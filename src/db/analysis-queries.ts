/**
 * All SQL for the analyzer framework tables lives here.
 *
 * The framework reads from / writes to:
 *   - analyzer_defs
 *   - analyzer_versions
 *   - prompt_registry
 *   - analyzer_configs
 *   - analysis_runs
 *   - analysis_nodes
 *   - analysis_edges
 *   - analysis_progress
 *
 * Plus the materialized `proposals` table.
 */

import type Database from "better-sqlite3";
import type {
	AnalysisNodeRow,
	AnalyzerConfig,
	AnalyzerDef,
	AnalyzerVersion,
	MessageRow,
	ProgressRow,
	PromptVersion,
	RunRow,
} from "../analyze/types.js";
import { computeConfigHash, fullHash, shortHash, uuidv7 } from "../analyze/input-hash.js";

// ── analyzer_defs ──

export function upsertAnalyzerDef(db: Database.Database, def: AnalyzerDef): void {
	db.prepare(`
		INSERT INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			label=excluded.label,
			description=excluded.description,
			anchor_span=excluded.anchor_span,
			dependencies=excluded.dependencies
	`).run(def.id, def.label, def.description, def.anchorSpan, JSON.stringify(def.dependencies), new Date().toISOString());
}

export function getAnalyzerDef(db: Database.Database, id: string): AnalyzerDef | undefined {
	return db.prepare("SELECT * FROM analyzer_defs WHERE id = ?").get(id) as any;
}

// ── analyzer_versions ──

export function upsertAnalyzerVersion(db: Database.Database, v: AnalyzerVersion): void {
	db.prepare(`
		INSERT INTO analyzer_versions (analyzer_id, version_id, implementation_kind, code_ref, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(analyzer_id, version_id) DO NOTHING
	`).run(v.analyzerId, v.versionId, v.implementationKind, v.codeRef ?? null, new Date().toISOString());
}

// ── prompt_registry ──

export function registerPrompt(db: Database.Database, p: PromptVersion): void {
	db.prepare(`
		INSERT OR IGNORE INTO prompt_registry (hash, content, role, created_at)
		VALUES (?, ?, ?, ?)
	`).run(p.hash, p.content, p.role ?? null, new Date().toISOString());
}

// ── analyzer_configs ──

/**
 * Idempotently resolve a config: if a row with this (analyzer_id,
 * config_hash) already exists, return that row's id; otherwise
 * insert a new row with a fresh UUID.
 */
export function resolveConfig(db: Database.Database, args: {
	analyzerId: string;
	configJson: Record<string, unknown>;
	label?: string;
}): AnalyzerConfig {
	const configHash = computeConfigHash(args.configJson);
	// Upsert by (analyzer_id, config_hash). If a row already exists,
	// the INSERT OR IGNORE is a no-op and we re-read the id.
	const newId = uuidv7();
	db.prepare(`
		INSERT OR IGNORE INTO analyzer_configs (id, analyzer_id, config_hash, config_json, label, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(newId, args.analyzerId, configHash, JSON.stringify(args.configJson), args.label ?? null, new Date().toISOString());

	const row = db.prepare(`
		SELECT id, analyzer_id, config_json, label FROM analyzer_configs
		WHERE analyzer_id = ? AND config_hash = ?
	`).get(args.analyzerId, configHash) as { id: string; analyzer_id: string; config_json: string; label: string | null };

	return {
		id: row.id,
		analyzerId: row.analyzer_id,
		configHash,
		configJson: JSON.parse(row.config_json),
		label: row.label ?? undefined,
	};
}

// ── analysis_runs ──

export function createRun(db: Database.Database, args: {
	id: string;
	analyzerId: string;
	analyzerVersionId: string;
	configId: string;
	sessionId: string;
	promptBundleHash: string;
	modelSpec?: string;
}): void {
	db.prepare(`
		INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id,
			status, prompt_bundle_hash, started_at, model_spec, cost_usd, tokens_used,
			nodes_produced, nodes_skipped)
		VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, 0, 0, 0, 0)
	`).run(
		args.id,
		args.analyzerId,
		args.analyzerVersionId,
		args.configId,
		args.sessionId,
		args.promptBundleHash,
		new Date().toISOString(),
		args.modelSpec ?? null,
	);
}

export function updateRun(db: Database.Database, id: string, patch: Partial<{
	status: string;
	finishedAt: string;
	costUsd: number;
	tokensUsed: number;
	nodesProduced: number;
	nodesSkipped: number;
	errorMessage: string | null;
}>): void {
	const fields: string[] = [];
	const values: unknown[] = [];
	if (patch.status !== undefined) { fields.push("status = ?"); values.push(patch.status); }
	if (patch.finishedAt !== undefined) { fields.push("finished_at = ?"); values.push(patch.finishedAt); }
	if (patch.costUsd !== undefined) { fields.push("cost_usd = ?"); values.push(patch.costUsd); }
	if (patch.tokensUsed !== undefined) { fields.push("tokens_used = ?"); values.push(patch.tokensUsed); }
	if (patch.nodesProduced !== undefined) { fields.push("nodes_produced = ?"); values.push(patch.nodesProduced); }
	if (patch.nodesSkipped !== undefined) { fields.push("nodes_skipped = ?"); values.push(patch.nodesSkipped); }
	if (patch.errorMessage !== undefined) { fields.push("error_message = ?"); values.push(patch.errorMessage); }
	if (fields.length === 0) return;
	values.push(id);
	db.prepare(`UPDATE analysis_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function getRun(db: Database.Database, id: string): RunRow | undefined {
	return db.prepare("SELECT * FROM analysis_runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function findStaleRunningRuns(db: Database.Database): RunRow[] {
	return db.prepare("SELECT * FROM analysis_runs WHERE status = 'running'").all() as RunRow[];
}

// ── analysis_nodes ──

export function findNodeByInputHash(db: Database.Database, inputHash: string): AnalysisNodeRow | undefined {
	return db.prepare("SELECT * FROM analysis_nodes WHERE input_hash = ? LIMIT 1").get(inputHash) as AnalysisNodeRow | undefined;
}

export function insertNode(db: Database.Database, args: {
	id: string;
	sessionId: string;
	analyzerId: string;
	analyzerVersionId: string;
	configId: string;
	runId: string;
	nodeKind: string;
	contentJson: string;
	sourceSetHash: string;
	inputHash: string;
	modelUsed?: string;
	costUsd?: number;
	tokensUsed?: number;
	durationMs?: number;
	createdAt: string;
}): void {
	db.prepare(`
		INSERT OR IGNORE INTO analysis_nodes (
			id, session_id, analyzer_id, analyzer_version_id, config_id, run_id,
			node_kind, content_json, source_set_hash, input_hash,
			model_used, cost_usd, tokens_used, duration_ms, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		args.id,
		args.sessionId,
		args.analyzerId,
		args.analyzerVersionId,
		args.configId,
		args.runId,
		args.nodeKind,
		args.contentJson,
		args.sourceSetHash,
		args.inputHash,
		args.modelUsed ?? null,
		args.costUsd ?? 0,
		args.tokensUsed ?? 0,
		args.durationMs ?? null,
		args.createdAt,
	);
}

export function getNode(db: Database.Database, id: string): AnalysisNodeRow | undefined {
	return db.prepare("SELECT * FROM analysis_nodes WHERE id = ?").get(id) as AnalysisNodeRow | undefined;
}

export function getAllSessionNodes(db: Database.Database, sessionId: string): AnalysisNodeRow[] {
	return db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ?").all(sessionId) as AnalysisNodeRow[];
}

export function getSessionNodesByAnalyzer(db: Database.Database, sessionId: string, analyzerId: string): AnalysisNodeRow[] {
	return db.prepare("SELECT * FROM analysis_nodes WHERE session_id = ? AND analyzer_id = ?").all(sessionId, analyzerId) as AnalysisNodeRow[];
}

// ── analysis_edges ──

export function insertEdge(db: Database.Database, args: {
	fromNodeId: string;
	toRefKind: string;
	toRefId: string;
	edgeKind: string;
	ordinal?: number;
}): void {
	db.prepare(`
		INSERT OR IGNORE INTO analysis_edges (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
		VALUES (?, ?, ?, ?, ?)
	`).run(args.fromNodeId, args.toRefKind, args.toRefId, args.edgeKind, args.ordinal ?? 0);
}

export function getEdgesFrom(db: Database.Database, fromNodeId: string): Array<{ to_ref_kind: string; to_ref_id: string; edge_kind: string; ordinal: number }> {
	return db.prepare("SELECT to_ref_kind, to_ref_id, edge_kind, ordinal FROM analysis_edges WHERE from_node_id = ?").all(fromNodeId) as any;
}

export function getEdgesTo(db: Database.Database, toRefKind: string, toRefId: string): Array<{ from_node_id: string; edge_kind: string }> {
	return db.prepare("SELECT from_node_id, edge_kind FROM analysis_edges WHERE to_ref_kind = ? AND to_ref_id = ?").all(toRefKind, toRefId) as any;
}

export function getAnchoredMessageIds(db: Database.Database, nodeId: string): string[] {
	return (db.prepare(`
		SELECT to_ref_id FROM analysis_edges
		WHERE from_node_id = ? AND to_ref_kind = 'message' AND edge_kind = 'anchors'
		ORDER BY ordinal ASC
	`).all(nodeId) as Array<{ to_ref_id: string }>).map((r) => r.to_ref_id);
}

// ── analysis_progress ──

export function getProgress(db: Database.Database, args: {
	analyzerId: string;
	analyzerVersionId: string;
	configId: string;
	sessionId: string;
}): ProgressRow | undefined {
	return db.prepare(`
		SELECT * FROM analysis_progress
		WHERE analyzer_id = ? AND analyzer_version_id = ? AND config_id = ? AND session_id = ?
	`).get(args.analyzerId, args.analyzerVersionId, args.configId, args.sessionId) as ProgressRow | undefined;
}

export function upsertProgress(db: Database.Database, args: {
	analyzerId: string;
	analyzerVersionId: string;
	configId: string;
	sessionId: string;
	cursorJson: string | null;
	lastRunId: string | null;
	totalAnalyzed: number;
	status: "ok" | "in_progress" | "error" | "needs_rerun";
	errorMessage: string | null;
}): void {
	db.prepare(`
		INSERT INTO analysis_progress (
			analyzer_id, analyzer_version_id, config_id, session_id,
			cursor_json, last_run_id, total_analyzed, status, error_message, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(analyzer_id, analyzer_version_id, config_id, session_id) DO UPDATE SET
			cursor_json = excluded.cursor_json,
			last_run_id = excluded.last_run_id,
			total_analyzed = excluded.total_analyzed,
			status = excluded.status,
			error_message = excluded.error_message,
			updated_at = excluded.updated_at
	`).run(
		args.analyzerId,
		args.analyzerVersionId,
		args.configId,
		args.sessionId,
		args.cursorJson,
		args.lastRunId,
		args.totalAnalyzed,
		args.status,
		args.errorMessage,
		new Date().toISOString(),
	);
}

// ── Messages ──

export function getMessage(db: Database.Database, id: string): MessageRow | undefined {
	return db.prepare(`
		SELECT id, session_id, parent_id, timestamp, role,
		       content_text, content_thinking, tool_calls, tool_results, meta_json
		FROM messages WHERE id = ?
	`).get(id) as MessageRow | undefined;
}
