/**
 * AnalyzerFramework: Orchestrates analyzer registration, planning, and execution.
 * Design reference: docs/analyzer-design-c.md §4.2
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
	Analyzer, AnalyzerConfig, AnalysisUnit, AnalysisResult, AnalysisNodeInsert,
	AnalysisEdgeInsert, AnalysisRunInsert, AnalysisProgressInsert, AnalysisProgressRow, AnalysisNodeRow,
	AnalysisRunRow, AnalyzerPlanContext, AnalyzerRunContext, MessageRow,
	LLMRequest, LLMResponse, ModelTier, ModelTierConfig, FrameworkRunResult, FrameworkRunAllResult,
} from "./types.js";
import {
	upsertAnalyzerDef, upsertAnalyzerVersion, insertPrompt, insertAnalyzerConfig,
	insertAnalysisRun, updateAnalysisRun, getAnalysisNode, getAnalysisNodesByAnalyzer,
	checkInputHashExists, insertAnalysisNode, insertAnalysisEdges, upsertAnalysisProgress,
	getAnalysisProgress, getFullSessionMessages,
} from "../db/analysis-queries.js";
import { computeSourceSetHash, computeInputHash, computePromptBundleHash } from "./input-hash.js";
import { materializeProposals } from "./proposal-materializer.js";
import { resolveModelTier, DEFAULT_MODEL_TIERS } from "./model-tiers.js";

export class AnalyzerFramework {
	private analyzers: Map<string, Analyzer> = new Map();
	private db: Database.Database;

	constructor(db: Database.Database) { this.db = db; }

	register(analyzer: Analyzer): void {
		this.analyzers.set(analyzer.def.id, analyzer);
		upsertAnalyzerDef(this.db, analyzer.def);
		upsertAnalyzerVersion(this.db, analyzer.version);
		for (const [_name, prompt] of Object.entries(analyzer.prompts)) {
			insertPrompt(this.db, prompt.hash, prompt.content, prompt.role ?? undefined, prompt.createdAt);
		}
		insertAnalyzerConfig(this.db, analyzer.defaultConfig);
	}

	get(analyzerId: string): Analyzer | undefined { return this.analyzers.get(analyzerId); }
	list(): string[] { return Array.from(this.analyzers.keys()); }

	async runAnalyzer(analyzerId: string, sessionId: string, configOverrides?: Partial<AnalyzerConfig>, modelTiers?: ModelTierConfig): Promise<FrameworkRunResult> {
		const analyzer = this.analyzers.get(analyzerId);
		if (!analyzer) throw new Error(`Analyzer not registered: ${analyzerId}`);
		const config = configOverrides ? { ...analyzer.defaultConfig, ...configOverrides } : analyzer.defaultConfig;
		const promptHashes = Object.values(analyzer.prompts).map(p => p.hash);
		const promptBundleHash = computePromptBundleHash(promptHashes);
		const runId = `run-${createHash("sha256").update(`${analyzerId}-${analyzer.version.versionId}-${sessionId}-${Date.now()}`).digest("hex").slice(0, 16)}`;
		const startedAt = new Date().toISOString();
		const modelSpec = resolveModelTier((analyzer.version.implementationKind === "deterministic" ? "cheap" : "mid") as ModelTier, modelTiers);

		const runInsert: AnalysisRunInsert = {
			id: runId, analyzerId: analyzer.def.id, analyzerVersionId: analyzer.version.versionId,
			configId: config.id, sessionId, status: "running", promptBundleHash, startedAt, modelSpec,
		};
		insertAnalysisRun(this.db, runInsert);

		const messages = this.getMessages(sessionId);
		const ownNodes = getAnalysisNodesByAnalyzer(this.db, analyzerId);
		const dependencyNodes = this.getDependencyNodes(analyzerId, sessionId);
		const progress: AnalysisProgressRow | null | undefined = getAnalysisProgress(this.db, analyzerId, analyzer.version.versionId, config.id, sessionId);

		const planContext: AnalyzerPlanContext = {
			sessionId, messages, allNodes: [...ownNodes, ...Object.values(dependencyNodes).flat()],
			ownNodes, dependencyNodes, progress: progress ?? undefined, db: this.db,
		};

		let units: AnalysisUnit[];
		try { units = await analyzer.plan(planContext); } catch (err) {
			updateAnalysisRun(this.db, runId, { status: "error", finished_at: new Date().toISOString(), error_message: `Plan failed: ${err instanceof Error ? err.message : String(err)}` });
			throw err;
		}

		let nodesProduced = 0; let nodesSkipped = 0; let totalCostUsd = 0; let totalTokensUsed = 0; let totalDurationMs = 0;

		for (const unit of units) {
			const inputHash = computeInputHash(analyzerId, analyzer.version.versionId, config.id, promptBundleHash, unit.sourceSetHash);
			if (checkInputHashExists(this.db, inputHash)) { nodesSkipped++; continue; }

			const runRow: AnalysisRunRow = {
				id: runId, analyzer_id: analyzer.def.id, analyzer_version_id: analyzer.version.versionId, config_id: config.id,
				session_id: sessionId, status: "running", prompt_bundle_hash: promptBundleHash, started_at: startedAt,
				finished_at: "", model_spec: modelSpec ?? "", cost_usd: 0, tokens_used: 0, nodes_produced: 0, nodes_skipped: 0, error_message: "",
			};

			const runContext: AnalyzerRunContext = {
				getMessage(id: string): MessageRow | undefined { return messages.find(m => m.id === id); },
				getNode: (id: string): AnalysisNodeRow | undefined => getAnalysisNode(this.db, id),
				getDependencyNodes: (depId: string): AnalysisNodeRow[] => dependencyNodes[depId] ?? [],
				llm: (req: LLMRequest) => this.callLLM(req, modelTiers), run: runRow, config, prompts: Object.fromEntries(Object.entries(analyzer.prompts).map(([k, v]) => [k, v.content])),
			};

			const startTime = Date.now();
			let result: AnalysisResult;
			try { result = await analyzer.analyze(unit, runContext); } catch (err) {
				result = { contentJson: { error: err instanceof Error ? err.message : String(err) }, nodeKind: "error", anchorKind: unit.anchorKind, anchorRef: unit.anchorRef, edges: [] };
			}
			const durationMs = Date.now() - startTime;

			const nodeId = `node-${createHash("sha256").update(inputHash).digest("hex").slice(0, 12)}`;
			const nodeInsert: AnalysisNodeInsert = {
				id: nodeId, sessionId, analyzerId: analyzer.def.id, analyzerVersionId: analyzer.version.versionId,
				configId: config.id, runId, nodeKind: result.nodeKind, contentJson: JSON.stringify(result.contentJson),
				sourceSetHash: unit.sourceSetHash, inputHash, createdAt: new Date().toISOString(),
				modelUsed: result.modelUsed ?? undefined, costUsd: result.costUsd ?? 0, tokensUsed: result.tokensUsed ?? 0, durationMs: result.durationMs ?? undefined,
			};
			insertAnalysisNode(this.db, nodeInsert);

			const edges: AnalysisEdgeInsert[] = result.edges.map((e: { toRefKind: string; toRefId: string; edgeKind: string; ordinal?: number }, idx: number) => ({
				fromNodeId: nodeId, toRefKind: e.toRefKind, toRefId: e.toRefId, edgeKind: e.edgeKind, ordinal: e.ordinal ?? idx,
			}));
			if (edges.length > 0) insertAnalysisEdges(this.db, edges);

			if (result.nodeKind === "summary" || result.nodeKind === "proposal") {
				const nodeRow = getAnalysisNode(this.db, nodeId);
				if (nodeRow) materializeProposals(this.db, nodeRow);
			}

			nodesProduced++;
			totalCostUsd += result.costUsd ?? 0;
			totalTokensUsed += result.tokensUsed ?? 0;
			totalDurationMs += durationMs;
		}

		const finishedAt = new Date().toISOString();
		updateAnalysisRun(this.db, runId, { status: "ok", finished_at: finishedAt, cost_usd: totalCostUsd, tokens_used: totalTokensUsed, nodes_produced: nodesProduced, nodes_skipped: nodesSkipped });

		const progressInsert: AnalysisProgressInsert = {
			analyzerId: analyzer.def.id, analyzerVersionId: analyzer.version.versionId, configId: config.id, sessionId,
			cursorJson: JSON.stringify({ lastUnitIndex: units.length }), lastRunId: runId,
			totalAnalyzed: (progress?.total_analyzed ?? 0) + nodesProduced, status: "ok", updatedAt: finishedAt,
		};
		upsertAnalysisProgress(this.db, progressInsert);

		return { runId, nodesProduced, nodesSkipped, costUsd: totalCostUsd, tokensUsed: totalTokensUsed, durationMs: totalDurationMs };
	}

	async runAll(sessionId: string, configOverrides?: Record<string, Partial<AnalyzerConfig>>, modelTiers?: ModelTierConfig): Promise<FrameworkRunAllResult> {
		const order = this.topologicalSort();
		const results: FrameworkRunResult[] = [];
		let totalNodesProduced = 0; let totalNodesSkipped = 0; let totalCostUsd = 0; let totalTokensUsed = 0;
		const errors: string[] = [];

		for (const analyzerId of order) {
			try {
				const config = configOverrides?.[analyzerId];
				const result = await this.runAnalyzer(analyzerId, sessionId, config, modelTiers);
				results.push(result);
				totalNodesProduced += result.nodesProduced; totalNodesSkipped += result.nodesSkipped;
				totalCostUsd += result.costUsd; totalTokensUsed += result.tokensUsed;
			} catch (err) { errors.push(`${analyzerId}: ${err instanceof Error ? err.message : String(err)}`); }
		}

		return { results, totalNodesProduced, totalNodesSkipped, totalCostUsd, totalTokensUsed, errors };
	}

	private getMessages(sessionId: string): MessageRow[] {
		const rows = getFullSessionMessages(this.db, sessionId);
		return rows.map(r => ({ ...r, content_text: r.content_text ?? "", content_thinking: r.content_thinking ?? "" }));
	}

	private getDependencyNodes(analyzerId: string, _sessionId: string): Record<string, AnalysisNodeRow[]> {
		const analyzer = this.analyzers.get(analyzerId);
		if (!analyzer) return {};
		const result: Record<string, AnalysisNodeRow[]> = {};
		for (const depId of analyzer.def.dependencies) { result[depId] = getAnalysisNodesByAnalyzer(this.db, depId); }
		return result;
	}

	private topologicalSort(): string[] {
		const visited = new Set<string>(); const order: string[] = []; const visiting = new Set<string>();
		const visit = (id: string) => {
			if (visited.has(id)) return; if (visiting.has(id)) return; visiting.add(id);
			const analyzer = this.analyzers.get(id);
			if (analyzer) { for (const dep of analyzer.def.dependencies) visit(dep); }
			visiting.delete(id); visited.add(id); order.push(id);
		};
		for (const id of this.analyzers.keys()) visit(id);
		return order;
	}

	private async callLLM(_request: LLMRequest, _modelTiers?: ModelTierConfig): Promise<LLMResponse> {
		throw new Error("LLM calls are not available outside Pi. Install pi-prospector as a Pi extension to enable LLM analysis.");
	}
}