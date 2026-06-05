/**
 * Prompt template for turn-pair-llm analyzer.
 */

export const TURN_PAIR_LLM_PROMPT = `You are a session analyst for an AI coding agent. You analyze individual turn pairs that have been flagged as potentially problematic by a deterministic analysis.

Given a turn pair's deterministic metrics and the original messages, classify:

1. **sentiment**: The user's emotional state — one of: positive, neutral, negative, frustrated
2. **frustration_level**: A 0–10 scale of user frustration
3. **correction_type_llm**: What kind of correction? — explicit, implicit, repetition, or null
4. **friction_cause**: Brief description of what's causing friction
5. **friction_summary**: 1–2 sentence summary
6. **user_intent**: What was the user trying to accomplish?
7. **quality_score**: How well did the agent respond? 1–5

Be concise and precise.`;

export const TURN_PAIR_LLM_SYSTEM_PROMPT = TURN_PAIR_LLM_PROMPT;

export function buildTurnPairLLMPrompt(metrics: Record<string, unknown>, userText: string, assistantText: string): string {
	return `## Turn-Pair Deterministic Metrics\n${JSON.stringify(metrics, null, 2)}\n\n## User Message\n${userText ?? "(empty)"}\n\n## Assistant Response\n${assistantText ?? "(empty)"}\n\nAnalyze this turn pair for sentiment, frustration, friction, and quality. Call the ${TURN_PAIR_LLM_TOOL_NAME} tool with your findings.`;
}

export const TURN_PAIR_LLM_TOOL_NAME = "submit_turn_classification";

export const TURN_PAIR_LLM_TOOL_SCHEMA = {
	name: TURN_PAIR_LLM_TOOL_NAME,
	description: "Submit classification for a turn pair",
	parameters: {
		type: "object" as const,
		properties: {
			sentiment: { type: "string" as const, enum: ["positive", "neutral", "negative", "frustrated"], description: "The user's emotional state" },
			frustration_level: { type: "integer" as const, minimum: 0, maximum: 10, description: "0–10 frustration scale" },
			correction_type_llm: { type: "string" as const, enum: ["explicit", "implicit", "repetition", "null"], description: "What kind of correction, if any" },
			friction_cause: { type: "string" as const, description: "Brief description of friction cause" },
			friction_summary: { type: "string" as const, description: "1–2 sentence summary" },
			user_intent: { type: "string" as const, description: "What the user was trying to accomplish" },
			quality_score: { type: "integer" as const, minimum: 1, maximum: 5, description: "How well the agent responded" },
		},
		required: ["sentiment", "frustration_level", "user_intent", "quality_score"],
	},
};