/**
 * Model tier resolution for analyzers. Design reference: docs/analyzer-design-c.md §10
 */

import type { ModelTierConfig, ModelTier } from "./types.js";

export const DEFAULT_MODEL_TIERS: ModelTierConfig = {
	cheap: "anthropic/claude-haiku-3",
	mid: "anthropic/claude-sonnet-4-5",
	expensive: "anthropic/claude-opus-4",
};

/** Resolve a model tier name to an actual model specification string. */
export function resolveModelTier(tier: ModelTier, config?: ModelTierConfig): string {
	const tiers = config ?? DEFAULT_MODEL_TIERS;
	switch (tier) {
		case "cheap": return tiers.cheap;
		case "mid": return tiers.mid ?? tiers.cheap;
		case "expensive": return tiers.expensive ?? tiers.mid ?? tiers.cheap;
		default: return tiers.mid ?? tiers.cheap;
	}
}

/** Validate model tier config has required fields. */
export function validateModelTierConfig(config: Partial<ModelTierConfig>): string[] {
	const errors: string[] = [];
	if (!config.cheap && !config.mid && !config.expensive) {
		errors.push("At least one model tier must be configured (cheap, mid, or expensive)");
	}
	return errors;
}