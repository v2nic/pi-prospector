import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { getStats, listProposalsV2, acceptProposalV2, rejectProposalV2 } from "../../src/db/queries.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

/** Insert a test proposal directly into the proposals table. */
function insertTestProposal(db: Database.Database, p: {
	id: string;
	session_id: string;
	target_type?: string;
	target_path?: string;
	severity?: string;
	summary: string;
	title?: string;
	status?: string;
}): void {
	db.prepare(`
		INSERT INTO proposals (id, created_at, session_id, target, target_type, target_path, severity, summary, title, status, dedup_key, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		p.id, new Date().toISOString(), p.session_id, p.target_type ?? "config",
		p.target_type ?? "config", p.target_path ?? null, p.severity ?? "suggestion",
		p.summary, p.title ?? p.summary, p.status ?? "open",
		`dh-${p.id}`, new Date().toISOString(),
	);
}

describe("end-to-end sync", () => {
	it("syncs simple.jsonl into database", () => {
		const { db, close } = tempDb();
		try {
			const result = runSync(db, FIXTURES);
			assert.ok(result.sessionsProcessed >= 1, `expected >=1 session, got ${result.sessionsProcessed}`);
			assert.ok(result.messagesInserted > 0, `expected messages, got ${result.messagesInserted}`);
			const stats = getStats(db);
			assert.ok(stats.totalSessions >= 1);
			assert.ok(stats.totalMessages >= 1);
		} finally {
			close();
		}
	});

	it("incremental re-sync skips unchanged files", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const stats1 = getStats(db);

			// Second sync should skip all
			const result2 = runSync(db, FIXTURES);
			assert.ok(result2.sessionsSkipped >= 1);
			assert.equal(result2.messagesInserted, 0);

			const stats2 = getStats(db);
			assert.equal(stats2.totalSessions, stats1.totalSessions);
		} finally {
			close();
		}
	});

	it("handles compacted session (compactionSummary entries)", () => {
		const { db, close } = tempDb();
		try {
			const result = runSync(db, FIXTURES);
			// compacted.jsonl should be among those synced
			const stats = getStats(db);
			assert.ok(stats.totalSessions >= 2, "should index at least 2 sessions (simple + compacted)");
		} finally {
			close();
		}
	});
});

describe("proposals v2", () => {
	it("inserts and retrieves a proposal", () => {
		const { db, close } = tempDb();
		try {
			// First insert a session so FK works
			runSync(db, FIXTURES);

			// Get a session ID from the DB
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };

			insertTestProposal(db, {
				id: "p-test-001",
				session_id: row.id,
				target_type: "config",
				target_path: "AGENTS.md § Tool usage",
				severity: "friction",
				summary: "Agent reads entire files instead of sections",
				title: "Optimize file reading",
			});

			const proposals = listProposalsV2(db);
			assert.ok(proposals.length >= 1);
			assert.equal(proposals[0]!.target_type, "config");
			assert.equal(proposals[0]!.target_path, "AGENTS.md § Tool usage");
		} finally {
			close();
		}
	});

	it("accepts and rejects proposals", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };

			insertTestProposal(db, { id: "p1", session_id: row.id, severity: "friction", summary: "s1", dedup_key: "dk1" });
			insertTestProposal(db, { id: "p2", session_id: row.id, severity: "correction", summary: "s2", dedup_key: "dk2" });

			assert.equal(acceptProposalV2(db, "p1"), true);
			assert.equal(rejectProposalV2(db, "p2"), true);

			const accepted = listProposalsV2(db, "applied");
			assert.equal(accepted.length, 1);
			assert.equal(accepted[0]!.id, "p1");

			const rejected = listProposalsV2(db, "rejected");
			assert.equal(rejected.length, 1);
			assert.equal(rejected[0]!.id, "p2");
		} finally {
			close();
		}
	});

	it("stats include proposal counts", () => {
		const { db, close } = tempDb();
		try {
			runSync(db, FIXTURES);
			const row = db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };

			insertTestProposal(db, { id: "pa", session_id: row.id, severity: "friction", summary: "a" });
			insertTestProposal(db, { id: "pb", session_id: row.id, severity: "waste", summary: "b", status: "applied" });

			const stats = getStats(db);
			assert.equal(stats.proposalsByStatus.open, 1); // "new" maps to "open" in v2
			assert.equal(stats.proposalsByStatus.applied, 1); // "accepted" maps to "applied" in v2
		} finally {
			close();
		}
	});
});