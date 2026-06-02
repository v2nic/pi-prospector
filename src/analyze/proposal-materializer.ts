/**
 * Materialize proposals from analysis nodes into the `proposals` table.
 *
 * When an analyzer produces a node with `node_kind = 'proposal'`, or
 * a summary node whose `content_json.improvement_proposals` array
 * contains proposal-shaped entries, the framework extracts them,
 * computes a dedup_key, and upserts into `proposals`.
 *
 * Dedup rule: an OPEN proposal with the same `dedup_key` already
 * exists → mark the new one as 'duplicate' (no insert, just track).
 * The original is preserved.
 */

import type Database from "better-sqlite3";
import { computeInputHash, fullHash, newId, shortHash } from "./input-hash.js";
import { REF_KINDS, EDGE_KINDS } from "./edge-kinds.js";

export interface ProposalShape {
	target_type: string;
	target_path: string;
	title: string;
	summary: string;
	detail: string;
	evidence: string;
	confidence: number;
	severity: string;
}

export interface MaterializedProposal {
	proposalId: string;
	analysisNodeId: string;
	sessionId: string;
	analyzerId: string;
	dedupKey: string;
	dedupHit: boolean;
}

const VALID_TARGET_TYPES = new Set([
	"agents_md",
	"system_md",
	"skill",
	"extension_prompt",
	"tool_output",
	"repo_doc",
	"config",
]);

const VALID_SEVERITIES = new Set([
	"friction",
	"correction",
	"waste",
	"suggestion",
	"insight",
]);

/**
 * Normalize a title for dedup. Whitespace, case, and trailing
 * punctuation are removed so the same idea in different forms
 * collides on one key.
 */
export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/[.!?,;:]+$/g, "")
		.trim();
}

export function computeProposalDedupKey(p: Pick<ProposalShape, "target_type" | "target_path" | "severity" | "title">): string {
	const joined = [p.target_type, p.target_path, p.severity, normalizeTitle(p.title)].join("|");
	return shortHash(joined);
}

/**
 * Determine if `obj` looks like a ProposalShape. We don't strictly
 * require every field to be present — the LLM may omit some — but
 * the required ones (target_type, title, summary) must be valid.
 */
export function isProposalShape(obj: unknown): obj is ProposalShape {
	if (!obj || typeof obj !== "object") return false;
	const o = obj as Record<string, unknown>;
	if (typeof o.target_type !== "string" || o.target_type.length === 0) return false;
	if (typeof o.title !== "string" || o.title.length === 0) return false;
	if (typeof o.summary !== "string" || o.summary.length === 0) return false;
	return true;
}

export function normalizeProposalShape(obj: Record<string, unknown>): ProposalShape {
	const targetType = VALID_TARGET_TYPES.has(obj.target_type as string)
		? (obj.target_type as string)
		: "repo_doc";
	const severity = VALID_SEVERITIES.has(obj.severity as string)
		? (obj.severity as string)
		: "suggestion";

	const confidence = typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
		? obj.confidence
		: 0.5;

	return {
		target_type: targetType,
		target_path: typeof obj.target_path === "string" ? obj.target_path : "",
		title: String(obj.title),
		summary: String(obj.summary),
		detail: typeof obj.detail === "string" ? obj.detail : "",
		evidence: typeof obj.evidence === "string" ? obj.evidence : "",
		confidence,
		severity,
	};
}

/**
 * Insert one materialized proposal and the edges that connect it
 * back to the producing node and to the session. Idempotent on
 * `(analysis_node_id)` — re-materializing the same source node
 * yields the same proposal_id.
 *
 * Returns the proposal row id and whether this call hit an existing
 * open dedup match.
 */
export function materializeProposal(
	db: Database.Database,
	args: {
		sessionId: string;
		analyzerId: string;
		sourceNodeId: string;        // the analysis_node that produced this proposal
		shape: ProposalShape;
		proposalNodeId?: string;     // optional pre-existing proposal analysis_node
	},
): MaterializedProposal {
	const dedupKey = computeProposalDedupKey(args.shape);

	// 1. Check for an open dedup match
	const existing = db.prepare(`
		SELECT id FROM proposals
		WHERE dedup_key = ? AND status = 'open'
		LIMIT 1
	`).get(dedupKey) as { id: string } | undefined;

	if (existing) {
		// Edge from source → existing proposal as 'produces' reference.
		// We don't create a new row; the source already points to the
		// canonical proposal via the produces edge.
		return {
			proposalId: existing.id,
			analysisNodeId: args.proposalNodeId ?? existing.id,
			sessionId: args.sessionId,
			analyzerId: args.analyzerId,
			dedupKey,
			dedupHit: true,
		};
	}

	const proposalNodeId = args.proposalNodeId ?? newId();
	const now = new Date().toISOString();

	// 2. Insert into proposals (UNIQUE on analysis_node_id enforces 1:1).
	// We populate both the legacy columns (target/severity/summary/dedup_hash)
	// and the new ones (target_type/target_path/title/etc.) so the
	// `/prospect-proposals` command continues to work without JOINs.
	db.prepare(`
		INSERT OR IGNORE INTO proposals (
			id, created_at, session_id, target, severity, summary, detail, evidence,
			status, dedup_hash, analysis_node_id, analyzer_id, target_type,
			target_path, title, evidence_json, confidence, dedup_key, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		proposalNodeId,
		now,
		args.sessionId,
		`${args.shape.target_type}:${args.shape.target_path || "untitled"}`,
		args.shape.severity,
		args.shape.summary,
		args.shape.detail,
		args.shape.evidence,
		dedupKey,
		proposalNodeId,
		args.analyzerId,
		args.shape.target_type,
		args.shape.target_path,
		args.shape.title,
		JSON.stringify({ text: args.shape.evidence }),
		args.shape.confidence,
		dedupKey,
		now,
	);

	return {
		proposalId: proposalNodeId,
		analysisNodeId: proposalNodeId,
		sessionId: args.sessionId,
		analyzerId: args.analyzerId,
		dedupKey,
		dedupHit: false,
	};
}

/**
 * Materialize every proposal in a node's `content_json.improvement_proposals`
 * array. Each proposal gets its own `analysis_node` row of kind
 * 'proposal' and a row in the `proposals` table.
 *
 * Edges inserted per proposal:
 *   source_node --produces--> proposal_node
 *   proposal_node --anchors--> session
 *
 * Returns the list of materialized proposals.
 */
export function materializeProposalsFromNode(
	db: Database.Database,
	args: {
		sessionId: string;
		analyzerId: string;
		analyzerVersionId: string;
		configId: string;
		runId: string;
		sourceNodeId: string;
		sourceSetHash: string;
		promptBundleHash: string;
		contentJson: Record<string, unknown>;
		now: string;
	},
): MaterializedProposal[] {
	const list = args.contentJson.improvement_proposals;
	if (!Array.isArray(list) || list.length === 0) return [];

	const out: MaterializedProposal[] = [];
	for (const raw of list) {
		if (!isProposalShape(raw)) continue;
		const shape = normalizeProposalShape(raw as unknown as Record<string, unknown>);

		const proposalNodeId = newId();
		// The proposal node's recipe is (analyzer, version, config, prompts, source).
		// Its content_json is the proposal shape itself, so input_hash is
		// stable per (analyzer, source).
		const proposalContent = {
			target_type: shape.target_type,
			target_path: shape.target_path,
			title: shape.title,
			summary: shape.summary,
			severity: shape.severity,
		};
		const proposalSourceSetHash = shortHash(`${args.sourceSetHash}|${shape.title}`);
		const proposalInputHash = computeInputHash({
			analyzerId: args.analyzerId,
			analyzerVersionId: args.analyzerVersionId,
			configId: args.configId,
			promptBundleHash: args.promptBundleHash,
			sourceSetHash: proposalSourceSetHash,
		});

		// 1. Insert the proposal analysis_node
		db.prepare(`
			INSERT OR IGNORE INTO analysis_nodes (
				id, session_id, analyzer_id, analyzer_version_id, config_id, run_id,
				node_kind, content_json, source_set_hash, input_hash, created_at
			) VALUES (?, ?, ?, ?, ?, ?, 'proposal', ?, ?, ?, ?)
		`).run(
			proposalNodeId,
			args.sessionId,
			args.analyzerId,
			args.analyzerVersionId,
			args.configId,
			args.runId,
			JSON.stringify(proposalContent),
			proposalSourceSetHash,
			proposalInputHash,
			args.now,
		);

		// 2. Materialize into proposals table
		const materialized = materializeProposal(db, {
			sessionId: args.sessionId,
			analyzerId: args.analyzerId,
			sourceNodeId: args.sourceNodeId,
			shape,
			proposalNodeId,
		});
		out.push(materialized);

		// 3. Edges: source --produces--> proposal_node
		//        and: proposal_node --anchors--> session
		if (!materialized.dedupHit) {
			db.prepare(`
				INSERT OR IGNORE INTO analysis_edges (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
				VALUES (?, ?, ?, ?, 0)
			`).run(args.sourceNodeId, REF_KINDS.ANALYSIS_NODE, proposalNodeId, EDGE_KINDS.PRODUCES);

			db.prepare(`
				INSERT OR IGNORE INTO analysis_edges (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal)
				VALUES (?, ?, ?, ?, 0)
			`).run(proposalNodeId, REF_KINDS.SESSION, args.sessionId, EDGE_KINDS.ANCHORS);
		}
	}
	return out;
}

// Re-export for convenience
export { fullHash };
