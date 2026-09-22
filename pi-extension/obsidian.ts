// Tools that give pi what only the running Obsidian app knows: the link graph and metadata
// cache, safe property edits, the command palette. Part of the Pi Harness plugin, which loads
// this file with `pi -e` when "Let pi use Obsidian" is switched on.
//
// Like browser.ts, each call crosses from the pi process to Obsidian on the one channel an
// extension and an RPC host already share: a dialog request with the title below, which the
// plugin answers with JSON instead of showing. Nothing listens on the network.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHANNEL = "pi-harness:obsidian";

interface Reply {
	error?: string;
	path?: string;
	frontmatter?: Record<string, unknown>;
	aliases?: string[];
	tags?: string[];
	headings?: { level: number; heading: string }[];
	links?: string[];
	unresolved?: string[];
	backlinks?: { path: string; count: number }[];
	counts?: { tag: string; count: number }[];
	notes?: string[];
	commands?: { id: string; name: string }[];
	total?: number;
	ran?: string;
	opened?: string;
	note?: string;
}

async function ask(ctx: ExtensionContext, request: Record<string, unknown>): Promise<Reply> {
	if (!ctx.hasUI) throw new Error("The obsidian_* tools only work inside Obsidian's Pi Harness panel.");
	const answer = await ctx.ui.input(CHANNEL, JSON.stringify(request));
	if (answer === undefined) throw new Error("Obsidian did not answer. Is the Pi Harness panel still open?");
	const reply = JSON.parse(answer) as Reply;
	if (reply.error) throw new Error(reply.error);
	return reply;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((item) => `- ${item}`).join("\n")}` : `${title}: none`);
const pathParam = (what: string) => Type.Optional(Type.String({ description: `Vault path of the ${what}, such as "Folder/Note.md"; a note name works too. Default: the note the user has open.` }));

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "obsidian_note_info",
		label: "Note info",
		description: "What Obsidian knows about a note beyond its text: properties (frontmatter), aliases, tags, headings, the notes it links to, links that point nowhere, and the notes that link to it (backlinks). Instant, from Obsidian's metadata cache.",
		promptSnippet: "Backlinks, tags, properties and headings of a note",
		promptGuidelines: [
			"Use obsidian_note_info instead of grep to find what links to a note or which tags and properties it has.",
			"Use obsidian_set_properties to change a note's properties; don't edit the YAML block by hand.",
		],
		parameters: Type.Object({ path: pathParam("note") }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = await ask(ctx, { action: "note_info", path: params.path });
			const properties = r.frontmatter && Object.keys(r.frontmatter).length ? `Properties:\n${JSON.stringify(r.frontmatter, null, 2)}` : "Properties: none";
			return text(
				[
					`Note: ${r.path}`,
					properties,
					list("Aliases", r.aliases ?? []),
					list("Tags", r.tags ?? []),
					list("Headings", (r.headings ?? []).map((h) => `${"#".repeat(h.level)} ${h.heading}`)),
					list("Links to", r.links ?? []),
					list("Unresolved links", r.unresolved ?? []),
					list("Linked from", (r.backlinks ?? []).map((b) => (b.count > 1 ? `${b.path} (${b.count})` : b.path))),
				].join("\n\n"),
			);
		},
	});

	pi.registerTool({
		name: "obsidian_tags",
		label: "Tags",
		description: "The vault's tags with how many notes use each, or the notes that carry one tag. Nested tags count for their parents too (#a/b is also #a).",
		parameters: Type.Object({
			tag: Type.Optional(Type.String({ description: "List the notes with this tag (with or without #). Default: list all tags." })),
			prefix: Type.Optional(Type.String({ description: "Only tags starting with this, when listing all." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = await ask(ctx, { action: "tags", tag: params.tag, prefix: params.prefix });
			if (r.notes) return text(list(`Notes tagged ${params.tag}`, r.notes) + (r.total && r.total > r.notes.length ? `\n… and ${r.total - r.notes.length} more` : ""));
			return text(list("Tags", (r.counts ?? []).map((c) => `${c.tag} (${c.count})`)));
		},
	});

	pi.registerTool({
		name: "obsidian_set_properties",
		label: "Set properties",
		description: "Set or remove properties (frontmatter) of a note through Obsidian, which keeps the YAML well-formed and the rest of the note untouched. Values can be strings, numbers, booleans, lists or dates (as ISO strings).",
		parameters: Type.Object({
			path: pathParam("note"),
			set: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Properties to set, by name." })),
			remove: Type.Optional(Type.Array(Type.String(), { description: "Property names to remove." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = await ask(ctx, { action: "set_properties", path: params.path, set: params.set, remove: params.remove });
			return text(`Properties of ${r.path} are now:\n${JSON.stringify(r.frontmatter ?? {}, null, 2)}`);
		},
	});

	pi.registerTool({
		name: "obsidian_open",
		label: "Open in Obsidian",
		description: "Show a note (or any vault file) to the user in Obsidian, optionally at a heading. Use it when the user should look at something, not to read it yourself.",
		parameters: Type.Object({
			path: Type.String({ description: 'Vault path or note name. Add "#Heading" to scroll to a heading.' }),
			newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of the current one. Default false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(`Opened ${(await ask(ctx, { action: "open", path: params.path, newTab: params.newTab })).opened}`);
		},
	});

	pi.registerTool({
		name: "obsidian_commands",
		label: "Obsidian commands",
		description: "List Obsidian's commands (the command palette): core ones and those of installed plugins, with their ids for obsidian_run_command. Only the ones the user allows pi to run are listed.",
		parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Words to filter by, matched against the name and id." })) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = await ask(ctx, { action: "commands", query: params.query });
			const rows = (r.commands ?? []).map((c) => `${c.id} — ${c.name}`);
			return text(list("Commands", rows) + (r.total && r.total > rows.length ? `\n… ${r.total - rows.length} more; narrow with query` : "") + (r.note ? `\n\n${r.note}` : ""));
		},
	});

	pi.registerTool({
		name: "obsidian_run_command",
		label: "Run Obsidian command",
		description: "Run an Obsidian command by id, as if the user picked it from the command palette. It acts on what the user has open. The user decides which commands pi may run, under Pi Harness settings.",
		parameters: Type.Object({ id: Type.String({ description: "Command id from obsidian_commands, such as editor:toggle-source." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return text(`Ran ${(await ask(ctx, { action: "run_command", id: params.id })).ran}.`);
		},
	});
}
