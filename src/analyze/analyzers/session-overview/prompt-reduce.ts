/**
 * Reduce-phase prompt: given a list of segment summaries
 * (from the map phase) plus the deterministic stats, produce a
 * final session-level analysis with materialized proposals.
 */

export const SESSION_OVERVIEW_REDUCE_PROMPT = `You are producing the FINAL session-level analysis for an AI coding agent session. You will receive a list of per-segment summaries from a previous pass, plus deterministic session statistics.

Combine the per-segment summaries into a single session-level analysis. De-duplicate proposals that recur across segments — keep the strongest instance. Return JSON only.

Schema (return exactly this shape):
{
  "session_summary": "3–6 sentence summary of the entire session",
  "key_friction_points": [
    {
      "description": "short noun phrase",
      "pair_node_id": "id of the originating pair node (use the IDs from the segment summaries if available, else 'unknown')",
      "severity": "low" | "medium" | "high"
    }
  ],
  "improvement_proposals": [
    {
      "target_type": "agents_md" | "system_md" | "skill" | "extension_prompt" | "tool_output" | "repo_doc" | "config",
      "target_path": "path to the file or config that should change",
      "title": "short imperative title",
      "summary": "one-line description",
      "detail": "2–3 sentence proposed change",
      "evidence": "the conversation excerpt that triggered this",
      "confidence": 0.0-1.0,
      "severity": "friction" | "correction" | "waste" | "suggestion" | "insight"
    }
  ],
  "sentiment_arc": [
    { "segment": integer, "sentiment": "positive" | "neutral" | "negative" | "frustrated", "key_event": "short phrase" }
  ]
}

Rules:
- De-duplicate: if two segments propose the same change, keep the one with higher confidence.
- Be conservative. A session that ran smoothly may produce zero proposals.
- Each proposal must point at a concrete, actionable file or config change.
- Confidence reflects how strongly the evidence supports the proposal.

Per-segment summaries:
"""
{segment_summaries}
"""

Deterministic session statistics:
"""
{stats}
"""

Return JSON only. No markdown fences, no prose.`;

export function buildReducePrompt(args: {
	segmentSummaries: string;
	stats: string;
}): string {
	return SESSION_OVERVIEW_REDUCE_PROMPT
		.replace("{segment_summaries}", args.segmentSummaries)
		.replace("{stats}", args.stats);
}

const VALID_TARGET_TYPES = new Set([
	"agents_md", "system_md", "skill", "extension_prompt", "tool_output", "repo_doc", "config",
]);
const VALID_SEVERITIES = new Set(["friction", "correction", "waste", "suggestion", "insight"]);

export interface SessionOverviewProperties {
	session_summary: string;
	key_friction_points: Array<{ description: string; pair_node_id: string; severity: "low" | "medium" | "high" }>;
	improvement_proposals: Array<{
		target_type: string;
		target_path: string;
		title: string;
		summary: string;
		detail: string;
		evidence: string;
		confidence: number;
		severity: string;
	}>;
	sentiment_arc: Array<{ segment: number; sentiment: string; key_event: string }>;
}

export function parseReduceResponse(text: string): SessionOverviewProperties {
	const empty: SessionOverviewProperties = {
		session_summary: "",
		key_friction_points: [],
		improvement_proposals: [],
		sentiment_arc: [],
	};
	try {
		const t = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
		const obj = JSON.parse(t);
		if (!obj || typeof obj !== "object") return empty;
		const o = obj as Record<string, unknown>;
		return {
			session_summary: typeof o.session_summary === "string" ? o.session_summary : "",
			key_friction_points: Array.isArray(o.key_friction_points)
				? (o.key_friction_points as Array<Record<string, unknown>>).map((p) => ({
					description: String(p.description ?? ""),
					pair_node_id: String(p.pair_node_id ?? "unknown"),
					severity: ["low", "medium", "high"].includes(p.severity as string) ? (p.severity as "low" | "medium" | "high") : "medium",
				}))
				: [],
			improvement_proposals: Array.isArray(o.improvement_proposals)
				? (o.improvement_proposals as Array<Record<string, unknown>>).map((p) => ({
					target_type: VALID_TARGET_TYPES.has(p.target_type as string) ? (p.target_type as string) : "repo_doc",
					target_path: String(p.target_path ?? ""),
					title: String(p.title ?? ""),
					summary: String(p.summary ?? ""),
					detail: String(p.detail ?? ""),
					evidence: String(p.evidence ?? ""),
					confidence: typeof p.confidence === "number" ? p.confidence : 0.5,
					severity: VALID_SEVERITIES.has(p.severity as string) ? (p.severity as string) : "suggestion",
				}))
				: [],
			sentiment_arc: Array.isArray(o.sentiment_arc)
				? (o.sentiment_arc as Array<Record<string, unknown>>).map((s) => ({
					segment: typeof s.segment === "number" ? s.segment : 0,
					sentiment: String(s.sentiment ?? "neutral"),
					key_event: String(s.key_event ?? ""),
				}))
				: [],
		};
	} catch {
		return empty;
	}
}
