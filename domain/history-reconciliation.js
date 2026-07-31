import {
  MEMORY_INBOX_KIND,
  MEMORY_INBOX_STATUS,
  MEMORY_RECORD_KIND,
} from "./memory-contract.js";
import { createDomainId, hashDomainValue } from "./memory-id.js";
import { appendMemoryLedgerTransaction, buildMemoryLedgerIndex } from "./memory-ledger.js";
import { materializeMemoryLedger } from "./memory-materializer.js";
import {
  createEvidenceActivation,
  createEvidenceInvalidation,
  createInboxItemRevision,
  createTurnEvidence,
} from "./memory-records.js";

function normalizeTurn(turn = {}, index = 0) {
  const assistantText = String(turn.assistantText ?? turn.assistant ?? "");
  if (!assistantText.trim()) return null;
  return {
    turnId: String(turn.turnId || "").trim(),
    hostTurnKey: String(turn.hostTurnKey || "").trim(),
    logicalSlotKey: String(turn.logicalSlotKey || "").trim(),
    userText: String(turn.userText ?? turn.user ?? ""),
    assistantText,
    normalizedUserText: String(turn.normalizedUserText ?? turn.userText ?? turn.user ?? "").trim(),
    normalizedAssistantText: String(
      turn.normalizedAssistantText ?? turn.assistantText ?? turn.assistant ?? "",
    ).trim(),
    hostChatId: String(turn.hostChatId || "").trim(),
    userMessageId: String(turn.userMessageId || "").trim(),
    assistantMessageId: String(turn.assistantMessageId || "").trim(),
    userFloor:
      turn.userFloor !== null && turn.userFloor !== undefined && turn.userFloor !== "" &&
      Number.isFinite(Number(turn.userFloor))
        ? Math.floor(Number(turn.userFloor))
        : null,
    assistantFloor:
      turn.assistantFloor !== null &&
      turn.assistantFloor !== undefined &&
      turn.assistantFloor !== "" &&
      Number.isFinite(Number(turn.assistantFloor))
      ? Math.floor(Number(turn.assistantFloor))
      : null,
    assistantSwipeId:
      turn.assistantSwipeId !== null &&
      turn.assistantSwipeId !== undefined &&
      turn.assistantSwipeId !== "" &&
      Number.isFinite(Number(turn.assistantSwipeId))
      ? Math.floor(Number(turn.assistantSwipeId))
      : null,
    generationId: String(turn.generationId || "").trim(),
    groupGenerationId: String(turn.groupGenerationId || "").trim(),
    speaker: String(turn.speaker || "").trim(),
    historyFingerprint: String(turn.historyFingerprint || "").trim(),
    metadata:
      turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
        ? { ...turn.metadata }
        : {},
    ordinal: index,
  };
}

function compareEvidenceDialogueOrder(left, right) {
  const floorDelta = Number(left?.source?.assistantFloor ?? Number.MAX_SAFE_INTEGER) -
    Number(right?.source?.assistantFloor ?? Number.MAX_SAFE_INTEGER);
  if (floorDelta !== 0) return floorDelta;
  const revisionDelta = Number(left?.ledgerRevision || 0) - Number(right?.ledgerRevision || 0);
  if (revisionDelta !== 0) return revisionDelta;
  return Number(left?.ledgerOrdinal || 0) - Number(right?.ledgerOrdinal || 0);
}

function evidenceMatchKey(record, key) {
  if (key === "hostTurnKey") return String(record?.metadata?.hostTurnKey || "").trim();
  if (key === "logicalSlotKey") return String(record?.metadata?.logicalSlotKey || "").trim();
  if (key === "user") return String(record?.content?.normalizedUser || "").trim();
  return "";
}

function findUnclaimed(records, claimedIds, predicate) {
  return records.find((record) => !claimedIds.has(record.id) && predicate(record)) || null;
}

function createCandidateEvidence(chatId, turn, turnId, now) {
  return createTurnEvidence({
    chatId,
    turnId,
    hostChatId: turn.hostChatId,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    userFloor: turn.userFloor,
    assistantFloor: turn.assistantFloor,
    assistantSwipeId: turn.assistantSwipeId,
    generationId: turn.generationId,
    groupGenerationId: turn.groupGenerationId,
    userText: turn.userText,
    assistantText: turn.assistantText,
    normalizedUserText: turn.normalizedUserText,
    normalizedAssistantText: turn.normalizedAssistantText,
    historyFingerprint: turn.historyFingerprint,
    metadata: {
      ...turn.metadata,
      speaker: turn.speaker,
      hostTurnKey: turn.hostTurnKey,
      logicalSlotKey: turn.logicalSlotKey,
    },
    createdAt: now,
  });
}

export function assignHistoryTurnIds(ledger, turns = [], { now = Date.now() } = {}) {
  const normalizedTurns = turns.map(normalizeTurn).filter(Boolean);
  const index = buildMemoryLedgerIndex(ledger);
  const evidence = [
    ...(index.recordsByKind.get(MEMORY_RECORD_KIND.EVIDENCE) || []),
  ].sort(compareEvidenceDialogueOrder);
  const claimedIds = new Set();
  const assigned = [];
  const userOccurrences = new Map();
  let previousTurnId = "root";

  for (const turn of normalizedTurns) {
    const probe = createCandidateEvidence(ledger.chatId, turn, "probe", now);
    let matched = null;
    if (turn.turnId) {
      matched = findUnclaimed(evidence, claimedIds, (record) => record.turnId === turn.turnId);
    }
    if (!matched && turn.hostTurnKey) {
      matched = findUnclaimed(
        evidence,
        claimedIds,
        (record) => evidenceMatchKey(record, "hostTurnKey") === turn.hostTurnKey,
      );
    }
    if (!matched) {
      matched = findUnclaimed(
        evidence,
        claimedIds,
        (record) => record.contentHash === probe.contentHash,
      );
    }
    if (!matched && turn.logicalSlotKey) {
      matched = findUnclaimed(
        evidence,
        claimedIds,
        (record) => evidenceMatchKey(record, "logicalSlotKey") === turn.logicalSlotKey,
      );
    }
    if (!matched && turn.normalizedUserText) {
      matched = findUnclaimed(
        evidence,
        claimedIds,
        (record) => evidenceMatchKey(record, "user") === turn.normalizedUserText,
      );
    }

    const occurrence = (userOccurrences.get(turn.normalizedUserText) || 0) + 1;
    userOccurrences.set(turn.normalizedUserText, occurrence);
    const turnId = String(
      turn.turnId ||
        matched?.turnId ||
        createDomainId("turn", {
          chatId: ledger.chatId,
          hostTurnKey: turn.hostTurnKey,
          logicalSlotKey: turn.logicalSlotKey,
          previousTurnId,
          user: turn.normalizedUserText,
          speaker: turn.speaker,
          occurrence,
        }),
    );
    if (matched) claimedIds.add(matched.id);
    previousTurnId = turnId;
    assigned.push({
      ...turn,
      turnId,
      evidence: createCandidateEvidence(ledger.chatId, turn, turnId, now),
      matchedEvidenceId: matched?.id || "",
    });
  }
  return assigned;
}

export function planHistoryReconciliation(
  ledger,
  {
    turns = [],
    mutationId = "",
    reason = "history-reconciled",
    historyFingerprint = "",
    now = Date.now(),
  } = {},
) {
  const assignedTurns = assignHistoryTurnIds(ledger, turns, { now });
  const index = buildMemoryLedgerIndex(ledger);
  const view = materializeMemoryLedger(ledger);
  const evidenceRecords = index.recordsByKind.get(MEMORY_RECORD_KIND.EVIDENCE) || [];
  const evidenceById = new Map(evidenceRecords.map((record) => [record.id, record]));
  const desiredById = new Map(assignedTurns.map((turn) => [turn.evidence.id, turn.evidence]));
  const activeIds = view.evidence.activeEvidenceIds;
  const normalizedFingerprint = String(
    historyFingerprint || hashDomainValue([...desiredById.keys()]),
  );
  const normalizedMutationId = String(
    mutationId ||
      createDomainId("history-mutation", {
        chatId: ledger.chatId,
        fingerprint: normalizedFingerprint,
        reason,
      }),
  );
  const records = [];
  const invalidatedEvidenceIds = [];
  const activatedEvidenceIds = [];
  const admittedEvidenceIds = [];
  const inboxState = view.inbox;

  for (const evidence of view.evidence.activeEvidence) {
    if (desiredById.has(evidence.id)) continue;
    records.push(
      createEvidenceInvalidation({
        chatId: ledger.chatId,
        evidenceId: evidence.id,
        reason,
        mutationId: normalizedMutationId,
        sourceFingerprint: normalizedFingerprint,
        createdAt: now,
      }),
    );
    invalidatedEvidenceIds.push(evidence.id);
  }

  for (const turn of assignedTurns) {
    const desired = turn.evidence;
    const existing = evidenceById.get(desired.id);
    if (!existing) {
      records.push(desired);
      admittedEvidenceIds.push(desired.id);
      const dedupeKey = `turn:${desired.turnId}:${desired.contentHash}`;
      if (!inboxState.items.some((item) => item.dedupeKey === dedupeKey)) {
        const inboxId = createDomainId("inbox", { chatId: ledger.chatId, dedupeKey });
        records.push(
          createInboxItemRevision({
            chatId: ledger.chatId,
            inboxId,
            inboxKind: MEMORY_INBOX_KIND.TURN_AVAILABLE,
            status: MEMORY_INBOX_STATUS.PENDING,
            sequence: 0,
            dedupeKey,
            sourceRecordIds: [desired.id],
            payload: {
              evidenceId: desired.id,
              turnId: desired.turnId,
              contentHash: desired.contentHash,
            },
            createdAt: now,
            availableAt: now,
          }),
        );
      }
    } else if (!activeIds.has(existing.id)) {
      records.push(
        createEvidenceActivation({
          chatId: ledger.chatId,
          evidenceId: existing.id,
          reason: "history-selection-restored",
          mutationId: normalizedMutationId,
          sourceFingerprint: normalizedFingerprint,
          createdAt: now,
        }),
      );
      activatedEvidenceIds.push(existing.id);
    }
  }

  const affectedEvidenceIds = [
    ...new Set([
      ...invalidatedEvidenceIds,
      ...activatedEvidenceIds,
      ...admittedEvidenceIds,
    ]),
  ];
  if (invalidatedEvidenceIds.length > 0 || activatedEvidenceIds.length > 0) {
    const dedupeKey = `history:${normalizedFingerprint}`;
    if (!inboxState.items.some((item) => item.dedupeKey === dedupeKey)) {
      const inboxId = createDomainId("inbox", { chatId: ledger.chatId, dedupeKey });
      records.push(
        createInboxItemRevision({
          chatId: ledger.chatId,
          inboxId,
          inboxKind: MEMORY_INBOX_KIND.HISTORY_INVALIDATED,
          status: MEMORY_INBOX_STATUS.PENDING,
          sequence: 0,
          dedupeKey,
          sourceRecordIds: affectedEvidenceIds,
          payload: {
            reason,
            mutationId: normalizedMutationId,
            historyFingerprint: normalizedFingerprint,
            invalidatedEvidenceIds,
            activatedEvidenceIds,
            admittedEvidenceIds,
          },
          createdAt: now,
          availableAt: now,
        }),
      );
    }
  }

  return {
    changed: records.length > 0,
    records,
    assignedTurns,
    invalidatedEvidenceIds,
    activatedEvidenceIds,
    admittedEvidenceIds,
    historyFingerprint: normalizedFingerprint,
    mutationId: normalizedMutationId,
    transaction: records.length
      ? {
          baseRevision: ledger.revision,
          idempotencyKey: `history:${hashDomainValue({
            chatId: ledger.chatId,
            mutationId: normalizedMutationId,
            records: records.map((record) => record.id),
          })}`,
          records,
          readRecordIds: view.evidence.activeEvidence.map((record) => record.id),
          sourceEvidenceIds: affectedEvidenceIds,
          reason,
          now,
        }
      : null,
  };
}

export function reconcileMemoryLedgerHistory(ledger, input = {}) {
  const plan = planHistoryReconciliation(ledger, input);
  if (!plan.transaction) {
    return { ...plan, ledger, commit: null, appendedRecords: [], replayed: false };
  }
  return {
    ...plan,
    ...appendMemoryLedgerTransaction(ledger, plan.transaction),
  };
}
