import {
  hashPlannerPlotInput,
  readStructuredPlotRecordFromMessage,
} from "../ena-planner/planner-plot-history.js";
import { t } from "../i18n/index.js";

export function createRecallMessageUiController(deps = {}) {
  let persistedRecallUiRefreshTimer = null;
  let persistedRecallUiRefreshObserver = null;
  let persistedRecallUiRefreshSession = 0;
  const persistedRecallUiDiagnosticTimestamps = new Map();
  const persistedRecallPersistDiagnosticTimestamps = new Map();
  const readPlotRecordFromMessage =
    deps.readStructuredPlotRecordFromMessage || readStructuredPlotRecordFromMessage;

  function hasPlotRecordContent(plotRecord) {
    if (!plotRecord || typeof plotRecord !== "object") return false;
    if (String(plotRecord.plotText || "").trim()) return true;
    return Array.isArray(plotRecord.plotBlocks) && plotRecord.plotBlocks.some((item) => String(item || "").trim());
  }

  const getContextValue = () => deps.getContext?.() || null;
  const getSettingsValue = () => deps.getSettings?.() || {};
  const getCurrentGraphValue = () => deps.getCurrentGraph?.() || null;
  const getDocument = () => deps.document || globalThis.document;
  const getMutationObserver = () => deps.MutationObserver || globalThis.MutationObserver;
  const getToastr = () => deps.toastr || {};
  const getConsole = () => deps.console || console;
  const getSetTimeout = () => deps.setTimeout || setTimeout;
  const getClearTimeout = () => deps.clearTimeout || clearTimeout;
  const getRefreshRetryDelays = () =>
    Array.isArray(deps.PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS)
      ? deps.PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS
      : [0, 80, 180, 320, 500, 850, 1300, 2000, 3000, 4200];
  const getDiagnosticThrottleMs = () =>
    Number.isFinite(Number(deps.PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS))
      ? Number(deps.PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS)
      : 1500;

function getMessageRecallRecord(messageIndex) {
  const chat = getContextValue()?.chat;
  return deps.readPersistedRecallFromUserMessage(chat, messageIndex);
}

function debugWithThrottle(cache, key, ...args) {
  if (!globalThis.__stBmeDebugLoggingEnabled) return;
  const now = Date.now();
  const lastAt = cache.get(key) || 0;
  if (now - lastAt < getDiagnosticThrottleMs()) return;
  cache.set(key, now);
  getConsole().debug(...args);
}

function debugPersistedRecallUi(reason, details = null, throttleKey = reason) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    persistedRecallUiDiagnosticTimestamps,
    `ui:${throttleKey}`,
    `[ST-BME] Recall Card UI: ${reason}${suffix}`,
  );
}

function removeMessageRecallRecord(messageIndex) {
  const chat = getContextValue()?.chat;
  if (!Array.isArray(chat)) return false;
  const removed = deps.removePersistedRecallFromUserMessage(chat, messageIndex);
  if (removed) {
    deps.triggerChatMetadataSave(getContextValue(), { immediate: false });
  }
  return removed;
}

function removePlotRecordFromUserMessage(messageIndex) {
  const chat = getContextValue()?.chat;
  if (!Array.isArray(chat)) return false;
  const message = chat[messageIndex];
  if (!message || !message.extra || typeof message.extra !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(message.extra, "st_bme_plot")) {
    return false;
  }
  delete message.extra.st_bme_plot;
  deps.triggerChatMetadataSave(getContextValue(), { immediate: false });
  return true;
}

function editMessageRecallRecord(messageIndex, nextInjectionText) {
  const chat = getContextValue()?.chat;
  if (!Array.isArray(chat)) return null;
  const current = deps.readPersistedRecallFromUserMessage(chat, messageIndex);
  if (!current) return null;

  const normalizedText = deps.normalizeRecallInputText(nextInjectionText);
  if (!normalizedText) return null;
  const nowIso = new Date().toISOString();
  const nextRecord = {
    ...current,
    injectionText: normalizedText,
    tokenEstimate: deps.estimateTokens(normalizedText),
    updatedAt: nowIso,
  };
  if (!deps.writePersistedRecallToUserMessage(chat, messageIndex, nextRecord)) {
    return null;
  }
  const edited = deps.markPersistedRecallManualEdit(
    chat,
    messageIndex,
    true,
    nowIso,
  );
  if (!edited) return null;

  deps.triggerChatMetadataSave(getContextValue(), { immediate: false });
  return edited;
}

function syncEditedUserMessageDom(messageIndex, nextText) {
  const chatRoot = getDocument()?.getElementById?.("chat");
  if (!chatRoot?.querySelectorAll) return false;

  for (const messageElement of Array.from(chatRoot.querySelectorAll(".mes") || [])) {
    if (resolveMessageIndexFromElement(messageElement) !== messageIndex) continue;
    const userTextElement = messageElement.querySelector?.(".mes_text");
    if (!userTextElement) return false;
    userTextElement.textContent = String(nextText || "");
    return true;
  }
  return false;
}

function persistEditedUserMessage(context = getContextValue()) {
  const candidates = [
    ["saveChatConditional", context?.saveChatConditional],
    ["saveChat", context?.saveChat],
  ];

  for (const [label, handler] of candidates) {
    if (typeof handler !== "function") continue;
    try {
      const result = handler.call(context);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          getConsole().error(`[ST-BME] 保存用户输入编辑失败 (${label}):`, error);
        });
      }
      return label;
    } catch (error) {
      getConsole().error(`[ST-BME] 调用 ${label} 保存用户输入编辑失败:`, error);
    }
  }

  return deps.triggerChatMetadataSave(context, { immediate: true });
}

function editMessageUserInputText(messageIndex, nextUserInputText) {
  const context = getContextValue();
  const chat = context?.chat;
  if (!Array.isArray(chat)) {
    return { ok: false, error: "missing-chat" };
  }

  const message = chat[messageIndex];
  if (!message?.is_user) {
    return { ok: false, error: "not-user-message" };
  }

  const normalizedText = deps.normalizeRecallInputText(nextUserInputText);
  if (!normalizedText) {
    return { ok: false, error: "empty-user-input" };
  }

  const previousText = deps.normalizeRecallInputText(message.mes || "");
  const currentRecord = deps.readPersistedRecallFromUserMessage(chat, messageIndex);
  const recallBoundText = deps.normalizeRecallInputText(
    currentRecord?.boundUserFloorText || previousText,
  );
  const recallMayBeStale = Boolean(currentRecord) && recallBoundText !== normalizedText;

  message.mes = normalizedText;
  const swipeIndex = Number.isFinite(Number(message?.swipe_id))
    ? Math.max(0, Math.floor(Number(message.swipe_id)))
    : null;
  if (
    Array.isArray(message?.swipes) &&
    swipeIndex !== null &&
    swipeIndex < message.swipes.length
  ) {
    message.swipes[swipeIndex] = normalizedText;
  }

  if (message.extra && typeof message.extra === "object") {
    if (typeof message.extra.display_text === "string") {
      message.extra.display_text = normalizedText;
    }
    if (typeof message.extra.current_display_text === "string") {
      message.extra.current_display_text = normalizedText;
    }
    const plotRecord = message.extra.st_bme_plot;
    if (plotRecord && typeof plotRecord === "object") {
      plotRecord.rawUserInput = normalizedText;
      plotRecord.inputHash = hashPlannerPlotInput(normalizedText);
      plotRecord.userInputEditedAt = Date.now();
    }
    const persistedRecall = message.extra.bme_recall;
    if (persistedRecall && typeof persistedRecall === "object") {
      persistedRecall.recallInput = normalizedText;
      persistedRecall.userInputEditedAt = Date.now();
      if (recallMayBeStale) {
        persistedRecall.recallMayBeStale = true;
      }
    }
  }

  const saveMode = persistEditedUserMessage(context);
  const domSynced = syncEditedUserMessageDom(messageIndex, normalizedText);

  return {
    ok: true,
    nextText: normalizedText,
    recallMayBeStale,
    unchanged: previousText === normalizedText,
    saveMode,
    domSynced,
  };
}

function clearPersistedRecallMessageUiObserver() {
  try {
    persistedRecallUiRefreshObserver?.disconnect?.();
  } catch (error) {
    getConsole().warn("[ST-BME] Recall Card UI observer disconnect 失败:", error);
  }
  persistedRecallUiRefreshObserver = null;
}

function isDomNodeAttached(node) {
  if (!node) return false;
  if (node.isConnected === true) return true;
  return typeof getDocument()?.contains === "function"
    ? getDocument().contains(node)
    : true;
}

function cleanupRecallCardElement(cardElement) {
  if (!cardElement) return;
  const messageElement = cardElement.closest?.(".mes") || null;
  if (messageElement) {
    restoreRecallCardUserInputDisplay(messageElement);
  }
  try {
    cardElement._bmeDestroyRenderer?.();
  } catch (error) {
    getConsole().warn("[ST-BME] Recall Card renderer 清理失败:", error);
  }
  cardElement.remove?.();
}

function cleanupLegacyRecallBadges(messageElement) {
  if (!messageElement?.querySelectorAll) return;
  const oldBadges = Array.from(
    messageElement.querySelectorAll(".st-bme-recall-badge") || [],
  );
  for (const oldBadge of oldBadges) oldBadge.remove();
}

function cleanupRecallArtifacts(messageElement, keepMessageIndex = null) {
  if (!messageElement?.querySelectorAll) return;

  cleanupLegacyRecallBadges(messageElement);
  restoreRecallCardUserInputDisplay(messageElement);

  const existingCards = Array.from(
    messageElement.querySelectorAll(".bme-recall-card") || [],
  );
  for (const card of existingCards) {
    if (
      keepMessageIndex !== null &&
      card.dataset?.messageIndex === String(keepMessageIndex)
    ) {
      continue;
    }
    cleanupRecallCardElement(card);
  }
}

function parseStableMessageIndex(candidate) {
  const normalized = String(candidate ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveMessageIndexFromElement(messageElement) {
  if (!messageElement) return null;

  const candidates = [
    messageElement.getAttribute?.("mesid"),
    messageElement.getAttribute?.("data-mesid"),
    messageElement.getAttribute?.("data-message-id"),
    messageElement.dataset?.mesid,
    messageElement.dataset?.messageId,
  ];

  for (const candidate of candidates) {
    const parsed = parseStableMessageIndex(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

function resolveRecallCardAnchor(messageElement) {
  if (!messageElement || !isDomNodeAttached(messageElement)) return null;
  const mesBlock = messageElement.querySelector?.(".mes_block");
  if (isDomNodeAttached(mesBlock)) return mesBlock;

  const mesTextParent =
    messageElement.querySelector?.(".mes_text")?.parentElement;
  if (isDomNodeAttached(mesTextParent)) return mesTextParent;

  return isDomNodeAttached(messageElement) ? messageElement : null;
}

function getRecallMessageElementPriority(messageElement) {
  if (!messageElement || !isDomNodeAttached(messageElement)) return -1;

  let priority = 0;
  const anchor = resolveRecallCardAnchor(messageElement);
  if (anchor === messageElement) priority += 1;
  else if (anchor) priority += 3;

  if (messageElement.querySelector?.(".mes_text")) priority += 1;
  if (messageElement.classList?.contains("last_mes")) priority += 2;
  if (
    messageElement.getAttribute?.("is_user") === "true" ||
    messageElement.dataset?.isUser === "true" ||
    messageElement.classList?.contains("user_mes")
  ) {
    priority += 1;
  }

  return priority;
}

function normalizeRecallCardUserInputDisplayMode(mode) {
  const normalized = String(mode || "").trim();
  if (
    normalized === "off" ||
    normalized === "beautify_only" ||
    normalized === "mirror"
  ) {
    return normalized;
  }
  return "beautify_only";
}

function applyRecallCardUserInputDisplayMode(messageElement, mode) {
  if (!messageElement?.querySelector) return;
  const userTextElement = messageElement.querySelector(".mes_text");
  if (!userTextElement) return;
  userTextElement.classList.toggle(
    "bme-hide-original-user-text",
    normalizeRecallCardUserInputDisplayMode(mode) === "beautify_only",
  );
}

function restoreRecallCardUserInputDisplay(messageElement) {
  if (!messageElement?.querySelector) return;
  const userTextElement = messageElement.querySelector(".mes_text");
  userTextElement?.classList?.remove("bme-hide-original-user-text");
}

function buildPersistedRecallUiRetryDelays(initialDelayMs = 0) {
  const normalizedInitial = Math.max(
    0,
    Number.parseInt(initialDelayMs, 10) || 0,
  );
  if (!normalizedInitial)
    return [...getRefreshRetryDelays()];
  return [
    normalizedInitial,
    ...getRefreshRetryDelays().filter(
      (delay) => delay > normalizedInitial,
    ),
  ];
}

function summarizePersistedRecallRefreshStatus(summary) {
  if (summary.waitingMessageIndices.length > 0) return "waiting_dom";
  if (summary.anchorFailureIndices.length > 0) return "missing_message_anchor";
  if (summary.renderedCount > 0) return "rendered";
  if (summary.skippedNonUserIndices.length > 0) return "skipped_non_user";
  if (summary.persistedRecordCount === 0) return "missing_recall_record";
  return "missing_message_anchor";
}

function refreshPersistedRecallMessageUi() {
  const context = getContextValue();
  const chat = context?.chat;
  if (!Array.isArray(chat) || typeof getDocument()?.getElementById !== "function") {
    return {
      status: "missing_chat_root",
      renderedCount: 0,
      persistedRecordCount: 0,
      waitingMessageIndices: [],
      anchorFailureIndices: [],
      skippedNonUserIndices: [],
    };
  }

  const chatRoot = getDocument().getElementById("chat");
  if (!chatRoot) {
    debugPersistedRecallUi("缺少 #chat 根节点");
    return {
      status: "missing_chat_root",
      renderedCount: 0,
      persistedRecordCount: 0,
      waitingMessageIndices: [],
      anchorFailureIndices: [],
      skippedNonUserIndices: [],
    };
  }

  const settings = getSettingsValue();
  const themeName = settings?.panelTheme || "crimson";
  const recallCardUserInputDisplayMode =
    normalizeRecallCardUserInputDisplayMode(
      settings?.recallCardUserInputDisplayMode,
    );
  const callbacks = getRecallCardCallbacks();
  const messageElementMap = new Map();
  const messageElements = Array.from(chatRoot.querySelectorAll(".mes"));
  for (const messageElement of messageElements) {
    cleanupLegacyRecallBadges(messageElement);
    const messageIndex = resolveMessageIndexFromElement(messageElement);
    if (!Number.isFinite(messageIndex)) {
      debugPersistedRecallUi(
        "消息 DOM 缺少稳定索引属性，跳过挂载",
        {
          className: messageElement.className || "",
        },
        "missing-stable-message-index",
      );
      continue;
    }
    if (messageElementMap.has(messageIndex)) {
      const previousElement = messageElementMap.get(messageIndex) || null;
      const previousPriority = getRecallMessageElementPriority(previousElement);
      const nextPriority = getRecallMessageElementPriority(messageElement);
      const shouldReplace = nextPriority >= previousPriority;
      debugPersistedRecallUi(
        "检测到重复消息 DOM 索引，已挑选更可靠的锚点",
        {
          messageIndex,
          previousPriority,
          nextPriority,
          replaced: shouldReplace,
        },
        `duplicate-message-index:${messageIndex}`,
      );
      if (shouldReplace) {
        cleanupRecallArtifacts(previousElement);
        messageElementMap.set(messageIndex, messageElement);
      } else {
        cleanupRecallArtifacts(messageElement);
      }
      continue;
    }
    messageElementMap.set(messageIndex, messageElement);
  }

  const summary = {
    status: "missing_recall_record",
    renderedCount: 0,
    persistedRecordCount: 0,
    waitingMessageIndices: [],
    anchorFailureIndices: [],
    skippedNonUserIndices: [],
  };

  for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
    const message = chat[messageIndex];
    const messageElement = messageElementMap.get(messageIndex) || null;
    const existingCard =
      messageElement?.querySelector?.(
        `.bme-recall-card[data-message-index="${messageIndex}"]`,
      ) || null;

    if (!message?.is_user) {
      if (messageElement) {
        restoreRecallCardUserInputDisplay(messageElement);
      }
      if (existingCard) cleanupRecallCardElement(existingCard);
      const unexpectedRecord = deps.readPersistedRecallFromUserMessage(
        chat,
        messageIndex,
      );
      if (unexpectedRecord) {
        summary.skippedNonUserIndices.push(messageIndex);
        debugPersistedRecallUi(
          "非 user 楼层存在持久召回记录，已跳过挂载",
          {
            messageIndex,
          },
          `skipped-non-user:${messageIndex}`,
        );
      }
      continue;
    }

    const record = deps.readPersistedRecallFromUserMessage(chat, messageIndex);
    const plotRecord = readPlotRecordFromMessage(message);
    const hasRecall = Boolean(record?.injectionText);
    const hasPlot = hasPlotRecordContent(plotRecord);
    if (!hasRecall && !hasPlot) {
      if (messageElement) {
        restoreRecallCardUserInputDisplay(messageElement);
      }
      if (existingCard) cleanupRecallCardElement(existingCard);
      continue;
    }

    summary.persistedRecordCount += hasRecall ? 1 : 0;
    if (!messageElement) {
      summary.waitingMessageIndices.push(messageIndex);
      debugPersistedRecallUi(
        "目标 user 楼层 DOM 未就绪，等待后续刷新",
        {
          messageIndex,
        },
        `waiting-dom:${messageIndex}`,
      );
      continue;
    }

    const anchor = resolveRecallCardAnchor(messageElement);
    if (!anchor) {
      restoreRecallCardUserInputDisplay(messageElement);
      cleanupRecallCardElement(existingCard);
      summary.anchorFailureIndices.push(messageIndex);
      debugPersistedRecallUi(
        "目标 user 楼层锚点解析失败，跳过挂载",
        {
          messageIndex,
        },
        `missing-anchor:${messageIndex}`,
      );
      continue;
    }

    cleanupRecallArtifacts(messageElement, messageIndex);
    const currentCard =
      messageElement.querySelector?.(
        `.bme-recall-card[data-message-index="${messageIndex}"]`,
      ) || null;

    const displayUserMessageText = String(
      plotRecord?.rawUserInput || record?.recallInput || message.mes || "",
    );
    const cardCallbacks = {
      ...callbacks,
      estimateTokens: deps.estimateTokens,
    };
    let shouldCreateCard = !currentCard;
    if (currentCard) {
      const updated = deps.updateRecallCardData(currentCard, record || {}, {
        plotRecord,
        userMessageText: displayUserMessageText,
        userInputDisplayMode: recallCardUserInputDisplayMode,
        graph: getCurrentGraphValue(),
        themeName,
        callbacks: cardCallbacks,
      });
      if (updated === false) {
        cleanupRecallCardElement(currentCard);
        shouldCreateCard = true;
      }
    }

    if (shouldCreateCard) {
      const card = deps.createRecallCardElement({
        messageIndex,
        record: record || {},
        plotRecord,
        userMessageText: displayUserMessageText,
        userInputDisplayMode: recallCardUserInputDisplayMode,
        graph: getCurrentGraphValue(),
        themeName,
        callbacks: cardCallbacks,
      });
      anchor.appendChild(card);
    }
    applyRecallCardUserInputDisplayMode(
      messageElement,
      recallCardUserInputDisplayMode,
    );
    summary.renderedCount += 1;
  }

  summary.status = summarizePersistedRecallRefreshStatus(summary);
  if (summary.status === "missing_recall_record") {
    debugPersistedRecallUi("当前无有效持久召回记录可渲染");
  } else if (summary.renderedCount > 0) {
    debugPersistedRecallUi(
      "Recall Card 挂载完成",
      {
        renderedCount: summary.renderedCount,
        persistedRecordCount: summary.persistedRecordCount,
        waitingDom: summary.waitingMessageIndices.length,
      },
      `rendered:${summary.renderedCount}`,
    );
  }
  return summary;
}

function getRecallCardCallbacks() {
  return {
    onEdit: (messageIndex) => {
      const record = getMessageRecallRecord(messageIndex);
      if (!record) return;
      deps.openRecallSidebar({
        mode: "edit",
        messageIndex,
        record,
        node: null,
        graph: getCurrentGraphValue(),
        callbacks: {
          onSave: (idx, newText) => {
            const edited = editMessageRecallRecord(idx, newText);
            if (edited) {
              getToastr().success("已保存手动编辑");
            } else {
              getToastr().warning("编辑失败：注入文本不能为空");
            }
            schedulePersistedRecallMessageUiRefresh();
          },
          estimateTokens: deps.estimateTokens,
        },
      });
    },
    onEditUserInput: (messageIndex, nextUserInputText) => {
      const result = editMessageUserInputText(messageIndex, nextUserInputText);
      if (!result?.ok) {
        getToastr().warning("编辑失败：内容不能为空或此楼层非用户消息");
        return result;
      }

      if (result.unchanged) {
        getToastr().info("用户输入未变化");
      } else {
        getToastr().success("已更新本轮用户输入");
      }
      if (result.recallMayBeStale) {
        getToastr().info("输入已改，当前召回结果可能需要重新召回");
      }
      schedulePersistedRecallMessageUiRefresh();
      return result;
    },
    onDelete: (messageIndex) => {
      if (removeMessageRecallRecord(messageIndex)) {
        getToastr().success("已删除持久召回注入");
        schedulePersistedRecallMessageUiRefresh();
      }
    },
    onRemovePlannerPlot: (messageIndex) => {
      if (removePlotRecordFromUserMessage(messageIndex)) {
        getToastr().success(t("recall.card.removedPlot"));
        schedulePersistedRecallMessageUiRefresh();
      }
    },
    onRerunRecall: async (messageIndex) => {
      const result = await deps.rerunRecallForMessage(messageIndex);
      if (result?.status === "completed") {
        getToastr().success("重新召回完成");
      }
      schedulePersistedRecallMessageUiRefresh();
    },
    onNodeClick: (messageIndex, node) => {
      const record = getMessageRecallRecord(messageIndex);
      if (!record) return;
      deps.openRecallSidebar({
        mode: "view",
        messageIndex,
        record,
        node,
        graph: getCurrentGraphValue(),
        callbacks: {
          onSave: (idx, newText) => {
            const edited = editMessageRecallRecord(idx, newText);
            if (edited) getToastr().success("已保存手动编辑");
            else getToastr().warning("编辑失败：注入文本不能为空");
            schedulePersistedRecallMessageUiRefresh();
          },
          estimateTokens: deps.estimateTokens,
        },
      });
    },
  };
}

function armPersistedRecallMessageUiObserver(sessionId, runAttempt) {
  clearPersistedRecallMessageUiObserver();
  const chatRoot = getDocument()?.getElementById?.("chat");
  const ObserverCtor = getMutationObserver();
  if (!chatRoot || typeof ObserverCtor !== "function") return false;

  persistedRecallUiRefreshObserver = new ObserverCtor(() => {
    if (sessionId !== persistedRecallUiRefreshSession) return;
    clearPersistedRecallMessageUiObserver();
    runAttempt();
  });
  persistedRecallUiRefreshObserver.observe(chatRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "mesid",
      "data-mesid",
      "data-message-id",
      "class",
      "is_user",
    ],
  });
  return true;
}

function schedulePersistedRecallMessageUiRefresh(delayMs = 0) {
  getClearTimeout()(persistedRecallUiRefreshTimer);
  clearPersistedRecallMessageUiObserver();

  const retryDelays = buildPersistedRecallUiRetryDelays(delayMs);
  const sessionId = ++persistedRecallUiRefreshSession;
  let attemptIndex = 0;

  const runAttempt = () => {
    if (sessionId !== persistedRecallUiRefreshSession) return;
    if (persistedRecallUiRefreshTimer) {
      getClearTimeout()(persistedRecallUiRefreshTimer);
      persistedRecallUiRefreshTimer = null;
    }

    const summary = refreshPersistedRecallMessageUi();

    const shouldRetryForPending =
      (summary.status === "missing_chat_root" ||
        summary.status === "waiting_dom" ||
        summary.status === "missing_message_anchor") &&
      attemptIndex < retryDelays.length - 1;

    // 勿在「已成功渲染」时长期监听 MutationObserver：chat 的 class/流式更新会疯狂触发
    // runAttempt，造成满屏刷新与日志；显式事件（USER_MESSAGE_RENDERED 等）仍会 schedule 刷新。
    const shouldWatchForRepaint = false;

    if (!shouldRetryForPending && !shouldWatchForRepaint) {
      clearPersistedRecallMessageUiObserver();
      return;
    }

    armPersistedRecallMessageUiObserver(sessionId, runAttempt);
    if (shouldRetryForPending) {
      attemptIndex += 1;
      persistedRecallUiRefreshTimer = getSetTimeout()(
        runAttempt,
        retryDelays[attemptIndex],
      );
      return;
    }

    const lingerMs = retryDelays[retryDelays.length - 1] || 0;
    if (lingerMs <= 0) {
      clearPersistedRecallMessageUiObserver();
      return;
    }
    persistedRecallUiRefreshTimer = getSetTimeout()(() => {
      if (sessionId !== persistedRecallUiRefreshSession) return;
      clearPersistedRecallMessageUiObserver();
      persistedRecallUiRefreshTimer = null;
    }, lingerMs);
  };

  persistedRecallUiRefreshTimer = getSetTimeout()(
    runAttempt,
    retryDelays[attemptIndex],
  );
}

function cleanupPersistedRecallMessageUi() {
  getClearTimeout()(persistedRecallUiRefreshTimer);
  persistedRecallUiRefreshTimer = null;
  clearPersistedRecallMessageUiObserver();
  const chatRoot = getDocument().getElementById("chat");
  if (!chatRoot?.querySelectorAll) return;
  for (const messageElement of Array.from(chatRoot.querySelectorAll(".mes"))) {
    cleanupRecallArtifacts(messageElement);
  }
}

  return {
    refreshPersistedRecallMessageUi,
    schedulePersistedRecallMessageUiRefresh,
    cleanupPersistedRecallMessageUi,
    resolveMessageIndexFromElement,
    resolveRecallCardAnchor,
  };
}
