import assert from "node:assert/strict";

import { buildPersistDelta } from "../sync/bme-db.js";
import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  OpfsGraphStore,
} from "../sync/bme-opfs-store.js";
import { createMemoryOpfsRoot } from "./helpers/memory-opfs.mjs";

function createRuntimeGraphLikeSnapshot({
  chatId,
  lastProcessedFloor,
  extractionCount,
  nodes = [],
  edges = [],
  batchJournal = [],
} = {}) {
  return {
    version: 9,
    lastProcessedSeq: lastProcessedFloor,
    nodes,
    edges,
    historyState: {
      chatId,
      lastProcessedAssistantFloor: lastProcessedFloor,
      extractionCount,
      processedMessageHashVersion: 2,
      processedMessageHashes: {},
      processedMessageHashesNeedRefresh: false,
      historyDirtyFrom: null,
      lastMutationReason: "",
      lastMutationSource: "",
      lastRecoveryResult: null,
      lastBatchStatus: null,
      lastExtractedRegion: "",
      activeRegion: "",
      activeRegionSource: "",
      activeStorySegmentId: "",
      activeStoryTimeLabel: "",
      activeStoryTimeSource: "",
      lastExtractedStorySegmentId: "",
      activeCharacterPovOwner: "",
      activeUserPovOwner: "",
      activeRecallOwnerKey: "",
      recentRecallOwnerKeys: [],
    },
    vectorIndexState: {
      mode: "backend",
      collectionId: `st-bme::${chatId}`,
      source: "",
      modelScope: "",
      hashToNodeId: {},
      nodeToHash: {},
      dirty: false,
      replayRequiredNodeIds: [],
      dirtyReason: "",
      pendingRepairFromFloor: null,
      lastSyncAt: 0,
      lastStats: {
        total: 0,
        indexed: 0,
        stale: 0,
        pending: 0,
      },
      lastWarning: "",
      lastIntegrityIssue: null,
    },
    batchJournal,
    maintenanceJournal: [],
    knowledgeState: {},
    regionState: {},
    timelineState: {},
    summaryState: {},
    lastRecallResult: null,
  };
}

async function testCommitDeltaAndPatchMetaSerialize() {
  const rootDirectory = createMemoryOpfsRoot({
    writeDelayMs: 5,
  });
  const store = new OpfsGraphStore("chat-opfs-serialize-meta", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();

  await store.importSnapshot(
    {
      meta: {
        revision: 1,
        lastBackupFilename: "",
      },
      state: {
        lastProcessedFloor: 0,
        extractionCount: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
    },
    {
      mode: "replace",
      preserveRevision: true,
    },
  );

  await Promise.all([
    store.commitDelta(
      {
        upsertNodes: [
          {
            id: "node-1",
            type: "event",
            fields: {
              title: "serialized",
            },
            archived: false,
            updatedAt: 100,
          },
        ],
      },
      {
        reason: "serialized-node",
      },
    ),
    store.patchMeta({
      lastBackupFilename: "backup-a.json",
      lastProcessedFloor: 7,
      extractionCount: 3,
    }),
  ]);

  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0]?.id, "node-1");
  assert.equal(snapshot.meta.lastBackupFilename, "backup-a.json");
  assert.equal(snapshot.state.lastProcessedFloor, 7);
  assert.equal(snapshot.state.extractionCount, 3);
}

async function testImportSnapshotAndClearAllSerialize() {
  const rootDirectory = createMemoryOpfsRoot({
    writeDelayMs: 5,
  });
  const store = new OpfsGraphStore("chat-opfs-serialize-clear", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();

  await store.importSnapshot(
    {
      meta: { revision: 2 },
      state: { lastProcessedFloor: 5, extractionCount: 2 },
      nodes: [
        {
          id: "seed-node",
          type: "event",
          fields: { title: "seed" },
          archived: false,
          updatedAt: 1,
        },
      ],
      edges: [],
      tombstones: [],
    },
    { mode: "replace", preserveRevision: true },
  );

  await Promise.all([
    store.clearAll(),
    store.importSnapshot(
      {
        meta: { revision: 4 },
        state: { lastProcessedFloor: 9, extractionCount: 4 },
        nodes: [
          {
            id: "after-clear-node",
            type: "fact",
            fields: { title: "after-clear" },
            archived: false,
            updatedAt: 2,
          },
        ],
        edges: [],
        tombstones: [],
      },
      { mode: "replace", preserveRevision: true },
    ),
  ]);

  const snapshot = await store.exportSnapshot();
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0]?.id, "after-clear-node");
  assert.equal(snapshot.state.lastProcessedFloor, 9);
  assert.equal(snapshot.state.extractionCount, 4);
}

async function testGraphLikeDeltaPreservesHistoryFrontier() {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore("chat-opfs-graph-like-delta", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();

  const beforeGraph = createRuntimeGraphLikeSnapshot({
    chatId: "chat-opfs-graph-like-delta",
    lastProcessedFloor: -1,
    extractionCount: 0,
  });
  const afterGraph = createRuntimeGraphLikeSnapshot({
    chatId: "chat-opfs-graph-like-delta",
    lastProcessedFloor: 12,
    extractionCount: 3,
    nodes: [
      {
        id: "node-graph-like",
        type: "event",
        fields: { title: "graph-like" },
        archived: false,
        updatedAt: 12,
      },
    ],
    batchJournal: [
      {
        id: "journal-1",
        processedRange: [12, 12],
      },
    ],
  });

  const delta = buildPersistDelta(beforeGraph, afterGraph, {
    useNativeDelta: false,
  });
  assert.equal(delta.runtimeMetaPatch.lastProcessedFloor, 12);
  assert.equal(delta.runtimeMetaPatch.extractionCount, 3);
  assert.equal(
    delta.runtimeMetaPatch.runtimeHistoryState?.lastProcessedAssistantFloor,
    12,
  );

  await store.commitDelta(delta, {
    reason: "graph-like-delta",
    requestedRevision: 1,
    markSyncDirty: true,
  });

  const reopenedStore = new OpfsGraphStore("chat-opfs-graph-like-delta", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await reopenedStore.open();
  const snapshot = await reopenedStore.exportSnapshot();
  assert.equal(snapshot.state.lastProcessedFloor, 12);
  assert.equal(snapshot.state.extractionCount, 3);
  assert.equal(
    snapshot.meta.runtimeHistoryState?.lastProcessedAssistantFloor,
    12,
  );
}

async function testCommitDeltaDiagnosticsSplitWalAndManifestStages() {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore("chat-opfs-diagnostics-split", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();

  await store.importSnapshot(
    {
      meta: { revision: 1 },
      state: { lastProcessedFloor: 0, extractionCount: 0 },
      nodes: [],
      edges: [],
      tombstones: [],
    },
    { mode: "replace", preserveRevision: true },
  );

  const result = await store.commitDelta(
    {
      upsertNodes: [
        {
          id: "diag-node-1",
          type: "event",
          fields: { title: "diag" },
          archived: false,
          updatedAt: 10,
        },
      ],
    },
    {
      reason: "diagnostics-split",
      requestedRevision: 2,
      markSyncDirty: true,
    },
  );

  assert.equal(Number.isFinite(result.diagnostics?.walSerializeMs), true);
  assert.equal(Number.isFinite(result.diagnostics?.walFileWriteMs), true);
  assert.equal(Number.isFinite(result.diagnostics?.walWriteMs), true);
  assert.equal(Number.isFinite(result.diagnostics?.manifestSerializeMs), true);
  assert.equal(Number.isFinite(result.diagnostics?.manifestFileWriteMs), true);
  assert.equal(Number.isFinite(result.diagnostics?.manifestWriteMs), true);
  assert.equal(
    result.diagnostics.walWriteMs >= result.diagnostics.walSerializeMs,
    true,
  );
  assert.equal(
    result.diagnostics.manifestWriteMs >= result.diagnostics.manifestSerializeMs,
    true,
  );
}

await testCommitDeltaAndPatchMetaSerialize();
await testImportSnapshotAndClearAllSerialize();
await testGraphLikeDeltaPreservesHistoryFrontier();
await testCommitDeltaDiagnosticsSplitWalAndManifestStages();
console.log("opfs-write-serialization tests passed");
