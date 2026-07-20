import { isDeepStrictEqual } from "node:util";
import {
	estimateTokens as estimatePiTokens,
	sessionEntryToContextMessages,
	type ContextEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];

export interface MappedMessage {
	alias: string;
	entryId: string;
	entryIndex: number;
	messageIndex: number;
	message: AgentMessage;
	estimatedTokens: number;
}

export interface MessageMap {
	contextEntries: SessionEntry[];
	messages: AgentMessage[];
	mappedMessages: MappedMessage[];
	byAlias: ReadonlyMap<string, MappedMessage>;
	byEntryId: ReadonlyMap<string, MappedMessage>;
	visibleAliases: ReadonlySet<string>;
}

export type MessageMapResult =
	| { ok: true; value: MessageMap }
	| { ok: false; messages: AgentMessage[]; reason: string };

const ANNOTATION_PATTERN = /^<dcp-message id="m\d+"(?: previous-assistant-id="m\d+")? \/>\n?/;
const ASSISTANT_ANNOTATION_PATTERN = /(?:\n?<dcp-message id="m\d+"(?: previous-assistant-id="m\d+")? \/>\n?|\s*<!-- dcp-message id="m\d+" -->\s*)/g;

function marker(alias: string, previousAssistantAlias?: string): string {
	const previous = previousAssistantAlias ? ` previous-assistant-id="${previousAssistantAlias}"` : "";
	return `<dcp-message id="${alias}"${previous} />`;
}

function stripAssistantAnnotationText(text: string): string {
	return text.replace(ASSISTANT_ANNOTATION_PATTERN, "");
}

function cloneMessage(message: AgentMessage): AgentMessage {
	return structuredClone(message);
}

function stripStringAnnotation(value: string): string {
	return value.replace(ANNOTATION_PATTERN, "");
}

function stripContentAnnotation(content: unknown): unknown {
	if (typeof content === "string") return stripStringAnnotation(content);
	if (!Array.isArray(content) || content.length === 0) return content;

	const first = content[0];
	if (
		typeof first === "object" &&
		first !== null &&
		(first as { type?: unknown }).type === "text" &&
		typeof (first as { text?: unknown }).text === "string" &&
		ANNOTATION_PATTERN.test((first as { text: string }).text)
	) {
		const text = stripStringAnnotation((first as { text: string }).text);
		return text.length === 0 ? content.slice(1) : [{ ...first, text }, ...content.slice(1)];
	}

	return content;
}

/** Remove only annotations produced by this extension. The input is never mutated. */
export function stripMessageAnnotation(message: AgentMessage): AgentMessage {
	const copy = cloneMessage(message) as AgentMessage & Record<string, unknown>;

	if (copy.role === "assistant" && Array.isArray(copy.content)) {
		copy.content = copy.content.flatMap((block) => {
			if (
				typeof block !== "object" ||
				block === null ||
				(block as { type?: unknown }).type !== "text" ||
				typeof (block as { text?: unknown }).text !== "string"
			) return [block];

			const text = stripAssistantAnnotationText((block as { text: string }).text);
			return text.length === 0 ? [] : [{ ...block, text }];
		});
		return copy;
	}

	if ("content" in copy) copy.content = stripContentAnnotation(copy.content);
	if (copy.role === "branchSummary" && typeof copy.summary === "string") {
		copy.summary = stripStringAnnotation(copy.summary);
	}
	if (copy.role === "compactionSummary" && typeof copy.summary === "string") {
		copy.summary = stripStringAnnotation(copy.summary);
	}
	if (copy.role === "bashExecution" && typeof copy.output === "string") {
		copy.output = stripStringAnnotation(copy.output);
	}
	return copy;
}

/**
 * Add a request-local alias without mutating the source message.
 * Assistant messages are deliberately left clean: the next non-assistant
 * message carries their alias so providers never receive injected assistant text.
 */
export function annotateMessage(
	message: AgentMessage,
	alias: string,
	previousAssistantAlias?: string,
): AgentMessage {
	const copy = stripMessageAnnotation(message) as AgentMessage & Record<string, unknown>;
	if (copy.role === "assistant") return copy;
	const annotation = marker(alias, previousAssistantAlias);

	if ("content" in copy) {
		if (typeof copy.content === "string") copy.content = `${annotation}\n${copy.content}`;
		else if (Array.isArray(copy.content)) copy.content = [{ type: "text", text: `${annotation}\n` }, ...copy.content];
		return copy;
	}

	if (copy.role === "branchSummary" && typeof copy.summary === "string") {
		copy.summary = `${annotation}\n${copy.summary}`;
	} else if (copy.role === "compactionSummary" && typeof copy.summary === "string") {
		copy.summary = `${annotation}\n${copy.summary}`;
	} else if (copy.role === "bashExecution" && typeof copy.output === "string") {
		copy.output = `${annotation}\n${copy.output}`;
	}
	return copy;
}

/** Use Pi's content-only heuristic; provider metadata and thinking signatures are not prompt text. */
export function estimateMessageTokens(message: AgentMessage): number {
	return Math.max(1, estimatePiTokens(stripMessageAnnotation(message)));
}

function isNonReplayableAssistant(message: AgentMessage): boolean {
	return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

function projectedMessages(entries: readonly SessionEntry[]): Array<{
	entry: SessionEntry;
	entryIndex: number;
	message: AgentMessage;
}> {
	const projected: Array<{ entry: SessionEntry; entryIndex: number; message: AgentMessage }> = [];
	for (const [entryIndex, entry] of entries.entries()) {
		for (const message of sessionEntryToContextMessages(entry)) {
			projected.push({ entry, entryIndex, message });
		}
	}
	return projected;
}

/**
 * Align the exact outbound message list with Pi's active, compaction-aware entries.
 * Any unexplained insertion/reorder fails open and returns the original array unchanged.
 */
export function buildMessageMap(
	contextEntries: readonly SessionEntry[],
	outboundMessages: readonly AgentMessage[],
): MessageMapResult {
	// Pi persists interrupted assistant turns for display/audit, but excludes them
	// from retry context. Provider transforms also skip restored error/aborted
	// assistant messages because their reasoning or tool calls may be incomplete.
	// Treat them as non-context tombstones on both sides so a retry can recover
	// immediately without assigning the failed turn an alias or compression range.
	const projected = projectedMessages(contextEntries).filter((item) => !isNonReplayableAssistant(item.message));
	const replayableOutbound = outboundMessages.filter((message) => !isNonReplayableAssistant(message));
	if (projected.length !== replayableOutbound.length) {
		return {
			ok: false,
			messages: outboundMessages as AgentMessage[],
			reason: `message count mismatch: projected ${projected.length}, outbound ${replayableOutbound.length}`,
		};
	}

	const producingEntryIds = new Set<string>();
	for (const item of projected) {
		if (producingEntryIds.has(item.entry.id)) {
			return {
				ok: false,
				messages: outboundMessages as AgentMessage[],
				reason: `session entry ${item.entry.id} projected to multiple messages`,
			};
		}
		producingEntryIds.add(item.entry.id);
	}

	const strippedProjected = projected.map((item) => stripMessageAnnotation(item.message));
	const stripped = replayableOutbound.map(stripMessageAnnotation);
	for (let index = 0; index < projected.length; index += 1) {
		if (!isDeepStrictEqual(strippedProjected[index], stripped[index])) {
			return {
				ok: false,
				messages: outboundMessages as AgentMessage[],
				reason: `message ${index} does not match session entry ${projected[index].entry.id}`,
			};
		}
	}

	// A fixed minimum width keeps every existing alias stable when the context grows past m999.
	const aliasFor = (index: number) => `m${String(index + 1).padStart(3, "0")}`;
	const visibleAliases = new Set<string>();
	const annotated = stripped.map((message, index) => {
		const alias = aliasFor(index);
		if (message.role === "assistant") return annotateMessage(message, alias);
		visibleAliases.add(alias);
		const previousAlias = index > 0 && stripped[index - 1].role === "assistant"
			? aliasFor(index - 1)
			: undefined;
		if (previousAlias) visibleAliases.add(previousAlias);
		return annotateMessage(message, alias, previousAlias);
	});
	const mappedMessages: MappedMessage[] = projected.map((item, messageIndex) => {
		const alias = aliasFor(messageIndex);
		return {
			alias,
			entryId: item.entry.id,
			entryIndex: item.entryIndex,
			messageIndex,
			message: stripped[messageIndex],
			estimatedTokens: estimateMessageTokens(stripped[messageIndex]),
		};
	});

	return {
		ok: true,
		value: {
			contextEntries: [...contextEntries],
			messages: annotated,
			mappedMessages,
			byAlias: new Map(mappedMessages.map((item) => [item.alias, item])),
			byEntryId: new Map(mappedMessages.map((item) => [item.entryId, item])),
			visibleAliases,
		},
	};
}
