import { Menu, moment, prepareFuzzySearch, setIcon } from "obsidian";
import { listSessions, type SessionSummary } from "../sessions";

export interface SessionsHost {
	sessionDir(): string | null;
	currentSessionFile(): string | null;
	// Session files held by other chat panels; two pi processes must never share one.
	sessionsOpenElsewhere(): Set<string>;
	openSession(session: SessionSummary): void;
	openSessionInNewTab(session: SessionSummary): void;
	renameSession(session: SessionSummary): void;
	duplicateSession(session: SessionSummary): void;
	deleteSession(session: SessionSummary): void;
	newSession(): void;
}

function groupOf(mtime: number): string {
	const days = moment().startOf("day").diff(moment(mtime).startOf("day"), "days");
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 7) return "Previous 7 days";
	if (days < 30) return "Previous 30 days";
	return "Older";
}

// The session browser that takes over the transcript area while it is open.
export class SessionsDrawer {
	readonly el: HTMLElement;
	private searchEl: HTMLInputElement;
	private listEl: HTMLElement;
	private sessions: SessionSummary[] = [];
	private visible: SessionSummary[] = [];
	private selected = 0;
	private loadId = 0;
	onClose: () => void = () => {};

	constructor(
		parent: HTMLElement,
		private host: SessionsHost,
	) {
		this.el = parent.createDiv({ cls: "pi-sessions" });
		this.el.hide();

		const top = this.el.createDiv({ cls: "pi-sessions-top" });
		this.searchEl = top.createEl("input", { type: "search", cls: "pi-sessions-search", attr: { placeholder: "Search sessions…" } });
		this.searchEl.addEventListener("input", () => {
			this.selected = 0;
			this.render();
		});
		this.searchEl.addEventListener("keydown", (evt) => this.onKey(evt));
		const newBtn = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "New session" } });
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => this.host.newSession());

		this.listEl = this.el.createDiv({ cls: "pi-sessions-list" });
	}

	get isOpen(): boolean {
		return this.el.isShown();
	}

	open(): void {
		this.el.show();
		this.searchEl.value = "";
		this.selected = 0;
		this.searchEl.focus();
		void this.refresh();
	}

	close(): void {
		if (!this.isOpen) return;
		this.el.hide();
		this.onClose();
	}

	async refresh(): Promise<void> {
		if (!this.isOpen) return;
		const dir = this.host.sessionDir();
		if (!dir) {
			this.sessions = [];
			return this.render("This session isn't saved to disk, so there is no history to browse.");
		}
		const id = ++this.loadId;
		if (!this.sessions.length) this.render("Loading…");
		const sessions = await listSessions(dir).catch(() => []);
		if (id !== this.loadId) return; // a newer refresh superseded this one
		this.sessions = sessions;
		this.render();
	}

	private onKey(evt: KeyboardEvent): void {
		if (evt.key === "Escape") {
			evt.preventDefault();
			this.close();
		} else if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
			evt.preventDefault();
			if (!this.visible.length) return;
			this.selected = (this.selected + (evt.key === "ArrowDown" ? 1 : -1) + this.visible.length) % this.visible.length;
			this.render();
			this.listEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
		} else if (evt.key === "Enter" && !evt.isComposing) {
			evt.preventDefault();
			const session = this.visible[this.selected];
			if (session) this.host.openSession(session);
		}
	}

	private filtered(): SessionSummary[] {
		const query = this.searchEl.value.trim();
		if (!query) return this.sessions;
		const match = prepareFuzzySearch(query);
		return this.sessions
			.map((session) => ({ session, score: match(session.title)?.score }))
			.filter((r): r is { session: SessionSummary; score: number } => r.score !== undefined)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.session);
	}

	private render(placeholder?: string): void {
		this.listEl.empty();
		this.visible = placeholder ? [] : this.filtered();
		if (!this.visible.length) {
			this.listEl.createDiv({ cls: "pi-sessions-empty", text: placeholder ?? (this.sessions.length ? "No sessions match." : "No saved sessions yet.") });
			return;
		}

		const current = this.host.currentSessionFile();
		const elsewhere = this.host.sessionsOpenElsewhere();
		// Search results are ranked by relevance, so date headings would be out of order there.
		const grouped = !this.searchEl.value.trim();
		let lastGroup = "";

		this.visible.forEach((session, i) => {
			const group = groupOf(session.mtime);
			if (grouped && group !== lastGroup) {
				this.listEl.createDiv({ cls: "pi-sessions-group", text: group });
				lastGroup = group;
			}
			const isCurrent = session.path === current;
			const row = this.listEl.createDiv({ cls: "pi-session" });
			row.toggleClass("is-current", isCurrent);
			row.toggleClass("is-selected", i === this.selected);

			const main = row.createDiv({ cls: "pi-session-main" });
			main.createDiv({ cls: "pi-session-title", text: session.title });
			const meta = [moment(session.mtime).fromNow()];
			if (isCurrent) meta.push("current");
			else if (elsewhere.has(session.path)) meta.push("open in another tab");
			main.createDiv({ cls: "pi-session-meta", text: meta.join(" · ") });

			const more = row.createEl("button", { cls: "pi-session-more clickable-icon", attr: { "aria-label": "More" } });
			setIcon(more, "more-horizontal");
			more.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.showMenu(session, evt);
			});
			row.addEventListener("click", () => this.host.openSession(session));
			row.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.showMenu(session, evt);
			});
		});
	}

	private showMenu(session: SessionSummary, evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Open").setIcon("message-square").onClick(() => this.host.openSession(session)));
		menu.addItem((i) => i.setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => this.host.openSessionInNewTab(session)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => this.host.renameSession(session)));
		menu.addItem((i) => i.setTitle("Duplicate").setIcon("copy").onClick(() => this.host.duplicateSession(session)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Move to trash").setIcon("trash-2").setWarning(true).onClick(() => this.host.deleteSession(session)));
		menu.showAtMouseEvent(evt);
	}
}
