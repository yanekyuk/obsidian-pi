import { basename } from "path";
import { splitContext } from "./prompt";
import type { AgentMessage, ContentBlock, ToolCallContent } from "./rpc/types";
import { contentText } from "./sessions";
import { SESSION_PROPERTY } from "./noteLink";

// A conversation as a note: what was said, in order, with tool calls as one-line asides.
// Thinking and tool output stay out; they are pi's working, not the conversation.

const MAX_ARG_CHARS = 80;

function toolLine(call: ToolCallContent): string {
	const args = call.arguments ?? {};
	const path = typeof args.path === "string" ? args.path : typeof args.command === "string" ? args.command : typeof args.query === "string" ? args.query : "";
	const detail = path.replace(/\s+/g, " ").slice(0, MAX_ARG_CHARS);
	return `> ⚙ \`${call.name}\`${detail ? ` ${detail}` : ""}`;
}

export function transcriptMarkdown(messages: AgentMessage[], title: string, sessionFile: string | null, date = new Date()): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const { text, notePath, hasSelection } = splitContext(contentText(message.content));
			const context = notePath ? `*Looking at [[${notePath.replace(/\.md$/, "")}]]${hasSelection ? ", with a selection" : ""}*\n\n` : "";
			if (text || context) parts.push(`**You**\n\n${context}${text}`.trimEnd());
		} else if (message.role === "assistant") {
			const lines: string[] = [];
			for (const block of message.content as ContentBlock[]) {
				if (block.type === "text" && block.text.trim()) lines.push(block.text.trim());
				else if (block.type === "toolCall") lines.push(toolLine(block as ToolCallContent));
			}
			if (lines.length) parts.push(`**pi**\n\n${lines.join("\n\n")}`);
		}
	}
	const properties = [`---`, sessionFile ? `${SESSION_PROPERTY}: ${basename(sessionFile)}` : null, `exported: ${date.toISOString().slice(0, 10)}`, `---`].filter(Boolean).join("\n");
	return `${properties}\n\n# ${title}\n\n${parts.join("\n\n---\n\n")}\n`;
}
