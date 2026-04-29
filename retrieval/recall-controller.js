// ST-BME: 召回输入解析与注入控制器（纯函数）

import { debugLog } from "../runtime/debug-logging.js";
import { isSystemMessageForExtraction } from "../maintenance/chat-history.js";

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
    if (isSystemMessageForExtraction(message, { index, chat })) continue;
    recentMessages.unshift(runtime.formatRecallContextLine(message));
  }

  const normalizedSynthetic =
    runtime.normalizeRecallInputText(syntheticUserMessage);
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

function buildPersistedRecallReuseResult(record = {}) {
  const selectedNodeIds = Array.isArray(record?.selectedNodeIds)
    ? record.selectedNodeIds
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  return {
    injectionText: String(record?.injectionText || "").trim(),
    selectedNodeIds,
    stats: {
      coreCount: 0,
      recallCount: selectedNodeIds.length,
    },
    meta: {
      retrieval: {
        vectorHits: 0,
        vectorMergedHits: 0,
        diffusionHits: 0,
        candidatePoolAfterDpp: 0,
        persistedReuse: true,
        llm: {
          status: "persisted",
          reason: "复用已持久化召回",
          selectionProtocol: "persisted-record-reuse",
          rawSelectedKeys: [],
          resolvedSelectedKeys: [],
          resolvedSelectedNodeIds: selectedNodeIds,
          fallbackReason: "",
          fallbackType: "",
          emptySelectionAccepted: false,
          candidateKeyMapPreview: {},
          legacySelectionUsed: false,
          candidatePool: 0,
        },
      },
    },
  };
}

function resolveReusablePersistedRecallRecord(chat, recallInput, runtime) {
  const generationType = String(recallInput?.generationType || "normal").trim() || "normal";
  if (generationType === "normal") return null;

  const targetUserMessageIndex = Number.isFinite(recallInput?.targetUserMessageIndex)
    ? Math.floor(Number(recallInput.targetUserMessageIndex))
    : null;
  if (!Number.isFinite(targetUserMessageIndex)) return null;

  const targetMessage = Array.isArray(chat) ? chat[targetUserMessageIndex] : null;
  if (!targetMessage?.is_user) return null;

  const readPersistedRecallFromUserMessage = runtime.readPersistedRecallFromUserMessage;
  if (typeof readPersistedRecallFromUserMessage !== "function") return null;

  const record = readPersistedRecallFromUserMessage(chat, targetUserMessageIndex);
  if (!record?.injectionText) return null;

  const normalizeText = (value = "") =>
    typeof runtime.normalizeRecallInputText === "function"
      ? runtime.normalizeRecallInputText(value)
      : String(value ?? "")
          .replace(/\r\n/g, "\n")
          .trim();
  const currentUserFloorText = normalizeText(targetMessage?.mes || "");
  const currentRecallInputText = normalizeText(recallInput?.userMessage || "");
  const recordRecallInput = normalizeText(record?.recallInput || "");
  const boundUserFloorText = normalizeText(record?.boundUserFloorText || "");

  const matchesBoundUserFloor = Boolean(
    currentUserFloorText &&
      boundUserFloorText &&
      currentUserFloorText === boundUserFloorText,
  );
  const matchesRecallInput = Boolean(
    currentRecallInputText &&
      recordRecallInput &&
      currentRecallInputText === recordRecallInput,
  );
  const matchesCurrentUserFloor = Boolean(
    currentUserFloorText &&
      boundUserFloorText &&
      currentUserFloorText === boundUserFloorText,
  );

  if (record.authoritativeInputUsed) {
    if (!matchesBoundUserFloor) return null;
  } else if (!matchesRecallInput && !matchesCurrentUserFloor) {
    return null;
  }

  return {
    record,
    targetUserMessageIndex,
  };
}

export function resolveRecallInputController(
  chat,
  recentContextMessageLimit,
  override = null,
  runtime,
) {
  const overrideText = runtime.normalizeRecallInputText(
    override?.userMessage || override?.overrideUserMessage || "",
  );
  if (overrideText) {
    return {
      userMessage: overrideText,
      generationType: String(override?.generationType || "normal"),
      targetUserMessageIndex: Number.isFinite(override?.targetUserMessageIndex)
        ? override.targetUserMessageIndex
        : null,
      source: String(
        override?.lockedSource ||
          override?.source ||
          override?.overrideSource ||
          "override",
      ),
      sourceLabel: String(
        override?.lockedSourceLabel ||
          override?.sourceLabel ||
          override?.overrideSourceLabel ||
          "发送前拦截",
      ),
      reason: String(
        override?.lockedReason ||
          override?.reason ||
          override?.overrideReason ||
          "override-bound",
      ),
      authoritativeInputUsed: Boolean(override?.authoritativeInputUsed),
      boundUserFloorText: runtime.normalizeRecallInputText(
        override?.boundUserFloorText || "",
      ),
      sourceCandidates: Array.isArray(override?.sourceCandidates)
        ? override.sourceCandidates.map((candidate) => ({ ...candidate }))
        : [],
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
    generationType: "normal",
    targetUserMessageIndex: null,
    source,
    sourceLabel: runtime.getRecallUserMessageSourceLabel(source),
    reason: userMessage ? `${source || "unknown"}-selected` : "no-recall-input",
    authoritativeInputUsed: false,
    boundUserFloorText: tailUserText || latestUserText || "",
    sourceCandidates: [],
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
  const injectionText = String(
    typeof result?.injectionText === "string"
      ? result.injectionText
      : runtime.formatInjection(result, runtime.getSchema()),
  ).trim();
  runtime.setLastInjectionContent(injectionText);

  const retrievalMeta = result?.meta?.retrieval || {};
  const isPersistedReuse = Boolean(retrievalMeta.persistedReuse);
  const llmMeta = retrievalMeta.llm || {
    status: settings.recallEnableLLM ? "unknown" : "disabled",
    reason: settings.recallEnableLLM ? "未提供 LLM 状态" : "LLM 精排已关闭",
    selectionProtocol: "",
    rawSelectedKeys: [],
    resolvedSelectedKeys: [],
    resolvedSelectedNodeIds: [],
    fallbackReason: "",
    fallbackType: "",
    emptySelectionAccepted: false,
    candidateKeyMapPreview: {},
    legacySelectionUsed: false,
    candidatePool: 0,
  };
  const deliveryMode =
    String(recallInput?.deliveryMode || "immediate").trim() || "immediate";

  if (injectionText && !isPersistedReuse) {
    const tokens = runtime.estimateTokens(injectionText);
    debugLog(
      `[ST-BME] 注入 ${tokens} 估算 tokens, Core=${result.stats.coreCount}, Recall=${result.stats.recallCount}`,
    );
    runtime.persistRecallInjectionRecord?.({
      recallInput,
      result,
      injectionText,
      tokenEstimate: tokens,
    });
  }

  let injectionTransport = {
    applied: false,
    source: "deferred",
    mode: "deferred",
  };
  if (deliveryMode === "immediate") {
    injectionTransport =
      runtime.applyModuleInjectionPrompt(injectionText, settings) ||
      injectionTransport;
  }
  runtime.recordInjectionSnapshot("recall", {
    taskType: "recall",
    source: recallInput.source,
    sourceLabel: recallInput.sourceLabel,
    reason: recallInput.reason || "",
    authoritativeInputUsed: Boolean(recallInput.authoritativeInputUsed),
    boundUserFloorText: String(recallInput.boundUserFloorText || ""),
    sourceCandidates: Array.isArray(recallInput.sourceCandidates)
      ? recallInput.sourceCandidates.map((candidate) => ({ ...candidate }))
      : [],
    hookName: recallInput.hookName,
    recentMessages,
    selectedNodeIds: result.selectedNodeIds || [],
    retrievalMeta,
    llmMeta,
    stats: result.stats || {},
    injectionText,
    deliveryMode,
    applicationMode:
      deliveryMode === "immediate" ? "injection" : "pending-rewrite",
    rewrite: {
      applied: false,
      path: "",
      field: "",
      reason:
        deliveryMode === "immediate"
          ? "immediate-injection"
          : "awaiting-generation-payload-rewrite",
    },
    transport: injectionTransport,
  });

  runtime.setCurrentGraphLastRecallResult(result.selectedNodeIds);
  runtime.updateLastRecalledItems(result.selectedNodeIds || []);
  runtime.saveGraphToChat({ reason: "recall-result-updated" });

  const llmLabel =
    isPersistedReuse
      ? "复用召回"
      : llmMeta.status === "llm"
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
      deliveryMode === "immediate" ? "即时注入" : "等待本轮 rewrite",
      `ctx ${recentMessages.length}`,
      `vector ${retrievalMeta.vectorHits ?? 0}`,
      retrievalMeta.vectorMergedHits
        ? `merged ${retrievalMeta.vectorMergedHits}`
        : "",
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

  return {
    injectionText,
    retrievalMeta,
    llmMeta,
    transport: injectionTransport,
    deliveryMode,
  };
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

  const hasGraph = !!runtime.getCurrentGraph();
  if (!hasGraph) {
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
  const isReadableForRecall =
    typeof runtime.isGraphReadableForRecall === "function"
      ? runtime.isGraphReadableForRecall()
      : runtime.isGraphReadable();
  if (!isReadableForRecall) {
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
              options.signal.reason ||
                runtime.createAbortError("宿主已终止生成"),
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
      recallInput.deliveryMode =
        String(options.deliveryMode || "immediate").trim() || "immediate";

      debugLog("[ST-BME] 开始召回", {
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

      const cachedRecallPayload =
        options.cachedRecallPayload &&
        typeof options.cachedRecallPayload === "object"
          ? options.cachedRecallPayload
          : null;
      if (cachedRecallPayload?.result) {
        // Cached planner handoff is already the authoritative source for this
        // generation, so any leftover send-intent snapshot must be cleared to
        // avoid leaking stale input into a later fallback recall path.
        runtime.setPendingRecallSendIntent?.(runtime.createRecallInputRecord());
        const cachedResult = cachedRecallPayload.result;
        const recentMessages = Array.isArray(cachedRecallPayload.recentMessages)
          ? cachedRecallPayload.recentMessages.map((item) => String(item || ""))
          : recallInput.recentMessages;
        const applied = runtime.applyRecallInjection(
          settings,
          recallInput,
          recentMessages,
          cachedResult,
        );
        runtime.consumePlannerRecallHandoff?.(cachedRecallPayload.chatId, {
          handoffId: cachedRecallPayload.handoffId,
        });
        return runtime.createRecallRunResult("completed", {
          reason: cachedRecallPayload.reason || "planner-handoff-reused",
          selectedNodeIds: cachedResult.selectedNodeIds || [],
          injectionText: applied?.injectionText || "",
          retrievalMeta: applied?.retrievalMeta || {},
          llmMeta: applied?.llmMeta || {},
          transport: applied?.transport || {
            applied: false,
            source: "none",
            mode: "none",
          },
          deliveryMode:
            applied?.deliveryMode ||
            String(recallInput?.deliveryMode || "immediate").trim() ||
            "immediate",
          source: recallInput?.source || cachedRecallPayload.source || "",
          sourceLabel:
            recallInput?.sourceLabel || cachedRecallPayload.sourceLabel || "",
          authoritativeInputUsed: Boolean(recallInput?.authoritativeInputUsed),
          boundUserFloorText: String(recallInput?.boundUserFloorText || ""),
          hookName: recallInput?.hookName || "",
          sourceCandidates: Array.isArray(recallInput?.sourceCandidates)
            ? recallInput.sourceCandidates.map((candidate) => ({
                ...candidate,
              }))
            : [],
          stats: cachedResult?.stats || {},
        });
      }

      const persistedReuse = resolveReusablePersistedRecallRecord(
        chat,
        recallInput,
        runtime,
      );
      if (persistedReuse) {
        const normalizedBoundUserFloorText =
          typeof runtime.normalizeRecallInputText === "function"
            ? runtime.normalizeRecallInputText(
                persistedReuse.record.boundUserFloorText ||
                  recallInput.boundUserFloorText ||
                  "",
              )
            : String(
                persistedReuse.record.boundUserFloorText ||
                  recallInput.boundUserFloorText ||
                  "",
              )
                .replace(/\r\n/g, "\n")
                .trim();
        const effectiveRecallInput = {
          ...recallInput,
          source: "persisted-user-floor",
          sourceLabel: "复用用户楼层召回",
          reason: "persisted-user-floor-reuse",
          authoritativeInputUsed: Boolean(
            persistedReuse.record.authoritativeInputUsed ||
              recallInput.authoritativeInputUsed,
          ),
          boundUserFloorText: normalizedBoundUserFloorText,
        };
        const reusedResult = buildPersistedRecallReuseResult(persistedReuse.record);
        const applied = runtime.applyRecallInjection(
          settings,
          effectiveRecallInput,
          recentMessages,
          reusedResult,
        );
        const bumpedRecord =
          typeof runtime.bumpPersistedRecallGenerationCount === "function"
            ? runtime.bumpPersistedRecallGenerationCount(
                chat,
                persistedReuse.targetUserMessageIndex,
              )
            : null;
        if (bumpedRecord) {
          runtime.triggerChatMetadataSave?.(context, { immediate: false });
          runtime.schedulePersistedRecallMessageUiRefresh?.();
        }
        return runtime.createRecallRunResult("completed", {
          reason: "persisted-user-floor-reused",
          selectedNodeIds: reusedResult.selectedNodeIds || [],
          injectionText: applied?.injectionText || reusedResult.injectionText || "",
          retrievalMeta: applied?.retrievalMeta || reusedResult.meta?.retrieval || {},
          llmMeta:
            applied?.llmMeta || reusedResult.meta?.retrieval?.llm || {},
          transport: applied?.transport || {
            applied: false,
            source: "none",
            mode: "none",
          },
          deliveryMode:
            applied?.deliveryMode ||
            String(effectiveRecallInput?.deliveryMode || "immediate").trim() ||
            "immediate",
          source: effectiveRecallInput.source || "",
          sourceLabel: effectiveRecallInput.sourceLabel || "",
          authoritativeInputUsed: Boolean(
            effectiveRecallInput.authoritativeInputUsed,
          ),
          boundUserFloorText: String(
            effectiveRecallInput.boundUserFloorText || "",
          ),
          hookName: effectiveRecallInput.hookName || "",
          sourceCandidates: Array.isArray(effectiveRecallInput.sourceCandidates)
            ? effectiveRecallInput.sourceCandidates.map((candidate) => ({
                ...candidate,
              }))
            : [],
          stats: reusedResult?.stats || {},
          recallInput: String(persistedReuse.record.recallInput || ""),
        });
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
              { syncRuntime: false, noticeMarquee: true },
          );
        },
        options: runtime.buildRecallRetrieveOptions(settings, context),
      });

      const applied = runtime.applyRecallInjection(
        settings,
        recallInput,
        recentMessages,
        result,
      );
      return runtime.createRecallRunResult("completed", {
        reason: "召回完成",
        selectedNodeIds: result.selectedNodeIds || [],
        injectionText: applied?.injectionText || "",
        retrievalMeta: applied?.retrievalMeta || {},
        llmMeta: applied?.llmMeta || {},
        transport: applied?.transport || {
          applied: false,
          source: "none",
          mode: "none",
        },
        deliveryMode:
          applied?.deliveryMode ||
          String(recallInput?.deliveryMode || "immediate").trim() ||
          "immediate",
        source: recallInput?.source || "",
        sourceLabel: recallInput?.sourceLabel || "",
        authoritativeInputUsed: Boolean(recallInput?.authoritativeInputUsed),
        boundUserFloorText: String(recallInput?.boundUserFloorText || ""),
        hookName: recallInput?.hookName || "",
        sourceCandidates: Array.isArray(recallInput?.sourceCandidates)
          ? recallInput.sourceCandidates.map((candidate) => ({ ...candidate }))
          : [],
        stats: result?.stats || {},
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
