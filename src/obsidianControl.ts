import { TFile, getAllTags, type App, type CachedMetadata } from "obsidian";
import type { VaultSearch } from "./search/VaultSearch";

// The Obsidian end of pi's obsidian_* tools (pi-extension/obsidian.ts): search, the metadata
// cache, property edits, the command palette. Requests arrive as a dialog request with this title
// and leave as its answer, so they never touch the network.
export const OBSIDIAN_CHANNEL = "pi-harness:obsidian";

const MAX_NOTES = 200;
const MAX_COMMANDS = 60;
const DEFAULT_SEARCH_HITS = 8;
const MAX_SEARCH_HITS = 20;

interface ObsidianRequest {
	action?: string;
	path?: string;
	tag?: string;
	prefix?: string;
	set?: Record<string, unknown>;
	remove?: string[];
	newTab?: boolean;
	query?: string;
	id?: string;
	folder?: string;
	limit?: number;
}

interface Command {
	id: string;
	name: string;
}

// Not in the public API, hence the guard: the command palette's registry.
type CommandsApp = App & { commands?: { listCommands?(): Command[]; executeCommandById?(id: string): boolean } };

// Which commands pi may run: one pattern per line, `*` for any, `editor:*` for a prefix. Empty: none.
export function commandAllowed(patterns: string, id: string): boolean {
	return patterns
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.some((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(id));
}

export class ObsidianControl {
	constructor(
		private app: App,
		private allowedCommands: () => string,
		private vaultSearch: VaultSearch,
	) {}

	// Always answers, with `{ error }` when something went wrong: pi is blocked on the reply.
	async handle(payload: string | undefined): Promise<string> {
		try {
			const request = JSON.parse(payload ?? "{}") as ObsidianRequest;
			return JSON.stringify(await this.run(request));
		} catch (err) {
			return JSON.stringify({ error: (err as Error).message || String(err) });
		}
	}

	private async run(request: ObsidianRequest): Promise<Record<string, unknown>> {
		switch (request.action) {
			case "search":
				return this.search(request.query ?? "", request.folder, request.limit);
			case "note_info":
				return this.noteInfo(this.note(request.path));
			case "tags":
				return this.tags(request.tag, request.prefix);
			case "set_properties":
				return this.setProperties(this.note(request.path), request.set ?? {}, request.remove ?? []);
			case "open":
				return this.open(request.path ?? "", Boolean(request.newTab));
			case "commands":
				return this.commands(request.query ?? "");
			case "run_command":
				return this.runCommand(request.id ?? "");
			default:
				throw new Error(`Unknown Obsidian action: ${String(request.action)}`);
		}
	}

	// A vault path, a path without .md, or a plain note name the way a wikilink would resolve it.
	private note(path: string | undefined): TFile {
		if (!path) {
			const active = this.app.workspace.getActiveFile();
			if (!active) throw new Error("No note is open in Obsidian; give a path.");
			return active;
		}
		const direct = this.app.vault.getAbstractFileByPath(path);
		if (direct instanceof TFile) return direct;
		const linked = this.app.metadataCache.getFirstLinkpathDest(path.replace(/\.md$/, ""), "");
		if (linked) return linked;
		throw new Error(`No note at ${path}.`);
	}

	private async search(query: string, folder: string | undefined, limit: number | undefined): Promise<Record<string, unknown>> {
		if (!query.trim()) throw new Error("Give some words to search for.");
		const hitLimit = Math.min(Math.max(1, Math.round(limit ?? DEFAULT_SEARCH_HITS)), MAX_SEARCH_HITS);
		const { hits, related } = await this.vaultSearch.search(query, { limit: hitLimit, folder });
		return { hits, related };
	}

	private noteInfo(file: TFile): Record<string, unknown> {
		const cache: CachedMetadata = this.app.metadataCache.getFileCache(file) ?? {};
		const { frontmatter = {} } = cache;
		const { position: _position, ...properties } = frontmatter as Record<string, unknown>;
		const rawAliases = properties.aliases ?? properties.alias;
		const aliases = Array.isArray(rawAliases) ? rawAliases.map(String) : rawAliases ? [String(rawAliases)] : [];
		const { resolvedLinks, unresolvedLinks } = this.app.metadataCache;
		const backlinks = Object.entries(resolvedLinks)
			.filter(([, targets]) => file.path in targets)
			.map(([path, targets]) => ({ path, count: targets[file.path] }))
			.sort((a, b) => a.path.localeCompare(b.path));
		return {
			path: file.path,
			frontmatter: properties,
			aliases,
			tags: getAllTags(cache) ?? [],
			headings: (cache.headings ?? []).map((h) => ({ level: h.level, heading: h.heading })),
			links: Object.keys(resolvedLinks[file.path] ?? {}).sort(),
			unresolved: Object.keys(unresolvedLinks[file.path] ?? {}).sort(),
			backlinks,
		};
	}

	private tags(tag: string | undefined, prefix: string | undefined): Record<string, unknown> {
		const normalize = (value: string) => (value.startsWith("#") ? value : `#${value}`).toLowerCase();
		const counts = new Map<string, number>();
		const notes: string[] = [];
		const wanted = tag ? normalize(tag) : null;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = new Set((cache && getAllTags(cache)) ?? []);
			// #a/b is a note about a too.
			const withParents = new Set<string>();
			for (const t of tags) {
				const parts = t.split("/");
				for (let i = 1; i <= parts.length; i++) withParents.add(parts.slice(0, i).join("/").toLowerCase());
			}
			if (wanted) {
				if (withParents.has(wanted)) notes.push(file.path);
				continue;
			}
			for (const t of withParents) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		if (wanted) return { notes: notes.sort().slice(0, MAX_NOTES), total: notes.length };
		const filter = prefix ? normalize(prefix) : null;
		return {
			counts: [...counts]
				.filter(([t]) => !filter || t.startsWith(filter))
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([t, count]) => ({ tag: t, count })),
		};
	}

	private async setProperties(file: TFile, set: Record<string, unknown>, remove: string[]): Promise<Record<string, unknown>> {
		if (file.extension !== "md") throw new Error(`${file.path} is not a note.`);
		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const key of remove) delete frontmatter[key];
			Object.assign(frontmatter, set);
		});
		// The cache catches up a moment after the write.
		await new Promise((resolve) => window.setTimeout(resolve, 150));
		const { position: _position, ...properties } = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		return { path: file.path, frontmatter: properties };
	}

	private async open(target: string, newTab: boolean): Promise<Record<string, unknown>> {
		const [path, heading] = target.split("#", 2);
		const file = this.note(path.trim());
		const linktext = heading ? `${file.path}#${heading}` : file.path;
		await this.app.workspace.openLinkText(linktext, "", newTab);
		return { opened: linktext };
	}

	private allCommands(): Command[] {
		const registry = (this.app as CommandsApp).commands;
		if (!registry?.listCommands) throw new Error("This Obsidian build doesn't expose its commands.");
		return registry.listCommands().map(({ id, name }) => ({ id, name }));
	}

	private commands(query: string): Record<string, unknown> {
		const allowed = this.allowedCommands();
		const words = query.toLowerCase().split(/\s+/).filter(Boolean);
		const matching = this.allCommands()
			.filter((c) => commandAllowed(allowed, c.id))
			.filter((c) => words.every((w) => c.id.toLowerCase().includes(w) || c.name.toLowerCase().includes(w)))
			.sort((a, b) => a.name.localeCompare(b.name));
		const note = allowed.trim() ? undefined : "The user hasn't allowed pi to run any Obsidian commands yet (Pi Harness settings → Commands pi may run).";
		return { commands: matching.slice(0, MAX_COMMANDS), total: matching.length, note };
	}

	private runCommand(id: string): Record<string, unknown> {
		if (!commandAllowed(this.allowedCommands(), id)) throw new Error(`The user hasn't allowed pi to run ${id}. They can add it under Pi Harness settings → Commands pi may run.`);
		const command = this.allCommands().find((c) => c.id === id);
		if (!command) throw new Error(`No Obsidian command with id ${id}. Look it up with obsidian_commands.`);
		const registry = (this.app as CommandsApp).commands;
		if (!registry?.executeCommandById?.(id)) throw new Error(`${command.name} can't run right now; it may need an editor or a selection.`);
		return { ran: `${command.name} (${id})` };
	}
}
