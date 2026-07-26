import assert from "node:assert/strict";
import { onManualExtractController } from "../maintenance/extraction-controller.js";
import { onRebuildController } from "../ui/ui-actions-controller.js";
import { syncVectorStateController } from "../vector/vector-sync-controller.js";

// Shared status facade that mirrors index.js setRuntimeStatus / setLastXStatus
// semantics the way controllers consume them (status setters are injected
// dependencies). No index.js slicing — controllers are imported directly.
function createBaseStatusContext() {
  const context = {
    console,
    Date,
    createUiStatus(text = "待命", meta = "", level = "idle") {
      return {
        text: String(text || "待命"),
        meta: String(meta || ""),
        level,
        updatedAt: Date.now(),
      };
    },
    runtimeStatus: { text: "待命", meta: "", level: "idle" },
    lastExtractionStatus: { text: "待命", meta: "", level: "idle" },
    lastVectorStatus: { text: "待命", meta: "", level: "idle" },
    lastRecallStatus: { text: "待命", meta: "", level: "idle" },
    lastStatusToastAt: {},
    STATUS_TOAST_THROTTLE_MS: 1500,
    getContext() {
      return {};
    },
    resolveOperationalChatId(context, graph, explicitChatId = "") {
      return (
        String(explicitChatId || "").trim() ||
        String(graph?.historyState?.chatId || "").trim() ||
        "chat-mobile"
      );
    },
    _panelModule: {
      updateFloatingBallStatus() {},
    },
    refreshPanelLiveState() {},
    updateStageNotice() {},
    notifyStatusToast() {},
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
  };

  context.setRuntimeStatus = function (text, meta, level = "info") {
    this.runtimeStatus = this.createUiStatus(text, meta, level);
  };
  context.setLastExtractionStatus = function (
    text,
    meta,
    level = "info",
    { syncRuntime = true } = {},
  ) {
    this.lastExtractionStatus = this.createUiStatus(text, meta, level);
    if (syncRuntime) this.setRuntimeStatus(text, meta, level);
  };
  context.setLastVectorStatus = function (
    text,
    meta,
    level = "info",
    { syncRuntime = false } = {},
  ) {
    this.lastVectorStatus = this.createUiStatus(text, meta, level);
    if (syncRuntime) this.setRuntimeStatus(text, meta, level);
  };
  context.setLastRecallStatus = function (
    text,
    meta,
    level = "info",
    { syncRuntime = true } = {},
  ) {
    this.lastRecallStatus = this.createUiStatus(text, meta, level);
    if (syncRuntime) this.setRuntimeStatus(text, meta, level);
  };

  return context;
}

async function testVectorSyncTerminalStateUpdatesRuntime() {
  const context = {
    ...createBaseStatusContext(),
    currentGraph: {
      vectorIndexState: {
        dirty: true,
        lastWarning: "",
      },
    },
    ensureCurrentGraphRuntimeState() {
      return context.currentGraph;
    },
    getCurrentGraph() {
      return context.currentGraph;
    },
    getEmbeddingConfig() {
      return { mode: "direct" };
    },
    validateVectorConfig() {
      return { valid: true };
    },
    async syncGraphVectorIndex() {
      return {
        insertedHashes: [],
        stats: {
          indexed: 12,
          pending: 0,
        },
      };
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    getVectorIndexStats() {
      return { indexed: 12, pending: 0 };
    },
    isAbortError() {
      return false;
    },
    markVectorStateDirty() {},
  };

  const result = await syncVectorStateController(context, { force: true });
  assert.equal(result.stats.indexed, 12);
  assert.equal(context.lastVectorStatus.text, "向量完成");
  assert.equal(context.runtimeStatus.text, "向量完成");
  assert.equal(context.runtimeStatus.level, "success");
}

async function testVectorSyncIgnoresLateCompletionAfterChatSwitch() {
  let releaseSync;
  let markDirtyCalls = 0;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const graphA = {
    historyState: { chatId: "chat-a" },
    vectorIndexState: { dirty: true, lastWarning: "" },
  };
  const graphB = {
    historyState: { chatId: "chat-b" },
    vectorIndexState: { dirty: false, lastWarning: "" },
  };
  const context = {
    ...createBaseStatusContext(),
    currentGraph: graphA,
    ensureCurrentGraphRuntimeState() {},
    getCurrentGraph() {
      return context.currentGraph;
    },
    getEmbeddingConfig() {
      return { mode: "direct" };
    },
    validateVectorConfig() {
      return { valid: true };
    },
    async syncGraphVectorIndex() {
      notifyStarted();
      return await new Promise((resolve) => {
        releaseSync = resolve;
      });
    },
    getVectorIndexStats(graph) {
      return { indexed: graph === graphA ? 1 : 2, pending: 0 };
    },
    isAbortError() {
      return false;
    },
    markVectorStateDirty() {
      markDirtyCalls += 1;
    },
  };

  const pending = syncVectorStateController(context, {
    force: true,
    expectedChatId: "chat-a",
  });
  await started;
  context.currentGraph = graphB;
  context.lastVectorStatus = { text: "B-vector", meta: "", level: "idle" };
  context.runtimeStatus = { text: "B-runtime", meta: "", level: "idle" };
  releaseSync({ insertedHashes: ["late-a"], stats: { indexed: 1, pending: 0 } });

  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.stale, true);
  assert.equal(result.error, "vector-sync-context-changed");
  assert.equal(context.lastVectorStatus.text, "B-vector");
  assert.equal(context.runtimeStatus.text, "B-runtime");
  assert.equal(markDirtyCalls, 0);
}

async function testManualExtractNoBatchesDoesNotStayRunning() {
  let assistantTurnCallCount = 0;
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  const context = {
    ...createBaseStatusContext(),
    isExtracting: false,
    currentGraph: {},
    graphPersistenceState: {
      pendingPersist: false,
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    getGraphPersistenceState() {
      return { pendingPersist: false };
    },
    getCurrentGraph() {
      return context.currentGraph;
    },
    getIsExtracting() {
      return context.isExtracting;
    },
    setIsExtracting(value) {
      context.isExtracting = value;
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    setCurrentGraph(graph) {
      context.currentGraph = graph;
    },
    createEmptyGraph() {
      return {};
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      assistantTurnCallCount += 1;
      return assistantTurnCallCount === 1 ? [1] : [];
    },
    getLastProcessedAssistantFloor() {
      return 0;
    },
    clampInt(value, fallback) {
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    beginStageAbortController() {
      return { signal: {} };
    },
    async executeExtractionBatch() {
      throw new Error("不应进入批次执行");
    },
    async retryPendingGraphPersist() {
      return {
        accepted: false,
        reason: "no-pending-persist",
      };
    },
    isAbortError() {
      return false;
    },
    onManualExtractController,
    finishStageAbortController() {},
  };

  await onManualExtractController(context, { drainAll: false });
  assert.equal(context.isExtracting, false);
  assert.equal(context.lastExtractionStatus.text, "无待提取内容");
  assert.equal(context.runtimeStatus.text, "无待提取内容");
  assert.notEqual(context.runtimeStatus.level, "running");
}

async function testManualExtractIgnoresSupersededPendingPersistence() {
  let executeExtractionBatchCalls = 0;
  let assistantTurnCallCount = 0;
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  const context = {
    ...createBaseStatusContext(),
    isExtracting: false,
    graphPersistenceState: {
      pendingPersist: false,
      lastAcceptedRevision: 7,
    },
    currentGraph: {
      historyState: {
        lastBatchStatus: {
          processedRange: [1, 1],
          persistence: {
            outcome: "queued",
            accepted: false,
            revision: 7,
            reason: "extraction-batch-complete:pending",
            storageTier: "none",
          },
        },
      },
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    getCurrentGraph() {
      return context.currentGraph;
    },
    getIsExtracting() {
      return context.isExtracting;
    },
    getGraphPersistenceState() {
      return {
        pendingPersist: false,
        lastAcceptedRevision: 7,
      };
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    setCurrentGraph(graph) {
      context.currentGraph = graph;
    },
    createEmptyGraph() {
      return {};
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      assistantTurnCallCount += 1;
      return assistantTurnCallCount <= 2 ? [1] : [];
    },
    getLastProcessedAssistantFloor() {
      return 0;
    },
    clampInt(value, fallback) {
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    beginStageAbortController() {
      return { signal: {} };
    },
    async executeExtractionBatch() {
      executeExtractionBatchCalls += 1;
      return {
        success: true,
        result: {
          newNodes: 0,
          updatedNodes: 0,
          newEdges: 0,
        },
        effects: {},
        batchStatus: {
          persistence: {
            accepted: true,
          },
        },
        historyAdvanceAllowed: true,
      };
    },
    async retryPendingGraphPersist() {
      return {
        accepted: false,
        reason: "no-pending-persist",
      };
    },
    isAbortError() {
      return false;
    },
    onManualExtractController,
    finishStageAbortController() {},
    setIsExtracting(value) {
      context.isExtracting = value;
    },
    setLastExtractionStatus(text, meta, level) {
      context.lastExtractionStatus = { text, meta, level };
      context.runtimeStatus = { text, meta, level };
    },
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
    result: null,
  };
  await onManualExtractController(context, { drainAll: false });
  assert.equal(executeExtractionBatchCalls, 1);
  assert.notEqual(context.lastExtractionStatus.text, "等待持久化确认");
}

async function testManualExtractContinuesWithRecoverablePendingPersistence() {
  let executeExtractionBatchCalls = 0;
  let assistantTurnCallCount = 0;
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  const context = {
    ...createBaseStatusContext(),
    isExtracting: false,
    graphPersistenceState: {
      pendingPersist: true,
      lastAcceptedRevision: 0,
      queuedPersistRevision: 7,
      shadowSnapshotRevision: 7,
      lastRecoverableStorageTier: "shadow",
    },
    currentGraph: {
      historyState: {
        lastBatchStatus: {
          processedRange: [1, 1],
          persistence: {
            outcome: "queued",
            accepted: false,
            revision: 7,
            reason: "extraction-batch-complete:pending",
            storageTier: "shadow",
          },
        },
      },
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    getCurrentGraph() {
      return context.currentGraph;
    },
    getIsExtracting() {
      return context.isExtracting;
    },
    getGraphPersistenceState() {
      return {
        pendingPersist: true,
        lastAcceptedRevision: 0,
        queuedPersistRevision: 7,
        shadowSnapshotRevision: 7,
        lastRecoverableStorageTier: "shadow",
      };
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    setCurrentGraph(graph) {
      context.currentGraph = graph;
    },
    createEmptyGraph() {
      return {};
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      assistantTurnCallCount += 1;
      return assistantTurnCallCount <= 2 ? [1] : [];
    },
    getLastProcessedAssistantFloor() {
      return 0;
    },
    clampInt(value, fallback) {
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    beginStageAbortController() {
      return { signal: {} };
    },
    async executeExtractionBatch() {
      executeExtractionBatchCalls += 1;
      return {
        success: true,
        result: {
          newNodes: 0,
          updatedNodes: 0,
          newEdges: 0,
        },
        effects: {},
        batchStatus: {
          persistence: {
            accepted: true,
          },
        },
        historyAdvanceAllowed: true,
      };
    },
    async retryPendingGraphPersist() {
      return {
        accepted: false,
        reason: "shadow-still-pending",
      };
    },
    isAbortError() {
      return false;
    },
    onManualExtractController,
    finishStageAbortController() {},
    setIsExtracting(value) {
      context.isExtracting = value;
    },
    setLastExtractionStatus(text, meta, level) {
      context.lastExtractionStatus = { text, meta, level };
      context.runtimeStatus = { text, meta, level };
    },
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
    result: null,
  };
  await onManualExtractController(context, { drainAll: false });
  assert.equal(executeExtractionBatchCalls, 1);
  assert.notEqual(context.lastExtractionStatus.text, "等待持久化确认");
}

async function testManualExtractIgnoresFailedBatchWithoutPersistenceAttempt() {
  let executeExtractionBatchCalls = 0;
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  const context = {
    ...createBaseStatusContext(),
    isExtracting: false,
    graphPersistenceState: {
      pendingPersist: false,
      lastAcceptedRevision: 0,
    },
    currentGraph: {
      historyState: {
        lastBatchStatus: {
          outcome: "failed",
          processedRange: [1, 1],
          persistence: {
            outcome: "queued",
            accepted: false,
            revision: 0,
            reason: "",
            storageTier: "none",
          },
        },
      },
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    getCurrentGraph() {
      return context.currentGraph;
    },
    getIsExtracting() {
      return context.isExtracting;
    },
    getGraphPersistenceState() {
      return {
        pendingPersist: false,
        lastAcceptedRevision: 0,
      };
    },
    ensureGraphMutationReady() {
      return true;
    },
    async recoverHistoryIfNeeded() {
      return true;
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    setCurrentGraph(graph) {
      context.currentGraph = graph;
    },
    createEmptyGraph() {
      return {};
    },
    getContext() {
      return { chat };
    },
    getAssistantTurns() {
      return [1];
    },
    getLastProcessedAssistantFloor() {
      return 0;
    },
    clampInt(value, fallback) {
      return Number.isFinite(Number(value)) ? Number(value) : fallback;
    },
    getSettings() {
      return { extractEvery: 1 };
    },
    beginStageAbortController() {
      return { signal: {} };
    },
    async executeExtractionBatch() {
      executeExtractionBatchCalls += 1;
      return {
        success: true,
        result: {
          newNodes: 0,
          updatedNodes: 0,
          newEdges: 0,
        },
        effects: {},
        batchStatus: {
          persistence: {
            accepted: true,
            revision: 1,
            attempted: true,
          },
        },
        historyAdvanceAllowed: true,
      };
    },
    async retryPendingGraphPersist() {
      return {
        accepted: false,
        reason: "no-pending-persist",
      };
    },
    isAbortError() {
      return false;
    },
    onManualExtractController,
    finishStageAbortController() {},
    setIsExtracting(value) {
      context.isExtracting = value;
    },
    setLastExtractionStatus(text, meta, level) {
      context.lastExtractionStatus = { text, meta, level };
      context.runtimeStatus = { text, meta, level };
    },
    toastr: {
      info() {},
      success() {},
      warning() {},
      error() {},
    },
    result: null,
  };

  await onManualExtractController(context, { drainAll: false });
  assert.equal(executeExtractionBatchCalls, 1);
  assert.notEqual(context.lastExtractionStatus.text, "等待持久化确认");
}

async function testManualRebuildSetsTerminalRuntimeStatus() {
  const chat = [{ is_user: true, mes: "u" }, { is_user: false, mes: "a" }];
  let savedHashes = null;
  let savedNeedRefresh = null;
  const context = {
    ...createBaseStatusContext(),
    __confirmHost: true,
    currentGraph: {
      historyState: {
        lastProcessedAssistantFloor: -1,
        processedMessageHashes: {},
        processedMessageHashesNeedRefresh: false,
      },
      vectorIndexState: {
        lastWarning: "",
      },
      batchJournal: [],
    },
    confirm() {
      assert.equal(this?.__confirmHost, true);
      return true;
    },
    getCurrentGraph() {
      return context.currentGraph;
    },
    setCurrentGraph(graph) {
      context.currentGraph = graph;
    },
    ensureGraphMutationReady() {
      return true;
    },
    getContext() {
      return { chat };
    },
    cloneGraphSnapshot(graph) {
      return graph;
    },
    snapshotRuntimeUiState() {
      return {};
    },
    getSettings() {
      return {};
    },
    normalizeGraphRuntimeState(graph) {
      return graph;
    },
    createEmptyGraph() {
      return {
        historyState: {
          lastProcessedAssistantFloor: -1,
          processedMessageHashes: {},
          processedMessageHashesNeedRefresh: false,
        },
        vectorIndexState: {
          lastWarning: "",
        },
        batchJournal: [],
      };
    },
    getCurrentChatId() {
      return "chat-mobile";
    },
    clearInjectionState() {},
    async prepareVectorStateForReplay() {},
    async replayExtractionFromHistory() {
      context.currentGraph.historyState.lastProcessedAssistantFloor = 1;
      context.currentGraph.vectorIndexState.lastWarning = "";
      return 2;
    },
    clearHistoryDirty(graph) {
      graph.historyState.processedMessageHashes = {};
      graph.historyState.processedMessageHashesNeedRefresh = true;
    },
    buildRecoveryResult(status, extra = {}) {
      return { status, ...extra };
    },
    updateProcessedHistorySnapshot(chatInput, floor) {
      context.currentGraph.historyState.lastProcessedAssistantFloor = floor;
      context.currentGraph.historyState.processedMessageHashes = {};
      for (let index = 0; index <= floor; index += 1) {
        context.currentGraph.historyState.processedMessageHashes[index] =
          String(chatInput[index]?.mes || "");
      }
      context.currentGraph.historyState.processedMessageHashesNeedRefresh = false;
    },
    saveGraphToChat() {
      savedHashes = { ...context.currentGraph.historyState.processedMessageHashes };
      savedNeedRefresh =
        context.currentGraph.historyState.processedMessageHashesNeedRefresh;
    },
    restoreRuntimeUiState() {},
    async runWithRestoreLock(_source, _reason, task) {
      return await task();
    },
    onRebuildController,
  };

  await onRebuildController(context);
  assert.equal(context.lastExtractionStatus.text, "图谱重建完成");
  assert.equal(context.runtimeStatus.text, "图谱重建完成");
  assert.equal(context.runtimeStatus.level, "success");
  assert.deepEqual(savedHashes, {
    0: "u",
    1: "a",
  });
  assert.equal(savedNeedRefresh, false);
}

await testVectorSyncTerminalStateUpdatesRuntime();
await testVectorSyncIgnoresLateCompletionAfterChatSwitch();
await testManualExtractNoBatchesDoesNotStayRunning();
await testManualExtractIgnoresSupersededPendingPersistence();
await testManualExtractContinuesWithRecoverablePendingPersistence();
await testManualExtractIgnoresFailedBatchWithoutPersistenceAttempt();
await testManualRebuildSetsTerminalRuntimeStatus();

console.log("mobile-status-regressions tests passed");
