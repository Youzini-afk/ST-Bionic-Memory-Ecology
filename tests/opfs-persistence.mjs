import assert from "node:assert/strict";

import {
  BME_RUNTIME_BATCH_JOURNAL_META_KEY,
  BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY,
  BME_TOMBSTONE_RETENTION_MS,
} from "../sync/bme-db.js";
import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  deleteAllOpfsStorage,
  deleteOpfsChatStorage,
  OpfsGraphStore,
  detectOpfsSupport,
} from "../sync/bme-opfs-store.js";
import { createEdge, createEmptyGraph, createNode } from "../graph/graph.js";

const PREFIX = "[ST-BME][opfs-persistence]";

function createNotFoundError(message) {
  const error = new Error(String(message || "Not found"));
  error.name = "NotFoundError";
  return error;
}

function createTypeMismatchError(message) {
  const error = new Error(String(message || "Type mismatch"));
  error.name = "TypeMismatchError";
  return error;
}

class MemoryOpfsFileHandle {
  constructor(parent, name) {
    this.parent = parent;
    this.name = String(name || "");
  }

  async getFile() {
    const parent = this.parent;
    const name = this.name;
    return {
      async text() {
        return String(parent.files.get(name) ?? "");
      },
    };
  }

  async createWritable() {
    const parent = this.parent;
    const name = this.name;
    let buffer = String(parent.files.get(name) ?? "");
    return {
      async write(chunk) {
        if (typeof chunk === "string") {
          buffer = chunk;
          return;
        }
        if (chunk == null) {
          buffer = "";
          return;
        }
        buffer = String(chunk);
      },
      async close() {
        parent.files.set(name, buffer);
      },
    };
  }
}

class MemoryOpfsDirectoryHandle {
  constructor(name = "") {
    this.name = String(name || "");
    this.directories = new Map();
    this.files = new Map();
  }

  async getDirectoryHandle(name, options = {}) {
    const normalizedName = String(name || "");
    if (this.files.has(normalizedName)) {
      throw createTypeMismatchError(
        `A file already exists for directory: ${normalizedName}`,
      );
    }
    let directory = this.directories.get(normalizedName) || null;
    if (!directory) {
      if (!options.create) {
        throw createNotFoundError(`Directory not found: ${normalizedName}`);
      }
      directory = new MemoryOpfsDirectoryHandle(normalizedName);
      this.directories.set(normalizedName, directory);
    }
    return directory;
  }

  async getFileHandle(name, options = {}) {
    const normalizedName = String(name || "");
    if (this.directories.has(normalizedName)) {
      throw createTypeMismatchError(
        `A directory already exists for file: ${normalizedName}`,
      );
    }
    if (!this.files.has(normalizedName)) {
      if (!options.create) {
        throw createNotFoundError(`File not found: ${normalizedName}`);
      }
      this.files.set(normalizedName, "");
    }
    return new MemoryOpfsFileHandle(this, normalizedName);
  }

  async removeEntry(name, options = {}) {
    const normalizedName = String(name || "");
    if (this.files.delete(normalizedName)) {
      return;
    }
    const directory = this.directories.get(normalizedName) || null;
    if (directory) {
      const canDelete =
        options.recursive === true
        || (directory.files.size === 0 && directory.directories.size === 0);
      if (!canDelete) {
        throw new Error(`Directory not empty: ${normalizedName}`);
      }
      this.directories.delete(normalizedName);
      return;
    }
    throw createNotFoundError(`Entry not found: ${normalizedName}`);
  }
}

function createMemoryOpfsRoot() {
  return new MemoryOpfsDirectoryHandle("root");
}

function getChatDirectory(rootDirectory, chatId) {
  const opfsRoot = rootDirectory.directories.get("st-bme") || null;
  assert.ok(opfsRoot, "OPFS 根目录必须存在");
  const chatsDirectory = opfsRoot.directories.get("chats") || null;
  assert.ok(chatsDirectory, "OPFS chats 目录必须存在");
  const chatDirectory = chatsDirectory.directories.get(encodeURIComponent(chatId)) || null;
  assert.ok(chatDirectory, `OPFS chat 目录必须存在: ${chatId}`);
  return chatDirectory;
}

function getNestedDirectory(directoryHandle, ...names) {
  let current = directoryHandle;
  for (const name of names) {
    current = current?.directories?.get(String(name || "")) || null;
    assert.ok(current, `目录必须存在: ${names.join("/")}`);
  }
  return current;
}

async function readJsonFromDirectory(directoryHandle, filename, { retries = 5 } = {}) {
  assert.ok(directoryHandle.files.has(filename), `文件必须存在: ${filename}`);
  let lastError = null;
  let lastText = "";
  const normalizedRetries = Math.max(0, Math.floor(Number(retries) || 0));
  for (let attempt = 0; attempt <= normalizedRetries; attempt += 1) {
    lastText = String(directoryHandle.files.get(filename) || "");
    if (lastText) {
      try {
        return JSON.parse(lastText);
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < normalizedRetries) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error(
    `读取目录 JSON 失败: ${filename} len=${lastText.length} error=${String(lastError?.message || "empty")}`,
  );
}

function buildLegacyGraph(chatId) {
  const graph = createEmptyGraph();
  graph.historyState.chatId = chatId;

  const node = createNode({
    type: "event",
    fields: {
      title: "legacy-node",
    },
    seq: 5,
    seqRange: [4, 5],
  });
  node.id = "legacy-node";
  node.updatedAt = 1000;

  const edge = createEdge({
    fromId: node.id,
    toId: node.id,
    relation: "self",
  });
  edge.id = "legacy-edge";
  edge.updatedAt = 1001;

  graph.nodes.push(node);
  graph.edges.push(edge);
  return graph;
}

async function testDetectOpfsSupport() {
  const rootDirectory = createMemoryOpfsRoot();
  const supported = await detectOpfsSupport({
    rootDirectoryFactory: async () => rootDirectory,
  });
  assert.equal(supported.available, true);
  assert.equal(supported.reason, "ok");

  const conflictedRootDirectory = createMemoryOpfsRoot();
  conflictedRootDirectory.files.set("st-bme", "legacy-conflict");
  const repairedConflict = await detectOpfsSupport({
    rootDirectoryFactory: async () => conflictedRootDirectory,
  });
  assert.equal(repairedConflict.available, true);
  assert.equal(repairedConflict.reason, "ok");
  assert.equal(conflictedRootDirectory.files.has("st-bme"), false);
  assert.ok(conflictedRootDirectory.directories.has("st-bme"));

  const missingHandle = await detectOpfsSupport({
    rootDirectoryFactory: async () => ({}),
  });
  assert.equal(missingHandle.available, false);
  assert.equal(missingHandle.reason, "missing-directory-handle");

  const failing = await detectOpfsSupport({
    rootDirectoryFactory: async () => {
      throw new Error("opfs-unavailable");
    },
  });
  assert.equal(failing.available, false);
  assert.equal(failing.reason, "opfs-unavailable");
}

async function testImportExportPersistenceAndFileRotation() {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore("chat-opfs-persist", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });

  await store.open();

  const initialSnapshot = await store.exportSnapshot();
  assert.equal(initialSnapshot.meta.chatId, "chat-opfs-persist");
  assert.equal(initialSnapshot.meta.storagePrimary, "opfs");
  assert.equal(initialSnapshot.meta.storageMode, "opfs-primary");

  const chatDirectory = getChatDirectory(rootDirectory, "chat-opfs-persist");
  assert.deepEqual(Array.from(chatDirectory.files.keys()).sort(), ["manifest.json"]);

  await store.importSnapshot(
    {
      meta: {
        revision: 4,
        deviceId: "device-1",
        [BME_RUNTIME_BATCH_JOURNAL_META_KEY]: {
          pending: ["job-1"],
        },
        [BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY]: {
          completedAt: 123,
        },
      },
      state: {
        lastProcessedFloor: 8,
        extractionCount: 2,
      },
      nodes: [
        {
          id: "node-1",
          type: "event",
          fields: {
            title: "A",
          },
          archived: false,
          updatedAt: 1000,
        },
      ],
      edges: [
        {
          id: "edge-1",
          fromId: "node-1",
          toId: "node-1",
          relation: "self",
          updatedAt: 1001,
        },
      ],
      tombstones: [
        {
          id: "ts-1",
          kind: "node",
          targetId: "node-old",
          sourceDeviceId: "device-1",
          deletedAt: 1002,
        },
      ],
    },
    {
      mode: "replace",
      preserveRevision: true,
      markSyncDirty: false,
    },
  );

  const manifestAfterFirstImport = await readJsonFromDirectory(chatDirectory, "manifest.json");
  assert.equal(manifestAfterFirstImport.formatVersion, 2);
  assert.equal(manifestAfterFirstImport.baseRevision, 4);
  assert.equal(manifestAfterFirstImport.headRevision, 4);
  assert.equal(manifestAfterFirstImport.wal.count, 0);
  const metaDirectory = getNestedDirectory(chatDirectory, "meta");
  const shardDirectory = getNestedDirectory(chatDirectory, "shards");
  const nodeShardDirectory = getNestedDirectory(shardDirectory, "nodes");
  const edgeShardDirectory = getNestedDirectory(shardDirectory, "edges");
  const tombstoneShardDirectory = getNestedDirectory(shardDirectory, "tombstones");
  const walDirectory = getNestedDirectory(chatDirectory, "wal");
  assert.ok(metaDirectory.files.size > 0);
  assert.ok(nodeShardDirectory.files.size > 0);
  assert.ok(edgeShardDirectory.files.size > 0);
  assert.ok(tombstoneShardDirectory.files.size > 0);
  assert.equal(walDirectory.files.size, 0);

  const firstExportedSnapshot = await store.exportSnapshot();
  assert.equal(firstExportedSnapshot.meta.revision, 4);
  assert.equal(firstExportedSnapshot.state.lastProcessedFloor, 8);
  assert.equal(firstExportedSnapshot.state.extractionCount, 2);
  assert.equal(firstExportedSnapshot.meta.storagePrimary, "opfs");
  assert.equal(firstExportedSnapshot.meta.storageMode, "opfs-primary");
  const lightweightSnapshot = await store.exportSnapshot({
    includeTombstones: false,
  });
  assert.equal(lightweightSnapshot.__stBmeTombstonesOmitted, true);
  assert.deepEqual(lightweightSnapshot.tombstones, []);
  assert.equal(lightweightSnapshot.meta.tombstoneCount, 1);
  assert.deepEqual(firstExportedSnapshot.meta[BME_RUNTIME_BATCH_JOURNAL_META_KEY], {
    pending: ["job-1"],
  });
  assert.deepEqual(
    firstExportedSnapshot.meta[BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY],
    {
      completedAt: 123,
    },
  );

  await store.close();

  const reopenedStore = new OpfsGraphStore("chat-opfs-persist", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await reopenedStore.open();

  const reopenedSnapshot = await reopenedStore.exportSnapshot();
  assert.equal(reopenedSnapshot.meta.revision, 4);
  assert.equal(reopenedSnapshot.nodes.length, 1);
  assert.equal(reopenedSnapshot.edges.length, 1);
  assert.equal(reopenedSnapshot.tombstones.length, 1);
  assert.deepEqual(reopenedSnapshot.meta[BME_RUNTIME_BATCH_JOURNAL_META_KEY], {
    pending: ["job-1"],
  });
  assert.deepEqual(reopenedSnapshot.meta[BME_RUNTIME_MAINTENANCE_JOURNAL_META_KEY], {
    completedAt: 123,
  });

  await reopenedStore.importSnapshot(
    {
      meta: {
        revision: 6,
      },
      state: {
        lastProcessedFloor: 9,
        extractionCount: 4,
      },
      nodes: [
        {
          id: "node-2",
          type: "fact",
          fields: {
            title: "B",
          },
          archived: false,
          updatedAt: 2000,
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

  const manifestAfterSecondImport = await readJsonFromDirectory(chatDirectory, "manifest.json");
  assert.equal(manifestAfterSecondImport.formatVersion, 2);
  assert.equal(manifestAfterSecondImport.baseRevision, 6);
  assert.equal(manifestAfterSecondImport.headRevision, 6);
  assert.equal(manifestAfterSecondImport.wal.count, 0);
  const secondSnapshot = await reopenedStore.exportSnapshot();
  assert.deepEqual(secondSnapshot.nodes.map((item) => item.id), ["node-2"]);
  assert.equal(secondSnapshot.edges.length, 0);
  assert.equal(secondSnapshot.tombstones.length, 0);

  await reopenedStore.close();
}

async function testImportLegacyGraphMigrationAndSkipPaths() {
  const migrationRoot = createMemoryOpfsRoot();
  const migrationStore = new OpfsGraphStore("chat-opfs-legacy", {
    rootDirectoryFactory: async () => migrationRoot,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  });
  await migrationStore.open();

  const nowMs = 1_700_000_000_000;
  const migrated = await migrationStore.importLegacyGraph(
    buildLegacyGraph("chat-opfs-legacy"),
    {
      nowMs,
      source: "chat_metadata",
      legacyRetentionMs: 5000,
      revision: 7,
    },
  );
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.skipped, false);
  assert.equal(migrated.reason, "migrated");
  assert.equal(migrated.revision, 7);

  const migratedSnapshot = await migrationStore.exportSnapshot();
  assert.equal(migratedSnapshot.meta.migrationCompletedAt, nowMs);
  assert.equal(migratedSnapshot.meta.migrationSource, "chat_metadata");
  assert.equal(migratedSnapshot.meta.legacyRetentionUntil, nowMs + 5000);
  assert.equal(migratedSnapshot.meta.storagePrimary, "opfs");
  assert.equal(migratedSnapshot.meta.storageMode, "opfs-primary");
  assert.equal(migratedSnapshot.nodes.length, 1);
  assert.equal(migratedSnapshot.edges.length, 1);
  assert.equal(migratedSnapshot.nodes[0]?.sourceFloor, 5);
  assert.equal(migratedSnapshot.edges[0]?.sourceFloor, 5);

  const repeatedMigration = await migrationStore.importLegacyGraph(
    buildLegacyGraph("chat-opfs-legacy"),
    {
      nowMs: nowMs + 1000,
      source: "chat_metadata",
    },
  );
  assert.equal(repeatedMigration.migrated, false);
  assert.equal(repeatedMigration.skipped, true);
  assert.equal(repeatedMigration.reason, "migration-already-completed");

  await migrationStore.close();

  const nonEmptyRoot = createMemoryOpfsRoot();
  const nonEmptyStore = new OpfsGraphStore("chat-opfs-non-empty", {
    rootDirectoryFactory: async () => nonEmptyRoot,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  });
  await nonEmptyStore.open();
  await nonEmptyStore.importSnapshot(
    {
      meta: {
        revision: 2,
      },
      state: {},
      nodes: [
        {
          id: "existing-node",
          type: "event",
          fields: {
            title: "existing",
          },
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

  const skippedBecauseNonEmpty = await nonEmptyStore.importLegacyGraph(
    buildLegacyGraph("chat-opfs-non-empty"),
    {
      nowMs,
      source: "chat_metadata",
    },
  );
  assert.equal(skippedBecauseNonEmpty.migrated, false);
  assert.equal(skippedBecauseNonEmpty.skipped, true);
  assert.equal(skippedBecauseNonEmpty.reason, "local-store-not-empty");

  const nonEmptySnapshot = await nonEmptyStore.exportSnapshot();
  assert.deepEqual(nonEmptySnapshot.nodes.map((item) => item.id), ["existing-node"]);

  await nonEmptyStore.close();
}

async function testPruneExpiredTombstonesAndClearAll() {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore("chat-opfs-prune", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  });
  await store.open();

  const nowMs = BME_TOMBSTONE_RETENTION_MS + 100_000;
  await store.importSnapshot(
    {
      meta: {
        revision: 3,
      },
      state: {},
      nodes: [],
      edges: [],
      tombstones: [
        {
          id: "ts-old",
          kind: "node",
          targetId: "node-old",
          sourceDeviceId: "device-1",
          deletedAt: nowMs - BME_TOMBSTONE_RETENTION_MS - 1,
        },
        {
          id: "ts-fresh",
          kind: "edge",
          targetId: "edge-fresh",
          sourceDeviceId: "device-1",
          deletedAt: nowMs - BME_TOMBSTONE_RETENTION_MS + 1,
        },
      ],
    },
    {
      mode: "replace",
      preserveRevision: true,
    },
  );

  const emptyIgnoringTombstones = await store.isEmpty();
  assert.equal(emptyIgnoringTombstones.empty, true);
  const emptyIncludingTombstones = await store.isEmpty({ includeTombstones: true });
  assert.equal(emptyIncludingTombstones.empty, false);

  const pruneResult = await store.pruneExpiredTombstones(nowMs);
  assert.equal(pruneResult.pruned, 1);
  assert.equal(pruneResult.revision, 4);

  const afterPruneSnapshot = await store.exportSnapshot();
  assert.deepEqual(afterPruneSnapshot.tombstones.map((item) => item.id), ["ts-fresh"]);

  const clearResult = await store.clearAll();
  assert.equal(clearResult.cleared, true);
  assert.equal(clearResult.revision, 5);

  const afterClearSnapshot = await store.exportSnapshot();
  assert.equal(afterClearSnapshot.nodes.length, 0);
  assert.equal(afterClearSnapshot.edges.length, 0);
  assert.equal(afterClearSnapshot.tombstones.length, 0);
  assert.equal(afterClearSnapshot.meta.storagePrimary, "opfs");
  assert.equal(afterClearSnapshot.meta.storageMode, "opfs-primary");

  const emptyAfterClear = await store.isEmpty({ includeTombstones: true });
  assert.equal(emptyAfterClear.empty, true);

  await store.close();
}

async function testDeleteCurrentAndAllOpfsStorage() {
  const rootDirectory = createMemoryOpfsRoot();
  const storeA = new OpfsGraphStore("chat-opfs-delete-a", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  const storeB = new OpfsGraphStore("chat-opfs-delete-b", {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await storeA.open();
  await storeB.open();

  await storeA.importSnapshot(
    {
      meta: { revision: 1 },
      state: { lastProcessedFloor: 1, extractionCount: 1 },
      nodes: [{ id: "node-a", type: "event", fields: { title: "A" }, archived: false, updatedAt: 1 }],
      edges: [],
      tombstones: [],
    },
    { mode: "replace", preserveRevision: true },
  );
  await storeB.importSnapshot(
    {
      meta: { revision: 1 },
      state: { lastProcessedFloor: 1, extractionCount: 1 },
      nodes: [{ id: "node-b", type: "event", fields: { title: "B" }, archived: false, updatedAt: 1 }],
      edges: [],
      tombstones: [],
    },
    { mode: "replace", preserveRevision: true },
  );

  const deleteCurrentResult = await deleteOpfsChatStorage("chat-opfs-delete-a", {
    rootDirectoryFactory: async () => rootDirectory,
  });
  assert.equal(deleteCurrentResult.deleted, true);

  const chatsDirectory = getNestedDirectory(
    getNestedDirectory(rootDirectory, "st-bme"),
    "chats",
  );
  assert.equal(chatsDirectory.directories.has(encodeURIComponent("chat-opfs-delete-a")), false);
  assert.equal(chatsDirectory.directories.has(encodeURIComponent("chat-opfs-delete-b")), true);

  const deleteAllResult = await deleteAllOpfsStorage({
    rootDirectoryFactory: async () => rootDirectory,
  });
  assert.equal(deleteAllResult.deleted, true);
  assert.equal(rootDirectory.directories.has("st-bme"), false);
}

async function main() {
  console.log(`${PREFIX} starting`);

  await testDetectOpfsSupport();
  await testImportExportPersistenceAndFileRotation();
  await testImportLegacyGraphMigrationAndSkipPaths();
  await testPruneExpiredTombstonesAndClearAll();
  await testDeleteCurrentAndAllOpfsStorage();

  console.log("opfs-persistence tests passed");
}

await main();
