export function registerBeforeCombinePromptsController(runtime, listener) {
  const makeFirst = runtime.getEventMakeFirst();
  if (typeof makeFirst === "function") {
    return makeFirst(
      runtime.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS,
      listener,
    );
  }

  runtime.console.warn("[ST-BME] eventMakeFirst 不可用，回退到普通事件注册");
  runtime.eventSource.on(runtime.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, listener);
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
  runtime.eventSource.on(runtime.eventTypes.GENERATION_AFTER_COMMANDS, listener);
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
      runtime.recordRecallSendIntent(runtime.getSendTextareaValue(), "send-button");
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

  eventSource.on(eventTypes.CHAT_CHANGED, handlers.onChatChanged);
  if (eventTypes.CHAT_LOADED) {
    eventSource.on(eventTypes.CHAT_LOADED, handlers.onChatLoaded);
  }
  if (eventTypes.MESSAGE_SENT) {
    eventSource.on(eventTypes.MESSAGE_SENT, handlers.onMessageSent);
  }

  runtime.registerGenerationAfterCommands(handlers.onGenerationAfterCommands);
  runtime.registerBeforeCombinePrompts(handlers.onBeforeCombinePrompts);

  eventSource.on(eventTypes.MESSAGE_RECEIVED, handlers.onMessageReceived);
  eventSource.on(eventTypes.MESSAGE_DELETED, handlers.onMessageDeleted);
  eventSource.on(eventTypes.MESSAGE_EDITED, handlers.onMessageEdited);
  eventSource.on(eventTypes.MESSAGE_SWIPED, handlers.onMessageSwiped);
  if (eventTypes.MESSAGE_UPDATED) {
    eventSource.on(eventTypes.MESSAGE_UPDATED, handlers.onMessageEdited);
  }
}

export function onChatChangedController(runtime) {
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

  const context = runtime.getContext();
  const chat = context?.chat;
  const recallOptions = runtime.buildGenerationAfterCommandsRecallInput(
    type,
    params,
    chat,
  );
  if (!recallOptions) return;

  const recallContext = runtime.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: String(type || "normal").trim() || "normal",
    recallOptions,
  });
  if (!recallContext.shouldRun) {
    return;
  }

  runtime.markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    "running",
  );
  const recallResult = await runtime.runRecall({
    ...recallOptions,
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
  const context = runtime.getContext();
  const chat = context?.chat;
  const recallOptions =
    runtime.buildNormalGenerationRecallInput(chat) ||
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

  runtime.markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    "running",
  );
  const recallResult = await runtime.runRecall({
    ...recallOptions,
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
  if (runtime.getCurrentGraph()) {
    if (
      runtime.getGraphPersistenceState()?.pendingPersist &&
      runtime.isGraphMetadataWriteAllowed()
    ) {
      runtime.maybeFlushQueuedGraphPersist("message-received-pending-flush");
    }
    runtime.maybeCaptureGraphShadowSnapshot("message-received-passive-sync");
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
