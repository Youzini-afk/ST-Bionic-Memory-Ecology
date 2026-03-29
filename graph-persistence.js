// ST-BME: 图谱持久化常量与纯工具函数
// 不依赖 index.js 模块级可变状态（currentGraph / graphPersistenceState 等）

import {
  deserializeGraph,
  serializeGraph,
} from "./graph.js";
import { normalizeGraphRuntimeState } from "./runtime-state.js";

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

export const MODULE_NAME = "st_bme";
export const GRAPH_METADATA_KEY = "st_bme_graph";
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
    const raw = globalThis.sessionStorage?.getItem(storageKey);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      String(snapshot.chatId || "") !== String(chatId || "") ||
      typeof snapshot.serializedGraph !== "string" ||
      !snapshot.serializedGraph
    ) {
      return null;
    }
    return {
      chatId: String(snapshot.chatId || ""),
      revision: Number.isFinite(snapshot.revision) ? snapshot.revision : 0,
      serializedGraph: snapshot.serializedGraph,
      updatedAt: String(snapshot.updatedAt || ""),
      reason: String(snapshot.reason || ""),
    };
  } catch {
    return null;
  }
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
  { revision = 0, reason = "" } = {},
) {
  const storageKey = getGraphShadowSnapshotStorageKey(chatId);
  if (!storageKey || !graph) return false;

  try {
    const serializedGraph = serializeGraph(graph);
    globalThis.sessionStorage?.setItem(
      storageKey,
      JSON.stringify({
        chatId: String(chatId || ""),
        revision: Number.isFinite(revision) ? revision : 0,
        serializedGraph,
        updatedAt: new Date().toISOString(),
        reason: String(reason || ""),
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
    globalThis.sessionStorage?.removeItem(storageKey);
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

export function shouldPreferShadowSnapshotOverOfficial(officialGraph, shadowSnapshot) {
  if (!shadowSnapshot) return false;
  const shadowRevision = Number(shadowSnapshot.revision || 0);
  const officialRevision = getGraphPersistedRevision(officialGraph);
  return shadowRevision > 0 && shadowRevision > officialRevision;
}
