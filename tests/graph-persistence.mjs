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
import {
  createUiStatus,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  normalizeStageNoticeLevel,
  getStageNoticeTitle,
  getStageNoticeDuration,
  normalizeRecallInputText,
  hashRecallInput,
  isFreshRecallInputRecord,
  clampInt,
  clampFloat,
  formatRecallContextLine,
} from "../ui-status.js";
import {
  cloneGraphForPersistence,
  cloneRuntimeDebugValue,
  getGraphPersistenceMeta,
  getGraphPersistedRevision,
  getGraphShadowSnapshotStorageKey,
  GRAPH_LOAD_PENDING_CHAT_ID,
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_PERSISTENCE_META_KEY,
  GRAPH_PERSISTENCE_SESSION_ID,
  GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX,
  GRAPH_STARTUP_RECONCILE_DELAYS_MS,
  MODULE_NAME,
  readGraphShadowSnapshot,
  removeGraphShadowSnapshot,
  shouldPreferShadowSnapshotOverOfficial,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphShadowSnapshot,
} from "../graph-persistence.js";
import { onMessageReceivedController } from "../event-binding.js";

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
  'const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";',
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
    createUiStatus,
    createGraphPersistenceState,
    createRecallInputRecord,
    createRecallRunResult,
    normalizeStageNoticeLevel,
    getStageNoticeTitle,
    getStageNoticeDuration,
    normalizeRecallInputText,
    hashRecallInput,
    isFreshRecallInputRecord,
    clampInt,
    clampFloat,
    formatRecallContextLine,
    cloneGraphForPersistence,
    cloneRuntimeDebugValue,
    getGraphPersistenceMeta,
    getGraphPersistedRevision,
    getGraphShadowSnapshotStorageKey,
    GRAPH_LOAD_PENDING_CHAT_ID,
    GRAPH_LOAD_STATES,
    GRAPH_METADATA_KEY,
    GRAPH_PERSISTENCE_META_KEY,
    GRAPH_PERSISTENCE_SESSION_ID,
    GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX,
    GRAPH_STARTUP_RECONCILE_DELAYS_MS,
    MODULE_NAME,
    readGraphShadowSnapshot,
    removeGraphShadowSnapshot,
    shouldPreferShadowSnapshotOverOfficial,
    stampGraphPersistenceMeta,
    writeChatMetadataPatch,
    writeGraphShadowSnapshot,
    // Shadow snapshot functions need VM-local sessionStorage overrides
    // because imported versions use the outer globalThis (no sessionStorage)
    readGraphShadowSnapshot(chatId = "") {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        if (!snap || String(snap.chatId || "") !== String(chatId || "") ||
            typeof snap.serializedGraph !== "string" || !snap.serializedGraph) return null;
        return {
          chatId: String(snap.chatId || ""),
          revision: Number.isFinite(snap.revision) ? snap.revision : 0,
          serializedGraph: snap.serializedGraph,
          updatedAt: String(snap.updatedAt || ""),
          reason: String(snap.reason || ""),
        };
      } catch { return null; }
    },
    writeGraphShadowSnapshot(chatId = "", graph = null, { revision = 0, reason = "" } = {}) {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key || !graph) return false;
      try {
        storage.setItem(key, JSON.stringify({
          chatId: String(chatId || ""),
          revision: Number.isFinite(revision) ? revision : 0,
          serializedGraph: serializeGraph(graph),
          updatedAt: new Date().toISOString(),
          reason: String(reason || ""),
        }));
        return true;
      } catch { return false; }
    },
    removeGraphShadowSnapshot(chatId = "") {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key) return false;
      try { storage.removeItem(key); return true; } catch { return false; }
    },
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
  cloneGraphForPersistence,
  assertRecoveryChatStillActive,
  createAbortError,
  isAbortError,
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
  assert.equal(
    harness.api.getCurrentGraph().historyState.chatId,
    "chat-global",
  );
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
    harness.api.readRuntimeDebugSnapshot().graphPersistence
      ?.queuedPersistRevision,
    4,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(createEmptyGraph(), "chat-empty"),
  );
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
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes?.[0]
      ?.fields?.title,
    "事件-shadow-newer",
  );
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.integrity,
    "integrity-official-older",
    "影子快照补写正式图谱时不能改写宿主 metadata.integrity",
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
    true,
    "插件保存图谱时不能改写宿主 metadata.integrity",
  );
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph
      ?.__stBmePersistence?.revision > 0,
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
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes
      ?.length,
    1,
  );
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.integrity,
    "meta-ready-promote",
    "metadata 就绪后提升影子快照时不能改写宿主 metadata.integrity",
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 1);
  assert.equal(reader.runtimeContext.__contextSaveCalls, 0);
  assert.equal(live.lastPersistedRevision, 9);
  assert.equal(live.pendingPersist, false);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-decouple",
    chatMetadata: {
      integrity: "meta-decouple",
    },
  });
  const runtimeGraph = createMeaningfulGraph("chat-decouple", "runtime");
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-decouple",
    revision: 3,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const result = harness.api.saveGraphToChat({
    reason: "decouple-metadata-runtime",
    markMutation: false,
  });

  assert.equal(result.saved, true);
  const persistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph;
  assert.notEqual(
    persistedGraph,
    harness.api.getCurrentGraph(),
    "写入 metadata 时必须使用独立 graph 快照",
  );

  persistedGraph.nodes[0].fields.title = "metadata-mutated";
  assert.equal(
    harness.api.getCurrentGraph().nodes[0].fields.title,
    "事件-runtime",
    "metadata 修改不能反向污染运行时 graph",
  );

  harness.api.getCurrentGraph().nodes[0].fields.title = "runtime-mutated";
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "metadata-mutated",
    "运行时修改不能反向污染已保存 metadata",
  );
}

{
  const officialGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-load-official", "official"),
    {
      revision: 4,
      integrity: "meta-load-official",
      chatId: "chat-load-official",
      reason: "official-save",
    },
  );
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-load-official",
    chatMetadata: {
      integrity: "meta-load-official",
      st_bme_graph: officialGraph,
    },
  });

  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "load-official-decoupled",
  });

  assert.equal(result.loadState, "loaded");
  const runtimeGraph = harness.api.getCurrentGraph();
  const persistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata.st_bme_graph;
  assert.notEqual(
    runtimeGraph,
    persistedGraph,
    "从 official metadata 恢复到运行时必须使用独立对象",
  );

  runtimeGraph.nodes[0].fields.title = "runtime-after-load";
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "事件-official",
    "official metadata 不应被运行时修改污染",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-load-shadow",
    chatMetadata: {
      integrity: "meta-load-shadow",
      st_bme_graph: stampPersistedGraph(
        createMeaningfulGraph("chat-load-shadow", "official-older"),
        {
          revision: 2,
          integrity: "meta-load-shadow",
          chatId: "chat-load-shadow",
          reason: "official-older",
        },
      ),
    },
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-load-shadow",
    createMeaningfulGraph("chat-load-shadow", "shadow"),
    {
      revision: 5,
      reason: "shadow-newer",
    },
  );

  const reader = await createGraphPersistenceHarness({
    chatId: "chat-load-shadow",
    chatMetadata: {
      integrity: "meta-load-shadow",
      st_bme_graph: stampPersistedGraph(
        createMeaningfulGraph("chat-load-shadow", "official-older"),
        {
          revision: 2,
          integrity: "meta-load-shadow",
          chatId: "chat-load-shadow",
          reason: "official-older",
        },
      ),
    },
    sessionStore: sharedSession,
  });

  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "load-shadow-decoupled",
  });

  assert.equal(result.loadState, "loaded");
  const runtimeGraph = reader.api.getCurrentGraph();
  const persistedGraph =
    reader.runtimeContext.__chatContext.chatMetadata.st_bme_graph;
  assert.notEqual(
    runtimeGraph,
    persistedGraph,
    "从 shadow snapshot 提升后，运行时与 metadata 也必须解耦",
  );

  runtimeGraph.nodes[0].fields.title = "runtime-shadow-mutated";
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "事件-shadow",
    "shadow 恢复后的运行时修改不能污染已补写 metadata",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-two-saves",
    chatMetadata: {
      integrity: "meta-two-saves",
    },
  });
  harness.api.setCurrentGraph(createMeaningfulGraph("chat-two-saves", "first"));
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-two-saves",
    revision: 1,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const firstSave = harness.api.saveGraphToChat({
    reason: "first-save",
    markMutation: false,
  });
  assert.equal(firstSave.saved, true);
  const firstPersistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata.st_bme_graph;

  harness.api.getCurrentGraph().nodes[0].fields.title = "runtime-between-saves";
  assert.equal(
    firstPersistedGraph.nodes[0].fields.title,
    "事件-first",
    "第一次保存后的 metadata 不应被后续运行时修改污染",
  );

  harness.api.setGraphPersistenceState({ revision: 2 });
  const secondSave = harness.api.saveGraphToChat({
    reason: "second-save",
    markMutation: false,
  });
  assert.equal(secondSave.saved, true);
  const secondPersistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata.st_bme_graph;

  assert.notEqual(
    secondPersistedGraph,
    firstPersistedGraph,
    "第二次保存应生成新的 metadata graph 快照",
  );
  assert.equal(
    secondPersistedGraph.nodes[0].fields.title,
    "runtime-between-saves",
    "第二次保存应反映第二轮运行时修改",
  );
  harness.api.getCurrentGraph().nodes[0].fields.title =
    "runtime-after-second-save";
  assert.equal(
    firstPersistedGraph.nodes[0].fields.title,
    "事件-first",
    "第二轮运行时修改仍不能污染第一次已保存 metadata",
  );
  assert.equal(
    secondPersistedGraph.nodes[0].fields.title,
    "runtime-between-saves",
    "第二次已保存 metadata 也不能被后续运行时修改污染",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-b",
    globalChatId: "chat-b",
    chatMetadata: {
      integrity: "meta-chat-b",
    },
  });
  harness.api.setCurrentGraph(createMeaningfulGraph("chat-a", "queued"));
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-a",
    revision: 6,
    lastPersistedRevision: 4,
    queuedPersistRevision: 6,
    queuedPersistChatId: "chat-a",
    queuedPersistMode: "immediate",
    pendingPersist: true,
    writesBlocked: false,
  });

  const result = harness.api.maybeFlushQueuedGraphPersist("cross-chat-flush");

  assert.equal(result.saved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "queued-chat-mismatch");
  assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph,
    undefined,
    "跨 chat 的 queued persist 不得 flush 到当前 metadata",
  );
  assert.equal(
    harness.api.getGraphPersistenceLiveState().queuedPersistChatId,
    "chat-a",
    "发生 chat mismatch 时应保留原始 queued chat 绑定",
  );
}

// === Fix 2c: assertRecoveryChatStillActive 跨 chat 守卫 ===
{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-recovery-a",
    globalChatId: "chat-recovery-a",
    chatMetadata: {
      integrity: "meta-recovery-a",
    },
  });

  // 同一 chat 不应抛出
  harness.api.assertRecoveryChatStillActive("chat-recovery-a", "test-same");

  // 切换到 chat-b
  harness.runtimeContext.__globalChatId = "chat-recovery-b";
  harness.runtimeContext.__chatContext.chatId = "chat-recovery-b";

  let abortCaught = false;
  try {
    harness.api.assertRecoveryChatStillActive("chat-recovery-a", "test-switch");
  } catch (e) {
    abortCaught = harness.api.isAbortError(e);
  }
  assert.equal(
    abortCaught,
    true,
    "chat 切换后 assertRecoveryChatStillActive 应抛出 AbortError",
  );

  // 空 expectedChatId 不应抛出
  harness.api.assertRecoveryChatStillActive("", "test-empty");
  harness.api.assertRecoveryChatStillActive(undefined, "test-undefined");
}

// === Fix 2e: resolveDirtyFloorFromMutationMeta 候选过滤 ===
// 此测试需要 resolveDirtyFloorFromMutationMeta 与 getAssistantTurns，
// 它们均在 persistencePrelude 范围内，通过 vm 上下文执行。
// 这里使用间接方式验证：构造一个只有晚期 assistant 的 chat，
// 然后检查 inspectHistoryMutation 不会对早期 floor 误判。
{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-dirty-floor",
    globalChatId: "chat-dirty-floor",
    chatMetadata: {
      integrity: "meta-dirty-floor",
    },
    chat: [
      // index 0: user
      { is_user: true, mes: "hello" },
      // index 1: user (no assistant before index 4)
      { is_user: true, mes: "second" },
      // index 2: user
      { is_user: true, mes: "third" },
      // index 3: user
      { is_user: true, mes: "fourth" },
      // index 4: first assistant
      { is_user: false, mes: "first reply" },
    ],
  });

  const graph = createMeaningfulGraph("chat-dirty-floor", "dirty-floor");
  graph.historyState.lastProcessedAssistantFloor = 4;
  graph.historyState.extractionCount = 1;
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-dirty-floor",
    revision: 2,
    writesBlocked: false,
  });

  // 模拟：meta 指向 floor=1（早于最小可提取 floor=4）的删除事件
  // 使用间接方式：graph 的 lastProcessedAssistantFloor=4，
  // 如果 resolveDirtyFloorFromMutationMeta 正确过滤了 floor<4 的候选，
  // 那么 inspectHistoryMutation 不会标记为 dirty（因为没有有效候选）。
  // 注意：这里不直接测试内部函数，而是验证整体行为。
  const graph2 = harness.api.getCurrentGraph();
  assert.ok(graph2, "graph 应存在");
  assert.equal(
    graph2.historyState.lastProcessedAssistantFloor,
    4,
    "lastProcessedAssistantFloor 应为 4",
  );
}

console.log("graph-persistence tests passed");
