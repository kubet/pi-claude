import { query } from "@anthropic-ai/claude-agent-sdk";
const q = query({ prompt: "Reply with exactly: ok", options: {} });
for await (const m of q) {
	if (m.type === "result") { console.log("result:", m.subtype, m.is_error ? "ERROR" : "ok", String(m.result).slice(0, 140)); break; }
}
