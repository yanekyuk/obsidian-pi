import { prepareFuzzySearch, type App } from "obsidian";
import type { SlashCommand } from "../rpc/types";

interface Item {
	label: string;
	detail: string;
	insert: string;
}

interface Trigger {
	start: number;
	query: string;
	kind: "command" | "note";
}

const MAX_ITEMS = 8;

// Popover above the composer: "/" at the start completes pi commands and skills,
// "@" anywhere completes vault notes as wikilinks.
export class ComposerSuggest {
	private el: HTMLElement;
	private items: Item[] = [];
	private selected = 0;
	private trigger: Trigger | null = null;
	commands: SlashCommand[] = [];

	constructor(
		private app: App,
		private input: HTMLTextAreaElement,
		parent: HTMLElement,
	) {
		this.el = parent.createDiv({ cls: "pi-suggest suggestion-container" });
		this.el.hide();
		input.addEventListener("input", () => this.update());
		input.addEventListener("blur", () => window.setTimeout(() => this.close(), 100));
	}

	get isOpen(): boolean {
		return this.trigger !== null && this.items.length > 0;
	}

	// Returns true when the key was consumed by the popover.
	handleKey(evt: KeyboardEvent): boolean {
		if (!this.isOpen) return false;
		if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
			const step = evt.key === "ArrowDown" ? 1 : -1;
			this.selected = (this.selected + step + this.items.length) % this.items.length;
			this.render();
		} else if (evt.key === "Enter" || evt.key === "Tab") {
			this.accept(this.items[this.selected]);
		} else if (evt.key === "Escape") {
			this.close();
		} else {
			return false;
		}
		evt.preventDefault();
		return true;
	}

	close(): void {
		this.trigger = null;
		this.el.hide();
	}

	private findTrigger(): Trigger | null {
		const before = this.input.value.slice(0, this.input.selectionStart);
		const command = before.match(/^\/(\S*)$/);
		if (command) return { start: 0, query: command[1], kind: "command" };
		const note = before.match(/(?:^|\s)@([^\s@]*)$/);
		if (note) return { start: before.length - note[1].length - 1, query: note[1], kind: "note" };
		// Obsidian's own habit: the wikilink is completed, brackets included.
		const link = before.match(/\[\[([^\][]*)$/);
		if (link) return { start: before.length - link[1].length - 2, query: link[1], kind: "note" };
		return null;
	}

	private update(): void {
		this.trigger = this.findTrigger();
		if (!this.trigger) return this.close();
		const { query, kind } = this.trigger;
		const candidates: Item[] =
			kind === "command"
				? this.commands.map((c) => ({ label: `/${c.name}`, detail: c.description ?? c.source, insert: `/${c.name} ` }))
				: this.app.vault.getMarkdownFiles().map((f) => ({
						label: f.basename,
						detail: f.parent?.path === "/" ? "" : (f.parent?.path ?? ""),
						insert: `[[${f.path.replace(/\.md$/, "")}]] `,
					}));

		if (query) {
			const match = prepareFuzzySearch(query);
			this.items = candidates
				.map((item) => ({ item, score: match(item.label)?.score }))
				.filter((r): r is { item: Item; score: number } => r.score !== undefined)
				.sort((a, b) => b.score - a.score)
				.slice(0, MAX_ITEMS)
				.map((r) => r.item);
		} else {
			this.items = candidates.slice(0, MAX_ITEMS);
		}
		this.selected = 0;
		this.render();
	}

	private render(): void {
		this.el.empty();
		if (!this.items.length) return this.el.hide();
		const list = this.el.createDiv({ cls: "suggestion" });
		this.items.forEach((item, i) => {
			const row = list.createDiv({ cls: "suggestion-item mod-complex" + (i === this.selected ? " is-selected" : "") });
			const content = row.createDiv({ cls: "suggestion-content" });
			content.createDiv({ cls: "suggestion-title", text: item.label });
			if (item.detail) content.createDiv({ cls: "suggestion-note", text: item.detail });
			// mousedown, not click: the textarea's blur would close the popover first.
			row.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				this.accept(item);
			});
		});
		this.el.show();
	}

	private accept(item: Item): void {
		if (!this.trigger) return;
		const { value, selectionStart } = this.input;
		const head = value.slice(0, this.trigger.start) + item.insert;
		this.input.value = head + value.slice(selectionStart);
		this.input.setSelectionRange(head.length, head.length);
		this.close();
		this.input.dispatchEvent(new Event("input"));
	}
}
