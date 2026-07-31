import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { stableStringify } from "../domain/memory-id.js";
import {
  MEMORY_LEDGER_HEAD_META_KEY,
  decodeMemoryLedgerSnapshot,
  encodeMemoryLedgerCommitPatch,
  memoryLedgerHeadFingerprint,
} from "./memory-ledger-codec.js";

function isPhysicalConflict(error) {
  return (
    error?.code === "transaction_conflict" ||
    error?.code === "memory_ledger_conflict" ||
    /conflict|base revision changed/i.test(String(error?.message || ""))
  );
}

export class MemoryLedgerStoreAdapter {
  constructor({ chatId, store, physicalRetryLimit = 4 } = {}) {
    this.chatId = String(chatId || "").trim();
    if (!this.chatId) throw new TypeError("MemoryLedgerStoreAdapter requires chatId");
    if (
      !store ||
      typeof store.exportSnapshot !== "function" ||
      typeof store.commitDelta !== "function" ||
      typeof store.getRevision !== "function" ||
      typeof store.getMeta !== "function"
    ) {
      throw new TypeError("MemoryLedgerStoreAdapter requires a snapshot/CAS store");
    }
    this.store = store;
    this.physicalRetryLimit = Math.max(1, Math.floor(Number(physicalRetryLimit) || 4));
    this._cachedLedger = null;
    this._cachedHead = null;
  }

  async load({ fresh = false } = {}) {
    if (!fresh && this._cachedLedger) return this._cachedLedger;
    const snapshot = await this.store.exportSnapshot();
    const ledger = decodeMemoryLedgerSnapshot(snapshot, { chatId: this.chatId });
    this._cachedLedger = ledger;
    this._cachedHead = snapshot?.meta?.[MEMORY_LEDGER_HEAD_META_KEY] || null;
    return ledger;
  }

  async transact(transactionOrFactory) {
    let lastConflict = null;
    for (let attempt = 0; attempt < this.physicalRetryLimit; attempt += 1) {
      const ledger = await this.load({ fresh: attempt > 0 });
      const transaction =
        typeof transactionOrFactory === "function"
          ? await transactionOrFactory(ledger)
          : transactionOrFactory;
      if (!transaction) {
        return { ledger, commit: null, appendedRecords: [], replayed: false, changed: false };
      }
      const domainResult = appendMemoryLedgerTransaction(ledger, transaction);
      if (domainResult.replayed) return { ...domainResult, changed: false };
      const encoded = encodeMemoryLedgerCommitPatch(ledger, domainResult);

      // Read the physical revision first, then the domain head. Any writer
      // after the revision read makes the subsequent CAS fail; a ledger writer
      // before the head read is detected without overwriting its head.
      const physicalRevision = await this.store.getRevision();
      const persistedHead = await this.store.getMeta(MEMORY_LEDGER_HEAD_META_KEY, null);
      if (
        memoryLedgerHeadFingerprint(persistedHead) !==
        memoryLedgerHeadFingerprint(this._cachedHead)
      ) {
        this._cachedLedger = null;
        this._cachedHead = null;
        lastConflict = new Error("memory ledger head changed before commit");
        lastConflict.code = "transaction_conflict";
        continue;
      }

      try {
        const physicalResult = await this.store.commitDelta(
          { runtimeMetaPatch: encoded.runtimeMetaPatch },
          {
            baseRevision: physicalRevision,
            reason: transaction.reason || "memory-ledger-commit",
            markSyncDirty: true,
            idempotencyKey: `memory-ledger:${domainResult.commit.id}:${physicalRevision}`,
          },
        );
        this._cachedLedger = domainResult.ledger;
        this._cachedHead = encoded.head;
        return {
          ...domainResult,
          changed: true,
          physicalRevision: Number(physicalResult?.revision || 0),
          physicalResult,
        };
      } catch (error) {
        this._cachedLedger = null;
        this._cachedHead = null;
        if (!isPhysicalConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict || new Error("memory ledger physical commit retry exhausted");
  }

  inspectCache() {
    return {
      chatId: this.chatId,
      loaded: Boolean(this._cachedLedger),
      revision: Number(this._cachedLedger?.revision || 0),
      headFingerprint: memoryLedgerHeadFingerprint(this._cachedHead),
      head: this._cachedHead ? JSON.parse(stableStringify(this._cachedHead)) : null,
    };
  }
}
