import assert from "node:assert/strict";

import { executeExtractionBatchController } from "../maintenance/extraction-controller.js";
import {
  createBatchStatusSkeleton,
  finalizeBatchStatus,
  setBatchStageOutcome,
} from "../ui/ui-status.js";

function createRuntime(persistResult) {
  const graph = {
    nodes: [],
    edges: [],
    historyState: {
      chatId: "chat-test",
      extractionCount: 6,
      processedMessageHashes: { 4: "old-hash" },
    },
    batchJournal: [],
  };
  let activeGraph = graph;
  let activeChatId = "chat-test";
  let processedHistoryUpdates = 0;
  let persistedGraphSnapshot = null;
  let lastPersistDeltaOptions = null;
  let extractionCount = 6;

  return {
    graph,
    processedHistoryUpdates,
    persistedGraphSnapshot,
    ensureCurrentGraphRuntimeState() {},
    throwIfAborted() {},
    getCurrentGraph() {
      return activeGraph;
    },
    setCurrentGraph(graph) {
      activeGraph = graph;
    },
    getCurrentChatId() {
      return activeChatId;
    },
    setActiveContext(nextGraph, nextChatId) {
      activeGraph = nextGraph;
      activeChatId = String(nextChatId || "");
    },
    createAbortError(message) {
      const error = new Error(message);
      error.name = "AbortError";
      return error;
    },
    getLastProcessedAssistantFloor() {
      return 4;
    },
    getExtractionCount() {
      return extractionCount;
    },
    setExtractionCount(value) {
      extractionCount = Number(value || 0);
    },
    cloneGraphSnapshot(value) {
      return JSON.parse(JSON.stringify(value));
    },
    buildPersistDelta(_beforeSnapshot, _afterSnapshot, options = {}) {
      lastPersistDeltaOptions = { ...(options || {}) };
      return {
        upsertNodes: [],
        upsertEdges: [],
        deleteNodeIds: [],
        deleteEdgeIds: [],
        tombstones: [],
        countDelta: {
          nodes: 0,
          edges: 0,
          tombstones: 0,
        },
        runtimeMetaPatch: {},
      };
    },
    buildExtractionMessages() {
      return [{ seq: 5, role: "assistant", content: "测试消息" }];
    },
    createBatchStatusSkeleton,
    async extractMemories({ graph: targetGraph }) {
      targetGraph.nodes.push({ id: "node-1", type: "event" });
      return {
        success: true,
        newNodes: 1,
        updatedNodes: 0,
        newEdges: 0,
        newNodeIds: ["node-1"],
        processedRange: [5, 5],
      };
    },
    getSchema() {
      return [];
    },
    getEmbeddingConfig() {
      return null;
    },
    setLastExtractionStatus() {},
    setBatchStageOutcome,
    async handleExtractionSuccess(
      result,
      _endIdx,
      _settings,
      _signal,
      batchStatus,
      _postProcessContext,
      taskContext,
    ) {
      taskContext.graph.historyState.extractionCount = extractionCount + 1;
      setBatchStageOutcome(batchStatus, "finalize", "success");
      return {
        postProcessArtifacts: [],
        vectorHashesInserted: [],
        warnings: [],
        batchStatus,
      };
    },
    async persistExtractionBatchResult() {
      persistedGraphSnapshot = arguments[0]?.graphSnapshot || null;
      return persistResult;
    },
    finalizeBatchStatus,
    shouldAdvanceProcessedHistory(batchStatus) {
      return batchStatus.historyAdvanceAllowed === true;
    },
    updateProcessedHistorySnapshot() {
      processedHistoryUpdates += 1;
    },
    appendBatchJournal(targetGraph, entry) {
      if (!targetGraph.batchJournal) targetGraph.batchJournal = [];
      targetGraph.batchJournal.push(entry);
    },
    createBatchJournalEntry() {
      return { id: "journal-1", processedRange: [5, 5] };
    },
    computePostProcessArtifacts() {
      return [];
    },
    applyProcessedHistorySnapshotToGraph(targetGraph, _chat, floor) {
      targetGraph.historyState.lastProcessedAssistantFloor = floor;
      targetGraph.historyState.processedMessageHashes = {
        ...targetGraph.historyState.processedMessageHashes,
        [floor]: `hash-${floor}`,
      };
      targetGraph.lastProcessedSeq = floor;
    },
    getGraphPersistenceState() {
      return { chatId: "chat-test" };
    },
    stampGraphPersistenceMeta() {},
    updateLastExtractedItems() {},
    console,
    get processedHistoryUpdates() {
      return processedHistoryUpdates;
    },
    get persistedGraphSnapshot() {
      return persistedGraphSnapshot;
    },
    get lastPersistDeltaOptions() {
      return lastPersistDeltaOptions;
    },
  };
}

{
  const runtime = createRuntime({
    saved: false,
    queued: true,
    blocked: true,
    accepted: false,
    reason: "persist-queued",
    revision: 7,
    saveMode: "immediate",
    storageTier: "none",
  });
  const result = await executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "测试" }],
    startIdx: 5,
    endIdx: 5,
    settings: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.historyAdvanceAllowed, false);
  assert.equal(runtime.processedHistoryUpdates, 0);
  assert.equal(
    runtime.getCurrentGraph().historyState.lastBatchStatus.persistence.outcome,
    "queued",
  );
  assert.equal(
    runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanceAllowed,
    false,
  );
  assert.equal(
    runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanced,
    false,
  );
  assert.equal(runtime.getCurrentGraph().batchJournal.length, 0);
  assert.equal(runtime.getCurrentGraph().nodes.length, 0);
  assert.equal(runtime.getCurrentGraph().historyState.extractionCount, 6);
  assert.deepEqual(
    runtime.getCurrentGraph().historyState.processedMessageHashes,
    { 4: "old-hash" },
  );
  assert.equal(
    runtime.persistedGraphSnapshot?.historyState?.lastProcessedAssistantFloor,
    5,
  );
  assert.equal(
    runtime.persistedGraphSnapshot?.batchJournal?.length,
    1,
  );
  assert.equal(runtime.persistedGraphSnapshot?.nodes?.length, 1);
  assert.equal(runtime.persistedGraphSnapshot?.historyState?.extractionCount, 7);
  assert.equal(
    runtime.persistedGraphSnapshot?.historyState?.processedMessageHashes?.[5],
    "hash-5",
  );
}

{
  const runtime = createRuntime({
    saved: true,
    queued: false,
    blocked: false,
    accepted: true,
    reason: "indexeddb",
    revision: 8,
    saveMode: "indexeddb",
    storageTier: "indexeddb",
  });
  const result = await executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "测试" }],
    startIdx: 5,
    endIdx: 5,
    settings: {},
  });

  assert.equal(result.success, true);
  assert.equal(result.historyAdvanceAllowed, true);
  assert.equal(runtime.processedHistoryUpdates, 0);
  assert.equal(
    runtime.getCurrentGraph().historyState.lastBatchStatus.persistence.outcome,
    "saved",
  );
  assert.equal(
    runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanceAllowed,
    true,
  );
  assert.equal(
    runtime.persistedGraphSnapshot?.historyState?.lastProcessedAssistantFloor,
    5,
  );
  assert.equal(
    runtime.persistedGraphSnapshot?.batchJournal?.length,
    1,
  );
  assert.equal(runtime.getCurrentGraph().nodes.length, 1);
  assert.equal(runtime.getCurrentGraph().batchJournal.length, 1);
  assert.equal(runtime.getCurrentGraph().historyState.extractionCount, 7);
  assert.equal(
    runtime.getCurrentGraph().historyState.processedMessageHashes?.[5],
    "hash-5",
  );
  assert.equal(
    runtime.getCurrentGraph().historyState.lastProcessedAssistantFloor,
    5,
  );
}

{
  const runtime = createRuntime({
    saved: false,
    queued: false,
    blocked: false,
    accepted: false,
    reason: "should-not-run",
    revision: 0,
    saveMode: "",
    storageTier: "none",
  });
  runtime.extractMemories = async ({ graph: targetGraph }) => {
    targetGraph.nodes.push({ id: "partial-node", type: "event" });
    return {
      success: false,
      error: "提取 LLM 未返回有效操作",
      processedRange: [4, 4],
    };
  };
  const result = await executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "测试" }],
    startIdx: 5,
    endIdx: 5,
    settings: {},
  });

  assert.equal(result.success, false);
  assert.equal(result.batchStatus.completed, false);
  assert.equal(result.batchStatus.stages.core.outcome, "failed");
  assert.equal(result.batchStatus.stages.finalize.outcome, "failed");
  assert.equal(runtime.getCurrentGraph().historyState.lastBatchStatus.persistence, null);
  assert.equal(runtime.getCurrentGraph().nodes.length, 0);
}

{
  const originalNativeBuilder = globalThis.__stBmeNativeBuildPersistDelta;
  globalThis.__stBmeNativeBuildPersistDelta = () => ({
    upsertNodes: [],
    upsertEdges: [],
    deleteNodeIds: [],
    deleteEdgeIds: [],
    tombstones: [],
    runtimeMetaPatch: {},
  });
  const runtime = createRuntime({
    saved: true,
    queued: false,
    blocked: false,
    accepted: true,
    reason: "indexeddb",
    revision: 9,
    saveMode: "indexeddb",
    storageTier: "indexeddb",
  });
  const result = await executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "测试" }],
    startIdx: 5,
    endIdx: 5,
    settings: {
      persistUseNativeDelta: true,
      graphNativeForceDisable: false,
      nativeEngineFailOpen: true,
      persistNativeDeltaThresholdRecords: 123,
      persistNativeDeltaThresholdStructuralDelta: 45,
      persistNativeDeltaThresholdSerializedChars: 6789,
      persistNativeDeltaBridgeMode: "hash",
    },
  });

  assert.equal(result.success, true);
  assert.equal(runtime.lastPersistDeltaOptions.useNativeDelta, true);
  assert.equal(runtime.lastPersistDeltaOptions.nativeFailOpen, true);
  assert.equal(runtime.lastPersistDeltaOptions.persistNativeDeltaThresholdRecords, 123);
  assert.equal(
    runtime.lastPersistDeltaOptions.persistNativeDeltaThresholdStructuralDelta,
    45,
  );
  assert.equal(
    runtime.lastPersistDeltaOptions.persistNativeDeltaThresholdSerializedChars,
    6789,
  );
  assert.equal(runtime.lastPersistDeltaOptions.persistNativeDeltaBridgeMode, "hash");

  if (typeof originalNativeBuilder === "function") {
    globalThis.__stBmeNativeBuildPersistDelta = originalNativeBuilder;
  } else {
    delete globalThis.__stBmeNativeBuildPersistDelta;
  }
}

{
  const runtime = createRuntime({
    saved: true,
    queued: false,
    blocked: false,
    accepted: true,
    reason: "indexeddb",
    revision: 10,
    saveMode: "indexeddb",
    storageTier: "indexeddb",
  });
  const result = await executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "测试" }],
    startIdx: 5,
    endIdx: 5,
    settings: {
      persistUseNativeDelta: true,
      graphNativeForceDisable: true,
    },
  });

  assert.equal(result.success, true);
  assert.equal(runtime.lastPersistDeltaOptions.useNativeDelta, false);
}

{
  let releaseExtraction;
  let notifyStarted;
  let handleSuccessCalls = 0;
  let persistCalls = 0;
  let extractionStatusCalls = 0;
  let reportStreamProgress = null;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const runtime = createRuntime({
    saved: true,
    queued: false,
    blocked: false,
    accepted: true,
    reason: "indexeddb",
    revision: 11,
    saveMode: "indexeddb",
    storageTier: "indexeddb",
  });
  runtime.extractMemories = async ({ onStreamProgress }) => {
    reportStreamProgress = onStreamProgress;
    notifyStarted();
    return await new Promise((resolve) => {
      releaseExtraction = resolve;
    });
  };
  runtime.handleExtractionSuccess = async () => {
    handleSuccessCalls += 1;
    return {};
  };
  runtime.persistExtractionBatchResult = async () => {
    persistCalls += 1;
    return { accepted: true, saved: true };
  };
  runtime.setLastExtractionStatus = () => {
    extractionStatusCalls += 1;
  };

  const pending = executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "chat A" }],
    startIdx: 5,
    endIdx: 5,
    settings: {},
  });
  await started;
  const graphB = {
    nodes: [],
    edges: [],
    historyState: { chatId: "chat-b" },
    batchJournal: [],
  };
  runtime.setActiveContext(graphB, "chat-b");
  reportStreamProgress({ previewText: "late A stream", receivedChars: 13 });
  releaseExtraction({
    success: true,
    newNodes: 1,
    updatedNodes: 0,
    newEdges: 0,
    newNodeIds: ["late-a"],
    processedRange: [5, 5],
  });

  await assert.rejects(
    pending,
    (error) =>
      error?.name === "AbortError" &&
      error?.message === "extraction-context-changed",
  );
  assert.equal(handleSuccessCalls, 0);
  assert.equal(persistCalls, 0);
  assert.equal(extractionStatusCalls, 0);
  assert.equal(graphB.historyState.lastBatchStatus, undefined);
}

{
  let releasePersist;
  let notifyPersistStarted;
  const persistStarted = new Promise((resolve) => {
    notifyPersistStarted = resolve;
  });
  const runtime = createRuntime(null);
  runtime.persistExtractionBatchResult = async () => {
    notifyPersistStarted();
    return await new Promise((resolve) => {
      releasePersist = resolve;
    });
  };

  const pending = executeExtractionBatchController(runtime, {
    chat: [{ is_user: false, mes: "chat A" }],
    startIdx: 5,
    endIdx: 5,
    settings: {},
  });
  await persistStarted;
  const graphB = {
    nodes: [{ id: "node-b" }],
    edges: [],
    historyState: { chatId: "chat-b", extractionCount: 2 },
    batchJournal: [],
  };
  runtime.setActiveContext(graphB, "chat-b");
  releasePersist({
    saved: true,
    accepted: true,
    revision: 12,
    storageTier: "indexeddb",
  });

  await assert.rejects(
    pending,
    (error) =>
      error?.name === "AbortError" &&
      error?.message === "extraction-context-changed",
  );
  assert.deepEqual(graphB.nodes, [{ id: "node-b" }]);
  assert.equal(graphB.historyState.extractionCount, 2);
  assert.equal(graphB.historyState.lastProcessedAssistantFloor, undefined);
  assert.equal(runtime.graph.nodes.length, 0);
  assert.equal(runtime.graph.historyState.extractionCount, 6);
  assert.deepEqual(runtime.graph.historyState.processedMessageHashes, {
    4: "old-hash",
  });
}

console.log("extraction-persistence-gating tests passed");
