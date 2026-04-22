import assert from "node:assert/strict";

import {
  BME_DB_SCHEMA_VERSION,
  BME_RUNTIME_BATCH_JOURNAL_META_KEY,
  BME_RUNTIME_HISTORY_META_KEY,
  BME_RUNTIME_RECORDS_NORMALIZED_META_KEY,
  BME_RUNTIME_VECTOR_META_KEY,
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
  "chat-manager-selector",
  "chat-export-without-tombstones",
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

async function testSnapshotExportWithoutTombstones() {
  const db = new BmeDatabase("chat-export-without-tombstones", {
    dexieClass: globalThis.Dexie,
  });
  await db.open();

  await db.bulkUpsertNodes([
    {
      id: "node-light-snapshot",
      type: "event",
      sourceFloor: 3,
      archived: false,
      updatedAt: Date.now(),
    },
  ]);
  await db.bulkUpsertTombstones([
    {
      id: "tomb-light-snapshot",
      kind: "node",
      targetId: "node-deleted-light-snapshot",
      deletedAt: Date.now(),
      sourceDeviceId: "device-light-snapshot",
    },
  ]);

  const exported = await db.exportSnapshot({ includeTombstones: false });
  assert.equal(exported.__stBmeTombstonesOmitted, true);
  assert.ok(Array.isArray(exported.nodes));
  assert.ok(Array.isArray(exported.edges));
  assert.deepEqual(exported.tombstones, []);
  assert.equal(exported.meta.tombstoneCount, 1);

  await db.close();
}

async function testSnapshotProbeExport() {
  const db = new BmeDatabase("chat-export-probe", {
    dexieClass: globalThis.Dexie,
  });
  await db.open();

  await db.bulkUpsertNodes([
    {
      id: "node-probe",
      type: "event",
      sourceFloor: 4,
      archived: false,
      updatedAt: Date.now(),
    },
  ]);
  await db.patchMeta({
    lastProcessedFloor: 6,
    extractionCount: 3,
    runtimeHistoryState: {
      chatId: "chat-export-probe",
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
    },
  });

  const probe = await db.exportSnapshotProbe();
  assert.equal(probe.__stBmeProbeOnly, true);
  assert.equal(probe.__stBmeTombstonesOmitted, true);
  assert.deepEqual(probe.nodes, []);
  assert.deepEqual(probe.edges, []);
  assert.deepEqual(probe.tombstones, []);
  assert.equal(probe.meta.chatId, "chat-export-probe");
  assert.equal(probe.meta.nodeCount, 1);
  assert.equal(probe.state.lastProcessedFloor, 6);
  assert.equal(probe.state.extractionCount, 3);
  assert.equal(
    probe.meta.runtimeHistoryState.lastProcessedAssistantFloor,
    6,
  );

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

async function testManagerRecreatesDbWhenSelectorKeyChanges() {
  let selectorKey = "indexeddb:indexeddb";
  let instanceCounter = 0;
  const closeLog = [];
  const manager = new BmeChatManager({
    selectorKeyResolver: async () => selectorKey,
    databaseFactory: async (chatId) => {
      instanceCounter += 1;
      const instanceId = instanceCounter;
      return {
        chatId,
        instanceId,
        openCount: 0,
        closed: false,
        async open() {
          this.openCount += 1;
          return this;
        },
        async close() {
          this.closed = true;
          closeLog.push(instanceId);
        },
      };
    },
  });

  const dbA = await manager.getCurrentDb("chat-manager-selector");
  assert.equal(dbA.instanceId, 1);
  assert.equal(dbA.openCount, 1);

  const reopenedSameSelector = await manager.getCurrentDb("chat-manager-selector");
  assert.equal(reopenedSameSelector, dbA);
  assert.equal(dbA.openCount, 2);
  assert.deepEqual(closeLog, []);

  selectorKey = "opfs:opfs-shadow";
  const dbB = await manager.getCurrentDb("chat-manager-selector");
  assert.notEqual(dbB, dbA);
  assert.equal(dbB.instanceId, 2);
  assert.equal(dbB.openCount, 1);
  assert.equal(dbA.closed, true);
  assert.deepEqual(closeLog, [1]);

  await manager.closeAll();
  assert.equal(dbB.closed, true);
  assert.deepEqual(closeLog, [1, 2]);
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
  graph.maintenanceJournal = [
    {
      id: "maintenance-1",
      action: "compress",
      updatedAt: 123,
    },
  ];
  graph.knowledgeState = {
    activeOwnerKey: "owner:hero",
    owners: {
      "owner:hero": {
        ownerKey: "owner:hero",
        displayName: "Hero",
      },
    },
  };
  graph.regionState = {
    activeRegion: "camp",
    knownRegions: {
      camp: {
        regionId: "camp",
        displayName: "Camp",
      },
    },
  };
  graph.timelineState = {
    activeSegmentId: "segment-1",
    segments: [
      {
        id: "segment-1",
        label: "Night 1",
      },
    ],
  };
  graph.summaryState = {
    updatedAt: 456,
    entries: [
      {
        id: "summary-1",
        text: "Summary text",
      },
    ],
  };
  graph.nodes.push({
    id: "node-converter",
    type: "event",
    sourceFloor: 9,
    fields: {
      title: "Converter Node",
    },
    updatedAt: Date.now(),
    embedding: [0.25, 0.5, 0.75],
    scope: {
      layer: "pov",
      ownerType: "character",
      ownerId: "hero",
      ownerName: "Hero",
      regionPrimary: "camp",
      regionPath: ["camp", "tent"],
      regionSecondary: ["forest"],
    },
    storyTime: {
      segmentId: "segment-1",
      label: "Dawn",
      tense: "ongoing",
      relation: "same",
      anchorLabel: "Night",
      confidence: "high",
      source: "derived",
    },
    storyTimeSpan: {
      startSegmentId: "segment-0",
      endSegmentId: "segment-1",
      startLabel: "Night",
      endLabel: "Dawn",
      mixed: false,
      source: "derived",
    },
  });

  let snapshotDiagnostics = null;
  const snapshot = buildSnapshotFromGraph(graph, {
    chatId: "chat-a",
    revision: 17,
    onDiagnostics(snapshotValue) {
      snapshotDiagnostics = snapshotValue;
    },
  });
  assert.equal(snapshot.meta.chatId, "chat-a");
  assert.equal(snapshot.meta.revision, 17);
  assert.equal(snapshot.meta[BME_RUNTIME_RECORDS_NORMALIZED_META_KEY], true);
  assert.equal(snapshot.state.lastProcessedFloor, 9);
  assert.equal(snapshot.state.extractionCount, 4);
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(Number.isFinite(snapshotDiagnostics?.nodesMs), true);
  assert.equal(Number.isFinite(snapshotDiagnostics?.edgesMs), true);
  assert.equal(Number.isFinite(snapshotDiagnostics?.tombstonesMs), true);
  assert.equal(Number.isFinite(snapshotDiagnostics?.stateMs), true);
  assert.equal(Number.isFinite(snapshotDiagnostics?.metaMs), true);
  assert.equal(Number.isFinite(snapshotDiagnostics?.totalMs), true);
  assert.equal(snapshotDiagnostics?.nodeCount, 1);

  let hydrateDiagnostics = null;
  const nextGraph = buildGraphFromSnapshot(snapshot, {
    chatId: "chat-a",
    onDiagnostics(snapshotValue) {
      hydrateDiagnostics = snapshotValue;
    },
  });
  assert.equal(hydrateDiagnostics?.success, true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.nodesMs), true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.edgesMs), true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.runtimeMetaMs), true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.stateMs), true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.normalizeMs), true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.integrityMs), true);
  assert.equal(Number.isFinite(hydrateDiagnostics?.totalMs), true);

  let reusedSnapshotDiagnostics = null;
  const reusedSnapshot = buildSnapshotFromGraph(nextGraph, {
    chatId: "chat-a",
    revision: 18,
    baseSnapshot: snapshot,
    onDiagnostics(snapshotValue) {
      reusedSnapshotDiagnostics = snapshotValue;
    },
  });
  assert.equal(
    reusedSnapshot.nodes[0],
    snapshot.nodes[0],
    "未变化节点应直接复用 baseSnapshot 记录对象",
  );
  assert.equal(reusedSnapshotDiagnostics?.reusedNodeCount, 1);
  nextGraph.nodes[0].updatedAt = Number(nextGraph.nodes[0].updatedAt || 0) + 1;
  const changedSnapshot = buildSnapshotFromGraph(nextGraph, {
    chatId: "chat-a",
    revision: 19,
    baseSnapshot: snapshot,
  });
  assert.notEqual(
    changedSnapshot.nodes[0],
    snapshot.nodes[0],
    "节点变化后不应复用 baseSnapshot 记录对象",
  );

  const rebuilt = buildGraphFromSnapshot(snapshot, {
    chatId: "chat-a",
  });
  const legacyCompatibleSnapshot = {
    ...snapshot,
    meta: {
      ...snapshot.meta,
    },
  };
  delete legacyCompatibleSnapshot.meta[BME_RUNTIME_RECORDS_NORMALIZED_META_KEY];
  legacyCompatibleSnapshot.nodes = [
    {
      ...legacyCompatibleSnapshot.nodes[0],
      scope: undefined,
      storyTime: undefined,
      storyTimeSpan: undefined,
    },
  ];
  const rebuiltLegacyCompatible = buildGraphFromSnapshot(legacyCompatibleSnapshot, {
    chatId: "chat-a",
  });
  const malformedButFlaggedSnapshot = {
    ...legacyCompatibleSnapshot,
    meta: {
      ...legacyCompatibleSnapshot.meta,
      [BME_RUNTIME_RECORDS_NORMALIZED_META_KEY]: true,
    },
  };
  const rebuiltMalformedButFlagged = buildGraphFromSnapshot(malformedButFlaggedSnapshot, {
    chatId: "chat-a",
  });
  assert.equal(rebuilt.historyState.lastProcessedAssistantFloor, 9);
  assert.equal(rebuilt.historyState.extractionCount, 4);
  assert.equal(rebuilt.nodes.length, 1);
  assert.equal(rebuilt.nodes[0].id, "node-converter");
  assert.equal(rebuilt.nodes[0].scope?.ownerType, "character");
  assert.equal(rebuilt.nodes[0].scope?.regionPrimary, "camp");
  assert.equal(rebuilt.nodes[0].storyTime?.label, "Dawn");
  assert.equal(rebuilt.nodes[0].storyTimeSpan?.endLabel, "Dawn");
  assert.equal(rebuilt.vectorIndexState.hashToNodeId["vec-hash"], "node-converter");
  assert.equal(rebuilt.maintenanceJournal[0].id, "maintenance-1");
  assert.equal(rebuilt.knowledgeState.activeOwnerKey, "owner:hero");
  assert.equal(rebuilt.regionState.activeRegion, "camp");
  assert.equal(rebuilt.timelineState.activeSegmentId, "segment-1");
  assert.equal(rebuilt.summaryState.entries[0].id, "summary-1");
  assert.equal(rebuiltLegacyCompatible.nodes[0].scope?.layer, "objective");
  assert.equal(rebuiltLegacyCompatible.nodes[0].storyTime?.tense, "unknown");
  assert.equal(rebuiltLegacyCompatible.nodes[0].storyTimeSpan?.mixed, false);
  assert.equal(rebuiltMalformedButFlagged.nodes[0].scope?.layer, "objective");
  assert.equal(rebuiltMalformedButFlagged.nodes[0].storyTime?.tense, "unknown");
  assert.equal(rebuiltMalformedButFlagged.nodes[0].storyTimeSpan?.mixed, false);

  rebuilt.nodes[0].fields.title = "Mutated Converter Node";
  rebuilt.nodes[0].embedding[0] = 99;
  rebuilt.historyState.processedMessageHashes[1] = "mutated-hash";
  rebuilt.vectorIndexState.hashToNodeId["vec-hash"] = "node-mutated";
  rebuilt.batchJournal[0].processedRange[0] = 99;

  assert.equal(
    snapshot.nodes[0].fields.title,
    "Converter Node",
    "buildGraphFromSnapshot 不应复用 snapshot 节点的嵌套字段引用",
  );
  assert.equal(
    snapshot.meta[BME_RUNTIME_HISTORY_META_KEY].processedMessageHashes[1],
    "hash-1",
    "buildGraphFromSnapshot 不应复用 snapshot historyState 的嵌套对象引用",
  );
  assert.equal(
    snapshot.nodes[0].embedding[0],
    0.25,
    "buildGraphFromSnapshot 不应复用 snapshot 节点的数组字段引用",
  );
  assert.equal(
    snapshot.meta[BME_RUNTIME_VECTOR_META_KEY].hashToNodeId["vec-hash"],
    "node-converter",
    "buildGraphFromSnapshot 不应复用 snapshot vectorState 的嵌套对象引用",
  );
  assert.equal(
    snapshot.meta[BME_RUNTIME_BATCH_JOURNAL_META_KEY][0].processedRange[0],
    8,
    "buildGraphFromSnapshot 不应复用 snapshot batchJournal 的嵌套数组引用",
  );
}

async function main() {
  await setupIndexedDbTestEnv();
  await cleanupDatabases();

  await testBuildAndOpen();
  await testCrudAndMeta();
  await testTransactionRollback();
  await testSnapshotExportImport();
  await testSnapshotExportWithoutTombstones();
  await testSnapshotProbeExport();
  await testReplaceImportResetsStaleMeta();
  await testRevisionMonotonicity();
  await testTombstonePrune();
  await testChatIsolationAndManager();
  await testManagerRecreatesDbWhenSelectorKeyChanges();
  await testGraphSnapshotConverters();

  await cleanupDatabases();

  console.log("indexeddb-persistence tests passed");
}

await main();
