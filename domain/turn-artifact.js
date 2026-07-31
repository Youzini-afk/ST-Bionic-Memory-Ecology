import { fingerprintMaterializedMemoryState } from "./memory-changeset.js";
import {
  TURN_ARTIFACT_KIND,
  TURN_ARTIFACT_STATUS,
  isTurnArtifactKind,
  requireDomainId,
} from "./memory-contract.js";
import {
  cloneDomainValue,
  hashDomainValue,
  normalizeStringArray,
} from "./memory-id.js";
import {
  MemoryLedgerConflictError,
  buildMemoryLedgerIndex,
  createMemoryLedgerReplayTransaction,
} from "./memory-ledger.js";
import { materializeMemoryLedger } from "./memory-materializer.js";
import { createTurnArtifact } from "./memory-records.js";

export function createTurnInputFingerprint({
  turnId,
  userMessage = "",
  recentMessages = [],
  historyFingerprint = "",
} = {}) {
  return hashDomainValue({
    turnId: requireDomainId(turnId, "turnId"),
    userMessage: String(userMessage || "").replace(/\r\n/g, "\n").trim(),
    recentMessages: (recentMessages || []).map((message) =>
      String(message || "").replace(/\r\n/g, "\n").trim(),
    ),
    historyFingerprint: String(historyFingerprint || "").trim(),
  });
}

export function findReusableTurnArtifact(
  ledger,
  {
    turnId,
    artifactKind = TURN_ARTIFACT_KIND.RECALL,
    inputFingerprint,
    historyFingerprint = "",
  } = {},
) {
  const normalizedTurnId = requireDomainId(turnId, "turnId");
  const normalizedKind = String(artifactKind || TURN_ARTIFACT_KIND.RECALL);
  if (!isTurnArtifactKind(normalizedKind)) {
    throw new TypeError(`invalid turn artifact kind: ${normalizedKind}`);
  }
  const normalizedInputFingerprint = requireDomainId(
    inputFingerprint,
    "inputFingerprint",
  );
  const expectedHistory = String(historyFingerprint || "").trim();
  const artifact = materializeMemoryLedger(ledger).turnArtifacts.get(
    normalizedTurnId,
    normalizedKind,
    normalizedInputFingerprint,
    expectedHistory,
  );
  if (!artifact) return null;
  // A turn artifact is a deliberate snapshot for this exact user-turn
  // version. Later, unrelated Memory Steward commits do not invalidate a
  // reroll; referenced evidence/revisions still must remain valid.
  if (
    expectedHistory &&
    String(artifact.historyFingerprint || "").trim() !== expectedHistory
  ) {
    return null;
  }
  return cloneDomainValue(artifact, artifact);
}

export function turnArtifactToRecallResult(artifact) {
  if (!artifact) return null;
  const injectionText = String(artifact.injectionText || "").trim();
  return {
    ...cloneDomainValue(artifact.result, {}),
    status: "completed",
    artifactStatus: artifact.status,
    didRecall: artifact.status === TURN_ARTIFACT_STATUS.READY,
    empty: artifact.status === TURN_ARTIFACT_STATUS.EMPTY,
    artifactId: artifact.id,
    artifactKind: artifact.artifactKind,
    chatId: artifact.chatId,
    turnId: artifact.turnId,
    inputFingerprint: artifact.inputFingerprint,
    historyFingerprint: artifact.historyFingerprint,
    memoryStateFingerprint: artifact.memoryStateFingerprint,
    selectedNodeIds: [...(artifact.selectedMemoryIds || [])],
    selectedMemoryIds: [...(artifact.selectedMemoryIds || [])],
    candidateMemoryIds: [...(artifact.candidateMemoryIds || [])],
    injectionText,
    source: artifact.source || "recall-artifact",
    persistedReuse: true,
  };
}

export function turnArtifactToPlannerResult(artifact) {
  if (!artifact) return null;
  return {
    ...cloneDomainValue(artifact.result, {}),
    status: "completed",
    artifactStatus: artifact.status,
    empty: artifact.status === TURN_ARTIFACT_STATUS.EMPTY,
    artifactId: artifact.id,
    artifactKind: artifact.artifactKind,
    chatId: artifact.chatId,
    turnId: artifact.turnId,
    inputFingerprint: artifact.inputFingerprint,
    historyFingerprint: artifact.historyFingerprint,
    memoryStateFingerprint: artifact.memoryStateFingerprint,
    contentText: String(artifact.contentText || ""),
    source: artifact.source || "planner-artifact",
    persistedReuse: true,
  };
}

export function planTurnArtifactCommit(
  ledger,
  {
    turnId,
    artifactKind = TURN_ARTIFACT_KIND.RECALL,
    inputFingerprint,
    historyFingerprint = "",
    expectedMemoryStateFingerprint,
    selectedMemoryIds = [],
    candidateMemoryIds = [],
    sourceArtifactIds = [],
    contentText = null,
    injectionText = "",
    evidenceIds = [],
    dependencyRevisionIds = [],
    agentRunId = "",
    agentTaskId = "",
    source = "recall-agent",
    result = {},
    now = Date.now(),
  } = {},
) {
  const reusable = findReusableTurnArtifact(ledger, {
    turnId,
    artifactKind,
    inputFingerprint,
    historyFingerprint,
  });
  if (reusable) {
    const commit = buildMemoryLedgerIndex(ledger).commitsByIdempotencyKey.get(
      `turn-artifact:${reusable.id}`,
    );
    return {
      artifact: reusable,
      transaction: commit
        ? createMemoryLedgerReplayTransaction(ledger, commit)
        : null,
      reused: true,
    };
  }
  const view = materializeMemoryLedger(ledger);
  const index = buildMemoryLedgerIndex(ledger);
  const currentMemoryStateFingerprint = fingerprintMaterializedMemoryState(view);
  const normalizedArtifactKind = String(artifactKind || TURN_ARTIFACT_KIND.RECALL);
  const normalizedSourceArtifactIds = normalizeStringArray(sourceArtifactIds);
  let artifactMemoryStateFingerprint = currentMemoryStateFingerprint;
  let selectedIds = normalizeStringArray(selectedMemoryIds);
  let candidateIds = normalizeStringArray(candidateMemoryIds);
  let selectedHeads = [];

  if (normalizedArtifactKind === TURN_ARTIFACT_KIND.PLANNER) {
    const recallArtifact = normalizedSourceArtifactIds
      .map((artifactId) => index.recordsById.get(artifactId))
      .find(
        (record) =>
          record?.artifactKind === TURN_ARTIFACT_KIND.RECALL &&
          record.turnId === turnId &&
          record.inputFingerprint === inputFingerprint &&
          String(record.historyFingerprint || "") === String(historyFingerprint || ""),
      );
    const recallValidation = recallArtifact
      ? view.turnArtifacts.validationByArtifactId.get(recallArtifact.id)
      : null;
    if (!recallArtifact || recallValidation?.valid !== true) {
      throw new MemoryLedgerConflictError(
        "planner artifact requires an active Recall artifact for the same turn version",
        { sourceArtifactIds: normalizedSourceArtifactIds },
      );
    }
    artifactMemoryStateFingerprint = String(recallArtifact.memoryStateFingerprint || "");
    if (
      String(expectedMemoryStateFingerprint || "") !==
      artifactMemoryStateFingerprint
    ) {
      throw new MemoryLedgerConflictError(
        "planner artifact memory snapshot does not match its Recall artifact",
        {
          expectedMemoryStateFingerprint: String(expectedMemoryStateFingerprint || ""),
          recallMemoryStateFingerprint: artifactMemoryStateFingerprint,
        },
      );
    }
    const recalledMemoryIds = normalizeStringArray(recallArtifact.selectedMemoryIds).sort();
    const requestedMemoryIds = [...selectedIds].sort();
    if (
      requestedMemoryIds.length > 0 &&
      requestedMemoryIds.join("\u0000") !== recalledMemoryIds.join("\u0000")
    ) {
      throw new MemoryLedgerConflictError(
        "planner artifact selected memories differ from its Recall artifact",
        { requestedMemoryIds, recalledMemoryIds },
      );
    }
    selectedIds = normalizeStringArray(recallArtifact.selectedMemoryIds);
    candidateIds = normalizeStringArray(recallArtifact.candidateMemoryIds);
  } else {
    selectedHeads = selectedIds.map((memoryId) =>
      view.memories.byMemoryId.get(memoryId),
    );
  }

  if (
    normalizedArtifactKind !== TURN_ARTIFACT_KIND.PLANNER &&
    String(expectedMemoryStateFingerprint || "") !== currentMemoryStateFingerprint
  ) {
    throw new MemoryLedgerConflictError(
      "memory state changed before the turn artifact was published",
      {
        expectedMemoryStateFingerprint: String(expectedMemoryStateFingerprint || ""),
        actualMemoryStateFingerprint: currentMemoryStateFingerprint,
      },
    );
  }
  const resolvedContentText = String(contentText ?? injectionText).trim();
  const missingMemoryIds = selectedIds.filter((_, index) => !selectedHeads[index]);
  if (
    normalizedArtifactKind !== TURN_ARTIFACT_KIND.PLANNER &&
    missingMemoryIds.length > 0
  ) {
    throw new MemoryLedgerConflictError(
      "selected memories changed before the turn artifact was published",
      { missingMemoryIds },
    );
  }
  const artifact = createTurnArtifact({
    chatId: ledger.chatId,
    turnId,
    artifactKind,
    inputFingerprint,
    historyFingerprint,
    memoryStateFingerprint: artifactMemoryStateFingerprint,
    status: resolvedContentText
      ? TURN_ARTIFACT_STATUS.READY
      : TURN_ARTIFACT_STATUS.EMPTY,
    selectedMemoryIds: selectedIds,
    candidateMemoryIds: candidateIds,
    sourceArtifactIds: normalizedSourceArtifactIds,
    contentText: resolvedContentText,
    injectionText,
    evidenceIds,
    dependencyRevisionIds: normalizeStringArray([
      ...dependencyRevisionIds,
      ...selectedHeads.filter(Boolean).map((revision) => revision.id),
    ]),
    agentRunId,
    agentTaskId,
    source,
    result,
    createdAt: now,
  });
  return {
    artifact,
    reused: false,
    transaction: {
      baseRevision: ledger.revision,
      idempotencyKey: `turn-artifact:${artifact.id}`,
      records: [artifact],
      readRecordIds: normalizeStringArray([
        ...dependencyRevisionIds,
        ...normalizedSourceArtifactIds,
        ...selectedHeads.filter(Boolean).map((revision) => revision.id),
      ]),
      sourceEvidenceIds: normalizeStringArray(evidenceIds),
      reason: `turn-artifact:${artifactKind}`,
      now,
    },
  };
}
