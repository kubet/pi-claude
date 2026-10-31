// The bridge: one long-lived Claude Code process per conversation.
//
// pi's provider contract is stateless per streamSimple() call, but Claude
// Code tool calls must park until pi's agent loop executes the tool and the
// next call arrives. So each conversation keeps a Claude Code process alive:
// user messages stream in through the query's prompt generator, tool calls
// park in PendingTools, and the next streamSimple() resolves them from the
// transcript and keeps reading. Bridge selection is prefix-matching over the
// hashed user-message history, which routes subagents to their own processes
// and respawns (with a rendered-transcript restore message) after compaction,
// forks, prompt changes, or host restarts.

import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import {
	query,
	type HookCallback,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { UserContentBlock } from "./convert";
import type { PiAi } from "./host";
import { makeToolServer, MCP_SERVER_NAME, piToolName } from "./mcp";
import { PendingTools } from "./pending";
import {
	emptyAssistant,
	resultError,
	restoreMessage,
	SdkToPiAccumulator,
	sdkUserContent,
	stableHash,
	toolResultToMcp,
} from "./convert";

export interface QueryLike extends AsyncIterable<SDKMessage> {
	interrupt(): unknown;
}

/** Injectable query factory so tests can drive the bridge without claude. */
export type SpawnQuery = (options: Options, prompt: AsyncGenerator<SDKUserMessage>) => QueryLike;

export const sdkSpawn: SpawnQuery = (options, prompt) => query({ prompt, options });

/** Claude Code features that duplicate pi's; pi's version wins (opencode parity). */
const ISOLATION_ENV: Record<string, string | undefined> = {
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
	ENABLE_TOOL_SEARCH: "false",
	CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
	// Raised so pi's own truncation applies instead
	MAX_MCP_OUTPUT_TOKENS: "200000",
	// Skips OAuth, so the subscription would not be used
	CLAUDE_CODE_SIMPLE: undefined,
	// A shell-level effort override would beat pi's live thinking level
	CLAUDE_CODE_EFFORT_LEVEL: undefined,
	// Would cap every pi tool call, failing permission prompts that wait on a human
	MCP_TOOL_TIMEOUT: undefined,
};

const PASSTHROUGH_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];

function sdkEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...ISOLATION_ENV };
	for (const name of PASSTHROUGH_ENV) {
		if (process.env[name]) env[name] = process.env[name];
	}
	return env;
}

/** Locate the claude binary on PATH (or via PI_CLAUDE_EXECUTABLE). */
export function findClaude(): string | undefined {
	const override = process.env.PI_CLAUDE_EXECUTABLE;
	if (override) return override;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "claude");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep scanning
		}
	}
	return undefined;
}

const ADAPTER_NOTE = [
	"",
	"[host] You are running inside the pi coding agent, powered by Claude Code.",
	'Every tool above is provided by pi over MCP and is named mcp__pi__<tool>: the tool pi calls "read" appears as "mcp__pi__read", and so on.',
	"Call them exactly as named in your tool definitions. pi executes every call itself and returns the results to you.",
].join("\n");

function hooksFor(pending: PendingTools): Options["hooks"] {
	const before: HookCallback = async (input) => {
		if (input.hook_event_name === "PreToolUse") {
			pending.before(input.tool_use_id, piToolName(input.tool_name));
		}
		return {};
	};
	const after: HookCallback = async (input) => {
		if (input.hook_event_name !== "PostToolUse") return {};
		const replacement = pending.after(input.tool_use_id);
		if (!replacement) return {};
		return {
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				updatedMCPToolOutput: replacement,
			},
		};
	};
	return {
		PreToolUse: [{ hooks: [before] }],
		PostToolUse: [{ hooks: [after] }],
	};
}

export interface BridgeKey {
	model: string;
	effort: string | undefined;
	systemHash: string;
	toolsHash: string;
}

export function bridgeKey(
	model: string,
	effort: string | undefined,
	systemPrompt: string | undefined,
	tools: readonly Tool[],
): BridgeKey {
	return {
		model,
		effort,
		systemHash: stableHash(systemPrompt ?? ""),
		toolsHash: stableHash(tools.map((tool) => [tool.name, tool.description, tool.parameters])),
	};
}

function sameKey(a: BridgeKey, b: BridgeKey): boolean {
	return a.model === b.model && a.effort === b.effort && a.systemHash === b.systemHash && a.toolsHash === b.toolsHash;
}

/** `sent` is a prefix of `incoming` (same hashes, same order). */
function isPrefix(sent: readonly string[], incoming: readonly string[]): boolean {
	if (sent.length > incoming.length) return false;
	return sent.every((hash, i) => hash === incoming[i]);
}

type Reader = (result: IteratorResult<SDKMessage>) => void;

export interface TurnInput {
	ai: PiAi;
	stream: AssistantMessageEventStream;
	model: Model<Api>;
	messages: readonly Message[];
	newUserMessages: readonly UserMessage[];
	signal?: AbortSignal;
}

export class Bridge {
	dead = false;
	busy = false;
	lastActivity = Date.now();
	sentHashes: string[] = [];
	private readonly consumedResults = new Set<string>();
	private readonly outgoing: SDKUserMessage[] = [];
	private wake: (() => void) | undefined;
	private readonly queue: SDKMessage[] = [];
	private readonly readers: Reader[] = [];
	private fatal: unknown;
	private queryDone = false;
	private skipNextResult = false;

	constructor(
		private readonly spawn: SpawnQuery,
		readonly key: BridgeKey,
		readonly pending: PendingTools,
		options: Options,
		initial: readonly SDKUserMessage[],
	) {
		this.query = spawn(options, this.prompt());
		for (const message of initial) this.pushUser(message);
		void this.runPump();
	}

	private readonly query: QueryLike;

	private async *prompt(): AsyncGenerator<SDKUserMessage> {
		while (!this.dead) {
			while (this.outgoing.length > 0) yield this.outgoing.shift() as SDKUserMessage;
			if (this.dead) return;
			const gate = Promise.withResolvers<void>();
			this.wake = gate.resolve;
			await gate.promise;
			this.wake = undefined;
		}
	}

	pushUser(message: SDKUserMessage): void {
		this.outgoing.push(message);
		this.wake?.();
	}

	private async runPump(): Promise<void> {
		try {
			for await (const message of this.query) {
				this.deliver({ value: message, done: false });
			}
			this.queryDone = true;
			this.drainReaders();
		} catch (error) {
			this.fatal = error;
			this.queryDone = true;
			this.drainReaders();
		}
	}

	private deliver(result: IteratorResult<SDKMessage>): void {
		const reader = this.readers.shift();
		if (reader) reader(result);
		else this.queue.push(result.value as SDKMessage);
	}

	private drainReaders(): void {
		if (!this.queryDone) return;
		while (this.readers.length > 0) {
			const reader = this.readers.shift();
			if (reader) reader({ value: undefined, done: true });
		}
	}

	private nextMessage(): Promise<SDKMessage | "closed"> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.fatal) return Promise.reject(this.fatal instanceof Error ? this.fatal : new Error(String(this.fatal)));
		if (this.queryDone) return Promise.resolve("closed");
		return new Promise<SDKMessage | "closed">((resolve) => {
			this.readers.push((result) => {
				resolve(result.done ? "closed" : (result.value as SDKMessage));
			});
		});
	}

	/** Settle readers parked in nextMessage after an abort so nothing dangles. */
	private abortReaders(): void {
		while (this.readers.length > 0) {
			const reader = this.readers.shift();
			if (reader) reader({ value: undefined, done: true });
		}
	}

	get idle(): boolean {
		return !this.busy && !this.dead && this.outgoing.length === 0;
	}

	kill(): void {
		this.dead = true;
		try {
			this.query.interrupt();
		} catch {
			// already gone
		}
		this.pending.clear();
		this.wake?.();
	}

	/**
	 * One streamSimple() call: resolve parked tool results from the transcript,
	 * feed new user messages, read until the assistant produced tool calls
	 * (pi executes them; the next call continues) or the turn ended.
	 */
	async turn(input: TurnInput): Promise<void> {
		const { ai, stream, model, messages, newUserMessages, signal } = input;
		this.busy = true;
		this.lastActivity = Date.now();
		const output = emptyAssistant(model);
		const accumulator = new SdkToPiAccumulator(ai, stream, output, model);
		try {
			for (const message of messages) {
				if (message.role !== "toolResult") continue;
				const toolResult = message as ToolResultMessage;
				if (this.consumedResults.has(toolResult.toolCallId)) continue;
				if (this.pending.resolveIfWaiting(toolResult.toolCallId, toolResultToMcp(toolResult))) {
					this.consumedResults.add(toolResult.toolCallId);
				}
			}
			for (const user of newUserMessages) {
				this.pushUser({
					type: "user",
					message: { role: "user", content: sdkUserContent(user.content) },
					parent_tool_use_id: null,
				});
			}
			await this.readUntilBoundary(accumulator, stream, output, signal);
		} finally {
			this.busy = false;
			this.lastActivity = Date.now();
		}
	}

	private async readUntilBoundary(
		accumulator: SdkToPiAccumulator,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
		signal: AbortSignal | undefined,
	): Promise<void> {
		for (;;) {
			const aborted = signal
				? (() => {
						const gate = Promise.withResolvers<true>();
						if (signal.aborted) gate.resolve(true);
						else signal.addEventListener("abort", () => gate.resolve(true), { once: true });
						return gate.promise;
					})()
				: null;
			const message: SDKMessage | "closed" = aborted
				? await Promise.race([this.nextMessage(), aborted.then(() => "closed" as const)])
				: await this.nextMessage();
			if (aborted && signal?.aborted) {
				this.abortReaders();
				this.query.interrupt();
				this.pending.clear();
				this.skipNextResult = true;
				output.stopReason = "aborted";
				output.errorMessage = "Aborted by pi";
				stream.push({ type: "error", reason: "aborted", error: output });
				stream.end();
				return;
			}
			if (message === "closed") {
				throw new Error(this.fatal instanceof Error ? this.fatal.message : "Claude Code process exited mid-turn");
			}
			switch (message.type) {
				case "stream_event":
					accumulator.onStreamEvent(message.event);
					break;
				case "assistant": {
					const inner = message.message;
					accumulator.onAssistant(inner);
					if (inner.content.some((block) => block.type === "tool_use")) {
						stream.push({ type: "done", reason: "toolUse", message: output });
						stream.end();
						return;
					}
					break;
				}
				case "result": {
					if (this.skipNextResult) {
						this.skipNextResult = false;
						break;
					}
					const error = resultError(message);
					if (error) throw error;
					const reason = accumulator.finish(message);
					output.stopReason = reason;
					stream.push({ type: "done", reason, message: output });
					stream.end();
					return;
				}
				case "user":
				case "system":
				default:
					// Init/status messages and our own echoed input carry no turn content.
					break;
			}
		}
	}
}

export interface AcquireInput {
	key: BridgeKey;
	systemPrompt: string | undefined;
	tools: readonly Tool[];
	transcript: TranscriptContext;
	userMessages: readonly UserMessage[];
	model: Model<Api>;
	cwd: string;
	maxTokens?: number;
}

export interface AcquiredBridge {
	bridge: Bridge;
	newUserMessages: readonly UserMessage[];
}

const MAX_BRIDGES = 6;

function toSdkUserMessage(content: UserContentBlock[]): SDKUserMessage {
	return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

export class BridgeManager {
	private bridges: Bridge[] = [];

	constructor(
		private readonly ai: PiAi,
		private readonly spawn: SpawnQuery = sdkSpawn,
	) {}

	private buildOptions(input: AcquireInput, pending: PendingTools): Options {
		const systemPrompt =
			input.tools.length > 0 ? `${input.systemPrompt ?? ""}${ADAPTER_NOTE}` : input.systemPrompt;
		const options: Options = {
			cwd: input.cwd,
			effort: input.key.effort as Options["effort"],
			systemPrompt: systemPrompt as NonNullable<Options["systemPrompt"]>,
			env: sdkEnv(),
			settingSources: [],
			settings: { disableAllHooks: true },
			thinking: { type: "adaptive", display: "summarized" },
			strictMcpConfig: true,
			skills: [],
			tools: [],
			permissionMode: "dontAsk",
			allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
			verbatimPrompts: true,
			includePartialMessages: true,
			persistSession: false,
			hooks: hooksFor(pending),
			mcpServers: input.tools.length > 0 ? { [MCP_SERVER_NAME]: makeToolServer(input.tools, pending) } : {},
			sessionId: randomUUID(),
			pathToClaudeCodeExecutable: findClaude(),
		};
		if (input.model.id !== "default") options.model = input.model.id;
		if (input.maxTokens !== undefined) {
			options.env = { ...options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.maxTokens) };
		}
		return options;
	}

	/** Find or spawn the bridge for this call; computes which user messages are new. */
	acquire(input: AcquireInput): AcquiredBridge {
		this.bridges = this.bridges.filter((bridge) => !bridge.dead);
		const incoming = input.userMessages.map((user) => stableHash(user.content));
		for (const bridge of this.bridges) {
			if (!sameKey(bridge.key, input.key)) continue;
			if (!isPrefix(bridge.sentHashes, incoming)) continue;
			const newUserMessages = input.userMessages.slice(bridge.sentHashes.length);
			bridge.sentHashes = incoming;
			bridge.lastActivity = Date.now();
			return { bridge, newUserMessages };
		}
		// No reusable process: spawn. When the conversation already has history
		// (assistant turns or tool results), replay it as a restore message.
		const hasHistory = input.transcript.messages.some(
			(message) => message.role === "assistant" || message.role === "toolResult",
		);
		const initial: SDKUserMessage[] = input.userMessages.map((user) =>
			toSdkUserMessage(sdkUserContent(user.content)),
		);
		if (hasHistory) {
			initial.unshift(toSdkUserMessage([{ type: "text", text: restoreMessage(input.transcript.messages) }]));
		}
		const pending = new PendingTools();
		const bridge = new Bridge(this.spawn, input.key, pending, this.buildOptions(input, pending), initial);
		bridge.sentHashes = incoming;
		this.bridges.push(bridge);
		this.evict(bridge);
		return { bridge, newUserMessages: [] };
	}

	private evict(keep: Bridge): void {
		const overflow = this.bridges.length - MAX_BRIDGES;
		if (overflow <= 0) return;
		const evictable = this.bridges.filter((bridge) => bridge !== keep && bridge.idle);
		const sorted = evictable.sort((a, b) => a.lastActivity - b.lastActivity).slice(0, overflow);
		for (const victim of sorted) victim.kill();

		this.bridges = this.bridges.filter((bridge) => !sorted.includes(bridge));
	}
}
