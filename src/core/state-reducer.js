import {
  applyChangeSet,
  createGraphCollections,
  normalizeChangeSet,
} from "./change-set.js";
import { assertTurnKeyBinding } from "./history.js";
import {
  isPlannerBoundToHistory,
  preparePlannerCreate,
} from "./planner-record.js";
import {
  isRecallBoundToHistory,
  prepareRecallCreate,
} from "./recall-record.js";
import {
  createConversationHead,
  prepareCommit,
  prepareHistoryReconciliation,
  requireChatKey,
} from "./state-model.js";

const clone = (value) => structuredClone(value);

export function createConversationState(chatKey) {
  return {
    head: createConversationHead(chatKey),
    collections: createGraphCollections(),
    transactions: [],
    recallRecords: new Map(),
    plannerRecords: new Map(),
    vectorJobs: new Map(),
  };
}

export async function reduceConversationState(
  current,
  operation,
  command = {},
  { now = Date.now, id = () => crypto.randomUUID() } = {},
) {
  switch (operation) {
    case "commit":
      return reduceCommit(current, command, { now, id });
    case "createTurnRecords":
      return await reduceTurnRecords(current, command, { now, id });
    case "reconcileHistory":
      return reduceHistory(current, command, { now });
    case "settleVectorJobs":
      return reduceVectorJobs(current, command, { now });
    default:
      throw new TypeError(`unknown StateStore operation ${operation}`);
  }
}

function reduceCommit(current, command, deps) {
  const { changeSet, transaction, nextHead, vectorJob } = prepareCommit(
    current.head,
    command,
    deps,
  );
  if (current.transactions.some(({ id }) => id === transaction.id)) {
    throw new TypeError(`duplicate transaction id ${transaction.id}`);
  }

  const state = clone(current);
  applyChangeSet(state.collections, changeSet, "forward");
  state.transactions.push(transaction);
  if (vectorJob) state.vectorJobs.set(vectorJob.id, vectorJob);
  state.head = nextHead;
  return {
    changed: true,
    state,
    result: {
      head: clone(nextHead),
      transaction: clone(transaction),
      vectorJob: vectorJob ? clone(vectorJob) : null,
    },
  };
}

async function reduceTurnRecords(current, command, deps) {
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

  const state = clone(current);
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
    }, deps);
    if (current.transactions.some(({ id }) => id === plan.transaction.id)) {
      throw new TypeError(`duplicate transaction id ${plan.transaction.id}`);
    }
    applyChangeSet(state.collections, plan.changeSet, "forward");
    state.transactions.push(plan.transaction);
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
      { chatKey, expectedRevision, record: command.plannerRecord },
      { now: deps.now },
    );
    nextHead = planner.nextHead;
    expectedRevision = nextHead.revision;
  }
  if (command.recallRecord) {
    const turnKey = String(command.recallRecord.turnKey || "").trim();
    recall = prepareRecallCreate(
      nextHead,
      current.recallRecords.get(turnKey) || null,
      { chatKey, expectedRevision, record: command.recallRecord },
      { now: deps.now },
    );
    nextHead = recall.nextHead;
  }

  const changed = Boolean(transaction || planner?.created || recall?.created);
  if (planner?.created) state.plannerRecords.set(planner.record.turnKey, planner.record);
  if (recall?.created) state.recallRecords.set(recall.record.turnKey, recall.record);
  if (changed) state.head = nextHead;
  return {
    changed,
    state,
    result: {
      head: clone(nextHead),
      transaction: transaction ? clone(transaction) : null,
      planner: planner
        ? { created: planner.created, record: clone(planner.record) }
        : null,
      recall: recall
        ? { created: recall.created, record: clone(recall.record) }
        : null,
    },
  };
}

function reduceHistory(current, command, { now }) {
  const plan = prepareHistoryReconciliation(current.head, current.transactions, command, { now });
  const result = {
    changed: plan.changed,
    commonPrefixLength: plan.commonPrefixLength,
    rolledBackTransactions: clone(plan.rolledBackTransactions),
    head: clone(plan.nextHead),
    vectorJob: plan.vectorJob ? clone(plan.vectorJob) : null,
  };
  if (!plan.changed) return { changed: false, state: clone(current), result };

  const state = clone(current);
  for (let index = plan.rolledBackTransactions.length - 1; index >= 0; index -= 1) {
    applyChangeSet(state.collections, plan.rolledBackTransactions[index], "rollback");
  }
  state.transactions = plan.remainingTransactions;
  for (const [turnKey, record] of state.recallRecords) {
    if (!isRecallBoundToHistory(record, plan.history)) state.recallRecords.delete(turnKey);
  }
  for (const [turnKey, record] of state.plannerRecords) {
    if (!isPlannerBoundToHistory(record, plan.history)) state.plannerRecords.delete(turnKey);
  }
  if (plan.vectorJob) state.vectorJobs.set(plan.vectorJob.id, plan.vectorJob);
  state.head = plan.nextHead;
  return { changed: true, state, result };
}

function reduceVectorJobs(current, command, { now }) {
  const chatKey = requireChatKey(command.chatKey);
  const ids = [...new Set((Array.isArray(command.ids) ? command.ids : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (ids.length === 0) throw new TypeError("vector job ids are required");
  const status = String(command.status || "completed").trim();
  if (status !== "completed" && status !== "pending") {
    throw new TypeError("vector job status must be completed or pending");
  }

  const state = clone(current);
  const updatedAt = Number(now());
  for (const jobId of ids) {
    const job = state.vectorJobs.get(jobId);
    if (!job || job.chatKey !== chatKey) throw new TypeError(`unknown vector job ${jobId}`);
    job.status = status;
    job.outcome = String(command.outcome || (status === "completed" ? "synced" : "retry"));
    job.lastError = String(command.error || "");
    job.attempts = Math.max(0, Number(job.attempts) || 0) + 1;
    job.updatedAt = updatedAt;
    job.completedAt = status === "completed" ? updatedAt : null;
  }
  return {
    changed: true,
    state,
    result: ids.map((jobId) => clone(state.vectorJobs.get(jobId))),
  };
}
