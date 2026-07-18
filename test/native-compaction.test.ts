import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionCompactEvent,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import dcpExtension from "../index.js";
import { inspectActiveBlocks, prepareDecompression } from "../lib/commands.js";
import { reconcileCompactionState, reconcileStateStore } from "../lib/compaction-sync.js";
import { prepareCompression } from "../lib/compression.js";
import { buildMessageMap } from "../lib/message-map.js";
import { createStateStore } from "../lib/persistence.js";
import { DCP_STATE_ENTRY_TYPE, restoreLatestState } from "../lib/state.js";
import type { CompressionBlock, DcpStateSnapshot } from "../lib/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function block(id: string, startEntryId: string, endEntryId: string): CompressionBlock {
	return {
		id,
		startEntryId,
		endEntryId,
		summary: `summary for ${id}`,
		createdAt: 1,
	};
}

function scenario() {
	const manager = SessionManager.inMemory("/tmp/pi-dcp-native-compaction");
	const ids = Array.from({ length: 8 }, (_, index) => manager.appendMessage({
		role: "user",
		content: `source message ${index + 1}`,
		timestamp: index + 1,
	}));
	const state: DcpStateSnapshot = {
		version: 1,
		nextBlockNumber: 4,
		activeBlocks: [
			block("b1", ids[0], ids[1]),
			block("b2", ids[2], ids[4]),
			block("b3", ids[5], ids[6]),
		],
	};
	manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, state);
	manager.appendCompaction("native summary one", ids[3], 10_000);
	return { manager, ids, state };
}

function extensionContext(manager: SessionManager, cwd = "/tmp/pi-dcp-native-compaction"): ExtensionContext {
	return {
		cwd,
		sessionManager: manager,
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
}

describe("native compaction reconciliation", () => {
	it("retires fully consumed and boundary-crossing blocks while retaining the complete tail", () => {
		const { manager, state } = scenario();
		const result = reconcileCompactionState(manager.buildContextEntries(), state);
		assert.equal(result.changed, true);
		assert.deepEqual(result.retired.map((item) => [item.block.id, item.reason]), [
			["b1", "source-consumed"],
			["b2", "boundary-crossing"],
		]);
		assert.deepEqual(result.state.activeBlocks.map((item) => item.id), ["b3"]);
		assert.equal(result.state.nextBlockNumber, 4);
		assert.deepEqual(inspectActiveBlocks(manager.buildContextEntries(), result.state).map((item) => item.restorable), [true]);
	});

	it("persists one bounded cleanup snapshot and does not grow state on repeated reconciliation", () => {
		const { manager, state } = scenario();
		const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		store.replace(state);
		const before = manager.getEntries().filter((entry) => entry.type === "custom").length;
		const first = reconcileStateStore(manager.buildContextEntries(), store);
		assert.equal(first.changed, true);
		assert.deepEqual(store.get().activeBlocks.map((item) => item.id), ["b3"]);
		assert.equal(manager.getEntries().filter((entry) => entry.type === "custom").length, before + 1);

		const second = reconcileStateStore(manager.buildContextEntries(), store);
		assert.equal(second.changed, false);
		assert.equal(manager.getEntries().filter((entry) => entry.type === "custom").length, before + 1);
	});

	it("does not advance in-memory state when cleanup persistence fails", () => {
		const { manager, state } = scenario();
		const store = createStateStore({ appendEntry: () => { throw new Error("disk full"); } });
		store.replace(state);
		assert.throws(() => reconcileStateStore(manager.buildContextEntries(), store), /disk full/);
		assert.deepEqual(store.get().activeBlocks.map((item) => item.id), ["b1", "b2", "b3"]);
	});

	it("keeps active state bounded through repeated native compactions", () => {
		const { manager, ids, state } = scenario();
		const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		store.replace(state);
		reconcileStateStore(manager.buildContextEntries(), store);
		assert.deepEqual(store.get().activeBlocks.map((item) => item.id), ["b3"]);

		manager.appendCompaction("native summary two", ids[7], 8_000);
		const second = reconcileStateStore(manager.buildContextEntries(), store);
		assert.deepEqual(second.retired.map((item) => item.block.id), ["b3"]);
		assert.deepEqual(store.get().activeBlocks, []);
		assert.equal(store.get().nextBlockNumber, 4);

		const decompressed = prepareDecompression(manager.buildContextEntries(), store.get(), "b3");
		assert.equal(decompressed.ok, false);
		assert.equal(reconcileStateStore(manager.buildContextEntries(), store).changed, false);
	});

	it("keeps state bounded across repeated real DCP preparation and Pi compaction cycles", () => {
		const manager = SessionManager.inMemory("/tmp/pi-dcp-native-cycles");
		const ids = Array.from({ length: 9 }, (_, index) => manager.appendMessage({
			role: "user",
			content: `completed phase ${index + 1}: ${"detail ".repeat(400)}`,
			timestamp: index + 1,
		}));
		const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		const firstMap = buildMessageMap(manager.buildContextEntries(), manager.buildSessionContext().messages);
		assert.equal(firstMap.ok, true);
		if (!firstMap.ok) return;
		const firstDcp = prepareCompression(firstMap.value, store.get(), [
			{ startId: "m001", endId: "m002", summary: "phases 1-2 complete" },
			{ startId: "m003", endId: "m005", summary: "phases 3-5 complete" },
			{ startId: "m006", endId: "m008", summary: "phases 6-8 complete" },
		], "first-compress", 10);
		assert.equal(firstDcp.ok, true);
		if (!firstDcp.ok) return;
		store.commit(firstDcp.value.state);
		assert.equal(store.get().activeBlocks.length, 3);

		manager.appendCompaction("native cycle one", ids[3], 30_000);
		reconcileStateStore(manager.buildContextEntries(), store);
		assert.deepEqual(store.get().activeBlocks.map((item) => item.id), ["b3"]);

		const currentId = manager.appendMessage({ role: "user", content: "new active phase", timestamp: 20 });
		const secondMap = buildMessageMap(manager.buildContextEntries(), manager.buildSessionContext().messages);
		assert.equal(secondMap.ok, true);
		if (!secondMap.ok) return;
		const startAlias = secondMap.value.byEntryId.get(ids[3])?.alias;
		const endAlias = secondMap.value.byEntryId.get(ids[4])?.alias;
		assert.ok(startAlias && endAlias);
		const secondDcp = prepareCompression(secondMap.value, store.get(), [{
			startId: startAlias,
			endId: endAlias,
			summary: "retained phases 4-5 complete",
		}], "second-compress", 30);
		assert.equal(secondDcp.ok, true);
		if (!secondDcp.ok) return;
		store.commit(secondDcp.value.state);
		assert.deepEqual(store.get().activeBlocks.map((item) => item.id), ["b3", "b4"]);

		manager.appendCompaction("native cycle two", currentId, 20_000);
		reconcileStateStore(manager.buildContextEntries(), store);
		assert.deepEqual(store.get().activeBlocks, []);
		assert.equal(store.get().nextBlockNumber, 5);
		for (const entry of manager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== DCP_STATE_ENTRY_TYPE) continue;
			const snapshot = entry.data as DcpStateSnapshot;
			assert.ok(snapshot.activeBlocks.length <= 3, "a complete snapshot accumulated inactive blocks");
		}
	});

	it("repairs stale state after a persisted session is resumed or reloaded", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-dcp-native-resume-"));
		temporaryDirectories.push(root);
		const sessions = join(root, "sessions");
		const manager = SessionManager.create(join(root, "project"), sessions);
		const consumedId = manager.appendMessage({ role: "user", content: "consumed", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "completed old work" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
		const stale: DcpStateSnapshot = {
			version: 1,
			nextBlockNumber: 2,
			activeBlocks: [block("b1", consumedId, consumedId)],
		};
		manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, stale);
		manager.appendCompaction("native summary", keptId, 5_000);
		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile);

		const resumed = SessionManager.open(sessionFile, sessions);
		const store = createStateStore({ appendEntry: (type, data) => { resumed.appendCustomEntry(type, data); } });
		store.restore(resumed.getBranch());
		assert.deepEqual(store.get().activeBlocks.map((item) => item.id), ["b1"]);
		reconcileStateStore(resumed.buildContextEntries(), store);
		assert.deepEqual(store.get().activeBlocks, []);

		const reloaded = SessionManager.open(sessionFile, sessions);
		assert.deepEqual(restoreLatestState(reloaded.getBranch()).state.activeBlocks, []);
		assert.equal(restoreLatestState(reloaded.getBranch()).state.nextBlockNumber, 2);
	});

	it("runs the same cleanup immediately from the extension session_compact event", async () => {
		const manager = SessionManager.inMemory("/tmp/pi-dcp-native-event");
		const sourceId = manager.appendMessage({ role: "user", content: "old source", timestamp: 1 });
		const keptId = manager.appendMessage({ role: "user", content: "kept source", timestamp: 2 });
		manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, {
			version: 1,
			nextBlockNumber: 2,
			activeBlocks: [block("b1", sourceId, sourceId)],
		} satisfies DcpStateSnapshot);

		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
		const pi = {
			appendEntry(type: string, data: unknown) { manager.appendCustomEntry(type, data); },
			registerTool() {},
			registerCommand() {},
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		dcpExtension(pi);
		const ctx = extensionContext(manager);
		await handlers.get("session_start")?.[0]({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, ctx);
		assert.deepEqual(restoreLatestState(manager.getBranch()).state.activeBlocks.map((item) => item.id), ["b1"]);

		const compactionId = manager.appendCompaction("native summary", keptId, 5_000);
		const compactionEntry = manager.getEntry(compactionId);
		assert.equal(compactionEntry?.type, "compaction");
		if (!compactionEntry || compactionEntry.type !== "compaction") return;
		await handlers.get("session_compact")?.[0]({
			type: "session_compact",
			compactionEntry,
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		} satisfies SessionCompactEvent, ctx);
		assert.deepEqual(restoreLatestState(manager.getBranch()).state.activeBlocks, []);
		assert.deepEqual(inspectActiveBlocks(manager.buildContextEntries(), restoreLatestState(manager.getBranch()).state), []);
	});
});
