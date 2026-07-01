'use strict';

import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_CJS = path.resolve(__dirname, '..', '.authority', 'server.cjs');
const MODULE_JSON = path.resolve(__dirname, '..', '.authority', 'module.json');

function createMockTxCtx() {
  const calls = {
    bulkUpsert: [],
    bulkLink: [],
    stat: [],
    searchHybrid: [],
    resolveMany: [],
    neighbors: [],
  };
  const trivium = {
    listDatabases: async () => ({ databases: [] }),
    stat: async (req) => {
      calls.stat.push(req);
      return {
        exists: true,
        nodeCount: 42,
        edgeCount: 7,
        mappingCount: 42,
        indexCount: 3,
        orphanMappingCount: 0,
        lastFlushAt: null,
        updatedAt: '2024-01-01T00:00:00Z',
        indexHealth: null,
      };
    },
    bulkUpsert: async (req) => {
      calls.bulkUpsert.push(req);
      return {
        totalCount: req.items.length,
        successCount: req.items.length,
        failureCount: 0,
        failures: [],
        items: req.items.map((item, i) => ({ index: i, id: i + 1, action: 'insert', externalId: item.externalId, namespace: item.namespace })),
      };
    },
    bulkLink: async (req) => {
      calls.bulkLink.push(req);
      return {
        totalCount: req.items.length,
        successCount: req.items.length,
        failureCount: 0,
        failures: [],
      };
    },
    searchHybrid: async (req) => {
      calls.searchHybrid.push(req);
      return [
        { id: 1, externalId: 'node-a', namespace: 'ns-1', score: 0.92, payload: { text: 'secret', content: 'should-strip' } },
        { id: 2, externalId: 'node-b', namespace: 'ns-1', score: 0.85, payload: { text: 'hidden', messages: ['no'] } },
      ];
    },
    resolveMany: async (req) => {
      calls.resolveMany.push(req);
      return {
        items: (req.items || []).map((item, i) => ({
          index: i,
          id: i + 1,
          externalId: item.externalId,
          namespace: item.namespace || null,
        })),
      };
    },
    neighbors: async (req) => {
      calls.neighbors.push(req);
      return {
        ids: [10, 11],
        nodes: [
          { id: 10, externalId: 'node-c', namespace: 'ns-1' },
          { id: 11, externalId: 'node-d', namespace: 'ns-1' },
        ],
      };
    },
  };
  return {
    calls,
    ctx: {
      moduleId: 'third-party.st-bme',
      ownerExtensionId: 'third-party/st-bme',
      moduleVersion: '7.8.4',
      transactionName: '',
      transactionVersion: '1.0.0',
      callerExtensionId: 'third-party/test-extension',
      requestId: 'test-req-1',
      limits: { maxRequestBytes: 67108864, maxResponseBytes: 67108864, timeoutMs: 120000, source: 'manifest' },
      logger: { info() {}, warn() {}, error() {} },
      audit: { logUsage: async () => {}, logWarning: async () => {}, logError: async () => {} },
      authorize: async () => true,
      signal: new AbortController().signal,
      trivium,
    },
  };
}

// Mock ctx for graph.getHead / graph.loadSnapshot / graph.commitDelta tests.
// The mock ctx.sql has `query`, `exec`, and `transaction` methods. The query
// mock inspects the statement string to decide which rows to return (meta
// rows, node/edge record_ids for getHead/commitDelta post-commit headHash,
// or node/edge/tombstone payloads for loadSnapshot). The transaction mock
// captures all statements and returns committed:true. The mock ctx also
// exposes `locks` (real in-memory withLock) and `idempotency` (caching run
// with fingerprint-mismatch detection) so graph.commitDelta tests can
// exercise the lock → idempotency → CAS → transaction pipeline without
// a live DOA host.
function createMockSqlTxCtx(options = {}) {
  const {
    meta = {},
    nodes = [],
    edges = [],
    tombstones = [],
    idempotencyCache = new Map(),
    transactionDelayMs = 0,
  } = options;
  const calls = {
    query: [],
    exec: [],
    transaction: [],
    lock: [],
    idempotencyRun: [],
  };

  const metaRows = Object.entries(meta).map(([key, value]) => ({
    meta_key: key,
    value_json: JSON.stringify(value),
  }));
  const nodeRecordIdRows = nodes.map((n) => ({ record_id: String(n.id) }));
  const nodePayloadRows = nodes.map((n) => ({ payload_json: JSON.stringify(n) }));
  const edgeRecordIdRows = edges.map((e) => ({ record_id: String(e.id) }));
  const edgePayloadRows = edges.map((e) => ({ payload_json: JSON.stringify(e) }));
  const tombstonePayloadRows = tombstones.map((t) => ({ payload_json: JSON.stringify(t) }));

  const sql = {
    exec: async (database, statement, params) => {
      calls.exec.push({ database, statement, params });
      return { kind: 'exec', rowsAffected: 0, lastInsertRowid: null };
    },
    query: async (database, statement, params) => {
      calls.query.push({ database, statement, params });
      let rows = [];
      let columns = [];
      if (statement.includes('st_bme_graph_meta')) {
        rows = metaRows;
        columns = ['meta_key', 'value_json'];
      } else if (statement.includes('st_bme_graph_nodes') && statement.includes('record_id')) {
        rows = nodeRecordIdRows;
        columns = ['record_id'];
      } else if (statement.includes('st_bme_graph_nodes')) {
        rows = nodePayloadRows;
        columns = ['payload_json'];
      } else if (statement.includes('st_bme_graph_edges') && statement.includes('record_id')) {
        rows = edgeRecordIdRows;
        columns = ['record_id'];
      } else if (statement.includes('st_bme_graph_edges')) {
        rows = edgePayloadRows;
        columns = ['payload_json'];
      } else if (statement.includes('st_bme_graph_tombstones')) {
        rows = tombstonePayloadRows;
        columns = ['payload_json'];
      }
      return { kind: 'query', columns, rows, rowCount: rows.length };
    },
    transaction: async (database, statements) => {
      calls.transaction.push({ database, statements });
      if (transactionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, transactionDelayMs));
      }
      return {
        committed: true,
        results: statements.map(() => ({ kind: 'exec', rowsAffected: 1, lastInsertRowid: null })),
      };
    },
  };

  // Real in-memory lock service. Mirrors the DOA LockService contract:
  // FIFO ordering through a promise chain, released in finally on both
  // success and failure. Used by graph.commitDelta to serialize per-chat
  // writers.
  const lockMap = new Map();
  const locks = {
    withLock: async (scope, lockOpts, fn) => {
      calls.lock.push({ scope, opts: lockOpts });
      const prev = lockMap.get(scope) || Promise.resolve();
      // Chain on the previous holder's promise. fn runs after prev
      // settles (success OR failure) so a thrown fn doesn't deadlock
      // subsequent waiters.
      const next = prev.then(fn, fn);
      // Store a chain that swallows errors so a failed fn doesn't break
      // the chain for later waiters.
      lockMap.set(scope, next.then(() => {}, () => {}));
      return await next;
    },
  };

  // Caching idempotency mock. Mirrors the DOA IdempotencyService.run
  // contract: cache by key+fingerprint, return cached on exact match,
  // throw idempotency_conflict (409) on same key + different fingerprint.
  // Errors from fn are NOT cached (a retry after error re-executes fn).
  const idempotency = {
    run: async (key, fingerprint, fn) => {
      calls.idempotencyRun.push({ key, fingerprint });
      const exactKey = key + '::' + fingerprint;
      if (idempotencyCache.has(exactKey)) {
        return idempotencyCache.get(exactKey);
      }
      // Check for same key, different fingerprint → conflict.
      for (const [k] of idempotencyCache.entries()) {
        if (k.startsWith(key + '::') && k !== exactKey) {
          const err = new Error('idempotency_conflict: key=' + key);
          err.status = 409;
          err.code = 'idempotency_conflict';
          err.details = {
            key,
            expectedFingerprint: k.slice(key.length + 2),
            actualFingerprint: fingerprint,
          };
          throw err;
        }
      }
      const result = await fn();
      idempotencyCache.set(exactKey, result);
      return result;
    },
    lookup: async () => null,
    record: async (key, fingerprint, response) => {
      idempotencyCache.set(key + '::' + fingerprint, response);
    },
  };

  return {
    calls,
    idempotencyCache,
    ctx: {
      moduleId: 'third-party.st-bme',
      ownerExtensionId: 'third-party/st-bme',
      moduleVersion: '7.8.4',
      transactionName: '',
      transactionVersion: '1',
      callerExtensionId: 'third-party/test-extension',
      requestId: 'test-req-graph-1',
      limits: { maxRequestBytes: 67108864, maxResponseBytes: 67108864, timeoutMs: 120000, source: 'manifest' },
      logger: { info() {}, warn() {}, error() {} },
      audit: { logUsage: async () => {}, logWarning: async () => {}, logError: async () => {} },
      authorize: async () => true,
      signal: new AbortController().signal,
      sql,
      locks,
      idempotency,
    },
  };
}

async function run() {
  console.log('[test:authority-companion-module] loading server.cjs');
  const mod = require(SERVER_CJS);
  assert.strictEqual(typeof mod.activate, 'function', 'activate must be a function');
  assert.strictEqual(mod.BME_GRAPH_SCHEMA_VERSION, 2, 'BME graph schema version must be 2');

  console.log('[test:authority-companion-module] testing graph schema v2 DDL shape');
  {
    const ddl = mod.GRAPH_SCHEMA_STATEMENTS.join('\n');
    assert.ok(ddl.includes('st_bme_extraction_state'), 'DDL must include extraction state table');
    assert.ok(ddl.includes('last_processed_assistant_floor'), 'extraction state must include last_processed_assistant_floor');
    assert.ok(ddl.includes('st_bme_message_hashes'), 'DDL must include message hashes table');
    assert.ok(ddl.includes('message_hash'), 'message hashes table must include message_hash');
    assert.ok(ddl.includes('st_bme_batch_journal'), 'DDL must include batch journal table');
    assert.ok(ddl.includes('request_fingerprint'), 'batch journal must include request_fingerprint');
    assert.ok(ddl.includes('request_fingerprint TEXT NOT NULL'), 'batch journal request_fingerprint must be NOT NULL');
    assert.ok(ddl.includes('last_processed_floor_after INTEGER NOT NULL'), 'batch journal last_processed_floor_after must be NOT NULL');
    assert.ok(ddl.includes('extraction_count_after INTEGER NOT NULL'), 'batch journal extraction_count_after must be NOT NULL');
    assert.ok(ddl.includes('journal_json TEXT NOT NULL'), 'batch journal journal_json must be NOT NULL');
    assert.ok(ddl.includes('ux_st_bme_batch_journal_chat_idempotency'), 'batch journal idempotency unique index must exist');
    assert.ok(ddl.includes('st_bme_vector_dirty_state'), 'DDL must include vector dirty state table');
    assert.ok(ddl.includes('dirty_generation'), 'vector dirty state must include dirty_generation');
    assert.ok(ddl.includes('ix_st_bme_graph_nodes_chat_deleted_at'), 'nodes deleted_at index must exist');
    assert.ok(ddl.includes('ix_st_bme_graph_edges_chat_from_id'), 'edges from_id index must exist');
    assert.ok(ddl.includes('ix_st_bme_graph_tombstones_chat_target_id'), 'tombstones target_id index must exist');
    assert.ok(ddl.includes('ix_st_bme_message_hashes_chat_hash'), 'message hash lookup index must exist');
  }

  // --- activate registers exactly the 6 transactions ---
  console.log('[test:authority-companion-module] testing activate registers all six transactions');
  {
    const registered = {};
    const ctx = {
      moduleId: 'third-party.st-bme',
      ownerExtensionId: 'third-party/st-bme',
      moduleDir: '/fake/.authority',
      logger: { info() {}, warn() {}, error() {} },
      registerTransaction(name, definition) {
        registered[name] = definition;
      },
    };
    await mod.activate(ctx);
    const keys = Object.keys(registered).sort();
    assert.deepStrictEqual(
      keys,
      ['graph.commitDelta', 'graph.getHead', 'graph.loadSnapshot', 'recall.candidates', 'vector.apply', 'vector.manifest'],
      'must register exactly vector.manifest, vector.apply, recall.candidates, graph.getHead, graph.loadSnapshot, and graph.commitDelta',
    );
    assert.strictEqual(typeof registered['vector.manifest'].handler, 'function', 'vector.manifest handler must be a function');
    assert.strictEqual(typeof registered['vector.apply'].handler, 'function', 'vector.apply handler must be a function');
    assert.strictEqual(typeof registered['recall.candidates'].handler, 'function', 'recall.candidates handler must be a function');
    assert.strictEqual(typeof registered['graph.getHead'].handler, 'function', 'graph.getHead handler must be a function');
    assert.strictEqual(typeof registered['graph.loadSnapshot'].handler, 'function', 'graph.loadSnapshot handler must be a function');
    assert.strictEqual(typeof registered['graph.commitDelta'].handler, 'function', 'graph.commitDelta handler must be a function');
  }

  // --- vector.apply calls bulkUpsert and bulkLink with correct payload ---
  console.log('[test:authority-companion-module] testing vector.apply with items and links');
  {
    const { calls, ctx } = createMockTxCtx();
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      collectionId: 'col-1',
      chatId: 'chat-1',
      graphRevision: 5,
      modelScope: 'gpt-4',
      observedDim: 3,
      items: [
        { externalId: 'node-a', vector: [1, 2, 3], payload: { text: 'hello', contentHash: 'abc' } },
        { externalId: 'node-b', vector: [4, 5, 6], payload: { text: 'world', contentHash: 'def' } },
      ],
      links: [
        { fromId: 'node-a', toId: 'node-b', label: 'related', weight: 1.0 },
      ],
    };
    const { calls: calls2, ctx: ctx2 } = createMockTxCtx();
    ctx2.transactionName = 'vector.apply';
    const result = await (await getHandler(mod, 'vector.apply'))(ctx2, input, { idempotencyKey: 'test-key' });
    assert.strictEqual(result.result.ok, true, 'vector.apply should return ok: true');
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.upsert.successCount, 2, 'upsert successCount should be 2');
    assert.strictEqual(result.result.links.successCount, 1, 'links successCount should be 1');
    assert.strictEqual(result.result.skippedLinkCount, 0, 'skippedLinkCount should be 0 when links present');

    // Verify bulkUpsert was called with the right database and dim
    assert.strictEqual(calls2.bulkUpsert.length, 1, 'bulkUpsert should be called once');
    assert.strictEqual(calls2.bulkUpsert[0].database, 'st_bme_vectors');
    assert.strictEqual(calls2.bulkUpsert[0].dim, 3, 'dim should be detected as 3');
    assert.strictEqual(calls2.bulkUpsert[0].items.length, 2);

    // Verify bulkLink was called with the right shape
    assert.strictEqual(calls2.bulkLink.length, 1, 'bulkLink should be called once');
    assert.strictEqual(calls2.bulkLink[0].database, 'st_bme_vectors');
    assert.strictEqual(calls2.bulkLink[0].items.length, 1);
    assert.strictEqual(calls2.bulkLink[0].items[0].src.externalId, 'node-a');
    assert.strictEqual(calls2.bulkLink[0].items[0].dst.externalId, 'node-b');
    assert.strictEqual(calls2.bulkLink[0].items[0].label, 'related');
  }

  // --- vector.apply handles empty links ---
  console.log('[test:authority-companion-module] testing vector.apply with empty links');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      items: [
        { externalId: 'node-a', vector: [1, 2, 3] },
      ],
      links: [],
    };
    const result = await (await getHandler(mod, 'vector.apply'))(ctx, input, { idempotencyKey: 'k' });
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.links.successCount, 0, 'links successCount should be 0 when no links');
    assert.strictEqual(result.result.skippedLinkCount, 0, 'skippedLinkCount should be 0 for empty links array');
    assert.strictEqual(calls.bulkLink.length, 0, 'bulkLink should NOT be called when links array is empty');
  }

  // --- vector.apply rejects mixed dimensions ---
  console.log('[test:authority-companion-module] testing vector.apply rejects mixed dimensions');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      items: [
        { externalId: 'node-a', vector: [1, 2, 3] },
        { externalId: 'node-b', vector: [4, 5] },
      ],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'vector.apply'))(ctx, input, {}),
      /inconsistent vector dimensions/,
      'should reject mixed dimensions',
    );
  }

  // --- vector.apply rejects observedDim mismatch ---
  console.log('[test:authority-companion-module] testing vector.apply rejects observedDim mismatch');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 128,
      items: [
        { externalId: 'node-a', vector: [1, 2, 3] },
      ],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'vector.apply'))(ctx, input, {}),
      /observedDim.*does not match/,
      'should reject observedDim mismatch',
    );
  }

  // --- vector.apply rejects empty items ---
  console.log('[test:authority-companion-module] testing vector.apply rejects empty items');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      items: [],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'vector.apply'))(ctx, input, {}),
      /at least one item/,
      'should reject empty items',
    );
  }

  // --- vector.manifest calls stat and returns expected fields ---
  console.log('[test:authority-companion-module] testing vector.manifest');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.manifest';
    const input = {
      database: 'st_bme_vectors',
      collectionId: 'col-1',
      chatId: 'chat-1',
      modelScope: 'gpt-4',
      graphRevision: 5,
      vectorSpaceId: 'vs-1',
      observedDim: 3,
      includeMappingIntegrity: true,
    };
    const result = await (await getHandler(mod, 'vector.manifest'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.manifest.exists, true);
    assert.strictEqual(result.result.manifest.nodeCount, 42);
    assert.strictEqual(result.result.manifest.edgeCount, 7);
    assert.strictEqual(result.result.manifest.mappingCount, 42);
    assert.strictEqual(result.result.manifest.collectionId, 'col-1');
    assert.strictEqual(result.result.manifest.chatId, 'chat-1');
    assert.strictEqual(result.result.manifest.modelScope, 'gpt-4');
    assert.strictEqual(result.result.manifest.graphRevision, 5);
    assert.strictEqual(result.result.manifest.vectorSpaceId, 'vs-1', 'vector.manifest manifest must echo vectorSpaceId from input');
    assert.strictEqual(result.result.manifest.observedDim, 3, 'vector.manifest manifest must echo observedDim from input');

    // Verify stat was called with the right database and includeMappingIntegrity
    assert.strictEqual(calls.stat.length, 1, 'stat should be called once');
    assert.strictEqual(calls.stat[0].database, 'st_bme_vectors');
    assert.strictEqual(calls.stat[0].includeMappingIntegrity, true);
  }

  // --- vector.manifest echoes empty vectorSpaceId/observedDim when absent ---
  console.log('[test:authority-companion-module] testing vector.manifest echoes empty echo fields when absent');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.manifest';
    const input = {
      database: 'st_bme_vectors',
      collectionId: 'col-1',
      chatId: 'chat-1',
    };
    const result = await (await getHandler(mod, 'vector.manifest'))(ctx, input, {});
    assert.strictEqual(result.result.manifest.vectorSpaceId, '', 'vector.manifest should echo empty vectorSpaceId when input has none');
    assert.strictEqual(result.result.manifest.observedDim, 0, 'vector.manifest should echo 0 observedDim when input has none');
  }

  // --- module.json shape ---
  console.log('[test:authority-companion-module] testing module.json shape');
  {
    const manifest = JSON.parse(fs.readFileSync(MODULE_JSON, 'utf8'));
    assert.strictEqual(manifest.schemaVersion, 1, 'schemaVersion must be 1');
    assert.strictEqual(manifest.id, 'third-party.st-bme', 'module id must be third-party.st-bme');
    assert.strictEqual(manifest.ownerExtensionId, 'third-party/st-bme', 'ownerExtensionId must be third-party/st-bme');
    assert.strictEqual(manifest.entry, './server.cjs', 'entry must be ./server.cjs');
    assert.strictEqual(manifest.protocolVersion, 1, 'protocolVersion must be 1');
    assert.ok(manifest.transactions['vector.manifest'], 'must declare vector.manifest');
    assert.ok(manifest.transactions['vector.apply'], 'must declare vector.apply');
    assert.ok(manifest.transactions['recall.candidates'], 'must declare recall.candidates');
    assert.ok(manifest.transactions['graph.getHead'], 'must declare graph.getHead');
    assert.ok(manifest.transactions['graph.loadSnapshot'], 'must declare graph.loadSnapshot');
    assert.strictEqual(manifest.transactions['vector.apply'].idempotency, 'required', 'vector.apply idempotency must be required');
    assert.strictEqual(manifest.transactions['recall.candidates'].idempotency, 'none', 'recall.candidates idempotency must be none');
    assert.strictEqual(manifest.transactions['recall.candidates'].riskLevel, 'low', 'recall.candidates riskLevel must be low');
    assert.strictEqual(manifest.transactions['recall.candidates'].version, '1', 'recall.candidates version must be "1"');
    assert.strictEqual(manifest.transactions['recall.candidates'].timeoutMs, 120000, 'recall.candidates timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['recall.candidates'].maxRequestBytes, 67108864, 'recall.candidates maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['recall.candidates'].maxResponseBytes, 67108864, 'recall.candidates maxResponseBytes must be 64 MiB');
    // graph.getHead declaration
    assert.strictEqual(manifest.transactions['graph.getHead'].idempotency, 'none', 'graph.getHead idempotency must be none');
    assert.strictEqual(manifest.transactions['graph.getHead'].riskLevel, 'low', 'graph.getHead riskLevel must be low');
    assert.strictEqual(manifest.transactions['graph.getHead'].version, '1', 'graph.getHead version must be "1"');
    assert.strictEqual(manifest.transactions['graph.getHead'].timeoutMs, 120000, 'graph.getHead timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['graph.getHead'].maxRequestBytes, 67108864, 'graph.getHead maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['graph.getHead'].maxResponseBytes, 67108864, 'graph.getHead maxResponseBytes must be 64 MiB');
    assert.ok(
      manifest.transactions['graph.getHead'].requiredResources.some(function (r) { return r.resource === 'sql.private'; }),
      'graph.getHead must require sql.private',
    );
    assert.ok(
      manifest.transactions['graph.getHead'].requiredResources.every(function (r) { return r.target === undefined; }),
      'graph.getHead must not pin a static database target',
    );
    // graph.loadSnapshot declaration
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].idempotency, 'none', 'graph.loadSnapshot idempotency must be none');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].riskLevel, 'low', 'graph.loadSnapshot riskLevel must be low');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].version, '1', 'graph.loadSnapshot version must be "1"');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].timeoutMs, 120000, 'graph.loadSnapshot timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].maxRequestBytes, 67108864, 'graph.loadSnapshot maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['graph.loadSnapshot'].maxResponseBytes, 67108864, 'graph.loadSnapshot maxResponseBytes must be 64 MiB');
    assert.ok(
      manifest.transactions['graph.loadSnapshot'].requiredResources.some(function (r) { return r.resource === 'sql.private'; }),
      'graph.loadSnapshot must require sql.private',
    );
    assert.ok(
      manifest.transactions['graph.loadSnapshot'].requiredResources.every(function (r) { return r.target === undefined; }),
      'graph.loadSnapshot must not pin a static database target',
    );
    // graph.commitDelta declaration
    assert.ok(manifest.transactions['graph.commitDelta'], 'must declare graph.commitDelta');
    assert.strictEqual(manifest.transactions['graph.commitDelta'].idempotency, 'required', 'graph.commitDelta idempotency must be required');
    assert.strictEqual(manifest.transactions['graph.commitDelta'].riskLevel, 'high', 'graph.commitDelta riskLevel must be high');
    assert.strictEqual(manifest.transactions['graph.commitDelta'].version, '1', 'graph.commitDelta version must be "1"');
    assert.strictEqual(manifest.transactions['graph.commitDelta'].timeoutMs, 120000, 'graph.commitDelta timeoutMs must be 120000');
    assert.strictEqual(manifest.transactions['graph.commitDelta'].maxRequestBytes, 67108864, 'graph.commitDelta maxRequestBytes must be 64 MiB');
    assert.strictEqual(manifest.transactions['graph.commitDelta'].maxResponseBytes, 67108864, 'graph.commitDelta maxResponseBytes must be 64 MiB');
    assert.ok(
      manifest.transactions['graph.commitDelta'].requiredResources.some(function (r) { return r.resource === 'sql.private'; }),
      'graph.commitDelta must require sql.private',
    );
    assert.ok(
      manifest.transactions['graph.commitDelta'].requiredResources.every(function (r) { return r.target === undefined; }),
      'graph.commitDelta must not pin a static database target',
    );
    assert.ok(manifest.transactions['vector.manifest'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'vector.manifest must require trivium.private');
    assert.ok(manifest.transactions['vector.apply'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'vector.apply must require trivium.private');
    assert.ok(manifest.transactions['recall.candidates'].requiredResources.some(function (r) { return r.resource === 'trivium.private'; }), 'recall.candidates must require trivium.private');
    assert.ok(manifest.transactions['vector.manifest'].requiredResources.every(function (r) { return r.target === undefined; }), 'vector.manifest must not pin a static database target');
    assert.ok(manifest.transactions['vector.apply'].requiredResources.every(function (r) { return r.target === undefined; }), 'vector.apply must not pin a static database target');
    assert.ok(manifest.transactions['recall.candidates'].requiredResources.every(function (r) { return r.target === undefined; }), 'recall.candidates must not pin a static database target');
    assert.strictEqual(manifest.transactions['vector.apply'].maxRequestBytes, 67108864, 'vector.apply maxRequestBytes should be 64 MiB');
    assert.strictEqual(manifest.transactions['vector.apply'].timeoutMs, 120000, 'vector.apply timeoutMs should be 120000');
  }

  // --- vector.apply uses default database when not specified ---
  console.log('[test:authority-companion-module] testing vector.apply default database');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      items: [{ externalId: 'node-a', vector: [1, 2, 3] }],
    };
    const result = await (await getHandler(mod, 'vector.apply'))(ctx, input, { idempotencyKey: 'k' });
    assert.strictEqual(result.result.database, 'st_bme_vectors', 'should default to st_bme_vectors database');
    assert.strictEqual(calls.bulkUpsert[0].database, 'st_bme_vectors');
  }

  // --- vector.apply echoes metadata in manifest field ---
  console.log('[test:authority-companion-module] testing vector.apply metadata echo');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'vector.apply';
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      collectionId: 'col-1',
      chatId: 'chat-1',
      modelScope: 'gpt-4',
      graphRevision: 7,
      vectorSpaceId: 'vs-1',
      observedDim: 3,
      items: [{ externalId: 'node-a', vector: [1, 2, 3] }],
    };
    const result = await (await getHandler(mod, 'vector.apply'))(ctx, input, { idempotencyKey: 'k' });
    assert.strictEqual(result.result.manifest.namespace, 'test-ns');
    assert.strictEqual(result.result.manifest.observedDim, 3);
    assert.strictEqual(result.result.manifest.collectionId, 'col-1');
    assert.strictEqual(result.result.manifest.chatId, 'chat-1');
    assert.strictEqual(result.result.manifest.modelScope, 'gpt-4');
    assert.strictEqual(result.result.manifest.graphRevision, 7);
    assert.strictEqual(result.result.manifest.vectorSpaceId, 'vs-1');
  }

  // --- recall.candidates handler returns candidates with externalId/internalId/namespace/score only ---
  console.log('[test:authority-companion-module] testing recall.candidates returns sanitized candidates');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      namespace: 'test-ns',
      collectionId: 'col-1',
      chatId: 'chat-1',
      graphRevision: 5,
      modelScope: 'gpt-4',
      vectorSpaceId: 'vs-1',
      observedDim: 3,
      queryTexts: ['hello world'],
      queryVectors: [[1, 2, 3]],
      topK: 10,
      expandDepth: 2,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true, 'recall.candidates should return ok: true');
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.collectionId, 'col-1');
    assert.strictEqual(result.result.chatId, 'chat-1');
    assert.strictEqual(result.result.graphRevision, 5);
    assert.strictEqual(result.result.modelScope, 'gpt-4');
    assert.strictEqual(result.result.vectorSpaceId, 'vs-1');
    assert.strictEqual(result.result.observedDim, 3);
    assert.strictEqual(result.result.queryCount, 1, 'queryCount should be 1');
    assert.ok(Array.isArray(result.result.candidates), 'candidates must be an array');
    assert.ok(result.result.candidates.length > 0, 'candidates must be non-empty');

    // HARD OUTPUT BOUNDARY: no text/payload/prompt/messages fields in result.
    const candidateKeys = new Set();
    for (const candidate of result.result.candidates) {
      for (const key of Object.keys(candidate)) candidateKeys.add(key);
    }
    assert.ok(!candidateKeys.has('text'), 'candidates must NOT include text');
    assert.ok(!candidateKeys.has('payload'), 'candidates must NOT include payload');
    assert.ok(!candidateKeys.has('prompt'), 'candidates must NOT include prompt');
    assert.ok(!candidateKeys.has('messages'), 'candidates must NOT include messages');
    assert.ok(!candidateKeys.has('content'), 'candidates must NOT include content');

    // Each candidate has only the allowed fields.
    const allowedFields = new Set(['externalId', 'internalId', 'namespace', 'score', 'source']);
    for (const candidate of result.result.candidates) {
      for (const key of Object.keys(candidate)) {
        assert.ok(allowedFields.has(key), `unexpected candidate field: ${key}`);
      }
      assert.ok(candidate.externalId, 'candidate must have externalId');
      assert.strictEqual(typeof candidate.score, 'number');
      assert.ok(candidate.source === 'search' || candidate.source === 'expand', `unexpected source: ${candidate.source}`);
    }

    // searchHybrid was called once per query.
    assert.strictEqual(calls.searchHybrid.length, 1, 'searchHybrid should be called once');
    // resolveMany + neighbors called because expandDepth > 0.
    assert.strictEqual(calls.resolveMany.length, 1, 'resolveMany should be called once when expandDepth > 0');
    assert.ok(calls.neighbors.length > 0, 'neighbors should be called when expandDepth > 0');

    // No payload content anywhere in the response.
    const responseJson = JSON.stringify(result.result);
    assert.ok(!responseJson.includes('secret'), 'response must not include search hit payload text');
    assert.ok(!responseJson.includes('hidden'), 'response must not include search hit payload text');
    assert.ok(!responseJson.includes('should-strip'), 'response must not include search hit payload content');
  }

  // --- recall.candidates rejects empty queryTexts/queryVectors ---
  console.log('[test:authority-companion-module] testing recall.candidates rejects empty queries');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 3,
      queryTexts: [],
      queryVectors: [],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'recall.candidates'))(ctx, input, {}),
      /requires at least one of queryTexts or queryVectors/,
      'should reject empty queryTexts and queryVectors',
    );
  }

  // --- recall.candidates rejects observedDim mismatch ---
  console.log('[test:authority-companion-module] testing recall.candidates rejects observedDim mismatch');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 128,
      queryTexts: ['hello'],
      queryVectors: [[1, 2, 3]],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'recall.candidates'))(ctx, input, {}),
      /does not match observedDim/,
      'should reject observedDim mismatch',
    );
  }

  // --- recall.candidates rejects non-array queryVector ---
  console.log('[test:authority-companion-module] testing recall.candidates rejects malformed queryVector');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      queryVectors: [[1, 2, 3], 'not-an-array'],
    };
    await assert.rejects(
      async () => await (await getHandler(mod, 'recall.candidates'))(ctx, input, {}),
      /must be a non-empty array/,
      'should reject non-array queryVector',
    );
  }

  // --- recall.candidates returns empty candidates when searchHybrid returns no hits ---
  console.log('[test:authority-companion-module] testing recall.candidates empty search result');
  {
    const { calls, ctx } = createMockTxCtx();
    // Override searchHybrid to return empty array.
    ctx.trivium.searchHybrid = async () => [];
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 3,
      queryTexts: ['nothing matches'],
      queryVectors: [[1, 2, 3]],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true, 'empty result is NOT an error');
    assert.deepStrictEqual(result.result.candidates, [], 'candidates should be empty array');
    assert.strictEqual(result.result.queryCount, 1);
    // resolveMany should NOT be called when there are no hits.
    assert.strictEqual(calls.resolveMany.length, 0);
    assert.strictEqual(calls.neighbors.length, 0);
  }

  // --- recall.candidates echoes all metadata fields ---
  console.log('[test:authority-companion-module] testing recall.candidates metadata echo');
  {
    const { ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      collectionId: 'col-echo',
      chatId: 'chat-echo',
      graphRevision: 9,
      modelScope: 'echo-model',
      vectorSpaceId: 'vs-echo',
      observedDim: 3,
      queryTexts: ['echo'],
      queryVectors: [[1, 2, 3]],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.database, 'st_bme_vectors');
    assert.strictEqual(result.result.collectionId, 'col-echo');
    assert.strictEqual(result.result.chatId, 'chat-echo');
    assert.strictEqual(result.result.graphRevision, 9);
    assert.strictEqual(result.result.modelScope, 'echo-model');
    assert.strictEqual(result.result.vectorSpaceId, 'vs-echo');
    assert.strictEqual(result.result.observedDim, 3);
    assert.ok(result.result.searchedAt, 'searchedAt should be set');
  }

  // --- recall.candidates works with queryTexts only (no queryVectors) ---
  console.log('[test:authority-companion-module] testing recall.candidates with queryTexts only');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      queryTexts: ['text-only-query'],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.queryCount, 1);
    assert.strictEqual(calls.searchHybrid.length, 1);
    assert.strictEqual(calls.searchHybrid[0].queryText, 'text-only-query');
    // vector should be undefined since we only passed queryTexts.
    assert.strictEqual(calls.searchHybrid[0].vector, undefined);
  }

  // --- recall.candidates works with queryVectors only (no queryTexts) ---
  console.log('[test:authority-companion-module] testing recall.candidates with queryVectors only');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      observedDim: 3,
      queryVectors: [[1, 2, 3]],
      topK: 5,
      expandDepth: 0,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.queryCount, 1);
    assert.strictEqual(calls.searchHybrid.length, 1);
    assert.deepStrictEqual(calls.searchHybrid[0].vector, [1, 2, 3]);
  }

  // --- recall.candidates clamps topK and expandDepth to server caps ---
  console.log('[test:authority-companion-module] testing recall.candidates clamps topK/expandDepth');
  {
    const { calls, ctx } = createMockTxCtx();
    ctx.transactionName = 'recall.candidates';
    const input = {
      database: 'st_bme_vectors',
      queryTexts: ['clamp-test'],
      topK: 99999,
      expandDepth: 99999,
    };
    const result = await (await getHandler(mod, 'recall.candidates'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.searchHybrid[0].topK, mod.MAX_SEARCH_TOP_K, 'topK should be clamped to MAX_SEARCH_TOP_K');
    // neighbors depth should be clamped to MAX_SEARCH_EXPAND_DEPTH.
    assert.strictEqual(calls.neighbors[0].depth, mod.MAX_SEARCH_EXPAND_DEPTH, 'expandDepth should be clamped to MAX_SEARCH_EXPAND_DEPTH');
  }

  // ===========================================================================
  // Phase D: graph.getHead / graph.loadSnapshot
  // ===========================================================================

  console.log('[test:authority-companion-module] testing graph.getHead returns revision + headHash + meta when chat exists');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: {
        revision: 5,
        lastModified: 1700000000000,
        syncDirty: false,
        syncDirtyReason: null,
        lastProcessedFloor: 3,
        extractionCount: 12,
        schemaVersion: 1,
        nodeCount: 2,
        edgeCount: 1,
        tombstoneCount: 0,
      },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-1' }],
    });
    ctx.transactionName = 'graph.getHead';
    const result = await (await getHandler(mod, 'graph.getHead'))(ctx, { chatId: 'chat-1' }, {});
    assert.strictEqual(result.result.ok, true, 'graph.getHead should return ok: true');
    assert.strictEqual(result.result.chatId, 'chat-1');
    assert.strictEqual(result.result.revision, 5, 'revision should be 5');
    assert.strictEqual(result.result.exists, true, 'exists should be true when meta rows present');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must be a string when chat exists');
    assert.ok(result.result.headHash.length > 0, 'headHash must be non-empty');
    assert.strictEqual(result.result.lastModified, 1700000000000, 'lastModified should be echoed from meta');
    assert.strictEqual(result.result.syncDirty, false, 'syncDirty should be false');
    assert.ok(result.result.meta, 'meta must be present');
    assert.strictEqual(result.result.meta.revision, 5);
    assert.strictEqual(result.result.meta.nodeCount, 2);
    assert.strictEqual(result.result.meta.edgeCount, 1);
    assert.strictEqual(result.result.meta.tombstoneCount, 0);
    assert.strictEqual(result.result.meta.lastProcessedFloor, 3);
    assert.strictEqual(result.result.meta.extractionCount, 12);
    assert.strictEqual(result.result.schemaVersion, 2);
    assert.strictEqual(result.result.meta.schemaVersion, 1);
    assert.strictEqual(result.result.meta.syncDirty, false);
    assert.strictEqual(result.result.meta.syncDirtyReason, null);

    // ensureGraphSchema called first — exec called with idempotent CREATE TABLE statements.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.ok(createTableCalls.length >= 8, 'must run graph + authority schema CREATE TABLE statements before reading');
    assert.ok(createTableCalls.every((c) => c.statement.includes('IF NOT EXISTS')), 'CREATE TABLE must be idempotent (IF NOT EXISTS)');

    // Database defaults to BME's graph default ('default') when not specified.
    assert.strictEqual(calls.exec[0].database, 'default', 'exec database must default to BME graph default');
    assert.strictEqual(calls.query[0].database, 'default', 'query database must default to BME graph default');

    // Only ctx.sql.query and ctx.sql.exec are used (no other ctx methods).
    assert.ok(calls.query.length > 0, 'must use ctx.sql.query for reads');
    assert.ok(calls.exec.length > 0, 'must use ctx.sql.exec for schema ensure');
  }

  console.log('[test:authority-companion-module] testing graph.getHead returns exists:false for new chat');
  {
    const { calls, ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.getHead';
    const result = await (await getHandler(mod, 'graph.getHead'))(ctx, { chatId: 'new-chat' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.chatId, 'new-chat');
    assert.strictEqual(result.result.revision, 0, 'revision should be 0 for new chat');
    assert.strictEqual(result.result.exists, false, 'exists should be false when no meta rows');
    assert.strictEqual(result.result.headHash, null, 'headHash must be null for new chat');
    assert.strictEqual(result.result.schemaVersion, 2);

    // Schema ensure still runs even for new chats.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.ok(createTableCalls.length >= 8, 'ensureGraphSchema must run before the meta read');
  }

  console.log('[test:authority-companion-module] testing graph.getHead respects explicit database');
  {
    const { calls, ctx } = createMockSqlTxCtx({ meta: { revision: 1 }, nodes: [], edges: [] });
    ctx.transactionName = 'graph.getHead';
    const result = await (await getHandler(mod, 'graph.getHead'))(ctx, { chatId: 'chat-1', database: 'custom-db' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.exec[0].database, 'custom-db', 'exec must use explicit database');
    assert.strictEqual(calls.query[0].database, 'custom-db', 'query must use explicit database');
  }

  console.log('[test:authority-companion-module] testing graph.getHead requires chatId');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.getHead';
    await assert.rejects(
      async () => await (await getHandler(mod, 'graph.getHead'))(ctx, {}, {}),
      /requires chatId/,
      'should reject missing chatId',
    );
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns full snapshot when chat exists');
  {
    const testNodes = [{ id: 'node-a', type: 'concept' }, { id: 'node-b', type: 'fact' }];
    const testEdges = [{ id: 'edge-1', from: 'node-a', to: 'node-b', relation: 'related' }];
    const testTombstones = [{ id: 'tomb-1', kind: 'node', targetId: 'node-c' }];
    const testMeta = {
      revision: 7,
      lastModified: 1700000000001,
      syncDirty: true,
      syncDirtyReason: 'test',
      lastProcessedFloor: 4,
      extractionCount: 20,
      schemaVersion: 1,
      nodeCount: 2,
      edgeCount: 1,
      tombstoneCount: 1,
    };
    const { calls, ctx } = createMockSqlTxCtx({
      meta: testMeta,
      nodes: testNodes,
      edges: testEdges,
      tombstones: testTombstones,
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-snap' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.chatId, 'chat-snap');
    assert.strictEqual(result.result.revision, 7);
    assert.strictEqual(result.result.schemaVersion, 2, 'schemaVersion should be 2');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must be a string');
    assert.ok(result.result.headHash.length > 0);

    assert.ok(Array.isArray(result.result.nodes), 'nodes must be an array');
    assert.strictEqual(result.result.nodes.length, 2, 'nodes should have 2 entries');
    assert.strictEqual(result.result.nodes[0].id, 'node-a');
    assert.strictEqual(result.result.nodes[1].id, 'node-b');
    assert.ok(Array.isArray(result.result.edges), 'edges must be an array');
    assert.strictEqual(result.result.edges.length, 1);
    assert.strictEqual(result.result.edges[0].id, 'edge-1');
    assert.ok(Array.isArray(result.result.tombstones), 'tombstones must be an array');
    assert.strictEqual(result.result.tombstones.length, 1);
    assert.strictEqual(result.result.tombstones[0].id, 'tomb-1');

    assert.ok(result.result.meta, 'meta must be present');
    assert.strictEqual(result.result.meta.revision, 7);
    assert.strictEqual(result.result.meta.syncDirty, true);
    assert.strictEqual(result.result.meta.syncDirtyReason, 'test');

    assert.ok(result.result.state, 'state must be present');
    assert.strictEqual(result.result.state.lastProcessedFloor, 4);
    assert.strictEqual(result.result.state.extractionCount, 20);

    // ensureGraphSchema called first.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.ok(createTableCalls.length >= 8, 'must run graph + authority schema CREATE TABLE statements before reading');

    // Only ctx.sql.query and ctx.sql.exec are used.
    assert.ok(calls.query.length > 0, 'must use ctx.sql.query for reads');
    assert.ok(calls.exec.length > 0, 'must use ctx.sql.exec for schema ensure');
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns unchanged when minRevision matches');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 7 },
      nodes: [{ id: 'node-a' }],
      edges: [],
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-unchanged', minRevision: 7 }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.unchanged, true, 'unchanged must be true when minRevision matches current revision');
    assert.strictEqual(result.result.revision, 7);
    assert.strictEqual(result.result.chatId, 'chat-unchanged');
    assert.strictEqual(result.result.schemaVersion, 2);
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must still be present');

    // Should NOT have queried payload tables — short-circuit before the payload reads.
    const payloadQueries = calls.query.filter((c) => c.statement.includes('payload_json'));
    assert.strictEqual(payloadQueries.length, 0, 'should not query payload tables when unchanged');
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns full snapshot when minRevision does not match');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 7 },
      nodes: [{ id: 'node-a' }],
      edges: [{ id: 'edge-1' }],
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-changed', minRevision: 5 }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.unchanged, undefined, 'unchanged must NOT be set when minRevision differs');
    assert.strictEqual(result.result.revision, 7);
    assert.ok(Array.isArray(result.result.nodes), 'nodes must be returned when revision differs');
    assert.strictEqual(result.result.nodes.length, 1);
    assert.strictEqual(result.result.nodes[0].id, 'node-a');
    assert.ok(Array.isArray(result.result.edges));
    assert.strictEqual(result.result.edges.length, 1);
    assert.strictEqual(result.result.edges[0].id, 'edge-1');

    // Payload tables were queried because the revision differed.
    const payloadQueries = calls.query.filter((c) => c.statement.includes('payload_json'));
    assert.ok(payloadQueries.length >= 3, 'should query nodes, edges, and tombstones payload tables');
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot returns empty snapshot for new chat');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [], tombstones: [] });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'new-chat-snap' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.chatId, 'new-chat-snap');
    assert.strictEqual(result.result.revision, 0);
    assert.strictEqual(result.result.headHash, null);
    assert.strictEqual(result.result.schemaVersion, 2);
    assert.deepStrictEqual(result.result.nodes, []);
    assert.deepStrictEqual(result.result.edges, []);
    assert.deepStrictEqual(result.result.tombstones, []);
    assert.deepStrictEqual(result.result.state, { lastProcessedFloor: 0, extractionCount: 0 });
  }

  console.log('[test:authority-companion-module] testing graph.loadSnapshot respects explicit database');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 1 },
      nodes: [{ id: 'n1' }],
      edges: [],
    });
    ctx.transactionName = 'graph.loadSnapshot';
    const result = await (await getHandler(mod, 'graph.loadSnapshot'))(ctx, { chatId: 'chat-1', database: 'graph-db' }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.exec[0].database, 'graph-db', 'exec must use explicit database');
    assert.strictEqual(calls.query[0].database, 'graph-db', 'query must use explicit database');
  }

  console.log('[test:authority-companion-module] testing graph headHash divergence detection');
  {
    // Same revision, different node sets -> different headHash.
    const { ctx: ctxA } = createMockSqlTxCtx({
      meta: { revision: 5 },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-1' }],
    });
    ctxA.transactionName = 'graph.getHead';
    const resultA = await (await getHandler(mod, 'graph.getHead'))(ctxA, { chatId: 'chat-A' }, {});

    const { ctx: ctxB } = createMockSqlTxCtx({
      meta: { revision: 5 },
      nodes: [{ id: 'node-a' }, { id: 'node-c' }],
      edges: [{ id: 'edge-1' }],
    });
    ctxB.transactionName = 'graph.getHead';
    const resultB = await (await getHandler(mod, 'graph.getHead'))(ctxB, { chatId: 'chat-B' }, {});

    assert.strictEqual(resultA.result.revision, 5);
    assert.strictEqual(resultB.result.revision, 5);
    assert.strictEqual(resultA.result.exists, true);
    assert.strictEqual(resultB.result.exists, true);
    assert.ok(typeof resultA.result.headHash === 'string');
    assert.ok(typeof resultB.result.headHash === 'string');
    assert.notStrictEqual(
      resultA.result.headHash,
      resultB.result.headHash,
      'same revision with different node ids must produce different headHashes',
    );

    // Same revision + same node ids + same edge ids -> same headHash.
    const { ctx: ctxC } = createMockSqlTxCtx({
      meta: { revision: 5 },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }],
      edges: [{ id: 'edge-1' }],
    });
    ctxC.transactionName = 'graph.getHead';
    const resultC = await (await getHandler(mod, 'graph.getHead'))(ctxC, { chatId: 'chat-C' }, {});
    assert.strictEqual(
      resultA.result.headHash,
      resultC.result.headHash,
      'same revision + same node/edge ids must produce the same headHash',
    );
  }

  // ===========================================================================
  // Phase E: graph.commitDelta
  // ===========================================================================

  console.log('[test:authority-companion-module] testing graph.commitDelta success: lock + idempotency + CAS + transaction');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 5, nodeCount: 2, edgeCount: 1, tombstoneCount: 0 },
      nodes: [{ id: 'node-a' }, { id: 'node-b' }, { id: 'node-c' }],
      edges: [{ id: 'edge-1' }, { id: 'edge-2' }],
    });
    ctx.transactionName = 'graph.commitDelta';
    const input = {
      chatId: 'chat-commit-1',
      collectionId: 'col-1',
      baseRevision: 5,
      idempotencyKey: 'test-commit-key-1',
      delta: {
        upsertNodes: [
          { id: 'node-c', type: 'concept', sourceFloor: 3, archived: false, updatedAt: 1700000000000, payload: { text: 'hello' } },
        ],
        upsertEdges: [
          { id: 'edge-2', fromId: 'node-a', toId: 'node-c', relation: 'related', sourceFloor: 3, updatedAt: 1700000000000 },
        ],
        tombstones: [
          { id: 'tomb-1', kind: 'node', targetId: 'node-x', deletedAt: 1700000000000, sourceDeviceId: 'dev-1' },
        ],
        deleteNodeIds: ['node-z'],
        deleteEdgeIds: ['edge-old'],
        runtimeMetaPatch: {
          lastProcessedFloor: 10,
          extractionCount: 42,
          processedMessageHashes: ['hash-1', 'hash-2'],
        },
        countDelta: { nodeCount: 3, edgeCount: 2, tombstoneCount: 1 },
      },
      options: { markSyncDirty: true, vectorDirtyHint: true, reason: 'extraction-batch' },
    };
    const result = await (await getHandler(mod, 'graph.commitDelta'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true, 'commitDelta should return ok: true');
    assert.strictEqual(result.result.accepted, true, 'commitDelta should return accepted: true');
    assert.strictEqual(result.result.revision, 6, 'revision should be baseRevision+1');
    assert.strictEqual(result.result.chatId, 'chat-commit-1');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must be a string');
    assert.ok(result.result.headHash.length > 0, 'headHash must be non-empty');
    assert.ok(result.result.committedAt, 'committedAt must be set');
    assert.strictEqual(result.result.vectorDirtyHint, true, 'vectorDirtyHint must echo input');
    assert.strictEqual(result.result.statementCount, 1 + 1 + 1 + 1 + 1 + 1, '5 data stmts + 1 meta stmt = 6');
    assert.strictEqual(result.result.applied.upsertedNodes, 1);
    assert.strictEqual(result.result.applied.upsertedEdges, 1);
    assert.strictEqual(result.result.applied.upsertedTombstones, 1);
    assert.strictEqual(result.result.applied.deletedNodeIds, 1);
    assert.strictEqual(result.result.applied.deletedEdgeIds, 1);

    // Lock was acquired for the chat scope.
    assert.strictEqual(calls.lock.length, 1, 'withLock should be called once');
    assert.strictEqual(calls.lock[0].scope, 'chat:chat-commit-1', 'lock scope must be chat:<chatId>');
    assert.ok(calls.lock[0].opts.timeoutMs > 0, 'lock must have a timeout');

    // Idempotency.run was called with the input key + a fingerprint.
    assert.strictEqual(calls.idempotencyRun.length, 1, 'idempotency.run should be called once');
    assert.strictEqual(calls.idempotencyRun[0].key, 'test-commit-key-1', 'idempotency key must match input');

    // Schema ensure ran first before any query.
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.ok(createTableCalls.length >= 8, 'ensureGraphSchema must run before any queries');
    assert.ok(calls.query.length > 0, 'must use ctx.sql.query for CAS read + post-commit headHash');
    assert.ok(calls.exec[0] === createTableCalls[0] || calls.exec[0].statement.includes('CREATE TABLE'), 'first exec must be CREATE TABLE');

    // Transaction was called once with the built statements.
    assert.strictEqual(calls.transaction.length, 1, 'transaction should be called once');
    const stmts = calls.transaction[0].statements;
    assert.ok(Array.isArray(stmts), 'statements must be an array');
    assert.ok(stmts.length <= mod.MAX_SQL_BATCH_STATEMENTS, 'must stay under MAX_SQL_BATCH_STATEMENTS');

    // Verify statement ordering: DELETE edges, DELETE nodes, INSERT nodes,
    // INSERT edges, INSERT tombstones, meta upsert.
    assert.ok(stmts[0].statement.includes('DELETE FROM st_bme_graph_edges'), 'first stmt must be DELETE edges');
    assert.ok(stmts[1].statement.includes('DELETE FROM st_bme_graph_nodes'), 'second stmt must be DELETE nodes');
    assert.ok(stmts[2].statement.includes('INSERT INTO st_bme_graph_nodes'), 'third stmt must be INSERT nodes');
    assert.ok(stmts[3].statement.includes('INSERT INTO st_bme_graph_edges'), 'fourth stmt must be INSERT edges');
    assert.ok(stmts[4].statement.includes('INSERT INTO st_bme_graph_tombstones'), 'fifth stmt must be INSERT tombstones');
    const metaStmts = stmts.filter((s) => s.statement.includes('INSERT INTO st_bme_graph_meta'));
    assert.strictEqual(metaStmts.length, 1, 'exactly one meta upsert statement');
    const metaStmt = metaStmts[0];

    // Meta upsert must include runtimeMetaPatch keys + reserved keys.
    // The statement uses positional ? params in row order: chat_id, key, value_json, updated_at.
    // value_json is JSON-stringified (that's what gets stored in the column),
    // so we parse it back to compare against the original values.
    const metaParams = metaStmt.params;
    const metaPairs = [];
    for (let i = 0; i < metaParams.length; i += 4) {
      metaPairs.push({ key: metaParams[i + 1], value: JSON.parse(metaParams[i + 2]) });
    }
    const metaKeyMap = {};
    for (const pair of metaPairs) metaKeyMap[pair.key] = pair.value;
    assert.strictEqual(metaKeyMap['lastProcessedFloor'], 10, 'lastProcessedFloor must be in meta upsert');
    assert.strictEqual(metaKeyMap['extractionCount'], 42, 'extractionCount must be in meta upsert');
    assert.deepStrictEqual(metaKeyMap['processedMessageHashes'], ['hash-1', 'hash-2'], 'processedMessageHashes must be in meta upsert');
    assert.strictEqual(metaKeyMap['revision'], 6, 'revision must be bumped to nextRevision');
    assert.strictEqual(metaKeyMap['syncDirty'], true, 'syncDirty must be true (markSyncDirty default true)');
    assert.strictEqual(metaKeyMap['syncDirtyReason'], 'extraction-batch', 'syncDirtyReason must echo reason');
    assert.strictEqual(metaKeyMap['lastMutationReason'], 'extraction-batch', 'lastMutationReason must echo reason');
    assert.strictEqual(metaKeyMap['nodeCount'], 3, 'nodeCount must come from countDelta');
    assert.strictEqual(metaKeyMap['edgeCount'], 2, 'edgeCount must come from countDelta');
    assert.strictEqual(metaKeyMap['tombstoneCount'], 1, 'tombstoneCount must come from countDelta');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta CAS conflict throws transaction_conflict');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 7, nodeCount: 2, edgeCount: 1 },
      nodes: [{ id: 'node-a' }],
      edges: [],
    });
    ctx.transactionName = 'graph.commitDelta';
    const input = {
      chatId: 'chat-conflict',
      baseRevision: 5, // server has 7, caller expects 5 → mismatch
      idempotencyKey: 'test-cas-conflict',
      delta: { upsertNodes: [{ id: 'node-b' }] },
    };
    let caught = null;
    try {
      await (await getHandler(mod, 'graph.commitDelta'))(ctx, input, {});
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'CAS conflict must throw');
    assert.strictEqual(caught.status, 409, 'CAS conflict must be 409');
    assert.strictEqual(caught.code, 'transaction_conflict', 'error code must be transaction_conflict');
    assert.ok(caught.details, 'error must have details');
    assert.strictEqual(caught.details.serverRevision, 7, 'details must include serverRevision');
    assert.strictEqual(caught.details.baseRevision, 5, 'details must include baseRevision');
    // Transaction must NOT have been called (CAS failed before build/commit).
    assert.strictEqual(calls.transaction.length, 0, 'transaction must not run on CAS conflict');
    // Idempotency.run WAS called (CAS happens inside idempotency).
    assert.strictEqual(calls.idempotencyRun.length, 1, 'idempotency.run must be called before CAS check');
    // Schema ensure ran (before the CAS read).
    const createTableCalls = calls.exec.filter((c) => c.statement.includes('CREATE TABLE'));
    assert.ok(createTableCalls.length >= 8, 'ensureGraphSchema must run before CAS read');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta idempotency replay returns cached result');
  {
    const sharedCache = new Map();
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 3, nodeCount: 0, edgeCount: 0 },
      nodes: [{ id: 'node-a' }],
      edges: [],
      idempotencyCache: sharedCache,
    });
    ctx.transactionName = 'graph.commitDelta';
    const input = {
      chatId: 'chat-replay',
      baseRevision: 3,
      idempotencyKey: 'replay-key',
      delta: { upsertNodes: [{ id: 'node-a' }] },
    };
    const handler = await getHandler(mod, 'graph.commitDelta');
    const result1 = await handler(ctx, input, {});
    assert.strictEqual(result1.result.revision, 4, 'first call must bump revision to 4');
    assert.strictEqual(result1.result.accepted, true);
    // First call: transaction executed once.
    assert.strictEqual(calls.transaction.length, 1, 'first call must execute transaction');

    // Second call with same key + same delta → same fingerprint → cached replay.
    const result2 = await handler(ctx, input, {});
    assert.strictEqual(result2.result.revision, 4, 'replay must return same revision');
    assert.strictEqual(result2.result.accepted, true);
    assert.strictEqual(result2.result.headHash, result1.result.headHash, 'replay must return same headHash');
    // Transaction must NOT have been called again.
    assert.strictEqual(calls.transaction.length, 1, 'replay must not re-execute transaction');
    // idempotency.run was called twice (both calls go through it).
    assert.strictEqual(calls.idempotencyRun.length, 2, 'idempotency.run called on both invocations');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta idempotency fingerprint mismatch throws idempotency_conflict');
  {
    const sharedCache = new Map();
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 3, nodeCount: 0, edgeCount: 0 },
      nodes: [{ id: 'node-a' }],
      edges: [],
      idempotencyCache: sharedCache,
    });
    ctx.transactionName = 'graph.commitDelta';
    const handler = await getHandler(mod, 'graph.commitDelta');
    // First call with delta A.
    const input1 = {
      chatId: 'chat-mismatch',
      baseRevision: 3,
      idempotencyKey: 'mismatch-key',
      delta: { upsertNodes: [{ id: 'node-a' }] },
    };
    await handler(ctx, input1, {});
    assert.strictEqual(calls.transaction.length, 1, 'first call must execute transaction');

    // Second call with SAME key but DIFFERENT delta → different fingerprint → conflict.
    const input2 = {
      chatId: 'chat-mismatch',
      baseRevision: 4, // bump baseRevision to match new server state
      idempotencyKey: 'mismatch-key', // SAME key
      delta: { upsertNodes: [{ id: 'node-b' }] }, // DIFFERENT delta
    };
    let caught = null;
    try {
      await handler(ctx, input2, {});
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'fingerprint mismatch must throw');
    assert.strictEqual(caught.status, 409, 'fingerprint mismatch must be 409');
    assert.strictEqual(caught.code, 'idempotency_conflict', 'error code must be idempotency_conflict');
    // Transaction still only ran once (the second call did not execute fn).
    assert.strictEqual(calls.transaction.length, 1, 'fn must not execute on fingerprint mismatch');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta lock serializes concurrent writers for same chat');
  {
    // Two concurrent calls to the same chatId. The first call's transaction
    // is artificially delayed so we can verify the second call doesn't
    // overlap (it starts only after the first completes).
    const sharedCache = new Map();
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 0, nodeCount: 0, edgeCount: 0 },
      nodes: [],
      edges: [],
      idempotencyCache: sharedCache,
      transactionDelayMs: 50,
    });
    ctx.transactionName = 'graph.commitDelta';
    const handler = await getHandler(mod, 'graph.commitDelta');

    // Track transaction execution windows.
    const windows = [];
    const origTransaction = ctx.sql.transaction;
    ctx.sql.transaction = async (database, statements) => {
      const start = Date.now();
      const result = await origTransaction(database, statements);
      const end = Date.now();
      windows.push({ start, end });
      return result;
    };

    // First call: baseRevision=0 (matches server), bumps to 1.
    // Second call: baseRevision=1 (matches post-first-call server state), bumps to 2.
    // But the mock ctx.sql.query always returns the ORIGINAL meta (revision=0),
    // so the second call would CAS-fail if it ran concurrently against the
    // stale meta. To test lock serialization (not CAS), we use different
    // chatIds... no wait, we want SAME chatId. Let me instead verify
    // serialization by checking the lock call order and transaction windows.
    //
    // Actually, the cleanest serialization test: both calls use baseRevision=0,
    // both target the same chat. The first succeeds (CAS passes, revision→1).
    // The second CAS-fails because the mock still returns revision=0... no,
    // the mock returns revision=0, so CAS passes again (baseRevision=0 matches
    // 0). Both would "succeed" against the mock. That's fine for testing
    // lock serialization — we just verify the transaction windows don't
    // overlap.
    const input1 = {
      chatId: 'chat-serial',
      baseRevision: 0,
      idempotencyKey: 'serial-key-1',
      delta: { upsertNodes: [{ id: 'node-1' }] },
    };
    const input2 = {
      chatId: 'chat-serial',
      baseRevision: 0,
      idempotencyKey: 'serial-key-2', // different key so idempotency doesn't short-circuit
      delta: { upsertNodes: [{ id: 'node-2' }] },
    };

    // Fire both concurrently.
    const [r1, r2] = await Promise.all([
      handler(ctx, input1, {}),
      handler(ctx, input2, {}),
    ]);

    assert.strictEqual(r1.result.ok, true);
    assert.strictEqual(r2.result.ok, true);
    // Both transactions ran.
    assert.strictEqual(calls.transaction.length, 2, 'both calls must execute their transactions');
    // Lock acquired twice for the same scope.
    assert.strictEqual(calls.lock.length, 2, 'withLock called for both');
    assert.strictEqual(calls.lock[0].scope, 'chat:chat-serial');
    assert.strictEqual(calls.lock[1].scope, 'chat:chat-serial');
    // The two transaction windows must NOT overlap: first.end <= second.start.
    assert.strictEqual(windows.length, 2, 'two transaction windows recorded');
    const sorted = windows.slice().sort((a, b) => a.start - b.start);
    assert.ok(
      sorted[0].end >= sorted[1].start - 5, // allow 5ms scheduling slack
      'second transaction must start at/after first transaction ends (lock serializes)',
    );
    // More precisely: the second window's start must be >= the first window's end
    // (the lock prevents overlap). With the 50ms delay, the gap should be clear.
    assert.ok(
      sorted[1].start >= sorted[0].end - 5,
      'second transaction window must not overlap first (lock serializes writers)',
    );
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta runtimeMetaPatch co-committed in same transaction');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 2, nodeCount: 1, edgeCount: 0, lastProcessedFloor: 5, extractionCount: 10 },
      nodes: [{ id: 'node-a' }],
      edges: [],
    });
    ctx.transactionName = 'graph.commitDelta';
    const input = {
      chatId: 'chat-meta',
      baseRevision: 2,
      idempotencyKey: 'meta-key',
      delta: {
        runtimeMetaPatch: {
          lastProcessedFloor: 15,
          extractionCount: 25,
          processedMessageHashes: ['h1', 'h2', 'h3'],
          customMetaKey: 'custom-value',
        },
      },
    };
    const result = await (await getHandler(mod, 'graph.commitDelta'))(ctx, input, {});
    assert.strictEqual(result.result.revision, 3, 'revision must bump even for meta-only delta');
    assert.strictEqual(result.result.accepted, true);

    // Exactly one transaction call.
    assert.strictEqual(calls.transaction.length, 1);
    const stmts = calls.transaction[0].statements;
    // The meta upsert is the only statement for a meta-only delta.
    assert.strictEqual(stmts.length, 1, 'meta-only delta must produce exactly 1 statement');
    assert.ok(stmts[0].statement.includes('INSERT INTO st_bme_graph_meta'), 'must be meta upsert');
    assert.ok(
      stmts[0].statement.includes('ON CONFLICT(chat_id, meta_key) DO UPDATE SET'),
      'must use ON CONFLICT DO UPDATE for upsert',
    );

    // Parse the meta pairs from positional params (value_json is JSON-stringified).
    const metaParams = stmts[0].params;
    const metaPairs = [];
    for (let i = 0; i < metaParams.length; i += 4) {
      metaPairs.push({ key: metaParams[i + 1], value: JSON.parse(metaParams[i + 2]) });
    }
    const metaKeyMap = {};
    for (const pair of metaPairs) metaKeyMap[pair.key] = pair.value;
    assert.strictEqual(metaKeyMap['lastProcessedFloor'], 15, 'lastProcessedFloor co-committed');
    assert.strictEqual(metaKeyMap['extractionCount'], 25, 'extractionCount co-committed');
    assert.deepStrictEqual(metaKeyMap['processedMessageHashes'], ['h1', 'h2', 'h3'], 'processedMessageHashes co-committed');
    assert.strictEqual(metaKeyMap['customMetaKey'], 'custom-value', 'custom meta key co-committed');
    assert.strictEqual(metaKeyMap['revision'], 3, 'revision co-committed in same statement');
    assert.strictEqual(metaKeyMap['syncDirty'], true, 'syncDirty co-committed (default true)');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta empty delta still commits (bumps revision)');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 5, nodeCount: 0, edgeCount: 0, tombstoneCount: 0 },
      nodes: [],
      edges: [],
    });
    ctx.transactionName = 'graph.commitDelta';
    const input = {
      chatId: 'chat-empty',
      baseRevision: 5,
      idempotencyKey: 'empty-key',
      delta: {}, // completely empty
    };
    const result = await (await getHandler(mod, 'graph.commitDelta'))(ctx, input, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(result.result.accepted, true);
    assert.strictEqual(result.result.revision, 6, 'empty delta must still bump revision');
    assert.strictEqual(typeof result.result.headHash, 'string', 'headHash must be computed');
    // Transaction ran with at least the meta upsert statement.
    assert.strictEqual(calls.transaction.length, 1);
    const stmts = calls.transaction[0].statements;
    assert.ok(stmts.length >= 1, 'empty delta must still produce at least the meta upsert');
    const metaStmts = stmts.filter((s) => s.statement.includes('st_bme_graph_meta'));
    assert.strictEqual(metaStmts.length, 1, 'exactly one meta upsert for empty delta');
    // No DELETE or INSERT statements for empty delta.
    assert.strictEqual(stmts.filter((s) => s.statement.includes('DELETE')).length, 0, 'no DELETE for empty delta');
    assert.strictEqual(stmts.filter((s) => s.statement.includes('INSERT INTO st_bme_graph_nodes')).length, 0, 'no node INSERT for empty delta');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta delta too large throws validation_error');
  {
    // 10001 nodes → ceil(10001/100) = 101 INSERT statements + 1 meta = 102 > 100.
    // The early budget estimate in buildCommitDeltaStatements must catch this
    // and throw validation_error BEFORE building any statements.
    const largeNodeArray = Array.from({ length: 10001 }, (_, i) => ({ id: 'node-' + i, type: 'concept' }));
    let caught = null;
    try {
      mod._buildCommitDeltaStatements('chat-big', 5, {
        upsertNodes: largeNodeArray,
      }, {}, { revision: 5, nodeCount: 0, edgeCount: 0 });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'oversized delta must throw');
    assert.strictEqual(caught.status, 400, 'must be 400 validation_error');
    assert.strictEqual(caught.code, 'validation_error', 'must be validation_error');
    assert.ok(caught.details, 'must have details');
    assert.ok(caught.details.statementCount > mod.MAX_SQL_BATCH_STATEMENTS, 'details must show overage');
    assert.strictEqual(caught.details.maxStatements, mod.MAX_SQL_BATCH_STATEMENTS);
    assert.strictEqual(caught.details.upsertNodes, 10001);
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta chunking: large-but-under-budget delta succeeds');
  {
    // 5000 nodes → ceil(5000/100) = 50 INSERT statements + 1 meta = 51 <= 100.
    // Verifies chunking produces multiple multi-row INSERT statements, each
    // carrying CHUNK_ROWS_INSERT rows.
    const nodeArray = Array.from({ length: 5000 }, (_, i) => ({ id: 'node-' + i, type: 't' }));
    const built = mod._buildCommitDeltaStatements('chat-chunk', 0, {
      upsertNodes: nodeArray,
    }, {}, { revision: 0, nodeCount: 0, edgeCount: 0 });
    // 50 INSERT nodes + 1 meta = 51 statements.
    assert.strictEqual(built.statements.length, 51, '5000 nodes must produce 50 INSERT chunks + 1 meta');
    const insertStmts = built.statements.filter((s) => s.statement.includes('INSERT INTO st_bme_graph_nodes'));
    assert.strictEqual(insertStmts.length, 50, '50 multi-row INSERT chunks');
    // Each INSERT chunk carries CHUNK_ROWS_INSERT rows × 8 params = 800 params.
    for (const stmt of insertStmts) {
      assert.strictEqual(stmt.params.length, mod.CHUNK_ROWS_INSERT * 8, 'each chunk must have 100 rows × 8 params');
    }
    assert.ok(built.statements[built.statements.length - 1].statement.includes('st_bme_graph_meta'), 'last stmt must be meta upsert');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta requires chatId');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.commitDelta';
    await assert.rejects(
      async () => await (await getHandler(mod, 'graph.commitDelta'))(ctx, { baseRevision: 0, delta: {} }, {}),
      /requires chatId/,
      'should reject missing chatId',
    );
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta requires baseRevision');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.commitDelta';
    await assert.rejects(
      async () => await (await getHandler(mod, 'graph.commitDelta'))(ctx, { chatId: 'c1', delta: {} }, {}),
      /requires baseRevision/,
      'should reject missing baseRevision',
    );
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta requires delta');
  {
    const { ctx } = createMockSqlTxCtx({ meta: {}, nodes: [], edges: [] });
    ctx.transactionName = 'graph.commitDelta';
    await assert.rejects(
      async () => await (await getHandler(mod, 'graph.commitDelta'))(ctx, { chatId: 'c1', baseRevision: 0 }, {}),
      /requires delta/,
      'should reject missing delta',
    );
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta respects explicit database');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 0 },
      nodes: [],
      edges: [],
    });
    ctx.transactionName = 'graph.commitDelta';
    const result = await (await getHandler(mod, 'graph.commitDelta'))(ctx, {
      chatId: 'chat-db',
      database: 'custom-graph-db',
      baseRevision: 0,
      idempotencyKey: 'db-key',
      delta: {},
    }, {});
    assert.strictEqual(result.result.ok, true);
    assert.strictEqual(calls.exec[0].database, 'custom-graph-db', 'exec must use explicit database');
    assert.strictEqual(calls.query[0].database, 'custom-graph-db', 'query must use explicit database');
    assert.strictEqual(calls.transaction[0].database, 'custom-graph-db', 'transaction must use explicit database');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta markSyncDirty:false clears syncDirty');
  {
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 1, nodeCount: 0, edgeCount: 0 },
      nodes: [],
      edges: [],
    });
    ctx.transactionName = 'graph.commitDelta';
    const result = await (await getHandler(mod, 'graph.commitDelta'))(ctx, {
      chatId: 'chat-sync',
      baseRevision: 1,
      idempotencyKey: 'sync-key',
      delta: {},
      options: { markSyncDirty: false },
    }, {});
    assert.strictEqual(result.result.ok, true);
    const metaStmt = calls.transaction[0].statements.find((s) => s.statement.includes('st_bme_graph_meta'));
    const metaParams = metaStmt.params;
    const metaPairs = [];
    for (let i = 0; i < metaParams.length; i += 4) {
      metaPairs.push({ key: metaParams[i + 1], value: JSON.parse(metaParams[i + 2]) });
    }
    const metaKeyMap = {};
    for (const pair of metaPairs) metaKeyMap[pair.key] = pair.value;
    assert.strictEqual(metaKeyMap['syncDirty'], false, 'syncDirty must be false when markSyncDirty:false');
    assert.strictEqual(metaKeyMap['syncDirtyReason'], '', 'syncDirtyReason must be empty when markSyncDirty:false');
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta idempotency fingerprint covers options (markSyncDirty true vs false → idempotency_conflict)');
  {
    // Phase E fingerprint blocker regression: previously the fingerprint
    // omitted `database` and `options`, so reusing the same idempotency
    // key with the same chatId/baseRevision/delta but DIFFERENT options
    // (e.g. markSyncDirty:true vs false) would incorrectly replay cached
    // success — committing the wrong syncDirty / lastMutationReason /
    // vectorDirtyHint values. The fingerprint now includes options, so a
    // differing options shape must surface idempotency_conflict (409)
    // and must NOT execute the transaction fn a second time.
    const sharedCache = new Map();
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 1, nodeCount: 0, edgeCount: 0 },
      nodes: [],
      edges: [],
      idempotencyCache: sharedCache,
    });
    ctx.transactionName = 'graph.commitDelta';
    const handler = await getHandler(mod, 'graph.commitDelta');

    // First call: markSyncDirty:true (default-ish).
    const input1 = {
      chatId: 'chat-opts',
      baseRevision: 1,
      idempotencyKey: 'opts-key',
      delta: {},
      options: { markSyncDirty: true, reason: 'extraction-batch' },
    };
    const result1 = await handler(ctx, input1, {});
    assert.strictEqual(result1.result.ok, true, 'first call must succeed');
    assert.strictEqual(result1.result.accepted, true, 'first call must be accepted');
    assert.strictEqual(calls.transaction.length, 1, 'first call must execute transaction');

    // Second call with SAME idempotency key + SAME chatId/baseRevision/delta
    // but DIFFERENT options (markSyncDirty:false) → different fingerprint →
    // idempotency_conflict (not replay).
    const input2 = {
      chatId: 'chat-opts',
      baseRevision: 2, // bump to match post-first-call server state (CAS never reached)
      idempotencyKey: 'opts-key', // SAME key
      delta: {}, // SAME delta
      options: { markSyncDirty: false }, // DIFFERENT options
    };
    let caught = null;
    try {
      await handler(ctx, input2, {});
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'options fingerprint mismatch must throw');
    assert.strictEqual(caught.status, 409, 'options fingerprint mismatch must be 409');
    assert.strictEqual(caught.code, 'idempotency_conflict', 'error code must be idempotency_conflict');
    // Transaction must NOT have been called again — the second call must
    // short-circuit at the idempotency layer, not execute fn() (which would
    // otherwise have run the CAS check and re-committed with markSyncDirty:false).
    assert.strictEqual(calls.transaction.length, 1, 'fn must not execute on options fingerprint mismatch');
    // Idempotency.run was called twice (both calls go through it).
    assert.strictEqual(calls.idempotencyRun.length, 2, 'idempotency.run called on both invocations');
    // The two fingerprints captured by idempotency.run must differ (the
    // options shape is what changed).
    assert.notStrictEqual(
      calls.idempotencyRun[0].fingerprint,
      calls.idempotencyRun[1].fingerprint,
      'fingerprint must differ when options differ',
    );
    assert.ok(
      calls.idempotencyRun[0].fingerprint.includes('"markSyncDirty"'),
      'fingerprint must include options payload',
    );
  }

  console.log('[test:authority-companion-module] testing graph.commitDelta idempotency fingerprint covers database');
  {
    // Same blocker, different angle: same idempotency key + same
    // chatId/baseRevision/delta but a DIFFERENT database target must
    // also surface idempotency_conflict rather than replay cached
    // success against the wrong database.
    const sharedCache = new Map();
    const { calls, ctx } = createMockSqlTxCtx({
      meta: { revision: 1, nodeCount: 0, edgeCount: 0 },
      nodes: [],
      edges: [],
      idempotencyCache: sharedCache,
    });
    ctx.transactionName = 'graph.commitDelta';
    const handler = await getHandler(mod, 'graph.commitDelta');

    const input1 = {
      chatId: 'chat-db-fp',
      database: 'graph-db-a',
      baseRevision: 1,
      idempotencyKey: 'db-fp-key',
      delta: {},
    };
    const result1 = await handler(ctx, input1, {});
    assert.strictEqual(result1.result.ok, true, 'first call must succeed');
    assert.strictEqual(calls.transaction.length, 1, 'first call must execute transaction');
    assert.strictEqual(calls.transaction[0].database, 'graph-db-a', 'first call must target db-a');

    const input2 = {
      chatId: 'chat-db-fp',
      database: 'graph-db-b', // DIFFERENT database target
      baseRevision: 2,
      idempotencyKey: 'db-fp-key', // SAME key
      delta: {}, // SAME delta
    };
    let caught = null;
    try {
      await handler(ctx, input2, {});
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'database fingerprint mismatch must throw');
    assert.strictEqual(caught.status, 409, 'database fingerprint mismatch must be 409');
    assert.strictEqual(caught.code, 'idempotency_conflict', 'error code must be idempotency_conflict');
    assert.strictEqual(calls.transaction.length, 1, 'fn must not execute on database fingerprint mismatch');
    assert.notStrictEqual(
      calls.idempotencyRun[0].fingerprint,
      calls.idempotencyRun[1].fingerprint,
      'fingerprint must differ when database differs',
    );
  }

  console.log('[test:authority-companion-module] all tests passed');
}

async function getHandler(mod, name) {
  const registered = {};
  const ctx = {
    moduleId: 'third-party.st-bme',
    ownerExtensionId: 'third-party/st-bme',
    moduleDir: '/fake/.authority',
    logger: { info() {}, warn() {}, error() {} },
    registerTransaction(n, def) { registered[n] = def; },
  };
  await mod.activate(ctx);
  return registered[name].handler;
}

run().catch((error) => {
  console.error('[test:authority-companion-module] FAILED:', error.message);
  console.error(error.stack);
  process.exit(1);
});
