/**
 * Correction and friction detection patterns.
 *
 * These regex sets are matched against user message text. They are
 * intentionally simple — false positives get filtered by the LLM
 * pass in turn-pair-llm. The deterministic pass is meant to flag
 * candidates cheaply.
 *
 * Categories:
 *   - strong_explicit: clearly corrective ("no, use X", "actually...")
 *   - weak_explicit: hedged but corrective ("could you try X", "maybe Y")
 *   - negation: leading negative words that flip intent
 *   - repetition: same intent, different words
 */

export type CorrectionType = "explicit" | "implicit" | "repetition" | null;

export interface CorrectionMatch {
	pattern: string;
	type: NonNullable<CorrectionType>;
	matched: string;
}

const STRONG_EXPLICIT: RegExp[] = [
	/\bno[,.\s]+(use|do|that's|that's|that is|it'?s|it is)\b/i,
	/\bnot\s+that\b/i,
	/\bnot\s+like\s+(that|this)\b/i,
	/\bno,\s+\w/i,                            // "no, do X"
	/\bdon'?t\s+(do|use|run|edit|add|remove|change|try)\b/i,
	/\bstop\s+(doing|using|running|trying)\b/i,
	/\bthat'?s\s+wrong\b/i,
	/\bthat\s+is\s+wrong\b/i,
	/\bthat'?s\s+not\s+what\b/i,
	/\bthat\s+is\s+not\s+what\b/i,
	/\bthat'?s\s+incorrect\b/i,
	/\bthat'?s\s+incorrect\b/i,
	/\binstead\s+of\s+(that|this)\b/i,
	/\binstead,?\s+\w/i,
	/\bI\s+said\b/i,
	/\bI\s+told\s+you\b/i,
	/\bI\s+already\s+(said|told|mentioned)\b/i,
	/\bI\s+meant\b/i,
	/\bactually[,.\s]/i,
	/\bI\s+meant\s+to\s+say\b/i,
];

const WEAK_EXPLICIT: RegExp[] = [
	/\bcould\s+you\s+(please\s+)?(try|use|do|change|switch)\b/i,
	/\bmaybe\s+(we|you|try)\b/i,
	/\bperhaps\s+(we|you|try)\b/i,
	/\bwhy\s+don'?t\s+you\b/i,
	/\bcan\s+you\s+(try|use|do)\s+instead\b/i,
	/\bprefer\s+to\s+(use|do)\b/i,
	/\bplease\s+(use|do|try)\b/i,
	/\bshould\s+(use|do|be)\b/i,
	/\bjust\s+\w+\b/i,                        // "just do X" — often corrective
];

const NEGATION: RegExp[] = [
	/^\s*no\b/i,
	/^\s*not\b/i,
	/^\s*never\b/i,
	/^\s*don'?t\b/i,
	/^\s*doesn'?t\b/i,
	/^\s*didn'?t\b/i,
	/^\s*won'?t\b/i,
	/^\s*can'?t\b/i,
	/^\s*shouldn'?t\b/i,
	/^\s*wouldn'?t\b/i,
	/^\s*isn'?t\b/i,
	/^\s*aren'?t\b/i,
];

/**
 * Detect a correction in the given user text. Returns the first
 * match found, or null.
 *
 * Strong patterns take priority over weak patterns. Negation is
 * only flagged in isolation (the user must lead with a negative
 * word, not use one mid-sentence).
 */
export function detectCorrection(text: string | null): CorrectionMatch | null {
	if (!text) return null;
	for (const re of STRONG_EXPLICIT) {
		const m = re.exec(text);
		if (m) return { pattern: re.source, type: "explicit", matched: m[0] };
	}
	for (const re of WEAK_EXPLICIT) {
		const m = re.exec(text);
		if (m) return { pattern: re.source, type: "explicit", matched: m[0] };
	}
	for (const re of NEGATION) {
		const m = re.exec(text);
		if (m) return { pattern: re.source, type: "explicit", matched: m[0] };
	}
	return null;
}

/**
 * Returns all matched patterns, not just the first. Used by the
 * `correction_patterns` field on a turn-pair node.
 */
export function detectAllCorrectionPatterns(text: string | null): string[] {
	if (!text) return [];
	const matched: string[] = [];
	for (const re of STRONG_EXPLICIT) if (re.test(text)) matched.push(re.source);
	for (const re of WEAK_EXPLICIT) if (re.test(text)) matched.push(re.source);
	for (const re of NEGATION) if (re.test(text)) matched.push(re.source);
	return matched;
}

/**
 * Detect if a user message is repeating a prior request without
 * new content. We use a simple length-based heuristic: if the
 * message is short (< 40 chars) and the prior user message also
 * exists in the session, the chance of repetition is high.
 *
 * A proper "repetition" detector would compare embeddings; this
 * is a cheap signal only.
 */
export function detectRepetition(text: string | null, priorUserText: string | null): boolean {
	if (!text) return false;
	if (text.length > 40) return false;
	if (!priorUserText) return false;
	const overlap = sharedTokenCount(text, priorUserText);
	return overlap >= 2;
}

function sharedTokenCount(a: string, b: string): number {
	const aTokens = new Set(a.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	const bTokens = new Set(b.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
	let count = 0;
	for (const t of aTokens) if (bTokens.has(t)) count++;
	return count;
}

/**
 * Extract the corrective instruction itself — the part of the
 * message that is corrective. We use a simple heuristic: take the
 * substring after the matched pattern.
 */
export function extractCorrectionText(text: string, match: CorrectionMatch): string {
	const idx = text.toLowerCase().indexOf(match.matched.toLowerCase());
	if (idx < 0) return text;
	return text.slice(idx + match.matched.length).trim().slice(0, 240) || match.matched;
}
