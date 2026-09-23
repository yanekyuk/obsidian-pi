import { execFile } from "child_process";
import { basename } from "path";

// The pi packages the panel knows how to present. A local checkout or git fork with the
// same folder name satisfies a requirement; Pi Harness only inspects packages and never
// installs, removes, or updates them.
export const MCP_ADAPTER = "pi-mcp-adapter";
export const REQUIRED_PACKAGES = ["rpiv-advisor", "rpiv-args", "rpiv-ask-user-question", "rpiv-btw", "rpiv-todo", "rpiv-web-tools", MCP_ADAPTER] as const;
export type RequiredPackageName = (typeof REQUIRED_PACKAGES)[number];

const SCOPE = "@juicesharp";
export const requiredPackageSource = (name: RequiredPackageName): string => (name === MCP_ADAPTER ? `npm:${name}` : `npm:${SCOPE}/${name}`);

// Steph Ango's Obsidian skills remain in their own repository. Users install and update
// them outside Obsidian; the plugin only checks whether Pi has loaded any of them.
export const SKILLS_PACKAGE = { name: "obsidian-skills", source: "git:github.com/kepano/obsidian-skills" } as const;
export const OBSIDIAN_SKILLS = ["obsidian-markdown", "obsidian-bases", "json-canvas", "obsidian-cli", "defuddle"];

// Local installs work with Pi Harness's isolated profile and its shared profile alike.
// These commands must be run by the user in a terminal whose working directory is the vault.
export function manualInstallCommands(missingPackages: readonly RequiredPackageName[], includeObsidianSkills: boolean): string[] {
	const sources = missingPackages.map(requiredPackageSource);
	if (includeObsidianSkills) sources.push(SKILLS_PACKAGE.source);
	return sources.map((source) => `pi install -l ${source}`);
}

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
// fork satisfies the requirement just as well, and should not be reported as missing.
export function findRequired(installed: InstalledPackage[]): Map<RequiredPackageName, InstalledPackage | null> {
	return new Map(REQUIRED_PACKAGES.map((name) => [name, installed.find((pkg) => basename(pkg.path) === name) ?? null] as const));
}

export interface RequirementsHost {
	piCommand(): Promise<{ binary: string; env: NodeJS.ProcessEnv; cwd: string }>;
}

const LIST_TIMEOUT_MS = 60_000;

// Inspection boundary for Pi's package state. The only subprocess operation here is
// `pi list`; package mutations belong to the user's terminal, outside Obsidian.
export class Requirements {
	private listing: Promise<InstalledPackage[]> | null = null;

	constructor(private host: RequirementsHost) {}

	// Concurrent tabs share one `pi list`, but a later check runs it again so packages the
	// user installed outside Obsidian are visible without restarting Obsidian.
	installed(): Promise<InstalledPackage[]> {
		if (this.listing) return this.listing;
		this.listing = this.listInstalled();
		const current = this.listing;
		void current.then(
			() => {
				if (this.listing === current) this.listing = null;
			},
			() => {
				if (this.listing === current) this.listing = null;
			},
		);
		return current;
	}

	async status(): Promise<Map<RequiredPackageName, InstalledPackage | null>> {
		return findRequired(await this.installed());
	}

	private async listInstalled(): Promise<InstalledPackage[]> {
		const { binary, env, cwd } = await this.host.piCommand();
		const output = await new Promise<string>((resolve, reject) => {
			execFile(binary, ["list"], { env, cwd, timeout: LIST_TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) reject(new Error((stderr || err.message).trim().split("\n").slice(-3).join("\n")));
				else resolve(stdout);
			});
		});
		return parsePiList(output);
	}
}
