import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { createTurnEvidence } from "../domain/memory-records.js";
import { BmeDatabase, buildBmeDbName } from "../sync/bme-db.js";
import { MEMORY_LEDGER_HEAD_META_KEY } from "../storage/memory-ledger-codec.js";
import { MemoryLedgerStoreAdapter } from "../storage/memory-ledger-store.js";

globalThis.Dexie = Dexie;
const chatId = "chat:vnext-ledger-indexeddb";
await Dexie.delete(buildBmeDbName(chatId));

function transactionFor(ledger, suffix, now) {
  const evidence = createTurnEvidence({
    chatId,
    turnId: `turn-${suffix}`,
    userText: `user-${suffix}`,
    assistantText: `assistant-${suffix}`,
    createdAt: now,
  });
  return {
    baseRevision: ledger.revision,
    idempotencyKey: `idb-${suffix}`,
    records: [evidence],
    sourceEvidenceIds: [evidence.id],
    reason: `idb-${suffix}`,
    now,
  };
}

let db = new BmeDatabase(chatId, { dexieClass: Dexie });
await db.open();
await db.bulkUpsertNodes([
  {
    id: "legacy-projection-node",
    type: "event",
    fields: { title: "projection remains independent" },
  },
]);
let adapter = new MemoryLedgerStoreAdapter({ chatId, store: db });
let committed = await adapter.transact((ledger) => transactionFor(ledger, "one", 10));
assert.equal(committed.ledger.revision, 1);
assert.equal((await db.getMeta(MEMORY_LEDGER_HEAD_META_KEY)).revision, 1);
await db.close();

db = new BmeDatabase(chatId, { dexieClass: Dexie });
await db.open();
adapter = new MemoryLedgerStoreAdapter({ chatId, store: db });
assert.equal((await adapter.load()).revision, 1);
assert.equal((await db.exportSnapshot()).nodes[0].id, "legacy-projection-node");

// A graph projection write may advance the physical revision without changing
// the ledger revision. The next ledger transaction safely commits from its own
// domain head while using the fresh physical CAS revision.
await db.bulkUpsertNodes([
  {
    id: "second-projection-node",
    type: "event",
    fields: { title: "unrelated projection commit" },
  },
]);
committed = await adapter.transact((ledger) => transactionFor(ledger, "two", 20));
assert.equal(committed.ledger.revision, 2);
assert.equal((await db.exportSnapshot()).nodes.length, 2);

await db.close();
await Dexie.delete(buildBmeDbName(chatId));

console.log("memory ledger IndexedDB integration tests passed");
