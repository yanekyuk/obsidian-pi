import { execFile } from "child_process";
import { readFileSync } from "fs";
import { basename, join } from "path";

// The pi extensions the panel is built around. The plugin installs the missing ones
// through pi's own package manager (user scope, ~/.pi/agent/npm), so they are the same
// copies a terminal pi uses rather than a second set that would register every tool twice.
export const REQUIRED_PACKAGES = ["rpiv-advisor", "rpiv-args", "rpiv-ask-user-question", "rpiv-btw", "rpiv-todo", "rpiv-web-tools"] as const;
const SCOPE = "@juicesharp";

// Steph Ango's Obsidian skills. They are his, so the plugin doesn't carry a copy: pi fetches
// them from his repository, and `pi update` keeps them current like any other package.
export const SKILLS_PACKAGE = { name: "obsidian-skills", source: "git:github.com/kepano/obsidian-skills" };
export const OBSIDIAN_SKILLS = ["obsidian-markdown", "obsidian-bases", "json-canvas", "obsidian-cli", "defuddle"];
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface InstalledPackage {
	source: string;
	path: string;
}

// `pi list` prints each package as an indented source line followed by its resolved path.
export function parsePiList(output: string): InstalledPackage[] {
	const packages: InstalledPackage[] = [];
	let source: string | null = null;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line || line.endsWith(":")) continue; // blank, or a "User packages:" heading
		if (line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line)) {
			if (source) packages.push({ source, path: line });
			source = null;
		} else {
			source = line.replace(/\s+\(filtered\)$/, "");
		}
	}
	return packages;
}

// By folder name, not by source: a package installed from a local checkout or a git
// fork satisfies the requirement just as well, and installing the npm one on top of it
// would load the extension twice.
export function findRequired(installed: InstalledPackage[]): Map<string, InstalledPackage | null> {
	return new Map(REQUIRED_PACKAGES.map((name) => [name, installed.find((p) => basename(p.path) === name) ?? null]));
}

// What tells one state of an installed package from the next: its npm version, or for a git
// checkout without one (the Obsidian skills are plain folders) the commit it is on.
export function versionAt(path: string): string | null {
	try {
		const version = (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version?: string }).version;
		if (version) return version;
	} catch {
		// no package.json: fall through to git
	}
	try {
		const head = readFileSync(join(path, ".git", "HEAD"), "utf8").trim();
		const ref = head.match(/^ref: (.+)$/)?.[1];
		if (!ref) return head.slice(0, 7);
		try {
			return readFileSync(join(path, ".git", ref), "utf8").trim().slice(0, 7);
		} catch {
			const packed = readFileSync(join(path, ".git", "packed-refs"), "utf8").match(new RegExp(`^([0-9a-f]{40}) ${ref}$`, "m"));
			return packed ? packed[1].slice(0, 7) : null;
		}
	} catch {
		return null;
	}
}

export interface RequirementsHost {
	piCommand(): Promise<{ binary: string; env: NodeJS.ProcessEnv; cwd: string }>;
	enabled(): boolean;
	autoUpdate(): boolean;
	// pi is in the middle of something in one of the tabs.
	busy(): boolean;
	lastUpdate(): number;
	setLastUpdate(time: number): Promise<void>;
	notify(message: string): void;
}

export class Requirements {
	private ensuring: Promise<void> | null = null;
	private updating: Promise<string[]> | null = null;
	private installingSkills: Promise<boolean> | null = null;

	constructor(private host: RequirementsHost) {}

	private async pi(args: string[]): Promise<string> {
		const { binary, env, cwd } = await this.host.piCommand();
		return new Promise((resolve, reject) => {
			execFile(binary, args, { env, cwd, timeout: INSTALL_TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join("\n")));
				else resolve(stdout);
			});
		});
	}

	async installed(): Promise<InstalledPackage[]> {
		return parsePiList(await this.pi(["list"]));
	}

	async status(): Promise<Map<string, InstalledPackage | null>> {
		return findRequired(await this.installed());
	}

	// Installs whatever is missing. Runs once per Obsidian session however many chat tabs
	// ask; a failure (offline, no npm) is reported and never keeps pi from starting.
	ensure(onStatus: (text: string) => void): Promise<void> {
		if (!this.host.enabled()) return Promise.resolve();
		this.ensuring ??= (async () => {
			try {
				const missing = [...(await this.status())].filter(([, pkg]) => pkg === null).map(([name]) => name);
				for (const name of missing) {
					onStatus(`Installing ${name}…`);
					await this.pi(["install", `npm:${SCOPE}/${name}`]);
				}
				if (missing.length) this.host.notify(`Pi Harness installed ${missing.join(", ")}.`);
			} catch (err) {
				this.ensuring = null; // let the next pi start try again
				this.host.notify(`Pi Harness couldn't install its pi extensions: ${(err as Error).message}`);
			}
		})();
		return this.ensuring;
	}

	// Whether these are needed is only known once pi is up and says which skills it found: a vault
	// may bring its own in .pi/skills, and those count. Resolves to true when they were installed
	// just now, which the running pi only notices after a reload.
	installSkills(onStatus: (text: string) => void): Promise<boolean> {
		if (!this.host.enabled()) return Promise.resolve(false);
		// Only the first caller hears "installed just now", so only one tab reloads for it, once.
		if (this.installingSkills) return this.installingSkills.then(() => false);
		this.installingSkills = (async () => {
			try {
				onStatus(`Installing ${SKILLS_PACKAGE.name}…`);
				await this.pi(["install", SKILLS_PACKAGE.source]);
				this.host.notify(`Pi Harness installed ${SKILLS_PACKAGE.name}.`);
				return true;
			} catch (err) {
				this.host.notify(`Pi Harness couldn't install the Obsidian skills: ${(err as Error).message}`);
				return false;
			}
		})();
		return this.installingSkills;
	}

	// pi itself, then every installed package, by folder name.
	private async versions(): Promise<Map<string, string>> {
		const versions = new Map([["pi", (await this.pi(["--version"])).trim()]]);
		for (const pkg of parsePiList(await this.pi(["list"]))) {
			const version = versionAt(pkg.path);
			if (version) versions.set(basename(pkg.path), version);
		}
		return versions;
	}

	// `pi update --all`: pi and every installed package, the rpiv extensions and the Obsidian
	// skills among them (a git package without a pinned ref is pulled), at most once a day unless forced.
	// It replaces pi's files, so it waits for a moment when no tab has pi at work. Returns
	// what changed; a running pi keeps the old code until it is reloaded.
	async update(force = false): Promise<string[]> {
		if (!force && (!this.host.autoUpdate() || this.host.busy() || Date.now() - this.host.lastUpdate() < UPDATE_INTERVAL_MS)) return [];
		this.updating ??= (async () => {
			try {
				const before = await this.versions();
				await this.pi(["update", "--all"]);
				await this.host.setLastUpdate(Date.now());
				return [...(await this.versions())].filter(([name, version]) => before.get(name) !== version).map(([name, version]) => `${name} ${version}`);
			} finally {
				this.updating = null;
			}
		})();
		return this.updating;
	}
}
