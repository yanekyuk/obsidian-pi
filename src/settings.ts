import { App, PluginSettingTab, Setting } from "obsidian";
import type PiAgentPlugin from "./main";
import { basename } from "path";
import { REQUIRED_PACKAGES, SKILLS_PACKAGE, findRequired } from "./requirements";

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
	manageExtensions: boolean;
	autoUpdate: boolean;
	// The user has answered the offer to install missing extensions, either way.
	extensionsOfferAnswered: boolean;
	lastExtensionUpdate: number;
	hiddenTodos: Record<string, string[]>;
	connectMcpOnStart: boolean;
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
	// Both download and run code from npm, so both wait for the user to say yes.
	manageExtensions: false,
	autoUpdate: false,
	extensionsOfferAnswered: false,
	lastExtensionUpdate: 0,
	hiddenTodos: {},
	connectMcpOnStart: true,
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

		new Setting(containerEl).setName("Extensions").setHeading();

		new Setting(containerEl)
			.setName("Install missing pi extensions")
			.setDesc(`The panel is built around ${REQUIRED_PACKAGES.join(", ")}, and around Steph Ango's Obsidian skills (${SKILLS_PACKAGE.source.replace("git:", "")}), which pi installs from his repository when no Obsidian skills are found. When this is on, missing ones are installed through pi (pi install, user scope) before pi starts. A copy you installed from a local folder or git counts as installed.`)
			.addToggle((t) =>
				t.setValue(s.manageExtensions).onChange(async (v) => {
					s.manageExtensions = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Keep pi up to date")
			.setDesc("Runs `pi update --all` once a day: pi itself and every installed package, not only the required ones. It waits until pi is idle in every tab, and tells you when something changed so you can reload. Off unless you turn it on: it downloads and runs new code from npm without asking each time.")
			.addToggle((t) =>
				t.setValue(s.autoUpdate).onChange(async (v) => {
					s.autoUpdate = v;
					await save();
				}),
			);

		const status = new Setting(containerEl).setName("Installed").setDesc("Checking…");
		status.addButton((b) => b.setButtonText("Update now").onClick(() => void this.plugin.updateExtensions(true).then(() => this.display())));
		void this.plugin.requirements
			.installed()
			.then((installed) => {
				const found = findRequired(installed);
				const skills = installed.find((pkg) => basename(pkg.path) === SKILLS_PACKAGE.name);
				const lines = [...found].map(([name, pkg]) => `${name}: ${pkg ? pkg.source : "missing"}`);
				lines.push(`${SKILLS_PACKAGE.name}: ${skills ? skills.source : "not installed through pi (skills in the vault's .pi/skills count too)"}`);
				status.setDesc(createFragment((f) => lines.forEach((line) => f.createDiv({ text: line }))));
			})
			.catch((err: Error) => status.setDesc(`Couldn't run pi list: ${err.message}`));

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
}
