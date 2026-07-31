import assert from "node:assert/strict";
import { MemoryStewardToolset } from "../agent/memory-steward-tools.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { createMemoryChangeSet, commitMemoryChangeSet } from "../domain/memory-changeset.js";
import { admitTurnEvidence } from "../domain/memory-inbox.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { createEvidenceInvalidation } from "../domain/memory-records.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

const chatId = "chat:steward-tools";
const repository = new InMemoryLedgerRepository(chatId);
let ledger = await repository.load(chatId);
const admission = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-1",
    userText: "What changed?",
    assistantText: "Mira moved from the inn to the riverside house.",
    assistantFloor: 7,
  },
  now: 2,
});
repository.ledgers.set(chatId, admission.ledger);

let semanticCalls = 0;
const toolset = new MemoryStewardToolset({
  repository,
  semanticSearch: async ({ query }) => {
    semanticCalls += 1;
    return query === "home" ? [{ memoryId: "memory:mira-home", score: 0.9 }] : [];
  },
  now: () => 10,
});
const registry = new AgentToolRegistry();
const dispose = toolset.registerInto(registry);
const tools = registry.capture();
const scope = { runId: "run:steward-tools", signal: new AbortController().signal };
toolset.openTask({
  runId: scope.runId,
  chatId,
  taskId: "task:steward-tools",
  inboxIds: [admission.inboxItem.inboxId],
  sourceEvidenceIds: [admission.evidence.id],
});

const execute = async (name, args = {}) =>
  await tools.execute({ id: `call:${name}`, name, arguments: JSON.stringify(args) }, scope);

const context = await execute("memory_task_context");
assert.equal(context.ok, true);
assert.equal(context.value.assignedEvidence[0].id, admission.evidence.id);
assert.equal(context.value.stats.activeMemories, 0);

const staged = await execute("memory_stage_changes", {
  reason: "record relocation",
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:mira-home",
      memoryType: "character",
      fields: { name: "Mira", state: "living at the riverside house" },
      evidenceIds: [admission.evidence.id],
      importance: 7,
    },
  ],
});
assert.equal(staged.ok, true);
assert.equal(staged.value.staged, true);
assert.equal((await execute("memory_validate_changes")).value.valid, true);
const committed = await execute("memory_commit_changes");
assert.equal(committed.ok, true);
assert.equal(committed.value.committed, true);
assert.equal(toolset.getOutcome(scope.runId).kind, "committed");
assert.equal(
  materializeMemoryLedger(await repository.load(chatId)).memories.byMemoryId.get("memory:mira-home").fields.state,
  "living at the riverside house",
);
const replayedCommit = await execute("memory_commit_changes");
assert.equal(replayedCommit.value.commitId, committed.value.commitId);

toolset.closeTask(scope.runId);

const staleScope = { runId: "run:steward-stale" };
toolset.openTask({
  runId: staleScope.runId,
  chatId,
  taskId: "task:steward-stale",
  inboxIds: [admission.inboxItem.inboxId],
  sourceEvidenceIds: [admission.evidence.id],
});
assert.equal((await tools.execute({ name: "memory_task_context", arguments: "{}" }, staleScope)).ok, true);
const search = await tools.execute(
  { name: "memory_search", arguments: JSON.stringify({ query: "home" }) },
  staleScope,
);
assert.equal(search.ok, true);
assert.equal(search.value.items[0].memoryId, "memory:mira-home");
assert.equal(search.value.semanticStatus, "available");
assert.equal(semanticCalls, 1);
ledger = await repository.load(chatId);
const external = createMemoryChangeSet({
  chatId,
  baseRevision: ledger.revision,
  sourceEvidenceIds: [admission.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:external-change",
      memoryType: "event",
      fields: { summary: "An external semantic change arrived." },
      evidenceIds: [admission.evidence.id],
    },
  ],
  createdAt: 11,
});
repository.ledgers.set(chatId, commitMemoryChangeSet(ledger, external).ledger);
const staleNoChange = await tools.execute(
  {
    name: "memory_complete_without_changes",
    arguments: JSON.stringify({ reason: "nothing else to record" }),
  },
  staleScope,
);
assert.equal(staleNoChange.ok, false);
assert.equal(staleNoChange.error.details.code, "memory_steward_state_changed");
assert.equal(toolset.getOutcome(staleScope.runId).kind, "pending");
const refreshed = await tools.execute(
  { name: "memory_task_context", arguments: JSON.stringify({ refresh: true }) },
  staleScope,
);
assert.equal(refreshed.ok, true);
const noChange = await tools.execute(
  {
    name: "memory_complete_without_changes",
    arguments: JSON.stringify({ reason: "all evidence is already represented" }),
  },
  staleScope,
);
assert.equal(noChange.ok, true);
assert.equal(noChange.value.kind, "no_change");
toolset.closeTask(staleScope.runId);

ledger = await repository.load(chatId);
const obsoleteAdmission = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-obsolete",
    userText: "Old branch",
    assistantText: "This branch was later deleted.",
  },
  now: 12,
});
ledger = obsoleteAdmission.ledger;
const obsoleteInvalidation = createEvidenceInvalidation({
  chatId,
  evidenceId: obsoleteAdmission.evidence.id,
  reason: "history-deleted",
  mutationId: "mutation:obsolete",
  createdAt: 13,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "invalidate:obsolete",
  records: [obsoleteInvalidation],
  sourceEvidenceIds: [obsoleteAdmission.evidence.id],
  reason: "history-reconciliation",
  now: 13,
}).ledger;
repository.ledgers.set(chatId, ledger);
const mixedScope = { runId: "run:steward-mixed-evidence" };
toolset.openTask({
  runId: mixedScope.runId,
  chatId,
  taskId: "task:steward-mixed-evidence",
  sourceEvidenceIds: [admission.evidence.id, obsoleteAdmission.evidence.id],
});
assert.equal(
  (await tools.execute({ name: "memory_task_context", arguments: "{}" }, mixedScope)).ok,
  true,
);
const mixedStage = await tools.execute(
  {
    name: "memory_stage_changes",
    arguments: JSON.stringify({
      operations: [
        {
          type: "memory_revision",
          memoryId: "memory:active-source-only",
          memoryType: "event",
          fields: { summary: "Only the active branch supports this memory." },
          evidenceIds: [admission.evidence.id],
        },
      ],
    }),
  },
  mixedScope,
);
assert.equal(mixedStage.ok, true);
assert.equal(mixedStage.value.staged, true);
toolset.closeTask(mixedScope.runId);
dispose();

console.log("memory steward tool tests passed");
