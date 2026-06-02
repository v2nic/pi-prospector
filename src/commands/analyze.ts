import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getUnanalyzedSessions } from "../db/queries.js";
import { getDbPath, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { registerDefaults, getDefaultLLMCaller } from "../analyze/defaults.js";

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description: "Run analyzer framework over unanalyzed sessions (turn-pair-core, turn-pair-llm, session-overview)",
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

			const db = new Database(getDbPath());
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

				const llm = getDefaultLLMCaller();
				const fw = new AnalyzerFramework({ db, llm });
				registerDefaults(fw);

				let totalNodes = 0;
				let totalProposals = 0;
				let errors = 0;
				const analyzersToRun = parsedArgs.analyzer ? [parsedArgs.analyzer] : ["turn-pair-core", "turn-pair-llm", "session-overview"];

				for (const session of unanalyzed) {
					try {
						for (const analyzerId of analyzersToRun) {
							if (!fw.get(analyzerId)) continue;
							const summary = await fw.run(analyzerId, session.id, { model: modelSpec });
							totalNodes += summary.nodesProduced;
							if (summary.status === "error") {
								errors++;
								const errMsg = `Error on session ${session.id} analyzer ${analyzerId}: ${summary.status}`;
								ctx.ui.notify(errMsg, "warning");
								console.error(errMsg);
							}
						}
					} catch (err) {
						errors++;
						const errMsg = `Error on session ${session.id}: ${err}`;
						ctx.ui.notify(errMsg, "warning");
						console.error(errMsg);
					}
				}

				// Count proposals generated
				const propCount = (db.prepare("SELECT COUNT(*) as c FROM proposals WHERE status = 'open'").get() as { c: number }).c;
				totalProposals = propCount;

				const doneMsg = `Done. ${unanalyzed.length - errors} analyzed, ${totalNodes} nodes, ${totalProposals} open proposals, ${errors} errors.`;
				ctx.ui.notify(doneMsg, "info");
				console.log(doneMsg);
			} finally {
				db.close();
			}
		},
	});
}

function parseArgs(raw: string): { model?: string; limit?: number; analyzer?: string } {
	const result: { model?: string; limit?: number; analyzer?: string } = {};
	const parts = raw.split(/\s+/);
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--model" && parts[i + 1]) result.model = parts[++i];
		else if (parts[i] === "--limit" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!isNaN(n)) result.limit = n;
		} else if (parts[i] === "--analyzer" && parts[i + 1]) {
			result.analyzer = parts[++i];
		}
	}
	return result;
}
