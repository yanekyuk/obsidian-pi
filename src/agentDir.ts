import { promises as fs } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

// The panel's pi gets a config folder of its own (pi calls it the agent dir), so none of what
// the user set up for pi in the terminal comes along: packages, extensions, skills, subagents,
// MCP overrides. What it does need from there is brought over by hand, and nothing else.
//   linked  auth.json   credentials. pi rewrites the file in place when it refreshes a token,
//                       so a link keeps both pis on the same tokens where a copy would go stale
//           models.json custom models and providers
//           mcp-oauth/  credentials again, for MCP servers that log in with OAuth
//   seeded  settings.json: default model and the like, once. Never the package list.
//   carried trust.json: whether this vault's own .pi folder is trusted
// Sessions stay where they were; see sessionDirFor.
export const USER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const HARNESS_AGENT_DIR = join(homedir(), ".pi", "harness");

const LINKED: { name: string; type: "file" | "dir" }[] = [
	{ name: "auth.json", type: "file" },
	{ name: "models.json", type: "file" },
	{ name: "mcp-oauth", type: "dir" },
];
const SEEDED_SETTINGS = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "enabledModels", "compaction", "shellCommandPrefix"];

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

async function link(source: string, target: string, type: "file" | "dir"): Promise<void> {
	if (!(await fs.stat(source).catch(() => null))) return; // nothing to share yet
	const existing = await fs.lstat(target).catch(() => null);
	if (existing?.isSymbolicLink()) return;
	if (existing) {
		// pi leaves an empty auth.json or folder behind on its first start. Anything with content is the user's.
		if (type === "dir") {
			if (await fs.rmdir(target).then(() => false, () => true)) return;
		} else {
			if (!["", "{}"].includes((await fs.readFile(target, "utf8")).trim())) return;
			await fs.unlink(target);
		}
	}
	// Windows only allows symlinks with extra rights; a copy of a file is the next best thing there.
	await fs.symlink(source, target, type).catch(() => (type === "file" ? fs.copyFile(source, target) : undefined));
}

export async function prepareAgentDir(vaultPath: string, userDir = USER_AGENT_DIR, harnessDir = HARNESS_AGENT_DIR): Promise<string> {
	await fs.mkdir(harnessDir, { recursive: true });
	for (const { name, type } of LINKED) await link(join(userDir, name), join(harnessDir, name), type);

	// Seeded, not synced: a key the panel's pi already has is left alone, so choices made here stick.
	const mine = await readJson(join(harnessDir, "settings.json"));
	const theirs = await readJson(join(userDir, "settings.json"));
	const missing = SEEDED_SETTINGS.filter((key) => !(key in mine) && key in theirs);
	if (missing.length) {
		for (const key of missing) mine[key] = theirs[key];
		await fs.writeFile(join(harnessDir, "settings.json"), JSON.stringify(mine, null, 2) + "\n");
	}

	// pi only loads a folder's own .pi resources (skills, settings, packages installed with -l)
	// once the user has trusted it. That decision was made in the terminal; it holds here too.
	// As in pi, a decision about a parent folder covers the folders inside it, and the nearest one wins.
	const vault = resolve(vaultPath);
	const decisions = await readJson(join(userDir, "trust.json"));
	let trusted: unknown;
	for (let dir = vault; trusted === undefined; dir = dirname(dir)) {
		trusted = decisions[dir];
		if (dirname(dir) === dir) break;
	}
	const trust = await readJson(join(harnessDir, "trust.json"));
	if (trusted !== undefined && trust[vault] !== trusted) {
		trust[vault] = trusted;
		await fs.writeFile(join(harnessDir, "trust.json"), JSON.stringify(trust, null, 2) + "\n");
	}
	return harnessDir;
}

// Where pi keeps this folder's sessions when left to itself (same naming as pi's session manager).
// The panel keeps using it, so the history is one list whichever pi wrote a session.
export function sessionDirFor(cwd: string, userDir = USER_AGENT_DIR): string {
	return join(userDir, "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
