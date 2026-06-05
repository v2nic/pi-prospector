import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSourceSetHash, computeInputHash, computePromptBundleHash, computePromptHash, computeDedupKey } from "../../src/analyze/input-hash.js";

describe("computeSourceSetHash", () => {
	it("produces deterministic hash for same sources", () => {
		const sources = [{ kind: "message" as const, id: "msg-1" }, { kind: "message" as const, id: "msg-2" }];
		assert.equal(computeSourceSetHash(sources), computeSourceSetHash(sources));
	});
	it("order-independent: same sources in different order produce same hash", () => {
		const s1 = [{ kind: "message" as const, id: "msg-1" }, { kind: "message" as const, id: "msg-2" }];
		const s2 = [{ kind: "message" as const, id: "msg-2" }, { kind: "message" as const, id: "msg-1" }];
		assert.equal(computeSourceSetHash(s1), computeSourceSetHash(s2));
	});
	it("different sources produce different hashes", () => {
		const s1 = [{ kind: "message" as const, id: "msg-1" }];
		const s2 = [{ kind: "message" as const, id: "msg-2" }];
		assert.notEqual(computeSourceSetHash(s1), computeSourceSetHash(s2));
	});
});

describe("computeInputHash", () => {
	it("produces deterministic hash for same inputs", () => {
		assert.equal(computeInputHash("a", "v1", "cfg", "pb", "ss"), computeInputHash("a", "v1", "cfg", "pb", "ss"));
	});
	it("produces different hash for different analyzer", () => {
		assert.notEqual(computeInputHash("a", "v1", "cfg", "pb", "ss"), computeInputHash("b", "v1", "cfg", "pb", "ss"));
	});
});

describe("computePromptBundleHash", () => {
	it("order-independent", () => {
		assert.equal(computePromptBundleHash(["abc", "def", "ghi"]), computePromptBundleHash(["ghi", "abc", "def"]));
	});
});

describe("computePromptHash", () => {
	it("returns first 16 chars of SHA-256", () => {
		assert.equal(computePromptHash("hello world").length, 16);
	});
	it("deterministic", () => {
		assert.equal(computePromptHash("test"), computePromptHash("test"));
	});
});

describe("computeDedupKey", () => {
	it("normalizes title case and whitespace", () => {
		assert.equal(computeDedupKey("agents_md", "", "friction", "Agent reads too much"), computeDedupKey("agents_md", "", "friction", "  Agent   reads   too   much  "));
	});
	it("different target types produce different keys", () => {
		assert.notEqual(computeDedupKey("agents_md", "", "friction", "Same title"), computeDedupKey("config", "", "friction", "Same title"));
	});
});