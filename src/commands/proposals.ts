import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listProposalsEnriched, acceptProposal, rejectProposal } from "../db/queries.js";
import { getDbPath } from "../config.js";

function output(ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function renderProposal(p: ReturnType<typeof listProposalsEnriched>[number]): string {
	const short = p.id.slice(0, 8);
	const target = p.target_type
		? `${p.target_type}${p.target_path ? `:${p.target_path}` : ""}`
		: "(unknown)";
	const title = p.title ? ` — ${p.title}` : "";
	return `[${p.status}] ${short} | ${p.severity} | ${target}${title}\n  ${p.summary}`;
}

export function registerProposalsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-proposals", {
		description: "List proposals (optionally filter by status: open, accepted, rejected, new)",
		handler: async (args: string, ctx: any) => {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const status = args?.trim() || undefined;
				const proposals = listProposalsEnriched(db, status);

				if (proposals.length === 0) {
					output(ctx, "No proposals found.");
					return;
				}

				const lines = proposals.map(renderProposal);
				output(ctx, `Proposals (${proposals.length}):\n${lines.join("\n")}`);
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("prospect-accept", {
		description: "Accept a proposal by ID",
		handler: async (args: string, ctx: any) => {
			const id = args?.trim();
			if (!id) { output(ctx, "Usage: /prospect-accept <id>", "warning"); return; }
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const ok = acceptProposal(db, id);
				output(ctx, ok ? `Proposal ${id} accepted.` : `Proposal ${id} not found or not in 'new'/'open' status.`, ok ? "info" : "warning");
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("prospect-reject", {
		description: "Reject a proposal by ID",
		handler: async (args: string, ctx: any) => {
			const id = args?.trim();
			if (!id) { output(ctx, "Usage: /prospect-reject <id>", "warning"); return; }
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const ok = rejectProposal(db, id);
				output(ctx, ok ? `Proposal ${id} rejected.` : `Proposal ${id} not found or not in 'new'/'open' status.`, ok ? "info" : "warning");
			} finally {
				db.close();
			}
		},
	});
}
