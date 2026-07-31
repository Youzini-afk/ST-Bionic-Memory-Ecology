// ST-BME vNext domain contract.
//
// This module deliberately contains no SillyTavern, persistence, UI, vector, or
// LLM dependencies. It is the stable vocabulary shared by the memory ledger,
// its materialized graph view, and Agent tools.

export const MEMORY_LEDGER_VERSION = 1;

export const MEMORY_RECORD_KIND = Object.freeze({
  EVIDENCE: "evidence",
  EVIDENCE_INVALIDATION: "evidence_invalidation",
  EVIDENCE_ACTIVATION: "evidence_activation",
  MEMORY_REVISION: "memory_revision",
  RELATION_REVISION: "relation_revision",
  COMMIT: "commit",
  INBOX_ITEM: "inbox_item",
  TASK_CHECKPOINT: "task_checkpoint",
  AGENT_EVENT: "agent_event",
  TURN_ARTIFACT: "turn_artifact",
  MIGRATION: "migration",
});

export const AGENT_EVENT_TYPE = Object.freeze({
  RUN_STARTED: "run_started",
  MODEL_REQUESTED: "model_requested",
  ASSISTANT_MESSAGE: "assistant_message",
  TOOL_STARTED: "tool_started",
  TOOL_FINISHED: "tool_finished",
  TOOL_INTERRUPTED: "tool_interrupted",
  CONTEXT_SUMMARY_CREATED: "context_summary_created",
  CONTEXT_COMPACTED: "context_compacted",
  RUN_COMPLETED: "run_completed",
  RUN_SUSPENDED: "run_suspended",
  RUN_FAILED: "run_failed",
  RUN_CANCELLED: "run_cancelled",
});

export const MEMORY_LAYER = Object.freeze({
  OBJECTIVE: "objective",
  POV: "pov",
  DERIVED: "derived",
});

export const MEMORY_REVISION_STATUS = Object.freeze({
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  CONTESTED: "contested",
  ARCHIVED: "archived",
});

export const MEMORY_INBOX_KIND = Object.freeze({
  TURN_AVAILABLE: "turn_available",
  HISTORY_INVALIDATED: "history_invalidated",
  REPAIR_REQUIRED: "repair_required",
  MANUAL_REQUEST: "manual_request",
});

export const MEMORY_INBOX_STATUS = Object.freeze({
  PENDING: "pending",
  CLAIMED: "claimed",
  COMPLETED: "completed",
  DEFERRED: "deferred",
  CANCELLED: "cancelled",
});

export const TURN_ARTIFACT_KIND = Object.freeze({
  RECALL: "recall",
  PLANNER: "planner",
});

export const TURN_ARTIFACT_STATUS = Object.freeze({
  READY: "ready",
  EMPTY: "empty",
});

export const DEFAULT_BME_AGENT_GUARD = Object.freeze({
  maxToolCalls: 500,
  maxRunMs: 8 * 60 * 1000,
});

export const MEMORY_DOMAIN_DIRECTORIES = Object.freeze([
  "domain",
  "application",
  "agent",
  "storage",
  "host",
  "ui",
]);

const RECORD_KINDS = new Set(Object.values(MEMORY_RECORD_KIND));
const MEMORY_LAYERS = new Set(Object.values(MEMORY_LAYER));
const REVISION_STATUSES = new Set(Object.values(MEMORY_REVISION_STATUS));
const INBOX_KINDS = new Set(Object.values(MEMORY_INBOX_KIND));
const INBOX_STATUSES = new Set(Object.values(MEMORY_INBOX_STATUS));
const AGENT_EVENT_TYPES = new Set(Object.values(AGENT_EVENT_TYPE));
const TURN_ARTIFACT_KINDS = new Set(Object.values(TURN_ARTIFACT_KIND));
const TURN_ARTIFACT_STATUSES = new Set(Object.values(TURN_ARTIFACT_STATUS));
const TERMINAL_AGENT_EVENT_TYPES = new Set([
  AGENT_EVENT_TYPE.RUN_COMPLETED,
  AGENT_EVENT_TYPE.RUN_SUSPENDED,
  AGENT_EVENT_TYPE.RUN_FAILED,
  AGENT_EVENT_TYPE.RUN_CANCELLED,
]);
const AGENT_EVENT_TRANSITIONS = new Map([
  [AGENT_EVENT_TYPE.RUN_STARTED, new Set([AGENT_EVENT_TYPE.MODEL_REQUESTED])],
  [
    AGENT_EVENT_TYPE.MODEL_REQUESTED,
    new Set([
      AGENT_EVENT_TYPE.ASSISTANT_MESSAGE,
      AGENT_EVENT_TYPE.CONTEXT_SUMMARY_CREATED,
    ]),
  ],
  [
    AGENT_EVENT_TYPE.CONTEXT_SUMMARY_CREATED,
    new Set([
      AGENT_EVENT_TYPE.MODEL_REQUESTED,
      AGENT_EVENT_TYPE.CONTEXT_COMPACTED,
    ]),
  ],
  [AGENT_EVENT_TYPE.CONTEXT_COMPACTED, new Set([AGENT_EVENT_TYPE.MODEL_REQUESTED])],
  [
    AGENT_EVENT_TYPE.ASSISTANT_MESSAGE,
    new Set([AGENT_EVENT_TYPE.TOOL_STARTED, AGENT_EVENT_TYPE.RUN_COMPLETED]),
  ],
  [
    AGENT_EVENT_TYPE.TOOL_STARTED,
    new Set([AGENT_EVENT_TYPE.TOOL_FINISHED, AGENT_EVENT_TYPE.TOOL_INTERRUPTED]),
  ],
  [
    AGENT_EVENT_TYPE.TOOL_FINISHED,
    new Set([AGENT_EVENT_TYPE.TOOL_STARTED, AGENT_EVENT_TYPE.MODEL_REQUESTED]),
  ],
  [AGENT_EVENT_TYPE.TOOL_INTERRUPTED, new Set()],
]);

export function normalizeDomainId(value = "") {
  return String(value ?? "").trim();
}

export function requireDomainId(value, label = "id") {
  const normalized = normalizeDomainId(value);
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

export function isMemoryRecordKind(value) {
  return RECORD_KINDS.has(String(value || ""));
}

export function isMemoryLayer(value) {
  return MEMORY_LAYERS.has(String(value || ""));
}

export function isMemoryRevisionStatus(value) {
  return REVISION_STATUSES.has(String(value || ""));
}

export function isMemoryInboxKind(value) {
  return INBOX_KINDS.has(String(value || ""));
}

export function isMemoryInboxStatus(value) {
  return INBOX_STATUSES.has(String(value || ""));
}

export function isAgentEventType(value) {
  return AGENT_EVENT_TYPES.has(String(value || ""));
}

export function isTurnArtifactKind(value) {
  return TURN_ARTIFACT_KINDS.has(String(value || ""));
}

export function isTurnArtifactStatus(value) {
  return TURN_ARTIFACT_STATUSES.has(String(value || ""));
}

export function isTerminalAgentEventType(value) {
  return TERMINAL_AGENT_EVENT_TYPES.has(String(value || ""));
}

export function isAgentEventTransitionAllowed(previousType, nextType) {
  const previous = String(previousType || "");
  const next = String(nextType || "");
  if (!isAgentEventType(previous) || !isAgentEventType(next)) return false;
  if (isTerminalAgentEventType(previous)) return false;
  if (
    isTerminalAgentEventType(next) &&
    next !== AGENT_EVENT_TYPE.RUN_COMPLETED
  ) {
    return true;
  }
  return AGENT_EVENT_TRANSITIONS.get(previous)?.has(next) === true;
}

export function createEmptyMemoryLedger({ chatId, now = Date.now() } = {}) {
  const normalizedChatId = requireDomainId(chatId, "chatId");
  const createdAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return {
    version: MEMORY_LEDGER_VERSION,
    chatId: normalizedChatId,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    records: [],
  };
}
