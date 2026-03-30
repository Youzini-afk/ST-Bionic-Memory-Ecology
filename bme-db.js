import { createEmptyGraph, deserializeGraph } from "./graph.js";
import { buildVectorCollectionId, normalizeGraphRuntimeState } from "./runtime-state.js";

const DEXIE_LOAD_PROMISE_KEY = "__stBmeDexieLoadPromise";
const DEXIE_SCRIPT_MARKER = "data-st-bme-dexie";
const DEXIE_SCRIPT_SOURCE = "./lib/dexie.min.js";

const META_DEFAULT_LAST_PROCESSED_FLOOR = -1;
const META_DEFAULT_EXTRACTION_COUNT = 0;

export const BME_DB_SCHEMA_VERSION = 1;
export const BME_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const BME_LEGACY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const BME_RUNTIME_HISTORY_META_KEY = "runtimeHistoryState";
export const BME_RUNTIME_VECTOR_META_KEY = "runtimeVectorIndexState";
export const BME_RUNTIME_BATCH_JOURNAL_META_KEY = "runtimeBatchJournal";
export const BME_RUNTIME_LAST_RECALL_META_KEY = "runtimeLastRecallResult";
export const BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY = "runtimeLastProcessedSeq";
export const BME_RUNTIME_GRAPH_VERSION_META_KEY = "runtimeGraphVersion";

export const BME_DB_TABLE_SCHEMAS = Object.freeze({
  nodes:
    "&id, type, sourceFloor, archived, updatedAt, deletedAt, isEmbedded, parentId, prevId, nextId",
  edges:
    "&id, fromId, toId, [fromId+toId], relation, sourceFloor, updatedAt, deletedAt",
  meta: "&key, updatedAt",
  tombstones: "&id, kind, targetId, deletedAt, sourceDeviceId, [kind+targetId]",
});

function createDefaultMetaValues(chatId = "", nowMs = Date.now()) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedNow = normalizeTimestamp(nowMs);
  return {
    chatId: normalizedChatId,
    revision: 0,
    lastProcessedFloor: META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: META_DEFAULT_EXTRACTION_COUNT,
    lastModified: normalizedNow,
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    deviceId: "",
    nodeCount: 0,
    edgeCount: 0,
    tombstoneCount: 0,
    schemaVersion: BME_DB_SCHEMA_VERSION,
    syncDirty: false,
    migrationCompletedAt: 0,
    migrationSource: "",
    legacyRetentionUntil: 0,
  };
}

function normalizeChatId(chatId) {
  return String(chatId ?? "").trim();
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function normalizeRevision(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value, fallbackValue = Date.now()) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return Math.floor(parsed);
  }
  return Math.floor(Number(fallbackValue) || Date.now());
}

function toPlainData(value, fallbackValue = null) {
  if (value == null) {
    return fallbackValue;
  }

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
    return fallbackValue;
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toMetaMap(rows = []) {
  const output = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = normalizeRecordId(row.key);
    if (!key) continue;
    output[key] = row.value;
  }
  return output;
}

function normalizeMode(mode = "replace") {
  return String(mode || "").toLowerCase() === "merge" ? "merge" : "replace";
}

function sanitizeSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      meta: {},
      state: {},
      nodes: [],
      edges: [],
      tombstones: [],
    };
  }

  const safeMeta =
    snapshot.meta && typeof snapshot.meta === "object" && !Array.isArray(snapshot.meta)
      ? { ...snapshot.meta }
      : {};
  const safeState =
    snapshot.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)
      ? { ...snapshot.state }
      : {};

  return {
    meta: safeMeta,
    state: safeState,
    nodes: toArray(snapshot.nodes).map((item) => ({ ...(item || {}) })),
    edges: toArray(snapshot.edges).map((item) => ({ ...(item || {}) })),
    tombstones: toArray(snapshot.tombstones).map((item) => ({ ...(item || {}) })),
  };
}

function normalizeStateSnapshot(snapshot = {}) {
  const state =
    snapshot?.state && typeof snapshot.state === "object" && !Array.isArray(snapshot.state)
      ? { ...snapshot.state }
      : {};

  return {
    lastProcessedFloor: Number.isFinite(Number(state.lastProcessedFloor))
      ? Number(state.lastProcessedFloor)
      : META_DEFAULT_LAST_PROCESSED_FLOOR,
    extractionCount: Number.isFinite(Number(state.extractionCount))
      ? Number(state.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT,
  };
}

function normalizeNodeUpdatedAt(node = {}, fallbackNowMs = Date.now()) {
  return normalizeTimestamp(
    node.updatedAt ?? node.lastAccessTime ?? node.createdTime,
    fallbackNowMs,
  );
}

function normalizeEdgeUpdatedAt(edge = {}, fallbackNowMs = Date.now()) {
  return normalizeTimestamp(
    edge.updatedAt ?? edge.validAt ?? edge.createdTime,
    fallbackNowMs,
  );
}

function normalizeSourceFloor(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function deriveNodeSourceFloor(node = {}) {
  const directSourceFloor = normalizeSourceFloor(node?.sourceFloor);
  if (directSourceFloor != null) return directSourceFloor;

  const seqRange = Array.isArray(node?.seqRange) ? node.seqRange : [];
  const seqRangeEnd = normalizeSourceFloor(seqRange[1]);
  if (seqRangeEnd != null) return seqRangeEnd;

  const seq = normalizeSourceFloor(node?.seq);
  if (seq != null) return seq;

  return null;
}

function deriveEdgeSourceFloor(edge = {}, nodeSourceFloorById = new Map()) {
  const directSourceFloor = normalizeSourceFloor(edge?.sourceFloor);
  if (directSourceFloor != null) return directSourceFloor;

  const seqRange = Array.isArray(edge?.seqRange) ? edge.seqRange : [];
  const seqRangeEnd = normalizeSourceFloor(seqRange[1]);
  if (seqRangeEnd != null) return seqRangeEnd;

  const seq = normalizeSourceFloor(edge?.seq);
  if (seq != null) return seq;

  const fromFloor = normalizeSourceFloor(
    nodeSourceFloorById.get(normalizeRecordId(edge?.fromId)),
  );
  const toFloor = normalizeSourceFloor(
    nodeSourceFloorById.get(normalizeRecordId(edge?.toId)),
  );

  if (fromFloor != null && toFloor != null) return Math.max(fromFloor, toFloor);
  if (fromFloor != null) return fromFloor;
  if (toFloor != null) return toFloor;
  return null;
}

export function buildSnapshotFromGraph(graph, options = {}) {
  const baseSnapshot = sanitizeSnapshot(options.baseSnapshot || {});
  const nowMs = normalizeTimestamp(options.nowMs, Date.now());
  const chatId =
    normalizeChatId(options.chatId) ||
    normalizeChatId(graph?.historyState?.chatId) ||
    normalizeChatId(baseSnapshot.meta?.chatId);

  const graphInput = toPlainData(graph, createEmptyGraph());
  if (!graphInput.historyState || typeof graphInput.historyState !== "object") {
    graphInput.historyState = {};
  }
  if (!graphInput.vectorIndexState || typeof graphInput.vectorIndexState !== "object") {
    graphInput.vectorIndexState = {};
  }
  if (chatId) {
    graphInput.historyState.chatId = chatId;
  }
  graphInput.vectorIndexState.collectionId = buildVectorCollectionId(
    chatId || graphInput.historyState.chatId || "",
  );
  const runtimeGraph = normalizeGraphRuntimeState(graphInput, chatId);

  const nodes = toArray(runtimeGraph?.nodes)
    .map((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return null;
      const id = normalizeRecordId(node.id);
      if (!id) return null;
      return {
        ...node,
        id,
        updatedAt: normalizeNodeUpdatedAt(node, nowMs),
      };
    })
    .filter(Boolean);

  const edges = toArray(runtimeGraph?.edges)
    .map((edge) => {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) return null;
      const id = normalizeRecordId(edge.id);
      if (!id) return null;
      return {
        ...edge,
        id,
        fromId: normalizeRecordId(edge.fromId),
        toId: normalizeRecordId(edge.toId),
        updatedAt: normalizeEdgeUpdatedAt(edge, nowMs),
      };
    })
    .filter(Boolean);

  const tombstones = toArray(options.tombstones ?? baseSnapshot.tombstones)
    .map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const id = normalizeRecordId(record.id);
      if (!id) return null;
      return {
        ...record,
        id,
        kind: normalizeRecordId(record.kind),
        targetId: normalizeRecordId(record.targetId),
        sourceDeviceId: normalizeRecordId(record.sourceDeviceId),
        deletedAt: normalizeTimestamp(record.deletedAt, nowMs),
      };
    })
    .filter(Boolean);

  const state = {
    ...normalizeStateSnapshot(baseSnapshot),
    ...(options.state || {}),
    lastProcessedFloor: Number.isFinite(
      Number(runtimeGraph?.historyState?.lastProcessedAssistantFloor),
    )
      ? Number(runtimeGraph.historyState.lastProcessedAssistantFloor)
      : Number(runtimeGraph?.lastProcessedSeq ?? META_DEFAULT_LAST_PROCESSED_FLOOR),
    extractionCount: Number.isFinite(Number(runtimeGraph?.historyState?.extractionCount))
      ? Number(runtimeGraph.historyState.extractionCount)
      : META_DEFAULT_EXTRACTION_COUNT,
  };

  const mergedMeta = {
    ...baseSnapshot.meta,
    ...(options.meta || {}),
    schemaVersion: BME_DB_SCHEMA_VERSION,
    chatId,
    revision: normalizeRevision(options.revision ?? baseSnapshot.meta?.revision),
    lastModified: normalizeTimestamp(
      options.lastModified ?? baseSnapshot.meta?.lastModified,
      nowMs,
    ),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    tombstoneCount: tombstones.length,
    [BME_RUNTIME_HISTORY_META_KEY]: toPlainData(runtimeGraph?.historyState || {}, {}),
    [BME_RUNTIME_VECTOR_META_KEY]: toPlainData(runtimeGraph?.vectorIndexState || {}, {}),
    [BME_RUNTIME_BATCH_JOURNAL_META_KEY]: toPlainData(runtimeGraph?.batchJournal || [], []),
    [BME_RUNTIME_LAST_RECALL_META_KEY]: toPlainData(
      runtimeGraph?.lastRecallResult ?? null,
      null,
    ),
    [BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY]: Number.isFinite(
      Number(runtimeGraph?.lastProcessedSeq),
    )
      ? Number(runtimeGraph.lastProcessedSeq)
      : state.lastProcessedFloor,
    [BME_RUNTIME_GRAPH_VERSION_META_KEY]: Number.isFinite(Number(runtimeGraph?.version))
      ? Number(runtimeGraph.version)
      : Number(baseSnapshot.meta?.[BME_RUNTIME_GRAPH_VERSION_META_KEY] || 0),
  };

  return {
    meta: mergedMeta,
    nodes,
    edges,
    tombstones,
    state,
  };
}

export function buildGraphFromSnapshot(snapshot, options = {}) {
  const normalizedSnapshot = sanitizeSnapshot(snapshot);
  const chatId =
    normalizeChatId(options.chatId) ||
    normalizeChatId(normalizedSnapshot.meta?.chatId) ||
    normalizeChatId(normalizedSnapshot.state?.chatId);

  const runtimeGraph = createEmptyGraph();
  runtimeGraph.version = Number.isFinite(
    Number(normalizedSnapshot.meta?.[BME_RUNTIME_GRAPH_VERSION_META_KEY]),
  )
    ? Number(normalizedSnapshot.meta[BME_RUNTIME_GRAPH_VERSION_META_KEY])
    : runtimeGraph.version;
  runtimeGraph.nodes = toArray(normalizedSnapshot.nodes).map((node) => ({ ...(node || {}) }));
  runtimeGraph.edges = toArray(normalizedSnapshot.edges).map((edge) => ({ ...(edge || {}) }));
  runtimeGraph.batchJournal = toArray(
    normalizedSnapshot.meta?.[BME_RUNTIME_BATCH_JOURNAL_META_KEY],
  );
  runtimeGraph.lastRecallResult = toPlainData(
    normalizedSnapshot.meta?.[BME_RUNTIME_LAST_RECALL_META_KEY],
    null,
  );

  runtimeGraph.historyState = {
    ...(runtimeGraph.historyState || {}),
    ...(normalizedSnapshot.meta?.[BME_RUNTIME_HISTORY_META_KEY] || {}),
    lastProcessedAssistantFloor: Number.isFinite(Number(normalizedSnapshot.state?.lastProcessedFloor))
      ? Number(normalizedSnapshot.state.lastProcessedFloor)
      : Number(
          normalizedSnapshot.meta?.[BME_RUNTIME_HISTORY_META_KEY]
            ?.lastProcessedAssistantFloor ?? META_DEFAULT_LAST_PROCESSED_FLOOR,
        ),
    extractionCount: Number.isFinite(Number(normalizedSnapshot.state?.extractionCount))
      ? Number(normalizedSnapshot.state.extractionCount)
      : Number(
          normalizedSnapshot.meta?.[BME_RUNTIME_HISTORY_META_KEY]?.extractionCount ??
            META_DEFAULT_EXTRACTION_COUNT,
        ),
  };
  runtimeGraph.vectorIndexState = {
    ...(runtimeGraph.vectorIndexState || {}),
    ...(normalizedSnapshot.meta?.[BME_RUNTIME_VECTOR_META_KEY] || {}),
    collectionId: buildVectorCollectionId(
      chatId ||
        normalizedSnapshot.meta?.[BME_RUNTIME_HISTORY_META_KEY]?.chatId ||
        runtimeGraph.historyState?.chatId ||
        "",
    ),
  };

  runtimeGraph.lastProcessedSeq = Number.isFinite(
    Number(normalizedSnapshot.meta?.[BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY]),
  )
    ? Number(normalizedSnapshot.meta[BME_RUNTIME_LAST_PROCESSED_SEQ_META_KEY])
    : Number(runtimeGraph.historyState.lastProcessedAssistantFloor);

  return normalizeGraphRuntimeState(runtimeGraph, chatId);
}

async function loadDexieFromNodeFallback() {
  try {
    const imported = await import("dexie");
    const DexieCtor = imported?.default || imported?.Dexie || imported;
    if (typeof DexieCtor === "function") {
      globalThis.Dexie = DexieCtor;
      return DexieCtor;
    }
  } catch {
    // ignore and continue to throw below.
  }

  throw new Error("Dexie 不可用（Node 环境缺少 dexie 依赖）");
}

async function loadDexieByScriptInjection() {
  const scriptUrl = new URL(DEXIE_SCRIPT_SOURCE, import.meta.url).toString();
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== "function") {
    throw new Error("document 不可用，无法注入 Dexie 脚本");
  }

  await new Promise((resolve, reject) => {
    const existingScript = doc.querySelector?.(`script[${DEXIE_SCRIPT_MARKER}="true"]`);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Dexie 脚本加载失败")),
        { once: true },
      );

      // 兼容脚本已经加载完成的情况
      if (globalThis.Dexie) {
        resolve();
      }
      return;
    }

    const script = doc.createElement("script");
    script.async = true;
    script.src = scriptUrl;
    script.setAttribute(DEXIE_SCRIPT_MARKER, "true");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error(`Dexie 脚本加载失败: ${scriptUrl}`)),
      { once: true },
    );

    const mountTarget = doc.head || doc.documentElement || doc.body;
    if (!mountTarget) {
      reject(new Error("无法找到可用的脚本挂载节点"));
      return;
    }
    mountTarget.appendChild(script);
  });

  if (!globalThis.Dexie) {
    throw new Error("Dexie 脚本已加载但 window.Dexie 不可用");
  }

  return globalThis.Dexie;
}

export async function ensureDexieLoaded() {
  if (globalThis.Dexie) {
    return globalThis.Dexie;
  }

  if (!globalThis[DEXIE_LOAD_PROMISE_KEY]) {
    globalThis[DEXIE_LOAD_PROMISE_KEY] = (async () => {
      if (globalThis.Dexie) {
        return globalThis.Dexie;
      }

      if (typeof globalThis.document === "undefined") {
        return await loadDexieFromNodeFallback();
      }

      return await loadDexieByScriptInjection();
    })()
      .then((DexieCtor) => {
        globalThis.Dexie = DexieCtor;
        return DexieCtor;
      })
      .catch((error) => {
        console.warn("[ST-BME] Dexie 加载失败:", error);
        throw error;
      })
      .finally(() => {
        if (!globalThis.Dexie) {
          delete globalThis[DEXIE_LOAD_PROMISE_KEY];
        }
      });
  }

  return await globalThis[DEXIE_LOAD_PROMISE_KEY];
}

export function buildBmeDbName(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  return `STBME_${normalizedChatId}`;
}

export class BmeDatabase {
  constructor(chatId, options = {}) {
    this.chatId = normalizeChatId(chatId);
    this.dbName = buildBmeDbName(this.chatId);
    this.options = {
      dexieClass: options.dexieClass || null,
    };

    this.db = null;
    this._openPromise = null;
  }

  async open() {
    if (this.db?.isOpen?.()) {
      return this.db;
    }

    if (!this._openPromise) {
      this._openPromise = (async () => {
        const DexieCtor =
          this.options.dexieClass || globalThis.Dexie || (await ensureDexieLoaded());
        if (typeof DexieCtor !== "function") {
          throw new Error("Dexie 构造函数不可用");
        }

        const db = new DexieCtor(this.dbName);
        db.version(BME_DB_SCHEMA_VERSION).stores(BME_DB_TABLE_SCHEMAS);
        await db.open();

        this.db = db;
        await this._ensureMetaDefaults();
        return db;
      })().catch((error) => {
        try {
          this.db?.close?.();
        } catch {
          // noop
        }
        this.db = null;
        this._openPromise = null;
        throw error;
      });
    }

    return await this._openPromise;
  }

  async close() {
    try {
      this.db?.close?.();
    } finally {
      this.db = null;
      this._openPromise = null;
    }
  }

  async getMeta(key, fallbackValue = null) {
    const db = await this.open();
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return fallbackValue;

    const row = await db.table("meta").get(normalizedKey);
    if (!row || !("value" in row)) return fallbackValue;
    return row.value;
  }

  async setMeta(key, value) {
    const db = await this.open();
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return null;

    const nowMs = Date.now();
    const record = {
      key: normalizedKey,
      value: toPlainData(value, value),
      updatedAt: nowMs,
    };

    await db.table("meta").put(record);
    return record;
  }

  async patchMeta(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return {};
    }

    const db = await this.open();
    const nowMs = Date.now();
    const entries = Object.entries(record).filter(([key]) => normalizeRecordId(key));

    if (!entries.length) {
      return {};
    }

    await db.transaction("rw", db.table("meta"), async () => {
      for (const [key, value] of entries) {
        await this._setMetaInTx(db, key, value, nowMs);
      }
    });

    return Object.fromEntries(entries);
  }

  async getRevision() {
    const revision = await this.getMeta("revision", 0);
    return normalizeRevision(revision);
  }

  async bumpRevision(reason = "mutation") {
    const db = await this.open();
    let nextRevision = 0;

    await db.transaction("rw", db.table("meta"), async () => {
      nextRevision = await this._bumpRevisionInTx(db, reason, Date.now());
    });

    return nextRevision;
  }

  async markSyncDirty(reason = "mutation") {
    const db = await this.open();
    const nowMs = Date.now();
    await db.transaction("rw", db.table("meta"), async () => {
      await this._setMetaInTx(db, "syncDirty", true, nowMs);
      await this._setMetaInTx(db, "syncDirtyReason", String(reason || "mutation"), nowMs);
    });
    return true;
  }

  async bulkUpsertNodes(nodes = []) {
    const records = this._normalizeNodeRecords(nodes);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }

    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
      await db.table("nodes").bulkPut(records);
      await this._updateCountMetaInTx(db, nowMs);
      nextRevision = await this._bumpRevisionInTx(db, "bulkUpsertNodes", nowMs);
      await this._setMetaInTx(db, "syncDirty", true, nowMs);
      await this._setMetaInTx(db, "syncDirtyReason", "bulkUpsertNodes", nowMs);
      },
    );

    return {
      upserted: records.length,
      revision: nextRevision,
    };
  }

  async bulkUpsertEdges(edges = []) {
    const records = this._normalizeEdgeRecords(edges);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }

    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
      await db.table("edges").bulkPut(records);
      await this._updateCountMetaInTx(db, nowMs);
      nextRevision = await this._bumpRevisionInTx(db, "bulkUpsertEdges", nowMs);
      await this._setMetaInTx(db, "syncDirty", true, nowMs);
      await this._setMetaInTx(db, "syncDirtyReason", "bulkUpsertEdges", nowMs);
      },
    );

    return {
      upserted: records.length,
      revision: nextRevision,
    };
  }

  async bulkUpsertTombstones(tombstones = []) {
    const records = this._normalizeTombstoneRecords(tombstones);
    if (!records.length) {
      return {
        upserted: 0,
        revision: await this.getRevision(),
      };
    }

    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
      await db.table("tombstones").bulkPut(records);
      await this._updateCountMetaInTx(db, nowMs);
      nextRevision = await this._bumpRevisionInTx(db, "bulkUpsertTombstones", nowMs);
      await this._setMetaInTx(db, "syncDirty", true, nowMs);
      await this._setMetaInTx(db, "syncDirtyReason", "bulkUpsertTombstones", nowMs);
      },
    );

    return {
      upserted: records.length,
      revision: nextRevision,
    };
  }

  async listNodes(options = {}) {
    const db = await this.open();
    const includeDeleted = options.includeDeleted !== false;
    const includeArchived = options.includeArchived !== false;

    let records = await db.table("nodes").toArray();

    if (!includeDeleted) {
      records = records.filter((item) => !Number.isFinite(Number(item?.deletedAt)));
    }

    if (!includeArchived) {
      records = records.filter((item) => !item?.archived);
    }

    if (typeof options.type === "string" && options.type.trim()) {
      records = records.filter((item) => String(item?.type || "") === options.type);
    }

    return this._applyListOptions(records, options);
  }

  async listEdges(options = {}) {
    const db = await this.open();
    const includeDeleted = options.includeDeleted !== false;

    let records = await db.table("edges").toArray();

    if (!includeDeleted) {
      records = records.filter((item) => !Number.isFinite(Number(item?.deletedAt)));
    }

    if (typeof options.relation === "string" && options.relation.trim()) {
      records = records.filter(
        (item) => String(item?.relation || "") === options.relation,
      );
    }

    return this._applyListOptions(records, options);
  }

  async listTombstones(options = {}) {
    const db = await this.open();
    let records = await db.table("tombstones").toArray();

    if (typeof options.kind === "string" && options.kind.trim()) {
      records = records.filter((item) => String(item?.kind || "") === options.kind);
    }

    if (typeof options.targetId === "string" && options.targetId.trim()) {
      records = records.filter(
        (item) => String(item?.targetId || "") === options.targetId,
      );
    }

    return this._applyListOptions(records, options);
  }

  async isEmpty(options = {}) {
    const db = await this.open();
    const includeTombstones = options.includeTombstones === true;

    const [nodes, edges, tombstones] = await db.transaction(
      "r",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      async () =>
        await Promise.all([
          db.table("nodes").count(),
          db.table("edges").count(),
          db.table("tombstones").count(),
        ]),
    );

    const empty = includeTombstones
      ? nodes === 0 && edges === 0 && tombstones === 0
      : nodes === 0 && edges === 0;

    return {
      empty,
      nodes,
      edges,
      tombstones,
      includeTombstones,
    };
  }

  async importLegacyGraph(legacyGraph, options = {}) {
    const db = await this.open();
    const nowMs = normalizeTimestamp(options.nowMs, Date.now());
    const migrationSource =
      normalizeRecordId(options.source || "chat_metadata") || "chat_metadata";
    const requestedRetentionMs = Number(options.legacyRetentionMs);
    const legacyRetentionMs =
      Number.isFinite(requestedRetentionMs) && requestedRetentionMs >= 0
        ? Math.floor(requestedRetentionMs)
        : BME_LEGACY_RETENTION_MS;
    const legacyRetentionUntil = nowMs + legacyRetentionMs;

    const runtimeLegacyGraph = normalizeGraphRuntimeState(
      deserializeGraph(toPlainData(legacyGraph, createEmptyGraph())),
      this.chatId,
    );
    const snapshot = buildSnapshotFromGraph(runtimeLegacyGraph, {
      chatId: this.chatId,
      nowMs,
      revision: normalizeRevision(
        options.revision ?? runtimeLegacyGraph?.__stBmePersistence?.revision,
      ),
      meta: {
        migrationCompletedAt: nowMs,
        migrationSource,
        legacyRetentionUntil,
      },
    });

    const nodeSourceFloorById = new Map();
    const nodes = this._normalizeNodeRecords(snapshot.nodes, nowMs).map((node) => {
      const sourceFloor = deriveNodeSourceFloor(node);
      nodeSourceFloorById.set(node.id, sourceFloor);
      return sourceFloor == null ? node : { ...node, sourceFloor };
    });
    const edges = this._normalizeEdgeRecords(snapshot.edges, nowMs).map((edge) => {
      const sourceFloor = deriveEdgeSourceFloor(edge, nodeSourceFloorById);
      return sourceFloor == null ? edge : { ...edge, sourceFloor };
    });
    const tombstones = this._normalizeTombstoneRecords(snapshot.tombstones, nowMs);

    let migrated = false;
    let skipReason = "";
    let nextRevision = await this.getRevision();
    let counts = {
      nodes: 0,
      edges: 0,
      tombstones: 0,
    };

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        const migrationCompletedAt = normalizeTimestamp(
          (await db.table("meta").get("migrationCompletedAt"))?.value,
          0,
        );
        if (migrationCompletedAt > 0) {
          skipReason = "migration-already-completed";
          nextRevision = normalizeRevision((await db.table("meta").get("revision"))?.value);
          counts = {
            nodes: await db.table("nodes").count(),
            edges: await db.table("edges").count(),
            tombstones: await db.table("tombstones").count(),
          };
          return;
        }

        const [nodeCount, edgeCount] = await Promise.all([
          db.table("nodes").count(),
          db.table("edges").count(),
        ]);
        if (nodeCount > 0 || edgeCount > 0) {
          skipReason = "indexeddb-not-empty";
          nextRevision = normalizeRevision((await db.table("meta").get("revision"))?.value);
          counts = {
            nodes: nodeCount,
            edges: edgeCount,
            tombstones: await db.table("tombstones").count(),
          };
          return;
        }

        await Promise.all([
          db.table("nodes").clear(),
          db.table("edges").clear(),
          db.table("tombstones").clear(),
        ]);

        if (nodes.length) {
          await db.table("nodes").bulkPut(nodes);
        }
        if (edges.length) {
          await db.table("edges").bulkPut(edges);
        }
        if (tombstones.length) {
          await db.table("tombstones").bulkPut(tombstones);
        }

        const metaPatch = {
          ...snapshot.meta,
          ...(snapshot.state || {}),
          chatId: this.chatId,
          schemaVersion: BME_DB_SCHEMA_VERSION,
          migrationCompletedAt: nowMs,
          migrationSource,
          legacyRetentionUntil,
        };

        delete metaPatch.revision;

        for (const [key, value] of Object.entries(metaPatch)) {
          if (!normalizeRecordId(key)) continue;
          await this._setMetaInTx(db, key, value, nowMs);
        }

        counts = await this._updateCountMetaInTx(db, nowMs);

        const currentRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        const incomingRevision = normalizeRevision(snapshot.meta?.revision);
        const explicitRevision = normalizeRevision(options.revision);
        const requestedRevision = Number.isFinite(Number(options.revision))
          ? explicitRevision
          : Math.max(incomingRevision, 1);

        nextRevision = Math.max(currentRevision + 1, requestedRevision, 1);
        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(db, "lastMutationReason", "importLegacyGraph", nowMs);
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(db, "syncDirtyReason", "legacy-migration", nowMs);

        migrated = true;
      },
    );

    return {
      migrated,
      skipped: !migrated,
      reason: migrated ? "migrated" : skipReason || "migration-skipped",
      revision: nextRevision,
      imported: toPlainData(counts, counts),
      migrationCompletedAt: migrated
        ? nowMs
        : normalizeTimestamp(await this.getMeta("migrationCompletedAt", 0), 0),
      migrationSource,
      legacyRetentionUntil,
    };
  }

  async exportSnapshot() {
    const db = await this.open();

    const [nodes, edges, tombstones, metaRows] = await db.transaction(
      "r",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () =>
        await Promise.all([
          db.table("nodes").toArray(),
          db.table("edges").toArray(),
          db.table("tombstones").toArray(),
          db.table("meta").toArray(),
        ]),
    );

    const meta = {
      ...toMetaMap(metaRows),
      schemaVersion: BME_DB_SCHEMA_VERSION,
      chatId: this.chatId,
      revision: normalizeRevision(toMetaMap(metaRows)?.revision),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      tombstoneCount: tombstones.length,
    };

    const state = {
      lastProcessedFloor: Number.isFinite(Number(meta.lastProcessedFloor))
        ? Number(meta.lastProcessedFloor)
        : META_DEFAULT_LAST_PROCESSED_FLOOR,
      extractionCount: Number.isFinite(Number(meta.extractionCount))
        ? Number(meta.extractionCount)
        : META_DEFAULT_EXTRACTION_COUNT,
    };

    return {
      meta,
      nodes: toPlainData(nodes, []),
      edges: toPlainData(edges, []),
      tombstones: toPlainData(tombstones, []),
      state,
    };
  }

  async importSnapshot(snapshot, options = {}) {
    const db = await this.open();
    const normalizedSnapshot = sanitizeSnapshot(snapshot);
    const mode = normalizeMode(options.mode);
    const shouldMarkSyncDirty = options.markSyncDirty !== false;
    const nowMs = Date.now();

    let nextRevision = 0;
    let counts = {
      nodes: 0,
      edges: 0,
      tombstones: 0,
    };
    let revisionFloor = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        revisionFloor = normalizeRevision((await db.table("meta").get("revision"))?.value);

        if (mode === "replace") {
          await Promise.all([
            db.table("nodes").clear(),
            db.table("edges").clear(),
            db.table("tombstones").clear(),
            db.table("meta").clear(),
          ]);
        }

        const nodes = this._normalizeNodeRecords(normalizedSnapshot.nodes, nowMs);
        const edges = this._normalizeEdgeRecords(normalizedSnapshot.edges, nowMs);
        const tombstones = this._normalizeTombstoneRecords(
          normalizedSnapshot.tombstones,
          nowMs,
        );

        if (nodes.length) {
          await db.table("nodes").bulkPut(nodes);
        }
        if (edges.length) {
          await db.table("edges").bulkPut(edges);
        }
        if (tombstones.length) {
          await db.table("tombstones").bulkPut(tombstones);
        }

        const metaPatch = {
          ...(mode === "replace" ? createDefaultMetaValues(this.chatId, nowMs) : {}),
          ...normalizedSnapshot.meta,
          ...(normalizedSnapshot.state || {}),
          chatId: this.chatId,
          schemaVersion: BME_DB_SCHEMA_VERSION,
        };

        delete metaPatch.revision;

        for (const [key, value] of Object.entries(metaPatch)) {
          if (!normalizeRecordId(key)) continue;
          await this._setMetaInTx(db, key, value, nowMs);
        }

        counts = await this._updateCountMetaInTx(db, nowMs);

        const persistedRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        const currentRevision =
          mode === "replace" ? Math.max(revisionFloor, persistedRevision) : persistedRevision;

        const incomingRevision = normalizeRevision(normalizedSnapshot.meta?.revision);
        const explicitRevision = normalizeRevision(options.revision);
        const requestedRevision = Number.isFinite(Number(options.revision))
          ? explicitRevision
          : options.preserveRevision
            ? incomingRevision
            : currentRevision + 1;

        nextRevision = Math.max(currentRevision + 1, requestedRevision);
        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(db, "lastMutationReason", "importSnapshot", nowMs);

        await this._setMetaInTx(db, "syncDirty", shouldMarkSyncDirty, nowMs);
        await this._setMetaInTx(db, "syncDirtyReason", "importSnapshot", nowMs);
      },
    );

    return {
      mode,
      revision: nextRevision,
      imported: {
        nodes: counts.nodes,
        edges: counts.edges,
        tombstones: counts.tombstones,
      },
    };
  }

  async clearAll() {
    const db = await this.open();
    const nowMs = Date.now();
    let nextRevision = 0;

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
        await Promise.all([
          db.table("nodes").clear(),
          db.table("edges").clear(),
          db.table("tombstones").clear(),
        ]);

        const currentRevision = normalizeRevision(
          (await db.table("meta").get("revision"))?.value,
        );
        nextRevision = currentRevision + 1;

        await this._setMetaInTx(db, "revision", nextRevision, nowMs);
        await this._setMetaInTx(db, "chatId", this.chatId, nowMs);
        await this._setMetaInTx(db, "schemaVersion", BME_DB_SCHEMA_VERSION, nowMs);
        await this._setMetaInTx(db, "nodeCount", 0, nowMs);
        await this._setMetaInTx(db, "edgeCount", 0, nowMs);
        await this._setMetaInTx(db, "tombstoneCount", 0, nowMs);
        await this._setMetaInTx(
          db,
          "lastProcessedFloor",
          META_DEFAULT_LAST_PROCESSED_FLOOR,
          nowMs,
        );
        await this._setMetaInTx(
          db,
          "extractionCount",
          META_DEFAULT_EXTRACTION_COUNT,
          nowMs,
        );
        await this._setMetaInTx(db, "lastModified", nowMs, nowMs);
        await this._setMetaInTx(db, "lastMutationReason", "clearAll", nowMs);
        await this._setMetaInTx(db, "syncDirty", true, nowMs);
        await this._setMetaInTx(db, "syncDirtyReason", "clearAll", nowMs);
      },
    );

    return {
      cleared: true,
      revision: nextRevision,
    };
  }

  async pruneExpiredTombstones(nowMs = Date.now()) {
    const db = await this.open();
    const normalizedNow = normalizeTimestamp(nowMs, Date.now());
    const cutoffMs = normalizedNow - BME_TOMBSTONE_RETENTION_MS;

    let removedCount = 0;
    let nextRevision = await this.getRevision();

    await db.transaction(
      "rw",
      db.table("nodes"),
      db.table("edges"),
      db.table("tombstones"),
      db.table("meta"),
      async () => {
      const staleIds = await db
        .table("tombstones")
        .where("deletedAt")
        .below(cutoffMs)
        .primaryKeys();

      if (!staleIds.length) {
        return;
      }

      await db.table("tombstones").bulkDelete(staleIds);
      removedCount = staleIds.length;

      await this._updateCountMetaInTx(db, normalizedNow);
      nextRevision = await this._bumpRevisionInTx(
        db,
        "pruneExpiredTombstones",
        normalizedNow,
      );
      await this._setMetaInTx(db, "syncDirty", true, normalizedNow);
      await this._setMetaInTx(
        db,
        "syncDirtyReason",
        "pruneExpiredTombstones",
        normalizedNow,
      );
      },
    );

    return {
      pruned: removedCount,
      revision: nextRevision,
      cutoffMs,
    };
  }

  async _ensureMetaDefaults() {
    const db = await this.open();
    const nowMs = Date.now();
    const defaultMeta = createDefaultMetaValues(this.chatId, nowMs);

    await db.transaction("rw", db.table("meta"), async () => {
      for (const [key, value] of Object.entries(defaultMeta)) {
        const existing = await db.table("meta").get(key);
        if (existing && "value" in existing) continue;
        await this._setMetaInTx(db, key, value, nowMs);
      }
    });
  }

  async _setMetaInTx(db, key, value, nowMs = Date.now()) {
    const normalizedKey = normalizeRecordId(key);
    if (!normalizedKey) return;

    await db.table("meta").put({
      key: normalizedKey,
      value: toPlainData(value, value),
      updatedAt: normalizeTimestamp(nowMs, Date.now()),
    });
  }

  async _bumpRevisionInTx(db, reason = "mutation", nowMs = Date.now()) {
    const currentRevision = normalizeRevision((await db.table("meta").get("revision"))?.value);
    const nextRevision = currentRevision + 1;

    await this._setMetaInTx(db, "revision", nextRevision, nowMs);
    await this._setMetaInTx(db, "lastModified", normalizeTimestamp(nowMs), nowMs);
    await this._setMetaInTx(db, "lastMutationReason", String(reason || "mutation"), nowMs);

    return nextRevision;
  }

  async _updateCountMetaInTx(db, nowMs = Date.now()) {
    const [nodes, edges, tombstones] = await Promise.all([
      db.table("nodes").count(),
      db.table("edges").count(),
      db.table("tombstones").count(),
    ]);

    await this._setMetaInTx(db, "nodeCount", nodes, nowMs);
    await this._setMetaInTx(db, "edgeCount", edges, nowMs);
    await this._setMetaInTx(db, "tombstoneCount", tombstones, nowMs);

    return {
      nodes,
      edges,
      tombstones,
    };
  }

  _applyListOptions(records, options = {}) {
    let nextRecords = toArray(records);

    const orderBy = String(options.orderBy || "updatedAt").trim();
    const reverse = options.reverse !== false;

    nextRecords = nextRecords.sort((left, right) => {
      const leftValue = Number(left?.[orderBy]);
      const rightValue = Number(right?.[orderBy]);
      if (!Number.isFinite(leftValue) && !Number.isFinite(rightValue)) return 0;
      if (!Number.isFinite(leftValue)) return reverse ? 1 : -1;
      if (!Number.isFinite(rightValue)) return reverse ? -1 : 1;
      return reverse ? rightValue - leftValue : leftValue - rightValue;
    });

    const limit = Number(options.limit);
    if (Number.isFinite(limit) && limit > 0) {
      nextRecords = nextRecords.slice(0, Math.floor(limit));
    }

    return toPlainData(nextRecords, []);
  }

  _normalizeNodeRecords(nodes = [], fallbackNowMs = Date.now()) {
    const nowMs = normalizeTimestamp(fallbackNowMs);
    return toArray(nodes)
      .map((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return null;
        const id = normalizeRecordId(node.id);
        if (!id) return null;

        return {
          ...node,
          id,
          updatedAt: normalizeTimestamp(node.updatedAt, nowMs),
        };
      })
      .filter(Boolean);
  }

  _normalizeEdgeRecords(edges = [], fallbackNowMs = Date.now()) {
    const nowMs = normalizeTimestamp(fallbackNowMs);
    return toArray(edges)
      .map((edge) => {
        if (!edge || typeof edge !== "object" || Array.isArray(edge)) return null;
        const id = normalizeRecordId(edge.id);
        if (!id) return null;

        return {
          ...edge,
          id,
          fromId: normalizeRecordId(edge.fromId),
          toId: normalizeRecordId(edge.toId),
          updatedAt: normalizeTimestamp(edge.updatedAt, nowMs),
        };
      })
      .filter(Boolean);
  }

  _normalizeTombstoneRecords(tombstones = [], fallbackNowMs = Date.now()) {
    const nowMs = normalizeTimestamp(fallbackNowMs);
    return toArray(tombstones)
      .map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) return null;

        const id = normalizeRecordId(record.id);
        if (!id) return null;

        return {
          ...record,
          id,
          kind: normalizeRecordId(record.kind),
          targetId: normalizeRecordId(record.targetId),
          sourceDeviceId: normalizeRecordId(record.sourceDeviceId),
          deletedAt: normalizeTimestamp(record.deletedAt, nowMs),
        };
      })
      .filter(Boolean);
  }
}
