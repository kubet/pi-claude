import { query } from "@anthropic-ai/claude-agent-sdk";
async function* prompt() {
	yield { type: "user", message: { role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }, parent_tool_use_id: null };
	// hold the generator open like the bridge does
	await new Promise(() => {});
}
const options = {
	cwd: process.cwd(),
	effort: "medium",
	env: { ...process.env, CLAUDE_CODE_SIMPLE: undefined, CLAUDE_CODE_EFFORT_LEVEL: undefined, MCP_TOOL_TIMEOUT: undefined },
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
	sessionId: crypto.randomUUID(),
	systemPrompt: "You are pi, a coding agent. Be terse.",
};
const q = query({ prompt: prompt(), options });
for await (const m of q) {
	if (m.type === "assistant") console.log("assistant:", m.message.content?.map((b) => b.type).join(","));
	if (m.type === "result") { console.log("result:", m.subtype, m.is_error ? "ERROR" : "ok", String(m.result).slice(0, 140)); break; }
}
