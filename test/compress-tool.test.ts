import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompressTool } from "../lib/compress-tool.js";
import { applyCompressionOverlay } from "../lib/compression.js";
import { buildMessageMap } from "../lib/message-map.js";
import { createStateStore } from "../lib/persistence.js";

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test" as never,
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

function setup() {
	const manager = SessionManager.inMemory("/tmp/pi-dcp-compress-tool");
	manager.appendMessage({ role: "user", content: "old ".repeat(1_000), timestamp: 1 });
	manager.appendMessage(assistant("old answer ".repeat(1_000)));
	const anchorLeafId = manager.appendMessage({ role: "user", content: "current work", timestamp: 3 });
	const mapped = buildMessageMap(manager.buildContextEntries(), manager.buildSessionContext().messages);
	if (!mapped.ok) throw new Error(mapped.reason);
	const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
	const snapshot = { map: mapped.value, sessionId: manager.getSessionId(), anchorLeafId };
	return { manager, store, snapshot };
}

describe("compress tool", () => {
	it("executes sequentially against the exact request snapshot", async () => {
		const { manager, store, snapshot } = setup();
		const tool = createCompressTool(store, () => snapshot);
		assert.equal(tool.executionMode, "sequential");
		const result = await tool.execute("compress-call-1", {
			ranges: [{ startId: "m001", endId: "m002", summary: "Preserved old investigation." }],
		}, undefined, undefined, { sessionManager: manager } as unknown as ExtensionContext);

		assert.equal(result.details.ok, true);
		assert.deepEqual(result.details?.blockIds, ["b1"]);
		assert.equal(store.get().activeBlocks[0].creatorToolCallId, "compress-call-1");
		assert.equal(manager.getBranch().at(-1)?.type, "custom");

		const rebuilt = buildMessageMap(manager.buildContextEntries(), manager.buildSessionContext().messages);
		assert.equal(rebuilt.ok, true);
		if (!rebuilt.ok) return;
		const overlay = applyCompressionOverlay(rebuilt.value, store.get());
		assert.equal(overlay.ok, true);
		assert.match(JSON.stringify(overlay.messages), /Preserved old investigation/);
		assert.doesNotMatch(JSON.stringify(overlay.messages), /old old old/);
	});

	it("rejects a snapshot after switching to a sibling branch", async () => {
		const { manager, store, snapshot } = setup();
		const firstId = manager.getEntries()[0].id;
		manager.branch(firstId);
		manager.appendMessage({ role: "user", content: "sibling", timestamp: 4 });

		const tool = createCompressTool(store, () => snapshot);
		const result = await tool.execute("stale-call", {
			ranges: [{ startId: "m001", endId: "m002", summary: "Should not commit." }],
		}, undefined, undefined, { sessionManager: manager } as unknown as ExtensionContext);
		assert.equal(result.details.ok, false);
		assert.match(JSON.stringify(result.content), /stale|another branch/);
		assert.equal(store.get().activeBlocks.length, 0);
	});
});
