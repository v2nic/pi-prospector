/**
 * Reduce-phase prompt: turn a session digest (or merged segment summaries plus
 * aggregate stats) into a session summary and a set of improvement proposals.
 */

import { shortHash } from "../../input-hash.js";

export const REDUCE_PROMPT = `You analyse a coding-agent session and propose concrete improvements to the
user's configuration, prompts, skills, or workflow. You do NOT make changes.

The digest includes both friction signals and **positive signals** (things that
went well). Use success/failure contrast: compare what went right against what
went wrong. When a session is smooth, focus on reinforcement — capturing what
worked so it can be encoded into standing instructions.

Return ONLY a JSON object with exactly these fields:
{
  "session_summary": "3-5 sentences summarising the session, its friction, and its strengths",
  "key_friction_points": [
    { "description": "what went wrong", "severity": "low" | "medium" | "high" }
  ],
  "key_positive_signals": [
    { "description": "what went well", "signal": "task-completed-without-correction" | "correction-then-clean-recovery" | "low-tool-failure-density" }
  ],
  "improvement_proposals": [
    {
      "target_type": "agents_md" | "skill" | "prompt" | "config" | "workflow" | "general",
      "target_path": "optional path or section, e.g. AGENTS.md § Tooling",
      "title": "short imperative title",
      "summary": "one sentence",
      "detail": "2-4 sentences with the concrete change to make",
      "evidence": "what in the session motivates this",
      "confidence": 0.0,
      "severity": "friction" | "correction" | "waste" | "suggestion" | "reinforcement"
    }
  ]
}

A "reinforcement" proposal is a proposal that identifies something the agent did
RIGHT and suggests encoding it ("keep doing X", "add this pattern to instructions").
Use severity "reinforcement" (not "suggestion") for positive-pattern proposals.

Every session — even a clean one — MUST produce a session_summary. A clean session
should still yield reinforcement proposals if there is evidence of good patterns
worth preserving. Only return an empty improvement_proposals array if the session
is truly empty (no turns at all).`;

export const REDUCE_PROMPT_HASH = shortHash(REDUCE_PROMPT);

export interface KeyFrictionPoint {
	description: string;
	severity: string;
}

export interface PositiveSignal {
	description: string;
	signal: string;
}

export interface SessionOverviewProperties {
	session_summary: string;
	key_friction_points: KeyFrictionPoint[];
	key_positive_signals: PositiveSignal[];
	improvement_proposals: Array<Record<string, unknown>>;
	stats?: Record<string, number | string[]>;
}

export function buildReducePrompt(params: { digestOrSummaries: string; stats: string; positiveSignals?: string[] }): string {
	const parts = [
		"AGGREGATE STATS:",
		params.stats,
	];
	if (params.positiveSignals && params.positiveSignals.length > 0) {
		parts.push("", "POSITIVE SIGNALS:", ...params.positiveSignals);
	}
	parts.push("", "SESSION SIGNALS / SEGMENT SUMMARIES:", params.digestOrSummaries);
	return parts.join("\n");
}

export function parseReduceResponse(
	text: string,
	extractJsonObject: (t: string) => Record<string, unknown>,
): SessionOverviewProperties {
	const obj = extractJsonObject(text);
	const friction = Array.isArray(obj["key_friction_points"])
		? (obj["key_friction_points"] as unknown[])
				.map((x) => normalizeFriction(x))
				.filter((x): x is KeyFrictionPoint => x !== null)
		: [];
	const positiveSignals = Array.isArray(obj["key_positive_signals"])
		? (obj["key_positive_signals"] as unknown[])
				.map((x) => normalizePositiveSignal(x))
				.filter((x): x is PositiveSignal => x !== null)
		: [];
	const proposals = Array.isArray(obj["improvement_proposals"])
		? (obj["improvement_proposals"] as unknown[]).filter(
				(x): x is Record<string, unknown> => x !== null && typeof x === "object",
			)
		: [];
	return {
		session_summary: typeof obj["session_summary"] === "string" ? (obj["session_summary"] as string) : "",
		key_friction_points: friction,
		key_positive_signals: positiveSignals,
		improvement_proposals: proposals,
	};
}

function normalizeFriction(value: unknown): KeyFrictionPoint | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v["description"] !== "string") return null;
	return {
		description: v["description"] as string,
		severity: typeof v["severity"] === "string" ? (v["severity"] as string) : "low",
	};
}

function normalizePositiveSignal(value: unknown): PositiveSignal | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v["description"] !== "string") return null;
	return {
		description: v["description"] as string,
		signal: typeof v["signal"] === "string" ? (v["signal"] as string) : "",
	};
}
