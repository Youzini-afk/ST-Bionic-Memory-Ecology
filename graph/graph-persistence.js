// ST-BME: 图谱持久化常量与纯工具函数
// 不依赖 index.js 模块级可变状态（currentGraph / graphPersistenceState 等）

import { deserializeGraph, getGraphStats, serializeGraph } from "./graph.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

export const MODULE_NAME = "st_bme";
export const GRAPH_METADATA_KEY = "st_bme_graph";
export const GRAPH_COMMIT_MARKER_KEY = "st_bme_commit_marker";
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
  return normalizeGraphRuntimeState(
    deserializeGraph(serializeGraph(graph)),
    chatId,
  );
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
