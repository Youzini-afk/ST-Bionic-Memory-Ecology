function getTimerApi(runtime) {
  const rawSetTimeout =
    typeof runtime?.setTimeout === "function"
      ? runtime.setTimeout
      : globalThis.setTimeout;
  const rawClearTimeout =
    typeof runtime?.clearTimeout === "function"
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

function toSafeFloor(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
}

export function registerBeforeCombinePromptsController(runtime, listener) {
  const makeFirst = runtime.getEventMakeFirst();
  if (typeof makeFirst === "function") {
    return makeFirst(
      runtime.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS,
      listener,
    );
  }

  runtime.console.warn("[ST-BME] eventMakeFirst 不可用，回退到普通事件注册");
  runtime.eventSource.on(
    runtime.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS,
    listener,
  );
  return null;
}

export function registerGenerationAfterCommandsController(runtime, listener) {
  const makeFirst = runtime.getEventMakeFirst();
  const eventName = runtime.eventTypes.GENERATION_AFTER_COMMANDS;
  if (typeof makeFirst === "function") {
    const cleanup = makeFirst(eventName, listener);
    return cleanup;
  }

  runtime.console.warn(
    "[ST-BME] eventMakeFirst 不可用，GENERATION_AFTER_COMMANDS 回退到普通事件注册",
  );
  runtime.eventSource.on(eventName, listener);
  return null;
}

export function scheduleSendIntentHookRetryController(runtime, delayMs = 400) {
  const timers = getTimerApi(runtime);
  timers.clearTimeout(runtime.getSendIntentHookRetryTimer());
  const timer = timers.setTimeout(() => {
    runtime.setSendIntentHookRetryTimer(null);
    runtime.installSendIntentHooks();
  }, delayMs);
  runtime.setSendIntentHookRetryTimer(timer);
}

export function installSendIntentHooksController(runtime) {
  for (const cleanup of runtime.consumeSendIntentHookCleanup()) {
    try {
      cleanup();
    } catch (error) {
      runtime.console.warn("[ST-BME] 清理发送意图钩子失败:", error);
    }
  }

  const sendButton = runtime.document.getElementById("send_but");
  const sendTextarea = runtime.document.getElementById("send_textarea");

  if (sendButton) {
    const captureSendIntent = () => {
      runtime.recordRecallSendIntent(
        runtime.getSendTextareaValue(),
        "send-button",
      );
    };

    sendButton.addEventListener("click", captureSendIntent, true);
    sendButton.addEventListener("pointerup", captureSendIntent, true);
    sendButton.addEventListener("touchend", captureSendIntent, true);
    runtime.pushSendIntentHookCleanup(() => {
      sendButton.removeEventListener("click", captureSendIntent, true);
      sendButton.removeEventListener("pointerup", captureSendIntent, true);
      sendButton.removeEventListener("touchend", captureSendIntent, true);
    });
  }

  if (sendTextarea) {
    const captureEnterIntent = (event) => {
      if (
        (event.key === "Enter" || event.key === "NumpadEnter") &&
        !event.shiftKey
      ) {
        runtime.recordRecallSendIntent(
          runtime.getSendTextareaValue(),
          "textarea-enter",
        );
      }
    };

    sendTextarea.addEventListener("keydown", captureEnterIntent, true);
    runtime.pushSendIntentHookCleanup(() => {
      sendTextarea.removeEventListener("keydown", captureEnterIntent, true);
    });
  }

  if (!sendButton || !sendTextarea) {
    runtime.scheduleSendIntentHookRetry();
  }
}

export function registerCoreEventHooksController(runtime) {
  const { eventSource, eventTypes, handlers } = runtime;
  const registrationState = runtime.getCoreEventBindingState?.() || {};

  if (registrationState.registered) {
    runtime.console?.warn?.("[ST-BME] 核心事件已注册，跳过重复绑定");
    return registrationState;
  }

  const cleanups = [];
  const bind = (eventName, listener) => {
    if (!eventName || typeof listener !== "function") return;
    eventSource.on(eventName, listener);
    if (typeof eventSource.off === "function") {
      cleanups.push(() => eventSource.off(eventName, listener));
    } else if (typeof eventSource.removeListener === "function") {
      cleanups.push(() => eventSource.removeListener(eventName, listener));
    }
  };

  bind(eventTypes.CHAT_CHANGED, handlers.onChatChanged);
  if (eventTypes.CHAT_LOADED) {
    bind(eventTypes.CHAT_LOADED, handlers.onChatLoaded);
  }
  if (eventTypes.MESSAGE_SENT) {
    bind(eventTypes.MESSAGE_SENT, handlers.onMessageSent);
  }
  if (eventTypes.GENERATION_STARTED) {
    bind(eventTypes.GENERATION_STARTED, handlers.onGenerationStarted);
  }
  if (eventTypes.GENERATION_ENDED) {
    bind(eventTypes.GENERATION_ENDED, handlers.onGenerationEnded);
  }

  const beforeCombineCleanup = runtime.registerBeforeCombinePrompts(
    handlers.onBeforeCombinePrompts,
  );
  if (typeof beforeCombineCleanup === "function") {
    cleanups.push(beforeCombineCleanup);
  }

  const afterCommandsCleanup = runtime.registerGenerationAfterCommands(
    handlers.onGenerationAfterCommands,
  );
  if (typeof afterCommandsCleanup === "function") {
    cleanups.push(afterCommandsCleanup);
  }

  bind(eventTypes.MESSAGE_RECEIVED, handlers.onMessageReceived);
  bind(eventTypes.MESSAGE_DELETED, handlers.onMessageDeleted);
  bind(eventTypes.MESSAGE_EDITED, handlers.onMessageEdited);
  bind(eventTypes.MESSAGE_SWIPED, handlers.onMessageSwiped);
  if (eventTypes.MESSAGE_UPDATED) {
    bind(eventTypes.MESSAGE_UPDATED, handlers.onMessageEdited);
  }
  if (eventTypes.USER_MESSAGE_RENDERED) {
    bind(eventTypes.USER_MESSAGE_RENDERED, handlers.onUserMessageRendered);
  }
  if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
    bind(
      eventTypes.CHARACTER_MESSAGE_RENDERED,
      handlers.onCharacterMessageRendered,
    );
  }

  const nextState = {
    registered: true,
    cleanups,
    registeredAt: Date.now(),
  };
  runtime.setCoreEventBindingState?.(nextState);
  return nextState;
}

export function onChatChangedController(runtime) {
  const timers = getTimerApi(runtime);
  runtime.clearPendingHistoryMutationChecks();
  timers.clearTimeout(runtime.getPendingHistoryRecoveryTimer());
  runtime.setPendingHistoryRecoveryTimer(null);
  runtime.setPendingHistoryRecoveryTrigger("");
  runtime.clearPendingAutoExtraction?.();
  runtime.clearPendingGraphLoadRetry();
  runtime.setSkipBeforeCombineRecallUntil(0);
  runtime.setLastPreGenerationRecallKey("");
  runtime.setLastPreGenerationRecallAt(0);
  runtime.clearGenerationRecallTransactionsForChat("", { clearAll: true });
  runtime.abortAllRunningStages();
  runtime.dismissAllStageNotices();
  runtime.syncGraphLoadFromLiveContext({
    source: "chat-changed",
    force: true,
  });
  runtime.clearCurrentGenerationTrivialSkip?.("chat-changed");
  runtime.clearInjectionState();
  runtime.clearRecallInputTracking();
  runtime.installSendIntentHooks();
  runtime.refreshPersistedRecallMessageUi?.();
}

export function onChatLoadedController(runtime) {
  runtime.syncGraphLoadFromLiveContext({
    source: "chat-loaded",
  });
  runtime.refreshPersistedRecallMessageUi?.();
}

export function onMessageSentController(runtime, messageId) {
  const context = runtime.getContext();
  const chat = context?.chat;
  const normalizedMessageId =
    messageId === null || messageId === undefined || messageId === ""
      ? null
      : Number(messageId);
  let resolvedMessageId = Number.isFinite(normalizedMessageId)
    ? normalizedMessageId
    : null;
  let message =
    Array.isArray(chat) && Number.isFinite(resolvedMessageId)
      ? chat[resolvedMessageId]
      : null;

  if (!message?.is_user && Array.isArray(chat)) {
    for (let index = chat.length - 1; index >= 0; index--) {
      if (!chat[index]?.is_user) continue;
      resolvedMessageId = index;
      message = chat[index];
      break;
    }
  }

  if (!message?.is_user) return;
  if (runtime.isTrivialUserInput?.(message.mes || "")?.trivial) {
    runtime.refreshPersistedRecallMessageUi?.();
    return;
  }
  runtime.recordRecallSentUserMessage(
    resolvedMessageId,
    message.mes || "",
  );
  // GENERATION_AFTER_COMMANDS 在 sendMessageAsUser 之前触发，此时新用户消息
  // 尚未进入 chat，recall 记录会被写到上一条 user 上。这里用户消息刚入场，
  // transaction 仍在桥接窗口内，立即把记录重新绑定到正确的楼层。
  runtime.rebindRecallRecordToNewUserMessage?.(resolvedMessageId);
  runtime.refreshPersistedRecallMessageUi?.();
}

export function onUserMessageRenderedController(runtime, messageId = null) {
  // MESSAGE_SENT 早于实际 DOM 挂载；这里等宿主确认 user 楼层渲染完成后，
  // 再补一次 Recall Card 刷新，避免“当前楼层没卡片，下一楼才补出来”。
  runtime.refreshPersistedRecallMessageUi?.(40);
  return {
    messageId: Number.isFinite(Number(messageId)) ? Number(messageId) : null,
    refreshed: true,
    source: "user-message-rendered",
  };
}

export function onCharacterMessageRenderedController(
  runtime,
  messageId = null,
  type = "",
) {
  runtime.refreshPersistedRecallMessageUi?.(80);
  return {
    messageId: Number.isFinite(Number(messageId)) ? Number(messageId) : null,
    type: String(type || ""),
    refreshed: true,
    source: "character-message-rendered",
  };
}

export function onGenerationStartedController(
  runtime,
  type,
  params = {},
  dryRun = false,
) {
  if (dryRun) {
    runtime.markDryRunPromptPreview?.();
    return null;
  }
  runtime.clearDryRunPromptPreview?.();
  if (params?.automatic_trigger || params?.quiet_prompt) return null;

  const generationType = String(type || "normal").trim() || "normal";
  if (generationType !== "normal") return null;

  const pendingSendIntent = runtime.getPendingRecallSendIntent?.();
  const pendingIntentText = runtime.isFreshRecallInputRecord?.(
    pendingSendIntent,
  )
    ? pendingSendIntent.text
    : "";
  const textareaText =
    typeof runtime.getSendTextareaValue === "function"
      ? runtime.getSendTextareaValue()
      : "";
  const snapshotText =
    runtime.normalizeRecallInputText?.(pendingIntentText || textareaText) || "";
  const trivialInputResult = runtime.isTrivialUserInput?.(snapshotText);
  if (trivialInputResult?.trivial) {
    const context = runtime.getContext?.() || {};
    runtime.markCurrentGenerationTrivialSkip?.({
      reason: trivialInputResult.reason,
      chatId: context?.chatId || "",
      chatLength: Array.isArray(context?.chat) ? context.chat.length : 0,
    });
    runtime.clearPendingRecallSendIntent?.();
    runtime.clearPendingHostGenerationInputSnapshot?.();
    console.info?.(
      `[ST-BME] trivial-input skip: reason=${trivialInputResult.reason} len=${trivialInputResult.normalizedText.length} hook=GENERATION_STARTED`,
    );
    return null;
  }
  runtime.clearCurrentGenerationTrivialSkip?.("new-non-trivial-generation");
  return runtime.freezeHostGenerationInputSnapshot(
    snapshotText,
    pendingIntentText
      ? "generation-started-send-intent"
      : "generation-started-textarea",
  );
}

export function onMessageDeletedController(
  runtime,
  chatLengthOrMessageId,
  meta = null,
) {
  runtime.invalidateRecallAfterHistoryMutation("消息已删除");
  runtime.scheduleHistoryMutationRecheck(
    "message-deleted",
    chatLengthOrMessageId,
    meta,
  );
  runtime.refreshPersistedRecallMessageUi?.();
}

export function onMessageEditedController(runtime, messageId, meta = null) {
  if (runtime.isMvuExtraAnalysisGuardActive?.()) {
    console.debug?.("[ST-BME] skip: mvu-extra-analysis hook=MESSAGE_EDITED");
    runtime.refreshPersistedRecallMessageUi?.();
    return;
  }
  runtime.invalidateRecallAfterHistoryMutation("消息已编辑");
  runtime.scheduleHistoryMutationRecheck("message-edited", messageId, meta);
  runtime.refreshPersistedRecallMessageUi?.();
}

export async function onMessageSwipedController(runtime, messageId, meta = null) {
  runtime.invalidateRecallAfterHistoryMutation("已切换楼层 swipe");
  const parsedFloor = Number(messageId);
  const fromFloor = Number.isFinite(parsedFloor) ? parsedFloor : undefined;
  let result = {
    success: false,
    rollbackPerformed: false,
    extractionTriggered: false,
    requestedFloor: fromFloor ?? null,
    effectiveFromFloor: null,
    recoveryPath: "reroll-handler-unavailable",
    affectedBatchCount: 0,
    error: "swipe reroll handler unavailable",
  };

  if (typeof runtime.onReroll === "function") {
    try {
      result = await runtime.onReroll({ fromFloor, meta });
    } catch (error) {
      runtime.console?.error?.("[ST-BME] swipe reroll failed:", error);
      result = {
        success: false,
        rollbackPerformed: false,
        extractionTriggered: false,
        requestedFloor: fromFloor ?? null,
        effectiveFromFloor: null,
        recoveryPath: "reroll-threw",
        affectedBatchCount: 0,
        error: error?.message || String(error) || "swipe reroll failed",
      };
    }
  } else {
    runtime.console?.warn?.(
      "[ST-BME] MESSAGE_SWIPED missing onReroll; skip generic history recovery fallback.",
      { messageId, meta },
    );
  }
  runtime.refreshPersistedRecallMessageUi?.();
  return result;
}

export async function onGenerationAfterCommandsController(
  runtime,
  type,
  params = {},
  dryRun = false,
) {
  if (dryRun) {
    return;
  }

  if (runtime.isMvuExtraAnalysisGuardActive?.()) {
    console.debug?.(
      "[ST-BME] skip: mvu-extra-analysis hook=GENERATION_AFTER_COMMANDS",
    );
    return;
  }

  const generationType = String(type || "normal").trim() || "normal";
  const frozenInputSnapshot =
    generationType === "normal"
      ? runtime.consumeHostGenerationInputSnapshot?.({ preserve: true }) ||
        runtime.consumeHostGenerationInputSnapshot?.()
      : null;

  const context = runtime.getContext();
  const chat = context?.chat;

  const recallOptions = runtime.buildGenerationAfterCommandsRecallInput(
    type,
    {
      ...params,
      frozenInputSnapshot,
    },
    chat,
  );
  if (!recallOptions) {
    return;
  }
  if (recallOptions?.__trivialSkip) {
    return;
  }

  const recallContext = runtime.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType,
    recallOptions,
  });
  if (!recallContext.shouldRun && !recallContext.transaction) {
    return;
  }

  const runtimeRecallOptions =
    recallContext.recallOptions || recallOptions || {};
  if (
    params &&
    typeof params === "object" &&
    runtimeRecallOptions?.authoritativeInputUsed === true
  ) {
    const authoritativePrompt = String(
      runtimeRecallOptions?.overrideUserMessage ||
        runtimeRecallOptions?.userMessage ||
        "",
    ).trim();
    if (authoritativePrompt) {
      params.prompt = authoritativePrompt;
      if (Object.prototype.hasOwnProperty.call(params, "user_input")) {
        params.user_input = authoritativePrompt;
      }
    }
  }
  const deliveryMode =
    runtime.resolveGenerationRecallDeliveryMode?.(
      recallContext.hookName,
      recallContext.generationType,
      runtimeRecallOptions,
    ) || "immediate";
  let recallResult = runtime.getGenerationRecallTransactionResult?.(
    recallContext.transaction,
  );

  if (recallContext.shouldRun) {
    runtime.markGenerationRecallTransactionHookState(
      recallContext.transaction,
      recallContext.hookName,
      "running",
    );
    if (deliveryMode === "deferred") {
      runtime.clearLiveRecallInjectionPromptForRewrite?.();
    }
    recallResult = await runtime.runRecall({
      ...runtimeRecallOptions,
      deliveryMode,
      recallKey: recallContext.recallKey,
      hookName: recallContext.hookName,
      signal: params?.signal,
    });
    runtime.storeGenerationRecallTransactionResult?.(
      recallContext.transaction,
      recallResult,
      {
        hookName: recallContext.hookName,
        deliveryMode,
      },
    );

    runtime.markGenerationRecallTransactionHookState(
      recallContext.transaction,
      recallContext.hookName,
      runtime.getGenerationRecallHookStateFromResult(recallResult),
    );
  }

  // immediate 模式下，runRecall → applyRecallInjection 内部已通过
  // setExtensionPrompt 完成了注入，此处直接返回召回结果。
  // 后续 GENERATE_BEFORE_COMBINE_PROMPTS 阶段会通过
  // applyFinalRecallInjectionForGeneration 做 deferred rewrite 兜底。
  if (deliveryMode === "immediate") {
    runtime.ensurePersistedRecallRecordForGeneration?.({
      generationType: recallContext.generationType,
      recallResult,
      transaction: recallContext.transaction,
      recallOptions: runtimeRecallOptions,
      hookName: recallContext.hookName,
    });
    // immediate 路径通常会在 runRecall 内完成持久化；如果当时 user 楼层还没稳定，
    // 上面的兜底补写会把 fresh recall 绑定回最终 user 楼层。
    // 这里再补一次 UI 刷新，避免需要等到消息编辑/历史恢复后才看到 Recall Card。
    runtime.refreshPersistedRecallMessageUi?.();
    return recallResult;
  }

  return runtime.applyFinalRecallInjectionForGeneration({
    generationType: recallContext.generationType,
    freshRecallResult: recallResult,
    transaction: recallContext.transaction,
    hookName: recallContext.hookName,
  });
}

export async function onBeforeCombinePromptsController(
  runtime,
  promptData = null,
) {
  if (runtime.consumeDryRunPromptPreview?.()) {
    return {
      skipped: true,
      reason: "dry-run-preview",
    };
  }

  if (runtime.isMvuExtraAnalysisGuardActive?.()) {
    console.debug?.(
      "[ST-BME] skip: mvu-extra-analysis hook=GENERATE_BEFORE_COMBINE_PROMPTS",
    );
    return {
      skipped: true,
      reason: "mvu-extra-analysis",
    };
  }

  const frozenInputSnapshot =
    runtime.consumeHostGenerationInputSnapshot?.() ||
    runtime.getPendingHostGenerationInputSnapshot?.() ||
    runtime.createRecallInputRecord?.() ||
    {};
  const context = runtime.getContext();
  const chat = context?.chat;
  const normalInput = runtime.buildNormalGenerationRecallInput(chat, {
    frozenInputSnapshot,
  });
  if (normalInput?.__trivialSkip) {
    return {
      skipped: true,
      reason: `trivial:${normalInput.trivialReason || ""}`,
    };
  }
  const recallOptions =
    normalInput ||
    runtime.buildHistoryGenerationRecallInput(chat) ||
    {};
  const recallContext = runtime.createGenerationRecallContext({
    hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
    generationType: "normal",
    recallOptions,
  });
  if (!recallContext.shouldRun && !recallContext.transaction) {
    return;
  }

  const runtimeRecallOptions =
    recallContext.recallOptions || recallOptions || {};
  const deliveryMode =
    runtime.resolveGenerationRecallDeliveryMode?.(
      recallContext.hookName,
      recallContext.generationType,
      runtimeRecallOptions,
    ) || "deferred";
  let recallResult = runtime.getGenerationRecallTransactionResult?.(
    recallContext.transaction,
  );

  if (recallContext.shouldRun) {
    runtime.markGenerationRecallTransactionHookState(
      recallContext.transaction,
      recallContext.hookName,
      "running",
    );
    if (deliveryMode === "deferred") {
      runtime.clearLiveRecallInjectionPromptForRewrite?.();
    }
    recallResult = await runtime.runRecall({
      ...runtimeRecallOptions,
      deliveryMode,
      recallKey: recallContext.recallKey,
      hookName: recallContext.hookName,
    });
    runtime.storeGenerationRecallTransactionResult?.(
      recallContext.transaction,
      recallResult,
      {
        hookName: recallContext.hookName,
        deliveryMode,
      },
    );
    runtime.markGenerationRecallTransactionHookState(
      recallContext.transaction,
      recallContext.hookName,
      runtime.getGenerationRecallHookStateFromResult(recallResult),
    );
  }

  return runtime.applyFinalRecallInjectionForGeneration({
    generationType: recallContext.generationType,
    freshRecallResult: recallResult,
    transaction: recallContext.transaction,
    promptData,
    hookName: recallContext.hookName,
  });
}

export function onMessageReceivedController(
  runtime,
  messageId = null,
  _type = "",
) {
  const enqueueMicrotask =
    typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
      : typeof runtime.queueMicrotask === "function"
        ? (task) => Reflect.apply(runtime.queueMicrotask, globalThis, [task])
        : (task) => Promise.resolve().then(task);
  const persistenceState = runtime.getGraphPersistenceState?.() || {};
  const loadState = persistenceState.loadState || "";
  const dbReady =
    persistenceState.dbReady ??
    (loadState === "loaded" || loadState === "empty-confirmed");
  if (
    !dbReady ||
    loadState === "loading" ||
    loadState === "shadow-restored" ||
    loadState === "blocked"
  ) {
    runtime.syncGraphLoadFromLiveContext?.({
      source: "message-received-reconcile",
    });
  }

  if (runtime.getCurrentGraph()) {
    if (
      runtime.getGraphPersistenceState()?.pendingPersist &&
      runtime.isGraphMetadataWriteAllowed()
    ) {
      runtime.maybeFlushQueuedGraphPersist("message-received-pending-flush");
    }
  }

  const pendingRecallSendIntent = runtime.getPendingRecallSendIntent();
  if (
    pendingRecallSendIntent?.text &&
    !runtime.isFreshRecallInputRecord(pendingRecallSendIntent)
  ) {
    runtime.setPendingRecallSendIntent(runtime.createRecallInputRecord());
  }

  const context = runtime.getContext();
  const chat = context?.chat;
  const settings =
    typeof runtime.getSettings === "function" ? runtime.getSettings() : {};
  const lastProcessedAssistantFloor =
    typeof runtime.getLastProcessedAssistantFloor === "function"
      ? runtime.getLastProcessedAssistantFloor()
      : -1;
  const receivedMessage =
    Array.isArray(chat) && Number.isFinite(Number(messageId))
      ? chat[Number(messageId)]
      : null;
  const lastMessage =
    Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : null;
  const targetMessage = runtime.isAssistantChatMessage(receivedMessage)
    ? receivedMessage
    : lastMessage;
  const targetMessageIndex = runtime.isAssistantChatMessage(receivedMessage)
    ? Number(messageId)
    : runtime.isAssistantChatMessage(lastMessage)
      ? chat.length - 1
      : null;

  if (runtime.isAssistantChatMessage(targetMessage)) {
    if (runtime.consumeCurrentGenerationTrivialSkip?.(targetMessageIndex)) {
      runtime.console?.info?.(
        "[ST-BME] trivial-input skip: extraction bypassed",
        { messageId: targetMessageIndex },
      );
      runtime.refreshPersistedRecallMessageUi?.();
      return;
    }
    const autoExtractionPlan =
      typeof runtime.resolveAutoExtractionPlan === "function"
        ? runtime.resolveAutoExtractionPlan({
            chat,
            settings,
            lastProcessedAssistantFloor,
          })
        : null;
    if (!autoExtractionPlan?.canRun) {
      runtime.console?.debug?.(
        "[ST-BME] assistant message received, auto extraction not runnable yet",
        {
          messageId: Number.isFinite(Number(targetMessageIndex))
            ? Number(targetMessageIndex)
            : null,
          reason: String(autoExtractionPlan?.reason || "not-runnable"),
          strategy: String(autoExtractionPlan?.strategy || "normal"),
        },
      );
      runtime.refreshPersistedRecallMessageUi?.();
      return;
    }
    runtime.console?.debug?.(
      "[ST-BME] assistant message received, queueing auto extraction",
      {
        messageId: Number.isFinite(Number(targetMessageIndex))
          ? Number(targetMessageIndex)
          : null,
        chatLength: Array.isArray(chat) ? chat.length : 0,
        loadState,
        dbReady,
      },
    );
    if (
      runtime.getIsHostGenerationRunning?.() === true &&
      typeof runtime.deferAutoExtraction === "function"
    ) {
      runtime.console?.debug?.(
        "[ST-BME] assistant message received during host generation, deferring auto extraction",
        {
          messageId: Number.isFinite(Number(targetMessageIndex))
            ? Number(targetMessageIndex)
            : null,
          targetEndFloor: toSafeFloor(autoExtractionPlan.plannedBatchEndFloor, null),
        },
      );
      runtime.deferAutoExtraction("generation-running", {
        messageId: targetMessageIndex,
        targetEndFloor: autoExtractionPlan.plannedBatchEndFloor,
        strategy: autoExtractionPlan.strategy,
      });
      runtime.refreshPersistedRecallMessageUi?.();
      return;
    }
    enqueueMicrotask(() => {
      void runtime
        .runExtraction({
          lockedEndFloor: autoExtractionPlan.plannedBatchEndFloor,
          triggerSource: "message-received",
        })
        .catch((error) => {
        runtime.console.error("[ST-BME] 异步自动提取失败:", error);
        runtime.notifyExtractionIssue(
          error?.message || String(error) || "自动提取失败",
        );
        });
    });
  }
  runtime.refreshPersistedRecallMessageUi?.();
}
