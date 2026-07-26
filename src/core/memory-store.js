import { createConversationState, reduceConversationState } from "./state-reducer.js";
import { requireChatKey } from "./state-model.js";

export {
  HistoryBasisConflictError,
  RevisionConflictError,
} from "./state-model.js";

function clone(value) {
  return structuredClone(value);
}

export class MemoryStateStore {
  #states = new Map();
  #queues = new Map();
  #now;
  #id;

  constructor({ now = Date.now, id = () => crypto.randomUUID() } = {}) {
    this.#now = now;
    this.#id = id;
  }

  async readConversation(chatKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    return clone(this.#states.get(chatKey) || createConversationState(chatKey));
  }

  async commit(command = {}) {
    return await this.#mutate("commit", command);
  }

  async readRecall(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    const turnKey = String(turnKeyInput || "").trim();
    if (!turnKey) throw new TypeError("turnKey is required");
    const record = this.#states.get(chatKey)?.recallRecords.get(turnKey) || null;
    return record ? clone(record) : null;
  }

  async readPlanner(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    const turnKey = String(turnKeyInput || "").trim();
    if (!turnKey) throw new TypeError("turnKey is required");
    const record = this.#states.get(chatKey)?.plannerRecords.get(turnKey) || null;
    return record ? clone(record) : null;
  }

  async createTurnRecords(command = {}) {
    return await this.#mutate("createTurnRecords", command);
  }

  async reconcileHistory(command = {}) {
    return await this.#mutate("reconcileHistory", command);
  }

  async listVectorJobs(chatKeyInput, { status = "pending" } = {}) {
    const chatKey = requireChatKey(chatKeyInput);
    const expectedStatus = String(status || "").trim();
    const current = this.#states.get(chatKey) || createConversationState(chatKey);
    return [...current.vectorJobs.values()]
      .filter((job) => !expectedStatus || job.status === expectedStatus)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(clone);
  }

  async settleVectorJobs(command = {}) {
    return await this.#mutate("settleVectorJobs", command);
  }

  async #mutate(operation, command) {
    const chatKey = requireChatKey(command.chatKey);
    const previous = this.#queues.get(chatKey) || Promise.resolve();
    let release;
    const queued = new Promise((resolve) => { release = resolve; });
    this.#queues.set(chatKey, queued);
    await previous;
    try {
      const current = this.#states.get(chatKey) || createConversationState(chatKey);
      const reduced = await reduceConversationState(current, operation, command, {
        now: this.#now,
        id: this.#id,
      });
      if (reduced.changed) this.#states.set(chatKey, reduced.state);
      return clone(reduced.result);
    } finally {
      release();
      if (this.#queues.get(chatKey) === queued) this.#queues.delete(chatKey);
    }
  }
}
