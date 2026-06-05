import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Stats } from "../types.js";

// ── Sessions ──

export interface SessionInsert {
	id: string;
	file_path: string;
	project: string;
	cwd: string;
	parent_session: string | null;
	started_at: string;
	last_line: number;
	last_modified: number;
	analyzed_at: string | null;
	message_count: number;
	branch_count: number;
}

export function upsertSession(db: Database.Database, s: SessionInsert): void {
	db.prepare(`
		INSERT INTO sessions (id, file_path, project, cwd, parent_session, started_at, last_line, last_modified, analyzed_at, message_count, branch_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			file_path=excluded.file_path, project=excluded.project, cwd=excluded.cwd,
			parent_session=excluded.parent_session, last_line=excluded.last_line,
			last_modified=excluded.last_modified, message_count=excluded.message_count,
			branch_count=excluded.branch_count
	`).run(s.id, s.file_path, s.project, s.cwd, s.parent_session, s.started_at, s.last_line, s.last_modified, s.analyzed_at, s.message_count, s.branch_count);
}

export function getCursor(db: Database.Database, filePath: string): { last_line: number; last_modified: number } | undefined {
	return db.prepare("SELECT last_line, last_modified FROM sessions WHERE file_path = ?").get(filePath) as { last_line: number; last_modified: number } | undefined;
}

export function updateCursor(db: Database.Database, sessionId: string, lastLine: number, lastModified: number): void {
	db.prepare("UPDATE sessions SET last_line = ?, last_modified = ? WHERE id = ?").run(lastLine, lastModified, sessionId);
}

export function updateMessageCount(db: Database.Database, sessionId: string, count: number): void {
	db.prepare("UPDATE sessions SET message_count = ? WHERE id = ?").run(count, sessionId);
}

export function markAnalyzed(db: Database.Database, sessionId: string): void {
	db.prepare("UPDATE sessions SET analyzed_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
}

export function getUnanalyzedSessions(db: Database.Database, limit?: number): Array<{ id: string; file_path: string; started_at: string }> {
	const sql = limit
		? "SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC LIMIT ?"
		: "SELECT id, file_path, started_at FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC";
	return (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as Array<{ id: string; file_path: string; started_at: string }>;
}

// ── Messages ──

export interface MessageInsert {
	id: string;
	session_id: string;
	parent_id: string | null;
	timestamp: string | null;
	role: string;
	content_text: string | null;
	content_thinking: string | null;
	tool_calls: string | null;
	tool_results: string | null;
}

export function insertMessage(db: Database.Database, m: MessageInsert): void {
	db.prepare(`
		INSERT OR IGNORE INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, content_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(m.id, m.session_id, m.parent_id, m.timestamp, m.role, m.content_text, m.content_thinking, m.tool_calls, m.tool_results, null);
}

export function countMessages(db: Database.Database, sessionId: string): number {
	return (db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }).c;
}

export function getSessionMessages(db: Database.Database, sessionId: string): Array<{ role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; timestamp: string | null }> {
	return db.prepare("SELECT role, content_text, content_thinking, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as any[];
}

// ── Proposals (v2 compatible) ──

export interface ProposalV2Row {
	id: string;
	created_at: string;
	session_id: string;
	analyzer_id: string | null;
	target_type: string;
	target_path: string | null;
	title: string | null;
	severity: string | null;
	summary: string;
	detail: string | null;
	evidence: string | null;
	confidence: number | null;
	status: string;
	dedup_key: string | null;
	source_node_id: string | null;
	updated_at: string | null;
}

function mapProposalRow(row: Record<string, unknown>): ProposalV2Row {
	return {
		id: String(row.id ?? ""),
		created_at: String(row.created_at ?? ""),
		session_id: String(row.session_id ?? ""),
		analyzer_id: row.analyzer_id as string | null,
		target_type: String(row.target_type ?? row.target ?? ""),
		target_path: row.target_path as string | null,
		title: row.title as string | null,
		severity: row.severity as string | null,
		summary: String(row.summary ?? ""),
		detail: row.detail as string | null,
		evidence: row.evidence as string | null,
		confidence: row.confidence as number | null,
		status: String(row.status ?? "open"),
		dedup_key: row.dedup_key as string | null,
		source_node_id: row.source_node_id as string | null,
		updated_at: row.updated_at as string | null,
	};
}

export function listProposalsV2(db: Database.Database, status?: string): ProposalV2Row[] {
	const sql = status
		? "SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC"
		: "SELECT * FROM proposals ORDER BY created_at DESC";
	const rows = (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as Record<string, unknown>[];
	return rows.map(mapProposalRow);
}

export function acceptProposalV2(db: Database.Database, id: string): boolean {
	return db.prepare("UPDATE proposals SET status = 'applied', updated_at = ? WHERE id = ? AND status IN ('open', 'new')").run(new Date().toISOString(), id).changes > 0;
}

export function rejectProposalV2(db: Database.Database, id: string): boolean {
	return db.prepare("UPDATE proposals SET status = 'rejected', updated_at = ? WHERE id = ? AND status IN ('open', 'new')").run(new Date().toISOString(), id).changes > 0;
}

export function getProposalById(db: Database.Database, id: string): ProposalV2Row | undefined {
	const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	return row ? mapProposalRow(row) : undefined;
}

// v1-compatible functions (for backward compat)

export function listProposals(db: Database.Database, status?: string): ProposalV2Row[] {
	return listProposalsV2(db, status);
}

export function acceptProposal(db: Database.Database, id: string): boolean {
	return acceptProposalV2(db, id);
}

export function rejectProposal(db: Database.Database, id: string): boolean {
	return rejectProposalV2(db, id);
}

export function computeDedupHash(target: string, severity: string, summary: string): string {
	return createHash("sha256").update(`${target}|${severity}|${summary}`).digest("hex").slice(0, 16);
}

// ── Stats ──

export function getStats(db: Database.Database): Stats {
	const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
	const totalMessages = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE role IN ('user','assistant')").get() as { c: number }).c;
	const totalToolResults = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE role = 'toolResult'").get() as { c: number }).c;
	const messagesProcessed = (db.prepare("SELECT SUM(message_count) as c FROM sessions WHERE analyzed_at IS NOT NULL").get() as { c: number | null }).c ?? 0;
	const pOpen = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status IN ('open', 'new')").get() as { c: number }).c;
	const pApplied = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'applied'").get() as { c: number }).c;
	const pRejected = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'rejected'").get() as { c: number }).c;
	const pDuplicate = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'duplicate'").get() as { c: number }).c;
	return { totalSessions, totalMessages, totalToolResults, messagesProcessed, proposalsByStatus: { open: pOpen, applied: pApplied, rejected: pRejected, duplicate: pDuplicate } };
}