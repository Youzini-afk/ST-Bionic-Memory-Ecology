import {
  applyChangeSet,
  createGraphCollections,
  normalizeChangeSet,
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
import {
  isPlannerBoundToHistory,
  preparePlannerCreate,
} from "./planner-record.js";
import { assertTurnKeyBinding } from "./history.js";

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
    plannerRecords: new Map(),
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

  async readPlanner(chatKeyInput, turnKeyInput) {
    const chatKey = requireChatKey(chatKeyInput);
    const turnKey = String(turnKeyInput || "").trim();
    if (!turnKey) throw new TypeError("turnKey is required");
    const record = this.#states.get(chatKey)?.plannerRecords.get(turnKey) || null;
    return record ? clone(record) : null;
  }

  async createTurnRecords(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    if (!command.plannerRecord && !command.recallRecord) {
      throw new TypeError("plannerRecord or recallRecord is required");
    }
    if (
      command.plannerRecord &&
      command.recallRecord &&
      String(command.plannerRecord.turnKey || "").trim() !==
        String(command.recallRecord.turnKey || "").trim()
    ) {
      throw new TypeError("plannerRecord and recallRecord must identify the same turn");
    }
    if (command.plannerRecord) {
      await assertTurnKeyBinding(
        chatKey,
        command.plannerRecord.historyPrefixHash,
        command.plannerRecord.turnKey,
      );
    }
    if (command.recallRecord) {
      await assertTurnKeyBinding(
        chatKey,
        command.recallRecord.historyPrefixHash,
        command.recallRecord.turnKey,
      );
    }

    const current = this.#states.get(chatKey) || createConversation(chatKey);
    const draft = clone(current);
    const recallTurnKey = String(command.recallRecord?.turnKey || "").trim();
    const existingRecall = recallTurnKey
      ? current.recallRecords.get(recallTurnKey) || null
      : null;
    const requestedChanges = normalizeChangeSet(command.changeSet || { changes: [] });
    if (requestedChanges.changes.length > 0 && !command.recallRecord) {
      throw new TypeError("recallRecord is required for recall access changes");
    }

    let nextHead = current.head;
    let expectedRevision = command.expectedRevision;
    let transaction = null;
    if (!existingRecall && requestedChanges.changes.length > 0) {
      const plan = prepareCommit(nextHead, {
        chatKey,
        expectedRevision,
        operation: "recall-access",
        basisHistoryLength: command.basisHistoryLength,
        basisHistoryHash: command.basisHistoryHash,
        processedThroughAfter: nextHead.processedThrough,
        changeSet: requestedChanges,
        enqueueVectorJob: false,
      }, { now: this.#now, id: this.#id });
      if (current.transactions.some(({ id }) => id === plan.transaction.id)) {
        throw new TypeError(`duplicate transaction id ${plan.transaction.id}`);
      }
      applyChangeSet(draft.collections, plan.changeSet, "forward");
      draft.transactions.push(plan.transaction);
      transaction = plan.transaction;
      nextHead = plan.nextHead;
      expectedRevision = nextHead.revision;
    }
    let planner = null;
    let recall = null;
    if (command.plannerRecord) {
      const turnKey = String(command.plannerRecord.turnKey || "").trim();
      planner = preparePlannerCreate(
        nextHead,
        current.plannerRecords.get(turnKey) || null,
        {
          chatKey,
          expectedRevision,
          record: command.plannerRecord,
        },
        { now: this.#now },
      );
      nextHead = planner.nextHead;
      expectedRevision = nextHead.revision;
    }
    if (command.recallRecord) {
      const turnKey = String(command.recallRecord.turnKey || "").trim();
      recall = prepareRecallCreate(
        nextHead,
        current.recallRecords.get(turnKey) || null,
        {
          chatKey,
          expectedRevision,
          record: command.recallRecord,
        },
        { now: this.#now },
      );
      nextHead = recall.nextHead;
    }

    if (transaction || planner?.created || recall?.created) {
      if (planner?.created) draft.plannerRecords.set(planner.record.turnKey, planner.record);
      if (recall?.created) draft.recallRecords.set(recall.record.turnKey, recall.record);
      draft.head = nextHead;
      this.#states.set(chatKey, draft);
    }
    return {
      head: clone(nextHead),
      transaction: transaction ? clone(transaction) : null,
      planner: planner
        ? { created: planner.created, record: clone(planner.record) }
        : null,
      recall: recall
        ? { created: recall.created, record: clone(recall.record) }
        : null,
    };
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
    for (const [turnKey, record] of draft.plannerRecords) {
      if (!isPlannerBoundToHistory(record, plan.history)) draft.plannerRecords.delete(turnKey);
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
