import type { Role } from "../../pi-extension/a2a/discussion";
import type { Model } from "../rpc/types";

// The automatic lineup for an A2A discussion: a model per role, each from a different provider.
// "Provider" here means who made the model, not pi's provider: resellers such as openrouter or
// github-copilot serve the same few makers' models, and two Claude models arguing is not a
// discussion between providers. The maker is read from the model id, then from pi's provider.
const MAKERS: [RegExp, string][] = [
	[/claude|anthropic/, "Anthropic"],
	[/gpt|codex|openai|^o\d/, "OpenAI"],
	[/gemini|gemma|google|antigravity/, "Google"],
	[/grok|x-ai|xai/, "xAI"],
	[/deepseek/, "DeepSeek"],
	[/kimi|moonshot|^k\d/, "Moonshot"],
	[/glm|z-ai|zhipu|zai/, "Zhipu"],
	[/qwen|qwq|alibaba/, "Alibaba"],
	[/llama|meta/, "Meta"],
	[/mistral|codestral|devstral|magistral/, "Mistral"],
	[/nova|amazon/, "Amazon"],
];

export function makerOf(model: Model): string {
	const id = model.id.toLowerCase().replace(/^~/, "");
	const provider = model.provider.toLowerCase();
	return MAKERS.find(([pattern]) => pattern.test(id))?.[1] ?? MAKERS.find(([pattern]) => pattern.test(provider))?.[1] ?? model.provider;
}

export const modelKey = (model: Model) => `${model.provider}/${model.id}`;

export interface LineupSources {
	available: Model[];
	// The user's scoped models (enabledModels), in their order: the models they chose to work with.
	scoped: Model[];
	// The model of the conversation the discussion comes from.
	current: Model | null;
	// rpiv-advisor's model ("provider/id"), the user's pick for reviewing work.
	advisor: string | undefined;
}

export type Lineup = Partial<Record<Role, Model>>;

// The referee is the advisor model when there is one: checking arguments is reviewing. The
// debaters come from the current model and the scoped list, in that order, each from a maker
// not yet in the lineup; all available models come after those. When there are fewer than three
// makers, the remaining roles share one and the proposal card says so.
export function suggestLineup(sources: LineupSources): Lineup {
	const lineup: Lineup = {};
	const advisor = sources.available.find((m) => modelKey(m) === sources.advisor);
	if (advisor) lineup.referee = advisor;

	const candidates = [...new Set([sources.current, ...sources.scoped, ...sources.available].filter((m): m is Model => m !== null))];
	const open: Role[] = (["debaterA", "debaterB", "referee"] as Role[]).filter((role) => !lineup[role]);
	const used = () => Object.values(lineup) as Model[];

	for (const role of open) {
		const makers = new Set(used().map(makerOf));
		const fresh = candidates.find((m) => !makers.has(makerOf(m)));
		const unused = candidates.find((m) => !used().includes(m));
		const pick = fresh ?? unused;
		if (pick) lineup[role] = pick;
	}
	return lineup;
}

// Roles whose models come from the same maker, for the proposal card to point out.
export function sharedMakers(lineup: Lineup): { maker: string; roles: Role[] }[] {
	const byMaker = new Map<string, Role[]>();
	for (const [role, model] of Object.entries(lineup) as [Role, Model][]) {
		const maker = makerOf(model);
		byMaker.set(maker, [...(byMaker.get(maker) ?? []), role]);
	}
	return [...byMaker].filter(([, roles]) => roles.length > 1).map(([maker, roles]) => ({ maker, roles }));
}
