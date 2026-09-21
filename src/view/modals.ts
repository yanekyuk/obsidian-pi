import { App, FuzzySuggestModal, Modal, Notice, type FuzzyMatch } from "obsidian";
import type { ScopedModels } from "../models";
import type { Model } from "../rpc/types";

type ModelChoice = { model: Model; unavailable?: undefined } | { model?: undefined; unavailable: string };

// pi's model selector: the scoped models first (the short list from enabledModels), all models a
// click or Tab away. Scoped entries pi can't use right now are listed too, so a missing provider
// shows up as what it is rather than as a model that silently isn't there.
export class ModelPicker extends FuzzySuggestModal<ModelChoice> {
	private showAll: boolean;
	private buttons: HTMLElement[] = [];

	constructor(
		app: App,
		private all: Model[],
		private scoped: ScopedModels,
		private current: Model | null,
		startWithAll: boolean,
		private onPick: (model: Model) => void,
		private onViewChange: (showAll: boolean) => void,
	) {
		super(app);
		this.showAll = startWithAll || !this.hasScope;
		this.setPlaceholder("Switch model…");
		if (!this.hasScope) return;
		const bar = createDiv({ cls: "pi-model-scope" });
		this.modalEl.prepend(bar);
		const views: [string, boolean][] = [[`Scoped (${scoped.models.length})`, false], [`All (${all.length})`, true]];
		this.buttons = views.map(([label, all]) => {
			const button = bar.createEl("button", { text: label, cls: "pi-pill clickable-icon" });
			button.addEventListener("click", () => this.setView(all));
			return button;
		});
		this.setInstructions([{ command: "tab", purpose: "scoped / all" }]);
		this.scope.register([], "Tab", (evt) => {
			evt.preventDefault();
			this.setView(!this.showAll);
		});
		this.setView(this.showAll);
	}

	private get hasScope(): boolean {
		return this.scoped.models.length + this.scoped.unavailable.length > 0;
	}

	private setView(showAll: boolean): void {
		if (showAll !== this.showAll) this.onViewChange(showAll);
		this.showAll = showAll;
		this.buttons.forEach((button, i) => button.toggleClass("is-active", (i === 1) === showAll));
		// Runs the query again against the other list.
		this.inputEl.dispatchEvent(new Event("input"));
		this.inputEl.focus();
	}

	getItems(): ModelChoice[] {
		if (this.showAll) return this.all.map((model) => ({ model }));
		return [...this.scoped.models.map((model) => ({ model })), ...this.scoped.unavailable.map((unavailable) => ({ unavailable }))];
	}

	getItemText(choice: ModelChoice): string {
		return choice.model ? `${choice.model.provider}/${choice.model.id}` : choice.unavailable;
	}

	renderSuggestion(match: FuzzyMatch<ModelChoice>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		const { model, unavailable } = match.item;
		if (model && this.current && model.provider === this.current.provider && model.id === this.current.id) el.createSpan({ cls: "pi-model-note", text: "current" });
		if (unavailable) {
			el.addClass("pi-model-unavailable");
			el.createSpan({ cls: "pi-model-note", text: "not available" });
		}
	}

	onChooseItem(choice: ModelChoice): void {
		if (choice.model) return this.onPick(choice.model);
		new Notice(`pi has no model for "${choice.unavailable}" right now. Its provider may come from a package that isn't installed for the panel's pi (Settings → Extensions → Packages), or you aren't logged in to it.`, 10000);
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
