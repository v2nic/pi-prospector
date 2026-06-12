/**
 * Map-phase prompt: summarise one digest segment of a large session.
 */

import { shortHash } from "../../input-hash.js";

export const MAP_PROMPT = `You summarise one segment of a coding-agent session's signals — both friction
and positive (things that went well). Return ONLY a JSON object:
{
  "segment_summary": "2-4 sentences on what happened, including any friction and any positive patterns",
  "notable_points": ["short bullet", "..."]
}
Note any clean recoveries (correction followed by smooth work), low friction, or
task completions without correction. Be concise and factual. Do not invent details
beyond the signals provided.`;

export const MAP_PROMPT_HASH = shortHash(MAP_PROMPT);

export interface MapSummary {
	segment_summary: string;
	notable_points: string[];
}

export function buildMapPrompt(segmentText: string): string {
	return `SESSION SEGMENT SIGNALS:\n${segmentText}`;
}

export function parseMapResponse(text: string, extractJsonObject: (t: string) => Record<string, unknown>): MapSummary {
	const obj = extractJsonObject(text);
	const notable = Array.isArray(obj["notable_points"])
		? (obj["notable_points"] as unknown[]).filter((x): x is string => typeof x === "string")
		: [];
	return {
		segment_summary: typeof obj["segment_summary"] === "string" ? (obj["segment_summary"] as string) : "",
		notable_points: notable,
	};
}
