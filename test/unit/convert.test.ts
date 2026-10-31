// Unit tests for SDK-to-pi conversion. Pure functions plus the event
// accumulator, driven with structural SDK message fixtures.

import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { staticModels, PROVIDER_ID, BASE_URL, effortFor } from "../../src/catalog";
import {
	SdkToPiAccumulator,
	sdkUserContent,
	toolResultToMcp,
	resultError,
	restoreMessage,
} from "../../src/convert";
import * as piAiModule from "@earendil-works/pi-ai";
import type { PiAi } from "../../src/extension-core";

const ai: PiAi = piAiModule;
const model: Model<"claude-code"> = {
	id: "default",
	name: "test",
	api: "claude-code",
	provider: PROVIDER_ID,
	baseUrl: BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const emptyUsage = (): AssistantMessage["usage"] => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function newAccumulator(toolNames?: ReadonlySet<string>) {
	const stream = ai.createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "claude-code",
		provider: PROVIDER_ID,
		model: "default",
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	return { stream, accumulator: new SdkToPiAccumulator(ai, stream, output, model, toolNames), output };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("catalog", () => {
	test("static models describe claude aliases with zero cost", () => {
		const models = staticModels();
		expect(models.map((m) => m.id)).toEqual(["default", "sonnet", "opus", "haiku"]);
		for (const m of models) {
			expect(m.provider).toBe(PROVIDER_ID);
			expect(m.reasoning).toBe(true);
		}
	});

	test("effort mapping covers pi thinking levels", () => {
		expect(effortFor(undefined)).toBeUndefined();
		expect(effortFor("minimal")).toBe("low");
		expect(effortFor("medium")).toBe("medium");
		expect(effortFor("high")).toBe("high");
		expect(effortFor("xhigh")).toBe("xhigh");
		expect(effortFor("max")).toBe("max");
	});
});

describe("sdkUserContent", () => {
	test("string content becomes a text block", () => {
		expect(sdkUserContent("hi")).toEqual([{ type: "text", text: "hi" }]);
	});

	test("mixed content keeps order and maps images", () => {
		const blocks = sdkUserContent([
			{ type: "text", text: "look" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		expect(blocks[0]).toEqual({ type: "text", text: "look" });
		expect(blocks[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "AAAA" },
		});
	});
});

describe("toolResultToMcp", () => {
	test("text results map to MCP text blocks and anthropic replacement", () => {
		const { mcp, replacement } = toolResultToMcp({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 0,
		});
		expect(mcp).toEqual({ content: [{ type: "text", text: "file body" }], isError: false });
		expect(replacement).toEqual([{ type: "text", text: "file body" }]);
	});

	test("image results map to MCP image blocks with mimeType", () => {
		const { mcp, replacement } = toolResultToMcp({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			isError: true,
			timestamp: 0,
		});
		expect(mcp.isError).toBe(true);
		expect(mcp.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		expect(replacement[0]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "AAAA" },
		});
	});
});

describe("resultError", () => {
	test("success is not an error", () => {
		expect(resultError({ subtype: "success", is_error: false })).toBeUndefined();
	});

	test("error_max_turns becomes an error with detail", () => {
		const error = resultError({ subtype: "error_max_turns", is_error: true, result: "gave up" });
		expect(error?.message).toContain("error_max_turns");
		expect(error?.message).toContain("gave up");
	});
});

describe("restoreMessage", () => {
	test("renders dialogue without system messages", () => {
		const rendered = restoreMessage([
			{ role: "system", content: "sys", toolsAdded: [], timestamp: 0 },
			{ role: "user", content: "do it", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } }],
				api: "claude-code",
				provider: PROVIDER_ID,
				model: "default",
				usage: emptyUsage(),
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false, timestamp: 3 },
		]);
		expect(rendered).toContain("user: do it");
		expect(rendered).toContain("bash(");
		expect(rendered).toContain("tool result for bash: a b");
		expect(rendered).not.toContain("sys");
	});

	test("truncates long content within budget", () => {
		const long = "x".repeat(200_000);
		const rendered = restoreMessage([{ role: "user", content: long, timestamp: 0 }]);
		expect(rendered.length).toBeLessThan(70_000);
		expect(rendered).toContain("…[truncated]");
	});
});

describe("SdkToPiAccumulator", () => {
	test("streams text deltas and finishes with stop", async () => {
		const { stream, accumulator } = newAccumulator();
		const events = collect(stream);
		accumulator.onStreamEvent({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } });
		accumulator.onStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		accumulator.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } });
		accumulator.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } });
		accumulator.onStreamEvent({ type: "content_block_stop", index: 0 });
		accumulator.onAssistant({ content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } });
		const reason = accumulator.finish({ subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 2 } });
		expect(reason).toBe("stop");
		stream.end();
		const collected = await events;
		expect(collected.map((e) => e.type)).toEqual([
			"start", "text_start", "text_delta", "text_delta", "text_end",
		]);
	});

	test("tool_use blocks become pi tool calls with unprefixed names", async () => {
		const { stream, accumulator } = newAccumulator();
		const events = collect(stream);
		accumulator.onStreamEvent({ type: "message_start", message: { usage: { input_tokens: 5 } } });
		accumulator.onStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t9", name: "mcp__pi__read" } });
		accumulator.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"' } });
		accumulator.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "}" } });
		accumulator.onStreamEvent({ type: "content_block_stop", index: 0 });
		expect(accumulator.hasToolCalls).toBe(true);
		expect(accumulator.finish({ subtype: "success", is_error: false })).toBe("toolUse");
		stream.end();
		const collected = await events;
		const end = collected.find((e) => e.type === "toolcall_end");
		expect(end && end.type === "toolcall_end" ? end.toolCall.name : "").toBe("read");
		expect(end && end.type === "toolcall_end" ? end.toolCall.id : "").toBe("t9");
		expect(end && end.type === "toolcall_end" ? end.toolCall.arguments : null).toEqual({ path: "a.txt" });
	});

	test("assistant-only delivery appends missed blocks", async () => {
		const { stream, accumulator } = newAccumulator();
		const events = collect(stream);
		accumulator.onAssistant({
			content: [
				{ type: "text", text: "direct" },
				{ type: "tool_use", id: "t2", name: "write", input: { path: "x", content: "y" } },
			],
			stop_reason: "tool_use",
		});
		expect(accumulator.finish({ subtype: "success", is_error: false })).toBe("toolUse");
		stream.end();
		const collected = await events;
		const textEnd = collected.find((e) => e.type === "text_end");
		const toolEnd = collected.find((e) => e.type === "toolcall_end");
		expect(textEnd && textEnd.type === "text_end" ? textEnd.content : "").toBe("direct");
		expect(toolEnd && toolEnd.type === "toolcall_end" ? toolEnd.toolCall.arguments : null).toEqual({ path: "x", content: "y" });
	});

	test("thinking blocks stream and end with content", async () => {
		const { stream, accumulator } = newAccumulator();
		const events = collect(stream);
		accumulator.onStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
		accumulator.onStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
		accumulator.onStreamEvent({ type: "content_block_stop", index: 0 });
		stream.end();
		const collected = await events;
		const end = collected.find((e) => e.type === "thinking_end");
		expect(end && end.type === "thinking_end" ? end.content : "").toBe("hmm");
	});

	test("usage reports last-call occupancy with summed output (opencode semantics)", () => {
		const { accumulator, output } = newAccumulator();
		// First API call: context occupancy 3/5/6, 4 output tokens.
		accumulator.onStreamEvent({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } } });
		// Second API call in the same turn: bigger context, 20 more output tokens.
		accumulator.onStreamEvent({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 7 } } } });
		accumulator.finish({ subtype: "success", is_error: false });
		expect(output.usage.input).toBe(100);
		expect(output.usage.cacheRead).toBe(50);
		expect(output.usage.cacheWrite).toBe(0);
		expect(output.usage.output).toBe(24);
		expect(output.usage.reasoning).toBe(7);
		expect(output.usage.totalTokens).toBe(100 + 50 + 0 + 24);
	});

	test("calls to tools pi did not offer are not emitted as tool calls", async () => {
		const { stream, accumulator } = newAccumulator(new Set(["read"]));
		const events = collect(stream);
		accumulator.onStreamEvent({ type: "message_start", message: { usage: { input_tokens: 1 } } });
		accumulator.onStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__pi__WebSearch" } });
		accumulator.onStreamEvent({ type: "content_block_stop", index: 0 });
		accumulator.onStreamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "mcp__pi__read" } });
		accumulator.onStreamEvent({ type: "content_block_stop", index: 1 });
		accumulator.finish({ subtype: "success", is_error: false });
		stream.end();
		const collected = await events;
		const toolEnds = collected.filter((e) => e.type === "toolcall_end");
		expect(toolEnds.length).toBe(1);
		const end = toolEnds[0];
		expect(end && end.type === "toolcall_end" ? end.toolCall.name : "").toBe("read");
	});

	test("offered filter also applies to authoritative assistant-only delivery", async () => {
		const { stream, accumulator } = newAccumulator(new Set(["read"]));
		const events = collect(stream);
		accumulator.onAssistant({
			content: [
				{ type: "tool_use", id: "t1", name: "mcp__pi__Write", input: {} },
				{ type: "text", text: "kept" },
			],
			stop_reason: "tool_use",
		});
		stream.end();
		const collected = await events;
		expect(collected.filter((e) => e.type === "toolcall_end").length).toBe(0);
		expect(collected.some((e) => e.type === "text_end")).toBe(true);
	});
});
