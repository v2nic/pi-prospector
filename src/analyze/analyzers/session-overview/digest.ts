/**
 * Build a structured session digest from turn-pair nodes and
 * raw messages. The digest is what the LLM sees, so its shape
 * matters: a markdown summary that highlights friction points,
 * corrections, and tool failures, while keeping tool-result
 * details verbatim only for high-signal events.
 */

import type { AnalysisNodeRow, MessageRow } from "../../types.js";

export interface DigestSegment {
	index: number;
	text: string;
	charCount: number;
}

export interface DigestResult {
	segments: DigestSegment[];
	totalChars: number;
	pairCount: number;
	frictionCount: number;
	compactionCount: number;
}

interface TurnPairCoreProps {
	correction_detected: boolean;
	friction_score: number;
	tool_failure_count: number;
	tool_waste_bytes: number;
	correction_type: "explicit" | "implicit" | "repetition" | null;
	correction_text: string | null;
	tool_names: string[];
	elapsed_seconds: number | null;
	model: string | null;
}

interface TurnPairLlmProps {
	sentiment: string;
	frustration_level: number;
	quality_score: number;
	friction_cause: string | null;
	friction_summary: string | null;
	user_intent: string;
	[key: string]: unknown;
}

function safeParse<T>(s: string | null): T | null {
	if (!s) return null;
	try { return JSON.parse(s) as T; } catch { return null; }
}

/**
 * Group messages by their position relative to the most recent
 * compaction summary. Each group becomes a "phase" of the
 * session. Phases before compaction are summarized from the
 * compaction text; phases after are detailed.
 */
function groupMessagesByCompaction(messages: MessageRow[]): Array<{ phase: string; messages: MessageRow[] }> {
	const phases: Array<{ phase: string; messages: MessageRow[] }> = [];
	let current: { phase: string; messages: MessageRow[] } = { phase: "initial", messages: [] };
	let compactionIndex = 0;
	for (const m of messages) {
		if (m.role === "compactionSummary") {
			phases.push(current);
			compactionIndex++;
			current = { phase: `post-compaction-${compactionIndex}`, messages: [] };
			continue;
		}
		current.messages.push(m);
	}
	if (current.messages.length > 0 || phases.length === 0) phases.push(current);
	return phases;
}

function formatPairRow(idx: number, props: TurnPairCoreProps, llm?: TurnPairLlmProps | null): string {
	const sentiment = llm?.sentiment ?? "—";
	const cause = llm?.friction_cause ?? "—";
	const elapsed = props.elapsed_seconds != null ? `${props.elapsed_seconds.toFixed(1)}s` : "—";
	const tools = props.tool_names.length > 0 ? props.tool_names.join(",") : "—";
	const corr = props.correction_type ?? "—";
	return `| ${idx} | ${elapsed} | ${sentiment} | ${props.friction_score.toFixed(2)} | ${corr} | ${props.tool_failure_count} | ${tools} | ${cause} |`;
}

function formatStatBlock(stats: {
	totalPairs: number;
	frictionPairs: number;
	correctionRate: number;
	toolFailures: number;
	toolWaste: number;
	durationSec: number | null;
}): string {
	const dur = stats.durationSec != null ? `${stats.durationSec.toFixed(0)}s` : "—";
	return [
		"### Statistics",
		`- Total pairs: ${stats.totalPairs}`,
		`- Friction pairs (score >= 0.4): ${stats.frictionPairs}`,
		`- Correction rate: ${(stats.correctionRate * 100).toFixed(0)}%`,
		`- Tool failures: ${stats.toolFailures}`,
		`- Tool waste (bytes never referenced): ${stats.toolWaste}`,
		`- Session duration: ${dur}`,
	].join("\n");
}

/**
 * Build the digest from pair nodes and the messages they cover.
 *
 * Pair nodes MUST be sorted in chronological order. The matching
 * messages are read from the framework's edge table; we get them
 * passed in already-resolved.
 */
export function buildDigest(args: {
	sessionId: string;
	messages: MessageRow[];
	pairNodes: AnalysisNodeRow[];
	llmNodes: AnalysisNodeRow[];
}): DigestResult {
	const pairProps: TurnPairCoreProps[] = args.pairNodes.map((n) => safeParse<TurnPairCoreProps>(n.content_json) ?? ({} as TurnPairCoreProps));
	const llmPropsByAnchor = new Map<string, TurnPairLlmProps>();
	for (const n of args.llmNodes) {
		const p = safeParse<TurnPairLlmProps>(n.content_json);
		if (p) {
			llmPropsByAnchor.set(n.id, p);
		}
	}

	const phases = groupMessagesByCompaction(args.messages);
	const compactions = args.messages.filter((m) => m.role === "compactionSummary");

	// Compute aggregate stats from pair props
	const totalPairs = pairProps.length;
	const frictionPairs = pairProps.filter((p) => p.friction_score >= 0.4).length;
	const correctionCount = pairProps.filter((p) => p.correction_detected).length;
	const toolFailures = pairProps.reduce((s, p) => s + p.tool_failure_count, 0);
	const toolWaste = pairProps.reduce((s, p) => s + p.tool_waste_bytes, 0);
	const firstTs = args.messages[0]?.timestamp;
	const lastTs = args.messages[args.messages.length - 1]?.timestamp;
	const durationSec = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : null;

	// Per-phase digests
	const phaseTexts: string[] = [];
	phaseTexts.push(`## Session Overview`);
	phaseTexts.push(`Session ID: ${args.sessionId}`);
	phaseTexts.push(`Messages: ${args.messages.length}, Pairs: ${totalPairs}, Compactions: ${compactions.length}\n`);

	for (let pi = 0; pi < phases.length; pi++) {
		const phase = phases[pi]!;
		phaseTexts.push(`### Phase ${pi + 1} (${phase.phase})`);
		if (pi > 0 && compactions[pi - 1]) {
			phaseTexts.push("**Compaction summary (verbatim):**");
			phaseTexts.push(compactions[pi - 1]!.content_text ?? "(empty)");
			phaseTexts.push("");
		}
		phaseTexts.push("**Per-pair (chronological):**");
		phaseTexts.push("| # | Elapsed | Sentiment | Friction | Correction | ToolFailures | Tools | Cause |");
		phaseTexts.push("|---|---------|-----------|----------|------------|--------------|-------|-------|");
		// For each pair node, format a row. The pair node IDs match the
		// sequence in pairProps. We look up the matching LLM node by id.
		for (let i = 0; i < pairProps.length; i++) {
			const p = pairProps[i]!;
			const node = args.pairNodes[i]!;
			const llm = llmPropsByAnchor.get(node.id) ?? null;
			phaseTexts.push(formatPairRow(i + 1, p, llm));
		}
		phaseTexts.push("");
	}

	phaseTexts.push(formatStatBlock({
		totalPairs,
		frictionPairs,
		correctionRate: totalPairs > 0 ? correctionCount / totalPairs : 0,
		toolFailures,
		toolWaste,
		durationSec,
	}));

	const fullText = phaseTexts.join("\n");
	return {
		segments: [{ index: 0, text: fullText, charCount: fullText.length }],
		totalChars: fullText.length,
		pairCount: totalPairs,
		frictionCount: frictionPairs,
		compactionCount: compactions.length,
	};
}

/**
 * Split a digest into multiple segments of approximately equal
 * character count, with each segment self-contained (header +
 * portion of pairs + footer). Used when the digest exceeds the
 * model's context budget.
 */
export function splitDigest(digest: DigestResult, segmentChars: number): DigestSegment[] {
	if (digest.totalChars <= segmentChars) return digest.segments;
	// Simple split: chunk the text evenly, preserving header lines.
	const text = digest.segments[0]?.text ?? "";
	const lines = text.split("\n");
	const out: DigestSegment[] = [];
	let buf: string[] = [];
	let bufChars = 0;
	for (const line of lines) {
		if (bufChars + line.length > segmentChars && buf.length > 0) {
			out.push({ index: out.length, text: buf.join("\n"), charCount: bufChars });
			buf = [];
			bufChars = 0;
		}
		buf.push(line);
		bufChars += line.length + 1;
	}
	if (buf.length > 0) out.push({ index: out.length, text: buf.join("\n"), charCount: bufChars });
	return out;
}
