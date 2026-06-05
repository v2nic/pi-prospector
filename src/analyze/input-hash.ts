/**
 * Hash computation utilities for the analyzer framework.
 * Design reference: docs/analyzer-design-c.md §3 Idempotency model
 */

import { createHash } from "node:crypto";
import type { SourceRef } from "./types.js";

/** Compute a source set hash from an array of source references. Sorts for determinism. */
export function computeSourceSetHash(sources: SourceRef[]): string {
	const sorted = [...sources].sort((a, b) => {
		const cmp = a.kind.localeCompare(b.kind);
		return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
	});
	const payload = sorted.map(r => `${r.kind}:${r.id}`).join("|");
	return sha256(payload);
}

/** Compute an input hash for idempotency checking. */
export function computeInputHash(
	analyzerId: string, analyzerVersionId: string, configId: string,
	promptBundleHash: string, sourceSetHash: string,
): string {
	const payload = [analyzerId, analyzerVersionId, configId, promptBundleHash, sourceSetHash].join("|");
	return sha256(payload);
}

/** Compute a prompt bundle hash from an array of prompt hashes. Sorts for determinism. */
export function computePromptBundleHash(promptHashes: string[]): string {
	const sorted = [...promptHashes].sort();
	return sha256(sorted.join("|"));
}

/** Compute a content hash for prompt registry (first 16 hex chars of SHA-256). */
export function computePromptHash(content: string): string {
	return sha256(content).slice(0, 16);
}

/** Compute a dedup key for proposals. */
export function computeDedupKey(targetType: string, targetPath: string | undefined, severity: string, title: string): string {
	const normalized = title.toLowerCase().trim().replace(/\s+/g, " ");
	const payload = `${targetType}|${targetPath ?? ""}|${severity}|${normalized}`;
	return sha256(payload);
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}