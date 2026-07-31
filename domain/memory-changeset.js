import { MEMORY_RECORD_KIND, requireDomainId } from "./memory-contract.js";
import { cloneDomainValue, createDomainId, hashDomainValue } from "./memory-id.js";
import {
  MemoryLedgerConflictError,
  MemoryLedgerValidationError,
  appendMemoryLedgerTransaction,
  buildMemoryLedgerIndex,
} from "./memory-ledger.js";
import { materializeMemoryLedger } from "./memory-materializer.js";
import { createMemoryRevision, createRelationRevision } from "./memory-records.js";

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
  if (Number(changeSet?.baseRevision) !== Number(ledger?.revision)) {
    issues.push("change set base revision is stale");
  }
  const index = buildMemoryLedgerIndex(ledger);
  for (const id of changeSet?.readRecordIds || []) {
    if (!index.recordsById.has(String(id))) issues.push(`missing read record: ${id}`);
  }
  const activeEvidenceIds = materializeMemoryLedger(ledger).evidence.activeEvidenceIds;
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
  return { valid: issues.length === 0, issues, records };
}

export function commitMemoryChangeSet(ledger, changeSet) {
  const validation = validateMemoryChangeSet(ledger, changeSet);
  if (!validation.valid) {
    const stale = validation.issues.some((issue) =>
      /base revision|missing read record|inactive source evidence/.test(issue),
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
  const sourceEvidenceIds = [
    ...new Set([
      ...(changeSet.sourceEvidenceIds || []),
      ...validation.records.flatMap((record) => record.evidenceIds || []),
    ]),
  ];
  const result = appendMemoryLedgerTransaction(ledger, {
    baseRevision: changeSet.baseRevision,
    idempotencyKey: changeSet.idempotencyKey,
    records: validation.records,
    readRecordIds: changeSet.readRecordIds,
    sourceEvidenceIds,
    reason: changeSet.reason,
    now: changeSet.createdAt,
  });
  return {
    ...result,
    changeSetFingerprint: hashDomainValue(changeSet),
    memoryRevisionIds: result.appendedRecords
      .filter((record) => record.kind === MEMORY_RECORD_KIND.MEMORY_REVISION)
      .map((record) => record.id),
    relationRevisionIds: result.appendedRecords
      .filter((record) => record.kind === MEMORY_RECORD_KIND.RELATION_REVISION)
      .map((record) => record.id),
  };
}
