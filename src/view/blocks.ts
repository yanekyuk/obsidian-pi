import { MarkdownRenderer, Notice, setIcon, type App, type Component } from "obsidian";
import { promises as fs } from "fs";
import type { ImageContent, ToolResult } from "../rpc/types";
import { contentText } from "../sessions";
import { imageSrc } from "./Attachments";
import { TOOL_RENDERERS, type ToolRenderer } from "./toolRenderers";

const RENDER_INTERVAL_MS = 80;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	svg: "image/svg+xml",
};

// The MIME type when the path names a picture the panel can show, otherwise null.
export function imageTypeOf(path: string): string | null {
	return IMAGE_TYPES[path.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? ""] ?? null;
}

// How a tool card gets at the files its tool names.
export interface ToolFiles {
	// Opens a vault file in Obsidian; false when the path is not in the vault.
	open(path: string, newLeaf: boolean): boolean;
	// The path as the file system knows it: tools may give one relative to the vault, or with "~".
	absolute(path: string): string;
	// Hands a file or folder outside the vault to the system's default app. Resolves to what went wrong, if anything.
	openExternally(path: string): Promise<string | null>;
}

export interface RenderHost {
	app: App;
	component: Component;
	onContentChanged: () => void;
}

// The block behind each element, so a whole panel can be rendered again without keeping blocks alive.
const blocksByEl = new WeakMap<HTMLElement, MarkdownBlock>();

// Renders every Markdown block under root again. Obsidian asks for this with "post-processor-change",
// e.g. once the vault's Mermaid diagrams are allowed, since its guard only goes away on a fresh render.
export function rerenderMarkdownIn(root: HTMLElement): void {
	for (const el of Array.from(root.querySelectorAll<HTMLElement>(".pi-md-block"))) blocksByEl.get(el)?.rerender();
}

// Markdown that re-renders as text streams in, at most once per interval.
export class MarkdownBlock {
	private text = "";
	private timer: number | null = null;
	private rendering = false;
	private stale = false;

	constructor(
		private host: RenderHost,
		readonly el: HTMLElement,
	) {
		el.addClass("pi-md-block");
		blocksByEl.set(el, this);
	}

	append(delta: string): void {
		this.text += delta;
		this.schedule();
	}

	set(text: string): void {
		if (text === this.text && !this.stale && this.timer === null) return;
		this.text = text;
		this.schedule();
	}

	rerender(): void {
		this.schedule();
	}

	private schedule(): void {
		this.stale = true;
		if (this.timer !== null || this.rendering) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.render();
		}, RENDER_INTERVAL_MS);
	}

	private async render(): Promise<void> {
		this.rendering = true;
		this.stale = false;
		// Render off-DOM and swap, so the block never flashes empty mid-stream.
		const staging = createDiv();
		await MarkdownRenderer.render(this.host.app, this.text, staging, "", this.host.component);
		this.el.replaceChildren(...Array.from(staging.childNodes));
		this.rendering = false;
		this.host.onContentChanged();
		if (this.stale) this.schedule();
	}
}

export function extractIntentLine(raw: string): string {
	if (!raw) return "";
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.replace(/^[#*\->`\s]+/, "").replace(/[*_`~]/g, "").trim())
		.filter(Boolean);
	if (lines.length === 0) return "";
	const lastLine = lines[lines.length - 1];
	const sentences = lastLine.split(/(?<=[.!?])\s+/).filter(Boolean);
	const candidate = (sentences[sentences.length - 1] ?? lastLine).trim();
	return candidate.length > 90 ? candidate.slice(0, 89) + "…" : candidate;
}

export class ThinkingBlock {
	private body: MarkdownBlock;
	private details: HTMLDetailsElement;
	private iconEl: HTMLElement;
	private label: HTMLElement;
	private rawText = "";
	private currentStatus: "running" | "done" | "error" = "running";
	private updateListeners: (() => void)[] = [];

	constructor(host: RenderHost, parent: HTMLElement) {
		this.details = parent.createEl("details", { cls: "pi-thinking" });
		const summary = this.details.createEl("summary");
		this.iconEl = summary.createSpan({ cls: "pi-icon pi-thinking-icon" });
		this.label = summary.createSpan({ cls: "pi-thinking-summary", text: "Thinking…" });
		this.body = new MarkdownBlock(host, this.details.createDiv({ cls: "pi-thinking-body markdown-rendered" }));
		this.setStatus("running");
	}

	get el(): HTMLElement {
		return this.details;
	}

	get status(): "running" | "done" | "error" {
		return this.currentStatus;
	}

	get text(): string {
		return this.rawText;
	}

	get summaryLine(): string {
		return extractIntentLine(this.rawText);
	}

	onUpdate(listener: () => void): void {
		this.updateListeners.push(listener);
	}

	private notifyUpdate(): void {
		for (const l of this.updateListeners) l();
	}

	private setStatus(status: "running" | "done" | "error"): void {
		this.currentStatus = status;
		this.details.dataset.status = status;
		this.iconEl.empty();
		setIcon(this.iconEl, status === "running" ? "loader" : status === "error" ? "x" : "brain");
	}

	append(delta: string): void {
		this.rawText += delta;
		this.body.append(delta);
		const line = this.summaryLine;
		this.label.setText(line || "Thinking…");
		this.label.setAttr("title", line);
		this.notifyUpdate();
	}

	finish(text?: string, isError = false): void {
		if (text !== undefined) {
			this.rawText = text;
			this.body.set(text);
		}
		this.setStatus(isError ? "error" : "done");
		const line = this.summaryLine;
		this.label.setText(line || "Thought");
		this.label.setAttr("title", line);
		this.notifyUpdate();
	}
}

const TOOL_ICONS: Record<string, string> = {
	bash: "terminal",
	read: "file-text",
	edit: "pencil",
	write: "file-plus",
	grep: "search",
	find: "folder-search",
	ls: "folder",
};

function summarize(name: string, args: Record<string, unknown>): { text: string; path: string | null } {
	const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : null);
	const path = str("path") ?? str("file_path");
	switch (name) {
		case "bash":
			return { text: str("command") ?? "", path: null };
		case "read":
		case "edit":
		case "write":
		case "ls":
			return { text: path ?? "", path };
		case "grep":
		case "find":
			return { text: [str("pattern"), path].filter(Boolean).join(" in "), path: null };
		default: {
			const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
			return { text: first ?? (Object.keys(args).length ? JSON.stringify(args) : ""), path: null };
		}
	}
}

function actionNameOf(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash") {
		const cmd = typeof args["command"] === "string" ? (args["command"] as string).trim() : "";
		if (!cmd) return "bash";
		const tokens = cmd.split(/\s+/).filter((t) => !t.includes("=") && !t.startsWith("-"));
		let first = tokens[0] ?? "";
		if (first === "sudo" && tokens[1]) first = tokens[1];
		if ((first === "python" || first === "python3" || first === "node" || first === "sh" || first === "bash") && tokens[1]) {
			first = tokens[1];
		}
		first = first.replace(/^.*[/\\]/, "");
		return first || "bash";
	}
	return TOOL_RENDERERS[toolName]?.label ?? toolName;
}

function formatToolsSummary(cards: ToolCard[]): string {
	if (cards.length === 0) return "";
	const counts = new Map<string, number>();
	for (const c of cards) {
		const key = c.actionLabel;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [key, count] of counts.entries()) {
		parts.push(count > 1 ? `${key} ×${count}` : key);
	}
	return parts.join(", ");
}

export function formatActivityText(toolName: string, args?: Record<string, unknown>): string {
	if (!args || !Object.keys(args).length) return `Running ${toolName}…`;
	const { text, path } = summarize(toolName, args);
	const short = (s: string, max = 50) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
	switch (toolName) {
		case "bash": {
			const act = actionNameOf(toolName, args);
			return act && act !== "bash" ? `Running ${act}…` : text ? `Running ${short(text, 40)}…` : "Running command…";
		}
		case "read":
			return path ? `Reading ${short(path.replace(/^.*[/\\]/, ""))}…` : "Reading note…";
		case "edit":
			return path ? `Editing ${short(path.replace(/^.*[/\\]/, ""))}…` : "Editing note…";
		case "write":
			return path ? `Writing ${short(path.replace(/^.*[/\\]/, ""))}…` : "Writing note…";
		case "grep":
		case "find":
			return text ? `Searching for ${short(text)}…` : "Searching vault…";
		default: {
			const label = TOOL_RENDERERS[toolName]?.label ?? toolName.replace(/_/g, " ");
			return text ? `${label}: ${short(text)}` : `Running ${label}…`;
		}
	}
}

export class ToolCard {
	private details: HTMLDetailsElement;
	private statusEl: HTMLElement;
	private summaryEl: HTMLElement;
	private bodyEl: HTMLElement;
	private outputEl: HTMLElement | null = null;
	private imagesEl: HTMLElement | null = null;
	private renderer: ToolRenderer | undefined;
	private args: Record<string, unknown> = {};
	private resultHasImages = false;
	private revertEl: HTMLElement | null = null;
	private revertNoteEl: HTMLElement | null = null;
	private currentStatus: "pending" | "running" | "done" | "error" = "pending";
	private summaryString = "";
	private updateListeners: (() => void)[] = [];

	constructor(
		parent: HTMLElement,
		private host: RenderHost,
		private name: string,
		expanded: boolean,
		private files: ToolFiles,
	) {
		this.renderer = TOOL_RENDERERS[name];
		this.details = parent.createEl("details", { cls: "pi-tool" });
		this.details.open = expanded;
		const summary = this.details.createEl("summary");
		setIcon(summary.createSpan({ cls: "pi-icon" }), this.renderer?.icon ?? TOOL_ICONS[name] ?? "wrench");
		summary.createSpan({ cls: "pi-tool-name", text: this.renderer?.label ?? name });
		this.summaryEl = summary.createSpan({ cls: "pi-tool-summary" });
		this.statusEl = summary.createSpan({ cls: "pi-tool-status" });
		this.bodyEl = this.details.createDiv({ cls: "pi-tool-body" });
		this.setStatus("pending");
	}

	get el(): HTMLElement {
		return this.details;
	}

	get toolName(): string {
		return this.name;
	}

	get status(): "pending" | "running" | "done" | "error" {
		return this.currentStatus;
	}

	get summaryLine(): string {
		return this.summaryString;
	}

	get actionLabel(): string {
		return actionNameOf(this.name, this.args);
	}

	get arguments(): Record<string, unknown> {
		return this.args;
	}

	onUpdate(listener: () => void): void {
		this.updateListeners.push(listener);
	}

	private notifyUpdate(): void {
		for (const l of this.updateListeners) l();
	}

	setArgs(args: Record<string, unknown>, result?: ToolResult): void {
		this.args = args;
		const renderer = this.renderer;
		const custom = renderer ? this.safely(() => renderer.summary(args, result)) : null;
		const { text, path } = custom !== null ? { text: custom, path: null } : summarize(this.name, args);
		this.summaryString = text;
		this.summaryEl.empty();
		this.summaryEl.setAttr("title", text);
		this.summaryEl.toggleClass("has-path", Boolean(path));
		if (!path) {
			this.summaryEl.setText(text);
			this.notifyUpdate();
			return;
		}
		const isImage = imageTypeOf(path) !== null;
		const link = this.summaryEl.createEl("a", { cls: "pi-tool-path", text });
		link.addEventListener("click", (evt) => {
			const opened = this.files.open(path, evt.metaKey || evt.ctrlKey);
			if (!opened && !isImage) return;
			evt.preventDefault();
			evt.stopPropagation();
			if (!opened) void this.showImage(path);
		});
		const button = (icon: string, label: string, run: (evt: MouseEvent) => void) => {
			const el = this.summaryEl.createEl("button", { cls: "pi-tool-action clickable-icon", attr: { "aria-label": label } });
			setIcon(el, icon);
			el.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				run(evt);
			});
		};
		if (isImage) button("image", "Show image here", () => void this.showImage(path));
		button("external-link", "Open file", (evt) => void this.openFile(path, evt.metaKey || evt.ctrlKey));
		this.notifyUpdate();
	}

	private safely<T>(render: () => T): T | null {
		try {
			return render();
		} catch (err) {
			console.warn(`[pi-workbench] couldn't render the ${this.name} card; showing it plain`, err);
			return null;
		}
	}

	private async openFile(path: string, newLeaf: boolean): Promise<void> {
		if (this.files.open(path, newLeaf)) return;
		const problem = await this.files.openExternally(path);
		if (problem) new Notice(`Couldn't open ${path}: ${problem}`);
	}

	private async showImage(path: string): Promise<void> {
		this.details.open = true;
		if (!this.resultHasImages) {
			this.imagesEl?.remove();
			this.imagesEl = this.bodyEl.createDiv({ cls: "pi-tool-images" });
			try {
				const file = this.files.absolute(path);
				if ((await fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error("the file is too large to preview");
				const url = URL.createObjectURL(new Blob([await fs.readFile(file)], { type: imageTypeOf(path) ?? "" }));
				const img = this.addImage(url);
				img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
				img.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
			} catch (err) {
				const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "the file is no longer there" : (err as Error).message;
				this.imagesEl.createDiv({ cls: "pi-msg-notice", text: `Couldn't show the image: ${reason}.` });
			}
		}
		this.host.onContentChanged();
		this.imagesEl?.scrollIntoView({ block: "nearest" });
	}

	private addImage(src: string): HTMLImageElement {
		const img = (this.imagesEl as HTMLElement).createEl("img", { attr: { src, alt: "Image from the tool" } });
		img.addEventListener("load", () => this.host.onContentChanged());
		img.addEventListener("click", () => img.toggleClass("is-expanded", !img.hasClass("is-expanded")));
		return img;
	}

	setRevert(state: "applied" | "reverted" | null, run?: () => void): void {
		this.revertEl?.remove();
		this.revertNoteEl?.remove();
		this.revertEl = this.revertNoteEl = null;
		if (!state || !run) return;
		const undone = state === "reverted";
		this.revertEl = this.summaryEl.createEl("button", { cls: "pi-tool-action clickable-icon", attr: { "aria-label": undone ? "Redo this edit" : "Undo this edit" } });
		setIcon(this.revertEl, undone ? "redo-2" : "undo-2");
		this.revertEl.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			run();
		});
		if (undone) this.revertNoteEl = this.bodyEl.createDiv({ cls: "pi-msg-notice", text: "Undone: the file is back to how it was before this edit. pi doesn't know." });
	}

	setStatus(status: "pending" | "running" | "done" | "error"): void {
		this.currentStatus = status;
		this.details.dataset.status = status;
		this.statusEl.empty();
		const icon = { pending: "circle-dashed", running: "loader", done: "check", error: "x" }[status];
		setIcon(this.statusEl, icon);
		this.notifyUpdate();
	}

	setResult(result: ToolResult | undefined, isError = false): void {
		this.renderOutput(result, isError);
		const images = (result?.content ?? []).filter((block): block is ImageContent => block.type === "image");
		this.resultHasImages = images.length > 0;
		this.imagesEl?.remove();
		this.imagesEl = images.length ? this.bodyEl.createDiv({ cls: "pi-tool-images" }) : null;
		for (const image of images) this.addImage(imageSrc(image));
		this.notifyUpdate();
	}

	private renderOutput(result: ToolResult | undefined, isError: boolean): void {
		const diff = !isError && typeof result?.details?.diff === "string" ? result.details.diff : null;
		this.outputEl?.remove();
		if (this.renderer && result) {
			this.setArgs(this.args, result);
			if (!isError && this.renderer.body) {
				this.outputEl = this.bodyEl.createDiv();
				const { body } = this.renderer;
				const outputEl = this.outputEl;
				if (this.safely(() => body(outputEl, result, this.host))) return;
				this.outputEl.remove();
			}
		}
		this.outputEl = this.bodyEl.createEl("pre", { cls: "pi-tool-output" });
		if (diff) {
			for (const line of diff.split("\n")) {
				const cls = line.startsWith("+") ? "pi-diff-add" : line.startsWith("-") ? "pi-diff-del" : "pi-diff-ctx";
				this.outputEl.createDiv({ cls, text: line || " " });
			}
			return;
		}
		const text = contentText(result?.content);
		this.outputEl.setText(
			text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… ${text.length - MAX_OUTPUT_CHARS} more characters` : text,
		);
		if (!text) this.outputEl.addClass("pi-tool-output-empty");
	}
}

export class ToolGroup {
	readonly el: HTMLElement;
	private headerEl: HTMLElement;
	private statusIconEl: HTMLElement;
	private titleEl: HTMLElement;
	private metaEl: HTMLElement;
	private chevronEl: HTMLElement;
	readonly bodyEl: HTMLElement;

	private cards: ToolCard[] = [];
	private thinkings: ThinkingBlock[] = [];
	private isExpanded = false;
	private isSettled = false;

	constructor(
		parent: HTMLElement,
		private host: RenderHost,
	) {
		this.el = parent.createDiv({ cls: "pi-tool-group" });

		this.headerEl = this.el.createDiv({
			cls: "pi-tool-group-header",
			attr: { role: "button", tabindex: "0", "aria-expanded": "false" },
		});

		this.statusIconEl = this.headerEl.createSpan({ cls: "pi-tool-group-status pi-icon" });
		this.titleEl = this.headerEl.createSpan({ cls: "pi-tool-group-title" });
		this.metaEl = this.headerEl.createSpan({ cls: "pi-tool-group-meta" });
		this.chevronEl = this.headerEl.createSpan({ cls: "pi-tool-group-chevron pi-icon" });
		setIcon(this.chevronEl, "chevron-right");

		this.headerEl.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.toggleExpanded();
		});
		this.headerEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				this.toggleExpanded();
			}
		});

		this.bodyEl = this.el.createDiv({ cls: "pi-tool-group-body is-collapsed" });

		this.updateView();
	}

	get cardContainer(): HTMLElement {
		return this.bodyEl;
	}

	hasThinking(thinking: ThinkingBlock): boolean {
		return this.thinkings.includes(thinking);
	}

	toggleExpanded(): void {
		this.isExpanded = !this.isExpanded;
		this.bodyEl.toggleClass("is-collapsed", !this.isExpanded);
		this.headerEl.setAttr("aria-expanded", String(this.isExpanded));
		this.el.toggleClass("is-open", this.isExpanded);
		this.updateView();
		this.host.onContentChanged();
	}

	addThinking(thinking: ThinkingBlock): void {
		if (this.thinkings.includes(thinking)) return;
		this.thinkings.push(thinking);
		this.bodyEl.appendChild(thinking.el);
		thinking.onUpdate(() => this.updateView());
		this.updateView();
		this.host.onContentChanged();
	}

	attachThinking(thinking: ThinkingBlock): void {
		this.addThinking(thinking);
	}

	addCard(card: ToolCard, thinking?: ThinkingBlock): void {
		if (thinking) this.addThinking(thinking);
		if (this.cards.includes(card)) return;
		this.cards.push(card);
		this.bodyEl.appendChild(card.el);
		card.onUpdate(() => this.updateView());
		this.updateView();
		this.host.onContentChanged();
	}

	settle(): void {
		this.isSettled = true;
		this.updateView();
	}

	private latestIntent(): string {
		for (let i = this.thinkings.length - 1; i >= 0; i--) {
			const line = this.thinkings[i].summaryLine;
			if (line) return line;
		}
		return "";
	}

	updateView(): void {
		this.el.toggleClass("is-settled", this.isSettled);
		const totalTools = this.cards.length;
		const totalThoughts = this.thinkings.length;

		if (totalTools === 0 && totalThoughts === 0) {
			this.headerEl.hide();
			return;
		}

		this.headerEl.show();
		const failedCount = this.cards.filter((c) => c.status === "error").length;
		const runningCard = [...this.cards].reverse().find((c) => c.status === "running" || c.status === "pending");
		const runningThinking = [...this.thinkings].reverse().find((t) => t.status === "running");
		const intent = this.latestIntent();
		const toolsSummary = formatToolsSummary(this.cards);

		if (!this.isSettled) {
			this.el.dataset.status = "running";
			setIcon(this.statusIconEl, "loader");

			if (intent) {
				this.titleEl.setText(intent);
			} else if (runningCard) {
				this.titleEl.setText(formatActivityText(runningCard.toolName, runningCard.arguments));
			} else if (runningThinking) {
				this.titleEl.setText("Thinking…");
			} else if (totalTools > 0) {
				const last = this.cards[totalTools - 1];
				this.titleEl.setText(formatActivityText(last.toolName, last.arguments));
			} else {
				this.titleEl.setText("Working…");
			}

			if (totalTools > 0) {
				const stepWord = totalTools === 1 ? "1 step" : `${totalTools} steps`;
				const failStr = failedCount > 0 ? ` (${failedCount} failed)` : "";
				const activeLabel = runningCard ? runningCard.actionLabel : toolsSummary;
				this.metaEl.setText(activeLabel ? `${stepWord}${failStr} · ${activeLabel}` : `${stepWord}${failStr}`);
				this.metaEl.show();
			} else {
				this.metaEl.hide();
			}
		} else {
			if (failedCount > 0) {
				this.el.dataset.status = "error";
				setIcon(this.statusIconEl, "alert-circle");
			} else {
				this.el.dataset.status = "done";
				setIcon(this.statusIconEl, "check");
			}

			if (totalTools > 0) {
				const stepWord = totalTools === 1 ? "1 step" : `${totalTools} steps`;
				const failStr = failedCount > 0 ? ` (${failedCount} failed)` : "";
				if (intent) {
					this.titleEl.setText(intent);
					this.metaEl.setText(`${stepWord}${failStr} · ${toolsSummary}`);
					this.metaEl.show();
				} else {
					this.titleEl.setText(`${stepWord}${failStr} · ${toolsSummary}`);
					this.metaEl.hide();
				}
			} else {
				this.titleEl.setText(intent || "Thought");
				this.metaEl.hide();
			}
		}

		this.headerEl.setAttr(
			"title",
			toolsSummary ? `${this.titleEl.getText()} (${toolsSummary})` : this.titleEl.getText(),
		);
	}
}
