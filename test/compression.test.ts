import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	applyCompressionOverlay,
	prepareCompression,
	type CompressionRangeInput,
} from "../lib/compression.js";
import { buildMessageMap, type AgentMessage, type MessageMap } from "../lib/message-map.js";
import { createStateStore } from "../lib/persistence.js";
import { createEmptyState } from "../lib/state.js";
import type { CompressionBlock, DcpStateSnapshot } from "../lib/types.js";

const temporaryDirectories: string[] = [];
let sequence = 0;

function user(text: string): AgentMessage {
	sequence += 1;
	return { role: "user", content: text, timestamp: sequence };
}

function assistant(content: unknown[]): AgentMessage {
	sequence += 1;
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((item) => (item as { type?: string }).type === "toolCall") ? "toolUse" : "stop",
		timestamp: sequence,
	} as AgentMessage;
}

function toolResult(id: string): AgentMessage {
	sequence += 1;
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: sequence };
}

function mapMessages(messages: AgentMessage[]): MessageMap {
	const entries = messages.map((message, index) => ({
		type: "message",
		id: `entry-${index + 1}`,
		parentId: index === 0 ? null : `entry-${index}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	} as SessionEntry));
	const mapped = buildMessageMap(entries, messages);
	if (!mapped.ok) throw new Error(mapped.reason);
	return mapped.value;
}

function long(label: string): string {
	return `${label}: ${label.repeat(700)}`;
}

function input(startId: string, endId: string, summary = "Concise preserved finding."): CompressionRangeInput {
	return { startId, endId, summary };
}

function stateWith(block: CompressionBlock): DcpStateSnapshot {
	return { version: 1, nextBlockNumber: Number(block.id.slice(1)) + 1, activeBlocks: [block] };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("compression preparation and outbound overlay", () => {
	it("prepares one old range and inserts its summary exactly once", () => {
		sequence = 0;
		const map = mapMessages([user(long("old user")), assistant([{ type: "text", text: long("old answer") }]), user("current work")]);
		const prepared = prepareCompression(map, createEmptyState(), [input("m001", "m002")], "tool-1", 100);
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;
		assert.equal(prepared.value.state.nextBlockNumber, 2);
		assert.equal(prepared.value.ranges[0].block.id, "b1");
		assert.ok(prepared.value.estimatedTokensSaved > 0);

		const overlay = applyCompressionOverlay(map, prepared.value.state);
		assert.equal(overlay.ok, true);
		const serialized = JSON.stringify(overlay.messages);
		assert.equal((serialized.match(/Concise preserved finding\./g) ?? []).length, 1);
		assert.doesNotMatch(serialized, /old userold user/);
		assert.match(serialized, /current work/);
	});

	it("validates and commits multiple disjoint ranges as one proposal", () => {
		sequence = 0;
		const map = mapMessages([
			user(long("range a")),
			assistant([{ type: "text", text: "separator" }]),
			user(long("range b")),
			assistant([{ type: "text", text: "older completion" }]),
			user("current"),
		]);
		const prepared = prepareCompression(map, createEmptyState(), [
			input("m001", "m001", "Summary A"),
			input("m003", "m003", "Summary B"),
		], "tool-multi", 200);
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;
		assert.deepEqual(prepared.value.ranges.map((item) => item.block.id), ["b1", "b2"]);
		assert.equal(prepared.value.state.nextBlockNumber, 3);

		const overlay = applyCompressionOverlay(map, prepared.value.state);
		assert.equal(overlay.ok, true);
		assert.equal((JSON.stringify(overlay.messages).match(/<dcp-compression id=/g) ?? []).length, 2);
	});

	it("rejects the whole request when any range is invalid or overlaps", () => {
		sequence = 0;
		const map = mapMessages([user(long("old")), assistant([{ type: "text", text: long("answer") }]), user("current")]);
		const invalid = prepareCompression(map, createEmptyState(), [
			input("m001", "m001"),
			input("m003", "m003"),
		], "tool-invalid");
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.match(invalid.errors.join(" "), /active work/);

		const overlapping = prepareCompression(map, createEmptyState(), [
			input("m001", "m002"),
			input("m002", "m002"),
		], "tool-overlap");
		assert.equal(overlapping.ok, false);
		if (!overlapping.ok) assert.match(overlapping.errors.join(" "), /overlaps ranges/);
	});

	it("protects the whole current tool loop as in-flight work", () => {
		sequence = 0;
		const map = mapMessages([
			user(long("old")),
			assistant([{ type: "text", text: long("old result") }]),
			user("current request"),
			assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "x" } }]),
			toolResult("read-1"),
		]);
		assert.equal(prepareCompression(map, createEmptyState(), [input("m001", "m002")], "safe").ok, true);
		const unsafe = prepareCompression(map, createEmptyState(), [input("m004", "m005")], "unsafe");
		assert.equal(unsafe.ok, false);
		if (!unsafe.ok) assert.match(unsafe.errors.join(" "), /active work/);
	});

	it("fails open if persisted boundaries would orphan a tool result", () => {
		sequence = 0;
		const map = mapMessages([
			user("old request"),
			assistant([{ type: "toolCall", id: "old-call", name: "read", arguments: { path: "x" } }]),
			toolResult("old-call"),
			user("current"),
		]);
		const corrupted = stateWith({
			id: "b1",
			startEntryId: "entry-2",
			endEntryId: "entry-2",
			summary: "unsafe partial group",
			createdAt: 1,
		});
		const overlay = applyCompressionOverlay(map, corrupted);
		assert.equal(overlay.ok, false);
		if (!overlay.ok) assert.match(overlay.errors.join(" "), /orphan/);
		assert.deepEqual(overlay.messages, map.messages);
	});

	it("rejects active-block overlap and uneconomic summaries", () => {
		sequence = 0;
		const map = mapMessages([user(long("old")), assistant([{ type: "text", text: long("answer") }]), user("current")]);
		const block: CompressionBlock = { id: "b1", startEntryId: "entry-1", endEntryId: "entry-1", summary: "existing", createdAt: 1 };
		const overlap = prepareCompression(map, stateWith(block), [input("m001", "m002")], "tool-2");
		assert.equal(overlap.ok, false);
		if (!overlap.ok) assert.match(overlap.errors.join(" "), /active block b1/);

		const hugeSummary = "summary".repeat(2_000);
		const uneconomic = prepareCompression(map, createEmptyState(), [input("m001", "m001", hugeSummary)], "tool-3");
		assert.equal(uneconomic.ok, false);
		if (!uneconomic.ok) assert.match(uneconomic.errors.join(" "), /not beneficial/);
	});

	it("scrubs historical compress summaries and is stable on fresh rebuilds", () => {
		sequence = 0;
		const historicalSummary = "SECRET HISTORICAL SUMMARY";
		const messages = [
			user(long("source")),
			assistant([{ type: "text", text: "old answer" }]),
			user("compress request"),
			assistant([{ type: "toolCall", id: "compress-1", name: "compress", arguments: { ranges: [{ startId: "m001", endId: "m002", summary: historicalSummary }] } }]),
			toolResult("compress-1"),
			user("new current work"),
		];
		const firstMap = mapMessages(messages);
		const block: CompressionBlock = {
			id: "b1",
			startEntryId: "entry-1",
			endEntryId: "entry-2",
			summary: historicalSummary,
			createdAt: 10,
			creatorToolCallId: "compress-1",
		};
		const state = stateWith(block);
		const first = applyCompressionOverlay(firstMap, state);
		assert.equal(first.ok, true);
		assert.equal((JSON.stringify(first.messages).match(/SECRET HISTORICAL SUMMARY/g) ?? []).length, 1);
		assert.match(JSON.stringify(first.messages), /stored in the corresponding DCP/);
		assert.equal((messages[3] as Extract<AgentMessage, { role: "assistant" }>).content[0].type, "toolCall");
		assert.match(JSON.stringify(messages[3]), /SECRET HISTORICAL SUMMARY/, "raw message was mutated");

		const rebuilt = applyCompressionOverlay(mapMessages(structuredClone(messages)), state);
		assert.deepEqual(rebuilt.messages, first.messages);
	});

	it("persists only a state entry while retaining source messages in the JSONL branch", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-dcp-compress-"));
		temporaryDirectories.push(root);
		const manager = SessionManager.create(join(root, "project"), join(root, "sessions"));
		const sourceText = long("JSONL-SOURCE-MARKER");
		const sourceId = manager.appendMessage({ role: "user", content: sourceText, timestamp: 1 });
		manager.appendMessage(assistant([{ type: "text", text: long("answer") }]) as Parameters<typeof manager.appendMessage>[0]);
		manager.appendMessage({ role: "user", content: "current", timestamp: 3 });
		const mapResult = buildMessageMap(manager.buildContextEntries(), manager.buildSessionContext().messages);
		assert.equal(mapResult.ok, true);
		if (!mapResult.ok) return;
		const prepared = prepareCompression(mapResult.value, createEmptyState(), [input("m001", "m002")], "persist-tool");
		assert.equal(prepared.ok, true);
		if (!prepared.ok) return;

		const store = createStateStore({ appendEntry: (type, data) => { manager.appendCustomEntry(type, data); } });
		store.commit(prepared.value.state);
		const source = manager.getEntry(sourceId);
		assert.equal(source?.type, "message");
		if (source?.type === "message" && source.message.role === "user") assert.equal(source.message.content, sourceText);
		assert.match(readFileSync(manager.getSessionFile() as string, "utf8"), /JSONL-SOURCE-MARKER/);
	});
});
