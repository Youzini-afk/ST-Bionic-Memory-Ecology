const BME_SYNC_FILE_PREFIX = "ST-BME_sync_";
const BME_SYNC_FILE_SUFFIX = ".json";

export const BME_SYNC_DEVICE_ID_KEY = "st_bme_sync_device_id_v1";
export const BME_SYNC_UPLOAD_DEBOUNCE_MS = 2500;

const syncInFlightByChatId = new Map();
const uploadDebounceTimerByChatId = new Map();
const sanitizedFilenameByChatId = new Map();

let visibilitySyncInstalled = false;
let lastVisibilityState = "visible";

function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

function normalizeRevision(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.floor(Number(fallback) || Date.now());
  return Math.floor(parsed);
}

function sanitizeSnapshotRecordArray(records) {
  return Array.isArray(records)
    ? records
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({ ...item }))
    : [];
}

function toSerializableData(value, fallback = null) {
  if (value == null) return fallback;

  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // no-op
    }
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function getStorage() {
  const storage = globalThis.localStorage;
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return null;
  }
  return storage;
}

function getRandomBytes(size = 16) {
  if (globalThis.crypto?.getRandomValues) {
    const buffer = new Uint8Array(size);
    globalThis.crypto.getRandomValues(buffer);
    return buffer;
  }

  const fallback = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    fallback[index] = Math.floor(Math.random() * 256);
  }
  return fallback;
}

function createFallbackDeviceId() {
  const bytes = getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeBase64Utf8(text) {
  const normalizedText = String(text ?? "");

  if (typeof globalThis.btoa === "function" && typeof globalThis.TextEncoder === "function") {
    const bytes = new TextEncoder().encode(normalizedText);
    const chunkSize = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return globalThis.btoa(binary);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalizedText, "utf8").toString("base64");
  }

  throw new Error("当前环境缺少 base64 编码能力");
}

function decodeBase64Utf8(base64Text) {
  const normalizedBase64 = String(base64Text ?? "");

  if (typeof globalThis.atob === "function" && typeof globalThis.TextDecoder === "function") {
    const binary = globalThis.atob(normalizedBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalizedBase64, "base64").toString("utf8");
  }

  throw new Error("当前环境缺少 base64 解码能力");
}

function getFetch(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch 不可用，无法执行 ST-BME 同步请求");
  }
  return fetchImpl;
}

function getRequestHeadersSafe(options = {}) {
  if (typeof options.getRequestHeaders === "function") {
    try {
      return options.getRequestHeaders() || {};
    } catch (error) {
      console.warn("[ST-BME] 读取请求头失败，回退为空请求头:", error);
      return {};
    }
  }
  return {};
}

function normalizeSyncSnapshot(snapshot = {}, chatId = "") {
  const normalizedChatId = normalizeChatId(chatId || snapshot?.meta?.chatId);
  const nowMs = Date.now();

  const nodes = sanitizeSnapshotRecordArray(snapshot?.nodes);
  const edges = sanitizeSnapshotRecordArray(snapshot?.edges);
  const tombstones = sanitizeSnapshotRecordArray(snapshot?.tombstones);

  const state = {
    lastProcessedFloor: Number.isFinite(Number(snapshot?.state?.lastProcessedFloor))
      ? Number(snapshot.state.lastProcessedFloor)
      : -1,
    extractionCount: Number.isFinite(Number(snapshot?.state?.extractionCount))
      ? Number(snapshot.state.extractionCount)
      : 0,
  };

  const incomingMeta =
    snapshot?.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
      ? { ...snapshot.meta }
      : {};

  const meta = {
    ...incomingMeta,
    schemaVersion: Number.isFinite(Number(incomingMeta.schemaVersion))
      ? Number(incomingMeta.schemaVersion)
      : 1,
    chatId: normalizedChatId,
    deviceId: String(incomingMeta.deviceId || "").trim(),
    revision: normalizeRevision(incomingMeta.revision),
    lastModified: normalizeTimestamp(incomingMeta.lastModified, nowMs),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    tombstoneCount: tombstones.length,
  };

  return {
    meta,
    nodes,
    edges,
    tombstones,
    state,
  };
}

function createRecordWinnerByUpdatedAt(localRecord, remoteRecord) {
  if (!localRecord) return remoteRecord || null;
  if (!remoteRecord) return localRecord || null;

  const localUpdatedAt = normalizeTimestamp(localRecord.updatedAt, 0);
  const remoteUpdatedAt = normalizeTimestamp(remoteRecord.updatedAt, 0);

  if (remoteUpdatedAt > localUpdatedAt) {
    return remoteRecord;
  }

  if (localUpdatedAt > remoteUpdatedAt) {
    return localRecord;
  }

  return remoteRecord;
}

function buildTombstoneIndex(tombstones = []) {
  const tombstoneById = new Map();
  const tombstoneByTarget = new Map();

  for (const tombstone of tombstones) {
    if (!tombstone || typeof tombstone !== "object") continue;

    const normalizedTombstone = {
      ...tombstone,
      id: String(tombstone.id || "").trim(),
      kind: String(tombstone.kind || "").trim(),
      targetId: String(tombstone.targetId || "").trim(),
      sourceDeviceId: String(tombstone.sourceDeviceId || "").trim(),
      deletedAt: normalizeTimestamp(tombstone.deletedAt, 0),
    };

    if (!normalizedTombstone.id) continue;

    const existingById = tombstoneById.get(normalizedTombstone.id);
    if (!existingById || normalizedTombstone.deletedAt >= existingById.deletedAt) {
      tombstoneById.set(normalizedTombstone.id, normalizedTombstone);
    }

    if (normalizedTombstone.kind && normalizedTombstone.targetId) {
      const targetKey = `${normalizedTombstone.kind}:${normalizedTombstone.targetId}`;
      const existingByTarget = tombstoneByTarget.get(targetKey);
      if (!existingByTarget || normalizedTombstone.deletedAt >= existingByTarget.deletedAt) {
        tombstoneByTarget.set(targetKey, normalizedTombstone);
      }
    }
  }

  return {
    byId: tombstoneById,
    byTarget: tombstoneByTarget,
  };
}

function filterRecordsByTombstones(records = [], kind, tombstoneIndex) {
  const normalizedKind = String(kind || "").trim();
  if (!normalizedKind || !tombstoneIndex?.byTarget) return records;

  return records.filter((record) => {
    const recordId = String(record?.id || "").trim();
    if (!recordId) return false;

    const targetKey = `${normalizedKind}:${recordId}`;
    const tombstone = tombstoneIndex.byTarget.get(targetKey);
    if (!tombstone) return true;

    const deletedAt = normalizeTimestamp(tombstone.deletedAt, 0);
    const updatedAt = normalizeTimestamp(record?.updatedAt, 0);
    return deletedAt <= updatedAt;
  });
}

function mergeRecordCollectionById(localRecords = [], remoteRecords = []) {
  const mergedById = new Map();

  for (const record of localRecords) {
    const id = String(record?.id || "").trim();
    if (!id) continue;
    mergedById.set(id, { ...record, id });
  }

  for (const record of remoteRecords) {
    const id = String(record?.id || "").trim();
    if (!id) continue;

    const localRecord = mergedById.get(id) || null;
    const remoteRecord = { ...record, id };
    const winner = createRecordWinnerByUpdatedAt(localRecord, remoteRecord);
    if (winner) mergedById.set(id, winner);
  }

  return Array.from(mergedById.values());
}

async function getDb(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error("chatId 不能为空");
  }

  if (typeof options.getDb !== "function") {
    throw new Error("同步运行时缺少 getDb(chatId) 能力");
  }

  const db = await options.getDb(normalizedChatId);
  if (!db || typeof db.exportSnapshot !== "function") {
    throw new Error("getDb(chatId) 必须返回有效的 BmeDatabase 实例");
  }

  return db;
}

async function patchDbMeta(db, patch = {}) {
  if (!db || !patch || typeof patch !== "object") return;
  if (typeof db.patchMeta === "function") {
    await db.patchMeta(patch);
    return;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (typeof db.setMeta === "function") {
      await db.setMeta(key, value);
    }
  }
}

async function sanitizeFilename(fileName, options = {}) {
  const fallbackSanitized = String(fileName || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/g, "")
    .slice(0, 180);

  const finalFallback = fallbackSanitized || "ST-BME_sync_unknown.json";

  if (options.disableRemoteSanitize) {
    return finalFallback;
  }

  try {
    const fetchImpl = getFetch(options);
    const response = await fetchImpl("/api/files/sanitize-filename", {
      method: "POST",
      headers: {
        ...getRequestHeadersSafe(options),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fileName }),
    });

    if (!response.ok) {
      return finalFallback;
    }

    const payload = await response.json().catch(() => null);
    const sanitized = String(payload?.fileName || "").trim();
    return sanitized || finalFallback;
  } catch {
    return finalFallback;
  }
}

async function resolveSyncFilename(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error("chatId 不能为空");
  }

  if (sanitizedFilenameByChatId.has(normalizedChatId)) {
    return sanitizedFilenameByChatId.get(normalizedChatId);
  }

  const rawFileName = `${BME_SYNC_FILE_PREFIX}${normalizedChatId}${BME_SYNC_FILE_SUFFIX}`;
  const sanitized = await sanitizeFilename(rawFileName, options);
  const finalName = sanitized || rawFileName;
  sanitizedFilenameByChatId.set(normalizedChatId, finalName);
  return finalName;
}

async function readRemoteSnapshot(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      exists: false,
      status: "missing-chat-id",
      filename: "",
      snapshot: null,
    };
  }

  const filename = await resolveSyncFilename(normalizedChatId, options);
  const fetchImpl = getFetch(options);
  const cacheBust = `t=${Date.now()}`;
  const url = `/user/files/${encodeURIComponent(filename)}?${cacheBust}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
    });
  } catch (error) {
    console.warn("[ST-BME] 读取远端同步文件失败:", error);
    return {
      exists: false,
      status: "network-error",
      filename,
      snapshot: null,
      error,
    };
  }

  if (response.status === 404) {
    return {
      exists: false,
      status: "not-found",
      filename,
      snapshot: null,
    };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    const error = new Error(errorText || `HTTP ${response.status}`);
    console.warn("[ST-BME] 读取远端同步文件失败:", error);
    return {
      exists: false,
      status: "http-error",
      filename,
      snapshot: null,
      error,
      statusCode: response.status,
    };
  }

  try {
    const remotePayload = await response.json();
    const snapshot = normalizeSyncSnapshot(remotePayload, normalizedChatId);
    return {
      exists: true,
      status: "ok",
      filename,
      snapshot,
    };
  } catch (error) {
    console.warn("[ST-BME] 解析远端同步文件失败:", error);
    return {
      exists: false,
      status: "invalid-json",
      filename,
      snapshot: null,
      error,
    };
  }
}

async function writeSnapshotToRemote(snapshot, chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedSnapshot = normalizeSyncSnapshot(snapshot, normalizedChatId);
  const filename = await resolveSyncFilename(normalizedChatId, options);
  const fetchImpl = getFetch(options);

  const payload = {
    meta: toSerializableData(normalizedSnapshot.meta, {}),
    nodes: toSerializableData(normalizedSnapshot.nodes, []),
    edges: toSerializableData(normalizedSnapshot.edges, []),
    tombstones: toSerializableData(normalizedSnapshot.tombstones, []),
    state: toSerializableData(normalizedSnapshot.state, {
      lastProcessedFloor: -1,
      extractionCount: 0,
    }),
  };

  const response = await fetchImpl("/api/files/upload", {
    method: "POST",
    headers: {
      ...getRequestHeadersSafe(options),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: filename,
      data: encodeBase64Utf8(JSON.stringify(payload, null, 2)),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(errorText || `HTTP ${response.status}`);
  }

  const uploadResult = await response.json().catch(() => ({}));
  return {
    filename,
    path: String(uploadResult?.path || ""),
    payload,
  };
}

function withChatSyncLock(chatId, task) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return Promise.resolve({
      synced: false,
      reason: "missing-chat-id",
      chatId: "",
    });
  }

  if (syncInFlightByChatId.has(normalizedChatId)) {
    return syncInFlightByChatId.get(normalizedChatId);
  }

  const taskPromise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.warn("[ST-BME] 同步任务失败:", error);
      return {
        synced: false,
        chatId: normalizedChatId,
        reason: "sync-error",
        error,
      };
    })
    .finally(() => {
      if (syncInFlightByChatId.get(normalizedChatId) === taskPromise) {
        syncInFlightByChatId.delete(normalizedChatId);
      }
    });

  syncInFlightByChatId.set(normalizedChatId, taskPromise);
  return taskPromise;
}

export function getOrCreateDeviceId() {
  const storage = getStorage();
  const existingDeviceId = String(storage?.getItem(BME_SYNC_DEVICE_ID_KEY) || "").trim();
  if (existingDeviceId) return existingDeviceId;

  const deviceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : createFallbackDeviceId();

  try {
    storage?.setItem(BME_SYNC_DEVICE_ID_KEY, deviceId);
  } catch (error) {
    console.warn("[ST-BME] 写入 deviceId 到 localStorage 失败:", error);
  }

  return deviceId;
}

export async function getRemoteStatus(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      chatId: "",
      exists: false,
      revision: 0,
      lastModified: 0,
      deviceId: "",
      filename: "",
      status: "missing-chat-id",
    };
  }

  const remoteResult = await readRemoteSnapshot(normalizedChatId, options);
  if (!remoteResult.exists || !remoteResult.snapshot) {
    if (remoteResult.status !== "not-found" && remoteResult.status !== "missing-chat-id") {
      console.warn("[ST-BME] 远端同步状态读取异常，已回退为可恢复状态:", {
        chatId: normalizedChatId,
        status: remoteResult.status,
      });
    }
    return {
      chatId: normalizedChatId,
      exists: false,
      revision: 0,
      lastModified: 0,
      deviceId: "",
      filename: remoteResult.filename || "",
      status: remoteResult.status,
      error: remoteResult.error || null,
    };
  }

  return {
    chatId: normalizedChatId,
    exists: true,
    revision: normalizeRevision(remoteResult.snapshot.meta?.revision),
    lastModified: normalizeTimestamp(remoteResult.snapshot.meta?.lastModified, 0),
    deviceId: String(remoteResult.snapshot.meta?.deviceId || "").trim(),
    filename: remoteResult.filename,
    status: "ok",
  };
}

export async function upload(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      uploaded: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const db = await getDb(normalizedChatId, options);
    const localSnapshot = normalizeSyncSnapshot(await db.exportSnapshot(), normalizedChatId);
    const nowMs = Date.now();

    const deviceId = getOrCreateDeviceId();
    localSnapshot.meta.deviceId = localSnapshot.meta.deviceId || deviceId;
    localSnapshot.meta.chatId = normalizedChatId;
    localSnapshot.meta.lastModified = normalizeTimestamp(localSnapshot.meta.lastModified, nowMs);

    const uploadResult = await writeSnapshotToRemote(localSnapshot, normalizedChatId, options);

    await patchDbMeta(db, {
      deviceId,
      lastSyncUploadedAt: nowMs,
      lastSyncedRevision: normalizeRevision(localSnapshot.meta.revision),
      syncDirty: false,
      syncDirtyReason: "",
      lastModified: localSnapshot.meta.lastModified,
    });

    return {
      uploaded: true,
      chatId: normalizedChatId,
      filename: uploadResult.filename,
      remotePath: uploadResult.path,
      revision: normalizeRevision(localSnapshot.meta.revision),
    };
  } catch (error) {
    console.warn("[ST-BME] 上传同步文件失败:", error);
    return {
      uploaded: false,
      chatId: normalizedChatId,
      reason: "upload-error",
      error,
    };
  }
}

export async function download(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      downloaded: false,
      exists: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const db = await getDb(normalizedChatId, options);
    const remoteResult = await readRemoteSnapshot(normalizedChatId, options);

    if (!remoteResult.exists || !remoteResult.snapshot) {
      return {
        downloaded: false,
        exists: false,
        chatId: normalizedChatId,
        filename: remoteResult.filename || "",
        reason: remoteResult.status || "remote-missing",
      };
    }

    const remoteSnapshot = normalizeSyncSnapshot(remoteResult.snapshot, normalizedChatId);
    const remoteRevision = normalizeRevision(remoteSnapshot.meta.revision);

    await db.importSnapshot(remoteSnapshot, {
      mode: "replace",
      preserveRevision: true,
      revision: remoteRevision,
      markSyncDirty: false,
    });

    await patchDbMeta(db, {
      deviceId: getOrCreateDeviceId(),
      lastSyncDownloadedAt: Date.now(),
      lastSyncedRevision: remoteRevision,
      syncDirty: false,
      syncDirtyReason: "",
    });

    return {
      downloaded: true,
      exists: true,
      chatId: normalizedChatId,
      filename: remoteResult.filename,
      revision: remoteRevision,
    };
  } catch (error) {
    console.warn("[ST-BME] 下载同步文件失败:", error);
    return {
      downloaded: false,
      exists: false,
      chatId: normalizedChatId,
      reason: "download-error",
      error,
    };
  }
}

export function mergeSnapshots(localSnapshot, remoteSnapshot, options = {}) {
  const normalizedChatId = normalizeChatId(options.chatId || localSnapshot?.meta?.chatId || remoteSnapshot?.meta?.chatId);
  const local = normalizeSyncSnapshot(localSnapshot, normalizedChatId);
  const remote = normalizeSyncSnapshot(remoteSnapshot, normalizedChatId);

  const mergedTombstoneIndex = buildTombstoneIndex([
    ...local.tombstones,
    ...remote.tombstones,
  ]);
  const mergedTombstones = Array.from(mergedTombstoneIndex.byId.values());

  const mergedNodes = filterRecordsByTombstones(
    mergeRecordCollectionById(local.nodes, remote.nodes),
    "node",
    mergedTombstoneIndex,
  );
  const mergedEdges = filterRecordsByTombstones(
    mergeRecordCollectionById(local.edges, remote.edges),
    "edge",
    mergedTombstoneIndex,
  );

  const localRevision = normalizeRevision(local.meta.revision);
  const remoteRevision = normalizeRevision(remote.meta.revision);
  const mergedRevision = Math.max(localRevision, remoteRevision) + 1;

  const mergedState = {
    lastProcessedFloor: Math.max(
      Number(local.state?.lastProcessedFloor ?? -1),
      Number(remote.state?.lastProcessedFloor ?? -1),
    ),
    extractionCount: Math.max(
      Number(local.state?.extractionCount ?? 0),
      Number(remote.state?.extractionCount ?? 0),
    ),
  };

  const mergedMeta = {
    ...local.meta,
    ...remote.meta,
    schemaVersion: Math.max(
      Number(local.meta?.schemaVersion || 1),
      Number(remote.meta?.schemaVersion || 1),
    ),
    chatId: normalizedChatId,
    deviceId: String(local.meta?.deviceId || remote.meta?.deviceId || getOrCreateDeviceId()).trim(),
    revision: mergedRevision,
    lastModified: Math.max(
      normalizeTimestamp(local.meta?.lastModified, 0),
      normalizeTimestamp(remote.meta?.lastModified, 0),
      Date.now(),
    ),
    nodeCount: mergedNodes.length,
    edgeCount: mergedEdges.length,
    tombstoneCount: mergedTombstones.length,
  };

  return {
    meta: mergedMeta,
    nodes: mergedNodes,
    edges: mergedEdges,
    tombstones: mergedTombstones,
    state: mergedState,
  };
}

export async function syncNow(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      synced: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  return await withChatSyncLock(normalizedChatId, async () => {
    const db = await getDb(normalizedChatId, options);
    const localSnapshot = normalizeSyncSnapshot(await db.exportSnapshot(), normalizedChatId);
    const localRevision = normalizeRevision(localSnapshot.meta.revision);
    const localDirty = Boolean(await db.getMeta("syncDirty", false));

    const remoteResult = await readRemoteSnapshot(normalizedChatId, options);
    if (!remoteResult.exists || !remoteResult.snapshot) {
      if (remoteResult.status !== "not-found") {
        return {
          synced: false,
          chatId: normalizedChatId,
          reason: remoteResult.status || "remote-read-error",
          error: remoteResult.error || null,
        };
      }

      const uploadResult = await upload(normalizedChatId, options);
      return {
        synced: Boolean(uploadResult.uploaded),
        chatId: normalizedChatId,
        action: uploadResult.uploaded ? "upload" : "none",
        ...uploadResult,
      };
    }

    const remoteSnapshot = normalizeSyncSnapshot(remoteResult.snapshot, normalizedChatId);
    const remoteRevision = normalizeRevision(remoteSnapshot.meta.revision);

    if (remoteRevision > localRevision && !localDirty) {
      const downloadResult = await download(normalizedChatId, options);
      return {
        synced: Boolean(downloadResult.downloaded),
        chatId: normalizedChatId,
        action: downloadResult.downloaded ? "download" : "none",
        ...downloadResult,
      };
    }

    if (localRevision > remoteRevision && !options.forceMerge) {
      const uploadResult = await upload(normalizedChatId, options);
      return {
        synced: Boolean(uploadResult.uploaded),
        chatId: normalizedChatId,
        action: uploadResult.uploaded ? "upload" : "none",
        ...uploadResult,
      };
    }

    if (localRevision === remoteRevision && !localDirty && !options.forceMerge) {
      return {
        synced: true,
        chatId: normalizedChatId,
        action: "noop",
        revision: localRevision,
      };
    }

    const mergedSnapshot = mergeSnapshots(localSnapshot, remoteSnapshot, {
      chatId: normalizedChatId,
    });

    await db.importSnapshot(mergedSnapshot, {
      mode: "replace",
      preserveRevision: true,
      revision: mergedSnapshot.meta.revision,
      markSyncDirty: false,
    });

    await patchDbMeta(db, {
      deviceId: getOrCreateDeviceId(),
      lastSyncDownloadedAt: Date.now(),
      lastSyncedRevision: normalizeRevision(mergedSnapshot.meta.revision),
      syncDirty: false,
      syncDirtyReason: "",
      lastProcessedFloor: mergedSnapshot.state.lastProcessedFloor,
      extractionCount: mergedSnapshot.state.extractionCount,
    });

    const uploadResult = await writeSnapshotToRemote(mergedSnapshot, normalizedChatId, options);

    await patchDbMeta(db, {
      lastSyncUploadedAt: Date.now(),
      lastSyncedRevision: normalizeRevision(mergedSnapshot.meta.revision),
      syncDirty: false,
      syncDirtyReason: "",
    });

    return {
      synced: true,
      chatId: normalizedChatId,
      action: "merge",
      filename: uploadResult.filename,
      remotePath: uploadResult.path,
      revision: normalizeRevision(mergedSnapshot.meta.revision),
    };
  });
}

export function scheduleUpload(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      scheduled: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Math.max(0, Math.floor(Number(options.debounceMs)))
    : BME_SYNC_UPLOAD_DEBOUNCE_MS;

  const previousTimer = uploadDebounceTimerByChatId.get(normalizedChatId);
  if (previousTimer) {
    clearTimeout(previousTimer);
  }

  const timer = setTimeout(() => {
    uploadDebounceTimerByChatId.delete(normalizedChatId);
    withChatSyncLock(normalizedChatId, async () => await upload(normalizedChatId, options));
  }, debounceMs);

  uploadDebounceTimerByChatId.set(normalizedChatId, timer);

  return {
    scheduled: true,
    chatId: normalizedChatId,
    debounceMs,
  };
}

export function autoSyncOnChatChange(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return Promise.resolve({
      synced: false,
      chatId: "",
      reason: "missing-chat-id",
    });
  }

  return syncNow(normalizedChatId, {
    ...options,
    trigger: options.trigger || "chat-change",
  });
}

export function autoSyncOnVisibility(options = {}) {
  if (visibilitySyncInstalled || typeof document?.addEventListener !== "function") {
    return {
      installed: visibilitySyncInstalled,
    };
  }

  visibilitySyncInstalled = true;
  lastVisibilityState = document.visibilityState || "visible";

  document.addEventListener("visibilitychange", () => {
    const currentVisibilityState = document.visibilityState || "visible";
    const becameVisible =
      lastVisibilityState === "hidden" && currentVisibilityState === "visible";

    lastVisibilityState = currentVisibilityState;

    if (!becameVisible) return;

    const chatIdResolver =
      typeof options.getCurrentChatId === "function"
        ? options.getCurrentChatId
        : () => "";

    const chatId = normalizeChatId(chatIdResolver());
    if (!chatId) return;

    autoSyncOnChatChange(chatId, {
      ...options,
      trigger: "visibility-visible",
    }).catch((error) => {
      console.warn("[ST-BME] visibility 自动同步失败:", error);
    });
  });

  return {
    installed: true,
  };
}

export async function deleteRemoteSyncFile(chatId, options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    return {
      deleted: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  try {
    const filename = await resolveSyncFilename(normalizedChatId, options);
    const fetchImpl = getFetch(options);
    const response = await fetchImpl("/api/files/delete", {
      method: "POST",
      headers: {
        ...getRequestHeadersSafe(options),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: `/user/files/${filename}`,
      }),
    });

    if (response.status === 404) {
      return {
        deleted: false,
        chatId: normalizedChatId,
        filename,
        reason: "not-found",
      };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(errorText || `HTTP ${response.status}`);
    }

    return {
      deleted: true,
      chatId: normalizedChatId,
      filename,
    };
  } catch (error) {
    console.warn("[ST-BME] 删除远端同步文件失败:", error);
    return {
      deleted: false,
      chatId: normalizedChatId,
      reason: "delete-error",
      error,
    };
  }
}

export function __testOnlyDecodeBase64Utf8(base64Text) {
  return decodeBase64Utf8(base64Text);
}
