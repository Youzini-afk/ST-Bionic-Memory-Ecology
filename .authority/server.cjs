'use strict';

/**
 * BME companion authority module server entry.
 *
 * Phase B: vector-only transactions (`vector.manifest`, `vector.apply`).
 *
 * Contract:
 *   module.exports.activate = async function activate(ctx) { ... }
 *
 * The DOA companion loader calls `activate(ctx)` once at startup. The
 * activation ctx exposes only safe metadata (`moduleId`, `ownerExtensionId`,
 * `moduleDir`, `logger`, `registerTransaction`). No raw DOA services are
 * available on the activation ctx.
 *
 * Each registered transaction handler receives a CompanionModuleTransactionContext
 * with a safe `trivium` wrapper that forces `extensionId = ownerExtensionId`
 * and authorizes `trivium.private` before each call. BME-specific vector logic
 * lives here; DOA stays generic.
 *
 * Payload shape (from `vector/authority-vector-primary-adapter.js`):
 *   {
 *     database, namespace, collectionId, chatId, graphRevision,
 *     modelScope, vectorSpaceId, observedDim, items, links, idempotencyKey
 *   }
 *
 * Return shape (consumed by the BME adapter):
 *   {
 *     ok: true,
 *     appliedAt: ISOString,
 *     database, manifest, upsert: {totalCount,successCount,failureCount},
 *     links: {totalCount,successCount,failureCount},
 *     skippedLinkCount
 *   }
 */

const DEFAULT_BME_DATABASE = 'st_bme_vectors';
const DEFAULT_NAMESPACE = 'default';

// BME graph SQL default database. Matches `DEFAULT_AUTHORITY_SQL_DATABASE`
// in sync/authority-graph-store.js — the value BME actually opens the graph
// store with when no explicit database is configured. Companion handlers use
// this when the request omits `database`.
const DEFAULT_BME_GRAPH_DATABASE = 'default';
const BME_GRAPH_SCHEMA_VERSION = 2;

// DOA enforces a hard cap of 100 statements per ctx.sql.transaction call
// (see MAX_SQL_BATCH_STATEMENTS in packages/server-plugin/src/constants.ts).
// The companion handler must pack the delta into bulk operations to stay
// under this cap. We mirror the constant here so the handler can validate
// the budget locally and surface a clear validation_error before reaching
// the DOA wrapper's hard reject.
const MAX_SQL_BATCH_STATEMENTS = 100;

// Chunking limits to stay under SQLite's default parameter cap (999 in
// most builds; 32766 in newer ones — we use the conservative 999 budget).
// Each multi-row INSERT carries 7-9 params per row × 100 rows = 700-900
// params per statement (safe). DELETE IN clauses carry 1 param per id;
// 500 ids per chunk is well under the cap and keeps statement text small.
const CHUNK_ROWS_INSERT = 100;
const CHUNK_IDS_DELETE = 500;

// Reserved meta keys that always accompany a commitDelta. Mirrors
// PERSIST_META_RESERVED_KEYS in sync/authority-graph-store.js so the
// server-side companion write stays in lockstep with the client-side
// graph store's reserved-meta contract.
const COMMIT_DELTA_RESERVED_META_KEYS = [
  'revision',
  'lastModified',
  'lastMutationReason',
  'syncDirty',
  'syncDirtyReason',
  'nodeCount',
  'edgeCount',
  'tombstoneCount',
];

const crypto = require('crypto');

// Server-side caps for recall.candidates. Mirrors the DOA companion
// trivium wrapper caps (MAX_SEARCH_TOP_K / MAX_SEARCH_EXPAND_DEPTH) so the
// handler clamps client requests before delegating to txCtx.trivium.
const MAX_SEARCH_TOP_K = 200;
const MAX_SEARCH_EXPAND_DEPTH = 5;
const DEFAULT_SEARCH_TOP_K = 10;
const DEFAULT_SEARCH_EXPAND_DEPTH = 0;

// --- helpers ---

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInteger(value, fallback, min, max) {
  var parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeString(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function normalizeRecordId(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeVector(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function resolveDatabase(payload) {
  return normalizeString(payload && payload.database, DEFAULT_BME_DATABASE);
}

function resolveNamespace(payload) {
  var ns = normalizeString(payload && payload.namespace, '');
  if (ns) return ns;
  var collectionId = normalizeString(payload && payload.collectionId, '');
  if (collectionId) return collectionId;
  var chatId = normalizeString(payload && payload.chatId, '');
  return chatId || DEFAULT_NAMESPACE;
}

function buildNodeReference(node) {
  if (!node || typeof node !== 'object') return { externalId: '', namespace: '' };
  var externalId = normalizeRecordId(node.externalId || node.nodeId || node.id);
  var namespace = normalizeString(node.namespace, '');
  return { externalId: externalId, namespace: namespace };
}

function buildV06PayloadSource(payload) {
  if (!payload || typeof payload !== 'object') return {};
  var source = {};
  var keys = ['nodeId', 'externalId', 'text', 'contentHash', 'index', 'collectionId', 'chatId', 'modelScope', 'graphRevision', 'vectorSpaceId', 'observedDim'];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (payload[key] !== undefined && payload[key] !== null) {
      source[key] = payload[key];
    }
  }
  return source;
}

function validateVectorBatch(items, observedDim) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('BME vector.apply requires at least one item');
  }
  var detectedDim = 0;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || typeof item !== 'object') {
      throw new Error('BME vector.apply item at index ' + i + ' is not an object');
    }
    var vector = normalizeVector(item.vector || item.embedding);
    if (vector.length === 0) {
      throw new Error('BME vector.apply item at index ' + i + ' has no vector');
    }
    if (detectedDim === 0) {
      detectedDim = vector.length;
    } else if (vector.length !== detectedDim) {
      throw new Error('BME vector.apply items have inconsistent vector dimensions: ' + detectedDim + ' vs ' + vector.length + ' at index ' + i);
    }
    if (observedDim && Number(observedDim) > 0 && Number(observedDim) !== detectedDim) {
      throw new Error('BME vector.apply observedDim (' + observedDim + ') does not match item vector length (' + detectedDim + ')');
    }
  }
  return detectedDim;
}

function buildUpsertItems(items, namespace, payload) {
  return items.map(function (item) {
    var nodeId = normalizeRecordId(item.externalId || item.nodeId || item.id);
    var payloadSource = buildV06PayloadSource(item.payload || item);
    var vector = normalizeVector(item.vector || item.embedding);
    return {
      externalId: nodeId,
      namespace: namespace,
      vector: vector,
      payload: Object.assign({}, payloadSource, {
        nodeId: payloadSource.nodeId || nodeId,
        externalId: payloadSource.externalId || nodeId,
        collectionId: payload.collectionId || payloadSource.collectionId || '',
        text: payloadSource.text || item.text || '',
        contentHash: payloadSource.contentHash || item.hash || '',
        index: Number(item.index || payloadSource.index || 0) || 0,
      }),
    };
  });
}

function buildLinkItems(links, namespace) {
  return toArray(links).map(function (link) {
    if (!link || typeof link !== 'object') return null;
    var src = normalizeRecordId(link.fromId || link.src || link.sourceId);
    var dst = normalizeRecordId(link.toId || link.dst || link.targetId);
    if (!src || !dst) return null;
    return {
      src: buildNodeReference(Object.assign({}, link.src || {}, { externalId: src, namespace: namespace })),
      dst: buildNodeReference(Object.assign({}, link.dst || {}, { externalId: dst, namespace: namespace })),
      label: String(link.relation || link.label || 'related'),
      weight: Number(link.weight != null ? link.weight : link.strength != null ? link.strength : 1) || 1,
    };
  }).filter(Boolean);
}

function buildManifestFromStat(statResult, input) {
  return {
    database: resolveDatabase(input),
    exists: Boolean(statResult && statResult.exists),
    status: statResult && statResult.exists ? 'ready' : 'missing',
    nodeCount: Number(statResult && statResult.nodeCount) || 0,
    edgeCount: Number(statResult && statResult.edgeCount) || 0,
    mappingCount: Number(statResult && statResult.mappingCount) || 0,
    indexCount: Number(statResult && statResult.indexCount) || 0,
    orphanMappingCount: Number(statResult && statResult.orphanMappingCount) || 0,
    lastFlushAt: (statResult && statResult.lastFlushAt) || null,
    updatedAt: (statResult && statResult.updatedAt) || null,
    collectionId: normalizeString(input && input.collectionId, ''),
    chatId: normalizeString(input && input.chatId, ''),
    modelScope: normalizeString(input && input.modelScope, ''),
    graphRevision: Number(input && input.graphRevision) || 0,
    vectorSpaceId: normalizeString(input && input.vectorSpaceId, ''),
    observedDim: Number(input && input.observedDim) || 0,
    indexHealth: (statResult && statResult.indexHealth) || null,
  };
}

// --- recall.candidates helpers ---

// HARD OUTPUT BOUNDARY: sanitize a searchHybrid hit so only candidate node
// reference fields are returned. NEVER include payload/text/content/messages/
// prompt. The handler returns ONLY externalId/internalId/namespace/score.
function sanitizeSearchHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  var externalId = normalizeRecordId(hit.externalId || hit.nodeId || hit.id);
  if (!externalId) return null;
  var internalId = Number(hit.id != null ? hit.id : hit.internalId);
  var namespace = normalizeString(hit.namespace, '');
  var score = Math.max(0, Number(hit.score != null ? hit.score : hit.similarity) || 0);
  var sanitized = {
    externalId: externalId,
    score: score,
    source: 'search',
  };
  if (Number.isFinite(internalId) && internalId > 0) {
    sanitized.internalId = internalId;
  }
  if (namespace) {
    sanitized.namespace = namespace;
  }
  return sanitized;
}

function sanitizeNeighborNode(node) {
  if (!node || typeof node !== 'object') return null;
  var externalId = normalizeRecordId(node.externalId || node.nodeId || node.id);
  if (!externalId) return null;
  var internalId = Number(node.id != null ? node.id : node.internalId);
  var namespace = normalizeString(node.namespace, '');
  var sanitized = {
    externalId: externalId,
    score: 0,
    source: 'expand',
  };
  if (Number.isFinite(internalId) && internalId > 0) {
    sanitized.internalId = internalId;
  }
  if (namespace) {
    sanitized.namespace = namespace;
  }
  return sanitized;
}

// Validate the recall.candidates input shape before delegating to the DOA
// trivium wrapper. Throws on validation errors.
function validateRecallCandidatesInput(input, observedDim) {
  var queryTexts = toArray(input && input.queryTexts)
    .filter(function (t) { return typeof t === 'string' && t.trim().length > 0; });
  var queryVectors = toArray(input && input.queryVectors);
  if (queryTexts.length === 0 && queryVectors.length === 0) {
    throw new Error('BME recall.candidates requires at least one of queryTexts or queryVectors');
  }
  for (var i = 0; i < queryVectors.length; i++) {
    var vec = queryVectors[i];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('BME recall.candidates queryVectors[' + i + '] must be a non-empty array');
    }
    if (observedDim && Number(observedDim) > 0 && Number(observedDim) !== vec.length) {
      throw new Error(
        'BME recall.candidates queryVectors[' + i + '] length (' + vec.length +
        ') does not match observedDim (' + observedDim + ')'
      );
    }
  }
}

// --- graph helpers (graph.getHead / graph.loadSnapshot) ---

// SQL result rows come back as `{ kind: 'query', columns, rows: [...] }` from
// the DOA `ctx.sql.query` wrapper (see SqlQueryResult in @stdo/shared-types).
// Test mocks may pass a bare array or `{ rows }` / `{ data }`. Normalize all
// shapes to a plain array of row objects.
function normalizeSqlRows(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.result && result.result.rows)) return result.result.rows;
  return [];
}

function parseJsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function readRowValue(row, keys) {
  if (!row || typeof row !== 'object') return undefined;
  for (var i = 0; i < keys.length; i++) {
    if (Object.prototype.hasOwnProperty.call(row, keys[i])) {
      return row[keys[i]];
    }
  }
  return undefined;
}

function toMetaMap(rows) {
  var output = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== 'object') continue;
    var key = String(readRowValue(row, ['key', 'meta_key', 'metaKey']) || '').trim();
    if (!key) continue;
    var rawValue = readRowValue(row, ['valueJson', 'value_json', 'value']);
    output[key] = parseJsonValue(rawValue, null);
  }
  return output;
}

function normalizePayloadRows(rows) {
  return rows
    .map(function (row) {
      var raw = readRowValue(row, ['payloadJson', 'payload_json', 'payload']);
      return parseJsonValue(raw, null);
    })
    .filter(function (record) {
      return record && typeof record === 'object' && !Array.isArray(record);
    });
}

function extractRecordIds(rows) {
  var ids = [];
  for (var i = 0; i < rows.length; i++) {
    var id = String(readRowValue(rows[i], ['record_id', 'recordId', 'id']) || '').trim();
    if (id) ids.push(id);
  }
  return ids;
}

function extractRecordIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.id || payload.recordId || payload.record_id || '').trim();
}

// Compute a content hash for same-revision divergence detection. Hashes
// sorted node + edge record_ids + revision so two chats with the same
// revision but different contents produce different headHashes. SHA-256 is
// always available server-side via node:crypto.
function computeHeadHash(nodeIds, edgeIds, revision) {
  var parts = [];
  for (var i = 0; i < nodeIds.length; i++) {
    if (nodeIds[i]) parts.push('n:' + nodeIds[i]);
  }
  for (var j = 0; j < edgeIds.length; j++) {
    if (edgeIds[j]) parts.push('e:' + edgeIds[j]);
  }
  parts.sort();
  parts.push('r:' + revision);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// CREATE TABLE / CREATE INDEX IF NOT EXISTS for BME graph authority tables.
// Safe to call repeatedly — companion handlers call this lazily before reads
// so a fresh database does not error on SELECT from a missing table.
var GRAPH_TABLES = {
  meta: 'st_bme_graph_meta',
  nodes: 'st_bme_graph_nodes',
  edges: 'st_bme_graph_edges',
  tombstones: 'st_bme_graph_tombstones',
  extractionState: 'st_bme_extraction_state',
  messageHashes: 'st_bme_message_hashes',
  batchJournal: 'st_bme_batch_journal',
  vectorDirtyState: 'st_bme_vector_dirty_state',
};

var GRAPH_SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.meta + ' (chat_id TEXT NOT NULL, meta_key TEXT NOT NULL, value_json TEXT, updated_at INTEGER, PRIMARY KEY(chat_id, meta_key))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.nodes + ' (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, node_type TEXT, source_floor INTEGER, archived INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(chat_id, record_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.edges + ' (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, from_id TEXT, to_id TEXT, relation TEXT, source_floor INTEGER, updated_at INTEGER, deleted_at INTEGER, PRIMARY KEY(chat_id, record_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.tombstones + ' (chat_id TEXT NOT NULL, record_id TEXT NOT NULL, payload_json TEXT NOT NULL, tombstone_kind TEXT, target_id TEXT, deleted_at INTEGER, source_device_id TEXT, PRIMARY KEY(chat_id, record_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.extractionState + ' (chat_id TEXT NOT NULL, last_processed_assistant_floor INTEGER NOT NULL DEFAULT -1, extraction_count INTEGER NOT NULL DEFAULT 0, last_batch_id TEXT, last_graph_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.messageHashes + ' (chat_id TEXT NOT NULL, floor INTEGER NOT NULL, message_hash TEXT NOT NULL, hash_version INTEGER NOT NULL DEFAULT 1, batch_id TEXT, graph_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, floor))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.batchJournal + ' (chat_id TEXT NOT NULL, batch_id TEXT NOT NULL, idempotency_key TEXT, request_fingerprint TEXT NOT NULL, base_revision INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, head_hash TEXT, source_floor_start INTEGER, source_floor_end INTEGER, last_processed_floor_before INTEGER, last_processed_floor_after INTEGER NOT NULL, extraction_count_before INTEGER, extraction_count_after INTEGER NOT NULL, journal_json TEXT NOT NULL, vector_dirty_generation INTEGER NOT NULL DEFAULT 0, committed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(chat_id, batch_id))',
  'CREATE TABLE IF NOT EXISTS ' + GRAPH_TABLES.vectorDirtyState + ' (chat_id TEXT NOT NULL, dirty_generation INTEGER NOT NULL DEFAULT 0, clean_generation INTEGER NOT NULL DEFAULT 0, dirty_from_floor INTEGER, dirty_reason TEXT, graph_revision INTEGER NOT NULL DEFAULT 0, collection_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id))',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_nodes_chat_deleted_at ON ' + GRAPH_TABLES.nodes + ' (chat_id, deleted_at)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_nodes_chat_source_floor ON ' + GRAPH_TABLES.nodes + ' (chat_id, source_floor)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_edges_chat_deleted_at ON ' + GRAPH_TABLES.edges + ' (chat_id, deleted_at)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_edges_chat_source_floor ON ' + GRAPH_TABLES.edges + ' (chat_id, source_floor)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_edges_chat_from_id ON ' + GRAPH_TABLES.edges + ' (chat_id, from_id)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_edges_chat_to_id ON ' + GRAPH_TABLES.edges + ' (chat_id, to_id)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_tombstones_chat_deleted_at ON ' + GRAPH_TABLES.tombstones + ' (chat_id, deleted_at)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_graph_tombstones_chat_target_id ON ' + GRAPH_TABLES.tombstones + ' (chat_id, target_id)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_message_hashes_chat_hash ON ' + GRAPH_TABLES.messageHashes + ' (chat_id, message_hash)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_message_hashes_chat_batch ON ' + GRAPH_TABLES.messageHashes + ' (chat_id, batch_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_st_bme_batch_journal_chat_idempotency ON ' + GRAPH_TABLES.batchJournal + ' (chat_id, idempotency_key)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_batch_journal_chat_revision ON ' + GRAPH_TABLES.batchJournal + ' (chat_id, revision)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_batch_journal_chat_source_floor_end ON ' + GRAPH_TABLES.batchJournal + ' (chat_id, source_floor_end)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_batch_journal_chat_committed_at ON ' + GRAPH_TABLES.batchJournal + ' (chat_id, committed_at)',
  'CREATE INDEX IF NOT EXISTS ix_st_bme_vector_dirty_state_generations ON ' + GRAPH_TABLES.vectorDirtyState + ' (dirty_generation, clean_generation)',
];

async function ensureGraphSchema(txCtx, database) {
  if (!txCtx || typeof txCtx.sql !== 'object' || typeof txCtx.sql.exec !== 'function') {
    throw new Error('BME graph transaction requires ctx.sql.exec (sql.private)');
  }
  for (var i = 0; i < GRAPH_SCHEMA_STATEMENTS.length; i++) {
    await txCtx.sql.exec(database, GRAPH_SCHEMA_STATEMENTS[i]);
  }
}

function resolveGraphDatabase(payload) {
  return normalizeString(payload && payload.database, DEFAULT_BME_GRAPH_DATABASE);
}

function resolveGraphChatId(payload) {
  var chatId = normalizeString(payload && payload.chatId, '');
  if (!chatId) {
    throw new Error('BME graph transaction requires chatId');
  }
  return chatId;
}

// Meta keys surfaced by graph.getHead. Mirrors the reserved meta keys in
// sync/authority-graph-store.js PERSIST_META_RESERVED_KEYS plus the runtime
// state keys (lastProcessedFloor, extractionCount, schemaVersion).
var GRAPH_META_REPORT_KEYS = [
  'revision',
  'lastModified',
  'syncDirty',
  'syncDirtyReason',
  'lastProcessedFloor',
  'extractionCount',
  'schemaVersion',
  'nodeCount',
  'edgeCount',
  'tombstoneCount',
];

function buildGraphMetaReport(meta) {
  var report = {};
  for (var i = 0; i < GRAPH_META_REPORT_KEYS.length; i++) {
    var key = GRAPH_META_REPORT_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      report[key] = meta[key];
    }
  }
  return report;
}

// Read head info for a chat: revision, headHash, meta. Used by both
// graph.getHead (full response) and graph.loadSnapshot (minRevision check).
// Returns { exists, revision, headHash, meta }.
async function readGraphHead(txCtx, database, chatId) {
  var metaRows = normalizeSqlRows(
    await txCtx.sql.query(
      database,
      'SELECT meta_key, value_json FROM ' + GRAPH_TABLES.meta + ' WHERE chat_id = ?',
      [chatId]
    )
  );
  if (metaRows.length === 0) {
    return { exists: false, revision: 0, headHash: null, meta: {} };
  }
  var meta = toMetaMap(metaRows);
  var revision = Number(meta.revision) || 0;

  var nodeRows = normalizeSqlRows(
    await txCtx.sql.query(
      database,
      'SELECT record_id FROM ' + GRAPH_TABLES.nodes + ' WHERE chat_id = ? AND deleted_at IS NULL',
      [chatId]
    )
  );
  var edgeRows = normalizeSqlRows(
    await txCtx.sql.query(
      database,
      'SELECT record_id FROM ' + GRAPH_TABLES.edges + ' WHERE chat_id = ? AND deleted_at IS NULL',
      [chatId]
    )
  );
  var nodeIds = extractRecordIds(nodeRows);
  var edgeIds = extractRecordIds(edgeRows);
  var headHash = computeHeadHash(nodeIds, edgeIds, revision);
  return { exists: true, revision: revision, headHash: headHash, meta: meta };
}

// --- graph.commitDelta helpers ---
//
// Build a single multi-row INSERT ... ON CONFLICT DO UPDATE statement for
// `st_bme_graph_meta`. Each row contributes 4 params (chat_id, meta_key,
// value_json, updated_at). The caller passes a list of { key, value }
// entries; values are JSON-stringified. The DOA transaction wrapper
// accepts positional `?` params (SqlValue[]), so we expand the placeholder
// list and concat params in row order.
function buildMetaUpsertStatement(chatId, entries, nowMs) {
  var rows = [];
  var params = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry || !entry.key) continue;
    rows.push('(?, ?, ?, ?)');
    params.push(chatId, String(entry.key), JSON.stringify(entry.value == null ? null : entry.value), nowMs);
  }
  if (rows.length === 0) return null;
  return {
    statement:
      'INSERT INTO ' + GRAPH_TABLES.meta +
      ' (chat_id, meta_key, value_json, updated_at) VALUES ' +
      rows.join(', ') +
      ' ON CONFLICT(chat_id, meta_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    params: params,
  };
}

// Build a single multi-row INSERT ... ON CONFLICT DO UPDATE statement for
// `st_bme_graph_nodes`. Each row carries 8 params (chat_id, record_id,
// payload_json, node_type, source_floor, archived, updated_at, deleted_at).
// `payload_json` is the full node object JSON-stringified (mirrors the
// BME client store's `_upsertNodeStatement` shape).
function buildNodeInsertStatement(chatId, nodes) {
  var rows = [];
  var params = [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i] || {};
    var id = normalizeRecordId(node.id || node.recordId || node.record_id);
    if (!id) continue;
    rows.push('(?, ?, ?, ?, ?, ?, ?, ?)');
    params.push(
      chatId,
      id,
      JSON.stringify(node),
      String(node.type || node.nodeType || ''),
      Number.isFinite(Number(node.sourceFloor != null ? node.sourceFloor : node.source_floor)) ? Number(node.sourceFloor != null ? node.sourceFloor : node.source_floor) : null,
      node.archived === true ? 1 : 0,
      Number.isFinite(Number(node.updatedAt != null ? node.updatedAt : node.updated_at)) ? Number(node.updatedAt != null ? node.updatedAt : node.updated_at) : null,
      Number.isFinite(Number(node.deletedAt != null ? node.deletedAt : node.deleted_at)) ? Number(node.deletedAt != null ? node.deletedAt : node.deleted_at) : null
    );
  }
  if (rows.length === 0) return null;
  return {
    statement:
      'INSERT INTO ' + GRAPH_TABLES.nodes +
      ' (chat_id, record_id, payload_json, node_type, source_floor, archived, updated_at, deleted_at) VALUES ' +
      rows.join(', ') +
      ' ON CONFLICT(chat_id, record_id) DO UPDATE SET payload_json = excluded.payload_json, node_type = excluded.node_type, source_floor = excluded.source_floor, archived = excluded.archived, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at',
    params: params,
  };
}

// Build a single multi-row INSERT ... ON CONFLICT DO UPDATE statement for
// `st_bme_graph_edges`. Each row carries 9 params (chat_id, record_id,
// payload_json, from_id, to_id, relation, source_floor, updated_at,
// deleted_at).
function buildEdgeInsertStatement(chatId, edges) {
  var rows = [];
  var params = [];
  for (var i = 0; i < edges.length; i++) {
    var edge = edges[i] || {};
    var id = normalizeRecordId(edge.id || edge.recordId || edge.record_id);
    if (!id) continue;
    rows.push('(?, ?, ?, ?, ?, ?, ?, ?, ?)');
    params.push(
      chatId,
      id,
      JSON.stringify(edge),
      normalizeRecordId(edge.fromId != null ? edge.fromId : edge.from_id),
      normalizeRecordId(edge.toId != null ? edge.toId : edge.to_id),
      String(edge.relation || ''),
      Number.isFinite(Number(edge.sourceFloor != null ? edge.sourceFloor : edge.source_floor)) ? Number(edge.sourceFloor != null ? edge.sourceFloor : edge.source_floor) : null,
      Number.isFinite(Number(edge.updatedAt != null ? edge.updatedAt : edge.updated_at)) ? Number(edge.updatedAt != null ? edge.updatedAt : edge.updated_at) : null,
      Number.isFinite(Number(edge.deletedAt != null ? edge.deletedAt : edge.deleted_at)) ? Number(edge.deletedAt != null ? edge.deletedAt : edge.deleted_at) : null
    );
  }
  if (rows.length === 0) return null;
  return {
    statement:
      'INSERT INTO ' + GRAPH_TABLES.edges +
      ' (chat_id, record_id, payload_json, from_id, to_id, relation, source_floor, updated_at, deleted_at) VALUES ' +
      rows.join(', ') +
      ' ON CONFLICT(chat_id, record_id) DO UPDATE SET payload_json = excluded.payload_json, from_id = excluded.from_id, to_id = excluded.to_id, relation = excluded.relation, source_floor = excluded.source_floor, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at',
    params: params,
  };
}

// Build a single multi-row INSERT ... ON CONFLICT DO UPDATE statement for
// `st_bme_graph_tombstones`. Each row carries 7 params (chat_id, record_id,
// payload_json, tombstone_kind, target_id, deleted_at, source_device_id).
function buildTombstoneInsertStatement(chatId, tombstones) {
  var rows = [];
  var params = [];
  for (var i = 0; i < tombstones.length; i++) {
    var tomb = tombstones[i] || {};
    var id = normalizeRecordId(tomb.id || tomb.recordId || tomb.record_id);
    if (!id) continue;
    rows.push('(?, ?, ?, ?, ?, ?, ?)');
    params.push(
      chatId,
      id,
      JSON.stringify(tomb),
      normalizeRecordId(tomb.kind != null ? tomb.kind : tomb.tombstoneKind || tomb.tombstone_kind),
      normalizeRecordId(tomb.targetId != null ? tomb.targetId : tomb.target_id),
      Number.isFinite(Number(tomb.deletedAt != null ? tomb.deletedAt : tomb.deleted_at)) ? Number(tomb.deletedAt != null ? tomb.deletedAt : tomb.deleted_at) : null,
      normalizeRecordId(tomb.sourceDeviceId != null ? tomb.sourceDeviceId : tomb.source_device_id)
    );
  }
  if (rows.length === 0) return null;
  return {
    statement:
      'INSERT INTO ' + GRAPH_TABLES.tombstones +
      ' (chat_id, record_id, payload_json, tombstone_kind, target_id, deleted_at, source_device_id) VALUES ' +
      rows.join(', ') +
      ' ON CONFLICT(chat_id, record_id) DO UPDATE SET payload_json = excluded.payload_json, tombstone_kind = excluded.tombstone_kind, target_id = excluded.target_id, deleted_at = excluded.deleted_at, source_device_id = excluded.source_device_id',
    params: params,
  };
}

// Build a single DELETE FROM <table> WHERE chat_id = ? AND record_id IN (...)
// statement. Chunked upstream so the IN list stays under the SQLite param
// cap. Returns null if `ids` is empty (no statement needed).
function buildDeleteInStatement(table, chatId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  var placeholders = [];
  var params = [chatId];
  for (var i = 0; i < ids.length; i++) {
    var id = normalizeRecordId(ids[i]);
    if (!id) continue;
    placeholders.push('?');
    params.push(id);
  }
  if (placeholders.length === 0) return null;
  return {
    statement: 'DELETE FROM ' + table + ' WHERE chat_id = ? AND record_id IN (' + placeholders.join(', ') + ')',
    params: params,
  };
}

// Chunk a flat array into sub-arrays of size `size`.
function chunkArray(arr, size) {
  var chunks = [];
  for (var i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Build the full statement list for a commitDelta transaction. Returns
// { statements, statementCount, counts: { nodeInserts, edgeInserts, ... } }
// for diagnostics. Throws validation_error if the total statement count
// would exceed MAX_SQL_BATCH_STATEMENTS.
function buildCommitDeltaStatements(chatId, baseRevision, delta, options, existingMeta) {
  delta = delta || {};
  options = options || {};
  var upsertNodes = toArray(delta.upsertNodes);
  var upsertEdges = toArray(delta.upsertEdges);
  var tombstones = toArray(delta.tombstones);
  var deleteNodeIds = toArray(delta.deleteNodeIds).map(normalizeRecordId).filter(Boolean);
  var deleteEdgeIds = toArray(delta.deleteEdgeIds).map(normalizeRecordId).filter(Boolean);
  var runtimeMetaPatch = (delta.runtimeMetaPatch && typeof delta.runtimeMetaPatch === 'object' && !Array.isArray(delta.runtimeMetaPatch))
    ? delta.runtimeMetaPatch
    : {};
  var countDelta = (delta.countDelta && typeof delta.countDelta === 'object' && !Array.isArray(delta.countDelta))
    ? delta.countDelta
    : {};

  // Early budget estimate so we can reject oversized deltas WITHOUT
  // building all the statements. Each chunk is one statement; the meta
  // upsert is always exactly one statement.
  var estimatedEdgeDeleteStmts = Math.ceil(deleteEdgeIds.length / CHUNK_IDS_DELETE);
  var estimatedNodeDeleteStmts = Math.ceil(deleteNodeIds.length / CHUNK_IDS_DELETE);
  var estimatedNodeInsertStmts = Math.ceil(upsertNodes.length / CHUNK_ROWS_INSERT);
  var estimatedEdgeInsertStmts = Math.ceil(upsertEdges.length / CHUNK_ROWS_INSERT);
  var estimatedTombInsertStmts = Math.ceil(tombstones.length / CHUNK_ROWS_INSERT);
  var estimatedTotal =
    estimatedEdgeDeleteStmts +
    estimatedNodeDeleteStmts +
    estimatedNodeInsertStmts +
    estimatedEdgeInsertStmts +
    estimatedTombInsertStmts +
    1; // +1 for the meta upsert (always present)

  if (estimatedTotal > MAX_SQL_BATCH_STATEMENTS) {
    var earlyErr = new Error(
      'BME graph.commitDelta delta exceeds MAX_SQL_BATCH_STATEMENTS (' + MAX_SQL_BATCH_STATEMENTS +
      '): estimated ' + estimatedTotal + ' statements. ' +
      'Reduce upsert/delete batch sizes and retry.'
    );
    earlyErr.status = 400;
    earlyErr.code = 'validation_error';
    earlyErr.details = {
      statementCount: estimatedTotal,
      maxStatements: MAX_SQL_BATCH_STATEMENTS,
      upsertNodes: upsertNodes.length,
      upsertEdges: upsertEdges.length,
      tombstones: tombstones.length,
      deleteNodeIds: deleteNodeIds.length,
      deleteEdgeIds: deleteEdgeIds.length,
    };
    throw earlyErr;
  }

  var nowMs = Date.now();
  var nextRevision = Number(baseRevision) + 1;
  var markSyncDirty = options.markSyncDirty !== false; // default true
  var reason = normalizeString(options.reason, 'commitDelta');

  var statements = [];

  // (a) DELETE edges (chunked by CHUNK_IDS_DELETE)
  var edgeDeleteChunks = chunkArray(deleteEdgeIds, CHUNK_IDS_DELETE);
  for (var ed = 0; ed < edgeDeleteChunks.length; ed++) {
    var stmt = buildDeleteInStatement(GRAPH_TABLES.edges, chatId, edgeDeleteChunks[ed]);
    if (stmt) statements.push(stmt);
  }

  // (b) DELETE nodes (chunked by CHUNK_IDS_DELETE)
  var nodeDeleteChunks = chunkArray(deleteNodeIds, CHUNK_IDS_DELETE);
  for (var nd = 0; nd < nodeDeleteChunks.length; nd++) {
    var stmt2 = buildDeleteInStatement(GRAPH_TABLES.nodes, chatId, nodeDeleteChunks[nd]);
    if (stmt2) statements.push(stmt2);
  }

  // (c) Multi-row INSERT nodes (chunked by CHUNK_ROWS_INSERT)
  var nodeInsertChunks = chunkArray(upsertNodes, CHUNK_ROWS_INSERT);
  for (var ni = 0; ni < nodeInsertChunks.length; ni++) {
    var stmt3 = buildNodeInsertStatement(chatId, nodeInsertChunks[ni]);
    if (stmt3) statements.push(stmt3);
  }

  // (d) Multi-row INSERT edges (chunked by CHUNK_ROWS_INSERT)
  var edgeInsertChunks = chunkArray(upsertEdges, CHUNK_ROWS_INSERT);
  for (var ei = 0; ei < edgeInsertChunks.length; ei++) {
    var stmt4 = buildEdgeInsertStatement(chatId, edgeInsertChunks[ei]);
    if (stmt4) statements.push(stmt4);
  }

  // (e) Multi-row INSERT tombstones (chunked by CHUNK_ROWS_INSERT)
  var tombInsertChunks = chunkArray(tombstones, CHUNK_ROWS_INSERT);
  for (var ti = 0; ti < tombInsertChunks.length; ti++) {
    var stmt5 = buildTombstoneInsertStatement(chatId, tombInsertChunks[ti]);
    if (stmt5) statements.push(stmt5);
  }

  // (f) Meta upsert (single multi-row statement). Always present so the
  // revision bump + syncDirty + runtimeMetaPatch co-commit in the same
  // atomic transaction. Reserved meta keys override any same-named keys
  // in runtimeMetaPatch so callers cannot accidentally stomp revision.
  var metaEntries = [];
  var reserved = new Set(COMMIT_DELTA_RESERVED_META_KEYS);
  // 1. Runtime meta patch first (non-reserved keys only).
  var patchKeys = Object.keys(runtimeMetaPatch);
  for (var pk = 0; pk < patchKeys.length; pk++) {
    var patchKey = patchKeys[pk];
    if (reserved.has(patchKey)) continue;
    metaEntries.push({ key: patchKey, value: runtimeMetaPatch[patchKey] });
  }
  // 2. Reserved keys (caller-supplied countDelta wins; otherwise fall
  // back to existing meta so we don't clobber known-good counts when
  // the caller didn't bother to recompute them).
  var fallbackNodeCount = Number(existingMeta && existingMeta.nodeCount);
  if (!Number.isFinite(fallbackNodeCount)) fallbackNodeCount = 0;
  var fallbackEdgeCount = Number(existingMeta && existingMeta.edgeCount);
  if (!Number.isFinite(fallbackEdgeCount)) fallbackEdgeCount = 0;
  var fallbackTombstoneCount = Number(existingMeta && existingMeta.tombstoneCount);
  if (!Number.isFinite(fallbackTombstoneCount)) fallbackTombstoneCount = 0;

  // Override reserved runtimeMetaPatch keys when present (lastProcessedFloor,
  // extractionCount are NOT in the reserved set, so they flow through the
  // runtime meta patch path above; but if a caller passes nodeCount in
  // runtimeMetaPatch it would be skipped — countDelta is the canonical
  // channel for counts).
  var nextNodeCount = Number.isFinite(Number(countDelta.nodeCount)) ? Number(countDelta.nodeCount) : fallbackNodeCount;
  var nextEdgeCount = Number.isFinite(Number(countDelta.edgeCount)) ? Number(countDelta.edgeCount) : fallbackEdgeCount;
  var nextTombstoneCount = Number.isFinite(Number(countDelta.tombstoneCount)) ? Number(countDelta.tombstoneCount) : fallbackTombstoneCount;

  metaEntries.push({ key: 'revision', value: nextRevision });
  metaEntries.push({ key: 'lastModified', value: nowMs });
  metaEntries.push({ key: 'lastMutationReason', value: reason });
  metaEntries.push({ key: 'syncDirty', value: Boolean(markSyncDirty) });
  metaEntries.push({ key: 'syncDirtyReason', value: markSyncDirty ? reason : '' });
  metaEntries.push({ key: 'nodeCount', value: nextNodeCount });
  metaEntries.push({ key: 'edgeCount', value: nextEdgeCount });
  metaEntries.push({ key: 'tombstoneCount', value: nextTombstoneCount });

  var metaStmt = buildMetaUpsertStatement(chatId, metaEntries, nowMs);
  if (metaStmt) statements.push(metaStmt);

  // Final budget check (defense-in-depth; the early estimate should
  // have caught any overage, but the actual statement count is the
  // source of truth).
  if (statements.length > MAX_SQL_BATCH_STATEMENTS) {
    var err = new Error(
      'BME graph.commitDelta delta exceeds MAX_SQL_BATCH_STATEMENTS (' + MAX_SQL_BATCH_STATEMENTS +
      '): generated ' + statements.length + ' statements. ' +
      'Reduce upsert/delete batch sizes and retry.'
    );
    err.status = 400;
    err.code = 'validation_error';
    err.details = {
      statementCount: statements.length,
      maxStatements: MAX_SQL_BATCH_STATEMENTS,
      upsertNodes: upsertNodes.length,
      upsertEdges: upsertEdges.length,
      tombstones: tombstones.length,
      deleteNodeIds: deleteNodeIds.length,
      deleteEdgeIds: deleteEdgeIds.length,
    };
    throw err;
  }

  return {
    statements: statements,
    nextRevision: nextRevision,
    nextNodeCount: nextNodeCount,
    nextEdgeCount: nextEdgeCount,
    nextTombstoneCount: nextTombstoneCount,
    upsertedNodes: upsertNodes.length,
    upsertedEdges: upsertEdges.length,
    upsertedTombstones: tombstones.length,
    deletedNodeIds: deleteNodeIds.length,
    deletedEdgeIds: deleteEdgeIds.length,
    committedAt: new Date(nowMs).toISOString(),
  };
}

// --- activate ---

module.exports.activate = async function activate(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('BME companion module: activation ctx is required');
  }
  if (typeof ctx.registerTransaction !== 'function') {
    throw new Error('BME companion module: ctx.registerTransaction is required');
  }
  var logger = ctx.logger || console;

  ctx.registerTransaction('vector.manifest', {
    handler: async function (txCtx, input) {
      var database = resolveDatabase(input);
      var includeMappingIntegrity = Boolean(input && input.includeMappingIntegrity);
      var statResult = await txCtx.trivium.stat({
        database: database,
        includeMappingIntegrity: includeMappingIntegrity,
      });
      var manifest = buildManifestFromStat(statResult, input || {});
      return {
        result: {
          ok: true,
          appliedAt: new Date().toISOString(),
          database: database,
          manifest: manifest,
        },
      };
    },
  });

  ctx.registerTransaction('vector.apply', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveDatabase(input);
      var namespace = resolveNamespace(input);
      var observedDim = Number(input.observedDim) || 0;
      var items = toArray(input.items);
      var links = toArray(input.links);

      // Validate the vector batch: items required, each has a non-empty
      // vector, all vectors have consistent dimension, observedDim if
      // provided must match.
      var detectedDim = validateVectorBatch(items, observedDim);

      // Map BME items to DOA Trivium bulkUpsert request shape.
      var upsertItems = buildUpsertItems(items, namespace, input);
      var openOptions = {
        database: database,
        dim: detectedDim,
      };
      if (input.dtype) openOptions.dtype = input.dtype;
      if (input.metric) openOptions.metric = input.metric;
      if (input.syncMode) openOptions.syncMode = input.syncMode;
      if (input.storageMode) openOptions.storageMode = input.storageMode;

      var upsertResult = await txCtx.trivium.bulkUpsert(Object.assign({}, openOptions, {
        items: upsertItems,
      }));

      // Map BME links to DOA Trivium bulkLink request shape.
      var linkItems = buildLinkItems(links, namespace);
      var linkResult;
      var skippedLinkCount = 0;
      if (linkItems.length > 0) {
        linkResult = await txCtx.trivium.bulkLink({
          database: database,
          items: linkItems,
        });
      } else {
        linkResult = {
          totalCount: 0,
          successCount: 0,
          failureCount: 0,
          failures: [],
        };
        skippedLinkCount = links.length;
      }

      var ok = Number(upsertResult.failureCount || 0) === 0 && Number(linkResult.failureCount || 0) === 0;

      return {
        result: {
          ok: ok,
          appliedAt: new Date().toISOString(),
          database: database,
          manifest: {
            database: database,
            namespace: namespace,
            observedDim: detectedDim,
            collectionId: normalizeString(input.collectionId, ''),
            chatId: normalizeString(input.chatId, ''),
            modelScope: normalizeString(input.modelScope, ''),
            graphRevision: Number(input.graphRevision) || 0,
            vectorSpaceId: normalizeString(input.vectorSpaceId, ''),
          },
          upsert: {
            totalCount: Number(upsertResult.totalCount) || 0,
            successCount: Number(upsertResult.successCount) || 0,
            failureCount: Number(upsertResult.failureCount) || 0,
            failures: toArray(upsertResult.failures),
          },
          links: {
            totalCount: Number(linkResult.totalCount) || 0,
            successCount: Number(linkResult.successCount) || 0,
            failureCount: Number(linkResult.failureCount) || 0,
            failures: toArray(linkResult.failures),
          },
          skippedLinkCount: skippedLinkCount,
        },
      };
    },
  });

  ctx.registerTransaction('recall.candidates', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveDatabase(input);
      var collectionId = normalizeString(input.collectionId, '');
      var chatId = normalizeString(input.chatId, '');
      var namespace = resolveNamespace(input);
      var graphRevision = Math.max(0, Math.floor(Number(input.graphRevision) || 0));
      var modelScope = normalizeString(input.modelScope, '');
      var vectorSpaceId = normalizeString(input.vectorSpaceId, '');
      var observedDim = Math.max(0, Math.floor(Number(input.observedDim) || 0));

      // Validate input shape. Throws on missing queries or observedDim mismatch.
      validateRecallCandidatesInput(input, observedDim);

      var queryTexts = toArray(input.queryTexts)
        .filter(function (t) { return typeof t === 'string' && t.trim().length > 0; });
      var queryVectors = toArray(input.queryVectors);
      var topK = clampInteger(input.topK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K);
      var expandDepth = clampInteger(input.expandDepth, DEFAULT_SEARCH_EXPAND_DEPTH, 0, MAX_SEARCH_EXPAND_DEPTH);
      var minScore = Number.isFinite(Number(input.minScore)) ? Number(input.minScore) : undefined;
      var hybridAlpha = Number.isFinite(Number(input.hybridAlpha)) ? Number(input.hybridAlpha) : undefined;
      var payloadFilter = (input.payloadFilter && typeof input.payloadFilter === 'object' && !Array.isArray(input.payloadFilter))
        ? input.payloadFilter
        : undefined;
      var filters = (input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters))
        ? input.filters
        : undefined;

      // Pair queryTexts[i] and queryVectors[i] if both arrays; iterate the
      // longer one. Skip indices where neither is present.
      var queryCount = Math.max(queryTexts.length, queryVectors.length);
      var candidates = [];
      var seenExternalIds = new Set();

      for (var q = 0; q < queryCount; q++) {
        var queryText = queryTexts[q];
        var vector = queryVectors[q];
        var hasQueryText = typeof queryText === 'string' && queryText.trim().length > 0;
        var hasVector = Array.isArray(vector) && vector.length > 0;
        if (!hasQueryText && !hasVector) continue;

        var searchReq = {
          database: database,
          vector: vector,
          topK: topK,
          // Expansion is done below via resolveMany + neighbors so the
          // candidate set is fully under our control (sanitized).
          expandDepth: 0,
        };
        if (hasQueryText) searchReq.queryText = queryText;
        if (minScore !== undefined) searchReq.minScore = minScore;
        if (hybridAlpha !== undefined) searchReq.hybridAlpha = hybridAlpha;
        if (payloadFilter !== undefined) searchReq.payloadFilter = payloadFilter;
        if (filters !== undefined) searchReq.filters = filters;

        var hits = await txCtx.trivium.searchHybrid(searchReq);
        hits = toArray(hits);

        for (var h = 0; h < hits.length; h++) {
          var sanitized = sanitizeSearchHit(hits[h]);
          if (!sanitized) continue;
          if (seenExternalIds.has(sanitized.externalId)) continue;
          seenExternalIds.add(sanitized.externalId);
          candidates.push(sanitized);
        }
      }

      // If expandDepth > 0 and hits found, optionally call resolveMany then
      // neighbors to expand the candidate set. Best-effort: failures are
      // logged but do NOT fail the request.
      if (expandDepth > 0 && candidates.length > 0) {
        var topHits = candidates.slice(0, Math.min(candidates.length, topK));
        try {
          var resolved = await txCtx.trivium.resolveMany({
            database: database,
            items: topHits.map(function (h) {
              var ref = { externalId: h.externalId };
              if (h.namespace) ref.namespace = h.namespace;
              return ref;
            }),
          });
          var resolvedItems = toArray(resolved && resolved.items);
          for (var r = 0; r < resolvedItems.length; r++) {
            var item = resolvedItems[r];
            var internalId = Number(item && item.id);
            if (!Number.isFinite(internalId) || internalId <= 0) continue;

            // Attach internalId to the existing candidate.
            for (var c = 0; c < candidates.length; c++) {
              if (candidates[c].externalId === (item && item.externalId)) {
                candidates[c].internalId = internalId;
                break;
              }
            }

            var neighborResult = await txCtx.trivium.neighbors({
              database: database,
              id: internalId,
              depth: expandDepth,
            });
            var neighborNodes = toArray(
              neighborResult && (neighborResult.nodes || neighborResult.neighbors)
            );
            for (var n = 0; n < neighborNodes.length; n++) {
              var sanitizedNeighbor = sanitizeNeighborNode(neighborNodes[n]);
              if (!sanitizedNeighbor) continue;
              if (seenExternalIds.has(sanitizedNeighbor.externalId)) continue;
              seenExternalIds.add(sanitizedNeighbor.externalId);
              candidates.push(sanitizedNeighbor);
            }
          }
        } catch (expandError) {
          // Expansion is best-effort; return search results without expansion.
          if (logger.warn) {
            logger.warn('[st-bme] recall.candidates expand failed:', expandError && expandError.message);
          }
        }
      }

      return {
        result: {
          ok: true,
          database: database,
          collectionId: collectionId,
          chatId: chatId,
          graphRevision: graphRevision,
          modelScope: modelScope,
          vectorSpaceId: vectorSpaceId,
          observedDim: observedDim,
          candidates: candidates,
          queryCount: queryCount,
          searchedAt: new Date().toISOString(),
        },
      };
    },
  });

  ctx.registerTransaction('graph.getHead', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveGraphDatabase(input);
      var chatId = resolveGraphChatId(input);

      await ensureGraphSchema(txCtx, database);

      var head = await readGraphHead(txCtx, database, chatId);
      if (!head.exists) {
        return {
          result: {
            ok: true,
            chatId: chatId,
            revision: 0,
            headHash: null,
            exists: false,
            schemaVersion: BME_GRAPH_SCHEMA_VERSION,
          },
        };
      }

      var metaReport = buildGraphMetaReport(head.meta);
      return {
        result: {
          ok: true,
          chatId: chatId,
          revision: head.revision,
          headHash: head.headHash,
          schemaVersion: BME_GRAPH_SCHEMA_VERSION,
          lastModified: metaReport.lastModified != null ? metaReport.lastModified : null,
          syncDirty: Boolean(metaReport.syncDirty),
          exists: true,
          meta: metaReport,
        },
      };
    },
  });

  ctx.registerTransaction('graph.loadSnapshot', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveGraphDatabase(input);
      var chatId = resolveGraphChatId(input);

      await ensureGraphSchema(txCtx, database);

      var head = await readGraphHead(txCtx, database, chatId);

      // minRevision short-circuit: if the caller already has this revision,
      // skip the payload and tell them nothing changed.
      if (input.minRevision !== undefined && input.minRevision !== null) {
        var minRevision = Number(input.minRevision);
        if (Number.isFinite(minRevision) && head.exists && head.revision === minRevision) {
          return {
            result: {
              ok: true,
              unchanged: true,
              chatId: chatId,
              revision: head.revision,
              headHash: head.headHash,
              schemaVersion: BME_GRAPH_SCHEMA_VERSION,
            },
          };
        }
      }

      if (!head.exists) {
        // No meta rows: return an empty snapshot at revision 0.
        return {
          result: {
            ok: true,
            chatId: chatId,
            revision: 0,
            headHash: null,
            schemaVersion: BME_GRAPH_SCHEMA_VERSION,
            meta: {},
            nodes: [],
            edges: [],
            tombstones: [],
            state: {
              lastProcessedFloor: 0,
              extractionCount: 0,
            },
          },
        };
      }

      var nodeRows = normalizeSqlRows(
        await txCtx.sql.query(
          database,
          'SELECT payload_json FROM ' + GRAPH_TABLES.nodes + ' WHERE chat_id = ? AND deleted_at IS NULL',
          [chatId]
        )
      );
      var edgeRows = normalizeSqlRows(
        await txCtx.sql.query(
          database,
          'SELECT payload_json FROM ' + GRAPH_TABLES.edges + ' WHERE chat_id = ? AND deleted_at IS NULL',
          [chatId]
        )
      );
      var tombstoneRows = normalizeSqlRows(
        await txCtx.sql.query(
          database,
          'SELECT payload_json FROM ' + GRAPH_TABLES.tombstones + ' WHERE chat_id = ?',
          [chatId]
        )
      );

      var nodes = normalizePayloadRows(nodeRows);
      var edges = normalizePayloadRows(edgeRows);
      var tombstones = normalizePayloadRows(tombstoneRows);

      // Compute headHash from the loaded payloads (same algorithm as getHead).
      var nodeIds = nodes.map(extractRecordIdFromPayload).filter(Boolean);
      var edgeIds = edges.map(extractRecordIdFromPayload).filter(Boolean);
      var headHash = computeHeadHash(nodeIds, edgeIds, head.revision);

      var meta = head.meta;
      var lastProcessedFloor = Number(meta.lastProcessedFloor);
      if (!Number.isFinite(lastProcessedFloor)) lastProcessedFloor = 0;
      var extractionCount = Number(meta.extractionCount);
      if (!Number.isFinite(extractionCount)) extractionCount = 0;

      return {
        result: {
          ok: true,
          chatId: chatId,
          revision: head.revision,
          headHash: headHash,
          schemaVersion: BME_GRAPH_SCHEMA_VERSION,
          meta: meta,
          nodes: nodes,
          edges: edges,
          tombstones: tombstones,
          state: {
            lastProcessedFloor: lastProcessedFloor,
            extractionCount: extractionCount,
          },
        },
      };
    },
  });

  ctx.registerTransaction('graph.commitDelta', {
    handler: async function (txCtx, input) {
      input = input || {};
      var database = resolveGraphDatabase(input);
      var chatId = resolveGraphChatId(input);

      // Validate companion capabilities required for the lock → idempotency
      // → CAS → transaction pipeline. The DOA host wires these onto txCtx
      // when the manifest declares idempotency:"required" + sql.private;
      // surface a clear error if a future host forgets to inject them.
      if (!txCtx || typeof txCtx.locks !== 'object' || typeof txCtx.locks.withLock !== 'function') {
        var lockErr = new Error('BME graph.commitDelta requires ctx.locks.withLock (Phase B companion capability)');
        lockErr.status = 500;
        lockErr.code = 'capability_unavailable';
        throw lockErr;
      }
      if (!txCtx || typeof txCtx.idempotency !== 'object' || typeof txCtx.idempotency.run !== 'function') {
        var idemErr = new Error('BME graph.commitDelta requires ctx.idempotency.run (Phase C companion capability)');
        idemErr.status = 500;
        idemErr.code = 'capability_unavailable';
        throw idemErr;
      }

      // --- validate input ---
      // baseRevision is required (number, >= 0). It is the CAS expected
      // value: the caller's view of the current server revision. The
      // handler reads the actual server revision inside the lock and
      // compares; mismatch → 409 transaction_conflict.
      var baseRevision = Number(input.baseRevision);
      if (!Number.isFinite(baseRevision) || baseRevision < 0) {
        var verr = new Error('BME graph.commitDelta requires baseRevision (non-negative number)');
        verr.status = 400;
        verr.code = 'validation_error';
        throw verr;
      }
      var delta = input.delta;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
        var dverr = new Error('BME graph.commitDelta requires delta (object)');
        dverr.status = 400;
        dverr.code = 'validation_error';
        throw dverr;
      }
      var options = (input.options && typeof input.options === 'object' && !Array.isArray(input.options))
        ? input.options
        : {};

      // Idempotency key: prefer caller-supplied (the DOA wrapper auto-
      // prefixes with ownerExtensionId); fall back to a deterministic
      // key scoped to chat + baseRevision. The fingerprint covers the
      // full delta + chatId + baseRevision + database + options so two
      // retries of the same logical request always produce the same
      // fingerprint, while a request that targets a different database
      // or carries different options (markSyncDirty, reason,
      // vectorDirtyHint, ...) is treated as a distinct logical write
      // and surfaces idempotency_conflict rather than silently replaying
      // cached success.
      var idempotencyKey = normalizeString(input.idempotencyKey, 'commitDelta:' + chatId + ':rev:' + baseRevision);
      var fingerprint = JSON.stringify({ chatId: chatId, baseRevision: baseRevision, database: database, delta: delta, options: options });

      // --- lock → idempotency → CAS → transaction ---
      // The lock serializes all companion writers for the same chat.
      // Inside the lock, idempotency checks for cached success (replay
      // safety). Inside idempotency, CAS checks baseRevision against
      // the server revision. If CAS passes, all statements execute in
      // ONE atomic ctx.sql.transaction. The lock makes the JS-level
      // CAS safe: only one writer at a time, so the window between the
      // revision read and the transaction is zero.
      return {
        result: await txCtx.locks.withLock('chat:' + chatId, { timeoutMs: 30000 }, async function () {
          return await txCtx.idempotency.run(idempotencyKey, fingerprint, async function () {
            // Lazy schema ensure (idempotent — safe to call every commit).
            await ensureGraphSchema(txCtx, database);

            // Read current revision + meta. We fetch all meta rows so we
            // can (a) check CAS on revision and (b) fall back to existing
            // counts when the caller didn't supply countDelta.
            var metaRows = normalizeSqlRows(
              await txCtx.sql.query(
                database,
                'SELECT meta_key, value_json FROM ' + GRAPH_TABLES.meta + ' WHERE chat_id = ?',
                [chatId]
              )
            );
            var existingMeta = metaRows.length > 0 ? toMetaMap(metaRows) : {};
            var currentRevision = Number(existingMeta.revision);
            if (!Number.isFinite(currentRevision)) currentRevision = 0;

            // CAS check. If the server revision doesn't match the caller's
            // baseRevision, another writer committed first; surface a 409
            // so the caller can re-read and retry.
            if (currentRevision !== baseRevision) {
              var casErr = new Error(
                'BME graph.commitDelta CAS conflict: baseRevision=' + baseRevision +
                ' but serverRevision=' + currentRevision
              );
              casErr.status = 409;
              casErr.code = 'transaction_conflict';
              casErr.details = {
                serverRevision: currentRevision,
                baseRevision: baseRevision,
                chatId: chatId,
              };
              throw casErr;
            }

            // Build statements (throws validation_error if budget exceeded).
            var built = buildCommitDeltaStatements(chatId, baseRevision, delta, options, existingMeta);

            // Execute as ONE atomic transaction.
            if (built.statements.length > 0) {
              await txCtx.sql.transaction(database, built.statements);
            }

            // Compute headHash from the post-commit node/edge record_ids.
            // The lock guarantees no other writer can interleave, so this
            // read is consistent with the just-committed transaction.
            var nodeRows = normalizeSqlRows(
              await txCtx.sql.query(
                database,
                'SELECT record_id FROM ' + GRAPH_TABLES.nodes + ' WHERE chat_id = ? AND deleted_at IS NULL',
                [chatId]
              )
            );
            var edgeRows = normalizeSqlRows(
              await txCtx.sql.query(
                database,
                'SELECT record_id FROM ' + GRAPH_TABLES.edges + ' WHERE chat_id = ? AND deleted_at IS NULL',
                [chatId]
              )
            );
            var nodeIds = extractRecordIds(nodeRows);
            var edgeIds = extractRecordIds(edgeRows);
            var headHash = computeHeadHash(nodeIds, edgeIds, built.nextRevision);

            return {
              ok: true,
              accepted: true,
              revision: built.nextRevision,
              headHash: headHash,
              committedAt: built.committedAt,
              chatId: chatId,
              vectorDirtyHint: Boolean(options.vectorDirtyHint),
              counts: {
                nodeCount: built.nextNodeCount,
                edgeCount: built.nextEdgeCount,
                tombstoneCount: built.nextTombstoneCount,
              },
              applied: {
                upsertedNodes: built.upsertedNodes,
                upsertedEdges: built.upsertedEdges,
                upsertedTombstones: built.upsertedTombstones,
                deletedNodeIds: built.deletedNodeIds,
                deletedEdgeIds: built.deletedEdgeIds,
              },
              statementCount: built.statements.length,
            };
          });
        }),
      };
    },
  });

  if (logger.info) {
    logger.info('[st-bme] Companion authority module activated: third-party.st-bme');
  }
};

module.exports.DEFAULT_BME_DATABASE = DEFAULT_BME_DATABASE;
module.exports.DEFAULT_NAMESPACE = DEFAULT_NAMESPACE;
module.exports.DEFAULT_BME_GRAPH_DATABASE = DEFAULT_BME_GRAPH_DATABASE;
module.exports.BME_GRAPH_SCHEMA_VERSION = BME_GRAPH_SCHEMA_VERSION;
module.exports.MAX_SQL_BATCH_STATEMENTS = MAX_SQL_BATCH_STATEMENTS;
module.exports.CHUNK_ROWS_INSERT = CHUNK_ROWS_INSERT;
module.exports.CHUNK_IDS_DELETE = CHUNK_IDS_DELETE;
module.exports.COMMIT_DELTA_RESERVED_META_KEYS = COMMIT_DELTA_RESERVED_META_KEYS;
module.exports.GRAPH_TABLES = GRAPH_TABLES;
module.exports.GRAPH_SCHEMA_STATEMENTS = GRAPH_SCHEMA_STATEMENTS;
module.exports.GRAPH_META_REPORT_KEYS = GRAPH_META_REPORT_KEYS;
module.exports._validateVectorBatch = validateVectorBatch;
module.exports._buildUpsertItems = buildUpsertItems;
module.exports._buildLinkItems = buildLinkItems;
module.exports._buildManifestFromStat = buildManifestFromStat;
module.exports._resolveDatabase = resolveDatabase;
module.exports._resolveNamespace = resolveNamespace;
module.exports._validateRecallCandidatesInput = validateRecallCandidatesInput;
module.exports._sanitizeSearchHit = sanitizeSearchHit;
module.exports._sanitizeNeighborNode = sanitizeNeighborNode;
module.exports._ensureGraphSchema = ensureGraphSchema;
module.exports._readGraphHead = readGraphHead;
module.exports._computeHeadHash = computeHeadHash;
module.exports._normalizeSqlRows = normalizeSqlRows;
module.exports._toMetaMap = toMetaMap;
module.exports._normalizePayloadRows = normalizePayloadRows;
module.exports._resolveGraphDatabase = resolveGraphDatabase;
module.exports._resolveGraphChatId = resolveGraphChatId;
module.exports._buildGraphMetaReport = buildGraphMetaReport;
module.exports._buildMetaUpsertStatement = buildMetaUpsertStatement;
module.exports._buildNodeInsertStatement = buildNodeInsertStatement;
module.exports._buildEdgeInsertStatement = buildEdgeInsertStatement;
module.exports._buildTombstoneInsertStatement = buildTombstoneInsertStatement;
module.exports._buildDeleteInStatement = buildDeleteInStatement;
module.exports._buildCommitDeltaStatements = buildCommitDeltaStatements;
module.exports._chunkArray = chunkArray;
module.exports.MAX_SEARCH_TOP_K = MAX_SEARCH_TOP_K;
module.exports.MAX_SEARCH_EXPAND_DEPTH = MAX_SEARCH_EXPAND_DEPTH;
