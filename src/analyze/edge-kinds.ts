/**
 * Edge kind constants for the analysis graph.
 */

export const EDGE_KINDS = {
	anchors: "anchors",
	consumes: "consumes",
	refines: "refines",
	uses_prompt: "uses_prompt",
	uses_config: "uses_config",
	produces: "produces",
} as const;

export type EdgeKind = typeof EDGE_KINDS[keyof typeof EDGE_KINDS];

export const REF_KINDS = {
	message: "message",
	analysis_node: "analysis_node",
	session: "session",
	prompt_version: "prompt_version",
	config_version: "config_version",
} as const;

export type RefKind = typeof REF_KINDS[keyof typeof REF_KINDS];
