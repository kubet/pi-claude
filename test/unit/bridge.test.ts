// Bridge orchestration tests driven by a scripted query factory: turn
// boundaries, parked tool resolution across streamSimple calls, prefix-based
// bridge reuse, restore-on-divergence, and abort handling.

import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
	AssistantMessageEventStream,
	Message,
	ToolResultMessage,
	TranscriptContext,
	UserMessage,
} from "@earendil-works/pi-ai";
import { BridgeManager, bridgeKey, type QueryLike, type SpawnQuery } from "../../src/bridge";
import { PROVIDER_ID, staticModels } from "../../src/catalog";
import { piAi, type PiAi } from "../../src/host";

const ai: PiAi = await piAi();
const model = staticModels()[0] as ReturnType<typeof staticModels>[0];

/** Scripted SDK query: the test emits messages; the bridge reads them. */
class FakeQuery implements QueryLike {
	interruptCount = 0;
	options: Options | undefined;
	received: SDKUserMessage[] = [];
	private readonly receivedWaiters: Array<() => void> = [];
	private readonly waiting: Array<(result: IteratorResult<SDKMessage>) => void> = [];
	private readonly buffered: SDKMessage[] = [];

	constructor(prompt: AsyncGenerator<SDKUserMessage>) {
		void this.consumePrompt(prompt);
	}

	private async consumePrompt(prompt: AsyncGenerator<SDKUserMessage>): Promise<void> {
		try {
			for await (const message of prompt) {
				this.received.push(message);
				for (const waiter of this.receivedWaiters.splice(0)) waiter();
			}
		} catch {
			// prompt generator ended or was killed
		}
	}

	/** Deterministic handshake: resolves once at least n user messages arrived. */
	async waitForUserMessages(n: number): Promise<void> {
		while (this.received.length < n) {
			const gate = Promise.withResolvers<void>();
			this.receivedWaiters.push(gate.resolve);
			await gate.promise;
		}
	}

	emit(message: SDKMessage): void {
		const reader = this.waiting.shift();
		if (reader) reader({ value: message, done: false });
		else this.buffered.push(message);
	}

	interrupt(): void {
		this.interruptCount += 1;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		for (;;) {
			while (this.buffered.length > 0) yield this.buffered.shift() as SDKMessage;
			const gate = Promise.withResolvers<IteratorResult<SDKMessage>>();
			this.waiting.push(gate.resolve);
			const message = await gate.promise;
			if (message.done) return;
			yield message.value;
		}
	}
}

function makeSpawn(captured: FakeQuery[]): SpawnQuery {
	return (options: Options, prompt: AsyncGenerator<SDKUserMessage>) => {
		const fake = new FakeQuery(prompt);
		fake.options = options;
		captured.push(fake);
		return fake;
	};
}

// Fixture builders: minimal structurally-valid SDK messages.
function textStreamEvents(text: string, index = 0): SDKMessage[] {
	return [
		{ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } },
		{ type: "stream_event", event: { type: "content_block_stop", index } },
	] as unknown as SDKMessage[];
}

function assistantMessage(content: Array<Record<string, unknown>>, stopReason = "end_turn"): SDKMessage {
	return { type: "assistant", message: { role: "assistant", content, stop_reason: stopReason, usage: null } } as unknown as SDKMessage;
}

function resultMessage(extra: Record<string, unknown> = {}): SDKMessage {
	return { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 7, output_tokens: 3 }, ...extra } as unknown as SDKMessage;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function toolResult(id: string, name: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

function asTranscript(messages: Message[]): TranscriptContext {
	return { messages } as TranscriptContext;
}

const SYSTEM = "You are pi.";
const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

interface TurnHandle {
	stream: AssistantMessageEventStream;
	events: Promise<AssistantMessageEventStream extends never ? never : unknown[]>;
	turn: Promise<void>;
}

async function collect(stream: AssistantMessageEventStream): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function startTurn(bridge: ReturnType<BridgeManager["acquire"]>["bridge"], messages: Message[], newUsers: readonly UserMessage[], signal?: AbortSignal): TurnHandle {
	const stream = ai.createAssistantMessageEventStream();
	const turn = bridge.turn({ ai, stream, model, messages, newUserMessages: newUsers, signal });
	return { stream, events: collect(stream), turn };
}

const lastEvent = (events: unknown[]) => events.at(-1) as { type: string; reason?: string; message?: { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } } };

describe("BridgeManager", () => {
	test("plain turn: user message forwarded, text streamed, result ends with stop", async () => {
		const captured: FakeQuery[] = [];
		const manager = new BridgeManager(ai, makeSpawn(captured));
		const users = [userMessage("hello")];
		const messages: Message[] = [{ role: "system", content: SYSTEM, timestamp: 0 }, ...users];
		const acquired = manager.acquire({
			key: bridgeKey("default", undefined, SYSTEM, TOOLS),
			systemPrompt: SYSTEM,
			tools: TOOLS,
			transcript: asTranscript(messages),
			userMessages: users,
			model,
			cwd: process.cwd(),
		});
		const handle = startTurn(acquired.bridge, messages, acquired.newUserMessages);
		const fake = captured[0] as FakeQuery;
		await fake.waitForUserMessages(1);
		for (const message of textStreamEvents("hi there")) fake.emit(message);
		fake.emit(assistantMessage([{ type: "text", text: "hi there" }]));
		fake.emit(resultMessage());
		await handle.turn;
		const events = await handle.events;
		expect(fake.received.map((m) => m.message)).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
		expect(fake.options?.systemPrompt).toContain(SYSTEM);
		expect(fake.options?.systemPrompt).toContain("mcp__pi__");
		expect(fake.options?.allowedTools).toEqual(["mcp__pi__*"]);
		const last = lastEvent(events);
		expect(last.type).toBe("done");
		expect(last.reason).toBe("stop");
	});

	test("tool turn parks the MCP call, the next turn resolves it from the transcript", async () => {
		const captured: FakeQuery[] = [];
		const manager = new BridgeManager(ai, makeSpawn(captured));
		const users = [userMessage("read a.txt")];
		const system = { role: "system", content: SYSTEM, timestamp: 0 } as Message;
		const acquired = manager.acquire({
			key: bridgeKey("default", undefined, SYSTEM, TOOLS),
			systemPrompt: SYSTEM,
			tools: TOOLS,
			transcript: asTranscript([system, ...users]),
			userMessages: users,
			model,
			cwd: process.cwd(),
		});
		const fake = captured[0] as FakeQuery;
		const first = startTurn(acquired.bridge, [system, ...users], acquired.newUserMessages);
		await fake.waitForUserMessages(1);
		fake.emit(assistantMessage([
			{ type: "tool_use", id: "t1", name: "mcp__pi__read", input: { path: "a.txt" } },
		], "tool_use"));
		await first.turn;
		expect(lastEvent(await first.events).reason).toBe("toolUse");

		// Claude Code asks for the tool: PreToolUse pairs the id, tools/call parks.
		const hooks = fake.options?.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<object>> }> };
		await hooks.PreToolUse[0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "mcp__pi__read" });
		const mcpCall = acquired.bridge.pending.call("read");

		// pi executed the tool; the next streamSimple carries the toolResult.
		const assistantReply = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } }],
			api: "claude-code",
			provider: PROVIDER_ID,
			model: "default",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as Message;
		const secondMessages: Message[] = [system, ...users, assistantReply, toolResult("t1", "read", "file body")];
		const second = manager.acquire({
			key: bridgeKey("default", undefined, SYSTEM, TOOLS),
			systemPrompt: SYSTEM,
			tools: TOOLS,
			transcript: asTranscript(secondMessages),
			userMessages: users,
			model,
			cwd: process.cwd(),
		});
		expect(second.bridge).toBe(acquired.bridge);
		expect(second.newUserMessages).toEqual([]);
		const secondHandle = startTurn(second.bridge, secondMessages, []);
		const resolved = await mcpCall;
		expect(resolved).toEqual({ content: [{ type: "text", text: "file body" }], isError: false });
		for (const message of textStreamEvents("done reading")) fake.emit(message);
		fake.emit(assistantMessage([{ type: "text", text: "done reading" }]));
		fake.emit(resultMessage());
		await secondHandle.turn;
		expect(lastEvent(await secondHandle.events).reason).toBe("stop");
	});

	test("divergent history respawns with a restore message", async () => {
		const captured: FakeQuery[] = [];
		const manager = new BridgeManager(ai, makeSpawn(captured));
		const key = bridgeKey("default", undefined, SYSTEM, TOOLS);
		const users1 = [userMessage("first")];
		const system = { role: "system", content: SYSTEM, timestamp: 0 } as Message;
		manager.acquire({
			key,
			systemPrompt: SYSTEM,
			tools: TOOLS,
			transcript: asTranscript([system, ...users1]),
			userMessages: users1,
			model,
			cwd: process.cwd(),
		});
		expect(captured.length).toBe(1);

	// Same key but the user history itself was rewritten (branch): no prefix match.
	const edited = userMessage("edited first");
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "old answer" }],
			api: "claude-code",
			provider: PROVIDER_ID,
			model: "default",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as Message;
		const second = manager.acquire({
			key,
			systemPrompt: SYSTEM,
			tools: TOOLS,
			transcript: asTranscript([system, edited, assistant]),
			userMessages: [edited],
			model,
			cwd: process.cwd(),
		});
		expect(captured.length).toBe(2);
		const fake2 = captured[1] as FakeQuery;
		await fake2.waitForUserMessages(2);
		const restore = fake2.received[0] as { message: { content: Array<{ text?: string }> } };
		expect(restore.message.content[0]?.text).toContain("[pi-claude]");
		expect(restore.message.content[0]?.text).toContain("edited first");
		const current = fake2.received[1] as { message: { content: Array<{ text?: string }> } };
		expect(current.message.content[0]?.text).toBe("edited first");
		expect(second.newUserMessages).toEqual([]);
	});

	test("abort interrupts the query, clears parked calls, and errors the stream", async () => {
		const captured: FakeQuery[] = [];
		const manager = new BridgeManager(ai, makeSpawn(captured));
		const users = [userMessage("long work")];
		const acquired = manager.acquire({
			key: bridgeKey("default", undefined, SYSTEM, []),
			systemPrompt: SYSTEM,
			tools: [],
			transcript: asTranscript([{ role: "system", content: SYSTEM, timestamp: 0 }, ...users]),
			userMessages: users,
			model,
			cwd: process.cwd(),
		});
		const fake = captured[0] as FakeQuery;
		const controller = new AbortController();
		const handle = startTurn(
			acquired.bridge,
			[{ role: "system", content: SYSTEM, timestamp: 0 }, ...users],
			acquired.newUserMessages,
			controller.signal,
		);
		await fake.waitForUserMessages(1);
		controller.abort();
		await handle.turn;
		const events = await handle.events;
		expect(fake.interruptCount).toBe(1);
		const last = lastEvent(events);
		expect(last.type).toBe("error");
		expect(last.reason).toBe("aborted");
	});

	test("usage from the result lands on the final message", async () => {
		const captured: FakeQuery[] = [];
		const manager = new BridgeManager(ai, makeSpawn(captured));
		const users = [userMessage("count")];
		const messages: Message[] = [{ role: "system", content: SYSTEM, timestamp: 0 }, ...users];
		const acquired = manager.acquire({
			key: bridgeKey("default", undefined, SYSTEM, []),
			systemPrompt: SYSTEM,
			tools: [],
			transcript: asTranscript(messages),
			userMessages: users,
			model,
			cwd: process.cwd(),
		});
		const fake = captured[0] as FakeQuery;
		const handle = startTurn(acquired.bridge, messages, acquired.newUserMessages);
		await fake.waitForUserMessages(1);
		fake.emit(assistantMessage([{ type: "text", text: "1 2 3" }]));
		fake.emit(resultMessage());
		await handle.turn;
		const last = lastEvent(await handle.events);
		expect(last.message?.usage?.input).toBe(7);
		expect(last.message?.usage?.output).toBe(3);
		expect(last.message?.usage?.totalTokens).toBe(10);
	});
});
