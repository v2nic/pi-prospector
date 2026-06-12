import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { sessionOverviewAnalyzer } from "../../src/analyze/analyzers/session-overview/index.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { listProposals } from "../../src/db/queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({
			sentiment: "frustrated",
			friction_type: "wrong_approach",
			is_genuine_correction: true,
			severity: "high",
			rationale: "user corrected the approach",
		});
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "a segment", notable_points: ["point"] });
	}
	// reduce
	return JSON.stringify({
		session_summary: "The agent took a wrong approach and was corrected.",
		key_friction_points: [{ description: "wrong approach to auth", severity: "high" }],
		improvement_proposals: [
			{
				target_type: "agents_md",
				target_path: "AGENTS.md § Auth",
				title: "Document the auth module location",
				summary: "Tell the agent where auth code lives",
				detail: "Add a note pointing at src/auth.",
				evidence: "User corrected the agent in turn 2.",
				confidence: 0.7,
				severity: "correction",
			},
		],
	});
}

function respondCleanRecovery(req: LLMRequest): string {
	const sys = req.system ?? "";
	// turn-pair-llm for the high-signal corrected turn
	if (sys.includes("classify a single turn")) {
		// The first turn had a correction but was followed by clean recovery
		return JSON.stringify({
			sentiment: "frustrated",
			friction_type: "wrong_approach",
			is_genuine_correction: true,
			severity: "medium",
			rationale: "user corrected the approach",
		});
	}
	// reduce: produce a reinforcement proposal for the clean recovery
	return JSON.stringify({
		session_summary: "The agent was corrected once but recovered well, completing the task cleanly afterward.",
		key_friction_points: [{ description: "initial wrong approach", severity: "low" }],
		key_positive_signals: [
			{ description: "agent recovered quickly after correction", signal: "correction-then-clean-recovery" },
		],
		improvement_proposals: [
			{
				target_type: "agents_md",
				target_path: "AGENTS.md § Recovery",
				title: "Encode clean recovery pattern",
				summary: "When corrected, the agent immediately pivoted and completed the task without further friction.",
				detail: "Add a standing instruction: after a user correction, acknowledge and immediately try the corrected approach.",
				evidence: "Turn 1 had a correction; turns 2+ were friction-free.",
				confidence: 0.8,
				severity: "reinforcement",
			},
		],
	});
}

function respondCleanSession(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		// shouldn't be called for a clean session (no high_signal pairs)
		return JSON.stringify({ sentiment: "neutral", friction_type: "none", is_genuine_correction: false, severity: "low", rationale: "no friction" });
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "smooth segment", notable_points: ["task completed without correction"] });
	}
	// reduce: produce a clean overview with a reinforcement proposal
	return JSON.stringify({
		session_summary: "This was a smooth session with no friction. The agent completed the task without corrections or tool failures.",
		key_friction_points: [],
		key_positive_signals: [
			{ description: "task completed without any correction", signal: "task-completed-without-correction" },
			{ description: "no tool failures throughout", signal: "low-tool-failure-density" },
		],
		improvement_proposals: [
			{
				target_type: "agents_md",
				title: "Reinforce clean workflow pattern",
				summary: "The agent's approach was efficient and correct throughout this session.",
				detail: "Consider documenting this as a reference workflow for similar tasks.",
				evidence: "All turns had low friction scores; no corrections or tool failures.",
				confidence: 0.6,
				severity: "reinforcement",
			},
		],
	});
}

function seedSession(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id);
	insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ role: "user", text: "no, that's wrong, use the auth module instead" },
		{ role: "assistant", text: "understood, fixing now" },
	]);
}

describe("analyzers end-to-end", () => {
	it("runs the full pipeline and materialises proposals", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db, "s1");
			const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);

			const summary = await fw.run("s1", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const kinds = db.prepare("SELECT node_kind, COUNT(*) AS c FROM analysis_nodes GROUP BY node_kind").all() as Array<{ node_kind: string; c: number }>;
			const byKind = Object.fromEntries(kinds.map((k) => [k.node_kind, k.c]));
			assert.ok(byKind["metric"] >= 2, "expected turn-pair-core metric nodes");
			assert.ok(byKind["classification"] >= 1, "expected at least one llm classification node");
			assert.equal(byKind["summary"], 1, "expected one session-overview summary node");

			assert.ok(summary.proposalsCreated >= 1);
			const proposals = listProposals(db);
			assert.equal(proposals.length, 1);
			assert.equal(proposals[0]!.target_type, "agents_md");
			assert.ok(summary.costUsd > 0);

			// The LLM was only consulted for high-signal pairs + the overview.
			assert.ok(mock.calls.length >= 2);
		} finally {
			close();
		}
	});

	it("enforces maxPairsPerSession as a cost guard, enriching highest-friction turns first", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s3");
			const msgs = [];
			for (let i = 0; i < 6; i++) {
				msgs.push({ role: "user", text: `no, that's wrong, do approach number ${i} instead please` });
				msgs.push({ role: "assistant", text: `ok approach ${i}`, toolCalls: [{ name: "read" }] });
				msgs.push({ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] });
			}
			insertMessages(db, "s3", msgs);

			const mock = createMockLLM({ responder: respond, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			fw.register(turnPairCoreAnalyzer);
			// turn-pair-llm variant whose cost guard allows only two enrichments.
			const cappedLLM = {
				...turnPairLLMAnalyzer,
				defaultConfig: {
					...turnPairLLMAnalyzer.defaultConfig,
					configJson: { ...turnPairLLMAnalyzer.defaultConfig.configJson, maxPairsPerSession: 2 },
				},
			};
			fw.register(cappedLLM);

			await fw.run("s3", {});

			const coreRows = db.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id='turn-pair-core'").all() as Array<{ content_json: string }>;
			const highSignal = coreRows.filter((r) => (JSON.parse(r.content_json) as { high_signal: boolean }).high_signal).length;
			assert.ok(highSignal > 2, `expected more than the cap of high-signal pairs, got ${highSignal}`);

			const classifications = (db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id='turn-pair-llm'").get() as { c: number }).c;
			assert.equal(classifications, 2, "llm enrichment is capped at maxPairsPerSession");
			const classifyCalls = mock.calls.filter((c) => (c.system ?? "").includes("classify a single turn"));
			assert.equal(classifyCalls.length, 2, "the model is called only for the capped set");
		} finally {
			close();
		}
	});

	it("exercises the map-reduce path when the digest is large", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s2");
			// Many corrective turns so the digest exceeds the (tiny) threshold.
			const msgs = [];
			for (let i = 0; i < 6; i++) {
				msgs.push({ role: "user", text: `no, that's wrong, do approach number ${i} instead please` });
				msgs.push({ role: "assistant", text: `ok approach ${i}` });
			}
			insertMessages(db, "s2", msgs);

			const mock = createMockLLM({ responder: respond, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });

			// session-overview variant with tiny map-reduce thresholds.
			const tinyOverview = {
				...sessionOverviewAnalyzer,
				defaultConfig: {
					...sessionOverviewAnalyzer.defaultConfig,
					configJson: {
						mapTier: "cheap",
						reduceTier: "mid",
						temperature: 0,
						mapReduceOverChars: 50,
						segmentChars: 80,
						maxSegments: 12,
					},
				},
			};
			fw.register(turnPairCoreAnalyzer);
			fw.register(turnPairLLMAnalyzer);
			fw.register(tinyOverview);

			const summary = await fw.run("s2", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// At least one map call must have happened (summarise one segment).
			const mapCalls = mock.calls.filter((c) => (c.system ?? "").includes("summarise one segment"));
			assert.ok(mapCalls.length >= 1, "expected map-phase calls");
		} finally {
			close();
		}
		});

	it("clean-recovery session yields a reinforcement proposal", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s-recovery");
			// Turn 1: correction (high friction), turn 2+: clean recovery
			insertMessages(db, "s-recovery", [
				{ role: "user", text: "no, that's wrong, use the auth module" },
				{ role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
				{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
				{ role: "user", text: "great, now finish the task" },
				{ role: "assistant", text: "done, all working now" },
			]);

			const mock = createMockLLM({ responder: respondCleanRecovery, tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);

			const summary = await fw.run("s-recovery", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// Must produce a summary node
			const summaryNodes = db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE node_kind='summary'").get() as { c: number };
			assert.equal(summaryNodes.c, 1, "expected one session-overview summary node");

			// Must produce at least one proposal, and at least one should be reinforcement
			const proposals = listProposals(db);
			assert.ok(proposals.length >= 1, "expected at least one proposal");
			const reinforcementProposals = proposals.filter((p) => p.severity === "reinforcement");
			assert.ok(reinforcementProposals.length >= 1, "expected at least one reinforcement proposal");
		} finally {
			close();
		}
	});

	it("clean session yields a non-empty overview node", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "s-clean");
			// A completely clean session: no corrections, no tool failures, low friction
			insertMessages(db, "s-clean", [
				{ role: "user", text: "help me set up the project" },
				{ role: "assistant", text: "I'll set it up for you.", toolCalls: [{ name: "write" }] },
				{ role: "toolResult", toolResults: [{ toolName: "write", isError: false, textLength: 50 }] },
				{ role: "user", text: "looks good, thanks" },
				{ role: "assistant", text: "You're welcome!" },
			]);

			const mock = createMockLLM({ responder: respondCleanSession, tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);

			const summary = await fw.run("s-clean", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// Must produce a summary node even for a clean session
			const summaryRows = db.prepare("SELECT * FROM analysis_nodes WHERE node_kind='summary'").all();
			const summaryNodes: Record<string, unknown>[] = summaryRows as Record<string, unknown>[];
			assert.equal(summaryNodes.length, 1, "expected one session-overview summary node for clean session");

			// The summary node must have a non-empty session_summary
			const node = summaryNodes[0]!;
			const content = JSON.parse(node.content_json as string) as Record<string, unknown>;
			assert.ok(typeof content["session_summary"] === "string" && (content["session_summary"] as string).length > 0, "session_summary must be non-empty");

			// The session-overview should have positive signals
			const positiveSignals = content["key_positive_signals"];
			assert.ok(Array.isArray(positiveSignals), "key_positive_signals should be an array");
			assert.ok(positiveSignals.length >= 1, "clean session should have at least one positive signal");
		} finally {
			close();
		}
	});
});
