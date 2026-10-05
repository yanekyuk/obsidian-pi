import { setIcon, type App } from "obsidian";
import { DEFAULT_ROUNDS, MAX_ROUNDS, MIN_ROUNDS, ROLE_LABELS, type DiscussionPlan, type Proposal, type Role } from "../../pi-extension/a2a/discussion";
import type { ScopedModels } from "../models";
import type { Model } from "../rpc/types";
import type { DialogForm } from "../view/InlineDialogs";
import { ModelPicker } from "../view/modals";
import { makerOf, modelKey, sharedMakers, type Lineup } from "./lineup";

// The card that proposes an A2A discussion: the question and the two stances as pi framed
// them, and the suggested model per role. Everything can be changed before starting; "Not now"
// declines, and pi carries on without the discussion.

export interface ModelChoices {
	available: Model[];
	scoped: ScopedModels;
	// The model picker's last view (all models or the scoped list), shared with the composer's.
	showAll: boolean;
	onShowAllChange(showAll: boolean): void;
}

const ROLE_HINTS: Record<Role, string> = {
	debaterA: "Argues for the first stance",
	debaterB: "Argues for the opposite stance",
	referee: "Checks both sides' arguments; takes no side",
};

export function lineupCard(app: App, proposal: Proposal, suggested: Lineup, choices: ModelChoices): DialogForm {
	return {
		header: "A2A discussion",
		icon: "swords",
		render(card, answer) {
			const lineup: Lineup = { ...suggested };
			const form = card.createDiv({ cls: "pi-a2a-form" });

			const topic = field(form, "Question").createEl("textarea", { cls: "pi-dialog-editor pi-a2a-topic" });
			topic.value = proposal.topic;

			const stances: Partial<Record<Role, HTMLTextAreaElement>> = {};
			const modelButtons: Partial<Record<Role, HTMLButtonElement>> = {};
			for (const role of ["debaterA", "debaterB", "referee"] as Role[]) {
				const row = field(form, ROLE_LABELS[role], ROLE_HINTS[role]);
				if (role !== "referee") {
					const stance = row.createEl("textarea", { cls: "pi-dialog-editor pi-a2a-stance" });
					stance.value = role === "debaterA" ? proposal.stanceA : proposal.stanceB;
					stances[role] = stance;
				}
				const button = row.createEl("button", { cls: "pi-a2a-model" });
				button.addEventListener("click", () => pickModel(role));
				modelButtons[role] = button;
			}

			const settingsRow = form.createDiv({ cls: "pi-a2a-rounds" });
			settingsRow.createSpan({ text: "Rounds" });
			const rounds = settingsRow.createEl("select", { cls: "dropdown" });
			for (let n = MIN_ROUNDS; n <= MAX_ROUNDS; n++) rounds.createEl("option", { text: String(n), value: String(n) });
			rounds.value = String(DEFAULT_ROUNDS);
			settingsRow.createSpan({ cls: "pi-a2a-note", text: "Each round: A argues, B answers, the referee checks both." });

			const warnings = form.createDiv({ cls: "pi-a2a-warnings" });
			const actions = card.createDiv({ cls: "pi-dialog-actions" });
			const start = actions.createEl("button", { text: "Start discussion", cls: "mod-cta" });
			actions.createEl("button", { text: "Not now" }).addEventListener("click", () => answer({ cancelled: true }));

			const refresh = () => {
				for (const [role, button] of Object.entries(modelButtons) as [Role, HTMLButtonElement][]) {
					const model = lineup[role];
					button.empty();
					setIcon(button.createSpan({ cls: "pi-icon" }), "cpu");
					button.createSpan({ text: model ? modelKey(model) : "Choose a model…" });
					if (model) button.createSpan({ cls: "pi-a2a-maker", text: makerOf(model) });
				}
				renderWarnings(warnings, lineup, proposal.webSearch);
				start.disabled = !lineup.debaterA || !lineup.debaterB || !lineup.referee;
			};

			const pickModel = (role: Role) => {
				new ModelPicker(app, choices.available, choices.scoped, lineup[role] ?? null, choices.showAll, (model) => {
					lineup[role] = model;
					refresh();
				}, (showAll) => {
					choices.showAll = showAll;
					choices.onShowAllChange(showAll);
				}).open();
			};

			start.addEventListener("click", () => {
				const { debaterA, debaterB, referee } = lineup;
				if (!debaterA || !debaterB || !referee) return;
				const plan: DiscussionPlan = {
					topic: topic.value.trim() || proposal.topic,
					stanceA: stances.debaterA?.value.trim() || proposal.stanceA,
					stanceB: stances.debaterB?.value.trim() || proposal.stanceB,
					context: proposal.context,
					rounds: Number(rounds.value),
					models: { debaterA: modelKey(debaterA), debaterB: modelKey(debaterB), referee: modelKey(referee) },
				};
				answer({ value: JSON.stringify(plan) });
			});

			refresh();
			return start;
		},
	};
}

function field(parent: HTMLElement, label: string, hint?: string): HTMLElement {
	const row = parent.createDiv({ cls: "pi-a2a-field" });
	const head = row.createDiv({ cls: "pi-a2a-label" });
	head.createSpan({ text: label });
	if (hint) head.createSpan({ cls: "pi-a2a-note", text: hint });
	return row;
}

function renderWarnings(el: HTMLElement, lineup: Lineup, webSearch: boolean): void {
	el.empty();
	for (const { maker, roles } of sharedMakers(lineup)) {
		el.createDiv({ cls: "pi-a2a-warning", text: `${roles.map((r) => ROLE_LABELS[r]).join(" and ")} are ${roles.length === 2 ? "both" : "all"} ${maker} models. Pick models from different providers for independent views.` });
	}
	if (!webSearch) {
		el.createDiv({ cls: "pi-a2a-warning", text: "pi has no web_search tool, so the agents will argue from what they already know and the referee can't check facts. Install rpiv-web-tools (Settings → Extensions)." });
	}
}
