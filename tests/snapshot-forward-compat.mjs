// ST-BME restrained rebirth — Phase 3 durable forward-compat integration tests.
//
// Proves the forward-compatibility discipline on REAL stores (not mocks):
//   - real BmeDatabase (IndexedDB via fake-indexeddb)
//   - real OpfsGraphStore (memory OPFS)
// Asserts a full write -> read round-trip preserves unknown future fields on
// nodes/edges/meta, that the durable snapshot carries schemaVersion, and that an
// older-version snapshot is handled by upgrade-on-read without data loss.

import assert from "node:assert/strict";

import {
  BME_DB_SCHEMA_VERSION,
  BmeDatabase,
  buildBmeDbName,
  ensureDexieLoaded,
} from "../sync/bme-db.js";
import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  OpfsGraphStore,
} from "../sync/bme-opfs-store.js";
import { createMemoryOpfsRoot } from "./helpers/memory-opfs.mjs";
import {
  inspectGraphSnapshotContract,
  readGraphSnapshotSchemaVersion,
} from "../sync/graph-snapshot-schema.js";
import { upgradeGraphSnapshotOnRead } from "../sync/graph-snapshot-upgrade.js";

const PREFIX = "[ST-BME][snapshot-forward-compat]";

const chatIdsForCleanup = new Set([
  "chat-fc-indexeddb",
  "chat-fc-upgrade",
]);

async function setupIndexedDbTestEnv() {
  let fakeIndexedDbLoaded = false;
  try {
    await import("fake-indexeddb/auto");
    fakeIndexedDbLoaded = true;
  } catch (error) {
    console.warn(`${PREFIX} fake-indexeddb 未安装，跳过 IndexedDB 集成断言:`, error?.message || error);
  }
  if (!globalThis.Dexie) {
    try {
      const imported = await import("dexie");
      globalThis.Dexie = imported?.default || imported?.Dexie || imported;
    } catch {
      await import("../lib/dexie.min.js");
    }
  }
  await ensureDexieLoaded();
  return { fakeIndexedDbLoaded };
}

async function cleanupDatabases() {
  if (typeof globalThis.Dexie?.delete !== "function") return;
  for (const chatId of chatIdsForCleanup) {
    try {
      await globalThis.Dexie.delete(buildBmeDbName(chatId));
    } catch {
      // ignore
    }
  }
}

// A snapshot carrying unknown FUTURE fields at every tolerant level.
function buildSnapshotWithFutureFields(chatId) {
  return {
    meta: {
      chatId,
      revision: 5,
      futureMetaField: { nested: "keep-me" },
    },
    state: {
      lastProcessedFloor: 9,
      extractionCount: 4,
      futureStateField: "state-keep",
    },
    nodes: [
      {
        id: "node-fc-1",
        type: "event",
        sourceFloor: 1,
        archived: false,
        updatedAt: 1000,
        fields: { title: "相遇" },
        futureNodeField: "node-keep",
      },
    ],
    edges: [
      {
        id: "edge-fc-1",
        fromId: "node-fc-1",
        toId: "node-fc-1",
        relation: "self",
        sourceFloor: 1,
        updatedAt: 1001,
        futureEdgeField: 42,
      },
    ],
    tombstones: [
      {
        id: "tomb-fc-1",
        kind: "node",
        targetId: "node-old",
        sourceDeviceId: "device-fc",
        deletedAt: 900,
        futureTombField: true,
      },
    ],
  };
}

async function testIndexedDbForwardCompat(fakeIndexedDbLoaded) {
  if (!fakeIndexedDbLoaded) {
    console.log(`${PREFIX} 跳过真实 IndexedDB 往返（无 fake-indexeddb）`);
    return;
  }
  const db = new BmeDatabase("chat-fc-indexeddb", { dexieClass: globalThis.Dexie });
  await db.open();

  await db.importSnapshot(buildSnapshotWithFutureFields("chat-fc-indexeddb"), {
    mode: "replace",
    preserveRevision: true,
  });

  const exported = await db.exportSnapshot();
  const inspection = inspectGraphSnapshotContract(exported);
  assert.equal(inspection.valid, true, "IndexedDB export matches durable contract");
  assert.ok(readGraphSnapshotSchemaVersion(exported) >= 1, "IndexedDB export carries schemaVersion");

  const node = exported.nodes.find((item) => item.id === "node-fc-1");
  const edge = exported.edges.find((item) => item.id === "edge-fc-1");
  const tomb = exported.tombstones.find((item) => item.id === "tomb-fc-1");
  assert.equal(node?.futureNodeField, "node-keep", "IndexedDB preserves unknown node field");
  assert.equal(edge?.futureEdgeField, 42, "IndexedDB preserves unknown edge field");
  assert.equal(tomb?.futureTombField, true, "IndexedDB preserves unknown tombstone field");
  assert.equal(exported.meta.futureMetaField?.nested, "keep-me", "IndexedDB preserves unknown meta field");

  await db.close();
  console.log("  ✓ real IndexedDB round-trip preserves unknown future fields + schemaVersion");
}

async function testOpfsForwardCompat() {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore("chat-fc-opfs", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();

  await store.importSnapshot(buildSnapshotWithFutureFields("chat-fc-opfs"));

  const reopened = new OpfsGraphStore("chat-fc-opfs", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await reopened.open();
  const exported = await reopened.exportSnapshot();

  const inspection = inspectGraphSnapshotContract(exported);
  assert.equal(inspection.valid, true, "OPFS export matches durable contract");
  assert.ok(readGraphSnapshotSchemaVersion(exported) >= 1, "OPFS export carries schemaVersion");

  const node = exported.nodes.find((item) => item.id === "node-fc-1");
  const edge = exported.edges.find((item) => item.id === "edge-fc-1");
  assert.equal(node?.futureNodeField, "node-keep", "OPFS preserves unknown node field across reopen");
  assert.equal(edge?.futureEdgeField, 42, "OPFS preserves unknown edge field across reopen");
  assert.equal(exported.meta.futureMetaField?.nested, "keep-me", "OPFS preserves unknown meta field");

  await store.close();
  await reopened.close();
  console.log("  ✓ real OPFS round-trip preserves unknown future fields across reopen");
}

async function testUpgradeOnReadOfOlderSnapshot(fakeIndexedDbLoaded) {
  if (!fakeIndexedDbLoaded) {
    console.log(`${PREFIX} 跳过旧版升级往返（无 fake-indexeddb）`);
    return;
  }
  // Simulate an older durable snapshot lacking the top-level schemaVersion field.
  const legacyLikeSnapshot = {
    meta: { chatId: "chat-fc-upgrade", revision: 2, schemaVersion: 1, legacyKeep: "x" },
    state: { lastProcessedFloor: 1 },
    nodes: [{ id: "node-legacy", type: "char", updatedAt: 500, legacyNodeField: "y" }],
    edges: [],
    tombstones: [],
  };

  const upgraded = upgradeGraphSnapshotOnRead(legacyLikeSnapshot);
  assert.equal(upgraded.ahead, false, "legacy snapshot is not ahead");
  assert.equal(upgraded.snapshot.nodes[0].legacyNodeField, "y", "upgrade preserves unknown legacy node field");
  assert.equal(upgraded.snapshot.meta.legacyKeep, "x", "upgrade preserves unknown legacy meta field");

  // The upgraded snapshot still round-trips through a real store.
  const db = new BmeDatabase("chat-fc-upgrade", { dexieClass: globalThis.Dexie });
  await db.open();
  await db.importSnapshot(upgraded.snapshot, { mode: "replace", preserveRevision: true });
  const exported = await db.exportSnapshot();
  assert.ok(readGraphSnapshotSchemaVersion(exported) >= 1, "upgraded snapshot persists with schemaVersion");
  assert.ok(
    exported.nodes.some((item) => item.id === "node-legacy" && item.legacyNodeField === "y"),
    "upgraded legacy node persists with unknown field intact",
  );
  await db.close();
  console.log("  ✓ older snapshot upgrades on read and round-trips on a real store");
}

async function run() {
  const { fakeIndexedDbLoaded } = await setupIndexedDbTestEnv();
  await cleanupDatabases();
  try {
    await testIndexedDbForwardCompat(fakeIndexedDbLoaded);
    await testOpfsForwardCompat();
    await testUpgradeOnReadOfOlderSnapshot(fakeIndexedDbLoaded);
  } finally {
    await cleanupDatabases();
  }
  console.log("snapshot-forward-compat tests passed");
}

await run();
