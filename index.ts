import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDcpCommand } from "./lib/commands.js";
import { reconcileStateStore } from "./lib/compaction-sync.js";
import { createCompressTool, type CompressionRequestSnapshot } from "./lib/compress-tool.js";
import { applyCompressionOverlay } from "./lib/compression.js";
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.js";
import { buildMessageMap, stripMessageAnnotation } from "./lib/message-map.js";
import { createNudgeController, estimateEffectiveContextTokens, injectNudge } from "./lib/nudges.js";
import { createStateStore } from "./lib/persistence.js";
import type { DcpConfig } from "./lib/types.js";

export default function dcpExtension(pi: ExtensionAPI): void {
	const state = createStateStore(pi);
	const nudges = createNudgeController();
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

	function reconcile(ctx: ExtensionContext): void {
		try {
			reconcileStateStore(ctx.sessionManager.buildContextEntries(), state);
		} catch (error) {
			warnOnce([`failed to persist native-compaction cleanup: ${error instanceof Error ? error.message : String(error)}`]);
		}
	}

	function restore(ctx: ExtensionContext, reloadConfig: boolean): void {
		latestSnapshot = undefined;
		nudges.reset();
		const restored = state.restore(ctx.sessionManager.getBranch());
		if (restored.invalidEntryIds.length > 0) {
			warnOnce([`ignored invalid state entries: ${restored.invalidEntryIds.join(", ")}`]);
		}
		reconcile(ctx);
		if (!reloadConfig) return;

		const loaded = loadConfig(ctx.cwd);
		config = loaded.config;
		warnOnce(loaded.warnings);
	}

	pi.registerTool(createCompressTool(state, () => latestSnapshot));
	registerDcpCommand(pi, state);

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: [
			event.systemPrompt,
			"DCP message markers are read-only metadata. When calling the `compress` tool, reference only their IDs; never output, quote, or reproduce the markers.",
		].join("\n\n"),
	}));
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
		const sanitized = stripMessageAnnotation(event.message);
		if (!isDeepStrictEqual(sanitized, event.message)) return { message: sanitized };
	});
	pi.on("session_start", async (_event, ctx) => restore(ctx, true));
	pi.on("session_tree", async (_event, ctx) => restore(ctx, false));
	pi.on("session_compact", async (_event, ctx) => {
		latestSnapshot = undefined;
		nudges.reset();
		reconcile(ctx);
	});
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
		if (!overlay.ok) {
			warnOnce([`compression overlay disabled for this request: ${overlay.errors.join("; ")}`]);
			return { messages: overlay.messages };
		}

		const latestUser = [...mapped.value.mappedMessages].reverse().find((item) => item.message.role === "user");
		const contextUsage = ctx.getContextUsage();
		const modelContextWindow = ctx.model?.contextWindow;
		const contextWindow = modelContextWindow && modelContextWindow > 0
			? modelContextWindow
			: contextUsage?.contextWindow;
		const evaluated = nudges.evaluate({
			config,
			contextWindow,
			estimatedTokens: estimateEffectiveContextTokens(
				mapped.value.messages,
				overlay.messages,
				contextUsage?.tokens ?? undefined,
			),
			sessionId: ctx.sessionManager.getSessionId(),
			requestLeafId: ctx.sessionManager.getLeafId(),
			latestUserEntryId: latestUser?.entryId,
		});
		if (evaluated.configError) warnOnce([`compression nudges disabled: ${evaluated.configError}`]);
		return { messages: injectNudge(overlay.messages, evaluated.decision) };
	});

}
