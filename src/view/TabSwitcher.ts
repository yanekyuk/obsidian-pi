import { setIcon } from "obsidian";
import type { ChatSession, TabStatus } from "./ChatSession";

const STATUS_ICON: Partial<Record<TabStatus, string>> = {
	working: "loader",
	asking: "message-circle-question",
	error: "alert-triangle",
	unloaded: "moon",
};

// Most pressing first: what needs the user comes before what is merely running.
const ATTENTION_ORDER: TabStatus[] = ["asking", "error", "unread", "working"];
const STATUS_PHRASE: Partial<Record<TabStatus, string>> = { asking: "waiting for you", error: "stopped", unread: "finished", working: "working" };

// The mark for one status: a spinner, a question, a dot for unread. Idle gets nothing.
export function renderStatus(el: HTMLElement, status: TabStatus): void {
	if (el.dataset.status === status) return;
	el.dataset.status = status;
	el.empty();
	const icon = STATUS_ICON[status];
	if (icon) setIcon(el, icon);
}

// What the tabs the user isn't looking at are doing, boiled down to one mark.
export function summarize(tabs: ChatSession[]): { status: TabStatus; count: number; label: string } | null {
	const counts = new Map<TabStatus, number>();
	for (const tab of tabs) counts.set(tab.status, (counts.get(tab.status) ?? 0) + 1);
	const present = ATTENTION_ORDER.filter((status) => counts.has(status));
	if (!present.length) return null;
	const label = present.map((status) => `${counts.get(status)} ${STATUS_PHRASE[status]}`).join(", ");
	return { status: present[0], count: counts.get(present[0]) ?? 0, label: `Other tabs: ${label}` };
}

export interface SwitcherHost {
	tabs(): ChatSession[];
	active(): ChatSession | null;
	select(tab: ChatSession): void;
	close(tab: ChatSession): void;
	reload(tab: ChatSession): void;
	newTab(): void;
}

interface Row {
	tab: ChatSession;
	el: HTMLElement;
	statusEl: HTMLElement;
	titleEl: HTMLElement;
	noteEl: HTMLElement;
}

// The list of open tabs that drops down from the panel's title.
export class TabSwitcher {
	private el: HTMLElement;
	private rows: Row[] = [];
	private selected = 0;
	private onOutsidePointer = (evt: PointerEvent) => {
		const target = evt.target as Node;
		if (!this.el.contains(target) && !this.anchor.contains(target)) this.close();
	};

	constructor(
		parent: HTMLElement,
		private anchor: HTMLElement,
		private host: SwitcherHost,
	) {
		this.el = parent.createDiv({ cls: "pi-switcher suggestion-container", attr: { tabindex: "-1" } });
		this.el.hide();
		this.el.addEventListener("keydown", (evt) => this.onKey(evt));
	}

	get isOpen(): boolean {
		return this.el.isShown();
	}

	toggle(): void {
		if (this.isOpen) this.close();
		else this.open();
	}

	open(): void {
		this.el.show();
		this.anchor.addClass("is-active");
		const active = this.host.active();
		this.selected = Math.max(0, this.host.tabs().findIndex((tab) => tab === active));
		this.build();
		this.el.focus();
		this.el.ownerDocument.addEventListener("pointerdown", this.onOutsidePointer, true);
	}

	close(): void {
		if (!this.isOpen) return;
		this.el.ownerDocument.removeEventListener("pointerdown", this.onOutsidePointer, true);
		this.anchor.removeClass("is-active");
		this.el.hide();
	}

	// Tabs keep working while the list is open. Rows are patched in place rather than rebuilt,
	// so a status change can't pull a row out from under a click.
	update(): void {
		if (!this.isOpen) return;
		const tabs = this.host.tabs();
		if (tabs.length !== this.rows.length || tabs.some((tab, i) => this.rows[i].tab !== tab)) return this.build();
		const active = this.host.active();
		this.rows.forEach((row, i) => {
			renderStatus(row.statusEl, row.tab.status);
			row.titleEl.setText(row.tab.title);
			row.noteEl.setText(row.tab.detail);
			row.noteEl.toggle(row.tab.detail !== "");
			row.el.toggleClass("is-current", row.tab === active);
			row.el.toggleClass("is-selected", i === this.selected);
		});
	}

	private build(): void {
		this.el.empty();
		const list = this.el.createDiv({ cls: "suggestion" });
		const tabs = this.host.tabs();
		this.selected = Math.min(this.selected, tabs.length - 1);
		this.rows = tabs.map((tab, i) => {
			const el = list.createDiv({ cls: "pi-switcher-row suggestion-item mod-complex" });
			const statusEl = el.createDiv({ cls: "pi-tab-status suggestion-icon" });
			const content = el.createDiv({ cls: "suggestion-content" });
			const titleEl = content.createDiv({ cls: "suggestion-title" });
			const noteEl = content.createDiv({ cls: "suggestion-note" });
			const action = (icon: string, label: string, run: () => void) => {
				const button = el.createDiv({ cls: "pi-switcher-action clickable-icon", attr: { "aria-label": label } });
				setIcon(button, icon);
				button.addEventListener("click", (evt) => {
					evt.stopPropagation();
					run();
				});
			};
			action("refresh-cw", "Reload pi in this tab", () => this.host.reload(tab));
			action("x", "Close tab", () => this.host.close(tab));
			el.addEventListener("click", () => this.choose(tab));
			el.addEventListener("mousemove", () => {
				if (this.selected === i) return;
				this.selected = i;
				this.update();
			});
			return { tab, el, statusEl, titleEl, noteEl };
		});

		const add = list.createDiv({ cls: "pi-switcher-row pi-switcher-new suggestion-item mod-complex" });
		setIcon(add.createDiv({ cls: "suggestion-icon" }), "plus");
		add.createDiv({ cls: "suggestion-content" }).createDiv({ cls: "suggestion-title", text: "New tab" });
		add.addEventListener("click", () => {
			this.close();
			this.host.newTab();
		});
		this.update();
	}

	private choose(tab: ChatSession): void {
		this.close();
		this.host.select(tab);
	}

	private onKey(evt: KeyboardEvent): void {
		if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			this.close();
			this.anchor.focus();
		} else if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
			evt.preventDefault();
			this.selected = (this.selected + (evt.key === "ArrowDown" ? 1 : -1) + this.rows.length) % this.rows.length;
			this.update();
		} else if (evt.key === "Enter") {
			evt.preventDefault();
			const row = this.rows[this.selected];
			if (row) this.choose(row.tab);
		}
	}
}
