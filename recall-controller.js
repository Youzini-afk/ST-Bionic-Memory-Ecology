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

export async function runRecallController(runtime, options = {}) {
  if (runtime.getIsRecalling()) {
    runtime.abortRecallStageWithReason("旧召回已取消，正在启动新的召回");
    const settle = await runtime.waitForActiveRecallToSettle();
    if (!settle.settled && runtime.getIsRecalling()) {
      runtime.setLastRecallStatus(
        "召回忙",
        "上一轮召回仍在清理，请稍后重试",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return runtime.createRecallRunResult("skipped", {
        reason: "上一轮召回仍在清理",
      });
    }
  }

  if (!runtime.getCurrentGraph()) {
    return runtime.createRecallRunResult("skipped", {
      reason: "当前无图谱",
    });
  }

  const settings = runtime.getSettings();
  if (!settings.enabled || !settings.recallEnabled) {
    return runtime.createRecallRunResult("skipped", {
      reason: "召回功能未启用",
    });
  }
  if (!runtime.isGraphReadable()) {
    const reason = runtime.getGraphMutationBlockReason("召回");
    runtime.setLastRecallStatus("等待图谱加载", reason, "warning", {
      syncRuntime: true,
    });
    return runtime.createRecallRunResult("skipped", {
      reason,
    });
  }
  if (runtime.isGraphMetadataWriteAllowed()) {
    if (!(await runtime.recoverHistoryIfNeeded("pre-recall"))) {
      return runtime.createRecallRunResult("skipped", {
        reason: "历史恢复未就绪",
      });
    }
  }

  const context = runtime.getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) {
    return runtime.createRecallRunResult("skipped", {
      reason: "当前聊天为空",
    });
  }

  const runId = runtime.nextRecallRunSequence();
  let recallPromise = null;
  recallPromise = (async () => {
    runtime.setIsRecalling(true);
    const recallController = runtime.beginStageAbortController("recall");
    const recallSignal = recallController.signal;
    if (options.signal) {
      if (options.signal.aborted) {
        recallController.abort(
          options.signal.reason || runtime.createAbortError("宿主已终止生成"),
        );
      } else {
        options.signal.addEventListener(
          "abort",
          () =>
            recallController.abort(
              options.signal.reason || runtime.createAbortError("宿主已终止生成"),
            ),
          { once: true },
        );
      }
    }

    try {
      await runtime.ensureVectorReadyIfNeeded("pre-recall", recallSignal);
      const recentContextMessageLimit = runtime.clampInt(
        settings.recallLlmContextMessages,
        4,
        0,
        20,
      );
      const recallInput = runtime.resolveRecallInput(
        chat,
        recentContextMessageLimit,
        options,
      );
      const userMessage = recallInput.userMessage;
      const recentMessages = recallInput.recentMessages;

      if (!userMessage) {
        return runtime.createRecallRunResult("skipped", {
          reason: "当前没有可用于召回的用户输入",
        });
      }

      recallInput.hookName = options.hookName || "";

      runtime.console.log("[ST-BME] 开始召回", {
        source: recallInput.source,
        sourceLabel: recallInput.sourceLabel,
        hookName: recallInput.hookName,
        userMessageLength: userMessage.length,
        recentMessages: recentMessages.length,
        runId,
      });
      runtime.setLastRecallStatus(
        "召回中",
        [
          runtime.getRecallHookLabel(recallInput.hookName),
          `来源 ${recallInput.sourceLabel}`,
          `上下文 ${recentMessages.length} 条`,
          `当前用户消息长度 ${userMessage.length}`,
        ]
          .filter(Boolean)
          .join(" · "),
        "running",
        { syncRuntime: true },
      );
      if (recallInput.source === "send-intent") {
        runtime.setPendingRecallSendIntent(runtime.createRecallInputRecord());
      }

      const result = await runtime.retrieve({
        graph: runtime.getCurrentGraph(),
        userMessage,
        recentMessages,
        embeddingConfig: runtime.getEmbeddingConfig(),
        schema: runtime.getSchema(),
        signal: recallSignal,
        settings,
        onStreamProgress: ({ previewText, receivedChars }) => {
          const preview =
            previewText?.length > 60
              ? "…" + previewText.slice(-60)
              : previewText || "";
          runtime.setLastRecallStatus(
            "AI 生成中",
            `${preview}  [${receivedChars}字]`,
            "running",
            { syncRuntime: true, noticeMarquee: true },
          );
        },
        options: runtime.buildRecallRetrieveOptions(settings, context),
      });

      runtime.applyRecallInjection(settings, recallInput, recentMessages, result);
      return runtime.createRecallRunResult("completed", {
        reason: "召回完成",
        selectedNodeIds: result.selectedNodeIds || [],
      });
    } catch (e) {
      if (runtime.isAbortError(e)) {
        runtime.setLastRecallStatus(
          "召回已终止",
          e?.message || "已手动终止当前召回",
          "warning",
          {
            syncRuntime: true,
          },
        );
        return runtime.createRecallRunResult("aborted", {
          reason: e?.message || "召回已终止",
        });
      }
      runtime.console.error("[ST-BME] 召回失败:", e);
      const message = e?.message || String(e);
      runtime.setLastRecallStatus("召回失败", message, "error", {
        syncRuntime: true,
        toastKind: "",
      });
      runtime.toastr.error(`召回失败: ${message}`);
      return runtime.createRecallRunResult("failed", {
        reason: message,
      });
    } finally {
      runtime.finishStageAbortController("recall", recallController);
      runtime.setIsRecalling(false);
      if (runtime.getActiveRecallPromise() === recallPromise) {
        runtime.setActiveRecallPromise(null);
      }
      runtime.refreshPanelLiveState();
    }
  })();

  runtime.setActiveRecallPromise(recallPromise);
  return await recallPromise;
}
