/**
 * Integration test: directly invokes pi-prospector commands without Pi runtime.
 * Tests the actual business logic end-to-end against a real database.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { migrate } from "../../src/db/schema.js";
import { getStats, listProposalsV2, acceptProposalV2, rejectProposalV2 } from "../../src/db/queries.js";
import { runSync } from "../../src/sync/index.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prospector-int-"));
const dbPath = path.join(tmpDir, "test.db");
const fixtureDir = path.resolve(import.meta.dirname, "../../tests/fixtures");

let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string, detail?: string): void {
	if (condition) {
		console.log(`  ✅ ${label}`);
		pass++;
	} else {
		console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
		fail++;
	}
}

console.log("═══════════════════════════════════════════");
console.log("  pi-prospector integration tests (v2)");
console.log("═══════════════════════════════════════════\n");

// --- Setup: create DB and sync fixtures ---
console.log("Setup: syncing fixture data...");
const db = new Database(dbPath);
migrate(db);
const result = runSync(db, fixtureDir);
console.log(`  Synced: ${result.sessionsProcessed} sessions, ${result.messagesInserted} messages, ${result.errors.length} errors\n`);

// --- Test: Stats ---
console.log("Stats command:");
const stats = getStats(db);
assert(stats.totalSessions >= 1, "totalSessions >= 1", `got ${stats.totalSessions}`);
assert(stats.totalMessages >= 1, "totalMessages >= 1", `got ${stats.totalMessages}`);
assert((stats.proposalsByStatus["open"] ?? 0) === 0, "no open proposals initially", `got ${stats.proposalsByStatus["open"] ?? 0}`);
console.log("");

// --- Test: Proposals (empty) ---
console.log("Proposals command (empty DB):");
const emptyProposals = listProposalsV2(db);
assert(emptyProposals.length === 0, "no proposals initially", `got ${emptyProposals.length}`);
console.log("");

// Get a real session ID (FK constraint requires it)
const realSessionIds = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
assert(realSessionIds.length >= 1, "have at least 1 synced session", `got ${realSessionIds.length}`);
const realSessionId = realSessionIds[0]!.id;

// --- Test: Insert + list proposals (v2) ---
console.log("Insert and list proposals:");
db.prepare(`
	INSERT INTO proposals (id, created_at, session_id, target, target_type, target_path, severity, summary, title, status, dedup_key, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
	"p-test-001", new Date().toISOString(), realSessionId, "config", "config",
	"src/foo.ts", "suggestion", "Consider extracting helper function",
	"Consider extracting helper function", "open", "dh-001", new Date().toISOString(),
);

const listed = listProposalsV2(db);
assert(listed.length === 1, "listProposalsV2 returns 1", `got ${listed.length}`);
assert(listed[0]!.status === "open", "proposal status is 'open'", `got ${listed[0]!.status}`);
assert(listed[0]!.target_type === "config", "target_type is 'config'", `got ${listed[0]!.target_type}`);
console.log("");

// --- Test: Accept proposal ---
console.log("Accept command:");
const acceptOk = acceptProposalV2(db, "p-test-001");
assert(acceptOk === true, "acceptProposalV2 succeeds");
const accepted = listProposalsV2(db, "applied");
assert(accepted.length === 1, "1 accepted proposal", `got ${accepted.length}`);
const stillOpen = listProposalsV2(db, "open");
assert(stillOpen.length === 0, "0 open proposals after accept", `got ${stillOpen.length}`);
console.log("");

// --- Test: Reject proposal ---
console.log("Reject command:");
db.prepare(`
	INSERT INTO proposals (id, created_at, session_id, target, target_type, target_path, severity, summary, title, status, dedup_key, updated_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
	"p-test-002", new Date().toISOString(), realSessionId, "agents_md",
	"agents_md", "~/.pi/agent/AGENTS.md", "friction",
	"Memory leak in event listener", "Memory leak in event listener", "open", "dh-002", new Date().toISOString(),
);
const rejectOk = rejectProposalV2(db, "p-test-002");
assert(rejectOk === true, "rejectProposalV2 succeeds");
const rejected = listProposalsV2(db, "rejected");
assert(rejected.length === 1, "1 rejected proposal", `got ${rejected.length}`);
console.log("");

// --- Test: Stats with proposals ---
console.log("Stats after proposals:");
const stats2 = getStats(db);
assert(stats2.proposalsByStatus.applied === 1, "1 accepted in stats", `got ${stats2.proposalsByStatus.applied}`);
assert(stats2.proposalsByStatus.rejected === 1, "1 rejected in stats", `got ${stats2.proposalsByStatus.rejected}`);
assert((stats2.proposalsByStatus.open ?? 0) === 0, "0 open in stats", `got ${stats2.proposalsByStatus.open ?? 0}`);
console.log("");

// --- Test: Incremental re-sync ---
console.log("Incremental re-sync:");
const result2 = runSync(db, fixtureDir);
assert(result2.sessionsSkipped >= 1, "sessions skipped on re-sync", `got ${result2.sessionsSkipped}`);
assert(result2.sessionsProcessed === 0, "no new sessions processed", `got ${result2.sessionsProcessed}`);
console.log("");

// Cleanup
db.close();
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

// Summary
console.log("═══════════════════════════════════════════");
console.log(`  Results: ${pass} passed, ${fail} failed (out of ${pass + fail})`);
console.log("═══════════════════════════════════════════\n");

process.exit(fail > 0 ? 1 : 0);
