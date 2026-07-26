import assert from "node:assert/strict";

import {
  applyChangeSet,
  ChangeConflictError,
  createGraphCollections,
  normalizeChangeSet,
} from "../../src/core/change-set.js";
import {
  ConversationEngine,
  LeaseExpiredError,
} from "../../src/core/conversation-engine.js";
import {
  findCommonPrefixLength,
  getHistoryPrefixHash,
  snapshotHistory,
} from "../../src/core/history.js";
import { MemoryStateStore } from "../../src/core/memory-store.js";
import {
  semanticMessages as messages,
  stateStoreContractCases,
} from "./state-store-contract.mjs";

const tests = [];
const test = (name, run) => tests.push({ name, run });

function deterministicStore() {
  let clock = 1000;
  let id = 0;
  return new MemoryStateStore({ now: () => ++clock, id: () => `tx-${++id}` });
}

test("semantic history ignores unrelated metadata and detects the first changed message", async () => {
  const base = messages(["user", "hello\r\nworld"], ["assistant", "reply"], ["user", "next"]);
  const same = base.map((message) => ({ ...message, extra: { transient: Math.random() } }));
  const changed = messages(["user", "hello\nworld"], ["assistant", "different"], ["user", "next"]);
  const left = await snapshotHistory(base);
  const equal = await snapshotHistory(same);
  const right = await snapshotHistory(changed);

  assert.deepEqual(
    left.map(({ messageHash, prefixHash }) => ({ messageHash, prefixHash })),
    equal.map(({ messageHash, prefixHash }) => ({ messageHash, prefixHash })),
  );
  assert.equal(findCommonPrefixLength(left, right), 1);
  assert.equal(getHistoryPrefixHash(left, 0), "0".repeat(64));
  assert.notEqual(getHistoryPrefixHash(left, 2), getHistoryPrefixHash(right, 2));
});

test("one ChangeSet applies and rolls back every touched record exactly", () => {
  const collections = createGraphCollections();
  const original = { id: "n1", text: "before", nested: { b: 2, a: 1 } };
  collections.nodes.set("n1", structuredClone(original));
  const changes = {
    changes: [
      { collection: "nodes", id: "n1", before: original, after: { id: "n1", text: "after" } },
      { collection: "nodes", id: "n2", before: null, after: { id: "n2", text: "new" } },
      { collection: "edges", id: "e1", before: null, after: { id: "e1", fromId: "n1", toId: "n2" } },
    ],
  };

  applyChangeSet(collections, changes, "forward");
  assert.equal(collections.nodes.get("n1").text, "after");
  assert.equal(collections.nodes.get("n2").text, "new");
  applyChangeSet(collections, changes, "rollback");
  assert.deepEqual(collections.nodes.get("n1"), original);
  assert.equal(collections.nodes.has("n2"), false);
  assert.equal(collections.edges.has("e1"), false);
});

test("ChangeSet rejects duplicate and stale record mutations", () => {
  assert.throws(
    () => normalizeChangeSet({ changes: [
      { collection: "nodes", id: "n1", before: null, after: { id: "n1" } },
      { collection: "nodes", id: "n1", before: null, after: { id: "n1", text: "again" } },
    ] }),
    /duplicate change/,
  );

  const collections = createGraphCollections();
  collections.nodes.set("n1", { id: "n1", value: 2 });
  assert.throws(
    () => applyChangeSet(collections, {
      changes: [{
        collection: "nodes",
        id: "n1",
        before: { id: "n1", value: 1 },
        after: { id: "n1", value: 3 },
      }],
    }),
    ChangeConflictError,
  );
});

for (const contract of stateStoreContractCases()) {
  test(`memory store: ${contract.name}`, () => contract.run(deterministicStore()));
}

test("engine serializes a chat and never retargets a late task to the active chat", async () => {
  const store = deterministicStore();
  const engine = new ConversationEngine({ store });
  const leaseA = engine.activate("chat-a");
  const historyA = messages(["user", "hello"]);
  const reconcileA = await engine.reconcile(leaseA, historyA);
  const basisHash = reconcileA.head.history[0].prefixHash;

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let leakedSideEffect = false;
  const activeTask = engine.enqueue(leaseA, async ({ assertActive }) => {
    await gate;
    assertActive();
    leakedSideEffect = true;
  });

  const leaseB = engine.activate("chat-b");
  await engine.reconcile(leaseB, messages(["user", "other"]));
  release();
  await assert.rejects(activeTask, LeaseExpiredError);
  assert.equal(leakedSideEffect, false);

  const stateA = await store.readConversation("chat-a");
  await engine.commit(leaseA, {
    expectedRevision: stateA.head.revision,
    operation: "background-extract",
    basisHistoryLength: 1,
    basisHistoryHash: basisHash,
    processedThroughAfter: 0,
    changeSet: {
      changes: [{ collection: "nodes", id: "a-only", before: null, after: { id: "a-only" } }],
    },
  }, { requiresActive: false });

  assert.equal((await store.readConversation("chat-a")).collections.nodes.has("a-only"), true);
  assert.equal((await store.readConversation("chat-b")).collections.nodes.has("a-only"), false);
});

test("a failed queued task does not poison later work", async () => {
  const engine = new ConversationEngine({ store: deterministicStore() });
  const lease = engine.activate("queue");
  const order = [];
  await assert.rejects(
    engine.enqueue(lease, async () => {
      order.push("failed");
      throw new Error("expected");
    }),
    /expected/,
  );
  await engine.enqueue(lease, async () => { order.push("next"); });
  assert.deepEqual(order, ["failed", "next"]);
});

let passed = 0;
for (const { name, run } of tests) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`vNext core: ${passed}/${tests.length} passed`);
