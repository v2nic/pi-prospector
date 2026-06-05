import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeFrictionScore, detectRetry, estimateWasteBytes, DEFAULT_CONFIG_PARAMS, createDefaultConfig } from "../../src/analyze/analyzers/turn-pair-core/config.js";

describe("computeFrictionScore", () => {
	it("returns 0 for no friction signals", () => {
		assert.equal(computeFrictionScore({ correctionDetected: false, correctionType: null, toolFailureCount: 0, toolFailureDetails: [], retryDetected: false, toolWasteBytes: 0, totalToolBytes: 100 }), 0);
	});
	it("returns high score for explicit correction", () => {
		const score = computeFrictionScore({ correctionDetected: true, correctionType: "explicit", toolFailureCount: 0, toolFailureDetails: [], retryDetected: false, toolWasteBytes: 0, totalToolBytes: 100 });
		assert.ok(score >= 0.4, `expected >= 0.4, got ${score}`);
	});
	it("adds tool failure signal", () => {
		const noFailures = computeFrictionScore({ correctionDetected: false, correctionType: null, toolFailureCount: 0, toolFailureDetails: [], retryDetected: false, toolWasteBytes: 0, totalToolBytes: 100 });
		const withFailures = computeFrictionScore({ correctionDetected: false, correctionType: null, toolFailureCount: 3, toolFailureDetails: [{ tool_name: "edit", error_preview: "file not found" }], retryDetected: false, toolWasteBytes: 0, totalToolBytes: 100 });
		assert.ok(withFailures > noFailures);
	});
	it("caps score at 1.0", () => {
		const score = computeFrictionScore({ correctionDetected: true, correctionType: "explicit", toolFailureCount: 5, toolFailureDetails: [], retryDetected: true, toolWasteBytes: 100, totalToolBytes: 100 });
		assert.ok(score <= 1.0, `expected <= 1.0, got ${score}`);
	});
});

describe("detectRetry", () => {
	it("detects when same tool called multiple times", () => { assert.equal(detectRetry(["read", "read"]), true); });
	it("returns false for no retries", () => { assert.equal(detectRetry(["read", "edit", "bash"]), false); });
	it("returns false for empty array", () => { assert.equal(detectRetry([]), false); });
});

describe("estimateWasteBytes", () => {
	it("counts all non-error tool results as waste when no subsequent text", () => {
		assert.equal(estimateWasteBytes([{ toolName: "read", textLength: 100, isError: false }], null), 100);
	});
	it("counts error results as 0 waste", () => {
		assert.equal(estimateWasteBytes([{ toolName: "bash", textLength: 50, isError: true }], "The command failed."), 0);
	});
	it("does not count tool results referenced in text", () => {
		assert.equal(estimateWasteBytes([{ toolName: "read", textLength: 100, isError: false }], "I can see from the read output that..."), 0);
	});
});

describe("createDefaultConfig", () => {
	it("creates a valid config with correct analyzer ID", () => {
		const config = createDefaultConfig();
		assert.equal(config.analyzerId, "turn-pair-core");
		assert.ok(config.configHash.length > 0);
	});
});