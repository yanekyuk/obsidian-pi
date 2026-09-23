import { MarkdownRenderer } from "obsidian";
import type { ToolResult } from "../rpc/types";
import { contentText } from "../sessions";
import type { RenderHost } from "./blocks";
import { renderInline } from "./markdown";
import { tasksFrom } from "./TodoPanel";

// Presentation for tools whose results carry structure worth showing: the rpiv
// extensions the plugin requires, and the plugin's own obsidian_search. Tools not listed here get the generic card.
export interface ToolRenderer {
	icon: string;
	label?: string;
	// One-line summary for the card header. `result` is absent until the tool finishes.
	summary(args: Record<string, unknown>, result?: ToolResult): string;
	// Fills the card body. Return false to fall back to the plain text output.
	body?(el: HTMLElement, result: ToolResult, host: RenderHost): boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function markdownBody(el: HTMLElement, text: string, host: RenderHost): boolean {
	if (!text.trim()) return false;
	const target = el.createDiv({ cls: "pi-tool-rich markdown-rendered" });
	void MarkdownRenderer.render(host.app, text, target, "", host.component).then(() => host.onContentChanged());
	return true;
}

const todo: ToolRenderer = {
	icon: "list-checks",
	label: "task",
	summary(args, result) {
		const action = str(args.action);
		const id = typeof args.id === "number" ? args.id : null;
		// An update only names the id; the snapshot in the result knows what that task is.
		const subject = str(args.subject) || tasksFrom(result?.details)?.find((t) => t.id === id)?.subject || "";
		const status = str(args.status).replace("_", " ");
		if (action === "create") return subject;
		if (action === "update") return [subject || (id === null ? "" : `#${id}`), status && `→ ${status}`].filter(Boolean).join(" ");
		if (action === "list" || action === "clear") return action;
		return [action, subject || (id === null ? "" : `#${id}`)].filter(Boolean).join(" ");
	},
};

interface Answer {
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
}

const askUserQuestion: ToolRenderer = {
	icon: "message-circle-question",
	label: "question",
	summary(args) {
		const questions = Array.isArray(args.questions) ? (args.questions as { question?: unknown }[]) : [];
		const first = str(questions[0]?.question);
		return questions.length > 1 ? `${first} (+${questions.length - 1})` : first;
	},
	body(el, result, host) {
		const details = result.details as { answers?: Answer[]; cancelled?: boolean } | null | undefined;
		if (!details || !Array.isArray(details.answers)) return false;
		const list = el.createDiv({ cls: "pi-tool-rich pi-qa" });
		for (const a of details.answers) {
			const row = list.createDiv({ cls: "pi-qa-row" });
			renderInline(host, row.createDiv({ cls: "pi-qa-question" }), a.question);
			const given = a.kind === "multi" ? (a.selected?.length ? a.selected.join(", ") : "Nothing selected") : (a.answer ?? "");
			renderInline(host, row.createDiv({ cls: "pi-qa-answer" }), given);
			if (a.notes) renderInline(host, row.createDiv({ cls: "pi-qa-notes" }), a.notes);
		}
		if (details.cancelled) list.createDiv({ cls: "pi-qa-notes", text: details.answers.length ? "Dismissed before the last question." : "Dismissed without answering." });
		return true;
	},
};

const advisor: ToolRenderer = {
	icon: "graduation-cap",
	summary(_args, result) {
		const d = result?.details as { advisorModel?: string; effort?: string } | null | undefined;
		return [d?.advisorModel, d?.effort].filter(Boolean).join(" · ") || "second opinion";
	},
	body: (el, result, host) => markdownBody(el, contentText(result.content), host),
};

interface SearchResult {
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	description?: string;
}

const webSearch: ToolRenderer = {
	icon: "globe",
	label: "search",
	summary(args, result) {
		const d = result?.details as { resultCount?: number; backend?: string } | null | undefined;
		const count = typeof d?.resultCount === "number" ? ` · ${d.resultCount} result${d.resultCount === 1 ? "" : "s"}` : "";
		return `${str(args.query)}${count}`;
	},
	body(el, result) {
		const results = (result.details as { results?: SearchResult[] } | null | undefined)?.results;
		if (!Array.isArray(results) || !results.length) return false;
		const list = el.createDiv({ cls: "pi-tool-rich pi-results" });
		for (const r of results) {
			if (!r.url) continue;
			const row = list.createDiv({ cls: "pi-result" });
			row.createEl("a", { cls: "pi-result-title external-link", text: r.title || r.url, href: r.url, attr: { target: "_blank", rel: "noopener" } });
			row.createDiv({ cls: "pi-result-url", text: r.url.replace(/^https?:\/\/(www\.)?/, "") });
			const snippet = r.snippet ?? r.description ?? r.content;
			if (snippet) row.createDiv({ cls: "pi-result-snippet", text: snippet.slice(0, 280) });
		}
		return true;
	},
};

const webFetch: ToolRenderer = {
	icon: "globe",
	label: "fetch",
	summary(args, result) {
		const title = str((result?.details as { title?: unknown } | null | undefined)?.title);
		return title || str(args.url).replace(/^https?:\/\/(www\.)?/, "");
	},
};

interface NoteHit {
	path: string;
	headings: string[];
	snippet: string;
}

// Characters that would end or split a wikilink, taken out of the shown text.
const linkLabel = (text: string) => text.replace(/[[\]|#^]/g, "");

const obsidianSearch: ToolRenderer = {
	icon: "search",
	label: "search notes",
	summary(args, result) {
		const hits = (result?.details as { hits?: unknown[] } | null | undefined)?.hits;
		const count = Array.isArray(hits) ? ` \u00b7 ${hits.length} section${hits.length === 1 ? "" : "s"}` : "";
		return `${str(args.query)}${count}`;
	},
	body(el, result, host) {
		const hits = (result.details as { hits?: NoteHit[] } | null | undefined)?.hits;
		if (!Array.isArray(hits) || !hits.length) return false;
		const list = el.createDiv({ cls: "pi-tool-rich pi-results" });
		for (const hit of hits) {
			const row = list.createDiv({ cls: "pi-result" });
			const note = hit.path.replace(/\.md$/, "");
			const label = [note.split("/").pop() ?? note, ...hit.headings].map(linkLabel).join(" \u203a ");
			renderInline(host, row.createDiv({ cls: "pi-result-title" }), `[[${note}|${label}]]`);
			row.createDiv({ cls: "pi-result-snippet", text: hit.snippet });
		}
		return true;
	},
};

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
	obsidian_search: obsidianSearch,
	todo,
	ask_user_question: askUserQuestion,
	advisor,
	web_search: webSearch,
	web_fetch: webFetch,
};
