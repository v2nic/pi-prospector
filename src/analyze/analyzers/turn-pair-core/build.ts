/**
 * Turn construction from a session's message stream.
 *
 * A *turn* begins at a turn-starting entry and spans everything the agent does
 * in response — assistant text, thinking, tool calls, and tool results — up to
 * (but excluding) the next turn-starting entry. Following the host platform's
 * own turn boundaries, a turn starts at a user message, a bash execution
 * (`bashExecution`), or a branch/custom summary (`branch_summary` /
 * `custom_message`). Context-management entries (compaction summaries) are not
 * turn starts and are not part of any turn.
 *
 * The fields named `userMessageId` / `userText` hold the turn-starting message
 * and its text; for ordinary turns that is the user's message, and for the
 * non-user turn starts above it is that entry.
 */

import type { MessageRow } from "../../types.js";

/**
 * Roles/entry-kinds that begin a new turn. Mirrors the host platform's turn
 * boundary definition (`user` and `bashExecution` messages, plus `branch_summary`
 * and `custom_message` entries). Compaction summaries are deliberately excluded.
 */
const TURN_START_ROLES = new Set<string>(["user", "bashExecution", "branch_summary", "custom_message"]);

export interface PairToolCall {
	name: string;
	/** Truncated tool-call arguments for classifier evidence (e.g. bash command, gh subcommand). */
	argumentsPreview: string;
}

export interface PairToolResult {
	toolName: string;
	isError: boolean;
	textLength: number;
	/** First N characters of the tool result text (captured for error diagnostics). */
	errorHead: string | null;
}

export interface TurnPair {
	/** Index of the pair within the session, 0-based. */
	index: number;
	/** The anchoring user message id. */
	userMessageId: string;
	/** All message ids covered by this pair (user + responses). */
	messageIds: string[];
	userText: string;
	assistantText: string;
	thinkingText: string;
	toolCalls: PairToolCall[];
	toolResults: PairToolResult[];
	/** The previous pair's user text, for repetition detection. */
	priorUserText: string | null;
	timestamp: string | null;
}

/** Max length for a tool-call arguments preview string. */
const ARGS_PREVIEW_MAX = 300;

/** Max length for an error head string captured from tool results. */
const ERROR_HEAD_MAX = 300;

/** Truncate a string to maxLen characters, appending an ellipsis if truncated. */
function truncateWithEllipsis(s: string, maxLen: number): string {
	return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/**
 * Extract a concise, human-readable arguments preview from a tool call.
 *
 * For `bash` calls, returns the command string.
 * For other calls (e.g. `gh`, `git`), returns a compact representation of
 * the arguments (subcommand + flags + key params).
 */
function formatArgsPreview(name: string, args: Record<string, unknown>): string {
	if (name === "bash" || name === "Shell") {
		const command = typeof args["command"] === "string" ? args["command"] : "";
		return truncateWithEllipsis(command, ARGS_PREVIEW_MAX);
	}
	// For other tools, build a compact key=value summary.
	const parts: string[] = [];
	for (const [key, val] of Object.entries(args)) {
		if (val === undefined || val === null) continue;
		const valStr = typeof val === "string" ? val : JSON.stringify(val);
		parts.push(`${key}=${truncateWithEllipsis(valStr, 80)}`);
	}
	return truncateWithEllipsis(parts.join(" "), ARGS_PREVIEW_MAX);
}

function parseToolCalls(json: string | null): PairToolCall[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as Array<{ name?: unknown; arguments?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.map((c) => {
			const name = typeof c.name === "string" ? c.name : "";
			const args = (c.arguments && typeof c.arguments === "object" && c.arguments !== null) ? c.arguments as Record<string, unknown> : {};
			return { name, argumentsPreview: formatArgsPreview(name, args) };
		});
	} catch {
		return [];
	}
}

function parseToolResults(json: string | null, errorText: string | null): PairToolResult[] {
	if (!json) return [];
	try {
		const arr = JSON.parse(json) as Array<{ toolName?: unknown; isError?: unknown; textLength?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.map((r) => {
			const isError = Boolean(r.isError);
			return {
				toolName: typeof r.toolName === "string" ? r.toolName : "",
				isError,
				textLength: typeof r.textLength === "number" ? r.textLength : 0,
				errorHead: isError && errorText ? truncateWithEllipsis(errorText.trim(), ERROR_HEAD_MAX) : null,
			};
		});
	} catch {
		return [];
	}
}

/** Build the ordered list of turn pairs for a session. */
export function buildTurnPairs(messages: MessageRow[]): TurnPair[] {
	const pairs: TurnPair[] = [];
	let current: TurnPair | null = null;
	let priorUserText: string | null = null;

	const flush = (): void => {
		if (current) {
			pairs.push(current);
			priorUserText = current.userText;
			current = null;
		}
	};

	for (const m of messages) {
		if (TURN_START_ROLES.has(m.role)) {
			flush();
			current = {
				index: pairs.length,
				userMessageId: m.id,
				messageIds: [m.id],
				userText: m.content_text ?? "",
				assistantText: "",
				thinkingText: "",
				toolCalls: [],
				toolResults: [],
				priorUserText,
				timestamp: m.timestamp,
			};
			continue;
		}

		if (!current) continue; // pre-first-turn noise (e.g. a leading summary)

		if (m.role === "assistant") {
			current.messageIds.push(m.id);
			if (m.content_text) current.assistantText += (current.assistantText ? "\n" : "") + m.content_text;
			if (m.content_thinking) current.thinkingText += (current.thinkingText ? "\n" : "") + m.content_thinking;
			current.toolCalls.push(...parseToolCalls(m.tool_calls));
		} else if (m.role === "toolResult") {
			current.messageIds.push(m.id);
			const errorText = m.content_text ?? null;
			current.toolResults.push(...parseToolResults(m.tool_results, errorText));
		}
	}

	flush();
	return pairs;
}
