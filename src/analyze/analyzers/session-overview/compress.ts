/**
 * Map-reduce compression for large sessions.
 */

import type { LLMRequest, LLMResponse } from "../../types.js";

export interface Segment { index: number; text: string; pairCount: number; }

export function splitDigestIntoSegments(markdown: string, maxCharsPerSegment: number = 8000): Segment[] {
	if (markdown.length <= maxCharsPerSegment) return [{ index: 0, text: markdown, pairCount: 0 }];
	const segments: Segment[] = [];
	const lines = markdown.split("\n");
	let currentLines: string[] = [];
	let currentLen = 0;
	let segIdx = 0;
	for (const line of lines) {
		if (currentLen + line.length > maxCharsPerSegment && currentLines.length > 0) {
			segments.push({ index: segIdx++, text: currentLines.join("\n"), pairCount: currentLines.filter(l => l.startsWith("|")).length - 1 });
			const overlapLines = currentLines.slice(-3);
			currentLines = [...overlapLines, line];
			currentLen = currentLines.join("\n").length + line.length;
		} else {
			currentLines.push(line);
			currentLen += line.length + 1;
		}
	}
	if (currentLines.length > 0) segments.push({ index: segIdx, text: currentLines.join("\n"), pairCount: currentLines.filter(l => l.startsWith("|")).length - 1 });
	return segments;
}

export async function mapPhase(segment: Segment, llm: (req: LLMRequest) => Promise<LLMResponse>, modelSpec: string): Promise<string> {
	const response = await llm({ model: modelSpec, systemPrompt: SESSION_MAP_SYSTEM_PROMPT, userPrompt: `Analyze this session segment:\n\n${segment.text}`, maxTokens: 1024, temperature: 0.2 });
	return response.content ?? "(no content)";
}

const SESSION_MAP_SYSTEM_PROMPT = `You are a session analyst. Summarize the key findings from this session segment. Focus on friction, corrections, waste, and quality.`;

export const SESSION_REDUCE_PROMPT = `You are a session analyst. Given segment summaries and aggregated statistics, produce a complete session analysis including:\n1. Session summary (2–3 sentences)\n2. Key friction points with severity\n3. Improvement proposals targeting specific config, skills, or documentation\n4. Sentiment arc across the session\n\nEach proposal should have: target_type, target_path, title, summary, detail, evidence, confidence (0.0–1.0), severity.\n\nCall the submit_session_analysis tool with your findings.`;

export const SESSION_OVERVIEW_TOOL_NAME = "submit_session_analysis";

export const SESSION_OVERVIEW_TOOL_SCHEMA = {
	name: SESSION_OVERVIEW_TOOL_NAME,
	description: "Submit session overview analysis with proposals",
	parameters: {
		type: "object" as const,
		properties: {
			session_summary: { type: "string" as const, description: "2–3 sentence summary" },
			key_friction_points: { type: "array" as const, items: { type: "object" as const, properties: { description: { type: "string" as const }, pair_node_id: { type: "string" as const }, severity: { type: "string" as const, enum: ["low", "medium", "high"] } }, required: ["description", "pair_node_id", "severity"] } },
			improvement_proposals: { type: "array" as const, items: { type: "object" as const, properties: { target_type: { type: "string" as const, enum: ["agents_md", "system_md", "skill", "extension_prompt", "tool_output", "repo_doc", "config"] }, target_path: { type: "string" as const }, title: { type: "string" as const }, summary: { type: "string" as const }, detail: { type: "string" as const }, evidence: { type: "string" as const }, confidence: { type: "number" as const }, severity: { type: "string" as const, enum: ["friction", "correction", "waste", "suggestion", "insight"] } }, required: ["target_type", "title", "summary", "severity", "confidence"] } },
			sentiment_arc: { type: "array" as const, items: { type: "object" as const, properties: { segment: { type: "number" as const }, sentiment: { type: "string" as const }, key_event: { type: "string" as const } }, required: ["segment", "sentiment", "key_event"] } },
		},
		required: ["session_summary", "key_friction_points", "improvement_proposals"],
	},
};