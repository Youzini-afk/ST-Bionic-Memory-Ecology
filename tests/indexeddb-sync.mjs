import assert from "node:assert/strict";

import {
  BME_SYNC_DEVICE_ID_KEY,
  BME_SYNC_UPLOAD_DEBOUNCE_MS,
  __testOnlyDecodeBase64Utf8,
  autoSyncOnChatChange,
  autoSyncOnVisibility,
  deleteRemoteSyncFile,
  getOrCreateDeviceId,
  getRemoteStatus,
  download,
  mergeSnapshots,
  scheduleUpload,
  syncNow,
  upload,
} from "../bme-sync.js";

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
      const decoded = __testOnlyDecodeBase64Utf8(body.data);
      const payload = JSON.parse(decoded);
      remoteFiles.set(body.name, payload);
      logs.uploadedPayloads.push({
        name: body.name,
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
  assert.equal(merged.meta.runtimeLastProcessedSeq, 9);
  assert.equal(merged.meta.runtimeGraphVersion, 11);
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
  await testDownloadImport();
  await testMergeRules();
  await testMergeRuntimeMetaPolicies();
  await testSyncNowLockAndAutoSync();
  await testDeleteRemoteSyncFile();
  await testAutoSyncOnVisibility();
  await testSyncNowRemoteReadErrorPath();
  await testSyncAppliedHook();
  console.log("indexeddb-sync tests passed");
}

await main();
