// ST-BME: UI 状态工厂、纯工具函数
// 此模块中的函数均不依赖 index.js 模块级可变状态，
// 可被 index.js 及其他模块安全导入。
import { sanitizePlannerMessageText } from "../runtime/planner-tag-utils.js";

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

export const BATCH_STAGE_ORDER = ["core", "structural", "semantic", "finalize"];
export const BATCH_STAGE_SEVERITY = {
  success: 0,
  partial: 1,
  failed: 2,
};

// ═══════════════════════════════════════════════════════════
// UI 状态工厂
// ═══════════════════════════════════════════════════════════

export function createUiStatus(text = "待命", meta = "", level = "idle") {
  return {
    text: String(text || "待命"),
    meta: String(meta || ""),
    level,
    updatedAt: Date.now(),
  };
}

export function createGraphPersistenceState() {
  return {
    loadState: "no-chat",
    chatId: "",
    reason: "当前尚未进入聊天",
    attemptIndex: 0,
    revision: 0,
    lastPersistedRevision: 0,
    queuedPersistRevision: 0,
    queuedPersistChatId: "",
    queuedPersistMode: "",
    queuedPersistRotateIntegrity: false,
    queuedPersistReason: "",
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    lastPersistReason: "",
    lastPersistMode: "",
    metadataIntegrity: "",
    writesBlocked: false,
    pendingPersist: false,
    lastAcceptedRevision: 0,
    acceptedStorageTier: "none",
    hostProfile: "generic-st",
    primaryStorageTier: "indexeddb",
    cacheStorageTier: "none",
    cacheMirrorState: "idle",
    persistDiagnosticTier: "none",
    acceptedBy: "none",
    lastRecoverableStorageTier: "none",
    persistMismatchReason: "",
    commitMarker: null,
    restoreLock: {
      active: false,
      depth: 0,
      source: "",
      reason: "",
      startedAt: 0,
    },
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    opfsWriteLockState: {
      active: false,
      queueDepth: 0,
      lastReason: "",
      updatedAt: 0,
    },
    dbReady: false,
    indexedDbRevision: 0,
    indexedDbLastError: "",
    syncState: "idle",
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastBackupUploadedAt: 0,
    lastBackupRestoredAt: 0,
    lastBackupRollbackAt: 0,
    lastBackupFilename: "",
    syncDirty: false,
    syncDirtyReason: "",
    lastSyncError: "",
    dualWriteLastResult: null,
    persistDelta: null,
    updatedAt: new Date().toISOString(),
  };
}

export function createRecallInputRecord(overrides = {}) {
  return {
    text: "",
    hash: "",
    messageId: null,
    source: "",
    at: 0,
    ...overrides,
  };
}

export function createRecallRunResult(status = "completed", extra = {}) {
  const normalizedStatus = String(status || "skipped").trim() || "skipped";
  return {
    ok: normalizedStatus === "completed",
    didRecall: normalizedStatus === "completed",
    status: normalizedStatus,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════
// 批次状态
// ═══════════════════════════════════════════════════════════

export function createBatchStageStatus(stage, consistency = "strong") {
  return {
    stage,
    outcome: "success",
    consistency,
    warnings: [],
    errors: [],
    artifacts: [],
  };
}

/**
 * @param {object} opts
 * @param {number[]} opts.processedRange
 * @param {number}   opts.extractionCountBefore
 * @param {number}   [opts.extractionCountAfter] — 如未提供，fallback 为 extractionCountBefore
 */
export function createBatchStatusSkeleton({
  processedRange,
  extractionCountBefore,
  extractionCountAfter,
}) {
  const countBefore = Number.isFinite(extractionCountBefore)
    ? extractionCountBefore
    : 0;
  const countAfter = Number.isFinite(extractionCountAfter)
    ? extractionCountAfter
    : countBefore;
  return {
    model: "layered-batch-v1",
    processedRange: Array.isArray(processedRange)
      ? [...processedRange]
      : [-1, -1],
    extractionCountBefore: countBefore,
    extractionCountAfter: countAfter,
    stages: {
      core: createBatchStageStatus("core", "strong"),
      structural: createBatchStageStatus("structural", "weak"),
      semantic: createBatchStageStatus("semantic", "weak"),
      finalize: createBatchStageStatus("finalize", "strong"),
    },
    outcome: "success",
    consistency: "strong",
    completed: false,
    persistence: null,
    historyAdvanceAllowed: false,
    warnings: [],
    errors: [],
  };
}

export function setBatchStageOutcome(status, stage, outcome, message = "") {
  const stageStatus = status?.stages?.[stage];
  if (!stageStatus) return;
  const nextSeverity = BATCH_STAGE_SEVERITY[outcome] ?? 0;
  const previousSeverity = BATCH_STAGE_SEVERITY[stageStatus.outcome] ?? 0;
  if (nextSeverity >= previousSeverity) {
    stageStatus.outcome = outcome;
  }
  if (!message) return;
  if (outcome === "failed") {
    stageStatus.errors.push(message);
  } else if (outcome === "partial") {
    stageStatus.warnings.push(message);
  }
}

export function pushBatchStageArtifact(status, stage, artifact) {
  const stageStatus = status?.stages?.[stage];
  if (!stageStatus || !artifact) return;
  if (!stageStatus.artifacts.includes(artifact)) {
    stageStatus.artifacts.push(artifact);
  }
}

/**
 * @param {object} status
 * @param {number} [currentExtractionCount] — 传入调用方的 extractionCount
 */
export function finalizeBatchStatus(status, currentExtractionCount) {
  const stages = status?.stages || {};
  const structuralOutcome = stages.structural?.outcome || "success";
  const semanticOutcome = stages.semantic?.outcome || "success";
  const finalizeOutcome = stages.finalize?.outcome || "failed";
  const outcomeList = BATCH_STAGE_ORDER.map(
    (stage) => stages[stage]?.outcome || "success",
  );

  if (finalizeOutcome !== "success") {
    status.outcome = "failed";
  } else if (outcomeList.includes("failed")) {
    status.outcome = "failed";
  } else if (structuralOutcome === "partial" || semanticOutcome === "partial") {
    status.outcome = "partial";
  } else {
    status.outcome = "success";
  }

  status.consistency =
    finalizeOutcome === "success" &&
    stages.core?.outcome === "success" &&
    stages.structural?.outcome === "success"
      ? "strong"
      : "weak";
  status.completed = finalizeOutcome === "success";
  if (Number.isFinite(currentExtractionCount)) {
    status.extractionCountAfter = currentExtractionCount;
  }
  status.warnings = BATCH_STAGE_ORDER.flatMap(
    (stage) => stages[stage]?.warnings || [],
  );
  status.errors = BATCH_STAGE_ORDER.flatMap(
    (stage) => stages[stage]?.errors || [],
  );
  return status;
}

// ═══════════════════════════════════════════════════════════
// 纯映射 / 纯变换
// ═══════════════════════════════════════════════════════════

export function normalizeStageNoticeLevel(level = "info") {
  if (level === "running" || level === "idle") return "info";
  if (level === "success" || level === "warning" || level === "error") {
    return level;
  }
  return "info";
}

export function getStageNoticeTitle(stage) {
  switch (stage) {
    case "extraction":
      return "ST-BME 提取";
    case "vector":
      return "ST-BME 向量";
    case "recall":
      return "ST-BME 召回";
    case "history":
      return "ST-BME 历史恢复";
    default:
      return "ST-BME";
  }
}

export function getStageNoticeDuration(level = "info") {
  switch (level) {
    case "error":
      return 6000;
    case "warning":
      return 5000;
    case "success":
      return 3000;
    default:
      return 3200;
  }
}

export function getRecallHookLabel(hookName = "") {
  switch (hookName) {
    case "GENERATION_AFTER_COMMANDS":
      return "hook GENERATION_AFTER_COMMANDS";
    case "GENERATE_BEFORE_COMBINE_PROMPTS":
      return "hook GENERATE_BEFORE_COMBINE_PROMPTS";
    default:
      return "";
  }
}

export function getGenerationRecallHookStateFromResult(result) {
  const status = String(result?.status || "").trim();
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
    case "superseded":
      return "aborted";
    default:
      return "skipped";
  }
}

export function isTerminalGenerationRecallHookState(state = "") {
  return ["completed", "failed", "aborted", "skipped"].includes(
    String(state || ""),
  );
}

export function shouldRunRecallForTransaction(transaction, hookName) {
  if (!hookName) return true;
  if (!transaction) return true;

  const hookStates = transaction.hookStates || {};
  const currentHookState = hookStates[hookName];
  if (
    currentHookState === "running" ||
    isTerminalGenerationRecallHookState(currentHookState)
  ) {
    return false;
  }

  const peerHookName =
    hookName === "GENERATION_AFTER_COMMANDS"
      ? "GENERATE_BEFORE_COMBINE_PROMPTS"
      : hookName === "GENERATE_BEFORE_COMBINE_PROMPTS"
        ? "GENERATION_AFTER_COMMANDS"
        : "";

  if (!peerHookName) return true;

  const peerHookState = hookStates[peerHookName];
  if (
    peerHookState === "running" ||
    isTerminalGenerationRecallHookState(peerHookState)
  ) {
    return false;
  }

  return true;
}

export function formatRecallContextLine(message) {
  return `[${message.is_user ? "user" : "assistant"}]: ${sanitizePlannerMessageText(message)}`;
}

// ═══════════════════════════════════════════════════════════
// 文本 / 数值 工具
// ═══════════════════════════════════════════════════════════

export function normalizeRecallInputText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function isTrivialUserInput(text) {
  const normalizedText = normalizeRecallInputText(text);
  if (!normalizedText) {
    return {
      trivial: true,
      reason: "empty",
      normalizedText,
    };
  }

  if (normalizedText.startsWith("/")) {
    return {
      trivial: true,
      reason: "slash-command",
      normalizedText,
    };
  }

  return {
    trivial: false,
    reason: "",
    normalizedText,
  };
}

export function hashRecallInput(text) {
  let hash = 0;
  const normalized = normalizeRecallInputText(text);
  for (let index = 0; index < normalized.length; index++) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return normalized ? String(hash) : "";
}

export function isFreshRecallInputRecord(record, ttlMs = 60000) {
  return Boolean(
    record?.text &&
    record.at &&
    Date.now() - record.at <= ttlMs,
  );
}

export function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function clampFloat(value, fallback, min = 0, max = 1) {
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}
