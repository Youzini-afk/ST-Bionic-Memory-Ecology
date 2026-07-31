import assert from "node:assert/strict";
import { HistoryTransactionService } from "../application/history-transaction-service.js";
import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import {
  reconcileMemoryLedgerHistory,
  resolveHistoryTurn,
} from "../domain/history-reconciliation.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeMemoryLedger } from "../domain/memory-materializer.js";
import { createMemoryRevision } from "../domain/memory-records.js";
import { buildConversationEvidenceSnapshot } from "../host/conversation-snapshot.js";

const user = (mes, sendDate) => ({
  is_user: true,
  is_system: false,
  name: "You",
  mes,
  send_date: sendDate,
  extra: {},
});
const assistant = (mes, sendDate, swipeId = 0) => ({
  is_user: false,
  is_system: false,
  name: "Erin",
  mes,
  send_date: sendDate,
  swipe_id: swipeId,
  extra: {},
});

const greeting = assistant("你好。", "greeting");
const firstUser = user("你住在哪里？", "u1");
const firstAssistant = assistant("我住在钟楼。", "a1");
const secondUser = user("明天见面吗？", "u2");
const secondAssistant = assistant("明天在河边见。", "a2");

let chat = [greeting, firstUser, firstAssistant, secondUser, secondAssistant];
let snapshot = buildConversationEvidenceSnapshot(chat, {
  chatId: "chat:history",
  hostChatId: "history.jsonl",
});
assert.equal(snapshot.turns.length, 2);
assert.deepEqual(snapshot.turns.map((turn) => turn.assistantFloor), [2, 4]);

let ledger = createEmptyMemoryLedger({ chatId: "chat:history", now: 1 });
let result = reconcileMemoryLedgerHistory(ledger, {
  turns: snapshot.turns,
  historyFingerprint: snapshot.historyFingerprint,
  mutationId: "initial-load",
  now: 10,
});
ledger = result.ledger;
let view = materializeMemoryLedger(ledger);
assert.equal(view.evidence.activeEvidence.length, 2);
assert.equal(view.inbox.pending.length, 2);
const originalByText = new Map(
  view.evidence.activeEvidence.map((record) => [record.content.assistant, record]),
);

// Deleting an earlier pair shifts mutable ST indexes. The unchanged second
// turn must retain its evidence identity instead of being re-extracted.
chat = [greeting, secondUser, secondAssistant];
snapshot = buildConversationEvidenceSnapshot(chat, {
  chatId: "chat:history",
  hostChatId: "history.jsonl",
});
result = reconcileMemoryLedgerHistory(ledger, {
  turns: snapshot.turns,
  historyFingerprint: snapshot.historyFingerprint,
  mutationId: "delete-first-pair",
  reason: "message-deleted",
  now: 20,
});
ledger = result.ledger;
view = materializeMemoryLedger(ledger);
assert.deepEqual(
  view.evidence.activeEvidence.map((record) => record.content.assistant),
  ["明天在河边见。"],
);
assert.equal(
  view.evidence.activeEvidence[0].id,
  originalByText.get("明天在河边见。").id,
);
assert.equal(result.admittedEvidenceIds.length, 0);
const memoryV1 = createMemoryRevision({
  chatId: ledger.chatId,
  memoryId: "memory:meeting-place",
  memoryType: "event",
  fields: { place: "河边" },
  evidenceIds: [view.evidence.activeEvidence[0].id],
  createdAt: 25,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "meeting-place-v1",
  records: [memoryV1],
  sourceEvidenceIds: memoryV1.evidenceIds,
  now: 25,
}).ledger;

// A reroll creates a new evidence version for the same logical assistant slot.
chat = [greeting, secondUser, assistant("改成明天在钟楼见。", "a2-reroll", 1)];
snapshot = buildConversationEvidenceSnapshot(chat, {
  chatId: "chat:history",
  hostChatId: "history.jsonl",
});
result = reconcileMemoryLedgerHistory(ledger, {
  turns: snapshot.turns,
  historyFingerprint: snapshot.historyFingerprint,
  mutationId: "reroll-second",
  reason: "assistant-reroll",
  now: 30,
});
ledger = result.ledger;
view = materializeMemoryLedger(ledger);
assert.equal(view.evidence.activeEvidence.length, 1);
assert.equal(view.evidence.activeEvidence[0].content.assistant, "改成明天在钟楼见。");
assert.equal(view.evidence.activeEvidence[0].turnId, originalByText.get("明天在河边见。").turnId);
const rerolledEvidenceId = view.evidence.activeEvidence[0].id;
assert.equal(view.memories.byMemoryId.has("memory:meeting-place"), false);
const memoryV2 = createMemoryRevision({
  chatId: ledger.chatId,
  memoryId: "memory:meeting-place",
  parentRevisionId: memoryV1.id,
  memoryType: "event",
  fields: { place: "钟楼" },
  evidenceIds: [rerolledEvidenceId],
  createdAt: 35,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "meeting-place-v2",
  records: [memoryV2],
  sourceEvidenceIds: memoryV2.evidenceIds,
  now: 35,
}).ledger;

// Selecting the old swipe again reactivates its immutable evidence. It does
// not duplicate extraction work or permanently lose the former result.
chat = [greeting, secondUser, assistant("明天在河边见。", "a2", 0)];
snapshot = buildConversationEvidenceSnapshot(chat, {
  chatId: "chat:history",
  hostChatId: "history.jsonl",
});
result = reconcileMemoryLedgerHistory(ledger, {
  turns: snapshot.turns,
  historyFingerprint: snapshot.historyFingerprint,
  mutationId: "select-old-swipe",
  reason: "assistant-swipe-selected",
  now: 40,
});
ledger = result.ledger;
view = materializeMemoryLedger(ledger);
assert.equal(view.evidence.activeEvidence[0].id, originalByText.get("明天在河边见。").id);
assert.equal(view.evidence.activeEvidenceIds.has(rerolledEvidenceId), false);
assert.deepEqual(result.activatedEvidenceIds, [originalByText.get("明天在河边见。").id]);
assert.equal(result.admittedEvidenceIds.length, 0);
assert.equal(
  view.memories.byMemoryId.get("memory:meeting-place").fields.place,
  "河边",
);

const noOp = reconcileMemoryLedgerHistory(ledger, {
  turns: snapshot.turns,
  historyFingerprint: snapshot.historyFingerprint,
  mutationId: "same-history",
  now: 50,
});
assert.equal(noOp.changed, false);
assert.equal(noOp.ledger, ledger);

let crossChatWriteAttempted = false;
const service = new HistoryTransactionService({
  ledgerRepository: {
    transact: async () => {
      crossChatWriteAttempted = true;
    },
  },
});
await assert.rejects(
  service.reconcile(
    { chatId: "chat:a" },
    { chatId: "chat:b", turns: [], historyFingerprint: "other" },
  ),
  /belongs to another chat/,
);
assert.equal(crossChatWriteAttempted, false);

// Foreground Recall/ENA must be able to address the user turn before its
// assistant reply exists. The eventual evidence uses the exact same turn id.
const pendingChatId = "chat:pending-turn";
const pendingUser = user("Remember the lantern.", "pending-u1");
const beforeReply = buildConversationEvidenceSnapshot([greeting, pendingUser], {
  chatId: pendingChatId,
  hostChatId: "pending.jsonl",
});
let pendingLedger = createEmptyMemoryLedger({ chatId: pendingChatId, now: 60 });
const pendingTurn = resolveHistoryTurn(pendingLedger, beforeReply.turns, {
  userFloor: 1,
  userMessage: pendingUser.mes,
  now: 60,
});
assert.equal(pendingTurn.pending, true);
const afterReply = buildConversationEvidenceSnapshot(
  [greeting, pendingUser, assistant("The lantern is lit.", "pending-a1")],
  { chatId: pendingChatId, hostChatId: "pending.jsonl" },
);
const completedTurn = resolveHistoryTurn(pendingLedger, afterReply.turns, {
  userFloor: 1,
  userMessage: pendingUser.mes,
  now: 61,
});
assert.equal(completedTurn.pending, false);
assert.equal(completedTurn.turnId, pendingTurn.turnId);

console.log("memory history reconciliation tests passed");
