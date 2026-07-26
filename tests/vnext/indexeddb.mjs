import assert from "node:assert/strict";

await import("fake-indexeddb/auto");
const importedDexie = await import("dexie");
const Dexie = importedDexie.default || importedDexie.Dexie || importedDexie;

import { getHistoryPrefixHash, snapshotHistory } from "../../src/core/history.js";
import { IndexedDbStateStore } from "../../src/storage/indexeddb-state-store.js";
import {
  semanticMessages,
  stateStoreContractCases,
} from "./state-store-contract.mjs";

const tests = [];
const test = (name, run) => tests.push({ name, run });
let databaseNumber = 0;

function nextDatabaseName() {
  databaseNumber += 1;
  return `STBME_v9_test_${process.pid}_${databaseNumber}`;
}

function createStore(databaseName) {
  let clock = 2000;
  let id = 0;
  return new IndexedDbStateStore({
    databaseName,
    dexieClass: Dexie,
    now: () => ++clock,
    id: () => `idb-tx-${++id}`,
  });
}

async function withDatabase(run) {
  const databaseName = nextDatabaseName();
  const store = createStore(databaseName);
  try {
    return await run(store, databaseName);
  } finally {
    await store.close();
    await Dexie.delete(databaseName);
  }
}

for (const contract of stateStoreContractCases()) {
  test(`IndexedDB store: ${contract.name}`, () =>
    withDatabase((store) => contract.run(store)));
}

test("a committed revision survives close and reopen", () =>
  withDatabase(async (first, databaseName) => {
    const chatKey = "restart";
    const history = await snapshotHistory(semanticMessages(
      ["user", "hello"],
      ["assistant", "reply"],
    ));
    await first.reconcileHistory({ chatKey, expectedRevision: 0, history });
    await first.commit({
      chatKey,
      expectedRevision: 1,
      operation: "extract",
      basisHistoryLength: 2,
      basisHistoryHash: getHistoryPrefixHash(history, 2),
      processedThroughAfter: 1,
      changeSet: {
        changes: [
          { collection: "nodes", id: "persisted", before: null, after: { id: "persisted" } },
        ],
      },
    });
    await first.close();

    const reopened = createStore(databaseName);
    try {
      const state = await reopened.readConversation(chatKey);
      assert.equal(state.head.revision, 2);
      assert.equal(state.collections.nodes.has("persisted"), true);
      assert.equal(state.transactions.length, 1);
    } finally {
      await reopened.close();
    }
  }));

test("a late IndexedDB constraint failure leaves no partial graph write", () =>
  withDatabase(async (store) => {
    const chatKey = "atomic";
    const history = await snapshotHistory(semanticMessages(["user", "one"]));
    await store.reconcileHistory({ chatKey, expectedRevision: 0, history });
    const basisHistoryHash = getHistoryPrefixHash(history, 1);
    await store.commit({
      id: "same-id",
      chatKey,
      expectedRevision: 1,
      operation: "extract",
      basisHistoryLength: 1,
      basisHistoryHash,
      processedThroughAfter: 0,
      changeSet: {
        changes: [{ collection: "nodes", id: "first", before: null, after: { id: "first" } }],
      },
    });

    await assert.rejects(store.commit({
      id: "same-id",
      chatKey,
      expectedRevision: 2,
      operation: "extract",
      basisHistoryLength: 1,
      basisHistoryHash,
      processedThroughAfter: 0,
      changeSet: {
        changes: [{ collection: "nodes", id: "partial", before: null, after: { id: "partial" } }],
      },
    }));

    const state = await store.readConversation(chatKey);
    assert.equal(state.head.revision, 2);
    assert.equal(state.collections.nodes.has("first"), true);
    assert.equal(state.collections.nodes.has("partial"), false);
    assert.equal(state.transactions.length, 1);
  }));

test("one database keeps conversation namespaces isolated", () =>
  withDatabase(async (store) => {
    const history = await snapshotHistory(semanticMessages(["user", "one"]));
    await store.reconcileHistory({ chatKey: "chat-a", expectedRevision: 0, history });
    await store.reconcileHistory({ chatKey: "chat-b", expectedRevision: 0, history });
    await store.commit({
      chatKey: "chat-a",
      expectedRevision: 1,
      operation: "extract",
      basisHistoryLength: 1,
      basisHistoryHash: getHistoryPrefixHash(history, 1),
      processedThroughAfter: 0,
      changeSet: {
        changes: [{ collection: "nodes", id: "only-a", before: null, after: { id: "only-a" } }],
      },
    });
    assert.equal((await store.readConversation("chat-a")).collections.nodes.has("only-a"), true);
    assert.equal((await store.readConversation("chat-b")).collections.nodes.has("only-a"), false);
  }));

let passed = 0;
for (const { name, run } of tests) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`vNext IndexedDB: ${passed}/${tests.length} passed`);
