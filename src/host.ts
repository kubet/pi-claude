// Host module resolution.
//
// pi and omp both expose the pi-ai runtime to extensions, but under different
// package names: pi aliases "@earendil-works/pi-ai" (and the legacy
// "@mariozechner/pi-ai"), omp aliases "@oh-my-pi/pi-ai". A static import
// satisfies one host and fails to load on the other, so the bridge resolves
// the host at runtime and fails loudly when no host module is available.
//
// Types come from the devDependency "@earendil-works/pi-ai"; omp's fork tracks
// the same API surface (it is the module pi-climb and every omp plugin is
// written against).

import type * as PiAiModule from "@earendil-works/pi-ai";

export type PiAi = typeof PiAiModule;
const SPECIFIERS = ["@earendil-works/pi-ai", "@mariozechner/pi-ai", "@oh-my-pi/pi-ai"] as const;
let cached: PiAi | undefined;

/** Resolve the host's pi-ai module. Throws when no known host provides it. */
export async function piAi(): Promise<PiAi> {
	if (cached) return cached;
	const errors: string[] = [];
	for (const specifier of SPECIFIERS) {
		try {
			cached = (await import(specifier)) as PiAi;
			return cached;
		} catch (error) {
			errors.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(
		`pi-claude: no host pi-ai module found. Tried:\n${errors.join("\n")}\n` +
			"Run this as a pi or omp extension.",
	);
}
