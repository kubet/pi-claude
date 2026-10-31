// Model catalog and effort mapping for the claude-code provider.
//
// Claude Code resolves model aliases itself (`default`, `sonnet`, `opus`,
// `haiku`), so the static catalog uses aliases instead of pinned model IDs —
// it never goes stale and works without probing. Pricing is zero: turns ride
// the local Claude Code subscription (or its ambient ANTHROPIC_* credentials),
// and any cost the result message reports is surfaced as provider-billed.

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code";
export const BASE_URL = "claude-code://local";

/** SDK effort levels accepted by the claude-agent-sdk `effort` option. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_BY_THINKING: Partial<Record<ThinkingLevel, EffortLevel>> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** Map a pi thinking level to a Claude Code effort level. undefined keeps Claude Code's default. */
export function effortFor(level: ThinkingLevel | undefined): EffortLevel | undefined {
	if (level === undefined) return undefined;
	return EFFORT_BY_THINKING[level] ?? "medium";
}

interface CatalogEntry {
	id: string;
	name: string;
}

const CATALOG: readonly CatalogEntry[] = [
	{ id: "default", name: "Claude Code (default model)" },
	{ id: "sonnet", name: "Claude Code (Sonnet)" },
	{ id: "opus", name: "Claude Code (Opus)" },
	{ id: "haiku", name: "Claude Code (Haiku)" },
];

const THINKING_LEVEL_MAP: Partial<Record<ThinkingLevel, string>> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export function staticModels(): Model<Api>[] {
	return CATALOG.map((entry) => ({
		id: entry.id,
		name: entry.name,
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinkingLevelMap: THINKING_LEVEL_MAP as Model<Api>["thinkingLevelMap"],
	}));
}

/** Minimum Claude Code CLI this bridge supports (opencode parity: 2.1.248). */
export const MIN_CLAUDE_VERSION = [2, 1, 248] as const;

/** null when compatible; an actionable message when the CLI is too old or unknown. */
export function versionProblem(version: string | undefined): string | null {
	if (version === undefined) {
		return "pi-claude could not read the claude CLI version. Run `claude --version` to check the installation.";
	}
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) {
		return `pi-claude could not parse the claude CLI version "${version}". Run \`claude update\`.`;
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	for (let i = 0; i < MIN_CLAUDE_VERSION.length; i++) {
		const have = [major, minor, patch][i] as number;
		const want = MIN_CLAUDE_VERSION[i];
		if (have > (want as number)) return null;
		if (have < (want as number)) {
			return `pi-claude needs Claude Code ${MIN_CLAUDE_VERSION.join(".")} or newer (found ${version}). Run \`claude update\`.`;
		}
	}
	return null;
}
