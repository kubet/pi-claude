// E2E: real pi CLI driving real Claude Code through the pi-claude provider.
//
// Every scenario spawns pi with the extension loaded in a scratch project and
// asserts on observable outcomes (stdout, files written, JSONL events).
// Gated behind PI_CLAUDE_E2E=1 so plain `bun test` never burns claude turns.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const PI = join(REPO, "node_modules", ".bin", "pi");
const EXTENSION = join(REPO, "src", "index.ts");

function runPi(cwd: string, prompt: string, extra: string[] = []): { stdout: string; stderr: string; status: number } {
	const result = spawnSync(
		PI,
		["--print", "--no-session", "--no-extensions", "-e", EXTENSION, "--model", "claude-code/sonnet", ...extra, "--", prompt],
		{ cwd, encoding: "utf8", timeout: 240_000, env: { ...process.env, PI_OFFLINE: "1" } },
	);
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 };
}

function scratch(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-claude-${name}-`));
	return dir;
}

const runIfEnabled = process.env.PI_CLAUDE_E2E === "1" ? describe : describe.skip;

runIfEnabled("pi + claude-code e2e", () => {
	let dir: string;

	beforeEach(() => {
		dir = scratch("e2e");
	});

	test("plain turn: claude answers through pi without tools", { timeout: 240_000 }, () => {
		const { stdout, status } = runPi(dir, "Reply with exactly: BRIDGE-OK", ["--no-tools"]);
		expect(status).toBe(0);
		expect(stdout).toContain("BRIDGE-OK");
	});

	test("read tool: claude reads a pi file and reports its contents", { timeout: 240_000 }, () => {
		writeFileSync(join(dir, "secret.txt"), "mango-42\n");
		const { stdout, status } = runPi(dir, "Read the file secret.txt and reply with only its exact contents, nothing else.");
		expect(status).toBe(0);
		expect(stdout).toContain("mango-42");
	});

	test("write tool: claude creates a file through pi's write tool", { timeout: 240_000 }, () => {
		const { stdout, status } = runPi(dir, "Create a file named hello.txt containing exactly the text hi-from-claude (no trailing newline) using your write tool.");
		expect(status).toBe(0);
		const created = join(dir, "hello.txt");
		expect(existsSync(created)).toBe(true);
		expect(readFileSync(created, "utf8")).toContain("hi-from-claude");
		void stdout;
	});

	test("multi-tool turn: two reads feed one write within a single pi turn", { timeout: 240_000 }, () => {
		writeFileSync(join(dir, "a.txt"), "alpha\n");
		writeFileSync(join(dir, "b.txt"), "beta\n");
		const { status } = runPi(dir, "Read a.txt and b.txt, then create combined.txt containing the contents of a.txt followed by the contents of b.txt.");
		expect(status).toBe(0);
		expect(readFileSync(join(dir, "combined.txt"), "utf8")).toBe("alpha\nbeta\n");
	});

	test("session continuity: claude remembers across a parked tool boundary", { timeout: 240_000 }, () => {
		writeFileSync(join(dir, "fact.txt"), "sunrise\n");
		const { stdout, status } = runPi(dir, "Remember the number 8641. First read fact.txt. After the tool result arrives, reply with exactly: <number> <file contents> — for example 1234 word. Nothing else.");
		expect(status).toBe(0);
		expect(stdout).toContain("8641");
		expect(stdout).toContain("sunrise");
	});

	test("usage is recorded on the pi assistant message", { timeout: 240_000 }, () => {
		writeFileSync(join(dir, "u.txt"), "usage-probe\n");
		const result = spawnSync(
			PI,
			[
				"--print", "--mode", "json", "--no-session", "--no-extensions",
				"-e", EXTENSION, "--model", "claude-code/sonnet", "--",
				"Read u.txt and reply with its contents.",
			],
			{ cwd: dir, encoding: "utf8", timeout: 240_000, env: { ...process.env, PI_OFFLINE: "1" } },
		);
		expect(result.status).toBe(0);
		const lines = (result.stdout ?? "").split("\n").filter((line) => line.trim().startsWith("{"));
		const withUsage = lines
			.map((line) => JSON.parse(line) as { type?: string; message?: { usage?: { input?: number; output?: number } } })
			.filter((event) => event.message?.usage && (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0) > 0);
		expect(withUsage.length).toBeGreaterThan(0);
	});
});


