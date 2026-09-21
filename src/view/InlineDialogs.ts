import { MarkdownRenderer, setIcon } from "obsidian";
import type { ExtensionUiRequest } from "../rpc/types";
import type { RenderHost } from "./blocks";
import { renderInline } from "./markdown";

export type UiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };
type Request = ExtensionUiRequest & { timeout?: number };

interface ParsedOption {
	value: string; // what goes back to pi, exactly as offered
	label: string;
	description: string;
	preview: string;
}

// ---- decoding
//
// Extensions that have a rich terminal UI fall back to pi's plain select/input dialogs
// under RPC and pack their structure into strings. These helpers unpack the conventions
// of @juicesharp/rpiv-ask-user-question (see its rpc-fallback.ts):
//   title    "[Header] Question?\n\n--- 1. Label preview ---\n<preview>"
//   option   "1. Label — description"
//   multi    an input whose title lists the options and whose placeholder is "1,3";
//            the answer is the chosen numbers, or free text for a custom answer
// Anything that doesn't match is shown as the plain dialog it is.

const NUMBERED = /^(\d+)\.\s+(.*?)(?:\s+—\s+(.*))?$/;
const MULTI_SELECT_PLACEHOLDER = "1,3";

export function splitHeader(title: string): { header: string | null; body: string } {
	const match = title.match(/^\[([^\]\n]{1,40})\]\s+/);
	return match ? { header: match[1], body: title.slice(match[0].length) } : { header: null, body: title };
}

export function splitPreviews(body: string): { question: string; previews: Map<number, string> } {
	const previews = new Map<number, string>();
	const start = body.search(/\n\n--- \d+\. .* preview ---\n/);
	if (start === -1) return { question: body, previews };
	const re = /--- (\d+)\. .* preview ---\n([\s\S]*?)(?=\n\n--- \d+\. .* preview ---\n|$)/g;
	for (const m of body.slice(start).matchAll(re)) previews.set(Number(m[1]), m[2]);
	return { question: body.slice(0, start), previews };
}

export function parseOptions(options: string[], previews: Map<number, string>): ParsedOption[] {
	const parsed = options.map((value) => ({ value, match: value.match(NUMBERED) }));
	const numbered = parsed.every((p, i) => p.match && Number(p.match[1]) === i + 1);
	return parsed.map(({ value, match }, i) =>
		numbered && match
			? { value, label: match[2], description: match[3] ?? "", preview: previews.get(i + 1) ?? "" }
			: { value, label: value, description: "", preview: "" },
	);
}

// The question, its options and nothing else: the typing instructions are replaced by checkboxes.
export function parseMultiSelect(req: Request): { question: string; options: ParsedOption[] } | null {
	if (req.method !== "input" || req.placeholder !== MULTI_SELECT_PLACEHOLDER) return null;
	const blocks = (req.title ?? "").split("\n\n");
	const listAt = blocks.findIndex((b) => b.split("\n").every((line) => NUMBERED.test(line)));
	if (listAt < 1) return null;
	const options = parseOptions(blocks[listAt].split("\n"), new Map());
	return { question: blocks.slice(0, listAt).join("\n\n"), options };
}

// ---- the dock

// Questions from pi extensions, answered in the panel instead of a popup. pi blocks on
// each one, so every request is answered exactly once: by the user, by dismissal, or
// by cancelAll when the session goes away.
export class InlineDialogs {
	private el: HTMLElement;
	private queue: Request[] = [];
	private timer: number | null = null;

	constructor(
		parent: HTMLElement,
		private host: RenderHost,
		private respond: (id: string, answer: UiAnswer) => void,
		private shouldFocus: () => boolean,
		// The number of open questions changed.
		private onChange: () => void = () => {},
	) {
		this.el = parent.createDiv({ cls: "pi-dialogs" });
	}

	get pending(): number {
		return this.queue.length;
	}

	push(req: Request): void {
		this.queue.push(req);
		if (this.queue.length === 1) this.render();
		else this.renderCount();
		this.onChange();
	}

	cancelAll(): void {
		for (const req of this.queue.splice(0)) this.respond(req.id, { cancelled: true });
		this.render();
		this.onChange();
	}

	// pi is gone; there is nobody left to answer.
	drop(): void {
		this.queue = [];
		this.render();
		this.onChange();
	}

	private finish(req: Request, answer: UiAnswer): void {
		if (this.queue[0] !== req) return;
		this.queue.shift();
		this.respond(req.id, answer);
		this.render();
		this.onChange();
	}

	private renderCount(): void {
		this.el.querySelector(".pi-dialog-count")?.setText(this.queue.length > 1 ? `+${this.queue.length - 1} more` : "");
	}

	private render(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.el.empty();
		const req = this.queue[0];
		if (!req) return;
		// pi answers for the user once the timeout passes; the card would be a dead end after that.
		if (req.timeout) {
			this.timer = window.setTimeout(() => {
				if (this.queue[0] !== req) return;
				this.queue.shift();
				this.render();
				this.onChange();
			}, req.timeout);
		}

		const card = this.el.createDiv({ cls: "pi-dialog", attr: { tabindex: "-1" } });
		const head = card.createDiv({ cls: "pi-dialog-head" });
		setIcon(head.createSpan({ cls: "pi-icon" }), "message-circle-question");
		const multi = parseMultiSelect(req);
		const { header, body } = splitHeader(multi ? multi.question : (req.title ?? ""));
		head.createSpan({ cls: "pi-dialog-header", text: header ?? "pi is asking" });
		head.createSpan({ cls: "pi-dialog-count" });
		const dismiss = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Dismiss (Esc)" } });
		setIcon(dismiss, "x");
		dismiss.addEventListener("click", () => this.finish(req, { cancelled: true }));
		this.renderCount();

		const { question, previews } = splitPreviews(body);
		const text = [question, req.message].filter(Boolean).join("\n\n");
		if (text) {
			const questionEl = card.createDiv({ cls: "pi-dialog-question markdown-rendered" });
			void MarkdownRenderer.render(this.host.app, text, questionEl, "", this.host.component).then(() => this.host.onContentChanged());
		}

		let focusTarget: HTMLElement = card;
		if (multi) focusTarget = this.renderMultiSelect(card, req, multi.options);
		else if (req.method === "select") this.renderSelect(card, req, parseOptions(req.options ?? [], previews));
		else if (req.method === "confirm") this.renderConfirm(card, req);
		else focusTarget = this.renderText(card, req);

		card.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			evt.stopPropagation();
			this.finish(req, { cancelled: true });
		});
		// Take focus only from the chat itself, never from a note the user is typing in.
		if (this.shouldFocus()) focusTarget.focus();
		this.host.onContentChanged();
	}

	private renderOption(row: HTMLElement, option: ParsedOption): void {
		const main = row.createDiv({ cls: "pi-dialog-option-main" });
		renderInline(this.host, main.createDiv({ cls: "pi-dialog-option-label" }), option.label);
		if (option.description) renderInline(this.host, main.createDiv({ cls: "pi-dialog-option-desc" }), option.description);
		if (!option.preview) return;
		// A preview is usually a mockup whose spacing matters, so it stays as typed unless it brings its own code fence.
		if (option.preview.includes("```")) renderInline(this.host, main.createDiv({ cls: "pi-dialog-option-preview-md" }), option.preview);
		else main.createEl("pre", { cls: "pi-dialog-option-preview", text: option.preview });
	}

	private renderSelect(card: HTMLElement, req: Request, options: ParsedOption[]): void {
		const list = card.createDiv({ cls: "pi-dialog-options" });
		options.forEach((option, i) => {
			const row = list.createEl("button", { cls: "pi-dialog-option" });
			row.createSpan({ cls: "pi-dialog-key", text: String(i + 1) });
			this.renderOption(row, option);
			row.addEventListener("click", (evt) => {
				// A link inside an option is for following, not for answering.
				if (!(evt.target as HTMLElement).closest("a")) this.finish(req, { value: option.value });
			});
		});
		card.addEventListener("keydown", (evt) => {
			const option = /^[1-9]$/.test(evt.key) ? options[Number(evt.key) - 1] : undefined;
			if (!option || evt.metaKey || evt.ctrlKey || evt.altKey) return;
			evt.preventDefault();
			this.finish(req, { value: option.value });
		});
	}

	private renderMultiSelect(card: HTMLElement, req: Request, options: ParsedOption[]): HTMLElement {
		const list = card.createDiv({ cls: "pi-dialog-options" });
		const boxes = options.map((option) => {
			const row = list.createEl("label", { cls: "pi-dialog-option" });
			const box = row.createEl("input", { type: "checkbox" });
			this.renderOption(row, option);
			return box;
		});
		const other = card.createEl("input", { type: "text", cls: "pi-dialog-input", attr: { placeholder: "Or type your own answer…" } });
		// A typed answer replaces the selection (that is how the extension reads it), so show that.
		other.addEventListener("input", () => list.toggleClass("is-overridden", other.value.trim() !== ""));
		const submit = () => {
			const typed = other.value.trim();
			const chosen = boxes.flatMap((box, i) => (box.checked ? [String(i + 1)] : []));
			this.finish(req, { value: typed || chosen.join(",") });
		};
		other.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.isComposing) {
				evt.preventDefault();
				submit();
			}
		});
		const actions = card.createDiv({ cls: "pi-dialog-actions" });
		actions.createEl("button", { text: "Submit", cls: "mod-cta" }).addEventListener("click", submit);
		return boxes[0] ?? other;
	}

	private renderConfirm(card: HTMLElement, req: Request): void {
		const actions = card.createDiv({ cls: "pi-dialog-actions" });
		actions.createEl("button", { text: "Yes", cls: "mod-cta" }).addEventListener("click", () => this.finish(req, { confirmed: true }));
		actions.createEl("button", { text: "No" }).addEventListener("click", () => this.finish(req, { confirmed: false }));
	}

	private renderText(card: HTMLElement, req: Request): HTMLElement {
		const multiline = req.method === "editor";
		const field = multiline ? card.createEl("textarea", { cls: "pi-dialog-editor" }) : card.createEl("input", { type: "text", cls: "pi-dialog-input" });
		field.value = req.prefill ?? "";
		field.placeholder = req.placeholder ?? "";
		const submit = () => this.finish(req, { value: field.value });
		// Widened to HTMLElement: the input/textarea union has no common addEventListener overload.
		(field as HTMLElement).addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.isComposing && (!multiline || evt.metaKey || evt.ctrlKey)) {
				evt.preventDefault();
				submit();
			}
		});
		const actions = card.createDiv({ cls: "pi-dialog-actions" });
		actions.createEl("button", { text: "Submit", cls: "mod-cta" }).addEventListener("click", submit);
		return field;
	}
}
