// Throwaway probe extension: bisects which option makes the SDK query fail
// inside pi. Variants via PI_PROBE_VARIANT=a|b|c|d|e. Delete after use.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { AssistantMessageEventStream, TranscriptContext, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piAi, type PiAi } from "../src/host";

const quiet = async () => ({});

const ISOLATION_ENV: Record<string, string | undefined> = {
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
	ENABLE_TOOL_SEARCH: "false",
	CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
	MAX_MCP_OUTPUT_TOKENS: "200000",
	CLAUDE_CODE_SIMPLE: undefined,
	CLAUDE_CODE_EFFORT_LEVEL: undefined,
	MCP_TOOL_TIMEOUT: undefined,
};

import { readFile } from "node:fs/promises";

export default async function (pi: ExtensionAPI) {
	const ai: PiAi = await piAi();

	const streamSimple = (_model: unknown, context: TranscriptContext): AssistantMessageEventStream => {
		const variant = process.env.PI_PROBE_VARIANT ?? "a";
		const stream = ai.createAssistantMessageEventStream();
		const output = {
			role: "assistant" as const,
			content: [] as Array<{ type: "text"; text: string }>,
			api: "claude-probe",
			provider: "claude-probe",
			model: "sonnet",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending" as "pending",
			timestamp: Date.now(),
		};
		void (async () => {
			try {
				const transcript = ai.collapseSystemMessages(context);
				const users = transcript.messages.filter((m): m is UserMessage => m.role === "user");
				const base: Record<string, unknown> = {
					cwd: process.cwd(),
					effort: "medium",
					model: "sonnet",
					env: { ...process.env, ...ISOLATION_ENV },
					settingSources: [],
					settings: { disableAllHooks: true },
					thinking: { type: "adaptive", display: "summarized" },
					strictMcpConfig: true,
					skills: [],
					tools: [],
					permissionMode: "dontAsk",
					allowedTools: ["mcp__pi__*"],
					verbatimPrompts: true,
					includePartialMessages: true,
					persistSession: false,
					sessionId: randomUUID(),
					systemPrompt:
						process.env.PI_PROBE_FILE
							? clipPrompt(undefined, await readFile(process.env.PI_PROBE_FILE, "utf8"))
							: variant === "e" || variant === "f"
								? clipPrompt(process.env.PI_PROBE_CLIP, ai.getCurrentSystemPrompt(transcript.messages))
								: "You are pi, a coding agent. Be terse.",
				};
				if (process.env.PI_PROBE_DUMP) {
					const { writeFileSync } = await import("node:fs");
					writeFileSync(process.env.PI_PROBE_DUMP as string, String(base.systemPrompt));
				}
				if (variant >= "b") base.hooks = { PreToolUse: [{ hooks: [quiet] }], PostToolUse: [{ hooks: [quiet] }] };
				if (variant >= "c") base.mcpServers = {};
				let userText =
					variant === "e"
						? (users.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n") || "Reply with exactly: PROBE-OK")
						: "Reply with exactly: PROBE-OK";
				const pad = Number(process.env.PI_PROBE_PAD ?? 0);
				if (pad > 0) userText = `${userText}\n\nIgnore this filler: ${"context filler text block. ".repeat(Math.ceil(pad / 24))}`;
				let prompt: string | AsyncGenerator<{ type: "user"; message: { role: "user"; content: Array<Record<string, unknown>> }; parent_tool_use_id: null }> = userText;
				if (variant >= "d") {
					const text = userText;
					prompt = (async function* () {
						yield {
							type: "user" as const,
							message: { role: "user" as const, content: [{ type: "text", text }] },
							parent_tool_use_id: null,
						};
						await new Promise<void>(() => {});
					})();
				}
				const q = query({ prompt: prompt as never, options: base as never });
				for await (const message of q) {
					if (message.type === "assistant") {
						for (const block of message.message.content) {
							if (block.type === "text") {
								const at = output.content.length;
								output.content.push({ type: "text", text: block.text });
								stream.push({ type: "text_start", contentIndex: at, partial: output });
								stream.push({ type: "text_delta", contentIndex: at, delta: block.text, partial: output });
								stream.push({ type: "text_end", contentIndex: at, content: block.text, partial: output });
							}
						}
					}
					if (message.type === "result") {
						console.error(`[probe ${variant}] result: ${message.subtype} ${message.is_error ? "ERROR" : "ok"} ${String(message.result).slice(0, 140)}`);
						output.stopReason = "stop";
						stream.push({ type: "done", reason: "stop", message: output });
						stream.end();
						return;
					}
				}
				throw new Error("query ended without result");
			} catch (error) {
				console.error(`[probe ${variant}] error: ${error instanceof Error ? error.message : String(error)}`);
				output.stopReason = "error";
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
			}
		})();
		return stream;
	};

	pi.registerProvider("claude-probe", {
		name: "Claude Probe",
		baseUrl: "claude-probe://local",
		apiKey: "probe",
		api: "claude-probe",
		models: [
			{
				id: "sonnet",
				name: "Probe Sonnet",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			},
		],
		streamSimple: streamSimple as never,
	});
}

function clipPrompt(clip: string | undefined, prompt: string): string {
	const n = clip === undefined ? undefined : Number(clip);
	return n === undefined || Number.isNaN(n) ? prompt : prompt.slice(0, n);
}
