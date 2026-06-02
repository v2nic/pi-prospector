/**
 * Model tier resolution.
 *
 * Analyzers don't ask for a specific model — they ask for a tier
 * (cheap, mid, expensive). The framework resolves the tier to a
 * concrete model string from the user's prospector.json config.
 *
 * Example config:
 *   {
 *     "model": "openrouter/deepseek-v4-flash",
 *     "models": {
 *       "cheap": "openrouter/deepseek-v4-flash",
 *       "mid": "openrouter/deepseek-v4-pro",
 *       "expensive": "anthropic/claude-opus-4"
 *     }
 *   }
 *
 * If a tier is missing, we fall back to the default model.
 */

import type { ModelTier, ModelTierConfig } from "./types.js";

export interface ProspectorModelConfig {
	model?: string;
	models?: Partial<ModelTierConfig>;
}

export function resolveModelTier(
	tier: ModelTier,
	config: ProspectorModelConfig,
): string {
	const explicit = config.models?.[tier];
	if (explicit) return explicit;
	if (config.model) return config.model;
	throw new Error(
		`No model configured for tier=${tier}. Set 'model' or 'models.${tier}' in prospector.json.`,
	);
}
