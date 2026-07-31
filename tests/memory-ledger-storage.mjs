import assert from "node:assert/strict";
import { createTurnEvidence } from "../domain/memory-records.js";
import { ConversationRepository } from "../sync/conversation-repository.js";
import {
  MEMORY_LEDGER_HEAD_META_KEY,
  MemoryLedgerStorageDivergenceError,
  decodeMemoryLedgerSnapshot,
  memoryLedgerRecordMetaKey,
} from "../storage/memory-ledger-codec.js";
import { MemoryLedgerRepository } from "../application/memory-ledger-repository.js";
import { MemoryLedgerStoreAdapter } from "../storage/memory-ledger-store.js";

function clone(value) {
  return structuredClone(value);
}

class FakeCasStore {
  constructor(chatId) {
    this.chatId = chatId;
    this.meta = { chatId, revision: 0, syncDirty: false };
    this.injectConflictOnce = false;
    this.throwAfterCommitOnce = false;
  }

  async open() {
    return this;
  }

  async close() {}

  async getRevision() {
    return Number(this.meta.revision || 0);
  }

  async getMeta(key, fallback = null) {
    return key in this.meta ? clone(this.meta[key]) : fallback;
  }

  async exportSnapshot() {
    return {
      schemaVersion: 1,
      meta: clone(this.meta),
      nodes: [],
      edges: [],
      tombstones: [],
      state: {},
    };
  }

  async commitDelta(delta, options) {
    if (this.injectConflictOnce) {
      this.injectConflictOnce = false;
      this.meta.revision += 1;
      const error = new Error("transaction conflict");
      error.code = "transaction_conflict";
      throw error;
    }
    if (Number(options.baseRevision) !== Number(this.meta.revision)) {
      const error = new Error("transaction conflict");
      error.code = "transaction_conflict";
      throw error;
    }
    Object.assign(this.meta, clone(delta.runtimeMetaPatch || {}));
    this.meta.revision += 1;
    this.meta.syncDirty = options.markSyncDirty !== false;
    const response = { revision: this.meta.revision };
    if (this.throwAfterCommitOnce) {
      this.throwAfterCommitOnce = false;
      throw new Error("response lost after durable commit");
    }
    return response;
  }
}

function evidenceTransaction(ledger, suffix, now) {
  const evidence = createTurnEvidence({
    chatId: ledger.chatId,
    turnId: `turn-${suffix}`,
    userText: `user-${suffix}`,
    assistantText: `assistant-${suffix}`,
    createdAt: now,
  });
  return {
    baseRevision: ledger.revision,
    idempotencyKey: `evidence-${suffix}`,
    records: [evidence],
    sourceEvidenceIds: [evidence.id],
    reason: `evidence-${suffix}`,
    now,
  };
}

const store = new FakeCasStore("chat:storage");
const adapter = new MemoryLedgerStoreAdapter({ chatId: "chat:storage", store });
let committed = await adapter.transact((ledger) => evidenceTransaction(ledger, "one", 10));
assert.equal(committed.ledger.revision, 1);
assert.equal(store.meta.syncDirty, true);
assert.equal(store.meta[MEMORY_LEDGER_HEAD_META_KEY].headCommitId, committed.commit.id);
assert.ok(store.meta[memoryLedgerRecordMetaKey(committed.commit.id)]);
assert.ok(store.meta[memoryLedgerRecordMetaKey(committed.appendedRecords[0].id)]);

const reopened = new MemoryLedgerStoreAdapter({ chatId: "chat:storage", store });
assert.equal((await reopened.load()).revision, 1);
assert.equal((await reopened.load()).records.length, 2);

// An unrelated physical write advances the shared graph-store revision. The
// adapter reloads and safely rebases because the domain ledger head is intact.
store.injectConflictOnce = true;
committed = await reopened.transact((ledger) => evidenceTransaction(ledger, "two", 20));
assert.equal(committed.ledger.revision, 2);

// A lost response must not leave an optimistic in-memory success. A retry of
// the same idempotency key observes the durable commit and returns replayed.
const transactionThree = evidenceTransaction(committed.ledger, "three", 30);
store.throwAfterCommitOnce = true;
await assert.rejects(reopened.transact(transactionThree), /response lost/);
const replay = await reopened.transact(transactionThree);
assert.equal(replay.replayed, true);
assert.equal(replay.ledger.revision, 3);

const divergentSnapshot = await store.exportSnapshot();
const existingCommit = replay.commit;
const forkCommit = {
  ...existingCommit,
  id: `${existingCommit.id}-fork`,
  idempotencyKey: `${existingCommit.idempotencyKey}-fork`,
};
divergentSnapshot.meta[memoryLedgerRecordMetaKey(forkCommit.id)] = forkCommit;
assert.throws(
  () => decodeMemoryLedgerSnapshot(divergentSnapshot, { chatId: "chat:storage" }),
  MemoryLedgerStorageDivergenceError,
);

// Background work may open its origin chat without changing the active chat
// pointer used by UI/runtime publication.
const stores = new Map();
const conversationRepository = new ConversationRepository({
  resolveBinding: async () => ({ tier: "fake" }),
  bindingKey: (binding) => binding.tier,
  storeFactory: async (chatId) => {
    if (!stores.has(chatId)) stores.set(chatId, new FakeCasStore(chatId));
    return stores.get(chatId);
  },
});
await conversationRepository.switchChat("chat:active");
const ledgerRepository = new MemoryLedgerRepository({ conversationRepository });
await ledgerRepository.load("chat:background");
assert.equal(conversationRepository.getCurrentChatId(), "chat:active");

console.log("memory ledger storage tests passed");
