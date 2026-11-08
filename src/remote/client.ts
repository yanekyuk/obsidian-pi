import * as obsidian from "obsidian";
import type { InstalledPackage } from "../requirements";
import type { SessionSummary } from "../sessions";
import type { FileSnapshot } from "../view/revert";
import type { RemoteSessionOverrides } from "./server";
import { normalizeHttpUrl, normalizeWsUrl } from "./ws";

export interface RemoteConfig {
	url: string;
	token: string;
}

export class PiRemoteClient {
	private cachedVaultPath = "";

	constructor(private getConfig: () => RemoteConfig) {}

	get configured(): boolean {
		return Boolean(normalizeHttpUrl(this.getConfig().url));
	}

	get vaultPath(): string {
		return this.cachedVaultPath;
	}

	wsUrl(path: "/rpc" | "/btw"): string {
		const { url, token } = this.getConfig();
		const target = normalizeWsUrl(url, path, token);
		if (!target) throw new Error("Configure the remote pi server URL in Settings → Pi Workbench.");
		return target;
	}

	async call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
		const { url, token } = this.getConfig();
		const base = normalizeHttpUrl(url);
		if (!base) throw new Error("Configure the remote pi server URL in Settings → Pi Workbench.");
		const endpoint = `${base}/api`;
		const body = JSON.stringify({ action, ...params });
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		};

		let status = 200;
		let parsed: { ok?: boolean; data?: T; error?: string };

		const reqUrl = (obsidian as unknown as { requestUrl?: (req: { url: string; method: string; headers: Record<string, string>; body: string; throw?: boolean }) => Promise<{ status: number; text: string }> }).requestUrl;
		if (typeof reqUrl === "function") {
			const res = await reqUrl({ url: endpoint, method: "POST", headers, body, throw: false });
			status = res.status;
			parsed = JSON.parse(res.text || "{}") as typeof parsed;
		} else {
			const res = await fetch(endpoint, { method: "POST", headers, body });
			status = res.status;
			parsed = (await res.json().catch(() => ({}))) as typeof parsed;
		}

		if (status >= 400 || !parsed.ok) {
			throw new Error(parsed.error || `Remote server returned HTTP ${status}`);
		}
		return parsed.data as T;
	}

	async ping(): Promise<{ vaultName: string; vaultPath: string }> {
		const data = await this.call<{ vaultName: string; vaultPath: string }>("ping");
		if (data.vaultPath) this.cachedVaultPath = data.vaultPath;
		return data;
	}

	setCachedVaultPath(vaultPath: string): void {
		if (vaultPath) this.cachedVaultPath = vaultPath;
	}

	async listSessions(): Promise<{ sessions: SessionSummary[]; heldSessionFiles: string[]; lastSessionFile: string }> {
		return this.call("list_sessions");
	}

	async sessionExists(path: string): Promise<boolean> {
		const res = await this.call<{ exists: boolean }>("session_exists", { path });
		return res.exists;
	}

	async resolveLinked(value: string): Promise<string | null> {
		const res = await this.call<{ path: string | null }>("resolve_linked", { value });
		return res.path;
	}

	async trashSession(path: string): Promise<void> {
		await this.call("trash_session", { path });
	}

	async readEnabledModels(): Promise<string[]> {
		const res = await this.call<{ patterns: string[] }>("read_enabled_models");
		return res.patterns;
	}

	async readAdvisorConfig(): Promise<Record<string, unknown> & { modelKey?: string }> {
		const res = await this.call<{ config: Record<string, unknown> & { modelKey?: string } }>("read_advisor");
		return res.config;
	}

	async writeAdvisorConfig(modelKey: string | null, effort: string | null): Promise<void> {
		await this.call("write_advisor", { modelKey, effort });
	}

	async installedPackages(): Promise<InstalledPackage[]> {
		const res = await this.call<{ packages: InstalledPackage[] }>("installed_packages");
		return res.packages;
	}

	async unusableMcpServers(): Promise<{ name: string; url: string; reason: string }[]> {
		const res = await this.call<{ servers: { name: string; url: string; reason: string }[] }>("unusable_mcp_servers");
		return res.servers;
	}

	async readImage(path: string): Promise<Uint8Array> {
		const res = await this.call<{ base64: string }>("read_image", { path });
		const binary = globalThis.atob ? globalThis.atob(res.base64) : Buffer.from(res.base64, "base64").toString("binary");
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	async snapshotBefore(path: string): Promise<FileSnapshot | undefined> {
		const res = await this.call<{ snapshot: FileSnapshot | null }>("snapshot_before", { path });
		return res.snapshot ?? undefined;
	}

	async snapshotAfter(snapshot: FileSnapshot, toolName: string, args: Record<string, unknown>): Promise<FileSnapshot | undefined> {
		const res = await this.call<{ snapshot: FileSnapshot | null }>("snapshot_after", { snapshot, toolName, args });
		return res.snapshot ?? undefined;
	}

	async unchangedSince(snapshot: FileSnapshot): Promise<boolean> {
		const res = await this.call<{ unchanged: boolean }>("unchanged_since", { snapshot });
		return res.unchanged;
	}

	async swapVersion(snapshot: FileSnapshot): Promise<FileSnapshot> {
		const res = await this.call<{ snapshot: FileSnapshot }>("swap_version", { snapshot });
		return res.snapshot;
	}

	buildSpawnOptions(sessionFile: string | null, overrides: RemoteSessionOverrides): {
		binary: string;
		args: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		remote: {
			wsUrl: string;
			sessionFile: string | null;
			overrides: RemoteSessionOverrides;
			onVaultPath?: (vaultPath: string) => void;
		};
	} {
		return {
			binary: "pi",
			args: [],
			cwd: this.cachedVaultPath || "/",
			env: {},
			remote: {
				wsUrl: this.wsUrl("/rpc"),
				sessionFile,
				overrides,
				onVaultPath: (vp) => this.setCachedVaultPath(vp),
			},
		};
	}
}
