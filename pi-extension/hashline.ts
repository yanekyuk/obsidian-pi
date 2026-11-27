// Content-addressed line-hash read & edit tools for Pi ("The Harness Problem" — Can Bölük).
// Each line read is tagged `<line>:<2-hex-hash>|text`, and edits reference those anchors instead
// of reproducing whitespace-sensitive text blocks. Eliminates indentation/retry loops on smaller
// or open-weight models while failing fast when a file changed underneath the model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "fs";
import { isAbsolute, resolve } from "path";
import { Type } from "typebox";

const DEFAULT_READ_LIMIT = 400;
const MAX_READ_LIMIT = 1000;

/** Deterministic 2-char hex content hash (FNV-1a 32-bit folded to 8 bits) of trimmed line content. */
export function lineHash(line: string): string {
	let h = 0x811c9dc5;
	const s = line.trim();
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	const byte = ((h >>> 24) ^ (h >>> 16) ^ (h >>> 8) ^ h) & 0xff;
	return byte.toString(16).padStart(2, "0");
}

export function formatHashlines(content: string, offset = 1, limit = DEFAULT_READ_LIMIT): { text: string; totalLines: number; shownStart: number; shownEnd: number } {
	const lines = content.split(/\r?\n/);
	const totalLines = lines.length;
	const start = Math.max(1, Math.floor(offset));
	const cap = Math.min(Math.max(1, Math.floor(limit)), MAX_READ_LIMIT);
	const end = Math.min(totalLines, start + cap - 1);
	const out: string[] = [];
	for (let i = start; i <= end; i++) {
		const line = lines[i - 1] ?? "";
		out.push(`${i}:${lineHash(line)}|${line}`);
	}
	const footer = end < totalLines ? `\n[Showing lines ${start}-${end} of ${totalLines}. Pass offset=${end + 1} for more.]` : "";
	return { text: out.join("\n") + footer, totalLines, shownStart: start, shownEnd: end };
}

export type HashlineEditOp =
	| { op: "replace"; start: string; end?: string; content: string }
	| { op: "insert_after"; anchor: string; content: string }
	| { op: "delete"; start: string; end?: string };

interface ParsedAnchor {
	line: number;
	hash: string;
}

function parseAnchor(raw: string): ParsedAnchor {
	const m = raw.trim().match(/^(\d+):([0-9a-fA-F]{2})$/);
	if (!m) throw new Error(`Invalid anchor "${raw}". Expected "<line>:<2-hex-hash>", e.g. "12:a3".`);
	const line = Number.parseInt(m[1], 10);
	if (!Number.isFinite(line) || line < 1) throw new Error(`Invalid line number in anchor "${raw}".`);
	return { line, hash: m[2].toLowerCase() };
}

function contextAround(lines: string[], lineNum: number): string {
	const from = Math.max(1, lineNum - 2);
	const to = Math.min(lines.length, lineNum + 2);
	const out: string[] = [];
	for (let i = from; i <= to; i++) out.push(`${i}:${lineHash(lines[i - 1])}|${lines[i - 1]}`);
	return out.join("\n");
}

function verifyAnchor(lines: string[], anchor: ParsedAnchor, label: string): void {
	if (anchor.line > lines.length) {
		throw new Error(`${label} line ${anchor.line} is past EOF (file has ${lines.length} lines).`);
	}
	const actual = lineHash(lines[anchor.line - 1]);
	if (actual !== anchor.hash) {
		throw new Error(
			`Hash mismatch at ${label} ${anchor.line}:${anchor.hash} (actual ${anchor.line}:${actual}). Current lines:\n${contextAround(lines, anchor.line)}`,
		);
	}
}

interface NormalizedOp {
	kind: "replace" | "insert_after" | "delete";
	startLine: number;
	endLine: number;
	newLines: string[];
}

/** Validates all line-hash anchors atomically before mutating, rejects overlaps, and applies bottom-up. */
export function applyHashlineEdits(content: string, edits: HashlineEditOp[]): { content: string; applied: number } {
	if (!edits.length) throw new Error("Provide at least one edit.");
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(/\r?\n/);

	const normalized: NormalizedOp[] = edits.map((edit, idx) => {
		if (edit.op === "insert_after") {
			const anchor = parseAnchor(edit.anchor);
			verifyAnchor(lines, anchor, `edit[${idx}].anchor`);
			return {
				kind: "insert_after",
				startLine: anchor.line,
				endLine: anchor.line,
				newLines: edit.content.split(/\r?\n/),
			};
		}
		const start = parseAnchor(edit.start);
		const end = edit.end ? parseAnchor(edit.end) : start;
		if (end.line < start.line) throw new Error(`edit[${idx}]: end line ${end.line} is before start line ${start.line}.`);
		verifyAnchor(lines, start, `edit[${idx}].start`);
		if (edit.end) verifyAnchor(lines, end, `edit[${idx}].end`);
		if (edit.op === "delete") {
			return { kind: "delete", startLine: start.line, endLine: end.line, newLines: [] };
		}
		return {
			kind: "replace",
			startLine: start.line,
			endLine: end.line,
			newLines: edit.content === "" ? [] : edit.content.split(/\r?\n/),
		};
	});

	// Sort ascending to check for overlapping spans on replace/delete.
	const sorted = [...normalized].sort((a, b) => a.startLine - b.startLine || (a.kind === "insert_after" ? 1 : -1));
	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const curr = sorted[i];
		if (prev.kind === "insert_after" && curr.kind === "insert_after" && prev.startLine === curr.startLine) continue;
		if (prev.kind !== "insert_after" && curr.kind !== "insert_after" && curr.startLine <= prev.endLine) {
			throw new Error(`Overlapping edits at lines ${prev.startLine}-${prev.endLine} and ${curr.startLine}-${curr.endLine}.`);
		}
	}

	// Apply from bottom to top so earlier line numbers never shift.
	const descending = [...normalized].sort((a, b) => b.startLine - a.startLine || (b.kind === "insert_after" ? 1 : -1));
	for (const op of descending) {
		if (op.kind === "insert_after") {
			lines.splice(op.startLine, 0, ...op.newLines);
		} else {
			lines.splice(op.startLine - 1, op.endLine - op.startLine + 1, ...op.newLines);
		}
	}

	return { content: lines.join(eol), applied: edits.length };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hashline_read",
		label: "Read (hashline)",
		description:
			"Read a file with each line prefixed by `<line>:<2-hex-hash>|`. Use these anchors with `hashline_edit` to edit files reliably without reproducing whitespace or indentation.",
		promptSnippet: "Read a file with content-hash line anchors for hashline_edit",
		promptGuidelines: [
			"When editing files with hashline_edit, read the target slice with hashline_read first and pass exact `<line>:<hash>` anchors.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory or absolute." }),
			offset: Type.Optional(Type.Number({ description: "1-based start line. Default 1." })),
			limit: Type.Optional(Type.Number({ description: "Max lines to read (default 400, max 1000)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const full = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			const raw = await fs.readFile(full, "utf8");
			const res = formatHashlines(raw, params.offset, params.limit);
			return { content: [{ type: "text" as const, text: res.text }], details: { totalLines: res.totalLines, shownStart: res.shownStart, shownEnd: res.shownEnd } };
		},
	});

	pi.registerTool({
		name: "hashline_edit",
		label: "Edit (hashline)",
		description:
			"Atomically edit a file using `<line>:<hash>` anchors from `hashline_read`. Every anchor hash is verified before writing; if a line changed, the edit fails safely with updated anchors.",
		promptSnippet: "Edit a file by `<line>:<hash>` anchors without copying existing code",
		parameters: Type.Object({
			path: Type.String({ description: "File path, relative to the working directory or absolute." }),
			edits: Type.Array(
				Type.Object({
					op: Type.Union([Type.Literal("replace"), Type.Literal("insert_after"), Type.Literal("delete")]),
					start: Type.Optional(Type.String({ description: 'Start anchor "<line>:<hash>" for replace/delete.' })),
					end: Type.Optional(Type.String({ description: 'Optional inclusive end anchor "<line>:<hash>" for multi-line replace/delete.' })),
					anchor: Type.Optional(Type.String({ description: 'Anchor "<line>:<hash>" for insert_after.' })),
					content: Type.Optional(Type.String({ description: "Replacement or inserted text (without line:hash prefixes)." })),
				}),
				{ description: "List of non-overlapping edits applied atomically." },
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const full = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
			const before = await fs.readFile(full, "utf8");
			const ops: HashlineEditOp[] = params.edits.map((e) => {
				if (e.op === "insert_after") {
					if (!e.anchor) throw new Error('insert_after requires "anchor".');
					return { op: "insert_after", anchor: e.anchor, content: e.content ?? "" };
				}
				if (!e.start) throw new Error(`${e.op} requires "start".`);
				if (e.op === "delete") return { op: "delete", start: e.start, end: e.end };
				return { op: "replace", start: e.start, end: e.end, content: e.content ?? "" };
			});
			const { content: after, applied } = applyHashlineEdits(before, ops);
			await fs.writeFile(full, after, "utf8");
			return {
				content: [{ type: "text" as const, text: `Applied ${applied} hashline edit${applied === 1 ? "" : "s"} to ${params.path}.` }],
				details: { applied },
			};
		},
	});
}
