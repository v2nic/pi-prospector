/**
 * Default config for the turn-pair-llm analyzer.
 */

export const DEFAULT_TURN_PAIR_LLM_CONFIG = {
	/** Minimum friction_score (0–1) from the deterministic pass to qualify. */
	friction_threshold: 0.4,
	/** Whether to require correction_detected (in addition to the score). */
	require_correction: false,
	/** Maximum turns per session to enrich (skip beyond to bound cost). */
	max_pairs_per_session: 50,
} as const;

export type TurnPairLlmConfig = typeof DEFAULT_TURN_PAIR_LLM_CONFIG;
