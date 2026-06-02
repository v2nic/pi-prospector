import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrate } from "../../src/db/schema.js";

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch { /* ignore */ } } };
}

describe("migration 002: analyzer framework tables", () => {
	it("creates analyzer_defs table", () => {
		const { db, close } = tempDb();
		try {
			db.prepare("INSERT INTO analyzer_defs (id, label, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?)").run(
				"test-analyzer", "Test Analyzer", "pair", "[]", new Date().toISOString(),
			);
			const row = db.prepare("SELECT * FROM analyzer_defs WHERE id = ?").get("test-analyzer") as Record<string, unknown>;
			assert.ok(row);
			assert.equal(row.id, "test-analyzer");
			assert.equal(row.label, "Test Analyzer");
			assert.equal(row.anchor_span, "pair");
		} finally {
			close();
		}
	});

	it("creates analyzer_versions table", () => {
		const { db, close } = tempDb();
		try {
			db.prepare("INSERT INTO analyzer_defs (id, label, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?)").run(
				"test-analyzer", "Test Analyzer", "pair", "[]", new Date().toISOString(),
			);
			db.prepare("INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, created_at) VALUES (?, ?, ?, ?)").run(
				"test-analyzer", "v1-001", "deterministic", new Date().toISOString(),
			);
			const row = db.prepare("SELECT * FROM analyzer_versions WHERE analyzer_id = ? AND version_id = ?").get("test-analyzer", "v1-001") as Record<string, unknown>;
			assert.ok(row);
			assert.equal(row.implementation_kind, "deterministic");
		} finally {
			close();
		}
	});

	it("creates prompt_registry table", () => {
		const { db, close } = tempDb();
		try {
			db.prepare("INSERT INTO prompt_registry (hash, content, role, created_at) VALUES (?, ?, ?, ?)").run(
				"abc123", "Test prompt content", "classify", new Date().toISOString(),
			);
			const row = db.prepare("SELECT * FROM prompt_registry WHERE hash = ?").get("abc123") as Record<string, unknown>;
			assert.ok(row);
			assert.equal(row.content, "Test prompt content");
		} finally {
			close();
		}
	});

	it("creates analyzer_configs table", () => {
		const { db, close } = tempDb();
		try {
			db.prepare("INSERT INTO analyzer_defs (id, label, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?)").run(
				"test-analyzer", "Test Analyzer", "pair", "[]", new Date().toISOString(),
			);
			db.prepare("INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
				"cfg-001", "test-analyzer", "hash-001", '{"key": "value"}', "default", new Date().toISOString(),
			);
			const row = db.prepare("SELECT * FROM analyzer_configs WHERE id = ?").get("cfg-001") as Record<string, unknown>;
			assert.ok(row);
			assert.equal(row.label, "default");
		} finally {
			close();
		}
	});

	it("creates analysis_runs, nodes, edges, progress tables", () => {
		const { db, close } = tempDb();
		try {
			// Insert prerequisite data
			db.prepare("INSERT INTO sessions (id, file_path, project, cwd, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, '', '', '', '', 0, 0, 0, 0)").run("test-session");
			db.prepare("INSERT INTO analyzer_defs (id, label, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?)").run("test-analyzer", "Test", "pair", "[]", new Date().toISOString());
			db.prepare("INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, created_at) VALUES (?, ?, ?, ?)").run("test-analyzer", "v1", "deterministic", new Date().toISOString());
			db.prepare("INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("cfg-001", "test-analyzer", "hash-001", '{}', "default", new Date().toISOString());

			// Insert run
			db.prepare("INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id, status, prompt_bundle_hash, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
				"run-001", "test-analyzer", "v1", "cfg-001", "test-session", "ok", "pb-hash", new Date().toISOString(),
			);
			const runRow = db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get("run-001") as Record<string, unknown>;
			assert.ok(runRow);
			assert.equal(runRow.status, "ok");

			// Insert node
			db.prepare("INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
				"node-001", "test-session", "test-analyzer", "v1", "cfg-001", "run-001", "metric", '{}', "ss-hash", "ih-hash", new Date().toISOString(),
			);
			const nodeRow = db.prepare("SELECT * FROM analysis_nodes WHERE id = ?").get("node-001") as Record<string, unknown>;
			assert.ok(nodeRow);
			assert.equal(nodeRow.node_kind, "metric");

			// Insert edge
			db.prepare("INSERT INTO analysis_edges (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal) VALUES (?, ?, ?, ?, ?)").run(
				"node-001", "analysis_node", "node-000", "consumes", 0,
			);
			const edgeRow = db.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?").get("node-001") as Record<string, unknown>;
			assert.ok(edgeRow);

			// Insert progress
			db.prepare("INSERT INTO analysis_progress (analyzer_id, analyzer_version_id, config_id, session_id, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
				"test-analyzer", "v1", "cfg-001", "test-session", "ok", new Date().toISOString(),
			);
			const progressRow = db.prepare("SELECT * FROM analysis_progress WHERE analyzer_id = ? AND session_id = ?").get("test-analyzer", "test-session") as Record<string, unknown>;
			assert.ok(progressRow);
			assert.equal(progressRow.status, "ok");
		} finally {
			close();
		}
	});

	it("proposals table has new v2 columns", () => {
		const { db, close } = tempDb();
		try {
			// Check that new columns exist
			const columns = db.pragma("table_info(proposals)") as Array<{ name: string }>;
			const columnNames = columns.map(c => c.name);
			assert.ok(columnNames.includes("source_node_id"), "should have source_node_id column");
			assert.ok(columnNames.includes("analyzer_id"), "should have analyzer_id column");
			assert.ok(columnNames.includes("target_type"), "should have target_type column");
			assert.ok(columnNames.includes("target_path"), "should have target_path column");
			assert.ok(columnNames.includes("title"), "should have title column");
			assert.ok(columnNames.includes("confidence"), "should have confidence column");
			assert.ok(columnNames.includes("updated_at"), "should have updated_at column");
		} finally {
			close();
		}
	});
});