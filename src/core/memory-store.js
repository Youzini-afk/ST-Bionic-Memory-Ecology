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

export {
  HistoryBasisConflictError,
  RevisionConflictError,
} from "./state-model.js";

function createConversation(chatKey) {
  return {
    head: createConversationHead(chatKey),
    collections: createGraphCollections(),
    transactions: [],
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
    const { changeSet, transaction, nextHead } = prepareCommit(current.head, command, {
      now: this.#now,
      id: this.#id,
    });
    if (current.transactions.some(({ id }) => id === transaction.id)) {
      throw new TypeError(`duplicate transaction id ${transaction.id}`);
    }

    const draft = clone(current);
    applyChangeSet(draft.collections, changeSet, "forward");
    draft.transactions.push(transaction);
    draft.head = nextHead;
    this.#states.set(chatKey, draft);
    return { head: clone(nextHead), transaction: clone(transaction) };
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
    draft.head = plan.nextHead;
    this.#states.set(chatKey, draft);
    return {
      changed: true,
      commonPrefixLength: plan.commonPrefixLength,
      rolledBackTransactions: clone(plan.rolledBackTransactions),
      head: clone(plan.nextHead),
    };
  }
}
