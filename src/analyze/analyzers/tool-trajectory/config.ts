/**
 * Configuration for the tool-trajectory analyzer.
 *
 * Thresholds for loop detection, polling detection, oscillation windows, and
 * pre-flight gap detection. All are part of the config fingerprint so a change
 * produces a new config identity and, when a run includes the `config` reason,
 * new node versions.
 */

import { Type, type Static } from "typebox";

export const ToolTrajectoryConfig = Type.Object({
	/** Minimum repetitions of the same (tool + normalised args) call to flag a stuck-loop. */
	stuckLoopMin: Type.Integer({ minimum: 2 }),
	/** Minimum repetitions of a read-only command to flag a polling-loop. */
	pollingLoopMin: Type.Integer({ minimum: 2 }),
	/** Sliding window size (in tool calls) for oscillation detection. */
	oscillationWindow: Type.Integer({ minimum: 2 }),
	/** Weight contributed by each stuck-loop signal to the session friction score. */
	stuckLoopWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Weight contributed by each polling-loop signal. */
	pollingLoopWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Weight contributed by each oscillation signal. */
	oscillationWeight: Type.Number({ minimum: 0, maximum: 1 }),
	/** Weight contributed by each pre-flight gap signal. */
	preFlightGapWeight: Type.Number({ minimum: 0, maximum: 1 }),
});
export type ToolTrajectoryConfig = Static<typeof ToolTrajectoryConfig>;

export const DEFAULT_TOOL_TRAJECTORY_CONFIG: ToolTrajectoryConfig = {
	stuckLoopMin: 3,
	pollingLoopMin: 3,
	oscillationWindow: 10,
	stuckLoopWeight: 0.3,
	pollingLoopWeight: 0.25,
	oscillationWeight: 0.35,
	preFlightGapWeight: 0.2,
};