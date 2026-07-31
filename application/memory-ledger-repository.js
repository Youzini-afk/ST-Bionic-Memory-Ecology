import { MemoryLedgerStoreAdapter } from "../storage/memory-ledger-store.js";
import { ChatTransactionCoordinator } from "./chat-transaction-coordinator.js";

export class MemoryLedgerRepository {
  constructor({ conversationRepository, coordinator = new ChatTransactionCoordinator() } = {}) {
    if (!conversationRepository) {
      throw new TypeError("MemoryLedgerRepository requires conversationRepository");
    }
    this.conversationRepository = conversationRepository;
    this.coordinator = coordinator;
    this._adapters = new Map();
  }

  async _resolveAdapter(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throw new TypeError("memory ledger repository requires chatId");
    const store = this.conversationRepository.getStoreForChat
      ? await this.conversationRepository.getStoreForChat(normalizedChatId)
      : await this.conversationRepository.getStore(normalizedChatId);
    const current = this._adapters.get(normalizedChatId);
    if (current?.store === store) return current;
    const adapter = new MemoryLedgerStoreAdapter({ chatId: normalizedChatId, store });
    this._adapters.set(normalizedChatId, adapter);
    return adapter;
  }

  async load(chatId, options = {}) {
    return await this.coordinator.run(chatId, async () => {
      const adapter = await this._resolveAdapter(chatId);
      return await adapter.load(options);
    });
  }

  async transact(chatId, transactionOrFactory, options = {}) {
    return await this.coordinator.run(chatId, async () => {
      const adapter = await this._resolveAdapter(chatId);
      return await adapter.transact(transactionOrFactory, options);
    });
  }

  inspect(chatId) {
    return {
      ...this.coordinator.getStatus(chatId),
      cache: this._adapters.get(String(chatId || "").trim())?.inspectCache() || null,
    };
  }
}
