# pi-prospector — Design & Concepts

This document is the orientation guide for anyone — human or AI agent — who is
new to this repository. It explains **what the system is for** and **why it is
built the way it is**, and it fixes a **ubiquitous language**: a small set of
terms that mean exactly one thing throughout the code, the database, the
commands, and any conversation about the project. When you read or write code
here, use these words with these meanings. When a term in this glossary appears
in a discussion, assume the precise definition below — not its everyday sense.

This is a conceptual guide. It deliberately contains no file paths, function
names, table definitions, or code. Those change; the concepts and the reasons
for them are what must stay stable.

---

## 1. Purpose

People spend hours working with coding agents. Those conversations are a
goldmine of signal about where the agent's standing instructions, documentation,
tools, and skills fall short: every time the user has to correct the agent,
re-explain context, or watch it waste effort, that friction is evidence of a
fixable gap.

pi-prospector mines that history. It reads the local record of past agent
**sessions**, looks for moments of **friction**, and turns recurring patterns
into concrete, reviewable **proposals** — suggested edits to the artifacts that
steer future agent behaviour (standing instruction files, skills, tool
descriptions, configuration, and similar). The human stays in control: the
system proposes, ranks, and explains; it never edits those artifacts on
its own.

The guiding intent behind every design choice is **trust through traceability
and cheap recomputation**. A proposal is only worth acting on if you can see the
exact evidence that produced it, and the analysis is only sustainable if it can
be re-derived cheaply as the analysis logic improves — without paying again for
work that is already up to date, and without throwing away earlier conclusions
that someone may want to compare against.

---

## 2. Ubiquitous language

These are the load-bearing nouns and verbs of the system. They are listed in
roughly the order concepts build on one another.

### Conversation domain (the read-only input)

- **Session** — one recorded conversation between a user and a coding agent,
  from start to end. Sessions are the raw material. They are treated as
  **read-only**: the system observes them and never alters them.
- **Message** — a single entry within a session: something the user said, one of
  the agent's replies, the agent's private reasoning, or the result of a tool the
  agent ran. Messages carry metadata (timing, model, token usage, error flags).
- **Turn** — the natural unit of one round of work, and where most friction is
  visible. A turn begins at a user message (the turn boundary) and spans
  *everything* the agent does in response — every assistant reply, its private
  reasoning, and every tool call and result — up to the next user message. A
  turn is therefore usually **many messages, not two**: a single request
  normally drives a loop of repeated assistant generations and tool calls before
  the next user message arrives. (The host platform also treats a few non-user
  entries — a bash execution, a branch or custom summary — as turn boundaries.)
  The per-turn analyzers are named `turn-pair-*` and the codebase calls this
  unit a "turn pair"; it is one turn, not a pair of turns.
- **Step** — one assistant generation within a turn: a single model response,
  possibly carrying tool calls. A turn is a sequence of one or more steps plus
  the tool results they trigger.
- **Compaction boundary** — a point where the conversation history was
  summarised and truncated to fit the model's context. The system is aware of
  these so it does not mistake a summary for an ordinary message.

### Analysis domain (the append-only output)

- **Analysis graph** — the entire body of derived analysis, layered on top of
  the conversation. It is a graph, not a tree, and it is **append-only**: once
  written, an analysis result is never edited or deleted.
- **Analysis node** (or just **node**) — one self-contained piece of derived
  analysis: a set of metrics for a turn, a classification of a turn, a
  session-level summary, or a recorded error. Every node states what it is
  about, what it was built from, and exactly which recipe produced it.
- **Node kind** — the category of a node's content. The kinds in use are
  **metric** (deterministic measurements of a turn), **classification** (a
  language-model judgement about a turn), **summary** (a session-level synthesis
  that carries proposals), and **error** (a record that an analysis attempt
  failed). An error node's identity is its recipe plus the failure's message and
  timestamp, so every failure is a distinct, append-only record that never
  occupies the recipe identity reserved for a successful result. Failures stay
  visible and auditable, yet never mark a unit as done: the unit stays *missing*
  and is recomputed on the next scan that reaches it.
- **Edge** — a typed, directed relationship in the analysis graph. Edges are the
  **single source of truth** for relationships: there are no parent links or
  embedded references hidden inside nodes. Every connection between a node and
  anything else is an explicit edge with a named kind.
- **Edge kind** — the meaning of an edge. The kinds are:
  - **anchors** — “this node is *about* this part of the conversation” (a
    session or a specific message). Anchoring is how a proposal can be traced
    back to the exact words that justify it.
  - **consumes** — “this node was *built from* that node.” It records the inputs
    that fed an analysis.
  - **uses_prompt** — “this node was produced using that prompt.”
  - **uses_config** — “this node was produced under that configuration.”
  - **produces** — “this node yielded that proposal.”
  - **revises** — “this node is a newer-version alternative of that node,
    covering the same subject.” This is the backbone of lineage (below).
- **Anchor** — the conversation entity a node is about, reached via an *anchors*
  edge. A turn-level node anchors to its user message; a session-level node
  anchors to the session.

### Recipe, identity, and idempotency

- **Analyzer** — a named, self-describing unit of analysis logic. An analyzer
  declares what it is about, what other analyzers it depends on, the prompts and
  default configuration it uses, how to enumerate the work it could do, and how
  to perform one piece of that work. Analyzers are the only things that create
  nodes.
- **Analyzer version** — an analyzer's declared release, a `major.minor` pair
  owned by its author (third-party, out-of-tree analyzers declare it when they
  register). The version represents everything the author *ships*: the analysis
  logic, the default prompt, and the default model tier. Improving an analyzer
  means bumping the version — **major** for a change the author judges
  significant, **minor** for a small one. Prompt or default changes are folded
  into that one number; shipped defaults have no separate identity axis. A new
  version produces new nodes rather than overwriting old ones.
- **Config** — everything the *user* sets for an analyzer: thresholds and
  parameters, a prompt override, the tier→model mapping, and any model pin. The
  resolved model lives here. Config is content-addressed, so changing any of it
  yields a distinct config identity — but config changes are **never graded**
  major/minor; a different prompt or a different model "is just different."
- **Prompt** — a content-addressed piece of prompt text, recorded for provenance
  (which prompt produced a node). A prompt the analyzer *ships* is represented by
  its version, not by a separate identity axis; only a prompt the *user* overrides
  contributes to identity, as part of config.
- **Source set** — the exact collection of inputs a single piece of analysis
  draws on, reduced to a stable fingerprint. Two analyses over the same inputs
  share a source-set fingerprint; adding or changing inputs changes it. A
  consumer's source set references its upstream sources by their **output key**
  (below), so the consumer's identity folds in *what those sources concluded*,
  not merely that they exist.
- **Recipe** — the full description of *how a node came to be*: which analyzer,
  which version, which config, and which source set. The recipe is condensed
  into a single fingerprint called the **input key**.
- **Input key** — the content-addressed fingerprint of a recipe (analyzer +
  version + config + source set). It is the system's notion of identity for
  *whether work needs doing*: if a node with a given input key already exists,
  the work it represents is already done. An input key folds in only *inputs* —
  never the model's output — so the same recipe over the same sources always has
  the same input key.
- **Output key** — the content-addressed fingerprint of a node's *result*:
  `hash(input_key, content)`. It identifies a *specific output*. A downstream
  analyzer references its sources by their output key, so the whole graph is a
  Merkle DAG: identical inputs and outputs reproduce identical keys on any
  machine, after any wipe, and a stored key can be re-derived from content to
  **verify** the node. Because analysis is append-only, a different output is
  always a different node and therefore a different output key.
- **Idempotency** — the property that running analysis again produces no
  duplicate work and no changed results, because identity is the recipe. Re-running
  is always safe and usually a no-op.
- **Verification** — recomputing every node's output key from its stored content
  and confirming it matches. Because identities are content-addressed, any drift
  reveals out-of-band tampering or corruption. (`prospect verify`.)

### Running analysis

- **Plan** — an analyzer's enumeration of the discrete pieces of work it *could*
  do for a session (for example, “one piece of work per turn”). Planning does
  not perform analysis; it only describes the candidate units and their source
  sets.
- **Unit** — one planned piece of work: a source set plus where its result would
  anchor. A unit is the thing that does or does not yet have a corresponding
  node.
- **Scan** — the act of comparing every planned unit against the existing graph
  and classifying it. Scanning is cheap (fingerprint lookups, no model calls)
  and is how the system decides what, if anything, needs doing. This replaces
  any notion of progress cursors or crash bookkeeping.
- **Unit status** — the result of classifying a unit during a scan:
  - **missing** — no *successful* node exists for this unit's recipe. Either it
    has never been attempted, or prior attempts only produced error nodes (which
    carry a decoupled identity and never satisfy a recipe). Missing work is always
    done, even by a frugal run.
  - **stale** — a node exists for this subject but under a different recipe than
    the current one. Staleness carries its *reasons*: **major** or **minor** (the
    analyzer's version moved — graded by the author) and/or **config** (the
    user's setup changed — ungraded). A unit can be stale for several reasons at
    once.
  - **current** — a node already exists for the current recipe; nothing to do.
- **Run** — one execution of an analyzer over a session. A run records its own
  provenance (status, cost, tokens, how many nodes it produced, skipped, or
  revised) so that execution history is itself auditable.
- **Revise reasons** — what a run is allowed to recompute, beyond always filling
  *missing* work. A run with no reasons is frugal: it fills missing analysis and
  touches nothing that already has a node. The reasons widen that reach to
  recompute stale nodes too: **major** (the analyzer had a major version bump),
  **minor** (major *and* minor bumps), and **config** (the user's setup changed).
  Reasons are a *set*, not a ladder — `config` is orthogonal to the author's
  major/minor grade, so you choose any combination (major-plus-config, or
  everything). Recomputing records each result as a new version linked by a
  *revises* edge.
- **Selection versus recompute** — the reasons decide *which* out-of-date units a
  run touches; they never decide *what to recompute toward*. A selected unit is
  always recomputed to the **current recipe in full** — latest version, latest
  config, latest resolved model. The grade is a trigger, not a target: there is
  no recomputing to an intermediate state, so a unit revised for one reason
  absorbs every pending change for that same unit at once and you never get a
  half-updated node.
- **Lineage** — the chain of versioned alternatives for one subject, connected by
  *revises* edges. Because analysis is append-only, recomputing does not replace
  the old conclusion; it adds a newer one beside it, and both remain navigable
  “at the same level.” This is what lets you compare how analysis changed as the
  logic improved.

### Language-model access

- **Model tier** — an abstract quality/cost band (**cheap**, **mid**,
  **expensive**) rather than a concrete model name. An analyzer's *default* tier
  is part of what its version ships; the **tier→model mapping** is the user's
  config. Before a node's identity is computed the tier resolves to a concrete
  model, and that resolved model is part of **config** — so changing which model
  a tier maps to is an ungraded config change, picked up by a run that includes
  the `config` reason.
- **Model pin (per run)** — a single run may pin *every* tier to one specific
  model, overriding the configured mapping for that invocation. That is a config
  change for the run: the pinned model is part of identity, so a pinned run
  produces its own nodes, and the model used and the model recorded can never
  disagree. Existing nodes become stale for the `config` reason rather than
  being silently reused.
- **LLM caller** — the single seam through which any analyzer reaches a language
  model. In normal operation it routes through the host agent platform's own
  model provider system, so credentials and model availability are managed in one
  place and never reimplemented here. In tests it is replaced by a deterministic
  stand-in so the suite needs no network and no API key.

### Proposals (the product)

- **Proposal** — a single, concrete, reviewable suggestion to improve a steering
  artifact: what to change, where, why, with what confidence, and backed by
  evidence drawn from the conversation. Proposals are the system's output and the
  only thing a human is asked to act on.
- **Target** — what a proposal would change (a category such as a standing
  instruction file, a skill, a tool description, or configuration, plus an
  optional location within it).
- **Severity** — the nature of the signal behind a proposal (for example
  friction, correction, waste, suggestion, or insight). It describes *why the
  proposal exists*, not how urgent it is.
- **Materialisation** — the step that lifts proposals out of a summary node into
  the fast, reviewable proposal store, attaching the evidence trail via
  *produces* and *anchors* edges. That trail is browsable after the fact: from a
  proposal you can walk back through the node that produced it to the turns it
  consumed and the messages they anchor, and read those turns verbatim
  (`prospect show`).
- **Proposal status** — where a proposal sits in its lifecycle: **open** (awaiting
  a decision), **applied** (accepted/acted upon), **rejected** (declined), or
  **duplicate** (recognised as the same as an existing open proposal).

---

## 3. Why the architecture is shaped this way

Each decision below exists to serve the guiding intent — traceability and cheap
recomputation — and to avoid a specific failure mode.

### Append-only analysis, never mutation

Analysis results are written once and never changed. The reason is trust: if a
proposal could be silently rewritten, you could never be sure the evidence you
are looking at is the evidence that produced it. Append-only storage means every
conclusion is permanently tied to the exact inputs and recipe behind it, and
re-analysis adds rather than overwrites.

### Relationships live only in typed edges

There are no parent pointers and no relationship fields buried inside nodes.
Every link is an explicit edge with a named kind. The reason is that the
interesting questions are all about relationships — *what evidence backs this
proposal, what did this summary consume, which version revised which* — and a
single typed-edge fabric answers all of them uniformly. Hiding some relationships
inside nodes and others in a side table would make traversal inconsistent and
provenance unreliable.

### Identity is the recipe (idempotency by input key)

A node's identity is the fingerprint of everything that determines its content:
the analyzer, its **version**, its **config**, and its **inputs** — condensed
into the **input key**. This is what
makes re-running safe and cheap, and it separates two kinds of change. A change
the analyzer's *author* ships — new logic, a reworked default prompt, a different
default tier — is a **version** bump, and the author grades it major or minor. A
change the *user* makes — a threshold, a prompt override, the tier→model mapping,
a model pin — is **config**, and it is never graded; a different prompt or model
"is just different." The resolved model is part of config, so changing which
model a tier maps to makes the affected nodes stale for the `config` reason —
picked up only by a run that asks for it, so a model swap never forces surprise
recomputation. Deterministic analyzers use no model, so nothing about model
settings touches their identity. Leave version, config, and inputs all the same
and nothing is recomputed.

Identities are **content-addressed end to end**. The input key folds in only
inputs (the config's *content* hash, not any database row id; and upstream
sources by their **output key**, not their incidental node id), and the output
key is `hash(input_key, content)`. So the same sessions analysed with the same
analyzers reproduce byte-identical keys on any machine and after any wipe, and
the graph forms a Merkle DAG whose integrity can be re-derived from content
alone (`prospect verify`). Crucially, this is what makes "output matters for
consumers" automatic: because a consumer references its sources by their output
key, a changed upstream output is a new output key, which changes the consumer's
input key and correctly marks it for recomputation — while a *re-run that
reproduces the same output* changes nothing.

### Incrementality by scanning, not by cursors or crash recovery

The system does not keep progress bookmarks and does not maintain crash-recovery
state. Instead, before doing anything it scans: it enumerates the work each
analyzer could do and classifies every candidate as missing, stale, or current
using cheap fingerprint lookups. Whatever is missing gets done; whatever is
current is skipped. The reason is robustness through simplicity: there is no
bookkeeping to get out of sync, nothing to repair after an interruption, and no
way for a stored cursor to disagree with reality. The graph *is* the source of
truth about what has been done, so an interrupted or *failed* run simply leaves
some units missing, and the next scan picks them up. A unit that fails records an
error node for visibility, but because that node carries a decoupled identity
(recipe + message + timestamp) it never claims the recipe's slot — so the unit
stays missing and **self-heals on the next plain fill**, with no special retry
mode. To make that automatic, a session is only retired from the unanalysed queue
once it completes with no errors; a session that had any failure stays queued, so
the next fill re-scans it, recomputes only the still-missing units, and leaves its
prior error nodes intact. This is a deliberate departure from earlier designs that
tracked per-session cursors and recovery status.

### Versioned lineage and the reach of a run

Because analysis logic will keep improving, the system treats a better analyzer
as a *new version* rather than an edit. By default a run is frugal: it fills only
genuinely missing work and never touches subjects that already have a node. When
you have improved an analyzer, or changed your own config, you widen the run's
reach with **revise reasons** — `major` and `minor` for the author's version
bumps, `config` for your own setup changes, in any combination. A run then
re-analyses the matching stale subjects and records each new result as a fresh
version linked back to its predecessor by a *revises* edge. Crucially, the
reasons only *select* what to touch; whatever is touched is recomputed to the
current recipe in full, so you never produce a half-updated node. The old and new
conclusions coexist as navigable alternatives, giving you both economy (don't
redo good work) and the ability to audit how conclusions evolved — without ever
losing the earlier ones.

### Dependency-scoped visibility

An analyzer can read the conversation and its own past output, plus the output of
the analyzers it explicitly declares as dependencies — and nothing else.
Attempting to read undeclared analysis is treated as an error, not quietly
allowed. The reason is to keep the analysis pipeline a clear, declared dependency
graph: composition stays predictable, ordering can be derived, and no analyzer
can develop a hidden reliance on another's internals.

### Deterministic first, language model second

Analysis is layered. A deterministic layer measures every turn with no model
calls at all — lengths, tool failures, wasted output, signs of correction, a
friction score. Only the turns that look high-signal are escalated to a
language-model layer for a nuanced judgement, and only then does a session-level
layer synthesise everything into proposals. The reason is cost and reliability:
the cheap, repeatable layer does the bulk of the triage and always works, the
expensive layer is spent sparingly on the moments that warrant it, and the whole
pipeline still produces useful structure even if the model layer is unavailable.

**Tool arguments and error payloads are first-class evidence.** Analyzers may
consume tool-call arguments and tool-result error text, not just message prose.
This lets the classifier diagnose the *mechanism* of a failure (wrong flags, a
missing `--repo`, targeting the wrong resource) instead of paraphrasing the
user's complaint. The deterministic correction regex in `turn-pair-core` is a
*ranking signal only* — it enriches pairs it matches with a `note=` hint — but
it must never *gate* what the synthesizer is allowed to see. Every pair carries
a truncated verbatim user-text snippet in the digest; pairs the regex misses are
still visible to the session-level LLM. The un-gating ensures that recall is
not bounded by regex coverage.

### Model access through the host platform, with a test seam

All model calls go through one seam that, in production, defers to the host agent
platform's own provider system. The system does not embed provider SDKs, manage
its own keys, or talk to a local model server. The reason is to have exactly one
place where models and credentials are configured — the same place the user
already manages them — and to avoid drift between this tool and its host. That
same seam accepts a deterministic stand-in for testing, so the analysis logic can
be verified end to end without a network, a key, or any nondeterminism.

### Proposals are materialised from their source

Proposals are synthesised inside session-level analysis but then lifted into a
dedicated, fast store for review, each carrying an evidence trail back to the
conversation. A proposal's identity is its **input key**, derived from the
content-addressed **output key** of the node that produced it plus its ordinal
in that node's output — never from the model's free-text title, path, or
severity. So re-materialising the same node is idempotent (it never double-
inserts), but two genuinely distinct sources — a different session, or a revised
version — keep their proposals separately. Overlapping suggestions across
sessions are intentionally retained rather than collapsed: the review step is
expected to be consumed with the help of an AI agent that sees the whole
picture, so the listing simply groups proposals per session and ranks them
by confidence. The reason identity is anchored to the source rather than the
wording is that an idempotency key must be a function of *inputs*; the LLM's
output never feeds it, it only flows into a downstream consumer's source
reference via the output key.

---

## 4. Invariants

These statements must always hold. If a change would violate one, the change is
wrong.

- A node, once written, is never modified or deleted.
- Every relationship is an edge with a valid kind and a valid target type; no
  relationships are stored anywhere else.
- A node's identity equals its recipe fingerprint — analyzer, version, config,
  and inputs; two nodes with the same recipe never both exist.
- The analyzer's shipped logic, default prompt, and default tier are represented
  by its version; everything the user sets, including the resolved model, is
  config. The version is graded major/minor by the author; config is never
  graded. An analyzer that uses no model has no model in its identity.
- Re-running analysis without changing the version, config, or inputs produces no
  new nodes.
- Improving an analyzer means a new version and new nodes; existing nodes for the
  old version remain and stay reachable through lineage.
- An analyzer reads only the conversation, its own nodes, and the nodes of its
  declared dependencies.
- Sessions are read-only; the system never writes to the conversation record.
- A proposal can always be traced, via edges, back to the conversation evidence
  that justifies it.
- The system proposes changes to steering artifacts; it never applies them
  itself.

---

## 5. Boundaries and non-goals

To keep the system focused, the following are explicitly *not* part of it:

- **No automatic editing of steering artifacts.** The system surfaces proposals;
  acting on them is a human decision.
- **No eager deletion of superseded analysis.** Old versions are kept for
  comparison; reclaiming space, if ever needed, is a separate, deliberate act.
- **No bespoke model or credential management.** Model access is delegated to the
  host platform; tiers abstract concrete models.
- **No cross-session meta-analysis as a first concern.** The unit of analysis is a
  session; broader pattern-finding builds on top of that later.
- **No real session data inside the project.** All test material is hand-written
  synthetic conversation; real user sessions never enter source, tests, history,
  or build artifacts.

---

## 6. How to think about a change

When extending this system, ask in order:

1. **Which concept am I touching?** Name it using the ubiquitous language above.
   If you find yourself needing a term that isn't here, that's a signal to define
   it here first.
2. **Does it preserve append-only and edge-only relationships?** If a change wants
   to mutate a node or hide a relationship, reconsider.
3. **Does identity still equal the recipe?** If a change affects a node's content,
   make sure it also affects the recipe, so idempotency and invalidation stay
   honest.
4. **Is the work still discoverable by scanning?** New analysis must be something
   a scan can classify as missing, stale, or current — not something tracked by
   side state.
5. **Is the evidence trail intact?** Any new node that informs a proposal must be
   reachable, by edges, from that proposal back to the conversation.

Hold to these and the system stays what it is meant to be: a trustworthy,
cheaply-recomputable engine that turns the friction in past agent conversations
into clear, evidence-backed suggestions for making the next conversation better.
