import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getUnanalyzedSessions, markAnalyzed } from "../db/queries.js";
import { getDbPath, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { turnPairCoreAnalyzer } from "../analyze/analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "../analyze/analyzers/turn-pair-llm/index.js";
import { sessionOverviewAnalyzer } from "../analyze/analyzers/session-overview/index.js";
import { callOllamaLLM } from "../analyze/ollama-llm.js";

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description: "Run analysis over unanalyzed sessions to generate proposals",
		handler: async (args: string, ctx: { ui: { notify: (msg: string, level?: string) => void } }) => {
			const config = loadConfig();
			const parsedArgs = parseArgs(args ?? "");
			const modelSpec = parsedArgs.model ?? config.model;
			const limit = parsedArgs.limit;

			const db = new Database(getDbPath(config));
			migrate(db);

			try {
				const unanalyzed = getUnanalyzedSessions(db, limit);
				if (unanalyzed.length === 0) {
					const msg = "No unanalyzed sessions. Run /prospect-sync first.";
					ctx.ui.notify(msg, "info");
					console.log(msg);
					return;
				}

				const effectiveLimit = limit ?? unanalyzed.length;
				const sessionsToAnalyze = unanalyzed.slice(0, effectiveLimit);
				const startMsg = `Analyzing ${sessionsToAnalyze.length} session(s)${modelSpec ? ` with ${modelSpec}` : " (deterministic only)"}...`;
				ctx.ui.notify(startMsg, "info");
				console.log(startMsg);

				const llmProvider = modelSpec ? callOllamaLLM : undefined;
				const framework = new AnalyzerFramework(db, llmProvider);
				framework.register(turnPairCoreAnalyzer);

				// Only register LLM analyzers if we have a model
				if (modelSpec) {
					framework.register(turnPairLLMAnalyzer);
					framework.register(sessionOverviewAnalyzer);
				}

				let totalNodes = 0;
				let errors = 0;

				for (const session of sessionsToAnalyze) {
					try {
						const result = await framework.runAll(session.id, undefined, config.modelTiers);
						totalNodes += result.totalNodesProduced;
						if (result.errors.length > 0) {
							for (const e of result.errors) console.error(`  Warning: ${e}`);
						}
						markAnalyzed(db, session.id);
					} catch (err) {
						errors++;
						const errMsg = `Error on session ${session.id}: ${err instanceof Error ? err.message : String(err)}`;
						ctx.ui.notify(errMsg, "warning");
						console.error(errMsg);
					}
				}

				const doneMsg = `Done. ${sessionsToAnalyze.length - errors} analyzed, ${totalNodes} nodes produced, ${errors} errors.`;
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