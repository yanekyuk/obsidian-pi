import { execFile } from "child_process";
import { homedir } from "os";
import { delimiter, join } from "path";

// GUI apps on macOS/Linux don't inherit the login shell's PATH, so `pi` (a
// `#!/usr/bin/env node` script) and the tools it shells out to would not resolve.
// Ask the user's shell once, and fall back to the usual install locations.

const MARK = "__PI_HARNESS_PATH__";

const FALLBACK_DIRS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	join(homedir(), ".local", "bin"),
	join(homedir(), ".bun", "bin"),
	join(homedir(), ".npm-global", "bin"),
	join(homedir(), ".volta", "bin"),
];

let cached: Promise<NodeJS.ProcessEnv> | null = null;

function shellPath(): Promise<string | null> {
	if (process.platform === "win32") return Promise.resolve(null);
	const shell = process.env.SHELL || "/bin/zsh";
	return new Promise((resolve) => {
		execFile(
			shell,
			// Braces matter: the marker starts with "_", so a bare $PATH would be read as
			// one long (unset) variable name and expand to nothing.
			["-ilc", `printf '%s' "${MARK}\${PATH}${MARK}"`],
			{ timeout: 5000, encoding: "utf8" },
			(_err, stdout) => {
				// rc files may print banners; only trust what sits between the markers.
				const match = stdout?.match(new RegExp(`${MARK}(.*?)${MARK}`, "s"));
				resolve(match?.[1] || null);
			},
		);
	});
}

export function resolveEnv(): Promise<NodeJS.ProcessEnv> {
	cached ??= shellPath().then((fromShell) => {
		const seen = new Set<string>();
		const parts = [...(fromShell ?? "").split(delimiter), ...(process.env.PATH ?? "").split(delimiter), ...FALLBACK_DIRS];
		const path = parts.filter((p) => p && !seen.has(p) && seen.add(p)).join(delimiter);
		return { ...process.env, PATH: path };
	});
	return cached;
}
