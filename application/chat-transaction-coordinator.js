export class ChatTransactionCoordinator {
  constructor() {
    this._tails = new Map();
    this._pendingCounts = new Map();
  }

  run(chatId, task) {
    const key = String(chatId || "").trim();
    if (!key) throw new TypeError("chat transaction requires chatId");
    if (typeof task !== "function") throw new TypeError("chat transaction requires task");
    const previous = this._tails.get(key) || Promise.resolve();
    this._pendingCounts.set(key, (this._pendingCounts.get(key) || 0) + 1);
    const current = previous.then(() => task());
    let settled = null;
    settled = current.catch(() => undefined).finally(() => {
      const remaining = Math.max(0, (this._pendingCounts.get(key) || 1) - 1);
      if (remaining > 0) this._pendingCounts.set(key, remaining);
      else this._pendingCounts.delete(key);
      if (this._tails.get(key) === settled) this._tails.delete(key);
    });
    this._tails.set(key, settled);
    return current;
  }

  getStatus(chatId) {
    const key = String(chatId || "").trim();
    return {
      chatId: key,
      busy: this._tails.has(key),
      pending: this._pendingCounts.get(key) || 0,
    };
  }

  async waitForIdle(chatId) {
    const key = String(chatId || "").trim();
    while (this._tails.has(key)) {
      const tail = this._tails.get(key);
      await tail.catch(() => undefined);
      if (this._tails.get(key) === tail) break;
    }
  }
}
