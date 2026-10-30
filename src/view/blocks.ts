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

export class ThinkingBlock {
	private body: MarkdownBlock;
	private details: HTMLDetailsElement;
	private label: HTMLElement;

	constructor(host: RenderHost, parent: HTMLElement) {
		this.details = parent.createEl("details", { cls: "pi-thinking" });
		const summary = this.details.createEl("summary");
		setIcon(summary.createSpan({ cls: "pi-icon" }), "brain");
		this.label = summary.createSpan({ text: "Thinking…" });
		this.body = new MarkdownBlock(host, this.details.createDiv({ cls: "pi-thinking-body markdown-rendered" }));
	}

	append(delta: string): void {
		this.body.append(delta);
	}

	finish(text?: string): void {
		if (text !== undefined) this.body.set(text);
		this.label.setText("Thought");
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
		first = first.replace(/^.*[/\\]/, "");
		return first || "bash";
	}
	return TOOL_RENDERERS[toolName]?.label ?? toolName;
}

function formatPreviousSummary(cards: ToolCard[]): string {
	if (cards.length === 0) return "";
	if (cards.length === 1) {
		const c = cards[0];
		const summary = c.summaryLine;
		if (summary && summary !== c.actionLabel) {
			const shortSummary = summary.length > 40 ? summary.slice(0, 37) + "…" : summary;
			return `${c.actionLabel} (${shortSummary})`;
		}
		return c.actionLabel;
	}

	const counts = new Map<string, number>();
	for (const c of cards) {
		const key = c.actionLabel;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const parts: string[] = [];
	for (const [key, count] of counts.entries()) {
		parts.push(count > 1 ? `${key} (×${count})` : key);
	}
	return parts.join(", ");
}

function formatCurrentActivity(active: ToolCard): string {
	const name = active.toolName;
	const summary = active.summaryLine;
	const status = active.status;

	if (status === "running") {
		if (name === "bash") return summary ? `Running: ${summary}` : "Running command…";
		if (name === "read") return `Reading ${summary || "file"}…`;
		if (name === "edit") return `Editing ${summary || "file"}…`;
		if (name === "write") return `Writing ${summary || "file"}…`;
		if (name === "grep" || name === "find") return `Searching: ${summary}…`;
		return summary ? `Running ${name}: ${summary}` : `Running ${name}…`;
	}

	if (status === "pending") {
		return `Calling ${name}…`;
	}

	if (status === "error") {
		return `Failed: ${name}${summary ? ` (${summary})` : ""}`;
	}

	return `Done: ${name}${summary ? ` (${summary})` : ""}`;
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
			// Only swallow the click when it did something; otherwise let it toggle the card.
			const opened = this.files.open(path, evt.metaKey || evt.ctrlKey);
			if (!opened && !isImage) return;
			evt.preventDefault();
			evt.stopPropagation();
			// A picture outside the vault can't open in Obsidian, so it is shown here instead.
			if (!opened) void this.showImage(path);
		});
		// Inside <summary>, so each button keeps its click from also folding the card.
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

	// A tool's own presentation is a nicety: when it chokes on a result it didn't expect (an old
	// session, a changed extension), the card falls back to the plain one instead of taking the
	// whole transcript down with it.
	private safely<T>(render: () => T): T | null {
		try {
			return render();
		} catch (err) {
			console.warn(`[pi-harness] couldn't render the ${this.name} card; showing it plain`, err);
			return null;
		}
	}

	// In Obsidian when the file is in the vault, otherwise in whatever the system opens it with.
	private async openFile(path: string, newLeaf: boolean): Promise<void> {
		if (this.files.open(path, newLeaf)) return;
		const problem = await this.files.openExternally(path);
		if (problem) new Notice(`Couldn't open ${path}: ${problem}`);
	}

	// Opens the card on the picture: the one the tool returned, or else the file as it is on disk now.
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
				// Once decoded the picture no longer needs the blob.
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

	// An undo (or, once undone, redo) button for an edit the panel can take back.
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
		// Pictures a tool returns (read on an image file, a screenshot from an MCP server) go under its output.
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
			// Some summaries only make sense once the result is in (a task's name, a result count).
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
	private prevBtn: HTMLButtonElement;
	private prevChevronEl: HTMLElement;
	private prevCountEl: HTMLElement;
	private prevSummaryEl: HTMLElement;

	private currentEl: HTMLElement;
	private currentIconEl: HTMLElement;
	private currentTextEl: HTMLElement;

	readonly previousContainer: HTMLElement;
	readonly activeContainer: HTMLElement;

	private cards: ToolCard[] = [];
	private activeCard: ToolCard | null = null;
	private isExpanded = false;
	private isSettled = false;

	constructor(
		parent: HTMLElement,
		private host: RenderHost,
	) {
		this.el = parent.createDiv({ cls: "pi-tool-group" });

		this.headerEl = this.el.createDiv({ cls: "pi-tool-group-header" });

		// Previous calls expander button
		this.prevBtn = this.headerEl.createEl("button", {
			cls: "pi-tool-group-prev clickable",
			attr: { "aria-expanded": "false" },
		});
		this.prevChevronEl = this.prevBtn.createSpan({ cls: "pi-tool-group-chevron pi-icon" });
		setIcon(this.prevChevronEl, "chevron-right");
		this.prevBtn.createSpan({ cls: "pi-tool-group-prev-title", text: "Previously:" });
		this.prevCountEl = this.prevBtn.createSpan({ cls: "pi-tool-group-prev-count" });
		this.prevBtn.createSpan({ cls: "pi-tool-group-prev-sep", text: "·" });
		this.prevSummaryEl = this.prevBtn.createSpan({ cls: "pi-tool-group-prev-summary" });
		this.prevBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.toggleExpanded();
		});

		// Current activity row
		this.currentEl = this.headerEl.createDiv({ cls: "pi-tool-group-current" });
		this.currentIconEl = this.currentEl.createSpan({ cls: "pi-tool-group-current-icon pi-icon" });
		this.currentTextEl = this.currentEl.createSpan({ cls: "pi-tool-group-current-text" });

		// Containers
		this.previousContainer = this.el.createDiv({ cls: "pi-tool-group-previous is-collapsed" });
		this.activeContainer = this.el.createDiv({ cls: "pi-tool-group-active" });

		this.updateView();
	}

	get cardContainer(): HTMLElement {
		return this.activeContainer;
	}

	toggleExpanded(): void {
		this.isExpanded = !this.isExpanded;
		this.previousContainer.toggleClass("is-collapsed", !this.isExpanded);
		this.prevBtn.setAttr("aria-expanded", String(this.isExpanded));
		this.prevBtn.toggleClass("is-open", this.isExpanded);
		this.updateView();
		this.host.onContentChanged();
	}

	addCard(card: ToolCard): void {
		if (this.cards.includes(card)) return;

		// Move former active card to previous container
		if (this.activeCard && this.activeCard !== card) {
			this.previousContainer.appendChild(this.activeCard.el);
		}

		this.cards.push(card);
		this.activeCard = card;
		this.activeContainer.appendChild(card.el);

		card.onUpdate(() => this.updateView());
		this.updateView();
		this.host.onContentChanged();
	}

	settle(): void {
		this.isSettled = true;
		this.updateView();
	}

	updateView(): void {
		const total = this.cards.length;
		if (total === 0) {
			this.headerEl.hide();
			return;
		}

		this.headerEl.show();
		const prevCount = total - 1;

		// 1. Previous calls expander
		if (prevCount > 0) {
			this.prevBtn.show();
			const prevCards = this.cards.slice(0, prevCount);
			const failedCount = prevCards.filter((c) => c.status === "error").length;
			const failedText = failedCount > 0 ? ` (${failedCount} failed)` : "";
			this.prevCountEl.setText(`${prevCount} ${prevCount === 1 ? "call" : "calls"}${failedText}`);
			const summary = formatPreviousSummary(prevCards);
			this.prevSummaryEl.setText(summary);
			this.prevBtn.setAttr("title", `Click to ${this.isExpanded ? "collapse" : "expand"} previous calls`);
		} else {
			this.prevBtn.hide();
		}

		// 2. What it is doing currently
		const active = this.activeCard;
		if (this.isSettled) {
			if (total > 1) {
				this.currentEl.show();
				const errorCount = this.cards.filter((c) => c.status === "error").length;
				if (errorCount > 0) {
					setIcon(this.currentIconEl, "alert-circle");
					this.currentEl.dataset.status = "error";
					this.currentTextEl.setText(`Completed ${total} tool calls (${errorCount} failed)`);
				} else {
					setIcon(this.currentIconEl, "check");
					this.currentEl.dataset.status = "done";
					this.currentTextEl.setText(`Completed ${total} tool calls`);
				}
			} else {
				this.currentEl.hide();
			}
		} else if (active) {
			this.currentEl.show();
			const status = active.status;
			this.currentEl.dataset.status = status;
			if (status === "running") {
				setIcon(this.currentIconEl, "loader");
			} else if (status === "pending") {
				setIcon(this.currentIconEl, "circle-dashed");
			} else if (status === "error") {
				setIcon(this.currentIconEl, "x");
			} else {
				setIcon(this.currentIconEl, "check");
			}
			this.currentTextEl.setText(formatCurrentActivity(active));
		} else {
			this.currentEl.hide();
		}
	}
}
