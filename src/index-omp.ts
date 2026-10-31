// omp entry: resolves the host pi-ai module through omp's alias map. The
// published @oh-my-pi/pi-ai package is only a partial stub; inside omp the
// alias maps this specifier to the full embedded fork, so the module is
// trusted at the boundary and cast to the shared core's expected shape.
import * as aiModule from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClaudeCodeProvider, type PiAi } from "./extension-core";

export default function (pi: ExtensionAPI) {
	return registerClaudeCodeProvider(pi, aiModule as unknown as PiAi);
}
