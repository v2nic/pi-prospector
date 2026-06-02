/**
 * Map-phase prompt: given a session digest segment, produce a
 * segment-level summary with the same shape used by the reduce
 * phase.
 */

export const SESSION_OVERVIEW_MAP_PROMPT = `You are summarizing a SEGMENT of an AI coding agent session. The segment below is a structured digest of user messages, agent responses, tool calls, and friction signals.

Produce a JSON object summarizing this segment:

{
  "segment_summary": "2–3 sentence summary of what the user was trying to accomplish and the agent's overall performance in this segment",
  "key_friction_points": [
    {
      "description": "short noun phrase",
      "severity": "low" | "medium" | "high",
      "evidence_pair_index": integer
    }
  ],
  "improvement_proposals": [
    {
      "target_type": "agents_md" | "system_md" | "skill" | "extension_prompt" | "tool_output" | "repo_doc" | "config",
      "target_path": "path to the file or config that should change",
      "title": "short imperative title",
      "summary": "one-line description",
      "detail": "2–3 sentence proposed change",
      "evidence": "the pair excerpt that triggered this",
      "confidence": 0.0-1.0,
      "severity": "friction" | "correction" | "waste" | "suggestion" | "insight"
    }
  ],
  "sentiment_arc": [
    { "segment": 0, "sentiment": "positive" | "neutral" | "negative" | "frustrated", "key_event": "short phrase" }
  ]
}

Rules:
- Only propose changes that are clearly supported by the digest.
- Be specific. "Be more careful" is bad; "When the user says pnpm, do not run npm" is good.
- Confidence 0.0–1.0 reflects how strongly the digest supports the proposal.
- severity values: friction (user struggled), correction (user explicitly corrected), waste (tool calls or context that didn't help), suggestion (opportunity to improve), insight (observation, not an action item).

Return JSON only. No markdown fences, no prose.

Segment digest:
"""
{digest}
"""`;

export function buildMapPrompt(digest: string): string {
	return SESSION_OVERVIEW_MAP_PROMPT.replace("{digest}", digest);
}

const VALID_TARGET_TYPES = new Set([
	"agents_md", "system_md", "skill", "extension_prompt", "tool_output", "repo_doc", "config",
]);
const VALID_SEVERITIES = new Set(["friction", "correction", "waste", "suggestion", "insight"]);

export interface MapSummary {
	segment_summary: string;
	key_friction_points: Array<{ description: string; severity: "low" | "medium" | "high"; evidence_pair_index: number }>;
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

export function parseMapResponse(text: string): MapSummary {
	const empty: MapSummary = {
		segment_summary: "",
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
			segment_summary: typeof o.segment_summary === "string" ? o.segment_summary : "",
			key_friction_points: Array.isArray(o.key_friction_points)
				? (o.key_friction_points as Array<Record<string, unknown>>).map((p) => ({
					description: String(p.description ?? ""),
					severity: ["low", "medium", "high"].includes(p.severity as string) ? (p.severity as "low" | "medium" | "high") : "medium",
					evidence_pair_index: typeof p.evidence_pair_index === "number" ? p.evidence_pair_index : 0,
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
