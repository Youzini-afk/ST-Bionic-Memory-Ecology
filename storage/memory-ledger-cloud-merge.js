import { MEMORY_RECORD_KIND, createEmptyMemoryLedger } from "../domain/memory-contract.js";
import {
  cloneDomainValue,
  hashDomainValue,
  stableStringify,
} from "../domain/memory-id.js";
import {
  MemoryLedgerValidationError,
  appendMemoryLedgerTransaction,
  assertMemoryLedger,
  buildMemoryLedgerIndex,
  createMemoryLedgerReplayTransaction,
} from "../domain/memory-ledger.js";
import {
  MemoryLedgerStorageDivergenceError,
  decodeMemoryLedgerSnapshot,
  encodeMemoryLedgerSnapshotMeta,
  isMemoryLedgerMetaKey,
} from "./memory-ledger-codec.js";

function transactionPayload(ledger, commit) {
  const index = buildMemoryLedgerIndex(ledger);
  return {
    idempotencyKey: String(commit?.idempotencyKey || ""),
    payloadFingerprint: String(commit?.payloadFingerprint || ""),
    records: (commit?.appendedRecordIds || []).map((id) => {
      const record = cloneDomainValue(index.recordsById.get(id), null);
      if (record) {
        delete record.ledgerRevision;
        delete record.ledgerOrdinal;
      }
      return record;
    }),
    readRecordIds: [...(commit?.readRecordIds || [])],
    sourceEvidenceIds: [...(commit?.sourceEvidenceIds || [])],
    reason: String(commit?.reason || ""),
    createdAt: Number(commit?.createdAt || 0),
  };
}

function transactionFingerprint(ledger, commit) {
  return hashDomainValue(transactionPayload(ledger, commit));
}

function commits(ledger) {
  const byRevision = buildMemoryLedgerIndex(ledger).commitsByRevision;
  return Array.from({ length: Number(ledger.revision) }, (_, index) =>
    byRevision.get(index + 1),
  );
}

function commonPrefixRevision(localLedger, remoteLedger) {
  const localCommits = commits(localLedger);
  const remoteCommits = commits(remoteLedger);
  const length = Math.min(localCommits.length, remoteCommits.length);
  let common = 0;
  while (common < length) {
    const localCommit = localCommits[common];
    const remoteCommit = remoteCommits[common];
    if (
      transactionFingerprint(localLedger, localCommit) !==
      transactionFingerprint(remoteLedger, remoteCommit)
    ) {
      break;
    }
    common += 1;
  }
  return common;
}

function ledgerAtRevision(ledger, revision) {
  const wanted = Math.max(0, Math.min(Number(ledger.revision), Number(revision) || 0));
  if (wanted === 0) {
    return createEmptyMemoryLedger({ chatId: ledger.chatId, now: ledger.createdAt });
  }
  const records = [];
  for (const record of ledger.records) {
    records.push(cloneDomainValue(record, record));
    if (
      record.kind === MEMORY_RECORD_KIND.COMMIT &&
      Number(record.revision) === wanted
    ) {
      break;
    }
  }
  const head = records.at(-1);
  const result = {
    version: ledger.version,
    chatId: ledger.chatId,
    revision: wanted,
    createdAt: ledger.createdAt,
    updatedAt: Number(head?.createdAt || ledger.createdAt),
    records,
  };
  assertMemoryLedger(result);
  return result;
}

function branchSuffix(ledger, commonRevision) {
  return commits(ledger)
    .slice(commonRevision)
    .map((commit) => ({
      ledger,
      commit,
      fingerprint: transactionFingerprint(ledger, commit),
    }));
}

function branchFingerprint(entries) {
  return hashDomainValue(entries.map((entry) => entry.fingerprint));
}

function recordWithoutLedgerOrder(record) {
  const value = cloneDomainValue(record, record);
  delete value.ledgerRevision;
  delete value.ledgerOrdinal;
  return value;
}

function planReplay(merged, entry) {
  const replay = createMemoryLedgerReplayTransaction(entry.ledger, entry.commit);
  const index = buildMemoryLedgerIndex(merged);
  const records = [];
  for (const record of replay.records) {
    const existing = index.recordsById.get(record.id);
    if (!existing) {
      records.push(record);
      continue;
    }
    if (
      stableStringify(recordWithoutLedgerOrder(existing)) !==
      stableStringify(recordWithoutLedgerOrder(record))
    ) {
      throw new MemoryLedgerStorageDivergenceError(
        "cloud memory ledgers contain different records with the same id",
        { recordId: record.id },
      );
    }
  }
  if (records.length === 0) return null;
  return {
    ...replay,
    baseRevision: merged.revision,
    idempotencyKey: `cloud-merge:${entry.fingerprint}`,
    records,
    readRecordIds: replay.readRecordIds.filter((id) => index.recordsById.has(id)),
    sourceEvidenceIds: replay.sourceEvidenceIds.filter((id) =>
      records.some((record) => record.id === id) || index.recordsById.has(id),
    ),
  };
}

function mergeDivergedLedgers(localLedger, remoteLedger, commonRevision) {
  let merged = ledgerAtRevision(localLedger, commonRevision);
  const branches = [
    branchSuffix(localLedger, commonRevision),
    branchSuffix(remoteLedger, commonRevision),
  ].sort((left, right) =>
    branchFingerprint(left).localeCompare(branchFingerprint(right), "en"),
  );
  try {
    for (const branch of branches) {
      for (const entry of branch) {
        const replay = planReplay(merged, entry);
        if (!replay) continue;
        merged = appendMemoryLedgerTransaction(merged, replay).ledger;
      }
    }
    assertMemoryLedger(merged);
    return merged;
  } catch (error) {
    if (error instanceof MemoryLedgerStorageDivergenceError) throw error;
    if (error instanceof MemoryLedgerValidationError || error?.code === "memory_ledger_conflict") {
      throw new MemoryLedgerStorageDivergenceError(
        "cloud memory ledger branches cannot be merged without changing durable history",
        { commonRevision, cause: error?.message || String(error) },
      );
    }
    throw error;
  }
}

export function withoutMemoryLedgerMeta(meta = {}) {
  return Object.fromEntries(
    Object.entries(meta || {}).filter(([key]) => !isMemoryLedgerMetaKey(key)),
  );
}

export function mergeMemoryLedgerSnapshotMeta(
  localSnapshot = {},
  remoteSnapshot = {},
  { chatId = "" } = {},
) {
  const normalizedChatId = String(
    chatId || localSnapshot?.meta?.chatId || remoteSnapshot?.meta?.chatId || "",
  ).trim();
  if (!normalizedChatId) throw new TypeError("cloud memory ledger merge requires chatId");
  const localLedger = decodeMemoryLedgerSnapshot(localSnapshot, { chatId: normalizedChatId });
  const remoteLedger = decodeMemoryLedgerSnapshot(remoteSnapshot, { chatId: normalizedChatId });
  const commonRevision = commonPrefixRevision(localLedger, remoteLedger);
  let ledger;
  let relationship;
  if (commonRevision === Number(localLedger.revision)) {
    ledger = remoteLedger;
    relationship = localLedger.revision === remoteLedger.revision ? "equal" : "remote-descendant";
  } else if (commonRevision === Number(remoteLedger.revision)) {
    ledger = localLedger;
    relationship = "local-descendant";
  } else {
    ledger = mergeDivergedLedgers(localLedger, remoteLedger, commonRevision);
    relationship = "merged-divergence";
  }
  return {
    ledger,
    relationship,
    commonRevision,
    meta: encodeMemoryLedgerSnapshotMeta(ledger),
  };
}
