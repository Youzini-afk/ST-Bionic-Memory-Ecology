// ST-BME: old-message hide engine
// Uses the host's native /hide and /unhide slash commands instead of
// mutating chat messages into is_system=true.

const hideState = {
  managedChatRef: null,
  managedChatKey: null,
  managedSystemIndices: new Set(),
  hiddenRangeEnd: -1,
  lastProcessedLength: 0,
  scheduledTimer: null,
  operationVersion: 0,
};

function getTimerApi(runtime = {}) {
  const rawSetTimeout =
    typeof runtime.setTimeout === "function"
      ? runtime.setTimeout
      : globalThis.setTimeout;
  const rawClearTimeout =
    typeof runtime.clearTimeout === "function"
      ? runtime.clearTimeout
      : globalThis.clearTimeout;

  return {
    setTimeout(...args) {
      return Reflect.apply(rawSetTimeout, globalThis, args);
    },
    clearTimeout(...args) {
      return Reflect.apply(rawClearTimeout, globalThis, args);
    },
  };
}

function getCurrentContext(runtime = {}) {
  try {
    return typeof runtime.getContext === "function" ? runtime.getContext() : null;
  } catch {
    return null;
  }
}

function getCurrentChatInfo(runtime = {}) {
  const context = getCurrentContext(runtime);
  return {
    chat: Array.isArray(context?.chat) ? context.chat : null,
    chatId:
      context?.chatId != null && context.chatId !== ""
        ? String(context.chatId)
        : null,
  };
}

function getCurrentChatKey(runtime = {}) {
  const { chat, chatId } = getCurrentChatInfo(runtime);
  if (chatId) return chatId;
  return Array.isArray(chat) ? chat : null;
}

function getSlashExecutor(runtime = {}) {
  if (typeof runtime.executeSlashCommands === "function") {
    return runtime.executeSlashCommands.bind(runtime);
  }

  const context = getCurrentContext(runtime);
  if (typeof context?.executeSlashCommands === "function") {
    return context.executeSlashCommands.bind(context);
  }

  if (typeof globalThis.executeSlashCommands === "function") {
    return globalThis.executeSlashCommands.bind(globalThis);
  }

  if (typeof globalThis.executeSlashCommandsOnChatInput === "function") {
    return globalThis.executeSlashCommandsOnChatInput.bind(globalThis);
  }

  return null;
}

async function executeSlashCommand(command, runtime = {}) {
  const executor = getSlashExecutor(runtime);
  if (!executor) {
    throw new Error("executeSlashCommands is not available");
  }

  return await executor(command, true);
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

function getJquery(runtime = {}) {
  if (typeof runtime.$ === "function") return runtime.$;
  if (typeof globalThis.$ === "function") return globalThis.$;
  return null;
}

function syncSystemAttribute(chat, indices = [], value = "true", runtime = {}) {
  if (!Array.isArray(chat) || !Array.isArray(indices) || indices.length === 0) {
    return;
  }

  const currentChat = getCurrentChatInfo(runtime).chat;
  if (currentChat !== chat) return;

  const jq = getJquery(runtime);
  if (!jq) return;

  const selector = indices.map((index) => `.mes[mesid="${index}"]`).join(",");
  if (!selector) return;
  jq(selector).attr("is_system", value);
}

function calcHideRange(chatLength, hideLastN) {
  if (!Number.isFinite(chatLength) || chatLength <= 0 || hideLastN <= 0) {
    return null;
  }

  const visibleStart =
    hideLastN >= chatLength ? 0 : Math.max(0, chatLength - hideLastN);
  const hideEnd = visibleStart - 1;
  if (hideEnd < 0) return null;

  return {
    start: 0,
    end: hideEnd,
  };
}

function beginOperation() {
  hideState.operationVersion += 1;
  return hideState.operationVersion;
}

function isOperationCurrent(version) {
  return version === hideState.operationVersion;
}

function clearScheduledTimer(runtime = {}) {
  const timers = getTimerApi(runtime);
  if (hideState.scheduledTimer) {
    timers.clearTimeout(hideState.scheduledTimer);
    hideState.scheduledTimer = null;
  }
}

function clearManagedState() {
  hideState.managedChatRef = null;
  hideState.managedChatKey = null;
  hideState.managedSystemIndices.clear();
  hideState.hiddenRangeEnd = -1;
  hideState.lastProcessedLength = 0;
}

function restoreManagedSystemFlags(chat, runtime = {}) {
  if (!Array.isArray(chat) || hideState.managedSystemIndices.size === 0) {
    hideState.managedSystemIndices.clear();
    return 0;
  }

  const restored = [];
  for (const index of hideState.managedSystemIndices) {
    const message = chat[index];
    if (!message || message.is_system !== true) continue;
    message.is_system = false;
    restored.push(index);
  }

  syncSystemAttribute(chat, restored, "false", runtime);
  hideState.managedSystemIndices.clear();
  return restored.length;
}

function markManagedSystemRange(chat, start, end, runtime = {}) {
  if (!Array.isArray(chat) || start > end) return 0;

  const marked = [];
  for (let index = start; index <= end && index < chat.length; index++) {
    const message = chat[index];
    if (!message || message.is_system === true) continue;
    message.is_system = true;
    hideState.managedSystemIndices.add(index);
    marked.push(index);
  }

  syncSystemAttribute(chat, marked, "true", runtime);
  return marked.length;
}

function adoptManagedChat(chat, chatKey, runtime = {}) {
  const previousChat = hideState.managedChatRef;
  if (previousChat && previousChat !== chat) {
    restoreManagedSystemFlags(previousChat, runtime);
    hideState.hiddenRangeEnd = -1;
    hideState.lastProcessedLength = 0;
  }

  hideState.managedChatRef = chat;
  hideState.managedChatKey = chatKey;
}

function buildResult({
  active = false,
  hiddenCount = 0,
  shownCount = 0,
  chatLength = 0,
  incremental = false,
  stale = false,
} = {}) {
  return {
    active,
    hiddenCount,
    shownCount,
    managedCount: active ? hiddenCount : 0,
    chatLength,
    incremental,
    stale,
  };
}

async function unhideCurrentRange(runtime = {}, version = null) {
  const { chat } = getCurrentChatInfo(runtime);
  const chatLength = Array.isArray(chat) ? chat.length : 0;
  const previousEnd = Math.min(hideState.hiddenRangeEnd, chatLength - 1);
  if (previousEnd < 0) {
    return { shownCount: 0, chatLength };
  }

  await executeSlashCommand(`/unhide 0-${previousEnd}`, runtime);
  if (!isOperationCurrent(version ?? hideState.operationVersion)) {
    return { shownCount: 0, chatLength, stale: true };
  }

  return { shownCount: previousEnd + 1, chatLength };
}

async function runHideApply(settings = {}, runtime = {}, options = {}) {
  const normalized = normalizeHideSettings(settings);
  const { incrementalPreferred = false, version = beginOperation() } = options;
  const chatInfo = getCurrentChatInfo(runtime);
  const chat = chatInfo.chat;
  const chatLength = Array.isArray(chat) ? chat.length : 0;

  if (!chat || chatLength === 0) {
    clearManagedState();
    return buildResult();
  }

  const chatKey = getCurrentChatKey(runtime);
  const previousChatKey = hideState.managedChatKey;
  const sameChat =
    previousChatKey !== null && chatKey !== null && previousChatKey === chatKey;
  const previousHiddenEnd = sameChat ? hideState.hiddenRangeEnd : -1;
  const previousLength = sameChat ? hideState.lastProcessedLength : 0;
  adoptManagedChat(chat, chatKey, runtime);
  hideState.lastProcessedLength = chatLength;

  if (!normalized.enabled || normalized.hideLastN <= 0) {
    if (previousHiddenEnd >= 0) {
      const { shownCount } = await unhideCurrentRange(runtime, version);
      if (!isOperationCurrent(version)) {
        return buildResult({ chatLength, shownCount, stale: true });
      }
      restoreManagedSystemFlags(chat, runtime);
      hideState.hiddenRangeEnd = -1;
      return buildResult({ chatLength, shownCount });
    }

    restoreManagedSystemFlags(chat, runtime);
    hideState.hiddenRangeEnd = -1;
    return buildResult({ chatLength });
  }

  const nextRange = calcHideRange(chatLength, normalized.hideLastN);
  if (!nextRange) {
    if (previousHiddenEnd >= 0) {
      const { shownCount } = await unhideCurrentRange(runtime, version);
      if (!isOperationCurrent(version)) {
        return buildResult({ chatLength, shownCount, stale: true });
      }
      restoreManagedSystemFlags(chat, runtime);
      hideState.hiddenRangeEnd = -1;
      return buildResult({ chatLength, shownCount });
    }

    restoreManagedSystemFlags(chat, runtime);
    hideState.hiddenRangeEnd = -1;
    return buildResult({
      active: true,
      hiddenCount: 0,
      chatLength,
    });
  }

  if (
    incrementalPreferred &&
    sameChat &&
    previousHiddenEnd >= 0 &&
    chatLength > previousLength &&
    previousLength > 0
  ) {
    const previousRange = calcHideRange(previousLength, normalized.hideLastN);
    const canExtendOnly =
      previousRange &&
      previousRange.end === previousHiddenEnd &&
      nextRange.end >= previousHiddenEnd;
    if (canExtendOnly && nextRange.end > previousHiddenEnd) {
      const start = previousHiddenEnd + 1;
      const end = nextRange.end;
      await executeSlashCommand(`/hide ${start}-${end}`, runtime);
      if (!isOperationCurrent(version)) {
        return buildResult({ chatLength, stale: true });
      }

      markManagedSystemRange(chat, start, end, runtime);
      hideState.hiddenRangeEnd = end;
      return buildResult({
        active: true,
        hiddenCount: end + 1,
        shownCount: 0,
        chatLength,
        incremental: true,
      });
    }
  }

  let shownCount = 0;
  if (previousHiddenEnd >= 0) {
    const unhideResult = await unhideCurrentRange(runtime, version);
    if (!isOperationCurrent(version)) {
      return buildResult({
        chatLength,
        shownCount: unhideResult.shownCount ?? 0,
        stale: true,
      });
    }
    shownCount = unhideResult.shownCount ?? 0;
  }
  restoreManagedSystemFlags(chat, runtime);

  await executeSlashCommand(`/hide ${nextRange.start}-${nextRange.end}`, runtime);
  if (!isOperationCurrent(version)) {
    return buildResult({ chatLength, shownCount, stale: true });
  }

  markManagedSystemRange(chat, nextRange.start, nextRange.end, runtime);
  hideState.hiddenRangeEnd = nextRange.end;
  hideState.lastProcessedLength = chatLength;

  return buildResult({
    active: true,
    hiddenCount: nextRange.end + 1,
    shownCount,
    chatLength,
    incremental: false,
  });
}

export async function runFullHideCheck(settings = {}, runtime = {}) {
  return await runHideApply(settings, runtime, {
    incrementalPreferred: false,
    version: beginOperation(),
  });
}

export async function runIncrementalHideCheck(settings = {}, runtime = {}) {
  return await runHideApply(settings, runtime, {
    incrementalPreferred: true,
    version: beginOperation(),
  });
}

export async function applyHideSettings(settings = {}, runtime = {}) {
  return await runFullHideCheck(settings, runtime);
}

export function scheduleHideSettingsApply(
  settings = {},
  runtime = {},
  delayMs = 120,
) {
  clearScheduledTimer(runtime);

  const timers = getTimerApi(runtime);
  const snapshot = normalizeHideSettings(settings);
  hideState.scheduledTimer = timers.setTimeout(() => {
    hideState.scheduledTimer = null;
    void applyHideSettings(snapshot, runtime).catch((error) => {
      console.warn?.("[ST-BME] scheduled hide apply failed", error);
    });
  }, Math.max(0, Math.trunc(Number(delayMs) || 0)));
}

export async function unhideAll(runtime = {}) {
  clearScheduledTimer(runtime);
  const version = beginOperation();
  const chatInfo = getCurrentChatInfo(runtime);
  const chatLength = Array.isArray(chatInfo.chat) ? chatInfo.chat.length : 0;

  if (chatLength === 0 || hideState.hiddenRangeEnd < 0) {
    hideState.lastProcessedLength = chatLength;
    hideState.hiddenRangeEnd = -1;
    hideState.managedChatKey = getCurrentChatKey(runtime);
    return buildResult({ chatLength });
  }

  const { shownCount } = await unhideCurrentRange(runtime, version);
  if (!isOperationCurrent(version)) {
    return buildResult({ chatLength, shownCount, stale: true });
  }

  restoreManagedSystemFlags(chatInfo.chat, runtime);
  hideState.hiddenRangeEnd = -1;
  hideState.lastProcessedLength = chatLength;
  hideState.managedChatRef = chatInfo.chat;
  hideState.managedChatKey = getCurrentChatKey(runtime);

  return buildResult({ chatLength, shownCount });
}

export function resetHideState(runtime = {}) {
  clearScheduledTimer(runtime);
  beginOperation();
  restoreManagedSystemFlags(hideState.managedChatRef, runtime);
  clearManagedState();
}

export function getHideStateSnapshot() {
  return {
    hasManagedChat: hideState.managedChatRef !== null,
    managedHiddenCount: hideState.hiddenRangeEnd >= 0 ? hideState.hiddenRangeEnd + 1 : 0,
    lastProcessedLength: hideState.lastProcessedLength,
    scheduled: Boolean(hideState.scheduledTimer),
  };
}
