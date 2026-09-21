import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

// Obsidian's plugin installer downloads main.js, manifest.json and styles.css and nothing else,
// so the launcher for Obsidian's CLI travels inside main.js and is written out when the plugin
// loads (src/bundled.ts). This esbuild plugin provides them as the "bundled-files" module.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_DIRS = ["bin"].map((dir) => join(root, dir));
const filesUnder = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.name === ".DS_Store" ? [] : [join(dir, e.name)]));

export const bundledFiles = {
	name: "bundled-files",
	setup(build) {
		build.onResolve({ filter: /^bundled-files$/ }, () => ({ path: "bundled-files", namespace: "bundled-files" }));
		build.onLoad({ filter: /.*/, namespace: "bundled-files" }, () => {
			const paths = BUNDLED_DIRS.flatMap(filesUnder);
			const files = Object.fromEntries(paths.map((p) => [relative(root, p).split("\\").join("/"), readFileSync(p, "utf8")]));
			return { contents: `export default ${JSON.stringify(files)};`, loader: "js", watchFiles: paths, watchDirs: BUNDLED_DIRS };
		});
	},
};
