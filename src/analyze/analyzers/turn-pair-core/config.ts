/**
 * Default config and friction scoring formula for turn-pair-core analyzer.
 */

import type { AnalyzerConfig } from "../../types.js";
import { createHash } from "node:crypto";

export interface TurnPairCoreConfigParams {
	correctionWeight: number;
	toolFailureWeight: number;
	retryWeight: number;
	toolWasteWeight: number;
	frictionThreshold: number;
}

export const DEFAULT_CONFIG_PARAMS: TurnPairCoreConfigParams = {
	correctionWeight: 0.4,
	toolFailureWeight: 0.3,
	retryWeight: 0.2,
	toolWasteWeight: 0.1,
	frictionThreshold: 0.4,
};

export function createDefaultConfig(): AnalyzerConfig {
	const configJson = DEFAULT_CONFIG_PARAMS as unknown as Record<string, unknown>;
	const configHash = createHash("sha256").update(JSON.stringify(configJson)).digest("hex");
	return { id: configHash.slice(0, 24), analyzerId: "turn-pair-core", configJson, configHash, label: "default", createdAt: new Date().toISOString() };
}

export function computeFrictionScore(params: {
	correctionDetected: boolean; correctionType: string | null;
	toolFailureCount: number; toolFailureDetails: Array<{ tool_name: string; error_preview: string }>;
	retryDetected: boolean; toolWasteBytes: number; totalToolBytes: number;
}, config: TurnPairCoreConfigParams = DEFAULT_CONFIG_PARAMS): number {
	let score = 0;
	if (params.correctionDetected) {
		const multiplier = params.correctionType === "explicit" ? 1.0 : params.correctionType === "repetition" ? 0.8 : params.correctionType === "implicit" ? 0.6 : 0.5;
		score += config.correctionWeight * multiplier;
	}
	if (params.toolFailureCount > 0) { score += config.toolFailureWeight * Math.min(params.toolFailureCount / 3, 1.0); }
	if (params.retryDetected) { score += config.retryWeight * 0.7; }
	if (params.totalToolBytes > 0) { score += config.toolWasteWeight * Math.min(params.toolWasteBytes / params.totalToolBytes, 1.0); }
	return Math.min(score, 1.0);
}

export function detectRetry(toolNames: string[]): boolean {
	const counts = new Map<string, number>();
	for (const name of toolNames) { counts.set(name, (counts.get(name) ?? 0) + 1); }
	for (const count of counts.values()) { if (count >= 2) return true; }
	return false;
}

export function estimateWasteBytes(toolResults: Array<{ toolName: string; textLength: number; isError: boolean }>, subsequentAssistantText: string | null): number {
	if (!subsequentAssistantText || toolResults.length === 0) {
		return toolResults.filter(r => !r.isError).reduce((sum, r) => sum + r.textLength, 0);
	}
	let wasteBytes = 0;
	for (const result of toolResults) {
		if (result.isError) continue;
		if (!subsequentAssistantText.toLowerCase().includes(result.toolName.toLowerCase())) { wasteBytes += result.textLength; }
	}
	return wasteBytes;
}