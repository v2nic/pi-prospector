/**
 * Configuration for turn-pair-llm analyzer.
 */
import type { AnalyzerConfig } from "../../types.js";
import { createHash } from "node:crypto";

export interface TurnPairLLMConfigParams {
	frictionThreshold: number;
	includeCorrections: boolean;
	modelTier: "cheap" | "mid" | "expensive";
}

export const DEFAULT_LLM_CONFIG_PARAMS: TurnPairLLMConfigParams = {
	frictionThreshold: 0.4,
	includeCorrections: true,
	modelTier: "cheap",
};

export function createDefaultConfig(): AnalyzerConfig {
	const configJson = DEFAULT_LLM_CONFIG_PARAMS as unknown as Record<string, unknown>;
	const configHash = createHash("sha256").update(JSON.stringify(configJson)).digest("hex");
	return { id: configHash.slice(0, 24), analyzerId: "turn-pair-llm", configJson, configHash, label: "default", createdAt: new Date().toISOString() };
}