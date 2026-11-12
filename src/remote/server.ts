import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, promises as fs } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { StringDecoder } from "string_decoder";
import { readAdvisorConfig, writeAdvisorConfig } from "../advisor";
import { unusableMcpServers } from "../mcp";
import { readEnabledModels } from "../models";
import { resolveLinked } from "../noteLink";
import type { InstalledPackage } from "../requirements";
import type { PiSpawnOptions } from "../rpc/PiRpcClient";
import { listSessions } from "../sessions";
import { snapshotAfter, snapshotBefore, unchangedSince, type FileSnapshot } from "../view/revert";
import { acceptWebSocket, ServerWebSocket, tokensMatch } from "./ws";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const STDERR_TAIL = 4000;
const DETACH_GRACE_MS = 10 * 60_000;
const MAX_BUFFERED_LINES = 2000;

export interface RemoteSessionOverrides {
	model?: string;
	systemPromptAddendum?: string;
	extraArgs?: string;
	browserControl?: boolean;
	obsidianControl?: boolean;
	trimToolOutput?: boolean;
}

export interface RemoteServerHost {
	vaultName(): string;
	vaultPath(): string;
	panelSettingsFile(): string;
	sessionDirectories(): string[];
	lastSessionFile(): string;
	heldSessionFiles(): string[];
	isSessionHeld(sessionFile: string): boolean;
	buildSpawnOptions(sessionFile: string | null, overrides?: RemoteSessionOverrides): Promise<PiSpawnOptions>;
	piCommand(): Promise<{ binary: string; env: NodeJS.ProcessEnv; cwd: string }>;
	installedPackages(): Promise<InstalledPackage[]>;
	trashSession(path: string): Promise<void>;
	swapVersion(snapshot: FileSnapshot): Promise<FileSnapshot>;
	onSessionsChanged?(): void;
}

interface ActiveToolStream {
	start: string;
	update: string | null;
}

interface ActiveRemoteSession {
	id: number;
	clientId: string;
	sessionFile: string | null;
	proc: ChildProcessWithoutNullStreams | null;
	ws: ServerWebSocket | null;
	stopping: boolean;
	busy: boolean;
	detachTimer: ReturnType<typeof setTimeout> | null;
	stderrTail: string;
	currentMessageEvents: string[];
	currentToolEvents: Map<string, ActiveToolStream>;
	pendingUiRequests: Map<string, string>;
	lastQueueLine: string | null;
	suppressEvents: boolean;
	suppressTimer: ReturnType<typeof setTimeout> | null;
	syncMessagesReqId: string | null;
	replaySnapshot: string[] | null;
	postSnapshotLines: string[];
	stopProc: () => Promise<void>;
	stop: () => Promise<void>;
}

export class PiRemoteServer {
	private server: Server | null = null;
	private sessions = new Map<number, ActiveRemoteSession>();
	private nextSessionId = 1;
	private listeningPort = 0;
	private detachGraceMs = DETACH_GRACE_MS;

	constructor(private host: RemoteServerHost, opts?: { detachGraceMs?: number }) {
		if (opts?.detachGraceMs !== undefined) this.detachGraceMs = opts.detachGraceMs;
	}

	get running(): boolean {
		return this.server !== null;
	}

	get port(): number {
		return this.listeningPort;
	}

	heldSessionFiles(exceptId?: number): string[] {
		const files: string[] = [];
		for (const session of this.sessions.values()) {
			if (session.id !== exceptId && session.sessionFile && (session.ws !== null || session.busy)) {
				files.push(session.sessionFile);
			}
		}
		return files;
	}

	isSessionHeld(sessionFile: string, exceptId?: number): boolean {
		for (const session of this.sessions.values()) {
			if (session.id !== exceptId && session.sessionFile === sessionFile && (session.ws !== null || session.busy)) {
				return true;
			}
		}
		return false;
	}

	async reclaimDetachedSession(sessionFile: string | null, exceptId?: number): Promise<void> {
		if (!sessionFile) return;
		const matching = [...this.sessions.values()].filter(
			(s) => s.id !== exceptId && s.sessionFile === sessionFile && s.ws === null && !s.busy,
		);
		for (const s of matching) {
			this.clearTimers(s);
			this.sessions.delete(s.id);
			await s.stop().catch(() => {});
		}
	}

	async start(opts: { port: number; bindHost: string; token: string }): Promise<number> {
		await this.stop();
		const server = createServer((req, res) => void this.handleHttp(req, res, opts.token));
		server.on("upgrade", (req, socket, head) => {
			if (!this.authorize(req, opts.token)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const ws = acceptWebSocket(req, socket, head);
			if (!ws) return;
			if (url.pathname === "/rpc") this.handleRpcSocket(ws);
			else if (url.pathname === "/btw") this.handleBtwSocket(ws);
			else ws.close(1008, "Unknown WebSocket path");
		});

		await new Promise<void>((resolvePromise, reject) => {
			server.once("error", reject);
			server.listen(opts.port, opts.bindHost || "0.0.0.0", () => {
				server.removeListener("error", reject);
				resolvePromise();
			});
		});

		this.server = server;
		const addr = server.address();
		this.listeningPort = typeof addr === "object" && addr ? addr.port : opts.port;
		return this.listeningPort;
	}

	async stop(): Promise<void> {
		const active = [...this.sessions.values()];
		this.sessions.clear();
		for (const s of active) this.clearTimers(s);
		await Promise.all(active.map((s) => s.stop().catch(() => {})));
		const server = this.server;
		this.server = null;
		this.listeningPort = 0;
		if (!server) return;
		await new Promise<void>((r) => server.close(() => r()));
	}

	private authorize(req: IncomingMessage, expectedToken: string): boolean {
		if (!expectedToken) return false;
		const auth = req.headers.authorization;
		if (typeof auth === "string" && auth.startsWith("Bearer ")) {
			if (tokensMatch(expectedToken, auth.slice(7).trim())) return true;
		}
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const queryToken = url.searchParams.get("token") ?? "";
			return tokensMatch(expectedToken, queryToken);
		} catch {
			return false;
		}
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
		res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}
		if (!this.authorize(req, token)) {
			this.sendJson(res, 401, { ok: false, error: "Invalid access token." });
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method !== "POST" || url.pathname !== "/api") {
			this.sendJson(res, 404, { ok: false, error: "Not found." });
			return;
		}
		try {
			const body = await this.readBody(req);
			const payload = JSON.parse(body || "{}") as Record<string, unknown>;
			const data = await this.dispatchApi(payload);
			this.sendJson(res, 200, { ok: true, data });
		} catch (err) {
			this.sendJson(res, 400, { ok: false, error: (err as Error).message });
		}
	}

	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		const text = JSON.stringify(body);
		res.statusCode = status;
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.end(text);
	}

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const chunks: Buffer[] = [];
			let total = 0;
			req.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > MAX_BODY_BYTES) {
					req.destroy();
					reject(new Error("Request body too large."));
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});
	}

	private resolveFile(rawPath: string): string {
		return resolve(this.host.vaultPath(), rawPath.replace(/^~(?=$|\/)/, homedir()));
	}

	private async dispatchApi(payload: Record<string, unknown>): Promise<unknown> {
		const action = typeof payload.action === "string" ? payload.action : "";
		switch (action) {
			case "ping":
				return { vaultName: this.host.vaultName(), vaultPath: this.host.vaultPath() };
			case "list_sessions": {
				const dirs = [...new Set([...this.host.sessionDirectories(), ...this.heldSessionFiles().map((p) => p.slice(0, p.lastIndexOf("/"))).filter(Boolean)])];
				const sessions = await listSessions(dirs);
				return {
					sessions,
					heldSessionFiles: this.host.heldSessionFiles(),
					lastSessionFile: this.host.lastSessionFile(),
				};
			}
			case "session_exists": {
				const path = typeof payload.path === "string" ? payload.path : "";
				return { exists: Boolean(path && existsSync(path)) };
			}
			case "resolve_linked": {
				const value = typeof payload.value === "string" ? payload.value : "";
				return { path: value ? resolveLinked(value, this.host.sessionDirectories()) : null };
			}
			case "trash_session": {
				const path = typeof payload.path === "string" ? payload.path : "";
				if (!path) throw new Error("Missing session path.");
				await this.reclaimDetachedSession(path);
				if (this.host.isSessionHeld(path)) throw new Error("That session is open on another device or tab.");
				await this.host.trashSession(path);
				this.host.onSessionsChanged?.();
				return { ok: true };
			}
			case "read_enabled_models":
				return { patterns: await readEnabledModels(this.host.panelSettingsFile()) };
			case "read_advisor":
				return { config: readAdvisorConfig() };
			case "write_advisor": {
				const modelKey = typeof payload.modelKey === "string" ? payload.modelKey : null;
				const effort = typeof payload.effort === "string" ? payload.effort : null;
				writeAdvisorConfig(modelKey, effort);
				return { ok: true };
			}
			case "installed_packages":
				return { packages: await this.host.installedPackages() };
			case "unusable_mcp_servers":
				return { servers: await unusableMcpServers(this.host.vaultPath()) };
			case "read_image": {
				const rawPath = typeof payload.path === "string" ? payload.path : "";
				if (!rawPath) throw new Error("Missing image path.");
				const file = this.resolveFile(rawPath);
				const stat = await fs.stat(file);
				if (stat.size > MAX_IMAGE_BYTES) throw new Error("the file is too large to preview");
				const bytes = await fs.readFile(file);
				return { base64: bytes.toString("base64") };
			}
			case "snapshot_before": {
				const rawPath = typeof payload.path === "string" ? payload.path : "";
				if (!rawPath) return { snapshot: null };
				return { snapshot: snapshotBefore(this.resolveFile(rawPath)) ?? null };
			}
			case "snapshot_after": {
				const snap = payload.snapshot as FileSnapshot | undefined;
				const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
				const args = (payload.args && typeof payload.args === "object" ? payload.args : {}) as Record<string, unknown>;
				if (!snap) return { snapshot: null };
				return { snapshot: snapshotAfter(snap, toolName, args) ?? null };
			}
			case "unchanged_since": {
				const snap = payload.snapshot as FileSnapshot | undefined;
				return { unchanged: snap ? unchangedSince(snap) : false };
			}
			case "swap_version": {
				const snap = payload.snapshot as FileSnapshot | undefined;
				if (!snap) throw new Error("Missing file snapshot.");
				return { snapshot: await this.host.swapVersion(snap) };
			}
			default:
				throw new Error(`Unknown API action: ${action}`);
		}
	}

	private clearTimers(entry: ActiveRemoteSession): void {
		if (entry.detachTimer) {
			clearTimeout(entry.detachTimer);
			entry.detachTimer = null;
		}
		if (entry.suppressTimer) {
			clearTimeout(entry.suppressTimer);
			entry.suppressTimer = null;
		}
	}

	private scheduleDetachCleanup(entry: ActiveRemoteSession): void {
		if (entry.detachTimer) clearTimeout(entry.detachTimer);
		entry.detachTimer = setTimeout(() => {
			entry.detachTimer = null;
			if (entry.ws !== null || !this.sessions.has(entry.id)) return;
			if (entry.busy) {
				// Keep the process alive while pi is actively executing a turn or compacting.
				this.scheduleDetachCleanup(entry);
				return;
			}
			this.clearTimers(entry);
			this.sessions.delete(entry.id);
			this.host.onSessionsChanged?.();
			void entry.stop();
		}, this.detachGraceMs);
		entry.detachTimer.unref?.();
	}

	private buildReplaySnapshot(entry: ActiveRemoteSession): string[] {
		const lines: string[] = [];
		for (const tool of entry.currentToolEvents.values()) {
			lines.push(tool.start);
			if (tool.update) lines.push(tool.update);
		}
		lines.push(...entry.currentMessageEvents);
		if (entry.lastQueueLine) lines.push(entry.lastQueueLine);
		for (const req of entry.pendingUiRequests.values()) {
			lines.push(req);
		}
		return lines;
	}

	private flushSuppressedEvents(entry: ActiveRemoteSession): void {
		if (!entry.suppressEvents) return;
		if (entry.suppressTimer) {
			clearTimeout(entry.suppressTimer);
			entry.suppressTimer = null;
		}
		const snapshot = entry.replaySnapshot ?? this.buildReplaySnapshot(entry);
		const post = entry.postSnapshotLines;
		entry.suppressEvents = false;
		entry.syncMessagesReqId = null;
		entry.replaySnapshot = null;
		entry.postSnapshotLines = [];
		if (!entry.ws) return;
		for (const line of snapshot) entry.ws.send(line);
		for (const line of post) entry.ws.send(line);
	}

	private attachSocket(entry: ActiveRemoteSession, ws: ServerWebSocket, reattached: boolean): void {
		this.clearTimers(entry);
		if (entry.ws && entry.ws !== ws) {
			const prev = entry.ws;
			entry.ws = null;
			prev.clearListeners();
			prev.close(1000, "Replaced by new connection");
		}
		entry.ws = ws;
		if (reattached) {
			entry.suppressEvents = true;
			entry.syncMessagesReqId = null;
			entry.replaySnapshot = null;
			entry.postSnapshotLines = [];
			// Fallback in case a raw RPC client reattaches without calling finishRemoteSync().
			entry.suppressTimer = setTimeout(() => this.flushSuppressedEvents(entry), 1500);
			entry.suppressTimer.unref?.();
		} else {
			entry.suppressEvents = false;
			entry.syncMessagesReqId = null;
			entry.replaySnapshot = null;
			entry.postSnapshotLines = [];
		}

		ws.onClose(() => {
			if (entry.ws !== ws) return;
			entry.ws = null;
			this.host.onSessionsChanged?.();
			if (entry.stopping || !this.sessions.has(entry.id)) return;
			this.scheduleDetachCleanup(entry);
		});

		ws.onMessage((text) => {
			void this.handleClientMessage(entry, ws, text);
		});

		if (reattached) {
			this.host.onSessionsChanged?.();
			ws.send(JSON.stringify({
				type: "pi_workbench_ready",
				sessionFile: entry.sessionFile,
				vaultPath: this.host.vaultPath(),
				reattached: true,
			}));
		}
	}

	private async handleClientMessage(entry: ActiveRemoteSession, ws: ServerWebSocket, text: string): Promise<void> {
		try {
			const parsed = JSON.parse(text) as { id?: string; type?: string; sessionPath?: string };
			if (parsed.type === "pi_workbench_ping") {
				ws.send(JSON.stringify({ type: "pi_workbench_pong" }));
				return;
			}
			if (parsed.type === "pi_workbench_stop") {
				this.clearTimers(entry);
				this.sessions.delete(entry.id);
				entry.sessionFile = null;
				this.host.onSessionsChanged?.();
				await entry.stopProc();
				ws.close(1000, "Stopped");
				return;
			}
			if (parsed.type === "pi_workbench_replay") {
				this.flushSuppressedEvents(entry);
				return;
			}
			if (parsed.type === "extension_ui_response" && typeof parsed.id === "string") {
				entry.pendingUiRequests.delete(parsed.id);
			}
			if (parsed.type === "get_messages" && entry.suppressEvents && typeof parsed.id === "string") {
				entry.syncMessagesReqId = parsed.id;
			}
			if (parsed.type === "switch_session" && typeof parsed.sessionPath === "string") {
				await this.reclaimDetachedSession(parsed.sessionPath, entry.id);
				if (this.host.isSessionHeld(parsed.sessionPath) && entry.sessionFile !== parsed.sessionPath) {
					ws.send(JSON.stringify({
						type: "response",
						id: parsed.id,
						command: "switch_session",
						success: false,
						error: "That session is already open in another tab or device.",
					}));
					return;
				}
				entry.sessionFile = parsed.sessionPath;
				this.host.onSessionsChanged?.();
			}
		} catch {
			// Forward as-is
		}
		if (!entry.proc) return;
		entry.proc.stdin.write(text + "\n");
	}

	private handleRpcSocket(ws: ServerWebSocket): void {
		let initialized = false;
		ws.onMessage((text) => {
			if (initialized) return;
			initialized = true;
			ws.clearListeners();
			void this.initRpcSession(ws, text);
		});
	}

	private async initRpcSession(ws: ServerWebSocket, initText: string): Promise<void> {
		let init: { type?: string; clientId?: string; sessionFile?: string | null; overrides?: RemoteSessionOverrides };
		try {
			init = JSON.parse(initText) as typeof init;
		} catch {
			ws.send(JSON.stringify({ type: "pi_workbench_error", error: "Invalid init message." }));
			ws.close(1002, "Invalid init");
			return;
		}

		const clientId = typeof init.clientId === "string" && init.clientId ? init.clientId : "";
		const requested = typeof init.sessionFile === "string" && init.sessionFile ? init.sessionFile : null;
		const usable = requested && existsSync(requested) ? requested : null;

		if (clientId) {
			const existing = [...this.sessions.values()].find((s) => s.clientId === clientId);
			if (existing) {
				if (existing.proc && !existing.stopping && (!usable || !existing.sessionFile || existing.sessionFile === usable)) {
					this.attachSocket(existing, ws, true);
					return;
				}
				this.clearTimers(existing);
				this.sessions.delete(existing.id);
				await existing.stop().catch(() => {});
			}
		}

		if (usable) {
			const detached = [...this.sessions.values()].find(
				(s) => s.sessionFile === usable && s.ws === null && s.proc !== null && !s.stopping,
			);
			if (detached) {
				if (clientId) detached.clientId = clientId;
				this.attachSocket(detached, ws, true);
				return;
			}
		}

		if (usable && this.host.isSessionHeld(usable)) {
			ws.send(JSON.stringify({ type: "pi_workbench_error", error: "That session is already open in another tab or device." }));
			ws.close(1008, "Session in use");
			return;
		}

		const id = this.nextSessionId++;
		const stopProc = async (): Promise<void> => {
			const current = entry.proc;
			if (!current) return;
			entry.proc = null;
			entry.stopping = true;
			await new Promise<void>((r) => {
				const force = setTimeout(() => current.kill("SIGKILL"), 2000);
				current.once("exit", () => {
					clearTimeout(force);
					r();
				});
				current.kill("SIGTERM");
			});
		};

		const entry: ActiveRemoteSession = {
			id,
			clientId,
			sessionFile: usable,
			proc: null,
			ws: null,
			stopping: false,
			busy: false,
			detachTimer: null,
			stderrTail: "",
			currentMessageEvents: [],
			currentToolEvents: new Map(),
			pendingUiRequests: new Map(),
			lastQueueLine: null,
			suppressEvents: false,
			suppressTimer: null,
			syncMessagesReqId: null,
			replaySnapshot: null,
			postSnapshotLines: [],
			stopProc,
			stop: async () => {
				this.clearTimers(entry);
				const attached = entry.ws;
				entry.ws = null;
				await stopProc();
				attached?.close(1000, "Server stopping");
			},
		};
		this.sessions.set(id, entry);
		this.attachSocket(entry, ws, false);
		this.host.onSessionsChanged?.();

		let opts: PiSpawnOptions;
		try {
			opts = await this.host.buildSpawnOptions(usable, init.overrides);
		} catch (err) {
			this.clearTimers(entry);
			this.sessions.delete(entry.id);
			this.host.onSessionsChanged?.();
			ws.send(JSON.stringify({ type: "pi_workbench_error", error: (err as Error).message }));
			ws.close(1011, "Spawn config failed");
			return;
		}

		if (!this.sessions.has(entry.id) || entry.stopping) return;

		const child = spawn(opts.binary, ["--mode", "rpc", ...opts.args], {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let spawned = false;
		child.once("spawn", () => {
			spawned = true;
			entry.proc = child;
			entry.ws?.send(JSON.stringify({
				type: "pi_workbench_ready",
				sessionFile: usable,
				vaultPath: this.host.vaultPath(),
			}));
		});

		child.once("error", (err) => {
			if (!spawned) {
				this.clearTimers(entry);
				this.sessions.delete(entry.id);
				this.host.onSessionsChanged?.();
				entry.ws?.send(JSON.stringify({ type: "pi_workbench_error", error: err.message }));
				entry.ws?.close(1011, "Spawn failed");
			}
		});

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				this.handleStdoutLine(entry, line);
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			entry.stderrTail = (entry.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
		});
		child.stdin.on("error", () => {});

		child.once("exit", (code) => {
			this.clearTimers(entry);
			this.sessions.delete(entry.id);
			entry.proc = null;
			this.host.onSessionsChanged?.();
			const attached = entry.ws;
			entry.ws = null;
			if (!attached) return;
			attached.send(JSON.stringify({
				type: "pi_workbench_exit",
				code,
				stderr: entry.stderrTail.trim(),
				expected: entry.stopping,
			}));
			attached.close(1000, "pi exited");
		});
	}

	private handleStdoutLine(entry: ActiveRemoteSession, line: string): void {
		type ParsedLine = {
			type?: string;
			id?: string;
			command?: string;
			success?: boolean;
			data?: { sessionFile?: unknown; cancelled?: boolean };
			message?: { role?: string };
			toolCallId?: string;
			method?: string;
		};
		let msg: ParsedLine | null = null;
		try {
			msg = JSON.parse(line) as ParsedLine;
		} catch {
			msg = null;
		}

		const isResponse = msg?.type === "response";
		if (isResponse && entry.suppressEvents && msg?.id && msg.id === entry.syncMessagesReqId && !entry.replaySnapshot) {
			entry.replaySnapshot = this.buildReplaySnapshot(entry);
			entry.postSnapshotLines = [];
		}

		if (msg) {
			this.trackFromParsedLine(entry, msg, line);
		}

		if (!entry.ws) return;
		if (entry.suppressEvents && !isResponse) {
			if (entry.replaySnapshot && entry.postSnapshotLines.length < MAX_BUFFERED_LINES) {
				entry.postSnapshotLines.push(line);
			}
			return;
		}
		entry.ws.send(line);
	}

	private trackFromParsedLine(
		entry: ActiveRemoteSession,
		msg: {
			type?: string;
			command?: string;
			success?: boolean;
			data?: { sessionFile?: unknown; cancelled?: boolean };
			message?: { role?: string };
			toolCallId?: string;
			id?: string;
			method?: string;
		},
		line: string,
	): void {
		if (msg.type === "response") {
			if (msg.command === "get_state" && msg.success) {
				const nextFile = typeof msg.data?.sessionFile === "string" && msg.data.sessionFile ? msg.data.sessionFile : null;
				if (entry.sessionFile !== nextFile) {
					entry.sessionFile = nextFile;
					this.host.onSessionsChanged?.();
				}
			} else if ((msg.command === "new_session" || msg.command === "switch_session") && msg.success && !msg.data?.cancelled) {
				entry.currentMessageEvents = [];
				entry.currentToolEvents.clear();
				entry.pendingUiRequests.clear();
				entry.lastQueueLine = null;
			}
			return;
		}

		switch (msg.type) {
			case "agent_start":
				entry.busy = true;
				entry.currentMessageEvents = [];
				entry.currentToolEvents.clear();
				break;
			case "agent_settled":
				entry.busy = false;
				entry.currentMessageEvents = [];
				entry.currentToolEvents.clear();
				entry.pendingUiRequests.clear();
				entry.lastQueueLine = null;
				if (entry.ws === null && this.sessions.has(entry.id)) {
					this.scheduleDetachCleanup(entry);
				}
				break;
			case "compaction_start":
				entry.busy = true;
				break;
			case "compaction_end":
				entry.busy = false;
				if (entry.ws === null && this.sessions.has(entry.id)) {
					this.scheduleDetachCleanup(entry);
				}
				break;
			case "message_start":
				if (msg.message?.role === "assistant") {
					entry.currentMessageEvents = [line];
				}
				break;
			case "message_update":
				if (entry.currentMessageEvents.length < MAX_BUFFERED_LINES) {
					entry.currentMessageEvents.push(line);
				}
				break;
			case "message_end":
				entry.currentMessageEvents = [];
				break;
			case "tool_execution_start":
				if (typeof msg.toolCallId === "string") {
					entry.currentToolEvents.set(msg.toolCallId, { start: line, update: null });
				}
				break;
			case "tool_execution_update":
				if (typeof msg.toolCallId === "string") {
					const active = entry.currentToolEvents.get(msg.toolCallId);
					if (active) active.update = line;
				}
				break;
			case "tool_execution_end":
				if (typeof msg.toolCallId === "string") {
					entry.currentToolEvents.delete(msg.toolCallId);
				}
				break;
			case "queue_update":
				entry.lastQueueLine = line;
				break;
			case "extension_ui_request":
				if (
					typeof msg.id === "string" &&
					(msg.method === "select" || msg.method === "confirm" || msg.method === "input" || msg.method === "editor")
				) {
					entry.pendingUiRequests.set(msg.id, line);
				}
				break;
		}
	}

	private handleBtwSocket(ws: ServerWebSocket): void {
		let proc: ChildProcess | null = null;
		let started = false;
		let cleanup: (() => void) | null = null;

		ws.onClose(() => {
			proc?.kill();
			proc = null;
			cleanup?.();
			cleanup = null;
		});

		ws.onMessage((text) => {
			if (started) return;
			started = true;
			void (async () => {
				try {
					const req = JSON.parse(text) as {
						sessionFile?: string | null;
						model?: { provider: string; id: string } | null;
						thinkingLevel?: string | null;
						prompt?: string;
						systemPrompt?: string;
					};
					const workDir = await fs.mkdtemp(join(tmpdir(), "pi-workbench-btw-"));
					cleanup = () => void fs.rm(workDir, { recursive: true, force: true });
					const { binary, env, cwd } = await this.host.piCommand();
					const args = [
						"-p",
						"--mode",
						"json",
						"--no-tools",
						"--no-skills",
						"--no-context-files",
						"--no-prompt-templates",
						"--system-prompt",
						req.systemPrompt ?? "",
					];
					if (req.sessionFile && existsSync(req.sessionFile)) args.push("--fork", req.sessionFile, "--session-dir", workDir);
					else args.push("--no-session");
					if (req.model) args.push("--model", `${req.model.provider}/${req.model.id}`);
					if (req.thinkingLevel) args.push("--thinking", req.thinkingLevel);
					args.push("--", req.prompt ?? "");

					const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
					proc = child;
					let stderr = "";
					let failure = "";
					const decoder = new StringDecoder("utf8");
					let buffer = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						buffer += decoder.write(chunk);
						let newline: number;
						while ((newline = buffer.indexOf("\n")) !== -1) {
							const line = buffer.slice(0, newline);
							buffer = buffer.slice(newline + 1);
							if (line.trim()) ws.send(line);
						}
					});
					child.stderr?.on("data", (chunk: Buffer) => {
						stderr = (stderr + chunk.toString("utf8")).slice(-2000);
					});
					child.on("error", (err) => {
						failure = err.message;
					});
					child.on("close", () => {
						cleanup?.();
						cleanup = null;
						proc = null;
						ws.send(JSON.stringify({ type: "pi_workbench_btw_end", failure, stderr }));
						ws.close(1000, "btw finished");
					});
				} catch (err) {
					cleanup?.();
					cleanup = null;
					ws.send(JSON.stringify({ type: "pi_workbench_btw_end", failure: (err as Error).message, stderr: "" }));
					ws.close(1011, "btw error");
				}
			})();
		});
	}
}
