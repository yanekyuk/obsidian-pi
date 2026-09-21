import { setIcon } from "obsidian";
import type { RenderHost } from "./blocks";
import { renderInline } from "./markdown";

// The task shape @juicesharp/rpiv-todo puts in every tool result (details.tasks): a full
// snapshot after each change, which is also how the extension itself restores its state.
export interface TodoTask {
	id: number;
	subject: string;
	activeForm?: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	blockedBy?: number[];
}

export function tasksFrom(details: unknown): TodoTask[] | null {
	const tasks = (details as { tasks?: unknown } | null | undefined)?.tasks;
	if (!Array.isArray(tasks)) return null;
	return tasks.filter((t): t is TodoTask => typeof t?.id === "number" && typeof t?.subject === "string" && typeof t?.status === "string");
}

const STATUS_ICON: Record<TodoTask["status"], string> = {
	pending: "circle",
	in_progress: "loader",
	completed: "check-circle-2",
	deleted: "circle-slash",
};

// Identifies a task for "clear". Ids alone won't do: the tool's own `clear` action restarts them at 1.
const keyOf = (task: TodoTask) => `${task.id}:${task.subject}`;

// The agent's task list, pinned above the composer so progress stays visible while
// the individual todo calls scroll away in the transcript.
export class TodoPanel {
	private el: HTMLDetailsElement;
	private collapsedByUser = false;
	private wasAllDone = false;
	private snapshot: TodoTask[] | null = null;
	private hidden = new Set<string>();
	// Progress in one line ("2/5 · Renaming notes") while there is work left, for the tab switcher.
	summary: string | null = null;

	// `onClear` receives every hidden key, to be stored with the session.
	constructor(
		parent: HTMLElement,
		private host: RenderHost,
		private onClear: (hidden: string[]) => void,
	) {
		this.el = parent.createEl("details", { cls: "pi-todos" });
		this.el.hide();
		// Clicks only, not the "toggle" event: that also fires when this class folds the panel itself.
		// The click arrives before the state flips, so "open now" means the user is collapsing it.
		this.el.addEventListener("click", (evt) => {
			if ((evt.target as HTMLElement).closest("summary")) this.collapsedByUser = this.el.open;
		});
	}

	// What the user cleared earlier in this session; call before `set` when the session changes.
	setHidden(keys: string[]): void {
		this.hidden = new Set(keys);
	}

	// Clearing is a view filter. The list itself belongs to the rpiv-todo extension, which
	// only the model can change, so the model still sees these tasks; the user no longer has to.
	private clearFinished(): void {
		for (const task of this.snapshot ?? []) if (task.status === "completed" || task.status === "deleted") this.hidden.add(keyOf(task));
		this.onClear([...this.hidden]);
		this.set(this.snapshot);
	}

	set(snapshot: TodoTask[] | null): void {
		this.snapshot = snapshot;
		const tasks = (snapshot ?? []).filter((t) => t.status !== "deleted" && !(t.status === "completed" && this.hidden.has(keyOf(t))));
		this.el.empty();
		this.el.toggle(tasks.length > 0);
		this.summary = null;
		if (!tasks.length) {
			this.collapsedByUser = false;
			this.wasAllDone = false;
			return;
		}

		const done = tasks.filter((t) => t.status === "completed").length;
		const active = tasks.find((t) => t.status === "in_progress");
		const allDone = done === tasks.length;
		if (!allDone) this.summary = [`${done}/${tasks.length}`, active?.activeForm ?? active?.subject].filter(Boolean).join(" · ");

		const summary = this.el.createEl("summary");
		setIcon(summary.createSpan({ cls: "pi-icon" }), "list-checks");
		summary.createSpan({ cls: "pi-todos-title", text: "Tasks" });
		summary.createSpan({ cls: "pi-todos-count", text: `${done}/${tasks.length}` });
		renderInline(this.host, summary.createSpan({ cls: "pi-todos-active" }), allDone ? "All done" : (active?.activeForm ?? active?.subject ?? ""));
		if (done > 0) {
			const clear = summary.createEl("button", { cls: "pi-todos-clear clickable-icon", attr: { "aria-label": "Clear completed tasks" } });
			setIcon(clear, "list-x");
			clear.addEventListener("click", (evt) => {
				// Inside <summary>: without this the click would also fold the panel.
				evt.preventDefault();
				evt.stopPropagation();
				this.clearFinished();
			});
		}
		const bar = summary.createDiv({ cls: "pi-todos-bar" });
		bar.createDiv({ cls: "pi-todos-bar-fill" }).setCssStyles({ width: `${(done / tasks.length) * 100}%` });

		const list = this.el.createDiv({ cls: "pi-todos-list" });
		for (const task of tasks) {
			const row = list.createDiv({ cls: "pi-todo", attr: { "data-status": task.status } });
			setIcon(row.createSpan({ cls: "pi-todo-icon" }), STATUS_ICON[task.status]);
			renderInline(this.host, row.createSpan({ cls: "pi-todo-text" }), task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject);
			const waiting = (task.blockedBy ?? []).filter((id) => tasks.some((t) => t.id === id && t.status !== "completed"));
			if (task.status === "pending" && waiting.length) row.createSpan({ cls: "pi-todo-blocked", text: `after ${waiting.map((id) => `#${id}`).join(", ")}` });
		}

		// Fold away once everything is done, but never fight a choice the user made.
		if (allDone && !this.wasAllDone) this.el.open = false;
		else if (!this.collapsedByUser && !allDone) this.el.open = true;
		this.wasAllDone = allDone;
	}
}
