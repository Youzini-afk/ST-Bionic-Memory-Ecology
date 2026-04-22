import { createEmptyGraph, deserializeGraph } from "../graph/graph.js";
import {
  buildVectorCollectionId,
  normalizeGraphRuntimeState,
} from "../runtime/runtime-state.js";

const DEXIE_LOAD_PROMISE_KEY = "__stBmeDexieLoadPromise";
const DEXIE_SCRIPT_MARKER = "data-st-bme-dexie";
const DEXIE_SCRIPT_SOURCE = "../lib/dexie.min.js";

const META_DEFAULT_LAST_PROCESSED_FLOOR = -1;
const META_DEFAULT_EXTRACTION_COUNT = 0;

export const BME_DB_SCHEMA_VERSION = 1;
export const BME_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const BME_LEGACY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_PERSIST_NATIVE_DELTA_THRESHOLD_RECORDS = 20000;
const DEFAULT_PERSIST_NATIVE_DELTA_THRESHOLD_STRUCTURAL_DELTA = 600;
const DEFAULT_PERSIST_NATIVE_DELTA_THRESHOLD_SERIALIZED_CHARS = 4000000;
const DEFAULT_PERSIST_NATIVE_DELTA_BRIDGE_MODE = "json";
const DEFAULT_NATIVE_HYDRATE_THRESHOLD_RECORDS = 30000;
const SUPPORTED_PERSIST_NATIVE_DELTA_BRIDGE_MODES = new Set(["json", "hash"]);
const PERSIST_RECORD_SERIALIZATION_CACHE_LIMIT = 50000;

const persistRecordSerializationCacheByObject = new WeakMap();
const persistRecordSerializationCacheByToken = new Map();
let persistRecordSerializationCacheEpoch = 1;
const persistPreparedRecordSetCacheByArray = new WeakMap();
let persistPreparedRecordSetCacheEpoch = 1;

export const BME_RUNTIME_HISTORY_META_KEY = "runtimeHistoryState";
export const BME_RUNTIME_VECTOR_META_KEY = "runtimeVectorIndexState";
export const BME_RUNTIME_BATCH_JOURNAL_META_KEY = "runtimeBatchJournal";
export const BME_RUNTIME_LAST_RECALL_META_KEY = "runtimeLastRecallResult";
export const BME_RUNTIME_SUMMARY_STATE_META_KEY = "runtimeSummaryState";
export const BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY = "maintenanceJournal";
export const BME_RUNTIME_KNOWLEDGE_STATE_META_KEY = "knowledgeState";
export const BME_RUNTIME_REGION_STATE_META_KEY = "regionState";
export const BME_RUNTIME_TIMELINE_STATE_META_KEY = "timelineState";
export const BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY =
  "runtimeLastProcessedSeq";
export const BME_RUNTIME_GRAPH_VERSION_META_KEY = "runtimeGraphVersion";
export const BME_RUNTIME_RECORDS_NORMALIZED_META_KEY =
  "runtimeRecordsNormalized";

export const BME_DB_TABLE_SCHEMAS = Object.freeze({
  nodes:
    "&id, type, sourceFloor, archived, updatedAt, deletedAt, isEmbedded, parentId, prevId, nextId",
  edges:
    "&id, fromId, toId, [fromId+toId], relation, sourceFloor, updatedAt, deletedAt",
  meta: "&key, updatedAt",
  tombstones: "&id, kind, targetId, deletedAt, sourceDeviceId, [kind+targetId]",
});

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
  };
}

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

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }
  return Math.max(0, Math.floor(parsed));
}

function readPersistCommitNow() {
  if (typeof performance === "object" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function normalizePersistCommitMs(value = 0) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function estimatePersistPayloadBytes(value = null) {
  if (value == null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function tryBuildNativeHydrateRecords(snapshotView, options = {}) {
  if (options?.useNativeHydrate !== true) {
    return {
      rawResult: null,
      status: "not-requested",
      error: "",
    };
  }
  const nativeBuilder = globalThis.__stBmeNativeHydrateSnapshotRecords;
  if (typeof nativeBuilder !== "function") {
    if (options?.nativeFailOpen === false) {
      throw new Error("native-hydrate-builder-unavailable");
    }
    return {
      rawResult: null,
      status: "builder-unavailable",
      error: "native-hydrate-builder-unavailable",
    };
  }

  try {
    return {
      rawResult: nativeBuilder(
        {
          nodes: toArray(snapshotView?.nodes),
          edges: toArray(snapshotView?.edges),
        },
        {
          recordsNormalized: options?.recordsNormalized === true,
        },
      ),
      status: "ok",
      error: "",
    };
  } catch (error) {
    if (options?.nativeFailOpen === false) {
      throw error;
    }
    return {
      rawResult: null,
      status: "builder-error",
      error: error?.message || String(error),
    };
  }
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

function cloneHydrateSnapshotNestedValue(value, fallbackValue = null) {
  if (value == null || typeof value !== "object") {
    return value == null ? fallbackValue : value;
  }
  if (Array.isArray(value)) {
    const output = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      output[index] =
        entry != null && typeof entry === "object"
          ? cloneHydrateSnapshotNestedValue(entry, entry)
          : entry;
    }
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return toPlainData(value, fallbackValue ?? value);
  }
  const output = {};
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const entry = value[key];
    output[key] =
      entry != null && typeof entry === "object"
        ? cloneHydrateSnapshotNestedValue(entry, entry)
        : entry;
  }
  return output;
}

function cloneHydrateSnapshotMemoryScope(scope = null) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return cloneHydrateSnapshotNestedValue(scope, scope);
  }
  return {
    ...scope,
    regionPath: Array.isArray(scope.regionPath) ? [...scope.regionPath] : [],
    regionSecondary: Array.isArray(scope.regionSecondary)
      ? [...scope.regionSecondary]
      : [],
  };
}

function cloneHydrateSnapshotStoryTime(storyTime = null) {
  if (!storyTime || typeof storyTime !== "object" || Array.isArray(storyTime)) {
    return cloneHydrateSnapshotNestedValue(storyTime, storyTime);
  }
  return {
    ...storyTime,
  };
}

function cloneHydrateSnapshotStoryTimeSpan(storyTimeSpan = null) {
  if (
    !storyTimeSpan ||
    typeof storyTimeSpan !== "object" ||
    Array.isArray(storyTimeSpan)
  ) {
    return cloneHydrateSnapshotNestedValue(storyTimeSpan, storyTimeSpan);
  }
  return {
    ...storyTimeSpan,
  };
}

function cloneHydrateSnapshotNodeRecord(record = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const cloned = {};
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    switch (key) {
      case "fields":
        cloned.fields = cloneHydrateSnapshotNestedValue(value, {});
        break;
      case "seqRange":
        cloned.seqRange = Array.isArray(value)
          ? value.slice()
          : cloneHydrateSnapshotNestedValue(value, value);
        break;
      case "childIds":
        cloned.childIds = Array.isArray(value)
          ? value.slice()
          : cloneHydrateSnapshotNestedValue(value, value);
        break;
      case "clusters":
        cloned.clusters = Array.isArray(value)
          ? value.slice()
          : cloneHydrateSnapshotNestedValue(value, value);
        break;
      case "scope":
        cloned.scope = cloneHydrateSnapshotMemoryScope(value);
        break;
      case "storyTime":
        cloned.storyTime = cloneHydrateSnapshotStoryTime(value);
        break;
      case "storyTimeSpan":
        cloned.storyTimeSpan = cloneHydrateSnapshotStoryTimeSpan(value);
        break;
      default:
        cloned[key] =
          value != null && typeof value === "object"
            ? cloneHydrateSnapshotNestedValue(value, value)
            : value;
        break;
    }
  }
  return cloned;
}

function cloneHydrateSnapshotEdgeRecord(record = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const cloned = {};
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (key === "scope") {
      cloned.scope = cloneHydrateSnapshotMemoryScope(value);
      continue;
    }
    cloned[key] =
      value != null && typeof value === "object"
        ? cloneHydrateSnapshotNestedValue(value, value)
        : value;
  }
  return cloned;
}

function cloneHydrateSnapshotNodeRecords(records = []) {
  const sourceRecords = toArray(records);
  if (sourceRecords.length === 0) return [];
  const output = new Array(sourceRecords.length);
  let writeIndex = 0;
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const cloned = cloneHydrateSnapshotNodeRecord(sourceRecords[index]);
    if (!cloned) continue;
    output[writeIndex] = cloned;
    writeIndex += 1;
  }
  output.length = writeIndex;
  return output;
}

function hasSharedHydrateRecordReferences(records = [], sourceRecords = []) {
  const normalizedSourceRecords = toArray(sourceRecords);
  if (!normalizedSourceRecords.length || !Array.isArray(records) || !records.length) {
    return false;
  }
  const sourceRecordSet = new WeakSet();
  for (let index = 0; index < normalizedSourceRecords.length; index += 1) {
    const record = normalizedSourceRecords[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    sourceRecordSet.add(record);
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (sourceRecordSet.has(record)) {
      return true;
    }
  }
  return false;
}

function normalizeNativeHydrateRecordArray(records = []) {
  const sourceRecords = toArray(records);
  if (sourceRecords.length === 0) return [];
  const output = new Array(sourceRecords.length);
  let writeIndex = 0;
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const record = sourceRecords[index];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    output[writeIndex] = record;
    writeIndex += 1;
  }
  output.length = writeIndex;
  return output;
}

function normalizeNativeHydrateResult(rawResult = null, snapshotView = {}) {
  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
    return null;
  }
  if (
    rawResult.nodes === snapshotView?.nodes ||
    rawResult.edges === snapshotView?.edges
  ) {
    return null;
  }
  const nodes = normalizeNativeHydrateRecordArray(rawResult.nodes);
  const edges = normalizeNativeHydrateRecordArray(rawResult.edges);
  if (
    hasSharedHydrateRecordReferences(nodes, snapshotView?.nodes) ||
    hasSharedHydrateRecordReferences(edges, snapshotView?.edges)
  ) {
    return null;
  }
  return {
    nodes,
    edges,
    diagnostics:
      rawResult.diagnostics &&
      typeof rawResult.diagnostics === "object" &&
      !Array.isArray(rawResult.diagnostics)
        ? rawResult.diagnostics
        : null,
  };
}

function cloneHydrateSnapshotEdgeRecords(records = []) {
  const sourceRecords = toArray(records);
  if (sourceRecords.length === 0) return [];
  const output = new Array(sourceRecords.length);
  let writeIndex = 0;
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const cloned = cloneHydrateSnapshotEdgeRecord(sourceRecords[index]);
    if (!cloned) continue;
    output[writeIndex] = cloned;
    writeIndex += 1;
  }
  output.length = writeIndex;
  return output;
}

function toMetaMap(rows = []) {
  const output = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = normalizeRecordId(row.key);
    if (!key) continue;
    output[key] = row.value;
  }
  return output;
}

function normalizeMode(mode = "replace") {
  return String(mode || "").toLowerCase() === "merge" ? "merge" : "replace";
}

const BME_PERSIST_META_RESERVED_KEYS = new Set([
  "revision",
  "lastModified",
  "nodeCount",
  "edgeCount",
  "tombstoneCount",
  "syncDirty",
  "syncDirtyReason",
  "lastMutationReason",
]);

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

  const safeMeta =
    snapshot.meta &&
    typeof snapshot.meta === "object" &&
    !Array.isArray(snapshot.meta)
      ? { ...snapshot.meta }
      : {};
  const safeState =
    snapshot.state &&
    typeof snapshot.state === "object" &&
    !Array.isArray(snapshot.state)
      ? { ...snapshot.state }
      : {};

  return {
    meta: safeMeta,
    state: safeState,
    nodes: toArray(snapshot.nodes).map((item) => ({ ...(item || {}) })),
    edges: toArray(snapshot.edges).map((item) => ({ ...(item || {}) })),
    tombstones: toArray(snapshot.tombstones).map((item) => ({
      ...(item || {}),
    })),
  };
}

function normalizePersistSnapshotView(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      meta: {},
      state: {},
      nodes: [],
      edges: [],
      tombstones: [],
    };
  }

  const hasExplicitMeta =
    snapshot.meta &&
    typeof snapshot.meta === "object" &&
    !Array.isArray(snapshot.meta);
  const hasExplicitState =
    snapshot.state &&
    typeof snapshot.state === "object" &&
    !Array.isArray(snapshot.state);
  const shouldDeriveFromRuntimeGraph =
    !hasExplicitMeta &&
    !hasExplicitState &&
    (Object.prototype.hasOwnProperty.call(snapshot, "historyState") ||
      Object.prototype.hasOwnProperty.call(snapshot, "vectorIndexState") ||
      Object.prototype.hasOwnProperty.call(snapshot, "batchJournal") ||
      Object.prototype.hasOwnProperty.call(snapshot, "maintenanceJournal") ||
      Object.prototype.hasOwnProperty.call(snapshot, "summaryState") ||
      Object.prototype.hasOwnProperty.call(snapshot, "knowledgeState") ||
      Object.prototype.hasOwnProperty.call(snapshot, "regionState") ||
      Object.prototype.hasOwnProperty.call(snapshot, "timelineState") ||
      Object.prototype.hasOwnProperty.call(snapshot, "lastRecallResult") ||
      Object.prototype.hasOwnProperty.call(snapshot, "lastProcessedSeq"));
  const derivedRuntimeSnapshot = shouldDeriveFromRuntimeGraph
    ? buildSnapshotFromGraph(snapshot, {
        chatId: normalizeChatId(snapshot?.historyState?.chatId || ""),
      })
    : null;

  return {
    meta: hasExplicitMeta
      ? snapshot.meta
      : derivedRuntimeSnapshot?.meta &&
          typeof derivedRuntimeSnapshot.meta === "object" &&
          !Array.isArray(derivedRuntimeSnapshot.meta)
        ? derivedRuntimeSnapshot.meta
        : {},
    state: hasExplicitState
      ? snapshot.state
      : derivedRuntimeSnapshot?.state &&
          typeof derivedRuntimeSnapshot.state === "object" &&
          !Array.isArray(derivedRuntimeSnapshot.state)
        ? derivedRuntimeSnapshot.state
        : {},
    nodes: toArray(snapshot.nodes),
    edges: toArray(snapshot.edges),
    tombstones: toArray(snapshot.tombstones),
  };
}

function normalizePersistNativeDeltaThreshold(value, fallbackValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  return Math.max(0, Math.floor(parsed));
}

function countPersistSnapshotRecords(snapshot = {}) {
  return (
    toArray(snapshot?.nodes).length +
    toArray(snapshot?.edges).length +
    toArray(snapshot?.tombstones).length
  );
}

function countHydrateSnapshotRecords(snapshot = {}) {
  return toArray(snapshot?.nodes).length + toArray(snapshot?.edges).length;
}

export function resolveNativeHydrateGateOptions(options = {}) {
  return {
    minSnapshotRecords: normalizePersistNativeDeltaThreshold(
      options?.loadNativeHydrateThresholdRecords ??
        options?.hydrateNativeThresholdRecords ??
        options?.minSnapshotRecords,
      DEFAULT_NATIVE_HYDRATE_THRESHOLD_RECORDS,
    ),
  };
}

export function evaluateNativeHydrateGate(snapshot, options = {}) {
  const normalizedSnapshot = normalizePersistSnapshotView(snapshot);
  const gateOptions = resolveNativeHydrateGateOptions(options);
  const recordCount = countHydrateSnapshotRecords(normalizedSnapshot);
  const reasons = [];
  if (
    gateOptions.minSnapshotRecords > 0 &&
    recordCount < gateOptions.minSnapshotRecords
  ) {
    reasons.push("below-min-snapshot-records");
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    minSnapshotRecords: gateOptions.minSnapshotRecords,
    recordCount,
  };
}

function countPersistSnapshotStructuralDelta(beforeSnapshot = {}, afterSnapshot = {}) {
  return (
    Math.abs(toArray(afterSnapshot?.nodes).length - toArray(beforeSnapshot?.nodes).length) +
    Math.abs(toArray(afterSnapshot?.edges).length - toArray(beforeSnapshot?.edges).length) +
    Math.abs(
      toArray(afterSnapshot?.tombstones).length -
        toArray(beforeSnapshot?.tombstones).length,
    )
  );
}

export function resolvePersistNativeDeltaGateOptions(options = {}) {
  return {
    minSnapshotRecords: normalizePersistNativeDeltaThreshold(
      options?.persistNativeDeltaThresholdRecords ?? options?.minSnapshotRecords,
      DEFAULT_PERSIST_NATIVE_DELTA_THRESHOLD_RECORDS,
    ),
    minStructuralDelta: normalizePersistNativeDeltaThreshold(
      options?.persistNativeDeltaThresholdStructuralDelta ??
        options?.minStructuralDelta,
      DEFAULT_PERSIST_NATIVE_DELTA_THRESHOLD_STRUCTURAL_DELTA,
    ),
    minCombinedSerializedChars: normalizePersistNativeDeltaThreshold(
      options?.persistNativeDeltaThresholdSerializedChars ??
        options?.minCombinedSerializedChars,
      DEFAULT_PERSIST_NATIVE_DELTA_THRESHOLD_SERIALIZED_CHARS,
    ),
  };
}

export function resolvePersistNativeDeltaBridgeMode(options = {}) {
  const rawMode = String(
    options?.persistNativeDeltaBridgeMode ??
      options?.nativeDeltaBridgeMode ??
      DEFAULT_PERSIST_NATIVE_DELTA_BRIDGE_MODE,
  )
    .trim()
    .toLowerCase();
  if (!rawMode) return DEFAULT_PERSIST_NATIVE_DELTA_BRIDGE_MODE;
  return SUPPORTED_PERSIST_NATIVE_DELTA_BRIDGE_MODES.has(rawMode)
    ? rawMode
    : DEFAULT_PERSIST_NATIVE_DELTA_BRIDGE_MODE;
}

export function evaluatePersistNativeDeltaGate(
  beforeSnapshot,
  afterSnapshot,
  options = {},
) {
  const gate = resolvePersistNativeDeltaGateOptions(options);
  const beforeRecordCount = countPersistSnapshotRecords(beforeSnapshot);
  const afterRecordCount = countPersistSnapshotRecords(afterSnapshot);
  const maxSnapshotRecords = Math.max(beforeRecordCount, afterRecordCount);
  const measuredCombinedSerializedChars = Number.isFinite(
    Number(options?.measuredCombinedSerializedChars ?? options?.combinedSerializedChars),
  )
    ? Math.max(
        0,
        Math.floor(
          Number(
            options?.measuredCombinedSerializedChars ??
              options?.combinedSerializedChars,
          ),
        ),
      )
    : null;
  const structuralDelta = countPersistSnapshotStructuralDelta(
    beforeSnapshot,
    afterSnapshot,
  );
  const reasons = [];

  if (
    gate.minSnapshotRecords > 0 &&
    maxSnapshotRecords < gate.minSnapshotRecords
  ) {
    reasons.push("below-record-threshold");
  }
  if (gate.minStructuralDelta > 0 && structuralDelta < gate.minStructuralDelta) {
    reasons.push("below-structural-delta-threshold");
  }
  if (
    gate.minCombinedSerializedChars > 0 &&
    measuredCombinedSerializedChars != null &&
    measuredCombinedSerializedChars < gate.minCombinedSerializedChars
  ) {
    reasons.push("below-serialized-chars-threshold");
  }

  return {
    allowed: reasons.length === 0,
    beforeRecordCount,
    afterRecordCount,
    maxSnapshotRecords,
    combinedSerializedChars: measuredCombinedSerializedChars,
    structuralDelta,
    minSnapshotRecords: gate.minSnapshotRecords,
    minStructuralDelta: gate.minStructuralDelta,
    minCombinedSerializedChars: gate.minCombinedSerializedChars,
    reasons,
  };
}

export function shouldUseNativePersistDeltaForSnapshots(
  beforeSnapshot,
  afterSnapshot,
  options = {},
) {
  return evaluatePersistNativeDeltaGate(beforeSnapshot, afterSnapshot, options).allowed;
}

function normalizeStateSnapshot(snapshot = {}) {
  const state =
    snapshot?.state &&
    typeof snapshot.state === "object" &&
    !Array.isArray(snapshot.state)
      ? { ...snapshot.state }
      : {};

  return {
    lastProcessedFloor: Number.isFinite(Number(state.lastProcessedFloor))
      ? Number(state.lastProcessedFloor)
      : META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: Number.isFinite(Number(state.extractionCount))
      ? Number(state.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT,
  };
}

function normalizeNodeUpdatedAt(node = {}, fallbackNowMs = Date.now()) {
  return normalizeTimestamp(
    node.updatedAt ?? node.lastAccessTime ?? node.createdTime,
    fallbackNowMs,
  );
}

function normalizeEdgeUpdatedAt(edge = {}, fallbackNowMs = Date.now()) {
  return normalizeTimestamp(
    edge.updatedAt ?? edge.invalidAt ?? edge.expiredAt ?? edge.validAt ?? edge.createdTime,
    fallbackNowMs,
  );
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

function clonePersistGraphInputRecord(record = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  return {
    ...record,
  };
}

function buildPersistSnapshotGraphInput(graph = null, chatId = "") {
  const sourceGraph =
    graph && typeof graph === "object" && !Array.isArray(graph)
      ? graph
      : createEmptyGraph();
  const graphInput = {
    ...sourceGraph,
    historyState:
      sourceGraph.historyState &&
      typeof sourceGraph.historyState === "object" &&
      !Array.isArray(sourceGraph.historyState)
        ? { ...sourceGraph.historyState }
        : {},
    vectorIndexState:
      sourceGraph.vectorIndexState &&
      typeof sourceGraph.vectorIndexState === "object" &&
      !Array.isArray(sourceGraph.vectorIndexState)
        ? { ...sourceGraph.vectorIndexState }
        : {},
    nodes: toArray(sourceGraph.nodes)
      .map((node) => clonePersistGraphInputRecord(node))
      .filter(Boolean),
    edges: toArray(sourceGraph.edges)
      .map((edge) => clonePersistGraphInputRecord(edge))
      .filter(Boolean),
    batchJournal: Array.isArray(sourceGraph.batchJournal)
      ? [...sourceGraph.batchJournal]
      : sourceGraph.batchJournal,
    maintenanceJournal: Array.isArray(sourceGraph.maintenanceJournal)
      ? [...sourceGraph.maintenanceJournal]
      : sourceGraph.maintenanceJournal,
  };
  if (chatId) {
    graphInput.historyState.chatId = chatId;
  }
  return graphInput;
}

function buildPersistSnapshotRecordByIdMap(records = []) {
  const map = new Map();
  for (const record of toArray(records)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const id = normalizeRecordId(record.id);
    if (!id || map.has(id)) continue;
    map.set(id, record);
  }
  return map;
}

function clonePersistSnapshotRecord(record = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(record));
  } catch {
    if (typeof globalThis.structuredClone === "function") {
      try {
        return globalThis.structuredClone(record);
      } catch {
        // no-op
      }
    }
    return null;
  }
}

function normalizeComparablePersistNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasReusablePersistNodeRecord(baseRecord, runtimeRecord, normalized = {}) {
  if (!baseRecord || !runtimeRecord) return false;
  const normalizedType = normalizeRecordId(normalized.type ?? runtimeRecord.type);
  if (normalizeRecordId(baseRecord.type) !== normalizedType) return false;
  if (Boolean(baseRecord.archived) !== Boolean(runtimeRecord.archived)) return false;
  if (
    normalizeComparablePersistNumber(baseRecord.updatedAt) !==
    normalizeComparablePersistNumber(normalized.updatedAt)
  ) {
    return false;
  }
  if (
    normalizeComparablePersistNumber(baseRecord.seq) !==
    normalizeComparablePersistNumber(runtimeRecord.seq)
  ) {
    return false;
  }
  if (normalizeRecordId(baseRecord.parentId) !== normalizeRecordId(runtimeRecord.parentId)) {
    return false;
  }
  if (normalizeRecordId(baseRecord.prevId) !== normalizeRecordId(runtimeRecord.prevId)) {
    return false;
  }
  if (normalizeRecordId(baseRecord.nextId) !== normalizeRecordId(runtimeRecord.nextId)) {
    return false;
  }
  return true;
}

function hasReusablePersistEdgeRecord(baseRecord, runtimeRecord, normalized = {}) {
  if (!baseRecord || !runtimeRecord) return false;
  if (normalizeRecordId(baseRecord.fromId) !== normalizeRecordId(normalized.fromId)) {
    return false;
  }
  if (normalizeRecordId(baseRecord.toId) !== normalizeRecordId(normalized.toId)) {
    return false;
  }
  if (normalizeRecordId(baseRecord.relation) !== normalizeRecordId(runtimeRecord.relation)) {
    return false;
  }
  if (
    normalizeComparablePersistNumber(baseRecord.updatedAt) !==
    normalizeComparablePersistNumber(normalized.updatedAt)
  ) {
    return false;
  }
  if (
    normalizeComparablePersistNumber(baseRecord.invalidAt) !==
    normalizeComparablePersistNumber(runtimeRecord.invalidAt)
  ) {
    return false;
  }
  if (
    normalizeComparablePersistNumber(baseRecord.expiredAt) !==
    normalizeComparablePersistNumber(runtimeRecord.expiredAt)
  ) {
    return false;
  }
  return true;
}

function hasReusablePersistTombstoneRecord(baseRecord, normalized = {}) {
  if (!baseRecord) return false;
  if (normalizeRecordId(baseRecord.kind) !== normalizeRecordId(normalized.kind)) {
    return false;
  }
  if (normalizeRecordId(baseRecord.targetId) !== normalizeRecordId(normalized.targetId)) {
    return false;
  }
  if (
    normalizeRecordId(baseRecord.sourceDeviceId) !==
    normalizeRecordId(normalized.sourceDeviceId)
  ) {
    return false;
  }
  if (
    normalizeComparablePersistNumber(baseRecord.deletedAt) !==
    normalizeComparablePersistNumber(normalized.deletedAt)
  ) {
    return false;
  }
  return true;
}

export function buildSnapshotFromGraph(graph, options = {}) {
  const baseSnapshotInput =
    options?.baseSnapshot &&
    typeof options.baseSnapshot === "object" &&
    !Array.isArray(options.baseSnapshot)
      ? options.baseSnapshot
      : {};
  const shouldCollectDiagnostics = typeof options?.onDiagnostics === "function";
  const snapshotStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const snapshotDiagnostics = shouldCollectDiagnostics
    ? {
        nodeCount: 0,
        edgeCount: 0,
        tombstoneCount: 0,
        reusedNodeCount: 0,
        reusedEdgeCount: 0,
        reusedTombstoneCount: 0,
        clonedNodeCount: 0,
        clonedEdgeCount: 0,
        clonedTombstoneCount: 0,
        nodesMs: 0,
        edgesMs: 0,
        tombstonesMs: 0,
        stateMs: 0,
        metaMs: 0,
      }
    : null;
  const baseSnapshot = sanitizeSnapshot(baseSnapshotInput);
  const baseSnapshotView = normalizePersistSnapshotView(baseSnapshotInput);
  const nowMs = normalizeTimestamp(options.nowMs, Date.now());
  const chatId =
    normalizeChatId(options.chatId) ||
    normalizeChatId(graph?.historyState?.chatId) ||
    normalizeChatId(baseSnapshot.meta?.chatId);

  const graphInput = buildPersistSnapshotGraphInput(graph, chatId);
  const legacyActiveOwnerKey = String(
    graphInput?.knowledgeState?.activeOwnerKey || "",
  ).trim();
  const legacyActiveRegion = String(
    graphInput?.regionState?.activeRegion || "",
  ).trim();
  const legacyActiveSegmentId = String(
    graphInput?.timelineState?.activeSegmentId || "",
  ).trim();
  graphInput.vectorIndexState.collectionId = buildVectorCollectionId(
    chatId || graphInput.historyState.chatId || "",
  );
  const runtimeGraph = normalizeGraphRuntimeState(graphInput, chatId);
  const baseNodeById = buildPersistSnapshotRecordByIdMap(baseSnapshotView.nodes);
  const baseEdgeById = buildPersistSnapshotRecordByIdMap(baseSnapshotView.edges);
  const baseTombstoneById = buildPersistSnapshotRecordByIdMap(
    baseSnapshotView.tombstones,
  );

  const nodesStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const nodes = toArray(runtimeGraph?.nodes)
    .map((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return null;
      }
      const id = normalizeRecordId(node.id);
      if (!id) return null;
      const normalizedUpdatedAt = normalizeNodeUpdatedAt(node, nowMs);
      const baseNode = baseNodeById.get(id);
      if (
        hasReusablePersistNodeRecord(baseNode, node, {
          type: node.type,
          updatedAt: normalizedUpdatedAt,
        })
      ) {
        if (snapshotDiagnostics) {
          snapshotDiagnostics.reusedNodeCount += 1;
        }
        return baseNode;
      }
      const plainNode = clonePersistSnapshotRecord(node);
      if (!plainNode || typeof plainNode !== "object" || Array.isArray(plainNode)) {
        return null;
      }
      if (snapshotDiagnostics) {
        snapshotDiagnostics.clonedNodeCount += 1;
      }
      plainNode.id = id;
      plainNode.updatedAt = normalizedUpdatedAt;
      return plainNode;
    })
    .filter(Boolean);
  if (snapshotDiagnostics) {
    snapshotDiagnostics.nodeCount = nodes.length;
    snapshotDiagnostics.nodesMs = readPersistDeltaNow() - nodesStartedAt;
  }

  const edgesStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const edges = toArray(runtimeGraph?.edges)
    .map((edge) => {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
        return null;
      }
      const id = normalizeRecordId(edge.id);
      if (!id) return null;
      const normalizedFromId = normalizeRecordId(edge.fromId);
      const normalizedToId = normalizeRecordId(edge.toId);
      const normalizedUpdatedAt = normalizeEdgeUpdatedAt(edge, nowMs);
      const baseEdge = baseEdgeById.get(id);
      if (
        hasReusablePersistEdgeRecord(baseEdge, edge, {
          fromId: normalizedFromId,
          toId: normalizedToId,
          updatedAt: normalizedUpdatedAt,
        })
      ) {
        if (snapshotDiagnostics) {
          snapshotDiagnostics.reusedEdgeCount += 1;
        }
        return baseEdge;
      }
      const plainEdge = clonePersistSnapshotRecord(edge);
      if (!plainEdge || typeof plainEdge !== "object" || Array.isArray(plainEdge)) {
        return null;
      }
      if (snapshotDiagnostics) {
        snapshotDiagnostics.clonedEdgeCount += 1;
      }
      plainEdge.id = id;
      plainEdge.fromId = normalizedFromId;
      plainEdge.toId = normalizedToId;
      plainEdge.updatedAt = normalizedUpdatedAt;
      return plainEdge;
    })
    .filter(Boolean);
  if (snapshotDiagnostics) {
    snapshotDiagnostics.edgeCount = edges.length;
    snapshotDiagnostics.edgesMs = readPersistDeltaNow() - edgesStartedAt;
  }

  const tombstonesStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const tombstones = toArray(options.tombstones ?? baseSnapshotView.tombstones)
    .map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record))
        return null;
      const id = normalizeRecordId(record.id);
      if (!id) return null;
      const normalizedKind = normalizeRecordId(record.kind);
      const normalizedTargetId = normalizeRecordId(record.targetId);
      const normalizedSourceDeviceId = normalizeRecordId(record.sourceDeviceId);
      const normalizedDeletedAt = normalizeTimestamp(record.deletedAt, nowMs);
      const baseTombstone = baseTombstoneById.get(id);
      if (
        hasReusablePersistTombstoneRecord(baseTombstone, {
          kind: normalizedKind,
          targetId: normalizedTargetId,
          sourceDeviceId: normalizedSourceDeviceId,
          deletedAt: normalizedDeletedAt,
        })
      ) {
        if (snapshotDiagnostics) {
          snapshotDiagnostics.reusedTombstoneCount += 1;
        }
        return baseTombstone;
      }
      const plainRecord = clonePersistSnapshotRecord(record);
      if (!plainRecord || typeof plainRecord !== "object" || Array.isArray(plainRecord)) {
        return null;
      }
      if (snapshotDiagnostics) {
        snapshotDiagnostics.clonedTombstoneCount += 1;
      }
      plainRecord.id = id;
      plainRecord.kind = normalizedKind;
      plainRecord.targetId = normalizedTargetId;
      plainRecord.sourceDeviceId = normalizedSourceDeviceId;
      plainRecord.deletedAt = normalizedDeletedAt;
      return plainRecord;
    })
    .filter(Boolean);
  if (snapshotDiagnostics) {
    snapshotDiagnostics.tombstoneCount = tombstones.length;
    snapshotDiagnostics.tombstonesMs =
      readPersistDeltaNow() - tombstonesStartedAt;
  }

  const stateStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const state = {
    ...normalizeStateSnapshot(baseSnapshot),
    ...(options.state || {}),
    lastProcessedFloor: Number.isFinite(
      Number(runtimeGraph?.historyState?.lastProcessedAssistantFloor),
    )
      ? Number(runtimeGraph.historyState.lastProcessedAssistantFloor)
      : Number(
          runtimeGraph?.lastProcessedSeq ?? META_DEFAULT_LAST_PROCESSED_FLOOR,
        ),
    extractionCount: Number.isFinite(
      Number(runtimeGraph?.historyState?.extractionCount),
    )
      ? Number(runtimeGraph.historyState.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT,
  };
  if (snapshotDiagnostics) {
    snapshotDiagnostics.stateMs = readPersistDeltaNow() - stateStartedAt;
  }

  const metaStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const mergedMeta = {
    ...baseSnapshot.meta,
    ...(options.meta || {}),
    schemaVersion: BME_DB_SCHEMA_VERSION,
    chatId,
    revision: normalizeRevision(
      options.revision ?? baseSnapshot.meta?.revision,
    ),
    lastModified: normalizeTimestamp(
      options.lastModified ?? baseSnapshot.meta?.lastModified,
      nowMs,
    ),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    tombstoneCount: tombstones.length,
    [BME_RUNTIME_HISTORY_META_KEY]: toPlainData(
      runtimeGraph?.historyState || {},
      {},
    ),
    [BME_RUNTIME_VECTOR_META_KEY]: toPlainData(
      runtimeGraph?.vectorIndexState || {},
      {},
    ),
    [BME_RUNTIME_BATCH_JOURNAL_META_KEY]: toPlainData(
      runtimeGraph?.batchJournal || [],
      [],
    ),
    [BME_RUNTIME_LAST_RECALL_META_KEY]: toPlainData(
      runtimeGraph?.lastRecallResult ?? null,
      null,
    ),
    [BME_RUNTIME_SUMMARY_STATE_META_KEY]: toPlainData(
      runtimeGraph?.summaryState || {},
      {},
    ),
    [BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY]: toPlainData(
      runtimeGraph?.maintenanceJournal || [],
      [],
    ),
    [BME_RUNTIME_KNOWLEDGE_STATE_META_KEY]: toPlainData(
      {
        ...(runtimeGraph?.knowledgeState || {}),
        activeOwnerKey: String(
          legacyActiveOwnerKey ||
            runtimeGraph?.historyState?.activeRecallOwnerKey ||
            "",
        ).trim(),
      },
      {},
    ),
    [BME_RUNTIME_REGION_STATE_META_KEY]: toPlainData(
      {
        ...(runtimeGraph?.regionState || {}),
        activeRegion: String(
          legacyActiveRegion ||
            runtimeGraph?.historyState?.activeRegion ||
            runtimeGraph?.regionState?.manualActiveRegion ||
            "",
        ).trim(),
      },
      {},
    ),
    [BME_RUNTIME_TIMELINE_STATE_META_KEY]: toPlainData(
      {
        ...(runtimeGraph?.timelineState || {}),
        activeSegmentId: String(
          legacyActiveSegmentId ||
            runtimeGraph?.historyState?.activeStorySegmentId ||
            runtimeGraph?.timelineState?.manualActiveSegmentId ||
            "",
        ).trim(),
      },
      {},
    ),
    [BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY]: Number.isFinite(
      Number(runtimeGraph?.lastProcessedSeq),
    )
      ? Number(runtimeGraph.lastProcessedSeq)
      : state.lastProcessedFloor,
    [BME_RUNTIME_GRAPH_VERSION_META_KEY]: Number.isFinite(
      Number(runtimeGraph?.version),
    )
      ? Number(runtimeGraph.version)
      : Number(baseSnapshot.meta?.[BME_RUNTIME_GRAPH_VERSION_META_KEY] || 0),
    [BME_RUNTIME_RECORDS_NORMALIZED_META_KEY]: true,
  };
  if (snapshotDiagnostics) {
    snapshotDiagnostics.metaMs = readPersistDeltaNow() - metaStartedAt;
  }

  const snapshotResult = {
    meta: mergedMeta,
    nodes,
    edges,
    tombstones,
    state,
  };
  if (snapshotDiagnostics) {
    emitOptionalDiagnostics(options, {
      ...snapshotDiagnostics,
      runtimeMetaKeyCount: Object.keys(mergedMeta).length,
      totalMs: readPersistDeltaNow() - snapshotStartedAt,
    });
  }

  return snapshotResult;
}

function normalizeSnapshotMetaState(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      meta: {},
      state: {},
    };
  }

  return {
    meta:
      snapshot.meta &&
      typeof snapshot.meta === "object" &&
      !Array.isArray(snapshot.meta)
        ? snapshot.meta
        : {},
    state:
      snapshot.state &&
      typeof snapshot.state === "object" &&
      !Array.isArray(snapshot.state)
        ? snapshot.state
        : {},
  };
}

function hashPersistSerializedRecord32(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolvePersistRecordSerializationVersion(record = {}) {
  const candidates = [
    record?.updatedAt,
    record?.deletedAt,
    record?.invalidAt,
    record?.expiredAt,
    record?.validAt,
    record?.lastModified,
    record?.createdTime,
    record?.lastAccessTime,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function resolvePersistRecordSerializationCacheToken(record = {}) {
  const id = normalizeRecordId(record?.id);
  const version = resolvePersistRecordSerializationVersion(record);
  if (!id || version == null) return "";
  return [
    id,
    version,
    normalizeRecordId(record?.kind),
    normalizeRecordId(record?.targetId),
    normalizeRecordId(record?.fromId),
    normalizeRecordId(record?.toId),
    normalizeRecordId(record?.type),
    normalizeRecordId(record?.relation),
    record?.archived === true ? "1" : "0",
  ].join("|");
}

function recordPersistSerializationCacheStat(stats = null, key = "") {
  if (!stats || typeof stats !== "object" || !key) return;
  stats[key] = Number(stats[key] || 0) + 1;
}

function recordPersistPreparedRecordSetCacheStat(stats = null, key = "") {
  if (!stats || typeof stats !== "object" || !key) return;
  stats[key] = Number(stats[key] || 0) + 1;
}

function resolvePreparedRecordSetCacheKey(options = {}) {
  return [
    options?.includeSerializedList === true ? "s1" : "s0",
    options?.includeHashList === true ? "h1" : "h0",
    options?.includeSerializedLookup !== false ? "l1" : "l0",
    options?.includeSerializedCharCount === true ? "c1" : "c0",
    options?.includeTargetKeys === true ? "t1" : "t0",
  ].join("|");
}

function touchPersistRecordSerializationTokenCache(token, entry) {
  if (!token || !entry) return;
  if (persistRecordSerializationCacheByToken.has(token)) {
    persistRecordSerializationCacheByToken.delete(token);
  }
  persistRecordSerializationCacheByToken.set(token, entry);
  while (
    persistRecordSerializationCacheByToken.size >
    PERSIST_RECORD_SERIALIZATION_CACHE_LIMIT
  ) {
    const oldestKey = persistRecordSerializationCacheByToken.keys().next().value;
    if (!oldestKey) break;
    persistRecordSerializationCacheByToken.delete(oldestKey);
  }
}

function ensurePersistRecordSerializationHash(entry = null) {
  if (!entry || typeof entry !== "object") return 0;
  if (!Number.isFinite(Number(entry.hash))) {
    entry.hash = hashPersistSerializedRecord32(String(entry.json || ""));
  }
  return Number(entry.hash) >>> 0;
}

function getPersistRecordSerialization(
  record,
  { includeHash = false, cacheStats = null } = {},
) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    const emptyEntry = { token: "", json: "null", length: 4, hash: 1996966820 };
    if (includeHash) emptyEntry.hash = hashPersistSerializedRecord32(emptyEntry.json);
    return emptyEntry;
  }

  const token = resolvePersistRecordSerializationCacheToken(record);
  const cachedByObject = token
    ? persistRecordSerializationCacheByObject.get(record)
    : null;
  if (
    cachedByObject &&
    cachedByObject.token === token &&
    cachedByObject.epoch === persistRecordSerializationCacheEpoch
  ) {
    recordPersistSerializationCacheStat(cacheStats, "objectHitCount");
    if (includeHash) ensurePersistRecordSerializationHash(cachedByObject);
    return cachedByObject;
  }

  const cachedByToken = token ? persistRecordSerializationCacheByToken.get(token) : null;
  if (cachedByToken) {
    persistRecordSerializationCacheByObject.set(record, cachedByToken);
    touchPersistRecordSerializationTokenCache(token, cachedByToken);
    recordPersistSerializationCacheStat(cacheStats, "tokenHitCount");
    if (includeHash) ensurePersistRecordSerializationHash(cachedByToken);
    return cachedByToken;
  }

  const json = JSON.stringify(record);
  const entry = {
    epoch: persistRecordSerializationCacheEpoch,
    token,
    json,
    length: json.length,
    hash: includeHash ? hashPersistSerializedRecord32(json) : null,
  };
  if (token) {
    persistRecordSerializationCacheByObject.set(record, entry);
    touchPersistRecordSerializationTokenCache(token, entry);
  }
  recordPersistSerializationCacheStat(cacheStats, "missCount");
  return entry;
}

function sumPersistSerializationCacheHits(stats = null) {
  if (!stats || typeof stats !== "object") return 0;
  return Number(stats.objectHitCount || 0) + Number(stats.tokenHitCount || 0);
}

export function resetPersistRecordSerializationCaches() {
  persistRecordSerializationCacheEpoch += 1;
  persistRecordSerializationCacheByToken.clear();
  persistPreparedRecordSetCacheEpoch += 1;
}

function buildPreparedRecordSet(
  records = [],
  {
    retainRecords = false,
    includeTargetKeys = false,
    includeSerializedList = false,
    includeHashList = false,
    includeSerializedLookup = true,
    includeSerializedCharCount = false,
    serializationCacheStats = null,
    preparedRecordSetCacheStats = null,
    usePreparedRecordSetCache = true,
  } = {},
) {
  const sourceRecords = toArray(records);
  const cacheKey =
    usePreparedRecordSetCache !== false &&
    Array.isArray(records) &&
    sourceRecords === records
      ? resolvePreparedRecordSetCacheKey({
          includeSerializedList,
          includeHashList,
          includeSerializedLookup,
          includeSerializedCharCount,
          includeTargetKeys,
        })
      : "";
  if (cacheKey) {
    const cachedEntry = persistPreparedRecordSetCacheByArray.get(records);
    const cachedRecordSet =
      cachedEntry &&
      cachedEntry.epoch === persistPreparedRecordSetCacheEpoch &&
      cachedEntry.values instanceof Map
        ? cachedEntry.values.get(cacheKey)
        : null;
    if (cachedRecordSet) {
      recordPersistPreparedRecordSetCacheStat(preparedRecordSetCacheStats, "hitCount");
      return cachedRecordSet;
    }
    recordPersistPreparedRecordSetCacheStat(preparedRecordSetCacheStats, "missCount");
  }
  const ids = [];
  const serialized = includeSerializedList ? [] : null;
  const hashes = includeHashList ? [] : null;
  const serializedById = includeSerializedLookup ? new Map() : null;
  const recordById = null;
  const targetKeyById = null;
  const targetKeys = includeTargetKeys ? [] : null;
  let serializedCharCount = 0;

  for (const record of sourceRecords) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const id = normalizeRecordId(record.id);
    if (!id) continue;
    const serializedEntry = getPersistRecordSerialization(record, {
      includeHash: includeHashList,
      cacheStats: serializationCacheStats,
    });
    const json = serializedEntry.json;
    ids.push(id);
    if (serialized) serialized.push(json);
    if (hashes) hashes.push(ensurePersistRecordSerializationHash(serializedEntry));
    if (serializedById) serializedById.set(id, json);
    if (includeSerializedCharCount) {
      serializedCharCount += serializedEntry.length;
    }
    if (targetKeys) {
      const kind = normalizeRecordId(record.kind);
      const targetId = normalizeRecordId(record.targetId);
      targetKeys.push(kind && targetId ? `${kind}:${targetId}` : "");
    }
  }

  const preparedRecordSet = {
    ids,
    serialized,
    hashes,
    serializedById,
    sourceRecords,
    recordById,
    targetKeyById,
    targetKeys,
    serializedCharCount,
  };
  if (cacheKey) {
    const cachedEntry = persistPreparedRecordSetCacheByArray.get(records);
    const values =
      cachedEntry &&
      cachedEntry.epoch === persistPreparedRecordSetCacheEpoch &&
      cachedEntry.values instanceof Map
        ? cachedEntry.values
        : new Map();
    values.set(cacheKey, preparedRecordSet);
    persistPreparedRecordSetCacheByArray.set(records, {
      epoch: persistPreparedRecordSetCacheEpoch,
      values,
    });
  }
  return preparedRecordSet;
}

function ensurePreparedSerializedLookup(recordSet = null, cacheStats = null) {
  if (!recordSet || typeof recordSet !== "object") {
    return new Map();
  }
  if (recordSet.serializedById instanceof Map) {
    return recordSet.serializedById;
  }

  const map = new Map();
  for (const record of toArray(recordSet.sourceRecords)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const id = normalizeRecordId(record.id);
    if (!id) continue;
    map.set(
      id,
      getPersistRecordSerialization(record, {
        cacheStats,
      }).json,
    );
  }
  recordSet.serializedById = map;
  return map;
}

function ensurePreparedRecordLookup(recordSet = null) {
  if (!recordSet || typeof recordSet !== "object") {
    return new Map();
  }
  if (recordSet.recordById instanceof Map) {
    return recordSet.recordById;
  }

  const map = new Map();
  for (const record of toArray(recordSet.sourceRecords)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const id = normalizeRecordId(record.id);
    if (!id) continue;
    map.set(id, record);
  }
  recordSet.recordById = map;
  return map;
}

function ensurePreparedTargetKeyLookup(recordSet = null) {
  if (!recordSet || typeof recordSet !== "object") {
    return new Map();
  }
  if (recordSet.targetKeyById instanceof Map) {
    return recordSet.targetKeyById;
  }

  const map = new Map();
  if (
    Array.isArray(recordSet.ids) &&
    Array.isArray(recordSet.targetKeys) &&
    recordSet.ids.length === recordSet.targetKeys.length
  ) {
    for (let index = 0; index < recordSet.ids.length; index++) {
      map.set(recordSet.ids[index], String(recordSet.targetKeys[index] || ""));
    }
  } else {
    for (const record of toArray(recordSet.sourceRecords)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const id = normalizeRecordId(record.id);
      if (!id) continue;
      const kind = normalizeRecordId(record.kind);
      const targetId = normalizeRecordId(record.targetId);
      map.set(id, kind && targetId ? `${kind}:${targetId}` : "");
    }
  }
  recordSet.targetKeyById = map;
  return map;
}

function buildPreparedPersistDeltaContext(
  beforeSnapshot,
  afterSnapshot,
  nowMs,
  options = {},
) {
  const compactPayloadModeRaw = String(options.compactPayloadMode || "none")
    .trim()
    .toLowerCase();
  const compactPayloadMode =
    compactPayloadModeRaw === "hash"
      ? "hash"
      : compactPayloadModeRaw === "json"
        ? "json"
        : "none";
  const includeCompactSerializedList = compactPayloadMode === "json";
  const includeCompactHashList = compactPayloadMode === "hash";
  const includeSerializedLookup = options.includeSerializedLookup !== false;
  const includeSerializedCharCount = options.includeSerializedCharCount === true;
  const serializationCacheStats =
    options?.serializationCacheStats &&
    typeof options.serializationCacheStats === "object" &&
    !Array.isArray(options.serializationCacheStats)
      ? options.serializationCacheStats
      : null;
  const preparedRecordSetCacheStats =
    options?.preparedRecordSetCacheStats &&
    typeof options.preparedRecordSetCacheStats === "object" &&
    !Array.isArray(options.preparedRecordSetCacheStats)
      ? options.preparedRecordSetCacheStats
      : null;
  const usePreparedRecordSetCache = options?.usePreparedRecordSetCache !== false;
  const beforeNodes = buildPreparedRecordSet(beforeSnapshot.nodes, {
    includeSerializedList: includeCompactSerializedList,
    includeHashList: includeCompactHashList,
    includeSerializedLookup,
    includeSerializedCharCount,
    serializationCacheStats,
    preparedRecordSetCacheStats,
    usePreparedRecordSetCache,
  });
  const afterNodes = buildPreparedRecordSet(afterSnapshot.nodes, {
    retainRecords: true,
    includeSerializedList: includeCompactSerializedList,
    includeHashList: includeCompactHashList,
    includeSerializedLookup,
    includeSerializedCharCount,
    serializationCacheStats,
    preparedRecordSetCacheStats,
    usePreparedRecordSetCache,
  });
  const beforeEdges = buildPreparedRecordSet(beforeSnapshot.edges, {
    includeSerializedList: includeCompactSerializedList,
    includeHashList: includeCompactHashList,
    includeSerializedLookup,
    includeSerializedCharCount,
    serializationCacheStats,
    preparedRecordSetCacheStats,
    usePreparedRecordSetCache,
  });
  const afterEdges = buildPreparedRecordSet(afterSnapshot.edges, {
    retainRecords: true,
    includeSerializedList: includeCompactSerializedList,
    includeHashList: includeCompactHashList,
    includeSerializedLookup,
    includeSerializedCharCount,
    serializationCacheStats,
    preparedRecordSetCacheStats,
    usePreparedRecordSetCache,
  });
  const beforeTombstones = buildPreparedRecordSet(beforeSnapshot.tombstones, {
    includeSerializedList: includeCompactSerializedList,
    includeHashList: includeCompactHashList,
    includeSerializedLookup,
    includeSerializedCharCount,
    serializationCacheStats,
    preparedRecordSetCacheStats,
    usePreparedRecordSetCache,
  });
  const afterTombstones = buildPreparedRecordSet(afterSnapshot.tombstones, {
    retainRecords: true,
    includeTargetKeys: true,
    includeSerializedList: includeCompactSerializedList,
    includeHashList: includeCompactHashList,
    includeSerializedLookup,
    includeSerializedCharCount,
    serializationCacheStats,
    preparedRecordSetCacheStats,
    usePreparedRecordSetCache,
  });
  const sourceDeviceId = normalizeRecordId(
    afterSnapshot.meta?.deviceId || beforeSnapshot.meta?.deviceId || "",
  );
  const beforeRecordCount =
    beforeNodes.ids.length + beforeEdges.ids.length + beforeTombstones.ids.length;
  const afterRecordCount =
    afterNodes.ids.length + afterEdges.ids.length + afterTombstones.ids.length;
  const beforeSerializedChars =
    includeSerializedCharCount
      ? beforeNodes.serializedCharCount +
        beforeEdges.serializedCharCount +
        beforeTombstones.serializedCharCount
      : 0;
  const afterSerializedChars =
    includeSerializedCharCount
      ? afterNodes.serializedCharCount +
        afterEdges.serializedCharCount +
        afterTombstones.serializedCharCount
      : 0;

  return {
    beforeNodes,
    afterNodes,
    beforeEdges,
    afterEdges,
    beforeTombstones,
    afterTombstones,
    nowMs,
    sourceDeviceId,
    beforeRecordCount,
    afterRecordCount,
    maxSnapshotRecords: Math.max(beforeRecordCount, afterRecordCount),
    structuralDelta:
      Math.abs(afterNodes.ids.length - beforeNodes.ids.length) +
      Math.abs(afterEdges.ids.length - beforeEdges.ids.length) +
      Math.abs(afterTombstones.ids.length - beforeTombstones.ids.length),
    beforeSerializedChars,
    afterSerializedChars,
    serializationCacheStats,
    compactPayload:
      compactPayloadMode === "json"
        ? {
            bridgeMode: "json",
            nowMs,
            beforeNodes: {
              ids: beforeNodes.ids,
              serialized: beforeNodes.serialized,
            },
            afterNodes: {
              ids: afterNodes.ids,
              serialized: afterNodes.serialized,
            },
            beforeEdges: {
              ids: beforeEdges.ids,
              serialized: beforeEdges.serialized,
            },
            afterEdges: {
              ids: afterEdges.ids,
              serialized: afterEdges.serialized,
            },
            beforeTombstones: {
              ids: beforeTombstones.ids,
              serialized: beforeTombstones.serialized,
            },
            afterTombstones: {
              ids: afterTombstones.ids,
              serialized: afterTombstones.serialized,
              targetKeys: afterTombstones.ids.map(
                (id) => afterTombstones.targetKeyById?.get(id) || "",
              ),
            },
          }
        : compactPayloadMode === "hash"
          ? {
              bridgeMode: "hash",
              nowMs,
              beforeNodes: {
                ids: beforeNodes.ids,
                hashes: beforeNodes.hashes,
              },
              afterNodes: {
                ids: afterNodes.ids,
                hashes: afterNodes.hashes,
              },
              beforeEdges: {
                ids: beforeEdges.ids,
                hashes: beforeEdges.hashes,
              },
              afterEdges: {
                ids: afterEdges.ids,
                hashes: afterEdges.hashes,
              },
              beforeTombstones: {
                ids: beforeTombstones.ids,
                hashes: beforeTombstones.hashes,
              },
              afterTombstones: {
                ids: afterTombstones.ids,
                hashes: afterTombstones.hashes,
                targetKeys: afterTombstones.ids.map(
                  (id) => afterTombstones.targetKeyById?.get(id) || "",
                ),
              },
            }
          : null,
  };
}

function buildRuntimeMetaPatch(snapshot = {}) {
  const normalizedSnapshot = normalizeSnapshotMetaState(snapshot);
  const patch = {};
  for (const [rawKey, value] of Object.entries(normalizedSnapshot.meta || {})) {
    const key = normalizeRecordId(rawKey);
    if (!key || BME_PERSIST_META_RESERVED_KEYS.has(key)) continue;
    patch[key] = toPlainData(value, value);
  }
  const state = normalizeStateSnapshot(normalizedSnapshot);
  patch.lastProcessedFloor = state.lastProcessedFloor;
  patch.extractionCount = state.extractionCount;
  patch.schemaVersion = BME_DB_SCHEMA_VERSION;
  patch.chatId = normalizeChatId(
    normalizedSnapshot.meta?.chatId || patch.chatId || "",
  );
  return patch;
}

function ensureDeleteTombstone(
  tombstoneMap,
  kind,
  targetId,
  deletedAt,
  sourceDeviceId = "",
) {
  const normalizedKind = normalizeRecordId(kind);
  const normalizedTargetId = normalizeRecordId(targetId);
  if (!normalizedKind || !normalizedTargetId) return;
  const targetKey = `${normalizedKind}:${normalizedTargetId}`;
  if (tombstoneMap.has(targetKey)) return;
  tombstoneMap.set(targetKey, {
    id: `${normalizedKind}:${normalizedTargetId}`,
    kind: normalizedKind,
    targetId: normalizedTargetId,
    sourceDeviceId: normalizeRecordId(sourceDeviceId),
    deletedAt: normalizeTimestamp(deletedAt),
  });
}

function normalizePersistDeltaShape(delta = null) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    return null;
  }

  const toObjectArray = (value) =>
    Array.isArray(value)
      ? value
          .filter((item) => item && typeof item === "object" && !Array.isArray(item))
          .map((item) => toPlainData(item, item))
      : [];
  const toStringArray = (value) =>
    Array.isArray(value)
      ? value
          .map((item) => normalizeRecordId(item))
          .filter((item) => item.length > 0)
      : [];
  const runtimeMetaPatch =
    delta.runtimeMetaPatch &&
    typeof delta.runtimeMetaPatch === "object" &&
    !Array.isArray(delta.runtimeMetaPatch)
      ? toPlainData(delta.runtimeMetaPatch, {})
      : {};

  return {
    upsertNodes: toObjectArray(delta.upsertNodes),
    upsertEdges: toObjectArray(delta.upsertEdges),
    deleteNodeIds: toStringArray(delta.deleteNodeIds),
    deleteEdgeIds: toStringArray(delta.deleteEdgeIds),
    tombstones: toObjectArray(delta.tombstones),
    runtimeMetaPatch,
  };
}

function normalizePersistDeltaIdShape(delta = null) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    return null;
  }

  const hasFullShapeFields =
    Object.prototype.hasOwnProperty.call(delta, "upsertNodes") ||
    Object.prototype.hasOwnProperty.call(delta, "upsertEdges") ||
    Object.prototype.hasOwnProperty.call(delta, "tombstones");
  if (hasFullShapeFields) return null;

  const hasIdShape =
    Object.prototype.hasOwnProperty.call(delta, "upsertNodeIds") ||
    Object.prototype.hasOwnProperty.call(delta, "upsertEdgeIds") ||
    Object.prototype.hasOwnProperty.call(delta, "deleteNodeIds") ||
    Object.prototype.hasOwnProperty.call(delta, "deleteEdgeIds") ||
    Object.prototype.hasOwnProperty.call(delta, "upsertTombstoneIds");
  if (!hasIdShape) return null;

  const toStringArray = (value) =>
    Array.isArray(value)
      ? value
          .map((item) => normalizeRecordId(item))
          .filter((item) => item.length > 0)
      : [];

  return {
    upsertNodeIds: toStringArray(delta.upsertNodeIds),
    upsertEdgeIds: toStringArray(delta.upsertEdgeIds),
    deleteNodeIds: toStringArray(delta.deleteNodeIds),
    deleteEdgeIds: toStringArray(delta.deleteEdgeIds),
    upsertTombstoneIds: toStringArray(delta.upsertTombstoneIds),
  };
}

function hydratePreparedRecords(recordById, ids = []) {
  const output = [];
  if (!(recordById instanceof Map)) return output;
  for (const id of ids) {
    const record = recordById.get(normalizeRecordId(id));
    if (!record) continue;
    output.push(record);
  }
  return output;
}

function buildPersistDeltaFromIdShape(preparedContext, delta = null) {
  const normalized = normalizePersistDeltaIdShape(delta);
  if (!normalized) return null;

  const afterNodeRecordById = ensurePreparedRecordLookup(preparedContext.afterNodes);
  const afterEdgeRecordById = ensurePreparedRecordLookup(preparedContext.afterEdges);
  const afterTombstoneRecordById = ensurePreparedRecordLookup(
    preparedContext.afterTombstones,
  );
  const afterTombstoneTargetKeyById = ensurePreparedTargetKeyLookup(
    preparedContext.afterTombstones,
  );

  const tombstoneMap = new Map();
  for (const id of normalized.upsertTombstoneIds) {
    const record = afterTombstoneRecordById.get(id);
    const targetKey = afterTombstoneTargetKeyById.get(id) || "";
    if (!record || !targetKey) continue;
    tombstoneMap.set(targetKey, record);
  }

  for (const nodeId of normalized.deleteNodeIds) {
    ensureDeleteTombstone(
      tombstoneMap,
      "node",
      nodeId,
      preparedContext.nowMs,
      preparedContext.sourceDeviceId,
    );
  }
  for (const edgeId of normalized.deleteEdgeIds) {
    ensureDeleteTombstone(
      tombstoneMap,
      "edge",
      edgeId,
      preparedContext.nowMs,
      preparedContext.sourceDeviceId,
    );
  }

  return {
    upsertNodes: hydratePreparedRecords(
      afterNodeRecordById,
      normalized.upsertNodeIds,
    ),
    upsertEdges: hydratePreparedRecords(
      afterEdgeRecordById,
      normalized.upsertEdgeIds,
    ),
    deleteNodeIds: normalized.deleteNodeIds,
    deleteEdgeIds: normalized.deleteEdgeIds,
    tombstones: Array.from(tombstoneMap.values()),
    runtimeMetaPatch: {},
  };
}

function buildPersistCountDelta(beforeSnapshot = {}, afterSnapshot = {}) {
  const normalizedBefore = normalizePersistSnapshotView(beforeSnapshot);
  const normalizedAfter = normalizePersistSnapshotView(afterSnapshot);
  const previous = {
    nodes: toArray(normalizedBefore.nodes).length,
    edges: toArray(normalizedBefore.edges).length,
    tombstones: toArray(normalizedBefore.tombstones).length,
  };
  const next = {
    nodes: toArray(normalizedAfter.nodes).length,
    edges: toArray(normalizedAfter.edges).length,
    tombstones: toArray(normalizedAfter.tombstones).length,
  };
  return {
    previous,
    next,
    delta: {
      nodes: next.nodes - previous.nodes,
      edges: next.edges - previous.edges,
      tombstones: next.tombstones - previous.tombstones,
    },
  };
}

function readPersistDeltaNow() {
  if (typeof performance === "object" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function emitOptionalDiagnostics(options = {}, snapshot = null) {
  if (typeof options?.onDiagnostics !== "function") return;
  try {
    options.onDiagnostics(snapshot ? toPlainData(snapshot, snapshot) : null);
  } catch {
    // ignore diagnostics callback failures
  }
}

function emitPersistDeltaDiagnostics(options = {}, snapshot = null) {
  emitOptionalDiagnostics(options, snapshot);
}

function tryBuildNativePersistDelta(
  beforeSnapshot,
  afterSnapshot,
  preparedContext,
  options = {},
) {
  if (options?.useNativeDelta !== true) {
    return {
      rawDelta: null,
      status: "not-requested",
      error: "",
    };
  }
  const nativeBuilder = globalThis.__stBmeNativeBuildPersistDelta;
  if (typeof nativeBuilder !== "function") {
    if (options?.nativeFailOpen === false) {
      throw new Error("native-persist-delta-builder-unavailable");
    }
    return {
      rawDelta: null,
      status: "builder-unavailable",
      error: "native-persist-delta-builder-unavailable",
    };
  }

  try {
    return {
      rawDelta: nativeBuilder(beforeSnapshot, afterSnapshot, {
        nowMs: options?.nowMs,
        preparedDeltaInput: preparedContext?.compactPayload || null,
      }),
      status: "ok",
      error: "",
    };
  } catch (error) {
    if (options?.nativeFailOpen === false) {
      throw error;
    }
    return {
      rawDelta: null,
      status: "builder-error",
      error: error?.message || String(error),
    };
  }
}

export function buildPersistDelta(beforeSnapshot, afterSnapshot, options = {}) {
  const shouldCollectDiagnostics = typeof options?.onDiagnostics === "function";
  const startedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const timings = shouldCollectDiagnostics
    ? {
        prepareMs: 0,
        nativeAttemptMs: 0,
        lookupMs: 0,
        jsDiffMs: 0,
        hydrateMs: 0,
      }
    : null;
  const serializationCacheStats = {
    objectHitCount: 0,
    tokenHitCount: 0,
    missCount: 0,
  };
  const preparedRecordSetCacheStats = shouldCollectDiagnostics
    ? {
        hitCount: 0,
        missCount: 0,
      }
    : null;
  const normalizedBefore = normalizePersistSnapshotView(beforeSnapshot);
  const normalizedAfter = normalizePersistSnapshotView(afterSnapshot);
  const nowMs = normalizeTimestamp(options.nowMs, Date.now());
  const nativeBridgeMode = resolvePersistNativeDeltaBridgeMode(options);
  const nativeGateOptions =
    options?.useNativeDelta === true
      ? resolvePersistNativeDeltaGateOptions(options)
      : null;
  const shouldMeasureSerializedChars =
    shouldCollectDiagnostics ||
    (options?.useNativeDelta === true &&
      (nativeGateOptions?.minCombinedSerializedChars || 0) > 0);
  const prepareStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const preparedContext = buildPreparedPersistDeltaContext(
    normalizedBefore,
    normalizedAfter,
    nowMs,
    {
      compactPayloadMode: options?.useNativeDelta === true ? nativeBridgeMode : "none",
      includeSerializedLookup: options?.useNativeDelta !== true,
      includeSerializedCharCount: shouldMeasureSerializedChars,
      serializationCacheStats,
      preparedRecordSetCacheStats,
      usePreparedRecordSetCache: options?.usePreparedRecordSetCache !== false,
    },
  );
  if (timings) {
    timings.prepareMs = readPersistDeltaNow() - prepareStartedAt;
  }
  const combinedSerializedChars =
    preparedContext.beforeSerializedChars + preparedContext.afterSerializedChars;
  const preparedNativeGate =
    options?.useNativeDelta === true
      ? evaluatePersistNativeDeltaGate(normalizedBefore, normalizedAfter, {
          minSnapshotRecords: nativeGateOptions?.minSnapshotRecords,
          minStructuralDelta: nativeGateOptions?.minStructuralDelta,
          minCombinedSerializedChars: nativeGateOptions?.minCombinedSerializedChars,
          measuredCombinedSerializedChars: combinedSerializedChars,
        })
      : null;

  const nativeAttemptStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const nativeAttempt =
    options?.useNativeDelta !== true
      ? {
          rawDelta: null,
          status: "not-requested",
          error: "",
        }
      : preparedNativeGate?.allowed === false
        ? {
            rawDelta: null,
            status: "gated-out",
            error: "",
          }
        : tryBuildNativePersistDelta(
            normalizedBefore,
            normalizedAfter,
            preparedContext,
            options,
          );
  if (timings) {
    timings.nativeAttemptMs = readPersistDeltaNow() - nativeAttemptStartedAt;
  }
  const nativeRawDelta = nativeAttempt.rawDelta;
  const nativeIdDelta = normalizePersistDeltaIdShape(nativeRawDelta);
  const hydrateStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const nativeDelta = nativeIdDelta
    ? buildPersistDeltaFromIdShape(preparedContext, nativeIdDelta)
    : normalizePersistDeltaShape(nativeRawDelta);
  if (timings && nativeRawDelta) {
    timings.hydrateMs = readPersistDeltaNow() - hydrateStartedAt;
  }
  if (nativeRawDelta && !nativeDelta) {
    if (options?.nativeFailOpen === false) {
      throw new Error("native-persist-delta-invalid-result");
    }
    nativeAttempt.status = "invalid-result";
    nativeAttempt.error = "native-persist-delta-invalid-result";
  }
  if (nativeDelta) {
    const result = {
      ...nativeDelta,
      countDelta: buildPersistCountDelta(normalizedBefore, normalizedAfter),
      runtimeMetaPatch: {
        ...buildRuntimeMetaPatch(normalizedAfter),
        ...nativeDelta.runtimeMetaPatch,
        ...(options.runtimeMetaPatch &&
        typeof options.runtimeMetaPatch === "object" &&
        !Array.isArray(options.runtimeMetaPatch)
          ? toPlainData(options.runtimeMetaPatch, {})
          : {}),
      },
    };
    if (shouldCollectDiagnostics) {
      emitPersistDeltaDiagnostics(options, {
        requestedNative: options?.useNativeDelta === true,
        requestedBridgeMode: options?.useNativeDelta === true ? nativeBridgeMode : "none",
        preparedBridgeMode: preparedContext.compactPayload?.bridgeMode || "none",
        usedNative: true,
        path: nativeIdDelta
          ? `native-compact-${preparedContext.compactPayload?.bridgeMode || "json"}`
          : "native-full",
        gateAllowed: preparedNativeGate?.allowed ?? false,
        gateReasons: preparedNativeGate?.reasons || [],
        nativeAttemptStatus: nativeAttempt.status,
        nativeError: nativeAttempt.error,
        beforeRecordCount: preparedContext.beforeRecordCount,
        afterRecordCount: preparedContext.afterRecordCount,
        maxSnapshotRecords: preparedContext.maxSnapshotRecords,
        combinedSerializedChars,
        structuralDelta: preparedContext.structuralDelta,
        beforeSerializedChars: preparedContext.beforeSerializedChars,
        afterSerializedChars: preparedContext.afterSerializedChars,
        prepareMs: timings?.prepareMs || 0,
        nativeAttemptMs: timings?.nativeAttemptMs || 0,
        lookupMs: timings?.lookupMs || 0,
        jsDiffMs: timings?.jsDiffMs || 0,
        hydrateMs: timings?.hydrateMs || 0,
        serializationCacheObjectHits: Number(serializationCacheStats.objectHitCount || 0),
        serializationCacheTokenHits: Number(serializationCacheStats.tokenHitCount || 0),
        serializationCacheMisses: Number(serializationCacheStats.missCount || 0),
        serializationCacheHits: sumPersistSerializationCacheHits(
          serializationCacheStats,
        ),
        preparedRecordSetCacheHits: Number(preparedRecordSetCacheStats?.hitCount || 0),
        preparedRecordSetCacheMisses: Number(preparedRecordSetCacheStats?.missCount || 0),
        minCombinedSerializedChars:
          preparedNativeGate?.minCombinedSerializedChars || 0,
        buildMs: readPersistDeltaNow() - startedAt,
        upsertNodeCount: result.upsertNodes.length,
        upsertEdgeCount: result.upsertEdges.length,
        deleteNodeCount: result.deleteNodeIds.length,
        deleteEdgeCount: result.deleteEdgeIds.length,
        tombstoneCount: result.tombstones.length,
      });
    }
    return result;
  }

  const lookupStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const beforeNodeSerializedById = ensurePreparedSerializedLookup(
    preparedContext.beforeNodes,
    serializationCacheStats,
  );
  const afterNodeSerializedById = ensurePreparedSerializedLookup(
    preparedContext.afterNodes,
    serializationCacheStats,
  );
  const beforeEdgeSerializedById = ensurePreparedSerializedLookup(
    preparedContext.beforeEdges,
    serializationCacheStats,
  );
  const afterEdgeSerializedById = ensurePreparedSerializedLookup(
    preparedContext.afterEdges,
    serializationCacheStats,
  );
  const beforeTombstoneSerializedById = ensurePreparedSerializedLookup(
    preparedContext.beforeTombstones,
    serializationCacheStats,
  );
  const afterTombstoneSerializedById = ensurePreparedSerializedLookup(
    preparedContext.afterTombstones,
    serializationCacheStats,
  );
  const afterNodeRecordById = ensurePreparedRecordLookup(preparedContext.afterNodes);
  const afterEdgeRecordById = ensurePreparedRecordLookup(preparedContext.afterEdges);
  const afterTombstoneRecordById = ensurePreparedRecordLookup(
    preparedContext.afterTombstones,
  );
  const afterTombstoneTargetKeyById = ensurePreparedTargetKeyLookup(
    preparedContext.afterTombstones,
  );
  if (timings) {
    timings.lookupMs = readPersistDeltaNow() - lookupStartedAt;
  }

  const jsDiffStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const upsertNodes = [];
  for (const id of preparedContext.afterNodes.ids) {
    if (
      beforeNodeSerializedById.get(id) !== afterNodeSerializedById.get(id)
    ) {
      const record = afterNodeRecordById.get(id);
      if (record) upsertNodes.push(record);
    }
  }

  const upsertEdges = [];
  for (const id of preparedContext.afterEdges.ids) {
    if (
      beforeEdgeSerializedById.get(id) !== afterEdgeSerializedById.get(id)
    ) {
      const record = afterEdgeRecordById.get(id);
      if (record) upsertEdges.push(record);
    }
  }

  const deleteNodeIds = [];
  for (const id of preparedContext.beforeNodes.ids) {
    if (!afterNodeSerializedById.has(id)) {
      deleteNodeIds.push(id);
    }
  }

  const deleteEdgeIds = [];
  for (const id of preparedContext.beforeEdges.ids) {
    if (!afterEdgeSerializedById.has(id)) {
      deleteEdgeIds.push(id);
    }
  }

  const tombstoneMap = new Map();
  for (const id of preparedContext.afterTombstones.ids) {
    if (
      beforeTombstoneSerializedById.get(id) !==
      afterTombstoneSerializedById.get(id)
    ) {
      const record = afterTombstoneRecordById.get(id);
      const targetKey = afterTombstoneTargetKeyById.get(id) || "";
      if (!record || !targetKey) continue;
      tombstoneMap.set(targetKey, record);
    }
  }

  for (const nodeId of deleteNodeIds) {
    ensureDeleteTombstone(
      tombstoneMap,
      "node",
      nodeId,
      preparedContext.nowMs,
      preparedContext.sourceDeviceId,
    );
  }
  for (const edgeId of deleteEdgeIds) {
    ensureDeleteTombstone(
      tombstoneMap,
      "edge",
      edgeId,
      preparedContext.nowMs,
      preparedContext.sourceDeviceId,
    );
  }

  const result = {
    upsertNodes,
    upsertEdges,
    deleteNodeIds,
    deleteEdgeIds,
    tombstones: Array.from(tombstoneMap.values()),
    countDelta: buildPersistCountDelta(normalizedBefore, normalizedAfter),
    runtimeMetaPatch: {
      ...buildRuntimeMetaPatch(normalizedAfter),
      ...(options.runtimeMetaPatch &&
      typeof options.runtimeMetaPatch === "object" &&
      !Array.isArray(options.runtimeMetaPatch)
        ? toPlainData(options.runtimeMetaPatch, {})
        : {}),
    },
  };
  if (timings) {
    timings.jsDiffMs = readPersistDeltaNow() - jsDiffStartedAt;
  }
  if (shouldCollectDiagnostics) {
    emitPersistDeltaDiagnostics(options, {
      requestedNative: options?.useNativeDelta === true,
      requestedBridgeMode: options?.useNativeDelta === true ? nativeBridgeMode : "none",
      preparedBridgeMode: preparedContext.compactPayload?.bridgeMode || "none",
      usedNative: false,
      path: "js",
      gateAllowed: preparedNativeGate?.allowed ?? false,
      gateReasons: preparedNativeGate?.reasons || [],
      nativeAttemptStatus: nativeAttempt.status,
      nativeError: nativeAttempt.error,
      beforeRecordCount: preparedContext.beforeRecordCount,
      afterRecordCount: preparedContext.afterRecordCount,
      maxSnapshotRecords: preparedContext.maxSnapshotRecords,
      combinedSerializedChars,
      structuralDelta: preparedContext.structuralDelta,
      beforeSerializedChars: preparedContext.beforeSerializedChars,
      afterSerializedChars: preparedContext.afterSerializedChars,
      prepareMs: timings?.prepareMs || 0,
      nativeAttemptMs: timings?.nativeAttemptMs || 0,
      lookupMs: timings?.lookupMs || 0,
      jsDiffMs: timings?.jsDiffMs || 0,
      hydrateMs: timings?.hydrateMs || 0,
      serializationCacheObjectHits: Number(serializationCacheStats.objectHitCount || 0),
      serializationCacheTokenHits: Number(serializationCacheStats.tokenHitCount || 0),
      serializationCacheMisses: Number(serializationCacheStats.missCount || 0),
      serializationCacheHits: sumPersistSerializationCacheHits(
        serializationCacheStats,
      ),
      preparedRecordSetCacheHits: Number(preparedRecordSetCacheStats?.hitCount || 0),
      preparedRecordSetCacheMisses: Number(preparedRecordSetCacheStats?.missCount || 0),
      minCombinedSerializedChars:
        preparedNativeGate?.minCombinedSerializedChars || 0,
      buildMs: readPersistDeltaNow() - startedAt,
      upsertNodeCount: result.upsertNodes.length,
      upsertEdgeCount: result.upsertEdges.length,
      deleteNodeCount: result.deleteNodeIds.length,
      deleteEdgeCount: result.deleteEdgeIds.length,
      tombstoneCount: result.tombstones.length,
    });
  }
  return result;
}

export function buildGraphFromSnapshot(snapshot, options = {}) {
  const shouldCollectDiagnostics = typeof options?.onDiagnostics === "function";
  const hydrateStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const hydrateDiagnostics = shouldCollectDiagnostics
    ? {
        success: false,
        nodeCount: 0,
        edgeCount: 0,
        tombstoneCount: 0,
        nodesMs: 0,
        edgesMs: 0,
        runtimeMetaMs: 0,
        stateMs: 0,
        normalizeMs: 0,
        integrityMs: 0,
        integrityReasonCount: 0,
        nativeRequested: false,
        nativeUsed: false,
        nativeStatus: "not-requested",
        nativeError: "",
        nativeRecordsMs: 0,
        nativeGateAllowed: false,
        nativeGateReasons: [],
        nativeModuleDiagnostics: null,
      }
    : null;
  const snapshotView = normalizePersistSnapshotView(snapshot);
  const snapshotMeta =
    snapshotView.meta &&
    typeof snapshotView.meta === "object" &&
    !Array.isArray(snapshotView.meta)
      ? snapshotView.meta
      : {};
  const snapshotState =
    snapshotView.state &&
    typeof snapshotView.state === "object" &&
    !Array.isArray(snapshotView.state)
      ? snapshotView.state
      : {};
  const chatId =
    normalizeChatId(options.chatId) ||
    normalizeChatId(snapshotMeta?.chatId) ||
    normalizeChatId(snapshotState?.chatId);
  const snapshotHistoryState = toPlainData(
    snapshotMeta?.[BME_RUNTIME_HISTORY_META_KEY],
    {},
  );
  const snapshotVectorState = toPlainData(
    snapshotMeta?.[BME_RUNTIME_VECTOR_META_KEY],
    {},
  );
  const snapshotRecordsNormalized =
    snapshotMeta?.[BME_RUNTIME_RECORDS_NORMALIZED_META_KEY] === true;
  const nativeHydrateGate =
    options?.useNativeHydrate === true
      ? evaluateNativeHydrateGate(snapshotView, options)
      : null;
  const nativeHydrateStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  let nativeHydrateAttempt =
    options?.useNativeHydrate !== true
      ? {
          rawResult: null,
          status: "not-requested",
          error: "",
        }
      : nativeHydrateGate?.allowed === false
        ? {
            rawResult: null,
            status: "gated-out",
            error: "",
          }
        : tryBuildNativeHydrateRecords(
            snapshotView,
            {
              ...options,
              recordsNormalized: snapshotRecordsNormalized,
            },
          );
  let nativeHydrateResult = normalizeNativeHydrateResult(
    nativeHydrateAttempt.rawResult,
    snapshotView,
  );
  if (nativeHydrateAttempt.rawResult && !nativeHydrateResult) {
    if (options?.nativeFailOpen === false) {
      throw new Error("native-hydrate-invalid-result");
    }
    nativeHydrateAttempt = {
      rawResult: null,
      status: "invalid-result",
      error: "native-hydrate-invalid-result",
    };
  }
  if (hydrateDiagnostics) {
    hydrateDiagnostics.nativeRequested = options?.useNativeHydrate === true;
    hydrateDiagnostics.nativeStatus = nativeHydrateAttempt.status;
    hydrateDiagnostics.nativeError = nativeHydrateAttempt.error;
    hydrateDiagnostics.nativeGateAllowed = nativeHydrateGate?.allowed ?? false;
    hydrateDiagnostics.nativeGateReasons = nativeHydrateGate?.reasons || [];
    hydrateDiagnostics.nativeModuleDiagnostics =
      nativeHydrateResult?.diagnostics || null;
    if (nativeHydrateAttempt.rawResult) {
      hydrateDiagnostics.nativeRecordsMs =
        readPersistDeltaNow() - nativeHydrateStartedAt;
    }
  }

  const runtimeGraph = createEmptyGraph();
  runtimeGraph.version = Number.isFinite(
    Number(snapshotMeta?.[BME_RUNTIME_GRAPH_VERSION_META_KEY]),
  )
    ? Number(snapshotMeta[BME_RUNTIME_GRAPH_VERSION_META_KEY])
    : runtimeGraph.version;

  const hydrateNodesStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  runtimeGraph.nodes = nativeHydrateResult
    ? nativeHydrateResult.nodes
    : cloneHydrateSnapshotNodeRecords(snapshotView.nodes);
  if (hydrateDiagnostics) {
    hydrateDiagnostics.nodeCount = runtimeGraph.nodes.length;
    hydrateDiagnostics.nodesMs = readPersistDeltaNow() - hydrateNodesStartedAt;
  }

  const hydrateEdgesStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  runtimeGraph.edges = nativeHydrateResult
    ? nativeHydrateResult.edges
    : cloneHydrateSnapshotEdgeRecords(snapshotView.edges);
  if (hydrateDiagnostics) {
    hydrateDiagnostics.edgeCount = runtimeGraph.edges.length;
    hydrateDiagnostics.edgesMs = readPersistDeltaNow() - hydrateEdgesStartedAt;
    hydrateDiagnostics.nativeUsed = Boolean(nativeHydrateResult);
  }

  const hydrateRuntimeMetaStartedAt = shouldCollectDiagnostics
    ? readPersistDeltaNow()
    : 0;
  runtimeGraph.batchJournal = toArray(
    toPlainData(snapshotMeta?.[BME_RUNTIME_BATCH_JOURNAL_META_KEY], []),
  );
  runtimeGraph.lastRecallResult = toPlainData(
    snapshotMeta?.[BME_RUNTIME_LAST_RECALL_META_KEY],
    null,
  );
  runtimeGraph.maintenanceJournal = toArray(
    toPlainData(snapshotMeta?.[BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY], []),
  );
  runtimeGraph.knowledgeState = toPlainData(
    snapshotMeta?.[BME_RUNTIME_KNOWLEDGE_STATE_META_KEY],
    runtimeGraph.knowledgeState || {},
  );
  runtimeGraph.regionState = toPlainData(
    snapshotMeta?.[BME_RUNTIME_REGION_STATE_META_KEY],
    runtimeGraph.regionState || {},
  );
  runtimeGraph.timelineState = toPlainData(
    snapshotMeta?.[BME_RUNTIME_TIMELINE_STATE_META_KEY],
    runtimeGraph.timelineState || {},
  );
  runtimeGraph.summaryState = toPlainData(
    snapshotMeta?.[BME_RUNTIME_SUMMARY_STATE_META_KEY],
    runtimeGraph.summaryState || {},
  );
  if (hydrateDiagnostics) {
    hydrateDiagnostics.runtimeMetaMs =
      readPersistDeltaNow() - hydrateRuntimeMetaStartedAt;
  }
  const rawKnowledgeState =
    runtimeGraph.knowledgeState &&
    typeof runtimeGraph.knowledgeState === "object" &&
    !Array.isArray(runtimeGraph.knowledgeState)
      ? runtimeGraph.knowledgeState
      : {};
  const rawRegionState =
    runtimeGraph.regionState &&
    typeof runtimeGraph.regionState === "object" &&
    !Array.isArray(runtimeGraph.regionState)
      ? runtimeGraph.regionState
      : {};
  const rawTimelineState =
    runtimeGraph.timelineState &&
    typeof runtimeGraph.timelineState === "object" &&
    !Array.isArray(runtimeGraph.timelineState)
      ? runtimeGraph.timelineState
      : {};

  const hydrateStateStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  runtimeGraph.historyState = {
    ...(runtimeGraph.historyState || {}),
    ...snapshotHistoryState,
    lastProcessedAssistantFloor: Number.isFinite(
      Number(snapshotState?.lastProcessedFloor),
    )
      ? Number(snapshotState.lastProcessedFloor)
      : Number(
          snapshotHistoryState?.lastProcessedAssistantFloor ??
            META_DEFAULT_LAST_PROCESSED_FLOOR,
        ),
    extractionCount: Number.isFinite(
      Number(snapshotState?.extractionCount),
    )
      ? Number(snapshotState.extractionCount)
      : Number(
          snapshotHistoryState?.extractionCount ?? META_DEFAULT_EXTRACTION_COUNT,
        ),
  };
  if (
    typeof runtimeGraph.historyState.activeRecallOwnerKey !== "string" ||
    !runtimeGraph.historyState.activeRecallOwnerKey
  ) {
    const legacyActiveOwnerKey = String(rawKnowledgeState.activeOwnerKey || "").trim();
    if (legacyActiveOwnerKey) {
      runtimeGraph.historyState.activeRecallOwnerKey = legacyActiveOwnerKey;
    }
  }
  if (
    typeof runtimeGraph.historyState.activeRegion !== "string" ||
    !runtimeGraph.historyState.activeRegion
  ) {
    const legacyActiveRegion = String(rawRegionState.activeRegion || "").trim();
    if (legacyActiveRegion) {
      runtimeGraph.historyState.activeRegion = legacyActiveRegion;
      if (
        typeof runtimeGraph.historyState.activeRegionSource !== "string" ||
        !runtimeGraph.historyState.activeRegionSource
      ) {
        runtimeGraph.historyState.activeRegionSource = "snapshot";
      }
    }
  }
  if (
    typeof runtimeGraph.historyState.activeStorySegmentId !== "string" ||
    !runtimeGraph.historyState.activeStorySegmentId
  ) {
    const legacyActiveSegmentId = String(rawTimelineState.activeSegmentId || "").trim();
    if (legacyActiveSegmentId) {
      runtimeGraph.historyState.activeStorySegmentId = legacyActiveSegmentId;
      const activeSegment = Array.isArray(rawTimelineState.segments)
        ? rawTimelineState.segments.find(
            (segment) => String(segment?.id || "").trim() === legacyActiveSegmentId,
          )
        : null;
      if (
        (typeof runtimeGraph.historyState.activeStoryTimeLabel !== "string" ||
          !runtimeGraph.historyState.activeStoryTimeLabel) &&
        activeSegment
      ) {
        runtimeGraph.historyState.activeStoryTimeLabel = String(
          activeSegment.label || "",
        ).trim();
      }
      if (
        typeof runtimeGraph.historyState.activeStoryTimeSource !== "string" ||
        !runtimeGraph.historyState.activeStoryTimeSource
      ) {
        runtimeGraph.historyState.activeStoryTimeSource = "snapshot";
      }
    }
  }
  runtimeGraph.vectorIndexState = {
    ...(runtimeGraph.vectorIndexState || {}),
    ...snapshotVectorState,
    collectionId: buildVectorCollectionId(
      chatId ||
        snapshotHistoryState?.chatId ||
        runtimeGraph.historyState?.chatId ||
        "",
    ),
  };

  runtimeGraph.lastProcessedSeq = Number.isFinite(
    Number(snapshotMeta?.[BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY]),
  )
    ? Number(snapshotMeta[BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY])
    : Number(runtimeGraph.historyState.lastProcessedAssistantFloor);
  if (hydrateDiagnostics) {
    hydrateDiagnostics.tombstoneCount = toArray(snapshotView.tombstones).length;
    hydrateDiagnostics.stateMs = readPersistDeltaNow() - hydrateStateStartedAt;
  }

  const normalizeStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  const normalizedGraph = normalizeGraphRuntimeState(runtimeGraph, chatId, {
    skipRecordFieldNormalization: snapshotRecordsNormalized,
  });
  if (hydrateDiagnostics) {
    hydrateDiagnostics.normalizeMs = readPersistDeltaNow() - normalizeStartedAt;
  }
  if (
    normalizedGraph.knowledgeState &&
    typeof normalizedGraph.knowledgeState === "object" &&
    !Array.isArray(normalizedGraph.knowledgeState)
  ) {
    normalizedGraph.knowledgeState.activeOwnerKey = String(
      normalizedGraph.historyState?.activeRecallOwnerKey ||
        rawKnowledgeState.activeOwnerKey ||
        "",
    ).trim();
  }
  if (
    normalizedGraph.regionState &&
    typeof normalizedGraph.regionState === "object" &&
    !Array.isArray(normalizedGraph.regionState)
  ) {
    normalizedGraph.regionState.activeRegion = String(
      normalizedGraph.historyState?.activeRegion ||
        normalizedGraph.regionState.manualActiveRegion ||
        rawRegionState.activeRegion ||
        "",
    ).trim();
  }
  if (
    normalizedGraph.timelineState &&
    typeof normalizedGraph.timelineState === "object" &&
    !Array.isArray(normalizedGraph.timelineState)
  ) {
    normalizedGraph.timelineState.activeSegmentId = String(
      normalizedGraph.historyState?.activeStorySegmentId ||
        normalizedGraph.timelineState.manualActiveSegmentId ||
        rawTimelineState.activeSegmentId ||
        "",
    ).trim();
  }
  const historyState = normalizedGraph.historyState || {};
  const vectorState = normalizedGraph.vectorIndexState || {};
  const resolvedLastProcessedFloor = Number.isFinite(
    Number(historyState.lastProcessedAssistantFloor),
  )
    ? Number(historyState.lastProcessedAssistantFloor)
    : META_DEFAULT_LAST_PROCESSED_FLOOR;
  const resolvedLastProcessedSeq = Number.isFinite(
    Number(normalizedGraph.lastProcessedSeq),
  )
    ? Number(normalizedGraph.lastProcessedSeq)
    : resolvedLastProcessedFloor;
  const collectionId = String(vectorState.collectionId || "");
  const expectedCollectionId = buildVectorCollectionId(
    chatId || historyState.chatId || "",
  );
  const inconsistentReasons = [];

  const integrityStartedAt = shouldCollectDiagnostics ? readPersistDeltaNow() : 0;
  if (
    Number.isFinite(resolvedLastProcessedFloor) &&
    Number.isFinite(resolvedLastProcessedSeq) &&
    resolvedLastProcessedFloor !== resolvedLastProcessedSeq
  ) {
    inconsistentReasons.push("last-processed-seq-mismatch");
  }
  if (
    chatId &&
    historyState.chatId &&
    String(historyState.chatId) !== String(chatId)
  ) {
    inconsistentReasons.push("history-chat-id-mismatch");
  }
  if (collectionId && collectionId !== expectedCollectionId) {
    inconsistentReasons.push("vector-collection-mismatch");
  }
  if (hydrateDiagnostics) {
    hydrateDiagnostics.integrityMs = readPersistDeltaNow() - integrityStartedAt;
    hydrateDiagnostics.integrityReasonCount = inconsistentReasons.length;
  }

  if (inconsistentReasons.length > 0) {
    if (hydrateDiagnostics) {
      emitOptionalDiagnostics(options, {
        ...hydrateDiagnostics,
        success: false,
        integrityReasons: [...inconsistentReasons],
        totalMs: readPersistDeltaNow() - hydrateStartedAt,
      });
    }
    const error = new Error(
      `图谱快照完整性校验失败: ${inconsistentReasons.join(", ")}`,
    );
    error.code = "BME_SNAPSHOT_INTEGRITY_ERROR";
    error.reasons = inconsistentReasons;
    error.snapshotChatId = chatId;
    throw error;
  }

  if (hydrateDiagnostics) {
    emitOptionalDiagnostics(options, {
      ...hydrateDiagnostics,
      success: true,
      integrityReasons: [],
      totalMs: readPersistDeltaNow() - hydrateStartedAt,
    });
  }

  return normalizedGraph;
}

async function loadDexieFromNodeFallback() {
  try {
    const imported = await import("dexie");
    const DexieCtor = imported?.default || imported?.Dexie || imported;
    if (typeof DexieCtor === "function") {
      globalThis.Dexie = DexieCtor;
      return DexieCtor;
    }
  } catch {
    // ignore and continue to throw below.
  }

  throw new Error("Dexie 不可用（Node 环境缺少 dexie 依赖）");
}

async function loadDexieByModuleImport() {
  const moduleUrl = new URL(DEXIE_SCRIPT_SOURCE, import.meta.url).toString();
  try {
    const imported = await import(moduleUrl);
    const DexieCtor =
      imported?.default ||
      imported?.Dexie ||
      globalThis.Dexie ||
      null;
    if (typeof DexieCtor === "function") {
      globalThis.Dexie = DexieCtor;
      return DexieCtor;
    }
    if (typeof globalThis.Dexie === "function") {
      return globalThis.Dexie;
    }
  } catch (error) {
    throw new Error(
      `Dexie 模块导入失败: ${error?.message || String(error) || moduleUrl}`,
    );
  }

  throw new Error("Dexie 模块已加载但未导出可用构造函数");
}

async function loadDexieByScriptInjection() {
  const scriptUrl = new URL(DEXIE_SCRIPT_SOURCE, import.meta.url).toString();
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("document 不可用，无法注入 Dexie 脚本");
  }

  await new Promise((resolve, reject) => {
    const existingScript = doc.querySelector?.(
      `script[${DEXIE_SCRIPT_MARKER}="true"]`,
    );
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Dexie 脚本加载失败")),
        { once: true },
      );

      // 兼容脚本已经加载完成的情况
      if (globalThis.Dexie) {
        resolve();
      }
      return;
    }

    const script = doc.createElement("script");
    script.async = true;
    script.src = scriptUrl;
    script.setAttribute(DEXIE_SCRIPT_MARKER, "true");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error(`Dexie 脚本加载失败: ${scriptUrl}`)),
      { once: true },
    );

    const mountTarget = doc.head || doc.documentElement || doc.body;
    if (!mountTarget) {
      reject(new Error("无法找到可用的脚本挂载节点"));
      return;
    }
    mountTarget.appendChild(script);
  });

  if (!globalThis.Dexie) {
    throw new Error("Dexie 脚本已加载但 window.Dexie 不可用");
  }

  return globalThis.Dexie;
}

export async function ensureDexieLoaded() {
  if (globalThis.Dexie) {
    return globalThis.Dexie;
  }

  if (!globalThis[DEXIE_LOAD_PROMISE_KEY]) {
    globalThis[DEXIE_LOAD_PROMISE_KEY] = (async () => {
      if (globalThis.Dexie) {
        return globalThis.Dexie;
      }

      if (typeof globalThis.document === "undefined") {
        return await loadDexieFromNodeFallback();
      }

      try {
        return await loadDexieByModuleImport();
      } catch (moduleError) {
        console.warn("[ST-BME] Dexie 模块导入失败，回退脚本注入:", moduleError);
      }

      return await loadDexieByScriptInjection();
    })()
      .then((DexieCtor) => {
        globalThis.Dexie = DexieCtor;
        return DexieCtor;
      })
      .catch((error) => {
        console.warn("[ST-BME] Dexie 加载失败:", error);
        throw error;
      })
      .finally(() => {
        if (!globalThis.Dexie) {
          delete globalThis[DEXIE_LOAD_PROMISE_KEY];
        }
      });
  }

  return await globalThis[DEXIE_LOAD_PROMISE_KEY];
}

export function buildBmeDbName(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  return `STBME_${normalizedChatId}`;
}

export class BmeDatabase {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.dbName = buildBmeDbName(this.chatId);
    this.options = {
      dexieClass: options.dexieClass || null,
    };
    this.storeKind = "indexeddb";
    this.storeMode = "indexeddb";

    this.db = null;
    this._openPromise = null;
  }

  async open() {
    if (this.db?.isOpen?.()) {
      return this.db;
    }

    if (!this._openPromise) {
      this._openPromise = (async () => {
        const DexieCtor =
          this.options.dexieClass ||
          globalThis.Dexie ||
          (await ensureDexieLoaded());
        if (typeof DexieCtor !== "function") {
          throw new Error("Dexie 构造函数不可用");
        }

        const db = new DexieCtor(this.dbName);
        db.version(BME_DB_SCHEMA_VERSION).stores(BME_DB_TABLE_SCHEMAS);
        await db.open();

        this.db = db;
        await this._ensureMetaDefaults();
        return db;
      })().catch((error) => {
        try {
          this.db?.close?.();
        } catch {
          // noop
        }
        this.db = null;
        this._openPromise = null;
        throw error;
      });
    }

    return await this._openPromise;
  }

  async close() {
    try {
      this.db?.close?.();
    } finally {
      this.db = null;
      this._openPromise = null;
    }
  }

  async getMeta(key, fallbackValue = null) {
    const db = await this.open();
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return fallbackValue;

    const row = await db.table("meta").get(normalizedKey);
    if (!row || !("value" in row)) return fallbackValue;
    return row.value;
  }

  async setMeta(key, value) {
    const db = await this.open();
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return null;

    const nowMs = Date.now();
    const record = {
      key: normalizedKey,
      value: toPlainData(value, value),
      updatedAt: nowMs,
    };

    await db.table("meta").put(record);
    return record;
  }

  async patchMeta(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {};
    }

    const db = await this.open();
    const nowMs = Date.now();
    const entries = Object.entries(record).filter(([key]) =>
      normalizeRecordId(key),
    );

    if (!entries.length) {
      return {};
    }

    await db.transaction("rw", db.table("meta"), async () => {
      for (const [key, value] of entries) {
        await this._setMetaInTx(db, key, value, nowMs);
      }
    });

    return Object.fromEntries(entries);
  }

  async getRevision() {
    const revision = await this.getMeta("revision", 0);
    return normalizeRevision(revision);
  }

  async bumpRevision(reason = "mutation") {
    const db = await this.open();
    let nextRevision = 0;

    await db.transaction("rw", db.table("meta"), async () => {
      nextRevision = await this._bumpRevisionInTx(db, reason, Date.now());
    });

    return nextRevision;
  }

  async markSyncDirty(reason = "mutation") {
    const db = await this.open();
    const nowMs = Date.now();
    await db.transaction("rw", db.table("meta"), async () => {
      await this._setMetaInTx(db, "syncDirty", true, nowMs);
      await this._setMetaInTx(
        db,
        "syncDirtyReason",
        String(reason || "mutation"),
        nowMs,
      );
    });
    return true;
  }

  async commitDelta(delta = {}, options = {}) {
    const db = await this.open();
    const commitRequestedAt = readPersistCommitNow();
    const nowMs = Date.now();
    const normalizedDelta =
      delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
    const upsertNodes = this._normalizeNodeRecords(normalizedDelta.upsertNodes, nowMs);
    const upsertEdges = this._normalizeEdgeRecords(normalizedDelta.upsertEdges, nowMs);
    const tombstones = this._normalizeTombstoneRecords(
      normalizedDelta.tombstones,
      nowMs,
    );
    const deleteNodeIds = toArray(normalizedDelta.deleteNodeIds)
      .map((value) => normalizeRecordId(value))
      .filter(Boolean);
    const deleteEdgeIds = toArray(normalizedDelta.deleteEdgeIds)
      .map((value) => normalizeRecordId(value))
      .filter(Boolean);
    const runtimeMetaPatch =
      normalizedDelta.runtimeMetaPatch &&
      typeof normalizedDelta.runtimeMetaPatch === "object" &&
      !Array.isArray(normalizedDelta.runtimeMetaPatch)
        ? normalizedDelta.runtimeMetaPatch
        : {};
    const reason = String(options.reason || "commitDelta");
    const requestedRevision = normalizeRevision(options.requestedRevision);
    const shouldMarkSyncDirty = options.markSyncDirty !== false;
    const payloadBytes = estimatePersistPayloadBytes(normalizedDelta);
    const normalizedCountDelta =
      normalizedDelta.countDelta &&
      typeof normalizedDelta.countDelta === "object" &&
      !Array.isArray(normalizedDelta.countDelta)
        ? normalizedDelta.countDelta
        : {};

    let nextRevision = 0;
    let counts = {
      nodes: 0,
      edges: 0,
      tombstones: 0,
    };
    let transactionMs = 0;

    const transactionStartedAt = readPersistCommitNow();
    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        if (deleteEdgeIds.length) {
          await db.table("edges").bulkDelete(deleteEdgeIds);
        }
        if (deleteNodeIds.length) {
          await db.table("nodes").bulkDelete(deleteNodeIds);
        }
        if (upsertNodes.length) {
          await db.table("nodes").bulkPut(upsertNodes);
        }
        if (upsertEdges.length) {
          await db.table("edges").bulkPut(upsertEdges);
        }
        if (tombstones.length) {
          await db.table("tombstones").bulkPut(tombstones);
        }

        for (const [rawKey, value] of Object.entries(runtimeMetaPatch)) {
          const key = normalizeRecordId(rawKey);
          if (!key || BME_PERSIST_META_RESERVED_KEYS.has(key)) continue;
          await this._setMetaInTx(db, key, value, nowMs);
        }

        counts = await this._applyCountDeltaMetaInTx(db, normalizedCountDelta, nowMs);
        const currentRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        nextRevision = Math.max(currentRevision + 1, requestedRevision);
        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(db, "lastMutationReason", reason, nowMs);
        await this._setMetaInTx(db, "syncDirty", shouldMarkSyncDirty, nowMs);
        await this._setMetaInTx(
          db,
          "syncDirtyReason",
          shouldMarkSyncDirty ? reason : "",
          nowMs,
        );
      },
    );
    transactionMs = readPersistCommitNow() - transactionStartedAt;

    return {
      revision: nextRevision,
      lastModified: nowMs,
      imported: {
        nodes: counts.nodes,
        edges: counts.edges,
        tombstones: counts.tombstones,
      },
      delta: {
        upsertNodes: upsertNodes.length,
        upsertEdges: upsertEdges.length,
        deleteNodeIds: deleteNodeIds.length,
        deleteEdgeIds: deleteEdgeIds.length,
        tombstones: tombstones.length,
      },
      diagnostics: {
        storageKind: "indexeddb",
        storeMode: "indexeddb",
        queueWaitMs: 0,
        commitMs: normalizePersistCommitMs(
          readPersistCommitNow() - commitRequestedAt,
        ),
        txMs: normalizePersistCommitMs(transactionMs),
        payloadBytes,
        runtimeMetaKeyCount: Object.keys(runtimeMetaPatch).length,
      },
    };
  }

  async bulkUpsertNodes(nodes = []) {
    const records = this._normalizeNodeRecords(nodes);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }

    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        await db.table("nodes").bulkPut(records);
        await this._updateCountMetaInTx(db, nowMs);
        nextRevision = await this._bumpRevisionInTx(
          db,
          "bulkUpsertNodes",
          nowMs,
        );
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(
          db,
          "syncDirtyReason",
          "bulkUpsertNodes",
          nowMs,
        );
      },
    );

    return {
      upserted: records.length,
      revision: nextRevision,
    };
  }

  async bulkUpsertEdges(edges = []) {
    const records = this._normalizeEdgeRecords(edges);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }

    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        await db.table("edges").bulkPut(records);
        await this._updateCountMetaInTx(db, nowMs);
        nextRevision = await this._bumpRevisionInTx(
          db,
          "bulkUpsertEdges",
          nowMs,
        );
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(
          db,
          "syncDirtyReason",
          "bulkUpsertEdges",
          nowMs,
        );
      },
    );

    return {
      upserted: records.length,
      revision: nextRevision,
    };
  }

  async bulkUpsertTombstones(tombstones = []) {
    const records = this._normalizeTombstoneRecords(tombstones);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }

    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        await db.table("tombstones").bulkPut(records);
        await this._updateCountMetaInTx(db, nowMs);
        nextRevision = await this._bumpRevisionInTx(
          db,
          "bulkUpsertTombstones",
          nowMs,
        );
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(
          db,
          "syncDirtyReason",
          "bulkUpsertTombstones",
          nowMs,
        );
      },
    );

    return {
      upserted: records.length,
      revision: nextRevision,
    };
  }

  async listNodes(options = {}) {
    const db = await this.open();
    const includeDeleted = options.includeDeleted !== false;
    const includeArchived = options.includeArchived !== false;

    let records = await db.table("nodes").toArray();

    if (!includeDeleted) {
      records = records.filter(
        (item) => !Number.isFinite(Number(item?.deletedAt)),
      );
    }

    if (!includeArchived) {
      records = records.filter((item) => !item?.archived);
    }

    if (typeof options.type === "string" && options.type.trim()) {
      records = records.filter(
        (item) => String(item?.type || "") === options.type,
      );
    }

    return this._applyListOptions(records, options);
  }

  async listEdges(options = {}) {
    const db = await this.open();
    const includeDeleted = options.includeDeleted !== false;

    let records = await db.table("edges").toArray();

    if (!includeDeleted) {
      records = records.filter(
        (item) => !Number.isFinite(Number(item?.deletedAt)),
      );
    }

    if (typeof options.relation === "string" && options.relation.trim()) {
      records = records.filter(
        (item) => String(item?.relation || "") === options.relation,
      );
    }

    return this._applyListOptions(records, options);
  }

  async listTombstones(options = {}) {
    const db = await this.open();
    let records = await db.table("tombstones").toArray();

    if (typeof options.kind === "string" && options.kind.trim()) {
      records = records.filter(
        (item) => String(item?.kind || "") === options.kind,
      );
    }

    if (typeof options.targetId === "string" && options.targetId.trim()) {
      records = records.filter(
        (item) => String(item?.targetId || "") === options.targetId,
      );
    }

    return this._applyListOptions(records, options);
  }

  async isEmpty(options = {}) {
    const db = await this.open();
    const includeTombstones = options.includeTombstones === true;

    const [nodes, edges, tombstones] = await db.transaction(
      "r",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      async () =>
        await Promise.all([
          db.table("nodes").count(),
          db.table("edges").count(),
          db.table("tombstones").count(),
        ]),
    );

    const empty = includeTombstones
      ? nodes === 0 && edges === 0 && tombstones === 0
      : nodes === 0 && edges === 0;

    return {
      empty,
      nodes,
      edges,
      tombstones,
      includeTombstones,
    };
  }

  async importLegacyGraph(legacyGraph, options = {}) {
    const db = await this.open();
    const nowMs = normalizeTimestamp(options.nowMs, Date.now());
    const migrationSource =
      normalizeRecordId(options.source || "chat_metadata") || "chat_metadata";
    const requestedRetentionMs = Number(options.legacyRetentionMs);
    const legacyRetentionMs =
      Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
        ? Math.floor(requestedRetentionMs)
        : BME_LEGACY_RETENTION_MS;
    const legacyRetentionUntil = nowMs + legacyRetentionMs;

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
      },
    });

    const nodeSourceFloorById = new Map();
    const nodes = this._normalizeNodeRecords(snapshot.nodes, nowMs).map(
      (node) => {
        const sourceFloor = deriveNodeSourceFloor(node);
        nodeSourceFloorById.set(node.id, sourceFloor);
        return sourceFloor == null ? node : { ...node, sourceFloor };
      },
    );
    const edges = this._normalizeEdgeRecords(snapshot.edges, nowMs).map(
      (edge) => {
        const sourceFloor = deriveEdgeSourceFloor(edge, nodeSourceFloorById);
        return sourceFloor == null ? edge : { ...edge, sourceFloor };
      },
    );
    const tombstones = this._normalizeTombstoneRecords(
      snapshot.tombstones,
      nowMs,
    );

    let migrated = false;
    let skipReason = "";
    let nextRevision = await this.getRevision();
    let counts = {
      nodes: 0,
      edges: 0,
      tombstones: 0,
    };

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        const migrationCompletedAt = normalizeTimestamp(
          (await db.table("meta").get("migrationCompletedAt"))?.value,
          0,
        );
        if (migrationCompletedAt > 0) {
          skipReason = "migration-already-completed";
          nextRevision = normalizeRevision(
            (await db.table("meta").get("revision"))?.value,
          );
          counts = {
            nodes: await db.table("nodes").count(),
            edges: await db.table("edges").count(),
            tombstones: await db.table("tombstones").count(),
          };
          return;
        }

        const [nodeCount, edgeCount] = await Promise.all([
          db.table("nodes").count(),
          db.table("edges").count(),
        ]);
        if (nodeCount > 0 || edgeCount > 0) {
          skipReason = "indexeddb-not-empty";
          nextRevision = normalizeRevision(
            (await db.table("meta").get("revision"))?.value,
          );
          counts = {
            nodes: nodeCount,
            edges: edgeCount,
            tombstones: await db.table("tombstones").count(),
          };
          return;
        }

        await Promise.all([
          db.table("nodes").clear(),
          db.table("edges").clear(),
          db.table("tombstones").clear(),
        ]);

        if (nodes.length) {
          await db.table("nodes").bulkPut(nodes);
        }
        if (edges.length) {
          await db.table("edges").bulkPut(edges);
        }
        if (tombstones.length) {
          await db.table("tombstones").bulkPut(tombstones);
        }

        const metaPatch = {
          ...snapshot.meta,
          ...(snapshot.state || {}),
          chatId: this.chatId,
          schemaVersion: BME_DB_SCHEMA_VERSION,
          migrationCompletedAt: nowMs,
          migrationSource,
          legacyRetentionUntil,
        };

        delete metaPatch.revision;

        for (const [key, value] of Object.entries(metaPatch)) {
          if (!normalizeRecordId(key)) continue;
          await this._setMetaInTx(db, key, value, nowMs);
        }

        counts = await this._updateCountMetaInTx(db, nowMs);

        const currentRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        const incomingRevision = normalizeRevision(snapshot.meta?.revision);
        const explicitRevision = normalizeRevision(options.revision);
        const requestedRevision = Number.isFinite(Number(options.revision))
          ? explicitRevision
          : Math.max(incomingRevision, 1);

        nextRevision = Math.max(currentRevision + 1, requestedRevision, 1);
        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(
          db,
          "lastMutationReason",
          "importLegacyGraph",
          nowMs,
        );
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(
          db,
          "syncDirtyReason",
          "legacy-migration",
          nowMs,
        );

        migrated = true;
      },
    );

    return {
      migrated,
      skipped: !migrated,
      reason: migrated ? "migrated" : skipReason || "migration-skipped",
      revision: nextRevision,
      imported: toPlainData(counts, counts),
      migrationCompletedAt: migrated
        ? nowMs
        : normalizeTimestamp(await this.getMeta("migrationCompletedAt", 0), 0),
      migrationSource,
      legacyRetentionUntil,
    };
  }

  async exportSnapshot(options = {}) {
    const db = await this.open();

    const includeTombstones =
      options && typeof options === "object"
        ? options.includeTombstones !== false
        : options !== false;
    let nodes = [];
    let edges = [];
    let tombstones = [];
    let metaRows = [];

    if (includeTombstones) {
      [nodes, edges, tombstones, metaRows] = await db.transaction(
        "r",
        db.table("nodes"),
        db.table("edges"),
        db.table("tombstones"),
        db.table("meta"),
        async () =>
          await Promise.all([
            db.table("nodes").toArray(),
            db.table("edges").toArray(),
            db.table("tombstones").toArray(),
            db.table("meta").toArray(),
          ]),
      );
    } else {
      [nodes, edges, metaRows] = await db.transaction(
        "r",
        db.table("nodes"),
        db.table("edges"),
        db.table("meta"),
        async () =>
          await Promise.all([
            db.table("nodes").toArray(),
            db.table("edges").toArray(),
            db.table("meta").toArray(),
          ]),
      );
    }

    const metaMap = toMetaMap(metaRows);
    const meta = {
      ...metaMap,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      chatId: this.chatId,
      revision: normalizeRevision(metaMap?.revision),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      tombstoneCount: normalizeNonNegativeInteger(
        metaMap?.tombstoneCount,
        tombstones.length,
      ),
    };

    const state = {
      lastProcessedFloor: Number.isFinite(Number(meta.lastProcessedFloor))
        ? Number(meta.lastProcessedFloor)
        : META_DEFAULT_LAST_PROCESSED_FLOOR,
      extractionCount: Number.isFinite(Number(meta.extractionCount))
        ? Number(meta.extractionCount)
        : META_DEFAULT_EXTRACTION_COUNT,
    };

    const snapshot = {
      meta,
      nodes,
      edges,
      tombstones: includeTombstones ? tombstones : [],
      state,
    };

    if (!includeTombstones) {
      snapshot.__stBmeTombstonesOmitted = true;
    }

    return snapshot;
  }

  async exportSnapshotProbe() {
    const db = await this.open();
    const metaRows = await db.transaction("r", db.table("meta"), async () =>
      await db.table("meta").toArray(),
    );
    const metaMap = toMetaMap(metaRows);
    const meta = {
      ...metaMap,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      chatId: this.chatId,
      revision: normalizeRevision(metaMap?.revision),
      nodeCount: normalizeNonNegativeInteger(metaMap?.nodeCount, 0),
      edgeCount: normalizeNonNegativeInteger(metaMap?.edgeCount, 0),
      tombstoneCount: normalizeNonNegativeInteger(metaMap?.tombstoneCount, 0),
    };
    const state = {
      lastProcessedFloor: Number.isFinite(Number(meta.lastProcessedFloor))
        ? Number(meta.lastProcessedFloor)
        : META_DEFAULT_LAST_PROCESSED_FLOOR,
      extractionCount: Number.isFinite(Number(meta.extractionCount))
        ? Number(meta.extractionCount)
        : META_DEFAULT_EXTRACTION_COUNT,
    };
    return {
      meta,
      state,
      nodes: [],
      edges: [],
      tombstones: [],
      __stBmeProbeOnly: true,
      __stBmeTombstonesOmitted: true,
    };
  }

  async importSnapshot(snapshot, options = {}) {
    const db = await this.open();
    const normalizedSnapshot = sanitizeSnapshot(snapshot);
    const mode = normalizeMode(options.mode);
    const shouldMarkSyncDirty = options.markSyncDirty !== false;
    const nowMs = Date.now();

    let nextRevision = 0;
    let counts = {
      nodes: 0,
      edges: 0,
      tombstones: 0,
    };
    let revisionFloor = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        revisionFloor = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );

        if (mode === "replace") {
          await Promise.all([
            db.table("nodes").clear(),
            db.table("edges").clear(),
            db.table("tombstones").clear(),
            db.table("meta").clear(),
          ]);
        }

        const nodes = this._normalizeNodeRecords(
          normalizedSnapshot.nodes,
          nowMs,
        );
        const edges = this._normalizeEdgeRecords(
          normalizedSnapshot.edges,
          nowMs,
        );
        const tombstones = this._normalizeTombstoneRecords(
          normalizedSnapshot.tombstones,
          nowMs,
        );

        if (nodes.length) {
          await db.table("nodes").bulkPut(nodes);
        }
        if (edges.length) {
          await db.table("edges").bulkPut(edges);
        }
        if (tombstones.length) {
          await db.table("tombstones").bulkPut(tombstones);
        }

        const metaPatch = {
          ...(mode === "replace"
            ? createDefaultMetaValues(this.chatId, nowMs)
            : {}),
          ...normalizedSnapshot.meta,
          ...(normalizedSnapshot.state || {}),
          chatId: this.chatId,
          schemaVersion: BME_DB_SCHEMA_VERSION,
        };

        delete metaPatch.revision;

        for (const [key, value] of Object.entries(metaPatch)) {
          if (!normalizeRecordId(key)) continue;
          await this._setMetaInTx(db, key, value, nowMs);
        }

        counts = await this._updateCountMetaInTx(db, nowMs);

        const persistedRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        const currentRevision =
          mode === "replace"
            ? Math.max(revisionFloor, persistedRevision)
            : persistedRevision;

        const incomingRevision = normalizeRevision(
          normalizedSnapshot.meta?.revision,
        );
        const explicitRevision = normalizeRevision(options.revision);
        const requestedRevision = Number.isFinite(Number(options.revision))
          ? explicitRevision
          : options.preserveRevision
            ? incomingRevision
            : currentRevision + 1;

        nextRevision = Math.max(currentRevision + 1, requestedRevision);
        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(
          db,
          "lastMutationReason",
          "importSnapshot",
          nowMs,
        );

        await this._setMetaInTx(db, "syncDirty", shouldMarkSyncDirty, nowMs);
        await this._setMetaInTx(db, "syncDirtyReason", "importSnapshot", nowMs);
      },
    );

    return {
      mode,
      revision: nextRevision,
      imported: {
        nodes: counts.nodes,
        edges: counts.edges,
        tombstones: counts.tombstones,
      },
    };
  }

  async clearAll() {
    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        await Promise.all([
          db.table("nodes").clear(),
          db.table("edges").clear(),
          db.table("tombstones").clear(),
        ]);

        const currentRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        nextRevision = currentRevision + 1;

        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "chatId", this.chatId, nowMs);
        await this._setMetaInTx(
          db,
          "schemaVersion",
          BME_DB_SCHEMA_VERSION,
          nowMs,
        );
        await this._setMetaInTx(db, "nodeCount", 0, nowMs);
        await this._setMetaInTx(db, "edgeCount", 0, nowMs);
        await this._setMetaInTx(db, "tombstoneCount", 0, nowMs);
        await this._setMetaInTx(
          db,
          "lastProcessedFloor",
          META_DEFAULT_LAST_PROCESSED_FLOOR,
          nowMs,
        );
        await this._setMetaInTx(
          db,
          "extractionCount",
          META_DEFAULT_EXTRACTION_COUNT,
          nowMs,
        );
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(db, "lastMutationReason", "clearAll", nowMs);
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(db, "syncDirtyReason", "clearAll", nowMs);
      },
    );

    return {
      cleared: true,
      revision: nextRevision,
    };
  }

  async pruneExpiredTombstones(nowMs = Date.now()) {
    const db = await this.open();
    const normalizedNow = normalizeTimestamp(nowMs, Date.now());
    const cutoffMs = normalizedNow - BME_TOMBSTONE_RETENTION_MS;

    let removedCount = 0;
    let nextRevision = await this.getRevision();

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        const staleIds = await db
          .table("tombstones")
          .where("deletedAt")
          .below(cutoffMs)
          .primaryKeys();

        if (!staleIds.length) {
          return;
        }

        await db.table("tombstones").bulkDelete(staleIds);
        removedCount = staleIds.length;

        await this._updateCountMetaInTx(db, normalizedNow);
        nextRevision = await this._bumpRevisionInTx(
          db,
          "pruneExpiredTombstones",
          normalizedNow,
        );
        await this._setMetaInTx(db, "syncDirty", true, normalizedNow);
        await this._setMetaInTx(
          db,
          "syncDirtyReason",
          "pruneExpiredTombstones",
          normalizedNow,
        );
      },
    );

    return {
      pruned: removedCount,
      revision: nextRevision,
      cutoffMs,
    };
  }

  async _ensureMetaDefaults() {
    const db = await this.open();
    const nowMs = Date.now();
    const defaultMeta = createDefaultMetaValues(this.chatId, nowMs);

    await db.transaction("rw", db.table("meta"), async () => {
      for (const [key, value] of Object.entries(defaultMeta)) {
        const existing = await db.table("meta").get(key);
        if (existing && "value" in existing) continue;
        await this._setMetaInTx(db, key, value, nowMs);
      }
    });
  }

  async _setMetaInTx(db, key, value, nowMs = Date.now()) {
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return;

    await db.table("meta").put({
      key: normalizedKey,
      value: toPlainData(value, value),
      updatedAt: normalizeTimestamp(nowMs, Date.now()),
    });
  }

  async _bumpRevisionInTx(db, reason = "mutation", nowMs = Date.now()) {
    const currentRevision = normalizeRevision(
      (await db.table("meta").get("revision"))?.value,
    );
    const nextRevision = currentRevision + 1;

    await this._setMetaInTx(db, "revision", nextRevision, nowMs);
    await this._setMetaInTx(
      db,
      "lastModified",
      normalizeTimestamp(nowMs),
      nowMs,
    );
    await this._setMetaInTx(
      db,
      "lastMutationReason",
      String(reason || "mutation"),
      nowMs,
    );

    return nextRevision;
  }

  async _updateCountMetaInTx(db, nowMs = Date.now()) {
    const [nodes, edges, tombstones] = await Promise.all([
      db.table("nodes").count(),
      db.table("edges").count(),
      db.table("tombstones").count(),
    ]);

    await this._setMetaInTx(db, "nodeCount", nodes, nowMs);
    await this._setMetaInTx(db, "edgeCount", edges, nowMs);
    await this._setMetaInTx(db, "tombstoneCount", tombstones, nowMs);

    return {
      nodes,
      edges,
      tombstones,
    };
  }

  async _applyCountDeltaMetaInTx(
    db,
    countDelta = null,
    nowMs = Date.now(),
  ) {
    const nextCounts =
      countDelta?.next &&
      typeof countDelta.next === "object" &&
      !Array.isArray(countDelta.next)
        ? countDelta.next
        : null;
    if (nextCounts) {
      const nodes = normalizeNonNegativeInteger(nextCounts.nodes, 0);
      const edges = normalizeNonNegativeInteger(nextCounts.edges, 0);
      const tombstones = normalizeNonNegativeInteger(nextCounts.tombstones, 0);
      await this._setMetaInTx(db, "nodeCount", nodes, nowMs);
      await this._setMetaInTx(db, "edgeCount", edges, nowMs);
      await this._setMetaInTx(db, "tombstoneCount", tombstones, nowMs);
      return {
        nodes,
        edges,
        tombstones,
      };
    }

    const previousCounts =
      countDelta?.previous &&
      typeof countDelta.previous === "object" &&
      !Array.isArray(countDelta.previous)
        ? countDelta.previous
        : null;
    const deltaCounts =
      countDelta?.delta &&
      typeof countDelta.delta === "object" &&
      !Array.isArray(countDelta.delta)
        ? countDelta.delta
        : null;
    if (previousCounts && deltaCounts) {
      const nodes = normalizeNonNegativeInteger(
        Number(previousCounts.nodes || 0) + Number(deltaCounts.nodes || 0),
        0,
      );
      const edges = normalizeNonNegativeInteger(
        Number(previousCounts.edges || 0) + Number(deltaCounts.edges || 0),
        0,
      );
      const tombstones = normalizeNonNegativeInteger(
        Number(previousCounts.tombstones || 0) + Number(deltaCounts.tombstones || 0),
        0,
      );
      await this._setMetaInTx(db, "nodeCount", nodes, nowMs);
      await this._setMetaInTx(db, "edgeCount", edges, nowMs);
      await this._setMetaInTx(db, "tombstoneCount", tombstones, nowMs);
      return {
        nodes,
        edges,
        tombstones,
      };
    }

    return await this._updateCountMetaInTx(db, nowMs);
  }

  _applyListOptions(records, options = {}) {
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

  _normalizeNodeRecords(nodes = [], fallbackNowMs = Date.now()) {
    const nowMs = normalizeTimestamp(fallbackNowMs);
    return toArray(nodes)
      .map((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node))
          return null;
        const id = normalizeRecordId(node.id);
        if (!id) return null;

        return {
          ...node,
          id,
          updatedAt: normalizeTimestamp(node.updatedAt, nowMs),
        };
      })
      .filter(Boolean);
  }

  _normalizeEdgeRecords(edges = [], fallbackNowMs = Date.now()) {
    const nowMs = normalizeTimestamp(fallbackNowMs);
    return toArray(edges)
      .map((edge) => {
        if (!edge || typeof edge !== "object" || Array.isArray(edge))
          return null;
        const id = normalizeRecordId(edge.id);
        if (!id) return null;

        return {
          ...edge,
          id,
          fromId: normalizeRecordId(edge.fromId),
          toId: normalizeRecordId(edge.toId),
          updatedAt: normalizeTimestamp(edge.updatedAt, nowMs),
        };
      })
      .filter(Boolean);
  }

  _normalizeTombstoneRecords(tombstones = [], fallbackNowMs = Date.now()) {
    const nowMs = normalizeTimestamp(fallbackNowMs);
    return toArray(tombstones)
      .map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record))
          return null;

        const id = normalizeRecordId(record.id);
        if (!id) return null;

        return {
          ...record,
          id,
          kind: normalizeRecordId(record.kind),
          targetId: normalizeRecordId(record.targetId),
          sourceDeviceId: normalizeRecordId(record.sourceDeviceId),
          deletedAt: normalizeTimestamp(record.deletedAt, nowMs),
        };
      })
      .filter(Boolean);
  }
}
