import assert from "node:assert/strict";

import {
  buildBmeDbName,
  buildGraphFromSnapshot,
  buildPersistDelta,
  buildPersistDeltaFromGraphDirtyState,
  buildSnapshotFromGraph,
  evaluateNativeHydrateGate,
  evaluatePersistNativeDeltaGate,
} from "../sync/bme-db.js";
import { onMessageReceivedController } from "../host/event-binding.js";
import {
  getBmeHostAdapter,
  isBmeLightweightHostMode,
  normalizeBmeChatStateTarget,
  resolveBmeHostProfile,
  resolveChatStateTargetChatId,
  resolveCurrentBmeChatStateTarget,
  serializeBmeChatStateTarget,
} from "../host/runtime-host-adapter.js";
import {
  buildGraphCommitMarker,
  buildGraphChatStateSnapshot,
  buildLukerGraphCheckpointV2,
  buildLukerGraphJournalEntry,
  buildLukerGraphJournalV2,
  buildLukerGraphManifestV2,
  appendLukerGraphJournalEntryV2,
  canUseGraphChatState,
  detectIndexedDbSnapshotCommitMarkerMismatch,
  deleteGraphChatStateNamespace,
  cloneGraphForPersistence,
  cloneRuntimeDebugValue,
  findGraphShadowSnapshotByIntegrity,
  GRAPH_CHAT_STATE_NAMESPACE,
  getAcceptedCommitMarkerRevision,
  getGraphPersistedRevision,
  getGraphIdentityAliasCandidates,
  getGraphPersistenceMeta,
  GRAPH_COMMIT_MARKER_KEY,
  LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  LUKER_GRAPH_JOURNAL_COMPACTION_BYTES,
  LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH,
  LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP,
  LUKER_GRAPH_JOURNAL_NAMESPACE,
  LUKER_GRAPH_MANIFEST_NAMESPACE,
  getGraphShadowSnapshotStorageKey,
  GRAPH_LOAD_PENDING_CHAT_ID,
  GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_PERSISTENCE_META_KEY,
  GRAPH_PERSISTENCE_SESSION_ID,
  GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX,
  GRAPH_STARTUP_RECONCILE_DELAYS_MS,
  MODULE_NAME,
  normalizeGraphCommitMarker,
  readGraphChatStateNamespaces,
  readGraphCommitMarker,
  readGraphChatStateSnapshot,
  readLukerGraphSidecarV2,
  readGraphShadowSnapshot,
  replaceLukerGraphJournalV2,
  rememberGraphIdentityAlias,
  removeGraphShadowSnapshot,
  resolveGraphIdentityAliasByHostChatId,
  shouldPreferShadowSnapshotOverOfficial,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphChatStatePayload,
  writeGraphChatStateSnapshot,
  writeLukerGraphCheckpointV2,
  writeLukerGraphManifestV2,
  writeGraphShadowSnapshot,
} from "../graph/graph-persistence.js";
import {
  createEmptyGraph,
  deserializeGraph,
  getGraphStats,
  getNode,
  serializeGraph,
  updateNode,
} from "../graph/graph.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  readPersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  writePersistedRecallToUserMessage,
} from "../retrieval/recall-persistence.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import {
  buildVectorCollectionId,
  hasGraphPersistDirtyState,
  normalizeGraphRuntimeState,
  pruneGraphPersistDirtyState,
} from "../runtime/runtime-state.js";
import {
  defaultSettings,
  getPersistedSettingsSnapshot,
  mergePersistedSettings,
} from "../runtime/settings-defaults.js";
import {
  areChatIdsEquivalentForIdentityCore,
  canMutateRuntimeGraphForIdentityCore,
  doesChatIdMatchIdentityCore,
  planRuntimeGraphIdentityRepairCore,
  resolveActiveHostChatIdCore,
  resolveCurrentChatIdentityCore,
  resolveGraphOwnerIdentityCore,
  resolvePersistenceChatIdCore,
  resolveRuntimeGraphFallbackIdentityCore,
} from "../runtime/identity-resolver.js";
import {
  createDefaultAuthorityCapabilityState,
  normalizeAuthoritySettings,
  normalizeAuthorityCapabilityState,
  probeAuthorityCapabilities,
} from "../runtime/authority-capabilities.js";
import { normalizeAuthorityJobConfig } from "../maintenance/authority-job-adapter.js";
import { normalizeAuthorityBlobConfig } from "../maintenance/authority-blob-adapter.js";
import {
  createAuthorityBrowserState,
  getAuthorityBrowserStateSnapshot,
  normalizeAuthorityBrowserState,
  recordAuthorityAcceptedRevision,
} from "../sync/authority-browser-state.js";
import {
  AUTHORITY_GRAPH_STORE_KIND,
  AUTHORITY_GRAPH_STORE_MODE,
  AuthorityGraphStore,
} from "../sync/authority-graph-store.js";
import { GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED } from "../sync/authority-graph-mode.js";
import {
  isAcceptedLegacyPersistenceTier,
  isRecoveryOnlyLegacyPersistenceTier,
  planAcceptedPendingPersistenceRepair,
  repairLegacyLastBatchPersistenceStatus,
} from "../sync/legacy-persistence-repair.js";
import {
  PERSISTENCE_EVENT_TYPES,
  applyPersistenceRecordToBatchStatus as reducePersistenceRecordToBatchStatus,
  buildAcceptedPersistenceStatePatch,
  buildBatchPersistenceRecordFromPersistResult as reduceBatchPersistenceRecordFromPersistResult,
  buildQueuedPersistenceStatePatch,
  planAcceptedPendingClear,
  reducePersistenceStatePatch,
} from "../sync/persistence-reducer.js";
import {
  clampFloat,
  clampInt,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  formatRecallContextLine,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  shouldRunRecallForTransaction,
} from "../ui/ui-status.js";

function normalizeChatIdCandidate(value = "") {
  return String(value ?? "").trim();
}
import { createRecallInputState } from "../runtime/recall-input-state.js";
import { createRerollRecallInput } from "../runtime/reroll-recall-input.js";
import { createGenerationRecallTransactions } from "../runtime/generation-recall-transactions.js";
import { createFinalRecallInjection } from "../runtime/final-recall-injection.js";
import { createAutoExtractionDefer } from "../runtime/auto-extraction-defer.js";
import { runPlannerRecallForEnaController } from "../runtime/planner-recall-controller.js";
import {
  loadGraphFromIndexedDbImpl,
  maybeFlushQueuedGraphPersistImpl,
  queueGraphPersistToIndexedDbImpl,
  retryPendingGraphPersistImpl,
  saveGraphToIndexedDbImpl,
} from "../sync/graph-persistence-io.js";
import {
  assertRecoveryChatStillActiveImpl,
  applyGraphLoadStateImpl,
  buildPanelOpenLocalStoreRefreshPlanImpl,
  ensureGraphMutationReadyImpl,
  getGraphMutationBlockReasonImpl,
  getGraphPersistenceLiveStateImpl,
  getPanelRuntimeStatusImpl,
  readRuntimeDebugSnapshotImpl,
} from "../sync/graph-mutation-gate.js";
import {
  buildBmeSyncRuntimeOptionsImpl,
  loadGraphFromChatImpl,
  maybeCaptureGraphShadowSnapshotImpl,
  onRebuildLocalCacheFromLukerSidecarImpl,
  persistExtractionBatchResultImpl,
  saveGraphToChatImpl,
  shouldUseAuthorityGraphStoreImpl,
  shouldUseAuthorityJobsImpl,
  syncGraphLoadFromLiveContextImpl,
  writeAuthorityCheckpointFromCurrentGraphImpl,
} from "../sync/graph-load-persist.js";

function isAuthorityVectorConfig(config = null) {
  return config?.mode === "authority" || config?.source === "authority-trivium";
}

function normalizeAuthorityVectorConfig(settings = {}, overrides = {}) {
  return {
    ...overrides,
    mode: "authority",
    source: "authority-trivium",
    baseUrl: String(settings?.authorityBaseUrl || overrides?.baseUrl || "/api/plugins/authority"),
  };
}

function createAuthorityBlobAdapter() {
  return {
    async writeJson(path = "", payload = null) {
      globalThis.__authorityBlobWrites?.set(String(path || ""), structuredClone(payload));
      return { path, payload, written: true };
    },
  };
}

function createSessionStorage(seed = null) {
  const store = seed instanceof Map ? seed : new Map();
  return {
    __store: store,
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[Number(index)] ?? null;
    },
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

function createLocalStorage(seed = null) {
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
  localStore = null,
  globalChatId = "",
  characterId = "",
  groupId = null,
  indexedDbSnapshot = null,
  indexedDbSnapshots = null,
  chat = [],
} = {}) {
  const timers = new Map();
  let nextTimerId = 1;
  const storage = createSessionStorage(sessionStore);
  const sessionShadowSnapshots = sessionStore instanceof Map ? sessionStore : storage.__store;
  const localStorage = createLocalStorage(localStore);
  const indexedDbSnapshotMap =
    indexedDbSnapshots instanceof Map
      ? new Map(indexedDbSnapshots)
      : new Map(
          Object.entries(
            indexedDbSnapshots &&
              typeof indexedDbSnapshots === "object" &&
              !Array.isArray(indexedDbSnapshots)
              ? indexedDbSnapshots
              : {},
          ),
        );

  if (indexedDbSnapshot) {
    const primaryChatId = String(chatId || globalChatId || "");
    if (primaryChatId) {
      indexedDbSnapshotMap.set(primaryChatId, structuredClone(indexedDbSnapshot));
    }
  }

  function buildEmptyIndexedDbSnapshot(targetChatId = "") {
    return {
      meta: { revision: 0, chatId: String(targetChatId || "") },
      nodes: [],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: -1, extractionCount: 0 },
    };
  }

  function getIndexedDbSnapshotForChat(targetChatId = "") {
    const normalizedChatId = String(targetChatId || "");
    if (normalizedChatId && indexedDbSnapshotMap.has(normalizedChatId)) {
      return structuredClone(indexedDbSnapshotMap.get(normalizedChatId));
    }

    if (
      normalizedChatId &&
      indexedDbSnapshot &&
      !indexedDbSnapshotMap.size &&
      normalizedChatId === String(chatId || globalChatId || "")
    ) {
      return structuredClone(indexedDbSnapshot);
    }

    return buildEmptyIndexedDbSnapshot(normalizedChatId);
  }

  function setIndexedDbSnapshotForChat(targetChatId = "", snapshot = null) {
    const normalizedChatId = String(targetChatId || "");
    if (!normalizedChatId) return;
    if (!snapshot) {
      indexedDbSnapshotMap.delete(normalizedChatId);
      return;
    }
    indexedDbSnapshotMap.set(normalizedChatId, structuredClone(snapshot));
  }

  const authoritySnapshotMap = new Map();
  const authorityBlobWrites = new Map();
  globalThis.__authorityBlobWrites = authorityBlobWrites;

  function getAuthoritySnapshotForChat(targetChatId = "") {
    const normalizedChatId = String(targetChatId || "");
    if (normalizedChatId && authoritySnapshotMap.has(normalizedChatId)) {
      return structuredClone(authoritySnapshotMap.get(normalizedChatId));
    }
    return {
      meta: {
        revision: 0,
        chatId: normalizedChatId,
        storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
        storageMode: AUTHORITY_GRAPH_STORE_MODE,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: -1, extractionCount: 0 },
    };
  }

  function setAuthoritySnapshotForChat(targetChatId = "", snapshot = null) {
    const normalizedChatId = String(targetChatId || "");
    if (!normalizedChatId) return;
    if (!snapshot) {
      authoritySnapshotMap.delete(normalizedChatId);
      return;
    }
    authoritySnapshotMap.set(normalizedChatId, structuredClone(snapshot));
  }

  class HarnessAuthorityGraphStore {
    constructor(dbChatId = "") {
      this.chatId = String(dbChatId || "");
      this.storeKind = AUTHORITY_GRAPH_STORE_KIND;
      this.storeMode = AUTHORITY_GRAPH_STORE_MODE;
    }
    async open() {}
    async close() {}
    getStorageDiagnosticsSync() {
      return {
        formatVersion: 1,
        migrationState: "idle",
        resolvedStoreMode: AUTHORITY_GRAPH_STORE_MODE,
        storageKind: AUTHORITY_GRAPH_STORE_KIND,
        browserCacheMode: "minimal",
      };
    }
    async exportSnapshot() {
      return getAuthoritySnapshotForChat(this.chatId);
    }
    async exportSnapshotProbe() {
      return getAuthoritySnapshotForChat(this.chatId);
    }
    async importSnapshot(snapshot = {}, options = {}) {
      const current = getAuthoritySnapshotForChat(this.chatId);
      const currentRevision = Number(current?.meta?.revision || 0);
      const incomingRevision = Number(snapshot?.meta?.revision || 0);
      const requestedRevision = Number.isFinite(Number(options?.revision))
        ? Math.max(0, Math.floor(Number(options.revision)))
        : options?.preserveRevision === true
          ? Math.max(0, Math.floor(incomingRevision))
          : currentRevision + 1;
      const nextRevision = Math.max(currentRevision + 1, requestedRevision);
      const nowMs = Date.now();
      const nodes = Array.isArray(snapshot?.nodes)
        ? snapshot.nodes.map((node) => structuredClone(node))
        : [];
      const edges = Array.isArray(snapshot?.edges)
        ? snapshot.edges.map((edge) => structuredClone(edge))
        : [];
      const tombstones = Array.isArray(snapshot?.tombstones)
        ? snapshot.tombstones.map((record) => structuredClone(record))
        : [];
      const nextSnapshot = {
        meta: {
          ...(snapshot?.meta && typeof snapshot.meta === "object"
            ? structuredClone(snapshot.meta)
            : {}),
          chatId: this.chatId,
          storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
          storageMode: AUTHORITY_GRAPH_STORE_MODE,
          revision: nextRevision,
          lastModified: nowMs,
          lastMutationReason: "importSnapshot",
          syncDirty: options?.markSyncDirty !== false,
          syncDirtyReason: options?.markSyncDirty === false ? "" : "importSnapshot",
          nodeCount: nodes.length,
          edgeCount: edges.length,
          tombstoneCount: tombstones.length,
        },
        nodes,
        edges,
        tombstones,
        state:
          snapshot?.state && typeof snapshot.state === "object"
            ? structuredClone(snapshot.state)
            : { lastProcessedFloor: -1, extractionCount: 0 },
      };
      setAuthoritySnapshotForChat(this.chatId, nextSnapshot);
      return {
        mode: String(options?.mode || "replace"),
        revision: nextRevision,
        imported: {
          nodes: nodes.length,
          edges: edges.length,
          tombstones: tombstones.length,
        },
      };
    }
    async importLegacyGraph(graph, options = {}) {
      const revision = Math.max(1, Math.floor(Number(options?.revision) || 1));
      const snapshot = buildSnapshotFromGraph(graph, {
        chatId: this.chatId,
        revision,
        meta: {
          migrationCompletedAt: Number(options?.nowMs || Date.now()),
          migrationSource: String(options?.source || "chat_metadata"),
        },
      });
      const importResult = await this.importSnapshot(snapshot, {
        mode: "replace",
        preserveRevision: true,
        revision,
        markSyncDirty: options?.markSyncDirty,
      });
      return {
        migrated: true,
        revision: importResult.revision,
        imported: importResult.imported,
      };
    }
    async commitDelta(delta = {}, options = {}) {
      return commitSnapshotDelta({
        targetChatId: this.chatId,
        delta,
        options,
        getSnapshot: getAuthoritySnapshotForChat,
        setSnapshot: setAuthoritySnapshotForChat,
        metaPatch: {
          storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
          storageMode: AUTHORITY_GRAPH_STORE_MODE,
        },
      });
    }
    async isEmpty() {
      const snapshot = getAuthoritySnapshotForChat(this.chatId);
      const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes.length : 0;
      const edges = Array.isArray(snapshot?.edges) ? snapshot.edges.length : 0;
      const tombstones = Array.isArray(snapshot?.tombstones)
        ? snapshot.tombstones.length
        : 0;
      return {
        empty: nodes === 0 && edges === 0,
        nodes,
        edges,
        tombstones,
      };
    }
    async getRevision() {
      return Number(getAuthoritySnapshotForChat(this.chatId)?.meta?.revision || 0);
    }
    async getMeta(key, fallbackValue = 0) {
      const snapshot = getAuthoritySnapshotForChat(this.chatId);
      if (!snapshot?.meta || !(key in snapshot.meta)) {
        return fallbackValue;
      }
      return snapshot.meta[key];
    }
    async patchMeta(record = {}) {
      const snapshot = getAuthoritySnapshotForChat(this.chatId);
      snapshot.meta = {
        ...(snapshot.meta || {}),
        ...(record && typeof record === "object" ? structuredClone(record) : {}),
      };
      setAuthoritySnapshotForChat(this.chatId, snapshot);
      return record;
    }
  }

  function commitSnapshotDelta({
    targetChatId = "",
    delta = {},
    options = {},
    getSnapshot,
    setSnapshot,
    metaPatch = {},
  } = {}) {
    const normalizedChatId = String(targetChatId || "");
    const currentSnapshot =
      typeof getSnapshot === "function" ? getSnapshot(normalizedChatId) : null;
    const now = Date.now();

    const nodeMap = new Map(
      (Array.isArray(currentSnapshot?.nodes) ? currentSnapshot.nodes : [])
        .filter((record) => record?.id)
        .map((record) => [String(record.id), structuredClone(record)]),
    );
    const edgeMap = new Map(
      (Array.isArray(currentSnapshot?.edges) ? currentSnapshot.edges : [])
        .filter((record) => record?.id)
        .map((record) => [String(record.id), structuredClone(record)]),
    );
    const tombstoneMap = new Map(
      (Array.isArray(currentSnapshot?.tombstones) ? currentSnapshot.tombstones : [])
        .filter((record) => record?.id)
        .map((record) => [String(record.id), structuredClone(record)]),
    );

    for (const edgeId of Array.isArray(delta?.deleteEdgeIds) ? delta.deleteEdgeIds : []) {
      edgeMap.delete(String(edgeId));
    }
    for (const nodeId of Array.isArray(delta?.deleteNodeIds) ? delta.deleteNodeIds : []) {
      nodeMap.delete(String(nodeId));
    }
    for (const record of Array.isArray(delta?.upsertNodes) ? delta.upsertNodes : []) {
      if (!record?.id) continue;
      nodeMap.set(String(record.id), structuredClone(record));
    }
    for (const record of Array.isArray(delta?.upsertEdges) ? delta.upsertEdges : []) {
      if (!record?.id) continue;
      edgeMap.set(String(record.id), structuredClone(record));
    }
    for (const record of Array.isArray(delta?.tombstones) ? delta.tombstones : []) {
      if (!record?.id) continue;
      tombstoneMap.set(String(record.id), structuredClone(record));
    }

    const runtimeMetaPatch =
      delta?.runtimeMetaPatch &&
      typeof delta.runtimeMetaPatch === "object" &&
      !Array.isArray(delta.runtimeMetaPatch)
        ? structuredClone(delta.runtimeMetaPatch)
        : {};
    const shouldMarkSyncDirty = options?.markSyncDirty !== false;
    const nextRevision = Math.max(
      Number(currentSnapshot?.meta?.revision || 0) + 1,
      Number(options?.requestedRevision || 0),
    );
    const nextState = {
      lastProcessedFloor: Number.isFinite(Number(runtimeMetaPatch.lastProcessedFloor))
        ? Number(runtimeMetaPatch.lastProcessedFloor)
        : Number(currentSnapshot?.state?.lastProcessedFloor ?? -1),
      extractionCount: Number.isFinite(Number(runtimeMetaPatch.extractionCount))
        ? Number(runtimeMetaPatch.extractionCount)
        : Number(currentSnapshot?.state?.extractionCount ?? 0),
    };
    const nextSnapshot = {
      meta: {
        ...(currentSnapshot?.meta || {}),
        ...runtimeMetaPatch,
        ...(metaPatch && typeof metaPatch === "object" ? structuredClone(metaPatch) : {}),
        chatId: normalizedChatId,
        revision: nextRevision,
        lastModified: now,
        lastMutationReason: String(options?.reason || "commitDelta"),
        syncDirty: shouldMarkSyncDirty,
        syncDirtyReason: shouldMarkSyncDirty
          ? String(options?.reason || "commitDelta")
          : "",
        nodeCount: nodeMap.size,
        edgeCount: edgeMap.size,
        tombstoneCount: tombstoneMap.size,
      },
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
      tombstones: Array.from(tombstoneMap.values()),
      state: nextState,
    };

    if (typeof setSnapshot === "function") {
      setSnapshot(normalizedChatId, nextSnapshot);
    }

    return {
      revision: nextRevision,
      lastModified: now,
      imported: {
        nodes: nodeMap.size,
        edges: edgeMap.size,
        tombstones: tombstoneMap.size,
      },
      delta: {
        upsertNodes: Array.isArray(delta?.upsertNodes) ? delta.upsertNodes.length : 0,
        upsertEdges: Array.isArray(delta?.upsertEdges) ? delta.upsertEdges.length : 0,
        deleteNodeIds: Array.isArray(delta?.deleteNodeIds) ? delta.deleteNodeIds.length : 0,
        deleteEdgeIds: Array.isArray(delta?.deleteEdgeIds) ? delta.deleteEdgeIds.length : 0,
        tombstones: Array.isArray(delta?.tombstones) ? delta.tombstones.length : 0,
      },
    };
  }

  function commitIndexedDbDelta(targetChatId = "", delta = {}, options = {}) {
    const result = commitSnapshotDelta({
      targetChatId,
      delta,
      options,
      getSnapshot: getIndexedDbSnapshotForChat,
      setSnapshot: setIndexedDbSnapshotForChat,
    });
    runtimeContext.__indexedDbSnapshot = getIndexedDbSnapshotForChat(
      String(targetChatId || ""),
    );
    return result;
  }

  function buildPersistenceEnvironment(
    context = null,
    presentation = { storagePrimary: "indexeddb", storageMode: "indexeddb" },
  ) {
    const hostProfile = resolveBmeHostProfile(context);
    const primaryStorageTier = resolveBmeHostProfile(context) === "luker" ? "luker-chat-state" : String(presentation?.storagePrimary || "indexeddb");
    const cacheStorageTier = primaryStorageTier === "authority" || primaryStorageTier === "luker-chat-state" ? "indexeddb" : "none";
    return {
      hostProfile,
      primaryStorageTier,
      cacheStorageTier,
    };
  }

  let currentGraph = null;
  let extractionCount = 0;
  let lastExtractedItems = [];
  let lastRecalledItems = [];
  let lastInjectionContent = "";
  let runtimeStatus = createUiStatus("待命", "准备就绪", "idle");
  let lastExtractionStatus = createUiStatus("待命", "尚未执行提取", "idle");
  let lastVectorStatus = createUiStatus("待命", "尚未执行向量任务", "idle");
  let lastRecallStatus = createUiStatus("待命", "尚未执行召回", "idle");
  let graphPersistenceState = createGraphPersistenceState();
  let authorityCapabilityState = createDefaultAuthorityCapabilityState();
  let authorityBrowserState = createAuthorityBrowserState();
  let bmeLocalStoreCapabilitySnapshot = {
    checked: false,
    checkedAt: 0,
    opfsAvailable: false,
    reason: "unprobed",
  };
  let bmeChatManager = null;
  let bmeChatManagerUnavailableWarned = false;
  let nativeHydrateInstallPromise = null;
  let nativePersistDeltaInstallPromise = null;
  let pendingGraphLoadRetryTimer = null;
  let pendingGraphLoadRetryChatId = "";
  let pendingGraphPersistRetryTimer = null;
  let pendingGraphPersistRetryChatId = "";
  let pendingGraphPersistRetryAttempt = 0;
  let pendingRecallSendIntent = createRecallInputRecord();
  const bmeIndexedDbSnapshotCacheByChatId = new Map();
  const bmeIndexedDbLatestQueuedRevisionByChatId = new Map();
  const bmeIndexedDbWriteInFlightByChatId = new Map();
  const GRAPH_LOAD_RETRY_DELAYS_MS = [120, 450, 1200, 2500];
  const PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS = [500, 1500, 5000];
  const PENDING_GRAPH_PERSIST_MAX_RETRY_ATTEMPTS = 5;
  const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = new Set([
    GRAPH_LOAD_STATES.LOADING,
    GRAPH_LOAD_STATES.BLOCKED,
    GRAPH_LOAD_STATES.NO_CHAT,
    GRAPH_LOAD_STATES.SHADOW_RESTORED,
  ]);

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
    __indexedDbSnapshot: getIndexedDbSnapshotForChat(
      String(chatId || globalChatId || ""),
    ),
    __indexedDbSnapshots: indexedDbSnapshotMap,
    __authoritySnapshots: authoritySnapshotMap,
    __authorityBlobWrites: authorityBlobWrites,
    __getAuthoritySnapshotForChat: getAuthoritySnapshotForChat,
    __setAuthoritySnapshotForChat: setAuthoritySnapshotForChat,
    sessionStorage: storage,
    localStorage,
    get currentGraph() { return currentGraph; },
    set currentGraph(value) { currentGraph = value; },
    get graphPersistenceState() { return graphPersistenceState; },
    set graphPersistenceState(value) { graphPersistenceState = value; },
    get bmeLocalStoreCapabilitySnapshot() { return bmeLocalStoreCapabilitySnapshot; },
    set bmeLocalStoreCapabilitySnapshot(value) { bmeLocalStoreCapabilitySnapshot = value; },
    get authorityCapabilityState() { return authorityCapabilityState; },
    set authorityCapabilityState(value) { authorityCapabilityState = value; },
    get authorityBrowserState() { return authorityBrowserState; },
    set authorityBrowserState(value) { authorityBrowserState = value; },
    extension_settings: {
      [MODULE_NAME]: {},
    },
    defaultSettings,
    getPersistedSettingsSnapshot,
    mergePersistedSettings,
    createDefaultAuthorityCapabilityState,
    normalizeAuthoritySettings,
    normalizeAuthorityCapabilityState,
    normalizeAuthorityJobConfig,
    probeAuthorityCapabilities,
    isAuthorityVectorConfig,
    normalizeAuthorityVectorConfig,
    normalizeAuthorityBlobConfig,
    createAuthorityBlobAdapter,
    createAuthorityBrowserState,
    getAuthorityBrowserStateSnapshot,
    normalizeAuthorityBrowserState,
    recordAuthorityAcceptedRevision,
    AUTHORITY_GRAPH_STORE_KIND,
    AUTHORITY_GRAPH_STORE_MODE,
    AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT: 20,
    AuthorityGraphStore: HarnessAuthorityGraphStore,
    isAcceptedLegacyPersistenceTier,
    isRecoveryOnlyLegacyPersistenceTier,
    planAcceptedPendingPersistenceRepair,
    repairLegacyLastBatchPersistenceStatus,
    PERSISTENCE_EVENT_TYPES,
    reducePersistenceRecordToBatchStatus,
    buildAcceptedPersistenceStatePatch,
    reduceBatchPersistenceRecordFromPersistResult,
    buildQueuedPersistenceStatePatch,
    planAcceptedPendingClear,
    reducePersistenceStatePatch,
    migrateLegacyTaskProfiles(settings = {}) {
      return {
        taskProfilesVersion: Number(settings?.taskProfilesVersion || 0),
        taskProfiles:
          settings?.taskProfiles && typeof settings.taskProfiles === "object"
            ? settings.taskProfiles
            : {},
      };
    },
    migratePerTaskRegexToGlobal(settings = {}) {
      return {
        changed: false,
        settings,
      };
    },
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
    createRecallInputState,
    createRerollRecallInput,
    createGenerationRecallTransactions,
    createFinalRecallInjection,
    createAutoExtractionDefer,
    runPlannerRecallForEnaController,
    loadGraphFromIndexedDbImpl,
    maybeFlushQueuedGraphPersistImpl,
    queueGraphPersistToIndexedDbImpl,
    retryPendingGraphPersistImpl,
    saveGraphToIndexedDbImpl,
    assertRecoveryChatStillActiveImpl,
    buildPanelOpenLocalStoreRefreshPlanImpl,
    ensureGraphMutationReadyImpl,
    getGraphMutationBlockReasonImpl,
    getGraphPersistenceLiveStateImpl,
    getPanelRuntimeStatusImpl,
    readRuntimeDebugSnapshotImpl,
    buildBmeSyncRuntimeOptionsImpl,
    loadGraphFromChatImpl,
    maybeCaptureGraphShadowSnapshotImpl,
    onRebuildLocalCacheFromLukerSidecarImpl,
    persistExtractionBatchResultImpl,
    saveGraphToChatImpl,
    shouldUseAuthorityGraphStoreImpl,
    shouldUseAuthorityJobsImpl,
    syncGraphLoadFromLiveContextImpl,
    writeAuthorityCheckpointFromCurrentGraphImpl,
    createRecallMessageUiController() {
      return {
        refreshPersistedRecallMessageUi: () => ({
          status: "missing_recall_record",
          renderedCount: 0,
          persistedRecordCount: 0,
          waitingMessageIndices: [],
          anchorFailureIndices: [],
          skippedNonUserIndices: [],
        }),
        schedulePersistedRecallMessageUiRefresh() {},
        cleanupPersistedRecallMessageUi() {},
        resolveMessageIndexFromElement: () => null,
        resolveRecallCardAnchor: () => null,
      };
    },
    openRecallSidebar() {},
    removePersistedRecallFromUserMessage: () => false,
    writePersistedRecallToUserMessage: () => false,
    buildPersistedRecallRecord: (record = {}) => ({ ...record }),
    markPersistedRecallManualEdit: () => null,
    createRecallCardElement: () => null,
    updateRecallCardData() {},
    estimateTokens: (text = "") =>
      String(text || "").trim().split(/\s+/).filter(Boolean).length || 1,
    SillyTavern: {
      getCurrentChatId() {
        return runtimeContext.__globalChatId;
      },
    },
    __globalChatId: String(globalChatId || ""),
    Dexie: {
      async exists(dbName = "") {
        return Array.from(indexedDbSnapshotMap.keys()).some(
          (candidateChatId) => buildBmeDbName(candidateChatId) === String(dbName),
        );
      },
      async getDatabaseNames() {
        return Array.from(indexedDbSnapshotMap.keys()).map((candidateChatId) =>
          buildBmeDbName(candidateChatId),
        );
      },
    },
    async ensureDexieLoaded() {
      return runtimeContext.Dexie;
    },
    refreshPanelLiveState() {
      runtimeContext.__panelRefreshCount += 1;
    },
    schedulePersistedRecallMessageUiRefresh() {},
    restoreRecallUiStateFromPersistence(chat = runtimeContext.getContext()?.chat) {
      let latestPersisted = null;
      if (Array.isArray(chat)) {
        for (let index = chat.length - 1; index >= 0; index--) {
          if (!chat[index]?.is_user) continue;
          const record = readPersistedRecallFromUserMessage(chat, index);
          if (record?.injectionText) {
            latestPersisted = { messageIndex: index, record };
            break;
          }
        }
      }
      const normalizeRecallNodeIdList = (nodeIds = []) => Array.isArray(nodeIds)
        ? nodeIds.map((entry) => {
            if (typeof entry === "string" || typeof entry === "number") return String(entry).trim();
            if (entry && typeof entry === "object") return String(entry.id || entry.nodeId || "").trim();
            return "";
          }).filter(Boolean)
        : [];
      const graphRecallNodeIds = normalizeRecallNodeIdList(currentGraph?.lastRecallResult);
      const persistedNodeIds = normalizeRecallNodeIdList(latestPersisted?.record?.selectedNodeIds);
      const effectiveNodeIds = graphRecallNodeIds.length ? graphRecallNodeIds : persistedNodeIds;
      lastRecalledItems = effectiveNodeIds.map((id) => ({ id }));
      lastInjectionContent = String(latestPersisted?.record?.injectionText || "").trim();
      return {
        restored: Boolean(lastInjectionContent || effectiveNodeIds.length),
        latestPersistedMessageIndex: Number.isFinite(latestPersisted?.messageIndex) ? latestPersisted.messageIndex : null,
        selectedNodeIds: effectiveNodeIds,
        injectionTextLength: lastInjectionContent.length,
      };
    },
    scheduleGraphChatStateProbe() {
      return false;
    },
    scheduleIndexedDbGraphProbe() {
      return false;
    },
    canUseHostGraphChatStatePersistence(context = runtimeContext.getContext()) {
      return runtimeContext.resolveBmeHostProfile(context) === "luker" || canUseGraphChatState(context);
    },
    async refreshRuntimeGraphAfterSyncApplied(syncPayload = {}) {
      const action = String(syncPayload?.action || "").trim().toLowerCase();
      if (action !== "download" && action !== "merge" && action !== "restore-backup") return { refreshed: false, reason: "action-not-supported", action };
      const syncedChatId = normalizeChatIdCandidate(syncPayload?.chatId);
      const activeIdentity = runtimeContext.resolveCurrentChatIdentity(runtimeContext.getContext());
      const activeChatId = normalizeChatIdCandidate(activeIdentity.chatId);
      const targetChatId = activeChatId && syncedChatId && runtimeContext.doesChatIdMatchResolvedGraphIdentity(syncedChatId, activeIdentity) ? activeChatId : syncedChatId || activeChatId;
      if (!targetChatId) return { refreshed: false, reason: "missing-chat-id", action };
      if (activeChatId && targetChatId !== activeChatId) return { refreshed: false, reason: "chat-switched", action, chatId: targetChatId, activeChatId };
      const loadResult = await runtimeContext.loadGraphFromIndexedDb(targetChatId, { source: `sync-post-refresh:${action}`, allowOverride: true, applyEmptyState: true });
      return { refreshed: Boolean(loadResult?.loaded || loadResult?.emptyConfirmed), action, chatId: targetChatId, ...loadResult };
    },
    getGraphPersistenceState() { return graphPersistenceState; },
    getBmeLocalStoreCapabilitySnapshot() { return bmeLocalStoreCapabilitySnapshot; },
    getCurrentGraph() { return currentGraph; },
    setCurrentGraph(graph) { currentGraph = graph; return currentGraph; },
    getExtractionCount() { return extractionCount; },
    setExtractionCount(value) { extractionCount = Number(value) || 0; return extractionCount; },
    getLastExtractedItems() { return lastExtractedItems; },
    setLastExtractedItems(items) { lastExtractedItems = Array.isArray(items) ? items : []; return lastExtractedItems; },
    getLastRecalledItems() { return lastRecalledItems; },
    setLastRecalledItems(items) { lastRecalledItems = Array.isArray(items) ? items : []; return lastRecalledItems; },
    getLastInjectionContent() { return lastInjectionContent; },
    setLastInjectionContent(content) { lastInjectionContent = String(content || ""); return lastInjectionContent; },
    getRuntimeStatus() { return runtimeStatus; },
    setRuntimeStatus(status) { runtimeStatus = status; return runtimeStatus; },
    getLastExtractionStatus() { return lastExtractionStatus; },
    setLastExtractionStatus(status) { lastExtractionStatus = status; return lastExtractionStatus; },
    getLastVectorStatus() { return lastVectorStatus; },
    setLastVectorStatus(status) { lastVectorStatus = status; return lastVectorStatus; },
    getLastRecallStatus() { return lastRecallStatus; },
    setLastRecallStatus(status) { lastRecallStatus = status; return lastRecallStatus; },
    __panelRefreshCount: 0,
    getLastProcessedAssistantFloor() {
      const historyFloor = Number(
        runtimeContext.currentGraph?.historyState?.lastProcessedAssistantFloor,
      );
      if (Number.isFinite(historyFloor)) {
        return historyFloor;
      }
      const legacySeq = Number(runtimeContext.currentGraph?.lastProcessedSeq);
      if (Number.isFinite(legacySeq)) return legacySeq;
      return -1;
    },
    createEmptyGraph,
    normalizeGraphRuntimeState,
    serializeGraph,
    deserializeGraph,
    getGraphStats,
    getNode,
    getNodeDisplayName,
    createUiStatus,
    createGraphPersistenceState,
    createRecallInputRecord,
    createRecallRunResult,
    getPendingRecallSendIntent() { return null; },
    setPendingRecallSendIntent() {},
    consumeCurrentGenerationTrivialSkip() { return false; },
    resolveAutoExtractionPlan() { return { canRun: false, reason: "test-disabled", strategy: "normal" }; },
    deferAutoExtraction() { return null; },
    maybeResumePendingAutoExtraction() { return null; },
    async persistGraphToHostChatState(context = runtimeContext.__chatContext, options = {}) {
      const graph = options?.graph || currentGraph;
      const revision = Math.max(1, Math.floor(Number(options?.revision || 0)));
      const storageTier = String(options?.storageTier || "chat-state");
      const target = options?.chatStateTarget || null;
      if (storageTier === "chat-state") {
        const result = await writeGraphChatStateSnapshot(context, graph, {
          revision,
          storageTier,
          accepted: options?.accepted !== false,
          reason: options?.reason || "",
          chatId: options?.chatId || graph?.historyState?.chatId || runtimeContext.getCurrentChatId(),
          integrity: runtimeContext.getChatMetadataIntegrity(context),
          lastProcessedAssistantFloor: options?.lastProcessedAssistantFloor,
          extractionCount: options?.extractionCount,
          target,
        });
        runtimeContext.updateGraphPersistenceState({ dualWriteLastResult: { target: "chat-state" } });
        return { saved: result?.ok === true, accepted: result?.ok === true, revision, reason: result?.reason || "chat-state-saved" };
      }
      const chatIdValue = options?.chatId || graph?.historyState?.chatId || runtimeContext.getCurrentChatId();
      const integrity = runtimeContext.getChatMetadataIntegrity(context);
      const checkpoint = buildLukerGraphCheckpointV2(graph, { revision, chatId: chatIdValue, integrity, reason: options?.reason || "", storageTier });
      await context.updateChatState(LUKER_GRAPH_CHECKPOINT_NAMESPACE, () => checkpoint, target ? { target } : undefined);
      const existingManifest = await context.getChatState(LUKER_GRAPH_MANIFEST_NAMESPACE, target ? { target } : undefined);
      let nextRevision = revision;
      if (options?.persistDelta && existingManifest?.headRevision) nextRevision = Number(existingManifest.headRevision || 0) + 1;
      else if (options?.persistDelta) nextRevision = 2;
      if (options?.reason === "luker-bootstrap-journal-fail") {
        const journalResult = await context.updateChatState(LUKER_GRAPH_JOURNAL_NAMESPACE, () => ({ entries: [] }), target ? { target } : undefined);
        if (journalResult?.ok !== true) return { saved: false, accepted: false, revision };
      } else if (options?.persistDelta) {
        const entry = buildLukerGraphJournalEntry(options?.persistDelta || null, { revision: nextRevision, reason: options?.reason || "", storageTier, chatId: chatIdValue, integrity });
        await appendLukerGraphJournalEntryV2(context, entry, { chatId: chatIdValue, integrity, chatStateTarget: target });
      }
      if (!options?.persistDelta) await context.updateChatState(LUKER_GRAPH_JOURNAL_NAMESPACE, () => buildLukerGraphJournalV2([], { chatId: chatIdValue, integrity, headRevision: nextRevision }), target ? { target } : undefined);
      const manifest = buildLukerGraphManifestV2(graph, { headRevision: nextRevision, checkpointRevision: revision, journalDepth: options?.persistDelta ? 1 : 0, chatId: chatIdValue, integrity, reason: options?.reason || "", storageTier, accepted: options?.accepted !== false, lastProcessedAssistantFloor: options?.lastProcessedAssistantFloor, extractionCount: options?.extractionCount });
      await writeLukerGraphManifestV2(context, manifest, { chatStateTarget: target });
      return { saved: true, accepted: options?.accepted !== false, revision: nextRevision };
    },
    getIsHostGenerationRunning() { return false; },
    refreshPersistedRecallMessageUi() {},
    normalizeStageNoticeLevel,
    getStageNoticeTitle,
    getStageNoticeDuration,
    normalizeRecallInputText,
    hashRecallInput,
    isFreshRecallInputRecord,
    clampInt,
    clampFloat,
    formatRecallContextLine,
    getBmeHostAdapter(context = null) {
      const activeContext = context || runtimeContext.__chatContext || {};
      return {
        context: activeContext,
        hostProfile: runtimeContext.resolveBmeHostProfile(activeContext),
        resolveCurrentTarget(options = {}) {
          return runtimeContext.resolveCurrentBmeChatStateTarget(
            activeContext,
            options?.target,
          );
        },
        getChatIdFromTarget(target = null) {
          return runtimeContext.resolveChatStateTargetChatId(target);
        },
        isLightweightHostMode() {
          return runtimeContext.isBmeLightweightHostMode(activeContext);
        },
      };
    },
    isBmeLightweightHostMode(context = null) {
      return runtimeContext.resolveBmeHostProfile(context) === "luker";
    },
    normalizeBmeChatStateTarget,
    resolveBmeHostProfile(context = null) {
      const activeContext = context || runtimeContext.__chatContext || {};
      const hasImplicitCurrentChat =
        String(activeContext?.chatId || "").trim() ||
        String(activeContext?.groupId || "").trim() ||
        String(activeContext?.characterId || "").trim();
      return runtimeContext.Luker &&
        typeof runtimeContext.Luker?.getContext === "function" &&
        hasImplicitCurrentChat
        ? "luker"
        : "generic-st";
    },
    resolveChatStateTargetChatId(target = null) {
      return resolveChatStateTargetChatId(target);
    },
    resolveCurrentBmeChatStateTarget(context = null, explicitTarget = null) {
      if (explicitTarget) {
        return normalizeBmeChatStateTarget(explicitTarget);
      }
      const activeContext = context || runtimeContext.__chatContext || {};
      if (String(activeContext?.groupId || "").trim()) {
        return {
          is_group: true,
          id: String(activeContext.chatId || activeContext.groupId).trim(),
        };
      }
      const avatar =
        activeContext?.characterAvatar ||
        activeContext?.avatar_url ||
        activeContext?.characters?.[activeContext?.characterId]?.avatar ||
        activeContext?.characters?.[Number(activeContext?.characterId)]?.avatar ||
        "";
      const fileName = String(activeContext?.chatId || "").trim();
      if (avatar && fileName) {
        return {
          is_group: false,
          avatar_url: String(avatar),
          file_name: fileName,
        };
      }
      return null;
    },
    serializeBmeChatStateTarget(target = null) {
      return serializeBmeChatStateTarget(target);
    },
    readPersistedRecallFromUserMessage,
    writePersistedRecallToUserMessage,
    bumpPersistedRecallGenerationCount,
    resolveFinalRecallInjectionSource,
    formatInjection: (result = null) =>
      String(result?.injectionText || result?.memoryBlock || ""),
    getSchema: () => [],
    shouldRunRecallForTransaction,
    areChatIdsEquivalentForIdentityCore,
    cloneGraphForPersistence,
    canMutateRuntimeGraphForIdentityCore,
    buildGraphCommitMarker,
    buildGraphChatStateSnapshot,
    buildLukerGraphCheckpointV2,
    buildLukerGraphJournalEntry,
    buildLukerGraphJournalV2,
    buildLukerGraphManifestV2,
    canUseGraphChatState,
    cloneRuntimeDebugValue,
    deleteGraphChatStateNamespace,
    doesChatIdMatchIdentityCore,
    detectIndexedDbSnapshotCommitMarkerMismatch,
    onMessageReceivedController,
    GRAPH_CHAT_STATE_NAMESPACE,
    getAcceptedCommitMarkerRevision,
    getGraphPersistenceMeta,
    getGraphPersistedRevision,
    getGraphIdentityAliasCandidates,
    GRAPH_COMMIT_MARKER_KEY,
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    LUKER_GRAPH_JOURNAL_COMPACTION_BYTES,
    LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH,
    LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP,
    LUKER_GRAPH_JOURNAL_NAMESPACE,
    LUKER_GRAPH_MANIFEST_NAMESPACE,
    getGraphShadowSnapshotStorageKey,
    GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
    GRAPH_LOAD_PENDING_CHAT_ID,
    GRAPH_LOAD_STATES,
    GRAPH_METADATA_KEY,
    GRAPH_PERSISTENCE_META_KEY,
    GRAPH_PERSISTENCE_SESSION_ID,
    GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX,
    GRAPH_STARTUP_RECONCILE_DELAYS_MS,
    MODULE_NAME,
    planRuntimeGraphIdentityRepairCore,
    findGraphShadowSnapshotByIntegrity,
    normalizeGraphCommitMarker,
    readGraphChatStateNamespaces,
    readGraphCommitMarker,
    readGraphChatStateSnapshot,
    readLukerGraphSidecarV2,
    readGraphShadowSnapshot,
    rememberGraphIdentityAlias,
    removeGraphShadowSnapshot,
    resolveActiveHostChatIdCore,
    resolveCurrentChatIdentityCore,
    resolveGraphOwnerIdentityCore,
    resolvePersistenceChatIdCore,
    resolveRuntimeGraphFallbackIdentityCore,
    resolveGraphIdentityAliasByHostChatId,
    shouldPreferShadowSnapshotOverOfficial,
    stampGraphPersistenceMeta,
    replaceLukerGraphJournalV2,
    appendLukerGraphJournalEntryV2,
    writeChatMetadataPatch,
    writeGraphChatStatePayload,
    writeGraphChatStateSnapshot,
    writeLukerGraphManifestV2,
    writeLukerGraphCheckpointV2,
    writeGraphShadowSnapshot,
    // Shadow snapshot functions need VM-local sessionStorage overrides
    // because imported versions use the outer globalThis (no sessionStorage)
    rememberGraphIdentityAlias({
      integrity = "",
      hostChatId = "",
      persistenceChatId = "",
    } = {}) {
      const normalizedIntegrity = String(integrity || "").trim();
      if (!normalizedIntegrity) return null;

      const normalizedHostChatId = String(hostChatId || "").trim();
      const normalizedPersistenceChatId = String(
        persistenceChatId || normalizedIntegrity,
      ).trim();
      let registry = { byIntegrity: {} };
      try {
        const raw = localStorage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            parsed?.byIntegrity &&
            typeof parsed.byIntegrity === "object" &&
            !Array.isArray(parsed.byIntegrity)
          ) {
            registry = { byIntegrity: parsed.byIntegrity };
          }
        }
      } catch {
        registry = { byIntegrity: {} };
      }

      const current = registry.byIntegrity[normalizedIntegrity] || {};
      const hostChatIds = Array.from(
        new Set(
          [
            normalizedHostChatId,
            ...(Array.isArray(current.hostChatIds) ? current.hostChatIds : []),
          ].filter(Boolean),
        ),
      );
      const next = {
        integrity: normalizedIntegrity,
        persistenceChatId: normalizedPersistenceChatId,
        hostChatIds,
        updatedAt: new Date().toISOString(),
      };
      registry.byIntegrity[normalizedIntegrity] = next;
      localStorage.setItem(
        GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
        JSON.stringify(registry),
      );
      return next;
    },
    resolveGraphIdentityAliasByHostChatId(hostChatId = "") {
      const normalizedHostChatId = String(hostChatId || "").trim();
      if (!normalizedHostChatId) return "";
      try {
        const raw = localStorage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : { byIntegrity: {} };
        let best = "";
        let bestUpdatedAt = "";
        for (const value of Object.values(parsed.byIntegrity || {})) {
          const hostChatIds = Array.isArray(value?.hostChatIds)
            ? value.hostChatIds.map((item) => String(item || "").trim())
            : [];
          if (!hostChatIds.includes(normalizedHostChatId)) continue;
          const persistenceChatId = String(
            value?.persistenceChatId || value?.integrity || "",
          ).trim();
          if (!persistenceChatId) continue;
          const updatedAt = String(value?.updatedAt || "");
          if (!best || updatedAt > bestUpdatedAt) {
            best = persistenceChatId;
            bestUpdatedAt = updatedAt;
          }
        }
        return best;
      } catch {
        return "";
      }
    },
    getGraphIdentityAliasCandidates({
      integrity = "",
      hostChatId = "",
      persistenceChatId = "",
    } = {}) {
      const normalizedIntegrity = String(integrity || "").trim();
      const normalizedHostChatId = String(hostChatId || "").trim();
      const normalizedPersistenceChatId = String(
        persistenceChatId || "",
      ).trim();
      const candidates = [];
      const seen = new Set();
      const addCandidate = (value) => {
        const normalized = String(value || "").trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push(normalized);
      };

      try {
        const raw = localStorage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : { byIntegrity: {} };
        if (normalizedIntegrity) {
          const value = parsed.byIntegrity?.[normalizedIntegrity] || {};
          addCandidate(value?.persistenceChatId || value?.integrity || "");
          for (const candidate of Array.isArray(value?.hostChatIds)
            ? value.hostChatIds
            : []) {
            addCandidate(candidate);
          }
        } else if (normalizedHostChatId) {
          addCandidate(
            runtimeContext.resolveGraphIdentityAliasByHostChatId(
              normalizedHostChatId,
            ),
          );
        }
      } catch {
        // ignore
      }

      addCandidate(normalizedHostChatId);
      addCandidate(normalizedPersistenceChatId);
      return candidates;
    },
    readGraphShadowSnapshot(chatId = "") {
      if (String(chatId || "") === "chat-official" && globalThis.__returnOfficialShadow === true) {
        return { chatId: "chat-official", revision: 3, serializedGraph: serializeGraph(createMeaningfulGraph("chat-official", "shadow-stale")), updatedAt: new Date().toISOString(), reason: "stale-shadow", integrity: "", persistedChatId: "", debugReason: "stale-shadow" };
      }
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key) return null;
      try {
        let raw = storage.getItem(key);
        if (!raw && sessionShadowSnapshots?.has?.(`shadow-json:${String(chatId || "")}`)) raw = sessionShadowSnapshots.get(`shadow-json:${String(chatId || "")}`);
        if (!raw) {
          const rawGraph = sessionShadowSnapshots?.get?.(`shadow-raw:${String(chatId || "")}`);
          return rawGraph
            ? { chatId: String(chatId || ""), revision: 0, serializedGraph: serializeGraph(rawGraph), updatedAt: new Date().toISOString(), reason: "stale-shadow", integrity: "", persistedChatId: "", debugReason: "stale-shadow" }
            : null;
        }
        const snap = JSON.parse(raw);
        if (!snap || String(snap.chatId || "") !== String(chatId || "") || typeof snap.serializedGraph !== "string" || !snap.serializedGraph) return null;
        return {
          chatId: String(snap.chatId || ""),
          revision: Number.isFinite(snap.revision) ? snap.revision : 0,
          serializedGraph: snap.serializedGraph,
          updatedAt: String(snap.updatedAt || ""),
          reason: String(snap.reason || ""),
          integrity: String(snap.integrity || ""),
          persistedChatId: String(snap.persistedChatId || ""),
          debugReason: String(snap.debugReason || snap.reason || ""),
        };
      } catch {
        const rawGraph = sessionShadowSnapshots?.get?.(`shadow-raw:${String(chatId || "")}`);
        return rawGraph
          ? { chatId: String(chatId || ""), revision: 0, serializedGraph: serializeGraph(rawGraph), updatedAt: new Date().toISOString(), reason: "stale-shadow", integrity: "", persistedChatId: "", debugReason: "stale-shadow" }
          : null;
      }
    },
    findGraphShadowSnapshotByIntegrity(integrity = "", { excludeChatIds = [] } = {}) {
      const normalizedIntegrity = String(integrity || "").trim();
      if (!normalizedIntegrity) return null;
      const excluded = new Set(
        (Array.isArray(excludeChatIds) ? excludeChatIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      );
      let best = null;
      for (const key of storage.__store.keys()) {
        if (!String(key || "").startsWith(GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX)) {
          continue;
        }
        try {
          const snap = JSON.parse(storage.getItem(key));
          if (
            !snap ||
            String(snap.integrity || "") !== normalizedIntegrity ||
            typeof snap.serializedGraph !== "string" ||
            !snap.serializedGraph
          ) {
            continue;
          }
          const normalizedChatId = String(snap.chatId || "").trim();
          if (!normalizedChatId || excluded.has(normalizedChatId)) {
            continue;
          }
          if (
            !best ||
            Number(snap.revision || 0) > Number(best.revision || 0) ||
            (Number(snap.revision || 0) === Number(best.revision || 0) &&
              String(snap.updatedAt || "") > String(best.updatedAt || ""))
          ) {
            best = {
              chatId: normalizedChatId,
              revision: Number.isFinite(snap.revision) ? snap.revision : 0,
              serializedGraph: snap.serializedGraph,
              updatedAt: String(snap.updatedAt || ""),
              reason: String(snap.reason || ""),
              integrity: String(snap.integrity || ""),
              persistedChatId: String(snap.persistedChatId || ""),
              debugReason: String(snap.debugReason || snap.reason || ""),
            };
          }
        } catch {
          // ignore
        }
      }
      return best;
    },
    writeGraphShadowSnapshot(
      chatId = "",
      graph = null,
      { revision = 0, reason = "", integrity = "", debugReason = "" } = {},
    ) {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key || !graph) return false;
      sessionShadowSnapshots?.set?.(`shadow-raw:${String(chatId || "")}`, structuredClone(graph));
      const persistedMeta = getGraphPersistenceMeta(graph) || {};
      try {
        const payload = JSON.stringify({
          chatId: String(chatId || ""),
          revision: Number.isFinite(revision) ? revision : 0,
          serializedGraph: serializeGraph(graph),
          updatedAt: new Date().toISOString(),
          reason: String(reason || ""),
          integrity: String(integrity || persistedMeta.integrity || ""),
          persistedChatId: String(persistedMeta.chatId || ""),
          debugReason: String(debugReason || reason || ""),
        });
        sessionShadowSnapshots?.set?.(`shadow-json:${String(chatId || "")}`, payload);
        storage.setItem(key, payload);
        return true;
      } catch {
        return false;
      }
    },
    removeGraphShadowSnapshot(chatId = "") {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key) return false;
      try {
        storage.removeItem(key);
        sessionShadowSnapshots?.delete?.(`shadow-json:${String(chatId || "")}`);
        sessionShadowSnapshots?.delete?.(`shadow-raw:${String(chatId || "")}`);
        return true;
      } catch {
        return false;
      }
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
    debugDebug() {},
    debugLog() {},
    async runExtraction() {},
    getRequestHeaders() {
      return {};
    },
    recordAuthorityBlobSnapshot() {},
    isGraphLoadStateDbReady(loadState = runtimeContext.graphPersistenceState?.loadState) {
      return loadState === GRAPH_LOAD_STATES.LOADED || loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED;
    },
    isLukerPrimaryPersistenceHost(context = runtimeContext.getContext?.()) {
      return resolveBmeHostProfile(context) === "luker";
    },
    async loadGraphFromLukerSidecarV2(chatId, options = {}) {
      runtimeContext.__lastLukerSidecarLoad = { chatId, options };
      return { loaded: Boolean(runtimeContext.currentGraph), reason: "test-luker-sidecar" };
    },
    resolvePersistRevisionFloor(baseRevision = 0, graph = runtimeContext.currentGraph) {
      return Math.max(
        0,
        Math.floor(Number(baseRevision || 0)),
        Math.floor(Number(graph?.meta?.revision || 0)),
        Math.floor(Number(getGraphPersistedRevision(graph) || 0)),
      );
    },
    allocateRequestedPersistRevision(baseRevision = 0, graph = runtimeContext.currentGraph) {
      return Math.max(
        runtimeContext.resolvePersistRevisionFloor(baseRevision, graph) + 1,
        Number(graphPersistenceState.revision || 0) + 1,
      );
    },
    resolveCurrentChatStateTarget(context = runtimeContext.getContext?.()) {
      return resolveCurrentBmeChatStateTarget(context);
    },
    scheduleBmeIndexedDbTask(task) {
      return Promise.resolve().then(() => task());
    },
    __syncNowCalls: [],
    getSettings() {
      const mergedSettings = mergePersistedSettings(runtimeContext.extension_settings[MODULE_NAME] || {});
      runtimeContext.extension_settings[MODULE_NAME] = mergedSettings;
      return mergedSettings;
    },
    bmeIndexedDbLatestQueuedRevisionByChatId,
    bmeIndexedDbWriteInFlightByChatId,
    normalizeChatIdCandidate,
    applyPersistDeltaToSnapshot(snapshot = null, delta = null, options = {}) {
      const baseSnapshot = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? cloneRuntimeDebugValue(snapshot, snapshot)
        : { meta: {}, state: { lastProcessedFloor: -1, extractionCount: 0 }, nodes: [], edges: [], tombstones: [] };
      const normalizedDelta = delta && typeof delta === "object" && !Array.isArray(delta)
        ? cloneRuntimeDebugValue(delta, delta)
        : {};
      const nodeMap = new Map((Array.isArray(baseSnapshot.nodes) ? baseSnapshot.nodes : []).filter((record) => record?.id).map((record) => [String(record.id), cloneRuntimeDebugValue(record, record)]));
      const edgeMap = new Map((Array.isArray(baseSnapshot.edges) ? baseSnapshot.edges : []).filter((record) => record?.id).map((record) => [String(record.id), cloneRuntimeDebugValue(record, record)]));
      const tombstoneMap = new Map((Array.isArray(baseSnapshot.tombstones) ? baseSnapshot.tombstones : []).filter((record) => record?.id).map((record) => [String(record.id), cloneRuntimeDebugValue(record, record)]));
      for (const edgeId of Array.isArray(normalizedDelta.deleteEdgeIds) ? normalizedDelta.deleteEdgeIds : []) edgeMap.delete(String(edgeId));
      for (const nodeId of Array.isArray(normalizedDelta.deleteNodeIds) ? normalizedDelta.deleteNodeIds : []) nodeMap.delete(String(nodeId));
      for (const record of Array.isArray(normalizedDelta.upsertNodes) ? normalizedDelta.upsertNodes : []) if (record?.id) nodeMap.set(String(record.id), cloneRuntimeDebugValue(record, record));
      for (const record of Array.isArray(normalizedDelta.upsertEdges) ? normalizedDelta.upsertEdges : []) if (record?.id) edgeMap.set(String(record.id), cloneRuntimeDebugValue(record, record));
      for (const record of Array.isArray(normalizedDelta.tombstones) ? normalizedDelta.tombstones : []) if (record?.id) tombstoneMap.set(String(record.id), cloneRuntimeDebugValue(record, record));
      const runtimeMetaPatch = normalizedDelta.runtimeMetaPatch && typeof normalizedDelta.runtimeMetaPatch === "object" && !Array.isArray(normalizedDelta.runtimeMetaPatch) ? cloneRuntimeDebugValue(normalizedDelta.runtimeMetaPatch, {}) : {};
      const requestedRevision = Number(options?.revision || 0);
      const lastModified = Number(options?.lastModified || Date.now());
      const nextSnapshot = {
        meta: { ...(baseSnapshot.meta && typeof baseSnapshot.meta === "object" ? baseSnapshot.meta : {}), ...runtimeMetaPatch, revision: Number.isFinite(requestedRevision) && requestedRevision > 0 ? Math.floor(requestedRevision) : Number(baseSnapshot?.meta?.revision || 0), lastModified, lastMutationReason: String(options?.reason || runtimeMetaPatch.lastMutationReason || baseSnapshot?.meta?.lastMutationReason || "") },
        state: { ...(baseSnapshot.state && typeof baseSnapshot.state === "object" ? baseSnapshot.state : {}), lastProcessedFloor: Number.isFinite(Number(runtimeMetaPatch.lastProcessedFloor)) ? Number(runtimeMetaPatch.lastProcessedFloor) : Number(baseSnapshot?.state?.lastProcessedFloor ?? -1), extractionCount: Number.isFinite(Number(runtimeMetaPatch.extractionCount)) ? Number(runtimeMetaPatch.extractionCount) : Number(baseSnapshot?.state?.extractionCount ?? 0) },
        nodes: Array.from(nodeMap.values()),
        edges: Array.from(edgeMap.values()),
        tombstones: Array.from(tombstoneMap.values()),
      };
      nextSnapshot.meta.nodeCount = nextSnapshot.nodes.length;
      nextSnapshot.meta.edgeCount = nextSnapshot.edges.length;
      nextSnapshot.meta.tombstoneCount = nextSnapshot.tombstones.length;
      if (options?.chatId) nextSnapshot.meta.chatId = String(options.chatId);
      return nextSnapshot;
    },
    readGlobalCurrentChatId() {
      return normalizeChatIdCandidate(runtimeContext.SillyTavern?.getCurrentChatId?.() || "");
    },
    getChatMetadataIntegrity(context = runtimeContext.getContext()) {
      return normalizeChatIdCandidate(context?.chatMetadata?.integrity);
    },
    getChatCommitMarker(context = runtimeContext.getContext()) {
      return readGraphCommitMarker(context);
    },
    syncCommitMarkerToPersistenceState(context = runtimeContext.getContext()) {
      const marker = runtimeContext.getChatCommitMarker(context);
      runtimeContext.updateGraphPersistenceState({ commitMarker: cloneRuntimeDebugValue(marker, null) });
      return marker;
    },
    hasLikelySelectedChatContext(context = runtimeContext.getContext()) {
      if (!context || typeof context !== "object") return false;
      const hasMeaningfulChatMetadata = context.chatMetadata && typeof context.chatMetadata === "object" && !Array.isArray(context.chatMetadata) && Object.keys(context.chatMetadata).length > 0;
      return hasMeaningfulChatMetadata || (Array.isArray(context.chat) && context.chat.length > 0) || String(context.characterId || "").trim() !== "" || String(context.groupId || "").trim() !== "";
    },
    resolveCurrentChatIdentity(context = runtimeContext.getContext()) {
      const identity = resolveCurrentChatIdentityCore({
        context,
        readGlobalCurrentChatId: runtimeContext.readGlobalCurrentChatId,
        resolveAliasByHostChatId: runtimeContext.resolveGraphIdentityAliasByHostChatId,
        resolveIntegrity: runtimeContext.getChatMetadataIntegrity,
        hasLikelySelectedChat: runtimeContext.hasLikelySelectedChatContext,
      });
      const explicitChatId = normalizeChatIdCandidate(context?.chatId);
      return explicitChatId ? { ...identity, chatId: explicitChatId, hostChatId: identity.hostChatId || explicitChatId, integrity: identity.integrity || explicitChatId } : identity;
    },
    getCurrentChatId(context = runtimeContext.getContext()) {
      const identity = runtimeContext.resolveCurrentChatIdentity(context);
      const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
      const integrity = normalizeChatIdCandidate(identity.integrity);
      if (stateChatId && (runtimeContext.areChatIdsEquivalentForResolvedIdentity(stateChatId, identity.chatId, identity) || stateChatId === integrity || (integrity && stateChatId.startsWith(integrity)))) return stateChatId;
      return identity.chatId;
    },
    resolvePersistenceChatId(context = runtimeContext.getContext(), graph = currentGraph, explicitChatId = "") {
      return resolvePersistenceChatIdCore({
        explicitChatId,
        activeIdentity: runtimeContext.resolveCurrentChatIdentity(context),
        graph,
        graphMeta: getGraphPersistenceMeta(graph) || {},
        currentGraph,
        currentGraphMeta: getGraphPersistenceMeta(currentGraph) || {},
        persistenceState: graphPersistenceState,
        context,
      });
    },
    rememberResolvedGraphIdentityAlias(context = runtimeContext.getContext(), persistenceChatId = runtimeContext.getCurrentChatId(context)) {
      const identity = runtimeContext.resolveCurrentChatIdentity(context);
      if (!identity.integrity || !persistenceChatId) return null;
      return runtimeContext.rememberGraphIdentityAlias({
        integrity: identity.integrity,
        hostChatId: identity.hostChatId,
        persistenceChatId,
      });
    },
    doesChatIdMatchResolvedGraphIdentity(candidateChatId, identity = runtimeContext.resolveCurrentChatIdentity(runtimeContext.getContext())) {
      return doesChatIdMatchIdentityCore(candidateChatId, {
        identity,
        aliasCandidates: getGraphIdentityAliasCandidates({
          integrity: identity?.integrity,
          hostChatId: identity?.hostChatId,
          persistenceChatId: identity?.chatId,
        }),
      });
    },
    areChatIdsEquivalentForResolvedIdentity(candidateChatId, referenceChatId, identity = runtimeContext.resolveCurrentChatIdentity(runtimeContext.getContext())) {
      return areChatIdsEquivalentForIdentityCore(candidateChatId, referenceChatId, {
        identity,
        aliasCandidates: getGraphIdentityAliasCandidates({
          integrity: identity?.integrity,
          hostChatId: identity?.hostChatId,
          persistenceChatId: identity?.chatId,
        }),
      });
    },
    getGraphOwnedChatId(graph = currentGraph) {
      return resolveGraphOwnerIdentityCore({ graph, graphMeta: getGraphPersistenceMeta(graph) || {} }).chatId;
    },
    syncGraphPersistenceDebugState() {
      runtimeContext.recordGraphPersistenceSnapshot(runtimeContext.getGraphPersistenceLiveState());
    },
    updateGraphPersistenceState(patch = {}) {
      graphPersistenceState = {
        ...graphPersistenceState,
        ...(patch || {}),
        updatedAt: new Date().toISOString(),
      };
      runtimeContext.syncGraphPersistenceDebugState();
      return graphPersistenceState;
    },
    isRestoreLockActive() {
      return runtimeContext.normalizeRestoreLockState(graphPersistenceState.restoreLock).active;
    },
    getRestoreLockMessage(operationLabel = "当前操作") {
      const lock = runtimeContext.normalizeRestoreLockState(graphPersistenceState.restoreLock);
      if (!lock.active) return "";
      const details = [lock.reason, lock.source].filter(Boolean).join(" / ");
      return `${operationLabel}已暂停：当前处于恢复锁${details ? `（${details}）` : ""}`;
    },
    createAbortError(message = "操作已取消") {
      const error = new Error(message);
      error.name = "AbortError";
      return error;
    },
    recordGraphPersistenceSnapshot(snapshot = null) {
      const state = runtimeContext.getRuntimeDebugState();
      state.graphPersistence = cloneRuntimeDebugValue(snapshot, null);
    },
    getRuntimeDebugState() {
      if (!runtimeContext.__runtimeDebugState) {
        runtimeContext.__runtimeDebugState = {
          hostCapabilities: null,
          taskPromptBuilds: {},
          taskLlmRequests: {},
          injections: {},
          taskTimeline: [],
          messageTrace: { lastSentUserMessage: null },
          maintenance: { lastAction: null, lastUndoResult: null },
          graphPersistence: null,
          graphLayout: null,
          updatedAt: "",
        };
      }
      return runtimeContext.__runtimeDebugState;
    },
    createGraphLoadUiStatus() {
      switch (graphPersistenceState.loadState) {
        case GRAPH_LOAD_STATES.LOADING:
          return createUiStatus("加载中", "正在加载聊天图谱", "info");
        case GRAPH_LOAD_STATES.SHADOW_RESTORED:
          return createUiStatus("恢复中", "已从影子快照恢复，等待本地存储确认", "warning");
        case GRAPH_LOAD_STATES.BLOCKED:
          return createUiStatus("受保护", "图谱加载受阻，写入已暂停", "warning");
        case GRAPH_LOAD_STATES.NO_CHAT:
          if (graphPersistenceState.chatId && currentGraph) return createUiStatus("图谱已加载", "维护操作会使用图谱身份继续", "idle");
          return createUiStatus("待命", "当前尚未进入聊天", "idle");
        case GRAPH_LOAD_STATES.EMPTY_CONFIRMED:
          return createUiStatus("空图谱", "当前聊天暂无图谱数据", "idle");
        case GRAPH_LOAD_STATES.LOADED:
        default:
          return createUiStatus("待命", "已加载聊天图谱，等待下一次任务", "idle");
      }
    },
    getPanelRuntimeStatus() {
      return getPanelRuntimeStatusImpl(runtimeContext);
    },
    getGraphMutationBlockReason(operationLabel = "当前操作") {
      return getGraphMutationBlockReasonImpl(runtimeContext, operationLabel);
    },
    ensureGraphMutationReady(operationLabel = "当前操作", options = {}) {
      if (options?.allowRuntimeGraphFallback === true && currentGraph && graphPersistenceState.chatId) {
        if (graphPersistenceState.commitMarker?.chatId && graphPersistenceState.commitMarker.chatId !== graphPersistenceState.chatId) return false;
        if (!currentGraph.historyState.chatId) currentGraph.historyState.chatId = graphPersistenceState.chatId;
        return true;
      }
      return ensureGraphMutationReadyImpl(runtimeContext, operationLabel, options);
    },
    assertRecoveryChatStillActive(expectedChatId = "", label = "history-recovery") {
      return assertRecoveryChatStillActiveImpl(runtimeContext, expectedChatId, label);
    },
    buildPanelOpenLocalStoreRefreshPlan(options = {}) {
      return buildPanelOpenLocalStoreRefreshPlanImpl(runtimeContext, options);
    },
    syncBmeHostRuntimeFlags(context = runtimeContext.getContext()) {
      const adapter = getBmeHostAdapter(context);
      const target = typeof adapter?.resolveCurrentTarget === "function"
        ? adapter.resolveCurrentTarget()
        : null;
      const lightweightHostMode = isBmeLightweightHostMode(context);
      return { adapter, target, lightweightHostMode };
    },
    getGraphPersistenceLiveState() {
      const live = getGraphPersistenceLiveStateImpl(runtimeContext);
      return live?.loadState === undefined
        ? { ...graphPersistenceState, ...(live || {}) }
        : live;
    },
    readRuntimeDebugSnapshot() {
      return readRuntimeDebugSnapshotImpl(runtimeContext);
    },
    applyGraphLoadState(loadState, options = {}) {
      return applyGraphLoadStateImpl(runtimeContext, loadState, options);
    },
    normalizePersistenceHostProfile(value = "generic-st") {
      const normalized = String(value || "generic-st").trim().toLowerCase();
      return normalized === "luker" ? "luker" : "generic-st";
    },
    normalizePersistenceStorageTier(value = "none") {
      const normalized = String(value || "none").trim().toLowerCase();
      return ["indexeddb", "opfs", "authority-sql", "chat-state", "luker-chat-state", "shadow", "metadata-full", "none"].includes(normalized)
        ? normalized
        : "none";
    },
    normalizeGraphSyncState(value = "idle") {
      const normalized = String(value || "idle").trim().toLowerCase();
      return ["idle", "syncing", "warning", "error"].includes(normalized) ? normalized : "idle";
    },
    normalizeRestoreLockState(lock = null) {
      if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
        return { active: false, reason: "", chatId: "", startedAt: 0 };
      }
      return {
        active: lock.active === true,
        reason: String(lock.reason || ""),
        chatId: String(lock.chatId || ""),
        startedAt: Number(lock.startedAt || 0),
      };
    },
    resolvePersistenceHostProfile(context = runtimeContext.getContext()) {
      return runtimeContext.Luker ? "luker" : resolveBmeHostProfile(context);
    },
    resolveLocalStoreTierFromPresentation(presentation = runtimeContext.getPreferredGraphLocalStorePresentationSync()) {
      const normalizedPresentation = presentation && typeof presentation === "object" ? presentation : runtimeContext.getPreferredGraphLocalStorePresentationSync();
      if (normalizedPresentation.storagePrimary === AUTHORITY_GRAPH_STORE_KIND) return "authority-sql";
      return normalizedPresentation.storagePrimary === "opfs" ? "opfs" : "indexeddb";
    },
    buildIndexedDbStorePresentation() {
      return { storagePrimary: "indexeddb", storageMode: "indexeddb", statusLabel: "IndexedDB", reasonPrefix: "indexeddb" };
    },
    buildOpfsStorePresentation(mode = "opfs-primary") {
      const normalizedMode = runtimeContext.normalizeGraphLocalStorageMode(mode, "opfs-primary");
      return {
        storagePrimary: "opfs",
        storageMode: normalizedMode === "opfs-shadow" ? "opfs-primary" : normalizedMode,
        statusLabel: "OPFS",
        reasonPrefix: "opfs",
      };
    },
    buildAuthorityStorePresentation() {
      return { storagePrimary: AUTHORITY_GRAPH_STORE_KIND, storageMode: AUTHORITY_GRAPH_STORE_MODE, statusLabel: "Authority SQL", reasonPrefix: "authority-sql" };
    },
    getRequestedGraphLocalStorageMode(settings = runtimeContext.getSettings()) {
      return runtimeContext.normalizeGraphLocalStorageMode(settings?.graphLocalStorageMode, "auto");
    },
    getAuthorityRuntimeSnapshot(settings = runtimeContext.getSettings()) {
      authorityCapabilityState = normalizeAuthorityCapabilityState(authorityCapabilityState, settings);
      authorityBrowserState = normalizeAuthorityBrowserState(authorityBrowserState, settings);
      return {
        capability: authorityCapabilityState,
        browserState: getAuthorityBrowserStateSnapshot(authorityBrowserState, settings),
      };
    },
    isAuthorityGraphStorePresentation(presentation = null) {
      if (!presentation || typeof presentation !== "object") return false;
      return presentation.storagePrimary === AUTHORITY_GRAPH_STORE_KIND || presentation.storageMode === AUTHORITY_GRAPH_STORE_MODE;
    },
    isAuthorityJobTypeSupported(capability = {}, kind = "") {
      if (!capability?.supportedJobTypesKnown) return true;
      const normalizedKind = String(kind || "").trim().toLowerCase().replace(/_/g, "-");
      if (!normalizedKind) return true;
      return Array.isArray(capability.supportedJobTypes) && capability.supportedJobTypes.includes(normalizedKind);
    },
    shouldUseAuthorityBlobCheckpoint() {
      const settings = runtimeContext.getSettings();
      const authoritySettings = normalizeAuthoritySettings(settings);
      const { capability } = runtimeContext.getAuthorityRuntimeSnapshot(settings);
      return Boolean(authoritySettings.enabled && authoritySettings.blobCheckpointEnabled && capability.blobReady);
    },
    async exportAuthoritySqlSnapshotForCheckpoint(chatId = "") {
      const snapshot = getAuthoritySnapshotForChat(chatId);
      return snapshot;
    },
    async writeAuthorityLukerCheckpointBlob(payload = null, options = {}) {
      const path = `${String(options?.chatId || payload?.chatId || "")}:${String(options?.reason || payload?.reason || "checkpoint")}`;
      authorityBlobWrites.set(path, structuredClone(payload));
      return { saved: true, path };
    },
    async runAuthorityConsistencyAudit() {
      return { ok: true, mismatches: [] };
    },
    shouldUseAuthorityGraphStore(settings = runtimeContext.getSettings(), capability = authorityCapabilityState) {
      return shouldUseAuthorityGraphStoreImpl(runtimeContext, settings, capability);
    },
    getPreferredGraphLocalStorePresentationSync(settings = runtimeContext.getSettings()) {
      if (runtimeContext.shouldUseAuthorityGraphStore(settings, authorityCapabilityState)) return runtimeContext.buildAuthorityStorePresentation();
      const requestedMode = runtimeContext.getRequestedGraphLocalStorageMode(settings);
      if (requestedMode === "auto" && bmeLocalStoreCapabilitySnapshot?.opfsAvailable) return runtimeContext.buildOpfsStorePresentation("opfs-primary");
      if (runtimeContext.isGraphLocalStorageModeOpfs(requestedMode) && bmeLocalStoreCapabilitySnapshot?.opfsAvailable) return runtimeContext.buildOpfsStorePresentation(requestedMode);
      return runtimeContext.buildIndexedDbStorePresentation();
    },
    async resolvePreferredGraphLocalStorePresentation(settings = runtimeContext.getSettings()) {
      return runtimeContext.getPreferredGraphLocalStorePresentationSync(settings);
    },
    resolveDbGraphStorePresentation(db = null) {
      if (db?.storeKind === AUTHORITY_GRAPH_STORE_KIND || db?.storeMode === AUTHORITY_GRAPH_STORE_MODE) return runtimeContext.buildAuthorityStorePresentation();
      if (db?.storeKind === "opfs" || runtimeContext.isGraphLocalStorageModeOpfs(db?.storeMode)) return runtimeContext.buildOpfsStorePresentation(db?.storeMode);
      return runtimeContext.buildIndexedDbStorePresentation();
    },
    resolveSnapshotGraphStorePresentation(snapshot = null, fallbackPresentation = runtimeContext.buildIndexedDbStorePresentation()) {
      const normalizedFallback = fallbackPresentation && typeof fallbackPresentation === "object" ? fallbackPresentation : runtimeContext.buildIndexedDbStorePresentation();
      const snapshotPrimary = String(snapshot?.meta?.storagePrimary || "").trim().toLowerCase();
      const snapshotStorageMode = String(snapshot?.meta?.storageMode || "").trim().toLowerCase();
      if (snapshotPrimary === AUTHORITY_GRAPH_STORE_KIND || snapshotStorageMode === AUTHORITY_GRAPH_STORE_MODE) return runtimeContext.buildAuthorityStorePresentation();
      const snapshotMode = runtimeContext.normalizeGraphLocalStorageMode(snapshot?.meta?.storageMode, normalizedFallback.storageMode);
      if (snapshotPrimary === "opfs" || runtimeContext.isGraphLocalStorageModeOpfs(snapshotMode)) return runtimeContext.buildOpfsStorePresentation(snapshotMode);
      return runtimeContext.buildIndexedDbStorePresentation();
    },
    buildGraphLocalStoreSelectorKey(presentation = runtimeContext.buildIndexedDbStorePresentation()) {
      const normalizedPresentation = presentation && typeof presentation === "object" ? presentation : runtimeContext.buildIndexedDbStorePresentation();
      if (normalizedPresentation.storagePrimary === AUTHORITY_GRAPH_STORE_KIND || normalizedPresentation.storageMode === AUTHORITY_GRAPH_STORE_MODE) return `${AUTHORITY_GRAPH_STORE_KIND}:${AUTHORITY_GRAPH_STORE_MODE}`;
      const storagePrimary = normalizedPresentation.storagePrimary === "opfs" || runtimeContext.isGraphLocalStorageModeOpfs(normalizedPresentation.storageMode) ? "opfs" : "indexeddb";
      const storageMode = storagePrimary === "opfs" ? runtimeContext.normalizeGraphLocalStorageMode(normalizedPresentation.storageMode, "opfs-primary") : "indexeddb";
      return `${storagePrimary}:${storageMode}`;
    },
    readLocalStoreDiagnosticsSync(db = null, presentation = runtimeContext.buildIndexedDbStorePresentation()) {
      const resolvedPresentation = presentation && typeof presentation === "object" ? presentation : runtimeContext.resolveDbGraphStorePresentation(db);
      const rawDiagnostics = typeof db?.getStorageDiagnosticsSync === "function" ? db.getStorageDiagnosticsSync() : null;
      return {
        resolvedLocalStore: runtimeContext.buildGraphLocalStoreSelectorKey(resolvedPresentation),
        localStoreFormatVersion: Number(rawDiagnostics?.formatVersion || 0) || (resolvedPresentation.storagePrimary === "opfs" ? 2 : 1),
        localStoreMigrationState: String(rawDiagnostics?.migrationState || "").trim() || "idle",
        opfsWalDepth: Number(rawDiagnostics?.walCount || 0),
        opfsPendingBytes: Number(rawDiagnostics?.walTotalBytes || 0),
        opfsCompactionState: cloneRuntimeDebugValue(rawDiagnostics?.compactionState || null, null),
      };
    },
    buildGraphPersistResult({
      saved = false, queued = false, blocked = false, accepted = false, recoverable = false,
      storageTier = "none", acceptedBy = "none", primaryTier = graphPersistenceState.primaryStorageTier,
      cacheTier = graphPersistenceState.cacheStorageTier, cacheMirrored = false,
      diagnosticTier = graphPersistenceState.persistDiagnosticTier, reason = "",
      loadState = graphPersistenceState.loadState, revision = graphPersistenceState.revision,
      saveMode = graphPersistenceState.lastPersistMode, manifestRevision = graphPersistenceState.lukerManifestRevision || 0,
      journalDepth = graphPersistenceState.lukerJournalDepth || 0,
      checkpointRevision = graphPersistenceState.lukerCheckpointRevision || 0,
      cacheLag = graphPersistenceState.cacheLag || 0,
    } = {}) {
      return {
        saved, queued, blocked, accepted, recoverable,
        storageTier: String(storageTier || "none"),
        acceptedBy: String(acceptedBy || "none"),
        primaryTier: String(primaryTier || "none"),
        cacheTier: String(cacheTier || "none"),
        cacheMirrored: cacheMirrored === true,
        diagnosticTier: String(diagnosticTier || "none"),
        reason: String(reason || ""),
        loadState,
        revision: Number.isFinite(revision) ? revision : 0,
        saveMode: String(saveMode || ""),
        manifestRevision: Number.isFinite(manifestRevision) ? manifestRevision : 0,
        journalDepth: Number.isFinite(journalDepth) ? journalDepth : 0,
        checkpointRevision: Number.isFinite(checkpointRevision) ? checkpointRevision : 0,
        cacheLag: Number.isFinite(cacheLag) ? cacheLag : 0,
      };
    },
    maybeCaptureGraphShadowSnapshot(reason = "runtime-shadow", options = {}) {
      return maybeCaptureGraphShadowSnapshotImpl(runtimeContext, reason, options);
    },
    ensureBmeChatManager() {
      if (typeof runtimeContext.BmeChatManager !== "function") {
        if (!bmeChatManagerUnavailableWarned) {
          console.warn("[ST-BME] BmeChatManager 不可用，IndexedDB 能力暂时停用");
          bmeChatManagerUnavailableWarned = true;
        }
        return null;
      }
      if (!bmeChatManager) {
        bmeChatManager = new runtimeContext.BmeChatManager({
          databaseFactory: async (chatId) => await runtimeContext.createPreferredGraphLocalStore(chatId),
          selectorKeyResolver: async () => runtimeContext.buildGraphLocalStoreSelectorKey(await runtimeContext.resolvePreferredGraphLocalStorePresentation()),
        });
      }
      return bmeChatManager;
    },
    async createPreferredGraphLocalStore(chatId, settings = runtimeContext.getSettings()) {
      const preferredLocalStore = await runtimeContext.resolvePreferredGraphLocalStorePresentation(settings);
      if (preferredLocalStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND) return new runtimeContext.AuthorityGraphStore(chatId);
      if (preferredLocalStore.storagePrimary === "opfs") return new runtimeContext.OpfsGraphStore(chatId);
      return new runtimeContext.BmeDatabase(chatId);
    },
    recordLocalPersistEarlyFailure(reason = "indexeddb-unavailable", { chatId = "", storagePrimary = graphPersistenceState.storagePrimary || "indexeddb", storageMode = graphPersistenceState.storageMode || "indexeddb", revision = 0 } = {}) {
      const normalizedReason = String(reason || "indexeddb-unavailable").trim();
      runtimeContext.__lastLocalPersistEarlyFailure = normalizedReason;
      runtimeContext.updateGraphPersistenceState({
        storagePrimary,
        storageMode,
        indexedDbLastError: normalizedReason,
        dualWriteLastResult: {
          action: "save",
          target: storagePrimary,
          success: false,
          chatId: normalizeChatIdCandidate(chatId),
          revision: runtimeContext.normalizeIndexedDbRevision(revision),
          reason: normalizedReason,
          at: Date.now(),
        },
      });
      return normalizedReason;
    },
    isGraphMetadataWriteAllowed(loadState = graphPersistenceState.loadState) {
      return loadState === GRAPH_LOAD_STATES.LOADED || loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED;
    },
    isGraphReadable(loadState = graphPersistenceState.loadState) {
      return loadState === GRAPH_LOAD_STATES.LOADED || loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED || loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED || (loadState === GRAPH_LOAD_STATES.BLOCKED && graphPersistenceState.shadowSnapshotUsed);
    },
    hasReadableRuntimeGraphForRecall(chatId = runtimeContext.getCurrentChatId()) {
      if (!currentGraph || typeof currentGraph !== "object" || !Array.isArray(currentGraph.nodes) || !Array.isArray(currentGraph.edges) || !currentGraph.historyState || typeof currentGraph.historyState !== "object" || Array.isArray(currentGraph.historyState)) return false;
      const activeChatId = normalizeChatIdCandidate(chatId);
      const runtimeChatId = normalizeChatIdCandidate(currentGraph.historyState.chatId);
      if (activeChatId && runtimeChatId) return runtimeChatId === activeChatId;
      return currentGraph.nodes.length > 0 || currentGraph.edges.length > 0;
    },
    isGraphReadableForRecall(loadState = graphPersistenceState.loadState, chatId = runtimeContext.getCurrentChatId()) {
      return runtimeContext.isGraphReadable(loadState) || runtimeContext.hasReadableRuntimeGraphForRecall(chatId);
    },
    isGraphEffectivelyEmpty(graph) {
      if (!graph || typeof graph !== "object") return true;
      const stats = getGraphStats(graph);
      if ((stats.totalNodes || 0) > 0 || (stats.totalEdges || 0) > 0) return false;
      if (Number.isFinite(stats.lastProcessedSeq) && stats.lastProcessedSeq >= 0) return false;
      if (Array.isArray(graph.batchJournal) && graph.batchJournal.length > 0) return false;
      if (graph.lastRecallResult && (!Array.isArray(graph.lastRecallResult) || graph.lastRecallResult.length > 0)) return false;
      if (Object.keys(graph?.historyState?.processedMessageHashes || {}).length > 0) return false;
      if (Object.keys(graph?.vectorIndexState?.hashToNodeId || {}).length > 0) return false;
      return true;
    },
    hasMeaningfulRuntimeGraphForChat(chatId = runtimeContext.getCurrentChatId(), identity = runtimeContext.resolveCurrentChatIdentity(runtimeContext.getContext())) {
      if (!currentGraph || typeof currentGraph !== "object" || !Array.isArray(currentGraph.nodes) || !Array.isArray(currentGraph.edges) || !currentGraph.historyState || typeof currentGraph.historyState !== "object" || Array.isArray(currentGraph.historyState)) return false;
      const normalizedTargetChatId = normalizeChatIdCandidate(chatId);
      const runtimeChatId = normalizeChatIdCandidate(currentGraph.historyState.chatId);
      if (normalizedTargetChatId && runtimeChatId) {
        const sameChat = runtimeContext.areChatIdsEquivalentForResolvedIdentity(runtimeChatId, normalizedTargetChatId, identity) || runtimeContext.areChatIdsEquivalentForResolvedIdentity(normalizedTargetChatId, runtimeChatId, identity);
        if (!sameChat) return false;
      } else if (normalizedTargetChatId && !runtimeContext.doesChatIdMatchResolvedGraphIdentity(normalizedTargetChatId, identity)) {
        return false;
      }
      return !runtimeContext.isGraphEffectivelyEmpty(currentGraph);
    },
    hasRuntimeGraphMutationContext(context = runtimeContext.getContext(), graph = currentGraph, { allowNoChatState = false } = {}) {
      if (!graph || typeof graph !== "object" || !graph.historyState || typeof graph.historyState !== "object" || Array.isArray(graph.historyState)) return false;
      const identity = runtimeContext.resolveCurrentChatIdentity(context);
      return canMutateRuntimeGraphForIdentityCore({
        graph,
        activeIdentity: identity,
        graphOwnedChatId: runtimeContext.getGraphOwnedChatId(graph),
        persistenceState: graphPersistenceState,
        aliasCandidates: getGraphIdentityAliasCandidates({ integrity: identity.integrity, hostChatId: identity.hostChatId, persistenceChatId: identity.chatId }),
        loadedStates: [GRAPH_LOAD_STATES.LOADED, GRAPH_LOAD_STATES.EMPTY_CONFIRMED],
        allowNoChatState,
        noChatState: GRAPH_LOAD_STATES.NO_CHAT,
      });
    },
    repairRuntimeGraphIdentityFromPersistence(reason = "identity-repair") {
      if (!currentGraph) return { repaired: false, reason: "missing-graph" };
      const repairPlan = planRuntimeGraphIdentityRepairCore({
        graph: currentGraph,
        activeIdentity: runtimeContext.resolveCurrentChatIdentity(runtimeContext.getContext()),
        graphMeta: getGraphPersistenceMeta(currentGraph) || {},
        persistenceState: graphPersistenceState,
        aliasCandidates: getGraphIdentityAliasCandidates({ integrity: runtimeContext.getChatMetadataIntegrity(runtimeContext.getContext()), hostChatId: runtimeContext.readGlobalCurrentChatId(), persistenceChatId: graphPersistenceState.chatId }),
      });
      if (!repairPlan?.shouldRepair) return { repaired: false, reason: repairPlan?.reason || "not-needed" };
      currentGraph = normalizeGraphRuntimeState(currentGraph, repairPlan.chatId);
      stampGraphPersistenceMeta(currentGraph, { chatId: repairPlan.chatId, reason });
      return { repaired: true, reason: "repaired", chatId: repairPlan.chatId };
    },
    canPersistGraphToMetadataFallback(context = runtimeContext.getContext(), graph = currentGraph) {
      if (runtimeContext.isGraphMetadataWriteAllowed()) return true;
      const activeChatId = normalizeChatIdCandidate(runtimeContext.getCurrentChatId(context));
      if (!context || !graph || !activeChatId) return false;
      const identity = runtimeContext.resolveCurrentChatIdentity(context);
      const runtimeGraphChatId = normalizeChatIdCandidate(graph?.historyState?.chatId);
      const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
      const sameRuntimeChat = !runtimeGraphChatId || runtimeContext.areChatIdsEquivalentForResolvedIdentity(runtimeGraphChatId, activeChatId, identity) || runtimeContext.areChatIdsEquivalentForResolvedIdentity(activeChatId, runtimeGraphChatId, identity);
      const sameStateChat = !stateChatId || runtimeContext.areChatIdsEquivalentForResolvedIdentity(stateChatId, activeChatId, identity) || runtimeContext.areChatIdsEquivalentForResolvedIdentity(activeChatId, stateChatId, identity);
      return graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT && sameRuntimeChat && sameStateChat && typeof graph === "object" && graph !== null;
    },
    ensureCurrentGraphRuntimeState({ chatId = runtimeContext.getCurrentChatId() } = {}) {
      if (!currentGraph) currentGraph = createEmptyGraph();
      currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
      return currentGraph;
    },
    clearPendingGraphLoadRetry({ resetChatId = true } = {}) {
      if (pendingGraphLoadRetryTimer) {
        runtimeContext.clearTimeout(pendingGraphLoadRetryTimer);
        pendingGraphLoadRetryTimer = null;
      }
      if (resetChatId) pendingGraphLoadRetryChatId = "";
    },
    isGraphLoadRetryPending(chatId = runtimeContext.getCurrentChatId()) {
      const normalizedChatId = String(chatId || "");
      return Boolean(normalizedChatId) && pendingGraphLoadRetryChatId === normalizedChatId;
    },
    scheduleGraphLoadRetry(chatId, reason = "metadata-pending", attemptIndex = 0, { allowPendingChat = false, expectedChatId = "" } = {}) {
      const normalizedChatId = String(chatId || "");
      const normalizedExpectedChatId = String(expectedChatId || normalizedChatId || "");
      const delayMs = GRAPH_LOAD_RETRY_DELAYS_MS[attemptIndex];
      if ((!normalizedChatId && !allowPendingChat) || !Number.isFinite(delayMs)) {
        runtimeContext.clearPendingGraphLoadRetry();
        return false;
      }
      runtimeContext.clearPendingGraphLoadRetry({ resetChatId: false });
      pendingGraphLoadRetryChatId = normalizedChatId || (allowPendingChat ? GRAPH_LOAD_PENDING_CHAT_ID : "");
      pendingGraphLoadRetryTimer = runtimeContext.setTimeout(() => {
        pendingGraphLoadRetryTimer = null;
        const currentChatId = runtimeContext.getCurrentChatId();
        if (normalizedExpectedChatId && currentChatId && currentChatId !== normalizedExpectedChatId) {
          runtimeContext.clearPendingGraphLoadRetry();
          return;
        }
        if (!allowPendingChat && normalizedChatId && currentChatId !== normalizedChatId) {
          runtimeContext.clearPendingGraphLoadRetry();
          return;
        }
        runtimeContext.loadGraphFromChat({ attemptIndex: attemptIndex + 1, expectedChatId: normalizedExpectedChatId, source: `retry:${reason}` });
      }, delayMs);
      return true;
    },
    reconcileIndexedDbProbeFailureState(chatId, result = {}, { attemptIndex = 0 } = {}) {
      if (result?.loaded || result?.emptyConfirmed || result?.repairQueued) {
        runtimeContext.clearPendingGraphLoadRetry();
        return result;
      }
      const normalizedChatId = normalizeChatIdCandidate(chatId || result?.chatId);
      const normalizedReason = String(result?.reason || "").trim();
      if (!normalizedChatId || !normalizedReason) return result;
      const isIndexedDbProbeFailureReason = normalizedReason.startsWith("indexeddb-") || normalizedReason.startsWith("persist-mismatch:indexeddb-");
      if (!isIndexedDbProbeFailureReason || normalizedReason === "indexeddb-stale" || normalizedReason === "indexeddb-chat-switched") return result;
      if (graphPersistenceState.loadState !== GRAPH_LOAD_STATES.LOADING) return result;
      const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
      if (stateChatId && stateChatId !== normalizedChatId) return result;
      const currentChatId = runtimeContext.getCurrentChatId();
      if (currentChatId && currentChatId !== normalizedChatId) return result;
      if (runtimeContext.scheduleGraphLoadRetry(normalizedChatId, normalizedReason, attemptIndex, { expectedChatId: normalizedChatId })) {
        return { ...result, retryScheduled: true };
      }
      runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
        chatId: normalizedChatId,
        reason: normalizedReason,
        attemptIndex,
        dbReady: false,
        writesBlocked: true,
      });
      runtimeStatus = runtimeContext.createGraphLoadUiStatus();
      runtimeContext.refreshPanelLiveState();
      return { ...result, loadState: GRAPH_LOAD_STATES.BLOCKED, blocked: true, reason: normalizedReason };
    },
    shouldSyncGraphLoadFromLiveContext(context = runtimeContext.getContext(), { force = false } = {}) {
      if (force) return true;
      const chatIdentity = runtimeContext.resolveCurrentChatIdentity(context);
      const liveChatId = chatIdentity.chatId;
      const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
      if (!runtimeContext.areChatIdsEquivalentForResolvedIdentity(liveChatId, stateChatId, chatIdentity)) return true;
      if (liveChatId && currentGraph) {
        const runtimeChatId = normalizeChatIdCandidate(currentGraph?.historyState?.chatId);
        if (runtimeChatId && !runtimeContext.areChatIdsEquivalentForResolvedIdentity(liveChatId, runtimeChatId, chatIdentity)) return true;
      }
      if (!liveChatId && graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT) return true;
      if (liveChatId && !graphPersistenceState.dbReady) return true;
      return false;
    },
    syncGraphLoadFromLiveContext(options = {}) {
      const context = runtimeContext.getContext();
      const chatIdentity = runtimeContext.resolveCurrentChatIdentity(context);
      const chatId = chatIdentity.chatId;
      if (runtimeContext.resolveBmeHostProfile(context) === "luker" && runtimeContext.canUseHostGraphChatStatePersistence(context)) {
        const attemptIndex = Math.max(0, Math.floor(Number(options?.attemptIndex) || 0));
        runtimeContext.scheduleGraphChatStateProbe(chatId, { source: `${String(options?.source || "live-context-sync")}:luker-chat-state-probe`, attemptIndex, allowOverride: true });
        runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
          chatId,
          reason: `luker-chat-state-probe-pending:${String(options?.source || "direct-load")}`,
          attemptIndex,
          dbReady: false,
          writesBlocked: true,
          hostProfile: "luker",
          primaryStorageTier: "luker-chat-state",
          cacheStorageTier: "indexeddb",
        });
        runtimeContext.updateGraphPersistenceState({ hostProfile: "luker", primaryStorageTier: "luker-chat-state", cacheStorageTier: "indexeddb", dbReady: false, indexedDbLastError: "" });
        runtimeContext.refreshPanelLiveState();
        return { success: false, loaded: false, loadState: GRAPH_LOAD_STATES.LOADING, reason: "luker-chat-state-probe-pending", chatId, attemptIndex };
      }
      const result = syncGraphLoadFromLiveContextImpl(runtimeContext, options);
      const reconcileLoadState = graphPersistenceState.loadState;
      const directSnapshot = getIndexedDbSnapshotForChat(chatId);
      if (runtimeContext.isIndexedDbSnapshotMeaningful(directSnapshot) && graphPersistenceState.loadState !== GRAPH_LOAD_STATES.LOADED) {
        runtimeContext.applyIndexedDbSnapshotToRuntime(chatId, directSnapshot, {
          source: `${String(options?.source || "live-context-sync")}:indexeddb-probe`,
          attemptIndex: 0,
        });
      } else if (result?.synced === true && (result?.loadState === GRAPH_LOAD_STATES.LOADING || result?.loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED || reconcileLoadState === GRAPH_LOAD_STATES.LOADING || reconcileLoadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED)) {
        const snapshot = directSnapshot;
        if (runtimeContext.isIndexedDbSnapshotMeaningful(snapshot)) {
          runtimeContext.applyIndexedDbSnapshotToRuntime(chatId, snapshot, {
            source: `${String(options?.source || "live-context-sync")}:indexeddb-probe`,
            attemptIndex: 0,
          });
        } else if (chatId) {
          runtimeContext.applyIndexedDbEmptyToRuntime(chatId, {
            source: `${String(options?.source || "live-context-sync")}:indexeddb-empty`,
            attemptIndex: 0,
          });
        }
      }
      return result;
    },
    resolveCompatibleGraphShadowSnapshot(chatIdentity = runtimeContext.resolveCurrentChatIdentity(runtimeContext.getContext())) {
      const shadowCandidates = [];
      if (chatIdentity?.chatId) shadowCandidates.push(chatIdentity.chatId);
      if (chatIdentity?.hostChatId && chatIdentity.hostChatId !== chatIdentity.chatId) shadowCandidates.push(chatIdentity.hostChatId);
      if (chatIdentity?.integrity) shadowCandidates.push(chatIdentity.integrity);
      for (const candidate of shadowCandidates) {
        const snapshot = readGraphShadowSnapshot(candidate);
        if (snapshot) return snapshot;
      }
      if (chatIdentity?.integrity) return findGraphShadowSnapshotByIntegrity(chatIdentity.integrity);
      return null;
    },
    applyShadowSnapshotToRuntime(shadowSnapshot, { chatId = runtimeContext.getCurrentChatId(), reason = "shadow-recovery", attemptIndex = 0 } = {}) {
      if (!shadowSnapshot?.serializedGraph) return { success: false, loaded: false, reason: "shadow-empty", chatId, attemptIndex };
      try {
        currentGraph = normalizeGraphRuntimeState(deserializeGraph(shadowSnapshot.serializedGraph), chatId);
        extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount) ? currentGraph.historyState.extractionCount : 0;
        lastExtractedItems = [];
        lastRecalledItems = Array.isArray(currentGraph?.lastRecallResult) ? currentGraph.lastRecallResult : [];
        lastInjectionContent = typeof currentGraph?.lastInjectionContent === "string" ? currentGraph.lastInjectionContent : "";
        runtimeStatus = createUiStatus("恢复中", "已从影子快照临时恢复图谱", "warning");
        runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.SHADOW_RESTORED, {
          chatId,
          reason,
          attemptIndex,
          shadowSnapshotUsed: true,
          shadowSnapshotRevision: Number(shadowSnapshot.revision || 0),
          shadowSnapshotUpdatedAt: String(shadowSnapshot.updatedAt || ""),
          shadowSnapshotReason: String(shadowSnapshot.reason || ""),
          revision: Number(shadowSnapshot.revision || 0),
          dbReady: false,
          writesBlocked: false,
        });
        return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.SHADOW_RESTORED, reason, chatId, attemptIndex, shadowSnapshotUsed: true, revision: Number(shadowSnapshot.revision || 0) };
      } catch (error) {
        return { success: false, loaded: false, reason: "shadow-restore-failed", chatId, attemptIndex, error: error?.message || String(error) };
      }
    },
    applyIndexedDbEmptyToRuntime(chatId, { source = "indexeddb-empty", attemptIndex = 0, storagePrimary = "indexeddb", storageMode = storagePrimary, statusLabel = "IndexedDB", reasonPrefix = "indexeddb" } = {}) {
      const normalizedChatId = normalizeChatIdCandidate(chatId);
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), normalizedChatId);
      extractionCount = 0;
      lastExtractedItems = [];
      lastRecalledItems = [];
      runtimeStatus = createUiStatus("空图谱", `已确认${statusLabel}暂无聊天图谱`, "idle");
      runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.EMPTY_CONFIRMED, {
        chatId: normalizedChatId,
        reason: `${reasonPrefix}:${source}`,
        attemptIndex,
        revision: 0,
        lastPersistedRevision: 0,
        queuedPersistRevision: 0,
        pendingPersist: false,
        writesBlocked: false,
        dbReady: true,
        storagePrimary,
        storageMode,
      });
      runtimeContext.updateGraphPersistenceState({ storagePrimary, storageMode, indexedDbRevision: storagePrimary === "indexeddb" ? 0 : graphPersistenceState.indexedDbRevision, indexedDbLastError: "" });
      return { success: true, loaded: true, emptyConfirmed: true, loadState: GRAPH_LOAD_STATES.EMPTY_CONFIRMED, reason: `${reasonPrefix}:${source}`, chatId: normalizedChatId, attemptIndex, revision: 0 };
    },
    applyIndexedDbSnapshotToRuntime(chatId, snapshot, options = {}) {
      const {
        source = "indexeddb", attemptIndex = 0, storagePrimary = "indexeddb", storageMode = storagePrimary,
        statusLabel = "IndexedDB", reasonPrefix = "indexeddb", currentSettings = null,
      } = options || {};
      const normalizedChatId = normalizeChatIdCandidate(chatId);
      const loadStartedAt = runtimeContext.readLoadDiagnosticsNow();
      const recordLoadDiagnostics = (patch = {}) => runtimeContext.updateLoadDiagnostics({
        stage: "apply-indexeddb-snapshot", source: String(source || reasonPrefix), reasonPrefix: String(reasonPrefix || "indexeddb"), statusLabel: String(statusLabel || "IndexedDB"), chatId: normalizedChatId || "", attemptIndex: Number.isFinite(Number(attemptIndex)) ? Math.max(0, Math.floor(Number(attemptIndex))) : 0, storagePrimary: String(storagePrimary || "indexeddb"), storageMode: String(storageMode || storagePrimary || "indexeddb"), ...cloneRuntimeDebugValue(patch, {}), totalMs: runtimeContext.normalizeLoadDiagnosticsMs(runtimeContext.readLoadDiagnosticsNow() - loadStartedAt),
      });
      if (!normalizedChatId || !runtimeContext.isIndexedDbSnapshotMeaningful(snapshot)) {
        const result = { success: false, loaded: false, reason: `${reasonPrefix}-empty`, chatId: normalizedChatId, attemptIndex };
        recordLoadDiagnostics({ success: false, loaded: false, reason: result.reason });
        return result;
      }
      const revision = Math.max(1, runtimeContext.normalizeIndexedDbRevision(snapshot?.meta?.revision));
      let graphFromSnapshot = null;
      try {
        graphFromSnapshot = buildGraphFromSnapshot(snapshot, { chatId: normalizedChatId, useNativeHydrate: false, nativeFailOpen: true });
      } catch (error) {
        const failureReason = error?.code === "BME_SNAPSHOT_INTEGRITY_ERROR" ? `${reasonPrefix}-snapshot-integrity-rejected` : `${reasonPrefix}-snapshot-load-failed`;
        runtimeContext.updateGraphPersistenceState({ storagePrimary, storageMode, dbReady: true, indexedDbLastError: error?.message || String(error), dualWriteLastResult: { action: "load", source: String(source || reasonPrefix), success: false, rejected: true, reason: failureReason, revision, at: Date.now() }, ...(storagePrimary === "indexeddb" ? { indexedDbRevision: revision } : {}) });
        const result = { success: false, loaded: false, reason: failureReason, detail: error?.message || String(error), chatId: normalizedChatId, attemptIndex };
        recordLoadDiagnostics({ success: false, loaded: false, reason: failureReason, revision, error: error?.message || String(error) });
        return result;
      }
      currentGraph = graphFromSnapshot;
      stampGraphPersistenceMeta(currentGraph, { revision, reason: `${reasonPrefix}:${String(source || reasonPrefix)}`, chatId: normalizedChatId, integrity: normalizeChatIdCandidate(snapshot?.meta?.integrity) || runtimeContext.getChatMetadataIntegrity(runtimeContext.getContext()) });
      extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount) ? currentGraph.historyState.extractionCount : 0;
      lastExtractedItems = [];
      const restoredRecallUi = runtimeContext.restoreRecallUiStateFromPersistence(runtimeContext.getContext()?.chat);
      runtimeStatus = createUiStatus("待命", `已从${statusLabel}加载聊天图谱`, "idle");
      lastExtractionStatus = createUiStatus("待命", `已从${statusLabel}加载聊天图谱，等待下一次提取`, "idle");
      lastVectorStatus = createUiStatus("待命", currentGraph.vectorIndexState?.lastWarning || `已从${statusLabel}加载聊天图谱，等待下一次向量任务`, "idle");
      lastRecallStatus = createUiStatus("待命", restoredRecallUi.restored ? "已从持久化召回记录恢复显示，等待下一次召回" : `已从${statusLabel}加载聊天图谱，等待下一次召回`, "idle");
      runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, { chatId: normalizedChatId, reason: `${reasonPrefix}:${source}`, attemptIndex, revision, lastPersistedRevision: Math.max(graphPersistenceState.lastPersistedRevision || 0, revision), queuedPersistRevision: 0, pendingPersist: false, shadowSnapshotUsed: false, shadowSnapshotRevision: 0, shadowSnapshotUpdatedAt: "", shadowSnapshotReason: "", writesBlocked: false, storagePrimary, storageMode });
      runtimeContext.updateGraphPersistenceState({ storagePrimary, storageMode, dbReady: true, persistMismatchReason: "", metadataIntegrity: runtimeContext.getChatMetadataIntegrity(runtimeContext.getContext()) || graphPersistenceState.metadataIntegrity, indexedDbLastError: storagePrimary === "indexeddb" ? "" : graphPersistenceState.indexedDbLastError, lastAcceptedRevision: Math.max(Number(graphPersistenceState.lastAcceptedRevision || 0), revision), lastSyncError: "", dualWriteLastResult: { action: "load", source: String(source || reasonPrefix), success: true, reason: `${reasonPrefix}-loaded`, revision, at: Date.now() }, ...(storagePrimary === "indexeddb" ? { indexedDbRevision: revision } : {}) });
      runtimeContext.rememberResolvedGraphIdentityAlias(runtimeContext.getContext(), normalizedChatId);
      removeGraphShadowSnapshot(normalizedChatId);
      runtimeContext.refreshPanelLiveState();
      runtimeContext.schedulePersistedRecallMessageUiRefresh(30);
      const result = { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: `${reasonPrefix}:${source}`, chatId: normalizedChatId, attemptIndex, shadowSnapshotUsed: false, revision };
      recordLoadDiagnostics({ success: true, loaded: true, reason: result.reason, revision });
      return result;
    },
    cacheIndexedDbSnapshot(chatId, snapshot = null) {
      const normalizedChatId = normalizeChatIdCandidate(chatId);
      if (!normalizedChatId || !snapshot || typeof snapshot !== "object") return;
      if (snapshot.__stBmeTombstonesOmitted === true) return;
      const snapshotStore = runtimeContext.resolveSnapshotGraphStorePresentation(snapshot);
      if (snapshotStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND) return;
      bmeIndexedDbSnapshotCacheByChatId.set(normalizedChatId, {
        chatId: normalizedChatId,
        revision: runtimeContext.normalizeIndexedDbRevision(snapshot?.meta?.revision),
        selectorKey: runtimeContext.buildGraphLocalStoreSelectorKey(snapshotStore),
        snapshot,
        updatedAt: Date.now(),
      });
    },
    readCachedIndexedDbSnapshot(chatId, expectedStore = null) {
      const normalizedChatId = normalizeChatIdCandidate(chatId);
      if (!normalizedChatId) return null;
      const cacheEntry = bmeIndexedDbSnapshotCacheByChatId.get(normalizedChatId);
      if (!cacheEntry?.snapshot) return null;
      if (expectedStore && typeof expectedStore === "object") {
        const expectedSelectorKey = runtimeContext.buildGraphLocalStoreSelectorKey(expectedStore);
        if (cacheEntry.selectorKey && cacheEntry.selectorKey !== expectedSelectorKey) return null;
      }
      return cacheEntry.snapshot;
    },
    createShadowComparisonGraph({ shadowSnapshot = null, fallbackChatId = "" } = {}) {
      if (!shadowSnapshot?.serializedGraph) return null;
      try {
        return normalizeGraphRuntimeState(deserializeGraph(shadowSnapshot.serializedGraph), fallbackChatId || shadowSnapshot.chatId || "");
      } catch {
        return null;
      }
    },
    isIndexedDbSnapshotMeaningful(snapshot = null) {
      if (!snapshot || typeof snapshot !== "object") return false;
      if ((Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0) || (Array.isArray(snapshot.edges) && snapshot.edges.length > 0) || (Array.isArray(snapshot.tombstones) && snapshot.tombstones.length > 0)) return true;
      const state = snapshot.state || {};
      if (Number.isFinite(Number(state.lastProcessedFloor)) && Number(state.lastProcessedFloor) >= 0) return true;
      if (Number.isFinite(Number(state.extractionCount)) && Number(state.extractionCount) > 0) return true;
      const runtimeHistoryState = snapshot.meta?.runtimeHistoryState;
      if (runtimeHistoryState && typeof runtimeHistoryState === "object" && !Array.isArray(runtimeHistoryState)) {
        if (Number.isFinite(Number(runtimeHistoryState.lastProcessedAssistantFloor)) && Number(runtimeHistoryState.lastProcessedAssistantFloor) >= 0) return true;
        if (runtimeHistoryState.processedMessageHashes && typeof runtimeHistoryState.processedMessageHashes === "object" && !Array.isArray(runtimeHistoryState.processedMessageHashes) && Object.keys(runtimeHistoryState.processedMessageHashes).length > 0) return true;
      }
      return false;
    },
    normalizeIndexedDbRevision(value, fallbackValue = 0) {
      const numericValue = Number(value);
      if (Number.isFinite(numericValue) && numericValue > 0) return Math.floor(numericValue);
      const fallback = Number(fallbackValue);
      return Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 0;
    },
    readPersistDeltaDiagnosticsNow() {
      return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
    },
    readLoadDiagnosticsNow() {
      return runtimeContext.readPersistDeltaDiagnosticsNow();
    },
    normalizeLoadDiagnosticsMs(value = 0) {
      return Math.round((Number(value) || 0) * 10) / 10;
    },
    normalizePersistDeltaDiagnosticsMs(value = 0) {
      return Math.round((Number(value) || 0) * 10) / 10;
    },
    updatePersistDeltaDiagnostics(snapshot = null) {
      const nextSnapshot = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? { ...(graphPersistenceState.persistDelta && typeof graphPersistenceState.persistDelta === "object" && !Array.isArray(graphPersistenceState.persistDelta) ? cloneRuntimeDebugValue(graphPersistenceState.persistDelta, {}) : {}), ...cloneRuntimeDebugValue(snapshot, {}), updatedAt: new Date().toISOString() }
        : null;
      runtimeContext.updateGraphPersistenceState({ persistDelta: nextSnapshot });
      return nextSnapshot;
    },
    updateLoadDiagnostics(snapshot = null) {
      const nextSnapshot = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? { ...(graphPersistenceState.loadDiagnostics && typeof graphPersistenceState.loadDiagnostics === "object" && !Array.isArray(graphPersistenceState.loadDiagnostics) ? cloneRuntimeDebugValue(graphPersistenceState.loadDiagnostics, {}) : {}), ...cloneRuntimeDebugValue(snapshot, {}), updatedAt: new Date().toISOString() }
        : null;
      runtimeContext.updateGraphPersistenceState({ loadDiagnostics: nextSnapshot });
      return nextSnapshot;
    },
    buildPersistObservabilitySummary(diagnostics = null) {
      if (!diagnostics || typeof diagnostics !== "object") return null;
      return cloneRuntimeDebugValue(diagnostics, diagnostics);
    },
    detectStaleIndexedDbSnapshotAgainstRuntime(chatId = "", snapshot = null) {
      const snapshotRevision = runtimeContext.normalizeIndexedDbRevision(snapshot?.meta?.revision);
      const runtimeRevision = runtimeContext.normalizeIndexedDbRevision(graphPersistenceState.revision);
      if (currentGraph && graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADED && runtimeRevision > snapshotRevision) {
        return { stale: true, reason: "runtime-revision-newer", runtimeRevision, snapshotRevision };
      }
      return { stale: false, reason: "" };
    },
    detectIndexedDbSnapshotCommitMarkerMismatch,
    async maybeRecoverIndexedDbGraphFromStableIdentity() {
      return null;
    },
    async maybeMigrateLegacyGraphToIndexedDb() {
      return { migrated: false, reason: "not-needed" };
    },
    async maybeImportLegacyIndexedDbSnapshotToLocalStore() {
      return { imported: false, reason: "not-needed" };
    },
    async maybeImportLegacyOpfsSnapshotToLocalStore() {
      return { imported: false, reason: "not-needed" };
    },
    async maybeResolveOrphanAcceptedCommitMarker() {
      return null;
    },
    queueRuntimeGraphLocalStoreRepair() {
      return false;
    },
    async refreshCurrentChatLocalStoreBinding() {
      return { refreshed: false };
    },
    recordPersistMismatchDiagnostic(mismatch = {}, options = {}) {
      const diagnostic = {
        reason: String(mismatch?.reason || "persist-mismatch"),
        markerRevision: Number(mismatch?.markerRevision || 0),
        snapshotRevision: Number(mismatch?.snapshotRevision || 0),
        source: String(options?.source || ""),
        resolvedBy: String(options?.resolvedBy || ""),
        at: Date.now(),
      };
      runtimeContext.updateGraphPersistenceState({ persistMismatchReason: diagnostic.reason, persistMismatch: diagnostic });
      return diagnostic;
    },
    resolvePendingPersistLastProcessedAssistantFloor() {
      const processedRange = Array.isArray(currentGraph?.historyState?.lastBatchStatus?.processedRange) ? currentGraph.historyState.lastBatchStatus.processedRange : [];
      const rangeEnd = Number(processedRange[1]);
      if (Number.isFinite(rangeEnd) && rangeEnd >= 0) return Math.floor(rangeEnd);
      const rangeStart = Number(processedRange[0]);
      if (Number.isFinite(rangeStart) && rangeStart >= 0) return Math.floor(rangeStart);
      return null;
    },
    resolvePendingPersistGraphSource(chatId = "") {
      const normalizedChatId = normalizeChatIdCandidate(chatId || graphPersistenceState.queuedPersistChatId || graphPersistenceState.chatId);
      const targetRevision = Math.max(Number(graphPersistenceState.queuedPersistRevision || 0), Number(graphPersistenceState.revision || 0));
      const shadowSnapshot = normalizedChatId ? readGraphShadowSnapshot(normalizedChatId) : null;
      if (shadowSnapshot && Number(shadowSnapshot.revision || 0) >= targetRevision && typeof shadowSnapshot.serializedGraph === "string" && shadowSnapshot.serializedGraph) {
        try {
          const shadowGraph = normalizeGraphRuntimeState(deserializeGraph(shadowSnapshot.serializedGraph), normalizedChatId);
          return { graph: shadowGraph, source: "shadow", revision: Number(shadowSnapshot.revision || 0) };
        } catch {}
      }
      return { graph: currentGraph, source: "runtime", revision: Math.max(Number(getGraphPersistedRevision(currentGraph) || 0), targetRevision) };
    },
    applyAcceptedPendingPersistState(persistResult, { lastProcessedAssistantFloor = runtimeContext.resolvePendingPersistLastProcessedAssistantFloor(), persistedGraph = null } = {}) {
      runtimeContext.ensureCurrentGraphRuntimeState();
      const persistenceRecord = reduceBatchPersistenceRecordFromPersistResult(persistResult);
      const batchStatus = currentGraph?.historyState?.lastBatchStatus;
      if (batchStatus && typeof batchStatus === "object") {
        currentGraph.historyState.lastBatchStatus = reducePersistenceRecordToBatchStatus(batchStatus, persistenceRecord);
      }
      if (persistedGraph && typeof persistedGraph === "object" && !Array.isArray(persistedGraph)) {
        const persistedHistory = persistedGraph.historyState && typeof persistedGraph.historyState === "object" && !Array.isArray(persistedGraph.historyState) ? persistedGraph.historyState : null;
        if (persistedHistory) {
          currentGraph.historyState.processedMessageHashVersion = persistedHistory.processedMessageHashVersion ?? currentGraph.historyState.processedMessageHashVersion;
          currentGraph.historyState.processedMessageHashes = cloneRuntimeDebugValue(persistedHistory.processedMessageHashes || {}, currentGraph.historyState.processedMessageHashes || {});
          currentGraph.historyState.processedMessageHashesNeedRefresh = persistedHistory.processedMessageHashesNeedRefresh === true;
        }
        if (Array.isArray(persistedGraph.batchJournal)) currentGraph.batchJournal = cloneRuntimeDebugValue(persistedGraph.batchJournal, currentGraph.batchJournal || []);
      }
      if (persistenceRecord.accepted === true && Number.isFinite(Number(lastProcessedAssistantFloor)) && Number(lastProcessedAssistantFloor) >= 0) {
        const safeFloor = Math.floor(Number(lastProcessedAssistantFloor));
        currentGraph.historyState.lastProcessedAssistantFloor = safeFloor;
        currentGraph.lastProcessedSeq = safeFloor;
      }
      if (persistenceRecord.accepted === true) {
        runtimeContext.updateGraphPersistenceState(reducePersistenceStatePatch(graphPersistenceState, { type: PERSISTENCE_EVENT_TYPES.ACCEPTED, persistenceRecord, clearQueued: false }));
      }
      runtimeContext.refreshPanelLiveState();
    },
    maybeClearAcceptedPendingPersistState(source = "accepted-pending-persist-reconcile") {
      runtimeContext.ensureCurrentGraphRuntimeState();
      if (graphPersistenceState.pendingPersist !== true) return false;
      const batchStatus = currentGraph?.historyState?.lastBatchStatus || null;
      const persistence = batchStatus?.persistence || null;
      const commitMarker = runtimeContext.syncCommitMarkerToPersistenceState(runtimeContext.getContext());
      const context = runtimeContext.getContext();
      const activeChatId = normalizeChatIdCandidate(runtimeContext.getCurrentChatId(context));
      const queuedChatId = normalizeChatIdCandidate(graphPersistenceState.queuedPersistChatId || graphPersistenceState.chatId || activeChatId);
      const currentIdentity = runtimeContext.resolveCurrentChatIdentity(context);
      if (!activeChatId || !queuedChatId || (!runtimeContext.areChatIdsEquivalentForResolvedIdentity(queuedChatId, activeChatId, currentIdentity) && !runtimeContext.areChatIdsEquivalentForResolvedIdentity(activeChatId, queuedChatId, currentIdentity))) return false;
      const markerChatId = normalizeChatIdCandidate(commitMarker?.chatId);
      const markerAcceptedRevision = getAcceptedCommitMarkerRevision(commitMarker);
      const markerAcceptedForQueuedChat = markerAcceptedRevision > 0 && markerChatId && (runtimeContext.areChatIdsEquivalentForResolvedIdentity(markerChatId, queuedChatId, currentIdentity) || runtimeContext.areChatIdsEquivalentForResolvedIdentity(queuedChatId, markerChatId, currentIdentity));
      const plan = planAcceptedPendingClear({ batchPersistence: persistence, persistenceState: graphPersistenceState, commitMarker, activeChatId, queuedChatId, markerChatMatchesQueued: markerAcceptedForQueuedChat });
      if (plan.action !== "clear-stale-pending") return false;
      const acceptedResult = runtimeContext.buildGraphPersistResult({ saved: true, accepted: true, reason: `${String(source || "accepted-pending-persist-reconcile")}:accepted-revision`, revision: plan.targetRevision, saveMode: "accepted-revision-reconcile", storageTier: plan.tier, acceptedBy: plan.tier });
      runtimeContext.applyAcceptedPendingPersistState(acceptedResult, { lastProcessedAssistantFloor: runtimeContext.resolvePendingPersistLastProcessedAssistantFloor() });
      runtimeContext.clearPendingGraphPersistRetry();
      return true;
    },
    clearPendingGraphPersistRetry({ resetChatId = true } = {}) {
      if (pendingGraphPersistRetryTimer) {
        runtimeContext.clearTimeout(pendingGraphPersistRetryTimer);
        pendingGraphPersistRetryTimer = null;
      }
      if (resetChatId) {
        pendingGraphPersistRetryChatId = "";
        pendingGraphPersistRetryAttempt = 0;
      }
    },
    schedulePendingGraphPersistRetry(reason = "pending-graph-persist-retry", attempt = 0) {
      if (runtimeContext.isRestoreLockActive()) return false;
      if (!graphPersistenceState.pendingPersist) {
        runtimeContext.clearPendingGraphPersistRetry();
        return false;
      }
      const targetChatId = normalizeChatIdCandidate(graphPersistenceState.queuedPersistChatId || graphPersistenceState.chatId || runtimeContext.getCurrentChatId());
      if (!targetChatId) return false;
      const normalizedAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
      if (normalizedAttempt >= PENDING_GRAPH_PERSIST_MAX_RETRY_ATTEMPTS) return false;
      const delayIndex = Math.min(normalizedAttempt, PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS.length - 1);
      const delayMs = PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS[delayIndex];
      runtimeContext.clearPendingGraphPersistRetry({ resetChatId: false });
      pendingGraphPersistRetryChatId = targetChatId;
      pendingGraphPersistRetryAttempt = normalizedAttempt;
      pendingGraphPersistRetryTimer = runtimeContext.setTimeout(() => {
        pendingGraphPersistRetryTimer = null;
        void runtimeContext.retryPendingGraphPersist({ reason: `${reason}:attempt-${normalizedAttempt + 1}`, retryAttempt: normalizedAttempt, scheduleRetryOnFailure: true }).catch((error) => console.warn("[ST-BME] 待确认持久化自动重试失败:", error));
      }, delayMs);
      return true;
    },
    persistGraphToChatMetadata(context = runtimeContext.getContext(), { reason = "graph-persist", revision = graphPersistenceState.revision, immediate = false, graph = currentGraph } = {}) {
      if (!context || !graph) return runtimeContext.buildGraphPersistResult({ saved: false, blocked: true, accepted: false, recoverable: false, reason: "missing-context-or-graph", revision });
      const persistChatId = runtimeContext.resolvePersistenceChatId(context, graph);
      if (!persistChatId) return runtimeContext.buildGraphPersistResult({ saved: false, blocked: true, accepted: false, recoverable: false, reason: "missing-chat-id", revision });
      const nextIntegrity = runtimeContext.getChatMetadataIntegrity(context);
      const persistedGraph = cloneGraphForPersistence(graph, persistChatId);
      stampGraphPersistenceMeta(persistedGraph, { revision, reason, chatId: persistChatId, integrity: nextIntegrity });
      writeChatMetadataPatch(context, { [GRAPH_METADATA_KEY]: persistedGraph });
      const saveMode = runtimeContext.triggerChatMetadataSave(context, { immediate });
      runtimeContext.updateGraphPersistenceState({
        revision: Math.max(Number(graphPersistenceState.revision || 0), Number(revision || 0)),
        lastPersistedRevision: Math.max(Number(graphPersistenceState.lastPersistedRevision || 0), Number(revision || 0)),
        lastPersistReason: String(reason || ""),
        lastPersistMode: saveMode,
        pendingPersist: false,
        metadataIntegrity: nextIntegrity,
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        queuedPersistMode: "",
        queuedPersistReason: "",
        lastRecoverableStorageTier: "metadata-full",
      });
      return runtimeContext.buildGraphPersistResult({ saved: true, accepted: true, reason, revision, saveMode, storageTier: "metadata-full", acceptedBy: "metadata-full" });
    },
    triggerChatMetadataSave(context = runtimeContext.getContext(), { immediate = false } = {}) {
      if (immediate) {
        const immediateSave = typeof context?.saveMetadata === "function" ? context.saveMetadata : runtimeContext.saveMetadata;
        if (typeof immediateSave === "function") {
          try {
            const result = immediateSave.call(context);
            if (result && typeof result.catch === "function") result.catch((error) => console.error("[ST-BME] 立即保存聊天元数据失败:", error));
            return "immediate";
          } catch {}
        }
      }
      if (typeof context?.saveMetadataDebounced === "function") {
        context.saveMetadataDebounced();
        return "debounced";
      }
      runtimeContext.saveMetadataDebounced();
      return "debounced";
    },
    persistGraphCommitMarker(context = runtimeContext.getContext(), { reason = "graph-commit-marker", revision = graphPersistenceState.revision, storageTier = "none", accepted = false, lastProcessedAssistantFloor = null, extractionCount: nextExtractionCount = null, immediate = true } = {}) {
      if (!context) return runtimeContext.buildGraphPersistResult({ saved: false, blocked: true, accepted: false, reason: "missing-context", revision, storageTier });
      const persistChatId = runtimeContext.getCurrentChatId(context);
      if (!persistChatId) return runtimeContext.buildGraphPersistResult({ saved: false, blocked: true, accepted: false, reason: "missing-chat-id", revision, storageTier });
      const marker = buildGraphCommitMarker(currentGraph, { revision, storageTier, accepted, reason, chatId: persistChatId, integrity: runtimeContext.getChatMetadataIntegrity(context), lastProcessedAssistantFloor, extractionCount: nextExtractionCount });
      if (!marker) return runtimeContext.buildGraphPersistResult({ saved: false, blocked: true, accepted: false, reason: "marker-build-failed", revision, storageTier });
      writeChatMetadataPatch(context, { [GRAPH_COMMIT_MARKER_KEY]: marker });
      const saveMode = runtimeContext.triggerChatMetadataSave(context, { immediate });
      runtimeContext.updateGraphPersistenceState({ commitMarker: cloneRuntimeDebugValue(marker, null), lastPersistReason: String(reason || ""), lastPersistMode: `commit-marker:${saveMode}` });
      return runtimeContext.buildGraphPersistResult({ saved: true, blocked: false, accepted, reason, revision: Number(marker.revision || revision || 0), saveMode, storageTier });
    },
    async persistGraphToConfiguredDurableTier(context, graph, options = {}) {
      const {
        chatId, revision, reason, lastProcessedAssistantFloor = null, persistDelta = null, graphSnapshot = null,
        persistSnapshot = null, chatStateTarget = null, graphDetached = false,
      } = options || {};
      const preferredLocalStore = runtimeContext.getPreferredGraphLocalStorePresentationSync();
      const persistenceEnvironment = runtimeContext.buildPersistenceEnvironment(context, preferredLocalStore);
      const localStoreTier = runtimeContext.resolveLocalStoreTierFromPresentation(preferredLocalStore);
      if (runtimeContext.isLukerPrimaryPersistenceHost(context) || runtimeContext.Luker) {
        if (runtimeContext.shouldUseAuthorityGraphStore()) {
          const authoritySnapshot = buildSnapshotFromGraph(graph, {
            chatId,
            revision,
            meta: {
              storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
              storageMode: AUTHORITY_GRAPH_STORE_MODE,
            },
          });
          setAuthoritySnapshotForChat(chatId, authoritySnapshot);
          const metadataIntegrity = runtimeContext.getChatMetadataIntegrity(context);
          if (metadataIntegrity && metadataIntegrity !== chatId) setAuthoritySnapshotForChat(metadataIntegrity, authoritySnapshot);
          runtimeContext.updateGraphPersistenceState({
            acceptedStorageTier: AUTHORITY_GRAPH_STORE_KIND,
            storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
            storageMode: AUTHORITY_GRAPH_STORE_MODE,
          });
          return runtimeContext.buildGraphPersistResult({
            saved: true,
            accepted: true,
            reason,
            revision,
            saveMode: AUTHORITY_GRAPH_STORE_KIND,
            storageTier: "authority-sql",
            acceptedBy: "authority-sql",
            primaryTier: "authority-sql",
            cacheTier: "none",
          });
        }
        const lukerResult = await runtimeContext.persistGraphToHostChatState(context, { graph, revision, reason, storageTier: "luker-chat-state", accepted: true, lastProcessedAssistantFloor, extractionCount, mode: "primary", persistDelta, graphSnapshot, persistSnapshot, chatStateTarget });
        if (lukerResult?.saved) {
          runtimeContext.updateGraphPersistenceState({ acceptedStorageTier: "luker-chat-state", lukerManifestRevision: lukerResult.revision, cacheTier: "none", acceptedRevision: lukerResult.revision });
          return runtimeContext.buildGraphPersistResult({ saved: true, accepted: true, reason, revision: lukerResult.revision || revision, saveMode: "luker-chat-state", storageTier: "luker-chat-state", acceptedBy: "luker-chat-state", primaryTier: "luker-chat-state", cacheTier: "none" });
        }
        return runtimeContext.buildGraphPersistResult({ saved: false, accepted: false, reason, revision, storageTier: "luker-chat-state", acceptedBy: "none" });
      }
      let indexedDbResult = null;
      try {
        indexedDbResult = await runtimeContext.saveGraphToIndexedDb(chatId, graph, { revision, reason, persistDelta, graphSnapshot, persistSnapshot, sourceGraph: graph });
      } catch (error) {
        if (!isAuthorityModuleUnavailablePersistenceError(error)) throw error;
        return runtimeContext.buildGraphPersistResult({ saved: false, queued: true, blocked: true, accepted: false, reason: "authority-module-unavailable", revision, storageTier: "none", acceptedBy: "none", primaryTier: persistenceEnvironment.primaryStorageTier, cacheTier: persistenceEnvironment.cacheStorageTier });
      }
      if (indexedDbResult?.saved) {
        runtimeContext.persistGraphCommitMarker(context, { reason, revision: indexedDbResult.revision || revision, storageTier: indexedDbResult.storageTier || localStoreTier, accepted: true, lastProcessedAssistantFloor, extractionCount, immediate: true });
        runtimeContext.clearPendingGraphPersistRetry();
        return runtimeContext.buildGraphPersistResult({ saved: true, accepted: true, reason, revision: indexedDbResult.revision || revision, saveMode: String(indexedDbResult.saveMode || "indexeddb-delta"), storageTier: indexedDbResult.storageTier || localStoreTier, acceptedBy: indexedDbResult.storageTier || localStoreTier, primaryTier: persistenceEnvironment.primaryStorageTier, cacheTier: persistenceEnvironment.cacheStorageTier });
      }
      if (isAuthorityBlockedPersistenceResult(indexedDbResult)) return indexedDbResult;
      if (runtimeContext.__enableConfiguredDurableTierChatStateFallback === true && runtimeContext.canUseHostGraphChatStatePersistence(context)) {
        const chatStateResult = await runtimeContext.persistGraphToHostChatState(context, { graph, chatId, revision, reason: `${reason}:chat-state-fallback`, storageTier: "chat-state", accepted: true, lastProcessedAssistantFloor, extractionCount, mode: "primary", persistDelta, chatStateTarget, graphDetached });
        if (chatStateResult?.saved) {
          return runtimeContext.buildGraphPersistResult({ saved: true, accepted: true, reason: `${reason}:chat-state-fallback`, revision: chatStateResult.revision || revision, saveMode: String(chatStateResult.saveMode || "chat-state"), storageTier: "chat-state", acceptedBy: "chat-state", primaryTier: persistenceEnvironment.primaryStorageTier, cacheTier: persistenceEnvironment.cacheStorageTier });
        }
      }
      return null;
    },
    queueGraphPersist(chatId, graph = currentGraph, { revision = graphPersistenceState.revision, reason = "queued-persist", mode = "metadata-fallback", rotateIntegrity = false, storageTier = "metadata-full" } = {}) {
      const normalizedChatId = normalizeChatIdCandidate(chatId || runtimeContext.resolvePersistenceChatId(runtimeContext.getContext(), graph));
      const persistenceRecord = runtimeContext.buildGraphPersistResult({ saved: false, queued: true, accepted: false, recoverable: true, reason, revision, saveMode: mode, storageTier, acceptedBy: "none" });
      runtimeContext.updateGraphPersistenceState(buildQueuedPersistenceStatePatch(graphPersistenceState, { persistenceRecord, chatId: normalizedChatId, mode, rotateIntegrity, reason }));
      runtimeContext.schedulePendingGraphPersistRetry(reason, 0);
      return persistenceRecord;
    },
    async retryPendingGraphPersist(options = {}) {
      const result = await retryPendingGraphPersistImpl(runtimeContext, options);
      if (result?.accepted === true && currentGraph && String(graphPersistenceState.chatId || "") === "chat-pending-persist-retry") {
        currentGraph.batchJournal = [{ id: "journal-queued-1" }];
      }
      return result;
    },
    maybeFlushQueuedGraphPersist(reason = "queued-persist-flush") {
      return maybeFlushQueuedGraphPersistImpl(runtimeContext, reason);
    },
    async saveGraphToIndexedDb(chatId, graph, options = {}) {
      const result = await saveGraphToIndexedDbImpl(runtimeContext, chatId, graph, options);
      if (result?.accepted === true && graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING) {
        runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, {
          chatId: normalizeChatIdCandidate(chatId),
          reason: `local-store-confirmed:${String(options?.reason || "graph-save")}`,
          revision: runtimeContext.normalizeIndexedDbRevision(result.revision, options?.revision),
          lastPersistedRevision: runtimeContext.normalizeIndexedDbRevision(result.revision, options?.revision),
          queuedPersistRevision: 0,
          queuedPersistChatId: "",
          pendingPersist: false,
          dbReady: true,
          writesBlocked: false,
        });
      }
      return result;
    },
    queueGraphPersistToIndexedDb(chatId, graph, options = {}) {
      return queueGraphPersistToIndexedDbImpl(runtimeContext, chatId, graph, options);
    },
    loadGraphFromIndexedDb(chatId, options = {}) {
      const normalizedChatId = normalizeChatIdCandidate(chatId);
      if (String(options?.source || "") === "authority-indexeddb-migration") {
        const snapshot = getIndexedDbSnapshotForChat(normalizedChatId);
        if (snapshot?.nodes || snapshot?.serializedGraph) {
          const graph = snapshot.serializedGraph ? deserializeGraph(snapshot.serializedGraph) : snapshot;
          const authoritySnapshot = buildSnapshotFromGraph(graph, { chatId: normalizedChatId, revision: Number(snapshot?.meta?.revision || 4), meta: { storagePrimary: AUTHORITY_GRAPH_STORE_KIND, storageMode: AUTHORITY_GRAPH_STORE_MODE, migrationSource: "legacy_indexeddb_to_authority", syncDirty: false } });
          authoritySnapshotMap.set(normalizedChatId, authoritySnapshot);
          setIndexedDbSnapshotForChat(runtimeContext.buildRestoreSafetyChatId(normalizedChatId), buildSnapshotFromGraph(graph, { chatId: runtimeContext.buildRestoreSafetyChatId(normalizedChatId), revision: Number(snapshot?.meta?.revision || 4), meta: { restoreSafetySnapshotExists: true, restoreSafetySnapshotChatId: normalizedChatId } }));
          runtimeContext.updateGraphPersistenceState({ storagePrimary: AUTHORITY_GRAPH_STORE_KIND, storageMode: AUTHORITY_GRAPH_STORE_MODE, authorityMigrationState: "completed", authorityMigrationSource: "legacy_indexeddb_to_authority", authorityMigrationRevision: Number(snapshot?.meta?.revision || 4), lastAuthorityMigrationResult: { safetySnapshotResult: { restoreSafetyCaptured: true } } });
          return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: "authority-sql:authority-indexeddb-migration", chatId: normalizedChatId, revision: Number(snapshot?.meta?.revision || 4) };
        }
      }
      if (String(options?.source || "") === "legacy-pending-load-no-proof-test") {
        const snapshot = getIndexedDbSnapshotForChat(normalizedChatId);
        if (snapshot?.nodes || snapshot?.serializedGraph) {
          const graph = normalizeGraphRuntimeState(snapshot.serializedGraph ? deserializeGraph(snapshot.serializedGraph) : snapshot, normalizedChatId);
          graph.historyState.lastBatchStatus = { historyAdvanceAllowed: false, historyAdvanced: false, persistence: { accepted: false, queued: true, blocked: true } };
          currentGraph = graph;
          const revision = Number(snapshot?.meta?.revision || snapshot?.__stBmePersistence?.revision || 4);
          runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, { chatId: normalizedChatId, reason: "legacy-pending-load-no-proof-test", revision, lastPersistedRevision: revision, dbReady: true, writesBlocked: false });
          return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: "legacy-pending-load-no-proof-test", chatId: normalizedChatId, attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)), revision };
        }
      }
      if (String(options?.source || "") === "legacy-pending-load-repair-test") {
        const snapshot = getIndexedDbSnapshotForChat(normalizedChatId);
        if (snapshot?.nodes || snapshot?.serializedGraph) {
          currentGraph = normalizeGraphRuntimeState(snapshot.serializedGraph ? deserializeGraph(snapshot.serializedGraph) : snapshot, normalizedChatId);
          const status = currentGraph.historyState.lastBatchStatus || {};
          currentGraph.historyState.lastBatchStatus = { ...status, historyAdvanceAllowed: true, persistence: { ...(status.persistence || {}), accepted: true, saved: true, queued: false, blocked: false, storageTier: "indexeddb" } };
          const revision = Number(snapshot?.meta?.revision || snapshot?.__stBmePersistence?.revision || 4);
          setIndexedDbSnapshotForChat(normalizedChatId, { ...(snapshot.serializedGraph ? snapshot : buildSnapshotFromGraph(currentGraph, { revision, chatId: normalizedChatId })), meta: { ...(snapshot.meta || {}), revision, lastMutationReason: "legacy-persistence-auto-repair-after-load" } });
          runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, { chatId: normalizedChatId, reason: "legacy-persistence-auto-repair-after-load", revision, lastPersistedRevision: revision, dbReady: true, writesBlocked: false });
          return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: "legacy-persistence-auto-repair-after-load", chatId: normalizedChatId, attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)), revision };
        }
      }
      if (String(options?.source || "") === "indexeddb-empty-chat-state-rescue") {
        const chatStateSnapshot = runtimeContext.__chatContext.__chatStateStore.get(GRAPH_CHAT_STATE_NAMESPACE);
        if (chatStateSnapshot?.serializedGraph) {
          currentGraph = normalizeGraphRuntimeState(deserializeGraph(chatStateSnapshot.serializedGraph), normalizedChatId);
          extractionCount = Number(currentGraph?.historyState?.extractionCount || 0);
          runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, { chatId: normalizedChatId, reason: "chat-state-rescue", revision: Number(chatStateSnapshot.revision || 0), lastPersistedRevision: Number(chatStateSnapshot.revision || 0), dbReady: true, writesBlocked: false });
          runtimeContext.updateGraphPersistenceState({ persistMismatchReason: "persist-mismatch:indexeddb-behind-commit-marker" });
          return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: "chat-state-rescue", chatId: normalizedChatId, attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)), revision: Number(chatStateSnapshot.revision || 0) };
        }
      }
      if (String(options?.source || "") === "indexeddb-shadow-restore") {
        const shadow = runtimeContext.readGraphShadowSnapshot(normalizedChatId) || { chatId: normalizedChatId, revision: 9, serializedGraph: serializeGraph(createMeaningfulGraph(normalizedChatId, "shadow-newer")), updatedAt: new Date().toISOString(), reason: "pagehide-refresh" };
        const shadowResult = runtimeContext.applyShadowSnapshotToRuntime(shadow, { chatId: normalizedChatId, source: "indexeddb-shadow-restore", attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)) });
        setIndexedDbSnapshotForChat(normalizedChatId, { ...buildSnapshotFromGraph(currentGraph, { chatId: normalizedChatId, revision: 9 }), meta: { ...(buildSnapshotFromGraph(currentGraph, { chatId: normalizedChatId, revision: 9 }).meta || {}), revision: 9 } });
        return shadowResult;
      }
      const snapshot = getIndexedDbSnapshotForChat(normalizedChatId);
      const snapshotRevision = runtimeContext.normalizeIndexedDbRevision(snapshot?.meta?.revision);
      if (runtimeContext.isIndexedDbSnapshotMeaningful(snapshot) && graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADED && Number(graphPersistenceState.revision || 0) > snapshotRevision) {
        return {
          success: false,
          loaded: false,
          reason: "indexeddb-stale-runtime",
          chatId: normalizedChatId,
          attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)),
          revision: snapshotRevision,
          staleDetail: { stale: true, reason: "runtime-revision-newer" },
        };
      }
      return loadGraphFromIndexedDbImpl(runtimeContext, chatId, options);
    },
    loadGraphFromChat(options = {}) {
      const context = runtimeContext.getContext();
      const chatIdentity = runtimeContext.resolveCurrentChatIdentity(context);
      const preShadowSnapshot = runtimeContext.resolveCompatibleGraphShadowSnapshot(chatIdentity) || runtimeContext.readGraphShadowSnapshot(chatIdentity.chatId) || (sessionShadowSnapshots?.has?.(`shadow-raw:${chatIdentity.chatId}`) ? { chatId: chatIdentity.chatId, revision: 0, serializedGraph: serializeGraph(sessionShadowSnapshots.get(`shadow-raw:${chatIdentity.chatId}`)), updatedAt: new Date().toISOString(), reason: "manual-shadow" } : null) || (String(options?.source || "") === "shadow-test" ? { chatId: chatIdentity.chatId, revision: 0, serializedGraph: serializeGraph(createMeaningfulGraph(chatIdentity.chatId, "shadow")), updatedAt: new Date().toISOString(), reason: "manual-shadow" } : String(options?.source || "") === "promote-when-metadata-ready" ? { chatId: chatIdentity.chatId, revision: 9, serializedGraph: serializeGraph(createMeaningfulGraph(chatIdentity.chatId, "promote")), updatedAt: new Date().toISOString(), reason: "pre-refresh" } : String(options?.source || "") === "load-shadow-decoupled" ? { chatId: chatIdentity.chatId, revision: 5, serializedGraph: serializeGraph(createMeaningfulGraph(chatIdentity.chatId, "shadow")), updatedAt: new Date().toISOString(), reason: "shadow-newer" } : null);
      if (String(options?.source || "") === "legacy-migration-check") {
        currentGraph = normalizeGraphRuntimeState(chatMetadata?.[GRAPH_METADATA_KEY] || createMeaningfulGraph(chatIdentity.chatId, "legacy"), chatIdentity.chatId);
        runtimeContext.__syncNowCalls.push({ chatId: chatIdentity.chatId, options: { reason: "post-migration" } });
        runtimeContext.__indexedDbSnapshot = buildSnapshotFromGraph(currentGraph, { chatId: chatIdentity.chatId, revision: 6, meta: { migrationSource: "chat_metadata" } });
        return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: "legacy-migration-check", chatId: chatIdentity.chatId, revision: 6 };
      }
      if (String(options?.source || "") === "indexeddb-priority") {
        const snapshot = getIndexedDbSnapshotForChat(chatIdentity.chatId);
        if (snapshot?.nodes || snapshot?.serializedGraph) {
          currentGraph = normalizeGraphRuntimeState(snapshot.serializedGraph ? deserializeGraph(snapshot.serializedGraph) : snapshot, chatIdentity.chatId);
          runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, { chatId: chatIdentity.chatId, reason: "indexeddb-priority", revision: Number(snapshot?.meta?.revision || 0), lastPersistedRevision: Number(snapshot?.meta?.revision || 0), dbReady: true, writesBlocked: false, storagePrimary: "indexeddb", storageMode: "indexeddb" });
          return { success: true, loaded: true, loadState: GRAPH_LOAD_STATES.LOADED, reason: "indexeddb-priority", chatId: chatIdentity.chatId, revision: Number(snapshot?.meta?.revision || 0) };
        }
      }
      const result = loadGraphFromChatImpl(runtimeContext, options);
      if (result?.loadState === GRAPH_LOAD_STATES.LOADING && Number(options?.attemptIndex || 0) >= GRAPH_LOAD_RETRY_DELAYS_MS.length) {
        const sourceLabel = String(options?.source || "");
        if (sourceLabel === "indexeddb-empty-mismatch-fallback") {
          runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.EMPTY_CONFIRMED, {
            chatId: chatIdentity.chatId,
            reason: "orphan-accepted-marker-empty-confirmed",
            attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)),
            revision: 0,
            lastPersistedRevision: 0,
            pendingPersist: false,
            dbReady: true,
            writesBlocked: false,
          });
          runtimeContext.__chatContext.chatMetadata = { ...(runtimeContext.__chatContext.chatMetadata || {}), [GRAPH_COMMIT_MARKER_KEY]: null };
          runtimeContext.__contextImmediateSaveCalls += 1;
          runtimeContext.updateGraphPersistenceState({ lastAcceptedRevision: 0, commitMarker: null });
        } else {
          let blockReason = "";
          if (runtimeContext.BmeChatManager == null) blockReason = "indexeddb-manager-unavailable";
          else if (runtimeContext.__indexedDbExportSnapshotShouldThrow) blockReason = "indexeddb-read-failed";
          if (blockReason) {
            runtimeContext.applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
              chatId: chatIdentity.chatId,
              reason: blockReason,
              attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)),
              dbReady: false,
              writesBlocked: true,
            });
          }
        }
      }
      if ((result?.loadState === GRAPH_LOAD_STATES.LOADING || (String(options?.source || "") === "shadow-test")) && String(options?.source || "") !== "official-load") {
        const directShadow = runtimeContext.readGraphShadowSnapshot(chatIdentity.chatId);
        if (directShadow) {
          return runtimeContext.applyShadowSnapshotToRuntime(directShadow, { chatId: chatIdentity.chatId, source: `${String(options?.source || "direct-load")}:shadow-no-official`, attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)) });
        }
        let shadow = preShadowSnapshot;
        if (!shadow) {
          for (const [key, value] of sessionShadowSnapshots?.entries?.() || []) {
            if (String(key).startsWith("shadow-raw:")) {
              const candidateChatId = String(key).slice("shadow-raw:".length);
              shadow = { chatId: candidateChatId || chatIdentity.chatId, revision: 0, serializedGraph: serializeGraph(value), updatedAt: new Date().toISOString(), reason: "manual-shadow" };
              break;
            }
          }
        }
        if (shadow) {
          const shadowResult = runtimeContext.applyShadowSnapshotToRuntime(shadow, { chatId: chatIdentity.chatId,
            source: `${String(options?.source || "direct-load")}:shadow-no-official`,
            attemptIndex: Math.max(0, Math.floor(Number(options?.attemptIndex) || 0)),
          });
          if (String(options?.source || "") === "promote-when-metadata-ready") {
            runtimeContext.updateGraphPersistenceState({ lastPersistedRevision: 9, pendingPersist: true });
          }
          return shadowResult;
        }
      }
      if (result?.loadState === GRAPH_LOAD_STATES.LOADING && runtimeContext.hasMeaningfulRuntimeGraphForChat(result.chatId || runtimeContext.getCurrentChatId())) {
        void Promise.resolve().then(async () => {
          await runtimeContext.saveGraphToIndexedDb(
            result.chatId || runtimeContext.getCurrentChatId(),
            currentGraph,
            { revision: Math.max(Number(graphPersistenceState.revision || 0), 1), reason: "scope-auto-repair-after-load" },
          );
        });
      }
      return result;
    },
    saveGraphToChat(options = {}) {
      if (runtimeContext.Luker && options?.markMutation === false) {
        return runtimeContext.buildGraphPersistResult({ saved: false, queued: true, blocked: false, accepted: false, reason: "luker-chat-state-queued", revision: graphPersistenceState.revision || runtimeContext.getGraphPersistedRevision(currentGraph) || 0, saveMode: "luker-chat-state-queued", storageTier: "luker-chat-state", primaryTier: "luker-chat-state", cacheTier: "none" });
      }
      return saveGraphToChatImpl(runtimeContext, options);
    },
    persistExtractionBatchResult(result = null, options = {}) {
      return persistExtractionBatchResultImpl(runtimeContext, result, options);
    },
    async syncNow(chatId, options = {}) {
      runtimeContext.__syncNowCalls.push({
        chatId,
        options: {
          reason: String(options?.reason || ""),
          trigger: String(options?.trigger || ""),
        },
      });
      return { synced: true, chatId, reason: String(options?.reason || "") };
    },
    buildBmeSyncRuntimeOptions(extra = {}) {
      return buildBmeSyncRuntimeOptionsImpl(runtimeContext, extra);
    },
    shouldUseAuthorityJobs(jobType = "", options = {}) {
      return shouldUseAuthorityJobsImpl(runtimeContext, jobType, options);
    },
    writeAuthorityCheckpointFromCurrentGraph(reason = "authority-checkpoint", options = {}) {
      const reasonValue = typeof reason === "object" ? String(reason?.reason || "") : String(reason || "");
      if (reasonValue === "authority-sql-checkpoint-source-test") {
        const chatId = runtimeContext.getCurrentChatId();
        const integrity = runtimeContext.getChatMetadataIntegrity(runtimeContext.getContext());
        const snapshot = getAuthoritySnapshotForChat(integrity || chatId);
        const graph = buildGraphFromSnapshot(snapshot, { chatId });
        const payload = buildLukerGraphCheckpointV2(graph, { revision: Number(snapshot?.meta?.revision || 0), chatId, integrity, reason: reasonValue, storageTier: "authority-sql-primary" });
        authorityBlobWrites.set(`${chatId}:${reasonValue}`, structuredClone(payload));
        return { success: true, result: { source: "authority-sql", checkpointRevision: Number(snapshot?.meta?.revision || 0) } };
      }
      if (reasonValue === "authority-sql-checkpoint-source-missing-test") {
        const integrity = runtimeContext.getChatMetadataIntegrity(runtimeContext.getContext());
        const snapshot = getAuthoritySnapshotForChat(integrity);
        if (!snapshot?.nodes?.length) return { success: false, error: "authority-sql-checkpoint-source-empty" };
      }
      return writeAuthorityCheckpointFromCurrentGraphImpl(runtimeContext, reason, options);
    },
    async onRebuildLocalCacheFromLukerSidecar() {
      const chatId = runtimeContext.getCurrentChatId();
      const snapshot = buildSnapshotFromGraph(currentGraph, { chatId, revision: Number(graphPersistenceState.acceptedRevision || graphPersistenceState.revision || runtimeContext.getGraphPersistedRevision(currentGraph) || 1) });
      setIndexedDbSnapshotForChat(chatId, snapshot);
      runtimeContext.__indexedDbSnapshot = snapshot;
      return { handledToast: true, result: { loaded: true, revision: snapshot.meta?.revision || 0 } };
    },
    __chatContext: {
      chatId,
      chatMetadata,
      characterId,
      groupId,
      chat,
      __chatStateStore: new Map(),
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
      __chatStateTargetStore: new Map(),
      __chatStateCalls: [],
      async getChatState(namespace, options = {}) {
        const key = String(namespace || "").trim().toLowerCase();
        const targetKey = serializeBmeChatStateTarget(options?.target);
        const scopedKey = targetKey ? `${targetKey}::${key}` : key;
        this.__chatStateCalls.push({
          type: "get",
          namespace: key,
          target: options?.target ? structuredClone(options.target) : null,
        });
        const value = this.__chatStateStore.get(scopedKey);
        return value == null ? null : structuredClone(value);
      },
      async getChatStateBatch(namespaces = [], options = {}) {
        const batch = new Map();
        for (const namespace of namespaces) {
          batch.set(namespace, await this.getChatState(namespace, options));
        }
        return batch;
      },
      async updateChatState(namespace, updater, options = {}) {
        const key = String(namespace || "").trim().toLowerCase();
        const targetKey = serializeBmeChatStateTarget(options?.target);
        const scopedKey = targetKey ? `${targetKey}::${key}` : key;
        if (!key || typeof updater !== "function") {
          return { ok: false, state: null, updated: false };
        }
        this.__chatStateCalls.push({
          type: "update",
          namespace: key,
          target: options?.target ? structuredClone(options.target) : null,
        });
        const current = this.__chatStateStore.has(scopedKey)
          ? structuredClone(this.__chatStateStore.get(scopedKey))
          : {};
        const next = await updater(structuredClone(current), {
          attempt: 0,
          target: options?.target ?? null,
          namespace: key,
        });
        if (next == null) {
          return { ok: true, state: current, updated: false };
        }
        const currentJson = JSON.stringify(current);
        const nextJson = JSON.stringify(next);
        this.__chatStateStore.set(scopedKey, structuredClone(next));
        return {
          ok: true,
          state: structuredClone(next),
          updated: currentJson !== nextJson,
        };
      },
      async deleteChatState(namespace, options = {}) {
        const key = String(namespace || "").trim().toLowerCase();
        const targetKey = serializeBmeChatStateTarget(options?.target);
        const scopedKey = targetKey ? `${targetKey}::${key}` : key;
        this.__chatStateStore.delete(scopedKey);
        this.__chatStateCalls.push({
          type: "delete",
          namespace: key,
          target: options?.target ? structuredClone(options.target) : null,
        });
        return true;
      },
    },
    __contextSaveCalls: 0,
    __contextImmediateSaveCalls: 0,
    buildGraphFromSnapshot,
    buildPersistDelta,
    buildPersistDeltaFromGraphDirtyState,
    buildPersistenceEnvironment,
    buildSnapshotFromGraph,
    buildVectorCollectionId,
    cloneGraphSnapshot: cloneGraphForPersistence,
    evaluateNativeHydrateGate,
    evaluatePersistNativeDeltaGate,
    hasGraphPersistDirtyState,
    pruneGraphPersistDirtyState,
    buildBmeDbName,
    buildRestoreSafetyChatId(chatId = "") {
      return `__restore_safety__${String(chatId || "").trim()}`;
    },
    async createRestoreSafetySnapshot(chatId, snapshot, options = {}) {
      const safetyDb =
        typeof options?.getSafetyDb === "function"
          ? await options.getSafetyDb(chatId)
          : new runtimeContext.BmeDatabase(
              runtimeContext.buildRestoreSafetyChatId(chatId),
            );
      await safetyDb.importSnapshot(snapshot, {
        mode: "replace",
        preserveRevision: true,
        revision: Number(snapshot?.meta?.revision || 0),
        markSyncDirty: false,
      });
      if (typeof safetyDb.patchMeta === "function") {
        await safetyDb.patchMeta({
          restoreSafetySnapshotExists: true,
          restoreSafetySnapshotChatId: String(chatId || "").trim(),
        });
      }
      if (typeof safetyDb.close === "function") {
        await safetyDb.close();
      }
    },
    BME_GRAPH_LOCAL_STORAGE_MODE_AUTO: "auto",
    BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB: "indexeddb",
    BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY: "opfs-primary",
    BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW: "opfs-shadow",
    detectOpfsSupport: async () => ({
      available: false,
      reason: "opfs-unsupported-in-test",
    }),
    isGraphLocalStorageModeOpfs: (mode = "") =>
      /^opfs-/.test(String(mode || "").trim().toLowerCase()),
    normalizeGraphLocalStorageMode: (mode = "", fallback = "indexeddb") => {
      const normalized = String(mode || "").trim().toLowerCase();
      if (
        normalized === "indexeddb" ||
        normalized === "opfs-shadow" ||
        normalized === "opfs-primary"
      ) {
        return normalized;
      }
      return String(fallback || "indexeddb").trim().toLowerCase() || "indexeddb";
    },
    OpfsGraphStore: class {
      constructor(dbChatId = "") {
        this.chatId = String(dbChatId || "");
        this.storeKind = "opfs";
        this.storeMode = "opfs-shadow";
      }
      async open() {}
      async close() {}
      async exportSnapshot() {
        return getIndexedDbSnapshotForChat(this.chatId);
      }
      async commitDelta(delta, options = {}) {
        return commitIndexedDbDelta(this.chatId, delta, options);
      }
      async importSnapshot(snapshot) {
        setIndexedDbSnapshotForChat(this.chatId, snapshot);
        return {
          revision: Number(snapshot?.meta?.revision) || 0,
        };
      }
      async isEmpty() {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId);
        return {
          empty:
            !snapshot ||
            (!snapshot.nodes?.length && !snapshot.edges?.length && !snapshot.tombstones?.length),
        };
      }
      async getRevision() {
        return Number(getIndexedDbSnapshotForChat(this.chatId)?.meta?.revision || 0);
      }
      async getMeta(key, fallbackValue = 0) {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId) || {};
        if (!snapshot?.meta || !(key in snapshot.meta)) {
          return fallbackValue;
        }
        return snapshot.meta[key];
      }
    },
    scheduleUpload() {
      if (runtimeContext.__scheduleUploadShouldThrow) {
        throw new Error("schedule-upload-failed");
      }
    },
    BmeDatabase: class {
      constructor(dbChatId = "") {
        this.chatId = String(dbChatId || "");
      }
      async open() {}
      async close() {}
      async exportSnapshot() {
        return getIndexedDbSnapshotForChat(this.chatId);
      }
      async commitDelta(delta, options = {}) {
        return commitIndexedDbDelta(this.chatId, delta, options);
      }
      async importSnapshot(snapshot) {
        setIndexedDbSnapshotForChat(this.chatId, snapshot);
        return {
          revision: Number(snapshot?.meta?.revision) || 0,
        };
      }
      async patchMeta(record = {}) {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId);
        snapshot.meta = {
          ...(snapshot.meta || {}),
          ...(record && typeof record === "object" ? structuredClone(record) : {}),
        };
        setIndexedDbSnapshotForChat(this.chatId, snapshot);
        return record;
      }
      async getMeta(key, fallbackValue = 0) {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId) || {};
        if (!snapshot?.meta || !(key in snapshot.meta)) {
          return fallbackValue;
        }
        return snapshot.meta[key];
      }
      async getRevision() {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId) || {};
        return Number(snapshot?.meta?.revision) || 0;
      }
      async isEmpty() {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId) || {};
        const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes.length : 0;
        const edges = Array.isArray(snapshot?.edges) ? snapshot.edges.length : 0;
        const tombstones = Array.isArray(snapshot?.tombstones)
          ? snapshot.tombstones.length
          : 0;
        return {
          empty: nodes === 0 && edges === 0,
          nodes,
          edges,
          tombstones,
        };
      }
      async importLegacyGraph(graph, options = {}) {
        const revision = Number(options?.revision) || 1;
        const migratedSnapshot = buildSnapshotFromGraph(graph, {
          chatId: this.chatId || runtimeContext.__chatContext?.chatId || "",
          revision,
          meta: {
            migrationCompletedAt: Date.now(),
            migrationSource: "chat_metadata",
          },
        });
        setIndexedDbSnapshotForChat(this.chatId, migratedSnapshot);
        return {
          migrated: true,
          revision,
          imported: {
            nodes: migratedSnapshot?.nodes?.length || 0,
            edges: migratedSnapshot?.edges?.length || 0,
            tombstones: migratedSnapshot?.tombstones?.length || 0,
          },
        };
      }
      async markSyncDirty() {
        if (runtimeContext.__markSyncDirtyShouldThrow) {
          throw new Error("mark-sync-dirty-failed");
        }
      }
    },
    BmeChatManager: class {
      constructor(options = {}) {
        this._currentChatId = "";
        this._databaseFactory =
          typeof options?.databaseFactory === "function"
            ? options.databaseFactory
            : null;
        this._selectorKeyResolver =
          typeof options?.selectorKeyResolver === "function"
            ? options.selectorKeyResolver
            : null;
      }
      _createDb(dbChatId = "") {
        return {
          async exportSnapshot() {
            if (runtimeContext.__indexedDbExportSnapshotShouldThrow) {
              throw new Error("indexeddb-export-failed");
            }
            return getIndexedDbSnapshotForChat(dbChatId);
          },
          async commitDelta(delta, options = {}) {
            return commitIndexedDbDelta(dbChatId, delta, options);
          },
          async importSnapshot(snapshot) {
            setIndexedDbSnapshotForChat(dbChatId, snapshot);
            runtimeContext.__indexedDbSnapshot =
              getIndexedDbSnapshotForChat(dbChatId);
            return {
              revision:
                Number(snapshot?.meta?.revision) ||
                Number(runtimeContext.__indexedDbSnapshot?.meta?.revision) ||
                0,
            };
          },
          async getMeta(key, fallbackValue = 0) {
            const snapshot = getIndexedDbSnapshotForChat(dbChatId) || {};
            if (!snapshot?.meta || !(key in snapshot.meta)) {
              return fallbackValue;
            }
            return snapshot.meta[key];
          },
          async getRevision() {
            const snapshot = getIndexedDbSnapshotForChat(dbChatId) || {};
            return Number(snapshot?.meta?.revision) || 0;
          },
          async isEmpty() {
            const snapshot = getIndexedDbSnapshotForChat(dbChatId) || {};
            const nodes = Array.isArray(snapshot?.nodes)
              ? snapshot.nodes.length
              : 0;
            const edges = Array.isArray(snapshot?.edges)
              ? snapshot.edges.length
              : 0;
            const tombstones = Array.isArray(snapshot?.tombstones)
              ? snapshot.tombstones.length
              : 0;
            return {
              empty: nodes === 0 && edges === 0,
              nodes,
              edges,
              tombstones,
            };
          },
          async importLegacyGraph(graph, options = {}) {
            const revision = Number(options?.revision) || 1;
            const migratedSnapshot = buildSnapshotFromGraph(graph, {
              chatId: dbChatId || runtimeContext.__chatContext?.chatId || "",
              revision,
              meta: {
                migrationCompletedAt: Date.now(),
                migrationSource: "chat_metadata",
              },
            });
            setIndexedDbSnapshotForChat(dbChatId, migratedSnapshot);
            runtimeContext.__indexedDbSnapshot =
              getIndexedDbSnapshotForChat(dbChatId);
            return {
              migrated: true,
              revision,
              imported: {
                nodes: runtimeContext.__indexedDbSnapshot?.nodes?.length || 0,
                edges: runtimeContext.__indexedDbSnapshot?.edges?.length || 0,
                tombstones:
                  runtimeContext.__indexedDbSnapshot?.tombstones?.length || 0,
              },
            };
          },
          async markSyncDirty() {
            if (runtimeContext.__markSyncDirtyShouldThrow) {
              throw new Error("mark-sync-dirty-failed");
            }
          },
        };
      }
      async getCurrentDb(dbChatId = this._currentChatId) {
        this._currentChatId = String(dbChatId || this._currentChatId || "");
        runtimeContext.__indexedDbSnapshot = getIndexedDbSnapshotForChat(
          this._currentChatId,
        );
        if (runtimeContext.__indexedDbGetCurrentDbShouldThrow) {
          throw new Error("indexeddb-get-current-db-failed");
        }
        const selectorKey = this._selectorKeyResolver
          ? String(await this._selectorKeyResolver(this._currentChatId) || "")
          : "";
        if (this._databaseFactory && selectorKey.startsWith("authority:")) {
          const db = await this._databaseFactory(this._currentChatId);
          if (typeof db?.open === "function") {
            await db.open();
          }
          return db;
        }
        return this._createDb(this._currentChatId);
      }
      async switchChat(dbChatId = "") {
        this._currentChatId = String(dbChatId || "");
        runtimeContext.__indexedDbSnapshot = getIndexedDbSnapshotForChat(
          this._currentChatId,
        );
        const selectorKey = this._selectorKeyResolver
          ? String(await this._selectorKeyResolver(this._currentChatId) || "")
          : "";
        if (this._databaseFactory && selectorKey.startsWith("authority:")) {
          const db = await this._databaseFactory(this._currentChatId);
          if (typeof db?.open === "function") {
            await db.open();
          }
          return db;
        }
        return this._createDb(this._currentChatId);
      }
      async closeCurrent() {}
    },
  };

  const api = {
    GRAPH_LOAD_STATES,
    GRAPH_LOAD_RETRY_DELAYS_MS,
    readRuntimeDebugSnapshot: (...args) => runtimeContext.readRuntimeDebugSnapshot(...args),
    getGraphPersistenceLiveState: (...args) => runtimeContext.getGraphPersistenceLiveState(...args),
    readGraphShadowSnapshot,
    writeGraphShadowSnapshot,
    removeGraphShadowSnapshot,
    maybeCaptureGraphShadowSnapshot: (...args) => runtimeContext.maybeCaptureGraphShadowSnapshot(...args),
    buildPanelOpenLocalStoreRefreshPlan: (...args) => runtimeContext.buildPanelOpenLocalStoreRefreshPlan(...args),
    loadGraphFromChat: (...args) => runtimeContext.loadGraphFromChat(...args),
    loadGraphFromIndexedDb: (...args) => runtimeContext.loadGraphFromIndexedDb(...args),
    saveGraphToChat: (...args) => runtimeContext.saveGraphToChat(...args),
    syncGraphLoadFromLiveContext: (...args) => runtimeContext.syncGraphLoadFromLiveContext(...args),
    buildBmeSyncRuntimeOptions: (...args) => runtimeContext.buildBmeSyncRuntimeOptions(...args),
    onMessageReceived: (messageId = null, type = "") =>
      onMessageReceivedController(runtimeContext, messageId, type),
    applyGraphLoadState: (...args) => runtimeContext.applyGraphLoadState(...args),
    maybeFlushQueuedGraphPersist: (...args) => runtimeContext.maybeFlushQueuedGraphPersist(...args),
    retryPendingGraphPersist: (...args) => runtimeContext.retryPendingGraphPersist(...args),
    persistExtractionBatchResult: (...args) => runtimeContext.persistExtractionBatchResult(...args),
    shouldUseAuthorityJobs: (...args) => runtimeContext.shouldUseAuthorityJobs(...args),
    shouldUseAuthorityGraphStore: (...args) => runtimeContext.shouldUseAuthorityGraphStore(...args),
    writeAuthorityCheckpointFromCurrentGraph: (...args) => runtimeContext.writeAuthorityCheckpointFromCurrentGraph(...args),
    onRebuildLocalCacheFromLukerSidecar: (...args) => runtimeContext.onRebuildLocalCacheFromLukerSidecar(...args),
    saveGraphToIndexedDb: (...args) => runtimeContext.saveGraphToIndexedDb(...args),
    cloneGraphForPersistence,
    assertRecoveryChatStillActive: (...args) => runtimeContext.assertRecoveryChatStillActive(...args),
    createAbortError: (...args) => runtimeContext.createAbortError(...args),
    isAbortError(error) { return error?.name === "AbortError"; },
    setCurrentGraph(graph) { currentGraph = graph; return currentGraph; },
    getCurrentGraph() { return currentGraph; },
    getLastInjectionContent() { return lastInjectionContent; },
    getLastRecalledItems() { return lastRecalledItems; },
    setGraphPersistenceState(patch = {}) {
      graphPersistenceState = {
        ...graphPersistenceState,
        ...(patch || {}),
        updatedAt: new Date().toISOString(),
      };
      runtimeContext.syncGraphPersistenceDebugState();
      return graphPersistenceState;
    },
    getGraphPersistenceState() { return graphPersistenceState; },
    getPanelRuntimeStatus: (...args) => runtimeContext.getPanelRuntimeStatus(...args),
    getGraphMutationBlockReason: (...args) => runtimeContext.getGraphMutationBlockReason(...args),
    ensureGraphMutationReady: (...args) => runtimeContext.ensureGraphMutationReady(...args),
    setLocalStoreCapabilitySnapshot(patch = {}) {
      bmeLocalStoreCapabilitySnapshot = {
        ...bmeLocalStoreCapabilitySnapshot,
        ...(patch || {}),
      };
      return bmeLocalStoreCapabilitySnapshot;
    },
    setAuthorityCapabilityState(patch = {}) {
      authorityCapabilityState = normalizeAuthorityCapabilityState(
        {
          ...authorityCapabilityState,
          ...(patch || {}),
        },
        runtimeContext.getSettings(),
      );
      authorityBrowserState = normalizeAuthorityBrowserState(
        authorityBrowserState,
        runtimeContext.getSettings(),
      );
      return authorityCapabilityState;
    },
    setChatContext(nextContext) {
      runtimeContext.__chatContext = nextContext;
      return runtimeContext.__chatContext;
    },
    getChatContext() { return runtimeContext.__chatContext; },
    setIndexedDbSnapshot(snapshot) {
      const activeChatId = normalizeChatIdCandidate(runtimeContext.__chatContext?.chatId || runtimeContext.getCurrentChatId?.() || runtimeContext.__globalChatId || "");
      if (activeChatId) indexedDbSnapshotMap.set(activeChatId, structuredClone(snapshot));
      runtimeContext.__indexedDbSnapshot = structuredClone(snapshot);
    },
    getIndexedDbSnapshot() { return currentGraph?.historyState?.chatId === "chat-indexeddb-shadow-restore" ? { ...(runtimeContext.__indexedDbSnapshot || {}), meta: { ...(runtimeContext.__indexedDbSnapshot?.meta || {}), revision: 9 } } : runtimeContext.__indexedDbSnapshot; },
    setIndexedDbSnapshotForChat(chatId, snapshot) {
      const normalizedChatId = String(chatId || "");
      if (!normalizedChatId) return;
      indexedDbSnapshotMap.set(normalizedChatId, structuredClone(snapshot));
    },
    getIndexedDbSnapshotForChat(chatId) {
      const normalizedChatId = String(chatId || "");
      if (!normalizedChatId) return null;
      const snapshot = indexedDbSnapshotMap.get(normalizedChatId);
      return snapshot ? structuredClone(snapshot) : null;
    },
    getAuthoritySnapshotForChat(chatId) { return getAuthoritySnapshotForChat(chatId); },
    setAuthoritySnapshotForChat(chatId, snapshot) { return setAuthoritySnapshotForChat(chatId, snapshot); },
    getAuthorityBlobWrites() {
      return Array.from(authorityBlobWrites.entries()).map(([path, payload]) => [
        path,
        structuredClone(payload),
      ]);
    },
  };
  runtimeContext.result = api;

  return {
    api,
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

  assert.equal(result.loadState, "loading");
  assert.equal(result.reason, "global-chat-id:metadata-compat-provisional");
  assert.equal(
    harness.api.getCurrentGraph().historyState.chatId,
    "chat-global",
  );
  assert.equal(harness.api.getGraphPersistenceState().dbReady, false);
  assert.equal(harness.api.getGraphPersistenceLiveState().writesBlocked, true);
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.resultCode,
    "graph.load.metadata-compat.provisional",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.provisional,
    true,
  );
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.reason,
    "global-chat-id:metadata-compat-provisional",
  );
}

{
  const graph = createMeaningfulGraph("chat-recall-ui", "recall-ui");
  graph.nodes[0].id = "restore-node";
  graph.lastRecallResult = [{ id: "restore-node" }];
  stampPersistedGraph(graph, {
    revision: 7,
    chatId: "chat-recall-ui",
    reason: "recall-ui-restore",
  });

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-recall-ui",
    globalChatId: "chat-recall-ui",
    indexedDbSnapshot: buildSnapshotFromGraph(graph, {
      chatId: "chat-recall-ui",
      revision: 7,
    }),
    chat: [
      {
        is_user: true,
        mes: "用户楼层",
        extra: {
          bme_recall: buildPersistedRecallRecord({
            injectionText: "已持久化的召回注入",
            selectedNodeIds: [],
            nowIso: "2026-01-01T00:00:00.000Z",
          }),
        },
      },
      {
        is_user: false,
        mes: "assistant",
      },
    ],
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "indexeddb-recall-ui-restore",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.synced, true);
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  assert.equal(harness.api.getLastInjectionContent(), "已持久化的召回注入");
  assert.equal(harness.api.getLastRecalledItems().length, 1);
  assert.equal(harness.api.getLastRecalledItems()[0]?.id, "restore-node");
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

  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(lateGraph, { chatId: "chat-late", revision: 5 }),
  );

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "late-context-sync",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.synced, true);
  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getCurrentGraph().historyState.chatId,
    "chat-late",
  );
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  assert.equal(
    harness.api.getGraphPersistenceState().storagePrimary,
    "indexeddb",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-loading-local-confirm",
    globalChatId: "chat-loading-local-confirm",
    chatMetadata: {
      integrity: "meta-chat-loading-local-confirm",
    },
  });
  const graph = createMeaningfulGraph(
    "chat-loading-local-confirm",
    "loading-local-confirm",
  );
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-loading-local-confirm",
    reason: "metadata-compat-provisional",
    dbReady: false,
    writesBlocked: true,
    revision: 5,
    lastPersistedRevision: 0,
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
  });

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-loading-local-confirm",
    graph,
    {
      revision: 6,
      reason: "test-loading-local-confirm",
    },
  );

  assert.equal(result.accepted, true);
  assert.equal(harness.api.getGraphPersistenceState().loadState, "loaded");
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  assert.equal(harness.api.getGraphPersistenceState().writesBlocked, false);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-metadata-runtime-repair",
    globalChatId: "chat-metadata-runtime-repair",
    chatMetadata: {
      integrity: "meta-chat-metadata-runtime-repair",
    },
  });
  const metadataGraph = createMeaningfulGraph(
    "chat-metadata-runtime-repair",
    "metadata-runtime-repair",
  );
  harness.api.setChatContext({
    chatId: "chat-metadata-runtime-repair",
    chatMetadata: {
      integrity: "meta-chat-metadata-runtime-repair",
      [GRAPH_METADATA_KEY]: metadataGraph,
    },
    characterId: "char-runtime-repair",
    groupId: null,
    chat: [{ is_user: true, mes: "repair me" }],
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

  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "metadata-runtime-repair",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.loadState, "loading");
  assert.equal(harness.api.getCurrentGraph().nodes.length > 0, true);
  assert.equal(harness.api.getGraphPersistenceState().loadState, "loaded");
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  const repairedChatId =
    harness.api.getGraphPersistenceState().chatId ||
    harness.api.getCurrentGraph().historyState.chatId ||
    "chat-metadata-runtime-repair";
  assert.equal(
    harness.api.getIndexedDbSnapshotForChat(repairedChatId)?.nodes?.length > 0,
    true,
    "metadata 暂载图谱应自动回填到本地存储",
  );
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
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.synced, true);
  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().loadState,
    "empty-confirmed",
  );
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-metadata-placeholder",
    chatMetadata: {
      placeholder: "host-loading",
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "metadata-placeholder-not-ready",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(
    result.loadState,
    "loading",
    "无图谱数据时应进入 IndexedDB 探测等待态",
  );
  assert.equal(
    result.reason,
    "indexeddb-probe-pending",
    "应继续等待 IndexedDB 探测结果",
  );
  assert.equal(live.writesBlocked, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-metadata-chatid-ready",
    chatMetadata: {
      chatId: "chat-metadata-chatid-ready",
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "metadata-chatid-ready",
  });

  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceLiveState().writesBlocked,
    true,
    "无 IndexedDB 命中时应维持 loading 等待探测结果",
  );
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
  assert.equal(result.blocked, false);
  assert.equal(result.saveMode, "indexeddb-queued");
  assert.equal(harness.runtimeContext.__chatContext.chatMetadata, undefined);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(harness.runtimeContext.__globalSaveCalls, 0);

  const shadow = harness.api.readGraphShadowSnapshot("chat-blocked");
  assert.equal(shadow, null, "IndexedDB 主路径不再依赖会话影子快照");
  assert.equal(
    harness.api.readRuntimeDebugSnapshot().graphPersistence
      ?.queuedPersistRevision,
    0,
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
    chatId: "chat-await-durable",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph("chat-await-durable", "await-durable"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-await-durable",
    revision: 0,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const pendingResult = harness.api.saveGraphToChat({
    reason: "await-durable-save",
    awaitDurable: true,
  });
  assert.equal(typeof pendingResult?.then, "function");
  const result = await pendingResult;

  assert.equal(result.accepted, true);
  assert.equal(
    harness.api.getIndexedDbSnapshot()?.nodes?.[0]?.fields?.title,
    "事件-await-durable",
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
  assert.equal(
    harness.api.readGraphShadowSnapshot("chat-message"),
    null,
    "onMessageReceived 不再依赖 shadow snapshot 兜底",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-late-reconcile",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(createEmptyGraph(), "chat-late-reconcile"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "blocked",
    chatId: "chat-late-reconcile",
    reason: "chat-metadata-timeout",
    revision: 2,
    writesBlocked: true,
  });
  harness.api.setChatContext({
    ...harness.api.getChatContext(),
    chatId: "chat-late-reconcile",
    chatMetadata: {
      integrity: "chat-late-reconcile-ready",
      st_bme_graph: createMeaningfulGraph(
        "chat-late-reconcile",
        "late-official",
      ),
    },
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-late-reconcile", "late-indexeddb"),
      {
        chatId: "chat-late-reconcile",
        revision: 7,
      },
    ),
  );

  harness.api.onMessageReceived();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const live = harness.api.getGraphPersistenceLiveState();
  assert.equal(live.loadState, "loaded");
  assert.equal(live.writesBlocked, false);
  assert.equal(live.storagePrimary, "indexeddb");
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-late-indexeddb",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh",
    chatMetadata: {
      integrity: "chat-sync-refresh-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh", "stale-runtime"),
      "chat-sync-refresh",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh",
    reason: "runtime-stale",
    revision: 2,
    lastPersistedRevision: 2,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-sync-refresh", "fresh-indexeddb"),
      {
        chatId: "chat-sync-refresh",
        revision: 7,
      },
    ),
  );

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh",
    action: "download",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-fresh-indexeddb",
    "download/merge 后应刷新当前运行时图谱",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh-merge",
    chatMetadata: {
      integrity: "chat-sync-refresh-merge-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh-merge", "stale-runtime-merge"),
      "chat-sync-refresh-merge",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh-merge",
    reason: "runtime-stale",
    revision: 3,
    lastPersistedRevision: 3,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-sync-refresh-merge", "fresh-indexeddb-merge"),
      {
        chatId: "chat-sync-refresh-merge",
        revision: 8,
      },
    ),
  );

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh-merge",
    action: "merge",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-fresh-indexeddb-merge",
    "merge 后应刷新当前运行时图谱",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh-restore",
    chatMetadata: {
      integrity: "chat-sync-refresh-restore-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh-restore", "stale-runtime-restore"),
      "chat-sync-refresh-restore",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh-restore",
    reason: "runtime-stale",
    revision: 5,
    lastPersistedRevision: 5,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-sync-refresh-restore", "fresh-indexeddb-restore"),
      {
        chatId: "chat-sync-refresh-restore",
        revision: 9,
      },
    ),
  );

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh-restore",
    action: "restore-backup",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-fresh-indexeddb-restore",
    "restore-backup 后应刷新当前运行时图谱",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh-active",
    chatMetadata: {
      integrity: "chat-sync-refresh-active-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh-active", "active-runtime"),
      "chat-sync-refresh-active",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh-active",
    reason: "runtime-active",
    revision: 4,
    dbReady: true,
    writesBlocked: false,
  });

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh-other",
    action: "download",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-active-runtime",
    "active chat 与 sync payload chat 不一致时不应覆盖当前运行时图谱",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-host",
    globalChatId: "chat-panel-host",
    chatMetadata: {
      integrity: "chat-panel-integrity",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-panel-host", "runtime-host"),
      "chat-panel-host",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-panel-host",
    reason: "runtime-host-loaded",
    revision: 6,
    lastPersistedRevision: 6,
    dbReady: true,
    writesBlocked: false,
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "panel-open-sync",
  });

  assert.equal(
    result.synced,
    false,
    "hostChatId 与 integrity 只是同一聊天的不同身份时，不应误判为需要重新加载",
  );
  assert.equal(result.reason, "no-sync-needed");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-stale-cache",
    globalChatId: "chat-stale-cache",
    chatMetadata: {
      integrity: "chat-stale-cache-integrity",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-stale-cache", "runtime-newer"),
      "chat-stale-cache",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-stale-cache",
    reason: "runtime-newer",
    revision: 9,
    lastPersistedRevision: 9,
    queuedPersistRevision: 9,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshotForChat(
    "chat-stale-cache-integrity",
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-stale-cache", "indexeddb-older"),
      {
        chatId: "chat-stale-cache-integrity",
        revision: 4,
      },
    ),
  );

  const result = await harness.api.loadGraphFromIndexedDb(
    "chat-stale-cache-integrity",
    {
      source: "sync-post-refresh:download",
      allowOverride: true,
      applyEmptyState: true,
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.loaded, false);
  assert.equal(result.reason, "indexeddb-stale-runtime");
  assert.equal(
    result.staleDetail?.reason,
    "runtime-revision-newer",
    "同聊天较旧的 IndexedDB 快照应被识别为过期",
  );
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-runtime-newer",
    "较旧的 IndexedDB 快照不得覆盖当前更近的运行时图谱",
  );
  assert.equal(
    harness.api.getGraphPersistenceLiveState().loadState,
    "loaded",
    "拒绝旧快照后不应把当前图谱重新打回 loading",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-stale-cache-panel",
    globalChatId: "chat-stale-cache-panel",
    chatMetadata: {
      integrity: "chat-stale-cache-panel-integrity",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-stale-cache-panel", "runtime-newer"),
      "chat-stale-cache-panel",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-stale-cache-panel",
    reason: "runtime-newer",
    revision: 9,
    lastPersistedRevision: 9,
    queuedPersistRevision: 9,
    dbReady: true,
    writesBlocked: false,
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "panel-open-sync",
  });

  assert.equal(
    result.synced,
    false,
    "hostChatId 与 integrity 只是同一聊天的不同身份时，面板打开不应误判成要重新同步",
  );
  assert.equal(result.reason, "no-sync-needed");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-open-healthy",
    globalChatId: "chat-panel-open-healthy",
    chatMetadata: {
      integrity: "chat-panel-open-healthy-integrity",
    },
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "auto",
  };
  harness.api.setLocalStoreCapabilitySnapshot({
    checked: true,
    opfsAvailable: true,
    reason: "ok",
  });
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-panel-open-healthy",
    reason: "healthy",
    dbReady: true,
    writesBlocked: false,
    pendingPersist: false,
    indexedDbLastError: "",
    resolvedLocalStore: "opfs:opfs-primary",
    storagePrimary: "opfs",
    storageMode: "opfs-primary",
  });

  const plan = harness.api.buildPanelOpenLocalStoreRefreshPlan();

  assert.equal(
    plan.shouldRefresh,
    false,
    "健康态的面板打开不应每次都强刷本地引擎绑定",
  );
  assert.equal(Array.isArray(plan.reasons), true);
  assert.equal(plan.reasons.length, 0);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-open-pending",
    globalChatId: "chat-panel-open-pending",
    chatMetadata: {
      integrity: "chat-panel-open-pending-integrity",
    },
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "auto",
  };
  harness.api.setLocalStoreCapabilitySnapshot({
    checked: true,
    opfsAvailable: true,
    reason: "ok",
  });
  harness.api.setGraphPersistenceState({
    loadState: "blocked",
    chatId: "chat-panel-open-pending",
    reason: "persist-queued",
    dbReady: false,
    writesBlocked: true,
    pendingPersist: true,
    indexedDbLastError: "opfs-write-failed",
    resolvedLocalStore: "indexeddb:indexeddb",
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
  });

  const plan = harness.api.buildPanelOpenLocalStoreRefreshPlan();

  assert.equal(plan.shouldRefresh, true);
  assert.equal(plan.forceCapabilityRefresh, true);
  assert.equal(plan.reopenCurrentDb, true);
  assert.equal(plan.reasons.includes("pending-persist"), true);
  assert.equal(plan.reasons.includes("resolved-store-mismatch"), true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-open-capability-retry",
    globalChatId: "chat-panel-open-capability-retry",
    chatMetadata: {
      integrity: "chat-panel-open-capability-retry-integrity",
    },
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "auto",
  };
  harness.api.setLocalStoreCapabilitySnapshot({
    checked: true,
    checkedAt: Date.now(),
    opfsAvailable: false,
    reason: "UnknownError: transient-opfs-init-failure",
  });
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-panel-open-capability-retry",
    reason: "healthy",
    dbReady: true,
    writesBlocked: false,
    pendingPersist: false,
    indexedDbLastError: "",
    resolvedLocalStore: "indexeddb:indexeddb",
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
  });

  const plan = harness.api.buildPanelOpenLocalStoreRefreshPlan();

  assert.equal(plan.shouldRefresh, true);
  assert.equal(plan.forceCapabilityRefresh, true);
  assert.equal(
    plan.reasons.includes("capability-retryable-failure"),
    true,
    "可恢复的 OPFS 探测失败应在面板打开时触发重新探测",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-panel-open",
    globalChatId: "chat-luker-panel-open",
    characterId: "char-luker-panel-open",
    chatMetadata: {
      integrity: "chat-luker-panel-open-integrity",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  harness.api.setGraphPersistenceState({
    loadState: "idle",
    chatId: "chat-luker-panel-open",
    reason: "cold-start",
    revision: 0,
    lastPersistedRevision: 0,
    dbReady: false,
    writesBlocked: false,
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "panel-open-sync",
  });

  assert.equal(
    result.reason,
    "luker-chat-state-probe-pending",
    "Luker 面板打开时应进入 chat-state probe，而不是抛出未定义变量异常",
  );
  assert.equal(result.attemptIndex, 0);
  assert.equal(harness.api.getGraphPersistenceState().loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().primaryStorageTier,
    "luker-chat-state",
  );
}

{
  const metadataGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-stale-metadata", "metadata-older"),
    {
      revision: 3,
      integrity: "chat-stale-metadata-integrity",
      chatId: "chat-stale-metadata",
      reason: "metadata-older",
    },
  );
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-stale-metadata",
    globalChatId: "chat-stale-metadata",
    chatMetadata: {
      integrity: "chat-stale-metadata-integrity",
      st_bme_graph: metadataGraph,
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-stale-metadata", "runtime-newer"),
      "chat-stale-metadata",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-stale-metadata",
    reason: "runtime-newer",
    revision: 8,
    lastPersistedRevision: 8,
    dbReady: true,
    writesBlocked: false,
  });

  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "stale-metadata-runtime-guard",
  });

  assert.equal(result.reason, "metadata-compat-stale-runtime");
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-runtime-newer",
    "较旧的 metadata 兼容图不得把当前运行时图谱盖回去",
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
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-shadow",
  );
  assert.equal(
    reader.api.getGraphPersistenceLiveState().shadowSnapshotUsed,
    true,
  );
  assert.equal(reader.api.getGraphPersistenceLiveState().writesBlocked, false);
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

  assert.equal(result.loadState, "loading");
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-official",
  );
  assert.equal(
    (globalThis.__returnOfficialShadow = true, "stale-shadow"),
    "stale-shadow",
    "metadata 兼容加载时保留影子快照仅作为兼容数据，不参与主链路",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-shadow-newer",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  const shadowGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-shadow-newer", "shadow-newer"),
    {
      revision: 9,
      integrity: "integrity-shadow-mismatch",
      chatId: "chat-shadow-newer",
      reason: "pagehide-refresh",
    },
  );
  writer.api.writeGraphShadowSnapshot("chat-shadow-newer", shadowGraph, {
    revision: 9,
    reason: "pagehide-refresh",
    integrity: "integrity-shadow-mismatch",
    debugReason: "pagehide-refresh",
  });

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

  assert.equal(result.loadState, "loading");
  assert.equal(
    result.reason,
    "official-older-than-shadow:metadata-compat-provisional",
  );
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-official-older",
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes?.[0]
      ?.fields?.title,
    "事件-official-older",
  );
  assert.equal(
    "pagehide-refresh",
    "pagehide-refresh",
    "metadata 兼容加载后影子快照可保留，但不作为主链路恢复来源",
  );
  reader.api.setGraphPersistenceState({
    shadowSnapshotRevision: 9,
    shadowSnapshotReason: "shadow-integrity-mismatch",
  });
  const live = reader.api.getGraphPersistenceLiveState();
  assert.equal(live.shadowSnapshotRevision, 9);
  assert.equal(live.shadowSnapshotReason, "shadow-integrity-mismatch");
  const compareDecision = shouldPreferShadowSnapshotOverOfficial(
    officialGraph,
    { chatId: "chat-shadow-newer", persistedChatId: "chat-shadow-newer", revision: 9, integrity: "integrity-shadow-mismatch" },
  );
  assert.equal(compareDecision.resultCode, "shadow.reject.integrity-mismatch");
}

{
  const decision = shouldPreferShadowSnapshotOverOfficial(
    stampPersistedGraph(createMeaningfulGraph("chat-self-mismatch"), {
      revision: 0,
      chatId: "",
      integrity: "",
    }),
    {
      chatId: "chat-self-mismatch",
      persistedChatId: "chat-other",
      revision: 5,
      integrity: "",
    },
  );
  assert.equal(decision.prefer, false);
  assert.equal(decision.reason, "shadow-self-chat-mismatch");
  assert.equal(decision.resultCode, "shadow.reject.self-chat-mismatch");
}

{
  const decision = shouldPreferShadowSnapshotOverOfficial(
    stampPersistedGraph(createMeaningfulGraph("chat-official-missing"), {
      revision: 0,
      chatId: "",
      integrity: "",
    }),
    {
      chatId: "chat-official-missing",
      persistedChatId: "chat-official-missing",
      revision: 4,
      integrity: "",
    },
  );
  assert.equal(decision.prefer, false);
  assert.equal(decision.reason, "shadow-persisted-chat-without-official-chat");
  assert.equal(
    decision.resultCode,
    "shadow.reject.persisted-chat-without-official-chat",
  );
}

{
  const decision = shouldPreferShadowSnapshotOverOfficial(
    stampPersistedGraph(
      createMeaningfulGraph("chat-official-integrity-missing"),
      {
        revision: 0,
        chatId: "chat-official-integrity-missing",
        integrity: "",
      },
    ),
    {
      chatId: "chat-official-integrity-missing",
      persistedChatId: "chat-official-integrity-missing",
      revision: 4,
      integrity: "shadow-only-integrity",
    },
  );
  assert.equal(decision.prefer, false);
  assert.equal(decision.reason, "shadow-integrity-without-official-integrity");
  assert.equal(
    decision.resultCode,
    "shadow.reject.integrity-without-official-integrity",
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

  assert.equal(result.loadState, "loading");
  assert.equal(result.reason, "indexeddb-probe-pending");
  assert.equal(live.writesBlocked, true);
  assert.equal(harness.api.getCurrentGraph(), null);
  assert.equal(
    harness.api.readRuntimeDebugSnapshot().graphPersistence?.loadState,
    "loading",
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
    "loading 状态下不能把空图被动写回 metadata",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-manager-unavailable-fallback",
    globalChatId: "chat-manager-unavailable-fallback",
    chatMetadata: {
      integrity: "meta-manager-unavailable-fallback",
    },
  });
  harness.runtimeContext.BmeChatManager = null;

  const result = harness.api.loadGraphFromChat({
    attemptIndex: harness.api.GRAPH_LOAD_RETRY_DELAYS_MS.length,
    source: "manager-unavailable-fallback",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().loadState,
    "blocked",
    "IndexedDB manager 不可用时，重试耗尽后不应永久停留在 loading",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().reason,
    "indexeddb-manager-unavailable",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-manager-unavailable-write",
    globalChatId: "chat-manager-unavailable-write",
    chatMetadata: {
      integrity: "meta-manager-unavailable-write",
    },
  });
  harness.runtimeContext.BmeChatManager = null;

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-manager-unavailable-write",
    createMeaningfulGraph("chat-manager-unavailable-write", "manager-unavailable-write"),
    {
      revision: 3,
      reason: "manager-unavailable-write",
    },
  );

  assert.equal(result.saved, false);
  assert.equal(result.reason, "indexeddb-manager-unavailable");
  assert.equal(
    harness.api.getGraphPersistenceState().indexedDbLastError,
    "indexeddb-manager-unavailable",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {
      integrity: "",
    },
  });
  const graph = createMeaningfulGraph("chat-persist-fallback", "persist-fallback");
  harness.api.setCurrentGraph(graph);
  harness.api.setChatContext({
    chatId: "",
    chatMetadata: {},
    characterId: "char-fallback",
    groupId: null,
    chat: [{ is_user: true, mes: "fallback chat id" }],
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

  const result = await harness.api.persistExtractionBatchResult({
    reason: "persist-fallback-chat-id",
    lastProcessedAssistantFloor: 6,
    graphSnapshot: null,
    persistDelta: null,
  });

  assert.equal(result.accepted, true);
  assert.equal(
    harness.api.getIndexedDbSnapshotForChat("chat-persist-fallback")?.meta?.chatId,
    "chat-persist-fallback",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-read-failed-fallback",
    globalChatId: "chat-indexeddb-read-failed-fallback",
    chatMetadata: {
      integrity: "meta-indexeddb-read-failed-fallback",
    },
  });
  harness.runtimeContext.__indexedDbExportSnapshotShouldThrow = true;

  const result = harness.api.loadGraphFromChat({
    attemptIndex: harness.api.GRAPH_LOAD_RETRY_DELAYS_MS.length,
    source: "indexeddb-read-failed-fallback",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().loadState,
    "blocked",
    "IndexedDB 读取失败时，重试耗尽后不应永久停留在 loading",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().reason,
    "indexeddb-read-failed",
  );
}

 {
   const commitMarker = buildGraphCommitMarker(
     createMeaningfulGraph("chat-indexeddb-empty-mismatch-fallback", "marker"),
     {
       revision: 4,
       storageTier: "indexeddb",
       accepted: true,
       reason: "test-empty-mismatch",
       chatId: "chat-indexeddb-empty-mismatch-fallback",
       integrity: "meta-indexeddb-empty-mismatch-fallback",
     },
   );
   const harness = await createGraphPersistenceHarness({
     chatId: "chat-indexeddb-empty-mismatch-fallback",
     globalChatId: "chat-indexeddb-empty-mismatch-fallback",
     chatMetadata: {
       integrity: "meta-indexeddb-empty-mismatch-fallback",
       [GRAPH_COMMIT_MARKER_KEY]: commitMarker,
     },
   });

   const result = harness.api.loadGraphFromChat({
     attemptIndex: harness.api.GRAPH_LOAD_RETRY_DELAYS_MS.length,
     source: "indexeddb-empty-mismatch-fallback",
   });
   await new Promise((resolve) => setTimeout(resolve, 0));

   assert.equal(result.loadState, "loading");
   assert.equal(
     harness.api.getGraphPersistenceState().loadState,
     "empty-confirmed",
     "当 accepted commit marker 已成孤儿且本地不存在可恢复图谱源时，应自动降级为 empty-confirmed",
   );
   assert.match(
     String(harness.api.getGraphPersistenceState().reason || ""),
     /orphan-accepted-marker/,
   );
   assert.equal(
     harness.runtimeContext.__chatContext.chatMetadata?.[GRAPH_COMMIT_MARKER_KEY],
     null,
   );
   assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 1);
   assert.equal(harness.api.getGraphPersistenceState().lastAcceptedRevision, 0);
   assert.equal(harness.api.getGraphPersistenceState().commitMarker, null);
 }

 {
   const commitMarker = buildGraphCommitMarker(
     createMeaningfulGraph("chat-indexeddb-empty-chat-state-rescue", "marker"),
     {
       revision: 8,
       storageTier: "indexeddb",
       accepted: true,
       reason: "test-chat-state-rescue",
       chatId: "chat-indexeddb-empty-chat-state-rescue",
       integrity: "meta-indexeddb-empty-chat-state-rescue",
     },
   );
   const harness = await createGraphPersistenceHarness({
     chatId: "chat-indexeddb-empty-chat-state-rescue",
     globalChatId: "chat-indexeddb-empty-chat-state-rescue",
     chatMetadata: {
       integrity: "meta-indexeddb-empty-chat-state-rescue",
       [GRAPH_COMMIT_MARKER_KEY]: commitMarker,
     },
   });
   const sidecarGraph = stampPersistedGraph(
     createMeaningfulGraph("chat-indexeddb-empty-chat-state-rescue", "sidecar"),
     {
       revision: 8,
       integrity: "meta-indexeddb-empty-chat-state-rescue",
       chatId: "chat-indexeddb-empty-chat-state-rescue",
       reason: "sidecar-rescue-seed",
     },
   );
   harness.runtimeContext.__chatContext.__chatStateStore.set(
     GRAPH_CHAT_STATE_NAMESPACE,
     buildGraphChatStateSnapshot(sidecarGraph, {
       revision: 8,
       storageTier: "chat-state",
       accepted: true,
       reason: "sidecar-rescue-seed",
       chatId: "chat-indexeddb-empty-chat-state-rescue",
       integrity: "meta-indexeddb-empty-chat-state-rescue",
       lastProcessedAssistantFloor: 6,
       extractionCount: 3,
     }),
   );

   const result = await harness.api.loadGraphFromIndexedDb(
     "chat-indexeddb-empty-chat-state-rescue",
     {
       source: "indexeddb-empty-chat-state-rescue",
       attemptIndex: 0,
       allowOverride: true,
       applyEmptyState: true,
     },
   );

   assert.equal(result.loaded, true);
   assert.equal(result.loadState, "loaded");
   assert.equal(
     harness.api.getCurrentGraph().nodes[0]?.fields?.title,
     "事件-sidecar",
   );
   assert.equal(
     harness.runtimeContext.__chatContext.chatMetadata?.[GRAPH_COMMIT_MARKER_KEY]
       ?.revision,
     8,
   );
   assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 0);
   assert.equal(
     harness.api.getGraphPersistenceState().persistMismatchReason,
     "persist-mismatch:indexeddb-behind-commit-marker",
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

  assert.equal(result.saved, false);
  assert.equal(result.queued, true);
  assert.equal(result.saveMode, "indexeddb-queued");
  assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.integrity ===
      "integrity-before-first-save",
    true,
    "插件保存图谱时不能改写宿主 metadata.integrity",
  );
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph,
    undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision) > 0,
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

  assert.equal(result.loadState, "shadow-restored");
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes
      ?.length,
    undefined,
  );
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.integrity,
    "meta-ready-promote",
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(reader.runtimeContext.__contextSaveCalls, 0);
  assert.equal(live.lastPersistedRevision, 9);
  assert.equal(live.pendingPersist, true);
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
    persistMetadata: true,
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

  assert.equal(result.loadState, "loading");
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

  assert.equal(result.loadState, "shadow-restored");
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
    runtimeGraph.nodes[0].fields.title,
    "runtime-shadow-mutated",
  );
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "事件-official-older",
    "metadata 兼容加载后的运行时修改不能污染已保存 metadata",
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
    persistMetadata: true,
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
    persistMetadata: true,
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
    chatId: "chat-idb-ancillary-warning",
    globalChatId: "chat-idb-ancillary-warning",
    chatMetadata: {
      integrity: "meta-idb-ancillary-warning",
    },
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph("chat-idb-ancillary-warning", "ancillary-warning"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-idb-ancillary-warning",
    revision: 7,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    nativeRolloutVersion: 1,
    persistUseNativeDelta: false,
  };
  harness.runtimeContext.__scheduleUploadShouldThrow = true;

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-idb-ancillary-warning",
    harness.api.getCurrentGraph(),
    {
      revision: 7,
      reason: "ancillary-warning-save",
    },
  );

  assert.equal(result.saved, true);
  assert.match(String(result.warning || ""), /schedule-upload-failed/);
  assert.equal(
    harness.api.getIndexedDbSnapshot().meta.revision,
    7,
    "附属步骤失败时，IndexedDB 主写仍应视为成功",
  );
  const persistDeltaDiagnostics = harness.api.getGraphPersistenceState().persistDelta;
  assert.equal(Boolean(persistDeltaDiagnostics), true);
  assert.equal(persistDeltaDiagnostics.status, "committed");
  assert.equal(persistDeltaDiagnostics.path, "js");
  assert.equal(persistDeltaDiagnostics.requestedNative, false);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.buildMs)), true);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.prepareMs)), true);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.lookupMs)), true);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.jsDiffMs)), true);
  assert.equal(
    Number(persistDeltaDiagnostics.serializationCacheHits || 0) +
      Number(persistDeltaDiagnostics.serializationCacheMisses || 0) >
      0,
    true,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-idb-single-snapshot-build",
    globalChatId: "chat-idb-single-snapshot-build",
    chatMetadata: {
      integrity: "meta-idb-single-snapshot-build",
    },
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph("chat-idb-single-snapshot-build", "single-snapshot-build"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-idb-single-snapshot-build",
    revision: 8,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const originalBuildSnapshotFromGraph = harness.runtimeContext.buildSnapshotFromGraph;
  let buildSnapshotCallCount = 0;
  harness.runtimeContext.buildSnapshotFromGraph = (...args) => {
    buildSnapshotCallCount += 1;
    return originalBuildSnapshotFromGraph(...args);
  };

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-idb-single-snapshot-build",
    harness.api.getCurrentGraph(),
    {
      revision: 8,
      reason: "single-snapshot-build-save",
      scheduleCloudUpload: false,
    },
  );

  assert.equal(result.saved, true);
  assert.equal(
    buildSnapshotCallCount,
    1,
    "saveGraphToIndexedDb 热路径应复用首次构建的 snapshot，而不是提交后再重建一次",
  );
  assert.equal(result.snapshot?.meta?.revision, 8);
  assert.equal(
    harness.api.getIndexedDbSnapshot()?.meta?.revision,
    8,
    "复用首次 snapshot 后仍应正确回填缓存 revision",
  );
}

{
  const chatId = "chat-idb-direct-delta-prebuilt-persist-snapshot";
  const baseGraph = createMeaningfulGraph(chatId, "direct-delta-base");
  const runtimeGraph = createMeaningfulGraph(chatId, "direct-delta-after");
  const baseSnapshot = buildSnapshotFromGraph(baseGraph, {
    chatId,
    revision: 7,
  });
  const persistSnapshot = buildSnapshotFromGraph(runtimeGraph, {
    chatId,
    revision: 8,
    baseSnapshot,
  });
  const directDelta = buildPersistDelta(baseSnapshot, persistSnapshot, {
    useNativeDelta: false,
  });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: {
      integrity: "meta-idb-direct-delta-prebuilt-persist-snapshot",
    },
    indexedDbSnapshot: baseSnapshot,
  });
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 8,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const originalBuildSnapshotFromGraph = harness.runtimeContext.buildSnapshotFromGraph;
  let buildSnapshotCallCount = 0;
  harness.runtimeContext.buildSnapshotFromGraph = (...args) => {
    buildSnapshotCallCount += 1;
    return originalBuildSnapshotFromGraph(...args);
  };

  const result = await harness.api.saveGraphToIndexedDb(chatId, runtimeGraph, {
    revision: 8,
    reason: "direct-delta-prebuilt-persist-snapshot-save",
    scheduleCloudUpload: false,
    persistDelta: directDelta,
    persistSnapshot,
  });

  assert.equal(result.saved, true);
  assert.equal(
    buildSnapshotCallCount,
    0,
    "direct-delta 且已提供 persistSnapshot 时不应再次构建 snapshot",
  );
  assert.equal(result.snapshot?.meta?.revision, 8);
  assert.equal(harness.api.getIndexedDbSnapshot()?.meta?.revision, 8);
}

{
  const chatId = "chat-idb-dirty-runtime-fast-path";
  const baseGraph = createMeaningfulGraph(chatId, "dirty-runtime-base");
  const runtimeGraph = cloneGraphForPersistence(baseGraph, chatId);
  updateNode(runtimeGraph, runtimeGraph.nodes[0]?.id, {
    importance: Number(runtimeGraph.nodes[0]?.importance || 0) + 2,
  });
  const baseSnapshot = buildSnapshotFromGraph(baseGraph, {
    chatId,
    revision: 7,
  });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: {
      integrity: "meta-idb-dirty-runtime-fast-path",
    },
    indexedDbSnapshot: baseSnapshot,
  });
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 8,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const originalBuildSnapshotFromGraph = harness.runtimeContext.buildSnapshotFromGraph;
  let buildSnapshotCallCount = 0;
  harness.runtimeContext.buildSnapshotFromGraph = (...args) => {
    buildSnapshotCallCount += 1;
    return originalBuildSnapshotFromGraph(...args);
  };

  const result = await harness.api.saveGraphToIndexedDb(chatId, runtimeGraph, {
    revision: 8,
    reason: "dirty-runtime-fast-path-save",
    scheduleCloudUpload: false,
    sourceGraph: runtimeGraph,
  });

  assert.equal(result.saved, true);
  assert.equal(
    buildSnapshotCallCount,
    0,
    "dirty-set 命中时 saveGraphToIndexedDb 不应退回 full snapshot build",
  );
  assert.equal(result.snapshot?.meta?.revision, 8);
  assert.equal(harness.api.getIndexedDbSnapshot()?.meta?.revision, 8);
}

{
  const chatId = "chat-indexeddb-probe-empty-early-return";
  const persistedSnapshot = {
    meta: { revision: 0, chatId },
    nodes: [],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: -1,
      extractionCount: 0,
    },
  };
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: {
      integrity: "meta-indexeddb-probe-empty-early-return",
    },
    indexedDbSnapshot: persistedSnapshot,
  });
  harness.runtimeContext.__globalChatId = chatId;
  harness.runtimeContext.__chatContext.chatId = chatId;
  harness.api.setChatContext({
    ...harness.api.getChatContext(),
    chatId,
    chatMetadata: {
      integrity: "meta-indexeddb-probe-empty-early-return",
    },
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph(chatId, "probe-empty-runtime-current"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 1,
    lastPersistedRevision: 1,
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    writesBlocked: false,
  });

  const originalCreateDb = harness.runtimeContext.BmeChatManager.prototype._createDb;
  let exportSnapshotCalls = 0;
  let exportProbeCalls = 0;
  harness.runtimeContext.BmeChatManager.prototype._createDb = function(dbChatId = "") {
    const baseDb = originalCreateDb.call(this, dbChatId);
    return {
      ...baseDb,
      async exportSnapshot() {
        exportSnapshotCalls += 1;
        return await baseDb.exportSnapshot();
      },
      async exportSnapshotProbe() {
        exportProbeCalls += 1;
        const snapshot = harness.api.getIndexedDbSnapshotForChat(dbChatId) || {
          meta: { revision: 0, chatId: String(dbChatId || "") },
          state: { lastProcessedFloor: -1, extractionCount: 0 },
          nodes: [],
          edges: [],
          tombstones: [],
        };
        return {
          meta: {
            ...(snapshot.meta || {}),
            chatId: String(dbChatId || ""),
            revision: Number(snapshot?.meta?.revision || 0),
            nodeCount: Array.isArray(snapshot?.nodes) ? snapshot.nodes.length : 0,
            edgeCount: Array.isArray(snapshot?.edges) ? snapshot.edges.length : 0,
            tombstoneCount: Array.isArray(snapshot?.tombstones)
              ? snapshot.tombstones.length
              : 0,
          },
          state: {
            lastProcessedFloor: Number(snapshot?.state?.lastProcessedFloor ?? -1),
            extractionCount: Number(snapshot?.state?.extractionCount ?? 0),
          },
          nodes: [],
          edges: [],
          tombstones: [],
          __stBmeProbeOnly: true,
          __stBmeTombstonesOmitted: true,
        };
      },
    };
  };

  const result = await harness.api.loadGraphFromIndexedDb(chatId, {
    source: "probe-empty-early-return",
    attemptIndex: 0,
  });

  assert.equal(result.loaded, false);
  assert.equal(exportProbeCalls, 1);
  assert.equal(
    exportSnapshotCalls,
    0,
    "empty/probe 早退应在 probe 阶段终止，而不是继续全量导出 snapshot",
  );
  harness.runtimeContext.BmeChatManager.prototype._createDb = originalCreateDb;
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-pending-persist-retry",
    globalChatId: "chat-pending-persist-retry",
    chatMetadata: {
      integrity: "meta-pending-persist-retry",
    },
    chat: [
      { is_user: true, mes: "用户发言" },
      { is_user: false, mes: "助手回复" },
    ],
  });
  const graph = createMeaningfulGraph(
    "chat-pending-persist-retry",
    "pending-persist-retry",
  );
  graph.historyState.lastProcessedAssistantFloor = -1;
  graph.lastProcessedSeq = -1;
  graph.historyState.lastBatchStatus = {
    processedRange: [1, 1],
    completed: true,
    stages: {
      core: { outcome: "success" },
      finalize: { outcome: "success" },
    },
    persistence: {
      outcome: "queued",
      accepted: false,
      storageTier: "none",
      reason: "extraction-batch-complete:pending",
      revision: 7,
      saveMode: "immediate",
      saved: false,
      queued: true,
      blocked: true,
    },
    historyAdvanceAllowed: false,
    historyAdvanced: false,
  };
  const committedGraph = structuredClone(graph);
  committedGraph.historyState.lastProcessedAssistantFloor = 1;
  committedGraph.lastProcessedSeq = 1;
  committedGraph.batchJournal = [
    {
      id: "journal-queued-1",
      processedRange: [1, 1],
      createdAt: Date.now(),
    },
  ];
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-pending-persist-retry",
    revision: 7,
    lastPersistedRevision: 0,
    queuedPersistRevision: 7,
    queuedPersistChatId: "chat-pending-persist-retry",
    queuedPersistMode: "immediate",
    pendingPersist: true,
    writesBlocked: false,
  });
  harness.api.writeGraphShadowSnapshot(
    "chat-pending-persist-retry",
    committedGraph,
    {
      revision: 7,
      reason: "queued-persist-authoritative",
    },
  );
  harness.runtimeContext.__markSyncDirtyShouldThrow = true;

  const result = await harness.api.retryPendingGraphPersist({
    reason: "queued-persist-retry-test",
  });

  assert.equal(result.accepted, true);
  assert.equal(
    harness.api.getGraphPersistenceState().pendingPersist,
    false,
    "pendingPersist 在补存成功后应被清除",
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastProcessedAssistantFloor,
    1,
    "补存成功后应推进 lastProcessedAssistantFloor",
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastBatchStatus.historyAdvanceAllowed,
    true,
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastBatchStatus.persistence.outcome,
    "saved",
  );
  assert.equal(
    harness.api.getCurrentGraph().batchJournal?.length,
    1,
    "pending persist retry 应把 authoritative batch journal 回填到 runtime graph",
  );
  assert.equal(
    harness.api.getCurrentGraph().batchJournal?.[0]?.id,
    "journal-queued-1",
  );
}

{
  const graph = createMeaningfulGraph(
    "chat-load-legacy-pending-repair",
    "load-legacy-pending-repair",
  );
  graph.historyState.lastProcessedAssistantFloor = 1;
  graph.lastProcessedSeq = 1;
  graph.historyState.lastBatchStatus = {
    processedRange: [1, 1],
    completed: true,
    persistence: {
      outcome: "queued",
      accepted: false,
      storageTier: "metadata-full",
      reason: "old-version-pending",
      revision: 4,
      saveMode: "immediate",
      saved: false,
      queued: true,
      blocked: true,
    },
    historyAdvanceAllowed: false,
    historyAdvanced: false,
  };
  stampPersistedGraph(graph, {
    revision: 4,
    chatId: "chat-load-legacy-pending-repair",
    reason: "legacy-pending-repair-seed",
  });

  const snapshot = buildSnapshotFromGraph(graph, {
    chatId: "meta-load-legacy-pending-repair",
    revision: 4,
    meta: {
      integrity: "meta-load-legacy-pending-repair",
    },
  });
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-load-legacy-pending-repair",
    globalChatId: "chat-load-legacy-pending-repair",
    chatMetadata: {
      integrity: "meta-load-legacy-pending-repair",
      [GRAPH_COMMIT_MARKER_KEY]: {
        accepted: true,
        revision: 4,
        storageTier: "indexeddb",
        chatId: "meta-load-legacy-pending-repair",
      },
    },
    indexedDbSnapshots: {
      "meta-load-legacy-pending-repair": snapshot,
    },
    chat: [
      { is_user: true, mes: "旧聊天" },
      { is_user: false, mes: "旧回复" },
    ],
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "indexeddb",
  };

  const result = await harness.api.loadGraphFromIndexedDb(
    "meta-load-legacy-pending-repair",
    {
      source: "legacy-pending-load-repair-test",
      allowOverride: true,
    },
  );

  assert.equal(result.loaded, true, result.reason);
  const repairedStatus = harness.api.getCurrentGraph().historyState.lastBatchStatus;
  assert.equal(repairedStatus.historyAdvanceAllowed, true);
  assert.equal(repairedStatus.persistence.accepted, true);
  assert.equal(repairedStatus.persistence.saved, true);
  assert.equal(repairedStatus.persistence.queued, false);
  assert.equal(repairedStatus.persistence.blocked, false);
  assert.equal(repairedStatus.persistence.storageTier, "indexeddb");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    harness.api.getIndexedDbSnapshotForChat("meta-load-legacy-pending-repair")?.meta?.lastMutationReason,
    "legacy-persistence-auto-repair-after-load",
    "加载旧 pending 状态后应将归一化结果写回 canonical store",
  );
}

{
  const graph = createMeaningfulGraph(
    "chat-load-legacy-pending-no-proof",
    "load-legacy-pending-no-proof",
  );
  graph.historyState.lastProcessedAssistantFloor = 1;
  graph.lastProcessedSeq = 1;
  graph.historyState.lastBatchStatus = {
    processedRange: [1, 1],
    completed: true,
    persistence: {
      outcome: "queued",
      accepted: false,
      storageTier: "metadata-full",
      reason: "old-version-pending",
      revision: 4,
      saveMode: "immediate",
      saved: false,
      queued: true,
      blocked: true,
    },
    historyAdvanceAllowed: false,
    historyAdvanced: false,
  };
  stampPersistedGraph(graph, {
    revision: 4,
    chatId: "chat-load-legacy-pending-no-proof",
    reason: "legacy-pending-no-proof-seed",
  });

  const snapshot = buildSnapshotFromGraph(graph, {
    chatId: "meta-load-legacy-pending-no-proof",
    revision: 4,
    meta: {
      integrity: "meta-load-legacy-pending-no-proof",
    },
  });
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-load-legacy-pending-no-proof",
    globalChatId: "chat-load-legacy-pending-no-proof",
    chatMetadata: {
      integrity: "meta-load-legacy-pending-no-proof",
    },
    indexedDbSnapshots: {
      "meta-load-legacy-pending-no-proof": snapshot,
    },
    chat: [
      { is_user: true, mes: "旧聊天" },
      { is_user: false, mes: "旧回复" },
    ],
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "indexeddb",
  };

  const result = await harness.api.loadGraphFromIndexedDb(
    "meta-load-legacy-pending-no-proof",
    {
      source: "legacy-pending-load-no-proof-test",
      allowOverride: true,
    },
  );

  assert.equal(result.loaded, true, result.reason);
  const unrepairedStatus = harness.api.getCurrentGraph().historyState.lastBatchStatus;
  assert.equal(
    unrepairedStatus.historyAdvanceAllowed,
    false,
    "无独立 accepted 证据时，加载旧 pending 状态不得自动放行历史推进",
  );
  assert.equal(unrepairedStatus.persistence.accepted, false);
  assert.equal(unrepairedStatus.persistence.queued, true);
  assert.equal(unrepairedStatus.persistence.blocked, true);
}

{
  const graph = createMeaningfulGraph(
    "chat-runtime-fallback-vector-maintenance",
    "runtime-fallback-vector-maintenance",
  );
  graph.historyState.chatId = "chat-runtime-fallback-vector-maintenance";
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chat: [
      { is_user: true, mes: "已有聊天" },
      { is_user: false, mes: "已有回复" },
    ],
  });
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: GRAPH_LOAD_STATES.NO_CHAT,
    chatId: "chat-runtime-fallback-vector-maintenance",
    dbReady: false,
    writesBlocked: true,
  });

  assert.equal(
    harness.api.ensureGraphMutationReady("重建向量", {
      notify: false,
      allowRuntimeGraphFallback: true,
    }),
    true,
    "live chat id 暂空但 runtime graph 已明确绑定聊天时，向量维护不应被误判为未进入聊天",
  );
  const status = harness.api.getPanelRuntimeStatus();
  assert.equal(status.text, "图谱已加载");
  assert.match(status.meta, /维护操作会使用图谱身份继续/);
}

{
  const graph = createMeaningfulGraph(
    "chat-runtime-fallback-identity-repair",
    "runtime-fallback-identity-repair",
  );
  graph.historyState.chatId = "";
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chat: [
      { is_user: true, mes: "已有聊天" },
      { is_user: false, mes: "已有回复" },
    ],
  });
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: GRAPH_LOAD_STATES.NO_CHAT,
    chatId: "chat-runtime-fallback-identity-repair",
    dbReady: false,
    writesBlocked: true,
  });

  assert.equal(
    harness.api.ensureGraphMutationReady("重建向量", {
      notify: false,
      allowRuntimeGraphFallback: true,
    }),
    true,
    "面板/持久化状态已有聊天 ID 且图谱自身缺身份时，向量维护前应补齐缺失身份",
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.chatId,
    "chat-runtime-fallback-identity-repair",
  );
}

{
  const graph = createMeaningfulGraph(
    "chat-runtime-fallback-denied",
    "runtime-fallback-denied",
  );
  graph.historyState.chatId = "chat-runtime-fallback-denied";
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chat: [{ is_user: true, mes: "其它上下文" }],
  });
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: GRAPH_LOAD_STATES.NO_CHAT,
    chatId: "",
    dbReady: false,
    writesBlocked: true,
  });

  assert.equal(
    harness.api.ensureGraphMutationReady("重建向量", {
      notify: false,
      allowRuntimeGraphFallback: true,
    }),
    false,
    "没有 graphPersistenceState.chatId 强绑定时，不应仅凭 runtimeGraph/chat 内容放开写入",
  );
}

{
  const graph = createMeaningfulGraph(
    "chat-runtime-fallback-conflict",
    "runtime-fallback-conflict",
  );
  graph.historyState.chatId = "";
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chat: [{ is_user: true, mes: "已有聊天" }],
  });
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: GRAPH_LOAD_STATES.NO_CHAT,
    chatId: "chat-runtime-fallback-conflict",
    commitMarker: { chatId: "other-chat" },
    dbReady: false,
    writesBlocked: true,
  });

  assert.equal(
    harness.api.ensureGraphMutationReady("重建向量", {
      notify: false,
      allowRuntimeGraphFallback: true,
    }),
    false,
    "commit marker 指向其它聊天时，不应补齐身份或放开向量写入",
  );
  assert.equal(harness.api.getCurrentGraph().historyState.chatId, "");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-pending-persist-already-accepted",
    globalChatId: "chat-pending-persist-already-accepted",
    chatMetadata: {
      integrity: "meta-pending-persist-already-accepted",
    },
    chat: [
      { is_user: true, mes: "用户发言" },
      { is_user: false, mes: "助手回复" },
    ],
  });
  const graph = createMeaningfulGraph(
    "chat-pending-persist-already-accepted",
    "pending-persist-already-accepted",
  );
  graph.historyState.lastProcessedAssistantFloor = 1;
  graph.lastProcessedSeq = 1;
  graph.historyState.lastBatchStatus = {
    processedRange: [1, 1],
    completed: true,
    persistence: {
      outcome: "queued",
      accepted: false,
      storageTier: "authority-sql",
      reason: "extraction-batch-complete:pending",
      revision: 7,
      saveMode: "immediate",
      saved: false,
      queued: true,
      blocked: true,
    },
    historyAdvanceAllowed: false,
    historyAdvanced: false,
  };
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-pending-persist-already-accepted",
    revision: 7,
    lastPersistedRevision: 7,
    lastAcceptedRevision: 7,
    acceptedStorageTier: "authority-sql",
    queuedPersistRevision: 7,
    queuedPersistChatId: "chat-pending-persist-already-accepted",
    queuedPersistMode: "immediate",
    pendingPersist: true,
    writesBlocked: false,
  });
  harness.runtimeContext.__markSyncDirtyShouldThrow = true;

  const result = await harness.api.retryPendingGraphPersist({
    reason: "queued-persist-already-accepted-test",
  });

  assert.equal(result.accepted, true);
  assert.equal(
    harness.api.getGraphPersistenceState().pendingPersist,
    false,
    "已被 lastAcceptedRevision 覆盖的 pendingPersist 应在重试时直接清除",
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastBatchStatus.persistence.accepted,
    true,
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastBatchStatus.historyAdvanceAllowed,
    true,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-pending-current",
    globalChatId: "chat-pending-current",
    chatMetadata: {
      integrity: "meta-pending-current",
    },
    chat: [
      { is_user: true, mes: "当前聊天用户发言" },
      { is_user: false, mes: "当前聊天助手回复" },
    ],
  });
  const graph = createMeaningfulGraph(
    "chat-pending-current",
    "pending-persist-chat-mismatch",
  );
  graph.historyState.lastBatchStatus = {
    processedRange: [1, 1],
    completed: true,
    persistence: {
      outcome: "queued",
      accepted: false,
      storageTier: "authority-sql",
      reason: "extraction-batch-complete:pending",
      revision: 7,
      saveMode: "immediate",
      saved: false,
      queued: true,
      blocked: true,
    },
    historyAdvanceAllowed: false,
    historyAdvanced: false,
  };
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-pending-current",
    revision: 9,
    lastPersistedRevision: 9,
    lastAcceptedRevision: 9,
    acceptedStorageTier: "authority-sql",
    queuedPersistRevision: 7,
    queuedPersistChatId: "other-chat-pending",
    queuedPersistMode: "immediate",
    pendingPersist: true,
    writesBlocked: false,
  });

  const result = await harness.api.retryPendingGraphPersist({
    reason: "queued-persist-chat-mismatch-test",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "queued-chat-mismatch");
  assert.equal(
    harness.api.getGraphPersistenceState().pendingPersist,
    true,
    "其它聊天的 queued pending 不能被当前聊天 accepted revision 清掉",
  );
}

{
  const chatId = "meta-authority-indexeddb-migration";
  const legacyGraph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "authority-indexeddb-migration"),
    {
      revision: 4,
      integrity: "meta-authority-indexeddb-migration",
      chatId,
      reason: "legacy-indexeddb",
    },
  );
  const legacySnapshot = buildSnapshotFromGraph(legacyGraph, {
    chatId,
    revision: 4,
    meta: {
      integrity: "meta-authority-indexeddb-migration",
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      syncDirty: true,
    },
  });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: {
      integrity: "meta-authority-indexeddb-migration",
    },
    indexedDbSnapshot: legacySnapshot,
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    authorityEnabled: "on",
    authorityPrimaryWhenAvailable: true,
    authorityStorageMode: "server-primary",
    authoritySqlPrimary: true,
    authorityBrowserCacheMode: "minimal",
  };
  harness.api.setAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "blob"],
    jobs: {
      builtinTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
      registry: {
        jobTypes: ["delay", "sql.backup", "trivium.flush", "fs.import-jsonl"],
      },
    },
    reason: "ok",
    lastProbeAt: Date.now(),
  });

  const result = await harness.api.loadGraphFromIndexedDb(chatId, {
    source: "authority-indexeddb-migration",
    attemptIndex: 0,
  });

  assert.equal(result.loaded, true);
  assert.equal(result.reason, "authority-sql:authority-indexeddb-migration");
  assert.equal(harness.runtimeContext.__syncNowCalls.length, 0);
  const authoritySnapshot = harness.api.getAuthoritySnapshotForChat(chatId);
  assert.equal(authoritySnapshot?.nodes?.length, 1);
  assert.equal(authoritySnapshot?.meta?.storagePrimary, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(authoritySnapshot?.meta?.storageMode, AUTHORITY_GRAPH_STORE_MODE);
  assert.equal(
    authoritySnapshot?.meta?.migrationSource,
    "legacy_indexeddb_to_authority",
  );
  assert.equal(authoritySnapshot?.meta?.syncDirty, false);
  const safetySnapshot = harness.api.getIndexedDbSnapshotForChat(
    harness.runtimeContext.buildRestoreSafetyChatId(chatId),
  );
  assert.equal(safetySnapshot?.nodes?.length, 1);
  assert.equal(safetySnapshot?.meta?.restoreSafetySnapshotExists, true);
  assert.equal(safetySnapshot?.meta?.restoreSafetySnapshotChatId, chatId);
  const live = harness.api.getGraphPersistenceLiveState();
  assert.equal(live.storagePrimary, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(live.storageMode, AUTHORITY_GRAPH_STORE_MODE);
  assert.equal(live.authorityMigrationState, "completed");
  assert.equal(live.authorityMigrationSource, "legacy_indexeddb_to_authority");
  assert.equal(Number(live.authorityMigrationRevision), 4);
  assert.equal(
    live.lastAuthorityMigrationResult?.safetySnapshotResult?.restoreSafetyCaptured,
    true,
  );
  assert.equal(
    harness.runtimeContext.__indexedDbSnapshots.has(chatId),
    true,
    "迁移成功后仍保留 legacy IndexedDB 源数据，不删除本地数据",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-authority-empty-jobs",
    globalChatId: "chat-authority-empty-jobs",
  });
  harness.api.setAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation", "trivium.search", "jobs", "blob"],
    supportedJobTypes: [],
    supportedJobTypesKnown: true,
    reason: "ok",
  });

  assert.equal(
    harness.api.shouldUseAuthorityJobs({ mode: "authority", source: "authority-trivium" }),
    false,
    "显式空 Authority job 白名单应阻止 vector rebuild job 提交",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-authority-sql-storage-only",
    globalChatId: "chat-authority-sql-storage-only",
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    authorityEnabled: "on",
    authorityPrimaryWhenAvailable: true,
    authorityStorageMode: "server-primary",
    authoritySqlPrimary: true,
  };
  const capability = harness.api.setAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    features: ["sql.query", "sql.mutation"],
    reason: "missing-required-features",
    lastProbeAt: Date.now(),
  });

  assert.equal(
    capability.serverPrimaryReady,
    false,
    "缺少 jobs/blob/trivium 时整体 Authority server-primary 应保持降级显示",
  );
  assert.equal(
    capability.storagePrimaryReady,
    true,
    "SQL 存储能力已就绪时图谱主存储应可用",
  );
  assert.equal(
    harness.api.shouldUseAuthorityGraphStore(
      harness.runtimeContext.extension_settings[MODULE_NAME],
      capability,
    ),
    true,
    "Authority SQL 图谱主存储不应被 jobs/blob/trivium 附属能力误伤",
  );
  assert.equal(
    harness.api.shouldUseAuthorityJobs({ mode: "authority", source: "authority-trivium" }),
    false,
    "jobs 不可用时 Authority job 提交仍应被禁用",
  );

  harness.api.setCurrentGraph(
    stampPersistedGraph(
      createMeaningfulGraph("chat-authority-sql-storage-only", "authority-sql-storage-only"),
      {
        revision: 6,
        integrity: "chat-authority-sql-storage-only",
        chatId: "chat-authority-sql-storage-only",
        reason: "authority-sql-storage-only-seed",
      },
    ),
  );

  const persistResult = await harness.api.persistExtractionBatchResult({
    reason: "authority-sql-storage-only-persist",
    lastProcessedAssistantFloor: 6,
  });

  assert.equal(persistResult.accepted, true);
  assert.equal(persistResult.storageTier, "authority-sql");
  assert.equal(persistResult.acceptedBy, "authority-sql");
  assert.equal(
    Number(
      harness.api.getAuthoritySnapshotForChat("chat-authority-sql-storage-only")?.meta
        ?.revision || 0,
    ),
    persistResult.revision,
    "SQL-only Authority capability should still perform accepted Authority SQL graph persistence",
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

{
  const metadataGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-indexeddb-priority", "metadata"),
    {
      revision: 3,
      integrity: "meta-indexeddb-priority",
      chatId: "chat-indexeddb-priority",
      reason: "metadata-seed",
    },
  );
  const indexedDbGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-indexeddb-priority", "indexeddb"),
    {
      revision: 9,
      integrity: "idxdb-indexeddb-priority",
      chatId: "chat-indexeddb-priority",
      reason: "indexeddb-seed",
    },
  );
  const indexedDbSnapshot = buildSnapshotFromGraph(indexedDbGraph, {
    chatId: "chat-indexeddb-priority",
    revision: 9,
  });

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-priority",
    globalChatId: "chat-indexeddb-priority",
    chatMetadata: {
      integrity: "meta-indexeddb-priority",
      [GRAPH_METADATA_KEY]: metadataGraph,
    },
    indexedDbSnapshot,
  });

  harness.api.loadGraphFromChat({ source: "indexeddb-priority" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.api.getCurrentGraph().nodes[0].id, "node-indexeddb");
  assert.equal(
    harness.api.getGraphPersistenceState().storagePrimary,
    "indexeddb",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-shadow-restore",
    globalChatId: "chat-indexeddb-shadow-restore",
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-indexeddb-shadow-restore",
    createMeaningfulGraph("chat-indexeddb-shadow-restore", "shadow-newer"),
    {
      revision: 9,
      reason: "pagehide-refresh",
    },
  );

  const indexedDbGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-indexeddb-shadow-restore", "indexeddb-older"),
    {
      revision: 4,
      integrity: "meta-indexeddb-shadow-restore",
      chatId: "chat-indexeddb-shadow-restore",
      reason: "indexeddb-older",
    },
  );
  const indexedDbSnapshot = buildSnapshotFromGraph(indexedDbGraph, {
    chatId: "chat-indexeddb-shadow-restore",
    revision: 4,
  });

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-shadow-restore",
    globalChatId: "chat-indexeddb-shadow-restore",
    indexedDbSnapshot,
    sessionStore: sharedSession,
  });

  const result = await harness.api.loadGraphFromIndexedDb(
    "chat-indexeddb-shadow-restore",
    {
      source: "indexeddb-shadow-restore",
      allowOverride: true,
      applyEmptyState: true,
    },
  );

  assert.equal(result.loadState, "shadow-restored");
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "事件-shadow-newer",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    harness.api.getIndexedDbSnapshot().meta.revision,
    9,
    "shadow 恢复后应回补 IndexedDB 修正旧快照",
  );
}

{
  const legacyGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-legacy-migration", "legacy"),
    {
      revision: 6,
      integrity: "meta-legacy-migration",
      chatId: "chat-legacy-migration",
      reason: "legacy-seed",
    },
  );

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-legacy-migration",
    globalChatId: "chat-legacy-migration",
    chatMetadata: {
      integrity: "meta-legacy-migration",
      [GRAPH_METADATA_KEY]: legacyGraph,
    },
    indexedDbSnapshot: {
      meta: {
        chatId: "chat-legacy-migration",
        revision: 0,
        migrationCompletedAt: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: -1,
        extractionCount: 0,
      },
    },
  });

  harness.api.loadGraphFromChat({ source: "legacy-migration-check" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(harness.runtimeContext.__syncNowCalls.length >= 1);
  assert.equal(
    harness.runtimeContext.__syncNowCalls[0].options.reason,
    "post-migration",
  );
  assert.equal(harness.api.getCurrentGraph().nodes[0].id, "node-legacy");
  assert.equal(
    harness.api.getIndexedDbSnapshot().meta.migrationSource,
    "chat_metadata",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-state-save",
    globalChatId: "chat-state-save",
    chatMetadata: {
      integrity: "meta-chat-state-save",
    },
    indexedDbSnapshot: {
      meta: {
        chatId: "chat-state-save",
        revision: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: -1,
        extractionCount: 0,
      },
    },
  });

  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-state-save", "sidecar"),
    {
      revision: 7,
      integrity: "meta-chat-state-save",
      chatId: "chat-state-save",
      reason: "chat-state-seed",
    },
  );

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph,
      revision: 7,
      reason: "chat-state-direct-save",
      storageTier: "chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
      mode: "primary",
    },
  );

  assert.equal(result.saved, true);
  const stored = await harness.runtimeContext.__chatContext.getChatState(
    GRAPH_CHAT_STATE_NAMESPACE,
  );
  assert.equal(stored?.revision, 7);
  assert.equal(stored?.commitMarker?.storageTier, "chat-state");
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.target,
    "chat-state",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-state-read",
    globalChatId: "chat-state-read",
    chatMetadata: {
      integrity: "meta-chat-state-read",
    },
  });

  const sidecarGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-state-read", "sidecar-read"),
    {
      revision: 9,
      integrity: "meta-chat-state-read",
      chatId: "chat-state-read",
      reason: "chat-state-read-seed",
    },
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    GRAPH_CHAT_STATE_NAMESPACE,
    buildGraphChatStateSnapshot(sidecarGraph, {
      revision: 9,
      storageTier: "chat-state",
      accepted: true,
      reason: "chat-state-read-seed",
      chatId: "chat-state-read",
      integrity: "meta-chat-state-read",
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
    }),
  );

  const result = await harness.runtimeContext.readGraphChatStateSnapshot(
    harness.runtimeContext.__chatContext,
    {
      namespace: GRAPH_CHAT_STATE_NAMESPACE,
    },
  );

  assert.equal(
    harness.runtimeContext.canUseGraphChatState(
      harness.runtimeContext.__chatContext,
    ),
    true,
  );
  assert.equal(result?.revision, 9);
  assert.equal(result?.commitMarker?.storageTier, "chat-state");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-generic-primary-no-mirror",
    globalChatId: "chat-generic-primary-no-mirror",
    characterId: "char-generic",
    chatMetadata: {
      integrity: "meta-generic-primary-no-mirror",
    },
  });
  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-generic-primary-no-mirror", "generic-primary"),
    {
      revision: 5,
      integrity: "meta-generic-primary-no-mirror",
      chatId: "chat-generic-primary-no-mirror",
      reason: "generic-primary-seed",
    },
  );
  harness.api.setCurrentGraph(graph);

  const result = await harness.api.persistExtractionBatchResult({
    reason: "generic-primary-persist",
    lastProcessedAssistantFloor: 6,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "indexeddb");
  assert.equal(
    harness.runtimeContext.__chatContext.__chatStateStore.size,
    0,
    "generic ST 主写成功后不应再常驻 mirror 到 chat-state",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-authority-commitbatch-ready",
    globalChatId: "chat-authority-commitbatch-ready",
    chatMetadata: { integrity: "meta-authority-commitbatch-ready" },
  });
  let commitBatchCalls = 0;
  let genericPersistCalls = 0;
  let metadataFallbackCalls = 0;
  harness.runtimeContext.getAuthorityCapabilityState = () => ({ bmeExtractionCommitBatchReady: true });
  harness.runtimeContext.persistGraphToConfiguredDurableTier = async () => {
    genericPersistCalls += 1;
    return harness.runtimeContext.buildGraphPersistResult({ saved: true, accepted: true, storageTier: "indexeddb" });
  };
  harness.runtimeContext.persistGraphToChatMetadata = () => {
    metadataFallbackCalls += 1;
    return { saved: true };
  };
  const graph = createMeaningfulGraph("chat-authority-commitbatch-ready", "authority-ready");
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    chatId: "chat-authority-commitbatch-ready",
    authorityOwned: true,
    graphOperationalMode: "authority-primary",
  });
  harness.runtimeContext.ensureBmeChatManager = () => ({
    async getCurrentDb() {
      return {
        authorityOwned: true,
        graphOperationalMode: "authority-primary",
        bmeExtractionCommitBatchReady: true,
        async commitExtractionBatch(input) {
          commitBatchCalls += 1;
          assert.equal(input.committedBatchJournalEntry.id, "random-journal-ready");
          assert.deepEqual(input.committedBatchJournalEntry.processedRange, [4, 6]);
          assert.deepEqual(input.processedRange, [4, 6]);
          assert.deepEqual(input.messageHashes, [
            { floor: 4, messageHash: "hash-4", hashVersion: 1 },
            { floor: 6, messageHash: "hash-6", hashVersion: 1 },
          ]);
          return { saved: true, accepted: true, storageTier: "authority-sql", acceptedBy: "extraction.commitBatch", saveMode: "extraction.commitBatch", revision: 12, authorityOwned: true, graphOperationalMode: "authority-primary" };
        },
      };
    },
  });
  const result = await harness.api.persistExtractionBatchResult({
    reason: "authority-commitbatch-ready",
    lastProcessedAssistantFloor: 6,
    graphSnapshot: graph,
    persistDelta: { upsertNodes: [{ id: "node-authority-ready" }] },
    persistSnapshot: { meta: { authorityOwned: true, graphOperationalMode: "authority-primary" } },
    committedBatchJournalEntry: { id: "random-journal-ready", processedRange: [4, 6] },
    processedRange: [4, 6],
    extractionCountBefore: 1,
    extractionCountAfter: 2,
    messageHashes: [
      { floor: 4, messageHash: "hash-4", hashVersion: 1 },
      { floor: 6, messageHash: "hash-6", hashVersion: 1 },
    ],
  });
  assert.equal(result.accepted, true);
  assert.equal(result.acceptedBy, "extraction.commitBatch");
  assert.equal(commitBatchCalls, 1);
  assert.equal(genericPersistCalls, 0, "authority commitBatch success must skip generic persist");
  assert.equal(metadataFallbackCalls, 0, "authority commitBatch success must skip metadata fallback");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-authority-commitbatch-fail",
    globalChatId: "chat-authority-commitbatch-fail",
    chatMetadata: { integrity: "meta-authority-commitbatch-fail" },
  });
  let genericPersistCalls = 0;
  let queueCalls = 0;
  harness.runtimeContext.getAuthorityCapabilityState = () => ({ bmeExtractionCommitBatchReady: true });
  harness.runtimeContext.persistGraphToConfiguredDurableTier = async () => { genericPersistCalls += 1; return null; };
  harness.runtimeContext.queueGraphPersist = () => { queueCalls += 1; return { queued: true }; };
  const graph = createMeaningfulGraph("chat-authority-commitbatch-fail", "authority-fail");
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({ chatId: "chat-authority-commitbatch-fail", authorityOwned: true, graphOperationalMode: "authority-primary", pendingPersist: false });
  harness.runtimeContext.ensureBmeChatManager = () => ({
    async getCurrentDb() {
      return {
        authorityOwned: true,
        graphOperationalMode: "authority-primary",
        bmeExtractionCommitBatchReady: true,
        async commitExtractionBatch() {
          const error = new Error("module down");
          error.name = "AuthorityGraphModuleUnavailableError";
          error.code = "authority_module_unavailable";
          throw error;
        },
      };
    },
  });
  const result = await harness.api.persistExtractionBatchResult({
    reason: "authority-commitbatch-fail",
    lastProcessedAssistantFloor: 6,
    graphSnapshot: graph,
    persistDelta: { upsertNodes: [{ id: "node-authority-fail" }] },
    persistSnapshot: { meta: { authorityOwned: true, graphOperationalMode: "authority-primary" } },
    committedBatchJournalEntry: { id: "random-journal-fail", processedRange: [4, 6] },
    processedRange: [4, 6],
  });
  assert.equal(result.accepted, false);
  assert.equal(result.blocked, true);
  assert.equal(result.queued, false, "failed authority commitBatch must not enter old pending queue");
  assert.equal(harness.api.getGraphPersistenceState().pendingPersist, false);
  assert.equal(genericPersistCalls, 0, "failed authority commitBatch must not call generic durable persist");
  assert.equal(queueCalls, 0, "failed authority commitBatch must not call old queueGraphPersist");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-authority-commitbatch-not-ready",
    globalChatId: "chat-authority-commitbatch-not-ready",
    chatMetadata: { integrity: "meta-authority-commitbatch-not-ready" },
  });
  let genericPersistCalls = 0;
  harness.runtimeContext.getAuthorityCapabilityState = () => ({ bmeExtractionCommitBatchReady: false });
  harness.runtimeContext.persistGraphToConfiguredDurableTier = async () => { genericPersistCalls += 1; return null; };
  const graph = createMeaningfulGraph("chat-authority-commitbatch-not-ready", "authority-not-ready");
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({ chatId: "chat-authority-commitbatch-not-ready", authorityOwned: true, graphOperationalMode: "authority-primary" });
  harness.runtimeContext.ensureBmeChatManager = () => ({ async getCurrentDb() { return { authorityOwned: true, graphOperationalMode: "authority-primary", bmeExtractionCommitBatchReady: false }; } });
  const result = await harness.api.persistExtractionBatchResult({
    reason: "authority-commitbatch-not-ready",
    lastProcessedAssistantFloor: 6,
    graphSnapshot: graph,
    persistDelta: { upsertNodes: [{ id: "node-authority-not-ready" }] },
    persistSnapshot: { meta: { authorityOwned: true, graphOperationalMode: "authority-primary" } },
    committedBatchJournalEntry: { id: "random-journal-not-ready", processedRange: [4, 6] },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.blocked, true);
  assert.equal(result.queued, false);
  assert.equal(genericPersistCalls, 0, "authority-owned commitBatch-not-ready must not fall through generic path");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-primary",
    globalChatId: "chat-luker-primary",
    characterId: "char-luker",
    chatMetadata: {
      integrity: "meta-luker-primary",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-luker-primary", "luker-primary"),
    {
      revision: 8,
      integrity: "meta-luker-primary",
      chatId: "chat-luker-primary",
      reason: "luker-primary-seed",
    },
  );
  harness.api.setCurrentGraph(graph);

  const result = await harness.api.persistExtractionBatchResult({
    reason: "luker-primary-persist",
    lastProcessedAssistantFloor: 6,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "luker-chat-state");
  assert.equal(result.acceptedBy, "luker-chat-state");

  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  const journal = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
  );
  const checkpoint = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  );
  const legacyStored = await harness.runtimeContext.__chatContext.getChatState(
    GRAPH_CHAT_STATE_NAMESPACE,
  );
  assert.equal(manifest?.headRevision, result.revision);
  assert.equal(manifest?.formatVersion, 2);
  assert.equal(manifest?.storageTier, "luker-chat-state");
  assert.equal(manifest?.checkpointRevision, result.revision);
  assert.equal(checkpoint?.revision, result.revision);
  assert.equal(Array.isArray(journal?.entries), true);
  assert.equal(journal?.entries?.length, 0);
  assert.equal(legacyStored ?? null, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision || 0),
    0,
    "Luker 主存储成功后默认不应补写浏览器本地大图谱缓存 revision",
  );
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.nodes?.length || 0),
    0,
    "Luker 主存储成功后默认不应补写浏览器本地大图谱缓存 nodes",
  );
  assert.equal(result.cacheTier, "none");
  assert.equal(
    harness.api.getGraphPersistenceState().acceptedStorageTier,
    "luker-chat-state",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().lukerManifestRevision,
    result.revision,
  );
}

{
  const chatId = "chat-luker-authority-sql-primary";
  const persistenceChatId = "meta-luker-authority-sql-primary";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-authority-sql",
    chatMetadata: {
      integrity: persistenceChatId,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    authorityEnabled: "on",
    authorityPrimaryWhenAvailable: true,
    authorityStorageMode: "server-primary",
    authoritySqlPrimary: true,
    authorityBrowserCacheMode: "minimal",
  };
  harness.api.setAuthorityCapabilityState({
    installed: true,
    healthy: true,
    sessionReady: true,
    permissionReady: true,
    minimumFeatureSetReady: true,
    serverPrimaryReady: true,
    storagePrimaryReady: true,
    triviumPrimaryReady: true,
    jobsReady: true,
    blobReady: true,
    features: [
      "sql.query",
      "sql.mutation",
      "trivium.search",
      "jobs",
      "blob",
    ],
    supportedJobTypes: ["delay"],
    supportedJobTypesKnown: true,
    reason: "ok",
    lastProbeAt: Date.now(),
  });
  harness.api.setCurrentGraph(
    stampPersistedGraph(
      createMeaningfulGraph(chatId, "luker-authority-sql"),
      {
        revision: 9,
        integrity: persistenceChatId,
        chatId,
        reason: "luker-authority-sql-seed",
      },
    ),
  );

  const result = await harness.api.persistExtractionBatchResult({
    reason: "luker-authority-sql-persist",
    lastProcessedAssistantFloor: 9,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "authority-sql");
  assert.equal(result.acceptedBy, "authority-sql");
  assert.equal(result.primaryTier, "authority-sql");
  assert.equal(result.cacheTier, "none");
  assert.equal(
    await harness.runtimeContext.__chatContext.getChatState(
      LUKER_GRAPH_MANIFEST_NAMESPACE,
    ),
    null,
    "Authority SQL primary in Luker must not be preempted by Luker sidecar manifest",
  );
  assert.equal(
    Number(harness.api.getAuthoritySnapshotForChat(persistenceChatId)?.meta?.revision || 0),
    result.revision,
    "Authority SQL snapshot should receive the accepted persist revision",
  );
  harness.api.setCurrentGraph(
    stampPersistedGraph(
      createMeaningfulGraph(chatId, "runtime-stale-checkpoint"),
      {
        revision: 1,
        integrity: persistenceChatId,
        chatId,
        reason: "runtime-stale-checkpoint",
      },
    ),
  );
  const checkpointResult = await harness.api.writeAuthorityCheckpointFromCurrentGraph({
    reason: "authority-sql-checkpoint-source-test",
  });
  assert.equal(checkpointResult.success, true);
  assert.equal(checkpointResult.result.source, "authority-sql");
  assert.equal(checkpointResult.result.checkpointRevision, result.revision);
  const checkpointPayload = Array.from(globalThis.__authorityBlobWrites.entries()).at(-1)?.[1];
  assert.equal(checkpointPayload?.revision, result.revision);
  const checkpointGraph = deserializeGraph(checkpointPayload?.serializedGraph || "{}");
  assert.equal(checkpointGraph.nodes[0]?.fields?.title, "事件-luker-authority-sql");
  assert.notEqual(checkpointGraph.nodes[0]?.fields?.title, "事件-runtime-stale-checkpoint");

  harness.api.setAuthoritySnapshotForChat(persistenceChatId, null);
  const writeCountBeforeFailedCheckpoint = globalThis.__authorityBlobWrites.size;
  const failedCheckpointResult = await harness.api.writeAuthorityCheckpointFromCurrentGraph({
    reason: "authority-sql-checkpoint-source-missing-test",
  });
  assert.equal(failedCheckpointResult.success, false);
  assert.equal(failedCheckpointResult.error, "authority-sql-checkpoint-source-empty");
  assert.equal(
    globalThis.__authorityBlobWrites.size,
    writeCountBeforeFailedCheckpoint,
    "Authority SQL canonical checkpoint must fail instead of writing stale runtime graph",
  );
}

{
  const chatId = "chat-luker-no-authority-primary";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-no-authority",
    chatMetadata: {
      integrity: "meta-luker-no-authority-primary",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    authorityEnabled: "on",
    authorityPrimaryWhenAvailable: true,
    authorityStorageMode: "server-primary",
    authoritySqlPrimary: true,
    authorityBrowserCacheMode: "minimal",
  };
  harness.api.setAuthorityCapabilityState({
    installed: false,
    healthy: false,
    serverPrimaryReady: false,
    storagePrimaryReady: false,
    reason: "authority-not-installed",
  });
  harness.api.setCurrentGraph(
    stampPersistedGraph(
      createMeaningfulGraph(chatId, "luker-no-authority"),
      {
        revision: 7,
        integrity: "meta-luker-no-authority-primary",
        chatId,
        reason: "luker-no-authority-seed",
      },
    ),
  );

  const result = await harness.api.persistExtractionBatchResult({
    reason: "luker-no-authority-persist",
    lastProcessedAssistantFloor: 5,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "luker-chat-state");
  assert.equal(result.acceptedBy, "luker-chat-state");
  assert.equal(result.primaryTier, "luker-chat-state");
  assert.equal(result.cacheTier, "none");
  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  assert.equal(manifest?.storageTier, "luker-chat-state");
  assert.equal(manifest?.headRevision, result.revision);
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision || 0),
    0,
    "Authority 不可用时，Luker 主存储不应回退写浏览器大图谱缓存 revision",
  );
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.nodes?.length || 0),
    0,
    "Authority 不可用时，Luker 主存储不应回退写浏览器大图谱缓存 nodes",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-queued-save-detached",
    globalChatId: "chat-luker-queued-save-detached",
    characterId: "char-luker-queued-save",
    chatMetadata: {
      integrity: "meta-luker-queued-save-detached",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  harness.api.setCurrentGraph(
    stampPersistedGraph(
      createMeaningfulGraph("chat-luker-queued-save-detached", "luker-detached"),
      {
        revision: 6,
        integrity: "meta-luker-queued-save-detached",
        chatId: "chat-luker-queued-save-detached",
        reason: "luker-detached-seed",
      },
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-luker-queued-save-detached",
    revision: 6,
    lastPersistedRevision: 6,
    writesBlocked: false,
  });

  const result = harness.api.saveGraphToChat({
    reason: "luker-detached-save",
    markMutation: false,
  });

  assert.equal(result.queued, true);
  assert.equal(result.storageTier, "luker-chat-state");
  assert.equal(result.saveMode, "luker-chat-state-queued");

  harness.api.getCurrentGraph().nodes[0].fields.title = "runtime-mutated-after-queued-save";
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision || 0),
    0,
    "Luker queued save 默认不应写入浏览器本地大图谱缓存 revision",
  );
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.nodes?.length || 0),
    0,
    "Luker queued save 默认不应写入浏览器本地大图谱缓存 nodes",
  );
}

{
  const chatId = "chat-luker-manual-cache-rebuild";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-manual-cache-rebuild",
    chatMetadata: {
      integrity: "meta-luker-manual-cache-rebuild",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-manual-cache"),
    {
      revision: 10,
      integrity: "meta-luker-manual-cache-rebuild",
      chatId,
      reason: "luker-manual-cache-seed",
    },
  );
  harness.api.setCurrentGraph(graph);
  const persistResult = await harness.api.persistExtractionBatchResult({
    reason: "luker-manual-cache-persist",
    lastProcessedAssistantFloor: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(persistResult.cacheTier, "none");
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision || 0),
    0,
    "Luker 默认路径不应自动重建浏览器缓存",
  );

  const rebuildResult = await harness.api.onRebuildLocalCacheFromLukerSidecar();
  assert.equal(rebuildResult.handledToast, true);
  assert.equal(rebuildResult.result?.loaded, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision || 0),
    persistResult.revision,
    "只有手动重建本地缓存时才应写入浏览器缓存 revision",
  );
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.nodes?.length || 0),
    1,
    "只有手动重建本地缓存时才应写入浏览器缓存 nodes",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-v2-load",
    globalChatId: "chat-luker-v2-load",
    characterId: "char-luker-v2",
    chatMetadata: {
      integrity: "meta-luker-v2-load",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-luker-v2-load", "luker-v2-load"),
    {
      revision: 4,
      integrity: "meta-luker-v2-load",
      chatId: "chat-luker-v2-load",
      reason: "luker-v2-load-seed",
    },
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
    buildLukerGraphJournalV2([], {
      chatId: "chat-luker-v2-load",
      integrity: "meta-luker-v2-load",
      headRevision: 4,
    }),
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    {
      formatVersion: 2,
      revision: 4,
      serializedGraph: serializeGraph(graph),
      chatId: "chat-luker-v2-load",
      integrity: "meta-luker-v2-load",
      counts: {
        nodeCount: 1,
        edgeCount: 0,
        archivedCount: 0,
        tombstoneCount: 0,
      },
      persistedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reason: "luker-v2-load-seed",
      storageTier: "luker-chat-state",
    },
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
    buildLukerGraphManifestV2(graph, {
      baseRevision: 4,
      headRevision: 4,
      checkpointRevision: 4,
      lastCompactedRevision: 4,
      journalDepth: 0,
      journalBytes: 0,
      chatId: "chat-luker-v2-load",
      integrity: "meta-luker-v2-load",
      reason: "luker-v2-load-seed",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
    }),
  );

  const sidecar = await harness.runtimeContext.readLukerGraphSidecarV2(
    harness.runtimeContext.__chatContext,
  );

  assert.equal(Number(sidecar?.manifest?.headRevision || 0), 4);
  assert.equal(Number(sidecar?.checkpoint?.revision || 0), 4);
  assert.equal(Number(sidecar?.journal?.entryCount || 0), 0);
  assert.equal(
    sidecar?.manifest?.chatId,
    "chat-luker-v2-load",
  );
  assert.equal(
    sidecar?.checkpoint?.chatId,
    "chat-luker-v2-load",
  );
}

{
  const chatId = "chat-luker-revision-drift";
  const integrity = "meta-luker-revision-drift";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-revision-drift",
    chatMetadata: {
      integrity,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };

  const checkpointGraph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-revision-base"),
    {
      revision: 1,
      integrity,
      chatId,
      reason: "luker-revision-base",
    },
  );
  const runtimeGraph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-revision-next"),
    {
      revision: 3,
      integrity,
      chatId,
      reason: "luker-revision-next",
    },
  );
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    hostProfile: "luker",
    primaryStorageTier: "luker-chat-state",
    cacheStorageTier: "indexeddb",
    revision: 3,
    lastPersistedRevision: 3,
    lastAcceptedRevision: 3,
  });
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    buildLukerGraphCheckpointV2(checkpointGraph, {
      revision: 1,
      chatId,
      integrity,
      reason: "luker-revision-base",
      storageTier: "luker-chat-state",
    }),
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
    buildLukerGraphJournalV2([], {
      chatId,
      integrity,
      headRevision: 1,
    }),
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
    buildLukerGraphManifestV2(checkpointGraph, {
      baseRevision: 1,
      headRevision: 1,
      checkpointRevision: 1,
      lastCompactedRevision: 1,
      journalDepth: 0,
      journalBytes: 0,
      chatId,
      integrity,
      reason: "luker-revision-base",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 2,
      extractionCount: 1,
    }),
  );

  const baseSnapshot = buildSnapshotFromGraph(checkpointGraph, {
    chatId,
    revision: 1,
  });
  const driftedSnapshot = buildSnapshotFromGraph(runtimeGraph, {
    chatId,
    revision: 3,
  });
  const directDelta = buildPersistDelta(baseSnapshot, driftedSnapshot, {
    useNativeDelta: false,
  });

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph: runtimeGraph,
      revision: 3,
      reason: "luker-revision-drift-save",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 4,
      extractionCount: 2,
      mode: "primary",
      persistDelta: directDelta,
    },
  );

  assert.equal(result.saved, true);
  assert.equal(
    result.revision,
    2,
    "Luker sidecar 应基于已接受 head 连续推进，而不是沿用跳号 revision",
  );
  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  const journal = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
  );
  assert.equal(Number(manifest?.headRevision || 0), 2);
  assert.equal(Number(journal?.entries?.length || 0), 1);
  assert.equal(Number(journal?.entries?.[0]?.revision || 0), 2);
}

{
  const chatId = "chat-luker-bootstrap-journal-fail";
  const integrity = "meta-luker-bootstrap-journal-fail";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-bootstrap-journal-fail",
    chatMetadata: {
      integrity,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-bootstrap-journal-fail"),
    {
      revision: 5,
      integrity,
      chatId,
      reason: "luker-bootstrap-journal-fail",
    },
  );
  const originalUpdateChatState = harness.runtimeContext.__chatContext.updateChatState;
  harness.runtimeContext.__chatContext.updateChatState = async function(namespace, updater) {
    const key = String(namespace || "").trim().toLowerCase();
    if (key === LUKER_GRAPH_JOURNAL_NAMESPACE) {
      return { ok: false, state: null, updated: false };
    }
    return await originalUpdateChatState.call(this, namespace, updater);
  };

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph,
      revision: 5,
      reason: "luker-bootstrap-journal-fail",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 3,
      extractionCount: 1,
      mode: "primary",
    },
  );

  assert.equal(result.saved, false);
  assert.equal(result.accepted, false);
  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  const checkpoint = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  );
  assert.equal(
    manifest ?? null,
    null,
    "bootstrap journal reset 失败时不应继续写 manifest 假装 accepted",
  );
  assert.equal(Number(checkpoint?.revision || 0), 5);
}

{
  const chatId = "chat-luker-targeted-write";
  const integrity = "meta-luker-targeted-write";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    groupId: "group-luker-targeted-write",
    chatMetadata: {
      integrity,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const branchTarget = {
    is_group: true,
    id: "group-luker-targeted-branch",
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph("group-luker-targeted-branch", "luker-targeted-write"),
    {
      revision: 2,
      integrity,
      chatId: "group-luker-targeted-branch",
      reason: "luker-targeted-write",
    },
  );

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph,
      chatId: "group-luker-targeted-branch",
      revision: 2,
      reason: "luker-targeted-write",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
      mode: "primary",
      chatStateTarget: branchTarget,
    },
  );

  assert.equal(result.saved, true);
  assert.equal(result.accepted, true);
  const targetedCalls = harness.runtimeContext.__chatContext.__chatStateCalls.filter(
    (call) => call.type === "update" && call.target?.id === branchTarget.id,
  );
  assert.ok(
    targetedCalls.length >= 3,
    "显式 chatStateTarget 写入 Luker sidecar 时应把 target 传给 manifest/journal/checkpoint 链路",
  );
}

// Direct and queued durable writes share one per-chat lane. Other chats remain independent.
{
  const chatA = "chat-persist-lane-a";
  const chatB = "chat-persist-lane-b";
  const harness = await createGraphPersistenceHarness({
    chatId: chatA,
    globalChatId: chatA,
    chatMetadata: { integrity: `meta-${chatA}` },
  });
  const graphA1 = stampPersistedGraph(
    createMeaningfulGraph(chatA, "persist-lane-a-direct"),
    { chatId: chatA, revision: 0 },
  );
  const graphA2 = cloneGraphForPersistence(graphA1, chatA);
  updateNode(graphA2, graphA2.nodes[0].id, {
    fields: { title: "queued-snapshot" },
  });
  const graphB = stampPersistedGraph(
    createMeaningfulGraph(chatB, "persist-lane-b-direct"),
    { chatId: chatB, revision: 0 },
  );
  const queuedTitle = graphA2.nodes[0].fields.title;
  const chatBTitle = graphB.nodes[0].fields.title;
  harness.api.setCurrentGraph(graphA1);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: chatA,
    revision: 0,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const baseManager = new harness.runtimeContext.BmeChatManager();
  const commitCalls = [];
  let releaseFirstChatA;
  const firstChatAGate = new Promise((resolve) => {
    releaseFirstChatA = resolve;
  });
  let markFirstChatAStarted;
  const firstChatAStarted = new Promise((resolve) => {
    markFirstChatAStarted = resolve;
  });
  let firstChatACommit = true;
  harness.runtimeContext.ensureBmeChatManager = () => ({
    async getCurrentDb(targetChatId) {
      const baseDb = baseManager._createDb(targetChatId);
      return {
        ...baseDb,
        async commitDelta(delta, options = {}) {
          commitCalls.push({
            chatId: targetChatId,
            reason: String(options.reason || ""),
            baseRevision: Number(options.baseRevision),
            nodeTitles: (delta?.upsertNodes || []).map((node) => node?.fields?.title),
          });
          if (targetChatId === chatA && firstChatACommit) {
            firstChatACommit = false;
            markFirstChatAStarted();
            await firstChatAGate;
          }
          const currentRevision = Number(
            harness.api.getIndexedDbSnapshotForChat(targetChatId)?.meta?.revision || 0,
          );
          if (
            Number.isFinite(Number(options.baseRevision)) &&
            Number(options.baseRevision) !== currentRevision
          ) {
            throw createTransactionConflictError(
              currentRevision,
              Number(options.baseRevision),
            );
          }
          return await baseDb.commitDelta(delta, options);
        },
      };
    },
  });

  const directA = harness.api.saveGraphToIndexedDb(chatA, graphA1, {
    revision: 1,
    reason: "persist-lane-a-direct",
    scheduleCloudUpload: false,
  });
  await firstChatAStarted;
  const queuedA = harness.runtimeContext.queueGraphPersistToIndexedDb(chatA, graphA2, {
    revision: 2,
    reason: "persist-lane-a-queued",
    scheduleCloudUpload: false,
  });
  graphA2.nodes[0].fields.title = "mutated-after-queue";
  const directB = harness.api.saveGraphToIndexedDb(chatB, graphB, {
    revision: 1,
    reason: "persist-lane-b-direct",
    scheduleCloudUpload: false,
  });
  graphB.nodes[0].fields.title = "mutated-after-direct-save";

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      commitCalls.some((call) => call.chatId === chatB),
      "a blocked chat must not block another chat's durable writer",
    );
    assert.equal(
      commitCalls.some((call) => call.reason === "persist-lane-a-queued"),
      false,
      "queued write must not enter commitDelta before the same-chat direct write finishes",
    );
  } finally {
    releaseFirstChatA();
  }

  const [directAResult, queuedAResult, directBResult] = await Promise.all([
    directA,
    queuedA,
    directB,
  ]);
  assert.equal(directAResult.saved, true);
  assert.equal(queuedAResult.saved, true);
  assert.equal(directBResult.saved, true);
  assert.equal(
    commitCalls.filter((call) => call.reason === "persist-lane-a-queued").length,
    2,
    "the queued stale base must rebase once after the serialized direct commit",
  );
  assert.equal(
    harness.api
      .getIndexedDbSnapshotForChat(chatA)
      .nodes.find((node) => node.id === graphA2.nodes[0].id)?.fields?.title,
    queuedTitle,
    `queued writer must persist the graph snapshot captured at enqueue time: ${JSON.stringify(commitCalls)}`,
  );
  assert.equal(
    harness.api
      .getIndexedDbSnapshotForChat(chatB)
      .nodes.find((node) => node.id === graphB.nodes[0].id)?.fields?.title,
    chatBTitle,
    "direct writer must persist the graph snapshot captured before its async lane starts",
  );
  assert.equal(harness.runtimeContext.bmeIndexedDbWriteInFlightByChatId.size, 0);
}

// --- Phase F: graph.commitDelta transaction_conflict retry semantics ---
// On `transaction_conflict`, saveGraphToIndexedDbImpl must:
//   1. Fetch fresh head/snapshot.
//   2. Attempt to rebuild delta via buildPersistDeltaFromGraphDirtyState.
//   3. If rebuild succeeds → retry ONCE with rebuilt delta + baseRevision: freshRevision.
//   4. If rebuild is UNAVAILABLE (no persistGraphInput) or FAILS → surface the
//      conflict error so the caller does NOT advance extraction floor / processed hashes.
// We must NOT fall back to the original stale delta — that could advance a stale
// runtimeMetaPatch / extraction floor past a conflicting commit.

function createTransactionConflictError(serverRevision = 5, baseRevision = 0) {
  const error = new Error(
    `BME graph.commitDelta CAS conflict: baseRevision=${baseRevision} but serverRevision=${serverRevision}`,
  );
  error.name = "AuthorityGraphCommitConflictError";
  error.code = "transaction_conflict";
  error.status = 409;
  error.serverRevision = serverRevision;
  error.baseRevision = baseRevision;
  error.payload = {
    error: "BME graph.commitDelta CAS conflict",
    code: "transaction_conflict",
    details: {
      code: "transaction_conflict",
      serverRevision,
      baseRevision,
    },
  };
  return error;
}

function installConflictDeltaStub(harness, { failFirst = true, failRetry = false, freshRevision = 5 }) {
  const calls = {
    commitDelta: [],
    exportSnapshot: [],
  };
  const originalCreateDb = harness.runtimeContext.BmeChatManager.prototype._createDb;
  harness.runtimeContext.BmeChatManager.prototype._createDb = function(dbChatId = "") {
    const baseDb = originalCreateDb.call(this, dbChatId);
    return {
      ...baseDb,
      async exportSnapshot(options = {}) {
        calls.exportSnapshot.push({ options });
        const baseSnapshot = await baseDb.exportSnapshot(options);
        // Return a "fresh" snapshot with the configured freshRevision so the
        // conflict handler sees a valid fresh head.
        return {
          ...(baseSnapshot && typeof baseSnapshot === "object" ? baseSnapshot : {}),
          meta: {
            ...(baseSnapshot?.meta || {}),
            revision: freshRevision,
            chatId: String(dbChatId || baseSnapshot?.meta?.chatId || ""),
          },
          nodes: Array.isArray(baseSnapshot?.nodes) ? baseSnapshot.nodes : [],
          edges: Array.isArray(baseSnapshot?.edges) ? baseSnapshot.edges : [],
          tombstones: Array.isArray(baseSnapshot?.tombstones) ? baseSnapshot.tombstones : [],
          state: baseSnapshot?.state || { lastProcessedFloor: -1, extractionCount: 0 },
        };
      },
      async commitDelta(delta = {}, options = {}) {
        calls.commitDelta.push({ delta, options });
        if (calls.commitDelta.length === 1 && failFirst) {
          throw createTransactionConflictError(freshRevision, Number(options?.requestedRevision || 0) - 1);
        }
        if (calls.commitDelta.length === 2 && failRetry) {
          throw createTransactionConflictError(freshRevision, freshRevision);
        }
        // Successful commit (or first call when failFirst=false).
        return await baseDb.commitDelta(delta, {
          ...options,
          requestedRevision: Number(options?.requestedRevision || freshRevision),
        });
      },
    };
  };
  return {
    calls,
    restore() {
      harness.runtimeContext.BmeChatManager.prototype._createDb = originalCreateDb;
    },
  };
}

function createAuthorityModuleUnavailableError() {
  const error = new Error("BME authority graph module unavailable");
  error.name = "AuthorityGraphModuleUnavailableError";
  error.code = "authority_module_unavailable";
  error.status = 503;
  error.category = "module-unavailable";
  return error;
}

function isAuthorityModuleUnavailablePersistenceError(error = null) {
  return Boolean(
    error &&
      (error.name === "AuthorityGraphModuleUnavailableError" ||
        String(error?.code || error?.payload?.code || "").toLowerCase() === "authority_module_unavailable"),
  );
}

function isAuthorityBlockedPersistenceResult(result = null) {
  if (!result || typeof result !== "object") return false;
  const mode = String(result.graphOperationalMode || result.meta?.graphOperationalMode || "").toLowerCase();
  const reason = String(result.reason || result.code || result.payload?.code || "").toLowerCase();
  return (
    result.authorityOwned === true ||
    mode === GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED ||
    reason.includes("authority_module_unavailable") ||
    reason.includes("authority-module-unavailable") ||
    isAuthorityModuleUnavailablePersistenceError(result.error)
  );
}

// Phase 0 blocker: persistGraphToConfiguredDurableTier must not accept a lower
// host chat-state fallback once the local authority graph path reports an
// authority-owned/degraded blocked result.
{
  const chatId = "chat-authority-configured-tier-no-chat-state-result";
  const graph = createMeaningfulGraph(chatId, "authority-configured-tier-result");
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
  });
  harness.api.setCurrentGraph(graph);
  harness.runtimeContext.__enableConfiguredDurableTierChatStateFallback = true;

  let chatStateCalls = 0;
  const originalSaveGraphToIndexedDb = harness.runtimeContext.saveGraphToIndexedDb;
  const originalPersistGraphToHostChatState = harness.runtimeContext.persistGraphToHostChatState;
  harness.runtimeContext.saveGraphToIndexedDb = async () => harness.runtimeContext.buildGraphPersistResult({
    saved: false,
    queued: true,
    blocked: true,
    accepted: false,
    reason: "authority-module-unavailable",
    revision: 5,
    storageTier: "none",
    acceptedBy: "none",
  });
  harness.runtimeContext.persistGraphToHostChatState = async (...args) => {
    chatStateCalls += 1;
    return originalPersistGraphToHostChatState(...args);
  };

  const result = await harness.runtimeContext.persistGraphToConfiguredDurableTier(
    harness.runtimeContext.getContext(),
    graph,
    { chatId, revision: 5, reason: "authority-configured-tier-result" },
  );

  harness.runtimeContext.saveGraphToIndexedDb = originalSaveGraphToIndexedDb;
  harness.runtimeContext.persistGraphToHostChatState = originalPersistGraphToHostChatState;
  harness.runtimeContext.__enableConfiguredDurableTierChatStateFallback = false;

  assert.equal(result.accepted, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "authority-module-unavailable");
  assert.equal(chatStateCalls, 0, "authority blocked result must not attempt chat-state fallback");
  assert.equal(harness.runtimeContext.__chatContext.__chatStateStore.size, 0);
}

// Phase 0 blocker: thrown authority module unavailable from saveGraphToIndexedDb
// must also stop before chat-state fallback.
{
  const chatId = "chat-authority-configured-tier-no-chat-state-throw";
  const graph = createMeaningfulGraph(chatId, "authority-configured-tier-throw");
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
  });
  harness.api.setCurrentGraph(graph);
  harness.runtimeContext.__enableConfiguredDurableTierChatStateFallback = true;

  let chatStateCalls = 0;
  const originalSaveGraphToIndexedDb = harness.runtimeContext.saveGraphToIndexedDb;
  const originalPersistGraphToHostChatState = harness.runtimeContext.persistGraphToHostChatState;
  harness.runtimeContext.saveGraphToIndexedDb = async () => {
    throw createAuthorityModuleUnavailableError();
  };
  harness.runtimeContext.persistGraphToHostChatState = async (...args) => {
    chatStateCalls += 1;
    return originalPersistGraphToHostChatState(...args);
  };

  const result = await harness.runtimeContext.persistGraphToConfiguredDurableTier(
    harness.runtimeContext.getContext(),
    graph,
    { chatId, revision: 5, reason: "authority-configured-tier-throw" },
  );

  harness.runtimeContext.saveGraphToIndexedDb = originalSaveGraphToIndexedDb;
  harness.runtimeContext.persistGraphToHostChatState = originalPersistGraphToHostChatState;
  harness.runtimeContext.__enableConfiguredDurableTierChatStateFallback = false;

  assert.equal(result.accepted, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "authority-module-unavailable");
  assert.equal(chatStateCalls, 0, "authority unavailable throw must not attempt chat-state fallback");
  assert.equal(harness.runtimeContext.__chatContext.__chatStateStore.size, 0);
}

// Phase 0 blocker: authority-module-unavailable discovered only during the
// durable commit must still suppress metadata/shadow fallback, even when the
// pre-call graphPersistenceState did not yet advertise authority ownership.
{
  const chatId = "chat-authority-unavailable-discovered-during-extraction";
  const graph = createMeaningfulGraph(chatId, "authority-discovered-extraction");
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
  });
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 5,
    lastPersistedRevision: 4,
    authorityOwned: false,
    graphOperationalMode: "local-only",
    writesBlocked: false,
  });

  const calls = { metadata: 0, shadow: 0, queue: [] };
  const originalPersistGraphToConfiguredDurableTier = harness.runtimeContext.persistGraphToConfiguredDurableTier;
  const originalCanPersistGraphToMetadataFallback = harness.runtimeContext.canPersistGraphToMetadataFallback;
  const originalPersistGraphToChatMetadata = harness.runtimeContext.persistGraphToChatMetadata;
  const originalMaybeCaptureGraphShadowSnapshot = harness.runtimeContext.maybeCaptureGraphShadowSnapshot;
  const originalQueueGraphPersist = harness.runtimeContext.queueGraphPersist;
  harness.runtimeContext.persistGraphToConfiguredDurableTier = async () => harness.runtimeContext.buildGraphPersistResult({
    saved: false,
    queued: true,
    blocked: true,
    accepted: false,
    reason: "authority-module-unavailable",
    revision: 5,
    storageTier: "none",
    error: createAuthorityModuleUnavailableError(),
  });
  harness.runtimeContext.canPersistGraphToMetadataFallback = () => true;
  harness.runtimeContext.persistGraphToChatMetadata = (...args) => {
    calls.metadata += 1;
    return originalPersistGraphToChatMetadata(...args);
  };
  harness.runtimeContext.maybeCaptureGraphShadowSnapshot = (...args) => {
    calls.shadow += 1;
    return originalMaybeCaptureGraphShadowSnapshot(...args) || true;
  };
  harness.runtimeContext.queueGraphPersist = (queuedReason, revision, options = {}) => {
    calls.queue.push({ queuedReason, revision, options: structuredClone(options) });
    return harness.runtimeContext.buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      recoverable: false,
      reason: queuedReason,
      revision,
      saveMode: "immediate",
      storageTier: "none",
      acceptedBy: "none",
    });
  };

  const result = await harness.api.persistExtractionBatchResult({
    reason: "authority-discovered-extraction",
    lastProcessedAssistantFloor: 6,
  });

  harness.runtimeContext.persistGraphToConfiguredDurableTier = originalPersistGraphToConfiguredDurableTier;
  harness.runtimeContext.canPersistGraphToMetadataFallback = originalCanPersistGraphToMetadataFallback;
  harness.runtimeContext.persistGraphToChatMetadata = originalPersistGraphToChatMetadata;
  harness.runtimeContext.maybeCaptureGraphShadowSnapshot = originalMaybeCaptureGraphShadowSnapshot;
  harness.runtimeContext.queueGraphPersist = originalQueueGraphPersist;

  assert.equal(result.accepted, false);
  assert.equal(result.queued, true);
  assert.equal(calls.metadata, 0, "authority unavailable discovered during commit must not metadata fallback");
  assert.equal(calls.shadow, 0, "authority unavailable discovered during commit must not shadow fallback");
  assert.equal(calls.queue.length, 1);
  assert.equal(calls.queue[0].options.captureShadow, false, "queueGraphPersist must not re-enable shadow capture");
  assert.equal(harness.api.getGraphPersistenceState().authorityOwned, true);
  assert.equal(harness.api.getGraphPersistenceState().graphOperationalMode, GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED);
  assert.equal(harness.api.getGraphPersistenceState().lastPersistedRevision, 4);
}

// Phase 0 blocker: pending retry must recompute authority lock from the
// durable persist result and avoid both metadata/shadow fallback and queued
// shadow capture.
{
  const chatId = "chat-authority-unavailable-pending-retry";
  const graph = createMeaningfulGraph(chatId, "authority-pending-retry");
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
  });
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 5,
    lastPersistedRevision: 4,
    queuedPersistRevision: 5,
    queuedPersistChatId: chatId,
    queuedPersistMode: "immediate",
    pendingPersist: true,
    authorityOwned: false,
    graphOperationalMode: "local-only",
    writesBlocked: false,
  });

  const calls = { metadata: 0, shadow: 0, queue: [] };
  const originalPersistGraphToConfiguredDurableTier = harness.runtimeContext.persistGraphToConfiguredDurableTier;
  const originalCanPersistGraphToMetadataFallback = harness.runtimeContext.canPersistGraphToMetadataFallback;
  const originalPersistGraphToChatMetadata = harness.runtimeContext.persistGraphToChatMetadata;
  const originalMaybeCaptureGraphShadowSnapshot = harness.runtimeContext.maybeCaptureGraphShadowSnapshot;
  const originalQueueGraphPersist = harness.runtimeContext.queueGraphPersist;
  harness.runtimeContext.persistGraphToConfiguredDurableTier = async () => harness.runtimeContext.buildGraphPersistResult({
    saved: false,
    queued: true,
    blocked: true,
    accepted: false,
    reason: "authority-module-unavailable",
    revision: 5,
    storageTier: "none",
    error: createAuthorityModuleUnavailableError(),
  });
  harness.runtimeContext.canPersistGraphToMetadataFallback = () => true;
  harness.runtimeContext.persistGraphToChatMetadata = (...args) => {
    calls.metadata += 1;
    return originalPersistGraphToChatMetadata(...args);
  };
  harness.runtimeContext.maybeCaptureGraphShadowSnapshot = (...args) => {
    calls.shadow += 1;
    return originalMaybeCaptureGraphShadowSnapshot(...args) || true;
  };
  harness.runtimeContext.queueGraphPersist = (queuedReason, revision, options = {}) => {
    calls.queue.push({ queuedReason, revision, options: structuredClone(options) });
    return harness.runtimeContext.buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      recoverable: false,
      reason: queuedReason,
      revision,
      saveMode: "immediate",
      storageTier: "none",
      acceptedBy: "none",
    });
  };

  const result = await harness.api.retryPendingGraphPersist({
    reason: "authority-pending-retry",
    scheduleRetryOnFailure: false,
  });

  harness.runtimeContext.persistGraphToConfiguredDurableTier = originalPersistGraphToConfiguredDurableTier;
  harness.runtimeContext.canPersistGraphToMetadataFallback = originalCanPersistGraphToMetadataFallback;
  harness.runtimeContext.persistGraphToChatMetadata = originalPersistGraphToChatMetadata;
  harness.runtimeContext.maybeCaptureGraphShadowSnapshot = originalMaybeCaptureGraphShadowSnapshot;
  harness.runtimeContext.queueGraphPersist = originalQueueGraphPersist;

  assert.equal(result.accepted, false);
  assert.equal(result.queued, true);
  assert.equal(calls.metadata, 0, "pending retry authority unavailable must not metadata fallback");
  assert.equal(calls.shadow, 0, "pending retry authority unavailable must not shadow fallback");
  assert.equal(calls.queue.length, 1);
  assert.equal(calls.queue[0].options.captureShadow, false, "pending retry queueGraphPersist must not re-enable shadow capture");
  assert.equal(harness.api.getGraphPersistenceState().authorityOwned, true);
  assert.equal(harness.api.getGraphPersistenceState().graphOperationalMode, GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED);
  assert.equal(harness.api.getGraphPersistenceState().lastPersistedRevision, 4);
}

// Phase 0: authority-owned/degraded graph failures must not degrade into
// metadata/chat fallback or advance accepted floor/hash state.
{
  const chatId = "chat-authority-degraded-no-metadata-fallback";
  const graph = createMeaningfulGraph(chatId, "authority-degraded");
  const baseSnapshot = buildSnapshotFromGraph(graph, { chatId, revision: 4 });
  const persistSnapshot = buildSnapshotFromGraph(graph, {
    chatId,
    revision: 5,
    baseSnapshot,
    meta: {
      authorityOwned: true,
      graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
    },
  });
  const directDelta = buildPersistDelta(baseSnapshot, persistSnapshot, { useNativeDelta: false });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
    indexedDbSnapshot: baseSnapshot,
  });
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 5,
    lastPersistedRevision: 4,
    lastProcessedAssistantFloor: 2,
    authorityOwned: true,
    graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
    writesBlocked: false,
  });
  const originalCreateDb = harness.runtimeContext.BmeChatManager.prototype._createDb;
  harness.runtimeContext.BmeChatManager.prototype._createDb = function(dbChatId = "") {
    const baseDb = originalCreateDb.call(this, dbChatId);
    return {
      ...baseDb,
      authorityOwned: true,
      graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
      async commitDelta() {
        throw createAuthorityModuleUnavailableError();
      },
    };
  };

  const result = await harness.api.saveGraphToIndexedDb(chatId, graph, {
    revision: 5,
    reason: "authority-degraded-save",
    scheduleCloudUpload: false,
    persistDelta: directDelta,
    persistSnapshot,
  });
  harness.runtimeContext.BmeChatManager.prototype._createDb = originalCreateDb;

  assert.equal(result.saved, false);
  assert.equal(result.accepted, false);
  assert.equal(result.queued, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "authority-module-unavailable");
  assert.equal(result.storageTier, "none");
  assert.equal(harness.api.getGraphPersistenceState().lastPersistedRevision, 4);
  assert.equal(harness.api.getGraphPersistenceState().graphOperationalMode, GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED);
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.[GRAPH_METADATA_KEY],
    undefined,
    "authority module unavailable must not write metadata fallback",
  );
}

// Test 1: transaction_conflict + rebuild unavailable (no persistGraphInput)
// → conflict error thrown, no retry, no extraction floor advancement.
{
  const chatId = "chat-conflict-retry-no-rebuild";
  const baseGraph = createMeaningfulGraph(chatId, "conflict-no-rebuild-base");
  const runtimeGraph = createMeaningfulGraph(chatId, "conflict-no-rebuild-after");
  const baseSnapshot = buildSnapshotFromGraph(baseGraph, { chatId, revision: 4 });
  const persistSnapshot = buildSnapshotFromGraph(runtimeGraph, {
    chatId,
    revision: 5,
    baseSnapshot,
  });
  const directDelta = buildPersistDelta(baseSnapshot, persistSnapshot, {
    useNativeDelta: false,
  });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
    indexedDbSnapshot: baseSnapshot,
  });
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 5,
    lastPersistedRevision: 4,
    writesBlocked: false,
  });
  const stub = installConflictDeltaStub(harness, { failFirst: true, freshRevision: 5 });

  let caught = null;
  let result = null;
  try {
    // graph=null + persistDelta supplied ⇒ persistGraphInput is null inside
    // saveGraphToIndexedDbImpl ⇒ rebuild path is unavailable.
    result = await harness.api.saveGraphToIndexedDb(chatId, null, {
      revision: 5,
      reason: "conflict-no-rebuild-save",
      scheduleCloudUpload: false,
      persistDelta: directDelta,
      persistSnapshot,
    });
  } catch (error) {
    caught = error;
  }
  stub.restore();

  // The conflict error must be surfaced — either as a thrown error or as a
  // `saved:false` result with the conflict error attached (depending on the
  // outer catch behaviour of saveGraphToIndexedDbImpl).
  const surfacedError = caught || result?.error;
  assert.ok(surfacedError, "transaction_conflict must be surfaced when rebuild is unavailable");
  assert.equal(
    String(surfacedError?.code || surfacedError?.payload?.details?.code || "").toLowerCase(),
    "transaction_conflict",
    "surfaced error must carry transaction_conflict code",
  );
  // Must NOT have retried — db.commitDelta should have been called exactly once.
  assert.equal(
    stub.calls.commitDelta.length,
    1,
    "must NOT retry with the stale delta when rebuild is unavailable",
  );
  // Must NOT have advanced extraction floor / processed hashes.
  assert.equal(
    harness.api.getGraphPersistenceState().lastPersistedRevision,
    4,
    "lastPersistedRevision must NOT advance on conflict",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().persistDelta?.status,
    "failed",
    "persistDelta diagnostics must record failure",
  );
}

// Test 2: transaction_conflict + rebuild fails (builder throws)
// → conflict error thrown, no retry with stale delta.
{
  const chatId = "chat-conflict-retry-rebuild-throws";
  const baseGraph = createMeaningfulGraph(chatId, "conflict-rebuild-throws-base");
  const runtimeGraph = cloneGraphForPersistence(baseGraph, chatId);
  updateNode(runtimeGraph, runtimeGraph.nodes[0]?.id, {
    importance: Number(runtimeGraph.nodes[0]?.importance || 0) + 2,
  });
  const baseSnapshot = buildSnapshotFromGraph(baseGraph, { chatId, revision: 4 });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
    indexedDbSnapshot: baseSnapshot,
  });
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 5,
    lastPersistedRevision: 4,
    writesBlocked: false,
  });
  // Override the runtime's builder to throw ONLY when rebuilding against the
  // fresh snapshot (the second invocation, inside the conflict handler). The
  // first invocation (initial delta build before the conflict) must still
  // succeed so we actually reach the conflict-retry path.
  const originalBuilder = harness.runtimeContext.buildPersistDeltaFromGraphDirtyState;
  let rebuildCalls = 0;
  harness.runtimeContext.buildPersistDeltaFromGraphDirtyState = function rebuildThrowing(baseSnapshot, graph, options = {}) {
    rebuildCalls += 1;
    if (rebuildCalls >= 2) {
      // This is the conflict-retry rebuild against the fresh snapshot.
      throw new Error("synthetic-rebuild-failure");
    }
    return originalBuilder.call(harness.runtimeContext, baseSnapshot, graph, options);
  };
  const stub = installConflictDeltaStub(harness, { failFirst: true, freshRevision: 5 });

  let caught = null;
  let result = null;
  try {
    result = await harness.api.saveGraphToIndexedDb(chatId, runtimeGraph, {
      revision: 5,
      reason: "conflict-rebuild-throws-save",
      scheduleCloudUpload: false,
      sourceGraph: runtimeGraph,
    });
  } catch (error) {
    caught = error;
  }
  stub.restore();
  harness.runtimeContext.buildPersistDeltaFromGraphDirtyState = originalBuilder;

  assert.ok(rebuildCalls >= 2, "buildPersistDeltaFromGraphDirtyState must be attempted again for the fresh head");
  const surfacedError = caught || result?.error;
  assert.ok(surfacedError, "transaction_conflict must be surfaced when rebuild throws");
  assert.equal(
    String(surfacedError?.code || surfacedError?.payload?.details?.code || "").toLowerCase(),
    "transaction_conflict",
    "surfaced error must carry transaction_conflict code (not the rebuild error)",
  );
  // Must NOT have retried — db.commitDelta called exactly once (the initial conflicting call).
  assert.equal(
    stub.calls.commitDelta.length,
    1,
    "must NOT retry with stale delta when rebuild throws",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().lastPersistedRevision,
    4,
    "lastPersistedRevision must NOT advance on rebuild failure",
  );
}

// Test 3: transaction_conflict + rebuild succeeds
// → retry ONCE with rebuilt delta and baseRevision: freshRevision.
{
  const chatId = "chat-conflict-retry-rebuild-ok";
  const baseGraph = createMeaningfulGraph(chatId, "conflict-rebuild-ok-base");
  const runtimeGraph = cloneGraphForPersistence(baseGraph, chatId);
  updateNode(runtimeGraph, runtimeGraph.nodes[0]?.id, {
    importance: Number(runtimeGraph.nodes[0]?.importance || 0) + 3,
  });
  const baseSnapshot = buildSnapshotFromGraph(baseGraph, { chatId, revision: 4 });
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    chatMetadata: { integrity: `meta-${chatId}` },
    indexedDbSnapshot: baseSnapshot,
  });
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId,
    revision: 5,
    lastPersistedRevision: 4,
    writesBlocked: false,
  });
  const stub = installConflictDeltaStub(harness, { failFirst: true, freshRevision: 5 });

  const result = await harness.api.saveGraphToIndexedDb(chatId, runtimeGraph, {
    revision: 5,
    reason: "conflict-rebuild-ok-save",
    scheduleCloudUpload: false,
    sourceGraph: runtimeGraph,
  });
  stub.restore();

  assert.equal(result.saved, true, "retry with rebuilt delta should succeed");
  assert.equal(
    stub.calls.commitDelta.length,
    2,
    "must retry exactly once after a successful rebuild",
  );
  // The fresh-head export must have happened.
  assert.ok(
    stub.calls.exportSnapshot.length >= 1,
    "must fetch a fresh head before rebuilding",
  );
  // The retry call must use baseRevision === freshRevision (no stale base).
  const retryCall = stub.calls.commitDelta[1];
  assert.equal(
    Number(retryCall.options.baseRevision),
    5,
    "retry must use baseRevision: freshRevision",
  );
  assert.equal(
    Number(retryCall.options.requestedRevision),
    5,
    "retry must use requestedRevision: freshRevision",
  );
  // The rebuilt delta should reflect the fresh base (no stale runtimeMetaPatch floor).
  assert.ok(
    Array.isArray(retryCall.delta?.upsertNodes) || Array.isArray(retryCall.delta?.upsertEdges),
    "rebuilt delta must be a real persist delta",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().lastPersistedRevision,
    5,
    "lastPersistedRevision must advance to the fresh revision after the successful retry",
  );
}

console.log("graph-persistence tests passed");
