import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { prepareCompression, type CompressionRangeInput } from "./compression.js";
import type { MessageMap } from "./message-map.js";
import type { StateStore } from "./persistence.js";

export interface CompressionRequestSnapshot {
	map: MessageMap;
	visibleAliases: ReadonlySet<string>;
	sessionId: string;
	anchorLeafId: string | null;
}

export interface CompressToolDetails {
	ok: boolean;
	blockIds?: string[];
	supersededBlockIds?: string[];
	estimatedTokensRemoved?: number;
	estimatedSummaryTokens?: number;
	estimatedTokensSaved?: number;
	errors?: string[];
}

export function formatTokenEstimate(tokens: number): string {
	const rounded = Math.max(0, Math.round(tokens));
	return rounded < 1_000 ? String(rounded) : `${(rounded / 1_000).toFixed(1)}k`;
}

const parameters = Type.Object({
	ranges: Type.Array(Type.Object({
		startId: Type.String({ description: "First DCP message alias in the closed range, for example m012" }),
		endId: Type.String({ description: "Last DCP message alias in the closed range, for example m037" }),
		summary: Type.String({ minLength: 1, description: "High-fidelity replacement summary for this range" }),
		topic: Type.Optional(Type.String({ description: "Optional short topic label" })),
	}), { minItems: 1, description: "One or more disjoint old-history ranges; all are committed atomically" }),
});

function errorResult(errors: string[]) {
	return {
		content: [{ type: "text" as const, text: `Compression rejected:\n- ${errors.join("\n- ")}` }],
		details: { ok: false, errors } satisfies CompressToolDetails,
	};
}

function snapshotIsCurrent(snapshot: CompressionRequestSnapshot, ctx: ExtensionContext): string | undefined {
	if (ctx.sessionManager.getSessionId() !== snapshot.sessionId) return "The referenced message IDs belong to another session";
	if (!snapshot.anchorLeafId) return "The request snapshot has no active branch anchor";
	if (!ctx.sessionManager.getBranch().some((entry) => entry.id === snapshot.anchorLeafId)) {
		return "The referenced message IDs are stale or belong to another branch";
	}
	return undefined;
}

export function createCompressTool(
	state: StateStore,
	getSnapshot: () => CompressionRequestSnapshot | undefined,
): ToolDefinition<typeof parameters, CompressToolDetails> {
	return {
		name: "compress",
		label: "Compress context",
		description: "Replace one or more old message ranges with your supplied high-fidelity summaries. Use only visible mNNN IDs.",
		promptSnippet: "Compress old context ranges using model-written summaries",
		promptGuidelines: [
			"Use compress only for completed, older work; never include the current active work segment.",
			"Make each compression summary self-contained and preserve decisions, constraints, paths, commands, errors, and unresolved work.",
			"Prefer a few substantial semantic ranges over frequent tiny compressions.",
		],
		parameters,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = getSnapshot();
			if (!snapshot) return errorResult(["No exact DCP message snapshot is available; retry after a fresh model request"]);
			const staleReason = snapshotIsCurrent(snapshot, ctx);
			if (staleReason) return errorResult([staleReason]);

			const invisibleErrors = (params.ranges as CompressionRangeInput[]).flatMap((range, index) => {
				const errors: string[] = [];
				if (!snapshot.visibleAliases.has(range.startId)) errors.push(`ranges[${index}].startId ${range.startId} was not visible in the request snapshot`);
				if (!snapshot.visibleAliases.has(range.endId)) errors.push(`ranges[${index}].endId ${range.endId} was not visible in the request snapshot`);
				return errors;
			});
			if (invisibleErrors.length > 0) return errorResult(invisibleErrors);

			const prepared = prepareCompression(
				snapshot.map,
				state.get(),
				params.ranges as CompressionRangeInput[],
				toolCallId,
			);
			if (!prepared.ok) return errorResult(prepared.errors);

			try {
				state.commit(prepared.value.state);
			} catch (error) {
				return errorResult([`Failed to persist compression state: ${error instanceof Error ? error.message : String(error)}`]);
			}

			const blockIds = prepared.value.ranges.map((item) => item.block.id);
			const superseded = prepared.value.supersededBlockIds;
			const estimatedSummaryTokens = prepared.value.ranges.reduce(
				(total, item) => total + item.replacementTokens,
				0,
			);
			const estimatedTokensRemoved = prepared.value.estimatedTokensSaved + estimatedSummaryTokens;
			return {
				content: [{
					type: "text",
					text: [
						`Compressed ${blockIds.length} range${blockIds.length === 1 ? "" : "s"} into ${blockIds.join(", ")}.`,
						superseded.length > 0 ? ` Superseded ${superseded.join(", ")}.` : "",
						"\n",
						`Removed ~${formatTokenEstimate(estimatedTokensRemoved)} tokens; `,
						`added ~${formatTokenEstimate(estimatedSummaryTokens)} summary tokens; `,
						`net reduction ~${formatTokenEstimate(prepared.value.estimatedTokensSaved)} tokens.`,
					].join(""),
				}],
				details: {
					ok: true,
					blockIds,
					supersededBlockIds: superseded,
					estimatedTokensRemoved,
					estimatedSummaryTokens,
					estimatedTokensSaved: prepared.value.estimatedTokensSaved,
				},
			};
		},
	};
}
