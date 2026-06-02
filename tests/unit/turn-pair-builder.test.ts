import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildTurnPairNode,
} from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG } from "../../src/analyze/analyzers/turn-pair-core/config.js";
import type { MessageRow } from "../../src/analyze/types.js";

function makeUser(id: string, text: string, ts: string): MessageRow {
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: ts,
		role: "user",
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		meta_json: null,
	};
}

function makeAssistant(id: string, text: string, ts: string, opts: {
	thinking?: string;
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	model?: string;
	usage?: { input?: number; output?: number };
	stopReason?: string;
} = {}): MessageRow {
	const meta: Record<string, unknown> = {};
	if (opts.model) meta.model = opts.model;
	if (opts.usage) meta.usage = opts.usage;
	if (opts.stopReason) meta.stop_reason = opts.stopReason;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: ts,
		role: "assistant",
		content_text: text,
		content_thinking: opts.thinking ?? null,
		tool_calls: opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
		tool_results: null,
		meta_json: Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
	};
}

function makeToolResult(id: string, toolName: string, text: string, isError: boolean): MessageRow {
	const tr = { toolName, isError, textLength: text.length };
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role: "toolResult",
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: JSON.stringify([tr]),
		meta_json: null,
	};
}

describe("buildTurnPairNode — basic shape", () => {
	it("returns null if no user message at the index", () => {
		const msgs: MessageRow[] = [makeAssistant("a1", "hi", "2026-01-01T00:00:00Z")];
		const r = buildTurnPairNode(msgs, 0, 0, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r, null);
	});

	it("returns null if no assistant follows", () => {
		const msgs: MessageRow[] = [makeUser("u1", "hi", "2026-01-01T00:00:00Z")];
		const r = buildTurnPairNode(msgs, 0, 0, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r, null);
	});

	it("computes lengths from text", () => {
		const msgs = [
			makeUser("u1", "hello world", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "ok", "2026-01-01T00:00:05Z"),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.ok(r);
		assert.equal(r!.user_msg_length, 11);
		assert.equal(r!.assistant_msg_length, 2);
	});

	it("captures thinking when present", () => {
		const msgs = [
			makeUser("u1", "hi", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "ok", "2026-01-01T00:00:05Z", { thinking: "let me think" }),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.has_thinking, true);
		assert.equal(r!.thinking_length, "let me think".length);
	});
});

describe("buildTurnPairNode — correction", () => {
	it("flags correction_detected with 'actually'", () => {
		const msgs = [
			makeUser("u1", "actually, use pnpm not npm", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "ok switching", "2026-01-01T00:00:05Z"),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.correction_detected, true);
		assert.equal(r!.correction_type, "explicit");
		assert.ok(r!.correction_patterns.length >= 1);
		assert.ok(r!.correction_text);
	});

	it("leaves correction_detected false for clean messages", () => {
		const msgs = [
			makeUser("u1", "what is the package manager?", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "pnpm", "2026-01-01T00:00:05Z"),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.correction_detected, false);
		assert.equal(r!.correction_type, null);
	});

	it("raises friction_score when correction detected", () => {
		const clean = buildTurnPairNode([
			makeUser("u1", "hello", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "hi", "2026-01-01T00:00:05Z"),
		], 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG)!;
		const corr = buildTurnPairNode([
			makeUser("u2", "actually, use pnpm", "2026-01-01T00:00:00Z"),
			makeAssistant("a2", "ok", "2026-01-01T00:00:05Z"),
		], 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG)!;
		assert.ok(corr.friction_score > clean.friction_score);
	});
});

describe("buildTurnPairNode — tools", () => {
	it("counts tool calls and tool names", () => {
		const msgs = [
			makeUser("u1", "look at the file", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "reading", "2026-01-01T00:00:05Z", {
				toolCalls: [
					{ name: "read", arguments: { path: "/a" } },
					{ name: "read", arguments: { path: "/b" } },
					{ name: "bash", arguments: { command: "ls" } },
				],
			}),
			makeToolResult("tr1", "read", "file contents of A", false),
			makeToolResult("tr2", "read", "file contents of B", false),
		];
		// endIndex includes the last tool result in this pair
		const r = buildTurnPairNode(msgs, 0, 3, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.tool_call_count, 3);
		assert.deepEqual(r!.tool_names.sort(), ["bash", "read"]);
	});

	it("counts tool failures and reports details", () => {
		const msgs = [
			makeUser("u1", "read a", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "trying", "2026-01-01T00:00:05Z", {
				toolCalls: [{ name: "read", arguments: { path: "/a" } }],
			}),
			makeToolResult("tr1", "read", "ERROR: file not found", true),
		];
		const r = buildTurnPairNode(msgs, 0, 2, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.tool_failure_count, 1);
		assert.equal(r!.tool_failure_details[0]!.tool_name, "read");
		assert.match(r!.tool_failure_details[0]!.error_preview, /ERROR/);
	});

	it("detects retry when same tool+target is called twice", () => {
		const msgs = [
			makeUser("u1", "read a", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "retrying", "2026-01-01T00:00:05Z", {
				toolCalls: [
					{ name: "read", arguments: { path: "/a" } },
					{ name: "read", arguments: { path: "/a" } },
				],
			}),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.retry_detected, true);
	});

	it("does not flag retry when different paths", () => {
		const msgs = [
			makeUser("u1", "read a and b", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "ok", "2026-01-01T00:00:05Z", {
				toolCalls: [
					{ name: "read", arguments: { path: "/a" } },
					{ name: "read", arguments: { path: "/b" } },
				],
			}),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.retry_detected, false);
	});

	it("captures model and usage from meta", () => {
		const msgs = [
			makeUser("u1", "hi", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "ok", "2026-01-01T00:00:05Z", {
				model: "anthropic/claude-sonnet-4-5",
				usage: { input: 100, output: 50 },
				stopReason: "stop",
			}),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.model, "anthropic/claude-sonnet-4-5");
		assert.equal(r!.usage_input_tokens, 100);
		assert.equal(r!.usage_output_tokens, 50);
		assert.equal(r!.stop_reason, "stop");
	});

	it("computes elapsed_seconds from timestamps", () => {
		const msgs = [
			makeUser("u1", "hi", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "ok", "2026-01-01T00:00:10Z"),
		];
		const r = buildTurnPairNode(msgs, 0, 1, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.elapsed_seconds, 10);
	});
});

describe("buildTurnPairNode — waste bytes", () => {
	it("counts bytes of tool results never referenced in assistant text", () => {
		const sample = "x".repeat(200);
		const msgs = [
			makeUser("u1", "check it", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", "I looked at the file", "2026-01-01T00:00:05Z", {
				toolCalls: [{ name: "read", arguments: { path: "/a" } }],
			}),
			makeToolResult("tr1", "read", sample, false),
		];
		const r = buildTurnPairNode(msgs, 0, 2, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.tool_waste_bytes, 200);
	});

	it("does not count bytes when assistant references the result", () => {
		const snippet = "function login(user) { return true; }";
		const msgs = [
			makeUser("u1", "show me login", "2026-01-01T00:00:00Z"),
			makeAssistant("a1", `the file has ${snippet} inside`, "2026-01-01T00:00:05Z", {
				toolCalls: [{ name: "read", arguments: { path: "/a" } }],
			}),
			makeToolResult("tr1", "read", snippet, false),
		];
		const r = buildTurnPairNode(msgs, 0, 2, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.tool_waste_bytes, 0);
	});
});

describe("buildTurnPairNode — compaction boundary", () => {
	it("flags when a compaction summary is in the range", () => {
		const msgs: MessageRow[] = [
			makeUser("u1", "hi", "2026-01-01T00:00:00Z"),
			{
				id: "cs1", session_id: "s", parent_id: null, timestamp: null,
				role: "compactionSummary", content_text: "old context", content_thinking: null,
				tool_calls: null, tool_results: null, meta_json: null,
			},
			makeAssistant("a1", "ok", "2026-01-01T00:00:05Z"),
		];
		const r = buildTurnPairNode(msgs, 0, 2, DEFAULT_TURN_PAIR_CORE_CONFIG);
		assert.equal(r!.is_compaction_boundary, true);
	});
});
