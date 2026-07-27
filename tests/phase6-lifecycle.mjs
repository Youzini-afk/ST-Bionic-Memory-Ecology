import assert from "node:assert/strict";

import {
  executeExtractionBatchController,
  recordGraphMutationController,
} from "../maintenance/extraction-controller.js";
import {
  buildRecallHistoryFingerprint,
  buildPersistedRecallRecord,
  readPersistedRecallFromUserMessage,
  writePersistedRecallToUserMessage,
} from "../retrieval/recall-persistence.js";
import { createRerollRecallInput } from "../runtime/reroll-recall-input.js";
import {
  createStructuredPlotRecord,
  writeStructuredPlotRecordToMessage,
} from "../ena-planner/planner-plot-history.js";
import {
  createBatchStatusSkeleton,
  finalizeBatchStatus,
  setBatchStageOutcome,
} from "../ui/ui-status.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

function createJournalEntry(_before, _after, meta = {}) {
  return {
    id: "batch-phase6",
    processedRange: meta.processedRange || [-1, -1],
    processedDialogueRange: meta.processedDialogueRange || [-1, -1],
    sourceChatIndexRange: meta.sourceChatIndexRange || [-1, -1],
    postProcessArtifacts: meta.postProcessArtifacts || [],
    vectorDelta: {
      insertedHashes: [...(meta.vectorHashesInserted || [])],
      removedHashes: [],
      replacedMappings: [],
      touchedNodeIds: [],
      replayRequiredNodeIds: [],
      backendDeleteHashes: [],
    },
  };
}

async function testStrictExtractionSyncsVectorsOnlyAfterPrimaryAcceptance() {
  const events = [];
  const chat = [
    { is_user: true, mes: "user" },
    { is_user: false, mes: "assistant" },
  ];
  let extractionCount = 0;
  let graph = {
    nodes: [],
    edges: [],
    batchJournal: [],
    historyState: { chatId: "chat-phase6", extractionCount: 0 },
    vectorIndexState: {},
  };
  const runtime = {
    appendBatchJournal(target, entry) {
      target.batchJournal.push(entry);
    },
    applyProcessedHistorySnapshotToGraph(target, _chat, endFloor) {
      target.historyState.lastProcessedAssistantFloor = endFloor;
      target.lastProcessedSeq = endFloor;
    },
    buildChatHistoryFingerprint: (value) => JSON.stringify(value),
    buildExtractionMessages: () => [],
    cloneGraphSnapshot: clone,
    computePostProcessArtifacts: (_before, _after, tags) => tags,
    console,
    createBatchJournalEntry: createJournalEntry,
    createBatchStatusSkeleton,
    ensureCurrentGraphRuntimeState() {
      graph.historyState ||= {};
      graph.vectorIndexState ||= {};
      graph.batchJournal ||= [];
    },
    extractMemories: async () => ({
      success: true,
      newNodeIds: ["node-phase6"],
      processedRange: [1, 1],
    }),
    finalizeBatchStatus,
    getContext: () => ({ chatId: "chat-phase6", chat }),
    getCurrentChatId: () => "chat-phase6",
    getCurrentGraph: () => graph,
    getEmbeddingConfig: () => ({ mode: "direct" }),
    getExtractionCount: () => extractionCount,
    getLastProcessedAssistantFloor: () => -1,
    getSettings: () => ({}),
    getSchema: () => [],
    getVectorIndexStats: (target) => target.vectorIndexState.lastStats || {},
    handleExtractionSuccess: async (
      _result,
      _endIdx,
      _settings,
      _signal,
      status,
      _postProcessContext,
      taskContext,
    ) => {
      taskContext.graph.vectorIndexState.dirty = true;
      taskContext.graph.vectorIndexState.dirtyReason =
        "vector-sync-awaiting-primary-commit";
      taskContext.graph.historyState.extractionCount = 1;
      setBatchStageOutcome(status, "finalize", "success");
      return {
        postProcessArtifacts: [],
        vectorHashesInserted: [],
        vectorStats: {},
        vectorError: "",
        batchStatus: finalizeBatchStatus(status, 1),
        committedVectorSync: {
          enabled: true,
          range: { start: 1, end: 1 },
        },
      };
    },
    isAbortError: (error) => error?.name === "AbortError",
    persistExtractionBatchResult: async (options) => {
      events.push("primary-persist");
      assert.equal(options.graphSnapshot.vectorIndexState.dirty, true);
      return {
        accepted: true,
        revision: 1,
        storageTier: "indexeddb",
        saveMode: "full",
        outcome: "accepted",
      };
    },
    saveGraphToChat: async () => {
      events.push("vector-state-persist");
      return { accepted: true, revision: 2, outcome: "accepted" };
    },
    setBatchStageOutcome,
    setCurrentGraph(nextGraph) {
      graph = nextGraph;
    },
    setExtractionCount(value) {
      extractionCount = value;
    },
    shouldAdvanceProcessedHistory: () => true,
    stampGraphPersistenceMeta(target, { revision }) {
      target.meta = { ...(target.meta || {}), revision };
    },
    syncVectorState: async ({ graph: target }) => {
      events.push("vector-sync");
      target.vectorIndexState.dirty = false;
      target.vectorIndexState.nodeToHash = { "node-phase6": "hash-phase6" };
      target.vectorIndexState.hashToNodeId = { "hash-phase6": "node-phase6" };
      return {
        insertedHashes: ["hash-phase6"],
        stats: { indexed: 1, pending: 0 },
      };
    },
    throwIfAborted: () => {},
    updateLastExtractedItems: () => {},
    EXTRACTION_VECTOR_SYNC_TIMEOUT_MS: 1000,
  };

  const result = await executeExtractionBatchController(runtime, {
    chat,
    startIdx: 1,
    endIdx: 1,
    settings: { maintenanceExecutionMode: "strict" },
  });

  assert.deepEqual(events, [
    "primary-persist",
    "vector-sync",
    "vector-state-persist",
  ]);
  assert.equal(result.success, true);
  assert.equal(result.effects.committedVectorSyncResult?.error, undefined);
  assert.deepEqual(
    graph.batchJournal[0].vectorDelta.insertedHashes,
    ["hash-phase6"],
  );
}

async function testManualMutationDoesNotSyncBeforePersistenceAcceptance() {
  const graph = {
    nodes: [{ id: "node-1" }],
    edges: [],
    batchJournal: [],
    historyState: { chatId: "chat-phase6" },
    vectorIndexState: {},
  };
  let vectorSyncCalls = 0;
  const runtime = {
      appendBatchJournal(target, entry) {
        target.batchJournal.push(entry);
      },
      cloneGraphSnapshot: clone,
      computePostProcessArtifacts: () => ["manual"],
      createBatchJournalEntry: createJournalEntry,
      ensureCurrentGraphRuntimeState: () => {},
      getCurrentChatId: () => "chat-phase6",
      getCurrentGraph: () => graph,
      getEmbeddingConfig: () => ({ mode: "backend" }),
      getExtractionCount: () => 0,
      getLastProcessedAssistantFloor: () => 1,
      isBackendVectorConfig: () => true,
      normalizeChatIdCandidate: (value) => String(value || "").trim(),
      saveGraphToChat: async () => ({
        accepted: false,
        reason: "primary-rejected",
      }),
      syncVectorState: async () => {
        vectorSyncCalls += 1;
        return {};
      },
    };
  const result = await recordGraphMutationController(
    runtime,
    { beforeSnapshot: clone(graph) },
  );

  assert.equal(vectorSyncCalls, 0);
  assert.equal(result.skipped, true);
  assert.equal(graph.vectorIndexState.dirty, true);

  let saveCalls = 0;
  runtime.saveGraphToChat = async () => {
    saveCalls += 1;
    return saveCalls === 1
      ? { accepted: true, revision: 1 }
      : { accepted: false, reason: "vector-state-rejected" };
  };
  runtime.syncVectorState = async ({ graph: target }) => {
    vectorSyncCalls += 1;
    target.vectorIndexState.dirty = false;
    return { insertedHashes: ["hash-1"] };
  };
  const followupRejected = await recordGraphMutationController(runtime, {
    beforeSnapshot: clone(graph),
  });

  assert.equal(saveCalls, 2);
  assert.equal(vectorSyncCalls, 1);
  assert.equal(followupRejected.vectorPersistence.accepted, false);
  assert.equal(graph.vectorIndexState.dirty, true);
  assert.equal(
    graph.vectorIndexState.dirtyReason,
    "vector-sync-state-persist-pending",
  );
}

async function testLateRecallFinalizationCannotCrossChats() {
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.chat = [{ is_user: true, mes: "chat A user" }];
  harness.enterConversation("chat-b");

  const resolution = harness.result.applyFinalRecallInjectionForGeneration({
    generationType: "normal",
    freshRecallResult: {
      chatId: "chat-main",
      status: "completed",
      didRecall: true,
      injectionText: "late memory from chat A",
    },
    transaction: {
      chatId: "chat-main",
      frozenRecallOptions: { generationType: "normal" },
    },
  });

  assert.equal(resolution.reason, "recall-context-changed");
  assert.equal(resolution.stale, true);
  assert.equal(harness.moduleInjectionCalls.length, 0);
  assert.equal(harness.metadataSaveCalls, 0);
  assert.equal(harness.chat[0].extra, undefined);
}

async function testPlannerHandoffPersistsOnlyForMatchedGenerationAndChat() {
  const chat = [{ is_user: true, mes: "原始输入" }];
  let saveCalls = 0;
  const runtime = createRerollRecallInput({
    buildPersistedRecallRecord,
    buildRecallHistoryFingerprint,
    estimateTokens: () => 7,
    formatInjection: (result) => result.injectionText || "",
    getActiveGenerationId: () => "generation-1",
    getContext: () => ({ chatId: "chat-ena", chat }),
    getCurrentChatId: () => "chat-ena",
    getSchema: () => [],
    hashRecallInput: (value) => String(value || "").length,
    normalizeChatIdCandidate: (value) => String(value || "").trim(),
    normalizeRecallInputText: (value) => String(value || "").trim(),
    readPersistedRecallFromUserMessage,
    triggerChatMetadataSave: () => {
      saveCalls += 1;
    },
    writePersistedRecallToUserMessage,
    writeStructuredPlotRecordToMessage,
  });
  const handoff = runtime.preparePlannerTurnHandoff({
    chatId: "chat-ena",
    rawUserInput: "原始输入",
    plannerAugmentedMessage: "规划增强输入",
    plannerRecall: {
      memoryBlock: "规划阶段召回",
      result: { selectedNodeIds: ["node-ena"] },
    },
    plannerPlotRecord: createStructuredPlotRecord({
      rawUserInput: "原始输入",
      plannerAugmentedMessage: "规划增强输入",
      plotText: "<plot>下一步推进</plot>",
    }),
  });
  runtime.markPlannerTurnHandoffMatched("chat-ena", {
    handoffId: handoff.id,
    generationId: "generation-1",
  });

  assert.equal(runtime.persistPlannerTurnHandoffToUserMessage(0), true);
  assert.equal(chat[0].extra.bme_recall.injectionText, "规划阶段召回");
  assert.equal(chat[0].extra.st_bme_plot.plotText, "<plot>下一步推进</plot>");
  assert.equal(saveCalls, 1);
  assert.equal(runtime.persistPlannerTurnHandoffToUserMessage(0), false);
}

await testStrictExtractionSyncsVectorsOnlyAfterPrimaryAcceptance();
await testManualMutationDoesNotSyncBeforePersistenceAcceptance();
await testLateRecallFinalizationCannotCrossChats();
await testPlannerHandoffPersistsOnlyForMatchedGenerationAndChat();

console.log("phase6-lifecycle tests passed");
