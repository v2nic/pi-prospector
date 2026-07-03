# pi-prospector

> [!WARNING]  
> This repository is now archived. See [elecnix/pi-prospector](https://github.com/elecnix/pi-prospector) instead.

Incremental session analysis and proposal generation for the [Pi coding agent](https://github.com/earendil-works/pi).

pi-prospector reads your Pi session transcripts, indexes them into a local SQLite database, and builds an **append-only analysis graph** over them — measuring every turn deterministically and using an LLM only where the signal warrants it. From that graph it surfaces concrete, ranked proposals to improve your prompts, skills, and configuration. It never applies them. You decide what to develop.

pi-prospector is a Pi **extension**: it has no standalone CLI. Everything runs through slash commands and a `prospect` tool inside a Pi session.

## How it works

```
Pi sessions (~/.pi/agent/sessions/)
        │
        ▼
┌──────────────────────┐
│  /prospect-sync      │  ← Incremental, no LLM. Only new lines are parsed.
│  (fast, cheap)       │    Detects forks; shared message trees stored once.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  prospector.db       │  ← Sessions, messages (+FTS), the analysis graph,
│  (SQLite + FTS5)     │    and proposals.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  /prospect-analyze   │  ← Builds the analysis graph incrementally:
│                      │
│  turn-pair-core      │    1. Score every turn pair — deterministic.
│     │     │          │
│     ▼     ▼          │    2. turn-pair-llm classifies high-signal turns
│ turn-pair-  tool-    │       (cheap LLM); tool-trajectory finds tool-call
│   llm    trajectory  │       loops & oscillation (deterministic).
│     │     │          │
│     ▼     ▼          │
│  session-overview    │    3. Synthesise → materialise ranked proposals.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  proposals table     │  ← status: open / applied / rejected / duplicate.
│  in prospector.db    │    Each links back to the node that justifies it.
└────────┬─────────────┘
         │
         ▼
┌──────────────────────┐
│  Pi tool: prospect   │  ← Your agent lists proposals, accepts or rejects
│  /prospect-* commands│    them, requests syncs, checks stats.
└──────────────────────┘
```

The analysis graph is **append-only and incremental**. Each node records the exact *recipe* that produced it (which analyzer, at which version, under which config, over which inputs), so re-running analysis recomputes only what is genuinely out of date and never repeats expensive LLM work that is still current. See [`DESIGN.md`](./DESIGN.md) for the full model.

## Install

```bash
pi install git:github.com/v2nic/pi-prospector
```

Requires Pi with an LLM API key configured for at least one provider. You choose which models analysis uses (see [Configuration](#configuration)); the deterministic layer needs no model at all.

> **Back up your sessions first.** pi-prospector treats `~/.pi/agent/sessions/` as read-only and never writes to it, but it does not make a backup for you. Run something like `tar czf ~/prospector-backup/sessions-$(date +%Y%m%d).tgz ~/.pi/agent/sessions/` before your first sync.

## Commands

### `/prospect-sync`

Index session files into the database. No LLM is called. Fast and cheap.

- Scans `~/.pi/agent/sessions/` for new or modified `.jsonl` files
- Parses each file line-by-line, starting from the last line previously processed (incremental)
- Detects sessions that forked from another via the `parentSession` header — shared message trees are stored once, not duplicated
- Tracks a cursor per session file (`{session_id, last_line, last_modified}`) and re-indexes a file only when its modification time changes

Run it as often as you like. It's idempotent and incremental.

### `/prospect-analyze [--revise <reasons>] [--limit N] [--session ID] [--analyzer ID] [--model provider/model]`

Build the analysis graph over synced sessions and materialise proposals. By default it does the cheapest useful thing: it **fills only missing work**. Nodes that are already current are skipped; nodes that are out of date are left alone unless you ask for them with `--revise`.

- `--revise major|minor|config|all` — also recompute *stale* nodes, selected by **why** they are stale:
  - `major` — the analyzer shipped a significant new version
  - `minor` — a small analyzer version bump (`minor` implies `major`)
  - `config` — *your* setup changed (a threshold, a prompt override, the tier→model mapping, or a model pin — including the resolved model)
  - `all` — every reason; combinable as a list, e.g. `--revise minor,config`

  Reasons only *select* which out-of-date nodes a run touches. A selected node is always recomputed to the **current recipe in full** (latest version, latest config, latest resolved model), and the new node is linked to its predecessor by a `revises` edge so lineage stays navigable. A plain fill scans only not-yet-analysed sessions; any `--revise` reason re-scans every session so stale work can be found.
- `--limit N` — cap how many sessions are scanned
- `--session ID` — analyse a single session
- `--analyzer ID` — run a single analyzer (`turn-pair-core`, `turn-pair-llm`, `tool-trajectory`, or `session-overview`) and its dependencies
- `--model provider/model` — pin **every** model tier to one concrete model for this run. Because the resolved model is part of a node's identity, a pinned run produces its own nodes; switching back to the normal mapping marks them stale (reason `config`).

Proposals are never auto-applied. They sit in the database with status `open` until you accept or reject them.

### `/prospect-stats`

Print a summary of the database: sessions indexed, messages and tool results, sessions analysed, proposals by status (`open`/`applied`/`rejected`/`duplicate`), and analysis-graph totals (nodes, edges, runs, and a breakdown of nodes by kind).

### `/prospect-proposals [status]`

List proposals, optionally filtered by status (`open`, `applied`, `rejected`, `duplicate`). Each row shows its status, a score label, severity, target, title, summary, and full id — together with a ready-to-paste `prospect show <id>` hint (proposal ids are time-ordered, so short prefixes can collide; the full id is always unambiguous). If you have decided a proposal, the row also shows your latest **decision** (verdict, disposition, and rationale).

- **Target** — what the proposal suggests changing (a category and optional path, e.g. a standing instruction file or a skill)
- **Severity** — the nature of the signal: `friction` | `correction` | `waste` | `suggestion` | `reinforcement` (listed as `reinforce`)
- **Status** — `open`, `applied`, `rejected`, or `duplicate`
- **Score** — either `replay-validated:<supported|unsupported> NN%` once the proposal has been replay-validated (see `/prospect-validate`), or `model-rated NN%` (the synthesising model's self-rating) until then

Proposals are ranked **supported → unvalidated → unsupported**, so a replay-validated success rises to the top and a replay-validated failure sinks below untested ones — regardless of the model's self-rated confidence. Add `--full` (or `-v`) to also print each proposal's detail, evidence, validation delta, and source node.

### `/prospect-show <id>`

Show one proposal together with the **verbatim turns it was synthesised from**, so you can judge it against the real conversation without re-opening the transcript. It accepts a full proposal id or any unambiguous id-prefix.

It walks the proposal's provenance — proposal → its source `session-overview` node → the turn nodes that node **consumed** → the messages those turns **anchor** — and prints, for each high-signal turn:

- the deterministic and LLM signals for that turn (friction score, correction type, tool-failure count, sentiment/severity)
- the **user** text and the **assistant** text, verbatim
- every **tool call with its arguments**, plus any tool-result errors

Because the overview consumes every turn, output is focused to the high-signal turns (those with friction or an LLM classification) and capped, with a note for any omitted turns. Surfacing the actual tool-call arguments often reveals mechanism-level detail the text-only classifier cannot see — for example whether a push failure was really about the push command or about a later `gh pr create` target.

### `/prospect-accept <id> [--planned|--done|--done-differently] [rationale...]`

Mark an open proposal as `applied`. This does **not** apply the change — it only
records your decision. You then ask your Pi coding agent to implement it (or, in
practice, you accept *because* you are about to implement it).

You can attach durable feedback to the decision:

- a **disposition** — `--planned` ("I will do it"), `--done` ("I already did the
  recommended action"), or `--done-differently` ("the idea was useful but I did
  something other than the literal recommendation"; recorded as the
  `accepted_modified` verdict)
- a free-text **rationale** — everything after the id/flags

Example: `/prospect-accept 0c9f --done capped polling iterations instead of banning loops`.

The decision is stored append-only, keyed by the proposal's content-addressed
input key, so it survives a wipe-and-recompute and re-attaches to the
regenerated proposal. It is shown in `/prospect-proposals` and `/prospect-show`,
and is the intended training signal for a future quality-improving meta-analyzer.
Calling with just an id still works.

### `/prospect-reject <id> [rationale...]`

Mark an open proposal as `rejected`, optionally with a rationale (for example
*"my current harness already enforces this"*). The rationale is recorded as a
durable decision exactly as for accept.

### `/prospect-verify`

Recompute every analysis node's output key from its stored content and confirm it matches what is recorded. Because identities are content-addressed, any mismatch reveals out-of-band tampering or corruption of the database. Pure read; reports `ok` or lists the mismatching nodes. See [Verification](#design) in `DESIGN.md`.

### `/prospect-validate [--revise <reasons>] [--limit N] [--session ID] [--model provider/model]`

Replay-validate open proposals to ground their confidence empirically instead of trusting the synthesising model's self-rating. For each proposal, a **distinct** validator model (the `mid` tier by default, vs. the `cheap` tier that generated it) re-classifies the proposal's originating high-signal turns twice — once as-is, once with the candidate rule injected as a standing instruction the agent "already had" — and the proposal is credited only where injecting the rule turns friction into no-friction.

The result is a content-addressed `validation` node (covered by `/prospect-verify`) plus a grounded `validated_score` and a status of `supported`, `unsupported`, or `unvalidated` written back onto the proposal. This is **advisory only** — it never edits anything — and it deliberately inherits the text-only classifier's blind spots, so the score is labelled *replay-validated*, not treated as ground truth. `--model` pins every tier to one model for the run (the resolved model is part of node identity); `--revise config` re-validates after a validator-model change.

## Pi tool: `prospect`

When installed, pi-prospector registers a `prospect` tool the Pi coding agent can call during a session:

| Action | What it does |
|--------|-------------|
| `sync` | Index new/modified sessions into the database |
| `stats` | Return sync and proposal statistics |
| `list_proposals` | List proposals, optionally filtered by status |
| `accept` | Mark a proposal as applied; optional `rationale`, `disposition` (planned/done/done_differently), `actual_change` record a durable decision |
| `reject` | Mark a proposal as rejected; optional `rationale` records a durable decision |

This lets you say things like "show me open proposals" or "sync my sessions and check stats" directly in a Pi conversation. (Analysis itself runs through `/prospect-analyze`, not the tool, because it can be long-running and cost money.)

## What gets analyzed

pi-prospector reads **only what is inside Pi session files**. It does not read Pi configuration files, `AGENTS.md`, skill files, or any other artifact directly. A session file contains:

- User messages (what you said)
- Assistant messages (what the agent said, including thinking)
- Tool calls and tool results (what the agent did)
- Compaction summaries (what was retained after context compression)
- Model changes and thinking-level changes

The unit of analysis is a **turn** — one round of work, segmented at the same boundaries Pi uses (a user or `bashExecution` message, or a `branch_summary`/`custom_message` entry). The deterministic layer scores every turn; only high-signal turns are sent to the LLM. The system prompt is not stored in session files and is not captured.

## Analyzers

Analysis is a small DAG of analyzers. The **deterministic** ones never call a model; the **LLM** ones ask for an abstract *tier* (`cheap`/`mid`), not a specific model. Every analyzer is versioned and content-addressed, so its nodes recompute only when its code version, config, or inputs change. All sources live under [`src/analyze/analyzers/`](./src/analyze/analyzers/).

### turn-pair-core — per-turn friction metrics (deterministic)

Scores every user→assistant **turn pair**: did the user correct the agent, did tools fail, was the reply empty, was tool output wasted? It also extracts a compact **tool-action trace** — each call's name, truncated arguments, and the first line of any failed result — which later analyzers rely on to blame the command actually at fault. No model; high-scoring pairs are flagged *high-signal*.

Source: [`turn-pair-core/index.ts`](./src/analyze/analyzers/turn-pair-core/index.ts) · correction/repetition patterns in [`patterns.ts`](./src/analyze/analyzers/turn-pair-core/patterns.ts) · turn assembly + trace extraction in [`build.ts`](./src/analyze/analyzers/turn-pair-core/build.ts) · weights/thresholds in [`config.ts`](./src/analyze/analyzers/turn-pair-core/config.ts).

### turn-pair-llm — per-turn classification (cheap LLM)

For *only* the high-signal pairs, a cheap model labels the friction: sentiment, friction type (`wrong_approach`, `missed_instruction`, `tool_misuse`, `repetition`, …), whether it is a genuine correction, and a severity. The prompt includes the turn's **actual tool calls and error heads** (from turn-pair-core's trace), so the model attributes friction to the command that failed rather than paraphrasing your wording. A length-aware cap bounds how many pairs are enriched per session.

Source: [`turn-pair-llm/index.ts`](./src/analyze/analyzers/turn-pair-llm/index.ts) · classifier prompt + evidence formatting in [`prompt.ts`](./src/analyze/analyzers/turn-pair-llm/prompt.ts) · tier + enrichment cap in [`config.ts`](./src/analyze/analyzers/turn-pair-llm/config.ts).

### tool-trajectory — tool-call patterns (deterministic)

Looks at the ordered stream of tool calls across the whole session and flags four shapes of wasted motion: **stuck-loops** (the same failing action repeated), **polling-loops** (re-checking the same state over and over), **oscillation** (doing and undoing), and **pre-flight gaps** (acting without the check that should precede it). No model — pure pattern detection that complements the text-based signals.

Source: [`tool-trajectory/index.ts`](./src/analyze/analyzers/tool-trajectory/index.ts) · detectors in [`detectors.ts`](./src/analyze/analyzers/tool-trajectory/detectors.ts) · call normalisation in [`arg-parser.ts`](./src/analyze/analyzers/tool-trajectory/arg-parser.ts) · thresholds in [`config.ts`](./src/analyze/analyzers/tool-trajectory/config.ts).

### session-overview — synthesis & proposals (LLM map-reduce)

Consumes the three analyzers above and turns a whole session into a short summary, a list of **positive signals** (what went well), and a set of **ranked improvement proposals**. It uses an *enumerate-then-propose* strategy — first list every friction point as a textual gradient, then emit one proposal per point — so recurring issues are not collapsed away. It emits a node even for clean sessions, which can yield `reinforcement` proposals that praise good habits. Proposals are materialised into the `proposals` table, each linked to the node that justifies it.

Source: [`session-overview/index.ts`](./src/analyze/analyzers/session-overview/index.ts) · deterministic digest in [`digest.ts`](./src/analyze/analyzers/session-overview/digest.ts) · map/reduce prompts in [`prompt-map.ts`](./src/analyze/analyzers/session-overview/prompt-map.ts) and [`prompt-reduce.ts`](./src/analyze/analyzers/session-overview/prompt-reduce.ts).

### proposal-validate — replay validation (opt-in LLM, advisory)

Run separately via `/prospect-validate`. For each open proposal it replays the originating high-signal turns twice with a **distinct** validator model — once as-is, once with the candidate rule injected as a standing instruction — and credits the proposal only where the rule turns friction into no-friction. The result is a grounded `validated_score` and a `supported`/`unsupported`/`unvalidated` status written back onto the proposal (mutable result fields — never part of any identity key). Advisory only; it never edits anything.

Source: [`proposal-validate/index.ts`](./src/analyze/analyzers/proposal-validate/index.ts) · baseline/with-rule replay prompts in [`prompt.ts`](./src/analyze/analyzers/proposal-validate/prompt.ts) · validator tier in [`config.ts`](./src/analyze/analyzers/proposal-validate/config.ts).

Registration and dependency order live in [`src/analyze/defaults.ts`](./src/analyze/defaults.ts); the framework that schedules analyzers, computes their content-addressed identities, and tracks lineage is [`src/analyze/framework.ts`](./src/analyze/framework.ts).

## Fork deduplication

Pi sessions are stored as trees. When you branch a session with `/tree`, the new session file carries a `parentSession` header pointing to the original, and messages before the branch point are shared. During sync, pi-prospector reads that header, resolves the parent, stores shared messages once, and marks the forked session as starting from the branch point — so analysing a fork only processes the **new** messages after the branch.

## Configuration

Create `~/.pi/agent/prospector.json` (all fields optional):

```json
{
  "dbPath": "~/.pi/agent/prospector.db",
  "modelTiers": {
    "cheap": "anthropic/claude-haiku-4-5",
    "mid": "anthropic/claude-sonnet-4-5",
    "expensive": "anthropic/claude-opus-4-1"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `dbPath` | `~/.pi/agent/prospector.db` | Path to the SQLite database. A leading `~` is expanded. |
| `modelTiers` | Claude haiku-4-5 / sonnet-4-5 / opus-4-1 | Maps the abstract tiers analyzers request (`cheap`/`mid`/`expensive`) to concrete `provider/model` strings. Each must be a model Pi has credentials for. Override every tier for a single run with `--model`. |

Analyzers ask for a **tier**, not a model, so you tune cost vs. quality in one place. The resolved model is part of a node's identity: change the mapping and the affected nodes become stale (reason `config`), recomputed when you next run `--revise config`. All model access goes through Pi's own provider system — pick any model Pi supports (configured via `/login` or API keys). The deterministic `turn-pair-core` layer needs no model and always runs.

The following environment variables override paths and are mainly for testing: `PROSPECTOR_DB_PATH`, `PROSPECTOR_SESSIONS_DIR`, `PROSPECTOR_CONFIG`.

## Running headlessly

The commands are normally invoked as slash commands inside an interactive Pi session, but the extension also registers a `--prospect` CLI flag so a single command runs **non-interactively and exits** — no `-p` needed. This is the convenient way to drive prospector from scripts or while iterating on the analyzers (the extension is reloaded fresh from source on every run, so code changes take effect without restarting an interactive session):

```bash
pi -e ./src/index.ts --prospect sync
pi -e ./src/index.ts --prospect stats
pi -e ./src/index.ts --prospect "analyze --limit 3 --model openrouter/anthropic/claude-3.5-haiku"
pi -e ./src/index.ts --prospect proposals
pi -e ./src/index.ts --prospect "accept <id>"
```

The value is `"<command> [args]"`; quote it when it contains spaces. Commands: `sync`, `analyze [flags]`, `stats`, `proposals [status] [--full]`, `show <id>`, `verify`, `validate [flags]`, `accept <id> [--planned|--done|--done-differently] [rationale]`, `reject <id> [rationale]`. When `--prospect` is absent the extension stays fully interactive. (`-ne` additionally skips discovery of other extensions, and `--no-session` keeps the run ephemeral.)

To iterate on a small **private** subset rather than your whole history, copy a few session folders somewhere outside any repo and point the env overrides at them — the sessions directory is only ever read:

```bash
export PROSPECTOR_SESSIONS_DIR="$HOME/.prospector-local/sessions"
export PROSPECTOR_DB_PATH="$HOME/.prospector-local/prospector.db"
pi -e ./src/index.ts --prospect stats
```

For structured-output calls, prefer a non-reasoning model/tier: reasoning models spend the token budget on thinking and can truncate the JSON answer (the LLM caller now fails fast with a clear message when a response is cut off at the output limit).

## Design

[`DESIGN.md`](./DESIGN.md) is the canonical description of the system: the ubiquitous language, the append-only graph, recipe-based identity and idempotency, versioned lineage, the reach of a run, and the deterministic-first layering. Read it before changing analysis behaviour.

## License

MIT
