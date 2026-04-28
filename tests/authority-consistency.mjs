import assert from "node:assert/strict";

import { createEmptyGraph, serializeGraph } from "../graph/graph.js";
import {
  applyAuthorityCheckpointToStore,
  buildAuthorityCheckpointImportSnapshot,
  buildAuthorityConsistencyAudit,
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
assert.ok(auditAligned.actions.includes("restore-from-authority-blob-checkpoint"));

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

console.log("authority-consistency tests passed");
