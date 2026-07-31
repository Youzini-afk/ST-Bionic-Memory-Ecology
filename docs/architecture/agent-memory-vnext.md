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
6. durable inbox items, Agent checkpoints, and append-only Agent boundary events.

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

## Cutover rule

Development may compare the old and new cores in tests, but the released
runtime has one owner for each behavior. After product-contract parity, the old
extraction, maintenance, recall, and history mutation paths are removed rather
than retained as a fallback. Any old-data support is a one-time importer outside
the live runtime.
