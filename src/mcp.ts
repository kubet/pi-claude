// The in-process MCP server that exposes pi's tools to Claude Code.
//
// Claude Code gets its own tools disabled and calls pi's tools through this
// server instead, so pi keeps executing everything: permissions, session log,
// extension tool_call events. Claude Code addresses the tools as
// `mcp__pi__<name>`; the pi name is the suffix.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@earendil-works/pi-ai";
import type { PendingTools } from "./pending";

export const MCP_SERVER_NAME = "pi";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** `mcp__pi__read` -> `read`. Unknown shapes pass through unchanged. */
export function piToolName(claudeName: string): string {
	return claudeName.startsWith(MCP_TOOL_PREFIX) ? claudeName.slice(MCP_TOOL_PREFIX.length) : claudeName;
}

export function makeToolServer(tools: readonly Tool[], pending: PendingTools): McpSdkServerConfigWithInstance {
	const server = new Server({ name: MCP_SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
	const known = new Set(tools.map((tool) => tool.name));
	const definitions = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
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
