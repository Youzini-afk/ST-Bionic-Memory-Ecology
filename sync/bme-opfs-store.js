import { createEmptyGraph, deserializeGraph } from "../graph/graph.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";
import {
  BME_DB_SCHEMA_VERSION,
  BME_LEGACY_RETENTION_MS,
  BME_RUNTIME_BATCH_JOURNAL_META_KEY,
  BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY,
  BME_TOMBSTONE_RETENTION_MS,
  buildSnapshotFromGraph,
} from "./bme-db.js";

const META_DEFAULT_LAST_PROCESSED_FLOOR = -1;
const META_DEFAULT_EXTRACTION_COUNT = 0;
const OPFS_ROOT_DIRECTORY_NAME = "st-bme";
const OPFS_CHATS_DIRECTORY_NAME = "chats";
const OPFS_MANIFEST_FILENAME = "manifest.json";
const OPFS_MANIFEST_VERSION = 1;
const OPFS_STORE_KIND = "opfs";
const OPFS_FORMAT_VERSION_V2 = 2;
const OPFS_CORE_FILENAME_PREFIX = "core.snapshot";
const OPFS_AUX_FILENAME_PREFIX = "aux.snapshot";
const OPFS_V2_META_DIRECTORY = "meta";
const OPFS_V2_SHARDS_DIRECTORY = "shards";
const OPFS_V2_WAL_DIRECTORY = "wal";
const OPFS_V2_NODE_BUCKET_COUNT = 64;
const OPFS_V2_EDGE_BUCKET_COUNT = 128;
const OPFS_V2_TOMBSTONE_BUCKET_COUNT = 16;
const OPFS_V2_WAL_COMPACTION_THRESHOLD = 64;
const OPFS_V2_WAL_BYTES_THRESHOLD = 16 * 1024 * 1024;
const OPFS_MANIFEST_META_KEYS = new Set([
  "chatId",
  "revision",
  "lastProcessedFloor",
  "extractionCount",
  "lastModified",
  "lastSyncUploadedAt",
  "lastSyncDownloadedAt",
  "lastSyncedRevision",
  "lastBackupUploadedAt",
  "lastBackupRestoredAt",
  "lastBackupRollbackAt",
  "lastBackupFilename",
  "syncDirtyReason",
  "deviceId",
  "nodeCount",
  "edgeCount",
  "tombstoneCount",
  "schemaVersion",
  "syncDirty",
  "migrationCompletedAt",
  "migrationSource",
  "legacyRetentionUntil",
  "lastMutationReason",
  "storagePrimary",
  "storageMode",
  "integrity",
  "hostChatId",
  "migratedFromChatId",
  "identityMigrationSource",
  "restoreSafetySnapshotExists",
  "restoreSafetySnapshotCreatedAt",
  "restoreSafetySnapshotChatId",
]);
const OPFS_AUX_META_KEYS = new Set([
  BME_RUNTIME_BATCH_JOURNAL_META_KEY,
  BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY,
]);

export const BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB = "indexeddb";
export const BME_GRAPH_LOCAL_STORAGE_MODE_AUTO = "auto";
export const BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW = "opfs-shadow";
export const BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY = "opfs-primary";

const OPFS_ENABLED_MODES = new Set([
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
]);

function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function normalizeRevision(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value, fallbackValue = Date.now()) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed);
  }
  return Math.floor(Number(fallbackValue) || Date.now());
}

function normalizeSourceFloor(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.floor(parsed);
}

function deriveNodeSourceFloor(node = {}) {
  const directSourceFloor = normalizeSourceFloor(node?.sourceFloor);
  if (directSourceFloor != null) return directSourceFloor;

  const seqRange = Array.isArray(node?.seqRange) ? node.seqRange : [];
  const seqRangeEnd = normalizeSourceFloor(seqRange[1]);
  if (seqRangeEnd != null) return seqRangeEnd;

  const seq = normalizeSourceFloor(node?.seq);
  if (seq != null) return seq;

  return null;
}

function deriveEdgeSourceFloor(edge = {}, nodeSourceFloorById = new Map()) {
  const directSourceFloor = normalizeSourceFloor(edge?.sourceFloor);
  if (directSourceFloor != null) return directSourceFloor;

  const seqRange = Array.isArray(edge?.seqRange) ? edge.seqRange : [];
  const seqRangeEnd = normalizeSourceFloor(seqRange[1]);
  if (seqRangeEnd != null) return seqRangeEnd;

  const seq = normalizeSourceFloor(edge?.seq);
  if (seq != null) return seq;

  const fromFloor = normalizeSourceFloor(
    nodeSourceFloorById.get(normalizeRecordId(edge?.fromId)),
  );
  const toFloor = normalizeSourceFloor(
    nodeSourceFloorById.get(normalizeRecordId(edge?.toId)),
  );

  if (fromFloor != null && toFloor != null) return Math.max(fromFloor, toFloor);
  if (fromFloor != null) return fromFloor;
  if (toFloor != null) return toFloor;
  return null;
}

function toPlainData(value, fallbackValue = null) {
  if (value == null) {
    return fallbackValue;
  }

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
    return fallbackValue;
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeSnapshotRecordArray(records = []) {
  return toArray(records)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...(item || {}) }));
}

function sanitizeSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      meta: {},
      state: {},
      nodes: [],
      edges: [],
      tombstones: [],
    };
  }

  const meta =
    snapshot.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
      ? { ...snapshot.meta }
      : {};
  const state =
    snapshot.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)
      ? { ...snapshot.state }
      : {};

  return {
    meta,
    state,
    nodes: sanitizeSnapshotRecordArray(snapshot.nodes),
    edges: sanitizeSnapshotRecordArray(snapshot.edges),
    tombstones: sanitizeSnapshotRecordArray(snapshot.tombstones),
  };
}

function normalizeMode(mode = "replace") {
  return String(mode || "").toLowerCase() === "merge" ? "merge" : "replace";
}

function createDefaultMetaValues(chatId = "", nowMs = Date.now()) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedNow = normalizeTimestamp(nowMs);
  return {
    chatId: normalizedChatId,
    revision: 0,
    lastProcessedFloor: META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: META_DEFAULT_EXTRACTION_COUNT,
    lastModified: normalizedNow,
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastBackupUploadedAt: 0,
    lastBackupRestoredAt: 0,
    lastBackupRollbackAt: 0,
    lastBackupFilename: "",
    syncDirtyReason: "",
    deviceId: "",
    nodeCount: 0,
    edgeCount: 0,
    tombstoneCount: 0,
    schemaVersion: BME_DB_SCHEMA_VERSION,
    syncDirty: false,
    migrationCompletedAt: 0,
    migrationSource: "",
    legacyRetentionUntil: 0,
    storagePrimary: OPFS_STORE_KIND,
    storageMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  };
}

function normalizeGraphLocalStorageModeInternal(
  value,
  fallbackValue = BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === BME_GRAPH_LOCAL_STORAGE_MODE_AUTO) {
    return BME_GRAPH_LOCAL_STORAGE_MODE_AUTO;
  }
  if (normalized === BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB) {
    return BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB;
  }
  if (OPFS_ENABLED_MODES.has(normalized)) {
    return normalized;
  }
  return normalizeGraphLocalStorageModeInternalFallback(fallbackValue);
}

function normalizeGraphLocalStorageModeInternalFallback(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === BME_GRAPH_LOCAL_STORAGE_MODE_AUTO) {
    return BME_GRAPH_LOCAL_STORAGE_MODE_AUTO;
  }
  if (OPFS_ENABLED_MODES.has(normalized)) {
    return normalized;
  }
  return BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB;
}

export function normalizeGraphLocalStorageMode(
  value,
  fallbackValue = BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
) {
  return normalizeGraphLocalStorageModeInternal(value, fallbackValue);
}

export function isGraphLocalStorageModeOpfs(value) {
  return OPFS_ENABLED_MODES.has(normalizeGraphLocalStorageMode(value));
}

function buildChatDirectoryName(chatId = "") {
  return encodeURIComponent(normalizeChatId(chatId));
}

function buildSnapshotFilename(prefix, revision = 0, stampMs = Date.now()) {
  return `${String(prefix || "snapshot")}.${normalizeRevision(revision)}.${normalizeTimestamp(stampMs)}.json`;
}

function escapeRegex(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSnapshotFilenameCandidate(name = "", prefix = "") {
  const normalizedName = String(name || "").trim();
  const normalizedPrefix = String(prefix || "").trim();
  if (!normalizedName || !normalizedPrefix) {
    return null;
  }
  const matcher = new RegExp(
    `^${escapeRegex(normalizedPrefix)}\\.(\\d+)\\.(\\d+)\\.json$`,
  );
  const match = normalizedName.match(matcher);
  if (!match) {
    return null;
  }
  return {
    filename: normalizedName,
    revision: normalizeRevision(match[1]),
    stampMs: normalizeTimestamp(match[2], 0),
  };
}

function isNotFoundError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return name === "NotFoundError" || /not.?found/i.test(message);
}

async function ensureDirectoryHandle(parentHandle, name) {
  return await parentHandle.getDirectoryHandle(String(name || ""), {
    create: true,
  });
}

async function maybeGetFileHandle(parentHandle, name) {
  try {
    return await parentHandle.getFileHandle(String(name || ""), {
      create: false,
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readJsonFile(parentHandle, name, fallbackValue = null) {
  const fileHandle = await maybeGetFileHandle(parentHandle, name);
  if (!fileHandle) {
    return fallbackValue;
  }
  const file = await fileHandle.getFile();
  const text = typeof file?.text === "function" ? await file.text() : "";
  if (!text) {
    return fallbackValue;
  }
  return JSON.parse(text);
}

async function writeJsonFile(parentHandle, name, value) {
  const fileHandle = await parentHandle.getFileHandle(String(name || ""), {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
  return fileHandle;
}

async function deleteFileIfExists(parentHandle, name) {
  if (!name) return false;
  try {
    await parentHandle.removeEntry(String(name), {
      recursive: false,
    });
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function listDirectoryFileNames(parentHandle) {
  if (!parentHandle) return [];

  if (parentHandle.files instanceof Map) {
    return Array.from(parentHandle.files.keys()).map((name) => String(name || ""));
  }

  const names = [];
  if (typeof parentHandle.keys === "function") {
    for await (const key of parentHandle.keys()) {
      if (typeof key === "string" && key) {
        names.push(key);
      }
    }
    return names;
  }

  if (typeof parentHandle.entries === "function") {
    for await (const [name, handle] of parentHandle.entries()) {
      if (
        typeof name === "string" &&
        name &&
        (!handle || handle.kind === "file" || typeof handle.getFile === "function")
      ) {
        names.push(name);
      }
    }
  }
  return names;
}

function normalizeSnapshotState(snapshot = {}) {
  const meta =
    snapshot?.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
      ? snapshot.meta
      : {};
  return {
    lastProcessedFloor: Number.isFinite(Number(snapshot?.state?.lastProcessedFloor))
      ? Number(snapshot.state.lastProcessedFloor)
      : Number.isFinite(Number(meta?.lastProcessedFloor))
        ? Number(meta.lastProcessedFloor)
        : META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: Number.isFinite(Number(snapshot?.state?.extractionCount))
      ? Number(snapshot.state.extractionCount)
      : Number.isFinite(Number(meta?.extractionCount))
        ? Number(meta.extractionCount)
        : META_DEFAULT_EXTRACTION_COUNT,
  };
}

function splitSnapshotMeta(meta = {}) {
  const manifestMeta = {};
  const coreMeta = {};
  const auxMeta = {};

  for (const [rawKey, value] of Object.entries(meta || {})) {
    const key = normalizeRecordId(rawKey);
    if (!key) continue;
    const clonedValue = toPlainData(value, value);
    if (OPFS_AUX_META_KEYS.has(key)) {
      auxMeta[key] = clonedValue;
      continue;
    }
    if (
      OPFS_MANIFEST_META_KEYS.has(key) ||
      clonedValue == null ||
      typeof clonedValue !== "object"
    ) {
      manifestMeta[key] = clonedValue;
      continue;
    }
    coreMeta[key] = clonedValue;
  }

  return {
    manifestMeta,
    coreMeta,
    auxMeta,
  };
}

function buildSnapshotFromStoredParts(manifest, corePayload = {}, auxPayload = {}) {
  const baseMeta =
    manifest?.meta && typeof manifest.meta === "object" && !Array.isArray(manifest.meta)
      ? manifest.meta
      : {};
  const coreMeta =
    corePayload?.meta && typeof corePayload.meta === "object" && !Array.isArray(corePayload.meta)
      ? corePayload.meta
      : {};
  const auxMeta =
    auxPayload?.meta && typeof auxPayload.meta === "object" && !Array.isArray(auxPayload.meta)
      ? auxPayload.meta
      : {};
  const nodes = sanitizeSnapshotRecordArray(corePayload?.nodes);
  const edges = sanitizeSnapshotRecordArray(corePayload?.edges);
  const tombstones = sanitizeSnapshotRecordArray(auxPayload?.tombstones);
  const mergedMeta = {
    ...baseMeta,
    ...coreMeta,
    ...auxMeta,
  };
  const state = normalizeSnapshotState({
    meta: mergedMeta,
    state: {
      ...(corePayload?.state &&
      typeof corePayload.state === "object" &&
      !Array.isArray(corePayload.state)
        ? corePayload.state
        : {}),
      ...(Number.isFinite(Number(baseMeta?.lastProcessedFloor))
        ? { lastProcessedFloor: Number(baseMeta.lastProcessedFloor) }
        : {}),
      ...(Number.isFinite(Number(baseMeta?.extractionCount))
        ? { extractionCount: Number(baseMeta.extractionCount) }
        : {}),
    },
  });
  const meta = {
    ...createDefaultMetaValues(baseMeta.chatId || manifest?.chatId || ""),
    ...toPlainData(mergedMeta, {}),
    chatId: normalizeChatId(baseMeta.chatId || manifest?.chatId || ""),
    schemaVersion: BME_DB_SCHEMA_VERSION,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    tombstoneCount: tombstones.length,
  };
  meta.lastProcessedFloor = Number.isFinite(Number(state.lastProcessedFloor))
    ? Number(state.lastProcessedFloor)
    : META_DEFAULT_LAST_PROCESSED_FLOOR;
  meta.extractionCount = Number.isFinite(Number(state.extractionCount))
    ? Number(state.extractionCount)
    : META_DEFAULT_EXTRACTION_COUNT;
  meta.storagePrimary = OPFS_STORE_KIND;
  meta.storageMode = normalizeGraphLocalStorageMode(
    meta.storageMode,
    BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  );

  return {
    meta,
    state,
    nodes,
    edges,
    tombstones,
  };
}

function mergeSnapshotRecords(currentRecords = [], nextRecords = []) {
  const recordMap = new Map();
  for (const record of sanitizeSnapshotRecordArray(currentRecords)) {
    const id = normalizeRecordId(record?.id);
    if (!id) continue;
    recordMap.set(id, record);
  }
  for (const record of sanitizeSnapshotRecordArray(nextRecords)) {
    const id = normalizeRecordId(record?.id);
    if (!id) continue;
    recordMap.set(id, record);
  }
  return Array.from(recordMap.values());
}

function applyListOptions(records, options = {}) {
  let nextRecords = toArray(records);

  const orderBy = String(options.orderBy || "updatedAt").trim();
  const reverse = options.reverse !== false;

  nextRecords = nextRecords.sort((left, right) => {
    const leftValue = Number(left?.[orderBy]);
    const rightValue = Number(right?.[orderBy]);
    if (!Number.isFinite(leftValue) && !Number.isFinite(rightValue)) return 0;
    if (!Number.isFinite(leftValue)) return reverse ? 1 : -1;
    if (!Number.isFinite(rightValue)) return reverse ? -1 : 1;
    return reverse ? rightValue - leftValue : leftValue - rightValue;
  });

  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) {
    nextRecords = nextRecords.slice(0, Math.floor(limit));
  }

  return toPlainData(nextRecords, []);
}

async function getDefaultOpfsRootDirectory() {
  const storage = globalThis.navigator?.storage;
  if (!storage || typeof storage.getDirectory !== "function") {
    throw new Error("OPFS 不可用");
  }
  return await storage.getDirectory();
}

export async function detectOpfsSupport(options = {}) {
  const rootDirectoryFactory =
    typeof options.rootDirectoryFactory === "function"
      ? options.rootDirectoryFactory
      : getDefaultOpfsRootDirectory;
  try {
    const rootDirectory = await rootDirectoryFactory();
    if (!rootDirectory || typeof rootDirectory.getDirectoryHandle !== "function") {
      return {
        available: false,
        reason: "missing-directory-handle",
      };
    }
    await ensureDirectoryHandle(rootDirectory, OPFS_ROOT_DIRECTORY_NAME);
    return {
      available: true,
      reason: "ok",
    };
  } catch (error) {
    return {
      available: false,
      reason: error?.message || String(error),
      error,
    };
  }
}

class LegacyOpfsGraphStore {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.options = options;
    this.storeKind = OPFS_STORE_KIND;
    this.storeMode = normalizeGraphLocalStorageMode(
      options.storeMode,
      BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
    );
    this._rootDirectoryFactory =
      typeof options.rootDirectoryFactory === "function"
        ? options.rootDirectoryFactory
        : getDefaultOpfsRootDirectory;
    this._chatDirectoryPromise = null;
    this._manifestCache = null;
    this._writeChain = Promise.resolve();
    this._writeQueueDepth = 0;
    this._writeLockState = {
      active: false,
      queueDepth: 0,
      lastReason: "",
      updatedAt: 0,
    };
  }

  async open() {
    await this._ensureManifest();
    return this;
  }

  async close() {
    this._chatDirectoryPromise = null;
    this._manifestCache = null;
    this._writeChain = Promise.resolve();
    this._writeQueueDepth = 0;
    this._writeLockState = {
      active: false,
      queueDepth: 0,
      lastReason: "",
      updatedAt: 0,
    };
  }

  getWriteLockSnapshot() {
    return toPlainData(this._writeLockState, this._writeLockState);
  }

  async _awaitPendingWrites() {
    try {
      await this._writeChain;
    } catch {
      // swallow previous write failure for read barrier
    }
  }

  _setWriteLockState(patch = {}) {
    this._writeLockState = {
      ...this._writeLockState,
      ...(patch || {}),
      updatedAt: Date.now(),
    };
    return this._writeLockState;
  }

  async _runSerializedWrite(reason = "opfs-write", task = null) {
    if (typeof task !== "function") {
      throw new Error("OpfsGraphStore serialized write task is required");
    }
    this._writeQueueDepth += 1;
    this._setWriteLockState({
      active: true,
      queueDepth: this._writeQueueDepth,
      lastReason: String(reason || "opfs-write"),
    });
    const runTask = async () => {
      try {
        return await task();
      } finally {
        this._writeQueueDepth = Math.max(0, this._writeQueueDepth - 1);
        this._setWriteLockState({
          active: this._writeQueueDepth > 0,
          queueDepth: this._writeQueueDepth,
          lastReason: String(reason || "opfs-write"),
        });
      }
    };
    const nextWrite = this._writeChain.catch(() => null).then(runTask);
    this._writeChain = nextWrite.catch(() => null);
    return await nextWrite;
  }

  async getMeta(key, fallbackValue = null) {
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return fallbackValue;
    if (OPFS_MANIFEST_META_KEYS.has(normalizedKey)) {
      const manifest = await this._ensureManifest();
      const manifestMeta =
        manifest?.meta &&
        typeof manifest.meta === "object" &&
        !Array.isArray(manifest.meta)
          ? manifest.meta
          : {};
      return Object.prototype.hasOwnProperty.call(manifestMeta, normalizedKey)
        ? manifestMeta[normalizedKey]
        : fallbackValue;
    }
    const snapshot = await this._loadSnapshot();
    return Object.prototype.hasOwnProperty.call(snapshot.meta, normalizedKey)
      ? snapshot.meta[normalizedKey]
      : fallbackValue;
  }

  async setMeta(key, value) {
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return null;
    await this.patchMeta({
      [normalizedKey]: value,
    });
    return {
      key: normalizedKey,
      value: await this.getMeta(normalizedKey, null),
      updatedAt: Date.now(),
    };
  }

  async patchMeta(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {};
    }
    const entries = Object.entries(record)
      .map(([rawKey, value]) => [normalizeRecordId(rawKey), toPlainData(value, value)])
      .filter(([key]) => Boolean(key));
    if (!entries.length) {
      return {};
    }

    const allManifestOnly = entries.every(([key]) =>
      OPFS_MANIFEST_META_KEYS.has(key),
    );
    if (allManifestOnly) {
      return await this._runSerializedWrite("patchMeta:manifest", async () => {
        const manifest = await this._ensureManifest({ awaitWrites: false });
        const nextMeta = {
          ...createDefaultMetaValues(this.chatId),
          ...(manifest?.meta && typeof manifest.meta === "object" && !Array.isArray(manifest.meta)
            ? toPlainData(manifest.meta, {})
            : {}),
          chatId: this.chatId,
          storagePrimary: OPFS_STORE_KIND,
          storageMode: this.storeMode,
        };
        for (const [key, normalizedValue] of entries) {
          nextMeta[key] = normalizedValue;
        }
        const nextManifest = {
          ...(manifest || {}),
          version: OPFS_MANIFEST_VERSION,
          chatId: this.chatId,
          storeKind: OPFS_STORE_KIND,
          storeMode: this.storeMode,
          activeCoreFilename: String(manifest?.activeCoreFilename || ""),
          activeAuxFilename: String(manifest?.activeAuxFilename || ""),
          meta: nextMeta,
        };
        const chatDirectory = await this._getChatDirectory();
        await writeJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, nextManifest);
        this._manifestCache = nextManifest;
        return Object.fromEntries(entries);
      });
    }

    return await this._runSerializedWrite("patchMeta:snapshot", async () => {
      const snapshot = await this._loadSnapshot({ awaitWrites: false });
      const appliedEntries = [];
      for (const [key, normalizedValue] of entries) {
        snapshot.meta[key] = normalizedValue;
        if (key === "lastProcessedFloor") {
          snapshot.state.lastProcessedFloor = Number.isFinite(Number(normalizedValue))
            ? Number(normalizedValue)
            : META_DEFAULT_LAST_PROCESSED_FLOOR;
        }
        if (key === "extractionCount") {
          snapshot.state.extractionCount = Number.isFinite(Number(normalizedValue))
            ? Number(normalizedValue)
            : META_DEFAULT_EXTRACTION_COUNT;
        }
        appliedEntries.push([key, normalizedValue]);
      }
      await this._writeResolvedSnapshot(snapshot);
      return Object.fromEntries(appliedEntries);
    });
  }

  async getRevision() {
    return normalizeRevision(await this.getMeta("revision", 0));
  }

  async markSyncDirty(reason = "mutation") {
    await this.patchMeta({
      syncDirty: true,
      syncDirtyReason: String(reason || "mutation"),
    });
    return true;
  }

  async commitDelta(delta = {}, options = {}) {
    return await this._runSerializedWrite(
      String(options?.reason || "commitDelta"),
      async () => {
        const nowMs = Date.now();
        const normalizedDelta =
          delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
        const currentSnapshot = await this._loadSnapshot({ awaitWrites: false });
        const nodeMap = new Map();
        const edgeMap = new Map();
        const tombstoneMap = new Map();

    for (const node of sanitizeSnapshotRecordArray(currentSnapshot.nodes)) {
      const id = normalizeRecordId(node.id);
      if (!id) continue;
      nodeMap.set(id, node);
    }
    for (const edge of sanitizeSnapshotRecordArray(currentSnapshot.edges)) {
      const id = normalizeRecordId(edge.id);
      if (!id) continue;
      edgeMap.set(id, edge);
    }
    for (const tombstone of sanitizeSnapshotRecordArray(currentSnapshot.tombstones)) {
      const id = normalizeRecordId(tombstone.id);
      if (!id) continue;
      tombstoneMap.set(id, tombstone);
    }

    const deleteNodeIds = toArray(normalizedDelta.deleteNodeIds)
      .map((value) => normalizeRecordId(value))
      .filter(Boolean);
    const deleteEdgeIds = toArray(normalizedDelta.deleteEdgeIds)
      .map((value) => normalizeRecordId(value))
      .filter(Boolean);

    for (const id of deleteNodeIds) {
      nodeMap.delete(id);
    }
    for (const id of deleteEdgeIds) {
      edgeMap.delete(id);
    }

    const upsertNodes = sanitizeSnapshotRecordArray(normalizedDelta.upsertNodes).map(
      (node) => ({
        ...node,
        id: normalizeRecordId(node.id),
        updatedAt: normalizeTimestamp(node.updatedAt, nowMs),
      }),
    );
    for (const node of upsertNodes) {
      if (!node.id) continue;
      nodeMap.set(node.id, node);
    }

    const upsertEdges = sanitizeSnapshotRecordArray(normalizedDelta.upsertEdges).map(
      (edge) => ({
        ...edge,
        id: normalizeRecordId(edge.id),
        fromId: normalizeRecordId(edge.fromId),
        toId: normalizeRecordId(edge.toId),
        updatedAt: normalizeTimestamp(edge.updatedAt, nowMs),
      }),
    );
    for (const edge of upsertEdges) {
      if (!edge.id) continue;
      edgeMap.set(edge.id, edge);
    }

    const tombstones = sanitizeSnapshotRecordArray(normalizedDelta.tombstones).map(
      (tombstone) => ({
        ...tombstone,
        id: normalizeRecordId(tombstone.id),
        kind: normalizeRecordId(tombstone.kind),
        targetId: normalizeRecordId(tombstone.targetId),
        sourceDeviceId: normalizeRecordId(tombstone.sourceDeviceId),
        deletedAt: normalizeTimestamp(tombstone.deletedAt, nowMs),
      }),
    );
    for (const tombstone of tombstones) {
      if (!tombstone.id) continue;
      tombstoneMap.set(tombstone.id, tombstone);
    }

    const runtimeMetaPatch =
      normalizedDelta.runtimeMetaPatch &&
      typeof normalizedDelta.runtimeMetaPatch === "object" &&
      !Array.isArray(normalizedDelta.runtimeMetaPatch)
        ? toPlainData(normalizedDelta.runtimeMetaPatch, {})
        : {};
    const requestedRevision = normalizeRevision(options.requestedRevision);
    const shouldMarkSyncDirty = options.markSyncDirty !== false;
    const reason = String(options.reason || "commitDelta");
    const nextRevision = Math.max(
      normalizeRevision(currentSnapshot.meta?.revision) + 1,
      requestedRevision,
    );
    const nextMeta = {
      ...currentSnapshot.meta,
      ...runtimeMetaPatch,
      chatId: this.chatId,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      revision: nextRevision,
      lastModified: nowMs,
      lastMutationReason: reason,
      syncDirty: shouldMarkSyncDirty,
      syncDirtyReason: shouldMarkSyncDirty ? reason : "",
      storagePrimary: OPFS_STORE_KIND,
      storageMode: this.storeMode,
    };
    const nextState = {
      lastProcessedFloor: Number.isFinite(Number(runtimeMetaPatch.lastProcessedFloor))
        ? Number(runtimeMetaPatch.lastProcessedFloor)
        : currentSnapshot.state.lastProcessedFloor,
      extractionCount: Number.isFinite(Number(runtimeMetaPatch.extractionCount))
        ? Number(runtimeMetaPatch.extractionCount)
        : currentSnapshot.state.extractionCount,
    };
        const nextSnapshot = {
          meta: nextMeta,
          state: nextState,
          nodes: Array.from(nodeMap.values()),
          edges: Array.from(edgeMap.values()),
          tombstones: Array.from(tombstoneMap.values()),
        };
        await this._writeResolvedSnapshot(nextSnapshot);

        return {
          revision: nextRevision,
          lastModified: nowMs,
          imported: {
            nodes: nextSnapshot.nodes.length,
            edges: nextSnapshot.edges.length,
            tombstones: nextSnapshot.tombstones.length,
          },
          delta: {
            upsertNodes: upsertNodes.length,
            upsertEdges: upsertEdges.length,
            deleteNodeIds: deleteNodeIds.length,
            deleteEdgeIds: deleteEdgeIds.length,
            tombstones: tombstones.length,
          },
        };
      },
    );
  }

  async bulkUpsertNodes(nodes = []) {
    const records = sanitizeSnapshotRecordArray(nodes);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }
    const result = await this.commitDelta(
      {
        upsertNodes: records,
      },
      {
        reason: "bulkUpsertNodes",
      },
    );
    return {
      upserted: records.length,
      revision: result.revision,
    };
  }

  async bulkUpsertEdges(edges = []) {
    const records = sanitizeSnapshotRecordArray(edges);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }
    const result = await this.commitDelta(
      {
        upsertEdges: records,
      },
      {
        reason: "bulkUpsertEdges",
      },
    );
    return {
      upserted: records.length,
      revision: result.revision,
    };
  }

  async bulkUpsertTombstones(tombstones = []) {
    const records = sanitizeSnapshotRecordArray(tombstones);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }
    const result = await this.commitDelta(
      {
        tombstones: records,
      },
      {
        reason: "bulkUpsertTombstones",
      },
    );
    return {
      upserted: records.length,
      revision: result.revision,
    };
  }

  async listNodes(options = {}) {
    const snapshot = await this._loadSnapshot();
    let records = snapshot.nodes;
    const includeDeleted = options.includeDeleted !== false;
    const includeArchived = options.includeArchived !== false;
    if (!includeDeleted) {
      records = records.filter(
        (node) => !Number.isFinite(Number(node?.deletedAt)),
      );
    }
    if (!includeArchived) {
      records = records.filter((node) => node?.archived !== true);
    }
    return applyListOptions(records, options);
  }

  async listEdges(options = {}) {
    const snapshot = await this._loadSnapshot();
    let records = snapshot.edges;
    const includeDeleted = options.includeDeleted !== false;
    if (!includeDeleted) {
      records = records.filter(
        (edge) => !Number.isFinite(Number(edge?.deletedAt)),
      );
    }
    return applyListOptions(records, options);
  }

  async listTombstones(options = {}) {
    const snapshot = await this._loadSnapshot();
    return applyListOptions(snapshot.tombstones, options);
  }

  async isEmpty(options = {}) {
    const snapshot = await this._loadSnapshot();
    const includeTombstones = options.includeTombstones === true;
    const nodes = snapshot.nodes.length;
    const edges = snapshot.edges.length;
    const tombstones = snapshot.tombstones.length;
    return {
      empty: includeTombstones
        ? nodes === 0 && edges === 0 && tombstones === 0
        : nodes === 0 && edges === 0,
      nodes,
      edges,
      tombstones,
      includeTombstones,
    };
  }

  async importLegacyGraph(legacyGraph, options = {}) {
    const nowMs = normalizeTimestamp(options.nowMs, Date.now());
    const migrationSource =
      normalizeRecordId(options.source || "chat_metadata") || "chat_metadata";
    const requestedRetentionMs = Number(options.legacyRetentionMs);
    const legacyRetentionMs =
      Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
        ? Math.floor(requestedRetentionMs)
        : BME_LEGACY_RETENTION_MS;
    const legacyRetentionUntil = nowMs + legacyRetentionMs;
    const migrationCompletedAt = normalizeTimestamp(
      await this.getMeta("migrationCompletedAt", 0),
      0,
    );
    if (migrationCompletedAt > 0) {
      return {
        migrated: false,
        skipped: true,
        reason: "migration-already-completed",
        revision: await this.getRevision(),
        imported: {
          nodes: (await this.listNodes()).length,
          edges: (await this.listEdges()).length,
          tombstones: (await this.listTombstones()).length,
        },
        migrationCompletedAt,
        migrationSource,
        legacyRetentionUntil: normalizeTimestamp(
          await this.getMeta("legacyRetentionUntil", 0),
          0,
        ),
      };
    }
    const emptyStatus = await this.isEmpty();
    if (!emptyStatus?.empty) {
      return {
        migrated: false,
        skipped: true,
        reason: "local-store-not-empty",
        revision: await this.getRevision(),
        imported: {
          nodes: emptyStatus.nodes,
          edges: emptyStatus.edges,
          tombstones: emptyStatus.tombstones,
        },
        migrationCompletedAt: 0,
        migrationSource,
        legacyRetentionUntil,
      };
    }

    const runtimeLegacyGraph = normalizeGraphRuntimeState(
      deserializeGraph(toPlainData(legacyGraph, createEmptyGraph())),
      this.chatId,
    );
    const snapshot = buildSnapshotFromGraph(runtimeLegacyGraph, {
      chatId: this.chatId,
      nowMs,
      revision: normalizeRevision(
        options.revision ?? runtimeLegacyGraph?.__stBmePersistence?.revision,
      ),
      meta: {
        migrationCompletedAt: nowMs,
        migrationSource,
        legacyRetentionUntil,
        storagePrimary: OPFS_STORE_KIND,
        storageMode: this.storeMode,
      },
    });
    const nodeSourceFloorById = new Map();
    const nodes = sanitizeSnapshotRecordArray(snapshot.nodes).map((node) => {
      const sourceFloor = deriveNodeSourceFloor(node);
      nodeSourceFloorById.set(node.id, sourceFloor);
      return sourceFloor == null ? node : { ...node, sourceFloor };
    });
    const edges = sanitizeSnapshotRecordArray(snapshot.edges).map((edge) => {
      const sourceFloor = deriveEdgeSourceFloor(edge, nodeSourceFloorById);
      return sourceFloor == null ? edge : { ...edge, sourceFloor };
    });
    const importResult = await this.importSnapshot(
      {
        meta: {
          ...snapshot.meta,
          migrationCompletedAt: nowMs,
          migrationSource,
          legacyRetentionUntil,
          storagePrimary: OPFS_STORE_KIND,
          storageMode: this.storeMode,
        },
        state: snapshot.state,
        nodes,
        edges,
        tombstones: sanitizeSnapshotRecordArray(snapshot.tombstones),
      },
      {
        mode: "replace",
        preserveRevision: true,
        revision: normalizeRevision(options.revision ?? snapshot.meta?.revision),
        markSyncDirty: true,
      },
    );

    return {
      migrated: true,
      skipped: false,
      reason: "migrated",
      revision: importResult.revision,
      imported: toPlainData(importResult.imported, importResult.imported),
      migrationCompletedAt: nowMs,
      migrationSource,
      legacyRetentionUntil,
    };
  }

  async exportSnapshot() {
    const snapshot = await this._loadSnapshot();
    return {
      meta: toPlainData(snapshot.meta, {}),
      nodes: toPlainData(snapshot.nodes, []),
      edges: toPlainData(snapshot.edges, []),
      tombstones: toPlainData(snapshot.tombstones, []),
      state: toPlainData(snapshot.state, {}),
    };
  }

  async importSnapshot(snapshot, options = {}) {
    return await this._runSerializedWrite("importSnapshot", async () => {
      const normalizedSnapshot = sanitizeSnapshot(snapshot);
      const mode = normalizeMode(options.mode);
      const shouldMarkSyncDirty = options.markSyncDirty !== false;
      const nowMs = Date.now();
      const currentSnapshot = await this._loadSnapshot({ awaitWrites: false });
      const nextSnapshot =
        mode === "replace"
          ? normalizedSnapshot
          : {
              meta: {
                ...currentSnapshot.meta,
                ...normalizedSnapshot.meta,
              },
              state: {
                ...currentSnapshot.state,
                ...normalizedSnapshot.state,
              },
              nodes: mergeSnapshotRecords(currentSnapshot.nodes, normalizedSnapshot.nodes),
              edges: mergeSnapshotRecords(currentSnapshot.edges, normalizedSnapshot.edges),
              tombstones: mergeSnapshotRecords(
                currentSnapshot.tombstones,
                normalizedSnapshot.tombstones,
              ),
            };
      const currentRevision = normalizeRevision(currentSnapshot.meta?.revision);
      const incomingRevision = normalizeRevision(normalizedSnapshot.meta?.revision);
      const explicitRevision = normalizeRevision(options.revision);
      const requestedRevision = Number.isFinite(Number(options.revision))
        ? explicitRevision
        : options.preserveRevision
          ? incomingRevision
          : currentRevision + 1;
      const nextRevision = Math.max(currentRevision + 1, requestedRevision);
      nextSnapshot.meta = {
        ...nextSnapshot.meta,
        chatId: this.chatId,
        revision: nextRevision,
        lastModified: nowMs,
        lastMutationReason: "importSnapshot",
        syncDirty: shouldMarkSyncDirty,
        syncDirtyReason: "importSnapshot",
        storagePrimary: OPFS_STORE_KIND,
        storageMode: this.storeMode,
      };
      nextSnapshot.state = {
        ...nextSnapshot.state,
        lastProcessedFloor: Number.isFinite(Number(nextSnapshot?.state?.lastProcessedFloor))
          ? Number(nextSnapshot.state.lastProcessedFloor)
          : Number.isFinite(Number(nextSnapshot?.meta?.lastProcessedFloor))
            ? Number(nextSnapshot.meta.lastProcessedFloor)
            : META_DEFAULT_LAST_PROCESSED_FLOOR,
        extractionCount: Number.isFinite(Number(nextSnapshot?.state?.extractionCount))
          ? Number(nextSnapshot.state.extractionCount)
          : Number.isFinite(Number(nextSnapshot?.meta?.extractionCount))
            ? Number(nextSnapshot.meta.extractionCount)
            : META_DEFAULT_EXTRACTION_COUNT,
      };
      await this._writeResolvedSnapshot(nextSnapshot);

      return {
        mode,
        revision: nextRevision,
        imported: {
          nodes: nextSnapshot.nodes.length,
          edges: nextSnapshot.edges.length,
          tombstones: nextSnapshot.tombstones.length,
        },
      };
    });
  }

  async clearAll() {
    return await this._runSerializedWrite("clearAll", async () => {
      const currentRevision = normalizeRevision(
        (await this._readManifest({ awaitWrites: false }))?.meta?.revision,
      );
      const nextRevision = currentRevision + 1;
      await this._writeResolvedSnapshot({
        meta: {
          revision: nextRevision,
          lastModified: Date.now(),
          lastMutationReason: "clearAll",
          syncDirty: true,
          syncDirtyReason: "clearAll",
          storagePrimary: OPFS_STORE_KIND,
          storageMode: this.storeMode,
        },
        state: {
          lastProcessedFloor: META_DEFAULT_LAST_PROCESSED_FLOOR,
          extractionCount: META_DEFAULT_EXTRACTION_COUNT,
        },
        nodes: [],
        edges: [],
        tombstones: [],
      });
      return {
        cleared: true,
        revision: nextRevision,
      };
    });
  }

  async pruneExpiredTombstones(nowMs = Date.now()) {
    return await this._runSerializedWrite(
      "pruneExpiredTombstones",
      async () => {
        const normalizedNow = normalizeTimestamp(nowMs, Date.now());
        const cutoffMs = normalizedNow - BME_TOMBSTONE_RETENTION_MS;
        const snapshot = await this._loadSnapshot({ awaitWrites: false });
        const nextTombstones = snapshot.tombstones.filter(
          (item) => normalizeTimestamp(item?.deletedAt, 0) >= cutoffMs,
        );
        const removedCount = snapshot.tombstones.length - nextTombstones.length;
        if (removedCount <= 0) {
          return {
            pruned: 0,
            revision: normalizeRevision(snapshot.meta?.revision),
            cutoffMs,
          };
        }
        const nextRevision = normalizeRevision(snapshot.meta?.revision) + 1;
        await this._writeResolvedSnapshot({
          meta: {
            ...snapshot.meta,
            revision: nextRevision,
            lastModified: normalizedNow,
            lastMutationReason: "pruneExpiredTombstones",
            syncDirty: true,
            syncDirtyReason: "pruneExpiredTombstones",
            storagePrimary: OPFS_STORE_KIND,
            storageMode: this.storeMode,
          },
          state: snapshot.state,
          nodes: snapshot.nodes,
          edges: snapshot.edges,
          tombstones: nextTombstones,
        });
        return {
          pruned: removedCount,
          revision: nextRevision,
          cutoffMs,
        };
      },
    );
  }

  async _recoverManifestFromDirectory(chatDirectory, manifest = null) {
    const fileNames = await listDirectoryFileNames(chatDirectory);
    const coreCandidates = fileNames
      .map((name) => parseSnapshotFilenameCandidate(name, OPFS_CORE_FILENAME_PREFIX))
      .filter(Boolean);
    const auxCandidates = fileNames
      .map((name) => parseSnapshotFilenameCandidate(name, OPFS_AUX_FILENAME_PREFIX))
      .filter(Boolean);
    if (!coreCandidates.length || !auxCandidates.length) {
      return null;
    }

    const coreByRevision = new Map();
    const auxByRevision = new Map();
    for (const candidate of coreCandidates) {
      const current = coreByRevision.get(candidate.revision) || null;
      if (!current || candidate.stampMs > current.stampMs) {
        coreByRevision.set(candidate.revision, candidate);
      }
    }
    for (const candidate of auxCandidates) {
      const current = auxByRevision.get(candidate.revision) || null;
      if (!current || candidate.stampMs > current.stampMs) {
        auxByRevision.set(candidate.revision, candidate);
      }
    }

    const candidateRevisions = Array.from(coreByRevision.keys())
      .filter((revision) => auxByRevision.has(revision))
      .sort((left, right) => right - left);
    if (!candidateRevisions.length) {
      return null;
    }

    const recoveredRevision = candidateRevisions[0];
    const recoveredCore = coreByRevision.get(recoveredRevision);
    const recoveredAux = auxByRevision.get(recoveredRevision);
    if (!recoveredCore || !recoveredAux) {
      return null;
    }

    const nextManifest = {
      ...(manifest || {}),
      version: OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      storeKind: OPFS_STORE_KIND,
      storeMode: this.storeMode,
      activeCoreFilename: recoveredCore.filename,
      activeAuxFilename: recoveredAux.filename,
      meta: {
        ...createDefaultMetaValues(this.chatId),
        ...(manifest?.meta && typeof manifest.meta === "object" && !Array.isArray(manifest.meta)
          ? toPlainData(manifest.meta, {})
          : {}),
        revision: recoveredRevision,
        chatId: this.chatId,
        storagePrimary: OPFS_STORE_KIND,
        storageMode: this.storeMode,
      },
    };
    await writeJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, nextManifest);
    this._manifestCache = nextManifest;
    return nextManifest;
  }

  async _getChatDirectory() {
    if (!this._chatDirectoryPromise) {
      this._chatDirectoryPromise = (async () => {
        const rootDirectory = await this._rootDirectoryFactory();
        if (!rootDirectory || typeof rootDirectory.getDirectoryHandle !== "function") {
          throw new Error("OPFS 根目录不可用");
        }
        const opfsRoot = await ensureDirectoryHandle(
          rootDirectory,
          OPFS_ROOT_DIRECTORY_NAME,
        );
        const chatsDirectory = await ensureDirectoryHandle(
          opfsRoot,
          OPFS_CHATS_DIRECTORY_NAME,
        );
        return await ensureDirectoryHandle(
          chatsDirectory,
          buildChatDirectoryName(this.chatId),
        );
      })();
    }
    return await this._chatDirectoryPromise;
  }

  async _ensureManifest(options = {}) {
    const existingManifest = await this._readManifest(options);
    if (existingManifest) {
      return existingManifest;
    }
    const chatDirectory = await this._getChatDirectory();
    const manifest = {
      version: OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      storeKind: OPFS_STORE_KIND,
      storeMode: this.storeMode,
      activeCoreFilename: "",
      activeAuxFilename: "",
      meta: createDefaultMetaValues(this.chatId),
    };
    manifest.meta.storagePrimary = OPFS_STORE_KIND;
    manifest.meta.storageMode = this.storeMode;
    await writeJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, manifest);
    this._manifestCache = manifest;
    return manifest;
  }

  async _readManifest({ awaitWrites = true } = {}) {
    if (awaitWrites) {
      await this._awaitPendingWrites();
    }
    if (this._manifestCache) {
      return this._manifestCache;
    }
    const chatDirectory = await this._getChatDirectory();
    const rawManifest = await readJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, null);
    if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
      return null;
    }
    const meta =
      rawManifest.meta &&
      typeof rawManifest.meta === "object" &&
      !Array.isArray(rawManifest.meta)
        ? {
            ...createDefaultMetaValues(this.chatId),
            ...toPlainData(rawManifest.meta, {}),
            chatId: this.chatId,
            schemaVersion: BME_DB_SCHEMA_VERSION,
            storagePrimary: OPFS_STORE_KIND,
            storageMode: this.storeMode,
          }
        : createDefaultMetaValues(this.chatId);
    const manifest = {
      version: Number.isFinite(Number(rawManifest.version))
        ? Number(rawManifest.version)
        : OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      storeKind: OPFS_STORE_KIND,
      storeMode: this.storeMode,
      activeCoreFilename: String(rawManifest.activeCoreFilename || ""),
      activeAuxFilename: String(rawManifest.activeAuxFilename || ""),
      meta,
    };
    this._manifestCache = manifest;
    return manifest;
  }

  async _loadSnapshot({ awaitWrites = true } = {}) {
    if (awaitWrites) {
      await this._awaitPendingWrites();
    }
    let manifest = await this._ensureManifest({
      awaitWrites: false,
    });
    const chatDirectory = await this._getChatDirectory();
    const activeCoreRevision = parseSnapshotFilenameCandidate(
      manifest?.activeCoreFilename,
      OPFS_CORE_FILENAME_PREFIX,
    )?.revision;
    const activeAuxRevision = parseSnapshotFilenameCandidate(
      manifest?.activeAuxFilename,
      OPFS_AUX_FILENAME_PREFIX,
    )?.revision;
    let shouldRecoverManifest =
      Boolean(manifest?.activeCoreFilename) &&
      Boolean(manifest?.activeAuxFilename) &&
      Number.isFinite(activeCoreRevision) &&
      Number.isFinite(activeAuxRevision) &&
      activeCoreRevision !== activeAuxRevision;
    let corePayload = {};
    let auxPayload = {};
    try {
      corePayload = manifest.activeCoreFilename
        ? await readJsonFile(chatDirectory, manifest.activeCoreFilename, null)
        : {};
      auxPayload = manifest.activeAuxFilename
        ? await readJsonFile(chatDirectory, manifest.activeAuxFilename, null)
        : {};
      if (
        (manifest.activeCoreFilename && !corePayload) ||
        (manifest.activeAuxFilename && !auxPayload)
      ) {
        shouldRecoverManifest = true;
      }
    } catch {
      shouldRecoverManifest = true;
    }

    if (shouldRecoverManifest) {
      const recoveredManifest = await this._recoverManifestFromDirectory(
        chatDirectory,
        manifest,
      );
      if (!recoveredManifest) {
        throw new Error("opfs-manifest-snapshot-mismatch");
      }
      manifest = recoveredManifest;
      corePayload = manifest.activeCoreFilename
        ? await readJsonFile(chatDirectory, manifest.activeCoreFilename, {})
        : {};
      auxPayload = manifest.activeAuxFilename
        ? await readJsonFile(chatDirectory, manifest.activeAuxFilename, {})
        : {};
    }
    return buildSnapshotFromStoredParts(manifest, corePayload, auxPayload);
  }

  async _writeResolvedSnapshot(snapshot) {
    const chatDirectory = await this._getChatDirectory();
    const previousManifest = await this._ensureManifest({
      awaitWrites: false,
    });
    const normalizedSnapshot = sanitizeSnapshot(snapshot);
    const state = normalizeSnapshotState(normalizedSnapshot);
    const writeStamp = Date.now();
    const resolvedMeta = {
      ...createDefaultMetaValues(this.chatId, writeStamp),
      ...toPlainData(normalizedSnapshot.meta, {}),
      chatId: this.chatId,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      lastProcessedFloor: Number.isFinite(Number(state.lastProcessedFloor))
        ? Number(state.lastProcessedFloor)
        : META_DEFAULT_LAST_PROCESSED_FLOOR,
      extractionCount: Number.isFinite(Number(state.extractionCount))
        ? Number(state.extractionCount)
        : META_DEFAULT_EXTRACTION_COUNT,
      nodeCount: normalizedSnapshot.nodes.length,
      edgeCount: normalizedSnapshot.edges.length,
      tombstoneCount: normalizedSnapshot.tombstones.length,
      storagePrimary: OPFS_STORE_KIND,
      storageMode: this.storeMode,
    };
    resolvedMeta.revision = normalizeRevision(resolvedMeta.revision);
    resolvedMeta.lastModified = normalizeTimestamp(
      resolvedMeta.lastModified,
      writeStamp,
    );
    const splitMeta = splitSnapshotMeta(resolvedMeta);
    const coreFilename = buildSnapshotFilename(
      OPFS_CORE_FILENAME_PREFIX,
      resolvedMeta.revision,
      writeStamp,
    );
    const auxFilename = buildSnapshotFilename(
      OPFS_AUX_FILENAME_PREFIX,
      resolvedMeta.revision,
      writeStamp,
    );
    const corePayload = {
      version: OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      nodes: normalizedSnapshot.nodes,
      edges: normalizedSnapshot.edges,
      state,
      meta: splitMeta.coreMeta,
    };
    const auxPayload = {
      version: OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      tombstones: normalizedSnapshot.tombstones,
      meta: splitMeta.auxMeta,
    };
    await writeJsonFile(chatDirectory, coreFilename, corePayload);
    await writeJsonFile(chatDirectory, auxFilename, auxPayload);
    const manifest = {
      version: OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      storeKind: OPFS_STORE_KIND,
      storeMode: this.storeMode,
      activeCoreFilename: coreFilename,
      activeAuxFilename: auxFilename,
      meta: splitMeta.manifestMeta,
    };
    await writeJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, manifest);
    this._manifestCache = manifest;

    if (
      previousManifest?.activeCoreFilename &&
      previousManifest.activeCoreFilename !== coreFilename
    ) {
      await deleteFileIfExists(chatDirectory, previousManifest.activeCoreFilename).catch(
        () => {},
      );
    }
    if (
      previousManifest?.activeAuxFilename &&
      previousManifest.activeAuxFilename !== auxFilename
    ) {
      await deleteFileIfExists(chatDirectory, previousManifest.activeAuxFilename).catch(
        () => {},
      );
    }

    return buildSnapshotFromStoredParts(manifest, corePayload, auxPayload);
  }
}

function hashRecordIdToBucket(id = "", bucketCount = 1) {
  const normalizedId = normalizeRecordId(id);
  const normalizedBucketCount = Math.max(1, Math.floor(Number(bucketCount) || 1));
  let hash = 2166136261;
  for (let index = 0; index < normalizedId.length; index += 1) {
    hash ^= normalizedId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % normalizedBucketCount;
}

function buildOpfsV2ShardFilename(kind = "nodes", bucketIndex = 0) {
  return `${String(kind || "records")}.${Math.max(0, Math.floor(Number(bucketIndex) || 0))
    .toString(16)
    .padStart(2, "0")}.json`;
}

function buildOpfsV2WalFilename(revision = 0) {
  return `commit.${normalizeRevision(revision)}.json`;
}

function buildOpfsV2MetaFilename(key = "") {
  return `meta.${encodeURIComponent(normalizeRecordId(key))}.json`;
}

function parseOpfsV2WalFilename(name = "") {
  const match = String(name || "").trim().match(/^commit\.(\d+)\.json$/);
  if (!match) return null;
  return {
    filename: String(name || "").trim(),
    revision: normalizeRevision(match[1]),
  };
}

function parseOpfsV2MetaFilename(name = "") {
  const match = String(name || "").trim().match(/^meta\.(.+)\.json$/);
  if (!match) return null;
  return normalizeRecordId(decodeURIComponent(match[1] || ""));
}

function normalizeOpfsV2CountDelta(countDelta = null) {
  const next =
    countDelta?.next && typeof countDelta.next === "object" && !Array.isArray(countDelta.next)
      ? countDelta.next
      : null;
  const previous =
    countDelta?.previous &&
    typeof countDelta.previous === "object" &&
    !Array.isArray(countDelta.previous)
      ? countDelta.previous
      : null;
  const delta =
    countDelta?.delta && typeof countDelta.delta === "object" && !Array.isArray(countDelta.delta)
      ? countDelta.delta
      : null;
  return {
    previous: {
      nodes: normalizeNonNegativeInteger(previous?.nodes, 0),
      edges: normalizeNonNegativeInteger(previous?.edges, 0),
      tombstones: normalizeNonNegativeInteger(previous?.tombstones, 0),
    },
    next: {
      nodes: normalizeNonNegativeInteger(next?.nodes, 0),
      edges: normalizeNonNegativeInteger(next?.edges, 0),
      tombstones: normalizeNonNegativeInteger(next?.tombstones, 0),
    },
    delta: {
      nodes: Number.isFinite(Number(delta?.nodes))
        ? Math.trunc(Number(delta.nodes))
        : normalizeNonNegativeInteger(next?.nodes, 0) -
          normalizeNonNegativeInteger(previous?.nodes, 0),
      edges: Number.isFinite(Number(delta?.edges))
        ? Math.trunc(Number(delta.edges))
        : normalizeNonNegativeInteger(next?.edges, 0) -
          normalizeNonNegativeInteger(previous?.edges, 0),
      tombstones: Number.isFinite(Number(delta?.tombstones))
        ? Math.trunc(Number(delta.tombstones))
        : normalizeNonNegativeInteger(next?.tombstones, 0) -
          normalizeNonNegativeInteger(previous?.tombstones, 0),
    },
  };
}

function sanitizeOpfsV2Delta(delta = {}, nowMs = Date.now()) {
  const normalizedDelta =
    delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
  return {
    upsertNodes: sanitizeSnapshotRecordArray(normalizedDelta.upsertNodes).map((node) => ({
      ...node,
      id: normalizeRecordId(node.id),
      updatedAt: normalizeTimestamp(node.updatedAt, nowMs),
    })),
    upsertEdges: sanitizeSnapshotRecordArray(normalizedDelta.upsertEdges).map((edge) => ({
      ...edge,
      id: normalizeRecordId(edge.id),
      fromId: normalizeRecordId(edge.fromId),
      toId: normalizeRecordId(edge.toId),
      updatedAt: normalizeTimestamp(edge.updatedAt, nowMs),
    })),
    deleteNodeIds: toArray(normalizedDelta.deleteNodeIds)
      .map((value) => normalizeRecordId(value))
      .filter(Boolean),
    deleteEdgeIds: toArray(normalizedDelta.deleteEdgeIds)
      .map((value) => normalizeRecordId(value))
      .filter(Boolean),
    tombstones: sanitizeSnapshotRecordArray(normalizedDelta.tombstones).map((tombstone) => ({
      ...tombstone,
      id: normalizeRecordId(tombstone.id),
      kind: normalizeRecordId(tombstone.kind),
      targetId: normalizeRecordId(tombstone.targetId),
      sourceDeviceId: normalizeRecordId(tombstone.sourceDeviceId),
      deletedAt: normalizeTimestamp(tombstone.deletedAt, nowMs),
    })),
    runtimeMetaPatch:
      normalizedDelta.runtimeMetaPatch &&
      typeof normalizedDelta.runtimeMetaPatch === "object" &&
      !Array.isArray(normalizedDelta.runtimeMetaPatch)
        ? toPlainData(normalizedDelta.runtimeMetaPatch, {})
        : {},
    countDelta: normalizeOpfsV2CountDelta(normalizedDelta.countDelta),
  };
}

function applyOpfsV2DeltaToSnapshot(snapshot = {}, delta = {}, nowMs = Date.now()) {
  const nextSnapshot = sanitizeSnapshot(snapshot);
  const normalizedDelta = sanitizeOpfsV2Delta(delta, nowMs);
  const nodeMap = new Map(
    sanitizeSnapshotRecordArray(nextSnapshot.nodes).map((record) => [
      normalizeRecordId(record.id),
      record,
    ]),
  );
  const edgeMap = new Map(
    sanitizeSnapshotRecordArray(nextSnapshot.edges).map((record) => [
      normalizeRecordId(record.id),
      record,
    ]),
  );
  const tombstoneMap = new Map(
    sanitizeSnapshotRecordArray(nextSnapshot.tombstones).map((record) => [
      normalizeRecordId(record.id),
      record,
    ]),
  );

  for (const nodeId of normalizedDelta.deleteNodeIds) {
    nodeMap.delete(nodeId);
  }
  for (const edgeId of normalizedDelta.deleteEdgeIds) {
    edgeMap.delete(edgeId);
  }
  for (const node of normalizedDelta.upsertNodes) {
    if (!node.id) continue;
    nodeMap.set(node.id, node);
  }
  for (const edge of normalizedDelta.upsertEdges) {
    if (!edge.id) continue;
    edgeMap.set(edge.id, edge);
  }
  for (const tombstone of normalizedDelta.tombstones) {
    if (!tombstone.id) continue;
    tombstoneMap.set(tombstone.id, tombstone);
  }

  nextSnapshot.nodes = Array.from(nodeMap.values());
  nextSnapshot.edges = Array.from(edgeMap.values());
  nextSnapshot.tombstones = Array.from(tombstoneMap.values());
  nextSnapshot.meta = {
    ...(nextSnapshot.meta || {}),
    ...(normalizedDelta.runtimeMetaPatch || {}),
    nodeCount: nextSnapshot.nodes.length,
    edgeCount: nextSnapshot.edges.length,
    tombstoneCount: nextSnapshot.tombstones.length,
  };
  nextSnapshot.state = normalizeSnapshotState(nextSnapshot);
  if (Object.prototype.hasOwnProperty.call(normalizedDelta.runtimeMetaPatch, "lastProcessedFloor")) {
    nextSnapshot.state.lastProcessedFloor = Number.isFinite(
      Number(normalizedDelta.runtimeMetaPatch.lastProcessedFloor),
    )
      ? Number(normalizedDelta.runtimeMetaPatch.lastProcessedFloor)
      : META_DEFAULT_LAST_PROCESSED_FLOOR;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedDelta.runtimeMetaPatch, "extractionCount")) {
    nextSnapshot.state.extractionCount = Number.isFinite(
      Number(normalizedDelta.runtimeMetaPatch.extractionCount),
    )
      ? Number(normalizedDelta.runtimeMetaPatch.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT;
  }
  nextSnapshot.meta.lastProcessedFloor = nextSnapshot.state.lastProcessedFloor;
  nextSnapshot.meta.extractionCount = nextSnapshot.state.extractionCount;
  return nextSnapshot;
}

function splitOpfsV2SnapshotMeta(meta = {}) {
  const manifestMeta = {};
  const runtimeMeta = {};
  for (const [rawKey, value] of Object.entries(meta || {})) {
    const key = normalizeRecordId(rawKey);
    if (!key) continue;
    const clonedValue = toPlainData(value, value);
    if (OPFS_MANIFEST_META_KEYS.has(key)) {
      manifestMeta[key] = clonedValue;
      continue;
    }
    runtimeMeta[key] = clonedValue;
  }
  return {
    manifestMeta,
    runtimeMeta,
  };
}

function createEmptyOpfsV2Manifest(chatId = "", storeMode = BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY) {
  return {
    version: OPFS_MANIFEST_VERSION,
    formatVersion: OPFS_FORMAT_VERSION_V2,
    chatId: normalizeChatId(chatId),
    storeKind: OPFS_STORE_KIND,
    storeMode: normalizeGraphLocalStorageMode(
      storeMode,
      BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
    ),
    baseRevision: 0,
    headRevision: 0,
    lastCompactedRevision: 0,
    pendingLogFromRevision: 1,
    shardLayout: {
      nodes: OPFS_V2_NODE_BUCKET_COUNT,
      edges: OPFS_V2_EDGE_BUCKET_COUNT,
      tombstones: OPFS_V2_TOMBSTONE_BUCKET_COUNT,
    },
    wal: {
      count: 0,
      totalBytes: 0,
    },
    compaction: {
      state: "idle",
      queued: false,
      lastAt: 0,
      lastReason: "",
    },
    meta: createDefaultMetaValues(chatId),
  };
}

function isOpfsV2Manifest(manifest = null) {
  return Number(manifest?.formatVersion || 0) === OPFS_FORMAT_VERSION_V2;
}

function groupOpfsV2RecordsByBucket(records = [], bucketCount = 1) {
  const bucketMap = new Map();
  for (const record of sanitizeSnapshotRecordArray(records)) {
    const id = normalizeRecordId(record.id);
    if (!id) continue;
    const bucketIndex = hashRecordIdToBucket(id, bucketCount);
    const bucketRecords = bucketMap.get(bucketIndex) || [];
    bucketRecords.push({ ...record, id });
    bucketMap.set(bucketIndex, bucketRecords);
  }
  return bucketMap;
}

function buildOpfsV2IntegritySummary(snapshot = {}) {
  return {
    nodeCount: normalizeNonNegativeInteger(snapshot?.nodes?.length, 0),
    edgeCount: normalizeNonNegativeInteger(snapshot?.edges?.length, 0),
    tombstoneCount: normalizeNonNegativeInteger(snapshot?.tombstones?.length, 0),
    revision: normalizeRevision(snapshot?.meta?.revision),
  };
}

export class OpfsGraphStore {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.options = options;
    this.storeKind = OPFS_STORE_KIND;
    const normalizedStoreMode = normalizeGraphLocalStorageMode(
      options.storeMode,
      BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
    );
    this.storeMode =
      normalizedStoreMode === BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW
        ? BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY
        : normalizedStoreMode;
    this._rootDirectoryFactory =
      typeof options.rootDirectoryFactory === "function"
        ? options.rootDirectoryFactory
        : getDefaultOpfsRootDirectory;
    this._chatDirectoryPromise = null;
    this._manifestCache = null;
    this._snapshotCache = null;
    this._writeChain = Promise.resolve();
    this._writeQueueDepth = 0;
    this._writeLockState = {
      active: false,
      queueDepth: 0,
      lastReason: "",
      updatedAt: 0,
    };
    this._compactionScheduled = false;
  }

  async open() {
    await this._ensureV2Ready();
    return this;
  }

  async close() {
    this._chatDirectoryPromise = null;
    this._manifestCache = null;
    this._snapshotCache = null;
    this._writeChain = Promise.resolve();
    this._writeQueueDepth = 0;
    this._compactionScheduled = false;
    this._writeLockState = {
      active: false,
      queueDepth: 0,
      lastReason: "",
      updatedAt: 0,
    };
  }

  getWriteLockSnapshot() {
    return toPlainData(this._writeLockState, this._writeLockState);
  }

  async _awaitPendingWrites() {
    try {
      await this._writeChain;
    } catch {
      // ignore previous write failure for read barrier
    }
  }

  _setWriteLockState(patch = {}) {
    this._writeLockState = {
      ...this._writeLockState,
      ...(patch || {}),
      updatedAt: Date.now(),
    };
    return this._writeLockState;
  }

  async _runSerializedWrite(reason = "opfs-v2-write", task = null) {
    if (typeof task !== "function") {
      throw new Error("OpfsGraphStore serialized write task is required");
    }
    this._writeQueueDepth += 1;
    this._setWriteLockState({
      active: true,
      queueDepth: this._writeQueueDepth,
      lastReason: String(reason || "opfs-v2-write"),
    });
    const runTask = async () => {
      try {
        return await task();
      } finally {
        this._writeQueueDepth = Math.max(0, this._writeQueueDepth - 1);
        this._setWriteLockState({
          active: this._writeQueueDepth > 0,
          queueDepth: this._writeQueueDepth,
          lastReason: String(reason || "opfs-v2-write"),
        });
      }
    };
    const nextWrite = this._writeChain.catch(() => null).then(runTask);
    this._writeChain = nextWrite.catch(() => null);
    return await nextWrite;
  }

  async getMeta(key, fallbackValue = null) {
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return fallbackValue;
    const manifest = await this._ensureV2Ready();
    if (OPFS_MANIFEST_META_KEYS.has(normalizedKey)) {
      const manifestMeta =
        manifest?.meta && typeof manifest.meta === "object" && !Array.isArray(manifest.meta)
          ? manifest.meta
          : {};
      return Object.prototype.hasOwnProperty.call(manifestMeta, normalizedKey)
        ? manifestMeta[normalizedKey]
        : fallbackValue;
    }
    const snapshot = await this._loadSnapshot();
    return Object.prototype.hasOwnProperty.call(snapshot.meta, normalizedKey)
      ? snapshot.meta[normalizedKey]
      : fallbackValue;
  }

  async setMeta(key, value) {
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return null;
    await this.patchMeta({
      [normalizedKey]: value,
    });
    return {
      key: normalizedKey,
      value: await this.getMeta(normalizedKey, null),
      updatedAt: Date.now(),
    };
  }

  async patchMeta(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {};
    }
    const entries = Object.entries(record)
      .map(([rawKey, value]) => [normalizeRecordId(rawKey), toPlainData(value, value)])
      .filter(([key]) => Boolean(key));
    if (!entries.length) {
      return {};
    }
    return await this._runSerializedWrite("patchMeta", async () => {
      const manifest = await this._ensureV2Ready({ awaitWrites: false });
      const manifestPatch = {};
      const runtimePatch = {};
      for (const [key, value] of entries) {
        if (OPFS_MANIFEST_META_KEYS.has(key)) {
          manifestPatch[key] = value;
        } else {
          runtimePatch[key] = value;
        }
      }

      if (Object.keys(runtimePatch).length > 0) {
        await this._writeRuntimeMetaEntries(runtimePatch);
      }

      if (Object.keys(manifestPatch).length > 0) {
        const nextManifest = {
          ...manifest,
          meta: {
            ...createDefaultMetaValues(this.chatId),
            ...(manifest.meta || {}),
            ...manifestPatch,
            chatId: this.chatId,
            schemaVersion: BME_DB_SCHEMA_VERSION,
            storagePrimary: OPFS_STORE_KIND,
            storageMode: this.storeMode,
          },
        };
        await this._writeManifest(nextManifest);
      }

      if (this._snapshotCache) {
        this._snapshotCache.meta = {
          ...this._snapshotCache.meta,
          ...manifestPatch,
          ...runtimePatch,
        };
        this._snapshotCache.state = {
          ...normalizeSnapshotState(this._snapshotCache),
          ...(Object.prototype.hasOwnProperty.call(manifestPatch, "lastProcessedFloor")
            ? {
                lastProcessedFloor: Number.isFinite(
                  Number(manifestPatch.lastProcessedFloor),
                )
                  ? Number(manifestPatch.lastProcessedFloor)
                  : META_DEFAULT_LAST_PROCESSED_FLOOR,
              }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(manifestPatch, "extractionCount")
            ? {
                extractionCount: Number.isFinite(Number(manifestPatch.extractionCount))
                  ? Number(manifestPatch.extractionCount)
                  : META_DEFAULT_EXTRACTION_COUNT,
              }
            : {}),
        };
        this._snapshotCache.meta.lastProcessedFloor =
          this._snapshotCache.state.lastProcessedFloor;
        this._snapshotCache.meta.extractionCount =
          this._snapshotCache.state.extractionCount;
      }

      return Object.fromEntries(entries);
    });
  }

  async getRevision() {
    return normalizeRevision(await this.getMeta("revision", 0));
  }

  async markSyncDirty(reason = "mutation") {
    await this.patchMeta({
      syncDirty: true,
      syncDirtyReason: String(reason || "mutation"),
    });
    return true;
  }

  getStorageDiagnosticsSync() {
    const manifest = this._manifestCache || null;
    return {
      formatVersion: isOpfsV2Manifest(manifest) ? OPFS_FORMAT_VERSION_V2 : 1,
      walCount: normalizeNonNegativeInteger(manifest?.wal?.count, 0),
      walTotalBytes: normalizeNonNegativeInteger(manifest?.wal?.totalBytes, 0),
      baseRevision: normalizeRevision(manifest?.baseRevision || 0),
      headRevision: normalizeRevision(
        manifest?.headRevision || manifest?.meta?.revision || 0,
      ),
      lastCompactedRevision: normalizeRevision(
        manifest?.lastCompactedRevision || 0,
      ),
      pendingLogFromRevision: normalizeRevision(
        manifest?.pendingLogFromRevision || 0,
      ),
      compactionState: toPlainData(manifest?.compaction || {}, {}),
      resolvedStoreMode: this.storeMode,
    };
  }

  async commitDelta(delta = {}, options = {}) {
    return await this._runSerializedWrite(
      String(options?.reason || "commitDelta"),
      async () => {
        const manifest = await this._ensureV2Ready({ awaitWrites: false });
        const nowMs = Date.now();
        const normalizedDelta = sanitizeOpfsV2Delta(delta, nowMs);
        const requestedRevision = normalizeRevision(options.requestedRevision);
        const shouldMarkSyncDirty = options.markSyncDirty !== false;
        const reason = String(options.reason || "commitDelta");
        const currentHeadRevision = normalizeRevision(
          manifest?.headRevision || manifest?.meta?.revision,
        );
        const nextRevision = Math.max(currentHeadRevision + 1, requestedRevision);
        const nextCountDelta = normalizeOpfsV2CountDelta(normalizedDelta.countDelta);
        const nextMeta = {
          ...createDefaultMetaValues(this.chatId),
          ...(manifest?.meta || {}),
          ...Object.fromEntries(
            Object.entries(normalizedDelta.runtimeMetaPatch).filter(([key]) =>
              OPFS_MANIFEST_META_KEYS.has(normalizeRecordId(key)),
            ),
          ),
          chatId: this.chatId,
          revision: nextRevision,
          lastModified: nowMs,
          lastMutationReason: reason,
          syncDirty: shouldMarkSyncDirty,
          syncDirtyReason: shouldMarkSyncDirty ? reason : "",
          storagePrimary: OPFS_STORE_KIND,
          storageMode: this.storeMode,
          nodeCount: normalizeNonNegativeInteger(nextCountDelta.next.nodes, 0),
          edgeCount: normalizeNonNegativeInteger(nextCountDelta.next.edges, 0),
          tombstoneCount: normalizeNonNegativeInteger(nextCountDelta.next.tombstones, 0),
        };
        const walRecord = {
          version: OPFS_MANIFEST_VERSION,
          formatVersion: OPFS_FORMAT_VERSION_V2,
          revision: nextRevision,
          reason,
          committedAt: nowMs,
          delta: normalizedDelta,
          runtimeMetaPatch: normalizedDelta.runtimeMetaPatch,
          countDelta: nextCountDelta,
        };
        const walDirectory = await this._getWalDirectory();
        const walFilename = buildOpfsV2WalFilename(nextRevision);
        await writeJsonFile(walDirectory, walFilename, walRecord);
        const walByteLength = JSON.stringify(walRecord).length;

        const hadPendingWal =
          normalizeRevision(manifest?.pendingLogFromRevision) <= currentHeadRevision;
        const nextManifest = {
          ...manifest,
          formatVersion: OPFS_FORMAT_VERSION_V2,
          chatId: this.chatId,
          storeKind: OPFS_STORE_KIND,
          storeMode: this.storeMode,
          headRevision: nextRevision,
          pendingLogFromRevision: hadPendingWal
            ? normalizeRevision(manifest?.pendingLogFromRevision || nextRevision)
            : nextRevision,
          wal: {
            count: normalizeNonNegativeInteger(manifest?.wal?.count, 0) + 1,
            totalBytes:
              normalizeNonNegativeInteger(manifest?.wal?.totalBytes, 0) + walByteLength,
          },
          meta: nextMeta,
          compaction: {
            ...(manifest?.compaction || {}),
            state: "pending",
            queued: false,
            lastReason: reason,
          },
        };
        await this._writeManifest(nextManifest);

        if (this._snapshotCache) {
          const nextSnapshot = applyOpfsV2DeltaToSnapshot(
            this._snapshotCache,
            normalizedDelta,
            nowMs,
          );
          nextSnapshot.meta = {
            ...nextSnapshot.meta,
            ...nextMeta,
          };
          nextSnapshot.state = normalizeSnapshotState(nextSnapshot);
          this._snapshotCache = nextSnapshot;
        }

        this._maybeScheduleCompaction(nextManifest, reason);

        return {
          revision: nextRevision,
          lastModified: nowMs,
          imported: {
            nodes: nextMeta.nodeCount,
            edges: nextMeta.edgeCount,
            tombstones: nextMeta.tombstoneCount,
          },
          delta: {
            upsertNodes: normalizedDelta.upsertNodes.length,
            upsertEdges: normalizedDelta.upsertEdges.length,
            deleteNodeIds: normalizedDelta.deleteNodeIds.length,
            deleteEdgeIds: normalizedDelta.deleteEdgeIds.length,
            tombstones: normalizedDelta.tombstones.length,
          },
        };
      },
    );
  }

  async bulkUpsertNodes(nodes = []) {
    const records = sanitizeSnapshotRecordArray(nodes);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }
    const result = await this.commitDelta(
      {
        upsertNodes: records,
      },
      {
        reason: "bulkUpsertNodes",
      },
    );
    return {
      upserted: records.length,
      revision: result.revision,
    };
  }

  async bulkUpsertEdges(edges = []) {
    const records = sanitizeSnapshotRecordArray(edges);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }
    const result = await this.commitDelta(
      {
        upsertEdges: records,
      },
      {
        reason: "bulkUpsertEdges",
      },
    );
    return {
      upserted: records.length,
      revision: result.revision,
    };
  }

  async bulkUpsertTombstones(tombstones = []) {
    const records = sanitizeSnapshotRecordArray(tombstones);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }
    const result = await this.commitDelta(
      {
        tombstones: records,
      },
      {
        reason: "bulkUpsertTombstones",
      },
    );
    return {
      upserted: records.length,
      revision: result.revision,
    };
  }

  async listNodes(options = {}) {
    const snapshot = await this._loadSnapshot();
    let records = sanitizeSnapshotRecordArray(snapshot.nodes);
    const includeDeleted = options.includeDeleted !== false;
    const includeArchived = options.includeArchived !== false;
    if (!includeDeleted) {
      records = records.filter((node) => !Number.isFinite(Number(node?.deletedAt)));
    }
    if (!includeArchived) {
      records = records.filter((node) => node?.archived !== true);
    }
    return applyListOptions(records, options);
  }

  async listEdges(options = {}) {
    const snapshot = await this._loadSnapshot();
    let records = sanitizeSnapshotRecordArray(snapshot.edges);
    const includeDeleted = options.includeDeleted !== false;
    if (!includeDeleted) {
      records = records.filter((edge) => !Number.isFinite(Number(edge?.deletedAt)));
    }
    return applyListOptions(records, options);
  }

  async listTombstones(options = {}) {
    const snapshot = await this._loadSnapshot();
    return applyListOptions(snapshot.tombstones, options);
  }

  async isEmpty(options = {}) {
    const snapshot = await this._loadSnapshot();
    const includeTombstones = options.includeTombstones === true;
    const nodes = snapshot.nodes.length;
    const edges = snapshot.edges.length;
    const tombstones = snapshot.tombstones.length;
    return {
      empty: includeTombstones
        ? nodes === 0 && edges === 0 && tombstones === 0
        : nodes === 0 && edges === 0,
      nodes,
      edges,
      tombstones,
      includeTombstones,
    };
  }

  async importLegacyGraph(legacyGraph, options = {}) {
    const nowMs = normalizeTimestamp(options.nowMs, Date.now());
    const migrationSource =
      normalizeRecordId(options.source || "chat_metadata") || "chat_metadata";
    const requestedRetentionMs = Number(options.legacyRetentionMs);
    const legacyRetentionMs =
      Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
        ? Math.floor(requestedRetentionMs)
        : BME_LEGACY_RETENTION_MS;
    const legacyRetentionUntil = nowMs + legacyRetentionMs;
    const migrationCompletedAt = normalizeTimestamp(
      await this.getMeta("migrationCompletedAt", 0),
      0,
    );
    if (migrationCompletedAt > 0) {
      return {
        migrated: false,
        skipped: true,
        reason: "migration-already-completed",
        revision: await this.getRevision(),
        imported: {
          nodes: (await this.listNodes()).length,
          edges: (await this.listEdges()).length,
          tombstones: (await this.listTombstones()).length,
        },
        migrationCompletedAt,
        migrationSource,
        legacyRetentionUntil: normalizeTimestamp(
          await this.getMeta("legacyRetentionUntil", 0),
          0,
        ),
      };
    }
    const emptyStatus = await this.isEmpty();
    if (!emptyStatus?.empty) {
      return {
        migrated: false,
        skipped: true,
        reason: "local-store-not-empty",
        revision: await this.getRevision(),
        imported: {
          nodes: emptyStatus.nodes,
          edges: emptyStatus.edges,
          tombstones: emptyStatus.tombstones,
        },
        migrationCompletedAt: 0,
        migrationSource,
        legacyRetentionUntil,
      };
    }
    const runtimeLegacyGraph = normalizeGraphRuntimeState(
      deserializeGraph(toPlainData(legacyGraph, createEmptyGraph())),
      this.chatId,
    );
    const snapshot = buildSnapshotFromGraph(runtimeLegacyGraph, {
      chatId: this.chatId,
      nowMs,
      revision: normalizeRevision(
        options.revision ?? runtimeLegacyGraph?.__stBmePersistence?.revision,
      ),
      meta: {
        migrationCompletedAt: nowMs,
        migrationSource,
        legacyRetentionUntil,
        storagePrimary: OPFS_STORE_KIND,
        storageMode: this.storeMode,
      },
    });
    const nodeSourceFloorById = new Map();
    const nodes = sanitizeSnapshotRecordArray(snapshot.nodes).map((node) => {
      const sourceFloor = deriveNodeSourceFloor(node);
      nodeSourceFloorById.set(node.id, sourceFloor);
      return sourceFloor == null ? node : { ...node, sourceFloor };
    });
    const edges = sanitizeSnapshotRecordArray(snapshot.edges).map((edge) => {
      const sourceFloor = deriveEdgeSourceFloor(edge, nodeSourceFloorById);
      return sourceFloor == null ? edge : { ...edge, sourceFloor };
    });
    const importResult = await this.importSnapshot({
      ...snapshot,
      nodes,
      edges,
      tombstones: sanitizeSnapshotRecordArray(snapshot.tombstones),
    }, {
      mode: "replace",
      preserveRevision: true,
      revision: normalizeRevision(options.revision ?? snapshot.meta?.revision),
      markSyncDirty: true,
    });
    return {
      migrated: true,
      skipped: false,
      reason: "migrated",
      revision: importResult.revision,
      imported: toPlainData(importResult.imported, importResult.imported),
      migrationCompletedAt: nowMs,
      migrationSource,
      legacyRetentionUntil,
    };
  }

  async exportSnapshot() {
    const snapshot = await this._loadSnapshot();
    return {
      meta: toPlainData(snapshot.meta, {}),
      nodes: toPlainData(snapshot.nodes, []),
      edges: toPlainData(snapshot.edges, []),
      tombstones: toPlainData(snapshot.tombstones, []),
      state: toPlainData(snapshot.state, {}),
    };
  }

  async importSnapshot(snapshot, options = {}) {
    return await this._runSerializedWrite("importSnapshot", async () => {
      await this._ensureV2Ready({ awaitWrites: false });
      const normalizedSnapshot = sanitizeSnapshot(snapshot);
      const mode = normalizeMode(options.mode);
      const shouldMarkSyncDirty = options.markSyncDirty !== false;
      const nowMs = Date.now();
      const currentSnapshot =
        mode === "replace" ? null : await this._loadSnapshot({ awaitWrites: false });
      const nextSnapshot =
        mode === "replace"
          ? normalizedSnapshot
          : {
              meta: {
                ...(currentSnapshot?.meta || {}),
                ...normalizedSnapshot.meta,
              },
              state: {
                ...(currentSnapshot?.state || {}),
                ...normalizedSnapshot.state,
              },
              nodes: mergeSnapshotRecords(
                currentSnapshot?.nodes || [],
                normalizedSnapshot.nodes,
              ),
              edges: mergeSnapshotRecords(
                currentSnapshot?.edges || [],
                normalizedSnapshot.edges,
              ),
              tombstones: mergeSnapshotRecords(
                currentSnapshot?.tombstones || [],
                normalizedSnapshot.tombstones,
              ),
            };
      const currentRevision = normalizeRevision(currentSnapshot?.meta?.revision);
      const incomingRevision = normalizeRevision(normalizedSnapshot.meta?.revision);
      const explicitRevision = normalizeRevision(options.revision);
      const requestedRevision = Number.isFinite(Number(options.revision))
        ? explicitRevision
        : options.preserveRevision
          ? incomingRevision
          : currentRevision + 1;
      const nextRevision = Math.max(currentRevision + 1, requestedRevision);
      nextSnapshot.meta = {
        ...nextSnapshot.meta,
        chatId: this.chatId,
        revision: nextRevision,
        lastModified: nowMs,
        lastMutationReason: "importSnapshot",
        syncDirty: shouldMarkSyncDirty,
        syncDirtyReason: shouldMarkSyncDirty ? "importSnapshot" : "",
        storagePrimary: OPFS_STORE_KIND,
        storageMode: this.storeMode,
        schemaVersion: BME_DB_SCHEMA_VERSION,
      };
      nextSnapshot.state = normalizeSnapshotState(nextSnapshot);
      nextSnapshot.meta.lastProcessedFloor = nextSnapshot.state.lastProcessedFloor;
      nextSnapshot.meta.extractionCount = nextSnapshot.state.extractionCount;
      nextSnapshot.meta.nodeCount = nextSnapshot.nodes.length;
      nextSnapshot.meta.edgeCount = nextSnapshot.edges.length;
      nextSnapshot.meta.tombstoneCount = nextSnapshot.tombstones.length;
      await this._rewriteBaseFromSnapshot(nextSnapshot, {
        headRevision: nextRevision,
        reason: "importSnapshot",
      });
      return {
        mode,
        revision: nextRevision,
        imported: {
          nodes: nextSnapshot.nodes.length,
          edges: nextSnapshot.edges.length,
          tombstones: nextSnapshot.tombstones.length,
        },
      };
    });
  }

  async clearAll() {
    return await this._runSerializedWrite("clearAll", async () => {
      const manifest = await this._ensureV2Ready({ awaitWrites: false });
      const nextRevision =
        normalizeRevision(manifest?.headRevision || manifest?.meta?.revision) + 1;
      await this._rewriteBaseFromSnapshot(
        {
          meta: {
            revision: nextRevision,
            lastModified: Date.now(),
            lastMutationReason: "clearAll",
            syncDirty: true,
            syncDirtyReason: "clearAll",
            storagePrimary: OPFS_STORE_KIND,
            storageMode: this.storeMode,
          },
          state: {
            lastProcessedFloor: META_DEFAULT_LAST_PROCESSED_FLOOR,
            extractionCount: META_DEFAULT_EXTRACTION_COUNT,
          },
          nodes: [],
          edges: [],
          tombstones: [],
        },
        {
          headRevision: nextRevision,
          reason: "clearAll",
        },
      );
      return {
        cleared: true,
        revision: nextRevision,
      };
    });
  }

  async pruneExpiredTombstones(nowMs = Date.now()) {
    const normalizedNow = normalizeTimestamp(nowMs, Date.now());
    const cutoffMs = normalizedNow - BME_TOMBSTONE_RETENTION_MS;
    const snapshot = await this._loadSnapshot();
    const nextTombstones = snapshot.tombstones.filter(
      (item) => normalizeTimestamp(item?.deletedAt, 0) >= cutoffMs,
    );
    const removedCount = snapshot.tombstones.length - nextTombstones.length;
    if (removedCount <= 0) {
      return {
        pruned: 0,
        revision: normalizeRevision(snapshot.meta?.revision),
        cutoffMs,
      };
    }
    const nextRevision = normalizeRevision(snapshot.meta?.revision) + 1;
    await this.importSnapshot(
      {
        meta: {
          ...snapshot.meta,
          revision: nextRevision,
          lastModified: normalizedNow,
          lastMutationReason: "pruneExpiredTombstones",
          syncDirty: true,
          syncDirtyReason: "pruneExpiredTombstones",
        },
        state: snapshot.state,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        tombstones: nextTombstones,
      },
      {
        mode: "replace",
        preserveRevision: true,
        revision: nextRevision,
        markSyncDirty: true,
      },
    );
    return {
      pruned: removedCount,
      revision: nextRevision,
      cutoffMs,
    };
  }

  async compactNow({ force = false, reason = "manual-compaction" } = {}) {
    return await this._runSerializedWrite("compactNow", async () => {
      const manifest = await this._ensureV2Ready({ awaitWrites: false });
      const walCount = normalizeNonNegativeInteger(manifest?.wal?.count, 0);
      const walBytes = normalizeNonNegativeInteger(manifest?.wal?.totalBytes, 0);
      if (
        !force &&
        walCount < OPFS_V2_WAL_COMPACTION_THRESHOLD &&
        walBytes < OPFS_V2_WAL_BYTES_THRESHOLD
      ) {
        return {
          compacted: false,
          skipped: true,
          reason: "below-threshold",
          revision: normalizeRevision(manifest?.headRevision || manifest?.meta?.revision),
        };
      }
      const snapshot = await this._loadSnapshot({ awaitWrites: false });
      const headRevision = normalizeRevision(snapshot.meta?.revision);
      await this._rewriteBaseFromSnapshot(snapshot, {
        headRevision,
        reason,
      });
      return {
        compacted: true,
        skipped: false,
        reason,
        revision: headRevision,
      };
    });
  }

  async _getChatDirectory() {
    if (!this._chatDirectoryPromise) {
      this._chatDirectoryPromise = (async () => {
        const rootDirectory = await this._rootDirectoryFactory();
        if (!rootDirectory || typeof rootDirectory.getDirectoryHandle !== "function") {
          throw new Error("OPFS 根目录不可用");
        }
        const opfsRoot = await ensureDirectoryHandle(
          rootDirectory,
          OPFS_ROOT_DIRECTORY_NAME,
        );
        const chatsDirectory = await ensureDirectoryHandle(
          opfsRoot,
          OPFS_CHATS_DIRECTORY_NAME,
        );
        return await ensureDirectoryHandle(
          chatsDirectory,
          buildChatDirectoryName(this.chatId),
        );
      })();
    }
    return await this._chatDirectoryPromise;
  }

  async _getMetaDirectory() {
    return await ensureDirectoryHandle(
      await this._getChatDirectory(),
      OPFS_V2_META_DIRECTORY,
    );
  }

  async _getShardDirectory(kind = "nodes") {
    return await ensureDirectoryHandle(
      await ensureDirectoryHandle(
        await this._getChatDirectory(),
        OPFS_V2_SHARDS_DIRECTORY,
      ),
      String(kind || "nodes"),
    );
  }

  async _getWalDirectory() {
    return await ensureDirectoryHandle(
      await this._getChatDirectory(),
      OPFS_V2_WAL_DIRECTORY,
    );
  }

  async _readRawManifest({ awaitWrites = true } = {}) {
    if (awaitWrites) {
      await this._awaitPendingWrites();
    }
    if (this._manifestCache) {
      return this._manifestCache;
    }
    const chatDirectory = await this._getChatDirectory();
    const manifest = await readJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, null);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return null;
    }
    this._manifestCache = manifest;
    return manifest;
  }

  async _writeManifest(manifest = {}) {
    const chatDirectory = await this._getChatDirectory();
    const nextManifest = {
      ...manifest,
      version: OPFS_MANIFEST_VERSION,
      formatVersion: OPFS_FORMAT_VERSION_V2,
      chatId: this.chatId,
      storeKind: OPFS_STORE_KIND,
      storeMode: this.storeMode,
      shardLayout: {
        nodes: OPFS_V2_NODE_BUCKET_COUNT,
        edges: OPFS_V2_EDGE_BUCKET_COUNT,
        tombstones: OPFS_V2_TOMBSTONE_BUCKET_COUNT,
        ...(manifest?.shardLayout || {}),
      },
      meta: {
        ...createDefaultMetaValues(this.chatId),
        ...(manifest?.meta || {}),
        chatId: this.chatId,
        schemaVersion: BME_DB_SCHEMA_VERSION,
        storagePrimary: OPFS_STORE_KIND,
        storageMode: this.storeMode,
      },
    };
    await writeJsonFile(chatDirectory, OPFS_MANIFEST_FILENAME, nextManifest);
    this._manifestCache = nextManifest;
    return nextManifest;
  }

  async _ensureV2Ready({ awaitWrites = true } = {}) {
    const manifest = await this._readRawManifest({ awaitWrites });
    if (isOpfsV2Manifest(manifest)) {
      return await this._writeManifest(manifest);
    }
    return await this._runSerializedWrite("ensureV2Ready", async () => {
      const latestManifest = await this._readRawManifest({ awaitWrites: false });
      if (isOpfsV2Manifest(latestManifest)) {
        return latestManifest;
      }
      const legacySnapshot = await this._tryReadLegacySnapshot(latestManifest);
      if (legacySnapshot) {
        await this._rewriteBaseFromSnapshot(legacySnapshot, {
          headRevision: normalizeRevision(legacySnapshot.meta?.revision),
          reason: "legacy-promote",
        });
        return this._manifestCache;
      }
      const emptySnapshot = {
        meta: createDefaultMetaValues(this.chatId),
        state: {
          lastProcessedFloor: META_DEFAULT_LAST_PROCESSED_FLOOR,
          extractionCount: META_DEFAULT_EXTRACTION_COUNT,
        },
        nodes: [],
        edges: [],
        tombstones: [],
      };
      await this._rewriteBaseFromSnapshot(emptySnapshot, {
        headRevision: 0,
        reason: "bootstrap",
      });
      return this._manifestCache;
    });
  }

  async _tryReadLegacySnapshot(rawManifest = null) {
    const chatDirectory = await this._getChatDirectory();
    const manifest =
      rawManifest && typeof rawManifest === "object" && !Array.isArray(rawManifest)
        ? rawManifest
        : null;
    const fileNames = await listDirectoryFileNames(chatDirectory);
    const coreCandidates = fileNames
      .map((name) => parseSnapshotFilenameCandidate(name, OPFS_CORE_FILENAME_PREFIX))
      .filter(Boolean);
    const auxCandidates = fileNames
      .map((name) => parseSnapshotFilenameCandidate(name, OPFS_AUX_FILENAME_PREFIX))
      .filter(Boolean);
    let coreFilename = String(manifest?.activeCoreFilename || "");
    let auxFilename = String(manifest?.activeAuxFilename || "");
    if (!coreFilename || !auxFilename) {
      const coreByRevision = new Map();
      const auxByRevision = new Map();
      for (const candidate of coreCandidates) {
        const current = coreByRevision.get(candidate.revision) || null;
        if (!current || candidate.stampMs > current.stampMs) {
          coreByRevision.set(candidate.revision, candidate);
        }
      }
      for (const candidate of auxCandidates) {
        const current = auxByRevision.get(candidate.revision) || null;
        if (!current || candidate.stampMs > current.stampMs) {
          auxByRevision.set(candidate.revision, candidate);
        }
      }
      const candidateRevisions = Array.from(coreByRevision.keys())
        .filter((revision) => auxByRevision.has(revision))
        .sort((left, right) => right - left);
      if (!candidateRevisions.length) {
        return null;
      }
      const latestRevision = candidateRevisions[0];
      coreFilename = coreByRevision.get(latestRevision)?.filename || "";
      auxFilename = auxByRevision.get(latestRevision)?.filename || "";
    }
    if (!coreFilename || !auxFilename) {
      return null;
    }
    const corePayload = await readJsonFile(chatDirectory, coreFilename, null);
    const auxPayload = await readJsonFile(chatDirectory, auxFilename, null);
    if (!corePayload || !auxPayload) {
      return null;
    }
    const legacyManifest = {
      version: Number.isFinite(Number(manifest?.version))
        ? Number(manifest.version)
        : OPFS_MANIFEST_VERSION,
      chatId: this.chatId,
      storeKind: OPFS_STORE_KIND,
      storeMode: this.storeMode,
      activeCoreFilename: coreFilename,
      activeAuxFilename: auxFilename,
      meta:
        manifest?.meta && typeof manifest.meta === "object" && !Array.isArray(manifest.meta)
          ? {
              ...createDefaultMetaValues(this.chatId),
              ...toPlainData(manifest.meta, {}),
            }
          : createDefaultMetaValues(this.chatId),
    };
    return buildSnapshotFromStoredParts(legacyManifest, corePayload, auxPayload);
  }

  async _readRuntimeMetaEntries() {
    const metaDirectory = await this._getMetaDirectory();
    const fileNames = await listDirectoryFileNames(metaDirectory);
    const output = {};
    for (const fileName of fileNames) {
      const key = parseOpfsV2MetaFilename(fileName);
      if (!key) continue;
      const value = await readJsonFile(metaDirectory, fileName, null);
      if (value === null && !OPFS_MANIFEST_META_KEYS.has(key)) continue;
      output[key] = value;
    }
    return output;
  }

  async _writeRuntimeMetaEntries(record = {}) {
    const metaDirectory = await this._getMetaDirectory();
    const desiredKeys = new Set();
    for (const [rawKey, value] of Object.entries(record || {})) {
      const key = normalizeRecordId(rawKey);
      if (!key || OPFS_MANIFEST_META_KEYS.has(key)) continue;
      desiredKeys.add(key);
      await writeJsonFile(metaDirectory, buildOpfsV2MetaFilename(key), value);
    }
    return desiredKeys;
  }

  async _rewriteBaseFromSnapshot(snapshot = {}, { headRevision = 0, reason = "rewrite-base" } = {}) {
    const normalizedSnapshot = sanitizeSnapshot(snapshot);
    const nowMs = Date.now();
    const nextRevision = normalizeRevision(
      headRevision || normalizedSnapshot.meta?.revision,
    );
    normalizedSnapshot.state = normalizeSnapshotState(normalizedSnapshot);
    normalizedSnapshot.meta = {
      ...createDefaultMetaValues(this.chatId, nowMs),
      ...toPlainData(normalizedSnapshot.meta, {}),
      chatId: this.chatId,
      revision: nextRevision,
      lastModified: normalizeTimestamp(normalizedSnapshot.meta?.lastModified, nowMs),
      lastMutationReason: String(
        normalizedSnapshot.meta?.lastMutationReason || reason || "rewrite-base",
      ),
      storagePrimary: OPFS_STORE_KIND,
      storageMode: this.storeMode,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      lastProcessedFloor: normalizedSnapshot.state.lastProcessedFloor,
      extractionCount: normalizedSnapshot.state.extractionCount,
      nodeCount: normalizedSnapshot.nodes.length,
      edgeCount: normalizedSnapshot.edges.length,
      tombstoneCount: normalizedSnapshot.tombstones.length,
    };
    const { manifestMeta, runtimeMeta } = splitOpfsV2SnapshotMeta(normalizedSnapshot.meta);
    const nodeDirectory = await this._getShardDirectory("nodes");
    const edgeDirectory = await this._getShardDirectory("edges");
    const tombstoneDirectory = await this._getShardDirectory("tombstones");
    const walDirectory = await this._getWalDirectory();

    const nodeBuckets = groupOpfsV2RecordsByBucket(
      normalizedSnapshot.nodes,
      OPFS_V2_NODE_BUCKET_COUNT,
    );
    const edgeBuckets = groupOpfsV2RecordsByBucket(
      normalizedSnapshot.edges,
      OPFS_V2_EDGE_BUCKET_COUNT,
    );
    const tombstoneBuckets = groupOpfsV2RecordsByBucket(
      normalizedSnapshot.tombstones,
      OPFS_V2_TOMBSTONE_BUCKET_COUNT,
    );

    for (let index = 0; index < OPFS_V2_NODE_BUCKET_COUNT; index += 1) {
      await writeJsonFile(
        nodeDirectory,
        buildOpfsV2ShardFilename("nodes", index),
        nodeBuckets.get(index) || [],
      );
    }
    for (let index = 0; index < OPFS_V2_EDGE_BUCKET_COUNT; index += 1) {
      await writeJsonFile(
        edgeDirectory,
        buildOpfsV2ShardFilename("edges", index),
        edgeBuckets.get(index) || [],
      );
    }
    for (let index = 0; index < OPFS_V2_TOMBSTONE_BUCKET_COUNT; index += 1) {
      await writeJsonFile(
        tombstoneDirectory,
        buildOpfsV2ShardFilename("tombstones", index),
        tombstoneBuckets.get(index) || [],
      );
    }

    const metaDirectory = await this._getMetaDirectory();
    const existingMetaFiles = await listDirectoryFileNames(metaDirectory);
    const runtimeMetaKeys = new Set(Object.keys(runtimeMeta));
    for (const fileName of existingMetaFiles) {
      const key = parseOpfsV2MetaFilename(fileName);
      if (!key || runtimeMetaKeys.has(key)) continue;
      await deleteFileIfExists(metaDirectory, fileName).catch(() => {});
    }
    await this._writeRuntimeMetaEntries(runtimeMeta);

    const walFiles = await listDirectoryFileNames(walDirectory);
    for (const walFile of walFiles) {
      if (!parseOpfsV2WalFilename(walFile)) continue;
      await deleteFileIfExists(walDirectory, walFile).catch(() => {});
    }

    const nextManifest = createEmptyOpfsV2Manifest(this.chatId, this.storeMode);
    nextManifest.baseRevision = nextRevision;
    nextManifest.headRevision = nextRevision;
    nextManifest.lastCompactedRevision = nextRevision;
    nextManifest.pendingLogFromRevision = nextRevision + 1;
    nextManifest.wal = {
      count: 0,
      totalBytes: 0,
    };
    nextManifest.compaction = {
      state: "idle",
      queued: false,
      lastAt: nowMs,
      lastReason: String(reason || "rewrite-base"),
    };
    nextManifest.meta = {
      ...nextManifest.meta,
      ...manifestMeta,
      revision: nextRevision,
      lastModified: normalizedSnapshot.meta.lastModified,
      lastMutationReason: String(reason || normalizedSnapshot.meta.lastMutationReason || "rewrite-base"),
      storagePrimary: OPFS_STORE_KIND,
      storageMode: this.storeMode,
      nodeCount: normalizedSnapshot.nodes.length,
      edgeCount: normalizedSnapshot.edges.length,
      tombstoneCount: normalizedSnapshot.tombstones.length,
      lastProcessedFloor: normalizedSnapshot.state.lastProcessedFloor,
      extractionCount: normalizedSnapshot.state.extractionCount,
      integrity: toPlainData(
        buildOpfsV2IntegritySummary(normalizedSnapshot),
        buildOpfsV2IntegritySummary(normalizedSnapshot),
      ),
    };
    await this._writeManifest(nextManifest);
    this._snapshotCache = {
      meta: {
        ...normalizedSnapshot.meta,
        ...runtimeMeta,
        ...nextManifest.meta,
      },
      state: toPlainData(normalizedSnapshot.state, normalizedSnapshot.state),
      nodes: toPlainData(normalizedSnapshot.nodes, normalizedSnapshot.nodes),
      edges: toPlainData(normalizedSnapshot.edges, normalizedSnapshot.edges),
      tombstones: toPlainData(normalizedSnapshot.tombstones, normalizedSnapshot.tombstones),
    };

    const chatDirectory = await this._getChatDirectory();
    const legacyFiles = await listDirectoryFileNames(chatDirectory);
    for (const legacyFile of legacyFiles) {
      if (
        parseSnapshotFilenameCandidate(legacyFile, OPFS_CORE_FILENAME_PREFIX) ||
        parseSnapshotFilenameCandidate(legacyFile, OPFS_AUX_FILENAME_PREFIX)
      ) {
        await deleteFileIfExists(chatDirectory, legacyFile).catch(() => {});
      }
    }
  }

  async _readShardRecords(kind = "nodes", bucketIndex = 0) {
    const shardDirectory = await this._getShardDirectory(kind);
    return sanitizeSnapshotRecordArray(
      await readJsonFile(
        shardDirectory,
        buildOpfsV2ShardFilename(kind, bucketIndex),
        [],
      ),
    );
  }

  async _readWalRecords(manifest = null) {
    const normalizedManifest = manifest || (await this._ensureV2Ready());
    const walDirectory = await this._getWalDirectory();
    const walFiles = (await listDirectoryFileNames(walDirectory))
      .map((name) => parseOpfsV2WalFilename(name))
      .filter(Boolean)
      .sort((left, right) => left.revision - right.revision);
    const pendingFromRevision = normalizeRevision(
      normalizedManifest?.pendingLogFromRevision,
    );
    const headRevision = normalizeRevision(
      normalizedManifest?.headRevision || normalizedManifest?.meta?.revision,
    );
    const filtered = walFiles.filter(
      (entry) =>
        entry.revision >= pendingFromRevision && entry.revision <= headRevision,
    );
    if (filtered.length > 0) {
      let expectedRevision = pendingFromRevision;
      for (const entry of filtered) {
        if (entry.revision !== expectedRevision) {
          throw new Error("opfs-v2-wal-gap");
        }
        expectedRevision += 1;
      }
      if (expectedRevision - 1 !== headRevision) {
        throw new Error("opfs-v2-wal-tail-mismatch");
      }
    } else if (pendingFromRevision <= headRevision) {
      throw new Error("opfs-v2-wal-missing");
    }
    const records = [];
    for (const entry of filtered) {
      const record = await readJsonFile(walDirectory, entry.filename, null);
      if (!record) {
        throw new Error("opfs-v2-wal-missing-record");
      }
      records.push({
        ...record,
        revision: entry.revision,
        byteLength: JSON.stringify(record).length,
      });
    }
    return records;
  }

  async _loadBaseSnapshotFromV2(manifest = null) {
    const normalizedManifest = manifest || (await this._ensureV2Ready());
    const runtimeMeta = await this._readRuntimeMetaEntries();
    const nodes = [];
    const edges = [];
    const tombstones = [];
    for (let index = 0; index < OPFS_V2_NODE_BUCKET_COUNT; index += 1) {
      nodes.push(...(await this._readShardRecords("nodes", index)));
    }
    for (let index = 0; index < OPFS_V2_EDGE_BUCKET_COUNT; index += 1) {
      edges.push(...(await this._readShardRecords("edges", index)));
    }
    for (let index = 0; index < OPFS_V2_TOMBSTONE_BUCKET_COUNT; index += 1) {
      tombstones.push(...(await this._readShardRecords("tombstones", index)));
    }
    const meta = {
      ...createDefaultMetaValues(this.chatId),
      ...(normalizedManifest?.meta || {}),
      ...runtimeMeta,
      chatId: this.chatId,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      storagePrimary: OPFS_STORE_KIND,
      storageMode: this.storeMode,
      nodeCount: normalizeNonNegativeInteger(normalizedManifest?.meta?.nodeCount, nodes.length),
      edgeCount: normalizeNonNegativeInteger(normalizedManifest?.meta?.edgeCount, edges.length),
      tombstoneCount: normalizeNonNegativeInteger(
        normalizedManifest?.meta?.tombstoneCount,
        tombstones.length,
      ),
    };
    const snapshot = {
      meta,
      state: normalizeSnapshotState({
        meta,
        state: {
          lastProcessedFloor: meta.lastProcessedFloor,
          extractionCount: meta.extractionCount,
        },
      }),
      nodes,
      edges,
      tombstones,
    };
    snapshot.meta.lastProcessedFloor = snapshot.state.lastProcessedFloor;
    snapshot.meta.extractionCount = snapshot.state.extractionCount;
    return snapshot;
  }

  async _loadSnapshot({ awaitWrites = true } = {}) {
    if (awaitWrites) {
      await this._awaitPendingWrites();
    }
    const manifest = await this._ensureV2Ready({ awaitWrites: false });
    const headRevision = normalizeRevision(
      manifest?.headRevision || manifest?.meta?.revision,
    );
    if (this._snapshotCache && normalizeRevision(this._snapshotCache.meta?.revision) === headRevision) {
      return this._snapshotCache;
    }
    const snapshot = await this._loadBaseSnapshotFromV2(manifest);
    const walRecords = await this._readWalRecords(manifest);
    for (const walRecord of walRecords) {
      const nextSnapshot = applyOpfsV2DeltaToSnapshot(snapshot, walRecord.delta, walRecord.committedAt);
      nextSnapshot.meta = {
        ...nextSnapshot.meta,
        revision: normalizeRevision(walRecord.revision),
        lastModified: normalizeTimestamp(walRecord.committedAt, Date.now()),
        lastMutationReason: String(walRecord.reason || "commitDelta"),
      };
      nextSnapshot.state = normalizeSnapshotState(nextSnapshot);
      snapshot.meta = nextSnapshot.meta;
      snapshot.state = nextSnapshot.state;
      snapshot.nodes = nextSnapshot.nodes;
      snapshot.edges = nextSnapshot.edges;
      snapshot.tombstones = nextSnapshot.tombstones;
    }
    snapshot.meta = {
      ...snapshot.meta,
      ...(manifest?.meta || {}),
      revision: headRevision,
      nodeCount: normalizeNonNegativeInteger(manifest?.meta?.nodeCount, snapshot.nodes.length),
      edgeCount: normalizeNonNegativeInteger(manifest?.meta?.edgeCount, snapshot.edges.length),
      tombstoneCount: normalizeNonNegativeInteger(
        manifest?.meta?.tombstoneCount,
        snapshot.tombstones.length,
      ),
      storagePrimary: OPFS_STORE_KIND,
      storageMode: this.storeMode,
    };
    snapshot.state = normalizeSnapshotState(snapshot);
    snapshot.meta.lastProcessedFloor = snapshot.state.lastProcessedFloor;
    snapshot.meta.extractionCount = snapshot.state.extractionCount;
    this._snapshotCache = snapshot;
    return snapshot;
  }

  _maybeScheduleCompaction(manifest = null, reason = "commitDelta") {
    if (this._compactionScheduled) return;
    const walCount = normalizeNonNegativeInteger(manifest?.wal?.count, 0);
    const walBytes = normalizeNonNegativeInteger(manifest?.wal?.totalBytes, 0);
    if (
      walCount < OPFS_V2_WAL_COMPACTION_THRESHOLD &&
      walBytes < OPFS_V2_WAL_BYTES_THRESHOLD
    ) {
      return;
    }
    this._compactionScheduled = true;
    const scheduler =
      typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
        : (callback) => setTimeout(callback, 0);
    scheduler(() => {
      this.compactNow({
        force: false,
        reason: `auto:${String(reason || "commitDelta")}`,
      })
        .catch(() => {})
        .finally(() => {
          this._compactionScheduled = false;
        });
    });
  }
}
