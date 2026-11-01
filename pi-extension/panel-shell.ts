// The panel's Pi can need an isolated profile, but its shell commands must not
// hand panel-only settings to unrelated apps launched with `open` (or their shells).
// A child that deliberately needs isolation can set its own environment explicitly.
import {
	createBashTool,
	createLocalBashOperations,
	createPowerShellTool,
	createLocalPowerShellOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 45;
export const TREE_COMMAND = "pi-workbench:tree";
export const BRANCH_ANCHOR_TYPE = "pi-workbench:branch-anchor";
export const BRANCH_START_TYPE = "pi-workbench:branch-start";

type TreeRequest =
	| { action: "start" }
	| { action: "navigate"; targetId: string; summarize?: boolean };

export function environmentForShell(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	delete clean.PI_CODING_AGENT_DIR;
	delete clean.PI_MCP_CONFIG_MODE;
	delete clean.PI_HARNESS_PI;
	delete clean.PI_SESSION_ID;
	delete clean.PI_SESSION_FILE;
	delete clean.PI_MODEL;
	delete clean.PI_PROVIDER;
	delete clean.PI_REASONING_LEVEL;
	return clean;
}

export default function (pi: ExtensionAPI): void {
	const isWindows = process.platform === "win32";
	const toolOptions = {
		// Prevent Pi's shell tool from injecting session metadata into launched apps.
		exposeSessionEnvironment: false,
		spawnHook: ({ command, cwd, env }: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
			command,
			cwd,
			env: environmentForShell(env),
		}),
	};

	const shell = isWindows
		? createPowerShellTool(process.cwd(), toolOptions)
		: createBashTool(process.cwd(), toolOptions);

	pi.registerTool({
		...shell,
		execute: (id, params, signal, onUpdate, ctx) => {
			const timeout = params?.timeout ?? DEFAULT_SHELL_TIMEOUT_SECONDS;
			return shell.execute(id, { ...params, timeout }, signal, onUpdate, ctx);
		},
	});

	// The user-entered !/!! path bypasses the model's shell tool and its spawn hook.
	const local = isWindows ? createLocalPowerShellOperations() : createLocalBashOperations();
	pi.on("user_bash", () => ({
		operations: {
			exec: (command, cwd, options) =>
				local.exec(command, cwd, {
					...options,
					env: environmentForShell({ ...process.env, ...options.env }),
				}),
		},
	}));

	// In-place tree navigation and branch markers live on ExtensionCommandContext/ExtensionAPI
	// rather than top-level RPC commands, so the panel drives them through this internal command.
	pi.registerCommand(TREE_COMMAND, {
		description: "Internal Pi Workbench session tree control",
		handler: async (args, ctx) => {
			const req = JSON.parse(args) as TreeRequest;
			if (req.action === "start") {
				const hasConversation = ctx.sessionManager
					.getBranch()
					.some((e: { type?: string; message?: { role?: string } }) => e.type === "message" && e.message?.role !== "system");
				if (!hasConversation) {
					throw new Error("Send a message before starting a branch.");
				}
				const anchorId = pi.appendEntry(BRANCH_ANCHOR_TYPE, {});
				pi.appendEntry(BRANCH_START_TYPE, { anchorId });
				return;
			}
			if (req.action === "navigate") {
				const result = await ctx.navigateTree(req.targetId, {
					summarize: Boolean(req.summarize),
				});
				if (result.cancelled) {
					throw new Error("Branch navigation was cancelled.");
				}
			}
		},
	});
}
