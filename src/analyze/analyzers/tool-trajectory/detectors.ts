/**
 * Trajectory signal detectors.
 *
 * Each detector receives the full ordered stream of normalised tool calls for a
 * session and returns zero or more TrajectorySignal objects. Detectors are pure
 * functions with no side effects.
 */

import type { NormalizedToolCall } from "./arg-parser.js";

export type TrajectoryPattern = "stuck-loop" | "polling-loop" | "oscillation" | "pre-flight-gap";

export interface TrajectorySignal {
	/** Which pattern was detected. */
	pattern: TrajectoryPattern;
	/** The tool name involved. */
	tool: string;
	/** Normalised arguments of the representative call. */
	normalizedArgs: string;
	/** How many times the pattern repeated. */
	count: number;
	/** Message ids of the participating tool calls. */
	messageIds: string[];
	/** Human-readable description. */
	description: string;
}

export interface ToolCallWithResult {
	call: NormalizedToolCall;
	/** Whether the tool result was an error. */
	isError: boolean;
	/** The role of the message carrying the tool result. */
	resultMessageId: string;
}

/**
 * Detect stuck-loops: the same (tool + normalised args) repeated N≥threshold
 * times without an intervening success or state change.
 *
 * A stuck-loop is the broadest repetition pattern — any tool called repeatedly
 * with near-identical arguments. If the repeated tool is read-only, this is
 * additionally classified as a polling-loop (detected separately).
 */
export function detectStuckLoops(
	calls: ToolCallWithResult[],
	threshold: number,
): TrajectorySignal[] {
	const signals: TrajectorySignal[] = [];
	// Group consecutive runs of near-identical calls (same tool + target)
	// that are not interrupted by a success on a different call.
	let i = 0;
	while (i < calls.length) {
		const current = calls[i]!;
		// Find the end of a run of near-identical calls
		let j = i + 1;
		let lastSuccess = !current.isError;
		while (j < calls.length && isNearIdenticalCall(current.call, calls[j]!.call)) {
			if (!calls[j]!.isError) lastSuccess = true;
			j++;
		}
		const runLength = j - i;
		if (runLength >= threshold && !lastSuccess) {
			const participants = calls.slice(i, j);
			signals.push({
				pattern: "stuck-loop",
				tool: current.call.tool,
				normalizedArgs: current.call.normalizedArgs,
				count: runLength,
				messageIds: participants.map((p) => p.call.messageId),
				description: `${current.call.tool} called ${runLength}× with near-identical args without success: ${current.call.normalizedArgs}`,
			});
		}
		i = j;
	}
	return signals;
}

/**
 * Detect polling-loops: a read-only command repeated N≥threshold times.
 *
 * A polling-loop is a specialisation of stuck-loop where the tool is read-only.
 * It is detected separately so it can carry a different weight.
 */
export function detectPollingLoops(
	calls: ToolCallWithResult[],
	threshold: number,
): TrajectorySignal[] {
	const signals: TrajectorySignal[] = [];
	// Group consecutive runs of near-identical read-only calls
	let i = 0;
	while (i < calls.length) {
		const current = calls[i]!;
		if (!current.call.readOnly) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < calls.length && isNearIdenticalCall(current.call, calls[j]!.call) && calls[j]!.call.readOnly) {
			j++;
		}
		const runLength = j - i;
		if (runLength >= threshold) {
			const participants = calls.slice(i, j);
			signals.push({
				pattern: "polling-loop",
				tool: current.call.tool,
				normalizedArgs: current.call.normalizedArgs,
				count: runLength,
				messageIds: participants.map((p) => p.call.messageId),
				description: `Read-only ${current.call.tool} called ${runLength}× polling for state: ${current.call.normalizedArgs}`,
			});
		}
		i = j;
	}
	return signals;
}

/**
 * Detect oscillation: an action followed later by its inverse on the same target,
 * within a sliding window.
 *
 * For git push, oscillation is detected when two force-pushes or a push followed
 * by a force-push target the same ref with different content. For checkout, when
 * the agent switches back to a previously visited branch. For file operations,
 * when a create is followed by a delete (or vice versa) on the same path.
 */
export function detectOscillation(
	calls: ToolCallWithResult[],
	window: number,
): TrajectorySignal[] {
	const signals: TrajectorySignal[] = [];

	for (let i = 0; i < calls.length; i++) {
		const current = calls[i]!.call;
		const currentKey = inverseActionKey(current);
		if (!currentKey) continue;

		// Look ahead within the window for an inverse
		for (let j = i + 1; j < Math.min(i + window, calls.length); j++) {
			const later = calls[j]!.call;

			// Same action key means potential inverse on same target
			const laterKey = inverseActionKey(later);
			if (laterKey !== currentKey) continue;

			// For checkout: check if the target switches back
			if (current.subcommand === "git checkout" || current.subcommand === "git switch") {
				if (current.target !== later.target && current.target !== "") {
					// Different target — look for a return to original target
					for (let k = j + 1; k < Math.min(i + window, calls.length); k++) {
						const returnCall = calls[k]!.call;
						if ((returnCall.subcommand === "git checkout" || returnCall.subcommand === "git switch") && returnCall.target === current.target) {
							signals.push({
								pattern: "oscillation",
								tool: "bash",
								normalizedArgs: `git checkout ${current.target} → ${later.target} → ${current.target}`,
								count: 3,
								messageIds: [current.messageId, later.messageId, returnCall.messageId],
								description: `Checkout oscillation: ${current.target} → ${later.target} → ${current.target}`,
							});
							break;
						}
					}
				}
			} else {
				// For push/create-delete patterns: same key, different targets means reversal
				if (current.target === later.target && current.target !== "") {
					// Avoid self-match (same exact call)
					if (current.normalizedArgs === later.normalizedArgs) continue;
					signals.push({
						pattern: "oscillation",
						tool: current.tool,
						normalizedArgs: `${current.normalizedArgs} ↔ ${later.normalizedArgs}`,
						count: 2,
						messageIds: [current.messageId, later.messageId],
						description: `Oscillation: ${current.normalizedArgs} then reversed by ${later.normalizedArgs}`,
					});
				}
			}
		}
	}
	return signals;
}

/**
 * Detect pre-flight gaps: a mutating command that fails on a missing precondition
 * that an earlier command in the session could have established.
 *
 * Patterns detected:
 * - `mv`/`cp` into a non-existent directory (no prior `mkdir`)
 * - `git push` of a branch that doesn't exist upstream (no prior `git push --set-upstream`)
 * - `edit`/`write` to a path where the parent directory doesn't exist
 */
export function detectPreFlightGaps(
	calls: ToolCallWithResult[],
): TrajectorySignal[] {
	const signals: TrajectorySignal[] = [];
	const establishedDirs = new Set<string>();
	const establishedBranches = new Set<string>();

	for (const entry of calls) {
		const { call, isError } = entry;

		// Track directories that were created
		if (call.subcommand === "mkdir" || call.tool === "bash") {
			if (call.subcommand === "mkdir") {
				const parsed = parseSimpleBash(call.normalizedArgs);
				if (parsed.rest[0]) {
					establishedDirs.add(parsed.rest[0]);
				}
			}
		}

		// Track branches that were pushed with --set-upstream
		if (call.normalizedArgs.includes("--set-upstream") || call.normalizedArgs.includes("-u")) {
			// Extract branch name from git push -u origin <branch>
			const parsed = parseSimpleBash(call.normalizedArgs);
			const branchIdx = parsed.rest.indexOf("origin") >= 0 ? parsed.rest.length - 1 : -1;
			if (branchIdx >= 0 && parsed.rest[branchIdx]) {
				establishedBranches.add(parsed.rest[branchIdx]);
			}
		}

		// Check for pre-flight gaps on mutating commands that failed
		if (!isError) continue; // Only flag failures

		// Pattern 1: mv/cp into non-existent directory
		if (call.tool === "bash" && (call.normalizedArgs.startsWith("mv ") || call.normalizedArgs.startsWith("cp "))) {
			const parsed = parseSimpleBash(call.normalizedArgs);
			// Destination is the last argument
			const dest = parsed.rest[parsed.rest.length - 1];
			if (dest) {
				// Check if destination directory was established
				const destDir = dest.includes("/") ? dest.substring(0, dest.lastIndexOf("/")) : ".";
				if (destDir !== "." && !establishedDirs.has(destDir)) {
					signals.push({
						pattern: "pre-flight-gap",
						tool: "bash",
						normalizedArgs: call.normalizedArgs,
						count: 1,
						messageIds: [call.messageId],
						description: `Pre-flight gap: ${parsed.base} into non-existent directory '${destDir}' (no prior mkdir)`,
					});
				}
			}
		}

		// Pattern 2: git push of untracked branch (no prior --set-upstream)
		if (call.subcommand === "git push" && call.target) {
			if (!establishedBranches.has(call.target) && call.normalizedArgs.includes("no upstream")) {
				signals.push({
					pattern: "pre-flight-gap",
					tool: "bash",
					normalizedArgs: call.normalizedArgs,
					count: 1,
					messageIds: [call.messageId],
					description: `Pre-flight gap: git push of branch '${call.target}' without --set-upstream`,
				});
			}
		}

		// Pattern 3: edit/write to a path where parent dir doesn't exist
		if ((call.tool === "edit" || call.tool === "write") && call.target) {
			const parentDir = call.target.includes("/") ? call.target.substring(0, call.target.lastIndexOf("/")) : ".";
			if (parentDir !== "." && !establishedDirs.has(parentDir)) {
				signals.push({
					pattern: "pre-flight-gap",
					tool: call.tool,
					normalizedArgs: call.normalizedArgs,
					count: 1,
					messageIds: [call.messageId],
					description: `Pre-flight gap: ${call.tool} to non-existent parent directory '${parentDir}'`,
				});
			}
		}
	}
	return signals;
}

/**
 * Run all detectors and return combined, deduplicated signals.
 */
export function detectAllSignals(
	calls: ToolCallWithResult[],
	config: {
		stuckLoopMin: number;
		pollingLoopMin: number;
		oscillationWindow: number;
	},
): TrajectorySignal[] {
	const stuckLoops = detectStuckLoops(calls, config.stuckLoopMin);
	const pollingLoops = detectPollingLoops(calls, config.pollingLoopMin);
	const oscillations = detectOscillation(calls, config.oscillationWindow);
	const preFlightGaps = detectPreFlightGaps(calls);

	// Deduplicate: a polling-loop is also a stuck-loop; keep both with their
	// own weights. But remove a stuck-loop that is entirely contained within a
	// polling-loop (same message ids) to avoid double-counting the same calls.
	const pollingIds = new Set(pollingLoops.flatMap((p) => p.messageIds));
	const filteredStuckLoops = stuckLoops.filter(
		(sl) => !sl.messageIds.every((id) => pollingIds.has(id)),
	);

	return [...filteredStuckLoops, ...pollingLoops, ...oscillations, ...preFlightGaps];
}

// ──────────────────────────── helpers ────────────────────────────

function isNearIdenticalCall(a: NormalizedToolCall, b: NormalizedToolCall): boolean {
	if (a.tool !== b.tool) return false;
	if (a.subcommand !== b.subcommand) return false;
	return a.target === b.target;
}

function inverseActionKey(call: NormalizedToolCall): string | null {
	if (call.subcommand === "git push" || call.subcommand === "git push --force") {
		return `git-push:${call.target}`;
	}
	if (call.subcommand === "git checkout" || call.subcommand === "git switch") {
		return `git-checkout`;
	}
	if (call.subcommand === "git add") return `git-add:${call.target}`;
	if (call.subcommand === "git rm") return `git-rm:${call.target}`;
	if (call.tool === "bash") {
		const parsed = parseSimpleBash(call.normalizedArgs);
		if (parsed.base === "mkdir") return `mkdir-rm:${parsed.rest[0] ?? ""}`;
		if (parsed.base === "rm" || parsed.base === "rm -r" || parsed.base === "rm -rf") return `mkdir-rm:${parsed.rest[0] ?? ""}`;
		if (parsed.base === "mv") return `mv:${parsed.rest[0] ?? ""}`;
	}
	if (call.tool === "write") return `write:${call.target}`;
	return null;
}

function parseSimpleBash(normalized: string): { base: string; flags: string[]; rest: string[] } {
	const tokens = normalized.split(/\s+/);
	const base = tokens[0] ?? "";
	const flags: string[] = [];
	const rest: string[] = [];
	for (const tok of tokens.slice(1)) {
		if (tok.startsWith("-")) {
			flags.push(tok);
		} else {
			rest.push(tok);
		}
	}
	return { base, flags, rest };
}