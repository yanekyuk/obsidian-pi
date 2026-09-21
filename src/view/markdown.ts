import { MarkdownRenderer } from "obsidian";
import type { RenderHost } from "./blocks";

// Anything Markdown would treat specially. Text without it renders as itself, so it skips the renderer.
const MARKDOWN_SYNTAX = /[`*_~[\]$=<>#|\\]|https?:/;

// Markdown for the small places: a label, an option, a task. Whatever the model writes there
// (`code`, **bold**, [[links]]) shows the way it does in the transcript. The plain text stands
// in until the render lands, and a single paragraph stays on the line it was given.
export function renderInline(host: RenderHost, el: HTMLElement, text: string): HTMLElement {
	el.addClass("pi-md-inline");
	el.setText(text);
	if (!MARKDOWN_SYNTAX.test(text)) return el;
	const rendered = createDiv();
	void MarkdownRenderer.render(host.app, text, rendered, "", host.component).then(() => {
		el.empty();
		el.addClass("markdown-rendered");
		el.append(...Array.from(rendered.childNodes));
		host.onContentChanged();
	});
	return el;
}
