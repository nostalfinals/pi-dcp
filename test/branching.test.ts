import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DCP_STATE_ENTRY_TYPE, restoreLatestState } from "../lib/state.js";
import type { DcpStateSnapshot } from "../lib/types.js";

const temporaryDirectories: string[] = [];

function state(nextBlockNumber: number, summary: string): DcpStateSnapshot {
	return {
		version: 1,
		nextBlockNumber,
		activeBlocks: [{
			id: `b${nextBlockNumber - 1}`,
			startEntryId: "start",
			endEntryId: "end",
			summary,
			createdAt: 1,
		}],
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("branch-aware state with Pi SessionManager", () => {
	it("survives reopening a persisted Pi session", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-dcp-resume-"));
		temporaryDirectories.push(root);
		const sessions = join(root, "sessions");
		const manager = SessionManager.create(join(root, "project"), sessions);
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, state(2, "persisted"));
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ready" }],
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
			timestamp: Date.now(),
		});

		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile);
		const reopened = SessionManager.open(sessionFile, sessions);
		assert.equal(restoreLatestState(reopened.getBranch()).state.activeBlocks[0].summary, "persisted");
	});

	it("does not leak a sibling branch's latest snapshot", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-dcp-branch-"));
		temporaryDirectories.push(root);
		const manager = SessionManager.create(join(root, "project"), join(root, "sessions"));

		const commonId = manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, { version: 1, nextBlockNumber: 1, activeBlocks: [] });
		const branchAId = manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, state(2, "branch A"));

		manager.branch(commonId);
		const branchBId = manager.appendCustomEntry(DCP_STATE_ENTRY_TYPE, state(2, "branch B"));
		assert.equal(restoreLatestState(manager.getBranch()).state.activeBlocks[0].summary, "branch B");

		manager.branch(branchAId);
		assert.equal(restoreLatestState(manager.getBranch()).state.activeBlocks[0].summary, "branch A");

		manager.branch(branchBId);
		assert.equal(restoreLatestState(manager.getBranch()).state.activeBlocks[0].summary, "branch B");
	});
});
