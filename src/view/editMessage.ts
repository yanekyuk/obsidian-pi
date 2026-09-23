import type { SessionEntry, UserMessage } from "../rpc/types";

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

// The entry that holds a user message, looked up on the branch the session is on. Messages
// carry no entry id over RPC, but the entry keeps the message as it was sent, timestamp and all.
export function entryIdOf(message: UserMessage, entries: SessionEntry[], leafId: string | null): string | null {
	if (message.timestamp === undefined) return null;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let entry = leafId ? byId.get(leafId) : undefined;
	while (entry) {
		const held = entry.message;
		if (entry.type === "message" && held?.role === "user" && held.timestamp === message.timestamp) return entry.id;
		entry = entry.parentId ? byId.get(entry.parentId) : undefined;
	}
	return null;
}
