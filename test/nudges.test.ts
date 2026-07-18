import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../lib/message-map.js";
import {
	createNudgeController,
	estimateEffectiveContextTokens,
	estimateOutboundTokens,
	injectNudge,
	type NudgeEvaluationInput,
} from "../lib/nudges.js";
import type { DcpConfig } from "../lib/types.js";

const numericConfig: DcpConfig = { minCompressContext: 100, maxCompressContext: 200, debugMarkerTrace: false };

function input(
	leaf: string,
	tokens: number,
	config: DcpConfig = numericConfig,
	contextWindow = 1_000,
	latestUserEntryId = "user-1",
): NudgeEvaluationInput {
	return {
		config,
		contextWindow,
		estimatedTokens: tokens,
		sessionId: "session-1",
		requestLeafId: leaf,
		latestUserEntryId,
	};
}

describe("DCP nudge policy", () => {
	it("emits no threshold nudge below minimum", () => {
		const controller = createNudgeController();
		assert.equal(controller.evaluate(input("leaf-1", 99)).decision, undefined);
	});

	it("throttles soft reminders to the first and every fifth later eligible request", () => {
		const controller = createNudgeController();
		assert.equal(controller.evaluate(input("leaf-1", 150)).decision?.level, "soft");
		for (let index = 2; index <= 5; index += 1) {
			assert.equal(controller.evaluate(input(`leaf-${index}`, 150)).decision, undefined);
		}
		assert.equal(controller.evaluate(input("leaf-6", 150)).decision?.level, "soft");
	});

	it("allows strong reminders on each distinct above-max request but only once per request", () => {
		const controller = createNudgeController();
		const first = controller.evaluate(input("leaf-1", 200));
		const repeated = controller.evaluate(input("leaf-1", 200));
		assert.equal(first.decision?.level, "strong");
		assert.deepEqual(repeated, first);
		assert.equal(controller.evaluate(input("leaf-2", 250)).decision?.level, "strong");

		const messages = [{ role: "user", content: "work", timestamp: 1 } as AgentMessage];
		const outbound = injectNudge(messages, repeated.decision);
		assert.equal(outbound.length, 2);
		assert.equal((JSON.stringify(outbound).match(/<dcp-nudge/g) ?? []).length, 1);
	});

	it("resolves percentage thresholds independently for each model window", () => {
		const percentage: DcpConfig = { minCompressContext: "25%", maxCompressContext: "80%", debugMarkerTrace: false };
		const smallWindow = createNudgeController().evaluate(input("small", 300, percentage, 1_000));
		assert.equal(smallWindow.decision?.level, "soft");

		const largeWindow = createNudgeController().evaluate(input("large", 300, percentage, 2_000));
		assert.equal(largeWindow.decision, undefined);

		const unavailable = createNudgeController().evaluate({ ...input("unknown", 900, percentage), contextWindow: undefined });
		assert.match(unavailable.configError ?? "", /context window/);
		assert.equal(unavailable.decision, undefined);
	});

	it("emits an iteration reminder after fifteen model/tool continuations", () => {
		const controller = createNudgeController();
		const highLimits: DcpConfig = { minCompressContext: 50_000, maxCompressContext: 100_000, debugMarkerTrace: false };
		assert.equal(controller.evaluate(input("user-leaf", 10, highLimits)).decision, undefined);
		for (let step = 1; step < 15; step += 1) {
			assert.equal(controller.evaluate(input(`tool-result-${step}`, 10, highLimits)).decision, undefined);
		}
		const due = controller.evaluate(input("tool-result-15", 10, highLimits));
		assert.equal(due.decision?.level, "iteration");
		assert.deepEqual(due.decision?.reasons, ["iteration"]);
		assert.match(due.decision?.message ?? "", /autonomous tool loop/);

		const resetByUser = controller.evaluate(input("new-user-leaf", 10, highLimits, 1_000, "user-2"));
		assert.equal(resetByUser.decision, undefined);
	});

	it("combines threshold and iteration reasons into one ephemeral message", () => {
		const controller = createNudgeController();
		controller.evaluate(input("user-leaf", 250));
		for (let step = 1; step < 15; step += 1) controller.evaluate(input(`loop-${step}`, 250));
		const combined = controller.evaluate(input("loop-15", 250));
		assert.equal(combined.decision?.level, "strong");
		assert.deepEqual(combined.decision?.reasons, ["threshold", "iteration"]);
		assert.equal((combined.decision?.message.match(/single reminder/g) ?? []).length, 1);
	});

	it("preserves the exact outbound array and session when no nudge is due", () => {
		const manager = SessionManager.inMemory("/tmp/pi-dcp-nudges");
		manager.appendMessage({ role: "user", content: "stable prefix", timestamp: 1 });
		const messages = manager.buildSessionContext().messages;
		const beforeEntries = structuredClone(manager.getEntries());
		const decision = createNudgeController().evaluate(input("stable", 10)).decision;
		const outbound = injectNudge(messages, decision);
		assert.equal(outbound, messages, "no-nudge pass changed the prompt array");
		assert.deepEqual(manager.getEntries(), beforeEntries, "ephemeral evaluation persisted session data");
	});

	it("estimates effective outbound size, including synthetic content", () => {
		const short = [{ role: "user", content: "x", timestamp: 1 } as AgentMessage];
		const long = [{ role: "user", content: "x".repeat(4_000), timestamp: 1 } as AgentMessage];
		assert.ok(estimateOutboundTokens(long) > estimateOutboundTokens(short) + 900);
	});

	it("uses Pi context usage instead of re-estimating provider metadata", () => {
		const raw = [{ role: "user", content: "x".repeat(4_000), timestamp: 1 } as AgentMessage];
		const overlay = [{ role: "user", content: "summary", timestamp: 1 } as AgentMessage];

		assert.equal(estimateEffectiveContextTokens(raw, raw, 310), 310);
		assert.equal(estimateEffectiveContextTokens(raw, overlay, 2_000), 2_000);
		assert.equal(estimateEffectiveContextTokens(raw, overlay), estimateOutboundTokens(overlay));
	});

	it("ignores invalid Pi usage and falls back to the overlay estimate", () => {
		const raw = [{ role: "user", content: "short", timestamp: 1 } as AgentMessage];
		const overlay = [{ role: "user", content: "x".repeat(4_000), timestamp: 1 } as AgentMessage];
		assert.equal(
			estimateEffectiveContextTokens(raw, overlay, Number.NaN),
			estimateOutboundTokens(overlay),
		);
	});
});
