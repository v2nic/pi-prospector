import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	computeInputHash,
	computePromptBundleHash,
	computeSourceSetHash,
	shortHash,
	fullHash,
	canonicalJsonStringify,
	computeConfigHash,
} from "../../src/analyze/input-hash.js";
import {
	EDGE_KINDS,
	EDGE_KIND_LIST,
	REF_KINDS,
	REF_KIND_LIST,
	validateEdge,
	isEdgeKind,
	isRefKind,
} from "../../src/analyze/edge-kinds.js";

describe("shortHash", () => {
	it("returns 16 hex chars", () => {
		const h = shortHash("hello");
		assert.equal(h.length, 16);
		assert.match(h, /^[0-9a-f]{16}$/);
	});

	it("is deterministic", () => {
		assert.equal(shortHash("foo"), shortHash("foo"));
	});

	it("changes with input", () => {
		assert.notEqual(shortHash("foo"), shortHash("bar"));
	});
});

describe("fullHash", () => {
	it("returns 64 hex chars", () => {
		const h = fullHash("hello");
		assert.equal(h.length, 64);
		assert.match(h, /^[0-9a-f]{64}$/);
	});

	it("starts with the short hash", () => {
		assert.equal(fullHash("hello").slice(0, 16), shortHash("hello"));
	});
});

describe("computeSourceSetHash", () => {
	it("is order-independent", () => {
		const a = computeSourceSetHash([{ kind: "message", id: "m1" }, { kind: "message", id: "m2" }]);
		const b = computeSourceSetHash([{ kind: "message", id: "m2" }, { kind: "message", id: "m1" }]);
		assert.equal(a, b);
	});

	it("distinguishes different kinds with the same id", () => {
		const a = computeSourceSetHash([{ kind: "message", id: "x" }]);
		const b = computeSourceSetHash([{ kind: "analysis_node", id: "x" }]);
		assert.notEqual(a, b);
	});

	it("handles empty input", () => {
		assert.equal(computeSourceSetHash([]), shortHash(""));
	});
});

describe("computePromptBundleHash", () => {
	it("is order-independent", () => {
		const a = computePromptBundleHash(["hash1", "hash2"]);
		const b = computePromptBundleHash(["hash2", "hash1"]);
		assert.equal(a, b);
	});

	it("handles empty bundle", () => {
		assert.equal(computePromptBundleHash([]), shortHash(""));
	});
});

describe("computeInputHash", () => {
	it("changes when any component changes", () => {
		const base = {
			analyzerId: "a",
			analyzerVersionId: "v1",
			configId: "c1",
			promptBundleHash: "p1",
			sourceSetHash: "s1",
		};
		const h0 = computeInputHash(base);
		assert.notEqual(h0, computeInputHash({ ...base, analyzerId: "b" }));
		assert.notEqual(h0, computeInputHash({ ...base, analyzerVersionId: "v2" }));
		assert.notEqual(h0, computeInputHash({ ...base, configId: "c2" }));
		assert.notEqual(h0, computeInputHash({ ...base, promptBundleHash: "p2" }));
		assert.notEqual(h0, computeInputHash({ ...base, sourceSetHash: "s2" }));
	});

	it("is deterministic for the same input", () => {
		const args = {
			analyzerId: "a",
			analyzerVersionId: "v1",
			configId: "c1",
			promptBundleHash: "p1",
			sourceSetHash: "s1",
		};
		assert.equal(computeInputHash(args), computeInputHash(args));
	});
});

describe("canonicalJsonStringify / computeConfigHash", () => {
	it("sorts keys at every level", () => {
		const a = canonicalJsonStringify({ b: 1, a: 2, c: { y: 3, x: 4 } });
		const b = canonicalJsonStringify({ c: { x: 4, y: 3 }, a: 2, b: 1 });
		assert.equal(a, b);
	});

	it("handles arrays (preserves order)", () => {
		const a = canonicalJsonStringify([3, 1, 2]);
		assert.equal(a, "[3,1,2]");
	});

	it("computeConfigHash is order-independent", () => {
		const h1 = computeConfigHash({ a: 1, b: 2 });
		const h2 = computeConfigHash({ b: 2, a: 1 });
		assert.equal(h1, h2);
	});
});

describe("edge-kinds", () => {
	it("EDGE_KIND_LIST contains the documented kinds", () => {
		assert.deepEqual([...EDGE_KIND_LIST].sort(), [
			"anchors",
			"consumes",
			"produces",
			"refines",
			"uses_config",
			"uses_prompt",
		]);
	});

	it("isEdgeKind accepts valid kinds", () => {
		assert.equal(isEdgeKind("anchors"), true);
		assert.equal(isEdgeKind("invalid"), false);
		assert.equal(isEdgeKind(42), false);
		assert.equal(isEdgeKind(null), false);
	});

	it("isRefKind accepts valid kinds", () => {
		assert.equal(isRefKind("message"), true);
		assert.equal(isRefKind("analysis_node"), true);
		assert.equal(isRefKind("nope"), false);
	});

	it("validates anchors → message or session", () => {
		validateEdge(EDGE_KINDS.ANCHORS, REF_KINDS.MESSAGE);
		validateEdge(EDGE_KINDS.ANCHORS, REF_KINDS.SESSION);
		assert.throws(() => validateEdge(EDGE_KINDS.ANCHORS, REF_KINDS.ANALYSIS_NODE), /anchors/);
	});

	it("validates consumes → message or analysis_node", () => {
		validateEdge(EDGE_KINDS.CONSUMES, REF_KINDS.MESSAGE);
		validateEdge(EDGE_KINDS.CONSUMES, REF_KINDS.ANALYSIS_NODE);
		assert.throws(() => validateEdge(EDGE_KINDS.CONSUMES, REF_KINDS.SESSION), /consumes/);
	});

	it("validates refines → analysis_node", () => {
		validateEdge(EDGE_KINDS.REFINES, REF_KINDS.ANALYSIS_NODE);
		assert.throws(() => validateEdge(EDGE_KINDS.REFINES, REF_KINDS.MESSAGE), /refines/);
	});

	it("validates uses_prompt → prompt_version", () => {
		validateEdge(EDGE_KINDS.USES_PROMPT, REF_KINDS.PROMPT_VERSION);
		assert.throws(() => validateEdge(EDGE_KINDS.USES_PROMPT, REF_KINDS.ANALYSIS_NODE), /uses_prompt/);
	});

	it("validates uses_config → config_version", () => {
		validateEdge(EDGE_KINDS.USES_CONFIG, REF_KINDS.CONFIG_VERSION);
		assert.throws(() => validateEdge(EDGE_KINDS.USES_CONFIG, REF_KINDS.ANALYSIS_NODE), /uses_config/);
	});

	it("validates produces → analysis_node", () => {
		validateEdge(EDGE_KINDS.PRODUCES, REF_KINDS.ANALYSIS_NODE);
		assert.throws(() => validateEdge(EDGE_KINDS.PRODUCES, REF_KINDS.MESSAGE), /produces/);
	});
});
