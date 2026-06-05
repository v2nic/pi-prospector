import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyCorrection, STRONG_PATTERNS, WEAK_PATTERNS, NEGATION_PATTERNS } from "../../src/analyze/analyzers/turn-pair-core/patterns.js";

describe("classifyCorrection", () => {
	it("detects explicit corrections with strong patterns", () => {
		const result = classifyCorrection("No, don't use npm, use pnpm instead", false);
		assert.equal(result.detected, true);
		assert.equal(result.type, "explicit");
	});
	it("detects 'wrong' as explicit correction", () => {
		const result = classifyCorrection("That's wrong, the function should return void", false);
		assert.equal(result.detected, true);
		assert.equal(result.type, "explicit");
	});
	it("detects 'actually' as correction", () => {
		const result = classifyCorrection("Actually, I wanted to use TypeScript", false);
		assert.equal(result.detected, true);
	});
	it("detects retry as repetition", () => {
		const result = classifyCorrection("Try again with different args", true);
		assert.equal(result.detected, true);
		assert.equal(result.type, "repetition");
	});
	it("returns no correction for neutral text", () => {
		const result = classifyCorrection("Please read the file", false);
		assert.equal(result.detected, false);
	});
	it("detects 'I said' as explicit correction", () => {
		const result = classifyCorrection("I said use pnpm, not npm", false);
		assert.equal(result.detected, true);
		assert.equal(result.type, "explicit");
	});
});

describe("STRONG_PATTERNS", () => { it("is a non-empty array of regex", () => { assert.ok(Array.isArray(STRONG_PATTERNS) && STRONG_PATTERNS.length > 0); }); });
describe("WEAK_PATTERNS", () => { it("is a non-empty array of regex", () => { assert.ok(Array.isArray(WEAK_PATTERNS) && WEAK_PATTERNS.length > 0); }); });
describe("NEGATION_PATTERNS", () => { it("is a non-empty array of regex", () => { assert.ok(Array.isArray(NEGATION_PATTERNS) && NEGATION_PATTERNS.length > 0); }); });