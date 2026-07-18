import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { appendStateSnapshot, createStateStore } from "../lib/persistence.js";
import {
	createEmptyState,
	DCP_STATE_ENTRY_TYPE,
	parseStateSnapshot,
	restoreLatestState,
} from "../lib/state.js";
import type { DcpStateSnapshot } from "../lib/types.js";

function snapshot(nextBlockNumber: number, id = `b${nextBlockNumber - 1}`): DcpStateSnapshot {
	return {
		version: 1,
		nextBlockNumber,
		activeBlocks: nextBlockNumber === 1
			? []
			: [{ id, startEntryId: "start", endEntryId: "end", summary: "summary", createdAt: 1 }],
	};
}

function customEntry(id: string, data: unknown, parentId: string | null = null): CustomEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: DCP_STATE_ENTRY_TYPE,
		data,
	};
}

describe("state snapshots", () => {
	it("creates an empty versioned state", () => {
		assert.deepEqual(createEmptyState(), { version: 1, nextBlockNumber: 1, activeBlocks: [] });
	});

	it("parses and defensively copies valid state", () => {
		const original = snapshot(2);
		const parsed = parseStateSnapshot(original);
		assert.deepEqual(parsed.state, original);
		assert.notEqual(parsed.state, original);
		assert.notEqual(parsed.state?.activeBlocks, original.activeBlocks);
	});

	it("rejects malformed and future-version state", () => {
		assert.match(parseStateSnapshot({ version: 2, nextBlockNumber: 1, activeBlocks: [] }).errors[0], /unsupported/);
		assert.match(parseStateSnapshot({ version: 1, nextBlockNumber: 0, activeBlocks: [] }).errors[0], /positive/);
		assert.match(parseStateSnapshot({ version: 1, nextBlockNumber: 2, activeBlocks: [{ id: "b1" }] }).errors.join(" "), /summary/);
	});

	it("rejects duplicate IDs and non-monotonic block numbering", () => {
		const block = snapshot(2).activeBlocks[0];
		const duplicate = parseStateSnapshot({ version: 1, nextBlockNumber: 3, activeBlocks: [block, { ...block }] });
		assert.match(duplicate.errors.join(" "), /duplicate/);

		const nonMonotonic = parseStateSnapshot({
			version: 1,
			nextBlockNumber: 2,
			activeBlocks: [{ ...block, id: "b2" }],
		});
		assert.match(nonMonotonic.errors.join(" "), /greater than every active block/);
	});

	it("restores the latest valid snapshot on the supplied branch", () => {
		const branch: SessionEntry[] = [
			customEntry("old", snapshot(2)),
			customEntry("new", snapshot(3, "b2"), "old"),
		];
		const restored = restoreLatestState(branch);
		assert.equal(restored.sourceEntryId, "new");
		assert.equal(restored.state.nextBlockNumber, 3);
	});

	it("skips malformed latest entries and records them for later repair", () => {
		const branch: SessionEntry[] = [
			customEntry("valid", snapshot(2)),
			customEntry("invalid", { version: 99 }, "valid"),
		];
		const restored = restoreLatestState(branch);
		assert.equal(restored.sourceEntryId, "valid");
		assert.deepEqual(restored.invalidEntryIds, ["invalid"]);
	});

	it("returns empty state when the branch has no valid DCP entry", () => {
		assert.deepEqual(restoreLatestState([]).state, createEmptyState());
	});

	it("persists a validated cloned snapshot", () => {
		const appended: Array<{ type: string; data: unknown }> = [];
		const pi = {
			appendEntry(type: string, data?: unknown) {
				appended.push({ type, data });
			},
		} as Pick<ExtensionAPI, "appendEntry">;
		const state = snapshot(2);
		appendStateSnapshot(pi, state);
		state.activeBlocks[0].summary = "mutated later";

		assert.equal(appended[0].type, DCP_STATE_ENTRY_TYPE);
		assert.equal((appended[0].data as DcpStateSnapshot).activeBlocks[0].summary, "summary");
	});

	it("state store restores, replaces, and persists current state", () => {
		let persisted: unknown;
		const store = createStateStore({ appendEntry: (_type, data) => { persisted = data; } });
		store.restore([customEntry("state", snapshot(2))]);
		assert.equal(store.get().nextBlockNumber, 2);
		store.replace(snapshot(3, "b2"));
		store.persist();
		assert.equal((persisted as DcpStateSnapshot).nextBlockNumber, 3);
	});
});
