import type { AgentMessage, SessionEntry, UserMessage } from "../rpc/types";

export const TREE_COMMAND = "pi-workbench:tree";
export const BRANCH_ANCHOR_TYPE = "pi-workbench:branch-anchor";
export const BRANCH_START_TYPE = "pi-workbench:branch-start";

const BRANCH_PREAMBLE = /^The user explored a different conversation branch before returning here\.\s*Summary of that exploration:\s*/i;

export function cleanBranchSummary(raw: string): string {
	return raw.replace(BRANCH_PREAMBLE, "").trim();
}

export interface ActiveBranch {
	startId: string;
	anchorId: string;
	// How many transcript-visible items (user, assistant, toolResult, branchSummary) sit
	// inside this branch at the tail of get_messages().
	messageCount: number;
}

// Editing a message the user sent, to run the conversation again from there. The bubble turns
// into a text box in place; what happens on send is ChatSession.rerunFrom.

// Opens the editor in a user message's bubble. The note chip and images stay in view, since
// they go out again with the new words. `resend` resolves once the edit has been dealt with;
// a failed one leaves the editor open to try again or cancel.
export function editInPlace(bubble: HTMLElement, text: string, resend: (text: string) => Promise<void>): void {
	if (bubble.hasClass("is-editing")) return;
	const shownText = bubble.querySelector<HTMLElement>(":scope > .pi-text");
	shownText?.hide();
	bubble.addClass("is-editing");

	const form = bubble.createDiv({ cls: "pi-msg-edit" });
	const input = form.createEl("textarea", { cls: "pi-input", attr: { rows: "1" } });
	input.value = text;
	const buttons = form.createDiv({ cls: "pi-msg-edit-buttons" });
	const cancelBtn = buttons.createEl("button", { text: "Cancel" });
	const sendBtn = buttons.createEl("button", { cls: "mod-cta", text: "Send", attr: { "aria-label": "Run the conversation again from here (Enter)" } });

	const grow = () => {
		input.setCssStyles({ height: "auto" });
		input.setCssStyles({ height: `${input.scrollHeight}px` });
	};
	const close = () => {
		form.remove();
		shownText?.show();
		bubble.removeClass("is-editing");
	};
	const submit = async () => {
		if (sendBtn.disabled) return;
		sendBtn.disabled = true;
		try {
			await resend(input.value.trim());
		} finally {
			sendBtn.disabled = false;
		}
	};

	input.addEventListener("input", grow);
	input.addEventListener("keydown", (evt) => {
		if (evt.isComposing) return;
		if (evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			close();
		} else if (evt.key === "Enter" && !evt.shiftKey) {
			evt.preventDefault();
			void submit();
		}
	});
	cancelBtn.addEventListener("click", close);
	sendBtn.addEventListener("click", () => void submit());

	grow();
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
}

// The active path from root to leaf, in chronological order.
export function activePathOf(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
	if (!leafId) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = byId.get(leafId);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function isRenderedEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		const role = entry.message?.role;
		return role === "user" || role === "assistant" || role === "toolResult";
	}
	return entry.type === "branch_summary" && Boolean(entry.summary);
}

function contextEntriesOf(path: SessionEntry[]): SessionEntry[] {
	let compactionIdx = -1;
	for (let i = 0; i < path.length; i++) {
		if (path[i].type === "compaction") compactionIdx = i;
	}
	if (compactionIdx < 0) return path;
	const compaction = path[compactionIdx];
	const kept: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		if (path[i].id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept && !(path[i].type === "message" && path[i].message?.role === "system")) {
			kept.push(path[i]);
		}
	}
	kept.push(...path.slice(compactionIdx + 1));
	return kept;
}

// Open subtopic branches along the active path, from outermost to innermost.
// Finishing or discarding a branch moves leafId back to its anchor, which drops
// its branch-start entry from the active path and pops it from this stack.
export function activeBranchesOf(entries: SessionEntry[], leafId: string | null): ActiveBranch[] {
	const path = activePathOf(entries, leafId);
	if (!path.length) return [];
	const contextEntries = contextEntriesOf(path);
	const branches: ActiveBranch[] = [];
	for (let i = 0; i < path.length; i++) {
		const entry = path[i];
		if (entry.type !== "custom" || entry.customType !== BRANCH_START_TYPE) continue;
		const data = entry.data as { anchorId?: string } | undefined;
		const anchorId = data?.anchorId ?? entry.parentId;
		if (!anchorId) continue;
		const afterIds = new Set(path.slice(i + 1).map((e) => e.id));
		const messageCount = contextEntries.filter((e) => afterIds.has(e.id) && isRenderedEntry(e)).length;
		branches.push({ startId: entry.id, anchorId, messageCount });
	}
	return branches;
}

// Reconstructs the chronological messages of a finished subtopic branch from the session tree.
// `branch_summary` sits at the branch's anchor (`parentId`) and names the branch's final leaf (`fromId`).
export function branchTurnsOf(fromId: string, entries: SessionEntry[]): AgentMessage[] {
	if (!fromId) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const summaryEntry = entries.find((entry) => entry.type === "branch_summary" && entry.fromId === fromId);
	const stopId = summaryEntry?.parentId ?? null;
	const branchEntries: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = byId.get(fromId);
	while (current && current.id !== stopId && !seen.has(current.id)) {
		if (current.type === "custom" && current.customType === BRANCH_ANCHOR_TYPE) break;
		seen.add(current.id);
		branchEntries.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branchEntries.reverse();
	const messages: AgentMessage[] = [];
	for (const entry of branchEntries) {
		if (entry.type === "message" && entry.message) {
			const { role } = entry.message;
			if (role === "user" || role === "assistant" || role === "toolResult") messages.push(entry.message);
		} else if (entry.type === "branch_summary" && entry.summary && entry.fromId) {
			messages.push({ role: "branchSummary", summary: entry.summary, fromId: entry.fromId });
		}
	}
	return messages;
}

// The entry that holds a user message, looked up on the active branch (and within the innermost
// subtopic branch when one is open, so parent history stays frozen until the branch closes).
export function entryIdOf(message: UserMessage, entries: SessionEntry[], leafId: string | null): string | null {
	if (message.timestamp === undefined) return null;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let entry = leafId ? byId.get(leafId) : undefined;
	while (entry) {
		if (entry.type === "custom" && entry.customType === BRANCH_START_TYPE) return null;
		const held = entry.message;
		if (entry.type === "message" && held?.role === "user" && held.timestamp === message.timestamp) return entry.id;
		entry = entry.parentId ? byId.get(entry.parentId) : undefined;
	}
	return null;
}
