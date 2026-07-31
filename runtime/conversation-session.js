export function normalizeGenerationType(type = "normal") {
  const normalized = String(type || "normal").trim();
  return normalized || "normal";
}

export function classifyGenerationKind(type = "normal", params = {}) {
  const generationType = normalizeGenerationType(type);
  if (params?.automatic_trigger || params?.quiet_prompt) return "skip";
  if (generationType === "quiet" || generationType === "impersonate") return "skip";
  if (["swipe", "regenerate", "continue"].includes(generationType)) {
    return "no-new-user";
  }
  return "fresh";
}

export function isVisibleUserGenerationMessage(
  message,
  { index = null, chat = null, isSystemMessage = null } = {},
) {
  if (!message?.is_user || message?.extra?.isSmallSys || message?.is_system) return false;
  return !(
    typeof isSystemMessage === "function" &&
    isSystemMessage(message, { index, chat })
  );
}

export function resolveGenerationParentUserFloor(
  chat,
  context = {},
  { isSystemMessage = null } = {},
) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  const generationType = normalizeGenerationType(
    context?.type || context?.generationType || "normal",
  );
  const findVisibleUserBefore = (startIndex) => {
    for (
      let index = Math.min(chat.length - 1, Math.floor(Number(startIndex)));
      index >= 0;
      index -= 1
    ) {
      if (isVisibleUserGenerationMessage(chat[index], { index, chat, isSystemMessage })) {
        return index;
      }
    }
    return null;
  };
  const findLastVisibleNonSystemIndex = () => {
    for (let index = chat.length - 1; index >= 0; index -= 1) {
      const message = chat[index];
      if (!message || message?.extra?.isSmallSys || message?.is_system) continue;
      if (
        typeof isSystemMessage === "function" &&
        isSystemMessage(message, { index, chat })
      ) {
        continue;
      }
      return index;
    }
    return null;
  };

  if (generationType === "swipe") {
    const swipedFloor = Number(context?.swipedAssistantFloor);
    if (Number.isFinite(swipedFloor)) return findVisibleUserBefore(swipedFloor - 1);
    const lastVisible = findLastVisibleNonSystemIndex();
    return Number.isFinite(lastVisible) ? findVisibleUserBefore(lastVisible - 1) : null;
  }

  if (generationType === "regenerate") {
    const lastVisible = findLastVisibleNonSystemIndex();
    if (!Number.isFinite(lastVisible)) return null;
    if (
      isVisibleUserGenerationMessage(chat[lastVisible], {
        index: lastVisible,
        chat,
        isSystemMessage,
      })
    ) {
      return lastVisible;
    }
    return findVisibleUserBefore(lastVisible - 1);
  }

  if (generationType === "continue") {
    const lastVisible = findLastVisibleNonSystemIndex();
    if (!Number.isFinite(lastVisible)) return null;
    return findVisibleUserBefore(lastVisible - (chat[lastVisible]?.is_user ? 0 : 1));
  }

  return findVisibleUserBefore(chat.length - 1);
}

function clonePlain(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return structuredClone(value);
  } catch (_error) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_jsonError) {
      return fallback;
    }
  }
}

function normalizeIdentity(identity = null) {
  const hostLineage =
    identity?.hostLineage && typeof identity.hostLineage === "object"
      ? {
          conversationId: String(identity.hostLineage.conversationId || "").trim(),
          branchId: String(identity.hostLineage.branchId || "").trim(),
          hostRevision: Number.isSafeInteger(Number(identity.hostLineage.hostRevision))
            ? Math.max(0, Number(identity.hostLineage.hostRevision))
            : 0,
          commitEventId: String(identity.hostLineage.commitEventId || "").trim(),
        }
      : null;
  return {
    chatId: String(identity?.chatId || "").trim(),
    hostChatId: String(identity?.hostChatId || "").trim(),
    integrity: String(identity?.integrity || "").trim(),
    identitySource: String(identity?.identitySource || "").trim(),
    hasLikelySelectedChat: identity?.hasLikelySelectedChat === true,
    hostLineage:
      hostLineage?.conversationId && hostLineage?.branchId ? hostLineage : null,
  };
}

export function createConversationSession(deps = {}) {
  let identity = normalizeIdentity();
  let epoch = 0;
  let generation = null;
  let pendingSwipe = null;
  let recentAssistantTailDelete = null;
  let generationSequence = 0;
  let trivialSkip = null;
  const inputs = {
    pendingRecallSendIntent: null,
    pendingHostGenerationInputSnapshot: null,
    lastRecallSentUserMessage: null,
  };

  const now = () =>
    typeof deps.now === "function" ? Number(deps.now()) || Date.now() : Date.now();
  const rerollInferenceWindowMs = () =>
    Number.isFinite(Number(deps.rerollInferenceWindowMs))
      ? Math.max(1, Number(deps.rerollInferenceWindowMs))
      : 15000;

  function resetConversationState() {
    generation = null;
    pendingSwipe = null;
    recentAssistantTailDelete = null;
    trivialSkip = null;
    for (const key of Object.keys(inputs)) inputs[key] = null;
  }

  function enterChat(nextIdentity = null, { forceNewEpoch = false, reason = "" } = {}) {
    const normalized = normalizeIdentity(nextIdentity);
    const canonicalChanged = identity.chatId !== normalized.chatId;
    const locatorChanged = Boolean(
      identity.hostChatId &&
        normalized.hostChatId &&
        identity.hostChatId !== normalized.hostChatId,
    );
    const sameHostLocator = Boolean(
      identity.hostChatId &&
        normalized.hostChatId &&
        identity.hostChatId === normalized.hostChatId,
    );
    const hostConversationChanged = Boolean(
      identity.hostLineage?.conversationId &&
        normalized.hostLineage?.conversationId &&
        identity.hostLineage.conversationId !== normalized.hostLineage.conversationId,
    );
    const hostBranchChanged = Boolean(
      identity.hostLineage?.branchId &&
        normalized.hostLineage?.branchId &&
        identity.hostLineage.branchId !== normalized.hostLineage.branchId,
    );
    const changed =
      forceNewEpoch === true ||
      locatorChanged ||
      hostConversationChanged ||
      hostBranchChanged ||
      (canonicalChanged && !sameHostLocator);
    if (changed) {
      epoch += 1;
      resetConversationState();
    } else if (canonicalChanged) {
      if (generation) {
        generation.chatId = normalized.chatId;
        if (generation.recallTransaction) {
          const transaction = generation.recallTransaction;
          transaction.chatId = normalized.chatId;
          transaction.id = [
            normalized.chatId,
            transaction.generationId || generation.id,
            transaction.generationType || "normal",
            transaction.recallKey || "",
          ].join(":");
        }
      }
      if (pendingSwipe) pendingSwipe.chatId = normalized.chatId;
      if (recentAssistantTailDelete) {
        recentAssistantTailDelete.chatId = normalized.chatId;
      }
    }
    identity = normalized;
    return {
      ...normalized,
      epoch,
      changed,
      reason: String(reason || ""),
    };
  }

  function getIdentity() {
    return { ...identity, epoch };
  }

  function getChatId() {
    return identity.chatId;
  }

  function noteSwipe(messageId = null, meta = null) {
    const parsed = Number(messageId);
    pendingSwipe = {
      assistantFloor: Number.isFinite(parsed) ? Math.floor(parsed) : null,
      meta: clonePlain(meta, null),
      chatId: identity.chatId,
      at: now(),
    };
    return clonePlain(pendingSwipe, null);
  }

  function noteAssistantTailDelete(payload = {}) {
    recentAssistantTailDelete = {
      chatId: identity.chatId,
      at: now(),
      ...clonePlain(payload, {}),
    };
    return clonePlain(recentAssistantTailDelete, null);
  }

  function beginGeneration(type = "normal", params = {}, { dryRun = false, phase = "" } = {}) {
    if (dryRun) return null;
    const at = now();
    const rawType = normalizeGenerationType(type);
    const freshInput = Boolean(params?.__stBmeFreshInputHint);
    const canInferRerollFromDelete = Boolean(
      rawType === "normal" &&
        !freshInput &&
        recentAssistantTailDelete &&
        recentAssistantTailDelete.chatId === identity.chatId &&
        at - Number(recentAssistantTailDelete.at || 0) <= rerollInferenceWindowMs(),
    );
    const generationType = canInferRerollFromDelete ? "regenerate" : rawType;
    generation = {
      id: `${epoch}:${at}:${++generationSequence}`,
      epoch,
      chatId: identity.chatId,
      type: generationType,
      rawType,
      kind: canInferRerollFromDelete
        ? "no-new-user"
        : classifyGenerationKind(generationType, params),
      params: clonePlain(params, {}),
      startedAt: at,
      updatedAt: at,
      phase: String(phase || ""),
      swipedAssistantFloor:
        generationType === "swipe" && Number.isFinite(pendingSwipe?.assistantFloor)
          ? pendingSwipe.assistantFloor
          : null,
      swipeMeta:
        generationType === "swipe" ? clonePlain(pendingSwipe?.meta, null) : null,
      expectedMutation: "",
      expectedMutationAt: 0,
      inferredFrom: canInferRerollFromDelete
        ? "assistant-tail-delete-without-fresh-input"
        : "",
      recallTransaction: null,
    };
    pendingSwipe = null;
    recentAssistantTailDelete = null;
    return getGeneration();
  }

  function updateGeneration(type = "normal", params = {}, options = {}) {
    if (options?.dryRun) return null;
    const rawType = normalizeGenerationType(type);
    const at = now();
    if (
      generation?.inferredFrom &&
      generation.rawType === rawType &&
      generation.chatId === identity.chatId
    ) {
      generation.rawType = rawType;
    } else if (!generation || generation.rawType !== rawType) {
      return beginGeneration(rawType, params, options);
    } else {
      generation.type = rawType;
      generation.kind = classifyGenerationKind(rawType, params);
    }
    generation.params = clonePlain(params, generation.params || {});
    generation.updatedAt = at;
    generation.phase = String(options?.phase || generation.phase || "");
    if (generation.phase === "GENERATION_AFTER_COMMANDS") {
      generation.afterCommandsAt = at;
    }
    return getGeneration();
  }

  function getGeneration() {
    if (!generation || generation.epoch !== epoch || generation.chatId !== identity.chatId) {
      return null;
    }
    const snapshot = clonePlain(generation, null);
    if (snapshot) delete snapshot.recallTransaction;
    return snapshot;
  }

  function clearGeneration(reason = "") {
    const previous = getGeneration();
    generation = null;
    return previous ? { ...previous, clearReason: String(reason || "") } : null;
  }

  function markExpectedMutation(kind = "", payload = {}) {
    if (!generation) return null;
    generation.expectedMutation = String(kind || "");
    generation.expectedMutationAt = now();
    generation.expectedMutationPayload = clonePlain(payload, {});
    generation.updatedAt = now();
    return getGeneration();
  }

  function getRecallTransaction() {
    return generation?.recallTransaction || null;
  }

  function setRecallTransaction(transaction = null) {
    if (!generation) return null;
    if (
      transaction &&
      transaction.generationId &&
      transaction.generationId !== generation.id
    ) {
      return null;
    }
    generation.recallTransaction = transaction;
    return transaction;
  }

  function clearRecallTransaction() {
    if (!generation?.recallTransaction) return null;
    const previous = generation.recallTransaction;
    generation.recallTransaction = null;
    return previous;
  }

  function getInput(name) {
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) return null;
    return clonePlain(inputs[name], null);
  }

  function setInput(name, value = null) {
    if (!Object.prototype.hasOwnProperty.call(inputs, name)) {
      throw new Error(`Unknown conversation input slot: ${name}`);
    }
    inputs[name] = clonePlain(value, null);
    return getInput(name);
  }

  function clearInputs() {
    for (const key of Object.keys(inputs)) inputs[key] = null;
  }

  function getTrivialSkip() {
    return clonePlain(trivialSkip, null);
  }

  function setTrivialSkip(value = null) {
    trivialSkip = clonePlain(value, null);
    return getTrivialSkip();
  }

  function captureLease({ revision = 0, historyHash = "" } = {}) {
    return Object.freeze({
      chatId: identity.chatId,
      hostChatId: identity.hostChatId,
      epoch,
      generationId: generation?.id || "",
      revision: Number(revision || 0),
      historyHash: String(historyHash || ""),
      hostConversationId: identity.hostLineage?.conversationId || "",
      hostBranchId: identity.hostLineage?.branchId || "",
      hostRevision: Number(identity.hostLineage?.hostRevision || 0),
      hostCommitEventId: identity.hostLineage?.commitEventId || "",
    });
  }

  function isLeaseCurrent(lease = null, { requireGeneration = false } = {}) {
    if (!lease || typeof lease !== "object") return false;
    if (Number(lease.epoch) !== epoch) {
      return false;
    }
    const sameChatId = String(lease.chatId || "") === identity.chatId;
    const sameHostLocator = Boolean(
      lease.hostChatId &&
        identity.hostChatId &&
        String(lease.hostChatId) === identity.hostChatId,
    );
    if (!sameChatId && !sameHostLocator) {
      return false;
    }
    if (
      lease.hostConversationId &&
      identity.hostLineage?.conversationId &&
      String(lease.hostConversationId) !== identity.hostLineage.conversationId
    ) {
      return false;
    }
    if (
      lease.hostBranchId &&
      identity.hostLineage?.branchId &&
      String(lease.hostBranchId) !== identity.hostLineage.branchId
    ) {
      return false;
    }
    if (requireGeneration) {
      return Boolean(generation?.id && generation.id === String(lease.generationId || ""));
    }
    return true;
  }

  function assertLeaseCurrent(lease, options = {}) {
    if (isLeaseCurrent(lease, options)) return true;
    const error = new Error("Conversation session changed while work was running");
    error.name = "AbortError";
    throw error;
  }

  return {
    enterChat,
    getIdentity,
    getChatId,
    noteSwipe,
    noteAssistantTailDelete,
    beginGeneration,
    updateGeneration,
    getGeneration,
    clearGeneration,
    markExpectedMutation,
    getRecallTransaction,
    setRecallTransaction,
    clearRecallTransaction,
    getInput,
    setInput,
    clearInputs,
    getTrivialSkip,
    setTrivialSkip,
    captureLease,
    isLeaseCurrent,
    assertLeaseCurrent,
  };
}
