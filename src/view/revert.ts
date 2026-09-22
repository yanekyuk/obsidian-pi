import { TFile, type App } from "obsidian";
import { existsSync, readFileSync } from "fs";
import { promises as fs } from "fs";
import { relative } from "path";

// Undo for pi's file edits. The panel reads the file just before pi's edit or write tool runs
// and again after it, so the card can put either version back. Nothing is written to disk
// for this; a reload of the panel forgets it, and Obsidian's File Recovery is there for the rest.

const MAX_SNAPSHOT_BYTES = 2_000_000;

export const EDITING_TOOLS = new Set(["edit", "write"]);

export interface FileSnapshot {
	path: string;
	// null: the file did not exist.
	before: string | null;
	after: string | null;
	// Which version is on disk as far as the panel knows.
	current: "after" | "before";
}

function readNow(path: string): string | null | undefined {
	if (!existsSync(path)) return null;
	try {
		const buffer = readFileSync(path);
		return buffer.length > MAX_SNAPSHOT_BYTES ? undefined : buffer.toString("utf8");
	} catch {
		return undefined;
	}
}

// Before the tool runs. `undefined` when the file can't be kept (too large, unreadable).
export function snapshotBefore(path: string): FileSnapshot | undefined {
	const before = readNow(path);
	return before === undefined ? undefined : { path, before, after: null, current: "after" };
}

// After the tool ran. The start event and pi's write race on the pipe, so the "before" reading
// is checked against what the tool said it did; when it can't be trusted, there is no undo.
export function snapshotAfter(snapshot: FileSnapshot, toolName: string, args: Record<string, unknown>): FileSnapshot | undefined {
	const after = readNow(snapshot.path);
	if (after === undefined || after === null) return undefined;
	if (toolName === "edit") {
		const { oldText, newText } = args as { oldText?: string; newText?: string };
		if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
		const clean = snapshot.before !== null && snapshot.before.includes(oldText) && snapshot.before.replace(oldText, () => newText) === after;
		if (clean) return { ...snapshot, after };
		// The read came too late: the file already had the new text. Undo it from the arguments instead,
		// when the new text sits in the file exactly once.
		if (snapshot.before === after && after.split(newText).length === 2) return { ...snapshot, before: after.replace(newText, () => oldText), after };
		return undefined;
	}
	if (snapshot.before === after) return undefined; // read too late, or a write that changed nothing
	return { ...snapshot, after };
}

// Puts the other version on disk, through Obsidian for vault files so open editors follow.
export async function swapVersion(app: App, vaultPath: string, snapshot: FileSnapshot): Promise<FileSnapshot> {
	const target = snapshot.current === "after" ? snapshot.before : snapshot.after;
	const rel = relative(vaultPath, snapshot.path);
	const inVault = !rel.startsWith("..") && !rel.startsWith("/");
	const file = inVault ? app.vault.getAbstractFileByPath(rel) : null;
	if (target === null) {
		if (file instanceof TFile) await app.vault.trash(file, true);
		else if (existsSync(snapshot.path)) await fs.rm(snapshot.path);
	} else if (file instanceof TFile) await app.vault.modify(file, target);
	else if (inVault) await app.vault.create(rel, target);
	else await fs.writeFile(snapshot.path, target);
	return { ...snapshot, current: snapshot.current === "after" ? "before" : "after" };
}

// Whether the file still holds the version the panel last put there (or saw pi put there).
export function unchangedSince(snapshot: FileSnapshot): boolean {
	const now = readNow(snapshot.path);
	return now === (snapshot.current === "after" ? snapshot.after : snapshot.before);
}
