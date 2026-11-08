import builtins from "builtin-modules";

// Obsidian Mobile runs inside a mobile webview where `require("obsidian")` exists, but Node
// built-ins (`fs`, `path`, `os`, `child_process`, `http`, `https`, `crypto`) and `electron`
// throw "Cannot find module" when required. Wrapping external Node/Electron imports in a
// try/catch with pure-JS fallbacks for `path` and `string_decoder` lets the single main.js
// bundle load on iOS and Android while still using real Node/Electron modules on desktop.

const NODE_MODULES = new Set(["electron", ...builtins, ...builtins.map((m) => `node:${m}`)]);

const SHIM_SOURCE = `
const rawRequire = typeof require === "function" ? require : null;
function tryRequire(id) {
	if (!rawRequire) return null;
	try {
		return rawRequire(id);
	} catch {
		return null;
	}
}

function splitParts(path, allowAboveRoot) {
	const res = [];
	for (const p of path.split("/")) {
		if (!p || p === ".") continue;
		if (p === "..") {
			if (res.length && res[res.length - 1] !== "..") res.pop();
			else if (allowAboveRoot) res.push("..");
		} else {
			res.push(p);
		}
	}
	return res;
}

function normalize(path) {
	if (!path) return ".";
	const isAbs = path.startsWith("/");
	const trailing = path.endsWith("/");
	const parts = splitParts(path, !isAbs).join("/");
	if (!parts && !isAbs) return ".";
	const out = (isAbs ? "/" : "") + parts;
	return out && trailing && !out.endsWith("/") ? out + "/" : out || "/";
}

function isAbsolute(path) {
	return Boolean(path && path.startsWith("/"));
}

function join(...paths) {
	const joined = paths.filter(Boolean).join("/");
	return joined ? normalize(joined) : ".";
}

function resolve(...paths) {
	let resolvedPath = "";
	let resolvedAbsolute = false;
	for (let i = paths.length - 1; i >= 0 && !resolvedAbsolute; i--) {
		const path = paths[i];
		if (!path) continue;
		resolvedPath = path + "/" + resolvedPath;
		resolvedAbsolute = path.startsWith("/");
	}
	if (!resolvedAbsolute) resolvedPath = "/" + resolvedPath;
	return "/" + splitParts(resolvedPath, false).join("/");
}

function dirname(path) {
	if (!path) return ".";
	const stripped = path.length > 1 ? path.replace(/\\/+$/, "") : path;
	const idx = stripped.lastIndexOf("/");
	if (idx === -1) return ".";
	if (idx === 0) return "/";
	return stripped.slice(0, idx);
}

function basename(path, ext) {
	if (!path) return "";
	const stripped = path.replace(/\\/+$/, "");
	const base = stripped.slice(stripped.lastIndexOf("/") + 1);
	return ext && base.endsWith(ext) ? base.slice(0, base.length - ext.length) : base;
}

function relative(from, to) {
	const f = resolve(from);
	const t = resolve(to);
	if (f === t) return "";
	const fParts = f.split("/").filter(Boolean);
	const tParts = t.split("/").filter(Boolean);
	let common = 0;
	while (common < fParts.length && common < tParts.length && fParts[common] === tParts[common]) common++;
	return [...Array(fParts.length - common).fill(".."), ...tParts.slice(common)].join("/");
}

const posixPath = { sep: "/", delimiter: ":", normalize, isAbsolute, join, resolve, dirname, basename, relative };

class WebStringDecoder {
	constructor(encoding = "utf-8") {
		this.decoder = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding);
	}
	write(buf) {
		if (typeof buf === "string") return buf;
		return this.decoder.decode(buf, { stream: true });
	}
	end(buf) {
		return (buf ? this.write(buf) : "") + this.decoder.decode();
	}
}

const unavailable = (mod) => () => {
	throw new Error(\`\${mod} is not available on Obsidian Mobile.\`);
};

const fallbacks = {
	path: posixPath,
	"string_decoder": { StringDecoder: WebStringDecoder },
	os: { homedir: () => "", tmpdir: () => "/tmp", networkInterfaces: () => ({}) },
	fs: {
		existsSync: () => false,
		readFileSync: unavailable("fs.readFileSync"),
		writeFileSync: unavailable("fs.writeFileSync"),
		mkdirSync: unavailable("fs.mkdirSync"),
		promises: new Proxy({}, { get: () => async () => unavailable("fs.promises")() }),
	},
	child_process: {
		spawn: unavailable("child_process.spawn"),
		execFile: unavailable("child_process.execFile"),
	},
	http: {
		createServer: unavailable("http.createServer"),
		request: unavailable("http.request"),
	},
	https: {
		request: unavailable("https.request"),
	},
	crypto: {
		randomBytes: (size) => {
			const bytes = new Uint8Array(size);
			globalThis.crypto?.getRandomValues?.(bytes);
			return {
				toString: () => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
			};
		},
		createHash: unavailable("crypto.createHash"),
		timingSafeEqual: unavailable("crypto.timingSafeEqual"),
	},
	electron: {
		shell: {
			trashItem: unavailable("electron.shell.trashItem"),
			openPath: async () => "Opening external files is only available on desktop.",
		},
	},
};

export function loadNodeModule(id) {
	const clean = id.replace(/^node:/, "");
	return tryRequire(id) ?? tryRequire(clean) ?? fallbacks[clean] ?? {};
}
`;

export const mobileShims = {
	name: "mobile-shims",
	setup(build) {
		build.onResolve({ filter: /^__mobile_shims__$/ }, () => ({ path: "runtime", namespace: "mobile-shims-runtime" }));
		build.onLoad({ filter: /.*/, namespace: "mobile-shims-runtime" }, () => ({ contents: SHIM_SOURCE, loader: "js" }));

		build.onResolve({ filter: /.*/ }, (args) => {
			if (args.namespace === "mobile-shims-runtime" || args.namespace === "mobile-shims") return null;
			if (!NODE_MODULES.has(args.path)) return null;
			return { path: args.path, namespace: "mobile-shims" };
		});

		build.onLoad({ filter: /.*/, namespace: "mobile-shims" }, (args) => ({
			contents: `const { loadNodeModule } = require("__mobile_shims__"); module.exports = loadNodeModule(${JSON.stringify(args.path)});`,
			loader: "js",
		}));
	},
};
