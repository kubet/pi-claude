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
import type { RateLimitInfo, UserContentBlock } from "./convert";
import type { PiAi } from "./extension-core";
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

export const sdkSpawn: SpawnQuery = (options, prompt) => {
	const q = query({ prompt, options });
	if (!process.env.PI_CLAUDE_DEBUG) return q;
	// Debug tee. Never stringify `options`: tool schemas are circular, and one
	// JSON.stringify crash here would take the whole turn down with it.
	const systemPrompt = options.systemPrompt;
	console.error(
		`[pi-claude] spawn: model=${options.model ?? "(default)"} effort=${options.effort ?? "(default)"} systemPrompt=${typeof systemPrompt === "string" ? systemPrompt.length : "(structured)"} mcp=${Object.keys(options.mcpServers ?? {}).join(",")}`,
	);
	const tee: QueryLike = {
		interrupt: () => q.interrupt(),
		async *[Symbol.asyncIterator]() {
			for await (const message of q) {
				console.error(`[pi-claude] msg: ${JSON.stringify(message).slice(0, 800)}`);
				yield message;
			}
		},
	};
	return tee;
};

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
	// Options.env is the child's COMPLETE environment, not a delta: start from
	// pi's own env (HOME, PATH, credentials helpers) or claude looks logged out.
	const env: Record<string, string | undefined> = { ...process.env, ...ISOLATION_ENV };
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
	toolNames: ReadonlySet<string>;
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
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly spawn: SpawnQuery,
		readonly key: BridgeKey,
		readonly pending: PendingTools,
		private readonly offeredTools: ReadonlySet<string>,
		options: Options,
		initial: readonly SDKUserMessage[],
	) {
		this.query = spawn(options, this.prompt());
		for (const message of initial) this.pushUser(message);
		void this.runPump();
	}

	private readonly query: QueryLike;

	/** Idle bridges hold a claude process for no reason; retire after 5 minutes (opencode parity). */
	private armIdleShutdown(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (!this.busy && !this.dead) this.kill();
		}, IDLE_MS);
		this.idleTimer.unref?.();
	}

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
		clearTimeout(this.idleTimer);
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
	async turn(input: TurnInput): Promise<AssistantMessage> {
		const { ai, stream, model, messages, newUserMessages, signal } = input;
		if (this.busy) {
			throw new Error("pi-claude: previous turn on this conversation is still active");
		}
		this.busy = true;
		this.lastActivity = Date.now();
		this.armIdleShutdown();
		const output = emptyAssistant(model);
		const accumulator = new SdkToPiAccumulator(ai, stream, output, model, input.toolNames);
		// Claude Code runs parallel tool calls from one assistant message
		// sequentially: resolving the first parked call makes it fire the next
		// mid-turn, with no new SDK message in between. Satisfy any parked call
		// from the transcript the moment it parks, or the turn deadlocks.
		const resultsById = new Map<string, ToolResultMessage>();
		for (const message of messages) {
			if (message.role === "toolResult") resultsById.set(message.toolCallId, message as ToolResultMessage);
		}
		this.pending.onPark = (id) => {
			const result = resultsById.get(id);
			if (!result || this.consumedResults.has(id)) return undefined;
			this.consumedResults.add(id);
			return toolResultToMcp(result);
		};
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
			this.armIdleShutdown();
		}
		return output;
	}

	/** Reads SDK messages until the turn ends at a tool boundary or a result. */
	private async readUntilBoundary(
		accumulator: SdkToPiAccumulator,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
		signal: AbortSignal | undefined,
	): Promise<void> {
		let rateLimit: RateLimitInfo | undefined;
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
				this.dead = true;
				throw new Error(this.fatal instanceof Error ? this.fatal.message : "Claude Code process exited mid-turn");
			}
			switch (message.type) {
				case "stream_event":
					accumulator.onStreamEvent(message.event);
					break;
				case "assistant": {
					const inner = message.message;
					accumulator.onAssistant(inner);
					// Only calls to tools pi offered end the turn; anything else
					// is left to Claude Code, which gets its own error from the
					// MCP layer and self-corrects (opencode parity).
					const offeredCall = (inner.content ?? []).some(
						(block) => block.type === "tool_use" && this.offeredTools.has(piToolName(block.name ?? "")),
					);
					if (offeredCall) {
						// omp's loop reads message.stopReason (pi reads the event's reason).
						output.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message: output });
						stream.end();
						return;
					}
					break;
				}
				case "rate_limit_event": {
					const info = (message as unknown as { rate_limit_info?: RateLimitInfo }).rate_limit_info;
					if (info) rateLimit = info;
					break;
				}
				case "result": {
					if (this.skipNextResult) {
						this.skipNextResult = false;
						break;
					}
					const error = resultError(message, rateLimit);
					if (error) {
						// A terminal claude-side failure leaves nothing to read;
						// retire the process so pi's retry respawns cleanly with
						// a transcript replay instead of hanging on a dead turn.
						this.dead = true;
						this.pending.clear();
						throw error;
					}
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

const IDLE_MS = 5 * 60_000;
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
		const systemPrompt = claudeSystemPrompt(input.systemPrompt, input.tools.length > 0);
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
		const bridge = new Bridge(
			this.spawn,
			input.key,
			pending,
			new Set(input.tools.map((tool) => tool.name)),
			this.buildOptions(input, pending),
			initial,
		);
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
	/** Kill every live Claude Code process (pi session shutdown). */
	shutdown(): void {
		for (const bridge of this.bridges) bridge.kill();
		this.bridges = [];
	}
}

/**
 * Compose the Claude Code-facing system prompt from pi's.
 *
 * pi's prompt sections are harness chrome Claude Code cannot use: <tools>
 * duplicates the real MCP schemas, <docs> and <skills> point at pi-side files
 * Claude Code reaches through pi's tools when needed. Worse, forwarding them
 * verbatim bloats the request enough to tip SDK turns into Claude Code's
 * overage path on a subscription with thin rolling headroom ("out of extra
 * usage"), so the bridge keeps the behavioral core — preamble, <rules>, and
 * the MCP adapter note — under PI_CLAUDE_SYSTEM_BUDGET (default 1600 chars).
 */
export function claudeSystemPrompt(piPrompt: string | undefined, withTools: boolean): string {
	const budget = Number(process.env.PI_CLAUDE_SYSTEM_BUDGET ?? 1600);
	const keep = (piPrompt ?? "")
		.replace(/<tools>[\s\S]*?<\/tools>/g, "")
		.replace(/<docs>[\s\S]*?<\/docs>/g, "")
		.replace(/<skills>[\s\S]*?<\/skills>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const prompt = `${keep}${withTools ? ADAPTER_NOTE : ""}`;
	return prompt.length <= budget ? prompt : prompt.slice(0, budget);
}
