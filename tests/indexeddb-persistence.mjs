import assert from "node:assert/strict";

import {
  BME_DB_SCHEMA_VERSION,
  BME_TOMBSTONE_RETENTION_MS,
  BmeDatabase,
  buildBmeDbName,
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
  ensureDexieLoaded,
} from "../sync/bme-db.js";
import { BmeChatManager } from "../sync/bme-chat-manager.js";
import { createEmptyGraph } from "../graph/graph.js";

const PREFIX = "[ST-BME][indexeddb-persistence]";

const chatIdsForCleanup = new Set([
  "chat-a",
  "chat-b",
  "chat-manager-a",
  "chat-manager-b",
  "chat-replace-reset",
]);

async function setupIndexedDbTestEnv() {
  let fakeIndexedDbLoaded = false;

  try {
    await import("fake-indexeddb/auto");
    fakeIndexedDbLoaded = true;
  } catch (error) {
    console.warn(
      `${PREFIX} fake-indexeddb 未安装，回退到当前运行时 indexedDB:`,
      error?.message || error,
    );
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

  assert.equal(typeof globalThis.Dexie, "function", "Dexie 构造函数必须可用");
  assert.ok(globalThis.indexedDB, "indexedDB 必须可用");
  assert.ok(globalThis.IDBKeyRange, "IDBKeyRange 必须可用");

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

async function testBuildAndOpen() {
  assert.equal(buildBmeDbName("chat-a"), "STBME_chat-a");

  const db = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  await db.open();

  const tableNames = db.db.tables.map((table) => table.name).sort();
  assert.deepEqual(tableNames, ["edges", "meta", "nodes", "tombstones"]);

  const schemaVersion = await db.getMeta("schemaVersion", 0);
  assert.equal(schemaVersion, BME_DB_SCHEMA_VERSION);

  await db.close();
}

async function testCrudAndMeta() {
  const db = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  await db.open();

  const nodeResult = await db.bulkUpsertNodes([
    {
      id: "node-1",
      type: "event",
      sourceFloor: 1,
      archived: false,
      updatedAt: Date.now(),
      fields: {
        title: "第一次相遇",
      },
    },
  ]);
  assert.equal(nodeResult.upserted, 1);

  const edgeResult = await db.bulkUpsertEdges([
    {
      id: "edge-1",
      fromId: "node-1",
      toId: "node-1",
      relation: "self",
      sourceFloor: 1,
      updatedAt: Date.now(),
    },
  ]);
  assert.equal(edgeResult.upserted, 1);

  await db.setMeta("lastProcessedFloor", 7);
  assert.equal(await db.getMeta("lastProcessedFloor", -1), 7);

  await db.patchMeta({
    extractionCount: 3,
    deviceId: "device-test",
  });
  assert.equal(await db.getMeta("extractionCount", 0), 3);
  assert.equal(await db.getMeta("deviceId", ""), "device-test");

  const nodes = await db.listNodes({ includeDeleted: false, reverse: false });
  const edges = await db.listEdges({ includeDeleted: false, reverse: false });

  assert.equal(nodes.length, 1);
  assert.equal(edges.length, 1);

  await db.close();
}

async function testTransactionRollback() {
  const db = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  await db.open();

  await assert.rejects(async () => {
    await db.db.transaction("rw", db.db.table("nodes"), async () => {
      await db.db.table("nodes").put({
        id: "node-rollback",
        type: "event",
        sourceFloor: 9,
        updatedAt: Date.now(),
      });
      throw new Error("simulate rollback");
    });
  });

  const rollbackNode = await db.db.table("nodes").get("node-rollback");
  assert.equal(rollbackNode, undefined);

  await db.close();
}

async function testSnapshotExportImport() {
  const db = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  await db.open();

  await db.bulkUpsertNodes([
    {
      id: "node-snapshot",
      type: "event",
      sourceFloor: 2,
      archived: false,
      updatedAt: Date.now(),
    },
  ]);
  await db.bulkUpsertEdges([
    {
      id: "edge-snapshot",
      fromId: "node-snapshot",
      toId: "node-1",
      relation: "related",
      sourceFloor: 2,
      updatedAt: Date.now(),
    },
  ]);

  const exported = await db.exportSnapshot();
  assert.ok(exported.meta);
  assert.ok(Array.isArray(exported.nodes));
  assert.ok(Array.isArray(exported.edges));

  await db.clearAll();
  assert.equal((await db.listNodes()).length, 0);

  const importResult = await db.importSnapshot(exported, {
    mode: "replace",
    preserveRevision: true,
  });

  assert.equal(importResult.mode, "replace");
  assert.ok(importResult.imported.nodes >= 1);
  assert.ok((await db.listNodes()).some((item) => item.id === "node-snapshot"));

  await db.close();
}

async function testReplaceImportResetsStaleMeta() {
  const chatId = "chat-replace-reset";
  const db = new BmeDatabase(chatId, { dexieClass: globalThis.Dexie });
  await db.open();

  await db.patchMeta({
    runtimeHistoryState: {
      chatId,
      lastProcessedAssistantFloor: 99,
      processedMessageHashes: {
        99: "stale-hash",
      },
    },
    runtimeVectorIndexState: {
      hashToNodeId: {
        "stale-hash": "node-stale",
      },
      nodeToHash: {
        "node-stale": "stale-hash",
      },
      dirty: true,
      pendingRepairFromFloor: 88,
    },
    runtimeBatchJournal: [{ id: "stale-journal", processedRange: [90, 99] }],
    runtimeLastRecallResult: { updatedAt: 123456, nodes: ["node-stale"] },
    runtimeLastProcessedSeq: 999,
    runtimeGraphVersion: 999,
    migrationCompletedAt: 987654321,
    legacyRetentionUntil: 987654321,
    customLeakField: "stale-value",
  });

  const revisionBefore = await db.getRevision();

  const importResult = await db.importSnapshot(
    {
      meta: {
        chatId,
        revision: 1,
        deviceId: "device-replace-new",
      },
      state: {
        lastProcessedFloor: 3,
        extractionCount: 2,
      },
      nodes: [],
      edges: [],
      tombstones: [],
    },
    {
      mode: "replace",
      preserveRevision: true,
      markSyncDirty: false,
    },
  );

  assert.ok(importResult.revision > revisionBefore, "replace 导入后 revision 必须单调递增");
  assert.equal(await db.getMeta("chatId", ""), chatId);
  assert.equal(await db.getMeta("lastProcessedFloor", -1), 3);
  assert.equal(await db.getMeta("extractionCount", 0), 2);
  assert.equal(await db.getMeta("deviceId", ""), "device-replace-new");
  assert.equal(await db.getMeta("migrationCompletedAt", -1), 0);
  assert.equal(await db.getMeta("legacyRetentionUntil", -1), 0);
  assert.equal(await db.getMeta("runtimeHistoryState", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("runtimeVectorIndexState", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("runtimeBatchJournal", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("runtimeLastRecallResult", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("runtimeLastProcessedSeq", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("runtimeGraphVersion", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("customLeakField", "__missing__"), "__missing__");
  assert.equal(await db.getMeta("syncDirty", true), false);

  await db.close();
}

async function testRevisionMonotonicity() {
  const db = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  await db.open();

  const revisionBefore = await db.getRevision();

  const afterNode = await db.bulkUpsertNodes([
    {
      id: "node-rev-1",
      type: "event",
      sourceFloor: 3,
      archived: false,
      updatedAt: Date.now(),
    },
  ]);

  const afterEdge = await db.bulkUpsertEdges([
    {
      id: "edge-rev-1",
      fromId: "node-rev-1",
      toId: "node-snapshot",
      relation: "next",
      sourceFloor: 3,
      updatedAt: Date.now(),
    },
  ]);

  assert.ok(afterNode.revision > revisionBefore);
  assert.ok(afterEdge.revision > afterNode.revision);

  await db.close();
}

async function testTombstonePrune() {
  const db = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  await db.open();

  const nowMs = Date.now();
  const oldDeletedAt = nowMs - BME_TOMBSTONE_RETENTION_MS - 1000;
  const freshDeletedAt = nowMs - 1000;

  await db.bulkUpsertTombstones([
    {
      id: "tomb-old",
      kind: "node",
      targetId: "node-old",
      deletedAt: oldDeletedAt,
      sourceDeviceId: "device-a",
    },
    {
      id: "tomb-fresh",
      kind: "node",
      targetId: "node-fresh",
      deletedAt: freshDeletedAt,
      sourceDeviceId: "device-a",
    },
  ]);

  const pruneResult = await db.pruneExpiredTombstones(nowMs);
  assert.equal(pruneResult.pruned, 1);

  const tombstones = await db.listTombstones({ reverse: false });
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].id, "tomb-fresh");

  await db.close();
}

async function testChatIsolationAndManager() {
  const dbA = new BmeDatabase("chat-a", { dexieClass: globalThis.Dexie });
  const dbB = new BmeDatabase("chat-b", { dexieClass: globalThis.Dexie });

  await dbA.open();
  await dbB.open();

  await dbA.bulkUpsertNodes([
    {
      id: "node-chat-a",
      type: "event",
      sourceFloor: 1,
      archived: false,
      updatedAt: Date.now(),
    },
  ]);

  await dbB.bulkUpsertNodes([
    {
      id: "node-chat-b",
      type: "event",
      sourceFloor: 1,
      archived: false,
      updatedAt: Date.now(),
    },
  ]);

  const nodesA = await dbA.listNodes({ reverse: false });
  const nodesB = await dbB.listNodes({ reverse: false });

  assert.ok(nodesA.some((item) => item.id === "node-chat-a"));
  assert.ok(!nodesA.some((item) => item.id === "node-chat-b"));
  assert.ok(nodesB.some((item) => item.id === "node-chat-b"));

  await dbA.close();
  await dbB.close();

  const manager = new BmeChatManager({
    databaseFactory: (chatId) => {
      chatIdsForCleanup.add(chatId);
      return new BmeDatabase(chatId, { dexieClass: globalThis.Dexie });
    },
  });

  const managerDbA = await manager.switchChat("chat-manager-a");
  assert.equal(manager.getCurrentChatId(), "chat-manager-a");
  assert.ok(managerDbA);

  await managerDbA.bulkUpsertNodes([
    {
      id: "manager-node-a",
      type: "event",
      sourceFloor: 1,
      updatedAt: Date.now(),
    },
  ]);

  const managerDbB = await manager.switchChat("chat-manager-b");
  assert.equal(manager.getCurrentChatId(), "chat-manager-b");
  await managerDbB.bulkUpsertNodes([
    {
      id: "manager-node-b",
      type: "event",
      sourceFloor: 1,
      updatedAt: Date.now(),
    },
  ]);

  const managerDbBNodes = await managerDbB.listNodes({ reverse: false });
  assert.ok(managerDbBNodes.some((item) => item.id === "manager-node-b"));

  const reopenedA = await manager.getCurrentDb("chat-manager-a");
  const reopenedANodes = await reopenedA.listNodes({ reverse: false });
  assert.ok(reopenedANodes.some((item) => item.id === "manager-node-a"));
  assert.ok(!reopenedANodes.some((item) => item.id === "manager-node-b"));

  await manager.closeAll();
  assert.equal(manager.getCurrentChatId(), "");
}

async function testGraphSnapshotConverters() {
  const graph = createEmptyGraph();
  graph.historyState.chatId = "chat-a";
  graph.historyState.lastProcessedAssistantFloor = 9;
  graph.historyState.extractionCount = 4;
  graph.historyState.processedMessageHashes = {
    1: "hash-1",
  };
  graph.vectorIndexState.hashToNodeId = {
    "vec-hash": "node-converter",
  };
  graph.lastRecallResult = ["node-converter"];
  graph.batchJournal = [
    {
      id: "journal-1",
      processedRange: [8, 9],
    },
  ];
  graph.nodes.push({
    id: "node-converter",
    type: "event",
    sourceFloor: 9,
    updatedAt: Date.now(),
  });

  const snapshot = buildSnapshotFromGraph(graph, {
    chatId: "chat-a",
    revision: 17,
  });
  assert.equal(snapshot.meta.chatId, "chat-a");
  assert.equal(snapshot.meta.revision, 17);
  assert.equal(snapshot.state.lastProcessedFloor, 9);
  assert.equal(snapshot.state.extractionCount, 4);
  assert.equal(snapshot.nodes.length, 1);

  const rebuilt = buildGraphFromSnapshot(snapshot, {
    chatId: "chat-a",
  });
  assert.equal(rebuilt.historyState.lastProcessedAssistantFloor, 9);
  assert.equal(rebuilt.historyState.extractionCount, 4);
  assert.equal(rebuilt.nodes.length, 1);
  assert.equal(rebuilt.nodes[0].id, "node-converter");
  assert.equal(rebuilt.vectorIndexState.hashToNodeId["vec-hash"], "node-converter");
}

async function main() {
  await setupIndexedDbTestEnv();
  await cleanupDatabases();

  await testBuildAndOpen();
  await testCrudAndMeta();
  await testTransactionRollback();
  await testSnapshotExportImport();
  await testReplaceImportResetsStaleMeta();
  await testRevisionMonotonicity();
  await testTombstonePrune();
  await testChatIsolationAndManager();
  await testGraphSnapshotConverters();

  await cleanupDatabases();

  console.log("indexeddb-persistence tests passed");
}

await main();
