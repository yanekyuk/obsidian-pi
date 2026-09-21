// Shapes from pi's RPC protocol (docs/rpc.md in @earendil-works/pi-coding-agent).
// Only the fields the plugin reads are typed; everything else passes through.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Model {
	id: string;
	name: string;
	provider: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
}

export interface SessionState {
	model?: Model | null;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
}

export interface SessionStats {
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface SlashCommand {
	name: string;
	description?: string;
	// "panel" marks commands the plugin answers itself; pi reports the other three.
	source: "extension" | "prompt" | "skill" | "panel";
}

export interface TextContent {
	type: "text";
	text: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}
export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
export type ContentBlock = TextContent | ThinkingContent | ToolCallContent | ImageContent;

export interface ToolResult {
	content?: ContentBlock[];
	details?: { diff?: string; [key: string]: unknown } | null;
}

export type AgentMessage =
	| { role: "user"; content: string | ContentBlock[]; timestamp?: number }
	| {
			role: "assistant";
			content: ContentBlock[];
			stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
			errorMessage?: string;
			timestamp?: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlock[];
			details?: ToolResult["details"];
			isError: boolean;
	  }
	| { role: "bashExecution"; command: string; output: string; exitCode: number | null }
	| { role: string; [key: string]: unknown };

export type AssistantMessageEvent =
	| { type: "text_start" | "thinking_start"; contentIndex: number }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_end"; contentIndex: number; content?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent };

export interface ExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
	text?: string;
}

export type RpcEvent =
	| { type: "agent_start" | "agent_settled" | "turn_start" }
	| { type: "agent_end"; willRetry?: boolean }
	| { type: "message_start" | "message_end"; message: AgentMessage }
	| { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: ToolResult }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; reason: string; aborted?: boolean; willRetry?: boolean; errorMessage?: string; result?: { tokensBefore?: number; estimatedTokensAfter?: number } | null }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "extension_error"; extensionPath: string; event: string; error: string }
	| ExtensionUiRequest;

export interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}
