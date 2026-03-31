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
  if (typeof makeFirst === "function") {
    return makeFirst(runtime.eventTypes.GENERATION_AFTER_COMMANDS, listener);
  }

  runtime.console.warn(
    "[ST-BME] eventMakeFirst 不可用，GENERATION_AFTER_COMMANDS 回退到普通事件注册",
  );
  runtime.eventSource.on(
    runtime.eventTypes.GENERATION_AFTER_COMMANDS,
    listener,
  );
  return null;
}

export function scheduleSendIntentHookRetryController(runtime, delayMs = 400) {
  runtime.clearTimeout(runtime.getSendIntentHookRetryTimer());
  const timer = runtime.setTimeout(() => {
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

  const nextState = {
    registered: true,
    cleanups,
    registeredAt: Date.now(),
  };
  runtime.setCoreEventBindingState?.(nextState);
  return nextState;
}

export function onChatChangedController(runtime) {
  runtime.clearCoreEventBindingState?.();
  runtime.clearPendingHistoryMutationChecks();
  runtime.clearTimeout(runtime.getPendingHistoryRecoveryTimer());
  runtime.setPendingHistoryRecoveryTimer(null);
  runtime.setPendingHistoryRecoveryTrigger("");
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
  const message =
    Array.isArray(chat) && Number.isFinite(messageId) ? chat[messageId] : null;

  if (!message?.is_user) return;
  runtime.recordRecallSentUserMessage(messageId, message.mes || "");
  runtime.refreshPersistedRecallMessageUi?.();
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
  runtime.invalidateRecallAfterHistoryMutation("消息已编辑");
  runtime.scheduleHistoryMutationRecheck("message-edited", messageId, meta);
  runtime.refreshPersistedRecallMessageUi?.();
}

export function onMessageSwipedController(runtime, messageId, meta = null) {
  runtime.invalidateRecallAfterHistoryMutation("已切换楼层 swipe");
  runtime.scheduleHistoryMutationRecheck("message-swiped", messageId, meta);
  runtime.refreshPersistedRecallMessageUi?.();
}

export async function onGenerationAfterCommandsController(
  runtime,
  type,
  params = {},
  dryRun = false,
) {
  if (dryRun) return;

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
  if (!recallOptions) return;

  const recallContext = runtime.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType,
    recallOptions,
  });
  if (!recallContext.shouldRun) {
    return;
  }

  const runtimeRecallOptions =
    recallContext.recallOptions || recallOptions || {};
  runtime.markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    "running",
  );
  const recallResult = await runtime.runRecall({
    ...runtimeRecallOptions,
    recallKey: recallContext.recallKey,
    hookName: recallContext.hookName,
    signal: params?.signal,
  });

  runtime.markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    runtime.getGenerationRecallHookStateFromResult(recallResult),
  );

  runtime.applyFinalRecallInjectionForGeneration({
    generationType: recallContext.generationType,
    freshRecallResult: recallResult,
  });
}

export async function onBeforeCombinePromptsController(runtime) {
  const frozenInputSnapshot =
    runtime.consumeHostGenerationInputSnapshot?.() ||
    runtime.getPendingHostGenerationInputSnapshot?.() ||
    runtime.createRecallInputRecord?.() ||
    {};
  const context = runtime.getContext();
  const chat = context?.chat;
  const recallOptions =
    runtime.buildNormalGenerationRecallInput(chat, {
      frozenInputSnapshot,
    }) ||
    runtime.buildHistoryGenerationRecallInput(chat) ||
    {};
  const recallContext = runtime.createGenerationRecallContext({
    hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
    generationType: "normal",
    recallOptions,
  });
  if (!recallContext.shouldRun) {
    return;
  }

  const runtimeRecallOptions =
    recallContext.recallOptions || recallOptions || {};
  runtime.markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    "running",
  );
  const recallResult = await runtime.runRecall({
    ...runtimeRecallOptions,
    recallKey: recallContext.recallKey,
    hookName: recallContext.hookName,
  });
  runtime.markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    runtime.getGenerationRecallHookStateFromResult(recallResult),
  );

  runtime.applyFinalRecallInjectionForGeneration({
    generationType: recallContext.generationType,
    freshRecallResult: recallResult,
  });
}

export function onMessageReceivedController(runtime) {
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
  const lastMessage =
    Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : null;

  if (runtime.isAssistantChatMessage(lastMessage)) {
    runtime.queueMicrotask(() => {
      void runtime.runExtraction().catch((error) => {
        runtime.console.error("[ST-BME] 异步自动提取失败:", error);
        runtime.notifyExtractionIssue(
          error?.message || String(error) || "自动提取失败",
        );
      });
    });
  }
  runtime.refreshPersistedRecallMessageUi?.();
}
