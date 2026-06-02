import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/schema.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import type {
	Analyzer,
	AnalyzerDef,
	AnalysisResult,
	AnalysisUnit,
	AnalyzerConfig,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	LLMRequest,
	LLMResponse,
	LLMCaller,
	AnalyzerVersion,
	PromptVersion,
	AnalysisNodeRow,
} from "../../src/analyze/types.js";
import { REF_KINDS, EDGE_KINDS } from "../../src/analyze/types.js";

function tempDb(): { db: Database.Database; close: () => void } {
	const dbPath = path.join(os.tmpdir(), `prospect-fw-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const db = new Database(dbPath);
	migrate(db);
	return { db, close: () => { db.close(); try { fs.unlinkSync(dbPath); } catch {} } };
}

function seedSession(db: Database.Database, sessionId: string, messages: Array<{ id: string; role: string; text: string }>) {
	db.prepare(`INSERT INTO sessions (id, file_path, project, cwd, parent_session, started_at, last_line, last_modified, message_count) VALUES (?, ?, '', '', NULL, ?, 0, 0, 0)`).run(sessionId, `/fake/${sessionId}.jsonl`, "2026-01-01T00:00:00Z");
	for (const m of messages) {
		db.prepare(`
			INSERT INTO messages (id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, meta_json)
			VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL)
		`).run(m.id, sessionId, "2026-01-01T00:00:00Z", m.role, m.text);
	}
	db.prepare(`UPDATE sessions SET message_count = ? WHERE id = ?`).run(messages.length, sessionId);
}

const STUB_LLM: LLMCaller = async (_req: LLMRequest): Promise<LLMResponse> => {
	return { text: "{}", model: "stub/model", costUsd: 0, tokensUsed: 0, durationMs: 0 };
};

function makeSimpleAnalyzer(overrides: Partial<{
	id: string;
	dependencies: string[];
	planFn: (ctx: AnalyzerPlanContext) => Promise<AnalysisUnit[]>;
	analyzeFn: (unit: AnalysisUnit, ctx: AnalyzerRunContext) => Promise<AnalysisResult>;
}>): Analyzer {
	const def: AnalyzerDef = {
		id: overrides.id ?? "test-analyzer",
		label: "Test",
		description: "test",
		anchorSpan: "pair",
		dependencies: overrides.dependencies ?? [],
	};
	const version: AnalyzerVersion = {
		analyzerId: def.id,
		versionId: "0.0.1",
		implementationKind: "deterministic",
	};
	const config: AnalyzerConfig = {
		id: "",
		analyzerId: def.id,
		configJson: {},
		configHash: "",
		label: "default",
	};
	return {
		def,
		version,
		prompts: {} as Record<string, PromptVersion>,
		defaultConfig: config,
		async plan(ctx) {
			return overrides.planFn ? overrides.planFn(ctx) : [{
				sources: ctx.messages.map((m) => ({ kind: "message", id: m.id })),
				sourceSetHash: "fake-hash",
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			}];
		},
		async analyze(unit, ctx) {
			return overrides.analyzeFn
				? overrides.analyzeFn(unit, ctx)
				: {
					contentJson: { hello: "world" },
					nodeKind: "metric",
					anchorKind: "session",
					anchorRef: ctx.run.session_id,
					edges: [{
						toRefKind: REF_KINDS.SESSION,
						toRefId: ctx.run.session_id,
						edgeKind: EDGE_KINDS.ANCHORS,
					}],
				};
		},
	};
}

describe("AnalyzerFramework — registration and lookup", () => {
	it("registers an analyzer and persists def/version/prompts", () => {
		const { db, close } = tempDb();
		try {
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({ id: "a1" }));
			assert.equal(fw.list().length, 1);

			const def = db.prepare("SELECT * FROM analyzer_defs WHERE id = ?").get("a1") as any;
			assert.ok(def);
			assert.equal(def.label, "Test");

			const v = db.prepare("SELECT * FROM analyzer_versions WHERE analyzer_id = ?").get("a1") as any;
			assert.ok(v);
			assert.equal(v.version_id, "0.0.1");
		} finally {
			close();
		}
	});

	it("is idempotent on re-registration", () => {
		const { db, close } = tempDb();
		try {
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({ id: "a1" }));
			fw.register(makeSimpleAnalyzer({ id: "a1" }));
			assert.equal(fw.list().length, 1);
		} finally {
			close();
		}
	});
});

describe("AnalyzerFramework — run()", () => {
	it("produces a node and a session-anchored edge", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);

			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({ id: "a1" }));
			const summary = await fw.run("a1", "s1");

			assert.equal(summary.status, "ok");
			assert.equal(summary.nodesProduced, 1);
			assert.equal(summary.nodesSkipped, 0);

			const node = db.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ?").get("a1") as any;
			assert.ok(node);
			assert.equal(node.session_id, "s1");
			assert.equal(node.node_kind, "metric");

			const edges = db.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?").all(node.id) as any[];
			assert.ok(edges.length >= 1);
			const anchor = edges.find((e: any) => e.to_ref_kind === "session" && e.to_ref_id === "s1");
			assert.ok(anchor);
		} finally {
			close();
		}
	});

	it("is idempotent on re-run (no new nodes)", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({ id: "a1" }));

			const r1 = await fw.run("a1", "s1");
			assert.equal(r1.nodesProduced, 1);
			assert.equal(r1.nodesSkipped, 0);

			const r2 = await fw.run("a1", "s1");
			assert.equal(r2.nodesProduced, 0);
			assert.equal(r2.nodesSkipped, 1);

			const count = (db.prepare("SELECT COUNT(*) as c FROM analysis_nodes").get() as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			close();
		}
	});

	it("creates a fresh node when source set changes", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			// Custom plan that hashes by message count — different sources → different hash
			fw.register(makeSimpleAnalyzer({
				id: "a1",
				planFn: async (ctx) => [{
					sources: ctx.messages.map((m) => ({ kind: "message", id: m.id })),
					sourceSetHash: `hash-${ctx.messages.length}`,
					anchorKind: "session",
					anchorRef: ctx.sessionId,
				}],
			}));

			const r1 = await fw.run("a1", "s1");
			assert.equal(r1.nodesProduced, 1);

			// Add a message and re-run
			db.prepare(`INSERT INTO messages (id, session_id, parent_id, timestamp, role, content_text) VALUES ('m3', 's1', NULL, '2026-01-01T00:00:05Z', 'user', 'again')`).run();
			const r2 = await fw.run("a1", "s1");
			assert.equal(r2.nodesProduced, 1);
			assert.equal(r2.nodesSkipped, 0);
		} finally {
			close();
		}
	});

	it("captures LLM cost and tokens on the run row", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const llm: LLMCaller = async () => ({ text: "x", model: "x/y", costUsd: 0.01, tokensUsed: 100, durationMs: 5 });
			const fw = new AnalyzerFramework({ db, llm });
			fw.register(makeSimpleAnalyzer({
				id: "a1",
				analyzeFn: async (_u, ctx) => ({
					contentJson: {},
					nodeKind: "metric",
					anchorKind: "session",
					anchorRef: ctx.run.session_id,
					edges: [],
					modelUsed: "x/y",
					costUsd: 0.01,
					tokensUsed: 100,
				}),
			}));
			await fw.run("a1", "s1");

			const run = db.prepare("SELECT * FROM analysis_runs WHERE analyzer_id = ?").get("a1") as any;
			assert.ok(run);
			assert.equal(run.cost_usd, 0.01);
			assert.equal(run.tokens_used, 100);
		} finally {
			close();
		}
	});

	it("inserts an error node if analyze() throws, but continues", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({
				id: "a1",
				planFn: async (ctx) => [
					{
						sources: [{ kind: "message", id: ctx.messages[0]!.id }],
						sourceSetHash: "h1",
						anchorKind: "session",
						anchorRef: ctx.sessionId,
					},
					{
						sources: [{ kind: "message", id: ctx.messages[1]!.id }],
						sourceSetHash: "h2",
						anchorKind: "session",
						anchorRef: ctx.sessionId,
					},
				],
				analyzeFn: async (unit) => {
					if (unit.sourceSetHash === "h1") throw new Error("boom");
					return {
						contentJson: { ok: true },
						nodeKind: "metric",
						anchorKind: "session",
						anchorRef: unit.anchorRef ?? "s1",
						edges: [],
					};
				},
			}));

			const r = await fw.run("a1", "s1");
			assert.equal(r.nodesProduced, 1);

			const errorNode = db.prepare("SELECT * FROM analysis_nodes WHERE node_kind = 'error'").get() as any;
			assert.ok(errorNode);
			assert.match(JSON.parse(errorNode.content_json).error, /boom/);

			const okNode = db.prepare("SELECT * FROM analysis_nodes WHERE node_kind = 'metric'").get() as any;
			assert.ok(okNode);
		} finally {
			close();
		}
	});
});

describe("AnalyzerFramework — proposal materialization", () => {
	it("materializes proposals from a summary node's content_json.improvement_proposals", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({
				id: "session-overview",
				analyzeFn: async (_u, ctx) => ({
					nodeKind: "summary",
					anchorKind: "session",
					anchorRef: ctx.run.session_id,
					edges: [],
					contentJson: {
						improvement_proposals: [{
							target_type: "skill",
							target_path: "skill/foo",
							title: "Add a foo skill",
							summary: "Tests show confusion about foo",
							detail: "Add a skill",
							evidence: "User repeatedly asked",
							confidence: 0.7,
							severity: "suggestion",
						}],
					},
				}),
			}));

			await fw.run("session-overview", "s1");

			const proposals = db.prepare("SELECT * FROM proposals WHERE session_id = ?").all("s1") as any[];
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0].target_type, "skill");
			assert.equal(proposals[0].title, "Add a foo skill");
			assert.equal(proposals[0].status, "open");
			assert.equal(proposals[0].analyzer_id, "session-overview");

			const proposalNode = db.prepare("SELECT * FROM analysis_nodes WHERE node_kind = 'proposal'").get() as any;
			assert.ok(proposalNode);

			const producesEdges = db.prepare("SELECT * FROM analysis_edges WHERE edge_kind = 'produces'").all() as any[];
			assert.ok(producesEdges.length >= 1);
			assert.equal(producesEdges[0].to_ref_id, proposalNode.id);
		} finally {
			close();
		}
	});

	it("dedups proposals on (target_type, target_path, severity, normalized title)", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			seedSession(db, "s2", [
				{ id: "n1", role: "user", text: "hi" },
				{ id: "n2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({
				id: "session-overview",
				analyzeFn: async (_u, ctx) => ({
					nodeKind: "summary",
					anchorKind: "session",
					anchorRef: ctx.run.session_id,
					edges: [],
					contentJson: {
						improvement_proposals: [{
							target_type: "skill",
							target_path: "skill/foo",
							title: "Add a Foo Skill.",  // trailing punctuation
							summary: "s",
							detail: "",
							evidence: "",
							confidence: 0.5,
							severity: "suggestion",
						}],
					},
				}),
			}));

			await fw.run("session-overview", "s1");
			await fw.run("session-overview", "s2");

			const proposals = db.prepare("SELECT * FROM proposals").all() as any[];
			assert.equal(proposals.length, 1, "should dedup to a single open proposal");
		} finally {
			close();
		}
	});
});

describe("AnalyzerFramework — dependency visibility", () => {
	it("inserts an error node when a child reads a non-declared dependency", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({ id: "child", dependencies: [] }));
			fw.register(makeSimpleAnalyzer({
				id: "parent",
				dependencies: ["child"],
				analyzeFn: async (_u, ctx) => {
					// Try to read a non-declared dependency
					ctx.getDependencyNodes("not-declared");
					return {
						nodeKind: "metric",
						anchorKind: "session",
						anchorRef: ctx.run.session_id,
						edges: [],
						contentJson: {},
					};
				},
			}));

			const r = await fw.run("parent", "s1");
			assert.equal(r.nodesProduced, 0);
			assert.equal(r.status, "ok");
			const errorNode = db.prepare("SELECT * FROM analysis_nodes WHERE node_kind = 'error'").get() as any;
			assert.ok(errorNode);
			const content = JSON.parse(errorNode.content_json);
			assert.match(content.error, /did not declare/);
		} finally {
			close();
		}
	});

	it("exposes own nodes and declared dependency nodes in plan context", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });

			// First analyzer: produces nodes for the session
			fw.register(makeSimpleAnalyzer({
				id: "producer",
				analyzeFn: async (_u, ctx) => ({
					nodeKind: "metric",
					anchorKind: "session",
					anchorRef: ctx.run.session_id,
					edges: [],
					contentJson: { from: "producer" },
				}),
			}));
			await fw.run("producer", "s1");

			// Second analyzer: declares dependency on producer
			let observedDeps: Record<string, AnalysisNodeRow[]> = {};
			fw.register(makeSimpleAnalyzer({
				id: "consumer",
				dependencies: ["producer"],
				planFn: async (ctx) => {
					observedDeps = ctx.dependencyNodes;
					return [{
						sources: ctx.messages.map((m) => ({ kind: "message", id: m.id })),
						sourceSetHash: "h",
						anchorKind: "session",
						anchorRef: ctx.sessionId,
					}];
				},
				analyzeFn: async (_u, ctx) => ({
					nodeKind: "summary",
					anchorKind: "session",
					anchorRef: ctx.run.session_id,
					edges: [],
					contentJson: {},
				}),
			}));
			await fw.run("consumer", "s1");

			assert.ok(observedDeps["producer"]);
			assert.equal(observedDeps["producer"]!.length, 1);
		} finally {
			close();
		}
	});
});

describe("AnalyzerFramework — crash recovery", () => {
	it("marks stale 'running' runs as 'error'", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1", [
				{ id: "m1", role: "user", text: "hi" },
				{ id: "m2", role: "assistant", text: "ok" },
			]);
			const fw = new AnalyzerFramework({ db, llm: STUB_LLM });
			fw.register(makeSimpleAnalyzer({ id: "a1" }));

			// Inject a stale 'running' row
			db.prepare(`
				INSERT INTO analysis_runs (id, analyzer_id, analyzer_version_id, config_id, session_id, status, prompt_bundle_hash, started_at)
				VALUES (?, 'a1', '0.0.1', 'c1', 's1', 'running', 'ph', '2026-01-01T00:00:00Z')
			`).run("stale-1");

			const n = fw.recoverStaleRuns();
			assert.equal(n, 1);

			const row = db.prepare("SELECT status, error_message FROM analysis_runs WHERE id = ?").get("stale-1") as any;
			assert.equal(row.status, "error");
			assert.match(row.error_message, /stale/);
		} finally {
			close();
		}
	});
});
