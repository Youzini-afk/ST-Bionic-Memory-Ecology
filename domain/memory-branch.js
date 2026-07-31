import { MEMORY_RECORD_KIND, createEmptyMemoryLedger } from "./memory-contract.js";
import { createDomainId, hashDomainValue } from "./memory-id.js";
import { appendMemoryLedgerTransaction, buildMemoryLedgerIndex } from "./memory-ledger.js";
import { materializeMemoryLedger } from "./memory-materializer.js";
import {
  createMemoryRevision,
  createMigrationRecord,
  createRelationRevision,
  createTurnEvidence,
} from "./memory-records.js";

function inBranchPrefix(evidence, cutoffFloor, includedTurnIds) {
  if (includedTurnIds?.size) return includedTurnIds.has(evidence.turnId);
  if (
    cutoffFloor === null ||
    cutoffFloor === undefined ||
    cutoffFloor === "" ||
    !Number.isFinite(Number(cutoffFloor))
  ) {
    return true;
  }
  const assistantFloor = Number(evidence?.source?.assistantFloor);
  return !Number.isFinite(assistantFloor) || assistantFloor <= Number(cutoffFloor);
}

function ledgerOrder(left, right) {
  const revisionDelta = Number(left?.ledgerRevision || 0) - Number(right?.ledgerRevision || 0);
  if (revisionDelta !== 0) return revisionDelta;
  return Number(left?.ledgerOrdinal || 0) - Number(right?.ledgerOrdinal || 0);
}

export function forkMemoryLedger(
  sourceLedger,
  {
    targetChatId,
    targetHostChatId = "",
    cutoffFloor = null,
    includedTurnIds = [],
    branchId = "",
    now = Date.now(),
  } = {},
) {
  const normalizedTargetChatId = String(targetChatId || "").trim();
  if (!normalizedTargetChatId) throw new TypeError("branch targetChatId is required");
  if (normalizedTargetChatId === sourceLedger.chatId) {
    throw new TypeError("branch target must use a distinct chatId");
  }
  const targetLedger = createEmptyMemoryLedger({ chatId: normalizedTargetChatId, now });
  const sourceIndex = buildMemoryLedgerIndex(sourceLedger);
  const sourceView = materializeMemoryLedger(sourceLedger);
  const includedTurns = new Set((includedTurnIds || []).map((value) => String(value)));
  const sourceEvidence = sourceView.evidence.activeEvidence
    .filter((evidence) => inBranchPrefix(evidence, cutoffFloor, includedTurns))
    .sort(ledgerOrder);
  const evidenceIdMap = new Map();
  const revisionIdMap = new Map();
  const records = [];
  const normalizedBranchId = String(
    branchId ||
      createDomainId("branch", {
        sourceChatId: sourceLedger.chatId,
        sourceRevision: sourceLedger.revision,
        targetChatId: normalizedTargetChatId,
        cutoffFloor,
      }),
  );

  for (const evidence of sourceEvidence) {
    const cloned = createTurnEvidence({
      chatId: normalizedTargetChatId,
      turnId: evidence.turnId,
      hostChatId: targetHostChatId,
      userMessageId: evidence.source?.userMessageId,
      assistantMessageId: evidence.source?.assistantMessageId,
      userFloor: evidence.source?.userFloor,
      assistantFloor: evidence.source?.assistantFloor,
      assistantSwipeId: evidence.source?.assistantSwipeId,
      generationId: evidence.source?.generationId,
      groupGenerationId: evidence.source?.groupGenerationId,
      userText: evidence.content?.user,
      assistantText: evidence.content?.assistant,
      normalizedUserText: evidence.content?.normalizedUser,
      normalizedAssistantText: evidence.content?.normalizedAssistant,
      contentHash: evidence.contentHash,
      historyFingerprint: evidence.historyFingerprint,
      metadata: {
        ...(evidence.metadata || {}),
        branchId: normalizedBranchId,
        branchSourceChatId: sourceLedger.chatId,
        branchSourceEvidenceId: evidence.id,
      },
      createdAt: evidence.createdAt,
    });
    evidenceIdMap.set(evidence.id, cloned.id);
    records.push(cloned);
  }

  const sourceRevisions = [
    ...(sourceIndex.recordsByKind.get(MEMORY_RECORD_KIND.MEMORY_REVISION) || []),
    ...(sourceIndex.recordsByKind.get(MEMORY_RECORD_KIND.RELATION_REVISION) || []),
  ].sort(ledgerOrder);
  const pending = [...sourceRevisions];
  const droppedRevisionIds = new Set();
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let index = 0; index < pending.length; index += 1) {
      const revision = pending[index];
      const mappedEvidenceIds = (revision.evidenceIds || []).map((id) => evidenceIdMap.get(id));
      if (mappedEvidenceIds.some((id) => !id)) {
        droppedRevisionIds.add(revision.id);
        pending.splice(index, 1);
        index -= 1;
        progressed = true;
        continue;
      }
      const mappedDependencies = (revision.dependencyRevisionIds || []).map((id) =>
        revisionIdMap.get(id),
      );
      if (mappedDependencies.some((id) => !id)) {
        if (
          (revision.dependencyRevisionIds || []).some((id) =>
            droppedRevisionIds.has(id),
          )
        ) {
          droppedRevisionIds.add(revision.id);
          pending.splice(index, 1);
          index -= 1;
          progressed = true;
        }
        continue;
      }
      if (
        revision.parentRevisionId &&
        pending.some((candidate) => candidate.id === revision.parentRevisionId)
      ) {
        continue;
      }
      const parentRevisionId = revision.parentRevisionId
        ? revisionIdMap.get(revision.parentRevisionId) || ""
        : "";
      let cloned = null;
      if (revision.kind === MEMORY_RECORD_KIND.MEMORY_REVISION) {
        cloned = createMemoryRevision({
          ...revision,
          id: undefined,
          chatId: normalizedTargetChatId,
          parentRevisionId,
          evidenceIds: mappedEvidenceIds,
          dependencyRevisionIds: mappedDependencies,
          reason: `branch-import:${normalizedBranchId}`,
        });
      } else if (revision.kind === MEMORY_RECORD_KIND.RELATION_REVISION) {
        cloned = createRelationRevision({
          ...revision,
          id: undefined,
          chatId: normalizedTargetChatId,
          parentRevisionId,
          evidenceIds: mappedEvidenceIds,
          dependencyRevisionIds: mappedDependencies,
          metadata: {
            ...(revision.metadata || {}),
            branchId: normalizedBranchId,
            branchSourceRevisionId: revision.id,
          },
        });
      }
      if (!cloned) continue;
      revisionIdMap.set(revision.id, cloned.id);
      records.push(cloned);
      pending.splice(index, 1);
      index -= 1;
      progressed = true;
    }
  }

  records.push(
    createMigrationRecord({
      chatId: normalizedTargetChatId,
      migrationId: "legacy-graph-to-ledger",
      sourceKind: "vnext-ledger-branch",
      sourceVersion: String(sourceLedger.version || ""),
      converterVersion: "branch-v1",
      sourceFingerprint: hashDomainValue({
        sourceChatId: sourceLedger.chatId,
        sourceRevision: sourceLedger.revision,
        branchId: normalizedBranchId,
        cutoffFloor,
        recordIds: records.map((record) => record.id),
      }),
      importedRecordIds: records.map((record) => record.id),
      metadata: {
        branchId: normalizedBranchId,
        branchSourceChatId: sourceLedger.chatId,
        branchSourceRevision: sourceLedger.revision,
      },
      createdAt: now,
    }),
  );
  const transaction = {
    baseRevision: 0,
    idempotencyKey: `branch-import:${normalizedBranchId}`,
    records,
    sourceEvidenceIds: [...evidenceIdMap.values()],
    reason: `branch-import:${sourceLedger.chatId}@${sourceLedger.revision}`,
    now,
  };
  const result = appendMemoryLedgerTransaction(targetLedger, transaction);
  return {
    ...result,
    transaction,
    branchId: normalizedBranchId,
    evidenceIdMap,
    revisionIdMap,
  };
}
