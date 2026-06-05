/**
 * Type definitions for pi-prospector.
 * All data shapes use TypeBox schemas, with TypeScript types derived via Static<typeof Schema>.
 */

// Re-export all types from the analyzer framework
export type {
	AnalyzerDef, AnalyzerVersion, PromptVersion, AnalyzerConfig,
	AnalysisUnit, SourceRef, AnalysisResult, AnalysisEdge,
	Analyzer, AnalyzerPlanContext, AnalyzerRunContext,
	AnalysisNodeInsert, AnalysisEdgeInsert, AnalysisRunInsert, AnalysisProgressInsert,
	AnalysisNodeRow, AnalysisRunRow, AnalysisProgressRow,
	MessageRow, LLMRequest, LLMResponse, FrameworkRunResult, FrameworkRunAllResult,
	ModelTierConfig, ModelTier,
	TurnPairCoreProperties, TurnPairLLMProperties,
	KeyFrictionPoint, ImprovementProposal, SentimentArcPoint,
	SessionOverviewProperties, ProposalV2,
} from "./analyze/types.js";

export {
	AnalyzerDefSchema, AnalyzerVersionSchema, PromptVersionSchema, AnalyzerConfigSchema,
	SourceRefSchema, AnalysisUnitSchema, AnalysisResultSchema, AnalysisEdgeSchema,
	NodeKindEnum, EdgeKindEnum, RefKindEnum, AnchorSpanEnum,
	SessionOverviewPropertiesSchema, ImprovementProposalSchema, ProspectorConfigV2Schema,
} from "./analyze/types.js";

// ─── Config ───

export interface ProspectorConfig {
	model?: string;
	dbPath?: string;
	modelTiers?: import("./analyze/types.js").ModelTierConfig;
}

// ─── Session ───

export interface SessionHeader { id: string; version: number; timestamp?: string; cwd?: string; parentSession?: string; }

// ─── Messages ───

export type MessageRole = "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary";

export interface ToolCallInfo { name: string; arguments: Record<string, unknown>; }
export interface ToolResultInfo { toolCallId: string; toolName: string; isError: boolean; textLength: number; }

export interface MessageEntry {
	id: string; parentId: string | null; timestamp: string | null; role: MessageRole;
	contentText: string | null; contentThinking: string | null;
	toolCalls: ToolCallInfo[] | null; toolResults: ToolResultInfo[] | null;
}

export interface ParsedLine { type: "session" | "message"; data: SessionHeader | MessageEntry; }

// ─── Sync ───

export interface DiscoveredSession { filePath: string; project: string; mtime: number; }
export interface SyncCursor { session_id: string; last_line: number; last_modified: number; }
export interface ForkInfo { parentSessionId: string; parentFilePath: string; branchLine: number; }
export interface SyncResult { sessionsProcessed: number; sessionsSkipped: number; messagesInserted: number; forksResolved: number; errors: string[]; }

// ─── Proposals (v1 compatibility) ───

export type ProposalSeverity = "friction" | "correction" | "waste" | "suggestion";
export type ProposalStatus = "open" | "applied" | "rejected" | "duplicate";

export interface NewProposal { sessionId: string; target: string; severity: ProposalSeverity; summary: string; detail: string; evidence: string; dedupHash: string; }
export interface Proposal { id: string; created_at: string; session_id: string; target: string; severity: ProposalSeverity; summary: string; detail: string; evidence: string; status: ProposalStatus; dedup_hash: string; }

// ─── Stats ───

export interface Stats { totalSessions: number; totalMessages: number; totalToolResults: number; messagesProcessed: number; proposalsByStatus: Record<ProposalStatus, number>; }

// ─── Analyze ───

export interface AnalyzeResult { sessionsAnalyzed: number; proposalsGenerated: number; errors: string[]; }