import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrate } from "../../src/db/schema.js";
import { materializeProposals } from "../../src/analyze/proposal-materializer.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch { /* ignore */ } } };
}

function setupPrerequisites(db: Database.Database): void {
	db.prepare("INSERT INTO sessions (id, file_path, project, cwd, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, '', '', '', '', 0, 0, 0, 0)").run("test-session");
	db.prepare("INSERT INTO analyzer_defs (id, label, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?)").run("session-overview", "Session Overview", "full_session", "[]", new Date().toISOString());
	db.prepare("INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, created_at) VALUES (?, ?, ?, ?)").run("session-overview", "v1-overview-001", "in_process_llm", new Date().toISOString());
	db.prepare("INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("cfg-default", "session-overview", "hash-default", '{}', "default", new Date().toISOString());
	db.prepare("INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id, status, prompt_bundle_hash, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
		"run-test-001", "session-overview", "v1-overview-001", "cfg-default", "test-session", "ok", "pb-hash-001", new Date().toISOString(),
	);
}

describe("materializeProposals", () => {
	it("inserts proposals from a session-overview node", () => {
		const { db, close } = tempDb();
		try {
			setupPrerequisites(db);
			const node: AnalysisNodeRow = {
				id: "node-test-001", session_id: "test-session", analyzer_id: "session-overview",
				analyzer_version_id: "v1-overview-001", config_id: "cfg-default", run_id: "run-test-001",
				node_kind: "summary",
				content_json: JSON.stringify({ improvement_proposals: [{ target_type: "agents_md", target_path: "~/.pi/agent/AGENTS.md", title: "Add tool selection guidance", summary: "Agent chose wrong tool repeatedly", detail: "The agent should prefer pnpm over npm", evidence: "User said 'use pnpm not npm'", confidence: 0.8, severity: "correction" }] }),
				source_set_hash: "ss-hash-001", input_hash: "ih-hash-001", created_at: new Date().toISOString(),
				model_used: "test-model", cost_usd: 0.01, tokens_used: 100, duration_ms: 500,
			};
			db.prepare("INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				node.id, node.session_id, node.analyzer_id, node.analyzer_version_id, node.config_id, node.run_id, node.node_kind, node.content_json, node.source_set_hash, node.input_hash, node.created_at,
			);
			const proposals = materializeProposals(db, node);
			assert.equal(proposals.length, 1, "should extract 1 proposal");
			assert.equal(proposals[0]!.targetType, "agents_md");
			assert.equal(proposals[0]!.title, "Add tool selection guidance");
			const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposals[0]!.id) as Record<string, unknown>;
			assert.ok(row, "proposal should be in database");
			assert.equal(row.status, "open");
		} finally { close(); }
	});

	it("deduplicates proposals with the same dedup key", () => {
		const { db, close } = tempDb();
		try {
			setupPrerequisites(db);
			const node1: AnalysisNodeRow = { ...makeNode(), id: "node-001" };
			db.prepare("INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				node1.id, node1.session_id, node1.analyzer_id, node1.analyzer_version_id, node1.config_id, node1.run_id, node1.node_kind, node1.content_json, node1.source_set_hash, node1.input_hash, node1.created_at,
			);
			materializeProposals(db, node1);

			const node2: AnalysisNodeRow = { ...makeNode(), id: "node-002", input_hash: "ih-hash-002" };
			db.prepare("INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				node2.id, node2.session_id, node2.analyzer_id, node2.analyzer_version_id, node2.config_id, node2.run_id, node2.node_kind, node2.content_json, node2.source_set_hash, node2.input_hash, node2.created_at,
			);
			const proposals2 = materializeProposals(db, node2);
			assert.equal(proposals2.length, 0, "should skip duplicated proposal");
		} finally { close(); }
	});

	it("handles node without improvement_proposals", () => {
		const { db, close } = tempDb();
		try {
			setupPrerequisites(db);
			const node: AnalysisNodeRow = { ...makeNode(), content_json: JSON.stringify({ total_pairs: 5, session_summary: "OK session" }) };
			db.prepare("INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				node.id, node.session_id, node.analyzer_id, node.analyzer_version_id, node.config_id, node.run_id, node.node_kind, node.content_json, node.source_set_hash, node.input_hash, node.created_at,
			);
			const proposals = materializeProposals(db, node);
			assert.equal(proposals.length, 0, "should return empty for non-proposal node");
		} finally { close(); }
	});
});

function makeNode(overrides: Partial<AnalysisNodeRow> = {}): AnalysisNodeRow {
	return {
		id: "node-test-001", session_id: "test-session", analyzer_id: "session-overview",
		analyzer_version_id: "v1-overview-001", config_id: "cfg-default", run_id: "run-test-001",
		node_kind: "summary",
		content_json: JSON.stringify({ improvement_proposals: [{ target_type: "agents_md", title: "Add tool guidance", summary: "Agent chose wrong tool", severity: "correction", confidence: 0.8 }] }),
		source_set_hash: "ss-hash-001", input_hash: "ih-hash-001", created_at: new Date().toISOString(),
		model_used: "test-model", cost_usd: 0.01, tokens_used: 100, duration_ms: 500,
		...overrides,
	};
}