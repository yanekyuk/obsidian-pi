import { execFile, spawn } from "child_process";
import type { AgentBackend } from "./rpc/AgentClient";
import type { AgentMessage } from "./rpc/types";
import { contentText } from "./sessions";
import { splitContext } from "./prompt";

// Tools that modify files or note properties on disk, across Pi, Agy, and built-in extensions.
export const FILE_MUTATING_TOOLS = new Set([
	"edit",
	"write",
	"edit_file",
	"write_file",
	"hashline_edit",
	"obsidian_set_properties",
	"create_file",
	"replace_file_content",
	"multi_replace_file_content",
]);

export function extractTouchedPath(toolName: string, args: Record<string, unknown> | undefined): string | null {
	if (!FILE_MUTATING_TOOLS.has(toolName) || !args) return null;
	for (const key of ["path", "Path", "file", "filePath", "target_file", "TargetFile"]) {
		const val = args[key];
		if (typeof val === "string" && val.trim()) return val.trim();
	}
	return null;
}

// ---------------------------------------------------------------- Verify-on-Stop oracle

export interface VerifyResult {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	summary: string;
	output: string;
	durationMs: number;
}

const MAX_VERIFY_CAPTURE_CHARS = 64_000;
const VERIFY_PROMPT_LINES = 30;
const VERIFY_PROMPT_CHARS = 4_000;

export function runVerifyCommand(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs = 60_000,
): Promise<VerifyResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let timedOut = false;

		const append = (chunk: Buffer | string) => {
			out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (out.length > MAX_VERIFY_CAPTURE_CHARS) out = out.slice(-MAX_VERIFY_CAPTURE_CHARS);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
		}, timeoutMs);

		const finish = (exitCode: number | null, err?: Error) => {
			clearTimeout(timer);
			const text = (err ? `${out}\n${err.message}` : out).trim();
			const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
			const ok = !timedOut && !err && exitCode === 0;
			const summary = timedOut
				? `timed out after ${Math.round(timeoutMs / 1000)}s`
				: lines[0]?.slice(0, 140) || (ok ? "passed" : `exited with code ${exitCode ?? "unknown"}`);
			resolve({ ok, exitCode, timedOut, summary, output: text, durationMs: Date.now() - started });
		};

		child.once("error", (err) => finish(null, err));
		child.once("close", (code) => finish(code));
	});
}

export function formatVerifyRetryPrompt(
	command: string,
	result: VerifyResult,
	attempt: number,
	maxRetries: number,
): string {
	const lines = result.output.split(/\r?\n/).slice(0, VERIFY_PROMPT_LINES).join("\n");
	const clipped = lines.length > VERIFY_PROMPT_CHARS ? `${lines.slice(0, VERIFY_PROMPT_CHARS)}\n[… truncated]` : lines;
	return [
		`[Harness verify-on-stop · attempt ${attempt}/${maxRetries}]`,
		`Verification command \`${command}\` failed (${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`}).`,
		"",
		"```",
		clipped || "(no output)",
		"```",
		"",
		"Fix ONLY the reported verification errors above without weakening the verification script or test fixtures, then finish.",
	].join("\n");
}

// ---------------------------------------------------------------- Doom-loop & step-budget guard

export type LoopAlert =
	| { kind: "doom_loop"; toolName: string; count: number; detail: string }
	| { kind: "severe_loop"; toolName: string; count: number; detail: string }
	| { kind: "budget"; count: number; limit: number };

function stableArgsHash(args: Record<string, unknown> | undefined): string {
	if (!args) return "{}";
	const keys = Object.keys(args).sort();
	const parts = keys.map((k) => {
		const v = args[k];
		const raw = typeof v === "string" ? v.slice(0, 200) : JSON.stringify(v)?.slice(0, 200) ?? "";
		return `${k}=${raw}`;
	});
	return parts.join("&");
}

export class LoopGuard {
	private totalCalls = 0;
	private budgetAlerted = false;
	private callArgs = new Map<string, { toolName: string; sig: string }>();
	private repeatCounts = new Map<string, number>();
	private consecutiveToolErrors = { key: "", count: 0 };
	private alertedKeys = new Set<string>();
	private severeAlertedKeys = new Set<string>();

	reset(): void {
		this.totalCalls = 0;
		this.budgetAlerted = false;
		this.callArgs.clear();
		this.repeatCounts.clear();
		this.consecutiveToolErrors = { key: "", count: 0 };
		this.alertedKeys.clear();
		this.severeAlertedKeys.clear();
	}

	get callCount(): number {
		return this.totalCalls;
	}

	onToolStart(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown> | undefined,
		maxCallsPerTurn: number,
	): LoopAlert | null {
		this.totalCalls++;
		const sig = `${toolName}:${stableArgsHash(args)}`;
		this.callArgs.set(toolCallId, { toolName, sig });
		if (maxCallsPerTurn > 0 && !this.budgetAlerted && this.totalCalls >= maxCallsPerTurn) {
			this.budgetAlerted = true;
			return { kind: "budget", count: this.totalCalls, limit: maxCallsPerTurn };
		}
		return null;
	}

	onToolEnd(
		toolCallId: string,
		toolName: string,
		isError: boolean,
		errorSnippet: string,
		threshold: number,
	): LoopAlert | null {
		const info = this.callArgs.get(toolCallId);
		this.callArgs.delete(toolCallId);
		if (threshold <= 0) return null;

		const sig = info?.sig ?? toolName;
		if (isError) {
			const sigCount = (this.repeatCounts.get(sig) ?? 0) + 1;
			this.repeatCounts.set(sig, sigCount);

			const errKey = `${toolName}:${errorSnippet.slice(0, 100).trim()}`;
			if (this.consecutiveToolErrors.key === errKey) this.consecutiveToolErrors.count++;
			else this.consecutiveToolErrors = { key: errKey, count: 1 };

			const count = Math.max(sigCount, this.consecutiveToolErrors.count);
			const alertKey = sigCount >= this.consecutiveToolErrors.count ? sig : errKey;
			const detail = errorSnippet.split(/\r?\n/)[0]?.slice(0, 140) || "repeated tool error";

			if (count >= threshold + 2 && !this.severeAlertedKeys.has(alertKey)) {
				this.severeAlertedKeys.add(alertKey);
				return { kind: "severe_loop", toolName, count, detail };
			}
			if (count >= threshold && !this.alertedKeys.has(alertKey)) {
				this.alertedKeys.add(alertKey);
				return { kind: "doom_loop", toolName, count, detail };
			}
			return null;
		}

		// Reset consecutive error streak on any successful tool call.
		this.consecutiveToolErrors = { key: "", count: 0 };
		// Still catch exact-same-args spinning (e.g. re-reading or re-running identical no-op commands).
		const exactKey = `ok:${sig}`;
		const exactCount = (this.repeatCounts.get(exactKey) ?? 0) + 1;
		this.repeatCounts.set(exactKey, exactCount);
		if (exactCount >= threshold + 1 && !this.alertedKeys.has(exactKey)) {
			this.alertedKeys.add(exactKey);
			return { kind: "doom_loop", toolName, count: exactCount, detail: "identical call repeated without change" };
		}
		return null;
	}
}

// ---------------------------------------------------------------- Friction trace & /retro

export type FrictionKind = "tool_error" | "verify_fail" | "doom_loop" | "user_undo" | "user_abort";

export interface FrictionEntry {
	ts: number;
	kind: FrictionKind;
	backend: AgentBackend;
	sessionTitle?: string;
	tool?: string;
	detail: string;
}

export const MAX_FRICTION_LOG = 100;

export function appendFriction(log: FrictionEntry[], entry: FrictionEntry): FrictionEntry[] {
	const next = [...log, entry];
	return next.length > MAX_FRICTION_LOG ? next.slice(-MAX_FRICTION_LOG) : next;
}

export function buildRetroPrompt(
	sessionEvents: FrictionEntry[],
	globalEvents: FrictionEntry[],
	vaultName: string,
): string {
	const format = (items: FrictionEntry[]) =>
		items.length
			? items
					.slice(-20)
					.map((e) => `- [${e.kind}] (${e.backend}${e.tool ? ` · ${e.tool}` : ""}) ${e.detail}`)
					.join("\n")
			: "- (none recorded)";

	// Count recurring signatures across recent global history to highlight systemic leaks.
	const counts = new Map<string, number>();
	for (const e of globalEvents) {
		const key = `${e.kind}${e.tool ? `:${e.tool}` : ""}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const recurring = [...counts.entries()]
		.filter(([, n]) => n >= 2)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([k, n]) => `- ${k} ×${n}`)
		.join("\n");

	return [
		`Run a short **Harness Engineering Retro** for "${vaultName}" using Mitchell Hashimoto's rule: *whenever an agent makes a mistake, engineer a permanent mechanical fix so that class of mistake cannot recur.*`,
		"",
		"### Friction events in this session",
		format(sessionEvents),
		"",
		"### Recurring patterns across recent sessions",
		recurring || "- (none yet)",
		"",
		"### Instructions",
		"1. Diagnose the top 1–3 root causes from the friction log above (not symptoms).",
		"2. For each root cause, propose a **mechanical harness fix** — ordered by leverage: (a) a check/linter rule in the verify oracle, (b) a tool schema or output improvement, or (c) a 1-line invariant in `AGENTS.md`. Do NOT propose vague multi-paragraph prose instructions.",
		"3. Wait for my approval before editing any harness or linter files.",
	].join("\n");
}

// ---------------------------------------------------------------- Clean Handoff & Blind Evaluator

export interface GitSnapshot {
	status: string;
	diffStat: string;
	diffSnippet: string;
}

function runGit(args: string[], cwd: string, timeoutMs = 5000): Promise<string> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, stdout) => {
			resolve(err ? "" : stdout.trim());
		});
	});
}

export async function readGitSnapshot(cwd: string, maxDiffChars = 8000): Promise<GitSnapshot | null> {
	const inside = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
	if (inside !== "true") return null;
	const [status, diffStat, rawDiff] = await Promise.all([
		runGit(["status", "--short"], cwd),
		runGit(["diff", "--stat"], cwd),
		runGit(["diff", "--unified=2"], cwd),
	]);
	const diffSnippet =
		rawDiff.length > maxDiffChars
			? `${rawDiff.slice(0, maxDiffChars)}\n[… diff truncated at ${maxDiffChars} chars]`
			: rawDiff;
	return { status, diffStat, diffSnippet };
}

export function buildHandoffPrompt(opts: {
	title: string;
	messages: AgentMessage[];
	editedFiles: string[];
	todos?: string | null;
	friction: FrictionEntry[];
	lastVerify?: VerifyResult | null;
	git?: GitSnapshot | null;
}): string {
	const userTexts = opts.messages
		.filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user")
		.map((m) => splitContext(contentText(m.content)).text.trim())
		.filter(Boolean);
	const firstGoal = userTexts[0]?.slice(0, 600) ?? opts.title;
	const latestAsk = userTexts.length > 1 ? userTexts[userTexts.length - 1]?.slice(0, 400) : null;

	const lastAssistant = [...opts.messages]
		.reverse()
		.find((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant");
	const lastSummary = lastAssistant
		? lastAssistant.content
				.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
				.map((b) => b.text.trim())
				.filter(Boolean)
				.join("\n\n")
				.slice(0, 1200)
		: "";

	const sections = [
		`## Clean Handoff Contract (fresh context from "${opts.title}")`,
		"",
		`### Goal\n${firstGoal}`,
		...(latestAsk ? [`### Latest focus\n${latestAsk}`] : []),
		`### Files touched\n${opts.editedFiles.length ? opts.editedFiles.map((f) => `- \`${f}\``).join("\n") : "- (none recorded)"}`,
		...(opts.todos ? [`### Task state\n${opts.todos}`] : []),
		...(opts.lastVerify
			? [`### Last verification\n${opts.lastVerify.ok ? "PASS" : "FAIL"}: ${opts.lastVerify.summary}`]
			: []),
		...(opts.friction.length
			? [
					`### Dead ends & friction (do not repeat)\n${opts.friction
						.slice(-8)
						.map((f) => `- [${f.kind}] ${f.tool ? `${f.tool}: ` : ""}${f.detail}`)
						.join("\n")}`,
				]
			: []),
		...(opts.git?.status ? [`### Working tree (\`git status --short\`)\n\`\`\`\n${opts.git.status.slice(0, 1500)}\n\`\`\``] : []),
		...(lastSummary ? [`### Where the previous session left off\n${lastSummary}`] : []),
		"",
		"Orient directly from the files on disk (do not assume unverified claims above), then continue with the next concrete step.",
	];
	return sections.join("\n\n");
}

export function buildEvaluatorPrompt(opts: {
	title: string;
	messages: AgentMessage[];
	editedFiles: string[];
	verifyCommand?: string;
	lastVerify?: VerifyResult | null;
	git?: GitSnapshot | null;
}): string {
	const userTexts = opts.messages
		.filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user")
		.map((m) => splitContext(contentText(m.content)).text.trim())
		.filter(Boolean);
	const spec = userTexts.slice(0, 3).map((t, i) => `${i + 1}. ${t.slice(0, 500)}`).join("\n") || opts.title;

	const sections = [
		`## Blind Evaluator Audit (fresh context · default FAIL)`,
		"",
		"You are an independent evaluator. You have NOT seen the generator's reasoning. Inspect the actual files on disk and run real checks before passing anything. Default to **FAIL** on any unexercised or unverified requirement.",
		"",
		`### Original task / acceptance spec\n${spec}`,
		`### Files modified by generator\n${opts.editedFiles.length ? opts.editedFiles.map((f) => `- \`${f}\``).join("\n") : "- (none tracked — inspect working tree)"}`,
		...(opts.verifyCommand ? [`### Verification oracle\nRun \`${opts.verifyCommand}\` and report the exact exit status.`] : []),
		...(opts.lastVerify ? [`### Prior verify output\n${opts.lastVerify.ok ? "PASS" : "FAIL"}: ${opts.lastVerify.summary}`] : []),
		...(opts.git?.diffStat ? [`### Diff summary\n\`\`\`\n${opts.git.diffStat.slice(0, 1500)}\n\`\`\``] : []),
		...(opts.git?.diffSnippet ? [`### Working diff\n\`\`\`diff\n${opts.git.diffSnippet}\n\`\`\``] : []),
		"",
		"### Required output format",
		"1. **VERDICT:** `PASS` or `FAIL`",
		"2. **Verified checks:** exact commands / files inspected and their results",
		"3. **Blocking issues:** concrete bugs, regressions, edge cases, or unverified claims (with `file:line`)",
		"4. **Minimal fix list:** smallest changes needed to reach `PASS` (do NOT edit files yourself unless asked)",
	];
	return sections.join("\n\n");
}
