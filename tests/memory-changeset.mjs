import assert from "node:assert/strict";
import {
  MEMORY_INBOX_STATUS,
  createEmptyMemoryLedger,
} from "../domain/memory-contract.js";
import {
  commitMemoryChangeSet,
  createMemoryChangeSet,
  fingerprintMaterializedMemoryState,
  validateMemoryChangeSet,
} from "../domain/memory-changeset.js";
import { admitTurnEvidence, transitionInboxItem } from "../domain/memory-inbox.js";
import { MemoryLedgerConflictError } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";

let ledger = createEmptyMemoryLedger({ chatId: "chat:changeset", now: 1 });
const admitted = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-1",
    userText: "她答应了吗？",
    assistantText: "艾琳答应明天在钟楼见面。",
  },
  now: 2,
});
ledger = admitted.ledger;
const changeSet = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  taskId: "task-1",
  readRecordIds: [admitted.evidence.id],
  sourceEvidenceIds: [admitted.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:meeting-promise",
      memoryType: "event",
      fields: {
        title: "约定钟楼见面",
        summary: "艾琳答应明天在钟楼见面。",
      },
      evidenceIds: [admitted.evidence.id],
      importance: 7,
    },
  ],
  createdAt: 3,
});
assert.equal(validateMemoryChangeSet(ledger, changeSet).valid, true);
const committed = commitMemoryChangeSet(ledger, changeSet);
ledger = committed.ledger;
assert.equal(committed.memoryRevisionIds.length, 1);
assert.equal(
  materializeMemoryLedger(ledger).memories.byMemoryId.get("memory:meeting-promise")
    .fields.title,
  "约定钟楼见面",
);

const rebasingChangeSet = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  taskId: "task-rebase",
  readRecordIds: [admitted.evidence.id],
  readStateFingerprint: fingerprintMaterializedMemoryState(ledger),
  sourceEvidenceIds: [admitted.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:rebase-safe",
      memoryType: "event",
      fields: { summary: "safe across Agent journal and inbox commits" },
      evidenceIds: [admitted.evidence.id],
    },
  ],
  createdAt: 4,
});
ledger = transitionInboxItem(ledger, {
  inboxId: admitted.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.CLAIMED,
  expectedStatus: MEMORY_INBOX_STATUS.PENDING,
  claimId: "claim-rebase",
  claimOwner: "memory-steward",
  now: 5,
}).ledger;
const rebased = commitMemoryChangeSet(ledger, rebasingChangeSet);
assert.equal(rebased.rebased, true);
assert.equal(rebased.rebasedFromRevision, rebasingChangeSet.baseRevision);
ledger = rebased.ledger;
assert.equal(
  materializeMemoryLedger(ledger).memories.byMemoryId.has("memory:rebase-safe"),
  true,
);

const replayedRebased = commitMemoryChangeSet(ledger, rebasingChangeSet);
assert.equal(replayedRebased.replayed, true);
assert.equal(replayedRebased.ledger, ledger);

const semanticStale = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  taskId: "task-semantic-stale",
  readStateFingerprint: fingerprintMaterializedMemoryState(ledger),
  sourceEvidenceIds: [admitted.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:semantic-stale",
      memoryType: "event",
      fields: { summary: "must be replanned" },
      evidenceIds: [admitted.evidence.id],
    },
  ],
});
const intervening = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  taskId: "task-intervening",
  sourceEvidenceIds: [admitted.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:intervening",
      memoryType: "event",
      fields: { summary: "changes the semantic memory state" },
      evidenceIds: [admitted.evidence.id],
    },
  ],
});
ledger = commitMemoryChangeSet(ledger, intervening).ledger;
assert.throws(
  () => commitMemoryChangeSet(ledger, semanticStale),
  MemoryLedgerConflictError,
);

const stale = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: 1,
  sourceEvidenceIds: [admitted.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:stale",
      memoryType: "event",
      fields: { summary: "stale" },
      evidenceIds: [admitted.evidence.id],
    },
  ],
});
assert.throws(() => commitMemoryChangeSet(ledger, stale), MemoryLedgerConflictError);

const activeHead = materializeMemoryLedger(ledger).memories.heads.get(
  "memory:meeting-promise",
);
const invalidActiveRelation = createMemoryChangeSet({
  chatId: ledger.chatId,
  baseRevision: ledger.revision,
  sourceEvidenceIds: [admitted.evidence.id],
  operations: [
    {
      type: "memory_revision",
      memoryId: "memory:meeting-promise",
      parentRevisionId: activeHead.id,
      memoryType: "event",
      status: "archived",
      fields: activeHead.fields,
      evidenceIds: [admitted.evidence.id],
    },
    {
      type: "relation_revision",
      relationId: "relation:to-archived-memory",
      fromMemoryId: "memory:intervening",
      toMemoryId: "memory:meeting-promise",
      relation: "related",
      evidenceIds: [admitted.evidence.id],
    },
  ],
});
const invalidRelationValidation = validateMemoryChangeSet(
  ledger,
  invalidActiveRelation,
);
assert.equal(invalidRelationValidation.valid, false);
assert.equal(
  invalidRelationValidation.issues.some((issue) =>
    issue.includes("inactive target memory"),
  ),
  true,
);

console.log("memory changeset tests passed");
