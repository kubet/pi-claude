// SDK-to-pi conversion: event accumulation and message translation.
//
// One pi AssistantMessage per streamSimple() call. Claude Code streams
// Anthropic wire events (SDKPartialAssistantMessage.event), then an
// authoritative SDKAssistantMessage, and finishes the turn with an
// SDKResultMessage. The accumulator appends blocks to the output content,
// streams deltas as pi events, and lets the authoritative message reconcile
// anything the partials missed. Shapes are deliberately structural: the SDK
// ships Beta variants with nullable fields that keep drifting.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	ToolCall,
	UserMessage,
	JsonObject,
} from "@earendil-works/pi-ai";
import type { PiAi } from "./host";
import { piToolName } from "./mcp";

/** pi tool-call arguments, assembled from JSON deltas. */
class ToolArgumentsStream {
	private text = "";

	append(delta: string): JsonObject {
		this.text += delta;
		try {
			const parsed = JSON.parse(this.text) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as JsonObject)
				: {};
		} catch {
			return {};
		}
	}

	finish(): { arguments?: JsonObject; argumentsError?: string } {
		try {
			const parsed = JSON.parse(this.text) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return { arguments: parsed as JsonObject };
			}
			return { argumentsError: `Tool call arguments were not a JSON object: ${this.text.slice(0, 500)}` };
		} catch (error) {
			return { argumentsError: `Tool call arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
}

/** Structural access to the pieces of SDK messages the accumulator consumes. */
interface AnthropicUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}

interface ContentBlockLike {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

export interface StreamEventLike {
	type: string;
	index?: number;
	message?: { usage?: AnthropicUsage | null };
	content_block?: ContentBlockLike | null;
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		partial_json?: string;
		signature?: string;
		stop_reason?: string | null;
	} | null;
	usage?: AnthropicUsage | null;
}

export interface AssistantMessageLike {
	content?: ContentBlockLike[];
	usage?: AnthropicUsage | null;
	stop_reason?: string | null;
}

export interface ResultMessageLike {
	subtype: string;
	is_error?: boolean;
	result?: string;
	usage?: AnthropicUsage | null;
	total_cost_usd?: number | null;
}

/** Text and image blocks for an Anthropic user message. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type UserContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

export function stableHash(value: unknown): string {
	return Bun.hash(JSON.stringify(value)).toString(36);
}

export function emptyAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** pi user content -> Anthropic content blocks (text and base64 images). */
export function sdkUserContent(content: UserMessage["content"]): UserContentBlock[] {
	const parts: (TextContent | ImageContent)[] =
		typeof content === "string" ? [{ type: "text", text: content }] : content;
	return parts.map((part) =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", source: { type: "base64", media_type: part.mimeType as ImageMediaType, data: part.data } },
	);
}

/** pi tool result -> MCP CallToolResult (MCP-shaped) + Anthropic blocks for the PostToolUse hook. */
export function toolResultToMcp(message: ToolResultMessage): { mcp: CallToolResult; replacement: UserContentBlock[] } {
	const mcpContent = message.content.map((part): CallToolResult["content"][number] =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
	const replacement = message.content.map((part): UserContentBlock =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", source: { type: "base64", media_type: part.mimeType as ImageMediaType, data: part.data } },
	);
	return { mcp: { content: mcpContent, isError: message.isError }, replacement };
}

function mapStopReason(raw: string | null | undefined): "stop" | "toolUse" | "length" {
	if (raw === "tool_use") return "toolUse";
	if (raw === "max_tokens") return "length";
	return "stop";
}

/** Turn a failed result message into an error; undefined when the result is fine. */
export function resultError(result: ResultMessageLike): Error | undefined {
	if (result.subtype === "success" && !result.is_error) return undefined;
	const detail = typeof result.result === "string" ? result.result.slice(0, 2000) : "";
	return new Error(`Claude Code turn failed (${result.subtype}): ${detail}`);
}

const RESTORE_PER_MESSAGE_LIMIT = 8000;
const RESTORE_TOTAL_LIMIT = 64000;

/**
 * Render the transcript as the first user message for a respawned Claude Code
 * process, so compaction, forks, and host restarts keep context without
 * replaying assistant turns (which the stream-json input cannot express).
 */
export function restoreMessage(messages: readonly Message[]): string {
	let budget = RESTORE_TOTAL_LIMIT;
	const lines: string[] = [];
	for (const message of messages) {
		if (budget <= 0) {
			lines.push("…[older messages truncated]");
			break;
		}
		let line: string;
		switch (message.role) {
			case "system":
				continue;
			case "user": {
				const text =
					typeof message.content === "string"
						? message.content
						: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
				line = `user: ${text}`;
				break;
			}
			case "assistant": {
				line = `assistant: ${message.content
					.map((part) =>
						part.type === "text"
							? part.text
							: part.type === "thinking"
								? "[thinking]"
								: `${part.name}(${JSON.stringify(part.arguments)})`,
					)
					.join("\n")}`;
				break;
			}
			case "toolResult": {
				line = `tool result for ${message.toolName}: ${message.content
					.map((part) => (part.type === "text" ? part.text : "[image]"))
					.join("\n")}`;
				break;
			}
		}
		const limit = Math.min(RESTORE_PER_MESSAGE_LIMIT, budget);
		const clipped = line.length > limit ? `${line.slice(0, limit)}…[truncated]` : line;
		budget -= clipped.length;
		lines.push(clipped);
	}
	return [
		"[pi-claude] The host restarted this conversation's Claude Code process.",
		"The dialogue so far, rendered by the host:",
		"",
		...lines,
		"",
		"Continue from here; the following messages are the current turn.",
	].join("\n");
}

interface OpenBlock {
	contentIndex: number;
	kind: "text" | "thinking" | "toolCall";
	args?: ToolArgumentsStream;
}

/**
 * Accumulates one Claude Code turn fragment into one pi AssistantMessage.
 * Streaming deltas flow through as pi events; the authoritative assistant
 * message closes open blocks and appends anything the partials missed.
 */
export class SdkToPiAccumulator {
	private readonly openBlocks = new Map<number, OpenBlock>();
	private messageBase = 0;
	private started = false;
	private stopHint: "stop" | "toolUse" | "length" = "stop";
	private hadUsage = false;

	constructor(
		private readonly ai: PiAi,
		private readonly stream: AssistantMessageEventStream,
		private readonly output: AssistantMessage,
		private readonly model: Model<Api>,
	) {}

	get hasToolCalls(): boolean {
		return this.output.content.some((part) => part.type === "toolCall");
	}

	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private addUsage(usage: AnthropicUsage | null | undefined): void {
		if (!usage) return;
		this.hadUsage = true;
		this.output.usage.input += usage.input_tokens ?? 0;
		this.output.usage.output += usage.output_tokens ?? 0;
		this.output.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
		this.output.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
		this.output.usage.totalTokens =
			this.output.usage.input + this.output.usage.output + this.output.usage.cacheRead + this.output.usage.cacheWrite;
	}

	onStreamEvent(event: StreamEventLike): void {
		switch (event.type) {
			case "message_start": {
				this.ensureStarted();
				this.messageBase = this.output.content.length;
				this.addUsage(event.message?.usage);
				break;
			}
			case "content_block_start": {
				this.ensureStarted();
				const block = event.content_block;
				const index = event.index ?? this.openBlocks.size;
				if (block?.type === "text") {
					this.output.content.push({ type: "text", text: "" });
					const at = this.output.content.length - 1;
					this.openBlocks.set(index, { contentIndex: at, kind: "text" });
					this.stream.push({ type: "text_start", contentIndex: at, partial: this.output });
				} else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
					this.output.content.push({ type: "thinking", thinking: "" });
					const at = this.output.content.length - 1;
					this.openBlocks.set(index, { contentIndex: at, kind: "thinking" });
					this.stream.push({ type: "thinking_start", contentIndex: at, partial: this.output });
				} else if (block?.type === "tool_use") {
					const pushed: AssistantMessage["content"][number] = {
						type: "toolCall",
						id: block.id ?? `toolu_${index}`,
						name: piToolName(block.name ?? ""),
						arguments: {},
					};
					if (pushed.type !== "toolCall") break;
					this.output.content.push(pushed);
					const at = this.output.content.length - 1;
					this.openBlocks.set(index, { contentIndex: at, kind: "toolCall", args: new ToolArgumentsStream() });
					this.stream.push({ type: "toolcall_start", contentIndex: at, partial: this.output });
				}
				break;
			}
			case "content_block_delta": {
				const open = this.openBlocks.get(event.index ?? -1);
				if (!open) break;
				const delta = event.delta;
				const block = this.output.content[open.contentIndex];
				if (!block || !delta) break;
				if (delta.type === "text_delta" && block.type === "text" && delta.text !== undefined) {
					block.text += delta.text;
					this.stream.push({ type: "text_delta", contentIndex: open.contentIndex, delta: delta.text, partial: this.output });
				} else if (delta.type === "thinking_delta" && block.type === "thinking" && delta.thinking !== undefined) {
					block.thinking += delta.thinking;
					this.stream.push({ type: "thinking_delta", contentIndex: open.contentIndex, delta: delta.thinking, partial: this.output });
				} else if (delta.type === "input_json_delta" && block.type === "toolCall" && open.args && delta.partial_json) {
					block.arguments = open.args.append(delta.partial_json);
					this.stream.push({ type: "toolcall_delta", contentIndex: open.contentIndex, delta: delta.partial_json, partial: this.output });
				} else if (delta.type === "signature_delta" && block.type === "thinking" && delta.signature) {
					block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
				}
				break;
			}
			case "content_block_stop": {
				const open = this.openBlocks.get(event.index ?? -1);
				if (!open) break;
				this.openBlocks.delete(event.index ?? -1);
				this.closeBlock(open);
				break;
			}
			case "message_delta": {
				if (event.delta?.stop_reason) this.stopHint = mapStopReason(event.delta.stop_reason);
				this.addUsage(event.usage);
				break;
			}
			default:
				break;
		}
	}

	private closeBlock(open: OpenBlock): void {
		const block = this.output.content[open.contentIndex];
		if (!block) return;
		if (block.type === "text") {
			this.stream.push({ type: "text_end", contentIndex: open.contentIndex, content: block.text, partial: this.output });
		} else if (block.type === "thinking") {
			this.stream.push({ type: "thinking_end", contentIndex: open.contentIndex, content: block.thinking, partial: this.output });
		} else if (block.type === "toolCall" && open.args) {
			const finished = open.args.finish();
			if (finished.arguments) block.arguments = finished.arguments;
			if (finished.argumentsError) block.argumentsError = finished.argumentsError;
			this.stream.push({ type: "toolcall_end", contentIndex: open.contentIndex, toolCall: block, partial: this.output });
		}
	}

	/** Authoritative message: close partials, reconcile, append missed blocks. */
	onAssistant(message: AssistantMessageLike): void {
		this.ensureStarted();
		if (message.stop_reason) this.stopHint = mapStopReason(message.stop_reason);
		for (const [index, open] of [...this.openBlocks]) {
			this.openBlocks.delete(index);
			this.closeBlock(open);
		}
		const blocks = message.content ?? [];
		const emitted = this.output.content.length - this.messageBase;
		// Reconcile already-emitted tool calls with authoritative inputs.
		for (let i = 0; i < Math.min(emitted, blocks.length); i++) {
			const authoritative = blocks[i];
			const target = this.output.content[this.messageBase + i];
			if (
				authoritative?.type === "tool_use" &&
				target?.type === "toolCall" &&
				target.argumentsError &&
				authoritative.input &&
				typeof authoritative.input === "object" &&
				!Array.isArray(authoritative.input)
			) {
				target.arguments = authoritative.input as typeof target.arguments;
				target.argumentsError = undefined;
			}
		}
		// Append blocks the partial stream never delivered.
		for (let i = emitted; i < blocks.length; i++) {
			const block = blocks[i];
			if (!block) continue;
			if (block.type === "text") {
				this.output.content.push({ type: "text", text: block.text ?? "" });
				const at = this.output.content.length - 1;
				this.stream.push({ type: "text_start", contentIndex: at, partial: this.output });
				this.stream.push({ type: "text_end", contentIndex: at, content: block.text ?? "", partial: this.output });
			} else if (block.type === "thinking") {
				this.output.content.push({ type: "thinking", thinking: block.thinking ?? "" });
				const at = this.output.content.length - 1;
				this.stream.push({ type: "thinking_start", contentIndex: at, partial: this.output });
				this.stream.push({ type: "thinking_end", contentIndex: at, content: block.thinking ?? "", partial: this.output });
			} else if (block.type === "tool_use") {
				const input =
					block.input && typeof block.input === "object" && !Array.isArray(block.input)
						? (block.input as ToolCall["arguments"])
						: {};
				const pushed: ToolCall = {
					type: "toolCall",
					id: block.id ?? `toolu_${i}`,
					name: piToolName(block.name ?? ""),
					arguments: input,
				};
				if (pushed.type !== "toolCall") continue;
				this.output.content.push(pushed);
				const at = this.output.content.length - 1;
				this.stream.push({ type: "toolcall_start", contentIndex: at, partial: this.output });
				this.stream.push({ type: "toolcall_end", contentIndex: at, toolCall: pushed, partial: this.output });
			}
		}
		this.messageBase = this.output.content.length;
		if (!this.hadUsage) this.addUsage(message.usage);
	}

	/** Turn finished: settle usage/cost and produce the pi stop reason. */
	finish(result: ResultMessageLike): "stop" | "length" | "toolUse" {
		if (!this.hadUsage) this.addUsage(result.usage);
		// Turns ride the Claude Code subscription; report the provider-billed
		// total when Claude Code reports one, zero otherwise.
		this.output.usage.cost.total =
			typeof result.total_cost_usd === "number" && result.total_cost_usd > 0 ? result.total_cost_usd : 0;

		if (this.hasToolCalls) return "toolUse";
		return this.stopHint === "length" ? "length" : "stop";
	}
}
