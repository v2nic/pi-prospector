import type { ExtensionAPI } from "./pi-stubs.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerProposalsCommand } from "./commands/proposals.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerProspectTool } from "./commands/tool.js";

export default function (pi: ExtensionAPI) {
	registerSyncCommand(pi);
	registerStatsCommand(pi);
	registerProposalsCommand(pi);
	registerAnalyzeCommand(pi);
	registerProspectTool(pi);
}

// Re-export framework components for programmatic use
export { AnalyzerFramework } from "./analyze/framework.js";
export { turnPairCoreAnalyzer } from "./analyze/analyzers/turn-pair-core/index.js";
export { turnPairLLMAnalyzer } from "./analyze/analyzers/turn-pair-llm/index.js";
export { sessionOverviewAnalyzer } from "./analyze/analyzers/session-overview/index.js";