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
import { sessionOverviewAnalyzer } from "../../src/analyze/analyzers/session-overview/index.js";
import type { LLMCaller } from "../../src/analyze/types.js";

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-so-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

function seedSession(db: Database.Database, sessionId: string, messages: Array<{ id: string; role: string; text: string }>) {
	db.prepare(`INSERT INTO sessions (id, file_path, project, cwd, parent_session, started_at, last_line, last_modified, message_count) VALUES (?, ?, '', '', NULL, ?, 0, 0, 0)`).run(sessionId, `/fake/${sessionId}.jsonl`, "2026-01-01T00:00:00Z");
	for (const m of messages) {
		db.prepare(`
			INSERT INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, meta_json)
			VALUES (?, ?, NULL, '2026-01-01T00:00:00Z', ?, ?, NULL, NULL, NULL, NULL)
		`).run(m.id, sessionId, m.role, m.text);
	}
	db.prepare(`UPDATE sessions SET message_count = ? WHERE id = ?`).run(messages.length, sessionId);
}

describe("session-overview end-to-end", () => {
	it("produces a session-anchored summary node and materializes proposals", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "u1", role: "user", text: "actually, use pnpm not npm" },
				{ id: "a1", role: "assistant", text: "switching" },
			]);

			const llm: LLMCaller = async (req) => {
				if (req.model === "cheap") {
					// turn-pair-llm classify
					return {
						text: JSON.stringify({
							sentiment: "frustrated",
							frustration_level: 6,
							correction_type_llm: "explicit",
							friction_cause: "wrong_pkg_mgr",
							friction_summary: "User corrected pnpm",
							user_intent: "fix package manager",
							quality_score: 3,
						}),
						model: "stub/cheap",
						costUsd: 0.001,
						tokensUsed: 50,
						durationMs: 5,
					};
				}
				// mid (reduce)
				return {
					text: JSON.stringify({
						session_summary: "User wanted pnpm; agent initially used npm and was corrected.",
						key_friction_points: [
							{ description: "wrong package manager", pair_node_id: "unknown", severity: "high" },
						],
						improvement_proposals: [{
							target_type: "agents_md",
							target_path: "~/.pi/agent/AGENTS.md",
							title: "Default to project's package manager",
							summary: "Read package.json before running install",
							detail: "When the user says 'install', read package.json first and use the package manager declared there.",
							evidence: "User: actually, use pnpm not npm",
							confidence: 0.85,
							severity: "correction",
						}],
						sentiment_arc: [{ segment: 0, sentiment: "frustrated", key_event: "package manager correction" }],
					}),
					model: "stub/mid",
					costUsd: 0.01,
					tokensUsed: 200,
					durationMs: 20,
				};
			};

			const fw = new AnalyzerFramework({ db, llm });
			fw.register(turnPairCoreAnalyzer);
			fw.register(turnPairLlmAnalyzer);
			fw.register(sessionOverviewAnalyzer);

			await fw.run("turn-pair-core", "s1");
			await fw.run("turn-pair-llm", "s1");
			const r = await fw.run("session-overview", "s1");
			assert.equal(r.status, "ok");
			assert.equal(r.nodesProduced, 1);

			// Verify summary node
			const summary = db.prepare(`SELECT * FROM analysis_nodes WHERE analyzer_id = 'session-overview' AND node_kind = 'summary'`).get() as any;
			assert.ok(summary);
			assert.equal(summary.node_kind, "summary");
			const content = JSON.parse(summary.content_json);
			assert.ok(content.session_summary.length > 0);
			assert.equal(content.improvement_proposals.length, 1);

			// Verify proposal materialized
			const proposals = db.prepare(`SELECT * FROM proposals WHERE session_id = ?`).all("s1") as any[];
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0].target_type, "agents_md");
			assert.equal(proposals[0].title, "Default to project's package manager");

			// Verify edges
			const edges = db.prepare(`SELECT * FROM analysis_edges WHERE from_node_id = ?`).all(summary.id) as any[];
			const edgeKinds = new Set(edges.map((e: any) => e.edge_kind));
			assert.ok(edgeKinds.has("anchors"), "has anchors");
			assert.ok(edgeKinds.has("consumes"), "has consumes");
			assert.ok(edgeKinds.has("uses_prompt"), "has uses_prompt");
		} finally {
			close();
		}
	});

	it("skips the session if no turn-pair-core nodes exist", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "u1", role: "user", text: "hi" },
				{ id: "a1", role: "assistant", text: "hello" },
			]);
			const llm: LLMCaller = async () => ({ text: "{}", model: "x", costUsd: 0, tokensUsed: 0, durationMs: 0 });
			const fw = new AnalyzerFramework({ db, llm });
			fw.register(sessionOverviewAnalyzer);
			const r = await fw.run("session-overview", "s1");
			assert.equal(r.nodesProduced, 0);

			const summary = db.prepare(`SELECT * FROM analysis_nodes WHERE analyzer_id = 'session-overview'`).get();
			assert.equal(summary, undefined);
		} finally {
			close();
		}
	});
});
