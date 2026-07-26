// ST-BME restrained rebirth — Phase 2 persistence reducer tests.

import assert from "node:assert/strict";
import {
  PERSISTENCE_EVENT_TYPES,
  applyPersistenceRecordToBatchStatus,
  buildAcceptedPersistenceStatePatch,
  buildBatchPersistenceRecordFromPersistResult,
  buildQueuedPersistenceStatePatch,
  planAcceptedPendingClear,
  reducePersistenceState,
  reducePersistenceStatePatch,
} from "../sync/persistence-reducer.js";

const acceptedRecord = buildBatchPersistenceRecordFromPersistResult({
  accepted: true,
  saved: true,
  storageTier: "authority-sql",
  reason: "extraction-batch-complete",
  revision: 12,
  saveMode: "authority-sql",
});
assert.deepEqual(acceptedRecord, {
  outcome: "saved",
  accepted: true,
  recoverable: false,
  storageTier: "authority-sql",
  reason: "extraction-batch-complete",
  revision: 12,
  saveMode: "authority-sql",
  saved: true,
  queued: false,
  blocked: false,
});

const recoverableRecord = buildBatchPersistenceRecordFromPersistResult({
  accepted: false,
  recoverable: true,
  storageTier: "metadata-full",
  revision: 4,
});
assert.equal(recoverableRecord.outcome, "recoverable");
assert.equal(recoverableRecord.accepted, false);

const chatStateRecord = buildBatchPersistenceRecordFromPersistResult({
  accepted: true,
  saved: true,
  storageTier: "chat-state",
  revision: 5,
});
assert.equal(
  chatStateRecord.outcome,
  "fallback",
  "Phase 2 preserves old batch-status wording for chat-state fallback acceptance",
);

console.log("  ✓ persist results reduce to stable batch persistence records");

const acceptedPatch = buildAcceptedPersistenceStatePatch({
  currentState: {
    lastAcceptedRevision: 9,
    queuedPersistRevision: 12,
    queuedPersistChatId: "chat-a",
    pendingPersist: true,
    writesBlocked: true,
    lastRecoverableStorageTier: "metadata-full",
  },
  persistenceRecord: acceptedRecord,
});
assert.equal(acceptedPatch.pendingPersist, false);
assert.equal(acceptedPatch.writesBlocked, false);
assert.equal(acceptedPatch.lastAcceptedRevision, 12);
assert.equal(acceptedPatch.acceptedStorageTier, "authority-sql");
assert.equal(acceptedPatch.lastRecoverableStorageTier, "none");
assert.equal(acceptedPatch.queuedPersistRevision, 0);
assert.equal(acceptedPatch.queuedPersistChatId, "");

const unsafeAcceptedPatch = buildAcceptedPersistenceStatePatch({
  currentState: { pendingPersist: true, lastAcceptedRevision: 4 },
  persistenceRecord: {
    accepted: true,
    storageTier: "metadata-full",
    revision: 9,
  },
});
assert.deepEqual(
  unsafeAcceptedPatch,
  {},
  "recovery-only accepted records must not clear pending state through the reducer",
);

console.log("  ✓ canonical accepted state clears pending and queued fields");

assert.deepEqual(
  reducePersistenceStatePatch(
    {
      lastAcceptedRevision: 9,
      pendingPersist: true,
      writesBlocked: true,
    },
    {
      type: PERSISTENCE_EVENT_TYPES.ACCEPTED,
      persistenceRecord: acceptedRecord,
    },
  ),
  buildAcceptedPersistenceStatePatch({
    currentState: {
      lastAcceptedRevision: 9,
      pendingPersist: true,
      writesBlocked: true,
    },
    persistenceRecord: acceptedRecord,
  }),
);

const reducedAcceptedState = reducePersistenceState(
  { pendingPersist: true, writesBlocked: true, lastAcceptedRevision: 9, custom: "keep" },
  { type: PERSISTENCE_EVENT_TYPES.ACCEPTED, persistenceRecord: acceptedRecord },
);
assert.equal(reducedAcceptedState.pendingPersist, false);
assert.equal(reducedAcceptedState.custom, "keep");
assert.equal(reducedAcceptedState.acceptedStorageTier, "authority-sql");

console.log("  ✓ accepted persistence state updates are event-reduced patches");

const queuedPatch = buildQueuedPersistenceStatePatch({
  currentState: {
    queuedPersistRevision: 6,
    lastRecoverableStorageTier: "metadata-full",
  },
  reason: "extraction-batch-complete:pending",
  revision: 10,
  chatId: "chat-a",
  immediate: true,
  recoverableTier: "shadow",
});
assert.equal(queuedPatch.pendingPersist, true);
assert.equal(queuedPatch.writesBlocked, false);
assert.equal(queuedPatch.queuedPersistRevision, 10);
assert.equal(queuedPatch.queuedPersistChatId, "chat-a");
assert.equal(queuedPatch.queuedPersistMode, "immediate");
assert.equal(queuedPatch.lastRecoverableStorageTier, "shadow");

const blockedQueuedPatch = buildQueuedPersistenceStatePatch({
  currentState: { queuedPersistRevision: 11, lastRecoverableStorageTier: "shadow" },
  reason: "authority-down",
  revision: 9,
  chatId: "chat-a",
  recoverableTier: "none",
});
assert.equal(blockedQueuedPatch.queuedPersistRevision, 11);
assert.equal(blockedQueuedPatch.writesBlocked, true);
assert.equal(blockedQueuedPatch.lastRecoverableStorageTier, "shadow");

console.log("  ✓ queued state preserves max revision and recovery-only semantics");

assert.deepEqual(
  reducePersistenceStatePatch(
    { queuedPersistRevision: 6, lastRecoverableStorageTier: "metadata-full" },
    {
      type: PERSISTENCE_EVENT_TYPES.QUEUED,
      reason: "extraction-batch-complete:pending",
      revision: 10,
      chatId: "chat-a",
      immediate: true,
      recoverableTier: "shadow",
    },
  ),
  queuedPatch,
);

assert.deepEqual(reducePersistenceStatePatch({}, { type: "unknown" }), {});

const batchStatus = {
  completed: true,
  historyAdvanceAllowed: false,
  historyAdvanced: false,
  persistence: { outcome: "queued" },
};
const nextBatchStatus = applyPersistenceRecordToBatchStatus(batchStatus, acceptedRecord);
assert.notEqual(nextBatchStatus, batchStatus);
assert.equal(nextBatchStatus.persistence.outcome, "saved");
assert.equal(nextBatchStatus.historyAdvanceAllowed, true);
assert.equal(nextBatchStatus.historyAdvanced, true);

const clearPlan = planAcceptedPendingClear({
  batchPersistence: { revision: 10, storageTier: "metadata-full" },
  persistenceState: {
    pendingPersist: true,
    queuedPersistRevision: 12,
    queuedPersistChatId: "chat-a",
    lastAcceptedRevision: 12,
    acceptedStorageTier: "authority-sql",
  },
  activeChatId: "chat-a",
  queuedChatId: "chat-a",
});
assert.equal(clearPlan.action, "clear-stale-pending");

const unsafePlan = planAcceptedPendingClear({
  batchPersistence: { revision: 10, storageTier: "metadata-full" },
  persistenceState: {
    pendingPersist: true,
    queuedPersistRevision: 12,
    queuedPersistChatId: "chat-a",
    lastAcceptedRevision: 12,
    acceptedStorageTier: "metadata-full",
  },
  activeChatId: "chat-a",
  queuedChatId: "chat-a",
});
assert.equal(unsafePlan.action, "keep");
assert.equal(unsafePlan.reason, "accepted-tier-not-canonical");

console.log("  ✓ accepted pending clear plan keeps canonical-tier invariant");
console.log("persistence-reducer tests passed");
