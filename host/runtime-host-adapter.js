export const BME_HOST_PROFILE_GENERIC_ST = "generic-st";
export const BME_HOST_PROFILE_LUKER = "luker";

function normalizeString(value = "") {
  return String(value ?? "").trim();
}

function getHostRuntimeContext() {
  try {
    if (typeof globalThis.Luker?.getContext === "function") {
      return globalThis.Luker.getContext();
    }
  } catch {
    // ignore
  }

  try {
    if (typeof globalThis.SillyTavern?.getContext === "function") {
      return globalThis.SillyTavern.getContext();
    }
  } catch {
    // ignore
  }

  try {
    if (typeof globalThis.getContext === "function") {
      return globalThis.getContext();
    }
  } catch {
    // ignore
  }

  return {};
}

export function normalizeBmeChatStateTarget(target = null) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return null;
  }

  const isGroup = target.is_group === true;
  if (isGroup) {
    const id = normalizeString(target.id);
    return id
      ? {
          is_group: true,
          id,
        }
      : null;
  }

  const avatarUrl = normalizeString(target.avatar_url);
  const fileName = normalizeString(target.file_name);
  if (!avatarUrl || !fileName) {
    return null;
  }

  return {
    is_group: false,
    avatar_url: avatarUrl,
    file_name: fileName,
  };
}

function resolveCharacterAvatar(context = null) {
  const activeContext =
    context && typeof context === "object" ? context : getHostRuntimeContext();
  const directCandidates = [
    activeContext.characterAvatar,
    activeContext.character_avatar,
    activeContext.avatar_url,
    activeContext.characterAvatarUrl,
    activeContext.name2_avatar,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const characterId = activeContext.characterId;
  const character =
    activeContext.character ||
    activeContext.characters?.[Number(characterId)] ||
    activeContext.characters?.[characterId] ||
    null;

  return normalizeString(
    character?.avatar ||
      character?.avatar_url ||
      character?.data?.avatar ||
      character?.data?.avatar_url,
  );
}

function resolveChatFileName(context = null) {
  const activeContext =
    context && typeof context === "object" ? context : getHostRuntimeContext();
  const candidates = [
    activeContext.chatId,
    typeof activeContext.getCurrentChatId === "function"
      ? activeContext.getCurrentChatId()
      : "",
    activeContext.chatMetadata?.chat_id,
    activeContext.chatMetadata?.chatId,
    activeContext.chatMetadata?.session_id,
    activeContext.chatMetadata?.sessionId,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

export function resolveCurrentBmeChatStateTarget(
  context = getHostRuntimeContext(),
  explicitTarget = null,
) {
  const normalizedExplicit = normalizeBmeChatStateTarget(explicitTarget);
  if (normalizedExplicit) {
    return normalizedExplicit;
  }

  const activeContext =
    context && typeof context === "object" ? context : getHostRuntimeContext();
  const groupId = normalizeString(activeContext.groupId);
  const chatId = resolveChatFileName(activeContext);
  if (groupId) {
    return normalizeBmeChatStateTarget({
      is_group: true,
      id: chatId || groupId,
    });
  }

  const avatarUrl = resolveCharacterAvatar(activeContext);
  const fileName = chatId;
  if (avatarUrl && fileName) {
    return normalizeBmeChatStateTarget({
      is_group: false,
      avatar_url: avatarUrl,
      file_name: fileName,
    });
  }

  return null;
}

export function serializeBmeChatStateTarget(target = null) {
  const normalized = normalizeBmeChatStateTarget(target);
  if (!normalized) return "";
  return normalized.is_group
    ? `group:${normalized.id}`
    : `char:${normalized.avatar_url}:${normalized.file_name}`;
}

export function resolveChatStateTargetChatId(target = null) {
  const normalized = normalizeBmeChatStateTarget(target);
  if (!normalized) return "";
  return normalized.is_group
    ? normalizeString(normalized.id)
    : normalizeString(normalized.file_name);
}

function isAndroidWebViewLike() {
  const userAgent = normalizeString(globalThis.navigator?.userAgent).toLowerCase();
  if (!userAgent) return false;
  return (
    userAgent.includes("wv") ||
    (userAgent.includes("android") && !userAgent.includes("chrome/")) ||
    userAgent.includes(" version/") ||
    userAgent.includes("lukerandroid")
  );
}

export function isLukerHostContext(context = getHostRuntimeContext()) {
  const activeContext =
    context && typeof context === "object" ? context : getHostRuntimeContext();
  return (
    !!globalThis.Luker &&
    typeof globalThis.Luker?.getContext === "function" &&
    typeof activeContext.getChatState === "function" &&
    typeof activeContext.updateChatState === "function" &&
    typeof activeContext.getChatStateBatch === "function"
  );
}

export function resolveBmeHostProfile(context = getHostRuntimeContext()) {
  return isLukerHostContext(context)
    ? BME_HOST_PROFILE_LUKER
    : BME_HOST_PROFILE_GENERIC_ST;
}

export function isBmeLightweightHostMode(context = getHostRuntimeContext()) {
  const activeContext =
    context && typeof context === "object" ? context : getHostRuntimeContext();
  const hostProfile = resolveBmeHostProfile(activeContext);
  if (hostProfile !== BME_HOST_PROFILE_LUKER) {
    return false;
  }

  if (activeContext.lightweightHostMode === true) {
    return true;
  }

  if (typeof activeContext.isMobile === "function" && activeContext.isMobile()) {
    return true;
  }

  if (globalThis.matchMedia?.("(pointer: coarse)")?.matches) {
    return true;
  }

  return isAndroidWebViewLike();
}

function callContextMethod(context, methodName, args = []) {
  const fn = context?.[methodName];
  if (typeof fn !== "function") {
    return null;
  }
  return Reflect.apply(fn, context, args);
}

function createBaseAdapter(context = getHostRuntimeContext()) {
  const activeContext =
    context && typeof context === "object" ? context : getHostRuntimeContext();
  const hostProfile = resolveBmeHostProfile(activeContext);

  return {
    context: activeContext,
    hostProfile,
    resolveCurrentTarget(options = {}) {
      return resolveCurrentBmeChatStateTarget(activeContext, options?.target);
    },
    getChatIdFromTarget(target = null) {
      return resolveChatStateTargetChatId(target);
    },
    isLightweightHostMode() {
      return isBmeLightweightHostMode(activeContext);
    },
    async readChatStateBatch(namespaces = [], options = {}) {
      const normalizedTarget = this.resolveCurrentTarget(options);
      const result = callContextMethod(activeContext, "getChatStateBatch", [
        namespaces,
        normalizedTarget ? { ...(options || {}), target: normalizedTarget } : options,
      ]);
      if (result instanceof Promise) {
        return await result;
      }
      return result ?? new Map();
    },
    async readChatState(namespace = "", options = {}) {
      const normalizedTarget = this.resolveCurrentTarget(options);
      const result = callContextMethod(activeContext, "getChatState", [
        namespace,
        normalizedTarget ? { ...(options || {}), target: normalizedTarget } : options,
      ]);
      if (result instanceof Promise) {
        return await result;
      }
      return result ?? null;
    },
    async updateChatState(namespace = "", updater, options = {}) {
      const normalizedTarget = this.resolveCurrentTarget(options);
      const result = callContextMethod(activeContext, "updateChatState", [
        namespace,
        updater,
        normalizedTarget ? { ...(options || {}), target: normalizedTarget } : options,
      ]);
      if (result instanceof Promise) {
        return await result;
      }
      return result ?? { ok: false, updated: false, state: null };
    },
    async deleteChatState(namespace = "", options = {}) {
      const normalizedTarget = this.resolveCurrentTarget(options);
      const result = callContextMethod(activeContext, "deleteChatState", [
        namespace,
        normalizedTarget ? { ...(options || {}), target: normalizedTarget } : options,
      ]);
      if (result instanceof Promise) {
        return await result;
      }
      return Boolean(result);
    },
    buildPresetAwarePromptMessages(options = {}) {
      return callContextMethod(activeContext, "buildPresetAwarePromptMessages", [
        options,
      ]);
    },
    async simulateWorldInfoActivation(options = {}) {
      const result = callContextMethod(activeContext, "simulateWorldInfoActivation", [
        options,
      ]);
      if (result instanceof Promise) {
        return await result;
      }
      return result ?? null;
    },
    resolveChatCompletionRequestProfile(options = {}) {
      return callContextMethod(
        activeContext,
        "resolveChatCompletionRequestProfile",
        [options],
      );
    },
    registerGenerationHooks(handlers = {}, options = {}) {
      const eventSource = activeContext?.eventSource;
      const eventTypes = activeContext?.eventTypes || {};
      if (!eventSource || typeof eventSource.on !== "function") {
        return [];
      }

      const cleanups = [];
      const priority =
        Number.isFinite(Number(options.priority)) ? Number(options.priority) : 20;
      const bind = (eventName, handler) => {
        if (!eventName || typeof handler !== "function") return;
        eventSource.on(eventName, handler, { priority });
        if (typeof eventSource.off === "function") {
          cleanups.push(() => eventSource.off(eventName, handler));
        } else if (typeof eventSource.removeListener === "function") {
          cleanups.push(() => eventSource.removeListener(eventName, handler));
        }
      };

      bind(eventTypes.GENERATION_CONTEXT_READY, handlers.onGenerationContextReady);
      bind(
        eventTypes.GENERATION_BEFORE_WORLD_INFO_SCAN,
        handlers.onGenerationBeforeWorldInfoScan,
      );
      bind(
        eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN,
        handlers.onGenerationAfterWorldInfoScan,
      );
      bind(
        eventTypes.GENERATION_WORLD_INFO_FINALIZED,
        handlers.onGenerationWorldInfoFinalized,
      );
      bind(
        eventTypes.GENERATION_BEFORE_API_REQUEST,
        handlers.onGenerationBeforeApiRequest,
      );
      bind(eventTypes.CHAT_BRANCH_CREATED, handlers.onChatBranchCreated);
      bind(eventTypes.MESSAGE_UPDATED, handlers.onMessageUpdated);
      return cleanups;
    },
    registerManagedRegexProvider(owner = "", options = {}) {
      return callContextMethod(activeContext, "registerManagedRegexProvider", [
        owner,
        options,
      ]);
    },
  };
}

export function getBmeHostAdapter(context = getHostRuntimeContext()) {
  return createBaseAdapter(context);
}
