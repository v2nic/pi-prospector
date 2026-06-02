/**
 * session-overview — produces one summary node per session,
 * consuming turn-pair-core and turn-pair-llm nodes. The summary
 * includes a free-text summary, key friction points, a sentiment
 * arc, and a list of improvement proposals. Proposals are
 * materialized into the `proposals` table by the framework.
 *
 * Strategy:
 *  1. Build a structured digest from messages + pair nodes.
 *  2. If the digest fits in `use_map_reduce_over_chars`, do a
 *     single reduce call (no map phase).
 *  3. Otherwise, split the digest into segments, call the map
 *     prompt on each (cheap model), then call the reduce prompt
 *     with the merged segment summaries + stats (mid model).
 *
 * The framework does not pick the model — analyzers pass a tier
 * (cheap, mid, expensive) and the framework resolves to a
 * concrete model string from `prospector.json`.
 */

import type {
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	Analyzer,
	AnalyzerConfig,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	MessageRow,
	PromptVersion,
} from "../../types.js";
import { computeSourceSetHash } from "../../framework.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { fullHash, shortHash } from "../../input-hash.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { TURN_PAIR_LLM_DEF } from "../turn-pair-llm/index.js";
import { buildDigest, splitDigest } from "./digest.js";
import {
	SESSION_OVERVIEW_MAP_PROMPT,
	buildMapPrompt,
	parseMapResponse,
	type MapSummary,
} from "./prompt-map.js";
import {
	SESSION_OVERVIEW_REDUCE_PROMPT,
	buildReducePrompt,
	parseReduceResponse,
	type SessionOverviewProperties,
} from "./prompt-reduce.js";
import { DEFAULT_SESSION_OVERVIEW_CONFIG, type SessionOverviewConfig } from "./config.js";

export const SESSION_OVERVIEW_DEF: AnalyzerDef = {
	id: "session-overview",
	label: "Session-Level Analysis & Proposals",
	description: "Produces a session-level summary, key friction points, sentiment arc, and improvement proposals. Consumes turn-pair-core and turn-pair-llm nodes.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id, TURN_PAIR_LLM_DEF.id],
};

export const SESSION_OVERVIEW_VERSION: AnalyzerVersion = {
	analyzerId: SESSION_OVERVIEW_DEF.id,
	versionId: "0.1.0",
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/session-overview/index.ts",
};

const MAP_PROMPT_HASH = shortHash(SESSION_OVERVIEW_MAP_PROMPT);
const MAP_PROMPT_FULL = fullHash(SESSION_OVERVIEW_MAP_PROMPT);
const REDUCE_PROMPT_HASH = shortHash(SESSION_OVERVIEW_REDUCE_PROMPT);
const REDUCE_PROMPT_FULL = fullHash(SESSION_OVERVIEW_REDUCE_PROMPT);

const SESSION_OVERVIEW_PROMPTS: Record<string, PromptVersion> = {
	"map-segment": {
		hash: MAP_PROMPT_HASH,
		content: SESSION_OVERVIEW_MAP_PROMPT,
		fullHash: MAP_PROMPT_FULL,
		role: "map",
	},
	"reduce-summaries": {
		hash: REDUCE_PROMPT_HASH,
		content: SESSION_OVERVIEW_REDUCE_PROMPT,
		fullHash: REDUCE_PROMPT_FULL,
		role: "reduce",
	},
};

function isPairNode(n: AnalysisNodeRow): boolean {
	return n.analyzer_id === TURN_PAIR_CORE_DEF.id;
}
function isLlmNode(n: AnalysisNodeRow): boolean {
	return n.analyzer_id === TURN_PAIR_LLM_DEF.id;
}

async function callMap(digest: string, ctx: AnalyzerRunContext): Promise<MapSummary> {
	const prompt = buildMapPrompt(digest);
	const response = await ctx.llm({
		model: "cheap",
		system: "You are a session-segment summarizer. Return JSON only.",
		user: prompt,
		temperature: 0.0,
		maxTokens: 2000,
	});
	return parseMapResponse(response.text);
}

async function callReduce(segmentSummaries: string, stats: string, ctx: AnalyzerRunContext): Promise<SessionOverviewProperties> {
	const prompt = buildReducePrompt({ segmentSummaries, stats });
	const response = await ctx.llm({
		model: "mid",
		system: "You are a session reducer. Return JSON only.",
		user: prompt,
		temperature: 0.0,
		maxTokens: 4000,
	});
	return parseReduceResponse(response.text);
}

export const sessionOverviewAnalyzer: Analyzer = {
	def: SESSION_OVERVIEW_DEF,
	version: SESSION_OVERVIEW_VERSION,
	prompts: SESSION_OVERVIEW_PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: SESSION_OVERVIEW_DEF.id,
		configJson: DEFAULT_SESSION_OVERVIEW_CONFIG as unknown as Record<string, unknown>,
		configHash: "",
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const pairNodes = (ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [])
			.filter(isPairNode)
			.sort((a, b) => a.id.localeCompare(b.id));
		if (pairNodes.length === 0) return [];

		const llmNodes = (ctx.dependencyNodes[TURN_PAIR_LLM_DEF.id] ?? []).filter(isLlmNode);

		const sources = [
			...pairNodes.map((n) => ({ kind: "analysis_node" as const, id: n.id })),
			...llmNodes.map((n) => ({ kind: "analysis_node" as const, id: n.id })),
		];

		return [{
			sources,
			sourceSetHash: computeSourceSetHash(sources),
			anchorKind: "session",
			anchorRef: ctx.sessionId,
		}];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as SessionOverviewConfig) ?? DEFAULT_SESSION_OVERVIEW_CONFIG;

		// Load messages for the session. We re-load here because the
		// plan context is per-plan and we want the most up-to-date
		// picture in case anything changed.
		const messages: MessageRow[] = ctx.getSessionMessages(ctx.run.session_id);

		// Resolve dependency nodes for this session
		const pairNodes = ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id)
			.filter(isPairNode)
			.sort((a, b) => a.id.localeCompare(b.id));
		const llmNodes = ctx.getDependencyNodes(TURN_PAIR_LLM_DEF.id).filter(isLlmNode);

		const digest = buildDigest({
			sessionId: ctx.run.session_id,
			messages,
			pairNodes,
			llmNodes,
		});

		const useMapReduce = digest.totalChars > config.use_map_reduce_over_chars;
		const statsText = JSON.stringify({
			total_pairs: digest.pairCount,
			friction_pairs: digest.frictionCount,
			compactions: digest.compactionCount,
			total_messages: messages.length,
		}, null, 2);

		let result: SessionOverviewProperties;
		let usedPrompts: string[] = [];

		if (!useMapReduce) {
			// Single reduce call with the whole digest as input
			const segmentSummaries = JSON.stringify([{ segment: 0, summary: digest.segments[0]?.text ?? "" }]);
			result = await callReduce(segmentSummaries, statsText, ctx);
			usedPrompts = [REDUCE_PROMPT_HASH];
		} else {
			// Map-reduce: split, map each, then reduce
			const segments = splitDigest(digest, config.segment_chars).slice(0, config.max_segments);
			const mapResults: MapSummary[] = [];
			for (const seg of segments) {
				const m = await callMap(seg.text, ctx);
				mapResults.push(m);
			}
			const segmentSummaries = JSON.stringify(
				mapResults.map((m, i) => ({ segment: i, summary: m.segment_summary, proposals: m.improvement_proposals })),
				null,
				2,
			);
			result = await callReduce(segmentSummaries, statsText, ctx);
			usedPrompts = [MAP_PROMPT_HASH, REDUCE_PROMPT_HASH];
		}

		const edges: AnalysisResult["edges"] = [];
		// Anchors to session
		edges.push({
			toRefKind: REF_KINDS.SESSION,
			toRefId: ctx.run.session_id,
			edgeKind: EDGE_KINDS.ANCHORS,
			ordinal: 0,
		});
		// Consumes all dependency nodes
		for (const n of pairNodes) {
			edges.push({
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: n.id,
				edgeKind: EDGE_KINDS.CONSUMES,
			});
		}
		for (const n of llmNodes) {
			edges.push({
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: n.id,
				edgeKind: EDGE_KINDS.CONSUMES,
			});
		}
		// uses_prompt for each prompt
		for (const h of usedPrompts) {
			edges.push({
				toRefKind: REF_KINDS.PROMPT_VERSION,
				toRefId: h,
				edgeKind: EDGE_KINDS.USES_PROMPT,
			});
		}

		return {
			contentJson: result as unknown as Record<string, unknown>,
			nodeKind: "summary",
			anchorKind: "session",
			anchorRef: ctx.run.session_id,
			edges,
		};
	},
};

export {
	SESSION_OVERVIEW_MAP_PROMPT,
	buildMapPrompt,
	parseMapResponse,
	SESSION_OVERVIEW_REDUCE_PROMPT,
	buildReducePrompt,
	parseReduceResponse,
	buildDigest,
	splitDigest,
	DEFAULT_SESSION_OVERVIEW_CONFIG,
};
export type { SessionOverviewConfig, SessionOverviewProperties, MapSummary };
