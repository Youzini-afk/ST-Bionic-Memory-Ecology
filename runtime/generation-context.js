const DEFAULT_GENERATION_CONTEXT_TTL_MS = 60000;

export function normalizeGenerationType(type = "normal") {
  const normalized = String(type || "normal").trim();
  return normalized || "normal";
}

export function classifyGenerationKind(type = "normal", params = {}) {
  const generationType = normalizeGenerationType(type);
  if (params?.automatic_trigger || params?.quiet_prompt) {
    return "skip";
  }
  if (generationType === "quiet" || generationType === "impersonate") {
    return "skip";
  }
  if (
    generationType === "swipe" ||
    generationType === "regenerate" ||
    generationType === "continue"
  ) {
    return "no-new-user";
  }
  return "fresh";
}

export function isVisibleUserGenerationMessage(message, { index = null, chat = null, isSystemMessage = null } = {}) {
  if (!message?.is_user) return false;
  if (message?.extra?.isSmallSys) return false;
  if (typeof isSystemMessage === "function" && isSystemMessage(message, { index, chat })) {
    return false;
  }
  if (message?.is_system) return false;
  return true;
}

export function resolveGenerationParentUserFloor(
  chat,
  context = {},
  { phase = "", isSystemMessage = null } = {},
) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  const generationType = normalizeGenerationType(context?.type || context?.generationType || "normal");
  const findVisibleUserBefore = (startIndex) => {
    for (let index = Math.min(chat.length - 1, Math.floor(Number(startIndex))); index >= 0; index--) {
      if (isVisibleUserGenerationMessage(chat[index], { index, chat, isSystemMessage })) return index;
    }
    return null;
  };
  const findLastVisibleNonSystemIndex = () => {
    for (let index = chat.length - 1; index >= 0; index--) {
      const message = chat[index];
      if (!message) continue;
      if (message?.extra?.isSmallSys) continue;
      if (typeof isSystemMessage === "function" && isSystemMessage(message, { index, chat })) continue;
      if (message?.is_system) continue;
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
    if (isVisibleUserGenerationMessage(chat[lastVisible], { index: lastVisible, chat, isSystemMessage })) {
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
  if (!value || typeof value !== "object") return fallback;
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

export function createGenerationContextTracker(deps = {}) {
  let current = null;
  let pendingSwipe = null;
  let recentAssistantTailDelete = null;
  let sequence = 0;

  const now = () =>
    typeof deps.now === "function" ? Number(deps.now()) || Date.now() : Date.now();
  const ttlMs = () =>
    Number.isFinite(Number(deps.ttlMs))
      ? Math.max(1, Number(deps.ttlMs))
      : DEFAULT_GENERATION_CONTEXT_TTL_MS;
  const getChatId = () => String(deps.getCurrentChatId?.() || "").trim();

  function noteSwipe(messageId = null, meta = null) {
    const parsed = Number(messageId);
    pendingSwipe = {
      assistantFloor: Number.isFinite(parsed) ? Math.floor(parsed) : null,
      meta: clonePlain(meta, null),
      chatId: getChatId(),
      at: now(),
    };
    return pendingSwipe;
  }

  function begin(type = "normal", params = {}, { dryRun = false, phase = "" } = {}) {
    if (dryRun) return null;
    const at = now();
    const rawType = normalizeGenerationType(type);
    const activeChatId = getChatId();
    const freshInput = Boolean(params?.__stBmeFreshInputHint);
    const canInferRerollFromDelete = Boolean(
      rawType === "normal" &&
        !freshInput &&
        recentAssistantTailDelete &&
        recentAssistantTailDelete.chatId === activeChatId &&
        at - Number(recentAssistantTailDelete.at || 0) <= ttlMs(),
    );
    const generationType = canInferRerollFromDelete ? "regenerate" : rawType;
    const kind = canInferRerollFromDelete
      ? "no-new-user"
      : classifyGenerationKind(generationType, params);
    const context = {
      id: `${at}:${++sequence}`,
      type: generationType,
      rawType,
      kind,
      chatId: getChatId(),
      params: clonePlain(params, {}),
      dryRun: false,
      startedAt: at,
      updatedAt: at,
      phase: String(phase || ""),
      swipedAssistantFloor:
        generationType === "swipe" && Number.isFinite(pendingSwipe?.assistantFloor)
          ? pendingSwipe.assistantFloor
          : null,
      swipeMeta: generationType === "swipe" ? clonePlain(pendingSwipe?.meta, null) : null,
      expectedMutation: "",
      expectedMutationAt: 0,
      inferredFrom: canInferRerollFromDelete
        ? "assistant-tail-delete-without-fresh-input"
        : "",
    };
    pendingSwipe = null;
    recentAssistantTailDelete = null;
    current = context;
    return { ...context };
  }

  function update(type = "normal", params = {}, { dryRun = false, phase = "" } = {}) {
    if (dryRun) return null;
    const at = now();
    const rawType = normalizeGenerationType(type);
    if (
      current?.inferredFrom &&
      current.rawType === rawType &&
      current.chatId === getChatId()
    ) {
      current = {
        ...current,
        rawType,
        params: clonePlain(params, current.params || {}),
        updatedAt: at,
        afterCommandsAt:
          String(phase || "") === "GENERATION_AFTER_COMMANDS"
            ? at
            : current.afterCommandsAt || 0,
        phase: String(phase || current.phase || ""),
      };
      return { ...current };
    }
    const generationType = rawType;
    const kind = classifyGenerationKind(generationType, params);
    if (!current || current.type !== generationType || current.chatId !== getChatId()) {
      return begin(generationType, params, { dryRun, phase });
    }
    current = {
      ...current,
      type: generationType,
      kind,
      params: clonePlain(params, current.params || {}),
      updatedAt: at,
      afterCommandsAt:
        String(phase || "") === "GENERATION_AFTER_COMMANDS"
          ? at
          : current.afterCommandsAt || 0,
      phase: String(phase || current.phase || ""),
    };
    return { ...current };
  }

  function get({ allowStale = false } = {}) {
    if (!current) return null;
    const age = now() - Number(current.updatedAt || current.startedAt || 0);
    if (!allowStale && age > ttlMs()) {
      current = null;
      return null;
    }
    const activeChatId = getChatId();
    if (current.chatId && activeChatId && current.chatId !== activeChatId) {
      current = null;
      return null;
    }
    return { ...current };
  }

  function markExpectedMutation(kind = "", payload = {}) {
    if (!current) return null;
    current = {
      ...current,
      expectedMutation: String(kind || ""),
      expectedMutationAt: now(),
      expectedMutationPayload: clonePlain(payload, {}),
      updatedAt: now(),
    };
    return { ...current };
  }

  function clear(reason = "") {
    const previous = current;
    current = null;
    pendingSwipe = null;
    recentAssistantTailDelete = null;
    return previous ? { ...previous, clearReason: String(reason || "") } : null;
  }

  function noteAssistantTailDelete(payload = {}) {
    recentAssistantTailDelete = {
      chatId: getChatId(),
      at: now(),
      ...clonePlain(payload, {}),
    };
    return { ...recentAssistantTailDelete };
  }

  return {
    begin,
    update,
    get,
    clear,
    noteSwipe,
    noteAssistantTailDelete,
    markExpectedMutation,
  };
}
