import { FileSystemAdapter, Notice, Plugin, TFile, addIcon, type Editor } from "obsidian";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import { basename, delimiter, isAbsolute, join, resolve } from "path";
import { DEFAULT_INHERITANCE, HARNESS_AGENT_DIR, USER_AGENT_DIR, prepareAgentDir, sessionDirFor } from "./agentDir";
import { loadsAllSkills, readPackageEntries, sourceOf } from "./packages";
import { MCP_ADAPTER, Requirements } from "./requirements";
import { BrowserControl } from "./browser";
import { ObsidianControl } from "./obsidianControl";
import { extractBundledFiles } from "./bundled";
import { StatusBar } from "./statusBar";
import { linkedSession, resolveLinked, sessionDirs } from "./noteLink";
import { resolveEnv } from "./env";
import { buildSystemPrompt } from "./prompt";
import type { PiSpawnOptions } from "./rpc/PiRpcClient";
import { DEFAULT_SETTINGS, PiAgentSettingTab, type PiAgentSettings } from "./settings";
import type { ChatSession } from "./view/ChatSession";
import { ChatView, VIEW_TYPE_PI } from "./view/ChatView";
import { panelsIn, type SavedTab } from "./view/savedTabs";

const MAX_SESSIONS_WITH_HIDDEN_TODOS = 30;
const LEGACY_VIEW_TYPE = "pi-agent-chat";
const UPDATE_CHECK_MS = 20 * 60 * 1000;
const PI_ICON = `<path d="M18 30h64M38 30v46M64 30v34c0 8 4 12 12 12" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;

export default class PiAgentPlugin extends Plugin {
	settings: PiAgentSettings = DEFAULT_SETTINGS;
	browser = new BrowserControl(this.app);
	obsidian = new ObsidianControl(this.app, () => this.settings.commandAllowlist);
	statusBar!: StatusBar;

	requirements = new Requirements({
		piCommand: () => this.piCommand(),
		enabled: () => this.settings.manageExtensions,
		autoUpdate: () => this.settings.autoUpdate,
		busy: () => this.chatViews().some((view) => view.isBusy),
		lastUpdate: () => this.settings.lastExtensionUpdate,
		setLastUpdate: async (time) => {
			this.settings.lastExtensionUpdate = time;
			await this.saveSettings();
		},
		notify: (message) => new Notice(message, 8000),
	});

	get vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Pi Harness needs a vault on the local file system.");
		return adapter.getBasePath();
	}

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<PiAgentSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved, inherit: { ...DEFAULT_INHERITANCE, ...saved?.inherit } };
		addIcon("pi", PI_ICON);
		void resolveEnv(); // warm the shell PATH lookup before the first spawn
		// Before any chat starts pi, whose PATH includes the launcher.
		if (this.manifest.dir) await extractBundledFiles(join(this.vaultPath, this.manifest.dir)).catch((err) => console.warn("[pi-harness] couldn't write the bundled launcher", err));

		this.registerView(VIEW_TYPE_PI, (leaf) => new ChatView(leaf, this));
		this.app.workspace.onLayoutReady(() => void this.adoptLegacyPanels());
		this.registerHoverLinkSource(VIEW_TYPE_PI, { display: "Pi Harness", defaultMod: true });
		this.addSettingTab(new PiAgentSettingTab(this.app, this));
		this.addRibbonIcon("pi", "Open pi", () => void this.activateView());
		this.statusBar = new StatusBar(this, () => this.chatViews(), (tab) => void this.chatViews().find((view) => view.allTabs().includes(tab))?.revealTab(tab));

		// obsidian://pi-harness?prompt=…  puts the words in the composer of a new tab; &send=1 sends
		// them; &note=Folder/Note opens pi for that note; &session=<file name> opens that session.
		this.registerObsidianProtocolHandler("pi-harness", (params) => void this.handleUri(params));

		// Well after startup, so it never competes with Obsidian loading or pi's first start. After
		// that it keeps asking: the update itself decides whether a day has passed and pi is idle.
		this.registerInterval(window.setTimeout(() => void this.updateExtensions(false), 60_000));
		this.registerInterval(window.setInterval(() => void this.updateExtensions(false), UPDATE_CHECK_MS));

		this.addCommand({ id: "update-extensions", name: "Update pi and its packages", callback: () => void this.updateExtensions(true) });
		this.addCommand({
			id: "advisor",
			name: "Set advisor model",
			callback: async () => (await this.activateView())?.configureAdvisor(),
		});
		this.addCommand({ id: "open", name: "Open chat", callback: () => void this.activateView() });
		this.addCommand({ id: "settings", name: "Open settings", callback: () => this.openSettings() });
		this.addCommand({
			id: "new-session",
			name: "New session",
			callback: async () => (await this.activateView())?.newSession(),
		});
		this.addCommand({ id: "new-tab", name: "New tab", callback: async () => (await this.activateView())?.newTab() });
		this.addCommand({
			id: "open-for-note",
			name: "Open pi for this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.openForNote(file);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((i) => i.setTitle("Open pi for this note").setIcon("pi").onClick(() => void this.openForNote(file)));
			}),
		);
		this.addCommand({ id: "export-session", name: "Export conversation to a note", callback: async () => (await this.activateView())?.current().exportToNote() });
		this.addCommand({ id: "close-tab", name: "Close tab", callback: async () => (await this.activateView())?.closeCurrentTab() });
		this.addCommand({ id: "switch-tab", name: "Switch tab", callback: async () => (await this.activateView())?.showTabs() });
		this.addCommand({ id: "new-panel", name: "Open another chat panel", callback: () => void this.openNewPanel() });
		this.addCommand({
			id: "sessions",
			name: "Show sessions",
			callback: async () => (await this.activateView())?.toggleSessions(),
		});
		this.addCommand({
			id: "rename-session",
			name: "Rename session",
			callback: async () => (await this.activateView())?.renameCurrent(),
		});
		this.addCommand({
			id: "restart",
			name: "Reload pi",
			callback: async () => (await this.activateView())?.reload(),
		});
		this.addCommand({
			id: "add-selection",
			name: "Add selection to chat",
			editorCallback: async (editor: Editor) => {
				const selection = editor.getSelection();
				if (!selection) return;
				const quoted = selection.split("\n").map((line) => `> ${line}`).join("\n");
				(await this.activateView())?.insertText(`${quoted}\n\n`);
			},
		});
	}

	async updateExtensions(force: boolean): Promise<void> {
		try {
			if (force) new Notice("Updating pi and its packages…");
			const changed = await this.requirements.update(force);
			if (changed.length) {
				// Tabs with pi at work keep the old code until they are reloaded by hand.
				const notice = new Notice(`Updated ${changed.join(", ")}. Click to reload pi.`, 15000);
				notice.noticeEl.addEventListener("click", () => this.chatViews().forEach((view) => void view.reloadIdleTabs()));
			} else if (force) new Notice("pi and its packages are up to date.");
		} catch (err) {
			if (force) new Notice(`Couldn't update pi: ${(err as Error).message}`, 8000);
		}
	}

	hiddenTodosFor(sessionFile: string | null): string[] {
		return (sessionFile && this.settings.hiddenTodos[sessionFile]) || [];
	}

	// Cleared tasks are remembered per session, for the most recent sessions only.
	async setHiddenTodos(sessionFile: string | null, hidden: string[]): Promise<void> {
		if (!sessionFile) return;
		const { [sessionFile]: _previous, ...rest } = this.settings.hiddenTodos;
		const kept = Object.entries(rest).slice(-(MAX_SESSIONS_WITH_HIDDEN_TODOS - 1));
		this.settings.hiddenTodos = Object.fromEntries([...kept, [sessionFile, hidden]]);
		await this.saveSettings();
	}

	// Enabled is not the same as running: Obsidian keeps an id in its enabled list after the
	// plugin's folder is gone, which is exactly what a rename leaves behind.
	isPluginRunning(id: string): boolean {
		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
		return Boolean(plugins?.plugins?.[id]);
	}

	// Opens Obsidian's settings on this plugin's tab. Not in the public API, hence the guards.
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	isPluginEnabled(id: string): boolean {
		// Not in the public API, hence the guard: a wrong "no" only costs a hint in a warning.
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
		return plugins?.enabledPlugins?.has(id) ?? false;
	}

	// How to run the pi binary for anything other than the chat process itself.
	async piCommand(): Promise<{ binary: string; env: NodeJS.ProcessEnv; cwd: string }> {
		return { binary: this.settings.piPath, env: await this.piEnv(), cwd: this.vaultPath };
	}

	// Before it was published the plugin was called Pi Agent, and its panels are still in the
	// workspace layout under that name's view type, as dead panes holding their open tabs. Their
	// tabs move to a live panel and the dead pane is closed.
	//
	// The layout file is read from disk: what a pane whose plugin is gone reports about itself at
	// run time is Obsidian's business and has proved unreliable, while the file says plainly what
	// was saved. Another plugin now owns the old name, so a pane is only touched while that plugin
	// isn't running and the state in it is plainly ours. Each pane is adopted once, so a tab the
	// user closes afterwards stays closed even if the dead pane could not be removed.
	private async adoptLegacyPanels(): Promise<void> {
		if (this.isPluginRunning("pi-agent")) return;
		try {
			const layout: unknown = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/workspace.json`));
			const found = panelsIn(layout, LEGACY_VIEW_TYPE);

			for (const { id, tabs } of found) {
				if (!this.settings.adoptedLegacyPanels.includes(id)) {
					this.settings.adoptedLegacyPanels = [...this.settings.adoptedLegacyPanels, id];
					await this.saveSettings();
					const live = this.chatViews()[0];
					if (live) live.adoptTabs(tabs);
					else this.pendingTabs.push(...tabs); // for the first panel that opens
					console.debug(`[pi-harness] adopted ${tabs.length} tabs from the old panel ${id}${live ? "" : " (waiting for a panel)"}`);
				}
				this.app.workspace.getLeafById(id)?.detach();
			}
		} catch (err) {
			console.warn("[pi-harness] couldn't look for panels from before the rename", err);
		}
	}

	private pendingTabs: SavedTab[] = [];

	takePendingTabs(): SavedTab[] {
		return this.pendingTabs.splice(0);
	}

	// The settings files pi reads its package lists from: the panel's pi, and the vault's own .pi folder.
	get panelSettingsFile(): string {
		return join(this.settings.isolate ? HARNESS_AGENT_DIR : USER_AGENT_DIR, "settings.json");
	}

	get vaultSettingsFile(): string {
		return join(this.vaultPath, ".pi", "settings.json");
	}

	// The environment every pi the plugin starts runs in: the chat, side questions, installs and updates.
	private async piEnv(): Promise<NodeJS.ProcessEnv> {
		const env = { ...(await resolveEnv()) };
		// The Obsidian CLI skill calls `obsidian`. The plugin's launcher goes last on the PATH, so
		// a command of that name the user already has wins.
		if (this.manifest.dir) env.PATH = [env.PATH, join(this.vaultPath, this.manifest.dir, "bin")].filter(Boolean).join(delimiter);
		if (this.settings.isolate) {
			env.PI_CODING_AGENT_DIR = await prepareAgentDir(this.vaultPath, this.settings.inherit);
			// pi's MCP adapter reads global files outside any pi folder. In this mode it reads one
			// file only: the one --mcp-config names (the vault's, see buildSpawnOptions).
			if (!this.settings.inherit.mcpServers) env.PI_MCP_CONFIG_MODE = "exclusive";
		}
		return env;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	chatViews(): ChatView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_PI)
			.map((leaf) => leaf.view)
			.filter((view): view is ChatView => view instanceof ChatView);
	}

	// The tab that has this session file, in whichever chat panel. Each file gets at most one pi process.
	holderOf(sessionFile: string, except?: ChatSession): { view: ChatView; tab: ChatSession } | null {
		for (const view of this.chatViews()) {
			const tab = view.tabFor(sessionFile);
			if (tab && tab !== except) return { view, tab };
		}
		return null;
	}

	heldSessionFiles(except?: ChatSession | null): string[] {
		return this.chatViews().flatMap((view) => view.heldSessionFiles(except));
	}

	// A second chat panel, for having two conversations side by side. It starts on a fresh session.
	async openNewPanel(): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_PI, active: true, state: { fresh: true } });
		await workspace.revealLeaf(leaf);
	}

	// Focuses the chat the user was last in, or opens the first one.
	private async handleUri(params: Record<string, string>): Promise<void> {
		const view = await this.activateView();
		if (!view) return;
		if (params.session) {
			const path = resolveLinked(params.session, sessionDirs(this.sessionDir(), this.settings.lastSessionFile));
			if (!path) return void new Notice("No such pi session here.");
			await view.openSession(path);
		} else if (params.note) {
			const file = this.app.vault.getAbstractFileByPath(params.note.endsWith(".md") ? params.note : `${params.note}.md`);
			if (!(file instanceof TFile)) return void new Notice(`No note at ${params.note}.`);
			await this.openForNote(file);
		} else if (params.prompt) view.newTab();
		if (!params.prompt) return;
		const tab = view.current();
		tab.insertText(params.prompt);
		if (params.send && params.send !== "0" && params.send !== "false") await tab.sendDraft();
	}

	// Where the panel's pi keeps this vault's sessions.
	sessionDir(): string {
		const s = this.settings;
		return s.isolate && !s.inherit.sessions ? sessionDirFor(this.vaultPath, HARNESS_AGENT_DIR) : sessionDirFor(this.vaultPath);
	}

	// The note's own session when it has one here; otherwise a new tab that becomes its session.
	async openForNote(file: TFile): Promise<void> {
		const view = await this.activateView();
		if (!view) return;
		const linked = linkedSession(this.app, file);
		const path = linked ? resolveLinked(linked, sessionDirs(this.sessionDir(), this.settings.lastSessionFile)) : null;
		if (path) return view.openSession(path);
		if (linked) new Notice("The session linked to this note isn't on this machine, so a new one starts.");
		view.newTab();
		view.current().linkToNote(file);
	}

	async activateView(): Promise<ChatView | null> {
		const { workspace } = this.app;
		const active = workspace.getActiveViewOfType(ChatView);
		let leaf = active?.leaf ?? workspace.getLeavesOfType(VIEW_TYPE_PI)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return null;
			leaf = right;
			await leaf.setViewState({ type: VIEW_TYPE_PI, active: true });
		}
		await workspace.revealLeaf(leaf);
		if (!(leaf.view instanceof ChatView)) return null;
		leaf.view.focusComposer();
		return leaf.view;
	}

	async buildSpawnOptions(sessionFile: string | null): Promise<PiSpawnOptions> {
		const s = this.settings;
		const vault = this.vaultPath;
		const args: string[] = ["--append-system-prompt", buildSystemPrompt(this.app.vault.getName(), s.systemPromptAddendum)];

		if (s.model) args.push("--model", s.model);
		if (sessionFile) args.push("--session", sessionFile);

		const env = await this.piEnv();
		const skillDirs = s.extraSkillPaths
			.split("\n")
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => (isAbsolute(p) ? p : join(vault, p)));
		if (s.isolate) {
			// A config folder of its own doesn't stop pi from finding ~/.agents/skills, so skills are
			// named one by one instead: those of installed packages and the vault's own. The vault's
			// count only once the user has trusted it, as they would if pi went looking by itself.
			args.push("--no-skills");
			if (s.inherit.sessions) args.push("--session-dir", sessionDirFor(vault));
			const packages = await this.requirements.installed().catch(() => []);
			// Naming a skills folder would load it whatever the package's entry says, so a package
			// that is switched off, or whose skills the user has narrowed down, is not named.
			const entries = [...(await readPackageEntries(this.panelSettingsFile)), ...(await readPackageEntries(this.vaultSettingsFile))];
			const narrowed = new Set(entries.filter((entry) => !loadsAllSkills(entry)).map(sourceOf));
			skillDirs.unshift(...packages.filter((pkg) => !narrowed.has(pkg.source)).map((pkg) => join(pkg.path, "skills")));
			if (await this.vaultIsTrusted(env)) skillDirs.push(join(vault, ".pi", "skills"), join(vault, ".agents", "skills"));
			if (s.inherit.skills) skillDirs.push(join(homedir(), ".agents", "skills"), join(USER_AGENT_DIR, "skills"));
			// The flag belongs to the adapter; pi refuses flags nobody registered.
			const mcpConfig = join(vault, ".mcp.json");
			if (!s.inherit.mcpServers && existsSync(mcpConfig) && packages.some((pkg) => basename(pkg.path) === MCP_ADAPTER)) args.push("--mcp-config", mcpConfig);
		}
		for (const dir of new Set(skillDirs)) if (existsSync(dir)) args.push("--skill", dir);

		// pi's browser_* tools for Obsidian's web viewer; the file is unpacked next to main.js (see bundled.ts).
		if (s.browserControl && this.manifest.dir) args.push("-e", join(vault, this.manifest.dir, "pi-extension", "browser.ts"));
		if (s.obsidianControl && this.manifest.dir) args.push("-e", join(vault, this.manifest.dir, "pi-extension", "obsidian.ts"));

		// Naive split is enough for flags; quote-aware parsing isn't worth it here.
		args.push(...s.extraArgs.split(/\s+/).filter(Boolean));

		return { binary: s.piPath, args, cwd: vault, env };
	}

	private async vaultIsTrusted(env: NodeJS.ProcessEnv): Promise<boolean> {
		try {
			const trust = JSON.parse(await fs.readFile(join(env.PI_CODING_AGENT_DIR ?? "", "trust.json"), "utf8")) as Record<string, unknown>;
			return trust[resolve(this.vaultPath)] === true;
		} catch {
			return false;
		}
	}
}
