import assert from "node:assert/strict";

import {
  BME_SYNC_DEVICE_ID_KEY,
  BME_SYNC_UPLOAD_DEBOUNCE_MS,
  __testOnlyDecodeBase64Utf8,
  autoSyncOnChatChange,
  autoSyncOnVisibility,
  backupToServer,
  buildRestoreSafetyChatId,
  deleteRemoteSyncFile,
  deleteServerBackup,
  getRestoreSafetySnapshotStatus,
  getOrCreateDeviceId,
  getRemoteStatus,
  download,
  listServerBackups,
  mergeSnapshots,
  rollbackFromRestoreSafetySnapshot,
  restoreFromServer,
  scheduleUpload,
  syncNow,
  upload,
} from "../sync/bme-sync.js";
import { MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY } from "../runtime/runtime-state.js";

const PREFIX = "[ST-BME][indexeddb-sync]";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }
}

class FakeDb {
  constructor(chatId, snapshot = null) {
    this.chatId = chatId;
    this.snapshot = snapshot || {
      meta: {
        schemaVersion: 1,
        chatId,
        deviceId: "",
        revision: 0,
        lastModified: Date.now(),
        nodeCount: 0,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: -1,
        extractionCount: 0,
      },
    };
    this.meta = new Map([
      ["syncDirty", false],
      ["syncDirtyReason", ""],
      ["lastSyncedRevision", 0],
      ["deviceId", ""],
    ]);
    this.lastImportPayload = null;
    this.lastImportOptions = null;
  }

  async exportSnapshot() {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  async importSnapshot(snapshot, options = {}) {
    this.lastImportPayload = JSON.parse(JSON.stringify(snapshot));
    this.lastImportOptions = { ...options };
    this.snapshot = JSON.parse(JSON.stringify(snapshot));
    return {
      mode: options.mode || "replace",
      revision: snapshot?.meta?.revision || 0,
      imported: {
        nodes: Array.isArray(snapshot?.nodes) ? snapshot.nodes.length : 0,
        edges: Array.isArray(snapshot?.edges) ? snapshot.edges.length : 0,
        tombstones: Array.isArray(snapshot?.tombstones) ? snapshot.tombstones.length : 0,
      },
    };
  }

  async getMeta(key, fallback = null) {
    return this.meta.has(key) ? this.meta.get(key) : fallback;
  }

  async patchMeta(record = {}) {
    for (const [key, value] of Object.entries(record)) {
      this.meta.set(key, value);
    }
  }

  async setMeta(key, value) {
    this.meta.set(key, value);
  }
}

function createJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() {
      return JSON.parse(JSON.stringify(body));
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function createMockFetchEnvironment() {
  const remoteFiles = new Map();
  const logs = {
    sanitizeCalls: 0,
    getCalls: 0,
    uploadCalls: 0,
    deleteCalls: 0,
    uploadedPayloads: [],
  };

  const fetch = async (url, options = {}) => {
    const method = String(options?.method || "GET").toUpperCase();

    if (url === "/api/files/sanitize-filename" && method === "POST") {
      logs.sanitizeCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      const sanitized = String(body.fileName || "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, "_");
      return createJsonResponse(200, { fileName: sanitized });
    }

    if (url === "/api/files/upload" && method === "POST") {
      logs.uploadCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      if (!/^[A-Za-z0-9._~-]+$/.test(String(body.name || ""))) {
        return createJsonResponse(
          400,
          "Illegal character in filename; only alphanumeric, '-', '_', '.', '~' are accepted.",
        );
      }
      const decoded = __testOnlyDecodeBase64Utf8(body.data);
      const payload = JSON.parse(decoded);
      remoteFiles.set(body.name, payload);
      logs.uploadedPayloads.push({
        name: body.name,
        decoded,
        payload,
      });
      return createJsonResponse(200, { path: `/user/files/${body.name}` });
    }

    if (url === "/api/files/delete" && method === "POST") {
      logs.deleteCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      const name = String(body.path || "").replace("/user/files/", "");
      if (!remoteFiles.has(name)) return createJsonResponse(404, "not found");
      remoteFiles.delete(name);
      return createJsonResponse(200, {});
    }

    if (String(url).startsWith("/user/files/") && method === "GET") {
      logs.getCalls += 1;
      const withoutQuery = String(url).split("?")[0];
      const fileName = decodeURIComponent(withoutQuery.slice("/user/files/".length));
      if (!remoteFiles.has(fileName)) {
        return createJsonResponse(404, "not found");
      }
      return createJsonResponse(200, remoteFiles.get(fileName));
    }

    return createJsonResponse(404, "unsupported route");
  };

  return {
    fetch,
    remoteFiles,
    logs,
  };
}

function buildRuntimeOptions({ dbByChatId, fetch }) {
  return {
    fetch,
    getDb: async (chatId) => {
      const db = dbByChatId.get(chatId);
      if (!db) throw new Error(`missing db: ${chatId}`);
      return db;
    },
    getRequestHeaders: () => ({
      "X-Test": "1",
    }),
    disableRemoteSanitize: false,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createVisibilityMockDocument(initialVisibilityState = "visible") {
  const listeners = new Map();
  const document = {
    visibilityState: initialVisibilityState,
    addEventListener(eventName, handler) {
      listeners.set(String(eventName), handler);
    },
  };

  return {
    document,
    emitVisibilityChange(nextVisibilityState) {
      document.visibilityState = nextVisibilityState;
      const handler = listeners.get("visibilitychange");
      if (typeof handler === "function") {
        handler();
      }
    },
    getListener(eventName) {
      return listeners.get(String(eventName));
    },
  };
}

async function testDeviceId() {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;

  const first = getOrCreateDeviceId();
  const second = getOrCreateDeviceId();

  assert.ok(first);
  assert.equal(first, second);
  assert.equal(storage.getItem(BME_SYNC_DEVICE_ID_KEY), first);
}

async function testRemoteStatusMissing() {
  const { fetch } = createMockFetchEnvironment();
  const status = await getRemoteStatus("chat-a", {
    fetch,
    getRequestHeaders: () => ({}),
  });

  assert.equal(status.exists, false);
  assert.equal(status.status, "not-found");
}

async function testUploadPayloadMetaFirstAndDebounce() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  dbByChatId.set(
    "chat-upload",
    new FakeDb("chat-upload", {
      meta: {
        schemaVersion: 1,
        chatId: "chat-upload",
        deviceId: "",
        revision: 9,
        lastModified: Date.now(),
        nodeCount: 1,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [{ id: "n1", updatedAt: 100 }],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: 7, extractionCount: 4 },
    }),
  );

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const uploadResult = await upload("chat-upload", runtime);
  assert.equal(uploadResult.uploaded, true);
  assert.equal(logs.uploadCalls, 1);

  const uploadedPayload = logs.uploadedPayloads[0].payload;
  assert.equal(Object.keys(uploadedPayload)[0], "meta");
  assert.equal(uploadedPayload.meta.revision, 9);

  scheduleUpload("chat-upload", {
    ...runtime,
    debounceMs: 20,
  });
  await sleep(50);
  assert.equal(logs.uploadCalls, 2);
}

async function testUploadSanitizesIllegalChatIdFilename() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "世界书 测试(chat)#1";
  dbByChatId.set(chatId, new FakeDb(chatId));

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const uploadResult = await upload(chatId, runtime);

  assert.equal(uploadResult.uploaded, true);
  assert.equal(logs.uploadCalls, 1);
  assert.match(uploadResult.filename, /^ST-BME_sync_[A-Za-z0-9._~-]+\.json$/);
  assert.match(logs.uploadedPayloads[0].name, /^[A-Za-z0-9._~-]+$/);
}

async function testDownloadImport() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-download");
  dbByChatId.set("chat-download", db);

  remoteFiles.set("ST-BME_sync_chat-download.json", {
    meta: {
      schemaVersion: 1,
      chatId: "chat-download",
      revision: 12,
      deviceId: "remote-device",
      lastModified: 500,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "remote-node", updatedAt: 400 }],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 10,
      extractionCount: 2,
    },
  });

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const result = await download("chat-download", runtime);

  assert.equal(result.downloaded, true);
  assert.equal(db.lastImportPayload.meta.revision, 12);
  assert.equal(db.lastImportPayload.nodes[0].id, "remote-node");
}

async function testLegacyRemoteFilenameFallbackAndReuse() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat~legacy name";
  const db = new FakeDb(chatId);
  dbByChatId.set(chatId, db);

  remoteFiles.set("ST-BME_sync_chat~legacy_name.json", {
    meta: {
      schemaVersion: 1,
      chatId,
      revision: 4,
      deviceId: "remote-device",
      lastModified: 400,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "legacy-node", updatedAt: 300 }],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 3,
      extractionCount: 2,
    },
  });

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const status = await getRemoteStatus(chatId, runtime);
  assert.equal(status.exists, true);
  assert.equal(status.filename, "ST-BME_sync_chat~legacy_name.json");

  const downloadResult = await download(chatId, runtime);
  assert.equal(downloadResult.downloaded, true);
  assert.equal(downloadResult.filename, "ST-BME_sync_chat~legacy_name.json");
  assert.equal(db.lastImportPayload.nodes[0].id, "legacy-node");

  const uploadResult = await upload(chatId, runtime);
  assert.equal(uploadResult.uploaded, true);
  assert.equal(uploadResult.filename, "ST-BME_sync_chat~legacy_name.json");
  assert.equal(logs.uploadedPayloads.at(-1)?.name, "ST-BME_sync_chat~legacy_name.json");
}

async function testMergeRules() {
  const local = {
    meta: {
      chatId: "chat-merge",
      revision: 7,
      lastModified: 100,
      deviceId: "local-device",
      schemaVersion: 1,
    },
    nodes: [{ id: "node-a", updatedAt: 100, value: "old" }],
    edges: [{ id: "edge-a", updatedAt: 100, fromId: "a", toId: "b" }],
    tombstones: [],
    state: {
      lastProcessedFloor: 5,
      extractionCount: 3,
    },
  };

  const remote = {
    meta: {
      chatId: "chat-merge",
      revision: 10,
      lastModified: 200,
      deviceId: "remote-device",
      schemaVersion: 1,
    },
    nodes: [{ id: "node-a", updatedAt: 200, value: "new" }],
    edges: [{ id: "edge-a", updatedAt: 200, fromId: "a", toId: "b" }],
    tombstones: [
      {
        id: "node:node-a",
        kind: "node",
        targetId: "node-a",
        deletedAt: 250,
        sourceDeviceId: "remote-device",
      },
    ],
    state: {
      lastProcessedFloor: 8,
      extractionCount: 2,
    },
  };

  const merged = mergeSnapshots(local, remote, { chatId: "chat-merge" });

  assert.equal(merged.meta.revision, 11);
  assert.equal(merged.nodes.length, 0, "tombstone 必须覆盖复活");
  assert.equal(merged.state.lastProcessedFloor, 8);
  assert.equal(merged.state.extractionCount, 3);
}

async function testMergeRuntimeMetaPolicies() {
  const local = {
    meta: {
      chatId: "chat-merge-meta",
      revision: 7,
      lastModified: 200,
      deviceId: "local-device",
      schemaVersion: 1,
      runtimeHistoryState: {
        chatId: "chat-merge-meta",
        lastProcessedAssistantFloor: 6,
        extractionCount: 6,
        processedMessageHashes: {
          1: "h1",
          2: "h2",
          3: "h3",
          4: "local-h4",
          6: "h6",
        },
      },
      runtimeVectorIndexState: {
        hashToNodeId: {
          "hash-local-a": "node-a",
          "hash-shared-b": "node-b",
        },
        nodeToHash: {
          "node-a": "hash-local-a",
          "node-b": "hash-shared-b",
        },
      },
      runtimeBatchJournal: [
        { id: "journal-shared", processedRange: [0, 2], createdAt: 100 },
        { id: "journal-drop-local", processedRange: [4, 5], createdAt: 110 },
      ],
      runtimeLastRecallResult: { nodes: ["local-only"] },
      runtimeSummaryState: { updatedAt: 500, frontier: ["local-summary"] },
      maintenanceJournal: [{ id: "maintenance-local", updatedAt: 600 }],
      knowledgeState: { updatedAt: 700, activeOwnerKey: "local-owner" },
      regionState: { updatedAt: 800, activeRegion: "local-region" },
      timelineState: { updatedAt: 900, activeSegmentId: "local-segment" },
      runtimeLastProcessedSeq: 2,
      runtimeGraphVersion: 10,
    },
    nodes: [
      { id: "node-a", updatedAt: 100 },
      { id: "node-b", updatedAt: 100 },
    ],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 6,
      extractionCount: 3,
    },
  };

  const remote = {
    meta: {
      chatId: "chat-merge-meta",
      revision: 10,
      lastModified: 200,
      deviceId: "remote-device",
      schemaVersion: 1,
      runtimeHistoryState: {
        chatId: "chat-merge-meta",
        lastProcessedAssistantFloor: 5,
        extractionCount: 7,
        processedMessageHashes: {
          1: "h1",
          2: "h2",
          3: "h3",
          4: "remote-h4",
          5: "h5",
        },
      },
      runtimeVectorIndexState: {
        hashToNodeId: {
          "hash-remote-a": "node-a",
          "hash-shared-b": "node-b",
        },
        nodeToHash: {
          "node-a": "hash-remote-a",
          "node-b": "hash-shared-b",
        },
      },
      runtimeBatchJournal: [
        { id: "journal-shared", processedRange: [0, 3], createdAt: 210 },
        { id: "journal-drop-remote", processedRange: [3, 4], createdAt: 220 },
      ],
      runtimeLastRecallResult: { nodes: ["remote-only"] },
      runtimeSummaryState: { updatedAt: 1500, frontier: ["remote-summary"] },
      maintenanceJournal: [{ id: "maintenance-remote", updatedAt: 1600 }],
      knowledgeState: { updatedAt: 1700, activeOwnerKey: "remote-owner" },
      regionState: { updatedAt: 1800, activeRegion: "remote-region" },
      timelineState: { updatedAt: 1900, activeSegmentId: "remote-segment" },
      runtimeLastProcessedSeq: 9,
      runtimeGraphVersion: 7,
    },
    nodes: [
      { id: "node-a", updatedAt: 200 },
      { id: "node-b", updatedAt: 200 },
    ],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 5,
      extractionCount: 2,
    },
  };

  const merged = mergeSnapshots(local, remote, { chatId: "chat-merge-meta" });

  assert.equal(merged.state.lastProcessedFloor, 3, "冲突哈希楼层应触发保守回退");
  assert.equal(merged.state.extractionCount, 7);
  assert.deepEqual(Object.keys(merged.meta.runtimeHistoryState.processedMessageHashes), ["1", "2", "3"]);
  assert.equal(merged.meta.runtimeHistoryState.historyDirtyFrom, 4);
  assert.ok(String(merged.meta.runtimeHistoryState.lastMutationReason).includes("processed-hash-conflict@4"));
  assert.equal(merged.meta.runtimeVectorIndexState.nodeToHash["node-a"], undefined);
  assert.equal(merged.meta.runtimeVectorIndexState.nodeToHash["node-b"], "hash-shared-b");
  assert.equal(merged.meta.runtimeVectorIndexState.hashToNodeId["hash-local-a"], undefined);
  assert.equal(merged.meta.runtimeVectorIndexState.hashToNodeId["hash-remote-a"], undefined);
  assert.equal(merged.meta.runtimeVectorIndexState.hashToNodeId["hash-shared-b"], "node-b");
  assert.equal(merged.meta.runtimeVectorIndexState.dirty, true);
  assert.ok(merged.meta.runtimeVectorIndexState.replayRequiredNodeIds.includes("node-a"));
  assert.equal(merged.meta.runtimeVectorIndexState.pendingRepairFromFloor, 3);
  assert.equal(merged.meta.runtimeBatchJournal.length, 1);
  assert.equal(merged.meta.runtimeBatchJournal[0].id, "journal-shared");
  assert.deepEqual(merged.meta.runtimeBatchJournal[0].processedRange, [0, 3]);
  assert.equal(merged.meta.runtimeLastRecallResult, null);
  assert.equal(merged.meta.runtimeSummaryState.frontier[0], "remote-summary");
  assert.equal(merged.meta.maintenanceJournal[0].id, "maintenance-remote");
  assert.equal(merged.meta.knowledgeState.activeOwnerKey, "remote-owner");
  assert.equal(merged.meta.regionState.activeRegion, "remote-region");
  assert.equal(merged.meta.timelineState.activeSegmentId, "remote-segment");
  assert.equal(merged.meta.runtimeLastProcessedSeq, 9);
  assert.equal(merged.meta.runtimeGraphVersion, 11);
}

async function testManualCloudModeGuards() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  dbByChatId.set("chat-manual", new FakeDb("chat-manual"));

  const runtime = {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    cloudStorageMode: "manual",
  };

  const scheduleResult = scheduleUpload("chat-manual", runtime);
  assert.equal(scheduleResult.scheduled, false);
  assert.equal(scheduleResult.reason, "manual-cloud-mode");

  const syncResult = await syncNow("chat-manual", runtime);
  assert.equal(syncResult.action, "manual-probe");
  assert.equal(logs.uploadCalls, 0);

  const chatChangeResult = await autoSyncOnChatChange("chat-manual", runtime);
  assert.equal(chatChangeResult.action, "manual-probe");
  assert.equal(chatChangeResult.remoteStatus, null);
  assert.equal(logs.getCalls, 0);
  assert.equal(logs.uploadCalls, 0);
}

async function testManualBackupAndRestoreFlow() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-backup-flow", {
    meta: {
      schemaVersion: 1,
      chatId: "chat-backup-flow",
      revision: 8,
      lastModified: 80,
      deviceId: "",
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
      runtimeHistoryState: {
        chatId: "chat-backup-flow",
        lastProcessedAssistantFloor: 4,
        extractionCount: 2,
        processedMessageHashVersion: 2,
        processedMessageHashes: {
          0: "hash-0",
          1: "hash-1",
          2: "hash-2",
          3: "hash-3",
          4: "hash-4",
        },
        processedMessageHashesNeedRefresh: false,
        historyDirtyFrom: 2,
        lastMutationReason: "hash-recheck",
        lastMutationSource: "event:message-received",
        lastRecoveryResult: {
          status: "pending",
          fromFloor: 2,
        },
      },
      runtimeBatchJournal: [
        { id: "journal-1", processedRange: [0, 0], createdAt: 11 },
        { id: "journal-2", processedRange: [1, 1], createdAt: 22 },
        { id: "journal-3", processedRange: [2, 2], createdAt: 33 },
        { id: "journal-4", processedRange: [3, 3], createdAt: 44 },
        { id: "journal-5", processedRange: [4, 4], createdAt: 55 },
        { id: "journal-6", processedRange: [5, 5], createdAt: 66 },
      ],
      maintenanceJournal: [
        { id: "maintenance-a", updatedAt: 70 },
        { id: "maintenance-b", updatedAt: 80 },
      ],
    },
    nodes: [{ id: "local-node", updatedAt: 80 }],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 4,
      extractionCount: 2,
    },
  });
  db.meta.set("syncDirty", true);
  dbByChatId.set("chat-backup-flow", db);

  const safetyDb = new FakeDb("__restore_safety__chat-backup-flow");
  const hookCalls = [];
  const runtime = {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    getSafetyDb: async () => safetyDb,
    onSyncApplied: async (payload) => hookCalls.push({ ...payload }),
  };

  const backupResult = await backupToServer("chat-backup-flow", runtime);
  assert.equal(backupResult.backedUp, true);
  assert.equal(db.meta.get("syncDirty"), false);
  assert.ok(Number(db.meta.get("lastBackupUploadedAt")) > 0);
  assert.ok(String(db.meta.get("lastBackupFilename") || "").startsWith("ST-BME_backup_"));
  const backupPayload = remoteFiles.get(backupResult.filename);
  assert.ok(backupPayload, "manual backup should be written to remote files");
  assert.equal(backupPayload.snapshot.meta.runtimeBatchJournal.length, 4);
  assert.deepEqual(
    backupPayload.snapshot.meta.runtimeBatchJournal.map((entry) => entry.id),
    ["journal-3", "journal-4", "journal-5", "journal-6"],
  );
  assert.equal(backupPayload.snapshot.meta.maintenanceJournal.length, 0);
  assert.deepEqual(
    backupPayload.snapshot.meta.runtimeHistoryState[MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY],
    {
      truncated: true,
      earliestRetainedFloor: 2,
      retainedCount: 4,
    },
  );
  assert.deepEqual(
    backupPayload.snapshot.meta.runtimeHistoryState.processedMessageHashes,
    {
      0: "hash-0",
      1: "hash-1",
      2: "hash-2",
      3: "hash-3",
      4: "hash-4",
    },
  );
  assert.equal(
    backupPayload.snapshot.meta.runtimeHistoryState.processedMessageHashesNeedRefresh,
    false,
  );
  const backupUploadLog = logs.uploadedPayloads.find(
    (entry) => entry.name === backupResult.filename,
  );
  assert.ok(backupUploadLog);
  assert.equal(backupUploadLog.decoded.includes("\n"), false);

  const manifestResult = await listServerBackups(runtime);
  assert.equal(manifestResult.entries.length, 1);
  assert.equal(manifestResult.entries[0].chatId, "chat-backup-flow");
  const manifestUploadLog = logs.uploadedPayloads.find(
    (entry) => entry.name === "ST-BME_BackupManifest.json",
  );
  assert.ok(manifestUploadLog);
  assert.equal(manifestUploadLog.decoded.includes("\n"), false);

  db.snapshot = {
    meta: {
      schemaVersion: 1,
      chatId: "chat-backup-flow",
      revision: 1,
      lastModified: 10,
      deviceId: "",
      nodeCount: 0,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: -1,
      extractionCount: 0,
    },
  };

  const restoreResult = await restoreFromServer("chat-backup-flow", runtime);
  assert.equal(restoreResult.restored, true);
  assert.equal(db.snapshot.nodes[0].id, "local-node");
  assert.equal(db.snapshot.meta.runtimeBatchJournal.length, 4);
  assert.equal(db.snapshot.meta.maintenanceJournal.length, 0);
  assert.deepEqual(
    db.snapshot.meta.runtimeHistoryState[MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY],
    {
      truncated: true,
      earliestRetainedFloor: 2,
      retainedCount: 4,
    },
  );
  assert.deepEqual(db.snapshot.meta.runtimeHistoryState.processedMessageHashes, {});
  assert.equal(
    db.snapshot.meta.runtimeHistoryState.processedMessageHashesNeedRefresh,
    true,
  );
  assert.equal(
    db.snapshot.meta.runtimeHistoryState.lastProcessedAssistantFloor,
    4,
  );
  assert.equal(db.snapshot.meta.runtimeHistoryState.historyDirtyFrom, null);
  assert.equal(db.snapshot.meta.runtimeHistoryState.lastMutationReason, "");
  assert.equal(db.snapshot.meta.runtimeHistoryState.lastMutationSource, "");
  assert.equal(db.snapshot.meta.runtimeHistoryState.lastRecoveryResult, null);
  assert.ok(Number(db.meta.get("lastBackupRestoredAt")) > 0);
  const safetyStatus = await getRestoreSafetySnapshotStatus(
    "chat-backup-flow",
    runtime,
  );
  assert.equal(safetyStatus.exists, true);
  assert.equal(safetyDb.lastImportPayload.meta.revision, 1);
  assert.deepEqual(
    hookCalls.map((item) => item.action),
    ["restore-backup"],
  );

  db.snapshot = {
    meta: {
      schemaVersion: 1,
      chatId: "chat-backup-flow",
      revision: 99,
      lastModified: 999,
      deviceId: "",
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "broken-node", updatedAt: 999 }],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 88,
      extractionCount: 9,
    },
  };

  const rollbackResult = await rollbackFromRestoreSafetySnapshot(
    "chat-backup-flow",
    runtime,
  );
  assert.equal(rollbackResult.restored, true);
  assert.equal(db.snapshot.meta.revision, 1);
  assert.equal(db.snapshot.nodes.length, 0);
  assert.equal(db.meta.get("syncDirty"), true);
  assert.ok(Number(db.meta.get("lastBackupRollbackAt")) > 0);

  const deleteResult = await deleteServerBackup("chat-backup-flow", runtime);
  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.localMetaUpdated, true);
  const manifestAfterDelete = await listServerBackups(runtime);
  assert.equal(manifestAfterDelete.entries.length, 0);
  assert.equal(
    Array.from(remoteFiles.keys()).some((key) => key.startsWith("ST-BME_backup_")),
    false,
  );
  assert.equal(db.meta.get("lastBackupUploadedAt"), 0);
  assert.equal(db.meta.get("lastBackupFilename"), "");
}

async function testBackupManifestReadFailureDoesNotOverwriteManifest() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-manifest-guard", {
    meta: {
      schemaVersion: 1,
      chatId: "chat-manifest-guard",
      revision: 3,
      lastModified: 30,
      deviceId: "",
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "node-manifest", updatedAt: 30 }],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 2,
      extractionCount: 1,
    },
  });
  dbByChatId.set("chat-manifest-guard", db);

  remoteFiles.set("ST-BME_BackupManifest.json", [
    {
      filename: "ST-BME_backup_existing-a.json",
      serverPath: "user/files/ST-BME_backup_existing-a.json",
      chatId: "chat-a",
      revision: 1,
      lastModified: 10,
      backupTime: 10,
      size: 100,
      schemaVersion: 1,
    },
  ]);

  let failManifestRead = true;
  const guardedFetch = async (url, options = {}) => {
    if (
      failManifestRead
      && String(options?.method || "GET").toUpperCase() === "GET"
      && String(url).startsWith("/user/files/ST-BME_BackupManifest.json")
    ) {
      return createJsonResponse(500, "manifest read failed");
    }
    return await fetch(url, options);
  };

  const runtime = buildRuntimeOptions({ dbByChatId, fetch: guardedFetch });
  const backupResult = await backupToServer("chat-manifest-guard", runtime);
  assert.equal(backupResult.backedUp, false);
  assert.equal(backupResult.reason, "backup-manifest-error");
  assert.equal(backupResult.backupUploaded, true);

  failManifestRead = false;
  const manifestResult = await listServerBackups(runtime);
  assert.equal(manifestResult.entries.length, 1);
  assert.equal(manifestResult.entries[0].chatId, "chat-a");
}

async function testRestoreValidationDoesNotCreateSafetySnapshot() {
  const { fetch } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-no-backup");
  const safetyDb = new FakeDb(buildRestoreSafetyChatId("chat-no-backup"));
  dbByChatId.set("chat-no-backup", db);

  const runtime = {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    getSafetyDb: async () => safetyDb,
  };

  const restoreResult = await restoreFromServer("chat-no-backup", runtime);
  assert.equal(restoreResult.restored, false);
  assert.equal(restoreResult.reason, "not-found");

  const safetyStatus = await getRestoreSafetySnapshotStatus(
    "chat-no-backup",
    runtime,
  );
  assert.equal(safetyStatus.exists, false);
}

async function testRestoreUsesManifestFilenameWhenCurrentFilenameDrifts() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-filename-drift");
  const safetyDb = new FakeDb(buildRestoreSafetyChatId("chat-filename-drift"));
  dbByChatId.set("chat-filename-drift", db);

  const legacyFilename = "ST-BME_backup_chat-filename-drift-legacy.json";
  remoteFiles.set(legacyFilename, {
    kind: "st-bme-backup",
    version: 1,
    chatId: "chat-filename-drift",
    createdAt: 123,
    sourceDeviceId: "remote-device",
    snapshot: {
      meta: {
        schemaVersion: 1,
        chatId: "chat-filename-drift",
        revision: 7,
        lastModified: 70,
        deviceId: "remote-device",
        nodeCount: 1,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [{ id: "restored-from-drift", updatedAt: 70 }],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: 5,
        extractionCount: 2,
      },
    },
  });
  remoteFiles.set("ST-BME_BackupManifest.json", [
    {
      filename: legacyFilename,
      serverPath: `user/files/${legacyFilename}`,
      chatId: "chat-filename-drift",
      revision: 7,
      lastModified: 70,
      backupTime: 123,
      size: 256,
      schemaVersion: 1,
    },
  ]);

  const runtime = {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    getSafetyDb: async () => safetyDb,
  };

  const restoreResult = await restoreFromServer("chat-filename-drift", runtime);
  assert.equal(restoreResult.restored, true);
  assert.equal(restoreResult.filename, legacyFilename);
  assert.equal(db.snapshot.nodes[0].id, "restored-from-drift");
}

async function testDeleteUsesExplicitManifestFilenameAndClearsLocalBackupMeta() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-delete-drift");
  db.meta.set("lastBackupUploadedAt", 999);
  db.meta.set("lastBackupFilename", "ST-BME_backup_chat-delete-drift-stale.json");
  dbByChatId.set("chat-delete-drift", db);

  const driftFilename = "ST-BME_backup_chat-delete-drift-legacy.json";
  remoteFiles.set(driftFilename, {
    kind: "st-bme-backup",
    version: 1,
    chatId: "chat-delete-drift",
    createdAt: 321,
    sourceDeviceId: "remote-device",
    snapshot: {
      meta: {
        schemaVersion: 1,
        chatId: "chat-delete-drift",
        revision: 3,
        lastModified: 30,
        deviceId: "remote-device",
        nodeCount: 0,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: -1,
        extractionCount: 0,
      },
    },
  });
  remoteFiles.set("ST-BME_BackupManifest.json", [
    {
      filename: driftFilename,
      serverPath: `user/files/${driftFilename}`,
      chatId: "chat-delete-drift",
      revision: 3,
      lastModified: 30,
      backupTime: 321,
      size: 128,
      schemaVersion: 1,
    },
  ]);

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const deleteResult = await deleteServerBackup("chat-delete-drift", {
    ...runtime,
    filename: driftFilename,
    serverPath: `user/files/${driftFilename}`,
  });

  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.filename, driftFilename);
  assert.equal(deleteResult.localMetaUpdated, true);
  assert.equal(remoteFiles.has(driftFilename), false);
  assert.equal(db.meta.get("lastBackupUploadedAt"), 0);
  assert.equal(db.meta.get("lastBackupFilename"), "");

  const manifestResult = await listServerBackups(runtime);
  assert.equal(manifestResult.entries.length, 0);
}

async function testSyncNowLockAndAutoSync() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const db = new FakeDb("chat-lock", {
    meta: {
      schemaVersion: 1,
      chatId: "chat-lock",
      revision: 1,
      lastModified: 10,
      deviceId: "",
      nodeCount: 0,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: -1,
      extractionCount: 0,
    },
  });
  dbByChatId.set("chat-lock", db);

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });

  const [r1, r2] = await Promise.all([
    syncNow("chat-lock", runtime),
    syncNow("chat-lock", runtime),
  ]);

  assert.equal(r1.action, "upload");
  assert.equal(r2.action, "upload");
  assert.equal(logs.uploadCalls, 1, "同 chatId 并发 sync 应串行去重");

  remoteFiles.set("ST-BME_sync_chat-lock.json", {
    meta: {
      schemaVersion: 1,
      chatId: "chat-lock",
      revision: 3,
      lastModified: 99,
      deviceId: "remote-device",
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "remote-new", updatedAt: 99 }],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: 2,
      extractionCount: 1,
    },
  });

  db.meta.set("syncDirty", false);
  const autoResult = await autoSyncOnChatChange("chat-lock", runtime);
  assert.equal(autoResult.action, "download");
  assert.equal(db.lastImportPayload.nodes[0].id, "remote-new");
}

async function testDeleteRemoteSyncFile() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  dbByChatId.set("chat-delete", new FakeDb("chat-delete"));
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });

  await upload("chat-delete", runtime);
  assert.equal(logs.uploadCalls, 1);

  const deleteResult = await deleteRemoteSyncFile("chat-delete", runtime);
  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.chatId, "chat-delete");
  assert.equal(logs.deleteCalls, 1);

  const deleteMissingResult = await deleteRemoteSyncFile("chat-delete", runtime);
  assert.equal(deleteMissingResult.deleted, false);
  assert.equal(deleteMissingResult.reason, "not-found");
  assert.equal(logs.deleteCalls, 2);
}

async function testDeleteRemoteSyncFileFallsBackToLegacyFilename() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat~legacy delete";
  dbByChatId.set(chatId, new FakeDb(chatId));
  remoteFiles.set("ST-BME_sync_chat~legacy_delete.json", {
    meta: {
      schemaVersion: 1,
      chatId,
      revision: 1,
      lastModified: 10,
      deviceId: "remote-device",
      nodeCount: 0,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: {
      lastProcessedFloor: -1,
      extractionCount: 0,
    },
  });

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const deleteResult = await deleteRemoteSyncFile(chatId, runtime);
  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.filename, "ST-BME_sync_chat~legacy_delete.json");
  assert.equal(logs.deleteCalls, 2, "应先尝试新文件名，再回退删除 legacy 文件名");
}

async function testAutoSyncOnVisibility() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  dbByChatId.set(
    "chat-visibility",
    new FakeDb("chat-visibility", {
      meta: {
        schemaVersion: 1,
        chatId: "chat-visibility",
        revision: 2,
        lastModified: 12,
        deviceId: "",
        nodeCount: 0,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: -1, extractionCount: 0 },
    }),
  );

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  runtime.getCurrentChatId = () => "chat-visibility";

  const originalDocument = globalThis.document;
  const visibilityDocument = createVisibilityMockDocument("hidden");
  globalThis.document = visibilityDocument.document;

  try {
    const installResult = autoSyncOnVisibility(runtime);
    assert.equal(installResult.installed, true);
    assert.ok(
      typeof visibilityDocument.getListener("visibilitychange") === "function",
    );

    visibilityDocument.emitVisibilityChange("visible");
    await sleep(30);
    assert.equal(logs.uploadCalls, 1, "visibility visible 应触发一次自动同步");

    const secondInstallResult = autoSyncOnVisibility(runtime);
    assert.equal(secondInstallResult.installed, true);
  } finally {
    globalThis.document = originalDocument;
  }
}

async function testSyncNowRemoteReadErrorPath() {
  const base = createMockFetchEnvironment();
  const fetch = async (url, options = {}) => {
    if (String(url).startsWith("/user/files/")) {
      return createJsonResponse(500, "server-error");
    }
    return await base.fetch(url, options);
  };

  const dbByChatId = new Map();
  dbByChatId.set("chat-remote-error", new FakeDb("chat-remote-error"));
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });

  const result = await syncNow("chat-remote-error", runtime);
  assert.equal(result.synced, false);
  assert.equal(result.reason, "http-error");
}

async function testSyncAppliedHook() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const hookCalls = [];

  dbByChatId.set(
    "chat-hook-download",
    new FakeDb("chat-hook-download", {
      meta: {
        schemaVersion: 1,
        chatId: "chat-hook-download",
        revision: 1,
        lastModified: 10,
        deviceId: "",
        nodeCount: 0,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: -1, extractionCount: 0 },
    }),
  );

  dbByChatId.set(
    "chat-hook-merge",
    new FakeDb("chat-hook-merge", {
      meta: {
        schemaVersion: 1,
        chatId: "chat-hook-merge",
        revision: 4,
        lastModified: 20,
        deviceId: "",
        nodeCount: 1,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [{ id: "local-merge", updatedAt: 20 }],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: 1, extractionCount: 1 },
    }),
  );

  remoteFiles.set("ST-BME_sync_chat-hook-download.json", {
    meta: { schemaVersion: 1, chatId: "chat-hook-download", revision: 3, lastModified: 30, deviceId: "remote", nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
    nodes: [{ id: "remote-download", updatedAt: 30 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 2, extractionCount: 1 },
  });
  remoteFiles.set("ST-BME_sync_chat-hook-merge.json", {
    meta: { schemaVersion: 1, chatId: "chat-hook-merge", revision: 4, lastModified: 25, deviceId: "remote", nodeCount: 1, edgeCount: 0, tombstoneCount: 0 },
    nodes: [{ id: "remote-merge", updatedAt: 25 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 3, extractionCount: 2 },
  });

  const runtime = {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    onSyncApplied: async (payload) => hookCalls.push({ ...payload }),
  };

  const downloadResult = await syncNow("chat-hook-download", runtime);
  assert.equal(downloadResult.action, "download");

  dbByChatId.get("chat-hook-merge").meta.set("syncDirty", true);
  const mergeResult = await syncNow("chat-hook-merge", runtime);
  assert.equal(mergeResult.action, "merge");

  assert.equal(downloadResult.revision, 3);
  assert.equal(mergeResult.revision, 5);

  assert.deepEqual(hookCalls.map((item) => item.action), ["download", "merge"]);
  assert.deepEqual(hookCalls.map((item) => item.chatId), ["chat-hook-download", "chat-hook-merge"]);
  assert.deepEqual(hookCalls.map((item) => item.revision), [3, 5]);
}

async function main() {
  console.log(`${PREFIX} debounce=${BME_SYNC_UPLOAD_DEBOUNCE_MS}`);
  await testDeviceId();
  await testRemoteStatusMissing();
  await testUploadPayloadMetaFirstAndDebounce();
  await testUploadSanitizesIllegalChatIdFilename();
  await testDownloadImport();
  await testLegacyRemoteFilenameFallbackAndReuse();
  await testMergeRules();
  await testMergeRuntimeMetaPolicies();
  await testManualCloudModeGuards();
  await testManualBackupAndRestoreFlow();
  await testBackupManifestReadFailureDoesNotOverwriteManifest();
  await testRestoreValidationDoesNotCreateSafetySnapshot();
  await testRestoreUsesManifestFilenameWhenCurrentFilenameDrifts();
  await testDeleteUsesExplicitManifestFilenameAndClearsLocalBackupMeta();
  await testSyncNowLockAndAutoSync();
  await testDeleteRemoteSyncFile();
  await testDeleteRemoteSyncFileFallsBackToLegacyFilename();
  await testAutoSyncOnVisibility();
  await testSyncNowRemoteReadErrorPath();
  await testSyncAppliedHook();
  console.log("indexeddb-sync tests passed");
}

await main();
