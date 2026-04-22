// ST-BME: 图谱持久化常量与纯工具函数
// 不依赖 index.js 模块级可变状态（currentGraph / graphPersistenceState 等）

import { deserializeGraph, getGraphStats, serializeGraph } from "./graph.js";
import {
  cloneGraphPersistDirtyState,
  normalizeGraphRuntimeState,
} from "../runtime/runtime-state.js";

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

export const MODULE_NAME = "st_bme";
export const GRAPH_METADATA_KEY = "st_bme_graph";
export const GRAPH_COMMIT_MARKER_KEY = "st_bme_commit_marker";
export const GRAPH_CHAT_STATE_NAMESPACE = `${MODULE_NAME}_graph_state`;
export const GRAPH_CHAT_STATE_VERSION = 1;
export const GRAPH_CHAT_STATE_MAX_OPERATIONS = 4000;
export const LUKER_GRAPH_MANIFEST_NAMESPACE = `${MODULE_NAME}_graph_manifest`;
export const LUKER_GRAPH_JOURNAL_NAMESPACE = `${MODULE_NAME}_graph_journal`;
export const LUKER_GRAPH_CHECKPOINT_NAMESPACE = `${MODULE_NAME}_graph_checkpoint`;
export const LUKER_HISTORY_STATE_NAMESPACE = `${MODULE_NAME}_history_state`;
export const LUKER_SUMMARY_STATE_NAMESPACE = `${MODULE_NAME}_summary_state`;
export const LUKER_RECALL_STATE_NAMESPACE = `${MODULE_NAME}_recall_state`;
export const LUKER_PROJECTION_STATE_NAMESPACE = `${MODULE_NAME}_projection_state`;
export const LUKER_UI_STATE_NAMESPACE = `${MODULE_NAME}_ui_state`;
export const LUKER_DEBUG_STATE_NAMESPACE = `${MODULE_NAME}_debug_state`;
export const LUKER_GRAPH_SIDECAR_V2_FORMAT = 2;
export const LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH = 32;
export const LUKER_GRAPH_JOURNAL_COMPACTION_BYTES = 2 * 1024 * 1024;
export const LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP = 64;
export const GRAPH_PERSISTENCE_META_KEY = "__stBmePersistence";
export const GRAPH_LOAD_STATES = Object.freeze({
  NO_CHAT: "no-chat",
  LOADING: "loading",
  LOADED: "loaded",
  SHADOW_RESTORED: "shadow-restored",
  EMPTY_CONFIRMED: "empty-confirmed",
  BLOCKED: "blocked",
});
export const GRAPH_LOAD_PENDING_CHAT_ID = "__pending_chat__";
export const GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX = `${MODULE_NAME}:graph-shadow:`;
export const GRAPH_IDENTITY_ALIAS_STORAGE_KEY = `${MODULE_NAME}:chat-identity-aliases`;
export const GRAPH_STARTUP_RECONCILE_DELAYS_MS = [150, 600, 1800, 4000];

// ═══════════════════════════════════════════════════════════
// 纯工具
// ═══════════════════════════════════════════════════════════

export function cloneRuntimeDebugValue(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback ?? value;
  }
}

export function createLocalIntegritySlug() {
  const nativeUuid = globalThis.crypto?.randomUUID?.();
  if (nativeUuid) return nativeUuid;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export const GRAPH_PERSISTENCE_SESSION_ID = createLocalIntegritySlug();

function normalizeIdentityValue(value) {
  return String(value ?? "").trim();
}

function getLocalStorageSafe() {
  const storage = globalThis.localStorage;
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    return null;
  }
  return storage;
}

function getSessionStorageSafe() {
  const storage = globalThis.sessionStorage;
  if (!storage || typeof storage.getItem !== "function") {
    return null;
  }
  return storage;
}

function listStorageKeys(storage) {
  if (!storage) return [];

  if (typeof storage.length === "number" && typeof storage.key === "function") {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key) {
        keys.push(key);
      }
    }
    return keys;
  }

  if (storage.__store instanceof Map) {
    return Array.from(storage.__store.keys()).map((key) => String(key));
  }

  return [];
}

function readGraphIdentityAliasRegistryRaw() {
  const storage = getLocalStorageSafe();
  if (!storage) {
    return {
      byIntegrity: {},
    };
  }

  try {
    const raw = storage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
    if (!raw) {
      return {
        byIntegrity: {},
      };
    }

    const parsed = JSON.parse(raw);
    const byIntegrity =
      parsed?.byIntegrity &&
      typeof parsed.byIntegrity === "object" &&
      !Array.isArray(parsed.byIntegrity)
        ? parsed.byIntegrity
        : {};

    return {
      byIntegrity,
    };
  } catch {
    return {
      byIntegrity: {},
    };
  }
}

function writeGraphIdentityAliasRegistryRaw(registry = null) {
  const storage = getLocalStorageSafe();
  if (!storage) return false;

  try {
    storage.setItem(
      GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
      JSON.stringify({
        byIntegrity:
          registry?.byIntegrity &&
          typeof registry.byIntegrity === "object" &&
          !Array.isArray(registry.byIntegrity)
            ? registry.byIntegrity
            : {},
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function normalizeGraphIdentityAliasEntry(entry = {}, integrity = "") {
  const normalizedIntegrity = normalizeIdentityValue(integrity || entry.integrity);
  const normalizedPersistenceChatId = normalizeIdentityValue(
    entry.persistenceChatId || normalizedIntegrity,
  );
  const normalizedHostChatIds = Array.from(
    new Set(
      (Array.isArray(entry.hostChatIds) ? entry.hostChatIds : [])
        .map((value) => normalizeIdentityValue(value))
        .filter(Boolean),
    ),
  ).slice(-16);

  return {
    integrity: normalizedIntegrity,
    persistenceChatId: normalizedPersistenceChatId || normalizedIntegrity,
    hostChatIds: normalizedHostChatIds,
    updatedAt: String(entry.updatedAt || ""),
  };
}

export function rememberGraphIdentityAlias({
  integrity = "",
  hostChatId = "",
  persistenceChatId = "",
} = {}) {
  const normalizedIntegrity = normalizeIdentityValue(integrity);
  if (!normalizedIntegrity) return null;

  const normalizedHostChatId = normalizeIdentityValue(hostChatId);
  const normalizedPersistenceChatId = normalizeIdentityValue(
    persistenceChatId || normalizedIntegrity,
  );
  const registry = readGraphIdentityAliasRegistryRaw();
  const existingEntry = normalizeGraphIdentityAliasEntry(
    registry.byIntegrity?.[normalizedIntegrity] || {},
    normalizedIntegrity,
  );
  const hostChatIds = Array.from(
    new Set(
      [normalizedHostChatId, ...existingEntry.hostChatIds].filter(Boolean),
    ),
  ).slice(-16);
  const nextEntry = {
    integrity: normalizedIntegrity,
    persistenceChatId: normalizedPersistenceChatId || normalizedIntegrity,
    hostChatIds,
    updatedAt: new Date().toISOString(),
  };

  registry.byIntegrity[normalizedIntegrity] = nextEntry;
  writeGraphIdentityAliasRegistryRaw(registry);
  return nextEntry;
}

export function resolveGraphIdentityAliasByHostChatId(hostChatId = "") {
  const normalizedHostChatId = normalizeIdentityValue(hostChatId);
  if (!normalizedHostChatId) return "";

  const registry = readGraphIdentityAliasRegistryRaw();
  let bestEntry = null;

  for (const [integrity, value] of Object.entries(registry.byIntegrity || {})) {
    const entry = normalizeGraphIdentityAliasEntry(value, integrity);
    if (!entry.hostChatIds.includes(normalizedHostChatId)) {
      continue;
    }

    if (!bestEntry) {
      bestEntry = entry;
      continue;
    }

    if (String(entry.updatedAt || "") > String(bestEntry.updatedAt || "")) {
      bestEntry = entry;
    }
  }

  return normalizeIdentityValue(bestEntry?.persistenceChatId || "");
}

export function getGraphIdentityAliasCandidates({
  integrity = "",
  hostChatId = "",
  persistenceChatId = "",
} = {}) {
  const normalizedIntegrity = normalizeIdentityValue(integrity);
  const normalizedHostChatId = normalizeIdentityValue(hostChatId);
  const normalizedPersistenceChatId = normalizeIdentityValue(persistenceChatId);
  const registry = readGraphIdentityAliasRegistryRaw();
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const normalized = normalizeIdentityValue(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  if (normalizedIntegrity) {
    const entry = normalizeGraphIdentityAliasEntry(
      registry.byIntegrity?.[normalizedIntegrity] || {},
      normalizedIntegrity,
    );
    pushCandidate(entry.persistenceChatId);
    for (const value of entry.hostChatIds) {
      pushCandidate(value);
    }
  } else if (normalizedHostChatId) {
    pushCandidate(resolveGraphIdentityAliasByHostChatId(normalizedHostChatId));
  }

  pushCandidate(normalizedHostChatId);
  pushCandidate(normalizedPersistenceChatId);
  return candidates;
}

function normalizeShadowSnapshotPayload(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const serializedGraph = String(snapshot.serializedGraph || "");
  const chatId = normalizeIdentityValue(snapshot.chatId);
  if (!chatId || !serializedGraph) {
    return null;
  }

  return {
    chatId,
    revision: Number.isFinite(snapshot.revision) ? snapshot.revision : 0,
    serializedGraph,
    updatedAt: String(snapshot.updatedAt || ""),
    reason: String(snapshot.reason || ""),
    integrity: normalizeIdentityValue(snapshot.integrity),
    persistedChatId: normalizeIdentityValue(snapshot.persistedChatId),
    debugReason: String(snapshot.debugReason || snapshot.reason || ""),
  };
}

// ═══════════════════════════════════════════════════════════
// 图谱持久化元数据
// ═══════════════════════════════════════════════════════════

/**
 * @param {object} graph
 * @returns {object|null}
 */
export function getGraphPersistenceMeta(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return null;
  }
  const meta = graph[GRAPH_PERSISTENCE_META_KEY];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  return meta;
}

/**
 * @param {object} graph
 * @returns {number}
 */
export function getGraphPersistedRevision(graph) {
  const revision = Number(getGraphPersistenceMeta(graph)?.revision);
  return Number.isFinite(revision) && revision > 0 ? revision : 0;
}

/**
 * @param {object} graph
 * @param {object} opts
 * @param {number} [opts.revision]
 * @param {string} [opts.reason]
 * @param {string} [opts.chatId]
 * @param {string} [opts.integrity]
 */
export function stampGraphPersistenceMeta(
  graph,
  { revision = 0, reason = "", chatId = "", integrity = "" } = {},
) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return null;
  }

  const existingMeta = getGraphPersistenceMeta(graph) || {};
  const nextMeta = {
    ...existingMeta,
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
    updatedAt: new Date().toISOString(),
    sessionId: GRAPH_PERSISTENCE_SESSION_ID,
    reason: String(reason || ""),
    chatId: String(chatId || existingMeta.chatId || ""),
    integrity: String(integrity || existingMeta.integrity || ""),
  };
  graph[GRAPH_PERSISTENCE_META_KEY] = nextMeta;
  return nextMeta;
}

// ═══════════════════════════════════════════════════════════
// 聊天元数据
// ═══════════════════════════════════════════════════════════

export function writeChatMetadataPatch(context, patch = {}) {
  if (!context) return false;
  if (typeof context.updateChatMetadata === "function") {
    context.updateChatMetadata(patch);
    return true;
  }

  if (
    !context.chatMetadata ||
    typeof context.chatMetadata !== "object" ||
    Array.isArray(context.chatMetadata)
  ) {
    context.chatMetadata = {};
  }
  Object.assign(context.chatMetadata, patch || {});
  return true;
}

export function canUseGraphChatState(context = null) {
  return (
    !!context &&
    typeof context.getChatState === "function" &&
    typeof context.updateChatState === "function"
  );
}

function canBatchReadGraphChatState(context = null) {
  return (
    !!context &&
    typeof context.getChatStateBatch === "function"
  );
}

function normalizeGraphCountSummary(value = {}) {
  const nodeCount = Number(value?.nodeCount ?? value?.nodes);
  const edgeCount = Number(value?.edgeCount ?? value?.edges);
  const archivedCount = Number(value?.archivedCount ?? value?.archivedNodes);
  const tombstoneCount = Number(value?.tombstoneCount ?? value?.tombstones);

  return {
    nodeCount: Number.isFinite(nodeCount) && nodeCount >= 0 ? Math.floor(nodeCount) : 0,
    edgeCount: Number.isFinite(edgeCount) && edgeCount >= 0 ? Math.floor(edgeCount) : 0,
    archivedCount:
      Number.isFinite(archivedCount) && archivedCount >= 0
        ? Math.floor(archivedCount)
        : 0,
    tombstoneCount:
      Number.isFinite(tombstoneCount) && tombstoneCount >= 0
        ? Math.floor(tombstoneCount)
        : 0,
  };
}

function normalizeGraphCountSummaryFromGraph(graph = null) {
  const stats = graph ? getGraphStats(graph) : null;
  return normalizeGraphCountSummary({
    nodeCount: Number(stats?.activeNodes || 0),
    edgeCount: Number(stats?.totalEdges || 0),
    archivedCount: Number(stats?.archivedNodes || 0),
    tombstoneCount: Number(stats?.tombstones || 0),
  });
}

function clonePlainObjectArray(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => cloneRuntimeDebugValue(item, item))
    : [];
}

function cloneStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeChatStatePersistDelta(delta = null) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    return {
      upsertNodes: [],
      upsertEdges: [],
      deleteNodeIds: [],
      deleteEdgeIds: [],
      tombstones: [],
      runtimeMetaPatch: {},
      countDelta: null,
    };
  }

  const runtimeMetaPatch =
    delta.runtimeMetaPatch &&
    typeof delta.runtimeMetaPatch === "object" &&
    !Array.isArray(delta.runtimeMetaPatch)
      ? cloneRuntimeDebugValue(delta.runtimeMetaPatch, {})
      : {};
  const countDelta =
    delta.countDelta &&
    typeof delta.countDelta === "object" &&
    !Array.isArray(delta.countDelta)
      ? cloneRuntimeDebugValue(delta.countDelta, {})
      : null;

  return {
    upsertNodes: clonePlainObjectArray(delta.upsertNodes),
    upsertEdges: clonePlainObjectArray(delta.upsertEdges),
    deleteNodeIds: cloneStringArray(delta.deleteNodeIds),
    deleteEdgeIds: cloneStringArray(delta.deleteEdgeIds),
    tombstones: clonePlainObjectArray(delta.tombstones),
    runtimeMetaPatch,
    countDelta,
  };
}

function stringifyJsonByteLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export function normalizeLukerGraphJournalEntry(entry = null) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const revision = Number(entry.revision);
  const reason = String(entry.reason || "");
  const persistedAt = String(entry.persistedAt || entry.updatedAt || "");
  const storageTier = String(entry.storageTier || "luker-chat-state");
  const chatId = normalizeIdentityValue(entry.chatId);
  const integrity = normalizeIdentityValue(entry.integrity);
  const persistDelta = normalizeChatStatePersistDelta(entry.persistDelta);

  const hasDeltaPayload =
    persistDelta.upsertNodes.length > 0 ||
    persistDelta.upsertEdges.length > 0 ||
    persistDelta.deleteNodeIds.length > 0 ||
    persistDelta.deleteEdgeIds.length > 0 ||
    persistDelta.tombstones.length > 0 ||
    Object.keys(persistDelta.runtimeMetaPatch).length > 0;

  if (!Number.isFinite(revision) || revision <= 0 || !hasDeltaPayload) {
    return null;
  }

  return {
    revision: Math.floor(revision),
    reason,
    persistedAt,
    storageTier,
    chatId,
    integrity,
    persistDelta,
    countDelta:
      persistDelta.countDelta &&
      typeof persistDelta.countDelta === "object" &&
      !Array.isArray(persistDelta.countDelta)
        ? cloneRuntimeDebugValue(persistDelta.countDelta, {})
        : null,
    byteLength: stringifyJsonByteLength({
      revision: Math.floor(revision),
      reason,
      persistedAt,
      storageTier,
      chatId,
      integrity,
      persistDelta,
    }),
  };
}

export function normalizeLukerGraphJournalV2(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const formatVersion = Number(payload.formatVersion || payload.version);
  const chatId = normalizeIdentityValue(payload.chatId);
  const integrity = normalizeIdentityValue(payload.integrity);
  const entries = Array.isArray(payload.entries)
    ? payload.entries
        .map((entry) => normalizeLukerGraphJournalEntry(entry))
        .filter(Boolean)
        .sort((left, right) => left.revision - right.revision)
    : [];
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const headRevision = Number(payload.headRevision || latestEntry?.revision || 0);

  return {
    formatVersion:
      Number.isFinite(formatVersion) && formatVersion > 0
        ? Math.floor(formatVersion)
        : LUKER_GRAPH_SIDECAR_V2_FORMAT,
    chatId,
    integrity,
    headRevision:
      Number.isFinite(headRevision) && headRevision >= 0
        ? Math.floor(headRevision)
        : Number(latestEntry?.revision || 0),
    updatedAt: String(payload.updatedAt || latestEntry?.persistedAt || ""),
    entries,
    entryCount: entries.length,
    totalBytes: entries.reduce(
      (sum, entry) => sum + Number(entry?.byteLength || 0),
      0,
    ),
  };
}

export function buildLukerGraphJournalEntry(
  delta = null,
  {
    revision = 0,
    reason = "",
    storageTier = "luker-chat-state",
    chatId = "",
    integrity = "",
    persistedAt = "",
  } = {},
) {
  return normalizeLukerGraphJournalEntry({
    revision,
    reason,
    persistedAt: String(persistedAt || new Date().toISOString()),
    storageTier,
    chatId,
    integrity,
    persistDelta: normalizeChatStatePersistDelta(delta),
  });
}

export function buildLukerGraphJournalV2(entries = [], metadata = {}) {
  return normalizeLukerGraphJournalV2({
    formatVersion: LUKER_GRAPH_SIDECAR_V2_FORMAT,
    chatId: metadata.chatId,
    integrity: metadata.integrity,
    headRevision: metadata.headRevision,
    updatedAt: metadata.updatedAt || new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : [],
  });
}

export function normalizeLukerGraphCheckpointV2(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const formatVersion = Number(payload.formatVersion || payload.version);
  const revision = Number(payload.revision);
  const serializedGraph = String(payload.serializedGraph || "");
  const chatId = normalizeIdentityValue(payload.chatId);
  const integrity = normalizeIdentityValue(payload.integrity);
  const counts = normalizeGraphCountSummary(payload.counts);

  if (!serializedGraph) {
    return null;
  }

  return {
    formatVersion:
      Number.isFinite(formatVersion) && formatVersion > 0
        ? Math.floor(formatVersion)
        : LUKER_GRAPH_SIDECAR_V2_FORMAT,
    revision: Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 0,
    serializedGraph,
    chatId,
    integrity,
    counts,
    persistedAt: String(payload.persistedAt || payload.updatedAt || ""),
    updatedAt: String(payload.updatedAt || payload.persistedAt || ""),
    reason: String(payload.reason || ""),
    storageTier: String(payload.storageTier || "luker-chat-state"),
  };
}

export function buildLukerGraphCheckpointV2(
  graph,
  {
    revision = 0,
    chatId = "",
    integrity = "",
    reason = "",
    storageTier = "luker-chat-state",
    persistedAt = "",
  } = {},
) {
  if (!graph) return null;
  return normalizeLukerGraphCheckpointV2({
    formatVersion: LUKER_GRAPH_SIDECAR_V2_FORMAT,
    revision,
    chatId,
    integrity,
    reason,
    storageTier,
    counts: normalizeGraphCountSummaryFromGraph(graph),
    persistedAt: String(persistedAt || new Date().toISOString()),
    updatedAt: String(persistedAt || new Date().toISOString()),
    serializedGraph: serializeGraph(graph),
  });
}

export function normalizeLukerGraphManifestV2(payload = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const formatVersion = Number(payload.formatVersion || payload.version);
  const baseRevision = Number(payload.baseRevision);
  const headRevision = Number(payload.headRevision);
  const checkpointRevision = Number(payload.checkpointRevision);
  const lastCompactedRevision = Number(payload.lastCompactedRevision);
  const lastProcessedAssistantFloor = Number(payload.lastProcessedAssistantFloor);
  const extractionCount = Number(payload.extractionCount);
  const journalDepth = Number(payload.journalDepth);
  const journalBytes = Number(payload.journalBytes);
  const chatId = normalizeIdentityValue(payload.chatId);
  const integrity = normalizeIdentityValue(payload.integrity);
  const counts = normalizeGraphCountSummary(payload.counts);

  return {
    formatVersion:
      Number.isFinite(formatVersion) && formatVersion > 0
        ? Math.floor(formatVersion)
        : LUKER_GRAPH_SIDECAR_V2_FORMAT,
    baseRevision: Number.isFinite(baseRevision) && baseRevision >= 0 ? Math.floor(baseRevision) : 0,
    headRevision: Number.isFinite(headRevision) && headRevision >= 0 ? Math.floor(headRevision) : 0,
    checkpointRevision:
      Number.isFinite(checkpointRevision) && checkpointRevision >= 0
        ? Math.floor(checkpointRevision)
        : 0,
    lastCompactedRevision:
      Number.isFinite(lastCompactedRevision) && lastCompactedRevision >= 0
        ? Math.floor(lastCompactedRevision)
        : 0,
    journalDepth:
      Number.isFinite(journalDepth) && journalDepth >= 0 ? Math.floor(journalDepth) : 0,
    journalBytes:
      Number.isFinite(journalBytes) && journalBytes >= 0 ? Math.floor(journalBytes) : 0,
    lastProcessedAssistantFloor:
      Number.isFinite(lastProcessedAssistantFloor)
        ? Math.floor(lastProcessedAssistantFloor)
        : -1,
    extractionCount:
      Number.isFinite(extractionCount) && extractionCount >= 0
        ? Math.floor(extractionCount)
        : 0,
    chatId,
    integrity,
    counts,
    storageTier: String(payload.storageTier || "luker-chat-state"),
    accepted: payload.accepted === true,
    persistedAt: String(payload.persistedAt || payload.updatedAt || ""),
    updatedAt: String(payload.updatedAt || payload.persistedAt || ""),
    reason: String(payload.reason || ""),
    compactionState:
      payload.compactionState && typeof payload.compactionState === "object"
        ? cloneRuntimeDebugValue(payload.compactionState, {})
        : {
            state: "idle",
            lastAt: 0,
            lastReason: "",
            error: "",
          },
  };
}

export function buildLukerGraphManifestV2(
  graph,
  {
    baseRevision = 0,
    headRevision = 0,
    checkpointRevision = 0,
    lastCompactedRevision = 0,
    journalDepth = 0,
    journalBytes = 0,
    chatId = "",
    integrity = "",
    reason = "",
    storageTier = "luker-chat-state",
    accepted = true,
    persistedAt = "",
    updatedAt = "",
    lastProcessedAssistantFloor = null,
    extractionCount = null,
    compactionState = null,
  } = {},
) {
  const stats = graph ? getGraphStats(graph) : null;
  const historyState = graph?.historyState || {};
  const nextCounts =
    graph != null
      ? normalizeGraphCountSummaryFromGraph(graph)
      : normalizeGraphCountSummary();
  return normalizeLukerGraphManifestV2({
    formatVersion: LUKER_GRAPH_SIDECAR_V2_FORMAT,
    baseRevision,
    headRevision,
    checkpointRevision,
    lastCompactedRevision,
    journalDepth,
    journalBytes,
    chatId,
    integrity,
    counts: nextCounts,
    storageTier,
    accepted,
    persistedAt: String(persistedAt || new Date().toISOString()),
    updatedAt: String(updatedAt || persistedAt || new Date().toISOString()),
    reason,
    lastProcessedAssistantFloor:
      lastProcessedAssistantFloor != null
        ? lastProcessedAssistantFloor
        : Number.isFinite(Number(historyState.lastProcessedAssistantFloor))
          ? Number(historyState.lastProcessedAssistantFloor)
          : Number.isFinite(Number(stats?.lastProcessedSeq))
            ? Number(stats.lastProcessedSeq)
            : -1,
    extractionCount:
      extractionCount != null
        ? extractionCount
        : Number.isFinite(Number(historyState.extractionCount))
          ? Number(historyState.extractionCount)
          : 0,
    compactionState,
  });
}

export async function readGraphChatStateNamespaces(
  context = null,
  namespaces = [],
  { target = null } = {},
) {
  if (!canUseGraphChatState(context) || !Array.isArray(namespaces) || namespaces.length === 0) {
    return new Map();
  }

  try {
    if (canBatchReadGraphChatState(context)) {
      const batch = await context.getChatStateBatch(
        namespaces,
        target ? { target } : undefined,
      );
      if (batch instanceof Map) {
        return batch;
      }
      if (batch && typeof batch === "object") {
        return new Map(Object.entries(batch));
      }
    }
  } catch (error) {
    console.warn("[ST-BME] 批量读取聊天侧车失败，回退逐项读取:", error);
  }

  const result = new Map();
  for (const namespace of namespaces) {
    try {
      result.set(
        namespace,
        await context.getChatState(namespace, target ? { target } : undefined),
      );
    } catch {
      result.set(namespace, null);
    }
  }
  return result;
}

export async function writeGraphChatStatePayload(
  context = null,
  namespace = "",
  payload = null,
  {
    maxOperations = GRAPH_CHAT_STATE_MAX_OPERATIONS,
    asyncDiff = false,
    target = null,
  } = {},
) {
  if (!canUseGraphChatState(context) || !namespace || !payload) {
    return {
      ok: false,
      updated: false,
      reason: "chat-state-unavailable",
      payload: null,
    };
  }

  try {
    const result = await context.updateChatState(
      namespace,
      () => cloneRuntimeDebugValue(payload, payload),
      {
        ...(target ? { target } : {}),
        maxOperations,
        asyncDiff,
        maxRetries: 1,
      },
    );
    return {
      ok: result?.ok === true,
      updated: result?.updated !== false,
      reason:
        result?.ok === true
          ? result?.updated === false
            ? "chat-state-noop"
            : "chat-state-saved"
          : "chat-state-save-failed",
      payload,
    };
  } catch (error) {
    console.warn(`[ST-BME] 写入聊天侧车 ${namespace} 失败:`, error);
    return {
      ok: false,
      updated: false,
      reason: "chat-state-save-failed",
      error,
      payload,
    };
  }
}

export async function readLukerGraphSidecarV2(
  context = null,
  {
    manifestNamespace = LUKER_GRAPH_MANIFEST_NAMESPACE,
    journalNamespace = LUKER_GRAPH_JOURNAL_NAMESPACE,
    checkpointNamespace = LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    chatStateTarget = null,
  } = {},
) {
  if (!canUseGraphChatState(context)) {
    return {
      manifest: null,
      journal: null,
      checkpoint: null,
    };
  }

  const payloads = await readGraphChatStateNamespaces(context, [
    manifestNamespace,
    journalNamespace,
    checkpointNamespace,
  ], {
    target: chatStateTarget,
  });

  return {
    manifest: normalizeLukerGraphManifestV2(payloads.get(manifestNamespace) || null),
    journal: normalizeLukerGraphJournalV2(payloads.get(journalNamespace) || null),
    checkpoint: normalizeLukerGraphCheckpointV2(payloads.get(checkpointNamespace) || null),
  };
}

export async function writeLukerGraphManifestV2(
  context = null,
  manifest = null,
  {
    namespace = LUKER_GRAPH_MANIFEST_NAMESPACE,
    maxOperations = 512,
    chatStateTarget = null,
  } = {},
) {
  const normalizedManifest = normalizeLukerGraphManifestV2(manifest);
  if (!normalizedManifest) {
    return {
      ok: false,
      updated: false,
      reason: "chat-state-build-failed",
      manifest: null,
    };
  }

  const result = await writeGraphChatStatePayload(context, namespace, normalizedManifest, {
    maxOperations,
    asyncDiff: false,
    target: chatStateTarget,
  });
  return {
    ...result,
    manifest: normalizedManifest,
  };
}

export async function appendLukerGraphJournalEntryV2(
  context = null,
  entry = null,
  {
    namespace = LUKER_GRAPH_JOURNAL_NAMESPACE,
    chatId = "",
    integrity = "",
    maxOperations = GRAPH_CHAT_STATE_MAX_OPERATIONS,
    chatStateTarget = null,
  } = {},
) {
  const normalizedEntry = normalizeLukerGraphJournalEntry(entry);
  if (!normalizedEntry || !canUseGraphChatState(context)) {
    return {
      ok: false,
      updated: false,
      reason: "chat-state-build-failed",
      journal: null,
      entry: null,
    };
  }

  try {
    const result = await context.updateChatState(
      namespace,
      (current = {}) => {
        const normalizedCurrent =
          normalizeLukerGraphJournalV2(current) ||
          buildLukerGraphJournalV2([], {
            chatId,
            integrity,
            headRevision: 0,
          });
        const existingEntries = Array.isArray(normalizedCurrent.entries)
          ? normalizedCurrent.entries.filter(
              (candidate) => Number(candidate?.revision || 0) !== normalizedEntry.revision,
            )
          : [];
        const nextEntries = [...existingEntries, normalizedEntry].sort(
          (left, right) => left.revision - right.revision,
        );
        const nextJournal = buildLukerGraphJournalV2(nextEntries, {
          chatId:
            normalizeIdentityValue(chatId) ||
            normalizedCurrent.chatId ||
            normalizedEntry.chatId,
          integrity:
            normalizeIdentityValue(integrity) ||
            normalizedCurrent.integrity ||
            normalizedEntry.integrity,
          headRevision: normalizedEntry.revision,
          updatedAt: normalizedEntry.persistedAt,
        });
        return nextJournal;
      },
      {
        ...(chatStateTarget ? { target: chatStateTarget } : {}),
        maxOperations,
        asyncDiff: false,
        maxRetries: 1,
      },
    );
    const journal = await readGraphChatStateNamespaces(
      context,
      [namespace],
      { target: chatStateTarget },
    );
    return {
      ok: result?.ok === true,
      updated: result?.updated !== false,
      reason:
        result?.ok === true
          ? result?.updated === false
            ? "chat-state-noop"
            : "chat-state-saved"
          : "chat-state-save-failed",
      journal: normalizeLukerGraphJournalV2(journal.get(namespace) || null),
      entry: normalizedEntry,
    };
  } catch (error) {
    console.warn("[ST-BME] 追加 Luker graph journal 失败:", error);
    return {
      ok: false,
      updated: false,
      reason: "chat-state-save-failed",
      error,
      journal: null,
      entry: normalizedEntry,
    };
  }
}

export async function replaceLukerGraphJournalV2(
  context = null,
  journal = null,
  {
    namespace = LUKER_GRAPH_JOURNAL_NAMESPACE,
    maxOperations = GRAPH_CHAT_STATE_MAX_OPERATIONS,
    chatStateTarget = null,
  } = {},
) {
  const normalizedJournal = normalizeLukerGraphJournalV2(journal);
  if (!normalizedJournal) {
    return {
      ok: false,
      updated: false,
      reason: "chat-state-build-failed",
      journal: null,
    };
  }

  const result = await writeGraphChatStatePayload(context, namespace, normalizedJournal, {
    maxOperations,
    asyncDiff: false,
    target: chatStateTarget,
  });
  return {
    ...result,
    journal: normalizedJournal,
  };
}

export async function writeLukerGraphCheckpointV2(
  context = null,
  checkpoint = null,
  {
    namespace = LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    maxOperations = GRAPH_CHAT_STATE_MAX_OPERATIONS,
    chatStateTarget = null,
  } = {},
) {
  const normalizedCheckpoint = normalizeLukerGraphCheckpointV2(checkpoint);
  if (!normalizedCheckpoint) {
    return {
      ok: false,
      updated: false,
      reason: "chat-state-build-failed",
      checkpoint: null,
    };
  }

  const result = await writeGraphChatStatePayload(context, namespace, normalizedCheckpoint, {
    maxOperations,
    asyncDiff: false,
    target: chatStateTarget,
  });
  return {
    ...result,
    checkpoint: normalizedCheckpoint,
  };
}

export function normalizeGraphChatStateSnapshot(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }

  const version = Number(snapshot.version);
  const revision = Number(snapshot.revision);
  const serializedGraph = String(snapshot.serializedGraph || "");
  const storageTier = String(snapshot.storageTier || "chat-state");
  const chatId = normalizeIdentityValue(snapshot.chatId);
  const integrity = normalizeIdentityValue(snapshot.integrity);
  const commitMarker = normalizeGraphCommitMarker(snapshot.commitMarker);

  if (!serializedGraph) {
    return null;
  }

  return {
    version: Number.isFinite(version) && version > 0 ? version : GRAPH_CHAT_STATE_VERSION,
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
    serializedGraph,
    persistedAt: String(snapshot.persistedAt || ""),
    updatedAt: String(snapshot.updatedAt || snapshot.persistedAt || ""),
    reason: String(snapshot.reason || ""),
    storageTier,
    chatId,
    integrity,
    commitMarker,
  };
}

export function buildGraphChatStateSnapshot(
  graph,
  {
    revision = 0,
    storageTier = "chat-state",
    accepted = true,
    reason = "",
    persistedAt = "",
    updatedAt = "",
    chatId = "",
    integrity = "",
    lastProcessedAssistantFloor = null,
    extractionCount = null,
  } = {},
) {
  if (!graph) {
    return null;
  }

  const commitMarker = buildGraphCommitMarker(graph, {
    revision,
    storageTier,
    accepted,
    reason,
    persistedAt,
    chatId,
    integrity,
    lastProcessedAssistantFloor,
    extractionCount,
  });

  return normalizeGraphChatStateSnapshot({
    version: GRAPH_CHAT_STATE_VERSION,
    revision,
    serializedGraph: serializeGraph(graph),
    persistedAt: String(persistedAt || new Date().toISOString()),
    updatedAt: String(updatedAt || persistedAt || new Date().toISOString()),
    reason: String(reason || ""),
    storageTier: String(storageTier || "chat-state"),
    chatId,
    integrity,
    commitMarker,
  });
}

export async function readGraphChatStateSnapshot(
  context = null,
  { namespace = GRAPH_CHAT_STATE_NAMESPACE, target = null } = {},
) {
  if (!canUseGraphChatState(context)) {
    return null;
  }

  try {
    const payload = await context.getChatState(
      namespace,
      target ? { target } : undefined,
    );
    return normalizeGraphChatStateSnapshot(payload);
  } catch (error) {
    console.warn("[ST-BME] 读取聊天侧车图谱失败:", error);
    return null;
  }
}

export async function writeGraphChatStateSnapshot(
  context = null,
  graph = null,
  {
    namespace = GRAPH_CHAT_STATE_NAMESPACE,
    revision = 0,
    storageTier = "chat-state",
    accepted = true,
    reason = "",
    chatId = "",
    integrity = "",
    lastProcessedAssistantFloor = null,
    extractionCount = null,
    maxOperations = GRAPH_CHAT_STATE_MAX_OPERATIONS,
    target = null,
  } = {},
) {
  if (!canUseGraphChatState(context) || !graph) {
    return {
      ok: false,
      updated: false,
      snapshot: null,
      reason: "chat-state-unavailable",
    };
  }

  const snapshot = buildGraphChatStateSnapshot(graph, {
    revision,
    storageTier,
    accepted,
    reason,
    chatId,
    integrity,
    lastProcessedAssistantFloor,
    extractionCount,
  });
  if (!snapshot) {
    return {
      ok: false,
      updated: false,
      snapshot: null,
      reason: "chat-state-build-failed",
    };
  }

  try {
    const result = await context.updateChatState(
      namespace,
      () => snapshot,
      {
        ...(target ? { target } : {}),
        maxOperations,
        asyncDiff: false,
        maxRetries: 1,
      },
    );
    return {
      ok: result?.ok === true,
      updated: result?.updated !== false,
      snapshot,
      reason:
        result?.ok === true
          ? result?.updated === false
            ? "chat-state-noop"
            : "chat-state-saved"
          : "chat-state-save-failed",
    };
  } catch (error) {
    console.warn("[ST-BME] 写入聊天侧车图谱失败:", error);
    return {
      ok: false,
      updated: false,
      snapshot,
      reason: "chat-state-save-failed",
      error,
    };
  }
}

export async function deleteGraphChatStateNamespace(
  context = null,
  namespace = "",
  { target = null } = {},
) {
  if (
    !canUseGraphChatState(context) ||
    typeof context?.deleteChatState !== "function" ||
    !String(namespace || "").trim()
  ) {
    return false;
  }

  try {
    return Boolean(
      await context.deleteChatState(
        namespace,
        target ? { target } : undefined,
      ),
    );
  } catch (error) {
    console.warn(`[ST-BME] 删除聊天侧车 ${namespace} 失败:`, error);
    return false;
  }
}

export function normalizeGraphCommitMarker(marker = null) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }

  const revision = Number(marker.revision);
  const lastProcessedAssistantFloor = Number(marker.lastProcessedAssistantFloor);
  const extractionCount = Number(marker.extractionCount);
  const nodeCount = Number(marker.nodeCount);
  const edgeCount = Number(marker.edgeCount);
  const archivedCount = Number(marker.archivedCount);

  return {
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
    lastProcessedAssistantFloor:
      Number.isFinite(lastProcessedAssistantFloor)
        ? Math.floor(lastProcessedAssistantFloor)
        : -1,
    extractionCount:
      Number.isFinite(extractionCount) && extractionCount >= 0
        ? Math.floor(extractionCount)
        : 0,
    nodeCount:
      Number.isFinite(nodeCount) && nodeCount >= 0 ? Math.floor(nodeCount) : 0,
    edgeCount:
      Number.isFinite(edgeCount) && edgeCount >= 0 ? Math.floor(edgeCount) : 0,
    archivedCount:
      Number.isFinite(archivedCount) && archivedCount >= 0
        ? Math.floor(archivedCount)
        : 0,
    persistedAt: String(marker.persistedAt || ""),
    storageTier: String(marker.storageTier || "none"),
    accepted: marker.accepted === true,
    reason: String(marker.reason || ""),
    chatId: normalizeIdentityValue(marker.chatId),
    integrity: normalizeIdentityValue(marker.integrity),
  };
}

export function buildGraphCommitMarker(
  graph,
  {
    revision = 0,
    storageTier = "none",
    accepted = false,
    reason = "",
    persistedAt = "",
    chatId = "",
    integrity = "",
    lastProcessedAssistantFloor = null,
    extractionCount = null,
  } = {},
) {
  const stats = graph ? getGraphStats(graph) : null;
  const historyState = graph?.historyState || {};
  const hasExplicitLastProcessedFloor =
    lastProcessedAssistantFloor !== null &&
    lastProcessedAssistantFloor !== undefined &&
    lastProcessedAssistantFloor !== "";
  const hasExplicitExtractionCount =
    extractionCount !== null &&
    extractionCount !== undefined &&
    extractionCount !== "";
  return normalizeGraphCommitMarker({
    revision,
    lastProcessedAssistantFloor:
      hasExplicitLastProcessedFloor &&
      Number.isFinite(Number(lastProcessedAssistantFloor))
        ? Number(lastProcessedAssistantFloor)
        : Number.isFinite(Number(historyState.lastProcessedAssistantFloor))
          ? Number(historyState.lastProcessedAssistantFloor)
          : Number.isFinite(Number(stats?.lastProcessedSeq))
            ? Number(stats.lastProcessedSeq)
            : -1,
    extractionCount:
      hasExplicitExtractionCount &&
      Number.isFinite(Number(extractionCount))
        ? Number(extractionCount)
        : Number.isFinite(Number(historyState.extractionCount))
          ? Number(historyState.extractionCount)
          : 0,
    nodeCount: Number(stats?.activeNodes || 0),
    edgeCount: Number(stats?.totalEdges || 0),
    archivedCount: Number(stats?.archivedNodes || 0),
    persistedAt: String(persistedAt || new Date().toISOString()),
    storageTier: String(storageTier || "none"),
    accepted: accepted === true,
    reason: String(reason || ""),
    chatId,
    integrity,
  });
}

export function readGraphCommitMarker(context = null) {
  const rawMarker =
    context?.chatMetadata &&
    typeof context.chatMetadata === "object" &&
    !Array.isArray(context.chatMetadata)
      ? context.chatMetadata[GRAPH_COMMIT_MARKER_KEY]
      : null;
  const marker = normalizeGraphCommitMarker(rawMarker);
  return marker?.revision ? marker : null;
}

export function getAcceptedCommitMarkerRevision(marker = null) {
  const normalizedMarker = normalizeGraphCommitMarker(marker);
  return normalizedMarker?.accepted === true
    ? Number(normalizedMarker.revision || 0)
    : 0;
}

export function detectIndexedDbSnapshotCommitMarkerMismatch(
  snapshot = null,
  marker = null,
) {
  const normalizedMarker = normalizeGraphCommitMarker(marker);
  if (!normalizedMarker || normalizedMarker.accepted !== true) {
    return {
      mismatched: false,
      reason: "",
      markerRevision: 0,
      snapshotRevision: Number.isFinite(Number(snapshot?.meta?.revision))
        ? Number(snapshot.meta.revision)
        : 0,
    };
  }

  const snapshotRevision = Number.isFinite(Number(snapshot?.meta?.revision))
    ? Number(snapshot.meta.revision)
    : 0;
  const markerRevision = Number(normalizedMarker.revision || 0);
  if (markerRevision <= 0 || snapshotRevision >= markerRevision) {
    return {
      mismatched: false,
      reason: "",
      markerRevision,
      snapshotRevision,
    };
  }

  return {
    mismatched: true,
    reason: "persist-mismatch:indexeddb-behind-commit-marker",
    markerRevision,
    snapshotRevision,
    marker: normalizedMarker,
  };
}

// ═══════════════════════════════════════════════════════════
// Shadow Snapshot（会话存储）
// ═══════════════════════════════════════════════════════════

export function getGraphShadowSnapshotStorageKey(chatId = "") {
  const normalizedChatId = String(chatId || "").trim();
  if (!normalizedChatId) return "";
  return `${GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX}${encodeURIComponent(normalizedChatId)}`;
}

export function readGraphShadowSnapshot(chatId = "") {
  const storageKey = getGraphShadowSnapshotStorageKey(chatId);
  if (!storageKey) return null;

  try {
    const raw = getSessionStorageSafe()?.getItem(storageKey);
    if (!raw) return null;
    const snapshot = normalizeShadowSnapshotPayload(JSON.parse(raw));
    if (!snapshot || snapshot.chatId !== String(chatId || "")) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

export function findGraphShadowSnapshotByIntegrity(
  integrity = "",
  { excludeChatIds = [] } = {},
) {
  const normalizedIntegrity = normalizeIdentityValue(integrity);
  if (!normalizedIntegrity) return null;

  const storage = getSessionStorageSafe();
  if (!storage) return null;

  const excludedChatIds = new Set(
    (Array.isArray(excludeChatIds) ? excludeChatIds : [])
      .map((value) => normalizeIdentityValue(value))
      .filter(Boolean),
  );

  let bestSnapshot = null;
  for (const key of listStorageKeys(storage)) {
    if (!String(key || "").startsWith(GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX)) {
      continue;
    }

    try {
      const snapshot = normalizeShadowSnapshotPayload(
        JSON.parse(storage.getItem(key)),
      );
      if (!snapshot || snapshot.integrity !== normalizedIntegrity) {
        continue;
      }
      if (excludedChatIds.has(snapshot.chatId)) {
        continue;
      }

      const bestRevision = Number(bestSnapshot?.revision || 0);
      const nextRevision = Number(snapshot.revision || 0);
      if (!bestSnapshot || nextRevision > bestRevision) {
        bestSnapshot = snapshot;
        continue;
      }

      if (
        nextRevision === bestRevision &&
        String(snapshot.updatedAt || "") > String(bestSnapshot.updatedAt || "")
      ) {
        bestSnapshot = snapshot;
      }
    } catch {
      // ignore broken shadow snapshot payloads
    }
  }

  return bestSnapshot;
}

/**
 * @param {string} chatId
 * @param {object} graph
 * @param {object} [opts]
 * @param {number} [opts.revision]
 * @param {string} [opts.reason]
 */
export function writeGraphShadowSnapshot(
  chatId,
  graph,
  { revision = 0, reason = "", integrity = "", debugReason = "" } = {},
) {
  const storageKey = getGraphShadowSnapshotStorageKey(chatId);
  if (!storageKey || !graph) return false;

  try {
    const serializedGraph = serializeGraph(graph);
    const persistedMeta = getGraphPersistenceMeta(graph) || {};
    getSessionStorageSafe()?.setItem(
      storageKey,
      JSON.stringify({
        chatId: String(chatId || ""),
        revision: Number.isFinite(revision) ? revision : 0,
        serializedGraph,
        updatedAt: new Date().toISOString(),
        reason: String(reason || ""),
        integrity: String(integrity || persistedMeta.integrity || ""),
        persistedChatId: String(persistedMeta.chatId || ""),
        debugReason: String(debugReason || reason || ""),
      }),
    );
    return true;
  } catch (error) {
    console.warn("[ST-BME] 写入会话图谱临时快照失败:", error);
    return false;
  }
}

export function removeGraphShadowSnapshot(chatId = "") {
  const storageKey = getGraphShadowSnapshotStorageKey(chatId);
  if (!storageKey) return false;

  try {
    getSessionStorageSafe()?.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 图谱克隆 / 比较
// ═══════════════════════════════════════════════════════════

export function cloneGraphForPersistence(graph, chatId = "") {
  const clonedGraph = normalizeGraphRuntimeState(
    deserializeGraph(serializeGraph(graph)),
    chatId,
  );
  cloneGraphPersistDirtyState(graph, clonedGraph);
  return clonedGraph;
}

export function shouldPreferShadowSnapshotOverOfficial(
  officialGraph,
  shadowSnapshot,
) {
  if (!shadowSnapshot) {
    return {
      prefer: false,
      reason: "shadow-missing",
      resultCode: "shadow.missing",
    };
  }

  const shadowRevision = Number(shadowSnapshot.revision || 0);
  const officialRevision = getGraphPersistedRevision(officialGraph);
  const officialMeta = getGraphPersistenceMeta(officialGraph) || {};
  const normalizedOfficialChatId = String(officialMeta.chatId || "").trim();
  const normalizedShadowChatId = String(shadowSnapshot.chatId || "").trim();
  const normalizedShadowPersistedChatId = String(
    shadowSnapshot.persistedChatId || "",
  ).trim();
  const officialIntegrity = String(officialMeta.integrity || "").trim();
  const shadowIntegrity = String(shadowSnapshot.integrity || "").trim();

  if (shadowRevision <= 0) {
    return {
      prefer: false,
      reason: "shadow-revision-invalid",
      resultCode: "shadow.reject.revision-invalid",
      shadowRevision,
      officialRevision,
    };
  }

  if (
    normalizedOfficialChatId &&
    normalizedShadowPersistedChatId &&
    normalizedOfficialChatId !== normalizedShadowPersistedChatId
  ) {
    return {
      prefer: false,
      reason: "shadow-persisted-chat-mismatch",
      resultCode: "shadow.reject.persisted-chat-mismatch",
      shadowRevision,
      officialRevision,
      officialChatId: normalizedOfficialChatId,
      shadowPersistedChatId: normalizedShadowPersistedChatId,
    };
  }

  if (
    normalizedOfficialChatId &&
    normalizedShadowChatId &&
    normalizedOfficialChatId !== normalizedShadowChatId
  ) {
    return {
      prefer: false,
      reason: "shadow-chat-mismatch",
      resultCode: "shadow.reject.chat-mismatch",
      shadowRevision,
      officialRevision,
      officialChatId: normalizedOfficialChatId,
      shadowChatId: normalizedShadowChatId,
    };
  }

  if (
    officialIntegrity &&
    shadowIntegrity &&
    officialIntegrity !== shadowIntegrity
  ) {
    return {
      prefer: false,
      reason: "shadow-integrity-mismatch",
      resultCode: "shadow.reject.integrity-mismatch",
      shadowRevision,
      officialRevision,
      officialIntegrity,
      shadowIntegrity,
    };
  }

  if (
    normalizedShadowPersistedChatId &&
    normalizedShadowChatId &&
    normalizedShadowPersistedChatId !== normalizedShadowChatId
  ) {
    return {
      prefer: false,
      reason: "shadow-self-chat-mismatch",
      resultCode: "shadow.reject.self-chat-mismatch",
      shadowRevision,
      officialRevision,
      shadowChatId: normalizedShadowChatId,
      shadowPersistedChatId: normalizedShadowPersistedChatId,
    };
  }

  if (normalizedShadowPersistedChatId && !normalizedOfficialChatId) {
    return {
      prefer: false,
      reason: "shadow-persisted-chat-without-official-chat",
      resultCode: "shadow.reject.persisted-chat-without-official-chat",
      shadowRevision,
      officialRevision,
      shadowPersistedChatId: normalizedShadowPersistedChatId,
    };
  }

  if (shadowIntegrity && !officialIntegrity) {
    return {
      prefer: false,
      reason: "shadow-integrity-without-official-integrity",
      resultCode: "shadow.reject.integrity-without-official-integrity",
      shadowRevision,
      officialRevision,
      shadowIntegrity,
    };
  }

  return {
    prefer: shadowRevision > 0 && shadowRevision > officialRevision,
    reason:
      shadowRevision > officialRevision
        ? "shadow-newer-than-official"
        : "shadow-not-newer-than-official",
    resultCode:
      shadowRevision > officialRevision
        ? "shadow.accept.newer-than-official"
        : "shadow.keep.official-not-older",
    shadowRevision,
    officialRevision,
  };
}
