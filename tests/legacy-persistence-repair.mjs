// ST-BME: regression tests — centralized legacy persistence repair policy

import assert from "node:assert/strict";
import {
  classifyLegacyPersistenceTier,
  isAcceptedLegacyPersistenceTier,
  isRecoveryOnlyLegacyPersistenceTier,
  planAcceptedPendingPersistenceRepair,
  repairLegacyLastBatchPersistenceStatus,
} from "../sync/legacy-persistence-repair.js";

const acceptedTiers = [
  "authority-sql",
  "opfs",
  "indexeddb",
  "chat-state",
  "luker-chat-state",
];
for (const tier of acceptedTiers) {
  assert.equal(isAcceptedLegacyPersistenceTier(tier), true, `${tier} should be canonical`);
  assert.equal(classifyLegacyPersistenceTier(tier).role, "accepted");
}

for (const tier of ["metadata-full", "shadow", "authority-blob-checkpoint"]) {
  assert.equal(
    isRecoveryOnlyLegacyPersistenceTier(tier),
    true,
    `${tier} should be recovery-only`,
  );
  assert.equal(isAcceptedLegacyPersistenceTier(tier), false);
}

for (const tier of ["trivium", "authority-trivium", "vector"]) {
  const classified = classifyLegacyPersistenceTier(tier);
  assert.equal(classified.role, "replica-only");
  assert.equal(classified.accepted, false);
}

console.log("  ✓ legacy persistence tier roles are centralized");

const coveredPlan = planAcceptedPendingPersistenceRepair({
  batchPersistence: {
    revision: 5,
    storageTier: "metadata-full",
  },
  persistenceState: {
    pendingPersist: true,
    queuedPersistRevision: 7,
    queuedPersistChatId: "chat-old",
    lastAcceptedRevision: 7,
    acceptedStorageTier: "authority-sql",
  },
  commitMarker: {
    chatId: "chat-old",
    accepted: true,
    revision: 7,
    storageTier: "authority-sql",
  },
  activeChatId: "chat-old",
  queuedChatId: "chat-old",
  markerChatMatchesQueued: true,
});
assert.equal(coveredPlan.action, "clear-stale-pending");
assert.equal(coveredPlan.targetRevision, 7);
assert.equal(coveredPlan.tier, "authority-sql");

console.log("  ✓ accepted canonical revision can clear stale legacy pending state");

const behindPlan = planAcceptedPendingPersistenceRepair({
  batchPersistence: { revision: 8, storageTier: "indexeddb" },
  persistenceState: {
    pendingPersist: true,
    queuedPersistRevision: 9,
    queuedPersistChatId: "chat-old",
    lastAcceptedRevision: 8,
    acceptedStorageTier: "indexeddb",
  },
  activeChatId: "chat-old",
  queuedChatId: "chat-old",
});
assert.equal(behindPlan.action, "keep");
assert.equal(behindPlan.reason, "accepted-revision-behind");

const wrongTierPlan = planAcceptedPendingPersistenceRepair({
  batchPersistence: { revision: 8, storageTier: "metadata-full" },
  persistenceState: {
    pendingPersist: true,
    queuedPersistRevision: 8,
    queuedPersistChatId: "chat-old",
    lastAcceptedRevision: 8,
    acceptedStorageTier: "metadata-full",
  },
  activeChatId: "chat-old",
  queuedChatId: "chat-old",
});
assert.equal(wrongTierPlan.action, "keep");
assert.equal(wrongTierPlan.reason, "accepted-tier-not-canonical");

const wrongChatPlan = planAcceptedPendingPersistenceRepair({
  batchPersistence: { revision: 8, storageTier: "indexeddb" },
  persistenceState: {
    pendingPersist: true,
    queuedPersistRevision: 8,
    queuedPersistChatId: "chat-a",
    lastAcceptedRevision: 8,
    acceptedStorageTier: "indexeddb",
  },
  activeChatId: "chat-b",
  queuedChatId: "chat-a",
});
assert.equal(wrongChatPlan.action, "keep");
assert.equal(wrongChatPlan.reason, "queued-chat-mismatch");

console.log("  ✓ stale pending repair keeps unsafe legacy states blocked");

const legacyBatchStatus = {
  processedRange: [0, 2],
  historyAdvanced: false,
  historyAdvanceAllowed: false,
  persistence: {
    outcome: "pending",
    accepted: false,
    saved: false,
    queued: true,
    blocked: true,
    storageTier: "metadata-full",
    revision: 4,
    reason: "old-version-pending",
  },
};
const repairedBatch = repairLegacyLastBatchPersistenceStatus({
  batchStatus: legacyBatchStatus,
  persistenceState: {
    chatId: "chat-old",
    lastAcceptedRevision: 4,
    acceptedStorageTier: "opfs",
  },
  activeChatId: "chat-old",
});
assert.equal(repairedBatch.repaired, true);
assert.equal(repairedBatch.batchStatus.historyAdvanceAllowed, true);
assert.equal(repairedBatch.batchStatus.persistence.accepted, true);
assert.equal(repairedBatch.batchStatus.persistence.saved, true);
assert.equal(repairedBatch.batchStatus.persistence.queued, false);
assert.equal(repairedBatch.batchStatus.persistence.blocked, false);
assert.equal(repairedBatch.batchStatus.persistence.storageTier, "opfs");

const unrepairedBatch = repairLegacyLastBatchPersistenceStatus({
  batchStatus: legacyBatchStatus,
  persistenceState: {
    chatId: "chat-old",
    lastAcceptedRevision: 4,
    acceptedStorageTier: "metadata-full",
  },
  activeChatId: "chat-old",
});
assert.equal(unrepairedBatch.repaired, false);

const wrongChatAcceptedBatch = repairLegacyLastBatchPersistenceStatus({
  batchStatus: legacyBatchStatus,
  persistenceState: {
    chatId: "other-chat",
    lastAcceptedRevision: 4,
    acceptedStorageTier: "opfs",
  },
  activeChatId: "chat-old",
});
assert.equal(wrongChatAcceptedBatch.repaired, false);

const markerRepairBatch = repairLegacyLastBatchPersistenceStatus({
  batchStatus: legacyBatchStatus,
  persistenceState: {
    chatId: "chat-old",
    lastAcceptedRevision: 0,
    acceptedStorageTier: "none",
  },
  commitMarker: {
    accepted: true,
    revision: 4,
    storageTier: "authority-sql",
    chatId: "chat-old",
  },
  activeChatId: "chat-old",
  commitMarkerChatMatchesActive: true,
});
assert.equal(markerRepairBatch.repaired, true);
assert.equal(markerRepairBatch.batchStatus.persistence.storageTier, "authority-sql");

console.log("  ✓ legacy lastBatchStatus is repaired only after canonical acceptance");

console.log("legacy-persistence-repair tests passed");
