/**
 * Default registry of all bundled analyzers.
 *
 * Call `registerDefaults(fw)` once at extension load to wire up
 * turn-pair-core, turn-pair-llm, and session-overview. Tests can
 * call this with a stub LLM; production wires it to a real
 * provider via `setDefaultLLMCaller()`.
 */

import { AnalyzerFramework } from "./framework.js";
import { turnPairCoreAnalyzer } from "./analyzers/turn-pair-core/index.js";
import { turnPairLlmAnalyzer } from "./analyzers/turn-pair-llm/index.js";
import { sessionOverviewAnalyzer } from "./analyzers/session-overview/index.js";
import type { LLMCaller } from "./types.js";

let llmOverride: LLMCaller | null = null;

/**
 * Install a global LLM caller that the default analyzers will use.
 * In production this is wired to @earendil-works/pi-ai; in tests
 * it's a stub.
 */
export function setDefaultLLMCaller(caller: LLMCaller): void {
	llmOverride = caller;
}

export function getDefaultLLMCaller(): LLMCaller {
	if (!llmOverride) {
		throw new Error(
			"No default LLM caller installed. Call setDefaultLLMCaller() at extension load, " +
			"or pass an explicit LLM caller when constructing AnalyzerFramework.",
		);
	}
	return llmOverride;
}

export function registerDefaults(fw: AnalyzerFramework): void {
	fw.register(turnPairCoreAnalyzer);
	fw.register(turnPairLlmAnalyzer);
	fw.register(sessionOverviewAnalyzer);
}
