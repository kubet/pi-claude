// Unit tests for the system-prompt composition the bridge applies before
// handing pi's prompt to Claude Code.

import { describe, expect, test } from "bun:test";
import { claudeSystemPrompt } from "../../src/bridge";

const PI_PROMPT = [
	"You are an expert coding assistant operating inside pi.",
	"",
	"<tools>",
	"- read: Read file contents",
	"- bash: Execute bash commands",
	"</tools>",
	"",
	"<rules>",
	"- Use read to examine files instead of cat or sed.",
	"- Be concise in your responses",
	"</rules>",
	"",
	"<docs>",
	"- Main documentation: /some/very/long/path/to/pi/README.md",
	`- ${"docs line padding. ".repeat(80)}`,
	"</docs>",
	"",
	"<skills>",
	"<skill>",
	"<name>example-skill</name>",
	`<description>${"a very long skill description. ".repeat(60)}</description>`,
	"<location>/skills/example/SKILL.md</location>",
	"</skill>",
	"</skills>",
].join("\n");

describe("claudeSystemPrompt", () => {
	test("keeps preamble and rules, drops tools/docs/skills, appends adapter note", () => {
		const out = claudeSystemPrompt(PI_PROMPT, true);
		expect(out).toContain("expert coding assistant");
		expect(out).toContain("<rules>");
		expect(out).not.toContain("Read file contents");
		expect(out).not.toContain("<docs>");
		expect(out).not.toContain("<skills>");
		expect(out).toContain("mcp__pi__");
	});

	test("omits the adapter note when no tools are exposed", () => {
		const out = claudeSystemPrompt(PI_PROMPT, false);
		expect(out).not.toContain("mcp__pi__");
		expect(out).toContain("Be concise");
	});

	test("truncates to the budget as the last resort", () => {
		process.env.PI_CLAUDE_SYSTEM_BUDGET = "50";
		try {
			expect(claudeSystemPrompt(PI_PROMPT, false).length).toBeLessThanOrEqual(50);
		} finally {
			delete process.env.PI_CLAUDE_SYSTEM_BUDGET;
		}
	});

	test("handles a missing host prompt", () => {
		const out = claudeSystemPrompt(undefined, true);
		expect(out).toContain("mcp__pi__");
	});
});
