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

function normalizeIssue(severity, code, message, i18n = {}) {
  return {
    severity,
    code: String(code || "unknown"),
    message: String(message || ""),
    messageKey: String(i18n.messageKey || ""),
    messageParams:
      i18n.messageParams && typeof i18n.messageParams === "object" && !Array.isArray(i18n.messageParams)
        ? clonePlain(i18n.messageParams, {})
        : {},
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

function normalizeRepairAction(value = "") {
  return String(value || "").trim();
}

export function isAuthorityReplicaSyncRepairAction(action = "") {
  return [
    "write-authority-checkpoint",
    "rebuild-authority-trivium",
  ].includes(normalizeRepairAction(action));
}

function collectIssueCodes(audit = null) {
  return new Set(
    (Array.isArray(audit?.issues) ? audit.issues : [])
      .map((issue) => String(issue?.code || "").trim())
      .filter(Boolean),
  );
}

export function buildAuthorityConsistencyRepairPlan(audit = null) {
  const source = audit && typeof audit === "object" && !Array.isArray(audit) ? audit : {};
  const actions = Array.isArray(source.actions)
    ? source.actions.map(normalizeRepairAction).filter(Boolean)
    : [];
  const issueCodes = collectIssueCodes(source);
  const steps = [];
  const sqlRevision = normalizeOptionalInteger(source?.sql?.revision);
  const blobRevision = normalizeOptionalInteger(source?.blob?.revision);
  const sqlNewerThanBlob = Number.isFinite(sqlRevision) && Number.isFinite(blobRevision) && sqlRevision > blobRevision;
  const addStep = (action, label, detail, codes = [], i18n = {}) => {
    const normalizedAction = normalizeRepairAction(action);
    if (!normalizedAction || !actions.includes(normalizedAction)) {
      return;
    }
    if (Array.isArray(codes) && codes.length > 0) {
      const matched = codes.some((code) => issueCodes.has(String(code || "").trim()));
      if (!matched) {
        return;
      }
    }
    if (steps.some((step) => step.action === normalizedAction)) {
      return;
    }
    steps.push({
      action: normalizedAction,
      label: String(label || normalizedAction),
      detail: String(detail || ""),
      labelKey: String(i18n.labelKey || ""),
      detailKey: String(i18n.detailKey || ""),
      labelParams:
        i18n.labelParams && typeof i18n.labelParams === "object" && !Array.isArray(i18n.labelParams)
          ? clonePlain(i18n.labelParams, {})
          : {},
      detailParams:
        i18n.detailParams && typeof i18n.detailParams === "object" && !Array.isArray(i18n.detailParams)
          ? clonePlain(i18n.detailParams, {})
          : {},
      issueCodes: Array.isArray(codes) ? codes.map((code) => String(code || "").trim()).filter(Boolean) : [],
    });
  };

  addStep(
    "write-authority-checkpoint",
    "同步备份 Checkpoint",
    "Authority Blob checkpoint 落后或缺失，应从当前权威图谱源同步一个新的备份 checkpoint。",
    ["blob-checkpoint-missing", "blob-checkpoint-behind", "blob-runtime-revision-drift"],
    {
      labelKey: "authority.repair.syncCheckpoint",
      detailKey: "authority.repair.syncCheckpoint.detail",
    },
  );
  if (!sqlNewerThanBlob) {
    addStep(
      "restore-from-authority-blob-checkpoint",
      "灾难恢复：从 Blob Checkpoint 恢复 SQL",
      "仅在 SQL 缺失、损坏或用户明确需要回滚时，才可用 Blob checkpoint 回灌 Authority SQL。",
      ["sql-runtime-revision-drift", "blob-newer-than-sql", "blob-chat-mismatch"],
      {
        labelKey: "authority.repair.disasterRecovery",
        detailKey: "authority.repair.disasterRecovery.detail",
      },
    );
  }
  addStep(
    "rebuild-authority-trivium",
    "同步向量/Trivium 副本",
    "Trivium 向量副本落后、collection 不匹配，或当前向量索引为 dirty，需要从权威图谱源重建/同步。",
    ["trivium-sql-revision-drift", "trivium-replica-behind", "trivium-collection-mismatch", "vector-dirty"],
    {
      labelKey: "authority.repair.syncTrivium",
      detailKey: "authority.repair.syncTrivium.detail",
    },
  );

  const blockedIssueCodes = (Array.isArray(source.issues) ? source.issues : [])
    .filter((issue) => String(issue?.severity || "") === "error")
    .map((issue) => String(issue?.code || "").trim())
    .filter(Boolean);
  const unsupportedActions = actions.filter(
    (action) => action !== "run-authority-consistency-audit" && !steps.some((step) => step.action === action),
  );
  const detail = steps.length
    ? `建议同步：${steps.map((step) => step.label).join(" → ")}`
    : String(source?.summary?.detail || "当前审计未发现需要自动编排的修复步骤");
  const detailKey = steps.length
    ? "authority.repair.summary.detail"
    : String(source?.summary?.detailKey || "authority.repair.noStepsNeeded");
  const detailParams = steps.length
    ? { steps: steps.map((step) => step.label).join(" → ") }
    : clonePlain(source?.summary?.detailParams, {});

  return {
    ok: steps.length > 0,
    steps,
    stepCount: steps.length,
    requiresConfirmation: steps.some((step) => step.action === "restore-from-authority-blob-checkpoint"),
    blockedIssueCodes,
    unsupportedActions,
    summary: {
      level: steps.length > 0 ? "warning" : String(source?.summary?.level || "idle"),
      label: steps.length > 0 ? `建议同步副本 ${steps.length} 步` : "当前无需编排修复",
      labelKey: steps.length > 0 ? "authority.repair.summaryLabel" : "authority.repair.none",
      labelParams: { count: steps.length },
      detail,
      detailKey,
      detailParams,
    },
  };
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
    sqlNewerThanBlob:
      Number.isFinite(sql.revision) && Number.isFinite(blob.revision) && sql.revision > blob.revision,
    blobNewerThanSql:
      Number.isFinite(sql.revision) && Number.isFinite(blob.revision) && blob.revision > sql.revision,
    sqlNewerThanTrivium:
      Number.isFinite(sql.revision) && Number.isFinite(trivium.revision) && sql.revision > trivium.revision,
    collectionMatchesRuntime:
      !trivium.namespace || !runtime.collectionId || trivium.namespace === runtime.collectionId,
    checkpointRestorable:
      blob.exists &&
      blob.hasSerializedGraph &&
      (!blob.chatId || !chatId || blob.chatId === chatId) &&
      !(
        Number.isFinite(sql.revision) &&
        Number.isFinite(blob.revision) &&
        sql.revision > blob.revision
      ),
  };

  const issues = [];
  if (sql.error) {
    issues.push(normalizeIssue("error", "sql-probe-error", `Authority SQL 探针失败：${sql.error}`, {
      messageKey: "authority.audit.sqlProbeFailed",
      messageParams: { error: sql.error },
    }));
  }
  if (blob.error) {
    issues.push(normalizeIssue("warning", "blob-probe-error", `Authority Blob 读取失败：${blob.error}`, {
      messageKey: "authority.audit.blobReadFailed",
      messageParams: { error: blob.error },
    }));
  }
  if (trivium.error) {
    issues.push(normalizeIssue("warning", "trivium-probe-error", `Authority Trivium 探针失败：${trivium.error}`, {
      messageKey: "authority.audit.triviumProbeFailed",
      messageParams: { error: trivium.error },
    }));
  }
  if (blob.exists && blob.chatId && chatId && blob.chatId !== chatId) {
    issues.push(normalizeIssue("error", "blob-chat-mismatch", `Checkpoint chatId 不匹配：${blob.chatId} ≠ ${chatId}`, {
      messageKey: "authority.audit.chatIdMismatch",
      messageParams: { blobChatId: blob.chatId, chatId },
    }));
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
        {
          messageKey: "authority.audit.sqlRuntimeDrift",
          messageParams: { sqlRevision: sql.revision, runtimeRevision: runtime.revision },
        },
      ),
    );
  }
  if (
    Number.isFinite(blob.revision) &&
    Number.isFinite(runtime.revision) &&
    blob.revision !== runtime.revision
  ) {
    const code = Number.isFinite(sql.revision) && blob.revision < sql.revision
      ? "blob-checkpoint-behind"
      : "blob-runtime-revision-drift";
    issues.push(
      normalizeIssue(
        "warning",
        code,
        code === "blob-checkpoint-behind"
          ? `Blob checkpoint 落后于 Authority SQL：${blob.revision} < ${sql.revision}`
          : `Blob checkpoint revision 与 runtime 不一致：${blob.revision} ≠ ${runtime.revision}`,
        code === "blob-checkpoint-behind"
          ? {
              messageKey: "authority.audit.blobBehindSql",
              messageParams: { blobRevision: blob.revision, sqlRevision: sql.revision },
            }
          : {
              messageKey: "authority.audit.blobRuntimeDrift",
              messageParams: { blobRevision: blob.revision, runtimeRevision: runtime.revision },
            },
      ),
    );
  }
  if (
    Number.isFinite(trivium.revision) &&
    Number.isFinite(sql.revision) &&
    trivium.revision !== sql.revision
  ) {
    const code = trivium.revision < sql.revision
      ? "trivium-replica-behind"
      : "trivium-sql-revision-drift";
    issues.push(
      normalizeIssue(
        "warning",
        code,
        code === "trivium-replica-behind"
          ? `Trivium 向量副本落后于 Authority SQL：${trivium.revision} < ${sql.revision}`
          : `Trivium revision 与 SQL 不一致：${trivium.revision} ≠ ${sql.revision}`,
        code === "trivium-replica-behind"
          ? {
              messageKey: "authority.audit.triviumBehindSql",
              messageParams: { triviumRevision: trivium.revision, sqlRevision: sql.revision },
            }
          : {
              messageKey: "authority.audit.triviumSqlDrift",
              messageParams: { triviumRevision: trivium.revision, sqlRevision: sql.revision },
            },
      ),
    );
  }
  if (!drift.collectionMatchesRuntime) {
    issues.push(
      normalizeIssue(
        "warning",
        "trivium-collection-mismatch",
        `Trivium collection/namespace 与 runtime 不一致：${trivium.namespace} ≠ ${runtime.collectionId}`,
        {
          messageKey: "authority.audit.collectionMismatch",
          messageParams: { triviumNamespace: trivium.namespace, runtimeCollectionId: runtime.collectionId },
        },
      ),
    );
  }
  if (runtime.vectorDirty) {
    issues.push(normalizeIssue("warning", "vector-dirty", "当前向量索引仍处于 dirty 状态", {
      messageKey: "authority.audit.vectorDirty",
    }));
  }
  if (!blob.exists && source.capability?.blobReady) {
    issues.push(normalizeIssue("warning", "blob-checkpoint-missing", "Authority Blob 尚无可用 checkpoint", {
      messageKey: "authority.audit.blobCheckpointMissing",
    }));
  }

  const actions = [];
  const restoreRelevant =
    drift.checkpointRestorable &&
    (
      sql.ok !== true ||
      drift.blobNewerThanSql ||
      issues.some((issue) => issue.code === "sql-probe-error")
    );
  if (restoreRelevant) actions.push("restore-from-authority-blob-checkpoint");
  if (runtime.vectorDirty || (Number.isFinite(drift.triviumVsSqlRevision) && drift.triviumVsSqlRevision < 0)) {
    actions.push("rebuild-authority-trivium");
  }
  if ((!blob.exists || drift.sqlNewerThanBlob) && source.capability?.blobReady) {
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
        ? sql.ok
          ? "副本待同步"
          : "存在待处理漂移"
        : level === "success"
          ? "Authority 工件已对齐"
          : "等待审计";
  const labelKey =
    level === "error"
      ? "authority.summary.blockingInconsistency"
      : level === "warning"
        ? sql.ok
          ? "authority.summary.replicasPendingSync"
          : "authority.summary.driftPending"
        : level === "success"
          ? "authority.summary.aligned"
          : "authority.summary.waitingForAudit";
  const detail = issues[0]?.message || (level === "success"
    ? "Authority SQL / Trivium / Blob 已达到当前可观测的一致状态"
    : "尚未运行审计");
  const detailKey = issues[0]?.messageKey || (level === "success"
    ? "authority.summary.alignedDetail"
    : "authority.summary.notYetAudited");
  const detailParams = issues[0]?.messageParams || {};
  const backupLag = issues.some((issue) => [
    "blob-checkpoint-missing",
    "blob-checkpoint-behind",
  ].includes(issue.code));
  const searchLag = issues.some((issue) => [
    "trivium-replica-behind",
    "vector-dirty",
  ].includes(issue.code));
  const runtimeAheadOfSql =
    Number.isFinite(runtime.revision) &&
    Number.isFinite(sql.revision) &&
    runtime.revision > sql.revision;
  const dataSafety = sql.ok
    ? runtimeAheadOfSql
      ? "runtime-ahead-of-sql"
      : (backupLag || searchLag)
        ? "saved-replicas-behind"
        : "saved"
    : (sql.available ? "unknown" : "unavailable");

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
      labelKey,
      labelParams: {},
      detail,
      detailKey,
      detailParams,
      issueCount: issues.length,
      dataSafety,
      backupRedundancy: backupLag ? "degraded" : (blob.exists ? "ok" : "unknown"),
      searchQuality: searchLag || drift.sqlNewerThanTrivium ? "degraded" : "ok",
    },
  };
}
