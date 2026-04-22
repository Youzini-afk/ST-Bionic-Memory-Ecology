import assert from "node:assert/strict";

import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  OpfsGraphStore,
} from "../sync/bme-opfs-store.js";
import { createMemoryOpfsRoot } from "./helpers/memory-opfs.mjs";

const rootDirectory = createMemoryOpfsRoot();
const store = new OpfsGraphStore("chat-opfs-meta-fast-path", {
  rootDirectoryFactory: async () => rootDirectory,
  storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
});

await store.open();
await store.importSnapshot(
  {
    meta: {
      revision: 3,
      lastBackupFilename: "before.json",
      lastSyncUploadedAt: 10,
    },
    state: {
      lastProcessedFloor: 2,
      extractionCount: 1,
    },
    nodes: [
      {
        id: "node-1",
        type: "event",
        fields: { title: "A" },
        archived: false,
        updatedAt: 1,
      },
    ],
    edges: [],
    tombstones: [],
  },
  {
    mode: "replace",
    preserveRevision: true,
  },
);

const originalLoadSnapshot = store._loadSnapshot.bind(store);
let loadSnapshotCalls = 0;
store._loadSnapshot = async (...args) => {
  loadSnapshotCalls += 1;
  return await originalLoadSnapshot(...args);
};

assert.equal(await store.getMeta("lastBackupFilename", ""), "before.json");
assert.equal(await store.getRevision(), 3);
await store.patchMeta({
  lastBackupFilename: "after.json",
  lastProcessedFloor: 9,
  extractionCount: 4,
});
const probe = await store.exportSnapshotProbe();

assert.equal(
  loadSnapshotCalls,
  0,
  "manifest-only meta fast path should not load full snapshot",
);
assert.equal(probe.__stBmeProbeOnly, true);
assert.equal(probe.meta.lastBackupFilename, "after.json");
assert.equal(probe.meta.nodeCount, 1);
assert.equal(probe.state.lastProcessedFloor, 9);
assert.equal(probe.state.extractionCount, 4);

const snapshot = await originalLoadSnapshot();
assert.equal(snapshot.meta.lastBackupFilename, "after.json");
assert.equal(snapshot.state.lastProcessedFloor, 9);
assert.equal(snapshot.state.extractionCount, 4);
assert.equal(snapshot.nodes.length, 1);

console.log("opfs-meta-fast-path tests passed");
