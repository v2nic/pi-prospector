import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { Type } from "typebox";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getStats, listProposalsEnriched, acceptProposal, rejectProposal } from "../db/queries.js";
import { getDbPath, getSessionsDir } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { registerDefaults, getDefaultLLMCaller } from "../analyze/defaults.js";

export function registerProspectTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "prospect",
		label: "Prospect",
		description: "Index sessions, check stats, list/accept/reject proposals, run analyzers. Actions: sync, stats, list_proposals, accept, reject, analyze.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("sync"),
				Type.Literal("stats"),
				Type.Literal("list_proposals"),
				Type.Literal("accept"),
				Type.Literal("reject"),
				Type.Literal("analyze"),
			]),
			status: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("open")])),
			proposal_id: Type.Optional(Type.String()),
			analyzer_id: Type.Optional(Type.String()),
			session_id: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer()),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>, _signal: unknown, _onUpdate: unknown, _ctx: unknown) {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				switch (params.action) {
					case "sync": {
						const result = runSync(db, getSessionsDir());
						return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
					}
					case "stats": {
						const stats = getStats(db);
						return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }], details: stats };
					}
					case "list_proposals": {
						const proposals = listProposalsEnriched(db, params.status as string | undefined);
						if (proposals.length === 0) return { content: [{ type: "text" as const, text: "No proposals found." }], details: [] };
						const text = proposals.map((p) => {
							const target = p.target_type
								? `${p.target_type}${p.target_path ? `:${p.target_path}` : ""}`
								: "(unknown)";
							const title = p.title ? ` — ${p.title}` : "";
							return `[${p.status}] ${p.id.slice(0, 8)} | ${p.severity} | ${target}${title}\n  ${p.summary}`;
						}).join("\n\n");
						return { content: [{ type: "text" as const, text }], details: proposals };
					}
					case "accept": {
						if (!params.proposal_id) return { content: [{ type: "text" as const, text: "proposal_id required" }], details: {} };
						const ok = acceptProposal(db, params.proposal_id as string);
						return { content: [{ type: "text" as const, text: ok ? `Accepted ${params.proposal_id}` : "Not found or not new" }], details: { ok } };
					}
					case "reject": {
						if (!params.proposal_id) return { content: [{ type: "text" as const, text: "proposal_id required" }], details: {} };
						const ok = rejectProposal(db, params.proposal_id as string);
						return { content: [{ type: "text" as const, text: ok ? `Rejected ${params.proposal_id}` : "Not found or not new" }], details: { ok } };
					}
					case "analyze": {
						const llm = getDefaultLLMCaller();
						const fw = new AnalyzerFramework({ db, llm });
						registerDefaults(fw);
						const analyzerId = (params.analyzer_id as string) ?? "turn-pair-core";
						const sessionId = params.session_id as string | undefined;
						if (sessionId) {
							const r = await fw.run(analyzerId, sessionId);
							return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }], details: r };
						}
						// Run over all unanalyzed
						const sessions = (db.prepare("SELECT id FROM sessions WHERE analyzed_at IS NULL ORDER BY started_at ASC LIMIT ?").all((params.limit as number) ?? 100) as Array<{ id: string }>).map((r) => r.id);
						const results: unknown[] = [];
						for (const sid of sessions) {
							const r = await fw.run(analyzerId, sid);
							results.push(r);
						}
						return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }], details: results };
					}
				}
			} finally {
				db.close();
			}
		},
	});
}
