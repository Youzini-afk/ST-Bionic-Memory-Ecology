import {
  AGENT_EVENT_TYPE,
  MEMORY_INBOX_STATUS,
  MEMORY_RECORD_KIND,
  MEMORY_REVISION_STATUS,
  isTerminalAgentEventType,
} from "./memory-contract.js";
import { buildMemoryLedgerIndex } from "./memory-ledger.js";

function compareLedgerOrder(left, right) {
  const revisionDelta = Number(left?.ledgerRevision || 0) - Number(right?.ledgerRevision || 0);
  if (revisionDelta !== 0) return revisionDelta;
  return Number(left?.ledgerOrdinal || 0) - Number(right?.ledgerOrdinal || 0);
}

function latestBy(records, identity) {
  const map = new Map();
  for (const record of records || []) {
    const key = String(identity(record) || "").trim();
    if (!key) continue;
    const current = map.get(key);
    if (!current || compareLedgerOrder(current, record) < 0) map.set(key, record);
  }
  return map;
}

export function materializeEvidenceState(ledger) {
  const index = buildMemoryLedgerIndex(ledger);
  const evidence = index.recordsByKind.get(MEMORY_RECORD_KIND.EVIDENCE) || [];
  const invalidations =
    index.recordsByKind.get(MEMORY_RECORD_KIND.EVIDENCE_INVALIDATION) || [];
  const activations =
    index.recordsByKind.get(MEMORY_RECORD_KIND.EVIDENCE_ACTIVATION) || [];
  const latestDispositionByEvidenceId = latestBy(
    [...invalidations, ...activations],
    (record) => record.evidenceId,
  );
  const latestInvalidationByEvidenceId = new Map(
    [...latestDispositionByEvidenceId].filter(
      ([, record]) => record.kind === MEMORY_RECORD_KIND.EVIDENCE_INVALIDATION,
    ),
  );
  const activeEvidence = [];
  const invalidEvidence = [];
  for (const record of evidence) {
    const invalidation = latestInvalidationByEvidenceId.get(record.id) || null;
    if (invalidation) invalidEvidence.push({ evidence: record, invalidation });
    else activeEvidence.push(record);
  }
  return {
    activeEvidence,
    activeEvidenceIds: new Set(activeEvidence.map((record) => record.id)),
    invalidEvidence,
    latestInvalidationByEvidenceId,
    latestDispositionByEvidenceId,
  };
}

function createRevisionValidator({ activeEvidenceIds, revisionById }) {
  const cache = new Map();
  const visiting = new Set();

  function validate(revisionId) {
    if (cache.has(revisionId)) return cache.get(revisionId);
    if (visiting.has(revisionId)) {
      const result = { valid: false, reasons: [`dependency-cycle:${revisionId}`] };
      cache.set(revisionId, result);
      return result;
    }
    const revision = revisionById.get(revisionId);
    if (!revision) {
      const result = { valid: false, reasons: [`missing-revision:${revisionId}`] };
      cache.set(revisionId, result);
      return result;
    }
    visiting.add(revisionId);
    const reasons = [];
    for (const evidenceId of revision.evidenceIds || []) {
      if (!activeEvidenceIds.has(evidenceId)) reasons.push(`inactive-evidence:${evidenceId}`);
    }
    for (const dependencyId of revision.dependencyRevisionIds || []) {
      const dependency = validate(dependencyId);
      if (!dependency.valid) reasons.push(`inactive-dependency:${dependencyId}`);
    }
    visiting.delete(revisionId);
    const result = { valid: reasons.length === 0, reasons };
    cache.set(revisionId, result);
    return result;
  }
  return { validate, cache };
}

function materializeRevisionHeads(records, identity, validator) {
  const grouped = new Map();
  for (const record of records || []) {
    const key = String(identity(record) || "").trim();
    if (!key) continue;
    const bucket = grouped.get(key) || [];
    bucket.push(record);
    grouped.set(key, bucket);
  }
  const active = [];
  const inactive = [];
  const heads = new Map();
  for (const [key, bucket] of grouped) {
    const ordered = [...bucket].sort(compareLedgerOrder).reverse();
    let selected = null;
    for (const revision of ordered) {
      const validation = validator.validate(revision.id);
      if (!validation.valid) {
        inactive.push({ revision, reasons: validation.reasons });
        continue;
      }
      selected = revision;
      break;
    }
    if (!selected) continue;
    heads.set(key, selected);
    if (selected.status !== MEMORY_REVISION_STATUS.ARCHIVED) active.push(selected);
    else inactive.push({ revision: selected, reasons: ["archived"] });
  }
  return { active, inactive, heads };
}

export function materializeInboxState(ledger) {
  const index = buildMemoryLedgerIndex(ledger);
  const revisions = index.recordsByKind.get(MEMORY_RECORD_KIND.INBOX_ITEM) || [];
  const latestByInboxId = latestBy(revisions, (record) => record.inboxId);
  const items = [...latestByInboxId.values()].sort(compareLedgerOrder);
  return {
    items,
    latestByInboxId,
    pending: items.filter(
      (item) =>
        item.status === MEMORY_INBOX_STATUS.PENDING ||
        item.status === MEMORY_INBOX_STATUS.DEFERRED,
    ),
    claimed: items.filter((item) => item.status === MEMORY_INBOX_STATUS.CLAIMED),
  };
}

function agentRunStatus(eventType = "") {
  switch (eventType) {
    case AGENT_EVENT_TYPE.RUN_COMPLETED:
      return "completed";
    case AGENT_EVENT_TYPE.RUN_SUSPENDED:
      return "suspended";
    case AGENT_EVENT_TYPE.RUN_FAILED:
      return "failed";
    case AGENT_EVENT_TYPE.RUN_CANCELLED:
      return "cancelled";
    default:
      return "running";
  }
}

export function materializeAgentRuns(ledger) {
  const index = buildMemoryLedgerIndex(ledger);
  const events = index.recordsByKind.get(MEMORY_RECORD_KIND.AGENT_EVENT) || [];
  const eventsByRunId = new Map();
  for (const event of events) {
    const bucket = eventsByRunId.get(event.runId) || [];
    bucket.push(event);
    eventsByRunId.set(event.runId, bucket);
  }
  const runs = new Map();
  for (const [runId, runEvents] of eventsByRunId) {
    const orderedEvents = [...runEvents].sort((left, right) => {
      const sequenceDelta = Number(left.sequence) - Number(right.sequence);
      return sequenceDelta || compareLedgerOrder(left, right);
    });
    const firstEvent = orderedEvents[0] || null;
    const latestEvent = orderedEvents.at(-1) || null;
    const status = agentRunStatus(latestEvent?.eventType);
    runs.set(runId, {
      runId,
      taskId: String(firstEvent?.taskId || latestEvent?.taskId || ""),
      agentKind: String(firstEvent?.agentKind || latestEvent?.agentKind || ""),
      status,
      terminal: isTerminalAgentEventType(latestEvent?.eventType),
      firstEvent,
      latestEvent,
      events: orderedEvents,
    });
  }
  const ordered = [...runs.values()].sort((left, right) =>
    compareLedgerOrder(left.firstEvent, right.firstEvent),
  );
  return {
    runs,
    ordered,
    active: ordered.filter((run) => !run.terminal),
    suspended: ordered.filter((run) => run.status === "suspended"),
  };
}

export function materializeMemoryLedger(ledger) {
  const index = buildMemoryLedgerIndex(ledger);
  const evidence = materializeEvidenceState(ledger);
  const memoryRevisions =
    index.recordsByKind.get(MEMORY_RECORD_KIND.MEMORY_REVISION) || [];
  const relationRevisions =
    index.recordsByKind.get(MEMORY_RECORD_KIND.RELATION_REVISION) || [];
  const revisionById = new Map(
    [...memoryRevisions, ...relationRevisions].map((record) => [record.id, record]),
  );
  const validator = createRevisionValidator({
    activeEvidenceIds: evidence.activeEvidenceIds,
    revisionById,
  });
  const memories = materializeRevisionHeads(
    memoryRevisions,
    (record) => record.memoryId,
    validator,
  );
  const activeMemoryIds = new Set(memories.active.map((record) => record.memoryId));
  const relations = materializeRevisionHeads(
    relationRevisions,
    (record) => record.relationId,
    validator,
  );
  const activeRelations = relations.active.filter(
    (record) =>
      activeMemoryIds.has(record.fromMemoryId) && activeMemoryIds.has(record.toMemoryId),
  );
  const endpointInvalidRelations = relations.active
    .filter((record) => !activeRelations.includes(record))
    .map((revision) => ({ revision, reasons: ["inactive-endpoint"] }));
  const inbox = materializeInboxState(ledger);
  const agent = materializeAgentRuns(ledger);
  return {
    chatId: ledger.chatId,
    revision: ledger.revision,
    evidence,
    memories: {
      ...memories,
      byMemoryId: new Map(memories.active.map((record) => [record.memoryId, record])),
    },
    relations: {
      ...relations,
      active: activeRelations,
      inactive: [...relations.inactive, ...endpointInvalidRelations],
      byRelationId: new Map(
        activeRelations.map((record) => [record.relationId, record]),
      ),
    },
    inbox,
    agent,
    validationByRevisionId: validator.cache,
  };
}
