# pi-prospector

Incremental session indexing and proposal generation for the [Pi coding agent](https://github.com/earendil-works/pi).

pi-prospector is a **Pi extension** that reads your Pi session transcripts, indexes them into a local SQLite database, and uses an LLM to propose improvements to your prompts, skills, and configuration — without applying them. You decide what to develop.

## How it works

```
Pi sessions (~/.pi/agent/sessions/)
        │
        ▼
┌─────────────────────┐
│  /prospect-sync      │  ← Incremental. Only new lines are processed.
│  (no LLM, fast)      │  Detects forks. Deduplicates shared message trees.
│  Also runs turn-pair- │  core (deterministic) analysis on new sessions.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  prospector.db       │  ← All session data, messages, analysis nodes,
│  (SQLite + FTS5)    │     edges, and proposals
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  /prospect-analyze   │  ← Runs LLM analyzers over unprocessed sessions.
│  (uses Ollama or    │  Generates proposals. Does NOT edit any files.
│   Pi's model)       │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  proposals table     │  ← status: open / applied / duplicate
│  in prospector.db    │  Each proposal deduplicates by content hash.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Pi tool: prospect   │  ← Your coding agent syncs, checks stats,
│  /prospect commands  │     lists/accepts/rejects proposals.
└─────────────────────┘
```

## Install

```bash
# From local path (for development):
pi install /path/to/pi-prospector

# From git (when published):
pi install git:github.com:v2nic/pi-prospector
```

Requires [Ollama](https://ollama.com) running locally for LLM-backed analysis. The deterministic analyzer (`turn-pair-core`) works without any LLM.

## Usage

### `/prospect-sync`

Index session files into the database. Also runs deterministic analysis on new sessions.

- Scans `~/.pi/agent/sessions/` for new or modified `.jsonl` files
- Parses each file line-by-line, starting from the last line processed (incremental)
- Detects sessions that forked from another via `parentSession` header
- After sync, runs `turn-pair-core` (deterministic) analysis on unanalyzed sessions
- No LLM required — fast and free

### `/prospect-analyze [--limit N] [--model model-spec]`

Run LLM analysis over sessions that have been synced but not yet analyzed.

- `--limit N`: only analyze N sessions
- `--model model-spec`: Ollama model spec (e.g. `glm-5.1:cloud`, `deepseek-v4-flash:cloud`)
  - If `--model` is not specified, falls back to `model` in config, then Pi's current model
- Runs all registered analyzers in topological order:
  1. `turn-pair-core` — deterministic user/assistant pair analysis
  2. `turn-pair-llm` — LLM-backed classification of pairs
  3. `session-overview` — LLM summary and sentiment arc analysis

### `/prospect-stats`

Print database statistics: sessions indexed, messages, analysis nodes/edges/runs, proposals by status.

### `/prospect-proposals [status]`

List proposals, optionally filtered by status (`open`, `applied`, `rejected`).

### `/prospect-accept <id>`

Mark a proposal as applied. Does **not** implement the proposal — only updates status.

### `/prospect-reject <id>`

Mark a proposal as rejected.

### Pi tool: `prospect`

The extension also registers a `prospect` tool that the Pi coding agent can call during sessions:

| Action | What it does |
|--------|-------------|
| `sync` | Index new/modified sessions into the database |
| `stats` | Return sync and proposal statistics |
| `list_proposals` | List proposals, optionally filtered by status |
| `accept` | Mark a proposal as applied |
| `reject` | Mark a proposal as rejected |

This lets you say things like "show me open proposals" or "sync my sessions" directly in a Pi conversation.

## Analyzer framework

The analysis framework implements the design from `docs/analyzer-design-c.md`:

- **`turn-pair-core`** — deterministic. Identifies user/assistant pairs, detects tool patterns, computes metrics (turn count, error count, retry count, etc.)
- **`turn-pair-llm`** — LLM-backed. Classifies each pair as one of 10 friction categories (error-retry, tool-correction, etc.)
- **`session-overview`** — LLM-backed. Generates a summary, sentiment arc, and session classification

Each analyzer:
1. Has an `id`, `versionId`, dependencies on other analyzers, and prompts
2. Plans analysis units from messages + dependency nodes
3. Runs each unit, producing nodes and edges
4. Nodes are deduplicated by input hash (re-running is safe)
5. Proposals are materialized from matching node kinds

## Database

Location: `~/.pi/agent/prospector.db` (configurable)

Tables:
- `sessions`, `messages` — synced from Pi session files
- `analyzer_defs`, `analyzer_versions`, `prompts`, `analyzer_configs` — analyzer metadata
- `analysis_runs`, `analysis_nodes`, `analysis_edges`, `analysis_progress` — analysis results
- `proposals` — LLM-generated improvement proposals (v2 schema with dedup)

## Configuration

Create `~/.pi/agent/prospector.json`:

```json
{
  "model": "glm-5.1:cloud",
  "dbPath": "~/.pi/agent/prospector.db",
  "modelTiers": {
    "cheap": "deepseek-v4-flash:cloud",
    "mid": "glm-5.1:cloud",
    "expensive": "glm-5.1:latest"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `model` | *(Pi's current model)* | Ollama model spec for LLM analysis |
| `dbPath` | `~/.pi/agent/prospector.db` | Path to the SQLite database |
| `modelTiers` | *(built-in defaults)* | Model tier mapping for cheap/mid/expensive analysis |

## Development

```bash
# Type check
npx tsc --noEmit

# Run unit + component tests
node --import tsx --test tests/unit/*.test.ts tests/component/*.test.ts

# Run integration tests
node --import tsx --test test/integration/*.ts

# Install extension locally for testing
pi install /path/to/pi-prospector
```

## Architecture

```
src/
├── index.ts                      # Extension entry point (registers commands + tool)
├── pi-stubs.ts                   # Type stubs for @earendil-works/pi-coding-agent
├── config.ts                     # Configuration loading
├── sync/                          # Session scanning and parsing (no LLM)
│   ├── scanner.ts                # Discovers .jsonl session files
│   ├── parser.ts                 # Parses session entries (v0.5+ format)
│   ├── cursor.ts                 # Tracks sync progress
│   └── forks.ts                  # Resolves parent sessions
├── db/
│   ├── schema.ts                 # Migrations (001: sync, 002: analysis)
│   ├── queries.ts                # Sync queries (sessions, messages, proposals v2)
│   └── analysis-queries.ts       # Analysis queries (runs, nodes, edges, progress)
├── analyze/
│   ├── types.ts                  # TypeBox schemas for all analysis data shapes
│   ├── framework.ts              # AnalyzerFramework: orchestrates planning + execution
│   ├── model-tiers.ts            # Model tier resolution (cheap/mid/expensive)
│   ├── input-hash.ts             # Input deduplication via SHA-256
│   ├── ollama-llm.ts             # Ollama LLM backend (localhost:11434)
│   ├── edge-kinds.ts             # Edge kind constants + validation
│   ├── proposal-materializer.ts  # Generates proposals from analysis nodes
│   └── analyzers/
│       ├── turn-pair-core/       # Deterministic pair analysis
│       ├── turn-pair-llm/        # LLM-backed friction classification
│       └── session-overview/     # LLM summary + sentiment arc
└── commands/
    ├── sync.ts                   # /prospect-sync
    ├── analyze.ts                # /prospect-analyze
    ├── stats.ts                  # /prospect-stats
    ├── proposals.ts              # /prospect-proposals, /prospect-accept, /prospect-reject
    └── tool.ts                   # prospect tool (for LLM to call)
```

## What gets analyzed

pi-prospector reads **only what is inside Pi session files**. It does not read Pi configuration files, `AGENTS.md`, skill files, or any other artifact directly. The session file contains:

- User messages (what you said)
- Assistant messages (what the agent said, including thinking)
- Tool calls and tool results (what the agent did)
- Compaction summaries (what was retained after context compression)
- Model changes and thinking level changes

## License

MIT