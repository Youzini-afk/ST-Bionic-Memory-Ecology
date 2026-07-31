import assert from "node:assert/strict";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import {
  commitMemoryChangeSet,
  createMemoryChangeSet,
  fingerprintMaterializedMemoryState,
} from "../domain/memory-changeset.js";
import { admitTurnEvidence } from "../domain/memory-inbox.js";
import {
  inspectMemoryNeighbors,
  inspectMemoryRecords,
  searchMemoryCatalog,
} from "../domain/memory-query.js";

let ledger = createEmptyMemoryLedger({ chatId: "chat:query", now: 1 });
const admission = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-1",
    userText: "Where will Mira go?",
    assistantText: "Mira promised to meet Rowan at the clock tower tomorrow.",
    assistantFloor: 4,
  },
  now: 2,
});
ledger = admission.ledger;
const evidenceId = admission.evidence.id;
const initial = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  sourceEvidenceIds: [evidenceId],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:mira",
      memoryType: "character",
      fields: { name: "Mira", state: "waiting" },
      evidenceIds: [evidenceId],
      importance: 5,
    },
    {
      type: "memory_revision",
      memoryId: "memory:meeting",
      memoryType: "event",
      fields: { title: "Clock tower promise", summary: "Mira will meet Rowan tomorrow." },
      storyTime: { label: "tomorrow", tense: "future" },
      evidenceIds: [evidenceId],
      importance: 8,
    },
    {
      type: "memory_revision",
      memoryId: "memory:mira-belief",
      memoryType: "pov_memory",
      layer: "pov",
      fields: { summary: "Mira believes Rowan will come.", about: ["memory:meeting"] },
      scope: { layer: "pov", ownerType: "character", ownerId: "memory:mira", ownerName: "Mira" },
      evidenceIds: [evidenceId],
      importance: 6,
    },
    {
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

const lexical = searchMemoryCatalog(ledger, { query: "clock tower", limit: 1 });
assert.equal(lexical.total >= 1, true);
assert.equal(lexical.items[0].memoryId, "memory:meeting");
assert.equal(Boolean(lexical.nextCursor), lexical.total > 1);

const semantic = searchMemoryCatalog(ledger, {
  query: "rendezvous",
  semanticMatches: [{ memoryId: "memory:meeting", score: 0.98 }],
});
assert.equal(semantic.items[0].memoryId, "memory:meeting");
assert.equal(semantic.items[0].semanticScore, 0.98);

const povOnly = searchMemoryCatalog(ledger, {
  query: "Rowan",
  layers: ["pov"],
  ownerIds: ["memory:mira"],
});
assert.deepEqual(povOnly.items.map((item) => item.memoryId), ["memory:mira-belief"]);

const inspected = inspectMemoryRecords(ledger, {
  memoryIds: ["memory:meeting", "memory:missing"],
  includeHistory: true,
  includeEvidence: true,
});
assert.equal(inspected.memories[0].head.memoryId, "memory:meeting");
assert.equal(inspected.memories[0].history.length, 1);
assert.equal(inspected.memories[1].head, null);
assert.equal(inspected.evidence[0].id, evidenceId);

const neighbors = inspectMemoryNeighbors(ledger, {
  memoryId: "memory:mira",
  direction: "out",
});
assert.equal(neighbors.relations[0].relationId, "relation:mira-meeting");
assert.equal(neighbors.neighbors[0].memoryId, "memory:meeting");

const firstPage = searchMemoryCatalog(ledger, { query: "Mira", limit: 1 });
const fingerprintBefore = fingerprintMaterializedMemoryState(ledger);
const extra = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  readStateFingerprint: fingerprintBefore,
  sourceEvidenceIds: [evidenceId],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:rowan",
      memoryType: "character",
      fields: { name: "Rowan" },
      evidenceIds: [evidenceId],
    },
  ],
});
ledger = commitMemoryChangeSet(ledger, extra).ledger;
assert.throws(() => searchMemoryCatalog(ledger, { query: "Mira", cursor: firstPage.nextCursor }));

console.log("memory query tests passed");
