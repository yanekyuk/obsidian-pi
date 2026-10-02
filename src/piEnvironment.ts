// The app can itself have been launched from an older isolated Pi. Shared mode
// always uses the standard profile, regardless of the app's inherited override.
export function sharedPiEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...inherited };
	delete env.PI_CODING_AGENT_DIR;
	delete env.PI_HARNESS_PI;
	delete env.PI_MCP_CONFIG_MODE;
	return env;
}
