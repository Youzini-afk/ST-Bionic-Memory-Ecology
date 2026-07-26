import assert from "node:assert/strict";

import { createEmptyGraph, serializeGraph } from "../graph/graph.js";
import {
  applyAuthorityCheckpointToStore,
  buildAuthorityCheckpointImportSnapshot,
  buildAuthorityConsistencyAudit,
  buildAuthorityConsistencyRepairPlan,
  isAuthorityReplicaSyncRepairAction,
} from "../maintenance/authority-consistency.js";

const graph = createEmptyGraph();
graph.chatId = "chat-a";
graph.meta = { ...(graph.meta || {}), chatId: "chat-a", revision: 7 };
graph.nodes.push({
  id: "node-a",
  type: "memory",
  seq: 1,
  seqRange: [1, 1],
  fields: { title: "Node A" },
  updatedAt: Date.now(),
});

const checkpoint = {
  chatId: "chat-a",
  revision: 7,
  integrity: "integrity-a",
  persistedAt: "2026-04-28T08:00:00.000Z",
  serializedGraph: serializeGraph(graph),
};

const prepared = buildAuthorityCheckpointImportSnapshot(checkpoint, {
  path: "user/files/checkpoint.json",
  source: "authority-blob-restore",
});
assert.equal(prepared.ok, true);
assert.equal(prepared.snapshot.meta.chatId, "chat-a");
assert.equal(prepared.snapshot.meta.revision, 7);
assert.equal(prepared.snapshot.meta.authorityCheckpointPath, "user/files/checkpoint.json");
assert.equal(prepared.snapshot.nodes.length, 1);

const missingSerialized = buildAuthorityCheckpointImportSnapshot({
  chatId: "chat-a",
  revision: 7,
});
assert.equal(missingSerialized.ok, false);
assert.equal(missingSerialized.reason, "checkpoint-serialized-graph-missing");

const imported = [];
const restoreResult = await applyAuthorityCheckpointToStore(
  {
    async open() {
      return true;
    },
    async importSnapshot(snapshot, options) {
      imported.push({ snapshot, options });
      return { revision: snapshot.meta.revision, imported: { nodes: snapshot.nodes.length } };
    },
  },
  checkpoint,
  { markSyncDirty: false },
);
assert.equal(restoreResult.ok, true);
assert.equal(restoreResult.restored, true);
assert.equal(imported.length, 1);
assert.equal(imported[0].options.mode, "replace");
assert.equal(imported[0].options.markSyncDirty, false);

const auditAligned = buildAuthorityConsistencyAudit({
  updatedAt: "2026-04-28T08:20:00.000Z",
  chatId: "chat-a",
  collectionId: "st-bme::chat-a",
  capability: {
    blobReady: true,
  },
  runtimeGraph: {
    meta: { revision: 7 },
    nodes: [{ id: "node-a" }],
    edges: [],
    vectorIndexState: {
      collectionId: "st-bme::chat-a",
      dirty: false,
    },
  },
  graphPersistenceState: {
    chatId: "chat-a",
    revision: 7,
    authorityBlobCheckpointPath: "user/files/checkpoint.json",
  },
  sqlSnapshot: {
    meta: { revision: 7, nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
    nodes: [],
    edges: [],
    tombstones: [],
  },
  triviumStat: {
    revision: 7,
    itemCount: 1,
    linkCount: 0,
    namespace: "st-bme::chat-a",
  },
  blobResult: {
    ok: true,
    exists: true,
    path: "user/files/checkpoint.json",
    checkpoint,
  },
});
assert.equal(auditAligned.summary.level, "success");
assert.equal(auditAligned.issues.length, 0);
assert.equal(auditAligned.drift.checkpointRestorable, true);
assert.equal(auditAligned.actions.includes("restore-from-authority-blob-checkpoint"), false);
assert.equal(auditAligned.summary.dataSafety, "saved");
const alignedRepairPlan = buildAuthorityConsistencyRepairPlan(auditAligned);
assert.equal(alignedRepairPlan.ok, false);
assert.equal(alignedRepairPlan.stepCount, 0);

const auditDrift = buildAuthorityConsistencyAudit({
  chatId: "chat-a",
  collectionId: "st-bme::chat-a",
  capability: {
    blobReady: true,
  },
  runtimeGraph: {
    meta: { revision: 9 },
    nodes: [],
    edges: [],
    vectorIndexState: {
      collectionId: "st-bme::chat-a",
      dirty: true,
    },
  },
  graphPersistenceState: {
    chatId: "chat-a",
    revision: 9,
  },
  sqlSnapshot: {
    meta: { revision: 8, nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
  },
  triviumStat: {
    revision: 7,
    namespace: "st-bme::chat-a",
  },
  blobResult: {
    ok: true,
    exists: false,
    path: "user/files/checkpoint.json",
  },
});
assert.equal(auditDrift.summary.level, "warning");
assert.ok(auditDrift.issues.some((issue) => issue.code === "sql-runtime-revision-drift"));
assert.ok(auditDrift.issues.some((issue) => issue.code === "vector-dirty"));
assert.ok(auditDrift.actions.includes("rebuild-authority-trivium"));
assert.ok(auditDrift.actions.includes("write-authority-checkpoint"));
const driftRepairPlan = buildAuthorityConsistencyRepairPlan(auditDrift);
assert.equal(driftRepairPlan.ok, true);
assert.equal(driftRepairPlan.requiresConfirmation, false);
assert.deepEqual(
  driftRepairPlan.steps.map((step) => step.action),
  [
    "write-authority-checkpoint",
    "rebuild-authority-trivium",
  ],
);

const auditSqlAheadReplicasBehind = buildAuthorityConsistencyAudit({
  chatId: "chat-a",
  collectionId: "st-bme::chat-a",
  capability: {
    blobReady: true,
  },
  runtimeGraph: {
    meta: { revision: 2 },
    nodes: [{ id: "node-a" }],
    edges: [],
    vectorIndexState: {
      collectionId: "st-bme::chat-a",
      dirty: false,
    },
  },
  graphPersistenceState: {
    chatId: "chat-a",
    revision: 2,
    authorityBlobCheckpointPath: "user/files/checkpoint.json",
    authorityBlobCheckpointRevision: 0,
  },
  sqlSnapshot: {
    meta: { revision: 2, nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
  },
  triviumStat: {
    revision: 0,
    namespace: "st-bme::chat-a",
  },
  blobResult: {
    ok: true,
    exists: true,
    path: "user/files/checkpoint.json",
    checkpoint: {
      chatId: "chat-a",
      revision: 0,
      serializedGraph: serializeGraph(createEmptyGraph()),
    },
  },
});
assert.equal(auditSqlAheadReplicasBehind.summary.level, "warning");
assert.equal(auditSqlAheadReplicasBehind.summary.label, "副本待同步");
assert.equal(auditSqlAheadReplicasBehind.summary.labelKey, "authority.summary.replicasPendingSync");
assert.equal(auditSqlAheadReplicasBehind.summary.dataSafety, "saved-replicas-behind");
assert.equal(auditSqlAheadReplicasBehind.summary.backupRedundancy, "degraded");
assert.equal(auditSqlAheadReplicasBehind.summary.searchQuality, "degraded");
assert.ok(auditSqlAheadReplicasBehind.issues.some((issue) => issue.code === "blob-checkpoint-behind"));
assert.ok(auditSqlAheadReplicasBehind.issues.some((issue) => issue.code === "trivium-replica-behind"));
assert.ok(auditSqlAheadReplicasBehind.issues.some((issue) => issue.messageKey === "authority.audit.blobBehindSql"));
assert.ok(auditSqlAheadReplicasBehind.issues.some((issue) => issue.messageKey === "authority.audit.triviumBehindSql"));
assert.ok(auditSqlAheadReplicasBehind.actions.includes("write-authority-checkpoint"));
assert.ok(auditSqlAheadReplicasBehind.actions.includes("rebuild-authority-trivium"));
assert.equal(auditSqlAheadReplicasBehind.actions.includes("restore-from-authority-blob-checkpoint"), false);
assert.equal(auditSqlAheadReplicasBehind.drift.checkpointRestorable, false);
const sqlAheadRepairPlan = buildAuthorityConsistencyRepairPlan(auditSqlAheadReplicasBehind);
assert.equal(sqlAheadRepairPlan.ok, true);
assert.equal(sqlAheadRepairPlan.requiresConfirmation, false);
assert.equal(sqlAheadRepairPlan.summary.labelKey, "authority.repair.summaryLabel");
assert.deepEqual(
  sqlAheadRepairPlan.steps.map((step) => step.action),
  [
    "write-authority-checkpoint",
    "rebuild-authority-trivium",
  ],
);
assert.deepEqual(
  sqlAheadRepairPlan.steps.map((step) => step.labelKey),
  [
    "authority.repair.syncCheckpoint",
    "authority.repair.syncTrivium",
  ],
);

const restoreRepairPlan = buildAuthorityConsistencyRepairPlan({
  issues: [
    {
      severity: "warning",
      code: "sql-runtime-revision-drift",
      message: "SQL revision drift",
    },
  ],
  actions: ["restore-from-authority-blob-checkpoint"],
  summary: {
    level: "warning",
    detail: "runtime / SQL drift",
  },
});
assert.equal(restoreRepairPlan.ok, true);
assert.equal(restoreRepairPlan.requiresConfirmation, true);
assert.deepEqual(
  restoreRepairPlan.steps.map((step) => step.action),
  ["restore-from-authority-blob-checkpoint"],
);

const auditRuntimeAheadOfSql = buildAuthorityConsistencyAudit({
  chatId: "chat-a",
  collectionId: "st-bme::chat-a",
  runtimeGraph: {
    meta: { revision: 4 },
    nodes: [{ id: "node-a" }],
    edges: [],
    vectorIndexState: { collectionId: "st-bme::chat-a", dirty: false },
  },
  graphPersistenceState: {
    chatId: "chat-a",
    revision: 4,
  },
  sqlSnapshot: {
    meta: { revision: 3, nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
  },
  triviumStat: {
    revision: 3,
    namespace: "st-bme::chat-a",
  },
});
assert.equal(auditRuntimeAheadOfSql.summary.level, "warning");
assert.equal(auditRuntimeAheadOfSql.summary.dataSafety, "runtime-ahead-of-sql");
assert.equal(auditRuntimeAheadOfSql.actions.includes("restore-from-authority-blob-checkpoint"), false);

const auditVectorDirtyOnly = buildAuthorityConsistencyAudit({
  chatId: "chat-a",
  collectionId: "st-bme::chat-a",
  runtimeGraph: {
    meta: { revision: 5 },
    nodes: [{ id: "node-a" }],
    edges: [],
    vectorIndexState: { collectionId: "st-bme::chat-a", dirty: true },
  },
  graphPersistenceState: {
    chatId: "chat-a",
    revision: 5,
  },
  sqlSnapshot: {
    meta: { revision: 5, nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
  },
  triviumStat: {
    revision: 5,
    namespace: "st-bme::chat-a",
  },
  blobResult: {
    ok: true,
    exists: true,
    path: "user/files/checkpoint.json",
    checkpoint: {
      chatId: "chat-a",
      revision: 5,
      serializedGraph: serializeGraph(graph),
    },
  },
});
assert.equal(auditVectorDirtyOnly.summary.backupRedundancy, "ok");
assert.equal(auditVectorDirtyOnly.summary.searchQuality, "degraded");
assert.equal(isAuthorityReplicaSyncRepairAction("write-authority-checkpoint"), true);
assert.equal(isAuthorityReplicaSyncRepairAction("rebuild-authority-trivium"), true);
assert.equal(isAuthorityReplicaSyncRepairAction("restore-from-authority-blob-checkpoint"), false);

console.log("authority-consistency tests passed");
