import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompressionBlock, DcpStateSnapshot } from "./types.js";

export const DCP_STATE_ENTRY_TYPE = "pi-dcp-state";

export interface StateParseResult {
	state?: DcpStateSnapshot;
	errors: string[];
}

export interface RestoredState {
	state: DcpStateSnapshot;
	sourceEntryId?: string;
	invalidEntryIds: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseBlock(value: unknown, index: number): { block?: CompressionBlock; errors: string[] } {
	if (!isPlainObject(value)) return { errors: [`activeBlocks[${index}] must be an object`] };

	const errors: string[] = [];
	if (!isNonEmptyString(value.id) || !/^b[1-9]\d*$/.test(value.id)) {
		errors.push(`activeBlocks[${index}].id must use the form b<number>`);
	}
	if (!isNonEmptyString(value.startEntryId)) errors.push(`activeBlocks[${index}].startEntryId must be a non-empty string`);
	if (!isNonEmptyString(value.endEntryId)) errors.push(`activeBlocks[${index}].endEntryId must be a non-empty string`);
	if (!isNonEmptyString(value.summary)) errors.push(`activeBlocks[${index}].summary must be a non-empty string`);
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt < 0) {
		errors.push(`activeBlocks[${index}].createdAt must be a non-negative finite number`);
	}
	if (value.topic !== undefined && typeof value.topic !== "string") {
		errors.push(`activeBlocks[${index}].topic must be a string when present`);
	}
	if (value.creatorToolCallId !== undefined && !isNonEmptyString(value.creatorToolCallId)) {
		errors.push(`activeBlocks[${index}].creatorToolCallId must be a non-empty string when present`);
	}
	if (errors.length > 0) return { errors };

	const block: CompressionBlock = {
		id: value.id as string,
		startEntryId: value.startEntryId as string,
		endEntryId: value.endEntryId as string,
		summary: value.summary as string,
		createdAt: value.createdAt as number,
	};
	if (value.topic !== undefined) block.topic = value.topic as string;
	if (value.creatorToolCallId !== undefined) block.creatorToolCallId = value.creatorToolCallId as string;
	return { block, errors: [] };
}

export function createEmptyState(): DcpStateSnapshot {
	return { version: 1, nextBlockNumber: 1, activeBlocks: [] };
}

export function cloneState(state: DcpStateSnapshot): DcpStateSnapshot {
	return {
		version: 1,
		nextBlockNumber: state.nextBlockNumber,
		activeBlocks: state.activeBlocks.map((block) => ({ ...block })),
	};
}

export function parseStateSnapshot(value: unknown): StateParseResult {
	if (!isPlainObject(value)) return { errors: ["state snapshot must be an object"] };
	if (value.version !== 1) return { errors: [`unsupported state version: ${String(value.version)}`] };

	const errors: string[] = [];
	if (!Number.isSafeInteger(value.nextBlockNumber) || (value.nextBlockNumber as number) < 1) {
		errors.push("nextBlockNumber must be a positive safe integer");
	}
	if (!Array.isArray(value.activeBlocks)) {
		errors.push("activeBlocks must be an array");
		return { errors };
	}

	const blocks: CompressionBlock[] = [];
	for (const [index, candidate] of value.activeBlocks.entries()) {
		const parsed = parseBlock(candidate, index);
		errors.push(...parsed.errors);
		if (parsed.block) blocks.push(parsed.block);
	}

	const ids = new Set<string>();
	let greatestBlockNumber = 0;
	for (const block of blocks) {
		if (ids.has(block.id)) errors.push(`duplicate active block id: ${block.id}`);
		ids.add(block.id);
		greatestBlockNumber = Math.max(greatestBlockNumber, Number(block.id.slice(1)));
	}
	if (Number.isSafeInteger(value.nextBlockNumber) && (value.nextBlockNumber as number) <= greatestBlockNumber) {
		errors.push("nextBlockNumber must be greater than every active block number");
	}

	if (errors.length > 0) return { errors };
	return {
		state: {
			version: 1,
			nextBlockNumber: value.nextBlockNumber as number,
			activeBlocks: blocks,
		},
		errors: [],
	};
}

export function restoreLatestState(branch: readonly SessionEntry[]): RestoredState {
	const invalidEntryIds: string[] = [];

	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== DCP_STATE_ENTRY_TYPE) continue;

		const parsed = parseStateSnapshot(entry.data);
		if (parsed.state) {
			return {
				state: parsed.state,
				sourceEntryId: entry.id,
				invalidEntryIds,
			};
		}
		invalidEntryIds.push(entry.id);
	}

	return { state: createEmptyState(), invalidEntryIds };
}
