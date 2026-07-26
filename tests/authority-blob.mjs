import assert from "node:assert/strict";

import {
  createAuthorityBlobAdapter,
  normalizeAuthorityBlobPath,
  normalizeAuthorityBlobReadResult,
} from "../maintenance/authority-blob-adapter.js";
import {
  backupToServer,
  download,
  listServerBackups,
  restoreFromServer,
  upload,
} from "../sync/bme-sync.js";

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
}

class FakeDb {
  constructor(chatId, snapshot = null) {
    this.chatId = chatId;
    this.snapshot = snapshot || {
      meta: {
        schemaVersion: 1,
        chatId,
        deviceId: "",
        revision: 1,
        lastModified: 10,
        nodeCount: 1,
        edgeCount: 0,
        tombstoneCount: 0,
      },
      nodes: [{ id: `${chatId}-node`, updatedAt: 10 }],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: 1,
        extractionCount: 1,
      },
    };
    this.meta = new Map([
      ["syncDirty", false],
      ["syncDirtyReason", ""],
      ["lastSyncedRevision", 0],
    ]);
    this.lastImportPayload = null;
  }

  async exportSnapshot() {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  async importSnapshot(snapshot) {
    this.lastImportPayload = JSON.parse(JSON.stringify(snapshot));
    this.snapshot = JSON.parse(JSON.stringify(snapshot));
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

function createMockAuthorityBlobClient() {
  const files = new Map();
  const calls = [];
  return {
    files,
    calls,
    async writeJson(payload = {}) {
      calls.push(["writeJson", { ...payload }]);
      files.set(String(payload.path || ""), JSON.parse(JSON.stringify(payload.payload)));
      return { ok: true, path: payload.path, size: JSON.stringify(payload.payload).length };
    },
    async writeText(payload = {}) {
      calls.push(["writeText", { ...payload }]);
      files.set(String(payload.path || ""), String(payload.text ?? payload.data ?? ""));
      return { ok: true, path: payload.path, size: String(payload.text ?? "").length };
    },
    async readJson(payload = {}) {
      calls.push(["readJson", { ...payload }]);
      const path = String(payload.path || "");
      if (!files.has(path)) return { exists: false, path };
      return { exists: true, path, payload: JSON.parse(JSON.stringify(files.get(path))) };
    },
    async delete(payload = {}) {
      calls.push(["delete", { ...payload }]);
      const path = String(payload.path || "");
      const existed = files.delete(path);
      return { ok: true, deleted: existed, exists: existed, path };
    },
  };
}

function createMockFetch() {
  const logs = {
    getCalls: 0,
    uploadCalls: 0,
    deleteCalls: 0,
    sanitizeCalls: 0,
  };
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() {
      return JSON.parse(JSON.stringify(body));
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  const fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    if (url === "/api/files/sanitize-filename" && method === "POST") {
      logs.sanitizeCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      return response(200, {
        fileName: String(body.fileName || "").replace(/[^A-Za-z0-9._~-]+/g, "_"),
      });
    }
    if (url === "/api/files/upload" && method === "POST") {
      logs.uploadCalls += 1;
      return response(500, "legacy upload should not be used");
    }
    if (url === "/api/files/delete" && method === "POST") {
      logs.deleteCalls += 1;
      return response(404, "not found");
    }
    if (String(url).startsWith("/user/files/") && method === "GET") {
      logs.getCalls += 1;
      return response(404, "not found");
    }
    return response(404, "unsupported route");
  };
  return { fetch, logs };
}

function createLegacyFileFetch() {
  const files = new Map();
  const logs = {
    getCalls: 0,
    uploadCalls: 0,
    deleteCalls: 0,
    sanitizeCalls: 0,
  };
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() {
      return typeof body === "string" ? JSON.parse(body) : JSON.parse(JSON.stringify(body));
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  });
  const decodeUploadData = (value = "") =>
    Buffer.from(String(value || ""), "base64").toString("utf8");
  const fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    if (url === "/api/files/sanitize-filename" && method === "POST") {
      logs.sanitizeCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      return response(200, {
        fileName: String(body.fileName || "").replace(/[^A-Za-z0-9._~-]+/g, "_"),
      });
    }
    if (url === "/api/files/upload" && method === "POST") {
      logs.uploadCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      const name = String(body.name || "");
      files.set(name, decodeUploadData(body.data));
      return response(200, { path: `/user/files/${name}` });
    }
    if (url === "/api/files/delete" && method === "POST") {
      logs.deleteCalls += 1;
      const body = JSON.parse(String(options.body || "{}"));
      const name = decodeURIComponent(String(body.path || "").split("/").pop() || "");
      const deleted = files.delete(name);
      return response(deleted ? 200 : 404, deleted ? { deleted: true } : "not found");
    }
    if (String(url).startsWith("/user/files/") && method === "GET") {
      logs.getCalls += 1;
      const path = String(url).split("?")[0];
      const name = decodeURIComponent(path.slice("/user/files/".length));
      if (!files.has(name)) return response(404, "not found");
      return response(200, JSON.parse(files.get(name)));
    }
    return response(404, "unsupported route");
  };
  return { fetch, files, logs };
}

function buildRuntimeOptions({ dbByChatId, fetch, blobClient, onAuthorityBlobEvent = null }) {
  return {
    fetch,
    blobClient,
    authorityBlobEnabled: true,
    authorityBlobFailOpen: true,
    getDb: async (chatId) => {
      const db = dbByChatId.get(chatId);
      if (!db) throw new Error(`missing db: ${chatId}`);
      return db;
    },
    getSafetyDb: async (chatId) => new FakeDb(`__restore_safety__${chatId}`),
    getRequestHeaders: () => ({ "X-Test": "1" }),
    onAuthorityBlobEvent,
  };
}

function createFailingAuthorityBlobClient() {
  const calls = [];
  const fail = async (method, payload = {}) => {
    calls.push([method, { ...payload }]);
    throw new Error("blob unavailable");
  };
  return {
    calls,
    writeJson: (payload) => fail("writeJson", payload),
    writeText: (payload) => fail("writeText", payload),
    readJson: (payload) => fail("readJson", payload),
    delete: (payload) => fail("delete", payload),
  };
}

async function testAdapterBasics() {
  const client = createMockAuthorityBlobClient();
  const adapter = createAuthorityBlobAdapter({}, { blobClient: client });
  assert.equal(normalizeAuthorityBlobPath("/user/files/demo.json"), "user/files/demo.json");
  assert.equal(
    normalizeAuthorityBlobReadResult({ data: JSON.stringify({ ok: true }) }, "a.json").payload.ok,
    true,
  );

  const writeResult = await adapter.writeJson("/user/files/demo.json", { hello: "world" });
  assert.equal(writeResult.ok, true);
  const readResult = await adapter.readJson("user/files/demo.json");
  assert.equal(readResult.exists, true);
  assert.deepEqual(readResult.payload, { hello: "world" });
  const deleteResult = await adapter.delete("user/files/demo.json");
  assert.equal(deleteResult.deleted, true);
  await assert.rejects(
    () => adapter.writeJson("../secret.json", {}),
    /Unsafe Authority Blob path/,
  );
  await assert.rejects(
    () => adapter.readJson("user/files/%2e%2e/secret.json"),
    /Unsafe Authority Blob path/,
  );
  await assert.rejects(
    () => adapter.stat("C:/Users/demo.json"),
    /Unsafe Authority Blob path/,
  );
}

async function testAuthorityBlobFailOpenFallsBackToUserFiles() {
  globalThis.localStorage = new MemoryStorage();
  const blobClient = createFailingAuthorityBlobClient();
  const { fetch, logs } = createLegacyFileFetch();
  const dbByChatId = new Map();
  const db = new FakeDb("blob-fallback", {
    meta: {
      schemaVersion: 1,
      chatId: "blob-fallback",
      deviceId: "",
      revision: 9,
      lastModified: 90,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "fallback-node", updatedAt: 90 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 6, extractionCount: 3 },
  });
  dbByChatId.set("blob-fallback", db);
  const events = [];
  const runtime = buildRuntimeOptions({
    dbByChatId,
    fetch,
    blobClient,
    onAuthorityBlobEvent: (event) => events.push(event),
  });

  const backupResult = await backupToServer("blob-fallback", runtime);
  assert.equal(backupResult.backedUp, true);
  assert.ok(logs.uploadCalls > 0);
  assert.ok(blobClient.calls.some(([method]) => method === "writeJson"));
  assert.ok(events.some((event) => event.reason === "authority-blob-error"));

  db.snapshot = {
    meta: {
      schemaVersion: 1,
      chatId: "blob-fallback",
      deviceId: "",
      revision: 1,
      lastModified: 10,
      nodeCount: 0,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: -1, extractionCount: 0 },
  };
  const restoreResult = await restoreFromServer("blob-fallback", runtime);
  assert.equal(restoreResult.restored, true);
  assert.equal(db.snapshot.nodes[0].id, "fallback-node");
  assert.ok(logs.getCalls > 0);
}

async function testBackupRestoreUsesAuthorityBlob() {
  globalThis.localStorage = new MemoryStorage();
  const blobClient = createMockAuthorityBlobClient();
  const { fetch, logs } = createMockFetch();
  const dbByChatId = new Map();
  const db = new FakeDb("blob-backup", {
    meta: {
      schemaVersion: 1,
      chatId: "blob-backup",
      deviceId: "",
      revision: 7,
      lastModified: 70,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "blob-node", updatedAt: 70 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 3, extractionCount: 2 },
  });
  dbByChatId.set("blob-backup", db);
  const events = [];
  const runtime = buildRuntimeOptions({
    dbByChatId,
    fetch,
    blobClient,
    onAuthorityBlobEvent: (event) => events.push(event),
  });

  const backupResult = await backupToServer("blob-backup", runtime);
  assert.equal(backupResult.backedUp, true);
  assert.equal(logs.uploadCalls, 0);
  assert.equal(blobClient.files.has("user/files/ST-BME_BackupManifest.json"), true);
  assert.equal(blobClient.files.has(`user/files/${backupResult.filename}`), true);

  const manifest = await listServerBackups(runtime);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].chatId, "blob-backup");

  db.snapshot = {
    meta: {
      schemaVersion: 1,
      chatId: "blob-backup",
      deviceId: "",
      revision: 1,
      lastModified: 10,
      nodeCount: 0,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: -1, extractionCount: 0 },
  };
  const restoreResult = await restoreFromServer("blob-backup", runtime);
  assert.equal(restoreResult.restored, true);
  assert.equal(db.snapshot.nodes[0].id, "blob-node");
  assert.equal(events.some((event) => event.backend === "authority-blob"), true);
}

async function testSyncUploadDownloadUsesAuthorityBlob() {
  globalThis.localStorage = new MemoryStorage();
  const blobClient = createMockAuthorityBlobClient();
  const { fetch, logs } = createMockFetch();
  const dbByChatId = new Map();
  const db = new FakeDb("blob-sync", {
    meta: {
      schemaVersion: 1,
      chatId: "blob-sync",
      deviceId: "",
      revision: 5,
      lastModified: 50,
      nodeCount: 1,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [{ id: "sync-blob-node", updatedAt: 50 }],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: 4, extractionCount: 1 },
  });
  dbByChatId.set("blob-sync", db);
  const runtime = buildRuntimeOptions({ dbByChatId, fetch, blobClient });

  const uploadResult = await upload("blob-sync", runtime);
  assert.equal(uploadResult.uploaded, true);
  assert.equal(logs.uploadCalls, 0);
  assert.equal(blobClient.files.has("user/files/ST-BME_sync_blob-sync.json"), true);

  db.snapshot = {
    meta: {
      schemaVersion: 1,
      chatId: "blob-sync",
      deviceId: "",
      revision: 1,
      lastModified: 10,
      nodeCount: 0,
      edgeCount: 0,
      tombstoneCount: 0,
    },
    nodes: [],
    edges: [],
    tombstones: [],
    state: { lastProcessedFloor: -1, extractionCount: 0 },
  };
  const downloadResult = await download("blob-sync", runtime);
  assert.equal(downloadResult.downloaded, true);
  assert.equal(db.snapshot.nodes[0].id, "sync-blob-node");
}

async function testAuthorityBlobHttpBoundary() {
  const requests = [];
  const adapter = createAuthorityBlobAdapter(
    { authorityBaseUrl: "https://authority.example.test/root" },
    {
      headerProvider: () => ({ "X-Test": "1" }),
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith("/session/init")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { sessionToken: "blob-session-token" };
            },
          };
        }
        if (url.endsWith("/fs/private/write-file")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                entry: {
                  path: "user/files/demo.json",
                  sizeBytes: 17,
                  updatedAt: "2026-04-28T12:00:00.000Z",
                },
              };
            },
          };
        }
        if (url.endsWith("/fs/private/read-file")) {
          const body = JSON.parse(String(options.body || "{}"));
          if (body.path === "user/files/missing.json") {
            return {
              ok: false,
              status: 404,
              async json() {
                return { error: "not found" };
              },
              async text() {
                return "not found";
              },
              headers: { get: () => "application/json" },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                entry: {
                  path: "user/files/demo.json",
                  sizeBytes: 17,
                  updatedAt: "2026-04-28T12:00:00.000Z",
                },
                content: JSON.stringify({ hello: "world" }),
                encoding: "utf8",
              };
            },
          };
        }
        if (url.endsWith("/fs/private/stat")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                entry: {
                  path: "user/files/demo.json",
                  sizeBytes: 17,
                  updatedAt: "2026-04-28T12:00:00.000Z",
                },
              };
            },
          };
        }
        if (url.endsWith("/fs/private/delete")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { ok: true };
            },
          };
        }
        return {
          ok: false,
          status: 404,
          async json() {
            return {};
          },
          async text() {
            return "not found";
          },
          headers: { get: () => "application/json" },
        };
      },
    },
  );

  const writeResult = await adapter.writeJson("user/files/demo.json", { hello: "world" });
  assert.equal(writeResult.ok, true);
  assert.equal(writeResult.path, "user/files/demo.json");

  const readResult = await adapter.readJson("user/files/demo.json");
  assert.equal(readResult.exists, true);
  assert.deepEqual(readResult.payload, { hello: "world" });

  const statResult = await adapter.stat("user/files/demo.json");
  assert.equal(statResult.exists, true);
  assert.equal(statResult.path, "user/files/demo.json");

  const missingResult = await adapter.readJson("user/files/missing.json");
  assert.equal(missingResult.exists, false);

  const deleteResult = await adapter.delete("user/files/demo.json");
  assert.equal(deleteResult.ok, true);

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "https://authority.example.test/root/session/init",
      "https://authority.example.test/root/fs/private/write-file",
      "https://authority.example.test/root/fs/private/read-file",
      "https://authority.example.test/root/fs/private/stat",
      "https://authority.example.test/root/fs/private/read-file",
      "https://authority.example.test/root/fs/private/delete",
    ],
  );
  assert.equal(requests[1].options.headers["x-authority-session-token"], "blob-session-token");
  assert.equal(requests[1].options.headers["X-Test"], "1");
  assert.deepEqual(JSON.parse(String(requests[1].options.body || "{}")), {
    path: "user/files/demo.json",
    content: JSON.stringify({ hello: "world" }),
    encoding: "utf8",
    createParents: true,
  });
}

await testAdapterBasics();
await testAuthorityBlobFailOpenFallsBackToUserFiles();
await testBackupRestoreUsesAuthorityBlob();
await testSyncUploadDownloadUsesAuthorityBlob();
await testAuthorityBlobHttpBoundary();
console.log("authority-blob tests passed");
