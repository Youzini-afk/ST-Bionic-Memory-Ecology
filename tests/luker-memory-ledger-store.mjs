import assert from "node:assert/strict";

import { createEmptyMemoryLedger } from "../domain/memory-contract.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { createTurnEvidence } from "../domain/memory-records.js";
import {
  LUKER_MEMORY_LEDGER_NAMESPACE,
  LukerMemoryLedgerStore,
} from "../host/luker-memory-ledger-store.js";
import { serializeBmeChatStateTarget } from "../host/runtime-host-adapter.js";
import { MemoryLedgerStoreAdapter } from "../storage/memory-ledger-store.js";

function createFakeHostAdapter() {
  const states = new Map();
  return {
    states,
    async readChatState(namespace, { target } = {}) {
      return states.get(`${serializeBmeChatStateTarget(target)}::${namespace}`) ?? null;
    },
    async updateChatState(namespace, updater, { target } = {}) {
      const key = `${serializeBmeChatStateTarget(target)}::${namespace}`;
      const next = await updater(states.get(key) ?? null);
      states.set(key, structuredClone(next));
      return { ok: true, updated: true, state: structuredClone(next) };
    },
  };
}

const chatId = "luker-chat.jsonl";
const target = {
  is_group: false,
  avatar_url: "alice.png",
  file_name: chatId,
};
const hostAdapter = createFakeHostAdapter();
const store = new LukerMemoryLedgerStore({ chatId, hostAdapter, target });
await store.open();
assert.equal(await store.getRevision(), 0);
assert.equal((await store.exportSnapshot()).meta.chatId, chatId);

const ledgerStore = new MemoryLedgerStoreAdapter({ chatId, store });
const evidence = createTurnEvidence({
  chatId,
  turnId: "turn:luker",
  userText: "Remember",
  assistantText: "Stored in Luker chat state",
  createdAt: 10,
});
const result = await ledgerStore.transact({
  baseRevision: 0,
  idempotencyKey: "luker-first",
  records: [evidence],
  sourceEvidenceIds: [evidence.id],
  now: 10,
});
assert.equal(result.ledger.revision, 1);
assert.equal(await store.getRevision(), 1);

const reopened = new MemoryLedgerStoreAdapter({
  chatId,
  store: new LukerMemoryLedgerStore({ chatId, hostAdapter, target }),
});
assert.deepEqual(await reopened.load({ fresh: true }), result.ledger);

await assert.rejects(
  store.commitDelta(
    { runtimeMetaPatch: { stale: true } },
    { baseRevision: 0, idempotencyKey: "stale" },
  ),
  (error) => error?.code === "transaction_conflict",
);

const otherTarget = { is_group: true, id: "group-other" };
const otherStore = new LukerMemoryLedgerStore({ chatId, hostAdapter, target: otherTarget });
assert.equal((await otherStore.exportSnapshot()).meta.revision, 0);
assert.equal(
  hostAdapter.states.has(`${serializeBmeChatStateTarget(target)}::${LUKER_MEMORY_LEDGER_NAMESPACE}`),
  true,
);

assert.throws(
  () => new LukerMemoryLedgerStore({ chatId, hostAdapter: null, target }),
  (error) => error?.code === "luker_memory_ledger_unavailable",
);
assert.throws(
  () => new LukerMemoryLedgerStore({ chatId, hostAdapter, target: null }),
  (error) => error?.code === "luker_memory_ledger_unavailable",
);

console.log("Luker memory ledger store tests passed");
