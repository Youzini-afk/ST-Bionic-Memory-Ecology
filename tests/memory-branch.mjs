import assert from "node:assert/strict";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import { reconcileMemoryLedgerHistory } from "../domain/history-reconciliation.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { forkMemoryLedger } from "../domain/memory-branch.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { createMemoryRevision } from "../domain/memory-records.js";

let source = createEmptyMemoryLedger({ chatId: "chat:source", now: 1 });
let admitted = reconcileMemoryLedgerHistory(source, {
  turns: [
    {
      turnId: "turn-1",
      userText: "你住在哪里？",
      assistantText: "我住在钟楼。",
      userFloor: 1,
      assistantFloor: 2,
    },
    {
      turnId: "turn-2",
      userText: "后来呢？",
      assistantText: "后来搬到了河边。",
      userFloor: 3,
      assistantFloor: 4,
    },
  ],
  mutationId: "source-history",
  now: 2,
});
source = admitted.ledger;
const [evidenceOne, evidenceTwo] = materializeMemoryLedger(source).evidence.activeEvidence;
const memoryV1 = createMemoryRevision({
  chatId: source.chatId,
  memoryId: "memory:home",
  memoryType: "fact",
  fields: { residence: "钟楼" },
  evidenceIds: [evidenceOne.id],
  createdAt: 3,
});
let commit = appendMemoryLedgerTransaction(source, {
  baseRevision: source.revision,
  idempotencyKey: "source-memory-v1",
  records: [memoryV1],
  sourceEvidenceIds: [evidenceOne.id],
  now: 3,
});
source = commit.ledger;
const memoryV2 = createMemoryRevision({
  chatId: source.chatId,
  memoryId: "memory:home",
  parentRevisionId: memoryV1.id,
  memoryType: "fact",
  fields: { residence: "河边" },
  evidenceIds: [evidenceTwo.id],
  createdAt: 4,
});
commit = appendMemoryLedgerTransaction(source, {
  baseRevision: source.revision,
  idempotencyKey: "source-memory-v2",
  records: [memoryV2],
  sourceEvidenceIds: [evidenceTwo.id],
  now: 4,
});
source = commit.ledger;
assert.equal(
  materializeMemoryLedger(source).memories.byMemoryId.get("memory:home").fields.residence,
  "河边",
);

const forked = forkMemoryLedger(source, {
  targetChatId: "chat:branch",
  targetHostChatId: "branch.jsonl",
  cutoffFloor: 2,
  now: 5,
});
const branchView = materializeMemoryLedger(forked.ledger);
assert.equal(forked.ledger.chatId, "chat:branch");
assert.equal(branchView.evidence.activeEvidence.length, 1);
assert.equal(branchView.evidence.activeEvidence[0].content.assistant, "我住在钟楼。");
assert.equal(branchView.memories.byMemoryId.get("memory:home").fields.residence, "钟楼");
assert.ok(forked.ledger.records.every((record) => record.chatId === "chat:branch"));
assert.equal(materializeMemoryLedger(source).evidence.activeEvidence.length, 2);

const fullFork = forkMemoryLedger(source, {
  targetChatId: "chat:full-branch",
  now: 6,
});
assert.equal(materializeMemoryLedger(fullFork.ledger).evidence.activeEvidence.length, 2);
assert.equal(
  materializeMemoryLedger(fullFork.ledger).memories.byMemoryId.get("memory:home").fields.residence,
  "河边",
);

console.log("memory branch tests passed");
