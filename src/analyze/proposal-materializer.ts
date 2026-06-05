/**
 * Proposal materialization: Extract proposals from analysis nodes, deduplicate, insert into proposals table.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { AnalysisNodeRow, TargetType } from "../analyze/types.js";
import { computeDedupKey } from "../analyze/input-hash.js";

export interface MaterializedProposal {
	id: string;
	analysisNodeId: string;
	sessionId: string;
	analyzerId: string;
	targetType: string;
	targetPath: string | undefined;
	title: string;
	summary: string;
	detail: string | undefined;
	evidenceJson: string | undefined;
	confidence: number | undefined;
	severity: string | undefined;
	dedupKey: string;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export function materializeProposals(db: Database.Database, node: AnalysisNodeRow): MaterializedProposal[] {
	let properties: Record<string, unknown>;
	try { properties = JSON.parse(node.content_json) as Record<string, unknown>; } catch { return []; }
	const proposals = properties.improvement_proposals;
	if (!Array.isArray(proposals)) return [];

	const inserted: MaterializedProposal[] = [];
	const now = new Date().toISOString();

	for (const p of proposals) {
		if (!p || typeof p !== "object") continue;
		const proposal = p as Record<string, unknown>;
		const targetType = validTargetType(proposal.target_type) ? proposal.target_type as TargetType : "config";
		const targetPath = typeof proposal.target_path === "string" ? proposal.target_path : undefined;
		const title = String(proposal.title ?? "Untitled proposal");
		const summary = String(proposal.summary ?? "");
		const detail = typeof proposal.detail === "string" ? proposal.detail : undefined;
		const evidence = typeof proposal.evidence === "string" ? proposal.evidence : undefined;
		const confidence = typeof proposal.confidence === "number" ? proposal.confidence : undefined;
		const severity = validSeverity(proposal.severity) ? proposal.severity as string : "suggestion";

		const dedupKey = computeDedupKey(targetType, targetPath ?? "", severity, title);
		const existing = db.prepare("SELECT id FROM proposals WHERE dedup_hash = ? AND status IN ('new', 'open') LIMIT 1").get(dedupKey) as { id: string } | undefined;
		if (existing) continue;

		const id = `p-${createHash("sha256").update(`${node.id}-${targetType}-${title}-${now}`).digest("hex").slice(0, 12)}`;
		db.prepare(`INSERT INTO proposals (id, created_at, session_id, target, severity, summary, detail, evidence, status, dedup_hash, source_node_id, analyzer_id, target_type, target_path, title, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			id, now, node.session_id, targetType, severity, title, detail ?? summary, evidence ?? "", "open", dedupKey,
			node.id, node.analyzer_id, targetType, targetPath, title, confidence ?? null, now,
		);

		inserted.push({ id, analysisNodeId: node.id, sessionId: node.session_id, analyzerId: node.analyzer_id, targetType, targetPath, title, summary, detail, evidenceJson: evidence, confidence, severity, dedupKey, status: "open", createdAt: now, updatedAt: now });
	}
	return inserted;
}

function validTargetType(v: unknown): v is TargetType { return typeof v === "string" && ["agents_md", "system_md", "skill", "extension_prompt", "tool_output", "repo_doc", "config"].includes(v); }
function validSeverity(v: unknown): boolean { return typeof v === "string" && ["friction", "correction", "waste", "suggestion", "insight"].includes(v); }