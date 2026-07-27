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
import {
  MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY,
  PROCESSED_MESSAGE_HASH_VERSION,
} from "../runtime/runtime-state.js";

const PREFIX = "[ST-BME][indexeddb-sync]";
const LOCAL_CLEANUP_META_KEY = "remoteSyncCleanupPendingV1";

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
    this.storeKind = "indexeddb";
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
    this.beforePatchMeta = null;
    this.beforeRevisionGuard = null;
  }

  async exportSnapshot() {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  async importSnapshot(snapshot, options = {}) {
    const currentRevision = await this.getRevision();
    if (
      (Number.isFinite(Number(options.expectedRevision)) &&
        currentRevision !== Number(options.expectedRevision)) ||
      (options.requireSyncClean === true &&
        Boolean(await this.getMeta("syncDirty", false)))
    ) {
      throw Object.assign(new Error("local snapshot changed before remote import"), {
        code: "LOCAL_SNAPSHOT_CHANGED",
      });
    }
    this.lastImportPayload = JSON.parse(JSON.stringify(snapshot));
    this.lastImportOptions = { ...options };
    const preservedMeta = Object.fromEntries(
      (Array.isArray(options.preserveMetaKeys) ? options.preserveMetaKeys : [])
        .filter((key) => this.meta.has(key))
        .map((key) => [key, this.meta.get(key)]),
    );
    this.snapshot = JSON.parse(JSON.stringify({
      ...snapshot,
      meta: {
        ...(snapshot?.meta || {}),
        ...preservedMeta,
      },
    }));
    const importedRevision = Math.max(
      currentRevision + 1,
      Number(options.revision ?? snapshot?.meta?.revision ?? 0) || 0,
    );
    this.snapshot.meta.revision = importedRevision;
    for (const [key, value] of Object.entries(this.snapshot.meta || {})) {
      this.meta.set(key, value);
    }
    this.meta.set("revision", importedRevision);
    this.meta.set("syncDirty", options.markSyncDirty !== false);
    this.meta.set(
      "syncDirtyReason",
      options.markSyncDirty !== false ? "importSnapshot" : "",
    );
    return {
      mode: options.mode || "replace",
      revision: importedRevision,
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

  async getRevision() {
    return Number(this.meta.get("revision") ?? this.snapshot?.meta?.revision ?? 0) || 0;
  }

  async patchMeta(record = {}) {
    if (typeof this.beforePatchMeta === "function") {
      await this.beforePatchMeta(record);
    }
    for (const [key, value] of Object.entries(record)) {
      this.meta.set(key, value);
    }
  }

  async patchMetaIfRevision(expectedRevision, matchingRecord = {}, mismatchingRecord = {}) {
    if (typeof this.beforeRevisionGuard === "function") {
      await this.beforeRevisionGuard();
    }
    const currentRevision = await this.getRevision();
    const matched = currentRevision === Number(expectedRevision);
    const selected = matched ? matchingRecord : mismatchingRecord;
    for (const [key, value] of Object.entries(selected)) {
      this.meta.set(key, value);
    }
    return {
      matched,
      currentRevision,
      applied: { ...selected },
    };
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
    uploadChunkCalls: 0,
    deleteCalls: 0,
    uploadedPayloads: [],
    uploadedChunkPayloads: [],
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
      const body = JSON.parse(String(options.body || "{}"));
      if (!/^[A-Za-z0-9._-]+$/.test(String(body.name || ""))) {
        return createJsonResponse(
          400,
          "Illegal character in filename; only alphanumeric, '-', '_', '.' are accepted.",
        );
      }
      const decoded = __testOnlyDecodeBase64Utf8(body.data);
      const payload = JSON.parse(decoded);
      remoteFiles.set(body.name, payload);
      const targetLog = String(body.name || "").includes(".__")
        ? "uploadedChunkPayloads"
        : "uploadedPayloads";
      if (targetLog === "uploadedChunkPayloads") {
        logs.uploadChunkCalls += 1;
      } else {
        logs.uploadCalls += 1;
      }
      logs[targetLog].push({
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

function createMockAuthorityBlobAdapter() {
  const blobs = new Map();
  const logs = {
    reads: 0,
    writes: 0,
    deletes: 0,
  };
  return {
    blobs,
    logs,
    adapter: {
      async readJson(path) {
        logs.reads += 1;
        if (!blobs.has(path)) {
          return { exists: false, ok: true, path };
        }
        return { exists: true, ok: true, path, payload: JSON.parse(JSON.stringify(blobs.get(path))) };
      },
      async writeJson(path, payload) {
        logs.writes += 1;
        blobs.set(path, JSON.parse(JSON.stringify(payload)));
        return { ok: true, path };
      },
      async writeText(path, payload) {
        logs.writes += 1;
        blobs.set(path, JSON.parse(payload));
        return { ok: true, path };
      },
      async delete(path) {
        logs.deletes += 1;
        const existed = blobs.delete(path);
        return { ok: true, deleted: existed, path };
      },
    },
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
  dbByChatId.get("chat-upload").snapshot.meta[LOCAL_CLEANUP_META_KEY] = [
    { filename: "must-stay-local" },
  ];
  const uploadResult = await upload("chat-upload", runtime);
  assert.equal(uploadResult.uploaded, true);
  assert.equal(logs.uploadCalls, 1);
  assert.equal(logs.uploadChunkCalls > 0, true);
  assert.equal(Number.isFinite(uploadResult.timings?.exportMs), true);
  assert.equal(Number.isFinite(uploadResult.timings?.chunkUploadMs), true);
  assert.equal(Number.isFinite(uploadResult.timings?.manifestUploadMs), true);
  assert.equal(Number.isFinite(uploadResult.timings?.metaPatchMs), true);

  const uploadedPayload = logs.uploadedPayloads[0].payload;
  assert.equal(uploadedPayload.formatVersion, 2);
  assert.equal(uploadedPayload.meta.revision, 9);
  assert.equal(Array.isArray(uploadedPayload.chunks), true);
  assert.equal(uploadedPayload.chunks.length > 0, true);
  const runtimeMetaChunk = logs.uploadedChunkPayloads.find(
    (entry) => entry.payload?.kind === "runtime-meta",
  );
  assert.equal(
    runtimeMetaChunk.payload.records[0][LOCAL_CLEANUP_META_KEY],
    undefined,
    "local cleanup recovery state must not replicate as graph metadata",
  );

  scheduleUpload("chat-upload", {
    ...runtime,
    debounceMs: 20,
  });
  await sleep(50);
  assert.equal(logs.uploadCalls, 2);
}

async function testUploadBuildsStableStSafeFilename() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "CON 世界书 测试(chat)#1 ".repeat(20).trim();
  dbByChatId.set(chatId, new FakeDb(chatId));

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const uploadResult = await upload(chatId, runtime);

  assert.equal(uploadResult.uploaded, true);
  assert.equal(logs.uploadCalls, 1);
  assert.equal(logs.sanitizeCalls, 0, "primary sync filenames are already ST-safe and stable");
  assert.match(uploadResult.filename, /^ST-BME_sync_[A-Za-z0-9._-]+\.json$/);
  assert.equal(uploadResult.filename.length <= 180, true);
  assert.match(logs.uploadedPayloads[0].name, /^[A-Za-z0-9._-]+$/);
}

async function testUploadDoesNotClearNewerLocalRevision() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-upload-local-advance";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.meta.set("revision", 1);
  db.meta.set("syncDirty", true);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  db.beforeRevisionGuard = async () => {
    db.beforeRevisionGuard = null;
    db.meta.set("revision", 2);
    db.meta.set("syncDirty", true);
    db.snapshot.meta.revision = 2;
  };

  const result = await upload(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    cloudStorageMode: "manual",
  });

  assert.equal(result.uploaded, true);
  assert.equal(result.revision, 1);
  assert.equal(result.currentLocalRevision, 2);
  assert.equal(result.pendingLocalChanges, true);
  assert.equal(db.meta.get("syncDirty"), true);
  assert.equal(
    db.meta.get("syncDirtyReason"),
    "local-revision-advanced-during-upload",
  );
  assert.equal(db.meta.get("lastSyncedRevision"), 1);
  assert.equal(remoteFiles.get(manifestName).meta.revision, 1);
}

async function testUploadDefersAndThenCleansStaleRemoteChunks() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-chunk-gc";
  const db = new FakeDb(chatId, {
    meta: {
      schemaVersion: 1,
      chatId,
      deviceId: "",
      revision: 1,
      lastModified: 100,
      nodeCount: 1,
      edgeCount: 1,
      tombstoneCount: 0,
    },
    nodes: [{ id: "n1", updatedAt: 100, name: "node" }],
    edges: [{ id: "e1", fromId: "n1", toId: "n2", updatedAt: 100 }],
    tombstones: [],
    state: { lastProcessedFloor: 1, extractionCount: 1 },
  });
  dbByChatId.set(chatId, db);

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const firstUpload = await upload(chatId, {
    ...runtime,
    nowMs: 1_000,
    remoteSyncChunkGcGraceMs: 5_000,
  });
  assert.equal(firstUpload.uploaded, true);
  const manifestName = firstUpload.filename;
  const firstManifest = remoteFiles.get(manifestName);
  const firstChunks = new Set(firstManifest.chunks.map((chunk) => chunk.filename));
  assert.ok(firstChunks.size >= 3, "v2 upload should create node, edge, and runtime-meta chunks");
  assert.equal(firstUpload.cleanup?.attempted, 0, "first upload has no previous manifest to clean");
  assert.deepEqual(firstManifest.chunkGc?.pending || [], []);

  db.snapshot = {
    ...JSON.parse(JSON.stringify(db.snapshot)),
    meta: {
      ...db.snapshot.meta,
      revision: 2,
      lastModified: 200,
    },
    nodes: [{ id: "n1", updatedAt: 100, name: "node" }],
    edges: [{ id: "e2", fromId: "n1", toId: "n3", updatedAt: 200 }],
    state: { lastProcessedFloor: 2, extractionCount: 2 },
  };

  const secondUpload = await upload(chatId, {
    ...runtime,
    nowMs: 2_000,
    remoteSyncChunkGcGraceMs: 5_000,
  });
  assert.equal(secondUpload.uploaded, true);
  const secondManifest = remoteFiles.get(manifestName);
  const secondChunks = new Set(secondManifest.chunks.map((chunk) => chunk.filename));
  const staleChunks = [...firstChunks].filter((filename) => !secondChunks.has(filename));
  const sharedChunks = [...firstChunks].filter((filename) => secondChunks.has(filename));

  assert.equal(
    staleChunks.length,
    firstChunks.size,
    "every publication must use isolated chunk names so later GC cannot delete a reused winner chunk",
  );
  assert.equal(sharedChunks.length, 0);
  for (const filename of staleChunks) {
    assert.equal(remoteFiles.has(filename), true, `stale chunk remains during grace period: ${filename}`);
  }
  for (const filename of secondChunks) {
    assert.equal(remoteFiles.has(filename), true, `current chunk should remain: ${filename}`);
  }
  assert.deepEqual(
    new Set((secondManifest.chunkGc?.pending || []).map((entry) => entry.filename)),
    new Set(staleChunks),
  );
  assert.equal(secondUpload.cleanup.attempted, 0);
  assert.equal(secondUpload.cleanup.deleted, 0);
  assert.equal(secondUpload.cleanup.failed, 0);
  assert.equal(logs.deleteCalls, 0);
  assert.equal(Number.isFinite(secondUpload.timings?.previousManifestReadMs), true);
  assert.equal(Number.isFinite(secondUpload.timings?.chunkCleanupMs), true);

  const chunkUploadCallsBeforeCleanup = logs.uploadChunkCalls;
  const thirdUpload = await syncNow(chatId, {
    ...runtime,
    nowMs: 8_000,
    remoteSyncChunkGcGraceMs: 5_000,
  });
  assert.equal(thirdUpload.uploaded, true);
  assert.equal(thirdUpload.action, "cleanup", "an idle sync should retire due chunks without a graph change");
  assert.equal(
    logs.uploadChunkCalls,
    chunkUploadCallsBeforeCleanup,
    "head-only GC must not rotate the current publication's chunks",
  );
  const thirdManifest = remoteFiles.get(manifestName);
  for (const filename of staleChunks) {
    assert.equal(remoteFiles.has(filename), false, `eligible stale chunk should be deleted: ${filename}`);
  }
  for (const filename of thirdManifest.chunks.map((chunk) => chunk.filename)) {
    assert.equal(remoteFiles.has(filename), true, `current chunk should remain after GC: ${filename}`);
  }
  assert.equal(thirdUpload.cleanup.attempted, staleChunks.length);
  assert.equal(thirdUpload.cleanup.deleted, staleChunks.length);
  assert.equal(thirdUpload.cleanup.failed, 0);
  assert.deepEqual(thirdManifest.chunkGc?.pending || [], [], "retired chunks must leave the durable GC ledger");
}

async function testUploadKeepsCompleteGcLedgerBeyondLegacyCap() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-gc-ledger-unbounded";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 2;
  dbByChatId.set(chatId, db);

  const manifestName = `ST-BME_sync_${chatId}.json`;
  const pending = Array.from({ length: 520 }, (_, index) => {
    const publicationId = `publication${String(index).padStart(4, "0")}`;
    return {
      filename: `ST-BME_sync_${chatId}.__nodes.${String(index).padStart(3, "0")}.${publicationId}.stale${index}.json`,
      publicationId,
      firstSeenAt: 1,
      eligibleAt: 100_000,
      sourceRevision: 1,
    };
  });
  remoteFiles.set(manifestName, {
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 1, lastModified: 1, nodeCount: 0, edgeCount: 0, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: -1, extractionCount: 0 },
    chunks: [],
    chunkGc: { version: 1, updatedAt: 1, graceMs: 5_000, pending },
  });

  const result = await upload(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    nowMs: 2_000,
    remoteSyncChunkGcGraceMs: 5_000,
  });
  assert.equal(result.uploaded, true);
  assert.equal(logs.deleteCalls, 0);
  assert.equal(remoteFiles.get(manifestName).chunkGc.pending.length, pending.length);
}

async function testLegacyUnscopedGcEntryIsNotAutoDeleted() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-legacy-unscoped-gc";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 2;
  db.meta.set("revision", 2);
  db.meta.set("syncDirty", false);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const legacyChunk = `ST-BME_sync_${chatId}.__edges.000.legacyhash.json`;
  remoteFiles.set(legacyChunk, { kind: "edges", index: 0, records: [] });
  remoteFiles.set(manifestName, {
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 2, lastModified: 2 },
    state: { lastProcessedFloor: -1, extractionCount: 0 },
    chunks: [],
    chunkGc: {
      version: 1,
      pending: [{ filename: legacyChunk, firstSeenAt: 1, eligibleAt: 2 }],
    },
  });

  const result = await syncNow(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    nowMs: 10,
  });

  assert.equal(result.action, "noop");
  assert.equal(remoteFiles.has(legacyChunk), true);
  assert.equal(logs.deleteCalls, 0);
}

async function testUploadRetriesFailedChunkGcAndRetiresMissingChunk() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-gc-delete-retry";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 2;
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const publicationId = "publicationretry1";
  const pendingFilename = `ST-BME_sync_${chatId}.__edges.000.${publicationId}.retry1.json`;
  remoteFiles.set(pendingFilename, { kind: "edges", index: 0, records: [] });
  remoteFiles.set(manifestName, {
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 1, lastModified: 1, nodeCount: 0, edgeCount: 0, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: -1, extractionCount: 0 },
    chunks: [],
    chunkGc: {
      version: 1,
      updatedAt: 1,
      graceMs: 1,
      pending: [{ filename: pendingFilename, publicationId, firstSeenAt: 1, eligibleAt: 2, sourceRevision: 1 }],
    },
  });

  let failDelete = true;
  const guardedFetch = async (url, options = {}) => {
    if (url === "/api/files/delete" && String(options.method || "").toUpperCase() === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      if (String(body.path || "").endsWith(`/${pendingFilename}`) && failDelete) {
        failDelete = false;
        return createJsonResponse(500, "temporary delete failure");
      }
    }
    return await fetch(url, options);
  };
  const runtime = buildRuntimeOptions({ dbByChatId, fetch: guardedFetch });
  const first = await upload(chatId, { ...runtime, nowMs: 10 });
  assert.equal(first.uploaded, true);
  assert.equal(first.cleanup.failed, 1);
  assert.equal(remoteFiles.has(pendingFilename), true);
  assert.equal(remoteFiles.get(manifestName).chunkGc.pending.some((entry) => entry.filename === pendingFilename), true);

  remoteFiles.delete(pendingFilename);
  const second = await upload(chatId, { ...runtime, nowMs: 20 });
  assert.equal(second.uploaded, true);
  assert.equal(second.cleanup.skipped, 1);
  assert.equal(remoteFiles.has(pendingFilename), false);
  assert.equal(remoteFiles.get(manifestName).chunkGc.pending.some((entry) => entry.filename === pendingFilename), false);
}

async function testManifestUploadFailureCompensatesNewChunks() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-manifest-failure-compensation";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "new-node", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const guardedFetch = async (url, options = {}) => {
    if (url === "/api/files/upload" && String(options.method || "").toUpperCase() === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      if (body.name === manifestName) return createJsonResponse(500, "manifest write failed");
    }
    return await fetch(url, options);
  };

  const result = await upload(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );
  assert.equal(result.uploaded, false);
  assert.equal(remoteFiles.has(manifestName), false);
  assert.equal(
    [...remoteFiles.keys()].some((filename) => filename.startsWith(manifestName.replace(/\.json$/, ".__"))),
    false,
    "chunks from an unpublished head must be compensated",
  );
}

async function testFailedCompensationIsRecoveredByNextManifest() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-compensation-recovery";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "node-v1", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const failingFetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    if (url === "/api/files/upload" && method === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      if (body.name === manifestName) {
        return createJsonResponse(500, "manifest write failed");
      }
    }
    if (url === "/api/files/delete" && method === "POST") {
      return createJsonResponse(500, "cleanup delete failed");
    }
    return await fetch(url, options);
  };

  const failed = await upload(
    chatId,
    {
      ...buildRuntimeOptions({ dbByChatId, fetch: failingFetch }),
      remoteSyncChunkGcGraceMs: 0,
    },
  );
  const localPending = db.meta.get(LOCAL_CLEANUP_META_KEY) || [];
  assert.equal(failed.uploaded, false);
  assert.ok(localPending.length > 0, "failed compensation must remain locally recoverable");
  assert.equal(db.meta.get("syncDirty"), true);

  db.snapshot.meta.revision = 2;
  db.snapshot.meta.lastModified = 2;
  db.snapshot.nodes = [{ id: "node-v2", updatedAt: 2 }];
  const recovered = await upload(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    nowMs: Math.max(...localPending.map((entry) => entry.eligibleAt)) + 1,
    remoteSyncChunkGcGraceMs: 0,
  });
  const recoveredManifest = remoteFiles.get(manifestName);
  const recoveredNames = new Set(localPending.map((entry) => entry.filename));
  const adoptedNames = (recoveredManifest.chunkGc?.pending || [])
    .map((entry) => entry.filename)
    .filter((filename) => recoveredNames.has(filename));

  assert.equal(recovered.uploaded, true);
  assert.ok(adoptedNames.length > 0, "next head must adopt known abandoned chunks into GC");
  assert.deepEqual(db.meta.get(LOCAL_CLEANUP_META_KEY), []);
}

async function testPreviousHeadReadFailureDoesNotPublish() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-head-read-failure";
  dbByChatId.set(chatId, new FakeDb(chatId));
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const previousHead = {
    meta: { chatId, revision: 1, lastModified: 1 },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: -1, extractionCount: 0 },
  };
  remoteFiles.set(manifestName, previousHead);
  const guardedFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${manifestName}`)
      && String(options.method || "GET").toUpperCase() === "GET"
    ) {
      return createJsonResponse(500, "head read failed");
    }
    return await fetch(url, options);
  };

  const result = await upload(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );
  assert.equal(result.uploaded, false);
  assert.deepEqual(remoteFiles.get(manifestName), previousHead);
  assert.equal(logs.uploadCalls, 0);
  assert.equal(logs.uploadChunkCalls, 0);
}

async function testConcurrentHeadChangeDoesNotRaceWinnerCleanup() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-concurrent-head-change";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "node-v1", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const first = await upload(chatId, runtime);
  assert.equal(first.uploaded, true);
  const firstManifest = JSON.parse(JSON.stringify(remoteFiles.get(first.filename)));

  db.snapshot.meta.revision = 2;
  db.snapshot.meta.lastModified = 2;
  db.snapshot.nodes = [{ id: "node-v2", updatedAt: 2 }];
  const concurrentManifest = {
    ...firstManifest,
    meta: { ...firstManifest.meta, revision: 3, lastModified: 3 },
  };
  let headReads = 0;
  const guardedFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${first.filename}`)
      && String(options.method || "GET").toUpperCase() === "GET"
    ) {
      headReads += 1;
      if (headReads === 2) remoteFiles.set(first.filename, concurrentManifest);
    }
    return await fetch(url, options);
  };

  const second = await upload(
    chatId,
    {
      ...buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
      remoteSyncChunkGcGraceMs: 0,
    },
  );
  assert.equal(second.uploaded, false);
  assert.equal(remoteFiles.get(first.filename).meta.revision, 3);
  const currentChunks = new Set(concurrentManifest.chunks.map((chunk) => chunk.filename));
  const storedChunks = new Set(
    [...remoteFiles.keys()].filter((filename) => filename.startsWith(first.filename.replace(/\.json$/, ".__"))),
  );
  for (const filename of currentChunks) assert.equal(storedChunks.has(filename), true);
  assert.equal(storedChunks.size > currentChunks.size, true, "observed concurrency must favor winner safety over risky cleanup");
  const localPending = db.meta.get(LOCAL_CLEANUP_META_KEY) || [];
  assert.ok(localPending.length > 0, "observed concurrent chunks must remain locally recoverable");
  assert.equal(db.meta.get("syncDirty"), true);

  db.snapshot.meta.revision = 4;
  db.snapshot.meta.lastModified = 4;
  const recoveryNow = Math.max(...localPending.map((entry) => entry.eligibleAt)) + 1;
  const recovered = await upload(chatId, {
    ...runtime,
    nowMs: recoveryNow,
    remoteSyncChunkGcGraceMs: 0,
  });
  assert.equal(recovered.uploaded, true);
  assert.deepEqual(db.meta.get(LOCAL_CLEANUP_META_KEY), []);
  const recoveredManifest = remoteFiles.get(first.filename);
  const localPendingNames = new Set(localPending.map((entry) => entry.filename));
  const adoptedNames = (recoveredManifest.chunkGc?.pending || [])
    .map((entry) => entry.filename)
    .filter((filename) => localPendingNames.has(filename));
  assert.ok(adoptedNames.length > 0);

  const cleanup = await syncNow(chatId, {
    ...runtime,
    nowMs: recoveryNow + 1,
    remoteSyncChunkGcGraceMs: 0,
  });
  assert.equal(cleanup.action, "cleanup");
  for (const filename of adoptedNames) assert.equal(remoteFiles.has(filename), false);
}

async function testHeadCheckFailureAfterChunkUploadCompensates() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-head-check-failure";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "node-v1", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const first = await upload(chatId, runtime);
  assert.equal(first.uploaded, true);
  const firstManifest = JSON.parse(JSON.stringify(remoteFiles.get(first.filename)));

  db.snapshot.meta.revision = 2;
  db.snapshot.meta.lastModified = 2;
  db.snapshot.nodes = [{ id: "node-v2", updatedAt: 2 }];
  let headReads = 0;
  const guardedFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${first.filename}`)
      && String(options.method || "GET").toUpperCase() === "GET"
    ) {
      headReads += 1;
      if (headReads === 2) return createJsonResponse(500, "head check failed");
    }
    return await fetch(url, options);
  };

  const second = await upload(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );
  assert.equal(second.uploaded, false);
  assert.deepEqual(remoteFiles.get(first.filename), firstManifest);
  assert.deepEqual(
    new Set([...remoteFiles.keys()].filter((name) => name.includes(".__"))),
    new Set(firstManifest.chunks.map((chunk) => chunk.filename)),
  );
}

async function testPostPublishHeadReplacementDoesNotDeleteWinnerChunks() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-post-publish-replacement";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "node-v1", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const first = await upload(chatId, runtime);
  assert.equal(first.uploaded, true);
  const firstManifest = JSON.parse(JSON.stringify(remoteFiles.get(first.filename)));
  const winnerManifest = {
    ...firstManifest,
    meta: { ...firstManifest.meta, revision: 3, lastModified: 3 },
  };

  db.snapshot.meta.revision = 2;
  db.snapshot.meta.lastModified = 2;
  db.snapshot.nodes = [{ id: "node-v2", updatedAt: 2 }];
  let headReads = 0;
  const guardedFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${first.filename}`)
      && String(options.method || "GET").toUpperCase() === "GET"
    ) {
      headReads += 1;
      if (headReads === 3) remoteFiles.set(first.filename, winnerManifest);
    }
    return await fetch(url, options);
  };

  const second = await upload(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );
  assert.equal(second.uploaded, false);
  assert.deepEqual(remoteFiles.get(first.filename), winnerManifest);
  const storedChunks = new Set([...remoteFiles.keys()].filter((name) => name.includes(".__")));
  const winnerChunks = new Set(winnerManifest.chunks.map((chunk) => chunk.filename));
  for (const filename of winnerChunks) assert.equal(storedChunks.has(filename), true);
  assert.equal(storedChunks.size > winnerChunks.size, true);
}

async function testUploadSkipsChunkCleanupWhenPreviousManifestUnavailable() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-chunk-gc-legacy";
  const db = new FakeDb(chatId, {
    meta: {
      schemaVersion: 1,
      chatId,
      deviceId: "",
      revision: 3,
      lastModified: 300,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "n1", updatedAt: 300 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 3, extractionCount: 1 },
  });
  dbByChatId.set(chatId, db);

  const legacyManifestName = "ST-BME_sync_chat-chunk-gc-legacy.json";
  const unrelatedOrphanChunk = "ST-BME_sync_chat-chunk-gc-legacy.__edges.000.orphan.json";
  remoteFiles.set(legacyManifestName, {
    meta: { chatId, revision: 1 },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 0, extractionCount: 0 },
  });
  remoteFiles.set(unrelatedOrphanChunk, { kind: "edges", records: [{ id: "old" }] });

  const result = await upload(chatId, buildRuntimeOptions({ dbByChatId, fetch }));
  assert.equal(result.uploaded, true);
  assert.equal(result.cleanup?.attempted, 0);
  assert.equal(logs.deleteCalls, 0, "non-v2 previous manifest must not trigger speculative deletion");
  assert.equal(remoteFiles.has(unrelatedOrphanChunk), true, "orphan chunk cannot be deleted without manifest evidence");
}

async function testAuthorityBlobUploadPreservesUserFilesFallbackTree() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const authority = createMockAuthorityBlobAdapter();
  const dbByChatId = new Map();
  const chatId = "chat-authority-gc";
  dbByChatId.set(
    chatId,
    new FakeDb(chatId, {
      meta: {
        schemaVersion: 1,
        chatId,
        deviceId: "",
        revision: 1,
        lastModified: 100,
        nodeCount: 1,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [{ id: "n1", updatedAt: 100 }],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: 1, extractionCount: 1 },
    }),
  );

  const fallbackManifest = "ST-BME_sync_chat-authority-gc.json";
  const fallbackChunk = "ST-BME_sync_chat-authority-gc.__nodes.000.fallback.json";
  remoteFiles.set(fallbackManifest, {
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 0, lastModified: 1, nodeCount: 1, edgeCount: 0, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: 0, extractionCount: 0 },
    chunks: [{ kind: "nodes", index: 0, count: 1, filename: fallbackChunk }],
  });
  remoteFiles.set(fallbackChunk, { kind: "nodes", index: 0, records: [{ id: "fallback" }] });

  const result = await upload(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    authorityBlobAdapter: authority.adapter,
    authorityBlobFailOpen: true,
    nowMs: 10_000,
    remoteSyncChunkGcGraceMs: 0,
  });

  assert.equal(result.uploaded, true);
  assert.equal(result.cleanup?.attempted, 0);
  assert.equal(logs.deleteCalls, 0, "authority upload must not cross-delete user-files fallback chunks");
  assert.equal(authority.logs.deletes, 0);
  assert.equal(remoteFiles.has(fallbackManifest), true);
  assert.equal(remoteFiles.has(fallbackChunk), true);
}

async function testAuthorityBlobGcIsScopedToAuthorityBackend() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const authority = createMockAuthorityBlobAdapter();
  const dbByChatId = new Map();
  const chatId = "chat-authority-gc-scoped";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "node-v1", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const runtime = {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    authorityBlobAdapter: authority.adapter,
    authorityBlobFailOpen: true,
    remoteSyncChunkGcGraceMs: 0,
  };

  const first = await upload(chatId, { ...runtime, nowMs: 100 });
  assert.equal(first.uploaded, true);
  const manifestPath = `user/files/${first.filename}`;
  const firstChunks = new Set(authority.blobs.get(manifestPath).chunks.map((chunk) => chunk.filename));
  db.snapshot.meta.revision = 2;
  db.snapshot.meta.lastModified = 2;
  db.snapshot.nodes = [{ id: "node-v2", updatedAt: 2 }];
  const second = await upload(chatId, { ...runtime, nowMs: 200 });
  assert.equal(second.uploaded, true);
  const secondManifest = authority.blobs.get(manifestPath);
  const secondChunks = new Set(secondManifest.chunks.map((chunk) => chunk.filename));
  const staleChunks = [...firstChunks].filter((filename) => !secondChunks.has(filename));
  assert.ok(staleChunks.length > 0);
  remoteFiles.set(staleChunks[0], { fallback: true });

  const authorityDelete = authority.adapter.delete.bind(authority.adapter);
  let rejectDelete = true;
  authority.adapter.delete = async (path) => {
    if (rejectDelete && staleChunks.some((filename) => path.endsWith(filename))) {
      rejectDelete = false;
      return { ok: false, deleted: false, path };
    }
    return await authorityDelete(path);
  };

  const third = await syncNow(chatId, { ...runtime, nowMs: 300 });
  assert.equal(third.uploaded, true);
  assert.equal(third.action, "cleanup");
  assert.equal(third.cleanup.failed, 1);
  assert.equal(authority.blobs.get(manifestPath).chunkGc.pending.length, 1);

  const fourth = await syncNow(chatId, { ...runtime, nowMs: 400 });
  assert.equal(fourth.uploaded, true);
  assert.equal(fourth.cleanup.deleted, 1);
  for (const filename of staleChunks) assert.equal(authority.blobs.has(`user/files/${filename}`), false);
  assert.equal(remoteFiles.has(staleChunks[0]), true, "authority GC must preserve user-files fallback data");
  assert.deepEqual(authority.blobs.get(manifestPath).chunkGc.pending, []);
}

async function testAuthorityManifestFailureCompensatesAuthorityChunks() {
  const { fetch } = createMockFetchEnvironment();
  const authority = createMockAuthorityBlobAdapter();
  const dbByChatId = new Map();
  const chatId = "chat-authority-manifest-failure";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "authority-node", updatedAt: 1 }];
  dbByChatId.set(chatId, db);
  const manifestPath = `user/files/ST-BME_sync_${chatId}.json`;
  const guardedAdapter = {
    ...authority.adapter,
    async writeJson(path, payload) {
      if (path === manifestPath) return { ok: false, path };
      return await authority.adapter.writeJson(path, payload);
    },
  };

  const result = await upload(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    authorityBlobAdapter: guardedAdapter,
    authorityBlobFailOpen: false,
  });
  assert.equal(result.uploaded, false);
  assert.equal(authority.blobs.has(manifestPath), false);
  assert.equal(
    [...authority.blobs.keys()].some((path) => path.startsWith(manifestPath.replace(/\.json$/, ".__"))),
    false,
  );
}

async function testUserFilesHeadReadsOnlyUserFilesChunks() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const authority = createMockAuthorityBlobAdapter();
  const dbByChatId = new Map();
  const chatId = "chat-backend-scoped-read";
  const db = new FakeDb(chatId);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const chunkName = `ST-BME_sync_${chatId}.__nodes.000.shared1.json`;
  remoteFiles.set(manifestName, {
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 1, lastModified: 1 },
    state: { lastProcessedFloor: -1, extractionCount: 0 },
    chunks: [{ kind: "nodes", index: 0, count: 1, filename: chunkName }],
  });
  remoteFiles.set(chunkName, { kind: "nodes", index: 0, records: [{ id: "user-files-node" }] });
  authority.blobs.set(`user/files/${chunkName}`, {
    kind: "nodes",
    index: 0,
    records: [{ id: "authority-node" }],
  });

  const result = await download(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    authorityBlobAdapter: authority.adapter,
    authorityBlobFailOpen: true,
  });
  assert.equal(result.downloaded, true);
  assert.equal(db.lastImportPayload.nodes[0].id, "user-files-node");
}

async function testAuthorityFailOpenGcStaysOnUserFiles() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-authority-fail-open-gc";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 2;
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  const publicationId = "publicationstale1";
  const pendingFilename = `ST-BME_sync_${chatId}.__edges.000.${publicationId}.stale1.json`;
  remoteFiles.set(pendingFilename, { kind: "edges", index: 0, records: [] });
  remoteFiles.set(manifestName, {
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 1, lastModified: 1 },
    state: { lastProcessedFloor: -1, extractionCount: 0 },
    chunks: [],
    chunkGc: {
      version: 1,
      updatedAt: 1,
      graceMs: 1,
      pending: [{ filename: pendingFilename, publicationId, firstSeenAt: 1, eligibleAt: 2, sourceRevision: 1 }],
    },
  });
  const failingAuthority = {
    async readJson() {
      throw new Error("authority unavailable");
    },
  };

  const result = await upload(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    authorityBlobAdapter: failingAuthority,
    authorityBlobFailOpen: true,
    nowMs: 10,
  });
  assert.equal(result.uploaded, true);
  assert.equal(result.cleanup.deleted, 1);
  assert.equal(remoteFiles.has(pendingFilename), false);
  assert.deepEqual(remoteFiles.get(manifestName).chunkGc.pending, []);
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
      runtimeVectorIndexState: {
        mode: "backend",
        collectionId: "st-bme::chat-download",
        source: "openai",
        hashToNodeId: {
          "hash-remote-node": "remote-node",
        },
        nodeToHash: {
          "remote-node": "hash-remote-node",
        },
        lastStats: {
          total: 1,
          indexed: 1,
          stale: 0,
          pending: 0,
        },
      },
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
  assert.equal(Number.isFinite(result.timings?.networkMs), true);
  assert.equal(Number.isFinite(result.timings?.importMs), true);
  assert.equal(Number.isFinite(result.timings?.metaPatchMs), true);
  assert.equal(Number.isFinite(result.timings?.hookMs), true);
  assert.equal(db.lastImportPayload.meta.revision, 12);
  assert.equal(db.lastImportPayload.nodes[0].id, "remote-node");
  assert.equal(db.lastImportPayload.meta.runtimeVectorIndexState.dirty, true);
  assert.equal(
    db.lastImportPayload.meta.runtimeVectorIndexState.dirtyReason,
    "backend-sync-download-unverified",
  );
  assert.deepEqual(db.lastImportPayload.meta.runtimeVectorIndexState.hashToNodeId, {});
  assert.deepEqual(db.lastImportPayload.meta.runtimeVectorIndexState.nodeToHash, {});
  assert.equal(
    db.lastImportPayload.meta.runtimeVectorIndexState.pendingRepairFromFloor,
    0,
  );
}

async function testLegacyRemoteFilenameFallbackMigratesWritesToStableName() {
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
  assert.notEqual(uploadResult.filename, "ST-BME_sync_chat~legacy_name.json");
  assert.match(uploadResult.filename, /^ST-BME_sync_[A-Za-z0-9._-]+\.json$/);
  assert.equal(logs.uploadedPayloads.at(-1)?.name, uploadResult.filename);
  assert.equal(remoteFiles.has(uploadResult.filename), true);
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
        processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
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
      runtimeVectorIndexState: {
        mode: "backend",
        collectionId: "st-bme::chat-backup-flow",
        source: "openai",
        hashToNodeId: {
          "hash-local-node": "local-node",
        },
        nodeToHash: {
          "local-node": "hash-local-node",
        },
        lastStats: {
          total: 1,
          indexed: 1,
          stale: 0,
          pending: 0,
        },
      },
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
  assert.equal(Number.isFinite(backupResult.timings?.exportMs), true);
  assert.equal(Number.isFinite(backupResult.timings?.uploadMs), true);
  assert.equal(Number.isFinite(backupResult.timings?.manifestWriteMs), true);
  assert.equal(Number.isFinite(backupResult.timings?.metaPatchMs), true);
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
  assert.equal(Number.isFinite(restoreResult.timings?.downloadMs), true);
  assert.equal(Number.isFinite(restoreResult.timings?.localExportMs), true);
  assert.equal(Number.isFinite(restoreResult.timings?.safetySnapshotMs), true);
  assert.equal(Number.isFinite(restoreResult.timings?.importMs), true);
  assert.equal(Number.isFinite(restoreResult.timings?.metaPatchMs), true);
  assert.equal(Number.isFinite(restoreResult.timings?.hookMs), true);
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
  assert.equal(db.snapshot.meta.runtimeVectorIndexState.dirty, true);
  assert.equal(
    db.snapshot.meta.runtimeVectorIndexState.dirtyReason,
    "backend-backup-restore-unverified",
  );
  assert.deepEqual(db.snapshot.meta.runtimeVectorIndexState.hashToNodeId, {});
  assert.deepEqual(db.snapshot.meta.runtimeVectorIndexState.nodeToHash, {});
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
  assert.ok(db.snapshot.meta.revision > 1, "rollback import keeps the local revision monotonic");
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
  assert.equal(Number.isFinite(restoreResult.timings?.downloadMs), true);

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
  assert.equal(logs.deleteCalls >= 1, true);
  const deleteCallsAfterFirstDelete = logs.deleteCalls;

  const deleteMissingResult = await deleteRemoteSyncFile("chat-delete", runtime);
  assert.equal(deleteMissingResult.deleted, false);
  assert.equal(deleteMissingResult.reason, "not-found");
  assert.equal(logs.deleteCalls > deleteCallsAfterFirstDelete, true);
}

async function testDeleteRemoteSyncFileV2CleansChunksAndGcPending() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-v2-delete-cleanup";
  dbByChatId.set(chatId, new FakeDb(chatId));

  // Manually set up a v2 manifest with chunks and chunkGc.pending entries in remote storage
  const manifestFilename = "ST-BME_sync_chat-v2-delete-cleanup.json";
  const chunkNodeFile = "ST-BME_sync_chat-v2-delete-cleanup.__nodes.000.abc123.json";
  const chunkEdgeFile = "ST-BME_sync_chat-v2-delete-cleanup.__edges.000.def456.json";
  const gcPendingFile = "ST-BME_sync_chat-v2-delete-cleanup.__runtime-meta.000.ghi789.json";

  remoteFiles.set(chunkNodeFile, { kind: "nodes", index: 0, records: [{ id: "n1" }] });
  remoteFiles.set(chunkEdgeFile, { kind: "edges", index: 0, records: [{ id: "e1" }] });
  remoteFiles.set(gcPendingFile, { kind: "runtime-meta", index: 0, records: [] });
  remoteFiles.set(manifestFilename, {
    formatVersion: 2,
    meta: { chatId, revision: 5, lastModified: 500, nodeCount: 1, edgeCount: 1, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: 3, extractionCount: 2 },
    chunks: [
      { kind: "nodes", index: 0, count: 1, filename: chunkNodeFile },
      { kind: "edges", index: 0, count: 1, filename: chunkEdgeFile },
    ],
    chunkGc: {
      pending: [
        { filename: gcPendingFile, firstSeenAt: 400, eligibleAt: 900, sourceRevision: 4 },
      ],
    },
  });

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const deleteResult = await deleteRemoteSyncFile(chatId, runtime);

  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.chatId, chatId);
  assert.equal(deleteResult.filename, manifestFilename);

  // All chunk files and gc-pending files should be deleted
  assert.equal(remoteFiles.has(chunkNodeFile), false, "manifest.chunks node file should be deleted");
  assert.equal(remoteFiles.has(chunkEdgeFile), false, "manifest.chunks edge file should be deleted");
  assert.equal(remoteFiles.has(gcPendingFile), false, "manifest.chunkGc.pending file should be deleted");
  assert.equal(remoteFiles.has(manifestFilename), false, "manifest itself should be deleted");
  assert.equal(deleteResult.cleanup.attempted, 3);
  assert.equal(deleteResult.cleanup.deleted, 3);
  assert.equal(deleteResult.cleanup.skipped, 0);
  assert.equal(deleteResult.cleanup.failed, 0);

  // Verify delete calls: 2 chunks + 1 gc-pending + 1 manifest = 4
  assert.equal(logs.deleteCalls, 4, "should delete 2 chunks + 1 gc-pending + 1 manifest");
}

async function testDeleteRemoteSyncFileManifestDeleteFailureKeepsChunks() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-delete-manifest-fails";
  dbByChatId.set(chatId, new FakeDb(chatId));

  const manifestFilename = "ST-BME_sync_chat-delete-manifest-fails.json";
  const chunkNodeFile = "ST-BME_sync_chat-delete-manifest-fails.__nodes.000.abc123.json";
  const gcPendingFile = "ST-BME_sync_chat-delete-manifest-fails.__runtime-meta.000.ghi789.json";

  remoteFiles.set(chunkNodeFile, { kind: "nodes", index: 0, records: [{ id: "n1" }] });
  remoteFiles.set(gcPendingFile, { kind: "runtime-meta", index: 0, records: [] });
  remoteFiles.set(manifestFilename, {
    formatVersion: 2,
    meta: { chatId, revision: 5, lastModified: 500, nodeCount: 1, edgeCount: 0, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: 3, extractionCount: 2 },
    chunks: [
      { kind: "nodes", index: 0, count: 1, filename: chunkNodeFile },
    ],
    chunkGc: {
      pending: [
        { filename: gcPendingFile, firstSeenAt: 400, eligibleAt: 900, sourceRevision: 4 },
      ],
    },
  });

  const guardedFetch = async (url, options = {}) => {
    if (url === "/api/files/delete" && String(options?.method || "").toUpperCase() === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      if (String(body.path || "") === `/user/files/${manifestFilename}`) {
        return createJsonResponse(500, "manifest delete failed");
      }
    }
    return await fetch(url, options);
  };

  const deleteResult = await deleteRemoteSyncFile(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );

  assert.equal(deleteResult.deleted, false);
  assert.equal(deleteResult.reason, "delete-error");
  assert.equal(remoteFiles.has(manifestFilename), true, "manifest remains after delete failure");
  assert.equal(remoteFiles.has(chunkNodeFile), true, "chunk must remain when manifest delete fails");
  assert.equal(remoteFiles.has(gcPendingFile), true, "pending chunk must remain when manifest delete fails");
}

async function testDeleteRemoteSyncFileManifestReadFailureAbortsDelete() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-delete-manifest-read-fails";
  dbByChatId.set(chatId, new FakeDb(chatId));

  const manifestFilename = "ST-BME_sync_chat-delete-manifest-read-fails.json";
  const chunkNodeFile = "ST-BME_sync_chat-delete-manifest-read-fails.__nodes.000.abc123.json";
  remoteFiles.set(chunkNodeFile, { kind: "nodes", index: 0, records: [{ id: "n1" }] });
  remoteFiles.set(manifestFilename, {
    formatVersion: 2,
    meta: { chatId, revision: 5, lastModified: 500, nodeCount: 1, edgeCount: 0, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: 3, extractionCount: 2 },
    chunks: [
      { kind: "nodes", index: 0, count: 1, filename: chunkNodeFile },
    ],
  });

  const guardedFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${manifestFilename}`)
      && String(options?.method || "GET").toUpperCase() === "GET"
    ) {
      return createJsonResponse(500, "manifest read failed");
    }
    return await fetch(url, options);
  };

  const deleteResult = await deleteRemoteSyncFile(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );

  assert.equal(deleteResult.deleted, false);
  assert.equal(deleteResult.reason, "manifest-read-error");
  assert.equal(deleteResult.cleanup.reason, "http-error");
  assert.equal(remoteFiles.has(manifestFilename), true, "manifest must remain after read failure");
  assert.equal(remoteFiles.has(chunkNodeFile), true, "chunk must remain after read failure");
}

async function testDeleteRemoteSyncFileRemoteHeadRecreatedSkipsChunkCleanup() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-delete-head-recreated";
  dbByChatId.set(chatId, new FakeDb(chatId));

  const manifestFilename = "ST-BME_sync_chat-delete-head-recreated.json";
  const chunkNodeFile = "ST-BME_sync_chat-delete-head-recreated.__nodes.000.abc123.json";
  const manifestPayload = {
    formatVersion: 2,
    meta: { chatId, revision: 5, lastModified: 500, nodeCount: 1, edgeCount: 0, tombstoneCount: 0, schemaVersion: 1 },
    state: { lastProcessedFloor: 3, extractionCount: 2 },
    chunks: [
      { kind: "nodes", index: 0, count: 1, filename: chunkNodeFile },
    ],
  };
  remoteFiles.set(chunkNodeFile, { kind: "nodes", index: 0, records: [{ id: "n1" }] });
  remoteFiles.set(manifestFilename, manifestPayload);

  const guardedFetch = async (url, options = {}) => {
    if (url === "/api/files/delete" && String(options?.method || "").toUpperCase() === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      if (String(body.path || "") === `/user/files/${manifestFilename}`) {
        const response = await fetch(url, options);
        remoteFiles.set(manifestFilename, {
          ...manifestPayload,
          meta: { ...manifestPayload.meta, revision: 6, lastModified: 600 },
        });
        return response;
      }
    }
    return await fetch(url, options);
  };

  const deleteResult = await deleteRemoteSyncFile(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: guardedFetch }),
  );

  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.cleanup.reason, "remote-head-recreated");
  assert.equal(deleteResult.cleanup.attempted, 0);
  assert.equal(remoteFiles.has(manifestFilename), true, "recreated manifest must remain");
  assert.equal(remoteFiles.has(chunkNodeFile), true, "chunk must remain when head is recreated");
}

async function testDeleteRemoteSyncFileMissingManifestNoSpeculativeDelete() {
  const { fetch, remoteFiles, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-missing-manifest-no-delete";
  dbByChatId.set(chatId, new FakeDb(chatId));

  // Pre-populate orphan-looking chunk files that match the chatId naming pattern
  const orphanChunk = "ST-BME_sync_chat-missing-manifest-no-delete.__nodes.000.orphan.json";
  const orphanGcPending = "ST-BME_sync_chat-missing-manifest-no-delete.__edges.000.stale.json";
  remoteFiles.set(orphanChunk, { kind: "nodes", index: 0, records: [] });
  remoteFiles.set(orphanGcPending, { kind: "edges", index: 0, records: [] });

  const deleteCallsBefore = logs.deleteCalls;
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const deleteResult = await deleteRemoteSyncFile(chatId, runtime);

  assert.equal(deleteResult.deleted, false);
  assert.equal(deleteResult.reason, "not-found");

  // Orphan chunks must NOT be speculatively deleted — only manifest filename candidates
  // may be attempted for deletion (which 404 because the manifest was never uploaded),
  // but chunks and gc-pending files must remain untouched.
  assert.equal(remoteFiles.has(orphanChunk), true, "orphan chunk must not be speculatively deleted");
  assert.equal(remoteFiles.has(orphanGcPending), true, "orphan gc-pending must not be speculatively deleted");
  assert.equal(remoteFiles.size, 2, "both orphan files should remain untouched after missing-manifest delete");
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

async function testDeleteRemoteSyncFileCleansPrimaryAndLegacyTrees() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat~dual tree";
  dbByChatId.set(chatId, new FakeDb(chatId));
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const uploadResult = await upload(chatId, runtime);
  assert.equal(uploadResult.uploaded, true);

  const legacyFilename = "ST-BME_sync_chat~dual_tree.json";
  remoteFiles.set(legacyFilename, {
    meta: { chatId, revision: 0, lastModified: 1 },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: -1, extractionCount: 0 },
  });

  const deleteResult = await deleteRemoteSyncFile(chatId, runtime);
  assert.equal(deleteResult.deleted, true);
  assert.deepEqual(new Set(deleteResult.filenames), new Set([uploadResult.filename, legacyFilename]));
  assert.equal(remoteFiles.has(uploadResult.filename), false);
  assert.equal(remoteFiles.has(legacyFilename), false);
}

async function testDeleteRemoteSyncFileCleansBothRemoteBackends() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const authority = createMockAuthorityBlobAdapter();
  const dbByChatId = new Map();
  const chatId = "chat-delete-both-backends";
  dbByChatId.set(chatId, new FakeDb(chatId));
  const manifestFilename = `ST-BME_sync_${chatId}.json`;
  const authorityChunk = `ST-BME_sync_${chatId}.__nodes.000.authority1.json`;
  const fallbackChunk = `ST-BME_sync_${chatId}.__edges.000.fallback1.json`;
  const buildManifest = (chunk) => ({
    kind: "st-bme-sync",
    formatVersion: 2,
    chatId,
    meta: { chatId, revision: 1, lastModified: 1 },
    state: { lastProcessedFloor: -1, extractionCount: 0 },
    chunks: [{ kind: chunk.includes(".__nodes.") ? "nodes" : "edges", index: 0, count: 0, filename: chunk }],
  });
  authority.blobs.set(`user/files/${manifestFilename}`, buildManifest(authorityChunk));
  authority.blobs.set(`user/files/${authorityChunk}`, { kind: "nodes", records: [] });
  remoteFiles.set(manifestFilename, buildManifest(fallbackChunk));
  remoteFiles.set(fallbackChunk, { kind: "edges", records: [] });

  const result = await deleteRemoteSyncFile(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch }),
    authorityBlobAdapter: authority.adapter,
  });
  assert.equal(result.deleted, true);
  assert.equal(authority.blobs.has(`user/files/${manifestFilename}`), false);
  assert.equal(authority.blobs.has(`user/files/${authorityChunk}`), false);
  assert.equal(remoteFiles.has(manifestFilename), false);
  assert.equal(remoteFiles.has(fallbackChunk), false);
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

async function testAutomaticDownloadCannotReplaceNewerLocalCommit() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-download-local-race";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.snapshot.nodes = [{ id: "local-before", updatedAt: 1 }];
  db.meta.set("revision", 1);
  db.meta.set("syncDirty", false);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  remoteFiles.set(manifestName, {
    meta: {
      schemaVersion: 1,
      chatId,
      revision: 3,
      lastModified: 30,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "remote", updatedAt: 30 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 2, extractionCount: 1 },
  });
  let headReads = 0;
  const racingFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${manifestName}`) &&
      String(options.method || "GET").toUpperCase() === "GET"
    ) {
      headReads += 1;
      if (headReads === 2) {
        db.meta.set("revision", 2);
        db.meta.set("syncDirty", true);
        db.snapshot.meta.revision = 2;
        db.snapshot.nodes = [{ id: "local-after", updatedAt: 40 }];
      }
    }
    return await fetch(url, options);
  };

  const result = await syncNow(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: racingFetch }),
  );

  assert.equal(result.synced, false);
  assert.equal(result.reason, "local-changed-during-download");
  assert.equal(db.snapshot.meta.revision, 2);
  assert.deepEqual(db.snapshot.nodes.map((node) => node.id), ["local-after"]);
  assert.equal(db.meta.get("syncDirty"), true);
}

async function testDownloadDoesNotClearCommitAfterImport() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-download-post-import-race";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 1;
  db.meta.set("revision", 1);
  db.meta.set("syncDirty", false);
  dbByChatId.set(chatId, db);
  remoteFiles.set(`ST-BME_sync_${chatId}.json`, {
    meta: { chatId, revision: 3, lastModified: 30 },
    nodes: [{ id: "remote", updatedAt: 30 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 2, extractionCount: 1 },
  });
  db.beforeRevisionGuard = async () => {
    db.beforeRevisionGuard = null;
    db.meta.set("revision", 4);
    db.meta.set("syncDirty", true);
    db.snapshot.meta.revision = 4;
  };

  const runtime = buildRuntimeOptions({ dbByChatId, fetch });
  const result = await syncNow(chatId, runtime);

  assert.equal(result.downloaded, true);
  assert.equal(result.synced, false);
  assert.equal(result.pendingLocalChanges, true);
  assert.equal(result.currentLocalRevision, 4);
  assert.equal(db.meta.get("syncDirty"), true);
  assert.equal(
    db.meta.get("syncDirtyReason"),
    "local-revision-advanced-during-download",
  );
  await deleteRemoteSyncFile(chatId, runtime);
}

async function testMergeCannotReplaceNewerLocalCommit() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-merge-local-race";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 2;
  db.snapshot.nodes = [{ id: "local-before", updatedAt: 2 }];
  db.meta.set("revision", 2);
  db.meta.set("syncDirty", true);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  remoteFiles.set(manifestName, {
    meta: {
      schemaVersion: 1,
      chatId,
      revision: 2,
      lastModified: 20,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "remote", updatedAt: 20 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 2, extractionCount: 1 },
  });
  const racingFetch = async (url, options = {}) => {
    if (
      String(url).startsWith(`/user/files/${manifestName}`) &&
      String(options.method || "GET").toUpperCase() === "GET"
    ) {
      db.meta.set("revision", 3);
      db.meta.set("syncDirty", true);
      db.snapshot.meta.revision = 3;
      db.snapshot.nodes = [{ id: "local-after", updatedAt: 30 }];
    }
    return await fetch(url, options);
  };

  const result = await syncNow(
    chatId,
    buildRuntimeOptions({ dbByChatId, fetch: racingFetch }),
  );

  assert.equal(result.synced, false);
  assert.equal(result.reason, "sync-error");
  assert.equal(result.error?.code, "LOCAL_SNAPSHOT_CHANGED");
  assert.equal(db.snapshot.meta.revision, 3);
  assert.deepEqual(db.snapshot.nodes.map((node) => node.id), ["local-after"]);
}

async function testMergeUploadFailureKeepsLocalReplicaDirty() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-merge-upload-failure";
  const db = new FakeDb(chatId, {
    meta: {
      schemaVersion: 1,
      chatId,
      revision: 2,
      lastModified: 20,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "local-node", updatedAt: 20 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 1, extractionCount: 1 },
  });
  db.meta.set("syncDirty", true);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  remoteFiles.set(manifestName, {
    meta: {
      schemaVersion: 1,
      chatId,
      revision: 2,
      lastModified: 25,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "remote-node", updatedAt: 25 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 2, extractionCount: 1 },
  });
  const failingFetch = async (url, options = {}) => {
    if (url === "/api/files/upload" && String(options.method || "GET").toUpperCase() === "POST") {
      const body = JSON.parse(String(options.body || "{}"));
      if (body.name === manifestName) {
        return createJsonResponse(500, "merge manifest write failed");
      }
    }
    return await fetch(url, options);
  };
  let hookCalls = 0;

  const result = await syncNow(chatId, {
    ...buildRuntimeOptions({ dbByChatId, fetch: failingFetch }),
    onSyncApplied: async () => {
      hookCalls += 1;
    },
  });

  assert.equal(result.synced, false);
  assert.equal(result.reason, "sync-error");
  assert.equal(db.meta.get("syncDirty"), true);
  assert.equal(db.meta.get("syncDirtyReason"), "cloud-merge-upload-failed");
  assert.deepEqual(
    new Set(db.snapshot.nodes.map((node) => node.id)),
    new Set(["local-node", "remote-node"]),
  );
  assert.equal(hookCalls, 0);
}

async function testMergeUploadDoesNotClearNewerLocalCommit() {
  const { fetch, remoteFiles } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-merge-post-import-race";
  const db = new FakeDb(chatId);
  db.snapshot.meta.revision = 2;
  db.snapshot.nodes = [{ id: "local", updatedAt: 20 }];
  db.meta.set("revision", 2);
  db.meta.set("syncDirty", true);
  dbByChatId.set(chatId, db);
  const manifestName = `ST-BME_sync_${chatId}.json`;
  remoteFiles.set(manifestName, {
    meta: { chatId, revision: 2, lastModified: 25 },
    nodes: [{ id: "remote", updatedAt: 25 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 2, extractionCount: 1 },
  });
  db.beforeRevisionGuard = async () => {
    db.beforeRevisionGuard = null;
    db.meta.set("revision", 4);
    db.meta.set("syncDirty", true);
    db.snapshot.meta.revision = 4;
  };
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });

  const result = await syncNow(chatId, runtime);

  assert.equal(result.action, "merge");
  assert.equal(result.synced, false);
  assert.equal(result.pendingLocalChanges, true);
  assert.equal(result.revision, 3);
  assert.equal(result.currentLocalRevision, 4);
  assert.equal(db.meta.get("syncDirty"), true);
  assert.equal(remoteFiles.get(manifestName).meta.revision, 3);
  await deleteRemoteSyncFile(chatId, runtime);
}

async function testAuthorityPrimarySkipsCloudReplica() {
  const { fetch, logs } = createMockFetchEnvironment();
  const dbByChatId = new Map();
  const chatId = "chat-authority-primary-cloud-skip";
  const db = new FakeDb(chatId);
  db.storeKind = "authority";
  dbByChatId.set(chatId, db);
  const runtime = buildRuntimeOptions({ dbByChatId, fetch });

  const uploadResult = await upload(chatId, runtime);
  const downloadResult = await download(chatId, runtime);
  const syncResult = await syncNow(chatId, runtime);

  assert.equal(uploadResult.reason, "authority-primary-not-replicated");
  assert.equal(downloadResult.reason, "authority-primary-not-replicated");
  assert.equal(syncResult.reason, "authority-primary-not-replicated");
  assert.equal(syncResult.synced, true);
  assert.equal(logs.uploadCalls, 0);
  assert.equal(logs.getCalls, 0);
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
        runtimeVectorIndexState: {
          mode: "backend",
          collectionId: "st-bme::chat-hook-merge",
          source: "openai",
          hashToNodeId: {
            "hash-local-merge": "local-merge",
          },
          nodeToHash: {
            "local-merge": "hash-local-merge",
          },
          lastStats: {
            total: 1,
            indexed: 1,
            stale: 0,
            pending: 0,
          },
        },
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
    meta: {
      schemaVersion: 1,
      chatId: "chat-hook-merge",
      revision: 4,
      lastModified: 25,
      deviceId: "remote",
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
      runtimeVectorIndexState: {
        mode: "backend",
        collectionId: "st-bme::chat-hook-merge",
        source: "openai",
        hashToNodeId: {
          "hash-remote-merge": "remote-merge",
        },
        nodeToHash: {
          "remote-merge": "hash-remote-merge",
        },
        lastStats: {
          total: 1,
          indexed: 1,
          stale: 0,
          pending: 0,
        },
      },
    },
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
  assert.equal(
    dbByChatId.get("chat-hook-merge").lastImportPayload.meta.runtimeVectorIndexState.dirty,
    true,
  );
  assert.equal(
    dbByChatId.get("chat-hook-merge").lastImportPayload.meta.runtimeVectorIndexState.dirtyReason,
    "backend-sync-merge-unverified",
  );
  assert.deepEqual(
    dbByChatId.get("chat-hook-merge").lastImportPayload.meta.runtimeVectorIndexState.hashToNodeId,
    {},
  );
  assert.deepEqual(
    dbByChatId.get("chat-hook-merge").lastImportPayload.meta.runtimeVectorIndexState.nodeToHash,
    {},
  );

  assert.deepEqual(hookCalls.map((item) => item.action), ["download", "merge"]);
  assert.deepEqual(hookCalls.map((item) => item.chatId), ["chat-hook-download", "chat-hook-merge"]);
  assert.deepEqual(hookCalls.map((item) => item.revision), [3, 5]);
}

async function main() {
  console.log(`${PREFIX} debounce=${BME_SYNC_UPLOAD_DEBOUNCE_MS}`);
  await testDeviceId();
  await testRemoteStatusMissing();
  await testUploadPayloadMetaFirstAndDebounce();
  await testUploadBuildsStableStSafeFilename();
  await testUploadDoesNotClearNewerLocalRevision();
  await testUploadDefersAndThenCleansStaleRemoteChunks();
  await testUploadKeepsCompleteGcLedgerBeyondLegacyCap();
  await testLegacyUnscopedGcEntryIsNotAutoDeleted();
  await testUploadRetriesFailedChunkGcAndRetiresMissingChunk();
  await testManifestUploadFailureCompensatesNewChunks();
  await testFailedCompensationIsRecoveredByNextManifest();
  await testPreviousHeadReadFailureDoesNotPublish();
  await testConcurrentHeadChangeDoesNotRaceWinnerCleanup();
  await testHeadCheckFailureAfterChunkUploadCompensates();
  await testPostPublishHeadReplacementDoesNotDeleteWinnerChunks();
  await testUploadSkipsChunkCleanupWhenPreviousManifestUnavailable();
  await testAuthorityBlobUploadPreservesUserFilesFallbackTree();
  await testAuthorityBlobGcIsScopedToAuthorityBackend();
  await testAuthorityManifestFailureCompensatesAuthorityChunks();
  await testUserFilesHeadReadsOnlyUserFilesChunks();
  await testAuthorityFailOpenGcStaysOnUserFiles();
  await testDownloadImport();
  await testLegacyRemoteFilenameFallbackMigratesWritesToStableName();
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
  await testDeleteRemoteSyncFileV2CleansChunksAndGcPending();
  await testDeleteRemoteSyncFileManifestDeleteFailureKeepsChunks();
  await testDeleteRemoteSyncFileManifestReadFailureAbortsDelete();
  await testDeleteRemoteSyncFileRemoteHeadRecreatedSkipsChunkCleanup();
  await testDeleteRemoteSyncFileMissingManifestNoSpeculativeDelete();
  await testDeleteRemoteSyncFileFallsBackToLegacyFilename();
  await testDeleteRemoteSyncFileCleansPrimaryAndLegacyTrees();
  await testDeleteRemoteSyncFileCleansBothRemoteBackends();
  await testAutoSyncOnVisibility();
  await testSyncNowRemoteReadErrorPath();
  await testAutomaticDownloadCannotReplaceNewerLocalCommit();
  await testDownloadDoesNotClearCommitAfterImport();
  await testMergeCannotReplaceNewerLocalCommit();
  await testMergeUploadFailureKeepsLocalReplicaDirty();
  await testMergeUploadDoesNotClearNewerLocalCommit();
  await testAuthorityPrimarySkipsCloudReplica();
  await testSyncAppliedHook();
  console.log("indexeddb-sync tests passed");
}

await main();
