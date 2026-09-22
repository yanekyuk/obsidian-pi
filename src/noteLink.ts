import { TFile, type App } from "obsidian";
import { existsSync } from "fs";
import { basename, dirname, isAbsolute, join } from "path";

// A note can carry the session that belongs to it, as a property, so "Open pi for this note"
// comes back to the same conversation. Only the file name is stored: the session folder
// depends on the machine and on the panel's settings.
export const SESSION_PROPERTY = "pi-session";

export function linkedSession(app: App, file: TFile): string | null {
	const value = app.metadataCache.getFileCache(file)?.frontmatter?.[SESSION_PROPERTY];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Where a stored value points on this machine, trying the folders a session could be in.
export function resolveLinked(value: string, dirs: (string | null)[]): string | null {
	if (isAbsolute(value)) return existsSync(value) ? value : null;
	for (const dir of dirs) {
		if (!dir) continue;
		const path = join(dir, value);
		if (existsSync(path)) return path;
	}
	return null;
}

export async function writeLink(app: App, file: TFile, sessionFile: string | null): Promise<void> {
	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		if (sessionFile) frontmatter[SESSION_PROPERTY] = basename(sessionFile);
		else delete frontmatter[SESSION_PROPERTY];
	});
}

// The folders to look in: where the panel's pi keeps sessions, and where the last one was.
export function sessionDirs(configured: string, lastSessionFile: string): string[] {
	return [...new Set([configured, lastSessionFile ? dirname(lastSessionFile) : ""].filter(Boolean))];
}
