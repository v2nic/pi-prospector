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
import type { ToolTrajectoryProperties } from "../tool-trajectory/index.js";

export interface DigestSegment {
	index: number;
	text: string;
}

export interface SessionDigest {
	header: string;
	perPairLines: string[];
	trajectoryLines: string[];
	text: string;
	totalChars: number;
	pairCount: number;
	frictionCount: number;
	compactionCount: number;
	correctionCount: number;
	toolFailureCount: number;
	trajectorySignalCount: number;
}

export interface BuildDigestInput {
	sessionId: string;
	messages: MessageRow[];
	coreNodes: AnalysisNodeRow[];
	llmNodes: AnalysisNodeRow[];
	trajectoryNodes: AnalysisNodeRow[];
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

	// Parse trajectory signal nodes
	const trajectory = input.trajectoryNodes
		.map((n) => safeParse<ToolTrajectoryProperties>(n.content_json))
		.filter((p): p is ToolTrajectoryProperties => p !== null);

	const compactions = input.messages
		.filter((m) => m.role === "compactionSummary" || m.role === "branch_summary")
		.map((m) => (m.content_text ?? "").trim())
		.filter((t) => t.length > 0);

	const frictionCount = core.filter((p) => p.high_signal).length;
	const correctionCount = core.filter((p) => p.correction_detected).length;
	const toolFailureCount = core.reduce((sum, p) => sum + p.tool_failure_count, 0);
	const trajectorySignalCount = trajectory.reduce((sum, t) => sum + (t.signals?.length ?? 0), 0);

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

	// Build trajectory signal lines
	const trajectoryLines = trajectory.flatMap((t) =>
		(t.signals ?? []).map((s) =>
			`trajectory:${s.pattern} tool=${s.tool} count=${s.count} ${s.description}`,
		),
	);

	const headerLines = [
		`## Session ${input.sessionId}`,
		`pairs=${core.length} high_signal=${frictionCount} corrections=${correctionCount} tool_failures=${toolFailureCount} trajectory_signals=${trajectorySignalCount}`,
	];
	if (trajectory.length > 0) {
		headerLines.push(`trajectory_friction=${trajectory.reduce((max, t) => Math.max(max, t.trajectory_friction_score ?? 0), 0).toFixed(2)}`);
	}
	if (compactions.length > 0) {
		headerLines.push("", "### Compaction summaries (verbatim)");
		for (const c of compactions) headerLines.push(c.slice(0, 2000));
	}
	const header = headerLines.join("\n");

	const parts = [header, "", "### Per-pair signals", ...perPairLines];
	if (trajectoryLines.length > 0) {
		parts.push("", "### Trajectory signals", ...trajectoryLines);
	}
	const text = parts.join("\n");

	return {
		header,
		perPairLines,
		trajectoryLines,
		text,
		totalChars: text.length,
		pairCount: core.length,
		frictionCount,
		compactionCount: compactions.length,
		correctionCount,
		toolFailureCount,
		trajectorySignalCount,
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

	const trajectorySection = digest.trajectoryLines.length > 0
		? ["", "### Trajectory signals", ...digest.trajectoryLines]
		: [];

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

	// Append trajectory section to the last segment if it fits, or create a new segment
	if (trajectorySection.length > 0) {
		const trajText = trajectorySection.join("\n");
		if (segments.length > 0 && (segments[segments.length - 1]!.text.length + trajText.length) <= segmentChars) {
			segments[segments.length - 1]!.text += "\n" + trajText;
		} else {
			segments.push({
				index: segments.length,
				text: [digest.header, ...trajectorySection].join("\n"),
			});
		}
	}

	return segments;
}
