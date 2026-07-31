import assert from "node:assert/strict";
import {
  MEMORY_INBOX_STATUS,
  createEmptyMemoryLedger,
} from "../domain/memory-contract.js";
import {
  admitTurnEvidence,
  listRunnableInboxItems,
  transitionInboxItem,
} from "../domain/memory-inbox.js";
import { materializeInboxState } from "../domain/memory-materializer.js";

let ledger = createEmptyMemoryLedger({ chatId: "chat:inbox", now: 1 });
let admission = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-1",
    userText: "继续",
    assistantText: "剧情继续发展。",
  },
  now: 10,
});
ledger = admission.ledger;
assert.equal(admission.admitted, true);
assert.equal(ledger.revision, 1);
assert.equal(materializeInboxState(ledger).pending.length, 1);

const duplicate = admitTurnEvidence(ledger, {
  evidence: {
    turnId: "turn-1",
    userText: "继续",
    assistantText: "剧情继续发展。",
  },
  now: 20,
});
assert.equal(duplicate.admitted, false);
assert.equal(duplicate.ledger, ledger);

let transition = transitionInboxItem(ledger, {
  inboxId: admission.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.CLAIMED,
  expectedStatus: MEMORY_INBOX_STATUS.PENDING,
  claimId: "claim-1",
  claimOwner: "memory-steward",
  now: 30,
});
ledger = transition.ledger;
assert.equal(transition.inboxItem.attempt, 1);
assert.equal(materializeInboxState(ledger).claimed.length, 1);

transition = transitionInboxItem(ledger, {
  inboxId: admission.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.DEFERRED,
  expectedStatus: MEMORY_INBOX_STATUS.CLAIMED,
  availableAt: 100,
  note: "等待模型恢复",
  now: 40,
});
ledger = transition.ledger;
assert.equal(listRunnableInboxItems(ledger, { now: 99 }).length, 0);
assert.equal(listRunnableInboxItems(ledger, { now: 100 }).length, 1);

transition = transitionInboxItem(ledger, {
  inboxId: admission.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.CLAIMED,
  expectedStatus: MEMORY_INBOX_STATUS.DEFERRED,
  claimId: "claim-2",
  claimOwner: "memory-steward",
  now: 100,
});
ledger = transition.ledger;
assert.equal(transition.inboxItem.attempt, 2);

transition = transitionInboxItem(ledger, {
  inboxId: admission.inboxItem.inboxId,
  status: MEMORY_INBOX_STATUS.COMPLETED,
  expectedStatus: MEMORY_INBOX_STATUS.CLAIMED,
  now: 110,
});
ledger = transition.ledger;
assert.equal(materializeInboxState(ledger).pending.length, 0);
assert.throws(() =>
  transitionInboxItem(ledger, {
    inboxId: admission.inboxItem.inboxId,
    status: MEMORY_INBOX_STATUS.PENDING,
  }),
);

console.log("memory inbox tests passed");
