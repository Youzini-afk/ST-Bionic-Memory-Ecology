async function persistRecoveryState(saveGraphToChat, reason) {
  try {
    return await Promise.resolve(
      saveGraphToChat({ reason, awaitDurable: true }),
    );
  } catch (error) {
    return { accepted: false, error };
  }
}

async function persistDetachedRecoveryState(
  persistDetachedRecoveryGraph,
  graph,
  reason,
  context,
) {
  if (typeof persistDetachedRecoveryGraph !== "function") {
    return {
      accepted: false,
      blocked: true,
      reason: "detached-recovery-persistence-unavailable",
    };
  }
  try {
    return await Promise.resolve(
      persistDetachedRecoveryGraph(graph, { reason, context }),
    );
  } catch (error) {
    return { accepted: false, error };
  }
}

export async function rollbackGraphForRerollController(
  runtime,
  { targetFloor, context = runtime.getContext?.() } = {},
) {
  const {
    applyRecoveryPlanToVectorState,
    assertRecoveryHistoryStillCurrent,
    buildChatHistoryFingerprint,
    buildRecoveryResult,
    buildReverseJournalRecoveryPlan,
    clearInjectionState,
    cloneGraphSnapshot,
    detectHistoryMutation,
    ensureCurrentGraphRuntimeState,
    findJournalRecoveryPoint,
    getContext,
    getCurrentChatId,
    getCurrentGraph,
    getEmbeddingConfig,
    isBackendVectorConfig,
    markHistoryDirty,
    normalizeGraphRuntimeState,
    persistDetachedRecoveryGraph,
    prepareVectorStateForReplay,
    pruneProcessedMessageHashesFromFloor,
    refreshPanelLiveState,
    rollbackAffectedJournals,
    saveGraphToChat,
    setCurrentGraph,
    setExtractionCount,
    setLastExtractedItems,
    setRuntimeStatus,
    tryDeleteBackendVectorHashesForRecovery,
    updateProcessedHistorySnapshot,
  } = runtime;
  ensureCurrentGraphRuntimeState();
  let currentGraph = getCurrentGraph();
  const chatId = getCurrentChatId(context);
  const chatSnapshot = cloneGraphSnapshot(
    Array.isArray(context?.chat) ? context.chat : [],
  );
  const historyFingerprint = buildChatHistoryFingerprint(chatSnapshot);
  const assertHistoryCurrent = (label) =>
    assertRecoveryHistoryStillCurrent(chatId, historyFingerprint, label);
  const rerollStartGraph = cloneGraphSnapshot(currentGraph);
  let checkpointAccepted = false;
  let candidateAccepted = false;
  let candidatePublished = false;
  let effectiveFromFloor = null;
  const buildRerollFailure = (
    recoveryPath,
    error,
    {
      resultCode = "reroll.rollback.failed",
      affectedBatchCount = 0,
      rollbackPerformed = false,
      effectiveFromFloor = null,
      checkpointRetained = false,
      persistence = null,
    } = {},
  ) => ({
    success: false,
    rollbackPerformed,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor,
    recoveryPath,
    affectedBatchCount,
    resultCode,
    checkpointRetained,
    persistence,
    error,
  });
  const recoveryPoint = findJournalRecoveryPoint(currentGraph, targetFloor);

  if (!recoveryPoint) {
    return buildRerollFailure(
      "unavailable",
      "未找到可用的回滚点，无法安全重新提取。请先执行一次历史恢复或重新提取更早的批次。",
      {
        resultCode: "reroll.rollback.unavailable",
      },
    );
  }

  clearInjectionState();
  setLastExtractedItems([]);

  const config = getEmbeddingConfig();
  const recoveryPath = recoveryPoint.path || "unknown";
  const affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
  let recoveryPlan = null;
  if (recoveryPath === "reverse-journal") {
    recoveryPlan = buildReverseJournalRecoveryPlan(
      recoveryPoint.affectedJournals,
      targetFloor,
    );
    if (recoveryPlan?.valid === false) {
      const invalidReason = String(
        recoveryPlan.invalidReason || "unknown",
      ).trim();
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "reroll-rollback-rejected",
        {
          fromFloor: targetFloor,
          effectiveFromFloor: null,
          path: "reverse-journal",
          affectedBatchCount,
          detectionSource: "manual-reroll",
          reason: `回滚计划完整性校验失败: ${invalidReason}`,
          debugReason: `reroll-rollback-plan-invalid:${invalidReason}`,
          resultCode: "reroll.rollback.plan-invalid",
          invalidReason,
        },
      );
      saveGraphToChat({ reason: "reroll-rollback-rejected" });
      refreshPanelLiveState();
      return buildRerollFailure(
        "reverse-journal-rejected",
        `回滚计划完整性校验失败: ${invalidReason}`,
        {
          affectedBatchCount,
          resultCode: "reroll.rollback.plan-invalid",
        },
      );
    }
  } else if (recoveryPath !== "legacy-snapshot") {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "reroll-rollback-rejected",
      {
        fromFloor: targetFloor,
        effectiveFromFloor: null,
        path: recoveryPath,
        affectedBatchCount,
        detectionSource: "manual-reroll",
        reason: `不支持的回滚路径: ${recoveryPath}`,
        debugReason: `reroll-rollback-unsupported:${recoveryPath}`,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
    saveGraphToChat({ reason: "reroll-rollback-rejected" });
    refreshPanelLiveState();
    return buildRerollFailure(
      recoveryPath,
      `不支持的回滚路径: ${recoveryPath}`,
      {
        affectedBatchCount,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
  }
  const beginRerollCheckpoint = async () => {
    assertHistoryCurrent("reroll-checkpoint-start");
    markHistoryDirty(
      currentGraph,
      targetFloor,
      "manual-reroll",
      "manual-reroll",
    );
    const persistence = await persistRecoveryState(
      saveGraphToChat,
      "reroll-checkpoint-start",
    );
    if (persistence?.accepted === true) checkpointAccepted = true;
    assertHistoryCurrent("reroll-checkpoint-persisted");
    if (persistence?.accepted === true) {
      return null;
    }
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "pending-persistence",
      {
        fromFloor: targetFloor,
        path: recoveryPath,
        affectedBatchCount,
        detectionSource: "manual-reroll",
        reason: "reroll checkpoint persistence was not accepted",
        resultCode: "reroll.rollback.checkpoint-persist-failed",
      },
    );
    return buildRerollFailure(
      recoveryPath,
      "无法确认重 Roll 回滚检查点已落盘，已保留待恢复状态。",
      {
        affectedBatchCount,
        resultCode: "reroll.rollback.checkpoint-persist-failed",
        checkpointRetained: true,
        persistence,
      },
    );
  };

  try {
    const checkpointFailure = await beginRerollCheckpoint();
    if (checkpointFailure) {
      refreshPanelLiveState();
      return checkpointFailure;
    }
    let workingGraph =
      recoveryPath === "legacy-snapshot"
        ? normalizeGraphRuntimeState(
            cloneGraphSnapshot(recoveryPoint.snapshotBefore),
            chatId,
          )
        : normalizeGraphRuntimeState(cloneGraphSnapshot(currentGraph), chatId);

    if (recoveryPath === "reverse-journal") {
      rollbackAffectedJournals(workingGraph, recoveryPoint.affectedJournals);
      workingGraph = normalizeGraphRuntimeState(workingGraph, chatId);
      applyRecoveryPlanToVectorState(recoveryPlan, targetFloor, workingGraph);
    }

    if (isBackendVectorConfig(config)) {
      setRuntimeStatus(
        "重新提取准备中",
        "正在准备向量回放状态",
        "running",
      );
    }
    assertHistoryCurrent("reroll-pre-prepare");
    await prepareVectorStateForReplay(false, undefined, {
      skipBackendPurge: true,
      resetBackendMappings: recoveryPath === "legacy-snapshot",
      graph: workingGraph,
    });
    assertHistoryCurrent("reroll-post-prepare");

    effectiveFromFloor = Number.isFinite(
      workingGraph.historyState?.lastProcessedAssistantFloor,
    )
      ? workingGraph.historyState.lastProcessedAssistantFloor + 1
      : 0;

    markHistoryDirty(
      workingGraph,
      targetFloor,
      "manual-reroll",
      "manual-reroll",
    );
    workingGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "reroll-rollback",
      {
        fromFloor: targetFloor,
        effectiveFromFloor,
        path: recoveryPath,
        affectedBatchCount,
        detectionSource: "manual-reroll",
        reason: "manual-reroll",
        resultCode: "reroll.rollback.applied",
      },
    );
    if (
      chatSnapshot.length > 0 &&
      Number.isFinite(workingGraph.historyState?.lastProcessedAssistantFloor) &&
      workingGraph.historyState.lastProcessedAssistantFloor >= 0
    ) {
      // Preserve the rolled-back prefix immediately so a failed follow-up
      // re-extraction does not look like a generic "missing processed hashes"
      // corruption on the next history integrity check.
      updateProcessedHistorySnapshot(
        chatSnapshot,
        workingGraph.historyState.lastProcessedAssistantFloor,
        workingGraph,
      );
    }
    pruneProcessedMessageHashesFromFloor(workingGraph, effectiveFromFloor);
    workingGraph.lastProcessedSeq =
      workingGraph.historyState?.lastProcessedAssistantFloor ?? -1;
    workingGraph.vectorIndexState.lastIntegrityIssue = null;
    assertHistoryCurrent("reroll-pre-rollback-persist");
    const rollbackPersistence = await persistDetachedRecoveryState(
      persistDetachedRecoveryGraph,
      workingGraph,
      "reroll-rollback-checkpoint",
      context,
    );

    if (rollbackPersistence?.accepted !== true) {
      currentGraph = getCurrentGraph();
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "pending-persistence",
        {
          fromFloor: targetFloor,
          effectiveFromFloor,
          path: recoveryPath,
          affectedBatchCount,
          detectionSource: "manual-reroll",
          reason: "reroll rollback persistence was not accepted",
          resultCode: "reroll.rollback.persist-failed",
        },
      );
      return buildRerollFailure(
        recoveryPath,
        "回滚候选未确认落盘，未发布到当前图谱；检查点已保留。",
        {
          affectedBatchCount,
          rollbackPerformed: false,
          effectiveFromFloor,
          resultCode: "reroll.rollback.persist-failed",
          checkpointRetained: true,
          persistence: rollbackPersistence,
        },
      );
    }

    candidateAccepted = true;
    assertHistoryCurrent("reroll-post-rollback-persist");
    currentGraph = workingGraph;
    setCurrentGraph(currentGraph);
    setExtractionCount(currentGraph.historyState.extractionCount || 0);
    candidatePublished = true;

    if (
      recoveryPath === "reverse-journal" &&
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      setRuntimeStatus(
        "重新提取准备中",
        `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
        "running",
      );
      await tryDeleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
        undefined,
        { source: "reroll" },
      );
      assertHistoryCurrent("reroll-post-vector");
    } else if (
      recoveryPath === "legacy-snapshot" &&
      isBackendVectorConfig(config)
    ) {
      await prepareVectorStateForReplay(false, undefined, {
        skipBackendPurge: false,
        resetBackendMappings: false,
        graph: currentGraph,
      });
      assertHistoryCurrent("reroll-post-vector");
    }
    refreshPanelLiveState();

    return {
      success: true,
      rollbackPerformed: true,
      extractionTriggered: false,
      requestedFloor: targetFloor,
      effectiveFromFloor,
      recoveryPath,
      affectedBatchCount,
      resultCode: "reroll.rollback.applied",
      checkpointFloor: targetFloor,
      checkpointRetained: true,
      persistence: rollbackPersistence,
      error: "",
    };
  } catch (error) {
    let persistence = null;
    if (checkpointAccepted && getCurrentChatId(getContext()) === chatId) {
      currentGraph = candidateAccepted
        ? normalizeGraphRuntimeState(cloneGraphSnapshot(rerollStartGraph), chatId)
        : getCurrentGraph();
      const concurrentDetection = detectHistoryMutation(
        getContext()?.chat,
        currentGraph.historyState,
      );
      const retainedFloor = concurrentDetection?.dirty &&
        Number.isFinite(concurrentDetection.earliestAffectedFloor)
        ? Math.min(targetFloor, concurrentDetection.earliestAffectedFloor)
        : targetFloor;
      markHistoryDirty(
        currentGraph,
        retainedFloor,
        concurrentDetection?.reason || "manual-reroll",
        concurrentDetection?.dirty ? "concurrent-history-change" : "manual-reroll",
      );
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        error?.name === "AbortError" ? "aborted" : "failed",
        {
          fromFloor: targetFloor,
          path: recoveryPath,
          affectedBatchCount,
          detectionSource: "manual-reroll",
          reason: error?.message || String(error),
          resultCode:
            error?.name === "AbortError"
              ? "reroll.rollback.aborted"
              : "reroll.rollback.failed",
        },
      );
      if (candidateAccepted) {
        currentGraph.vectorIndexState.dirty = true;
        currentGraph.vectorIndexState.dirtyReason =
          currentGraph.vectorIndexState.dirtyReason ||
          "history-recovery-compensated";
        currentGraph.vectorIndexState.lastWarning =
          "重 Roll 已补偿恢复，向量索引需要修复";
        persistence = await persistDetachedRecoveryState(
          persistDetachedRecoveryGraph,
          currentGraph,
          "reroll-rollback-restored",
          context,
        );
        if (persistence?.accepted === true) {
          setCurrentGraph(currentGraph);
          setExtractionCount(currentGraph.historyState.extractionCount || 0);
          candidateAccepted = false;
          candidatePublished = false;
        } else {
          currentGraph = getCurrentGraph();
        }
      } else {
        persistence = await persistRecoveryState(
          saveGraphToChat,
          "reroll-rollback-restored",
        );
      }
    }
    refreshPanelLiveState();
    return buildRerollFailure(
      error?.name === "AbortError" ? "aborted" : recoveryPath,
      error?.message || String(error),
      {
        affectedBatchCount,
        resultCode:
          error?.name === "AbortError"
            ? "reroll.rollback.aborted"
            : "reroll.rollback.failed",
        rollbackPerformed: candidatePublished,
        effectiveFromFloor,
        checkpointRetained: checkpointAccepted || candidateAccepted,
        persistence,
      },
    );
  }

}

export async function recoverHistoryIfNeededController(
  runtime,
  { trigger = "history-recovery" } = {},
) {
  const {
    applyRecoveryPlanToVectorState,
    assertRecoveryHistoryStillCurrent,
    beginStageAbortController,
    buildChatHistoryFingerprint,
    buildRecoveryResult,
    buildReverseJournalRecoveryPlan,
    clampRecoveryStartFloor,
    clearHistoryDirty,
    clearInjectionState,
    cloneGraphSnapshot,
    createEmptyGraph,
    ensureCurrentGraphRuntimeState,
    enterRestoreLock,
    findJournalRecoveryPoint,
    finishStageAbortController,
    getContext,
    getCurrentChatId,
    getCurrentGraph,
    getEmbeddingConfig,
    getIsRecoveringHistory,
    getRenderLimitedHistoryRecoveryGuard,
    getSettings,
    inspectHistoryMutation,
    isAbortError,
    isBackendVectorConfig,
    isRestoreLockActive,
    leaveRestoreLock,
    markHistoryDirty,
    maybeResumePendingAutoExtraction,
    normalizeGraphRuntimeState,
    notifyRenderLimitedHistoryRecoveryBlocked,
    persistDetachedRecoveryGraph,
    prepareVectorStateForReplay,
    refreshPanelLiveState,
    replayExtractionFromHistory,
    rollbackAffectedJournals,
    saveGraphToChat,
    setCurrentGraph,
    setExtractionCount,
    setIsRecoveringHistory,
    settleExtractionStatusAfterHistoryRecovery,
    throwIfAborted,
    tryDeleteBackendVectorHashesForRecovery,
    updateProcessedHistorySnapshot,
    updateStageNotice,
  } = runtime;
  const toastr = runtime.toastr || {};
  const console = runtime.console || globalThis.console;
  let currentGraph = getCurrentGraph();
  if (!currentGraph || getIsRecoveringHistory()) {
    return !getIsRecoveringHistory();
  }

  ensureCurrentGraphRuntimeState();
  currentGraph = getCurrentGraph();
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) return true;
  const renderLimitedGuard = getRenderLimitedHistoryRecoveryGuard(chat);
  if (renderLimitedGuard.blocked) {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "paused",
      {
        fromFloor: currentGraph.historyState?.historyDirtyFrom ?? null,
        path: "render-limit-guard",
        detectionSource:
          currentGraph.historyState?.lastMutationSource || "render-limit-guard",
        reason: renderLimitedGuard.message,
        resultCode: "history.recovery.paused.render-limit",
        chatLength: renderLimitedGuard.chatLength,
        renderLimit: renderLimitedGuard.renderLimit,
        highestProcessedFloor: renderLimitedGuard.highestProcessedFloor,
      },
    );
    notifyRenderLimitedHistoryRecoveryBlocked(renderLimitedGuard, trigger);
    refreshPanelLiveState();
    return false;
  }

  const detection = inspectHistoryMutation(trigger);
  const dirtyFrom = currentGraph?.historyState?.historyDirtyFrom;
  if (!detection.dirty && !Number.isFinite(dirtyFrom)) {
    return true;
  }
  if (isRestoreLockActive()) {
    return false;
  }

  enterRestoreLock("history-recovery", trigger);
  setIsRecoveringHistory(true);
  clearInjectionState();

  const chatId = getCurrentChatId(context);
  const chatSnapshot = cloneGraphSnapshot(chat);
  const historyFingerprint = buildChatHistoryFingerprint(chatSnapshot);
  const assertHistoryCurrent = (label) =>
    assertRecoveryHistoryStillCurrent(chatId, historyFingerprint, label);
  const settings = getSettings();
  const initialDirtyFromRaw = Number.isFinite(dirtyFrom)
    ? dirtyFrom
    : detection.earliestAffectedFloor;
  const initialDirtyFrom = clampRecoveryStartFloor(
    chatSnapshot,
    initialDirtyFromRaw,
  );
  const recoveryStartGraph = cloneGraphSnapshot(currentGraph);
  const checkpointReason = String(
    detection.reason ||
      currentGraph.historyState?.lastMutationReason ||
      trigger ||
      "history-recovery",
  );
  const checkpointSource = String(
    detection.source ||
      currentGraph.historyState?.lastMutationSource ||
      "hash-recheck",
  );
  let replayedBatches = 0;
  let usedFullRebuild = false;
  let recoveryPath = "full-rebuild";
  let affectedBatchCount = 0;
  let recoveryBaseAccepted = false;
  const historyController = beginStageAbortController("history");
  const historySignal = historyController.signal;
  const retainCheckpoint = (graph, result = null) => {
    markHistoryDirty(
      graph,
      initialDirtyFrom,
      checkpointReason,
      checkpointSource,
    );
    if (result) graph.historyState.lastRecoveryResult = result;
  };
  const publishAcceptedGraph = (graph) => {
    currentGraph = graph;
    setCurrentGraph(graph);
    setExtractionCount(graph?.historyState?.extractionCount || 0);
    return graph;
  };
  const persistAndPublishRecoveryBase = async (graph, reason) => {
    assertHistoryCurrent(`${reason}-start`);
    const persistence = await persistDetachedRecoveryState(
      persistDetachedRecoveryGraph,
      graph,
      reason,
      context,
    );
    if (persistence?.accepted !== true) return persistence;
    recoveryBaseAccepted = true;
    assertHistoryCurrent(`${reason}-persisted`);
    publishAcceptedGraph(graph);
    return persistence;
  };
  const compensateRecoveryStartGraph = async (result, reason) => {
    if (getCurrentChatId(getContext()) !== chatId) return null;
    if (!recoveryBaseAccepted) {
      currentGraph = getCurrentGraph();
      retainCheckpoint(currentGraph, result);
      return await persistRecoveryState(saveGraphToChat, reason);
    }

    const restoredGraph = normalizeGraphRuntimeState(
      cloneGraphSnapshot(recoveryStartGraph),
      chatId,
    );
    retainCheckpoint(restoredGraph, result);
    restoredGraph.vectorIndexState.dirty = true;
    restoredGraph.vectorIndexState.dirtyReason =
      restoredGraph.vectorIndexState.dirtyReason ||
      "history-recovery-compensated";
    restoredGraph.vectorIndexState.lastWarning =
      "历史恢复已补偿回到起始图谱，向量索引需要修复";
    const persistence = await persistDetachedRecoveryState(
      persistDetachedRecoveryGraph,
      restoredGraph,
      reason,
      context,
    );
    if (persistence?.accepted === true) {
      publishAcceptedGraph(restoredGraph);
      recoveryBaseAccepted = false;
    } else {
      currentGraph = getCurrentGraph();
      retainCheckpoint(currentGraph, result);
    }
    return persistence;
  };
  const finalizeRecoveredState = async (result, reason) => {
    assertHistoryCurrent(`${reason}-start`);
    currentGraph = getCurrentGraph();
    const completionGraph = normalizeGraphRuntimeState(
      cloneGraphSnapshot(currentGraph),
      chatId,
    );
    retainCheckpoint(completionGraph, result);
    const recoveredLastProcessedFloor = Number.isFinite(
      completionGraph?.historyState?.lastProcessedAssistantFloor,
    )
      ? completionGraph.historyState.lastProcessedAssistantFloor
      : -1;
    if (recoveredLastProcessedFloor >= 0) {
      updateProcessedHistorySnapshot(
        chatSnapshot,
        recoveredLastProcessedFloor,
        completionGraph,
      );
    }
    clearHistoryDirty(completionGraph, result);
    if (recoveredLastProcessedFloor >= 0) {
      updateProcessedHistorySnapshot(
        chatSnapshot,
        recoveredLastProcessedFloor,
        completionGraph,
      );
    }
    const completionPersistence = await persistDetachedRecoveryState(
      persistDetachedRecoveryGraph,
      completionGraph,
      reason,
      context,
    );
    assertHistoryCurrent(`${reason}-clear-persisted`);
    if (completionPersistence?.accepted === true) {
      publishAcceptedGraph(completionGraph);
      return true;
    }

    retainCheckpoint(
      currentGraph,
      buildRecoveryResult("pending-persistence", {
        fromFloor: initialDirtyFrom,
        path: recoveryPath,
        detectionSource: checkpointSource,
        reason: "recovery completion persistence was not accepted",
        resultCode: "history.recovery.clear-persist-failed",
      }),
    );
    return false;
  };

  updateStageNotice(
    "history",
    "历史恢复中",
    Number.isFinite(initialDirtyFrom)
      ? `受影响起点楼层 ${initialDirtyFrom} · 正在回滚并重放`
      : "正在回滚并重放受影响后缀",
    "running",
    {
      persist: true,
      busy: true,
    },
  );

  try {
    throwIfAborted(historySignal, "历史恢复已终止");
    assertHistoryCurrent("checkpoint-start");
    retainCheckpoint(currentGraph);
    const initialCheckpointPersistence = await persistRecoveryState(
      saveGraphToChat,
      "history-recovery-checkpoint-start",
    );
    assertHistoryCurrent("checkpoint-persisted");
    if (initialCheckpointPersistence?.accepted !== true) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "pending-persistence",
        {
          fromFloor: initialDirtyFrom,
          path: "checkpoint",
          detectionSource: checkpointSource,
          reason: "history recovery checkpoint persistence was not accepted",
          resultCode: "history.recovery.checkpoint-start-persist-failed",
        },
      );
      updateStageNotice(
        "history",
        "历史恢复等待持久化",
        "恢复检查点尚未确认落盘，本次未执行回滚。",
        "warning",
        { busy: false, persist: false },
      );
      refreshPanelLiveState();
      return false;
    }
    const recoveryPoint = findJournalRecoveryPoint(
      currentGraph,
      initialDirtyFrom,
    );
    const config = getEmbeddingConfig();
    let recoveryPlan = null;
    let recoveryGraph = null;
    if (recoveryPoint?.path === "reverse-journal") {
      recoveryPath = "reverse-journal";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      recoveryPlan = buildReverseJournalRecoveryPlan(
        recoveryPoint.affectedJournals,
        initialDirtyFrom,
      );
      if (recoveryPlan?.valid === false) {
        throw new Error(
          `reverse-journal recovery plan invalid: ${
            recoveryPlan.invalidReason || "unknown"
          }`,
        );
      }
      recoveryGraph = normalizeGraphRuntimeState(
        cloneGraphSnapshot(currentGraph),
        chatId,
      );
      rollbackAffectedJournals(
        recoveryGraph,
        recoveryPoint.affectedJournals,
      );
      recoveryGraph = normalizeGraphRuntimeState(recoveryGraph, chatId);
      applyRecoveryPlanToVectorState(
        recoveryPlan,
        initialDirtyFrom,
        recoveryGraph,
      );
    } else if (recoveryPoint?.path === "legacy-snapshot") {
      recoveryPath = "legacy-snapshot";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      recoveryGraph = normalizeGraphRuntimeState(
        cloneGraphSnapshot(recoveryPoint.snapshotBefore),
        chatId,
      );
    } else {
      recoveryPath = "full-rebuild";
      recoveryGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      usedFullRebuild = true;
    }

    retainCheckpoint(recoveryGraph);
    if (isBackendVectorConfig(config)) {
      updateStageNotice(
        "history",
        "历史恢复中",
        "正在准备向量回放状态",
        "running",
        { persist: true, busy: true },
      );
    }
    assertHistoryCurrent("pre-vector-prepare");
    await prepareVectorStateForReplay(usedFullRebuild, historySignal, {
      skipBackendPurge: true,
      resetBackendMappings: recoveryPath !== "reverse-journal",
      graph: recoveryGraph,
    });
    assertHistoryCurrent("post-vector-prepare");

    const recoveryBasePersistence = await persistAndPublishRecoveryBase(
      recoveryGraph,
      `history-recovery-base:${recoveryPath}`,
    );
    if (recoveryBasePersistence?.accepted !== true) {
      currentGraph = getCurrentGraph();
      retainCheckpoint(
        currentGraph,
        buildRecoveryResult("pending-persistence", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource: checkpointSource,
          reason: "recovery base persistence was not accepted",
          resultCode: "history.recovery.base-persist-failed",
        }),
      );
      updateStageNotice(
        "history",
        "历史恢复等待持久化",
        "回退候选尚未确认落盘，当前图谱未发布候选状态。",
        "warning",
        { busy: false, persist: false },
      );
      refreshPanelLiveState();
      return false;
    }

    if (
      recoveryPath === "reverse-journal" &&
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      updateStageNotice(
        "history",
        "历史恢复中",
        `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
        "running",
        { persist: true, busy: true },
      );
      await tryDeleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
        historySignal,
        { source: "history-recovery" },
      );
      assertHistoryCurrent("post-backend-delete");
    } else if (isBackendVectorConfig(config)) {
      await prepareVectorStateForReplay(usedFullRebuild, historySignal, {
        skipBackendPurge: false,
        resetBackendMappings: false,
        graph: currentGraph,
      });
      assertHistoryCurrent("post-backend-purge");
    }

    assertHistoryCurrent("pre-replay");
    replayedBatches = await replayExtractionFromHistory(
      chatSnapshot,
      settings,
      historySignal,
      chatId,
      historyFingerprint,
    );

    currentGraph = getCurrentGraph();
    const recoveryResult = buildRecoveryResult(
      usedFullRebuild ? "full-rebuild" : "replayed",
      {
        fromFloor: initialDirtyFrom,
        batches: replayedBatches,
        path: recoveryPath,
        detectionSource:
          detection.source ||
          currentGraph?.historyState?.lastMutationSource ||
          "hash-recheck",
        affectedBatchCount,
        replayedBatchCount: replayedBatches,
        reason:
          detection.reason ||
          currentGraph?.historyState?.lastMutationReason ||
          trigger,
      },
    );
    if (
      !(await finalizeRecoveredState(
        recoveryResult,
        "history-recovery-complete",
      ))
    ) {
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "历史恢复等待持久化",
        "恢复结果尚未确认落盘，检查点已保留。",
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复等待持久化",
        "恢复结果尚未确认落盘，检查点已保留。",
        "warning",
        { busy: false, persist: false },
      );
      return false;
    }
    refreshPanelLiveState();
    settleExtractionStatusAfterHistoryRecovery(
      "提取完成",
      `历史恢复回放 ${replayedBatches} 批`,
      "success",
    );
    updateStageNotice(
      "history",
      usedFullRebuild ? "历史恢复完成（全量重建）" : "历史恢复完成",
      `path ${recoveryPath} · 起点楼层 ${initialDirtyFrom} · 受影响 ${affectedBatchCount} 批 · 回放 ${replayedBatches} 批`,
      usedFullRebuild ? "warning" : "success",
      {
        busy: false,
        persist: false,
      },
    );
    if (usedFullRebuild) {
      toastr.warning("历史变化已触发全量重建");
    }
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      currentGraph = getCurrentGraph();
      const abortedResult = buildRecoveryResult("aborted", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: error?.message || "已手动终止当前恢复流程",
          debugReason: `history-recovery-aborted:${recoveryPath}`,
          resultCode: "history.recovery.aborted",
        });
      await compensateRecoveryStartGraph(
        abortedResult,
        "history-recovery-aborted",
      );
      if (getCurrentChatId(getContext()) === chatId) {
        inspectHistoryMutation(`${trigger}:concurrent-change`);
      }
      settleExtractionStatusAfterHistoryRecovery(
        "提取已终止",
        error?.message || "历史恢复已终止",
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已终止",
        error?.message || "已手动终止当前恢复流程",
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      return false;
    }
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      const fallbackGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      retainCheckpoint(fallbackGraph);
      assertHistoryCurrent("pre-fallback-vector-prepare");
      await prepareVectorStateForReplay(true, historySignal, {
        skipBackendPurge: true,
        resetBackendMappings: true,
        graph: fallbackGraph,
      });
      assertHistoryCurrent("post-fallback-vector-prepare");
      const fallbackBasePersistence = await persistAndPublishRecoveryBase(
        fallbackGraph,
        "history-recovery-fallback-base",
      );
      if (fallbackBasePersistence?.accepted !== true) {
        throw new Error(
          fallbackBasePersistence?.reason ||
            "fallback recovery base persistence was not accepted",
        );
      }
      if (isBackendVectorConfig(getEmbeddingConfig())) {
        await prepareVectorStateForReplay(true, historySignal, {
          skipBackendPurge: false,
          resetBackendMappings: false,
          graph: currentGraph,
        });
        assertHistoryCurrent("post-fallback-backend-purge");
      }
      assertHistoryCurrent("pre-fallback-replay");
      replayedBatches = await replayExtractionFromHistory(
        chatSnapshot,
        settings,
        historySignal,
        chatId,
        historyFingerprint,
      );
      currentGraph = getCurrentGraph();
      const fallbackRecoveryResult = buildRecoveryResult("full-rebuild", {
          fromFloor: 0,
          batches: replayedBatches,
          path: "full-rebuild",
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: `恢复失败后兜底全量重建: ${error?.message || error}`,
          debugReason: `history-recovery-fallback-full-rebuild:${recoveryPath}`,
          resultCode: "history.recovery.fallback-full-rebuild",
        });
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      if (
        !(await finalizeRecoveredState(
          fallbackRecoveryResult,
          "history-recovery-fallback-rebuild",
        ))
      ) {
        refreshPanelLiveState();
        settleExtractionStatusAfterHistoryRecovery(
          "历史恢复等待持久化",
          "全量重建结果尚未确认落盘，检查点已保留。",
          "warning",
        );
        updateStageNotice(
          "history",
          "历史恢复等待持久化",
          "全量重建结果尚未确认落盘，检查点已保留。",
          "warning",
          { busy: false, persist: false },
        );
        return false;
      }
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取完成",
        `历史恢复已退化为全量重建，回放 ${replayedBatches} 批`,
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已退化为全量重建",
        `path full-rebuild · 起点楼层 ${initialDirtyFrom} · 回放 ${replayedBatches} 批`,
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.warning("历史恢复已退化为全量重建");
      return true;
    } catch (fallbackError) {
      currentGraph = getCurrentGraph();
      const failedResult = buildRecoveryResult("failed", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: String(fallbackError),
          debugReason: `history-recovery-failed:${recoveryPath}`,
          resultCode: "history.recovery.failed",
        });
      await compensateRecoveryStartGraph(
        failedResult,
        "history-recovery-failed",
      );
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取失败",
        fallbackError?.message || String(fallbackError),
        "error",
      );
      updateStageNotice(
        "history",
        "历史恢复失败",
        fallbackError?.message || String(fallbackError),
        "error",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.error(`历史恢复失败: ${fallbackError?.message || fallbackError}`);
      return false;
    }
  } finally {
    finishStageAbortController("history", historyController);
    leaveRestoreLock("history-recovery");
    setIsRecoveringHistory(false);
    const enqueueMicrotask =
      typeof runtime.queueMicrotask === "function"
        ? runtime.queueMicrotask
        : typeof globalThis.queueMicrotask === "function"
          ? globalThis.queueMicrotask.bind(globalThis)
          : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      if (typeof maybeResumePendingAutoExtraction === "function") {
        void maybeResumePendingAutoExtraction("history-recovery-finished");
      }
    });
  }

}
