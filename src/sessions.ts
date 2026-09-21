import { promises as fs } from "fs";
import { join } from "path";
import { splitContext } from "./prompt";

export interface SessionSummary {
	path: string;
	title: string;
	// True when the title is a name the user (or pi) gave it, not just the first prompt.
	named: boolean;
	mtime: number;
}

const MAX_SESSIONS = 200;
const READ_CONCURRENCY = 8;
const SESSION_INFO = Buffer.from('"type":"session_info"');
const NEWLINE = 0x0a;

// Session files run to several MB, and the list is reopened often. A file's title
// can only change when the file does, so remember it per (mtime, size).
const titleCache = new Map<string, { stamp: string; title: string; named: boolean }>();

// pi has no RPC command for listing sessions, but sessions for a cwd live side by
// side, so the directory of the current session file is the place to look.
export async function listSessions(sessionDir: string): Promise<SessionSummary[]> {
	const names = (await fs.readdir(sessionDir)).filter((n) => n.endsWith(".jsonl"));
	const files = await Promise.all(
		names.map(async (name) => {
			const path = join(sessionDir, name);
			const stat = await fs.stat(path);
			return { path, mtime: stat.mtimeMs, stamp: `${stat.mtimeMs}:${stat.size}` };
		}),
	);
	files.sort((a, b) => b.mtime - a.mtime);
	files.length = Math.min(files.length, MAX_SESSIONS);

	const result: SessionSummary[] = new Array(files.length);
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const i = next++;
			const { path, mtime, stamp } = files[i];
			let entry = titleCache.get(path);
			if (entry?.stamp !== stamp) {
				entry = { stamp, ...(await readTitle(path).catch(() => ({ title: "Unreadable session", named: false }))) };
				titleCache.set(path, entry);
			}
			result[i] = { path, mtime, title: entry.title, named: entry.named };
		}
	};
	await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
	for (const path of titleCache.keys()) if (path.startsWith(sessionDir) && !files.some((f) => f.path === path)) titleCache.delete(path);
	return result;
}

function lineAt(buffer: Buffer, index: number): string {
	const start = buffer.lastIndexOf(NEWLINE, index) + 1;
	const end = buffer.indexOf(NEWLINE, index);
	return buffer.toString("utf8", start, end === -1 ? buffer.length : end);
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

// The name is the latest session_info entry, which can sit anywhere in the file.
// Searching the raw bytes finds it without JSON-parsing megabytes of transcript;
// only the matching line and the first few lines (for the first prompt) get parsed.
async function readTitle(path: string): Promise<{ title: string; named: boolean }> {
	const buffer = await fs.readFile(path);

	for (let at = buffer.lastIndexOf(SESSION_INFO); at !== -1; at = at === 0 ? -1 : buffer.lastIndexOf(SESSION_INFO, at - 1)) {
		try {
			const entry = JSON.parse(lineAt(buffer, at)) as { type?: string; name?: string };
			// The marker also appears inside transcripts that merely mention it.
			if (entry.type !== "session_info") continue;
			if (entry.name?.trim()) return { title: clean(entry.name), named: true };
			break; // an empty name is how pi records "name cleared"
		} catch {
			continue;
		}
	}

	let start = 0;
	for (let line = 0; line < 50 && start < buffer.length; line++) {
		let end = buffer.indexOf(NEWLINE, start);
		if (end === -1) end = buffer.length;
		try {
			const entry = JSON.parse(buffer.toString("utf8", start, end)) as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry.type === "message" && entry.message?.role === "user") {
				const text = clean(splitContext(contentText(entry.message.content)).text);
				if (text) return { title: text, named: false };
			}
		} catch {
			// skip malformed lines
		}
		start = end + 1;
	}
	return { title: "Empty session", named: false };
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}
