import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { applyCompressionOverlay } from "./compression.js";
import { buildMessageMap } from "./message-map.js";
import type { StateStore } from "./persistence.js";
import type { CompressionBlock, DcpStateSnapshot } from "./types.js";

export interface BlockAvailability {
	block: CompressionBlock;
	restorable: boolean;
	reason?: string;
}

export type DecompressionResult =
	| { ok: true; state: DcpStateSnapshot; block: CompressionBlock }
	| { ok: false; message: string };

/** Inspect each block independently so one stale record cannot hide another restorable block. */
export function inspectActiveBlocks(
	entries: readonly SessionEntry[],
	state: DcpStateSnapshot,
): BlockAvailability[] {
	const messages = entries.flatMap(sessionEntryToContextMessages);
	const mapped = buildMessageMap(entries, messages);
	if (!mapped.ok) {
		return state.activeBlocks.map((block) => ({ block, restorable: false, reason: mapped.reason }));
	}

	return state.activeBlocks.map((block) => {
		const overlay = applyCompressionOverlay(mapped.value, {
			version: 1,
			nextBlockNumber: state.nextBlockNumber,
			activeBlocks: [block],
		});
		return overlay.ok
			? { block, restorable: true }
			: { block, restorable: false, reason: overlay.errors.join("; ") };
	});
}

export function prepareDecompression(
	entries: readonly SessionEntry[],
	state: DcpStateSnapshot,
	blockId: string,
): DecompressionResult {
	const block = state.activeBlocks.find((candidate) => candidate.id === blockId);
	if (!block) return { ok: false, message: `Unknown active compression block: ${blockId}` };
	const availability = inspectActiveBlocks(entries, state).find((candidate) => candidate.block.id === blockId);
	if (!availability?.restorable) {
		return {
			ok: false,
			message: `${blockId} can no longer be decompressed because Pi native compaction has already consolidated or removed its source range`,
		};
	}
	return {
		ok: true,
		block,
		state: {
			version: 1,
			nextBlockNumber: state.nextBlockNumber,
			activeBlocks: state.activeBlocks.filter((candidate) => candidate.id !== blockId).map((candidate) => ({ ...candidate })),
		},
	};
}

function blockLabel(block: CompressionBlock): string {
	return block.topic ? `${block.id} — ${block.topic}` : block.id;
}

function listMessage(entries: readonly SessionEntry[], state: DcpStateSnapshot, includeUsage: boolean): string {
	const availability = inspectActiveBlocks(entries, state);
	const restorable = availability.filter((item) => item.restorable);
	const unavailable = availability.length - restorable.length;
	const lines = restorable.length > 0
		? restorable.map((item) => `• ${blockLabel(item.block)} (${item.block.startEntryId.slice(0, 8)}…${item.block.endEntryId.slice(0, 8)})`)
		: ["No active, restorable DCP compression blocks."];
	if (unavailable > 0) lines.push(`${unavailable} stale block${unavailable === 1 ? " is" : "s are"} unavailable pending native-compaction cleanup.`);
	if (includeUsage) lines.push("Use /dcp inspect <block-id> to view a summary or /dcp decompress <block-id> to restore a range.");
	return lines.join("\n");
}

function inspectionMessage(block: CompressionBlock): string {
	return [
		blockLabel(block),
		`Range: ${block.startEntryId.slice(0, 8)}…${block.endEntryId.slice(0, 8)}`,
		"",
		"Summary:",
		block.summary,
	].join("\n");
}

export function registerDcpCommand(pi: Pick<ExtensionAPI, "registerCommand">, state: StateStore): void {
	pi.registerCommand("dcp", {
		description: "Inspect DCP context, view a summary, or decompress an active block",
		getArgumentCompletions(prefix) {
			const options = [
				{ value: "context", label: "context" },
				{ value: "inspect", label: "inspect" },
				{ value: "decompress", label: "decompress" },
				...state.get().activeBlocks.map((block) => ({ value: `inspect ${block.id}`, label: `inspect ${blockLabel(block)}` })),
				...state.get().activeBlocks.map((block) => ({ value: `decompress ${block.id}`, label: `decompress ${blockLabel(block)}` })),
			];
			const matches = options.filter((item) => item.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const operation = parts[0] ?? "context";
			if (operation === "context") {
				if (parts.length > 1) {
					ctx.ui.notify("Usage: /dcp context", "warning");
					return;
				}
				ctx.ui.notify(listMessage(ctx.sessionManager.buildContextEntries(), state.get(), true), "info");
				return;
			}
			if (operation !== "inspect" && operation !== "decompress") {
				ctx.ui.notify("Usage: /dcp [context | inspect [block-id] | decompress [block-id]]", "warning");
				return;
			}
			if (parts.length === 1) {
				ctx.ui.notify(listMessage(ctx.sessionManager.buildContextEntries(), state.get(), true), "info");
				return;
			}
			if (parts.length !== 2) {
				ctx.ui.notify(`Usage: /dcp ${operation} [block-id]`, "warning");
				return;
			}

			const entries = ctx.sessionManager.buildContextEntries();
			const currentState = state.get();
			if (operation === "inspect") {
				const availability = inspectActiveBlocks(entries, currentState).find((candidate) => candidate.block.id === parts[1]);
				if (!availability?.restorable) {
					ctx.ui.notify(
						availability
							? `${parts[1]} can no longer be inspected because Pi native compaction has already consolidated or removed its source range`
							: `Unknown active compression block: ${parts[1]}`,
						"warning",
					);
					return;
				}
				ctx.ui.notify(inspectionMessage(availability.block), "info");
				return;
			}

			const decompressed = prepareDecompression(entries, currentState, parts[1]);
			if (!decompressed.ok) {
				ctx.ui.notify(decompressed.message, "warning");
				return;
			}
			try {
				state.commit(decompressed.state);
				ctx.ui.notify(`Decompressed ${blockLabel(decompressed.block)}; original messages will return on the next context build.`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to persist decompression: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
