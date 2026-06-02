import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	detectCorrection,
	detectAllCorrectionPatterns,
	detectRepetition,
	extractCorrectionText,
} from "../../src/analyze/analyzers/turn-pair-core/patterns.js";
import {
	DEFAULT_TURN_PAIR_CORE_CONFIG,
	computeFrictionScore,
} from "../../src/analyze/analyzers/turn-pair-core/config.js";

describe("detectCorrection", () => {
	it("flags 'no, use X' as strong explicit", () => {
		const m = detectCorrection("no, use pnpm not npm");
		assert.ok(m);
		assert.equal(m?.type, "explicit");
	});

	it("flags 'actually' as strong explicit", () => {
		const m = detectCorrection("actually, I meant pnpm");
		assert.ok(m);
		assert.equal(m?.type, "explicit");
	});

	it("flags 'I said' / 'I told you' as strong explicit", () => {
		assert.ok(detectCorrection("I said use pnpm"));
		assert.ok(detectCorrection("I told you this earlier"));
	});

	it("flags 'that's wrong' as strong explicit", () => {
		assert.ok(detectCorrection("that's wrong, the function is foo"));
	});

	it("flags leading negation", () => {
		assert.ok(detectCorrection("no"));
		assert.ok(detectCorrection("don't do that"));
		assert.ok(detectCorrection("never mind, do X instead"));
	});

	it("flags weak correction patterns", () => {
		assert.ok(detectCorrection("could you try using the new API?"));
		assert.ok(detectCorrection("maybe we should use a different approach"));
	});

	it("returns null for clean messages", () => {
		assert.equal(detectCorrection("Hello, can you help me with the auth module?"), null);
		assert.equal(detectCorrection("Run the tests please"), null);
	});

	it("returns null for null input", () => {
		assert.equal(detectCorrection(null), null);
	});
});

describe("detectAllCorrectionPatterns", () => {
	it("returns multiple patterns when several match", () => {
		const m = detectAllCorrectionPatterns("actually, I said use pnpm, no?");
		assert.ok(m.length >= 2);
	});

	it("returns empty for clean text", () => {
		assert.deepEqual(detectAllCorrectionPatterns("Hello world"), []);
	});
});

describe("detectRepetition", () => {
	it("flags short message with shared tokens as repetition", () => {
		assert.equal(detectRepetition("try pnpm install", "run pnpm install please"), true);
	});

	it("does not flag longer messages", () => {
		assert.equal(detectRepetition(
			"please run pnpm install to update dependencies across the workspace",
			"run pnpm install",
		), false);
	});

	it("returns false without prior text", () => {
		assert.equal(detectRepetition("try pnpm install", null), false);
	});
});

describe("extractCorrectionText", () => {
	it("returns text after the matched pattern", () => {
		const m = detectCorrection("actually, use pnpm not npm");
		assert.ok(m);
		const text = extractCorrectionText("actually, use pnpm not npm", m!);
		assert.match(text, /use pnpm not npm/);
	});

	it("caps at 240 chars", () => {
		const long = "no, " + "x".repeat(500);
		const m = detectCorrection(long);
		assert.ok(m);
		const text = extractCorrectionText(long, m!);
		assert.ok(text.length <= 240);
	});
});

describe("computeFrictionScore", () => {
	const cfg = DEFAULT_TURN_PAIR_CORE_CONFIG;

	it("is 0 with no signals", () => {
		assert.equal(computeFrictionScore(cfg, {
			correctionDetected: false,
			toolFailureCount: 0,
			retryDetected: false,
			hasThinking: false,
			isCompactionBoundary: false,
		}), 0);
	});

	it("is at most 1.0 with all signals", () => {
		const score = computeFrictionScore(cfg, {
			correctionDetected: true,
			toolFailureCount: 100,
			retryDetected: true,
			hasThinking: true,
			isCompactionBoundary: true,
		});
		assert.ok(score <= 1.0);
		assert.ok(score > 0.5);
	});

	it("is sensitive to correction", () => {
		const noCorr = computeFrictionScore(cfg, {
			correctionDetected: false,
			toolFailureCount: 0, retryDetected: false, hasThinking: false, isCompactionBoundary: false,
		});
		const corr = computeFrictionScore(cfg, {
			correctionDetected: true,
			toolFailureCount: 0, retryDetected: false, hasThinking: false, isCompactionBoundary: false,
		});
		assert.ok(corr > noCorr);
	});

	it("caps failures at max_tool_failures (step function)", () => {
		const belowCap = computeFrictionScore(cfg, {
			correctionDetected: false, toolFailureCount: 2,
			retryDetected: false, hasThinking: false, isCompactionBoundary: false,
		});
		const atCap = computeFrictionScore(cfg, {
			correctionDetected: false, toolFailureCount: 3,
			retryDetected: false, hasThinking: false, isCompactionBoundary: false,
		});
		const aboveCap = computeFrictionScore(cfg, {
			correctionDetected: false, toolFailureCount: 10,
			retryDetected: false, hasThinking: false, isCompactionBoundary: false,
		});
		assert.equal(belowCap, 0, "below cap should be 0");
		assert.equal(atCap, aboveCap, "at and above cap should match");
		assert.equal(atCap, cfg.weights.tool_failure);
	});
});
