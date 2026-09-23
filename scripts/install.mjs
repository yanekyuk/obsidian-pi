// Copies the built plugin into a vault:  npm run install:vault [-- /path/to/vault]
// Without a path it uses the vault Obsidian currently has open.
//
//   npm run install:test [-- /path/to/vault]
// installs the build as a second plugin, "Pi Harness (test)" (id pi-harness-test), to try a change
// before it is released. Its panel's view type and its obsidian:// address get names of their own,
// so it can run next to the released plugin. On the first install it copies the released plugin's
// settings, but not its last session: two pi processes on one session file would corrupt it.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const testCopy = args.includes("--test");
const vaultArg = args.find((arg) => !arg.startsWith("--"));

function openVault() {
	const registry = {
		darwin: join(homedir(), "Library/Application Support/obsidian/obsidian.json"),
		win32: join(process.env.APPDATA ?? "", "obsidian/obsidian.json"),
	}[process.platform] ?? join(homedir(), ".config/obsidian/obsidian.json");
	if (!existsSync(registry)) return null;
	const vaults = Object.values(JSON.parse(readFileSync(registry, "utf8")).vaults ?? {});
	return (vaults.find((v) => v.open) ?? vaults[0])?.path ?? null;
}

// The names in main.js that two copies of the plugin can't share, each expected exactly once.
const TEST_RENAMES = [
	['"pi-harness-chat"', '"pi-harness-test-chat"'], // the panel's view type
	['"pi-harness"', '"pi-harness-test"'], // obsidian://pi-harness
];

function testBuild(mainJs) {
	for (const [from, to] of TEST_RENAMES) {
		const count = mainJs.split(from).length - 1;
		if (count !== 1) throw new Error(`Expected ${from} once in main.js, found it ${count} times; update TEST_RENAMES in scripts/install.mjs.`);
		mainJs = mainJs.replace(from, to);
	}
	return mainJs;
}

const vault = vaultArg ?? process.env.OBSIDIAN_VAULT ?? openVault();
if (!vault || !existsSync(join(vault, ".obsidian"))) {
	console.error(`Not an Obsidian vault: ${vault ?? "(none found)"}\nUsage: npm run install:vault -- /path/to/vault`);
	process.exit(1);
}
if (!existsSync(join(root, "main.js"))) {
	console.error("main.js is missing. Run `npm run build` first.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const released = manifest.id;
// The test copy's version names the build it carries, such as 0.1.16-test.20260923.1506, so
// Settings → Community plugins shows which build is installed.
const builtAt = statSync(join(root, "main.js")).mtime;
const stamp = (n) => String(n).padStart(2, "0");
const buildStamp = `${builtAt.getFullYear()}${stamp(builtAt.getMonth() + 1)}${stamp(builtAt.getDate())}.${stamp(builtAt.getHours())}${stamp(builtAt.getMinutes())}`;
if (testCopy) Object.assign(manifest, { id: `${released}-test`, name: `${manifest.name} (test)`, version: `${manifest.version}-test.${buildStamp}` });
const pluginsDir = join(vault, ".obsidian", "plugins");
const dest = join(pluginsDir, manifest.id);
mkdirSync(dest, { recursive: true });

const mainJs = readFileSync(join(root, "main.js"), "utf8");
writeFileSync(join(dest, "main.js"), testCopy ? testBuild(mainJs) : mainJs);
writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
cpSync(join(root, "styles.css"), join(dest, "styles.css"));
// Replace rather than merge, so files removed from the repo don't linger. data.json is left alone.
for (const dir of ["bin", "pi-extension"]) {
	rmSync(join(dest, dir), { recursive: true, force: true });
	cpSync(join(root, dir), join(dest, dir), { recursive: true });
}

const releasedData = join(pluginsDir, released, "data.json");
if (testCopy && !existsSync(join(dest, "data.json")) && existsSync(releasedData)) {
	const settings = JSON.parse(readFileSync(releasedData, "utf8"));
	writeFileSync(join(dest, "data.json"), JSON.stringify({ ...settings, lastSessionFile: "", hiddenTodos: {} }, null, "\t"));
	console.log(`Copied the settings of ${released}, without its last session.`);
}

console.log(`Installed ${manifest.id} ${manifest.version} to ${dest}`);
if (testCopy) console.log(`Enable "${manifest.name}" under Settings → Community plugins. Don't open one session in both panels at once.`);
