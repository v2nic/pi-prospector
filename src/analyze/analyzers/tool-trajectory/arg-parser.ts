/**
 * Argument normalisation for tool-call trajectory analysis.
 *
 * The trajectory detectors need to compare tool calls for "sameness" and
 * identify inverse actions. Raw tool-call arguments are too variable for direct
 * comparison, so this module normalises them into a structured shape:
 *
 *   - For `bash` calls: parse the `command` string into a base command and
 *     flags, normalising away incidental differences (e.g. `--force` vs `-f`,
 *     flag order, whitespace). The normalised form is the canonical string
 *     representation used for comparison.
 *   - For `gh` and `git` calls: extract the subcommand and key positional
 *     arguments so that `gh pr view 29` and `gh pr view 29 --json state` are
 *     recognised as "near-identical" (same subcommand + same target, different
 *     flags).
 *   - For structured tool calls (e.g. `edit`, `read`): extract the primary
 *     positional arguments (file path) so that repeated edits to the same file
 *     are detected.
 *
 * The output is a `NormalizedToolCall` that the detectors compare.
 */

export interface NormalizedToolCall {
	/** Tool name (e.g. "bash", "gh", "git", "edit"). */
	tool: string;
	/** Normalised argument string — canonical form for comparison. */
	normalizedArgs: string;
	/** Is this tool call read-only (no mutation to filesystem or remote)? */
	readOnly: boolean;
	/** Parsed subcommand for gh/git, or base command for bash; empty string if unknown. */
	subcommand: string;
	/** Target identifier — the primary positional argument (file path, ref, PR number, etc.). */
	target: string;
	/** Original message id carrying this tool call. */
	messageId: string;
}

/** Known read-only bash command prefixes. */
const READ_ONLY_BASH_PREFIXES = new Set([
	"cat", "ls", "find", "grep", "head", "tail", "wc", "git status", "git log",
	"git diff", "git branch --list", "git remote", "gh pr view", "gh run list",
	"gh pr list", "gh pr checks", "which", "echo", "pwd", "test", "true",
	"node --version", "npm list",
]);

/** Known read-only gh subcommands. */
const READ_ONLY_GH_SUBCOMMANDS = new Set(["view", "list", "checks", "api"]);

/** Known read-only git subcommands. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "branch", "remote", "show", "rev-parse",
	"ls-files", "ls-remote", "describe", "tag --list",
]);

/** Known read-only tool names. */
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep"]);

/** Known mutating git subcommands. */
const MUTATING_GIT_SUBCOMMANDS = new Set([
	"push", "checkout", "add", "commit", "merge", "rebase", "reset", "stash",
	"rm", "mv", "fetch", "pull", "clone", "init", "am", "apply", "cherry-pick",
	"clean", "restore", "switch",
]);

/** Known mutating gh subcommands. */
const MUTATING_GH_SUBCOMMANDS = new Set([
	"create", "edit", "close", "merge", "ready", "review", "label", "comment",
]);

/** Known inverse-action pairs for oscillation detection. */
const INVERSE_PAIRS: Array<[string, string]> = [
	["git push", "git reset"],
	["git push", "git push --force"], // force push can undo a prior push
	["git checkout", "git checkout"], // checkout x then checkout y (same subcommand, different target)
	["git add", "git rm"],
	["git stash push", "git stash pop"],
	["git branch --delete", "git checkout -b"], // delete then recreate
	["create", "delete"],
	["mkdir", "rm -r"],
	["mv", "mv"], // mv A B then mv B A
];

/**
 * Parse a bash command string into a normalised form.
 * Strips leading/trailing whitespace, collapses multiple spaces, and
 * extracts the base command + flags.
 */
function normalizeBashCommand(command: string): { base: string; flags: string[]; rest: string[] } {
	const trimmed = command.trim();
	// Split by whitespace, preserving quoted segments loosely
	const tokens: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	for (const ch of trimmed) {
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}
		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}
		if (ch === " " && !inSingleQuote && !inDoubleQuote) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);

	if (tokens.length === 0) return { base: "", flags: [], rest: [] };

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
	// Sort flags for normalisation
	flags.sort();
	return { base, flags, rest };
}

/**
 * Determine if a bash command is read-only (no mutation to filesystem/remote).
 */
function isBashReadOnly(command: string): boolean {
	const normalized = command.trimStart();
	// Check known read-only prefixes
	for (const prefix of READ_ONLY_BASH_PREFIXES) {
		if (normalized.startsWith(prefix)) return true;
	}
	// Check for common read-only patterns
	if (/^(cat|ls|find|grep|head|tail|wc|which|echo|pwd|test|true|type|file|stat)\s/.test(normalized)) return true;
	if (/^git\s+(status|log|diff|branch|remote|show|rev-parse|ls-files|ls-remote|describe|tag\s+--list)/.test(normalized)) return true;
	if (/^gh\s+(pr\s+)?(view|list|checks|api)/.test(normalized)) return true;
	return false;
}

/**
 * Parse a git subcommand from a bash command that starts with "git".
 */
function parseGitSubcommand(command: string): { subcommand: string; target: string } {
	const { base, rest } = normalizeBashCommand(command);
	const subcmd = rest[0] ?? "";
	// For git push, target is the ref (last positional before flags, or "HEAD")
	let target = "";
	if (subcmd === "push") {
		// git push <remote> <ref> → target is the ref
		target = rest[2] ?? rest[1] ?? "";
	} else if (subcmd === "checkout" || subcmd === "switch") {
		target = rest[1] ?? "";
	} else if (subcmd === "add" || subcmd === "rm") {
		target = rest[1] ?? "";
	} else if (subcmd === "commit") {
		target = rest[1] ?? "";
	} else {
		target = rest.slice(1).join(" ");
	}
	return { subcommand: `git ${subcmd}`, target };
}

/**
 * Parse a gh subcommand from a bash command that starts with "gh".
 */
function parseGhSubcommand(command: string): { subcommand: string; target: string } {
	const { rest } = normalizeBashCommand(command);
	// gh <resource> <action> <target>
	// e.g. "gh pr view 29" → subcommand="pr view", target="29"
	const resource = rest[0] ?? "";
	const action = rest[1] ?? "";
	const subcommand = resource && action ? `${resource} ${action}` : resource;
	const target = rest[2] ?? "";
	return { subcommand, target };
}

/**
 * Normalise a tool call's arguments into a structured NormalizedToolCall.
 */
export function normalizeToolCall(call: {
	name: string;
	args?: Record<string, unknown>;
	messageId: string;
}): NormalizedToolCall {
	const { name, args, messageId } = call;

	if (name === "bash" && args) {
		const command = typeof args["command"] === "string" ? args["command"] as string : "";
		const parsed = normalizeBashCommand(command);
		const readOnly = isBashReadOnly(command);

		if (parsed.base === "git" && parsed.rest.length > 0) {
			const { subcommand, target } = parseGitSubcommand(command);
			// Normalise: "git <subcmd> <target> <sorted-flags>"
			const flagsPart = parsed.flags.length > 0 ? ` ${parsed.flags.join(" ")}` : "";
			const normalizedArgs = `${subcommand} ${target}${flagsPart}`.trim();
			return { tool: "bash", normalizedArgs, readOnly, subcommand, target, messageId };
		}

		if (parsed.base === "gh" && parsed.rest.length > 0) {
			const { subcommand, target } = parseGhSubcommand(command);
			const flagsPart = parsed.flags.length > 0 ? ` ${parsed.flags.join(" ")}` : "";
			const normalizedArgs = `gh ${subcommand} ${target}${flagsPart}`.trim();
			const ghReadOnly = READ_ONLY_GH_SUBCOMMANDS.has(subcommand.split(" ")[1] ?? "");
			return { tool: "bash", normalizedArgs, readOnly: readOnly || ghReadOnly, subcommand: `gh ${subcommand}`, target, messageId };
		}

		// Generic bash: normalise to "base <sorted-flags> <rest-joined>"
		const flagsPart = parsed.flags.length > 0 ? ` ${parsed.flags.join(" ")}` : "";
		const restPart = parsed.rest.length > 0 ? ` ${parsed.rest.join(" ")}` : "";
		const normalizedArgs = `${parsed.base}${flagsPart}${restPart}`.trim();
		return {
			tool: "bash",
			normalizedArgs,
			readOnly,
			subcommand: parsed.base,
			target: parsed.rest[0] ?? "",
			messageId,
		};
	}

	if (name === "bash") {
		return { tool: "bash", normalizedArgs: "", readOnly: true, subcommand: "", target: "", messageId };
	}

	// Structured tool calls
	if (READ_ONLY_TOOLS.has(name)) {
		const filePath = typeof args?.["file_path"] === "string" ? args["file_path"] as string : "";
		const pattern = typeof args?.["pattern"] === "string" ? args["pattern"] as string : "";
		return {
			tool: name,
			normalizedArgs: filePath || pattern ? `${name} ${filePath || pattern}` : name,
			readOnly: true,
			subcommand: "",
			target: filePath || pattern,
			messageId,
		};
	}

	// edit, write, mkdir — mutating tools
	if (name === "edit" || name === "write") {
		const filePath = typeof args?.["file_path"] === "string" ? args["file_path"] as string : "";
		return {
			tool: name,
			normalizedArgs: filePath ? `${name} ${filePath}` : name,
			readOnly: false,
			subcommand: "",
			target: filePath,
			messageId,
		};
	}

	// Generic tool
	const argsStr = args ? JSON.stringify(Object.entries(args).sort()) : "";
	return {
		tool: name,
		normalizedArgs: argsStr,
		readOnly: READ_ONLY_TOOLS.has(name),
		subcommand: "",
		target: "",
		messageId,
	};
}

/**
 * Check whether two normalised tool calls are "near-identical" — same tool,
 * same normalised args (up to flag-order differences which normalisation
 * already removes), within a tolerance.
 */
export function isNearIdentical(a: NormalizedToolCall, b: NormalizedToolCall): boolean {
	if (a.tool !== b.tool) return false;
	if (a.subcommand !== b.subcommand) return false;
	// For polling/loop detection: same subcommand + same target is "near-identical"
	// even if flags differ. The normalized args contain flags, so we check
	// subcommand + target for looser matching, and full normalizedArgs for
	// strict matching.
	return a.target === b.target;
}

/**
 * Check whether two normalised tool calls are "exactly identical" — same tool
 * and same normalised arguments string.
 */
export function isExactlyIdentical(a: NormalizedToolCall, b: NormalizedToolCall): boolean {
	return a.tool === b.tool && a.normalizedArgs === b.normalizedArgs;
}

/**
 * Build the inverse-action key for oscillation detection.
 * Returns a key such that if action A and action B have the same key,
 * they are inverses of each other on the same target.
 */
export function inverseActionKey(call: NormalizedToolCall): string | null {
	// For git push: the inverse is a force-push that restores an old ref
	if (call.subcommand === "git push" || call.subcommand === "git push --force") {
		return `git-push:${call.target}`;
	}
	// For git checkout/switch: oscillation on the same target pattern
	if (call.subcommand === "git checkout" || call.subcommand === "git switch") {
		return `git-checkout`;
	}
	// For file create/delete
	if (call.tool === "bash") {
		const parsed = normalizeBashCommand(call.normalizedArgs);
		if (parsed.base === "mkdir") return `mkdir-rm:${parsed.rest[0] ?? ""}`;
		if (parsed.base === "rm" || parsed.base === "rm -r" || parsed.base === "rm -rf") return `mkdir-rm:${parsed.rest[0] ?? ""}`;
		if (parsed.base === "mv") return `mv:${parsed.rest[0] ?? ""}`;
	}
	// For tool create/delete patterns
	if (call.tool === "write") return `write:${call.target}`;
	return null;
}