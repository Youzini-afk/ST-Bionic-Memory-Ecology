import {
  applyChangeSet,
  createGraphCollections,
} from "./change-set.js";
import {
  createConversationHead,
  prepareCommit,
  prepareHistoryReconciliation,
  requireChatKey,
} from "./state-model.js";
import {
  isRecallBoundToHistory,
  prepareRecallCreate,
} from "./recall-record.js";

export {
  HistoryBasisConflictError,
  RevisionConflictError,
} from "./state-model.js";

function createConversation(chatKey) {
  return {
    head: createConversationHead(chatKey),
    collections: createGraphCollections(),
    transactions: [],
    recallRecords: new Map(),
    vectorJobs: new Map(),
  };
}

function clone(value) {
  return structuredClone(value);
}

export class MemoryStateStore {
  #states = new Map();
  #now;
  #id;

  constructor({ now = Date.now, id = () => crypto.randomUUID() } = {}) {
    this.#now = now;
    this.#id = id;
  }

  async readConversation(chatKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    return clone(this.#states.get(chatKey) || createConversation(chatKey));
  }

  async commit(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    const { changeSet, transaction, nextHead, vectorJob } = prepareCommit(current.head, command, {
      now: this.#now,
      id: this.#id,
    });
    if (current.transactions.some(({ id }) => id === transaction.id)) {
      throw new TypeError(`duplicate transaction id ${transaction.id}`);
    }

    const draft = clone(current);
    applyChangeSet(draft.collections, changeSet, "forward");
    draft.transactions.push(transaction);
    if (vectorJob) draft.vectorJobs.set(vectorJob.id, vectorJob);
    draft.head = nextHead;
    this.#states.set(chatKey, draft);
    return {
      head: clone(nextHead),
      transaction: clone(transaction),
      vectorJob: vectorJob ? clone(vectorJob) : null,
    };
  }

  async readRecall(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    const turnKey = String(turnKeyInput || "").trim();
    if (!turnKey) throw new TypeError("turnKey is required");
    const record = this.#states.get(chatKey)?.recallRecords.get(turnKey) || null;
    return record ? clone(record) : null;
  }

  async createRecall(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    const turnKey = String(command.record?.turnKey || "").trim();
    const plan = prepareRecallCreate(
      current.head,
      current.recallRecords.get(turnKey) || null,
      command,
      { now: this.#now },
    );
    if (!plan.created) {
      return { created: false, head: clone(plan.nextHead), record: clone(plan.record) };
    }
    const draft = clone(current);
    draft.recallRecords.set(plan.record.turnKey, plan.record);
    draft.head = plan.nextHead;
    this.#states.set(chatKey, draft);
    return { created: true, head: clone(plan.nextHead), record: clone(plan.record) };
  }

  async reconcileHistory(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    const plan = prepareHistoryReconciliation(current.head, current.transactions, command, {
      now: this.#now,
    });
    if (!plan.changed) {
      return {
        changed: false,
        commonPrefixLength: plan.commonPrefixLength,
        rolledBackTransactions: [],
        head: clone(plan.nextHead),
      };
    }

    const draft = clone(current);
    for (let index = plan.rolledBackTransactions.length - 1; index >= 0; index -= 1) {
      applyChangeSet(draft.collections, plan.rolledBackTransactions[index], "rollback");
    }
    draft.transactions = plan.remainingTransactions;
    for (const [turnKey, record] of draft.recallRecords) {
      if (!isRecallBoundToHistory(record, plan.history)) draft.recallRecords.delete(turnKey);
    }
    if (plan.vectorJob) draft.vectorJobs.set(plan.vectorJob.id, plan.vectorJob);
    draft.head = plan.nextHead;
    this.#states.set(chatKey, draft);
    return {
      changed: true,
      commonPrefixLength: plan.commonPrefixLength,
      rolledBackTransactions: clone(plan.rolledBackTransactions),
      head: clone(plan.nextHead),
      vectorJob: plan.vectorJob ? clone(plan.vectorJob) : null,
    };
  }

  async listVectorJobs(chatKeyInput, { status = "pending" } = {}) {
    const chatKey = requireChatKey(chatKeyInput);
    const expectedStatus = String(status || "").trim();
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    return [...current.vectorJobs.values()]
      .filter((job) => !expectedStatus || job.status === expectedStatus)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(clone);
  }

  async settleVectorJobs(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const ids = [...new Set((Array.isArray(command.ids) ? command.ids : [])
      .map((id) => String(id || "").trim()).filter(Boolean))];
    if (ids.length === 0) throw new TypeError("vector job ids are required");
    const status = String(command.status || "completed").trim();
    if (status !== "completed" && status !== "pending") {
      throw new TypeError("vector job status must be completed or pending");
    }
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    const draft = clone(current);
    const updatedAt = Number(this.#now());
    for (const id of ids) {
      const job = draft.vectorJobs.get(id);
      if (!job || job.chatKey !== chatKey) throw new TypeError(`unknown vector job ${id}`);
      job.status = status;
      job.outcome = String(command.outcome || (status === "completed" ? "synced" : "retry"));
      job.lastError = String(command.error || "");
      job.attempts = Math.max(0, Number(job.attempts) || 0) + 1;
      job.updatedAt = updatedAt;
      job.completedAt = status === "completed" ? updatedAt : null;
    }
    this.#states.set(chatKey, draft);
    return ids.map((id) => clone(draft.vectorJobs.get(id)));
  }
}
