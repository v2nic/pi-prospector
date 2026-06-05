import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getStats } from "../db/queries.js";
import { getAnalysisStats } from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";

export function registerStatsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-stats", {
		description: "Show prospector database statistics",
		handler: async (_args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
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
					"  ── Proposals (v1) ──",
					`    new:      ${s.proposalsByStatus.new}`,
					`    accepted: ${s.proposalsByStatus.accepted}`,
					`    rejected: ${s.proposalsByStatus.rejected}`,
					"",
					"  ── Analysis Framework ──",
					`  Analysis nodes:       ${a.totalNodes}`,
					`  Analysis edges:       ${a.totalEdges}`,
					`  Analysis runs:        ${a.totalRuns}`,
				];
				if (Object.keys(a.nodesByKind).length > 0) {
					lines.push("", "  ── Nodes by kind ──");
					for (const [kind, count] of Object.entries(a.nodesByKind)) lines.push(`    ${kind}: ${count}`);
				}
				if (Object.keys(a.runsByStatus).length > 0) {
					lines.push("", "  ── Runs by status ──");
					for (const [status, count] of Object.entries(a.runsByStatus)) lines.push(`    ${status}: ${count}`);
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