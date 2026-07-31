# BME Agent memory architecture

This document is the implementation contract for BME's two runtime modes. It
does not define a second memory format and it does not authorize removing the
existing workflow product.

## One memory authority, two orchestration modes

Memory remains the current chat's graph. Its canonical persistence tier is
selected by the existing host and storage rules:

- Authority SQL when Authority is the selected primary;
- Luker chat-state when Luker owns the chat and Authority is not primary;
- otherwise the selected browser-local OPFS or IndexedDB store.

Cloud Sync remains a replica of browser-local storage rather than another
primary. The graph, processed-floor/hash state, batch and maintenance journals,
summary state, cognition, timeline, vector state, and recall records keep their
existing persistence and rollback semantics.

`memoryRuntimeMode` changes only how work is decided and scheduled:

- `workflow` is the default. Existing event-driven recall, extraction,
  maintenance, ENA, reroll, and history recovery run exactly as configured.
- `agent` lets BME's own model decide recall depth and which enabled workflow
  capabilities a new assistant batch needs. The chosen work still executes
  through the same graph controllers, detached working graphs, durability
  gates, and atomic publish boundary.

Switching modes never migrates, copies, imports, projects, or changes ownership
of memory. Workflow settings are not legacy compatibility controls. Fixed
cadence, surprise triggering, and one-turn delay schedule Workflow mode; all
other capability toggles and parameters remain Agent permissions and bounds.

## Foreground Recall Agent

Deterministic retrieval first builds a multi-channel candidate packet. The
Recall Agent may publish it immediately or use tools to:

1. read the frozen turn and candidate packet;
2. search the full current graph with a new query;
3. inspect exact active nodes;
4. traverse graph relations;
5. publish one validated list of stable graph node IDs.

BME, not the model, formats final injection text from the selected graph nodes.
The tool boundary re-applies the existing POV, owner, region, and cognition
filters before a node can be read, traversed, or published. An empty selection
is valid. Provider failure, malformed tool use, or a run guard never makes
recall unavailable: BME falls back to the deterministic selection already
produced for that same turn.

Each recall run clones one frozen graph snapshot before its first async model or
vector step. It never waits for a Graph Steward already working in the
background. A Steward commit completed before the clone is visible immediately;
one completed afterward becomes available on the next turn. This prevents a
single injection from mixing pre-commit candidates with post-commit nodes.

The existing generation transaction and user-floor recall record remain outside
the Agent. Therefore ENA handoff, recall cards, no-new-user generation, and
reroll reuse keep the same delivery and persistence semantics in both modes.
Disabling LLM recall also disables the Recall Agent and leaves deterministic
retrieval active.

## Background Graph Steward

In Agent mode every pending assistant batch is offered to a background Graph
Steward instead of waiting for a fixed `extractEvery` cadence. The Steward reads
the complete unprocessed batch, graph statistics, and the user's enabled
capabilities, then makes one disposition:

- run the existing extraction pipeline with a need-based subset of enabled
  consolidation, hierarchical summary, reflection, compression, and forgetting;
- or persist an explicit no-change processed-history checkpoint.

The Steward cannot enable a capability the user disabled. Extraction and all
selected follow-up work still run in the existing workflow controllers, so
scope/POV rules, story time, task presets, vector handling, batch persistence,
Luker behavior, Authority transactions, and background maintenance are reused
rather than reimplemented.

If the Steward model fails or exits before attempting a disposition, BME runs
the full user-enabled workflow as a safe fallback. Once a mutating disposition
has started, failure is recorded and never followed by a second pipeline call;
the unadvanced batch remains pending for a later retry. This preserves memory
coverage without risking duplicate side effects.

## Agent control state is not memory state

The generic Agent loop, tool registry, model protocol, token-aware context
manager, and guards are shared infrastructure. Graph-backed Agents use a
transient control journal for model/tool boundary ordering. It contains no
memory mutations and is never a second memory primary. On reload, an unfinished
decision is safely replanned from the canonical graph; committed graph work is
already protected by the existing durable batch transaction.

The append-only memory-ledger modules remain isolated infrastructure and tests.
They are not wired as the production memory owner for either runtime mode.

## Concurrency and recovery

- A task captures the current chat lease and chat-history fingerprint before an
  Agent model call. Every mutating tool rechecks both after the wait.
- Chat changes, chat reloads, plugin disable, and runtime-mode changes abort
  background Agent decisions. A late task cannot publish into the new chat.
- Recall also remains inside the existing generation lease and abort controller.
- The Graph Steward never mutates the graph while waiting for the model. Its
  selected pipeline creates the same detached working graph used by workflow
  mode and publishes only after canonical persistence accepts it.
- An explicit no-change decision writes a reversible no-op batch journal and
  advances processed history only after a durable graph save. Failed
  persistence restores the prior live snapshot; a post-save history mismatch is
  marked dirty and sent through the shared recovery path.
- Reroll, edit, delete, swipe, branch, and history recovery remain shared graph
  operations. They do not need mode-specific migration or reconciliation.

## Model ownership, context, and guards

Agent calls use BME's configured memory model, never DOA's model. The configured
context window drives token-aware compaction; there is no character-count cap.
The only default runaway guards are 500 tool calls and eight minutes per Agent
task, both configurable in BME. These guards do not limit workflow steps,
retrieval candidates, graph size, conversation length, or the number of future
tasks.

## Product rule

New Agent behavior must be introduced by composition around stable workflow
boundaries. A phase is incomplete if it hides, disables, deletes, or bypasses an
existing product capability merely because Agent mode can perform related work.
Workflow mode must remain a complete product, and Agent mode must fail back to
that complete product without changing the chat's memory authority.
