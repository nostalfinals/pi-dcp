import type { AgentMessage, MessageMap } from "./message-map.js";

export type RangeErrorCode =
	| "missing_start"
	| "missing_end"
	| "reversed_range"
	| "unsafe_tool_protocol";

export interface RangeError {
	code: RangeErrorCode;
	message: string;
}

export interface NormalizedRange {
	requestedStartAlias: string;
	requestedEndAlias: string;
	startAlias: string;
	endAlias: string;
	startEntryId: string;
	endEntryId: string;
	startMessageIndex: number;
	endMessageIndex: number;
	entryIds: string[];
	messageAliases: string[];
	estimatedTokens: number;
}

export type NormalizeRangeResult =
	| { ok: true; value: NormalizedRange }
	| { ok: false; error: RangeError };

interface ToolGroup {
	assistantIndex: number;
	memberIndices: Set<number>;
	callIds: string[];
	complete: boolean;
}

interface ToolProtocol {
	groups: ToolGroup[];
	issues: string[];
}

function toolCalls(message: AgentMessage): Array<{ id: string; name: string }> {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "toolCall" &&
			typeof (block as { id?: unknown }).id === "string"
		) {
			return [{
				id: (block as { id: string }).id,
				name: typeof (block as { name?: unknown }).name === "string" ? (block as { name: string }).name : "unknown",
			}];
		}
		return [];
	});
}

function inspectToolProtocol(messages: readonly AgentMessage[]): ToolProtocol {
	const issues: string[] = [];
	const groups: ToolGroup[] = [];
	const callToGroup = new Map<string, ToolGroup>();
	const resultIndices = new Map<string, number[]>();

	for (const [index, message] of messages.entries()) {
		const calls = toolCalls(message);
		if (calls.length > 0) {
			const group: ToolGroup = {
				assistantIndex: index,
				memberIndices: new Set([index]),
				callIds: calls.map((call) => call.id),
				complete: true,
			};
			groups.push(group);
			for (const call of calls) {
				if (callToGroup.has(call.id)) issues.push(`duplicate tool call id ${call.id}`);
				else callToGroup.set(call.id, group);
			}
		}

		if (message.role === "toolResult") {
			const toolCallId = message.toolCallId;
			const indices = resultIndices.get(toolCallId) ?? [];
			indices.push(index);
			resultIndices.set(toolCallId, indices);
		}
	}

	for (const [toolCallId, indices] of resultIndices) {
		const group = callToGroup.get(toolCallId);
		if (!group) {
			issues.push(`orphan tool result ${toolCallId}`);
			continue;
		}
		if (indices.length !== 1) issues.push(`tool call ${toolCallId} has ${indices.length} results`);
		for (const index of indices) {
			if (index <= group.assistantIndex) issues.push(`tool result ${toolCallId} precedes its assistant call`);
			group.memberIndices.add(index);
		}
	}

	for (const group of groups) {
		for (const callId of group.callIds) {
			if ((resultIndices.get(callId)?.length ?? 0) !== 1) group.complete = false;
		}
		if (!group.complete) {
			issues.push(`assistant tool batch at message ${group.assistantIndex} is incomplete`);
			continue;
		}

		const resultPositions = [...group.memberIndices]
			.filter((index) => index !== group.assistantIndex)
			.sort((left, right) => left - right);
		const contiguous = resultPositions.every((index, offset) => index === group.assistantIndex + offset + 1);
		if (!contiguous) issues.push(`assistant tool batch at message ${group.assistantIndex} has interleaved results`);
	}

	return { groups, issues };
}

/** Return provider protocol problems without modifying messages. */
export function findToolProtocolIssues(messages: readonly AgentMessage[]): string[] {
	return inspectToolProtocol(messages).issues;
}

function intersects(group: ToolGroup, start: number, end: number): boolean {
	for (const index of group.memberIndices) {
		if (index >= start && index <= end) return true;
	}
	return false;
}

function groupBounds(group: ToolGroup): { start: number; end: number } {
	const indices = [...group.memberIndices];
	return { start: Math.min(...indices), end: Math.max(...indices) };
}

/** Resolve aliases and expand the range until every touched tool batch is removed atomically. */
export function normalizeRange(
	map: MessageMap,
	startAlias: string,
	endAlias: string,
): NormalizeRangeResult {
	const requestedStart = map.byAlias.get(startAlias);
	if (!requestedStart) {
		return { ok: false, error: { code: "missing_start", message: `Unknown or stale startId: ${startAlias}` } };
	}
	const requestedEnd = map.byAlias.get(endAlias);
	if (!requestedEnd) {
		return { ok: false, error: { code: "missing_end", message: `Unknown or stale endId: ${endAlias}` } };
	}
	if (requestedStart.messageIndex > requestedEnd.messageIndex) {
		return {
			ok: false,
			error: { code: "reversed_range", message: `startId ${startAlias} occurs after endId ${endAlias}` },
		};
	}

	const protocol = inspectToolProtocol(map.mappedMessages.map((item) => item.message));
	if (protocol.issues.length > 0) {
		return {
			ok: false,
			error: {
				code: "unsafe_tool_protocol",
				message: `Cannot normalize a range in malformed tool history: ${protocol.issues.join("; ")}`,
			},
		};
	}

	let start = requestedStart.messageIndex;
	let end = requestedEnd.messageIndex;
	let changed = true;
	while (changed) {
		changed = false;
		for (const group of protocol.groups) {
			if (!intersects(group, start, end)) continue;
			const bounds = groupBounds(group);
			if (bounds.start < start) {
				start = bounds.start;
				changed = true;
			}
			if (bounds.end > end) {
				end = bounds.end;
				changed = true;
			}
		}
	}

	const selected = map.mappedMessages.slice(start, end + 1);
	const remaining = map.mappedMessages
		.filter((item) => item.messageIndex < start || item.messageIndex > end)
		.map((item) => item.message);
	const remainingIssues = findToolProtocolIssues(remaining);
	if (remainingIssues.length > 0) {
		return {
			ok: false,
			error: {
				code: "unsafe_tool_protocol",
				message: `Normalized range would break tool history: ${remainingIssues.join("; ")}`,
			},
		};
	}

	const first = selected[0];
	const last = selected.at(-1) as typeof first;
	return {
		ok: true,
		value: {
			requestedStartAlias: startAlias,
			requestedEndAlias: endAlias,
			startAlias: first.alias,
			endAlias: last.alias,
			startEntryId: first.entryId,
			endEntryId: last.entryId,
			startMessageIndex: start,
			endMessageIndex: end,
			entryIds: selected.map((item) => item.entryId),
			messageAliases: selected.map((item) => item.alias),
			estimatedTokens: selected.reduce((total, item) => total + item.estimatedTokens, 0),
		},
	};
}
