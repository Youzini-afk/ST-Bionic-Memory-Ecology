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
  };
  let processedHistoryUpdates = 0;

  return {
    graph,
    processedHistoryUpdates,
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
      return persistResult;
    },
    finalizeBatchStatus,
    shouldAdvanceProcessedHistory(batchStatus) {
      return batchStatus.historyAdvanceAllowed === true;
    },
    updateProcessedHistorySnapshot() {
      processedHistoryUpdates += 1;
    },
    appendBatchJournal() {},
    createBatchJournalEntry() {
      return { id: "journal-1" };
    },
    computePostProcessArtifacts() {
      return [];
    },
    getGraphPersistenceState() {
      return { chatId: "chat-test" };
    },
    console,
    get processedHistoryUpdates() {
      return processedHistoryUpdates;
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
}

console.log("extraction-persistence-gating tests passed");
