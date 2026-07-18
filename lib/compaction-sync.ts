import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { StateStore } from "./persistence.js";
import type { CompressionBlock, DcpStateSnapshot } from "./types.js";

export type RetiredBlockReason = "source-consumed" | "boundary-crossing" | "invalid-order";

export interface RetiredCompressionBlock {
	block: CompressionBlock;
	reason: RetiredBlockReason;
}

export interface CompactionReconciliation {
	changed: boolean;
	state: DcpStateSnapshot;
	retired: RetiredCompressionBlock[];
}

/**
 * Reconcile against Pi's canonical, compaction-aware entry sequence.
 * A block remains active only while its complete closed source range is still present.
 */
export function reconcileCompactionState(
	contextEntries: readonly SessionEntry[],
	state: DcpStateSnapshot,
): CompactionReconciliation {
	const positions = new Map(contextEntries.map((entry, index) => [entry.id, index]));
	const activeBlocks: CompressionBlock[] = [];
	const retired: RetiredCompressionBlock[] = [];

	for (const block of state.activeBlocks) {
		const start = positions.get(block.startEntryId);
		const end = positions.get(block.endEntryId);
		if (start === undefined && end === undefined) {
			retired.push({ block: { ...block }, reason: "source-consumed" });
			continue;
		}
		if (start === undefined || end === undefined) {
			retired.push({ block: { ...block }, reason: "boundary-crossing" });
			continue;
		}
		if (start > end) {
			retired.push({ block: { ...block }, reason: "invalid-order" });
			continue;
		}
		activeBlocks.push({ ...block });
	}

	return {
		changed: retired.length > 0,
		state: {
			version: 1,
			nextBlockNumber: state.nextBlockNumber,
			activeBlocks,
		},
		retired,
	};
}

/** Persist a repaired complete snapshot only when reconciliation retired blocks. */
export function reconcileStateStore(
	contextEntries: readonly SessionEntry[],
	store: StateStore,
): CompactionReconciliation {
	const reconciliation = reconcileCompactionState(contextEntries, store.get());
	if (reconciliation.changed) store.commit(reconciliation.state);
	return reconciliation;
}
