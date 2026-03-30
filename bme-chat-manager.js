import { BmeDatabase } from "./bme-db.js";

function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

export class BmeChatManager {
  constructor(options = {}) {
    this.options = options;
    this._currentChatId = "";
    this._dbByChatId = new Map();

    this._databaseFactory =
      typeof options.databaseFactory === "function"
        ? options.databaseFactory
        : (chatId) => new BmeDatabase(chatId, options.databaseOptions || {});
  }

  async switchChat(chatId) {
    const normalizedChatId = normalizeChatId(chatId);

    if (!normalizedChatId) {
      await this.closeCurrent();
      this._currentChatId = "";
      return null;
    }

    this._currentChatId = normalizedChatId;
    return await this.getCurrentDb(normalizedChatId);
  }

  async getCurrentDb(chatId = this._currentChatId) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
      return null;
    }

    if (this._currentChatId !== normalizedChatId) {
      this._currentChatId = normalizedChatId;
    }

    let db = this._dbByChatId.get(normalizedChatId);
    if (!db) {
      db = this._databaseFactory(normalizedChatId);
      if (!db || typeof db.open !== "function") {
        throw new Error("BmeChatManager: databaseFactory 必须返回可 open() 的实例");
      }
      this._dbByChatId.set(normalizedChatId, db);
    }

    await db.open();
    return db;
  }

  getCurrentChatId() {
    return this._currentChatId;
  }

  async closeCurrent() {
    const chatId = this._currentChatId;
    if (!chatId) {
      return;
    }

    const db = this._dbByChatId.get(chatId);
    if (db && typeof db.close === "function") {
      await db.close();
    }

    this._dbByChatId.delete(chatId);
    this._currentChatId = "";
  }

  async closeAll() {
    const dbInstances = Array.from(this._dbByChatId.values());

    for (const db of dbInstances) {
      if (!db || typeof db.close !== "function") continue;
      try {
        await db.close();
      } catch (error) {
        console.warn("[ST-BME] 关闭 BME chat 数据库失败:", error);
      }
    }

    this._dbByChatId.clear();
    this._currentChatId = "";
  }
}
