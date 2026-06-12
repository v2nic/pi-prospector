/**
 * Bundled analyzer registry. `registerDefaults(framework)` wires up the three
 * built-in analyzers in dependency order.
 */

import type { AnalyzerFramework } from "./framework.js";
import { turnPairCoreAnalyzer } from "./analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "./analyzers/turn-pair-llm/index.js";
import { sessionOverviewAnalyzer } from "./analyzers/session-overview/index.js";
import { toolTrajectoryAnalyzer } from "./analyzers/tool-trajectory/index.js";

export const DEFAULT_ANALYZER_IDS = ["turn-pair-core", "turn-pair-llm", "tool-trajectory", "session-overview"] as const;

export function registerDefaults(framework: AnalyzerFramework): void {
	framework.register(turnPairCoreAnalyzer);
	framework.register(turnPairLLMAnalyzer);
	framework.register(toolTrajectoryAnalyzer);
	framework.register(sessionOverviewAnalyzer);
}
