import { Component, MarkdownRenderer, Modal, Notice, setIcon, type App } from "obsidian";
import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SubagentInfo {
	toolCallId: string;
	label: string;
	typeName: string;
	model: string;
	prompt: string;
	startedAt: number;
	conversationId?: string;
	resultText?: string;
}

interface TranscriptToolCall {
	name?: string;
	args?: Record<string, unknown>;
}

interface TranscriptStep {
	step_index?: number;
	source?: string;
	type?: string;
	status?: string;
	created_at?: string;
	content?: string;
	thinking?: string;
	tool_calls?: TranscriptToolCall[];
	model?: string;
}

const POLL_INTERVAL_MS = 800;
const MAX_TOOL_OUTPUT_CHARS = 4000;
const BRAIN_DIR = join(homedir(), ".gemini", "antigravity-cli", "brain");

function transcriptPathFor(conversationId: string): string {
	return join(BRAIN_DIR, conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function summarizeArgs(args?: Record<string, unknown>): string {
	if (!args || typeof args !== "object") return "";
	const preferredKeys = ["Path", "path", "CommandLine", "command", "Query", "query", "Pattern", "pattern", "Description", "Role"];
	for (const key of preferredKeys) {
		const val = args[key];
		if (typeof val === "string" && val.trim()) {
			const clean = val.replace(/\s+/g, " ").trim();
			return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
		}
	}
	for (const val of Object.values(args)) {
		if (typeof val === "string" && val.trim()) {
			const clean = val.replace(/\s+/g, " ").trim();
			return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
		}
	}
	return "";
}

function parseTranscript(raw: string): TranscriptStep[] {
	const steps: TranscriptStep[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			steps.push(JSON.parse(trimmed) as TranscriptStep);
		} catch {
			// Ignore incomplete trailing line while the subagent is writing.
		}
	}
	return steps;
}

export class SubagentModal extends Modal {
	private component = new Component();
	private statusBadgeEl!: HTMLElement;
	private idBadgeEl!: HTMLElement;
	private feedEl!: HTMLElement;
	private pollTimer: number | null = null;
	private lastKey = "";
	private refreshing = false;

	constructor(
		app: App,
		private subagent: SubagentInfo,
		private isStillActive: () => boolean,
	) {
		super(app);
	}

	onOpen(): void {
		this.component.load();
		this.modalEl.addClass("pi-subagent-modal");
		this.setTitle(this.subagent.label);

		const { contentEl } = this;
		contentEl.empty();

		const metaBar = contentEl.createDiv({ cls: "pi-subagent-modal-meta" });
		this.statusBadgeEl = metaBar.createSpan({ cls: "pi-subagent-badge" });
		if (this.subagent.typeName) {
			metaBar.createSpan({ cls: "pi-subagent-badge is-muted", text: this.subagent.typeName });
		}
		if (this.subagent.model && this.subagent.model !== "inherit") {
			metaBar.createSpan({ cls: "pi-subagent-badge is-muted", text: this.subagent.model });
		}
		this.idBadgeEl = metaBar.createEl("button", {
			cls: "pi-subagent-badge is-id clickable-icon",
			attr: { type: "button", "aria-label": "Copy conversation ID" },
		});
		this.idBadgeEl.hide();
		this.idBadgeEl.addEventListener("click", () => {
			if (!this.subagent.conversationId) return;
			void navigator.clipboard.writeText(this.subagent.conversationId);
			new Notice("Copied subagent conversation ID");
		});

		const refreshBtn = metaBar.createEl("button", {
			cls: "pi-subagent-refresh clickable-icon",
			attr: { type: "button", "aria-label": "Refresh transcript" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => {
			this.lastKey = "";
			void this.refresh();
		});

		if (this.subagent.prompt) {
			const promptDetails = contentEl.createEl("details", { cls: "pi-subagent-modal-prompt" });
			promptDetails.createEl("summary", { text: "Task prompt" });
			promptDetails.createDiv({ cls: "pi-subagent-prompt-body", text: this.subagent.prompt });
		}

		this.feedEl = contentEl.createDiv({ cls: "pi-subagent-modal-feed" });

		this.updateBadges();
		void this.refresh();
		this.pollTimer = window.setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
	}

	onClose(): void {
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.component.unload();
		this.contentEl.empty();
	}

	private updateBadges(): void {
		const active = this.isStillActive();
		this.statusBadgeEl.setText(active ? "Running" : "Finished");
		this.statusBadgeEl.toggleClass("is-running", active);
		this.statusBadgeEl.toggleClass("is-done", !active);

		if (this.subagent.conversationId) {
			this.idBadgeEl.setText(this.subagent.conversationId.slice(0, 8));
			this.idBadgeEl.setAttribute("title", this.subagent.conversationId);
			this.idBadgeEl.show();
		}
	}

	private async resolveTranscriptPath(): Promise<string | null> {
		if (this.subagent.conversationId) {
			const p = transcriptPathFor(this.subagent.conversationId);
			try {
				await fs.access(p);
				return p;
			} catch {
				return null;
			}
		}

		// Fallback: scan recently modified Antigravity brain transcripts and match the initial prompt.
		if (!this.subagent.prompt) return null;
		let entries: string[];
		try {
			entries = await fs.readdir(BRAIN_DIR);
		} catch {
			return null;
		}

		const cutoff = this.subagent.startedAt - 10_000;
		const needle = this.subagent.prompt.slice(0, 160).trim();
		const candidates: { id: string; path: string; mtimeMs: number }[] = [];

		for (const id of entries) {
			const p = transcriptPathFor(id);
			try {
				const stat = await fs.stat(p);
				if (stat.mtimeMs >= cutoff) {
					candidates.push({ id, path: p, mtimeMs: stat.mtimeMs });
				}
			} catch {
				// No transcript yet or not a conversation directory.
			}
		}

		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const candidate of candidates.slice(0, 12)) {
			try {
				const raw = await fs.readFile(candidate.path, "utf8");
				const firstLine = raw.split("\n", 1)[0];
				if (!firstLine) continue;
				const step = JSON.parse(firstLine) as TranscriptStep;
				if (step.type === "USER_INPUT" && typeof step.content === "string" && step.content.includes(needle)) {
					this.subagent.conversationId = candidate.id;
					this.updateBadges();
					return candidate.path;
				}
			} catch {
				// Ignore unreadable/partial files.
			}
		}
		return null;
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			this.updateBadges();
			const path = await this.resolveTranscriptPath();
			if (!path) {
				if (this.lastKey !== "empty") {
					this.lastKey = "empty";
					this.renderEmptyState();
				}
				return;
			}

			const raw = await fs.readFile(path, "utf8");
			const key = `${path}:${raw.length}:${this.isStillActive()}`;
			if (key === this.lastKey) return;
			this.lastKey = key;

			const steps = parseTranscript(raw);
			this.renderSteps(steps);
		} catch {
			// Ignore transient read errors while file is being updated.
		} finally {
			this.refreshing = false;
		}
	}

	private renderEmptyState(): void {
		this.feedEl.empty();
		if (this.subagent.resultText?.trim()) {
			const block = this.feedEl.createDiv({ cls: "pi-subagent-step markdown-rendered" });
			void MarkdownRenderer.render(this.app, this.subagent.resultText, block, "", this.component);
			return;
		}
		this.feedEl.createDiv({
			cls: "pi-subagent-empty",
			text: this.isStillActive()
				? "Waiting for subagent transcript…"
				: "No local transcript file was found for this subagent.",
		});
	}

	private renderSteps(steps: TranscriptStep[]): void {
		const nearBottom =
			this.feedEl.scrollHeight - this.feedEl.scrollTop - this.feedEl.clientHeight < 64;
		this.feedEl.empty();

		const visible = steps.filter((s, idx) => !(idx === 0 && s.type === "USER_INPUT"));
		if (visible.length === 0) {
			this.feedEl.createDiv({ cls: "pi-subagent-empty", text: "Subagent started — waiting for first step…" });
			return;
		}

		for (const step of visible) {
			if (step.type === "PLANNER_RESPONSE") {
				const card = this.feedEl.createDiv({ cls: "pi-subagent-step is-model" });
				if (step.thinking?.trim()) {
					const details = card.createEl("details", { cls: "pi-subagent-thinking" });
					details.createEl("summary", { text: "Thinking" });
					details.createDiv({ cls: "pi-subagent-thinking-body", text: step.thinking.trim() });
				}
				if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
					const callsEl = card.createDiv({ cls: "pi-subagent-tool-calls" });
					for (const call of step.tool_calls) {
						const row = callsEl.createDiv({ cls: "pi-subagent-tool-call" });
						setIcon(row.createSpan({ cls: "pi-icon" }), "wrench");
						row.createSpan({ cls: "pi-subagent-tool-name", text: call.name ?? "tool" });
						const summary = summarizeArgs(call.args);
						if (summary) row.createSpan({ cls: "pi-subagent-tool-args", text: summary });
					}
				}
				if (step.content?.trim()) {
					const body = card.createDiv({ cls: "pi-subagent-step-body markdown-rendered" });
					void MarkdownRenderer.render(this.app, step.content.trim(), body, "", this.component);
				}
			} else if (step.type === "GENERIC" && step.content?.trim()) {
				const details = this.feedEl.createEl("details", { cls: "pi-subagent-tool-result" });
				const len = step.content.length;
				details.createEl("summary", { text: `Tool output (${len.toLocaleString()} chars)` });
				const text =
					len > MAX_TOOL_OUTPUT_CHARS
						? `${step.content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated)`
						: step.content;
				details.createEl("pre", { text });
			} else if (step.type === "USER_INPUT" && step.content?.trim()) {
				const card = this.feedEl.createDiv({ cls: "pi-subagent-step is-user" });
				card.createDiv({ cls: "pi-subagent-step-label", text: "Message" });
				card.createDiv({ cls: "pi-subagent-step-body", text: step.content.trim() });
			}
		}

		if (nearBottom) {
			this.feedEl.scrollTop = this.feedEl.scrollHeight;
		}
	}
}
