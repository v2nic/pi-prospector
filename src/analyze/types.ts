/**
 * Public type definitions for the analyzer framework.
 *
 * The framework exposes a small surface:
 *   - Analyzer implementations conform to the Analyzer interface
 *   - The framework's run() executes plan/analyze, inserts nodes,
 *     inserts edges, materializes proposals, and updates cursors
 *   - AnalyzerPlanContext / AnalyzerRunContext provide scoped
 *     access to messages, own nodes, and dependency nodes
 *
 * All shapes are plain TypeScript interfaces. The runtime values are
 * stored as TEXT/JSON in SQLite; TypeBox is reserved for Pi tool
 * registration where the host SDK requires it.
 */

import type Database from "better-sqlite3";
import type { MessageRole } from "../types.js";
import type { EdgeKind, RefKind } from "./edge-kinds.js";
import { EDGE_KINDS, REF_KINDS } from "./edge-kinds.js";

// ── Analyzer definition ──

export interface AnalyzerDef {
	id: string;
	label: string;
	description: string;
	anchorSpan: "pair" | "segment" | "full_session";
	dependencies: string[];
}

export type ImplementationKind = "deterministic" | "in_process_llm" | "pi_subagent";

export interface AnalyzerVersion {
	analyzerId: string;
	versionId: string;
	implementationKind: ImplementationKind;
	codeRef?: string;
}

export interface PromptVersion {
	/** Content hash (first 16 hex chars of SHA-256). */
	hash: string;
	/** Full prompt template text. */
	content: string;
	/** Full 64-hex SHA-256 for verification. */
	fullHash: string;
	role?: "classify" | "map" | "reduce" | "verify";
}

export interface AnalyzerConfig {
	id: string;
	analyzerId: string;
	configJson: Record<string, unknown>;
	configHash: string;
	label?: string;
}

// ── Source references ──

export interface SourceRef {
	kind: "message" | "analysis_node" | "session";
	id: string;
}

// ── Analysis unit (input to analyze()) ──

export interface AnalysisUnit {
	sources: SourceRef[];
	sourceSetHash: string;
	/** What kind of conversation entity this unit targets. */
	anchorKind: "message" | "pair" | "segment" | "session" | "analysis_node" | "none";
	/** The id of the anchor (message.id or session.id), null for 'none'. */
	anchorRef?: string;
	meta?: Record<string, unknown>;
}

// ── Analysis result (output of analyze()) ──

export interface AnalysisResult {
	contentJson: Record<string, unknown>;
	nodeKind: "metric" | "classification" | "summary" | "proposal" | "error";
	/** What kind of conversation entity this node is about. */
	anchorKind: "message" | "pair" | "segment" | "session" | "analysis_node" | "none";
	/** The id of the anchor (message.id or session.id), null for 'none'. */
	anchorRef?: string;
	edges: Array<{
		toRefKind: RefKind;
		toRefId: string;
		edgeKind: EdgeKind;
		ordinal?: number;
	}>;
	modelUsed?: string;
	costUsd?: number;
	tokensUsed?: number;
	durationMs?: number;
}

// ── LLM abstraction ──
//
// The framework passes an llm() function into the run context.
// In production this is wired to @earendil-works/pi-ai; in tests it
// is a stub that returns canned responses.

export interface LLMRequest {
	model: string;
	system?: string;
	user: string;
	jsonSchema?: Record<string, unknown>;
	temperature?: number;
	maxTokens?: number;
}

export interface LLMResponse {
	text: string;
	model: string;
	costUsd: number;
	tokensUsed: number;
	durationMs: number;
}

export type LLMCaller = (request: LLMRequest) => Promise<LLMResponse>;

// ── Database row types (read-only views used by analyzers) ──

export interface MessageRow {
	id: string;
	session_id: string;
	parent_id: string | null;
	timestamp: string | null;
	role: MessageRole;
	content_text: string | null;
	content_thinking: string | null;
	tool_calls: string | null;
	tool_results: string | null;
	meta_json: string | null;
}

export interface AnalysisNodeRow {
	id: string;
	session_id: string;
	analyzer_id: string;
	analyzer_version_id: string;
	config_id: string;
	run_id: string;
	node_kind: string;
	content_json: string;
	source_set_hash: string;
	input_hash: string;
	created_at: string;
	model_used: string | null;
	cost_usd: number | null;
	tokens_used: number | null;
	duration_ms: number | null;
}

export interface RunRow {
	id: string;
	analyzer_id: string;
	analyzer_version_id: string;
	config_id: string;
	session_id: string;
	status: string;
	prompt_bundle_hash: string;
	started_at: string;
	finished_at: string | null;
	model_spec: string | null;
	cost_usd: number;
	tokens_used: number;
	nodes_produced: number;
	nodes_skipped: number;
	error_message: string | null;
}

export interface ProgressRow {
	analyzer_id: string;
	analyzer_version_id: string;
	config_id: string;
	session_id: string;
	cursor_json: string | null;
	last_run_id: string | null;
	total_analyzed: number;
	status: "ok" | "in_progress" | "error" | "needs_rerun";
	error_message: string | null;
	updated_at: string;
}

// ── Contexts ──

export interface AnalyzerPlanContext {
	sessionId: string;
	messages: MessageRow[];
	allNodes: AnalysisNodeRow[];
	ownNodes: AnalysisNodeRow[];
	dependencyNodes: Record<string, AnalysisNodeRow[]>;
	progress: ProgressRow | null;
	db: Database.Database;
}

export interface AnalyzerRunContext {
	getMessage(id: string): MessageRow | undefined;
	getNode(id: string): AnalysisNodeRow | undefined;
	getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
	getAnchoredMessages(nodeId: string): MessageRow[];
	getSessionMessages(sessionId: string): MessageRow[];
	llm(request: LLMRequest): Promise<LLMResponse>;
	run: RunRow;
	config: AnalyzerConfig;
	prompts: Record<string, string>;
}

// ── Analyzer interface ──

export interface Analyzer {
	def: AnalyzerDef;
	version: AnalyzerVersion;
	prompts: Record<string, PromptVersion>;
	defaultConfig: AnalyzerConfig;
	plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]>;
	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult>;
}

// ── Run summary ──

export interface RunSummary {
	runId: string;
	analyzerId: string;
	analyzerVersionId: string;
	sessionId: string;
	status: "ok" | "error" | "partial";
	nodesProduced: number;
	nodesSkipped: number;
	costUsd: number;
	tokensUsed: number;
}

// ── Config resolver interface (model tiers) ──

export interface ModelTierConfig {
	cheap: string;
	mid: string;
	expensive: string;
}

export type ModelTier = "cheap" | "mid" | "expensive";

export interface RunOptions {
	configId?: string;
	/** Force re-execution even if the same input_hash exists. Default false. */
	force?: boolean;
}

// Re-export edge/RefKind constants for analyzers' convenience.
export { EDGE_KINDS, REF_KINDS, type EdgeKind, type RefKind };
