import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { StringDecoder } from "string_decoder";
import type { SessionSummary } from "../sessions";
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
	ElicitationChoice,
	ElicitationProperty,
	ElicitationSchema,
	ImageContent,
	Model,
	RpcEvent,
	SessionEntry,
	SessionState,
	SessionStats,
	SlashCommand,
	ThinkingLevel,
	ToolResult,
	UiResponse,
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

interface AcpConfigOptionValue {
	value: string;
	name?: string;
	description?: string;
}

interface AcpConfigOption {
	id: string;
	name?: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options?: AcpConfigOptionValue[];
}

interface AcpSessionResponse {
	sessionId?: string;
	models?: { availableModels?: AcpModelInfo[]; currentModelId?: string };
	configOptions?: AcpConfigOption[];
}

interface PendingElicitation {
	toolCallId?: string;
	schema: ElicitationSchema;
	resolve: (result: unknown) => void;
}

interface TrackedToolCall {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	ended: boolean;
}

interface QueuedAcpPrompt {
	message: string;
	images?: ImageContent[];
}

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CANONICAL_TOOL_NAMES = new Set(["invoke_subagent", "manage_subagents", "ask_question", "update_steps"]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && VALID_THINKING_LEVELS.has(value as ThinkingLevel);
}

function normalizeElicitationSchema(raw: unknown): ElicitationSchema {
	if (!raw || typeof raw !== "object") return { type: "object", properties: {} };
	const obj = raw as Record<string, unknown>;
	const rawProps = obj.properties && typeof obj.properties === "object" ? (obj.properties as Record<string, unknown>) : {};
	const properties: Record<string, ElicitationProperty> = {};
	for (const [key, val] of Object.entries(rawProps)) {
		if (val && typeof val === "object") properties[key] = val as ElicitationProperty;
	}
	const required = Array.isArray(obj.required) ? obj.required.filter((r): r is string => typeof r === "string") : undefined;
	return { type: "object", properties, ...(required?.length ? { required } : {}) };
}

function choicesOf(prop: ElicitationProperty): ElicitationChoice[] {
	if (Array.isArray(prop.oneOf)) return prop.oneOf;
	if (Array.isArray(prop.items?.anyOf)) return prop.items.anyOf;
	if (Array.isArray(prop.enum)) {
		return prop.enum.map((v, i) => ({ const: v, title: prop.enumNames?.[i] ?? v }));
	}
	if (Array.isArray(prop.items?.enum)) {
		return prop.items.enum.map((v) => ({ const: v, title: v }));
	}
	return [];
}

function buildElicitationDetails(
	schema: ElicitationSchema,
	content: Record<string, unknown> | null,
	cancelled: boolean,
): Record<string, unknown> {
	const answers: Array<{
		question: string;
		kind: "option" | "custom" | "multi";
		answer: string | null;
		selected?: string[];
	}> = [];
	const entries = Object.entries(schema.properties);
	const consumed = new Set<string>();

	for (const [key, prop] of entries) {
		if (consumed.has(key)) continue;
		const otherKey = `${key}_other`;
		const hasOther = otherKey in schema.properties && schema.properties[otherKey]?.type === "string";
		const choices = choicesOf(prop);
		const isMulti = prop.type === "array" && choices.length > 0;
		const isSingle = prop.type === "string" && choices.length > 0;
		const question = prop.title || key;

		if (isMulti || isSingle) {
			if (hasOther) consumed.add(otherKey);
			const rawVal = content?.[key];
			const otherVal = hasOther && typeof content?.[otherKey] === "string" ? content[otherKey].trim() : "";
			const labelFor = (code: string) => choices.find((c) => c.const === code)?.title ?? code;

			if (isMulti) {
				const selected = Array.isArray(rawVal) ? rawVal.map((v) => labelFor(String(v))) : [];
				if (selected.length || otherVal || !cancelled) {
					answers.push({
						question,
						kind: "multi",
						selected,
						answer: otherVal || null,
					});
				}
			} else {
				const selectedLabel = typeof rawVal === "string" && rawVal ? labelFor(rawVal) : null;
				if (otherVal && !selectedLabel) {
					answers.push({ question, kind: "custom", answer: otherVal });
				} else if (selectedLabel && otherVal) {
					answers.push({ question, kind: "option", answer: `${selectedLabel}; ${otherVal}` });
				} else if (selectedLabel || !cancelled) {
					answers.push({ question, kind: "option", answer: selectedLabel });
				}
			}
			continue;
		}

		const rawVal = content?.[key];
		if (rawVal === undefined && cancelled) continue;
		const answer =
			typeof rawVal === "boolean"
				? rawVal
					? "Yes"
					: "No"
				: rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== ""
					? String(rawVal)
					: null;
		answers.push({ question, kind: "custom", answer });
	}

	return { answers, ...(cancelled ? { cancelled: true } : {}) };
}

function stepsToTodoTasks(steps: unknown): Array<{ id: number; subject: string; status: "pending" | "in_progress" | "completed" | "deleted" }> | null {
	if (!Array.isArray(steps)) return null;
	const tasks: Array<{ id: number; subject: string; status: "pending" | "in_progress" | "completed" | "deleted" }> = [];
	steps.forEach((step, idx) => {
		if (!step || typeof step !== "object") return;
		const s = step as { title?: unknown; status?: unknown };
		if (typeof s.title !== "string" || !s.title.trim()) return;
		const rawStatus = typeof s.status === "string" ? s.status : "pending";
		let status: "pending" | "in_progress" | "completed" | "deleted" = "pending";
		let subject = s.title.trim();
		if (rawStatus === "done" || rawStatus === "completed") status = "completed";
		else if (rawStatus === "in_progress") status = "in_progress";
		else if (rawStatus === "skipped" || rawStatus === "deleted") status = "deleted";
		else if (rawStatus === "failed") {
			status = "pending";
			subject = `${subject} (failed)`;
		}
		tasks.push({ id: idx + 1, subject, status });
	});
	return tasks.length ? tasks : null;
}

const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4000;
const UNSOLICITED_SETTLE_MS = 2500;
const LONG_RUNNING_METHODS = new Set(["session/prompt", "session/new", "session/load"]);

export class AcpClient implements AgentClient {
	readonly backend: AgentBackend = "acp";
	readonly capabilities: AgentCapabilities = capabilitiesForBackend("acp");

	private proc: ChildProcessWithoutNullStreams | null = null;
	private opts: AcpSpawnOptions | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingJsonRpc>();
	private pendingPermissions = new Map<string, { options: AcpPermissionOption[]; resolve: (result: unknown) => void }>();
	private pendingElicitations = new Map<string, PendingElicitation>();
	private resolvedElicitationDetails = new Map<string, Record<string, unknown>>();
	private eventListeners = new Set<EventListener>();
	private exitListeners = new Set<ExitListener>();
	private stderrTail = "";
	private stopping = false;

	private sessionId: string | null = null;
	private sessionName: string | undefined = undefined;
	private customSessionName = false;
	private availableModels: Model[] = [];
	private currentModel: Model | null = null;
	private currentBaseModelId: string | null = null;
	private availableThinkingLevels: ThinkingLevel[] = [];
	private currentThinkingLevel: ThinkingLevel = "off";
	private contextUsed: number | null = null;
	private contextSize: number | null = null;
	private usageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	private commands: SlashCommand[] = [];
	private messages: AgentMessage[] = [];
	private isStreaming = false;
	private replayingHistory = false;
	private unsolicitedTurn = false;
	private unsolicitedTimer: ReturnType<typeof setTimeout> | null = null;
	private steeringQueue: QueuedAcpPrompt[] = [];
	private followUpQueue: QueuedAcpPrompt[] = [];
	private draining = false;
	private steerInterruptPending = false;
	private userAborted = false;

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
		await this.spawnAndInitialize(spawnOpts);
		await this.openSession(spawnOpts.sessionId ?? null);

		if (spawnOpts.model && this.currentModel?.id !== spawnOpts.model) {
			await this.setModel("antigravity", spawnOpts.model).catch(() => {});
		}
	}

	private async spawnAndInitialize(opts: AcpSpawnOptions): Promise<void> {
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
				elicitation: { form: {} },
			},
			clientInfo: { name: "agent-workbench", version: "0.1.47" },
		});
	}

	static async listSessionsOnce(opts: AcpSpawnOptions): Promise<SessionSummary[]> {
		const client = new AcpClient();
		try {
			await client.spawnAndInitialize(opts);
			return await client.listSessions(opts.cwd);
		} finally {
			await client.stop();
		}
	}

	private async openSession(targetSessionId: string | null): Promise<void> {
		const opts = this.opts;
		if (!opts) return;
		this.messages = [];
		this.sessionName = undefined;
		this.customSessionName = false;
		this.currentBaseModelId = null;
		this.availableThinkingLevels = [];
		this.currentThinkingLevel = "off";
		this.contextUsed = null;
		this.contextSize = null;
		this.usageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		this.resolvedElicitationDetails.clear();
		this.resetQueues();
		const mcpServers = opts.mcpServers ?? [];

		let res: AcpSessionResponse;

		if (targetSessionId) {
			try {
				this.replayingHistory = true;
				res = (await this.request("session/load", {
					sessionId: targetSessionId,
					cwd: opts.cwd,
					mcpServers,
				})) as AcpSessionResponse;
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
		if (Array.isArray(res.configOptions)) {
			this.applyConfigOptions(res.configOptions);
		}
	}

	private applyConfigOptions(options: AcpConfigOption[]): void {
		const thought = options.find((o) => o.id === "thought_level" || o.category === "thought_level");
		if (thought) {
			const levels = (thought.options ?? []).map((o) => o.value).filter(isThinkingLevel);
			this.availableThinkingLevels = levels;
			if (isThinkingLevel(thought.currentValue)) {
				this.currentThinkingLevel = thought.currentValue;
			} else if (levels.length && !levels.includes(this.currentThinkingLevel)) {
				this.currentThinkingLevel = levels[0];
			}
		}
		const modelOpt = options.find((o) => o.id === "model" || o.category === "model");
		if (modelOpt?.currentValue) {
			this.currentBaseModelId = modelOpt.currentValue;
		}
		const hasReasoning = this.availableThinkingLevels.length > 0;
		for (const m of this.availableModels) {
			m.reasoning = hasReasoning;
		}
		if (this.currentBaseModelId) {
			const combinedId =
				this.currentThinkingLevel !== "off" ? `${this.currentBaseModelId}-${this.currentThinkingLevel}` : this.currentBaseModelId;
			const matched =
				this.availableModels.find((m) => m.id === combinedId) ??
				this.availableModels.find((m) => m.id === this.currentBaseModelId);
			if (matched) this.currentModel = matched;
		}
		if (this.currentModel) {
			this.currentModel.reasoning = hasReasoning;
		}
	}

	private async createNewSession(
		opts: AcpSpawnOptions,
		mcpServers: AcpSpawnOptions["mcpServers"],
	): Promise<AcpSessionResponse> {
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
		return (await this.request("session/new", params)) as AcpSessionResponse;
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
		this.pendingElicitations.clear();
		this.resetQueues();
		this.settleUnsolicitedTurn("aborted");

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
			this.pendingElicitations.clear();
			this.clearUnsolicitedTimer();
			this.unsolicitedTurn = false;
			this.isStreaming = false;
			this.resetQueues();
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
		if (method === "elicitation/create") {
			const mode = typeof params.mode === "string" ? params.mode : "form";
			if (mode !== "form") {
				this.sendRaw({ jsonrpc: "2.0", id, result: { action: "decline" } });
				return;
			}
			const schema = normalizeElicitationSchema(params.requestedSchema);
			const message = typeof params.message === "string" ? params.message.trim() : "";
			const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : undefined;
			const uiId = `acp-elicit-${id}`;
			const result = await new Promise<unknown>((resolve) => {
				this.pendingElicitations.set(uiId, { toolCallId, schema, resolve });
				this.emit({
					type: "extension_ui_request",
					id: uiId,
					method: "form",
					title: message || "Agy is asking",
					schema,
				});
			});
			this.sendRaw({ jsonrpc: "2.0", id, result });
			return;
		}

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

		if (kind === "available_commands_update") {
			const raw = Array.isArray(update.availableCommands) ? update.availableCommands : [];
			this.commands = raw
				.filter((c): c is { name: string; description?: string } => typeof c?.name === "string")
				.map((c) => ({ name: c.name, description: c.description, source: "extension" }));
			return;
		}

		if (kind === "config_option_update") {
			if (Array.isArray(update.configOptions)) {
				this.applyConfigOptions(update.configOptions as AcpConfigOption[]);
			}
			return;
		}

		if (kind === "session_info_update") {
			const title = typeof update.title === "string" ? update.title.trim() : "";
			if (title && !this.customSessionName) {
				this.sessionName = title;
				this.emit({
					type: "extension_ui_request",
					id: `acp-title-${Date.now()}`,
					method: "setTitle",
					title,
				});
			}
			return;
		}

		if (kind === "usage_update") {
			const used = typeof update.used === "number" ? update.used : null;
			const size = typeof update.size === "number" ? update.size : null;
			if (used !== null && used >= 0) this.contextUsed = used;
			if (size !== null && size > 0) this.contextSize = size;
			if (this.unsolicitedTurn) this.bumpUnsolicitedTimer();
			return;
		}

		if (
			kind !== "agent_message_chunk" &&
			kind !== "agent_thought_chunk" &&
			kind !== "tool_call" &&
			kind !== "tool_call_update"
		) {
			return;
		}

		// Background subagent wakeups can stream session/update notifications after session/prompt returned.
		if (!this.isStreaming) {
			this.beginUnsolicitedTurn();
		}
		if (this.unsolicitedTurn) {
			this.bumpUnsolicitedTimer();
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
			const toolName = this.resolveToolName(update);
			const args = this.extractToolArgs(update);
			this.activeTools.set(toolCallId, { toolCallId, toolName, args, ended: false });
			this.emit({ type: "tool_execution_start", toolCallId, toolName, args });
			return;
		}

		if (kind === "tool_call_update") {
			const toolCallId = String(update.toolCallId ?? "");
			if (!toolCallId) return;
			const incomingArgs = this.extractToolArgs(update);
			let tracked = this.activeTools.get(toolCallId);
			if (!tracked) {
				const toolName = this.resolveToolName(update);
				tracked = { toolCallId, toolName, args: incomingArgs, ended: false };
				this.activeTools.set(toolCallId, tracked);
				this.emit({ type: "tool_execution_start", toolCallId, toolName, args: incomingArgs });
			} else {
				tracked.toolName = this.resolveToolName(update, tracked.toolName);
				if (Object.keys(incomingArgs).length > 0) tracked.args = incomingArgs;
			}

			const status = String(update.status ?? "");
			const result = this.extractToolResult(update, tracked);
			if ((status === "completed" || status === "failed") && !tracked.ended) {
				tracked.ended = true;
				this.resolvedElicitationDetails.delete(toolCallId);
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
	}

	private extractToolArgs(update: Record<string, unknown>): Record<string, unknown> {
		if (update.rawInput && typeof update.rawInput === "object") return update.rawInput as Record<string, unknown>;
		if (update.args && typeof update.args === "object") return update.args as Record<string, unknown>;
		return {};
	}

	private resolveToolName(update: Record<string, unknown>, fallback?: string): string {
		const rawName = typeof update.name === "string" ? update.name : "";
		if (CANONICAL_TOOL_NAMES.has(rawName)) return rawName;
		if (fallback && CANONICAL_TOOL_NAMES.has(fallback)) return fallback;
		return String(update.title || rawName || update.kind || fallback || "tool");
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

	private extractToolResult(update: Record<string, unknown>, tracked?: TrackedToolCall): ToolResult {
		const content: ContentBlock[] = [];
		let details: Record<string, unknown> | undefined;
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
				details = {
					...details,
					diff: `--- ${path}\n+++ ${path}\n${oldText ? `-${oldText.split("\n").join("\n-")}\n` : ""}+${newText.split("\n").join("\n+")}`,
				};
			}
		}
		if (!content.length && update.rawOutput !== undefined) {
			const text = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2);
			if (text) content.push({ type: "text", text });
		}
		if (tracked) {
			const elicitDetails = this.resolvedElicitationDetails.get(tracked.toolCallId);
			if (elicitDetails) {
				details = { ...details, ...elicitDetails };
			}
			if (tracked.toolName === "update_steps") {
				const tasks = stepsToTodoTasks(tracked.args.steps);
				if (tasks) details = { ...details, tasks };
			}
		}
		return { content, details };
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

	private clearUnsolicitedTimer(): void {
		if (this.unsolicitedTimer) {
			clearTimeout(this.unsolicitedTimer);
			this.unsolicitedTimer = null;
		}
	}

	private bumpUnsolicitedTimer(): void {
		this.clearUnsolicitedTimer();
		for (const tool of this.activeTools.values()) {
			if (!tool.ended) return;
		}
		this.unsolicitedTimer = setTimeout(() => this.settleUnsolicitedTurn("stop"), UNSOLICITED_SETTLE_MS);
	}

	private beginUnsolicitedTurn(): void {
		this.unsolicitedTurn = true;
		this.isStreaming = true;
		this.textBlockIndex = null;
		this.thinkingBlockIndex = null;
		this.turnBlocks = [];
		this.activeTools.clear();
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		const assistantStart: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
		this.emit({ type: "message_start", message: assistantStart });
	}

	private emitQueueUpdate(): void {
		this.emit({
			type: "queue_update",
			steering: this.steeringQueue.map((q) => q.message),
			followUp: this.followUpQueue.map((q) => q.message),
		});
	}

	private resetQueues(): void {
		const hadQueued = this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
		this.steeringQueue = [];
		this.followUpQueue = [];
		this.draining = false;
		this.steerInterruptPending = false;
		this.userAborted = false;
		if (hadQueued) this.emitQueueUpdate();
	}

	private settleUnsolicitedTurn(stopReason: "stop" | "aborted" | "error" = "stop", errorMessage?: string): void {
		this.clearUnsolicitedTimer();
		if (!this.unsolicitedTurn) return;
		this.unsolicitedTurn = false;
		const next = !this.stopping && stopReason === "stop" ? this.shiftNextQueued() : null;
		if (next) {
			this.finalizeAssistantMessage(stopReason, errorMessage);
			void this.runPromptLoop(next, false).catch(() => {});
			return;
		}
		this.finishAssistantTurn(stopReason, errorMessage);
	}

	private finalizeAssistantMessage(stopReason: "stop" | "aborted" | "error", errorMessage?: string): void {
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
	}

	private finishAssistantTurn(stopReason: "stop" | "aborted" | "error", errorMessage?: string): void {
		this.isStreaming = false;
		this.finalizeAssistantMessage(stopReason, errorMessage);
		this.emit({ type: "agent_end" });
		this.emit({ type: "agent_settled", aborted: stopReason === "aborted" });
	}

	private shiftNextQueued(): QueuedAcpPrompt | null {
		if (this.steeringQueue.length > 0) {
			const item = this.steeringQueue.shift()!;
			this.emitQueueUpdate();
			return item;
		}
		if (this.followUpQueue.length > 0) {
			const item = this.followUpQueue.shift()!;
			this.emitQueueUpdate();
			return item;
		}
		return null;
	}

	private requestSteerInterrupt(): void {
		if (this.steerInterruptPending || !this.sessionId) return;
		this.steerInterruptPending = true;
		this.notify("session/cancel", { sessionId: this.sessionId });
	}

	async prompt(message: string, opts: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } = {}): Promise<void> {
		if (!this.sessionId) throw new Error("No active ACP session.");

		// Unsolicited background-subagent turn: queue follow-ups behind it, or interrupt immediately on steer/prompt.
		if (this.unsolicitedTurn) {
			if (opts.streamingBehavior === "followUp") {
				this.followUpQueue.push({ message, images: opts.images });
				this.emitQueueUpdate();
				return;
			}
			this.settleUnsolicitedTurn("stop");
		}

		// Already streaming a prompt turn: enqueue into steering (interrupting the active step) or followUp (after task).
		if (this.isStreaming || this.draining) {
			if (opts.streamingBehavior === "steer") {
				this.steeringQueue.push({ message, images: opts.images });
				this.emitQueueUpdate();
				this.requestSteerInterrupt();
			} else {
				this.followUpQueue.push({ message, images: opts.images });
				this.emitQueueUpdate();
			}
			return;
		}

		await this.runPromptLoop({ message, images: opts.images }, true);
	}

	private async runPromptLoop(initial: QueuedAcpPrompt, emitStart: boolean): Promise<void> {
		this.draining = true;
		this.isStreaming = true;
		this.userAborted = false;
		this.steerInterruptPending = false;
		if (emitStart) this.emit({ type: "agent_start" });

		let current: QueuedAcpPrompt | null = initial;
		let finalStopReason: "stop" | "aborted" | "error" = "stop";
		let firstTurnError: Error | null = null;
		let turnNumber = 0;

		try {
			while (current && this.sessionId && !this.stopping) {
				turnNumber++;
				const turn = await this.executeSingleTurn(current);

				// Steer cancelled the in-flight turn: seamlessly hand off to the queued steering message.
				if (this.steerInterruptPending && !this.userAborted) {
					this.steerInterruptPending = false;
					if (this.steeringQueue.length > 0) {
						this.finalizeAssistantMessage("stop");
						current = this.shiftNextQueued();
						continue;
					}
				}

				this.finalizeAssistantMessage(turn.stopReason, turn.errorMessage);
				finalStopReason = turn.stopReason;

				if (turn.error) {
					if (turnNumber === 1) firstTurnError = turn.error;
					break;
				}
				if (this.userAborted || turn.stopReason === "aborted") {
					break;
				}

				const next = this.shiftNextQueued();
				if (!next) break;
				current = next;
			}
		} finally {
			this.draining = false;
			this.isStreaming = false;
			this.steerInterruptPending = false;
			const wasAborted = this.userAborted || finalStopReason === "aborted";
			this.userAborted = false;
			this.emit({ type: "agent_end" });
			this.emit({ type: "agent_settled", aborted: wasAborted });
		}

		if (firstTurnError) throw firstTurnError;
	}

	private async executeSingleTurn(
		item: QueuedAcpPrompt,
	): Promise<{ stopReason: "stop" | "aborted" | "error"; errorMessage?: string; error?: Error }> {
		const promptBlocks: Record<string, unknown>[] = [{ type: "text", text: item.message }];
		const userContent: ContentBlock[] = [{ type: "text", text: item.message }];
		for (const img of item.images ?? []) {
			promptBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
			userContent.push(img);
		}

		const userMessage: AgentMessage = { role: "user", content: userContent, timestamp: Date.now() };
		this.messages.push(userMessage);
		this.textBlockIndex = null;
		this.thinkingBlockIndex = null;
		this.turnBlocks = [];
		this.activeTools.clear();

		this.emit({ type: "turn_start" });
		this.emit({ type: "message_start", message: userMessage });
		this.emit({ type: "message_end", message: userMessage });
		const assistantStart: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
		this.emit({ type: "message_start", message: assistantStart });

		try {
			const res = (await this.request("session/prompt", {
				sessionId: this.sessionId!,
				prompt: promptBlocks,
			})) as {
				stopReason?: string;
				usage?: {
					inputTokens?: number;
					outputTokens?: number;
					cachedReadTokens?: number;
					cachedWriteTokens?: number;
					totalTokens?: number;
				};
			};
			if (res?.usage) {
				if (typeof res.usage.inputTokens === "number") this.usageTokens.input = res.usage.inputTokens;
				if (typeof res.usage.outputTokens === "number") this.usageTokens.output = res.usage.outputTokens;
				if (typeof res.usage.cachedReadTokens === "number") this.usageTokens.cacheRead = res.usage.cachedReadTokens;
				if (typeof res.usage.cachedWriteTokens === "number") this.usageTokens.cacheWrite = res.usage.cachedWriteTokens;
				if (typeof res.usage.totalTokens === "number") this.usageTokens.total = res.usage.totalTokens;
			}
			return { stopReason: res?.stopReason === "cancelled" ? "aborted" : "stop" };
		} catch (err) {
			const error = err as Error;
			return { stopReason: "error", errorMessage: error.message || String(error), error };
		}
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.prompt(message, { streamingBehavior: "steer", images });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.prompt(message, { streamingBehavior: "followUp", images });
	}

	async abort(): Promise<void> {
		if (!this.sessionId) return;
		this.userAborted = true;
		this.steerInterruptPending = false;
		this.notify("session/cancel", { sessionId: this.sessionId });
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const steering = this.steeringQueue.splice(0).map((q) => q.message);
		const followUp = this.followUpQueue.splice(0).map((q) => q.message);
		if (steering.length || followUp.length) {
			this.emitQueueUpdate();
		}
		return { steering, followUp };
	}

	async getState(): Promise<SessionState> {
		return {
			model: this.currentModel,
			thinkingLevel: this.currentThinkingLevel,
			isStreaming: this.isStreaming,
			isCompacting: false,
			sessionFile: this.sessionId ? `acp:${this.sessionId}` : undefined,
			sessionId: this.sessionId ?? undefined,
			sessionName: this.sessionName,
			messageCount: this.messages.length,
			pendingMessageCount: this.steeringQueue.length + this.followUpQueue.length,
		};
	}

	async listSessions(cwd?: string): Promise<SessionSummary[]> {
		const targetCwd = cwd ?? this.opts?.cwd;
		const sessions: SessionSummary[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const params: Record<string, unknown> = {};
			if (targetCwd) params.cwd = targetCwd;
			if (cursor) params.cursor = cursor;
			const res = (await this.request("session/list", params)) as {
				sessions?: Array<{ sessionId?: string; cwd?: string; title?: string; updatedAt?: string }>;
				nextCursor?: string;
			};
			for (const s of res.sessions ?? []) {
				if (!s.sessionId) continue;
				const title = s.title?.trim() || "Agy session";
				const mtime = s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0;
				sessions.push({
					path: `acp:${s.sessionId}`,
					title,
					named: Boolean(s.title?.trim()),
					mtime,
				});
			}
			if (!res.nextCursor) break;
			cursor = res.nextCursor;
		}
		return sessions;
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
			reasoning: this.availableThinkingLevels.length > 0,
		};
		this.currentModel = found;
		const suffix = modelId.match(/-(off|minimal|low|medium|high|xhigh|max)$/)?.[1];
		if (suffix && isThinkingLevel(suffix)) {
			this.currentThinkingLevel = suffix;
			this.currentBaseModelId = modelId.slice(0, -(suffix.length + 1));
		}
		return found;
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		return [...this.availableThinkingLevels];
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (!this.sessionId || !this.availableThinkingLevels.length) return;
		const res = (await this.request("session/set_config_option", {
			sessionId: this.sessionId,
			configId: "thought_level",
			value: level,
		})) as { configOptions?: AcpConfigOption[] } | null;
		this.currentThinkingLevel = level;
		if (Array.isArray(res?.configOptions)) {
			this.applyConfigOptions(res.configOptions);
		}
	}

	async getSessionStats(): Promise<SessionStats> {
		const contextUsage =
			this.contextSize && this.contextSize > 0
				? {
						tokens: this.contextUsed,
						contextWindow: this.contextSize,
						percent: this.contextUsed !== null ? (this.contextUsed / this.contextSize) * 100 : null,
					}
				: undefined;
		return {
			cost: 0,
			tokens: { ...this.usageTokens },
			contextUsage,
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

	async setSessionName(name: string): Promise<void> {
		const trimmed = name.trim();
		this.sessionName = trimmed || undefined;
		this.customSessionName = Boolean(trimmed);
	}

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

	respondToUi(id: string, response: UiResponse): void {
		const pendingElicit = this.pendingElicitations.get(id);
		if (pendingElicit) {
			this.pendingElicitations.delete(id);
			if ("cancelled" in response && response.cancelled) {
				if (pendingElicit.toolCallId) {
					this.resolvedElicitationDetails.set(
						pendingElicit.toolCallId,
						buildElicitationDetails(pendingElicit.schema, null, true),
					);
				}
				pendingElicit.resolve({ action: "cancel" });
				return;
			}
			if ("declined" in response && response.declined) {
				if (pendingElicit.toolCallId) {
					this.resolvedElicitationDetails.set(
						pendingElicit.toolCallId,
						buildElicitationDetails(pendingElicit.schema, null, true),
					);
				}
				pendingElicit.resolve({ action: "decline" });
				return;
			}
			if ("content" in response && response.content && typeof response.content === "object") {
				if (pendingElicit.toolCallId) {
					this.resolvedElicitationDetails.set(
						pendingElicit.toolCallId,
						buildElicitationDetails(pendingElicit.schema, response.content, false),
					);
				}
				pendingElicit.resolve({ action: "accept", content: response.content });
				return;
			}
			pendingElicit.resolve({ action: "cancel" });
			return;
		}

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
