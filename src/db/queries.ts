import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Proposal, Stats } from "../types.js";

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
	meta_json?: string | null;
}

export function insertMessage(db: Database.Database, m: MessageInsert): void {
	db.prepare(`
		INSERT OR IGNORE INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, content_hash, meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(m.id, m.session_id, m.parent_id, m.timestamp, m.role, m.content_text, m.content_thinking, m.tool_calls, m.tool_results, null, m.meta_json ?? null);
}

export function countMessages(db: Database.Database, sessionId: string): number {
	return (db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId) as { c: number }).c;
}

export function getSessionMessages(db: Database.Database, sessionId: string): Array<{ role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; timestamp: string | null }> {
	return db.prepare("SELECT role, content_text, content_thinking, tool_calls, timestamp FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as any[];
}

export function getSessionMessagesFull(db: Database.Database, sessionId: string): Array<{ id: string; session_id: string; parent_id: string | null; timestamp: string | null; role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; tool_results: string | null; meta_json: string | null }> {
	return db.prepare(`
		SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking,
		       tool_calls, tool_results, meta_json
		FROM messages WHERE session_id = ? ORDER BY rowid ASC
	`).all(sessionId) as any[];
}

export function getMessageById(db: Database.Database, id: string): { id: string; session_id: string; parent_id: string | null; timestamp: string | null; role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; tool_results: string | null; meta_json: string | null } | undefined {
	return db.prepare(`
		SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking,
		       tool_calls, tool_results, meta_json
		FROM messages WHERE id = ?
	`).get(id) as any;
}

// ── Proposals ──

export function insertProposal(db: Database.Database, p: Proposal): string {
	db.prepare(`
		INSERT OR IGNORE INTO proposals (id, created_at, session_id, target, severity, summary, detail, evidence, status, dedup_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(p.id, p.created_at, p.session_id, p.target, p.severity, p.summary, p.detail, p.evidence, p.status, p.dedup_hash);
	return p.id;
}

export function listProposals(db: Database.Database, status?: string): Proposal[] {
	if (status) return db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC").all(status) as Proposal[];
	return db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all() as Proposal[];
}

export function acceptProposal(db: Database.Database, id: string): boolean {
	// Both 'new' (legacy) and 'open' (framework) are valid pre-accept states.
	return db.prepare("UPDATE proposals SET status = 'accepted' WHERE id = ? AND status IN ('new', 'open')").run(id).changes > 0;
}

export function rejectProposal(db: Database.Database, id: string): boolean {
	return db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ? AND status IN ('new', 'open')").run(id).changes > 0;
}

/**
 * List proposals joined with their source analysis_node (if any).
 * Used by the proposals command and the tool to render richer
 * output: target_type, target_path, title, confidence, etc.
 */
export function listProposalsEnriched(db: Database.Database, status?: string): Array<{
	id: string;
	created_at: string;
	updated_at: string | null;
	session_id: string;
	analyzer_id: string | null;
	target_type: string | null;
	target_path: string | null;
	title: string | null;
	summary: string;
	detail: string | null;
	evidence: string | null;
	confidence: number | null;
	severity: string;
	dedup_key: string | null;
	status: string;
	analysis_node_id: string | null;
}> {
	const where = status ? "WHERE status = ?" : "";
	const params = status ? [status] : [];
	return db.prepare(`
		SELECT id, created_at, updated_at, session_id, analyzer_id,
		       target_type, target_path, title, summary, detail, evidence,
		       confidence, severity, dedup_key, status, analysis_node_id
		FROM proposals ${where}
		ORDER BY created_at DESC
	`).all(...params) as any;
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
	const pNew = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'new'").get() as { c: number }).c;
	const pAccepted = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'accepted'").get() as { c: number }).c;
	const pRejected = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'rejected'").get() as { c: number }).c;
	return { totalSessions, totalMessages, totalToolResults, messagesProcessed, proposalsByStatus: { new: pNew, accepted: pAccepted, rejected: pRejected } };
}