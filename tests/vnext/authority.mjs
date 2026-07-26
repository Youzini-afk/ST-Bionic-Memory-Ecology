import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { AuthorityStateStore } from "../../src/storage/authority-state-store.js";
import {
  semanticMessages,
  stateStoreContractCases,
} from "./state-store-contract.mjs";
import { getHistoryPrefixHash, snapshotHistory } from "../../src/core/history.js";

const require = createRequire(import.meta.url);
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const authorityModule = require(path.join(extensionRoot, ".authority/server.cjs"));

function sqlValue(value) {
  return typeof value === "boolean" ? Number(value) : value;
}

class SqlHarness {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.failWriteAt = null;
  }

  async query(_database, statement, params = []) {
    const rows = this.db.prepare(statement).all(...params.map(sqlValue));
    return { kind: "query", columns: rows.length ? Object.keys(rows[0]) : [], rows, rowCount: rows.length };
  }

  async exec(_database, statement, params = []) {
    const result = this.db.prepare(statement).run(...params.map(sqlValue));
    return { kind: "exec", rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) || null };
  }

  async transaction(_database, statements) {
    const inject = statements.some(({ mode }) => mode !== "query") ? this.failWriteAt : null;
    if (inject !== null) this.failWriteAt = null;
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (inject === index) throw new Error(`injected SQL failure at ${index}`);
        const item = statements[index];
        const prepared = this.db.prepare(item.statement);
        if (item.mode === "query") {
          const rows = prepared.all(...(item.params || []).map(sqlValue));
          results.push({ kind: "query", columns: rows.length ? Object.keys(rows[0]) : [], rows, rowCount: rows.length });
        } else {
          const result = prepared.run(...(item.params || []).map(sqlValue));
          results.push({ kind: "exec", rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) || null });
        }
      }
      this.db.exec("COMMIT");
      return { committed: true, results };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async migrate(_database, migrations, tableName = "_authority_migrations") {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = [];
    const skipped = [];
    for (const migration of migrations) {
      const exists = this.db.prepare(`SELECT 1 FROM ${tableName} WHERE id = ?`).get(migration.id);
      if (exists) {
        skipped.push(migration.id);
        continue;
      }
      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.statement);
        this.db.prepare(`INSERT INTO ${tableName} (id, applied_at) VALUES (?, ?)`).run(
          migration.id,
          new Date().toISOString(),
        );
        this.db.exec("COMMIT");
        applied.push(migration.id);
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return { tableName, applied, skipped, latestId: migrations.at(-1)?.id || null };
  }

  close() {
    this.db.close();
  }
}

class LockHarness {
  tails = new Map();

  async withLock(scope, _options, task) {
    const previous = this.tails.get(scope) || Promise.resolve();
    let release;
    const queued = new Promise((resolve) => { release = resolve; });
    this.tails.set(scope, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(scope) === queued) this.tails.delete(scope);
    }
  }
}

async function createHarness(triviumOverrides = {}) {
  const handlers = new Map();
  const sql = new SqlHarness();
  const locks = new LockHarness();
  await authorityModule.activate({
    moduleDir: path.join(extensionRoot, ".authority"),
    logger: { info() {}, warn() {}, error() {} },
    registerTransaction(name, definition) {
      handlers.set(name, definition.handler);
    },
  });
  const txCtx = {
    sql,
    locks,
    idempotency: { async run(_key, _fingerprint, task) { return await task(); } },
    trivium: {
      async stat() { return { exists: false, nodeCount: 0, edgeCount: 0 }; },
      async bulkUpsert() { throw new Error("unexpected vector write"); },
      async bulkLink() { throw new Error("unexpected vector link"); },
      async searchHybrid() { return []; },
      async resolveMany() { return { items: [] }; },
      async neighbors() { return { nodes: [] }; },
      ...triviumOverrides,
    },
  };
  const client = {
    async requestModuleTransaction(moduleId, name, input, options = {}) {
      assert.equal(moduleId, "third-party.st-bme");
      const handler = handlers.get(name);
      if (!handler) throw new Error(`missing handler ${name}`);
      const wireInput = JSON.parse(JSON.stringify(input));
      const output = await handler(txCtx, wireInput, {
        input: wireInput,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      return { ok: true, result: JSON.parse(JSON.stringify(output.result)) };
    },
  };
  let id = 0;
  return {
    client,
    handlers,
    sql,
    store: new AuthorityStateStore({ client, id: () => `authority-${++id}` }),
    close: () => sql.close(),
  };
}

let passed = 0;
for (const contract of stateStoreContractCases()) {
  const harness = await createHarness();
  try {
    await contract.run(harness.store);
    passed += 1;
    console.log(`ok ${passed} - authority store: ${contract.name}`);
  } finally {
    harness.close();
  }
}

{
  const harness = await createHarness();
  try {
    const chatKey = "atomic-failure";
    const history = await snapshotHistory(semanticMessages(["user", "one"]));
    const reconciled = await harness.store.reconcileHistory({ chatKey, expectedRevision: 0, history });
    harness.sql.failWriteAt = 2;
    await assert.rejects(harness.store.commit({
      id: "atomic-transaction",
      chatKey,
      expectedRevision: reconciled.head.revision,
      operation: "extract",
      basisHistoryLength: 1,
      basisHistoryHash: getHistoryPrefixHash(history),
      processedThroughAfter: 0,
      changeSet: {
        changes: [{ collection: "nodes", id: "n1", before: null, after: { id: "n1" } }],
      },
    }), /injected SQL failure/);
    const state = await harness.store.readConversation(chatKey);
    assert.equal(state.head.revision, reconciled.head.revision);
    assert.equal(state.collections.nodes.size, 0);
    assert.equal(state.transactions.length, 0);
    passed += 1;
    console.log(`ok ${passed} - authority SQL failure leaves the prior revision intact`);
  } finally {
    harness.close();
  }
}

{
  const harness = await createHarness();
  try {
    const input = {
      operation: "reconcileHistory",
      command: {
        chatKey: "durable-replay",
        expectedRevision: 0,
        history: await snapshotHistory(semanticMessages(["user", "one"])),
      },
    };
    const options = { idempotencyKey: "durable-command" };
    const first = await harness.client.requestModuleTransaction("third-party.st-bme", "state.command", input, options);
    const replay = await harness.client.requestModuleTransaction("third-party.st-bme", "state.command", input, options);
    assert.deepEqual(replay.result, first.result);
    assert.equal((await harness.store.readConversation("durable-replay")).head.revision, 1);
    const conflict = await harness.client.requestModuleTransaction(
      "third-party.st-bme",
      "state.command",
      { ...input, operation: "settleVectorJobs" },
      options,
    );
    assert.equal(conflict.result.error.code, "idempotency_conflict");
    passed += 1;
    console.log(`ok ${passed} - authority command result replays from the atomic SQL ledger`);
  } finally {
    harness.close();
  }
}

{
  const calls = [];
  const namespace = "bme-vnext:collection-a";
  const harness = await createHarness({
    async stat(request) {
      calls.push(["stat", request]);
      return { exists: true, nodeCount: 1, edgeCount: 0 };
    },
    async bulkUpsert(request) {
      calls.push(["upsert", request]);
      return { totalCount: 1, successCount: 1, failureCount: 0, failures: [] };
    },
    async bulkLink(request) {
      calls.push(["link", request]);
      return { totalCount: 1, successCount: 1, failureCount: 0, failures: [] };
    },
    async searchHybrid(request) {
      calls.push(["search", request]);
      return [
        { id: 1, externalId: "valid", namespace, score: 0.9, payload: { secret: "never return" } },
        { id: 2, externalId: "other-chat", namespace: "bme-vnext:collection-b", score: 1 },
      ];
    },
  });
  try {
    const manifest = await harness.client.requestModuleTransaction(
      "third-party.st-bme",
      "vector.manifest",
      { collectionId: "collection-a", observedDim: 2 },
    );
    assert.equal(manifest.result.database, "st_bme_vnext_vectors");
    assert.equal(manifest.result.manifest.observedDim, 2);

    const applied = await harness.client.requestModuleTransaction(
      "third-party.st-bme",
      "vector.apply",
      {
        collectionId: "collection-a",
        chatId: "chat-a",
        graphRevision: 3,
        modelScope: "provider:model",
        vectorSpaceId: "space-a",
        observedDim: 2,
        items: [{ externalId: "valid", vector: [0.25, 0.75], text: "memory" }],
        links: [{ fromId: "valid", toId: "valid", relation: "self" }],
      },
      { idempotencyKey: "vector-job-1" },
    );
    assert.equal(applied.result.ok, true);
    assert.equal(applied.result.namespace, namespace);
    assert.equal(calls.find(([name]) => name === "upsert")[1].items[0].payload.chatId, "chat-a");

    const recalled = await harness.client.requestModuleTransaction(
      "third-party.st-bme",
      "recall.candidates",
      {
        collectionId: "collection-a",
        chatId: "chat-a",
        observedDim: 2,
        queryTexts: ["memory"],
        queryVectors: [[0.25, 0.75]],
        payloadFilter: { ownerKey: ["character-a"] },
      },
    );
    assert.deepEqual(recalled.result.candidates, [{
      externalId: "valid",
      score: 0.9,
      source: "search",
      internalId: 1,
      namespace,
    }]);
    assert.deepEqual(calls.find(([name]) => name === "search")[1].payloadFilter, {
      ownerKey: ["character-a"],
    });
    passed += 1;
    console.log(`ok ${passed} - derived vectors stay in the vNext namespace and recall returns sanitized same-scope candidates`);
  } finally {
    harness.close();
  }
}

const manifest = require(path.join(extensionRoot, ".authority/module.json"));
assert.deepEqual(Object.keys(manifest.transactions).sort(), [
  "recall.candidates",
  "state.command",
  "state.read",
  "vector.apply",
  "vector.manifest",
]);
assert.equal(authorityModule.STATE_DATABASE, "st_bme_vnext");
assert.equal(authorityModule.VECTOR_DATABASE, "st_bme_vnext_vectors");
passed += 1;
console.log(`ok ${passed} - companion manifest exposes only the vNext state and derived-index surface`);
console.log(`vNext authority: ${passed}/${passed} passed`);
