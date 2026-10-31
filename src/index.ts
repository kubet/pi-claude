// pi entry: resolves the host pi-ai module through pi's own alias map
// (static import required — dynamic imports bypass the alias).
import * as aiModule from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClaudeCodeProvider, type PiAi } from "./extension-core";

export default function (pi: ExtensionAPI) {
	return registerClaudeCodeProvider(pi, aiModule as PiAi);
}
