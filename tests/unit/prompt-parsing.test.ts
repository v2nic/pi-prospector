import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractJsonObject,
	parseClassifyResponse,
	buildClassifyPrompt,
} from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";
import { parseMapResponse } from "../../src/analyze/analyzers/session-overview/prompt-map.js";
import { parseReduceResponse } from "../../src/analyze/analyzers/session-overview/prompt-reduce.js";

describe("extractJsonObject", () => {
	it("parses a bare JSON object", () => {
		assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
	});

	it("parses JSON inside markdown fences", () => {
		assert.deepEqual(extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
	});

	it("parses JSON surrounded by prose", () => {
		assert.deepEqual(extractJsonObject('Here you go: {"a":3} cheers'), { a: 3 });
	});

	it("handles nested objects", () => {
		assert.deepEqual(extractJsonObject('{"a":{"b":1}}'), { a: { b: 1 } });
	});

	it("throws when no object present", () => {
		assert.throws(() => extractJsonObject("no json here"), /No JSON object/);
	});

	it("throws on unterminated object", () => {
		assert.throws(() => extractJsonObject('{"a":1'), /Unterminated/);
	});
});

describe("parseClassifyResponse", () => {
	it("parses a valid classification", () => {
		const r = parseClassifyResponse('{"sentiment":"frustrated","friction_type":"wrong_approach","is_genuine_correction":true,"severity":"high","rationale":"x"}');
		assert.equal(r.sentiment, "frustrated");
		assert.equal(r.friction_type, "wrong_approach");
		assert.equal(r.is_genuine_correction, true);
		assert.equal(r.severity, "high");
	});

	it("falls back to safe defaults on invalid enum values", () => {
		const r = parseClassifyResponse('{"sentiment":"weird","friction_type":"nope","severity":"huge"}');
		assert.equal(r.sentiment, "neutral");
		assert.equal(r.friction_type, "none");
		assert.equal(r.severity, "low");
		assert.equal(r.is_genuine_correction, false);
	});
});

describe("buildClassifyPrompt", () => {
	it("includes user and assistant text and optional hint", () => {
		const p = buildClassifyPrompt({ userText: "hello", assistantText: "world", correctionText: "use X" });
		assert.ok(p.includes("hello") && p.includes("world") && p.includes("use X"));
	});

	it("omits hint when absent", () => {
		const p = buildClassifyPrompt({ userText: "a", assistantText: "b", correctionText: null });
		assert.ok(!p.includes("HEURISTIC"));
	});
});

describe("parseMapResponse", () => {
	it("parses segment summary and notable points", () => {
		const r = parseMapResponse('{"segment_summary":"s","notable_points":["a","b"]}', extractJsonObject);
		assert.equal(r.segment_summary, "s");
		assert.deepEqual(r.notable_points, ["a", "b"]);
	});

	it("defaults missing fields", () => {
		const r = parseMapResponse("{}", extractJsonObject);
		assert.equal(r.segment_summary, "");
		assert.deepEqual(r.notable_points, []);
	});
});

describe("parseReduceResponse", () => {
	it("parses summary, friction points, and proposals", () => {
		const json = JSON.stringify({
			session_summary: "did stuff",
			key_friction_points: [{ description: "x", severity: "high" }, { bad: true }],
			improvement_proposals: [{ title: "t", summary: "s", target_type: "config", severity: "friction" }],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.session_summary, "did stuff");
		assert.equal(r.key_friction_points.length, 1);
		assert.equal(r.improvement_proposals.length, 1);
	});

	it("defaults arrays when missing", () => {
		const r = parseReduceResponse("{}", extractJsonObject);
		assert.deepEqual(r.key_friction_points, []);
		assert.deepEqual(r.key_positive_signals, []);
		assert.deepEqual(r.improvement_proposals, []);
	});

	it("parses key_positive_signals from the LLM response", () => {
		const json = JSON.stringify({
			session_summary: "clean session",
			key_friction_points: [],
			key_positive_signals: [
				{ description: "agent recovered well after a correction", signal: "correction-then-clean-recovery" },
				{ description: "no tool failures", signal: "low-tool-failure-density" },
			],
			improvement_proposals: [
				{ title: "Add recovery pattern", summary: "encode the clean recovery", severity: "reinforcement", target_type: "agents_md" },
			],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.key_positive_signals.length, 2);
		assert.equal(r.key_positive_signals[0]!.signal, "correction-then-clean-recovery");
		assert.equal(r.key_positive_signals[1]!.description, "no tool failures");
		assert.equal(r.improvement_proposals.length, 1);
		assert.equal((r.improvement_proposals[0] as Record<string, unknown>)["severity"], "reinforcement");
	});

	it("filters out invalid positive signals", () => {
		const json = JSON.stringify({
			session_summary: "test",
			key_friction_points: [],
			key_positive_signals: [
				{ description: "valid", signal: "task-completed-without-correction" },
				{ bad: true },
				5,
			],
			improvement_proposals: [],
		});
		const r = parseReduceResponse(json, extractJsonObject);
		assert.equal(r.key_positive_signals.length, 1);
		assert.equal(r.key_positive_signals[0]!.description, "valid");
	});
});
