import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SessionManager,
	sessionEntryToContextMessages,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	buildMessageMap,
	estimateMessageTokens,
	stripMessageAnnotation,
	type AgentMessage,
} from "../lib/message-map.js";

const ISO = "2026-01-01T00:00:00.000Z";
let entryNumber = 0;

function entry(overrides: Record<string, unknown>): SessionEntry {
	entryNumber += 1;
	return {
		id: `entry-${entryNumber}`,
		parentId: entryNumber === 1 ? null : `entry-${entryNumber - 1}`,
		timestamp: ISO,
		...overrides,
	} as SessionEntry;
}

function userEntry(text: string): SessionEntry {
	return entry({ type: "message", message: { role: "user", content: text, timestamp: 1 } });
}

function messagesFor(entries: SessionEntry[]): AgentMessage[] {
	return entries.flatMap(sessionEntryToContextMessages);
}

describe("message mapping", () => {
	it("maps every context-producing Pi entry and ignores state-only entries", () => {
		entryNumber = 0;
		const entries: SessionEntry[] = [
			userEntry("hello"),
			entry({ type: "thinking_level_change", thinkingLevel: "high" }),
			entry({ type: "model_change", provider: "test", modelId: "model" }),
			entry({ type: "custom", customType: "pi-dcp-state", data: { version: 1 } }),
			entry({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reason", thinkingSignature: "signed" },
						{ type: "text", text: "answer" },
					],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: 2,
				},
			}),
			entry({
				type: "custom_message",
				customType: "fixture",
				content: [{ type: "text", text: "custom" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				display: false,
			}),
			entry({ type: "branch_summary", fromId: "old", summary: "branch summary" }),
			entry({ type: "compaction", summary: "compact summary", firstKeptEntryId: "kept", tokensBefore: 100 }),
		];
		const outbound = messagesFor(entries);
		const original = structuredClone(outbound);
		const result = buildMessageMap(entries, outbound);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.value.mappedMessages.map((item) => item.alias), ["m001", "m002", "m003", "m004", "m005"]);
		assert.deepEqual(result.value.mappedMessages.map((item) => item.entryId), [entries[0].id, entries[4].id, entries[5].id, entries[6].id, entries[7].id]);
		assert.deepEqual(outbound, original, "session-owned outbound messages were mutated");

		const assistant = result.value.messages[1];
		assert.equal(assistant.role, "assistant");
		if (assistant.role === "assistant") {
			assert.equal(assistant.content[0].type, "thinking", "signed thinking must remain first");
			assert.deepEqual(assistant.content[1], { type: "text", text: '<dcp-message id="m002" />\n' });
			assert.deepEqual(assistant.content[2], { type: "text", text: "answer" });
			assert.deepEqual(stripMessageAnnotation(assistant), outbound[1]);
		}
		assert.match(JSON.stringify(result.value.messages[2]), /dcp-message id=\\"m003/);
		assert.doesNotMatch(JSON.stringify(result.value.messages[2]), /previous-assistant-id/);
		assert.match(JSON.stringify(result.value.messages[3]), /dcp-message id=\\"m004/);
		assert.match(JSON.stringify(result.value.messages[4]), /dcp-message id=\\"m005/);
	});

	it("annotates image messages without changing image payloads", () => {
		entryNumber = 0;
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
		const entries = [entry({
			type: "message",
			message: { role: "user", content: [image], timestamp: 1 },
		})];
		const mapped = buildMessageMap(entries, messagesFor(entries));
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		const message = mapped.value.messages[0];
		assert.equal(message.role, "user");
		if (message.role === "user" && Array.isArray(message.content)) {
			assert.deepEqual(message.content[0], { type: "text", text: '<dcp-message id="m001" />\n' });
			assert.deepEqual(message.content[1], image);
		}
	});

	it("annotates tool-calling assistant messages before the first tool call", () => {
		entryNumber = 0;
		const entries = [entry({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } }],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
		})];
		const mapped = buildMessageMap(entries, messagesFor(entries));
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		const message = mapped.value.messages[0];
		assert.equal(message.role, "assistant");
		if (message.role === "assistant") {
			assert.deepEqual(message.content[0], { type: "text", text: '<dcp-message id="m001" />\n' });
			assert.equal(message.content[1]?.type, "toolCall");
		}
	});

	it("maps legacy assistant marker pollution and reapplies the current alias", () => {
		entryNumber = 0;
		const entries = [entry({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: '<dcp-message id="m777" />\n' },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
		})];
		const mapped = buildMessageMap(entries, messagesFor(entries));
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		assert.match(JSON.stringify(mapped.value.messages[0]), /dcp-message id=\\"m001/);
		assert.doesNotMatch(JSON.stringify(mapped.value.messages[0]), /m777/);
	});

	it("strips inline model-emitted assistant markers", () => {
		const raw = {
			role: "assistant",
			content: [{ type: "text", text: 'before <dcp-message id="m123" /> after' }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		} as AgentMessage;
		const stripped = stripMessageAnnotation(raw);
		assert.equal(stripped.role, "assistant");
		if (stripped.role === "assistant") assert.deepEqual(stripped.content, [{ type: "text", text: "before  after" }]);
	});

	it("aligns Pi's native compaction-aware SessionManager context", () => {
		const manager = SessionManager.inMemory("/tmp/pi-dcp-message-map");
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		manager.appendCustomEntry("pi-dcp-state", { version: 1 });
		const compactionId = manager.appendCompaction("native summary", keptId, 500);

		const entries = manager.buildContextEntries();
		const outbound = manager.buildSessionContext().messages;
		const mapped = buildMessageMap(entries, outbound);
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		assert.deepEqual(mapped.value.mappedMessages.map((item) => item.entryId), [compactionId, keptId]);
	});

	it("keeps existing aliases stable when message count grows past 999", () => {
		entryNumber = 0;
		const entries = Array.from({ length: 999 }, (_, index) => userEntry(`message ${index + 1}`));
		const before = buildMessageMap(entries, messagesFor(entries));
		assert.equal(before.ok, true);
		if (!before.ok) return;
		assert.equal(before.value.mappedMessages[0].alias, "m001");
		assert.equal(before.value.mappedMessages[998].alias, "m999");

		entries.push(userEntry("message 1000"));
		const after = buildMessageMap(entries, messagesFor(entries));
		assert.equal(after.ok, true);
		if (!after.ok) return;
		assert.equal(after.value.mappedMessages[0].alias, "m001");
		assert.equal(after.value.mappedMessages[998].alias, "m999");
		assert.equal(after.value.mappedMessages[999].alias, "m1000");
	});

	it("is idempotent across repeated context passes", () => {
		entryNumber = 0;
		const entries = [userEntry("one"), userEntry("two")];
		const first = buildMessageMap(entries, messagesFor(entries));
		assert.equal(first.ok, true);
		if (!first.ok) return;
		const second = buildMessageMap(entries, first.value.messages);
		assert.equal(second.ok, true);
		if (!second.ok) return;

		assert.deepEqual(second.value.messages, first.value.messages);
		assert.equal((JSON.stringify(second.value.messages).match(/dcp-message/g) ?? []).length, 2);
	});

	it("strips only DCP annotations and recovers the original message", () => {
		entryNumber = 0;
		const entries = [userEntry("body")];
		const mapped = buildMessageMap(entries, messagesFor(entries));
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		assert.deepEqual(stripMessageAnnotation(mapped.value.messages[0]), messagesFor(entries)[0]);
	});

	it("fails open on unexplained insertions and modifications", () => {
		entryNumber = 0;
		const entries = [userEntry("original")];
		const inserted = [...messagesFor(entries), { role: "user", content: "extra", timestamp: 2 } as AgentMessage];
		const countMismatch = buildMessageMap(entries, inserted);
		assert.equal(countMismatch.ok, false);
		if (!countMismatch.ok) assert.equal(countMismatch.messages, inserted);

		const modified = [{ role: "user", content: "modified", timestamp: 1 } as AgentMessage];
		const contentMismatch = buildMessageMap(entries, modified);
		assert.equal(contentMismatch.ok, false);
		if (!contentMismatch.ok) {
			assert.equal(contentMismatch.messages, modified);
			assert.match(contentMismatch.reason, /does not match/);
		}
	});

	it("estimates raw content without charging DCP annotations", () => {
		const raw = { role: "user", content: "x".repeat(400), timestamp: 1 } as AgentMessage;
		entryNumber = 0;
		const entries = [entry({ type: "message", message: raw })];
		const mapped = buildMessageMap(entries, [raw]);
		assert.equal(mapped.ok, true);
		if (!mapped.ok) return;
		assert.equal(estimateMessageTokens(mapped.value.messages[0]), estimateMessageTokens(raw));
		assert.ok(estimateMessageTokens(raw) >= 100);
	});
});
