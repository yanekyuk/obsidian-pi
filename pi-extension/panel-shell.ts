// The panel's Pi can need an isolated profile, but its shell commands must not
// hand panel-only settings to unrelated apps launched with `open` (or their shells).
// A child that deliberately needs isolation can set its own environment explicitly.
import { createBashTool, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	const bash = createBashTool(process.cwd(), {
		// Prevent Pi's shell tool from injecting session metadata into launched apps.
		exposeSessionEnvironment: false,
		spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: environmentForShell(env) }),
	});
	pi.registerTool({
		...bash,
		execute: (id, params, signal, onUpdate, _ctx) => bash.execute(id, params, signal, onUpdate),
	});

	// The user-entered !/!! path bypasses the model's bash tool and its spawn hook.
	const local = createLocalBashOperations();
	pi.on("user_bash", () => ({
		operations: {
			exec: (command, cwd, options) => local.exec(command, cwd, {
				...options,
				env: environmentForShell({ ...process.env, ...options.env }),
			}),
		},
	}));
}
