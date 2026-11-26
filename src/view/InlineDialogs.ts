import { MarkdownRenderer, setIcon } from "obsidian";
import type { ElicitationChoice, ElicitationProperty, ElicitationSchema, ExtensionUiRequest, UiResponse } from "../rpc/types";
import type { RenderHost } from "./blocks";
import { renderInline } from "./markdown";

export type UiAnswer = UiResponse;

// A question of the panel's own making, drawn by its owner instead of as a plain dialog.
// The dock still queues it, dismisses it with Esc and answers it once.
export interface DialogForm {
	header: string;
	icon: string;
	// Fills the card and returns what to focus.
	render(card: HTMLElement, answer: (answer: UiAnswer) => void): HTMLElement;
}

type Request = ExtensionUiRequest & { timeout?: number; form?: DialogForm };

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
//   multi    an input whose title lists the options and whose placeholder starts with "1,3";
//            the answer is the chosen numbers, or free text for a custom answer
// Anything that doesn't match is shown as the plain dialog it is.

const NUMBERED = /^(\d+)\.\s+(.*?)(?:\s+—\s+(.*))?$/;
const RECOMMENDED_PREFIX = /^\(recommended\)\s*/i;
const GENERIC_ELICIT_TITLE = /^the agent has (?:a|\d+) questions?\.?$/i;
const isMultiSelectPlaceholder = (p: string | undefined): boolean => typeof p === "string" && (p === "1,3" || p.startsWith("1,3"));

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
	if (req.method !== "input" || !isMultiSelectPlaceholder(req.placeholder)) return null;
	const blocks = (req.title ?? "").split("\n\n");
	const listAt = blocks.findIndex((b) => b.split("\n").every((line) => NUMBERED.test(line)));
	if (listAt < 1) return null;
	const options = parseOptions(blocks[listAt].split("\n"), new Map());
	return { question: blocks.slice(0, listAt).join("\n\n"), options };
}

function choicesOf(prop: ElicitationProperty): ElicitationChoice[] {
	if (Array.isArray(prop.oneOf)) return prop.oneOf;
	if (Array.isArray(prop.items?.anyOf)) return prop.items.anyOf;
	if (Array.isArray(prop.enum)) {
		return prop.enum.map((v, i) => ({ const: v, title: prop.enumNames?.[i] ?? v }));
	}
	if (Array.isArray(prop.items?.enum)) {
		return prop.items.enum.map((v) => ({ const: v, title: v }));
	}
	return [];
}

function splitRecommended(label: string): { text: string; recommended: boolean } {
	if (!RECOMMENDED_PREFIX.test(label)) return { text: label, recommended: false };
	return { text: label.replace(RECOMMENDED_PREFIX, ""), recommended: true };
}

interface ParsedFormField {
	key: string;
	otherKey?: string;
	prop: ElicitationProperty;
	otherProp?: ElicitationProperty;
	kind: "single" | "multi" | "boolean" | "number" | "text";
	choices: ElicitationChoice[];
	required: boolean;
}

export function parseElicitationFields(schema: ElicitationSchema): ParsedFormField[] {
	const requiredSet = new Set(schema.required ?? []);
	const entries = Object.entries(schema.properties ?? {});
	const consumed = new Set<string>();
	const fields: ParsedFormField[] = [];

	for (const [key, prop] of entries) {
		if (consumed.has(key)) continue;
		const choices = choicesOf(prop);
		const otherKey = `${key}_other`;
		const otherProp = schema.properties[otherKey];
		const pairOther = Boolean(otherProp && otherProp.type === "string" && choices.length > 0);

		if (prop.type === "array" && choices.length > 0) {
			if (pairOther) consumed.add(otherKey);
			fields.push({
				key,
				otherKey: pairOther ? otherKey : undefined,
				prop,
				otherProp: pairOther ? otherProp : undefined,
				kind: "multi",
				choices,
				required: requiredSet.has(key),
			});
			continue;
		}
		if (prop.type === "string" && choices.length > 0) {
			if (pairOther) consumed.add(otherKey);
			fields.push({
				key,
				otherKey: pairOther ? otherKey : undefined,
				prop,
				otherProp: pairOther ? otherProp : undefined,
				kind: "single",
				choices,
				required: requiredSet.has(key),
			});
			continue;
		}
		if (prop.type === "boolean") {
			fields.push({ key, prop, kind: "boolean", choices: [], required: requiredSet.has(key) });
			continue;
		}
		if (prop.type === "number" || prop.type === "integer") {
			fields.push({ key, prop, kind: "number", choices: [], required: requiredSet.has(key) });
			continue;
		}
		fields.push({ key, prop, kind: "text", choices: [], required: requiredSet.has(key) });
	}
	return fields;
}

// ---- the dock

// Questions from pi extensions or Agy ACP elicitations, answered in the panel instead of a popup.
// The agent blocks on each one, so every request is answered exactly once: by the user, by dismissal,
// or by cancelAll when the session goes away.
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
		private agentLabel = "Pi",
	) {
		this.el = parent.createDiv({ cls: "pi-dialogs" });
	}

	get pending(): number {
		return this.queue.length;
	}

	has(id: string): boolean {
		return this.queue.some((req) => req.id === id);
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

	// The agent is gone; there is nobody left to answer.
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

		const isSchemaForm = req.method === "form" && Boolean(req.schema);
		const formFields = isSchemaForm && req.schema ? parseElicitationFields(req.schema) : [];

		const card = this.el.createDiv({ cls: isSchemaForm ? "pi-dialog pi-dialog-form" : "pi-dialog", attr: { tabindex: "-1" } });
		const head = card.createDiv({ cls: "pi-dialog-head" });
		setIcon(head.createSpan({ cls: "pi-icon" }), req.form?.icon ?? "message-circle-question");
		const multi = parseMultiSelect(req);
		const { header, body } = splitHeader(multi ? multi.question : (req.title ?? ""));
		const defaultHeader = `${this.agentLabel} is asking`;
		let headerText = req.form?.header ?? header ?? defaultHeader;
		if (isSchemaForm && !req.form) {
			const countLabel = formFields.length > 1 ? `${formFields.length} questions` : "Question";
			headerText = `${this.agentLabel} · ${countLabel}`;
		}
		head.createSpan({ cls: "pi-dialog-header", text: headerText });
		head.createSpan({ cls: "pi-dialog-count" });
		const dismiss = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Dismiss (Esc)" } });
		setIcon(dismiss, "x");
		dismiss.addEventListener("click", () => this.finish(req, { cancelled: true }));
		this.renderCount();

		if (isSchemaForm && req.schema) {
			const intro = [body && !GENERIC_ELICIT_TITLE.test(body.trim()) ? body : "", req.message ?? ""].filter(Boolean).join("\n\n");
			if (intro) {
				const introEl = card.createDiv({ cls: "pi-dialog-question markdown-rendered" });
				void MarkdownRenderer.render(this.host.app, intro, introEl, "", this.host.component).then(() => this.host.onContentChanged());
			}
			const focusTarget = this.renderSchemaForm(card, req, formFields);
			this.attachEscapeHandler(card, req);
			if (this.shouldFocus()) focusTarget.focus();
			this.host.onContentChanged();
			return;
		}

		const { question, previews } = splitPreviews(body);
		const text = [question, req.message].filter(Boolean).join("\n\n");
		if (text && !req.form) {
			const questionEl = card.createDiv({ cls: "pi-dialog-question markdown-rendered" });
			void MarkdownRenderer.render(this.host.app, text, questionEl, "", this.host.component).then(() => this.host.onContentChanged());
		}

		let focusTarget: HTMLElement = card;
		if (req.form) focusTarget = req.form.render(card, (answer) => this.finish(req, answer));
		else if (multi) focusTarget = this.renderMultiSelect(card, req, multi.options);
		else if (req.method === "select") this.renderSelect(card, req, parseOptions(req.options ?? [], previews));
		else if (req.method === "confirm") this.renderConfirm(card, req);
		else focusTarget = this.renderText(card, req);

		this.attachEscapeHandler(card, req);
		// Take focus only from the chat itself, never from a note the user is typing in.
		if (this.shouldFocus()) focusTarget.focus();
		this.host.onContentChanged();
	}

	private attachEscapeHandler(card: HTMLElement, req: Request): void {
		card.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.preventDefault();
			evt.stopPropagation();
			this.finish(req, { cancelled: true });
		});
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

	private renderChoiceLabel(container: HTMLElement, choice: ElicitationChoice): void {
		const main = container.createDiv({ cls: "pi-dialog-option-main" });
		const labelRow = main.createDiv({ cls: "pi-dialog-option-label" });
		const { text, recommended } = splitRecommended(choice.title ?? choice.const);
		renderInline(this.host, labelRow.createSpan(), text);
		if (recommended) labelRow.createSpan({ cls: "pi-dialog-badge", text: "Recommended" });
		if (choice.description) renderInline(this.host, main.createDiv({ cls: "pi-dialog-option-desc" }), choice.description);
	}

	private renderSchemaForm(card: HTMLElement, req: Request, fields: ParsedFormField[]): HTMLElement {
		const bodyEl = card.createDiv({ cls: "pi-dialog-form-body" });
		const multiQuestion = fields.length > 1;
		const readers: Array<{
			required: boolean;
			answered: () => boolean;
			collect: (out: Record<string, unknown>) => void;
		}> = [];
		let firstFocus: HTMLElement | null = null;
		let singleFieldQuickToggle: ((index: number) => void) | null = null;

		const statusEl = createSpan({ cls: "pi-dialog-status" });
		const submitBtn = createEl("button", {
			cls: "pi-dialog-send mod-cta",
			attr: { type: "button" },
		});
		submitBtn.createSpan({ text: multiQuestion ? "Send answers" : "Send answer" });
		setIcon(submitBtn.createSpan({ cls: "pi-icon" }), "send-horizontal");

		const refreshFooter = () => {
			let answered = 0;
			let missingRequired = false;
			for (const r of readers) {
				const ok = r.answered();
				if (ok) answered++;
				else if (r.required) missingRequired = true;
			}
			const canSend = readers.length === 0 || (!missingRequired && answered > 0);
			submitBtn.disabled = !canSend;
			if (!readers.length) {
				statusEl.setText("");
			} else if (multiQuestion) {
				statusEl.setText(`${answered} of ${readers.length} answered`);
			} else if (answered > 0) {
				statusEl.setText("Ready to send");
			} else {
				const hint = fields[0]?.kind === "multi" ? "Select one or more" : fields[0]?.kind === "single" ? "Choose one option" : "Enter an answer";
				statusEl.setText(hint);
			}
		};

		const submit = () => {
			if (submitBtn.disabled) return;
			const content: Record<string, unknown> = {};
			for (const r of readers) r.collect(content);
			this.finish(req, { content });
		};

		fields.forEach((field, fieldIndex) => {
			const group = bodyEl.createDiv({ cls: "pi-dialog-group" });
			const heading = group.createDiv({ cls: "pi-dialog-group-head" });
			const titleEl = heading.createDiv({ cls: "pi-dialog-group-title" });
			const prefix = multiQuestion ? `${fieldIndex + 1}. ` : "";
			renderInline(this.host, titleEl, `${prefix}${field.prop.title || field.key}`);
			if (field.required) titleEl.createSpan({ cls: "pi-dialog-required", text: " *" });
			if (field.kind === "multi") {
				heading.createSpan({ cls: "pi-dialog-group-hint", text: "Multiple choice" });
			}
			if (field.prop.description) {
				renderInline(this.host, group.createDiv({ cls: "pi-dialog-group-desc" }), field.prop.description);
			}

			if (field.kind === "single") {
				const list = group.createDiv({ cls: "pi-dialog-options", attr: { role: "radiogroup" } });
				const radioName = `pi-elicit-${req.id}-${field.key}`;
				const rows: { row: HTMLElement; input: HTMLInputElement; value: string }[] = [];

				const syncSelected = () => {
					for (const item of rows) item.row.toggleClass("is-selected", item.input.checked);
					if (otherRow && otherRadio) otherRow.toggleClass("is-selected", otherRadio.checked);
					refreshFooter();
				};

				field.choices.forEach((choice, i) => {
					const row = list.createEl("label", { cls: "pi-dialog-option pi-dialog-radio" });
					const radio = row.createEl("input", {
						type: "radio",
						attr: { name: radioName, value: choice.const },
					});
					if (field.prop.default === choice.const) radio.checked = true;
					if (!multiQuestion && i < 9) row.createSpan({ cls: "pi-dialog-key", text: String(i + 1) });
					this.renderChoiceLabel(row, choice);
					radio.addEventListener("change", syncSelected);
					row.addEventListener("click", (evt) => {
						if ((evt.target as HTMLElement).closest("a")) evt.stopPropagation();
					});
					rows.push({ row, input: radio, value: choice.const });
					if (!firstFocus) firstFocus = radio;
				});

				let otherRow: HTMLElement | null = null;
				let otherRadio: HTMLInputElement | null = null;
				let otherInput: HTMLInputElement | null = null;
				if (field.otherKey) {
					otherRow = list.createEl("label", { cls: "pi-dialog-option pi-dialog-radio pi-dialog-other-row" });
					otherRadio = otherRow.createEl("input", {
						type: "radio",
						attr: { name: radioName, value: "__other__" },
					});
					otherInput = otherRow.createEl("input", {
						type: "text",
						cls: "pi-dialog-other-input",
						attr: { placeholder: "Other — type your own answer…" },
					});
					otherRadio.addEventListener("change", () => {
						syncSelected();
						if (otherRadio?.checked) otherInput?.focus();
					});
					otherInput.addEventListener("focus", () => {
						if (otherRadio && !otherRadio.checked) {
							otherRadio.checked = true;
							syncSelected();
						}
					});
					otherInput.addEventListener("input", () => {
						if (otherRadio && otherInput?.value.trim()) otherRadio.checked = true;
						syncSelected();
					});
					otherInput.addEventListener("keydown", (evt) => {
						if (evt.key === "Enter" && !evt.isComposing && !multiQuestion) {
							evt.preventDefault();
							submit();
						}
					});
				}

				if (!multiQuestion) {
					singleFieldQuickToggle = (idx: number) => {
						const target = rows[idx];
						if (!target) return;
						target.input.checked = true;
						syncSelected();
					};
				}

				syncSelected();
				readers.push({
					required: field.required,
					answered: () => {
						if (rows.some((r) => r.input.checked)) return true;
						return Boolean(otherRadio?.checked && otherInput?.value.trim());
					},
					collect: (out) => {
						const chosen = rows.find((r) => r.input.checked);
						if (chosen) {
							out[field.key] = chosen.value;
							return;
						}
						const typed = otherInput?.value.trim() ?? "";
						if (field.otherKey && otherRadio?.checked && typed) {
							out[field.otherKey] = typed;
						}
					},
				});
			} else if (field.kind === "multi") {
				const list = group.createDiv({ cls: "pi-dialog-options", attr: { role: "group" } });
				const defaultVals = Array.isArray(field.prop.default) ? new Set(field.prop.default.map(String)) : new Set<string>();
				const rows: { row: HTMLElement; input: HTMLInputElement; value: string }[] = [];

				const syncSelected = () => {
					for (const item of rows) item.row.toggleClass("is-selected", item.input.checked);
					refreshFooter();
				};

				field.choices.forEach((choice, i) => {
					const row = list.createEl("label", { cls: "pi-dialog-option pi-dialog-check" });
					const box = row.createEl("input", { type: "checkbox" });
					if (defaultVals.has(choice.const)) box.checked = true;
					if (!multiQuestion && i < 9) row.createSpan({ cls: "pi-dialog-key", text: String(i + 1) });
					this.renderChoiceLabel(row, choice);
					box.addEventListener("change", syncSelected);
					row.addEventListener("click", (evt) => {
						if ((evt.target as HTMLElement).closest("a")) evt.stopPropagation();
					});
					rows.push({ row, input: box, value: choice.const });
					if (!firstFocus) firstFocus = box;
				});

				let otherInput: HTMLInputElement | null = null;
				if (field.otherKey) {
					otherInput = group.createEl("input", {
						type: "text",
						cls: "pi-dialog-input pi-dialog-other-standalone",
						attr: { placeholder: "Other (optional)…" },
					});
					otherInput.addEventListener("input", refreshFooter);
					otherInput.addEventListener("keydown", (evt) => {
						if (evt.key === "Enter" && !evt.isComposing && !multiQuestion) {
							evt.preventDefault();
							submit();
						}
					});
				}

				if (!multiQuestion) {
					singleFieldQuickToggle = (idx: number) => {
						const target = rows[idx];
						if (!target) return;
						target.input.checked = !target.input.checked;
						syncSelected();
					};
				}

				syncSelected();
				readers.push({
					required: field.required,
					answered: () => rows.some((r) => r.input.checked) || Boolean(otherInput?.value.trim()),
					collect: (out) => {
						const selected = rows.filter((r) => r.input.checked).map((r) => r.value);
						if (selected.length) out[field.key] = selected;
						const typed = otherInput?.value.trim() ?? "";
						if (field.otherKey && typed) out[field.otherKey] = typed;
					},
				});
			} else if (field.kind === "boolean") {
				const row = group.createEl("label", { cls: "pi-dialog-option pi-dialog-check" });
				const box = row.createEl("input", { type: "checkbox" });
				if (typeof field.prop.default === "boolean") box.checked = field.prop.default;
				row.createSpan({ cls: "pi-dialog-option-label", text: field.prop.title || field.key });
				const syncBool = () => {
					row.toggleClass("is-selected", box.checked);
					refreshFooter();
				};
				box.addEventListener("change", syncBool);
				syncBool();
				if (!firstFocus) firstFocus = box;
				readers.push({
					required: false,
					answered: () => true,
					collect: (out) => {
						out[field.key] = box.checked;
					},
				});
			} else if (field.kind === "number") {
				const input = group.createEl("input", {
					type: "number",
					cls: "pi-dialog-input",
					attr: {
						step: field.prop.type === "integer" ? "1" : "any",
						...(field.prop.minimum !== undefined ? { min: String(field.prop.minimum) } : {}),
						...(field.prop.maximum !== undefined ? { max: String(field.prop.maximum) } : {}),
					},
				});
				if (typeof field.prop.default === "number") input.value = String(field.prop.default);
				input.addEventListener("input", refreshFooter);
				input.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter" && !evt.isComposing && !multiQuestion) {
						evt.preventDefault();
						submit();
					}
				});
				if (!firstFocus) firstFocus = input;
				readers.push({
					required: field.required,
					answered: () => input.value.trim() !== "" && !Number.isNaN(Number(input.value)),
					collect: (out) => {
						if (input.value.trim() === "") return;
						const n = Number(input.value);
						if (!Number.isNaN(n)) out[field.key] = field.prop.type === "integer" ? Math.trunc(n) : n;
					},
				});
			} else {
				const inputType =
					field.prop.format === "email"
						? "email"
						: field.prop.format === "uri"
							? "url"
							: field.prop.format === "date"
								? "date"
								: "text";
				const input = group.createEl("input", {
					type: inputType,
					cls: "pi-dialog-input",
					attr: {
						placeholder: field.prop.description || "Type your answer…",
						...(field.prop.minLength !== undefined ? { minlength: String(field.prop.minLength) } : {}),
						...(field.prop.maxLength !== undefined ? { maxlength: String(field.prop.maxLength) } : {}),
					},
				});
				if (typeof field.prop.default === "string") input.value = field.prop.default;
				input.addEventListener("input", refreshFooter);
				input.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter" && !evt.isComposing && !multiQuestion) {
						evt.preventDefault();
						submit();
					}
				});
				if (!firstFocus) firstFocus = input;
				readers.push({
					required: field.required,
					answered: () => input.value.trim().length >= (field.prop.minLength ?? 1),
					collect: (out) => {
						const val = input.value.trim();
						if (val) out[field.key] = val;
					},
				});
			}
		});

		const footer = card.createDiv({ cls: "pi-dialog-footer" });
		footer.appendChild(statusEl);
		const actions = footer.createDiv({ cls: "pi-dialog-actions" });
		const cancelBtn = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
		cancelBtn.addEventListener("click", () => this.finish(req, { cancelled: true }));
		submitBtn.addEventListener("click", submit);
		actions.appendChild(submitBtn);

		card.addEventListener("keydown", (evt) => {
			if (evt.isComposing) return;
			const target = evt.target as HTMLElement | null;
			const inText = target?.tagName === "TEXTAREA" || (target?.tagName === "INPUT" && !["radio", "checkbox"].includes((target as HTMLInputElement).type));
			if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey || (!inText && !multiQuestion))) {
				if (!submitBtn.disabled) {
					evt.preventDefault();
					submit();
				}
				return;
			}
			if (!inText && singleFieldQuickToggle && /^[1-9]$/.test(evt.key) && !evt.metaKey && !evt.ctrlKey && !evt.altKey) {
				evt.preventDefault();
				singleFieldQuickToggle(Number(evt.key) - 1);
			}
		});

		refreshFooter();
		return firstFocus ?? card;
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
			const row = list.createEl("label", { cls: "pi-dialog-option pi-dialog-check" });
			const box = row.createEl("input", { type: "checkbox" });
			box.addEventListener("change", () => row.toggleClass("is-selected", box.checked));
			this.renderOption(row, option);
			return box;
		});
		const other = card.createEl("input", { type: "text", cls: "pi-dialog-input", attr: { placeholder: "Or type your own answer…" } });
		const submit = () => {
			const typed = other.value.trim();
			const chosen = boxes.flatMap((box, i) => (box.checked ? [String(i + 1)] : []));
			const value = chosen.length && typed ? `${chosen.join(",")}; ${typed}` : typed || chosen.join(",");
			this.finish(req, { value });
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
