import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDigest, splitDigest } from "../../src/analyze/analyzers/session-overview/digest.js";
import type { AnalysisNodeRow, MessageRow } from "../../src/analyze/types.js";
import type { TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import type { TurnPairLLMProperties } from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";

function coreNode(id: string, props: Partial<TurnPairCoreProperties>): AnalysisNodeRow {
	const full: TurnPairCoreProperties = {
		pair_index: props.pair_index ?? 0,
		user_message_id: props.user_message_id ?? "u",
		correction_detected: props.correction_detected ?? false,
		correction_type: props.correction_type ?? null,
		correction_patterns: props.correction_patterns ?? [],
		correction_text: props.correction_text ?? null,
		tool_call_count: props.tool_call_count ?? 0,
		tool_failure_count: props.tool_failure_count ?? 0,
		tool_result_bytes: props.tool_result_bytes ?? 0,
		tool_waste_bytes: props.tool_waste_bytes ?? 0,
		empty_response: props.empty_response ?? false,
		friction_score: props.friction_score ?? 0,
		high_signal: props.high_signal ?? false,
	};
	return {
		id,
		session_id: "s1",
		analyzer_id: "turn-pair-core",
		analyzer_version_id: "1.0.0",
		config_id: "c",
		run_id: null,
		node_kind: "metric",
		content_json: JSON.stringify(full),
		source_set_hash: "ssh",
		config_fingerprint: "",
		input_key: id,
		output_key: id,
		model_used: null,
		cost_usd: null,
		tokens_used: null,
		duration_ms: null,
		created_at: new Date().toISOString(),
	};
}

const NO_MESSAGES: MessageRow[] = [];

function llmNode(id: string, props: TurnPairLLMProperties): AnalysisNodeRow {
	return {
		...coreNode(id, {}),
		analyzer_id: "turn-pair-llm",
		node_kind: "classification",
		content_json: JSON.stringify(props),
	};
}

describe("buildDigest", () => {
	it("aggregates counts and renders per-pair lines", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.7, high_signal: true, correction_detected: true, correction_type: "explicit" }),
				coreNode("n2", { pair_index: 1, friction_score: 0.1, tool_failure_count: 0 }),
			],
			llmNodes: [],
		});
		assert.equal(digest.pairCount, 2);
		assert.equal(digest.frictionCount, 1);
		assert.equal(digest.correctionCount, 1);
		assert.equal(digest.perPairLines.length, 2);
		assert.ok(digest.text.includes("#0"));
	});

	it("orders pairs by index regardless of node order", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [coreNode("n2", { pair_index: 5 }), coreNode("n1", { pair_index: 1 })],
			llmNodes: [],
		});
		assert.ok(digest.perPairLines[0]!.startsWith("#1"));
		assert.ok(digest.perPairLines[1]!.startsWith("#5"));
	});

	it("includes compaction summaries verbatim", () => {
		const messages: MessageRow[] = [
			{
				id: "c1",
				session_id: "s1",
				parent_id: null,
				timestamp: null,
				role: "compactionSummary",
				content_text: "PRIOR CONTEXT: refactored auth",
				content_thinking: null,
				tool_calls: null,
				tool_results: null,
			},
		];
		const digest = buildDigest({ sessionId: "s1", messages, coreNodes: [coreNode("n1", {})], llmNodes: [] });
		assert.equal(digest.compactionCount, 1);
		assert.ok(digest.text.includes("refactored auth"));
	});

	it("merges turn-pair-llm enrichment onto the matching pair by user_message_id", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-hot", friction_score: 0.8, high_signal: true }),
				coreNode("n2", { pair_index: 1, user_message_id: "u-cold", friction_score: 0.1 }),
			],
			llmNodes: [
				llmNode("l1", {
					user_message_id: "u-hot",
					sentiment: "frustrated",
					friction_type: "wrong_approach",
					is_genuine_correction: true,
					severity: "high",
					rationale: "x",
				}),
			],
		});
		const hotLine = digest.perPairLines.find((l) => l.startsWith("#0"))!;
		const coldLine = digest.perPairLines.find((l) => l.startsWith("#1"))!;
		assert.ok(hotLine.includes("sentiment=frustrated"), "enriched pair shows LLM sentiment");
		assert.ok(hotLine.includes("type=wrong_approach") && hotLine.includes("sev=high"));
		assert.ok(!coldLine.includes("sentiment="), "un-enriched pair has no LLM fields");
	});

	it("includes branch summaries verbatim (Pi's snake_case branch_summary role)", () => {
		const messages: MessageRow[] = [
			{
				id: "b1",
				session_id: "s1",
				parent_id: null,
				timestamp: null,
				role: "branch_summary",
				content_text: "BRANCH CONTEXT: split off to try OAuth",
				content_thinking: null,
				tool_calls: null,
				tool_results: null,
			},
		];
		const digest = buildDigest({ sessionId: "s1", messages, coreNodes: [coreNode("n1", {})], llmNodes: [] });
		assert.equal(digest.compactionCount, 1);
		assert.ok(digest.text.includes("split off to try OAuth"));
	});

	it("tolerates malformed node content", () => {
		const bad: AnalysisNodeRow = { ...coreNode("n1", {}), content_json: "{bad" };
		const digest = buildDigest({ sessionId: "s1", messages: NO_MESSAGES, coreNodes: [bad], llmNodes: [] });
		assert.equal(digest.pairCount, 0);
	});

	it("includes user text for every pair, not just correction-matched ones (un-gate)", () => {
		// A pair whose user text is an unrecognized correction (no regex match).
		// Before the un-gating change, this pair would have no `note=` or `text=` field.
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-circleci", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "This repo does not use CircleCI", content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-circleci", correction_detected: false, friction_score: 0.3 }),
			],
			llmNodes: [],
		});
		const line = digest.perPairLines[0]!;
		// The key assertion: even without correction_detected, the user text appears.
		assert.ok(line.includes("text="), "un-gated pair must have a text= snippet");
		assert.ok(line.includes("CircleCI"), "text= must contain the user's actual words");
	});

	it("includes user text snippet even for pairs with no correction at all", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-plain", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: "please add a test for this", content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-plain", friction_score: 0.05 }),
			],
			llmNodes: [],
		});
		const line = digest.perPairLines[0]!;
		assert.ok(line.includes("text="), "plain pair must have a text= snippet");
		assert.ok(line.includes("add a test"), "text= must contain the user text");
	});

	it("truncates long user text to the budget", () => {
		const longText = "a".repeat(500);
		const digest = buildDigest({
			sessionId: "s1",
			messages: [
				{ id: "u-long", session_id: "s1", parent_id: null, timestamp: null, role: "user", content_text: longText, content_thinking: null, tool_calls: null, tool_results: null },
			],
			coreNodes: [
				coreNode("n1", { pair_index: 0, user_message_id: "u-long", friction_score: 0.1 }),
			],
			llmNodes: [],
		});
		const line = digest.perPairLines[0]!;
		// The text field should be truncated to USER_TEXT_SNIPPET_MAX (200) + ellipsis
		assert.ok(line.includes("text=\""), "must have text field");
		// Extract the text field value and check it's truncated
		const match = line.match(/text="([^"]*)"/);
		assert.ok(match, "text field must be extractable");
		assert.ok(match[1]!.length <= 201, "truncated text must be within budget");
	});
});

describe("splitDigest", () => {
	it("returns a single segment when under budget", () => {
		const digest = buildDigest({ sessionId: "s1", messages: NO_MESSAGES, coreNodes: [coreNode("n1", {})], llmNodes: [] });
		assert.equal(splitDigest(digest, 100000).length, 1);
	});

	it("splits into multiple segments when over budget", () => {
		const nodes = Array.from({ length: 40 }, (_, i) => coreNode(`n${i}`, { pair_index: i, correction_text: "x".repeat(100) }));
		const digest = buildDigest({ sessionId: "s1", messages: NO_MESSAGES, coreNodes: nodes, llmNodes: [] });
		const segments = splitDigest(digest, 500);
		assert.ok(segments.length > 1);
		for (const seg of segments) assert.ok(seg.text.includes("Per-pair signals"));
	});
});
