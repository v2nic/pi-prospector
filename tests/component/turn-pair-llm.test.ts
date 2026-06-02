import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnPairLlmAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import type { LLMCaller, LLMRequest } from "../../src/analyze/types.js";

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-tpllm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

function seedSession(db: Database.Database, sessionId: string, messages: Array<{ id: string; role: string; text: string; ts?: string }>) {
	db.prepare(`INSERT INTO sessions (id, file_path, project, cwd, parent_session, started_at, last_line, last_modified, message_count) VALUES (?, ?, '', '', NULL, ?, 0, 0, 0)`).run(sessionId, `/fake/${sessionId}.jsonl`, "2026-01-01T00:00:00Z");
	for (const m of messages) {
		db.prepare(`
			INSERT INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, meta_json)
			VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL)
		`).run(m.id, sessionId, m.ts ?? "2026-01-01T00:00:00Z", m.role, m.text);
	}
	db.prepare(`UPDATE sessions SET message_count = ? WHERE id = ?`).run(messages.length, sessionId);
}

describe("turn-pair-llm end-to-end", () => {
	it("only enriches pairs flagged by the deterministic pass", async () => {
		const { db, close } = tempDb();
		try {
			// Two pairs: one with correction, one clean
			seedSession(db, "s1", [
				{ id: "u1", role: "user", text: "actually, use pnpm not npm" },
				{ id: "a1", role: "assistant", text: "switching to pnpm" },
				{ id: "u2", role: "user", text: "what does the package.json say?" },
				{ id: "a2", role: "assistant", text: "it has scripts" },
			]);

			const llmCalls: LLMRequest[] = [];
			const llm: LLMCaller = async (req) => {
				llmCalls.push(req);
				return {
					text: JSON.stringify({
						sentiment: "frustrated",
						frustration_level: 6,
						correction_type_llm: "explicit",
						friction_cause: "wrong_package_manager",
						friction_summary: "User corrected pnpm vs npm",
						user_intent: "fix package manager",
						quality_score: 3,
					}),
					model: "stub/cheap",
					costUsd: 0.001,
					tokensUsed: 100,
					durationMs: 5,
				};
			};

			const fw = new AnalyzerFramework({ db, llm });
			fw.register(turnPairCoreAnalyzer);
			fw.register(turnPairLlmAnalyzer);

			const r1 = await fw.run("turn-pair-core", "s1");
			assert.equal(r1.nodesProduced, 2, "two pairs");

			const r2 = await fw.run("turn-pair-llm", "s1");
			assert.equal(r2.nodesProduced, 1, "only the corrected pair is enriched");
			assert.equal(llmCalls.length, 1);

			const llmNodes = db.prepare(`SELECT * FROM analysis_nodes WHERE analyzer_id = 'turn-pair-llm'`).all() as any[];
			assert.equal(llmNodes.length, 1);
			assert.equal(llmNodes[0].node_kind, "classification");

			const content = JSON.parse(llmNodes[0].content_json);
			assert.equal(content.sentiment, "frustrated");
			assert.equal(content.frustration_level, 6);

			// Verify edges
			const edges = db.prepare(`SELECT * FROM analysis_edges WHERE from_node_id = ?`).all(llmNodes[0].id) as any[];
			const edgeKinds = edges.map((e: any) => `${e.to_ref_kind}:${e.edge_kind}`).sort();
			assert.ok(edgeKinds.some((k) => k === "analysis_node:refines"), "has refines edge");
			assert.ok(edgeKinds.some((k) => k === "analysis_node:consumes"), "has consumes edge");
			assert.ok(edgeKinds.some((k) => k === "prompt_version:uses_prompt"), "has uses_prompt edge");
		} finally {
			close();
		}
	});

	it("records LLM cost and tokens on the run row", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "u1", role: "user", text: "no, use pnpm" },
				{ id: "a1", role: "assistant", text: "ok" },
			]);
			const llm: LLMCaller = async () => ({ text: JSON.stringify({ sentiment: "negative" }), model: "x/y", costUsd: 0.005, tokensUsed: 50, durationMs: 10 });
			const fw = new AnalyzerFramework({ db, llm });
			fw.register(turnPairCoreAnalyzer);
			fw.register(turnPairLlmAnalyzer);
			await fw.run("turn-pair-core", "s1");
			await fw.run("turn-pair-llm", "s1");

			const run = db.prepare(`SELECT * FROM analysis_runs WHERE analyzer_id = 'turn-pair-llm'`).get() as any;
			assert.ok(run.cost_usd >= 0.005);
			assert.ok(run.tokens_used >= 50);
		} finally {
			close();
		}
	});
});
