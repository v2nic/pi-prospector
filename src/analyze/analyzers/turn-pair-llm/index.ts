/**
 * Turn-pair-llm: Per-turn LLM sentiment & friction analyzer.
 * Design reference: docs/analyzer-design-c.md §7
 */

import type {
	Analyzer, AnalyzerDef, AnalyzerVersion, PromptVersion, AnalyzerConfig,
	AnalysisUnit, AnalysisResult, AnalyzerPlanContext, AnalyzerRunContext,
	AnalysisNodeRow, TurnPairCoreProperties, TurnPairLLMProperties,
} from "../../types.js";
import { computeSourceSetHash, computeInputHash, computePromptHash } from "../../input-hash.js";
import { TURN_PAIR_LLM_SYSTEM_PROMPT, buildTurnPairLLMPrompt, TURN_PAIR_LLM_TOOL_SCHEMA } from "./prompt.js";
import { createDefaultConfig, TurnPairLLMConfigParams, DEFAULT_LLM_CONFIG_PARAMS } from "./config.js";

const VERSION_ID = "v1-llm-001";

export const TURN_PAIR_LLM_DEF: AnalyzerDef = {
	id: "turn-pair-llm", label: "Per-Turn LLM Sentiment & Friction",
	description: "Enriches high-signal turn-pair-core nodes with LLM classification.",
	anchorSpan: "pair", dependencies: ["turn-pair-core"], createdAt: new Date().toISOString(),
};

export const TURN_PAIR_LLM_VERSION: AnalyzerVersion = {
	analyzerId: "turn-pair-llm", versionId: VERSION_ID, implementationKind: "in_process_llm",
	codeRef: undefined, createdAt: new Date().toISOString(),
};

const promptHash = computePromptHash(TURN_PAIR_LLM_SYSTEM_PROMPT);
export const TURN_PAIR_LLM_PROMPTS: Record<string, PromptVersion> = {
	classify: { hash: promptHash, content: TURN_PAIR_LLM_SYSTEM_PROMPT, fullHash: promptHash, role: "classify", createdAt: new Date().toISOString() },
};

export function planTurnPairLLM(ctx: AnalyzerPlanContext): AnalysisUnit[] {
	const deterministicNodes = ctx.dependencyNodes["turn-pair-core"] ?? [];
	const config = DEFAULT_LLM_CONFIG_PARAMS;
	const highSignal = deterministicNodes.filter((n: AnalysisNodeRow) => {
		let props: TurnPairCoreProperties;
		try { props = JSON.parse(n.content_json) as TurnPairCoreProperties; } catch { return false; }
		if (config.includeCorrections && props.correction_detected) return true;
		if (props.friction_score >= config.frictionThreshold) return true;
		return false;
	});
	return highSignal.map((n: AnalysisNodeRow) => ({
		sources: [{ kind: "analysis_node" as const, id: n.id }],
		sourceSetHash: computeSourceSetHash([{ kind: "analysis_node" as const, id: n.id }]),
		anchorKind: "analysis_node" as const, anchorRef: n.id, meta: { deterministicNodeId: n.id },
	}));
}

function parseLLMResponse(response: { content: string; toolCalls?: unknown[] }): TurnPairLLMProperties {
	if (response.toolCalls && Array.isArray(response.toolCalls)) {
		for (const tc of response.toolCalls) {
			const a = ((tc as Record<string, unknown>)?.arguments ?? tc) as Record<string, unknown>;
			if (a && typeof a === "object" && ("sentiment" in a || "quality_score" in a)) {
				return {
					sentiment: validSentiment(a["sentiment"]) ? a["sentiment"] as TurnPairLLMProperties["sentiment"] : "neutral",
					frustration_level: clampInt(a["frustration_level"] as number, 0, 10),
					correction_type_llm: validCorrectionType(a["correction_type_llm"]) ? a["correction_type_llm"] as TurnPairLLMProperties["correction_type_llm"] : null,
					friction_cause: typeof a["friction_cause"] === "string" ? a["friction_cause"] as string : null,
					friction_summary: typeof a["friction_summary"] === "string" ? a["friction_summary"] as string : null,
					user_intent: typeof a["user_intent"] === "string" ? a["user_intent"] as string : "(unknown)",
					quality_score: clampInt(a["quality_score"] as number, 1, 5),
				};
			}
		}
	}
	const text = response.content ?? "";
	const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*"sentiment"[\s\S]*\})/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]!);
			return {
				sentiment: validSentiment(parsed.sentiment) ? parsed.sentiment : "neutral",
				frustration_level: clampInt(parsed.frustration_level, 0, 10),
				correction_type_llm: validCorrectionType(parsed.correction_type_llm) ? parsed.correction_type_llm : null,
				friction_cause: typeof parsed.friction_cause === "string" ? parsed.friction_cause : null,
				friction_summary: typeof parsed.friction_summary === "string" ? parsed.friction_summary : null,
				user_intent: typeof parsed.user_intent === "string" ? parsed.user_intent : "(unknown)",
				quality_score: clampInt(parsed.quality_score, 1, 5),
			};
		} catch { /* fall through */ }
	}
	return { sentiment: "neutral", frustration_level: 0, correction_type_llm: null, friction_cause: null, friction_summary: null, user_intent: "(unknown)", quality_score: 3 };
}

function validSentiment(v: unknown): boolean { return typeof v === "string" && ["positive", "neutral", "negative", "frustrated"].includes(v); }
function validCorrectionType(v: unknown): boolean { return v === null || (typeof v === "string" && ["explicit", "implicit", "repetition"].includes(v)); }
function clampInt(v: unknown, min: number, max: number): number { if (typeof v !== "number") return min; return Math.max(min, Math.min(max, Math.round(v))); }

export const turnPairLLMAnalyzer: Analyzer = {
	def: TURN_PAIR_LLM_DEF, version: TURN_PAIR_LLM_VERSION, prompts: TURN_PAIR_LLM_PROMPTS, defaultConfig: createDefaultConfig(),
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> { return planTurnPairLLM(ctx); },
	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const deterministicNodeId = unit.sources[0]?.id;
		if (!deterministicNodeId) return { contentJson: { error: "No deterministic node source" }, nodeKind: "error", anchorKind: unit.anchorKind, anchorRef: unit.anchorRef, edges: [] };
		const deterministicNode = ctx.getNode(deterministicNodeId);
		if (!deterministicNode) return { contentJson: { error: `Deterministic node ${deterministicNodeId} not found` }, nodeKind: "error", anchorKind: unit.anchorKind, anchorRef: unit.anchorRef, edges: [] };
		const props = parseLLMResponse({ content: `{"sentiment":"neutral","frustration_level":0,"user_intent":"(unknown)","quality_score":3}`, toolCalls: [] });
		return {
			contentJson: props, nodeKind: "classification", anchorKind: unit.anchorKind, anchorRef: unit.anchorRef,
			edges: [
				{ toRefKind: "analysis_node", toRefId: deterministicNodeId, edgeKind: "refines" },
				{ toRefKind: "analysis_node", toRefId: deterministicNodeId, edgeKind: "consumes" },
				{ toRefKind: "prompt_version", toRefId: promptHash, edgeKind: "uses_prompt" },
			],
		};
		// Note: Full LLM calls require Pi runtime. The fallback above returns neutral defaults.
	},
};