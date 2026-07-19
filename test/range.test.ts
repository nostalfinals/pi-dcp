import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildMessageMap, type AgentMessage, type MessageMap } from "../lib/message-map.js";
import { findToolProtocolIssues, normalizeRange } from "../lib/range.js";

let sequence = 0;

function assistant(content: unknown[]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((block) => (block as { type?: string }).type === "toolCall") ? "toolUse" : "stop",
		timestamp: sequence,
	} as AgentMessage;
}

function toolResult(toolCallId: string, toolName = "read"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: `result for ${toolCallId}` }],
		isError: false,
		timestamp: sequence,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: sequence };
}

function mapMessages(messages: AgentMessage[]): MessageMap {
	sequence = 0;
	const entries = messages.map((message, index) => {
		sequence += 1;
		return {
			type: "message",
			id: `entry-${sequence}`,
			parentId: index === 0 ? null : `entry-${sequence - 1}`,
			timestamp: "2026-01-01T00:00:00.000Z",
			message,
		} as SessionEntry;
	});
	const mapped = buildMessageMap(entries, messages);
	if (!mapped.ok) throw new Error(`message mapping failed: ${mapped.reason}`);
	return mapped.value;
}

describe("safe range normalization", () => {
	it("resolves a plain closed range and estimates its raw size", () => {
		const map = mapMessages([user("one"), assistant([{ type: "text", text: "two" }]), user("three")]);
		const result = normalizeRange(map, "m001", "m002");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.startEntryId, "entry-1");
		assert.equal(result.value.endEntryId, "entry-2");
		assert.deepEqual(result.value.messageAliases, ["m001", "m002"]);
		assert.ok(result.value.estimatedTokens > 0);
	});

	it("expands a result endpoint to include its sequential assistant call", () => {
		const map = mapMessages([
			user("before"),
			assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } }]),
			toolResult("call-1"),
			assistant([{ type: "text", text: "done" }]),
			user("after"),
		]);
		const result = normalizeRange(map, "m003", "m004");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.value.startAlias, "m002");
		assert.equal(result.value.endAlias, "m004");
		assert.deepEqual(result.value.messageAliases, ["m002", "m003", "m004"]);
	});

	it("keeps a parallel tool batch atomic", () => {
		const map = mapMessages([
			user("before"),
			assistant([
				{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } },
			]),
			toolResult("call-a"),
			toolResult("call-b"),
			user("after"),
		]);
		const result = normalizeRange(map, "m003", "m003");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.messageAliases, ["m002", "m003", "m004"]);

		const remaining = map.mappedMessages
			.filter((item) => item.messageIndex < result.value.startMessageIndex || item.messageIndex > result.value.endMessageIndex)
			.map((item) => item.message);
		assert.deepEqual(findToolProtocolIssues(remaining), []);
		assert.deepEqual(findToolProtocolIssues(convertToLlm(map.messages)), []);
	});

	it("rejects interleaved tool batches that providers cannot replay safely", () => {
		const map = mapMessages([
			assistant([{ type: "toolCall", id: "outer", name: "read", arguments: {} }]),
			assistant([{ type: "toolCall", id: "inner", name: "read", arguments: {} }]),
			toolResult("inner"),
			toolResult("outer"),
			user("after"),
		]);
		const result = normalizeRange(map, "m003", "m003");
		assert.equal(result.ok, false);
	});

	it("rejects missing, stale, reversed, and cross-branch aliases", () => {
		const current = mapMessages([user("current")]);
		const missing = normalizeRange(current, "m999", "m001");
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.equal(missing.error.code, "missing_start");
		assert.equal(normalizeRange(current, "m001", "m002").ok, false);

		const two = mapMessages([user("one"), user("two")]);
		const reversed = normalizeRange(two, "m002", "m001");
		assert.equal(reversed.ok, false);
		if (!reversed.ok) assert.equal(reversed.error.code, "reversed_range");

		const siblingBranch = mapMessages([user("sibling")]);
		const crossBranch = normalizeRange(siblingBranch, "m001", "m002");
		assert.equal(crossBranch.ok, false);
	});

	it("rejects malformed tool history rather than risking an orphan", () => {
		const orphan = mapMessages([user("before"), toolResult("missing"), user("after")]);
		const orphanResult = normalizeRange(orphan, "m001", "m003");
		assert.equal(orphanResult.ok, false);
		if (!orphanResult.ok) assert.equal(orphanResult.error.code, "unsafe_tool_protocol");

		const incomplete = mapMessages([
			assistant([{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "sleep" } }]),
			user("next"),
		]);
		const incompleteResult = normalizeRange(incomplete, "m001", "m002");
		assert.equal(incompleteResult.ok, false);
	});
});
