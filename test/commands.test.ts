import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	inspectActiveBlocks,
	prepareDecompression,
	registerDcpCommand,
} from "../lib/commands.js";
import { applyCompressionOverlay } from "../lib/compression.js";
import { buildMessageMap } from "../lib/message-map.js";
import { createStateStore } from "../lib/persistence.js";
import { DCP_STATE_ENTRY_TYPE, restoreLatestState } from "../lib/state.js";
import type { DcpStateSnapshot } from "../lib/types.js";

function setup() {
	const manager = SessionManager.inMemory("/tmp/pi-dcp-commands");
	const sourceId = manager.appendMessage({ role: "user", content: "source text", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "current text", timestamp: 2 });
	const state: DcpStateSnapshot = {
		version: 1,
		nextBlockNumber: 2,
		activeBlocks: [{
			id: "b1",
			startEntryId: sourceId,
			endEntryId: sourceId,
			summary: "source summary",
			topic: "investigation",
			createdAt: 1,
		}],
	};
	return { manager, sourceId, state };
}

describe("DCP context and decompress commands", () => {
	it("lists only active blocks whose raw source is still restorable", () => {
		const { manager, state } = setup();
		assert.deepEqual(inspectActiveBlocks(manager.buildContextEntries(), state).map((item) => item.restorable), [true]);

		const currentId = manager.getLeafId() as string;
		manager.appendCompaction("native summary", currentId, 100);
		const stale = inspectActiveBlocks(manager.buildContextEntries(), state);
		assert.equal(stale[0].restorable, false);
		assert.match(stale[0].reason ?? "", /outside the current context/);
	});

	it("removes a restorable block while preserving monotonic numbering", () => {
		const { manager, state } = setup();
		const result = prepareDecompression(manager.buildContextEntries(), state, "b1");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.state.nextBlockNumber, 2);
		assert.deepEqual(result.state.activeBlocks, []);
		assert.equal(manager.getEntries()[0].type, "message", "source history was changed");

		const mapped = buildMessageMap(manager.buildContextEntries(), manager.buildSessionContext().messages);
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		const compressed = applyCompressionOverlay(mapped.value, state);
		const restored = applyCompressionOverlay(mapped.value, result.state);
		assert.doesNotMatch(JSON.stringify(compressed.messages), /source text/);
		assert.match(JSON.stringify(restored.messages), /source text/);
	});

	it("does not claim success for unknown or native-compacted blocks", () => {
		const { manager, state } = setup();
		const unknown = prepareDecompression(manager.buildContextEntries(), state, "b9");
		assert.equal(unknown.ok, false);
		if (!unknown.ok) assert.match(unknown.message, /Unknown/);

		const currentId = manager.getLeafId() as string;
		manager.appendCompaction("native summary", currentId, 100);
		const stale = prepareDecompression(manager.buildContextEntries(), state, "b1");
		assert.equal(stale.ok, false);
		if (!stale.ok) assert.match(stale.message, /native compaction/);
	});

	it("registers /dcp context, listing, and persistent decompress behavior", async () => {
		const { manager, state } = setup();
		const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		store.replace(state);
		let command: {
			handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
			getArgumentCompletions?: (prefix: string) => unknown;
		} | undefined;
		registerDcpCommand({
			registerCommand(name, options) {
				assert.equal(name, "dcp");
				command = options;
			},
		} as Pick<ExtensionAPI, "registerCommand">, store);
		assert.ok(command);
		assert.ok(command.getArgumentCompletions?.("decompress"));

		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			sessionManager: manager,
			ui: { notify: (message: string, level: string) => { notifications.push({ message, level }); } },
		} as unknown as ExtensionCommandContext;
		await command.handler("context", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /b1 — investigation/);

		await command.handler("decompress", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /decompress <block-id>/);
		assert.equal(store.get().activeBlocks.length, 1);

		await command.handler("decompress b1", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /Decompressed b1/);
		assert.equal(store.get().activeBlocks.length, 0);
		assert.equal(manager.getBranch().at(-1)?.type, "custom");
	});

	it("keeps decompression branch-local", () => {
		const { manager, state } = setup();
		const activeStateId = manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, state);
		const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		store.restore(manager.getBranch());
		const decompressed = prepareDecompression(manager.buildContextEntries(), store.get(), "b1");
		assert.equal(decompressed.ok, true);
		if (!decompressed.ok) return;
		store.commit(decompressed.state);
		assert.equal(restoreLatestState(manager.getBranch()).state.activeBlocks.length, 0);

		manager.branch(activeStateId);
		manager.appendMessage({ role: "user", content: "sibling continuation", timestamp: 3 });
		assert.deepEqual(restoreLatestState(manager.getBranch()).state.activeBlocks.map((block) => block.id), ["b1"]);
	});
});
