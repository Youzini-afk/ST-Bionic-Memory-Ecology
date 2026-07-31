import {
  AGENT_EVENT_TYPE,
  MEMORY_INBOX_KIND,
  MEMORY_INBOX_STATUS,
  MEMORY_LAYER,
  MEMORY_RECORD_KIND,
  MEMORY_REVISION_STATUS,
  isMemoryInboxKind,
  isMemoryInboxStatus,
  isAgentEventType,
  isMemoryLayer,
  isMemoryRevisionStatus,
  requireDomainId,
} from "./memory-contract.js";
import {
  cloneDomainValue,
  createDomainId,
  hashDomainValue,
  normalizeStringArray,
  normalizeTimestamp,
} from "./memory-id.js";

function plainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneDomainValue(value, fallback)
    : fallback;
}

function optionalFloor(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function baseRecord(kind, input = {}) {
  return {
    id: requireDomainId(input.id, `${kind}.id`),
    kind,
    chatId: requireDomainId(input.chatId, `${kind}.chatId`),
    createdAt: normalizeTimestamp(input.createdAt),
  };
}

export function createTurnEvidence(input = {}) {
  const chatId = requireDomainId(input.chatId, "evidence.chatId");
  const turnId = requireDomainId(input.turnId, "evidence.turnId");
  const userText = String(input.userText ?? "");
  const assistantText = String(input.assistantText ?? "");
  if (!assistantText.trim() && input.allowEmptyAssistant !== true) {
    throw new TypeError("evidence.assistantText is required");
  }
  const source = {
    hostChatId: String(input.hostChatId || "").trim(),
    userMessageId: String(input.userMessageId || "").trim(),
    assistantMessageId: String(input.assistantMessageId || "").trim(),
    userFloor: optionalFloor(input.userFloor),
    assistantFloor: optionalFloor(input.assistantFloor),
    assistantSwipeId: optionalFloor(input.assistantSwipeId),
    generationId: String(input.generationId || "").trim(),
    groupGenerationId: String(input.groupGenerationId || "").trim(),
  };
  const content = {
    user: userText,
    assistant: assistantText,
    normalizedUser: String(input.normalizedUserText ?? userText).trim(),
    normalizedAssistant: String(input.normalizedAssistantText ?? assistantText).trim(),
  };
  // Mutable SillyTavern array indexes are locators, not content identity. Keep
  // them in `source`, but never let an insertion/deletion change the evidence
  // id of an otherwise unchanged assistant turn.
  const contentHash = String(
    input.contentHash ||
      hashDomainValue({
        content,
        speaker: String(input.metadata?.speaker || "").trim(),
      }),
  );
  const id = String(
    input.id ||
      createDomainId("evidence", {
        chatId,
        turnId,
        contentHash,
      }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.EVIDENCE, {
      ...input,
      id,
      chatId,
    }),
    turnId,
    source,
    content,
    contentHash,
    historyFingerprint: String(input.historyFingerprint || "").trim(),
    metadata: plainObject(input.metadata),
  };
}

export function createEvidenceInvalidation(input = {}) {
  const chatId = requireDomainId(input.chatId, "invalidation.chatId");
  const evidenceId = requireDomainId(input.evidenceId, "invalidation.evidenceId");
  const reason = String(input.reason || "history-invalidated").trim();
  const mutationId = String(input.mutationId || "").trim();
  const id = String(
    input.id ||
      createDomainId("invalidation", {
        chatId,
        evidenceId,
        reason,
        mutationId,
      }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.EVIDENCE_INVALIDATION, {
      ...input,
      id,
      chatId,
    }),
    evidenceId,
    reason,
    mutationId,
    sourceFingerprint: String(input.sourceFingerprint || "").trim(),
  };
}

export function createEvidenceActivation(input = {}) {
  const chatId = requireDomainId(input.chatId, "activation.chatId");
  const evidenceId = requireDomainId(input.evidenceId, "activation.evidenceId");
  const reason = String(input.reason || "history-reactivated").trim();
  const mutationId = String(input.mutationId || "").trim();
  const id = String(
    input.id ||
      createDomainId("activation", {
        chatId,
        evidenceId,
        reason,
        mutationId,
      }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.EVIDENCE_ACTIVATION, {
      ...input,
      id,
      chatId,
    }),
    evidenceId,
    reason,
    mutationId,
    sourceFingerprint: String(input.sourceFingerprint || "").trim(),
  };
}

export function createMemoryRevision(input = {}) {
  const chatId = requireDomainId(input.chatId, "memoryRevision.chatId");
  const memoryId = requireDomainId(input.memoryId, "memoryRevision.memoryId");
  const layer = String(input.layer || MEMORY_LAYER.OBJECTIVE);
  if (!isMemoryLayer(layer)) throw new TypeError(`invalid memory layer: ${layer}`);
  const status = String(input.status || MEMORY_REVISION_STATUS.ACTIVE);
  if (!isMemoryRevisionStatus(status)) {
    throw new TypeError(`invalid memory revision status: ${status}`);
  }
  const evidenceIds = normalizeStringArray(input.evidenceIds);
  const dependencyRevisionIds = normalizeStringArray(input.dependencyRevisionIds);
  if (evidenceIds.length === 0 && dependencyRevisionIds.length === 0) {
    throw new TypeError("memory revision requires evidenceIds or dependencyRevisionIds");
  }
  const parentRevisionId = String(input.parentRevisionId || "").trim();
  const memoryType = requireDomainId(input.memoryType || input.type, "memoryRevision.memoryType");
  const payloadFingerprint = hashDomainValue({
    memoryId,
    parentRevisionId,
    layer,
    status,
    memoryType,
    fields: input.fields || {},
    scope: input.scope || {},
    storyTime: input.storyTime || {},
    evidenceIds,
    dependencyRevisionIds,
  });
  const id = String(
    input.id || createDomainId("memory-revision", { chatId, memoryId, payloadFingerprint }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.MEMORY_REVISION, {
      ...input,
      id,
      chatId,
    }),
    memoryId,
    parentRevisionId,
    layer,
    status,
    memoryType,
    fields: plainObject(input.fields),
    scope: plainObject(input.scope),
    storyTime: plainObject(input.storyTime),
    evidenceIds,
    dependencyRevisionIds,
    importance: Number.isFinite(Number(input.importance))
      ? Math.max(0, Math.min(10, Number(input.importance)))
      : 5,
    confidence: Number.isFinite(Number(input.confidence))
      ? Math.max(0, Math.min(1, Number(input.confidence)))
      : 1,
    reason: String(input.reason || "").trim(),
    agentTaskId: String(input.agentTaskId || "").trim(),
  };
}

export function createRelationRevision(input = {}) {
  const chatId = requireDomainId(input.chatId, "relationRevision.chatId");
  const relationId = requireDomainId(input.relationId, "relationRevision.relationId");
  const fromMemoryId = requireDomainId(
    input.fromMemoryId,
    "relationRevision.fromMemoryId",
  );
  const toMemoryId = requireDomainId(input.toMemoryId, "relationRevision.toMemoryId");
  const relation = requireDomainId(input.relation, "relationRevision.relation");
  const evidenceIds = normalizeStringArray(input.evidenceIds);
  const dependencyRevisionIds = normalizeStringArray(input.dependencyRevisionIds);
  if (evidenceIds.length === 0 && dependencyRevisionIds.length === 0) {
    throw new TypeError("relation revision requires evidenceIds or dependencyRevisionIds");
  }
  const parentRevisionId = String(input.parentRevisionId || "").trim();
  const status = String(input.status || MEMORY_REVISION_STATUS.ACTIVE);
  if (!isMemoryRevisionStatus(status)) {
    throw new TypeError(`invalid relation revision status: ${status}`);
  }
  const payloadFingerprint = hashDomainValue({
    relationId,
    parentRevisionId,
    fromMemoryId,
    toMemoryId,
    relation,
    status,
    evidenceIds,
    dependencyRevisionIds,
  });
  const id = String(
    input.id ||
      createDomainId("relation-revision", { chatId, relationId, payloadFingerprint }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.RELATION_REVISION, {
      ...input,
      id,
      chatId,
    }),
    relationId,
    parentRevisionId,
    fromMemoryId,
    toMemoryId,
    relation,
    status,
    evidenceIds,
    dependencyRevisionIds,
    strength: Number.isFinite(Number(input.strength))
      ? Math.max(0, Math.min(1, Number(input.strength)))
      : 0.5,
    metadata: plainObject(input.metadata),
  };
}

export function createInboxItemRevision(input = {}) {
  const chatId = requireDomainId(input.chatId, "inbox.chatId");
  const inboxId = requireDomainId(input.inboxId, "inbox.inboxId");
  const inboxKind = String(input.inboxKind || MEMORY_INBOX_KIND.TURN_AVAILABLE);
  if (!isMemoryInboxKind(inboxKind)) throw new TypeError(`invalid inbox kind: ${inboxKind}`);
  const status = String(input.status || MEMORY_INBOX_STATUS.PENDING);
  if (!isMemoryInboxStatus(status)) throw new TypeError(`invalid inbox status: ${status}`);
  const sequence = Number.isFinite(Number(input.sequence))
    ? Math.max(0, Math.floor(Number(input.sequence)))
    : 0;
  const previousRevisionId = String(input.previousRevisionId || "").trim();
  if (sequence > 0 && !previousRevisionId) {
    throw new TypeError("inbox transition requires previousRevisionId");
  }
  const id = String(
    input.id ||
      createDomainId("inbox-revision", {
        chatId,
        inboxId,
        sequence,
        status,
        previousRevisionId,
      }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.INBOX_ITEM, {
      ...input,
      id,
      chatId,
    }),
    inboxId,
    inboxKind,
    status,
    sequence,
    previousRevisionId,
    dedupeKey: String(input.dedupeKey || "").trim(),
    sourceRecordIds: normalizeStringArray(input.sourceRecordIds),
    payload: plainObject(input.payload),
    attempt: Number.isFinite(Number(input.attempt))
      ? Math.max(0, Math.floor(Number(input.attempt)))
      : 0,
    claimId: String(input.claimId || "").trim(),
    claimOwner: String(input.claimOwner || "").trim(),
    availableAt: normalizeTimestamp(input.availableAt, normalizeTimestamp(input.createdAt)),
    note: String(input.note || "").trim(),
  };
}

export function createTaskCheckpoint(input = {}) {
  const chatId = requireDomainId(input.chatId, "taskCheckpoint.chatId");
  const taskId = requireDomainId(input.taskId, "taskCheckpoint.taskId");
  const sequence = Number.isFinite(Number(input.sequence))
    ? Math.max(0, Math.floor(Number(input.sequence)))
    : 0;
  const id = String(
    input.id || createDomainId("task-checkpoint", { chatId, taskId, sequence }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.TASK_CHECKPOINT, {
      ...input,
      id,
      chatId,
    }),
    taskId,
    sequence,
    state: String(input.state || "running").trim(),
    inboxIds: normalizeStringArray(input.inboxIds),
    readRecordIds: normalizeStringArray(input.readRecordIds),
    stagedRecordIds: normalizeStringArray(input.stagedRecordIds),
    contextSummary: String(input.contextSummary || ""),
    metadata: plainObject(input.metadata),
  };
}

export function createAgentEvent(input = {}) {
  const chatId = requireDomainId(input.chatId, "agentEvent.chatId");
  const runId = requireDomainId(input.runId, "agentEvent.runId");
  const taskId = requireDomainId(input.taskId, "agentEvent.taskId");
  const agentKind = requireDomainId(input.agentKind, "agentEvent.agentKind");
  const eventType = String(input.eventType || "").trim();
  if (!isAgentEventType(eventType)) {
    throw new TypeError(`invalid agent event type: ${eventType}`);
  }
  const sequence = Number(input.sequence);
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new TypeError("agentEvent.sequence must be a non-negative integer");
  }
  const previousEventId = String(input.previousEventId || "").trim();
  if (sequence > 0 && !previousEventId) {
    throw new TypeError("agent event transition requires previousEventId");
  }
  if (sequence === 0 && eventType !== AGENT_EVENT_TYPE.RUN_STARTED) {
    throw new TypeError("the first agent event must be run_started");
  }
  if (sequence > 0 && eventType === AGENT_EVENT_TYPE.RUN_STARTED) {
    throw new TypeError("run_started cannot appear after the first agent event");
  }
  const payload = plainObject(input.payload);
  const id = String(
    input.id ||
      createDomainId("agent-event", {
        chatId,
        runId,
        sequence,
        eventType,
        previousEventId,
        payload,
      }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.AGENT_EVENT, {
      ...input,
      id,
      chatId,
    }),
    runId,
    taskId,
    agentKind,
    sequence,
    eventType,
    previousEventId,
    sourceRecordIds: normalizeStringArray(input.sourceRecordIds),
    payload,
  };
}

export function createLedgerCommitRecord(input = {}) {
  const chatId = requireDomainId(input.chatId, "commit.chatId");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new TypeError("commit.revision must be a positive integer");
  }
  const idempotencyKey = requireDomainId(
    input.idempotencyKey,
    "commit.idempotencyKey",
  );
  const id = String(
    input.id || createDomainId("commit", { chatId, revision, idempotencyKey }),
  );
  return {
    ...baseRecord(MEMORY_RECORD_KIND.COMMIT, {
      ...input,
      id,
      chatId,
    }),
    revision,
    baseRevision: Math.max(0, Math.floor(Number(input.baseRevision) || 0)),
    parentCommitId: String(input.parentCommitId || "").trim(),
    idempotencyKey,
    payloadFingerprint: requireDomainId(
      input.payloadFingerprint,
      "commit.payloadFingerprint",
    ),
    appendedRecordIds: normalizeStringArray(input.appendedRecordIds),
    readRecordIds: normalizeStringArray(input.readRecordIds),
    sourceEvidenceIds: normalizeStringArray(input.sourceEvidenceIds),
    reason: String(input.reason || "").trim(),
  };
}
