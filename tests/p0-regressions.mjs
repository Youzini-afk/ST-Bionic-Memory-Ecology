import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const originalRequire = globalThis.require;
globalThis.require = require;

const { createEmptyGraph, createNode, addNode, createEdge, addEdge } =
  await import("../graph.js");
const { compressType } = await import("../compressor.js");
const { syncGraphVectorIndex } = await import("../vector-index.js");
const { extractMemories } = await import("../extractor.js");
const { consolidateMemories } = await import("../consolidator.js");
const {
  createBatchJournalEntry,
  buildReverseJournalRecoveryPlan,
  normalizeGraphRuntimeState,
  rollbackBatch,
} = await import("../runtime-state.js");
const llm = await import("../llm.js");
const embedding = await import("../embedding.js");

if (originalRequire === undefined) {
  delete globalThis.require;
} else {
  globalThis.require = originalRequire;
}

const schema = [
  {
    id: "event",
    label: "事件",
    columns: [
      { name: "title" },
      { name: "summary" },
      { name: "participants" },
      { name: "status" },
    ],
    compression: {
      mode: "hierarchical",
      threshold: 2,
    },
  },
  {
    id: "character",
    label: "角色",
    columns: [{ name: "name" }, { name: "state" }],
    latestOnly: true,
  },
];

function createBatchStageHarness() {
  const indexPath = path.resolve("./index.js");
  return fs.readFile(indexPath, "utf8").then((source) => {
    const marker = "function isAssistantChatMessage(message) {";
    const start = source.indexOf("const BATCH_STAGE_ORDER =");
    const end = source.indexOf(marker);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error("无法从 index.js 提取批次状态机定义");
    }
    const snippet = source.slice(start, end);
    const context = {
      console,
      result: null,
      extractionCount: 0,
      currentGraph: null,
      consolidateMemories: async () => {},
      generateSynopsis: async () => {},
      generateReflection: async () => {},
      sleepCycle: () => {},
      compressAll: async () => ({ created: 0, archived: 0 }),
      syncVectorState: async () => ({
        insertedHashes: [],
        stats: { pending: 0 },
      }),
      getSchema: () => schema,
      getEmbeddingConfig: () => null,
      getVectorIndexStats: () => ({ pending: 0 }),
      updateLastExtractedItems: () => {},
      ensureCurrentGraphRuntimeState: () => {},
      throwIfAborted: () => {},
      isAbortError: () => false,
      createAbortError: (message) => new Error(message),
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { createBatchStatusSkeleton, finalizeBatchStatus, handleExtractionSuccess, setBatchStageOutcome, shouldAdvanceProcessedHistory };`,
      context,
      { filename: indexPath },
    );
    return context;
  });
}

function createGenerationRecallHarness() {
  const indexPath = path.resolve("./index.js");
  return fs.readFile(indexPath, "utf8").then((source) => {
    const start = source.indexOf("const RECALL_INPUT_RECORD_TTL_MS = 60000;");
    const end = source.indexOf("function onMessageReceived() {");
    if (start < 0 || end < 0 || end <= start) {
      throw new Error("无法从 index.js 提取生成召回事务定义");
    }
    const snippet = source.slice(start, end);
    const context = {
      console,
      Date,
      Map,
      setTimeout,
      clearTimeout,
      result: null,
      currentGraph: {},
      isRecalling: false,
      getCurrentChatId: () => "chat-main",
      normalizeRecallInputText: (text = "") => String(text || "").trim(),
      pendingRecallSendIntent: { text: "", hash: "", at: 0 },
      lastRecallSentUserMessage: { text: "", hash: "", at: 0 },
      getLatestUserChatMessage: (chat = []) =>
        [...chat].reverse().find((message) => message?.is_user) || null,
      getLastNonSystemChatMessage: (chat = []) =>
        [...chat].reverse().find((message) => !message?.is_system) || null,
      getSendTextareaValue: () => "",
      getRecallUserMessageSourceLabel: (source = "") => source,
      buildRecallRecentMessages: (
        chat = [],
        _limit,
        syntheticUserMessage = "",
      ) =>
        syntheticUserMessage
          ? [...chat, { is_user: true, mes: syntheticUserMessage }]
          : [...chat],
      getContext: () => ({
        chat: context.chat,
      }),
      chat: [],
      runRecallCalls: [],
      runRecall: async (options = {}) => {
        context.runRecallCalls.push({ ...options });
        return true;
      },
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { hashRecallInput, buildPreGenerationRecallKey, buildGenerationAfterCommandsRecallInput, cleanupGenerationRecallTransactions, buildGenerationRecallTransactionId, beginGenerationRecallTransaction, markGenerationRecallTransactionHookState, shouldRunRecallForTransaction, createGenerationRecallContext, onGenerationAfterCommands, onBeforeCombinePrompts, generationRecallTransactions };`,
      context,
      { filename: indexPath },
    );
    return context;
  });
}

function makeEvent(seq, title) {
  return createNode({
    type: "event",
    seq,
    fields: {
      title,
      summary: `${title} 摘要`,
      participants: "Alice",
      status: "active",
    },
  });
}

async function testCompressorMigratesEdgesToCompressedNode() {
  const graph = createEmptyGraph();
  const external = createNode({
    type: "character",
    seq: 0,
    fields: { name: "Alice", state: "awake" },
  });
  const first = makeEvent(1, "事件1");
  const second = makeEvent(2, "事件2");
  addNode(graph, external);
  addNode(graph, first);
  addNode(graph, second);
  addEdge(
    graph,
    createEdge({
      fromId: first.id,
      toId: external.id,
      relation: "mentions",
      strength: 0.7,
    }),
  );

  const originalSummarize = llm.callLLMForJSON;
  llm.callLLMForJSON = async () => ({
    fields: {
      title: "压缩事件",
      summary: "合并摘要",
      participants: "Alice",
      status: "done",
    },
  });

  try {
    const result = await compressType({
      graph,
      typeDef: schema[0],
      embeddingConfig: null,
      force: true,
      settings: {},
    });
    assert.equal(result.created, 1);

    const compressed = graph.nodes.find(
      (node) => node.level === 1 && !node.archived,
    );
    assert.ok(compressed);
    const migrated = graph.edges.find(
      (edge) =>
        edge.fromId === compressed.id &&
        edge.toId === external.id &&
        edge.relation === "mentions" &&
        !edge.invalidAt &&
        !edge.expiredAt,
    );
    assert.ok(migrated);
  } finally {
    llm.callLLMForJSON = originalSummarize;
  }
}

async function testVectorIndexKeepsDirtyOnDirectPartialEmbeddingFailure() {
  const graph = createEmptyGraph();
  const first = makeEvent(1, "向量事件1");
  const second = makeEvent(2, "向量事件2");
  addNode(graph, first);
  addNode(graph, second);
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.lastWarning = "旧 warning";

  const originalEmbedBatch = embedding.embedBatch;
  embedding.embedBatch = async () => [[0.1, 0.2], null];

  try {
    const result = await syncGraphVectorIndex(
      graph,
      {
        mode: "direct",
        source: "direct",
        apiUrl: "https://example.com/v1",
        model: "text-embedding-3-small",
      },
      {},
    );

    assert.equal(result.insertedHashes.length, 1);
    assert.equal(graph.vectorIndexState.dirty, true);
    assert.equal(typeof result.stats.pending, "number");
    assert.equal(graph.vectorIndexState.lastStats, result.stats);
    assert.match(
      graph.vectorIndexState.lastWarning,
      /部分节点 embedding 生成失败/,
    );
    assert.equal(
      graph.vectorIndexState.lastWarning,
      "部分节点 embedding 生成失败，向量索引仍待修复",
    );
    assert.equal(second.embedding, null);
  } finally {
    embedding.embedBatch = originalEmbedBatch;
  }
}

async function testConsolidatorMergeFallbackKeepsNodeWhenTargetMissing() {
  const graph = createEmptyGraph();
  const target = createNode({
    type: "event",
    seq: 3,
    fields: {
      title: "旧记忆",
      summary: "旧摘要",
      participants: "Alice",
      status: "active",
    },
  });
  const incoming = createNode({
    type: "event",
    seq: 8,
    fields: {
      title: "新记忆",
      summary: "新摘要",
      participants: "Alice",
      status: "updated",
    },
  });
  target.embedding = [0.9, 0.1];
  addNode(graph, target);
  addNode(graph, incoming);

  const originalFindSimilar = embedding.searchSimilar;
  const originalEmbedBatch = embedding.embedBatch;
  const originalCall = llm.callLLMForJSON;
  embedding.embedBatch = async () => [[0.2, 0.3]];
  embedding.searchSimilar = async () => [{ nodeId: target.id, score: 0.99 }];
  llm.callLLMForJSON = async () => ({
    results: [
      {
        node_id: incoming.id,
        action: "merge",
        merge_target_id: "missing-node-id",
        reason: "故意触发无效 merge target 回退",
      },
    ],
  });

  try {
    const stats = await consolidateMemories({
      graph,
      newNodeIds: [incoming.id],
      embeddingConfig: {
        mode: "direct",
        source: "direct",
        apiUrl: "https://example.com/v1",
        model: "text-embedding-3-small",
      },
      settings: {},
    });

    assert.equal(stats.merged, 0);
    assert.equal(stats.kept, 1);
    assert.equal(incoming.archived, false);
    assert.deepEqual(target.embedding, [0.9, 0.1]);
  } finally {
    embedding.searchSimilar = originalFindSimilar;
    embedding.embedBatch = originalEmbedBatch;
    llm.callLLMForJSON = originalCall;
  }
}

async function testExtractorFailsOnUnknownOperation() {
  const graph = createEmptyGraph();
  const originalCall = llm.callLLMForJSON;
  llm.callLLMForJSON = async () => ({
    operations: [{ action: "nonsense", foo: 1 }],
  });

  try {
    const result = await extractMemories({
      graph,
      messages: [{ seq: 4, role: "assistant", content: "测试非法操作" }],
      startSeq: 4,
      endSeq: 4,
      schema,
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(result.success, false);
    assert.match(result.error, /未知操作类型/);
    assert.equal(graph.lastProcessedSeq, -1);
  } finally {
    llm.callLLMForJSON = originalCall;
  }
}

async function testConsolidatorMergeUpdatesSeqRange() {
  const graph = createEmptyGraph();
  const target = createNode({
    type: "event",
    seq: 3,
    seqRange: [3, 4],
    fields: {
      title: "旧记忆",
      summary: "旧摘要",
      participants: "Alice",
      status: "active",
    },
  });
  const incoming = createNode({
    type: "event",
    seq: 8,
    seqRange: [8, 9],
    fields: {
      title: "新记忆",
      summary: "新摘要",
      participants: "Alice",
      status: "updated",
    },
  });
  addNode(graph, target);
  addNode(graph, incoming);

  const originalFindSimilar = embedding.searchSimilar;
  const originalCall = llm.callLLMForJSON;
  embedding.searchSimilar = async () => [{ nodeId: target.id, score: 0.99 }];
  llm.callLLMForJSON = async () => ({
    results: [
      {
        node_id: incoming.id,
        action: "merge",
        merge_target_id: target.id,
        merged_fields: { summary: "合并后摘要" },
      },
    ],
  });

  try {
    const stats = await consolidateMemories({
      graph,
      newNodeIds: [incoming.id],
      embeddingConfig: null,
      settings: {},
    });

    assert.equal(stats.merged, 1);
    assert.deepEqual(target.seqRange, [3, 9]);
    assert.equal(target.seq, 8);
    assert.equal(target.fields.summary, "合并后摘要");
    assert.equal(target.embedding, null);
    assert.equal(incoming.archived, true);
  } finally {
    embedding.searchSimilar = originalFindSimilar;
    llm.callLLMForJSON = originalCall;
  }
}

async function testBatchJournalVectorDeltaCapturesRecoveryFields() {
  const before = normalizeGraphRuntimeState(createEmptyGraph(), "chat-a");
  const after = normalizeGraphRuntimeState(createEmptyGraph(), "chat-a");
  const beforeNode = createNode({
    id: "node-before",
    type: "event",
    seq: 1,
    fields: { title: "旧", summary: "旧", participants: "A", status: "old" },
  });
  const afterNode = createNode({
    id: "node-before",
    type: "event",
    seq: 1,
    fields: { title: "新", summary: "新", participants: "A", status: "new" },
  });
  addNode(before, beforeNode);
  addNode(after, afterNode);
  before.vectorIndexState.hashToNodeId = { hash_old: "node-before" };
  before.vectorIndexState.nodeToHash = { "node-before": "hash_old" };
  after.vectorIndexState.hashToNodeId = {
    hash_new: "node-before",
    hash_inserted: "node-extra",
  };
  after.vectorIndexState.nodeToHash = {
    "node-before": "hash_new",
    "node-extra": "hash_inserted",
  };
  after.vectorIndexState.replayRequiredNodeIds = ["node-before", "node-extra"];

  const journal = createBatchJournalEntry(before, after, {
    processedRange: [4, 6],
    vectorHashesInserted: ["hash_inserted"],
  });

  assert.deepEqual(journal.vectorDelta.insertedHashes.sort(), [
    "hash_inserted",
    "hash_new",
  ]);
  assert.deepEqual(journal.vectorDelta.removedHashes, ["hash_old"]);
  assert.deepEqual(journal.vectorDelta.touchedNodeIds.sort(), [
    "node-before",
    "node-extra",
  ]);
  assert.deepEqual(journal.vectorDelta.replayRequiredNodeIds.sort(), [
    "node-before",
    "node-extra",
  ]);
  assert.deepEqual(journal.vectorDelta.backendDeleteHashes, ["hash_old"]);
  assert.deepEqual(journal.vectorDelta.replacedMappings, [
    { nodeId: "node-before", previousHash: "hash_old", nextHash: "hash_new" },
    { nodeId: "node-extra", previousHash: "", nextHash: "hash_inserted" },
  ]);
}

async function testReverseJournalRecoveryPlanLegacyFallback() {
  const recoveryPlan = buildReverseJournalRecoveryPlan(
    [
      {
        processedRange: [5, 7],
        vectorDelta: {
          insertedHashes: ["hash_1"],
        },
      },
    ],
    5,
  );

  assert.equal(recoveryPlan.legacyGapFallback, true);
  assert.equal(recoveryPlan.dirtyReason, "legacy-gap");
  assert.equal(recoveryPlan.pendingRepairFromFloor, 5);
  assert.deepEqual(recoveryPlan.backendDeleteHashes, ["hash_1"]);
  assert.deepEqual(recoveryPlan.replayRequiredNodeIds, []);
}

async function testReverseJournalRecoveryPlanAggregatesDeletesAndReplay() {
  const recoveryPlan = buildReverseJournalRecoveryPlan(
    [
      {
        processedRange: [8, 9],
        vectorDelta: {
          insertedHashes: ["hash_new"],
          removedHashes: ["hash_removed"],
          replacedMappings: [
            {
              nodeId: "node-1",
              previousHash: "hash_old",
              nextHash: "hash_new",
            },
          ],
          touchedNodeIds: ["node-1"],
          replayRequiredNodeIds: ["node-2"],
          backendDeleteHashes: ["hash_backend"],
        },
      },
      {
        processedRange: [4, 6],
        vectorDelta: {
          insertedHashes: ["hash_other"],
          removedHashes: [],
          replacedMappings: [],
          touchedNodeIds: ["node-3"],
          replayRequiredNodeIds: ["node-3"],
          backendDeleteHashes: [],
        },
      },
    ],
    6,
  );

  assert.equal(recoveryPlan.legacyGapFallback, false);
  assert.equal(recoveryPlan.dirtyReason, "history-recovery-replay");
  assert.equal(recoveryPlan.pendingRepairFromFloor, 4);
  assert.deepEqual(recoveryPlan.backendDeleteHashes.sort(), [
    "hash_backend",
    "hash_new",
    "hash_old",
    "hash_other",
    "hash_removed",
  ]);
  assert.deepEqual(recoveryPlan.replayRequiredNodeIds.sort(), [
    "node-1",
    "node-2",
    "node-3",
  ]);
  assert.deepEqual(recoveryPlan.touchedNodeIds.sort(), ["node-1", "node-3"]);
}

async function testReverseJournalRollbackStateFormsReplayClosure() {
  const before = normalizeGraphRuntimeState(createEmptyGraph(), "chat-replay");
  const after = normalizeGraphRuntimeState(createEmptyGraph(), "chat-replay");
  const stableNode = createNode({
    id: "node-stable",
    type: "event",
    seq: 1,
    fields: {
      title: "稳定节点",
      summary: "稳定摘要",
      participants: "Alice",
      status: "stable",
    },
  });
  const touchedBefore = createNode({
    id: "node-touched",
    type: "event",
    seq: 2,
    fields: {
      title: "回滚前节点",
      summary: "旧摘要",
      participants: "Bob",
      status: "old",
    },
  });
  const touchedAfter = createNode({
    id: "node-touched",
    type: "event",
    seq: 5,
    fields: {
      title: "回滚后节点",
      summary: "新摘要",
      participants: "Bob",
      status: "updated",
    },
  });
  const appendedNode = createNode({
    id: "node-appended",
    type: "event",
    seq: 6,
    fields: {
      title: "新增节点",
      summary: "新增摘要",
      participants: "Cara",
      status: "new",
    },
  });
  addNode(before, stableNode);
  addNode(before, touchedBefore);
  addNode(after, stableNode);
  addNode(after, touchedAfter);
  addNode(after, appendedNode);

  before.historyState.lastProcessedAssistantFloor = 3;
  before.historyState.processedMessageHashes = {
    0: "h0",
    1: "h1",
    2: "h2",
    3: "h3",
  };
  before.historyState.extractionCount = 1;
  before.vectorIndexState.hashToNodeId = {
    hash_stable: stableNode.id,
    hash_old: touchedBefore.id,
  };
  before.vectorIndexState.nodeToHash = {
    [stableNode.id]: "hash_stable",
    [touchedBefore.id]: "hash_old",
  };

  after.historyState.lastProcessedAssistantFloor = 6;
  after.historyState.processedMessageHashes = {
    0: "h0",
    1: "h1",
    2: "h2",
    3: "h3",
    4: "h4",
    5: "h5",
    6: "h6",
  };
  after.historyState.extractionCount = 2;
  after.vectorIndexState.hashToNodeId = {
    hash_stable: stableNode.id,
    hash_new: touchedAfter.id,
    hash_added: appendedNode.id,
  };
  after.vectorIndexState.nodeToHash = {
    [stableNode.id]: "hash_stable",
    [touchedAfter.id]: "hash_new",
    [appendedNode.id]: "hash_added",
  };
  after.vectorIndexState.replayRequiredNodeIds = [appendedNode.id];

  const journal = createBatchJournalEntry(before, after, {
    processedRange: [4, 6],
    extractionCountBefore: before.historyState.extractionCount,
  });

  const runtimeGraph = normalizeGraphRuntimeState(
    JSON.parse(JSON.stringify(after)),
    "chat-replay",
  );
  rollbackBatch(runtimeGraph, journal);

  assert.deepEqual(runtimeGraph.nodes.map((node) => node.id).sort(), [
    stableNode.id,
    touchedBefore.id,
  ]);
  assert.deepEqual(runtimeGraph.vectorIndexState.hashToNodeId, {
    hash_stable: stableNode.id,
    hash_old: touchedBefore.id,
  });
  assert.deepEqual(runtimeGraph.vectorIndexState.nodeToHash, {
    [stableNode.id]: "hash_stable",
    [touchedBefore.id]: "hash_old",
  });
  assert.equal(runtimeGraph.historyState.lastProcessedAssistantFloor, 3);

  const recoveryPlan = buildReverseJournalRecoveryPlan([journal], 4);
  runtimeGraph.vectorIndexState.replayRequiredNodeIds = [stableNode.id];
  runtimeGraph.vectorIndexState.dirty = false;
  runtimeGraph.vectorIndexState.dirtyReason = "";
  runtimeGraph.vectorIndexState.pendingRepairFromFloor = null;

  const replayRequiredNodeIds = new Set(
    runtimeGraph.vectorIndexState.replayRequiredNodeIds,
  );
  for (const nodeId of recoveryPlan.replayRequiredNodeIds) {
    replayRequiredNodeIds.add(nodeId);
  }
  runtimeGraph.vectorIndexState.replayRequiredNodeIds = [
    ...replayRequiredNodeIds,
  ];
  runtimeGraph.vectorIndexState.dirty = true;
  runtimeGraph.vectorIndexState.dirtyReason =
    recoveryPlan.dirtyReason ||
    runtimeGraph.vectorIndexState.dirtyReason ||
    "history-recovery-replay";
  runtimeGraph.vectorIndexState.pendingRepairFromFloor =
    recoveryPlan.pendingRepairFromFloor;
  runtimeGraph.vectorIndexState.lastWarning = recoveryPlan.legacyGapFallback
    ? "历史恢复检测到 legacy-gap，向量索引需按受影响后缀修复"
    : "历史恢复后需要修复受影响后缀的向量索引";

  assert.deepEqual(
    runtimeGraph.vectorIndexState.replayRequiredNodeIds.sort(),
    [appendedNode.id, stableNode.id, touchedBefore.id].sort(),
  );
  assert.equal(runtimeGraph.vectorIndexState.pendingRepairFromFloor, 4);
  assert.equal(
    runtimeGraph.vectorIndexState.dirtyReason,
    "history-recovery-replay",
  );
  assert.equal(
    runtimeGraph.vectorIndexState.lastWarning,
    "历史恢复后需要修复受影响后缀的向量索引",
  );
  assert.deepEqual(runtimeGraph.vectorIndexState.hashToNodeId, {
    hash_stable: stableNode.id,
    hash_old: touchedBefore.id,
  });
  assert.deepEqual(runtimeGraph.vectorIndexState.nodeToHash, {
    [stableNode.id]: "hash_stable",
    [touchedBefore.id]: "hash_old",
  });
}

async function testReverseJournalRecoveryPlanMixedLegacyAndCurrentRetainsRepairSet() {
  const recoveryPlan = buildReverseJournalRecoveryPlan(
    [
      {
        processedRange: [10, 12],
        vectorDelta: {
          insertedHashes: ["hash-current"],
          removedHashes: ["hash-removed"],
          replacedMappings: [
            {
              nodeId: "node-current",
              previousHash: "hash-prev",
              nextHash: "hash-current",
            },
          ],
          touchedNodeIds: ["node-current"],
          replayRequiredNodeIds: ["node-extra"],
          backendDeleteHashes: ["hash-backend"],
        },
      },
      {
        processedRange: [7, 9],
        vectorDelta: {
          insertedHashes: ["hash-legacy"],
        },
      },
    ],
    9,
  );

  assert.equal(recoveryPlan.legacyGapFallback, true);
  assert.equal(recoveryPlan.dirtyReason, "legacy-gap");
  assert.equal(recoveryPlan.pendingRepairFromFloor, 7);
  assert.deepEqual(recoveryPlan.replayRequiredNodeIds.sort(), [
    "node-current",
    "node-extra",
  ]);
  assert.deepEqual(recoveryPlan.touchedNodeIds, ["node-current"]);
  assert.deepEqual(recoveryPlan.backendDeleteHashes.sort(), [
    "hash-backend",
    "hash-current",
    "hash-legacy",
    "hash-prev",
    "hash-removed",
  ]);
}

async function testBatchStatusStructuralPartialRemainsRecoverable() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.compressAll = async () => {
    throw new Error("compression down");
  };
  harness.syncVectorState = async () => ({
    insertedHashes: ["hash-ok"],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [2, 4],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-1"] },
    4,
    {
      enableConsolidation: false,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(effects.batchStatus.stages.core.outcome, "success");
  assert.equal(effects.batchStatus.stages.structural.outcome, "partial");
  assert.equal(effects.batchStatus.stages.finalize.outcome, "success");
  assert.equal(effects.batchStatus.outcome, "partial");
  assert.equal(effects.batchStatus.completed, true);
  assert.equal(effects.batchStatus.consistency, "weak");
  assert.match(effects.batchStatus.warnings[0], /压缩阶段失败/);
}

async function testBatchStatusSemanticFailureDoesNotHideCoreSuccess() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.generateSynopsis = async () => {
    throw new Error("semantic down");
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 0 },
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [5, 5],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-2"] },
    5,
    {
      enableConsolidation: false,
      enableSynopsis: true,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(effects.batchStatus.stages.core.outcome, "success");
  assert.equal(effects.batchStatus.stages.semantic.outcome, "failed");
  assert.equal(effects.batchStatus.stages.finalize.outcome, "success");
  assert.equal(effects.batchStatus.outcome, "failed");
  assert.equal(effects.batchStatus.completed, true);
  assert.match(effects.batchStatus.errors[0], /概要生成失败/);
}

async function testBatchStatusFinalizeFailureIsNotCompleteSuccess() {
  const harness = await createBatchStageHarness();
  const { createBatchStatusSkeleton, handleExtractionSuccess } = harness.result;
  harness.currentGraph = {
    historyState: { extractionCount: 0 },
    vectorIndexState: {},
  };
  harness.ensureCurrentGraphRuntimeState = () => {
    harness.currentGraph.historyState ||= {};
    harness.currentGraph.vectorIndexState ||= {};
  };
  harness.syncVectorState = async () => ({
    insertedHashes: [],
    stats: { pending: 1 },
    error: "vector finalize down",
  });

  const batchStatus = createBatchStatusSkeleton({
    processedRange: [6, 7],
    extractionCountBefore: 0,
  });
  const effects = await handleExtractionSuccess(
    { newNodeIds: ["node-3"] },
    7,
    {
      enableConsolidation: false,
      enableSynopsis: false,
      enableReflection: false,
      enableSleepCycle: false,
      synopsisEveryN: 1,
      reflectEveryN: 1,
      sleepEveryN: 1,
    },
    undefined,
    batchStatus,
  );

  assert.equal(effects.batchStatus.stages.core.outcome, "success");
  assert.equal(effects.batchStatus.stages.finalize.outcome, "failed");
  assert.equal(effects.batchStatus.outcome, "failed");
  assert.equal(effects.batchStatus.completed, false);
  assert.equal(effects.batchStatus.consistency, "weak");
  assert.equal(effects.vectorError, "vector finalize down");
}

async function testProcessedHistoryAdvanceRequiresCompleteStrongSuccess() {
  const harness = await createBatchStageHarness();
  const {
    createBatchStatusSkeleton,
    finalizeBatchStatus,
    setBatchStageOutcome,
    shouldAdvanceProcessedHistory,
  } = harness.result;

  const structuralPartial = createBatchStatusSkeleton({
    processedRange: [2, 4],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(structuralPartial, "core", "success");
  setBatchStageOutcome(
    structuralPartial,
    "structural",
    "partial",
    "compression down",
  );
  setBatchStageOutcome(structuralPartial, "finalize", "success");
  finalizeBatchStatus(structuralPartial);
  assert.equal(structuralPartial.completed, true);
  assert.equal(structuralPartial.outcome, "partial");
  assert.equal(structuralPartial.consistency, "weak");
  assert.equal(shouldAdvanceProcessedHistory(structuralPartial), false);

  const semanticFailed = createBatchStatusSkeleton({
    processedRange: [5, 5],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(semanticFailed, "core", "success");
  setBatchStageOutcome(semanticFailed, "semantic", "failed", "semantic down");
  setBatchStageOutcome(semanticFailed, "finalize", "success");
  finalizeBatchStatus(semanticFailed);
  assert.equal(semanticFailed.completed, true);
  assert.equal(semanticFailed.outcome, "failed");
  assert.equal(semanticFailed.consistency, "strong");
  assert.equal(shouldAdvanceProcessedHistory(semanticFailed), false);

  const fullSuccess = createBatchStatusSkeleton({
    processedRange: [8, 9],
    extractionCountBefore: 0,
  });
  setBatchStageOutcome(fullSuccess, "core", "success");
  setBatchStageOutcome(fullSuccess, "structural", "success");
  setBatchStageOutcome(fullSuccess, "semantic", "success");
  setBatchStageOutcome(fullSuccess, "finalize", "success");
  finalizeBatchStatus(fullSuccess);
  assert.equal(fullSuccess.completed, true);
  assert.equal(fullSuccess.outcome, "success");
  assert.equal(fullSuccess.consistency, "strong");
  assert.equal(shouldAdvanceProcessedHistory(fullSuccess), true);
}

async function testGenerationRecallTransactionDedupesDoubleHookBySameKey() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同一轮输入" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].hookName, "GENERATION_AFTER_COMMANDS");
}

async function testGenerationRecallBeforeCombineRunsStandalone() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "仅 before combine" }];

  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.runRecallCalls[0].hookName,
    "GENERATE_BEFORE_COMBINE_PROMPTS",
  );
}

async function testGenerationRecallDifferentKeyCanRunAgain() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "第一条" }];
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  harness.chat = [{ is_user: true, mes: "第二条" }];
  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 2);
  assert.notEqual(
    harness.runRecallCalls[0].recallKey,
    harness.runRecallCalls[1].recallKey,
  );
}

await testCompressorMigratesEdgesToCompressedNode();
await testVectorIndexKeepsDirtyOnDirectPartialEmbeddingFailure();
await testExtractorFailsOnUnknownOperation();
await testConsolidatorMergeUpdatesSeqRange();
await testConsolidatorMergeFallbackKeepsNodeWhenTargetMissing();
await testBatchJournalVectorDeltaCapturesRecoveryFields();
await testReverseJournalRecoveryPlanLegacyFallback();
await testReverseJournalRecoveryPlanAggregatesDeletesAndReplay();
await testReverseJournalRollbackStateFormsReplayClosure();
await testReverseJournalRecoveryPlanMixedLegacyAndCurrentRetainsRepairSet();
await testBatchStatusStructuralPartialRemainsRecoverable();
await testBatchStatusSemanticFailureDoesNotHideCoreSuccess();
await testBatchStatusFinalizeFailureIsNotCompleteSuccess();
await testProcessedHistoryAdvanceRequiresCompleteStrongSuccess();
await testGenerationRecallTransactionDedupesDoubleHookBySameKey();
await testGenerationRecallBeforeCombineRunsStandalone();
await testGenerationRecallDifferentKeyCanRunAgain();

console.log("p0-regressions tests passed");
