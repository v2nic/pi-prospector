/**
 * Correction/frustration regex patterns for turn-pair-core analyzer.
 */

/** Strong correction patterns — high confidence that the user is correcting the agent. */
export const STRONG_PATTERNS: readonly RegExp[] = [
	/\bno[,.!?\s]+\b(don't|do not|not|wrong|incorrect|stop|wait|actually|instead)\b/i,
	/\b(not|don't|do not|shouldn't|should not)\s+(use|do|say|write|put|add|remove|delete|call|run|execute)\b/i,
	/\bthat's?\s+(not|wrong|incorrect|off|not right|not what|not how|not the)\b/i,
	/\b(stop|quit|cancel|abort|undo)\s+(that|it|this|now|please)?\b/i,
	/\b(revert|rollback|undo)\s+(that|it|the|this|changes?)\b/i,
	/\binstead\b.*\b(use|try|do|say|write|put)\b/i,
	/\bi\s+(said|meant|wanted|meant to say)\b/i,
	/\bcorrection:?\b/i,
	/\bwrong[,.!?\s]/i,
	/\bincorrect[,.!?\s]/i,
];

/** Weak correction patterns — lower confidence, could be natural dialogue. */
export const WEAK_PATTERNS: readonly RegExp[] = [
	/\bactually\b/i,
	/\bwait\b/i,
	/\bno\b/i,
	/\bnot\s+(quite|exactly|really|necessarily)\b/i,
	/\b(re)?try\s+(again|once more|a different|another)\b/i,
	/\bmaybe\b.*\b(instead|different|else)\b/i,
];

/** Negation patterns — if these appear near a correction word, it's likely NOT a correction. */
export const NEGATION_PATTERNS: readonly RegExp[] = [
	/\b(that|this|it)\s+(is|was|seems|looks|appears)\s+(right|correct|good|fine|ok|perfect|exactly)\b/i,
	/\b(yes|yeah|yep|right|correct|good|great)\s*[,.!?]\b/i,
	/\blooks?\s+(good|great|fine|correct|right)\b/i,
	/\bof course\b/i,
];

/**
 * Classify a correction pattern.
 * Returns: 'explicit' (strong pattern, no negation), 'implicit' (weak pattern), 'repetition' (retry detected), or null.
 */
export function classifyCorrection(text: string, isRetry: boolean): { detected: boolean; type: "explicit" | "implicit" | "repetition" | null; patterns: string[]; correctionText: string | null } {
	const patterns: string[] = [];
	let hasStrong = false;
	let hasWeak = false;

	// Check negation context first
	for (const neg of NEGATION_PATTERNS) {
		if (neg.test(text)) { hasWeak = true; break; }
	}

	for (const pat of STRONG_PATTERNS) { if (pat.test(text)) { patterns.push(pat.source); hasStrong = true; } }
	if (!hasStrong) { for (const pat of WEAK_PATTERNS) { if (pat.test(text)) { patterns.push(pat.source); hasWeak = true; } } }

	if (isRetry) return { detected: true, type: "repetition", patterns, correctionText: extractCorrectionText(text) };
	if (hasStrong) return { detected: true, type: "explicit", patterns, correctionText: extractCorrectionText(text) };
	if (hasWeak) return { detected: true, type: "implicit", patterns, correctionText: extractCorrectionText(text) };
	return { detected: false, type: null, patterns: [], correctionText: null };
}

function extractCorrectionText(text: string): string | null {
	const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
	for (const sentence of sentences) {
		const trimmed = sentence.trim();
		if (trimmed.length > 0 && trimmed.length <= 200) {
			for (const pat of [...STRONG_PATTERNS, ...WEAK_PATTERNS]) { if (pat.test(trimmed)) return trimmed; }
		}
	}
	return null;
}