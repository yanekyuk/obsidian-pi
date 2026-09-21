import { promises as fs } from "fs";
import type { Model } from "./rpc/types";

// pi's "scoped" models: the short list from `enabledModels` in settings.json (or --models) that
// its model selector shows first and Ctrl+P cycles through. RPC doesn't hand the list over, so
// the patterns are resolved here the way pi's model-resolver does.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ScopedModels {
	models: Model[];
	// Patterns that match nothing pi can use right now: a provider whose package isn't installed, or no login.
	unavailable: string[];
}

function withoutThinking(pattern: string): string {
	const colon = pattern.lastIndexOf(":");
	return colon !== -1 && THINKING_LEVELS.includes(pattern.slice(colon + 1)) ? pattern.slice(0, colon) : pattern;
}

function globToRegExp(glob: string): RegExp {
	const source = glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${source}$`, "i");
}

export function scopeModels(patterns: string[], available: Model[]): ScopedModels {
	const models: Model[] = [];
	const unavailable: string[] = [];
	const add = (found: Model[]) => found.forEach((m) => !models.includes(m) && models.push(m));
	for (const raw of patterns) {
		const pattern = withoutThinking(raw.trim());
		if (!pattern) continue;
		const lower = pattern.toLowerCase();
		let found: Model[];
		if (/[*?[]/.test(pattern)) {
			const re = globToRegExp(pattern);
			found = available.filter((m) => re.test(`${m.provider}/${m.id}`) || re.test(m.id));
		} else {
			const exact = available.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower || m.id.toLowerCase() === lower);
			// A partial name stands for one model; the plain alias is usually the shortest id.
			const partial = available.filter((m) => m.id.toLowerCase().includes(lower) || (m.name ?? "").toLowerCase().includes(lower)).sort((a, b) => a.id.length - b.id.length);
			found = exact.length ? exact : partial.slice(0, 1);
		}
		if (found.length) add(found);
		else unavailable.push(pattern);
	}
	return { models, unavailable };
}

export async function readEnabledModels(settingsFile: string): Promise<string[]> {
	try {
		const patterns = (JSON.parse(await fs.readFile(settingsFile, "utf8")) as { enabledModels?: unknown }).enabledModels;
		return Array.isArray(patterns) ? patterns.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}
