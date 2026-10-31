// Throwaway SDK option bisector. Delete after use.
import { query } from "@anthropic-ai/claude-agent-sdk";

const variants: Array<[string, Record<string, unknown>]> = [
	["bare", {}],
	["effort", { effort: "medium" }],
	["thinking", { thinking: { type: "adaptive", display: "summarized" } }],
	["isolation-env", { env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", DISABLE_AUTO_COMPACT: "1", ENABLE_TOOL_SEARCH: "false", MAX_MCP_OUTPUT_TOKENS: "200000" } }],
	["full", {
		cwd: process.cwd(),
		effort: "medium",
		env: { ...process.env },
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
	}],
	["full+undefined-env", {
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
	}],
	["full+model", {
		cwd: process.cwd(),
		model: "sonnet",
		effort: "medium",
		env: { ...process.env },
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
	}],
];

const which = Number(process.argv[2] ?? 0);
const [name, options] = variants[which] as [string, Record<string, unknown>];
console.log(`--- variant ${which}: ${name}`);
const q = query({ prompt: "Reply with exactly: ok", options: options as never });
for await (const message of q) {
	if (message.type === "assistant") console.log("assistant:", message.message.content?.map((b) => b.type).join(","));
	if (message.type === "result") {
		console.log("result:", message.subtype, message.is_error ? "ERROR" : "ok", String(message.result).slice(0, 120));
		break;
	}
}
