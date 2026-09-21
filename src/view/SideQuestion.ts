import { spawn, type ChildProcess } from "child_process";
import { existsSync, promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { setIcon } from "obsidian";
import { MarkdownBlock, type RenderHost } from "./blocks";
import { renderInline } from "./markdown";

// /btw, done by the panel. @juicesharp/rpiv-btw answers in a terminal overlay, which
// cannot exist under RPC (its command never even returns there), so the panel provides
// the same thing itself: a one-off pi run on a throwaway fork of the session, with no
// tools, whose answer never enters the main conversation.

const SYSTEM_PROMPT = `You are answering a quick side question while the user's main session carries on.

The conversation you are given is the user's main session; treat it as background. Do not continue the assistant's earlier work or pick up a tool call where it left off: the side question stands on its own.

Answer directly and briefly, in short paragraphs or compact bullets. When the context supports a claim, point to the note, file or passage. If the context is not enough to answer, say so instead of guessing.

You have no tools and must not try to call any, even though earlier turns show tool use. Reply in plain Markdown.`;

const MAX_PRIOR_TURNS = 4;

export interface SideQuestionHost {
	piCommand(): Promise<{ binary: string; env: NodeJS.ProcessEnv; cwd: string }>;
	sessionFile(): string | null;
	model(): { provider: string; id: string } | null;
	thinkingLevel(): string | null;
}

export class SideQuestions {
	private el: HTMLElement;
	private proc: ChildProcess | null = null;
	private turns: { question: string; answer: string }[] = [];
	private runId = 0;

	constructor(
		parent: HTMLElement,
		private render: RenderHost,
		private host: SideQuestionHost,
	) {
		this.el = parent.createDiv({ cls: "pi-side" });
	}

	// A new main session makes earlier side questions irrelevant.
	reset(): void {
		this.dismiss();
		this.turns = [];
	}

	dismiss(): void {
		this.runId++;
		this.proc?.kill();
		this.proc = null;
		this.el.empty();
	}

	async ask(question: string): Promise<void> {
		this.dismiss();
		const id = this.runId;

		const card = this.el.createDiv({ cls: "pi-side-card" });
		const head = card.createDiv({ cls: "pi-dialog-head" });
		setIcon(head.createSpan({ cls: "pi-icon" }), "git-branch");
		head.createSpan({ cls: "pi-dialog-header", text: "Side question" });
		head.createSpan({ cls: "pi-side-note", text: "not added to the conversation" });
		const close = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Dismiss" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.dismiss());
		renderInline(this.render, card.createDiv({ cls: "pi-side-question" }), question);
		const answerEl = card.createDiv({ cls: "pi-side-answer markdown-rendered" });
		const status = answerEl.createDiv({ cls: "pi-side-status", text: "Thinking…" });
		const answer = new MarkdownBlock(this.render, answerEl);
		this.render.onContentChanged();

		const workDir = await fs.mkdtemp(join(tmpdir(), "pi-harness-btw-"));
		const cleanup = () => void fs.rm(workDir, { recursive: true, force: true });
		if (id !== this.runId) return cleanup();

		const { binary, env, cwd } = await this.host.piCommand();
		const args = ["-p", "--mode", "json", "--no-tools", "--no-skills", "--no-context-files", "--no-prompt-templates", "--system-prompt", SYSTEM_PROMPT];
		// Forking into a temp dir gives the run the whole conversation and leaves the real session file alone.
		// A session with no messages yet has no file; then there is no context to bring either.
		const session = this.host.sessionFile();
		if (session && existsSync(session)) args.push("--fork", session, "--session-dir", workDir);
		else args.push("--no-session");
		const model = this.host.model();
		if (model) args.push("--model", `${model.provider}/${model.id}`);
		const thinking = this.host.thinkingLevel();
		if (thinking) args.push("--thinking", thinking);
		args.push("--", this.promptFor(question));

		const proc = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		this.proc = proc;
		let text = "";
		let failure = "";
		let stderr = "";
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const onLine = (line: string) => {
			let event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; message?: { role?: string; stopReason?: string; errorMessage?: string } };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (id !== this.runId) return;
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				status.remove();
				text += event.assistantMessageEvent.delta ?? "";
				answer.append(event.assistantMessageEvent.delta ?? "");
			} else if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
				failure = event.message.errorMessage ?? "The model returned an error.";
			}
		};
		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				onLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-2000)));
		proc.on("error", (err) => (failure = err.message));
		proc.on("close", () => {
			cleanup();
			if (id !== this.runId) return;
			this.proc = null;
			status.remove();
			if (text.trim()) {
				this.turns.push({ question, answer: text.trim() });
				this.turns = this.turns.slice(-MAX_PRIOR_TURNS);
			} else {
				answerEl.createDiv({ cls: "pi-msg-notice is-error", text: failure || stderr.trim().split("\n").slice(-4).join("\n") || "pi gave no answer." });
			}
			this.render.onContentChanged();
		});
	}

	// Earlier side questions ride along so a follow-up ("and the second one?") makes sense.
	private promptFor(question: string): string {
		if (!this.turns.length) return question;
		const earlier = this.turns.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n\n");
		return `Earlier side questions in this chat, for continuity:\n\n${earlier}\n\nSide question: ${question}`;
	}
}
