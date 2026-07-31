import {
  MEMORY_RECORD_KIND,
  MEMORY_REVISION_STATUS,
  requireDomainId,
} from "./memory-contract.js";
import { cloneDomainValue, createDomainId, hashDomainValue } from "./memory-id.js";
import {
  MemoryLedgerConflictError,
  MemoryLedgerValidationError,
  appendMemoryLedgerTransaction,
  buildMemoryLedgerIndex,
} from "./memory-ledger.js";
import { materializeMemoryLedger } from "./memory-materializer.js";
import { createMemoryRevision, createRelationRevision } from "./memory-records.js";

export function fingerprintMaterializedMemoryState(ledgerOrView) {
  const view = ledgerOrView?.memories
    ? ledgerOrView
    : materializeMemoryLedger(ledgerOrView);
  return hashDomainValue({
    activeEvidenceIds: [...(view.evidence?.activeEvidenceIds || [])].sort(),
    memoryHeads: [...(view.memories?.heads || new Map()).entries()]
      .map(([memoryId, revision]) => [memoryId, revision?.id || ""])
      .sort(([left], [right]) => left.localeCompare(right, "en")),
    relationHeads: [...(view.relations?.heads || new Map()).entries()]
      .map(([relationId, revision]) => [relationId, revision?.id || ""])
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  });
}

export function createMemoryChangeSet(input = {}) {
  const chatId = requireDomainId(input.chatId, "changeSet.chatId");
  const baseRevision = Number(input.baseRevision);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    throw new TypeError("changeSet.baseRevision must be a non-negative integer");
  }
  const operations = Array.isArray(input.operations)
    ? cloneDomainValue(input.operations, [])
    : [];
  if (operations.length === 0) throw new TypeError("changeSet.operations is required");
  const id = String(
    input.id ||
      createDomainId("change-set", {
        chatId,
        baseRevision,
        operations,
        taskId: input.taskId || "",
      }),
  );
  return {
    id,
    chatId,
    baseRevision,
    taskId: String(input.taskId || "").trim(),
    idempotencyKey: String(input.idempotencyKey || `change-set:${id}`),
    readRecordIds: Array.isArray(input.readRecordIds) ? [...input.readRecordIds] : [],
    readStateFingerprint: String(input.readStateFingerprint || "").trim(),
    sourceEvidenceIds: Array.isArray(input.sourceEvidenceIds)
      ? [...input.sourceEvidenceIds]
      : [],
    operations,
    reason: String(input.reason || "memory-agent-change-set"),
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : Date.now(),
  };
}
function compileOperation(changeSet, operation, operationIndex) {
  const type = String(operation?.type || "").trim();
  const common = {
    ...operation,
    chatId: changeSet.chatId,
    agentTaskId: operation.agentTaskId || changeSet.taskId,
    id:
      operation.id ||
      createDomainId(type || "operation", {
        changeSetId: changeSet.id,
        operationIndex,
        operation,
      }),
    createdAt: operation.createdAt ?? changeSet.createdAt,
  };
  if (type === "memory_revision") return createMemoryRevision(common);
  if (type === "relation_revision") return createRelationRevision(common);
  throw new TypeError(`unsupported memory change operation: ${type}`);
}

export function validateMemoryChangeSet(ledger, changeSet) {
  const issues = [];
  if (changeSet?.chatId !== ledger?.chatId) issues.push("change set belongs to another chat");
  if (Number(changeSet?.baseRevision) > Number(ledger?.revision)) {
    issues.push("change set base revision is ahead of the ledger");
  }
  const index = buildMemoryLedgerIndex(ledger);
  for (const id of changeSet?.readRecordIds || []) {
    if (!index.recordsById.has(String(id))) issues.push(`missing read record: ${id}`);
  }
  const view = materializeMemoryLedger(ledger);
  const activeEvidenceIds = view.evidence.activeEvidenceIds;
  if (Number(changeSet?.baseRevision) < Number(ledger?.revision)) {
    if (!changeSet?.readStateFingerprint) {
      issues.push("stale change set has no memory state fingerprint");
    } else if (
      changeSet.readStateFingerprint !== fingerprintMaterializedMemoryState(view)
    ) {
      issues.push("memory state changed after the Agent read it");
    }
  }
  for (const id of changeSet?.sourceEvidenceIds || []) {
    if (!activeEvidenceIds.has(String(id))) issues.push(`inactive source evidence: ${id}`);
  }
  const records = [];
  for (let indexValue = 0; indexValue < (changeSet?.operations || []).length; indexValue++) {
    try {
      records.push(compileOperation(changeSet, changeSet.operations[indexValue], indexValue));
    } catch (error) {
      issues.push(error?.message || String(error));
    }
  }
  const memoryOperations = new Set();
  const relationOperations = new Set();
  const stagedMemoryIds = new Set();
  for (const record of records) {
    if (record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION) {
      if (memoryOperations.has(record.memoryId)) {
        issues.push(`multiple revisions for memory ${record.memoryId} in one change set`);
        continue;
      }
      memoryOperations.add(record.memoryId);
      stagedMemoryIds.add(record.memoryId);
      const currentHead = view.memories.heads.get(record.memoryId) || null;
      if (currentHead && record.parentRevisionId !== currentHead.id) {
        issues.push(`memory ${record.memoryId} head changed`);
      } else if (!currentHead && record.parentRevisionId) {
        issues.push(`new memory ${record.memoryId} cannot have a parent revision`);
      }
    }
    if (record.kind === MEMORY_RECORD_KIND.RELATION_REVISION) {
      if (relationOperations.has(record.relationId)) {
        issues.push(`multiple revisions for relation ${record.relationId} in one change set`);
        continue;
      }
      relationOperations.add(record.relationId);
      const currentHead = view.relations.heads.get(record.relationId) || null;
      if (currentHead && record.parentRevisionId !== currentHead.id) {
        issues.push(`relation ${record.relationId} head changed`);
      } else if (!currentHead && record.parentRevisionId) {
        issues.push(`new relation ${record.relationId} cannot have a parent revision`);
      }
    }
  }
  const availableMemoryIds = new Set([
    ...view.memories.heads.keys(),
    ...stagedMemoryIds,
  ]);
  const activeMemoryIds = new Set(
    view.memories.active.map((revision) => revision.memoryId),
  );
  for (const record of records) {
    if (record.kind !== MEMORY_RECORD_KIND.MEMORY_REVISION) continue;
    if (record.status === MEMORY_REVISION_STATUS.ARCHIVED) {
      activeMemoryIds.delete(record.memoryId);
    } else {
      activeMemoryIds.add(record.memoryId);
    }
  }
  for (const record of records) {
    if (record.kind !== MEMORY_RECORD_KIND.RELATION_REVISION) continue;
    if (!availableMemoryIds.has(record.fromMemoryId)) {
      issues.push(`relation ${record.relationId} has missing source memory`);
    }
    if (!availableMemoryIds.has(record.toMemoryId)) {
      issues.push(`relation ${record.relationId} has missing target memory`);
    }
    if (
      record.status !== MEMORY_REVISION_STATUS.ARCHIVED &&
      !activeMemoryIds.has(record.fromMemoryId)
    ) {
      issues.push(`relation ${record.relationId} has inactive source memory`);
    }
    if (
      record.status !== MEMORY_REVISION_STATUS.ARCHIVED &&
      !activeMemoryIds.has(record.toMemoryId)
    ) {
      issues.push(`relation ${record.relationId} has inactive target memory`);
    }
  }
  return { valid: issues.length === 0, issues, records };
}

function throwInvalidChangeSet(validation) {
  if (!validation.valid) {
    const stale = validation.issues.some((issue) =>
      /base revision|missing read record|inactive source evidence|state changed|head changed|no memory state fingerprint/.test(issue),
    );
    if (stale) {
      throw new MemoryLedgerConflictError("memory change set is stale", {
        issues: validation.issues,
      });
    }
    throw new MemoryLedgerValidationError(
      "memory change set is invalid",
      validation.issues,
    );
  }
}

export function planMemoryChangeSetCommit(ledger, changeSet) {
  const ledgerIndex = buildMemoryLedgerIndex(ledger);
  const existingCommit = ledgerIndex.commitsByIdempotencyKey.get(
    String(changeSet?.idempotencyKey || ""),
  );
  const validation = existingCommit
    ? {
        valid: true,
        issues: [],
        records: (changeSet?.operations || []).map((operation, index) =>
          compileOperation(changeSet, operation, index),
        ),
      }
    : validateMemoryChangeSet(ledger, changeSet);
  throwInvalidChangeSet(validation);
  const sourceEvidenceIds = [
    ...new Set([
      ...(changeSet.sourceEvidenceIds || []),
      ...validation.records.flatMap((record) => record.evidenceIds || []),
    ]),
  ];
  const rebased = existingCommit
    ? Number(existingCommit.baseRevision) !== Number(changeSet.baseRevision)
    : Number(changeSet.baseRevision) !== Number(ledger.revision);
  return {
    transaction: {
      baseRevision: existingCommit ? changeSet.baseRevision : ledger.revision,
      idempotencyKey: changeSet.idempotencyKey,
      records: validation.records,
      readRecordIds: changeSet.readRecordIds,
      sourceEvidenceIds,
      reason: changeSet.reason,
      now: changeSet.createdAt,
    },
    validation,
    existingCommit,
    changeSetFingerprint: hashDomainValue(changeSet),
    rebased,
    rebasedFromRevision: rebased ? Number(changeSet.baseRevision) : null,
  };
}

export function commitMemoryChangeSet(ledger, changeSet) {
  const planned = planMemoryChangeSetCommit(ledger, changeSet);
  const result = appendMemoryLedgerTransaction(ledger, planned.transaction);
  return {
    ...result,
    changeSetFingerprint: planned.changeSetFingerprint,
    memoryRevisionIds: result.appendedRecords
      .filter((record) => record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION)
      .map((record) => record.id),
    relationRevisionIds: result.appendedRecords
      .filter((record) => record.kind === MEMORY_RECORD_KIND.RELATION_REVISION)
      .map((record) => record.id),
    rebased: planned.rebased,
    rebasedFromRevision: planned.rebasedFromRevision,
  };
}
