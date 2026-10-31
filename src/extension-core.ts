// Shared extension core, host-agnostic: everything except the pi-ai module
// itself, which each host entry supplies via its own static import (pi and
// omp alias different package names, and dynamic imports bypass the alias
// maps, so the module must arrive as a parameter).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as PiAiModule from "@earendil-works/pi-ai";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Message,
	Model,
	Provider,
	SimpleStreamOptions,
	Tool,
	TranscriptContext,
	UserMessage,
} from "@earendil-works/pi-ai";

export type PiAi = typeof PiAiModule;
import { execFile } from "node:child_process";
import { API_ID, BASE_URL, effortFor, PROVIDER_ID, staticModels, versionProblem } from "./catalog";
import { BridgeManager, bridgeKey, findClaude } from "./bridge";
import { emptyAssistant } from "./convert";

export async function registerClaudeCodeProvider(pi: ExtensionAPI, ai: PiAi): Promise<void> {
	if (process.env.PI_CLAUDE_DEBUG) {
		const interesting = Object.entries(process.env)
			.filter(([key]) => /CLAUDE|ANTHROPIC|API_KEY/i.test(key))
			.map(([key, value]) => `${key}=${(value ?? "").slice(0, 24)}`);
		console.error(`[pi-claude] extension env: ${interesting.join(" ") || "(none)"}`);
	}
	const incompatible = await claudeVersionProblem(findClaude());
	if (incompatible) console.error(`[pi-claude] ${incompatible}`);
	const models = staticModels();
	const manager = new BridgeManager(ai);
	// Parked Claude Code processes keep the event loop alive; stop them on shutdown.
	pi.events.on("session_shutdown", () => {
		manager.shutdown();
	});

	const streamSimple = (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = ai.createAssistantMessageEventStream();
		const output = emptyAssistant(model);
		void (async () => {
			if (incompatible) {
				output.stopReason = "error";
				output.errorMessage = incompatible;
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}
			try {
				const transcript = ai.collapseSystemMessages(context);
				const systemPrompt = ai.getCurrentSystemPrompt(transcript.messages);
				const tools = ai.getCurrentTools(transcript.messages);
				const users = transcript.messages.filter(
					(message: Message): message is UserMessage => message.role === "user",
				);
				const effort = effortFor(options?.reasoning);
				const key = bridgeKey(model.id, effort, systemPrompt, tools);
				const acquired = manager.acquire({
					key,
					systemPrompt,
					tools,
					transcript,
					userMessages: users,
					model,
					cwd: process.cwd(),
					maxTokens: options?.maxTokens,
				});
				const final = await acquired.bridge.turn({
					ai,
					stream,
					model,
					messages: transcript.messages,
					newUserMessages: acquired.newUserMessages,
					toolNames: new Set(tools.map((tool: Tool) => tool.name)),
					signal: options?.signal,
				});
				// processes would keep it hanging. Multi-prompt print runs
				// continue via the bridge's respawn-and-restore path.
				if (printMode() && final.stopReason !== "toolUse" && final.stopReason !== "pending") {
					manager.shutdown();
				}
			} catch (error) {
				output.stopReason = output.stopReason === "pending" ? "error" : output.stopReason;
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
			}
		})();
		return stream;
	};

	// Legacy registration form: omp's fork only accepts (name, config), and
	// pi supports both. The marker apiKey satisfies the config gate; the real
	// credentials live in the claude CLI itself, checked per turn.
	pi.registerProvider(PROVIDER_ID, {
		name: "Claude Code",
		baseUrl: BASE_URL,
		apiKey: "claude-code",
		api: API_ID,
		models,
		streamSimple,
	});
}

function printMode(): boolean {
	return process.argv.some((arg) => arg === "--print" || arg === "-p" || arg.startsWith("--print="));
}

/** One-time CLI compatibility check; null when fine. */
async function claudeVersionProblem(binary: string | undefined): Promise<string | null> {
	if (binary === undefined) {
		return "pi-claude found no claude CLI on PATH. Install Claude Code (https://code.claude.com) or set PI_CLAUDE_EXECUTABLE.";
	}
	const version = await new Promise<string | undefined>((resolve) => {
		const child = execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim());
		});
		child.on("error", () => resolve(undefined));
	});
	return versionProblem(version);
}
