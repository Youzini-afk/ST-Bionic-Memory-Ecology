import assert from "node:assert/strict";

import { AGENT_EVENT_TYPE, createEmptyMemoryLedger } from "../domain/memory-contract.js";
import { appendMemoryLedgerTransaction, assertMemoryLedger } from "../domain/memory-ledger.js";
import {
  createAgentEvent,
  createMemoryRevision,
  createTurnEvidence,
} from "../domain/memory-records.js";
import {
  MemoryLedgerStorageDivergenceError,
  decodeMemoryLedgerSnapshot,
  encodeMemoryLedgerSnapshotMeta,
  memoryLedgerRecordMetaKey,
} from "../storage/memory-ledger-codec.js";
import { mergeMemoryLedgerSnapshotMeta } from "../storage/memory-ledger-cloud-merge.js";

const chatId = "chat:cloud-ledger";

function append(ledger, idempotencyKey, records, now) {
  return appendMemoryLedgerTransaction(ledger, {
    baseRevision: ledger.revision,
    idempotencyKey,
    records,
    sourceEvidenceIds: records
      .filter((record) => record.kind === "evidence")
      .map((record) => record.id),
    now,
  }).ledger;
}

function snapshot(ledger, extraMeta = {}) {
  return {
    meta: {
      chatId,
      revision: Number(extraMeta.revision || ledger.revision),
      ...extraMeta,
      ...encodeMemoryLedgerSnapshotMeta(ledger),
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: {},
  };
}

const commonEvidence = createTurnEvidence({
  chatId,
  turnId: "turn:common",
  userText: "Common",
  assistantText: "Common evidence",
  createdAt: 10,
});
let common = createEmptyMemoryLedger({ chatId, now: 1 });
common = append(common, "common", [commonEvidence], 10);

const localMemory = createMemoryRevision({
  chatId,
  memoryId: "memory:local",
  memoryType: "fact",
  fields: { text: "local" },
  evidenceIds: [commonEvidence.id],
  createdAt: 20,
});
const remoteMemory = createMemoryRevision({
  chatId,
  memoryId: "memory:remote",
  memoryType: "fact",
  fields: { text: "remote" },
  evidenceIds: [commonEvidence.id],
  createdAt: 30,
});
const local = append(common, "local-branch", [localMemory], 20);
const remote = append(common, "remote-branch", [remoteMemory], 30);

const descendant = mergeMemoryLedgerSnapshotMeta(snapshot(common), snapshot(local), { chatId });
assert.equal(descendant.relationship, "remote-descendant");
assert.equal(descendant.ledger.revision, local.revision);
const reverseDescendant = mergeMemoryLedgerSnapshotMeta(snapshot(local), snapshot(common), { chatId });
assert.equal(reverseDescendant.relationship, "local-descendant");
assert.equal(reverseDescendant.ledger.revision, local.revision);

const diverged = mergeMemoryLedgerSnapshotMeta(snapshot(local), snapshot(remote), { chatId });
assert.equal(diverged.relationship, "merged-divergence");
assert.equal(diverged.commonRevision, 1);
assert.equal(diverged.ledger.revision, 3);
assertMemoryLedger(diverged.ledger);
assert.ok(diverged.ledger.records.some((record) => record.id === localMemory.id));
assert.ok(diverged.ledger.records.some((record) => record.id === remoteMemory.id));
assert.deepEqual(
  mergeMemoryLedgerSnapshotMeta(snapshot(remote), snapshot(local), { chatId }).meta,
  diverged.meta,
);
assert.deepEqual(
  decodeMemoryLedgerSnapshot({ meta: diverged.meta }, { chatId }),
  diverged.ledger,
);

const originalDivergedCommitIds = new Set([
  local.records.at(-1).id,
  remote.records.at(-1).id,
]);
for (const commitId of originalDivergedCommitIds) {
  assert.equal(Object.hasOwn(diverged.meta, memoryLedgerRecordMetaKey(commitId)), false);
}

const started = createAgentEvent({
  chatId,
  runId: "run:conflict",
  taskId: "task:conflict",
  agentKind: "memory-steward",
  sequence: 0,
  eventType: AGENT_EVENT_TYPE.RUN_STARTED,
  createdAt: 40,
});
let agentCommon = append(common, "agent-started", [started], 40);
const localRequested = createAgentEvent({
  chatId,
  runId: started.runId,
  taskId: started.taskId,
  agentKind: started.agentKind,
  sequence: 1,
  previousEventId: started.id,
  eventType: AGENT_EVENT_TYPE.MODEL_REQUESTED,
  payload: { branch: "local" },
  createdAt: 41,
});
const remoteRequested = createAgentEvent({
  chatId,
  runId: started.runId,
  taskId: started.taskId,
  agentKind: started.agentKind,
  sequence: 1,
  previousEventId: started.id,
  eventType: AGENT_EVENT_TYPE.MODEL_REQUESTED,
  payload: { branch: "remote" },
  createdAt: 42,
});
const localAgent = append(agentCommon, "agent-local", [localRequested], 41);
const remoteAgent = append(agentCommon, "agent-remote", [remoteRequested], 42);
assert.throws(
  () => mergeMemoryLedgerSnapshotMeta(snapshot(localAgent), snapshot(remoteAgent), { chatId }),
  (error) =>
    error instanceof MemoryLedgerStorageDivergenceError &&
    /cannot be merged/.test(error.message),
);

const orphanMeta = {
  chatId,
  [memoryLedgerRecordMetaKey(commonEvidence.id)]: commonEvidence,
};
assert.throws(
  () => decodeMemoryLedgerSnapshot({ meta: orphanMeta }, { chatId }),
  MemoryLedgerStorageDivergenceError,
);

console.log("memory ledger cloud merge tests passed");
