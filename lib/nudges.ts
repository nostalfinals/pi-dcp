import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config.js";
import type { AgentMessage } from "./message-map.js";
import type { DcpConfig } from "./types.js";

export type NudgeLevel = "soft" | "strong" | "iteration";

export interface NudgeDecision {
	level: NudgeLevel;
	reasons: Array<"threshold" | "iteration">;
	estimatedTokens: number;
	message: string;
}

export interface NudgeEvaluationInput {
	config: DcpConfig;
	contextWindow?: number;
	estimatedTokens: number;
	sessionId: string;
	requestLeafId: string | null;
	latestUserEntryId?: string;
}

export interface NudgeEvaluationResult {
	decision?: NudgeDecision;
	configError?: string;
}

export interface NudgeController {
	evaluate(input: NudgeEvaluationInput): NudgeEvaluationResult;
	reset(): void;
}

export const DCP_NUDGE_MESSAGE_TYPE = "pi-dcp-nudge";
const SOFT_INTERVAL = 5;
const ITERATION_INTERVAL = 15;

function nudgeText(level: NudgeLevel): string {
	const opening = level === "strong"
		? "REMINDER: CONTEXT PRESSURE HAS EXCEEDED A SAFE LEVEL. COMPRESS OLDER COMPLETED WORK NOW IF A SAFE RANGE EXISTS."
		: level === "soft"
			? "Reminder: Context pressure has reached a notable level. Consider compressing older completed work if a safe range exists."
			: "Reminder: Many tool calls have been made. Consider compressing older completed work if a safe range exists.";
	return [
		`<dcp-nudge level="${level}">`,
		opening,
		"</dcp-nudge>",
	].join("\n");
}

export function createNudgeMessage(decision: NudgeDecision): AgentMessage {
	return {
		role: "custom",
		customType: DCP_NUDGE_MESSAGE_TYPE,
		content: decision.message,
		display: false,
		// Ephemeral and deterministic; this value is never appended to the session.
		timestamp: 0,
	};
}

/** Preserve the exact array/prefix when no nudge is due. */
export function injectNudge(
	messages: AgentMessage[],
	decision: NudgeDecision | undefined,
): AgentMessage[] {
	return decision ? [...messages, createNudgeMessage(decision)] : messages;
}

export function estimateOutboundTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** Use Pi's provider-aware usage when available; estimate only as a fallback. */
export function estimateEffectiveContextTokens(
	_overlaySourceMessages: readonly AgentMessage[],
	overlayMessages: readonly AgentMessage[],
	piUsageTokens?: number,
): number {
	if (piUsageTokens !== undefined && Number.isFinite(piUsageTokens) && piUsageTokens >= 0) {
		return Math.round(piUsageTokens);
	}
	return estimateOutboundTokens(overlayMessages);
}

export function createNudgeController(): NudgeController {
	let lastRequestKey: string | undefined;
	let lastDecisionSignature: string | undefined;
	let lastDecision: NudgeEvaluationResult | undefined;
	let lastUserEntryId: string | undefined;
	let stepsSinceUser = 0;
	let lastIterationNudgeStep = 0;
	let softEligibleCount = 0;
	let lastSoftNudgeCount = 0;
	let softCountedRequestKey: string | undefined;
	let softDueForRequest = false;
	let iterationDueForRequest = false;

	function reset(): void {
		lastRequestKey = undefined;
		lastDecisionSignature = undefined;
		lastDecision = undefined;
		lastUserEntryId = undefined;
		stepsSinceUser = 0;
		lastIterationNudgeStep = 0;
		softEligibleCount = 0;
		lastSoftNudgeCount = 0;
		softCountedRequestKey = undefined;
		softDueForRequest = false;
		iterationDueForRequest = false;
	}

	function evaluate(input: NudgeEvaluationInput): NudgeEvaluationResult {
		const requestKey = `${input.sessionId}:${input.requestLeafId ?? "none"}`;
		const isNewRequest = requestKey !== lastRequestKey;
		if (isNewRequest) {
			lastRequestKey = requestKey;
			lastDecisionSignature = undefined;
			lastDecision = undefined;
			softCountedRequestKey = undefined;
			softDueForRequest = false;
			iterationDueForRequest = false;
			if (input.latestUserEntryId !== lastUserEntryId) {
				lastUserEntryId = input.latestUserEntryId;
				stepsSinceUser = 0;
				lastIterationNudgeStep = 0;
			} else {
				stepsSinceUser += 1;
			}
		}

		const resolved = resolveConfig(input.config, input.contextWindow);
		const signature = JSON.stringify([
			requestKey,
			input.estimatedTokens,
			input.contextWindow,
			resolved.config?.minCompressContext,
			resolved.config?.maxCompressContext,
			resolved.error,
			stepsSinceUser,
		]);
		if (signature === lastDecisionSignature && lastDecision) return lastDecision;

		let thresholdLevel: "soft" | "strong" | undefined;
		if (resolved.config) {
			if (input.estimatedTokens >= resolved.config.maxCompressContext) thresholdLevel = "strong";
			else if (input.estimatedTokens >= resolved.config.minCompressContext) thresholdLevel = "soft";
		}

		if (thresholdLevel === "soft") {
			if (softCountedRequestKey !== requestKey) {
				softEligibleCount += 1;
				softCountedRequestKey = requestKey;
			}
			if (softEligibleCount === 1 || softEligibleCount - lastSoftNudgeCount >= SOFT_INTERVAL) {
				softDueForRequest = true;
				lastSoftNudgeCount = softEligibleCount;
			}
		} else {
			softEligibleCount = 0;
			lastSoftNudgeCount = 0;
			softCountedRequestKey = undefined;
		}

		if (stepsSinceUser >= ITERATION_INTERVAL && stepsSinceUser - lastIterationNudgeStep >= ITERATION_INTERVAL) {
			iterationDueForRequest = true;
			lastIterationNudgeStep = stepsSinceUser;
		}

		const reasons: Array<"threshold" | "iteration"> = [];
		if (thresholdLevel === "strong" || softDueForRequest) reasons.push("threshold");
		if (iterationDueForRequest) reasons.push("iteration");

		let decision: NudgeDecision | undefined;
		if (reasons.length > 0) {
			const level: NudgeLevel = thresholdLevel === "strong"
				? "strong"
				: softDueForRequest
					? "soft"
					: "iteration";
			decision = {
				level,
				reasons,
				estimatedTokens: input.estimatedTokens,
				message: nudgeText(level),
			};
		}

		lastDecisionSignature = signature;
		lastDecision = { decision, configError: resolved.error };
		return lastDecision;
	}

	return { evaluate, reset };
}
