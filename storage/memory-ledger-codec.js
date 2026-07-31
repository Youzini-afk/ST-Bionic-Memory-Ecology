import { MEMORY_LEDGER_VERSION, MEMORY_RECORD_KIND, createEmptyMemoryLedger } from "../domain/memory-contract.js";
import { cloneDomainValue, freezeDomainValue, hashDomainValue, stableStringify } from "../domain/memory-id.js";
import { assertMemoryLedger } from "../domain/memory-ledger.js";

export const MEMORY_LEDGER_HEAD_META_KEY = "bmeMemoryLedger.head";
export const MEMORY_LEDGER_RECORD_META_PREFIX = "bmeMemoryLedger.record.";

export class MemoryLedgerStorageCorruptionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MemoryLedgerStorageCorruptionError";
    this.code = "memory_ledger_storage_corrupt";
    this.details = details;
  }
}

export class MemoryLedgerStorageDivergenceError extends MemoryLedgerStorageCorruptionError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = "MemoryLedgerStorageDivergenceError";
    this.code = "memory_ledger_storage_diverged";
  }
}

export function memoryLedgerRecordMetaKey(recordId) {
  return `${MEMORY_LEDGER_RECORD_META_PREFIX}${encodeURIComponent(String(recordId || ""))}`;
}

export function memoryLedgerHeadFingerprint(head) {
  return head ? hashDomainValue(stableStringify(head)) : "empty";
}

export function isMemoryLedgerMetaKey(key = "") {
  const normalized = String(key || "");
  return normalized === MEMORY_LEDGER_HEAD_META_KEY ||
    normalized.startsWith(MEMORY_LEDGER_RECORD_META_PREFIX);
}

export function encodeMemoryLedgerSnapshotMeta(ledger) {
  assertMemoryLedger(ledger);
  if (Number(ledger.revision) === 0) return {};
  const commits = ledger.records.filter(
    (record) => record.kind === MEMORY_RECORD_KIND.COMMIT,
  );
  const headCommit = commits.at(-1) || null;
  if (!headCommit || Number(headCommit.revision) !== Number(ledger.revision)) {
    throw new MemoryLedgerStorageCorruptionError(
      "memory ledger cannot be encoded without its head commit",
      { chatId: ledger.chatId, revision: ledger.revision },
    );
  }
  const meta = {};
  for (const record of ledger.records) {
    meta[memoryLedgerRecordMetaKey(record.id)] = cloneDomainValue(record, record);
  }
  meta[MEMORY_LEDGER_HEAD_META_KEY] = {
    version: MEMORY_LEDGER_VERSION,
    chatId: ledger.chatId,
    revision: ledger.revision,
    headCommitId: headCommit.id,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    recordCount: ledger.records.length,
  };
  return meta;
}

export function encodeMemoryLedgerCommitPatch(previousLedger, commitResult) {
  assertMemoryLedger(previousLedger);
  const nextLedger = commitResult?.ledger;
  const commit = commitResult?.commit;
  assertMemoryLedger(nextLedger);
  if (!commit || commit.kind !== MEMORY_RECORD_KIND.COMMIT) {
    throw new TypeError("memory ledger commit result is required");
  }
  const runtimeMetaPatch = {};
  for (const record of [...(commitResult.appendedRecords || []), commit]) {
    runtimeMetaPatch[memoryLedgerRecordMetaKey(record.id)] = cloneDomainValue(record, record);
  }
  const head = {
    version: MEMORY_LEDGER_VERSION,
    chatId: nextLedger.chatId,
    revision: nextLedger.revision,
    headCommitId: commit.id,
    createdAt: nextLedger.createdAt,
    updatedAt: nextLedger.updatedAt,
    recordCount: nextLedger.records.length,
  };
  runtimeMetaPatch[MEMORY_LEDGER_HEAD_META_KEY] = head;
  return { head, runtimeMetaPatch };
}

function readStoredRecords(meta) {
  const recordsById = new Map();
  for (const [key, value] of Object.entries(meta || {})) {
    if (!key.startsWith(MEMORY_LEDGER_RECORD_META_PREFIX)) continue;
    const id = String(value?.id || "").trim();
    if (!id) {
      throw new MemoryLedgerStorageCorruptionError("stored memory record has no id", { key });
    }
    if (recordsById.has(id)) {
      throw new MemoryLedgerStorageCorruptionError("duplicate stored memory record id", { id });
    }
    recordsById.set(id, cloneDomainValue(value, value));
  }
  return recordsById;
}

export function decodeMemoryLedgerSnapshot(snapshot = {}, { chatId } = {}) {
  const normalizedChatId = String(chatId || snapshot?.meta?.chatId || "").trim();
  if (!normalizedChatId) throw new TypeError("memory ledger snapshot requires chatId");
  const meta = snapshot?.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
  const head = meta[MEMORY_LEDGER_HEAD_META_KEY] || null;
  if (!head) {
    const orphanRecordKeys = Object.keys(meta).filter((key) =>
      key.startsWith(MEMORY_LEDGER_RECORD_META_PREFIX),
    );
    if (orphanRecordKeys.length > 0) {
      throw new MemoryLedgerStorageDivergenceError(
        "memory ledger records exist without a head",
        { orphanRecordKeys },
      );
    }
    return freezeDomainValue(createEmptyMemoryLedger({ chatId: normalizedChatId }));
  }
  if (Number(head.version) !== MEMORY_LEDGER_VERSION || head.chatId !== normalizedChatId) {
    throw new MemoryLedgerStorageCorruptionError("memory ledger head identity mismatch", {
      expectedChatId: normalizedChatId,
      head,
    });
  }
  const recordsById = readStoredRecords(meta);
  const commits = [...recordsById.values()]
    .filter((record) => record.kind === MEMORY_RECORD_KIND.COMMIT)
    .sort((left, right) => Number(left.revision) - Number(right.revision));
  if (commits.length !== Number(head.revision)) {
    throw new MemoryLedgerStorageDivergenceError("memory ledger commit count diverged", {
      headRevision: head.revision,
      commitRevisions: commits.map((commit) => commit.revision),
    });
  }

  const orderedRecords = [];
  const referencedIds = new Set();
  let parentCommitId = "";
  for (let index = 0; index < commits.length; index += 1) {
    const commit = commits[index];
    const expectedRevision = index + 1;
    if (
      Number(commit.revision) !== expectedRevision ||
      Number(commit.baseRevision) !== expectedRevision - 1 ||
      String(commit.parentCommitId || "") !== parentCommitId
    ) {
      throw new MemoryLedgerStorageDivergenceError("memory ledger commit chain diverged", {
        commitId: commit.id,
        expectedRevision,
        parentCommitId,
      });
    }
    for (const recordId of commit.appendedRecordIds || []) {
      const record = recordsById.get(recordId);
      if (!record || record.kind === MEMORY_RECORD_KIND.COMMIT) {
        throw new MemoryLedgerStorageCorruptionError("memory ledger commit references a missing record", {
          commitId: commit.id,
          recordId,
        });
      }
      orderedRecords.push(record);
      referencedIds.add(recordId);
    }
    orderedRecords.push(commit);
    referencedIds.add(commit.id);
    parentCommitId = commit.id;
  }
  if (parentCommitId !== String(head.headCommitId || "")) {
    throw new MemoryLedgerStorageDivergenceError("memory ledger head commit mismatch", {
      expected: head.headCommitId,
      actual: parentCommitId,
    });
  }
  const orphanCommitIds = [...recordsById.values()]
    .filter(
      (record) =>
        record.kind === MEMORY_RECORD_KIND.COMMIT && !referencedIds.has(record.id),
    )
    .map((record) => record.id);
  if (orphanCommitIds.length > 0) {
    throw new MemoryLedgerStorageDivergenceError("memory ledger contains orphan commits", {
      orphanCommitIds,
    });
  }
  if (Number(head.recordCount) !== orderedRecords.length) {
    throw new MemoryLedgerStorageCorruptionError("memory ledger record count mismatch", {
      expected: head.recordCount,
      actual: orderedRecords.length,
    });
  }
  const ledger = {
    version: MEMORY_LEDGER_VERSION,
    chatId: normalizedChatId,
    revision: Number(head.revision),
    createdAt: Number(head.createdAt) || 0,
    updatedAt: Number(head.updatedAt) || Number(head.createdAt) || 0,
    records: orderedRecords,
  };
  assertMemoryLedger(ledger);
  return freezeDomainValue(ledger);
}
