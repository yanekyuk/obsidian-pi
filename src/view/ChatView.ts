import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { existsSync } from "fs";
import { dirname } from "path";
import { readAdvisorConfig } from "../advisor";
import type PiAgentPlugin from "../main";
import type { SessionSummary } from "../sessions";
import { ChatSession, type SessionHost } from "./ChatSession";
import { confirmAction } from "./modals";
import { savedTabsFrom, type SavedTab } from "./savedTabs";
import { SessionsDrawer } from "./SessionsDrawer";
import { TabSwitcher, renderStatus, summarize } from "./TabSwitcher";

export const VIEW_TYPE_PI = "pi-harness-chat";

// Electron's trash keeps deletion reversible. It is external to the bundle and has no types here.
const { shell } = require("electron") as { shell: { trashItem(path: string): Promise<void> } };

// The chat panel: a toolbar, the session history, and one or more tabs, each a conversation
// with its own pi. One tab is on screen; the others keep working behind the title's dropdown.
export class ChatView extends ItemView {
	private tabs: ChatSession[] = [];
	private active: ChatSession | null = null;
	private saved: { tabs: SavedTab[]; active: number } | null = null;
	private ready = false;
	private adopted: SavedTab[] = [];
	private sessionHost: SessionHost;

	private tabsEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private nameEl!: HTMLElement;
	private othersEl!: HTMLElement;
	private othersCountEl!: HTMLElement;
	private sessionsBtn!: HTMLElement;
	private reloadBtn!: HTMLElement;
	private drawer!: SessionsDrawer;
	private switcher!: TabSwitcher;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PiAgentPlugin,
	) {
		super(leaf);
		this.sessionHost = {
			app: this.app,
			plugin,
			view: this,
			viewType: VIEW_TYPE_PI,
			isShowing: (tab) => tab === this.active && this.contentEl.isShown() && !this.drawer.isOpen,
			changed: (tab) => this.onTabChanged(tab),
			reveal: (tab) => void this.revealTab(tab),
			sessionsChanged: () => {
				this.app.workspace.requestSaveLayout();
				void this.drawer.refresh();
			},
			closeDrawer: () => this.drawer.close(),
		};
	}

	getViewType(): string {
		return VIEW_TYPE_PI;
	}

	getDisplayText(): string {
		return this.active ? `pi · ${this.active.title}` : "pi";
	}

	getIcon(): string {
		return "pi";
	}

	// The open tabs live in the view state, so Obsidian's workspace layout brings them back.
	// A session that was never written to has no file yet and nothing to come back to.
	getState(): Record<string, unknown> {
		const kept = this.tabs.filter((tab) => tab.heldSessionFile !== null);
		return {
			...super.getState(),
			tabs: kept.map((tab) => ({ sessionFile: tab.heldSessionFile, title: tab.title })),
			active: this.active ? kept.indexOf(this.active) : 0,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const saved = savedTabsFrom(state);
		if (saved && !this.ready) this.saved = saved;
		else if (saved) for (const tab of saved.tabs) if (!this.plugin.holderOf(tab.sessionFile) && existsSync(tab.sessionFile)) this.addTab(tab, false);
		await super.setState(state, result);
	}

	// Takes on tabs from somewhere else (a panel left over from before the plugin was renamed).
	// A session that is already open in some tab is not opened twice.
	// Before the panel has opened its own tabs they wait here, where the state Obsidian is about to apply can't overwrite them.
	adoptTabs(tabs: SavedTab[]): void {
		if (!this.ready) return void this.adopted.push(...tabs);
		for (const tab of tabs) if (existsSync(tab.sessionFile) && !this.plugin.holderOf(tab.sessionFile)) this.addTab(tab, false);
		this.app.workspace.requestSaveLayout();
	}

	async onOpen(): Promise<void> {
		this.buildDom();
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.active?.renderNoteChip()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.active?.renderNoteChip()));
		this.watchStatusBar();
		// Obsidian applies the saved view state right after onOpen resolves; open the tabs once it has.
		window.setTimeout(() => this.init());
	}

	async onClose(): Promise<void> {
		this.switcher.close();
		await Promise.all(this.tabs.map((tab) => tab.dispose()));
	}

	// Obsidian's status bar floats over the bottom-right corner of the window, which is where
	// this panel's composer buttons are when it sits in the right sidebar. How far the bar reaches
	// into the panel is measured and handed to the stylesheet, which keeps the bottom edge clear.
	private watchStatusBar(): void {
		const measure = () => {
			const bar = this.contentEl.ownerDocument.querySelector(".status-bar")?.getBoundingClientRect();
			const panel = this.contentEl.getBoundingClientRect();
			const covered = bar && bar.width > 0 && panel.width > 0 && bar.left < panel.right && bar.right > panel.left && bar.top < panel.bottom && bar.bottom > panel.top;
			this.contentEl.setCssProps({ "--pi-status-bar-clearance": covered ? `${Math.ceil(panel.bottom - bar.top)}px` : "0px" });
		};
		// The bar grows and shrinks with what plugins put in it; the panel moves with the layout.
		const observer = new ResizeObserver(measure);
		observer.observe(this.contentEl);
		const bar = this.contentEl.ownerDocument.querySelector(".status-bar");
		if (bar) observer.observe(bar);
		this.register(() => observer.disconnect());
		this.registerEvent(this.app.workspace.on("layout-change", measure));
		this.registerEvent(this.app.workspace.on("resize", measure));
		measure();
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		this.addMenuItems(menu);
	}

	private addMenuItems(menu: Menu): void {
		const tab = this.current();
		menu.addItem((i) => i.setTitle("New tab").setIcon("lucide-file-plus").onClick(() => this.newTab()));
		if (this.tabs.length > 1) menu.addItem((i) => i.setTitle("Close tab").setIcon("x").onClick(() => void this.closeTab(tab)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Rename session…").setIcon("pencil").onClick(() => void tab.renameCurrent()));
		const advisor = readAdvisorConfig().modelKey;
		menu.addItem((i) => i.setTitle(advisor ? `Advisor: ${advisor}…` : "Set advisor model…").setIcon("graduation-cap").onClick(() => void tab.configureAdvisor()));
		menu.addItem((i) => i.setTitle("Compact context").setIcon("fold-vertical").onClick(() => void tab.compact()));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Settings…").setIcon("settings").onClick(() => this.plugin.openSettings()));
	}

	// ---------------------------------------------------------------- DOM

	private buildDom(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("pi-view");

		// Obsidian hides a view's own header (and its addAction buttons) while the view is
		// docked in a sidebar, so the controls live inside the panel, styled like the file explorer's.
		const toolbar = root.createDiv({ cls: "pi-toolbar nav-header" });
		this.titleEl = toolbar.createDiv({ cls: "pi-toolbar-title", attr: { "aria-label": "Open tabs", role: "button", tabindex: "0" } });
		this.nameEl = this.titleEl.createSpan({ cls: "pi-toolbar-name" });
		setIcon(this.titleEl.createSpan({ cls: "pi-icon" }), "chevron-down");
		this.othersEl = this.titleEl.createSpan({ cls: "pi-toolbar-others" });
		renderStatus(this.othersEl.createSpan({ cls: "pi-tab-status" }), "idle");
		this.othersCountEl = this.othersEl.createSpan();
		this.titleEl.addEventListener("click", () => this.switcher.toggle());
		this.titleEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " " && evt.key !== "ArrowDown") return;
			evt.preventDefault();
			this.switcher.open();
		});

		const buttons = toolbar.createDiv({ cls: "nav-buttons-container" });
		const button = (icon: string, label: string, run: (evt: MouseEvent) => void) => {
			const el = buttons.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
			setIcon(el, icon);
			el.addEventListener("click", run);
			return el;
		};
		button("plus", "New session", () => void this.newSession());
		this.sessionsBtn = button("history", "Sessions", () => this.toggleSessions());
		this.reloadBtn = button("refresh-cw", "Reload pi (/reload)", () => void this.reload());
		button("more-vertical", "More", (evt) => {
			const menu = new Menu();
			this.addMenuItems(menu);
			menu.showAtMouseEvent(evt);
		});

		this.switcher = new TabSwitcher(toolbar, this.titleEl, {
			tabs: () => this.tabs,
			active: () => this.active,
			select: (tab) => this.activate(tab),
			close: (tab) => void this.closeTab(tab),
			reload: (tab) => void (tab === this.active ? this.reload() : tab.reload()),
			newTab: () => this.newTab(),
		});

		this.drawer = new SessionsDrawer(root, {
			sessionDir: () => {
				const file = this.active?.heldSessionFile ?? this.tabs.find((tab) => tab.heldSessionFile)?.heldSessionFile ?? (this.plugin.settings.lastSessionFile || null);
				return file ? dirname(file) : null;
			},
			currentSessionFile: () => this.active?.heldSessionFile ?? null,
			sessionsOpenElsewhere: () => new Set(this.plugin.heldSessionFiles(this.active)),
			openSession: (session) => void this.openSession(session.path),
			renameSession: (session) => void this.renameSession(session),
			duplicateSession: (session) => void this.duplicateSession(session),
			deleteSession: (session) => void this.deleteSession(session),
			newSession: () => void this.newSession(),
		});
		this.drawer.onClose = () => {
			root.removeClass("is-showing-sessions");
			this.sessionsBtn.removeClass("is-active");
			this.active?.show();
			this.focusComposer();
		};

		this.tabsEl = root.createDiv({ cls: "pi-tabs" });
	}

	private renderTitle(): void {
		this.nameEl.setText(this.active?.title ?? "pi");
		const others = summarize(this.tabs.filter((tab) => tab !== this.active));
		this.othersEl.toggle(others !== null);
		if (others) {
			renderStatus(this.othersEl.firstElementChild as HTMLElement, others.status);
			this.othersCountEl.setText(others.count > 1 ? String(others.count) : "");
			this.othersEl.setAttr("aria-label", others.label);
		}
	}

	// ---------------------------------------------------------------- tabs

	// Opens the tabs the workspace layout remembers, or the last session, or a fresh one.
	// Only the tab on screen starts its pi; the rest start when they are first looked at.
	private init(): void {
		if (this.ready) return;
		this.ready = true;
		const { resumeLastSession, lastSessionFile } = this.plugin.settings;
		const own = !resumeLastSession ? [] : this.saved ? this.saved.tabs : lastSessionFile ? [{ sessionFile: lastSessionFile, title: "" }] : [];
		const wanted = [...own, ...this.adopted.splice(0), ...this.plugin.takePendingTabs()];
		// Each session file gets one pi, whichever panel asks first.
		for (const tab of wanted) if (existsSync(tab.sessionFile) && !this.plugin.holderOf(tab.sessionFile)) this.addTab(tab, false);
		const lastActive = this.saved?.tabs[this.saved.active]?.sessionFile;
		this.activate(this.tabs.find((tab) => tab.heldSessionFile === lastActive) ?? this.tabs[0] ?? this.addTab({ sessionFile: null }, false));
	}

	// The tab on screen. Commands can arrive before the panel has opened its tabs.
	private current(): ChatSession {
		this.init();
		return this.active as ChatSession;
	}

	private addTab(initial: { sessionFile: string | null; title?: string }, activate = true): ChatSession {
		const tab = new ChatSession(this.tabsEl, this.sessionHost, initial);
		this.tabs.push(tab);
		if (activate) this.activate(tab);
		else this.onTabChanged(tab);
		return tab;
	}

	private activate(tab: ChatSession): void {
		this.drawer.close();
		if (tab !== this.active) {
			this.active?.hide();
			this.active = tab;
			tab.show();
			this.app.workspace.requestSaveLayout();
		}
		this.onTabChanged(tab);
		tab.focusComposer();
	}

	private onTabChanged(_tab: ChatSession): void {
		if (!this.titleEl) return;
		this.renderTitle();
		this.switcher.update();
		// Refreshes the workspace tab's title, which shows the session name.
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
	}

	tabFor(sessionFile: string): ChatSession | null {
		return this.tabs.find((tab) => tab.heldSessionFile === sessionFile) ?? null;
	}

	heldSessionFiles(except?: ChatSession | null): string[] {
		return this.tabs.filter((tab) => tab !== except).flatMap((tab) => tab.heldSessionFile ?? []);
	}

	async revealTab(tab: ChatSession): Promise<void> {
		await this.app.workspace.revealLeaf(this.leaf);
		this.activate(tab);
	}

	// A new tab beside the ones that are open. An empty one is reused: two would be no use.
	newTab(): void {
		this.init();
		this.activate(this.tabs.find((tab) => tab.isEmpty) ?? this.addTab({ sessionFile: null }, false));
	}

	// Closing stops that tab's pi. The conversation stays in the session history.
	async closeTab(tab: ChatSession): Promise<void> {
		if (!this.tabs.includes(tab)) return;
		if (tab.isBusy && !(await confirmAction(this.app, "Close this tab?", `pi is still working in "${tab.title}". Closing the tab stops it.`, "Stop and close"))) return;
		const index = this.tabs.indexOf(tab);
		if (index === -1) return;
		this.tabs.splice(index, 1);
		if (tab === this.active) {
			this.active = null;
			this.activate(this.tabs[Math.min(index, this.tabs.length - 1)] ?? this.addTab({ sessionFile: null }, false));
		}
		this.onTabChanged(tab);
		this.app.workspace.requestSaveLayout();
		await tab.dispose();
	}

	// ---------------------------------------------------------------- sessions

	// A fresh session, in a tab of its own. A conversation is never swapped out from under the
	// user: the only tab that gets reused is one with nothing in it.
	async newSession(): Promise<void> {
		this.init();
		this.drawer.close();
		this.newTab();
	}

	async openSession(path: string): Promise<void> {
		this.init();
		// Two pi processes appending to one session file would corrupt it; go to the tab that has it.
		const holder = this.plugin.holderOf(path);
		if (holder) return holder.view.revealTab(holder.tab);
		if (!existsSync(path)) {
			new Notice("That session file no longer exists.");
			return void this.drawer.refresh();
		}
		const empty = this.tabs.find((tab) => tab.isEmpty);
		if (!empty) return void this.addTab({ sessionFile: path });
		this.activate(empty);
		await empty.load(path);
	}

	toggleSessions(): void {
		this.init();
		if (this.drawer.isOpen) return this.drawer.close();
		this.switcher.close();
		this.active?.hide();
		this.contentEl.addClass("is-showing-sessions");
		this.sessionsBtn.addClass("is-active");
		this.drawer.open();
	}

	// pi can only name the session it has loaded, so renaming another one opens it first.
	// Writing the entry into the file by hand could collide with a pi that has it open.
	private async renameSession(session: SessionSummary): Promise<void> {
		await (await this.opened(session.path))?.renameCurrent();
	}

	private async duplicateSession(session: SessionSummary): Promise<void> {
		await (await this.opened(session.path))?.duplicate();
	}

	// The tab that has this session, opened if need be, with its pi up.
	private async opened(path: string): Promise<ChatSession | null> {
		await this.openSession(path);
		const tab = this.plugin.holderOf(path)?.tab ?? null;
		await tab?.whenReady();
		return tab;
	}

	private async deleteSession(session: SessionSummary): Promise<void> {
		const ok = await confirmAction(this.app, "Move session to trash?", `"${session.title}" will be moved to the system trash.`, "Move to trash");
		if (!ok) return;
		try {
			// Let go of the file before removing it, or pi would recreate it on its next write.
			const holder = this.plugin.holderOf(session.path);
			if (holder) await holder.view.closeTab(holder.tab);
			if (this.plugin.holderOf(session.path)) return; // the user chose to keep a busy tab open
			await shell.trashItem(session.path);
			if (this.plugin.settings.lastSessionFile === session.path) {
				this.plugin.settings.lastSessionFile = this.active?.heldSessionFile ?? "";
				await this.plugin.saveSettings();
			}
		} catch (err) {
			new Notice(`Couldn't move the session to the trash: ${(err as Error).message}`);
		}
		void this.drawer.refresh();
	}

	// ---------------------------------------------------------------- for the plugin's commands

	focusComposer(): void {
		this.active?.focusComposer();
	}

	insertText(text: string): void {
		this.drawer.close();
		this.current().insertText(text);
	}

	showTabs(): void {
		this.init();
		this.drawer.close();
		this.switcher.open();
	}

	closeCurrentTab(): Promise<void> {
		return this.closeTab(this.current());
	}

	renameCurrent(): Promise<void> {
		return this.current().renameCurrent();
	}

	configureAdvisor(): Promise<void> {
		return this.current().configureAdvisor();
	}

	get isBusy(): boolean {
		return this.tabs.some((tab) => !tab.replaceable);
	}

	// After an update: tabs where pi is at rest pick up the new code, the others are left alone.
	async reloadIdleTabs(): Promise<void> {
		await Promise.all(this.tabs.filter((tab) => tab.isRunning && tab.replaceable).map((tab) => tab.reload()));
	}

	// Acts on the tab on screen; the button turns while that tab's pi comes back up.
	async reload(): Promise<void> {
		const tab = this.current();
		this.drawer.close();
		this.reloadBtn.addClass("is-reloading");
		try {
			await tab.reload();
		} finally {
			this.reloadBtn.removeClass("is-reloading");
		}
	}
}
