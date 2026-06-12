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
	text: string;
	totalChars: number;
	pairCount: number;
	frictionCount: number;
	compactionCount: number;
	correctionCount: number;
	toolFailureCount: number;
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

/** Max length for a user-text snippet included in the per-pair digest line. */
const USER_TEXT_SNIPPET_MAX = 200;

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

	// Map message id → user text, so every pair can include a verbatim snippet
	// (not just pairs where the regex matched). This un-gates the synthesizer
	// from the deterministic correction regex: the regex is a ranking signal only.
	const userTextById = new Map<string, string>();
	for (const m of input.messages) {
		if (m.role === "user" && m.content_text) {
			userTextById.set(m.id, m.content_text);
		}
	}

	const compactions = input.messages
		.filter((m) => m.role === "compactionSummary" || m.role === "branch_summary")
		.map((m) => (m.content_text ?? "").trim())
		.filter((t) => t.length > 0);

	const frictionCount = core.filter((p) => p.high_signal).length;
	const correctionCount = core.filter((p) => p.correction_detected).length;
	const toolFailureCount = core.reduce((sum, p) => sum + p.tool_failure_count, 0);

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
		// Un-gate: include a user-text snippet for every pair, not just regex-matched ones.
		// The correction regex is a ranking signal only; the synthesizer must see all text.
		const userText = userTextById.get(p.user_message_id);
		if (userText) {
			bits.push(`text="${truncateLine(userText, USER_TEXT_SNIPPET_MAX)}"`);
		}
		return bits.join(" ");
	});

	const headerLines = [
		`## Session ${input.sessionId}`,
		`pairs=${core.length} high_signal=${frictionCount} corrections=${correctionCount} tool_failures=${toolFailureCount}`,
	];
	if (compactions.length > 0) {
		headerLines.push("", "### Compaction summaries (verbatim)");
		for (const c of compactions) headerLines.push(c.slice(0, 2000));
	}
	const header = headerLines.join("\n");

	const text = [header, "", "### Per-pair signals", ...perPairLines].join("\n");

	return {
		header,
		perPairLines,
		text,
		totalChars: text.length,
		pairCount: core.length,
		frictionCount,
		compactionCount: compactions.length,
		correctionCount,
		toolFailureCount,
	};
}

/** Truncate a line to maxLen characters, replacing newlines with spaces. */
function truncateLine(s: string, maxLen: number): string {
	const flat = s.replace(/\n/g, " ");
	return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
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
