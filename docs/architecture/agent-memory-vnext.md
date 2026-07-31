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
6. durable inbox items and Agent checkpoints.

The visible graph, timeline, cognition view, summaries, vector index, and recall
candidate caches are materialized projections. They may be rebuilt and never
turn a failed ledger commit into a successful save.

## Agent roles

The background Memory Steward consumes a durable per-chat inbox. It reads source
turns and memory indexes through tools, stages a change set, validates it, and
publishes it in one domain transaction. Extraction, consolidation, evolution,
summary, reflection, and compression are capabilities of this one open tool
loop, not independent mandatory LLM stages.

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

## Context and limits

BME model presets own the model and its context-window size. Context compaction
is token-aware: it changes the Agent-visible projection while preserving the
full durable journal. There is no character-count cap. The only default runaway
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

