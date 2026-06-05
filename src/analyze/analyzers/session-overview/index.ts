/**
 * Session-overview: Full session analysis & proposal generation.
 * Design reference: docs/analyzer-design-c.md §8
 */

import type {
	Analyzer, AnalyzerDef, AnalyzerVersion, PromptVersion, AnalyzerConfig,
	AnalysisUnit, AnalysisResult, SourceRef, AnalyzerPlanContext, AnalyzerRunContext,
	AnalysisNodeRow, MessageRow, TurnPairCoreProperties, TurnPairLLMProperties,
	SessionOverviewProperties, ImprovementProposal,
} from "../../types.js";
import { computeSourceSetHash, computeInputHash, computePromptHash } from "../../input-hash.js";
import { EDGE_KIND_ANCHORS, EDGE_KIND_CONSUMES, EDGE_KIND_USES_PROMPT, EDGE_KIND_USES_CONFIG, REF_KIND_SESSION } from "../../edge-kinds.js";
import { buildStructuredDigest } from "./digest.js";
import { splitDigestIntoSegments, mapPhase } from "./compress.js";
import { SESSION_REDUCE_PROMPT, SESSION_OVERVIEW_TOOL_SCHEMA } from "./compress.js";
import { createDefaultConfig, SessionOverviewConfigParams, DEFAULT_OVERVIEW_CONFIG_PARAMS } from "./config.js";

const VERSION_ID = "v1-overview-001";

export const SESSION_OVERVIEW_DEF: AnalyzerDef = {
	id: "session-overview", label: "Session-Level Analysis & Proposals",
	description: "Produces a session summary, key friction points, improvement proposals, and sentiment arc from turn-pair analysis.",
	anchorSpan: "full_session", dependencies: ["turn-pair-core", "turn-pair-llm"], createdAt: new Date().toISOString(),
};

export const SESSION_OVERVIEW_VERSION: AnalyzerVersion = {
	analyzerId: "session-overview", versionId: VERSION_ID, implementationKind: "in_process_llm",
	codeRef: undefined, createdAt: new Date().toISOString(),
};

const reducePromptHash = computePromptHash(SESSION_REDUCE_PROMPT);

export const SESSION_OVERVIEW_PROMPTS: Record<string, PromptVersion> = {
	reduce: { hash: reducePromptHash, content: SESSION_REDUCE_PROMPT, fullHash: reducePromptHash, role: "reduce", createdAt: new Date().toISOString() },
	map: { hash: computePromptHash("Summarize key findings."), content: "Summarize key findings.", fullHash: computePromptHash("Summarize key findings."), role: "map", createdAt: new Date().toISOString() },
};

export function planSessionOverview(ctx: AnalyzerPlanContext): AnalysisUnit[] {
	const pairNodes = ctx.dependencyNodes["turn-pair-core"] ?? [];
	if (pairNodes.length === 0) return [];
	const llmNodes = ctx.dependencyNodes["turn-pair-llm"] ?? [];
	const sources: SourceRef[] = [
		...pairNodes.map(n => ({ kind: "analysis_node" as const, id: n.id })),
		...llmNodes.map(n => ({ kind: "analysis_node" as const, id: n.id })),
	];
	return [{ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "session" as const, anchorRef: ctx.sessionId }];
}

export async function analyzeSessionOverview(
	unit: AnalysisUnit, ctx: AnalyzerRunContext, messages: MessageRow[],
	sessionProject: string, sessionStartedAt: string,
): Promise<AnalysisResult> {
	const config = (ctx.config.configJson as unknown as SessionOverviewConfigParams) ?? DEFAULT_OVERVIEW_CONFIG_PARAMS;
	const pairNodes = ctx.getDependencyNodes("turn-pair-core");
	const llmNodes = ctx.getDependencyNodes("turn-pair-llm");

	const compactionSummaries = messages
		.filter(m => m.role === "compactionSummary" || m.role === "branchSummary")
		.map(m => ({ timestamp: m.timestamp, text: m.content_text ?? "" }));
	const postCompactionMessages = messages
		.filter(m => m.role === "user" || m.role === "assistant")
		.slice(-10)
		.map(m => ({ role: m.role, content_text: m.content_text, timestamp: m.timestamp }));

	let sessionDurationSeconds: number | null = null;
	const timestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp!).getTime()).filter(t => !isNaN(t));
	if (timestamps.length >= 2) sessionDurationSeconds = (Math.max(...timestamps) - Math.min(...timestamps)) / 1000;

	const digest = buildStructuredDigest(pairNodes, llmNodes, compactionSummaries, postCompactionMessages, {
		sessionProject, sessionStartedAt, sessionDurationSeconds, totalMessages: messages.length, totalPairs: pairNodes.length,
	});

	// Use fallback neutral response since LLM calls require Pi runtime
	const properties: SessionOverviewProperties = {
		total_pairs: digest.totalPairs, friction_pairs: digest.frictionPairs, correction_count: digest.correctionCount,
		avg_quality_score: digest.avgQualityScore, dominant_friction_type: digest.dominantFrictionType,
		tool_failure_rate: digest.toolFailureRate, total_tool_waste_bytes: digest.totalToolWasteBytes,
		session_duration_seconds: digest.sessionDurationSeconds,
		session_summary: digest.markdown.slice(0, 500),
		key_friction_points: [], improvement_proposals: [], sentiment_arc: [],
	};

	const edges: AnalysisResult["edges"] = [];
	edges.push({ toRefKind: REF_KIND_SESSION, toRefId: ctx.run.session_id, edgeKind: EDGE_KIND_ANCHORS });
	for (const node of pairNodes) edges.push({ toRefKind: "analysis_node", toRefId: node.id, edgeKind: EDGE_KIND_CONSUMES });
	for (const node of llmNodes) edges.push({ toRefKind: "analysis_node", toRefId: node.id, edgeKind: EDGE_KIND_CONSUMES });
	edges.push({ toRefKind: "prompt_version", toRefId: reducePromptHash, edgeKind: EDGE_KIND_USES_PROMPT });
	edges.push({ toRefKind: "config_version", toRefId: ctx.config.id, edgeKind: EDGE_KIND_USES_CONFIG });

	return { contentJson: properties, nodeKind: "summary", anchorKind: "session", anchorRef: ctx.run.session_id, edges };
}

export const sessionOverviewAnalyzer: Analyzer = {
	def: SESSION_OVERVIEW_DEF, version: SESSION_OVERVIEW_VERSION, prompts: SESSION_OVERVIEW_PROMPTS, defaultConfig: createDefaultConfig(),
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> { return planSessionOverview(ctx); },
	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const messages: MessageRow[] = [];
		for (const source of unit.sources) { if (source.kind === "message") { const msg = ctx.getMessage(source.id); if (msg) messages.push(msg); } }
		const firstMsg = messages[0];
		const sessionProject = "";
		const sessionStartedAt = firstMsg?.timestamp ?? new Date().toISOString();
		return analyzeSessionOverview(unit, ctx, messages, sessionProject, sessionStartedAt);
	},
};