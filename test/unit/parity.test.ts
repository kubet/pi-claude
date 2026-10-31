// Parity tests: error mapping, tool-name sanitization, version gate.

import { describe, expect, test } from "bun:test";
import { resultError } from "../../src/convert";
import { claudeToolName, piToolName } from "../../src/mcp";
import { versionProblem, MIN_CLAUDE_VERSION } from "../../src/catalog";

describe("resultError mapping", () => {
	test("billing/extra-usage failures name the remedy and the reset", () => {
		const error = resultError(
			{ subtype: "success", is_error: true, result: "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going." },
			{ resetsAt: 1793682000 },
		);
		expect(error?.message).toContain("usage limit");
		expect(error?.message).toContain("claude.ai/settings/usage");
		expect(error?.message).toContain(new Date(1793682000 * 1000).toISOString());
	});

	test("logged-out failures point at claude /login", () => {
		const error = resultError({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
		expect(error?.message).toContain("claude /login");
	});

	test("empty success after retries reports the HTTP status", () => {
		const error = resultError({ subtype: "success", is_error: true, result: "API Error", api_error_status: 529 });
		expect(error?.message).toContain("529");
		expect(error?.message).toContain("retries");
	});

	test("rate limit without HTTP status keeps the reset window", () => {
		const error = resultError(
			{ subtype: "error_during_execution", is_error: true, result: "rate limit exceeded" },
			{ resetsAt: 1793682000 },
		);
		expect(error?.message).toContain("rate limit");
		expect(error?.message).toContain(new Date(1793682000 * 1000).toISOString());
	});

	test("plain failures keep the subtype and detail", () => {
		const error = resultError({ subtype: "error_max_turns", is_error: true, result: "gave up" });
		expect(error?.message).toContain("error_max_turns");
		expect(error?.message).toContain("gave up");
	});
});

describe("tool name sanitization", () => {
	test("normal pi names pass through unchanged", () => {
		expect(claudeToolName("read")).toBe("read");
		expect(piToolName("mcp__pi__read")).toBe("read");
	});

	test("unsafe characters and oversize names sanitize with a stable suffix and round-trip", () => {
		const awkward = "mcp.github/search issues.super-long-tool-name.that-exceeds";
		const claudeName = claudeToolName(awkward);
		expect(claudeName).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(claudeName.length).toBeLessThanOrEqual(64 - "mcp__pi__".length);
		expect(claudeToolName(awkward)).toBe(claudeName);
		expect(piToolName(`mcp__pi__${claudeName}`)).toBe(awkward);
	});

	test("distinct oversize names do not collide", () => {
		const a = claudeToolName(`${"a".repeat(80)}-one`);
		const b = claudeToolName(`${"a".repeat(80)}-two`);
		expect(a).not.toBe(b);
	});
});

describe("version gate", () => {
	test(`accepts ${MIN_CLAUDE_VERSION.join(".")} and newer, rejects older with an update hint`, () => {
		expect(versionProblem("2.1.316 (Claude Code)")).toBeNull();
		expect(versionProblem("3.0.0")).toBeNull();
		expect(versionProblem("2.1.247")).toContain("claude update");
		expect(versionProblem("2.0.99")).toContain("claude update");
	});

	test("unknown versions fail with guidance", () => {
		expect(versionProblem(undefined)).toContain("claude --version");
		expect(versionProblem("garbage")).toContain("claude update");
	});
});
