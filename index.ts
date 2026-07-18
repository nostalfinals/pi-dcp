import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.js";
import { buildMessageMap } from "./lib/message-map.js";
import { createStateStore } from "./lib/persistence.js";
import type { DcpConfig } from "./lib/types.js";

export default function dcpExtension(pi: ExtensionAPI): void {
	const state = createStateStore(pi);
	let config: DcpConfig = { ...DEFAULT_CONFIG };
	const emittedWarnings = new Set<string>();

	function warnOnce(messages: readonly string[]): void {
		if (messages.length === 0) return;
		const warning = `[pi-dcp] ${messages.join(" | ")}`;
		if (emittedWarnings.has(warning)) return;
		emittedWarnings.add(warning);
		console.warn(warning);
	}

	function restore(ctx: ExtensionContext, reloadConfig: boolean): void {
		const restored = state.restore(ctx.sessionManager.getBranch());
		if (restored.invalidEntryIds.length > 0) {
			warnOnce([`ignored invalid state entries: ${restored.invalidEntryIds.join(", ")}`]);
		}
		if (!reloadConfig) return;

		const loaded = loadConfig(ctx.cwd);
		config = loaded.config;
		warnOnce(loaded.warnings);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx, true));
	pi.on("session_tree", async (_event, ctx) => restore(ctx, false));
	pi.on("context", async (event, ctx) => {
		const mapped = buildMessageMap(ctx.sessionManager.buildContextEntries(), event.messages);
		if (!mapped.ok) {
			warnOnce([`message mapping disabled for this request: ${mapped.reason}`]);
			return { messages: event.messages };
		}
		return { messages: mapped.value.messages };
	});

	// Retained by the extension runtime for later phases (nudges and tooling).
	void config;
}
