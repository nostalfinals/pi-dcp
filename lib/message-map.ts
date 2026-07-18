import { isDeepStrictEqual } from "node:util";
import {
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
}

export type MessageMapResult =
	| { ok: true; value: MessageMap }
	| { ok: false; messages: AgentMessage[]; reason: string };

const ANNOTATION_PATTERN = /^<dcp-message id="m\d+" \/>\n?/;
const ASSISTANT_ANNOTATION_PATTERN = /^\n?<dcp-message id="m\d+" \/>$/;

function marker(alias: string): string {
	return `<dcp-message id="${alias}" />`;
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
		copy.content = copy.content.filter((block) => {
			return !(
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string" &&
				ASSISTANT_ANNOTATION_PATTERN.test((block as { text: string }).text)
			);
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

/** Add a request-local alias without mutating the source message. */
export function annotateMessage(message: AgentMessage, alias: string): AgentMessage {
	const copy = stripMessageAnnotation(message) as AgentMessage & Record<string, unknown>;
	const annotation = marker(alias);

	if (copy.role === "assistant" && Array.isArray(copy.content)) {
		// Keep signed thinking first, and keep annotation text before any tool calls.
		let insertionIndex = 0;
		while (copy.content[insertionIndex]?.type === "thinking") insertionIndex += 1;
		copy.content = [
			...copy.content.slice(0, insertionIndex),
			{ type: "text", text: `${annotation}\n` },
			...copy.content.slice(insertionIndex),
		];
		return copy;
	}

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

function jsonForEstimation(message: AgentMessage): string {
	try {
		return JSON.stringify(message, (key, value: unknown) => {
			// Timestamps and provider accounting do not enter the prompt body.
			if (key === "timestamp" || key === "usage" || key === "cost") return undefined;
			return value;
		}) ?? "";
	} catch {
		return "";
	}
}

/** Conservative, provider-neutral estimate used only to reject uneconomic ranges. */
export function estimateMessageTokens(message: AgentMessage): number {
	const characters = jsonForEstimation(stripMessageAnnotation(message)).length;
	return Math.max(1, Math.ceil(characters / 4) + 4);
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
	const projected = projectedMessages(contextEntries);
	if (projected.length !== outboundMessages.length) {
		return {
			ok: false,
			messages: outboundMessages as AgentMessage[],
			reason: `message count mismatch: projected ${projected.length}, outbound ${outboundMessages.length}`,
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

	const stripped = outboundMessages.map(stripMessageAnnotation);
	for (let index = 0; index < projected.length; index += 1) {
		if (!isDeepStrictEqual(projected[index].message, stripped[index])) {
			return {
				ok: false,
				messages: outboundMessages as AgentMessage[],
				reason: `message ${index} does not match session entry ${projected[index].entry.id}`,
			};
		}
	}

	// A fixed minimum width keeps every existing alias stable when the context grows past m999.
	const aliasFor = (index: number) => `m${String(index + 1).padStart(3, "0")}`;
	const annotated = stripped.map((message, index) => annotateMessage(message, aliasFor(index)));
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
		},
	};
}
