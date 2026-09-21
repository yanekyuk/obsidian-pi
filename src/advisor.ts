import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";

// rpiv-advisor's config file: ~/.config/rpiv-advisor/advisor.json, or under an absolute XDG_CONFIG_HOME.
function advisorConfigPath(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.replace(/^~(?=$|\/)/, homedir());
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "rpiv-advisor", "advisor.json");
}

export function readAdvisorConfig(): Record<string, unknown> & { modelKey?: string } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(advisorConfigPath(), "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

// Merges like the extension's saveAdvisorConfig: other keys (guidance, disabledForModels) are kept.
export function writeAdvisorConfig(modelKey: string | null, effort: string | null): void {
	const config = readAdvisorConfig();
	if (modelKey) config.modelKey = modelKey;
	else delete config.modelKey;
	if (effort) config.effort = effort;
	else delete config.effort;
	mkdirSync(dirname(advisorConfigPath()), { recursive: true });
	writeFileSync(advisorConfigPath(), JSON.stringify(config, null, 2) + "\n");
}
