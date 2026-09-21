// Copies the built plugin into a vault:  npm run install:vault [-- /path/to/vault]
// Without a path it uses the vault Obsidian currently has open.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function openVault() {
	const registry = {
		darwin: join(homedir(), "Library/Application Support/obsidian/obsidian.json"),
		win32: join(process.env.APPDATA ?? "", "obsidian/obsidian.json"),
	}[process.platform] ?? join(homedir(), ".config/obsidian/obsidian.json");
	if (!existsSync(registry)) return null;
	const vaults = Object.values(JSON.parse(readFileSync(registry, "utf8")).vaults ?? {});
	return (vaults.find((v) => v.open) ?? vaults[0])?.path ?? null;
}

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT ?? openVault();
if (!vault || !existsSync(join(vault, ".obsidian"))) {
	console.error(`Not an Obsidian vault: ${vault ?? "(none found)"}\nUsage: npm run install:vault -- /path/to/vault`);
	process.exit(1);
}
if (!existsSync(join(root, "main.js"))) {
	console.error("main.js is missing. Run `npm run build` first.");
	process.exit(1);
}

const { id } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const dest = join(vault, ".obsidian", "plugins", id);
mkdirSync(dest, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) cpSync(join(root, file), join(dest, file));
// Replace rather than merge, so files removed from the repo don't linger. data.json is left alone.
for (const dir of ["bin"]) {
	rmSync(join(dest, dir), { recursive: true, force: true });
	cpSync(join(root, dir), join(dest, dir), { recursive: true });
}

console.log(`Installed ${id} to ${dest}`);
