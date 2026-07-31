import assert from "node:assert/strict";
import { MEMORY_INBOX_STATUS, createEmptyMemoryLedger } from "../domain/memory-contract.js";
import {
  admitTurnEvidence,
  planInboxBatchTransition,
  transitionInboxItem,
} from "../domain/memory-inbox.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeInboxState } from "../domain/memory-materializer.js";

let ledger = createEmptyMemoryLedger({ chatId: "chat:inbox-batch", now: 1 });
const first = admitTurnEvidence(ledger, {
  evidence: { turnId: "turn-1", userText: "Continue", assistantText: "The gate opened." },
  now: 2,
});
ledger = first.ledger;
const second = admitTurnEvidence(ledger, {
  evidence: { turnId: "turn-2", userText: "Enter", assistantText: "Mira entered the archive." },
  now: 3,
});
ledger = second.ledger;

const claimPlan = planInboxBatchTransition(ledger, {
  inboxIds: [first.inboxItem.inboxId, second.inboxItem.inboxId],
  status: MEMORY_INBOX_STATUS.CLAIMED,
  expectedStatus: MEMORY_INBOX_STATUS.PENDING,
  claimId: "run:batch-1",
  claimOwner: "memory-steward",
  payloadPatch: { agentRunId: "run:batch-1" },
  idempotencyKey: "claim:batch-1",
  now: 4,
});
const claimed = appendMemoryLedgerTransaction(ledger, claimPlan.transaction);
ledger = claimed.ledger;
assert.equal(claimed.appendedRecords.length, 2);
assert.equal(materializeInboxState(ledger).claimed.length, 2);
assert.equal(materializeInboxState(ledger).claimed.every((item) => item.attempt === 1), true);
assert.equal(materializeInboxState(ledger).claimed.every((item) => item.payload.agentRunId === "run:batch-1"), true);

const replayed = appendMemoryLedgerTransaction(ledger, claimPlan.transaction);
assert.equal(replayed.replayed, true);
assert.equal(replayed.ledger, ledger);

const completionPlan = planInboxBatchTransition(ledger, {
  inboxIds: [first.inboxItem.inboxId, second.inboxItem.inboxId],
  status: MEMORY_INBOX_STATUS.COMPLETED,
  expectedStatus: MEMORY_INBOX_STATUS.CLAIMED,
  idempotencyKey: "complete:batch-1",
  now: 5,
});
ledger = appendMemoryLedgerTransaction(ledger, completionPlan.transaction).ledger;
assert.equal(materializeInboxState(ledger).pending.length, 0);

let conflictLedger = createEmptyMemoryLedger({ chatId: "chat:inbox-batch-conflict", now: 1 });
const conflictFirst = admitTurnEvidence(conflictLedger, {
  evidence: { turnId: "turn-a", userText: "A", assistantText: "A happened." },
  now: 2,
});
conflictLedger = conflictFirst.ledger;
const conflictSecond = admitTurnEvidence(conflictLedger, {
  evidence: { turnId: "turn-b", userText: "B", assistantText: "B happened." },
  now: 3,
});
conflictLedger = conflictSecond.ledger;
conflictLedger = transitionInboxItem(conflictLedger, {
  inboxId: conflictFirst.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.DEFERRED,
  expectedStatus: MEMORY_INBOX_STATUS.PENDING,
  availableAt: 10,
  now: 4,
}).ledger;
const beforeConflict = conflictLedger;
assert.throws(() =>
  planInboxBatchTransition(conflictLedger, {
    inboxIds: [conflictFirst.inboxItem.inboxId, conflictSecond.inboxItem.inboxId],
    status: MEMORY_INBOX_STATUS.CLAIMED,
    expectedStatus: MEMORY_INBOX_STATUS.PENDING,
    claimId: "run:conflict",
    claimOwner: "memory-steward",
  }),
);
assert.equal(conflictLedger, beforeConflict);
assert.equal(materializeInboxState(conflictLedger).claimed.length, 0);

const staleCandidate = materializeInboxState(conflictLedger).pending.find(
  (item) => item.inboxId === conflictSecond.inboxItem.inboxId,
);
conflictLedger = transitionInboxItem(conflictLedger, {
  inboxId: conflictSecond.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.DEFERRED,
  expectedStatus: MEMORY_INBOX_STATUS.PENDING,
  availableAt: 999,
  now: 5,
}).ledger;
assert.throws(() =>
  planInboxBatchTransition(conflictLedger, {
    inboxIds: [staleCandidate.inboxId],
    expectedRevisionIds: [staleCandidate.id],
    status: MEMORY_INBOX_STATUS.CLAIMED,
    claimId: "run:stale-candidate",
    claimOwner: "memory-steward",
    now: 6,
  }),
  /inbox revision changed/,
);
assert.throws(() =>
  planInboxBatchTransition(conflictLedger, {
    inboxIds: [conflictSecond.inboxItem.inboxId],
    status: MEMORY_INBOX_STATUS.CLAIMED,
    claimId: "run:early-retry",
    claimOwner: "memory-steward",
    now: 6,
  }),
  /not available/,
);

console.log("memory inbox batch tests passed");
