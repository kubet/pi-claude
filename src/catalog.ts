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
