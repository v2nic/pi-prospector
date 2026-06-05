/**
 * Ollama LLM backend for the analyzer framework.
 * Calls Ollama's local API (http://localhost:11434) to run LLM inference.
 */

import type { LLMRequest, LLMResponse } from "./analyze/types.js";
import type { ModelTierConfig } from "./analyze/types.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/**
 * Resolve a model spec to an actual Ollama model name.
 * If the spec contains a tier name (cheap/mid/expensive), resolve it using the config.
 * Otherwise, use the spec directly as the model name.
 */
export function resolveOllamaModel(spec: string, config?: ModelTierConfig): string {
	const tiers: ModelTierConfig = config ?? {
		cheap: "deepseek-v4-flash:cloud",
		mid: "glm-5.1:cloud",
		expensive: "deepseek-v4-pro:cloud",
	};
	if (spec === "cheap") return tiers.cheap;
	if (spec === "mid") return tiers.mid;
	if (spec === "expensive") return tiers.expensive;
	return spec;
}

/**
 * Call Ollama's chat API to generate a response.
 * Uses the /api/chat endpoint with structured output when tools are provided.
 */
export async function callOllamaLLM(request: LLMRequest, modelConfig?: ModelTierConfig): Promise<LLMResponse> {
	const model = resolveOllamaModel(request.model, modelConfig);
	const url = `${OLLAMA_BASE_URL}/api/chat`;

	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: request.systemPrompt },
			{ role: "user", content: request.userPrompt },
		],
		stream: false,
		options: {
			...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
			...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
		},
	};

	// If tools are provided, include them for structured output
	if (request.tools && request.tools.length > 0) {
		body.tools = request.tools.map((tool: unknown) => {
			if (typeof tool === "object" && tool !== null) {
				const t = tool as Record<string, unknown>;
				return {
					type: "function" as const,
					function: {
						name: t.name ?? "classify",
						description: t.description ?? "",
						parameters: t.parameters ?? {},
					},
				};
			}
			return tool;
		});
	}

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Ollama API error (${response.status}): ${errorText}`);
	}

	const data = await response.json() as Record<string, unknown>;
	const message = data.message as Record<string, unknown> | undefined;

	// Extract content from the response
	const content = (message?.content as string) ?? "";

	// Extract tool calls if present
	let toolCalls: unknown[] | undefined;
	if (message?.tool_calls && Array.isArray(message.tool_calls)) {
		toolCalls = (message.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
			name: (tc.function as Record<string, unknown>)?.name,
			arguments: (tc.function as Record<string, unknown>)?.arguments,
		}));
	}

	// Extract usage info
	const evalCount = (data.eval_count as number) ?? 0;
	const promptEvalCount = (data.prompt_eval_count as number) ?? 0;

	return {
		content,
		toolCalls: toolCalls,
		usage: {
			inputTokens: promptEvalCount,
			outputTokens: evalCount,
		},
		model: data.model as string | undefined,
	};
}