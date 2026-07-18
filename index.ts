import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompressTool, type CompressionRequestSnapshot } from "./lib/compress-tool.js";
import { applyCompressionOverlay } from "./lib/compression.js";
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.js";
import { buildMessageMap } from "./lib/message-map.js";
import { createStateStore } from "./lib/persistence.js";
import type { DcpConfig } from "./lib/types.js";

export default function dcpExtension(pi: ExtensionAPI): void {
	const state = createStateStore(pi);
	let config: DcpConfig = { ...DEFAULT_CONFIG };
	let latestSnapshot: CompressionRequestSnapshot | undefined;
	const emittedWarnings = new Set<string>();

	function warnOnce(messages: readonly string[]): void {
		if (messages.length === 0) return;
		const warning = `[pi-dcp] ${messages.join(" | ")}`;
		if (emittedWarnings.has(warning)) return;
		emittedWarnings.add(warning);
		console.warn(warning);
	}

	function restore(ctx: ExtensionContext, reloadConfig: boolean): void {
		latestSnapshot = undefined;
		const restored = state.restore(ctx.sessionManager.getBranch());
		if (restored.invalidEntryIds.length > 0) {
			warnOnce([`ignored invalid state entries: ${restored.invalidEntryIds.join(", ")}`]);
		}
		if (!reloadConfig) return;

		const loaded = loadConfig(ctx.cwd);
		config = loaded.config;
		warnOnce(loaded.warnings);
	}

	pi.registerTool(createCompressTool(state, () => latestSnapshot));

	pi.on("session_start", async (_event, ctx) => restore(ctx, true));
	pi.on("session_tree", async (_event, ctx) => restore(ctx, false));
	pi.on("context", async (event, ctx) => {
		const mapped = buildMessageMap(ctx.sessionManager.buildContextEntries(), event.messages);
		if (!mapped.ok) {
			latestSnapshot = undefined;
			warnOnce([`message mapping disabled for this request: ${mapped.reason}`]);
			return { messages: event.messages };
		}

		latestSnapshot = {
			map: mapped.value,
			sessionId: ctx.sessionManager.getSessionId(),
			anchorLeafId: ctx.sessionManager.getLeafId(),
		};
		const overlay = applyCompressionOverlay(mapped.value, state.get());
		if (!overlay.ok) warnOnce([`compression overlay disabled for this request: ${overlay.errors.join("; ")}`]);
		return { messages: overlay.messages };
	});

	// Retained by the extension runtime for later phases (nudges and tooling).
	void config;
}
