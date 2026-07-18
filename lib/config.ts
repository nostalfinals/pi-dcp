import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextLimit, DcpConfig, ResolvedDcpConfig } from "./types.js";

export const DEFAULT_CONFIG: Readonly<DcpConfig> = Object.freeze({
	minCompressContext: 50_000,
	maxCompressContext: 100_000,
	debugMarkerTrace: false,
});

export interface LoadedConfig {
	config: DcpConfig;
	warnings: string[];
	paths: {
		global: string;
		project: string;
	};
}

export interface ResolvedConfigResult {
	config?: ResolvedDcpConfig;
	error?: string;
}

const CONTEXT_LIMIT_CONFIG_KEYS = ["minCompressContext", "maxCompressContext"] as const;
const CONFIG_KEYS = new Set<keyof DcpConfig>([...CONTEXT_LIMIT_CONFIG_KEYS, "debugMarkerTrace"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseContextLimit(value: unknown): ContextLimit | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}

	if (typeof value !== "string" || !value.endsWith("%")) return undefined;

	const numericPart = value.slice(0, -1);
	if (numericPart.trim() !== numericPart || numericPart.length === 0) return undefined;

	const percentage = Number(numericPart);
	if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return undefined;

	return value as ContextLimit;
}

function compareCompatibleLimits(minimum: ContextLimit, maximum: ContextLimit): boolean | undefined {
	if (typeof minimum === "number" && typeof maximum === "number") return minimum < maximum;
	if (typeof minimum === "string" && typeof maximum === "string") {
		return Number(minimum.slice(0, -1)) < Number(maximum.slice(0, -1));
	}
	return undefined;
}

export function parseConfigLayer(value: unknown): { config?: Partial<DcpConfig>; errors: string[] } {
	if (!isPlainObject(value)) return { errors: ["configuration root must be an object"] };

	const errors: string[] = [];
	const config: Partial<DcpConfig> = {};

	for (const key of Object.keys(value)) {
		if (!CONFIG_KEYS.has(key as keyof DcpConfig)) errors.push(`unknown setting: ${key}`);
	}

	for (const key of CONTEXT_LIMIT_CONFIG_KEYS) {
		if (!(key in value)) continue;
		const parsed = parseContextLimit(value[key]);
		if (parsed === undefined) {
			errors.push(`${key} must be a positive integer token count or a percentage in (0%, 100%]`);
		} else {
			config[key] = parsed;
		}
	}
	if ("debugMarkerTrace" in value) {
		if (typeof value.debugMarkerTrace !== "boolean") {
			errors.push("debugMarkerTrace must be a boolean");
		} else {
			config.debugMarkerTrace = value.debugMarkerTrace;
		}
	}

	if (errors.length > 0) return { errors };
	return { config, errors: [] };
}

function readConfigLayer(path: string): { config?: Partial<DcpConfig>; warning?: string } {
	if (!existsSync(path)) return {};

	try {
		const parsed = parseConfigLayer(JSON.parse(readFileSync(path, "utf8")));
		if (parsed.errors.length > 0) {
			return { warning: `${path}: ${parsed.errors.join("; ")}; ignoring this file` };
		}
		return { config: parsed.config };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { warning: `${path}: ${message}; ignoring this file` };
	}
}

export function loadConfig(cwd: string, agentDir = getAgentDir()): LoadedConfig {
	const globalPath = join(agentDir, "dcp.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "dcp.json");
	const global = readConfigLayer(globalPath);
	const project = readConfigLayer(projectPath);
	const warnings = [global.warning, project.warning].filter((warning): warning is string => warning !== undefined);

	const config: DcpConfig = {
		...DEFAULT_CONFIG,
		...global.config,
		...project.config,
	};

	const compatibleOrder = compareCompatibleLimits(config.minCompressContext, config.maxCompressContext);
	if (compatibleOrder === false) {
		warnings.push("minCompressContext must be lower than maxCompressContext; using defaults");
		return {
			config: { ...DEFAULT_CONFIG },
			warnings,
			paths: { global: globalPath, project: projectPath },
		};
	}

	return { config, warnings, paths: { global: globalPath, project: projectPath } };
}

function resolveLimit(limit: ContextLimit, contextWindow: number | undefined): number | undefined {
	if (typeof limit === "number") return limit;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	return Math.floor((Number(limit.slice(0, -1)) / 100) * contextWindow);
}

export function resolveConfig(config: DcpConfig, contextWindow?: number): ResolvedConfigResult {
	const minimum = resolveLimit(config.minCompressContext, contextWindow);
	const maximum = resolveLimit(config.maxCompressContext, contextWindow);

	if (minimum === undefined || maximum === undefined) {
		return { error: "percentage context limits require a positive model context window" };
	}
	if (minimum >= maximum) {
		return { error: "resolved minCompressContext must be lower than maxCompressContext" };
	}

	return {
		config: {
			minCompressContext: minimum,
			maxCompressContext: maximum,
		},
	};
}
