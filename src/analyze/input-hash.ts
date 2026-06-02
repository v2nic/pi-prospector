/**
 * Hashing primitives for the analyzer framework.
 *
 * Three different hashes are computed for a node:
 *
 *   source_set_hash  -- SHA-256 of the sorted source refs (what went in)
 *   prompt_bundle_hash -- SHA-256 of sorted prompt hashes used
 *   input_hash       -- SHA-256(analyzer_id | version_id | config_id
 *                                     | prompt_bundle_hash | source_set_hash)
 *
 * The input_hash uniquely identifies a node produced by a given recipe
 * on a given source set, regardless of which model produced it. The
 * model is metadata on the analysis_run, not part of the recipe.
 *
 * All hashes are the first 16 hex chars of SHA-256 (64 bits). This is
 * ample for a local-first indexer. The full 64-hex digest is also
 * computed when needed for the prompt_registry, but the first-16 form
 * is what gets stored on analysis_nodes rows.
 */

import { createHash, randomUUID } from "node:crypto";

/** Return the first 16 hex chars of SHA-256(input). */
export function shortHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Return the full 64 hex chars of SHA-256(input). */
export function fullHash(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash a list of {kind, id} refs in a canonical, sort-stable way so
 * that {ref1, ref2} and {ref2, ref1} produce the same digest.
 */
export function computeSourceSetHash(refs: ReadonlyArray<{ kind: string; id: string }>): string {
	const sorted = [...refs]
		.map((r) => `${r.kind}:${r.id}`)
		.sort();
	return shortHash(sorted.join("|"));
}

/**
 * Hash a list of prompt hashes (the content addresses of the prompts
 * an analyzer used for a run). Analyzers may use multiple prompts
 * (e.g. map + reduce); the bundle is the sorted concatenation.
 */
export function computePromptBundleHash(promptHashes: ReadonlyArray<string>): string {
	const sorted = [...promptHashes].sort();
	return shortHash(sorted.join("|"));
}

/**
 * Compute the recipe hash: the unique identity of a node produced by
 * (analyzer_id, version_id, config_id, prompts) on (source set).
 */
export function computeInputHash(args: {
	analyzerId: string;
	analyzerVersionId: string;
	configId: string;
	promptBundleHash: string;
	sourceSetHash: string;
}): string {
	const joined = [
		args.analyzerId,
		args.analyzerVersionId,
		args.configId,
		args.promptBundleHash,
		args.sourceSetHash,
	].join("|");
	return shortHash(joined);
}

/**
 * Hash a config object in a stable way: sort keys recursively so
 * {"a":1,"b":2} and {"b":2,"a":1} hash the same.
 */
export function computeConfigHash(config: Record<string, unknown>): string {
	return shortHash(canonicalJsonStringify(config));
}

/**
 * Stable JSON serialization with sorted keys at every level.
 * Used for hashing configs and content_json.
 */
export function canonicalJsonStringify(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortValue);
	if (v && typeof v === "object") {
		const obj = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			out[key] = sortValue(obj[key]);
		}
		return out;
	}
	return v;
}

/**
 * Generate a time-sortable UUID (UUIDv7-like).
 *
 * The first 48 bits encode the current millisecond timestamp in
 * big-endian. This means rows inserted in time order naturally sort
 * by primary key, which is convenient for cursors and progress.
 *
 * We don't depend on `crypto.randomUUID` being v7 — Node 22's is v4.
 * We construct v7 ourselves so the framework doesn't have to wait for
 * a runtime upgrade.
 */
export function uuidv7(): string {
	const buf = new Uint8Array(16);
	// 48-bit timestamp (ms)
	const ts = Date.now();
	buf[0] = (ts / 2 ** 40) & 0xff;
	buf[1] = (ts / 2 ** 32) & 0xff;
	buf[2] = (ts / 2 ** 24) & 0xff;
	buf[3] = (ts / 2 ** 16) & 0xff;
	buf[4] = (ts / 2 ** 8) & 0xff;
	buf[5] = ts & 0xff;
	// version (7) and variant (10xx)
	buf[6] = 0x70 | (Math.random() * 0x0f) & 0x0f;
	buf[7] = 0x80 | (Math.random() * 0x3f) & 0x3f;
	// random tail
	for (let i = 8; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
	const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A wrapper used for tests so we can stub the clock. */
export function newId(): string {
	return uuidv7();
}

/**
 * Determine a stable config_id for an analyzer. The default is a
 * v7 UUID, but if the config has a 'label' field we mix it in so
 * the same labeled config always gets the same id within a session
 * (callers can override the strategy).
 */
export function newConfigId(_config: Record<string, unknown>): string {
	return uuidv7();
}

/**
 * Generate a randomUUID (Node's, which is v4) for analysis_run ids.
 * We don't need time-ordering for runs — the started_at column is
 * what we sort by.
 */
export function newRunId(): string {
	return randomUUID();
}
