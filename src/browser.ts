import type { App, WorkspaceLeaf } from "obsidian";

// The Obsidian end of pi's browser_* tools (pi-extension/browser.ts): it drives the web viewer,
// Obsidian's core plugin for opening pages inside the app. Requests arrive as a dialog request
// with this title and leave as its answer, so they never touch the network.
export const BROWSER_CHANNEL = "pi-harness:browser";

const WEB_VIEWER = "webviewer";
const LOAD_TIMEOUT_MS = 20_000;
const SETTLE_MS = 600;
const MAX_TEXT_CHARS = 40_000;
const MAX_LINKS = 150;
const SCREENSHOT_MAX_WIDTH = 1280;

// The parts of Electron's <webview> tag used here. Obsidian is an Electron app; the tag has no types in its API.
interface NativeImage {
	getSize(): { width: number; height: number };
	resize(options: { width: number }): NativeImage;
	toJPEG(quality: number): Uint8Array;
}
interface Webview extends HTMLElement {
	getURL(): string;
	getTitle(): string;
	isLoading(): boolean;
	executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
	capturePage(): Promise<NativeImage>;
}

interface BrowserRequest {
	action?: string;
	url?: string;
	selector?: string;
	text?: string;
	links?: boolean;
	submit?: boolean;
	code?: string;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// Runs in the page. Arguments travel as JSON inside the source, never by string concatenation.
export const inPage = (fn: (...args: never[]) => unknown, ...args: unknown[]) => `(${fn.toString()})(...${JSON.stringify(args)})`;

export function readPage(selector: string | null, wantLinks: boolean, maxChars: number, maxLinks: number) {
	const root = selector ? document.querySelector<HTMLElement>(selector) : document.body;
	if (!root) return { error: `Nothing on the page matches ${selector}.` };
	const text = root.innerText ?? "";
	const links = wantLinks
		? Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
				.map((a) => ({ text: (a.innerText || a.title || "").trim().replace(/\s+/g, " ").slice(0, 100), href: a.href }))
				.filter((l) => l.text && /^https?:/.test(l.href))
				.slice(0, maxLinks)
		: undefined;
	return { text: text.slice(0, maxChars), truncated: text.length > maxChars, links };
}

export function clickOnPage(selector: string | null, text: string | null) {
	const visible = (el: HTMLElement) => el.offsetParent !== null || getComputedStyle(el).position === "fixed";
	let target: HTMLElement | null = null;
	if (selector) target = document.querySelector<HTMLElement>(selector);
	else if (text) {
		// Labels often wrap or carry stray spacing; only the words matter.
		const words = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
		const wanted = words(text);
		const label = (el: HTMLElement) => words(el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "");
		const candidates = Array.from(document.querySelectorAll<HTMLElement>("a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], summary, label")).filter(visible);
		target = candidates.find((el) => label(el) === wanted) ?? candidates.find((el) => label(el).includes(wanted)) ?? null;
	}
	if (!target) return { error: `Nothing to click matches ${selector ?? JSON.stringify(text)}.` };
	target.scrollIntoView({ block: "center" });
	target.click();
	return {};
}

export function typeOnPage(selector: string, text: string, submit: boolean) {
	const el = document.querySelector<HTMLElement>(selector);
	if (!el) return { error: `Nothing on the page matches ${selector}.` };
	el.scrollIntoView({ block: "center" });
	el.focus();
	if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
		// Through the native setter, so frameworks that track the value (React) notice the change.
		const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
	} else if (el.isContentEditable) el.textContent = text;
	else return { error: `${selector} is not something one can type into.` };
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	if (submit) {
		const form = el.closest("form");
		if (form) form.requestSubmit();
		else for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
	}
	return {};
}

export class BrowserControl {
	// The tab pi opened. Without one, pi works with whatever web viewer tab the user has.
	private leaf: WorkspaceLeaf | null = null;

	constructor(private app: App) {}

	// Always answers, with `{ error }` when something went wrong: pi is blocked on the reply.
	async handle(payload: string | undefined): Promise<string> {
		try {
			const request = JSON.parse(payload ?? "{}") as BrowserRequest;
			return JSON.stringify(await this.run(request));
		} catch (err) {
			return JSON.stringify({ error: (err as Error).message || String(err) });
		}
	}

	private async run(request: BrowserRequest): Promise<Record<string, unknown>> {
		if (!this.webViewerEnabled()) throw new Error("Obsidian's web viewer is switched off. The user can turn it on under Settings → Core plugins → Web viewer.");
		if (request.action === "open") return this.open(request.url ?? "");
		const webview = await this.webview();
		const page = () => ({ url: webview.getURL(), title: webview.getTitle() });
		const evaluate = async (code: string) => {
			const result = (await webview.executeJavaScript(code, true)) as { error?: string } | null;
			if (result?.error) throw new Error(result.error);
			return result ?? {};
		};
		switch (request.action) {
			case "read":
				return { ...page(), ...(await evaluate(inPage(readPage as never, request.selector ?? null, Boolean(request.links), MAX_TEXT_CHARS, MAX_LINKS))) };
			case "click":
				if (!request.selector && !request.text) throw new Error("Give a selector or the visible text of what to click.");
				await evaluate(inPage(clickOnPage as never, request.selector ?? null, request.text ?? null));
				await this.settle(webview);
				return page();
			case "type":
				await evaluate(inPage(typeOnPage as never, request.selector ?? "", request.text ?? "", Boolean(request.submit)));
				if (request.submit) await this.settle(webview);
				return page();
			case "screenshot": {
				// A tab in the background has nothing painted to capture.
				await this.show();
				await sleep(150);
				let image = await webview.capturePage();
				if (image.getSize().width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH });
				return { ...page(), data: Buffer.from(image.toJPEG(80)).toString("base64"), mimeType: "image/jpeg" };
			}
			case "eval": {
				const value = await webview.executeJavaScript(request.code ?? "", true);
				const json = JSON.stringify(value, null, 2) ?? "undefined";
				return { value: json.length > MAX_TEXT_CHARS ? `${json.slice(0, MAX_TEXT_CHARS)}\n… cut off` : json };
			}
			default:
				throw new Error(`Unknown browser action: ${String(request.action)}`);
		}
	}

	private webViewerEnabled(): boolean {
		// Not in the public API, hence the guard. When it can't be told, opening the view will tell.
		const internal = (this.app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
		return internal?.getEnabledPluginById ? Boolean(internal.getEnabledPluginById(WEB_VIEWER)) : true;
	}

	private async open(rawUrl: string): Promise<Record<string, unknown>> {
		const url = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
		if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https addresses can be opened.");
		const { workspace } = this.app;
		if (!this.leaf || !workspace.getLeavesOfType(WEB_VIEWER).includes(this.leaf)) this.leaf = workspace.getLeaf("tab");
		await this.leaf.setViewState({ type: WEB_VIEWER, state: { url, navigate: true }, active: false });
		await this.show();
		const webview = await this.webview();
		await this.settle(webview);
		return { url: webview.getURL(), title: webview.getTitle() };
	}

	// Brings the tab to the front of its pane without taking the keyboard away from the chat.
	private async show(): Promise<void> {
		if (!this.leaf) return;
		const parent = this.leaf.parent as unknown as { selectTab?(leaf: WorkspaceLeaf): void } | null;
		if (parent?.selectTab) parent.selectTab(this.leaf);
		else await this.app.workspace.revealLeaf(this.leaf);
		await (this.leaf as WorkspaceLeaf & { loadIfDeferred?(): Promise<void> }).loadIfDeferred?.();
	}

	private async webview(): Promise<Webview> {
		const leaves = this.app.workspace.getLeavesOfType(WEB_VIEWER);
		if (!this.leaf || !leaves.includes(this.leaf)) this.leaf = leaves[0] ?? null;
		if (!this.leaf) throw new Error("No page is open in Obsidian's web viewer. Open one with browser_open.");
		await (this.leaf as WorkspaceLeaf & { loadIfDeferred?(): Promise<void> }).loadIfDeferred?.();
		// The view creates its <webview> shortly after it opens.
		for (let waited = 0; waited < 5000; waited += 100) {
			const webview = this.leaf.view.containerEl.querySelector<Webview>("webview");
			if (webview) return webview;
			await sleep(100);
		}
		throw new Error("Obsidian's web viewer did not come up.");
	}

	// Waits until the page has stopped loading, and a moment longer for scripts to fill it in.
	private async settle(webview: Webview): Promise<void> {
		await sleep(SETTLE_MS);
		for (let waited = 0; waited < LOAD_TIMEOUT_MS; waited += 200) {
			try {
				if (!webview.isLoading() && webview.getURL() !== "about:blank") break;
			} catch {
				// Not attached yet: Electron throws until the webview's dom-ready.
			}
			await sleep(200);
		}
		await sleep(SETTLE_MS);
	}
}
