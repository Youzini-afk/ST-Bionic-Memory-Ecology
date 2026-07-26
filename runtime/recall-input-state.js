export function createRecallInputState(deps = {}) {
  const getPendingRecallSendIntent = () =>
    deps.getPendingRecallSendIntent?.() ?? deps.createRecallInputRecord?.();
  const setPendingRecallSendIntent = (record) => {
    deps.setPendingRecallSendIntent?.(record);
    return record;
  };
  const getPendingHostGenerationInputSnapshot = () =>
    deps.getPendingHostGenerationInputSnapshot?.() ?? deps.createRecallInputRecord?.();
  const setPendingHostGenerationInputSnapshot = (record) => {
    deps.setPendingHostGenerationInputSnapshot?.(record);
    return record;
  };
  const getLastRecallSentUserMessage = () =>
    deps.getLastRecallSentUserMessage?.() ?? deps.createRecallInputRecord?.();
  const setLastRecallSentUserMessage = (record) => {
    deps.setLastRecallSentUserMessage?.(record);
    return record;
  };
  const getCurrentChatId = (...args) => deps.getCurrentChatId?.(...args);
  const normalizeChatIdCandidate = (value = "") =>
    deps.normalizeChatIdCandidate?.(value) ?? String(value ?? "").trim();
  const normalizeRecallInputText = (value = "") =>
    deps.normalizeRecallInputText?.(value) ?? String(value || "").trim();
  const createRecallInputRecord = (record = {}) =>
    deps.createRecallInputRecord?.(record) ?? { ...(record || {}) };
  const hashRecallInput = (value = "") => deps.hashRecallInput?.(value) ?? "";
  const isFreshRecallInputRecord = (record) =>
    deps.isFreshRecallInputRecord?.(record) ?? Boolean(record?.text);
  const getCurrentGenerationTrivialSkipRecord = () =>
    deps.getCurrentGenerationTrivialSkip?.() || null;
  const setCurrentGenerationTrivialSkipRecord = (record = null) =>
    deps.setCurrentGenerationTrivialSkip?.(record) ?? record;
  const getTrivialGenerationSkipTtlMs = () =>
    Number.isFinite(Number(deps.TRIVIAL_GENERATION_SKIP_TTL_MS))
      ? Number(deps.TRIVIAL_GENERATION_SKIP_TTL_MS)
      : 60000;

  function freezeHostGenerationInputSnapshot(
    text,
    source = "host-generation-lifecycle",
  ) {
    const normalized = normalizeRecallInputText(text);
    if (!normalized) return null;

    const nextSnapshot = createRecallInputRecord({
      text: normalized,
      hash: hashRecallInput(normalized),
      source,
      at: Date.now(),
    });
    setPendingHostGenerationInputSnapshot(nextSnapshot);
    return nextSnapshot;
  }

  function consumeHostGenerationInputSnapshot(options = {}) {
    const { preserve = false } = options;
    const pendingHostGenerationInputSnapshot = getPendingHostGenerationInputSnapshot();
    if (!isFreshRecallInputRecord(pendingHostGenerationInputSnapshot)) {
      if (!preserve) {
        setPendingHostGenerationInputSnapshot(createRecallInputRecord());
      }
      return createRecallInputRecord();
    }

    const snapshot = createRecallInputRecord({
      ...pendingHostGenerationInputSnapshot,
    });
    if (!preserve) {
      setPendingHostGenerationInputSnapshot(createRecallInputRecord());
    }
    return snapshot;
  }

  function readPendingHostGenerationInputSnapshot() {
    return getPendingHostGenerationInputSnapshot();
  }

  function clearPendingRecallSendIntent() {
    const nextRecord = createRecallInputRecord();
    setPendingRecallSendIntent(nextRecord);
    return nextRecord;
  }

  function clearPendingHostGenerationInputSnapshot() {
    const nextSnapshot = createRecallInputRecord();
    setPendingHostGenerationInputSnapshot(nextSnapshot);
    return nextSnapshot;
  }

  function getCurrentGenerationTrivialSkip(
    chatId = getCurrentChatId(),
    now = Date.now(),
  ) {
    const currentGenerationTrivialSkip =
      getCurrentGenerationTrivialSkipRecord();
    if (!currentGenerationTrivialSkip) return null;

    const setAtMs = Number(currentGenerationTrivialSkip.setAtMs) || 0;
    if (
      !setAtMs ||
      now - setAtMs > getTrivialGenerationSkipTtlMs()
    ) {
      setCurrentGenerationTrivialSkipRecord(null);
      return null;
    }

    const normalizedChatId = normalizeChatIdCandidate(chatId);
    const activeChatId = normalizeChatIdCandidate(
      currentGenerationTrivialSkip.chatId,
    );
    if (normalizedChatId && activeChatId && normalizedChatId !== activeChatId) {
      return null;
    }

    return currentGenerationTrivialSkip;
  }

  function markCurrentGenerationTrivialSkip({
    reason = "",
    chatId = getCurrentChatId(),
    chatLength = 0,
  } = {}) {
    const currentGenerationTrivialSkip = {
      chatId: normalizeChatIdCandidate(chatId),
      setAtMs: Date.now(),
      reason: String(reason || ""),
      generationStartMinChatIndex: Math.max(
        0,
        Math.floor(Number(chatLength) || 0),
      ),
    };
    return setCurrentGenerationTrivialSkipRecord(
      currentGenerationTrivialSkip,
    );
  }

  function clearCurrentGenerationTrivialSkip(_reason = "") {
    const previous = getCurrentGenerationTrivialSkipRecord();
    setCurrentGenerationTrivialSkipRecord(null);
    return previous;
  }

  function consumeCurrentGenerationTrivialSkip(
    targetMessageIndex,
    chatId = getCurrentChatId(),
    now = Date.now(),
  ) {
    const activeSkip = getCurrentGenerationTrivialSkip(chatId, now);
    if (!activeSkip) return false;

    const normalizedTargetIndex = Number.isFinite(Number(targetMessageIndex))
      ? Math.floor(Number(targetMessageIndex))
      : null;
    if (!Number.isFinite(normalizedTargetIndex)) {
      return false;
    }

    if (
      normalizedTargetIndex <
      Math.max(0, Math.floor(Number(activeSkip.generationStartMinChatIndex) || 0))
    ) {
      return false;
    }

    setCurrentGenerationTrivialSkipRecord(null);
    return true;
  }

  function recordRecallSendIntent(text, source = "dom-intent") {
    const normalized = normalizeRecallInputText(text);
    if (!normalized) return createRecallInputRecord();

    const hash = hashRecallInput(normalized);
    const pendingRecallSendIntent = getPendingRecallSendIntent();
    const previousRecord = isFreshRecallInputRecord(pendingRecallSendIntent)
      ? pendingRecallSendIntent
      : null;
    const previousHash = String(previousRecord?.hash || "");
    const previousText = String(previousRecord?.text || "");

    if (previousHash && previousHash === hash && previousText === normalized) {
      const nextRecord = createRecallInputRecord({
        ...previousRecord,
        at: Date.now(),
        source: String(source || previousRecord.source || "dom-intent"),
      });
      setPendingRecallSendIntent(nextRecord);
      return nextRecord;
    }

    const nextRecord = createRecallInputRecord({
      text: normalized,
      hash,
      source,
      at: Date.now(),
    });
    setPendingRecallSendIntent(nextRecord);
    return nextRecord;
  }

  function recordRecallSentUserMessage(messageId, text, source = "message-sent") {
    const normalized = normalizeRecallInputText(text);
    if (!normalized) return createRecallInputRecord();

    const hash = hashRecallInput(normalized);
    const recordedAt = Date.now();
    const normalizedMessageId = Number.isFinite(messageId) ? messageId : null;
    const nextRecord = createRecallInputRecord({
      text: normalized,
      hash,
      messageId: normalizedMessageId,
      source,
      at: recordedAt,
    });
    setLastRecallSentUserMessage(nextRecord);

    const pendingRecallSendIntent = getPendingRecallSendIntent();
    if (isFreshRecallInputRecord(pendingRecallSendIntent)) {
      setPendingRecallSendIntent(
        createRecallInputRecord({
          ...pendingRecallSendIntent,
          messageId: normalizedMessageId,
          sentAt: recordedAt,
        }),
      );
    }
    if (typeof deps.recordMessageTraceSnapshot === "function") {
      deps.recordMessageTraceSnapshot({
        lastSentUserMessage: {
          text: normalized,
          hash,
          messageId: normalizedMessageId,
          source,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    // 注意：不再在 MESSAGE_SENT 阶段清空 pendingRecallSendIntent /
    // pendingHostGenerationInputSnapshot / transactions。
    // 这些数据在 GENERATION_AFTER_COMMANDS 中被消费；MESSAGE_SENT 先于
    // GENERATION_AFTER_COMMANDS 触发，提前清空会导致召回拿不到用户输入。
    // 真正的消费发生在 recall 执行后（runRecallController 内部）。

    return nextRecord;
  }

  function clearRecallInputTracking() {
    clearPendingRecallSendIntent();
    setLastRecallSentUserMessage(createRecallInputRecord());
    clearPendingHostGenerationInputSnapshot();
    if (typeof deps.recordMessageTraceSnapshot === "function") {
      deps.recordMessageTraceSnapshot({
        lastSentUserMessage: null,
      });
    }
    deps.clearPlannerTurnHandoffsForChat?.("", { clearAll: true });
  }

  return {
    freezeHostGenerationInputSnapshot,
    consumeHostGenerationInputSnapshot,
    getPendingHostGenerationInputSnapshot: readPendingHostGenerationInputSnapshot,
    clearPendingHostGenerationInputSnapshot,
    recordRecallSendIntent,
    clearPendingRecallSendIntent,
    recordRecallSentUserMessage,
    getCurrentGenerationTrivialSkip,
    markCurrentGenerationTrivialSkip,
    clearCurrentGenerationTrivialSkip,
    consumeCurrentGenerationTrivialSkip,
    clearRecallInputTracking,
    getLastRecallSentUserMessage,
    getPendingRecallSendIntent,
  };
}
