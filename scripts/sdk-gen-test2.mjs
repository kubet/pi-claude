import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
async function* prompt() {
	yield { type: "user", message: { role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }, parent_tool_use_id: null };
	await new Promise(() => {});
}
const quiet = async () => ({});
const options = {
	cwd: process.cwd(),
	effort: "medium",
	model: "sonnet",
	systemPrompt: "You are pi, a coding agent. Be terse.",
	env: {
		...process.env,
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
		CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
	},
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
	hooks: { PreToolUse: [{ hooks: [quiet] }], PostToolUse: [{ hooks: [quiet] }] },
	mcpServers: {},
	sessionId: randomUUID(),
	pathToClaudeCodeExecutable: process.env.HOME + "/.local/bin/claude",
};
const q = query({ prompt: prompt(), options });
for await (const m of q) {
	if (m.type === "result") { console.log("result:", m.subtype, m.is_error ? "ERROR" : "ok", String(m.result).slice(0, 140)); break; }
}
