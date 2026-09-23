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

	get arguments(): Record<string, unknown> {
		return this.args;
	}

	setArgs(args: Record<string, unknown>, result?: ToolResult): void {
		this.args = args;
		const { text, path } = this.renderer ? { text: this.renderer.summary(args, result), path: null } : summarize(this.name, args);
		this.summaryEl.empty();
		this.summaryEl.setAttr("title", text);
		this.summaryEl.toggleClass("has-path", Boolean(path));
		if (!path) {
			this.summaryEl.setText(text);
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
		this.details.dataset.status = status;
		this.statusEl.empty();
		const icon = { pending: "circle-dashed", running: "loader", done: "check", error: "x" }[status];
		setIcon(this.statusEl, icon);
	}

	setResult(result: ToolResult | undefined, isError = false): void {
		this.renderOutput(result, isError);
		// Pictures a tool returns (read on an image file, a screenshot from an MCP server) go under its output.
		const images = (result?.content ?? []).filter((block): block is ImageContent => block.type === "image");
		this.resultHasImages = images.length > 0;
		this.imagesEl?.remove();
		this.imagesEl = images.length ? this.bodyEl.createDiv({ cls: "pi-tool-images" }) : null;
		for (const image of images) this.addImage(imageSrc(image));
	}

	private renderOutput(result: ToolResult | undefined, isError: boolean): void {
		const diff = !isError && typeof result?.details?.diff === "string" ? result.details.diff : null;
		this.outputEl?.remove();
		if (this.renderer && result) {
			// Some summaries only make sense once the result is in (a task's name, a result count).
			this.setArgs(this.args, result);
			if (!isError && this.renderer.body) {
				this.outputEl = this.bodyEl.createDiv();
				if (this.renderer.body(this.outputEl, result, this.host)) return;
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
