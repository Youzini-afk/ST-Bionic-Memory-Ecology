import {
  MEMORY_INBOX_KIND,
  MEMORY_INBOX_STATUS,
  requireDomainId,
} from "./memory-contract.js";
import { createDomainId, hashDomainValue, normalizeTimestamp } from "./memory-id.js";
import { appendMemoryLedgerTransaction } from "./memory-ledger.js";
import { materializeInboxState } from "./memory-materializer.js";
import { createInboxItemRevision, createTurnEvidence } from "./memory-records.js";

const ALLOWED_TRANSITIONS = Object.freeze({
  [MEMORY_INBOX_STATUS.PENDING]: new Set([
    MEMORY_INBOX_STATUS.CLAIMED,
    MEMORY_INBOX_STATUS.CANCELLED,
    MEMORY_INBOX_STATUS.DEFERRED,
  ]),
  [MEMORY_INBOX_STATUS.DEFERRED]: new Set([
    MEMORY_INBOX_STATUS.CLAIMED,
    MEMORY_INBOX_STATUS.CANCELLED,
    MEMORY_INBOX_STATUS.PENDING,
  ]),
  [MEMORY_INBOX_STATUS.CLAIMED]: new Set([
    MEMORY_INBOX_STATUS.COMPLETED,
    MEMORY_INBOX_STATUS.DEFERRED,
    MEMORY_INBOX_STATUS.CANCELLED,
  ]),
  [MEMORY_INBOX_STATUS.COMPLETED]: new Set(),
  [MEMORY_INBOX_STATUS.CANCELLED]: new Set(),
});

export function admitTurnEvidence(
  ledger,
  {
    evidence: evidenceInput = {},
    inboxId = "",
    dedupeKey = "",
    availableAt = undefined,
    idempotencyKey = "",
    now = Date.now(),
  } = {},
) {
  const evidence = createTurnEvidence({
    ...evidenceInput,
    chatId: ledger.chatId,
    createdAt: evidenceInput.createdAt ?? now,
  });
  const resolvedDedupeKey = String(
    dedupeKey || `turn:${evidence.turnId}:${evidence.contentHash}`,
  );
  const existing = materializeInboxState(ledger).items.find(
    (item) => item.dedupeKey === resolvedDedupeKey,
  );
  if (existing) {
    const existingEvidence = ledger.records.find((record) => record.id === evidence.id) || null;
    return {
      ledger,
      evidence: existingEvidence,
      inboxItem: existing,
      admitted: false,
      replayed: true,
    };
  }
  const resolvedInboxId = String(
    inboxId || createDomainId("inbox", { chatId: ledger.chatId, dedupeKey: resolvedDedupeKey }),
  );
  const inboxItem = createInboxItemRevision({
    chatId: ledger.chatId,
    inboxId: resolvedInboxId,
    inboxKind: MEMORY_INBOX_KIND.TURN_AVAILABLE,
    status: MEMORY_INBOX_STATUS.PENDING,
    sequence: 0,
    dedupeKey: resolvedDedupeKey,
    sourceRecordIds: [evidence.id],
    payload: {
      evidenceId: evidence.id,
      turnId: evidence.turnId,
      contentHash: evidence.contentHash,
    },
    createdAt: now,
    availableAt: availableAt ?? now,
  });
  const result = appendMemoryLedgerTransaction(ledger, {
    baseRevision: ledger.revision,
    idempotencyKey:
      idempotencyKey || `admit-turn:${hashDomainValue(resolvedDedupeKey)}`,
    records: [evidence, inboxItem],
    sourceEvidenceIds: [evidence.id],
    reason: "admit-turn-evidence",
    now,
  });
  return {
    ...result,
    evidence: result.appendedRecords.find((record) => record.id === evidence.id),
    inboxItem: result.appendedRecords.find((record) => record.id === inboxItem.id),
    admitted: !result.replayed,
  };
}

export function transitionInboxItem(
  ledger,
  {
    inboxId,
    status,
    expectedStatus = "",
    claimId = "",
    claimOwner = "",
    availableAt = undefined,
    note = "",
    payload = undefined,
    idempotencyKey = "",
    now = Date.now(),
  } = {},
) {
  const normalizedInboxId = requireDomainId(inboxId, "inboxId");
  const state = materializeInboxState(ledger);
  const current = state.latestByInboxId.get(normalizedInboxId);
  if (!current) throw new Error(`inbox item not found: ${normalizedInboxId}`);
  if (expectedStatus && current.status !== expectedStatus) {
    throw new Error(`inbox status changed: ${current.status}`);
  }
  const targetStatus = String(status || "");
  if (!ALLOWED_TRANSITIONS[current.status]?.has(targetStatus)) {
    throw new Error(`invalid inbox transition: ${current.status} -> ${targetStatus}`);
  }
  const next = createInboxItemRevision({
    ...current,
    id: undefined,
    status: targetStatus,
    sequence: Number(current.sequence) + 1,
    previousRevisionId: current.id,
    attempt:
      targetStatus === MEMORY_INBOX_STATUS.CLAIMED
        ? Number(current.attempt || 0) + 1
        : Number(current.attempt || 0),
    claimId:
      targetStatus === MEMORY_INBOX_STATUS.CLAIMED
        ? requireDomainId(claimId, "claimId")
        : claimId || current.claimId,
    claimOwner:
      targetStatus === MEMORY_INBOX_STATUS.CLAIMED
        ? requireDomainId(claimOwner, "claimOwner")
        : claimOwner || current.claimOwner,
    availableAt:
      targetStatus === MEMORY_INBOX_STATUS.DEFERRED
        ? normalizeTimestamp(availableAt, now)
        : current.availableAt,
    note,
    payload: payload === undefined ? current.payload : payload,
    createdAt: now,
  });
  const result = appendMemoryLedgerTransaction(ledger, {
    baseRevision: ledger.revision,
    idempotencyKey:
      idempotencyKey ||
      `inbox:${normalizedInboxId}:${next.sequence}:${targetStatus}`,
    records: [next],
    readRecordIds: [current.id],
    sourceEvidenceIds: current.sourceRecordIds,
    reason: `inbox-${targetStatus}`,
    now,
  });
  return {
    ...result,
    inboxItem: result.appendedRecords[0],
  };
}

export function listRunnableInboxItems(ledger, { now = Date.now() } = {}) {
  return materializeInboxState(ledger).pending.filter(
    (item) => Number(item.availableAt || 0) <= Number(now),
  );
}
