export function shouldAdvanceProcessedHistory(batchStatus) {
  if (!batchStatus || typeof batchStatus !== "object") return false;
  if (batchStatus.historyAdvanceAllowed === true) {
    return true;
  }
  if (batchStatus.historyAdvanceAllowed === false) {
    return false;
  }
  return (
    batchStatus?.stages?.core?.outcome === "success" &&
    batchStatus?.stages?.finalize?.outcome === "success" &&
    batchStatus?.completed === true
  );
}

export async function handleExtractionSuccessController(
  runtime,
  {
    result,
    endIdx,
    settings,
    signal = undefined,
    status = undefined,
    postProcessContext = null,
  },
) {
  const {
    clonePlanCommitValue,
    consolidateMemories,
    createAbortError,
    createBatchStatusSkeleton,
    ensureCurrentGraphRuntimeState,
    finalizeBatchStatus,
    getContext,
    getEmbeddingConfig,
    getSchema,
    getSummaryStageLabel,
    getVectorIndexStats,
    isAbortError,
    pushBatchStageArtifact,
    resolveMaintenancePostProcessConcurrency,
    runCompressionPostProcessPlanCommit,
    runReflectionPostProcessPlanCommit,
    setBatchStageOutcome,
    setLastExtractionStatus,
    setLastVectorStatus,
    shouldDeferExtractionMaintenance,
    shouldDeferExtractionVectorSync,
    sleepCycle,
    syncVectorState,
    throwIfAborted,
    updateLastExtractedItems,
    getExtractionCount,
    setExtractionCount,
    getCurrentGraph,
    EXTRACTION_VECTOR_SYNC_TIMEOUT_MS,
  } = runtime;

  status = status || createBatchStatusSkeleton({
    processedRange: [endIdx, endIdx],
    extractionCountBefore: getExtractionCount(),
  });
  const postProcessArtifacts = [];
  const newNodeCount = Array.isArray(result?.newNodeIds)
    ? result.newNodeIds.length
    : 0;
  const resolveAutoConsolidationGate =
    typeof runtime.evaluateAutoConsolidationGate === "function"
      ? runtime.evaluateAutoConsolidationGate
      : (count, analysis = null, localSettings = {}) => {
          const minNewNodes = Math.max(
            1,
            Math.min(
              50,
              Math.floor(
                Number(localSettings?.consolidationAutoMinNewNodes ?? 2),
              ) || 2,
            ),
          );
          const safeCount = Math.max(0, Number(count) || 0);
          if (safeCount >= minNewNodes) {
            return {
              shouldRun: true,
              minNewNodes,
              reason: `本批新增 ${safeCount} 个节点，达到自动整合门槛 ${minNewNodes}`,
              matchedScore: null,
              matchedNodeId: "",
            };
          }
          if (analysis?.triggered) {
            return {
              shouldRun: true,
              minNewNodes,
              reason:
                String(analysis.reason || "").trim() ||
                "检测到高重复风险，已触发自动整合",
              matchedScore: Number.isFinite(Number(analysis?.matchedScore))
                ? Number(analysis.matchedScore)
                : null,
              matchedNodeId: String(analysis?.matchedNodeId || ""),
            };
          }
          return {
            shouldRun: false,
            minNewNodes,
            reason:
              String(analysis?.reason || "").trim() ||
              `本批新增少且无明显重复风险，跳过自动整合`,
            matchedScore: Number.isFinite(Number(analysis?.matchedScore))
              ? Number(analysis.matchedScore)
              : null,
            matchedNodeId: String(analysis?.matchedNodeId || ""),
          };
        };
  const analyzeConsolidationGate =
    typeof runtime.analyzeAutoConsolidationGate === "function"
      ? runtime.analyzeAutoConsolidationGate
      : async () => ({
          triggered: false,
          reason: "本批新增少且无明显重复风险，跳过自动整合",
          matchedScore: null,
          matchedNodeId: "",
        });
  const resolveAutoCompressionSchedule =
    typeof runtime.evaluateAutoCompressionSchedule === "function"
      ? runtime.evaluateAutoCompressionSchedule
      : (currentCount, localSettings = {}) => {
          const enabled = localSettings?.enableAutoCompression !== false;
          const parsedEveryN = Math.floor(Number(localSettings?.compressionEveryN));
          const everyN =
            Number.isFinite(parsedEveryN) && parsedEveryN >= 1
              ? Math.min(500, parsedEveryN)
              : 10;
          const safeCount = Math.max(0, Number(currentCount) || 0);
          if (!enabled) {
            return {
              scheduled: false,
              everyN,
              nextExtractionCount: null,
              reason: "自动压缩开关已关闭",
            };
          }
          const remainder = safeCount % everyN;
          if (remainder !== 0) {
            return {
              scheduled: false,
              everyN,
              nextExtractionCount: safeCount + (everyN - remainder),
              reason: `当前为第 ${safeCount} 次提取，未到每 ${everyN} 次自动压缩周期`,
            };
          }
          return {
            scheduled: true,
            everyN,
            nextExtractionCount: safeCount + everyN,
            reason: "",
          };
        };
  const inspectCompressionCandidates =
    typeof runtime.inspectAutoCompressionCandidates === "function"
      ? runtime.inspectAutoCompressionCandidates
      : () => ({
          hasCandidates: false,
          reason: "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组",
        });
  const applyMaintenanceGateNote =
    typeof runtime.noteMaintenanceGate === "function"
      ? runtime.noteMaintenanceGate
      : (batchStatus, action, reason) => {
          if (!batchStatus || !reason) return;
          batchStatus.maintenanceGateApplied = true;
          const details = Array.isArray(batchStatus.maintenanceGateDetails)
            ? batchStatus.maintenanceGateDetails
            : [];
          details.push({
            action: String(action || "").trim() || "unknown",
            reason: String(reason || ""),
          });
          batchStatus.maintenanceGateDetails = details;
          batchStatus.maintenanceGateReason = details
            .map((item) => `${item.action}: ${item.reason}`)
            .join(" | ");
        };
  const summarizeMaintenance =
    typeof runtime.summarizeMaintenance === "function"
      ? runtime.summarizeMaintenance
      : (action, maintenanceResult, mode = "manual") => {
          const prefix = mode === "auto" ? "自动" : "手动";
          switch (String(action || "")) {
            case "compress":
              return `${prefix}压缩：新增 ${maintenanceResult?.created || 0}，归档 ${maintenanceResult?.archived || 0}`;
            case "consolidate":
              return `${prefix}整合：合并 ${maintenanceResult?.merged || 0}，跳过 ${maintenanceResult?.skipped || 0}，保留 ${maintenanceResult?.kept || 0}，进化 ${maintenanceResult?.evolved || 0}，新链接 ${maintenanceResult?.connections || 0}，回溯更新 ${maintenanceResult?.updates || 0}`;
            case "sleep":
              return `${prefix}遗忘：归档 ${maintenanceResult?.forgotten || 0} 个节点`;
            default:
              return `${prefix}维护已执行`;
          }
        };
  const runSummaryPostProcess = runtime.runSummaryPostProcess;
  const summaryStageLabel = getSummaryStageLabel();
  const cloneMaintenanceSnapshot =
    typeof runtime.cloneMaintenanceSnapshot === "function"
      ? runtime.cloneMaintenanceSnapshot
      : (value) => JSON.parse(JSON.stringify(value ?? null));
  const persistMaintenanceAction =
    typeof runtime.persistMaintenanceAction === "function"
      ? runtime.persistMaintenanceAction
      : () => null;
  const updateExtractionPostProcessStatus =
    typeof runtime.updateExtractionPostProcessStatus === "function"
      ? runtime.updateExtractionPostProcessStatus
      : (
          text,
          meta,
          { noticeMarquee = false } = {},
        ) => {
          if (typeof setLastExtractionStatus !== "function") return;
          setLastExtractionStatus(text, meta, "running", {
            syncRuntime: true,
            noticeMarquee,
          });
        };
  const deferredMaintenance = [];
  const maintenancePostProcessConcurrency =
    resolveMaintenancePostProcessConcurrency(settings);
  const enqueueDeferredMaintenance = (task) => {
    if (!task || typeof task !== "object" || !task.type) return null;
    const normalizedTask = {
      id: String(task.id || `${task.type}:${Date.now()}:${endIdx}`),
      type: String(task.type),
      mode: maintenancePostProcessConcurrency.mode,
      reason: String(task.reason || `background-${task.type}-after-extraction`),
      payload:
        task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
          ? clonePlanCommitValue(task.payload, {})
          : {},
    };
    deferredMaintenance.push(normalizedTask);
    status.backgroundMaintenanceQueued = true;
    status.backgroundMaintenanceMode = normalizedTask.mode;
    status.backgroundMaintenanceTasks = deferredMaintenance.map((item) => ({
      id: item.id,
      type: item.type,
      reason: item.reason,
    }));
    pushBatchStageArtifact(status, "finalize", `${normalizedTask.type}-queued`);
    return normalizedTask;
  };
  throwIfAborted(signal, "提取已终止");
  const nextExtractionCount = getExtractionCount() + 1;
  setExtractionCount(nextExtractionCount);
  const extractionCount = nextExtractionCount;
  ensureCurrentGraphRuntimeState();
  const currentGraph = getCurrentGraph();
  currentGraph.historyState.extractionCount = extractionCount;
  updateLastExtractedItems(result.newNodeIds || []);
  setBatchStageOutcome(status, "core", "success");
  updateExtractionPostProcessStatus(
    "提取收尾中",
    `已抽取 ${newNodeCount} 个新节点，正在处理后续阶段`,
  );

  const consolidationCandidateNodeIds = Array.from(
    new Set(
      [
        ...(Array.isArray(postProcessContext?.pendingAutoConsolidationNodeIds)
          ? postProcessContext.pendingAutoConsolidationNodeIds
          : []),
        ...(Array.isArray(result?.newNodeIds) ? result.newNodeIds : []),
      ]
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );
  const consolidationCandidateCount = consolidationCandidateNodeIds.length;

  if (settings.enableConsolidation && consolidationCandidateCount > 0) {
    const suppressAutoConsolidation =
      postProcessContext?.suppressAutoConsolidation === true;
    if (suppressAutoConsolidation) {
      const reason =
        String(postProcessContext?.autoConsolidationSuppressReason || "").trim() ||
        "批量提取进行中，已跳过本批自动整合";
      status.consolidationGateTriggered = false;
      status.consolidationGateReason = reason;
      status.consolidationGateSimilarity = null;
      status.consolidationGateMatchedNodeId = "";
      applyMaintenanceGateNote(status, "consolidate", reason);
      pushBatchStageArtifact(status, "structural", "consolidation-skipped");
    } else {
      let consolidationAnalysis = null;
      const minNewNodes = Math.max(
        1,
        Math.min(
          50,
          Math.floor(Number(settings?.consolidationAutoMinNewNodes ?? 2)) || 2,
        ),
      );
      if (consolidationCandidateCount < minNewNodes) {
        updateExtractionPostProcessStatus(
          "整合判定中",
          `本窗口候选 ${consolidationCandidateCount} 个节点，正在检查是否需要自动整合/进化`,
        );
        consolidationAnalysis = await analyzeConsolidationGate({
          graph: currentGraph,
          newNodeIds: consolidationCandidateNodeIds,
          embeddingConfig: getEmbeddingConfig(),
          schema: getSchema(),
          conflictThreshold: settings.consolidationThreshold,
          signal,
        });
      }
      const gate = resolveAutoConsolidationGate(
        consolidationCandidateCount,
        consolidationAnalysis,
        settings,
      );
      status.consolidationGateTriggered = Boolean(gate.shouldRun);
      status.consolidationGateReason = String(gate.reason || "");
      status.consolidationGateSimilarity = Number.isFinite(
        Number(gate.matchedScore),
      )
        ? Number(gate.matchedScore)
        : null;
      status.consolidationGateMatchedNodeId = String(gate.matchedNodeId || "");
      if (!gate.shouldRun) {
        applyMaintenanceGateNote(status, "consolidate", gate.reason);
        pushBatchStageArtifact(status, "structural", "consolidation-skipped");
      } else {
        try {
          updateExtractionPostProcessStatus(
            "整合/进化中",
            String(gate.reason || "").trim() || "正在自动整合新旧记忆",
          );
          const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
          const consolidationResult = await consolidateMemories({
            graph: currentGraph,
            newNodeIds: consolidationCandidateNodeIds,
            embeddingConfig: getEmbeddingConfig(),
            options: {
              neighborCount: settings.consolidationNeighborCount,
              conflictThreshold: settings.consolidationThreshold,
            },
            settings,
            signal,
          });
          persistMaintenanceAction({
            action: "consolidate",
            beforeSnapshot,
            mode: "auto",
            summary: summarizeMaintenance(
              "consolidate",
              consolidationResult,
              "auto",
            ),
          });
          postProcessArtifacts.push("consolidation");
          pushBatchStageArtifact(status, "structural", "consolidation");
        } catch (e) {
          if (isAbortError(e)) throw e;
          const message = e?.message || String(e) || "记忆整合阶段失败";
          setBatchStageOutcome(
            status,
            "structural",
            "partial",
            `记忆整合失败: ${message}`,
          );
          console.error("[ST-BME] 记忆整合失败:", e);
        }
      }
    }
  }

  if (settings.enableHierarchicalSummary !== false) {
    try {
      const currentChatMessages =
        typeof getContext === "function" && Array.isArray(getContext()?.chat)
          ? getContext().chat
          : [];
      const summaryPayload = {
        chat: clonePlanCommitValue(currentChatMessages, []),
        currentExtractionCount: extractionCount,
        currentAssistantFloor: endIdx,
        currentRange: result?.processedRange || [endIdx, endIdx],
        currentNodeIds: result?.changedNodeIds || result?.newNodeIds || [],
      };
      if (shouldDeferExtractionMaintenance(settings)) {
        enqueueDeferredMaintenance({
          type: "summary",
          reason: "background-summary-after-extraction",
          payload: summaryPayload,
        });
        updateExtractionPostProcessStatus(
          "层级总结已排队",
          `${maintenancePostProcessConcurrency.mode} 模式：层级总结将在批次持久化后后台执行`,
        );
        pushBatchStageArtifact(status, "semantic", "summary-queued");
      } else {
        updateExtractionPostProcessStatus(
          summaryStageLabel === "旧式全局概要生成" ? "旧式全局概要更新中" : "层级总结处理中",
          summaryStageLabel === "旧式全局概要生成"
            ? `${extractionCount} 次提取，正在生成旧式全局概要`
            : `${extractionCount} 次提取，正在检查小总结与折叠总结`,
        );
        const summaryResult = await runSummaryPostProcess({
          graph: currentGraph,
          chat: currentChatMessages,
          settings,
          signal,
          ...summaryPayload,
        });
        if (summaryResult?.smallSummary?.created) {
          postProcessArtifacts.push("summary");
          pushBatchStageArtifact(status, "semantic", "summary");
        } else if (summaryResult?.smallSummary?.reason) {
          applyMaintenanceGateNote(status, "summary", summaryResult.smallSummary.reason);
        }
        if (Number(summaryResult?.rollup?.createdCount || 0) > 0) {
          postProcessArtifacts.push("summary-rollup");
          pushBatchStageArtifact(status, "semantic", "summary-rollup");
        }
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || `${summaryStageLabel}阶段失败`;
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `${summaryStageLabel}失败: ${message}`,
      );
      console.error(`[ST-BME] ${summaryStageLabel}失败:`, e);
    }
  }

  if (
    settings.enableReflection &&
    extractionCount % settings.reflectEveryN === 0
  ) {
    try {
      const reflectionPayload = { currentSeq: endIdx };
      if (shouldDeferExtractionMaintenance(settings)) {
        enqueueDeferredMaintenance({
          type: "reflection",
          reason: "background-reflection-after-extraction",
          payload: reflectionPayload,
        });
        updateExtractionPostProcessStatus(
          "反思生成已排队",
          `${maintenancePostProcessConcurrency.mode} 模式：长期反思将在批次持久化后后台执行`,
        );
        pushBatchStageArtifact(status, "semantic", "reflection-queued");
      } else {
        updateExtractionPostProcessStatus(
          "反思生成中",
          `${extractionCount} 次提取，正在生成长期反思`,
        );
        const reflectionResult = await runReflectionPostProcessPlanCommit({
          graph: currentGraph,
          currentSeq: endIdx,
          schema: getSchema(),
          embeddingConfig: getEmbeddingConfig(),
          settings,
          signal,
        });
        if (reflectionResult?.reflectionId) {
          postProcessArtifacts.push("reflection");
          pushBatchStageArtifact(status, "semantic", "reflection");
        }
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || "反思生成阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `反思生成失败: ${message}`,
      );
      console.error("[ST-BME] 反思生成失败:", e);
    }
  }

  if (
    settings.enableSleepCycle &&
    extractionCount % settings.sleepEveryN === 0
  ) {
    try {
      updateExtractionPostProcessStatus(
        "主动遗忘中",
        `${extractionCount} 次提取，正在归档低价值记忆`,
      );
      const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
      const sleepResult = sleepCycle(currentGraph, settings);
      if ((sleepResult?.forgotten || 0) > 0) {
        persistMaintenanceAction({
          action: "sleep",
          beforeSnapshot,
          mode: "auto",
          summary: summarizeMaintenance("sleep", sleepResult, "auto"),
        });
        postProcessArtifacts.push("sleep");
        pushBatchStageArtifact(status, "semantic", "sleep");
      }
    } catch (e) {
      const message = e?.message || String(e) || "主动遗忘阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `主动遗忘失败: ${message}`,
      );
      console.error("[ST-BME] 主动遗忘失败:", e);
    }
  }

  const compressionSchedule = resolveAutoCompressionSchedule(
    extractionCount,
    settings,
  );
  status.autoCompressionScheduled = Boolean(compressionSchedule.scheduled);
  status.nextCompressionAtExtractionCount =
    compressionSchedule.nextExtractionCount;
  status.autoCompressionSkippedReason = compressionSchedule.reason || "";

  try {
    throwIfAborted(signal, "提取已终止");
    if (compressionSchedule.scheduled) {
      const compressionInspection = inspectCompressionCandidates(
        currentGraph,
        getSchema(),
        false,
      );
      if (!compressionInspection?.hasCandidates) {
        status.autoCompressionSkippedReason =
          String(compressionInspection?.reason || "").trim() ||
          "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组";
        pushBatchStageArtifact(status, "structural", "compression-skipped");
      } else {
        status.autoCompressionSkippedReason = "";
        if (shouldDeferExtractionMaintenance(settings)) {
          enqueueDeferredMaintenance({
            type: "compression",
            reason: "background-compression-after-extraction",
            payload: {
              force: false,
              customPrompt: null,
            },
          });
          updateExtractionPostProcessStatus(
            "自动压缩已排队",
            `${maintenancePostProcessConcurrency.mode} 模式：层级压缩将在批次持久化后后台执行`,
          );
          pushBatchStageArtifact(status, "structural", "compression-queued");
        } else {
          updateExtractionPostProcessStatus(
            "自动压缩中",
            `已到第 ${extractionCount} 次提取周期，正在压缩层级记忆`,
          );
          const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
          const compressionResult = await runCompressionPostProcessPlanCommit({
            graph: currentGraph,
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            force: false,
            customPrompt: undefined,
            signal,
            settings,
          });
          if (compressionResult.created > 0 || compressionResult.archived > 0) {
            persistMaintenanceAction({
              action: "compress",
              beforeSnapshot,
              mode: "auto",
              summary: summarizeMaintenance(
                "compress",
                compressionResult,
                "auto",
              ),
            });
            postProcessArtifacts.push("compression");
            pushBatchStageArtifact(status, "structural", "compression");
          } else {
            status.autoCompressionSkippedReason =
              "已尝试自动压缩，但本轮未产生可持久化变化";
          }
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error?.message || String(error) || "压缩阶段失败";
    setBatchStageOutcome(
      status,
      "structural",
      "partial",
      `压缩阶段失败: ${message}`,
    );
    console.error("[ST-BME] 记忆压缩失败:", error);
  }

  let vectorSync = null;
  let backgroundVectorSync = null;
  const vectorSyncRangeSource = Array.isArray(result?.processedRange)
    ? result.processedRange
    : Array.isArray(status?.processedRange)
      ? status.processedRange
      : [endIdx, endIdx];
  const vectorSyncRange = {
    start: Math.min(
      Number(vectorSyncRangeSource[0] ?? endIdx),
      Number(vectorSyncRangeSource[1] ?? endIdx),
    ),
    end: Math.max(
      Number(vectorSyncRangeSource[0] ?? endIdx),
      Number(vectorSyncRangeSource[1] ?? endIdx),
    ),
  };
  if (shouldDeferExtractionVectorSync(settings)) {
    const concurrency = resolveMaintenancePostProcessConcurrency(settings);
    ensureCurrentGraphRuntimeState();
    currentGraph.vectorIndexState ||= {};
    currentGraph.vectorIndexState.dirty = true;
    currentGraph.vectorIndexState.dirtyReason = "background-vector-sync-queued";
    currentGraph.vectorIndexState.lastWarning =
      `${concurrency.mode} 模式已将本批向量同步放入后台队列`;
    backgroundVectorSync = {
      enabled: true,
      mode: concurrency.mode,
      id: `vector-sync:${Date.now()}:${endIdx}`,
      reason: "background-vector-sync-after-extraction",
      range: vectorSyncRange,
    };
    status.backgroundVectorSyncQueued = true;
    status.backgroundVectorSyncMode = concurrency.mode;
    status.backgroundVectorSyncTaskId = backgroundVectorSync.id;
    updateExtractionPostProcessStatus(
      "向量同步已排队",
      `${concurrency.mode} 模式：本批向量将在持久化后后台同步`,
    );
    if (typeof setLastVectorStatus === "function") {
      setLastVectorStatus(
        "后台向量已排队",
        `${concurrency.mode} 模式 · 等待批次持久化确认`,
        "running",
        { syncRuntime: false },
      );
    }
    pushBatchStageArtifact(status, "finalize", "vector-sync-queued");
    setBatchStageOutcome(status, "finalize", "success");
  } else {
    try {
      updateExtractionPostProcessStatus(
        "向量同步中",
        "正在同步本批提取后的向量索引",
      );
      const vectorSyncTimeoutController = new AbortController();
      const vectorSyncTimeout = setTimeout(
        () => vectorSyncTimeoutController.abort(
          new DOMException(
            `向量同步超时 (${Math.round(EXTRACTION_VECTOR_SYNC_TIMEOUT_MS / 1000)}s)`,
            "AbortError",
          ),
        ),
        EXTRACTION_VECTOR_SYNC_TIMEOUT_MS,
      );
      let vectorSyncSignal = vectorSyncTimeoutController.signal;
      if (signal) {
        try {
          if (typeof AbortSignal.any === "function") {
            vectorSyncSignal = AbortSignal.any([signal, vectorSyncTimeoutController.signal]);
          }
        } catch {}
      }
      try {
        vectorSync = await syncVectorState({ signal: vectorSyncSignal });
      } finally {
        clearTimeout(vectorSyncTimeout);
      }
    } catch (error) {
      if (isAbortError(error)) {
        const isVectorSyncTimeout = error?.name === "AbortError" &&
          typeof error?.message === "string" &&
          error.message.includes("向量同步超时");
        if (!isVectorSyncTimeout) throw error;
      }
      const message = error?.message || String(error) || "向量同步阶段失败";
      setBatchStageOutcome(
        status,
        "finalize",
        "failed",
        `向量同步失败: ${message}`,
      );
      return {
        postProcessArtifacts,
        vectorHashesInserted: [],
        vectorStats: getVectorIndexStats(currentGraph),
        vectorError: message,
        warnings: status.warnings,
        batchStatus: finalizeBatchStatus(status, extractionCount),
        backgroundVectorSync: null,
        backgroundMaintenance: deferredMaintenance,
      };
    }

    if (vectorSync?.aborted) {
      throw createAbortError(vectorSync.error || "提取已终止");
    }
    if (vectorSync?.error) {
      setBatchStageOutcome(
        status,
        "finalize",
        "failed",
        `向量同步失败: ${vectorSync.error}`,
      );
    } else {
      setBatchStageOutcome(status, "finalize", "success");
    }
  }

  status.maintenanceJournalSize =
    currentGraph?.maintenanceJournal?.length || 0;
  if (
    status.maintenanceGateApplied &&
    !status.maintenanceGateReason &&
    Array.isArray(status.maintenanceGateDetails)
  ) {
    status.maintenanceGateReason = status.maintenanceGateDetails
      .map((item) => `${item.action}: ${item.reason}`)
      .join(" | ");
  }

  return {
    postProcessArtifacts,
    vectorHashesInserted: vectorSync?.insertedHashes || [],
    vectorStats: vectorSync?.stats || getVectorIndexStats(currentGraph),
    vectorError: vectorSync?.error || "",
    warnings: status.warnings,
    batchStatus: finalizeBatchStatus(status, extractionCount),
    backgroundVectorSync,
    backgroundMaintenance: deferredMaintenance,
  };

}
