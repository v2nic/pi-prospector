import type { ExtensionAPI } from "./pi-stubs.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerProposalsCommand } from "./commands/proposals.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerProspectTool } from "./commands/tool.js";
import { setDefaultLLMCaller } from "./analyze/defaults.js";
import type { LLMCaller, LLMRequest } from "./analyze/types.js";

/**
 * LLM caller that delegates to Pi's model provider. In production
 * the host SDK exposes a `pi.ai` namespace; here we use the
 * extension's context to call models. In tests this default
 * stub is replaced via `setDefaultLLMCaller`.
 */
function makePiLLMCaller(pi: ExtensionAPI): LLMCaller {
	return async (request: LLMRequest): Promise<{
		text: string;
		model: string;
		costUsd: number;
		tokensUsed: number;
		durationMs: number;
	}> => {
		const start = Date.now();
		try {
			// Delegate to Pi's ai.complete API. The exact shape depends
			// on the host SDK; we use a minimal interface that Pi
			// should be able to satisfy. Falls back to a stub if the
			// host doesn't expose this.
			const result = await (pi as any).ai?.complete?.({
				model: request.model,
				system: request.system,
				prompt: request.user,
				...request.jsonSchema ? { schema: request.jsonSchema } : {},
			});
			return {
				text: result?.text ?? "",
				model: request.model,
				costUsd: result?.cost ?? 0,
				tokensUsed: result?.tokens ?? 0,
				durationMs: Date.now() - start,
			};
		} catch (err) {
			return {
				text: "",
				model: request.model,
				costUsd: 0,
				tokensUsed: 0,
				durationMs: Date.now() - start,
			};
		}
	};
}

export default function (pi: ExtensionAPI) {
	setDefaultLLMCaller(makePiLLMCaller(pi));
	registerSyncCommand(pi);
	registerStatsCommand(pi);
	registerProposalsCommand(pi);
	registerAnalyzeCommand(pi);
	registerProspectTool(pi);
}
