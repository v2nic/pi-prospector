/**
 * Prompt template for the turn-pair-llm analyzer.
 *
 * Classifies a flagged turn pair along several axes:
 *   - sentiment
 *   - frustration level (0–10)
 *   - correction type
 *   - friction cause and summary
 *   - user intent
 *   - quality score (1–5)
 *
 * The output is plain JSON, not tool-calling. We parse the response
 * with the shared parser below.
 */

export const TURN_PAIR_LLM_PROMPT_NAME = "classify-turn-pair";

export const TURN_PAIR_LLM_PROMPT = `You are analyzing a single turn pair from an AI coding agent session. A "turn pair" is a user message followed by the agent's response (and any tool calls/results in between).

You will receive:
  - The user message text
  - The agent's final text response
  - A pre-computed "friction summary" flagging whether the turn had corrections, tool failures, retries, or high thinking time
  - The tool calls and results during the turn

Classify this turn pair along these axes. Return ONLY a JSON object — no prose, no markdown fences.

Schema (return exactly this shape, no extra keys):
{
  "sentiment": "positive" | "neutral" | "negative" | "frustrated",
  "frustration_level": 0-10,
  "correction_type_llm": "explicit" | "implicit" | "repetition" | null,
  "friction_cause": string | null,
  "friction_summary": string | null,
  "user_intent": string,
  "quality_score": 1-5
}

Rules:
- sentiment: pick the dominant emotional tone of the user's message and context.
- frustration_level: 0 = no frustration, 10 = extreme frustration.
- correction_type_llm: only set if the deterministic pass flagged correction_detected=true. Use:
    "explicit" when the user clearly corrects the agent ("no, use X", "actually...", "that's wrong")
    "implicit" when the user course-corrects without explicit pushback ("maybe try X")
    "repetition" when the user re-asks the same thing
    null otherwise
- friction_cause: a short noun phrase naming the cause (e.g. "wrong_function_name", "missing_test_step", "ambiguous_request"). null if no friction.
- friction_summary: 1–2 sentences explaining the friction. null if no friction.
- user_intent: one sentence describing what the user was trying to accomplish.
- quality_score: 1 = very poor agent response, 5 = excellent.

User message:
"""
{user_text}
"""

Agent response:
"""
{assistant_text}
"""

Tool calls during this turn:
"""
{tool_calls_text}
"""

Tool results during this turn:
"""
{tool_results_text}
"""

Pre-computed friction signals:
- correction_detected: {correction_detected}
- friction_score: {friction_score}
- tool_failure_count: {tool_failure_count}
- retry_detected: {retry_detected}
- thinking_length: {thinking_length}

Return JSON only.`;

export function buildTurnPairLlmPrompt(args: {
	userText: string;
	assistantText: string;
	toolCalls: string;
	toolResults: string;
	friction: {
		correction_detected: boolean;
		friction_score: number;
		tool_failure_count: number;
		retry_detected: boolean;
		thinking_length: number;
	};
}): string {
	return TURN_PAIR_LLM_PROMPT
		.replace("{user_text}", args.userText)
		.replace("{assistant_text}", args.assistantText)
		.replace("{tool_calls_text}", args.toolCalls)
		.replace("{tool_results_text}", args.toolResults)
		.replace("{correction_detected}", String(args.friction.correction_detected))
		.replace("{friction_score}", args.friction.friction_score.toFixed(2))
		.replace("{tool_failure_count}", String(args.friction.tool_failure_count))
		.replace("{retry_detected}", String(args.friction.retry_detected))
		.replace("{thinking_length}", String(args.friction.thinking_length));
}

const VALID_SENTIMENTS = new Set(["positive", "neutral", "negative", "frustrated"]);
const VALID_CORRECTIONS = new Set(["explicit", "implicit", "repetition"]);

export interface TurnPairLlmClassification {
	sentiment: "positive" | "neutral" | "negative" | "frustrated";
	frustration_level: number;
	correction_type_llm: "explicit" | "implicit" | "repetition" | null;
	friction_cause: string | null;
	friction_summary: string | null;
	user_intent: string;
	quality_score: number;
}

/**
 * Parse the LLM's JSON response into a typed classification.
 * Defensive against malformed output: returns sensible defaults
 * rather than throwing, since classification is a soft signal.
 */
export function parseTurnPairLlmResponse(text: string): TurnPairLlmClassification {
	const defaults: TurnPairLlmClassification = {
		sentiment: "neutral",
		frustration_level: 0,
		correction_type_llm: null,
		friction_cause: null,
		friction_summary: null,
		user_intent: "",
		quality_score: 3,
	};
	try {
		// Strip optional code fences
		const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
		const obj = JSON.parse(trimmed);
		if (!obj || typeof obj !== "object") return defaults;
		const o = obj as Record<string, unknown>;
		return {
			sentiment: VALID_SENTIMENTS.has(o.sentiment as string) ? (o.sentiment as TurnPairLlmClassification["sentiment"]) : defaults.sentiment,
			frustration_level: clampInt(o.frustration_level, 0, 10),
			correction_type_llm: VALID_CORRECTIONS.has(o.correction_type_llm as string) ? (o.correction_type_llm as TurnPairLlmClassification["correction_type_llm"]) : null,
			friction_cause: typeof o.friction_cause === "string" ? o.friction_cause : null,
			friction_summary: typeof o.friction_summary === "string" ? o.friction_summary : null,
			user_intent: typeof o.user_intent === "string" ? o.user_intent : "",
			quality_score: clampInt(o.quality_score, 1, 5),
		};
	} catch {
		return defaults;
	}
}

function clampInt(v: unknown, lo: number, hi: number): number {
	const n = typeof v === "number" ? Math.round(v) : NaN;
	if (isNaN(n)) return lo;
	return Math.max(lo, Math.min(hi, n));
}
