// One turn of one agent in an A2A discussion, as a separate one-off pi run: its own model, its
// own instructions, and web_search/web_fetch as its only tools. pi does the tool loop; this
// reads its JSON event stream, reports searches and text as they come, and returns the answer.
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import type { TurnProgress, TurnRequest } from "./discussion";

export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface PiEvent {
	type?: string;
	toolName?: string;
	args?: { query?: unknown };
	assistantMessageEvent?: { type?: string; delta?: string };
	message?: { role?: string; stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[]; usage?: TurnUsage };
}

const TOOLS = "web_search,web_fetch";
// How pi runs pi: the Pi Harness plugin names its binary (Settings → pi binary) in the environment.
const piBinary = () => process.env.PI_HARNESS_PI || "pi";

export function speakWithPi(
	request: TurnRequest,
	cwd: string,
	onProgress: (progress: TurnProgress) => void,
	onUsage: (usage: TurnUsage) => void,
	signal?: AbortSignal,
): Promise<string> {
	const args = [
		"-p",
		"--mode", "json",
		"--no-session",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--tools", TOOLS,
		"--model", request.model,
		"--system-prompt", request.systemPrompt,
		"--", request.prompt,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(piBinary(), args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const stop = () => proc.kill();
		signal?.addEventListener("abort", stop, { once: true });

		// The agent may write between searches; what counts is its last message.
		let answer = "";
		let streaming = "";
		let failure = "";
		let stderr = "";

		const onEvent = (event: PiEvent) => {
			if (event.type === "tool_execution_start" && event.toolName === "web_search" && typeof event.args?.query === "string") {
				onProgress({ search: event.args.query });
			} else if (event.type === "message_start" && event.message?.role === "assistant") {
				streaming = "";
			} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				streaming += event.assistantMessageEvent.delta ?? "";
				onProgress({ text: streaming });
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				if (event.message.usage) onUsage(event.message.usage);
				if (event.message.stopReason === "error") failure = event.message.errorMessage || "The model returned an error.";
				const text = (event.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
				if (text) answer = text;
			}
		};

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let newline: number;
			while ((newline = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					onEvent(JSON.parse(line) as PiEvent);
				} catch {
					// Not an event: pi's own warnings can land on stdout.
				}
			}
		});
		proc.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-2000)));
		proc.on("error", (err) => (failure = `Couldn't start ${piBinary()}: ${err.message}`));
		proc.on("close", (code) => {
			signal?.removeEventListener("abort", stop);
			if (signal?.aborted) return reject(new Error("Stopped."));
			if (failure) return reject(new Error(failure));
			if (answer) return resolve(answer);
			const lastLines = stderr.trim().split("\n").slice(-4).join("\n");
			reject(new Error(lastLines || `pi exited (code ${code}) without an answer.`));
		});
	});
}
