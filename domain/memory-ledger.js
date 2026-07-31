import {
  AGENT_EVENT_TYPE,
  MEMORY_LEDGER_VERSION,
  MEMORY_RECORD_KIND,
  isAgentEventTransitionAllowed,
  isAgentEventType,
  isMemoryRecordKind,
  requireDomainId,
} from "./memory-contract.js";
import {
  cloneDomainValue,
  freezeDomainValue,
  hashDomainValue,
  normalizeStringArray,
  normalizeTimestamp,
  stableStringify,
} from "./memory-id.js";
import { createLedgerCommitRecord } from "./memory-records.js";

export class MemoryLedgerConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MemoryLedgerConflictError";
    this.code = "memory_ledger_conflict";
    this.details = details;
  }
}

export class MemoryLedgerValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "MemoryLedgerValidationError";
    this.code = "memory_ledger_validation";
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

export function assertMemoryLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    throw new MemoryLedgerValidationError("memory ledger must be an object");
  }
  if (Number(ledger.version) !== MEMORY_LEDGER_VERSION) {
    throw new MemoryLedgerValidationError(
      `unsupported memory ledger version: ${ledger.version}`,
    );
  }
  requireDomainId(ledger.chatId, "ledger.chatId");
  if (!Number.isInteger(Number(ledger.revision)) || Number(ledger.revision) < 0) {
    throw new MemoryLedgerValidationError("ledger.revision must be a non-negative integer");
  }
  if (!Array.isArray(ledger.records)) {
    throw new MemoryLedgerValidationError("ledger.records must be an array");
  }
  const issues = [];
  const recordIds = new Set();
  let commitCount = 0;
  let parentCommitId = "";
  const latestAgentEventByRunId = new Map();
  for (const record of ledger.records) {
    const id = String(record?.id || "").trim();
    const kind = String(record?.kind || "").trim();
    if (!id) issues.push("ledger record id is required");
    else if (recordIds.has(id)) issues.push(`duplicate ledger record id: ${id}`);
    else recordIds.add(id);
    if (!isMemoryRecordKind(kind)) issues.push(`invalid ledger record kind: ${kind}`);
    if (String(record?.chatId || "").trim() !== ledger.chatId) {
      issues.push(`ledger record ${id || "<unknown>"} belongs to another chat`);
    }
    if (kind === MEMORY_RECORD_KIND.COMMIT) {
      commitCount += 1;
      if (
        Number(record.revision) !== commitCount ||
        Number(record.baseRevision) !== commitCount - 1 ||
        String(record.parentCommitId || "") !== parentCommitId
      ) {
        issues.push(`ledger commit chain is invalid at revision ${commitCount}`);
      }
      parentCommitId = id;
    } else if (
      !Number.isInteger(Number(record?.ledgerRevision)) ||
      Number(record.ledgerRevision) <= 0 ||
      Number(record.ledgerRevision) > Number(ledger.revision)
    ) {
      issues.push(`ledger record ${id || "<unknown>"} has invalid revision`);
    }
    if (kind === MEMORY_RECORD_KIND.AGENT_EVENT) {
      const runId = String(record?.runId || "").trim();
      const previous = latestAgentEventByRunId.get(runId) || null;
      if (!runId) {
        issues.push(`agent event ${id || "<unknown>"} has no run id`);
      } else if (!isAgentEventType(record.eventType)) {
        issues.push(`agent event ${id || "<unknown>"} has an invalid type`);
      } else if (!previous) {
        if (
          Number(record.sequence) !== 0 ||
          record.eventType !== AGENT_EVENT_TYPE.RUN_STARTED ||
          record.previousEventId
        ) {
          issues.push(`agent run ${runId} has an invalid first event`);
        }
      } else if (
        Number(record.sequence) !== Number(previous.sequence) + 1 ||
        String(record.previousEventId || "") !== previous.id ||
        record.eventType === AGENT_EVENT_TYPE.RUN_STARTED ||
        !isAgentEventTransitionAllowed(previous.eventType, record.eventType)
      ) {
        issues.push(`agent run ${runId} has an invalid event chain at ${id || "<unknown>"}`);
      }
      if (runId) latestAgentEventByRunId.set(runId, record);
    }
  }
  if (commitCount !== Number(ledger.revision)) {
    issues.push(`ledger revision ${ledger.revision} does not match ${commitCount} commits`);
  }
  if (issues.length > 0) {
    throw new MemoryLedgerValidationError("memory ledger integrity check failed", issues);
  }
  return ledger;
}

export function buildMemoryLedgerIndex(ledger) {
  assertMemoryLedger(ledger);
  const recordsById = new Map();
  const recordsByKind = new Map();
  const commitsByIdempotencyKey = new Map();
  const commitsByRevision = new Map();
  for (const record of ledger.records) {
    const id = String(record?.id || "").trim();
    if (!id) continue;
    recordsById.set(id, record);
    const kind = String(record?.kind || "");
    const bucket = recordsByKind.get(kind) || [];
    bucket.push(record);
    recordsByKind.set(kind, bucket);
    if (kind === MEMORY_RECORD_KIND.COMMIT && record.idempotencyKey) {
      commitsByIdempotencyKey.set(String(record.idempotencyKey), record);
      commitsByRevision.set(Number(record.revision), record);
    }
  }
  return {
    recordsById,
    recordsByKind,
    commitsByIdempotencyKey,
    commitsByRevision,
    headCommit: commitsByRevision.get(Number(ledger.revision)) || null,
  };
}

function validateRecordShape(record, ledger, index, appendedById) {
  const issues = [];
  const id = String(record?.id || "").trim();
  const kind = String(record?.kind || "").trim();
  if (!id) issues.push("record.id is required");
  if (!isMemoryRecordKind(kind) || kind === MEMORY_RECORD_KIND.COMMIT) {
    issues.push(`record ${id || "<unknown>"} has invalid append kind: ${kind}`);
  }
  if (String(record?.chatId || "").trim() !== ledger.chatId) {
    issues.push(`record ${id || "<unknown>"} belongs to another chat`);
  }
  if (id && (index.recordsById.has(id) || appendedById.has(id))) {
    issues.push(`record id already exists: ${id}`);
  }
  return issues;
}

function validateRecordReferences(records, index) {
  const issues = [];
  const available = new Map(index.recordsById);
  for (const record of records) available.set(record.id, record);
  for (const record of records) {
    if (
      record.kind === MEMORY_RECORD_KIND.EVIDENCE_INVALIDATION ||
      record.kind === MEMORY_RECORD_KIND.EVIDENCE_ACTIVATION
    ) {
      const evidence = available.get(record.evidenceId);
      if (evidence?.kind !== MEMORY_RECORD_KIND.EVIDENCE) {
        issues.push(`invalidation ${record.id} references missing evidence ${record.evidenceId}`);
      }
    }
    if (
      record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION ||
      record.kind === MEMORY_RECORD_KIND.RELATION_REVISION
    ) {
      for (const evidenceId of record.evidenceIds || []) {
        if (available.get(evidenceId)?.kind !== MEMORY_RECORD_KIND.EVIDENCE) {
          issues.push(`${record.id} references missing evidence ${evidenceId}`);
        }
      }
      for (const revisionId of record.dependencyRevisionIds || []) {
        const dependency = available.get(revisionId);
        if (
          dependency?.kind !== MEMORY_RECORD_KIND.MEMORY_REVISION &&
          dependency?.kind !== MEMORY_RECORD_KIND.RELATION_REVISION
        ) {
          issues.push(`${record.id} references missing revision ${revisionId}`);
        }
      }
      if (record.parentRevisionId) {
        const parent = available.get(record.parentRevisionId);
        if (parent?.kind !== record.kind) {
          issues.push(`${record.id} references invalid parent ${record.parentRevisionId}`);
        } else if (
          record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION &&
          parent.memoryId !== record.memoryId
        ) {
          issues.push(`${record.id} parent belongs to another memory`);
        } else if (
          record.kind === MEMORY_RECORD_KIND.RELATION_REVISION &&
          parent.relationId !== record.relationId
        ) {
          issues.push(`${record.id} parent belongs to another relation`);
        }
      }
    }
    if (record.kind === MEMORY_RECORD_KIND.INBOX_ITEM && record.previousRevisionId) {
      const previous = available.get(record.previousRevisionId);
      if (
        previous?.kind !== MEMORY_RECORD_KIND.INBOX_ITEM ||
        previous.inboxId !== record.inboxId
      ) {
        issues.push(`${record.id} references invalid inbox predecessor`);
      } else if (Number(record.sequence) !== Number(previous.sequence) + 1) {
        issues.push(`${record.id} has a non-contiguous inbox sequence`);
      }
    }
    if (record.kind === MEMORY_RECORD_KIND.AGENT_EVENT) {
      if (Number(record.sequence) === 0) {
        if (record.previousEventId) {
          issues.push(`${record.id} has an unexpected agent predecessor`);
        }
      } else {
        const previous = available.get(record.previousEventId);
        if (
          previous?.kind !== MEMORY_RECORD_KIND.AGENT_EVENT ||
          previous.runId !== record.runId
        ) {
          issues.push(`${record.id} references invalid agent predecessor`);
        } else if (Number(record.sequence) !== Number(previous.sequence) + 1) {
          issues.push(`${record.id} has a non-contiguous agent sequence`);
        } else if (!isAgentEventTransitionAllowed(previous.eventType, record.eventType)) {
          issues.push(
            `${record.id} has an invalid agent transition ${previous.eventType} -> ${record.eventType}`,
          );
        }
      }
      for (const sourceRecordId of record.sourceRecordIds || []) {
        if (!available.has(sourceRecordId)) {
          issues.push(`${record.id} references missing source record ${sourceRecordId}`);
        }
      }
    }
  }
  return issues;
}

export function appendMemoryLedgerTransaction(
  ledger,
  {
    baseRevision,
    idempotencyKey,
    records = [],
    readRecordIds = [],
    sourceEvidenceIds = [],
    reason = "",
    now = Date.now(),
  } = {},
) {
  assertMemoryLedger(ledger);
  const normalizedIdempotencyKey = requireDomainId(
    idempotencyKey,
    "idempotencyKey",
  );
  if (!Array.isArray(records) || records.length === 0) {
    throw new MemoryLedgerValidationError("ledger transaction requires records");
  }
  const normalizedReadRecordIds = normalizeStringArray(readRecordIds);
  const normalizedSourceEvidenceIds = normalizeStringArray(sourceEvidenceIds);
  const payloadFingerprint = hashDomainValue({
    records,
    readRecordIds: normalizedReadRecordIds,
    sourceEvidenceIds: normalizedSourceEvidenceIds,
    reason: String(reason || ""),
  });
  const index = buildMemoryLedgerIndex(ledger);
  const replayCommit = index.commitsByIdempotencyKey.get(normalizedIdempotencyKey);
  if (replayCommit) {
    if (String(replayCommit.payloadFingerprint) !== payloadFingerprint) {
      throw new MemoryLedgerConflictError("idempotency key was reused with another payload", {
        idempotencyKey: normalizedIdempotencyKey,
        existingCommitId: replayCommit.id,
      });
    }
    return {
      ledger,
      commit: replayCommit,
      appendedRecords: replayCommit.appendedRecordIds
        .map((id) => index.recordsById.get(id))
        .filter(Boolean),
      replayed: true,
    };
  }
  const expectedBase = Number(baseRevision);
  if (!Number.isInteger(expectedBase) || expectedBase !== Number(ledger.revision)) {
    throw new MemoryLedgerConflictError("memory ledger base revision changed", {
      expectedRevision: expectedBase,
      actualRevision: Number(ledger.revision),
    });
  }
  const missingReads = normalizedReadRecordIds.filter((id) => !index.recordsById.has(id));
  if (missingReads.length > 0) {
    throw new MemoryLedgerConflictError("memory ledger read set is stale", {
      missingRecordIds: missingReads,
    });
  }
  const transactionRecordsById = new Map(
    records
      .filter((record) => String(record?.id || "").trim())
      .map((record) => [String(record.id), record]),
  );
  const invalidSourceEvidenceIds = normalizedSourceEvidenceIds.filter((id) => {
    const record = transactionRecordsById.get(id) || index.recordsById.get(id);
    return record?.kind !== MEMORY_RECORD_KIND.EVIDENCE;
  });
  if (invalidSourceEvidenceIds.length > 0) {
    throw new MemoryLedgerValidationError("transaction source evidence is invalid", [
      ...invalidSourceEvidenceIds.map((id) => `missing source evidence: ${id}`),
    ]);
  }
  const appendedById = new Map();
  const issues = [];
  for (const record of records) {
    issues.push(...validateRecordShape(record, ledger, index, appendedById));
    const id = String(record?.id || "").trim();
    if (id) appendedById.set(id, record);
  }
  issues.push(...validateRecordReferences(records, index));
  if (issues.length > 0) {
    throw new MemoryLedgerValidationError("memory ledger transaction is invalid", issues);
  }
  const committedAt = normalizeTimestamp(now);
  const revision = Number(ledger.revision) + 1;
  const appendedRecords = records.map((record, ordinal) =>
    freezeDomainValue({
      ...cloneDomainValue(record, record),
      ledgerRevision: revision,
      ledgerOrdinal: ordinal,
    }),
  );
  const commit = freezeDomainValue(
    createLedgerCommitRecord({
      chatId: ledger.chatId,
      revision,
      baseRevision: Number(ledger.revision),
      parentCommitId: index.headCommit?.id || "",
      idempotencyKey: normalizedIdempotencyKey,
      payloadFingerprint,
      appendedRecordIds: appendedRecords.map((record) => record.id),
      readRecordIds: normalizedReadRecordIds,
      sourceEvidenceIds: normalizedSourceEvidenceIds,
      reason,
      createdAt: committedAt,
    }),
  );
  const nextLedger = freezeDomainValue({
    ...cloneDomainValue(ledger, ledger),
    revision,
    updatedAt: committedAt,
    records: [...ledger.records, ...appendedRecords, commit],
  });
  return { ledger: nextLedger, commit, appendedRecords, replayed: false };
}

export function inspectMemoryLedger(ledger) {
  try {
    assertMemoryLedger(ledger);
  } catch (error) {
    return {
      valid: false,
      error: error?.message || String(error),
      chatId: "",
      revision: 0,
      recordCount: 0,
      fingerprint: "",
    };
  }
  return {
    valid: true,
    error: "",
    chatId: ledger.chatId,
    revision: Number(ledger.revision),
    recordCount: ledger.records.length,
    fingerprint: hashDomainValue(stableStringify(ledger.records)),
  };
}
