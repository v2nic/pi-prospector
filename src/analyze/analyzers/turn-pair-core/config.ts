/**
 * Default config for turn-pair-core analyzer.
 *
 * The friction_score formula and signal weights are tunable here.
 */

export const DEFAULT_TURN_PAIR_CORE_CONFIG = {
	/** Threshold above which friction is considered "high". */
	friction_threshold: 0.4,
	/** Per-signal weights for the friction score. */
	weights: {
		correction: 0.45,
		tool_failure: 0.25,
		retry: 0.2,
		thinking_present: 0.05,
		compaction_boundary: 0.05,
	},
	/** Cap on tool failures counted per pair. */
	max_tool_failures: 3,
} as const;

export type TurnPairCoreConfig = typeof DEFAULT_TURN_PAIR_CORE_CONFIG;

/**
 * Compute a 0.0–1.0 friction score for a turn pair.
 *
 * The score is a weighted sum of the binary / count signals clipped
 * to [0, 1]. Each weight is in [0, 1] and they should sum to ~1.0
 * by default; if a caller supplies different weights, the score
 * simply scales to whatever they sum to.
 *
 * Tool failures contribute fully once they reach `max_tool_failures`
 * (a step function, not a linear ramp). This makes the signal robust
 * to long failure cascades.
 */
export function computeFrictionScore(
	config: TurnPairCoreConfig,
	signals: {
		correctionDetected: boolean;
		toolFailureCount: number;
		retryDetected: boolean;
		hasThinking: boolean;
		isCompactionBoundary: boolean;
	},
): number {
	const w = config.weights;
	const failures = signals.toolFailureCount >= config.max_tool_failures ? 1 : 0;
	const score =
		(signals.correctionDetected ? w.correction : 0) +
		failures * w.tool_failure +
		(signals.retryDetected ? w.retry : 0) +
		(signals.hasThinking ? w.thinking_present : 0) +
		(signals.isCompactionBoundary ? w.compaction_boundary : 0);
	return Math.max(0, Math.min(1, score));
}
