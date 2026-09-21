import { promises as fs } from "fs";
import { dirname, join } from "path";
import files from "bundled-files";

// Writes the CLI launcher into the plugin folder. Obsidian installs only main.js,
// manifest.json and styles.css, so after an install or update from the community list this is
// how the rest gets there. Files that are already right are left alone.
export async function extractBundledFiles(pluginDir: string): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const target = join(pluginDir, path);
		const current = await fs.readFile(target, "utf8").catch(() => null);
		if (current !== content) {
			await fs.mkdir(dirname(target), { recursive: true });
			await fs.writeFile(target, content);
		}
		if (path.startsWith("bin/")) await fs.chmod(target, 0o755);
	}
}
