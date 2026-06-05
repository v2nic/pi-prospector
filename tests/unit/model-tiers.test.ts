import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelTier, validateModelTierConfig, DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { ModelTierConfig } from "../../src/analyze/types.js";

describe("resolveModelTier", () => {
	it("returns cheap model for cheap tier", () => { assert.equal(resolveModelTier("cheap"), DEFAULT_MODEL_TIERS.cheap); });
	it("returns mid model for mid tier", () => { assert.equal(resolveModelTier("mid"), DEFAULT_MODEL_TIERS.mid); });
	it("returns expensive model for expensive tier", () => { assert.equal(resolveModelTier("expensive"), DEFAULT_MODEL_TIERS.expensive); });
	it("falls back to mid for expensive when not configured", () => {
		const config: ModelTierConfig = { cheap: "cheap-model", mid: "mid-model", expensive: undefined as unknown as string };
		assert.equal(resolveModelTier("expensive", config), "mid-model");
	});
	it("uses custom config when provided", () => {
		const config: ModelTierConfig = { cheap: "my-cheap", mid: "my-mid", expensive: "my-expensive" };
		assert.equal(resolveModelTier("cheap", config), "my-cheap");
		assert.equal(resolveModelTier("mid", config), "my-mid");
		assert.equal(resolveModelTier("expensive", config), "my-expensive");
	});
});

describe("validateModelTierConfig", () => {
	it("returns no errors for valid config", () => { assert.equal(validateModelTierConfig({ cheap: "model-a", mid: "model-b", expensive: "model-c" }).length, 0); });
	it("returns error when no tiers configured", () => { assert.equal(validateModelTierConfig({}).length, 1); });
});

describe("DEFAULT_MODEL_TIERS", () => {
	it("has all three tiers", () => { assert.ok(DEFAULT_MODEL_TIERS.cheap); assert.ok(DEFAULT_MODEL_TIERS.mid); assert.ok(DEFAULT_MODEL_TIERS.expensive); });
});