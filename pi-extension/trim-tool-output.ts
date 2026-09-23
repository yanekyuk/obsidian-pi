// Keeps long conversations light: before each model call, the bulky output of tool calls from
// earlier turns (whole notes pi read, fetched pages, screenshots) is replaced by one line saying
// what it was, so pi can run the tool again if it still needs it. Part of the Pi Harness plugin,
// which loads this file with `pi -e` when "Trim old tool output" is switched on.
//
// Only what goes to the model for that request changes. The session file, the panel and
// compaction still see every output in full, and switching this off brings it all back.
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];
type ToolResult = Extract<Message, { role: "toolResult" }>;

// The tool output of this many of the latest user turns is always sent whole.
const KEEP_RECENT_TURNS = 3;
// Providers reuse a cached prompt up to its first change, so the trimmed part grows by this many
// turns at a time rather than every turn: the cache is rebuilt once per step, not on each message.
const TRIM_STEP_TURNS = 3;
// Output shorter than this stays; a stand-in would save little. An image is always trimmed.
const MIN_TRIMMED_CHARS = 2000;
const MAX_ARGUMENT_CHARS = 80;
const MAX_ARGUMENTS_SHOWN = 3;

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => {
		const end = trimmedPrefixEnd(event.messages);
		if (end === 0) return;
		const argumentsById = toolCallArguments(event.messages.slice(0, end));
		const messages = event.messages.map((message, i) => (i < end && isBulkyToolResult(message) ? standIn(message, argumentsById.get(message.toolCallId)) : message));
		return { messages };
	});
}

/** Index of the first message sent whole: the start of a user turn at least KEEP_RECENT_TURNS back, moved in steps. 0 when nothing is trimmed. */
function trimmedPrefixEnd(messages: Message[]): number {
	const turnStarts = messages.flatMap((message, i) => (message.role === "user" ? [i] : []));
	const olderTurns = Math.max(0, turnStarts.length - KEEP_RECENT_TURNS);
	const trimmedTurns = Math.floor(olderTurns / TRIM_STEP_TURNS) * TRIM_STEP_TURNS;
	return trimmedTurns === 0 ? 0 : turnStarts[trimmedTurns];
}

function isBulkyToolResult(message: Message): message is ToolResult {
	if (message.role !== "toolResult") return false;
	return message.content.some((block) => block.type === "image") || textLength(message) >= MIN_TRIMMED_CHARS;
}

function standIn(result: ToolResult, args: Record<string, unknown> | undefined): ToolResult {
	const images = result.content.filter((block) => block.type === "image").length;
	const size = [`${textLength(result)} characters`, images ? `${images} image${images === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
	const text = `[Trimmed from the context to save space: the output of ${describeCall(result.toolName, args)}, ${size}. Run the tool again if you need it.]`;
	return { ...result, content: [{ type: "text", text }] };
}

function textLength(result: ToolResult): number {
	return result.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
}

/** The arguments of every tool call the assistant made, by call id. */
function toolCallArguments(messages: Message[]): Map<string, Record<string, unknown>> {
	const byId = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") byId.set(block.id, block.arguments);
	}
	return byId;
}

/** Like read(path="Notes/Plan.md"): enough for pi to recognise the call and repeat it. */
function describeCall(toolName: string, args: Record<string, unknown> | undefined): string {
	const shown = Object.entries(args ?? {})
		.filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		.slice(0, MAX_ARGUMENTS_SHOWN)
		.map(([name, value]) => {
			const text = String(value);
			return `${name}=${JSON.stringify(text.length > MAX_ARGUMENT_CHARS ? `${text.slice(0, MAX_ARGUMENT_CHARS)}…` : text)}`;
		});
	return `${toolName}(${shown.join(", ")})`;
}
