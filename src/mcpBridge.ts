import { randomBytes } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { BrowserControl } from "./browser";
import type { ObsidianControl } from "./obsidianControl";
import type { AcpMcpServerStdio } from "./rpc/AgentClient";

interface McpToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const OBSIDIAN_TOOLS: McpToolDef[] = [
	{
		name: "obsidian_search",
		description: "Ranked keyword search across the Obsidian vault. Returns matching note sections with headings, line ranges, and snippets.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query words." },
				folder: { type: "string", description: "Optional folder path prefix to restrict search." },
				limit: { type: "number", description: "Maximum number of hits (default 8, max 20)." },
			},
			required: ["query"],
		},
	},
	{
		name: "obsidian_note_info",
		description: "Read a note's frontmatter properties, aliases, tags, headings, outgoing links, unresolved links, and backlinks from Obsidian's metadata cache.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault path or note name. Defaults to the currently open note." },
			},
		},
	},
	{
		name: "obsidian_tags",
		description: "List all vault tags with counts, or list notes carrying a specific tag.",
		inputSchema: {
			type: "object",
			properties: {
				tag: { type: "string", description: "Optional tag (with or without #) to list matching notes." },
				prefix: { type: "string", description: "Optional tag prefix filter." },
			},
		},
	},
	{
		name: "obsidian_set_properties",
		description: "Safely set or remove YAML frontmatter properties on a note through Obsidian.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault path or note name. Defaults to the currently open note." },
				set: { type: "object", description: "Key-value pairs to set in frontmatter." },
				remove: { type: "array", items: { type: "string" }, description: "Property keys to remove." },
			},
		},
	},
	{
		name: "obsidian_open",
		description: "Open a note in Obsidian.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Vault path or note name." },
				newTab: { type: "boolean", description: "Open in a new tab." },
			},
		},
	},
	{
		name: "obsidian_commands",
		description: "List available Obsidian command palette commands and their IDs.",
		inputSchema: {
			type: "object",
			properties: {
				prefix: { type: "string", description: "Optional command ID or name filter." },
			},
		},
	},
	{
		name: "obsidian_run_command",
		description: "Run an Obsidian command by ID (subject to user allowlist).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Command ID to execute." },
			},
			required: ["id"],
		},
	},
];

const BROWSER_TOOLS: McpToolDef[] = [
	{
		name: "browser_open",
		description: "Open a URL in Obsidian's built-in web viewer.",
		inputSchema: {
			type: "object",
			properties: { url: { type: "string" } },
			required: ["url"],
		},
	},
	{
		name: "browser_read",
		description: "Read text and optional links from the active Obsidian web viewer page.",
		inputSchema: {
			type: "object",
			properties: {
				selector: { type: "string" },
				links: { type: "boolean" },
			},
		},
	},
	{
		name: "browser_click",
		description: "Click an element on the active Obsidian web viewer page by selector or visible text.",
		inputSchema: {
			type: "object",
			properties: {
				selector: { type: "string" },
				text: { type: "string" },
			},
		},
	},
	{
		name: "browser_type",
		description: "Type text into an input element on the active Obsidian web viewer page.",
		inputSchema: {
			type: "object",
			properties: {
				selector: { type: "string" },
				text: { type: "string" },
				submit: { type: "boolean" },
			},
			required: ["selector", "text"],
		},
	},
	{
		name: "browser_screenshot",
		description: "Capture a screenshot of the active Obsidian web viewer page.",
		inputSchema: { type: "object", properties: {} },
	},
];

// Minimal stdio-to-HTTP JSON-RPC bridge executed via Electron's Node mode.
const STDIO_SHIM = `
const http = require("http");
const readline = require("readline");
const port = Number(process.argv[1]);
const token = process.argv[2];
const path = process.argv[3] || "/mcp";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = http.request({
    hostname: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      "Content-Length": Buffer.byteLength(line),
    },
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      if (body.trim()) process.stdout.write(body.trim() + "\\n");
    });
  });
  req.on("error", () => {});
  req.write(line);
  req.end();
});
`;

export class ObsidianMcpBridge {
	private server: Server | null = null;
	private port = 0;
	private readonly token = randomBytes(24).toString("hex");

	constructor(
		private obsidian: ObsidianControl,
		private browser: BrowserControl,
		private options: () => { obsidianControl: boolean; browserControl: boolean },
	) {}

	async ensureStarted(): Promise<number> {
		if (this.server && this.port > 0) return this.port;
		const server = createServer((req, res) => void this.handleHttp(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (addr && typeof addr === "object") this.port = addr.port;
				resolve();
			});
		});
		this.server = server;
		return this.port;
	}

	async stdioConfig(overrides?: { obsidianControl?: boolean; browserControl?: boolean }): Promise<AcpMcpServerStdio | null> {
		const base = this.options();
		const obsidianControl = overrides?.obsidianControl ?? base.obsidianControl;
		const browserControl = overrides?.browserControl ?? base.browserControl;
		if (!obsidianControl && !browserControl) return null;
		const port = await this.ensureStarted();
		const path = `/mcp?obsidian=${obsidianControl ? "1" : "0"}&browser=${browserControl ? "1" : "0"}`;
		return {
			name: "obsidian",
			command: process.execPath,
			args: ["-e", STDIO_SHIM, String(port), this.token, path],
			env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
		};
	}

	stop(): void {
		this.server?.close();
		this.server = null;
		this.port = 0;
	}

	private effectiveOptions(url: URL): { obsidianControl: boolean; browserControl: boolean } {
		const base = this.options();
		const obs = url.searchParams.get("obsidian");
		const bro = url.searchParams.get("browser");
		return {
			obsidianControl: obs === null ? base.obsidianControl : obs === "1",
			browserControl: bro === null ? base.browserControl : bro === "1",
		};
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "POST" || url.pathname !== "/mcp" || req.headers.authorization !== `Bearer ${this.token}`) {
			res.writeHead(403).end();
			return;
		}
		const opts = this.effectiveOptions(url);
		let raw = "";
		for await (const chunk of req) raw += chunk;
		let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
		try {
			msg = JSON.parse(raw);
		} catch {
			res.writeHead(400).end();
			return;
		}

		// Notifications have no id and expect no JSON-RPC response body.
		if (msg.id === undefined) {
			res.writeHead(204).end();
			return;
		}

		const reply = (result: unknown) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
		};
		const fail = (code: number, message: string) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }));
		};

		try {
			if (msg.method === "initialize") {
				return reply({
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "agent-workbench-obsidian", version: "1.0.0" },
				});
			}
			if (msg.method === "tools/list") {
				const tools = [
					...(opts.obsidianControl ? OBSIDIAN_TOOLS : []),
					...(opts.browserControl ? BROWSER_TOOLS : []),
				];
				return reply({ tools });
			}
			if (msg.method === "tools/call") {
				const name = String(msg.params?.name ?? "");
				const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
				const result = await this.callTool(name, args, opts);
				return reply(result);
			}
			return fail(-32601, `Method not found: ${msg.method ?? ""}`);
		} catch (err) {
			return fail(-32603, (err as Error).message || String(err));
		}
	}

	private async callTool(
		name: string,
		args: Record<string, unknown>,
		opts: { obsidianControl: boolean; browserControl: boolean },
	): Promise<{ content: unknown[]; isError?: boolean }> {
		if (name.startsWith("obsidian_")) {
			if (!opts.obsidianControl) return { content: [{ type: "text", text: "Obsidian tools are disabled in settings." }], isError: true };
			const action = name.slice("obsidian_".length);
			const raw = await this.obsidian.handle(JSON.stringify({ ...args, action }));
			const parsed = JSON.parse(raw) as { error?: string };
			return { content: [{ type: "text", text: raw }], isError: Boolean(parsed.error) };
		}
		if (name.startsWith("browser_")) {
			if (!opts.browserControl) return { content: [{ type: "text", text: "Browser tools are disabled in settings." }], isError: true };
			const action = name.slice("browser_".length);
			const raw = await this.browser.handle(JSON.stringify({ ...args, action }));
			const parsed = JSON.parse(raw) as { error?: string; image?: string; mimeType?: string };
			if (parsed.image && parsed.mimeType) {
				return {
					content: [{ type: "image", data: parsed.image, mimeType: parsed.mimeType }],
				};
			}
			return { content: [{ type: "text", text: raw }], isError: Boolean(parsed.error) };
		}
		return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
	}
}
