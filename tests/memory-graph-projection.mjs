import assert from "node:assert/strict";
import { projectMemoryLedgerToGraph } from "../projection/memory-graph-projection.js";
import { createMemoryChangeSet, commitMemoryChangeSet } from "../domain/memory-changeset.js";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import { admitTurnEvidence } from "../domain/memory-inbox.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { createEvidenceInvalidation } from "../domain/memory-records.js";
import { createEmptyGraph } from "../graph/graph.js";

let ledger = createEmptyMemoryLedger({ chatId: "chat:projection", now: 1 });
const admission = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-1",
    userText: "What happens tomorrow?",
    assistantText: "Mira plans to meet Rowan at the clock tower, but wrongly believes the tower is closed.",
    assistantFloor: 4,
  },
  now: 2,
});
ledger = admission.ledger;
const evidenceId = admission.evidence.id;
const initial = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  taskId: "task:projection",
  sourceEvidenceIds: [evidenceId],
  operations: [
    {
      id: "revision:mira:1",
      type: "memory_revision",
      memoryId: "memory:mira",
      memoryType: "character",
      fields: { name: "Mira", state: "planning a meeting" },
      evidenceIds: [evidenceId],
    },
    {
      id: "revision:meeting:1",
      type: "memory_revision",
      memoryId: "memory:meeting",
      memoryType: "event",
      fields: { title: "Clock tower meeting", summary: "Mira plans to meet Rowan." },
      storyTime: { label: "tomorrow", tense: "future", confidence: "high", source: "extract" },
      evidenceIds: [evidenceId],
      importance: 8,
    },
    {
      id: "revision:mira-belief:1",
      type: "memory_revision",
      memoryId: "memory:mira-belief",
      memoryType: "pov_memory",
      layer: "pov",
      fields: {
        summary: "Mira believes the tower is closed.",
        certainty: "mistaken",
        about: ["memory:meeting"],
      },
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "memory:mira",
        ownerName: "Mira",
        regionPrimary: "clock tower",
      },
      storyTime: { label: "tomorrow", tense: "future", source: "extract" },
      evidenceIds: [evidenceId],
    },
    {
      id: "revision:synopsis:1",
      type: "memory_revision",
      memoryId: "memory:synopsis",
      memoryType: "synopsis",
      layer: "derived",
      fields: { summary: "Mira's planned meeting is complicated by a mistaken belief.", level: 1 },
      dependencyRevisionIds: ["revision:meeting:1", "revision:mira-belief:1"],
      importance: 9,
    },
    {
      id: "revision:relation:1",
      type: "relation_revision",
      relationId: "relation:mira-meeting",
      fromMemoryId: "memory:mira",
      toMemoryId: "memory:meeting",
      relation: "involved_in",
      evidenceIds: [evidenceId],
      strength: 0.9,
    },
  ],
  createdAt: 3,
});
ledger = commitMemoryChangeSet(ledger, initial).ledger;

const baseGraph = createEmptyGraph();
baseGraph.lastRecallResult = { marker: "preserve-runtime-state" };
const first = projectMemoryLedgerToGraph(ledger, baseGraph);
assert.equal(first.changed, true);
assert.deepEqual(first.graph.nodes.map((node) => node.id).sort(), [
  "memory:meeting",
  "memory:mira",
  "memory:mira-belief",
  "memory:synopsis",
]);
const meeting = first.graph.nodes.find((node) => node.id === "memory:meeting");
assert.equal(meeting.memoryRevisionId, "revision:meeting:1");
assert.deepEqual(meeting.seqRange, [4, 4]);
assert.equal(meeting.sourceFloor, 4);
assert.equal(meeting.storyTime.segmentId.startsWith("bme-timeline_"), true);
assert.equal(first.graph.edges[0].id, "relation:mira-meeting");
assert.equal(first.graph.edges[0].relationRevisionId, "revision:relation:1");
assert.equal(first.graph.summaryState.activeEntryIds.includes("memory:synopsis"), true);
assert.equal(first.graph.summaryState.entries[0].text.includes("mistaken belief"), true);
const miraKnowledge = Object.values(first.graph.knowledgeState.owners).find(
  (owner) => owner.ownerName === "Mira",
);
assert.equal(miraKnowledge.mistakenNodeIds.includes("memory:meeting"), true);
assert.deepEqual(first.graph.lastRecallResult, { marker: "preserve-runtime-state" });
assert.equal(first.graph.historyState.lastProcessedAssistantFloor, 4);
assert.equal(first.graph.vectorIndexState.dirty, true);

const hydrated = first.graph;
hydrated.nodes.find((node) => node.id === "memory:meeting").embedding = [0.25, 0.75];
hydrated.nodes.find((node) => node.id === "memory:meeting").accessCount = 3;
hydrated.vectorIndexState.nodeToHash = { "memory:meeting": "hash:meeting" };
hydrated.vectorIndexState.hashToNodeId = { "hash:meeting": "memory:meeting" };
hydrated.vectorIndexState.dirty = false;
hydrated.vectorIndexState.replayRequiredNodeIds = [];
const repeated = projectMemoryLedgerToGraph(ledger, hydrated);
assert.equal(repeated.changed, false);
assert.deepEqual(repeated.graph.nodes.find((node) => node.id === "memory:meeting").embedding, [0.25, 0.75]);
assert.equal(repeated.graph.nodes.find((node) => node.id === "memory:meeting").accessCount, 3);
assert.equal(repeated.graph.vectorIndexState.nodeToHash["memory:meeting"], "hash:meeting");

const rebuilt = projectMemoryLedgerToGraph(ledger, createEmptyGraph());
assert.equal(
  rebuilt.graph.nodes.find((node) => node.id === "memory:meeting").storyTime.segmentId,
  repeated.graph.nodes.find((node) => node.id === "memory:meeting").storyTime.segmentId,
);

const meetingHead = materializeMemoryLedger(ledger).memories.heads.get("memory:meeting");
const update = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  sourceEvidenceIds: [evidenceId],
  operations: [
    {
      id: "revision:meeting:2",
      type: "memory_revision",
      memoryId: "memory:meeting",
      parentRevisionId: meetingHead.id,
      memoryType: "event",
      fields: { title: "Clock tower meeting", summary: "The meeting was moved to noon." },
      storyTime: { label: "tomorrow", tense: "future", source: "extract" },
      evidenceIds: [evidenceId],
      importance: 8,
    },
  ],
  createdAt: 5,
});
ledger = commitMemoryChangeSet(ledger, update).ledger;
const updated = projectMemoryLedgerToGraph(ledger, repeated.graph);
const updatedMeeting = updated.graph.nodes.find((node) => node.id === "memory:meeting");
assert.equal(updatedMeeting.id, "memory:meeting");
assert.equal(updatedMeeting.memoryRevisionId, "revision:meeting:2");
assert.equal(updatedMeeting.fields.summary, "The meeting was moved to noon.");
assert.equal(updatedMeeting.embedding, null);
assert.equal(updatedMeeting.accessCount, 3);
assert.equal(updated.graph.vectorIndexState.dirty, true);
assert.equal(updated.graph.vectorIndexState.nodeToHash["memory:meeting"], undefined);

const invalidation = createEvidenceInvalidation({
  chatId: ledger.chatId,
  evidenceId,
  reason: "history-deleted",
  mutationId: "mutation:delete-turn-1",
  createdAt: 6,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "invalidate:projection-turn",
  records: [invalidation],
  readRecordIds: [evidenceId],
  sourceEvidenceIds: [evidenceId],
  reason: "history-reconciliation",
  now: 6,
}).ledger;
const retracted = projectMemoryLedgerToGraph(ledger, updated.graph);
assert.equal(retracted.graph.nodes.length, 0);
assert.equal(retracted.graph.edges.length, 0);
assert.equal(retracted.deletedNodeIds.includes("memory:meeting"), true);
assert.equal(retracted.graph.historyState.lastProcessedAssistantFloor, -1);

console.log("memory graph projection tests passed");
