/**
 * Edge kind and ref kind constants for the analysis graph.
 * Design reference: docs/analyzer-design-c.md §2.2
 */

// ─── Edge kinds ───

/** This node is about this conversation entity. Pair-level nodes anchor to their user message. Session-level nodes anchor to the session. */
export const EDGE_KIND_ANCHORS = "anchors" as const;

/** This node used this as input. A session-overview consumes turn-pair nodes. An LLM enrichment consumes its deterministic base node. */
export const EDGE_KIND_CONSUMES = "consumes" as const;

/** This node builds on top of another. An LLM enrichment refines its deterministic base. */
export const EDGE_KIND_REFINES = "refines" as const;

/** This node was produced using this prompt. */
export const EDGE_KIND_USES_PROMPT = "uses_prompt" as const;

/** This node was produced with this config. */
export const EDGE_KIND_USES_CONFIG = "uses_config" as const;

/** This node produced this proposal (materialized into the proposals table). */
export const EDGE_KIND_PRODUCES = "produces" as const;

/** All valid edge kinds. */
export const EDGE_KINDS = [
	EDGE_KIND_ANCHORS,
	EDGE_KIND_CONSUMES,
	EDGE_KIND_REFINES,
	EDGE_KIND_USES_PROMPT,
	EDGE_KIND_USES_CONFIG,
	EDGE_KIND_PRODUCES,
] as const;

export type EdgeKindConstant = typeof EDGE_KINDS[number];

// ─── Ref kinds (what kind of entity an edge target is) ───

export const REF_KIND_MESSAGE = "message" as const;
export const REF_KIND_ANALYSIS_NODE = "analysis_node" as const;
export const REF_KIND_SESSION = "session" as const;
export const REF_KIND_PROMPT_VERSION = "prompt_version" as const;
export const REF_KIND_CONFIG_VERSION = "config_version" as const;

/** All valid ref kinds. */
export const REF_KINDS = [
	REF_KIND_MESSAGE,
	REF_KIND_ANALYSIS_NODE,
	REF_KIND_SESSION,
	REF_KIND_PROMPT_VERSION,
	REF_KIND_CONFIG_VERSION,
] as const;

export type RefKindConstant = typeof REF_KINDS[number];

// ─── Validation ───

export function isValidEdgeKind(kind: string): kind is EdgeKindConstant {
	return EDGE_KINDS.includes(kind as EdgeKindConstant);
}

export function isValidRefKind(kind: string): kind is RefKindConstant {
	return REF_KINDS.includes(kind as RefKindConstant);
}