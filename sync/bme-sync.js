import { BmeDatabase } from "./bme-db.js";
import {
  MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY,
  PROCESSED_MESSAGE_HASH_VERSION,
} from "../runtime/runtime-state.js";

const BME_SYNC_FILE_PREFIX = "ST-BME_sync_";
const BME_SYNC_FILE_SUFFIX = ".json";
const BME_SYNC_FILENAME_MAX_LENGTH = 180;
const BME_BACKUP_FILE_PREFIX = "ST-BME_backup_";
const BME_BACKUP_MANIFEST_FILENAME = "ST-BME_BackupManifest.json";
const BME_BACKUP_SCHEMA_VERSION = 1;

export const BME_SYNC_DEVICE_ID_KEY = "st_bme_sync_device_id_v1";
export const BME_SYNC_UPLOAD_DEBOUNCE_MS = 2500;

const syncInFlightByChatId = new Map();
const uploadDebounceTimerByChatId = new Map();
const sanitizedFilenameByChatId = new Map();

let visibilitySyncInstalled = false;
let lastVisibilityState = "visible";

const RUNTIME_HISTORY_META_KEY = "runtimeHistoryState";
const RUNTIME_VECTOR_META_KEY = "runtimeVectorIndexState";
const RUNTIME_BATCH_JOURNAL_META_KEY = "runtimeBatchJournal";
const RUNTIME_LAST_RECALL_META_KEY = "runtimeLastRecallResult";
const RUNTIME_SUMMARY_STATE_META_KEY = "runtimeSummaryState";
const RUNTIME_MAINTENANCE_JOURNAL_META_KEY = "maintenanceJournal";
const RUNTIME_KNOWLEDGE_STATE_META_KEY = "knowledgeState";
const RUNTIME_REGION_STATE_META_KEY = "regionState";
const RUNTIME_TIMELINE_STATE_META_KEY = "timelineState";
const RUNTIME_LAST_PROCESSED_SEQ_META_KEY = "runtimeLastProcessedSeq";
const RUNTIME_GRAPH_VERSION_META_KEY = "runtimeGraphVersion";
const RUNTIME_BATCH_JOURNAL_LIMIT = 96;
const MANUAL_BACKUP_BATCH_JOURNAL_LIMIT = 4;

function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

export function buildRestoreSafetyChatId(chatId) {
  return `__restore_safety__${normalizeChatId(chatId)}`;
}

function resolveCloudStorageMode(options = {}) {
  const mode =
    typeof options.getCloudStorageMode === "function"
      ? options.getCloudStorageMode()
      : options.cloudStorageMode;
  return String(mode || "automatic").trim().toLowerCase() === "manual"
    ? "manual"
    : "automatic";
}

function isAutomaticCloudMode(options = {}) {
  return resolveCloudStorageMode(options) === "automatic";
}

function createStableFilenameHash(input = "") {
  let hash = 2166136261;
  const normalized = String(input ?? "");
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeRemoteFilenameCandidate(fileName, fallbackValue = "ST-BME_sync_unknown.json") {
  const raw = String(fileName ?? "");
  const normalized = typeof raw.normalize === "function" ? raw.normalize("NFKD") : raw;
  const sanitized = normalized
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/g, "")
    .slice(0, BME_SYNC_FILENAME_MAX_LENGTH)
    .trim();
  return sanitized || fallbackValue;
}

function buildBackupFilename(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  const hash = createStableFilenameHash(normalizedChatId || "unknown");
  const rawSlug = normalizeRemoteFilenameCandidate(normalizedChatId, "");
  const suffixPart = `-${hash}${BME_SYNC_FILE_SUFFIX}`;
  const maxSlugLength = Math.max(
    0,
    BME_SYNC_FILENAME_MAX_LENGTH -
      BME_BACKUP_FILE_PREFIX.length -
      suffixPart.length,
  );
  const safeSlug = rawSlug
    .slice(0, maxSlugLength)
    .replace(/^[_.-]+|[_.-]+$/g, "");
  const core = safeSlug
    ? `${BME_BACKUP_FILE_PREFIX}${safeSlug}-${hash}`
    : `${BME_BACKUP_FILE_PREFIX}${hash}`;
  return `${core}${BME_SYNC_FILE_SUFFIX}`;
}

function normalizeLegacyRemoteFilenameCandidate(
  fileName,
  fallbackValue = "ST-BME_sync_unknown.json",
) {
  const raw = String(fileName ?? "");
  const normalized =
    typeof raw.normalize === "function" ? raw.normalize("NFKD") : raw;
  const sanitized = normalized
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._~-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/g, "")
    .slice(0, BME_SYNC_FILENAME_MAX_LENGTH)
    .trim();
  return sanitized || fallbackValue;
}

function buildSyncFilename(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  const legacyName = `${BME_SYNC_FILE_PREFIX}${normalizedChatId}${BME_SYNC_FILE_SUFFIX}`;
  if (
    normalizedChatId
    && /^[A-Za-z0-9._-]+$/.test(normalizedChatId)
    && legacyName.length <= BME_SYNC_FILENAME_MAX_LENGTH
  ) {
    return legacyName;
  }

  const hash = createStableFilenameHash(normalizedChatId || "unknown");
  const rawSlug = normalizeRemoteFilenameCandidate(normalizedChatId, "");
  const suffixPart = `-${hash}${BME_SYNC_FILE_SUFFIX}`;
  const maxSlugLength = Math.max(
    0,
    BME_SYNC_FILENAME_MAX_LENGTH - BME_SYNC_FILE_PREFIX.length - suffixPart.length,
  );
  const safeSlug = rawSlug.slice(0, maxSlugLength).replace(/^[_.-]+|[_.-]+$/g, "");
  const core = safeSlug
    ? `${BME_SYNC_FILE_PREFIX}${safeSlug}-${hash}`
    : `${BME_SYNC_FILE_PREFIX}${hash}`;
  return `${core}${BME_SYNC_FILE_SUFFIX}`;
}

function buildLegacyRawSyncFilename(chatId) {
  return `${BME_SYNC_FILE_PREFIX}${normalizeChatId(chatId)}${BME_SYNC_FILE_SUFFIX}`;
}

function rememberResolvedSyncFilename(chatId, filename) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedFilename = String(filename || "").trim();
  if (!normalizedChatId || !normalizedFilename) return "";
  sanitizedFilenameByChatId.set(normalizedChatId, normalizedFilename);
  return normalizedFilename;
}

function normalizeRevision(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.floor(Number(fallback) || Date.now());
  return Math.floor(parsed);
}

function sanitizeSnapshotRecordArray(records) {
  return Array.isArray(records)
    ? records
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({ ...item }))
    : [];
}

function toSerializableData(value, fallback = null) {
  if (value == null) return fallback;

  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // no-op
    }
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeBackupManifestEntry(rawEntry = {}) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }

  const filename = String(rawEntry.filename || "").trim();
  if (
    !filename
    || !filename.startsWith(BME_BACKUP_FILE_PREFIX)
    || !filename.endsWith(BME_SYNC_FILE_SUFFIX)
  ) {
    return null;
  }

  return {
    filename,
    serverPath: String(rawEntry.serverPath || "").trim(),
    chatId: normalizeChatId(rawEntry.chatId),
    revision: normalizeRevision(rawEntry.revision),
    lastModified: normalizeTimestamp(rawEntry.lastModified, 0),
    backupTime: normalizeTimestamp(rawEntry.backupTime, 0),
    size: normalizeNonNegativeInteger(rawEntry.size, 0),
    schemaVersion: normalizeNonNegativeInteger(rawEntry.schemaVersion, 0),
  };
}

function normalizeBackupEnvelope(payload = {}, chatId = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const normalizedSnapshot = normalizeSyncSnapshot(payload.snapshot, chatId);
  return {
    kind: String(payload.kind || "st-bme-backup").trim().toLowerCase(),
    version: normalizeNonNegativeInteger(payload.version, 0),
    chatId: normalizeChatId(payload.chatId || normalizedSnapshot.meta?.chatId),
    createdAt: normalizeTimestamp(payload.createdAt, 0),
    sourceDeviceId: String(payload.sourceDeviceId || "").trim(),
    snapshot: normalizedSnapshot,
  };
}

function getStorage() {
  const storage = globalThis.localStorage;
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return null;
  }
  return storage;
}

function getRandomBytes(size = 16) {
  if (globalThis.crypto?.getRandomValues) {
    const buffer = new Uint8Array(size);
    globalThis.crypto.getRandomValues(buffer);
    return buffer;
  }

  const fallback = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    fallback[index] = Math.floor(Math.random() * 256);
  }
  return fallback;
}

function createFallbackDeviceId() {
  const bytes = getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeBase64Utf8(text) {
  const normalizedText = String(text ?? "");

  if (typeof globalThis.btoa === "function" && typeof globalThis.TextEncoder === "function") {
    const bytes = new TextEncoder().encode(normalizedText);
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return globalThis.btoa(binary);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalizedText, "utf8").toString("base64");
  }

  throw new Error("当前环境缺少 base64 编码能力");
}

function decodeBase64Utf8(base64Text) {
  const normalizedBase64 = String(base64Text ?? "");

  if (typeof globalThis.atob === "function" && typeof globalThis.TextDecoder === "function") {
    const binary = globalThis.atob(normalizedBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalizedBase64, "base64").toString("utf8");
  }

  throw new Error("当前环境缺少 base64 解码能力");
}

function getFetch(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch 不可用，无法执行 ST-BME 同步请求");
  }
  return fetchImpl;
}

async function getSafetyDb(chatId, options = {}) {
  if (typeof options.getSafetyDb === "function") {
    return await options.getSafetyDb(chatId);
  }

  const db = new BmeDatabase(buildRestoreSafetyChatId(chatId));
  await db.open();
  return db;
}

async function fetchBackupManifest(options = {}) {
  const fetchImpl = getFetch(options);
  const response = await fetchImpl(
    `/user/files/${BME_BACKUP_MANIFEST_FILENAME}?t=${Date.now()}`,
    {
      method: "GET",
      cache: "no-store",
    },
  );
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(errorText || `manifest read failed: HTTP ${response.status}`);
  }
  const rawPayload = await response.json();
  if (!Array.isArray(rawPayload)) {
    throw new Error("backup manifest payload is not an array");
  }
  return rawPayload.map(normalizeBackupManifestEntry).filter(Boolean);
}

async function writeBackupManifest(entries = [], options = {}) {
  const fetchImpl = getFetch(options);
  const payload = JSON.stringify(entries);
  const response = await fetchImpl("/api/files/upload", {
    method: "POST",
    headers: {
      ...getRequestHeadersSafe(options),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: BME_BACKUP_MANIFEST_FILENAME,
      data: encodeBase64Utf8(payload),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(errorText || `HTTP ${response.status}`);
  }
}

async function upsertBackupManifestEntry(entry, options = {}) {
  const existingEntries = await fetchBackupManifest(options);
  const filteredEntries = existingEntries.filter(
    (candidate) => candidate.filename !== entry.filename,
  );
  filteredEntries.push(normalizeBackupManifestEntry(entry));
  filteredEntries.sort((left, right) => right.backupTime - left.backupTime);
  await writeBackupManifest(filteredEntries, options);
}

function normalizeSelectedBackupFilename(filename) {
  const normalized = String(filename ?? "")
    .trim()
    .replace(/^\/+/, "");
  if (
    !normalized
    || normalized === BME_BACKUP_MANIFEST_FILENAME
    || /[\\/]/.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

function normalizeSelectedBackupServerPath(serverPath, fallbackFilename = "") {
  const normalizedPath = String(serverPath ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (normalizedPath && !normalizedPath.includes("..")) {
    return `/${normalizedPath}`;
  }

  const normalizedFilename = normalizeSelectedBackupFilename(fallbackFilename);
  return normalizedFilename ? `/user/files/${normalizedFilename}` : "";
}

function sortBackupManifestEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const timeDelta =
      normalizeTimestamp(right.backupTime, 0) -
      normalizeTimestamp(left.backupTime, 0);
    if (timeDelta !== 0) return timeDelta;

    const modifiedDelta =
      normalizeTimestamp(right.lastModified, 0) -
      normalizeTimestamp(left.lastModified, 0);
    if (modifiedDelta !== 0) return modifiedDelta;

    return String(left.filename || "").localeCompare(
      String(right.filename || ""),
    );
  });
}

async function resolveBackupLookupContext(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const explicitFilename = normalizeSelectedBackupFilename(
    options.filename || options.backupFilename,
  );
  const explicitServerPath = normalizeSelectedBackupServerPath(
    options.serverPath,
    explicitFilename,
  );

  let manifestEntries = [];
  let manifestError = null;
  try {
    manifestEntries = sortBackupManifestEntries(await fetchBackupManifest(options));
  } catch (error) {
    manifestError = error;
  }

  const candidates = [];
  const candidateIndexByFilename = new Map();
  const pushCandidate = (filename, serverPath = "") => {
    const normalizedFilename = normalizeSelectedBackupFilename(filename);
    if (!normalizedFilename) return;

    const normalizedServerPath = normalizeSelectedBackupServerPath(
      serverPath,
      normalizedFilename,
    );
    const existingIndex = candidateIndexByFilename.get(normalizedFilename);
    if (existingIndex != null) {
      if (
        normalizedServerPath &&
        !candidates[existingIndex].serverPath
      ) {
        candidates[existingIndex].serverPath = normalizedServerPath;
      }
      return;
    }

    candidateIndexByFilename.set(normalizedFilename, candidates.length);
    candidates.push({
      filename: normalizedFilename,
      serverPath: normalizedServerPath,
    });
  };

  pushCandidate(explicitFilename, explicitServerPath);

  if (explicitFilename) {
    for (const entry of manifestEntries) {
      if (entry.filename === explicitFilename) {
        pushCandidate(entry.filename, entry.serverPath);
      }
    }
  }

  for (const entry of manifestEntries) {
    if (normalizeChatId(entry.chatId) === normalizedChatId) {
      pushCandidate(entry.filename, entry.serverPath);
    }
  }

  pushCandidate(buildBackupFilename(normalizedChatId));

  return {
    explicitFilename,
    manifestEntries,
    manifestError,
    candidates,
  };
}

async function readBackupEnvelope(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const lookup = await resolveBackupLookupContext(normalizedChatId, options);
  const fetchImpl = getFetch(options);
  const fallbackFilename = buildBackupFilename(normalizedChatId);
  let lastMissingFilename = lookup.candidates[0]?.filename || fallbackFilename;

  for (const candidate of lookup.candidates) {
    try {
      const response = await fetchImpl(
        `${candidate.serverPath || `/user/files/${encodeURIComponent(candidate.filename)}`}?t=${Date.now()}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );
      if (response.status === 404) {
        lastMissingFilename = candidate.filename;
        continue;
      }
      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        return {
          exists: false,
          filename: candidate.filename,
          envelope: null,
          reason: "backup-read-error",
          error: new Error(errorText || `HTTP ${response.status}`),
        };
      }

      const payload = await response.json();
      const envelope = normalizeBackupEnvelope(payload, normalizedChatId);
      if (!envelope) {
        return {
          exists: false,
          filename: candidate.filename,
          envelope: null,
          reason: "invalid-backup",
        };
      }
      return {
        exists: true,
        filename: candidate.filename,
        envelope,
        reason: "ok",
      };
    } catch (error) {
      return {
        exists: false,
        filename: candidate.filename,
        envelope: null,
        reason: "backup-read-error",
        error,
      };
    }
  }

  return {
    exists: false,
    filename: lastMissingFilename,
    envelope: null,
    reason: "not-found",
    manifestError: lookup.manifestError,
  };
}

async function syncDeletedBackupMeta(chatId, remainingEntry, options = {}) {
  try {
    const db = await getDb(chatId, options);
    await patchDbMeta(db, {
      lastBackupUploadedAt: remainingEntry
        ? normalizeTimestamp(
            remainingEntry.backupTime || remainingEntry.lastModified,
            0,
          )
        : 0,
      lastBackupFilename: remainingEntry
        ? String(remainingEntry.filename || "")
        : "",
    });
    return true;
  } catch {
    return false;
  }
}

async function writeBackupEnvelope(envelope, chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const filename = buildBackupFilename(normalizedChatId);
  const fetchImpl = getFetch(options);
  const payload = JSON.stringify(envelope);
  const response = await fetchImpl("/api/files/upload", {
    method: "POST",
    headers: {
      ...getRequestHeadersSafe(options),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: filename,
      data: encodeBase64Utf8(payload),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  const uploadResult = await response.json().catch(() => ({}));
  return {
    filename,
    path: String(uploadResult?.path || `/user/files/${filename}`),
  };
}

async function createRestoreSafetySnapshot(chatId, snapshot, options = {}) {
  const safetyDb = await getSafetyDb(chatId, options);
  const revision = normalizeRevision(snapshot?.meta?.revision);
  try {
    await safetyDb.importSnapshot(snapshot, {
      mode: "replace",
      preserveRevision: true,
      revision,
      markSyncDirty: false,
    });
    await patchDbMeta(safetyDb, {
      restoreSafetySnapshotExists: true,
      restoreSafetySnapshotCreatedAt: Date.now(),
      restoreSafetySnapshotChatId: normalizeChatId(chatId),
    });
  } finally {
    if (typeof options.getSafetyDb !== "function") {
      await safetyDb.close().catch(() => {});
    }
  }
}

export async function getRestoreSafetySnapshotStatus(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      exists: false,
      chatId: "",
      createdAt: 0,
      reason: "missing-chat-id",
    };
  }

  try {
    const safetyDb = await getSafetyDb(normalizedChatId, options);
    try {
      const exists = Boolean(
        await readDbMeta(safetyDb, "restoreSafetySnapshotExists", false),
      );
      const createdAt = normalizeTimestamp(
        await readDbMeta(safetyDb, "restoreSafetySnapshotCreatedAt", 0),
        0,
      );
      return {
        exists,
        chatId: normalizedChatId,
        createdAt: exists ? createdAt : 0,
        reason: exists ? "ok" : "not-found",
      };
    } finally {
      if (typeof options.getSafetyDb !== "function") {
        await safetyDb.close().catch(() => {});
      }
    }
  } catch (error) {
    return {
      exists: false,
      chatId: normalizedChatId,
      createdAt: 0,
      reason: "safety-status-error",
      error,
    };
  }
}

export async function rollbackFromRestoreSafetySnapshot(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      restored: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const status = await getRestoreSafetySnapshotStatus(normalizedChatId, options);
    if (!status.exists) {
      return {
        restored: false,
        chatId: normalizedChatId,
        reason: status.reason || "safety-not-found",
      };
    }

    const safetyDb = await getSafetyDb(normalizedChatId, options);
    try {
      const snapshot = normalizeSyncSnapshot(
        await safetyDb.exportSnapshot(),
        normalizedChatId,
      );
      const db = await getDb(normalizedChatId, options);
      await db.importSnapshot(snapshot, {
        mode: "replace",
        preserveRevision: true,
        revision: normalizeRevision(snapshot.meta?.revision),
        markSyncDirty: false,
      });
      await patchDbMeta(db, {
        deviceId: getOrCreateDeviceId(),
        syncDirty: true,
        syncDirtyReason: "restore-safety-rollback",
        lastBackupRollbackAt: Date.now(),
      });
      await invokeSyncAppliedHook(options, {
        chatId: normalizedChatId,
        action: "restore-backup",
        revision: normalizeRevision(snapshot.meta?.revision),
      });
      return {
        restored: true,
        chatId: normalizedChatId,
        revision: normalizeRevision(snapshot.meta?.revision),
        createdAt: normalizeTimestamp(status.createdAt, 0),
      };
    } finally {
      if (typeof options.getSafetyDb !== "function") {
        await safetyDb.close().catch(() => {});
      }
    }
  } catch (error) {
    console.warn("[ST-BME] 回滚本地安全快照失败:", error);
    return {
      restored: false,
      chatId: normalizedChatId,
      reason: "restore-safety-rollback-error",
      error,
    };
  }
}

function getRequestHeadersSafe(options = {}) {
  if (typeof options.getRequestHeaders === "function") {
    try {
      return options.getRequestHeaders() || {};
    } catch (error) {
      console.warn("[ST-BME] 读取请求头失败，回退为空请求头:", error);
      return {};
    }
  }
  return {};
}

function normalizeSyncSnapshot(snapshot = {}, chatId = "") {
  const normalizedChatId = normalizeChatId(chatId || snapshot?.meta?.chatId);
  const nowMs = Date.now();

  const nodes = sanitizeSnapshotRecordArray(snapshot?.nodes);
  const edges = sanitizeSnapshotRecordArray(snapshot?.edges);
  const tombstones = sanitizeSnapshotRecordArray(snapshot?.tombstones);

  const state = {
    lastProcessedFloor: Number.isFinite(Number(snapshot?.state?.lastProcessedFloor))
      ? Number(snapshot.state.lastProcessedFloor)
      : -1,
    extractionCount: Number.isFinite(Number(snapshot?.state?.extractionCount))
      ? Number(snapshot.state.extractionCount)
      : 0,
  };

  const incomingMeta =
    snapshot?.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
      ? { ...snapshot.meta }
      : {};

  const meta = {
    ...incomingMeta,
    schemaVersion: Number.isFinite(Number(incomingMeta.schemaVersion))
      ? Number(incomingMeta.schemaVersion)
      : 1,
    chatId: normalizedChatId,
    deviceId: String(incomingMeta.deviceId || "").trim(),
    revision: normalizeRevision(incomingMeta.revision),
    lastModified: normalizeTimestamp(incomingMeta.lastModified, nowMs),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    tombstoneCount: tombstones.length,
  };

  return {
    meta,
    nodes,
    edges,
    tombstones,
    state,
  };
}

function createRecordWinnerByUpdatedAt(localRecord, remoteRecord) {
  if (!localRecord) return remoteRecord || null;
  if (!remoteRecord) return localRecord || null;

  const localUpdatedAt = normalizeTimestamp(localRecord.updatedAt, 0);
  const remoteUpdatedAt = normalizeTimestamp(remoteRecord.updatedAt, 0);

  if (remoteUpdatedAt > localUpdatedAt) {
    return remoteRecord;
  }

  if (localUpdatedAt > remoteUpdatedAt) {
    return localRecord;
  }

  return remoteRecord;
}

function buildTombstoneIndex(tombstones = []) {
  const tombstoneById = new Map();
  const tombstoneByTarget = new Map();

  for (const tombstone of tombstones) {
    if (!tombstone || typeof tombstone !== "object") continue;

    const normalizedTombstone = {
      ...tombstone,
      id: String(tombstone.id || "").trim(),
      kind: String(tombstone.kind || "").trim(),
      targetId: String(tombstone.targetId || "").trim(),
      sourceDeviceId: String(tombstone.sourceDeviceId || "").trim(),
      deletedAt: normalizeTimestamp(tombstone.deletedAt, 0),
    };

    if (!normalizedTombstone.id) continue;

    const existingById = tombstoneById.get(normalizedTombstone.id);
    if (!existingById || normalizedTombstone.deletedAt >= existingById.deletedAt) {
      tombstoneById.set(normalizedTombstone.id, normalizedTombstone);
    }

    if (normalizedTombstone.kind && normalizedTombstone.targetId) {
      const targetKey = `${normalizedTombstone.kind}:${normalizedTombstone.targetId}`;
      const existingByTarget = tombstoneByTarget.get(targetKey);
      if (!existingByTarget || normalizedTombstone.deletedAt >= existingByTarget.deletedAt) {
        tombstoneByTarget.set(targetKey, normalizedTombstone);
      }
    }
  }

  return {
    byId: tombstoneById,
    byTarget: tombstoneByTarget,
  };
}

function filterRecordsByTombstones(records = [], kind, tombstoneIndex) {
  const normalizedKind = String(kind || "").trim();
  if (!normalizedKind || !tombstoneIndex?.byTarget) return records;

  return records.filter((record) => {
    const recordId = String(record?.id || "").trim();
    if (!recordId) return false;

    const targetKey = `${normalizedKind}:${recordId}`;
    const tombstone = tombstoneIndex.byTarget.get(targetKey);
    if (!tombstone) return true;

    const deletedAt = normalizeTimestamp(tombstone.deletedAt, 0);
    const updatedAt = normalizeTimestamp(record?.updatedAt, 0);
    return deletedAt <= updatedAt;
  });
}

function mergeRecordCollectionById(localRecords = [], remoteRecords = []) {
  const mergedById = new Map();

  for (const record of localRecords) {
    const id = String(record?.id || "").trim();
    if (!id) continue;
    mergedById.set(id, { ...record, id });
  }

  for (const record of remoteRecords) {
    const id = String(record?.id || "").trim();
    if (!id) continue;

    const localRecord = mergedById.get(id) || null;
    const remoteRecord = { ...record, id };
    const winner = createRecordWinnerByUpdatedAt(localRecord, remoteRecord);
    if (winner) mergedById.set(id, winner);
  }

  return Array.from(mergedById.values());
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.floor(parsed);
}

function normalizeOptionalFloor(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function normalizeStringMap(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(value || "").trim();
    if (!normalizedKey || !normalizedValue) continue;
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function normalizeProcessedMessageHashes(record = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }

  const normalized = {};
  for (const [floorKey, hashValue] of Object.entries(record)) {
    const floor = Number.parseInt(floorKey, 10);
    const normalizedHash = String(hashValue || "").trim();
    if (!Number.isFinite(floor) || floor < 0 || !normalizedHash) continue;
    normalized[String(floor)] = normalizedHash;
  }
  return normalized;
}

function sortProcessedMessageHashes(record = {}) {
  const sorted = {};
  const keys = Object.keys(record)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  for (const key of keys) {
    sorted[String(key)] = record[String(key)];
  }
  return sorted;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

function stableSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function readRuntimeTimestamp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }

  const candidates = [
    value.updatedAt,
    value.at,
    value.createdAt,
    value.completedAt,
    value.lastUpdatedAt,
    value.timestamp,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }

    if (typeof candidate === "string") {
      const dateValue = Date.parse(candidate);
      if (Number.isFinite(dateValue) && dateValue > 0) {
        return Math.floor(dateValue);
      }
    }
  }

  return 0;
}

function chooseNewerRuntimePayload(localValue, remoteValue) {
  const local = toSerializableData(localValue, null);
  const remote = toSerializableData(remoteValue, null);

  if (local == null) return remote;
  if (remote == null) return local;

  if (stableSerialize(local) === stableSerialize(remote)) {
    return local;
  }

  const localTimestamp = readRuntimeTimestamp(local);
  const remoteTimestamp = readRuntimeTimestamp(remote);
  if (remoteTimestamp > localTimestamp) return remote;
  if (localTimestamp > remoteTimestamp) return local;

  return null;
}

function pickMinFinite(values = [], fallbackValue = null) {
  const normalized = values.filter(Number.isFinite);
  if (!normalized.length) return fallbackValue;
  return Math.min(...normalized);
}

function normalizeRuntimeHistoryMeta(value = {}, fallbackChatId = "") {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? toSerializableData(value, {})
      : {};
  const processedMessageHashVersion = Number.isFinite(
    Number(input.processedMessageHashVersion),
  )
    ? Math.max(1, Math.floor(Number(input.processedMessageHashVersion)))
    : PROCESSED_MESSAGE_HASH_VERSION;
  const processedMessageHashesNeedRefresh =
    input.processedMessageHashesNeedRefresh === true ||
    processedMessageHashVersion !== PROCESSED_MESSAGE_HASH_VERSION;

  return {
    ...input,
    chatId: normalizeChatId(input.chatId || fallbackChatId),
    lastProcessedAssistantFloor: Number.isFinite(Number(input.lastProcessedAssistantFloor))
      ? Math.floor(Number(input.lastProcessedAssistantFloor))
      : -1,
    processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
    extractionCount: normalizeNonNegativeInteger(input.extractionCount, 0),
    processedMessageHashes: processedMessageHashesNeedRefresh
      ? {}
      : normalizeProcessedMessageHashes(input.processedMessageHashes),
    processedMessageHashesNeedRefresh,
    historyDirtyFrom: normalizeOptionalFloor(input.historyDirtyFrom),
    lastMutationReason:
      typeof input.lastMutationReason === "string" ? input.lastMutationReason : "",
    lastMutationSource:
      typeof input.lastMutationSource === "string" ? input.lastMutationSource : "",
    lastRecoveryResult: toSerializableData(input.lastRecoveryResult, null),
    lastBatchStatus: toSerializableData(input.lastBatchStatus, null),
  };
}

function resolveEarliestRetainedBatchFloor(journals = []) {
  let earliestFloor = null;
  for (const journal of Array.isArray(journals) ? journals : []) {
    const range = Array.isArray(journal?.processedRange)
      ? journal.processedRange
      : [];
    const startFloor = Number(range[0]);
    if (!Number.isFinite(startFloor)) continue;
    const normalizedFloor = Math.max(0, Math.floor(startFloor));
    earliestFloor =
      earliestFloor == null
        ? normalizedFloor
        : Math.min(earliestFloor, normalizedFloor);
  }
  return earliestFloor;
}

function buildManualBackupSnapshot(snapshot = {}, chatId = "") {
  const normalizedSnapshot = normalizeSyncSnapshot(snapshot, chatId);
  const meta = toSerializableData(normalizedSnapshot.meta, {});
  const originalBatchJournal = Array.isArray(meta[RUNTIME_BATCH_JOURNAL_META_KEY])
    ? toSerializableData(meta[RUNTIME_BATCH_JOURNAL_META_KEY], [])
    : [];
  const retainedBatchJournal = originalBatchJournal.slice(
    -MANUAL_BACKUP_BATCH_JOURNAL_LIMIT,
  );
  const historyState = normalizeRuntimeHistoryMeta(
    meta[RUNTIME_HISTORY_META_KEY],
    chatId,
  );

  historyState[MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY] = {
    truncated: originalBatchJournal.length > retainedBatchJournal.length,
    earliestRetainedFloor: resolveEarliestRetainedBatchFloor(retainedBatchJournal),
    retainedCount: retainedBatchJournal.length,
  };

  meta[RUNTIME_HISTORY_META_KEY] = historyState;
  meta[RUNTIME_BATCH_JOURNAL_META_KEY] = retainedBatchJournal;
  meta[RUNTIME_MAINTENANCE_JOURNAL_META_KEY] = [];

  return {
    meta,
    nodes: toSerializableData(normalizedSnapshot.nodes, []),
    edges: toSerializableData(normalizedSnapshot.edges, []),
    tombstones: toSerializableData(normalizedSnapshot.tombstones, []),
    state: toSerializableData(normalizedSnapshot.state, {
      lastProcessedFloor: -1,
      extractionCount: 0,
    }),
  };
}

function markManualBackupHistoryForLocalRebind(snapshot = {}, chatId = "") {
  const normalizedSnapshot = normalizeSyncSnapshot(snapshot, chatId);
  const meta = toSerializableData(normalizedSnapshot.meta, {});
  const historyState = normalizeRuntimeHistoryMeta(
    meta[RUNTIME_HISTORY_META_KEY],
    chatId,
  );
  const lastProcessedAssistantFloor = Number(
    historyState.lastProcessedAssistantFloor,
  );

  historyState.processedMessageHashes = {};
  historyState.processedMessageHashesNeedRefresh =
    Number.isFinite(lastProcessedAssistantFloor) &&
    lastProcessedAssistantFloor >= 0;
  historyState.historyDirtyFrom = null;
  historyState.lastMutationReason = "";
  historyState.lastMutationSource = "";
  historyState.lastRecoveryResult = null;
  meta[RUNTIME_HISTORY_META_KEY] = historyState;

  return {
    meta,
    nodes: toSerializableData(normalizedSnapshot.nodes, []),
    edges: toSerializableData(normalizedSnapshot.edges, []),
    tombstones: toSerializableData(normalizedSnapshot.tombstones, []),
    state: toSerializableData(normalizedSnapshot.state, {
      lastProcessedFloor: -1,
      extractionCount: 0,
    }),
  };
}

function mergeRuntimeHistoryMeta(localMeta = {}, remoteMeta = {}, options = {}) {
  const localHistory = normalizeRuntimeHistoryMeta(localMeta, options.chatId);
  const remoteHistory = normalizeRuntimeHistoryMeta(remoteMeta, options.chatId);

  const fallbackLastProcessedFloor = Number.isFinite(Number(options.fallbackLastProcessedFloor))
    ? Math.floor(Number(options.fallbackLastProcessedFloor))
    : -1;
  const fallbackExtractionCount = normalizeNonNegativeInteger(options.fallbackExtractionCount, 0);

  const baseLastProcessedFloor = Math.max(
    localHistory.lastProcessedAssistantFloor,
    remoteHistory.lastProcessedAssistantFloor,
    fallbackLastProcessedFloor,
  );

  const mergedHashes = {};
  const conflictFloors = [];
  const floorSet = new Set([
    ...Object.keys(localHistory.processedMessageHashes),
    ...Object.keys(remoteHistory.processedMessageHashes),
  ]);
  const sortedFloors = Array.from(floorSet)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  for (const floor of sortedFloors) {
    const floorKey = String(floor);
    const localHash = localHistory.processedMessageHashes[floorKey];
    const remoteHash = remoteHistory.processedMessageHashes[floorKey];
    if (localHash && remoteHash && localHash !== remoteHash) {
      conflictFloors.push(floor);
      continue;
    }
    if (localHash || remoteHash) {
      mergedHashes[floorKey] = localHash || remoteHash;
    }
  }

  let safeLastProcessedFloor = baseLastProcessedFloor;
  const hasIntegrityConflict = conflictFloors.length > 0;
  if (hasIntegrityConflict) {
    const highestConflictFreeFloor = sortedFloors.length
      ? sortedFloors[sortedFloors.length - 1]
      : -1;
    const firstConflictFloor = Math.min(...conflictFloors);
    safeLastProcessedFloor = Math.min(
      baseLastProcessedFloor,
      highestConflictFreeFloor,
      firstConflictFloor - 1,
    );
  }
  safeLastProcessedFloor = Math.max(-1, safeLastProcessedFloor);

  const historyDirtyFrom = pickMinFinite(
    [
      localHistory.historyDirtyFrom,
      remoteHistory.historyDirtyFrom,
      hasIntegrityConflict ? Math.max(0, safeLastProcessedFloor + 1) : null,
    ],
    null,
  );

  const firstConflictFloor = hasIntegrityConflict ? Math.min(...conflictFloors) : null;
  const mergedHistory = {
    ...localHistory,
    ...remoteHistory,
    chatId: normalizeChatId(remoteHistory.chatId || localHistory.chatId || options.chatId),
    lastProcessedAssistantFloor: safeLastProcessedFloor,
    processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
    extractionCount: Math.max(
      localHistory.extractionCount,
      remoteHistory.extractionCount,
      fallbackExtractionCount,
    ),
    processedMessageHashes: sortProcessedMessageHashes(mergedHashes),
    processedMessageHashesNeedRefresh:
      localHistory.processedMessageHashesNeedRefresh === true ||
      remoteHistory.processedMessageHashesNeedRefresh === true,
    historyDirtyFrom,
    lastMutationReason: hasIntegrityConflict
      ? `sync-merge:processed-hash-conflict@${firstConflictFloor}`
      : String(remoteHistory.lastMutationReason || localHistory.lastMutationReason || ""),
    lastMutationSource: hasIntegrityConflict
      ? "sync-merge"
      : String(remoteHistory.lastMutationSource || localHistory.lastMutationSource || ""),
    lastRecoveryResult: chooseNewerRuntimePayload(
      localHistory.lastRecoveryResult,
      remoteHistory.lastRecoveryResult,
    ),
    lastBatchStatus: chooseNewerRuntimePayload(
      localHistory.lastBatchStatus,
      remoteHistory.lastBatchStatus,
    ),
  };

  return {
    history: mergedHistory,
    hasIntegrityConflict,
    safeLastProcessedFloor,
    conflictFloors,
  };
}

function normalizeRuntimeVectorMeta(value = {}) {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? toSerializableData(value, {})
      : {};

  const localStats =
    input.lastStats && typeof input.lastStats === "object" && !Array.isArray(input.lastStats)
      ? input.lastStats
      : {};

  return {
    ...input,
    mode: typeof input.mode === "string" ? input.mode : "",
    collectionId: typeof input.collectionId === "string" ? input.collectionId : "",
    source: typeof input.source === "string" ? input.source : "",
    modelScope: typeof input.modelScope === "string" ? input.modelScope : "",
    hashToNodeId: normalizeStringMap(input.hashToNodeId),
    nodeToHash: normalizeStringMap(input.nodeToHash),
    dirty: Boolean(input.dirty),
    replayRequiredNodeIds: normalizeStringArray(input.replayRequiredNodeIds),
    dirtyReason: typeof input.dirtyReason === "string" ? input.dirtyReason : "",
    pendingRepairFromFloor: normalizeOptionalFloor(input.pendingRepairFromFloor),
    lastSyncAt: normalizeTimestamp(input.lastSyncAt, 0),
    lastStats: {
      total: normalizeNonNegativeInteger(localStats.total, 0),
      indexed: normalizeNonNegativeInteger(localStats.indexed, 0),
      stale: normalizeNonNegativeInteger(localStats.stale, 0),
      pending: normalizeNonNegativeInteger(localStats.pending, 0),
    },
    lastWarning: typeof input.lastWarning === "string" ? input.lastWarning : "",
  };
}

function mergeRuntimeVectorMeta(localMeta = {}, remoteMeta = {}, options = {}) {
  const localVector = normalizeRuntimeVectorMeta(localMeta);
  const remoteVector = normalizeRuntimeVectorMeta(remoteMeta);

  const aliveNodeIds = new Set(
    (Array.isArray(options.mergedNodes) ? options.mergedNodes : [])
      .map((node) => String(node?.id || "").trim())
      .filter(Boolean),
  );

  const conflictNodeIds = new Set();
  const candidateHashByNode = new Map();
  const registerCandidate = (nodeId, hash) => {
    const normalizedNodeId = String(nodeId || "").trim();
    const normalizedHash = String(hash || "").trim();
    if (!normalizedNodeId || !normalizedHash || !aliveNodeIds.has(normalizedNodeId)) return;
    if (conflictNodeIds.has(normalizedNodeId)) return;
    const existingHash = candidateHashByNode.get(normalizedNodeId);
    if (!existingHash) {
      candidateHashByNode.set(normalizedNodeId, normalizedHash);
      return;
    }
    if (existingHash !== normalizedHash) {
      conflictNodeIds.add(normalizedNodeId);
      candidateHashByNode.delete(normalizedNodeId);
    }
  };

  for (const [nodeId, hash] of Object.entries(localVector.nodeToHash)) {
    registerCandidate(nodeId, hash);
  }
  for (const [nodeId, hash] of Object.entries(remoteVector.nodeToHash)) {
    registerCandidate(nodeId, hash);
  }
  for (const [hash, nodeId] of Object.entries(localVector.hashToNodeId)) {
    registerCandidate(nodeId, hash);
  }
  for (const [hash, nodeId] of Object.entries(remoteVector.hashToNodeId)) {
    registerCandidate(nodeId, hash);
  }

  for (const nodeId of conflictNodeIds) {
    candidateHashByNode.delete(nodeId);
  }

  const hashBuckets = new Map();
  for (const [nodeId, hash] of candidateHashByNode.entries()) {
    const bucket = hashBuckets.get(hash) || new Set();
    bucket.add(nodeId);
    hashBuckets.set(hash, bucket);
  }

  const mergedNodeToHash = {};
  const mergedHashToNodeId = {};
  for (const [hash, bucket] of hashBuckets.entries()) {
    const nodeIds = Array.from(bucket).filter((nodeId) => aliveNodeIds.has(nodeId));
    if (nodeIds.length !== 1) {
      for (const nodeId of nodeIds) {
        conflictNodeIds.add(nodeId);
      }
      continue;
    }
    const nodeId = nodeIds[0];
    mergedNodeToHash[nodeId] = hash;
    mergedHashToNodeId[hash] = nodeId;
  }

  const replayRequiredNodeIds = normalizeStringArray([
    ...localVector.replayRequiredNodeIds,
    ...remoteVector.replayRequiredNodeIds,
    ...Array.from(conflictNodeIds),
  ]).filter((nodeId) => aliveNodeIds.has(nodeId));

  const hasMappingConflict = conflictNodeIds.size > 0;
  const inheritedDirty = Boolean(localVector.dirty || remoteVector.dirty);
  const dirty = inheritedDirty || hasMappingConflict || replayRequiredNodeIds.length > 0;
  const fallbackRepairFloor = Number.isFinite(Number(options.fallbackLastProcessedFloor))
    ? Math.max(0, Math.floor(Number(options.fallbackLastProcessedFloor)))
    : 0;

  const pendingRepairFromFloor = dirty
    ? pickMinFinite(
        [
          localVector.pendingRepairFromFloor,
          remoteVector.pendingRepairFromFloor,
          hasMappingConflict ? fallbackRepairFloor : null,
        ],
        null,
      )
    : null;

  const mappingCount = Object.keys(mergedNodeToHash).length;
  const total = Math.max(mappingCount, localVector.lastStats.total, remoteVector.lastStats.total);
  const indexed = mappingCount;
  const stale = Math.max(0, total - indexed);
  const pending = dirty
    ? Math.max(
        replayRequiredNodeIds.length,
        localVector.lastStats.pending,
        remoteVector.lastStats.pending,
        hasMappingConflict ? 1 : 0,
      )
    : 0;

  return {
    ...localVector,
    ...remoteVector,
    mode: String(remoteVector.mode || localVector.mode || "").trim(),
    source: String(remoteVector.source || localVector.source || "").trim(),
    modelScope: String(remoteVector.modelScope || localVector.modelScope || "").trim(),
    collectionId: String(remoteVector.collectionId || localVector.collectionId || "").trim(),
    hashToNodeId: mergedHashToNodeId,
    nodeToHash: mergedNodeToHash,
    replayRequiredNodeIds,
    dirty,
    dirtyReason: hasMappingConflict
      ? "sync-merge-vector-conflict"
      : dirty
        ? String(
            remoteVector.dirtyReason ||
              localVector.dirtyReason ||
              "sync-merge-vector-replay-required",
          )
        : "",
    pendingRepairFromFloor,
    lastSyncAt: Math.max(localVector.lastSyncAt, remoteVector.lastSyncAt),
    lastStats: {
      total,
      indexed,
      stale,
      pending,
    },
    lastWarning: hasMappingConflict
      ? "同步合并检测到向量映射冲突，已标记待重建"
      : String(remoteVector.lastWarning || localVector.lastWarning || ""),
  };
}

function normalizeJournalEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const normalizedId = String(entry.id || "").trim();
  if (!normalizedId) return null;

  const range = Array.isArray(entry.processedRange) ? entry.processedRange : [];
  const rangeStart = Number(range[0]);
  const rangeEnd = Number(range[1]);
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart > rangeEnd) {
    return null;
  }

  return {
    ...toSerializableData(entry, entry),
    id: normalizedId,
    createdAt: normalizeTimestamp(entry.createdAt ?? entry.at, 0),
    processedRange: [Math.floor(rangeStart), Math.floor(rangeEnd)],
  };
}

function chooseJournalEntryWinner(localEntry, remoteEntry) {
  if (!localEntry) return remoteEntry || null;
  if (!remoteEntry) return localEntry || null;

  if (remoteEntry.createdAt > localEntry.createdAt) return remoteEntry;
  if (localEntry.createdAt > remoteEntry.createdAt) return localEntry;

  const localEnd = Number(localEntry.processedRange?.[1] ?? -1);
  const remoteEnd = Number(remoteEntry.processedRange?.[1] ?? -1);
  if (remoteEnd > localEnd) return remoteEntry;
  if (localEnd > remoteEnd) return localEntry;
  return remoteEntry;
}

function mergeRuntimeBatchJournal(localJournal = [], remoteJournal = [], options = {}) {
  const journalById = new Map();
  const register = (entry) => {
    const normalizedEntry = normalizeJournalEntry(entry);
    if (!normalizedEntry) return;
    const existing = journalById.get(normalizedEntry.id);
    const winner = chooseJournalEntryWinner(existing, normalizedEntry);
    if (winner) journalById.set(normalizedEntry.id, winner);
  };

  for (const entry of Array.isArray(localJournal) ? localJournal : []) {
    register(entry);
  }
  for (const entry of Array.isArray(remoteJournal) ? remoteJournal : []) {
    register(entry);
  }

  let merged = Array.from(journalById.values());
  const maxTrustedFloor = Number.isFinite(Number(options.maxTrustedFloor))
    ? Math.floor(Number(options.maxTrustedFloor))
    : null;
  if (Number.isFinite(maxTrustedFloor)) {
    merged = merged.filter((entry) => Number(entry.processedRange?.[1]) <= maxTrustedFloor);
  }

  merged.sort((left, right) => {
    const leftStart = Number(left.processedRange?.[0] ?? -1);
    const rightStart = Number(right.processedRange?.[0] ?? -1);
    const leftEnd = Number(left.processedRange?.[1] ?? -1);
    const rightEnd = Number(right.processedRange?.[1] ?? -1);
    return (
      leftStart - rightStart ||
      leftEnd - rightEnd ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id)
    );
  });

  if (merged.length > RUNTIME_BATCH_JOURNAL_LIMIT) {
    merged = merged.slice(-RUNTIME_BATCH_JOURNAL_LIMIT);
  }

  return merged.map((entry) => toSerializableData(entry, entry));
}

function mergeRuntimeLastRecallResult(localSnapshot, remoteSnapshot) {
  const localRecall = toSerializableData(localSnapshot?.meta?.[RUNTIME_LAST_RECALL_META_KEY], null);
  const remoteRecall = toSerializableData(remoteSnapshot?.meta?.[RUNTIME_LAST_RECALL_META_KEY], null);
  const mergedByPayload = chooseNewerRuntimePayload(localRecall, remoteRecall);
  if (mergedByPayload != null) {
    return mergedByPayload;
  }

  const localModified = normalizeTimestamp(localSnapshot?.meta?.lastModified, 0);
  const remoteModified = normalizeTimestamp(remoteSnapshot?.meta?.lastModified, 0);
  if (remoteModified > localModified) return remoteRecall;
  if (localModified > remoteModified) return localRecall;
  return null;
}

async function getDb(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error("chatId 不能为空");
  }

  if (typeof options.getDb !== "function") {
    throw new Error("同步运行时缺少 getDb(chatId) 能力");
  }

  const db = await options.getDb(normalizedChatId);
  if (!db || typeof db.exportSnapshot !== "function") {
    throw new Error("getDb(chatId) 必须返回有效的 BmeDatabase 实例");
  }

  return db;
}

async function readDbMeta(db, key, fallbackValue = null) {
  if (!db || typeof key !== "string" || !key) return fallbackValue;
  if (typeof db.getMeta === "function") {
    return db.getMeta(key, fallbackValue);
  }
  if (db.meta instanceof Map) {
    return db.meta.has(key) ? db.meta.get(key) : fallbackValue;
  }
  if (db.meta && typeof db.meta === "object" && !Array.isArray(db.meta)) {
    return Object.prototype.hasOwnProperty.call(db.meta, key)
      ? db.meta[key]
      : fallbackValue;
  }
  return fallbackValue;
}

async function patchDbMeta(db, patch = {}) {
  if (!db || !patch || typeof patch !== "object") return;
  if (typeof db.patchMeta === "function") {
    await db.patchMeta(patch);
    return;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (typeof db.setMeta === "function") {
      await db.setMeta(key, value);
    }
  }
}

async function invokeSyncAppliedHook(options = {}, payload = {}) {
  if (typeof options.onSyncApplied !== "function") {
    return;
  }

  try {
    await options.onSyncApplied({
      ...(payload || {}),
    });
  } catch (error) {
    console.warn("[ST-BME] 同步后运行时刷新回调失败:", {
      chatId: String(payload?.chatId || ""),
      action: String(payload?.action || ""),
      error,
    });
  }
}

async function sanitizeFilename(fileName, options = {}) {
  const finalFallback = normalizeRemoteFilenameCandidate(
    fileName,
    "ST-BME_sync_unknown.json",
  );

  if (options.disableRemoteSanitize) {
    return finalFallback;
  }

  try {
    const sanitized = await requestSanitizedFilename(fileName, options);
    return normalizeRemoteFilenameCandidate(sanitized, finalFallback);
  } catch {
    return finalFallback;
  }
}

async function requestSanitizedFilename(fileName, options = {}) {
  if (options.disableRemoteSanitize) {
    return String(fileName || "");
  }

  const fetchImpl = getFetch(options);
  const response = await fetchImpl("/api/files/sanitize-filename", {
    method: "POST",
    headers: {
      ...getRequestHeadersSafe(options),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fileName }),
  });

  if (!response.ok) {
    return "";
  }

  const payload = await response.json().catch(() => null);
  return String(payload?.fileName || "").trim();
}

async function resolveLegacySyncFilename(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const rawFileName = buildLegacyRawSyncFilename(normalizedChatId);
  const legacyFallback = normalizeLegacyRemoteFilenameCandidate(
    rawFileName,
    "ST-BME_sync_unknown.json",
  );

  if (options.disableRemoteSanitize) {
    return legacyFallback;
  }

  try {
    const sanitized = await requestSanitizedFilename(rawFileName, options);
    return normalizeLegacyRemoteFilenameCandidate(sanitized, legacyFallback);
  } catch {
    return legacyFallback;
  }
}

async function resolveSyncFilename(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error("chatId 不能为空");
  }

  if (sanitizedFilenameByChatId.has(normalizedChatId)) {
    return sanitizedFilenameByChatId.get(normalizedChatId);
  }

  const rawFileName = buildSyncFilename(normalizedChatId);
  const sanitized = await sanitizeFilename(rawFileName, options);
  const finalName = normalizeRemoteFilenameCandidate(sanitized, rawFileName);
  rememberResolvedSyncFilename(normalizedChatId, finalName);
  return finalName;
}

async function resolveSyncFilenameCandidates(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error("chatId 不能为空");
  }

  const candidates = [];
  const pushCandidate = (value) => {
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue || candidates.includes(normalizedValue)) return;
    candidates.push(normalizedValue);
  };

  if (sanitizedFilenameByChatId.has(normalizedChatId)) {
    pushCandidate(sanitizedFilenameByChatId.get(normalizedChatId));
  }

  const primaryRawFileName = buildSyncFilename(normalizedChatId);
  const primarySanitized = await sanitizeFilename(primaryRawFileName, options);
  pushCandidate(
    normalizeRemoteFilenameCandidate(primarySanitized, primaryRawFileName),
  );

  const legacyRawFileName = buildLegacyRawSyncFilename(normalizedChatId);
  if (legacyRawFileName !== primaryRawFileName) {
    pushCandidate(await resolveLegacySyncFilename(normalizedChatId, options));
  }

  return candidates;
}

async function readRemoteSnapshot(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      exists: false,
      status: "missing-chat-id",
      filename: "",
      snapshot: null,
    };
  }

  const fetchImpl = getFetch(options);
  const candidateFilenames = await resolveSyncFilenameCandidates(
    normalizedChatId,
    options,
  );
  let lastNotFoundFilename = candidateFilenames[0] || "";

  for (const filename of candidateFilenames) {
    const cacheBust = `t=${Date.now()}`;
    const url = `/user/files/${encodeURIComponent(filename)}?${cacheBust}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
      });
    } catch (error) {
      console.warn("[ST-BME] 读取远端同步文件失败:", error);
      return {
        exists: false,
        status: "network-error",
        filename,
        snapshot: null,
        error,
      };
    }

    if (response.status === 404) {
      lastNotFoundFilename = filename;
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      const error = new Error(errorText || `HTTP ${response.status}`);
      console.warn("[ST-BME] 读取远端同步文件失败:", error);
      return {
        exists: false,
        status: "http-error",
        filename,
        snapshot: null,
        error,
        statusCode: response.status,
      };
    }

    try {
      const remotePayload = await response.json();
      const snapshot = normalizeSyncSnapshot(remotePayload, normalizedChatId);
      rememberResolvedSyncFilename(normalizedChatId, filename);
      return {
        exists: true,
        status: "ok",
        filename,
        snapshot,
      };
    } catch (error) {
      console.warn("[ST-BME] 解析远端同步文件失败:", error);
      return {
        exists: false,
        status: "invalid-json",
        filename,
        snapshot: null,
        error,
      };
    }
  }

  return {
    exists: false,
    status: "not-found",
    filename: lastNotFoundFilename,
    snapshot: null,
  };
}

async function writeSnapshotToRemote(snapshot, chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedSnapshot = normalizeSyncSnapshot(snapshot, normalizedChatId);
  const filename = await resolveSyncFilename(normalizedChatId, options);
  const fetchImpl = getFetch(options);

  const payload = {
    meta: toSerializableData(normalizedSnapshot.meta, {}),
    nodes: toSerializableData(normalizedSnapshot.nodes, []),
    edges: toSerializableData(normalizedSnapshot.edges, []),
    tombstones: toSerializableData(normalizedSnapshot.tombstones, []),
    state: toSerializableData(normalizedSnapshot.state, {
      lastProcessedFloor: -1,
      extractionCount: 0,
    }),
  };

  const response = await fetchImpl("/api/files/upload", {
    method: "POST",
    headers: {
      ...getRequestHeadersSafe(options),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: filename,
      data: encodeBase64Utf8(JSON.stringify(payload, null, 2)),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  const uploadResult = await response.json().catch(() => ({}));
  return {
    filename,
    path: String(uploadResult?.path || ""),
    payload,
  };
}

function withChatSyncLock(chatId, task) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return Promise.resolve({
      synced: false,
      reason: "missing-chat-id",
      chatId: "",
    });
  }

  if (syncInFlightByChatId.has(normalizedChatId)) {
    return syncInFlightByChatId.get(normalizedChatId);
  }

  const taskPromise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.warn("[ST-BME] 同步任务失败:", error);
      return {
        synced: false,
        chatId: normalizedChatId,
        reason: "sync-error",
        error,
      };
    })
    .finally(() => {
      if (syncInFlightByChatId.get(normalizedChatId) === taskPromise) {
        syncInFlightByChatId.delete(normalizedChatId);
      }
    });

  syncInFlightByChatId.set(normalizedChatId, taskPromise);
  return taskPromise;
}

export function getOrCreateDeviceId() {
  const storage = getStorage();
  const existingDeviceId = String(storage?.getItem(BME_SYNC_DEVICE_ID_KEY) || "").trim();
  if (existingDeviceId) return existingDeviceId;

  const deviceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : createFallbackDeviceId();

  try {
    storage?.setItem(BME_SYNC_DEVICE_ID_KEY, deviceId);
  } catch (error) {
    console.warn("[ST-BME] 写入 deviceId 到 localStorage 失败:", error);
  }

  return deviceId;
}

export async function getRemoteStatus(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      chatId: "",
      exists: false,
      revision: 0,
      lastModified: 0,
      deviceId: "",
      filename: "",
      status: "missing-chat-id",
    };
  }

  const remoteResult = await readRemoteSnapshot(normalizedChatId, options);
  if (!remoteResult.exists || !remoteResult.snapshot) {
    if (remoteResult.status !== "not-found" && remoteResult.status !== "missing-chat-id") {
      console.warn("[ST-BME] 远端同步状态读取异常，已回退为可恢复状态:", {
        chatId: normalizedChatId,
        status: remoteResult.status,
      });
    }
    return {
      chatId: normalizedChatId,
      exists: false,
      revision: 0,
      lastModified: 0,
      deviceId: "",
      filename: remoteResult.filename || "",
      status: remoteResult.status,
      error: remoteResult.error || null,
    };
  }

  return {
    chatId: normalizedChatId,
    exists: true,
    revision: normalizeRevision(remoteResult.snapshot.meta?.revision),
    lastModified: normalizeTimestamp(remoteResult.snapshot.meta?.lastModified, 0),
    deviceId: String(remoteResult.snapshot.meta?.deviceId || "").trim(),
    filename: remoteResult.filename,
    status: "ok",
  };
}

export async function listServerBackups(options = {}) {
  const entries = await fetchBackupManifest(options);
  return {
    entries,
    filename: BME_BACKUP_MANIFEST_FILENAME,
  };
}

export async function backupToServer(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      backedUp: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const db = await getDb(normalizedChatId, options);
    const snapshot = normalizeSyncSnapshot(
      await db.exportSnapshot(),
      normalizedChatId,
    );
    const nowMs = Date.now();
    const deviceId = getOrCreateDeviceId();

    snapshot.meta.chatId = normalizedChatId;
    snapshot.meta.deviceId = snapshot.meta.deviceId || deviceId;
    snapshot.meta.lastModified = normalizeTimestamp(
      snapshot.meta.lastModified,
      nowMs,
    );

    const backupSnapshot = buildManualBackupSnapshot(snapshot, normalizedChatId);
    const envelope = {
      kind: "st-bme-backup",
      version: BME_BACKUP_SCHEMA_VERSION,
      chatId: normalizedChatId,
      createdAt: nowMs,
      sourceDeviceId: deviceId,
      snapshot: backupSnapshot,
    };

    const uploadResult = await writeBackupEnvelope(
      envelope,
      normalizedChatId,
      options,
    );
    const serializedEnvelope = JSON.stringify(envelope);

    try {
      await upsertBackupManifestEntry(
        {
          filename: uploadResult.filename,
          serverPath: String(uploadResult.path || "").replace(/^\/+/, ""),
          chatId: normalizedChatId,
          revision: normalizeRevision(snapshot.meta.revision),
          lastModified: normalizeTimestamp(snapshot.meta.lastModified, nowMs),
          backupTime: nowMs,
          size: serializedEnvelope.length,
          schemaVersion: BME_BACKUP_SCHEMA_VERSION,
        },
        options,
      );
    } catch (manifestError) {
      return {
        backedUp: false,
        chatId: normalizedChatId,
        filename: uploadResult.filename,
        remotePath: uploadResult.path,
        reason: "backup-manifest-error",
        backupUploaded: true,
        error: manifestError,
      };
    }

    await patchDbMeta(db, {
      deviceId,
      syncDirty: false,
      syncDirtyReason: "",
      lastBackupUploadedAt: nowMs,
      lastBackupFilename: uploadResult.filename,
    });

    return {
      backedUp: true,
      chatId: normalizedChatId,
      filename: uploadResult.filename,
      remotePath: uploadResult.path,
      revision: normalizeRevision(snapshot.meta.revision),
      backupTime: nowMs,
    };
  } catch (error) {
    console.warn("[ST-BME] 手动备份到云端失败:", error);
    return {
      backedUp: false,
      chatId: normalizedChatId,
      reason: "backup-error",
      error,
    };
  }
}

export async function restoreFromServer(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      restored: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const db = await getDb(normalizedChatId, options);
    const remoteResult = await readBackupEnvelope(normalizedChatId, options);
    if (!remoteResult.exists || !remoteResult.envelope) {
      return {
        restored: false,
        chatId: normalizedChatId,
        filename: remoteResult.filename || "",
        reason: remoteResult.reason || "backup-missing",
      };
    }

    const envelope = remoteResult.envelope;
    if (envelope.version !== BME_BACKUP_SCHEMA_VERSION) {
      return {
        restored: false,
        chatId: normalizedChatId,
        filename: remoteResult.filename,
        reason: "backup-version-mismatch",
      };
    }

    if (envelope.chatId !== normalizedChatId) {
      return {
        restored: false,
        chatId: normalizedChatId,
        filename: remoteResult.filename,
        reason: "backup-chat-id-mismatch",
      };
    }

    const snapshot = markManualBackupHistoryForLocalRebind(
      envelope.snapshot,
      normalizedChatId,
    );
    if (normalizeChatId(snapshot.meta?.chatId) !== normalizedChatId) {
      return {
        restored: false,
        chatId: normalizedChatId,
        filename: remoteResult.filename,
        reason: "snapshot-chat-id-mismatch",
      };
    }

    const localSnapshot = normalizeSyncSnapshot(
      await db.exportSnapshot(),
      normalizedChatId,
    );
    await createRestoreSafetySnapshot(
      normalizedChatId,
      localSnapshot,
      options,
    );

    await db.importSnapshot(snapshot, {
      mode: "replace",
      preserveRevision: true,
      revision: normalizeRevision(snapshot.meta.revision),
      markSyncDirty: false,
    });

    await patchDbMeta(db, {
      deviceId: getOrCreateDeviceId(),
      syncDirty: false,
      syncDirtyReason: "",
      lastBackupRestoredAt: Date.now(),
      lastBackupFilename:
        remoteResult.filename || buildBackupFilename(normalizedChatId),
    });

    await invokeSyncAppliedHook(options, {
      chatId: normalizedChatId,
      action: "restore-backup",
      revision: normalizeRevision(snapshot.meta.revision),
    });

    return {
      restored: true,
      chatId: normalizedChatId,
      filename: remoteResult.filename,
      revision: normalizeRevision(snapshot.meta.revision),
      backupTime: normalizeTimestamp(envelope.createdAt, 0),
    };
  } catch (error) {
    console.warn("[ST-BME] 从云端恢复备份失败:", error);
    return {
      restored: false,
      chatId: normalizedChatId,
      reason: "restore-error",
      error,
    };
  }
}

export async function deleteServerBackup(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      deleted: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  const lookup = await resolveBackupLookupContext(normalizedChatId, options);
  const targetCandidate = lookup.candidates[0] || {
    filename: buildBackupFilename(normalizedChatId),
    serverPath: normalizeSelectedBackupServerPath(
      "",
      buildBackupFilename(normalizedChatId),
    ),
  };
  const filename = targetCandidate.filename;
  const serverPath =
    targetCandidate.serverPath ||
    normalizeSelectedBackupServerPath("", filename);
  const fetchImpl = getFetch(options);

  try {
    const response = await fetchImpl("/api/files/delete", {
      method: "POST",
      headers: {
        ...getRequestHeadersSafe(options),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: serverPath,
      }),
    });

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    try {
      const existingEntries =
        lookup.manifestError == null
          ? lookup.manifestEntries
          : await fetchBackupManifest(options);
      const filteredEntries = existingEntries.filter(
        (entry) => entry.filename !== filename,
      );
      await writeBackupManifest(filteredEntries, options);

      const remainingEntry =
        sortBackupManifestEntries(
          filteredEntries.filter(
            (entry) => normalizeChatId(entry.chatId) === normalizedChatId,
          ),
        )[0] || null;
      const localMetaUpdated = await syncDeletedBackupMeta(
        normalizedChatId,
        remainingEntry,
        options,
      );

      return {
        deleted: true,
        chatId: normalizedChatId,
        filename,
        localMetaUpdated,
      };
    } catch (manifestError) {
      return {
        deleted: false,
        chatId: normalizedChatId,
        filename,
        reason: "delete-backup-manifest-error",
        backupDeleted: true,
        error: manifestError,
      };
    }
  } catch (error) {
    console.warn("[ST-BME] 删除服务端备份失败:", error);
    return {
      deleted: false,
      chatId: normalizedChatId,
      filename,
      reason: "delete-backup-error",
      error,
    };
  }
}

export async function upload(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      uploaded: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const db = await getDb(normalizedChatId, options);
    const localSnapshot = normalizeSyncSnapshot(await db.exportSnapshot(), normalizedChatId);
    const nowMs = Date.now();

    const deviceId = getOrCreateDeviceId();
    localSnapshot.meta.deviceId = localSnapshot.meta.deviceId || deviceId;
    localSnapshot.meta.chatId = normalizedChatId;
    localSnapshot.meta.lastModified = normalizeTimestamp(localSnapshot.meta.lastModified, nowMs);

    const uploadResult = await writeSnapshotToRemote(localSnapshot, normalizedChatId, options);

    await patchDbMeta(db, {
      deviceId,
      lastSyncUploadedAt: nowMs,
      lastSyncedRevision: normalizeRevision(localSnapshot.meta.revision),
      syncDirty: false,
      syncDirtyReason: "",
      lastModified: localSnapshot.meta.lastModified,
    });

    return {
      uploaded: true,
      chatId: normalizedChatId,
      filename: uploadResult.filename,
      remotePath: uploadResult.path,
      revision: normalizeRevision(localSnapshot.meta.revision),
    };
  } catch (error) {
    console.warn("[ST-BME] 上传同步文件失败:", error);
    return {
      uploaded: false,
      chatId: normalizedChatId,
      reason: "upload-error",
      error,
    };
  }
}

export async function download(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      downloaded: false,
      exists: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const db = await getDb(normalizedChatId, options);
    const remoteResult = await readRemoteSnapshot(normalizedChatId, options);

    if (!remoteResult.exists || !remoteResult.snapshot) {
      return {
        downloaded: false,
        exists: false,
        chatId: normalizedChatId,
        filename: remoteResult.filename || "",
        reason: remoteResult.status || "remote-missing",
      };
    }

    const remoteSnapshot = normalizeSyncSnapshot(remoteResult.snapshot, normalizedChatId);
    const remoteRevision = normalizeRevision(remoteSnapshot.meta.revision);

    await db.importSnapshot(remoteSnapshot, {
      mode: "replace",
      preserveRevision: true,
      revision: remoteRevision,
      markSyncDirty: false,
    });

    await patchDbMeta(db, {
      deviceId: getOrCreateDeviceId(),
      lastSyncDownloadedAt: Date.now(),
      lastSyncedRevision: remoteRevision,
      syncDirty: false,
      syncDirtyReason: "",
    });

    await invokeSyncAppliedHook(options, {
      chatId: normalizedChatId,
      action: "download",
      revision: remoteRevision,
    });

    return {
      downloaded: true,
      exists: true,
      chatId: normalizedChatId,
      filename: remoteResult.filename,
      revision: remoteRevision,
    };
  } catch (error) {
    console.warn("[ST-BME] 下载同步文件失败:", error);
    return {
      downloaded: false,
      exists: false,
      chatId: normalizedChatId,
      reason: "download-error",
      error,
    };
  }
}

export function mergeSnapshots(localSnapshot, remoteSnapshot, options = {}) {
  const normalizedChatId = normalizeChatId(options.chatId || localSnapshot?.meta?.chatId || remoteSnapshot?.meta?.chatId);
  const local = normalizeSyncSnapshot(localSnapshot, normalizedChatId);
  const remote = normalizeSyncSnapshot(remoteSnapshot, normalizedChatId);

  const mergedTombstoneIndex = buildTombstoneIndex([
    ...local.tombstones,
    ...remote.tombstones,
  ]);
  const mergedTombstones = Array.from(mergedTombstoneIndex.byId.values());

  const mergedNodes = filterRecordsByTombstones(
    mergeRecordCollectionById(local.nodes, remote.nodes),
    "node",
    mergedTombstoneIndex,
  );
  const mergedEdges = filterRecordsByTombstones(
    mergeRecordCollectionById(local.edges, remote.edges),
    "edge",
    mergedTombstoneIndex,
  );

  const localRevision = normalizeRevision(local.meta.revision);
  const remoteRevision = normalizeRevision(remote.meta.revision);
  const mergedRevision = Math.max(localRevision, remoteRevision) + 1;

  const baseMergedState = {
    lastProcessedFloor: Math.max(
      Number(local.state?.lastProcessedFloor ?? -1),
      Number(remote.state?.lastProcessedFloor ?? -1),
    ),
    extractionCount: Math.max(
      Number(local.state?.extractionCount ?? 0),
      Number(remote.state?.extractionCount ?? 0),
    ),
  };

  const mergedHistoryResult = mergeRuntimeHistoryMeta(
    local.meta?.[RUNTIME_HISTORY_META_KEY],
    remote.meta?.[RUNTIME_HISTORY_META_KEY],
    {
      chatId: normalizedChatId,
      fallbackLastProcessedFloor: baseMergedState.lastProcessedFloor,
      fallbackExtractionCount: baseMergedState.extractionCount,
    },
  );

  const mergedLastProcessedFloor = Math.min(
    Number(baseMergedState.lastProcessedFloor ?? -1),
    Number(mergedHistoryResult.safeLastProcessedFloor ?? -1),
  );

  const mergedState = {
    lastProcessedFloor: Number.isFinite(mergedLastProcessedFloor)
      ? Math.floor(mergedLastProcessedFloor)
      : -1,
    extractionCount: Math.max(
      Number(baseMergedState.extractionCount ?? 0),
      Number(mergedHistoryResult.history?.extractionCount ?? 0),
    ),
  };

  const mergedHistoryState = {
    ...mergedHistoryResult.history,
    chatId: normalizedChatId,
    lastProcessedAssistantFloor: mergedState.lastProcessedFloor,
    extractionCount: mergedState.extractionCount,
    processedMessageHashes: sortProcessedMessageHashes(
      Object.fromEntries(
        Object.entries(mergedHistoryResult.history?.processedMessageHashes || {}).filter(
          ([floorKey]) => {
            const floor = Number.parseInt(floorKey, 10);
            return Number.isFinite(floor) && floor >= 0 && floor <= mergedState.lastProcessedFloor;
          },
        ),
      ),
    ),
  };

  const mergedVectorState = mergeRuntimeVectorMeta(
    local.meta?.[RUNTIME_VECTOR_META_KEY],
    remote.meta?.[RUNTIME_VECTOR_META_KEY],
    {
      mergedNodes,
      fallbackLastProcessedFloor: mergedState.lastProcessedFloor,
    },
  );

  const mergedBatchJournal = mergeRuntimeBatchJournal(
    local.meta?.[RUNTIME_BATCH_JOURNAL_META_KEY],
    remote.meta?.[RUNTIME_BATCH_JOURNAL_META_KEY],
    {
      maxTrustedFloor: mergedState.lastProcessedFloor,
    },
  );

  const mergedLastRecallResult = mergeRuntimeLastRecallResult(local, remote);
  const mergedSummaryState =
    chooseNewerRuntimePayload(
      local.meta?.[RUNTIME_SUMMARY_STATE_META_KEY],
      remote.meta?.[RUNTIME_SUMMARY_STATE_META_KEY],
    ) ??
    toSerializableData(
      remote.meta?.[RUNTIME_SUMMARY_STATE_META_KEY] ??
        local.meta?.[RUNTIME_SUMMARY_STATE_META_KEY] ??
        {},
      {},
    );
  const mergedMaintenanceJournal =
    chooseNewerRuntimePayload(
      local.meta?.[RUNTIME_MAINTENANCE_JOURNAL_META_KEY],
      remote.meta?.[RUNTIME_MAINTENANCE_JOURNAL_META_KEY],
    ) ??
    toSerializableData(
      remote.meta?.[RUNTIME_MAINTENANCE_JOURNAL_META_KEY] ??
        local.meta?.[RUNTIME_MAINTENANCE_JOURNAL_META_KEY] ??
        [],
      [],
    );
  const mergedKnowledgeState =
    chooseNewerRuntimePayload(
      local.meta?.[RUNTIME_KNOWLEDGE_STATE_META_KEY],
      remote.meta?.[RUNTIME_KNOWLEDGE_STATE_META_KEY],
    ) ??
    toSerializableData(
      remote.meta?.[RUNTIME_KNOWLEDGE_STATE_META_KEY] ??
        local.meta?.[RUNTIME_KNOWLEDGE_STATE_META_KEY] ??
        {},
      {},
    );
  const mergedRegionState =
    chooseNewerRuntimePayload(
      local.meta?.[RUNTIME_REGION_STATE_META_KEY],
      remote.meta?.[RUNTIME_REGION_STATE_META_KEY],
    ) ??
    toSerializableData(
      remote.meta?.[RUNTIME_REGION_STATE_META_KEY] ??
        local.meta?.[RUNTIME_REGION_STATE_META_KEY] ??
        {},
      {},
    );
  const mergedTimelineState =
    chooseNewerRuntimePayload(
      local.meta?.[RUNTIME_TIMELINE_STATE_META_KEY],
      remote.meta?.[RUNTIME_TIMELINE_STATE_META_KEY],
    ) ??
    toSerializableData(
      remote.meta?.[RUNTIME_TIMELINE_STATE_META_KEY] ??
        local.meta?.[RUNTIME_TIMELINE_STATE_META_KEY] ??
        {},
      {},
    );

  const mergedLastProcessedSeq = Math.max(
    normalizeNonNegativeInteger(local.meta?.[RUNTIME_LAST_PROCESSED_SEQ_META_KEY], 0),
    normalizeNonNegativeInteger(remote.meta?.[RUNTIME_LAST_PROCESSED_SEQ_META_KEY], 0),
    normalizeNonNegativeInteger(mergedState.lastProcessedFloor, 0),
  );

  const mergedRuntimeGraphVersion = Math.max(
    normalizeNonNegativeInteger(local.meta?.[RUNTIME_GRAPH_VERSION_META_KEY], 0),
    normalizeNonNegativeInteger(remote.meta?.[RUNTIME_GRAPH_VERSION_META_KEY], 0),
    normalizeNonNegativeInteger(mergedRevision, 0),
  );

  const mergedMeta = {
    ...local.meta,
    ...remote.meta,
    [RUNTIME_HISTORY_META_KEY]: mergedHistoryState,
    [RUNTIME_VECTOR_META_KEY]: mergedVectorState,
    [RUNTIME_BATCH_JOURNAL_META_KEY]: mergedBatchJournal,
    [RUNTIME_LAST_RECALL_META_KEY]: mergedLastRecallResult,
    [RUNTIME_SUMMARY_STATE_META_KEY]: mergedSummaryState,
    [RUNTIME_MAINTENANCE_JOURNAL_META_KEY]: mergedMaintenanceJournal,
    [RUNTIME_KNOWLEDGE_STATE_META_KEY]: mergedKnowledgeState,
    [RUNTIME_REGION_STATE_META_KEY]: mergedRegionState,
    [RUNTIME_TIMELINE_STATE_META_KEY]: mergedTimelineState,
    [RUNTIME_LAST_PROCESSED_SEQ_META_KEY]: mergedLastProcessedSeq,
    [RUNTIME_GRAPH_VERSION_META_KEY]: mergedRuntimeGraphVersion,
    schemaVersion: Math.max(
      Number(local.meta?.schemaVersion || 1),
      Number(remote.meta?.schemaVersion || 1),
    ),
    chatId: normalizedChatId,
    deviceId: String(local.meta?.deviceId || remote.meta?.deviceId || getOrCreateDeviceId()).trim(),
    revision: mergedRevision,
    lastModified: Math.max(
      normalizeTimestamp(local.meta?.lastModified, 0),
      normalizeTimestamp(remote.meta?.lastModified, 0),
      Date.now(),
    ),
    nodeCount: mergedNodes.length,
    edgeCount: mergedEdges.length,
    tombstoneCount: mergedTombstones.length,
    syncDirty: false,
    syncDirtyReason: "",
    lastProcessedFloor: mergedState.lastProcessedFloor,
    extractionCount: mergedState.extractionCount,
  };

  return {
    meta: mergedMeta,
    nodes: mergedNodes,
    edges: mergedEdges,
    tombstones: mergedTombstones,
    state: mergedState,
  };
}

export async function syncNow(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      synced: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  if (!isAutomaticCloudMode(options)) {
    return {
      synced: false,
      chatId: normalizedChatId,
      action: "manual-probe",
      reason: "manual-cloud-mode",
      remoteStatus: null,
    };
  }

  return await withChatSyncLock(normalizedChatId, async () => {
    const db = await getDb(normalizedChatId, options);
    const localSnapshot = normalizeSyncSnapshot(await db.exportSnapshot(), normalizedChatId);
    const localRevision = normalizeRevision(localSnapshot.meta.revision);
    const localDirty = Boolean(await db.getMeta("syncDirty", false));

    const remoteResult = await readRemoteSnapshot(normalizedChatId, options);
    if (!remoteResult.exists || !remoteResult.snapshot) {
      if (remoteResult.status !== "not-found") {
        return {
          synced: false,
          chatId: normalizedChatId,
          reason: remoteResult.status || "remote-read-error",
          error: remoteResult.error || null,
        };
      }

      const uploadResult = await upload(normalizedChatId, options);
      return {
        synced: Boolean(uploadResult.uploaded),
        chatId: normalizedChatId,
        action: uploadResult.uploaded ? "upload" : "none",
        ...uploadResult,
      };
    }

    const remoteSnapshot = normalizeSyncSnapshot(remoteResult.snapshot, normalizedChatId);
    const remoteRevision = normalizeRevision(remoteSnapshot.meta.revision);

    if (remoteRevision > localRevision && !localDirty) {
      const downloadResult = await download(normalizedChatId, options);
      return {
        synced: Boolean(downloadResult.downloaded),
        chatId: normalizedChatId,
        action: downloadResult.downloaded ? "download" : "none",
        ...downloadResult,
      };
    }

    if (localRevision > remoteRevision && !options.forceMerge) {
      const uploadResult = await upload(normalizedChatId, options);
      return {
        synced: Boolean(uploadResult.uploaded),
        chatId: normalizedChatId,
        action: uploadResult.uploaded ? "upload" : "none",
        ...uploadResult,
      };
    }

    if (localRevision === remoteRevision && !localDirty && !options.forceMerge) {
      return {
        synced: true,
        chatId: normalizedChatId,
        action: "noop",
        revision: localRevision,
      };
    }

    const mergedSnapshot = mergeSnapshots(localSnapshot, remoteSnapshot, {
      chatId: normalizedChatId,
    });

    await db.importSnapshot(mergedSnapshot, {
      mode: "replace",
      preserveRevision: true,
      revision: mergedSnapshot.meta.revision,
      markSyncDirty: false,
    });

    await patchDbMeta(db, {
      deviceId: getOrCreateDeviceId(),
      lastSyncDownloadedAt: Date.now(),
      lastSyncedRevision: normalizeRevision(mergedSnapshot.meta.revision),
      syncDirty: false,
      syncDirtyReason: "",
      lastProcessedFloor: mergedSnapshot.state.lastProcessedFloor,
      extractionCount: mergedSnapshot.state.extractionCount,
    });

    const uploadResult = await writeSnapshotToRemote(mergedSnapshot, normalizedChatId, options);

    await patchDbMeta(db, {
      lastSyncUploadedAt: Date.now(),
      lastSyncedRevision: normalizeRevision(mergedSnapshot.meta.revision),
      syncDirty: false,
      syncDirtyReason: "",
    });

    await invokeSyncAppliedHook(options, {
      chatId: normalizedChatId,
      action: "merge",
      revision: normalizeRevision(mergedSnapshot.meta.revision),
    });

    return {
      synced: true,
      chatId: normalizedChatId,
      action: "merge",
      filename: uploadResult.filename,
      remotePath: uploadResult.path,
      revision: normalizeRevision(mergedSnapshot.meta.revision),
    };
  });
}

export function scheduleUpload(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      scheduled: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  if (!isAutomaticCloudMode(options)) {
    return {
      scheduled: false,
      chatId: normalizedChatId,
      reason: "manual-cloud-mode",
    };
  }

  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Math.max(0, Math.floor(Number(options.debounceMs)))
    : BME_SYNC_UPLOAD_DEBOUNCE_MS;

  const previousTimer = uploadDebounceTimerByChatId.get(normalizedChatId);
  if (previousTimer) {
    clearTimeout(previousTimer);
  }

  const timer = setTimeout(() => {
    uploadDebounceTimerByChatId.delete(normalizedChatId);
    withChatSyncLock(normalizedChatId, async () => await upload(normalizedChatId, options));
  }, debounceMs);

  uploadDebounceTimerByChatId.set(normalizedChatId, timer);

  return {
    scheduled: true,
    chatId: normalizedChatId,
    debounceMs,
  };
}

export function autoSyncOnChatChange(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return Promise.resolve({
      synced: false,
      chatId: "",
      reason: "missing-chat-id",
    });
  }

  if (!isAutomaticCloudMode(options)) {
    return Promise.resolve({
      synced: false,
      chatId: normalizedChatId,
      action: "manual-probe",
      reason: "manual-cloud-mode",
      remoteStatus: null,
    });
  }

  return syncNow(normalizedChatId, {
    ...options,
    trigger: options.trigger || "chat-change",
  });
}

export function autoSyncOnVisibility(options = {}) {
  if (visibilitySyncInstalled || typeof document?.addEventListener !== "function") {
    return {
      installed: visibilitySyncInstalled,
    };
  }

  visibilitySyncInstalled = true;
  lastVisibilityState = document.visibilityState || "visible";

  document.addEventListener("visibilitychange", () => {
    const currentVisibilityState = document.visibilityState || "visible";
    const becameVisible =
      lastVisibilityState === "hidden" && currentVisibilityState === "visible";

    lastVisibilityState = currentVisibilityState;

    if (!becameVisible) return;

    const chatIdResolver =
      typeof options.getCurrentChatId === "function"
        ? options.getCurrentChatId
        : () => "";

    const chatId = normalizeChatId(chatIdResolver());
    if (!chatId) return;
    if (!isAutomaticCloudMode(options)) return;

    autoSyncOnChatChange(chatId, {
      ...options,
      trigger: "visibility-visible",
    }).catch((error) => {
      console.warn("[ST-BME] visibility 自动同步失败:", error);
    });
  });

  return {
    installed: true,
  };
}

export async function deleteRemoteSyncFile(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      deleted: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const fetchImpl = getFetch(options);
    const filenames = await resolveSyncFilenameCandidates(
      normalizedChatId,
      options,
    );
    let lastNotFoundFilename = filenames[0] || "";

    for (const filename of filenames) {
      const response = await fetchImpl("/api/files/delete", {
        method: "POST",
        headers: {
          ...getRequestHeadersSafe(options),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: `/user/files/${filename}`,
        }),
      });

      if (response.status === 404) {
        lastNotFoundFilename = filename;
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(errorText || `HTTP ${response.status}`);
      }

      sanitizedFilenameByChatId.delete(normalizedChatId);
      return {
        deleted: true,
        chatId: normalizedChatId,
        filename,
      };
    }

    return {
      deleted: false,
      chatId: normalizedChatId,
      filename: lastNotFoundFilename,
      reason: "not-found",
    };
  } catch (error) {
    console.warn("[ST-BME] 删除远端同步文件失败:", error);
    return {
      deleted: false,
      chatId: normalizedChatId,
      reason: "delete-error",
      error,
    };
  }
}

export function __testOnlyDecodeBase64Utf8(base64Text) {
  return decodeBase64Utf8(base64Text);
}
