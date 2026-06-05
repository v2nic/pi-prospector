import type { ExtensionAPI, ExtensionContext, ToolResult } from "../pi-stubs.js";
import { Type, Static } from "typebox";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getStats } from "../db/queries.js";
import { listProposalsV2, acceptProposalV2, rejectProposalV2 } from "../db/queries.js";
import { getDbPath, getSessionsDir } from "../config.js";

const ProspectParams = Type.Object({
	action: Type.Union([
		Type.Literal("sync"),
		Type.Literal("stats"),
		Type.Literal("list_proposals"),
		Type.Literal("accept"),
		Type.Literal("reject"),
	]),
	status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("rejected")])),
	proposal_id: Type.Optional(Type.String()),
});

type ProspectParamsType = Static<typeof ProspectParams>;

export function registerProspectTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "prospect",
		label: "Prospect",
		description: "Index sessions, check stats, list/accept/reject proposals. Actions: sync, stats, list_proposals, accept, reject.",
		parameters: ProspectParams,
		async execute(_toolCallId: string, params: ProspectParamsType, _signal: AbortSignal, _onUpdate: unknown, _ctx: ExtensionContext): Promise<ToolResult> {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				switch (params.action) {
					case "sync": {
						const result = runSync(db, getSessionsDir());
						return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
					}
					case "stats": {
						const stats = getStats(db);
						return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }], details: stats };
					}
					case "list_proposals": {
						const proposals = listProposalsV2(db, params.status);
						if (proposals.length === 0) return { content: [{ type: "text", text: "No proposals found." }], details: [] };
						const text = proposals.map((p) => `[${p.status}] ${p.id.slice(0, 8)} | ${p.severity ?? "—"} | ${p.target_path ?? p.target_type}\n  ${p.title ?? p.summary}`).join("\n\n");
						return { content: [{ type: "text", text }], details: proposals };
					}
					case "accept": {
						if (!params.proposal_id) return { content: [{ type: "text", text: "proposal_id required" }], details: {} };
						const ok = acceptProposalV2(db, params.proposal_id);
						return { content: [{ type: "text", text: ok ? `Accepted ${params.proposal_id}` : "Not found or not open" }], details: { ok } };
					}
					case "reject": {
						if (!params.proposal_id) return { content: [{ type: "text", text: "proposal_id required" }], details: {} };
						const ok = rejectProposalV2(db, params.proposal_id);
						return { content: [{ type: "text", text: ok ? `Rejected ${params.proposal_id}` : "Not found or not open" }], details: { ok } };
					}
				}
			} finally {
				db.close();
			}
			// Should be unreachable but satisfies type checker
			return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
		},
	});
}