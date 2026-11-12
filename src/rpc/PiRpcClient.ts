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
	id: string;
	type: string;
	payload: Record<string, unknown>;
	sent: boolean;
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

type EventListener = (event: RpcEvent) => void;
type ExitListener = (info: { code: number | null; stderr: string; expected: boolean }) => void;
type ReconnectListener = (reattached: boolean) => void;

// Commands that legitimately block for a long time and must not time out.
const LONG_RUNNING = new Set(["prompt", "abort", "compact", "bash", "new_session", "switch_session", "clone", "fork"]);
// Read-only commands that can be safely re-sent if a remote WebSocket drops mid-request.
const IDEMPOTENT_REQUESTS = new Set([
	"get_state",
	"get_messages",
	"get_entries",
	"get_commands",
	"get_available_models",
	"get_available_thinking_levels",
	"get_session_stats",
]);
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 8_000;
const CLIENT_PING_INTERVAL_MS = 20_000;
const STALE_SOCKET_MS = 25_000;
const PING_TIMEOUT_MS = 3_000;
const STDERR_TAIL = 4000;

export class PiRpcClient {
	private readonly clientId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	private proc: ChildProcessWithoutNullStreams | null = null;
	private ws: WebSocket | null = null;
	private remoteOpts: PiRemoteSpawnOptions | null = null;
	private reconnecting: Promise<void> | null = null;
	private verifying: Promise<void> | null = null;
	private verifyWaiters = new Set<(alive: boolean) => void>();
	private wakeRetry: (() => void) | null = null;
	private activeConnectAbort: (() => void) | null = null;
	private activeConnectStartedAt = 0;
	private lastReceivedAt = 0;
	private clientPingTimer: ReturnType<typeof setInterval> | null = null;
	private cleanupLifecycle: (() => void) | null = null;
	private queuedWrites: Record<string, unknown>[] = [];
	private pending = new Map<string, Pending>();
	private eventListeners = new Set<EventListener>();
	private exitListeners = new Set<ExitListener>();
	private reconnectingListeners = new Set<() => void>();
	private reconnectedListeners = new Set<ReconnectListener>();
	private nextId = 1;
	private stderrTail = "";
	private stopping = false;

	get running(): boolean {
		return this.proc !== null || this.ws !== null || this.reconnecting !== null;
	}

	get isReconnecting(): boolean {
		return this.reconnecting !== null;
	}

	onEvent(fn: EventListener): () => void {
		this.eventListeners.add(fn);
		return () => this.eventListeners.delete(fn);
	}

	onExit(fn: ExitListener): () => void {
		this.exitListeners.add(fn);
		return () => this.exitListeners.delete(fn);
	}

	onReconnecting(fn: () => void): () => void {
		this.reconnectingListeners.add(fn);
		return () => this.reconnectingListeners.delete(fn);
	}

	onReconnected(fn: ReconnectListener): () => void {
		this.reconnectedListeners.add(fn);
		return () => this.reconnectedListeners.delete(fn);
	}

	start(opts: PiSpawnOptions): Promise<void> {
		if (this.proc || this.ws || this.reconnecting) return Promise.resolve();
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

	private async startRemote(remote: PiRemoteSpawnOptions): Promise<void> {
		const opts: PiRemoteSpawnOptions = { ...remote };
		await this.openRemoteSocket(opts);
		this.remoteOpts = opts;
		this.attachRemoteLifecycle();
	}

	private openRemoteSocket(remote: PiRemoteSpawnOptions): Promise<boolean> {
		return new Promise((resolve, reject) => {
			let ws: WebSocket;
			try {
				ws = new WebSocket(remote.wsUrl);
			} catch (err) {
				reject(err as Error);
				return;
			}
			let settled = false;
			this.activeConnectStartedAt = Date.now();
			const finishAttempt = () => {
				clearTimeout(connectTimer);
				if (this.activeConnectAbort === abortAttempt) this.activeConnectAbort = null;
			};
			const abortAttempt = () => {
				if (settled) return;
				settled = true;
				finishAttempt();
				try {
					ws.close();
				} catch {
					// Ignore
				}
				reject(new Error("Connection attempt timed out."));
			};
			this.activeConnectAbort = abortAttempt;
			const connectTimer = setTimeout(abortAttempt, CONNECT_TIMEOUT_MS);
			connectTimer.unref?.();

			ws.addEventListener("open", () => {
				this.lastReceivedAt = Date.now();
				ws.send(JSON.stringify({
					type: "pi_workbench_init",
					clientId: this.clientId,
					sessionFile: remote.sessionFile,
					overrides: remote.overrides,
				}));
			});

			ws.addEventListener("message", (evt) => {
				this.lastReceivedAt = Date.now();
				if (this.verifyWaiters.size) {
					for (const waiter of this.verifyWaiters) waiter(true);
					this.verifyWaiters.clear();
				}
				const raw = typeof evt.data === "string" ? evt.data : String(evt.data ?? "");
				for (const line of raw.split("\n")) {
					const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed) as {
							type?: string;
							error?: string;
							vaultPath?: string;
							sessionFile?: string | null;
							reattached?: boolean;
							code?: number | null;
							stderr?: string;
							expected?: boolean;
						};
						if (parsed.type === "pi_workbench_pong") continue;
						if (parsed.type === "pi_workbench_ready") {
							if (parsed.vaultPath) remote.onVaultPath?.(parsed.vaultPath);
							if (typeof parsed.sessionFile === "string" && parsed.sessionFile) {
								remote.sessionFile = parsed.sessionFile;
							}
							if (!settled) {
								settled = true;
								finishAttempt();
								this.ws = ws;
								this.startClientPing();
								if (parsed.reattached && this.reconnectedListeners.size === 0) {
									this.finishRemoteSync();
								}
								resolve(Boolean(parsed.reattached));
							}
							continue;
						}
						if (parsed.type === "pi_workbench_error") {
							const err = Object.assign(new Error(parsed.error || "Remote pi server rejected the connection."), { fatal: true });
							if (!settled) {
								settled = true;
								finishAttempt();
								ws.close();
								reject(err);
							} else {
								this.remoteOpts = null;
								this.stopRemoteLifecycle();
								this.stderrTail = err.message;
								this.handleWsExit(ws, 1, false);
							}
							continue;
						}
						if (parsed.type === "pi_workbench_exit") {
							if (typeof parsed.stderr === "string") this.stderrTail = parsed.stderr;
							this.remoteOpts = null;
							this.stopRemoteLifecycle();
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
					finishAttempt();
					reject(new Error("Could not connect to the remote pi server."));
				}
			});

			ws.addEventListener("close", () => {
				if (this.verifyWaiters.size) {
					for (const waiter of this.verifyWaiters) waiter(false);
					this.verifyWaiters.clear();
				}
				if (!settled) {
					settled = true;
					finishAttempt();
					reject(new Error("Connection to the remote pi server closed before pi started."));
					return;
				}
				if (this.stopping || !this.remoteOpts) {
					this.handleWsExit(ws, null, this.stopping);
					return;
				}
				if (this.ws === ws) {
					void this.beginReconnect(ws);
				}
			});
		});
	}

	private startClientPing(): void {
		if (this.clientPingTimer) clearInterval(this.clientPingTimer);
		this.clientPingTimer = setInterval(() => {
			if (this.stopping || !this.remoteOpts || this.isDocumentHidden()) return;
			if (this.ws && this.ws.readyState === 1) {
				try {
					this.ws.send(JSON.stringify({ type: "pi_workbench_ping" }));
				} catch {
					void this.beginReconnect(this.ws);
				}
			}
		}, CLIENT_PING_INTERVAL_MS);
		this.clientPingTimer.unref?.();
	}

	private attachRemoteLifecycle(): void {
		this.stopRemoteLifecycle();
		const cleanups: (() => void)[] = [];
		const onWake = () => this.nudgeReconnect();
		if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
			const onVis = () => {
				if (document.visibilityState === "visible") onWake();
			};
			document.addEventListener("visibilitychange", onVis);
			cleanups.push(() => document.removeEventListener("visibilitychange", onVis));
		}
		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			for (const evt of ["focus", "online", "pageshow"]) {
				window.addEventListener(evt, onWake);
				cleanups.push(() => window.removeEventListener(evt, onWake));
			}
		}
		this.cleanupLifecycle = () => {
			for (const fn of cleanups) fn();
		};
	}

	private stopRemoteLifecycle(): void {
		if (this.clientPingTimer) {
			clearInterval(this.clientPingTimer);
			this.clientPingTimer = null;
		}
		this.cleanupLifecycle?.();
		this.cleanupLifecycle = null;
	}

	private isDocumentHidden(): boolean {
		return typeof document !== "undefined" && document.visibilityState === "hidden";
	}

	// Called when the app returns to the foreground or the user clicks Retry.
	nudgeReconnect(): void {
		if (this.stopping || !this.remoteOpts) return;
		if (this.reconnecting) {
			if (this.activeConnectAbort && Date.now() - this.activeConnectStartedAt > 1500) {
				this.activeConnectAbort();
			}
			this.wakeRetry?.();
			return;
		}
		if (!this.ws || this.ws.readyState !== 1) {
			void this.beginReconnect(this.ws ?? undefined);
			return;
		}
		void this.verifySocket();
	}

	// Sends a lightweight application ping and reconnects if the socket is silently dead.
	verifySocket(): Promise<void> {
		if (!this.remoteOpts || this.stopping) return Promise.resolve();
		if (this.reconnecting) return this.reconnecting;
		if (this.verifying) return this.verifying;
		const ws = this.ws;
		if (!ws || ws.readyState !== 1) {
			return this.beginReconnect(ws ?? undefined);
		}
		this.verifying = (async () => {
			const alive = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					this.verifyWaiters.delete(onResult);
					resolve(false);
				}, PING_TIMEOUT_MS);
				timer.unref?.();
				const onResult = (ok: boolean) => {
					clearTimeout(timer);
					this.verifyWaiters.delete(onResult);
					resolve(ok);
				};
				this.verifyWaiters.add(onResult);
				try {
					ws.send(JSON.stringify({ type: "pi_workbench_ping" }));
				} catch {
					onResult(false);
				}
			});
			this.verifying = null;
			if (!alive && !this.stopping && this.remoteOpts) {
				try {
					ws.close();
				} catch {
					// Ignore
				}
				await this.beginReconnect(ws);
			}
		})();
		return this.verifying;
	}

	private beginReconnect(closedWs?: WebSocket): Promise<void> {
		if (this.stopping || !this.remoteOpts) return Promise.resolve();
		if (closedWs && this.ws === closedWs) {
			this.ws = null;
		}
		if (this.clientPingTimer) {
			clearInterval(this.clientPingTimer);
			this.clientPingTimer = null;
		}
		for (const [id, pending] of this.pending) {
			if (!pending.sent) continue;
			if (IDEMPOTENT_REQUESTS.has(pending.type)) {
				pending.sent = false;
				if (pending.timer) {
					clearTimeout(pending.timer);
					pending.timer = null;
				}
			} else {
				this.pending.delete(id);
				if (pending.timer) clearTimeout(pending.timer);
				pending.reject(new Error("Connection to the remote pi server was interrupted."));
			}
		}
		if (this.reconnecting) return this.reconnecting;

		for (const fn of this.reconnectingListeners) fn();
		this.reconnecting = this.runReconnectLoop();
		return this.reconnecting;
	}

	private async runReconnectLoop(): Promise<void> {
		let attempt = 0;
		while (!this.stopping && this.remoteOpts) {
			if (attempt > 0 && this.isDocumentHidden()) {
				await this.waitForWakeOrDelay(30_000);
				if (this.stopping || !this.remoteOpts) break;
			}
			try {
				const reattached = await this.openRemoteSocket(this.remoteOpts);
				this.reconnecting = null;
				this.flushQueuedTraffic();
				for (const fn of this.reconnectedListeners) fn(reattached);
				return;
			} catch (err) {
				if (this.stopping || !this.remoteOpts) break;
				if ((err as { fatal?: boolean }).fatal) {
					this.reconnecting = null;
					this.remoteOpts = null;
					this.stopRemoteLifecycle();
					this.stderrTail = (err as Error).message;
					this.finishExit(1, false);
					return;
				}
				attempt++;
				const delay = Math.min(400 * Math.pow(1.6, Math.min(attempt - 1, 6)), 8_000);
				await this.waitForWakeOrDelay(delay);
			}
		}
		this.reconnecting = null;
	}

	private waitForWakeOrDelay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				if (this.wakeRetry === done) this.wakeRetry = null;
				resolve();
			};
			const timer = setTimeout(done, ms);
			timer.unref?.();
			this.wakeRetry = done;
		});
	}

	private flushQueuedTraffic(): void {
		if (!this.ws || this.ws.readyState !== 1) return;
		const writes = this.queuedWrites.splice(0);
		for (const payload of writes) {
			try {
				this.ws.send(JSON.stringify(payload));
			} catch {
				// Ignore
			}
		}
		for (const pending of this.pending.values()) {
			if (pending.sent) continue;
			try {
				this.startPendingTimer(pending);
				pending.sent = true;
				this.ws.send(JSON.stringify(pending.payload));
			} catch {
				pending.sent = false;
			}
		}
	}

	finishRemoteSync(): void {
		if (this.ws && this.ws.readyState === 1) {
			try {
				this.ws.send(JSON.stringify({ type: "pi_workbench_replay" }));
			} catch {
				// Ignore
			}
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.remoteOpts = null;
		this.stopRemoteLifecycle();
		this.activeConnectAbort?.();
		this.wakeRetry?.();
		for (const waiter of this.verifyWaiters) waiter(false);
		this.verifyWaiters.clear();
		this.queuedWrites = [];
		if (this.ws) {
			const ws = this.ws;
			await new Promise<void>((resolve) => {
				if (ws.readyState === 3) {
					resolve();
					return;
				}
				const force = setTimeout(() => {
					try {
						ws.close();
					} catch {
						// Ignore
					}
					resolve();
				}, 2000);
				const done = () => {
					clearTimeout(force);
					resolve();
				};
				ws.addEventListener("close", done, { once: true });
				ws.addEventListener("error", done, { once: true });
				if (ws.readyState === 1) {
					try {
						ws.send(JSON.stringify({ type: "pi_workbench_stop" }));
					} catch {
						ws.close();
					}
				} else {
					ws.close();
				}
			});
			this.handleWsExit(ws, 0, true);
			return;
		}
		if (this.reconnecting) {
			this.reconnecting = null;
			this.finishExit(0, true);
			return;
		}
		const proc = this.proc;
		if (!proc) return;
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
			if (this.remoteOpts && msg.success) {
				if (msg.command === "get_state") {
					const sf = (msg.data as { sessionFile?: unknown } | undefined)?.sessionFile;
					if (typeof sf === "string" && sf) this.remoteOpts.sessionFile = sf;
				} else if (msg.command === "new_session" && !(msg.data as { cancelled?: boolean } | undefined)?.cancelled) {
					this.remoteOpts.sessionFile = null;
				}
			}
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

	private startPendingTimer(pending: Pending): void {
		if (pending.timer) clearTimeout(pending.timer);
		pending.timer = LONG_RUNNING.has(pending.type)
			? null
			: setTimeout(() => {
					this.pending.delete(pending.id);
					pending.reject(new Error(`pi did not respond to "${pending.type}"`));
				}, REQUEST_TIMEOUT_MS);
	}

	private write(payload: Record<string, unknown>): void {
		if (this.ws && this.ws.readyState === 1) {
			this.ws.send(JSON.stringify(payload));
			return;
		}
		if (this.remoteOpts && !this.stopping) {
			this.queuedWrites.push(payload);
			void this.beginReconnect(this.ws ?? undefined);
			return;
		}
		if (!this.proc) throw new Error("pi is not running");
		this.proc.stdin.write(JSON.stringify(payload) + "\n");
	}

	request<T = unknown>(type: string, params: Record<string, unknown> = {}): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = `req-${this.nextId++}`;
			const payload: Record<string, unknown> = { id, type, ...params };
			const pending: Pending = {
				id,
				type,
				payload,
				sent: false,
				resolve: resolve as (data: unknown) => void,
				reject,
				timer: null,
			};
			this.pending.set(id, pending);
			void this.dispatchPending(pending);
		});
	}

	private async dispatchPending(pending: Pending): Promise<void> {
		if (!this.pending.has(pending.id)) return;
		if (this.remoteOpts) {
			if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastReceivedAt > STALE_SOCKET_MS) {
				await this.verifySocket();
			} else if (this.verifying) {
				await this.verifying;
			}
			if (this.reconnecting) {
				await this.reconnecting;
			}
			if (!this.pending.has(pending.id) || pending.sent) return;
		}
		try {
			this.startPendingTimer(pending);
			pending.sent = true;
			if (this.ws && this.ws.readyState === 1) {
				this.ws.send(JSON.stringify(pending.payload));
				return;
			}
			if (!this.proc) throw new Error("pi is not running");
			this.proc.stdin.write(JSON.stringify(pending.payload) + "\n");
		} catch (err) {
			if (this.remoteOpts && !this.stopping) {
				pending.sent = false;
				if (pending.timer) {
					clearTimeout(pending.timer);
					pending.timer = null;
				}
				void this.beginReconnect(this.ws ?? undefined);
				return;
			}
			this.pending.delete(pending.id);
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(err as Error);
		}
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
