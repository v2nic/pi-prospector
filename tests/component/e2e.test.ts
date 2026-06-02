import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { turnPairCoreAnalyzer, turnPairLlmAnalyzer, sessionOverviewAnalyzer } from "../../src/analyze/analyzers/index.js";
import type { LLMCaller, LLMRequest } from "../../src/analyze/types.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

describe("end-to-end sync + framework", () => {
	it("syncs fixtures and produces analysis nodes + proposals", async () => {
		const { db, close } = tempDb();
		try {
			const sync = runSync(db, FIXTURES);
			assert.ok(sync.sessionsProcessed >= 2);

			// Verify meta_json was captured for assistant messages
			const assistants = db.prepare(
				"SELECT meta_json FROM messages WHERE role = 'assistant' AND meta_json IS NOT NULL LIMIT 1",
			).get() as { meta_json: string } | undefined;
			assert.ok(assistants, "at least one assistant message should have meta_json");
			const meta = JSON.parse(assistants!.meta_json);
			assert.ok(meta.model, "meta should include model");
			assert.ok(meta.usage, "meta should include usage");
			assert.equal(meta.stop_reason, "toolUse");

			// Wire framework
			const llmCalls: LLMRequest[] = [];
			const llm: LLMCaller = async (req) => {
				llmCalls.push(req);
				if (req.model === "cheap") {
					return {
						text: JSON.stringify({
							sentiment: "neutral",
							frustration_level: 0,
							correction_type_llm: null,
							friction_cause: null,
							friction_summary: null,
							user_intent: "ask a question",
							quality_score: 4,
						}),
						model: "stub/cheap",
						costUsd: 0,
						tokensUsed: 0,
						durationMs: 0,
					};
				}
				return {
					text: JSON.stringify({
						session_summary: "User asked how to run tests; agent provided the answer.",
						key_friction_points: [],
						improvement_proposals: [],
						sentiment_arc: [],
					}),
					model: "stub/mid",
					costUsd: 0,
					tokensUsed: 0,
					durationMs: 0,
				};
			};

			const fw = new AnalyzerFramework({ db, llm });
			fw.register(turnPairCoreAnalyzer);
			fw.register(turnPairLlmAnalyzer);
			fw.register(sessionOverviewAnalyzer);

			// Run all three over all sessions
			const sessions = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
			for (const s of sessions) {
				await fw.run("turn-pair-core", s.id);
				await fw.run("turn-pair-llm", s.id);
				await fw.run("session-overview", s.id);
			}

			// Verify there are turn-pair-core metric nodes
			const metrics = db.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE node_kind = 'metric'").get() as { c: number };
			assert.ok(metrics.c > 0, "should have turn-pair-core metric nodes");

			// Verify there is at least one session-overview summary
			const summaries = db.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE node_kind = 'summary'").get() as { c: number };
			assert.equal(summaries.c, sessions.length);

			// Verify edges
			const edgeCounts = db.prepare(`
				SELECT edge_kind, COUNT(*) as c FROM analysis_edges GROUP BY edge_kind
			`).all() as Array<{ edge_kind: string; c: number }>;
			const kinds = new Set(edgeCounts.map((e) => e.edge_kind));
			assert.ok(kinds.has("anchors"));
			assert.ok(kinds.has("consumes"));
		} finally {
			close();
		}
	});
});
