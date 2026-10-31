// Parked tool calls: the seam between Claude Code's MCP tool calls and pi's
// agent loop.
//
// Claude Code invokes a pi tool through the in-process MCP server; the call
// arrives without the tool_use id, so the PreToolUse hook stamps the id first
// (`before`). The call then parks (`call`) until pi executed the tool and the
// next streamSimple() call resolves it by toolCallId (`resolve`). The
// PostToolUse hook swaps the recorded MCP output for the full content blocks
// (`after`), keeping Claude Code's transcript faithful.
//
// Port of opencode's claude-agent PendingTools, adapted to pi's loop boundary.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ParkedResult {
	/** Result returned to Claude Code over MCP. */
	readonly mcp: CallToolResult;
	/** Full content blocks written into Claude Code's transcript by the PostToolUse hook. */
	readonly replacement: unknown[] | undefined;
}

interface Call {
	readonly name: string;
	readonly result: PromiseWithResolvers<ParkedResult>;
}

export class PendingTools {
	private readonly calls = new Map<string, Call>();
	private readonly replacements = new Map<string, unknown[]>();
	private next: string | undefined;

	private expect(id: string, name: string): Call {
		const saved = this.calls.get(id);
		const call = saved ?? { name, result: Promise.withResolvers<ParkedResult>() };
		if (!saved) this.calls.set(id, call);
		if (call.name !== name) throw new Error(`Mismatched Claude tool call ${id}: ${call.name} vs ${name}`);
		return call;
	}

	/** PreToolUse hook: remember the tool_use id that the next MCP call belongs to. */
	before(id: string, name: string): void {
		this.expect(id, name);
		this.next = id;
	}

	/** Optional: synchronously satisfy a call the moment it parks (result already in the host transcript). */
	onPark?: (id: string) => ParkedResult | undefined;


	/** MCP tools/call: park until pi's tool result arrives. */
	async call(name: string): Promise<CallToolResult> {
		const id = this.next;
		this.next = undefined;
		if (!id) throw new Error(`Claude Code invoked pi tool "${name}" without a preceding PreToolUse id`);
		const call = this.expect(id, name);
		const result = this.onPark?.(id) ?? (await call.result.promise);
		this.calls.delete(id);
		return result.mcp;
	}

	/** pi produced a tool result for a parked call. Throws when nothing waits for it. */
	resolve(id: string, result: ParkedResult): void {
		const call = this.calls.get(id);
		if (!call) throw new Error(`No waiting Claude Code tool call ${id}`);
		call.result.resolve(result);
	}

	resolveIfWaiting(id: string, result: ParkedResult): boolean {
		if (!this.calls.has(id)) return false;
		this.resolve(id, result);
		return true;
	}

	/** PostToolUse hook: full content blocks for Claude Code's transcript. */
	after(id: string): unknown[] | undefined {
		const replacement = this.replacements.get(id);
		this.replacements.delete(id);
		return replacement;
	}

	has(id: string): boolean {
		return this.calls.has(id);
	}

	/** After an interrupt: unblock every parked call so nothing dangles. */
	clear(): void {
		for (const call of this.calls.values()) {
			call.result.resolve({
				mcp: { isError: true, content: [{ type: "text", text: "Cancelled." }] },
				replacement: undefined,
			});
		}
		this.calls.clear();
		this.replacements.clear();
		this.next = undefined;
	}
}
