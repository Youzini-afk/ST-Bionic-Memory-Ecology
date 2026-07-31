import { createEmptyGraph, deserializeGraph } from "../graph/graph.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";
import {
  BME_DB_SCHEMA_VERSION,
  BME_LEGACY_RETENTION_MS,
  BME_TOMBSTONE_RETENTION_MS,
  buildSnapshotFromGraph,
} from "./bme-db.js";
import { normalizeAuthorityBaseUrl } from "../runtime/authority-capabilities.js";
import { AuthorityHttpClient } from "../runtime/authority-http-client.js";
import {
  buildHostTransactionFence,
  captureHostTransactionContext,
  normalizeHostTransactionContext,
} from "../runtime/host-transaction-context.js";
import {
  GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
  GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
  isAuthorityGraphOperationalMode,
  normalizeGraphAuthorityMeta,
  resolveGraphOperationalMode,
} from "./authority-graph-mode.js";

export const AUTHORITY_GRAPH_STORE_KIND = "authority";
export const AUTHORITY_GRAPH_STORE_MODE = "authority-sql-primary";

const BME_AUTHORITY_MODULE_ID = "third-party.st-bme";
const BME_GRAPH_COMMIT_DELTA_TRANSACTION = "graph.commitDelta";
const BME_GRAPH_GET_HEAD_TRANSACTION = "graph.getHead";
const BME_GRAPH_LOAD_SNAPSHOT_TRANSACTION = "graph.loadSnapshot";
const BME_EXTRACTION_COMMIT_BATCH_TRANSACTION = "extraction.commitBatch";

const META_DEFAULT_LAST_PROCESSED_FLOOR = -1;
const META_DEFAULT_EXTRACTION_COUNT = 0;
const DEFAULT_AUTHORITY_SQL_DATABASE = "default";
const AUTHORITY_SQL_QUERY_ENDPOINT = "/sql/query";
const AUTHORITY_SQL_EXEC_ENDPOINT = "/sql/exec";
const AUTHORITY_SQL_TRANSACTION_ENDPOINT = "/sql/transaction";
const AUTHORITY_SQL_TRANSACTION_BATCH_SIZE = 150;
const AUTHORITY_SQL_TRANSACTION_MAX_REQUEST_BYTES = 1024 * 1024;
const AUTHORITY_SQL_TRANSACTION_SAFE_REQUEST_BYTES = 512 * 1024;

const AUTHORITY_TABLES = Object.freeze({
  meta: "st_bme_graph_meta",
  nodes: "st_bme_graph_nodes",
  edges: "st_bme_graph_edges",
  tombstones: "st_bme_graph_tombstones",
});

const PERSIST_META_RESERVED_KEYS = new Set([
  "revision",
  "lastModified",
  "nodeCount",
  "edgeCount",
  "tombstoneCount",
  "syncDirty",
  "syncDirtyReason",
  "lastMutationReason",
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
  if (Number.isFinite(parsed)) return Math.floor(parsed);
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

function measureJsonBytes(value = null) {
  let json = "";
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = "";
  }
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(json).byteLength;
  }
  return json.length * 3;
}

function normalizeSqlTransactionByteBudget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return AUTHORITY_SQL_TRANSACTION_SAFE_REQUEST_BYTES;
  return Math.max(1024, Math.floor(parsed));
}

function isAuthorityPayloadTooLargeError(error = null) {
  const status = Number(error?.status || error?.payload?.status || 0);
  const category = String(error?.category || error?.payload?.category || "").toLowerCase();
  const code = String(error?.code || error?.payload?.code || error?.payload?.reason || "").toLowerCase();
  const message = String(error?.message || error?.payload?.error || error?.payload?.message || "").toLowerCase();
  return (
    status === 413 ||
    category === "payload-too-large" ||
    category === "limit" ||
    code.includes("length_limit") ||
    code.includes("payload") ||
    message.includes("length limit") ||
    message.includes("payload too large") ||
    message.includes("request entity too large")
  );
}

function createTerminalAuthoritySqlPayloadError(statement = null, cause = null) {
  const estimatedBytes = estimateAuthoritySqlTransactionRequestBytes([statement], DEFAULT_AUTHORITY_SQL_DATABASE);
  const error = new Error(
    `Authority SQL transaction payload is too large for a single graph persistence statement (${estimatedBytes} bytes estimated); refusing endless retry`,
  );
  error.name = "AuthoritySqlPayloadTooLargeError";
  error.status = Number(cause?.status || 413);
  error.code = "authority_sql_payload_too_large";
  error.category = "payload-too-large";
  error.terminal = true;
  error.nonRetryable = true;
  error.estimatedBytes = estimatedBytes;
  error.cause = cause;
  return error;
}

function normalizeAuthorityTransactionStatement(statement = {}) {
  const positional = convertNamedParamsToPositional(String(statement?.sql || ""), statement?.params || {});
  return {
    statement: positional.sql,
    params: positional.params,
  };
}

function estimateAuthoritySqlTransactionRequestBytes(statements = [], database = DEFAULT_AUTHORITY_SQL_DATABASE) {
  return measureJsonBytes({
    database: normalizeRecordId(database) || DEFAULT_AUTHORITY_SQL_DATABASE,
    statements: toArray(statements)
      .filter((statement) => statement?.sql)
      .map(normalizeAuthorityTransactionStatement),
  });
}

function buildAuthoritySqlTransactionChunks(statements = [], options = {}) {
  const normalizedStatements = toArray(statements).filter((statement) => statement?.sql);
  const maxStatements = Math.max(1, Math.floor(Number(options.maxStatements) || AUTHORITY_SQL_TRANSACTION_BATCH_SIZE));
  const maxBytes = normalizeSqlTransactionByteBudget(options.maxBytes);
  const database = normalizeRecordId(options.database) || DEFAULT_AUTHORITY_SQL_DATABASE;
  const chunks = [];
  let current = [];

  const pushCurrent = () => {
    if (current.length) {
      chunks.push(current);
      current = [];
    }
  };

  for (const statement of normalizedStatements) {
    if (!current.length) {
      current.push(statement);
      continue;
    }

    const candidate = [...current, statement];
    const candidateBytes = estimateAuthoritySqlTransactionRequestBytes(candidate, database);
    if (candidate.length > maxStatements || candidateBytes > maxBytes) {
      pushCurrent();
    }
    current.push(statement);
  }

  pushCurrent();
  return chunks;
}

function toPlainData(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
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

function createDefaultMetaValues(chatId = "", nowMs = Date.now()) {
  const normalizedNow = normalizeTimestamp(nowMs);
  return {
    chatId: normalizeChatId(chatId),
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
    storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
    storageMode: AUTHORITY_GRAPH_STORE_MODE,
    authorityOwned: false,
    graphOperationalMode: GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
  };
}

function normalizeMode(value = "replace") {
  return String(value || "").toLowerCase() === "merge" ? "merge" : "replace";
}

function parseJsonValue(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof value === "object") return toPlainData(value, fallbackValue);
  try {
    return JSON.parse(String(value));
  } catch {
    return fallbackValue;
  }
}

function stringifyJsonValue(value) {
  return JSON.stringify(toPlainData(value, value));
}

function readRowValue(row = {}, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return row[key];
    }
  }
  return undefined;
}

function normalizeSqlRows(result = null) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.result?.rows)) return result.result.rows;
  if (Array.isArray(result.results?.[0]?.rows)) return result.results[0].rows;
  return [];
}

function normalizeCountResult(result = null) {
  const row = normalizeSqlRows(result)[0] || {};
  return normalizeNonNegativeInteger(
    readRowValue(row, ["count", "COUNT(*)", "COUNT", "total", "value"]),
    0,
  );
}

function toMetaMap(rows = []) {
  const output = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = normalizeRecordId(readRowValue(row, ["key", "meta_key", "metaKey"]));
    if (!key) continue;
    output[key] = parseJsonValue(
      readRowValue(row, ["valueJson", "value_json", "value"]),
      null,
    );
  }
  return output;
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
  return {
    meta:
      snapshot.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
        ? toPlainData(snapshot.meta, {})
        : {},
    state:
      snapshot.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)
        ? toPlainData(snapshot.state, {})
        : {},
    nodes: toArray(snapshot.nodes).filter(Boolean).map((node) => toPlainData(node, node)),
    edges: toArray(snapshot.edges).filter(Boolean).map((edge) => toPlainData(edge, edge)),
    tombstones: toArray(snapshot.tombstones).filter(Boolean).map((record) => toPlainData(record, record)),
  };
}

function normalizeStateSnapshot(snapshot = {}) {
  const state = snapshot?.state && typeof snapshot.state === "object" ? snapshot.state : {};
  const meta = snapshot?.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
  return {
    lastProcessedFloor: Number.isFinite(Number(state.lastProcessedFloor ?? meta.lastProcessedFloor))
      ? Number(state.lastProcessedFloor ?? meta.lastProcessedFloor)
      : META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: Number.isFinite(Number(state.extractionCount ?? meta.extractionCount))
      ? Number(state.extractionCount ?? meta.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT,
  };
}

function buildModuleGraphSnapshot(response = {}, chatId = "", options = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response) || response.ok === false) {
    throw new Error("AuthorityGraphStore: graph.loadSnapshot returned an invalid response");
  }
  if (response.unchanged === true) {
    throw new Error("AuthorityGraphStore: graph.loadSnapshot unexpectedly omitted the snapshot payload");
  }

  const includeTombstones = options.includeTombstones !== false;
  const normalized = sanitizeSnapshot(response);
  const state = normalizeStateSnapshot(normalized);
  const meta = {
    ...createDefaultMetaValues(chatId),
    ...normalized.meta,
    ...state,
    schemaVersion: BME_DB_SCHEMA_VERSION,
    authorityGraphSchemaVersion: normalizeNonNegativeInteger(response.schemaVersion, 0),
    chatId: normalizeChatId(chatId),
    revision: normalizeRevision(response.revision ?? normalized.meta?.revision),
    headHash: String(response.headHash || normalized.meta?.headHash || ""),
    nodeCount: normalized.nodes.length,
    edgeCount: normalized.edges.length,
    tombstoneCount: includeTombstones
      ? normalized.tombstones.length
      : normalizeNonNegativeInteger(normalized.meta?.tombstoneCount, normalized.tombstones.length),
    storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
    storageMode: AUTHORITY_GRAPH_STORE_MODE,
    authorityOwned: true,
    graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  };
  const snapshot = {
    meta,
    nodes: normalized.nodes,
    edges: normalized.edges,
    tombstones: includeTombstones ? normalized.tombstones : [],
    state,
  };
  if (!includeTombstones) snapshot.__stBmeTombstonesOmitted = true;
  return snapshot;
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

function normalizeNodeRecords(nodes = [], fallbackNowMs = Date.now()) {
  const nowMs = normalizeTimestamp(fallbackNowMs);
  return toArray(nodes)
    .map((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return null;
      const id = normalizeRecordId(node.id);
      if (!id) return null;
      return {
        ...toPlainData(node, node),
        id,
        updatedAt: normalizeTimestamp(node.updatedAt, nowMs),
      };
    })
    .filter(Boolean);
}

function normalizeEdgeRecords(edges = [], fallbackNowMs = Date.now()) {
  const nowMs = normalizeTimestamp(fallbackNowMs);
  return toArray(edges)
    .map((edge) => {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) return null;
      const id = normalizeRecordId(edge.id);
      if (!id) return null;
      return {
        ...toPlainData(edge, edge),
        id,
        fromId: normalizeRecordId(edge.fromId),
        toId: normalizeRecordId(edge.toId),
        updatedAt: normalizeTimestamp(edge.updatedAt, nowMs),
      };
    })
    .filter(Boolean);
}

function normalizeTombstoneRecords(tombstones = [], fallbackNowMs = Date.now()) {
  const nowMs = normalizeTimestamp(fallbackNowMs);
  return toArray(tombstones)
    .map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const id = normalizeRecordId(record.id);
      if (!id) return null;
      return {
        ...toPlainData(record, record),
        id,
        kind: normalizeRecordId(record.kind),
        targetId: normalizeRecordId(record.targetId),
        sourceDeviceId: normalizeRecordId(record.sourceDeviceId),
        deletedAt: normalizeTimestamp(record.deletedAt, nowMs),
      };
    })
    .filter(Boolean);
}

function normalizePayloadRows(rows = []) {
  return normalizeSqlRows(rows)
    .map((row) =>
      parseJsonValue(readRowValue(row, ["payloadJson", "payload_json", "payload"]), null),
    )
    .filter((record) => record && typeof record === "object" && !Array.isArray(record));
}

function normalizeUpsertCountDelta(delta = {}) {
  const source = delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
  const next = source.next && typeof source.next === "object" ? source.next : null;
  if (!next) {
    const previous =
      source.previous && typeof source.previous === "object" ? source.previous : null;
    const deltaCounts =
      source.delta && typeof source.delta === "object" ? source.delta : null;
    if (!previous || !deltaCounts) return null;
    return {
      nodes: normalizeNonNegativeInteger(
        Number(previous.nodes || 0) + Number(deltaCounts.nodes || 0),
        0,
      ),
      edges: normalizeNonNegativeInteger(
        Number(previous.edges || 0) + Number(deltaCounts.edges || 0),
        0,
      ),
      tombstones: normalizeNonNegativeInteger(
        Number(previous.tombstones || 0) + Number(deltaCounts.tombstones || 0),
        0,
      ),
    };
  }
  return {
    nodes: normalizeNonNegativeInteger(next.nodes, 0),
    edges: normalizeNonNegativeInteger(next.edges, 0),
    tombstones: normalizeNonNegativeInteger(next.tombstones, 0),
  };
}

export function convertNamedParamsToPositional(sql, params = {}) {
  if (Array.isArray(params)) return { sql, params };
  if (!params || typeof params !== "object") return { sql, params: [] };
  const names = [];
  const positionalSql = sql.replace(/(?<!:):(\w+)/g, (_, name) => {
    names.push(name);
    return "?";
  });
  if (!names.length) return { sql: positionalSql, params: [] };
  const positionalParams = names.map((name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return null;
    return params[name];
  });
  return { sql: positionalSql, params: positionalParams };
}

export class AuthoritySqlHttpClient {
  constructor(options = {}) {
    this.http = new AuthorityHttpClient({
      ...options,
      baseUrl: normalizeAuthorityBaseUrl(options.baseUrl),
    });
    this.database = normalizeRecordId(options.database) || DEFAULT_AUTHORITY_SQL_DATABASE;
  }

  async query(sql, params = {}) {
    const positional = convertNamedParamsToPositional(String(sql || ""), params);
    return await this._request(AUTHORITY_SQL_QUERY_ENDPOINT, {
      database: this.database,
      statement: positional.sql,
      params: positional.params,
    });
  }

  async execute(sql, params = {}) {
    const positional = convertNamedParamsToPositional(String(sql || ""), params);
    return await this._request(AUTHORITY_SQL_EXEC_ENDPOINT, {
      database: this.database,
      statement: positional.sql,
      params: positional.params,
    });
  }

  async transaction(statements = []) {
    return await this._request(AUTHORITY_SQL_TRANSACTION_ENDPOINT, {
      database: this.database,
      statements: toArray(statements)
        .filter((statement) => statement?.sql)
        .map(normalizeAuthorityTransactionStatement),
    });
  }

  async _request(path, body = {}) {
    return await this.http.requestJson(path, {
      method: "POST",
      body,
      session: true,
    });
  }
}

export function createAuthoritySqlClient(options = {}) {
  if (options.sqlClient && typeof options.sqlClient === "object") {
    return options.sqlClient;
  }
  return new AuthoritySqlHttpClient(options);
}

/**
 * Phase F: structured error thrown by `AuthorityGraphStore.commitDelta` when
 * the companion module `graph.commitDelta` transaction returns a 409
 * `transaction_conflict`. Callers (graph-persistence-io) MUST NOT fall back
 * to the local chunked path on this error — they fetch a fresh head via
 * `graph.getHead`, rebuild the delta against the new revision, and retry
 * once. On a second conflict, the error surfaces and the extraction floor /
 * processed-message hashes are NOT advanced.
 *
 * The `serverRevision` and `headHash` fields are populated from the DOA
 * error payload `details` when present so the caller can decide whether the
 * retry can use the cached baseRevision or needs a fresh getHead.
 */
export class AuthorityGraphCommitConflictError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthorityGraphCommitConflictError";
    this.code = "transaction_conflict";
    this.category = "transaction-conflict";
    this.status = Number(options.status || 409);
    this.serverRevision = Number.isFinite(Number(options.serverRevision))
      ? Number(options.serverRevision)
      : null;
    this.baseRevision = Number.isFinite(Number(options.baseRevision))
      ? Number(options.baseRevision)
      : null;
    this.headHash = String(options.headHash || "");
    this.payload = toPlainData(options.payload, null);
    this.cause = options.cause || null;
  }
}

export class AuthorityGraphModuleUnavailableError extends Error {
  constructor(message = "BME authority graph module unavailable", options = {}) {
    super(message);
    this.name = "AuthorityGraphModuleUnavailableError";
    this.code = "authority_module_unavailable";
    this.status = Number(options.status || 503);
    this.category = "module-unavailable";
    this.authorityOwned = options.authorityOwned === true;
    this.graphOperationalMode = resolveGraphOperationalMode({
      authorityOwned: this.authorityOwned,
      graphOperationalMode: options.graphOperationalMode,
    });
    this.payload = toPlainData(options.payload, null);
    this.cause = options.cause || null;
  }
}

function isBmeGraphCommitConflictError(error = null) {
  if (!error) return false;
  if (error instanceof AuthorityGraphCommitConflictError) return true;
  const code = String(error?.code || error?.payload?.details?.code || error?.payload?.code || "").toLowerCase();
  return code === "transaction_conflict";
}

function isRetryableAuthorityTransportError(error = null) {
  if (!error || isBmeGraphCommitConflictError(error)) return false;
  if (error?.name === "AbortError") return false;
  const status = Number(error?.status || error?.payload?.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

function sha1Hash(input) {
  // JS fallback: FNV-1a 32-bit, hex-prefixed. Not cryptographically secure,
  // but stable across a single chat+revision+delta shape which is all
  // idempotency key needs. (The server-side idempotency layer re-fingerprints
  // with its own JSON.stringify + sha256; we just need a stable client-side
  // key so retries of the same logical request collide on the same idem key.)
  let hash = 0x811c9dc5;
  const text = String(input ?? "");
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function computeDeltaFingerprintHash(value) {
  let json = "";
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    json = "";
  }
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    try {
      const encoded = new TextEncoder().encode(json);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
      const bytes = new Uint8Array(digest);
      let hex = "";
      for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, "0");
      }
      return `sha256:${hex}`;
    } catch {
      // fallthrough to JS fallback
    }
  }
  return sha1Hash(json);
}

function stripVolatileJournalIdentity(journal = null) {
  const clone = toPlainData(journal, {});
  if (!clone || typeof clone !== "object" || Array.isArray(clone)) return {};
  delete clone.id;
  delete clone.createdAt;
  return clone;
}

function stripGeneratedRecordTimestampsForFingerprint(records = [], rawRecords = [], timestampKeys = ["updatedAt"]) {
  const rawArray = toArray(rawRecords);
  return toArray(records).map((record, index) => {
    const clone = toPlainData(record, record) || {};
    const raw = rawArray[index] && typeof rawArray[index] === "object" && !Array.isArray(rawArray[index])
      ? rawArray[index]
      : {};
    for (const key of timestampKeys) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) delete clone[key];
    }
    return clone;
  });
}

function buildStableExtractionDeltaFingerprintShape(rawDelta = {}, normalizedDelta = {}) {
  const raw = rawDelta && typeof rawDelta === "object" && !Array.isArray(rawDelta) ? rawDelta : {};
  return {
    ...toPlainData(normalizedDelta, normalizedDelta),
    upsertNodes: stripGeneratedRecordTimestampsForFingerprint(normalizedDelta.upsertNodes, raw.upsertNodes, ["updatedAt"]),
    upsertEdges: stripGeneratedRecordTimestampsForFingerprint(normalizedDelta.upsertEdges, raw.upsertEdges, ["updatedAt"]),
    tombstones: stripGeneratedRecordTimestampsForFingerprint(normalizedDelta.tombstones, raw.tombstones, ["deletedAt"]),
  };
}

function normalizeFingerprintToken(value = "") {
  return String(value || "")
    .replace(/^[a-z0-9]+:/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 48) || "0";
}

export class AuthorityGraphStore {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.options = options;
    this.storeKind = AUTHORITY_GRAPH_STORE_KIND;
    this.storeMode = AUTHORITY_GRAPH_STORE_MODE;
    this.sqlClient = createAuthoritySqlClient(options);
    // Phase F: companion module `graph.commitDelta` readiness. When
    // `bmeGraphCommitReady === true` AND
    // `isAuthorityModuleGraphCommitReady === true`, `commitDelta` switches
    // to the server-side atomic transaction (CAS + idempotency). On
    // `transaction_conflict`, it throws `AuthorityGraphCommitConflictError`
    // so the caller can fetch a fresh head and retry once. On other module
    // errors (module_not_loaded, timeout, network, ...), it falls back to
    // the existing local chunked `commitDeltaLocal` path.
    this.bmeGraphCommitReady = Boolean(options.bmeGraphCommitReady);
    this.isAuthorityModuleGraphCommitReady = Boolean(
      options.isAuthorityModuleGraphCommitReady ?? options.bmeGraphCommitReady,
    );
    this.bmeExtractionCommitBatchReady = Boolean(options.bmeExtractionCommitBatchReady);
    this.isAuthorityModuleExtractionCommitBatchReady = Boolean(
      options.isAuthorityModuleExtractionCommitBatchReady ?? options.bmeExtractionCommitBatchReady,
    );
    this.bmeGraphModuleClient = options.bmeGraphModuleClient || null;
    this._setInMemoryAuthorityMeta({
      authorityOwned: options.authorityOwned === true,
      graphOperationalMode: options.graphOperationalMode,
    });
    this._openPromise = null;
    this._opened = false;
  }

  async open() {
    if (this._opened) return this;
    if (!this._openPromise) {
      this._openPromise = (async () => {
        await this._ensureSchema();
        await this._ensureMetaDefaults();
        this._opened = true;
        return this;
      })().catch((error) => {
        this._openPromise = null;
        this._opened = false;
        throw error;
      });
    }
    return await this._openPromise;
  }

  async close() {
    if (typeof this.sqlClient?.close === "function") {
      await this.sqlClient.close();
    }
    this._opened = false;
    this._openPromise = null;
  }

  getStorageDiagnosticsSync() {
    return {
      formatVersion: 1,
      migrationState: "idle",
      resolvedStoreMode: this.storeMode,
      storageKind: this.storeKind,
      browserCacheMode: "minimal",
    };
  }

  async getMeta(key, fallbackValue = null) {
    await this.open();
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return fallbackValue;
    const rows = await this._query(
      `SELECT meta_key AS key, value_json AS valueJson FROM ${AUTHORITY_TABLES.meta} WHERE chat_id = :chatId AND meta_key = :key LIMIT 1`,
      { chatId: this.chatId, key: normalizedKey },
    );
    const row = normalizeSqlRows(rows)[0] || null;
    if (!row) return fallbackValue;
    return parseJsonValue(readRowValue(row, ["valueJson", "value_json", "value"]), fallbackValue);
  }

  async setMeta(key, value) {
    await this.open();
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return null;
    const nowMs = Date.now();
    await this._executeStatements([this._upsertMetaStatement(normalizedKey, value, nowMs)]);
    return {
      key: normalizedKey,
      value: toPlainData(value, value),
      updatedAt: nowMs,
    };
  }

  async patchMeta(record) {
    await this.open();
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {};
    }
    const nowMs = Date.now();
    const entries = Object.entries(record).filter(([key]) => normalizeRecordId(key));
    if (!entries.length) return {};
    await this._executeStatements(
      entries.map(([key, value]) => this._upsertMetaStatement(key, value, nowMs)),
    );
    return Object.fromEntries(entries);
  }

  async getRevision() {
    return normalizeRevision(await this.getMeta("revision", 0));
  }

  async bumpRevision(reason = "mutation") {
    await this.open();
    const nowMs = Date.now();
    const nextRevision = (await this.getRevision()) + 1;
    await this._executeStatements([
      this._upsertMetaStatement("revision", nextRevision, nowMs),
      this._upsertMetaStatement("lastModified", nowMs, nowMs),
      this._upsertMetaStatement("lastMutationReason", reason, nowMs),
    ]);
    return nextRevision;
  }

  async markSyncDirty(reason = "mutation") {
    await this.patchMeta({
      syncDirty: true,
      syncDirtyReason: String(reason || "mutation"),
    });
    return true;
  }

  async commitDelta(delta = {}, options = {}) {
    // Phase F: when DOA + companion module `graph.commitDelta` are available,
    // switch the primary write path to the server-side atomic transaction
    // (atomic SQL transaction + per-chat lock + CAS + idempotency).
    // On `transaction_conflict` (409 from the CAS check), do NOT fall back
    // to the local chunked path — surface `AuthorityGraphCommitConflictError`
    // so the caller can fetch a fresh head, rebuild the delta, and retry
    // once. On other module errors (module_not_loaded, timeout, network,
    // validation_error other than CAS), fall back to the local chunked
    // `commitDeltaLocal` path (acceptable degradation) and log the fallback.
    const authorityMeta = await this._resolveAuthorityMeta(options);
    if (this._shouldUseBmeGraphCommit()) {
      try {
        return await this.commitDeltaViaModule(delta, options);
      } catch (error) {
        if (isBmeGraphCommitConflictError(error)) {
          // CAS conflict — do NOT fall back to local write. Re-throw as a
          // structured conflict error carrying serverRevision/headHash when
          // available so the caller can rebuild the delta.
          throw error instanceof AuthorityGraphCommitConflictError
            ? error
            : new AuthorityGraphCommitConflictError(
                error?.message || "BME graph.commitDelta transaction_conflict",
                {
                  status: error?.status || 409,
                  serverRevision: error?.payload?.details?.serverRevision,
                  baseRevision: error?.payload?.details?.baseRevision,
                  headHash: error?.payload?.details?.headHash,
                  payload: error?.payload,
                  cause: error,
                },
              );
        }
        if (this._isAuthorityPrimaryOrDegraded(authorityMeta)) {
          this._setInMemoryAuthorityMeta({
            authorityOwned: true,
            graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
          });
          throw new AuthorityGraphModuleUnavailableError(
            error?.message || "BME graph.commitDelta module transaction unavailable",
            {
              cause: error,
              payload: error?.payload,
              authorityOwned: true,
              graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
            },
          );
        }
        // Other local-only module errors — preserve local chunked fallback.
        console.warn(
          `[ST-BME] graph.commitDelta module transaction failed, falling back to local chunked commit:`,
          error?.message || error,
        );
        return await this.commitDeltaLocal(delta, options);
      }
    }
    if (this._isAuthorityPrimaryOrDegraded(authorityMeta)) {
      this._setInMemoryAuthorityMeta({
        authorityOwned: true,
        graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
      });
      throw new AuthorityGraphModuleUnavailableError(
        "BME graph.commitDelta module is not ready for authority-owned graph",
        {
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
        },
      );
    }
    return await this.commitDeltaLocal(delta, options);
  }

  async _resolveAuthorityMeta(options = {}) {
    const explicit = normalizeGraphAuthorityMeta({
      authorityOwned: options.authorityOwned === true || this.authorityOwned === true,
      graphOperationalMode: options.graphOperationalMode || this.graphOperationalMode,
    });
    try {
      const persisted = normalizeGraphAuthorityMeta({
        authorityOwned:
          explicit.authorityOwned === true ||
          (await this.getMeta("authorityOwned", explicit.authorityOwned)) === true,
        graphOperationalMode: explicit.authorityOwned === true
          ? explicit.graphOperationalMode
          : await this.getMeta("graphOperationalMode", explicit.graphOperationalMode),
      });
      return this._setInMemoryAuthorityMeta(persisted);
    } catch {
      return this._setInMemoryAuthorityMeta(explicit);
    }
  }

  _setInMemoryAuthorityMeta(meta = {}) {
    const normalized = normalizeGraphAuthorityMeta(meta);
    this.authorityOwned = normalized.authorityOwned;
    this.graphOperationalMode = normalized.graphOperationalMode;
    return normalized;
  }

  _isAuthorityPrimaryOrDegraded(meta = null) {
    const normalized = normalizeGraphAuthorityMeta(meta || {
      authorityOwned: this.authorityOwned,
      graphOperationalMode: this.graphOperationalMode,
    });
    return normalized.authorityOwned || isAuthorityGraphOperationalMode(normalized.graphOperationalMode);
  }

  _shouldUseBmeGraphCommit() {
    return Boolean(
      this.bmeGraphCommitReady &&
        this.isAuthorityModuleGraphCommitReady &&
        (this.bmeGraphModuleClient ||
          (this.sqlClient?.http && typeof this.sqlClient.http.requestModuleTransaction === "function")),
    );
  }

  _shouldUseBmeExtractionCommitBatch() {
    return Boolean(
      this.bmeExtractionCommitBatchReady &&
        this.isAuthorityModuleExtractionCommitBatchReady &&
        (this.bmeGraphModuleClient ||
          (this.sqlClient?.http && typeof this.sqlClient.http.requestModuleTransaction === "function")),
    );
  }

  async commitExtractionBatch(input = {}, options = {}) {
    await this.open();
    const commitRequestedAt = readPersistCommitNow();
    if (!this._shouldUseBmeExtractionCommitBatch()) {
      this._setInMemoryAuthorityMeta({
        authorityOwned: true,
        graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
      });
      throw new AuthorityGraphModuleUnavailableError(
        "BME extraction.commitBatch module is not ready for authority-owned graph",
        {
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
        },
      );
    }

    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const journal = source.committedBatchJournalEntry || source.journal;
    if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
      throw new Error("AuthorityGraphStore.commitExtractionBatch requires committedBatchJournalEntry/journal");
    }
    const rangeSource = source.processedRange || journal.processedRange || [];
    const processedRange = Array.isArray(rangeSource)
      ? { startFloor: Number(rangeSource[0]), endFloor: Number(rangeSource[1]) }
      : {
          startFloor: Number(rangeSource.startFloor ?? rangeSource.start ?? rangeSource[0]),
          endFloor: Number(rangeSource.endFloor ?? rangeSource.end ?? rangeSource[1]),
        };
    const nextLastProcessedFloor = Number(
      source.nextLastProcessedFloor ?? source.lastProcessedAssistantFloor ?? processedRange.endFloor,
    );
    const previousLastProcessedFloor = Number(
      source.previousLastProcessedFloor ?? journal?.stateBefore?.lastProcessedAssistantFloor ?? -1,
    );
    const previousExtractionCount = Number(source.extractionCountBefore ?? source.previousExtractionCount ?? 0);
    const nextExtractionCount = Number(
      source.extractionCountAfter ?? source.nextExtractionCount ?? previousExtractionCount + 1,
    );
    const normalizedDelta = source.persistDelta && typeof source.persistDelta === "object" && !Array.isArray(source.persistDelta)
      ? source.persistDelta
      : (source.delta && typeof source.delta === "object" && !Array.isArray(source.delta) ? source.delta : {});
    const nowMs = Date.now();
    const delta = {
      upsertNodes: normalizeNodeRecords(normalizedDelta.upsertNodes, nowMs),
      upsertEdges: normalizeEdgeRecords(normalizedDelta.upsertEdges, nowMs),
      tombstones: normalizeTombstoneRecords(normalizedDelta.tombstones, nowMs),
      deleteNodeIds: toArray(normalizedDelta.deleteNodeIds).map(normalizeRecordId).filter(Boolean),
      deleteEdgeIds: toArray(normalizedDelta.deleteEdgeIds).map(normalizeRecordId).filter(Boolean),
      countDelta: normalizedDelta.countDelta && typeof normalizedDelta.countDelta === "object" ? normalizedDelta.countDelta : null,
      runtimeMetaPatch: {
        ...(normalizedDelta.runtimeMetaPatch && typeof normalizedDelta.runtimeMetaPatch === "object" && !Array.isArray(normalizedDelta.runtimeMetaPatch)
          ? normalizedDelta.runtimeMetaPatch
          : {}),
        authorityOwned: true,
        graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
      },
    };
    const client = this._getBmeGraphModuleClient();
    const hostContext =
      normalizeHostTransactionContext(options.hostContext || source.hostContext) ||
      captureHostTransactionContext({
        context: globalThis.SillyTavern?.getContext?.() || null,
      });
    const hostTransaction =
      source.hostTransaction && typeof source.hostTransaction === "object"
        ? source.hostTransaction
        : buildHostTransactionFence(hostContext, hostContext);
    try {
      let head = null;
      if (typeof client.bmeGraphGetHead === "function") {
        head = await client.bmeGraphGetHead(
          {
            chatId: this.chatId,
            collectionId: String(this.options.collectionId || this.options.namespace || source.collectionId || ""),
            ...(this.options.database ? { database: this.options.database } : {}),
          },
          {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(hostContext ? { hostContext } : {}),
          },
        );
      }
      const baseRevision = Number.isFinite(Number(options.baseRevision ?? source.baseRevision))
        ? normalizeRevision(options.baseRevision ?? source.baseRevision)
        : normalizeRevision(head?.revision ?? await this.getRevision());
      const stableFingerprint = await computeDeltaFingerprintHash({
        chatId: this.chatId,
        database: this.options.database || "",
        collectionId: String(this.options.collectionId || this.options.namespace || source.collectionId || ""),
        baseRevision,
        processedRange,
        extraction: {
          previousLastProcessedFloor,
          nextLastProcessedFloor,
          previousExtractionCount,
          nextExtractionCount,
        },
        messageHashes: toArray(source.messageHashes),
        pruneMessageHashesFromFloor: source.pruneMessageHashesFromFloor ?? null,
        delta: buildStableExtractionDeltaFingerprintShape(normalizedDelta, delta),
        journal: stripVolatileJournalIdentity(journal),
        hostTransaction,
        options: {
          reason: String(options.reason || source.reason || "extraction-batch-complete"),
          markSyncDirty: options.markSyncDirty !== false,
          vectorDirty: options.vectorDirty ?? source.vectorDirty ?? (toArray(source.messageHashes).length > 0),
          dirtyFromFloor: options.dirtyFromFloor ?? source.dirtyFromFloor ?? processedRange.startFloor,
        },
      });
      const batchId = `batch-${normalizeFingerprintToken(stableFingerprint)}`;
      const idempotencyKey = String(
        options.idempotencyKey || source.idempotencyKey || `extraction:${this.chatId}:${batchId}`,
      );
      const transactionInput = {
        chatId: this.chatId,
        collectionId: String(this.options.collectionId || this.options.namespace || source.collectionId || ""),
        baseRevision,
        batchId,
        idempotencyKey,
        processedRange,
        extraction: {
          previousLastProcessedFloor,
          nextLastProcessedFloor,
          previousExtractionCount,
          nextExtractionCount,
        },
        messageHashes: toArray(source.messageHashes),
        pruneMessageHashesFromFloor: source.pruneMessageHashesFromFloor ?? null,
        delta,
        journal,
        ...(hostTransaction ? { hostTransaction } : {}),
        options: {
          reason: String(options.reason || source.reason || "extraction-batch-complete"),
          markSyncDirty: options.markSyncDirty !== false,
          vectorDirty: options.vectorDirty ?? source.vectorDirty ?? (toArray(source.messageHashes).length > 0),
          dirtyFromFloor: options.dirtyFromFloor ?? source.dirtyFromFloor ?? processedRange.startFloor,
        },
        ...(this.options.database ? { database: this.options.database } : {}),
      };

      const requestOptions = {
        idempotencyKey,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(hostContext ? { hostContext } : {}),
      };
      let response = null;
      try {
        response = await client.bmeExtractionCommitBatch(
          transactionInput,
          requestOptions,
        );
      } catch (error) {
        if (!isRetryableAuthorityTransportError(error)) throw error;
        response = await client.bmeExtractionCommitBatch(
          transactionInput,
          requestOptions,
        );
      }
      const revision = normalizeRevision(response?.revision);
      const committedAtMs = Number.isFinite(Number(response?.committedAt))
        ? Number(response.committedAt)
        : Date.parse(String(response?.committedAt || ""));
      const lastModified = Number.isFinite(committedAtMs) ? Math.floor(committedAtMs) : nowMs;
      try {
        await this.patchMeta({
          revision,
          headHash: String(response?.headHash || ""),
          lastProcessedFloor: nextLastProcessedFloor,
          lastProcessedAssistantFloor: nextLastProcessedFloor,
          extractionCount: nextExtractionCount,
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
          lastBatchId: batchId,
          lastModified,
          ...(hostContext
            ? {
                hostConversationId: hostContext.conversationId,
                hostBranchId: hostContext.branchId,
                hostRevision: hostContext.hostRevision,
                hostCommitEventId:
                  hostContext.commitEventId || hostContext.sourceEventId || "",
                hostCommitTransactionId: hostContext.commitTransactionId || "",
              }
            : {}),
        });
      } catch (metaPatchError) {
        console.warn(`[ST-BME] extraction.commitBatch local meta cache patch failed after server commit:`, metaPatchError?.message || metaPatchError);
      }
      this._setInMemoryAuthorityMeta({ authorityOwned: true, graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY });
      return {
        saved: true,
        accepted: true,
        queued: false,
        blocked: false,
        storageTier: "authority-sql",
        acceptedBy: BME_EXTRACTION_COMMIT_BATCH_TRANSACTION,
        saveMode: BME_EXTRACTION_COMMIT_BATCH_TRANSACTION,
        reason: String(options.reason || source.reason || "extraction-batch-complete"),
        revision,
        headHash: String(response?.headHash || ""),
        batchId,
        batchJournalDurable: true,
        authorityOwned: true,
        graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
        extraction: response?.extraction || { lastProcessedAssistantFloor: nextLastProcessedFloor, extractionCount: nextExtractionCount },
        diagnostics: {
          commitPath: BME_EXTRACTION_COMMIT_BATCH_TRANSACTION,
          idempotencyKey,
          baseRevision,
          hostRevision: Number(hostContext?.hostRevision || 0),
          hostBranchId: String(hostContext?.branchId || ""),
          commitMs: normalizePersistCommitMs(readPersistCommitNow() - commitRequestedAt),
          statementCount: Number(response?.statementCount || 0),
        },
      };
    } catch (error) {
      if (isBmeGraphCommitConflictError(error)) {
        throw error instanceof AuthorityGraphCommitConflictError
          ? error
          : new AuthorityGraphCommitConflictError(error?.message || "BME extraction.commitBatch transaction_conflict", {
              status: error?.status || 409,
              serverRevision: error?.payload?.details?.serverRevision,
              baseRevision: error?.payload?.details?.baseRevision,
              headHash: error?.payload?.details?.headHash,
              payload: error?.payload,
              cause: error,
            });
      }
      this._setInMemoryAuthorityMeta({ authorityOwned: true, graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED });
      throw new AuthorityGraphModuleUnavailableError(
        error?.message || "BME extraction.commitBatch module transaction unavailable",
        {
          cause: error,
          status: error?.status || 503,
          payload: error?.payload,
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
        },
      );
    }
  }

  /**
   * Phase F: server-side atomic commit via the BME companion module
   * `graph.commitDelta` transaction. Builds the module transaction input
   * from the existing delta + options shape, lifts an idempotencyKey to
   * the envelope (the manifest declares `idempotency:"required"`), calls
   * `requestModuleTransaction`, and unwraps `response.result` into a shape
   * compatible with the existing local `commitDeltaLocal` return value.
   */
  async commitDeltaViaModule(delta = {}, options = {}) {
    await this.open();
    const commitRequestedAt = readPersistCommitNow();
    const normalizedDelta = delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
    const nowMs = Date.now();
    const upsertNodes = normalizeNodeRecords(normalizedDelta.upsertNodes, nowMs);
    const upsertEdges = normalizeEdgeRecords(normalizedDelta.upsertEdges, nowMs);
    const tombstones = normalizeTombstoneRecords(normalizedDelta.tombstones, nowMs);
    const deleteNodeIds = toArray(normalizedDelta.deleteNodeIds).map(normalizeRecordId).filter(Boolean);
    const deleteEdgeIds = toArray(normalizedDelta.deleteEdgeIds).map(normalizeRecordId).filter(Boolean);
    const runtimeMetaPatch =
      normalizedDelta.runtimeMetaPatch &&
      typeof normalizedDelta.runtimeMetaPatch === "object" &&
      !Array.isArray(normalizedDelta.runtimeMetaPatch)
        ? normalizedDelta.runtimeMetaPatch
        : {};
    const moduleRuntimeMetaPatch = {
      ...runtimeMetaPatch,
      authorityOwned: true,
      graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
    };
    const reason = String(options.reason || "commitDelta");
    const requestedRevision = normalizeRevision(options.requestedRevision);
    const shouldMarkSyncDirty = options.markSyncDirty !== false;
    const vectorDirtyHint = Boolean(options.vectorDirtyHint);
    const payloadBytes = estimatePersistPayloadBytes(normalizedDelta);

    // The CAS expected value is the caller's view of the current server
    // revision. When options.requestedRevision is supplied, the caller has
    // already chosen the next revision they want; the server expects the
    // *base* (current) revision, so we subtract 1 only when the caller
    // supplied an explicit floor that is one above the local view. We
    // can't always know the server revision locally, so we read it from
    // the local meta row (kept in sync on every prior commit). If the
    // local view disagrees with the server (out-of-band writer), the CAS
    // will throw transaction_conflict and the caller rebuilds.
    const localRevision = await this.getRevision();
    const baseRevision =
      Number.isFinite(Number(options.baseRevision)) && Number(options.baseRevision) >= 0
        ? normalizeRevision(options.baseRevision)
        : requestedRevision > 0 && requestedRevision <= localRevision + 1
          ? localRevision
          : localRevision;

    const transactionInput = {
      chatId: this.chatId,
      collectionId: String(this.options.collectionId || this.options.namespace || ""),
      baseRevision,
      delta: {
        upsertNodes,
        upsertEdges,
        tombstones,
        deleteNodeIds,
        deleteEdgeIds,
        runtimeMetaPatch: moduleRuntimeMetaPatch,
        countDelta: normalizedDelta.countDelta && typeof normalizedDelta.countDelta === "object"
          ? normalizedDelta.countDelta
          : null,
      },
      options: {
        markSyncDirty: shouldMarkSyncDirty,
        vectorDirtyHint,
        reason,
      },
      ...(this.options.database ? { database: this.options.database } : {}),
    };

    const idempotencyKey =
      typeof options.idempotencyKey === "string" && options.idempotencyKey.trim()
        ? options.idempotencyKey.trim()
        : `${this.chatId}:${baseRevision}:${await computeDeltaFingerprintHash(transactionInput)}`;

    const client = this._getBmeGraphModuleClient();
    const response = await client.bmeGraphCommit(transactionInput, {
      idempotencyKey,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.hostContext !== undefined
        ? { hostContext: options.hostContext }
        : {}),
    });

    const nextRevision = normalizeRevision(response?.revision);
    const committedLastModified = Number(response?.committedAt) || nowMs;
    const counts = {
      nodes: normalizeNonNegativeInteger(response?.counts?.nodeCount, 0),
      edges: normalizeNonNegativeInteger(response?.counts?.edgeCount, 0),
      tombstones: normalizeNonNegativeInteger(response?.counts?.tombstoneCount, 0),
    };
    const applied = response?.applied && typeof response.applied === "object" ? response.applied : {};

    // Mirror the local meta cache so subsequent commits in the same session
    // can compute baseRevision without an extra round-trip. This is best-
    // effort: if the local write fails (e.g. transient SQL error), the
    // next commitDeltaViaModule call will still send a possibly-stale
    // baseRevision and the server CAS will catch the divergence.
    try {
      await this.patchMeta({
        revision: nextRevision,
        lastModified: committedLastModified,
        lastMutationReason: reason,
        syncDirty: shouldMarkSyncDirty,
        syncDirtyReason: shouldMarkSyncDirty ? reason : "",
        nodeCount: counts.nodes,
        edgeCount: counts.edges,
        tombstoneCount: counts.tombstones,
        authorityOwned: true,
        graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
        ...(response?.headHash ? { headHash: String(response.headHash) } : {}),
      });
    } catch (metaPatchError) {
      console.warn(
        `[ST-BME] graph.commitDelta local meta cache patch failed after server commit:`,
        metaPatchError?.message || metaPatchError,
      );
    }
    this._setInMemoryAuthorityMeta({
      authorityOwned: true,
      graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
    });

    return {
      revision: nextRevision,
      lastModified: committedLastModified,
      headHash: String(response?.headHash || ""),
      imported: counts,
      delta: {
        upsertNodes: Number(applied.upsertedNodes ?? upsertNodes.length) || 0,
        upsertEdges: Number(applied.upsertedEdges ?? upsertEdges.length) || 0,
        deleteNodeIds: Number(applied.deletedNodeIds ?? deleteNodeIds.length) || 0,
        deleteEdgeIds: Number(applied.deletedEdgeIds ?? deleteEdgeIds.length) || 0,
        tombstones: Number(applied.upsertedTombstones ?? tombstones.length) || 0,
      },
      diagnostics: {
        storageKind: AUTHORITY_GRAPH_STORE_KIND,
        storeMode: AUTHORITY_GRAPH_STORE_MODE,
        commitPath: "bme-module",
        queueWaitMs: 0,
        commitMs: normalizePersistCommitMs(readPersistCommitNow() - commitRequestedAt),
        txMs: 0,
        payloadBytes,
        runtimeMetaKeyCount: Object.keys(moduleRuntimeMetaPatch).length,
        browserCacheMode: "minimal",
        idempotencyKey,
        baseRevision,
        serverRevision: nextRevision,
      },
    };
  }

  async getHead(options = {}) {
    if (this._shouldUseBmeGraphCommit()) {
      const client = this._getBmeGraphModuleClient();
      const response = await client.bmeGraphGetHead(
        {
          chatId: this.chatId,
          collectionId: String(this.options.collectionId || this.options.namespace || ""),
          ...(this.options.database ? { database: this.options.database } : {}),
        },
        {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        },
      );
      return {
        ok: response?.ok !== false,
        chatId: String(response?.chatId || this.chatId),
        revision: normalizeRevision(response?.revision),
        headHash: String(response?.headHash || ""),
        source: "bme-module",
      };
    }

    const authorityMeta = await this._resolveAuthorityMeta(options);
    if (this._isAuthorityPrimaryOrDegraded(authorityMeta)) {
      throw new AuthorityGraphModuleUnavailableError(
        "BME graph.getHead module is not ready for authority-owned graph",
        {
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
        },
      );
    }
    const snapshot = await this.exportSnapshot({ includeTombstones: false });
    return {
      ok: true,
      chatId: this.chatId,
      revision: normalizeRevision(snapshot?.meta?.revision),
      headHash: String(snapshot?.meta?.headHash || ""),
      source: "local-snapshot",
    };
  }

  _getBmeGraphModuleClient() {
    if (this.bmeGraphModuleClient) return this.bmeGraphModuleClient;
    // Lazily synthesize a thin client on top of the sqlClient's http transport
    // when an explicit bmeGraphModuleClient was not injected. This reuses the
    // same AuthorityHttpClient session as the SQL path so the companion
    // module transactions share the same session token.
    const http = this.sqlClient?.http;
    if (!http || typeof http.requestModuleTransaction !== "function") {
      throw new Error("AuthorityGraphStore: BME graph module client unavailable (no http transport on sqlClient)");
    }
    return {
      async bmeGraphCommit(input, options = {}) {
        const idempotencyKey =
          (options.idempotencyKey ? String(options.idempotencyKey) : "") ||
          (input?.idempotencyKey ? String(input.idempotencyKey) : undefined);
        const response = await http.requestModuleTransaction(
          BME_AUTHORITY_MODULE_ID,
          BME_GRAPH_COMMIT_DELTA_TRANSACTION,
          input,
          {
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.hostContext !== undefined ? { hostContext: options.hostContext } : {}),
          },
        );
        return response?.result ?? response ?? {};
      },
      async bmeGraphGetHead(input, options = {}) {
        const response = await http.requestModuleTransaction(
          BME_AUTHORITY_MODULE_ID,
          BME_GRAPH_GET_HEAD_TRANSACTION,
          input,
          {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.hostContext !== undefined ? { hostContext: options.hostContext } : {}),
          },
        );
        return response?.result ?? response ?? {};
      },
      async bmeGraphLoadSnapshot(input, options = {}) {
        const response = await http.requestModuleTransaction(
          BME_AUTHORITY_MODULE_ID,
          BME_GRAPH_LOAD_SNAPSHOT_TRANSACTION,
          input,
          {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.hostContext !== undefined ? { hostContext: options.hostContext } : {}),
          },
        );
        return response?.result ?? response ?? {};
      },
      async bmeExtractionCommitBatch(input, options = {}) {
        const idempotencyKey =
          (options.idempotencyKey ? String(options.idempotencyKey) : "") ||
          (input?.idempotencyKey ? String(input.idempotencyKey) : undefined);
        const response = await http.requestModuleTransaction(
          BME_AUTHORITY_MODULE_ID,
          BME_EXTRACTION_COMMIT_BATCH_TRANSACTION,
          input,
          {
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.hostContext !== undefined ? { hostContext: options.hostContext } : {}),
          },
        );
        return response?.result ?? response ?? {};
      },
    };
  }

  async commitDeltaLocal(delta = {}, options = {}) {
    await this.open();
    const commitRequestedAt = readPersistCommitNow();
    const nowMs = Date.now();
    const normalizedDelta = delta && typeof delta === "object" && !Array.isArray(delta) ? delta : {};
    const upsertNodes = normalizeNodeRecords(normalizedDelta.upsertNodes, nowMs);
    const upsertEdges = normalizeEdgeRecords(normalizedDelta.upsertEdges, nowMs);
    const tombstones = normalizeTombstoneRecords(normalizedDelta.tombstones, nowMs);
    const deleteNodeIds = toArray(normalizedDelta.deleteNodeIds).map(normalizeRecordId).filter(Boolean);
    const deleteEdgeIds = toArray(normalizedDelta.deleteEdgeIds).map(normalizeRecordId).filter(Boolean);
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
    const currentRevision = await this.getRevision();
    const nextRevision = Math.max(currentRevision + 1, requestedRevision);
    const statements = [];

    for (const id of deleteEdgeIds) statements.push(this._deleteByIdStatement(AUTHORITY_TABLES.edges, id));
    for (const id of deleteNodeIds) statements.push(this._deleteByIdStatement(AUTHORITY_TABLES.nodes, id));
    for (const node of upsertNodes) statements.push(this._upsertNodeStatement(node));
    for (const edge of upsertEdges) statements.push(this._upsertEdgeStatement(edge));
    for (const tombstone of tombstones) statements.push(this._upsertTombstoneStatement(tombstone));
    for (const [rawKey, value] of Object.entries(runtimeMetaPatch)) {
      const key = normalizeRecordId(rawKey);
      if (!key || PERSIST_META_RESERVED_KEYS.has(key)) continue;
      statements.push(this._upsertMetaStatement(key, value, nowMs));
    }

    let counts = normalizeUpsertCountDelta(normalizedDelta.countDelta);
    if (counts) {
      statements.push(this._upsertMetaStatement("nodeCount", counts.nodes, nowMs));
      statements.push(this._upsertMetaStatement("edgeCount", counts.edges, nowMs));
      statements.push(this._upsertMetaStatement("tombstoneCount", counts.tombstones, nowMs));
    }
    statements.push(this._upsertMetaStatement("chatId", this.chatId, nowMs));
    statements.push(this._upsertMetaStatement("schemaVersion", BME_DB_SCHEMA_VERSION, nowMs));
    statements.push(this._upsertMetaStatement("storagePrimary", AUTHORITY_GRAPH_STORE_KIND, nowMs));
    statements.push(this._upsertMetaStatement("storageMode", AUTHORITY_GRAPH_STORE_MODE, nowMs));
    statements.push(this._upsertMetaStatement("revision", nextRevision, nowMs));
    statements.push(this._upsertMetaStatement("lastModified", nowMs, nowMs));
    statements.push(this._upsertMetaStatement("lastMutationReason", reason, nowMs));
    statements.push(this._upsertMetaStatement("syncDirty", shouldMarkSyncDirty, nowMs));
    statements.push(this._upsertMetaStatement("syncDirtyReason", shouldMarkSyncDirty ? reason : "", nowMs));

    const transactionStartedAt = readPersistCommitNow();
    await this._executeStatements(statements);
    const transactionMs = readPersistCommitNow() - transactionStartedAt;
    if (!counts) {
      counts = await this._readCounts();
      await this.patchMeta({
        nodeCount: counts.nodes,
        edgeCount: counts.edges,
        tombstoneCount: counts.tombstones,
      });
    }

    return {
      revision: nextRevision,
      lastModified: nowMs,
      imported: counts,
      delta: {
        upsertNodes: upsertNodes.length,
        upsertEdges: upsertEdges.length,
        deleteNodeIds: deleteNodeIds.length,
        deleteEdgeIds: deleteEdgeIds.length,
        tombstones: tombstones.length,
      },
      diagnostics: {
        storageKind: AUTHORITY_GRAPH_STORE_KIND,
        storeMode: AUTHORITY_GRAPH_STORE_MODE,
        queueWaitMs: 0,
        commitMs: normalizePersistCommitMs(readPersistCommitNow() - commitRequestedAt),
        txMs: normalizePersistCommitMs(transactionMs),
        payloadBytes,
        runtimeMetaKeyCount: Object.keys(runtimeMetaPatch).length,
        browserCacheMode: "minimal",
      },
    };
  }

  async bulkUpsertNodes(nodes = []) {
    const records = normalizeNodeRecords(nodes);
    if (!records.length) {
      return { upserted: 0, revision: await this.getRevision() };
    }
    const result = await this.commitDelta({ upsertNodes: records }, { reason: "bulkUpsertNodes" });
    return { upserted: records.length, revision: result.revision };
  }

  async bulkUpsertEdges(edges = []) {
    const records = normalizeEdgeRecords(edges);
    if (!records.length) {
      return { upserted: 0, revision: await this.getRevision() };
    }
    const result = await this.commitDelta({ upsertEdges: records }, { reason: "bulkUpsertEdges" });
    return { upserted: records.length, revision: result.revision };
  }

  async bulkUpsertTombstones(tombstones = []) {
    const records = normalizeTombstoneRecords(tombstones);
    if (!records.length) {
      return { upserted: 0, revision: await this.getRevision() };
    }
    const result = await this.commitDelta({ tombstones: records }, { reason: "bulkUpsertTombstones" });
    return { upserted: records.length, revision: result.revision };
  }

  async listNodes(options = {}) {
    await this.open();
    let records = normalizePayloadRows(
      await this._query(`SELECT payload_json AS payloadJson FROM ${AUTHORITY_TABLES.nodes} WHERE chat_id = :chatId`, {
        chatId: this.chatId,
      }),
    );
    if (options.includeDeleted === false) {
      records = records.filter((item) => !Number.isFinite(Number(item?.deletedAt)));
    }
    if (options.includeArchived === false) {
      records = records.filter((item) => !item?.archived);
    }
    if (typeof options.type === "string" && options.type.trim()) {
      records = records.filter((item) => String(item?.type || "") === options.type);
    }
    return applyListOptions(records, options);
  }

  async listEdges(options = {}) {
    await this.open();
    let records = normalizePayloadRows(
      await this._query(`SELECT payload_json AS payloadJson FROM ${AUTHORITY_TABLES.edges} WHERE chat_id = :chatId`, {
        chatId: this.chatId,
      }),
    );
    if (options.includeDeleted === false) {
      records = records.filter((item) => !Number.isFinite(Number(item?.deletedAt)));
    }
    if (typeof options.relation === "string" && options.relation.trim()) {
      records = records.filter((item) => String(item?.relation || "") === options.relation);
    }
    return applyListOptions(records, options);
  }

  async listTombstones(options = {}) {
    await this.open();
    let records = normalizePayloadRows(
      await this._query(`SELECT payload_json AS payloadJson FROM ${AUTHORITY_TABLES.tombstones} WHERE chat_id = :chatId`, {
        chatId: this.chatId,
      }),
    );
    if (typeof options.kind === "string" && options.kind.trim()) {
      records = records.filter((item) => String(item?.kind || "") === options.kind);
    }
    if (typeof options.targetId === "string" && options.targetId.trim()) {
      records = records.filter((item) => String(item?.targetId || "") === options.targetId);
    }
    return applyListOptions(records, options);
  }

  async isEmpty(options = {}) {
    await this.open();
    const counts = await this._readCounts();
    const includeTombstones = options.includeTombstones === true;
    return {
      empty: includeTombstones
        ? counts.nodes === 0 && counts.edges === 0 && counts.tombstones === 0
        : counts.nodes === 0 && counts.edges === 0,
      nodes: counts.nodes,
      edges: counts.edges,
      tombstones: counts.tombstones,
      includeTombstones,
    };
  }

  async importLegacyGraph(legacyGraph, options = {}) {
    await this.open();
    const nowMs = normalizeTimestamp(options.nowMs, Date.now());
    const migrationSource = normalizeRecordId(options.source || "chat_metadata") || "chat_metadata";
    const requestedRetentionMs = Number(options.legacyRetentionMs);
    const legacyRetentionMs =
      Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
        ? Math.floor(requestedRetentionMs)
        : BME_LEGACY_RETENTION_MS;
    const legacyRetentionUntil = nowMs + legacyRetentionMs;
    const migrationCompletedAt = normalizeTimestamp(await this.getMeta("migrationCompletedAt", 0), 0);
    if (migrationCompletedAt > 0) {
      const counts = await this._readCounts();
      return {
        migrated: false,
        skipped: true,
        reason: "migration-already-completed",
        revision: await this.getRevision(),
        imported: counts,
        migrationCompletedAt,
        migrationSource,
        legacyRetentionUntil: normalizeTimestamp(await this.getMeta("legacyRetentionUntil", 0), 0),
      };
    }
    const emptyStatus = await this.isEmpty();
    if (!emptyStatus?.empty) {
      return {
        migrated: false,
        skipped: true,
        reason: "authority-store-not-empty",
        revision: await this.getRevision(),
        imported: {
          nodes: emptyStatus.nodes,
          edges: emptyStatus.edges,
          tombstones: emptyStatus.tombstones,
        },
        isEmptyCheck: {
          empty: false,
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
      revision: normalizeRevision(options.revision ?? runtimeLegacyGraph?.__stBmePersistence?.revision),
      meta: {
        migrationCompletedAt: nowMs,
        migrationSource,
        legacyRetentionUntil,
        storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
        storageMode: AUTHORITY_GRAPH_STORE_MODE,
      },
    });
    const importResult = await this.importSnapshot(snapshot, {
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

  async exportSnapshot(options = {}) {
    await this.open();
    const includeTombstones = options && typeof options === "object" ? options.includeTombstones !== false : options !== false;
    const normalizedOptions = options && typeof options === "object" ? options : {};
    const authorityMeta = await this._resolveAuthorityMeta(normalizedOptions);
    if (this._shouldUseBmeGraphCommit()) {
      try {
        const client = this._getBmeGraphModuleClient();
        if (typeof client.bmeGraphLoadSnapshot !== "function") {
          throw new Error("AuthorityGraphStore: BME graph.loadSnapshot module client unavailable");
        }
        const allowCrossLineageRead = normalizedOptions.allowCrossLineageRead === true;
        const hostContext = allowCrossLineageRead
          ? null
          : normalizeHostTransactionContext(normalizedOptions.hostContext) ||
            captureHostTransactionContext({
              context: globalThis.SillyTavern?.getContext?.() || null,
            });
        const response = await client.bmeGraphLoadSnapshot(
          {
            chatId: this.chatId,
            collectionId: String(this.options.collectionId || this.options.namespace || ""),
            ...(this.options.database ? { database: this.options.database } : {}),
          },
          {
            ...(normalizedOptions.signal !== undefined ? { signal: normalizedOptions.signal } : {}),
            ...(normalizedOptions.timeoutMs !== undefined ? { timeoutMs: normalizedOptions.timeoutMs } : {}),
            // Parent snapshots are read only while creating a child branch.
            // Requiring an explicit opt-in keeps ordinary loads host-scoped.
            hostContext,
          },
        );
        const snapshot = buildModuleGraphSnapshot(response, this.chatId, {
          includeTombstones,
        });
        this._setInMemoryAuthorityMeta(snapshot.meta);
        return snapshot;
      } catch (error) {
        const status = Number(error?.status || error?.payload?.status || 0);
        if (status === 409) {
          // A lineage/revision conflict is authoritative. Never bypass it by
          // reading the same rows through the raw SQL compatibility path.
          throw error;
        }
        if (this._isAuthorityPrimaryOrDegraded(authorityMeta)) {
          this._setInMemoryAuthorityMeta({
            authorityOwned: true,
            graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
          });
          throw new AuthorityGraphModuleUnavailableError(
            error?.message || "BME graph.loadSnapshot module transaction unavailable",
            {
              cause: error,
              payload: error?.payload,
              authorityOwned: true,
              graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
            },
          );
        }
        console.warn(
          `[ST-BME] graph.loadSnapshot module transaction failed, falling back to the legacy SQL snapshot read:`,
          error?.message || error,
        );
      }
    } else if (this._isAuthorityPrimaryOrDegraded(authorityMeta)) {
      this._setInMemoryAuthorityMeta({
        authorityOwned: true,
        graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
      });
      throw new AuthorityGraphModuleUnavailableError(
        "BME graph.loadSnapshot module is not ready for authority-owned graph",
        {
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
        },
      );
    }
    const [metaRows, nodes, edges, tombstones] = await Promise.all([
      this._query(`SELECT meta_key AS key, value_json AS valueJson FROM ${AUTHORITY_TABLES.meta} WHERE chat_id = :chatId`, {
        chatId: this.chatId,
      }),
      this.listNodes(),
      this.listEdges(),
      includeTombstones ? this.listTombstones() : Promise.resolve([]),
    ]);
    const metaMap = toMetaMap(normalizeSqlRows(metaRows));
    const meta = {
      ...createDefaultMetaValues(this.chatId),
      ...metaMap,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      chatId: this.chatId,
      revision: normalizeRevision(metaMap?.revision),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      tombstoneCount: includeTombstones
        ? tombstones.length
        : normalizeNonNegativeInteger(metaMap?.tombstoneCount, 0),
      storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
      storageMode: AUTHORITY_GRAPH_STORE_MODE,
      ...normalizeGraphAuthorityMeta(metaMap),
    };
    const snapshot = {
      meta,
      nodes,
      edges,
      tombstones: includeTombstones ? tombstones : [],
      state: normalizeStateSnapshot({ meta }),
    };
    if (!includeTombstones) snapshot.__stBmeTombstonesOmitted = true;
    return snapshot;
  }

  async exportSnapshotProbe() {
    const snapshot = await this.exportSnapshot({ includeTombstones: false });
    return {
      ...snapshot,
      nodes: [],
      edges: [],
      tombstones: [],
      __stBmeProbeOnly: true,
      __stBmeTombstonesOmitted: true,
    };
  }

  async importSnapshot(snapshot, options = {}) {
    await this.open();
    const normalizedSnapshot = sanitizeSnapshot(snapshot);
    const mode = normalizeMode(options.mode);
    const shouldMarkSyncDirty = options.markSyncDirty !== false;
    const nowMs = Date.now();
    const currentRevision = await this.getRevision();
    const nodes = normalizeNodeRecords(normalizedSnapshot.nodes, nowMs);
    const edges = normalizeEdgeRecords(normalizedSnapshot.edges, nowMs);
    const tombstones = normalizeTombstoneRecords(normalizedSnapshot.tombstones, nowMs);
    const state = normalizeStateSnapshot(normalizedSnapshot);
    const metaPatch = {
      ...(mode === "replace" ? createDefaultMetaValues(this.chatId, nowMs) : {}),
      ...normalizedSnapshot.meta,
      ...state,
      chatId: this.chatId,
      schemaVersion: BME_DB_SCHEMA_VERSION,
      storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
      storageMode: AUTHORITY_GRAPH_STORE_MODE,
      ...normalizeGraphAuthorityMeta(normalizedSnapshot.meta),
    };
    delete metaPatch.revision;

    const statements = [];
    if (mode === "replace") {
      statements.push(this._deleteChatRowsStatement(AUTHORITY_TABLES.nodes));
      statements.push(this._deleteChatRowsStatement(AUTHORITY_TABLES.edges));
      statements.push(this._deleteChatRowsStatement(AUTHORITY_TABLES.tombstones));
      statements.push(this._deleteChatRowsStatement(AUTHORITY_TABLES.meta));
    }
    for (const node of nodes) statements.push(this._upsertNodeStatement(node));
    for (const edge of edges) statements.push(this._upsertEdgeStatement(edge));
    for (const tombstone of tombstones) statements.push(this._upsertTombstoneStatement(tombstone));
    for (const [key, value] of Object.entries(metaPatch)) {
      if (!normalizeRecordId(key)) continue;
      statements.push(this._upsertMetaStatement(key, value, nowMs));
    }

    const incomingRevision = normalizeRevision(normalizedSnapshot.meta?.revision);
    const explicitRevision = normalizeRevision(options.revision);
    const requestedRevision = Number.isFinite(Number(options.revision))
      ? explicitRevision
      : options.preserveRevision
        ? incomingRevision
        : currentRevision + 1;
    const nextRevision = Math.max(currentRevision + 1, requestedRevision);
    statements.push(this._upsertMetaStatement("revision", nextRevision, nowMs));
    statements.push(this._upsertMetaStatement("lastModified", nowMs, nowMs));
    statements.push(this._upsertMetaStatement("lastMutationReason", "importSnapshot", nowMs));
    statements.push(this._upsertMetaStatement("syncDirty", shouldMarkSyncDirty, nowMs));
    statements.push(this._upsertMetaStatement("syncDirtyReason", "importSnapshot", nowMs));
    statements.push(this._upsertMetaStatement("nodeCount", nodes.length, nowMs));
    statements.push(this._upsertMetaStatement("edgeCount", edges.length, nowMs));
    statements.push(this._upsertMetaStatement("tombstoneCount", tombstones.length, nowMs));
    await this._executeStatements(statements);
    this._setInMemoryAuthorityMeta(metaPatch);

    return {
      mode,
      revision: nextRevision,
      imported: {
        nodes: nodes.length,
        edges: edges.length,
        tombstones: tombstones.length,
      },
    };
  }

  async clearAll() {
    await this.open();
    const nowMs = Date.now();
    const nextRevision = (await this.getRevision()) + 1;
    await this._executeStatements([
      this._deleteChatRowsStatement(AUTHORITY_TABLES.nodes),
      this._deleteChatRowsStatement(AUTHORITY_TABLES.edges),
      this._deleteChatRowsStatement(AUTHORITY_TABLES.tombstones),
      this._upsertMetaStatement("revision", nextRevision, nowMs),
      this._upsertMetaStatement("chatId", this.chatId, nowMs),
      this._upsertMetaStatement("schemaVersion", BME_DB_SCHEMA_VERSION, nowMs),
      this._upsertMetaStatement("storagePrimary", AUTHORITY_GRAPH_STORE_KIND, nowMs),
      this._upsertMetaStatement("storageMode", AUTHORITY_GRAPH_STORE_MODE, nowMs),
      this._upsertMetaStatement("authorityOwned", this.authorityOwned === true, nowMs),
      this._upsertMetaStatement(
        "graphOperationalMode",
        this.authorityOwned === true ? this.graphOperationalMode : GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
        nowMs,
      ),
      this._upsertMetaStatement("nodeCount", 0, nowMs),
      this._upsertMetaStatement("edgeCount", 0, nowMs),
      this._upsertMetaStatement("tombstoneCount", 0, nowMs),
      this._upsertMetaStatement("lastProcessedFloor", META_DEFAULT_LAST_PROCESSED_FLOOR, nowMs),
      this._upsertMetaStatement("extractionCount", META_DEFAULT_EXTRACTION_COUNT, nowMs),
      this._upsertMetaStatement("lastModified", nowMs, nowMs),
      this._upsertMetaStatement("lastMutationReason", "clearAll", nowMs),
      this._upsertMetaStatement("syncDirty", true, nowMs),
      this._upsertMetaStatement("syncDirtyReason", "clearAll", nowMs),
    ]);
    return {
      cleared: true,
      revision: nextRevision,
    };
  }

  async pruneExpiredTombstones(nowMs = Date.now()) {
    await this.open();
    const normalizedNow = normalizeTimestamp(nowMs, Date.now());
    const cutoffMs = normalizedNow - BME_TOMBSTONE_RETENTION_MS;
    const rows = await this._query(
      `SELECT record_id AS id FROM ${AUTHORITY_TABLES.tombstones} WHERE chat_id = :chatId AND deleted_at < :cutoffMs`,
      { chatId: this.chatId, cutoffMs },
    );
    const ids = normalizeSqlRows(rows)
      .map((row) => normalizeRecordId(readRowValue(row, ["id", "record_id", "recordId"])))
      .filter(Boolean);
    if (!ids.length) {
      return {
        pruned: 0,
        revision: await this.getRevision(),
      };
    }
    const nextRevision = (await this.getRevision()) + 1;
    await this._executeStatements([
      ...ids.map((id) => this._deleteByIdStatement(AUTHORITY_TABLES.tombstones, id)),
      this._upsertMetaStatement("revision", nextRevision, normalizedNow),
      this._upsertMetaStatement("lastModified", normalizedNow, normalizedNow),
      this._upsertMetaStatement("lastMutationReason", "pruneExpiredTombstones", normalizedNow),
      this._upsertMetaStatement("syncDirty", true, normalizedNow),
      this._upsertMetaStatement("syncDirtyReason", "pruneExpiredTombstones", normalizedNow),
    ]);
    const counts = await this._readCounts();
    await this.patchMeta({ tombstoneCount: counts.tombstones });
    return {
      pruned: ids.length,
      revision: nextRevision,
    };
  }

  async _ensureSchema() {
    await this._executeStatements([
      {
        sql: `CREATE TABLE IF NOT EXISTS ${AUTHORITY_TABLES.meta} (chat_id TEXT NOT NULL, meta_key TEXT NOT NULL, value_json TEXT, updated_at INTEGER, PRIMARY KEY(chat_id, meta_key))`,
        params: {},
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS ${AUTHORITY_TABLES.nodes} (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, node_type TEXT, source_floor INTEGER, archived INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(chat_id, record_id))`,
        params: {},
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS ${AUTHORITY_TABLES.edges} (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, from_id TEXT, to_id TEXT, relation TEXT, source_floor INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(chat_id, record_id))`,
        params: {},
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS ${AUTHORITY_TABLES.tombstones} (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, tombstone_kind TEXT, target_id TEXT, deleted_at INTEGER, source_device_id TEXT, PRIMARY KEY(chat_id, record_id))`,
        params: {},
      },
    ]);
  }

  async _ensureMetaDefaults() {
    const nowMs = Date.now();
    const defaultMeta = createDefaultMetaValues(this.chatId, nowMs);
    const metaRows = await this._query(
      `SELECT meta_key AS key, value_json AS valueJson FROM ${AUTHORITY_TABLES.meta} WHERE chat_id = :chatId`,
      { chatId: this.chatId },
    );
    const existingMeta = toMetaMap(normalizeSqlRows(metaRows));
    const statements = [];
    for (const [key, value] of Object.entries(defaultMeta)) {
      if (Object.prototype.hasOwnProperty.call(existingMeta, key)) continue;
      statements.push(this._upsertMetaStatement(key, value, nowMs));
    }
    await this._executeStatements(statements);
  }

  async _readCounts() {
    const [nodes, edges, tombstones] = await Promise.all([
      this._query(`SELECT COUNT(*) AS count FROM ${AUTHORITY_TABLES.nodes} WHERE chat_id = :chatId`, { chatId: this.chatId }),
      this._query(`SELECT COUNT(*) AS count FROM ${AUTHORITY_TABLES.edges} WHERE chat_id = :chatId`, { chatId: this.chatId }),
      this._query(`SELECT COUNT(*) AS count FROM ${AUTHORITY_TABLES.tombstones} WHERE chat_id = :chatId`, { chatId: this.chatId }),
    ]);
    return {
      nodes: normalizeCountResult(nodes),
      edges: normalizeCountResult(edges),
      tombstones: normalizeCountResult(tombstones),
    };
  }

  async _query(sql, params = {}) {
    if (typeof this.sqlClient?.query === "function") {
      return await this.sqlClient.query(sql, params);
    }
    if (typeof this.sqlClient === "function") {
      return await this.sqlClient({ action: "query", sql, params });
    }
    throw new Error("Authority SQL query unavailable");
  }

  async _execute(sql, params = {}) {
    if (typeof this.sqlClient?.execute === "function") {
      return await this.sqlClient.execute(sql, params);
    }
    if (typeof this.sqlClient === "function") {
      return await this.sqlClient({ action: "execute", sql, params });
    }
    throw new Error("Authority SQL execute unavailable");
  }

  async _executeStatements(statements = []) {
    const normalizedStatements = toArray(statements).filter((statement) => statement?.sql);
    if (!normalizedStatements.length) return null;

    if (typeof this.sqlClient?.transaction === "function") {
      let lastResult = null;
      const chunks = this._buildTransactionChunks(normalizedStatements);
      for (const batch of chunks) {
        lastResult = await this._executeTransactionChunk(batch);
      }
      return lastResult;
    }

    const upsertStatements = [];
    const deleteStatements = [];
    for (const stmt of normalizedStatements) {
      if (stmt.sql.trim().toUpperCase().startsWith("DELETE")) {
        deleteStatements.push(stmt);
      } else {
        upsertStatements.push(stmt);
      }
    }
    let result = null;
    for (const stmt of upsertStatements) {
      result = await this._execute(stmt.sql, stmt.params || {});
    }
    for (const stmt of deleteStatements) {
      result = await this._execute(stmt.sql, stmt.params || {});
    }
    if (deleteStatements.length > 0 && upsertStatements.length > 0) {
      console.warn("[ST-BME] _executeStatements fallback 路径执行：先 upsert 后 delete，无事务保护", {
        chatId: this.chatId,
        upsertCount: upsertStatements.length,
        deleteCount: deleteStatements.length,
      });
    }
    return result;
  }

  _buildTransactionChunks(statements = []) {
    const budget = normalizeSqlTransactionByteBudget(
      this.options?.sqlTransactionMaxBytes ?? this.options?.authoritySqlTransactionMaxBytes,
    );
    const maxBytes = Math.min(
      AUTHORITY_SQL_TRANSACTION_MAX_REQUEST_BYTES - 64 * 1024,
      Math.max(1024, budget),
    );
    return buildAuthoritySqlTransactionChunks(statements, {
      database: this.sqlClient?.database || DEFAULT_AUTHORITY_SQL_DATABASE,
      maxStatements: this.options?.sqlTransactionBatchSize ?? AUTHORITY_SQL_TRANSACTION_BATCH_SIZE,
      maxBytes,
    });
  }

  async _executeTransactionChunk(batch = []) {
    const normalizedBatch = toArray(batch).filter((statement) => statement?.sql);
    if (!normalizedBatch.length) return null;
    try {
      return await this.sqlClient.transaction(normalizedBatch);
    } catch (error) {
      if (!isAuthorityPayloadTooLargeError(error)) {
        throw error;
      }
      if (normalizedBatch.length <= 1) {
        throw createTerminalAuthoritySqlPayloadError(normalizedBatch[0], error);
      }
      const mid = Math.max(1, Math.floor(normalizedBatch.length / 2));
      const left = normalizedBatch.slice(0, mid);
      const right = normalizedBatch.slice(mid);
      const leftResult = await this._executeTransactionChunk(left);
      const rightResult = await this._executeTransactionChunk(right);
      return rightResult ?? leftResult;
    }
  }

  _upsertMetaStatement(key, value, nowMs = Date.now()) {
    return {
      sql: `INSERT INTO ${AUTHORITY_TABLES.meta} (chat_id, meta_key, value_json, updated_at) VALUES (:chatId, :key, :valueJson, :updatedAt) ON CONFLICT(chat_id, meta_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      params: {
        chatId: this.chatId,
        key: normalizeRecordId(key),
        valueJson: stringifyJsonValue(value),
        updatedAt: normalizeTimestamp(nowMs),
      },
    };
  }

  _upsertNodeStatement(node) {
    return {
      sql: `INSERT INTO ${AUTHORITY_TABLES.nodes} (chat_id, record_id, payload_json, node_type, source_floor, archived, updated_at, deleted_at) VALUES (:chatId, :id, :payloadJson, :type, :sourceFloor, :archived, :updatedAt, :deletedAt) ON CONFLICT(chat_id, record_id) DO UPDATE SET payload_json = excluded.payload_json, node_type = excluded.node_type, source_floor = excluded.source_floor, archived = excluded.archived, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
      params: {
        chatId: this.chatId,
        id: node.id,
        payloadJson: stringifyJsonValue(node),
        type: String(node.type || ""),
        sourceFloor: Number.isFinite(Number(node.sourceFloor)) ? Number(node.sourceFloor) : null,
        archived: node.archived === true ? 1 : 0,
        updatedAt: normalizeTimestamp(node.updatedAt),
        deletedAt: Number.isFinite(Number(node.deletedAt)) ? Number(node.deletedAt) : null,
      },
    };
  }

  _upsertEdgeStatement(edge) {
    return {
      sql: `INSERT INTO ${AUTHORITY_TABLES.edges} (chat_id, record_id, payload_json, from_id, to_id, relation, source_floor, updated_at, deleted_at) VALUES (:chatId, :id, :payloadJson, :fromId, :toId, :relation, :sourceFloor, :updatedAt, :deletedAt) ON CONFLICT(chat_id, record_id) DO UPDATE SET payload_json = excluded.payload_json, from_id = excluded.from_id, to_id = excluded.to_id, relation = excluded.relation, source_floor = excluded.source_floor, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
      params: {
        chatId: this.chatId,
        id: edge.id,
        payloadJson: stringifyJsonValue(edge),
        fromId: normalizeRecordId(edge.fromId),
        toId: normalizeRecordId(edge.toId),
        relation: String(edge.relation || ""),
        sourceFloor: Number.isFinite(Number(edge.sourceFloor)) ? Number(edge.sourceFloor) : null,
        updatedAt: normalizeTimestamp(edge.updatedAt),
        deletedAt: Number.isFinite(Number(edge.deletedAt)) ? Number(edge.deletedAt) : null,
      },
    };
  }

  _upsertTombstoneStatement(tombstone) {
    return {
      sql: `INSERT INTO ${AUTHORITY_TABLES.tombstones} (chat_id, record_id, payload_json, tombstone_kind, target_id, deleted_at, source_device_id) VALUES (:chatId, :id, :payloadJson, :kind, :targetId, :deletedAt, :sourceDeviceId) ON CONFLICT(chat_id, record_id) DO UPDATE SET payload_json = excluded.payload_json, tombstone_kind = excluded.tombstone_kind, target_id = excluded.target_id, deleted_at = excluded.deleted_at, source_device_id = excluded.source_device_id`,
      params: {
        chatId: this.chatId,
        id: tombstone.id,
        payloadJson: stringifyJsonValue(tombstone),
        kind: normalizeRecordId(tombstone.kind),
        targetId: normalizeRecordId(tombstone.targetId),
        deletedAt: normalizeTimestamp(tombstone.deletedAt),
        sourceDeviceId: normalizeRecordId(tombstone.sourceDeviceId),
      },
    };
  }

  _deleteByIdStatement(tableName, id) {
    return {
      sql: `DELETE FROM ${tableName} WHERE chat_id = :chatId AND record_id = :id`,
      params: {
        chatId: this.chatId,
        id: normalizeRecordId(id),
      },
    };
  }

  _deleteChatRowsStatement(tableName) {
    return {
      sql: `DELETE FROM ${tableName} WHERE chat_id = :chatId`,
      params: {
        chatId: this.chatId,
      },
    };
  }
}
