/**
 * turn-pair-llm — cheap LLM enrichment of high-signal turn pairs.
 *
 * Depends on turn-pair-core. Only pairs that the deterministic pass flagged as
 * `high_signal` are sent to the model, keeping cost bounded. Produces one
 * `classification` node per enriched pair, consuming the core metric node.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { resolveModelSpec } from "../../model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import {
	buildTurnPairs,
	type PairToolCall,
	type PairToolResult,
} from "../turn-pair-core/build.js";
import { TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../turn-pair-core/index.js";
import {
	CLASSIFY_PROMPT,
	CLASSIFY_PROMPT_HASH,
	buildClassifyPrompt,
	parseClassifyResponse,
	type TurnPairLLMProperties,
	type ToolCallEvidence,
	type ToolResultEvidence,
} from "./prompt.js";
import { DEFAULT_TURN_PAIR_LLM_CONFIG, type TurnPairLLMConfig } from "./config.js";

export const TURN_PAIR_LLM_DEF: AnalyzerDef = {
	id: "turn-pair-llm",
	label: "Per-Turn Classification (LLM)",
	description: "Classifies sentiment and friction for high-signal turn pairs using a cheap model.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id],
};

export const TURN_PAIR_LLM_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_LLM_DEF.id,
	major: 1,
	minor: 1,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/turn-pair-llm/index.ts",
};

const PROMPTS: Record<string, PromptVersion> = {
	classify: { hash: CLASSIFY_PROMPT_HASH, content: CLASSIFY_PROMPT, role: "classify" },
};

interface EnrichMeta {
	userText: string;
	assistantText: string;
	correctionText: string | null;
	toolCalls: ToolCallEvidence[];
	toolResults: ToolResultEvidence[];
	coreNodeId: string;
}

export const turnPairLLMAnalyzer: Analyzer = {
	def: TURN_PAIR_LLM_DEF,
	version: TURN_PAIR_LLM_VERSION,
	prompts: PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: TURN_PAIR_LLM_DEF.id,
		configHash: computeConfigHash(DEFAULT_TURN_PAIR_LLM_CONFIG),
		configJson: DEFAULT_TURN_PAIR_LLM_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers): string[] {
		const cfg = (config as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;
		return [resolveModelSpec(cfg.tier, modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		const pairs = buildTurnPairs(ctx.messages);
		const pairByUserId = new Map(pairs.map((p) => [p.userMessageId, p]));
		const config = (ctx.config as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;

		// Collect every high-signal pair that still maps to a turn in the transcript.
		const candidates: { node: typeof coreNodes[number]; props: TurnPairCoreProperties }[] = [];
		for (const node of coreNodes) {
			let props: TurnPairCoreProperties;
			try {
				props = JSON.parse(node.content_json) as TurnPairCoreProperties;
			} catch {
				continue;
			}
			if (!props.high_signal) continue;
			if (!pairByUserId.has(props.user_message_id)) continue;
			candidates.push({ node, props });
		}

		// Cost guard: enrich at most `maxPairsPerSession`, highest friction first
		// (ties broken by pair order so selection is deterministic across runs).
		candidates.sort((a, b) => b.props.friction_score - a.props.friction_score || a.props.pair_index - b.props.pair_index);
		const cap = config.maxPairsPerSession;
		const selected = Number.isFinite(cap) && cap >= 0 ? candidates.slice(0, cap) : candidates;

		const units: AnalysisUnit[] = [];
		for (const { node, props } of selected) {
			const pair = pairByUserId.get(props.user_message_id)!;
			const sources: SourceRef[] = [{ kind: "analysis_node", id: node.output_key }];
			const meta: EnrichMeta = {
				userText: pair.userText,
				assistantText: pair.assistantText,
				correctionText: props.correction_text,
				toolCalls: pair.toolCalls.map((tc): ToolCallEvidence => ({
					name: tc.name,
					argumentsPreview: tc.argumentsPreview,
				})),
				toolResults: pair.toolResults.map((tr): ToolResultEvidence => ({
					toolName: tr.toolName,
					isError: tr.isError,
					errorHead: tr.errorHead,
				})),
				coreNodeId: node.id,
			};
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: props.user_message_id,
				meta: meta as unknown as Record<string, unknown>,
			});
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = (ctx.config.configJson as unknown as TurnPairLLMConfig) ?? DEFAULT_TURN_PAIR_LLM_CONFIG;
		const meta = unit.meta as unknown as EnrichMeta;

		const response = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
			user: buildClassifyPrompt({
				userText: meta.userText,
				assistantText: meta.assistantText,
				correctionText: meta.correctionText,
				toolCalls: meta.toolCalls,
				toolResults: meta.toolResults,
			}),
			temperature: config.temperature,
			maxTokens: 500,
		});

		const properties: TurnPairLLMProperties = {
			...parseClassifyResponse(response.text),
			user_message_id: unit.anchorRef,
		};

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "message",
			anchorRef: unit.anchorRef,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			durationMs: response.durationMs,
			edges: [
				{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
				{ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.coreNodeId, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 },
				{ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 2 },
			],
		};
	},
};
