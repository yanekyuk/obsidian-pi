import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import {
	capabilitiesForBackend,
	type AcpSpawnOptions,
	type AgentBackend,
	type AgentCapabilities,
	type AgentClient,
	type AgentSpawnOptions,
	type EventListener,
	type ExitListener,
	type ReconnectListener,
} from "./AgentClient";
import type {
	AgentMessage,
	ContentBlock,
	ImageContent,
	Model,
	RpcEvent,
	SessionEntry,
	SessionState,
	SessionStats,
	SlashCommand,
	ThinkingLevel,
	ToolResult,
} from "./types";

interface PendingJsonRpc {
	method: string;
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

interface AcpModelInfo {
	modelId: string;
	name?: string;
	description?: string;
}

interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind?: string;
}

interface TrackedToolCall {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	ended: boolean;
}

const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4000;
const LONG_RUNNING_METHODS = new Set(["session/prompt", "session/new", "session/load"]);

export class AcpClient implements AgentClient {
	readonly backend: AgentBackend = "acp";
	readonly capabilities: AgentCapabilities = capabilitiesForBackend("acp");

	private proc: ChildProcessWithoutNullStreams | null = null;
	private opts: AcpSpawnOptions | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingJsonRpc>();
	private pendingPermissions = new Map<string, { options: AcpPermissionOption[]; resolve: (result: unknown) => void }>();
	private eventListeners = new Set<EventListener>();
	private exitListeners = new Set<ExitListener>();
	private stderrTail = "";
	private stopping = false;

	private sessionId: string | null = null;
	private availableModels: Model[] = [];
	private currentModel: Model | null = null;
	private commands: SlashCommand[] = [];
	private messages: AgentMessage[] = [];
	private isStreaming = false;
	private replayingHistory = false;

	// Per-turn streaming accumulators for translating ACP updates into pi-workbench events.
	private textBlockIndex: number | null = null;
	private thinkingBlockIndex: number | null = null;
	private turnBlocks: ContentBlock[] = [];
	private activeTools = new Map<string, TrackedToolCall>();

	get running(): boolean {
		return this.proc !== null;
	}

	get isReconnecting(): boolean {
		return false;
	}

	onEvent(fn: EventListener): () => void {
		this.eventListeners.add(fn);
		return () => this.eventListeners.delete(fn);
	}

	onExit(fn: ExitListener): () => void {
		this.exitListeners.add(fn);
		return () => this.exitListeners.delete(fn);
	}

	onReconnecting(_fn: () => void): () => void {
		return () => {};
	}

	onReconnected(_fn: ReconnectListener): () => void {
		return () => {};
	}

	nudgeReconnect(): void {}
	finishRemoteSync(): void {}

	async start(spawnOpts: AgentSpawnOptions): Promise<void> {
		if (this.proc) return;
		if (!("skipPermissions" in spawnOpts)) {
			throw new Error("AcpClient requires AcpSpawnOptions.");
		}
		const opts = spawnOpts;
		this.opts = opts;
		this.stopping = false;
		this.stderrTail = "";

		const args = ["acp", ...(opts.skipPermissions ? ["--dangerously-skip-permissions"] : []), ...opts.args];
		const proc = spawn(opts.binary, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc;

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const onSpawn = () => {
				if (settled) return;
				settled = true;
				proc.removeListener("error", onErr);
				resolve();
			};
			const onErr = (err: Error) => {
				if (!settled) {
					settled = true;
					proc.removeListener("spawn", onSpawn);
					this.proc = null;
					reject(err);
				}
			};
			proc.once("spawn", onSpawn);
			proc.once("error", onErr);
			this.attachStreams(proc);
		});

		await this.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: "agent-workbench", version: "0.1.40" },
		});

		await this.openSession(opts.sessionId ?? null);

		if (opts.model && this.currentModel?.id !== opts.model) {
			await this.setModel("antigravity", opts.model).catch(() => {});
		}
	}

	private async openSession(targetSessionId: string | null): Promise<void> {
		const opts = this.opts;
		if (!opts) return;
		this.messages = [];
		const mcpServers = opts.mcpServers ?? [];

		let res: {
			sessionId?: string;
			models?: { availableModels?: AcpModelInfo[]; currentModelId?: string };
		};

		if (targetSessionId) {
			try {
				this.replayingHistory = true;
				res = (await this.request("session/load", {
					sessionId: targetSessionId,
					cwd: opts.cwd,
					mcpServers,
				})) as typeof res;
			} catch {
				this.replayingHistory = false;
				this.messages = [];
				res = await this.createNewSession(opts, mcpServers);
			} finally {
				this.replayingHistory = false;
			}
		} else {
			res = await this.createNewSession(opts, mcpServers);
		}

		this.sessionId = res.sessionId ?? targetSessionId ?? `acp-${Date.now()}`;
		const rawModels = res.models?.availableModels ?? [];
		this.availableModels = rawModels.map((m) => ({
			id: m.modelId,
			name: m.name || m.modelId,
			provider: "antigravity",
		}));
		const currentId = res.models?.currentModelId;
		this.currentModel =
			this.availableModels.find((m) => m.id === currentId) ??
			(currentId ? { id: currentId, name: currentId, provider: "antigravity" } : null);
	}

	private async createNewSession(
		opts: AcpSpawnOptions,
		mcpServers: AcpSpawnOptions["mcpServers"],
	): Promise<{ sessionId?: string; models?: { availableModels?: AcpModelInfo[]; currentModelId?: string } }> {
		const params: Record<string, unknown> = {
			cwd: opts.cwd,
			mcpServers: mcpServers ?? [],
		};
		if (opts.systemPromptAppend) {
			params._meta = {
				antigravity: {
					systemPrompt: { append: opts.systemPromptAppend },
				},
			};
		}
		return (await this.request("session/new", params)) as {
			sessionId?: string;
			models?: { availableModels?: AcpModelInfo[]; currentModelId?: string };
		};
	}

	async stop(): Promise<void> {
		if (!this.proc) return;
		this.stopping = true;
		const proc = this.proc;
		this.proc = null;

		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error("ACP client stopped"));
		}
		this.pending.clear();
		this.pendingPermissions.clear();

		await new Promise<void>((resolve) => {
			const force = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already exited
				}
				resolve();
			}, 1500);
			proc.once("exit", () => {
				clearTimeout(force);
				resolve();
			});
			try {
				proc.stdin.end();
				proc.kill("SIGTERM");
			} catch {
				clearTimeout(force);
				resolve();
			}
		});
	}

	private attachStreams(proc: ChildProcessWithoutNullStreams): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let idx: number;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line) this.handleLine(line);
			}
		});

		const errDecoder = new StringDecoder("utf8");
		proc.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + errDecoder.write(chunk)).slice(-STDERR_TAIL);
		});

		proc.on("exit", (code) => {
			const tail = buffer + decoder.end();
			if (tail.trim()) this.handleLine(tail.trim());
			const expected = this.stopping;
			this.proc = null;
			for (const [, p] of this.pending) {
				if (p.timer) clearTimeout(p.timer);
				p.reject(new Error(this.stderrTail.trim() || `Agy exited (${code ?? "signal"})`));
			}
			this.pending.clear();
			this.pendingPermissions.clear();
			for (const fn of this.exitListeners) fn({ code, stderr: this.stderrTail, expected });
		});
	}

	private handleLine(line: string): void {
		let msg: {
			id?: number | string;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { code?: number; message?: string };
		};
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}

		if (msg.id !== undefined && msg.method === undefined) {
			const pending = this.pending.get(Number(msg.id));
			if (!pending) return;
			this.pending.delete(Number(msg.id));
			if (pending.timer) clearTimeout(pending.timer);
			if (msg.error) {
				pending.reject(new Error(this.formatAcpError(msg.error.message ?? "ACP request failed")));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		if (msg.id !== undefined && msg.method !== undefined) {
			void this.handleIncomingRequest(msg.id, msg.method, msg.params ?? {});
			return;
		}

		if (msg.method === "session/update") {
			this.handleSessionUpdate(msg.params ?? {});
		}
	}

	private formatAcpError(message: string): string {
		if (/auth|login|unauthenticated|credential/i.test(message)) {
			return `${message}\nRun "agy acp --login" in your terminal to authenticate Agy.`;
		}
		return message;
	}

	private async handleIncomingRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
		if (method === "session/request_permission") {
			const options = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [];
			const toolCall = (params.toolCall ?? {}) as { title?: string };
			if (this.opts?.skipPermissions) {
				const allow =
					options.find((o) => o.kind === "allow_always") ??
					options.find((o) => o.kind === "allow_once") ??
					options[0];
				this.sendRaw({
					jsonrpc: "2.0",
					id,
					result: allow
						? { outcome: { outcome: "selected", optionId: allow.optionId } }
						: { outcome: { outcome: "cancelled" } },
				});
				return;
			}

			const uiId = `acp-perm-${id}`;
			const result = await new Promise<unknown>((resolve) => {
				this.pendingPermissions.set(uiId, { options, resolve });
				this.emit({
					type: "extension_ui_request",
					id: uiId,
					method: "select",
					title: toolCall.title || "Allow tool execution?",
					options: options.map((o) => o.name),
				});
			});
			this.sendRaw({ jsonrpc: "2.0", id, result });
			return;
		}

		this.sendRaw({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `Unsupported client method: ${method}` },
		});
	}

	private handleSessionUpdate(params: Record<string, unknown>): void {
		const update = (params.update ?? params) as Record<string, unknown>;
		const kind = String(update.sessionUpdate ?? "");

		if (this.replayingHistory) {
			if (kind === "user_message_chunk") {
				const text = this.extractChunkText(update.content);
				if (text) this.messages.push({ role: "user", content: text });
			} else if (kind === "agent_message_chunk") {
				const text = this.extractChunkText(update.content);
				if (text) {
					const last = this.messages[this.messages.length - 1];
					if (last && last.role === "assistant" && Array.isArray(last.content)) {
						const tb = last.content.find((b): b is { type: "text"; text: string } => b.type === "text");
						if (tb) tb.text += text;
						else last.content.push({ type: "text", text });
					} else {
						this.messages.push({ role: "assistant", content: [{ type: "text", text }] });
					}
				}
			}
			return;
		}

		if (kind === "agent_message_chunk") {
			const text = this.extractChunkText(update.content);
			if (!text) return;
			this.closeThinkingBlock();
			if (this.textBlockIndex === null) {
				this.textBlockIndex = this.turnBlocks.length;
				this.turnBlocks.push({ type: "text", text: "" });
				this.emit({
					type: "message_update",
					assistantMessageEvent: { type: "text_start", contentIndex: this.textBlockIndex },
				});
			}
			(this.turnBlocks[this.textBlockIndex] as { type: "text"; text: string }).text += text;
			this.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: this.textBlockIndex, delta: text },
			});
			return;
		}

		if (kind === "agent_thought_chunk") {
			const text = this.extractChunkText(update.content);
			if (!text) return;
			this.closeTextBlock();
			if (this.thinkingBlockIndex === null) {
				this.thinkingBlockIndex = this.turnBlocks.length;
				this.turnBlocks.push({ type: "thinking", thinking: "" });
				this.emit({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_start", contentIndex: this.thinkingBlockIndex },
				});
			}
			(this.turnBlocks[this.thinkingBlockIndex] as { type: "thinking"; thinking: string }).thinking += text;
			this.emit({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", contentIndex: this.thinkingBlockIndex, delta: text },
			});
			return;
		}

		if (kind === "tool_call") {
			this.closeThinkingBlock();
			this.closeTextBlock();
			const toolCallId = String(update.toolCallId ?? `tool-${Date.now()}`);
			const toolName = String(update.title || update.kind || "tool");
			const args = (update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {}) as Record<string, unknown>;
			this.activeTools.set(toolCallId, { toolCallId, toolName, args, ended: false });
			this.emit({ type: "tool_execution_start", toolCallId, toolName, args });
			return;
		}

		if (kind === "tool_call_update") {
			const toolCallId = String(update.toolCallId ?? "");
			if (!toolCallId) return;
			let tracked = this.activeTools.get(toolCallId);
			if (!tracked) {
				const toolName = String(update.title || update.kind || "tool");
				const args = (update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {}) as Record<string, unknown>;
				tracked = { toolCallId, toolName, args, ended: false };
				this.activeTools.set(toolCallId, tracked);
				this.emit({ type: "tool_execution_start", toolCallId, toolName, args });
			} else if (typeof update.title === "string" && update.title) {
				tracked.toolName = update.title;
			}

			const status = String(update.status ?? "");
			const result = this.extractToolResult(update);
			if ((status === "completed" || status === "failed") && !tracked.ended) {
				tracked.ended = true;
				this.emit({
					type: "tool_execution_end",
					toolCallId,
					toolName: tracked.toolName,
					result,
					isError: status === "failed",
				});
			} else if (!tracked.ended) {
				this.emit({
					type: "tool_execution_update",
					toolCallId,
					toolName: tracked.toolName,
					partialResult: result,
				});
			}
			return;
		}

		if (kind === "available_commands_update") {
			const raw = Array.isArray(update.availableCommands) ? update.availableCommands : [];
			this.commands = raw
				.filter((c): c is { name: string; description?: string } => typeof c?.name === "string")
				.map((c) => ({ name: c.name, description: c.description, source: "extension" }));
		}
	}

	private extractChunkText(content: unknown): string {
		if (!content) return "";
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map((c) => this.extractChunkText(c)).join("");
		if (typeof content === "object" && content !== null) {
			const obj = content as { type?: string; text?: string };
			if (typeof obj.text === "string") return obj.text;
		}
		return "";
	}

	private extractToolResult(update: Record<string, unknown>): ToolResult {
		const content: ContentBlock[] = [];
		let diff: string | undefined;
		const rawContent = Array.isArray(update.content) ? update.content : [];
		for (const item of rawContent) {
			if (!item || typeof item !== "object") continue;
			const block = item as Record<string, unknown>;
			if (block.type === "content" && block.content && typeof block.content === "object") {
				const inner = block.content as { type?: string; text?: string; data?: string; mimeType?: string };
				if (inner.type === "text" && typeof inner.text === "string") {
					content.push({ type: "text", text: inner.text });
				} else if (inner.type === "image" && typeof inner.data === "string" && typeof inner.mimeType === "string") {
					content.push({ type: "image", data: inner.data, mimeType: inner.mimeType });
				}
			} else if (block.type === "diff") {
				const path = typeof block.path === "string" ? block.path : "";
				const oldText = typeof block.oldText === "string" ? block.oldText : "";
				const newText = typeof block.newText === "string" ? block.newText : "";
				diff = `--- ${path}\n+++ ${path}\n${oldText ? `-${oldText.split("\n").join("\n-")}\n` : ""}+${newText.split("\n").join("\n+")}`;
			}
		}
		if (!content.length && update.rawOutput !== undefined) {
			const text = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2);
			if (text) content.push({ type: "text", text });
		}
		return { content, details: diff ? { diff } : undefined };
	}

	private emit(event: RpcEvent): void {
		for (const fn of this.eventListeners) fn(event);
	}

	private sendRaw(payload: Record<string, unknown>): void {
		if (!this.proc || !this.proc.stdin.writable) return;
		this.proc.stdin.write(JSON.stringify(payload) + "\n");
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this.proc) return Promise.reject(new Error("Agy is not running."));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = LONG_RUNNING_METHODS.has(method)
				? null
				: setTimeout(() => {
						this.pending.delete(id);
						reject(new Error(`ACP request timed out: ${method}`));
					}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { method, resolve, reject, timer });
			this.sendRaw({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.sendRaw({ jsonrpc: "2.0", method, params });
	}

	private closeTextBlock(): void {
		if (this.textBlockIndex === null) return;
		const block = this.turnBlocks[this.textBlockIndex] as { type: "text"; text: string } | undefined;
		this.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_end", contentIndex: this.textBlockIndex, content: block?.text ?? "" },
		});
		this.textBlockIndex = null;
	}

	private closeThinkingBlock(): void {
		if (this.thinkingBlockIndex === null) return;
		const block = this.turnBlocks[this.thinkingBlockIndex] as { type: "thinking"; thinking: string } | undefined;
		this.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", contentIndex: this.thinkingBlockIndex, content: block?.thinking ?? "" },
		});
		this.thinkingBlockIndex = null;
	}

	async prompt(message: string, opts: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } = {}): Promise<void> {
		if (!this.sessionId) throw new Error("No active ACP session.");
		const promptBlocks: Record<string, unknown>[] = [{ type: "text", text: message }];
		const userContent: ContentBlock[] = [{ type: "text", text: message }];
		for (const img of opts.images ?? []) {
			promptBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
			userContent.push(img);
		}

		const userMessage: AgentMessage = { role: "user", content: userContent, timestamp: Date.now() };
		this.messages.push(userMessage);
		this.isStreaming = true;
		this.textBlockIndex = null;
		this.thinkingBlockIndex = null;
		this.turnBlocks = [];
		this.activeTools.clear();

		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		this.emit({ type: "message_start", message: userMessage });
		this.emit({ type: "message_end", message: userMessage });
		const assistantStart: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
		this.emit({ type: "message_start", message: assistantStart });

		let stopReason: "stop" | "aborted" | "error" = "stop";
		let errorMessage: string | undefined;
		try {
			const res = (await this.request("session/prompt", {
				sessionId: this.sessionId,
				prompt: promptBlocks,
			})) as { stopReason?: string };
			if (res?.stopReason === "cancelled") stopReason = "aborted";
		} catch (err) {
			stopReason = "error";
			errorMessage = (err as Error).message || String(err);
			throw err;
		} finally {
			this.isStreaming = false;
			this.closeThinkingBlock();
			this.closeTextBlock();
			const finalAssistant: AgentMessage = {
				role: "assistant",
				content: this.turnBlocks,
				stopReason,
				errorMessage,
				timestamp: Date.now(),
			};
			this.messages.push(finalAssistant);
			this.emit({ type: "message_end", message: finalAssistant });
			this.emit({ type: "agent_end" });
			this.emit({ type: "agent_settled", aborted: stopReason === "aborted" });
		}
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.prompt(message, { images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.prompt(message, { images });
	}

	async abort(): Promise<void> {
		if (!this.sessionId) return;
		this.notify("session/cancel", { sessionId: this.sessionId });
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return { steering: [], followUp: [] };
	}

	async getState(): Promise<SessionState> {
		return {
			model: this.currentModel,
			thinkingLevel: "off",
			isStreaming: this.isStreaming,
			isCompacting: false,
			sessionFile: this.sessionId ? `acp:${this.sessionId}` : undefined,
			sessionId: this.sessionId ?? undefined,
			messageCount: this.messages.length,
			pendingMessageCount: 0,
		};
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.messages;
	}

	async getCommands(): Promise<SlashCommand[]> {
		return this.commands;
	}

	async getAvailableModels(): Promise<Model[]> {
		return this.availableModels;
	}

	async setModel(_provider: string, modelId: string): Promise<Model> {
		if (!this.sessionId) throw new Error("No active ACP session.");
		await this.request("session/set_model", { sessionId: this.sessionId, modelId });
		const found = this.availableModels.find((m) => m.id === modelId) ?? {
			id: modelId,
			name: modelId,
			provider: "antigravity",
		};
		this.currentModel = found;
		return found;
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		return [];
	}

	async setThinkingLevel(_level: ThinkingLevel): Promise<void> {}

	async getSessionStats(): Promise<SessionStats> {
		return {
			cost: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		await this.openSession(null);
		return { cancelled: false };
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const id = sessionPath.startsWith("acp:") ? sessionPath.slice(4) : sessionPath;
		await this.openSession(id);
		return { cancelled: false };
	}

	async setSessionName(_name: string): Promise<void> {}

	async cloneSession(): Promise<{ cancelled: boolean }> {
		return { cancelled: true };
	}

	async fork(_entryId: string): Promise<{ cancelled: boolean }> {
		return { cancelled: true };
	}

	async getEntries(): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		return { entries: [], leafId: null };
	}

	async startBranch(): Promise<void> {}

	async navigateTree(_targetId: string, _opts?: { summarize?: boolean }): Promise<void> {}

	async compact(_customInstructions?: string): Promise<unknown> {
		return null;
	}

	respondToUi(id: string, response: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
		const pending = this.pendingPermissions.get(id);
		if (!pending) return;
		this.pendingPermissions.delete(id);
		if ("cancelled" in response && response.cancelled) {
			pending.resolve({ outcome: { outcome: "cancelled" } });
			return;
		}
		if ("value" in response) {
			const match = pending.options.find((o) => o.name === response.value);
			if (match) {
				pending.resolve({ outcome: { outcome: "selected", optionId: match.optionId } });
				return;
			}
		}
		pending.resolve({ outcome: { outcome: "cancelled" } });
	}
}
