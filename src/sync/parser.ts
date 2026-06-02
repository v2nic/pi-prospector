/**
 * JSONL line parser for Pi session files.
 */
import type { SessionHeader, MessageRole } from "../types.js";

export interface ParsedSession {
	kind: "session";
	header: SessionHeader;
}

export interface ParsedMessage {
	kind: "message";
	entry: {
		id: string;
		parentId: string | null;
		timestamp: string | null;
		role: MessageRole;
		text: string | null;
		thinking: string | null;
		tool_calls: Array<{ name: string; arguments: Record<string, unknown> }> | null;
		tool_results: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number }> | null;
		meta?: Record<string, unknown> | null;
	};
}

export type ParsedLine = ParsedSession | ParsedMessage;

export function parseLine(line: string): ParsedLine | null {
	if (!line.trim()) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}

	if (typeof obj !== "object" || obj === null) return null;

	const type = obj.type as string | undefined;

	// Session header
	if (type === "session") {
		return {
			kind: "session",
			header: {
				id: String(obj.id ?? ""),
				version: (obj.version as number) ?? 3,
				timestamp: obj.timestamp as string | undefined,
				cwd: obj.cwd as string | undefined,
				parentSession: obj.parentSession as string | undefined,
			},
		};
	}

	// Message entry
	if (type === "message") {
		const id = String(obj.id ?? "");
		const parentId = (obj.parentId as string) ?? null;
		const timestamp = (obj.timestamp as string) ?? null;
		const msg = obj.message as Record<string, unknown> | undefined;
		if (!msg) return null;

		const role = (msg.role as string) ?? "unknown";
		const content = msg.content;

		let text: string | null = null;
		let thinking: string | null = null;
		let tool_calls: ParsedMessage["entry"]["tool_calls"] = null;
		let tool_results: ParsedMessage["entry"]["tool_results"] = null;
		let meta: Record<string, unknown> | null = null;

		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			const textParts: string[] = [];
			const thinkParts: string[] = [];
			const calls: NonNullable<ParsedMessage["entry"]["tool_calls"]> = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type === "text" && typeof p.text === "string") textParts.push(p.text);
				else if (p.type === "thinking" && typeof p.thinking === "string") thinkParts.push(p.thinking);
				else if (p.type === "toolCall") {
					calls.push({
						name: String(p.name ?? ""),
						arguments: (p.arguments as Record<string, unknown>) ?? {},
					});
				}
			}

			if (textParts.length > 0) text = textParts.join("\n");
			if (thinkParts.length > 0) thinking = thinkParts.join("\n");
			if (calls.length > 0) tool_calls = calls;
		}

		// Tool results
		if (role === "toolResult") {
			const textLen = text?.length ?? 0;
			tool_results = [{
				toolCallId: String(msg.toolCallId ?? ""),
				toolName: String(msg.toolName ?? ""),
				isError: Boolean(msg.isError),
				textLength: textLen,
			}];
		}

		// Capture assistant / model metadata for analyzers that need
		// model, usage, stopReason, etc.
		if (msg && typeof msg === "object") {
			const m = msg as Record<string, unknown>;
			if (m.model !== undefined || m.usage !== undefined || m.stopReason !== undefined || m.api !== undefined || m.provider !== undefined) {
				meta = {};
				if (m.model !== undefined) meta.model = m.model;
				if (m.api !== undefined) meta.api = m.api;
				if (m.provider !== undefined) meta.provider = m.provider;
				if (m.stopReason !== undefined) meta.stop_reason = m.stopReason;
				if (m.usage !== undefined) meta.usage = m.usage;
			}
		}

		return {
			kind: "message",
			entry: { id, parentId, timestamp, role: role as MessageRole, text, thinking, tool_calls, tool_results, meta },
		};
	}

	// Other message-like types (bashExecution, branchSummary, compactionSummary, custom)
	if (type && obj.id) {
		const id = String(obj.id);
		const parentId = (obj.parentId as string) ?? null;
		const timestamp = (obj.timestamp as string) ?? null;

		// Try to get message.role or use the type itself as the role
		const msg = obj.message as Record<string, unknown> | undefined;
		const role = (msg?.role as string) ?? type;

		let text: string | null = null;
		if (msg) {
			if (typeof msg.content === "string") text = msg.content;
			else if (msg.summary) text = String(msg.summary);
			else if (msg.command) text = `${msg.command}\n${msg.output ?? ""}`;
		} else {
			if (obj.summary) text = String(obj.summary);
		}

		return {
			kind: "message",
			entry: { id, parentId, timestamp, role: role as MessageRole, text, thinking: null, tool_calls: null, tool_results: null, meta: null },
		};
	}

	return null;
}