/**
 * Edge kinds in the analysis graph.
 *
 * Every relationship between analysis nodes and other entities
 * (messages, sessions, prompts, configs, other nodes) is expressed
 * through a single typed edge table. There are no parent_id columns
 * on nodes.
 *
 * The constants below are the only canonical strings the framework
 * will accept or produce. Any other edge_kind value is rejected.
 */

export const EDGE_KINDS = {
	ANCHORS: "anchors",
	CONSUMES: "consumes",
	REFINES: "refines",
	USES_PROMPT: "uses_prompt",
	USES_CONFIG: "uses_config",
	PRODUCES: "produces",
} as const;

export type EdgeKind = (typeof EDGE_KINDS)[keyof typeof EDGE_KINDS];

export const EDGE_KIND_LIST: readonly EdgeKind[] = [
	EDGE_KINDS.ANCHORS,
	EDGE_KINDS.CONSUMES,
	EDGE_KINDS.REFINES,
	EDGE_KINDS.USES_PROMPT,
	EDGE_KINDS.USES_CONFIG,
	EDGE_KINDS.PRODUCES,
];

export function isEdgeKind(value: unknown): value is EdgeKind {
	if (typeof value !== "string") return false;
	return (EDGE_KIND_LIST as readonly string[]).includes(value);
}

/**
 * The set of to_ref_kind values the framework accepts.
 * Mirrors the schema check constraint on analysis_edges.
 */
export const REF_KINDS = {
	MESSAGE: "message",
	SESSION: "session",
	ANALYSIS_NODE: "analysis_node",
	PROMPT_VERSION: "prompt_version",
	CONFIG_VERSION: "config_version",
} as const;

export type RefKind = (typeof REF_KINDS)[keyof typeof REF_KINDS];

export const REF_KIND_LIST: readonly RefKind[] = [
	REF_KINDS.MESSAGE,
	REF_KINDS.SESSION,
	REF_KINDS.ANALYSIS_NODE,
	REF_KINDS.PROMPT_VERSION,
	REF_KINDS.CONFIG_VERSION,
];

export function isRefKind(value: unknown): value is RefKind {
	if (typeof value !== "string") return false;
	return (REF_KIND_LIST as readonly string[]).includes(value);
}

/**
 * Validate the compatibility of an edge_kind with a to_ref_kind.
 *
 * - anchors:    must point to a message or session
 * - consumes:   must point to a message or analysis_node
 * - refines:    must point to an analysis_node
 * - uses_prompt: must point to a prompt_version
 * - uses_config: must point to a config_version
 * - produces:   must point to an analysis_node (the produced node)
 */
export function validateEdge(edgeKind: EdgeKind, toRefKind: RefKind): void {
	switch (edgeKind) {
		case EDGE_KINDS.ANCHORS:
			if (toRefKind !== REF_KINDS.MESSAGE && toRefKind !== REF_KINDS.SESSION) {
				throw new Error(`edge_kind=anchors requires to_ref_kind in {message, session}, got ${toRefKind}`);
			}
			return;
		case EDGE_KINDS.CONSUMES:
			if (toRefKind !== REF_KINDS.MESSAGE && toRefKind !== REF_KINDS.ANALYSIS_NODE) {
				throw new Error(`edge_kind=consumes requires to_ref_kind in {message, analysis_node}, got ${toRefKind}`);
			}
			return;
		case EDGE_KINDS.REFINES:
			if (toRefKind !== REF_KINDS.ANALYSIS_NODE) {
				throw new Error(`edge_kind=refines requires to_ref_kind=analysis_node, got ${toRefKind}`);
			}
			return;
		case EDGE_KINDS.USES_PROMPT:
			if (toRefKind !== REF_KINDS.PROMPT_VERSION) {
				throw new Error(`edge_kind=uses_prompt requires to_ref_kind=prompt_version, got ${toRefKind}`);
			}
			return;
		case EDGE_KINDS.USES_CONFIG:
			if (toRefKind !== REF_KINDS.CONFIG_VERSION) {
				throw new Error(`edge_kind=uses_config requires to_ref_kind=config_version, got ${toRefKind}`);
			}
			return;
		case EDGE_KINDS.PRODUCES:
			if (toRefKind !== REF_KINDS.ANALYSIS_NODE) {
				throw new Error(`edge_kind=produces requires to_ref_kind=analysis_node, got ${toRefKind}`);
			}
			return;
		default: {
			const _exhaustive: never = edgeKind;
			throw new Error(`unknown edge_kind: ${String(_exhaustive)}`);
		}
	}
}
