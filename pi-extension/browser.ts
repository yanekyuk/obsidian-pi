// Tools that let pi drive Obsidian's built-in web viewer. Part of the Pi Harness plugin, which
// loads this file with `pi -e` when "Let pi use the web viewer" is switched on.
//
// pi runs as a child process and the web viewer lives inside Obsidian, so each tool call has to
// cross over. It travels on the one channel an extension and an RPC host already share: a
// dialog request. The plugin recognises the title below, does the work in the web viewer and
// answers with JSON; the user never sees a dialog. No port is opened and nothing else on the
// machine can reach it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHANNEL = "pi-harness:browser";

type Reply = { error?: string; url?: string; title?: string; text?: string; truncated?: boolean; links?: { text: string; href: string }[]; data?: string; mimeType?: string; value?: string };

async function ask(ctx: ExtensionContext, request: Record<string, unknown>): Promise<Reply> {
	if (!ctx.hasUI) throw new Error("The web viewer tools only work inside Obsidian's Pi Harness panel.");
	const answer = await ctx.ui.input(CHANNEL, JSON.stringify(request));
	if (answer === undefined) throw new Error("Obsidian did not answer. Is the Pi Harness panel still open?");
	const reply = JSON.parse(answer) as Reply;
	if (reply.error) throw new Error(reply.error);
	return reply;
}

const where = (reply: Reply) => `${reply.title || "(untitled)"}\n${reply.url ?? ""}`;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser_open",
		label: "Open page",
		description: "Open a URL in Obsidian's web viewer, in a tab the user can see, and wait for it to load. Later browser_* calls act on this page.",
		promptSnippet: "Open a web page in Obsidian's web viewer",
		promptGuidelines: [
			"Use browser_open and the other browser_* tools when the user wants to see a page inside Obsidian, or when a page needs a real browser (JavaScript, a login the user already has in the web viewer, clicking through). To just read a public page, web_fetch is cheaper.",
			"After browser_open, use browser_read to get the text; take a browser_screenshot only when the layout or an image matters.",
		],
		parameters: Type.Object({ url: Type.String({ description: "http(s) URL. A bare domain gets https://." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(`Opened: ${where(await ask(ctx, { action: "open", url: params.url }))}`);
		},
	});

	pi.registerTool({
		name: "browser_read",
		label: "Read page",
		description: "Read the visible text of the page in Obsidian's web viewer: the one browser_open loaded, or else the web viewer tab the user has open. Optionally only one element, and optionally the links on it.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector of the element to read. Default: the whole page." })),
			links: Type.Optional(Type.Boolean({ description: "Also list the links (text and address). Default false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = await ask(ctx, { action: "read", selector: params.selector, links: params.links });
			const links = reply.links?.length ? `\n\nLinks:\n${reply.links.map((l) => `- [${l.text}](${l.href})`).join("\n")}` : "";
			return text(`${where(reply)}\n\n${reply.text ?? ""}${reply.truncated ? "\n\n[Cut off here. Read a part of the page with `selector` for the rest.]" : ""}${links}`);
		},
	});

	pi.registerTool({
		name: "browser_click",
		label: "Click",
		description: "Click something on the page in Obsidian's web viewer: by CSS selector, or by the visible text of a link or button. Waits for any navigation it causes.",
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS selector of the element to click." })),
			text: Type.Optional(Type.String({ description: "Visible text of the link or button to click, when there is no good selector." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(`Clicked. Now on: ${where(await ask(ctx, { action: "click", selector: params.selector, text: params.text }))}`);
		},
	});

	pi.registerTool({
		name: "browser_type",
		label: "Type",
		description: "Type into a field on the page in Obsidian's web viewer, replacing what is there. With submit, presses Enter / submits the form afterwards and waits for the result.",
		parameters: Type.Object({
			selector: Type.String({ description: "CSS selector of the input, textarea or editable element." }),
			text: Type.String(),
			submit: Type.Optional(Type.Boolean({ description: "Submit after typing. Default false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(`Typed. Now on: ${where(await ask(ctx, { action: "type", selector: params.selector, text: params.text, submit: params.submit }))}`);
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "Screenshot",
		description: "Take a picture of what the web viewer in Obsidian is showing right now.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const reply = await ask(ctx, { action: "screenshot" });
			return { content: [{ type: "text" as const, text: where(reply) }, { type: "image" as const, data: reply.data ?? "", mimeType: reply.mimeType ?? "image/jpeg" }], details: {} };
		},
	});

	pi.registerTool({
		name: "browser_eval",
		label: "Run script",
		description: "Run JavaScript in the page in Obsidian's web viewer and get the value of the last expression back as JSON. For what the other browser_* tools can't do: scrolling, reading attributes, going back (history.back()).",
		parameters: Type.Object({ code: Type.String({ description: "JavaScript. Wrap statements in an IIFE that returns a JSON-serializable value." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text((await ask(ctx, { action: "eval", code: params.code })).value ?? "undefined");
		},
	});
}
