/**
 * Structured session digest for the session-overview analyzer.
 *
 * Rather than truncating raw transcript, we build a compact digest from the
 * deterministic per-pair metrics, the LLM classifications, any compaction
 * summaries, and aggregate statistics. Large sessions are split into segments
 * for a map-reduce summarisation.
 */

import type { AnalysisNodeRow, MessageRow } from "../../types.js";
import type { TurnPairCoreProperties } from "../turn-pair-core/index.js";
import type { TurnPairLLMProperties } from "../turn-pair-llm/prompt.js";

export interface DigestSegment {
	index: number;
	text: string;
}

export interface SessionDigest {
	header: string;
	perPairLines: string[];
	positiveSignals: string[];
	text: string;
	totalChars: number;
	pairCount: number;
	frictionCount: number;
	compactionCount: number;
	correctionCount: number;
	toolFailureCount: number;
	/** True when the session had at least one correction followed by a clean (no-friction) pair — a "good pivot". */
	cleanRecovery: boolean;
	/** True when the session completed all turns without any correction or high-signal friction. */
	taskCompletedWithoutCorrection: boolean;
	/** True when fewer than half the turns had a tool failure (density check). */
	lowToolFailureDensity: boolean;
}

export interface BuildDigestInput {
	sessionId: string;
	messages: MessageRow[];
	coreNodes: AnalysisNodeRow[];
	llmNodes: AnalysisNodeRow[];
}

function safeParse<T>(json: string): T | null {
	try {
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

export function buildDigest(input: BuildDigestInput): SessionDigest {
	const core = input.coreNodes
		.map((n) => safeParse<TurnPairCoreProperties>(n.content_json))
		.filter((p): p is TurnPairCoreProperties => p !== null)
		.sort((a, b) => a.pair_index - b.pair_index);

	// Map user_message_id → llm classification. turn-pair-llm records the anchor
	// user-message id in its content, so we merge enrichment by id (not by order).
	const llmByUser = new Map<string, TurnPairLLMProperties>();
	for (const node of input.llmNodes) {
		const props = safeParse<TurnPairLLMProperties>(node.content_json);
		if (props && props.user_message_id) llmByUser.set(props.user_message_id, props);
	}

	const compactions = input.messages
		.filter((m) => m.role === "compactionSummary" || m.role === "branch_summary")
		.map((m) => (m.content_text ?? "").trim())
		.filter((t) => t.length > 0);

	const frictionCount = core.filter((p) => p.high_signal).length;
	const correctionCount = core.filter((p) => p.correction_detected).length;
	const toolFailureCount = core.reduce((sum, p) => sum + p.tool_failure_count, 0);

	// ── Positive signals ──────────────────────────────────────────────────
	// task-completed-without-correction: zero corrections across all pairs.
	const taskCompletedWithoutCorrection = core.length > 0 && correctionCount === 0;

	// correction-then-clean-recovery: at least one correction followed by a
	// clean (low-friction, no correction) pair — the agent recovered gracefully.
	let cleanRecovery = false;
	for (let i = 0; i < core.length - 1; i++) {
		if (core[i]!.correction_detected) {
			const next = core[i + 1]!;
			if (!next.correction_detected && !next.high_signal) {
				cleanRecovery = true;
				break;
			}
		}
	}

	// low tool-failure density: fewer than half the pairs have a tool failure.
	const pairsWithToolFailure = core.filter((p) => p.tool_failure_count > 0).length;
	const lowToolFailureDensity = core.length > 0 && pairsWithToolFailure < core.length / 2;

	const positiveSignals: string[] = [];
	if (taskCompletedWithoutCorrection) positiveSignals.push("task-completed-without-correction");
	if (cleanRecovery) positiveSignals.push("correction-then-clean-recovery");
	if (lowToolFailureDensity) positiveSignals.push("low-tool-failure-density");

	const perPairLines = core.map((p) => {
		const llm = llmByUser.get(p.user_message_id);
		const bits = [
			`#${p.pair_index}`,
			`friction=${p.friction_score.toFixed(2)}`,
			p.correction_detected ? `correction=${p.correction_type}` : "correction=none",
			`tool_fail=${p.tool_failure_count}`,
		];
		if (llm) bits.push(`sentiment=${llm.sentiment}`, `type=${llm.friction_type}`, `sev=${llm.severity}`);
		if (p.correction_text) bits.push(`note="${p.correction_text.slice(0, 120)}"`);
		return bits.join(" ");
	});

	const headerLines = [
		`## Session ${input.sessionId}`,
		`pairs=${core.length} high_signal=${frictionCount} corrections=${correctionCount} tool_failures=${toolFailureCount}`,
	];
	if (positiveSignals.length > 0) {
		headerLines.push(`positive_signals=${positiveSignals.join(",")}`);
	}
	if (compactions.length > 0) {
		headerLines.push("", "### Compaction summaries (verbatim)");
		for (const c of compactions) headerLines.push(c.slice(0, 2000));
	}
	const header = headerLines.join("\n");

	const sections = [header, "", "### Per-pair signals", ...perPairLines];
	if (positiveSignals.length > 0) {
		sections.push("", "### Positive signals", ...positiveSignals.map((s) => `- ${s}`));
	}
	const text = sections.join("\n");

	return {
		header,
		perPairLines,
		positiveSignals,
		text,
		totalChars: text.length,
		pairCount: core.length,
		frictionCount,
		compactionCount: compactions.length,
		correctionCount,
		toolFailureCount,
		cleanRecovery,
		taskCompletedWithoutCorrection,
		lowToolFailureDensity,
	};
}

/**
 * Split a digest's per-pair body into segments no larger than `segmentChars`,
 * each prefixed with the shared header. Returns at least one segment.
 */
export function splitDigest(digest: SessionDigest, segmentChars: number): DigestSegment[] {
	if (digest.totalChars <= segmentChars || digest.perPairLines.length === 0) {
		return [{ index: 0, text: digest.text }];
	}

	const segments: DigestSegment[] = [];
	let buffer: string[] = [];
	let bufferLen = digest.header.length;

	const flush = (): void => {
		if (buffer.length === 0) return;
		segments.push({
			index: segments.length,
			text: [digest.header, "", "### Per-pair signals", ...buffer].join("\n"),
		});
		buffer = [];
		bufferLen = digest.header.length;
	};

	for (const line of digest.perPairLines) {
		if (bufferLen + line.length > segmentChars && buffer.length > 0) flush();
		buffer.push(line);
		bufferLen += line.length + 1;
	}
	flush();

	return segments;
}
