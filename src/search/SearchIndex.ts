// Ranked keyword search over the vault, one heading section at a time: the engine behind pi's
// obsidian_search tool. It knows nothing of Obsidian. VaultSearch feeds it notes as they change
// and hands it the link graph when a search runs, so this file can be tested on its own.
//
// Words are compared without case or accents (Üzüm = uzum, ışık = isik), so a note is found
// however its words were typed.
//
// Ranking, in order:
// 1. BM25 over sections. A match in the note's name, aliases, tags or the section's headings
//    counts as several matches in its text.
// 2. A query word also matches longer words that start with it (plan → planning), for a little less.
// 3. Sections that match more of the query's words win: the score is scaled by the share matched.
// 4. Notes that link to each other among the best results get a small boost, and notes linked
//    with several of the final results are suggested as related.

/** A note as the index needs it. Offsets are into `text`, the whole file. */
export interface NoteForIndex {
	path: string;
	/** What the note goes by: its file name and aliases. */
	names: string[];
	tags: string[];
	text: string;
	/** Where the body starts, after the properties block. */
	bodyStart: number;
	headings: { level: number; heading: string; offset: number }[];
}

/** Obsidian's resolved links: source path → target path → number of links. */
export type LinkGraph = Record<string, Record<string, number>>;

export interface SearchOptions {
	limit: number;
	/** Only notes in this folder or below it. */
	folder?: string;
}

export interface SearchHit {
	path: string;
	/** The section's heading and the headings above it, outermost first. Empty before the first heading. */
	headings: string[];
	/** 1-based, inclusive: the lines to read for the whole section. */
	startLine: number;
	endLine: number;
	snippet: string;
}

export interface RelatedNote {
	path: string;
	/** How many of the hits' notes it links to or is linked from. */
	linkedHits: number;
}

export interface SearchResult {
	hits: SearchHit[];
	related: RelatedNote[];
}

interface Section {
	path: string;
	headings: string[];
	startLine: number;
	endLine: number;
	text: string;
	termCounts: Map<string, number>;
	length: number;
}

// BM25's usual constants: how fast repeated words stop adding up, and how much a long section is discounted.
const K1 = 1.2;
const B = 0.75;
// A word in the note's names, tags or headings counts this many times.
const HEADER_WEIGHT = 3;
// Query words this long or longer also match words that start with them, at this weight.
const MIN_PREFIX_CHARS = 3;
const PREFIX_MATCH_WEIGHT = 0.7;
// Long sections are split at blank lines into pieces about this big, so a hit points at a readable part.
const MAX_SECTION_CHARS = 2000;
// Of the best results, how many take part in the link boost (as a multiple of the limit), and by how much.
const LINK_POOL_FACTOR = 3;
const LINK_BOOST_PER_NOTE = 0.1;
const MAX_LINK_BOOSTS = 3;
const MAX_HITS_PER_NOTE = 2;
const MAX_RELATED = 5;
const MIN_LINKED_HITS_FOR_RELATED = 2;
const SNIPPET_CHARS = 240;
const SNIPPET_LEAD_CHARS = 60;

export class SearchIndex {
	private notes = new Map<string, Section[]>();
	private postings = new Map<string, Set<Section>>();
	private sectionCount = 0;
	private totalLength = 0;

	/** Adds a note, or replaces what the index had for it. */
	put(note: NoteForIndex): void {
		this.remove(note.path);
		const sections = sectionsOf(note);
		for (const section of sections) {
			for (const term of section.termCounts.keys()) {
				let holders = this.postings.get(term);
				if (!holders) this.postings.set(term, (holders = new Set()));
				holders.add(section);
			}
			this.sectionCount++;
			this.totalLength += section.length;
		}
		this.notes.set(note.path, sections);
	}

	remove(path: string): void {
		const sections = this.notes.get(path);
		if (!sections) return;
		for (const section of sections) {
			for (const term of section.termCounts.keys()) {
				const holders = this.postings.get(term);
				holders?.delete(section);
				if (holders?.size === 0) this.postings.delete(term);
			}
			this.sectionCount--;
			this.totalLength -= section.length;
		}
		this.notes.delete(path);
	}

	search(query: string, options: SearchOptions, links: LinkGraph): SearchResult {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0) return { hits: [], related: [] };

		const ranked = this.scoreSections(queryTerms, folderPrefix(options.folder));
		boostLinkedNotes(ranked.slice(0, options.limit * LINK_POOL_FACTOR), links);
		ranked.sort((a, b) => b.score - a.score);

		const best = bestPerNote(ranked, options.limit);
		const hits = best.map((section) => ({
			path: section.path,
			headings: section.headings,
			startLine: section.startLine,
			endLine: section.endLine,
			snippet: snippetOf(section.text, queryTerms),
		}));
		return { hits, related: relatedNotes(new Set(best.map((section) => section.path)), links) };
	}

	private scoreSections(queryTerms: string[], folder: string | null): { section: Section; score: number }[] {
		const averageLength = this.totalLength / Math.max(1, this.sectionCount);
		const totals = new Map<Section, { score: number; matchedTerms: number }>();

		for (const queryTerm of queryTerms) {
			// Each query word scores once per section, by its best-matching word there.
			const best = new Map<Section, number>();
			for (const [term, weight] of this.termsMatching(queryTerm)) {
				const holders = this.postings.get(term)!;
				const idf = Math.log(1 + (this.sectionCount - holders.size + 0.5) / (holders.size + 0.5));
				for (const section of holders) {
					if (folder && !section.path.startsWith(folder)) continue;
					const count = section.termCounts.get(term)!;
					const saturation = (count * (K1 + 1)) / (count + K1 * (1 - B + (B * section.length) / averageLength));
					const score = weight * idf * saturation;
					if (score > (best.get(section) ?? 0)) best.set(section, score);
				}
			}
			for (const [section, score] of best) {
				const total = totals.get(section) ?? { score: 0, matchedTerms: 0 };
				total.score += score;
				total.matchedTerms++;
				totals.set(section, total);
			}
		}

		return [...totals].map(([section, total]) => ({ section, score: (total.score * total.matchedTerms) / queryTerms.length }));
	}

	/** The indexed words a query word stands for, with their weight: itself, and longer words it begins. */
	private *termsMatching(queryTerm: string): Generator<[string, number]> {
		if (this.postings.has(queryTerm)) yield [queryTerm, 1];
		if (queryTerm.length < MIN_PREFIX_CHARS) return;
		for (const term of this.postings.keys()) {
			if (term !== queryTerm && term.startsWith(queryTerm)) yield [term, PREFIX_MATCH_WEIGHT];
		}
	}
}

// ---- indexing a note

function sectionsOf(note: NoteForIndex): Section[] {
	const lineStarts = lineStartsOf(note.text);
	const headings = note.headings.filter((heading) => heading.offset >= note.bodyStart).sort((a, b) => a.offset - b.offset);
	const noteTerms = tokenize([...note.names, ...note.tags].join(" "));
	const starts = [note.bodyStart, ...headings.map((heading) => heading.offset)];

	const sections: Section[] = [];
	const trail: { level: number; heading: string }[] = [];
	for (let i = 0; i < starts.length; i++) {
		// starts[0] is the text before the first heading; starts[i] opens headings[i - 1].
		const heading = i > 0 ? headings[i - 1] : null;
		if (heading) {
			while (trail.length && trail[trail.length - 1].level >= heading.level) trail.pop();
			trail.push(heading);
		}
		const headingPath = trail.map((h) => h.heading);
		const headerTerms = [...noteTerms, ...tokenize(headingPath.join(" "))];
		const end = i + 1 < starts.length ? starts[i + 1] : note.text.length;
		for (const piece of piecesOf(note.text, starts[i], end)) {
			const text = note.text.slice(piece.start, piece.end);
			const termCounts = countTerms(tokenize(text), headerTerms);
			sections.push({
				path: note.path,
				headings: headingPath,
				startLine: lineAt(lineStarts, piece.start),
				endLine: lineAt(lineStarts, piece.end - 1),
				text,
				termCounts,
				length: [...termCounts.values()].reduce((sum, count) => sum + count, 0),
			});
		}
	}
	return sections;
}

/** The non-blank parts of text[start, end), cut at blank lines to at most about MAX_SECTION_CHARS, without surrounding whitespace. */
function piecesOf(text: string, start: number, end: number): { start: number; end: number }[] {
	const pieces: { start: number; end: number }[] = [];
	let pieceStart = start;
	while (end - pieceStart > MAX_SECTION_CHARS) {
		const blankLine = text.lastIndexOf("\n\n", pieceStart + MAX_SECTION_CHARS);
		const cut = blankLine > pieceStart ? blankLine + 2 : pieceStart + MAX_SECTION_CHARS;
		pieces.push({ start: pieceStart, end: cut });
		pieceStart = cut;
	}
	pieces.push({ start: pieceStart, end });

	return pieces.map((piece) => trimmed(text, piece)).filter((piece) => piece.end > piece.start);
}

function trimmed(text: string, piece: { start: number; end: number }): { start: number; end: number } {
	let { start, end } = piece;
	while (start < end && /\s/.test(text[start])) start++;
	while (end > start && /\s/.test(text[end - 1])) end--;
	return { start, end };
}

function countTerms(bodyTerms: string[], headerTerms: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const term of bodyTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
	for (const term of headerTerms) counts.set(term, (counts.get(term) ?? 0) + HEADER_WEIGHT);
	return counts;
}

/** Words of two or more letters or digits, in any script, folded (see foldForSearch). Punctuation and Markdown syntax fall away. */
export function tokenize(text: string): string[] {
	return (foldForSearch(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length >= 2);
}

const foldedChars = new Map<string, string>();

/**
 * Lowercase, without accents: "Üzüm" becomes "uzum", and Turkish dotless and dotted i
 * (ı, İ) both become i. The result is exactly as long as the input, character for character,
 * so a position found in it is the same position in the original: snippets show the text as written.
 */
function foldForSearch(text: string): string {
	return text.replace(/[A-Z]|[^\x00-\x7F]/gu, (char) => {
		let folded = foldedChars.get(char);
		if (folded === undefined) {
			folded = char === "\u0131" || char === "\u0130" ? "i" : char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
			// Some characters fold to more or fewer (\u00df would become "ss"); they stay as they are.
			if (folded.length !== char.length) folded = char;
			foldedChars.set(char, folded);
		}
		return folded;
	});
}

function lineStartsOf(text: string): number[] {
	const starts = [0];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
	return starts;
}

/** 1-based number of the line holding `offset`. */
function lineAt(lineStarts: number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (lineStarts[middle] <= offset) low = middle;
		else high = middle - 1;
	}
	return low + 1;
}

// ---- ranking

function folderPrefix(folder: string | undefined): string | null {
	const trimmedFolder = (folder ?? "").replace(/^\/+|\/+$/g, "");
	return trimmedFolder ? `${trimmedFolder}/` : null;
}

/** Notes that link to or from other notes in the pool are more likely what the search is about. Changes scores in place. */
function boostLinkedNotes(pool: { section: Section; score: number }[], links: LinkGraph): void {
	const poolNotes = new Set(pool.map((entry) => entry.section.path));
	for (const entry of pool) {
		const path = entry.section.path;
		let linked = 0;
		for (const other of poolNotes) {
			if (other !== path && (links[path]?.[other] || links[other]?.[path])) linked++;
		}
		entry.score *= 1 + LINK_BOOST_PER_NOTE * Math.min(linked, MAX_LINK_BOOSTS);
	}
}

/** The best sections in order, with no more than MAX_HITS_PER_NOTE from any one note. */
function bestPerNote(ranked: { section: Section; score: number }[], limit: number): Section[] {
	const perNote = new Map<string, number>();
	const best: Section[] = [];
	for (const { section } of ranked) {
		if (best.length >= limit) break;
		const taken = perNote.get(section.path) ?? 0;
		if (taken >= MAX_HITS_PER_NOTE) continue;
		perNote.set(section.path, taken + 1);
		best.push(section);
	}
	return best;
}

/** Notes that aren't hits themselves but link with several of the hits' notes, in either direction. */
function relatedNotes(hitNotes: Set<string>, links: LinkGraph): RelatedNote[] {
	const linkedHits = new Map<string, Set<string>>();
	const note = (path: string, hit: string) => {
		if (hitNotes.has(path) || !path.endsWith(".md")) return;
		let hits = linkedHits.get(path);
		if (!hits) linkedHits.set(path, (hits = new Set()));
		hits.add(hit);
	};
	for (const [source, targets] of Object.entries(links)) {
		for (const target of Object.keys(targets)) {
			if (hitNotes.has(source)) note(target, source);
			if (hitNotes.has(target)) note(source, target);
		}
	}
	return [...linkedHits]
		.map(([path, hits]) => ({ path, linkedHits: hits.size }))
		.filter((related) => related.linkedHits >= MIN_LINKED_HITS_FOR_RELATED)
		.sort((a, b) => b.linkedHits - a.linkedHits || a.path.localeCompare(b.path))
		.slice(0, MAX_RELATED);
}

/** A short stretch of the section around the first place a query word appears, on one line. */
function snippetOf(text: string, queryTerms: string[]): string {
	const folded = foldForSearch(text);
	const found = queryTerms.map((term) => folded.indexOf(term)).filter((position) => position >= 0);
	const first = found.length ? Math.min(...found) : 0;
	let start = Math.max(0, first - SNIPPET_LEAD_CHARS);
	if (start > 0) {
		// Start at a word, not in the middle of one.
		const space = text.slice(start, first).search(/\s/);
		if (space >= 0) start += space + 1;
	}
	const end = Math.min(text.length, start + SNIPPET_CHARS);
	const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}
