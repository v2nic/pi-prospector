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

	it("detects task-completed-without-correction when no corrections exist", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.1, correction_detected: false }),
				coreNode("n2", { pair_index: 1, friction_score: 0.05, correction_detected: false }),
			],
			llmNodes: [],
		});
		assert.equal(digest.taskCompletedWithoutCorrection, true, "no corrections → task-completed-without-correction");
		assert.ok(digest.positiveSignals.includes("task-completed-without-correction"));
		assert.ok(digest.text.includes("positive_signals"));
	});

	it("detects correction-then-clean-recovery when a correction is followed by a clean pair", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, correction_detected: true, correction_type: "explicit", friction_score: 0.6, high_signal: true }),
				coreNode("n2", { pair_index: 1, correction_detected: false, friction_score: 0.05, high_signal: false }),
			],
			llmNodes: [],
		});
		assert.equal(digest.cleanRecovery, true, "correction followed by clean pair → clean recovery");
		assert.ok(digest.positiveSignals.includes("correction-then-clean-recovery"));
	});

	it("does not flag clean recovery when correction is followed by another correction", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, correction_detected: true, correction_type: "explicit", friction_score: 0.7, high_signal: true }),
				coreNode("n2", { pair_index: 1, correction_detected: true, correction_type: "explicit", friction_score: 0.6, high_signal: true }),
			],
			llmNodes: [],
		});
		assert.equal(digest.cleanRecovery, false, "back-to-back corrections → no clean recovery");
	});

	it("detects low-tool-failure-density when fewer than half the pairs have tool failures", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, tool_failure_count: 0 }),
				coreNode("n2", { pair_index: 1, tool_failure_count: 0 }),
				coreNode("n3", { pair_index: 2, tool_failure_count: 1 }),
			],
			llmNodes: [],
		});
		assert.equal(digest.lowToolFailureDensity, true, "1 of 3 pairs with tool failure → low density");
		assert.ok(digest.positiveSignals.includes("low-tool-failure-density"));
	});

	it("does not flag low-tool-failure-density when half or more pairs have tool failures", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, tool_failure_count: 1 }),
				coreNode("n2", { pair_index: 1, tool_failure_count: 2 }),
			],
			llmNodes: [],
		});
		assert.equal(digest.lowToolFailureDensity, false, "all pairs with failures → not low density");
	});

	it("a fully clean session has all three positive signals and no friction", () => {
		const digest = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.05, correction_detected: false, tool_failure_count: 0, high_signal: false }),
				coreNode("n2", { pair_index: 1, friction_score: 0.02, correction_detected: false, tool_failure_count: 0, high_signal: false }),
			],
			llmNodes: [],
		});
		assert.equal(digest.frictionCount, 0);
		assert.equal(digest.correctionCount, 0);
		assert.equal(digest.taskCompletedWithoutCorrection, true);
		assert.equal(digest.lowToolFailureDensity, true);
		assert.equal(digest.positiveSignals.length, 2, "clean session has task-completed-without-correction and low-tool-failure-density");
		assert.ok(!digest.positiveSignals.includes("correction-then-clean-recovery"), "no corrections → no clean-recovery signal");
	});

	it("includes positive signals section in digest text only when signals exist", () => {
		const digestWithSignals = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.1, correction_detected: false, tool_failure_count: 0, high_signal: false }),
			],
			llmNodes: [],
		});
		assert.ok(digestWithSignals.text.includes("### Positive signals"));
		assert.ok(digestWithSignals.text.includes("- task-completed-without-correction"));

		const digestNoSignals = buildDigest({
			sessionId: "s1",
			messages: NO_MESSAGES,
			coreNodes: [
				coreNode("n1", { pair_index: 0, friction_score: 0.8, correction_detected: true, tool_failure_count: 3, high_signal: true }),
			],
			llmNodes: [],
		});
		assert.ok(!digestNoSignals.text.includes("### Positive signals"), "no positive signals → no section");
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
