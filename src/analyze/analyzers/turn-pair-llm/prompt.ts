/**
 * Prompt and response parsing for turn-pair-llm.
 *
 * The model receives a single high-signal turn pair and returns a compact JSON
 * classification. We keep the schema small and deterministic so cheap models
 * can comply and so parsing is robust.
 */

import { shortHash } from "../../input-hash.js";

export const CLASSIFY_PROMPT = `You classify a single turn in a coding-agent session.
A "turn" is one user message and the assistant's response to it.

Return ONLY a JSON object, no prose, with exactly these fields:
{
  "sentiment": "positive" | "neutral" | "frustrated",
  "friction_type": "none" | "wrong_approach" | "missed_instruction" | "tool_misuse" | "repetition" | "other",
  "is_genuine_correction": boolean,
  "severity": "low" | "medium" | "high",
  "rationale": "one short sentence"
}

Judge only what the text supports. If the user is simply continuing the task with
no friction, use sentiment "neutral", friction_type "none", is_genuine_correction false.

When TOOL CALLS are shown, use them to ground your diagnosis: prefer friction_type
"tool_misuse" when the tool name, arguments, or error reveal the mechanism of the
failure (e.g. wrong flags, missing --repo, targeting the wrong resource).`;

export const CLASSIFY_PROMPT_HASH = shortHash(CLASSIFY_PROMPT);

export interface ToolCallEvidence {
	/** Tool name (e.g. "bash", "gh", "git"). */
	name: string;
	/** Truncated arguments preview (e.g. the bash command string, gh subcommand+flags). */
	argumentsPreview: string;
}

export interface ToolResultEvidence {
	/** Tool name that produced this result. */
	toolName: string;
	/** Whether the tool result is an error. */
	isError: boolean;
	/** First N characters of the error text, null if not an error. */
	errorHead: string | null;
}

export interface ClassifyInput {
	userText: string;
	assistantText: string;
	correctionText: string | null;
	/** Tool calls made by the assistant in this turn. */
	toolCalls: ToolCallEvidence[];
	/** Tool results (including errors) in this turn. */
	toolResults: ToolResultEvidence[];
}

export function buildClassifyPrompt(input: ClassifyInput): string {
	const sections: string[] = [
		"USER MESSAGE:",
		truncate(input.userText, 1500),
		"",
		"ASSISTANT RESPONSE:",
		truncate(input.assistantText, 1500),
	];

	if (input.correctionText) {
		sections.push("", `HEURISTIC CORRECTION HINT: ${truncate(input.correctionText, 300)}`);
	}

	// Tool-call evidence: failing tool names, truncated arguments, and error heads.
	if (input.toolCalls.length > 0 || input.toolResults.some((r) => r.isError)) {
		const toolLines: string[] = [];
		for (const tc of input.toolCalls) {
			if (tc.argumentsPreview) {
				toolLines.push(`  ${tc.name}: ${truncate(tc.argumentsPreview, 200)}`);
			} else {
				toolLines.push(`  ${tc.name}`);
			}
		}
		for (const tr of input.toolResults) {
			if (tr.isError) {
				const errLine = tr.errorHead ? ` error="${truncate(tr.errorHead, 200)}"` : "";
				toolLines.push(`  ${tr.toolName} (FAILED)${errLine}`);
			}
		}
		if (toolLines.length > 0) {
			sections.push("", "TOOL CALLS:", ...toolLines);
		}
	}

	return sections.join("\n");
}

/** The fields the model returns for a single turn. */
export interface ClassifyResult {
	sentiment: string;
	friction_type: string;
	is_genuine_correction: boolean;
	severity: string;
	rationale: string;
}

/**
 * The stored classification node content: the model's result plus the id of the
 * user message whose turn it classifies. The anchor id comes from the planned
 * unit, not the model, so the session-overview digest can merge LLM enrichment
 * back onto the matching deterministic pair by `user_message_id`.
 */
export interface TurnPairLLMProperties extends ClassifyResult {
	user_message_id: string;
}

const VALID_SENTIMENT = new Set(["positive", "neutral", "frustrated"]);
const VALID_FRICTION = new Set(["none", "wrong_approach", "missed_instruction", "tool_misuse", "repetition", "other"]);
const VALID_SEVERITY = new Set(["low", "medium", "high"]);

/** Parse the model's JSON, tolerating markdown fences and extra prose. */
export function parseClassifyResponse(text: string): ClassifyResult {
	const obj = extractJsonObject(text);
	const sentiment = pickString(obj["sentiment"], VALID_SENTIMENT, "neutral");
	const frictionType = pickString(obj["friction_type"], VALID_FRICTION, "none");
	const severity = pickString(obj["severity"], VALID_SEVERITY, "low");
	return {
		sentiment,
		friction_type: frictionType,
		is_genuine_correction: Boolean(obj["is_genuine_correction"]),
		severity,
		rationale: typeof obj["rationale"] === "string" ? (obj["rationale"] as string).slice(0, 300) : "",
	};
}

function pickString(value: unknown, allowed: Set<string>, fallback: string): string {
	return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Extract the first balanced JSON object from arbitrary model text. */
export function extractJsonObject(text: string): Record<string, unknown> {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = fenced ? fenced[1]! : text;
	const start = candidate.indexOf("{");
	if (start < 0) throw new Error("No JSON object found in LLM response");
	let depth = 0;
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				const slice = candidate.slice(start, i + 1);
				return JSON.parse(slice) as Record<string, unknown>;
			}
		}
	}
	throw new Error("Unterminated JSON object in LLM response");
}
