/**
 * turn-pair-core — deterministic, per-(user, assistant + tool_results)
 * pair analyzer.
 *
 * Produces a single `metric` node per pair with all 19 properties
 * from §6.3 of the design doc. No LLM. Always runnable; the
 * cheapest pass.
 *
 * Edges:
 *   anchors → each message in the pair (user, assistant, tool results)
 */

import type {
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
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash } from "../../framework.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import {
	detectAllCorrectionPatterns,
	detectCorrection,
	detectRepetition,
	extractCorrectionText,
} from "./patterns.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG, computeFrictionScore, type TurnPairCoreConfig } from "./config.js";export const TURN_PAIR_CORE_DEF: AnalyzerDef = {
	id: "turn-pair-core",
	label: "Per-Turn Deterministic Metrics",
	description: "Computes per-pair metrics (lengths, friction score, tool stats, correction detection) without using an LLM.",
	anchorSpan: "pair",
	dependencies: [],
};

export const TURN_PAIR_CORE_VERSION: AnalyzerVersion = {
	analyzerId: TURN_PAIR_CORE_DEF.id,
	versionId: "0.1.0",
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/turn-pair-core/index.ts",
};

export const TURN_PAIR_CORE_PROMPTS: Record<string, PromptVersion> = {};

export interface TurnPairNode {
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
	tool_failure_details: Array<{ tool_name: string; error_preview: string }>;
	tool_waste_bytes: number;
	retry_detected: boolean;
	elapsed_seconds: number | null;
	friction_score: number;
	model: string | null;
	stop_reason: string | null;
	usage_input_tokens: number | null;
	usage_output_tokens: number | null;
	is_compaction_boundary: boolean;
	/** Indices into ctx.messages for traceability. */
	user_index: number;
	assistant_index: number;
}

function findPair(messages: MessageRow[], startAt: number): { user: MessageRow; assistant: MessageRow | null; intervening: MessageRow[]; userIndex: number; assistantIndex: number; endIndex: number } | null {
	for (let i = startAt; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== "user") continue;

		// The pair extends from this user message to (but not including)
		// the next user message, or the end of the session. Tool results,
		// intermediate assistants, and compaction summaries within are
		// "intervening" and belong to this pair. The "assistant response"
		// is the LAST assistant in the range, if any. Intervening does
		// not include the final assistant (that IS the response).
		let j = i + 1;
		let lastAssistant: MessageRow | null = null;
		let lastAssistantIndex = -1;
		while (j < messages.length) {
			const n = messages[j]!;
			if (n.role === "user") break;
			if (n.role === "assistant") {
				lastAssistant = n;
				lastAssistantIndex = j;
			}
			j++;
		}
		const endIndex = j - 1;
		const intervening: MessageRow[] = [];
		for (let k = i + 1; k <= endIndex && k < messages.length; k++) {
			if (k !== lastAssistantIndex) intervening.push(messages[k]!);
		}
		return { user: m, assistant: lastAssistant, intervening, userIndex: i, assistantIndex: lastAssistantIndex, endIndex };
	}
	return null;
}

function parseMeta(metaJson: string | null): { model?: string; stop_reason?: string; usage?: { input?: number; output?: number } } | null {
	if (!metaJson) return null;
	try { return JSON.parse(metaJson); } catch { return null; }
}

function toolName(callJson: string | null): string | null {
	if (!callJson) return null;
	try {
		const parsed = JSON.parse(callJson);
		if (Array.isArray(parsed) && parsed[0]?.name) return String(parsed[0].name);
	} catch { /* ignore */ }
	return null;
}

function toolResultInfo(resultJson: string | null): { toolName: string; isError: boolean; textLength: number } | null {
	if (!resultJson) return null;
	try {
		const parsed = JSON.parse(resultJson);
		if (Array.isArray(parsed) && parsed[0]) {
			return {
				toolName: String(parsed[0].toolName ?? ""),
				isError: Boolean(parsed[0].isError),
				textLength: Number(parsed[0].textLength ?? 0),
			};
		}
	} catch { /* ignore */ }
	return null;
}

function buildToolCallKey(name: string, args: Record<string, unknown>): string {
	// For "read" we use the path; for "bash" the command; etc.
	// Anything else uses a JSON of the args.
	const target = (args.path as string)
		?? (args.command as string)
		?? (args.file as string)
		?? JSON.stringify(args);
	return `${name}::${target}`;
}

function previewError(text: string | null): string {
	if (!text) return "";
	return text.length > 80 ? text.slice(0, 80) + "..." : text;
}

export function buildTurnPairNode(
	messages: MessageRow[],
	userIndex: number,
	endIndex: number,
	config: TurnPairCoreConfig,
): TurnPairNode | null {
	const user = messages[userIndex];
	if (!user || user.role !== "user") return null;

	// Find the last assistant in the range [userIndex+1, endIndex]
	let assistant: MessageRow | null = null;
	let lastAssistantIndex = -1;
	for (let k = userIndex + 1; k <= endIndex && k < messages.length; k++) {
		if (messages[k]!.role === "assistant") {
			assistant = messages[k]!;
			lastAssistantIndex = k;
		}
	}
	if (!assistant) return null;

	// Intervening: everything in [userIndex+1, endIndex] EXCEPT the
	// final assistant. This is where tool results, compactions, and
	// intermediate assistants live.
	const intervening: MessageRow[] = [];
	for (let k = userIndex + 1; k <= endIndex && k < messages.length; k++) {
		if (k !== lastAssistantIndex) intervening.push(messages[k]!);
	}

	const userText = user.content_text;
	const assistantText = assistant?.content_text ?? null;
	const thinking = assistant?.content_thinking ?? null;

	// Tool calls
	let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	if (assistant?.tool_calls) {
		try { toolCalls = JSON.parse(assistant.tool_calls); } catch { toolCalls = []; }
	}

	// Tool results
	let toolResults: Array<{ toolName: string; isError: boolean; textLength: number }> = [];
	for (const m of intervening) {
		if (m.role === "toolResult") {
			const info = toolResultInfo(m.tool_results);
			if (info) toolResults.push(info);
		}
	}

	// Correction detection
	const userPriorIndex = findPriorUserIndex(messages, userIndex);
	const priorText = userPriorIndex >= 0 ? messages[userPriorIndex]?.content_text ?? null : null;
	const correction = detectCorrection(userText);
	const correctionPatterns = detectAllCorrectionPatterns(userText);
	const repetition = !correction && detectRepetition(userText, priorText);
	const correctionType: TurnPairNode["correction_type"] = correction ? "explicit" : (repetition ? "repetition" : null);
	const correctionText = correction && userText ? extractCorrectionText(userText, correction) : null;

	// Tool stats
	const toolCallCount = toolCalls.length;
	const toolNames = [...new Set(toolCalls.map((c) => c.name))];
	const failures = toolResults.filter((r) => r.isError);
	const toolFailureDetails: Array<{ tool_name: string; error_preview: string }> = [];
	for (let i = 0; i < failures.length; i++) {
		const f = failures[i]!;
		const resultMsg = intervening.find((m) => m.role === "toolResult" && toolResultInfo(m.tool_results)?.toolName === f.toolName);
		toolFailureDetails.push({ tool_name: f.toolName, error_preview: previewError(resultMsg?.content_text ?? null) });
	}

	// Waste bytes: tool results that are never referenced in the
	// assistant's text. We approximate by checking the assistant's
	// text for any of the tool result text (cheap: any 30-char
	// fragment). A more sophisticated approach would diff structured
	// references; this is a useful upper bound.
	let toolWasteBytes = 0;
	if (assistantText) {
		for (let i = 0; i < intervening.length; i++) {
			const m = intervening[i]!;
			if (m.role !== "toolResult") continue;
			const resultLen = m.content_text?.length ?? 0;
			if (resultLen === 0) continue;
			// Pull a 30-char sample
			const sample = m.content_text?.slice(0, 30) ?? "";
			if (sample.length >= 10 && !assistantText.includes(sample)) {
				toolWasteBytes += resultLen;
			}
		}
	}

	// Retry detection
	let retryDetected = false;
	const seenTargets = new Set<string>();
	for (const c of toolCalls) {
		const key = buildToolCallKey(c.name, c.arguments);
		if (seenTargets.has(key)) {
			retryDetected = true;
			break;
		}
		seenTargets.add(key);
	}

	// Elapsed seconds
	let elapsedSeconds: number | null = null;
	if (user.timestamp && assistant?.timestamp) {
		const u = Date.parse(user.timestamp);
		const a = Date.parse(assistant.timestamp);
		if (!isNaN(u) && !isNaN(a)) elapsedSeconds = Math.max(0, (a - u) / 1000);
	}

	// Compaction boundary
	const isCompactionBoundary = intervening.some((m) => m.role === "compactionSummary") || assistant?.role === "compactionSummary";

	// Assistant meta
	const meta = parseMeta(assistant?.meta_json ?? null);
	const model = meta?.model ?? null;
	const stopReason = meta?.stop_reason ?? null;
	const inputTokens = meta?.usage?.input ?? null;
	const outputTokens = meta?.usage?.output ?? null;

	// Friction score
	const frictionScore = computeFrictionScore(config, {
		correctionDetected: correction !== null || repetition,
		toolFailureCount: failures.length,
		retryDetected,
		hasThinking: thinking != null && thinking.length > 0,
		isCompactionBoundary,
	});

	return {
		user_msg_length: userText?.length ?? 0,
		assistant_msg_length: assistantText?.length ?? 0,
		has_thinking: thinking != null && thinking.length > 0,
		thinking_length: thinking?.length ?? 0,
		correction_detected: correction !== null || repetition,
		correction_patterns: correctionPatterns,
		correction_type: correctionType,
		correction_text: correctionText,
		tool_call_count: toolCallCount,
		tool_names: toolNames,
		tool_failure_count: failures.length,
		tool_failure_details: toolFailureDetails,
		tool_waste_bytes: toolWasteBytes,
		retry_detected: retryDetected,
		elapsed_seconds: elapsedSeconds,
		friction_score: frictionScore,
		model,
		stop_reason: stopReason,
		usage_input_tokens: inputTokens,
		usage_output_tokens: outputTokens,
		is_compaction_boundary: isCompactionBoundary,
		user_index: userIndex,
		assistant_index: lastAssistantIndex,
	};
}

function findPriorUserIndex(messages: MessageRow[], before: number): number {
	for (let i = before - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") return i;
	}
	return -1;
}

export const turnPairCoreAnalyzer: Analyzer = {
	def: TURN_PAIR_CORE_DEF,
	version: TURN_PAIR_CORE_VERSION,
	prompts: TURN_PAIR_CORE_PROMPTS,
	defaultConfig: {
		id: "",  // resolved at registration
		analyzerId: TURN_PAIR_CORE_DEF.id,
		configJson: DEFAULT_TURN_PAIR_CORE_CONFIG as unknown as Record<string, unknown>,
		configHash: "",
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const units: AnalysisUnit[] = [];
		let i = 0;
		while (true) {
			const pair = findPair(ctx.messages, i);
			if (!pair) break;
			// Skip pairs with no assistant response — there's nothing
			// to measure until the assistant acts.
			if (!pair.assistant) break;

			const sources: SourceRef[] = [];
			for (let k = pair.userIndex; k <= pair.endIndex && k < ctx.messages.length; k++) {
				sources.push({ kind: "message", id: ctx.messages[k]!.id });
			}

			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "pair",
				anchorRef: pair.user.id,
				meta: { userIndex: pair.userIndex, endIndex: pair.endIndex },
			});

			i = pair.endIndex + 1;
		}
		return units;
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const userIndex = (unit.meta as { userIndex: number } | undefined)?.userIndex;
		const endIndex = (unit.meta as { endIndex: number } | undefined)?.endIndex;
		if (typeof userIndex !== "number" || typeof endIndex !== "number") {
			throw new Error("turn-pair-core: unit.meta missing userIndex/endIndex");
		}

		const config = (ctx.config.configJson as unknown as TurnPairCoreConfig) ?? DEFAULT_TURN_PAIR_CORE_CONFIG;

		// Reconstruct the in-pair messages by reading from the run
		// context's getMessage(). unit.sources is already in order
		// (built sequentially in plan()).
		const messages: MessageRow[] = [];
		for (const src of unit.sources) {
			if (src.kind !== "message") continue;
			const m = ctx.getMessage(src.id);
			if (m) messages.push(m);
		}

		const props = buildTurnPairNode(messages, 0, messages.length - 1, config);
		if (!props) throw new Error(`turn-pair-core: could not build node for unit at userIndex=${userIndex}`);

		const edges: AnalysisResult["edges"] = [];
		for (let k = 0; k < messages.length; k++) {
			edges.push({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: messages[k]!.id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: k,
			});
		}
		edges.push({
			toRefKind: REF_KINDS.SESSION,
			toRefId: ctx.run.session_id,
			edgeKind: EDGE_KINDS.ANCHORS,
			ordinal: 999,
		});

		return {
			contentJson: props as unknown as Record<string, unknown>,
			nodeKind: "metric",
			anchorKind: "pair",
			anchorRef: unit.anchorRef,
			edges,
		};
	},
};

// Re-exports for unit tests
export { DEFAULT_TURN_PAIR_CORE_CONFIG, computeFrictionScore } from "./config.js";
export {
	detectCorrection,
	detectAllCorrectionPatterns,
	detectRepetition,
	extractCorrectionText,
} from "./patterns.js";
export type { TurnPairCoreConfig } from "./config.js";
