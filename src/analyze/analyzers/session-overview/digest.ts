/**
 * Build a structured session digest from turn-pair-core and turn-pair-llm nodes.
 */

import type { AnalysisNodeRow, TurnPairCoreProperties, TurnPairLLMProperties } from "../../types.js";

export interface DigestOptions {
	sessionProject: string;
	sessionStartedAt: string;
	sessionDurationSeconds: number | null;
	totalMessages: number;
	totalPairs: number;
}

export interface StructuredDigest {
	markdown: string;
	totalPairs: number;
	frictionPairs: number;
	correctionCount: number;
	avgQualityScore: number | null;
	dominantFrictionType: string | null;
	toolFailureRate: number;
	totalToolWasteBytes: number;
	sessionDurationSeconds: number | null;
}

export function buildStructuredDigest(
	pairNodes: AnalysisNodeRow[], llmNodes: AnalysisNodeRow[],
	compactionSummaries: Array<{ timestamp: string | null; text: string }>,
	postCompactionMessages: Array<{ role: string; content_text: string | null; timestamp: string | null }>,
	options: DigestOptions,
): StructuredDigest {
	let frictionPairs = 0;
	let correctionCount = 0;
	let totalToolFailures = 0;
	let totalToolCalls = 0;
	let totalToolWasteBytes = 0;
	const dominantFriction: Map<string, number> = new Map();
	const pairRows: Array<{ index: number; time: string; sentiment: string; friction: string; correction: string; tools: string }> = [];

	for (let i = 0; i < pairNodes.length; i++) {
		let metrics: TurnPairCoreProperties;
		try { metrics = JSON.parse(pairNodes[i]!.content_json) as TurnPairCoreProperties; } catch { continue; }
		totalToolCalls += metrics.tool_call_count;
		totalToolFailures += metrics.tool_failure_count;
		totalToolWasteBytes += metrics.tool_waste_bytes;
		if (metrics.friction_score >= 0.4) frictionPairs++;
		if (metrics.correction_detected) { correctionCount++; if (metrics.correction_type) dominantFriction.set(metrics.correction_type, (dominantFriction.get(metrics.correction_type) ?? 0) + 1); }
		let sentiment = "—";
		let llmNode: AnalysisNodeRow | null = null;
		// Find matching LLM node
		for (const ln of llmNodes) {
			// Simple heuristic: LLM nodes that refine/core nodes from same session
			if (ln.session_id === pairNodes[i]!.session_id || true) { llmNode = ln; break; }
		}
		if (llmNode) { try { const llmProps = JSON.parse(llmNode.content_json) as TurnPairLLMProperties; sentiment = llmProps.sentiment; } catch { /* keep default */ } }
		pairRows.push({
			index: i + 1,
			time: metrics.elapsed_seconds !== null ? `${Math.round(metrics.elapsed_seconds)}s` : "—",
			sentiment,
			friction: metrics.friction_score >= 0.4 ? String(metrics.friction_score.toFixed(2)) : "—",
			correction: metrics.correction_detected ? (metrics.correction_type ?? "yes") : "—",
			tools: metrics.tool_names.length > 0 ? metrics.tool_names.join(", ") : "—",
		});
	}

	let dominantFrictionType: string | null = null;
	let maxCount = 0;
	for (const [type, count] of dominantFriction) { if (count > maxCount) { maxCount = count; dominantFrictionType = type; } }

	let qualitySum = 0; let qualityCount = 0;
	for (const ln of llmNodes) { try { const props = JSON.parse(ln.content_json) as TurnPairLLMProperties; qualitySum += props.quality_score; qualityCount++; } catch { /* skip */ } }
	const avgQualityScore = qualityCount > 0 ? qualitySum / qualityCount : null;
	const toolFailureRate = totalToolCalls > 0 ? totalToolFailures / totalToolCalls : 0;

	let md = "";
	md += `## Session: ${options.sessionProject}, ${options.sessionStartedAt}`;
	if (options.sessionDurationSeconds !== null) md += `, ${Math.round(options.sessionDurationSeconds / 60)} min`;
	md += `, ${options.totalPairs} pairs\n\n`;

	if (compactionSummaries.length > 0) {
		md += `### Compaction Summary (verbatim from session)\n`;
		for (const cs of compactionSummaries) md += `${cs.text}\n`;
		md += "\n";
	}

	md += `### Per-Pair Summary (from turn-pair-core nodes)\n`;
	md += `| # | Time | Sentiment | Friction | Correction | Tools |\n`;
	md += `|---|------|-----------|----------|------------|-------|\n`;
	for (const row of pairRows) md += `| ${row.index} | ${row.time} | ${row.sentiment} | ${row.friction} | ${row.correction} | ${row.tools} |\n`;
	md += "\n";

	if (postCompactionMessages.length > 0) {
		md += `### Key Events (post-compaction messages, full detail)\n`;
		for (const msg of postCompactionMessages.slice(0, 10)) {
			const timestamp = msg.timestamp ? `[${new Date(msg.timestamp).toLocaleTimeString()}]` : "";
			const role = msg.role === "user" ? "USER" : "AGENT";
			const text = (msg.content_text ?? "").slice(0, 200);
			md += `${timestamp} ${role}: "${text}"\n`;
		}
		md += "\n";
	}

	md += `### Statistics (deterministic, from turn-pair aggregation)\n`;
	md += `- Total pairs: ${options.totalPairs}, friction pairs: ${frictionPairs}, correction rate: ${options.totalPairs > 0 ? (correctionCount / options.totalPairs).toFixed(2) : "0"}\n`;
	md += `- Tool failures: ${totalToolFailures}, tool failure rate: ${toolFailureRate.toFixed(2)}\n`;
	md += `- Tool waste: ${totalToolWasteBytes} bytes total\n`;

	return { markdown: md, totalPairs: options.totalPairs, frictionPairs, correctionCount, avgQualityScore, dominantFrictionType, toolFailureRate, totalToolWasteBytes, sessionDurationSeconds: options.sessionDurationSeconds };
}