/**
 * Type definitions for pi-prospector.
 * All data shapes are plain TypeScript interfaces — no TypeBox schemas needed
 * for internal types. TypeBox schemas are used only for the Pi tool registration
 * where Pi's API expects them.
 */

// ─── Config ───

export interface ProspectorConfig {
	model?: string; // provider/model format, e.g. "anthropic/claude-sonnet-4-5"
	dbPath?: string; // defaults to ~/.pi/agent/prospector.db
	/** Model tiers used by analyzers (cheap/mid/expensive → provider/model). */
	modelTiers?: {
		cheap: string;
		mid: string;
		expensive: string;
	};
}

// ─── Session ───

export interface SessionHeader {
	id: string;
	version: number;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

// ─── Messages ───

export type MessageRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "bashExecution"
	| "custom_message"
	| "branch_summary"
	| "compactionSummary";

export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultInfo {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	textLength: number;
}

export interface MessageEntry {
	id: string;
	parentId: string | null;
	timestamp: string | null;
	role: MessageRole;
	contentText: string | null;
	contentThinking: string | null;
	toolCalls: ToolCallInfo[] | null;
	toolResults: ToolResultInfo[] | null;
}

export interface ParsedLine {
	type: "session" | "message";
	data: SessionHeader | MessageEntry;
}

// ─── Sync ───

export interface DiscoveredSession {
	filePath: string;
	project: string;
	mtime: number; // milliseconds
}

export interface SyncCursor {
	session_id: string;
	last_line: number;
	last_modified: number;
}

export interface ForkInfo {
	parentSessionId: string;
	parentFilePath: string;
	branchLine: number; // line number where the fork diverges
}

export interface SyncResult {
	sessionsProcessed: number;
	sessionsSkipped: number;
	messagesInserted: number;
	forksResolved: number;
	errors: string[];
}

// ─── Proposals ───

export type ProposalSeverity = "friction" | "correction" | "waste" | "suggestion" | "reinforcement";
export type ProposalStatus = "open" | "applied" | "rejected" | "duplicate";

export interface Proposal {
	id: string;
	created_at: string;
	updated_at: string;
	session_id: string;
	source_node_id: string | null;
	analyzer_id: string | null;
	target_type: string;
	target_path: string | null;
	title: string;
	severity: string;
	summary: string;
	detail: string | null;
	evidence: string | null;
	confidence: number | null;
	status: ProposalStatus;
	input_key: string;
}

// ─── Stats ───

export interface Stats {
	totalSessions: number;
	totalMessages: number;
	totalToolResults: number;
	sessionsAnalyzed: number;
	proposalsByStatus: Record<ProposalStatus, number>;
	analysis: {
		nodes: number;
		edges: number;
		runs: number;
		nodesByKind: Record<string, number>;
	};
}

// ─── Analyze ───

export interface AnalyzeResult {
	sessionsAnalyzed: number;
	proposalsGenerated: number;
	errors: string[];
}