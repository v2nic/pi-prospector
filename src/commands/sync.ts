import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import { getDbPath, getSessionsDir, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { turnPairCoreAnalyzer } from "../analyze/analyzers/turn-pair-core/index.js";
import { getUnanalyzedSessions, markAnalyzed } from "../db/queries.js";

export function registerSyncCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-sync", {
		description: "Index session files into the prospector database, then run deterministic analysis",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const dbPath = getDbPath();
			const db = new Database(dbPath);
			migrate(db);

			try {
				const result = runSync(db, getSessionsDir());
				const lines = [
					"⛏️ Prospect sync complete",
					`  Sessions processed: ${result.sessionsProcessed}`,
					`  Sessions skipped:   ${result.sessionsSkipped}`,
					`  Messages inserted:  ${result.messagesInserted}`,
					`  Forks resolved:     ${result.forksResolved}`,
				];
				if (result.errors.length > 0) {
					lines.push(`  Errors: ${result.errors.length}`);
					for (const e of result.errors.slice(0, 5)) lines.push(`    ${e}`);
				}
				const text = lines.join("\n");
				console.log(text);
				ctx.ui.notify(text, "info");

				// After sync, run deterministic analysis on unanalyzed sessions
				if (result.sessionsProcessed > 0 || result.messagesInserted > 0) {
					const config = loadConfig();
					const framework = new AnalyzerFramework(db);
					framework.register(turnPairCoreAnalyzer);

					const unanalyzed = getUnanalyzedSessions(db);
					let analyzed = 0;
					let syncedErrors = 0;

					for (const session of unanalyzed) {
						try {
							const runResult = await framework.runAnalyzer("turn-pair-core", session.id, undefined, config.modelTiers);
							analyzed += runResult.nodesProduced;
							markAnalyzed(db, session.id);
						} catch (err) {
							syncedErrors++;
							console.error(`  Warning: turn-pair-core failed on ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
						}
					}

					if (analyzed > 0 || syncedErrors > 0) {
						const analyzeMsg = `  Deterministic analysis: ${analyzed} nodes produced, ${syncedErrors} errors`;
						console.log(analyzeMsg);
						ctx.ui.notify(analyzeMsg, "info");
					}
				}
			} finally {
				db.close();
			}
		},
	});
}