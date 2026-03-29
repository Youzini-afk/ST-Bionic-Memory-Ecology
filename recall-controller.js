// ST-BME: 召回输入解析与注入控制器（纯函数）

export function buildRecallRecentMessagesController(
  chat,
  limit,
  syntheticUserMessage = "",
  runtime,
) {
  if (!Array.isArray(chat) || limit <= 0) return [];

  const recentMessages = [];
  for (
    let index = chat.length - 1;
    index >= 0 && recentMessages.length < limit;
    index--
  ) {
    const message = chat[index];
    if (message?.is_system) continue;
    recentMessages.unshift(runtime.formatRecallContextLine(message));
  }

  const normalizedSynthetic = runtime.normalizeRecallInputText(
    syntheticUserMessage,
  );
  if (!normalizedSynthetic) return recentMessages;

  const syntheticLine = `[user]: ${normalizedSynthetic}`;
  if (recentMessages[recentMessages.length - 1] !== syntheticLine) {
    recentMessages.push(syntheticLine);
    while (recentMessages.length > limit) {
      recentMessages.shift();
    }
  }

  return recentMessages;
}

export function getRecallUserMessageSourceLabelController(source) {
  switch (source) {
    case "send-intent":
      return "发送意图";
    case "chat-tail-user":
      return "当前用户楼层";
    case "message-sent":
      return "已发送用户楼层";
    case "chat-last-user":
      return "历史最后用户楼层";
    default:
      return "未知";
  }
}

export function resolveRecallInputController(
  chat,
  recentContextMessageLimit,
  override = null,
  runtime,
) {
  const overrideText = runtime.normalizeRecallInputText(
    override?.userMessage || "",
  );
  if (overrideText) {
    return {
      userMessage: overrideText,
      source: String(override?.source || "override"),
      sourceLabel: String(override?.sourceLabel || "发送前拦截"),
      recentMessages: runtime.buildRecallRecentMessages(
        chat,
        recentContextMessageLimit,
        override?.includeSyntheticUserMessage === false ? "" : overrideText,
      ),
    };
  }

  const latestUserMessage = runtime.getLatestUserChatMessage(chat);
  const latestUserText = runtime.normalizeRecallInputText(
    latestUserMessage?.mes || "",
  );
  const lastNonSystemMessage = runtime.getLastNonSystemChatMessage(chat);
  const tailUserText = lastNonSystemMessage?.is_user
    ? runtime.normalizeRecallInputText(lastNonSystemMessage?.mes || "")
    : "";
  const pendingIntentText = runtime.isFreshRecallInputRecord(
    runtime.pendingRecallSendIntent,
  )
    ? runtime.pendingRecallSendIntent.text
    : "";
  const sentUserText = runtime.isFreshRecallInputRecord(
    runtime.lastRecallSentUserMessage,
  )
    ? runtime.lastRecallSentUserMessage.text
    : "";

  let userMessage = "";
  let source = "";
  let syntheticUserMessage = "";

  if (pendingIntentText) {
    userMessage = pendingIntentText;
    source = "send-intent";
    syntheticUserMessage = pendingIntentText;
  } else if (tailUserText) {
    userMessage = tailUserText;
    source = "chat-tail-user";
  } else if (sentUserText) {
    userMessage = sentUserText;
    source = "message-sent";
    if (!latestUserText || latestUserText !== sentUserText) {
      syntheticUserMessage = sentUserText;
    }
  } else if (latestUserText) {
    userMessage = latestUserText;
    source = "chat-last-user";
  }

  return {
    userMessage,
    source,
    sourceLabel: runtime.getRecallUserMessageSourceLabel(source),
    recentMessages: runtime.buildRecallRecentMessages(
      chat,
      recentContextMessageLimit,
      syntheticUserMessage,
    ),
  };
}

export function applyRecallInjectionController(
  settings,
  recallInput,
  recentMessages,
  result,
  runtime,
) {
  const injectionText = runtime
    .formatInjection(result, runtime.getSchema())
    .trim();
  runtime.setLastInjectionContent(injectionText);

  const retrievalMeta = result?.meta?.retrieval || {};
  const llmMeta = retrievalMeta.llm || {
    status: settings.recallEnableLLM ? "unknown" : "disabled",
    reason: settings.recallEnableLLM ? "未提供 LLM 状态" : "LLM 精排已关闭",
    candidatePool: 0,
  };

  if (injectionText) {
    const tokens = runtime.estimateTokens(injectionText);
    runtime.console.log(
      `[ST-BME] 注入 ${tokens} 估算 tokens, Core=${result.stats.coreCount}, Recall=${result.stats.recallCount}`,
    );
  }

  const injectionTransport = runtime.applyModuleInjectionPrompt(
    injectionText,
    settings,
  );
  runtime.recordInjectionSnapshot("recall", {
    taskType: "recall",
    source: recallInput.source,
    sourceLabel: recallInput.sourceLabel,
    hookName: recallInput.hookName,
    recentMessages,
    selectedNodeIds: result.selectedNodeIds || [],
    retrievalMeta,
    llmMeta,
    stats: result.stats || {},
    injectionText,
    transport: injectionTransport,
  });

  runtime.setCurrentGraphLastRecallResult(result.selectedNodeIds);
  runtime.updateLastRecalledItems(result.selectedNodeIds || []);
  runtime.saveGraphToChat({ reason: "recall-result-updated" });

  const llmLabel =
    llmMeta.status === "llm"
      ? "LLM 精排完成"
      : llmMeta.status === "fallback"
        ? "LLM 回退评分"
        : llmMeta.status === "disabled"
          ? "仅评分排序"
          : "召回完成";
  const hookLabel = runtime.getRecallHookLabel(recallInput.hookName);
  runtime.setLastRecallStatus(
    llmLabel,
    [
      hookLabel,
      recallInput.sourceLabel,
      `ctx ${recentMessages.length}`,
      `vector ${retrievalMeta.vectorHits ?? 0}`,
      retrievalMeta.vectorMergedHits ? `merged ${retrievalMeta.vectorMergedHits}` : "",
      `diffusion ${retrievalMeta.diffusionHits ?? 0}`,
      retrievalMeta.candidatePoolAfterDpp
        ? `dpp ${retrievalMeta.candidatePoolAfterDpp}`
        : "",
      `llm pool ${llmMeta.candidatePool ?? 0}`,
      `recall ${result.stats.recallCount}`,
    ]
      .filter(Boolean)
      .join(" · "),
    llmMeta.status === "fallback" ? "warning" : "success",
    {
      syncRuntime: true,
      toastKind: "",
    },
  );

  if (llmMeta.status === "fallback") {
    const now = Date.now();
    if (now - runtime.getLastRecallFallbackNoticeAt() > 15000) {
      runtime.setLastRecallFallbackNoticeAt(now);
      runtime.toastr.warning(
        llmMeta.reason || "LLM 精排未成功，已改用评分排序并继续注入记忆",
        "ST-BME 召回提示",
        { timeOut: 4500 },
      );
    }
  }

  return { injectionText, retrievalMeta, llmMeta };
}
