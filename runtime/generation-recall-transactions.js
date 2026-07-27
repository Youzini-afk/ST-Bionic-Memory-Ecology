export function createGenerationRecallTransactions(deps = {}) {
  const normalizeChatIdCandidate = (value = "") =>
    deps.normalizeChatIdCandidate?.(value) ?? String(value ?? "").trim();
  const normalizeRecallInputText = (value = "") =>
    deps.normalizeRecallInputText?.(value) ?? String(value || "").trim();
  const getCurrentChatId = (...args) => deps.getCurrentChatId?.(...args);
  const getContext = (...args) => deps.getContext?.(...args);
  const getActiveGenerationId = () =>
    String(deps.getActiveGenerationId?.() || "").trim();
  const getCurrentTransaction = () =>
    deps.getGenerationRecallTransaction?.() || null;
  const setCurrentTransaction = (transaction = null) =>
    deps.setGenerationRecallTransaction?.(transaction) ?? transaction;
  const clearCurrentTransaction = () =>
    deps.clearGenerationRecallTransaction?.() || null;

  function buildPreGenerationRecallKey(type, options = {}) {
    const targetUserMessageIndex = Number.isFinite(options.targetUserMessageIndex)
      ? options.targetUserMessageIndex
      : "none";
    const seedText =
      options.overrideUserMessage ||
      options.userMessage ||
      `@target:${targetUserMessageIndex}`;

    const normalizedChatId = normalizeChatIdCandidate(
      options.chatId || getCurrentChatId(),
    );

    return [
      normalizedChatId,
      String(type || "normal").trim() || "normal",
      deps.hashRecallInput(seedText || ""),
    ].join(":");
  }

  function getGenerationRecallPeerHookName(hookName = "") {
    const normalized = String(hookName || "").trim();
    if (normalized === "GENERATION_AFTER_COMMANDS") {
      return "GENERATE_BEFORE_COMBINE_PROMPTS";
    }
    if (normalized === "GENERATE_BEFORE_COMBINE_PROMPTS") {
      return "GENERATION_AFTER_COMMANDS";
    }
    return "";
  }

  function normalizeGenerationRecallTransactionType(generationType = "normal") {
    const normalized = String(generationType || "normal").trim() || "normal";
    return normalized === "normal" ? "normal" : "history";
  }

  function resolveGenerationRecallDeliveryMode(
    hookName,
    generationType = "normal",
    recallOptions = {},
  ) {
    if (recallOptions?.forceImmediateDelivery === true) {
      return "immediate";
    }

    const normalizedType = normalizeGenerationRecallTransactionType(
      recallOptions?.generationType || generationType,
    );
    if (normalizedType !== "normal") {
      return "immediate";
    }

    // GENERATION_AFTER_COMMANDS: immediate —— await 完召回后直接通过
    // setExtensionPrompt 注入记忆，与 shujuku 参考实现一致。
    // GENERATE_BEFORE_COMBINE_PROMPTS: deferred —— 作为兜底，通过 promptData
    // rewrite 补救注入。
    if (hookName === "GENERATE_BEFORE_COMBINE_PROMPTS") {
      return "deferred";
    }
    return "immediate";
  }

  function shouldUseAuthoritativeGenerationRecallInput(recallOptions = {}) {
    const normalizedGenerationType = normalizeGenerationRecallTransactionType(
      recallOptions?.generationType || "normal",
    );
    if (normalizedGenerationType !== "normal") {
      return false;
    }
    return Boolean(deps.getSettings?.()?.recallUseAuthoritativeGenerationInput);
  }

  function shouldPreserveAuthoritativeGenerationRecallText(
    source,
    overrideUserMessage,
    targetUserMessageText,
    recallOptions = {},
  ) {
    if (!shouldUseAuthoritativeGenerationRecallInput(recallOptions)) {
      return false;
    }
    const normalizedOverride = normalizeRecallInputText(overrideUserMessage);
    const normalizedTarget = normalizeRecallInputText(targetUserMessageText);
    if (!normalizedOverride || !normalizedTarget || normalizedOverride === normalizedTarget) {
      return false;
    }
    const normalizedSource = String(source || "").trim();
    return [
      "send-intent",
      "generation-started-send-intent",
      "generation-started-textarea",
      "host-generation-lifecycle",
      "textarea-live",
      "planner-handoff",
    ].includes(normalizedSource);
  }

  function freezeGenerationRecallOptionsForTransaction(
    chat,
    generationType = "normal",
    recallOptions = {},
  ) {
    if (!Array.isArray(chat)) return null;

    const optionGenerationType =
      String(
        recallOptions?.generationType || generationType || "normal",
      ).trim() || "normal";
    const normalizedGenerationType = optionGenerationType;

    const overrideUserMessage = normalizeRecallInputText(
      recallOptions?.overrideUserMessage || recallOptions?.userMessage || "",
    );

    const source =
      String(
        recallOptions?.overrideSource || recallOptions?.source || "",
      ).trim() ||
      (normalizeGenerationRecallTransactionType(normalizedGenerationType) ===
      "normal"
        ? "chat-tail-user"
        : "chat-last-user");
    const sourceLabel =
      String(
        recallOptions?.overrideSourceLabel ||
          recallOptions?.sourceLabel ||
          deps.getRecallUserMessageSourceLabel(source),
      ).trim() || deps.getRecallUserMessageSourceLabel(source);
    const sourceReason =
      String(
        recallOptions?.overrideReason || recallOptions?.reason || "",
      ).trim() || "transaction-source-frozen";
    const sourceCandidates = Array.isArray(recallOptions?.sourceCandidates)
      ? recallOptions.sourceCandidates
          .map((candidate) => ({
            text: normalizeRecallInputText(candidate?.text || ""),
            source: String(candidate?.source || "").trim(),
            sourceLabel: String(candidate?.sourceLabel || "").trim(),
            reason: String(candidate?.reason || "").trim(),
            includeSyntheticUserMessage: Boolean(
              candidate?.includeSyntheticUserMessage,
            ),
          }))
          .filter((candidate) => candidate.text && candidate.source)
      : [];

    let targetUserMessageIndex = recallOptions?.awaitingUserMessage
      ? null
      : Number.isFinite(recallOptions?.targetUserMessageIndex)
        ? Math.floor(Number(recallOptions.targetUserMessageIndex))
        : deps.resolveGenerationTargetUserMessageIndex(chat, {
            generationType: normalizedGenerationType,
          });

    if (!Number.isFinite(targetUserMessageIndex)) {
      if (
        normalizeGenerationRecallTransactionType(normalizedGenerationType) ===
          "normal" &&
        overrideUserMessage
      ) {
        const authoritativeInputUsed =
          shouldUseAuthoritativeGenerationRecallInput(recallOptions);
        return {
          generationType: normalizedGenerationType,
          targetUserMessageIndex: null,
          overrideUserMessage,
          overrideSource: source,
          overrideSourceLabel: sourceLabel,
          overrideReason: sourceReason,
          sourceCandidates,
          lockedSource: source,
          lockedSourceLabel: sourceLabel,
          lockedReason: sourceReason,
          authoritativeInputUsed,
          boundUserFloorText: "",
          includeSyntheticUserMessage: true,
          awaitingUserMessage: Boolean(recallOptions?.awaitingUserMessage),
        };
      }
      return null;
    }
    targetUserMessageIndex = Math.floor(targetUserMessageIndex);

    const targetUserMessage = chat[targetUserMessageIndex];
    if (!targetUserMessage?.is_user) {
      return null;
    }

    const targetUserMessageText = normalizeRecallInputText(targetUserMessage?.mes || "");
    const preserveAuthoritativeText = shouldPreserveAuthoritativeGenerationRecallText(
      source,
      overrideUserMessage,
      targetUserMessageText,
      recallOptions,
    );
    const frozenUserMessage = preserveAuthoritativeText
      ? normalizeRecallInputText(overrideUserMessage)
      : normalizeRecallInputText(
          targetUserMessage?.mes ||
            recallOptions?.overrideUserMessage ||
            recallOptions?.userMessage ||
            "",
        );
    if (!frozenUserMessage) {
      return null;
    }

    return {
      generationType: normalizedGenerationType,
      targetUserMessageIndex,
      overrideUserMessage: frozenUserMessage,
      overrideSource: source,
      overrideSourceLabel: sourceLabel,
      overrideReason:
        sourceReason ||
        (frozenUserMessage === overrideUserMessage
          ? "transaction-source-frozen"
          : "transaction-bound-to-chat-user-floor"),
      sourceCandidates,
      lockedSource: source,
      lockedSourceLabel: sourceLabel,
      lockedReason:
        sourceReason ||
        (frozenUserMessage === overrideUserMessage
          ? "transaction-source-frozen"
          : "transaction-bound-to-chat-user-floor"),
      authoritativeInputUsed: preserveAuthoritativeText,
      boundUserFloorText: targetUserMessageText,
      includeSyntheticUserMessage: preserveAuthoritativeText,
      awaitingUserMessage: Boolean(recallOptions?.awaitingUserMessage),
    };
  }

  function buildGenerationRecallTransactionId(
    chatId,
    generationType,
    recallKey,
    generationId = getActiveGenerationId(),
  ) {
    return [
      String(chatId || ""),
      String(generationId || ""),
      String(generationType || "normal").trim() || "normal",
      String(recallKey || ""),
    ].join(":");
  }

  function beginGenerationRecallTransaction({
    chatId,
    generationType = "normal",
    recallKey = "",
    forceNew = false,
  } = {}) {
    const normalizedChatId = String(chatId || "");
    const normalizedGenerationType =
      String(generationType || "normal").trim() || "normal";
    const normalizedRecallKey = String(recallKey || "");
    const generationId = getActiveGenerationId();
    if (!normalizedChatId || !normalizedRecallKey || !generationId) return null;
    const transactionId = buildGenerationRecallTransactionId(
      normalizedChatId,
      normalizedGenerationType,
      normalizedRecallKey,
      generationId,
    );

    const now = Date.now();
    const existingTransaction = getCurrentTransaction();
    if (existingTransaction?.id === transactionId && !forceNew) {
      existingTransaction.updatedAt = now;
      setCurrentTransaction(existingTransaction);
      return existingTransaction;
    }

    const transaction = {
      id: transactionId,
      chatId: normalizedChatId,
      generationType: normalizedGenerationType,
      recallKey: normalizedRecallKey,
      generationId,
      hookStates: {},
      createdAt: now,
      frozenRecallOptions: null,
    };
    transaction.updatedAt = now;
    setCurrentTransaction(transaction);
    return transaction;
  }

  function findRecentGenerationRecallTransactionForChat(
    chatId = getCurrentChatId(),
  ) {
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId) return null;

    // 跨代际隔离：当宿主提供了当前生成代际 id 时，只桥接“同一次生成”的事务。
    // 这阻止上一轮 normal 生成遗留的事务被本轮 reroll 复用，从而保证
    // reroll 真正进入 runRecall → 持久召回复用门禁，而不是继承旧的 fresh 结果。
    const transaction = getCurrentTransaction();
    if (!transaction || String(transaction.chatId || "") !== normalizedChatId) {
      return null;
    }
    const activeGenerationId = getActiveGenerationId();
    if (
      activeGenerationId &&
      String(transaction.generationId || "") !== activeGenerationId
    ) {
      return null;
    }
    return transaction;
  }

  function shouldReuseRecentGenerationRecallTransaction(
    transaction,
    hookName,
    recallKey = "",
  ) {
    if (!transaction || !hookName) return false;
    const activeGenerationId = getActiveGenerationId();
    if (
      activeGenerationId &&
      String(transaction.generationId || "") !== activeGenerationId
    ) {
      return false;
    }

    const hookStates = transaction.hookStates || {};
    const normalizedRecallKey = String(recallKey || "");
    const transactionRecallKey = String(transaction.recallKey || "");

    if (Object.values(hookStates).includes("running")) {
      return true;
    }

    const peerHookName = getGenerationRecallPeerHookName(hookName);
    const peerHookState = peerHookName ? hookStates[peerHookName] : "";
    if (peerHookState) {
      return true;
    }

    const ownState = hookStates[hookName];
    if (ownState) {
      return ownState === "running";
    }

    if (!Object.keys(hookStates).length) {
      if (!transactionRecallKey) {
        return true;
      }
      if (!normalizedRecallKey) {
        return false;
      }
      if (normalizedRecallKey !== transactionRecallKey) {
        return false;
      }
      return true;
    }

    return false;
  }

  function markGenerationRecallTransactionHookState(
    transaction,
    hookName,
    state = "completed",
  ) {
    if (!transaction?.id || !hookName) return transaction;
    transaction.hookStates ||= {};
    transaction.hookStates[hookName] = state;
    transaction.updatedAt = Date.now();
    setCurrentTransaction(transaction);
    return transaction;
  }

  function getGenerationRecallTransactionResult(transaction) {
    return transaction?.lastRecallResult || null;
  }

  function storeGenerationRecallTransactionResult(
    transaction,
    recallResult = null,
    meta = {},
  ) {
    if (!transaction?.id) return transaction;
    transaction.lastRecallResult = recallResult ? { ...recallResult } : null;
    transaction.lastRecallMeta =
      meta && typeof meta === "object" ? { ...meta } : {};
    transaction.lastDeliveryMode =
      String(meta?.deliveryMode || recallResult?.deliveryMode || "").trim() ||
      transaction.lastDeliveryMode ||
      "";
    transaction.finalResolution = null;
    transaction.updatedAt = Date.now();
    setCurrentTransaction(transaction);
    return transaction;
  }

  function readGenerationRecallTransactionFinalResolution(transaction) {
    return transaction?.finalResolution || null;
  }

  function storeGenerationRecallTransactionFinalResolution(
    transaction,
    finalResolution = null,
  ) {
    if (!transaction?.id) return transaction;
    transaction.finalResolution = finalResolution ? { ...finalResolution } : null;
    transaction.updatedAt = Date.now();
    setCurrentTransaction(transaction);
    return transaction;
  }

  function clearGenerationRecallTransactionsForChat(
    chatId = getCurrentChatId(),
    { clearAll = false } = {},
  ) {
    const normalizedChatId = String(chatId || "");
    const transaction = getCurrentTransaction();
    if (!transaction) return 0;
    if (
      !clearAll &&
      normalizedChatId &&
      String(transaction.chatId || "") !== normalizedChatId
    ) {
      return 0;
    }
    clearCurrentTransaction();
    return 1;
  }

  function isPlannerTurnHandoffForRecall(handoff, recallOptions = {}) {
    const augmentedMessage = normalizeRecallInputText(
      handoff?.plannerAugmentedMessage || "",
    );
    if (!augmentedMessage) return false;
    const candidates = [
      recallOptions?.overrideUserMessage,
      recallOptions?.userMessage,
      recallOptions?.boundUserFloorText,
      ...(Array.isArray(recallOptions?.sourceCandidates)
        ? recallOptions.sourceCandidates.map((candidate) => candidate?.text)
        : []),
    ];
    return candidates.some(
      (candidate) => normalizeRecallInputText(candidate || "") === augmentedMessage,
    );
  }

  function createGenerationRecallContext({
    hookName,
    generationType = "normal",
    recallOptions = {},
    chatId = getCurrentChatId(),
  } = {}) {
    const context = getContext();
    const chat = context?.chat;
    const normalizedChatId = normalizeChatIdCandidate(
      chatId || context?.chatId || getCurrentChatId(),
    );
    const effectiveGenerationType = normalizeGenerationRecallTransactionType(
      recallOptions?.generationType || generationType,
    );
    const pendingPlannerHandoff =
      effectiveGenerationType === "normal"
        ? deps.peekPlannerTurnHandoff(normalizedChatId)
        : null;
    let plannerTurnHandoff = isPlannerTurnHandoffForRecall(
      pendingPlannerHandoff,
      recallOptions,
    )
      ? pendingPlannerHandoff
      : null;
    if (pendingPlannerHandoff && !plannerTurnHandoff) {
      deps.clearPlannerTurnHandoffsForChat?.(normalizedChatId);
    }
    if (plannerTurnHandoff) {
      plannerTurnHandoff = deps.markPlannerTurnHandoffMatched?.(normalizedChatId, {
        handoffId: plannerTurnHandoff.id,
        generationId: getActiveGenerationId(),
      }) || null;
      if (!plannerTurnHandoff) {
        deps.clearPlannerTurnHandoffsForChat?.(normalizedChatId);
      }
    }
    const effectiveRecallOptions = plannerTurnHandoff
      ? {
          ...(recallOptions || {}),
          overrideUserMessage: plannerTurnHandoff.rawUserInput,
          overrideSource: plannerTurnHandoff.source || "planner-handoff",
          overrideSourceLabel:
            plannerTurnHandoff.sourceLabel || "Planner handoff",
          overrideReason: "planner-handoff-reuse",
          targetUserMessageIndex: null,
          awaitingUserMessage: true,
          sourceCandidates: [
            {
              text: plannerTurnHandoff.rawUserInput,
              source: plannerTurnHandoff.source || "planner-handoff",
              sourceLabel:
                plannerTurnHandoff.sourceLabel || "Planner handoff",
              reason: "planner-handoff-reuse",
              includeSyntheticUserMessage: false,
            },
          ],
          includeSyntheticUserMessage: false,
        }
      : recallOptions;

    const frozenRecallOptions = freezeGenerationRecallOptionsForTransaction(
      chat,
      generationType,
      effectiveRecallOptions,
    );
    if (!frozenRecallOptions) {
      return {
        hookName,
        generationType,
        recallKey: "",
        transaction: null,
        recallOptions: null,
        shouldRun: false,
        guardReason: "missing-frozen-recall-options",
      };
    }

    const transactionGenerationType = normalizeGenerationRecallTransactionType(
      frozenRecallOptions.generationType || generationType,
    );
    const fallbackRecallKey =
      effectiveRecallOptions?.recallKey ||
      buildPreGenerationRecallKey(transactionGenerationType, {
        ...frozenRecallOptions,
        chatId: normalizedChatId,
        userMessage: frozenRecallOptions.overrideUserMessage,
      });

    if (!normalizedChatId || !String(fallbackRecallKey || "").trim()) {
      return {
        hookName,
        generationType: transactionGenerationType,
        recallKey: "",
        transaction: null,
        recallOptions: null,
        shouldRun: false,
        guardReason: !normalizedChatId ? "missing-chat-id" : "missing-recall-key",
      };
    }

    const now = Date.now();
    const recentTransaction = findRecentGenerationRecallTransactionForChat(
      normalizedChatId,
    );
    let transaction = recentTransaction;
    if (
      !shouldReuseRecentGenerationRecallTransaction(
        transaction,
        hookName,
        fallbackRecallKey,
      )
    ) {
      transaction = beginGenerationRecallTransaction({
        chatId: normalizedChatId,
        generationType: transactionGenerationType,
        recallKey: fallbackRecallKey,
        forceNew: true,
      });
    }

    if (!transaction) {
      return {
        hookName,
        generationType: transactionGenerationType,
        recallKey: "",
        transaction: null,
        recallOptions: null,
        shouldRun: false,
        guardReason: "transaction-unavailable",
      };
    }

    const normalizedTransactionChatId = normalizeChatIdCandidate(
      transaction.chatId,
    );
    const transactionRecallKey = String(transaction.recallKey || "").trim();
    const peerHookName = getGenerationRecallPeerHookName(hookName);
    const hasPeerHookState = Boolean(
      peerHookName && transaction.hookStates?.[peerHookName],
    );
    if (
      normalizedTransactionChatId !== normalizedChatId ||
      !transactionRecallKey ||
      (!hasPeerHookState && transactionRecallKey !== String(fallbackRecallKey))
    ) {
      return {
        hookName,
        generationType: transactionGenerationType,
        recallKey: String(fallbackRecallKey || ""),
        transaction,
        recallOptions: null,
        shouldRun: false,
        guardReason: "transaction-mismatch",
      };
    }

    if (
      !transaction.frozenRecallOptions ||
      typeof transaction.frozenRecallOptions !== "object"
    ) {
      transaction.frozenRecallOptions = {
        ...frozenRecallOptions,
        lockedSource:
          frozenRecallOptions?.lockedSource ||
          frozenRecallOptions?.overrideSource ||
          frozenRecallOptions?.source ||
          "",
        lockedSourceLabel:
          frozenRecallOptions?.lockedSourceLabel ||
          frozenRecallOptions?.overrideSourceLabel ||
          frozenRecallOptions?.sourceLabel ||
          "",
        lockedReason:
          frozenRecallOptions?.lockedReason ||
          frozenRecallOptions?.overrideReason ||
          frozenRecallOptions?.reason ||
          "",
        lockedAt: now,
      };
    }
    if (!String(transaction.generationType || "").trim()) {
      transaction.generationType = transactionGenerationType;
    }
    transaction.updatedAt = now;
    setCurrentTransaction(transaction);

    const boundRecallOptions = {
      ...(transaction.frozenRecallOptions || frozenRecallOptions),
      recallKey: transaction.recallKey,
      generationType:
        transaction.frozenRecallOptions?.generationType || generationType,
    };
    // Only register a cached recall payload when the planner handoff
    // actually carries a non-empty memory block. Otherwise the main recall
    // would be short-circuited by an empty cached payload and produce no
    // recall record / no recall card (see docs/features/ena-planner.md:76).
    if (
      plannerTurnHandoff?.result &&
      String(plannerTurnHandoff.injectionText || "").trim()
    ) {
      boundRecallOptions.cachedRecallPayload = {
        handoffId: plannerTurnHandoff.id,
        chatId: plannerTurnHandoff.chatId,
        result: plannerTurnHandoff.result,
        recentMessages: Array.isArray(plannerTurnHandoff.recentMessages)
          ? plannerTurnHandoff.recentMessages.map((item) => String(item || ""))
          : [],
        injectionText: String(plannerTurnHandoff.injectionText || ""),
        source: plannerTurnHandoff.source || "planner-handoff",
        sourceLabel: plannerTurnHandoff.sourceLabel || "Planner handoff",
        reason: "planner-handoff-reuse",
      };
    }

    const recallKey = transactionRecallKey;
    const shouldRun = deps.shouldRunRecallForTransaction(transaction, hookName);

    return {
      hookName,
      generationType: boundRecallOptions.generationType,
      recallKey,
      transaction,
      recallOptions: boundRecallOptions,
      shouldRun,
      guardReason: shouldRun ? "" : "transaction-not-runnable",
    };
  }

  return {
    buildPreGenerationRecallKey,
    resolveGenerationRecallDeliveryMode,
    beginGenerationRecallTransaction,
    findRecentGenerationRecallTransactionForChat,
    markGenerationRecallTransactionHookState,
    getGenerationRecallTransactionResult,
    storeGenerationRecallTransactionResult,
    readGenerationRecallTransactionFinalResolution,
    storeGenerationRecallTransactionFinalResolution,
    clearGenerationRecallTransactionsForChat,
    createGenerationRecallContext,
  };
}
