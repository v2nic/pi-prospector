import type Database from "better-sqlite3";

/**
 * Apply schema migrations. Idempotent — safe to call on every command
 * start. Existing tables and rows are preserved; new tables and
 * columns are added.
 *
 * Migration history:
 *   001 — initial: sessions, messages, proposals + FTS5
 *   002 — analyzer framework: adds meta_json to messages; extends
 *         proposals with analyzer_id / target_type / target_path /
 *         title / analysis_node_id / confidence / dedup_key /
 *         updated_at / evidence_json; creates analyzer_defs,
 *         analyzer_versions, prompt_registry, analyzer_configs,
 *         analysis_runs, analysis_nodes, analysis_edges,
 *         analysis_progress.
 */
export function migrate(db: Database.Database): void {
	// 001 — base schema
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			cwd TEXT NOT NULL DEFAULT '',
			parent_session TEXT,
			started_at TEXT,
			last_line INTEGER NOT NULL DEFAULT 0,
			last_modified REAL NOT NULL DEFAULT 0,
			analyzed_at TEXT,
			message_count INTEGER NOT NULL DEFAULT 0,
			branch_count INTEGER NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			parent_id TEXT,
			timestamp TEXT,
			role TEXT NOT NULL,
			content_text TEXT,
			content_thinking TEXT,
			tool_calls TEXT,
			tool_results TEXT,
			content_hash TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE TABLE IF NOT EXISTS proposals (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			session_id TEXT NOT NULL,
			target TEXT NOT NULL,
			severity TEXT NOT NULL,
			summary TEXT NOT NULL,
			detail TEXT,
			evidence TEXT,
			status TEXT NOT NULL DEFAULT 'new',
			dedup_hash TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
		CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
		CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
		CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
		CREATE INDEX IF NOT EXISTS idx_proposals_dedup ON proposals(dedup_hash);
		CREATE INDEX IF NOT EXISTS idx_sessions_file ON sessions(file_path);

		DROP TABLE IF EXISTS messages_fts;
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			content_text,
			content_thinking,
			content='messages',
			content_rowid='rowid'
		);

		DROP TRIGGER IF EXISTS messages_ai;
		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts(rowid, content_text, content_thinking)
			VALUES (NEW.rowid, NEW.content_text, NEW.content_thinking);
		END;

		DROP TRIGGER IF EXISTS messages_ad;
		CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking)
			VALUES ('delete', OLD.rowid, OLD.content_text, OLD.content_thinking);
		END;
	`);

	// 002 — analyzer framework
	addColumnIfMissing(db, "messages", "meta_json", "TEXT");
	addColumnIfMissing(db, "proposals", "analysis_node_id", "TEXT");
	addColumnIfMissing(db, "proposals", "analyzer_id", "TEXT");
	addColumnIfMissing(db, "proposals", "target_type", "TEXT");
	addColumnIfMissing(db, "proposals", "target_path", "TEXT");
	addColumnIfMissing(db, "proposals", "title", "TEXT");
	addColumnIfMissing(db, "proposals", "evidence_json", "TEXT");
	addColumnIfMissing(db, "proposals", "confidence", "REAL");
	addColumnIfMissing(db, "proposals", "dedup_key", "TEXT");
	addColumnIfMissing(db, "proposals", "updated_at", "TEXT");

	db.exec(`
		CREATE TABLE IF NOT EXISTS analyzer_defs (
			id              TEXT PRIMARY KEY,
			label           TEXT NOT NULL,
			description     TEXT,
			anchor_span     TEXT NOT NULL,
			dependencies    TEXT NOT NULL DEFAULT '[]',
			created_at      TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS analyzer_versions (
			analyzer_id         TEXT NOT NULL,
			version_id          TEXT NOT NULL,
			implementation_kind TEXT NOT NULL,
			code_ref            TEXT,
			created_at          TEXT NOT NULL,
			PRIMARY KEY (analyzer_id, version_id),
			FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
		);

		CREATE TABLE IF NOT EXISTS prompt_registry (
			hash            TEXT PRIMARY KEY,
			content         TEXT NOT NULL,
			role            TEXT,
			created_at      TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS analyzer_configs (
			id              TEXT PRIMARY KEY,
			analyzer_id     TEXT NOT NULL,
			config_hash     TEXT NOT NULL,
			config_json     TEXT NOT NULL,
			label           TEXT,
			created_at      TEXT NOT NULL,
			FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
		);

		CREATE TABLE IF NOT EXISTS analysis_runs (
			id                      TEXT PRIMARY KEY,
			analyzer_id             TEXT NOT NULL,
			analyzer_version_id     TEXT NOT NULL,
			config_id               TEXT NOT NULL,
			session_id              TEXT NOT NULL,
			status                  TEXT NOT NULL DEFAULT 'planned',
			prompt_bundle_hash      TEXT NOT NULL,
			started_at              TEXT NOT NULL,
			finished_at             TEXT,
			model_spec              TEXT,
			cost_usd                REAL DEFAULT 0,
			tokens_used             INTEGER DEFAULT 0,
			nodes_produced          INTEGER DEFAULT 0,
			nodes_skipped           INTEGER DEFAULT 0,
			error_message           TEXT,
			FOREIGN KEY (analyzer_id, analyzer_version_id) REFERENCES analyzer_versions(analyzer_id, version_id),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE TABLE IF NOT EXISTS analysis_nodes (
			id                  TEXT PRIMARY KEY,
			session_id          TEXT NOT NULL,
			analyzer_id         TEXT NOT NULL,
			analyzer_version_id TEXT NOT NULL,
			config_id           TEXT NOT NULL,
			run_id              TEXT NOT NULL,
			node_kind           TEXT NOT NULL,
			content_json        TEXT NOT NULL,
			source_set_hash     TEXT NOT NULL,
			input_hash          TEXT NOT NULL,
			created_at          TEXT NOT NULL,
			model_used          TEXT,
			cost_usd            REAL DEFAULT 0,
			tokens_used         INTEGER DEFAULT 0,
			duration_ms         INTEGER,
			FOREIGN KEY (run_id) REFERENCES analysis_runs(id),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE TABLE IF NOT EXISTS analysis_edges (
			from_node_id    TEXT NOT NULL,
			to_ref_kind     TEXT NOT NULL,
			to_ref_id       TEXT NOT NULL,
			edge_kind       TEXT NOT NULL,
			ordinal         INTEGER DEFAULT 0,
			PRIMARY KEY (from_node_id, to_ref_kind, to_ref_id, edge_kind, ordinal),
			FOREIGN KEY (from_node_id) REFERENCES analysis_nodes(id)
		);

		CREATE TABLE IF NOT EXISTS analysis_progress (
			analyzer_id         TEXT NOT NULL,
			analyzer_version_id TEXT NOT NULL,
			config_id           TEXT NOT NULL,
			session_id          TEXT NOT NULL,
			cursor_json         TEXT,
			last_run_id         TEXT,
			total_analyzed      INTEGER DEFAULT 0,
			status              TEXT NOT NULL DEFAULT 'ok',
			error_message       TEXT,
			updated_at          TEXT NOT NULL,
			PRIMARY KEY (analyzer_id, analyzer_version_id, config_id, session_id),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_runs_session ON analysis_runs(session_id);
		CREATE INDEX IF NOT EXISTS idx_runs_status ON analysis_runs(status);
		CREATE INDEX IF NOT EXISTS idx_nodes_session ON analysis_nodes(session_id);
		CREATE INDEX IF NOT EXISTS idx_nodes_analyzer ON analysis_nodes(analyzer_id, analyzer_version_id);
		CREATE INDEX IF NOT EXISTS idx_nodes_kind ON analysis_nodes(node_kind);
		CREATE INDEX IF NOT EXISTS idx_nodes_input_hash ON analysis_nodes(input_hash);
		CREATE INDEX IF NOT EXISTS idx_nodes_source_hash ON analysis_nodes(source_set_hash);
		CREATE INDEX IF NOT EXISTS idx_nodes_config ON analysis_nodes(config_id);
		CREATE INDEX IF NOT EXISTS idx_nodes_idempotency
			ON analysis_nodes(analyzer_id, analyzer_version_id, config_id, source_set_hash);
		CREATE INDEX IF NOT EXISTS idx_edges_from ON analysis_edges(from_node_id);
		CREATE INDEX IF NOT EXISTS idx_edges_to ON analysis_edges(to_ref_kind, to_ref_id);
		CREATE INDEX IF NOT EXISTS idx_edges_kind ON analysis_edges(edge_kind);
		CREATE INDEX IF NOT EXISTS idx_progress_session
			ON analysis_progress(analyzer_id, analyzer_version_id, session_id);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_config_unique
			ON analyzer_configs(analyzer_id, config_hash);
	`);
}

/**
 * Add a column to a table if it doesn't already exist.
 * SQLite has no ADD COLUMN IF NOT EXISTS, so we inspect pragma.
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, typeDecl: string): void {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (cols.some((c) => c.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
}
