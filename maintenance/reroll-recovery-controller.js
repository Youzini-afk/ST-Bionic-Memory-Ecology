async function persistRecoveryState(saveGraphToChat, reason) {
  try {
    return await Promise.resolve(
      saveGraphToChat({ reason, awaitDurable: true }),
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
  if (recoveryPath === "reverse-journal") {
    const recoveryPlan = buildReverseJournalRecoveryPlan(
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
    const checkpointFailure = await beginRerollCheckpoint();
    if (checkpointFailure) {
      refreshPanelLiveState();
      return checkpointFailure;
    }
    rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
    currentGraph = getCurrentGraph();
    currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
    setCurrentGraph(currentGraph);
    setExtractionCount(currentGraph.historyState.extractionCount || 0);
    applyRecoveryPlanToVectorState(recoveryPlan, targetFloor);

    if (
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      setRuntimeStatus(
        "重新提取准备中",
        `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
        "running",
      );
      assertHistoryCurrent("reroll-pre-vector");
      await tryDeleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
        undefined,
        {
          source: "reroll",
        },
      );
      assertHistoryCurrent("reroll-post-vector");
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
      skipBackendPurge: isBackendVectorConfig(config),
    });
    assertHistoryCurrent("reroll-post-prepare");
  } else if (recoveryPath === "legacy-snapshot") {
    const checkpointFailure = await beginRerollCheckpoint();
    if (checkpointFailure) {
      refreshPanelLiveState();
      return checkpointFailure;
    }
    currentGraph = normalizeGraphRuntimeState(
      recoveryPoint.snapshotBefore,
      chatId,
    );
    setCurrentGraph(currentGraph);
    setExtractionCount(currentGraph.historyState.extractionCount || 0);
    assertHistoryCurrent("reroll-pre-legacy-prepare");
    await prepareVectorStateForReplay(false);
    assertHistoryCurrent("reroll-post-legacy-prepare");
  } else {
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

  const effectiveFromFloor = Number.isFinite(
    currentGraph.historyState?.lastProcessedAssistantFloor,
  )
    ? currentGraph.historyState.lastProcessedAssistantFloor + 1
    : 0;

  markHistoryDirty(
    currentGraph,
    targetFloor,
    "manual-reroll",
    "manual-reroll",
  );
  currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
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
    Number.isFinite(currentGraph.historyState?.lastProcessedAssistantFloor) &&
    currentGraph.historyState.lastProcessedAssistantFloor >= 0
  ) {
    // Preserve the rolled-back prefix immediately so a failed follow-up
    // re-extraction does not look like a generic "missing processed hashes"
    // corruption on the next history integrity check.
    updateProcessedHistorySnapshot(
      chatSnapshot,
      currentGraph.historyState.lastProcessedAssistantFloor,
    );
  }
  pruneProcessedMessageHashesFromFloor(currentGraph, effectiveFromFloor);
  currentGraph.lastProcessedSeq =
    currentGraph.historyState?.lastProcessedAssistantFloor ?? -1;
  currentGraph.vectorIndexState.lastIntegrityIssue = null;
  assertHistoryCurrent("reroll-pre-rollback-persist");
  const rollbackPersistence = await persistRecoveryState(
    saveGraphToChat,
    "reroll-rollback-checkpoint",
  );
  assertHistoryCurrent("reroll-post-rollback-persist");
  refreshPanelLiveState();

  if (rollbackPersistence?.accepted !== true) {
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
      "回滚已执行，但持久化未确认；检查点已保留，将在下一次恢复时继续。",
      {
        affectedBatchCount,
        rollbackPerformed: true,
        effectiveFromFloor,
        resultCode: "reroll.rollback.persist-failed",
        checkpointRetained: true,
        persistence: rollbackPersistence,
      },
    );
  }

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
      currentGraph = normalizeGraphRuntimeState(
        cloneGraphSnapshot(rerollStartGraph),
        chatId,
      );
      setCurrentGraph(currentGraph);
      setExtractionCount(currentGraph.historyState.extractionCount || 0);
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
      persistence = await persistRecoveryState(
        saveGraphToChat,
        "reroll-rollback-restored",
      );
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
        checkpointRetained: checkpointAccepted,
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
  const restoreRecoveryStartGraph = () => {
    if (getCurrentChatId(getContext()) !== chatId) return null;
    currentGraph = normalizeGraphRuntimeState(
      cloneGraphSnapshot(recoveryStartGraph),
      chatId,
    );
    setCurrentGraph(currentGraph);
    setExtractionCount(currentGraph.historyState.extractionCount || 0);
    return currentGraph;
  };
  const finalizeRecoveredState = async (result, reason) => {
    assertHistoryCurrent(`${reason}-start`);
    currentGraph = getCurrentGraph();
    retainCheckpoint(currentGraph, result);
    const recoveredLastProcessedFloor = Number.isFinite(
      currentGraph?.historyState?.lastProcessedAssistantFloor,
    )
      ? currentGraph.historyState.lastProcessedAssistantFloor
      : -1;
    if (recoveredLastProcessedFloor >= 0) {
      updateProcessedHistorySnapshot(
        chatSnapshot,
        recoveredLastProcessedFloor,
      );
    }

    const checkpointPersistence = await persistRecoveryState(
      saveGraphToChat,
      `${reason}-checkpoint`,
    );
    assertHistoryCurrent(`${reason}-checkpoint-persisted`);
    if (checkpointPersistence?.accepted !== true) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "pending-persistence",
        {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource: checkpointSource,
          reason: "recovered checkpoint persistence was not accepted",
          resultCode: "history.recovery.checkpoint-persist-failed",
        },
      );
      return false;
    }

    clearHistoryDirty(currentGraph, result);
    if (recoveredLastProcessedFloor >= 0) {
      updateProcessedHistorySnapshot(
        chatSnapshot,
        recoveredLastProcessedFloor,
      );
    }
    const clearPersistence = await persistRecoveryState(
      saveGraphToChat,
      reason,
    );
    assertHistoryCurrent(`${reason}-clear-persisted`);
    if (clearPersistence?.accepted === true) return true;

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
    await persistRecoveryState(
      saveGraphToChat,
      `${reason}-checkpoint-restored`,
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
    if (recoveryPoint?.path === "reverse-journal") {
      recoveryPath = "reverse-journal";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      const config = getEmbeddingConfig();
      const recoveryPlan = buildReverseJournalRecoveryPlan(
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
      rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
      currentGraph = getCurrentGraph();
      currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
      setCurrentGraph(currentGraph);
      retainCheckpoint(currentGraph);
      setExtractionCount(currentGraph.historyState.extractionCount || 0);
      applyRecoveryPlanToVectorState(recoveryPlan, initialDirtyFrom);

      if (
        isBackendVectorConfig(config) &&
        recoveryPlan.backendDeleteHashes.length > 0
      ) {
        updateStageNotice(
          "history",
          "历史恢复中",
          `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
          "running",
          {
            persist: true,
            busy: true,
          },
        );
        assertHistoryCurrent("pre-backend-delete");
        await tryDeleteBackendVectorHashesForRecovery(
          currentGraph.vectorIndexState.collectionId,
          config,
          recoveryPlan.backendDeleteHashes,
          historySignal,
          {
            source: "history-recovery",
          },
        );
        assertHistoryCurrent("post-backend-delete");
      }
      if (isBackendVectorConfig(config)) {
        updateStageNotice(
          "history",
          "历史恢复中",
          "正在准备向量回放状态",
          "running",
          {
            persist: true,
            busy: true,
          },
        );
      }
      assertHistoryCurrent("pre-vector-prepare");
      await prepareVectorStateForReplay(false, historySignal, {
        skipBackendPurge: isBackendVectorConfig(config),
      });
      assertHistoryCurrent("post-vector-prepare");
    } else if (recoveryPoint?.path === "legacy-snapshot") {
      recoveryPath = "legacy-snapshot";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      currentGraph = normalizeGraphRuntimeState(
        recoveryPoint.snapshotBefore,
        chatId,
      );
      setCurrentGraph(currentGraph);
      retainCheckpoint(currentGraph);
      setExtractionCount(currentGraph.historyState.extractionCount || 0);
      assertHistoryCurrent("pre-legacy-vector-prepare");
      await prepareVectorStateForReplay(false, historySignal);
      assertHistoryCurrent("post-legacy-vector-prepare");
    } else {
      recoveryPath = "full-rebuild";
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      setCurrentGraph(currentGraph);
      retainCheckpoint(currentGraph);
      usedFullRebuild = true;
      setExtractionCount(0);
      assertHistoryCurrent("pre-rebuild-vector-prepare");
      await prepareVectorStateForReplay(true, historySignal);
      assertHistoryCurrent("post-rebuild-vector-prepare");
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
      currentGraph = restoreRecoveryStartGraph();
      if (currentGraph) {
        inspectHistoryMutation(`${trigger}:concurrent-change`);
      }
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
      if (currentGraph) {
        retainCheckpoint(currentGraph, abortedResult);
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
      if (currentGraph) {
        await persistRecoveryState(saveGraphToChat, "history-recovery-aborted");
      }
      return false;
    }
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      setCurrentGraph(currentGraph);
      retainCheckpoint(currentGraph);
      setExtractionCount(0);
      assertHistoryCurrent("pre-fallback-vector-prepare");
      await prepareVectorStateForReplay(true, historySignal);
      assertHistoryCurrent("post-fallback-vector-prepare");
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
      currentGraph = restoreRecoveryStartGraph();
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
      if (currentGraph) {
        retainCheckpoint(currentGraph, failedResult);
        await persistRecoveryState(saveGraphToChat, "history-recovery-failed");
      }
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
