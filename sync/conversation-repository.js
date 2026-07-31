function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

function normalizeBinding(presentation, bindingKey) {
  const key = String(bindingKey(presentation) ?? "").trim();
  if (!key) throw new Error("ConversationRepository: binding key 不能为空");
  return Object.freeze({ key, presentation });
}

export class ConversationRepository {
  constructor({ resolveBinding, bindingKey, storeFactory } = {}) {
    if (
      typeof resolveBinding !== "function" ||
      typeof bindingKey !== "function" ||
      typeof storeFactory !== "function"
    ) {
      throw new TypeError(
        "ConversationRepository requires resolveBinding, bindingKey and storeFactory",
      );
    }
    this._resolveBinding = resolveBinding;
    this._bindingKey = bindingKey;
    this._storeFactory = storeFactory;
    this._currentChatId = "";
    this._entries = new Map();
  }

  async _createEntry(chatId, binding = null) {
    const normalizedBinding = normalizeBinding(
      binding ?? (await this._resolveBinding(chatId)),
      this._bindingKey,
    );
    const store = await this._storeFactory(chatId, normalizedBinding);
    if (!store || typeof store.open !== "function") {
      throw new Error("ConversationRepository: storeFactory 必须返回可 open() 的实例");
    }
    await store.open();
    return { binding: normalizedBinding, store };
  }

  async getStoreForChat(chatId, { binding = null } = {}) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return null;

    let entry = this._entries.get(normalizedChatId);
    if (!entry) {
      entry = {
        ready: this._createEntry(normalizedChatId, binding),
      };
      this._entries.set(normalizedChatId, entry);
    }

    try {
      const resolved = await entry.ready;
      entry.binding = resolved.binding;
      entry.store = resolved.store;
      return resolved.store;
    } catch (error) {
      if (this._entries.get(normalizedChatId) === entry) {
        this._entries.delete(normalizedChatId);
      }
      throw error;
    }
  }

  async getStore(chatId = this._currentChatId, { binding = null } = {}) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return null;
    this._currentChatId = normalizedChatId;
    return await this.getStoreForChat(normalizedChatId, { binding });
  }

  async switchChat(chatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      await this.closeCurrent();
      return null;
    }
    this._currentChatId = normalizedChatId;
    return await this.getStoreForChat(normalizedChatId);
  }

  async rebind(chatId = this._currentChatId, binding = null) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return null;
    const nextPresentation =
      binding ?? (await this._resolveBinding(normalizedChatId));
    const existing = this._entries.get(normalizedChatId);
    if (existing) {
      const resolved = await existing.ready;
      await resolved.store?.close?.();
      this._entries.delete(normalizedChatId);
    }
    return await this.getStore(normalizedChatId, {
      binding: nextPresentation,
    });
  }

  getBinding(chatId = this._currentChatId) {
    return this._entries.get(normalizeChatId(chatId))?.binding || null;
  }

  getCurrentChatId() {
    return this._currentChatId;
  }

  async closeCurrent() {
    const chatId = this._currentChatId;
    if (!chatId) return;
    const entry = this._entries.get(chatId);
    this._entries.delete(chatId);
    this._currentChatId = "";
    if (!entry) return;
    try {
      const { store } = await entry.ready;
      await store?.close?.();
    } catch {
      // A store that failed to open has nothing durable to close.
    }
  }

  async closeAll() {
    const entries = [...this._entries.values()];
    this._entries.clear();
    this._currentChatId = "";
    for (const entry of entries) {
      try {
        const { store } = await entry.ready;
        await store?.close?.();
      } catch (error) {
        console.warn("[ST-BME] 关闭会话存储失败:", error);
      }
    }
  }
}
