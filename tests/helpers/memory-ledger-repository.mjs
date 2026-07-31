import { createEmptyMemoryLedger } from "../../domain/memory-contract.js";
import { appendMemoryLedgerTransaction } from "../../domain/memory-ledger.js";

export class InMemoryLedgerRepository {
  constructor(chatId = "chat:agent-test", now = 1) {
    this.ledgers = new Map([[chatId, createEmptyMemoryLedger({ chatId, now })]]);
  }

  async load(chatId) {
    const ledger = this.ledgers.get(chatId);
    if (!ledger) throw new Error(`missing in-memory ledger: ${chatId}`);
    return ledger;
  }

  async transact(chatId, transactionOrFactory, { signal = null } = {}) {
    if (signal?.aborted) throw signal.reason || new Error("transaction cancelled");
    const ledger = await this.load(chatId);
    const transaction =
      typeof transactionOrFactory === "function"
        ? await transactionOrFactory(ledger)
        : transactionOrFactory;
    if (signal?.aborted) throw signal.reason || new Error("transaction cancelled");
    if (!transaction) {
      return { ledger, commit: null, appendedRecords: [], replayed: false, changed: false };
    }
    const result = appendMemoryLedgerTransaction(ledger, transaction);
    this.ledgers.set(chatId, result.ledger);
    return { ...result, changed: !result.replayed };
  }
}
