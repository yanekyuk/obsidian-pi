import { Component, TFile, getAllTags, parseFrontMatterAliases, type App, type CachedMetadata } from "obsidian";
import { SearchIndex, type SearchOptions, type SearchResult } from "./SearchIndex";

// The vault's side of obsidian_search: fills a SearchIndex with the vault's notes the first time pi
// searches, then keeps it current from Obsidian's own events, so a result never describes an old
// version of a note. Nothing is indexed, and nothing is kept in memory, until pi searches.
const NOTES_READ_AT_ONCE = 50;

export class VaultSearch extends Component {
	private index = new SearchIndex();
	private built: Promise<void> | null = null;
	// Bumped on every change to a path, so a slow read can tell it has been overtaken.
	private versions = new Map<string, number>();

	constructor(private app: App) {
		super();
	}

	onload(): void {
		// "changed" comes once the metadata cache has the note's new headings, and brings its text.
		this.registerEvent(this.app.metadataCache.on("changed", (file, text, cache) => this.whenBuilt(() => this.indexNote(file, text, cache))));
		this.registerEvent(this.app.metadataCache.on("deleted", (file) => this.whenBuilt(() => this.forget(file.path))));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.whenBuilt(() => {
					this.forget(oldPath);
					if (file instanceof TFile) void this.readAndIndex(file);
				}),
			),
		);
	}

	async search(query: string, options: SearchOptions): Promise<SearchResult> {
		this.built ??= this.build();
		await this.built;
		return this.index.search(query, options, this.app.metadataCache.resolvedLinks);
	}

	private async build(): Promise<void> {
		const notes = this.app.vault.getMarkdownFiles();
		for (let i = 0; i < notes.length; i += NOTES_READ_AT_ONCE) {
			await Promise.all(notes.slice(i, i + NOTES_READ_AT_ONCE).map((note) => this.readAndIndex(note)));
		}
	}

	// Before the first search there is no index to keep current; building it reads every note fresh.
	private whenBuilt(update: () => void): void {
		if (this.built) update();
	}

	private async readAndIndex(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		const version = this.bump(file.path);
		const text = await this.app.vault.cachedRead(file);
		if (this.versions.get(file.path) !== version) return;
		this.put(file, text, this.app.metadataCache.getFileCache(file));
	}

	private indexNote(file: TFile, text: string, cache: CachedMetadata): void {
		if (file.extension !== "md") return;
		this.bump(file.path);
		this.put(file, text, cache);
	}

	private forget(path: string): void {
		this.bump(path);
		this.index.remove(path);
	}

	private put(file: TFile, text: string, cache: CachedMetadata | null): void {
		this.index.put({
			path: file.path,
			names: [file.basename, ...(parseFrontMatterAliases(cache?.frontmatter) ?? [])],
			tags: (cache && getAllTags(cache)) ?? [],
			text,
			bodyStart: cache?.frontmatterPosition?.end.offset ?? 0,
			headings: (cache?.headings ?? []).map((h) => ({ level: h.level, heading: h.heading, offset: h.position.start.offset })),
		});
	}

	private bump(path: string): number {
		const version = (this.versions.get(path) ?? 0) + 1;
		this.versions.set(path, version);
		return version;
	}
}
