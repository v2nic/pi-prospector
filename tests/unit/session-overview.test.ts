import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDigest,
	splitDigest,
} from "../../src/analyze/analyzers/session-overview/digest.js";
import {
	buildMapPrompt,
	parseMapResponse,
} from "../../src/analyze/analyzers/session-overview/prompt-map.js";
import {
	buildReducePrompt,
	parseReduceResponse,
} from "../../src/analyze/analyzers/session-overview/prompt-reduce.js";
import type { AnalysisNodeRow, MessageRow } from "../../src/analyze/types.js";

function makeMessage(id: string, role: string, text: string | null): MessageRow {
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: "2026-01-01T00:00:00Z",
		role: role as MessageRow["role"],
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		meta_json: null,
	};
}

function makePairNode(id: string, props: Record<string, unknown>): AnalysisNodeRow {
	return {
		id,
		session_id: "s",
		analyzer_id: "turn-pair-core",
		analyzer_version_id: "0.1.0",
		config_id: "c",
		run_id: "r",
		node_kind: "metric",
		content_json: JSON.stringify(props),
		source_set_hash: "h",
		input_hash: "i",
		created_at: "2026-01-01T00:00:00Z",
		model_used: null,
		cost_usd: 0,
		tokens_used: 0,
		duration_ms: null,
	};
}

describe("buildDigest", () => {
	it("produces a single-segment digest with header, phases, and stats", () => {
		const messages = [
			makeMessage("u1", "user", "actually, use pnpm"),
			makeMessage("a1", "assistant", "ok switching"),
		];
		const pairProps = {
			correction_detected: true,
			friction_score: 0.45,
			tool_failure_count: 0,
			tool_waste_bytes: 0,
			correction_type: "explicit",
			correction_text: "use pnpm",
			tool_names: ["bash"],
			elapsed_seconds: 5.0,
			model: "anthropic/claude-sonnet-4-5",
		};
		const pairNodes = [makePairNode("p1", pairProps)];
		const digest = buildDigest({ sessionId: "s1", messages, pairNodes, llmNodes: [] });
		assert.equal(digest.segments.length, 1);
		assert.ok(digest.segments[0]!.text.includes("Session ID: s1"));
		assert.ok(digest.segments[0]!.text.includes("explicit"), "shows correction type");
		assert.ok(digest.segments[0]!.text.includes("0.45"), "shows friction score");
		assert.ok(digest.segments[0]!.text.includes("Statistics"));
		assert.ok(digest.segments[0]!.text.includes("Total pairs: 1"));
		assert.equal(digest.pairCount, 1);
		assert.equal(digest.frictionCount, 1);
	});

	it("counts compactions", () => {
		const messages = [
			makeMessage("u1", "user", "hi"),
			makeMessage("a1", "assistant", "ok"),
			makeMessage("c1", "compactionSummary", "old context"),
			makeMessage("u2", "user", "hi again"),
			makeMessage("a2", "assistant", "ok again"),
		];
		const digest = buildDigest({ sessionId: "s1", messages, pairNodes: [], llmNodes: [] });
		assert.equal(digest.compactionCount, 1);
	});
});

describe("splitDigest", () => {
	it("returns single segment when under budget", () => {
		const digest = buildDigest({ sessionId: "s", messages: [], pairNodes: [], llmNodes: [] });
		const segs = splitDigest(digest, 10_000);
		assert.equal(segs.length, 1);
	});

	it("splits into multiple segments when over budget", () => {
		const messages = Array.from({ length: 50 }, (_, i) => makeMessage(`m${i}`, i % 2 === 0 ? "user" : "assistant", `text-${i}-${"x".repeat(100)}`));
		const pairNodes = Array.from({ length: 25 }, (_, i) => makePairNode(`p${i}`, {
			correction_detected: i % 3 === 0,
			friction_score: i % 5 === 0 ? 0.5 : 0.1,
			tool_failure_count: 0,
			tool_waste_bytes: 0,
			correction_type: null,
			correction_text: null,
			tool_names: ["read"],
			elapsed_seconds: 1,
			model: "x",
		}));
		const digest = buildDigest({ sessionId: "s", messages, pairNodes, llmNodes: [] });
		const segs = splitDigest(digest, 500);
		assert.ok(segs.length >= 2, `expected >=2 segments, got ${segs.length}`);
	});
});

describe("buildMapPrompt / buildReducePrompt", () => {
	it("substitutes the digest placeholder", () => {
		const out = buildMapPrompt("hello-marker");
		assert.ok(out.includes("hello-marker"));
		assert.equal(out.includes("{digest}"), false);
	});

	it("substitutes segment_summaries and stats", () => {
		const out = buildReducePrompt({ segmentSummaries: "ss-marker", stats: "st-marker" });
		assert.ok(out.includes("ss-marker"));
		assert.ok(out.includes("st-marker"));
		assert.equal(out.includes("{segment_summaries}"), false);
		assert.equal(out.includes("{stats}"), false);
	});
});

describe("parseMapResponse", () => {
	it("parses well-formed JSON", () => {
		const text = JSON.stringify({
			segment_summary: "User wanted X, agent did Y",
			key_friction_points: [{ description: "wrong_api", severity: "high", evidence_pair_index: 3 }],
			improvement_proposals: [{
				target_type: "skill",
				target_path: "skill/foo",
				title: "Add a foo skill",
				summary: "s",
				detail: "d",
				evidence: "e",
				confidence: 0.8,
				severity: "suggestion",
			}],
			sentiment_arc: [{ segment: 0, sentiment: "frustrated", key_event: "agent loop" }],
		});
		const r = parseMapResponse(text);
		assert.equal(r.segment_summary, "User wanted X, agent did Y");
		assert.equal(r.key_friction_points.length, 1);
		assert.equal(r.improvement_proposals.length, 1);
		assert.equal(r.sentiment_arc.length, 1);
	});

	it("returns empty on invalid JSON", () => {
		const r = parseMapResponse("not json");
		assert.equal(r.segment_summary, "");
		assert.equal(r.improvement_proposals.length, 0);
	});
});

describe("parseReduceResponse", () => {
	it("parses well-formed JSON", () => {
		const text = JSON.stringify({
			session_summary: "Overall summary",
			key_friction_points: [],
			improvement_proposals: [{
				target_type: "agents_md",
				target_path: "~/.pi/agent/AGENTS.md",
				title: "Tweak",
				summary: "s",
				detail: "d",
				evidence: "e",
				confidence: 0.6,
				severity: "suggestion",
			}],
			sentiment_arc: [],
		});
		const r = parseReduceResponse(text);
		assert.equal(r.session_summary, "Overall summary");
		assert.equal(r.improvement_proposals.length, 1);
	});
});
