import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PiAgentPlugin from "./main";
import { basename } from "path";
import { DEFAULT_INHERITANCE, type Inheritance } from "./agentDir";
import { disabled, enabled, isDisabled, readPackageEntries, replacePackageEntry, sourceOf, type PackageEntry } from "./packages";
import { findRequired, manualInstallCommands, REQUIRED_PACKAGES, SKILLS_PACKAGE } from "./requirements";

export interface PiAgentSettings {
	piPath: string;
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
}

export const DEFAULT_SETTINGS: PiAgentSettings = {
	piPath: "pi",
	model: "",
	extraSkillPaths: "",
	includeActiveNote: true,
	resumeLastSession: true,
	showThinking: true,
	expandTools: false,
	systemPromptAddendum: "",
	extraArgs: "",
	lastSessionFile: "",
	isolate: true,
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

		new Setting(containerEl).setName("pi").setHeading();

		new Setting(containerEl)
			.setName("pi binary")
			.setDesc("Command name or absolute path. Your login shell's PATH is used to resolve it.")
			.addText((t) =>
				t.setPlaceholder("pi").setValue(s.piPath).onChange(async (v) => {
					s.piPath = v.trim() || "pi";
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Default model")
			.setDesc('Pattern passed to --model, e.g. "anthropic/claude-sonnet-5" or "*sonnet*:high". Leave empty to use pi\'s default.')
			.addText((t) =>
				t.setValue(s.model).onChange(async (v) => {
					s.model = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Extra arguments")
			.setDesc('Appended to the pi command line, e.g. "--tools read,grep,find,ls" for a read-only agent.')
			.addText((t) =>
				t.setValue(s.extraArgs).onChange(async (v) => {
					s.extraArgs = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Resume last session")
			.setDesc("Each chat tab reopens the session it had last time. Turn off to start fresh whenever pi starts.")
			.addToggle((t) =>
				t.setValue(s.resumeLastSession).onChange(async (v) => {
					s.resumeLastSession = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Inheritance").setHeading();

		new Setting(containerEl)
			.setName("Keep the panel's pi separate from your terminal pi")
			.setDesc("The panel's pi uses a config folder of its own (~/.pi/harness) and takes from your terminal pi (~/.pi/agent) only what is switched on below. What this vault has in its own .pi folder is not inheritance and loads either way, once you have trusted the vault in pi. Off: the panel uses ~/.pi/agent as it is, with everything in it. Reload pi after changing anything here.")
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
			["mcpLogins", "MCP logins", "OAuth logins for MCP servers."],
			["mcpServers", "MCP servers", "Servers from your global MCP files (~/.config/mcp/mcp.json, ~/.agents/mcp.json and pi's own). Off: only the vault's .mcp.json counts."],
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

		new Setting(containerEl).setName("Extensions").setHeading();

		const packagesEl = containerEl.createDiv();
		void this.renderPackages(packagesEl);

		new Setting(containerEl)
			.setName("Let pi use the web viewer")
			.setDesc("Gives pi tools to open pages in Obsidian's web viewer, read them, click, type, take a screenshot and run scripts in them. You watch it happen in a tab. The web viewer keeps you logged in to sites, so pi acts there as you, and a page it reads can contain text that tries to steer it: leave this off unless you want it. Needs the Web viewer core plugin. Reload pi after changing this.")
			.addToggle((t) =>
				t.setValue(s.browserControl).onChange(async (v) => {
					s.browserControl = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Let pi use Obsidian")
			.setDesc("Gives pi tools for what only the running app knows: ranked search of your notes, section by section, kept current as you edit; backlinks, tags, aliases and headings from the metadata cache, property edits that keep the YAML well-formed, opening a note for you, and the command palette. Reload pi after changing this.")
			.addToggle((t) =>
				t.setValue(s.obsidianControl).onChange(async (v) => {
					s.obsidianControl = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Commands pi may run")
			.setDesc("Obsidian command ids pi is allowed to run, one per line. * stands for anything: editor:* allows every editor command, * alone allows all of them. Leave empty to let pi list commands but run none. Find ids with the obsidian_commands tool or in Settings → Hotkeys.")
			.addTextArea((t) => {
				t.setPlaceholder("editor:*\nworkspace:*\napp:reload").setValue(s.commandAllowlist);
				t.inputEl.rows = 4;
				t.onChange(async (v) => {
					s.commandAllowlist = v;
					await save();
				});
			});

		new Setting(containerEl)
			.setName("Connect the vault's MCP servers when pi starts")
			.setDesc("pi's MCP adapter only connects to a server when something first uses it, so a new pi reports the vault's servers as disconnected with no tools. With this on, the HTTP servers in the vault's .mcp.json that are up (such as Vault as MCP) are connected right away.")
			.addToggle((t) =>
				t.setValue(s.connectMcpOnStart).onChange(async (v) => {
					s.connectMcpOnStart = v;
					await save();
				}),
			);

		new Setting(containerEl).setName("Skills and context").setHeading();

		new Setting(containerEl)
			.setName("Extra skill folders")
			.setDesc("One path per line, relative to the vault or absolute, e.g. .claude/skills. Skills in .pi/skills and .agents/skills are found by pi on its own.")
			.addTextArea((t) =>
				t.setValue(s.extraSkillPaths).onChange(async (v) => {
					s.extraSkillPaths = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Share the active note")
			.setDesc("Tell pi which note is open and what text is selected. Can be toggled per message in the composer.")
			.addToggle((t) =>
				t.setValue(s.includeActiveNote).onChange(async (v) => {
					s.includeActiveNote = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Trim old tool output")
			.setDesc("Before each reply, the model gets a one-line stand-in instead of the bulky output of tool calls from more than a few messages ago: notes read in full, fetched pages, screenshots. pi can run the tool again if it needs it. A conversation then goes longer before pi has to compact it. The session and the panel keep everything. Reload pi after changing this.")
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
			text: "Changes to the pi section and to skills take effect the next time pi starts (the panel's ↻ button, or /reload).",
		});
	}

	// Every package the panel's pi loads, from its own config folder and from the vault's .pi folder,
	// with a switch each. Off is pi's own kind of off: the package stays installed and loads nothing.
	private async renderPackages(el: HTMLElement): Promise<void> {
		const { plugin } = this;
		const s = plugin.settings;
		const header = new Setting(el).setName("Packages").setDesc("Checking…");

		const installed = await plugin.requirements.installed().catch((err: Error) => err);
		if (installed instanceof Error) return void header.setDesc(`Couldn't run pi list: ${installed.message}`);
		header.setDesc("Pi Harness only inspects installation status; it never installs, removes, or updates Pi packages. Manage packages yourself in a terminal. The switches below only control whether an installed package loads.");

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
			{ file: plugin.panelSettingsFile, label: s.isolate ? "the panel's pi" : "your pi, shared with the terminal", editable: s.isolate },
			{ file: plugin.vaultSettingsFile, label: "this vault's .pi folder", editable: true },
		];
		for (const scope of scopes) {
			for (const entry of await readPackageEntries(scope.file)) {
				const source = sourceOf(entry);
				const path = installed.find((pkg) => pkg.source === source)?.path;
				const name = path ? basename(path) : source;
				const description = [source, scope.label, required.has(name) ? "recommended by Pi Harness" : null, path ? null : "not installed; manage it in a terminal"].filter(Boolean).join(" · ");
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
