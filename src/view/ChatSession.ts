import { Component, Keymap, Menu, Notice, TFile, setIcon, type App, type ItemView } from "obsidian";
import { existsSync } from "fs";
import { homedir } from "os";
import { basename, relative, resolve } from "path";
import { readAdvisorConfig, writeAdvisorConfig } from "../advisor";
import { BROWSER_CHANNEL } from "../browser";
import type PiAgentPlugin from "../main";
import { probeMcp, unusableMcpServers, vaultMcpServers } from "../mcp";
import { readActiveContext, splitContext, withContext } from "../prompt";
import { OBSIDIAN_SKILLS, SKILLS_PACKAGE } from "../requirements";
import { PiRpcClient } from "../rpc/PiRpcClient";
import type { AgentMessage, AssistantMessageEvent, ExtensionUiRequest, ImageContent, RpcEvent, SessionState, SlashCommand, ToolCallContent } from "../rpc/types";
import { contentText } from "../sessions";
import { AttachmentTray, imageFilesOf, imageSrc } from "./Attachments";
import { MarkdownBlock, ThinkingBlock, ToolCard, type RenderHost } from "./blocks";
import { ComposerSuggest } from "./ComposerSuggest";
import { InlineDialogs } from "./InlineDialogs";
import { readEnabledModels, scopeModels } from "../models";
import { renderInline } from "./markdown";
import { ModelPicker, pickOne, promptText } from "./modals";
import { SideQuestions } from "./SideQuestion";
import { TodoPanel, tasksFrom } from "./TodoPanel";

const STICK_TO_BOTTOM_PX = 48;
const MCP_RECHECK_MS = 30_000;

// pi's built-in slash commands exist only in its terminal UI and are not sent over RPC
// (get_commands leaves them out), so the ones worth having are provided here.
const PANEL_COMMANDS: SlashCommand[] = [
	{ name: "compact", description: "Summarize the conversation to free up context. Optional: what to focus on.", source: "panel" },
	{ name: "reload", description: "Reload extensions, skills, prompt templates, context files and settings. The conversation stays.", source: "panel" },
];

// Output this long, or on several lines, is something to read: it goes in the transcript.
const TOAST_MAX_CHARS = 100;

const compactTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Extension status and widget text is written for a terminal.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");

// Electron is external to the bundle and has no types here. openPath resolves to an error message, or "".
const { shell } = require("electron") as { shell: { openPath(path: string): Promise<string> } };

type Block = MarkdownBlock | ThinkingBlock | ToolCard;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

// A message sent while pi was compacting. pi refuses prompts then (its terminal UI holds them
// back the same way), so the tab keeps them and sends them on once compaction ends.
interface HeldMessage {
	text: string;
	message: string;
	images: ImageContent[];
	mode: "steer" | "followUp";
}

interface LiveAssistant {
	el: HTMLElement;
	blocks: Map<number, Block>;
}

// What a tab is up to, as the switcher shows it. "unloaded" is a tab brought back from the
// workspace layout whose pi hasn't been started yet; "unread" finished while out of sight.
export type TabStatus = "unloaded" | "idle" | "working" | "asking" | "unread" | "error";

// The chat panel, as far as one of its tabs is concerned.
export interface SessionHost {
	app: App;
	plugin: PiAgentPlugin;
	view: ItemView;
	viewType: string;
	// Whether this tab is the one on screen.
	isShowing(session: ChatSession): boolean;
	// Its title, status or detail changed.
	changed(session: ChatSession): void;
	reveal(session: ChatSession): void;
	// Session files were created, renamed or swapped.
	sessionsChanged(): void;
	closeDrawer(): void;
}

// One tab of the chat panel: a conversation with its own pi process, transcript and composer.
// Tabs that aren't on screen keep running; the panel shows one at a time.
export class ChatSession {
	readonly el: HTMLElement;
	private client = new PiRpcClient();
	// Owns the rendered markdown, so closing the tab lets go of it.
	private component = new Component();
	private renderHost: RenderHost;
	private state: SessionState | null = null;
	private busy = false;
	private started = false;
	private startup: Promise<void> | null = null;
	private connecting = false;
	private compacting = false;
	private failed = false;
	private unread = false;
	private stickToBottom = true;
	private scrollTop = 0;
	private shareNote: boolean;

	// The session this tab should hold. Comes from the saved workspace layout before
	// pi starts, and tracks pi's actual session file afterwards.
	private sessionFile: string | null;
	private savedTitle: string;
	private firstPrompt = "";

	private live: LiveAssistant | null = null;
	private toolCards = new Map<string, ToolCard>();
	private widgets = new Map<string, { lines: string[]; below: boolean }>();
	private held: HeldMessage[] = [];
	private flushing = false;
	private piQueue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };

	private messagesEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private queueEl!: HTMLElement;
	private widgetsAboveEl!: HTMLElement;
	private widgetsBelowEl!: HTMLElement;
	private activityEl!: HTMLElement;
	private mcpWarningEl!: HTMLElement;
	private offerEl!: HTMLElement;
	private mcpCheckedAt = 0;
	// Server names whose "reconnected" notice is ours to swallow, because the panel asked for it.
	private quietReconnects = new Set<string>();
	private noteChipEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private modelBtn!: HTMLElement;
	private thinkingBtn!: HTMLElement;
	private statsEl!: HTMLElement;
	private compactBtn!: HTMLElement;
	private stopBtn!: HTMLElement;
	private queueBtn!: HTMLElement;
	private sendBtn!: HTMLElement;
	private suggest!: ComposerSuggest;
	private attachments!: AttachmentTray;
	private dialogs!: InlineDialogs;
	private todos!: TodoPanel;
	private side!: SideQuestions;

	constructor(
		parent: HTMLElement,
		private host: SessionHost,
		initial: { sessionFile: string | null; title?: string },
	) {
		this.sessionFile = initial.sessionFile;
		this.savedTitle = initial.title ?? "";
		this.shareNote = host.plugin.settings.includeActiveNote;
		this.el = parent.createDiv({ cls: "pi-tab" });
		this.el.hide();
		host.view.addChild(this.component);
		this.renderHost = { app: host.app, component: this.component, onContentChanged: () => this.keepScrolled() };
		this.client.onEvent((e) => this.handleEvent(e));
		this.client.onExit((info) => this.handleExit(info));
		this.buildDom();
		// Looking at a tab is what makes it read.
		for (const type of ["pointerdown", "focusin"]) this.el.addEventListener(type, () => this.markRead());
	}

	private get app(): App {
		return this.host.app;
	}

	private get plugin(): PiAgentPlugin {
		return this.host.plugin;
	}

	get heldSessionFile(): string | null {
		return this.state?.sessionFile ?? this.sessionFile;
	}

	get title(): string {
		return this.state?.sessionName || this.firstPrompt || this.savedTitle || "New session";
	}

	get isRunning(): boolean {
		return this.client.running;
	}

	get isBusy(): boolean {
		return this.busy || this.compacting;
	}

	// Whether another session may take this tab's place without cutting anything short.
	get replaceable(): boolean {
		return !this.isBusy && !this.connecting && this.dialogs.pending === 0;
	}

	// A session nobody has said anything in: not worth keeping a second one of.
	get isEmpty(): boolean {
		return this.started && !this.failed && this.replaceable && !this.messagesEl.querySelector(".pi-msg") && !this.inputEl.value.trim();
	}

	get status(): TabStatus {
		if (!this.started) return "unloaded";
		if (this.failed) return "error";
		if (this.dialogs.pending > 0) return "asking";
		if (this.isBusy || this.connecting) return "working";
		return this.unread ? "unread" : "idle";
	}

	// One line on what the status means right now.
	get detail(): string {
		switch (this.status) {
			case "unloaded":
				return "Not loaded yet";
			case "error":
				return "pi stopped";
			case "asking":
				return "Waiting for your answer";
			case "working":
				return this.todos.summary ?? (this.activityEl.textContent || "Working…");
			case "unread":
				return "Finished";
			default:
				return "";
		}
	}

	show(): void {
		this.el.show();
		this.unread = false;
		this.renderNoteChip();
		// A hidden element measures as nothing, so whatever changed meanwhile is sized now.
		this.autoGrow();
		this.messagesEl.scrollTop = this.stickToBottom ? this.messagesEl.scrollHeight : this.scrollTop;
		if (!this.started) this.startup = this.connect();
		this.host.changed(this);
	}

	// Resolves once a tab that was just put on screen has its pi up (or has failed to get it up).
	async whenReady(): Promise<void> {
		await this.startup;
	}

	hide(): void {
		this.scrollTop = this.messagesEl.scrollTop;
		this.el.hide();
	}

	private markRead(): void {
		if (!this.unread) return;
		this.unread = false;
		this.host.changed(this);
	}

	// Stops pi and takes the tab off the screen for good.
	async dispose(): Promise<void> {
		this.side.dismiss();
		this.dialogs.drop();
		this.el.remove();
		this.host.view.removeChild(this.component);
		await this.client.stop();
	}

	// ---------------------------------------------------------------- DOM

	private buildDom(): void {
		const root = this.el;

		this.bannerEl = root.createDiv({ cls: "pi-banner" });
		this.bannerEl.hide();

		this.messagesEl = root.createDiv({ cls: "pi-messages" });
		this.messagesEl.addEventListener("scroll", () => {
			if (!this.el.isShown()) return;
			const { scrollHeight, scrollTop, clientHeight } = this.messagesEl;
			this.stickToBottom = scrollHeight - scrollTop - clientHeight < STICK_TO_BOTTOM_PX;
		});
		this.registerLinkHandlers();

		const dock = root.createDiv({ cls: "pi-dock" });
		this.mcpWarningEl = dock.createDiv({ cls: "pi-warning", attr: { "aria-label": "Click to check again" } });
		this.mcpWarningEl.hide();
		this.mcpWarningEl.addEventListener("click", () => void this.checkMcp(true));
		this.offerEl = dock.createDiv({ cls: "pi-offer" });
		// Same shape as a "Thinking…" line in the transcript above it: an icon, then the words.
		const activity = dock.createDiv({ cls: "pi-activity" });
		setIcon(activity.createSpan({ cls: "pi-icon" }), "loader");
		this.activityEl = activity.createSpan({ cls: "pi-activity-text" });
		this.todos = new TodoPanel(dock, this.renderHost, (hidden) => void this.plugin.setHiddenTodos(this.heldSessionFile, hidden));
		this.queueEl = dock.createDiv({ cls: "pi-queue" });
		this.widgetsAboveEl = dock.createDiv({ cls: "pi-widgets" });
		this.side = new SideQuestions(dock, this.renderHost, {
			piCommand: () => this.plugin.piCommand(),
			sessionFile: () => this.heldSessionFile,
			model: () => this.state?.model ?? null,
			thinkingLevel: () => (this.state?.model?.reasoning ? (this.state.thinkingLevel ?? null) : null),
		});
		this.dialogs = new InlineDialogs(
			dock,
			this.renderHost,
			(id, answer) => {
				if (this.client.running) this.client.respondToUi(id, answer);
			},
			() => this.el.contains(this.el.ownerDocument.activeElement),
			() => this.host.changed(this),
		);

		const composer = dock.createDiv({ cls: "pi-composer" });
		this.noteChipEl = composer.createDiv({ cls: "pi-note-chip" });
		this.noteChipEl.addEventListener("click", () => {
			this.shareNote = !this.shareNote;
			this.renderNoteChip();
		});

		this.attachments = new AttachmentTray(composer, () => this.renderComposerMode());
		this.inputEl = composer.createEl("textarea", { cls: "pi-input", attr: { rows: "1", placeholder: "Ask pi…  / for commands, @ for notes" } });
		this.suggest = new ComposerSuggest(this.app, this.inputEl, composer);
		this.inputEl.addEventListener("input", () => this.autoGrow());
		this.inputEl.addEventListener("keydown", (evt) => this.onInputKey(evt));
		this.inputEl.addEventListener("paste", (evt) => {
			const files = imageFilesOf(evt.clipboardData);
			if (!files.length) return; // plain text pastes as usual
			evt.preventDefault();
			void this.attach(files);
		});
		composer.addEventListener("dragover", (evt) => {
			if (!evt.dataTransfer?.types.includes("Files")) return;
			evt.preventDefault();
			composer.addClass("is-drop-target");
		});
		composer.addEventListener("dragleave", () => composer.removeClass("is-drop-target"));
		composer.addEventListener("drop", (evt) => {
			composer.removeClass("is-drop-target");
			const files = imageFilesOf(evt.dataTransfer);
			if (!files.length) return;
			evt.preventDefault();
			void this.attach(files);
		});

		const bar = composer.createDiv({ cls: "pi-composer-bar" });
		this.modelBtn = bar.createEl("button", { cls: "pi-pill clickable-icon", attr: { "aria-label": "Switch model" } });
		this.modelBtn.addEventListener("click", () => void this.pickModel());
		this.thinkingBtn = bar.createEl("button", { cls: "pi-pill clickable-icon", attr: { "aria-label": "Thinking level" } });
		this.thinkingBtn.addEventListener("click", (evt) => void this.pickThinking(evt));
		this.statsEl = bar.createSpan({ cls: "pi-stats" });
		this.compactBtn = bar.createEl("button", { cls: "pi-compact clickable-icon", attr: { "aria-label": "Compact context (/compact)" } });
		setIcon(this.compactBtn, "fold-vertical");
		this.compactBtn.addEventListener("click", () => void this.compact());
		this.compactBtn.hide();

		this.queueBtn = bar.createEl("button", { cls: "pi-queue-btn clickable-icon", attr: { "aria-label": "Queue for when pi has finished (Alt+Enter)" } });
		setIcon(this.queueBtn, "list-end");
		this.queueBtn.addEventListener("click", () => void this.send("followUp"));
		this.queueBtn.hide();
		this.stopBtn = bar.createEl("button", { cls: "pi-stop", attr: { "aria-label": "Stop (Esc)" } });
		setIcon(this.stopBtn, "square");
		this.stopBtn.addEventListener("click", () => void this.stop());
		this.stopBtn.hide();
		this.sendBtn = bar.createEl("button", { cls: "pi-send mod-cta" });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.addEventListener("click", () => void this.send());

		this.widgetsBelowEl = dock.createDiv({ cls: "pi-widgets" });
		this.renderNoteChip();
		this.renderControls();
		this.renderComposerMode();
	}

	// Rendered markdown in a custom view doesn't navigate on its own. Covers the whole tab:
	// questions, tasks and side answers can hold links too.
	private registerLinkHandlers(): void {
		const linkOf = (evt: MouseEvent) => (evt.target as HTMLElement).closest<HTMLElement>("a.internal-link");
		this.el.addEventListener("click", (evt) => {
			const link = linkOf(evt);
			const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
			if (!href) return;
			evt.preventDefault();
			void this.app.workspace.openLinkText(href, "", Keymap.isModEvent(evt));
		});
		this.el.addEventListener("mouseover", (evt) => {
			const link = linkOf(evt);
			const linktext = link?.getAttribute("data-href");
			if (!link || !linktext) return;
			this.app.workspace.trigger("hover-link", { event: evt, source: this.host.viewType, hoverParent: this.host.view, targetEl: link, linktext, sourcePath: "" });
		});
	}

	renderNoteChip(): void {
		const file = this.app.workspace.getActiveFile();
		this.noteChipEl.empty();
		this.noteChipEl.toggle(file !== null);
		if (!file) return;
		this.noteChipEl.toggleClass("is-off", !this.shareNote);
		this.noteChipEl.setAttr("aria-label", this.shareNote ? "Shared with pi, along with your selection. Click to stop sharing." : "Not shared with pi. Click to share.");
		setIcon(this.noteChipEl.createSpan({ cls: "pi-icon" }), this.shareNote ? "file-text" : "file-x");
		this.noteChipEl.createSpan({ text: file.basename });
	}

	private renderControls(): void {
		const model = this.state?.model;
		this.modelBtn.setText(model ? model.name || model.id : "No model");
		this.thinkingBtn.setText(this.state?.thinkingLevel ?? "");
		this.thinkingBtn.toggle(Boolean(model?.reasoning));
		this.host.changed(this);
	}

	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.stopBtn.toggle(busy);
		this.el.toggleClass("is-busy", busy);
		this.renderComposerMode();
		if (!busy) this.setActivity(null);
		else this.host.changed(this);
	}

	private setActivity(text: string | null): void {
		this.activityEl.setText(text ?? "");
		this.activityEl.parentElement?.toggleClass("is-active", Boolean(text));
		this.host.changed(this);
	}

	// What Enter will do right now, said where the user is looking: on the buttons and in the box.
	private renderComposerMode(): void {
		if (!this.sendBtn) return;
		const waiting = this.busy || this.compacting;
		const hasDraft = this.inputEl.value.trim() !== "" || this.attachments.count > 0;
		// One round button at rest. While pi works it is Stop, and once there is something
		// to send, Send comes back beside it along with the choice to queue instead.
		this.queueBtn.toggle(waiting && hasDraft);
		this.sendBtn.toggle(!this.busy || hasDraft);
		this.sendBtn.setAttr("aria-label", this.compacting ? "Send once compaction is done (Enter)" : this.busy ? "Steer: pi reads it before its next step (Enter)" : "Send (Enter)");
		this.inputEl.placeholder = this.compacting
			? "Compacting… what you send now goes out when it's done"
			: this.busy
				? "Steer pi…  Alt+Enter queues it for when pi has finished"
				: "Ask pi…  / for commands, @ for notes";
	}

	private setCompacting(compacting: boolean): void {
		this.compacting = compacting;
		this.el.toggleClass("is-compacting", compacting);
		this.renderComposerMode();
		this.host.changed(this);
	}

	// pi's MCP adapter is lazy: a fresh pi knows of the vault's servers but has not connected,
	// so /mcp reads "disconnected (0 tools)" until something uses one. In Obsidian the vault's
	// own server is the point, so connect the ones that are up as soon as pi has started.
	private async connectMcp(): Promise<void> {
		if (!this.plugin.settings.connectMcpOnStart || !this.suggest.commands.some((c) => c.name === "mcp")) return;
		for (const server of await vaultMcpServers(this.plugin.vaultPath)) {
			// A name with a space can't be passed to the command; a server that is down gets the warning instead.
			if (/\s/.test(server.name) || (await probeMcp(server.url)) !== null || !this.client.running) continue;
			this.quietReconnects.add(server.name);
			await this.client.prompt(`/mcp reconnect ${server.name}`).catch(() => this.quietReconnects.delete(server.name));
		}
	}

	private get hasObsidianSkills(): boolean {
		return this.suggest.commands.some((c) => c.source === "skill" && OBSIDIAN_SKILLS.includes(c.name.replace(/^skill:/, "")));
	}

	// The Obsidian skills come from their author's repository, through pi. Whether they are
	// needed shows only now that pi has listed its skills: ones in the vault's .pi/skills count.
	private async ensureSkills(): Promise<void> {
		if (this.hasObsidianSkills || !this.plugin.settings.manageExtensions) return;
		// Installed but not loaded means the user switched the package off; that is not "missing".
		const installed = await this.plugin.requirements.installed().catch(() => []);
		if (installed.some((pkg) => basename(pkg.path) === SKILLS_PACKAGE.name)) return;
		const installedNow = await this.plugin.requirements.installSkills((status) => this.setActivity(status));
		this.setActivity(this.busy ? "Working…" : null);
		// One reload, by whichever tab got here first while pi was at rest; the others pick them up on their next start.
		if (installedNow && !this.hasObsidianSkills && this.replaceable && this.client.running) await this.restart();
	}

	// Installing extensions means downloading code from npm and running it inside pi, so it is
	// the user's call. Asked once, in the tab on screen; the settings tab has the same switches.
	private async offerExtensions(): Promise<void> {
		const { settings } = this.plugin;
		if (settings.manageExtensions || settings.extensionsOfferAnswered || !this.host.isShowing(this)) return;
		const missing = [...(await this.plugin.requirements.status().catch(() => new Map<string, null>()))].filter(([, pkg]) => pkg === null).map(([name]) => name);
		if (!this.hasObsidianSkills) missing.push(`${SKILLS_PACKAGE.name} (Steph Ango's skills for notes, Bases and Canvas, from ${SKILLS_PACKAGE.source.replace("git:", "")})`);
		if (!missing.length || settings.extensionsOfferAnswered) return;

		this.offerEl.empty();
		const card = this.offerEl.createDiv({ cls: "pi-side-card" });
		const head = card.createDiv({ cls: "pi-dialog-head" });
		setIcon(head.createSpan({ cls: "pi-icon" }), "package");
		head.createSpan({ cls: "pi-dialog-header", text: "Extensions" });
		card.createDiv({
			text: `The panel is built around a few pi extensions and skills (task list, questions, web tools, Obsidian know-how), and ${missing.length === 1 ? "one is" : `${missing.length} are`} not installed: ${missing.join(", ")}. Installing runs "pi install", which downloads them from npm and GitHub into pi's own package folder, where a pi in your terminal uses them too. pi works without them, with fewer features.`,
		});
		const update = card.createEl("label", { cls: "pi-offer-check" });
		const updateBox = update.createEl("input", { type: "checkbox" });
		update.createSpan({ text: "Also keep pi and its packages up to date (runs \"pi update --all\" once a day)" });
		const actions = card.createDiv({ cls: "pi-dialog-actions" });
		const answer = async (install: boolean) => {
			settings.extensionsOfferAnswered = true;
			settings.manageExtensions = install;
			if (install) settings.autoUpdate = updateBox.checked;
			await this.plugin.saveSettings();
			this.offerEl.empty();
			if (install) await this.reload();
		};
		actions.createEl("button", { text: "Install", cls: "mod-cta" }).addEventListener("click", () => void answer(true));
		actions.createEl("button", { text: "Not now" }).addEventListener("click", () => void answer(false));
		this.keepScrolled();
	}

	// pi's MCP adapter connects lazily and reports "enabled" either way, so ask the servers themselves.
	private async checkMcp(force = false): Promise<void> {
		if (!force && Date.now() - this.mcpCheckedAt < MCP_RECHECK_MS) return;
		this.mcpCheckedAt = Date.now();
		const down = await unusableMcpServers(this.plugin.vaultPath);
		this.mcpWarningEl.empty();
		this.mcpWarningEl.toggle(down.length > 0);
		if (!down.length) return;
		setIcon(this.mcpWarningEl.createSpan({ cls: "pi-icon" }), "alert-triangle");
		const lines = down.map((s) => `MCP server "${s.name}" is unavailable: ${s.reason} (${s.url.replace(/^https?:\/\//, "")}).`);
		const hint = down.some((s) => s.name === "obsidian") && !this.plugin.isPluginEnabled("vault-as-mcp") ? " Enable the Vault as MCP plugin." : "";
		this.mcpWarningEl.createSpan({ text: `${lines.join(" ")} pi can't use it until it is back.${hint}` });
	}

	private showBanner(title: string, detail: string, action?: { label: string; run: () => void }): void {
		this.bannerEl.empty();
		this.bannerEl.createDiv({ cls: "pi-banner-title", text: title });
		if (detail) this.bannerEl.createEl("pre", { cls: "pi-banner-detail", text: detail });
		if (action) this.bannerEl.createEl("button", { text: action.label }).addEventListener("click", action.run);
		this.bannerEl.show();
	}

	private keepScrolled(): void {
		if (this.stickToBottom) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	// Runs after every change to the draft, typed or not, so the buttons follow along too.
	private autoGrow(): void {
		this.inputEl.setCssStyles({ height: "auto" });
		this.inputEl.setCssStyles({ height: `${this.inputEl.scrollHeight}px` });
		this.renderComposerMode();
	}

	// ---------------------------------------------------------------- lifecycle

	// `session` is an explicit choice by the user; without it the tab resumes its own.
	private async connect(session?: string): Promise<void> {
		this.started = true;
		this.connecting = true;
		this.failed = false;
		this.bannerEl.hide();
		this.setActivity("Starting pi…");
		try {
			await this.plugin.requirements.ensure((status) => this.setActivity(status));
			this.setActivity("Starting pi…");
			await this.client.start(await this.plugin.buildSpawnOptions(session ?? this.resumeTarget()));
			await this.syncSession();
			const fromPi = await this.client.getCommands();
			this.suggest.commands = [...PANEL_COMMANDS.filter((c) => !fromPi.some((p) => p.name === c.name)), ...fromPi];
			this.renderEmptyState();
			void this.checkMcp(true);
			void this.connectMcp();
			void this.offerExtensions();
			void this.ensureSkills();
		} catch (err) {
			const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
			this.failed = true;
			this.showBanner(
				missing ? `Couldn't find "${this.plugin.settings.piPath}"` : "pi failed to start",
				missing ? "Install pi, or set its full path in Settings → Pi Harness." : String((err as Error).message ?? err),
				{ label: "Retry", run: () => void this.restart() },
			);
		} finally {
			this.connecting = false;
			this.setActivity(null);
		}
	}

	private handleExit(info: { code: number | null; stderr: string; expected: boolean }): void {
		this.failed = !info.expected;
		this.piQueue = { steering: [], followUp: [] };
		void this.unqueue();
		this.setBusy(false);
		this.setCompacting(false);
		this.dialogs.drop();
		if (info.expected) return;
		this.showBanner(`pi exited${info.code === null ? "" : ` with code ${info.code}`}`, info.stderr.split("\n").slice(-12).join("\n"), {
			label: "Restart",
			run: () => void this.restart(),
		});
	}

	// Which session file to start pi on, or null for a fresh session.
	private resumeTarget(): string | null {
		// A tab resumes its own session or nothing: if that file is gone (pi only writes a
		// session once it has messages), it must not grab another tab's.
		const candidate = this.heldSessionFile;
		const usable = candidate && existsSync(candidate) && !this.plugin.holderOf(candidate, this) ? candidate : null;
		// Claim it synchronously, so a second tab starting at the same moment sees it as taken.
		this.sessionFile = usable;
		return usable;
	}

	// pi's own /reload lives in its terminal UI and RPC has no command for it. Starting pi again
	// on the same session picks up everything /reload does (extensions, skills, prompt templates,
	// context files) and settings.json too.
	async reload(): Promise<void> {
		if (this.connecting) return;
		if (!this.replaceable) {
			new Notice(this.isBusy ? "pi is still working. Reload once it has finished, or stop it first." : "pi is waiting for your answer. Reload once you have answered.");
			return;
		}
		await this.restart();
		if (!this.failed) this.renderNotice("pi reloaded");
	}

	async restart(session?: string): Promise<void> {
		await this.client.stop();
		await this.connect(session);
	}

	// Pull pi's session into the view: state, controls and the full transcript.
	private async syncSession(): Promise<void> {
		this.state = await this.client.getState();
		this.sessionFile = this.state.sessionFile ?? null;
		if (this.state.sessionFile && this.state.sessionFile !== this.plugin.settings.lastSessionFile) {
			this.plugin.settings.lastSessionFile = this.state.sessionFile;
			await this.plugin.saveSettings();
		}
		this.todos.setHidden(this.plugin.hiddenTodosFor(this.sessionFile));
		this.firstPrompt = "";
		this.savedTitle = "";
		this.setBusy(this.state.isStreaming);
		this.renderTranscript(await this.client.getMessages());
		this.renderControls();
		void this.refreshStats();
		this.host.sessionsChanged();
	}

	private async refreshStats(): Promise<void> {
		if (!this.client.running) return;
		try {
			const stats = await this.client.getSessionStats();
			const percent = stats.contextUsage?.percent;
			const parts = [percent == null ? null : `${Math.round(percent)}% context`, stats.cost > 0 ? `$${stats.cost.toFixed(2)}` : null];
			this.statsEl.setText(parts.filter(Boolean).join(" · "));
			// Offered once there is a context reading, i.e. once there is something to compact.
			this.compactBtn.toggle(percent != null);
		} catch {
			this.statsEl.setText("");
			this.compactBtn.hide();
		}
	}

	// ---------------------------------------------------------------- actions

	private onInputKey(evt: KeyboardEvent): void {
		if (evt.isComposing || this.suggest.handleKey(evt)) return;
		if (evt.key === "Escape" && this.busy) {
			evt.preventDefault();
			void this.stop();
		} else if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			void this.send(evt.altKey ? "followUp" : "steer");
		}
	}

	private async attach(files: File[]): Promise<void> {
		const model = this.state?.model;
		if (model?.input && !model.input.includes("image")) {
			new Notice(`${model.name || model.id} doesn't accept images. Switch model to attach one.`);
			return;
		}
		const failed = await this.attachments.add(files);
		if (failed) new Notice(failed === 1 ? "Couldn't read that image." : `Couldn't read ${failed} of the images.`);
		this.focusComposer();
	}

	// While pi is working, Enter steers the current run and Alt+Enter queues a follow-up.
	private async send(whileBusy: "steer" | "followUp" = "steer"): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text && !this.attachments.count) return;
		if (this.runLocalCommand(text)) {
			this.inputEl.value = "";
			this.autoGrow();
			return;
		}
		if (!this.client.running) {
			new Notice("pi isn't running. Start it again with the panel's ↻ button.");
			return;
		}
		this.host.closeDrawer();
		const message = withContext(text, this.shareNote ? readActiveContext(this.app) : null);
		const images = this.attachments.take();
		this.inputEl.value = "";
		this.autoGrow();
		this.stickToBottom = true;
		const command = text.match(/^\/(\S+)/)?.[1];
		const isExtensionCommand = Boolean(command && this.suggest.commands.some((c) => c.name === command && c.source === "extension"));
		if (isExtensionCommand) this.echoCommand(text);
		// pi runs extension commands at any time, but turns prompts away while it compacts.
		// Behind messages that are already waiting, a new one waits too, so the order holds.
		if (!isExtensionCommand && (this.compacting || this.flushing || this.held.length)) {
			this.held.push({ text, message, images, mode: whileBusy });
			return this.renderQueue();
		}
		try {
			await this.client.prompt(message, { streamingBehavior: this.busy ? whileBusy : undefined, images });
			// Extension commands can change anything (model, session name) without emitting events.
			if (text.startsWith("/")) {
				this.state = await this.client.getState();
				this.renderControls();
			}
		} catch (err) {
			this.inputEl.value = text;
			this.attachments.restore(images);
			this.autoGrow();
			new Notice(`pi: ${(err as Error).message}`);
		}
	}

	// Two rpiv commands draw a terminal overlay, which pi cannot show over RPC: there
	// /advisor does nothing and /btw never returns. The panel answers them itself.
	private runLocalCommand(text: string): boolean {
		const compact = text.match(/^\/compact(?:\s+([\s\S]*))?$/);
		if (compact) {
			void this.compact(compact[1]?.trim());
			return true;
		}
		if (/^\/reload\s*$/.test(text)) {
			void this.reload();
			return true;
		}
		const btw = text.match(/^\/btw(?:\s+([\s\S]*))?$/);
		if (btw) {
			if (btw[1]?.trim()) void this.side.ask(btw[1].trim());
			else new Notice("Usage: /btw <question>");
			return true;
		}
		if (/^\/advisor\s*$/.test(text)) {
			void this.configureAdvisor();
			return true;
		}
		return false;
	}

	// Same choices and the same config file as rpiv-advisor's own /advisor picker.
	async configureAdvisor(): Promise<void> {
		if (!this.client.running) return;
		type Choice = { label: string; key: string | null; reasoning: boolean };
		const models = await this.client.getAvailableModels();
		const choices: Choice[] = [
			{ label: "No advisor", key: null, reasoning: false },
			...models.map((m) => ({ label: `${m.provider}/${m.id}`, key: `${m.provider}/${m.id}`, reasoning: Boolean(m.reasoning) })),
		];
		const current = readAdvisorConfig().modelKey;
		const picked = await pickOne(this.app, choices, (c) => (c.key === current ? `${c.label}  (current)` : c.label), "Advisor model…");
		if (!picked) return;
		let effort: string | null = null;
		if (picked.reasoning) {
			const efforts = ["model default", "low", "medium", "high"];
			const chosen = await pickOne(this.app, efforts, (e) => e, `Reasoning effort for ${picked.label}…`);
			effort = chosen && chosen !== "model default" ? chosen : null;
		}
		try {
			writeAdvisorConfig(picked.key, effort);
		} catch (err) {
			new Notice(`Couldn't save the advisor setting: ${(err as Error).message}`);
			return;
		}
		// rpiv-advisor reads its config when a session starts, so bring pi back up on the same session.
		await this.restart();
		new Notice(picked.key ? `Advisor: ${picked.label}${effort ? ` (${effort})` : ""}` : "Advisor turned off.");
	}

	async stop(): Promise<void> {
		if (!this.client.running || !this.busy) return;
		// abort would go on to run queued messages; hand them back to the editor instead.
		await this.unqueue();
		await this.client.abort().catch(() => {});
	}

	// Takes everything that is waiting, in pi's queue or held here, back into the editor.
	private async unqueue(): Promise<void> {
		const queued = this.client.running ? await this.client.clearQueue().catch(() => ({ steering: [], followUp: [] })) : { steering: [], followUp: [] };
		const held = this.held.splice(0);
		const restored = [...[...queued.steering, ...queued.followUp].map((m) => splitContext(m).text), ...held.map((h) => h.text)];
		this.attachments.restore(held.flatMap((h) => h.images));
		if (restored.length) {
			this.inputEl.value = [...restored, this.inputEl.value].filter(Boolean).join("\n\n");
			this.autoGrow();
		}
		this.renderQueue();
	}

	// Compaction is over: send on what was held, the way pi's terminal UI does. The first message
	// starts a run unless one is already under way or about to be retried; the rest queue into it.
	private async flushHeld(runExpected: boolean): Promise<void> {
		if (this.flushing || !this.held.length) return;
		this.flushing = true;
		let inRun = runExpected || this.busy;
		try {
			while (this.held.length && !this.compacting && this.client.running) {
				const { message, images, mode } = this.held[0];
				if (!inRun) await this.client.prompt(message, { images, streamingBehavior: mode });
				else if (mode === "followUp") await this.client.followUp(message, images);
				else await this.client.steer(message, images);
				inRun = true;
				this.held.shift();
				this.renderQueue();
			}
		} catch (err) {
			new Notice(`pi: ${(err as Error).message}`);
			await this.unqueue();
		} finally {
			this.flushing = false;
		}
	}

	// A fresh session in this tab, on the pi that is already running.
	async newSession(): Promise<void> {
		if (!this.client.running) {
			this.sessionFile = null;
			this.state = null;
			return this.restart();
		}
		await this.stop();
		const { cancelled } = await this.client.newSession();
		if (!cancelled) await this.syncSession();
		this.focusComposer();
	}

	// Swaps this tab over to another session. The panel has made sure no other tab holds it.
	async load(path: string): Promise<void> {
		if (!this.client.running) {
			this.sessionFile = path;
			this.state = null;
			return this.restart(path);
		}
		await this.stop();
		const { cancelled } = await this.client.switchSession(path);
		if (!cancelled) await this.syncSession();
	}

	async renameCurrent(): Promise<void> {
		if (!this.client.running) return;
		const name = await promptText(this.app, "Rename session", this.state?.sessionName ?? "");
		// pi's RPC rejects empty names, so there is no way to clear one from here.
		if (!name?.trim()) return;
		try {
			await this.client.setSessionName(name.trim());
			this.state = await this.client.getState();
			this.renderControls();
			this.host.sessionsChanged();
		} catch (err) {
			new Notice(`pi: ${(err as Error).message}`);
		}
	}

	// Continues in a copy of this session; the original stays in the history.
	async duplicate(): Promise<void> {
		if (!this.client.running) return;
		if (!this.replaceable) {
			new Notice("pi is still working in that session. Duplicate it once it has finished.");
			return;
		}
		try {
			const { cancelled } = await this.client.cloneSession();
			if (cancelled) return;
			await this.syncSession();
			new Notice("Now in a copy of the session.");
		} catch (err) {
			new Notice(`pi: ${(err as Error).message}`);
		}
	}

	private async pickModel(): Promise<void> {
		if (!this.client.running) return;
		const models = await this.client.getAvailableModels();
		const scoped = scopeModels(await readEnabledModels(this.plugin.panelSettingsFile), models);
		new ModelPicker(
			this.app,
			models,
			scoped,
			this.state?.model ?? null,
			this.plugin.settings.showAllModels,
			async (model) => {
				try {
					await this.client.setModel(model.provider, model.id);
					this.state = await this.client.getState();
					this.renderControls();
				} catch (err) {
					new Notice(`pi: ${(err as Error).message}`);
				}
			},
			(showAll) => {
				this.plugin.settings.showAllModels = showAll;
				void this.plugin.saveSettings();
			},
		).open();
	}

	private async pickThinking(evt: MouseEvent): Promise<void> {
		if (!this.client.running) return;
		const levels = await this.client.getAvailableThinkingLevels();
		const menu = new Menu();
		for (const level of levels) {
			menu.addItem((i) =>
				i.setTitle(level).setChecked(level === this.state?.thinkingLevel).onClick(async () => {
					await this.client.setThinkingLevel(level);
					this.state = await this.client.getState();
					this.renderControls();
				}),
			);
		}
		menu.showAtMouseEvent(evt);
	}

	// `instructions` tells pi what the summary should hold on to.
	async compact(instructions?: string): Promise<void> {
		if (!this.client.running) return;
		if (this.isBusy) {
			new Notice(this.busy ? "pi is still working. Compact once it has finished, or stop it first." : "Already compacting.");
			return;
		}
		try {
			await this.client.compact(instructions || undefined);
		} catch (err) {
			new Notice(`pi: ${(err as Error).message}`);
		}
	}

	focusComposer(): void {
		this.inputEl.focus();
	}

	insertText(text: string): void {
		const { value } = this.inputEl;
		this.inputEl.value = value && !value.endsWith("\n") ? `${value}\n${text}` : value + text;
		this.autoGrow();
		this.focusComposer();
	}

	// ---------------------------------------------------------------- events

	private handleEvent(e: RpcEvent): void {
		switch (e.type) {
			case "agent_start":
				this.setBusy(true);
				this.setActivity("Working…");
				void this.checkMcp();
				break;
			case "agent_settled":
				if (!this.host.isShowing(this)) this.unread = true;
				this.setBusy(false);
				void this.refreshStats();
				break;
			case "message_start":
				if (e.message.role === "user") this.renderUser(e.message as Extract<AgentMessage, { role: "user" }>);
				else if (e.message.role === "assistant") this.live = this.beginAssistant();
				break;
			case "message_update":
				this.onDelta(e.assistantMessageEvent);
				break;
			case "message_end":
				if (e.message.role === "assistant") {
					this.finishAssistant(this.live ?? this.beginAssistant(), e.message as AssistantMessage);
					this.live = null;
				}
				break;
			case "tool_execution_start":
				this.cardFor(e.toolCallId, e.toolName, e.args).setStatus("running");
				this.setActivity(`Running ${e.toolName}…`);
				break;
			case "tool_execution_update":
				this.toolCards.get(e.toolCallId)?.setResult(e.partialResult);
				this.keepScrolled();
				break;
			case "tool_execution_end": {
				const card = this.cardFor(e.toolCallId, e.toolName);
				if (e.toolName === "todo" && !e.isError) this.todos.set(tasksFrom(e.result?.details) ?? null);
				card.setResult(e.result, e.isError);
				card.setStatus(e.isError ? "error" : "done");
				this.setActivity("Working…");
				this.keepScrolled();
				break;
			}
			case "queue_update":
				this.piQueue = { steering: e.steering, followUp: e.followUp };
				this.renderQueue();
				break;
			case "compaction_start":
				this.setCompacting(true);
				this.setActivity("Compacting context…");
				break;
			case "compaction_end":
				this.setCompacting(false);
				this.setActivity(this.busy ? "Working…" : null);
				void this.flushHeld(Boolean(e.willRetry));
				if (e.errorMessage) new Notice(`pi: compaction failed. ${e.errorMessage}`);
				else if (!e.aborted) {
					const { tokensBefore: before, estimatedTokensAfter: after } = e.result ?? {};
					this.renderNotice(before && after ? `Context compacted · ${compactTokens(before)} → ${compactTokens(after)} tokens` : "Context compacted");
				}
				void this.refreshStats();
				break;
			case "auto_retry_start":
				this.setActivity(`Retrying (${e.attempt}/${e.maxAttempts}) in ${Math.round(e.delayMs / 1000)}s…`);
				break;
			case "auto_retry_end":
				if (!e.success) this.renderNotice(e.finalError ?? "Retries exhausted", true);
				break;
			case "extension_error":
				console.warn(`[pi-harness] extension error in ${e.extensionPath} (${e.event}): ${e.error}`);
				break;
			case "extension_ui_request":
				this.onExtensionUi(e);
				break;
		}
	}

	private onDelta(d: AssistantMessageEvent): void {
		const live = (this.live ??= this.beginAssistant());
		switch (d.type) {
			case "text_start":
				live.blocks.set(d.contentIndex, this.textBlock(live));
				break;
			case "text_delta":
				(live.blocks.get(d.contentIndex) as MarkdownBlock | undefined)?.append(d.delta);
				break;
			case "thinking_start":
				if (this.plugin.settings.showThinking) live.blocks.set(d.contentIndex, new ThinkingBlock(this.renderHost, live.el));
				break;
			case "thinking_delta":
				(live.blocks.get(d.contentIndex) as ThinkingBlock | undefined)?.append(d.delta);
				break;
			case "thinking_end":
				(live.blocks.get(d.contentIndex) as ThinkingBlock | undefined)?.finish();
				break;
			case "toolcall_start":
				live.blocks.set(d.contentIndex, this.cardFor(d.id, d.toolName));
				break;
			case "toolcall_end":
				this.cardFor(d.toolCall.id, d.toolCall.name, d.toolCall.arguments);
				break;
		}
		this.keepScrolled();
	}

	private onExtensionUi(req: ExtensionUiRequest): void {
		// Not a question for the user: one of pi's browser_* tools asking Obsidian to act (see browser.ts).
		if (req.method === "input" && req.title === BROWSER_CHANNEL) {
			void this.plugin.browser.handle(req.placeholder).then((value) => {
				if (this.client.running) this.client.respondToUi(req.id, { value });
			});
			return;
		}
		switch (req.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
				this.dialogs.push(req);
				// The question sits in this tab; say so if the user is looking somewhere else.
				if (!this.host.isShowing(this)) this.callOver(`pi has a question for you in "${this.title}".`);
				else if (!this.el.contains(this.el.ownerDocument.activeElement)) this.callOver("pi has a question for you.");
				break;
			case "notify":
				this.showNotification(stripAnsi(req.message ?? ""), req.notifyType ?? "info");
				break;
			case "setStatus":
				// Footer chatter meant for pi's terminal ("MCP: 1 server enabled", auth state).
				// The panel shows what pi is doing and warns about what is broken; nothing else.
				break;
			case "setWidget":
				if (req.widgetKey) {
					if (req.widgetLines?.length) this.widgets.set(req.widgetKey, { lines: req.widgetLines, below: req.widgetPlacement === "belowEditor" });
					else this.widgets.delete(req.widgetKey);
					this.renderWidgets();
				}
				break;
			case "set_editor_text":
				this.inputEl.value = req.text ?? "";
				this.autoGrow();
				break;
		}
	}

	// ---------------------------------------------------------------- transcript

	private renderTranscript(messages: AgentMessage[]): void {
		this.messagesEl.empty();
		this.toolCards.clear();
		this.live = null;
		// Whatever was pending belonged to the session that just went away.
		this.dialogs.cancelAll();
		this.side.reset();
		let tasks: ReturnType<typeof tasksFrom> = null;
		for (const m of messages) {
			if (m.role === "user") this.renderUser(m as Extract<AgentMessage, { role: "user" }>);
			else if (m.role === "assistant") this.finishAssistant(this.beginAssistant(), m as AssistantMessage);
			else if (m.role === "toolResult") {
				const r = m as Extract<AgentMessage, { role: "toolResult" }>;
				const card = this.cardFor(r.toolCallId, r.toolName);
				card.setResult(r, r.isError);
				card.setStatus(r.isError ? "error" : "done");
				// Every todo result is a full snapshot, so the last one is the current list.
				if (r.toolName === "todo" && !r.isError) tasks = tasksFrom(r.details) ?? tasks;
			}
		}
		this.todos.set(tasks);
		this.renderEmptyState();
		this.stickToBottom = true;
		this.keepScrolled();
	}

	private renderEmptyState(): void {
		this.messagesEl.querySelector(".pi-empty")?.remove();
		if (this.messagesEl.childElementCount > 0) return;
		const empty = this.messagesEl.createDiv({ cls: "pi-empty" });
		setIcon(empty.createDiv({ cls: "pi-empty-icon" }), "pi");
		empty.createDiv({ cls: "pi-empty-title", text: `Ask pi about ${this.app.vault.getName()}` });
		const skills = this.suggest.commands.filter((c) => c.source === "skill" && OBSIDIAN_SKILLS.includes(c.name.replace(/^skill:/, "")));
		if (!skills.length) return;
		const chips = empty.createDiv({ cls: "pi-empty-skills" });
		for (const skill of skills) {
			const chip = chips.createEl("button", { cls: "pi-pill", text: skill.name.replace(/^skill:/, ""), attr: { "aria-label": skill.description ?? "" } });
			chip.addEventListener("click", () => this.insertText(`/${skill.name} `));
		}
	}

	private addMessageEl(cls: string): HTMLElement {
		this.messagesEl.querySelector(".pi-empty")?.remove();
		return this.messagesEl.createDiv({ cls: `pi-msg ${cls}` });
	}

	private renderUser(message: Extract<AgentMessage, { role: "user" }>): void {
		const { text, notePath, hasSelection } = splitContext(contentText(message.content));
		if (!this.firstPrompt) {
			this.firstPrompt = text.replace(/\s+/g, " ").trim().slice(0, 60);
			this.host.changed(this);
		}
		const el = this.addMessageEl("pi-msg-user");
		if (notePath) {
			const chip = el.createDiv({ cls: "pi-msg-context" });
			setIcon(chip.createSpan({ cls: "pi-icon" }), hasSelection ? "text-select" : "file-text");
			chip.createSpan({ text: notePath.replace(/\.md$/, "").split("/").pop() + (hasSelection ? " (selection)" : "") });
		}
		const images = Array.isArray(message.content) ? message.content.filter((b): b is ImageContent => b.type === "image") : [];
		if (images.length) {
			const strip = el.createDiv({ cls: "pi-msg-images" });
			for (const image of images) {
				const img = strip.createEl("img", { attr: { src: imageSrc(image), alt: "Attached image" } });
				img.addEventListener("load", () => this.keepScrolled());
				img.addEventListener("click", () => img.toggleClass("is-expanded", !img.hasClass("is-expanded")));
			}
		}
		if (text) new MarkdownBlock(this.renderHost, el.createDiv({ cls: "pi-text markdown-rendered" })).set(text);
		this.keepScrolled();
	}

	// A toast that brings the user to this tab when clicked.
	private callOver(text: string): void {
		new Notice(text, 8000).noticeEl.addEventListener("click", () => this.host.reveal(this));
	}

	// What an extension "notifies" is often the whole output of a command (/mcp, /todos).
	// A toast is no place to read that, so only short remarks stay toasts.
	private showNotification(message: string, type: "info" | "warning" | "error"): void {
		const text = message.trim();
		if (!text) return;
		const reconnected = text.match(/^MCP: Reconnected to (\S+)/);
		if (reconnected && this.quietReconnects.delete(reconnected[1])) return;
		if (!text.includes("\n") && text.length <= TOAST_MAX_CHARS) {
			new Notice(text, type === "error" ? 8000 : 4000);
			return;
		}
		const el = this.addMessageEl("pi-msg-output");
		el.dataset.type = type;
		el.setText(text);
		this.keepScrolled();
	}

	// Extension commands run without leaving a message in the conversation, so their
	// output would otherwise appear out of nowhere. Panel-only: a reload won't show it again.
	private echoCommand(text: string): void {
		this.addMessageEl("pi-msg-command").setText(text);
		this.keepScrolled();
	}

	private renderNotice(text: string, isError = false): void {
		this.addMessageEl(isError ? "pi-msg-notice is-error" : "pi-msg-notice").setText(text);
		this.keepScrolled();
	}

	private beginAssistant(): LiveAssistant {
		return { el: this.addMessageEl("pi-msg-assistant"), blocks: new Map() };
	}

	private textBlock(live: LiveAssistant): MarkdownBlock {
		return new MarkdownBlock(this.renderHost, live.el.createDiv({ cls: "pi-text markdown-rendered" }));
	}

	// message_end is authoritative: reconcile whatever streamed with the final content.
	private finishAssistant(live: LiveAssistant, message: AssistantMessage): void {
		message.content.forEach((block, i) => {
			const existing = live.blocks.get(i);
			if (block.type === "text") {
				const md = (existing as MarkdownBlock | undefined) ?? this.textBlock(live);
				live.blocks.set(i, md);
				md.set(block.text);
			} else if (block.type === "thinking" && this.plugin.settings.showThinking) {
				const thinking = (existing as ThinkingBlock | undefined) ?? new ThinkingBlock(this.renderHost, live.el);
				live.blocks.set(i, thinking);
				thinking.finish(block.thinking);
			} else if (block.type === "toolCall") {
				const call = block as ToolCallContent;
				live.blocks.set(i, this.cardFor(call.id, call.name, call.arguments, live.el));
			}
		});
		if (message.stopReason === "error") {
			live.el.createDiv({ cls: "pi-msg-notice is-error", text: message.errorMessage ?? "The model returned an error." });
		} else if (message.stopReason === "aborted") {
			live.el.createDiv({ cls: "pi-msg-notice", text: "Stopped" });
		}
		if (!live.el.childElementCount) live.el.remove();
		this.keepScrolled();
	}

	private cardFor(id: string, name: string, args?: Record<string, unknown>, parent?: HTMLElement): ToolCard {
		let card = this.toolCards.get(id);
		if (!card) {
			const container = parent ?? this.live?.el ?? this.addMessageEl("pi-msg-assistant");
			card = new ToolCard(container, this.renderHost, name, this.plugin.settings.expandTools, {
				open: (p, newLeaf) => this.openVaultPath(p, newLeaf),
				absolute: (p) => this.absolutePath(p),
				openExternally: async (p) => {
					const file = this.absolutePath(p);
					if (!existsSync(file)) return "it is no longer there";
					return (await shell.openPath(file)) || null;
				},
			});
			this.toolCards.set(id, card);
		}
		if (args) card.setArgs(args);
		return card;
	}

	private absolutePath(path: string): string {
		return resolve(this.plugin.vaultPath, path.replace(/^~(?=$|\/)/, homedir()));
	}

	private openVaultPath(path: string, newLeaf: boolean): boolean {
		const base = this.plugin.vaultPath;
		const rel = relative(base, this.absolutePath(path));
		const file = this.app.vault.getAbstractFileByPath(rel);
		if (!(file instanceof TFile)) return false;
		void this.app.workspace.getLeaf(newLeaf).openFile(file);
		return true;
	}

	// pi's own queue, then what the tab holds back during compaction. "Next" reaches pi before
	// its next step; "After" waits until it has finished.
	private renderQueue(): void {
		this.queueEl.empty();
		const row = (text: string, label: string) => {
			const el = this.queueEl.createDiv({ cls: "pi-queue-item" });
			el.createSpan({ cls: "pi-queue-label", text: label });
			renderInline(this.renderHost, el.createSpan({ cls: "pi-queue-text" }), text);
			return el;
		};
		const rows = [
			...this.piQueue.steering.map((t) => row(splitContext(t).text, "Next")),
			...this.piQueue.followUp.map((t) => row(splitContext(t).text, "After")),
			...this.held.map((h) => row(h.text || `${h.images.length} image${h.images.length === 1 ? "" : "s"}`, h.mode === "followUp" ? "After" : "Next")),
		];
		if (!rows.length) return;
		const back = rows[0].createEl("button", { cls: "pi-queue-clear clickable-icon", attr: { "aria-label": "Take queued messages back into the editor" } });
		setIcon(back, "undo-2");
		back.addEventListener("click", () => void this.unqueue().then(() => this.focusComposer()));
		this.keepScrolled();
	}

	private renderWidgets(): void {
		this.widgetsAboveEl.empty();
		this.widgetsBelowEl.empty();
		for (const { lines, below } of this.widgets.values()) {
			(below ? this.widgetsBelowEl : this.widgetsAboveEl).createEl("pre", { cls: "pi-widget", text: stripAnsi(lines.join("\n")) });
		}
	}
}
