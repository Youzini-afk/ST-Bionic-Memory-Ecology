import { normalizeChangeSet, recordsEqual } from "./change-set.js";
import {
  HistoryBasisConflictError,
  requireChatKey,
  requireRevision,
  RevisionConflictError,
} from "./state-model.js";

export class RecallConflictError extends Error {
  constructor(turnKey) {
    super(`recall record already exists with different content: ${turnKey}`);
    this.name = "RecallConflictError";
    this.turnKey = turnKey;
  }
}

export class GraphRevisionConflictError extends Error {
  constructor(chatKey, expectedGraphRevision, actualGraphRevision) {
    super(
      `graph revision conflict for ${chatKey}: expected ${expectedGraphRevision}, got ${actualGraphRevision}`,
    );
    this.name = "GraphRevisionConflictError";
    this.chatKey = chatKey;
    this.expectedGraphRevision = expectedGraphRevision;
    this.actualGraphRevision = actualGraphRevision;
  }
}

function requireString(value, label, { allowEmpty = false } = {}) {
  const text = String(value ?? "");
  if (!allowEmpty && !text.trim()) throw new TypeError(`${label} is required`);
  return text;
}

function normalizeNodeIds(value) {
  if (!Array.isArray(value)) throw new TypeError("selectedNodeIds must be an array");
  const ids = value.map((id, index) => requireString(id, `selectedNodeIds[${index}]`).trim());
  if (new Set(ids).size !== ids.length) throw new TypeError("selectedNodeIds must be unique");
  return ids;
}

function normalizeTokenEstimate(value) {
  const estimate = Number(value ?? 0);
  if (!Number.isFinite(estimate) || estimate < 0) {
    throw new TypeError("tokenEstimate must be a non-negative finite number");
  }
  return estimate;
}

export function normalizeRecallResult(value = {}) {
  const selectedNodeIds = Array.isArray(value.selectedNodeIds)
    ? value.selectedNodeIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  return {
    selectedNodeIds: [...new Set(selectedNodeIds)],
    injectionText: String(value.injectionText ?? ""),
    tokenEstimate: normalizeTokenEstimate(value.tokenEstimate),
    changeSet: normalizeChangeSet(value.changeSet || { changes: [] }),
  };
}

function recallContent(record) {
  return {
    turnKey: record.turnKey,
    chatKey: record.chatKey,
    boundUserMessageHash: record.boundUserMessageHash,
    historyPrefixHash: record.historyPrefixHash,
    recallInput: record.recallInput,
    selectedNodeIds: record.selectedNodeIds,
    injectionText: record.injectionText,
    tokenEstimate: record.tokenEstimate,
  };
}

export function isRecallBoundToHistory(record, history) {
  return history.some(
    ({ messageHash, prefixHash }) =>
      messageHash === record.boundUserMessageHash &&
      prefixHash === record.historyPrefixHash,
  );
}

export function prepareRecallCreate(
  head,
  existing,
  command = {},
  { now = Date.now } = {},
) {
  const chatKey = requireChatKey(command.chatKey);
  const expectedRevision = requireRevision(command.expectedRevision, "expectedRevision");
  if (head.chatKey !== chatKey) throw new TypeError("conversation head does not match chatKey");
  if (head.revision !== expectedRevision) {
    throw new RevisionConflictError(chatKey, expectedRevision, head.revision);
  }

  const source = command.record || {};
  const content = {
    turnKey: requireString(source.turnKey, "turnKey").trim(),
    chatKey,
    boundUserMessageHash: requireString(
      source.boundUserMessageHash,
      "boundUserMessageHash",
    ).trim(),
    historyPrefixHash: requireString(source.historyPrefixHash, "historyPrefixHash").trim(),
    recallInput: requireString(source.recallInput, "recallInput", { allowEmpty: true }),
    selectedNodeIds: normalizeNodeIds(source.selectedNodeIds ?? []),
    injectionText: requireString(source.injectionText, "injectionText", { allowEmpty: true }),
    tokenEstimate: normalizeTokenEstimate(source.tokenEstimate),
  };
  const graphRevision = requireRevision(source.graphRevision, "graphRevision");
  if (source.chatKey && requireChatKey(source.chatKey) !== chatKey) {
    throw new TypeError("recall record does not match chatKey");
  }
  if (!isRecallBoundToHistory(content, head.history)) {
    throw new HistoryBasisConflictError(
      chatKey,
      head.history.length,
      content.historyPrefixHash,
    );
  }

  if (existing) {
    if (!recordsEqual(recallContent(existing), content)) {
      throw new RecallConflictError(content.turnKey);
    }
    return {
      created: false,
      record: structuredClone(existing),
      nextHead: structuredClone(head),
    };
  }

  if (graphRevision !== head.graphRevision) {
    throw new GraphRevisionConflictError(chatKey, graphRevision, head.graphRevision);
  }

  const timestamp = Number(now());
  if (!Number.isFinite(timestamp)) throw new TypeError("clock must return a finite number");
  const record = {
    ...content,
    graphRevision,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const nextHead = {
    ...structuredClone(head),
    revision: head.revision + 1,
    updatedAt: timestamp,
  };
  return { created: true, record, nextHead };
}
