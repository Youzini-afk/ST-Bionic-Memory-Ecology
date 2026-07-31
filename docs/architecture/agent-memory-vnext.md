# BME Agent memory architecture

This document is the implementation contract for the Agent-era memory core. It
describes the target architecture, not a compatibility layer around the legacy
pipeline.

## Authority of data

The durable authority is a per-chat append-only ledger. Its records contain:

1. immutable conversation evidence;
2. evidence invalidations caused by edit, delete, swipe, reroll, or branch;
3. versioned objective, POV, and derived memories with explicit dependencies;
4. versioned relations;
5. atomic commits;
6. durable inbox items, Agent checkpoints, and append-only Agent boundary events;
7. immutable Recall and Planner Artifacts bound to one exact user-turn version.

The visible graph, timeline, cognition view, summaries, vector index, and recall
candidate caches are materialized projections. They may be rebuilt and never
turn a failed ledger commit into a successful save.

## Agent roles

The background Memory Steward consumes a durable per-chat inbox. It reads source
turns and memory indexes through tools, stages a change set, validates it, and
publishes it in one domain transaction. Extraction, consolidation, evolution,
summary, reflection, and compression are capabilities of this one open tool
loop, not independent mandatory LLM stages.

The Steward claims every currently runnable inbox item for a chat as one atomic
assignment. It may search lexically and semantically, inspect exact revisions,
relations, and evidence, and then either publish one complete change set or
record an explicit no-change outcome. New semantic state invalidates an old
plan; Agent journal and inbox-only commits may be rebased because they do not
change the materialized memory view. Deferred work stays durable and is retried
by a later wake rather than by an unbounded foreground retry loop.

The foreground Recall Agent receives a programmatic multi-channel candidate
packet. It may publish immediately or query deeper through the same read tools.
It writes exactly one turn-scoped Recall Artifact. ENA remains opt-in and uses
that artifact; reroll reuses the parent user turn's Recall and Planner Artifacts
without rerunning either Agent.

The candidate packet is a fast starting point rather than a retrieval boundary.
It combines deterministic retrieval with a recent-memory tail for dirty,
unindexed, or replay-required vector state, so recall never waits for index
repair. Backend vector scores are used when the server returns a score,
similarity, or distance; rank is identified honestly as a fallback when it does
not. The Agent publishes stable memory IDs only. BME revalidates those IDs and
formats the final injection from the current ledger projection, so generated
text cannot become memory evidence by crossing the publish boundary.

A Recall Artifact has an explicit `ready` or `empty` completion state. Empty is
a successful, persisted outcome: first-turn recall still gets a recall card and
ENA does not invoke recall a second time. A Planner Artifact must reference the
Recall Artifact from the same turn and input/history fingerprint. The pair is a
deliberate turn snapshot: unrelated later Steward evolution does not change a
reroll, while invalidated evidence, revisions, or source artifacts invalidate
the affected snapshot.

## Concurrency and recovery

- Inbox admission is durable before execution is woken.
- One coordinator serializes writers for a chat; different chats may run in
  parallel.
- An Agent run never holds the writer lock while waiting for an LLM or a tool.
- Commit validation checks chat identity, source evidence, and every read
  dependency. Unrelated commits may rebase; semantic conflicts require replanning.
- A late task may commit to its origin chat repository but may not publish into
  another active chat's graph, UI, prompt, or message array.
- In-flight provider streams and non-idempotent tools are not replayed after a
  crash. Durable inbox work remains pending and resumes from the last safe
  checkpoint.

The ledger revision is independent from the physical graph-store revision.
Each immutable ledger record is stored under its own nested metadata key and a
small head points to the latest commit. A write checks the physical store CAS
and the ledger parent commit. Unrelated projection writes may advance the
physical revision and be retried; a changed ledger head is a semantic conflict.
This avoids rewriting the complete ledger on every turn and lets IndexedDB,
OPFS, and the Authority module share the same atomic boundary.

The compatibility graph projection uses stable `memoryId` and `relationId`
identities. Sequence ranges and persistence repair floors are derived from the
supporting turn evidence, while revision and evidence provenance remain on the
projected records. Timeline segments are deterministic, synopsis revisions
materialize summary entries, and POV revisions materialize cognition ownership.
An unchanged revision keeps runtime access statistics and embeddings; a changed
or retracted revision invalidates its vector mapping. The projection can be
rebuilt without becoming a second source of truth.

History reconciliation compares the complete current set of assistant-turn
evidence with the ledger. Mutable SillyTavern array indexes remain locators
only. Delete, edit, reroll, and swipe append evidence disposition records;
selecting an older swipe reactivates its earlier evidence instead of extracting
it again. A branch receives a distinct chat identity, retains its lineage, and
imports only the evidence and memory revisions valid at its cutoff.

## Context and limits

BME model presets own the model and its context-window size. Context compaction
is token-aware: it changes the Agent-visible projection while preserving the
full durable journal. A provider request and every tool start are journaled
before crossing their boundary; an interrupted boundary is suspended rather
than replayed. Tool registrations are snapshotted for a run, so a hot reload
cannot silently change the implementation midway through that run. There is no
character-count cap. The only default runaway
guards are 500 tool calls and eight minutes, both configurable in BME.

## Host boundary

Only `host/` knows SillyTavern event names, mutable message indexes, extension
prompt placement, Regex, MVU, TavernHelper, Luker, group generation, or branch
payloads. Domain and Agent code use stable chat, turn, message-version, and
generation identities supplied by the host adapter.

## Released runtime composition

`MemoryLifecycleRuntime` is the single production owner of a selected chat's
ledger, history reconciliation, Recall Agent, Memory Steward, Planner
Artifacts, branching, and manual memory mutations. SillyTavern events first
capture a stable conversation snapshot and then call this lifecycle; the graph
and panel receive only a materialized projection after a successful commit.
Switching chats replaces the active lifecycle, while a late task keeps writing
to its frozen origin repository and is barred from publishing into the newly
active UI.

Existing graph data is imported once through one atomic migration transaction.
The transaction contains evidence, memory and relation revisions plus a
migration marker, so a partial conversion can never become authoritative and a
completed conversion is never repeated. Evidence that cannot be tied to a
historical assistant turn is marked as external to history reconciliation
rather than being incorrectly invalidated on the next load.

The physical stores preserve the same ledger semantics:

- Standard SillyTavern stores immutable ledger records in the per-chat
  conversation repository beside the rebuildable graph projection.
- Luker stores the ledger in the dedicated `st_bme_memory_ledger_v1`
  chat-state namespace with revision CAS. It never falls back to browser-local
  storage, which would silently split one chat into two authorities.
- Cloud Sync removes ledger keys from generic metadata overlay. It selects the
  descendant when one ledger contains the other, deterministically replays
  compatible divergent transactions, and rejects conflicting Agent event
  chains rather than manufacturing a winner.

ENA and ordinary generation call the same Recall Agent entry point. ENA keeps
the resulting Recall Artifact through the planner handoff; after SillyTavern
binds the user floor, BME publishes the Planner Artifact against that exact
turn. A reroll reads this durable pair. It does not rerun retrieval or planning,
and an `empty` Recall Artifact remains a valid reusable result.

Manual edit, graph import, whole-graph clear, range clear, and archive operations
are ledger transactions too. Import replaces the active ledger snapshot;
clear operations append auditable archive revisions. UI controls do not mutate
the compatibility graph directly. Background Steward progress uses
its own status channel, so it neither lengthens the foreground extraction
notice nor blocks generation and recall.

## Cutover rule

Development may compare the old and new cores in tests, but the released
runtime has one owner for each behavior. The old extraction and maintenance
implementations may remain as import/build-time modules while migration is
settling, but SillyTavern lifecycle events and exposed maintenance actions do
not run them as a second live writer or fallback. Any old-data support is a
one-time importer outside the live runtime.
