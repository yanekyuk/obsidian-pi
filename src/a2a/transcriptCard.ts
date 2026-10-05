import { MarkdownRenderer } from "obsidian";
import { ROLE_LABELS, type DiscussionDetails, type Turn } from "../../pi-extension/a2a/discussion";
import type { ToolResult } from "../rpc/types";
import type { RenderHost } from "../view/blocks";
import type { ToolRenderer } from "../view/toolRenderers";

// The a2a_discussion tool card: the lineup, then every turn as it comes in, each with what the
// agent searched for. The same card shows a live discussion and one reopened from the session.

// A discussion that was stopped or failed to start is an error result, which pi saves with empty
// details: only a record with turns is a discussion.
function detailsOf(result?: ToolResult): DiscussionDetails | null {
	const details = result?.details as Partial<DiscussionDetails> | null | undefined;
	return details && Array.isArray(details.turns) ? (details as DiscussionDetails) : null;
}

export const a2aDiscussion: ToolRenderer = {
	icon: "swords",
	label: "A2A discussion",
	summary(args, result) {
		const details = detailsOf(result);
		const topic = details?.plan?.topic ?? (typeof args.topic === "string" ? args.topic : "");
		if (!details) return topic;
		if (details.status === "declined") return `${topic} · declined`;
		if (details.status === "failed") return `${topic} · stopped early`;
		const turn = details.turns[details.turns.length - 1];
		if (details.status === "running" && turn && details.plan) return `${topic} · round ${turn.round} of ${details.plan.rounds}, ${ROLE_LABELS[turn.role]}`;
		return topic;
	},
	body(el, result, host) {
		const details = detailsOf(result);
		if (!details?.plan) return false;
		const { plan } = details;
		const root = el.createDiv({ cls: "pi-tool-rich pi-a2a" });

		const lineup = root.createDiv({ cls: "pi-a2a-lineup" });
		lineupRow(lineup, "Debater A", plan.models.debaterA, plan.stanceA);
		lineupRow(lineup, "Debater B", plan.models.debaterB, plan.stanceB);
		lineupRow(lineup, "Referee", plan.models.referee, "Checks whether the arguments make sense");

		for (const turn of details.turns) renderTurn(root, turn, host);
		return true;
	},
};

function lineupRow(parent: HTMLElement, role: string, model: string, stance: string): void {
	const row = parent.createDiv({ cls: "pi-a2a-lineup-row" });
	row.createSpan({ cls: "pi-a2a-role", text: role });
	row.createSpan({ cls: "pi-a2a-maker", text: model });
	row.createSpan({ cls: "pi-a2a-stance", text: stance });
}

function renderTurn(parent: HTMLElement, turn: Turn, host: RenderHost): void {
	const el = parent.createDiv({ cls: "pi-a2a-turn", attr: { "data-role": turn.role } });
	const head = el.createDiv({ cls: "pi-a2a-turn-head" });
	head.createSpan({ cls: "pi-a2a-role", text: `Round ${turn.round} · ${ROLE_LABELS[turn.role]}` });
	head.createSpan({ cls: "pi-a2a-maker", text: turn.model });
	if (turn.searches.length) el.createDiv({ cls: "pi-a2a-searches", text: `Searched: ${turn.searches.join(" · ")}` });

	if (turn.status === "failed") {
		el.createDiv({ cls: "pi-msg-notice is-error", text: turn.error ?? "This turn failed." });
		return;
	}
	if (!turn.text.trim()) {
		el.createDiv({ cls: "pi-a2a-waiting", text: turn.role === "referee" ? "Checking the arguments…" : "Preparing an argument…" });
		return;
	}
	const text = el.createDiv({ cls: "markdown-rendered" });
	void MarkdownRenderer.render(host.app, turn.text, text, "", host.component).then(() => host.onContentChanged());
}
