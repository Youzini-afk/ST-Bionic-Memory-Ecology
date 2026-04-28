import { deserializeGraph } from "../graph/graph.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";
import { buildSnapshotFromGraph } from "../sync/bme-db.js";

function clonePlain(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function normalizeChatId(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function normalizeIssue(severity, code, message) {
  return {
    severity,
    code: String(code || "unknown"),
    message: String(message || ""),
  };
}

function readNestedValue(source = null, path = []) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function readFirstValue(source = null, candidates = []) {
  for (const candidate of candidates) {
    const path = Array.isArray(candidate) ? candidate : [candidate];
    const value = readNestedValue(source, path);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function readFirstInteger(source = null, candidates = []) {
  const value = readFirstValue(source, candidates);
  return normalizeOptionalInteger(value);
}

function readFirstString(source = null, candidates = []) {
  const value = readFirstValue(source, candidates);
  return value == null ? "" : String(value || "").trim();
}

function normalizeErrorMessage(error = null) {
  if (!error) return "";
  return String(error?.message || error || "").trim();
}

function buildRevisionDelta(left = null, right = null) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Number(left) - Number(right);
}

export function buildAuthorityCheckpointImportSnapshot(checkpoint = null, options = {}) {
  const normalizedCheckpoint =
    checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
      ? checkpoint
      : null;
  if (!normalizedCheckpoint) {
    return {
      ok: false,
      reason: "checkpoint-missing",
      snapshot: null,
    };
  }

  const chatId = normalizeChatId(options.chatId || normalizedCheckpoint.chatId);
  if (!chatId) {
    return {
      ok: false,
      reason: "checkpoint-chat-id-missing",
      snapshot: null,
    };
  }

  const serializedGraph = String(normalizedCheckpoint.serializedGraph || "").trim();
  const rawGraph =
    normalizedCheckpoint.graph &&
    typeof normalizedCheckpoint.graph === "object" &&
    !Array.isArray(normalizedCheckpoint.graph)
      ? clonePlain(normalizedCheckpoint.graph, null)
      : null;
  if (!serializedGraph && !rawGraph) {
    return {
      ok: false,
      reason: "checkpoint-serialized-graph-missing",
      snapshot: null,
    };
  }

  try {
    const restoredGraph = normalizeGraphRuntimeState(
      rawGraph || deserializeGraph(serializedGraph),
      chatId,
    );
    const revision = Math.max(
      0,
      normalizeOptionalInteger(options.revision) ?? -1,
      normalizeOptionalInteger(normalizedCheckpoint.revision) ?? -1,
    );
    const source = String(options.source || "authority-checkpoint-restore").trim() ||
      "authority-checkpoint-restore";
    const integrity = String(
      normalizedCheckpoint.integrity || options.integrity || "",
    ).trim();
    const snapshot = buildSnapshotFromGraph(restoredGraph, {
      chatId,
      revision,
      lastModified: Date.now(),
      meta: {
        integrity,
        storagePrimary: String(options.storagePrimary || "authority"),
        storageMode: String(options.storageMode || "authority-sql-primary"),
        lastMutationReason: source,
        authorityCheckpointSource: source,
        authorityCheckpointChatId: chatId,
        authorityCheckpointRevision: revision,
        authorityCheckpointPersistedAt: String(
          normalizedCheckpoint.persistedAt || "",
        ),
        authorityCheckpointPath: String(options.path || ""),
      },
    });
    return {
      ok: true,
      reason: "checkpoint-import-snapshot-ready",
      snapshot,
      checkpoint: {
        chatId,
        revision,
        integrity,
        persistedAt: String(normalizedCheckpoint.persistedAt || ""),
        hasSerializedGraph: Boolean(serializedGraph || rawGraph),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "checkpoint-invalid",
      error,
      snapshot: null,
    };
  }
}

export async function applyAuthorityCheckpointToStore(
  targetStore,
  checkpoint = null,
  options = {},
) {
  const prepared = buildAuthorityCheckpointImportSnapshot(checkpoint, options);
  if (!prepared.ok || !prepared.snapshot) {
    return {
      ...prepared,
      restored: false,
    };
  }
  if (!targetStore || typeof targetStore.importSnapshot !== "function") {
    return {
      ...prepared,
      ok: false,
      reason: "target-store-import-unavailable",
      restored: false,
    };
  }
  if (typeof targetStore.open === "function") {
    await targetStore.open();
  }
  if (typeof options.beforeImport === "function") {
    await options.beforeImport(prepared.snapshot);
  }
  const importResult = await targetStore.importSnapshot(prepared.snapshot, {
    mode: "replace",
    preserveRevision: true,
    revision: prepared.snapshot.meta.revision,
    markSyncDirty: options.markSyncDirty === true,
  });
  prepared.snapshot.meta.revision = Math.max(
    normalizeOptionalInteger(importResult?.revision) ?? 0,
    normalizeOptionalInteger(prepared.snapshot.meta.revision) ?? 0,
  );
  return {
    ...prepared,
    ok: true,
    restored: true,
    revision: prepared.snapshot.meta.revision,
    importResult: clonePlain(importResult, importResult),
  };
}

export function buildAuthorityConsistencyAudit(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const updatedAt = String(source.updatedAt || new Date().toISOString());
  const chatId = normalizeChatId(
    source.chatId ||
      source.runtimeGraph?.chatId ||
      source.graphPersistenceState?.chatId ||
      source.blobResult?.checkpoint?.chatId,
  );
  const collectionId = normalizeChatId(
    source.collectionId ||
      source.runtimeGraph?.vectorIndexState?.collectionId ||
      source.runtimeGraph?.runtimeState?.vectorIndexState?.collectionId,
  );
  const sqlSnapshot =
    source.sqlSnapshot && typeof source.sqlSnapshot === "object" && !Array.isArray(source.sqlSnapshot)
      ? source.sqlSnapshot
      : null;
  const sqlError = normalizeErrorMessage(source.sqlError);
  const sql = {
    available: Boolean(sqlSnapshot),
    ok: Boolean(sqlSnapshot) && !sqlError,
    error: sqlError,
    revision: readFirstInteger(sqlSnapshot, [["meta", "revision"]]),
    nodeCount: readFirstInteger(sqlSnapshot, [["meta", "nodeCount"]]) ??
      (Array.isArray(sqlSnapshot?.nodes) ? sqlSnapshot.nodes.length : null),
    edgeCount: readFirstInteger(sqlSnapshot, [["meta", "edgeCount"]]) ??
      (Array.isArray(sqlSnapshot?.edges) ? sqlSnapshot.edges.length : null),
    tombstoneCount: readFirstInteger(sqlSnapshot, [["meta", "tombstoneCount"]]) ??
      (Array.isArray(sqlSnapshot?.tombstones) ? sqlSnapshot.tombstones.length : null),
    lastModified: readFirstString(sqlSnapshot, [["meta", "lastModified"], ["meta", "updatedAt"]]),
  };

  const blobError = normalizeErrorMessage(source.blobError || source.blobResult?.error);
  const blobCheckpoint =
    source.blobResult?.checkpoint &&
    typeof source.blobResult.checkpoint === "object" &&
    !Array.isArray(source.blobResult.checkpoint)
      ? source.blobResult.checkpoint
      : null;
  const blob = {
    available: source.blobResult != null,
    ok: source.blobResult?.ok !== false && !blobError,
    error: blobError,
    exists: Boolean(source.blobResult?.exists && blobCheckpoint),
    path: String(
      source.blobResult?.path || source.graphPersistenceState?.authorityBlobCheckpointPath || "",
    ).trim(),
    revision:
      readFirstInteger(blobCheckpoint, [["revision"]]) ??
      normalizeOptionalInteger(source.graphPersistenceState?.authorityBlobCheckpointRevision),
    chatId: normalizeChatId(blobCheckpoint?.chatId),
    persistedAt: readFirstString(blobCheckpoint, [["persistedAt"], ["updatedAt"]]),
    hasSerializedGraph: Boolean(
      String(blobCheckpoint?.serializedGraph || "").trim() ||
        (blobCheckpoint?.graph && typeof blobCheckpoint.graph === "object"),
    ),
  };

  const triviumSource =
    source.triviumStat && typeof source.triviumStat === "object" && !Array.isArray(source.triviumStat)
      ? source.triviumStat
      : null;
  const triviumError = normalizeErrorMessage(source.triviumError);
  const trivium = {
    available: Boolean(triviumSource),
    ok: Boolean(triviumSource) && !triviumError,
    error: triviumError,
    revision: readFirstInteger(triviumSource, [
      ["revision"],
      ["graphRevision"],
      ["result", "revision"],
      ["result", "graphRevision"],
      ["stats", "revision"],
      ["meta", "revision"],
    ]),
    itemCount: readFirstInteger(triviumSource, [
      ["itemCount"],
      ["count"],
      ["total"],
      ["vectorCount"],
      ["documentCount"],
      ["result", "itemCount"],
      ["result", "count"],
      ["result", "total"],
      ["stats", "itemCount"],
      ["stats", "count"],
    ]),
    linkCount: readFirstInteger(triviumSource, [
      ["linkCount"],
      ["edgeCount"],
      ["relationCount"],
      ["result", "linkCount"],
      ["result", "edgeCount"],
      ["stats", "linkCount"],
    ]),
    namespace: readFirstString(triviumSource, [
      ["namespace"],
      ["result", "namespace"],
      ["collectionId"],
      ["result", "collectionId"],
    ]),
  };

  const runtimeGraph =
    source.runtimeGraph && typeof source.runtimeGraph === "object" && !Array.isArray(source.runtimeGraph)
      ? source.runtimeGraph
      : {};
  const runtimePersistence =
    source.graphPersistenceState &&
    typeof source.graphPersistenceState === "object" &&
    !Array.isArray(source.graphPersistenceState)
      ? source.graphPersistenceState
      : {};
  const runtime = {
    revision: Math.max(
      normalizeOptionalInteger(runtimeGraph?.meta?.revision) ?? 0,
      normalizeOptionalInteger(runtimePersistence?.revision) ?? 0,
    ),
    nodeCount: Array.isArray(runtimeGraph?.nodes) ? runtimeGraph.nodes.length : null,
    edgeCount: Array.isArray(runtimeGraph?.edges) ? runtimeGraph.edges.length : null,
    collectionId,
    vectorDirty: Boolean(runtimeGraph?.vectorIndexState?.dirty),
    lastJobId: String(
      source.lastJob?.id || runtimePersistence?.authorityLastJobId || "",
    ).trim(),
    lastJobStatus: String(
      source.lastJob?.status || runtimePersistence?.authorityLastJobStatus || "",
    ).trim(),
  };

  const drift = {
    runtimeVsSqlRevision: buildRevisionDelta(runtime.revision, sql.revision),
    runtimeVsBlobRevision: buildRevisionDelta(runtime.revision, blob.revision),
    sqlVsBlobRevision: buildRevisionDelta(sql.revision, blob.revision),
    triviumVsSqlRevision: buildRevisionDelta(trivium.revision, sql.revision),
    collectionMatchesRuntime:
      !trivium.namespace || !runtime.collectionId || trivium.namespace === runtime.collectionId,
    checkpointRestorable:
      blob.exists && blob.hasSerializedGraph && (!blob.chatId || !chatId || blob.chatId === chatId),
  };

  const issues = [];
  if (sql.error) {
    issues.push(normalizeIssue("error", "sql-probe-error", `Authority SQL 探针失败：${sql.error}`));
  }
  if (blob.error) {
    issues.push(normalizeIssue("warning", "blob-probe-error", `Authority Blob 读取失败：${blob.error}`));
  }
  if (trivium.error) {
    issues.push(normalizeIssue("warning", "trivium-probe-error", `Authority Trivium 探针失败：${trivium.error}`));
  }
  if (blob.exists && blob.chatId && chatId && blob.chatId !== chatId) {
    issues.push(normalizeIssue("error", "blob-chat-mismatch", `Checkpoint chatId 不匹配：${blob.chatId} ≠ ${chatId}`));
  }
  if (
    Number.isFinite(sql.revision) &&
    Number.isFinite(runtime.revision) &&
    sql.revision !== runtime.revision
  ) {
    issues.push(
      normalizeIssue(
        "warning",
        "sql-runtime-revision-drift",
        `SQL revision 与 runtime 不一致：${sql.revision} ≠ ${runtime.revision}`,
      ),
    );
  }
  if (
    Number.isFinite(blob.revision) &&
    Number.isFinite(runtime.revision) &&
    blob.revision !== runtime.revision
  ) {
    issues.push(
      normalizeIssue(
        "warning",
        "blob-runtime-revision-drift",
        `Blob checkpoint revision 与 runtime 不一致：${blob.revision} ≠ ${runtime.revision}`,
      ),
    );
  }
  if (
    Number.isFinite(trivium.revision) &&
    Number.isFinite(sql.revision) &&
    trivium.revision !== sql.revision
  ) {
    issues.push(
      normalizeIssue(
        "warning",
        "trivium-sql-revision-drift",
        `Trivium revision 与 SQL 不一致：${trivium.revision} ≠ ${sql.revision}`,
      ),
    );
  }
  if (!drift.collectionMatchesRuntime) {
    issues.push(
      normalizeIssue(
        "warning",
        "trivium-collection-mismatch",
        `Trivium collection/namespace 与 runtime 不一致：${trivium.namespace} ≠ ${runtime.collectionId}`,
      ),
    );
  }
  if (runtime.vectorDirty) {
    issues.push(normalizeIssue("warning", "vector-dirty", "当前向量索引仍处于 dirty 状态"));
  }
  if (!blob.exists && source.capability?.blobReady) {
    issues.push(normalizeIssue("warning", "blob-checkpoint-missing", "Authority Blob 尚无可用 checkpoint"));
  }

  const actions = [];
  if (drift.checkpointRestorable) actions.push("restore-from-authority-blob-checkpoint");
  if (runtime.vectorDirty || (Number.isFinite(drift.triviumVsSqlRevision) && drift.triviumVsSqlRevision < 0)) {
    actions.push("rebuild-authority-trivium");
  }
  if (!blob.exists && source.capability?.blobReady) {
    actions.push("write-authority-checkpoint");
  }
  if (issues.some((issue) => issue.code === "sql-runtime-revision-drift" || issue.code === "blob-runtime-revision-drift")) {
    actions.push("run-authority-consistency-audit");
  }

  const level = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.length
      ? "warning"
      : sql.available || blob.available || trivium.available
        ? "success"
        : "idle";
  const label =
    level === "error"
      ? "存在阻塞性不一致"
      : level === "warning"
        ? "存在待处理漂移"
        : level === "success"
          ? "Authority 工件已对齐"
          : "等待审计";
  const detail = issues[0]?.message || (level === "success"
    ? "Authority SQL / Trivium / Blob 已达到当前可观测的一致状态"
    : "尚未运行审计");

  return {
    updatedAt,
    chatId,
    collectionId,
    sql,
    trivium,
    blob,
    runtime,
    drift,
    issues,
    actions,
    summary: {
      level,
      label,
      detail,
      issueCount: issues.length,
    },
  };
}
