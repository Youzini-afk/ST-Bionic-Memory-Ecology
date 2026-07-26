import { recordsEqual } from "./change-set.js";
import {
  HistoryBasisConflictError,
  requireChatKey,
  requireRevision,
  RevisionConflictError,
} from "./state-model.js";

export class PlannerConflictError extends Error {
  constructor(turnKey) {
    super(`planner record already exists with different content: ${turnKey}`);
    this.name = "PlannerConflictError";
    this.turnKey = turnKey;
  }
}

function requireString(value, label, { allowEmpty = false } = {}) {
  const text = String(value ?? "");
  if (!allowEmpty && !text.trim()) throw new TypeError(`${label} is required`);
  return text;
}

function normalizePlotBlocks(value) {
  if (!Array.isArray(value)) throw new TypeError("plotBlocks must be an array");
  return value.map((block, index) => requireString(block, `plotBlocks[${index}]`).trim());
}

function plannerContent(record) {
  return {
    turnKey: record.turnKey,
    chatKey: record.chatKey,
    boundUserMessageHash: record.boundUserMessageHash,
    historyPrefixHash: record.historyPrefixHash,
    rawUserInput: record.rawUserInput,
    augmentedUserMessage: record.augmentedUserMessage,
    plotText: record.plotText,
    plotBlocks: record.plotBlocks,
    promptProfileId: record.promptProfileId,
    recallTurnKey: record.recallTurnKey,
  };
}

export function isPlannerBoundToHistory(record, history) {
  return history.some(
    ({ messageHash, prefixHash }) =>
      messageHash === record.boundUserMessageHash &&
      prefixHash === record.historyPrefixHash,
  );
}

export function preparePlannerCreate(
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
  const turnKey = requireString(source.turnKey, "turnKey").trim();
  const content = {
    turnKey,
    chatKey,
    boundUserMessageHash: requireString(
      source.boundUserMessageHash,
      "boundUserMessageHash",
    ).trim(),
    historyPrefixHash: requireString(source.historyPrefixHash, "historyPrefixHash").trim(),
    rawUserInput: requireString(source.rawUserInput, "rawUserInput"),
    augmentedUserMessage: requireString(source.augmentedUserMessage, "augmentedUserMessage"),
    plotText: requireString(source.plotText, "plotText"),
    plotBlocks: normalizePlotBlocks(source.plotBlocks ?? []),
    promptProfileId: requireString(source.promptProfileId, "promptProfileId").trim(),
    recallTurnKey: requireString(source.recallTurnKey, "recallTurnKey", {
      allowEmpty: true,
    }).trim(),
  };
  if (source.chatKey && requireChatKey(source.chatKey) !== chatKey) {
    throw new TypeError("planner record does not match chatKey");
  }
  if (content.recallTurnKey && content.recallTurnKey !== turnKey) {
    throw new TypeError("recallTurnKey must identify the same user turn");
  }
  if (!isPlannerBoundToHistory(content, head.history)) {
    throw new HistoryBasisConflictError(chatKey, head.history.length, content.historyPrefixHash);
  }

  if (existing) {
    if (!recordsEqual(plannerContent(existing), content)) {
      throw new PlannerConflictError(turnKey);
    }
    return {
      created: false,
      record: structuredClone(existing),
      nextHead: structuredClone(head),
    };
  }

  const createdAt = Number(now());
  if (!Number.isFinite(createdAt)) throw new TypeError("clock must return a finite number");
  const record = { ...content, createdAt };
  const nextHead = {
    ...structuredClone(head),
    revision: head.revision + 1,
    updatedAt: createdAt,
  };
  return { created: true, record, nextHead };
}
