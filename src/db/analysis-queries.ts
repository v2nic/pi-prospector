/**
 * Analysis framework database queries.
 * All SQL for analyzer_defs, analyzer_versions, prompt_registry, analyzer_configs,
 * analysis_runs, analysis_nodes, analysis_edges, analysis_progress lives here.
 */

import Database from "better-sqlite3";
import type {
	AnalyzerDef, AnalyzerVersion, AnalyzerConfig,
	AnalysisNodeInsert, AnalysisEdgeInsert, AnalysisRunInsert, AnalysisProgressInsert,
	AnalysisNodeRow, AnalysisRunRow, AnalysisProgressRow,
} from "../analyze/types.js";

// ── Analyzer definitions ──

export function upsertAnalyzerDef(db: Database.Database, def: AnalyzerDef): void {
	db.prepare(`INSERT INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, description=excluded.description, anchor_span=excluded.anchor_span, dependencies=excluded.dependencies`).run(def.id, def.label, def.description ?? null, def.anchorSpan, JSON.stringify(def.dependencies), def.createdAt);
}

export function getAnalyzerDef(db: Database.Database, id: string): AnalyzerDef | undefined {
	const row = db.prepare("SELECT * FROM analyzer_defs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return { id: row.id as string, label: row.label as string, description: row.description as string | undefined, anchorSpan: row.anchor_span as "pair" | "segment" | "full_session", dependencies: JSON.parse(row.dependencies as string) as string[], createdAt: row.created_at as string };
}

export function getAllAnalyzerDefs(db: Database.Database): AnalyzerDef[] {
	const rows = db.prepare("SELECT * FROM analyzer_defs").all() as Record<string, unknown>[];
	return rows.map(row => ({ id: row.id as string, label: row.label as string, description: row.description as string | undefined, anchorSpan: row.anchor_span as "pair" | "segment" | "full_session", dependencies: JSON.parse(row.dependencies as string) as string[], createdAt: row.created_at as string }));
}

// ── Analyzer versions ──

export function upsertAnalyzerVersion(db: Database.Database, v: AnalyzerVersion): void {
	db.prepare(`INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(analyzer_id, version_id) DO UPDATE SET implementation_kind=excluded.implementation_kind, code_ref=excluded.code_ref`).run(v.analyzerId, v.versionId, v.implementationKind, v.codeRef ?? null, v.createdAt);
}

export function getAnalyzerVersions(db: Database.Database, analyzerId: string): AnalyzerVersion[] {
	const rows = db.prepare("SELECT * FROM analyzer_versions WHERE analyzer_id = ? ORDER BY created_at DESC").all(analyzerId) as Record<string, unknown>[];
	return rows.map(row => ({ analyzerId: row.analyzer_id as string, versionId: row.version_id as string, implementationKind: row.implementation_kind as "deterministic" | "in_process_llm" | "pi_subagent", codeRef: row.code_ref as string | undefined, createdAt: row.created_at as string }));
}

export function getLatestAnalyzerVersion(db: Database.Database, analyzerId: string): AnalyzerVersion | undefined {
	const row = db.prepare("SELECT * FROM analyzer_versions WHERE analyzer_id = ? ORDER BY created_at DESC LIMIT 1").get(analyzerId) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return { analyzerId: row.analyzer_id as string, versionId: row.version_id as string, implementationKind: row.implementation_kind as "deterministic" | "in_process_llm" | "pi_subagent", codeRef: row.code_ref as string | undefined, createdAt: row.created_at as string };
}

// ── Prompt registry ──

export function insertPrompt(db: Database.Database, hash: string, content: string, role: string | undefined, createdAt: string): void {
	db.prepare("INSERT OR IGNORE INTO prompt_registry (hash, content, role, created_at) VALUES (?, ?, ?, ?)").run(hash, content, role ?? null, createdAt);
}

// ── Analyzer configs ──

export function insertAnalyzerConfig(db: Database.Database, config: AnalyzerConfig): void {
	db.prepare("INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(config.id, config.analyzerId, config.configHash, JSON.stringify(config.configJson), config.label ?? null, config.createdAt);
}

export function getAnalyzerConfigByHash(db: Database.Database, configHash: string): AnalyzerConfig | undefined {
	const row = db.prepare("SELECT * FROM analyzer_configs WHERE config_hash = ?").get(configHash) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return { id: row.id as string, analyzerId: row.analyzer_id as string, configJson: JSON.parse(row.config_json as string) as Record<string, unknown>, configHash: row.config_hash as string, label: row.label as string | undefined, createdAt: row.created_at as string };
}

// ── Analysis runs ──

export function insertAnalysisRun(db: Database.Database, run: AnalysisRunInsert): void {
	db.prepare(`INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id, status, prompt_bundle_hash, started_at, finished_at, model_spec, cost_usd, tokens_used, nodes_produced, nodes_skipped, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.analyzerId, run.analyzerVersionId, run.configId, run.sessionId, run.status, run.promptBundleHash, run.startedAt, run.finishedAt ?? null, run.modelSpec ?? null, run.costUsd ?? 0, run.tokensUsed ?? 0, run.nodesProduced ?? 0, run.nodesSkipped ?? 0, run.errorMessage ?? null);
}

export function updateAnalysisRun(db: Database.Database, id: string, updates: Partial<Pick<AnalysisRunRow, "status" | "finished_at" | "cost_usd" | "tokens_used" | "nodes_produced" | "nodes_skipped" | "error_message">>): void {
	const setClauses: string[] = [];
	const values: unknown[] = [];
	if (updates.status !== undefined) { setClauses.push("status = ?"); values.push(updates.status); }
	if (updates.finished_at !== undefined) { setClauses.push("finished_at = ?"); values.push(updates.finished_at); }
	if (updates.cost_usd !== undefined) { setClauses.push("cost_usd = ?"); values.push(updates.cost_usd); }
	if (updates.tokens_used !== undefined) { setClauses.push("tokens_used = ?"); values.push(updates.tokens_used); }
	if (updates.nodes_produced !== undefined) { setClauses.push("nodes_produced = ?"); values.push(updates.nodes_produced); }
	if (updates.nodes_skipped !== undefined) { setClauses.push("nodes_skipped = ?"); values.push(updates.nodes_skipped); }
	if (updates.error_message !== undefined) { setClauses.push("error_message = ?"); values.push(updates.error_message); }
	if (setClauses.length === 0) return;
	values.push(id);
	db.prepare(`UPDATE analysis_runs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

// ── Analysis nodes ──

export function insertAnalysisNode(db: Database.Database, node: AnalysisNodeInsert): void {
	db.prepare(`INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, run_id, node_kind, content_json, source_set_hash, input_hash, created_at, model_used, cost_usd, tokens_used, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(node.id, node.sessionId, node.analyzerId, node.analyzerVersionId, node.configId, node.runId, node.nodeKind, node.contentJson, node.sourceSetHash, node.inputHash, node.createdAt, node.modelUsed ?? null, node.costUsd ?? 0, node.tokensUsed ?? 0, node.durationMs ?? null);
}

export function getAnalysisNode(db: Database.Database, id: string): AnalysisNodeRow | undefined {
	const row = db.prepare("SELECT * FROM analysis_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return mapNodeRow(row);
}

export function getAnalysisNodesByAnalyzer(db: Database.Database, analyzerId: string, analyzerVersionId?: string): AnalysisNodeRow[] {
	const sql = analyzerVersionId
		? "SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND analyzer_version_id = ? ORDER BY created_at ASC"
		: "SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC";
	const params = analyzerVersionId ? [analyzerId, analyzerVersionId] : [analyzerId];
	return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(mapNodeRow);
}

export function checkInputHashExists(db: Database.Database, inputHash: string): boolean {
	const row = db.prepare("SELECT 1 FROM analysis_nodes WHERE input_hash = ? LIMIT 1").get(inputHash) as { "1": number } | undefined;
	return row !== undefined;
}

function mapNodeRow(row: Record<string, unknown>): AnalysisNodeRow {
	return { id: row.id as string, session_id: row.session_id as string, analyzer_id: row.analyzer_id as string, analyzer_version_id: row.analyzer_version_id as string, config_id: row.config_id as string, run_id: row.run_id as string, node_kind: row.node_kind as string, content_json: row.content_json as string, source_set_hash: row.source_set_hash as string, input_hash: row.input_hash as string, created_at: row.created_at as string, model_used: (row.model_used as string) ?? "", cost_usd: (row.cost_usd as number) ?? 0, tokens_used: (row.tokens_used as number) ?? 0, duration_ms: (row.duration_ms as number) ?? 0 };
}

// ── Analysis edges ──

export function insertAnalysisEdges(db: Database.Database, edges: AnalysisEdgeInsert[]): void {
	const insert = db.prepare("INSERT OR IGNORE INTO analysis_edges (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal) VALUES (?, ?, ?, ?, ?)");
	db.transaction(() => { for (const edge of edges) { insert.run(edge.fromNodeId, edge.toRefKind, edge.toRefId, edge.edgeKind, edge.ordinal ?? 0); } })();
}

// ── Analysis progress ──

export function upsertAnalysisProgress(db: Database.Database, progress: AnalysisProgressInsert): void {
	db.prepare(`INSERT INTO analysis_progress (analyzer_id, analyzer_version_id, config_id, session_id, cursor_json, last_run_id, total_analyzed, status, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(analyzer_id, analyzer_version_id, config_id, session_id) DO UPDATE SET cursor_json=excluded.cursor_json, last_run_id=excluded.last_run_id, total_analyzed=excluded.total_analyzed, status=excluded.status, error_message=excluded.error_message, updated_at=excluded.updated_at`).run(progress.analyzerId, progress.analyzerVersionId, progress.configId, progress.sessionId, progress.cursorJson ?? null, progress.lastRunId ?? null, progress.totalAnalyzed ?? 0, progress.status ?? "ok", progress.errorMessage ?? null, progress.updatedAt);
}

export function getAnalysisProgress(db: Database.Database, analyzerId: string, analyzerVersionId: string, configId: string, sessionId: string): AnalysisProgressRow | undefined {
	const row = db.prepare("SELECT * FROM analysis_progress WHERE analyzer_id = ? AND analyzer_version_id = ? AND config_id = ? AND session_id = ?").get(analyzerId, analyzerVersionId, configId, sessionId) as Record<string, unknown> | undefined;
	if (!row) return undefined;
	return { analyzer_id: row.analyzer_id as string, analyzer_version_id: row.analyzer_version_id as string, config_id: row.config_id as string, session_id: row.session_id as string, cursor_json: row.cursor_json as string, last_run_id: row.last_run_id as string, total_analyzed: row.total_analyzed as number, status: row.status as string, error_message: row.error_message as string, updated_at: row.updated_at as string };
}

// ── Session queries ──

export interface MessageRowFull {
	id: string; session_id: string; parent_id: string | null; timestamp: string | null;
	role: string; content_text: string | null; content_thinking: string | null;
	tool_calls: string | null; tool_results: string | null;
}

export function getFullSessionMessages(db: Database.Database, sessionId: string): MessageRowFull[] {
	return (db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC").all(sessionId) as Record<string, unknown>[]).map(row => ({
		id: row.id as string, session_id: row.session_id as string, parent_id: row.parent_id as string | null,
		timestamp: row.timestamp as string | null, role: row.role as string,
		content_text: row.content_text as string | null, content_thinking: row.content_thinking as string | null,
		tool_calls: row.tool_calls as string | null, tool_results: row.tool_results as string | null,
	}));
}

// ── Analysis stats ──

export function getAnalysisStats(db: Database.Database): { totalNodes: number; totalEdges: number; totalRuns: number; nodesByKind: Record<string, number>; runsByStatus: Record<string, number> } {
	const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM analysis_nodes").get() as { c: number }).c;
	const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM analysis_edges").get() as { c: number }).c;
	const totalRuns = (db.prepare("SELECT COUNT(*) as c FROM analysis_runs").get() as { c: number }).c;
	const kindRows = db.prepare("SELECT node_kind, COUNT(*) as c FROM analysis_nodes GROUP BY node_kind").all() as Array<{ node_kind: string; c: number }>;
	const nodesByKind: Record<string, number> = {};
	for (const r of kindRows) nodesByKind[r.node_kind] = r.c;
	const statusRows = db.prepare("SELECT status, COUNT(*) as c FROM analysis_runs GROUP BY status").all() as Array<{ status: string; c: number }>;
	const runsByStatus: Record<string, number> = {};
	for (const r of statusRows) runsByStatus[r.status] = r.c;
	return { totalNodes, totalEdges, totalRuns, nodesByKind, runsByStatus };
}