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
		const p = buildClassifyPrompt({ userText: "hello", assistantText: "world", correctionText: "use X", toolCalls: [], toolResults: [] });
		assert.ok(p.includes("hello") && p.includes("world") && p.includes("use X"));
	});

	it("omits hint when absent", () => {
		const p = buildClassifyPrompt({ userText: "a", assistantText: "b", correctionText: null, toolCalls: [], toolResults: [] });
		assert.ok(!p.includes("HEURISTIC"));
	});

	it("includes tool calls section when tool calls have arguments", () => {
		const p = buildClassifyPrompt({
			userText: "push it",
			assistantText: "running git push",
			correctionText: null,
			toolCalls: [{ name: "bash", argumentsPreview: "git push -u origin v2nic/gh-pr-review" }],
			toolResults: [],
		});
		assert.ok(p.includes("TOOL CALLS:"), "prompt must include TOOL CALLS section");
		assert.ok(p.includes("bash:"), "prompt must mention tool name");
		assert.ok(p.includes("git push -u origin"), "prompt must include the arguments preview");
	});

	it("includes failing command for a tool-error turn", () => {
		const p = buildClassifyPrompt({
			userText: "YOU SHOULD HAVE PUSHED TO v2nic/gh-pr-review",
			assistantText: "creating PR",
			correctionText: null,
			toolCalls: [
				{ name: "bash", argumentsPreview: "git push -u origin v2nic/gh-pr-review" },
				{ name: "bash", argumentsPreview: "gh pr create --title fix" },
			],
			toolResults: [
				{ toolName: "bash", isError: true, errorHead: "Error: no --repo flag, targeting upstream" },
			],
		});
		assert.ok(p.includes("TOOL CALLS:"), "prompt must include TOOL CALLS section");
		assert.ok(p.includes("git push -u origin"), "prompt must include push command");
		assert.ok(p.includes("gh pr create"), "prompt must include gh command");
		assert.ok(p.includes("FAILED"), "prompt must mark failed result");
		assert.ok(p.includes("no --repo flag"), "prompt must include error head");
	});

	it("includes non-bash tool calls", () => {
		const p = buildClassifyPrompt({
			userText: "add the file",
			assistantText: "adding",
			correctionText: null,
			toolCalls: [{ name: "edit", argumentsPreview: "file=src/index.ts" }],
			toolResults: [],
		});
		assert.ok(p.includes("TOOL CALLS:"));
		assert.ok(p.includes("edit:"));
	});

	it("omits tool calls section when no tool calls and no errors", () => {
		const p = buildClassifyPrompt({ userText: "hi", assistantText: "hello", correctionText: null, toolCalls: [], toolResults: [] });
		assert.ok(!p.includes("TOOL CALLS:"));
	});

	it("shows tool calls section when there are errors even without tool calls", () => {
		const p = buildClassifyPrompt({
			userText: "run it",
			assistantText: "failed",
			correctionText: null,
			toolCalls: [],
			toolResults: [{ toolName: "bash", isError: true, errorHead: "command not found" }],
		});
		assert.ok(p.includes("TOOL CALLS:"));
		assert.ok(p.includes("FAILED"));
		assert.ok(p.includes("command not found"));
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
		assert.deepEqual(r.improvement_proposals, []);
	});
});
