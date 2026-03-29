import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  BATCH_STAGE_ORDER,
  BATCH_STAGE_SEVERITY,
  clampFloat,
  clampInt,
  createBatchStageStatus,
  createBatchStatusSkeleton,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  finalizeBatchStatus,
  formatRecallContextLine,
  getGenerationRecallHookStateFromResult,
  getRecallHookLabel,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  isTerminalGenerationRecallHookState,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  pushBatchStageArtifact,
  setBatchStageOutcome,
  shouldRunRecallForTransaction,
} from "../ui-status.js";
import {
  cloneRuntimeDebugValue,
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_PERSISTENCE_META_KEY,
  GRAPH_PERSISTENCE_SESSION_ID,
  MODULE_NAME,
  readGraphShadowSnapshot,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphShadowSnapshot,
} from "../graph-persistence.js";
import {
  buildExtractionMessages,
  clampRecoveryStartFloor,
  getAssistantTurns,
  getChatIndexForAssistantSeq,
  getChatIndexForPlayableSeq,
  getMinExtractableAssistantFloor,
  isAssistantChatMessage,
  pruneProcessedMessageHashesFromFloor,
  rollbackAffectedJournals,
} from "../chat-history.js";
import {
  onBeforeCombinePromptsController,
  onGenerationAfterCommandsController,
} from "../event-binding.js";
import { onRerollController } from "../extraction-controller.js";
import {
  buildPersistedRecallRecord,
  readPersistedRecallFromUserMessage,
  removePersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  resolveGenerationTargetUserMessageIndex,
  writePersistedRecallToUserMessage,
  bumpPersistedRecallGenerationCount,
  markPersistedRecallManualEdit,
} from "../recall-persistence.js";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__p0ExtensionSettings || {};",
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return { 'Content-Type': 'application/json' };",
  "}",
].join("\n");
const openAiShimSource = [
  "export const chat_completion_sources = { CUSTOM: 'custom', OPENAI: 'openai' };",
  "export async function sendOpenAIRequest(...args) {",
  "  if (typeof globalThis.__p0SendOpenAIRequest === 'function') {",
  "    return await globalThis.__p0SendOpenAIRequest(...args);",
  "  }",
  "  return { choices: [{ message: { content: '{}' } }] };",
  "}",
].join("\n");

const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;
const scriptShimUrl = `data:text/javascript,${encodeURIComponent(
  scriptShimSource,
)}`;
const openAiShimUrl = `data:text/javascript,${encodeURIComponent(
  openAiShimSource,
)}`;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../index.js");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: extensionsShimUrl,
      };
    }
    if (specifier === "../../../../script.js") {
      return {
        shortCircuit: true,
        url: scriptShimUrl,
      };
    }
    if (specifier === "../../../openai.js") {
      return {
        shortCircuit: true,
        url: openAiShimUrl,
      };
    }
    return nextResolve(specifier, context);
  },
});

const require = createRequire(import.meta.url);
const originalRequire = globalThis.require;
const originalP0ExtensionSettings = globalThis.__p0ExtensionSettings;
const originalP0SendOpenAIRequest = globalThis.__p0SendOpenAIRequest;
const originalStBmeTestOverrides = globalThis.__stBmeTestOverrides;
globalThis.__p0ExtensionSettings = {
  st_bme: {},
};
globalThis.__stBmeTestOverrides = {};
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
const { createDefaultTaskProfiles } = await import("../prompt-profiles.js");
const extensionsApi = await import("../../../../extensions.js");
const llm = await import("../llm.js");
const embedding = await import("../embedding.js");

if (originalRequire === undefined) {
  delete globalThis.require;
} else {
  globalThis.require = originalRequire;
}

if (originalP0ExtensionSettings === undefined) {
  delete globalThis.__p0ExtensionSettings;
} else {
  globalThis.__p0ExtensionSettings = originalP0ExtensionSettings;
}

if (originalP0SendOpenAIRequest === undefined) {
  delete globalThis.__p0SendOpenAIRequest;
} else {
  globalThis.__p0SendOpenAIRequest = originalP0SendOpenAIRequest;
}

if (originalStBmeTestOverrides === undefined) {
  delete globalThis.__stBmeTestOverrides;
} else {
  globalThis.__stBmeTestOverrides = originalStBmeTestOverrides;
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
  return fs.readFile(indexPath, "utf8").then((source) => {
    const marker = "function notifyHistoryDirty(dirtyFrom, reason) {";
    const start = source.indexOf("function shouldAdvanceProcessedHistory(");
    const end = source.indexOf(marker);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error("无法从 index.js 提取批次状态机定义");
    }
    const snippet = source.slice(start, end).replace(/^export\s+/gm, "");
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
      BATCH_STAGE_ORDER,
      BATCH_STAGE_SEVERITY,
      createBatchStageStatus,
      createBatchStatusSkeleton,
      setBatchStageOutcome,
      pushBatchStageArtifact,
      finalizeBatchStatus,
      createUiStatus,
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
  return fs.readFile(indexPath, "utf8").then((source) => {
    const start = source.indexOf("const RECALL_INPUT_RECORD_TTL_MS = 60000;");
    const end = source.indexOf("function onMessageReceived() {");
    if (start < 0 || end < 0 || end <= start) {
      throw new Error("无法从 index.js 提取生成召回事务定义");
    }
    const snippet = source.slice(start, end).replace(/^export\s+/gm, "");
    const context = {
      console,
      Date,
      Map,
      setTimeout,
      clearTimeout,
      document: {
        getElementById() {
          return null;
        },
      },
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
        chatId: "chat-main",
        chat: context.chat,
      }),
      chat: [],
      runRecallCalls: [],
      applyFinalCalls: [],
      createRecallInputRecord,
      createRecallRunResult,
      hashRecallInput,
      normalizeRecallInputText,
      isFreshRecallInputRecord,
      isTerminalGenerationRecallHookState,
      shouldRunRecallForTransaction,
      getGenerationRecallHookStateFromResult,
      createUiStatus,
      createGraphPersistenceState,
      getRecallHookLabel,
      getStageNoticeTitle,
      getStageNoticeDuration,
      normalizeStageNoticeLevel,
      MODULE_NAME,
      GRAPH_LOAD_STATES,
      GRAPH_METADATA_KEY,
      GRAPH_PERSISTENCE_META_KEY,
      onBeforeCombinePromptsController,
      onGenerationAfterCommandsController,
      readPersistedRecallFromUserMessage: () => null,
      resolveFinalRecallInjectionSource: ({ freshRecallResult = null } = {}) => ({
        source: freshRecallResult?.didRecall ? "fresh" : "none",
        injectionText: String(freshRecallResult?.injectionText || ""),
        record: null,
      }),
      bumpPersistedRecallGenerationCount: () => null,
      applyModuleInjectionPrompt: () => ({}),
      getSettings: () => ({}),
      triggerChatMetadataSave: () => "debounced",
      refreshPanelLiveState: () => {},
      resolveGenerationTargetUserMessageIndex: (chat = [], { generationType } = {}) => {
        const normalized = String(generationType || "normal");
        if (!Array.isArray(chat) || chat.length === 0) return null;
        if (normalized === "normal") return chat[chat.length - 1]?.is_user ? chat.length - 1 : null;
        for (let index = chat.length - 1; index >= 0; index--) if (chat[index]?.is_user) return index;
        return null;
      },
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { hashRecallInput, buildPreGenerationRecallKey, buildGenerationAfterCommandsRecallInput, cleanupGenerationRecallTransactions, buildGenerationRecallTransactionId, beginGenerationRecallTransaction, markGenerationRecallTransactionHookState, shouldRunRecallForTransaction, createGenerationRecallContext, onGenerationAfterCommands, onBeforeCombinePrompts, generationRecallTransactions };`,
      context,
      { filename: indexPath },
    );
    context.applyFinalRecallInjectionForGeneration = (payload = {}) => {
      context.applyFinalCalls.push({ ...payload });
      return {
        source: "fresh",
        targetUserMessageIndex: null,
      };
    };
    context.runRecall = async (options = {}) => {
      context.runRecallCalls.push({ ...options });
      return { status: "completed", didRecall: true, ok: true };
    };
    return context;
  });
}

function createRerollHarness() {
  return fs.readFile(indexPath, "utf8").then((source) => {
    const rollbackStart = source.indexOf("async function rollbackGraphForReroll(");
    const rollbackEnd = source.indexOf("async function recoverHistoryIfNeeded(");
    const rerollStart = source.indexOf("async function onReroll(");
    const rerollEnd = source.indexOf("async function onManualSleep()");
    if (
      rollbackStart < 0 ||
      rollbackEnd < 0 ||
      rerollStart < 0 ||
      rerollEnd < 0 ||
      rollbackEnd <= rollbackStart ||
      rerollEnd <= rerollStart
    ) {
      throw new Error("无法从 index.js 提取 reroll 定义");
    }
    const snippet = [source.slice(rollbackStart, rollbackEnd), source.slice(rerollStart, rerollEnd)]
      .join("\n")
      .replace(/^export\s+/gm, "");
    const context = {
      console,
      Date,
      result: null,
      currentGraph: null,
      isExtracting: false,
      extractionCount: 0,
      lastExtractedItems: ["stale-node"],
      lastExtractionStatus: { level: "idle" },
      chat: [],
      embeddingConfig: { mode: "backend" },
      rollbackAffectedJournalsCalls: [],
      deletedHashesCalls: [],
      prepareVectorStateCalls: [],
      recoveryPlans: [],
      saveGraphToChatCalls: 0,
      refreshPanelCalls: 0,
      clearInjectionCalls: 0,
      onManualExtractCalls: 0,
      clearedHistoryDirty: null,
      postRollbackGraph: null,
      manualExtractLevel: "success",
      ensureCurrentGraphRuntimeState() {
        return context.currentGraph;
      },
      getContext() {
        return {
          chat: context.chat,
          chatId: "chat-main",
        };
      },
      getCurrentChatId() {
        return "chat-main";
      },
      getAssistantTurns(chat = []) {
        return chat.flatMap((message, index) =>
          !message?.is_user && !message?.is_system ? [index] : [],
        );
      },
      getLastProcessedAssistantFloor() {
        return Number(
          context.currentGraph?.historyState?.lastProcessedAssistantFloor ?? -1,
        );
      },
      findJournalRecoveryPoint(graph, floor) {
        return context.findJournalRecoveryPointImpl(graph, floor);
      },
      findJournalRecoveryPointImpl() {
        return null;
      },
      buildReverseJournalRecoveryPlan(...args) {
        return context.buildReverseJournalRecoveryPlanImpl(...args);
      },
      buildReverseJournalRecoveryPlanImpl() {
        return {
          backendDeleteHashes: [],
          replayRequiredNodeIds: [],
          pendingRepairFromFloor: null,
          legacyGapFallback: false,
          dirtyReason: "history-recovery-replay",
        };
      },
      rollbackAffectedJournals(graph, journals) {
        context.rollbackAffectedJournalsCalls.push({ graph, journals });
        if (context.postRollbackGraph) {
          context.currentGraph = context.postRollbackGraph;
        }
      },
      normalizeGraphRuntimeState(graph) {
        return graph;
      },
      getEmbeddingConfig() {
        return context.embeddingConfig;
      },
      applyRecoveryPlanToVectorState(plan, floor) {
        context.recoveryPlans.push({ plan, floor });
      },
      isBackendVectorConfig(config) {
        return config?.mode === "backend";
      },
      async deleteBackendVectorHashesForRecovery(...args) {
        context.deletedHashesCalls.push(args);
      },
      pruneProcessedMessageHashesFromFloor(graph, fromFloor) {
        return pruneProcessedMessageHashesFromFloor(graph, fromFloor);
      },
      async prepareVectorStateForReplay(...args) {
        context.prepareVectorStateCalls.push(args);
      },
      clearHistoryDirty(graph, result) {
        context.clearedHistoryDirty = result;
        graph.historyState ||= {};
        graph.historyState.historyDirtyFrom = null;
        graph.historyState.lastRecoveryResult = result;
      },
      buildRecoveryResult(status, extra = {}) {
        return {
          status,
          ...extra,
        };
      },
      saveGraphToChat() {
        context.saveGraphToChatCalls += 1;
        return true;
      },
      refreshPanelLiveState() {
        context.refreshPanelCalls += 1;
      },
      setRuntimeStatus(text, meta = "", level = "info") {
        context.runtimeStatus = { text, meta, level };
      },
      clearInjectionState() {
        context.clearInjectionCalls += 1;
      },
      async onManualExtract() {
        context.onManualExtractCalls += 1;
        context.lastExtractionStatus = { level: context.manualExtractLevel };
      },
      ensureGraphMutationReady() {
        return true;
      },
      getGraphMutationBlockReason() {
        return "graph-not-ready";
      },
      graphPersistenceState: {
        loadState: "loaded",
      },
      createUiStatus,
      onRerollController,
      isAbortError: (e) => e?.name === "AbortError",
      assertRecoveryChatStillActive() {
        // no-op in test
      },
      toastr: {
        info() {},
        error() {},
        success() {},
      },
    };
    vm.createContext(context);
    vm.runInContext(
      `${snippet}\nresult = { rollbackGraphForReroll, onReroll };`,
      context,
      { filename: indexPath },
    );
    return context;
  });
}

function pushTestOverrides(patch = {}) {
  const previous = globalThis.__stBmeTestOverrides || {};
  globalThis.__stBmeTestOverrides = {
    ...previous,
    ...patch,
    llm: {
      ...(previous.llm || {}),
      ...(patch.llm || {}),
    },
    embedding: {
      ...(previous.embedding || {}),
      ...(patch.embedding || {}),
    },
  };

  return () => {
    globalThis.__stBmeTestOverrides = previous;
  };
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

  const restoreOverrides = pushTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          fields: {
            title: "压缩事件",
            summary: "合并摘要",
            participants: "Alice",
            status: "done",
          },
        };
      },
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
    restoreOverrides();
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

  const restoreOverrides = pushTestOverrides({
    embedding: {
      async embedBatch() {
        return [[0.1, 0.2], null];
      },
    },
  });

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
    restoreOverrides();
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

  const restoreOverrides = pushTestOverrides({
    embedding: {
      async embedBatch() {
        return [[0.2, 0.3]];
      },
      searchSimilar() {
        return [{ nodeId: target.id, score: 0.99 }];
      },
    },
    llm: {
      async callLLMForJSON() {
        return {
          results: [
            {
              node_id: incoming.id,
              action: "merge",
              merge_target_id: "missing-node-id",
              reason: "故意触发无效 merge target 回退",
            },
          ],
        };
      },
    },
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
    restoreOverrides();
  }
}

async function testExtractorFailsOnUnknownOperation() {
  const graph = createEmptyGraph();
  const restoreOverrides = pushTestOverrides({
    llm: {
      async callLLMForJSON() {
        return {
          operations: [{ action: "nonsense", foo: 1 }],
        };
      },
    },
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
    restoreOverrides();
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
  target.embedding = [0.8, 0.2];
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

  const restoreOverrides = pushTestOverrides({
    embedding: {
      async embedBatch() {
        return [[0.4, 0.5]];
      },
      searchSimilar() {
        return [{ nodeId: target.id, score: 0.99 }];
      },
    },
    llm: {
      async callLLMForJSON() {
        return {
          results: [
            {
              node_id: incoming.id,
              action: "merge",
              merge_target_id: target.id,
              merged_fields: { summary: "合并后摘要" },
            },
          ],
        };
      },
    },
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

    assert.equal(stats.merged, 1);
    assert.deepEqual(target.seqRange, [3, 9]);
    assert.equal(target.seq, 8);
    assert.equal(target.fields.summary, "合并后摘要");
    assert.equal(target.embedding, null);
    assert.equal(incoming.archived, true);
  } finally {
    restoreOverrides();
  }
}

async function testBatchJournalVectorDeltaCapturesRecoveryFields() {
  const before = normalizeGraphRuntimeState(createEmptyGraph(), "chat-a");
  const after = normalizeGraphRuntimeState(createEmptyGraph(), "chat-a");
  const beforeNode = createNode({
    type: "event",
    seq: 1,
    fields: { title: "旧", summary: "旧", participants: "A", status: "old" },
  });
  beforeNode.id = "node-before";
  const afterNode = createNode({
    type: "event",
    seq: 1,
    fields: { title: "新", summary: "新", participants: "A", status: "new" },
  });
  afterNode.id = "node-before";
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
    type: "event",
    seq: 1,
    fields: {
      title: "稳定节点",
      summary: "稳定摘要",
      participants: "Alice",
      status: "stable",
    },
  });
  stableNode.id = "node-stable";
  const touchedBefore = createNode({
    type: "event",
    seq: 2,
    fields: {
      title: "回滚前节点",
      summary: "旧摘要",
      participants: "Bob",
      status: "old",
    },
  });
  touchedBefore.id = "node-touched";
  const touchedAfter = createNode({
    type: "event",
    seq: 5,
    fields: {
      title: "回滚后节点",
      summary: "新摘要",
      participants: "Bob",
      status: "updated",
    },
  });
  touchedAfter.id = "node-touched";
  const appendedNode = createNode({
    type: "event",
    seq: 6,
    fields: {
      title: "新增节点",
      summary: "新增摘要",
      participants: "Cara",
      status: "new",
    },
  });
  appendedNode.id = "node-appended";
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

async function testGenerationRecallSkippedStateDoesNotLoopToBeforeCombine() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同一条但本次跳过" }];
  harness.runRecall = async (options = {}) => {
    harness.runRecallCalls.push({ ...options });
    return {
      status: "skipped",
      didRecall: false,
      ok: false,
      reason: "测试跳过",
    };
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(
    harness.result.generationRecallTransactions.size,
    1,
  );
  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.equal(transaction.hookStates.GENERATION_AFTER_COMMANDS, "skipped");
}

async function testGenerationRecallAppliesFinalInjectionOncePerTransaction() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "同一轮仅一次最终注入" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.applyFinalCalls.length, 1);
  assert.equal(harness.applyFinalCalls[0].generationType, "normal");
}

async function testPersistentRecallDataLayerLifecycleAndCompatibility() {
  const chat = [
    { is_user: true, mes: "u0" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
  ];

  const record = buildPersistedRecallRecord({
    injectionText: "fresh-memory",
    selectedNodeIds: ["n1", "n2"],
    recallInput: "u2",
    recallSource: "chat-last-user",
    hookName: "GENERATION_AFTER_COMMANDS",
    tokenEstimate: 24,
    manuallyEdited: false,
    nowIso: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(writePersistedRecallToUserMessage(chat, 2, record), true);

  const loaded = readPersistedRecallFromUserMessage(chat, 2);
  assert.ok(loaded);
  assert.equal(loaded.injectionText, "fresh-memory");
  assert.equal(loaded.generationCount, 0);
  assert.equal(loaded.manuallyEdited, false);

  chat[2].mes = "u2 edited";
  assert.equal(readPersistedRecallFromUserMessage(chat, 2)?.injectionText, "fresh-memory");

  const bumped = bumpPersistedRecallGenerationCount(chat, 2);
  assert.equal(bumped?.generationCount, 1);

  const edited = markPersistedRecallManualEdit(
    chat,
    2,
    true,
    "2026-01-01T00:00:01.000Z",
  );
  assert.equal(edited?.manuallyEdited, true);
  assert.equal(edited?.updatedAt, "2026-01-01T00:00:01.000Z");

  const overwrite = buildPersistedRecallRecord(
    {
      injectionText: "system-rerecall",
      selectedNodeIds: ["n3"],
      recallInput: "u2 edited",
      recallSource: "message-floor-rerecall",
      hookName: "MESSAGE_RECALL_BADGE_RERUN",
      tokenEstimate: 30,
      manuallyEdited: false,
      nowIso: "2026-01-01T00:00:02.000Z",
    },
    readPersistedRecallFromUserMessage(chat, 2),
  );
  assert.equal(writePersistedRecallToUserMessage(chat, 2, overwrite), true);
  const overwritten = readPersistedRecallFromUserMessage(chat, 2);
  assert.equal(overwritten?.manuallyEdited, false);
  assert.equal(overwritten?.injectionText, "system-rerecall");

  assert.equal(removePersistedRecallFromUserMessage(chat, 2), true);
  assert.equal(readPersistedRecallFromUserMessage(chat, 2), null);
  assert.equal(readPersistedRecallFromUserMessage([{ is_user: true, mes: "legacy" }], 0), null);
}

async function testPersistentRecallSourceResolutionAndTargetRouting() {
  const chat = [
    { is_user: true, mes: "u0" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a3" },
  ];

  assert.equal(resolveGenerationTargetUserMessageIndex(chat, { generationType: "normal" }), null);
  assert.equal(resolveGenerationTargetUserMessageIndex(chat, { generationType: "continue" }), 2);

  const withTailUser = [...chat, { is_user: true, mes: "u4" }];
  assert.equal(resolveGenerationTargetUserMessageIndex(withTailUser, { generationType: "normal" }), 4);

  const freshWins = resolveFinalRecallInjectionSource({
    freshRecallResult: { status: "completed", didRecall: true, injectionText: "fresh" },
    persistedRecord: { injectionText: "persisted" },
  });
  assert.equal(freshWins.source, "fresh");
  assert.equal(freshWins.injectionText, "fresh");

  const fallback = resolveFinalRecallInjectionSource({
    freshRecallResult: { status: "skipped", didRecall: false, injectionText: "" },
    persistedRecord: { injectionText: "persisted" },
  });
  assert.equal(fallback.source, "persisted");
  assert.equal(fallback.injectionText, "persisted");
}

async function testRecallSubGraphAndDataLayerEntryPoints() {
  // Sub-graph build test (pure function, no DOM needed)
  const { buildRecallSubGraph } = await import("../recall-message-ui.js");

  const graph = {
    nodes: [
      { id: "n1", type: "character", name: "赵管家", importance: 7 },
      { id: "n2", type: "event", name: "喂食", importance: 5 },
      { id: "n3", type: "location", name: "厨房", importance: 3, archived: true },
      { id: "n4", type: "thread", name: "主线", importance: 8 },
    ],
    edges: [
      { fromId: "n1", toId: "n2", strength: 0.8, relation: "related" },
      { fromId: "n2", toId: "n3", strength: 0.5, relation: "located" },
      { fromId: "n1", toId: "n4", strength: 0.6, relation: "participates" },
    ],
  };

  const sub1 = buildRecallSubGraph(graph, ["n1", "n2"]);
  assert.equal(sub1.nodes.length, 2);
  assert.equal(sub1.edges.length, 1);
  assert.equal(sub1.edges[0].fromId, "n1");

  // archived node should be excluded
  const sub2 = buildRecallSubGraph(graph, ["n1", "n3"]);
  assert.equal(sub2.nodes.length, 1);
  assert.equal(sub2.edges.length, 0);

  // empty/null safety
  assert.equal(buildRecallSubGraph(null, ["n1"]).nodes.length, 0);
  assert.equal(buildRecallSubGraph(graph, null).nodes.length, 0);
  assert.equal(buildRecallSubGraph(graph, []).nodes.length, 0);

  // Data layer: edit and delete still work
  const chat = [{ is_user: true, mes: "u0", extra: { bme_recall: { version: 1, injectionText: "test", selectedNodeIds: ["n1"], generationCount: 0, manuallyEdited: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", recallInput: "u0", recallSource: "test", hookName: "TEST", tokenEstimate: 4 } } }];
  assert.ok(readPersistedRecallFromUserMessage(chat, 0));
  assert.equal(removePersistedRecallFromUserMessage(chat, 0), true);
  assert.equal(readPersistedRecallFromUserMessage(chat, 0), null);
}

async function testRerollUsesBatchBoundaryRollbackAndPersistsState() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
    { is_user: true, mes: "u3" },
    { is_user: false, mes: "a3" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 5,
      processedMessageHashes: {
        1: "hash-1",
        3: "hash-3",
        5: "hash-5",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [{ id: "journal-1" }],
    lastProcessedSeq: 5,
  };
  harness.postRollbackGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: {
        1: "hash-1",
        3: "stale-hash",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };
  harness.findJournalRecoveryPointImpl = () => ({
    path: "reverse-journal",
    affectedBatchCount: 1,
    affectedJournals: [{ id: "journal-1" }],
  });
  harness.buildReverseJournalRecoveryPlanImpl = () => ({
    backendDeleteHashes: ["hash-old"],
    replayRequiredNodeIds: ["node-1"],
    pendingRepairFromFloor: 2,
    legacyGapFallback: false,
    dirtyReason: "history-recovery-replay",
  });

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, true);
  assert.equal(result.rollbackPerformed, true);
  assert.equal(result.recoveryPath, "reverse-journal");
  assert.equal(result.effectiveFromFloor, 2);
  assert.equal(harness.rollbackAffectedJournalsCalls.length, 1);
  assert.equal(harness.deletedHashesCalls.length, 1);
  assert.equal(harness.prepareVectorStateCalls.length, 1);
  assert.equal(harness.prepareVectorStateCalls[0][2].skipBackendPurge, true);
  assert.equal(harness.saveGraphToChatCalls, 1);
  assert.equal(harness.refreshPanelCalls, 2);
  assert.equal(harness.clearInjectionCalls, 1);
  assert.equal(harness.onManualExtractCalls, 1);
  assert.equal(harness.currentGraph.historyState.processedMessageHashes[3], undefined);
  assert.equal(harness.lastExtractedItems.length, 0);
}

async function testRerollRejectsMissingRecoveryPoint() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 3,
      processedMessageHashes: {
        1: "hash-1",
        3: "hash-3",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 3,
  };

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, false);
  assert.equal(result.recoveryPath, "unavailable");
  assert.equal(harness.onManualExtractCalls, 0);
  assert.equal(harness.saveGraphToChatCalls, 0);
}

async function testRerollFallsBackToDirectExtractForUnprocessedFloor() {
  const harness = await createRerollHarness();
  harness.chat = [
    { is_user: true, mes: "u1" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a2" },
  ];
  harness.currentGraph = {
    historyState: {
      lastProcessedAssistantFloor: 1,
      processedMessageHashes: {
        1: "hash-1",
      },
    },
    vectorIndexState: {
      collectionId: "col-1",
    },
    batchJournal: [],
    lastProcessedSeq: 1,
  };

  const result = await harness.result.onReroll({ fromFloor: 3 });

  assert.equal(result.success, true);
  assert.equal(result.rollbackPerformed, false);
  assert.equal(result.recoveryPath, "direct-extract");
  assert.equal(result.effectiveFromFloor, 2);
  assert.equal(harness.onManualExtractCalls, 1);
  assert.equal(harness.saveGraphToChatCalls, 0);
}

async function testLlmDebugSnapshotRedactsSecretsBeforeStorage() {
  const originalFetch = globalThis.fetch;
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  delete globalThis.__stBmeRuntimeDebugState;
  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-secret-redaction",
    llmModel: "gpt-test",
    timeoutMs: 1234,
  };

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"ok":true}',
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  try {
    const result = await llm.callLLMForJSON({
      systemPrompt: "system",
      userPrompt: "user",
      maxRetries: 0,
      requestSource: "test:redaction",
    });
    assert.deepEqual(result, { ok: true });

    const snapshot =
      globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.["test:redaction"];
    assert.ok(snapshot);
    assert.equal(snapshot.redacted, true);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /sk-secret-redaction/);
    assert.match(serialized, /\[REDACTED\]/);
  } finally {
    globalThis.fetch = originalFetch;
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
}

async function testEmbeddingUsesConfigTimeoutInsteadOfDefault() {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let capturedDelay = null;

  globalThis.setTimeout = (fn, delay, ...args) => {
    capturedDelay = delay;
    return originalSetTimeout(fn, 0, ...args);
  };
  globalThis.clearTimeout = originalClearTimeout;
  globalThis.fetch = async (_url, options = {}) =>
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });

  try {
    await assert.rejects(
      embedding.embedText("timeout test", {
        apiUrl: "https://example.com/v1",
        model: "text-embedding-test",
        timeoutMs: 7,
      }),
      /Embedding 请求超时/,
    );
    assert.equal(capturedDelay, 7);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

async function testLlmOutputRegexCleansResponseBeforeJsonParse() {
  const originalFetch = globalThis.fetch;
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  delete globalThis.__stBmeRuntimeDebugState;

  const taskProfiles = createDefaultTaskProfiles();
  taskProfiles.extract.profiles[0].regex = {
    ...taskProfiles.extract.profiles[0].regex,
    enabled: true,
    inheritStRegex: false,
    stages: {
      ...taskProfiles.extract.profiles[0].regex.stages,
      "output.rawResponse": true,
      "output.beforeParse": true,
    },
    localRules: [
      {
        id: "strip-prefix",
        script_name: "strip-prefix",
        enabled: true,
        find_regex: "/^NOTE:\\s*/g",
        replace_string: "",
        trim_strings: [],
        source: {
          ai_output: true,
        },
        destination: {
          prompt: true,
          display: false,
        },
      },
      {
        id: "strip-suffix",
        script_name: "strip-suffix",
        enabled: true,
        find_regex: "/\\s*END$/g",
        replace_string: "",
        trim_strings: [],
        source: {
          ai_output: true,
        },
        destination: {
          prompt: true,
          display: false,
        },
      },
    ],
  };

  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-secret-redaction",
    llmModel: "gpt-test",
    taskProfilesVersion: 1,
    taskProfiles,
  };

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'NOTE: {"ok":true} END',
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  try {
    const result = await llm.callLLMForJSON({
      systemPrompt: "system",
      userPrompt: "user",
      maxRetries: 0,
      taskType: "extract",
      requestSource: "test:output-regex",
    });
    assert.deepEqual(result, { ok: true });

    const snapshot =
      globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.extract;
    assert.ok(snapshot);
    assert.equal(snapshot.responseCleaning?.applied, true);
    assert.equal(snapshot.responseCleaning?.changed, true);
    assert.deepEqual(
      snapshot.responseCleaning?.stages?.map((entry) => entry.stage),
      ["output.rawResponse", "output.beforeParse"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
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
await testGenerationRecallSkippedStateDoesNotLoopToBeforeCombine();
await testGenerationRecallAppliesFinalInjectionOncePerTransaction();
await testPersistentRecallDataLayerLifecycleAndCompatibility();
await testPersistentRecallSourceResolutionAndTargetRouting();
await testRecallSubGraphAndDataLayerEntryPoints();
await testRerollUsesBatchBoundaryRollbackAndPersistsState();
await testRerollRejectsMissingRecoveryPoint();
await testRerollFallsBackToDirectExtractForUnprocessedFloor();
await testLlmDebugSnapshotRedactsSecretsBeforeStorage();
await testEmbeddingUsesConfigTimeoutInsteadOfDefault();
await testLlmOutputRegexCleansResponseBeforeJsonParse();

console.log("p0-regressions tests passed");
