import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getUnanalyzedSessions, markAnalyzed } from "../db/queries.js";
import { getDbPath, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { turnPairCoreAnalyzer } from "../analyze/analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "../analyze/analyzers/turn-pair-llm/index.js";
import { sessionOverviewAnalyzer } from "../analyze/analyzers/session-overview/index.js";

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description: "Run LLM analysis over unanalyzed sessions to generate proposals",
		handler: async (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const config = loadConfig();
			const parsedArgs = parseArgs(args ?? "");
			const modelSpec = parsedArgs.model ?? config.model;

			if (!modelSpec) {
				const msg = "No model configured. Use --model provider/model or set in ~/.pi/agent/prospector.json";
				ctx.ui.notify(msg, "error");
				console.log(msg);
				return;
			}

			const db = new Database(getDbPath(config));
			migrate(db);

			try {
				const unanalyzed = getUnanalyzedSessions(db, parsedArgs.limit);
				if (unanalyzed.length === 0) {
					const msg = "No unanalyzed sessions. Run /prospect-sync first.";
					ctx.ui.notify(msg, "info");
					console.log(msg);
					return;
				}

				const startMsg = `Analyzing ${unanalyzed.length} session(s) with ${modelSpec}...`;
				ctx.ui.notify(startMsg, "info");
				console.log(startMsg);

				const framework = new AnalyzerFramework(db);
				framework.register(turnPairCoreAnalyzer);
				framework.register(turnPairLLMAnalyzer);
				framework.register(sessionOverviewAnalyzer);

				let totalProposals = 0;
				let errors = 0;

				for (const session of unanalyzed) {
					try {
						const result = await framework.runAll(session.id, undefined, config.modelTiers);
						totalProposals += result.totalNodesProduced;
						if (result.errors.length > 0) {
							for (const e of result.errors) console.error(`  Warning: ${e}`);
						}
						markAnalyzed(db, session.id);
					} catch (err) {
						errors++;
						const errMsg = `Error on session ${session.id}: ${err}`;
						ctx.ui.notify(errMsg, "warning");
						console.error(errMsg);
					}
				}

				const doneMsg = `Done. ${unanalyzed.length - errors} analyzed, ${totalProposals} nodes produced, ${errors} errors.`;
				ctx.ui.notify(doneMsg, "info");
				console.log(doneMsg);
			} finally {
				db.close();
			}
		},
	});
}

function parseArgs(raw: string): { model?: string; limit?: number } {
	const result: { model?: string; limit?: number } = {};
	const parts = raw.split(/\s+/);
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--model" && parts[i + 1]) result.model = parts[++i]!;
		else if (parts[i] === "--limit" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!isNaN(n)) result.limit = n;
		}
	}
	return result;
}