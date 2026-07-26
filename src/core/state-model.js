import { normalizeChangeSet } from "./change-set.js";
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

export class HistoryBasisConflictError extends Error {
  constructor(chatKey, historyLength, historyHash) {
    super(`history basis conflict for ${chatKey} at prefix ${historyLength}`);
    this.name = "HistoryBasisConflictError";
    this.chatKey = chatKey;
    this.historyLength = historyLength;
    this.historyHash = historyHash;
  }
}

export function requireChatKey(value) {
  const chatKey = String(value || "").trim();
  if (!chatKey) throw new TypeError("chatKey is required");
  return chatKey;
}

export function requireRevision(value, label = "revision") {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return revision;
}

export function createConversationHead(chatKeyInput) {
  const chatKey = requireChatKey(chatKeyInput);
  return {
    chatKey,
    revision: 0,
    graphRevision: 0,
    processedThrough: -1,
    vectorModelScope: "",
    history: [],
    updatedAt: 0,
  };
}

function timestamp(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new TypeError("clock must return a finite number");
  return value;
}

export function prepareCommit(head, command = {}, { now = Date.now, id = () => crypto.randomUUID() } = {}) {
  const chatKey = requireChatKey(command.chatKey);
  if (head.chatKey !== chatKey) throw new TypeError("conversation head does not match chatKey");

  const expectedRevision = requireRevision(command.expectedRevision, "expectedRevision");
  if (head.revision !== expectedRevision) {
    throw new RevisionConflictError(chatKey, expectedRevision, head.revision);
  }

  const basisHistoryLength = requireRevision(command.basisHistoryLength, "basisHistoryLength");
  const basisHistoryHash = String(command.basisHistoryHash || "");
  if (!historyBasisMatches(head.history, basisHistoryLength, basisHistoryHash)) {
    throw new HistoryBasisConflictError(chatKey, basisHistoryLength, basisHistoryHash);
  }

  const operation = String(command.operation || "").trim();
  if (!operation) throw new TypeError("operation is required");
  const processedThroughBefore = head.processedThrough;
  const processedThroughAfter = Number.isInteger(command.processedThroughAfter)
    ? command.processedThroughAfter
    : processedThroughBefore;
  if (processedThroughAfter < -1 || processedThroughAfter >= head.history.length) {
    throw new RangeError("processedThroughAfter is outside current history");
  }

  const changeSet = normalizeChangeSet(command.changeSet || { changes: [] });
  const forceVectorJob = command.forceVectorJob === true;
  if (
    changeSet.changes.length === 0 &&
    processedThroughAfter === processedThroughBefore &&
    !forceVectorJob
  ) {
    throw new TypeError("commit must change graph state or processedThrough");
  }

  const transactionId = String(command.id || id()).trim();
  if (!transactionId) throw new TypeError("transaction id is required");
  const committedRevision = expectedRevision + 1;
  const createdAt = timestamp(now);
  const vectorModelScope = Object.hasOwn(command, "vectorModelScope")
    ? String(command.vectorModelScope || "").trim()
    : String(head.vectorModelScope || "").trim();
  const vectorAffected = command.enqueueVectorJob === true && (
    forceVectorJob || changeSet.changes.some(
      ({ collection }) => collection === "nodes" || collection === "edges",
    )
  );
  if (vectorAffected && !vectorModelScope) {
    throw new TypeError("vectorModelScope is required for vector jobs");
  }
  const transaction = {
    id: transactionId,
    chatKey,
    baseRevision: expectedRevision,
    committedRevision,
    operation,
    basisHistoryLength,
    basisHistoryHash,
    processedThroughBefore,
    processedThroughAfter,
    vectorAffected,
    vectorModelScope,
    changes: changeSet.changes,
    createdAt,
  };
  const nextHead = {
    ...structuredClone(head),
    revision: committedRevision,
    graphRevision: head.graphRevision + (changeSet.changes.length > 0 ? 1 : 0),
    processedThrough: processedThroughAfter,
    vectorModelScope,
    updatedAt: createdAt,
  };
  const vectorJob = vectorAffected
    ? {
        id: `${transactionId}:vector`,
        chatKey,
        transactionId,
        committedRevision,
        graphRevision: nextHead.graphRevision,
        modelScope: vectorModelScope,
        reason: operation,
        status: "pending",
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
      }
    : null;
  return { changeSet, transaction, nextHead, vectorJob };
}

export function prepareHistoryReconciliation(
  head,
  transactions,
  command = {},
  { now = Date.now } = {},
) {
  const chatKey = requireChatKey(command.chatKey);
  if (head.chatKey !== chatKey) throw new TypeError("conversation head does not match chatKey");
  const expectedRevision = requireRevision(command.expectedRevision, "expectedRevision");
  if (head.revision !== expectedRevision) {
    throw new RevisionConflictError(chatKey, expectedRevision, head.revision);
  }

  const history = toHistoryIdentity(command.history || []);
  const orderedTransactions = [...transactions].sort(
    (left, right) => left.committedRevision - right.committedRevision,
  );
  const commonPrefixLength = findCommonPrefixLength(head.history, history);
  const historyChanged =
    commonPrefixLength !== head.history.length || commonPrefixLength !== history.length;
  const firstInvalidIndex = orderedTransactions.findIndex(
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
      history,
      rolledBackTransactions: [],
      remainingTransactions: orderedTransactions,
      nextHead: structuredClone(head),
      vectorJob: null,
    };
  }

  const rolledBackTransactions =
    firstInvalidIndex < 0 ? [] : orderedTransactions.slice(firstInvalidIndex);
  const remainingTransactions =
    firstInvalidIndex < 0 ? orderedTransactions : orderedTransactions.slice(0, firstInvalidIndex);
  const processedThrough = rolledBackTransactions.length > 0
    ? rolledBackTransactions[0].processedThroughBefore
    : head.processedThrough;
  const nextHead = {
    ...structuredClone(head),
    history,
    processedThrough: Math.min(processedThrough, history.length - 1),
    revision: head.revision + 1,
    graphRevision:
      head.graphRevision +
      (rolledBackTransactions.some((transaction) => transaction.changes.length > 0) ? 1 : 0),
    updatedAt: timestamp(now),
  };
  const vectorAffected = rolledBackTransactions.some(
    (transaction) => transaction.vectorAffected === true,
  );
  const vectorModelScope = String(nextHead.vectorModelScope || "").trim();
  const vectorJob = vectorAffected && vectorModelScope
    ? {
        id: `rollback:${chatKey}:${nextHead.revision}:vector`,
        chatKey,
        transactionId: "",
        committedRevision: nextHead.revision,
        graphRevision: nextHead.graphRevision,
        modelScope: vectorModelScope,
        reason: "history-rollback",
        status: "pending",
        attempts: 0,
        createdAt: nextHead.updatedAt,
        updatedAt: nextHead.updatedAt,
      }
    : null;
  return {
    changed: true,
    commonPrefixLength,
    history,
    rolledBackTransactions,
    remainingTransactions,
    nextHead,
    vectorJob,
  };
}
