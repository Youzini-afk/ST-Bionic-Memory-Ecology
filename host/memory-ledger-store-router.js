import { LukerMemoryLedgerStore } from "./luker-memory-ledger-store.js";
import {
  normalizeBmeChatStateTarget,
  serializeBmeChatStateTarget,
} from "./runtime-host-adapter.js";

export class MemoryLedgerStoreRouter {
  constructor({ localConversationRepository, resolveHostBinding } = {}) {
    if (
      !localConversationRepository ||
      typeof localConversationRepository.getStoreForChat !== "function"
    ) {
      throw new TypeError("MemoryLedgerStoreRouter requires a local conversation repository");
    }
    if (typeof resolveHostBinding !== "function") {
      throw new TypeError("MemoryLedgerStoreRouter requires resolveHostBinding");
    }
    this.localConversationRepository = localConversationRepository;
    this.resolveHostBinding = resolveHostBinding;
    this._explicitBindings = new Map();
    this._lukerStores = new Map();
  }

  registerHostBinding(chatId, binding) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throw new TypeError("host binding requires chatId");
    const value = binding && typeof binding === "object"
      ? {
          ...binding,
          chatId: normalizedChatId,
          target: normalizeBmeChatStateTarget(binding.target),
        }
      : null;
    this._explicitBindings.set(normalizedChatId, value);
  }

  async getStoreForChat(chatId) {
    const normalizedChatId = String(chatId || "").trim();
    if (!normalizedChatId) throw new TypeError("memory ledger store requires chatId");
    const hasExplicitBinding = this._explicitBindings.has(normalizedChatId);
    const binding = hasExplicitBinding
      ? this._explicitBindings.get(normalizedChatId)
      : await this.resolveHostBinding(normalizedChatId);
    if (binding?.hostProfile !== "luker") {
      return await this.localConversationRepository.getStoreForChat(normalizedChatId);
    }
    // A Luker target is mutable global host state. It must be frozen while the
    // conversation is captured; resolving it later could bind chat A's ledger
    // to chat B after a fast chat switch.
    if (!hasExplicitBinding) {
      const error = new Error("Luker memory ledger requires a captured host binding");
      error.code = "luker_memory_ledger_unavailable";
      throw error;
    }
    const targetKey = serializeBmeChatStateTarget(binding.target);
    if (!targetKey || !binding.hostAdapter) {
      const error = new Error("Luker memory ledger target is unavailable");
      error.code = "luker_memory_ledger_unavailable";
      throw error;
    }
    const cacheKey = `${normalizedChatId}::${targetKey}`;
    let store = this._lukerStores.get(cacheKey);
    if (!store) {
      store = new LukerMemoryLedgerStore({
        chatId: normalizedChatId,
        hostAdapter: binding.hostAdapter,
        target: binding.target,
      });
      await store.open();
      this._lukerStores.set(cacheKey, store);
    }
    return store;
  }

  async getStore(chatId) {
    return await this.getStoreForChat(chatId);
  }

  async closeAll() {
    const stores = [...this._lukerStores.values()];
    this._lukerStores.clear();
    this._explicitBindings.clear();
    await Promise.allSettled(stores.map((store) => store.close?.()));
  }
}
