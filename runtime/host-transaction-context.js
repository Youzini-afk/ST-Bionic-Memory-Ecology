// ST-BME: optional SillyTavern Host Bridge transaction identity.
//
// BME keeps its existing per-chat persistence id as the data owner.  The
// bridge identity is a separate control plane used to fence asynchronous
// work and to bind processed floors to durable message/swipe identities.

export const BME_HOST_LINEAGE_VERSION = 1;

function normalizeIdentifier(value = "") {
  return String(value ?? "").trim();
}

function normalizeRevision(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : Math.max(0, Math.floor(Number(fallback) || 0));
}

function clonePlain(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }
}

export function normalizeHostTransactionContext(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Number(value.schemaVersion) !== 1) return null;
  const phase = String(value.phase || "").trim();
  if (!new Set(["snapshot", "event", "committed"]).has(phase)) return null;
  const conversationId = normalizeIdentifier(value.conversationId);
  const branchId = normalizeIdentifier(value.branchId);
  if (!conversationId || !branchId) return null;
  const hostRevision = normalizeRevision(value.hostRevision);
  const baseHostRevision = normalizeRevision(value.baseHostRevision, hostRevision);
  if (baseHostRevision > hostRevision) return null;

  const normalized = {
    schemaVersion: 1,
    phase,
    conversationId,
    branchId,
    hostRevision,
    baseHostRevision,
    capturedAt:
      typeof value.capturedAt === "string" && Number.isFinite(Date.parse(value.capturedAt))
        ? value.capturedAt
        : new Date().toISOString(),
  };
  for (const key of [
    "commitEventId",
    "commitTransactionId",
    "commitCommittedAt",
    "commitOperation",
    "sourceEventId",
    "rootEventId",
    "correlationId",
    "operation",
  ]) {
    const normalizedValue = normalizeIdentifier(value[key]);
    if (normalizedValue) normalized[key] = normalizedValue;
  }
  if (value.causationId === null) {
    normalized.causationId = null;
  } else {
    const causationId = normalizeIdentifier(value.causationId);
    if (causationId) normalized.causationId = causationId;
  }
  for (const key of ["sourceEventIds", "originExtensionIds"]) {
    const values = Array.isArray(value[key])
      ? [...new Set(value[key].map(normalizeIdentifier).filter(Boolean))]
      : [];
    if (values.length > 0) normalized[key] = values;
  }
  for (const key of ["messageUid", "swipeUid"]) {
    if (value[key] === null) {
      normalized[key] = null;
    } else {
      const normalizedValue = normalizeIdentifier(value[key]);
      if (normalizedValue) normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function buildContextFromMetadata(context = null) {
  const state = context?.chatMetadata?.authority ?? context?.chat_metadata?.authority;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const conversationId = normalizeIdentifier(state.conversationId);
  const branchId = normalizeIdentifier(state.branchId);
  if (!conversationId || !branchId) return null;
  const hostRevision = normalizeRevision(state.revision);
  return normalizeHostTransactionContext({
    schemaVersion: 1,
    phase: "snapshot",
    conversationId,
    branchId,
    hostRevision,
    baseHostRevision:
      state.lastEventId && hostRevision > 0 ? hostRevision - 1 : hostRevision,
    commitEventId: state.lastEventId,
    commitTransactionId: state.lastTransactionId,
    commitCommittedAt: state.committedAt,
    commitOperation: state.lastCommit?.operation,
    sourceEventIds: state.lastCommit?.sourceEventIds,
    originExtensionIds: state.lastCommit?.originExtensionIds,
    capturedAt: new Date().toISOString(),
  });
}

export function captureHostTransactionContext({
  context = null,
  bridge = null,
} = {}) {
  if (typeof bridge?.captureTransactionContext === "function") {
    try {
      const captured = normalizeHostTransactionContext(
        bridge.captureTransactionContext(),
      );
      if (captured) return captured;
    } catch (error) {
      console.debug?.("[ST-BME] Host Bridge context capture skipped:", error);
    }
  }
  return buildContextFromMetadata(context);
}

export function getMessageUid(message = null) {
  return normalizeIdentifier(message?.authority?.messageUid);
}

export function getActiveSwipeUid(message = null) {
  if (!Array.isArray(message?.swipe_info)) return "";
  const swipeIndex = normalizeRevision(message?.swipe_id);
  return normalizeIdentifier(message.swipe_info[swipeIndex]?.authority?.swipeUid);
}

export function buildProcessedMessageRecord(message = null, messageHash = "") {
  return {
    messageHash: normalizeIdentifier(messageHash),
    messageUid: getMessageUid(message),
    swipeUid: getActiveSwipeUid(message),
    swipeIndex: Number.isFinite(Number(message?.swipe_id))
      ? Math.floor(Number(message.swipe_id))
      : null,
    role: message?.is_user
      ? "user"
      : message?.is_system && message?.extra?.__st_bme_hide_managed !== true
        ? "system"
        : "assistant",
  };
}

export function normalizeProcessedMessageRecord(value = null) {
  if (typeof value === "string") {
    const messageHash = normalizeIdentifier(value);
    return messageHash
      ? {
          messageHash,
          messageUid: "",
          swipeUid: "",
          swipeIndex: null,
          role: "",
        }
      : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messageHash = normalizeIdentifier(value.messageHash || value.hash);
  const messageUid = normalizeIdentifier(value.messageUid);
  const swipeUid = normalizeIdentifier(value.swipeUid);
  const swipeIndex = value.swipeIndex != null && Number.isFinite(Number(value.swipeIndex))
    ? Math.floor(Number(value.swipeIndex))
    : null;
  const role = new Set(["user", "assistant", "system"]).has(String(value.role || ""))
    ? String(value.role)
    : "";
  if (!messageHash && !messageUid && !swipeUid) return null;
  return { messageHash, messageUid, swipeUid, swipeIndex, role };
}

export function buildStructuralMessageIdentity(message = null, index = 0) {
  const messageUid = getMessageUid(message);
  const swipeUid = getActiveSwipeUid(message);
  return {
    index: Math.max(0, Math.floor(Number(index) || 0)),
    messageUid,
    swipeUid,
    role: message?.is_user
      ? "user"
      : message?.is_system && message?.extra?.__st_bme_hide_managed !== true
        ? "system"
        : "assistant",
    // These positional fallbacks keep non-Bridge installations useful while
    // deliberately excluding message text and plugin-managed attachments.
    fallbackSwipeIndex: Number.isFinite(Number(message?.swipe_id))
      ? Math.floor(Number(message.swipe_id))
      : null,
  };
}

export function buildHostLineage(value = null) {
  const context = normalizeHostTransactionContext(value);
  if (!context) return null;
  const parentConversationId = normalizeIdentifier(value?.parentConversationId);
  return {
    schemaVersion: BME_HOST_LINEAGE_VERSION,
    conversationId: context.conversationId,
    branchId: context.branchId,
    hostRevision: context.hostRevision,
    baseHostRevision: context.baseHostRevision,
    commitEventId: normalizeIdentifier(
      context.commitEventId || context.sourceEventId,
    ),
    commitTransactionId: normalizeIdentifier(context.commitTransactionId),
    committedAt: normalizeIdentifier(context.commitCommittedAt),
    ...(parentConversationId
      ? {
          parentConversationId,
          parentBranchId: normalizeIdentifier(value?.parentBranchId),
          parentRevision: normalizeRevision(value?.parentRevision),
        }
      : {}),
  };
}

export function normalizeHostLineage(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const conversationId = normalizeIdentifier(value.conversationId);
  const branchId = normalizeIdentifier(value.branchId);
  if (!conversationId || !branchId) return null;
  const parentConversationId = normalizeIdentifier(value.parentConversationId);
  return {
    schemaVersion: BME_HOST_LINEAGE_VERSION,
    conversationId,
    branchId,
    hostRevision: normalizeRevision(value.hostRevision),
    baseHostRevision: normalizeRevision(value.baseHostRevision),
    commitEventId: normalizeIdentifier(value.commitEventId),
    commitTransactionId: normalizeIdentifier(value.commitTransactionId),
    committedAt: normalizeIdentifier(value.committedAt),
    ...(parentConversationId
      ? {
          parentConversationId,
          parentBranchId: normalizeIdentifier(value.parentBranchId),
          parentRevision: normalizeRevision(value.parentRevision),
        }
      : {}),
  };
}

export function areHostContextsInSameBranch(left = null, right = null) {
  const a = normalizeHostTransactionContext(left);
  const b = normalizeHostTransactionContext(right);
  if (!a || !b) return true;
  return a.conversationId === b.conversationId && a.branchId === b.branchId;
}

export function buildHostTransactionFence(source = null, validated = null) {
  const sourceContext = normalizeHostTransactionContext(source);
  const validatedContext = normalizeHostTransactionContext(validated);
  if (!sourceContext && !validatedContext) return null;
  const effectiveSource = sourceContext || validatedContext;
  const effectiveValidated = validatedContext || sourceContext;
  if (!areHostContextsInSameBranch(effectiveSource, effectiveValidated)) {
    return null;
  }
  return {
    schemaVersion: 1,
    conversationId: effectiveValidated.conversationId,
    branchId: effectiveValidated.branchId,
    sourceHostRevision: effectiveSource.hostRevision,
    validatedHostRevision: effectiveValidated.hostRevision,
    sourceEventId: normalizeIdentifier(
      effectiveSource.sourceEventId || effectiveSource.commitEventId,
    ),
    validatedCommitEventId: normalizeIdentifier(
      effectiveValidated.commitEventId || effectiveValidated.sourceEventId,
    ),
  };
}

export function cloneHostTransactionContext(value = null) {
  return clonePlain(normalizeHostTransactionContext(value), null);
}
