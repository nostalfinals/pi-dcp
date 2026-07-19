import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	DEFAULT_CONFIG,
	loadConfig,
	parseConfigLayer,
	parseContextLimit,
	resolveConfig,
} from "../lib/config.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-dcp-config-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("configuration", () => {
	it("accepts positive integer token counts and bounded percentages", () => {
		assert.equal(parseContextLimit(1), 1);
		assert.equal(parseContextLimit("0.5%"), "0.5%");
		assert.equal(parseContextLimit("100%"), "100%");
		for (const invalid of [0, -1, 1.5, Number.NaN, "0%", "101%", " 25%", "25% ", "tokens"]) {
			assert.equal(parseContextLimit(invalid), undefined);
		}
	});

	it("accepts the marker debug switch and rejects invalid values", () => {
		assert.deepEqual(parseConfigLayer({ debugMarkerTrace: true }), {
			config: { debugMarkerTrace: true },
			errors: [],
		});
		assert.equal(parseConfigLayer({ debugMarkerTrace: "yes" }).errors.length, 1);
	});

	it("rejects unknown public settings", () => {
		const parsed = parseConfigLayer({ minCompressContext: 10, deduplication: true });
		assert.equal(parsed.config, undefined);
		assert.equal(parsed.errors.length, 1);
	});

	it("uses defaults when no files exist", () => {
		const root = temporaryDirectory();
		const loaded = loadConfig(join(root, "project"), join(root, "agent"));
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.deepEqual(loaded.warnings, []);
	});

	it("merges global settings and project overrides", () => {
		const root = temporaryDirectory();
		const agent = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agent, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agent, "dcp.json"), JSON.stringify({ minCompressContext: "20%", maxCompressContext: "80%" }));
		writeFileSync(join(project, ".pi", "dcp.json"), JSON.stringify({ maxCompressContext: "60%" }));

		const loaded = loadConfig(project, agent);
		assert.deepEqual(loaded.config, {
			minCompressContext: "20%",
			maxCompressContext: "60%",
			debugMarkerTrace: false,
		});
		assert.deepEqual(loaded.warnings, []);
	});

	it("ignores an invalid layer and reports one aggregateable warning", () => {
		const root = temporaryDirectory();
		const agent = join(root, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "dcp.json"), "{ broken json");

		const loaded = loadConfig(join(root, "project"), agent);
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.equal(loaded.warnings.length, 1);
	});

	it("falls back to defaults when directly comparable limits are inverted", () => {
		const root = temporaryDirectory();
		const agent = join(root, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "dcp.json"), JSON.stringify({ minCompressContext: 100, maxCompressContext: 50 }));

		const loaded = loadConfig(join(root, "project"), agent);
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.equal(loaded.warnings.length, 1);
	});

	it("resolves percentages against the model context window", () => {
		assert.deepEqual(resolveConfig({ minCompressContext: "25%", maxCompressContext: "80%", debugMarkerTrace: false }, 200_000), {
			config: { minCompressContext: 50_000, maxCompressContext: 160_000 },
		});
		assert.ok(resolveConfig({ minCompressContext: "25%", maxCompressContext: 100_000, debugMarkerTrace: false }).error);
	});

	it("validates mixed limits after resolution", () => {
		const result = resolveConfig({ minCompressContext: "80%", maxCompressContext: 50_000, debugMarkerTrace: false }, 100_000);
		assert.equal(result.config, undefined);
		assert.ok(result.error);
	});
});
