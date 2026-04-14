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
const OPFS_CORE_FILENAME_PREFIX = "core.snapshot";
const OPFS_AUX_FILENAME_PREFIX = "aux.snapshot";
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

export class OpfsGraphStore {
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
