import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getAnalysisStats } from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const s = getStats(db);
				const a = getAnalysisStats(db);
				const lines = [
					"╔══════════════════════════════════════════╗",
					"║          ⛏️  Prospector Stats             ║",
					"╚══════════════════════════════════════════╝",
					"",
					"  ── Sessions ──",
					`  Sessions indexed:    ${s.totalSessions}`,
					`  Messages (user+asst): ${s.totalMessages}`,
					`  Tool results:         ${s.totalToolResults}`,
					`  Sessions analyzed:    ${s.messagesProcessed}`,
					"",
					"  ── Proposals ──",
					`    open:     ${s.proposalsByStatus.open ?? 0}`,
					`    applied:  ${s.proposalsByStatus.applied ?? 0}`,
					`    rejected: ${s.proposalsByStatus.rejected ?? 0}`,
				`    duplicate:   ${s.proposalsByStatus.duplicate ?? 0}`,
					"",
					"  ── Analysis Framework ──",
					`  Analysis nodes:       ${a.totalNodes}`,
					`  Analysis edges:       ${a.totalEdges}`,
					`  Analysis runs:        ${a.totalRuns}`,
				];

				// Node kind breakdown
				if (Object.keys(a.nodesByKind).length > 0) {
					lines.push("");
					lines.push("  ── Nodes by kind ──");
					for (const [kind, count] of Object.entries(a.nodesByKind)) {
						lines.push(`    ${kind}: ${count}`);
					}
				}

				// Run status breakdown
				if (Object.keys(a.runsByStatus).length > 0) {
					lines.push("");
					lines.push("  ── Runs by status ──");
					for (const [status, count] of Object.entries(a.runsByStatus)) {
						lines.push(`    ${status}: ${count}`);
					}
				}

				const text = lines.join("\n");
				ctx.ui.notify(text, "info");
				console.log(text);
			} finally {
				db.close();
			}
		},
	});
}