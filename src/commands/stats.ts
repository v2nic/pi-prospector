import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getDbPath } from "../config.js";

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics",
		handler: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const s = getStats(db);

				// Analysis framework stats
				const analyzerDefs = (db.prepare("SELECT COUNT(*) as c FROM analyzer_defs").get() as { c: number }).c;
				const analysisNodes = (db.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE node_kind != 'error'").get() as { c: number }).c;
				const errorNodes = (db.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE node_kind = 'error'").get() as { c: number }).c;
				const proposalNodes = (db.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE node_kind = 'proposal'").get() as { c: number }).c;
				const runs = (db.prepare("SELECT COUNT(*) as c FROM analysis_runs WHERE status = 'ok'").get() as { c: number }).c;
				const nodesByAnalyzer = db.prepare(`
					SELECT analyzer_id, COUNT(*) as c FROM analysis_nodes
					WHERE node_kind != 'error'
					GROUP BY analyzer_id
				`).all() as Array<{ analyzer_id: string; c: number }>;

				const openProposals = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status IN ('new', 'open')").get() as { c: number }).c;

				const lines = [
					"╔══════════════════════════════════════════╗",
					"║          ⛏️  Prospector Stats             ║",
					"╚══════════════════════════════════════════╝",
					"",
					`  Sessions indexed:    ${s.totalSessions}`,
					`  Messages (user+asst):${s.totalMessages}`,
					`  Tool results:        ${s.totalToolResults}`,
					`  Sessions analyzed:   ${s.messagesProcessed}`,
					"",
					"  Analysis:",
					`    Analyzers registered: ${analyzerDefs}`,
					`    Analysis nodes:        ${analysisNodes}`,
					`    Error nodes:           ${errorNodes}`,
					`    Proposal nodes:        ${proposalNodes}`,
					`    Successful runs:       ${runs}`,
				];
				if (nodesByAnalyzer.length > 0) {
					lines.push("    Per-analyzer:");
					for (const r of nodesByAnalyzer) {
						lines.push(`      ${r.analyzer_id}: ${r.c}`);
					}
				}
				lines.push(
					"",
					"  Proposals:",
					`    new/open: ${s.proposalsByStatus.new + openProposals}`,
					`    accepted: ${s.proposalsByStatus.accepted}`,
					`    rejected: ${s.proposalsByStatus.rejected}`,
				);
				const text = lines.join("\n");
				ctx.ui.notify(text, "info");
				console.log(text);
			} finally {
				db.close();
			}
		},
	});
}
