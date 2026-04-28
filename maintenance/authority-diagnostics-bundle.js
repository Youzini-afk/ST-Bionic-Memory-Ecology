function safeClone(value, fallback = null) {
  if (value == null) return fallback;
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback ?? value;
  }
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function truncateText(value, maxLength = 4000) {
  const text = String(value ?? "");
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function buildHash(input = "") {
  let hash = 2166136261;
  const text = String(input ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildSafeSlug(input = "", fallback = "unknown") {
  const normalized = String(input || fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function buildCompactTimestamp(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function isSensitiveKey(key = "") {
  return /(api[_-]?key|token|secret|password|authorization|auth[_-]?header|cookie)/i.test(
    String(key || ""),
  );
}

function sanitizeValue(value, key = "", depth = 0) {
  if (depth > 8) {
    return "[Truncated]";
  }
  if (value == null) return value;
  if (isSensitiveKey(key)) {
    return String(value || "") ? "[REDACTED]" : "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, "", depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return value;
}

function buildGraphSummary(graph = null) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const activeNodes = nodes.filter((node) => !node?.archived);
  const archivedNodes = nodes.filter((node) => node?.archived);
  const typeCounts = {};
  for (const node of activeNodes) {
    const type = String(node?.type || "unknown");
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  return {
    nodeCount: nodes.length,
    activeNodeCount: activeNodes.length,
    archivedNodeCount: archivedNodes.length,
    edgeCount: edges.length,
    typeCounts,
    historyState: safeClone(
      {
        chatId: graph?.historyState?.chatId || "",
        extractionCount: Number(graph?.historyState?.extractionCount || 0),
        lastProcessedAssistantFloor: Number(
          graph?.historyState?.lastProcessedAssistantFloor ?? -1,
        ),
        activeRegion: String(graph?.historyState?.activeRegion || ""),
        activeStorySegmentId: String(
          graph?.historyState?.activeStorySegmentId || "",
        ),
        activeStoryTimeLabel: String(
          graph?.historyState?.activeStoryTimeLabel || "",
        ),
        activeRecallOwnerKey: String(
          graph?.historyState?.activeRecallOwnerKey || "",
        ),
        activeRecallOwnerKeys: Array.isArray(
          graph?.historyState?.activeRecallOwnerKeys,
        )
          ? graph.historyState.activeRecallOwnerKeys.map((value) => String(value || ""))
          : [],
        lastRecoveryResult: graph?.historyState?.lastRecoveryResult || null,
      },
      null,
    ),
    vectorIndexState: safeClone(
      {
        mode: String(graph?.vectorIndexState?.mode || ""),
        source: String(graph?.vectorIndexState?.source || ""),
        dirty: Boolean(graph?.vectorIndexState?.dirty),
        dirtyReason: String(graph?.vectorIndexState?.dirtyReason || ""),
        lastWarning: String(graph?.vectorIndexState?.lastWarning || ""),
        collectionId: String(graph?.vectorIndexState?.collectionId || ""),
        indexedCount: Number(
          Object.keys(graph?.vectorIndexState?.hashToNodeId || {}).length || 0,
        ),
      },
      null,
    ),
    summaryState: safeClone(
      {
        enabled: graph?.summaryState?.enabled !== false,
        lastSummarizedExtractionCount: Number(
          graph?.summaryState?.lastSummarizedExtractionCount || 0,
        ),
        lastSummarizedAssistantFloor: Number(
          graph?.summaryState?.lastSummarizedAssistantFloor ?? -1,
        ),
      },
      null,
    ),
  };
}

function buildStatusSnapshot(status = null) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return null;
  }
  return safeClone(
    {
      text: String(status.text || ""),
      meta: truncateText(status.meta || "", 2000),
      level: String(status.level || "idle"),
      updatedAt: Number(status.updatedAt || 0),
    },
    null,
  );
}

export function buildAuthorityPerformanceBaseline({
  chatId = "",
  graphPersistence = null,
  graph = null,
  consistencyAudit = null,
} = {}) {
  const persistence =
    graphPersistence && typeof graphPersistence === "object" && !Array.isArray(graphPersistence)
      ? graphPersistence
      : {};
  const runtimeGraph = graph && typeof graph === "object" && !Array.isArray(graph) ? graph : {};
  const audit =
    consistencyAudit && typeof consistencyAudit === "object" && !Array.isArray(consistencyAudit)
      ? consistencyAudit
      : persistence.authorityConsistencyAudit &&
          typeof persistence.authorityConsistencyAudit === "object" &&
          !Array.isArray(persistence.authorityConsistencyAudit)
        ? persistence.authorityConsistencyAudit
        : null;
  const loadDiagnostics =
    persistence.loadDiagnostics && typeof persistence.loadDiagnostics === "object"
      ? persistence.loadDiagnostics
      : {};
  const persistDelta =
    persistence.persistDelta && typeof persistence.persistDelta === "object"
      ? persistence.persistDelta
      : {};
  const recentJobs = Array.isArray(persistence.authorityRecentJobs)
    ? persistence.authorityRecentJobs
    : [];
  const failedJobs = recentJobs.filter((job) => {
    const queueState = String(job?.queueState || "").trim();
    return queueState === "failed" || queueState === "error";
  });
  const runningJobs = recentJobs.filter(
    (job) => String(job?.queueState || "").trim() === "running",
  );
  const graphRevision = Number(
    runtimeGraph?.meta?.revision || persistence.revision || 0,
  );
  return {
    kind: "authority-performance-baseline",
    capturedAt: new Date().toISOString(),
    chatId: normalizeRecordId(chatId || persistence.chatId || runtimeGraph?.chatId),
    graphRevision: Number.isFinite(graphRevision) ? graphRevision : 0,
    graphNodeCount: Array.isArray(runtimeGraph?.nodes) ? runtimeGraph.nodes.length : 0,
    graphEdgeCount: Array.isArray(runtimeGraph?.edges) ? runtimeGraph.edges.length : 0,
    extractionCount: Number(runtimeGraph?.historyState?.extractionCount || 0),
    load: safeClone(
      {
        state: String(persistence.loadState || ""),
        source: String(loadDiagnostics.source || ""),
        totalMs: Number(loadDiagnostics.totalMs || 0),
        preApplyMs: Number(loadDiagnostics.preApplyMs || 0),
        exportSnapshotMs: Number(loadDiagnostics.exportSnapshotMs || 0),
        hydrateMs: Number(loadDiagnostics.hydrateMs || 0),
        hydrateNativeRecordsMs: Number(loadDiagnostics.hydrateNativeRecordsMs || 0),
        applyRuntimeMs: Number(loadDiagnostics.applyRuntimeMs || 0),
        updatedAt: String(loadDiagnostics.updatedAt || ""),
      },
      null,
    ),
    persist: safeClone(
      {
        totalMs: Number(persistDelta.totalMs || persistDelta.buildMs || 0),
        buildMs: Number(persistDelta.buildMs || 0),
        baseSnapshotReadMs: Number(persistDelta.baseSnapshotReadMs || 0),
        snapshotBuildMs: Number(persistDelta.snapshotBuildMs || 0),
        prepareMs: Number(persistDelta.prepareMs || 0),
        nativeAttemptMs: Number(persistDelta.nativeAttemptMs || 0),
        lookupMs: Number(persistDelta.lookupMs || 0),
        jsDiffMs: Number(persistDelta.jsDiffMs || 0),
        hydrateMs: Number(persistDelta.hydrateMs || 0),
        commitQueueWaitMs: Number(persistDelta.commitQueueWaitMs || 0),
        commitMs: Number(persistDelta.commitMs || 0),
        commitPayloadBytes: Number(persistDelta.commitPayloadBytes || 0),
        commitWalBytes: Number(persistDelta.commitWalBytes || 0),
        updatedAt: String(persistDelta.updatedAt || ""),
      },
      null,
    ),
    soak: {
      recentJobCount: recentJobs.length,
      runningJobCount: runningJobs.length,
      failedJobCount: failedJobs.length,
      lastJobId: String(persistence.authorityLastJobId || ""),
      lastJobStatus: String(persistence.authorityLastJobStatus || ""),
      lastJobUpdatedAt: String(persistence.authorityLastJobUpdatedAt || ""),
    },
    audit: safeClone(
      {
        state: String(persistence.authorityConsistencyState || audit?.summary?.level || "idle"),
        issueCount: Array.isArray(audit?.issues) ? audit.issues.length : 0,
        sqlRevision: Number(audit?.sql?.revision || 0),
        triviumRevision: Number(audit?.trivium?.revision || 0),
        blobRevision: Number(
          audit?.blob?.revision || persistence.authorityBlobCheckpointRevision || 0,
        ),
      },
      null,
    ),
    artifacts: safeClone(
      {
        diagnosticsBundlePath: String(persistence.authorityDiagnosticsBundlePath || ""),
        diagnosticsBundleReason: String(persistence.authorityDiagnosticsBundleReason || ""),
        diagnosticsBundleUpdatedAt: String(
          persistence.authorityDiagnosticsBundleUpdatedAt || "",
        ),
        diagnosticsBundleSize: Number(persistence.authorityDiagnosticsBundleSize || 0),
        blobCheckpointPath: String(persistence.authorityBlobCheckpointPath || ""),
        blobCheckpointRevision: Number(persistence.authorityBlobCheckpointRevision || 0),
        blobCheckpointUpdatedAt: String(
          persistence.authorityBlobCheckpointUpdatedAt || "",
        ),
      },
      null,
    ),
  };
}

export function sanitizeDiagnosticsSettings(settings = {}) {
  return sanitizeValue(settings, "settings", 0);
}

export function buildAuthorityDiagnosticsBundlePath(chatId = "", reason = "diagnostics") {
  const normalizedChatId = normalizeRecordId(chatId);
  const safeChatId = buildSafeSlug(normalizedChatId || "global");
  const safeReason = buildSafeSlug(reason || "diagnostics", "diagnostics");
  const hash = buildHash(`${normalizedChatId}:${safeReason}`);
  const timestamp = buildCompactTimestamp(new Date());
  return `user/files/ST-BME_diagnostics_${safeChatId}-${safeReason}-${hash}-${timestamp}.json`;
}

export function buildAuthorityDiagnosticsBundle({
  chatId = "",
  reason = "diagnostics-bundle",
  settings = {},
  runtimeStatus = null,
  runtimeDebug = null,
  graphPersistence = null,
  graph = null,
  lastExtractionStatus = null,
  lastVectorStatus = null,
  lastRecallStatus = null,
  lastBatchStatus = null,
  lastInjection = "",
  lastExtract = [],
  lastRecall = [],
  performanceBaseline = null,
} = {}) {
  const createdAt = new Date().toISOString();
  return {
    kind: "st-bme-authority-diagnostics",
    bundleVersion: 1,
    createdAt,
    chatId: normalizeRecordId(chatId),
    reason: String(reason || "diagnostics-bundle"),
    settings: sanitizeDiagnosticsSettings(settings || {}),
    runtimeStatus: buildStatusSnapshot(runtimeStatus),
    runtimeDebug: safeClone(runtimeDebug, null),
    graphPersistence: safeClone(graphPersistence, null),
    graphSummary: buildGraphSummary(graph),
    performanceBaseline: safeClone(performanceBaseline, null),
    lastStatuses: {
      extraction: buildStatusSnapshot(lastExtractionStatus),
      vector: buildStatusSnapshot(lastVectorStatus),
      recall: buildStatusSnapshot(lastRecallStatus),
      batch: safeClone(lastBatchStatus, null),
    },
    lastInjection: {
      textPreview: truncateText(lastInjection, 4000),
      textLength: String(lastInjection || "").length,
    },
    recentExtractedItems: safeClone(
      (Array.isArray(lastExtract) ? lastExtract : []).slice(0, 20),
      [],
    ),
    recentRecalledItems: safeClone(
      (Array.isArray(lastRecall) ? lastRecall : []).slice(0, 20),
      [],
    ),
  };
}

export async function writeAuthorityDiagnosticsBundle(adapter, bundle = null, options = {}) {
  if (!adapter || typeof adapter.writeJson !== "function") {
    throw new Error("Authority diagnostics adapter unavailable");
  }
  const chatId = normalizeRecordId(options.chatId || bundle?.chatId);
  const reason = String(options.reason || bundle?.reason || "diagnostics-bundle");
  const path =
    options.path || buildAuthorityDiagnosticsBundlePath(chatId, reason);
  const result = await adapter.writeJson(path, safeClone(bundle, bundle), {
    signal: options.signal,
    metadata: safeClone(
      {
        chatId,
        reason,
        kind: "diagnostics-bundle",
        bundleVersion: Number(bundle?.bundleVersion || 1),
        createdAt: bundle?.createdAt || new Date().toISOString(),
      },
      {},
    ),
  });
  return {
    ok: result?.ok !== false,
    path: String(result?.path || path),
    result,
  };
}
