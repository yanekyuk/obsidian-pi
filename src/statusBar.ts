import { setIcon, type Plugin } from "obsidian";
import type { ChatSession } from "./view/ChatSession";
import type { ChatView } from "./view/ChatView";
import { summarize } from "./view/TabSwitcher";

// What pi is up to, in Obsidian's status bar: for when the panel is closed or out of sight.
// Shows only while something is running or waiting for the user; clicking goes to that tab.
export class StatusBar {
	private el: HTMLElement;
	private iconEl: HTMLElement;
	private textEl: HTMLElement;
	private target: ChatSession | null = null;

	constructor(
		plugin: Plugin,
		private views: () => ChatView[],
		private reveal: (tab: ChatSession) => void,
	) {
		this.el = plugin.addStatusBarItem();
		this.el.addClass("pi-status-bar", "mod-clickable");
		this.iconEl = this.el.createSpan({ cls: "pi-status-bar-icon" });
		this.textEl = this.el.createSpan({ cls: "pi-status-bar-text" });
		this.el.addEventListener("click", () => {
			if (this.target) this.reveal(this.target);
		});
		this.el.hide();
	}

	refresh(): void {
		const tabs = this.views().flatMap((view) => view.allTabs());
		const summary = summarize(tabs.filter((tab) => tab.status === "working" || tab.status === "asking"));
		if (!summary) {
			this.el.hide();
			this.target = null;
			return;
		}
		this.target = tabs.find((tab) => tab.status === summary.status) ?? null;
		this.el.dataset.status = summary.status;
		this.iconEl.empty();
		setIcon(this.iconEl, summary.status === "asking" ? "message-circle-question" : "loader");
		const detail = this.target && summary.count === 1 ? this.target.title : `${summary.count} tabs`;
		this.textEl.setText(summary.status === "asking" ? `pi is asking: ${detail}` : `pi: ${detail}`);
		this.el.setAttr("aria-label", summary.label.replace("Other tabs", "Tabs"));
		this.el.show();
	}
}
