import { promises as fs } from "fs";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { join } from "path";

export interface McpServer {
	name: string;
	url: string;
}

const PROBE_TIMEOUT_MS = 1500;

// The HTTP servers in the vault's .mcp.json, which is where pi's MCP adapter finds them.
// Command-based (stdio) servers are started by the adapter itself and can't be probed.
export async function vaultMcpServers(vaultPath: string): Promise<McpServer[]> {
	try {
		const config = JSON.parse(await fs.readFile(join(vaultPath, ".mcp.json"), "utf8")) as { mcpServers?: Record<string, { url?: unknown; disabled?: unknown }> };
		return Object.entries(config.mcpServers ?? {})
			.filter(([, server]) => typeof server?.url === "string" && server.disabled !== true)
			.map(([name, server]) => ({ name, url: server.url as string }));
	} catch {
		return []; // no file, or not valid JSON: nothing to check
	}
}

const INITIALIZE = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "obsidian-pi-harness", version: "probe" } },
});

// Asks the server the first thing any MCP client asks. pi's adapter connects lazily, so its
// own status line reads "enabled" whether or not the server is there; this finds out.
// Returns null when the server is usable, otherwise why not.
//   no connection  -> down
//   404 or 5xx     -> something is listening, but not a working MCP endpoint
//   anything else  -> up (2xx; 401/403 mean it wants auth, which is the adapter's job;
//                     other 4xx mean it is alive and merely dislikes this probe)
export function probeMcp(url: string): Promise<string | null> {
	return new Promise((resolve) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return resolve("its URL is not valid");
		}
		const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
			target,
			{
				method: "POST",
				timeout: PROBE_TIMEOUT_MS,
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(INITIALIZE) },
			},
			(res) => {
				const status = res.statusCode ?? 0;
				// Settle first: tearing the socket down can emit a late "error", which must not win.
				resolve(status === 404 || status >= 500 ? `it answered HTTP ${status}, not as an MCP server` : null);
				res.resume();
				req.destroy();
			},
		);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", () => resolve("nothing is answering there"));
		req.end(INITIALIZE);
	});
}

export async function unusableMcpServers(vaultPath: string): Promise<(McpServer & { reason: string })[]> {
	const servers = await vaultMcpServers(vaultPath);
	const reasons = await Promise.all(servers.map((s) => probeMcp(s.url)));
	return servers.flatMap((s, i) => (reasons[i] ? [{ ...s, reason: reasons[i] as string }] : []));
}
