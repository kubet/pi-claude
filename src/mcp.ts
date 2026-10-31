// The in-process MCP server that exposes pi's tools to Claude Code.
//
// Claude Code gets its own tools disabled and calls pi's tools through this
// server instead, so pi keeps executing everything: permissions, session log,
// extension tool_call events. Claude Code addresses the tools as
// `mcp__pi__<name>`; the pi name is the suffix — unless the pi name breaks
// Claude Code's tool-name limits (64 chars, [a-zA-Z0-9_-]), in which case it
// is sanitized with a stable hash suffix and mapped back through a registry.

import { createHash } from "node:crypto";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";
import type { PendingTools } from "./pending";

export const MCP_SERVER_NAME = "pi";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** Claude Code caps tool names at 64 chars over [a-zA-Z0-9_-] (opencode parity). */
const CLAUDE_NAME_LIMIT = 64;
const DESCRIPTION_LIMIT = 2048;

const piNameByClaudeName = new Map<string, string>();

/** The name Claude Code sees for a pi tool; registers the mapping. */
export function claudeToolName(piName: string): string {
	const cleaned = piName.replace(/[^a-zA-Z0-9_-]/g, "_");
	const budget = CLAUDE_NAME_LIMIT - MCP_TOOL_PREFIX.length;
	if (cleaned === piName && cleaned.length <= budget) {
		piNameByClaudeName.set(`${MCP_TOOL_PREFIX}${piName}`, piName);
		return piName;
	}
	const hash = createHash("sha256").update(piName).digest("base64url").slice(0, 8);
	const short = `${cleaned.slice(0, budget - hash.length - 1)}-${hash}`;
	piNameByClaudeName.set(`${MCP_TOOL_PREFIX}${short}`, piName);
	return short;
}

/** `mcp__pi__read` -> `read`, resolving sanitized names back to their pi originals. */
export function piToolName(claudeName: string): string {
	const registered = piNameByClaudeName.get(claudeName);
	if (registered !== undefined) return registered;
	return claudeName.startsWith(MCP_TOOL_PREFIX) ? claudeName.slice(MCP_TOOL_PREFIX.length) : claudeName;
}

export function makeToolServer(tools: readonly Tool[], pending: PendingTools): McpSdkServerConfigWithInstance {
	const server = new Server({ name: MCP_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
	const known = new Set(tools.map((tool) => tool.name));
	const definitions = tools.map((tool) => ({
		name: claudeToolName(tool.name),
		description:
			tool.description.length > DESCRIPTION_LIMIT
				? `${tool.description.slice(0, DESCRIPTION_LIMIT - 1)}…`
				: tool.description,
		// pi tool parameters are typebox schemas, which are JSON Schema objects.
		inputSchema: tool.parameters as never,
		// Claude Code serializes non-read-only tools; handlers take the id from the PreToolUse hook.
		annotations: { readOnlyHint: false },
		_meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 500_000 },
	}));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = piToolName(request.params.name);
		if (!known.has(name)) {
			throw new Error(`Claude Code called an unregistered pi tool: ${request.params.name}`);
		}
		return pending.call(name);
	});

	// The SDK's instance type names the higher-level McpServer; the low-level Server speaks the same protocol.
	return { type: "sdk", name: MCP_SERVER_NAME, instance: server as unknown as McpSdkServerConfigWithInstance["instance"] };
}
