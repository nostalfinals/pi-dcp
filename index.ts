import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDcpCommand } from "./lib/commands.js";
import { reconcileStateStore } from "./lib/compaction-sync.js";
import { createCompressTool, type CompressionRequestSnapshot } from "./lib/compress-tool.js";
import { applyCompressionOverlay, hasClosedHistory } from "./lib/compression.js";
import { DEFAULT_CONFIG, loadConfig } from "./lib/config.js";
import { buildMessageMap, stripMessageAnnotation } from "./lib/message-map.js";
import { emitMarkerDebug } from "./lib/marker-debug.js";
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

	function traceMarker(stage: string, value: unknown, force = false, includeExcerpts = true): void {
		emitMarkerDebug(config.debugMarkerTrace, stage, value, { force, includeExcerpts });
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
			"DCP message markers are read-only metadata. `id` labels the message carrying the marker; `previous-assistant-id` references the immediately preceding assistant message. Never output, quote, or reproduce the markers.",
		].join("\n\n"),
	}));
	pi.on("message_update", async (event) => {
		traceMarker("message_update.message", event.message);
		traceMarker("message_update.assistantMessageEvent", event.assistantMessageEvent);
	});
	pi.on("message_end", async (event) => {
		traceMarker("message_end.before-sanitize", event.message);
		if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
		const sanitized = stripMessageAnnotation(event.message);
		if (!isDeepStrictEqual(sanitized, event.message)) {
			traceMarker("message_end.after-sanitize", sanitized, true);
			return { message: sanitized };
		}
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
			traceMarker("context.outbound.mapping-failed", event.messages, true, false);
			return { messages: event.messages };
		}

		const overlay = applyCompressionOverlay(mapped.value, state.get());
		latestSnapshot = {
			map: mapped.value,
			visibleAliases: overlay.ok ? overlay.visibleAliases : mapped.value.visibleAliases,
			sessionId: ctx.sessionManager.getSessionId(),
			anchorLeafId: ctx.sessionManager.getLeafId(),
		};
		if (!overlay.ok) {
			warnOnce([`compression overlay disabled for this request: ${overlay.errors.join("; ")}`]);
			traceMarker("context.outbound.overlay-failed", overlay.messages, true, false);
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
			hasClosedHistory: hasClosedHistory(mapped.value),
		});
		if (evaluated.configError) warnOnce([`compression nudges disabled: ${evaluated.configError}`]);
		const outbound = injectNudge(overlay.messages, evaluated.decision);
		traceMarker("context.outbound", outbound, true, false);
		return { messages: outbound };
	});

}
