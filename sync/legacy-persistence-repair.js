// ST-BME: legacy persistence repair policy
// Pure helpers only: no IO, no runtime mutation.

const ACCEPTED_GRAPH_TIERS = new Set([
  "authority-sql",
  "opfs",
  "indexeddb",
  "chat-state",
  "luker-chat-state",
]);

const RECOVERY_ONLY_GRAPH_TIERS = new Set([
  "shadow",
  "metadata-full",
  "authority-blob",
  "authority-blob-checkpoint",
  "runtime-recovery",
]);

const REPLICA_ONLY_GRAPH_TIERS = new Set([
  "trivium",
  "authority-trivium",
  "vector",
]);

export function normalizeLegacyPersistenceTier(storageTier = "none") {
  return String(storageTier || "none").trim().toLowerCase() || "none";
}

export function classifyLegacyPersistenceTier(storageTier = "none") {
  const tier = normalizeLegacyPersistenceTier(storageTier);
  if (ACCEPTED_GRAPH_TIERS.has(tier)) {
    return { tier, role: "accepted", accepted: true, recoverable: true };
  }
  if (RECOVERY_ONLY_GRAPH_TIERS.has(tier)) {
    return { tier, role: "recovery-only", accepted: false, recoverable: true };
  }
  if (REPLICA_ONLY_GRAPH_TIERS.has(tier)) {
    return { tier, role: "replica-only", accepted: false, recoverable: false };
  }
  return { tier, role: "unknown", accepted: false, recoverable: false };
}

export function isAcceptedLegacyPersistenceTier(storageTier = "none") {
  return classifyLegacyPersistenceTier(storageTier).accepted === true;
}

export function isRecoveryOnlyLegacyPersistenceTier(storageTier = "none") {
  const classified = classifyLegacyPersistenceTier(storageTier);
  return classified.role === "recovery-only";
}

function firstMeaningfulTier(...values) {
  for (const value of values) {
    const tier = normalizeLegacyPersistenceTier(value);
    if (tier && tier !== "none") return tier;
  }
  return "none";
}

export function getPendingPersistenceTargetRevision({
  batchPersistence = null,
  persistenceState = null,
} = {}) {
  const persistenceRevision = Number(batchPersistence?.revision || 0);
  const queuedRevision = Number(persistenceState?.queuedPersistRevision || 0);
  const targetRevision = Math.max(
    Number.isFinite(persistenceRevision) ? persistenceRevision : 0,
    Number.isFinite(queuedRevision) ? queuedRevision : 0,
  );
  return Number.isFinite(targetRevision) && targetRevision > 0 ? targetRevision : 0;
}

export function getAcceptedCommitMarkerRevision(marker = null) {
  if (!marker || typeof marker !== "object") return 0;
  if (marker.accepted !== true) return 0;
  const revision = Number(marker.revision || marker.acceptedRevision || 0);
  return Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0;
}

export function planAcceptedPendingPersistenceRepair({
  batchPersistence = null,
  persistenceState = null,
  commitMarker = null,
  activeChatId = "",
  queuedChatId = "",
  markerChatMatchesQueued = false,
} = {}) {
  const targetRevision = getPendingPersistenceTargetRevision({
    batchPersistence,
    persistenceState,
  });
  if (persistenceState?.pendingPersist !== true) {
    return { action: "keep", reason: "not-pending", targetRevision };
  }
  if (targetRevision <= 0) {
    return { action: "keep", reason: "missing-target-revision", targetRevision };
  }
  const normalizedActiveChatId = String(activeChatId || "").trim();
  const normalizedQueuedChatId = String(queuedChatId || "").trim();
  if (!normalizedActiveChatId || !normalizedQueuedChatId) {
    return { action: "keep", reason: "missing-chat-id", targetRevision };
  }
  if (normalizedActiveChatId !== normalizedQueuedChatId) {
    return { action: "keep", reason: "queued-chat-mismatch", targetRevision };
  }

  const stateAcceptedRevision = Number(persistenceState?.lastAcceptedRevision || 0);
  const markerAcceptedRevision = markerChatMatchesQueued
    ? getAcceptedCommitMarkerRevision(commitMarker)
    : 0;
  const acceptedRevision = Math.max(
    Number.isFinite(stateAcceptedRevision) ? stateAcceptedRevision : 0,
    Number.isFinite(markerAcceptedRevision) ? markerAcceptedRevision : 0,
  );
  if (acceptedRevision < targetRevision) {
    return {
      action: "keep",
      reason: "accepted-revision-behind",
      targetRevision,
      acceptedRevision,
    };
  }

  const tier = firstMeaningfulTier(
    persistenceState?.acceptedStorageTier,
    commitMarker?.storageTier,
    batchPersistence?.storageTier,
  );
  if (!isAcceptedLegacyPersistenceTier(tier)) {
    return {
      action: "keep",
      reason: "accepted-tier-not-canonical",
      targetRevision,
      acceptedRevision,
      tier,
    };
  }

  return {
    action: "clear-stale-pending",
    reason: "accepted-revision-covers-pending",
    targetRevision,
    acceptedRevision,
    tier,
  };
}

export function repairLegacyLastBatchPersistenceStatus({
  batchStatus = null,
  persistenceState = null,
  commitMarker = null,
  activeChatId = "",
  commitMarkerChatMatchesActive = false,
} = {}) {
  const persistence = batchStatus?.persistence;
  if (!batchStatus || !persistence || typeof persistence !== "object") {
    return { repaired: false, batchStatus };
  }
  const targetRevision = getPendingPersistenceTargetRevision({
    batchPersistence: persistence,
    persistenceState,
  });
  const normalizedActiveChatId = String(activeChatId || "").trim();
  const stateChatId = String(persistenceState?.chatId || "").trim();
  const stateMatchesActive =
    !normalizedActiveChatId || !stateChatId || normalizedActiveChatId === stateChatId;
  const acceptedRevision = Math.max(
    stateMatchesActive ? Number(persistenceState?.lastAcceptedRevision || 0) : 0,
    commitMarkerChatMatchesActive ? getAcceptedCommitMarkerRevision(commitMarker) : 0,
  );
  const tier = firstMeaningfulTier(
    stateMatchesActive ? persistenceState?.acceptedStorageTier : "",
    commitMarkerChatMatchesActive ? commitMarker?.storageTier : "",
    persistence.storageTier,
  );
  if (
    targetRevision <= 0 ||
    acceptedRevision < targetRevision ||
    !isAcceptedLegacyPersistenceTier(tier)
  ) {
    return { repaired: false, batchStatus };
  }
  return {
    repaired: true,
    batchStatus: {
      ...batchStatus,
      historyAdvanceAllowed: true,
      historyAdvanced: batchStatus.historyAdvanced === true,
      persistence: {
        ...persistence,
        outcome: "accepted",
        accepted: true,
        saved: true,
        queued: false,
        blocked: false,
        recoverable: false,
        attempted: true,
        storageTier: tier,
        reason: "legacy-accepted-revision-repair",
        revision: targetRevision,
      },
    },
    targetRevision,
    acceptedRevision,
    tier,
  };
}
