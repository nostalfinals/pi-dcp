import type { AgentMessage, MessageMap } from "./message-map.js";
import { annotateMessage, estimateMessageTokens } from "./message-map.js";
import { findToolProtocolIssues, normalizeRange, type NormalizedRange } from "./range.js";
import type { CompressionBlock, DcpStateSnapshot } from "./types.js";

export const DCP_COMPRESSION_MESSAGE_TYPE = "pi-dcp-compression";

export interface CompressionRangeInput {
	startId: string;
	endId: string;
	summary: string;
	topic?: string;
}

export interface PreparedRange {
	block: CompressionBlock;
	normalized: NormalizedRange;
	replacementTokens: number;
}

export interface PreparedCompression {
	state: DcpStateSnapshot;
	ranges: PreparedRange[];
	supersededBlockIds: string[];
	estimatedTokensSaved: number;
}

export type PrepareCompressionResult =
	| { ok: true; value: PreparedCompression }
	| { ok: false; errors: string[] };

export type CompressionOverlayResult =
	| { ok: true; messages: AgentMessage[]; visibleAliases: ReadonlySet<string> }
	| { ok: false; messages: AgentMessage[]; errors: string[] };

interface IndexedBlock {
	block: CompressionBlock;
	start: number;
	end: number;
}

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function compressionSummaryText(block: CompressionBlock): string {
	const topic = block.topic ? ` topic="${escapeAttribute(block.topic)}"` : "";
	return `<dcp-compression id="${block.id}"${topic}>\n${block.summary}\n</dcp-compression>`;
}

export function createCompressionSummaryMessage(block: CompressionBlock): AgentMessage {
	return {
		role: "custom",
		customType: DCP_COMPRESSION_MESSAGE_TYPE,
		content: compressionSummaryText(block),
		display: false,
		timestamp: block.createdAt,
	};
}

/** Remove large historical summaries from compress tool arguments without touching session-owned messages. */
export function scrubHistoricalCompressArguments(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((item) => {
		if (item.type !== "toolCall" || item.name !== "compress") return item;
		const args = item.arguments;
		if (typeof args !== "object" || args === null || !Array.isArray((args as { ranges?: unknown }).ranges)) return item;
		changed = true;
		const ranges = (args as { ranges: unknown[] }).ranges.map((range) => {
			if (typeof range !== "object" || range === null || !("summary" in range)) return range;
			return { ...range, summary: "[stored in the corresponding DCP compression block]" };
		});
		return { ...item, arguments: { ...args, ranges } };
	});
	return changed ? { ...message, content } : message;
}

function indexBlocks(map: MessageMap, blocks: readonly CompressionBlock[]): { indexed: IndexedBlock[]; errors: string[] } {
	const indexed: IndexedBlock[] = [];
	const errors: string[] = [];
	for (const block of blocks) {
		const start = map.byEntryId.get(block.startEntryId);
		const end = map.byEntryId.get(block.endEntryId);
		if (!start || !end) {
			errors.push(`active block ${block.id} references entries outside the current context`);
			continue;
		}
		if (start.messageIndex > end.messageIndex) {
			errors.push(`active block ${block.id} has reversed session boundaries`);
			continue;
		}
		indexed.push({ block, start: start.messageIndex, end: end.messageIndex });
	}
	indexed.sort((left, right) => left.start - right.start || left.end - right.end);
	for (let index = 1; index < indexed.length; index += 1) {
		if (indexed[index].start <= indexed[index - 1].end) {
			errors.push(`active blocks ${indexed[index - 1].block.id} and ${indexed[index].block.id} overlap`);
		}
	}
	return { indexed, errors };
}

/** Apply active blocks as a pure outbound overlay. */
export function applyCompressionOverlay(map: MessageMap, state: DcpStateSnapshot): CompressionOverlayResult {
	const resolved = indexBlocks(map, state.activeBlocks);
	if (resolved.errors.length > 0) return { ok: false, messages: map.messages, errors: resolved.errors };

	const starts = new Map(resolved.indexed.map((item) => [item.start, item]));
	const covered = new Set<number>();
	for (const item of resolved.indexed) {
		for (let index = item.start; index <= item.end; index += 1) covered.add(index);
	}

	const messages: AgentMessage[] = [];
	const visibleAliases = new Set<string>();
	for (const item of map.mappedMessages) {
		const block = starts.get(item.messageIndex);
		if (block) messages.push(createCompressionSummaryMessage(block.block));
		if (covered.has(item.messageIndex)) continue;

		const scrubbed = scrubHistoricalCompressArguments(item.message);
		if (scrubbed.role === "assistant") {
			messages.push(annotateMessage(scrubbed, item.alias));
			continue;
		}

		visibleAliases.add(item.alias);
		const previous = item.messageIndex > 0
			? map.mappedMessages[item.messageIndex - 1]
			: undefined;
		const previousAlias = previous?.message.role === "assistant" && !covered.has(previous.messageIndex)
			? previous.alias
			: undefined;
		if (previousAlias) visibleAliases.add(previousAlias);
		messages.push(annotateMessage(scrubbed, item.alias, previousAlias));
	}
	const protocolIssues = findToolProtocolIssues(messages);
	if (protocolIssues.length > 0) {
		return {
			ok: false,
			messages: map.messages,
			errors: [`compression overlay would break tool history: ${protocolIssues.join("; ")}`],
		};
	}
	return { ok: true, messages, visibleAliases };
}

function activeWorkStart(map: MessageMap): number {
	for (let index = map.mappedMessages.length - 1; index >= 0; index -= 1) {
		const role = map.mappedMessages[index].message.role;
		if (role === "user" || role === "custom" || role === "bashExecution") return index;
	}
	return Math.max(0, map.mappedMessages.length - 1);
}

function overlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
	return leftStart <= rightEnd && rightStart <= leftEnd;
}

/** Validate every range before constructing one immutable next-state snapshot. */
export function prepareCompression(
	map: MessageMap,
	state: DcpStateSnapshot,
	inputs: readonly CompressionRangeInput[],
	creatorToolCallId: string,
	createdAt = Date.now(),
): PrepareCompressionResult {
	if (inputs.length === 0) return { ok: false, errors: ["At least one range is required"] };
	if (map.mappedMessages.length === 0) return { ok: false, errors: ["No mapped context is available to compress"] };

	const existing = indexBlocks(map, state.activeBlocks);
	if (existing.errors.length > 0) return { ok: false, errors: existing.errors };
	const protectedStart = activeWorkStart(map);
	const protectedAlias = map.mappedMessages[protectedStart].alias;
	const candidates: Array<{
		inputIndex: number;
		input: CompressionRangeInput;
		normalized: NormalizedRange;
		containedBlocks: IndexedBlock[];
		effectiveTokens: number;
	}> = [];
	const errors: string[] = [];

	for (const [inputIndex, input] of inputs.entries()) {
		const prefix = `ranges[${inputIndex}]`;
		if (input.summary.trim().length === 0) {
			errors.push(`${prefix}.summary must contain non-whitespace text`);
			continue;
		}
		const normalized = normalizeRange(map, input.startId, input.endId);
		if (!normalized.ok) {
			errors.push(`${prefix}: ${normalized.error.message}`);
			continue;
		}
		if (normalized.value.endMessageIndex >= protectedStart) {
			errors.push(`${prefix} reaches active work at ${protectedAlias}; choose an older endId`);
			continue;
		}
		const overlappingBlocks = existing.indexed.filter((block) => overlap(
			normalized.value.startMessageIndex,
			normalized.value.endMessageIndex,
			block.start,
			block.end,
		));
		const containedBlocks = overlappingBlocks.filter((block) => (
			normalized.value.startMessageIndex <= block.start && normalized.value.endMessageIndex >= block.end
		));
		const incompatible = overlappingBlocks.find((block) => !containedBlocks.includes(block));
		if (incompatible) {
			const blockStartAlias = map.mappedMessages[incompatible.start].alias;
			const blockEndAlias = map.mappedMessages[incompatible.end].alias;
			const relation = incompatible.start <= normalized.value.startMessageIndex && incompatible.end >= normalized.value.endMessageIndex
				? "is contained by"
				: "partially overlaps";
			const safeChoices: string[] = [];
			if (incompatible.start > 0) safeChoices.push(`end at or before ${map.mappedMessages[incompatible.start - 1].alias}`);
			if (incompatible.end + 1 < map.mappedMessages.length) {
				safeChoices.push(`start at or after ${map.mappedMessages[incompatible.end + 1].alias}`);
			}
			safeChoices.push(`fully contain ${incompatible.block.id}`);
			errors.push(
				`${prefix} ${relation} active block ${incompatible.block.id} (${blockStartAlias}..${blockEndAlias}); ${safeChoices.join(", or ")}`,
			);
			continue;
		}

		let effectiveTokens = normalized.value.estimatedTokens;
		for (const contained of containedBlocks) {
			const hiddenRawTokens = map.mappedMessages
				.slice(contained.start, contained.end + 1)
				.reduce((total, item) => total + item.estimatedTokens, 0);
			effectiveTokens -= hiddenRawTokens;
			effectiveTokens += estimateMessageTokens(createCompressionSummaryMessage(contained.block));
		}
		candidates.push({ inputIndex, input, normalized: normalized.value, containedBlocks, effectiveTokens });
	}

	for (let left = 0; left < candidates.length; left += 1) {
		for (let right = left + 1; right < candidates.length; right += 1) {
			if (overlap(
				candidates[left].normalized.startMessageIndex,
				candidates[left].normalized.endMessageIndex,
				candidates[right].normalized.startMessageIndex,
				candidates[right].normalized.endMessageIndex,
			)) {
				errors.push(`ranges[${candidates[left].inputIndex}] overlaps ranges[${candidates[right].inputIndex}] after normalization`);
			}
		}
	}
	if (errors.length > 0) return { ok: false, errors };

	let nextBlockNumber = state.nextBlockNumber;
	let estimatedTokensSaved = 0;
	const prepared: PreparedRange[] = [];
	const supersededBlockIds = new Set<string>();
	for (const candidate of candidates) {
		const summary = candidate.input.summary.trim();
		const topic = candidate.input.topic?.trim();
		const block: CompressionBlock = {
			id: `b${nextBlockNumber}`,
			startEntryId: candidate.normalized.startEntryId,
			endEntryId: candidate.normalized.endEntryId,
			summary,
			createdAt,
			creatorToolCallId,
		};
		if (topic) block.topic = topic;
		const replacementTokens = estimateMessageTokens(createCompressionSummaryMessage(block));
		if (candidate.effectiveTokens <= replacementTokens) {
			errors.push(
				`ranges[${candidate.inputIndex}] is not beneficial: current outbound section ~${candidate.effectiveTokens} tokens, replacement ~${replacementTokens}`,
			);
			continue;
		}
		prepared.push({ block, normalized: candidate.normalized, replacementTokens });
		for (const contained of candidate.containedBlocks) supersededBlockIds.add(contained.block.id);
		estimatedTokensSaved += candidate.effectiveTokens - replacementTokens;
		nextBlockNumber += 1;
	}
	if (errors.length > 0) return { ok: false, errors };

	return {
		ok: true,
		value: {
			state: {
				version: 1,
				nextBlockNumber,
				activeBlocks: [
					...state.activeBlocks.filter((block) => !supersededBlockIds.has(block.id)).map((block) => ({ ...block })),
					...prepared.map((item) => item.block),
				],
			},
			ranges: prepared,
			supersededBlockIds: [...supersededBlockIds],
			estimatedTokensSaved,
		},
	};
}
