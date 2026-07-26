import {
  applyChangeSet,
  createGraphCollections,
  normalizeChangeSet,
} from "./change-set.js";
import {
  findCommonPrefixLength,
  historyBasisMatches,
  toHistoryIdentity,
} from "./history.js";

export class RevisionConflictError extends Error {
  constructor(chatKey, expectedRevision, actualRevision) {
    super(`revision conflict for ${chatKey}: expected ${expectedRevision}, got ${actualRevision}`);
    this.name = "RevisionConflictError";
    this.chatKey = chatKey;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function requireChatKey(value) {
  const chatKey = String(value || "").trim();
  if (!chatKey) throw new TypeError("chatKey is required");
  return chatKey;
}

function requireRevision(value, label = "revision") {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return revision;
}

function createConversation(chatKey) {
  return {
    head: {
      chatKey,
      revision: 0,
      graphRevision: 0,
      processedThrough: -1,
      history: [],
      updatedAt: 0,
    },
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
    const expectedRevision = requireRevision(command.expectedRevision, "expectedRevision");
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    if (current.head.revision !== expectedRevision) {
      throw new RevisionConflictError(chatKey, expectedRevision, current.head.revision);
    }

    const basisHistoryLength = requireRevision(
      command.basisHistoryLength,
      "basisHistoryLength",
    );
    const basisHistoryHash = String(command.basisHistoryHash || "");
    if (!historyBasisMatches(current.head.history, basisHistoryLength, basisHistoryHash)) {
      throw new RevisionConflictError(chatKey, expectedRevision, current.head.revision);
    }

    const operation = String(command.operation || "").trim();
    if (!operation) throw new TypeError("operation is required");
    const processedThroughBefore = current.head.processedThrough;
    const processedThroughAfter = Number.isInteger(command.processedThroughAfter)
      ? command.processedThroughAfter
      : processedThroughBefore;
    if (processedThroughAfter < -1 || processedThroughAfter >= current.head.history.length) {
      throw new RangeError("processedThroughAfter is outside current history");
    }

    const changeSet = normalizeChangeSet(command.changeSet || { changes: [] });
    if (changeSet.changes.length === 0 && processedThroughAfter === processedThroughBefore) {
      throw new TypeError("commit must change graph state or processedThrough");
    }

    const draft = clone(current);
    applyChangeSet(draft.collections, changeSet, "forward");
    const committedRevision = expectedRevision + 1;
    const transaction = {
      id: String(command.id || this.#id()),
      chatKey,
      baseRevision: expectedRevision,
      committedRevision,
      operation,
      basisHistoryLength,
      basisHistoryHash,
      processedThroughBefore,
      processedThroughAfter,
      changes: changeSet.changes,
      createdAt: Number(this.#now()),
    };
    draft.transactions.push(transaction);
    draft.head.revision = committedRevision;
    if (changeSet.changes.length > 0) draft.head.graphRevision += 1;
    draft.head.processedThrough = processedThroughAfter;
    draft.head.updatedAt = Number(this.#now());
    this.#states.set(chatKey, draft);
    return { state: clone(draft), transaction: clone(transaction) };
  }

  async reconcileHistory(command = {}) {
    const chatKey = requireChatKey(command.chatKey);
    const expectedRevision = requireRevision(command.expectedRevision, "expectedRevision");
    const history = toHistoryIdentity(command.history || []);
    const current = this.#states.get(chatKey) || createConversation(chatKey);
    if (current.head.revision !== expectedRevision) {
      throw new RevisionConflictError(chatKey, expectedRevision, current.head.revision);
    }

    const commonPrefixLength = findCommonPrefixLength(current.head.history, history);
    const historyChanged =
      commonPrefixLength !== current.head.history.length ||
      commonPrefixLength !== history.length;
    const firstInvalidIndex = current.transactions.findIndex(
      (transaction) =>
        !historyBasisMatches(
          history,
          transaction.basisHistoryLength,
          transaction.basisHistoryHash,
        ),
    );
    if (!historyChanged && firstInvalidIndex < 0) {
      return {
        changed: false,
        commonPrefixLength,
        rolledBackTransactions: [],
        state: clone(current),
      };
    }

    const draft = clone(current);
    const rolledBackTransactions =
      firstInvalidIndex < 0 ? [] : draft.transactions.slice(firstInvalidIndex);
    for (let index = rolledBackTransactions.length - 1; index >= 0; index -= 1) {
      applyChangeSet(draft.collections, rolledBackTransactions[index], "rollback");
    }
    if (firstInvalidIndex >= 0) {
      draft.transactions = draft.transactions.slice(0, firstInvalidIndex);
      draft.head.processedThrough = rolledBackTransactions[0].processedThroughBefore;
    }

    draft.head.history = history;
    draft.head.processedThrough = Math.min(
      draft.head.processedThrough,
      history.length - 1,
    );
    draft.head.revision += 1;
    if (rolledBackTransactions.some((transaction) => transaction.changes.length > 0)) {
      draft.head.graphRevision += 1;
    }
    draft.head.updatedAt = Number(this.#now());
    this.#states.set(chatKey, draft);
    return {
      changed: true,
      commonPrefixLength,
      rolledBackTransactions: clone(rolledBackTransactions),
      state: clone(draft),
    };
  }
}
