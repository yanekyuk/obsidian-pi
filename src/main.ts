import { FileSystemAdapter, Notice, Platform, Plugin, TFile, addIcon, type Editor } from "obsidian";
import { existsSync, promises as fs } from "fs";
import { homedir } from "os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "path";
import { readAdvisorConfig, writeAdvisorConfig } from "./advisor";
import { DEFAULT_INHERITANCE, HARNESS_AGENT_DIR, USER_AGENT_DIR, prepareAgentDir, sessionDirFor } from "./agentDir";
import { loadsAllSkills, readPackageEntries, sourceOf } from "./packages";
import { MCP_ADAPTER, Requirements, type InstalledPackage } from "./requirements";
import { BrowserControl } from "./browser";
import { ObsidianControl } from "./obsidianControl";
import { VaultSearch } from "./search/VaultSearch";
import { extractBundledFiles } from "./bundled";
import { StatusBar } from "./statusBar";
import { linkedSession, resolveLinked, sessionDirs } from "./noteLink";
import { resolveEnv } from "./env";
import { unusableMcpServers } from "./mcp";
import { readEnabledModels } from "./models";
import { sharedPiEnvironment } from "./piEnvironment";
import { buildSystemPrompt } from "./prompt";
import { PiRemoteClient } from "./remote/client";
import { PiRemoteServer, type RemoteSessionOverrides } from "./remote/server";
import { DEFAULT_SERVER_PORT, discoverServerUrls, generateServerToken } from "./remote/ws";
import type { PiSpawnOptions } from "./rpc/PiRpcClient";
import { listSessions, type SessionSummary } from "./sessions";
import { DEFAULT_SETTINGS, PiAgentSettingTab, type PiAgentSettings } from "./settings";
import type { ChatSession } from "./view/ChatSession";
import { ChatView, VIEW_TYPE_PI } from "./view/ChatView";
import { snapshotAfter, snapshotBefore, swapVersion, unchangedSince, type FileSnapshot } from "./view/revert";
import { panelsIn, type SavedTab } from "./view/savedTabs";

const MAX_SESSIONS_WITH_HIDDEN_TODOS = 30;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const { shell } = require("electron") as { shell: { trashItem(path: string): Promise<void>; openPath(path: string): Promise<string> } };
// Panels saved under the names this plugin had before, with the id of the plugin that may own each name now.
const LEGACY_PANELS = [
	{ viewType: "pi-agent-chat", plugin: "pi-agent" }, // before it was published
	{ viewType: "pi-harness-chat", plugin: "pi-harness" }, // up to 0.1.27, before the id changed
];
const PI_ICON = `<path d="M18 30h64M38 30v46M64 30v34c0 8 4 12 12 12" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;

export default class PiAgentPlugin extends Plugin {
	settings: PiAgentSettings = DEFAULT_SETTINGS;
	browser = new BrowserControl(this.app);
	vaultSearch = new VaultSearch(this.app);
	obsidian = new ObsidianControl(this.app, () => this.settings.commandAllowlist, this.vaultSearch);
	statusBar!: StatusBar;

	requirements = new Requirements({ piCommand: () => this.piCommand() });
	remoteClient = new PiRemoteClient(() => ({
		url: this.settings.remoteUrl,
		token: this.settings.remoteToken || this.settings.serverToken,
	}));
	remoteServer: PiRemoteServer | null = null;
	cachedAdvisorModel: string | undefined = undefined;

	get hasLocalFs(): boolean {
		return !Platform.isMobile && this.app.vault.adapter instanceof FileSystemAdapter;
	}

	get isRemote(): boolean {
		return !this.hasLocalFs;
	}

	get vaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
		return this.remoteClient.vaultPath || "/";
	}

	async onload(): Promise<void> {
		const loaded = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		const currentSettings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((key) => key in loaded).map((key) => [key, loaded[key]])) as Partial<PiAgentSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...currentSettings, inherit: { ...DEFAULT_INHERITANCE, ...currentSettings.inherit } };
		addIcon("pi", PI_ICON);
		if (this.hasLocalFs) {
			void resolveEnv(); // warm the shell PATH lookup before the first spawn
			// Before any chat starts pi, whose PATH includes the launcher.
			if (this.manifest.dir) await extractBundledFiles(join(this.vaultPath, this.manifest.dir)).catch((err) => console.warn("[pi-workbench] couldn't write the bundled launcher", err));
			this.cachedAdvisorModel = readAdvisorConfig().modelKey;
			await this.syncRemoteServer();
		} else if (this.remoteClient.configured) {
			void this.refreshAdvisorModel();
		}

		this.addChild(this.vaultSearch);
		this.registerView(VIEW_TYPE_PI, (leaf) => new ChatView(leaf, this));
		this.app.workspace.onLayoutReady(() => void this.adoptLegacyPanels());
		this.registerHoverLinkSource(VIEW_TYPE_PI, { display: "Pi Workbench", defaultMod: true });
		this.addSettingTab(new PiAgentSettingTab(this.app, this));
		this.addRibbonIcon("pi", "Open pi", () => void this.activateView());
		this.statusBar = new StatusBar(this, () => this.chatViews(), (tab) => void this.chatViews().find((view) => view.allTabs().includes(tab))?.revealTab(tab));

		// obsidian://pi-workbench?prompt=…  puts the words in the composer of a new tab; &send=1 sends
		// them; &note=Folder/Note opens pi for that note; &session=<file name> opens that session.
		this.registerObsidianProtocolHandler("pi-workbench", (params) => void this.handleUri(params));

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


	onunload(): void {
		void this.remoteServer?.stop();
		this.remoteServer = null;
	}

	async syncRemoteServer(): Promise<void> {
		if (!this.hasLocalFs) return;
		if (!this.settings.serverEnabled) {
			await this.remoteServer?.stop();
			this.remoteServer = null;
			return;
		}
		let settingsChanged = false;
		if (!this.settings.serverToken) {
			this.settings.serverToken = generateServerToken();
			settingsChanged = true;
		}
		if (!this.settings.remoteToken) {
			this.settings.remoteToken = this.settings.serverToken;
			settingsChanged = true;
		}
		const discovered = discoverServerUrls(this.settings.serverPort || DEFAULT_SERVER_PORT, this.settings.serverBindHost || "0.0.0.0");
		if (!this.settings.remoteUrl && discovered[0]) {
			this.settings.remoteUrl = discovered[0];
			settingsChanged = true;
		}
		if (settingsChanged) await this.saveSettings();
		if (!this.remoteServer) {
			this.remoteServer = new PiRemoteServer({
				vaultName: () => this.app.vault.getName(),
				vaultPath: () => this.vaultPath,
				panelSettingsFile: () => this.panelSettingsFile,
				sessionDirectories: () => this.sessionDirectories(),
				lastSessionFile: () => this.settings.lastSessionFile,
				heldSessionFiles: () => this.heldSessionFiles(),
				isSessionHeld: (file) => this.isSessionHeld(file),
				buildSpawnOptions: (file, overrides) => this.buildLocalSpawnOptions(file, overrides),
				piCommand: () => this.piCommand(),
				installedPackages: () => this.requirements.installed(),
				trashSession: (path) => shell.trashItem(path),
				swapVersion: (snap) => swapVersion(this.app, this.vaultPath, snap),
				onSessionsChanged: () => this.chatViews().forEach((v) => v.refreshSessions()),
			});
		}
		try {
			await this.remoteServer.start({
				port: this.settings.serverPort || DEFAULT_SERVER_PORT,
				bindHost: this.settings.serverBindHost || "0.0.0.0",
				token: this.settings.serverToken,
			});
		} catch (err) {
			new Notice(`Couldn't start the Pi Workbench mobile server: ${(err as Error).message}`);
		}
	}

	async refreshAdvisorModel(): Promise<string | undefined> {
		try {
			const cfg = this.isRemote ? await this.remoteClient.readAdvisorConfig() : readAdvisorConfig();
			this.cachedAdvisorModel = cfg.modelKey;
		} catch {
			// Ignore when disconnected
		}
		return this.cachedAdvisorModel;
	}

	async setAdvisorModel(modelKey: string | null, effort: string | null): Promise<void> {
		if (this.isRemote) await this.remoteClient.writeAdvisorConfig(modelKey, effort);
		else writeAdvisorConfig(modelKey, effort);
		this.cachedAdvisorModel = modelKey ?? undefined;
	}

	async readEnabledModelPatterns(): Promise<string[]> {
		if (this.isRemote) return this.remoteClient.readEnabledModels().catch(() => []);
		return readEnabledModels(this.panelSettingsFile);
	}

	async installedPackages(): Promise<InstalledPackage[]> {
		if (this.isRemote) return this.remoteClient.installedPackages();
		return this.requirements.installed();
	}

	async unusableMcp(): Promise<{ name: string; url: string; reason: string }[]> {
		if (this.isRemote) return this.remoteClient.unusableMcpServers().catch(() => []);
		return unusableMcpServers(this.vaultPath);
	}

	async loadSessionList(): Promise<{ sessions: SessionSummary[]; openElsewhere: Set<string> }> {
		if (this.isRemote) {
			const res = await this.remoteClient.listSessions();
			return { sessions: res.sessions, openElsewhere: new Set(res.heldSessionFiles) };
		}
		return { sessions: await listSessions(this.sessionDirectories()), openElsewhere: new Set() };
	}

	canRestoreTab(sessionFile: string, except?: ChatSession): boolean {
		if (!sessionFile || this.isSessionHeld(sessionFile, except)) return false;
		return this.isRemote ? true : existsSync(sessionFile);
	}

	async sessionExists(path: string): Promise<boolean> {
		if (!path) return false;
		return this.isRemote ? this.remoteClient.sessionExists(path) : existsSync(path);
	}

	async resolveLinkedSession(value: string): Promise<string | null> {
		if (!value) return null;
		return this.isRemote ? this.remoteClient.resolveLinked(value) : resolveLinked(value, this.sessionDirectories());
	}

	async trashSessionFile(path: string): Promise<void> {
		if (this.isRemote) await this.remoteClient.trashSession(path);
		else await shell.trashItem(path);
	}

	remoteBtwUrl(): string | null {
		return this.isRemote ? this.remoteClient.wsUrl("/btw") : null;
	}

	async readImageBytes(rawPath: string): Promise<Uint8Array> {
		const abs = resolve(this.vaultPath, rawPath.replace(/^~(?=$|\/)/, homedir() || "/"));
		const rel = abs.startsWith(`${this.vaultPath}/`) ? abs.slice(this.vaultPath.length + 1) : rawPath;
		const vaultFile = this.app.vault.getAbstractFileByPath(rel);
		if (vaultFile instanceof TFile) {
			const buf = await this.app.vault.readBinary(vaultFile);
			if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("the file is too large to preview");
			return new Uint8Array(buf);
		}
		if (this.isRemote) return this.remoteClient.readImage(rawPath);
		if ((await fs.stat(abs)).size > MAX_IMAGE_BYTES) throw new Error("the file is too large to preview");
		return await fs.readFile(abs);
	}

	async openExternalFile(file: string): Promise<string | null> {
		if (this.isRemote) return "External files on the server cannot be opened on this device.";
		if (!existsSync(file)) return "it is no longer there";
		return (await shell.openPath(file)) || null;
	}

	snapshotBeforeEdit(absPath: string): Promise<FileSnapshot | undefined> {
		if (this.isRemote) return this.remoteClient.snapshotBefore(absPath).catch(() => undefined);
		return Promise.resolve(snapshotBefore(absPath));
	}

	snapshotAfterEdit(snapshot: FileSnapshot, toolName: string, args: Record<string, unknown>): Promise<FileSnapshot | undefined> {
		if (this.isRemote) return this.remoteClient.snapshotAfter(snapshot, toolName, args).catch(() => undefined);
		return Promise.resolve(snapshotAfter(snapshot, toolName, args));
	}

	isSnapshotUnchanged(snapshot: FileSnapshot): Promise<boolean> {
		if (this.isRemote) return this.remoteClient.unchangedSince(snapshot).catch(() => false);
		return Promise.resolve(unchangedSince(snapshot));
	}

	async swapSnapshotVersion(snapshot: FileSnapshot): Promise<FileSnapshot> {
		if (this.isRemote) return this.remoteClient.swapVersion(snapshot);
		return swapVersion(this.app, this.vaultPath, snapshot);
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

	// The plugin was called Pi Agent before it was published, and its id was pi-harness up to
	// 0.1.27. Its panels are still in the workspace layout under those view types, as dead panes
	// holding their open tabs. Their tabs move to a live panel and the dead pane is closed.
	//
	// The layout file is read from disk: what a pane whose plugin is gone reports about itself at
	// run time is Obsidian's business and has proved unreliable, while the file says plainly what
	// was saved. Another plugin may now own an old name, so a pane is only touched while that
	// plugin isn't running and the state in it is plainly ours. Each pane is adopted once, so a tab the
	// user closes afterwards stays closed even if the dead pane could not be removed.
	private async adoptLegacyPanels(): Promise<void> {
		const names = LEGACY_PANELS.filter((legacy) => !this.isPluginRunning(legacy.plugin));
		if (names.length === 0) return;
		try {
			const layout: unknown = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/workspace.json`));
			const found = names.flatMap((legacy) => panelsIn(layout, legacy.viewType));

			for (const { id, tabs } of found) {
				if (!this.settings.adoptedLegacyPanels.includes(id)) {
					this.settings.adoptedLegacyPanels = [...this.settings.adoptedLegacyPanels, id];
					await this.saveSettings();
					const live = this.chatViews()[0];
					if (live) live.adoptTabs(tabs);
					else this.pendingTabs.push(...tabs); // for the first panel that opens
					console.debug(`[pi-workbench] adopted ${tabs.length} tabs from the old panel ${id}${live ? "" : " (waiting for a panel)"}`);
				}
				this.app.workspace.getLeafById(id)?.detach();
			}
		} catch (err) {
			console.warn("[pi-workbench] couldn't look for panels from before the rename", err);
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

	// The environment every pi process the plugin starts uses: chats, side questions, and package inspection.
	private async piEnv(): Promise<NodeJS.ProcessEnv> {
		const env = sharedPiEnvironment(await resolveEnv());
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
			const tab = view.tabFor(sessionFile, except);
			if (tab) return { view, tab };
		}
		return null;
	}

	isSessionHeld(sessionFile: string, except?: ChatSession): boolean {
		return Boolean(this.holderOf(sessionFile, except) || this.remoteServer?.isSessionHeld(sessionFile));
	}

	heldSessionFiles(except?: ChatSession | null): string[] {
		return [
			...this.chatViews().flatMap((view) => view.heldSessionFiles(except)),
			...(this.remoteServer?.heldSessionFiles() ?? []),
		];
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
			const path = await this.resolveLinkedSession(params.session);
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

	// Both profiles can hold this vault's history after a setting change. Keep directories
	// of already-known sessions too, without guessing that other vaults are this one.
	sessionDirectories(): string[] {
		const vault = this.vaultPath;
		return [...new Set([
			...sessionDirs(this.sessionDir(), this.settings.lastSessionFile),
			sessionDirFor(vault),
			sessionDirFor(vault, HARNESS_AGENT_DIR),
			...this.heldSessionFiles().map(dirname),
		])];
	}

	// The note's own session when it has one here; otherwise a new tab that becomes its session.
	async openForNote(file: TFile): Promise<void> {
		const view = await this.activateView();
		if (!view) return;
		const linked = linkedSession(this.app, file);
		const path = linked ? await this.resolveLinkedSession(linked).catch(() => null) : null;
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
		if (this.isRemote) {
			const s = this.settings;
			return this.remoteClient.buildSpawnOptions(sessionFile, {
				model: s.model,
				systemPromptAddendum: s.systemPromptAddendum,
				extraArgs: s.extraArgs,
				browserControl: s.browserControl && this.hasLocalFs,
				obsidianControl: s.obsidianControl,
				trimToolOutput: s.trimToolOutput,
			});
		}
		return this.buildLocalSpawnOptions(sessionFile);
	}

	private async buildLocalSpawnOptions(sessionFile: string | null, overrides?: RemoteSessionOverrides): Promise<PiSpawnOptions> {
		if (!overrides && sessionFile) await this.remoteServer?.reclaimDetachedSession(sessionFile);
		const s = this.settings;
		const vault = this.vaultPath;
		const addendum = overrides?.systemPromptAddendum ?? s.systemPromptAddendum;
		const model = overrides?.model ?? s.model;
		const extraArgs = overrides?.extraArgs ?? s.extraArgs;
		const browserControl = overrides?.browserControl ?? s.browserControl;
		const obsidianControl = overrides?.obsidianControl ?? s.obsidianControl;
		const trimToolOutput = overrides?.trimToolOutput ?? s.trimToolOutput;

		const args: string[] = ["--append-system-prompt", buildSystemPrompt(this.app.vault.getName(), addendum)];

		if (model) args.push("--model", model);
		if (sessionFile) args.push("--session", sessionFile);

		const env = await this.piEnv();
		const skillDirs = s.extraSkillPaths
			.split("\n")
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => (isAbsolute(p) ? p : join(vault, p)));
		// Keep panel-only overrides out of shell commands that can launch other apps.
		if (this.manifest.dir) args.push("-e", join(vault, this.manifest.dir, "pi-extension", "panel-shell.ts"));
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
		if (browserControl && this.manifest.dir) args.push("-e", join(vault, this.manifest.dir, "pi-extension", "browser.ts"));
		if (obsidianControl && this.manifest.dir) args.push("-e", join(vault, this.manifest.dir, "pi-extension", "obsidian.ts"));
		if (trimToolOutput && this.manifest.dir) args.push("-e", join(vault, this.manifest.dir, "pi-extension", "trim-tool-output.ts"));

		// Naive split is enough for flags; quote-aware parsing isn't worth it here.
		args.push(...extraArgs.split(/\s+/).filter(Boolean));

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
