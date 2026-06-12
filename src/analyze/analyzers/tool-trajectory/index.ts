/**
 * tool-trajectory — deterministic session-level tool-call trajectory analysis.
 *
 * Produces one `metric` node per session, containing all trajectory signals
 * (stuck-loops, polling-loops, oscillations, pre-flight gaps) detected in the
 * session's ordered tool-call stream. No LLM is used: all detectors are pure
 * functions operating on normalised tool-call representations.
 *
 * The analyzer depends on turn-pair-core (to consume its per-turn tool metadata)
 * and emits metric nodes that feed into the session-overview digest.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeSourceSetHash, computeConfigHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { TURN_PAIR_CORE_DEF } from "../turn-pair-core/index.js";
import { normalizeToolCall, type NormalizedToolCall } from "./arg-parser.js";
import { detectAllSignals, type TrajectorySignal, type ToolCallWithResult } from "./detectors.js";
import { DEFAULT_TOOL_TRAJECTORY_CONFIG, type ToolTrajectoryConfig } from "./config.js";

export const TOOL_TRAJECTORY_DEF: AnalyzerDef = {
	id: "tool-trajectory",
	label: "Tool-Call Trajectory (deterministic)",
	description:
		"Detects stuck-loops, polling-loops, oscillation, and pre-flight gaps in the ordered tool-call stream. No LLM.",
	anchorSpan: "full_session",
	dependencies: [TURN_PAIR_CORE_DEF.id],
};

export const TOOL_TRAJECTORY_VERSION: AnalyzerVersion = {
	analyzerId: TOOL_TRAJECTORY_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/tool-trajectory/index.ts",
};

export interface ToolTrajectoryProperties {
	/** Session id this analysis covers. */
	session_id: string;
	/** All trajectory signals detected. */
	signals: TrajectorySignal[];
	/** Aggregate friction contribution from trajectory signals. */
	trajectory_friction_score: number;
	/** Counts per pattern. */
	pattern_counts: Record<string, number>;
	/** Total number of tool calls analysed. */
	tool_call_count: number;
}

// ──────────────────────────── message parsing ────────────────────────────

interface ParsedToolCall {
	name: string;
	args: Record<string, unknown>;
	messageId: string;
}

interface ParsedToolResult {
	toolName: string;
	isError: boolean;
	textLength: number;
}

/**
 * Extract tool calls and results from the session's message stream.
 */
function extractToolCalls(messages: MessageRow[]): ToolCallWithResult[] {
	const calls: ParsedToolCall[] = [];
	const resultsByMsgId = new Map<string, ParsedToolResult[]>();

	for (const m of messages) {
		if (m.role === "assistant" && m.tool_calls) {
			try {
				const parsed = JSON.parse(m.tool_calls) as Array<{ name?: unknown; input?: unknown }>;
				for (const tc of parsed) {
					calls.push({
						name: typeof tc.name === "string" ? tc.name : "",
						args: tc.input && typeof tc.input === "object" ? tc.input as Record<string, unknown> : {},
						messageId: m.id,
					});
				}
			} catch {
				// skip malformed tool_calls
			}
		}
		if (m.role === "toolResult" && m.tool_results) {
			try {
				const parsed = JSON.parse(m.tool_results) as Array<{ toolName?: unknown; isError?: unknown; textLength?: unknown; toolCallId?: unknown }>;
				// Tool results are associated with the preceding assistant message;
				// we pair them by order since they follow the calls.
				for (const tr of parsed) {
					if (typeof tr.toolName === "string") {
						if (!resultsByMsgId.has(m.id)) {
							resultsByMsgId.set(m.id, []);
						}
						resultsByMsgId.get(m.id)!.push({
							toolName: tr.toolName,
							isError: Boolean(tr.isError),
							textLength: typeof tr.textLength === "number" ? tr.textLength : 0,
						});
					}
				}
			} catch {
				// skip malformed tool_results
			}
		}
	}

	// Normalise each call and pair with its result
	const normalized: NormalizedToolCall[] = calls.map((c) =>
		normalizeToolCall(c),
	);

	// Pair calls with their results. Tool results follow the assistant messages
	// that contained the calls, in order. We pair them sequentially.
	let resultIdx = 0;
	const allResults: ParsedToolResult[] = [];
	for (const [, results] of resultsByMsgId) {
		allResults.push(...results);
	}

	const withResults: ToolCallWithResult[] = normalized.map((nc, i) => {
		// Each call should have a corresponding result; if not, assume success
		const result = allResults[resultIdx];
		resultIdx++;
		return {
			call: nc,
			isError: result?.isError ?? false,
			resultMessageId: "",
		};
	});

	return withResults;
}

/**
 * Compute the trajectory friction score from detected signals.
 * Each signal pattern has a weight; the score is the sum of weights,
 * clamped to [0, 1].
 */
function computeTrajectoryFriction(
	signals: TrajectorySignal[],
	config: ToolTrajectoryConfig,
): number {
	let score = 0;
	for (const signal of signals) {
		switch (signal.pattern) {
			case "stuck-loop":
				score += config.stuckLoopWeight;
				break;
			case "polling-loop":
				score += config.pollingLoopWeight;
				break;
			case "oscillation":
				score += config.oscillationWeight;
				break;
			case "pre-flight-gap":
				score += config.preFlightGapWeight;
				break;
		}
	}
	return Math.max(0, Math.min(1, score));
}

// ──────────────────────────── analyzer ────────────────────────────

export const toolTrajectoryAnalyzer: Analyzer = {
	def: TOOL_TRAJECTORY_DEF,
	version: TOOL_TRAJECTORY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TOOL_TRAJECTORY_DEF.id,
		configHash: computeConfigHash(DEFAULT_TOOL_TRAJECTORY_CONFIG),
		configJson: DEFAULT_TOOL_TRAJECTORY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// One unit per session, consuming turn-pair-core nodes.
		const coreNodes = ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? [];
		if (coreNodes.length === 0 && ctx.messages.length === 0) return [];

		const sources: SourceRef[] = [
			...coreNodes.map((n) => ({ kind: "analysis_node" as const, id: n.output_key })),
		];
		// Also anchor to the session itself
		return [
			{
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): AnalysisResult {
		const config = (ctx.config.configJson as unknown as ToolTrajectoryConfig) ?? DEFAULT_TOOL_TRAJECTORY_CONFIG;
		const messages = ctx.getSessionMessages(ctx.sessionId);
		const toolCalls = extractToolCalls(messages);

		const signals = detectAllSignals(toolCalls, {
			stuckLoopMin: config.stuckLoopMin,
			pollingLoopMin: config.pollingLoopMin,
			oscillationWindow: config.oscillationWindow,
		});

		const trajectoryFriction = computeTrajectoryFriction(signals, config);

		const patternCounts: Record<string, number> = {};
		for (const s of signals) {
			patternCounts[s.pattern] = (patternCounts[s.pattern] ?? 0) + 1;
		}

		const properties: ToolTrajectoryProperties = {
			session_id: ctx.sessionId,
			signals,
			trajectory_friction_score: trajectoryFriction,
			pattern_counts: patternCounts,
			tool_call_count: toolCalls.length,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		let ordinal = 1;
		// Consume turn-pair-core nodes
		const coreNodes = ctx.getDependencyNodes(TURN_PAIR_CORE_DEF.id);
		for (const n of coreNodes) {
			edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: n.id, edgeKind: EDGE_KINDS.CONSUMES, ordinal: ordinal++ });
		}

		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};