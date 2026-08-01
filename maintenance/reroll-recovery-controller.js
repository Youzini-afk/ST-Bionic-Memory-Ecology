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
  targetChatId = "",
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
      persistDetachedRecoveryGraph(graph, {
        reason,
        context,
        targetChatId,
      }),
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
      chatId,
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
          chatId,
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
    assertRecoveryStructureStillCurrent,
    beginStageAbortController,
    buildChatHistoryFingerprint,
    buildChatStructureFingerprint,
    buildRecoveryResult,
    buildReverseJournalRecoveryPlan,
    clampRecoveryStartFloor,
    clearHistoryDirty,
    clearInjectionState,
    cloneGraphSnapshot,
    ensureCurrentGraphRuntimeState,
    enterRestoreLock,
    findJournalRecoveryPoint,
    finishStageAbortController,
    getContext,
    getCurrentChatId,
    getCurrentGraph,
    getIsRecoveringHistory,
    getRenderLimitedHistoryRecoveryGuard,
    inspectHistoryMutation,
    isAbortError,
    isRestoreLockActive,
    leaveRestoreLock,
    markHistoryDirty,
    normalizeGraphRuntimeState,
    notifyRenderLimitedHistoryRecoveryBlocked,
    persistDetachedRecoveryGraph,
    refreshPanelLiveState,
    rollbackAffectedJournals,
    saveGraphToChat,
    setCurrentGraph,
    setExtractionCount,
    setIsRecoveringHistory,
    throwIfAborted,
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

  const restoreLockToken = enterRestoreLock("history-recovery", trigger);
  setIsRecoveringHistory(true);
  clearInjectionState();

  const chatId = getCurrentChatId(context);
  const chatSnapshot = cloneGraphSnapshot(chat);
  const buildRollbackFingerprint =
    buildChatStructureFingerprint || buildChatHistoryFingerprint;
  const assertRollbackCurrent =
    assertRecoveryStructureStillCurrent || assertRecoveryHistoryStillCurrent;
  const historyFingerprint = buildRollbackFingerprint(chatSnapshot);
  const assertHistoryCurrent = (label) =>
    assertRollbackCurrent(chatId, historyFingerprint, label);
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
  let recoveryPath = "unavailable";
  let affectedBatchCount = 0;
  let rollbackCandidateAccepted = false;
  const historyController = beginStageAbortController("history");
  const historySignal = historyController.signal;
  const retainCheckpoint = (
    graph,
    result = null,
    retainedFloor = initialDirtyFrom,
  ) => {
    markHistoryDirty(
      graph,
      retainedFloor,
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
  const compensateRecoveryStartGraph = async (result, reason) => {
    if (getCurrentChatId(getContext()) !== chatId) return null;
    const latestGraph = getCurrentGraph();
    const latestDirtyFrom = Number.isFinite(
      latestGraph?.historyState?.historyDirtyFrom,
    )
      ? latestGraph.historyState.historyDirtyFrom
      : initialDirtyFrom;
    const retainedFloor = Math.min(initialDirtyFrom, latestDirtyFrom);
    if (!rollbackCandidateAccepted) {
      currentGraph = getCurrentGraph();
      retainCheckpoint(currentGraph, result, retainedFloor);
      return await persistRecoveryState(saveGraphToChat, reason);
    }

    const restoredGraph = normalizeGraphRuntimeState(
      cloneGraphSnapshot(recoveryStartGraph),
      chatId,
    );
    retainCheckpoint(restoredGraph, result, retainedFloor);
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
      chatId,
    );
    if (persistence?.accepted === true) {
      publishAcceptedGraph(restoredGraph);
      rollbackCandidateAccepted = false;
    } else {
      currentGraph = getCurrentGraph();
      retainCheckpoint(currentGraph, result);
      const fallbackPersistence = await persistRecoveryState(
        saveGraphToChat,
        `${reason}:checkpoint-fallback`,
      );
      if (fallbackPersistence?.accepted === true) {
        return fallbackPersistence;
      }
      return {
        ...persistence,
        fallbackPersistence,
      };
    }
    return persistence;
  };

  updateStageNotice(
    "history",
    "楼层回滚中",
    Number.isFinite(initialDirtyFrom)
      ? `正在回滚楼层 ${initialDirtyFrom} 及其后的记忆影响`
      : "正在回滚受影响的记忆事务",
    "running",
    {
      persist: true,
      busy: true,
    },
  );

  try {
    throwIfAborted(historySignal, "楼层回滚已终止");
    assertHistoryCurrent("checkpoint-start");
    retainCheckpoint(currentGraph);
    const initialCheckpointPersistence = await persistRecoveryState(
      saveGraphToChat,
      "history-rollback-checkpoint-start",
    );
    throwIfAborted(historySignal, "楼层回滚已终止");
    assertHistoryCurrent("checkpoint-persisted");
    if (initialCheckpointPersistence?.accepted !== true) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "pending-persistence",
        {
          fromFloor: initialDirtyFrom,
          path: "checkpoint",
          detectionSource: checkpointSource,
          reason: "history rollback checkpoint persistence was not accepted",
          resultCode: "history.rollback.checkpoint-persist-failed",
        },
      );
      updateStageNotice(
        "history",
        "楼层回滚等待持久化",
        "回滚检查点尚未确认落盘，本次没有改动当前图谱。",
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
    if (!recoveryPoint) {
      const unavailableResult = buildRecoveryResult("rollback-unavailable", {
        fromFloor: initialDirtyFrom,
        path: "unavailable",
        detectionSource: checkpointSource,
        affectedBatchCount: 0,
        replayedBatchCount: 0,
        automaticReplay: false,
        reason: "没有覆盖该楼层的可逆事务记录，未自动重建或重新提取",
        resultCode: "history.rollback.unavailable",
      });
      retainCheckpoint(currentGraph, unavailableResult);
      await persistRecoveryState(saveGraphToChat, "history-rollback-unavailable");
      updateStageNotice(
        "history",
        "楼层回滚缺少事务记录",
        "没有覆盖该楼层的可逆记录；已保留检查点，不会自动重建或重新提取。",
        "warning",
        { busy: false, persist: false },
      );
      refreshPanelLiveState();
      return false;
    }

    let recoveryPlan = null;
    let rollbackGraph = null;
    if (recoveryPoint.path === "reverse-journal") {
      recoveryPath = "reverse-journal";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      recoveryPlan = buildReverseJournalRecoveryPlan(
        recoveryPoint.affectedJournals,
        initialDirtyFrom,
      );
      if (recoveryPlan?.valid === false) {
        throw new Error(
          `reverse-journal rollback plan invalid: ${
            recoveryPlan.invalidReason || "unknown"
          }`,
        );
      }
      rollbackGraph = normalizeGraphRuntimeState(
        cloneGraphSnapshot(currentGraph),
        chatId,
      );
      rollbackAffectedJournals(
        rollbackGraph,
        recoveryPoint.affectedJournals,
      );
      rollbackGraph = normalizeGraphRuntimeState(rollbackGraph, chatId);
      applyRecoveryPlanToVectorState(
        recoveryPlan,
        initialDirtyFrom,
        rollbackGraph,
      );
    } else if (recoveryPoint.path === "legacy-snapshot") {
      recoveryPath = "legacy-snapshot";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      rollbackGraph = normalizeGraphRuntimeState(
        cloneGraphSnapshot(recoveryPoint.snapshotBefore),
        chatId,
      );
      applyRecoveryPlanToVectorState(
        {
          valid: true,
          backendDeleteHashes: [],
          replayRequiredNodeIds: (rollbackGraph.nodes || [])
            .map((node) => String(node?.id || "").trim())
            .filter(Boolean),
          pendingRepairFromFloor: initialDirtyFrom,
          legacyGapFallback: true,
          dirtyReason: "history-rollback-legacy-snapshot",
        },
        initialDirtyFrom,
        rollbackGraph,
      );
    } else {
      throw new Error(`unsupported history rollback path: ${recoveryPoint.path}`);
    }

    throwIfAborted(historySignal, "楼层回滚已终止");
    assertHistoryCurrent("pre-rollback-commit");
    const rolledBackLastProcessedFloor = Number.isFinite(
      rollbackGraph?.historyState?.lastProcessedAssistantFloor,
    )
      ? rollbackGraph.historyState.lastProcessedAssistantFloor
      : -1;
    const rollbackResult = buildRecoveryResult("rolled-back", {
      fromFloor: initialDirtyFrom,
      effectiveFromFloor: rolledBackLastProcessedFloor + 1,
      path: recoveryPath,
      detectionSource: checkpointSource,
      affectedBatchCount,
      replayedBatchCount: 0,
      automaticReplay: false,
      reason: checkpointReason,
      resultCode: "history.rollback.applied",
    });
    clearHistoryDirty(rollbackGraph, rollbackResult);
    if (rolledBackLastProcessedFloor >= 0) {
      updateProcessedHistorySnapshot(
        chatSnapshot,
        rolledBackLastProcessedFloor,
        rollbackGraph,
      );
    }
    rollbackGraph.lastProcessedSeq = rolledBackLastProcessedFloor;

    const rollbackPersistence = await persistDetachedRecoveryState(
      persistDetachedRecoveryGraph,
      rollbackGraph,
      "history-rollback-complete",
      context,
      chatId,
    );
    if (rollbackPersistence?.accepted !== true) {
      currentGraph = getCurrentGraph();
      retainCheckpoint(
        currentGraph,
        buildRecoveryResult("pending-persistence", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource: checkpointSource,
          affectedBatchCount,
          replayedBatchCount: 0,
          automaticReplay: false,
          reason: "history rollback persistence was not accepted",
          resultCode: "history.rollback.persist-failed",
        }),
      );
      updateStageNotice(
        "history",
        "楼层回滚等待持久化",
        "回滚状态尚未确认落盘，当前图谱没有发布候选状态。",
        "warning",
        { busy: false, persist: false },
      );
      refreshPanelLiveState();
      return false;
    }

    rollbackCandidateAccepted = true;
    throwIfAborted(historySignal, "楼层回滚已终止");
    assertHistoryCurrent("rollback-persisted");
    publishAcceptedGraph(rollbackGraph);
    refreshPanelLiveState();
    updateStageNotice(
      "history",
      "楼层回滚完成",
      `起点楼层 ${initialDirtyFrom} · 回滚 ${affectedBatchCount} 笔记忆事务`,
      "success",
      {
        busy: false,
        persist: false,
      },
    );
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      if (getCurrentChatId(getContext()) === chatId) {
        inspectHistoryMutation(`${trigger}:concurrent-change`);
      }
      currentGraph = getCurrentGraph();
      const abortedResult = buildRecoveryResult("aborted", {
        fromFloor: initialDirtyFrom,
        path: recoveryPath,
        detectionSource:
          detection.source ||
          currentGraph?.historyState?.lastMutationSource ||
          "hash-recheck",
        affectedBatchCount,
        replayedBatchCount: 0,
        automaticReplay: false,
        reason: error?.message || "楼层再次变化，旧回滚事务已终止",
        debugReason: `history-rollback-aborted:${recoveryPath}`,
        resultCode: "history.rollback.aborted",
      });
      await compensateRecoveryStartGraph(
        abortedResult,
        "history-rollback-aborted",
      );
      updateStageNotice(
        "history",
        "楼层回滚已切换",
        error?.message || "楼层再次变化，正在等待最新回滚事务。",
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      return false;
    }

    console.error("[ST-BME] 楼层事务回滚失败:", error);
    currentGraph = getCurrentGraph();
    const failedResult = buildRecoveryResult("failed", {
      fromFloor: initialDirtyFrom,
      path: recoveryPath,
      detectionSource:
        detection.source ||
        currentGraph?.historyState?.lastMutationSource ||
        "hash-recheck",
      affectedBatchCount,
      replayedBatchCount: 0,
      automaticReplay: false,
      reason: error?.message || String(error),
      debugReason: `history-rollback-failed:${recoveryPath}`,
      resultCode: "history.rollback.failed",
    });
    await compensateRecoveryStartGraph(
      failedResult,
      "history-rollback-failed",
    );
    refreshPanelLiveState();
    updateStageNotice(
      "history",
      "楼层回滚失败",
      error?.message || String(error),
      "error",
      {
        busy: false,
        persist: false,
      },
    );
    toastr.error?.(`楼层回滚失败: ${error?.message || error}`);
    return false;
  } finally {
    finishStageAbortController("history", historyController);
    leaveRestoreLock(restoreLockToken || "history-recovery");
    setIsRecoveringHistory(false);
  }
}
