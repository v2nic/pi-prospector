/**
 * Turn-pair-core: Per-turn deterministic metrics analyzer.
 * Design reference: docs/analyzer-design-c.md §6
 */

import type {
	Analyzer, AnalyzerDef, AnalyzerVersion, PromptVersion, AnalyzerConfig,
	AnalysisUnit, AnalysisResult, SourceRef, AnalyzerPlanContext, AnalyzerRunContext,
	MessageRow, TurnPairCoreProperties,
} from "../../types.js";
import { computeSourceSetHash, computeInputHash } from "../../input-hash.js";
import { classifyCorrection } from "./patterns.js";
import { computeFrictionScore, detectRetry, estimateWasteBytes, createDefaultConfig, TurnPairCoreConfigParams, DEFAULT_CONFIG_PARAMS } from "./config.js";

const VERSION_ID = "v1-deterministic-001";

export const TURN_PAIR_CORE_DEF: AnalyzerDef = {
	id: "turn-pair-core", label: "Per-Turn Deterministic Metrics",
	description: "Computes deterministic metrics for each user→assistant turn pair: message lengths, correction detection, tool usage, friction score.",
	anchorSpan: "pair", dependencies: [], createdAt: new Date().toISOString(),
};

export const TURN_PAIR_CORE_VERSION: AnalyzerVersion = {
	analyzerId: "turn-pair-core", versionId: VERSION_ID, implementationKind: "deterministic",
	codeRef: undefined, createdAt: new Date().toISOString(),
};

export const TURN_PAIR_CORE_PROMPTS: Record<string, PromptVersion> = {};

export function planTurnPairs(ctx: AnalyzerPlanContext): AnalysisUnit[] {
	const units: AnalysisUnit[] = [];
	const messages = ctx.messages;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		if (msg.role !== "user") continue;
		let assistantIdx = -1;
		let endIdx = i;
		for (let j = i + 1; j < messages.length; j++) {
			const m = messages[j]!;
			if (m.role === "assistant") { assistantIdx = j; endIdx = j; break; }
			if (m.role === "user") break;
			endIdx = j;
		}
		if (assistantIdx === -1) continue;
		const sources: SourceRef[] = [];
		for (let k = i; k <= endIdx && k < messages.length; k++) { sources.push({ kind: "message", id: messages[k]!.id }); }
		units.push({ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "pair", anchorRef: messages[i]!.id, meta: { userIndex: i, assistantIndex: assistantIdx } });
	}
	return units;
}

export function analyzeTurnPair(unit: AnalysisUnit, ctx: AnalyzerRunContext, config: AnalyzerConfig, messages: MessageRow[]): AnalysisResult {
	const configParams = (config.configJson as unknown as TurnPairCoreConfigParams) ?? DEFAULT_CONFIG_PARAMS;
	const userMsg = messages.find(m => m.role === "user");
	const assistantMsg = messages.find(m => m.role === "assistant");
	const toolResultMsgs = messages.filter(m => m.role === "toolResult");

	if (!userMsg || !assistantMsg) {
		return {
			contentJson: { error: "Missing user or assistant message in pair" }, nodeKind: "metric",
			anchorKind: unit.anchorKind, anchorRef: unit.anchorRef,
			edges: unit.sources.map((s: SourceRef, idx: number) => ({ toRefKind: s.kind as "message", toRefId: s.id, edgeKind: "anchors" as const, ordinal: idx })),
		};
	}

	let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	if (assistantMsg.tool_calls) { try { toolCalls = JSON.parse(assistantMsg.tool_calls); } catch { /* ignore */ } }

	let toolResults: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number }> = [];
	for (const trMsg of toolResultMsgs) { if (trMsg.tool_results) { try { toolResults = JSON.parse(trMsg.tool_results); } catch { /* ignore */ } } }

	const userText = userMsg.content_text ?? "";
	const correction = classifyCorrection(userText, false);
	const retryDetected = detectRetry(toolCalls.map(tc => tc.name));
	const totalToolBytes = toolResults.filter(r => !r.isError).reduce((sum, r) => sum + r.textLength, 0);
	const toolWasteBytes = estimateWasteBytes(toolResults.map(r => ({ toolName: r.toolName, textLength: r.textLength, isError: r.isError })), assistantMsg.content_text);
	const toolFailureDetails = toolResults.filter(r => r.isError).map(r => ({ tool_name: r.toolName, error_preview: `Tool ${r.toolName} returned error` }));
	const elapsedSeconds = computeElapsedSeconds(userMsg.timestamp, assistantMsg.timestamp);
	const isCompactionBoundary = messages.some(m => m.role === "compactionSummary" || m.role === "branchSummary");
	const frictionScore = computeFrictionScore({
		correctionDetected: correction.detected, correctionType: correction.type,
		toolFailureCount: toolResults.filter(r => r.isError).length, toolFailureDetails,
		retryDetected, toolWasteBytes, totalToolBytes,
	}, configParams as TurnPairCoreConfigParams);

	const properties: TurnPairCoreProperties = {
		user_msg_length: (userMsg.content_text ?? "").length,
		assistant_msg_length: (assistantMsg.content_text ?? "").length,
		has_thinking: assistantMsg.content_thinking !== null && (assistantMsg.content_thinking ?? "").length > 0,
		thinking_length: (assistantMsg.content_thinking ?? "").length,
		correction_detected: correction.detected, correction_patterns: correction.patterns,
		correction_type: correction.type, correction_text: correction.correctionText,
		tool_call_count: toolCalls.length, tool_names: toolCalls.map(tc => tc.name),
		tool_failure_count: toolResults.filter(r => r.isError).length, tool_failure_details: toolFailureDetails,
		tool_waste_bytes: toolWasteBytes, retry_detected: retryDetected,
		elapsed_seconds: elapsedSeconds, friction_score: frictionScore,
		model: null, stop_reason: null, usage_input_tokens: null, usage_output_tokens: null,
		is_compaction_boundary: isCompactionBoundary,
	};

	const edges: AnalysisResult["edges"] = unit.sources.map((s: SourceRef, idx: number) => ({
		toRefKind: s.kind as "message", toRefId: s.id, edgeKind: "anchors" as const, ordinal: idx,
	}));

	return { contentJson: properties, nodeKind: "metric", anchorKind: unit.anchorKind, anchorRef: unit.anchorRef, edges };
}

function computeElapsedSeconds(userTimestamp: string | null, assistantTimestamp: string | null): number | null {
	if (!userTimestamp || !assistantTimestamp) return null;
	try { const diff = (new Date(assistantTimestamp).getTime() - new Date(userTimestamp).getTime()) / 1000; return diff >= 0 ? diff : null; } catch { return null; }
}

export const turnPairCoreAnalyzer: Analyzer = {
	def: TURN_PAIR_CORE_DEF, version: TURN_PAIR_CORE_VERSION, prompts: TURN_PAIR_CORE_PROMPTS, defaultConfig: createDefaultConfig(),
	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> { return planTurnPairs(ctx); },
	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const messages: MessageRow[] = [];
		for (const source of unit.sources) { if (source.kind === "message") { const msg = ctx.getMessage(source.id); if (msg) messages.push(msg); } }
		return analyzeTurnPair(unit, ctx, ctx.config, messages);
	},
};