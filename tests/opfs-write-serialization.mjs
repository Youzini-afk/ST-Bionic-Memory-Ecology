import assert from "node:assert/strict";

import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  OpfsGraphStore,
} from "../sync/bme-opfs-store.js";
import { createMemoryOpfsRoot } from "./helpers/memory-opfs.mjs";

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

await testCommitDeltaAndPatchMetaSerialize();
await testImportSnapshotAndClearAllSerialize();
console.log("opfs-write-serialization tests passed");
