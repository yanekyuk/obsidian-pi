// A2A discussions: two agents from different providers argue opposite stances on a question
// while a referee checks whether their arguments hold up; all three can search the web. Part of
// the Pi Harness plugin, which loads this with `pi -e` when "Let pi hold A2A discussions" is on.
//
// pi proposes a discussion by calling a2a_discussion (or the user asks for one with /a2a). The
// panel shows the proposal with an automatically chosen model per role, which the user can
// change, and answers on the dialog channel with the lineup, or nothing if the user declines.
// The discussion then runs here (discussion.ts), each turn as a one-off pi run (agentTurn.ts).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { speakWithPi, type TurnUsage } from "./agentTurn";
import { A2A_CHANNEL, MAX_ROUNDS, MIN_ROUNDS, ROLE_LABELS, discussionMarkdown, runDiscussion, type DiscussionDetails, type DiscussionPlan, type Proposal, type Speaker } from "./discussion";

// The panel re-renders the whole card on each update, so streamed text goes out at most this often.
const UPDATE_INTERVAL_MS = 1000;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "a2a_discussion",
		label: "A2A discussion",
		description:
			"Propose an A2A discussion to the user: two AI agents from different providers argue two opposing stances on a question over a few rounds, and a referee from a third provider checks whether each argument really makes sense (facts, sources, reasoning) without taking a side. All three can search the web. The user sees the proposal, can change the stances and the models, and can decline. Returns the full discussion with the referee's checks and closing assessment. Takes minutes.",
		promptSnippet: "Propose a debate between two agents from different providers, checked by a referee, on a contested question",
		promptGuidelines: [
			"When the user weighs a decision or question on which informed people genuinely disagree (a trade-off, a contested claim, a strategy choice) and a one-sided answer from you would hide that, suggest an A2A discussion by calling a2a_discussion. The user reviews and can decline the proposal, so the call itself is the suggestion.",
			"Don't use a2a_discussion for questions with a clear factual answer or for tasks; use it where arguing both sides adds something the user needs.",
			"For a2a_discussion, find where the real disagreement lies and frame stanceA and stanceB as two sharp, committed theses with different consequences, one sentence each. Where a serious unconventional position exists, let one side take it rather than offering two mild versions of the usual advice. Don't set up a compromise as either stance, and don't invent controversy about settled facts.",
			"Put everything the agents need from this conversation or the vault into the context parameter of a2a_discussion: they see nothing else.",
			"After an A2A discussion, tell the user what the referee found: which arguments held up, which failed and why, and what stays open. Keep a disagreement that survived the checks as a disagreement, and give a strong minority argument its due, instead of averaging both sides into a middle-ground recommendation. Give your own view only on top of that; a hybrid answer needs its own justification and is not the default ending.",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "The question to discuss, stated neutrally." }),
			stanceA: Type.String({ description: "The thesis Debater A argues for, in one sentence: committed, not hedged." }),
			stanceB: Type.String({ description: "The opposing thesis Debater B argues for, in one sentence: committed, not hedged, and not a compromise." }),
			context: Type.Optional(Type.String({ description: "Background the agents need: facts, constraints and goals from the conversation or the user's notes." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const proposal: Proposal = { ...params, webSearch: pi.getAllTools().some((tool) => tool.name === "web_search") };
			const plan = await askForLineup(ctx, proposal, signal);
			if (!plan) {
				const declined: DiscussionDetails = { status: "declined", turns: [] };
				return { content: [{ type: "text" as const, text: "The user declined the A2A discussion. Carry on without it." }], details: declined };
			}

			const usage = emptyUsage();
			const speak: Speaker = (request, onProgress, turnSignal) => speakWithPi(request, ctx.cwd, onProgress, (turnUsage) => addUsage(usage, turnUsage), turnSignal);
			const report = throttled((details: DiscussionDetails) => onUpdate?.({ content: [{ type: "text", text: progressLine(details) }], details: structuredClone(details) }));

			const details = await runDiscussion(plan, speak, report, signal);
			return { content: [{ type: "text" as const, text: discussionMarkdown(details) }], details, usage };
		},
	});

	pi.registerCommand("a2a", {
		description: "Start an A2A discussion: two agents from different providers argue a question, a referee checks their arguments",
		handler: async (args, ctx) => {
			const topic = args.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /a2a <question to discuss>", "warning");
				return;
			}
			// pi frames the stances from what it knows of the conversation, then proposes the discussion.
			const request = `Set up an A2A discussion on this question: ${topic}\n\nFind where the real disagreement lies and frame two sharp, genuinely opposed theses; if a serious unconventional position exists, give it to one side instead of two mild versions of the usual advice. Gather the context the agents need from our conversation, and call a2a_discussion.`;
			pi.sendUserMessage(request, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});
}

// The panel answers with the lineup the user started, nothing when they declined, or `{ error }`.
async function askForLineup(ctx: ExtensionContext, proposal: Proposal, signal?: AbortSignal): Promise<DiscussionPlan | null> {
	if (!ctx.hasUI) throw new Error("An A2A discussion needs the Pi Harness panel, where the user chooses the models.");
	const answer = await ctx.ui.input(A2A_CHANNEL, JSON.stringify(proposal), { signal });
	if (answer === undefined) return null;
	const reply = JSON.parse(answer) as DiscussionPlan & { error?: string };
	if (reply.error) throw new Error(`The panel couldn't propose the discussion: ${reply.error}`);
	return checkedPlan(reply);
}

function checkedPlan(plan: DiscussionPlan): DiscussionPlan {
	for (const role of Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]) {
		if (!plan.models?.[role]) throw new Error(`The lineup has no model for the ${ROLE_LABELS[role]}.`);
	}
	if (!plan.topic?.trim() || !plan.stanceA?.trim() || !plan.stanceB?.trim()) throw new Error("The discussion needs a question and two stances.");
	const rounds = Math.round(Number(plan.rounds));
	return { ...plan, rounds: Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Number.isFinite(rounds) ? rounds : MIN_ROUNDS)) };
}

// Shown while the discussion runs, in place of the result.
function progressLine(details: DiscussionDetails): string {
	const turn = details.turns[details.turns.length - 1];
	if (!turn || !details.plan) return "Starting the A2A discussion…";
	return `Round ${turn.round} of ${details.plan.rounds}: ${ROLE_LABELS[turn.role]} (${turn.model}) ${turn.role === "referee" ? "is checking the arguments" : "is speaking"}…`;
}

// Passes on every new turn and every finished one at once; streamed text in between at most once per interval.
function throttled(send: (details: DiscussionDetails) => void): (details: DiscussionDetails) => void {
	let lastSent = 0;
	let lastShape = "";
	return (details) => {
		const shape = details.turns.map((t) => `${t.status}:${t.searches.length}`).join(",") + details.status;
		const now = Date.now();
		if (shape === lastShape && now - lastSent < UPDATE_INTERVAL_MS) return;
		lastShape = shape;
		lastSent = now;
		send(details);
	};
}

// The agents' model calls count toward the session's totals.
function emptyUsage(): TurnUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(total: TurnUsage, turn: TurnUsage): void {
	total.input += turn.input ?? 0;
	total.output += turn.output ?? 0;
	total.cacheRead += turn.cacheRead ?? 0;
	total.cacheWrite += turn.cacheWrite ?? 0;
	total.totalTokens += turn.totalTokens ?? 0;
	for (const key of Object.keys(total.cost) as (keyof TurnUsage["cost"])[]) total.cost[key] += turn.cost?.[key] ?? 0;
}
