import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	cloneState,
	DCP_STATE_ENTRY_TYPE,
	parseStateSnapshot,
	restoreLatestState,
	type RestoredState,
} from "./state.js";
import type { DcpStateSnapshot } from "./types.js";

export interface StateStore {
	get(): DcpStateSnapshot;
	restore(branch: readonly SessionEntry[]): RestoredState;
	replace(next: DcpStateSnapshot): void;
	persist(): void;
	commit(next: DcpStateSnapshot): void;
}

export function appendStateSnapshot(
	pi: Pick<ExtensionAPI, "appendEntry">,
	state: DcpStateSnapshot,
): void {
	const snapshot = cloneState(state);
	const parsed = parseStateSnapshot(snapshot);
	if (!parsed.state) throw new Error(`Refusing to persist invalid DCP state: ${parsed.errors.join("; ")}`);
	pi.appendEntry(DCP_STATE_ENTRY_TYPE, parsed.state);
}

export function createStateStore(pi: Pick<ExtensionAPI, "appendEntry">): StateStore {
	let current = restoreLatestState([]).state;

	return {
		get: () => cloneState(current),
		restore(branch) {
			const restored = restoreLatestState(branch);
			current = restored.state;
			return {
				...restored,
				state: cloneState(restored.state),
			};
		},
		replace(next) {
			const parsed = parseStateSnapshot(next);
			if (!parsed.state) throw new Error(`Invalid DCP state: ${parsed.errors.join("; ")}`);
			current = parsed.state;
		},
		persist() {
			appendStateSnapshot(pi, current);
		},
		commit(next) {
			const parsed = parseStateSnapshot(next);
			if (!parsed.state) throw new Error(`Invalid DCP state: ${parsed.errors.join("; ")}`);
			// Append first so an I/O failure cannot leave memory ahead of the branch log.
			appendStateSnapshot(pi, parsed.state);
			current = parsed.state;
		},
	};
}
