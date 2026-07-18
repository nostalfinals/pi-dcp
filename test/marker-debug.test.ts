import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	emitMarkerDebug,
	MARKER_DEBUG_PREFIX,
	scanMarkerDebugValue,
} from "../lib/marker-debug.js";

describe("marker debug tracing", () => {
	it("counts nested markers and retains only short excerpts", () => {
		const secret = "s".repeat(500);
		const scan = scanMarkerDebugValue({
			content: [
				`${secret}<dcp-message id=\"m001\" />${secret}`,
				"<!-- dcp-message id=\"m002\" -->",
			],
		});
		assert.equal(scan.count, 2);
		assert.equal(scan.excerpts.length, 2);
		assert.ok(scan.excerpts.every((excerpt) => excerpt.length < 200));
	});

	it("emits only relevant records unless forced", () => {
		const lines: string[] = [];
		const sink = (line: string) => lines.push(line);
		emitMarkerDebug(true, "ordinary", { text: "no metadata" }, { sink });
		assert.equal(lines.length, 0);

		emitMarkerDebug(true, "stream", { text: '<dcp-message id="m003" />' }, { sink });
		emitMarkerDebug(true, "context", { text: "no metadata" }, { sink, force: true, includeExcerpts: false });
		assert.equal(lines.length, 2);
		assert.ok(lines.every((line) => line.startsWith(`${MARKER_DEBUG_PREFIX} `)));
		assert.match(lines[0], /"stage":"stream"/);
		assert.match(lines[0], /"markerCount":1/);
		assert.match(lines[1], /"markerCount":0/);
	});

	it("stays silent when disabled", () => {
		const lines: string[] = [];
		emitMarkerDebug(false, "stream", { text: '<dcp-message id="m004" />' }, {
			sink: (line) => lines.push(line),
			force: true,
		});
		assert.equal(lines.length, 0);
	});
});
