export function createRerollRecallInput(deps = {}) {
  const plannerTurnHandoffs = new Map();

  const getCurrentChatId = (...args) => deps.getCurrentChatId?.(...args);
  const normalizeChatIdCandidate = (value = "") =>
    deps.normalizeChatIdCandidate?.(value) ?? String(value ?? "").trim();
  const normalizeRecallInputText = (value = "") =>
    deps.normalizeRecallInputText?.(value) ?? String(value || "").trim();
  const hashRecallInput = (value = "") => deps.hashRecallInput?.(value) ?? "";
  const getLastRecallSentUserMessage = () =>
    deps.getLastRecallSentUserMessage?.() || {};
  const getPendingRecallSendIntent = () =>
    deps.getPendingRecallSendIntent?.() || {};
  const getPlannerRecallHandoffTtlMs = () =>
    Number.isFinite(Number(deps.PLANNER_RECALL_HANDOFF_TTL_MS))
      ? Number(deps.PLANNER_RECALL_HANDOFF_TTL_MS)
      : 60000;

  function buildGenerationAfterCommandsRecallInput(type, params = {}, chat) {
    if (params?.automatic_trigger || params?.quiet_prompt) {
      return null;
    }

    const generationType = String(type || "").trim() || "normal";
    if (!["normal", "continue", "regenerate", "swipe"].includes(generationType)) {
      return null;
    }

    const targetUserMessageIndex = deps.resolveGenerationTargetUserMessageIndex(chat, {
      generationType,
      generationContext: params?.generationContext,
    });

    // 对于 history 类型（continue/regenerate/swipe），必须依赖 chat 中的用户消息
    if (generationType !== "normal") {
      if (!Number.isFinite(targetUserMessageIndex)) {
        return {
          generationType,
          targetUserMessageIndex: null,
        };
      }
      const historyInput = buildHistoryGenerationRecallInput(chat, {
        generationType,
        generationContext: params?.generationContext,
      });
      if (!historyInput) {
        return {
          generationType,
          targetUserMessageIndex,
        };
      }
      return {
        ...historyInput,
        generationType,
        targetUserMessageIndex,
      };
    }

    // 对于 normal 类型：GENERATION_AFTER_COMMANDS 触发时用户消息可能不在 chat 末尾
    // （ST 可能已追加空 assistant 消息）。如果 chat 中存在任何用户消息，
    // 继续走 buildNormalGenerationRecallInput，它会通过 latestUserText 兜底找到。
    // 如果 chat 中完全没有用户消息，则延迟到 BEFORE_COMBINE_PROMPTS 处理。
    if (!Number.isFinite(targetUserMessageIndex) && !deps.getLatestUserChatMessage(chat)) {
      return {
        generationType,
        targetUserMessageIndex: null,
      };
    }

    const normalInput = buildNormalGenerationRecallInput(chat, {
      frozenInputSnapshot: params?.frozenInputSnapshot,
    });
    return normalInput;
  }

  function buildNormalGenerationRecallInput(chat, options = {}) {
    const lastNonSystemMessage = deps.getLastNonSystemChatMessage(chat);
    const tailUserText = lastNonSystemMessage?.is_user
      ? normalizeRecallInputText(lastNonSystemMessage?.mes || "")
      : "";
    // 当 GENERATION_AFTER_COMMANDS 触发时，ST 可能已追加了空 assistant 消息。
    // 导致 lastNonSystemMessage 不是 user。用 getLatestUserChatMessage 反向扫描
    // 定位真正的用户消息（与 shujuku 参考实现一致）。
    const latestUserMessage = !tailUserText ? deps.getLatestUserChatMessage(chat) : null;
    const latestUserText = latestUserMessage
      ? normalizeRecallInputText(latestUserMessage?.mes || "")
      : "";
    const targetUserMessageIndex = deps.resolveGenerationTargetUserMessageIndex(chat, {
      generationType: "normal",
    });
    const frozenInputSnapshot = deps.isFreshRecallInputRecord(
      options?.frozenInputSnapshot,
    )
      ? options.frozenInputSnapshot
      : null;
    const pendingRecallSendIntent = getPendingRecallSendIntent();
    const pendingSendIntent = deps.isFreshRecallInputRecord(pendingRecallSendIntent)
      ? pendingRecallSendIntent
      : null;
    const sendIntentText = normalizeRecallInputText(
      pendingSendIntent?.text || "",
    );
    const hostSnapshotText = normalizeRecallInputText(
      frozenInputSnapshot?.text || "",
    );
    const textareaText = normalizeRecallInputText(deps.getSendTextareaValue());
    const sourceCandidates = [
      sendIntentText
        ? {
            text: sendIntentText,
            source: "send-intent",
            sourceLabel: "发送意图",
            reason: tailUserText
              ? "send-intent-overrides-chat-tail"
              : "send-intent-captured",
            includeSyntheticUserMessage: !tailUserText,
          }
        : null,
      hostSnapshotText
        ? {
            text: hostSnapshotText,
            source: String(
              frozenInputSnapshot?.source || "host-generation-lifecycle",
            ),
            sourceLabel: "宿主发送快照",
            reason: sendIntentText
              ? "host-snapshot-suppressed-by-send-intent"
              : tailUserText
                ? "host-snapshot-suppressed-by-chat-tail"
                : "host-snapshot-captured",
            includeSyntheticUserMessage: !tailUserText,
          }
        : null,
      tailUserText
        ? {
            text: tailUserText,
            source: "chat-tail-user",
            sourceLabel: "当前用户楼层",
            reason:
              sendIntentText || hostSnapshotText
                ? "chat-tail-deprioritized"
                : "chat-tail-fallback",
            includeSyntheticUserMessage: false,
          }
        : null,
      latestUserText
        ? {
            text: latestUserText,
            source: "chat-latest-user",
            sourceLabel: "最近用户消息",
            reason:
              sendIntentText || hostSnapshotText || tailUserText
                ? "latest-user-deprioritized"
                : "latest-user-fallback",
            includeSyntheticUserMessage: false,
          }
        : null,
      textareaText
        ? {
            text: textareaText,
            source: "textarea-live",
            sourceLabel: "输入框当前文本",
            reason:
              sendIntentText || hostSnapshotText || tailUserText
                ? "textarea-live-deprioritized"
                : "textarea-live-fallback",
            includeSyntheticUserMessage: !tailUserText,
          }
        : null,
    ].filter(Boolean);
    const activeTrivialSkip = deps.getCurrentGenerationTrivialSkip();
    if (activeTrivialSkip) {
      deps.clearPendingRecallSendIntent();
      deps.clearPendingHostGenerationInputSnapshot();
      return deps.createTrivialRecallSkipSentinel(activeTrivialSkip.reason);
    }

    const selectedCandidate = sourceCandidates[0] || null;
    if (!selectedCandidate?.text) return null;
    const usesStableChatFloor = [
      "chat-tail-user",
      "chat-latest-user",
    ].includes(selectedCandidate.source);
    const sentIntentMessageId = Number.isFinite(pendingSendIntent?.messageId)
      ? Math.floor(Number(pendingSendIntent.messageId))
      : null;
    const confirmedSentIntentTarget =
      selectedCandidate.source === "send-intent" &&
      Number.isFinite(sentIntentMessageId) &&
      sentIntentMessageId === targetUserMessageIndex &&
      chat?.[sentIntentMessageId]?.is_user
        ? sentIntentMessageId
        : null;
    const awaitingUserMessage =
      !usesStableChatFloor && !Number.isFinite(confirmedSentIntentTarget);

    const trivialInputResult = deps.isTrivialUserInput(selectedCandidate.text);

    if (trivialInputResult.trivial) {
      deps.clearPendingRecallSendIntent();
      deps.clearPendingHostGenerationInputSnapshot();
      deps.markCurrentGenerationTrivialSkip({
        reason: trivialInputResult.reason,
        chatId: getCurrentChatId(),
        chatLength: Array.isArray(chat) ? chat.length : 0,
      });
      deps.console?.info?.(
        `[ST-BME] trivial-input skip: reason=${trivialInputResult.reason} len=${trivialInputResult.normalizedText.length} hook=build-normal-input`,
      );
      return deps.createTrivialRecallSkipSentinel(trivialInputResult.reason);
    }

    return {
      overrideUserMessage: selectedCandidate.text,
      generationType: "normal",
      targetUserMessageIndex: awaitingUserMessage
        ? null
        : confirmedSentIntentTarget ?? targetUserMessageIndex,
      overrideSource: selectedCandidate.source,
      overrideSourceLabel: selectedCandidate.sourceLabel,
      overrideReason: selectedCandidate.reason,
      sourceCandidates,
      includeSyntheticUserMessage: awaitingUserMessage
        ? true
        : Number.isFinite(confirmedSentIntentTarget)
          ? false
          : selectedCandidate.includeSyntheticUserMessage,
      awaitingUserMessage,
    };
  }

  function buildHistoryGenerationRecallInput(chat, options = {}) {
    const generationType = String(options?.generationType || "history").trim() || "history";
    const lastRecallSentUserMessage = getLastRecallSentUserMessage();
    const targetUserMessageIndex = deps.resolveGenerationTargetUserMessageIndex(chat, {
      generationType,
      generationContext: options?.generationContext,
    });
    const targetUserText = Number.isFinite(targetUserMessageIndex)
      ? normalizeRecallInputText(chat?.[targetUserMessageIndex]?.mes || "")
      : "";
    const latestUserText = normalizeRecallInputText(
      targetUserText || deps.getLatestUserChatMessage(chat)?.mes || lastRecallSentUserMessage.text,
    );
    if (!latestUserText) return null;

    return {
      overrideUserMessage: latestUserText,
      generationType,
      targetUserMessageIndex,
      overrideSource: Number.isFinite(targetUserMessageIndex)
        ? "chat-last-user"
        : "chat-last-user-missing",
      overrideSourceLabel: Number.isFinite(targetUserMessageIndex)
        ? "历史最后用户楼层"
        : "历史用户楼层缺失",
      includeSyntheticUserMessage: false,
    };
  }

  function cleanupPlannerTurnHandoffs(now = Date.now()) {
    for (const [chatId, handoff] of plannerTurnHandoffs.entries()) {
      if (
        !handoff ||
        String(handoff.chatId || "") !== String(chatId || "") ||
        now - Number(handoff.updatedAt || handoff.createdAt || 0) >
          getPlannerRecallHandoffTtlMs()
      ) {
        plannerTurnHandoffs.delete(chatId);
      }
    }
  }

  function peekPlannerTurnHandoff(
    chatId = getCurrentChatId(),
    now = Date.now(),
  ) {
    cleanupPlannerTurnHandoffs(now);
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId) return null;

    const handoff = plannerTurnHandoffs.get(normalizedChatId) || null;
    if (!handoff) return null;
    if (
      now - Number(handoff.updatedAt || handoff.createdAt || 0) >
      getPlannerRecallHandoffTtlMs()
    ) {
      plannerTurnHandoffs.delete(normalizedChatId);
      return null;
    }
    return handoff;
  }

  function clearPlannerTurnHandoffsForChat(
    chatId = getCurrentChatId(),
    { clearAll = false } = {},
  ) {
    cleanupPlannerTurnHandoffs();
    if (clearAll) {
      const removed = plannerTurnHandoffs.size;
      plannerTurnHandoffs.clear();
      return removed;
    }

    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId) return 0;
    return plannerTurnHandoffs.delete(normalizedChatId) ? 1 : 0;
  }

  function consumePlannerTurnHandoff(chatId = getCurrentChatId()) {
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId) return null;
    const handoff = peekPlannerTurnHandoff(normalizedChatId);
    if (!handoff) return null;
    plannerTurnHandoffs.delete(normalizedChatId);
    return handoff;
  }

  function markPlannerTurnHandoffMatched(
    chatId = getCurrentChatId(),
    { handoffId = "", generationId = "" } = {},
  ) {
    const handoff = peekPlannerTurnHandoff(chatId);
    if (!handoff || (handoffId && String(handoff.id || "") !== String(handoffId))) {
      return null;
    }
    const nextGenerationId = String(generationId || "").trim();
    const matchedGenerationId = String(handoff.matchedGenerationId || "").trim();
    if (
      !nextGenerationId ||
      (matchedGenerationId && matchedGenerationId !== nextGenerationId)
    ) {
      return null;
    }
    const matchedAt = Date.now();
    handoff.matchedGenerationId = nextGenerationId;
    handoff.matchedAt = matchedAt;
    handoff.updatedAt = matchedAt;
    return handoff;
  }

  function consumePlannerTurnHandoffForGeneration(
    chatId = getCurrentChatId(),
    generationId = "",
    userMessageText = "",
  ) {
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId) return null;
    const handoff = peekPlannerTurnHandoff(normalizedChatId);
    if (!handoff) return null;
    const matchedGenerationId = String(handoff?.matchedGenerationId || "").trim();
    const activeGenerationId = String(generationId || "").trim();
    const matchesGeneration = Boolean(
      matchedGenerationId && matchedGenerationId === activeGenerationId,
    );
    const matchesUserMessage = Boolean(
      normalizeRecallInputText(userMessageText) &&
        normalizeRecallInputText(userMessageText) ===
          normalizeRecallInputText(handoff.plannerAugmentedMessage),
    );
    if (!matchesGeneration && !matchesUserMessage) return null;
    plannerTurnHandoffs.delete(normalizedChatId);
    return handoff;
  }

  function preparePlannerTurnHandoff({
    rawUserInput = "",
    plannerAugmentedMessage = "",
    plannerRecall = null,
    plannerPlotRecord = null,
    chatId = getCurrentChatId(),
  } = {}) {
    const normalizedChatId = normalizeChatIdCandidate(
      getCurrentChatId() || chatId,
    );
    const normalizedRawUserInput = normalizeRecallInputText(rawUserInput);
    const normalizedPlannerAugmentedMessage = normalizeRecallInputText(
      plannerAugmentedMessage,
    );
    if (
      !normalizedChatId ||
      !normalizedRawUserInput ||
      !normalizedPlannerAugmentedMessage
    ) {
      return null;
    }

    const rawResult = plannerRecall?.result || null;
    const injectionText = rawResult
      ? normalizeRecallInputText(
          plannerRecall?.memoryBlock ||
            deps.formatInjection?.(rawResult, deps.getSchema?.()) ||
            "",
        )
      : "";
    const result = injectionText ? rawResult : null;
    const plotText = normalizeRecallInputText(plannerPlotRecord?.plotText || "");
    const normalizedPlotRecord = plotText
      ? {
          ...(plannerPlotRecord || {}),
          rawUserInput: normalizedRawUserInput,
          plannerAugmentedMessage: normalizedPlannerAugmentedMessage,
          plotText,
          plotBlocks: Array.isArray(plannerPlotRecord?.plotBlocks)
            ? [...plannerPlotRecord.plotBlocks]
            : null,
        }
      : null;
    if (!result && !normalizedPlotRecord) return null;

    cleanupPlannerTurnHandoffs();
    const createdAt = Date.now();
    const handoff = {
      id: [
        normalizedChatId,
        hashRecallInput(normalizedRawUserInput),
        createdAt,
      ].join(":"),
      chatId: normalizedChatId,
      rawUserInput: normalizedRawUserInput,
      plannerAugmentedMessage: normalizedPlannerAugmentedMessage,
      result,
      recentMessages: Array.isArray(plannerRecall?.recentMessages)
        ? plannerRecall.recentMessages.map((item) => String(item || ""))
        : [],
      injectionText,
      plannerPlotRecord: normalizedPlotRecord,
      source: "planner-handoff",
      sourceLabel: "Planner handoff",
      createdAt,
      updatedAt: createdAt,
    };
    plannerTurnHandoffs.set(normalizedChatId, handoff);
    return handoff;
  }

  function persistPlannerTurnHandoffToUserMessage(newUserMessageIndex) {
    const context = deps.getContext?.();
    const chat = context?.chat;
    if (
      !Array.isArray(chat) ||
      !Number.isFinite(newUserMessageIndex) ||
      !chat[newUserMessageIndex]?.is_user
    ) {
      return false;
    }
    const targetUserFloorText = normalizeRecallInputText(
      chat[newUserMessageIndex]?.mes || "",
    );
    // Handoffs are keyed by BME's canonical chat identity, not the host filename.
    const chatId = getCurrentChatId();
    const handoff = consumePlannerTurnHandoffForGeneration(
      chatId,
      deps.getActiveGenerationId?.(),
      targetUserFloorText,
    );
    if (!handoff) return false;

    const injectionText = String(handoff?.injectionText || "").trim();
    const result = handoff?.result || null;
    const recallWasMatched = Boolean(
      String(handoff?.matchedGenerationId || "").trim(),
    );
    let wroteRecall = false;
    if (
      recallWasMatched &&
      injectionText &&
      result &&
      !deps.readPersistedRecallFromUserMessage?.(chat, newUserMessageIndex)
    ) {
      wroteRecall = Boolean(
        deps.writePersistedRecallToUserMessage?.(
          chat,
          newUserMessageIndex,
          deps.buildPersistedRecallRecord?.({
            injectionText,
            selectedNodeIds: result?.selectedNodeIds || [],
            recallInput: String(handoff.rawUserInput || ""),
            recallSource: String(handoff.source || "planner-handoff"),
            hookName: "MESSAGE_SENT",
            tokenEstimate: deps.estimateTokens?.(injectionText) || 0,
            manuallyEdited: false,
            authoritativeInputUsed: true,
            boundUserFloorText: targetUserFloorText,
            historyFingerprint:
              deps.buildRecallHistoryFingerprint?.(
                chat,
                newUserMessageIndex,
              ) || "",
          }),
        ),
      );
    }

    const plannerPlotRecord = handoff.plannerPlotRecord;
    const wrotePlot = Boolean(
      plannerPlotRecord &&
        deps.writeStructuredPlotRecordToMessage?.(chat[newUserMessageIndex], {
          ...plannerPlotRecord,
          recallHandoffId:
            handoff.id || plannerPlotRecord.recallHandoffId || "",
        }),
    );
    if (wroteRecall || wrotePlot) {
      deps.triggerChatMetadataSave?.(context, { immediate: false });
    }
    return wroteRecall || wrotePlot;
  }

  return {
    buildNormalGenerationRecallInput,
    buildHistoryGenerationRecallInput,
    buildGenerationAfterCommandsRecallInput,
    preparePlannerTurnHandoff,
    peekPlannerTurnHandoff,
    consumePlannerTurnHandoff,
    consumePlannerTurnHandoffForGeneration,
    markPlannerTurnHandoffMatched,
    cleanupPlannerTurnHandoffs,
    clearPlannerTurnHandoffsForChat,
    persistPlannerTurnHandoffToUserMessage,
  };
}
