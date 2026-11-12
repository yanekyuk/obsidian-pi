import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import type {
	AgentMessage,
	ImageContent,
	Model,
	RpcEvent,
	RpcResponse,
	SessionEntry,
	SessionState,
	SessionStats,
	SlashCommand,
	ThinkingLevel,
} from "./types";

export interface PiRemoteSpawnOptions {
	wsUrl: string;
	sessionFile: string | null;
	overrides?: object;
	onVaultPath?: (vaultPath: string) => void;
}

export interface PiSpawnOptions {
	binary: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	remote?: PiRemoteSpawnOptions;
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

type EventListener = (event: RpcEvent) => void;
type ExitListener = (info: { code: number | null; stderr: string; expected: boolean }) => void;

// Commands that legitimately block for a long time and must not time out.
const LONG_RUNNING = new Set(["prompt", "abort", "compact", "bash", "new_session", "switch_session", "clone", "fork"]);
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4000;

export class PiRpcClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private ws: WebSocket | null = null;
	private pending = new Map<string, Pending>();
	private eventListeners = new Set<EventListener>();
	private exitListeners = new Set<ExitListener>();
	private nextId = 1;
	private stderrTail = "";
	private stopping = false;

	get running(): boolean {
		return this.proc !== null || this.ws !== null;
	}

	onEvent(fn: EventListener): () => void {
		this.eventListeners.add(fn);
		return () => this.eventListeners.delete(fn);
	}

	onExit(fn: ExitListener): () => void {
		this.exitListeners.add(fn);
		return () => this.exitListeners.delete(fn);
	}

	start(opts: PiSpawnOptions): Promise<void> {
		if (this.proc || this.ws) return Promise.resolve();
		this.stopping = false;
		this.stderrTail = "";
		if (opts.remote) return this.startRemote(opts.remote);

		return new Promise((resolve, reject) => {
			const proc = spawn(opts.binary, ["--mode", "rpc", ...opts.args], {
				cwd: opts.cwd,
				env: opts.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let settled = false;

			proc.once("spawn", () => {
				settled = true;
				this.proc = proc;
				resolve();
			});
			proc.once("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
			proc.once("close", (code) => this.handleExit(proc, code));

			this.attachJsonlReader(proc);
			proc.stderr.on("data", (chunk: Buffer) => {
				this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
			});
			// A dead pi closes stdin; writes must not throw an unhandled EPIPE.
			proc.stdin.on("error", () => {});
		});
	}

	private startRemote(remote: PiRemoteSpawnOptions): Promise<void> {
		return new Promise((resolve, reject) => {
			let ws: WebSocket;
			try {
				ws = new WebSocket(remote.wsUrl);
			} catch (err) {
				reject(err as Error);
				return;
			}
			let settled = false;

			ws.addEventListener("open", () => {
				ws.send(JSON.stringify({
					type: "pi_workbench_init",
					sessionFile: remote.sessionFile,
					overrides: remote.overrides,
				}));
			});

			ws.addEventListener("message", (evt) => {
				const raw = typeof evt.data === "string" ? evt.data : String(evt.data ?? "");
				for (const line of raw.split("\n")) {
					const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed) as {
							type?: string;
							error?: string;
							vaultPath?: string;
							code?: number | null;
							stderr?: string;
							expected?: boolean;
						};
						if (parsed.type === "pi_workbench_ready") {
							if (parsed.vaultPath) remote.onVaultPath?.(parsed.vaultPath);
							if (!settled) {
								settled = true;
								this.ws = ws;
								resolve();
							}
							continue;
						}
						if (parsed.type === "pi_workbench_error") {
							const err = new Error(parsed.error || "Remote pi server rejected the connection.");
							if (!settled) {
								settled = true;
								ws.close();
								reject(err);
							} else {
								this.stderrTail = err.message;
								this.handleWsExit(ws, 1, false);
							}
							continue;
						}
						if (parsed.type === "pi_workbench_exit") {
							if (typeof parsed.stderr === "string") this.stderrTail = parsed.stderr;
							this.handleWsExit(ws, parsed.code ?? null, Boolean(parsed.expected) || this.stopping);
							continue;
						}
					} catch {
						// Pass to handleLine
					}
					this.handleLine(trimmed);
				}
			});

			ws.addEventListener("error", () => {
				if (!settled) {
					settled = true;
					reject(new Error("Could not connect to the remote pi server."));
				}
			});

			ws.addEventListener("close", () => {
				if (!settled) {
					settled = true;
					reject(new Error("Connection to the remote pi server closed before pi started."));
					return;
				}
				this.handleWsExit(ws, null, this.stopping);
			});
		});
	}

	async stop(): Promise<void> {
		if (this.ws) {
			const ws = this.ws;
			this.stopping = true;
			await new Promise<void>((resolve) => {
				if (ws.readyState === 3) {
					resolve();
					return;
				}
				const force = setTimeout(resolve, 2000);
				const done = () => {
					clearTimeout(force);
					resolve();
				};
				ws.addEventListener("close", done, { once: true });
				ws.addEventListener("error", done, { once: true });
				ws.close();
			});
			this.handleWsExit(ws, 0, true);
			return;
		}
		const proc = this.proc;
		if (!proc) return;
		this.stopping = true;
		await new Promise<void>((resolve) => {
			const force = setTimeout(() => proc.kill("SIGKILL"), 2000);
			proc.once("close", () => {
				clearTimeout(force);
				resolve();
			});
			proc.kill("SIGTERM");
		});
	}

	// RPC is strict JSONL: LF is the only record delimiter. Node's readline also
	// splits on U+2028/U+2029, which are valid inside JSON strings, so frame by hand.
	private attachJsonlReader(proc: ChildProcessWithoutNullStreams): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (line) this.handleLine(line);
			}
		});
	}

	private handleLine(line: string): void {
		let msg: RpcResponse | RpcEvent;
		try {
			msg = JSON.parse(line);
		} catch {
			return; // Extensions occasionally print non-protocol noise to stdout.
		}
		if (msg.type === "response") {
			const pending = msg.id ? this.pending.get(msg.id) : undefined;
			if (!pending || !msg.id) return;
			this.pending.delete(msg.id);
			if (pending.timer) clearTimeout(pending.timer);
			if (msg.success) pending.resolve(msg.data);
			else pending.reject(new Error(msg.error ?? `pi command failed: ${msg.command}`));
			return;
		}
		for (const fn of this.eventListeners) fn(msg);
	}

	private handleExit(proc: ChildProcessWithoutNullStreams, code: number | null): void {
		if (this.proc !== proc && this.proc !== null) return;
		this.proc = null;
		this.finishExit(code, this.stopping);
	}

	private handleWsExit(ws: WebSocket, code: number | null, expected: boolean): void {
		if (this.ws !== ws) return;
		this.ws = null;
		this.finishExit(code, expected);
	}

	private finishExit(code: number | null, expected: boolean): void {
		const stderr = this.stderrTail.trim();
		const tail = stderr.split("\n").slice(-12).join("\n");
		const err = new Error(tail || (code === null ? "pi process exited" : `pi exited with code ${code}`));
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pending.clear();
		const info = { code, stderr, expected };
		for (const fn of this.exitListeners) fn(info);
	}

	private write(payload: Record<string, unknown>): void {
		if (this.ws) {
			this.ws.send(JSON.stringify(payload));
			return;
		}
		if (!this.proc) throw new Error("pi is not running");
		this.proc.stdin.write(JSON.stringify(payload) + "\n");
	}

	request<T = unknown>(type: string, params: Record<string, unknown> = {}): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = `req-${this.nextId++}`;
			const timer = LONG_RUNNING.has(type)
				? null
				: setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`pi did not respond to "${type}"`));
					}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
			try {
				this.write({ id, type, ...params });
			} catch (err) {
				this.pending.delete(id);
				if (timer) clearTimeout(timer);
				reject(err as Error);
			}
		});
	}

	prompt(message: string, opts: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } = {}): Promise<void> {
		const params: Record<string, unknown> = { message };
		if (opts.streamingBehavior) params.streamingBehavior = opts.streamingBehavior;
		if (opts.images?.length) params.images = opts.images;
		return this.request("prompt", params);
	}

	// steer and follow_up queue a message whether or not a run has started yet; prompt only
	// queues into a run that is already streaming.
	steer(message: string, images?: ImageContent[]): Promise<void> {
		return this.request("steer", images?.length ? { message, images } : { message });
	}

	followUp(message: string, images?: ImageContent[]): Promise<void> {
		return this.request("follow_up", images?.length ? { message, images } : { message });
	}

	abort(): Promise<void> {
		return this.request("abort");
	}

	clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return this.request("clear_queue");
	}

	getState(): Promise<SessionState> {
		return this.request("get_state");
	}

	async getMessages(): Promise<AgentMessage[]> {
		const data = await this.request<{ messages: AgentMessage[] }>("get_messages");
		return data.messages;
	}

	async getCommands(): Promise<SlashCommand[]> {
		const data = await this.request<{ commands: SlashCommand[] }>("get_commands");
		return data.commands;
	}

	async getAvailableModels(): Promise<Model[]> {
		const data = await this.request<{ models: Model[] }>("get_available_models");
		return data.models;
	}

	setModel(provider: string, modelId: string): Promise<Model> {
		return this.request("set_model", { provider, modelId });
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const data = await this.request<{ levels: ThinkingLevel[] }>("get_available_thinking_levels");
		return data.levels;
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.request("set_thinking_level", { level });
	}

	getSessionStats(): Promise<SessionStats> {
		return this.request("get_session_stats");
	}

	newSession(): Promise<{ cancelled: boolean }> {
		return this.request("new_session");
	}

	switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.request("switch_session", { sessionPath });
	}

	setSessionName(name: string): Promise<void> {
		return this.request("set_session_name", { name });
	}

	// Copies the active branch into a new session file and makes that the current session.
	cloneSession(): Promise<{ cancelled: boolean }> {
		return this.request("clone");
	}

	// Starts a new session file holding the active branch up to just before a user message,
	// and makes that the current session. `text` is the message forked from.
	fork(entryId: string): Promise<{ text?: string; cancelled: boolean }> {
		return this.request("fork", { entryId });
	}

	// Every entry of the session, abandoned branches and compacted history included.
	getEntries(): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		return this.request("get_entries");
	}

	// Marks the start of an in-place subtopic branch at the current leaf (via panel-shell.ts).
	startBranch(): Promise<void> {
		return this.runTreeCommand({ action: "start" });
	}

	// Moves the active leaf inside the current session file, optionally summarizing the abandoned path.
	navigateTree(targetId: string, opts: { summarize?: boolean } = {}): Promise<void> {
		return this.runTreeCommand({ action: "navigate", targetId, summarize: opts.summarize });
	}

	private async runTreeCommand(payload: Record<string, unknown>): Promise<void> {
		let commandError: string | null = null;
		const off = this.onEvent((e) => {
			if (e.type === "extension_error" && e.extensionPath === "command:pi-workbench:tree") {
				commandError = e.error;
			}
		});
		try {
			await this.prompt(`/pi-workbench:tree ${JSON.stringify(payload)}`);
		} finally {
			off();
		}
		if (commandError) throw new Error(commandError);
	}

	compact(customInstructions?: string): Promise<unknown> {
		return this.request("compact", customInstructions ? { customInstructions } : {});
	}

	respondToUi(id: string, response: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
		this.write({ type: "extension_ui_response", id, ...response });
	}
}
