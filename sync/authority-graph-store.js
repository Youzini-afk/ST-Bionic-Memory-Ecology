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

export const AUTHORITY_GRAPH_STORE_KIND = "authority";
export const AUTHORITY_GRAPH_STORE_MODE = "authority-sql-primary";

const META_DEFAULT_LAST_PROCESSED_FLOOR = -1;
const META_DEFAULT_EXTRACTION_COUNT = 0;
const DEFAULT_AUTHORITY_SQL_DATABASE = "default";
const AUTHORITY_SQL_QUERY_ENDPOINT = "/sql/query";
const AUTHORITY_SQL_EXEC_ENDPOINT = "/sql/exec";
const AUTHORITY_SQL_TRANSACTION_ENDPOINT = "/sql/transaction";

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
        .map((statement) => {
          const positional = convertNamedParamsToPositional(String(statement.sql || ""), statement.params || {});
          return {
            statement: positional.sql,
            params: positional.params,
          };
        }),
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

export class AuthorityGraphStore {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.options = options;
    this.storeKind = AUTHORITY_GRAPH_STORE_KIND;
    this.storeMode = AUTHORITY_GRAPH_STORE_MODE;
    this.sqlClient = createAuthoritySqlClient(options);
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

    const BATCH_SIZE = 150;
    if (typeof this.sqlClient?.transaction === "function") {
      if (normalizedStatements.length <= BATCH_SIZE) {
        return await this.sqlClient.transaction(normalizedStatements);
      }
      let lastResult = null;
      for (let i = 0; i < normalizedStatements.length; i += BATCH_SIZE) {
        const batch = normalizedStatements.slice(i, i + BATCH_SIZE);
        lastResult = await this.sqlClient.transaction(batch);
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
