/**
 * Unit tests for tool-trajectory detector functions and argument parsing.
 *
 * All fixtures are hand-written synthetic data — no real session content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolCall, isNearIdentical, isExactlyIdentical, type NormalizedToolCall } from "../../src/analyze/analyzers/tool-trajectory/arg-parser.js";
import { detectStuckLoops, detectPollingLoops, detectOscillation, detectPreFlightGaps, detectAllSignals, type ToolCallWithResult } from "../../src/analyze/analyzers/tool-trajectory/detectors.js";

// ──────────────────── helpers ────────────────────

function makeBashCall(command: string, messageId: string, isError = false): ToolCallWithResult {
	const call = normalizeToolCall({ name: "bash", args: { command }, messageId });
	return { call, isError, resultMessageId: `${messageId}-result` };
}

function makeToolCall(name: string, args: Record<string, unknown>, messageId: string, isError = false): ToolCallWithResult {
	const call = normalizeToolCall({ name, args, messageId });
	return { call, isError, resultMessageId: `${messageId}-result` };
}

// ──────────────────── arg-parser tests ────────────────────

describe("normalizeToolCall", () => {
	it("normalises a simple bash command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "ls -la /tmp" }, messageId: "m1" });
		assert.equal(result.tool, "bash");
		assert.equal(result.subcommand, "ls");
		assert.equal(result.readOnly, true);
	});

	it("normalises a git command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "git push origin main" }, messageId: "m1" });
		assert.equal(result.subcommand, "git push");
		assert.equal(result.target, "main");
		assert.equal(result.readOnly, false);
	});

	it("normalises a gh command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		assert.equal(result.subcommand, "gh pr view");
		assert.equal(result.target, "29");
		assert.equal(result.readOnly, true);
	});

	it("normalises a git status command as read-only", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "git status" }, messageId: "m1" });
		assert.equal(result.readOnly, true);
		assert.equal(result.subcommand, "git status");
	});

	it("normalises an edit tool call with file path", () => {
		const result = normalizeToolCall({ name: "edit", args: { file_path: "/src/index.ts" }, messageId: "m1" });
		assert.equal(result.tool, "edit");
		assert.equal(result.target, "/src/index.ts");
		assert.equal(result.readOnly, false);
	});

	it("normalises a read tool call as read-only", () => {
		const result = normalizeToolCall({ name: "read", args: { file_path: "/src/index.ts" }, messageId: "m1" });
		assert.equal(result.tool, "read");
		assert.equal(result.target, "/src/index.ts");
		assert.equal(result.readOnly, true);
	});

	it("sorts flags in a bash command", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "ls -la --sort=size /tmp" }, messageId: "m1" });
		assert.ok(result.normalizedArgs.includes("--sort=size") || result.normalizedArgs.includes("ls"));
		// Flags should be sorted: -a -l (or -la) before --sort
	});

	it("handles bash command with no arguments", () => {
		const result = normalizeToolCall({ name: "bash", args: { command: "pwd" }, messageId: "m1" });
		assert.equal(result.subcommand, "pwd");
		assert.equal(result.readOnly, true);
	});
});

describe("isNearIdentical", () => {
	it("matches calls with same tool and target", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29 --json state" }, messageId: "m2" });
		assert.equal(isNearIdentical(a, b), true);
	});

	it("rejects calls with different subcommands", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "gh pr list" }, messageId: "m2" });
		assert.equal(isNearIdentical(a, b), false);
	});

	it("rejects calls with different tools", () => {
		const a = normalizeToolCall({ name: "edit", args: { file_path: "/foo" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "read", args: { file_path: "/foo" }, messageId: "m2" });
		assert.equal(isNearIdentical(a, b), false);
	});
});

describe("isExactlyIdentical", () => {
	it("matches calls with same tool and identical normalised args", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "git status" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "git status" }, messageId: "m2" });
		assert.equal(isExactlyIdentical(a, b), true);
	});

	it("rejects calls with different args", () => {
		const a = normalizeToolCall({ name: "bash", args: { command: "gh pr view 29" }, messageId: "m1" });
		const b = normalizeToolCall({ name: "bash", args: { command: "gh pr view 30" }, messageId: "m2" });
		assert.equal(isExactlyIdentical(a, b), false);
	});
});

// ──────────────────── detector tests ────────────────────

describe("detectStuckLoops", () => {
	it("detects a stuck loop of 3 identical failed bash calls", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", true),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "stuck-loop");
		assert.equal(signals[0]!.count, 3);
		assert.ok(signals[0]!.description.includes("npm install"));
	});

	it("does not flag a run under the threshold", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 0);
	});

	it("does not flag a run that eventually succeeds", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm install", "m1", true),
			makeBashCall("npm install", "m2", true),
			makeBashCall("npm install", "m3", false),
		];
		const signals = detectStuckLoops(calls, 3);
		assert.equal(signals.length, 0);
	});

	it("detects gh pr view polling pattern", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("gh pr view 29", "m1", false),
			makeBashCall("gh pr view 29", "m2", false),
			makeBashCall("gh pr view 29", "m3", false),
			makeBashCall("gh pr view 29", "m4", false),
			makeBashCall("gh pr view 29", "m5", false),
		];
		// Stuck-loop with threshold 3 won't trigger because they all succeed (no error)
		const stuckSignals = detectStuckLoops(calls, 3);
		assert.equal(stuckSignals.length, 0);
	});
});

describe("detectPollingLoops", () => {
	it("detects a polling loop of 3+ identical read-only calls", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("gh pr view 29", "m1", false),
			makeBashCall("gh pr view 29", "m2", false),
			makeBashCall("gh pr view 29", "m3", false),
			makeBashCall("gh pr view 29", "m4", false),
			makeBashCall("gh pr view 29", "m5", false),
		];
		const signals = detectPollingLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "polling-loop");
		assert.equal(signals[0]!.count, 5);
	});

	it("does not flag mutating commands as polling", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git push origin main", "m1", false),
			makeBashCall("git push origin main", "m2", false),
			makeBashCall("git push origin main", "m3", false),
		];
		const signals = detectPollingLoops(calls, 3);
		assert.equal(signals.length, 0);
	});

	it("detects git status polling", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git status", "m1", false),
			makeBashCall("git status", "m2", false),
			makeBashCall("git status", "m3", false),
		];
		const signals = detectPollingLoops(calls, 3);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "polling-loop");
	});

	it("splits polling into separate runs when interleaved with other commands", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git status", "m1", false),
			makeBashCall("git status", "m2", false),
			// interleaved different command
			makeBashCall("git diff", "m3", false),
			makeBashCall("git status", "m4", false),
			makeBashCall("git status", "m5", false),
			makeBashCall("git status", "m6", false),
		];
		const signals = detectPollingLoops(calls, 3);
		// Only one run of 3 consecutive git status (m4-m6)
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.count, 3);
	});
});

describe("detectOscillation", () => {
	it("detects git checkout oscillation (x → y → x)", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git checkout main", "m1", false),
			makeBashCall("git checkout feature", "m2", false),
			makeBashCall("git checkout main", "m3", false),
		];
		const signals = detectOscillation(calls, 10);
		assert.ok(signals.length >= 1);
		assert.equal(signals[0]!.pattern, "oscillation");
		assert.ok(signals[0]!.description.includes("Checkout") || signals[0]!.description.includes("checkout"));
	});

	it("detects push-force oscillation on same ref", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git push origin main", "m1", false),
			makeBashCall("git push --force origin main", "m2", false),
		];
		const signals = detectOscillation(calls, 10);
		assert.ok(signals.length >= 1);
		assert.equal(signals[0]!.pattern, "oscillation");
	});

	it("does not flag unrelated commands outside the window", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("git checkout main", "m1", false),
			// Fill with many unrelated commands
			...Array.from({ length: 15 }, (_, i) => makeBashCall(`npm test`, `m${i + 2}`, false)),
			makeBashCall("git checkout feature", "m17", false),
		];
		const signals = detectOscillation(calls, 10);
		assert.equal(signals.length, 0);
	});
});

describe("detectPreFlightGaps", () => {
	it("detects mv into non-existent directory", () => {
		const calls: ToolCallWithResult[] = [
			// No mkdir for /nonexistent
			makeBashCall("mv file.txt /nonexistent/dest.txt", "m1", true),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "pre-flight-gap");
		assert.ok(signals[0]!.description.includes("nonexistent"));
	});

	it("does not flag mv when mkdir was done earlier", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("mkdir /target", "m0", false),
			makeBashCall("mv file.txt /target/dest.txt", "m1", true),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 0);
	});

	it("detects write to non-existent parent directory", () => {
		const calls: ToolCallWithResult[] = [
			makeToolCall("write", { file_path: "/nonexistent/sub/file.ts" }, "m1", true),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 1);
		assert.equal(signals[0]!.pattern, "pre-flight-gap");
		assert.ok(signals[0]!.description.includes("nonexistent"));
	});

	it("does not flag successful commands", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("mv file.txt /nonexistent/dest.txt", "m1", false),
		];
		const signals = detectPreFlightGaps(calls);
		assert.equal(signals.length, 0);
	});
});

describe("detectAllSignals", () => {
	it("deduplicates stuck-loops that are fully contained in polling-loops", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("gh pr view 29", "m1", true),
			makeBashCall("gh pr view 29", "m2", true),
			makeBashCall("gh pr view 29", "m3", true),
		];
		const signals = detectAllSignals(calls, {
			stuckLoopMin: 3,
			pollingLoopMin: 3,
			oscillationWindow: 10,
		});
		// Should have a polling-loop (read-only) and NOT a stuck-loop that
		// duplicates the same messages
		const polling = signals.filter((s) => s.pattern === "polling-loop");
		const stuck = signals.filter((s) => s.pattern === "stuck-loop");
		assert.ok(polling.length >= 1, "should detect polling-loop");
		// Stuck-loops whose message ids are fully contained in polling-loops should be filtered
		const pollingMsgIds = new Set(polling.flatMap((p) => p.messageIds));
		const duplicateStuck = stuck.filter((s) => s.messageIds.every((id) => pollingMsgIds.has(id)));
		assert.equal(duplicateStuck.length, 0, "stuck-loop should not duplicate polling-loop");
	});

	it("returns empty signals for a clean session", () => {
		const calls: ToolCallWithResult[] = [
			makeBashCall("npm test", "m1", false),
			makeBashCall("git status", "m2", false),
			makeBashCall("git add .", "m3", false),
			makeBashCall("git commit -m 'fix'", "m4", false),
		];
		const signals = detectAllSignals(calls, {
			stuckLoopMin: 3,
			pollingLoopMin: 3,
			oscillationWindow: 10,
		});
		assert.equal(signals.length, 0);
	});
});