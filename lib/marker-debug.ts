export const MARKER_DEBUG_PREFIX = "[pi-dcp:marker-debug]";

export interface MarkerDebugScan {
	count: number;
	excerpts: string[];
}

export interface MarkerDebugOptions {
	force?: boolean;
	includeExcerpts?: boolean;
	sink?: (line: string) => void;
}

const MARKER_NAME = "dcp-message";
const MAX_EXCERPTS = 6;
const EXCERPT_RADIUS = 80;

/** Find marker references without retaining complete conversation content. */
export function scanMarkerDebugValue(value: unknown): MarkerDebugScan {
	let count = 0;
	const excerpts: string[] = [];
	const visited = new WeakSet<object>();

	function visit(current: unknown): void {
		if (typeof current === "string") {
			let offset = 0;
			while (offset < current.length) {
				const index = current.indexOf(MARKER_NAME, offset);
				if (index === -1) break;
				count += 1;
				if (excerpts.length < MAX_EXCERPTS) {
					const start = Math.max(0, index - EXCERPT_RADIUS);
					const end = Math.min(current.length, index + MARKER_NAME.length + EXCERPT_RADIUS);
					excerpts.push(current.slice(start, end).replaceAll("\n", "\\n"));
				}
				offset = index + MARKER_NAME.length;
			}
			return;
		}
		if (typeof current !== "object" || current === null) return;
		if (visited.has(current)) return;
		visited.add(current);
		if (Array.isArray(current)) {
			for (const item of current) visit(item);
			return;
		}
		for (const item of Object.values(current as Record<string, unknown>)) visit(item);
	}

	visit(value);
	return { count, excerpts };
}

/** Emit one grep-friendly JSON record to stderr when marker debugging is enabled. */
export function emitMarkerDebug(
	enabled: boolean,
	stage: string,
	value: unknown,
	options: MarkerDebugOptions = {},
): void {
	if (!enabled) return;
	const scan = scanMarkerDebugValue(value);
	if (!options.force && scan.count === 0) return;
	const record: Record<string, unknown> = {
		time: new Date().toISOString(),
		stage,
		markerCount: scan.count,
	};
	if (options.includeExcerpts !== false && scan.excerpts.length > 0) record.excerpts = scan.excerpts;
	(options.sink ?? console.error)(`${MARKER_DEBUG_PREFIX} ${JSON.stringify(record)}`);
}
