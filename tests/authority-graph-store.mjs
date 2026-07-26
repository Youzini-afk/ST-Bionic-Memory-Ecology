import assert from "node:assert/strict";

import {
  AUTHORITY_GRAPH_STORE_KIND,
  AUTHORITY_GRAPH_STORE_MODE,
  AuthorityGraphCommitConflictError,
  AuthorityGraphModuleUnavailableError,
  AuthorityGraphStore,
  AuthoritySqlHttpClient,
  convertNamedParamsToPositional,
} from "../sync/authority-graph-store.js";
import {
  GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
  GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  GRAPH_OPERATIONAL_MODE_LOCAL_ONLY,
} from "../sync/authority-graph-mode.js";
import {
  BME_DB_SCHEMA_VERSION,
  BME_TOMBSTONE_RETENTION_MS,
} from "../sync/bme-db.js";
import { AuthorityHttpError } from "../runtime/authority-http-client.js";

const PREFIX = "[ST-BME][authority-graph-store]";

class MockAuthoritySqlClient {
  constructor() {
    this.meta = new Map();
    this.nodes = new Map();
    this.edges = new Map();
    this.tombstones = new Map();
    this.statements = [];
  }

  async transaction(statements = []) {
    for (const statement of statements) {
      await this.execute(statement.sql, statement.params || {});
    }
    return { executed: statements.length };
  }

  async execute(sql, params = {}) {
    this.statements.push({ sql, params });
    const normalizedSql = String(sql || "").toLowerCase();
    if (normalizedSql.startsWith("create table")) {
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_meta")) {
      this.meta.set(this._key(params.chatId, params.key), {
        chat_id: params.chatId,
        meta_key: params.key,
        value_json: params.valueJson,
        updated_at: params.updatedAt,
      });
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_nodes")) {
      this.nodes.set(this._key(params.chatId, params.id), {
        chat_id: params.chatId,
        record_id: params.id,
        payload_json: params.payloadJson,
        node_type: params.type,
        source_floor: params.sourceFloor,
        archived: params.archived,
        updated_at: params.updatedAt,
        deleted_at: params.deletedAt,
      });
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_edges")) {
      this.edges.set(this._key(params.chatId, params.id), {
        chat_id: params.chatId,
        record_id: params.id,
        payload_json: params.payloadJson,
        from_id: params.fromId,
        to_id: params.toId,
        relation: params.relation,
        source_floor: params.sourceFloor,
        updated_at: params.updatedAt,
        deleted_at: params.deletedAt,
      });
      return { ok: true };
    }
    if (normalizedSql.includes("insert into st_bme_graph_tombstones")) {
      this.tombstones.set(this._key(params.chatId, params.id), {
        chat_id: params.chatId,
        record_id: params.id,
        payload_json: params.payloadJson,
        tombstone_kind: params.kind,
        target_id: params.targetId,
        deleted_at: params.deletedAt,
        source_device_id: params.sourceDeviceId,
      });
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_nodes")) {
      this._deleteRows(this.nodes, params);
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_edges")) {
      this._deleteRows(this.edges, params);
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_tombstones")) {
      this._deleteRows(this.tombstones, params);
      return { ok: true };
    }
    if (normalizedSql.startsWith("delete from st_bme_graph_meta")) {
      this._deleteRows(this.meta, params);
      return { ok: true };
    }
    throw new Error(`Unhandled SQL execute: ${sql}`);
  }

  async query(sql, params = {}) {
    const normalizedSql = String(sql || "").toLowerCase();
    if (normalizedSql.includes("from st_bme_graph_meta")) {
      return this._readRows(this.meta, params).map((row) => ({
        key: row.meta_key,
        valueJson: row.value_json,
      }));
    }
    if (normalizedSql.includes("from st_bme_graph_nodes")) {
      if (normalizedSql.includes("count(*)")) {
        return [{ count: this._readRows(this.nodes, params).length }];
      }
      return this._readRows(this.nodes, params).map((row) => ({
        payloadJson: row.payload_json,
      }));
    }
    if (normalizedSql.includes("from st_bme_graph_edges")) {
      if (normalizedSql.includes("count(*)")) {
        return [{ count: this._readRows(this.edges, params).length }];
      }
      return this._readRows(this.edges, params).map((row) => ({
        payloadJson: row.payload_json,
      }));
    }
    if (normalizedSql.includes("from st_bme_graph_tombstones")) {
      if (normalizedSql.includes("count(*)")) {
        return [{ count: this._readRows(this.tombstones, params).length }];
      }
      if (normalizedSql.includes("deleted_at <")) {
        return this._readRows(this.tombstones, params)
          .filter((row) => Number(row.deleted_at) < Number(params.cutoffMs))
          .map((row) => ({ id: row.record_id }));
      }
      return this._readRows(this.tombstones, params).map((row) => ({
        payloadJson: row.payload_json,
      }));
    }
    throw new Error(`Unhandled SQL query: ${sql}`);
  }

  _key(chatId, id) {
    return `${String(chatId || "")}\u0000${String(id || "")}`;
  }

  _readRows(table, params = {}) {
    const chatId = String(params.chatId || "");
    const id = params.id ?? params.key;
    return Array.from(table.values()).filter((row) => {
      if (String(row.chat_id || "") !== chatId) return false;
      if (id == null) return true;
      return String(row.record_id ?? row.meta_key ?? "") === String(id);
    });
  }

  _deleteRows(table, params = {}) {
    const chatId = String(params.chatId || "");
    const id = params.id ?? params.key;
    for (const [key, row] of table.entries()) {
      if (String(row.chat_id || "") !== chatId) continue;
      if (id != null && String(row.record_id ?? row.meta_key ?? "") !== String(id)) continue;
      table.delete(key);
    }
  }
}

function createLimitError() {
  const error = new Error("length limit exceeded");
  error.status = 413;
  error.category = "limit";
  error.code = "length_limit_exceeded";
  return error;
}

function isNodeUpsertStatement(statement = {}) {
  return String(statement.sql || "").toLowerCase().includes("insert into st_bme_graph_nodes");
}

async function testOpenSeedsAuthorityMeta() {
  const sqlClient = new MockAuthoritySqlClient();
  const store = new AuthorityGraphStore("authority-chat-a", { sqlClient });
  await store.open();

  assert.equal(store.storeKind, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(store.storeMode, AUTHORITY_GRAPH_STORE_MODE);
  assert.equal(await store.getMeta("schemaVersion"), BME_DB_SCHEMA_VERSION);
  assert.equal(await store.getMeta("storagePrimary"), AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(await store.getMeta("authorityOwned"), false);
  assert.equal(await store.getMeta("graphOperationalMode"), GRAPH_OPERATIONAL_MODE_LOCAL_ONLY);
  assert.equal(await store.getRevision(), 0);

  const diagnostics = store.getStorageDiagnosticsSync();
  assert.equal(diagnostics.storageKind, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(diagnostics.browserCacheMode, "minimal");
}

async function testImportCommitAndExportSnapshot() {
  const sqlClient = new MockAuthoritySqlClient();
  const store = new AuthorityGraphStore("authority-chat-b", { sqlClient });
  await store.open();

  const importResult = await store.importSnapshot(
    {
      meta: {
        revision: 7,
        lastProcessedFloor: 3,
        extractionCount: 4,
      },
      nodes: [
        { id: "node-1", type: "event", sourceFloor: 1, updatedAt: 10 },
        { id: "node-2", type: "event", archived: true, updatedAt: 20 },
        { id: "node-3", type: "memory", deletedAt: 30, updatedAt: 30 },
      ],
      edges: [
        {
          id: "edge-1",
          fromId: "node-1",
          toId: "node-3",
          relation: "refers",
          updatedAt: 40,
        },
      ],
      tombstones: [
        {
          id: "tombstone-1",
          kind: "node",
          targetId: "node-old",
          deletedAt: 50,
        },
      ],
    },
    { preserveRevision: true },
  );

  assert.equal(importResult.revision, 7);
  assert.deepEqual(importResult.imported, { nodes: 3, edges: 1, tombstones: 1 });
  assert.equal((await store.listNodes()).length, 3);
  assert.deepEqual(
    (await store.listNodes({ includeArchived: false, includeDeleted: false })).map((node) => node.id),
    ["node-1"],
  );
  assert.deepEqual((await store.listEdges({ relation: "refers" })).map((edge) => edge.id), ["edge-1"]);

  const commitResult = await store.commitDelta(
    {
      upsertNodes: [{ id: "node-4", type: "event", updatedAt: 60 }],
      deleteNodeIds: ["node-2"],
      countDelta: {
        previous: { nodes: 3, edges: 1, tombstones: 1 },
        delta: { nodes: 0, edges: 0, tombstones: 0 },
      },
      runtimeMetaPatch: {
        lastProcessedFloor: 8,
        revision: 999,
      },
    },
    {
      reason: "test-commit",
      requestedRevision: 9,
    },
  );

  assert.equal(commitResult.revision, 9);
  assert.deepEqual(commitResult.imported, { nodes: 3, edges: 1, tombstones: 1 });
  assert.equal(await store.getMeta("lastProcessedFloor"), 8);
  assert.equal(await store.getRevision(), 9);
  assert.equal(await store.getMeta("lastMutationReason"), "test-commit");
  assert.equal(await store.getMeta("syncDirty"), true);
  assert.deepEqual((await store.listNodes()).map((node) => node.id).sort(), ["node-1", "node-3", "node-4"]);

  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.meta.revision, 9);
  assert.equal(snapshot.meta.storagePrimary, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(snapshot.meta.storageMode, AUTHORITY_GRAPH_STORE_MODE);
  assert.equal(snapshot.meta.nodeCount, 3);
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.edges.length, 1);
  assert.equal(snapshot.tombstones.length, 1);
  assert.equal(snapshot.state.lastProcessedFloor, 8);
}

async function testPruneAndClear() {
  const sqlClient = new MockAuthoritySqlClient();
  const store = new AuthorityGraphStore("authority-chat-c", { sqlClient });
  await store.importSnapshot({
    nodes: [{ id: "node-1", type: "event", updatedAt: 1 }],
    tombstones: [
      { id: "old-tombstone", kind: "node", targetId: "old", deletedAt: 1 },
      {
        id: "new-tombstone",
        kind: "node",
        targetId: "new",
        deletedAt: BME_TOMBSTONE_RETENTION_MS,
      },
    ],
  });

  const pruneResult = await store.pruneExpiredTombstones(BME_TOMBSTONE_RETENTION_MS + 100);
  assert.equal(pruneResult.pruned, 1);
  assert.deepEqual((await store.listTombstones()).map((item) => item.id), ["new-tombstone"]);

  const clearResult = await store.clearAll();
  assert.equal(clearResult.cleared, true);
  assert.equal((await store.isEmpty({ includeTombstones: true })).empty, true);
  assert.equal(await store.getMeta("storagePrimary"), AUTHORITY_GRAPH_STORE_KIND);
}

async function testHttpSqlClientBoundary() {
  const requests = [];
  const client = new AuthoritySqlHttpClient({
    baseUrl: "https://authority.example.test/root/",
    headerProvider: () => ({ "X-Test": "1" }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/session/init")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sessionToken: "sql-session-token" };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { rows: [{ value: 1 }] };
        },
      };
    },
  });

  const result = await client.query("SELECT 1", { chatId: "chat" });
  assert.deepEqual(result, { rows: [{ value: 1 }] });
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://authority.example.test/root/session/init",
      "https://authority.example.test/root/sql/query",
    ],
  );
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers["X-Test"], "1");
  assert.equal(requests[1].init.headers["x-authority-session-token"], "sql-session-token");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    database: "default",
    statement: "SELECT 1",
    params: [],
  });
}

async function testConvertNamedParamsToPositional() {
  // Named params with :placeholders get converted to positional ? with array
  const r1 = convertNamedParamsToPositional(
    "SELECT * FROM t WHERE chat_id = :chatId AND meta_key = :key",
    { chatId: "abc", key: "rev" },
  );
  assert.equal(r1.sql, "SELECT * FROM t WHERE chat_id = ? AND meta_key = ?");
  assert.deepEqual(r1.params, ["abc", "rev"]);

  // Duplicate named params produce multiple positional entries
  const r2 = convertNamedParamsToPositional(
    "INSERT INTO t (a, b) VALUES (:chatId, :chatId)",
    { chatId: "dup" },
  );
  assert.equal(r2.sql, "INSERT INTO t (a, b) VALUES (?, ?)");
  assert.deepEqual(r2.params, ["dup", "dup"]);

  // No placeholders → empty array
  const r3 = convertNamedParamsToPositional("SELECT 1", { chatId: "x" });
  assert.equal(r3.sql, "SELECT 1");
  assert.deepEqual(r3.params, []);

  // Already-array params pass through unchanged
  const r4 = convertNamedParamsToPositional("SELECT ?", [42]);
  assert.equal(r4.sql, "SELECT ?");
  assert.deepEqual(r4.params, [42]);

  // Empty/null params → empty array
  const r5 = convertNamedParamsToPositional("SELECT 1", null);
  assert.deepEqual(r5.params, []);
  const r6 = convertNamedParamsToPositional("SELECT 1", undefined);
  assert.deepEqual(r6.params, []);

  // Missing param name → null in array
  const r7 = convertNamedParamsToPositional(
    "WHERE x = :x AND y = :y",
    { x: 1 },
  );
  assert.equal(r7.sql, "WHERE x = ? AND y = ?");
  assert.deepEqual(r7.params, [1, null]);

  // ::typecast is not treated as a named param
  const r8 = convertNamedParamsToPositional(
    "SELECT x::text FROM t WHERE id = :id",
    { id: 5 },
  );
  assert.equal(r8.sql, "SELECT x::text FROM t WHERE id = ?");
  assert.deepEqual(r8.params, [5]);
}

async function testTransactionBatchingUsesByteBudget() {
  const sqlClient = new MockAuthoritySqlClient();
  const batchSizes = [];
  const originalTransaction = sqlClient.transaction.bind(sqlClient);
  sqlClient.transaction = async (statements = []) => {
    if (statements.some(isNodeUpsertStatement)) {
      batchSizes.push(statements.length);
    }
    return await originalTransaction(statements);
  };
  const store = new AuthorityGraphStore("authority-chat-byte-budget", {
    sqlClient,
    sqlTransactionBatchSize: 150,
    sqlTransactionMaxBytes: 4096,
  });
  const nodes = Array.from({ length: 8 }, (_, index) => ({
    id: `node-${index}`,
    type: "event",
    text: `payload-${index}-${"測試".repeat(260)}`,
    updatedAt: index + 1,
  }));

  await store.bulkUpsertNodes(nodes);

  assert.equal((await store.listNodes()).length, nodes.length);
  assert.ok(batchSizes.length > 1, "expected large payload to split into multiple transactions");
  assert.ok(batchSizes.every((size) => size < nodes.length), "expected no single node transaction batch to contain all records");
}

async function testTransaction413SplitsWithoutRepeatingOversizedBatch() {
  const sqlClient = new MockAuthoritySqlClient();
  const attemptedBatchSizes = [];
  const originalTransaction = sqlClient.transaction.bind(sqlClient);
  sqlClient.transaction = async (statements = []) => {
    const nodeBatchSize = statements.filter(isNodeUpsertStatement).length;
    if (nodeBatchSize > 0) {
      attemptedBatchSizes.push(nodeBatchSize);
      if (nodeBatchSize > 2) {
        throw createLimitError();
      }
    }
    return await originalTransaction(statements);
  };
  const store = new AuthorityGraphStore("authority-chat-413-split", {
    sqlClient,
    sqlTransactionBatchSize: 150,
    sqlTransactionMaxBytes: 512 * 1024,
  });
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    id: `node-${index}`,
    type: "event",
    text: `payload-${index}`,
    updatedAt: index + 1,
  }));

  await store.bulkUpsertNodes(nodes);

  assert.equal((await store.listNodes()).length, nodes.length);
  assert.equal(attemptedBatchSizes[0], 6);
  assert.ok(attemptedBatchSizes.some((size) => size <= 2), "expected oversized request to be split below the failing size");
  assert.ok(attemptedBatchSizes.length <= 10, "expected bounded split attempts instead of an endless retry loop");
}

async function testSingleStatement413IsTerminal() {
  const sqlClient = new MockAuthoritySqlClient();
  let oversizedAttempts = 0;
  sqlClient.transaction = async (statements = []) => {
    if (statements.some(isNodeUpsertStatement)) {
      oversizedAttempts += 1;
      throw createLimitError();
    }
    for (const statement of statements) {
      await sqlClient.execute(statement.sql, statement.params || {});
    }
    return { executed: statements.length };
  };
  const store = new AuthorityGraphStore("authority-chat-single-413", { sqlClient });

  await assert.rejects(
    () => store.bulkUpsertNodes([{ id: "too-large", type: "event", text: "x".repeat(1024), updatedAt: 1 }]),
    (error) => {
      assert.equal(error.name, "AuthoritySqlPayloadTooLargeError");
      assert.equal(error.nonRetryable, true);
      assert.equal(error.terminal, true);
      return true;
    },
  );
  assert.ok(oversizedAttempts >= 1, "expected the oversized record to be attempted at least once");
  assert.ok(oversizedAttempts <= 4, "single oversized record must not retry forever");
}

await testConvertNamedParamsToPositional();
await testOpenSeedsAuthorityMeta();
await testImportCommitAndExportSnapshot();
await testPruneAndClear();
await testHttpSqlClientBoundary();
await testTransactionBatchingUsesByteBudget();
await testTransaction413SplitsWithoutRepeatingOversizedBatch();
await testSingleStatement413IsTerminal();

// --- Phase F: companion module graph.commitDelta integration tests ---
// These exercise the AuthorityGraphStore.commitDelta wrapper:
//   1. Success path — calls bmeGraphCommit, unwraps response.result, patches
//      local meta cache, returns compatible shape.
//   2. transaction_conflict — re-throws as AuthorityGraphCommitConflictError,
//      does NOT fall back to local chunked write.
//   3. Other module error (module_not_loaded / network) — falls back to
//      the local chunked commitDeltaLocal path and logs a warning.

function createBmeGraphModuleClientMock({
  commitResult = null,
  commitError = null,
  extractionResult = null,
  extractionError = null,
  headResult = null,
  headError = null,
} = {}) {
  const calls = {
    bmeGraphCommit: [],
    bmeGraphGetHead: [],
    bmeExtractionCommitBatch: [],
  };
  return {
    calls,
    async bmeGraphCommit(input, options = {}) {
      calls.bmeGraphCommit.push({ input, options });
      if (commitError) throw commitError;
      return (
        commitResult || {
          ok: true,
          accepted: true,
          revision: 42,
          headHash: "sha256:mock",
          committedAt: 1700000000000,
          chatId: input?.chatId || "chat",
          vectorDirtyHint: Boolean(input?.options?.vectorDirtyHint),
          counts: { nodeCount: 2, edgeCount: 1, tombstoneCount: 0 },
          applied: {
            upsertedNodes: (input?.delta?.upsertNodes || []).length,
            upsertedEdges: (input?.delta?.upsertEdges || []).length,
            upsertedTombstones: (input?.delta?.tombstones || []).length,
            deletedNodeIds: (input?.delta?.deleteNodeIds || []).length,
            deletedEdgeIds: (input?.delta?.deleteEdgeIds || []).length,
          },
          statementCount: 5,
        }
      );
    },
    async bmeGraphGetHead(input, options = {}) {
      calls.bmeGraphGetHead.push({ input, options });
      if (headError) throw headError;
      return headResult || { ok: true, revision: 42, headHash: "sha256:head" };
    },
    async bmeExtractionCommitBatch(input, options = {}) {
      calls.bmeExtractionCommitBatch.push({ input, options });
      if (extractionError) throw extractionError;
      return extractionResult || {
        ok: true,
        accepted: true,
        revision: 43,
        headHash: "sha256:batch",
        committedAt: "2026-01-01T00:00:00.000Z",
        batchId: input?.batchId,
        vectorDirtyGeneration: 2,
        extraction: { lastProcessedAssistantFloor: input?.extraction?.nextLastProcessedFloor, extractionCount: input?.extraction?.nextExtractionCount },
        statementCount: 7,
      };
    },
  };
}

async function testCommitExtractionBatchSuccess() {
  const sqlClient = new MockAuthoritySqlClient();
  const bmeGraphModuleClient = createBmeGraphModuleClientMock({ headResult: { ok: true, revision: 9, headHash: "sha256:head9" } });
  const store = new AuthorityGraphStore("authority-chat-extraction", {
    sqlClient,
    bmeGraphCommitReady: true,
    isAuthorityModuleGraphCommitReady: true,
    bmeExtractionCommitBatchReady: true,
    isAuthorityModuleExtractionCommitBatchReady: true,
    bmeGraphModuleClient,
  });
  await store.open();
  const result = await store.commitExtractionBatch({
    persistDelta: { upsertNodes: [{ id: "node-batch", type: "event" }], runtimeMetaPatch: { custom: true } },
    committedBatchJournalEntry: { id: "batch-abc", processedRange: [4, 6], stateBefore: { lastProcessedAssistantFloor: 3 } },
    processedRange: [4, 6],
    previousLastProcessedFloor: 3,
    lastProcessedAssistantFloor: 6,
    extractionCountBefore: 10,
    extractionCountAfter: 11,
    messageHashes: [{ floor: 6, messageHash: "hash-6", hashVersion: 1 }],
    pruneMessageHashesFromFloor: 4,
  }, { reason: "extraction-test" });
  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "authority-sql");
  assert.equal(result.acceptedBy, "extraction.commitBatch");
  assert.equal(result.batchJournalDurable, true);
  const call = bmeGraphModuleClient.calls.bmeExtractionCommitBatch[0];
  assert.equal(call.input.baseRevision, 9, "baseRevision must come from fresh getHead");
  assert.ok(call.input.batchId.startsWith("batch-"));
  assert.equal(call.options.idempotencyKey, `extraction:authority-chat-extraction:${call.input.batchId}`);
  assert.equal(call.input.delta.runtimeMetaPatch.authorityOwned, true);
  assert.deepEqual(call.input.messageHashes, [{ floor: 6, messageHash: "hash-6", hashVersion: 1 }]);
  assert.equal(await store.getMeta("revision"), 43);
  assert.equal(await store.getMeta("lastProcessedAssistantFloor"), 6);
  assert.equal(await store.getMeta("extractionCount"), 11);
  assert.equal(await store.getMeta("authorityOwned"), true);
}

async function testCommitExtractionBatchStableBatchIdIgnoresRandomJournalId() {
  const sqlClient = new MockAuthoritySqlClient();
  const bmeGraphModuleClient = createBmeGraphModuleClientMock({ headResult: { ok: true, revision: 9, headHash: "sha256:head9" } });
  const store = new AuthorityGraphStore("authority-chat-extraction-stable", {
    sqlClient,
    bmeExtractionCommitBatchReady: true,
    isAuthorityModuleExtractionCommitBatchReady: true,
    bmeGraphModuleClient,
  });
  await store.open();
  const base = {
    persistDelta: { upsertNodes: [{ id: "node-stable", type: "event" }] },
    processedRange: [4, 6],
    previousLastProcessedFloor: 3,
    lastProcessedAssistantFloor: 6,
    extractionCountBefore: 10,
    extractionCountAfter: 11,
    messageHashes: [{ floor: 6, messageHash: "hash-6", hashVersion: 1 }],
  };
  await store.commitExtractionBatch({ ...base, committedBatchJournalEntry: { id: "batch-random-a", createdAt: 1700000000000, processedRange: [4, 6], stable: true } });
  await store.commitExtractionBatch({ ...base, committedBatchJournalEntry: { id: "batch-random-b", createdAt: 1800000000000, processedRange: [4, 6], stable: true } });
  const first = bmeGraphModuleClient.calls.bmeExtractionCommitBatch[0];
  const second = bmeGraphModuleClient.calls.bmeExtractionCommitBatch[1];
  assert.equal(first.input.batchId, second.input.batchId, "logical retries with different journal ids must use same durable batchId");
  assert.equal(first.options.idempotencyKey, second.options.idempotencyKey, "logical retries with different journal ids must use same idempotency key");
  await store.commitExtractionBatch({ ...base, extractionCountAfter: 12, committedBatchJournalEntry: { id: "batch-random-c", createdAt: 1800000000000, processedRange: [4, 6], stable: true } });
  const third = bmeGraphModuleClient.calls.bmeExtractionCommitBatch[2];
  assert.notEqual(first.input.batchId, third.input.batchId, "semantic extraction changes must produce a different durable batchId");
}

async function testCommitExtractionBatchConflictAndUnavailableNoFallback() {
  const conflictError = new AuthorityHttpError("conflict", { status: 409, code: "transaction_conflict", payload: { code: "transaction_conflict", details: { serverRevision: 10, baseRevision: 9 } } });
  const conflictClient = createBmeGraphModuleClientMock({ extractionError: conflictError, headResult: { ok: true, revision: 9 } });
  const conflictStore = new AuthorityGraphStore("authority-chat-extraction-conflict", { sqlClient: new MockAuthoritySqlClient(), bmeExtractionCommitBatchReady: true, isAuthorityModuleExtractionCommitBatchReady: true, bmeGraphModuleClient: conflictClient });
  await conflictStore.open();
  await assert.rejects(
    () => conflictStore.commitExtractionBatch({ persistDelta: {}, committedBatchJournalEntry: { id: "batch-conflict", processedRange: [1, 2] }, lastProcessedAssistantFloor: 2, extractionCountAfter: 1 }),
    (error) => error instanceof AuthorityGraphCommitConflictError,
  );

  const unavailableStore = new AuthorityGraphStore("authority-chat-extraction-unavail", { sqlClient: new MockAuthoritySqlClient(), bmeExtractionCommitBatchReady: false, isAuthorityModuleExtractionCommitBatchReady: false, bmeGraphModuleClient: createBmeGraphModuleClientMock() });
  await unavailableStore.open();
  await assert.rejects(
    () => unavailableStore.commitExtractionBatch({ persistDelta: {}, committedBatchJournalEntry: { id: "batch-unavail", processedRange: [1, 2] }, lastProcessedAssistantFloor: 2, extractionCountAfter: 1 }),
    (error) => error instanceof AuthorityGraphModuleUnavailableError,
  );
}

async function testCommitDeltaViaModuleSuccess() {
  const sqlClient = new MockAuthoritySqlClient();
  const bmeGraphModuleClient = createBmeGraphModuleClientMock();
  const store = new AuthorityGraphStore("authority-chat-module-success", {
    sqlClient,
    bmeGraphCommitReady: true,
    isAuthorityModuleGraphCommitReady: true,
    bmeGraphModuleClient,
  });
  await store.open();

  const result = await store.commitDelta(
    {
      upsertNodes: [{ id: "node-mod-1", type: "event", updatedAt: 100 }],
      upsertEdges: [],
      tombstones: [],
      deleteNodeIds: [],
      deleteEdgeIds: [],
      runtimeMetaPatch: { lastProcessedFloor: 5 },
    },
    { reason: "module-commit-test", markSyncDirty: true },
  );

  assert.equal(result.revision, 42, "should return server revision");
  assert.equal(result.headHash, "sha256:mock");
  assert.equal(result.diagnostics.commitPath, "bme-module");
  assert.equal(result.diagnostics.storageKind, AUTHORITY_GRAPH_STORE_KIND);
  assert.equal(result.delta.upsertNodes, 1);

  // Verify idempotencyKey was lifted to the envelope.
  const commitCall = bmeGraphModuleClient.calls.bmeGraphCommit[0];
  assert.ok(commitCall.options.idempotencyKey, "idempotencyKey must be lifted to envelope options");
  assert.equal(typeof commitCall.options.idempotencyKey, "string");

  // Verify input shape.
  assert.equal(commitCall.input.chatId, "authority-chat-module-success");
  assert.equal(commitCall.input.baseRevision, 0, "baseRevision defaults to local revision");
  assert.ok(Array.isArray(commitCall.input.delta.upsertNodes));
  assert.equal(commitCall.input.delta.upsertNodes.length, 1);
  assert.equal(commitCall.input.delta.runtimeMetaPatch.authorityOwned, true);
  assert.equal(
    commitCall.input.delta.runtimeMetaPatch.graphOperationalMode,
    GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  );
  assert.equal(commitCall.input.delta.runtimeMetaPatch.lastProcessedFloor, 5);
  assert.equal(commitCall.input.options.markSyncDirty, true);
  assert.equal(commitCall.input.options.reason, "module-commit-test");

  // Verify local meta cache was patched after the server commit.
  assert.equal(await store.getMeta("revision"), 42);
  assert.equal(await store.getMeta("lastMutationReason"), "module-commit-test");
  assert.equal(await store.getMeta("authorityOwned"), true);
  assert.equal(await store.getMeta("graphOperationalMode"), GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY);
  assert.equal(store.authorityOwned, true);
  assert.equal(store.graphOperationalMode, GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY);
}

async function testCommitDeltaViaModuleTransactionConflictThrows() {
  const sqlClient = new MockAuthoritySqlClient();
  // Simulate a 409 transaction_conflict response from the DOA module host.
  const conflictError = new AuthorityHttpError(
    "BME graph.commitDelta CAS conflict: baseRevision=0 but serverRevision=5",
    {
      status: 409,
      code: "transaction_conflict",
      category: "validation",
      payload: {
        error: "BME graph.commitDelta CAS conflict",
        code: "transaction_conflict",
        details: {
          code: "transaction_conflict",
          serverRevision: 5,
          baseRevision: 0,
          chatId: "authority-chat-conflict",
        },
      },
      path: "/modules/third-party.st-bme/transactions/graph.commitDelta",
    },
  );
  const bmeGraphModuleClient = createBmeGraphModuleClientMock({ commitError: conflictError });
  const store = new AuthorityGraphStore("authority-chat-conflict", {
    sqlClient,
    bmeGraphCommitReady: true,
    isAuthorityModuleGraphCommitReady: true,
    bmeGraphModuleClient,
  });
  await store.open();

  let caught = null;
  try {
    await store.commitDelta(
      {
        upsertNodes: [{ id: "node-conflict", type: "event", updatedAt: 100 }],
      },
      { reason: "conflict-test" },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthorityGraphCommitConflictError, "must re-throw as AuthorityGraphCommitConflictError");
  assert.equal(caught.code, "transaction_conflict");
  assert.equal(caught.serverRevision, 5);
  assert.equal(caught.baseRevision, 0);

  // Must NOT have attempted a fallback local write — the sqlClient should
  // not have received any upsert statements.
  const nodeUpserts = sqlClient.statements.filter((s) =>
    String(s.sql || "").toLowerCase().includes("insert into st_bme_graph_nodes"),
  );
  assert.equal(nodeUpserts.length, 0, "must NOT fall back to local chunked write on transaction_conflict");
}

async function testCommitDeltaViaModuleOtherModuleErrorFallsBackToLocal() {
  const sqlClient = new MockAuthoritySqlClient();
  // Simulate a module_not_loaded error from the DOA module host.
  const moduleError = new AuthorityHttpError(
    "BME companion module 'third-party.st-bme' is not loaded: Module not loaded",
    {
      status: 409,
      code: "module_not_loaded",
      category: "validation",
      payload: {
        error: "Module not loaded: third-party.st-bme",
        code: "validation_error",
        details: { code: "module_not_loaded", moduleId: "third-party.st-bme" },
      },
      path: "/modules/third-party.st-bme/transactions/graph.commitDelta",
    },
  );
  const bmeGraphModuleClient = createBmeGraphModuleClientMock({ commitError: moduleError });
  const store = new AuthorityGraphStore("authority-chat-fallback", {
    sqlClient,
    bmeGraphCommitReady: true,
    isAuthorityModuleGraphCommitReady: true,
    bmeGraphModuleClient,
  });
  await store.open();

  const result = await store.commitDelta(
    {
      upsertNodes: [{ id: "node-fallback", type: "event", updatedAt: 200 }],
      countDelta: {
        previous: { nodes: 0, edges: 0, tombstones: 0 },
        delta: { nodes: 1, edges: 0, tombstones: 0 },
      },
    },
    { reason: "fallback-test" },
  );

  // Should have fallen back to local chunked path (commitDeltaLocal).
  assert.equal(result.diagnostics.commitPath, undefined, "fallback path must NOT set commitPath=bme-module");
  assert.equal(result.diagnostics.storageKind, AUTHORITY_GRAPH_STORE_KIND);
  // Local chunked path bumped revision to 1.
  assert.equal(result.revision, 1);

  // Verify a node upsert was actually executed against the SQL client.
  const nodeUpserts = sqlClient.statements.filter((s) =>
    String(s.sql || "").toLowerCase().includes("insert into st_bme_graph_nodes"),
  );
  assert.ok(nodeUpserts.length > 0, "fallback path must have written the node locally");

  // The bmeGraphCommit client must have been attempted exactly once.
  assert.equal(bmeGraphModuleClient.calls.bmeGraphCommit.length, 1, "module client should have been attempted once before fallback");
}

async function testCommitDeltaViaModuleOtherModuleErrorThrowsForAuthorityPrimary() {
  const sqlClient = new MockAuthoritySqlClient();
  const moduleError = new AuthorityHttpError(
    "BME companion module unavailable",
    {
      status: 503,
      code: "module_unavailable",
      category: "module-unavailable",
      payload: { error: "module unavailable", code: "module_unavailable" },
    },
  );
  const bmeGraphModuleClient = createBmeGraphModuleClientMock({ commitError: moduleError });
  const store = new AuthorityGraphStore("authority-chat-primary-no-fallback", {
    sqlClient,
    bmeGraphCommitReady: true,
    isAuthorityModuleGraphCommitReady: true,
    bmeGraphModuleClient,
    authorityOwned: true,
    graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  });
  await store.open();

  await assert.rejects(
    () => store.commitDelta({ upsertNodes: [{ id: "node-no-fallback", type: "event", updatedAt: 1 }] }),
    (error) => {
      assert.ok(error instanceof AuthorityGraphModuleUnavailableError);
      assert.equal(error.code, "authority_module_unavailable");
      return true;
    },
  );

  const nodeUpserts = sqlClient.statements.filter((s) =>
    String(s.sql || "").toLowerCase().includes("insert into st_bme_graph_nodes"),
  );
  assert.equal(nodeUpserts.length, 0, "authority-primary module errors must not fall back to local write");
  assert.equal(store.graphOperationalMode, GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED);
}

async function testCommitDeltaLocalPathWhenModuleNotReady() {
  const sqlClient = new MockAuthoritySqlClient();
  const bmeGraphModuleClient = createBmeGraphModuleClientMock();
  // bmeGraphCommitReady defaults to false → must use local path.
  const store = new AuthorityGraphStore("authority-chat-not-ready", {
    sqlClient,
    bmeGraphModuleClient,
  });
  await store.open();

  const result = await store.commitDelta(
    {
      upsertNodes: [{ id: "node-local", type: "event", updatedAt: 300 }],
    },
    { reason: "local-only-test" },
  );

  assert.equal(bmeGraphModuleClient.calls.bmeGraphCommit.length, 0, "module client must NOT be called when bmeGraphCommitReady is false");
  assert.equal(result.diagnostics.commitPath, undefined, "local path must NOT set commitPath=bme-module");
  assert.equal(result.revision, 1);
}

async function testCommitDeltaModuleNotReadyThrowsForAuthorityOwned() {
  const sqlClient = new MockAuthoritySqlClient();
  const bmeGraphModuleClient = createBmeGraphModuleClientMock();
  const store = new AuthorityGraphStore("authority-chat-not-ready-owned", {
    sqlClient,
    bmeGraphModuleClient,
    authorityOwned: true,
    graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_PRIMARY,
  });
  await store.open();

  await assert.rejects(
    () => store.commitDelta({ upsertNodes: [{ id: "node-owned", type: "event", updatedAt: 300 }] }),
    (error) => {
      assert.ok(error instanceof AuthorityGraphModuleUnavailableError);
      assert.equal(error.code, "authority_module_unavailable");
      return true;
    },
  );
  assert.equal(bmeGraphModuleClient.calls.bmeGraphCommit.length, 0, "module client must not be called when readiness is false");
  const nodeUpserts = sqlClient.statements.filter((s) =>
    String(s.sql || "").toLowerCase().includes("insert into st_bme_graph_nodes"),
  );
  assert.equal(nodeUpserts.length, 0, "authority-owned not-ready path must not write locally");
}

async function testGetHeadUsesModule() {
  const sqlClient = new MockAuthoritySqlClient();
  const bmeGraphModuleClient = createBmeGraphModuleClientMock({
    headResult: { ok: true, revision: 77, headHash: "sha256:module-head", chatId: "authority-chat-head" },
  });
  const store = new AuthorityGraphStore("authority-chat-head", {
    sqlClient,
    bmeGraphCommitReady: true,
    isAuthorityModuleGraphCommitReady: true,
    bmeGraphModuleClient,
  });
  await store.open();

  const head = await store.getHead({ timeoutMs: 1234 });

  assert.equal(head.revision, 77);
  assert.equal(head.headHash, "sha256:module-head");
  assert.equal(head.source, "bme-module");
  assert.equal(bmeGraphModuleClient.calls.bmeGraphGetHead.length, 1);
  assert.equal(bmeGraphModuleClient.calls.bmeGraphGetHead[0].options.timeoutMs, 1234);
}

await testCommitDeltaViaModuleSuccess();
await testCommitDeltaViaModuleTransactionConflictThrows();
await testCommitDeltaViaModuleOtherModuleErrorFallsBackToLocal();
await testCommitDeltaViaModuleOtherModuleErrorThrowsForAuthorityPrimary();
await testCommitDeltaLocalPathWhenModuleNotReady();
await testCommitDeltaModuleNotReadyThrowsForAuthorityOwned();
await testGetHeadUsesModule();
await testCommitExtractionBatchSuccess();
await testCommitExtractionBatchStableBatchIdIgnoresRandomJournalId();
await testCommitExtractionBatchConflictAndUnavailableNoFallback();

console.log(`${PREFIX} all tests passed`);
