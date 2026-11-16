import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PiAgentPlugin from "./main";
import { basename } from "path";
import { DEFAULT_INHERITANCE, type Inheritance } from "./agentDir";
import { disabled, enabled, isDisabled, readPackageEntries, replacePackageEntry, sourceOf, type PackageEntry } from "./packages";
import { DEFAULT_SERVER_PORT, discoverServerUrls, generateServerToken } from "./remote/ws";
import { findRequired, manualInstallCommands, REQUIRED_PACKAGES, SKILLS_PACKAGE } from "./requirements";
import type { AgentBackend } from "./rpc/AgentClient";

export interface PiAgentSettings {
	backend: AgentBackend;
	piPath: string;
	agyPath: string;
	agyArgs: string;
	agySkipPermissions: boolean;
	model: string;
	extraSkillPaths: string;
	includeActiveNote: boolean;
	resumeLastSession: boolean;
	showThinking: boolean;
	expandTools: boolean;
	systemPromptAddendum: string;
	extraArgs: string;
	lastSessionFile: string;
	isolate: boolean;
	inherit: Inheritance;
	// Package entries as they were before being switched off here, so their own filters come back. Keyed by settings file and source.
	rememberedPackages: Record<string, PackageEntry>;
	// Ids of panes from before the rename whose tabs have been taken over (see main.ts).
	adoptedLegacyPanels: string[];
	hiddenTodos: Record<string, string[]>;
	connectMcpOnStart: boolean;
	browserControl: boolean;
	// pi's obsidian_* tools: metadata cache, properties, commands.
	obsidianControl: boolean;
	// Command ids pi may run, one glob per line; empty means none.
	commandAllowlist: string;
	// Send the model stand-ins for bulky tool output from older turns (pi-extension/trim-tool-output.ts).
	trimToolOutput: boolean;
	// The model picker's last view: all models, or pi's scoped list (enabledModels).
	showAllModels: boolean;
	// Desktop server for Obsidian Mobile over Tailscale or LAN.
	serverEnabled: boolean;
	serverPort: number;
	serverBindHost: string;
	serverToken: string;
	// Remote server connection (required on Obsidian Mobile, optional on desktop).
	remoteUrl: string;
	remoteToken: string;
}

export const DEFAULT_SETTINGS: PiAgentSettings = {
	backend: "pi",
	piPath: "pi",
	agyPath: "agy",
	agyArgs: "",
	agySkipPermissions: true,
	model: "",
	extraSkillPaths: "",
	includeActiveNote: true,
	resumeLastSession: true,
	showThinking: true,
	expandTools: false,
	systemPromptAddendum: "",
	extraArgs: "",
	lastSessionFile: "",
	isolate: false,
	inherit: DEFAULT_INHERITANCE,
	rememberedPackages: {},
	adoptedLegacyPanels: [],
	hiddenTodos: {},
	connectMcpOnStart: true,
	browserControl: false,
	obsidianControl: true,
	commandAllowlist: "",
	trimToolOutput: true,
	showAllModels: false,
	serverEnabled: false,
	serverPort: DEFAULT_SERVER_PORT,
	serverBindHost: "0.0.0.0",
	serverToken: "",
	remoteUrl: "",
	remoteToken: "",
};

export class PiAgentSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: PiAgentPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const hasLocal = this.plugin.hasLocalFs;

		if (!hasLocal) this.renderRemoteClientSection(containerEl);

		new Setting(containerEl).setName("Agent backend").setHeading();

		new Setting(containerEl)
			.setName("Default backend")
			.setDesc("Choose whether new tabs use Pi (pi --mode rpc) or Agy (agy acp). You can also open either backend from the panel menu.")
			.addDropdown((d) =>
				d
					.addOption("pi", "Pi")
					.addOption("acp", "Agy")
					.setValue(s.backend)
					.onChange(async (v) => {
						s.backend = v === "acp" ? "acp" : "pi";
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Default model")
			.setDesc('Model name or pattern, e.g. "anthropic/claude-sonnet-5" or "*sonnet*:high". Leave empty to use the agent\'s default.')
			.addText((t) =>
				t.setValue(s.model).onChange(async (v) => {
					s.model = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Resume last session")
			.setDesc("Each chat tab reopens the session it had last time. Turn off to start fresh whenever an agent starts.")
			.addToggle((t) =>
				t.setValue(s.resumeLastSession).onChange(async (v) => {
					s.resumeLastSession = v;
					await save();
				}),
			);

		if (hasLocal) {
			new Setting(containerEl).setName("Agy").setHeading();

			new Setting(containerEl)
				.setName("Agy binary")
				.setDesc("Command name or absolute path for the Agy CLI (agy acp). Authenticate once in a terminal with: agy acp --login")
				.addText((t) =>
					t.setPlaceholder("agy").setValue(s.agyPath).onChange(async (v) => {
						s.agyPath = v.trim() || "agy";
						await save();
					}),
				);

			new Setting(containerEl)
				.setName("Skip tool permission prompts")
				.setDesc("Pass --dangerously-skip-permissions to agy acp so tool calls run without confirmation, matching Pi's behavior.")
				.addToggle((t) =>
					t.setValue(s.agySkipPermissions).onChange(async (v) => {
						s.agySkipPermissions = v;
						await save();
					}),
				);

			new Setting(containerEl)
				.setName("Extra Agy arguments")
				.setDesc('Appended to "agy acp", e.g. "--sandbox" or "--agent my-agent".')
				.addText((t) =>
					t.setValue(s.agyArgs).onChange(async (v) => {
						s.agyArgs = v;
						await save();
					}),
				);
		}

		new Setting(containerEl).setName("Pi").setHeading();

		if (hasLocal) {
			new Setting(containerEl)
				.setName("Pi binary")
				.setDesc("Command name or absolute path. Your login shell's PATH is used to resolve it.")
				.addText((t) =>
					t.setPlaceholder("pi").setValue(s.piPath).onChange(async (v) => {
						s.piPath = v.trim() || "pi";
						await save();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Extra Pi arguments")
			.setDesc('Appended to the pi command line, e.g. "--tools read,grep,find,ls" for a read-only agent.')
			.addText((t) =>
				t.setValue(s.extraArgs).onChange(async (v) => {
					s.extraArgs = v;
					await save();
				}),
			);

		if (hasLocal) {
			this.renderDesktopServerSection(containerEl);

			new Setting(containerEl).setName("Inheritance").setHeading();

			new Setting(containerEl)
				.setName("Keep the panel's Pi separate from your terminal Pi")
				.setDesc("Off by default: the panel shares your terminal Pi's ~/.pi/agent profile. Turn on to use ~/.pi/harness and choose what to inherit below. The vault's own .pi folder loads either way once you have trusted it in Pi. Reload Pi after changing anything here.")
				.addToggle((t) =>
					t.setValue(s.isolate).onChange(async (v) => {
						s.isolate = v;
						await save();
						this.display();
					}),
				);

			const inherited: [keyof Inheritance, string, string][] = [
				["logins", "Logins", "Your provider credentials (auth.json), linked so a refreshed token is shared. A login that depends on a provider package also needs that package, for example installed in the vault's .pi folder."],
				["models", "Custom models", "Models and providers you defined in models.json."],
				["settings", "Default model and settings", "Default provider, model and thinking level, enabled models, compaction and shell prefix, copied once. Never the package list."],
				["sessions", "Session history", "Keep this vault's sessions where your terminal pi keeps them, so the history is one list."],
				["trust", "Vault trust", "Your decision in pi to trust this vault, which is what lets the vault's own .pi folder load."],
				["mcpLogins", "Legacy MCP logins", "Links mcp-oauth/ for pi-mcp-adapter. Native MCP tokens in mcp-auth.json are not shared with a separate profile."],
				["mcpServers", "Legacy MCP servers", "For pi-mcp-adapter: include global MCP files, or use only the vault's .mcp.json when off. Native MCP reads the vault's .pi/mcp.json and this pi profile's mcp.json instead."],
				["skills", "Skills", "Skills in ~/.agents/skills and ~/.pi/agent/skills."],
				["extensions", "Local extensions", "Extensions in ~/.pi/agent/extensions. Packages you installed with pi install are not inherited one by one: install the ones you want in the vault's .pi folder (pi install -l), or switch the separation off."],
				["agents", "Subagents", "Subagent definitions in ~/.pi/agent/agents, for an extension that uses them."],
				["prompts", "Prompt templates", "Templates in ~/.pi/agent/prompts."],
			];
			if (s.isolate) {
				for (const [key, name, desc] of inherited) {
					new Setting(containerEl)
						.setName(name)
						.setDesc(desc)
						.addToggle((t) =>
							t.setValue(s.inherit[key]).onChange(async (v) => {
								s.inherit = { ...s.inherit, [key]: v };
								await save();
							}),
						);
				}
			}
		}

		new Setting(containerEl).setName("Extensions").setHeading();

		const packagesEl = containerEl.createDiv();
		void this.renderPackages(packagesEl);

		if (hasLocal) {
			new Setting(containerEl)
				.setName("Let agents use the web viewer")
				.setDesc("Gives agents tools to open pages in Obsidian's web viewer, read them, click, type, take a screenshot and run scripts in them. You watch it happen in a tab. The web viewer keeps you logged in to sites, so the agent acts there as you, and a page it reads can contain text that tries to steer it: leave this off unless you want it. Needs the Web viewer core plugin. Reload after changing this.")
				.addToggle((t) =>
					t.setValue(s.browserControl).onChange(async (v) => {
						s.browserControl = v;
						await save();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Let agents use Obsidian")
			.setDesc("Gives agents tools for what only the running app knows: ranked search of your notes, section by section, kept current as you edit; backlinks, tags, aliases and headings from the metadata cache, property edits that keep the YAML well-formed, opening a note for you, and the command palette. Reload after changing this.")
			.addToggle((t) =>
				t.setValue(s.obsidianControl).onChange(async (v) => {
					s.obsidianControl = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Commands agents may run")
			.setDesc("Obsidian command ids agents are allowed to run, one per line. * stands for anything: editor:* allows every editor command, * alone allows all of them. Leave empty to let agents list commands but run none. Find ids with the obsidian_commands tool or in Settings → Hotkeys.")
			.addTextArea((t) => {
				t.setPlaceholder("editor:*\nworkspace:*\napp:reload").setValue(s.commandAllowlist);
				t.inputEl.rows = 4;
				t.onChange(async (v) => {
					s.commandAllowlist = v;
					await save();
				});
			});

		if (hasLocal) {
			new Setting(containerEl)
				.setName("Connect legacy MCP servers when Pi starts")
				.setDesc("For pi-mcp-adapter and the vault's .mcp.json: connects available HTTP servers right away rather than waiting until something uses them. Pi's native MCP connects servers from .pi/mcp.json itself.")
				.addToggle((t) =>
					t.setValue(s.connectMcpOnStart).onChange(async (v) => {
						s.connectMcpOnStart = v;
						await save();
					}),
				);
		}

		new Setting(containerEl).setName("Skills and context").setHeading();

		if (hasLocal) {
			new Setting(containerEl)
				.setName("Extra skill folders")
				.setDesc("One path per line, relative to the vault or absolute, e.g. .claude/skills. Skills in .pi/skills and .agents/skills are found by Pi on its own.")
				.addTextArea((t) =>
					t.setValue(s.extraSkillPaths).onChange(async (v) => {
						s.extraSkillPaths = v;
						await save();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Share the active note")
			.setDesc("Tell the agent which note is open and what text is selected. Can be toggled per message in the composer.")
			.addToggle((t) =>
				t.setValue(s.includeActiveNote).onChange(async (v) => {
					s.includeActiveNote = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Trim old tool output")
			.setDesc("Before each reply in Pi tabs, the model gets a one-line stand-in instead of the bulky output of tool calls from more than a few messages ago: notes read in full, fetched pages, screenshots. Pi can run the tool again if it needs it. A conversation then goes longer before Pi has to compact it. The session and the panel keep everything. Reload Pi after changing this.")
			.addToggle((t) =>
				t.setValue(s.trimToolOutput).onChange(async (v) => {
					s.trimToolOutput = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Additional instructions")
			.setDesc("Appended to the system prompt, after the plugin's own Obsidian guidance.")
			.addTextArea((t) =>
				t.setValue(s.systemPromptAddendum).onChange(async (v) => {
					s.systemPromptAddendum = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Display").setHeading();

		new Setting(containerEl).setName("Show thinking").addToggle((t) =>
			t.setValue(s.showThinking).onChange(async (v) => {
				s.showThinking = v;
				await save();
			}),
		);

		new Setting(containerEl)
			.setName("Expand tool calls")
			.setDesc("Show tool output open by default instead of collapsed.")
			.addToggle((t) =>
				t.setValue(s.expandTools).onChange(async (v) => {
					s.expandTools = v;
					await save();
				}),
			);

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Changes to backend settings and to skills take effect the next time a tab starts or reloads (the panel's ↻ button, or /reload).",
		});
	}

	private renderDesktopServerSection(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl).setName("Mobile server").setHeading();

		new Setting(containerEl)
			.setName("Host server for Obsidian Mobile")
			.setDesc("Starts a WebSocket server inside desktop Obsidian so your phone can use this machine's Pi over Tailscale.")
			.addToggle((t) =>
				t.setValue(s.serverEnabled).onChange(async (v) => {
					s.serverEnabled = v;
					if (v && !s.serverToken) s.serverToken = generateServerToken();
					await save();
					await this.plugin.syncRemoteServer();
					this.display();
				}),
			);

		if (!s.serverEnabled) return;

		const urls = discoverServerUrls(s.serverPort || DEFAULT_SERVER_PORT, s.serverBindHost);
		const urlSummary = urls.length ? `Reachable at: ${urls.join("  ·  ")}` : "Listening on the configured address and port.";

		new Setting(containerEl)
			.setName("Server port")
			.setDesc(urlSummary)
			.addText((t) =>
				t.setPlaceholder(String(DEFAULT_SERVER_PORT)).setValue(String(s.serverPort || DEFAULT_SERVER_PORT)).onChange(async (v) => {
					const parsed = Number.parseInt(v.trim(), 10);
					if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
						s.serverPort = parsed;
						await save();
						await this.plugin.syncRemoteServer();
					}
				}),
			)
			.addButton((b) =>
				b.setButtonText("Copy URL").onClick(async () => {
					const primary = urls[0] ?? `ws://127.0.0.1:${s.serverPort || DEFAULT_SERVER_PORT}`;
					await navigator.clipboard.writeText(primary);
					new Notice(`Copied ${primary}`);
				}),
			);

		new Setting(containerEl)
			.setName("Bind address")
			.setDesc("0.0.0.0 listens on all interfaces, including Tailscale. Set your Tailscale IP to restrict listening to that interface.")
			.addText((t) =>
				t.setPlaceholder("0.0.0.0").setValue(s.serverBindHost).onChange(async (v) => {
					s.serverBindHost = v.trim() || "0.0.0.0";
					await save();
					await this.plugin.syncRemoteServer();
				}),
			);

		new Setting(containerEl)
			.setName("Access token")
			.setDesc("Enter this token on Obsidian Mobile to authenticate connections.")
			.addText((t) =>
				t.setValue(s.serverToken).onChange(async (v) => {
					s.serverToken = v.trim();
					await save();
					await this.plugin.syncRemoteServer();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Copy").onClick(async () => {
					await navigator.clipboard.writeText(s.serverToken);
					new Notice("Copied access token.");
				}),
			)
			.addButton((b) =>
				b.setButtonText("Regenerate").onClick(async () => {
					s.serverToken = generateServerToken();
					s.remoteToken = s.serverToken;
					await save();
					await this.plugin.syncRemoteServer();
					this.display();
				}),
			);
	}

	private renderRemoteClientSection(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl).setName("Remote server").setHeading();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Tailscale or LAN address of the desktop machine running Obsidian, e.g. ws://100.64.0.1:31415.")
			.addText((t) =>
				t.setPlaceholder("ws://100.x.y.z:31415").setValue(s.remoteUrl).onChange(async (v) => {
					s.remoteUrl = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Access token")
			.setDesc("The access token from Settings → Agent Workbench → Mobile server on the desktop machine.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("Paste access token").setValue(s.remoteToken || s.serverToken).onChange(async (v) => {
					s.remoteToken = v.trim();
					await save();
				});
			})
			.addButton((b) =>
				b.setButtonText("Test connection").onClick(async () => {
					try {
						const info = await this.plugin.remoteClient.ping();
						new Notice(`Connected to "${info.vaultName}" (${info.vaultPath}).`);
					} catch (err) {
						new Notice(`Connection failed: ${(err as Error).message}`);
					}
				}),
			);
	}

	// Every package the panel's pi loads, from its own config folder and from the vault's .pi folder,
	// with a switch each. Off is pi's own kind of off: the package stays installed and loads nothing.
	private async renderPackages(el: HTMLElement): Promise<void> {
		const { plugin } = this;
		const s = plugin.settings;
		const header = new Setting(el).setName("Packages").setDesc("Checking…");

		const installed = await plugin.installedPackages().catch((err: Error) => err);
		if (installed instanceof Error) return void header.setDesc(`Couldn't inspect packages: ${installed.message}`);
		if (plugin.isRemote) {
			header.setDesc("Packages are managed on the remote server. Installed on the server: " + (installed.map((p) => basename(p.path)).join(", ") || "none") + ".");
			return;
		}
		header.setDesc("Agent Workbench only inspects installation status; it never installs, removes, or updates Pi packages. Manage packages yourself in a terminal. The switches below only control whether an installed package loads.");

		const missingPackages = [...findRequired(installed)].filter(([, pkg]) => pkg === null).map(([name]) => name);
		const skillsPackageMissing = !installed.some((pkg) => basename(pkg.path) === SKILLS_PACKAGE.name);
		const commands = manualInstallCommands(missingPackages, skillsPackageMissing);
		if (commands.length) {
			new Setting(el)
				.setName("Manual setup")
				.setDesc("Open a terminal in this vault's root and run the commands below. Local installs work whether the panel uses its isolated Pi profile or your terminal profile. The Obsidian skills package is optional if Pi already loads those skills another way.");
			el.createEl("pre", { cls: "pi-package-commands", text: commands.join("\n") });
		}

		const required = new Set<string>([...REQUIRED_PACKAGES, SKILLS_PACKAGE.name]);
		const scopes = [
			{ file: plugin.panelSettingsFile, label: s.isolate ? "the panel's Pi" : "your Pi, shared with the terminal", editable: s.isolate },
			{ file: plugin.vaultSettingsFile, label: "this vault's .pi folder", editable: true },
		];
		for (const scope of scopes) {
			for (const entry of await readPackageEntries(scope.file)) {
				const source = sourceOf(entry);
				const path = installed.find((pkg) => pkg.source === source)?.path;
				const name = path ? basename(path) : source;
				const description = [source, scope.label, required.has(name) ? "recommended by Agent Workbench" : null, path ? null : "not installed; manage it in a terminal"].filter(Boolean).join(" · ");
				new Setting(el)
					.setName(name)
					.setDesc(description)
					.addToggle((t) =>
						t
							.setValue(!isDisabled(entry))
							.setDisabled(!scope.editable)
							.setTooltip(scope.editable ? "" : "Shared with your terminal pi. Change it there with pi config.")
							.onChange(async (on) => {
								const key = `${scope.file}::${source}`;
								const before = await replacePackageEntry(scope.file, source, (current) => (on ? enabled(current, s.rememberedPackages[key]) : disabled(current))).catch((err: Error) => void new Notice(`Couldn't change ${scope.file}: ${err.message}`, 8000));
								const { [key]: _forgotten, ...rest } = s.rememberedPackages;
								s.rememberedPackages = !on && before && !isDisabled(before) ? { ...rest, [key]: before } : rest;
								await plugin.saveSettings();
							}),
					);
			}
		}
	}
}
