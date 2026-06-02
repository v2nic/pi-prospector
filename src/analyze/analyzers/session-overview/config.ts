/**
 * Default config for the session-overview analyzer.
 */

export const DEFAULT_SESSION_OVERVIEW_CONFIG = {
	/** Maximum input tokens for the digest (rough char count / 4). */
	context_budget_chars: 100_000,
	/** If digest exceeds budget, split into segments of this size. */
	segment_chars: 30_000,
	/** Max segments to map in a single run (cost cap). */
	max_segments: 8,
	/** When to use map-reduce vs single-call. */
	use_map_reduce_over_chars: 60_000,
	/** Tool model tier for the map phase. */
	map_tier: "cheap",
	/** Tool model tier for the reduce phase. */
	reduce_tier: "mid",
} as const;

export type SessionOverviewConfig = typeof DEFAULT_SESSION_OVERVIEW_CONFIG;
