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
    historyState: {},
    batchJournal: [],
  };
  let processedHistoryUpdates = 0;
  let persistedGraphSnapshot = null;

  return {
    graph,
    processedHistoryUpdates,
    persistedGraphSnapshot,
    ensureCurrentGraphRuntimeState() {},
    throwIfAborted() {},
    getCurrentGraph() {
      return graph;
    },
    getLastProcessedAssistantFloor() {
      return 4;
    },
    getExtractionCount() {
      return 6;
    },
    cloneGraphSnapshot(value) {
      return JSON.parse(JSON.stringify(value));
    },
    buildExtractionMessages() {
      return [{ seq: 5, role: "assistant", content: "测试消息" }];
    },
    createBatchStatusSkeleton,
    async extractMemories() {
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
    async handleExtractionSuccess(result, _endIdx, _settings, _signal, batchStatus) {
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
      targetGraph.lastProcessedSeq = floor;
    },
    getGraphPersistenceState() {
      return { chatId: "chat-test" };
    },
    console,
    get processedHistoryUpdates() {
      return processedHistoryUpdates;
    },
    get persistedGraphSnapshot() {
      return persistedGraphSnapshot;
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
    runtime.graph.historyState.lastBatchStatus.persistence.outcome,
    "queued",
  );
  assert.equal(
    runtime.graph.historyState.lastBatchStatus.historyAdvanceAllowed,
    false,
  );
  assert.equal(
    runtime.persistedGraphSnapshot?.historyState?.lastProcessedAssistantFloor,
    5,
  );
  assert.equal(
    runtime.persistedGraphSnapshot?.batchJournal?.length,
    1,
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
  assert.equal(runtime.processedHistoryUpdates, 1);
  assert.equal(
    runtime.graph.historyState.lastBatchStatus.persistence.outcome,
    "saved",
  );
  assert.equal(
    runtime.graph.historyState.lastBatchStatus.historyAdvanceAllowed,
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
  runtime.extractMemories = async () => ({
    success: false,
    error: "提取 LLM 未返回有效操作",
    processedRange: [4, 4],
  });
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
  assert.equal(runtime.graph.historyState.lastBatchStatus.persistence, null);
}

console.log("extraction-persistence-gating tests passed");
