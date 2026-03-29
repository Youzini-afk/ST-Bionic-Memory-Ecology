import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  createEmptyGraph,
  deserializeGraph,
  getGraphStats,
  getNode,
  serializeGraph,
} from "../graph.js";
import { normalizeGraphRuntimeState } from "../runtime-state.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../index.js");
const indexSource = await fs.readFile(indexPath, "utf8");

function extractSnippet(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`无法提取 index.js 片段: ${startMarker} -> ${endMarker}`);
  }
  return indexSource.slice(start, end).replace(/^export\s+/gm, "");
}

const persistencePrelude = extractSnippet(
  'const MODULE_NAME = "st_bme";',
  "function clearInjectionState(options = {}) {",
);
const persistenceCore = extractSnippet(
  "function loadGraphFromChat(options = {}) {",
  "function handleGraphShadowSnapshotPageHide() {",
);
const messageSnippet = extractSnippet(
  "function onMessageReceived() {",
  "// ==================== UI 操作 ====================",
);

function createSessionStorage(seed = null) {
  const store = seed instanceof Map ? seed : new Map();
  return {
    __store: store,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
  };
}

function createMeaningfulGraph(chatId = "chat-test", suffix = "base") {
  const graph = createEmptyGraph();
  graph.historyState.chatId = chatId;
  graph.historyState.extractionCount = 3;
  graph.historyState.lastProcessedAssistantFloor = 6;
  graph.lastProcessedSeq = 6;
  graph.lastRecallResult = [{ id: `recall-${suffix}` }];
  graph.nodes.push({
    id: `node-${suffix}`,
    type: "event",
    fields: {
      title: `事件-${suffix}`,
      summary: `摘要-${suffix}`,
    },
    seq: 6,
    seqRange: [6, 6],
    archived: false,
    embedding: null,
    importance: 5,
    accessCount: 0,
    lastAccessTime: Date.now(),
    createdTime: Date.now(),
    level: 0,
    parentId: null,
    childIds: [],
    prevId: null,
    nextId: null,
    clusters: [],
  });
  return normalizeGraphRuntimeState(graph, chatId);
}

function stampPersistedGraph(
  graph,
  {
    revision = 1,
    integrity = "",
    chatId = graph?.historyState?.chatId || "",
    reason = "test",
  } = {},
) {
  graph.__stBmePersistence = {
    revision,
    integrity,
    chatId,
    reason,
    updatedAt: new Date().toISOString(),
    sessionId: "test-session",
  };
  return graph;
}

async function createGraphPersistenceHarness({
  chatId = "chat-test",
  chatMetadata = undefined,
  sessionStore = null,
  globalChatId = "",
  characterId = "",
  groupId = null,
  chat = [],
} = {}) {
  const timers = new Map();
  let nextTimerId = 1;
  const storage = createSessionStorage(sessionStore);

  const runtimeContext = {
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    structuredClone,
    result: null,
    sessionStorage: storage,
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    queueMicrotask(fn) {
      fn();
    },
    toastr: {
      info() {},
      warning() {},
      error() {},
      success() {},
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      visibilityState: "visible",
      getElementById() {
        return null;
      },
    },
    SillyTavern: {
      getCurrentChatId() {
        return runtimeContext.__globalChatId;
      },
    },
    __globalChatId: String(globalChatId || ""),
    refreshPanelLiveState() {
      runtimeContext.__panelRefreshCount += 1;
    },
    __panelRefreshCount: 0,
    createEmptyGraph,
    normalizeGraphRuntimeState,
    serializeGraph,
    deserializeGraph,
    getGraphStats,
    getNode,
    createDefaultTaskProfiles() {
      return {
        extract: { activeProfileId: "default", profiles: [] },
        recall: { activeProfileId: "default", profiles: [] },
        compress: { activeProfileId: "default", profiles: [] },
        synopsis: { activeProfileId: "default", profiles: [] },
        reflection: { activeProfileId: "default", profiles: [] },
      };
    },
    getContext() {
      return runtimeContext.__chatContext;
    },
    async saveMetadata() {
      runtimeContext.__globalImmediateSaveCalls += 1;
    },
    saveMetadataDebounced() {
      runtimeContext.__globalSaveCalls += 1;
    },
    __globalSaveCalls: 0,
    __globalImmediateSaveCalls: 0,
    isAssistantChatMessage() {
      return false;
    },
    isFreshRecallInputRecord() {
      return true;
    },
    notifyExtractionIssue() {},
    async runExtraction() {},
    __chatContext: {
      chatId,
      chatMetadata,
      characterId,
      groupId,
      chat,
      updateChatMetadata(patch) {
        const base =
          this.chatMetadata &&
          typeof this.chatMetadata === "object" &&
          !Array.isArray(this.chatMetadata)
            ? this.chatMetadata
            : {};
        this.chatMetadata = {
          ...base,
          ...(patch || {}),
        };
      },
      saveMetadataDebounced() {
        runtimeContext.__contextSaveCalls += 1;
      },
      async saveMetadata() {
        runtimeContext.__contextImmediateSaveCalls += 1;
      },
    },
    __contextSaveCalls: 0,
    __contextImmediateSaveCalls: 0,
  };

  runtimeContext.globalThis = runtimeContext;
  vm.createContext(runtimeContext);
  vm.runInContext(
    [
      persistencePrelude,
      persistenceCore,
      messageSnippet,
      `
result = {
  GRAPH_LOAD_STATES,
  GRAPH_LOAD_RETRY_DELAYS_MS,
  readRuntimeDebugSnapshot,
  getGraphPersistenceLiveState,
  readGraphShadowSnapshot,
  writeGraphShadowSnapshot,
  removeGraphShadowSnapshot,
  maybeCaptureGraphShadowSnapshot,
  loadGraphFromChat,
  saveGraphToChat,
  syncGraphLoadFromLiveContext,
  onMessageReceived,
  applyGraphLoadState,
  maybeFlushQueuedGraphPersist,
  setCurrentGraph(graph) {
    currentGraph = graph;
    return currentGraph;
  },
  getCurrentGraph() {
    return currentGraph;
  },
  setGraphPersistenceState(patch = {}) {
    graphPersistenceState = {
      ...graphPersistenceState,
      ...(patch || {}),
      updatedAt: new Date().toISOString(),
    };
    syncGraphPersistenceDebugState();
    return graphPersistenceState;
  },
  getGraphPersistenceState() {
    return graphPersistenceState;
  },
  setChatContext(nextContext) {
    globalThis.__chatContext = nextContext;
    return globalThis.__chatContext;
  },
  getChatContext() {
    return globalThis.__chatContext;
  },
};
      `,
    ].join("\n"),
    runtimeContext,
    { filename: indexPath },
  );

  return {
    api: runtimeContext.result,
    runtimeContext,
    sessionStore: storage.__store,
  };
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {},
    characterId: "",
    groupId: null,
    chat: [],
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "no-chat-empty-host-state",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "no-chat");
  assert.equal(live.loadState, "no-chat");
  assert.equal(live.writesBlocked, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "chat-global",
    chatMetadata: {
      st_bme_graph: createMeaningfulGraph("chat-global", "global"),
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "global-chat-id",
  });

  assert.equal(result.loadState, "loaded");
  assert.equal(harness.api.getCurrentGraph().historyState.chatId, "chat-global");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {},
  });
  const lateGraph = createMeaningfulGraph("chat-late", "late");
  harness.api.setChatContext({
    chatId: "chat-late",
    chatMetadata: {
      integrity: "chat-late-ready",
      st_bme_graph: lateGraph,
    },
    characterId: "char-late",
    groupId: null,
    chat: [{ is_user: true, mes: "late load" }],
    updateChatMetadata(patch) {
      const base =
        this.chatMetadata &&
        typeof this.chatMetadata === "object" &&
        !Array.isArray(this.chatMetadata)
          ? this.chatMetadata
          : {};
      this.chatMetadata = {
        ...base,
        ...(patch || {}),
      };
    },
    saveMetadataDebounced() {},
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "late-context-sync",
  });

  assert.equal(result.synced, true);
  assert.equal(result.loadState, "loaded");
  assert.equal(harness.api.getCurrentGraph().historyState.chatId, "chat-late");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {},
  });
  harness.api.setChatContext({
    chatId: "chat-empty-live",
    chatMetadata: {
      integrity: "chat-empty-live-ready",
    },
    characterId: "char-empty-live",
    groupId: null,
    chat: [{ is_user: true, mes: "hello" }],
    updateChatMetadata(patch) {
      const base =
        this.chatMetadata &&
        typeof this.chatMetadata === "object" &&
        !Array.isArray(this.chatMetadata)
          ? this.chatMetadata
          : {};
      this.chatMetadata = {
        ...base,
        ...(patch || {}),
      };
    },
    saveMetadataDebounced() {},
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "late-empty-sync",
  });

  assert.equal(result.synced, true);
  assert.equal(result.loadState, "empty-confirmed");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    characterId: "char-1",
    chatMetadata: undefined,
    chat: [{ is_user: true, mes: "hello" }],
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "pending-chat-context",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "loading");
  assert.equal(live.loadState, "loading");
  assert.equal(live.reason, "chat-id-missing");
  assert.equal(live.writesBlocked, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-blocked",
    chatMetadata: undefined,
  });
  const graph = createMeaningfulGraph("chat-blocked", "blocked");
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-blocked",
    reason: "chat-metadata-missing",
    revision: 4,
    writesBlocked: true,
  });

  const result = harness.api.saveGraphToChat({
    reason: "blocked-save",
    markMutation: false,
  });
  assert.equal(result.saved, false);
  assert.equal(result.queued, true);
  assert.equal(result.blocked, true);
  assert.equal(harness.runtimeContext.__chatContext.chatMetadata, undefined);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(harness.runtimeContext.__globalSaveCalls, 0);

  const shadow = harness.api.readGraphShadowSnapshot("chat-blocked");
  assert.ok(shadow, "loading 状态下应写入会话影子快照");
  assert.equal(shadow.revision, 4);
  assert.equal(
    harness.api.readRuntimeDebugSnapshot().graphPersistence?.queuedPersistRevision,
    4,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(normalizeGraphRuntimeState(createEmptyGraph(), "chat-empty"));
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-empty",
    reason: "chat-metadata-missing",
    revision: 0,
    writesBlocked: true,
  });

  const result = harness.api.saveGraphToChat({
    reason: "loading-empty-save",
    markMutation: false,
  });
  assert.equal(result.blocked, false);
  assert.equal(result.queued, false);
  assert.equal(result.reason, "passive-empty-graph-skipped");
  assert.equal(
    harness.api.readGraphShadowSnapshot("chat-empty"),
    null,
    "空图不应污染影子快照",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-message",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(createMeaningfulGraph("chat-message", "message"));
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-message",
    reason: "chat-metadata-missing",
    revision: 2,
    writesBlocked: true,
  });

  harness.api.onMessageReceived();

  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata,
    undefined,
    "onMessageReceived 不应在 loading 期间写回 chat metadata",
  );
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.ok(
    harness.api.readGraphShadowSnapshot("chat-message"),
    "onMessageReceived 应只做会话快照兜底",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-shadow",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-shadow",
    createMeaningfulGraph("chat-shadow", "shadow"),
    { revision: 7, reason: "manual-shadow" },
  );

  const reader = await createGraphPersistenceHarness({
    chatId: "chat-shadow",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "shadow-test",
  });

  assert.equal(result.loadState, "shadow-restored");
  assert.equal(reader.api.getCurrentGraph().nodes.length, 1);
  assert.equal(
    reader.api.getGraphPersistenceLiveState().shadowSnapshotUsed,
    true,
  );
  assert.equal(reader.api.getGraphPersistenceLiveState().writesBlocked, true);
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-official",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-official",
    createMeaningfulGraph("chat-official", "shadow-stale"),
    { revision: 3, reason: "stale-shadow" },
  );

  const officialGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-official", "official"),
    { revision: 6, integrity: "official-integrity" },
  );
  const reader = await createGraphPersistenceHarness({
    chatId: "chat-official",
    chatMetadata: {
      integrity: "official-integrity",
      st_bme_graph: officialGraph,
    },
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "official-load",
  });

  assert.equal(result.loadState, "loaded");
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-official",
  );
  assert.equal(
    reader.api.readGraphShadowSnapshot("chat-official"),
    null,
    "正式元数据到位后应清理影子快照",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-shadow-newer",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-shadow-newer",
    createMeaningfulGraph("chat-shadow-newer", "shadow-newer"),
    { revision: 9, reason: "pagehide-refresh" },
  );

  const officialGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-shadow-newer", "official-older"),
    { revision: 3, integrity: "integrity-official-older" },
  );
  const reader = await createGraphPersistenceHarness({
    chatId: "chat-shadow-newer",
    chatMetadata: {
      integrity: "integrity-official-older",
      st_bme_graph: officialGraph,
    },
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "official-older-than-shadow",
  });

  assert.equal(result.loadState, "loaded");
  assert.equal(result.reason, "shadow-snapshot-newer-than-official");
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-shadow-newer",
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 1);
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes?.[0]?.fields
      ?.title,
    "事件-shadow-newer",
  );
  assert.equal(
    reader.api.readGraphShadowSnapshot("chat-shadow-newer"),
    null,
    "影子快照补写成功后应被清理",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty-confirmed",
    chatMetadata: {
      integrity: "meta-ready-empty",
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "ready-empty",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "empty-confirmed");
  assert.equal(live.writesBlocked, false);
  assert.equal(live.canWriteToMetadata, true);
  assert.equal(harness.api.getCurrentGraph().nodes.length, 0);
  assert.equal(
    harness.api.readRuntimeDebugSnapshot().graphPersistence?.loadState,
    "empty-confirmed",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty-confirmed-passive",
    chatMetadata: {
      integrity: "meta-ready-empty-passive",
    },
  });
  harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "ready-empty-passive",
  });

  harness.api.onMessageReceived();

  assert.equal(
    harness.runtimeContext.__contextImmediateSaveCalls,
    0,
    "空聊天的被动同步不应触发立即保存",
  );
  assert.equal(
    harness.runtimeContext.__contextSaveCalls,
    0,
    "空聊天的被动同步不应触发防抖保存",
  );
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph,
    undefined,
    "empty-confirmed 状态下不能把空图被动写回 metadata",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-create-first-graph",
    chatMetadata: {
      integrity: "integrity-before-first-save",
    },
  });
  harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "ready-for-first-save",
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph("chat-create-first-graph", "first-save"),
  );

  const result = harness.api.saveGraphToChat({
    reason: "first-meaningful-graph",
  });

  assert.equal(result.saved, true);
  assert.equal(result.saveMode, "immediate");
  assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 1);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.integrity ===
      "integrity-before-first-save",
    false,
    "真正改图后应轮换 metadata.integrity，阻止旧页面覆盖",
  );
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.__stBmePersistence
      ?.revision > 0,
    true,
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-promote",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-promote",
    createMeaningfulGraph("chat-promote", "promote"),
    { revision: 9, reason: "pre-refresh" },
  );

  const reader = await createGraphPersistenceHarness({
    chatId: "chat-promote",
    chatMetadata: {
      integrity: "meta-ready-promote",
    },
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "promote-when-metadata-ready",
  });
  const live = reader.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "loaded");
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes?.length,
    1,
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 1);
  assert.equal(reader.runtimeContext.__contextSaveCalls, 0);
  assert.equal(live.lastPersistedRevision, 9);
  assert.equal(live.pendingPersist, false);
}

console.log("graph-persistence tests passed");
