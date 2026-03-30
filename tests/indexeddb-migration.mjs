import assert from "node:assert/strict";

import {
  BME_LEGACY_RETENTION_MS,
  BmeDatabase,
  buildBmeDbName,
  ensureDexieLoaded,
} from "../bme-db.js";
import { createEmptyGraph } from "../graph.js";

const PREFIX = "[ST-BME][indexeddb-migration]";

const chatIdsForCleanup = new Set([
  "chat-migration-a",
  "chat-migration-b",
  "chat-migration-c",
]);

async function setupIndexedDbTestEnv() {
  try {
    await import("fake-indexeddb/auto");
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

function createLegacyGraph(chatId, suffix = "legacy") {
  const graph = createEmptyGraph();
  graph.historyState.chatId = chatId;
  graph.historyState.lastProcessedAssistantFloor = 8;
  graph.historyState.extractionCount = 3;
  graph.lastProcessedSeq = 8;
  graph.nodes.push(
    {
      id: `node-${suffix}-a`,
      type: "event",
      seq: 5,
      seqRange: [4, 5],
      archived: false,
      fields: {
        title: "第一条",
      },
    },
    {
      id: `node-${suffix}-b`,
      type: "event",
      seq: 8,
      archived: false,
      fields: {
        title: "第二条",
      },
    },
  );
  graph.edges.push({
    id: `edge-${suffix}-ab`,
    fromId: `node-${suffix}-a`,
    toId: `node-${suffix}-b`,
    relation: "related",
    seqRange: [5, 8],
  });
  graph.__stBmePersistence = {
    revision: 6,
    reason: "legacy-seed",
    updatedAt: new Date().toISOString(),
  };
  return graph;
}

async function testMigrationSuccessAndMeta() {
  const db = new BmeDatabase("chat-migration-a", { dexieClass: globalThis.Dexie });
  await db.open();

  const before = await db.isEmpty();
  assert.equal(before.empty, true);

  const nowMs = 1735689600000;
  const result = await db.importLegacyGraph(createLegacyGraph("chat-migration-a"), {
    nowMs,
    source: "chat_metadata",
    revision: 6,
  });

  assert.equal(result.migrated, true);
  assert.ok(result.revision >= 1);

  const snapshot = await db.exportSnapshot();
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.edges.length, 1);

  const migratedNodeA = snapshot.nodes.find((item) => item.id === "node-legacy-a");
  const migratedNodeB = snapshot.nodes.find((item) => item.id === "node-legacy-b");
  const migratedEdge = snapshot.edges.find((item) => item.id === "edge-legacy-ab");

  assert.ok(migratedNodeA);
  assert.ok(migratedNodeB);
  assert.ok(migratedEdge);

  assert.equal(migratedNodeA.sourceFloor, 5, "node sourceFloor 应优先取 seqRange[1]");
  assert.equal(migratedNodeB.sourceFloor, 8, "node sourceFloor 应回退到 seq");
  assert.equal(migratedEdge.sourceFloor, 8, "edge sourceFloor 应优先取 seqRange[1]");

  assert.equal(snapshot.meta.migrationSource, "chat_metadata");
  assert.equal(snapshot.meta.migrationCompletedAt, nowMs);
  assert.equal(snapshot.meta.legacyRetentionUntil, nowMs + BME_LEGACY_RETENTION_MS);
  assert.equal(snapshot.state.lastProcessedFloor, 8);
  assert.equal(snapshot.state.extractionCount, 3);

  await db.close();
}

async function testMigrationIdempotent() {
  const db = new BmeDatabase("chat-migration-a", { dexieClass: globalThis.Dexie });
  await db.open();

  const beforeSnapshot = await db.exportSnapshot();
  const result = await db.importLegacyGraph(createLegacyGraph("chat-migration-a"), {
    nowMs: beforeSnapshot.meta.migrationCompletedAt + 1000,
    source: "chat_metadata",
    revision: 12,
  });

  assert.equal(result.migrated, false);
  assert.equal(result.reason, "migration-already-completed");

  const afterSnapshot = await db.exportSnapshot();
  assert.equal(afterSnapshot.meta.revision, beforeSnapshot.meta.revision);
  assert.equal(afterSnapshot.nodes.length, beforeSnapshot.nodes.length);

  await db.close();
}

async function testMigrationSkippedWhenNotEmpty() {
  const db = new BmeDatabase("chat-migration-b", { dexieClass: globalThis.Dexie });
  await db.open();

  await db.bulkUpsertNodes([
    {
      id: "existing-node",
      type: "event",
      sourceFloor: 1,
      updatedAt: Date.now(),
    },
  ]);

  const result = await db.importLegacyGraph(createLegacyGraph("chat-migration-b"), {
    nowMs: Date.now(),
    source: "chat_metadata",
    revision: 5,
  });

  assert.equal(result.migrated, false);
  assert.equal(result.reason, "indexeddb-not-empty");

  const migrationCompletedAt = await db.getMeta("migrationCompletedAt", 0);
  assert.equal(migrationCompletedAt, 0);

  await db.close();
}

async function testIsEmptyWithTombstonesOption() {
  const db = new BmeDatabase("chat-migration-c", { dexieClass: globalThis.Dexie });
  await db.open();

  await db.bulkUpsertTombstones([
    {
      id: "tomb-only",
      kind: "node",
      targetId: "legacy-node",
      deletedAt: Date.now(),
      sourceDeviceId: "device-a",
    },
  ]);

  const defaultEmpty = await db.isEmpty();
  const strictEmpty = await db.isEmpty({ includeTombstones: true });

  assert.equal(defaultEmpty.empty, true);
  assert.equal(strictEmpty.empty, false);

  await db.close();
}

async function main() {
  await setupIndexedDbTestEnv();
  await cleanupDatabases();

  await testMigrationSuccessAndMeta();
  await testMigrationIdempotent();
  await testMigrationSkippedWhenNotEmpty();
  await testIsEmptyWithTombstonesOption();

  await cleanupDatabases();

  console.log("indexeddb-migration tests passed");
}

await main();
