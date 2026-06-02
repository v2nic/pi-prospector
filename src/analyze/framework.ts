/**
 * AnalyzerFramework — registers, plans, runs, and materializes
 * analyzers over Pi session data.
 *
 * Design notes:
 *
 * 1. Idempotency: every node carries an `input_hash` derived from
 *    (analyzer, version, config, prompts, source_set). Before
 *    computing, we look it up; if a node exists, we skip. This makes
 *    re-runs cheap and crash recovery automatic.
 *
 * 2. Visibility: an analyzer can only see its own nodes and the
 *    nodes of analyzers listed in its `def.dependencies`. The
 *    framework enforces this when building the plan and run contexts.
 *
 * 3. Edges are the source of truth for graph relationships. There
 *    are no `parent_id` columns on nodes. Anchors, consumes, refines,
 *    uses_prompt, uses_config, produces are all explicit edge kinds.
 *
 * 4. Proposals materialize from analysis nodes whose `node_kind` is
 *    'proposal' (or whose content_json has an `improvement_proposals`
 *    array). Dedup is by (target_type, target_path, severity,
 *    normalize(title)).
 *
 * 5. Crash recovery: if a process dies mid-run, the run row is
 *    still 'running' and any in-flight node INSERTs that didn't
 *    finish leave no row. A subsequent call detects stale running
 *    runs and either re-runs them or marks them as 'error'.
 */

import type Database from "better-sqlite3";
import type {
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	Analyzer,
	AnalyzerConfig,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	LLMCaller,
	LLMRequest,
	MessageRow,
	ProgressRow,
	RunOptions,
	RunRow,
	RunSummary,
} from "./types.js";
import {
	computeInputHash,
	computePromptBundleHash,
	computeSourceSetHash,
	shortHash,
	uuidv7,
} from "./input-hash.js";
import {
	REF_KINDS,
	EDGE_KINDS,
	isEdgeKind,
	isRefKind,
	validateEdge,
} from "./edge-kinds.js";
import {
	createRun,
	findNodeByInputHash,
	insertEdge,
	insertNode,
	getAllSessionNodes,
	getMessage,
	getNode,
	getProgress,
	resolveConfig,
	upsertAnalyzerDef,
	upsertAnalyzerVersion,
	upsertProgress,
	updateRun,
	registerPrompt,
	findStaleRunningRuns,
	getAnchoredMessageIds,
} from "../db/analysis-queries.js";
import { materializeProposalsFromNode } from "./proposal-materializer.js";

export interface FrameworkDeps {
	db: Database.Database;
	llm: LLMCaller;
}

export class AnalyzerFramework {
	private readonly analyzers = new Map<string, Analyzer>();

	constructor(private readonly deps: FrameworkDeps) {}

	register(analyzer: Analyzer): void {
		// Idempotent registration
		if (this.analyzers.has(analyzer.def.id)) return;
		upsertAnalyzerDef(this.deps.db, analyzer.def);
		upsertAnalyzerVersion(this.deps.db, analyzer.version);
		for (const prompt of Object.values(analyzer.prompts)) {
			registerPrompt(this.deps.db, prompt);
		}
		this.analyzers.set(analyzer.def.id, analyzer);
	}

	get(id: string): Analyzer | undefined {
		return this.analyzers.get(id);
	}

	list(): Analyzer[] {
		return [...this.analyzers.values()];
	}

	/**
	 * Run one analyzer against one session with a given config (or default).
	 * Returns a RunSummary.
	 */
	async run(
		analyzerId: string,
		sessionId: string,
		opts: RunOptions & { model?: string; configOverride?: Record<string, unknown> } = {},
	): Promise<RunSummary> {
		const analyzer = this.analyzers.get(analyzerId);
		if (!analyzer) throw new Error(`Analyzer not registered: ${analyzerId}`);

		const config = resolveConfig(this.deps.db, {
			analyzerId: analyzer.def.id,
			configJson: opts.configOverride ?? analyzer.defaultConfig.configJson,
			label: analyzer.defaultConfig.label,
		});

		const promptBundleHash = computePromptBundleHash(
			Object.values(analyzer.prompts).map((p) => p.hash),
		);

		// Build plan context
		const messages = this.loadMessages(sessionId);
		const allNodes = getAllSessionNodes(this.deps.db, sessionId);
		const ownNodes = allNodes.filter((n) => n.analyzer_id === analyzer.def.id);
		const dependencyNodes = this.buildDependencyNodes(analyzer, allNodes);
		const progress = getProgress(this.deps.db, {
			analyzerId: analyzer.def.id,
			analyzerVersionId: analyzer.version.versionId,
			configId: config.id,
			sessionId,
		}) ?? null;

		const planCtx: AnalyzerPlanContext = {
			sessionId,
			messages,
			allNodes,
			ownNodes,
			dependencyNodes,
			progress,
			db: this.deps.db,
		};

		const units = await analyzer.plan(planCtx);

		// Pre-filter: drop units whose source_set_hash matches an
		// existing node UNLESS opts.force is set.
		const todoUnits: AnalysisUnit[] = [];
		let nodesSkipped = 0;
		for (const unit of units) {
			if (!opts.force) {
				const inputHash = computeInputHash({
					analyzerId: analyzer.def.id,
					analyzerVersionId: analyzer.version.versionId,
					configId: config.id,
					promptBundleHash,
					sourceSetHash: unit.sourceSetHash,
				});
				if (findNodeByInputHash(this.deps.db, inputHash)) {
					nodesSkipped++;
					continue;
				}
			}
			todoUnits.push(unit);
		}

		// Create the run row
		const runId = uuidv7();
		createRun(this.deps.db, {
			id: runId,
			analyzerId: analyzer.def.id,
			analyzerVersionId: analyzer.version.versionId,
			configId: config.id,
			sessionId,
			promptBundleHash,
			modelSpec: opts.model ?? undefined,
		});

		let nodesProduced = 0;
		let costUsd = 0;
		let tokensUsed = 0;
		let lastError: string | null = null;
		const status: "ok" | "error" | "partial" = "ok";

		try {
			upsertProgress(this.deps.db, {
				analyzerId: analyzer.def.id,
				analyzerVersionId: analyzer.version.versionId,
				configId: config.id,
				sessionId,
				cursorJson: JSON.stringify({ planned: todoUnits.length }),
				lastRunId: runId,
				totalAnalyzed: 0,
				status: "in_progress",
				errorMessage: null,
			});

			for (let i = 0; i < todoUnits.length; i++) {
				const unit = todoUnits[i]!;
				try {
					const result = await analyzer.analyze(unit, this.buildRunContext(analyzer, config, runId, promptsByName(analyzer), sessionId));
					const inputHash = computeInputHash({
						analyzerId: analyzer.def.id,
						analyzerVersionId: analyzer.version.versionId,
						configId: config.id,
						promptBundleHash,
						sourceSetHash: unit.sourceSetHash,
					});

					const nodeId = uuidv7();
					const now = new Date().toISOString();
					insertNode(this.deps.db, {
						id: nodeId,
						sessionId,
						analyzerId: analyzer.def.id,
						analyzerVersionId: analyzer.version.versionId,
						configId: config.id,
						runId,
						nodeKind: result.nodeKind,
						contentJson: JSON.stringify(result.contentJson),
						sourceSetHash: unit.sourceSetHash,
						inputHash,
						modelUsed: result.modelUsed,
						costUsd: result.costUsd,
						tokensUsed: result.tokensUsed,
						durationMs: result.durationMs,
						createdAt: now,
					});

					// Insert edges
					for (let e = 0; e < result.edges.length; e++) {
						const edge = result.edges[e]!;
						if (!isEdgeKind(edge.edgeKind)) {
							throw new Error(`Analyzer returned invalid edge_kind: ${String(edge.edgeKind)}`);
						}
						if (!isRefKind(edge.toRefKind)) {
							throw new Error(`Analyzer returned invalid to_ref_kind: ${String(edge.toRefKind)}`);
						}
						validateEdge(edge.edgeKind, edge.toRefKind);
						insertEdge(this.deps.db, {
							fromNodeId: nodeId,
							toRefKind: edge.toRefKind,
							toRefId: edge.toRefId,
							edgeKind: edge.edgeKind,
							ordinal: edge.ordinal ?? e,
						});
					}

					// If the node anchors to a session, add the session anchor
					// (the spec's "anchors" edges for session-anchored nodes
					// are explicit, but we add it if not present so traversal
					// queries always work).
					if (result.anchorKind === "session" && result.anchorRef) {
						insertEdge(this.deps.db, {
							fromNodeId: nodeId,
							toRefKind: REF_KINDS.SESSION,
							toRefId: result.anchorRef,
							edgeKind: EDGE_KINDS.ANCHORS,
							ordinal: 999,
						});
					}

					// Materialize any proposals embedded in this node
					if (result.nodeKind === "summary" || result.nodeKind === "proposal") {
						materializeProposalsFromNode(this.deps.db, {
							sessionId,
							analyzerId: analyzer.def.id,
							analyzerVersionId: analyzer.version.versionId,
							configId: config.id,
							runId,
							sourceNodeId: nodeId,
							sourceSetHash: unit.sourceSetHash,
							promptBundleHash,
							contentJson: result.contentJson,
							now,
						});
					}

					if (result.costUsd) costUsd += result.costUsd;
					if (result.tokensUsed) tokensUsed += result.tokensUsed;
					nodesProduced++;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					// Insert an error node so the unit isn't retried blindly
					try {
						const errorHash = computeInputHash({
							analyzerId: analyzer.def.id,
							analyzerVersionId: analyzer.version.versionId,
							configId: config.id,
							promptBundleHash,
							sourceSetHash: unit.sourceSetHash,
						});
						const now = new Date().toISOString();
						insertNode(this.deps.db, {
							id: uuidv7(),
							sessionId,
							analyzerId: analyzer.def.id,
							analyzerVersionId: analyzer.version.versionId,
							configId: config.id,
							runId,
							nodeKind: "error",
							contentJson: JSON.stringify({ error: lastError, unit_meta: unit.meta ?? null }),
							sourceSetHash: unit.sourceSetHash,
							inputHash: errorHash,
							createdAt: now,
						});
					} catch { /* ignore secondary error */ }
				}
			}

			updateRun(this.deps.db, runId, {
				status: "ok",
				finishedAt: new Date().toISOString(),
				costUsd,
				tokensUsed,
				nodesProduced,
				nodesSkipped,
			});

			upsertProgress(this.deps.db, {
				analyzerId: analyzer.def.id,
				analyzerVersionId: analyzer.version.versionId,
				configId: config.id,
				sessionId,
				cursorJson: JSON.stringify({ completed: todoUnits.length, skipped: nodesSkipped }),
				lastRunId: runId,
				totalAnalyzed: nodesProduced,
				status: "ok",
				errorMessage: null,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			updateRun(this.deps.db, runId, {
				status: "error",
				finishedAt: new Date().toISOString(),
				costUsd,
				tokensUsed,
				nodesProduced,
				nodesSkipped,
				errorMessage: msg,
			});
			upsertProgress(this.deps.db, {
				analyzerId: analyzer.def.id,
				analyzerVersionId: analyzer.version.versionId,
				configId: config.id,
				sessionId,
				cursorJson: null,
				lastRunId: runId,
				totalAnalyzed: nodesProduced,
				status: "error",
				errorMessage: msg,
			});
			return {
				runId,
				analyzerId: analyzer.def.id,
				analyzerVersionId: analyzer.version.versionId,
				sessionId,
				status: "error",
				nodesProduced,
				nodesSkipped,
				costUsd,
				tokensUsed,
			};
		}

		return {
			runId,
			analyzerId: analyzer.def.id,
			analyzerVersionId: analyzer.version.versionId,
			sessionId,
			status,
			nodesProduced,
			nodesSkipped,
			costUsd,
			tokensUsed,
		};
	}

	/**
	 * Find stale 'running' rows that have no recent activity. Mark
	 * them as 'error' so they don't block idempotent re-runs. Returns
	 * the number of runs marked.
	 */
	recoverStaleRuns(): number {
		const stale = findStaleRunningRuns(this.deps.db);
		for (const r of stale) {
			updateRun(this.deps.db, r.id, {
				status: "error",
				finishedAt: new Date().toISOString(),
				errorMessage: "Marked stale by recoverStaleRuns (no recent activity)",
			});
		}
		return stale.length;
	}

	// ── internals ──

	private loadMessages(sessionId: string): MessageRow[] {
		return this.deps.db.prepare(`
			SELECT id, session_id, parent_id, timestamp, role,
			       content_text, content_thinking, tool_calls, tool_results, meta_json
			FROM messages WHERE session_id = ? ORDER BY rowid ASC
		`).all(sessionId) as MessageRow[];
	}

	private buildDependencyNodes(analyzer: Analyzer, allNodes: AnalysisNodeRow[]): Record<string, AnalysisNodeRow[]> {
		const out: Record<string, AnalysisNodeRow[]> = {};
		for (const depId of analyzer.def.dependencies) {
			out[depId] = allNodes.filter((n) => n.analyzer_id === depId);
		}
		return out;
	}

	private buildRunContext(
		analyzer: Analyzer,
		config: AnalyzerConfig,
		runId: string,
		prompts: Record<string, string>,
		sessionId: string,
	): AnalyzerRunContext {
		const self = this;
		const runRow: RunRow = {
			id: runId,
			analyzer_id: analyzer.def.id,
			analyzer_version_id: analyzer.version.versionId,
			config_id: config.id,
			session_id: sessionId,
			status: "running",
			prompt_bundle_hash: computePromptBundleHash(Object.values(analyzer.prompts).map((p) => p.hash)),
			started_at: new Date().toISOString(),
			finished_at: null,
			model_spec: null,
			cost_usd: 0,
			tokens_used: 0,
			nodes_produced: 0,
			nodes_skipped: 0,
			error_message: null,
		};

		return {
			getMessage: (id) => getMessage(self.deps.db, id),
			getNode: (id) => getNode(self.deps.db, id),
			getDependencyNodes: (depId) => {
				if (!analyzer.def.dependencies.includes(depId)) {
					throw new Error(
						`Analyzer ${analyzer.def.id} tried to read dependency ${depId} but did not declare it. ` +
						`Add it to def.dependencies.`,
					);
				}
				return self.deps.db.prepare(`
					SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND session_id = ?
				`).all(depId, sessionId) as AnalysisNodeRow[];
			},
			getAnchoredMessages: (nodeId) => {
				const ids = getAnchoredMessageIds(self.deps.db, nodeId);
				return ids
					.map((id) => getMessage(self.deps.db, id))
					.filter((m): m is MessageRow => m !== undefined);
			},
			getSessionMessages: (sid) => self.loadMessages(sid),
			llm: (request: LLMRequest) => self.deps.llm(request),
			run: runRow,
			config,
			prompts,
		};
	}
}

function promptsByName(analyzer: Analyzer): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, p] of Object.entries(analyzer.prompts)) {
		out[name] = p.content;
	}
	return out;
}

// Re-export hashing helpers used by analyzers
export {
	computeInputHash,
	computeSourceSetHash,
	computePromptBundleHash,
	shortHash,
	uuidv7,
};
