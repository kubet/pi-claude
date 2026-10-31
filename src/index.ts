// pi-claude: run Claude Code as a model provider inside pi.
//
// Registration uses the complete-Provider form: ambient auth (the local
// claude binary holds the credentials), a static alias catalog, and a
// streamSimple() that hands each pi model turn to the BridgeManager.
// Everything pi-side keeps working: tools, permissions, session log,
// extensions observing tool_call events.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Model,
	Provider,
	SimpleStreamOptions,
	TranscriptContext,
	UserMessage,
} from "@earendil-works/pi-ai";
import { BASE_URL, effortFor, PROVIDER_ID, staticModels } from "./catalog";
import { BridgeManager, bridgeKey, findClaude } from "./bridge";
import { emptyAssistant } from "./convert";
import { piAi, type PiAi } from "./host";

export default async function (pi: ExtensionAPI) {
	// Fail fast on a host that provides no pi-ai module.
	const ai: PiAi = await piAi();
	if (process.env.PI_CLAUDE_DEBUG) {
		const interesting = Object.entries(process.env)
			.filter(([key]) => /CLAUDE|ANTHROPIC|API_KEY/i.test(key))
			.map(([key, value]) => `${key}=${(value ?? "").slice(0, 24)}`);
		console.error(`[pi-claude] extension env: ${interesting.join(" ") || "(none)"}`);
	}
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
			try {
				const transcript = ai.collapseSystemMessages(context);
				const systemPrompt = ai.getCurrentSystemPrompt(transcript.messages);
				const tools = ai.getCurrentTools(transcript.messages);
				const users = transcript.messages.filter(
					(message): message is UserMessage => message.role === "user",
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
					signal: options?.signal,
				});
				// pi --print exits after the last prompt; live Claude Code
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

	const provider: Provider = {
		id: PROVIDER_ID,
		name: "Claude Code",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "Claude Code CLI (subscription or ambient ANTHROPIC_* credentials)",
				resolve: async () =>
					findClaude()
						? { auth: { apiKey: "claude-code" }, source: "local Claude Code CLI" }
						: undefined,
			},
		},
		getModels: () => models,
		stream: (model: Model<Api>, context: TranscriptContext, options?: ApiStreamOptions<Api>) =>
			streamSimple(model, context, options as SimpleStreamOptions | undefined),
		streamSimple,
	};

	pi.registerProvider(provider);

}

function printMode(): boolean {
	return process.argv.some((arg) => arg === "--print" || arg === "-p" || arg.startsWith("--print="));
}
