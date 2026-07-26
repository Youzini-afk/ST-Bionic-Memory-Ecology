// ST-BME persistence reducer core.
//
// Pure helpers only: no IO, no graph mutation, no UI side effects.
// Phase 2 centralized accepted/queued/pending invariants; Phase 5 routes
// call sites through explicit events while leaving durable routing
// (IndexedDB/OPFS/Authority/Luker) in the existing orchestration layer.

import {
  isAcceptedLegacyPersistenceTier,
  isRecoveryOnlyLegacyPersistenceTier,
  planAcceptedPendingPersistenceRepair,
} from "./legacy-persistence-repair.js";

const SAVED_BATCH_ACCEPTED_TIERS = new Set([
  "indexeddb",
  "opfs",
  "authority-sql",
  "luker-chat-state",
]);

export const PERSISTENCE_EVENT_TYPES = Object.freeze({
  ACCEPTED: "accepted",
  QUEUED: "queued",
});

function normalizeRevision(value = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function normalizeTier(value = "none") {
  return String(value || "none").trim().toLowerCase() || "none";
}

export function buildBatchPersistenceRecordFromPersistResult(persistResult = null) {
  const accepted = persistResult?.accepted === true;
  const queued = persistResult?.queued === true;
  const blocked = persistResult?.blocked === true;
  const recoverable = persistResult?.recoverable === true;
  const storageTier = normalizeTier(persistResult?.storageTier);
  let outcome = "failed";

  if (accepted && SAVED_BATCH_ACCEPTED_TIERS.has(storageTier)) {
    outcome = "saved";
  } else if (accepted) {
    outcome = "fallback";
  } else if (queued) {
    outcome = "queued";
  } else if (recoverable) {
    outcome = "recoverable";
  } else if (blocked) {
    outcome = "blocked";
  }

  return {
    outcome,
    accepted,
    recoverable,
    storageTier,
    reason: String(persistResult?.reason || ""),
    revision: normalizeRevision(persistResult?.revision),
    saveMode: String(persistResult?.saveMode || ""),
    saved: persistResult?.saved === true,
    queued,
    blocked,
  };
}

export function applyPersistenceRecordToBatchStatus(batchStatus = null, persistenceRecord = null) {
  if (!batchStatus || typeof batchStatus !== "object" || !persistenceRecord) {
    return batchStatus;
  }
  const accepted = persistenceRecord.accepted === true;
  return {
    ...batchStatus,
    persistence: persistenceRecord,
    historyAdvanceAllowed: accepted,
    historyAdvanced: accepted,
  };
}

export function buildAcceptedPersistenceStatePatch({
  currentState = null,
  persistenceRecord = null,
  acceptedRevision = persistenceRecord?.revision,
  acceptedStorageTier = persistenceRecord?.storageTier,
  acceptedBy = acceptedStorageTier,
  clearQueued = true,
} = {}) {
  const revision = Math.max(
    normalizeRevision(currentState?.lastAcceptedRevision),
    normalizeRevision(acceptedRevision),
  );
  const tier = normalizeTier(acceptedStorageTier);
  const acceptedTier = isAcceptedLegacyPersistenceTier(tier) ? tier : "none";
  if (persistenceRecord?.accepted !== true || acceptedTier === "none") {
    return {};
  }
  const patch = {
    acceptedStorageTier: acceptedTier,
    acceptedBy: acceptedTier,
    lastAcceptedRevision: revision,
    lastRecoverableStorageTier: "none",
    pendingPersist: false,
    writesBlocked: false,
  };
  if (clearQueued) {
    patch.queuedPersistRevision = 0;
    patch.queuedPersistChatId = "";
    patch.queuedPersistMode = "";
    patch.queuedPersistRotateIntegrity = false;
    patch.queuedPersistReason = "";
  }
  return patch;
}

export function buildQueuedPersistenceStatePatch({
  currentState = null,
  reason = "",
  revision = 0,
  chatId = "",
  immediate = false,
  recoverableTier = "none",
} = {}) {
  const normalizedRevision = Math.max(
    normalizeRevision(currentState?.queuedPersistRevision),
    normalizeRevision(revision),
  );
  const tier = normalizeTier(recoverableTier);
  const recoverable = isRecoveryOnlyLegacyPersistenceTier(tier);
  return {
    queuedPersistRevision: normalizedRevision,
    queuedPersistChatId: String(chatId || ""),
    queuedPersistMode: immediate ? "immediate" : "debounced",
    queuedPersistRotateIntegrity: false,
    queuedPersistReason: String(reason || ""),
    pendingPersist: true,
    writesBlocked: !recoverable,
    lastPersistReason: String(reason || ""),
    lastPersistMode: immediate ? "pending-immediate" : "pending-debounced",
    lastRecoverableStorageTier: recoverable
      ? tier
      : currentState?.lastRecoverableStorageTier,
  };
}

export function planAcceptedPendingClear(options = {}) {
  return planAcceptedPendingPersistenceRepair(options);
}

export function reducePersistenceStatePatch(currentState = null, event = null) {
  const type = String(event?.type || "").trim();
  switch (type) {
    case PERSISTENCE_EVENT_TYPES.ACCEPTED:
      return buildAcceptedPersistenceStatePatch({
        currentState,
        persistenceRecord: event.persistenceRecord,
        acceptedRevision: event.acceptedRevision,
        acceptedStorageTier: event.acceptedStorageTier,
        acceptedBy: event.acceptedBy,
        clearQueued: event.clearQueued !== false,
      });

    case PERSISTENCE_EVENT_TYPES.QUEUED:
      return buildQueuedPersistenceStatePatch({
        currentState,
        reason: event.reason,
        revision: event.revision,
        chatId: event.chatId,
        immediate: event.immediate === true,
        recoverableTier: event.recoverableTier,
      });

    default:
      return {};
  }
}

export function reducePersistenceState(currentState = null, event = null) {
  return {
    ...(currentState && typeof currentState === "object" ? currentState : {}),
    ...reducePersistenceStatePatch(currentState, event),
  };
}
