import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listProposals, acceptProposal, rejectProposal, getSessionLabels } from "../db/queries.js";
import { getDbPath } from "../config.js";
import type { Proposal } from "../types.js";
import { homedir } from "node:os";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

const PROPOSAL_STATUSES = new Set(["open", "applied", "rejected", "duplicate"]);

/**
 * Parse the `proposals` argument string into an optional status filter and a
 * `full` flag. Accepts a status word (open|applied|rejected|duplicate) and/or
 * `--full`/`-v`/`--verbose`, in any order; unknown tokens are ignored.
 */
export function parseProposalsArgs(args: string): { status?: string; full: boolean } {
	let status: string | undefined;
	let full = false;
	for (const tok of (args ?? "").trim().split(/\s+/).filter(Boolean)) {
		const t = tok.toLowerCase();
		if (t === "--full" || t === "-v" || t === "--verbose") full = true;
		else if (PROPOSAL_STATUSES.has(t)) status = t;
	}
	return { status, full };
}

function formatConfidence(confidence: number | null): string {
	return confidence == null ? " n/a" : `${Math.round(confidence * 100)}%`;
}

function formatTarget(p: Proposal): string {
	return p.target_path ? `${p.target_type}: ${p.target_path}` : p.target_type;
}

/** Strongest recommendations first: confidence desc (nulls last), then newest. */
export function rankProposals(a: Proposal, b: Proposal): number {
	const ca = a.confidence ?? -1;
	const cb = b.confidence ?? -1;
	if (cb !== ca) return cb - ca;
	if (a.created_at === b.created_at) return 0;
	return a.created_at < b.created_at ? 1 : -1;
}

function severityLabel(severity: string): string {
	if (severity === "reinforcement") return "reinforce";
	return severity;
}

function conciseEntry(p: Proposal): string {
	return `  [${p.status}] ${formatConfidence(p.confidence).padStart(4)} ${severityLabel(p.severity)} · ${formatTarget(p)}\n    ${p.title}\n    ${p.summary}\n    id: ${p.id}  ·  prospect show ${p.id}`;
}

function fullEntry(p: Proposal): string {
	const lines = [conciseEntry(p)];
	if (p.detail && p.detail.trim()) lines.push(`    detail:   ${p.detail.trim()}`);
	if (p.evidence && p.evidence.trim()) lines.push(`    evidence: ${p.evidence.trim()}`);
	lines.push(`    source:   ${p.analyzer_id ?? "?"} · node ${p.source_node_id ?? "?"}`);
	return lines.join("\n");
}

/** A short, readable session label: cwd (with $HOME → ~), else project, else id. */
export function sessionLabel(s: { project: string; cwd: string } | undefined, id: string): string {
	const home = homedir();
	if (s?.cwd) return s.cwd.startsWith(home) ? `~${s.cwd.slice(home.length)}` : s.cwd;
	if (s?.project) return s.project;
	return id.slice(0, 8);
}

export async function prospectProposals(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const { status, full } = parseProposalsArgs(args);
		const proposals = listProposals(db, status).sort(rankProposals);

		if (proposals.length === 0) {
			output(ctx, status ? `No ${status} proposals found.` : "No proposals found.");
			return;
		}

		const labels = new Map(getSessionLabels(db).map((s) => [s.id, s]));

		// Group by session. Because `proposals` is already globally ranked by
		// confidence, first-seen order puts the session with the strongest single
		// recommendation first, and each group stays confidence-ranked within.
		const groups = new Map<string, Proposal[]>();
		for (const p of proposals) {
			const bucket = groups.get(p.session_id);
			if (bucket) bucket.push(p);
			else groups.set(p.session_id, [p]);
		}

		const format = full ? fullEntry : conciseEntry;
		const blocks: string[] = [];
		for (const [sessionId, group] of groups) {
			const label = sessionLabel(labels.get(sessionId), sessionId);
			const header = `═══ ${sessionId.slice(0, 8)} · ${label} · ${group.length} proposal(s) ═══`;
			blocks.push(`${header}\n${group.map(format).join("\n\n")}`);
		}

		const headline = `Proposals (${proposals.length}${status ? `, ${status}` : ""}) in ${groups.size} session(s), ranked by confidence:`;
		output(ctx, `${headline}\n\n${blocks.join("\n\n")}`);
	} finally {
		db.close();
	}
}

export async function prospectAccept(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const id = args?.trim();
	if (!id) {
		output(ctx, "Usage: /prospect-accept <id>", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const ok = acceptProposal(db, id);
		output(ctx, ok ? `Proposal ${id} applied.` : `Proposal ${id} not found or not open.`, ok ? "info" : "warning");
	} finally {
		db.close();
	}
}

export async function prospectReject(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const id = args?.trim();
	if (!id) {
		output(ctx, "Usage: /prospect-reject <id>", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const ok = rejectProposal(db, id);
		output(ctx, ok ? `Proposal ${id} rejected.` : `Proposal ${id} not found or not open.`, ok ? "info" : "warning");
	} finally {
		db.close();
	}
}

export function registerProposalsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-proposals", {
		description:
			"List proposals, ranked by confidence. Optional status filter (open|applied|rejected|duplicate) and --full for evidence/source.",
		handler: prospectProposals,
	});

	pi.registerCommand("prospect-accept", {
		description: "Accept (apply) a proposal by ID",
		handler: prospectAccept,
	});

	pi.registerCommand("prospect-reject", {
		description: "Reject a proposal by ID",
		handler: prospectReject,
	});
}
