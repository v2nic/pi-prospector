import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listProposalsV2, acceptProposalV2, rejectProposalV2 } from "../db/queries.js";
import { getDbPath } from "../config.js";

export function registerProposalsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-proposals", {
		description: "List proposals (optionally filter by status: open, applied, rejected)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const status = args?.trim() || undefined;
				const proposals = listProposalsV2(db, status);

				if (proposals.length === 0) {
					ctx.ui.notify("No proposals found.", "info");
					return;
				}

				const lines = proposals.map((p) => {
					const short = p.id.slice(0, 8);
					const target = p.target_path ?? p.target_type;
					return `[${p.status}] ${short} | ${p.severity ?? "—"} | ${target}\n  ${p.title ?? p.summary}`;
				});
				ctx.ui.notify(`Proposals (${proposals.length}):\n${lines.join("\n")}`, "info");
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("prospect-accept", {
		description: "Accept a proposal by ID",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const id = args?.trim();
			if (!id) { ctx.ui.notify("Usage: /prospect-accept <id>", "warning"); return; }
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const ok = acceptProposalV2(db, id);
				ctx.ui.notify(ok ? `Proposal ${id} accepted.` : `Proposal ${id} not found or not in 'open' status.`, ok ? "info" : "warning");
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("prospect-reject", {
		description: "Reject a proposal by ID",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const id = args?.trim();
			if (!id) { ctx.ui.notify("Usage: /prospect-reject <id>", "warning"); return; }
			const db = new Database(getDbPath());
			migrate(db);
			try {
				const ok = rejectProposalV2(db, id);
				ctx.ui.notify(ok ? `Proposal ${id} rejected.` : `Proposal ${id} not found or not in 'open' status.`, ok ? "info" : "warning");
			} finally {
				db.close();
			}
		},
	});
}