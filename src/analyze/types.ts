/**
 * Type definitions for the analyzer framework.
 * All data shapes use TypeBox schemas, with TypeScript types derived via Static<typeof Schema>.
 * Design reference: docs/analyzer-design-c.md
 */

import { Type, Static } from "typebox";

// ─── Core identifiers ───

export const RefKindEnum = Type.Union([
	Type.Literal("message"),
	Type.Literal("analysis_node"),
	Type.Literal("session"),
	Type.Literal("prompt_version"),
	Type.Literal("config_version"),
]);
export type RefKind = Static<typeof RefKindEnum>;

export const EdgeKindEnum = Type.Union([
	Type.Literal("anchors"),
	Type.Literal("consumes"),
	Type.Literal("refines"),
	Type.Literal("uses_prompt"),
	Type.Literal("uses_config"),
	Type.Literal("produces"),
]);
export type EdgeKind = Static<typeof EdgeKindEnum>;

export const NodeKindEnum = Type.Union([
	Type.Literal("metric"),
	Type.Literal("classification"),
	Type.Literal("summary"),
	Type.Literal("proposal"),
	Type.Literal("error"),
]);
export type NodeKind = Static<typeof NodeKindEnum>;

export const AnchorSpanEnum = Type.Union([Type.Literal("pair"), Type.Literal("segment"), Type.Literal("full_session")]);
export type AnchorSpan = Static<typeof AnchorSpanEnum>;

export const ImplementationKindEnum = Type.Union([Type.Literal("deterministic"), Type.Literal("in_process_llm"), Type.Literal("pi_subagent")]);
export type ImplementationKind = Static<typeof ImplementationKindEnum>;

export const AnchorKindEnum = Type.Union([Type.Literal("message"), Type.Literal("pair"), Type.Literal("segment"), Type.Literal("session"), Type.Literal("analysis_node"), Type.Literal("none")]);
export type AnchorKind = Static<typeof AnchorKindEnum>;

export const ProposalSeverityEnum = Type.Union([Type.Literal("friction"), Type.Literal("correction"), Type.Literal("waste"), Type.Literal("suggestion"), Type.Literal("insight")]);
export type ProposalSeverityV2 = Static<typeof ProposalSeverityEnum>;

export const TargetTypeEnum = Type.Union([Type.Literal("agents_md"), Type.Literal("system_md"), Type.Literal("skill"), Type.Literal("extension_prompt"), Type.Literal("tool_output"), Type.Literal("repo_doc"), Type.Literal("config")]);
export type TargetType = Static<typeof TargetTypeEnum>;

// ─── Analyzer definition schemas ───

export const AnalyzerDefSchema = Type.Object({
	id: Type.String(), label: Type.String(), description: Type.Optional(Type.String()),
	anchorSpan: AnchorSpanEnum, dependencies: Type.Array(Type.String(), { default: [] }), createdAt: Type.String(),
});
export type AnalyzerDef = Static<typeof AnalyzerDefSchema>;

export const AnalyzerVersionSchema = Type.Object({
	analyzerId: Type.String(), versionId: Type.String(), implementationKind: ImplementationKindEnum,
	codeRef: Type.Optional(Type.String()), createdAt: Type.String(),
});
export type AnalyzerVersion = Static<typeof AnalyzerVersionSchema>;

export const PromptVersionSchema = Type.Object({
	hash: Type.String(), content: Type.String(), fullHash: Type.String(),
	role: Type.Optional(Type.Union([Type.Literal("classify"), Type.Literal("map"), Type.Literal("reduce"), Type.Literal("verify")])),
	createdAt: Type.String(),
});
export type PromptVersion = Static<typeof PromptVersionSchema>;

export const AnalyzerConfigSchema = Type.Object({
	id: Type.String(), analyzerId: Type.String(), configJson: Type.Record(Type.String(), Type.Unknown()),
	configHash: Type.String(), label: Type.Optional(Type.String()), createdAt: Type.String(),
});
export type AnalyzerConfig = Static<typeof AnalyzerConfigSchema>;

// ─── Analysis unit and result schemas ───

export const SourceRefSchema = Type.Object({ kind: Type.Union([Type.Literal("message"), Type.Literal("analysis_node"), Type.Literal("session")]), id: Type.String() });
export type SourceRef = Static<typeof SourceRefSchema>;

export const AnalysisUnitSchema = Type.Object({
	sources: Type.Array(SourceRefSchema), sourceSetHash: Type.String(),
	anchorKind: AnchorKindEnum, anchorRef: Type.Optional(Type.String()), meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AnalysisUnit = Static<typeof AnalysisUnitSchema>;

export const AnalysisEdgeSchema = Type.Object({
	toRefKind: Type.Union([SourceRefSchema.properties.kind, Type.Literal("prompt_version"), Type.Literal("config_version")]),
	toRefId: Type.String(), edgeKind: EdgeKindEnum, ordinal: Type.Optional(Type.Number()),
});
export type AnalysisEdge = Static<typeof AnalysisEdgeSchema>;

export const AnalysisResultSchema = Type.Object({
	contentJson: Type.Record(Type.String(), Type.Unknown()), nodeKind: NodeKindEnum,
	anchorKind: AnchorKindEnum, anchorRef: Type.Optional(Type.String()), edges: Type.Array(AnalysisEdgeSchema),
	modelUsed: Type.Optional(Type.String()), costUsd: Type.Optional(Type.Number()),
	tokensUsed: Type.Optional(Type.Number()), durationMs: Type.Optional(Type.Number()),
});
export type AnalysisResult = Static<typeof AnalysisResultSchema>;

// ─── Database row schemas ───

export const AnalysisNodeInsertSchema = Type.Object({
	id: Type.String(), sessionId: Type.String(), analyzerId: Type.String(), analyzerVersionId: Type.String(),
	configId: Type.String(), runId: Type.String(), nodeKind: NodeKindEnum, contentJson: Type.String(),
	sourceSetHash: Type.String(), inputHash: Type.String(), createdAt: Type.String(),
	modelUsed: Type.Optional(Type.String()), costUsd: Type.Optional(Type.Number({ default: 0 })),
	tokensUsed: Type.Optional(Type.Number({ default: 0 })), durationMs: Type.Optional(Type.Number()),
});
export type AnalysisNodeInsert = Static<typeof AnalysisNodeInsertSchema>;

export const AnalysisEdgeInsertSchema = Type.Object({
	fromNodeId: Type.String(), toRefKind: Type.String(), toRefId: Type.String(),
	edgeKind: Type.String(), ordinal: Type.Optional(Type.Number({ default: 0 })),
});
export type AnalysisEdgeInsert = Static<typeof AnalysisEdgeInsertSchema>;

export const AnalysisRunInsertSchema = Type.Object({
	id: Type.String(), analyzerId: Type.String(), analyzerVersionId: Type.String(),
	configId: Type.String(), sessionId: Type.String(), status: Type.Union([Type.Literal("planned"), Type.Literal("running"), Type.Literal("ok"), Type.Literal("error"), Type.Literal("partial")]),
	promptBundleHash: Type.String(), startedAt: Type.String(), finishedAt: Type.Optional(Type.String()),
	modelSpec: Type.Optional(Type.String()), costUsd: Type.Optional(Type.Number({ default: 0 })),
	tokensUsed: Type.Optional(Type.Number({ default: 0 })), nodesProduced: Type.Optional(Type.Number({ default: 0 })),
	nodesSkipped: Type.Optional(Type.Number({ default: 0 })), errorMessage: Type.Optional(Type.String()),
});
export type AnalysisRunInsert = Static<typeof AnalysisRunInsertSchema>;

export const AnalysisProgressInsertSchema = Type.Object({
	analyzerId: Type.String(), analyzerVersionId: Type.String(), configId: Type.String(), sessionId: Type.String(),
	cursorJson: Type.Optional(Type.String()), lastRunId: Type.Optional(Type.String()),
	totalAnalyzed: Type.Optional(Type.Number({ default: 0 })),
	status: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("in_progress"), Type.Literal("error"), Type.Literal("needs_rerun")])),
	errorMessage: Type.Optional(Type.String()), updatedAt: Type.String(),
});
export type AnalysisProgressInsert = Static<typeof AnalysisProgressInsertSchema>;

export const AnalysisNodeRowSchema = Type.Object({
	id: Type.String(), session_id: Type.String(), analyzer_id: Type.String(), analyzer_version_id: Type.String(),
	config_id: Type.String(), run_id: Type.String(), node_kind: Type.String(), content_json: Type.String(),
	source_set_hash: Type.String(), input_hash: Type.String(), created_at: Type.String(),
	model_used: Type.String(), cost_usd: Type.Number(), tokens_used: Type.Number(), duration_ms: Type.Number(),
});
export type AnalysisNodeRow = Static<typeof AnalysisNodeRowSchema>;

export const AnalysisRunRowSchema = Type.Object({
	id: Type.String(), analyzer_id: Type.String(), analyzer_version_id: Type.String(),
	config_id: Type.String(), session_id: Type.String(), status: Type.String(),
	prompt_bundle_hash: Type.String(), started_at: Type.String(), finished_at: Type.String(),
	model_spec: Type.String(), cost_usd: Type.Number(), tokens_used: Type.Number(),
	nodes_produced: Type.Number(), nodes_skipped: Type.Number(), error_message: Type.String(),
});
export type AnalysisRunRow = Static<typeof AnalysisRunRowSchema>;

export const AnalysisProgressRowSchema = Type.Object({
	analyzer_id: Type.String(), analyzer_version_id: Type.String(), config_id: Type.String(), session_id: Type.String(),
	cursor_json: Type.String(), last_run_id: Type.String(), total_analyzed: Type.Number(),
	status: Type.String(), error_message: Type.String(), updated_at: Type.String(),
});
export type AnalysisProgressRow = Static<typeof AnalysisProgressRowSchema>;

export const MessageRowSchema = Type.Object({
	id: Type.String(), session_id: Type.String(), parent_id: Type.Union([Type.String(), Type.Null()]),
	timestamp: Type.Union([Type.String(), Type.Null()]), role: Type.String(),
	content_text: Type.Union([Type.String(), Type.Null()]), content_thinking: Type.Union([Type.String(), Type.Null()]),
	tool_calls: Type.Union([Type.String(), Type.Null()]), tool_results: Type.Union([Type.String(), Type.Null()]),
});
export type MessageRow = Static<typeof MessageRowSchema>;

// ─── LLM interface ───

export const LLMRequestSchema = Type.Object({
	model: Type.String(), systemPrompt: Type.String(), userPrompt: Type.String(),
	tools: Type.Optional(Type.Array(Type.Unknown())),
	maxTokens: Type.Optional(Type.Number()), temperature: Type.Optional(Type.Number()),
});
export type LLMRequest = Static<typeof LLMRequestSchema>;

export const LLMResponseSchema = Type.Object({
	content: Type.String(), toolCalls: Type.Optional(Type.Array(Type.Unknown())),
	usage: Type.Optional(Type.Object({ inputTokens: Type.Number(), outputTokens: Type.Number(), costUsd: Type.Optional(Type.Number()) })),
	model: Type.Optional(Type.String()),
});
export type LLMResponse = Static<typeof LLMResponseSchema>;

// ─── Analyzer interface ───

export interface Analyzer {
	def: AnalyzerDef; version: AnalyzerVersion;
	prompts: Record<string, PromptVersion>; defaultConfig: AnalyzerConfig;
	plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]>;
	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult>;
}

export interface AnalyzerPlanContext {
	sessionId: string; messages: MessageRow[]; allNodes: AnalysisNodeRow[];
	ownNodes: AnalysisNodeRow[]; dependencyNodes: Record<string, AnalysisNodeRow[]>;
	progress: AnalysisProgressRow | null | undefined; db: import("better-sqlite3").Database;
}

export interface AnalyzerRunContext {
	getMessage(id: string): MessageRow | undefined;
	getNode(id: string): AnalysisNodeRow | undefined;
	getDependencyNodes(analyzerId: string): AnalysisNodeRow[];
	llm(request: LLMRequest): Promise<LLMResponse>;
	run: AnalysisRunRow; config: AnalyzerConfig; prompts: Record<string, string>;
}

// ─── Framework result ───

export interface FrameworkRunResult {
	runId: string; nodesProduced: number; nodesSkipped: number;
	costUsd: number; tokensUsed: number; durationMs: number;
}

export interface FrameworkRunAllResult {
	results: FrameworkRunResult[]; totalNodesProduced: number; totalNodesSkipped: number;
	totalCostUsd: number; totalTokensUsed: number; errors: string[];
}

// ─── Model tier config ───

export const ModelTierConfigSchema = Type.Object({
	cheap: Type.String(), mid: Type.String(), expensive: Type.String(),
});
export type ModelTierConfig = Static<typeof ModelTierConfigSchema>;
export type ModelTier = "cheap" | "mid" | "expensive";

// ─── Turn-pair-core specific types ───

export const TurnPairCorePropertiesSchema = Type.Object({
	user_msg_length: Type.Number(), assistant_msg_length: Type.Number(), has_thinking: Type.Boolean(),
	thinking_length: Type.Number(), correction_detected: Type.Boolean(), correction_patterns: Type.Array(Type.String()),
	correction_type: Type.Union([Type.Literal("explicit"), Type.Literal("implicit"), Type.Literal("repetition"), Type.Null()]),
	correction_text: Type.Union([Type.String(), Type.Null()]), tool_call_count: Type.Number(), tool_names: Type.Array(Type.String()),
	tool_failure_count: Type.Number(), tool_failure_details: Type.Array(Type.Object({ tool_name: Type.String(), error_preview: Type.String() })),
	tool_waste_bytes: Type.Number(), retry_detected: Type.Boolean(),
	elapsed_seconds: Type.Union([Type.Number(), Type.Null()]), friction_score: Type.Number(),
	model: Type.Union([Type.String(), Type.Null()]), stop_reason: Type.Union([Type.String(), Type.Null()]),
	usage_input_tokens: Type.Union([Type.Number(), Type.Null()]), usage_output_tokens: Type.Union([Type.Number(), Type.Null()]),
	is_compaction_boundary: Type.Boolean(),
});
export type TurnPairCoreProperties = Static<typeof TurnPairCorePropertiesSchema>;

// ─── Turn-pair-llm specific types ───

export const TurnPairLLMPropertiesSchema = Type.Object({
	sentiment: Type.Union([Type.Literal("positive"), Type.Literal("neutral"), Type.Literal("negative"), Type.Literal("frustrated")]),
	frustration_level: Type.Number(), correction_type_llm: Type.Union([Type.Literal("explicit"), Type.Literal("implicit"), Type.Literal("repetition"), Type.Null()]),
	friction_cause: Type.Union([Type.String(), Type.Null()]), friction_summary: Type.Union([Type.String(), Type.Null()]),
	user_intent: Type.String(), quality_score: Type.Number(),
});
export type TurnPairLLMProperties = Static<typeof TurnPairLLMPropertiesSchema>;

// ─── Session-overview specific types ───

export const KeyFrictionPointSchema = Type.Object({
	description: Type.String(), pair_node_id: Type.String(), severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});
export type KeyFrictionPoint = Static<typeof KeyFrictionPointSchema>;

export const ImprovementProposalSchema = Type.Object({
	target_type: TargetTypeEnum, target_path: Type.Optional(Type.String()), title: Type.String(),
	summary: Type.String(), detail: Type.String(), evidence: Type.String(),
	confidence: Type.Number(), severity: Type.Union([Type.Literal("friction"), Type.Literal("correction"), Type.Literal("waste"), Type.Literal("suggestion"), Type.Literal("insight")]),
});
export type ImprovementProposal = Static<typeof ImprovementProposalSchema>;

export const SessionOverviewPropertiesSchema = Type.Object({
	total_pairs: Type.Number(), friction_pairs: Type.Number(), correction_count: Type.Number(),
	avg_quality_score: Type.Union([Type.Number(), Type.Null()]), dominant_friction_type: Type.Union([Type.String(), Type.Null()]),
	tool_failure_rate: Type.Number(), total_tool_waste_bytes: Type.Number(),
	session_duration_seconds: Type.Union([Type.Number(), Type.Null()]), session_summary: Type.String(),
	key_friction_points: Type.Array(KeyFrictionPointSchema),
	improvement_proposals: Type.Array(ImprovementProposalSchema),
	sentiment_arc: Type.Array(Type.Object({ segment: Type.Number(), sentiment: Type.String(), key_event: Type.String() })),
});
export type SessionOverviewProperties = Static<typeof SessionOverviewPropertiesSchema>;

// ─── Config ───

export const ProspectorConfigV2Schema = Type.Object({
	model: Type.Optional(Type.String()), dbPath: Type.Optional(Type.String()),
	modelTiers: Type.Optional(ModelTierConfigSchema),
});
export type ProspectorConfigV2 = Static<typeof ProspectorConfigV2Schema>;

// ─── Updated proposal types (v2) ───

export const ProposalV2Schema = Type.Object({
	id: Type.String(), analysis_node_id: Type.String(), session_id: Type.String(), analyzer_id: Type.String(),
	target_type: TargetTypeEnum, target_path: Type.Optional(Type.String()), title: Type.String(),
	summary: Type.String(), detail: Type.Optional(Type.String()),
	evidence_json: Type.Optional(Type.String()), confidence: Type.Optional(Type.Number()),
	severity: Type.Optional(Type.Union([Type.Literal("friction"), Type.Literal("correction"), Type.Literal("waste"), Type.Literal("suggestion"), Type.Literal("insight")])),
	dedup_key: Type.Optional(Type.String()),
	status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("applied"), Type.Literal("rejected"), Type.Literal("duplicate")]),
	created_at: Type.String(), updated_at: Type.String(),
});
export type ProposalV2 = Static<typeof ProposalV2Schema>;