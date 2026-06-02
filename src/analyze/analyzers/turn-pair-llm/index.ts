/**
 * turn-pair-llm — LLM enrichment for high-signal turn pairs.
 *
 * Depends on turn-pair-core. Filters dependency nodes to those
 * flagged as corrections or high friction, then asks an LLM to
 * classify sentiment, frustration, friction cause, and quality.
 *
 * The framework passes a `cheap` model (configured in
 * prospector.json's `models.cheap`) via the run context's
 * `llm()` function. The analyzer doesn't pick the model.
 *
 * Edges produced:
 *   refines  → turn-pair-core node
 *   consumes → turn-pair-core node
 *   anchors  → each message in the underlying pair (inherited)
 *   uses_prompt → the classification prompt
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
	PromptVersion,
} from "../../types.js";
import { computeSourceSetHash } from "../../framework.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { fullHash, shortHash } from "../../input-hash.js";
import {
	TURN_PAIR_LLM_PROMPT,
	TURN_PAIR_LLM_PROMPT_NAME,
	buildTurnPairLlmPrompt,
	parseTurnPairLlmResponse,
} from "./prompt.js";
import { DEFAULT_TURN_PAIR_LLM_CONFIG, type TurnPairLlmConfig } from "./config.js";

export const TURN_PAIR_LLM_DEF: AnalyzerDef = {
	id: "turn-pair-llm",
	label: "Per-Turn LLM Sentiment & Friction",
	description: "Enriches high-signal turn pairs (corrections, high friction) with an LLM classification of sentiment, frustration, friction cause, and quality.",
	anchorSpan: "pair",
	dependencies: [TURN_PAIR_CORE_DEF.id],
};

export const TURN_PAIR_LLM_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_LLM_DEF.id,
	versionId: "0.1.0",
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/turn-pair-llm/index.ts",
};

const PROMPT_HASH = shortHash(TURN_PAIR_LLM_PROMPT);
const PROMPT_FULL_HASH = fullHash(TURN_PAIR_LLM_PROMPT);

const TURN_PAIR_LLM_PROMPTS: Record<string, PromptVersion> = {
	[TURN_PAIR_LLM_PROMPT_NAME]: {
		hash: PROMPT_HASH,
		content: TURN_PAIR_LLM_PROMPT,
		fullHash: PROMPT_FULL_HASH,
		role: "classify",
	},
};

interface TurnPairCoreProps {
	user_msg_length: number;
	assistant_msg_length: number;
	has_thinking: boolean;
	thinking_length: number;
	correction_detected: boolean;
	correction_patterns: string[];
	correction_type: "explicit" | "implicit" | "repetition" | null;
	correction_text: string | null;
	tool_call_count: number;
	tool_names: string[];
	tool_failure_count: number;
	tool_waste_bytes: number;
	retry_detected: boolean;
	elapsed_seconds: number | null;
	friction_score: number;
	is_compaction_boundary: boolean;
	user_index: number;
	assistant_index: number;
	[key: string]: unknown;
}

function isHighSignal(node: AnalysisNodeRow, config: TurnPairLlmConfig): boolean {
	let props: TurnPairCoreProps;
	try { props = JSON.parse(node.content_json) as TurnPairCoreProps; } catch { return false; }
	if (config.require_correction && !props.correction_detected) return false;
	return Boolean(props.correction_detected) || props.friction_score >= config.friction_threshold;
}

export const turnPairLlmAnalyzer: Analyzer = {
	def: TURN_PAIR_LLM_DEF,
	version: TURN_PAIR_LLM_VERSION,
	prompts: TURN_PAIR_LLM_PROMPTS,
	defaultConfig: {
		id: "",
		analyzerId: TURN_PAIR_LLM_DEF.id,
		configJson: DEFAULT_TURN_PAIR_LLM_CONFIG as unknown as Record<string, unknown>,
		configHash: "",
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = (ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id]?.[0]
			? (JSON.parse(ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id]![0]!.content_json) as TurnPairCoreProps)
			: null)
			? DEFAULT_TURN_PAIR_LLM_CONFIG
			: DEFAULT_TURN_PAIR_LLM_CONFIG;

		// We can't read the config here (plan doesn't have it), so
		// we use defaults. The actual filtering happens at run time
		// because the config is per-run.
		const effectiveConfig = config;

		const pairNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		const highSignal = pairNodes
			.filter((n) => isHighSignal(n, effectiveConfig))
			.slice(0, DEFAULT_TURN_PAIR_LLM_CONFIG.max_pairs_per_session);

		return highSignal.map((n) => ({
			sources: [{ kind: "analysis_node", id: n.id }],
			sourceSetHash: computeSourceSetHash([{ kind: "analysis_node", id: n.id }]),
			anchorKind: "analysis_node",
			anchorRef: n.id,
			meta: { deterministicNodeId: n.id },
		}));
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const detId = (unit.meta as { deterministicNodeId?: string } | undefined)?.deterministicNodeId;
		if (!detId) throw new Error("turn-pair-llm: missing deterministicNodeId in unit meta");

		const detNode = ctx.getNode(detId);
		if (!detNode) throw new Error(`turn-pair-llm: dependency node not found: ${detId}`);

		let detProps: TurnPairCoreProps;
		try { detProps = JSON.parse(detNode.content_json) as TurnPairCoreProps; }
		catch (e) {
			throw new Error(`turn-pair-llm: invalid content_json in dependency node: ${(e as Error).message}`);
		}

		// Read the messages anchored to the deterministic node.
		const messages = ctx.getAnchoredMessages(detId);
		if (messages.length === 0) {
			throw new Error("turn-pair-llm: deterministic node has no anchored message edges; cannot build prompt");
		}

		const userMsg = messages.find((m) => m.role === "user");
		const assistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
		if (!userMsg || !assistantMsg) {
			throw new Error("turn-pair-llm: cannot find user and assistant messages for pair");
		}

		// Build tool call / result digests
		const toolCalls: Array<{ name: string; args: unknown }> = [];
		const toolResults: Array<{ tool: string; ok: boolean; preview: string }> = [];
		for (const m of messages) {
			if (m.role === "assistant" && m.tool_calls) {
				try {
					const calls = JSON.parse(m.tool_calls);
					if (Array.isArray(calls)) {
						for (const c of calls) {
							toolCalls.push({ name: c.name, args: c.arguments });
						}
					}
				} catch { /* ignore */ }
			}
			if (m.role === "toolResult" && m.tool_results) {
				try {
					const results = JSON.parse(m.tool_results);
					if (Array.isArray(results)) {
						for (const r of results) {
							toolResults.push({
								tool: r.toolName,
								ok: !r.isError,
								preview: (m.content_text ?? "").slice(0, 200),
							});
						}
					}
				} catch { /* ignore */ }
			}
		}

		const prompt = buildTurnPairLlmPrompt({
			userText: userMsg.content_text ?? "",
			assistantText: assistantMsg.content_text ?? "",
			toolCalls: JSON.stringify(toolCalls, null, 2),
			toolResults: JSON.stringify(toolResults, null, 2),
			friction: {
				correction_detected: detProps.correction_detected,
				friction_score: detProps.friction_score,
				tool_failure_count: detProps.tool_failure_count,
				retry_detected: detProps.retry_detected,
				thinking_length: detProps.thinking_length,
			},
		});

		const start = Date.now();
		const response = await ctx.llm({
			model: "cheap",  // framework resolves to a concrete model
			system: "You are a turn-pair classifier. Return JSON only.",
			user: prompt,
			temperature: 0.0,
			maxTokens: 600,
		});
		const durationMs = Date.now() - start;

		const classification = parseTurnPairLlmResponse(response.text);

		const edges: AnalysisResult["edges"] = [
			{
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: detId,
				edgeKind: EDGE_KINDS.REFINES,
			},
			{
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: detId,
				edgeKind: EDGE_KINDS.CONSUMES,
			},
			{
				toRefKind: REF_KINDS.PROMPT_VERSION,
				toRefId: PROMPT_HASH,
				edgeKind: EDGE_KINDS.USES_PROMPT,
			},
		];
		// Anchor to the same messages as the deterministic node
		for (const m of messages) {
			edges.push({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: m.id,
				edgeKind: EDGE_KINDS.ANCHORS,
			});
		}
		edges.push({
			toRefKind: REF_KINDS.SESSION,
			toRefId: ctx.run.session_id,
			edgeKind: EDGE_KINDS.ANCHORS,
			ordinal: 999,
		});

		return {
			contentJson: classification as unknown as Record<string, unknown>,
			nodeKind: "classification",
			anchorKind: "analysis_node",
			anchorRef: detId,
			edges,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			durationMs,
		};
	},
};

export { TURN_PAIR_LLM_PROMPT, buildTurnPairLlmPrompt, parseTurnPairLlmResponse } from "./prompt.js";
export { DEFAULT_TURN_PAIR_LLM_CONFIG } from "./config.js";
export type { TurnPairLlmConfig } from "./config.js";

// Re-exports for tests
export type { TurnPairLlmClassification } from "./prompt.js";
