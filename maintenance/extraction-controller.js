// ST-BME: 提取编排控制器（纯函数）
// 通过 runtime 依赖注入，避免直接访问 index.js 模块级状态。

import { debugLog } from "../runtime/debug-logging.js";

function toSafeFloor(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
}

function clampIntValue(value, fallback = 0, min = 0, max = 9999) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function isAssistantFloor(runtime, chat, index) {
  if (!Array.isArray(chat)) return false;
  const message = chat[index];
  if (!message) return false;
  if (typeof runtime?.isAssistantChatMessage === "function") {
    return Boolean(
      runtime.isAssistantChatMessage(message, {
        index,
        chat,
      }),
    );
  }
  return Boolean(message) && !message.is_user && !message.is_system;
}

function getAssistantTurnsFallback(runtime, chat = []) {
  if (!Array.isArray(chat)) return [];
  const assistantTurns = [];
  for (let index = 0; index < chat.length; index++) {
    if (!isAssistantFloor(runtime, chat, index)) continue;
    if (!String(chat[index]?.mes ?? "").trim()) continue;
    assistantTurns.push(index);
  }
  return assistantTurns;
}

function normalizeSmartTriggerDecision(decision = null) {
  if (!decision || typeof decision !== "object") {
    return { triggered: false, score: 0, reasons: [] };
  }
  return {
    triggered: decision.triggered === true,
    score: Number.isFinite(Number(decision.score)) ? Number(decision.score) : 0,
    reasons: Array.isArray(decision.reasons)
      ? decision.reasons.map((item) => String(item || "")).filter(Boolean)
      : [],
  };
}

export function resolveAutoExtractionPlanController(
  runtime,
  {
    chat = null,
    settings = null,
    lastProcessedAssistantFloor = null,
    lockedEndFloor = null,
  } = {},
) {
  const resolvedChat = Array.isArray(chat)
    ? chat
    : runtime?.getContext?.()?.chat || [];
  const resolvedSettings =
    settings && typeof settings === "object"
      ? settings
      : runtime?.getSettings?.() || {};
  const safeLastProcessedAssistantFloor = toSafeFloor(
    lastProcessedAssistantFloor,
    toSafeFloor(runtime?.getLastProcessedAssistantFloor?.(), -1),
  );
  const safeLockedEndFloor = toSafeFloor(lockedEndFloor, null);
  const strategy =
    resolvedSettings.extractAutoDelayLatestAssistant === true
      ? "lag-one-assistant"
      : "normal";
  const extractEvery = clampIntValue(
    resolvedSettings.extractEvery,
    1,
    1,
    50,
  );
  const assistantTurns =
    typeof runtime?.getAssistantTurns === "function"
      ? runtime.getAssistantTurns(resolvedChat)
      : getAssistantTurnsFallback(runtime, resolvedChat);
  const pendingAssistantTurns = assistantTurns.filter(
    (floor) => floor > safeLastProcessedAssistantFloor,
  );
  const candidateAssistantTurns =
    safeLockedEndFloor == null
      ? pendingAssistantTurns
      : pendingAssistantTurns.filter((floor) => floor <= safeLockedEndFloor);

  let eligibleAssistantTurns = candidateAssistantTurns;
  let waitingForNextAssistant = false;
  if (safeLockedEndFloor == null && strategy === "lag-one-assistant") {
    if (candidateAssistantTurns.length <= 1) {
      eligibleAssistantTurns = [];
      waitingForNextAssistant = candidateAssistantTurns.length === 1;
    } else {
      eligibleAssistantTurns = candidateAssistantTurns.slice(0, -1);
    }
  }

  const eligibleEndFloor =
    eligibleAssistantTurns.length > 0
      ? eligibleAssistantTurns[eligibleAssistantTurns.length - 1]
      : null;
  const smartTriggerDecision =
    resolvedSettings.enableSmartTrigger && eligibleEndFloor != null
      ? normalizeSmartTriggerDecision(
          runtime?.getSmartTriggerDecision?.(
            resolvedChat,
            safeLastProcessedAssistantFloor,
            resolvedSettings,
            eligibleEndFloor,
          ),
        )
      : { triggered: false, score: 0, reasons: [] };
  const meetsExtractEvery = eligibleAssistantTurns.length >= extractEvery;
  const canRun =
    eligibleAssistantTurns.length > 0 &&
    (meetsExtractEvery || smartTriggerDecision.triggered);
  const batchAssistantTurns = canRun
    ? smartTriggerDecision.triggered
      ? eligibleAssistantTurns
      : eligibleAssistantTurns.slice(0, extractEvery)
    : [];
  const plannedBatchEndFloor =
    batchAssistantTurns.length > 0
      ? batchAssistantTurns[batchAssistantTurns.length - 1]
      : null;

  let reason = "";
  if (pendingAssistantTurns.length === 0) {
    reason = "no-unprocessed-assistant-turns";
  } else if (candidateAssistantTurns.length === 0) {
    reason =
      safeLockedEndFloor == null
        ? "no-candidate-assistant-turns"
        : "locked-target-missing";
  } else if (waitingForNextAssistant) {
    reason = "waiting-next-assistant";
  } else if (!canRun && !smartTriggerDecision.triggered) {
    reason = "below-extract-every";
  }

  return {
    strategy,
    chat: resolvedChat,
    settings: resolvedSettings,
    lastProcessedAssistantFloor: safeLastProcessedAssistantFloor,
    lockedEndFloor: safeLockedEndFloor,
    extractEvery,
    pendingAssistantTurns,
    candidateAssistantTurns,
    eligibleAssistantTurns,
    eligibleEndFloor,
    waitingForNextAssistant,
    smartTriggerDecision,
    meetsExtractEvery,
    canRun,
    batchAssistantTurns,
    plannedBatchEndFloor,
    startIdx: batchAssistantTurns[0] ?? null,
    endIdx: plannedBatchEndFloor,
    reason,
  };
}

export async function executeExtractionBatchController(
  runtime,
  {
    chat,
    startIdx,
    endIdx,
    settings,
    smartTriggerDecision = null,
    signal = undefined,
  } = {},
) {
  runtime.ensureCurrentGraphRuntimeState();
  runtime.throwIfAborted(signal, "提取已终止");

  const currentGraph = runtime.getCurrentGraph();
  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const extractionCountBefore = runtime.getExtractionCount();
  const beforeSnapshot = runtime.cloneGraphSnapshot(currentGraph);
  const messages = runtime.buildExtractionMessages(chat, startIdx, endIdx, settings);
  const batchStatus = runtime.createBatchStatusSkeleton({
    processedRange: [startIdx, endIdx],
    extractionCountBefore,
  });

  debugLog(
    `[ST-BME] 开始提取: 楼层 ${startIdx}-${endIdx}` +
      (smartTriggerDecision?.triggered
        ? ` [智能触发 score=${smartTriggerDecision.score}; ${smartTriggerDecision.reasons.join(" / ")}]`
        : ""),
  );

  const result = await runtime.extractMemories({
    graph: currentGraph,
    messages,
    startSeq: startIdx,
    endSeq: endIdx,
    lastProcessedSeq: lastProcessed,
    schema: runtime.getSchema(),
    embeddingConfig: runtime.getEmbeddingConfig(),
    extractPrompt: undefined,
    settings,
    signal,
    onStreamProgress: ({ previewText, receivedChars }) => {
      const preview =
        previewText?.length > 60 ? "…" + previewText.slice(-60) : previewText || "";
      runtime.setLastExtractionStatus(
        "AI 生成中",
        `${preview}  [${receivedChars}字]`,
        "running",
        { noticeMarquee: true },
      );
    },
  });

  if (!result.success) {
    runtime.setBatchStageOutcome(
      batchStatus,
      "core",
      "failed",
      result?.error || "提取阶段未返回有效操作",
    );
    runtime.finalizeBatchStatus(batchStatus, runtime.getExtractionCount());
    runtime.getCurrentGraph().historyState.lastBatchStatus = batchStatus;
    return {
      success: false,
      result,
      effects: null,
      batchStatus,
      error: result?.error || "提取阶段未返回有效操作",
    };
  }

  runtime.setBatchStageOutcome(batchStatus, "core", "success");
  const effects = await runtime.handleExtractionSuccess(
    result,
    endIdx,
    settings,
    signal,
    batchStatus,
  );
  const batchStatusRef = effects?.batchStatus || batchStatus;
  const persistResult = runtime.saveGraphToChat({
    reason: "extraction-batch-complete",
    persistMetadata: true,
    captureShadow: true,
    immediate: true,
  });
  const persistAccepted = Boolean(
    persistResult?.saved || persistResult?.queued,
  );

  if (!persistAccepted) {
    runtime.setBatchStageOutcome(
      batchStatusRef,
      "finalize",
      "failed",
      `图谱持久化失败: ${persistResult?.reason || "unknown-persist-failure"}`,
    );
  }
  const finalizedBatchStatus = runtime.finalizeBatchStatus(
    batchStatusRef,
    runtime.getExtractionCount(),
  );

  runtime.getCurrentGraph().historyState.lastBatchStatus = {
    ...finalizedBatchStatus,
    historyAdvanced: runtime.shouldAdvanceProcessedHistory(finalizedBatchStatus),
    persist: persistResult
      ? {
          saved: Boolean(persistResult.saved),
          queued: Boolean(persistResult.queued),
          blocked: Boolean(persistResult.blocked),
          reason: String(persistResult.reason || ""),
          saveMode: String(persistResult.saveMode || ""),
          revision: Number.isFinite(Number(persistResult.revision))
            ? Number(persistResult.revision)
            : 0,
        }
      : null,
  };

  if (runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanced) {
    runtime.updateProcessedHistorySnapshot(chat, endIdx);
  } else if (!persistAccepted) {
    runtime.setLastExtractionStatus(
      "提取待恢复",
      `楼层 ${startIdx}-${endIdx} 已抽取但未确认写盘成功，请稍后重试或检查持久化状态`,
      "warning",
      { syncRuntime: true },
    );
    runtime.console?.warn?.("[ST-BME] extraction persist not accepted", {
      chatId: runtime.getGraphPersistenceState?.()?.chatId || "",
      persist: persistResult,
      processedRange: [startIdx, endIdx],
    });
  }

  const afterSnapshot = runtime.cloneGraphSnapshot(runtime.getCurrentGraph());
  const postProcessArtifacts = runtime.computePostProcessArtifacts(
    beforeSnapshot,
    afterSnapshot,
    effects?.postProcessArtifacts || [],
  );
  runtime.appendBatchJournal(
    runtime.getCurrentGraph(),
    runtime.createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
      processedRange: [startIdx, endIdx],
      postProcessArtifacts,
      vectorHashesInserted: effects?.vectorHashesInserted || [],
      extractionCountBefore,
    }),
  );

  return {
    success: finalizedBatchStatus.completed,
    result,
    effects,
    batchStatus: finalizedBatchStatus,
    error: finalizedBatchStatus.completed
      ? ""
      : effects?.vectorError ||
        finalizedBatchStatus.errors?.[0] ||
        "批次未完成 finalize 闭环",
  };
}

export async function runExtractionController(runtime, options = {}) {
  const lockedEndFloor = toSafeFloor(options?.lockedEndFloor, null);
  const triggerSource = String(options?.triggerSource || "auto").trim() || "auto";
  const settings = runtime.getSettings?.() || {};
  const context = runtime.getContext?.() || {};
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const plan = resolveAutoExtractionPlanController(runtime, {
    chat,
    settings,
    lockedEndFloor,
  });
  const deferredTargetEndFloor =
    plan.plannedBatchEndFloor ?? lockedEndFloor;

  if (runtime.getIsExtracting()) {
    runtime.console?.debug?.("[ST-BME] auto extraction deferred: extraction already in progress");
    runtime.deferAutoExtraction?.("extracting", {
      targetEndFloor: deferredTargetEndFloor,
      strategy: plan.strategy,
    });
    return;
  }

  if (!settings.enabled) return;
  if (!runtime.ensureGraphMutationReady("自动提取", { notify: false })) {
    runtime.console?.debug?.("[ST-BME] auto extraction blocked: graph-not-ready", {
      loadState: runtime.getGraphPersistenceState?.()?.loadState || "",
    });
    runtime.deferAutoExtraction?.("graph-not-ready", {
      targetEndFloor: deferredTargetEndFloor,
      strategy: plan.strategy,
    });
    runtime.setLastExtractionStatus(
      "等待图谱加载",
      runtime.getGraphMutationBlockReason("自动提取"),
      "warning",
      { syncRuntime: true },
    );
    return;
  }

  if (!runtime.getCurrentGraph()) {
    runtime.ensureCurrentGraphRuntimeState?.();
  }

  if (!(await runtime.recoverHistoryIfNeeded("auto-extract"))) {
    runtime.console?.debug?.("[ST-BME] auto extraction paused during history recovery", {
      recovering: runtime.getIsRecoveringHistory?.() === true,
    });
    if (runtime.getIsRecoveringHistory?.()) {
      runtime.deferAutoExtraction?.("history-recovering", {
        targetEndFloor: deferredTargetEndFloor,
        strategy: plan.strategy,
      });
    }
    return;
  }

  if (!chat || chat.length === 0) return;
  if (!plan.canRun || plan.startIdx == null || plan.endIdx == null) {
    return;
  }

  const startIdx = plan.startIdx;
  const endIdx = plan.endIdx;
  const smartTriggerDecision = plan.smartTriggerDecision;
  runtime.setIsExtracting(true);
  const extractionController = runtime.beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  runtime.setLastExtractionStatus(
    "提取中",
    `楼层 ${startIdx}-${endIdx}${smartTriggerDecision.triggered ? " · 智能触发" : ""}${triggerSource !== "auto" ? ` · ${triggerSource}` : ""}`,
    "running",
    { syncRuntime: true },
  );

  try {
    const batchResult = await runtime.executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
      smartTriggerDecision,
      signal: extractionSignal,
    });

    if (!batchResult.success) {
      const message =
        batchResult.error ||
        batchResult?.result?.error ||
        "提取批次未返回有效结果";
      runtime.console.warn("[ST-BME] 提取批次未返回有效结果:", message);
      runtime.notifyExtractionIssue(message);
      return;
    }

    runtime.setLastExtractionStatus(
      "提取完成",
      `楼层 ${startIdx}-${endIdx} · 新建 ${batchResult.result?.newNodes || 0} · 更新 ${batchResult.result?.updatedNodes || 0} · 新边 ${batchResult.result?.newEdges || 0}`,
      "success",
      { syncRuntime: true },
    );
  } catch (e) {
    if (runtime.isAbortError(e)) {
      runtime.setLastExtractionStatus(
        "提取已终止",
        e?.message || "已手动终止当前提取",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    runtime.console.error("[ST-BME] 提取失败:", e);
    runtime.notifyExtractionIssue(e?.message || String(e) || "自动提取失败");
  } finally {
    runtime.finishStageAbortController("extraction", extractionController);
    runtime.setIsExtracting(false);
  }
}

export async function onManualExtractController(runtime, options = {}) {
  if (runtime.getIsExtracting()) {
    runtime.toastr.info("记忆提取正在进行中，请稍候");
    return;
  }
  if (!runtime.ensureGraphMutationReady("手动提取")) return;
  if (!(await runtime.recoverHistoryIfNeeded("manual-extract"))) return;
  if (!runtime.getCurrentGraph()) {
    runtime.setCurrentGraph(
      runtime.normalizeGraphRuntimeState(
        runtime.createEmptyGraph(),
        runtime.getCurrentChatId(),
      ),
    );
  }

  const context = runtime.getContext();
  const chat = context.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    runtime.toastr.info("当前聊天为空，暂无可提取内容");
    return;
  }

  const assistantTurns = runtime.getAssistantTurns(chat);
  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const pendingAssistantTurns = assistantTurns.filter((i) => i > lastProcessed);
  if (pendingAssistantTurns.length === 0) {
    runtime.toastr.info("没有待提取的新回复");
    return;
  }

  const settings = runtime.getSettings();
  const extractEvery = runtime.clampInt(settings.extractEvery, 1, 1, 50);
  const totals = {
    newNodes: 0,
    updatedNodes: 0,
    newEdges: 0,
    batches: 0,
  };
  const warnings = [];

  runtime.setIsExtracting(true);
  const extractionController = runtime.beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  runtime.setLastExtractionStatus(
    "手动提取中",
    `待处理 assistant 楼层 ${pendingAssistantTurns.length} 条`,
    "running",

    { syncRuntime: true, toastKind: "info", toastTitle: "ST-BME 手动提取" },
  );
  try {
    while (true) {
      const pendingTurns = runtime
        .getAssistantTurns(chat)
        .filter((i) => i > runtime.getLastProcessedAssistantFloor());
      if (pendingTurns.length === 0) break;

      const batchAssistantTurns = pendingTurns.slice(0, extractEvery);
      const startIdx = batchAssistantTurns[0];
      const endIdx = batchAssistantTurns[batchAssistantTurns.length - 1];
      const batchResult = await runtime.executeExtractionBatch({
        chat,
        startIdx,
        endIdx,
        settings,
        signal: extractionSignal,
      });

      if (!batchResult.success) {
        throw new Error(
          batchResult.error ||
            batchResult?.result?.error ||
            "手动提取未返回有效结果",
        );
      }

      totals.newNodes += batchResult.result.newNodes || 0;
      totals.updatedNodes += batchResult.result.updatedNodes || 0;
      totals.newEdges += batchResult.result.newEdges || 0;
      totals.batches++;

      if (Array.isArray(batchResult.effects?.warnings)) {
        warnings.push(...batchResult.effects.warnings);
      }

      if (options?.drainAll === false) {
        break;
      }
    }

    if (totals.batches === 0) {
      runtime.setLastExtractionStatus(
        "无待提取内容",
        "没有新的 assistant 回复需要处理",
        "info",
        {
          syncRuntime: true,
        },
      );
      runtime.toastr.info("没有待提取的新回复");
      return;
    }

    runtime.toastr.success(
      `提取完成：${totals.batches} 批，新建 ${totals.newNodes}，更新 ${totals.updatedNodes}，新边 ${totals.newEdges}`,
    );
    runtime.setLastExtractionStatus(
      "手动提取完成",
      `${totals.batches} 批 · 新建 ${totals.newNodes} · 更新 ${totals.updatedNodes} · 新边 ${totals.newEdges}`,
      "success",
      {
        syncRuntime: true,
        toastKind: "success",
        toastTitle: "ST-BME 手动提取",
      },
    );
    if (warnings.length > 0) {
      runtime.toastr.warning(warnings.slice(0, 2).join("；"), "ST-BME 提取警告", {
        timeOut: 5000,
      });
    }
  } catch (e) {
    if (runtime.isAbortError(e)) {
      runtime.setLastExtractionStatus(
        "手动提取已终止",
        e?.message || "已手动终止当前提取",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    runtime.console.error("[ST-BME] 手动提取失败:", e);
    runtime.setLastExtractionStatus("手动提取失败", e?.message || String(e), "error", {
      syncRuntime: true,
      toastKind: "",
      toastTitle: "ST-BME 手动提取",
    });
    runtime.toastr.error(`手动提取失败: ${e.message || e}`);
  } finally {
    runtime.finishStageAbortController("extraction", extractionController);
    runtime.setIsExtracting(false);
    runtime.refreshPanelLiveState();
  }
}

export async function onRerollController(runtime, { fromFloor } = {}) {
  if (runtime.getIsExtracting?.()) {
    runtime.toastr?.info?.("记忆提取正在进行中，请稍候");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "busy",
      affectedBatchCount: 0,
      error: "记忆提取正在进行中",
    };
  }

  if (
    typeof runtime.ensureGraphMutationReady === "function" &&
    !runtime.ensureGraphMutationReady("重新提取")
  ) {
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: Number.isFinite(fromFloor) ? fromFloor : null,
      effectiveFromFloor: null,
      recoveryPath: runtime.getGraphPersistenceState?.()?.loadState || "graph-not-ready",
      affectedBatchCount: 0,
      error:
        typeof runtime.getGraphMutationBlockReason === "function"
          ? runtime.getGraphMutationBlockReason("重新提取")
          : "重新提取已暂停：图谱尚未就绪。",
    };
  }

  if (!runtime.getCurrentGraph?.()) {
    runtime.toastr?.info?.("图谱为空，无需重 Roll");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "empty-graph",
      affectedBatchCount: 0,
      error: "图谱为空",
    };
  }

  const context = runtime.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    runtime.toastr?.info?.("当前聊天为空");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "empty-chat",
      affectedBatchCount: 0,
      error: "当前聊天为空",
    };
  }

  let targetFloor = Number.isFinite(fromFloor) ? fromFloor : null;
  if (targetFloor === null) {
    const assistantTurns = runtime.getAssistantTurns(chat);
    if (assistantTurns.length === 0) {
      runtime.toastr?.info?.("聊天中没有 AI 回复");
      return {
        success: false,
        rollbackPerformed: false,
        extractionTriggered: false,
        requestedFloor: null,
        effectiveFromFloor: null,
        recoveryPath: "no-assistant-turn",
        affectedBatchCount: 0,
        error: "聊天中没有 AI 回复",
      };
    }
    targetFloor = assistantTurns[assistantTurns.length - 1];
  }

  runtime.setRuntimeStatus(
    "重新提取中",
    Number.isFinite(targetFloor)
      ? `准备从楼层 ${targetFloor} 开始回滚并重新提取`
      : "准备回滚最新 AI 楼并重新提取",
    "running",
  );

  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const alreadyExtracted = targetFloor <= lastProcessed;

  if (!alreadyExtracted) {
    runtime.toastr?.info?.("该楼层尚未提取，直接执行提取…", "ST-BME 重 Roll", {
      timeOut: 2000,
    });
    await runtime.onManualExtract();
    return {
      success: true,
      rollbackPerformed: false,
      extractionTriggered: true,
      requestedFloor: targetFloor,
      effectiveFromFloor: lastProcessed + 1,
      recoveryPath: "direct-extract",
      affectedBatchCount: 0,
      extractionStatus: runtime.getLastExtractionStatusLevel?.() || "idle",
      error: "",
    };
  }

  debugLog(`[ST-BME] 重 Roll 开始，目标楼层: ${targetFloor}`);
  let rollbackResult;
  try {
    rollbackResult = await runtime.rollbackGraphForReroll(targetFloor, context);
  } catch (e) {
    if (runtime.isAbortError(e)) {
      runtime.setRuntimeStatus(
        "重新提取已取消",
        e.message || "聊天已切换",
        "warning",
      );
      return {
        success: false,
        rollbackPerformed: false,
        extractionTriggered: false,
        requestedFloor: targetFloor,
        effectiveFromFloor: null,
        recoveryPath: "aborted",
        affectedBatchCount: 0,
        error: e.message || "聊天已切换，重新提取已取消",
      };
    }
    throw e;
  }

  if (!rollbackResult?.success) {
    runtime.setRuntimeStatus(
      "重新提取失败",
      rollbackResult.error || "回滚失败",
      "error",
    );
    runtime.toastr?.error?.(rollbackResult.error, "ST-BME 重 Roll");
    return rollbackResult;
  }

  const rerollDesc =
    rollbackResult.effectiveFromFloor !== targetFloor
      ? `已按批次边界回滚到楼层 ${rollbackResult.effectiveFromFloor} 开始重新提取…`
      : `已回滚到楼层 ${targetFloor} 开始重新提取…`;
  runtime.toastr?.info?.(rerollDesc, "ST-BME 重 Roll", {
    timeOut: 2500,
  });

  await runtime.onManualExtract({ drainAll: false });
  runtime.refreshPanelLiveState();
  return {
    ...rollbackResult,
    extractionTriggered: true,
    extractionStatus: runtime.getLastExtractionStatusLevel?.() || "idle",
  };
}
