import assert from "node:assert/strict";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import {
  commitMemoryChangeSet,
  createMemoryChangeSet,
  validateMemoryChangeSet,
} from "../domain/memory-changeset.js";
import { admitTurnEvidence } from "../domain/memory-inbox.js";
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

console.log("memory changeset tests passed");
