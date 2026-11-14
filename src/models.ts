import { promises as fs } from "fs";
import type { Model, ThinkingLevel } from "./rpc/types";

// pi's "scoped" models: the short list from `enabledModels` in settings.json (or --models) that
// its model selector shows first and Ctrl+P cycles through. RPC doesn't hand the list over, so
// the patterns are resolved here the way pi's model-resolver does: case-insensitive globs on
// "provider/id" or a bare id, plain patterns tried exact and then fuzzy, and a ":high" suffix
// pinning a thinking level for the model it resolves. A pattern that matches nothing pi can use
// right now comes back unavailable: its provider's package isn't installed for the panel's pi, or
// there is no login.
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// A dated snapshot id, as opposed to an alias that follows the provider's latest.
const DATED_SNAPSHOT = /-\d{8}$/;

export interface ScopedModel {
	model: Model;
	// Set only when a pattern pinned one, as in "provider/model:high".
	thinkingLevel?: ThinkingLevel;
}

export interface ScopedModels {
	models: ScopedModel[];
	// Patterns that match nothing pi can use right now.
	unavailable: string[];
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

// The suffix pi reads off a pattern. A colon that isn't followed by a level means nothing here.
function splitThinking(text: string): { base: string; thinkingLevel?: ThinkingLevel } {
	const colon = text.lastIndexOf(":");
	if (colon === -1 || !isThinkingLevel(text.slice(colon + 1))) return { base: text };
	return { base: text.slice(0, colon), thinkingLevel: text.slice(colon + 1) as ThinkingLevel };
}

// minimatch, as far as model patterns use it: * stops at the "/" in "provider/id", ** does not,
// and brackets hold a character class. pi matches case-insensitively.
function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				source += ".*";
				i++;
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else if (char === "[") {
			const end = glob.indexOf("]", i + 1);
			if (end === -1) source += "\\[";
			else {
				const set = glob.slice(i + 1, end);
				source += `[${set.startsWith("!") ? `^${set.slice(1)}` : set}]`;
				i = end;
			}
		} else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "i");
}

function fuzzyMatches(text: string, models: Model[]): Model[] {
	const lower = text.toLowerCase();
	return models.filter((model) => model.id.toLowerCase().includes(lower) || model.name?.toLowerCase().includes(lower));
}

function bestFuzzyMatch(matches: Model[]): Model | undefined {
	const aliases = matches.filter((model) => model.id.endsWith("-latest") || !DATED_SNAPSHOT.test(model.id));
	return [...(aliases.length ? aliases : matches)].sort((a, b) => b.id.localeCompare(a.id))[0];
}

// "provider/rest" when the text starts with a provider pi knows. The longest one wins, so a
// provider whose name contains another's is still found.
function providerSplit(text: string, models: Model[]): { provider: string; modelText: string } | null {
	const lower = text.toLowerCase();
	let best: { provider: string; modelText: string } | null = null;
	for (const { provider } of models) {
		const prefix = provider.trim().toLowerCase();
		if (!prefix || (best && best.provider.length >= provider.length)) continue;
		const slash = lower.indexOf("/", prefix.length);
		if (slash === -1 || lower.slice(0, slash).trim() !== prefix) continue;
		const modelText = text.slice(slash + 1).trim();
		if (modelText) best = { provider, modelText };
	}
	return best;
}

// A model named outright: by "provider/id", by the id alone, or, when fuzzy, by a piece of the
// id or name. Several providers offering one id stay several candidates, so the caller can add
// each of them the way pi does.
function selectReference(text: string, models: Model[], fuzzy: boolean): Model[] | null {
	const lower = text.toLowerCase();
	const byId = models.filter((model) => model.id.toLowerCase() === lower);
	const split = providerSplit(text, models);
	let named: Model | undefined;
	if (split) {
		const pool = models.filter((model) => model.provider === split.provider);
		const lowerModelText = split.modelText.toLowerCase();
		named =
			pool.find((model) => model.id.toLowerCase() === lowerModelText) ??
			byId.find((model) => model.provider === split.provider) ??
			(fuzzy ? bestFuzzyMatch(fuzzyMatches(split.modelText, pool)) : undefined);
	}
	const others = byId.filter((model) => model !== named);
	const candidates = named ? [named, ...others] : others;
	if (!candidates.length) return null;
	if (new Set(candidates.map((model) => model.provider)).size === 1) return [candidates[0]];
	return named ? [named] : candidates;
}

function selectFuzzy(text: string, models: Model[]): Model[] | null {
	const best = bestFuzzyMatch(fuzzyMatches(text, models));
	if (!best) return null;
	const tied = models.filter((model) => model.id === best.id);
	return new Set(tied.map((model) => model.provider)).size === 1 ? [best] : tied;
}

// The plain-pattern path: exact first, then fuzzy, then again without the ":level" suffix, which
// is how pi reads both "provider/model:high" and a colon that turned out not to be a level.
function resolvePattern(text: string, models: Model[]): { models: Model[]; thinkingLevel?: ThinkingLevel } | null {
	const exact = selectReference(text, models, true) ?? selectFuzzy(text, models);
	if (exact) return { models: exact };
	const { base, thinkingLevel } = splitThinking(text);
	if (thinkingLevel) {
		const inner = resolvePattern(base, models);
		return inner && { ...inner, thinkingLevel };
	}
	const colon = text.lastIndexOf(":");
	if (colon === -1) return null;
	return resolvePattern(text.slice(0, colon), models);
}

export function scopeModels(patterns: string[], available: Model[]): ScopedModels {
	const models: ScopedModel[] = [];
	const unavailable: string[] = [];
	const add = (found: Model[], thinkingLevel?: ThinkingLevel) => {
		for (const model of found) {
			if (!models.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id)) models.push({ model, thinkingLevel });
		}
	};
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (!pattern) continue;
		let found: Model[] | null;
		let thinkingLevel: ThinkingLevel | undefined;
		if (/[*?[]/.test(pattern)) {
			const { base, thinkingLevel: pinned } = splitThinking(pattern);
			thinkingLevel = pinned;
			// A glob that happens to name a model outright is read as one, as pi does; otherwise
			// it matches "provider/id" and the bare id.
			const exact = selectReference(base, available, false);
			const glob = globToRegExp(base);
			found = exact ?? available.filter((model) => glob.test(`${model.provider}/${model.id}`) || glob.test(model.id));
		} else {
			const resolved = resolvePattern(pattern, available);
			found = resolved?.models ?? null;
			thinkingLevel = resolved?.thinkingLevel;
		}
		if (!found?.length) {
			unavailable.push(pattern);
			continue;
		}
		add(found, thinkingLevel);
	}
	return { models, unavailable };
}

// The scope list pi would work from, given one settings file per layer: the terminal profile's,
// then the vault's own when the vault is trusted. A later layer that names enabledModels wins,
// which is how pi layers project settings over the agent directory's.
export async function readEnabledModels(...settingsFiles: string[]): Promise<string[]> {
	let patterns: string[] = [];
	for (const settingsFile of settingsFiles) {
		try {
			const enabled = (JSON.parse(await fs.readFile(settingsFile, "utf8")) as { enabledModels?: unknown }).enabledModels;
			if (Array.isArray(enabled)) patterns = enabled.filter((pattern): pattern is string => typeof pattern === "string");
		} catch {
			// A missing or unreadable layer says nothing; the ones before it stand.
		}
	}
	return patterns;
}

// `--models a,b` replaces `enabledModels` in pi, and it is read the same way here.
export function modelsFlagPatterns(extraArgs: string): string[] | null {
	// The panel splits Extra arguments on whitespace too, so the flag looks the same here.
	const tokens = extraArgs.split(/\s+/).filter(Boolean);
	const flag = "--models";
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const value = token === flag ? (tokens[i + 1] ?? null) : token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : null;
		if (value === null) continue;
		return value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
	}
	return null;
}
