import type { PiSpawnOptions } from "./PiRpcClient";
import type {
	AgentMessage,
	ImageContent,
	Model,
	RpcEvent,
	SessionEntry,
	SessionState,
	SessionStats,
	SlashCommand,
	ThinkingLevel,
	UiResponse,
} from "./types";

export type AgentBackend = "pi" | "acp";

/** Short user-facing name for an agent backend. */
export function backendLabel(backend: AgentBackend): string {
	return backend === "acp" ? "Agy" : "Pi";
}

export interface AgentCapabilities {
	queueing: boolean;
	branching: boolean;
	compaction: boolean;
	sessionFiles: boolean;
	thinkingLevels: boolean;
	extensionUi: boolean;
}

const PI_CAPABILITIES: AgentCapabilities = {
	queueing: true,
	branching: true,
	compaction: true,
	sessionFiles: true,
	thinkingLevels: true,
	extensionUi: true,
};

const ACP_CAPABILITIES: AgentCapabilities = {
	queueing: true,
	branching: false,
	compaction: false,
	sessionFiles: false,
	thinkingLevels: true,
	extensionUi: true,
};

export function capabilitiesForBackend(backend: AgentBackend): AgentCapabilities {
	return { ...(backend === "acp" ? ACP_CAPABILITIES : PI_CAPABILITIES) };
}

export interface AcpMcpServerStdio {
	name: string;
	command: string;
	args: string[];
	env: { name: string; value: string }[];
}

export interface AcpSpawnOptions {
	binary: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	sessionId?: string | null;
	model?: string;
	systemPromptAppend?: string;
	skipPermissions: boolean;
	mcpServers?: AcpMcpServerStdio[];
}

export type AgentSpawnOptions = PiSpawnOptions | AcpSpawnOptions;

export type EventListener = (event: RpcEvent) => void;
export type ExitListener = (info: { code: number | null; stderr: string; expected: boolean }) => void;
export type ReconnectListener = (reattached: boolean) => void;

export interface AgentClient {
	readonly backend: AgentBackend;
	readonly capabilities: AgentCapabilities;
	readonly running: boolean;
	readonly isReconnecting: boolean;

	onEvent(fn: EventListener): () => void;
	onExit(fn: ExitListener): () => void;
	onReconnecting(fn: () => void): () => void;
	onReconnected(fn: ReconnectListener): () => void;

	start(opts: AgentSpawnOptions): Promise<void>;
	stop(): Promise<void>;
	nudgeReconnect(): void;
	finishRemoteSync(): void;

	prompt(message: string, opts?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] }): Promise<void>;
	steer(message: string, images?: ImageContent[]): Promise<void>;
	followUp(message: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;

	getState(): Promise<SessionState>;
	getMessages(): Promise<AgentMessage[]>;
	getCommands(): Promise<SlashCommand[]>;
	getAvailableModels(): Promise<Model[]>;
	setModel(provider: string, modelId: string): Promise<Model>;
	getAvailableThinkingLevels(): Promise<ThinkingLevel[]>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getSessionStats(): Promise<SessionStats>;

	newSession(): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	setSessionName(name: string): Promise<void>;
	cloneSession(): Promise<{ cancelled: boolean }>;
	fork(entryId: string): Promise<{ text?: string; cancelled: boolean }>;
	getEntries(): Promise<{ entries: SessionEntry[]; leafId: string | null }>;
	startBranch(): Promise<void>;
	navigateTree(targetId: string, opts?: { summarize?: boolean }): Promise<void>;
	compact(customInstructions?: string): Promise<unknown>;
	respondToUi(id: string, response: UiResponse): void;
}
