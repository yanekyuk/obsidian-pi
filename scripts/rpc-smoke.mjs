// Headless check of the plugin's pi integration, without Obsidian.
// Bundles the real PiRpcClient + resolveEnv, then talks to a live pi process.
//
//   npm run test:rpc              handshake only (no model call)
//   npm run test:rpc -- --prompt  also streams one tiny prompt through the model
//   npm run test:rpc -- --prompt --compact  also pads the session so compaction really runs
//
// To mimic Obsidian launched from the Dock, run it with a bare environment:
//   env -i HOME="$HOME" SHELL="$SHELL" PATH=/usr/bin:/bin "$(which node)" scripts/rpc-smoke.mjs

import esbuild from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { crc32, deflateSync } from "zlib";
import { bundledFiles } from "./bundled-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pi-harness-smoke-"));
const entry = join(work, "entry.ts");
writeFileSync(
	entry,
	`export { PiRpcClient } from ${JSON.stringify(join(root, "src/rpc/PiRpcClient.ts"))};
export { resolveEnv } from ${JSON.stringify(join(root, "src/env.ts"))};
export { listSessions } from ${JSON.stringify(join(root, "src/sessions.ts"))};
export { splitHeader, splitPreviews, parseOptions, parseMultiSelect } from ${JSON.stringify(join(root, "src/view/InlineDialogs.ts"))};
export { parsePiList, findRequired, REQUIRED_PACKAGES, SKILLS_PACKAGE, OBSIDIAN_SKILLS, versionAt } from ${JSON.stringify(join(root, "src/requirements.ts"))};
export { vaultMcpServers, probeMcp, unusableMcpServers } from ${JSON.stringify(join(root, "src/mcp.ts"))};
export { tasksFrom } from ${JSON.stringify(join(root, "src/view/TodoPanel.ts"))};
export { TOOL_RENDERERS } from ${JSON.stringify(join(root, "src/view/toolRenderers.ts"))};
export { summarize } from ${JSON.stringify(join(root, "src/view/TabSwitcher.ts"))};
export { extractBundledFiles } from ${JSON.stringify(join(root, "src/bundled.ts"))};
export { savedTabsFrom } from ${JSON.stringify(join(root, "src/view/savedTabs.ts"))};`,
);
// sessions.ts reaches prompt.ts, which imports the Obsidian API; outside the app a stub will do.
const obsidianStub = {
	name: "obsidian-stub",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "export class MarkdownView {}\nexport const MarkdownRenderer = {};\nexport const setIcon = () => {};",
		}));
	},
};
const outfile = join(work, "bundle.mjs");
await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, logLevel: "error", plugins: [obsidianStub, bundledFiles] });
const { PiRpcClient, resolveEnv, listSessions, splitHeader, splitPreviews, parseOptions, parseMultiSelect, parsePiList, findRequired, REQUIRED_PACKAGES, SKILLS_PACKAGE, OBSIDIAN_SKILLS, versionAt, tasksFrom, TOOL_RENDERERS, vaultMcpServers, probeMcp, unusableMcpServers, summarize, savedTabsFrom, extractBundledFiles } =
	await import(pathToFileURL(outfile).href);

const withPrompt = process.argv.includes("--prompt");
const check = (ok, label, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
	if (!ok) process.exitCode = 1;
};

// ---- session titles, from hand-written files (no pi needed)
{
	const dir = join(work, "fixtures");
	mkdirSync(dir);
	const line = (o) => JSON.stringify(o) + "\n";
	const header = line({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/v" });
	const user = (text) => line({ type: "message", id: "u1", parentId: null, message: { role: "user", content: text } });
	const info = (name) => line({ type: "session_info", id: "i1", parentId: "u1", name });
	writeFileSync(join(dir, "a-unnamed.jsonl"), header + user("<obsidian-context>\nActive note: Inbox.md\n</obsidian-context>\n\nSummarize   this\nnote"));
	writeFileSync(join(dir, "b-named.jsonl"), header + user("first prompt") + info("Old name") + user("more") + info("New name"));
	writeFileSync(join(dir, "c-cleared.jsonl"), header + user("back to the prompt") + info("Temporary") + info(""));
	// A transcript that merely talks about session_info entries must not be mistaken for one.
	writeFileSync(join(dir, "d-mention.jsonl"), header + user([{ type: "text", text: 'what does {"type":"session_info"} mean' }]));
	writeFileSync(join(dir, "e-empty.jsonl"), header);
	writeFileSync(join(dir, "ignored.txt"), "not a session");
	const byFile = Object.fromEntries((await listSessions(dir)).map((s) => [s.path.split("/").pop(), s]));
	check(Object.keys(byFile).length === 5, "listSessions finds only .jsonl files");
	check(byFile["a-unnamed.jsonl"].title === "Summarize this note" && !byFile["a-unnamed.jsonl"].named, "unnamed session: first prompt, context block stripped", byFile["a-unnamed.jsonl"].title);
	check(byFile["b-named.jsonl"].title === "New name" && byFile["b-named.jsonl"].named, "named session: latest name wins");
	check(byFile["c-cleared.jsonl"].title === "back to the prompt" && !byFile["c-cleared.jsonl"].named, "cleared name falls back to the first prompt");
	check(byFile["d-mention.jsonl"].title.startsWith("what does") && !byFile["d-mention.jsonl"].named, "a message mentioning session_info is not a name");
	check(byFile["e-empty.jsonl"].title === "Empty session", "session with no messages");
}

// ---- bundled files: what an install from the community list has to unpack for itself
{
	const { execFileSync } = await import("child_process");
	const { statSync } = await import("fs");
	const target = join(work, "plugin-dir");
	await extractBundledFiles(target);
	const same = (dir) => {
		try {
			execFileSync("diff", ["-r", "-x", ".DS_Store", join(root, dir), join(target, dir)]);
			return true;
		} catch {
			return false;
		}
	};
	check(same("bin"), "bin/ unpacks from the bundle exactly as it is in the repo");
	check((statSync(join(target, "bin/obsidian")).mode & 0o111) !== 0, "the CLI launcher is executable after unpacking");
	writeFileSync(join(target, "bin/obsidian"), "tampered");
	await extractBundledFiles(target);
	check(same("bin"), "a changed file is put right on the next load");
	check(!existsSync(join(root, "skills")) && !existsSync(join(target, "skills")), "no copy of anyone's skills in the repo or the bundle");
}

// ---- update detection: npm packages have a version, a git package of plain folders has a commit
{
	const { execFileSync } = await import("child_process");
	const npmPkg = join(work, "npm-pkg");
	mkdirSync(npmPkg);
	writeFileSync(join(npmPkg, "package.json"), JSON.stringify({ version: "2.10.1" }));
	check(versionAt(npmPkg) === "2.10.1", "an npm package is known by its version");
	const gitPkg = join(work, "git-pkg");
	mkdirSync(gitPkg);
	const git = (...args) => execFileSync("git", ["-C", gitPkg, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
	git("init", "-q");
	writeFileSync(join(gitPkg, "SKILL.md"), "one");
	git("add", "-A");
	git("commit", "-q", "-m", "one");
	const first = versionAt(gitPkg);
	check(first === git("rev-parse", "--short=7", "HEAD"), "a git package without package.json is known by its commit", first);
	writeFileSync(join(gitPkg, "SKILL.md"), "two");
	git("commit", "-qam", "two");
	git("pack-refs", "--all");
	check(versionAt(gitPkg) === git("rev-parse", "--short=7", "HEAD") && versionAt(gitPkg) !== first, "a pulled update shows as a new commit, packed refs included");
	check(versionAt(join(work, "nowhere")) === null, "a folder that is neither has no version");
}

// ---- tabs: what the title shows for the tabs out of sight, and what the layout brings back
{
	const tabs = (...statuses) => statuses.map((status) => ({ status }));
	check(summarize(tabs("idle", "unloaded")) === null, "idle and unloaded tabs need no mark");
	const busy = summarize(tabs("working", "idle", "working"));
	check(busy?.status === "working" && busy.count === 2, "working tabs are counted", busy?.label);
	const mixed = summarize(tabs("working", "unread", "asking", "working"));
	check(mixed?.status === "asking" && mixed.count === 1 && mixed.label === "Other tabs: 1 waiting for you, 1 finished, 2 working", "a question outranks finished and working tabs", mixed?.label);

	const saved = savedTabsFrom({ tabs: [{ sessionFile: "/s/a.jsonl", title: "A" }, { title: "no file" }, { sessionFile: "/s/b.jsonl" }], active: 1 });
	check(saved?.tabs.length === 2 && saved.tabs[1].title === "" && saved.active === 1, "saved tabs: entries without a file are dropped");
	check(savedTabsFrom({ sessionFile: "/s/old.jsonl" })?.tabs[0].sessionFile === "/s/old.jsonl", "saved tabs: a single-session layout from before tabs still opens");
	check(savedTabsFrom({ fresh: true })?.tabs.length === 0 && savedTabsFrom({}) === null && savedTabsFrom(null) === null, "saved tabs: fresh panel vs. no saved state");
}

// ---- question cards: the panel's decoder against the real encoder in rpiv-ask-user-question
{
	const fallback = join(homedir(), ".pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/rpc-fallback.ts");
	if (!existsSync(fallback)) {
		console.log("SKIP  rpiv-ask-user-question is not installed; question decoding not checked");
	} else {
		const out = join(work, "fallback.mjs");
		await esbuild.build({ entryPoints: [fallback], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error", packages: "external" });
		const { runRpcQuestionnaire } = await import(pathToFileURL(out).href);
		const seen = {};
		// Stands in for the panel: decode what the extension sends, "click" by returning what the card would.
		const ui = {
			select: async (title, options) => {
				const { header, body } = splitHeader(title);
				const { question, previews } = splitPreviews(body);
				seen.select = { header, question, options: parseOptions(options, previews) };
				return seen.select.options[1].value;
			},
			input: async (title, placeholder) => {
				seen.multi = parseMultiSelect({ method: "input", title, placeholder });
				seen.multiHeader = seen.multi && splitHeader(seen.multi.question);
				return "1,3";
			},
		};
		const result = await runRpcQuestionnaire(ui, {
			questions: [
				{ header: "Library", question: "Which date library?", options: [{ label: "dayjs", description: "Small and familiar" }, { label: "date-fns", description: "Tree-shakeable — functional", preview: "import { format } from 'date-fns'\n\nformat(d, 'P')" }] },
				{ header: "Scope", question: "Which folders?", multiSelect: true, options: [{ label: "Journal", description: "Daily notes" }, { label: "People", description: "Contacts" }, { label: "Projects", description: "Active work" }] },
			],
		});
		const s = seen.select;
		check(s?.header === "Library" && s.question === "Which date library?", "question card: header chip and question are separated", `${s?.header} / ${s?.question}`);
		check(s?.options.length === 3 && s.options[0].label === "dayjs" && s.options[0].description === "Small and familiar", "question card: options split into label and description");
		check(s?.options[1].description === "Tree-shakeable — functional", "question card: a description containing a dash survives", s?.options[1].description);
		check(s?.options[1].preview.includes("format(d, 'P')") && s.options[0].preview === "", "question card: previews attach to their option");
		check(s?.options[2].description === "" && /type/i.test(s.options[2].label), "question card: the free-text row is kept", s?.options[2].label);
		const m = seen.multi;
		check(m?.options.map((o) => o.label).join() === "Journal,People,Projects" && seen.multiHeader.header === "Scope" && seen.multiHeader.body === "Which folders?", "multi-select: decoded into checkboxes, typing instructions dropped");
		check(result.answers[0]?.answer === "date-fns" && result.answers[0].kind === "option", "round trip: clicking option 2 answers with its label", result.answers[0]?.answer);
		check(result.answers[1]?.selected?.join() === "Journal,Projects" && !result.cancelled, "round trip: ticking boxes 1 and 3 selects those labels", result.answers[1]?.selected?.join());
		check(parseMultiSelect({ method: "input", title: "Enter a value", placeholder: "type something..." }) === null, "an ordinary input is not mistaken for a multi-select");
		const plain = parseOptions(["Allow", "Block"], new Map());
		check(plain[0].label === "Allow" && plain[0].value === "Allow" && plain[0].description === "", "an ordinary select keeps its options as they are");
	}
}

// ---- tasks and tool cards
{
	const details = { action: "update", tasks: [{ id: 1, subject: "Write parser", status: "completed" }, { id: 2, subject: "Add tests", activeForm: "Adding tests", status: "in_progress", blockedBy: [1] }, { junk: true }], nextId: 3 };
	check(tasksFrom(details)?.length === 2 && tasksFrom({}) === null && tasksFrom(null) === null, "task snapshot is read from details.tasks, junk ignored");
	const todo = TOOL_RENDERERS.todo;
	check(todo.summary({ action: "create", subject: "Write parser" }) === "Write parser", "todo card: create shows the task");
	check(todo.summary({ action: "update", id: 2, status: "in_progress" }) === "#2 → in progress", "todo card: update shows id until the result arrives");
	check(todo.summary({ action: "update", id: 2, status: "in_progress" }, { details }) === "Add tests → in progress", "todo card: update names the task once the snapshot is in");
	check(TOOL_RENDERERS.web_search.summary({ query: "obsidian bases" }, { details: { resultCount: 5 } }) === "obsidian bases · 5 results", "web_search card: query and result count");
	check(TOOL_RENDERERS.ask_user_question.summary({ questions: [{ question: "A?" }, { question: "B?" }] }) === "A? (+1)", "ask_user_question card: first question and count");
}

// ---- MCP availability: the probe is a real `initialize`, against real listeners
{
	const { createServer } = await import("http");
	let lastBody = "";
	const listen = (status) =>
		new Promise((res) => {
			const server = createServer((req, reply) => {
				let body = "";
				req.on("data", (d) => (body += d)).on("end", () => {
					lastBody = body;
					reply.statusCode = status;
					reply.end(status === 200 ? '{"jsonrpc":"2.0","id":1,"result":{}}' : "");
				});
			});
			server.listen(0, "127.0.0.1", () => res(server));
		});
	const [ok, needsAuth, notMcp] = await Promise.all([listen(200), listen(401), listen(404)]);
	const url = (server) => `http://127.0.0.1:${server.address().port}/mcp`;
	const vault = join(work, "vault");
	mkdirSync(vault);
	check((await vaultMcpServers(vault)).length === 0, "mcp: a vault without .mcp.json has nothing to check");
	writeFileSync(join(vault, ".mcp.json"), JSON.stringify({ mcpServers: {
		working: { type: "http", url: url(ok) },
		auth: { type: "http", url: url(needsAuth) },
		squatter: { type: "http", url: url(notMcp) },
		dead: { type: "http", url: "http://127.0.0.1:1/mcp" },
		off: { type: "http", url: "http://127.0.0.1:1/mcp", disabled: true },
		stdio: { command: "npx", args: ["some-server"] },
	} }));
	check((await vaultMcpServers(vault)).map((s) => s.name).join() === "working,auth,squatter,dead", "mcp: only enabled HTTP servers are checked (stdio and disabled skipped)");
	check((await probeMcp(url(ok))) === null && JSON.parse(lastBody).method === "initialize", "mcp: the probe is an MCP initialize request, and a 200 means usable");
	check((await probeMcp(url(needsAuth))) === null, "mcp: a server asking for auth is up (auth is the adapter's job)");
	const bad = await unusableMcpServers(vault);
	check(bad.map((s) => s.name).join() === "squatter,dead", "mcp: reported: the port answering 404 and the dead one", bad.map((s) => `${s.name}: ${s.reason}`).join(" | "));
	const okUrl = url(ok);
	await new Promise((r) => ok.close(r));
	check((await probeMcp(okUrl)) !== null, "mcp: the working server is reported once it stops");
	needsAuth.close();
	notMcp.close();
}

// ---- required extensions, against the real `pi list`
{
	const sample = "User packages:\n  npm:@juicesharp/rpiv-todo\n    /u/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo\n  git:github.com/x/y (filtered)\n    /u/.pi/agent/git/github.com/x/y\n  ../../Projects/rpiv-mono/packages/rpiv-web-tools\n    /u/Projects/rpiv-mono/packages/rpiv-web-tools\n";
	const parsed = parsePiList(sample);
	check(parsed.length === 3 && parsed[1].source === "git:github.com/x/y", "pi list: sources paired with paths, (filtered) stripped");
	const found = findRequired(parsed);
	check(found.get("rpiv-todo")?.source.startsWith("npm:") && found.get("rpiv-web-tools")?.source.startsWith("../") && found.get("rpiv-btw") === null, "requirements: a local checkout counts as installed; absent ones are missing");
}

console.log(`inherited PATH: ${process.env.PATH}`);
const env = await resolveEnv();
check(env.PATH.split(":").length > (process.env.PATH ?? "").split(":").length || env.PATH.includes("homebrew"), "resolveEnv widened PATH", `${env.PATH.split(":").length} entries`);

{
	const { execFileSync } = await import("child_process");
	const real = findRequired(parsePiList(execFileSync("pi", ["list"], { env, encoding: "utf8" })));
	const missing = REQUIRED_PACKAGES.filter((name) => !real.get(name));
	check(missing.length === 0, "all six required extensions are found in this machine's `pi list`", missing.length ? `missing: ${missing.join(", ")}` : [...real.values()].map((p) => p.source.replace("npm:@juicesharp/", "")).join(", "));
}

const client = new PiRpcClient();
const events = [];
client.onEvent((e) => events.push(e));
let exitInfo = null;
client.onExit((info) => (exitInfo = info));

// cwd is a scratch dir, not a vault: nothing personal gets loaded. The Obsidian skills come
// from their author's repository the way the plugin installs them, except that `-e` fetches
// the package for this run only and leaves this machine's pi settings alone.
await client.start({
	binary: "pi",
	args: ["--session-dir", join(work, "sessions"), "--thinking", "minimal", "-e", SKILLS_PACKAGE.source],
	cwd: work,
	env,
});
check(client.running, "pi spawned in rpc mode");

const state = await client.getState();
check(typeof state.thinkingLevel === "string", "get_state", `model=${state.model?.provider}/${state.model?.id} thinking=${state.thinkingLevel}`);

const commands = await client.getCommands();
const fromPackage = OBSIDIAN_SKILLS.filter((name) => commands.some((c) => c.name === `skill:${name}` && /obsidian-skills/.test(c.sourceInfo?.path ?? "")));
check(fromPackage.length === OBSIDIAN_SKILLS.length, `the Obsidian skills load from ${SKILLS_PACKAGE.source} as a pi package`, `${fromPackage.length}/${OBSIDIAN_SKILLS.length}: ${fromPackage.join(", ")}`);

const levels = await client.getAvailableThinkingLevels();
check(Array.isArray(levels) && levels.length > 0, "get_available_thinking_levels", levels.join(","));
const models = await client.getAvailableModels();
check(models.length > 0, "get_available_models", `${models.length} models`);
check((await client.getMessages()).length === 0, "get_messages on a fresh session is empty");

let rejected = false;
await client.setModel("no-such-provider", "no-such-model").catch(() => (rejected = true));
check(rejected, "failed commands reject instead of hanging");

if (withPrompt) {
	const settled = new Promise((res) => client.onEvent((e) => e.type === "agent_settled" && res()));
	await client.prompt("Reply with exactly the word: pong");
	await Promise.race([settled, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for agent_settled")), 90_000))]);
	const types = new Set(events.map((e) => e.type));
	const deltas = events.filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta");
	const streamed = deltas.map((e) => e.assistantMessageEvent.delta).join("");
	const final = events.filter((e) => e.type === "message_end" && e.message.role === "assistant").pop();
	const finalText = final?.message.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
	check(types.has("agent_start") && types.has("agent_settled"), "agent_start … agent_settled lifecycle");
	check(events.some((e) => e.type === "message_start" && e.message.role === "user"), "user message echoed via message_start");
	check(streamed.length > 0 && streamed === finalText, "streamed deltas reassemble to the final text", JSON.stringify(finalText));
	check(/pong/i.test(finalText), "model answered");
	const stats = await client.getSessionStats();
	check(stats.tokens.total > 0, "get_session_stats", `${stats.tokens.total} tokens, $${stats.cost.toFixed(4)}`);

	// ---- sessions, against files pi really wrote
	const original = (await client.getState()).sessionFile;
	const dir = dirname(original);
	check(existsSync(original), "session file is on disk after the first exchange");
	let list = await listSessions(dir);
	check(list.length === 1 && list[0].title === "Reply with exactly the word: pong" && !list[0].named, "new session is listed under its first prompt", list[0]?.title);

	await client.setSessionName("Smoke test name");
	list = await listSessions(dir);
	check(list[0].title === "Smoke test name" && list[0].named, "rename shows up in the list (pi's session_info format matches)", list[0].title);
	check((await client.getState()).sessionName === "Smoke test name", "get_state reports the new name");

	const cloned = await client.cloneSession();
	const copy = (await client.getState()).sessionFile;
	check(!cloned.cancelled && copy !== original && existsSync(copy), "clone moves pi onto a new session file");
	check((await listSessions(dir)).length === 2, "clone is listed as a second session");

	const switched = await client.switchSession(original);
	check(!switched.cancelled && (await client.getState()).sessionFile === original, "switch_session returns to the original");
	check((await client.getMessages()).length >= 2, "switched session brings its transcript");

	// ---- images: a solid red PNG sent with no text at all, the way a bare paste goes out
	const png = (() => {
		const size = 32;
		const chunk = (type, data) => {
			const body = Buffer.concat([Buffer.from(type), data]);
			const out = Buffer.alloc(body.length + 8);
			out.writeUInt32BE(data.length, 0);
			body.copy(out, 4);
			out.writeUInt32BE(crc32(body), body.length + 4);
			return out;
		};
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(size, 0);
		ihdr.writeUInt32BE(size, 4);
		ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
		const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [255, 0, 0]).flat())]);
		const pixels = Buffer.concat(Array.from({ length: size }, () => row));
		return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
	})();
	const before = events.length;
	const settledAgain = new Promise((res) => client.onEvent((e) => e.type === "agent_settled" && res()));
	let accepted = true;
	await client.prompt("", { images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] }).catch((err) => {
		accepted = false;
		console.log("      prompt error:", err.message);
	});
	check(accepted, "pi accepts a message that is only an image");
	if (accepted) {
		await Promise.race([settledAgain, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out on the image prompt")), 90_000))]);
		const fresh = events.slice(before);
		const echoed = fresh.find((e) => e.type === "message_start" && e.message.role === "user")?.message.content;
		check(Array.isArray(echoed) && echoed.some((b) => b.type === "image" && b.mimeType === "image/png"), "user message comes back with its image block (transcript can show it)");
		const reply = fresh.filter((e) => e.type === "message_end" && e.message.role === "assistant").pop()?.message;
		const replyText = reply?.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
		check(/red/i.test(replyText), "the model saw the image", JSON.stringify(replyText.slice(0, 80)));
		const stored = (await client.getMessages()).filter((m) => m.role === "user").pop();
		check(Array.isArray(stored?.content) && stored.content.some((b) => b.type === "image"), "get_messages keeps the image, so it survives a session reload");
	}

	// ---- /compact with instructions. pi refuses to compact a small session, so --compact
	// first pads this one with a long message (costs a few cents more than the other checks).
	if (process.argv.includes("--compact")) {
		const filler = Array.from({ length: 1400 }, (_, i) => `Line ${i}: the archive shelf ${i % 97} holds folder ${i * 7}.`).join("\n");
		for (const text of [`Here is an inventory. Reply with just: noted\n\n${filler}`, "Reply with just: ok"]) {
			const done = new Promise((res) => client.onEvent((e) => e.type === "agent_settled" && res()));
			await client.prompt(text);
			await done;
		}
	}
	const beforeCompact = events.length;
	let compactError = null;
	const summary = await client.compact("Keep the fact that the user asked for the word pong.").catch((err) => (compactError = err.message));
	if (compactError) {
		// A two-message session can be too small for pi to compact; that is pi's call, not a plugin fault.
		console.log(`NOTE  compact was declined by pi: ${compactError}`);
	} else {
		const seenEvents = events.slice(beforeCompact);
		const end = seenEvents.find((e) => e.type === "compaction_end");
		check(seenEvents.some((e) => e.type === "compaction_start" && e.reason === "manual"), "compact: compaction_start arrives with reason manual");
		check(typeof summary?.summary === "string" && summary.summary.length > 0, "compact: returns a summary", JSON.stringify(summary.summary.slice(0, 70)));
		check(end && !end.errorMessage && end.result?.tokensBefore > 0, "compact: compaction_end carries token counts for the notice", `${end?.result?.tokensBefore} → ${end?.result?.estimatedTokensAfter}`);
	}

	let refused = false;
	await client.setSessionName("").catch(() => (refused = true));
	check(refused, "pi refuses an empty session name (so the plugin never sends one)");
}

await client.stop();
check(!client.running && exitInfo?.expected === true, "stop() shuts pi down and reports the exit as expected");
