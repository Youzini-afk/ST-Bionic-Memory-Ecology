// ST-BME message render-limit policy.
//
// Extracted from index.js so it can be unit-tested by direct import instead of
// slicing index.js into a temp module. Pure decisions take plain arguments;
// the one side-effecting entry (applyMessageRenderLimit) receives an explicit
// host adapter, so this module owns no module-level mutable state and never
// reaches for globals on its own.

/**
 * Normalizes render-limit settings into {enabled, render_last_n}.
 * @param {object|null} settings
 * @param {() => object} [resolveSettings] fallback settings source when none passed
 */
export function getMessageRenderLimitSettings(settings = null, resolveSettings = null) {
  let sourceSettings = settings;
  if (!sourceSettings || typeof sourceSettings !== "object") {
    try {
      sourceSettings =
        typeof resolveSettings === "function" ? resolveSettings() : {};
    } catch {
      sourceSettings = {};
    }
  }
  return {
    enabled:
      sourceSettings.enabled !== false &&
      Boolean(sourceSettings.hideOldMessagesRenderLimitEnabled),
    render_last_n: Math.max(
      0,
      Math.trunc(Number(sourceSettings.hideOldMessagesRenderLimit ?? 0) || 0),
    ),
  };
}

/**
 * Applies the render limit to the host (power_user.chat_truncation + jQuery
 * truncation inputs), optionally reloading the chat.
 *
 * @param {object|null} settings
 * @param {object} [options] {clearWhenDisabled, reloadCurrentChat}
 * @param {object} [host] injected host adapter
 * @param {() => object|null} [host.getPowerUser]
 * @param {(selector: string) => any} [host.jq] jQuery-like selector
 * @param {() => void} [host.reloadCurrentChat]
 * @param {() => object|null} [host.resolveSettings]
 * @param {Console} [host.console]
 */
export function applyMessageRenderLimit(settings = null, options = {}, host = {}) {
  const logger = host.console || console;
  const normalized = getMessageRenderLimitSettings(settings, host.resolveSettings);
  const shouldClear = options.clearWhenDisabled === true;
  if (!normalized.enabled && !shouldClear) {
    return {
      active: false,
      renderLimit: 0,
      applied: false,
      skipped: true,
    };
  }

  const renderLimit =
    normalized.enabled && normalized.render_last_n > 0
      ? normalized.render_last_n
      : 0;
  let applied = false;
  const powerUserSettings =
    typeof host.getPowerUser === "function" ? host.getPowerUser() : null;
  if (powerUserSettings && typeof powerUserSettings === "object") {
    powerUserSettings.chat_truncation = renderLimit;
    applied = true;
  }

  try {
    const jq = typeof host.jq === "function" ? host.jq : null;
    if (jq) {
      const value = String(renderLimit);
      const truncationInput = jq("#chat_truncation");
      if (
        truncationInput &&
        Number(truncationInput.length || 0) > 0 &&
        typeof truncationInput.val === "function"
      ) {
        truncationInput.val(value);
        if (typeof truncationInput.trigger === "function") {
          truncationInput.trigger("change");
        }
        applied = true;
      }
      const truncationCounter = jq("#chat_truncation_counter");
      if (
        truncationCounter &&
        Number(truncationCounter.length || 0) > 0 &&
        typeof truncationCounter.val === "function"
      ) {
        truncationCounter.val(value);
        applied = true;
      }
    }
  } catch (error) {
    logger.warn("[ST-BME] 同步聊天区渲染楼层限制失败:", error);
  }

  if (options.reloadCurrentChat === true) {
    try {
      if (typeof host.reloadCurrentChat === "function") {
        host.reloadCurrentChat();
      }
    } catch (error) {
      logger.warn("[ST-BME] 重新加载聊天区渲染楼层失败:", error);
    }
  }

  return {
    active: renderLimit > 0,
    renderLimit,
    applied,
    skipped: false,
  };
}

/**
 * Returns the effective render limit used for the history-recovery guard,
 * combining configured settings with the host power_user truncation.
 */
export function getActiveMessageRenderLimitForHistoryGuard(
  settings = null,
  host = {},
) {
  const normalized = getMessageRenderLimitSettings(settings, host.resolveSettings);
  const configuredLimit =
    normalized.enabled && normalized.render_last_n > 0
      ? normalized.render_last_n
      : 0;
  let hostLimit = 0;
  try {
    const powerUserSettings =
      typeof host.getPowerUser === "function" ? host.getPowerUser() : null;
    hostLimit = Math.max(
      0,
      Math.trunc(Number(powerUserSettings?.chat_truncation ?? 0) || 0),
    );
  } catch {
    hostLimit = 0;
  }

  if (configuredLimit > 0 && hostLimit > 0) {
    return Math.min(configuredLimit, hostLimit);
  }
  return Math.max(configuredLimit, hostLimit);
}

/** Highest floor index tracked in processed-history state. Pure. */
export function getHighestTrackedProcessedHistoryFloor(historyState = {}) {
  const lastProcessed = Number.isFinite(
    Number(historyState?.lastProcessedAssistantFloor),
  )
    ? Math.floor(Number(historyState.lastProcessedAssistantFloor))
    : -1;
  const hashes =
    historyState?.processedMessageHashes &&
    typeof historyState.processedMessageHashes === "object" &&
    !Array.isArray(historyState.processedMessageHashes)
      ? historyState.processedMessageHashes
      : {};
  const maxHashFloor = Object.keys(hashes).reduce((maxFloor, key) => {
    const floor = Number.parseInt(key, 10);
    return Number.isFinite(floor) ? Math.max(maxFloor, floor) : maxFloor;
  }, -1);

  return Math.max(lastProcessed, maxHashFloor);
}

/**
 * Decides whether history recovery must be blocked because the chat view is
 * render-limited (a truncated view must not be mistaken for deleted history).
 *
 * @param {Array} chat
 * @param {object} [opts] {settings, historyState, host}
 */
export function getRenderLimitedHistoryRecoveryGuard(
  chat,
  { settings = null, historyState = {}, host = {} } = {},
) {
  const renderLimit = getActiveMessageRenderLimitForHistoryGuard(settings, host);
  if (!Array.isArray(chat) || renderLimit <= 0) {
    return { blocked: false };
  }

  const chatLength = chat.length;
  const highestProcessedFloor =
    getHighestTrackedProcessedHistoryFloor(historyState);
  const renderWindowTolerance = renderLimit + 1;
  if (chatLength > renderWindowTolerance || highestProcessedFloor < chatLength) {
    return { blocked: false };
  }

  return {
    blocked: true,
    chatLength,
    highestProcessedFloor,
    renderLimit,
    reason: "render-limited-chat-slice",
    message:
      `当前聊天区最多只渲染最近 ${renderLimit} 条消息，当前可见 ${chatLength} 条；` +
      `图谱已处理到楼层 ${highestProcessedFloor}。为避免把截断视图误判为历史删除并清空运行时图谱，已暂停历史恢复。` +
      "请临时关闭“限制聊天区渲染楼层”或调大渲染数量并刷新后再提取。",
  };
}
