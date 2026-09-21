import { App, FuzzySuggestModal, Modal } from "obsidian";
import type { Model } from "../rpc/types";

export class ModelPicker extends FuzzySuggestModal<Model> {
	constructor(
		app: App,
		private models: Model[],
		private onPick: (model: Model) => void,
	) {
		super(app);
		this.setPlaceholder("Switch model…");
	}
	getItems(): Model[] {
		return this.models;
	}
	getItemText(model: Model): string {
		return `${model.provider}/${model.id}`;
	}
	onChooseItem(model: Model): void {
		this.onPick(model);
	}
}

class ChoicePicker<T> extends FuzzySuggestModal<T> {
	constructor(
		app: App,
		private items: T[],
		private label: (item: T) => string,
		private done: (item: T | null) => void,
	) {
		super(app);
	}
	getItems(): T[] {
		return this.items;
	}
	getItemText(item: T): string {
		return this.label(item);
	}
	onChooseItem(item: T): void {
		this.done(item);
	}
	onClose(): void {
		// Obsidian closes the modal before it reports the choice, so give the choice a tick to land.
		window.setTimeout(() => this.done(null));
	}
}

export function pickOne<T>(app: App, items: T[], label: (item: T) => string, placeholder: string): Promise<T | null> {
	return new Promise((resolve) => {
		let settled = false;
		const picker = new ChoicePicker(app, items, label, (item) => {
			if (settled) return;
			settled = true;
			resolve(item);
		});
		picker.setPlaceholder(placeholder);
		picker.open();
	});
}

// Small promise-based dialogs for the plugin's own questions.

export function promptText(app: App, title: string, initial: string, cta = "Save"): Promise<string | null> {
	return new Promise((resolve) => {
		let result: string | null = null;
		const modal = new Modal(app);
		modal.setTitle(title);
		const input = modal.contentEl.createEl("input", { type: "text", cls: "pi-dialog-input" });
		input.value = initial;
		const submit = () => {
			result = input.value;
			modal.close();
		};
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" && !evt.isComposing) {
				evt.preventDefault();
				submit();
			}
		});
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: cta, cls: "mod-cta" }).addEventListener("click", submit);
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		modal.onClose = () => resolve(result);
		modal.open();
		window.setTimeout(() => {
			input.focus();
			input.select();
		});
	});
}

export function confirmAction(app: App, title: string, message: string, cta: string): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new Modal(app);
		modal.setTitle(title);
		modal.contentEl.createEl("p", { text: message });
		const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: cta, cls: "mod-warning" }).addEventListener("click", () => {
			confirmed = true;
			modal.close();
		});
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
		modal.onClose = () => resolve(confirmed);
		modal.open();
	});
}
