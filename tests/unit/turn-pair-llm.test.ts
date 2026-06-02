import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildTurnPairLlmPrompt,
	parseTurnPairLlmResponse,
} from "../../src/analyze/analyzers/turn-pair-llm/prompt.js";

describe("buildTurnPairLlmPrompt", () => {
	it("substitutes every placeholder", () => {
		const out = buildTurnPairLlmPrompt({
			userText: "u-marker",
			assistantText: "a-marker",
			toolCalls: "[]",
			toolResults: "[]",
			friction: {
				correction_detected: true,
				friction_score: 0.5,
				tool_failure_count: 2,
				retry_detected: true,
				thinking_length: 100,
			},
		});
		assert.ok(out.includes("u-marker"));
		assert.ok(out.includes("a-marker"));
		assert.ok(out.includes("[]"));
		assert.ok(out.includes("true"));
		assert.ok(out.includes("0.50"));
		// No leftover template placeholders
		assert.equal(out.includes("{user_text}"), false);
		assert.equal(out.includes("{assistant_text}"), false);
	});
});

describe("parseTurnPairLlmResponse", () => {
	it("parses well-formed JSON", () => {
		const text = JSON.stringify({
			sentiment: "frustrated",
			frustration_level: 7,
			correction_type_llm: "explicit",
			friction_cause: "wrong_function_name",
			friction_summary: "User corrected the function name twice.",
			user_intent: "Get the agent to use the right helper",
			quality_score: 2,
		});
		const c = parseTurnPairLlmResponse(text);
		assert.equal(c.sentiment, "frustrated");
		assert.equal(c.frustration_level, 7);
		assert.equal(c.correction_type_llm, "explicit");
		assert.equal(c.friction_cause, "wrong_function_name");
		assert.equal(c.quality_score, 2);
	});

	it("strips code fences", () => {
		const text = "```json\n" + JSON.stringify({ sentiment: "positive" }) + "\n```";
		const c = parseTurnPairLlmResponse(text);
		assert.equal(c.sentiment, "positive");
	});

	it("returns defaults on invalid JSON", () => {
		const c = parseTurnPairLlmResponse("not json");
		assert.equal(c.sentiment, "neutral");
		assert.equal(c.frustration_level, 0);
		assert.equal(c.quality_score, 3);
	});

	it("clamps frustration_level to [0, 10]", () => {
		const c1 = parseTurnPairLlmResponse(JSON.stringify({ frustration_level: 99 }));
		assert.equal(c1.frustration_level, 10);
		const c2 = parseTurnPairLlmResponse(JSON.stringify({ frustration_level: -5 }));
		assert.equal(c2.frustration_level, 0);
	});

	it("clamps quality_score to [1, 5]", () => {
		const c1 = parseTurnPairLlmResponse(JSON.stringify({ quality_score: 99 }));
		assert.equal(c1.quality_score, 5);
		const c2 = parseTurnPairLlmResponse(JSON.stringify({ quality_score: 0 }));
		assert.equal(c2.quality_score, 1);
	});

	it("rejects invalid sentiment values", () => {
		const c = parseTurnPairLlmResponse(JSON.stringify({ sentiment: "happy" }));
		assert.equal(c.sentiment, "neutral");
	});
});
