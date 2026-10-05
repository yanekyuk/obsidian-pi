// An A2A discussion: two agents argue opposite stances on a question, a referee checks whether
// their arguments hold up. This file owns the discussion itself (who speaks when, what each
// agent is told, how the transcript reads) and the shapes that cross between the pi extension
// (index.ts) and the Pi Harness panel. It imports nothing from pi or Obsidian, so both sides
// and the tests can use it.

// The extension asks the panel for a lineup on this dialog channel, like obsidian.ts does.
export const A2A_CHANNEL = "pi-harness:a2a";

export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 4;
export const DEFAULT_ROUNDS = 2;

export type Role = "debaterA" | "debaterB" | "referee";

export const ROLE_LABELS: Record<Role, string> = {
	debaterA: "Debater A",
	debaterB: "Debater B",
	referee: "Referee",
};

// What the main agent proposes; the panel shows it to the user with a suggested lineup.
export interface Proposal {
	topic: string;
	stanceA: string;
	stanceB: string;
	context?: string;
	// Whether pi has web_search, which the agents are meant to use.
	webSearch: boolean;
}

// What the user agreed to: the proposal as they left it, with a model ("provider/id") per role.
export interface DiscussionPlan {
	topic: string;
	stanceA: string;
	stanceB: string;
	context?: string;
	rounds: number;
	models: Record<Role, string>;
}

export interface Turn {
	round: number;
	role: Role;
	model: string;
	status: "speaking" | "done" | "failed";
	text: string;
	// What the agent looked up with web_search during this turn.
	searches: string[];
	error?: string;
}

export interface DiscussionDetails {
	status: "running" | "done" | "failed" | "declined";
	plan?: DiscussionPlan;
	turns: Turn[];
}

// One agent's turn: its instructions and what it is asked now. Speaking may take several model
// calls (web searches in between); the result is what the agent finally says.
export interface TurnRequest {
	role: Role;
	model: string;
	systemPrompt: string;
	prompt: string;
}

export interface TurnProgress {
	// Text so far, while the agent is still writing.
	text?: string;
	search?: string;
}

export type Speaker = (request: TurnRequest, onProgress: (progress: TurnProgress) => void, signal?: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------- the discussion

// Every round, A speaks, then B answers, then the referee checks both. The debaters see the
// referee's checks from the rounds before, so a failed argument has to be fixed or dropped.
// The referee's check in the last round ends with its assessment of the whole discussion.
// A turn that fails ends the discussion; what was said until then is kept.
export async function runDiscussion(plan: DiscussionPlan, speak: Speaker, onChange: (details: DiscussionDetails) => void, signal?: AbortSignal): Promise<DiscussionDetails> {
	const details: DiscussionDetails = { status: "running", plan, turns: [] };
	const order: Role[] = ["debaterA", "debaterB", "referee"];

	for (let round = 1; round <= plan.rounds; round++) {
		for (const role of order) {
			if (signal?.aborted) throw new Error("The A2A discussion was stopped.");
			const turn: Turn = { round, role, model: plan.models[role], status: "speaking", text: "", searches: [] };
			const request: TurnRequest = { role, model: turn.model, systemPrompt: systemPromptFor(role, plan), prompt: promptFor(role, round, plan, details.turns) };
			details.turns.push(turn);
			onChange(details);

			try {
				turn.text = await speak(
					request,
					(progress) => {
						if (progress.text !== undefined) turn.text = progress.text;
						if (progress.search) turn.searches.push(progress.search);
						onChange(details);
					},
					signal,
				);
				turn.status = "done";
			} catch (err) {
				if (signal?.aborted) throw new Error("The A2A discussion was stopped.");
				turn.status = "failed";
				turn.error = (err as Error).message || String(err);
				details.status = "failed";
				onChange(details);
				return details;
			}
			onChange(details);
		}
	}

	details.status = "done";
	onChange(details);
	return details;
}

// ---------------------------------------------------------------- what each agent is told

// Models drift toward the safe consensus answer: balanced, hedged, meeting in the middle. That
// makes for a dull debate and hides the arguments the user asked to hear, so the debaters are told
// to commit and the referee to judge soundness, not conventionality. Neither is asked to defend
// what has been shown false: a concession the evidence forces is still made, and said plainly.

const EVIDENCE_RULES = `Evidence:
- Search with web_search before you make your case, and again for any fact you are not sure of. Read a page with web_fetch before you rely on it.
- Cite only pages that your searches returned or that you fetched, as inline Markdown links. Never invent a source, a quote or a number, and never cite a link from memory.
- Mark what kind of claim you make: a verified fact (cite it), an inference (show the step), a speculation, or a value judgment.`;

function systemPromptFor(role: Role, plan: DiscussionPlan): string {
	if (role === "referee") {
		return `You are the referee of a structured debate between two AI agents. You do not take a side, you do not argue, and you do not say who is winning.

Your only job is to check whether each argument really makes sense:
- Factual claims: are they true? Verify the ones that matter with web_search and web_fetch, and say what you found.
- Sources: does a cited source exist and say what the debater claims it says?
- Reasoning: does the conclusion follow from the premises? Name fallacies (straw man, false dichotomy, cherry-picking, appeal to authority, appeal to consensus, slippery slope, moving the goalposts) where they occur.
- Engagement: does the argument answer what the other side actually said?

Judge soundness, not conventionality:
- An unconventional or uncomfortable conclusion, or one that goes against the consensus, is not a defect. "Most experts disagree" is not a refutation; say what is wrong with the argument itself.
- A new idea may have no direct evidence yet. Then say so, judge whether the reasoning and the analogies it rests on hold, and mark the uncertainty rather than dismissing it.
- Weigh trade-offs against the goals in the question and background, not against what people usually prefer.
- Apply the same standard to both sides, the conventional one included: a mainstream claim still needs support.
- Point out hedging: a debater who retreats to a vaguer claim, or drifts toward the other side's position without saying what forced it, has weakened their case.
- Never propose a compromise or a middle ground of your own.

Go through each debater's argument point by point. Give every point a verdict, **Holds**, **Weak** or **Fails**, with a one or two sentence reason. Do not add arguments of your own for either stance. Be brief and precise; reply in Markdown.`;
	}
	const stance = role === "debaterA" ? plan.stanceA : plan.stanceB;
	const other = role === "debaterA" ? plan.stanceB : plan.stanceA;
	return `You are ${ROLE_LABELS[role]} in a structured debate with another AI agent. A referee checks every argument for factual accuracy and sound reasoning, and does not reward caution or consensus.

Your stance: ${stance}
The other side's stance: ${other}

Make the strongest case for your stance, not the most agreeable one. You are here to argue a position, not to find common ground:
- State a sharp thesis and commit to it. Say what follows if you are right: the mechanism, the consequences, what should change.
- Follow the argument where it leads, even to an unconventional, uncomfortable or unpopular conclusion, as long as you can support it. Don't round it down to what sounds generally acceptable.
- Attack the other side's strongest premise directly, not a weak version of it.
- No performative balance: no "both sides have merit", no "it depends", no generic caveats, and no hybrid or middle-ground proposal.
- Concede a point only when evidence or reasoning forces it, and then say exactly what it changes and why your stance still stands. Don't defend a claim the referee showed to be false: drop it and make a better one.

${EVIDENCE_RULES}

Stay under 450 words, in Markdown, with no preamble.`;
}

function promptFor(role: Role, round: number, plan: DiscussionPlan, turnsSoFar: Turn[]): string {
	const background = [`# Question\n\n${plan.topic}`, plan.context ? `# Background from the user's conversation\n\n${plan.context}` : "", `# Stances\n\n- Debater A: ${plan.stanceA}\n- Debater B: ${plan.stanceB}`];
	const said = turnsSoFar.filter((t) => t.status === "done");
	if (said.length) background.push(`# The discussion so far\n\n${said.map(turnMarkdown).join("\n\n")}`);
	return [...background.filter(Boolean), `# Your task\n\n${taskFor(role, round, plan.rounds)}`].join("\n\n");
}

function taskFor(role: Role, round: number, rounds: number): string {
	if (role === "referee") {
		const check = `Check the arguments both debaters made in round ${round} of ${rounds}.`;
		if (round < rounds) return check;
		return `${check} This was the last round, so finish with a section "## Assessment" covering the whole discussion: the arguments that held up under checking, the ones that failed and why, and the questions that remain open. Where both sides kept arguments that hold, say so and leave the disagreement standing; do not average them into a compromise, and do not declare a winner.`;
	}
	if (round === 1 && role === "debaterA") return `Round 1 of ${rounds}: search for evidence, then make your opening argument.`;
	if (round === 1) return `Round 1 of ${rounds}: search for evidence, then make your opening argument and take apart Debater A's.`;
	const last = round === rounds ? " This is the last round: close with your thesis in its strongest form that survived the checks, not a softer one." : "";
	return `Round ${round} of ${rounds}: rebut the other side's latest argument, and fix or drop what the referee found weak in yours.${last}`;
}

// ---------------------------------------------------------------- the transcript

function turnMarkdown(turn: Turn): string {
	return `## Round ${turn.round} · ${ROLE_LABELS[turn.role]} (${turn.model})\n\n${turn.text.trim()}`;
}

// The discussion as the main agent receives it.
export function discussionMarkdown(details: DiscussionDetails): string {
	const plan = details.plan;
	if (!plan) return "";
	const head = `# A2A discussion: ${plan.topic}\n\n- Debater A (${plan.models.debaterA}): ${plan.stanceA}\n- Debater B (${plan.models.debaterB}): ${plan.stanceB}\n- Referee: ${plan.models.referee}`;
	const turns = details.turns.filter((t) => t.status === "done").map(turnMarkdown);
	const failed = details.turns.find((t) => t.status === "failed");
	const ending = failed ? `**The discussion stopped early:** ${ROLE_LABELS[failed.role]} (${failed.model}) failed in round ${failed.round}: ${failed.error}` : "";
	return [head, ...turns, ending].filter(Boolean).join("\n\n");
}
