import assert from "node:assert/strict";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import {
  MemoryLedgerConflictError,
  MemoryLedgerValidationError,
  appendMemoryLedgerTransaction,
  inspectMemoryLedger,
} from "../domain/memory-ledger.js";
import {
  createEvidenceInvalidation,
  createMemoryRevision,
  createRelationRevision,
  createTurnEvidence,
} from "../domain/memory-records.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";

let ledger = createEmptyMemoryLedger({ chatId: "chat:ledger", now: 1 });
const evidenceOne = createTurnEvidence({
  chatId: ledger.chatId,
  turnId: "turn-1",
  userMessageId: "user-1",
  assistantMessageId: "assistant-1",
  userText: "你认识艾琳吗？",
  assistantText: "艾琳住在钟楼。",
  createdAt: 2,
});
let committed = appendMemoryLedgerTransaction(ledger, {
  baseRevision: 0,
  idempotencyKey: "evidence:turn-1",
  records: [evidenceOne],
  sourceEvidenceIds: [evidenceOne.id],
  now: 2,
});
ledger = committed.ledger;
assert.equal(ledger.revision, 1);
assert.equal(ledger.records.length, 2);
assert.equal(committed.replayed, false);
assert.equal(committed.commit.parentCommitId, "");
assert.ok(Object.isFrozen(ledger));
assert.ok(Object.isFrozen(committed.appendedRecords[0]));

const replay = appendMemoryLedgerTransaction(ledger, {
  baseRevision: 0,
  idempotencyKey: "evidence:turn-1",
  records: [evidenceOne],
  sourceEvidenceIds: [evidenceOne.id],
  now: 99,
});
assert.equal(replay.replayed, true);
assert.equal(replay.ledger, ledger);

assert.throws(
  () =>
    appendMemoryLedgerTransaction(ledger, {
      baseRevision: 1,
      idempotencyKey: "evidence:turn-1",
      records: [
        createTurnEvidence({
          chatId: ledger.chatId,
          turnId: "turn-other",
          userText: "x",
          assistantText: "y",
        }),
      ],
    }),
  MemoryLedgerConflictError,
);

const memoryV1 = createMemoryRevision({
  chatId: ledger.chatId,
  memoryId: "memory:erin-home",
  memoryType: "character",
  fields: { name: "艾琳", residence: "钟楼" },
  evidenceIds: [evidenceOne.id],
  createdAt: 3,
});
committed = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "memory:erin-home:v1",
  records: [memoryV1],
  readRecordIds: [evidenceOne.id],
  sourceEvidenceIds: [evidenceOne.id],
  now: 3,
});
assert.equal(committed.commit.parentCommitId, replay.commit.id);
ledger = committed.ledger;

const evidenceTwo = createTurnEvidence({
  chatId: ledger.chatId,
  turnId: "turn-2",
  userText: "她搬家了吗？",
  assistantText: "艾琳已经从钟楼搬到了河畔小屋。",
  createdAt: 4,
});
committed = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "evidence:turn-2",
  records: [evidenceTwo],
  sourceEvidenceIds: [evidenceTwo.id],
  now: 4,
});
ledger = committed.ledger;
const memoryV2 = createMemoryRevision({
  chatId: ledger.chatId,
  memoryId: memoryV1.memoryId,
  parentRevisionId: memoryV1.id,
  memoryType: "character",
  fields: { name: "艾琳", residence: "河畔小屋" },
  evidenceIds: [evidenceTwo.id],
  createdAt: 5,
});
const derived = createMemoryRevision({
  chatId: ledger.chatId,
  memoryId: "memory:erin-trend",
  layer: "derived",
  memoryType: "reflection",
  fields: { summary: "艾琳离开了长期居所。" },
  dependencyRevisionIds: [memoryV2.id],
  createdAt: 5,
});
const relation = createRelationRevision({
  chatId: ledger.chatId,
  relationId: "relation:erin-home",
  fromMemoryId: memoryV1.memoryId,
  toMemoryId: derived.memoryId,
  relation: "supports",
  dependencyRevisionIds: [memoryV2.id, derived.id],
  createdAt: 5,
});
committed = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "memory:erin-home:v2",
  records: [memoryV2, derived, relation],
  sourceEvidenceIds: [evidenceTwo.id],
  now: 5,
});
ledger = committed.ledger;

let view = materializeMemoryLedger(ledger);
assert.equal(view.memories.byMemoryId.get(memoryV1.memoryId).id, memoryV2.id);
assert.equal(view.memories.byMemoryId.get(derived.memoryId).id, derived.id);
assert.equal(view.relations.active.length, 1);

const invalidation = createEvidenceInvalidation({
  chatId: ledger.chatId,
  evidenceId: evidenceTwo.id,
  reason: "assistant-reroll",
  mutationId: "mutation-1",
  createdAt: 6,
});
committed = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "invalidate:turn-2",
  records: [invalidation],
  readRecordIds: [evidenceTwo.id],
  now: 6,
});
ledger = committed.ledger;
view = materializeMemoryLedger(ledger);
assert.equal(view.memories.byMemoryId.get(memoryV1.memoryId).id, memoryV1.id);
assert.equal(view.memories.byMemoryId.has(derived.memoryId), false);
assert.equal(view.relations.active.length, 0);
assert.ok(
  view.memories.inactive.some(
    (entry) =>
      entry.revision.id === memoryV2.id &&
      entry.reasons.includes(`inactive-evidence:${evidenceTwo.id}`),
  ),
);

const beforeInvalid = ledger;
assert.throws(
  () =>
    appendMemoryLedgerTransaction(ledger, {
      baseRevision: ledger.revision,
      idempotencyKey: "invalid-cross-chat",
      records: [
        createTurnEvidence({
          chatId: "chat:other",
          turnId: "turn-x",
          userText: "x",
          assistantText: "y",
        }),
      ],
    }),
  MemoryLedgerValidationError,
);
assert.equal(ledger, beforeInvalid);
assert.equal(inspectMemoryLedger(ledger).valid, true);

assert.throws(
  () =>
    appendMemoryLedgerTransaction(ledger, {
      baseRevision: ledger.revision,
      idempotencyKey: "invalid-source-evidence",
      records: [
        createMemoryRevision({
          chatId: ledger.chatId,
          memoryId: "memory:invalid-source",
          memoryType: "event",
          fields: { summary: "invalid source" },
          evidenceIds: [evidenceOne.id],
        }),
      ],
      sourceEvidenceIds: ["evidence:missing"],
    }),
  MemoryLedgerValidationError,
);

console.log("memory ledger tests passed");
