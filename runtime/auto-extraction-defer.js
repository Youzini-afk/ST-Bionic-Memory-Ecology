export function createAutoExtractionDefer(deps = {}) {
  let pendingAutoExtractionTimer = null;
  let pendingAutoExtraction = {
    chatId: "",
    messageId: null,
    reason: "",
    requestedAt: 0,
    attempts: 0,
    targetEndFloor: null,
    strategy: "normal",
  };

  const normalizeChatIdCandidate = (value = "") =>
    deps.normalizeChatIdCandidate?.(value) ?? String(value ?? "").trim();
  const getCurrentChatId = (...args) => deps.getCurrentChatId?.(...args);
  const getContext = (...args) => deps.getContext?.(...args);
  const getSettings = (...args) => deps.getSettings?.(...args);
  const clearTimeoutImpl = deps.clearTimeout || globalThis.clearTimeout;
  const setTimeoutImpl = deps.setTimeout || globalThis.setTimeout;
  const consoleImpl = deps.console || console;
  const deferRetryDelays = Array.isArray(deps.AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS)
    ? deps.AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS
    : [120, 320, 800, 1600, 2800];
  const hostSettleMs = Number.isFinite(Number(deps.AUTO_EXTRACTION_HOST_SETTLE_MS))
    ? Number(deps.AUTO_EXTRACTION_HOST_SETTLE_MS)
    : 120;

  function getPendingAutoExtraction() {
    return { ...pendingAutoExtraction };
  }

  function clearPendingAutoExtraction({ resetState = true } = {}) {
    if (pendingAutoExtractionTimer) {
      clearTimeoutImpl(pendingAutoExtractionTimer);
      pendingAutoExtractionTimer = null;
    }

    if (resetState) {
      pendingAutoExtraction = {
        chatId: "",
        messageId: null,
        reason: "",
        requestedAt: 0,
        attempts: 0,
        targetEndFloor: null,
        strategy: "normal",
      };
    }
  }

  function deferAutoExtraction(
    reason = "auto-extraction-deferred",
    {
      chatId = getCurrentChatId(),
      messageId = null,
      delayMs = null,
      targetEndFloor = null,
      strategy = "",
    } = {},
  ) {
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId) {
      clearPendingAutoExtraction();
      return {
        scheduled: false,
        reason: "missing-chat-id",
        chatId: "",
      };
    }

    const sameChat = normalizedChatId === pendingAutoExtraction.chatId;
    const previousAttempts = sameChat
      ? Math.max(0, Math.floor(Number(pendingAutoExtraction.attempts) || 0))
      : 0;
    const nextAttempts = previousAttempts + 1;
    const resolvedDelayMs =
      delayMs !== null &&
      delayMs !== undefined &&
      Number.isFinite(Number(delayMs))
      ? Math.max(0, Math.floor(Number(delayMs)))
      : deferRetryDelays[
          Math.min(
            previousAttempts,
            deferRetryDelays.length - 1,
          )
        ];

    pendingAutoExtraction = {
      chatId: normalizedChatId,
      messageId: Number.isFinite(Number(messageId))
        ? Math.floor(Number(messageId))
        : sameChat
          ? pendingAutoExtraction.messageId
          : null,
      reason: String(reason || "auto-extraction-deferred"),
      requestedAt:
        sameChat && pendingAutoExtraction.requestedAt > 0
          ? pendingAutoExtraction.requestedAt
          : Date.now(),
      attempts: nextAttempts,
      targetEndFloor: Number.isFinite(Number(targetEndFloor))
        ? sameChat &&
          Number.isFinite(Number(pendingAutoExtraction.targetEndFloor))
          ? Math.max(
              Math.floor(Number(targetEndFloor)),
              Math.floor(Number(pendingAutoExtraction.targetEndFloor)),
            )
          : Math.floor(Number(targetEndFloor))
        : sameChat
          ? pendingAutoExtraction.targetEndFloor
          : null,
      strategy: String(strategy || "")
        ? String(strategy || "")
        : sameChat
          ? String(pendingAutoExtraction.strategy || "normal")
          : "normal",
    };

    if (pendingAutoExtractionTimer) {
      clearTimeoutImpl(pendingAutoExtractionTimer);
    }

    pendingAutoExtractionTimer = setTimeoutImpl(() => {
      pendingAutoExtractionTimer = null;
      void maybeResumePendingAutoExtraction(
        `retry:${pendingAutoExtraction.reason || "auto-extraction-deferred"}`,
      );
    }, resolvedDelayMs);
    consoleImpl.debug?.("[ST-BME] auto extraction deferred", {
      reason: pendingAutoExtraction.reason,
      chatId: normalizedChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
      attempts: nextAttempts,
      delayMs: resolvedDelayMs,
    });

    return {
      scheduled: true,
      chatId: normalizedChatId,
      messageId: pendingAutoExtraction.messageId,
      reason: pendingAutoExtraction.reason,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
      attempts: nextAttempts,
      delayMs: resolvedDelayMs,
    };
  }

  function maybeResumePendingAutoExtraction(source = "auto-extraction-resume") {
    const pendingChatId = normalizeChatIdCandidate(pendingAutoExtraction.chatId);
    if (!pendingChatId) {
      return {
        resumed: false,
        reason: "no-pending-auto-extraction",
      };
    }

    if (deps.isRestoreLockActive()) {
      return {
        resumed: false,
        reason: "restore-lock-active",
        restoreLock: deps.cloneRuntimeDebugValue(
          deps.normalizeRestoreLockState(deps.getGraphPersistenceState?.()?.restoreLock),
          null,
        ),
      };
    }

    const currentChatId = normalizeChatIdCandidate(getCurrentChatId());
    if (!currentChatId || currentChatId !== pendingChatId) {
      clearPendingAutoExtraction();
      return {
        resumed: false,
        reason: "chat-switched",
        chatId: pendingChatId,
        currentChatId,
      };
    }

    if (deps.getIsExtracting?.()) {
      return deferAutoExtraction("extracting", {
        chatId: pendingChatId,
        messageId: pendingAutoExtraction.messageId,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }

    if (deps.getIsHostGenerationRunning?.()) {
      return deferAutoExtraction("generation-running", {
        chatId: pendingChatId,
        messageId: pendingAutoExtraction.messageId,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }

    const lastHostGenerationEndedAt = Number(deps.getLastHostGenerationEndedAt?.() || 0);
    const hostGenerationSettleRemainingMs =
      lastHostGenerationEndedAt > 0
        ? hostSettleMs -
          (Date.now() - lastHostGenerationEndedAt)
        : 0;
    if (hostGenerationSettleRemainingMs > 0) {
      return deferAutoExtraction("generation-settling", {
        chatId: pendingChatId,
        messageId: pendingAutoExtraction.messageId,
        delayMs: hostGenerationSettleRemainingMs,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }

    if (deps.getIsRecoveringHistory?.()) {
      return deferAutoExtraction("history-recovering", {
        chatId: pendingChatId,
        messageId: pendingAutoExtraction.messageId,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }

    if (!deps.ensureGraphMutationReady("自动提取", { notify: false })) {
      consoleImpl.debug?.(
        "[ST-BME] pending auto extraction resume blocked: graph-not-ready",
        {
          source,
          chatId: pendingChatId,
          attempts: pendingAutoExtraction.attempts || 0,
          loadState: deps.getGraphPersistenceState?.()?.loadState || "",
        },
      );
      return deferAutoExtraction("graph-not-ready", {
        chatId: pendingChatId,
        messageId: pendingAutoExtraction.messageId,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }

    const resumeContext = getContext();
    const resumeChat = resumeContext?.chat;
    const settings = getSettings();
    let lockedEndFloor = Number.isFinite(Number(pendingAutoExtraction.targetEndFloor))
      ? Math.floor(Number(pendingAutoExtraction.targetEndFloor))
      : null;
    if (
      Array.isArray(resumeChat) &&
      Number.isFinite(Number(pendingAutoExtraction.messageId))
    ) {
      const pendingMessageIndex = Math.floor(
        Number(pendingAutoExtraction.messageId),
      );
      const pendingMessage = resumeChat[pendingMessageIndex];
      if (
        deps.isAssistantChatMessage(pendingMessage, {
          index: pendingMessageIndex,
          chat: resumeChat,
        }) &&
        !String(pendingMessage?.mes ?? "").trim()
      ) {
        return deferAutoExtraction("assistant-message-empty", {
          chatId: pendingChatId,
          messageId: pendingMessageIndex,
          delayMs: hostSettleMs,
          targetEndFloor: pendingAutoExtraction.targetEndFloor,
          strategy: pendingAutoExtraction.strategy,
        });
      }
    }

    if (Array.isArray(resumeChat) && resumeChat.length > 0 && lockedEndFloor != null) {
      const lockedPlan = deps.resolveAutoExtractionPlan({
        chat: resumeChat,
        settings,
        lockedEndFloor,
      });
      if (
        !lockedPlan.canRun &&
        lockedPlan.candidateAssistantTurns.length === 0
      ) {
        const fallbackPlan = deps.resolveAutoExtractionPlan({
          chat: resumeChat,
          settings,
        });
        lockedEndFloor = fallbackPlan.canRun
          ? fallbackPlan.plannedBatchEndFloor
          : null;
      }
    }

    const pendingRequest = { ...pendingAutoExtraction };
    clearPendingAutoExtraction();
    if (lockedEndFloor == null) {
      const currentPlan = deps.resolveAutoExtractionPlan({
        chat: resumeChat,
        settings,
      });
      if (!currentPlan.canRun) {
        return {
          resumed: false,
          reason: "no-runnable-auto-extraction",
          source,
          ...pendingRequest,
        };
      }
      lockedEndFloor = currentPlan.plannedBatchEndFloor;
    }
    consoleImpl.debug?.("[ST-BME] resuming pending auto extraction", {
      source,
      chatId: pendingRequest.chatId,
      messageId: pendingRequest.messageId,
      targetEndFloor: lockedEndFloor,
      attempts: pendingRequest.attempts || 0,
    });
    const enqueueMicrotask =
      typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
        : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      void deps.runExtraction({
        lockedEndFloor,
        triggerSource: source,
      }).catch((error) => {
        consoleImpl.error("[ST-BME] 延迟自动提取失败:", error);
        deps.notifyExtractionIssue(error?.message || String(error) || "自动提取失败");
      });
    });

    return {
      resumed: true,
      source,
      lockedEndFloor,
      ...pendingRequest,
    };
  }

  return {
    clearPendingAutoExtraction,
    deferAutoExtraction,
    maybeResumePendingAutoExtraction,
    getPendingAutoExtraction,
  };
}
