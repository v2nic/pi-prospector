/**
 * Configuration for session-overview analyzer.
 */
import type { AnalyzerConfig } from "../../types.js";
import { createHash } from "node:crypto";

export interface SessionOverviewConfigParams {
	mapModelTier: "cheap" | "mid" | "expensive";
	reduceModelTier: "cheap" | "mid" | "expensive";
	maxSegmentChars: number;
	minFrictionForDigest: number;
	contextBudgetChars: number;
}

export const DEFAULT_OVERVIEW_CONFIG_PARAMS: SessionOverviewConfigParams = {
	mapModelTier: "cheap",
	reduceModelTier: "mid",
	maxSegmentChars: 8000,
	minFrictionForDigest: 0.3,
	contextBudgetChars: 12000,
};

export function createDefaultConfig(): AnalyzerConfig {
	const configJson = DEFAULT_OVERVIEW_CONFIG_PARAMS as unknown as Record<string, unknown>;
	const configHash = createHash("sha256").update(JSON.stringify(configJson)).digest("hex");
	return { id: configHash.slice(0, 24), analyzerId: "session-overview", configJson, configHash, label: "default", createdAt: new Date().toISOString() };
}