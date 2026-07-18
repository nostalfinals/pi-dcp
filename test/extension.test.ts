import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import dcpExtension from "../index.js";
import type { AgentMessage } from "../lib/message-map.js";

function registeredHandlers() {
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const pi = {
		appendEntry() {},
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	dcpExtension(pi);
	return handlers;
}

function assistant(content: unknown[]): AgentMessage {
	return {
		role: "assistant" as const,
		content,
		api: "test" as never,
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: 1,
	} as AgentMessage;
}

describe("extension message finalization", () => {
	it("removes model-emitted DCP-only assistant markers before persistence", async () => {
		const handlers = registeredHandlers();
		const message = assistant([
			{ type: "text", text: '<dcp-message id="m123" />\n' },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
		]);
		const result = await handlers.get("message_end")?.[0](
			{ type: "message_end", message } as never,
			{} as ExtensionContext,
		) as { message?: { content: unknown[] } } | undefined;

		assert.equal(result?.message?.content.length, 1);
		assert.doesNotMatch(JSON.stringify(result?.message), /dcp-message/);
	});

	it("removes inline model-emitted markers before persistence", async () => {
		const handlers = registeredHandlers();
		const message = assistant([{ type: "text", text: 'before <dcp-message id="m123" /> after' }]);
		const result = await handlers.get("message_end")?.[0](
			{ type: "message_end", message } as never,
			{} as ExtensionContext,
		) as { message?: { content: Array<{ type: string; text: string }> } } | undefined;

		assert.equal(result?.message?.content[0]?.text, "before  after");
	});

	it("adds a per-run system instruction that forbids reproducing markers", async () => {
		const handlers = registeredHandlers();
		const result = await handlers.get("before_agent_start")?.[0](
			{ type: "before_agent_start", systemPrompt: "base" } as never,
			{} as ExtensionContext,
		) as { systemPrompt?: string } | undefined;

		assert.match(result?.systemPrompt ?? "", /^base/);
		assert.match(result?.systemPrompt ?? "", /read-only metadata/);
		assert.match(result?.systemPrompt ?? "", /reference only their IDs/);
		assert.match(result?.systemPrompt ?? "", /never output, quote, or reproduce/);
	});

	it("leaves ordinary assistant messages unchanged", async () => {
		const handlers = registeredHandlers();
		const message = assistant([{ type: "text", text: "normal output" }]);
		const result = await handlers.get("message_end")?.[0](
			{ type: "message_end", message } as never,
			{} as ExtensionContext,
		);
		assert.equal(result, undefined);
	});
});
