// ST-BME: 提取编排控制器（纯函数）
// 通过 runtime 依赖注入，避免直接访问 index.js 模块级状态。

import { debugLog } from "../runtime/debug-logging.js";
import {
  buildDialogueFloorMap,
  normalizeDialogueFloorRange,
} from "./chat-history.js";

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

function normalizePersistenceStateRecord(persistResult = null) {
  const accepted = persistResult?.accepted === true;
  const queued = persistResult?.queued === true;
  const blocked = persistResult?.blocked === true;
  let outcome = "failed";
  if (accepted && String(persistResult?.storageTier || "") === "indexeddb") {
    outcome = "saved";
  } else if (accepted) {
    outcome = "fallback";
  } else if (queued) {
    outcome = "queued";
  } else if (blocked) {
    outcome = "blocked";
  }

  return {
    outcome,
    accepted,
    storageTier: String(persistResult?.storageTier || "none"),
    reason: String(persistResult?.reason || ""),
    revision: Number.isFinite(Number(persistResult?.revision))
      ? Number(persistResult.revision)
      : 0,
    saveMode: String(persistResult?.saveMode || ""),
    recoverable: persistResult?.recoverable === true,
    saved: persistResult?.saved === true,
    queued,
    blocked,
    attempted: true,
  };
}

function hasMeaningfulPersistenceRecord(persistence = null) {
  if (!persistence || typeof persistence !== "object") return false;
  if (persistence.attempted === true) return true;
  const revision = Number(persistence?.revision || 0);
  if (Number.isFinite(revision) && revision > 0) return true;
  if (String(persistence?.storageTier || "").trim() && persistence.storageTier !== "none") {
    return true;
  }
  if (String(persistence?.saveMode || "").trim()) return true;
  if (String(persistence?.reason || "").trim()) return true;
  return (
    persistence.saved === true ||
    persistence.queued === true ||
    persistence.blocked === true
  );
}

function cloneSerializable(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function setExtractionProgressStatus(
  runtime,
  text,
  meta = "",
  level = "info",
  options = {},
) {
  if (typeof runtime?.setLastExtractionStatus === "function") {
    runtime.setLastExtractionStatus(text, meta, level, options);
    return;
  }
  if (options?.syncRuntime !== false && typeof runtime?.setRuntimeStatus === "function") {
    runtime.setRuntimeStatus(text, meta, level);
  }
}

function resolveLatestAssistantDialogueFloor(chat = []) {
  const map = buildDialogueFloorMap(chat);
  const assistantDialogueFloors = Array.isArray(map.assistantDialogueFloors)
    ? map.assistantDialogueFloors
    : [];
  return assistantDialogueFloors.length > 0
    ? assistantDialogueFloors[assistantDialogueFloors.length - 1]
    : null;
}

function resolveRerunDialogueTask(chat = [], options = {}) {
  const hasStart = Number.isFinite(Number(options?.startFloor));
  const hasEnd = Number.isFinite(Number(options?.endFloor));
  if (!hasStart && !hasEnd) {
    const latestAssistantDialogueFloor = resolveLatestAssistantDialogueFloor(chat);
    if (!Number.isFinite(Number(latestAssistantDialogueFloor))) {
      return {
        valid: false,
        reason: "当前没有可重提的 AI 回复",
      };
    }
    const normalizedRange = normalizeDialogueFloorRange(
      chat,
      latestAssistantDialogueFloor,
      latestAssistantDialogueFloor,
    );
    return {
      ...normalizedRange,
      mode: "current",
      requestedStartFloor: null,
      requestedEndFloor: null,
    };
  }

  const normalizedRange = normalizeDialogueFloorRange(
    chat,
    options?.startFloor,
    options?.endFloor,
  );
  return {
    ...normalizedRange,
    mode: "range",
    requestedStartFloor: hasStart ? Number(options.startFloor) : null,
    requestedEndFloor: hasEnd ? Number(options.endFloor) : null,
  };
}

function resolveAssistantTargetRange(chat = [], dialogueRange = [-1, -1]) {
  const map = buildDialogueFloorMap(chat);
  const assistantDialogueFloors = Array.isArray(map.assistantDialogueFloors)
    ? map.assistantDialogueFloors
    : [];
  const assistantChatIndices = Array.isArray(map.assistantChatIndices)
    ? map.assistantChatIndices
    : [];
  const [startFloor, endFloor] = Array.isArray(dialogueRange)
    ? dialogueRange
    : [-1, -1];
  const targeted = [];

  for (let index = 0; index < assistantDialogueFloors.length; index += 1) {
    const floor = Number(assistantDialogueFloors[index]);
    const chatIndex = Number(assistantChatIndices[index]);
    if (!Number.isFinite(floor) || !Number.isFinite(chatIndex)) continue;
    if (floor < startFloor || floor > endFloor) continue;
    targeted.push({
      dialogueFloor: floor,
      chatIndex,
    });
  }

  return {
    map,
    targeted,
    startAssistantChatIndex: targeted.length > 0 ? targeted[0].chatIndex : null,
    endAssistantChatIndex:
      targeted.length > 0 ? targeted[targeted.length - 1].chatIndex : null,
    latestAssistantDialogueFloor:
      assistantDialogueFloors.length > 0
        ? assistantDialogueFloors[assistantDialogueFloors.length - 1]
        : null,
  };
}

function buildRerunFallbackInfo(chat = [], targetDialogueRange = [-1, -1]) {
  const assistantRange = resolveAssistantTargetRange(chat, targetDialogueRange);
  if (!assistantRange.targeted.length) {
    return {
      valid: false,
      reason: "目标范围内没有可重提的 AI 回复",
      fallbackToLatest: false,
      ...assistantRange,
    };
  }

  const latestTargetedDialogueFloor = Number(
    assistantRange.targeted[assistantRange.targeted.length - 1]?.dialogueFloor,
  );
  const latestAssistantDialogueFloor = Number(
    assistantRange.latestAssistantDialogueFloor,
  );
  const fallbackToLatest =
    Number.isFinite(latestTargetedDialogueFloor) &&
    Number.isFinite(latestAssistantDialogueFloor) &&
    latestTargetedDialogueFloor < latestAssistantDialogueFloor;

  return {
    valid: true,
    reason: fallbackToLatest
      ? "当前图谱对中段范围重提的后缀保留证据不足，已退化为从起始楼层到最新重提"
      : "",
    fallbackToLatest,
    ...assistantRange,
  };
}

function buildCommittedBatchPersistSnapshot(
  runtime,
  {
    graph = null,
    chat = [],
    beforeSnapshot = null,
    processedRange = [null, null],
    postProcessArtifacts = [],
    vectorHashesInserted = [],
    extractionCountBefore = 0,
  } = {},
) {
  if (!graph || typeof runtime?.cloneGraphSnapshot !== "function") {
    return {
      persistGraphSnapshot: null,
      committedBatchJournalEntry: null,
      afterSnapshot: null,
      committedAfterSnapshot: null,
      postProcessArtifacts: Array.isArray(postProcessArtifacts)
        ? [...postProcessArtifacts]
        : [],
    };
  }

  const range = Array.isArray(processedRange) ? processedRange : [null, null];
  const rangeStart = Number.isFinite(Number(range[0])) ? Number(range[0]) : null;
  const rangeEnd = Number.isFinite(Number(range[1])) ? Number(range[1]) : null;
  const dialogueMap = buildDialogueFloorMap(chat);
  const processedDialogueRange = [
    Number.isFinite(Number(rangeStart))
      ? dialogueMap.chatIndexToFloor[rangeStart]
      : null,
    Number.isFinite(Number(rangeEnd))
      ? dialogueMap.chatIndexToFloor[rangeEnd]
      : null,
  ];
  const sourceChatIndexRange = [
    Number.isFinite(Number(rangeStart))
      ? Math.max(
          0,
          Number(rangeStart) -
            Math.max(
              0,
              Number(runtime?.getSettings?.()?.extractContextTurns) || 0,
            ) *
              2,
        )
      : null,
    rangeEnd,
  ];
  const afterSnapshot = runtime.cloneGraphSnapshot(graph);
  const effectiveArtifacts = Array.isArray(postProcessArtifacts)
    ? [...postProcessArtifacts]
    : [];
  const committedGraphSnapshot = runtime.cloneGraphSnapshot(graph);

  if (typeof runtime.applyProcessedHistorySnapshotToGraph === "function") {
    runtime.applyProcessedHistorySnapshotToGraph(
      committedGraphSnapshot,
      chat,
      rangeEnd,
    );
  } else {
    if (
      !committedGraphSnapshot.historyState ||
      typeof committedGraphSnapshot.historyState !== "object" ||
      Array.isArray(committedGraphSnapshot.historyState)
    ) {
      committedGraphSnapshot.historyState = {};
    }
    committedGraphSnapshot.historyState.lastProcessedAssistantFloor =
      Number.isFinite(rangeEnd) ? Math.floor(rangeEnd) : -1;
    committedGraphSnapshot.lastProcessedSeq =
      Number.isFinite(rangeEnd) ? Math.floor(rangeEnd) : -1;
  }

  const committedBatchJournalEntry =
    typeof runtime.createBatchJournalEntry === "function"
      ? runtime.createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
          processedRange: [rangeStart, rangeEnd],
          processedDialogueRange,
          sourceChatIndexRange,
          postProcessArtifacts: effectiveArtifacts,
          vectorHashesInserted: Array.isArray(vectorHashesInserted)
            ? vectorHashesInserted
            : [],
          extractionCountBefore,
        })
      : null;

  if (
    committedBatchJournalEntry &&
    typeof runtime.appendBatchJournal === "function"
  ) {
    runtime.appendBatchJournal(
      committedGraphSnapshot,
      cloneSerializable(committedBatchJournalEntry, committedBatchJournalEntry),
    );
  }

  return {
    persistDelta:
      typeof runtime.buildPersistDelta === "function"
        ? runtime.buildPersistDelta(beforeSnapshot, committedGraphSnapshot, {
            useNativeDelta: false,
          })
        : null,
    persistGraphSnapshot: committedGraphSnapshot,
    committedBatchJournalEntry,
    afterSnapshot,
    committedAfterSnapshot: runtime.cloneGraphSnapshot(committedGraphSnapshot),
    postProcessArtifacts: effectiveArtifacts,
  };
}

function isPersistenceRevisionAccepted(runtime, persistence = null) {
  if (!persistence || persistence.accepted === true) return true;
  const graphPersistenceState = runtime?.getGraphPersistenceState?.() || {};
  if (graphPersistenceState.pendingPersist === true) {
    return false;
  }
  const persistenceRevision = Number(persistence?.revision || 0);
  if (!Number.isFinite(persistenceRevision) || persistenceRevision <= 0) {
    return false;
  }
  const lastAcceptedRevision = Number(graphPersistenceState?.lastAcceptedRevision || 0);
  return Number.isFinite(lastAcceptedRevision) && lastAcceptedRevision >= persistenceRevision;
}

function getPendingPersistenceGateInfo(runtime) {
  const graph = runtime?.getCurrentGraph?.();
  const batchStatus = graph?.historyState?.lastBatchStatus || null;
  const persistence = batchStatus?.persistence || null;
  const pendingPersist = runtime?.getGraphPersistenceState?.()?.pendingPersist === true;
  const accepted = isPersistenceRevisionAccepted(runtime, persistence);
  const attempted = hasMeaningfulPersistenceRecord(persistence);
  if (!pendingPersist && (!attempted || accepted)) {
    return null;
  }

  return {
    pendingPersist,
    accepted,
    attempted,
    outcome: String(persistence?.outcome || ""),
    reason: String(persistence?.reason || ""),
    revision: Number.isFinite(Number(persistence?.revision))
      ? Number(persistence.revision)
      : 0,
  };
}

async function maybeRetryPendingPersistence(runtime, reason = "pending-persist-retry") {
  const gate = getPendingPersistenceGateInfo(runtime);
  if (!gate || typeof runtime?.retryPendingGraphPersist !== "function") {
    return gate;
  }

  try {
    const retryResult = await runtime.retryPendingGraphPersist({ reason });
    if (retryResult?.accepted === true) {
      return null;
    }
  } catch (error) {
    runtime?.console?.warn?.("[ST-BME] pending persistence retry failed", error);
  }

  return getPendingPersistenceGateInfo(runtime);
}

function formatPendingPersistenceGateMessage(runtime, operationLabel = "当前提取") {
  const gate = getPendingPersistenceGateInfo(runtime);
  if (!gate) return "";
  const reason = gate.reason ? ` · ${gate.reason}` : "";
  const revision =
    Number.isFinite(Number(gate.revision)) && Number(gate.revision) > 0
      ? ` · rev ${Number(gate.revision)}`
      : "";
  return `${operationLabel}已暂停：上一批持久化尚未确认，请先使用“重试持久化”或“重新探测图谱”${revision}${reason}`;
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
    runtime.setBatchStageOutcome(
      batchStatus,
      "finalize",
      "failed",
      "提取阶段失败，未进入持久化",
    );
    batchStatus.persistence = null;
    batchStatus.historyAdvanceAllowed = false;
    batchStatus.historyAdvanced = false;
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
  const committedPersistState = buildCommittedBatchPersistSnapshot(runtime, {
    graph: runtime.getCurrentGraph(),
    chat,
    beforeSnapshot,
    processedRange: [startIdx, endIdx],
    postProcessArtifacts: runtime.computePostProcessArtifacts(
      beforeSnapshot,
      runtime.cloneGraphSnapshot(runtime.getCurrentGraph()),
      effects?.postProcessArtifacts || [],
    ),
    vectorHashesInserted: effects?.vectorHashesInserted || [],
    extractionCountBefore,
  });
  const persistResult = await runtime.persistExtractionBatchResult({
    reason: "extraction-batch-complete",
    lastProcessedAssistantFloor: endIdx,
    graphSnapshot: committedPersistState.persistGraphSnapshot,
    persistDelta: committedPersistState.persistDelta,
  });
  const persistence = normalizePersistenceStateRecord(persistResult);
  batchStatusRef.persistence = persistence;
  batchStatusRef.historyAdvanceAllowed = persistence.accepted === true;
  const finalizedBatchStatus = runtime.finalizeBatchStatus(
    batchStatusRef,
    runtime.getExtractionCount(),
  );

  runtime.getCurrentGraph().historyState.lastBatchStatus = {
    ...finalizedBatchStatus,
    persistence,
    historyAdvanceAllowed: persistence.accepted === true,
    historyAdvanced: runtime.shouldAdvanceProcessedHistory({
      ...finalizedBatchStatus,
      historyAdvanceAllowed: persistence.accepted === true,
    }),
  };

  if (runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanced) {
    runtime.updateProcessedHistorySnapshot(chat, endIdx);
    if (committedPersistState.committedBatchJournalEntry) {
      runtime.appendBatchJournal(
        runtime.getCurrentGraph(),
        cloneSerializable(
          committedPersistState.committedBatchJournalEntry,
          committedPersistState.committedBatchJournalEntry,
        ),
      );
    }
  } else if (!persistence.accepted) {
    runtime.setLastExtractionStatus(
      "提取待恢复",
      `楼层 ${startIdx}-${endIdx} 已抽取，但持久化状态为 ${persistence.outcome || "failed"}${persistence.reason ? ` · ${persistence.reason}` : ""}`,
      "warning",
      { syncRuntime: true },
    );
    runtime.console?.warn?.("[ST-BME] extraction persist not accepted", {
      chatId: runtime.getGraphPersistenceState?.()?.chatId || "",
      persistence,
      processedRange: [startIdx, endIdx],
    });
  }

  return {
    success: finalizedBatchStatus.completed,
    result,
    effects: {
      ...(effects || {}),
      persistResult,
    },
    batchStatus: finalizedBatchStatus,
    persistResult,
    historyAdvanceAllowed: persistence.accepted === true,
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

  const pendingPersistGate = await maybeRetryPendingPersistence(
    runtime,
    "auto-extraction-persist-retry",
  );
  const pendingPersistMessage = pendingPersistGate
    ? formatPendingPersistenceGateMessage(runtime, "自动提取")
    : "";
  if (pendingPersistMessage) {
    runtime.console?.debug?.("[ST-BME] auto extraction paused: pending persistence", {
      persistence: runtime.getCurrentGraph?.()?.historyState?.lastBatchStatus?.persistence || null,
    });
    runtime.deferAutoExtraction?.("pending-persist", {
      targetEndFloor: deferredTargetEndFloor,
      strategy: plan.strategy,
    });
    runtime.setLastExtractionStatus(
      "等待持久化确认",
      pendingPersistMessage,
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

    const persistence = batchResult.batchStatus?.persistence || null;
    if (batchResult.historyAdvanceAllowed === false) {
      runtime.setLastExtractionStatus(
        "提取完成，持久化待确认",
        `楼层 ${startIdx}-${endIdx} · 新建 ${batchResult.result?.newNodes || 0} · 更新 ${batchResult.result?.updatedNodes || 0} · 新边 ${batchResult.result?.newEdges || 0}${persistence?.reason ? ` · ${persistence.reason}` : ""}`,
        "warning",
        { syncRuntime: true },
      );
    } else {
      runtime.setLastExtractionStatus(
        "提取完成",
        `楼层 ${startIdx}-${endIdx} · 新建 ${batchResult.result?.newNodes || 0} · 更新 ${batchResult.result?.updatedNodes || 0} · 新边 ${batchResult.result?.newEdges || 0}`,
        "success",
        { syncRuntime: true },
      );
    }
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
  const taskLabel = String(options?.taskLabel || "手动提取").trim() || "手动提取";
  const toastTitle = String(options?.toastTitle || `ST-BME ${taskLabel}`).trim() ||
    `ST-BME ${taskLabel}`;
  const showStartToast = options?.showStartToast !== false;
  const lockedEndFloor = toSafeFloor(options?.lockedEndFloor, null);
  if (!runtime.ensureGraphMutationReady(taskLabel)) return;
  const pendingPersistGate = await maybeRetryPendingPersistence(
    runtime,
    "manual-extraction-persist-retry",
  );
  const pendingPersistMessage = pendingPersistGate
    ? formatPendingPersistenceGateMessage(runtime, taskLabel)
    : "";
  if (pendingPersistMessage) {
    runtime.setLastExtractionStatus(
      "等待持久化确认",
      pendingPersistMessage,
      "warning",
      {
        syncRuntime: true,
      },
    );
    runtime.toastr.warning("上一批持久化尚未确认，请先点“重试持久化”或“重新探测图谱”");
    return;
  }
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
  const targetAssistantTurns = pendingAssistantTurns.filter((i) => {
    if (lockedEndFloor != null && i > lockedEndFloor) return false;
    return true;
  });
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
  let processedAssistantTurns = 0;
  const warnings = [];

  runtime.setIsExtracting(true);
  const extractionController = runtime.beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  setExtractionProgressStatus(
    runtime,
    `${taskLabel}中`,
    lockedEndFloor != null
      ? `待处理 AI 回复 ${targetAssistantTurns.length} 条 · 截止 chatIndex ${lockedEndFloor}`
      : `待处理 AI 回复 ${targetAssistantTurns.length} 条`,
    "running",
    {
      syncRuntime: true,
      toastKind: showStartToast ? "info" : "",
      toastTitle,
    },
  );
  try {
    while (true) {
      const pendingTurns = runtime
        .getAssistantTurns(chat)
        .filter((i) => {
          if (i <= runtime.getLastProcessedAssistantFloor()) return false;
          if (lockedEndFloor != null && i > lockedEndFloor) return false;
          return true;
        });
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
      processedAssistantTurns += batchAssistantTurns.length;

      if (Array.isArray(batchResult.effects?.warnings)) {
        warnings.push(...batchResult.effects.warnings);
      }

      const totalTurnsForDisplay = Math.max(
        processedAssistantTurns,
        targetAssistantTurns.length,
      );
      setExtractionProgressStatus(
        runtime,
        `${taskLabel}中`,
        totalTurnsForDisplay > 0
          ? `已处理 ${processedAssistantTurns}/${totalTurnsForDisplay} 条 AI 回复 · 当前楼层 ${startIdx}-${endIdx} · 累计 ${totals.batches} 批`
          : `当前楼层 ${startIdx}-${endIdx} · 累计 ${totals.batches} 批`,
        "running",
        {
          syncRuntime: true,
          toastKind: "",
          toastTitle,
        },
      );

      if (batchResult.historyAdvanceAllowed === false) {
        warnings.push(
          batchResult.batchStatus?.persistence?.reason ||
            "当前批次持久化尚未确认",
        );
        break;
      }

      if (options?.drainAll === false) {
        break;
      }
    }

    if (totals.batches === 0) {
      setExtractionProgressStatus(
        runtime,
        "无待提取内容",
        lockedEndFloor != null
          ? "指定范围内没有新的 assistant 回复需要处理"
          : "没有新的 assistant 回复需要处理",
        "info",
        {
          syncRuntime: true,
        },
      );
      runtime.toastr.info("没有待提取的新回复");
      return;
    }

    const pendingAfterRun = getPendingPersistenceGateInfo(runtime);
    if (pendingAfterRun) {
      runtime.toastr.warning(
        `提取完成但持久化待确认：${pendingAfterRun.reason || pendingAfterRun.outcome || "unknown"}`,
      );
      runtime.setLastExtractionStatus(
        `${taskLabel}完成，持久化待确认`,
        `${totals.batches} 批 · 新建 ${totals.newNodes} · 更新 ${totals.updatedNodes} · 新边 ${totals.newEdges}${pendingAfterRun.reason ? ` · ${pendingAfterRun.reason}` : ""}`,
        "warning",
        {
          syncRuntime: true,
          toastKind: "",
          toastTitle,
        },
      );
    } else {
      runtime.toastr.success(
        `提取完成：${totals.batches} 批，新建 ${totals.newNodes}，更新 ${totals.updatedNodes}，新边 ${totals.newEdges}`,
      );
      runtime.setLastExtractionStatus(
        `${taskLabel}完成`,
        `${totals.batches} 批 · 新建 ${totals.newNodes} · 更新 ${totals.updatedNodes} · 新边 ${totals.newEdges}`,
        "success",
        {
          syncRuntime: true,
          toastKind: "success",
          toastTitle,
        },
      );
    }
    if (warnings.length > 0) {
      runtime.toastr.warning(warnings.slice(0, 2).join("；"), "ST-BME 提取警告", {
        timeOut: 5000,
      });
    }
  } catch (e) {
    if (runtime.isAbortError(e)) {
      runtime.setLastExtractionStatus(
        `${taskLabel}已终止`,
        e?.message || "已手动终止当前提取",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    runtime.console.error("[ST-BME] 手动提取失败:", e);
    runtime.setLastExtractionStatus(`${taskLabel}失败`, e?.message || String(e), "error", {
      syncRuntime: true,
      toastKind: "",
      toastTitle,
    });
    runtime.toastr.error(`${taskLabel}失败: ${e.message || e}`);
  } finally {
    runtime.finishStageAbortController("extraction", extractionController);
    runtime.setIsExtracting(false);
    runtime.refreshPanelLiveState();
  }
}

export async function onExtractionTaskController(runtime, options = {}) {
  const requestedMode = String(options?.mode || "pending").trim().toLowerCase();
  const context = runtime.getContext?.() || {};
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const runManualExtract = async (manualOptions = {}) => {
    if (typeof runtime?.onManualExtract === "function") {
      return await runtime.onManualExtract(manualOptions);
    }
    return await onManualExtractController(runtime, manualOptions);
  };

  if (requestedMode === "pending") {
    return await runManualExtract({
      ...options,
      taskLabel: "提取未处理",
      toastTitle: "ST-BME 重新提取",
    });
  }

  const rerunTask = resolveRerunDialogueTask(chat, options);
  if (!rerunTask.valid) {
    runtime.toastr?.info?.(rerunTask.reason || "当前没有可重提的范围");
    return {
      success: false,
      rerunPerformed: false,
      fallbackToLatest: false,
      requestedRange: [null, null],
      effectiveDialogueRange: [null, null],
      reason: rerunTask.reason || "invalid-rerun-range",
    };
  }

  const fallbackInfo = buildRerunFallbackInfo(chat, [
    rerunTask.startFloor,
    rerunTask.endFloor,
  ]);
  if (!fallbackInfo.valid) {
    runtime.toastr?.info?.(fallbackInfo.reason || "目标范围内没有可重提的 AI 回复");
    return {
      success: false,
      rerunPerformed: false,
      fallbackToLatest: false,
      requestedRange: [rerunTask.requestedStartFloor, rerunTask.requestedEndFloor],
      effectiveDialogueRange: [rerunTask.startFloor, rerunTask.endFloor],
      reason: fallbackInfo.reason || "no-assistant-in-range",
    };
  }

  const effectiveLockedEndFloor = fallbackInfo.fallbackToLatest
    ? null
    : fallbackInfo.endAssistantChatIndex;
  const effectiveDialogueRange = [
    rerunTask.startFloor,
    fallbackInfo.fallbackToLatest
      ? Number.isFinite(Number(fallbackInfo.latestAssistantDialogueFloor))
        ? Number(fallbackInfo.latestAssistantDialogueFloor)
        : rerunTask.endFloor
      : rerunTask.endFloor,
  ];

  setExtractionProgressStatus(
    runtime,
    "重新提取准备中",
    fallbackInfo.fallbackToLatest
      ? `范围 ${rerunTask.startFloor} ~ ${rerunTask.endFloor} 命中旧批次，但当前将退化为从 ${effectiveDialogueRange[0]} 到最新重提`
      : `准备重提范围 ${rerunTask.startFloor} ~ ${rerunTask.endFloor}`,
    fallbackInfo.fallbackToLatest ? "warning" : "running",
    {
      syncRuntime: true,
      toastKind: "info",
      toastTitle: "ST-BME 重新提取",
    },
  );

  const rollbackResult = await runtime.rollbackGraphForReroll(
    fallbackInfo.startAssistantChatIndex,
    context,
  );
  if (!rollbackResult?.success) {
    const rollbackError = String(
      rollbackResult?.error ||
        rollbackResult?.reason ||
        rollbackResult?.recoveryPath ||
        "回滚失败",
    ).trim() || "回滚失败";
    setExtractionProgressStatus(
      runtime,
      "重新提取失败",
      rollbackError,
      "warning",
      {
        syncRuntime: true,
        toastKind: "",
        toastTitle: "ST-BME 重新提取",
      },
    );
    runtime.toastr?.warning?.(
      `重新提取未开始：${rollbackError}`,
      "ST-BME 重新提取",
      {
        timeOut: 4500,
      },
    );
    return {
      ...rollbackResult,
      rerunPerformed: false,
      fallbackToLatest: fallbackInfo.fallbackToLatest,
      requestedRange: [rerunTask.requestedStartFloor, rerunTask.requestedEndFloor],
      effectiveDialogueRange,
    };
  }

  if (fallbackInfo.reason) {
    runtime.toastr?.warning?.(fallbackInfo.reason, "ST-BME 重新提取", {
      timeOut: 3500,
    });
  }

  const rollbackDesc =
    rollbackResult.effectiveFromFloor !== fallbackInfo.startAssistantChatIndex
      ? `已按批次边界回滚到楼层 ${rollbackResult.effectiveFromFloor}，正在开始重新提取`
      : `已回滚到楼层 ${fallbackInfo.startAssistantChatIndex}，正在开始重新提取`;
  setExtractionProgressStatus(
    runtime,
    "重新提取中",
    rollbackDesc,
    "running",
    {
      syncRuntime: true,
      toastKind: "",
      toastTitle: "ST-BME 重新提取",
    },
  );

  await runManualExtract({
    drainAll: true,
    lockedEndFloor: effectiveLockedEndFloor,
    taskLabel: "重新提取",
    toastTitle: "ST-BME 重新提取",
    showStartToast: false,
  });

  return {
    success: true,
    rerunPerformed: true,
    fallbackToLatest: fallbackInfo.fallbackToLatest,
    requestedRange: [rerunTask.requestedStartFloor, rerunTask.requestedEndFloor],
    effectiveDialogueRange,
    effectiveAssistantChatRange: [
      fallbackInfo.startAssistantChatIndex,
      effectiveLockedEndFloor,
    ],
    rollbackResult,
    reason: fallbackInfo.reason || "",
  };
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

  setExtractionProgressStatus(
    runtime,
    "重新提取准备中",
    Number.isFinite(targetFloor)
      ? `准备从楼层 ${targetFloor} 开始回滚并重新提取`
      : "准备回滚最新 AI 楼并重新提取",
    "running",
    {
      syncRuntime: true,
      toastKind: "info",
      toastTitle: "ST-BME 重 Roll",
    },
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
      setExtractionProgressStatus(
        runtime,
        "重新提取已取消",
        e.message || "聊天已切换",
        "warning",
        {
          syncRuntime: true,
        },
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
    setExtractionProgressStatus(
      runtime,
      "重新提取失败",
      rollbackResult.error || "回滚失败",
      "error",
      {
        syncRuntime: true,
      },
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

  setExtractionProgressStatus(
    runtime,
    "重新提取中",
    rerollDesc,
    "running",
    {
      syncRuntime: true,
      toastKind: "",
      toastTitle: "ST-BME 重 Roll",
    },
  );

  await runtime.onManualExtract({ drainAll: false, showStartToast: false });
  runtime.refreshPanelLiveState();
  return {
    ...rollbackResult,
    extractionTriggered: true,
    extractionStatus: runtime.getLastExtractionStatusLevel?.() || "idle",
  };
}
