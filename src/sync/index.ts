import Database from "better-sqlite3";
import * as fs from "node:fs";
import { migrate } from "../db/schema.js";
import { upsertSession, getCursor, updateCursor, updateMessageCount, insertMessage, countMessages } from "../db/queries.js";
import { discoverSessions } from "./scanner.js";
import { parseLine } from "./parser.js";
import { resolveFork } from "./forks.js";
import type { SyncResult } from "../types.js";

export function runSync(db: Database.Database, sessionsDir: string): SyncResult {
	migrate(db);

	const discovered = discoverSessions(sessionsDir);
	const result: SyncResult = { sessionsProcessed: 0, sessionsSkipped: 0, messagesInserted: 0, forksResolved: 0, errors: [] };

	for (const disc of discovered) {
		try {
			const cursor = getCursor(db, disc.filePath);

			// Skip unchanged files
			if (cursor && cursor.last_modified >= disc.mtime) {
				result.sessionsSkipped++;
				continue;
			}

			const content = fs.readFileSync(disc.filePath, "utf-8");
			const lines = content.split("\n");

			// Parse session header (must be first non-empty line)
			let sessionId = "";
			let parentSession: string | null = null;
			let cwd = "";
			let startedAt = "";

			for (const line of lines) {
				if (!line.trim()) continue;
				const parsed = parseLine(line);
				if (parsed && parsed.kind === "session") {
					sessionId = parsed.header.id;
					parentSession = parsed.header.parentSession ?? null;
					cwd = parsed.header.cwd ?? "";
					startedAt = parsed.header.timestamp ?? "";
					break;
				}
				break; // First non-empty line wasn't a header — malformed
			}

			if (!sessionId) {
				result.errors.push(`No session header: ${disc.filePath}`);
				continue;
			}

			// Resolve fork
			let branchCount = 0;
			if (parentSession) {
				const forkInfo = resolveFork(parentSession, sessionsDir);
				if (forkInfo) {
					branchCount = 1;
					result.forksResolved++;
				}
			}

			// Upsert session
			upsertSession(db, {
				id: sessionId,
				file_path: disc.filePath,
				project: disc.project,
				cwd,
				parent_session: parentSession,
				started_at: startedAt,
				last_line: cursor?.last_line ?? 0,
				last_modified: disc.mtime,
				analyzed_at: null,
				message_count: 0,
				branch_count: branchCount,
			});

			// Parse messages from resume point
			const resumeLine = cursor?.last_line ?? 0;
			let msgCount = 0;

			for (let i = resumeLine; i < lines.length; i++) {
				const line = lines[i]?.trim();
				if (!line) continue;

				const parsed = parseLine(line);
				if (!parsed || parsed.kind === "session") continue;

				const entry = parsed.entry;
				insertMessage(db, {
					id: entry.id,
					session_id: sessionId,
					parent_id: entry.parentId,
					timestamp: entry.timestamp,
					role: entry.role,
					content_text: entry.text,
					content_thinking: entry.thinking,
					tool_calls: entry.tool_calls ? JSON.stringify(entry.tool_calls) : null,
					tool_results: entry.tool_results ? JSON.stringify(entry.tool_results) : null,
					meta_json: entry.meta ? JSON.stringify(entry.meta) : null,
				});
				msgCount++;
			}

			// Update cursor and message count
			updateCursor(db, sessionId, lines.length, disc.mtime);
			const total = countMessages(db, sessionId);
			updateMessageCount(db, sessionId, total);

			result.sessionsProcessed++;
			result.messagesInserted += msgCount;
		} catch (err) {
			result.errors.push(`${disc.filePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return result;
}

export { runSync as sync };