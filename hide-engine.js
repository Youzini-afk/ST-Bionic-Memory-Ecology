// ST-BME: 隐藏旧楼层引擎
// 通过临时把旧楼层标记为 is_system=true，让宿主主回复与 ST-BME 自己的聊天读取一起跳过这些楼层。

const hideState = {
  managedChatRef: null,
  hiddenIndices: new Set(),
  lastProcessedLength: 0,
  scheduledTimer: null,
};

function getTimerApi(runtime = {}) {
  return {
    setTimeout:
      typeof runtime.setTimeout === "function"
        ? runtime.setTimeout.bind(runtime)
        : globalThis.setTimeout.bind(globalThis),
    clearTimeout:
      typeof runtime.clearTimeout === "function"
        ? runtime.clearTimeout.bind(runtime)
        : globalThis.clearTimeout.bind(globalThis),
  };
}

function getJquery(runtime = {}) {
  if (typeof runtime.$ === "function") return runtime.$;
  if (typeof globalThis.$ === "function") return globalThis.$;
  return null;
}

function getCurrentChat(runtime = {}) {
  try {
    const context =
      typeof runtime.getContext === "function" ? runtime.getContext() : null;
    return Array.isArray(context?.chat) ? context.chat : null;
  } catch {
    return null;
  }
}

function normalizeHideSettings(settings = {}) {
  return {
    enabled: Boolean(settings.enabled),
    hideLastN: Math.max(
      0,
      Math.trunc(
        Number(
          settings.hideLastN ??
            settings.hide_last_n ??
            settings.keepLastN ??
            settings.keep_last_n ??
            0,
        ) || 0,
      ),
    ),
  };
}

function syncSystemAttribute(chat, indices = [], value = "true", runtime = {}) {
  if (!Array.isArray(indices) || indices.length === 0) return;
  if (getCurrentChat(runtime) !== chat) return;

  const jq = getJquery(runtime);
  if (!jq) return;

  const selector = indices.map((index) => `.mes[mesid="${index}"]`).join(",");
  if (!selector) return;
  jq(selector).attr("is_system", value);
}

function unhideTrackedChat(chat, runtime = {}) {
  if (!Array.isArray(chat) || hideState.hiddenIndices.size === 0) {
    return { shownCount: 0 };
  }

  const toShow = [];
  for (const index of hideState.hiddenIndices) {
    const message = chat[index];
    if (!message || message.is_system !== true) continue;
    message.is_system = false;
    toShow.push(index);
  }

  syncSystemAttribute(chat, toShow, "false", runtime);
  return { shownCount: toShow.length };
}

function swapManagedChat(nextChat, runtime = {}) {
  const previousChat = hideState.managedChatRef;
  if (previousChat && previousChat !== nextChat) {
    unhideTrackedChat(previousChat, runtime);
    hideState.hiddenIndices.clear();
    hideState.lastProcessedLength = 0;
  }
  hideState.managedChatRef = nextChat;
}

export function runFullHideCheck(settings = {}, runtime = {}) {
  const normalized = normalizeHideSettings(settings);
  const chat = getCurrentChat(runtime);
  if (!chat || chat.length === 0) {
    resetHideState(runtime);
    return {
      active: false,
      hiddenCount: 0,
      shownCount: 0,
      managedCount: 0,
      chatLength: 0,
    };
  }

  swapManagedChat(chat, runtime);

  if (!normalized.enabled || normalized.hideLastN <= 0) {
    const { shownCount } = unhideTrackedChat(chat, runtime);
    hideState.hiddenIndices.clear();
    hideState.lastProcessedLength = chat.length;
    return {
      active: false,
      hiddenCount: 0,
      shownCount,
      managedCount: 0,
      chatLength: chat.length,
    };
  }

  const visibleStart =
    normalized.hideLastN >= chat.length
      ? 0
      : Math.max(0, chat.length - normalized.hideLastN);
  const desiredHiddenIndices = new Set();
  const managedHiddenIndices = new Set();
  const toHide = [];
  const toShow = [];

  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message) continue;

    const shouldHide = index < visibleStart;
    const isHidden = message.is_system === true;
    const wasHiddenByBme = hideState.hiddenIndices.has(index);

    if (shouldHide) {
      desiredHiddenIndices.add(index);
      if (wasHiddenByBme || !isHidden) {
        managedHiddenIndices.add(index);
      }
      if (!isHidden) {
        message.is_system = true;
        toHide.push(index);
      }
      continue;
    }

    if (isHidden && wasHiddenByBme) {
      message.is_system = false;
      toShow.push(index);
    }
  }

  syncSystemAttribute(chat, [...desiredHiddenIndices], "true", runtime);
  syncSystemAttribute(chat, toShow, "false", runtime);

  hideState.hiddenIndices = managedHiddenIndices;
  hideState.lastProcessedLength = chat.length;

  return {
    active: true,
    hiddenCount: toHide.length,
    shownCount: toShow.length,
    managedCount: managedHiddenIndices.size,
    chatLength: chat.length,
  };
}

export function runIncrementalHideCheck(settings = {}, runtime = {}) {
  const normalized = normalizeHideSettings(settings);
  const chat = getCurrentChat(runtime);
  if (!chat || chat.length === 0) {
    resetHideState(runtime);
    return {
      active: false,
      hiddenCount: 0,
      shownCount: 0,
      managedCount: 0,
      chatLength: 0,
      incremental: false,
    };
  }

  if (
    hideState.managedChatRef !== chat ||
    !normalized.enabled ||
    normalized.hideLastN <= 0
  ) {
    return {
      ...runFullHideCheck(normalized, runtime),
      incremental: false,
    };
  }

  const chatLength = chat.length;
  const previousLength = hideState.lastProcessedLength;
  if (chatLength <= previousLength) {
    return {
      ...runFullHideCheck(normalized, runtime),
      incremental: false,
    };
  }

  const previousVisibleStart =
    previousLength > 0 ? Math.max(0, previousLength - normalized.hideLastN) : 0;
  const nextVisibleStart = Math.max(0, chatLength - normalized.hideLastN);
  const toHide = [];

  if (nextVisibleStart > previousVisibleStart) {
    for (let index = previousVisibleStart; index < nextVisibleStart; index++) {
      const message = chat[index];
      if (!message || message.is_system === true) continue;
      message.is_system = true;
      hideState.hiddenIndices.add(index);
      toHide.push(index);
    }
  }

  syncSystemAttribute(chat, toHide, "true", runtime);
  hideState.lastProcessedLength = chatLength;

  return {
    active: true,
    hiddenCount: toHide.length,
    shownCount: 0,
    managedCount: hideState.hiddenIndices.size,
    chatLength,
    incremental: true,
  };
}

export function applyHideSettings(settings = {}, runtime = {}) {
  return runFullHideCheck(settings, runtime);
}

export function scheduleHideSettingsApply(
  settings = {},
  runtime = {},
  delayMs = 120,
) {
  const timers = getTimerApi(runtime);
  if (hideState.scheduledTimer) {
    timers.clearTimeout(hideState.scheduledTimer);
    hideState.scheduledTimer = null;
  }

  const snapshot = normalizeHideSettings(settings);
  hideState.scheduledTimer = timers.setTimeout(() => {
    hideState.scheduledTimer = null;
    applyHideSettings(snapshot, runtime);
  }, Math.max(0, Math.trunc(Number(delayMs) || 0)));
}

export function unhideAll(runtime = {}) {
  const timers = getTimerApi(runtime);
  if (hideState.scheduledTimer) {
    timers.clearTimeout(hideState.scheduledTimer);
    hideState.scheduledTimer = null;
  }

  const managedChat = hideState.managedChatRef;
  const { shownCount } = unhideTrackedChat(managedChat, runtime);
  hideState.hiddenIndices.clear();
  hideState.lastProcessedLength = Array.isArray(managedChat)
    ? managedChat.length
    : 0;

  return {
    active: false,
    shownCount,
    managedCount: 0,
  };
}

export function resetHideState(runtime = {}) {
  const timers = getTimerApi(runtime);
  if (hideState.scheduledTimer) {
    timers.clearTimeout(hideState.scheduledTimer);
    hideState.scheduledTimer = null;
  }

  const managedChat = hideState.managedChatRef;
  unhideTrackedChat(managedChat, runtime);
  hideState.managedChatRef = null;
  hideState.hiddenIndices.clear();
  hideState.lastProcessedLength = 0;
}

export function getHideStateSnapshot() {
  return {
    hasManagedChat: Boolean(hideState.managedChatRef),
    managedHiddenCount: hideState.hiddenIndices.size,
    lastProcessedLength: hideState.lastProcessedLength,
    scheduled: Boolean(hideState.scheduledTimer),
  };
}
