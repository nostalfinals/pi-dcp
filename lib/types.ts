export type ContextLimit = number | `${number}%`;

export interface DcpConfig {
	minCompressContext: ContextLimit;
	maxCompressContext: ContextLimit;
	debugMarkerTrace: boolean;
}

export interface ResolvedDcpConfig {
	minCompressContext: number;
	maxCompressContext: number;
}

export interface CompressionBlock {
	id: string;
	startEntryId: string;
	endEntryId: string;
	summary: string;
	topic?: string;
	createdAt: number;
	creatorToolCallId?: string;
}

export interface DcpStateSnapshot {
	version: 1;
	nextBlockNumber: number;
	activeBlocks: CompressionBlock[];
}
