import {
  normalizeBmeChatStateTarget,
  serializeBmeChatStateTarget,
} from "./runtime-host-adapter.js";

export const LUKER_MEMORY_LEDGER_NAMESPACE = "st_bme_memory_ledger_v1";
export const LUKER_MEMORY_LEDGER_FORMAT_VERSION = 1;

const writeTailByTarget = new Map();

function clone(value, fallback = null) {
  if (value === undefined) return fallback;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON for host-provided plain state.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function conflict(message, details = {}) {
  const error = new Error(message);
  error.code = "transaction_conflict";
  error.details = details;
  return error;
}

function unavailable(message, details = {}) {
  const error = new Error(message);
  error.code = "luker_memory_ledger_unavailable";
  error.details = details;
  return error;
}

function normalizePayload(value, chatId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      formatVersion: LUKER_MEMORY_LEDGER_FORMAT_VERSION,
      chatId,
      revision: 0,
      meta: { chatId, revision: 0 },
      updatedAt: 0,
      reason: "",
      idempotencyKey: "",
    };
  }
  const storedChatId = String(value.chatId || value.meta?.chatId || "").trim();
  if (storedChatId && storedChatId !== chatId) {
    throw unavailable("Luker memory ledger belongs to another chat", {
      expectedChatId: chatId,
      actualChatId: storedChatId,
    });
  }
  const revision = Math.max(0, Math.floor(Number(value.revision ?? value.meta?.revision) || 0));
  return {
    formatVersion: LUKER_MEMORY_LEDGER_FORMAT_VERSION,
    chatId,
    revision,
    meta: {
      ...(value.meta && typeof value.meta === "object" && !Array.isArray(value.meta)
        ? clone(value.meta, {})
        : {}),
      chatId,
      revision,
    },
    updatedAt: Number(value.updatedAt || 0),
    reason: String(value.reason || ""),
    idempotencyKey: String(value.idempotencyKey || ""),
  };
}

async function queueTargetWrite(targetKey, task) {
  const previous = writeTailByTarget.get(targetKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  writeTailByTarget.set(targetKey, current);
  try {
    return await current;
  } finally {
    if (writeTailByTarget.get(targetKey) === current) writeTailByTarget.delete(targetKey);
  }
}

export class LukerMemoryLedgerStore {
  constructor({ chatId, hostAdapter, target, namespace = LUKER_MEMORY_LEDGER_NAMESPACE } = {}) {
    this.chatId = String(chatId || "").trim();
    this.hostAdapter = hostAdapter;
    this.target = normalizeBmeChatStateTarget(target);
    this.targetKey = serializeBmeChatStateTarget(this.target);
    this.namespace = String(namespace || LUKER_MEMORY_LEDGER_NAMESPACE).trim();
    this.storeKind = "luker-chat-state";
    this.storeMode = "luker-memory-ledger-primary";
    if (!this.chatId) throw new TypeError("LukerMemoryLedgerStore requires chatId");
    if (!this.target || !this.targetKey) {
      throw unavailable("Luker memory ledger requires a stable chat-state target");
    }
    if (
      !hostAdapter ||
      typeof hostAdapter.readChatState !== "function" ||
      typeof hostAdapter.updateChatState !== "function"
    ) {
      throw unavailable("Luker chat-state API is unavailable");
    }
  }

  async open() {
    await this._read();
    return this;
  }

  async close() {}

  async _read() {
    try {
      const value = await this.hostAdapter.readChatState(this.namespace, {
        target: this.target,
      });
      return normalizePayload(value, this.chatId);
    } catch (error) {
      if (error?.code === "luker_memory_ledger_unavailable") throw error;
      throw unavailable("Failed to read the Luker memory ledger", {
        target: this.targetKey,
        cause: error?.message || String(error),
      });
    }
  }

  async exportSnapshot() {
    const payload = await this._read();
    return {
      schemaVersion: LUKER_MEMORY_LEDGER_FORMAT_VERSION,
      meta: clone(payload.meta, { chatId: this.chatId, revision: payload.revision }),
      nodes: [],
      edges: [],
      tombstones: [],
      state: {},
    };
  }

  async getRevision() {
    return (await this._read()).revision;
  }

  async getMeta(key, fallback = null) {
    const payload = await this._read();
    return Object.hasOwn(payload.meta, key) ? clone(payload.meta[key], payload.meta[key]) : fallback;
  }

  async commitDelta(
    { runtimeMetaPatch = {} } = {},
    { baseRevision, reason = "memory-ledger-commit", idempotencyKey = "" } = {},
  ) {
    const expectedRevision = Number(baseRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("Luker memory ledger commit requires baseRevision");
    }
    const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
    return await queueTargetWrite(this.targetKey, async () => {
      let committed = null;
      let updaterError = null;
      let response;
      try {
        response = await this.hostAdapter.updateChatState(
          this.namespace,
          (currentValue) => {
            try {
              const current = normalizePayload(currentValue, this.chatId);
              if (
                normalizedIdempotencyKey &&
                current.idempotencyKey === normalizedIdempotencyKey
              ) {
                committed = current;
                return current;
              }
              if (current.revision !== expectedRevision) {
                throw conflict("Luker memory ledger base revision changed", {
                  expectedRevision,
                  actualRevision: current.revision,
                });
              }
              const revision = current.revision + 1;
              committed = {
                ...current,
                revision,
                meta: {
                  ...current.meta,
                  ...clone(runtimeMetaPatch, {}),
                  chatId: this.chatId,
                  revision,
                },
                updatedAt: Date.now(),
                reason: String(reason || "memory-ledger-commit"),
                idempotencyKey: normalizedIdempotencyKey,
              };
              return committed;
            } catch (error) {
              updaterError = error;
              throw error;
            }
          },
          {
            target: this.target,
            maxRetries: 1,
            asyncDiff: false,
          },
        );
      } catch (error) {
        throw updaterError || error;
      }
      if (updaterError) throw updaterError;
      if (response?.ok === false || response?.updated === false && !committed) {
        throw unavailable("Luker rejected the memory ledger update", {
          target: this.targetKey,
          error: response?.error || response?.reason || "update rejected",
        });
      }
      const result = normalizePayload(response?.state || committed, this.chatId);
      if (result.revision < expectedRevision + 1 && result.idempotencyKey !== normalizedIdempotencyKey) {
        throw unavailable("Luker memory ledger update was not durably acknowledged", {
          target: this.targetKey,
          expectedRevision: expectedRevision + 1,
          actualRevision: result.revision,
        });
      }
      return {
        revision: result.revision,
        idempotent: result.revision === expectedRevision,
        chatId: this.chatId,
        target: clone(this.target, this.target),
      };
    });
  }
}
