import { MarkdownView, Notice, TFile, normalizePath, type App } from "obsidian";

const MAX_TITLE_CHARS = 60;

// The note the user is working in, and its editor if one is open. The chat panel is never
// a file view, so the active file stays the note even while the panel has focus.
function targetNote(app: App): { file: TFile; view: MarkdownView | null } | null {
	const file = app.workspace.getActiveFile();
	if (!file || file.extension !== "md") return null;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		if (leaf.view instanceof MarkdownView && leaf.view.file === file) return { file, view: leaf.view };
	}
	return { file, view: null };
}

// Replaces the selection, or inserts at the cursor when nothing is selected.
export function insertIntoNote(app: App, text: string): boolean {
	const target = targetNote(app);
	if (!target?.view) {
		new Notice("Open a note in an editor first.");
		return false;
	}
	target.view.editor.replaceSelection(text);
	new Notice(`Inserted into ${target.file.basename}.`);
	return true;
}

export async function appendToNote(app: App, text: string): Promise<boolean> {
	const target = targetNote(app);
	if (!target) {
		new Notice("Open a note first.");
		return false;
	}
	const current = await app.vault.read(target.file);
	const gap = current === "" ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
	await app.vault.append(target.file, `${gap}${text.replace(/\s+$/, "")}\n`);
	new Notice(`Appended to ${target.file.basename}.`);
	return true;
}

// A note named after the reply's heading or first line, next to the active note, opened beside it.
export async function createNoteFrom(app: App, text: string): Promise<TFile> {
	const { title, body } = splitTitle(text);
	return createNote(app, title, body);
}

// A new note where Obsidian puts new notes, with a number added when the name is taken, opened in a tab.
export async function createNote(app: App, title: string, body: string): Promise<TFile> {
	const name = fileNameOf(title) || "pi reply";
	const folder = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
	const base = folder.path === "/" ? "" : `${folder.path}/`;
	let path = normalizePath(`${base}${name}.md`);
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${base}${name} ${n}.md`);
	const file = await app.vault.create(path, body);
	await app.workspace.getLeaf("tab").openFile(file);
	return file;
}

export function splitTitle(text: string): { title: string; body: string } {
	const trimmed = text.trim();
	const heading = trimmed.match(/^#\s+(.+)\n?/);
	const source = heading ? heading[1] : trimmed.split("\n").find((line) => line.trim()) ?? "";
	const title = fileNameOf(source) || "pi reply";
	// A single top heading becomes the file name; anything else stays as written.
	const body = heading ? trimmed.slice(heading[0].length).replace(/^\n+/, "") : trimmed;
	return { title, body: body ? `${body}\n` : "" };
}

function fileNameOf(line: string): string {
	return line
		.replace(/[*_`~>#[\]:|^]/g, "")
		.replace(/[\\/]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.+$/, "")
		.slice(0, MAX_TITLE_CHARS)
		.trim();
}

export function markdownOf(blocks: { type: string; text?: string }[]): string {
	return blocks
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text!.trim())
		.filter(Boolean)
		.join("\n\n");
}
