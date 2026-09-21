import { promises as fs } from "fs";

// pi's settings.json lists packages as plain sources, or as objects that filter what a package
// may load. An empty list for every kind of resource loads nothing, which is how pi itself
// (pi config) switches a package off while leaving it installed.
export type PackageEntry = string | ({ source: string } & Record<string, unknown>);

const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;

export const sourceOf = (entry: PackageEntry): string => (typeof entry === "string" ? entry : entry.source);

export function isDisabled(entry: PackageEntry): boolean {
	return typeof entry !== "string" && RESOURCE_KINDS.every((kind) => Array.isArray(entry[kind]) && (entry[kind] as unknown[]).length === 0);
}

// Whether the package's skills load as the package ships them. Any skills filter means the user
// (or the off switch) has narrowed them, and the panel must not add them back by path.
export function loadsAllSkills(entry: PackageEntry): boolean {
	return typeof entry === "string" || !("skills" in entry);
}

export function disabled(entry: PackageEntry): PackageEntry {
	return { ...(typeof entry === "string" ? {} : entry), source: sourceOf(entry), extensions: [], skills: [], prompts: [], themes: [] };
}

// `remembered` is the entry as it was before it was switched off, filters and all. Without it
// the package simply loads everything again.
export function enabled(entry: PackageEntry, remembered?: PackageEntry): PackageEntry {
	if (remembered && sourceOf(remembered) === sourceOf(entry) && !isDisabled(remembered)) return remembered;
	if (typeof entry === "string") return entry;
	const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => !(RESOURCE_KINDS as readonly string[]).includes(key))) as { source: string };
	return Object.keys(rest).length === 1 ? rest.source : rest;
}

export async function readPackageEntries(settingsFile: string): Promise<PackageEntry[]> {
	try {
		const packages = (JSON.parse(await fs.readFile(settingsFile, "utf8")) as { packages?: unknown }).packages;
		return Array.isArray(packages) ? packages.filter((p): p is PackageEntry => typeof p === "string" || (typeof p === "object" && p !== null && typeof (p as { source?: unknown }).source === "string")) : [];
	} catch {
		return [];
	}
}

// Rewrites one entry and leaves the rest of the file as it was. Returns the entry that was replaced.
export async function replacePackageEntry(settingsFile: string, source: string, change: (entry: PackageEntry) => PackageEntry): Promise<PackageEntry | null> {
	const settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as { packages?: PackageEntry[] };
	const index = (settings.packages ?? []).findIndex((entry) => sourceOf(entry) === source);
	if (!settings.packages || index === -1) return null;
	const before = settings.packages[index];
	settings.packages[index] = change(before);
	await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n");
	return before;
}
