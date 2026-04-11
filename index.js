// ST-BME: 主入�?
// 事件钩子、设置管理、流程调�?

import {
  eventSource,
  event_types,
  extension_prompt_roles,
  extension_prompt_types,
  getRequestHeaders,
  saveMetadata,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "../../../extensions.js";

import { BmeChatManager } from "./sync/bme-chat-manager.js";
import {
  BmeDatabase,
  buildBmeDbName,
  buildPersistDelta,
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
  ensureDexieLoaded,
} from "./sync/bme-db.js";
import {
  autoSyncOnChatChange,
  autoSyncOnVisibility,
  backupToServer,
  buildRestoreSafetyChatId,
  deleteRemoteSyncFile,
  deleteServerBackup,
  getRestoreSafetySnapshotStatus,
  listServerBackups,
  rollbackFromRestoreSafetySnapshot,
  restoreFromServer,
  scheduleUpload,
  syncNow,
} from "./sync/bme-sync.js";
import {
  buildExtractionMessages,
  clampRecoveryStartFloor,
  getAssistantTurns,
  isAssistantChatMessage,
  isSystemMessageForExtraction,
  pruneProcessedMessageHashesFromFloor,
  resolveDirtyFloorFromMutationMeta,
  rollbackAffectedJournals,
} from "./maintenance/chat-history.js";
import {
  compressAll,
  inspectAutoCompressionCandidates,
  sleepCycle,
} from "./maintenance/compressor.js";
import {
  analyzeAutoConsolidationGate,
  consolidateMemories,
} from "./maintenance/consolidator.js";
import {
  installSendIntentHooksController,
  onBeforeCombinePromptsController,
  onCharacterMessageRenderedController,
  onChatChangedController,
  onChatLoadedController,
  onGenerationAfterCommandsController,
  onGenerationStartedController,
  onMessageDeletedController,
  onMessageEditedController,
  onMessageReceivedController,
  onMessageSentController,
  onMessageSwipedController,
  onUserMessageRenderedController,
  registerBeforeCombinePromptsController,
  registerCoreEventHooksController,
  registerGenerationAfterCommandsController,
  scheduleSendIntentHookRetryController,
} from "./host/event-binding.js";
import {
  executeExtractionBatchController,
  onExtractionTaskController,
  onManualExtractController,
  onRerollController,
  resolveAutoExtractionPlanController,
  runExtractionController,
} from "./maintenance/extraction-controller.js";
import {
  DEFAULT_TRIGGER_KEYWORDS,
  getSmartTriggerDecision,
} from "./maintenance/smart-trigger.js";
import {
  debugDebug,
  debugLog,
} from "./runtime/debug-logging.js";
import {
  extractMemories,
  generateReflection,
} from "./maintenance/extractor.js";
import {
  generateSmallSummary,
  rebuildHierarchicalSummaryState,
  resetHierarchicalSummaryState,
  rollupSummaryFrontier,
  runHierarchicalSummaryPostProcess,
} from "./maintenance/hierarchical-summary.js";
import {
  buildGraphCommitMarker,
  canUseGraphChatState,
  detectIndexedDbSnapshotCommitMarkerMismatch,
  findGraphShadowSnapshotByIntegrity,
  getAcceptedCommitMarkerRevision,
  GRAPH_CHAT_STATE_NAMESPACE,
  GRAPH_LOAD_PENDING_CHAT_ID,
  GRAPH_LOAD_STATES,
  GRAPH_COMMIT_MARKER_KEY,
  GRAPH_METADATA_KEY,
  GRAPH_STARTUP_RECONCILE_DELAYS_MS,
  MODULE_NAME,
  cloneGraphForPersistence,
  cloneRuntimeDebugValue,
  getGraphPersistedRevision,
  getGraphPersistenceMeta,
  getGraphIdentityAliasCandidates,
  readGraphShadowSnapshot,
  removeGraphShadowSnapshot,
  rememberGraphIdentityAlias,
  readGraphCommitMarker,
  readGraphChatStateSnapshot,
  resolveGraphIdentityAliasByHostChatId,
  shouldPreferShadowSnapshotOverOfficial,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphChatStateSnapshot,
  writeGraphShadowSnapshot,
} from "./graph/graph-persistence.js";
import {
  applyHideSettings,
  getHideStateSnapshot,
  resetHideState,
  runIncrementalHideCheck,
  scheduleHideSettingsApply,
  unhideAll,
} from "./ui/hide-engine.js";
import {
  createEmptyGraph,
  deserializeGraph,
  exportGraph,
  getGraphStats,
  getNode,
  importGraph,
  removeNode,
  updateNode,
} from "./graph/graph.js";
import {
  HOST_ADAPTER_STATE_SEMANTICS,
  getHostAdapter,
  getHostCapabilitySnapshot,
  initializeHostAdapter,
  readHostCapability,
  refreshHostCapabilitySnapshot,
} from "./host/adapter/index.js";
import { estimateTokens, formatInjection } from "./retrieval/injector.js";
import { fetchMemoryLLMModels, testLLMConnection } from "./llm/llm.js";
import { getNodeDisplayName } from "./graph/node-labels.js";
import { showManagedBmeNotice } from "./ui/notice.js";
import {
  createNoticePanelActionController,
  initializePanelBridgeController,
  refreshPanelLiveStateController,
} from "./ui/panel-bridge.js";
import {
  migrateLegacyTaskProfiles,
  migratePerTaskRegexToGlobal,
} from "./prompting/prompt-profiles.js";
import { inspectTaskRegexReuse } from "./prompting/task-regex.js";
import {
  applyRecallInjectionController,
  buildRecallRecentMessagesController,
  getRecallUserMessageSourceLabelController,
  resolveRecallInputController,
  runRecallController,
} from "./retrieval/recall-controller.js";
import {
  createRecallCardElement,
  openRecallSidebar,
  updateRecallCardData,
} from "./ui/recall-message-ui.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  markPersistedRecallManualEdit,
  readPersistedRecallFromUserMessage,
  removePersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  resolveGenerationTargetUserMessageIndex,
  writePersistedRecallToUserMessage,
} from "./retrieval/recall-persistence.js";
import { resolveConfiguredTimeoutMs } from "./runtime/request-timeout.js";
import {
  defaultSettings,
  getPersistedSettingsSnapshot,
  mergePersistedSettings,
} from "./runtime/settings-defaults.js";
import { retrieve } from "./retrieval/retriever.js";
import {
  applyProcessedHistorySnapshotToGraph,
  appendBatchJournal,
  appendMaintenanceJournal,
  buildRecoveryResult,
  buildReverseJournalRecoveryPlan,
  clearHistoryDirty,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  createMaintenanceJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
  markHistoryDirty,
  normalizeGraphRuntimeState,
  PROCESSED_MESSAGE_HASH_VERSION,
  rebindProcessedHistoryStateToChat,
  snapshotProcessedMessageHashes,
  undoLatestMaintenance,
} from "./runtime/runtime-state.js";
import { DEFAULT_NODE_SCHEMA, validateSchema } from "./graph/schema.js";
import {
  applyManualKnowledgeOverride,
  clearManualKnowledgeOverride,
  setManualActiveRegion,
  updateRegionAdjacencyManual,
} from "./graph/knowledge-state.js";
import {
  clearManualActiveStorySegment,
  setManualActiveStorySegment,
} from "./graph/story-timeline.js";
import {
  onExportGraphController,
  onFetchEmbeddingModelsController,
  onFetchMemoryLLMModelsController,
  onImportGraphController,
  onManualCompressController,
  onManualEvolveController,
  onManualSummaryRollupController,
  onManualSleepController,
  onManualSynopsisController,
  onRebuildSummaryStateController,
  onClearSummaryStateController,
  onUndoLastMaintenanceController,
  onRebuildController,
  onRebuildVectorIndexController,
  onReembedDirectController,
  onTestEmbeddingController,
  onTestMemoryLLMController,
  onViewGraphController,
  onViewLastInjectionController,
  onClearGraphController,
  onClearGraphRangeController,
  onClearVectorCacheController,
  onClearBatchJournalController,
  onDeleteCurrentIdbController,
  onDeleteAllIdbController,
  onDeleteServerSyncFileController,
} from "./ui/ui-actions-controller.js";
import {
  clampInt,
  createBatchStatusSkeleton,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  finalizeBatchStatus,
  formatRecallContextLine,
  getGenerationRecallHookStateFromResult,
  getRecallHookLabel,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  isTrivialUserInput,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  pushBatchStageArtifact,
  setBatchStageOutcome,
  shouldRunRecallForTransaction,
} from "./ui/ui-status.js";
import {
  deleteBackendVectorHashesForRecovery,
  fetchAvailableEmbeddingModels,
  getVectorConfigFromSettings,
  getVectorIndexStats,
  isBackendVectorConfig,
  isDirectVectorConfig,
  syncGraphVectorIndex,
  testVectorConnection,
  validateVectorConfig,
} from "./vector/vector-index.js";

export { DEFAULT_TRIGGER_KEYWORDS, getSmartTriggerDecision };

// 操控面板模块（动态加载，防止加载失败崩溃整个扩展�?
let _panelModule = null;
let _themesModule = null;

const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";
const SERVER_SETTINGS_URL = `/user/files/${SERVER_SETTINGS_FILENAME}`;

function getChatMetadataIntegrity(context = getContext()) {
  return normalizeChatIdCandidate(context?.chatMetadata?.integrity);
}

function getChatCommitMarker(context = getContext()) {
  return readGraphCommitMarker(context);
}

function syncCommitMarkerToPersistenceState(context = getContext()) {
  const marker = getChatCommitMarker(context);
  updateGraphPersistenceState({
    commitMarker: cloneRuntimeDebugValue(marker, null),
  });
  return marker;
}

function isAcceptedPersistTier(storageTier = "none") {
  const normalizedTier = String(storageTier || "none").trim().toLowerCase();
  return normalizedTier === "indexeddb" || normalizedTier === "chat-state";
}

function isRecoveryOnlyPersistTier(storageTier = "none") {
  const normalizedTier = String(storageTier || "none").trim().toLowerCase();
  return normalizedTier === "shadow" || normalizedTier === "metadata-full";
}

function resolvePersistRevisionFloor(
  requestedRevision = 0,
  graph = currentGraph,
) {
  return Math.max(
    normalizeIndexedDbRevision(requestedRevision),
    normalizeIndexedDbRevision(graphPersistenceState.revision),
    normalizeIndexedDbRevision(graphPersistenceState.lastPersistedRevision),
    normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
    normalizeIndexedDbRevision(graph ? getGraphPersistedRevision(graph) : 0),
  );
}

function allocateRequestedPersistRevision(
  requestedRevision = 0,
  graph = currentGraph,
) {
  return Math.max(1, resolvePersistRevisionFloor(requestedRevision, graph) + 1);
}

function normalizeRestoreLockState(lock = null) {
  const source = String(lock?.source || "").trim();
  const reason = String(lock?.reason || "").trim();
  const startedAt = Number(lock?.startedAt);
  const depth = Math.max(0, Math.floor(Number(lock?.depth) || 0));
  const active = lock?.active === true || depth > 0;
  return {
    active,
    depth: active ? Math.max(1, depth || 1) : 0,
    source,
    reason,
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
  };
}

function isRestoreLockActive() {
  return normalizeRestoreLockState(graphPersistenceState.restoreLock).active;
}

function getRestoreLockMessage(operationLabel = "当前操作") {
  const lock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  if (!lock.active) return "";
  const details = [lock.reason, lock.source].filter(Boolean).join(" / ");
  return `${operationLabel}已暂停：当前处于恢复锁${details ? `（${details}）` : ""}`;
}

function enterRestoreLock(source = "runtime", reason = "") {
  const currentLock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  const nextLock = {
    active: true,
    depth: currentLock.depth + 1,
    source: String(source || currentLock.source || "runtime"),
    reason: String(reason || currentLock.reason || ""),
    startedAt: currentLock.startedAt || Date.now(),
  };
  updateGraphPersistenceState({
    restoreLock: nextLock,
  });
  return cloneRuntimeDebugValue(nextLock, nextLock);
}

function leaveRestoreLock(source = "runtime") {
  const currentLock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  if (!currentLock.active) {
    return currentLock;
  }
  const nextDepth = Math.max(0, currentLock.depth - 1);
  const nextLock =
    nextDepth > 0
      ? {
          ...currentLock,
          depth: nextDepth,
          source: String(source || currentLock.source || ""),
        }
      : {
          active: false,
          depth: 0,
          source: "",
          reason: "",
          startedAt: 0,
        };
  updateGraphPersistenceState({
    restoreLock: nextLock,
  });
  return cloneRuntimeDebugValue(nextLock, nextLock);
}

async function runWithRestoreLock(source, reason, task) {
  enterRestoreLock(source, reason);
  try {
    return await task();
  } finally {
    leaveRestoreLock(source);
  }
}

function recordPersistMismatchDiagnostic(
  mismatch = null,
  { source = "persist-mismatch", resolvedBy = "" } = {},
) {
  const normalizedReason = String(mismatch?.reason || "").trim();
  const marker = cloneRuntimeDebugValue(mismatch?.marker, null) || getChatCommitMarker();
  updateGraphPersistenceState({
    persistMismatchReason: normalizedReason,
    commitMarker: marker,
    dualWriteLastResult: {
      action: "load",
      source: String(source || "persist-mismatch"),
      success: false,
      diagnostic: true,
      reason: normalizedReason,
      markerRevision: Number(mismatch?.markerRevision || 0),
      snapshotRevision: Number(mismatch?.snapshotRevision || 0),
      resolvedBy: String(resolvedBy || ""),
      at: Date.now(),
    },
  });
  return {
    reason: normalizedReason,
    marker,
  };
}

function persistGraphCommitMarker(
  context = getContext(),
  {
    reason = "graph-commit-marker",
    revision = graphPersistenceState.revision,
    storageTier = "none",
    accepted = false,
    lastProcessedAssistantFloor = null,
    extractionCount: nextExtractionCount = null,
    immediate = true,
  } = {},
) {
  if (!context) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-context",
      revision,
      storageTier,
    });
  }

  const chatId = getCurrentChatId(context);
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-chat-id",
      revision,
      storageTier,
    });
  }

  const marker = buildGraphCommitMarker(currentGraph, {
    revision,
    storageTier,
    accepted,
    reason,
    chatId,
    integrity: getChatMetadataIntegrity(context),
    lastProcessedAssistantFloor,
    extractionCount: nextExtractionCount,
  });
  if (!marker) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "marker-build-failed",
      revision,
      storageTier,
    });
  }

  writeChatMetadataPatch(context, {
    [GRAPH_COMMIT_MARKER_KEY]: marker,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });
  updateGraphPersistenceState({
    commitMarker: cloneRuntimeDebugValue(marker, null),
    lastPersistReason: String(reason || ""),
    lastPersistMode: `commit-marker:${saveMode}`,
  });
  return buildGraphPersistResult({
    saved: true,
    blocked: false,
    accepted,
    reason,
    revision: Number(marker.revision || revision || 0),
    saveMode,
    storageTier,
  });
}

function applyPersistMismatchBlockedState(
  chatId,
  mismatch = null,
  { source = "persist-mismatch", attemptIndex = 0, resolvedBy = "" } = {},
) {
  const marker = cloneRuntimeDebugValue(mismatch?.marker, null) || getChatCommitMarker();
  const markerRevision = Number(mismatch?.markerRevision || 0);
  const snapshotRevision = Number(mismatch?.snapshotRevision || 0);
  const diagnostic = recordPersistMismatchDiagnostic(
    {
      ...(mismatch || {}),
      marker,
    },
    {
      source,
      resolvedBy,
    },
  );
  refreshPanelLiveState();
  return {
    success: false,
    loaded: false,
    loadState: graphPersistenceState.loadState,
    reason:
      diagnostic.reason ||
      String(
        mismatch?.reason ||
          "persist-mismatch:indexeddb-behind-commit-marker",
      ),
    chatId,
    attemptIndex,
    markerRevision,
    snapshotRevision,
    diagnosticOnly: true,
  };
}

function triggerChatMetadataSave(
  context = getContext(),
  { immediate = false } = {},
) {
  if (immediate) {
    const immediateSave =
      typeof context?.saveMetadata === "function"
        ? context.saveMetadata
        : saveMetadata;
    if (typeof immediateSave === "function") {
      try {
        const result = immediateSave.call(context);
        if (result && typeof result.catch === "function") {
          result.catch((error) => {
            console.error("[ST-BME] 立即保存聊天元数据失败:", error);
          });
        }
        return "immediate";
      } catch (error) {
        console.error("[ST-BME] 触发立即保存聊天元数据失败:", error);
      }
    }
  }

  if (typeof context?.saveMetadataDebounced === "function") {
    context.saveMetadataDebounced();
    return "debounced";
  }
  saveMetadataDebounced();
  return "debounced";
}

function getRuntimeDebugState() {
  const stateKey = "__stBmeRuntimeDebugState";
  if (!globalThis[stateKey] || typeof globalThis[stateKey] !== "object") {
    globalThis[stateKey] = {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      taskTimeline: [],
      messageTrace: {
        lastSentUserMessage: null,
      },
      maintenance: {
        lastAction: null,
        lastUndoResult: null,
      },
      graphPersistence: null,
      updatedAt: "",
    };
  }
  return globalThis[stateKey];
}

function touchRuntimeDebugState() {
  const state = getRuntimeDebugState();
  state.updatedAt = new Date().toISOString();
  return state;
}

function recordHostCapabilitySnapshot(snapshot = null) {
  const state = touchRuntimeDebugState();
  state.hostCapabilities = cloneRuntimeDebugValue(snapshot, null);
}

function recordInjectionSnapshot(kind, snapshot = {}) {
  const normalizedKind = String(kind || "").trim() || "default";
  const state = touchRuntimeDebugState();
  state.injections[normalizedKind] = {
    updatedAt: new Date().toISOString(),
    ...cloneRuntimeDebugValue(snapshot, {}),
  };
}

function recordMessageTraceSnapshot(patch = {}) {
  const state = touchRuntimeDebugState();
  const previous = state.messageTrace || {
    lastSentUserMessage: null,
  };
  state.messageTrace = {
    ...previous,
    ...cloneRuntimeDebugValue(patch, {}),
  };
}

function recordGraphPersistenceSnapshot(snapshot = null) {
  const state = touchRuntimeDebugState();
  state.graphPersistence = cloneRuntimeDebugValue(snapshot, null);
}

function recordMaintenanceDebugSnapshot(patch = {}) {
  const state = touchRuntimeDebugState();
  const previous = state.maintenance || {
    lastAction: null,
    lastUndoResult: null,
  };
  state.maintenance = {
    ...previous,
    ...cloneRuntimeDebugValue(patch, {}),
  };
}

function readRuntimeDebugSnapshot() {
  const state = getRuntimeDebugState();
  return cloneRuntimeDebugValue(
    {
      hostCapabilities: state.hostCapabilities,
      taskPromptBuilds: state.taskPromptBuilds,
      taskLlmRequests: state.taskLlmRequests,
      injections: state.injections,
      taskTimeline: state.taskTimeline,
      messageTrace: state.messageTrace,
      maintenance: state.maintenance,
      graphPersistence: state.graphPersistence,
      updatedAt: state.updatedAt,
    },
    {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      taskTimeline: [],
      messageTrace: {
        lastSentUserMessage: null,
      },
      maintenance: {
        lastAction: null,
        lastUndoResult: null,
      },
      graphPersistence: null,
      updatedAt: "",
    },
  );
}

// ==================== 状�?====================

let currentGraph = null;
let isExtracting = false;
let isRecalling = false;
let activeRecallPromise = null;
let recallRunSequence = 0;
let lastInjectionContent = "";
let lastExtractedItems = []; // 最近提取的节点（面板展示用�?
let lastRecalledItems = []; // 最近召回的节点（面板展示用�?
let extractionCount = 0; // v2: 提取次数计数器（定期触发概要/遗忘/反思）
let serverSettingsSaveTimer = null;
let isRecoveringHistory = false;
let lastHistoryWarningAt = 0;
let lastRecallFallbackNoticeAt = 0;
let lastExtractionWarningAt = 0;
const LOCAL_VECTOR_TIMEOUT_MS = 300000;
const STATUS_TOAST_THROTTLE_MS = 1500;
const RECALL_INPUT_RECORD_TTL_MS = 60000;
const TRIVIAL_GENERATION_SKIP_TTL_MS = 60000;
const HISTORY_RECOVERY_SETTLE_MS = 80;
const HISTORY_MUTATION_RETRY_DELAYS_MS = [80, 220, 500, 900];
const GRAPH_LOAD_RETRY_DELAYS_MS = [120, 450, 1200, 2500];
const AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS = [120, 320, 800, 1600, 2800];
const AUTO_EXTRACTION_HOST_SETTLE_MS = 120;
let runtimeStatus = createUiStatus("待命", "准备就绪", "idle");
let lastExtractionStatus = createUiStatus("待命", "尚未执行提取", "idle");
let lastVectorStatus = createUiStatus("待命", "尚未执行向量任务", "idle");
let lastRecallStatus = createUiStatus("待命", "尚未执行召回", "idle");
let graphPersistenceState = createGraphPersistenceState();
const lastStatusToastAt = {};
let pendingRecallSendIntent = createRecallInputRecord();
let lastRecallSentUserMessage = createRecallInputRecord();
let pendingHostGenerationInputSnapshot = createRecallInputRecord();
let currentGenerationTrivialSkip = null;
let coreEventBindingState = {
  registered: false,
  cleanups: [],
  registeredAt: 0,
};
let sendIntentHookCleanup = [];
let sendIntentHookRetryTimer = null;
let pendingHistoryRecoveryTimer = null;
let pendingHistoryRecoveryTrigger = "";
let pendingHistoryMutationCheckTimers = [];
let pendingGraphLoadRetryTimer = null;
let pendingGraphLoadRetryChatId = "";
let pendingGraphPersistRetryTimer = null;
let pendingGraphPersistRetryChatId = "";
let pendingGraphPersistRetryAttempt = 0;
let pendingAutoExtractionTimer = null;
let pendingAutoExtraction = {
  chatId: "",
  messageId: null,
  reason: "",
  requestedAt: 0,
  attempts: 0,
  targetEndFloor: null,
  strategy: "normal",
};
let isHostGenerationRunning = false;
let lastHostGenerationEndedAt = 0;
let skipBeforeCombineRecallUntil = 0;
let lastPreGenerationRecallKey = "";
let lastPreGenerationRecallAt = 0;
const generationRecallTransactions = new Map();
const plannerRecallHandoffs = new Map();
let persistedRecallUiRefreshTimer = null;
let persistedRecallUiRefreshObserver = null;
let persistedRecallUiRefreshSession = 0;
const PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS = [
  0,
  80,
  180,
  320,
  500,
  850,
  1300,
  2000,
  3000,
  4200,
];
const PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS = 1500;
const persistedRecallUiDiagnosticTimestamps = new Map();
const persistedRecallPersistDiagnosticTimestamps = new Map();
const GENERATION_RECALL_TRANSACTION_TTL_MS = 15000;
const PLANNER_RECALL_HANDOFF_TTL_MS = GENERATION_RECALL_TRANSACTION_TTL_MS;
const GENERATION_RECALL_HOOK_BRIDGE_MS = 1200;
const stageNoticeHandles = {
  extraction: null,
  vector: null,
  recall: null,
  history: null,
};
const stageAbortControllers = {
  extraction: null,
  vector: null,
  recall: null,
  history: null,
};
let bmeChatManager = null;
let bmeChatManagerUnavailableWarned = false;
const bmeIndexedDbSnapshotCacheByChatId = new Map();
const bmeIndexedDbLoadInFlightByChatId = new Map();
const bmeIndexedDbWriteInFlightByChatId = new Map();
const bmeIndexedDbLegacyMigrationInFlightByChatId = new Map();
const bmeIndexedDbLatestQueuedRevisionByChatId = new Map();
const bmeChatStateSnapshotCacheByChatId = new Map();
const bmeChatStateLoadInFlightByChatId = new Map();
const PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS = [500, 1500, 5000];
const PENDING_GRAPH_PERSIST_MAX_RETRY_ATTEMPTS = 5;
const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = new Set([
  GRAPH_LOAD_STATES.LOADING,
  GRAPH_LOAD_STATES.BLOCKED,
  GRAPH_LOAD_STATES.NO_CHAT,
  GRAPH_LOAD_STATES.SHADOW_RESTORED,
]);

function isGraphLoadStateDbReady(loadState = graphPersistenceState.loadState) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
  );
}

function normalizeGraphSyncState(value = "idle") {
  const normalized = String(value || "idle")
    .trim()
    .toLowerCase();
  if (["idle", "syncing", "warning", "error"].includes(normalized))
    return normalized;
  return "idle";
}

function getGraphPersistenceLiveState() {
  const liveCommitMarker =
    cloneRuntimeDebugValue(graphPersistenceState.commitMarker, null) ||
    readGraphCommitMarker(getContext());
  const restoreLock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  const snapshot = {
    loadState: graphPersistenceState.loadState,
    chatId: graphPersistenceState.chatId,
    reason: graphPersistenceState.reason,
    attemptIndex: graphPersistenceState.attemptIndex,
    graphRevision: graphPersistenceState.revision,
    lastPersistedRevision: graphPersistenceState.lastPersistedRevision,
    queuedPersistRevision: graphPersistenceState.queuedPersistRevision,
    queuedPersistChatId: graphPersistenceState.queuedPersistChatId,
    shadowSnapshotUsed: graphPersistenceState.shadowSnapshotUsed,
    shadowSnapshotRevision: graphPersistenceState.shadowSnapshotRevision,
    shadowSnapshotUpdatedAt: graphPersistenceState.shadowSnapshotUpdatedAt,
    shadowSnapshotReason: graphPersistenceState.shadowSnapshotReason,
    lastPersistReason: graphPersistenceState.lastPersistReason,
    lastPersistMode: graphPersistenceState.lastPersistMode,
    metadataIntegrity: graphPersistenceState.metadataIntegrity,
    writesBlocked: graphPersistenceState.writesBlocked,
    pendingPersist: graphPersistenceState.pendingPersist,
    lastAcceptedRevision: Number(graphPersistenceState.lastAcceptedRevision || 0),
    acceptedStorageTier: String(graphPersistenceState.acceptedStorageTier || "none"),
    lastRecoverableStorageTier: String(
      graphPersistenceState.lastRecoverableStorageTier || "none",
    ),
    persistMismatchReason: String(graphPersistenceState.persistMismatchReason || ""),
    commitMarker: cloneRuntimeDebugValue(liveCommitMarker, null),
    restoreLock,
    queuedPersistMode: graphPersistenceState.queuedPersistMode,
    queuedPersistRotateIntegrity:
      graphPersistenceState.queuedPersistRotateIntegrity,
    queuedPersistReason: graphPersistenceState.queuedPersistReason,
    canWriteToMetadata: isGraphMetadataWriteAllowed(
      graphPersistenceState.loadState,
    ),
    updatedAt: graphPersistenceState.updatedAt,
    storagePrimary: graphPersistenceState.storagePrimary || "indexeddb",
    storageMode: graphPersistenceState.storageMode || "indexeddb",
    dbReady:
      graphPersistenceState.dbReady ??
      isGraphLoadStateDbReady(graphPersistenceState.loadState),
    indexedDbRevision: graphPersistenceState.indexedDbRevision || 0,
    indexedDbLastError: graphPersistenceState.indexedDbLastError || "",
    syncState: normalizeGraphSyncState(graphPersistenceState.syncState),
    syncDirty: Boolean(graphPersistenceState.syncDirty),
    syncDirtyReason: String(graphPersistenceState.syncDirtyReason || ""),
    lastSyncUploadedAt: Number(graphPersistenceState.lastSyncUploadedAt) || 0,
    lastSyncDownloadedAt:
      Number(graphPersistenceState.lastSyncDownloadedAt) || 0,
    lastSyncedRevision: Number(graphPersistenceState.lastSyncedRevision) || 0,
    lastBackupUploadedAt:
      Number(graphPersistenceState.lastBackupUploadedAt) || 0,
    lastBackupRestoredAt:
      Number(graphPersistenceState.lastBackupRestoredAt) || 0,
    lastBackupRollbackAt:
      Number(graphPersistenceState.lastBackupRollbackAt) || 0,
    lastBackupFilename: String(graphPersistenceState.lastBackupFilename || ""),
    lastSyncError: String(graphPersistenceState.lastSyncError || ""),
    dualWriteLastResult: cloneRuntimeDebugValue(
      graphPersistenceState.dualWriteLastResult,
      null,
    ),
  };

  return cloneRuntimeDebugValue(snapshot, snapshot);
}

function syncGraphPersistenceDebugState() {
  recordGraphPersistenceSnapshot(getGraphPersistenceLiveState());
}

function updateGraphPersistenceState(patch = {}) {
  graphPersistenceState = {
    ...graphPersistenceState,
    ...(patch || {}),
    updatedAt: new Date().toISOString(),
  };
  syncGraphPersistenceDebugState();
  return graphPersistenceState;
}

function bumpGraphRevision(reason = "graph-mutation") {
  const nextRevision =
    Math.max(
      graphPersistenceState.revision || 0,
      graphPersistenceState.lastPersistedRevision || 0,
      graphPersistenceState.queuedPersistRevision || 0,
    ) + 1;
  updateGraphPersistenceState({
    revision: nextRevision,
    lastPersistReason: String(
      reason || graphPersistenceState.lastPersistReason || "",
    ),
  });
  return nextRevision;
}

function isGraphMetadataWriteAllowed(
  loadState = graphPersistenceState.loadState,
) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
  );
}

function isGraphReadable(loadState = graphPersistenceState.loadState) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED ||
    loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
    (loadState === GRAPH_LOAD_STATES.BLOCKED &&
      graphPersistenceState.shadowSnapshotUsed)
  );
}

function hasReadableRuntimeGraphForRecall(chatId = getCurrentChatId()) {
  if (
    !currentGraph ||
    typeof currentGraph !== "object" ||
    !Array.isArray(currentGraph.nodes) ||
    !Array.isArray(currentGraph.edges) ||
    !currentGraph.historyState ||
    typeof currentGraph.historyState !== "object" ||
    Array.isArray(currentGraph.historyState)
  ) {
    return false;
  }

  const activeChatId = normalizeChatIdCandidate(chatId);
  const runtimeChatId = normalizeChatIdCandidate(
    currentGraph.historyState.chatId,
  );

  // chatId 匹配验证：如果两者都有，必须一�?
  if (activeChatId && runtimeChatId) {
    return runtimeChatId === activeChatId;
  }

  // 兜底：chatId 不可用（ST 插件环境可能无法获取 chatId），
  // �?currentGraph 结构完整且有节点数据 �?允许召回�?
  // 这对应用户能�?UI 看到图谱�?getCurrentChatId() 返回空的场景�?
  return currentGraph.nodes.length > 0 || currentGraph.edges.length > 0;
}

function isGraphReadableForRecall(
  loadState = graphPersistenceState.loadState,
  chatId = getCurrentChatId(),
) {
  if (isGraphReadable(loadState)) {
    return true;
  }

  // �?loadState 不在正常可读状态时（如 NO_CHAT、LOADING），
  // 仍检查运行时图谱的实际结构。持久化状态机可能失同�?
  // （如 getCurrentChatId 在某�?ST 环境下返回空导致 loadState 卡在 NO_CHAT），
  // �?currentGraph 已经通过其他路径（IndexedDB probe / metadata fallback）加载了数据�?
  return hasReadableRuntimeGraphForRecall(chatId);
}

function createGraphLoadUiStatus() {
  const state = graphPersistenceState.loadState;
  const chatId = graphPersistenceState.chatId || getCurrentChatId();
  switch (state) {
    case GRAPH_LOAD_STATES.NO_CHAT:
      return createUiStatus("待命", "当前尚未进入聊天", "idle");
    case GRAPH_LOAD_STATES.LOADING:
      return createUiStatus(
        "图谱加载中",
        chatId
          ? `正在读取聊天 ${chatId} 的 IndexedDB 图谱`
          : "正在等待聊天上下文准备完成",
        "running",
      );
    case GRAPH_LOAD_STATES.SHADOW_RESTORED:
      return createUiStatus(
        "图谱临时恢复",
        "已从本次会话临时恢复，正在等待正式聊天元数据",
        "warning",
      );
    case GRAPH_LOAD_STATES.EMPTY_CONFIRMED:
      return createUiStatus(
        "图谱待命",
        chatId ? "当前聊天还没有图谱" : "当前尚未进入聊天",
        "idle",
      );
    case GRAPH_LOAD_STATES.BLOCKED:
      return createUiStatus(
        "图谱加载受阻",
        "当前图谱尚未完成 IndexedDB 初始加载",
        "warning",
      );
    case GRAPH_LOAD_STATES.LOADED:
    default:
      return createUiStatus("待命", "已加载聊天图谱，等待下一次任务", "idle");
  }
}

function getPanelRuntimeStatus() {
  const graphStatus = createGraphLoadUiStatus();
  if (
    !graphPersistenceState.dbReady ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.BLOCKED ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.NO_CHAT
  ) {
    return graphStatus;
  }
  return runtimeStatus;
}

function getGraphMutationBlockReason(operationLabel = "当前操作") {
  if (isRestoreLockActive()) {
    return getRestoreLockMessage(operationLabel);
  }
  const loadState = graphPersistenceState.loadState;
  if (!getCurrentChatId()) {
    return `${operationLabel}已暂停：当前尚未进入聊天。`;
  }

  if (graphPersistenceState.dbReady || isGraphLoadStateDbReady(loadState)) {
    return `${operationLabel}暂不可用。`;
  }

  switch (graphPersistenceState.loadState) {
    case GRAPH_LOAD_STATES.LOADING:
      return `${operationLabel}已暂停：正在加载 IndexedDB 图谱。`;
    case GRAPH_LOAD_STATES.SHADOW_RESTORED:
      return `${operationLabel}已暂停：当前图谱仍处于旧恢复状态，请等待 IndexedDB 初始化完成。`;
    case GRAPH_LOAD_STATES.BLOCKED:
      return `${operationLabel}已暂停：IndexedDB 初始化受阻，请稍后重试。`;
    case GRAPH_LOAD_STATES.NO_CHAT:
      return `${operationLabel}已暂停：当前尚未进入聊天。`;
    default:
      return `${operationLabel}已暂停：图谱尚未完成初始化。`;
  }
}

function ensureGraphMutationReady(
  operationLabel = "当前操作",
  { notify = true, ignoreRestoreLock = false } = {},
) {
  if (!ignoreRestoreLock && isRestoreLockActive()) {
    if (notify) {
      toastr.info(getRestoreLockMessage(operationLabel), "ST-BME");
    }
    return false;
  }
  if (graphPersistenceState.dbReady || isGraphLoadStateDbReady()) return true;
  if (notify) {
    toastr.info(getGraphMutationBlockReason(operationLabel), "ST-BME");
  }
  return false;
}

function applyGraphLoadState(
  loadState,
  {
    chatId = getCurrentChatId(),
    reason = "",
    attemptIndex = 0,
    shadowSnapshotUsed = false,
    shadowSnapshotRevision = 0,
    shadowSnapshotUpdatedAt = "",
    shadowSnapshotReason = "",
    revision = graphPersistenceState.revision,
    lastPersistedRevision = graphPersistenceState.lastPersistedRevision,
    queuedPersistRevision = graphPersistenceState.queuedPersistRevision,
    pendingPersist = graphPersistenceState.pendingPersist,
    dbReady = isGraphLoadStateDbReady(loadState),
    writesBlocked = !isGraphMetadataWriteAllowed(loadState),
  } = {},
) {
  updateGraphPersistenceState({
    loadState,
    chatId: String(chatId || ""),
    reason: String(reason || ""),
    attemptIndex,
    revision,
    lastPersistedRevision,
    queuedPersistRevision,
    shadowSnapshotUsed,
    shadowSnapshotRevision,
    shadowSnapshotUpdatedAt,
    shadowSnapshotReason,
    pendingPersist,
    writesBlocked,
    dbReady,
    storageMode: "indexeddb",
  });

  if (dbReady && isGraphLoadStateDbReady(loadState)) {
    const enqueueMicrotask =
      typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
        : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      if (typeof maybeResumePendingAutoExtraction === "function") {
        void maybeResumePendingAutoExtraction(`graph-ready:${loadState}`);
      }
    });
  }
}

function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal, message = "操作已终止") {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError(message);
  }
}

function assertRecoveryChatStillActive(expectedChatId, label = "") {
  if (!expectedChatId) return;
  const currentIdentity = resolveCurrentChatIdentity(getContext());
  const currentId = normalizeChatIdCandidate(currentIdentity.chatId);
  const normalizedExpectedChatId = normalizeChatIdCandidate(expectedChatId);
  if (
    currentId &&
    normalizedExpectedChatId &&
    !doesChatIdMatchResolvedGraphIdentity(
      normalizedExpectedChatId,
      currentIdentity,
    )
  ) {
    throw createAbortError(
      `历史恢复已终止：聊天已从 ${normalizedExpectedChatId} 切换到 ${currentId}${label ? ` (${label})` : ""}`,
    );
  }
}

function getStageAbortLabel(stage) {
  switch (stage) {
    case "extraction":
      return "提取";
    case "vector":
      return "向量";
    case "recall":
      return "召回";
    case "history":
      return "历史恢复";
    default:
      return "当前流程";
  }
}

function beginStageAbortController(stage) {
  const controller = new AbortController();
  stageAbortControllers[stage] = controller;
  syncStageNoticeAbortAction(stage);
  return controller;
}

function finishStageAbortController(stage, controller = null) {
  if (!controller || stageAbortControllers[stage] === controller) {
    stageAbortControllers[stage] = null;
  }
}

function findAbortableStageForNotice(stage) {
  const preferred = [stage];
  if (stage === "vector") {
    preferred.push("history", "extraction", "recall");
  }

  for (const candidate of preferred) {
    const controller = stageAbortControllers[candidate];
    if (controller && !controller.signal.aborted) {
      return candidate;
    }
  }

  return null;
}

function abortStage(stage) {
  const controller = stageAbortControllers[stage];
  if (!controller || controller.signal.aborted) return false;
  controller.abort(createAbortError(`${getStageAbortLabel(stage)}已终止`));
  return true;
}

function abortRecallStageWithReason(reason = "召回已终止") {
  const controller = stageAbortControllers.recall;
  if (!controller || controller.signal.aborted) return false;
  controller.abort(createAbortError(reason));
  return true;
}

async function waitForActiveRecallToSettle(timeoutMs = 1800) {
  const pending = activeRecallPromise;
  if (!pending) {
    return {
      settled: !isRecalling,
      timedOut: false,
    };
  }

  let settled = false;
  await Promise.race([
    Promise.resolve(pending)
      .catch(() => {})
      .then(() => {
        settled = true;
      }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  return {
    settled: settled || !isRecalling,
    timedOut: !settled && isRecalling,
  };
}

function buildAbortStageAction(stage) {
  const abortStageName = findAbortableStageForNotice(stage);
  if (!abortStageName) return undefined;

  return {
    label: `终止${getStageAbortLabel(abortStageName)}`,
    kind: "danger",
    onClick: () => {
      abortStage(abortStageName);
    },
  };
}

function createNoticePanelAction() {
  return createNoticePanelActionController({
    getPanelModule: () => _panelModule,
  });
}

function dismissStageNotice(stage) {
  stageNoticeHandles[stage]?.dismiss?.();
  stageNoticeHandles[stage] = null;
}

function dismissAllStageNotices() {
  for (const stage of Object.keys(stageNoticeHandles)) {
    dismissStageNotice(stage);
  }
}

function abortAllRunningStages() {
  for (const stage of Object.keys(stageAbortControllers)) {
    abortStage(stage);
  }
}

function getStageUiStatus(stage) {
  switch (stage) {
    case "extraction":
      return lastExtractionStatus;
    case "vector":
      return lastVectorStatus;
    case "recall":
      return lastRecallStatus;
    default:
      return null;
  }
}

function syncStageNoticeAbortAction(stage) {
  const status = getStageUiStatus(stage);
  if (!status || !stageNoticeHandles[stage]) return;
  updateStageNotice(stage, status.text, status.meta, status.level, {
    title: getStageNoticeTitle(stage),
  });
}

function getStageNoticeDisplayMode(level = "info") {
  const configuredMode = getSettings()?.noticeDisplayMode;
  if (
    configuredMode === "compact" &&
    level !== "warning" &&
    level !== "error"
  ) {
    return "compact";
  }
  return "normal";
}

function refreshVisibleStageNotices() {
  for (const stage of Object.keys(stageNoticeHandles)) {
    const handle = stageNoticeHandles[stage];
    if (!handle || handle.isClosed?.()) continue;
    const status = getStageUiStatus(stage);
    if (!status) continue;
    updateStageNotice(stage, status.text, status.meta, status.level, {
      title: getStageNoticeTitle(stage),
    });
  }
}

function updateStageNotice(
  stage,
  text,
  meta = "",
  level = "info",
  options = {},
) {
  const noticeLevel = normalizeStageNoticeLevel(level);
  const busy = options.busy ?? level === "running";
  const persist = options.persist ?? busy;
  const title = options.title || getStageNoticeTitle(stage);
  const message = [text, meta].filter(Boolean).join("\n");
  const input = {
    title,
    message,
    displayMode: options.displayMode || getStageNoticeDisplayMode(noticeLevel),
    level: noticeLevel,
    busy,
    persist,
    marquee: options.noticeMarquee ?? false,
    duration_ms: options.duration_ms ?? getStageNoticeDuration(noticeLevel),
    action:
      options.action === undefined
        ? busy
          ? buildAbortStageAction(stage)
          : noticeLevel === "warning" || noticeLevel === "error"
            ? createNoticePanelAction()
            : undefined
        : options.action,
  };

  const currentHandle = stageNoticeHandles[stage];
  if (!currentHandle || currentHandle.isClosed?.()) {
    stageNoticeHandles[stage] = showManagedBmeNotice(input);
    return;
  }

  currentHandle.update(input);
}

function toPanelNodeItem(node, meta = "") {
  return {
    id: node.id,
    type: node.type,
    name: getNodeDisplayName(node),
    meta,
  };
}

function updateLastExtractedItems(nodeIds = []) {
  if (!currentGraph || !Array.isArray(nodeIds)) {
    lastExtractedItems = [];
    return;
  }

  lastExtractedItems = nodeIds
    .map((id) => getNode(currentGraph, id))
    .filter(Boolean)
    .slice(-5)
    .reverse()
    .map((node) =>
      toPanelNodeItem(
        node,
        `seq ${node.seqRange?.[1] ?? node.seq ?? 0} · ${new Date(
          node.createdTime || Date.now(),
        ).toLocaleTimeString()}`,
      ),
    );
}

function updateLastRecalledItems(nodeIds = []) {
  if (!currentGraph || !Array.isArray(nodeIds)) {
    lastRecalledItems = [];
    return;
  }

  lastRecalledItems = normalizeRecallNodeIdList(nodeIds)
    .map((id) => getNode(currentGraph, id))
    .filter(Boolean)
    .slice(0, 8)
    .map((node) =>
      toPanelNodeItem(
        node,
        `imp ${node.importance ?? 5} · seq ${node.seqRange?.[1] ?? node.seq ?? 0}`,
      ),
    );
}

function normalizeRecallNodeIdList(nodeIds = []) {
  if (!Array.isArray(nodeIds)) return [];
  return nodeIds
    .map((entry) => {
      if (typeof entry === "string" || typeof entry === "number") {
        return String(entry).trim();
      }
      if (entry && typeof entry === "object") {
        return String(entry.id || entry.nodeId || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function areRecallNodeIdListsEqual(left = [], right = []) {
  const normalizedLeft = normalizeRecallNodeIdList(left);
  const normalizedRight = normalizeRecallNodeIdList(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  for (let index = 0; index < normalizedLeft.length; index++) {
    if (normalizedLeft[index] !== normalizedRight[index]) return false;
  }
  return true;
}

function getLatestPersistedRecallDisplayRecord(chat = getContext()?.chat) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  for (let index = chat.length - 1; index >= 0; index--) {
    if (!chat[index]?.is_user) continue;
    const record = readPersistedRecallFromUserMessage(chat, index);
    if (record?.injectionText) {
      return {
        messageIndex: index,
        record,
      };
    }
  }
  return null;
}

function restoreRecallUiStateFromPersistence(chat = getContext()?.chat) {
  const latestPersisted = getLatestPersistedRecallDisplayRecord(chat);
  const graphRecallNodeIds = normalizeRecallNodeIdList(
    currentGraph?.lastRecallResult,
  );
  const persistedNodeIds = normalizeRecallNodeIdList(
    latestPersisted?.record?.selectedNodeIds,
  );
  const effectiveNodeIds = graphRecallNodeIds.length
    ? graphRecallNodeIds
    : persistedNodeIds;

  updateLastRecalledItems(effectiveNodeIds);
  lastInjectionContent = String(latestPersisted?.record?.injectionText || "").trim();

  return {
    restored: Boolean(lastInjectionContent || effectiveNodeIds.length),
    latestPersistedMessageIndex: Number.isFinite(latestPersisted?.messageIndex)
      ? latestPersisted.messageIndex
      : null,
    selectedNodeIds: effectiveNodeIds,
    injectionTextLength: lastInjectionContent.length,
  };
}

function clearRecallInputTracking() {
  clearPendingRecallSendIntent();
  lastRecallSentUserMessage = createRecallInputRecord();
  clearPendingHostGenerationInputSnapshot();
  if (typeof recordMessageTraceSnapshot === "function") {
    recordMessageTraceSnapshot({
      lastSentUserMessage: null,
    });
  }
  clearPlannerRecallHandoffsForChat("", { clearAll: true });
}

function getCoreEventBindingState() {
  return coreEventBindingState;
}

function setCoreEventBindingState(nextState = {}) {
  coreEventBindingState = {
    registered: Boolean(nextState?.registered),
    cleanups: Array.isArray(nextState?.cleanups) ? nextState.cleanups : [],
    registeredAt: Number(nextState?.registeredAt) || 0,
  };
  return coreEventBindingState;
}

function clearCoreEventBindingState() {
  const cleanups = Array.isArray(coreEventBindingState?.cleanups)
    ? coreEventBindingState.cleanups.splice(
        0,
        coreEventBindingState.cleanups.length,
      )
    : [];
  for (const cleanup of cleanups) {
    try {
      cleanup?.();
    } catch (error) {
      console.warn("[ST-BME] 清理核心事件绑定失败:", error);
    }
  }
  coreEventBindingState = {
    registered: false,
    cleanups: [],
    registeredAt: 0,
  };
  return coreEventBindingState;
}

function freezeHostGenerationInputSnapshot(
  text,
  source = "host-generation-lifecycle",
) {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return null;

  pendingHostGenerationInputSnapshot = createRecallInputRecord({
    text: normalized,
    hash: hashRecallInput(normalized),
    source,
    at: Date.now(),
  });
  return pendingHostGenerationInputSnapshot;
}

function consumeHostGenerationInputSnapshot(options = {}) {
  const { preserve = false } = options;
  if (!isFreshRecallInputRecord(pendingHostGenerationInputSnapshot)) {
    if (!preserve) {
      pendingHostGenerationInputSnapshot = createRecallInputRecord();
    }
    return createRecallInputRecord();
  }

  const snapshot = createRecallInputRecord({
    ...pendingHostGenerationInputSnapshot,
  });
  if (!preserve) {
    pendingHostGenerationInputSnapshot = createRecallInputRecord();
  }
  return snapshot;
}

function getPendingHostGenerationInputSnapshot() {
  return pendingHostGenerationInputSnapshot;
}

function clearPendingRecallSendIntent() {
  pendingRecallSendIntent = createRecallInputRecord();
  return pendingRecallSendIntent;
}

function clearPendingHostGenerationInputSnapshot() {
  pendingHostGenerationInputSnapshot = createRecallInputRecord();
  return pendingHostGenerationInputSnapshot;
}

function getCurrentGenerationTrivialSkip(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  if (!currentGenerationTrivialSkip) return null;

  const setAtMs = Number(currentGenerationTrivialSkip.setAtMs) || 0;
  if (
    !setAtMs ||
    now - setAtMs > TRIVIAL_GENERATION_SKIP_TTL_MS
  ) {
    currentGenerationTrivialSkip = null;
    return null;
  }

  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const activeChatId = normalizeChatIdCandidate(
    currentGenerationTrivialSkip.chatId,
  );
  if (normalizedChatId && activeChatId && normalizedChatId !== activeChatId) {
    return null;
  }

  return currentGenerationTrivialSkip;
}

function markCurrentGenerationTrivialSkip({
  reason = "",
  chatId = getCurrentChatId(),
  chatLength = 0,
} = {}) {
  currentGenerationTrivialSkip = {
    chatId: normalizeChatIdCandidate(chatId),
    setAtMs: Date.now(),
    reason: String(reason || ""),
    generationStartMinChatIndex: Math.max(
      0,
      Math.floor(Number(chatLength) || 0),
    ),
  };
  return currentGenerationTrivialSkip;
}

function clearCurrentGenerationTrivialSkip(_reason = "") {
  const previous = currentGenerationTrivialSkip;
  currentGenerationTrivialSkip = null;
  return previous;
}

function consumeCurrentGenerationTrivialSkip(
  targetMessageIndex,
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  const activeSkip = getCurrentGenerationTrivialSkip(chatId, now);
  if (!activeSkip) return false;

  const normalizedTargetIndex = Number.isFinite(Number(targetMessageIndex))
    ? Math.floor(Number(targetMessageIndex))
    : null;
  if (!Number.isFinite(normalizedTargetIndex)) {
    return false;
  }

  if (
    normalizedTargetIndex <
    Math.max(0, Math.floor(Number(activeSkip.generationStartMinChatIndex) || 0))
  ) {
    return false;
  }

  currentGenerationTrivialSkip = null;
  return true;
}

function recordRecallSendIntent(text, source = "dom-intent") {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return createRecallInputRecord();

  const hash = hashRecallInput(normalized);
  const previousRecord = isFreshRecallInputRecord(pendingRecallSendIntent)
    ? pendingRecallSendIntent
    : null;
  const previousHash = String(previousRecord?.hash || "");
  const previousText = String(previousRecord?.text || "");

  if (previousHash && previousHash === hash && previousText === normalized) {
    pendingRecallSendIntent = createRecallInputRecord({
      ...previousRecord,
      at: Date.now(),
      source: String(source || previousRecord.source || "dom-intent"),
    });
    return pendingRecallSendIntent;
  }

  pendingRecallSendIntent = createRecallInputRecord({
    text: normalized,
    hash,
    source,
    at: Date.now(),
  });
  return pendingRecallSendIntent;
}

function recordRecallSentUserMessage(messageId, text, source = "message-sent") {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return createRecallInputRecord();

  const hash = hashRecallInput(normalized);
  lastRecallSentUserMessage = createRecallInputRecord({
    text: normalized,
    hash,
    messageId: Number.isFinite(messageId) ? messageId : null,
    source,
    at: Date.now(),
  });
  if (typeof recordMessageTraceSnapshot === "function") {
    recordMessageTraceSnapshot({
      lastSentUserMessage: {
        text: normalized,
        hash,
        messageId: Number.isFinite(messageId) ? messageId : null,
        source,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  // 注意：不再在 MESSAGE_SENT 阶段清空 pendingRecallSendIntent /
  // pendingHostGenerationInputSnapshot / transactions�?
  // 这些数据�?GENERATION_AFTER_COMMANDS 中被消费；MESSAGE_SENT 先于
  // GENERATION_AFTER_COMMANDS 触发，提前清空会导致召回拿不到用户输入�?
  // 真正的消费发生在 recall 执行后（runRecallController 内部）�?

  return lastRecallSentUserMessage;
}

function getMessageRecallRecord(messageIndex) {
  const chat = getContext()?.chat;
  return readPersistedRecallFromUserMessage(chat, messageIndex);
}

function debugWithThrottle(cache, key, ...args) {
  if (!globalThis.__stBmeDebugLoggingEnabled) return;
  const now = Date.now();
  const lastAt = cache.get(key) || 0;
  if (now - lastAt < PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS) return;
  cache.set(key, now);
  console.debug(...args);
}

function debugPersistedRecallUi(reason, details = null, throttleKey = reason) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    persistedRecallUiDiagnosticTimestamps,
    `ui:${throttleKey}`,
    `[ST-BME] Recall Card UI: ${reason}${suffix}`,
  );
}

function debugPersistedRecallPersistence(
  reason,
  details = null,
  throttleKey = reason,
) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    persistedRecallPersistDiagnosticTimestamps,
    `persist:${throttleKey}`,
    `[ST-BME] Recall Card persist: ${reason}${suffix}`,
  );
}

function buildRecallTargetCandidateHashes(candidateTexts = []) {
  const hashes = new Set();
  for (const text of candidateTexts) {
    const normalized = normalizeRecallInputText(text);
    if (!normalized) continue;
    const hash = hashRecallInput(normalized);
    if (hash) hashes.add(hash);
  }
  return hashes;
}

function doesChatUserMessageMatchRecallCandidates(message, candidateHashes) {
  if (!message?.is_user || !(candidateHashes instanceof Set) || !candidateHashes.size) {
    return false;
  }
  const normalizedMessage = normalizeRecallInputText(message?.mes || "");
  if (!normalizedMessage) return false;
  return candidateHashes.has(hashRecallInput(normalizedMessage));
}

function rebindRecallRecordToNewUserMessage(newUserMessageIndex) {
  const chat = getContext()?.chat;
  if (
    !Array.isArray(chat) ||
    !Number.isFinite(newUserMessageIndex) ||
    !chat[newUserMessageIndex]?.is_user
  ) {
    return;
  }
  if (readPersistedRecallFromUserMessage(chat, newUserMessageIndex)) {
    return;
  }
  const recentTransaction = findRecentGenerationRecallTransactionForChat();
  const recallResult = getGenerationRecallTransactionResult(recentTransaction);
  if (
    !recallResult ||
    recallResult.status !== "completed" ||
    !recallResult.didRecall ||
    !String(recallResult.injectionText || "").trim()
  ) {
    return;
  }
  const record = buildPersistedRecallRecord(
    {
      injectionText: String(recallResult.injectionText || "").trim(),
      selectedNodeIds: recallResult.selectedNodeIds || [],
      recallInput: String(
        recallResult.recallInput || recallResult.userMessage || "",
      ),
      recallSource: String(recallResult.source || ""),
      hookName: String(
        recallResult.hookName ||
          recentTransaction?.lastRecallMeta?.hookName ||
          "",
      ),
      tokenEstimate: estimateTokens(
        String(recallResult.injectionText || "").trim(),
      ),
      manuallyEdited: false,
    },
    null,
  );
  if (writePersistedRecallToUserMessage(chat, newUserMessageIndex, record)) {
    triggerChatMetadataSave(getContext(), { immediate: false });
  }
}

function resolveRecallPersistenceTargetUserMessageIndex(
  chat,
  {
    generationType = "normal",
    explicitTargetUserMessageIndex = null,
    candidateTexts = [],
    preferredRecord = null,
  } = {},
) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  const normalizedGenerationType =
    String(generationType || "normal").trim() || "normal";

  const explicitIndex = Number.isFinite(explicitTargetUserMessageIndex)
    ? Math.floor(Number(explicitTargetUserMessageIndex))
    : null;
  if (Number.isFinite(explicitIndex) && chat[explicitIndex]?.is_user) {
    return explicitIndex;
  }

  const candidateHashes = buildRecallTargetCandidateHashes(candidateTexts);
  const latestUserIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType: "history",
  });

  const hasFreshPreferredRecord = isFreshRecallInputRecord(preferredRecord);
  const preferredMessageId =
    hasFreshPreferredRecord && Number.isFinite(preferredRecord?.messageId)
      ? Math.floor(Number(preferredRecord.messageId))
      : null;

  if (
    Number.isFinite(preferredMessageId) &&
    chat[preferredMessageId]?.is_user &&
    (!candidateHashes.size ||
      doesChatUserMessageMatchRecallCandidates(
        chat[preferredMessageId],
        candidateHashes,
      ))
  ) {
    return preferredMessageId;
  }

  if (
    candidateHashes.size &&
    Number.isFinite(latestUserIndex) &&
    chat[latestUserIndex]?.is_user &&
    doesChatUserMessageMatchRecallCandidates(
      chat[latestUserIndex],
      candidateHashes,
    )
  ) {
    return latestUserIndex;
  }

  if (hasFreshPreferredRecord && candidateHashes.size) {
    for (let index = chat.length - 1; index >= 0; index--) {
      const message = chat[index];
      if (
        doesChatUserMessageMatchRecallCandidates(message, candidateHashes)
      ) {
        return index;
      }
    }
  }

  // 正常生成阶段里，ST 可能会在真正发送前改写用户文本
  // （命令展开、包装显示、助�?UI 处理等），导�?hash 已无法精确匹配�?
  // 这时仍应优先回绑到“当前最�?user 楼层”，否则召回记录虽然生成了，
  // �?Recall Card 会因为找不到目标楼层而消失�?
  if (
    normalizedGenerationType === "normal" &&
    Number.isFinite(latestUserIndex) &&
    chat[latestUserIndex]?.is_user
  ) {
    return latestUserIndex;
  }

  if (
    normalizedGenerationType === "normal" &&
    Number.isFinite(preferredMessageId) &&
    chat[preferredMessageId]?.is_user
  ) {
    return preferredMessageId;
  }

  if (
    normalizedGenerationType !== "normal" &&
    Number.isFinite(latestUserIndex) &&
    chat[latestUserIndex]?.is_user
  ) {
    return latestUserIndex;
  }

  return null;
}

function persistRecallInjectionRecord({
  recallInput = {},
  result = {},
  injectionText = "",
  tokenEstimate = 0,
} = {}) {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return null;

  const generationType =
    String(recallInput?.generationType || "normal").trim() || "normal";
  let resolvedTargetIndex = resolveRecallPersistenceTargetUserMessageIndex(
    chat,
    {
      generationType,
      explicitTargetUserMessageIndex: recallInput?.targetUserMessageIndex,
      candidateTexts: [
        recallInput?.userMessage,
        recallInput?.overrideUserMessage,
        lastRecallSentUserMessage?.text,
      ],
      preferredRecord: lastRecallSentUserMessage,
    },
  );

  if (!Number.isFinite(resolvedTargetIndex)) {
    debugPersistedRecallPersistence("目标 user 楼层解析失败", {
      generationType,
      explicitTargetUserMessageIndex: recallInput?.targetUserMessageIndex,
      lastSentUserMessageId: lastRecallSentUserMessage?.messageId,
      recallInputSource: String(recallInput?.source || ""),
    });
    return null;
  }

  if (!chat[resolvedTargetIndex]?.is_user) {
    debugPersistedRecallPersistence("目标楼层不是 user 消息，跳过持久化", {
      targetUserMessageIndex: resolvedTargetIndex,
      messageKeys: Object.keys(chat[resolvedTargetIndex] || {}),
    });
    return null;
  }

  const record = buildPersistedRecallRecord(
    {
      injectionText,
      selectedNodeIds: result?.selectedNodeIds || [],
      recallInput: String(recallInput?.userMessage || ""),
      recallSource: String(recallInput?.source || ""),
      hookName: String(recallInput?.hookName || ""),
      tokenEstimate,
      manuallyEdited: false,
    },
    readPersistedRecallFromUserMessage(chat, resolvedTargetIndex),
  );
  if (!String(record?.injectionText || "").trim()) {
    debugPersistedRecallPersistence("无有效 injectionText，跳过持久化", {
      targetUserMessageIndex: resolvedTargetIndex,
      selectedNodeCount: Array.isArray(result?.selectedNodeIds)
        ? result.selectedNodeIds.length
        : 0,
    });
    return null;
  }
  if (!writePersistedRecallToUserMessage(chat, resolvedTargetIndex, record)) {
    debugPersistedRecallPersistence("写入 user 楼层失败", {
      targetUserMessageIndex: resolvedTargetIndex,
    });
    return null;
  }

  triggerChatMetadataSave(getContext(), { immediate: false });
  schedulePersistedRecallMessageUiRefresh();
  debugPersistedRecallPersistence(
    "召回记录已写入 user 楼层",
    {
      targetUserMessageIndex: resolvedTargetIndex,
      injectionTextLength: String(record?.injectionText || "").length,
      selectedNodeCount: Array.isArray(record?.selectedNodeIds)
        ? record.selectedNodeIds.length
        : 0,
    },
    `persist-success:${resolvedTargetIndex}`,
  );
  return {
    index: resolvedTargetIndex,
    record,
  };
}

function ensurePersistedRecallRecordForGeneration({
  generationType = "normal",
  recallResult = null,
  transaction = null,
  recallOptions = null,
  hookName = "",
} = {}) {
  const injectionText = String(recallResult?.injectionText || "").trim();
  if (
    recallResult?.status !== "completed" ||
    !recallResult?.didRecall ||
    !injectionText
  ) {
    return {
      persisted: false,
      reason: "no-fresh-recall",
      targetUserMessageIndex: null,
      record: null,
    };
  }

  const chat = getContext()?.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    return {
      persisted: false,
      reason: "missing-chat",
      targetUserMessageIndex: null,
      record: null,
    };
  }

  const frozenRecallOptions =
    transaction?.frozenRecallOptions &&
    typeof transaction.frozenRecallOptions === "object"
      ? transaction.frozenRecallOptions
      : null;
  const targetUserMessageIndex = resolveRecallPersistenceTargetUserMessageIndex(
    chat,
    {
      generationType,
      explicitTargetUserMessageIndex:
        frozenRecallOptions?.targetUserMessageIndex ??
        recallOptions?.targetUserMessageIndex ??
        recallOptions?.explicitTargetUserMessageIndex ??
        null,
      candidateTexts: [
        frozenRecallOptions?.overrideUserMessage,
        frozenRecallOptions?.userMessage,
        recallOptions?.overrideUserMessage,
        recallOptions?.userMessage,
        recallResult?.recallInput,
        recallResult?.userMessage,
        ...(Array.isArray(recallResult?.sourceCandidates)
          ? recallResult.sourceCandidates.map((candidate) => candidate?.text)
          : []),
        lastRecallSentUserMessage?.text,
      ],
      preferredRecord: lastRecallSentUserMessage,
    },
  );

  if (
    !Number.isFinite(targetUserMessageIndex) ||
    !chat[targetUserMessageIndex]?.is_user
  ) {
    return {
      persisted: false,
      reason: "target-unresolved",
      targetUserMessageIndex: Number.isFinite(targetUserMessageIndex)
        ? targetUserMessageIndex
        : null,
      record: null,
    };
  }

  const selectedNodeIds = normalizeRecallNodeIdList(
    recallResult?.selectedNodeIds || [],
  );
  const existingRecord = readPersistedRecallFromUserMessage(
    chat,
    targetUserMessageIndex,
  );
  if (
    existingRecord &&
    String(existingRecord.injectionText || "").trim() === injectionText &&
    areRecallNodeIdListsEqual(existingRecord.selectedNodeIds, selectedNodeIds)
  ) {
    return {
      persisted: false,
      reason: "already-up-to-date",
      targetUserMessageIndex,
      record: existingRecord,
    };
  }

  const nextRecord = buildPersistedRecallRecord(
    {
      injectionText,
      selectedNodeIds,
      recallInput: String(
        recallResult?.recallInput ||
          recallResult?.userMessage ||
          frozenRecallOptions?.overrideUserMessage ||
          recallOptions?.overrideUserMessage ||
          recallOptions?.userMessage ||
          "",
      ),
      recallSource: String(
        recallResult?.source ||
          frozenRecallOptions?.lockedSource ||
          frozenRecallOptions?.overrideSource ||
          recallOptions?.overrideSource ||
          "",
      ),
      hookName: String(
        hookName ||
          recallResult?.hookName ||
          frozenRecallOptions?.hookName ||
          recallOptions?.hookName ||
          "",
      ),
      tokenEstimate: estimateTokens(injectionText),
      manuallyEdited: false,
    },
    existingRecord,
  );

  if (!writePersistedRecallToUserMessage(chat, targetUserMessageIndex, nextRecord)) {
    return {
      persisted: false,
      reason: "write-failed",
      targetUserMessageIndex,
      record: null,
    };
  }

  triggerChatMetadataSave(getContext(), { immediate: false });
  schedulePersistedRecallMessageUiRefresh();
  debugPersistedRecallPersistence(
    "最终阶段已补写召回记录",
    {
      targetUserMessageIndex,
      hookName:
        String(
          hookName ||
            recallResult?.hookName ||
            frozenRecallOptions?.hookName ||
            recallOptions?.hookName ||
            "",
        ) || "",
      injectionTextLength: injectionText.length,
      selectedNodeCount: selectedNodeIds.length,
    },
    `finalize-persist:${targetUserMessageIndex}`,
  );

  return {
    persisted: true,
    reason: "backfilled",
    targetUserMessageIndex,
    record: nextRecord,
  };
}

function removeMessageRecallRecord(messageIndex) {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return false;
  const removed = removePersistedRecallFromUserMessage(chat, messageIndex);
  if (removed) {
    triggerChatMetadataSave(getContext(), { immediate: false });
  }
  return removed;
}

function editMessageRecallRecord(messageIndex, nextInjectionText) {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return null;
  const current = readPersistedRecallFromUserMessage(chat, messageIndex);
  if (!current) return null;

  const normalizedText = normalizeRecallInputText(nextInjectionText);
  if (!normalizedText) return null;
  const nowIso = new Date().toISOString();
  const nextRecord = {
    ...current,
    injectionText: normalizedText,
    tokenEstimate: estimateTokens(normalizedText),
    updatedAt: nowIso,
  };
  if (!writePersistedRecallToUserMessage(chat, messageIndex, nextRecord)) {
    return null;
  }
  const edited = markPersistedRecallManualEdit(
    chat,
    messageIndex,
    true,
    nowIso,
  );
  if (!edited) return null;

  triggerChatMetadataSave(getContext(), { immediate: false });
  return edited;
}

function rewriteRecallPayloadWithInjection(
  promptData = null,
  injectionText = "",
) {
  const normalizedInjectionText = normalizeRecallInputText(injectionText);
  if (!normalizedInjectionText) {
    return {
      applied: false,
      path: "",
      field: "",
      reason: "empty-injection-text",
    };
  }

  const finalMesSend = Array.isArray(promptData?.finalMesSend)
    ? promptData.finalMesSend
    : null;
  if (Array.isArray(finalMesSend) && finalMesSend.length > 0) {
    for (let index = finalMesSend.length - 1; index >= 0; index--) {
      const entry = finalMesSend[index];
      if (!entry || typeof entry !== "object") continue;
      if (entry.injected === true) continue;
      const messageText = normalizeRecallInputText(
        entry.message || entry.mes || entry.content || "",
      );
      if (!messageText) continue;

      entry.extensionPrompts = Array.isArray(entry.extensionPrompts)
        ? entry.extensionPrompts
        : [];
      const alreadyPresent = entry.extensionPrompts.some((chunk) =>
        String(chunk || "").includes(normalizedInjectionText),
      );
      if (!alreadyPresent) {
        entry.extensionPrompts.push(`${normalizedInjectionText}\n`);
      }
      return {
        applied: true,
        path: "finalMesSend",
        field: `finalMesSend[${index}].extensionPrompts`,
        reason: alreadyPresent
          ? "rewrite-already-present"
          : "finalMesSend-extensionPrompt-appended",
        targetIndex: index,
      };
    }

    return {
      applied: false,
      path: "finalMesSend",
      field: "",
      reason: "no-rewritable-finalMesSend-entry",
    };
  }

  if (
    typeof promptData?.combinedPrompt === "string" &&
    promptData.combinedPrompt.trim()
  ) {
    if (!promptData.combinedPrompt.includes(normalizedInjectionText)) {
      promptData.combinedPrompt = `${normalizedInjectionText}\n\n${promptData.combinedPrompt}`;
    }
    return {
      applied: true,
      path: "combinedPrompt",
      field: "combinedPrompt",
      reason: "combinedPrompt-prefixed",
    };
  }

  if (typeof promptData?.prompt === "string" && promptData.prompt.trim()) {
    if (!promptData.prompt.includes(normalizedInjectionText)) {
      promptData.prompt = `${normalizedInjectionText}\n\n${promptData.prompt}`;
    }
    return {
      applied: true,
      path: "prompt",
      field: "prompt",
      reason: "prompt-prefixed",
    };
  }

  return {
    applied: false,
    path: "",
    field: "",
    reason: "prompt-payload-unavailable",
  };
}

function readGenerationRecallTransactionFinalResolution(transaction) {
  return transaction?.finalResolution || null;
}

function storeGenerationRecallTransactionFinalResolution(
  transaction,
  finalResolution = null,
) {
  if (!transaction?.id) return transaction;
  transaction.finalResolution = finalResolution ? { ...finalResolution } : null;
  transaction.updatedAt = Date.now();
  generationRecallTransactions.set(transaction.id, transaction);
  return transaction;
}

function applyFinalRecallInjectionForGeneration({
  generationType = "normal",
  freshRecallResult = null,
  transaction = null,
  promptData = null,
  hookName = "",
} = {}) {
  const existingFinalResolution =
    readGenerationRecallTransactionFinalResolution(transaction);
  if (existingFinalResolution) {
    return existingFinalResolution;
  }

  const recallResult =
    freshRecallResult ||
    getGenerationRecallTransactionResult(transaction) ||
    null;
  const deliveryMode =
    String(
      recallResult?.deliveryMode ||
        transaction?.lastDeliveryMode ||
        resolveGenerationRecallDeliveryMode(
          hookName,
          generationType,
          transaction?.frozenRecallOptions || {},
        ),
    ).trim() || "immediate";
  const chat = getContext()?.chat;

  let transport = {
    applied: false,
    source: "none",
    mode: "none",
  };
  let targetUserMessageIndex = null;
  let resolved = {
    source: "none",
    injectionText: "",
    record: null,
  };
  const rewrite = {
    applied: false,
    path: "",
    field: "",
    reason: "no-recall-source",
  };
  let applicationMode = "none";

  if (!Array.isArray(chat)) {
    transport = applyModuleInjectionPrompt("", getSettings()) || transport;
    const emptyResolution = {
      source: "none",
      isFallback: false,
      targetUserMessageIndex: null,
      usedText: "",
      deliveryMode,
      applicationMode: "none",
      rewrite,
      transport,
    };
    storeGenerationRecallTransactionFinalResolution(
      transaction,
      emptyResolution,
    );
    return emptyResolution;
  }

  const ensuredPersistence = ensurePersistedRecallRecordForGeneration({
    generationType,
    recallResult,
    transaction,
    recallOptions: transaction?.frozenRecallOptions || null,
    hookName,
  });

  targetUserMessageIndex = resolveRecallPersistenceTargetUserMessageIndex(chat, {
    generationType,
    explicitTargetUserMessageIndex:
      transaction?.frozenRecallOptions?.targetUserMessageIndex,
    candidateTexts: [
      transaction?.frozenRecallOptions?.overrideUserMessage,
      recallResult?.recallInput,
      recallResult?.userMessage,
      recallResult?.sourceCandidates?.[0]?.text,
      lastRecallSentUserMessage?.text,
    ],
    preferredRecord: lastRecallSentUserMessage,
  });
  if (Number.isFinite(ensuredPersistence?.targetUserMessageIndex)) {
    targetUserMessageIndex = ensuredPersistence.targetUserMessageIndex;
  }

  const persistedRecord = Number.isFinite(targetUserMessageIndex)
    ? readPersistedRecallFromUserMessage(chat, targetUserMessageIndex)
    : null;
  resolved = resolveFinalRecallInjectionSource({
    freshRecallResult: recallResult,
    persistedRecord,
  });

  if (resolved.source === "fresh" && deliveryMode === "deferred") {
    const rewriteResult = rewriteRecallPayloadWithInjection(
      promptData,
      resolved.injectionText || "",
    );
    Object.assign(rewrite, rewriteResult);
    lastInjectionContent = resolved.injectionText || "";
    if (rewriteResult.applied) {
      applicationMode = "rewrite";
      transport = clearLiveRecallInjectionPromptForRewrite() || {
        applied: false,
        source: "rewrite-cleared",
        mode: "rewrite-cleared",
      };
      runtimeStatus = createUiStatus(
        "召回已改写",
        `本轮发送载荷已 rewrite · ${rewriteResult.path || rewriteResult.field || "payload"}`,
        "success",
      );
    } else {
      applicationMode = "fallback-injection";
      transport =
        applyModuleInjectionPrompt(
          resolved.injectionText || "",
          getSettings(),
        ) || transport;
      runtimeStatus = createUiStatus(
        "召回回退",
        `rewrite 未命中，已回退注入 · ${rewriteResult.reason}`,
        "warning",
      );
    }
  } else if (resolved.source === "fresh") {
    applicationMode = "injection";
    transport =
      applyModuleInjectionPrompt(resolved.injectionText || "", getSettings()) ||
      transport;
    lastInjectionContent = resolved.injectionText || "";
    rewrite.reason = "immediate-injection";
    runtimeStatus = createUiStatus(
      "召回已注入",
      "本轮已使用最新召回结果",
      "success",
    );
  } else if (resolved.source === "persisted") {
    applicationMode = "persisted-injection";
    transport =
      applyModuleInjectionPrompt(resolved.injectionText || "", getSettings()) ||
      transport;
    lastInjectionContent = resolved.injectionText || "";
    rewrite.reason = "persisted-record-fallback";
    runtimeStatus = createUiStatus(
      "召回回退",
      "已使用消息楼层持久化注入",
      "info",
    );
  } else {
    transport = applyModuleInjectionPrompt("", getSettings()) || transport;
    lastInjectionContent = "";
    runtimeStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }

  if (
    resolved.source === "persisted" &&
    Number.isFinite(targetUserMessageIndex)
  ) {
    bumpPersistedRecallGenerationCount(chat, targetUserMessageIndex);
    triggerChatMetadataSave(getContext(), { immediate: false });
  }

  recordInjectionSnapshot("recall", {
    taskType: "recall",
    source:
      String(
        recallResult?.source ||
          transaction?.frozenRecallOptions?.lockedSource ||
          transaction?.frozenRecallOptions?.overrideSource ||
          "",
      ).trim() || "unknown",
    sourceLabel:
      String(
        recallResult?.sourceLabel ||
          transaction?.frozenRecallOptions?.lockedSourceLabel ||
          transaction?.frozenRecallOptions?.overrideSourceLabel ||
          "",
      ).trim() || "未知",
    reason:
      String(
        recallResult?.reason ||
          transaction?.frozenRecallOptions?.lockedReason ||
          transaction?.frozenRecallOptions?.overrideReason ||
          "",
      ).trim() || "final-application",
    sourceCandidates: Array.isArray(recallResult?.sourceCandidates)
      ? recallResult.sourceCandidates.map((candidate) => ({ ...candidate }))
      : Array.isArray(transaction?.frozenRecallOptions?.sourceCandidates)
        ? transaction.frozenRecallOptions.sourceCandidates.map((candidate) => ({
            ...candidate,
          }))
        : [],
    hookName: String(hookName || recallResult?.hookName || "").trim(),
    selectedNodeIds: recallResult?.selectedNodeIds || [],
    retrievalMeta: recallResult?.retrievalMeta || {},
    llmMeta: recallResult?.llmMeta || {},
    stats: recallResult?.stats || {},
    injectionText: resolved.injectionText || "",
    deliveryMode,
    applicationMode,
    transport,
    rewrite,
    targetUserMessageIndex,
    sourceKind: resolved.source,
  });

  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh();

  const finalResolution = {
    source: resolved.source,
    isFallback:
      resolved.source === "persisted" ||
      applicationMode === "fallback-injection",
    targetUserMessageIndex,
    usedText: resolved.injectionText || "",
    deliveryMode,
    applicationMode,
    rewrite,
    transport,
  };
  storeGenerationRecallTransactionFinalResolution(transaction, finalResolution);
  return finalResolution;
}

function clearLiveRecallInjectionPromptForRewrite() {
  try {
    return (
      applyModuleInjectionPrompt("", getSettings()) || {
        applied: false,
        source: "rewrite-clear",
        mode: "rewrite-clear",
      }
    );
  } catch (error) {
    console.warn("[ST-BME] 清理 rewrite 前旧注入失败:", error);
    return {
      applied: false,
      source: "rewrite-clear-error",
      mode: "rewrite-clear-error",
      error: error instanceof Error ? error.message : String(error || ""),
    };
  }
}

function clearPersistedRecallMessageUiObserver() {
  try {
    persistedRecallUiRefreshObserver?.disconnect?.();
  } catch (error) {
    console.warn("[ST-BME] Recall Card UI observer disconnect 失败:", error);
  }
  persistedRecallUiRefreshObserver = null;
}

function isDomNodeAttached(node) {
  if (!node) return false;
  if (node.isConnected === true) return true;
  return typeof document?.contains === "function"
    ? document.contains(node)
    : true;
}

function cleanupRecallCardElement(cardElement) {
  if (!cardElement) return;
  const messageElement = cardElement.closest?.(".mes") || null;
  if (messageElement) {
    restoreRecallCardUserInputDisplay(messageElement);
  }
  try {
    cardElement._bmeDestroyRenderer?.();
  } catch (error) {
    console.warn("[ST-BME] Recall Card renderer 清理失败:", error);
  }
  cardElement.remove?.();
}

function cleanupLegacyRecallBadges(messageElement) {
  if (!messageElement?.querySelectorAll) return;
  const oldBadges = Array.from(
    messageElement.querySelectorAll(".st-bme-recall-badge") || [],
  );
  for (const oldBadge of oldBadges) oldBadge.remove();
}

function cleanupRecallArtifacts(messageElement, keepMessageIndex = null) {
  if (!messageElement?.querySelectorAll) return;

  cleanupLegacyRecallBadges(messageElement);
  restoreRecallCardUserInputDisplay(messageElement);

  const existingCards = Array.from(
    messageElement.querySelectorAll(".bme-recall-card") || [],
  );
  for (const card of existingCards) {
    if (
      keepMessageIndex !== null &&
      card.dataset?.messageIndex === String(keepMessageIndex)
    ) {
      continue;
    }
    cleanupRecallCardElement(card);
  }
}

function parseStableMessageIndex(candidate) {
  const normalized = String(candidate ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveMessageIndexFromElement(messageElement) {
  if (!messageElement) return null;

  const candidates = [
    messageElement.getAttribute?.("mesid"),
    messageElement.getAttribute?.("data-mesid"),
    messageElement.getAttribute?.("data-message-id"),
    messageElement.dataset?.mesid,
    messageElement.dataset?.messageId,
  ];

  for (const candidate of candidates) {
    const parsed = parseStableMessageIndex(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

function resolveRecallCardAnchor(messageElement) {
  if (!messageElement || !isDomNodeAttached(messageElement)) return null;
  const mesBlock = messageElement.querySelector?.(".mes_block");
  if (isDomNodeAttached(mesBlock)) return mesBlock;

  const mesTextParent =
    messageElement.querySelector?.(".mes_text")?.parentElement;
  if (isDomNodeAttached(mesTextParent)) return mesTextParent;

  return isDomNodeAttached(messageElement) ? messageElement : null;
}

function getRecallMessageElementPriority(messageElement) {
  if (!messageElement || !isDomNodeAttached(messageElement)) return -1;

  let priority = 0;
  const anchor = resolveRecallCardAnchor(messageElement);
  if (anchor === messageElement) priority += 1;
  else if (anchor) priority += 3;

  if (messageElement.querySelector?.(".mes_text")) priority += 1;
  if (messageElement.classList?.contains("last_mes")) priority += 2;
  if (
    messageElement.getAttribute?.("is_user") === "true" ||
    messageElement.dataset?.isUser === "true" ||
    messageElement.classList?.contains("user_mes")
  ) {
    priority += 1;
  }

  return priority;
}

function normalizeRecallCardUserInputDisplayMode(mode) {
  const normalized = String(mode || "").trim();
  if (
    normalized === "off" ||
    normalized === "beautify_only" ||
    normalized === "mirror"
  ) {
    return normalized;
  }
  return "beautify_only";
}

function applyRecallCardUserInputDisplayMode(messageElement, mode) {
  if (!messageElement?.querySelector) return;
  const userTextElement = messageElement.querySelector(".mes_text");
  if (!userTextElement) return;
  userTextElement.classList.toggle(
    "bme-hide-original-user-text",
    normalizeRecallCardUserInputDisplayMode(mode) === "beautify_only",
  );
}

function restoreRecallCardUserInputDisplay(messageElement) {
  if (!messageElement?.querySelector) return;
  const userTextElement = messageElement.querySelector(".mes_text");
  userTextElement?.classList?.remove("bme-hide-original-user-text");
}

function buildPersistedRecallUiRetryDelays(initialDelayMs = 0) {
  const normalizedInitial = Math.max(
    0,
    Number.parseInt(initialDelayMs, 10) || 0,
  );
  if (!normalizedInitial)
    return [...PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS];
  return [
    normalizedInitial,
    ...PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS.filter(
      (delay) => delay > normalizedInitial,
    ),
  ];
}

function summarizePersistedRecallRefreshStatus(summary) {
  if (summary.waitingMessageIndices.length > 0) return "waiting_dom";
  if (summary.anchorFailureIndices.length > 0) return "missing_message_anchor";
  if (summary.renderedCount > 0) return "rendered";
  if (summary.skippedNonUserIndices.length > 0) return "skipped_non_user";
  if (summary.persistedRecordCount === 0) return "missing_recall_record";
  return "missing_message_anchor";
}

function refreshPersistedRecallMessageUi() {
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || typeof document?.getElementById !== "function") {
    return {
      status: "missing_chat_root",
      renderedCount: 0,
      persistedRecordCount: 0,
      waitingMessageIndices: [],
      anchorFailureIndices: [],
      skippedNonUserIndices: [],
    };
  }

  const chatRoot = document.getElementById("chat");
  if (!chatRoot) {
    debugPersistedRecallUi("缺少 #chat 根节点");
    return {
      status: "missing_chat_root",
      renderedCount: 0,
      persistedRecordCount: 0,
      waitingMessageIndices: [],
      anchorFailureIndices: [],
      skippedNonUserIndices: [],
    };
  }

  const settings = getSettings();
  const themeName = settings?.panelTheme || "crimson";
  const recallCardUserInputDisplayMode =
    normalizeRecallCardUserInputDisplayMode(
      settings?.recallCardUserInputDisplayMode,
    );
  const callbacks = getRecallCardCallbacks();
  const messageElementMap = new Map();
  const messageElements = Array.from(chatRoot.querySelectorAll(".mes"));
  for (const messageElement of messageElements) {
    cleanupLegacyRecallBadges(messageElement);
    const messageIndex = resolveMessageIndexFromElement(messageElement);
    if (!Number.isFinite(messageIndex)) {
      debugPersistedRecallUi(
        "消息 DOM 缺少稳定索引属性，跳过挂载",
        {
          className: messageElement.className || "",
        },
        "missing-stable-message-index",
      );
      continue;
    }
    if (messageElementMap.has(messageIndex)) {
      const previousElement = messageElementMap.get(messageIndex) || null;
      const previousPriority = getRecallMessageElementPriority(previousElement);
      const nextPriority = getRecallMessageElementPriority(messageElement);
      const shouldReplace = nextPriority >= previousPriority;
      debugPersistedRecallUi(
        "检测到重复消息 DOM 索引，已挑选更可靠的锚点",
        {
          messageIndex,
          previousPriority,
          nextPriority,
          replaced: shouldReplace,
        },
        `duplicate-message-index:${messageIndex}`,
      );
      if (shouldReplace) {
        cleanupRecallArtifacts(previousElement);
        messageElementMap.set(messageIndex, messageElement);
      } else {
        cleanupRecallArtifacts(messageElement);
      }
      continue;
    }
    messageElementMap.set(messageIndex, messageElement);
  }

  const summary = {
    status: "missing_recall_record",
    renderedCount: 0,
    persistedRecordCount: 0,
    waitingMessageIndices: [],
    anchorFailureIndices: [],
    skippedNonUserIndices: [],
  };

  for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
    const message = chat[messageIndex];
    const messageElement = messageElementMap.get(messageIndex) || null;
    const existingCard =
      messageElement?.querySelector?.(
        `.bme-recall-card[data-message-index="${messageIndex}"]`,
      ) || null;

    if (!message?.is_user) {
      if (messageElement) {
        restoreRecallCardUserInputDisplay(messageElement);
      }
      if (existingCard) cleanupRecallCardElement(existingCard);
      const unexpectedRecord = readPersistedRecallFromUserMessage(
        chat,
        messageIndex,
      );
      if (unexpectedRecord) {
        summary.skippedNonUserIndices.push(messageIndex);
        debugPersistedRecallUi(
          "非 user 楼层存在持久召回记录，已跳过挂载",
          {
            messageIndex,
          },
          `skipped-non-user:${messageIndex}`,
        );
      }
      continue;
    }

    const record = readPersistedRecallFromUserMessage(chat, messageIndex);
    if (!record?.injectionText) {
      if (messageElement) {
        restoreRecallCardUserInputDisplay(messageElement);
      }
      if (existingCard) cleanupRecallCardElement(existingCard);
      continue;
    }

    summary.persistedRecordCount += 1;
    if (!messageElement) {
      summary.waitingMessageIndices.push(messageIndex);
      debugPersistedRecallUi(
        "目标 user 楼层 DOM 未就绪，等待后续刷新",
        {
          messageIndex,
        },
        `waiting-dom:${messageIndex}`,
      );
      continue;
    }

    const anchor = resolveRecallCardAnchor(messageElement);
    if (!anchor) {
      restoreRecallCardUserInputDisplay(messageElement);
      cleanupRecallCardElement(existingCard);
      summary.anchorFailureIndices.push(messageIndex);
      debugPersistedRecallUi(
        "目标 user 楼层锚点解析失败，跳过挂载",
        {
          messageIndex,
        },
        `missing-anchor:${messageIndex}`,
      );
      continue;
    }

    cleanupRecallArtifacts(messageElement, messageIndex);
    const currentCard =
      messageElement.querySelector?.(
        `.bme-recall-card[data-message-index="${messageIndex}"]`,
      ) || null;

    if (currentCard) {
      updateRecallCardData(currentCard, record, {
        userMessageText: message.mes || "",
        userInputDisplayMode: recallCardUserInputDisplayMode,
        graph: currentGraph,
        themeName,
        callbacks,
      });
    } else {
      const card = createRecallCardElement({
        messageIndex,
        record,
        userMessageText: message.mes || "",
        userInputDisplayMode: recallCardUserInputDisplayMode,
        graph: currentGraph,
        themeName,
        callbacks,
      });
      anchor.appendChild(card);
    }
    applyRecallCardUserInputDisplayMode(
      messageElement,
      recallCardUserInputDisplayMode,
    );
    summary.renderedCount += 1;
  }

  summary.status = summarizePersistedRecallRefreshStatus(summary);
  if (summary.status === "missing_recall_record") {
    debugPersistedRecallUi("当前无有效持久召回记录可渲染");
  } else if (summary.renderedCount > 0) {
    debugPersistedRecallUi(
      "Recall Card 挂载完成",
      {
        renderedCount: summary.renderedCount,
        persistedRecordCount: summary.persistedRecordCount,
        waitingDom: summary.waitingMessageIndices.length,
      },
      `rendered:${summary.renderedCount}`,
    );
  }
  return summary;
}

function getRecallCardCallbacks() {
  return {
    onEdit: (messageIndex) => {
      const record = getMessageRecallRecord(messageIndex);
      if (!record) return;
      openRecallSidebar({
        mode: "edit",
        messageIndex,
        record,
        node: null,
        graph: currentGraph,
        callbacks: {
          onSave: (idx, newText) => {
            const edited = editMessageRecallRecord(idx, newText);
            if (edited) {
              toastr.success("已保存手动编辑");
            } else {
              toastr.warning("编辑失败：注入文本不能为空");
            }
            schedulePersistedRecallMessageUiRefresh();
          },
          estimateTokens,
        },
      });
    },
    onDelete: (messageIndex) => {
      if (removeMessageRecallRecord(messageIndex)) {
        toastr.success("已删除持久召回注入");
        schedulePersistedRecallMessageUiRefresh();
      }
    },
    onRerunRecall: async (messageIndex) => {
      const result = await rerunRecallForMessage(messageIndex);
      if (result?.status === "completed") {
        toastr.success("重新召回完成");
      }
      schedulePersistedRecallMessageUiRefresh();
    },
    onNodeClick: (messageIndex, node) => {
      const record = getMessageRecallRecord(messageIndex);
      if (!record) return;
      openRecallSidebar({
        mode: "view",
        messageIndex,
        record,
        node,
        graph: currentGraph,
        callbacks: {
          onSave: (idx, newText) => {
            const edited = editMessageRecallRecord(idx, newText);
            if (edited) toastr.success("已保存手动编辑");
            else toastr.warning("编辑失败：注入文本不能为空");
            schedulePersistedRecallMessageUiRefresh();
          },
          estimateTokens,
        },
      });
    },
  };
}

function armPersistedRecallMessageUiObserver(sessionId, runAttempt) {
  clearPersistedRecallMessageUiObserver();
  const chatRoot = document?.getElementById?.("chat");
  const ObserverCtor = globalThis.MutationObserver;
  if (!chatRoot || typeof ObserverCtor !== "function") return false;

  persistedRecallUiRefreshObserver = new ObserverCtor(() => {
    if (sessionId !== persistedRecallUiRefreshSession) return;
    clearPersistedRecallMessageUiObserver();
    runAttempt();
  });
  persistedRecallUiRefreshObserver.observe(chatRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "mesid",
      "data-mesid",
      "data-message-id",
      "class",
      "is_user",
    ],
  });
  return true;
}

function schedulePersistedRecallMessageUiRefresh(delayMs = 0) {
  clearTimeout(persistedRecallUiRefreshTimer);
  clearPersistedRecallMessageUiObserver();

  const retryDelays = buildPersistedRecallUiRetryDelays(delayMs);
  const sessionId = ++persistedRecallUiRefreshSession;
  let attemptIndex = 0;

  const runAttempt = () => {
    if (sessionId !== persistedRecallUiRefreshSession) return;
    if (persistedRecallUiRefreshTimer) {
      clearTimeout(persistedRecallUiRefreshTimer);
      persistedRecallUiRefreshTimer = null;
    }

    const summary = refreshPersistedRecallMessageUi();

    const shouldRetryForPending =
      (summary.status === "missing_chat_root" ||
        summary.status === "waiting_dom" ||
        summary.status === "missing_message_anchor") &&
      attemptIndex < retryDelays.length - 1;

    // 勿在「已成功渲染」时长期�?MutationObserver�?chat �?class/流式更新会疯狂触�?
    // runAttempt，造成满屏刷新与日志；显式事件（USER_MESSAGE_RENDERED 等）仍会 schedule 刷新�?
    const shouldWatchForRepaint = false;

    if (!shouldRetryForPending && !shouldWatchForRepaint) {
      clearPersistedRecallMessageUiObserver();
      return;
    }

    armPersistedRecallMessageUiObserver(sessionId, runAttempt);
    if (shouldRetryForPending) {
      attemptIndex += 1;
      persistedRecallUiRefreshTimer = setTimeout(
        runAttempt,
        retryDelays[attemptIndex],
      );
      return;
    }

    const lingerMs = retryDelays[retryDelays.length - 1] || 0;
    if (lingerMs <= 0) {
      clearPersistedRecallMessageUiObserver();
      return;
    }
    persistedRecallUiRefreshTimer = setTimeout(() => {
      if (sessionId !== persistedRecallUiRefreshSession) return;
      clearPersistedRecallMessageUiObserver();
      persistedRecallUiRefreshTimer = null;
    }, lingerMs);
  };

  persistedRecallUiRefreshTimer = setTimeout(
    runAttempt,
    retryDelays[attemptIndex],
  );
}

function cleanupPersistedRecallMessageUi() {
  clearTimeout(persistedRecallUiRefreshTimer);
  persistedRecallUiRefreshTimer = null;
  clearPersistedRecallMessageUiObserver();
  const chatRoot = document.getElementById("chat");
  if (!chatRoot?.querySelectorAll) return;
  for (const messageElement of Array.from(chatRoot.querySelectorAll(".mes"))) {
    cleanupRecallArtifacts(messageElement);
  }
}

async function rerunRecallForMessage(messageIndex) {
  const chat = getContext()?.chat;
  const message = Array.isArray(chat) ? chat[messageIndex] : null;
  cleanupPersistedRecallMessageUi();
  if (!message?.is_user) {
    toastr.info("仅用户消息支持重新召回");
    return null;
  }

  const userMessage = normalizeRecallInputText(message.mes || "");
  if (!userMessage) {
    toastr.info("该楼层内容为空，无法重新召回");
    return null;
  }

  const result = await runRecall({
    overrideUserMessage: userMessage,
    overrideSource: "message-floor-rerecall",
    overrideSourceLabel: `用户楼层 ${messageIndex}`,
    generationType: "history",
    targetUserMessageIndex: messageIndex,
    includeSyntheticUserMessage: false,
    hookName: "MESSAGE_RECALL_BADGE_RERUN",
  });
  applyFinalRecallInjectionForGeneration({
    generationType: "history",
    freshRecallResult: result,
  });
  return result;
}

function getSendTextareaValue() {
  return String(document.getElementById("send_textarea")?.value ?? "");
}

function scheduleSendIntentHookRetry(delayMs = 400) {
  return scheduleSendIntentHookRetryController(
    {
      clearTimeout,
      getSendIntentHookRetryTimer: () => sendIntentHookRetryTimer,
      installSendIntentHooks,
      setSendIntentHookRetryTimer: (timer) => {
        sendIntentHookRetryTimer = timer;
      },
      setTimeout,
    },
    delayMs,
  );
}

function registerBeforeCombinePrompts(listener) {
  return registerBeforeCombinePromptsController(
    {
      console,
      eventSource,
      eventTypes: event_types,
      getEventMakeFirst: () => globalThis.eventMakeFirst,
    },
    listener,
  );
}

function registerGenerationAfterCommands(listener) {
  return registerGenerationAfterCommandsController(
    {
      console,
      eventSource,
      eventTypes: event_types,
      getEventMakeFirst: () => globalThis.eventMakeFirst,
    },
    listener,
  );
}

function installSendIntentHooks() {
  return installSendIntentHooksController({
    console,
    consumeSendIntentHookCleanup: () =>
      sendIntentHookCleanup.splice(0, sendIntentHookCleanup.length),
    document,
    getSendTextareaValue,
    pushSendIntentHookCleanup: (cleanup) => {
      sendIntentHookCleanup.push(cleanup);
    },
    recordRecallSendIntent,
    scheduleSendIntentHookRetry,
  });
}

// ==================== 设置管理 ====================

function getSettings() {
  const mergedSettings = mergePersistedSettings(
    extension_settings[MODULE_NAME] || {},
  );
  const migrated = migrateLegacyTaskProfiles(mergedSettings);
  mergedSettings.taskProfilesVersion = migrated.taskProfilesVersion;
  mergedSettings.taskProfiles = migrated.taskProfiles;
  const regexMigration = migratePerTaskRegexToGlobal(mergedSettings);
  if (regexMigration.changed) {
    mergedSettings.globalTaskRegex = regexMigration.settings.globalTaskRegex;
    mergedSettings.taskProfiles = regexMigration.settings.taskProfiles;
  }
  extension_settings[MODULE_NAME] = mergedSettings;
  globalThis.__stBmeDebugLoggingEnabled = Boolean(
    mergedSettings.debugLoggingEnabled,
  );
  return mergedSettings;
}

function getMessageHideSettings(settings = null) {
  let sourceSettings = settings;
  if (!sourceSettings || typeof sourceSettings !== "object") {
    try {
      sourceSettings =
        typeof getSettings === "function" ? getSettings() : {};
    } catch {
      sourceSettings = {};
    }
  }
  return {
    enabled: Boolean(sourceSettings.hideOldMessagesEnabled),
    hide_last_n: Math.max(
      0,
      Math.trunc(Number(sourceSettings.hideOldMessagesKeepLastN ?? 0) || 0),
    ),
  };
}

function getHideRuntimeAdapters() {
  return {
    $,
    clearTimeout,
    getContext,
    setTimeout,
  };
}

async function applyMessageHideNow(reason = "manual-apply") {
  try {
    const result = await applyHideSettings(
      getMessageHideSettings(),
      getHideRuntimeAdapters(),
    );
    debugLog("[ST-BME] 已应用旧楼层隐藏:", reason, result);
    return result;
  } catch (error) {
    console.warn("[ST-BME] 应用旧楼层隐藏失败:", reason, error);
    return {
      active: false,
      error: error instanceof Error ? error.message : String(error || "未知错误"),
    };
  }
}

function scheduleMessageHideApply(reason = "scheduled", delayMs = 120) {
  try {
    scheduleHideSettingsApply(
      getMessageHideSettings(),
      getHideRuntimeAdapters(),
      delayMs,
    );
  } catch (error) {
    console.warn("[ST-BME] 调度旧楼层隐藏失败:", reason, error);
  }
}

async function runIncrementalMessageHide(reason = "incremental") {
  try {
    const result = await runIncrementalHideCheck(
      getMessageHideSettings(),
      getHideRuntimeAdapters(),
    );
    if (result?.active) {
      debugLog("[ST-BME] 已增量更新旧楼层隐藏:", reason, result);
    }
    return result;
  } catch (error) {
    console.warn("[ST-BME] 增量更新旧楼层隐藏失败:", reason, error);
    return {
      active: false,
      error: error instanceof Error ? error.message : String(error || "未知错误"),
    };
  }
}

function clearMessageHideState(reason = "reset") {
  try {
    resetHideState(getHideRuntimeAdapters());
    debugLog("[ST-BME] 已重置旧楼层隐藏状态", reason);
  } catch (error) {
    console.warn("[ST-BME] 重置旧楼层隐藏状态失败:", reason, error);
  }
}

async function clearAllHiddenMessages(reason = "manual-clear") {
  try {
    const result = await unhideAll(getHideRuntimeAdapters());
    debugLog("[ST-BME] 已取消全部旧楼层隐藏:", reason, result);
    return result;
  } catch (error) {
    console.warn("[ST-BME] 取消全部旧楼层隐藏失败:", reason, error);
    return {
      active: false,
      error: error instanceof Error ? error.message : String(error || "未知错误"),
    };
  }
}

function initializeHostCapabilityBridge(options = {}) {
  try {
    initializeHostAdapter({
      getContext,
      ...options,
    });
  } catch (error) {
    console.warn("[ST-BME] 宿主桥接初始化失败:", error);
  }

  return getHostCapabilityStatus();
}

function buildHostCapabilityErrorStatus(error) {
  const snapshot = {
    available: false,
    mode: "error",
    fallbackReason:
      error instanceof Error ? error.message : String(error || "未知错误"),
    versionHints: {
      stateSemantics: HOST_ADAPTER_STATE_SEMANTICS,
      refreshMode: "manual-rebuild",
    },
    stateSemantics: HOST_ADAPTER_STATE_SEMANTICS,
    refreshMode: "manual-rebuild",
    snapshotRevision: -1,
    snapshotCreatedAt: "",
  };
  recordHostCapabilitySnapshot(snapshot);
  return snapshot;
}

export function getHostCapabilityStatus(options = {}) {
  const normalizedOptions =
    options && typeof options === "object" ? { ...options } : {};
  const shouldRefresh = normalizedOptions.refresh === true;

  delete normalizedOptions.refresh;

  try {
    const snapshot = shouldRefresh
      ? refreshHostCapabilitySnapshot(normalizedOptions)
      : getHostCapabilitySnapshot();
    recordHostCapabilitySnapshot(snapshot);
    return snapshot;
  } catch (error) {
    console.warn("[ST-BME] 读取宿主桥接状态失败:", error);
    return buildHostCapabilityErrorStatus(error);
  }
}

export function refreshHostCapabilityStatus(options = {}) {
  return getHostCapabilityStatus({
    ...options,
    refresh: true,
  });
}

export function getHostCapability(name, options = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;

  try {
    return readHostCapability(normalizedName, options) || null;
  } catch (error) {
    console.warn("[ST-BME] 读取宿主桥接能力失败:", error);
    return getHostCapabilityStatus(options)?.[normalizedName] || null;
  }
}

export function getPanelRuntimeDebugSnapshot(options = {}) {
  const shouldRefreshHost = options?.refreshHost === true;
  const hostCapabilities = shouldRefreshHost
    ? refreshHostCapabilityStatus()
    : getHostCapabilityStatus();

  return {
    hostCapabilities,
    messageHiding: getHideStateSnapshot(),
    runtimeDebug: readRuntimeDebugSnapshot(),
  };
}

function getSchema() {
  const settings = getSettings();
  const schema = settings.nodeTypeSchema || DEFAULT_NODE_SCHEMA;
  const validation = validateSchema(schema);
  if (!validation.valid) {
    console.warn("[ST-BME] Schema 非法，回退到默认 Schema:", validation.errors);
    return DEFAULT_NODE_SCHEMA;
  }
  return schema;
}

function getConfiguredTimeoutMs(settings = getSettings()) {
  return typeof resolveConfiguredTimeoutMs === "function"
    ? resolveConfiguredTimeoutMs(settings, LOCAL_VECTOR_TIMEOUT_MS)
    : (() => {
        const timeoutMs = Number(settings?.timeoutMs);
        return Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : LOCAL_VECTOR_TIMEOUT_MS;
      })();
}

function getPlannerRecallTimeoutMs() {
  return getConfiguredTimeoutMs(getSettings());
}

function getEmbeddingConfig(mode = null) {
  const settings = getSettings();
  return getVectorConfigFromSettings(
    mode ? { ...settings, embeddingTransportMode: mode } : settings,
  );
}

function normalizeChatIdCandidate(value = "") {
  return String(value ?? "").trim();
}

function readGlobalCurrentChatId() {
  try {
    return normalizeChatIdCandidate(
      globalThis.SillyTavern?.getCurrentChatId?.() ||
        globalThis.getCurrentChatId?.() ||
        "",
    );
  } catch {
    return "";
  }
}

function hasLikelySelectedChatContext(context = getContext()) {
  if (!context || typeof context !== "object") {
    return false;
  }

  const hasMeaningfulChatMetadata =
    context.chatMetadata &&
    typeof context.chatMetadata === "object" &&
    !Array.isArray(context.chatMetadata) &&
    Object.keys(context.chatMetadata).length > 0;
  const hasChatMessages =
    Array.isArray(context.chat) && context.chat.length > 0;
  const hasCharacterId =
    context.characterId !== undefined &&
    context.characterId !== null &&
    String(context.characterId).trim() !== "";
  const hasGroupId =
    context.groupId !== undefined &&
    context.groupId !== null &&
    String(context.groupId).trim() !== "";

  return (
    hasMeaningfulChatMetadata || hasChatMessages || hasCharacterId || hasGroupId
  );
}

function hasHostMetadataReadySignal(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }

  if (normalizeChatIdCandidate(metadata.integrity)) {
    return true;
  }

  const chatIdentityCandidates = [
    metadata.chat_id,
    metadata.chatId,
    metadata.session_id,
    metadata.sessionId,
  ];
  if (
    chatIdentityCandidates.some((candidate) =>
      Boolean(normalizeChatIdCandidate(candidate)),
    )
  ) {
    return true;
  }

  return false;
}

function isHostChatMetadataReady(context = getContext()) {
  if (
    !context?.chatMetadata ||
    typeof context.chatMetadata !== "object" ||
    Array.isArray(context.chatMetadata)
  ) {
    return false;
  }

  const metadata = context.chatMetadata;
  // 仅接受宿主“强信号”，避免把中间�?占位 metadata 误判�?ready�?
  if (hasHostMetadataReadySignal(metadata)) return true;

  return false;
}

function resolveCurrentHostChatId(context = getContext()) {
  const candidates = [
    context?.chatId,
    context?.getCurrentChatId?.(),
    readGlobalCurrentChatId(),
    context?.chatMetadata?.chat_id,
    context?.chatMetadata?.chatId,
    context?.chatMetadata?.session_id,
    context?.chatMetadata?.sessionId,
  ];

  return (
    candidates
      .map((candidate) => normalizeChatIdCandidate(candidate))
      .find(Boolean) || ""
  );
}

function resolveCurrentChatIdentity(context = getContext()) {
  const hostChatId = resolveCurrentHostChatId(context);
  const integrity =
    typeof getChatMetadataIntegrity === "function"
      ? getChatMetadataIntegrity(context)
      : normalizeChatIdCandidate(
          context?.chatMetadata?.integrity ||
            context?.chatMetadata?.chat_id ||
            context?.chatMetadata?.chatId ||
            "",
        );
  const aliasedChatId =
    !integrity &&
    hostChatId &&
    typeof resolveGraphIdentityAliasByHostChatId === "function"
      ? resolveGraphIdentityAliasByHostChatId(hostChatId)
      : "";
  const chatId = integrity || aliasedChatId || hostChatId;

  return {
    chatId,
    hostChatId,
    integrity,
    identitySource: integrity
      ? "integrity"
      : aliasedChatId
        ? "alias"
        : hostChatId
          ? "host-chat-id"
          : "",
    hasLikelySelectedChat: hasLikelySelectedChatContext(context),
  };
}

function getCurrentChatId(context = getContext()) {
  return resolveCurrentChatIdentity(context).chatId;
}

function rememberResolvedGraphIdentityAlias(
  context = getContext(),
  persistenceChatId = getCurrentChatId(context),
) {
  const identity = resolveCurrentChatIdentity(context);
  if (!identity.integrity || !persistenceChatId) {
    return null;
  }

  return rememberGraphIdentityAlias({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId,
  });
}

function buildLegacyGraphIdentityCandidates(
  targetChatId,
  context = getContext(),
  { shadowSnapshot = null } = {},
) {
  const normalizedTargetChatId = normalizeChatIdCandidate(targetChatId);
  const identity = resolveCurrentChatIdentity(context);
  const candidates = new Set();
  const addCandidate = (value) => {
    const normalized = normalizeChatIdCandidate(value);
    if (!normalized || normalized === normalizedTargetChatId) return;
    candidates.add(normalized);
  };

  addCandidate(identity.hostChatId);
  for (const aliasCandidate of getGraphIdentityAliasCandidates({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId: normalizedTargetChatId,
  })) {
    addCandidate(aliasCandidate);
  }

  const currentGraphMeta = getGraphPersistenceMeta(currentGraph) || {};
  const runtimeGraphIntegrity = normalizeChatIdCandidate(
    currentGraphMeta.integrity || graphPersistenceState.metadataIntegrity,
  );
  if (
    identity.integrity &&
    runtimeGraphIntegrity &&
    runtimeGraphIntegrity === identity.integrity
  ) {
    addCandidate(graphPersistenceState.chatId);
    addCandidate(currentGraph?.historyState?.chatId);
    addCandidate(currentGraphMeta.chatId);
  }

  addCandidate(shadowSnapshot?.chatId);
  addCandidate(shadowSnapshot?.persistedChatId);
  return Array.from(candidates);
}

async function doesIndexedDbChatStoreExist(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return false;

  const DexieCtor = globalThis.Dexie || (await ensureDexieLoaded());
  if (typeof DexieCtor?.exists === "function") {
    return await DexieCtor.exists(buildBmeDbName(normalizedChatId));
  }

  if (typeof DexieCtor?.getDatabaseNames === "function") {
    const names = await DexieCtor.getDatabaseNames();
    return Array.isArray(names)
      ? names.includes(buildBmeDbName(normalizedChatId))
      : false;
  }

  return false;
}

async function exportIndexedDbSnapshotForChat(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return null;
  }

  if (!(await doesIndexedDbChatStoreExist(normalizedChatId))) {
    return null;
  }

  const DexieCtor = globalThis.Dexie || (await ensureDexieLoaded());
  const db = new BmeDatabase(normalizedChatId, {
    dexieClass: DexieCtor,
  });

  try {
    await db.open();
    return await db.exportSnapshot();
  } finally {
    await db.close();
  }
}

function buildRecoveredSnapshotForChatIdentity(
  graph,
  targetChatId,
  {
    revision = 0,
    integrity = "",
    source = "identity-recovery",
    legacyChatId = "",
  } = {},
) {
  const normalizedTargetChatId = normalizeChatIdCandidate(targetChatId);
  const normalizedIntegrity = normalizeChatIdCandidate(integrity);
  const normalizedLegacyChatId = normalizeChatIdCandidate(legacyChatId);
  const normalizedGraph = cloneGraphForPersistence(graph, normalizedTargetChatId);
  const effectiveRevision = Math.max(
    1,
    normalizeIndexedDbRevision(
      revision || graphPersistenceState.revision || getGraphPersistedRevision(graph),
    ),
  );

  stampGraphPersistenceMeta(normalizedGraph, {
    revision: effectiveRevision,
    reason: source,
    chatId: normalizedTargetChatId,
    integrity: normalizedIntegrity,
  });

  return buildSnapshotFromGraph(normalizedGraph, {
    chatId: normalizedTargetChatId,
    revision: effectiveRevision,
    lastModified: Date.now(),
    meta: {
      storagePrimary: "indexeddb",
      lastMutationReason: String(source || "identity-recovery"),
      integrity: normalizedIntegrity,
      migratedFromChatId: normalizedLegacyChatId,
      identityMigrationSource: String(source || "identity-recovery"),
    },
  });
}

async function importRecoveredSnapshotToIndexedDb(
  targetDb,
  targetChatId,
  graph,
  { revision = 0, integrity = "", source = "identity-recovery", legacyChatId = "" } = {},
) {
  const snapshot = buildRecoveredSnapshotForChatIdentity(graph, targetChatId, {
    revision,
    integrity,
    source,
    legacyChatId,
  });
  const importResult = await targetDb.importSnapshot(snapshot, {
    mode: "replace",
    preserveRevision: true,
    revision: snapshot.meta.revision,
    markSyncDirty: true,
  });
  snapshot.meta.revision = normalizeIndexedDbRevision(
    importResult?.revision,
    snapshot.meta.revision,
  );
  return snapshot;
}

function doesChatIdMatchResolvedGraphIdentity(
  candidateChatId,
  identity = resolveCurrentChatIdentity(getContext()),
) {
  const normalizedCandidate = normalizeChatIdCandidate(candidateChatId);
  if (!normalizedCandidate || !identity || typeof identity !== "object") {
    return false;
  }

  const knownChatIds = new Set();
  const addKnownChatId = (value) => {
    const normalized = normalizeChatIdCandidate(value);
    if (normalized) {
      knownChatIds.add(normalized);
    }
  };

  addKnownChatId(identity.chatId);
  addKnownChatId(identity.hostChatId);
  addKnownChatId(identity.integrity);

  for (const aliasCandidate of getGraphIdentityAliasCandidates({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId: identity.chatId,
  })) {
    addKnownChatId(aliasCandidate);
  }

  return knownChatIds.has(normalizedCandidate);
}

function areChatIdsEquivalentForResolvedIdentity(
  candidateChatId,
  referenceChatId,
  identity = resolveCurrentChatIdentity(getContext()),
) {
  const normalizedCandidate = normalizeChatIdCandidate(candidateChatId);
  const normalizedReference = normalizeChatIdCandidate(referenceChatId);
  if (!normalizedCandidate || !normalizedReference) {
    return normalizedCandidate === normalizedReference;
  }
  if (normalizedCandidate === normalizedReference) {
    return true;
  }
  return (
    doesChatIdMatchResolvedGraphIdentity(normalizedCandidate, identity) &&
    doesChatIdMatchResolvedGraphIdentity(normalizedReference, identity)
  );
}

function getIndexedDbSnapshotHistoryState(snapshot = null) {
  const snapshotState =
    snapshot?.meta?.runtimeHistoryState &&
    typeof snapshot.meta.runtimeHistoryState === "object" &&
    !Array.isArray(snapshot.meta.runtimeHistoryState)
      ? snapshot.meta.runtimeHistoryState
      : null;

  return {
    lastProcessedAssistantFloor: Number.isFinite(
      Number(snapshot?.state?.lastProcessedFloor),
    )
      ? Number(snapshot.state.lastProcessedFloor)
      : Number.isFinite(Number(snapshotState?.lastProcessedAssistantFloor))
        ? Number(snapshotState.lastProcessedAssistantFloor)
        : -1,
    extractionCount: Number.isFinite(Number(snapshot?.state?.extractionCount))
      ? Number(snapshot.state.extractionCount)
      : Number.isFinite(Number(snapshotState?.extractionCount))
        ? Number(snapshotState.extractionCount)
        : 0,
  };
}

function detectStaleIndexedDbSnapshotAgainstRuntime(
  chatId,
  snapshot,
  { identity = resolveCurrentChatIdentity(getContext()) } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot) || !currentGraph) {
    return {
      stale: false,
      reason: "",
    };
  }

  const runtimeChatId = normalizeChatIdCandidate(
    currentGraph?.historyState?.chatId ||
      getGraphPersistenceMeta(currentGraph)?.chatId ||
      graphPersistenceState.chatId,
  );
  if (
    !runtimeChatId ||
    !areChatIdsEquivalentForResolvedIdentity(
      normalizedChatId,
      runtimeChatId,
      identity,
    )
  ) {
    return {
      stale: false,
      reason: "",
    };
  }

  const runtimeRevision = Math.max(
    normalizeIndexedDbRevision(graphPersistenceState.revision),
    normalizeIndexedDbRevision(graphPersistenceState.lastPersistedRevision),
    normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
    getGraphPersistedRevision(currentGraph),
  );
  const snapshotRevision = normalizeIndexedDbRevision(snapshot?.meta?.revision);
  if (runtimeRevision > snapshotRevision) {
    return {
      stale: true,
      reason: "runtime-revision-newer",
      runtimeRevision,
      snapshotRevision,
    };
  }

  if (runtimeRevision < snapshotRevision) {
    return {
      stale: false,
      reason: "",
      runtimeRevision,
      snapshotRevision,
    };
  }

  const runtimeLastProcessedFloor = Number.isFinite(
    Number(currentGraph?.historyState?.lastProcessedAssistantFloor),
  )
    ? Number(currentGraph.historyState.lastProcessedAssistantFloor)
    : Number.isFinite(Number(currentGraph?.lastProcessedSeq))
      ? Number(currentGraph.lastProcessedSeq)
      : -1;
  const runtimeExtractionCount = Number.isFinite(
    Number(currentGraph?.historyState?.extractionCount),
  )
    ? Number(currentGraph.historyState.extractionCount)
    : Number.isFinite(Number(extractionCount))
      ? Number(extractionCount)
      : 0;
  const snapshotHistoryState = getIndexedDbSnapshotHistoryState(snapshot);

  if (runtimeLastProcessedFloor > snapshotHistoryState.lastProcessedAssistantFloor) {
    return {
      stale: true,
      reason: "runtime-last-processed-newer",
      runtimeRevision,
      snapshotRevision,
      runtimeLastProcessedFloor,
      snapshotLastProcessedFloor: snapshotHistoryState.lastProcessedAssistantFloor,
      runtimeExtractionCount,
      snapshotExtractionCount: snapshotHistoryState.extractionCount,
    };
  }

  if (runtimeExtractionCount > snapshotHistoryState.extractionCount) {
    return {
      stale: true,
      reason: "runtime-extraction-count-newer",
      runtimeRevision,
      snapshotRevision,
      runtimeLastProcessedFloor,
      snapshotLastProcessedFloor: snapshotHistoryState.lastProcessedAssistantFloor,
      runtimeExtractionCount,
      snapshotExtractionCount: snapshotHistoryState.extractionCount,
    };
  }

  return {
    stale: false,
    reason: "",
    runtimeRevision,
    snapshotRevision,
    runtimeLastProcessedFloor,
    snapshotLastProcessedFloor: snapshotHistoryState.lastProcessedAssistantFloor,
    runtimeExtractionCount,
    snapshotExtractionCount: snapshotHistoryState.extractionCount,
  };
}

function resolveCompatibleGraphShadowSnapshot(
  identity = resolveCurrentChatIdentity(getContext()),
) {
  if (!identity || typeof identity !== "object") {
    return null;
  }

  const directSnapshot = readGraphShadowSnapshot(identity.chatId);
  if (directSnapshot) {
    return directSnapshot;
  }

  const seenChatIds = new Set(
    [identity.chatId].map((value) => normalizeChatIdCandidate(value)).filter(Boolean),
  );
  const readByChatId = (value) => {
    const normalized = normalizeChatIdCandidate(value);
    if (!normalized || seenChatIds.has(normalized)) {
      return null;
    }
    seenChatIds.add(normalized);
    return readGraphShadowSnapshot(normalized);
  };

  const hostSnapshot = readByChatId(identity.hostChatId);
  if (hostSnapshot) {
    return hostSnapshot;
  }

  for (const aliasCandidate of getGraphIdentityAliasCandidates({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId: identity.chatId,
  })) {
    const aliasSnapshot = readByChatId(aliasCandidate);
    if (aliasSnapshot) {
      return aliasSnapshot;
    }
  }

  return findGraphShadowSnapshotByIntegrity(identity.integrity, {
    excludeChatIds: Array.from(seenChatIds),
  });
}

function createShadowComparisonGraph({
  chatId = "",
  revision = 0,
  integrity = "",
} = {}) {
  const graph = createEmptyGraph();
  stampGraphPersistenceMeta(graph, {
    revision: Math.max(0, normalizeIndexedDbRevision(revision)),
    chatId: String(chatId || ""),
    integrity: String(integrity || ""),
    reason: "shadow-compare-reference",
  });
  return graph;
}

function applyShadowSnapshotToRuntime(
  chatId,
  shadowSnapshot,
  {
    source = "shadow-restore",
    attemptIndex = 0,
    promoteToIndexedDb = true,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(
    chatId || shadowSnapshot?.chatId,
  );
  if (!normalizedChatId || !shadowSnapshot?.serializedGraph) {
    return {
      success: false,
      loaded: false,
      loadState: graphPersistenceState.loadState,
      reason: "shadow-invalid",
      chatId: normalizedChatId || "",
      attemptIndex,
    };
  }

  let shadowGraph = null;
  try {
    shadowGraph = cloneGraphForPersistence(
      normalizeGraphRuntimeState(
        deserializeGraph(shadowSnapshot.serializedGraph),
        normalizedChatId,
      ),
      normalizedChatId,
    );
  } catch (error) {
    console.warn("[ST-BME] shadow snapshot 恢复失败:", error);
    return {
      success: false,
      loaded: false,
      loadState: graphPersistenceState.loadState,
      reason: "shadow-deserialize-failed",
      detail: error?.message || String(error),
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const shadowRevision = Math.max(
    1,
    normalizeIndexedDbRevision(shadowSnapshot.revision),
  );
  stampGraphPersistenceMeta(shadowGraph, {
    revision: shadowRevision,
    reason: `shadow:${String(source || "shadow-restore")}`,
    chatId: normalizedChatId,
    integrity:
      String(shadowSnapshot.integrity || "").trim() ||
      getChatMetadataIntegrity(getContext()) ||
      graphPersistenceState.metadataIntegrity,
  });

  currentGraph = shadowGraph;
  extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount)
    ? currentGraph.historyState.extractionCount
    : 0;
  lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  runtimeStatus = createUiStatus(
    "图谱临时恢复",
    "已从本次会话临时快照恢复最近图谱，正在补写 IndexedDB",
    "warning",
  );
  lastExtractionStatus = createUiStatus(
    "待命",
    "已从会话快照恢复最近图谱，等待下一次提取",
    "idle",
  );
  lastVectorStatus = createUiStatus(
    "待命",
    currentGraph.vectorIndexState?.lastWarning ||
      "已从会话快照恢复最近图谱，等待下一次向量任务",
    "idle",
  );
  lastRecallStatus = createUiStatus(
    "待命",
    restoredRecallUi.restored
      ? "已从持久化召回记录恢复显示，并已恢复最近图谱"
      : "已从会话快照恢复最近图谱，等待下一次召回",
    "idle",
  );

  applyGraphLoadState(GRAPH_LOAD_STATES.SHADOW_RESTORED, {
    chatId: normalizedChatId,
    reason: `shadow:${String(source || "shadow-restore")}`,
    attemptIndex,
    revision: shadowRevision,
    lastPersistedRevision: Math.max(
      normalizeIndexedDbRevision(graphPersistenceState.lastPersistedRevision),
      shadowRevision,
    ),
    queuedPersistRevision: Math.max(
      normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
      shadowRevision,
    ),
    queuedPersistChatId: normalizedChatId,
    pendingPersist: Boolean(promoteToIndexedDb),
    shadowSnapshotUsed: true,
    shadowSnapshotRevision: shadowRevision,
    shadowSnapshotUpdatedAt: String(shadowSnapshot.updatedAt || ""),
    shadowSnapshotReason: String(
      shadowSnapshot.debugReason || shadowSnapshot.reason || source || "",
    ),
    dbReady: true,
    writesBlocked: false,
  });
  updateGraphPersistenceState({
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    dbReady: true,
    indexedDbLastError: "",
    pendingPersist: Boolean(promoteToIndexedDb),
    lastRecoverableStorageTier: "shadow",
    metadataIntegrity:
      getChatMetadataIntegrity(getContext()) ||
      graphPersistenceState.metadataIntegrity,
    dualWriteLastResult: {
      action: "load",
      source: `${String(source || "shadow-restore")}:shadow`,
      success: true,
      provisional: true,
      revision: shadowRevision,
      resultCode: "graph.load.shadow-restored",
      reason: `shadow:${String(source || "shadow-restore")}`,
      at: Date.now(),
    },
  });
  rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

  if (promoteToIndexedDb) {
    queueGraphPersistToIndexedDb(normalizedChatId, currentGraph, {
      revision: shadowRevision,
      reason: `shadow-restore-promote:${String(source || "shadow-restore")}`,
    });
  }

  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh(30);
  return {
    success: true,
    loaded: true,
    loadState: GRAPH_LOAD_STATES.SHADOW_RESTORED,
    reason: `shadow:${String(source || "shadow-restore")}`,
    chatId: normalizedChatId,
    attemptIndex,
    revision: shadowRevision,
    shadowRestored: true,
  };
}

async function refreshRuntimeGraphAfterSyncApplied(syncPayload = {}) {
  const action = String(syncPayload?.action || "")
    .trim()
    .toLowerCase();
  if (
    action !== "download"
    && action !== "merge"
    && action !== "restore-backup"
  ) {
    return {
      refreshed: false,
      reason: "action-not-supported",
      action,
    };
  }

  const syncedChatId = normalizeChatIdCandidate(syncPayload?.chatId);
  const activeIdentity = resolveCurrentChatIdentity(getContext());
  const activeChatId = normalizeChatIdCandidate(activeIdentity.chatId);
  const targetChatId =
    activeChatId &&
    syncedChatId &&
    doesChatIdMatchResolvedGraphIdentity(syncedChatId, activeIdentity)
      ? activeChatId
      : syncedChatId || activeChatId;

  if (!targetChatId) {
    return {
      refreshed: false,
      reason: "missing-chat-id",
      action,
    };
  }

  if (activeChatId && targetChatId !== activeChatId) {
    return {
      refreshed: false,
      reason: "chat-switched",
      action,
      chatId: targetChatId,
      activeChatId,
    };
  }

  const loadResult = await loadGraphFromIndexedDb(targetChatId, {
    source: `sync-post-refresh:${action}`,
    allowOverride: true,
    applyEmptyState: true,
  });

  return {
    refreshed: Boolean(loadResult?.loaded || loadResult?.emptyConfirmed),
    action,
    chatId: targetChatId,
    ...loadResult,
  };
}

function buildBmeSyncRuntimeOptions(extra = {}) {
  const normalizedExtra =
    extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  const defaultOptions = {
    getDb: async (chatId) => {
      const manager = ensureBmeChatManager();
      if (!manager) {
        throw new Error("BmeChatManager 不可用");
      }
      return await manager.getCurrentDb(chatId);
    },
    getCurrentChatId: () => getCurrentChatId(),
    getCloudStorageMode: () => getSettings().cloudStorageMode || "automatic",
    getRequestHeaders,
    onSyncApplied: async (payload = {}) => {
      await refreshRuntimeGraphAfterSyncApplied(payload);
    },
  };

  if (typeof normalizedExtra.onSyncApplied !== "function") {
    return {
      ...defaultOptions,
      ...normalizedExtra,
    };
  }

  return {
    ...defaultOptions,
    ...normalizedExtra,
    onSyncApplied: async (payload = {}) => {
      await defaultOptions.onSyncApplied(payload);
      await normalizedExtra.onSyncApplied(payload);
    },
  };
}

async function syncIndexedDbMetaToPersistenceState(
  chatId,
  { syncState = "idle", lastSyncError = "" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  try {
    const manager = ensureBmeChatManager();
    if (!manager) return null;
    const db = await manager.getCurrentDb(normalizedChatId);
    const [
      revision,
      syncDirty,
      syncDirtyReason,
      lastSyncUploadedAt,
      lastSyncDownloadedAt,
      lastSyncedRevision,
      lastBackupUploadedAt,
      lastBackupRestoredAt,
      lastBackupRollbackAt,
      lastBackupFilename,
    ] = await Promise.all([
      db.getRevision(),
      db.getMeta("syncDirty", false),
      db.getMeta("syncDirtyReason", ""),
      db.getMeta("lastSyncUploadedAt", 0),
      db.getMeta("lastSyncDownloadedAt", 0),
      db.getMeta("lastSyncedRevision", 0),
      db.getMeta("lastBackupUploadedAt", 0),
      db.getMeta("lastBackupRestoredAt", 0),
      db.getMeta("lastBackupRollbackAt", 0),
      db.getMeta("lastBackupFilename", ""),
    ]);

    const patch = {
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      indexedDbRevision: normalizeIndexedDbRevision(revision),
      syncState: normalizeGraphSyncState(syncState),
      syncDirty: Boolean(syncDirty),
      syncDirtyReason: String(syncDirtyReason || ""),
      lastSyncUploadedAt: Number(lastSyncUploadedAt) || 0,
      lastSyncDownloadedAt: Number(lastSyncDownloadedAt) || 0,
      lastSyncedRevision: Number(lastSyncedRevision) || 0,
      lastBackupUploadedAt: Number(lastBackupUploadedAt) || 0,
      lastBackupRestoredAt: Number(lastBackupRestoredAt) || 0,
      lastBackupRollbackAt: Number(lastBackupRollbackAt) || 0,
      lastBackupFilename: String(lastBackupFilename || ""),
      lastSyncError: String(lastSyncError || ""),
    };

    updateGraphPersistenceState(patch);
    return patch;
  } catch (error) {
    console.warn("[ST-BME] 读取 IndexedDB 同步元数据失败:", error);
    updateGraphPersistenceState({
      syncState: "error",
      lastSyncError: error?.message || String(error),
    });
    return null;
  }
}

async function runBmeAutoSyncForChat(source = "unknown", chatId = "") {
  const normalizedChatId = String(chatId || "").trim();
  if (!normalizedChatId) return { synced: false, reason: "missing-chat-id" };

  updateGraphPersistenceState({
    syncState: "syncing",
    lastSyncError: "",
  });

  try {
    const syncResult = await autoSyncOnChatChange(
      normalizedChatId,
      buildBmeSyncRuntimeOptions({
        trigger: source,
        reason: String(source || "chat-change"),
      }),
    );

    await syncIndexedDbMetaToPersistenceState(normalizedChatId, {
      syncState:
        syncResult?.action === "manual-probe"
          ? "idle"
          : syncResult?.synced
            ? "idle"
            : "warning",
      lastSyncError: syncResult?.error || "",
    });

    return syncResult;
  } catch (error) {
    await syncIndexedDbMetaToPersistenceState(normalizedChatId, {
      syncState: "error",
      lastSyncError: error?.message || String(error),
    });
    throw error;
  }
}

function ensureBmeChatManager() {
  if (typeof BmeChatManager !== "function") {
    if (!bmeChatManagerUnavailableWarned) {
      console.warn("[ST-BME] BmeChatManager 不可用，IndexedDB 能力暂时停用");
      bmeChatManagerUnavailableWarned = true;
    }
    return null;
  }

  if (!bmeChatManager) {
    bmeChatManager = new BmeChatManager();
  }
  return bmeChatManager;
}

function scheduleBmeIndexedDbTask(task) {
  const scheduler =
    typeof globalThis.queueMicrotask === "function"
      ? globalThis.queueMicrotask.bind(globalThis)
      : (callback) => setTimeout(callback, 0);

  scheduler(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.warn("[ST-BME] IndexedDB 后台任务失败:", error);
      });
  });
}

async function syncBmeChatManagerWithCurrentChat(
  source = "unknown",
  context = getContext(),
) {
  const manager = ensureBmeChatManager();
  if (!manager) {
    return {
      chatId: "",
      opened: false,
      skipped: true,
      reason: "manager-unavailable",
    };
  }
  const chatId = getCurrentChatId(context);

  if (!chatId) {
    await manager.closeCurrent();
    debugDebug("[ST-BME] IndexedDB 会话已关闭（无活动聊天）", {
      source,
    });
    return {
      chatId: "",
      opened: false,
      skipped: false,
    };
  }

  const db = await manager.switchChat(chatId);
  debugDebug("[ST-BME] IndexedDB 会话已同步", {
    source,
    chatId,
  });
  return {
    chatId,
    opened: Boolean(db),
    skipped: false,
  };
}

function scheduleBmeIndexedDbWarmup(source = "init") {
  scheduleBmeIndexedDbTask(async () => {
    await ensureDexieLoaded();
    await syncBmeChatManagerWithCurrentChat(source);
  });
}

function normalizeIndexedDbRevision(value, fallbackValue = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Number(fallbackValue) || 0);
  }
  return Math.floor(parsed);
}

function isIndexedDbSnapshotMeaningful(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return false;

  if (Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0) return true;
  if (Array.isArray(snapshot.edges) && snapshot.edges.length > 0) return true;
  if (Array.isArray(snapshot.tombstones) && snapshot.tombstones.length > 0)
    return true;

  const state = snapshot.state || {};
  if (
    Number.isFinite(Number(state.lastProcessedFloor)) &&
    Number(state.lastProcessedFloor) >= 0
  ) {
    return true;
  }
  if (
    Number.isFinite(Number(state.extractionCount)) &&
    Number(state.extractionCount) > 0
  ) {
    return true;
  }

  const runtimeHistoryState = snapshot.meta?.runtimeHistoryState;
  if (
    runtimeHistoryState &&
    typeof runtimeHistoryState === "object" &&
    !Array.isArray(runtimeHistoryState)
  ) {
    if (
      Number.isFinite(
        Number(runtimeHistoryState.lastProcessedAssistantFloor),
      ) &&
      Number(runtimeHistoryState.lastProcessedAssistantFloor) >= 0
    ) {
      return true;
    }
    if (
      runtimeHistoryState.processedMessageHashes &&
      typeof runtimeHistoryState.processedMessageHashes === "object" &&
      !Array.isArray(runtimeHistoryState.processedMessageHashes) &&
      Object.keys(runtimeHistoryState.processedMessageHashes).length > 0
    ) {
      return true;
    }
  }

  return false;
}

function cacheIndexedDbSnapshot(chatId, snapshot = null) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !snapshot || typeof snapshot !== "object") return;
  bmeIndexedDbSnapshotCacheByChatId.set(normalizedChatId, {
    chatId: normalizedChatId,
    revision: normalizeIndexedDbRevision(snapshot?.meta?.revision),
    snapshot,
    updatedAt: Date.now(),
  });
}

function readCachedIndexedDbSnapshot(chatId) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const cacheEntry = bmeIndexedDbSnapshotCacheByChatId.get(normalizedChatId);
  if (!cacheEntry?.snapshot) return null;
  return cacheEntry.snapshot;
}

function cacheChatStateSnapshot(chatId, snapshot = null) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !snapshot || typeof snapshot !== "object") return;
  bmeChatStateSnapshotCacheByChatId.set(normalizedChatId, {
    chatId: normalizedChatId,
    revision: Number(snapshot?.revision || 0),
    snapshot,
    updatedAt: Date.now(),
  });
}

function readCachedChatStateSnapshot(chatId) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const cacheEntry = bmeChatStateSnapshotCacheByChatId.get(normalizedChatId);
  if (!cacheEntry?.snapshot) return null;
  return cacheEntry.snapshot;
}

function canUseHostGraphChatStatePersistence(context = getContext()) {
  return canUseGraphChatState(context);
}

function selectPreferredCommitMarker(...candidates) {
  let bestMarker = null;
  let bestRevision = 0;

  for (const candidate of candidates) {
    const revision = getAcceptedCommitMarkerRevision(candidate);
    if (revision > bestRevision) {
      bestRevision = revision;
      bestMarker = candidate;
    }
  }

  return bestMarker || null;
}

async function persistGraphToHostChatState(
  context = getContext(),
  {
    graph = currentGraph,
    revision = graphPersistenceState.revision,
    reason = "graph-chat-state",
    storageTier = "chat-state",
    accepted = true,
    lastProcessedAssistantFloor = null,
    extractionCount: nextExtractionCount = null,
    mode = "primary",
  } = {},
) {
  if (!context || !graph || !canUseHostGraphChatStatePersistence(context)) {
    return {
      saved: false,
      accepted: false,
      reason: "chat-state-unavailable",
      revision,
      storageTier,
    };
  }

  const chatId = getCurrentChatId(context);
  if (!chatId) {
    return {
      saved: false,
      accepted: false,
      reason: "missing-chat-id",
      revision,
      storageTier,
    };
  }

  const resolvedIdentity = resolveCurrentChatIdentity(context);
  const nextIntegrity =
    getChatMetadataIntegrity(context) ||
    normalizeChatIdCandidate(resolvedIdentity?.integrity) ||
    graphPersistenceState.metadataIntegrity;
  const persistedGraph = cloneGraphForPersistence(graph, chatId);
  stampGraphPersistenceMeta(persistedGraph, {
    revision,
    reason: `chat-state:${String(reason || "graph-chat-state")}`,
    chatId,
    integrity: nextIntegrity,
  });

  const writeResult = await writeGraphChatStateSnapshot(
    context,
    persistedGraph,
    {
      namespace: GRAPH_CHAT_STATE_NAMESPACE,
      revision,
      storageTier,
      accepted,
      reason,
      chatId,
      integrity: nextIntegrity,
      lastProcessedAssistantFloor,
      extractionCount: nextExtractionCount,
    },
  );

  if (!writeResult?.ok || !writeResult?.snapshot) {
    updateGraphPersistenceState({
      dualWriteLastResult: {
        action: "save",
        target: "chat-state",
        success: false,
        chatId,
        revision: Number(revision || 0),
        reason: String(reason || "graph-chat-state"),
        mode: String(mode || "primary"),
        error: writeResult?.error?.message || writeResult?.reason || "chat-state-save-failed",
        at: Date.now(),
      },
    });
    return {
      saved: false,
      accepted: false,
      reason: writeResult?.reason || "chat-state-save-failed",
      revision,
      storageTier,
      error: writeResult?.error || null,
    };
  }

  cacheChatStateSnapshot(chatId, writeResult.snapshot);
  rememberResolvedGraphIdentityAlias(context, chatId);
  updateGraphPersistenceState({
    metadataIntegrity: String(nextIntegrity || graphPersistenceState.metadataIntegrity || ""),
    lastPersistReason: String(reason || ""),
    lastPersistMode:
      mode === "mirror" ? "chat-state-mirror" : "chat-state",
    lastAcceptedRevision:
      accepted === true
        ? Math.max(
            Number(graphPersistenceState.lastAcceptedRevision || 0),
            Number(writeResult.snapshot.revision || revision || 0),
          )
        : Number(graphPersistenceState.lastAcceptedRevision || 0),
    dualWriteLastResult: {
      action: "save",
      target: "chat-state",
      success: true,
      chatId,
      revision: Number(writeResult.snapshot.revision || revision || 0),
      reason: String(reason || "graph-chat-state"),
      mode: String(mode || "primary"),
      at: Date.now(),
    },
  });
  if (mode !== "mirror") {
    clearPendingGraphPersistRetry();
  }

  return {
    saved: true,
    accepted,
    chatId,
    revision: Number(writeResult.snapshot.revision || revision || 0),
    reason: String(reason || "graph-chat-state"),
    saveMode: mode === "mirror" ? "chat-state-mirror" : "chat-state",
    storageTier,
    snapshot: writeResult.snapshot,
  };
}

async function loadGraphFromChatState(
  chatId,
  {
    source = "chat-state-probe",
    attemptIndex = 0,
    allowOverride = false,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const context = getContext();
  if (!normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
  }
  if (!canUseHostGraphChatStatePersistence(context)) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-unavailable",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const payload =
    (await readGraphChatStateSnapshot(context, {
      namespace: GRAPH_CHAT_STATE_NAMESPACE,
    })) || readCachedChatStateSnapshot(normalizedChatId);
  if (!payload?.serializedGraph) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-empty",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }
  cacheChatStateSnapshot(normalizedChatId, payload);

  let chatStateGraph = null;
  try {
    chatStateGraph = cloneGraphForPersistence(
      normalizeGraphRuntimeState(
        deserializeGraph(payload.serializedGraph),
        normalizedChatId,
      ),
      normalizedChatId,
    );
  } catch (error) {
    console.warn("[ST-BME] 聊天侧车图谱反序列化失败:", error);
    return {
      success: false,
      loaded: false,
      reason: "chat-state-deserialize-failed",
      chatId: normalizedChatId,
      attemptIndex,
      error,
    };
  }

  if (isGraphEffectivelyEmpty(chatStateGraph)) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-empty",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const revision = Math.max(
    1,
    Number(payload.revision || getGraphPersistedRevision(chatStateGraph) || 1),
  );
  const integrity =
    normalizeChatIdCandidate(payload.integrity) ||
    getChatMetadataIntegrity(context) ||
    graphPersistenceState.metadataIntegrity;
  stampGraphPersistenceMeta(chatStateGraph, {
    revision,
    reason: `chat-state:${String(source || "chat-state-probe")}`,
    chatId: normalizedChatId,
    integrity,
  });

  const snapshot = buildSnapshotFromGraph(chatStateGraph, {
    chatId: normalizedChatId,
    revision,
    meta: {
      storagePrimary: "chat-state",
      lastMutationReason: String(payload.reason || source || "chat-state"),
      integrity,
    },
  });
  const shadowSnapshot = resolveCompatibleGraphShadowSnapshot(
    resolveCurrentChatIdentity(context),
  );
  const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
    chatStateGraph,
    shadowSnapshot,
  );
  if (shadowSnapshot && shadowDecision?.prefer) {
    return applyShadowSnapshotToRuntime(normalizedChatId, shadowSnapshot, {
      source: `${source}:shadow-over-chat-state`,
      attemptIndex,
    });
  }

  const effectiveCommitMarker = selectPreferredCommitMarker(
    payload.commitMarker,
    getChatCommitMarker(context),
  );
  const commitMarkerMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
    snapshot,
    effectiveCommitMarker,
  );
  let commitMarkerDiagnostic = null;
  if (commitMarkerMismatch.mismatched) {
    commitMarkerDiagnostic = recordPersistMismatchDiagnostic(
      {
        ...commitMarkerMismatch,
        marker: commitMarkerMismatch.marker || effectiveCommitMarker,
      },
      {
        source: `${source}:chat-state-marker`,
      },
    );
    if (
      shadowSnapshot &&
      Number(shadowSnapshot.revision || 0) >=
        Number(commitMarkerMismatch.markerRevision || 0)
    ) {
      const shadowResult = applyShadowSnapshotToRuntime(normalizedChatId, shadowSnapshot, {
        source: `${source}:shadow-beats-chat-state-marker`,
        attemptIndex,
      });
      if (shadowResult?.loaded && commitMarkerDiagnostic?.reason) {
        updateGraphPersistenceState({
          persistMismatchReason: commitMarkerDiagnostic.reason,
        });
      }
      return shadowResult;
    }
  }

  const shouldAllowOverride =
    allowOverride ||
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(graphPersistenceState.loadState) ||
    graphPersistenceState.storagePrimary === "chat-state" ||
    revision >= normalizeIndexedDbRevision(graphPersistenceState.revision);
  if (!shouldAllowOverride) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-stale",
      chatId: normalizedChatId,
      attemptIndex,
      revision,
    };
  }

  if (getCurrentChatId() !== normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-chat-switched",
      chatId: normalizedChatId,
      attemptIndex,
      revision,
    };
  }

  const loadResult = applyIndexedDbSnapshotToRuntime(normalizedChatId, snapshot, {
    source,
    attemptIndex,
    storagePrimary: "chat-state",
    storageMode: "chat-state",
    statusLabel: "聊天侧车",
    reasonPrefix: "chat-state",
  });
  if (commitMarkerDiagnostic?.reason && loadResult?.loaded) {
    updateGraphPersistenceState({
      persistMismatchReason: commitMarkerDiagnostic.reason,
    });
  }
  return loadResult;
}

function scheduleGraphChatStateProbe(chatId, options = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (
    !normalizedChatId ||
    !canUseHostGraphChatStatePersistence(getContext()) ||
    bmeChatStateLoadInFlightByChatId.has(normalizedChatId)
  ) {
    return;
  }

  scheduleBmeIndexedDbTask(() => {
    const loadPromise = loadGraphFromChatState(normalizedChatId, options)
      .catch((error) => {
        console.warn("[ST-BME] 聊天侧车后台加载失败:", error);
      })
      .finally(() => {
        if (
          bmeChatStateLoadInFlightByChatId.get(normalizedChatId) === loadPromise
        ) {
          bmeChatStateLoadInFlightByChatId.delete(normalizedChatId);
        }
      });

    bmeChatStateLoadInFlightByChatId.set(normalizedChatId, loadPromise);
    return loadPromise;
  });
}

function readLegacyGraphFromChatMetadata(chatId, context = getContext()) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  const legacyGraph = context?.chatMetadata?.[GRAPH_METADATA_KEY];
  if (!legacyGraph) return null;

  try {
    const hydratedLegacyGraph =
      typeof legacyGraph === "string"
        ? deserializeGraph(legacyGraph)
        : legacyGraph;
    return cloneGraphForPersistence(
      normalizeGraphRuntimeState(hydratedLegacyGraph, normalizedChatId),
      normalizedChatId,
    );
  } catch (error) {
    console.warn("[ST-BME] 读取 legacy chat_metadata 图谱失败:", error);
    return null;
  }
}

async function maybeRecoverIndexedDbGraphFromStableIdentity(
  chatId,
  context = getContext(),
  { source = "unknown", db = null } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      migrated: false,
      reason: "identity-recovery-missing-chat-id",
      chatId: "",
    };
  }

  const identity = resolveCurrentChatIdentity(context);
  if (!identity.integrity) {
    return {
      migrated: false,
      reason: "identity-recovery-integrity-missing",
      chatId: normalizedChatId,
    };
  }

  const manager = ensureBmeChatManager();
  if (!manager) {
    return {
      migrated: false,
      reason: "identity-recovery-manager-unavailable",
      chatId: normalizedChatId,
    };
  }

  const targetDb = db || (await manager.getCurrentDb(normalizedChatId));
  if (!targetDb) {
    return {
      migrated: false,
      reason: "identity-recovery-db-unavailable",
      chatId: normalizedChatId,
    };
  }

  const emptyStatus = await targetDb.isEmpty();
  if (!emptyStatus?.empty) {
    return {
      migrated: false,
      reason: "identity-recovery-target-not-empty",
      chatId: normalizedChatId,
      emptyStatus,
    };
  }

  const finalizeMigration = async (
    graph,
    {
      revision = 0,
      legacyChatId = "",
      migrationSource = "identity-recovery",
      shadowChatId = "",
    } = {},
  ) => {
    const snapshot = await importRecoveredSnapshotToIndexedDb(
      targetDb,
      normalizedChatId,
      graph,
      {
        revision,
        integrity: identity.integrity,
        source: migrationSource,
        legacyChatId,
      },
    );
    cacheIndexedDbSnapshot(normalizedChatId, snapshot);
    rememberResolvedGraphIdentityAlias(context, normalizedChatId);

    if (shadowChatId && shadowChatId !== normalizedChatId) {
      removeGraphShadowSnapshot(shadowChatId);
    }

    let syncResult = {
      synced: false,
      reason: "identity-recovery-sync-skipped",
      chatId: normalizedChatId,
    };
    try {
      syncResult = await syncNow(
        normalizedChatId,
        buildBmeSyncRuntimeOptions({
          reason: "identity-recovery",
          trigger: `${String(source || "identity-recovery")}:identity-recovery`,
        }),
      );
    } catch (syncError) {
      console.warn("[ST-BME] 身份恢复后的同步失败:", syncError);
      syncResult = {
        synced: false,
        reason: "identity-recovery-sync-failed",
        chatId: normalizedChatId,
        error: syncError?.message || String(syncError),
      };
    }

    return {
      migrated: true,
      reason: "identity-recovery-completed",
      chatId: normalizedChatId,
      legacyChatId: normalizeChatIdCandidate(legacyChatId),
      source: migrationSource,
      snapshot,
      syncResult,
    };
  };

  const currentGraphMeta = getGraphPersistenceMeta(currentGraph) || {};
  const runtimeGraphIntegrity = normalizeChatIdCandidate(
    currentGraphMeta.integrity || graphPersistenceState.metadataIntegrity,
  );
  const runtimeGraphChatId = normalizeChatIdCandidate(
    currentGraph?.historyState?.chatId ||
      currentGraphMeta.chatId ||
      graphPersistenceState.chatId,
  );

  if (
    currentGraph &&
    !isGraphEffectivelyEmpty(currentGraph) &&
    runtimeGraphIntegrity &&
    runtimeGraphIntegrity === identity.integrity &&
    runtimeGraphChatId &&
    runtimeGraphChatId !== normalizedChatId
  ) {
    return await finalizeMigration(currentGraph, {
      revision: Math.max(
        graphPersistenceState.revision || 0,
        getGraphPersistedRevision(currentGraph),
        1,
      ),
      legacyChatId: runtimeGraphChatId,
      migrationSource: "runtime-identity-promotion",
    });
  }

  const aliasShadowSnapshot = findGraphShadowSnapshotByIntegrity(
    identity.integrity,
    {
      excludeChatIds: [normalizedChatId],
    },
  );
  if (aliasShadowSnapshot?.serializedGraph) {
    try {
      const shadowGraph = normalizeGraphRuntimeState(
        deserializeGraph(aliasShadowSnapshot.serializedGraph),
        normalizedChatId,
      );
      if (!isGraphEffectivelyEmpty(shadowGraph)) {
        return await finalizeMigration(shadowGraph, {
          revision: Math.max(
            Number(aliasShadowSnapshot.revision || 0),
            getGraphPersistedRevision(shadowGraph),
            1,
          ),
          legacyChatId:
            aliasShadowSnapshot.persistedChatId || aliasShadowSnapshot.chatId,
          migrationSource: "shadow-identity-recovery",
          shadowChatId: aliasShadowSnapshot.chatId,
        });
      }
    } catch (error) {
      console.warn("[ST-BME] 通过影子快照恢复聊天身份失败:", error);
    }
  }

  const legacyCandidates = buildLegacyGraphIdentityCandidates(
    normalizedChatId,
    context,
    {
      shadowSnapshot: aliasShadowSnapshot,
    },
  );

  for (const legacyChatId of legacyCandidates) {
    try {
      const legacySnapshot = await exportIndexedDbSnapshotForChat(legacyChatId);
      if (!isIndexedDbSnapshotMeaningful(legacySnapshot)) {
        continue;
      }

      const legacyGraph = buildGraphFromSnapshot(legacySnapshot, {
        chatId: legacyChatId,
      });
      if (isGraphEffectivelyEmpty(legacyGraph)) {
        continue;
      }

      return await finalizeMigration(legacyGraph, {
        revision: Math.max(
          normalizeIndexedDbRevision(legacySnapshot?.meta?.revision),
          getGraphPersistedRevision(legacyGraph),
          1,
        ),
        legacyChatId,
        migrationSource: "indexeddb-identity-alias",
      });
    } catch (error) {
      console.warn("[ST-BME] 读取旧身份 IndexedDB 图谱失败:", {
        legacyChatId,
        error,
      });
    }
  }

  return {
    migrated: false,
    reason: "identity-recovery-no-match",
    chatId: normalizedChatId,
  };
}

async function maybeMigrateLegacyGraphToIndexedDb(
  chatId,
  context = getContext(),
  { source = "unknown", db = null } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      migrated: false,
      reason: "migration-missing-chat-id",
      chatId: "",
    };
  }

  const inFlightMigration =
    bmeIndexedDbLegacyMigrationInFlightByChatId.get(normalizedChatId);
  if (inFlightMigration) {
    return await inFlightMigration;
  }

  const migrationTask = (async () => {
    try {
      const manager = ensureBmeChatManager();
      if (!manager) {
        return {
          migrated: false,
          reason: "migration-manager-unavailable",
          chatId: normalizedChatId,
        };
      }

      const targetDb = db || (await manager.getCurrentDb(normalizedChatId));
      if (!targetDb) {
        return {
          migrated: false,
          reason: "migration-db-unavailable",
          chatId: normalizedChatId,
        };
      }

      const contextChatId = resolveCurrentChatIdentity(context).chatId;
      if (contextChatId && contextChatId !== normalizedChatId) {
        return {
          migrated: false,
          reason: "migration-context-chat-mismatch",
          chatId: normalizedChatId,
          contextChatId,
        };
      }

      const migrationCompletedAt = Number(
        await targetDb.getMeta("migrationCompletedAt", 0),
      );
      if (Number.isFinite(migrationCompletedAt) && migrationCompletedAt > 0) {
        return {
          migrated: false,
          reason: "migration-already-completed",
          chatId: normalizedChatId,
          migrationCompletedAt,
        };
      }

      const legacyGraph = readLegacyGraphFromChatMetadata(
        normalizedChatId,
        context,
      );
      if (!legacyGraph) {
        return {
          migrated: false,
          reason: "migration-legacy-graph-missing",
          chatId: normalizedChatId,
        };
      }

      const emptyStatus = await targetDb.isEmpty();
      if (!emptyStatus?.empty) {
        return {
          migrated: false,
          reason: "migration-indexeddb-not-empty",
          chatId: normalizedChatId,
          emptyStatus,
        };
      }

      const legacyRevision = Math.max(
        normalizeIndexedDbRevision(getGraphPersistedRevision(legacyGraph), 0),
        1,
      );
      const migrationResult = await targetDb.importLegacyGraph(legacyGraph, {
        source: "chat_metadata",
        revision: legacyRevision,
      });
      if (!migrationResult?.migrated) {
        return {
          migrated: false,
          reason: migrationResult?.reason || "migration-skipped",
          chatId: normalizedChatId,
          migrationResult,
        };
      }

      const postMigrationSnapshot = await targetDb.exportSnapshot();
      cacheIndexedDbSnapshot(normalizedChatId, postMigrationSnapshot);
      debugDebug("[ST-BME] legacy chat_metadata 图谱迁移完成", {
        source,
        chatId: normalizedChatId,
        revision:
          postMigrationSnapshot?.meta?.revision ||
          migrationResult?.revision ||
          0,
        imported: migrationResult.imported,
      });

      let syncResult = {
        synced: false,
        reason: "post-migration-sync-skipped",
        chatId: normalizedChatId,
      };
      try {
        syncResult = await syncNow(
          normalizedChatId,
          buildBmeSyncRuntimeOptions({
            reason: "post-migration",
            trigger: `${String(source || "migration")}:post-migration`,
          }),
        );
      } catch (syncError) {
        console.warn("[ST-BME] legacy 迁移后立即同步失败:", syncError);
        syncResult = {
          synced: false,
          reason: "post-migration-sync-failed",
          chatId: normalizedChatId,
          error: syncError?.message || String(syncError),
        };
      }

      return {
        migrated: true,
        reason: "migration-completed",
        chatId: normalizedChatId,
        migrationResult,
        snapshot: postMigrationSnapshot,
        syncResult,
      };
    } catch (error) {
      console.warn("[ST-BME] legacy chat_metadata 迁移失败:", error);
      return {
        migrated: false,
        reason: "migration-failed",
        chatId: normalizedChatId,
        error: error?.message || String(error),
      };
    }
  })().finally(() => {
    if (
      bmeIndexedDbLegacyMigrationInFlightByChatId.get(normalizedChatId) ===
      migrationTask
    ) {
      bmeIndexedDbLegacyMigrationInFlightByChatId.delete(normalizedChatId);
    }
  });

  bmeIndexedDbLegacyMigrationInFlightByChatId.set(
    normalizedChatId,
    migrationTask,
  );
  return await migrationTask;
}

function applyIndexedDbEmptyToRuntime(
  chatId,
  { source = "indexeddb-empty", attemptIndex = 0 } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "indexeddb-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
  }

  currentGraph = normalizeGraphRuntimeState(
    createEmptyGraph(),
    normalizedChatId,
  );
  extractionCount = 0;
  lastExtractedItems = [];
  lastRecalledItems = [];
  lastInjectionContent = "";
  runtimeStatus = createUiStatus("待命", "当前聊天还没有图谱", "idle");
  lastExtractionStatus = createUiStatus("待命", "当前聊天尚未执行提取", "idle");
  lastVectorStatus = createUiStatus("待命", "当前聊天尚未执行向量任务", "idle");
  lastRecallStatus = createUiStatus("待命", "当前聊天尚未建立记忆图谱", "idle");

  applyGraphLoadState(GRAPH_LOAD_STATES.EMPTY_CONFIRMED, {
    chatId: normalizedChatId,
    reason: `indexeddb-empty:${String(source || "indexeddb-empty")}`,
    attemptIndex,
    revision: 0,
    lastPersistedRevision: 0,
    queuedPersistRevision: 0,
    queuedPersistChatId: "",
    pendingPersist: false,
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    dbReady: true,
    writesBlocked: false,
  });

  updateGraphPersistenceState({
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    dbReady: true,
    persistMismatchReason: "",
    indexedDbRevision: 0,
    indexedDbLastError: "",
    dualWriteLastResult: {
      action: "load",
      source: String(source || "indexeddb-empty"),
      success: true,
      empty: true,
      at: Date.now(),
    },
  });

  refreshPanelLiveState();
  return {
    success: true,
    loaded: false,
    emptyConfirmed: true,
    loadState: GRAPH_LOAD_STATES.EMPTY_CONFIRMED,
    reason: `indexeddb-empty:${String(source || "indexeddb-empty")}`,
    chatId: normalizedChatId,
    attemptIndex,
  };
}

function applyIndexedDbSnapshotToRuntime(
  chatId,
  snapshot,
  {
    source = "indexeddb",
    attemptIndex = 0,
    storagePrimary = "indexeddb",
    storageMode = storagePrimary,
    statusLabel = "IndexedDB",
    reasonPrefix = "indexeddb",
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  syncCommitMarkerToPersistenceState(getContext());
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot)) {
    return {
      success: false,
      loaded: false,
      reason: `${reasonPrefix}-empty`,
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const revision = Math.max(
    1,
    normalizeIndexedDbRevision(snapshot?.meta?.revision),
  );
  const staleDecision = detectStaleIndexedDbSnapshotAgainstRuntime(
    normalizedChatId,
    snapshot,
  );
  if (staleDecision.stale) {
    const persistencePatch = {
      storagePrimary: graphPersistenceState.storagePrimary || storagePrimary,
      storageMode: graphPersistenceState.storageMode || storageMode,
      metadataIntegrity:
        getChatMetadataIntegrity(getContext()) ||
        graphPersistenceState.metadataIntegrity,
      indexedDbLastError: "",
      dualWriteLastResult: {
        action: "load",
        source: String(source || reasonPrefix),
        success: false,
        rejected: true,
        reason: `${reasonPrefix}-stale-runtime`,
        revision,
        staleDetail: cloneRuntimeDebugValue(staleDecision, null),
        at: Date.now(),
      },
    };
    if (storagePrimary === "indexeddb") {
      persistencePatch.indexedDbRevision = Math.max(
        graphPersistenceState.indexedDbRevision || 0,
        revision,
      );
    }
    updateGraphPersistenceState({
      ...persistencePatch,
    });
    debugDebug(`[ST-BME] 已拒绝用较旧 ${statusLabel} 快照覆盖当前运行时图谱`, {
      chatId: normalizedChatId,
      source,
      revision,
      staleDetail: staleDecision,
    });
    return {
      success: false,
      loaded: false,
      reason: `${reasonPrefix}-stale-runtime`,
      chatId: normalizedChatId,
      attemptIndex,
      revision,
      staleDetail: cloneRuntimeDebugValue(staleDecision, null),
    };
  }
  let graphFromSnapshot = null;
  try {
    graphFromSnapshot = buildGraphFromSnapshot(snapshot, {
      chatId: normalizedChatId,
    });
  } catch (error) {
    const failureReason =
      error?.code === "BME_SNAPSHOT_INTEGRITY_ERROR"
        ? `${reasonPrefix}-snapshot-integrity-rejected`
        : `${reasonPrefix}-snapshot-load-failed`;
    const persistencePatch = {
      storagePrimary,
      storageMode,
      dbReady: true,
      indexedDbLastError: error?.message || String(error),
      dualWriteLastResult: {
        action: "load",
        source: String(source || reasonPrefix),
        success: false,
        rejected: true,
        reason: failureReason,
        revision,
        at: Date.now(),
      },
    };
    if (storagePrimary === "indexeddb") {
      persistencePatch.indexedDbRevision = revision;
    }
    updateGraphPersistenceState({
      ...persistencePatch,
    });
    console.warn(`[ST-BME] ${statusLabel} 图谱快照已拒绝加载`, {
      chatId: normalizedChatId,
      source,
      revision,
      reason: failureReason,
      detail: error?.message || String(error),
      integrityReasons: Array.isArray(error?.reasons) ? error.reasons : [],
    });
    return {
      success: false,
      loaded: false,
      reason: failureReason,
      detail: error?.message || String(error),
      integrityReasons: Array.isArray(error?.reasons) ? error.reasons : [],
      chatId: normalizedChatId,
      attemptIndex,
    };
  }
  currentGraph = cloneGraphForPersistence(
    normalizeGraphRuntimeState(graphFromSnapshot, normalizedChatId),
    normalizedChatId,
  );
  stampGraphPersistenceMeta(currentGraph, {
    revision,
    reason: `${reasonPrefix}:${String(source || reasonPrefix)}`,
    chatId: normalizedChatId,
    integrity:
      normalizeChatIdCandidate(snapshot?.meta?.integrity) ||
      getChatMetadataIntegrity(getContext()),
  });
  currentGraph.vectorIndexState.lastIntegrityIssue = null;

  extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount)
    ? currentGraph.historyState.extractionCount
    : 0;
  lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  runtimeStatus = createUiStatus("待命", `已从${statusLabel}加载聊天图谱`, "idle");
  lastExtractionStatus = createUiStatus(
    "待命",
    `已从${statusLabel}加载聊天图谱，等待下一次提取`,
    "idle",
  );
  lastVectorStatus = createUiStatus(
    "待命",
    currentGraph.vectorIndexState?.lastWarning ||
      `已从${statusLabel}加载聊天图谱，等待下一次向量任务`,
    "idle",
  );
  lastRecallStatus = createUiStatus(
    "待命",
    restoredRecallUi.restored
      ? "已从持久化召回记录恢复显示，等待下一次召回"
      : `已从${statusLabel}加载聊天图谱，等待下一次召回`,
    "idle",
  );

  applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, {
    chatId: normalizedChatId,
    reason: `${reasonPrefix}:${source}`,
    attemptIndex,
    revision,
    lastPersistedRevision: Math.max(
      graphPersistenceState.lastPersistedRevision || 0,
      revision,
    ),
    queuedPersistRevision: 0,
    pendingPersist: false,
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    writesBlocked: false,
  });
  const persistencePatch = {
    storagePrimary,
    storageMode,
    dbReady: true,
    persistMismatchReason: "",
    metadataIntegrity:
      getChatMetadataIntegrity(getContext()) ||
        graphPersistenceState.metadataIntegrity,
    indexedDbLastError: storagePrimary === "indexeddb" ? "" : graphPersistenceState.indexedDbLastError,
    lastAcceptedRevision: Math.max(
      Number(graphPersistenceState.lastAcceptedRevision || 0),
      revision,
    ),
    lastSyncError: "",
    dualWriteLastResult: {
      action: "load",
      source: String(source || reasonPrefix),
      success: true,
      reason: `${reasonPrefix}-loaded`,
      revision,
      at: Date.now(),
    },
  };
  if (storagePrimary === "indexeddb") {
    persistencePatch.indexedDbRevision = revision;
  }
  updateGraphPersistenceState(persistencePatch);
  rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

  removeGraphShadowSnapshot(normalizedChatId);
  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh(30);
  debugDebug(`[ST-BME] 已从${statusLabel}加载图谱`, {
    chatId: normalizedChatId,
    source,
    revision,
    ...getGraphStats(currentGraph),
  });

  return {
    success: true,
    loaded: true,
    loadState: GRAPH_LOAD_STATES.LOADED,
    reason: `${reasonPrefix}:${source}`,
    chatId: normalizedChatId,
    attemptIndex,
    shadowSnapshotUsed: false,
    revision,
  };
}

async function loadGraphFromIndexedDb(
  chatId,
  {
    source = "indexeddb-probe",
    attemptIndex = 0,
    allowOverride = false,
    applyEmptyState = false,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const commitMarker = syncCommitMarkerToPersistenceState(getContext());
  if (!normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "indexeddb-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
  }

  try {
    const manager = ensureBmeChatManager();
    if (!manager) {
      return {
        success: false,
        loaded: false,
        reason: "indexeddb-manager-unavailable",
        chatId: normalizedChatId,
        attemptIndex,
      };
    }
    const db = await manager.getCurrentDb(normalizedChatId);

    const identityRecoveryResult =
      await maybeRecoverIndexedDbGraphFromStableIdentity(
        normalizedChatId,
        getContext(),
        {
          source,
          db,
        },
      );

    if (identityRecoveryResult?.migrated) {
      const recoveredRevision = normalizeIndexedDbRevision(
        identityRecoveryResult?.snapshot?.meta?.revision,
      );
      updateGraphPersistenceState({
        storagePrimary: "indexeddb",
        storageMode: "indexeddb",
        indexedDbRevision: recoveredRevision,
        indexedDbLastError: "",
        lastSyncError: "",
        dualWriteLastResult: {
          action: "identity-recovery",
          source: String(identityRecoveryResult?.source || "indexeddb"),
          success: true,
          chatId: normalizedChatId,
          legacyChatId: String(identityRecoveryResult?.legacyChatId || ""),
          revision: recoveredRevision,
          reason: String(
            identityRecoveryResult?.reason || "identity-recovery",
          ),
          at: Date.now(),
          syncResult: cloneRuntimeDebugValue(
            identityRecoveryResult?.syncResult,
            null,
          ),
        },
      });
    }

    const migrationResult = identityRecoveryResult?.migrated
      ? {
          migrated: false,
          reason: "identity-recovery-already-applied",
          chatId: normalizedChatId,
        }
      : await maybeMigrateLegacyGraphToIndexedDb(
          normalizedChatId,
          getContext(),
          {
            source,
            db,
          },
        );

    if (migrationResult?.migrated) {
      const migratedRevision = normalizeIndexedDbRevision(
        migrationResult?.snapshot?.meta?.revision ||
          migrationResult?.migrationResult?.revision,
      );
      updateGraphPersistenceState({
        storagePrimary: "indexeddb",
        storageMode: "indexeddb",
        indexedDbRevision: migratedRevision,
        indexedDbLastError: "",
        lastSyncError: "",
        dualWriteLastResult: {
          action: "migration",
          source: "chat_metadata",
          success: true,
          chatId: normalizedChatId,
          revision: migratedRevision,
          reason: migrationResult?.reason || "migration-completed",
          at: Date.now(),
          syncResult: cloneRuntimeDebugValue(migrationResult?.syncResult, null),
        },
      });
    } else if (migrationResult?.reason === "migration-failed") {
      updateGraphPersistenceState({
        indexedDbLastError: String(
          migrationResult?.error || "migration-failed",
        ),
        dualWriteLastResult: {
          action: "migration",
          source: "chat_metadata",
          success: false,
          error: String(migrationResult?.error || "migration-failed"),
          at: Date.now(),
        },
      });
    }
    const snapshot =
      identityRecoveryResult?.snapshot ||
      migrationResult?.snapshot ||
      (await db.exportSnapshot());
    const shadowSnapshot = resolveCompatibleGraphShadowSnapshot(
      resolveCurrentChatIdentity(getContext()),
    );

    cacheIndexedDbSnapshot(normalizedChatId, snapshot);

    const commitMarkerMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
      snapshot,
      commitMarker,
    );
    let commitMarkerDiagnostic = null;
    if (!isIndexedDbSnapshotMeaningful(snapshot)) {
      if (commitMarkerMismatch.mismatched) {
        commitMarkerDiagnostic = recordPersistMismatchDiagnostic(
          commitMarkerMismatch,
          {
            source: `${source}:indexeddb-empty`,
          },
        );
        if (
          shadowSnapshot &&
          Number(shadowSnapshot.revision || 0) >=
            Number(commitMarkerMismatch.markerRevision || 0)
        ) {
          const shadowRestoreResult = applyShadowSnapshotToRuntime(
            normalizedChatId,
            shadowSnapshot,
            {
              source: `${source}:shadow-indexeddb-empty`,
              attemptIndex,
            },
          );
          if (shadowRestoreResult?.loaded) {
            updateGraphPersistenceState({
              persistMismatchReason: commitMarkerDiagnostic.reason,
            });
            return shadowRestoreResult;
          }
        }
      }
      if (shadowSnapshot) {
        const shadowRestoreResult = applyShadowSnapshotToRuntime(
          normalizedChatId,
          shadowSnapshot,
          {
            source: `${source}:shadow-indexeddb-empty`,
            attemptIndex,
          },
        );
        if (shadowRestoreResult?.loaded) {
          return shadowRestoreResult;
        }
      }
      if (
        applyEmptyState &&
        !commitMarkerDiagnostic?.reason &&
        getCurrentChatId() === normalizedChatId
      ) {
        return applyIndexedDbEmptyToRuntime(normalizedChatId, {
          source,
          attemptIndex,
        });
      }
      return {
        success: false,
        loaded: false,
        reason: commitMarkerDiagnostic?.reason || "indexeddb-empty",
        chatId: normalizedChatId,
        attemptIndex,
      };
    }

    const snapshotRevision = normalizeIndexedDbRevision(
      snapshot?.meta?.revision,
    );
    const snapshotIntegrity = String(snapshot?.meta?.integrity || "").trim();
    const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
      createShadowComparisonGraph({
        chatId: normalizedChatId,
        revision: snapshotRevision,
        integrity: snapshotIntegrity,
      }),
      shadowSnapshot,
    );
    if (shadowSnapshot && shadowDecision?.reason) {
      updateGraphPersistenceState({
        dualWriteLastResult: {
          action: "shadow-compare",
          source: `${source}:indexeddb-shadow-compare`,
          success: Boolean(shadowDecision.prefer),
          reason: shadowDecision.reason,
          resultCode: String(shadowDecision.resultCode || ""),
          shadowRevision: Number(shadowSnapshot.revision || 0),
          officialRevision: snapshotRevision,
          at: Date.now(),
        },
      });
    }
    if (shadowSnapshot && shadowDecision?.prefer) {
      return applyShadowSnapshotToRuntime(
        normalizedChatId,
        shadowSnapshot,
        {
          source: `${source}:shadow-newer-than-indexeddb`,
          attemptIndex,
        },
      );
    }
    if (commitMarkerMismatch.mismatched) {
      commitMarkerDiagnostic = recordPersistMismatchDiagnostic(
        {
          ...commitMarkerMismatch,
          marker: commitMarkerMismatch.marker || commitMarker,
        },
        {
          source: `${source}:indexeddb-commit-marker`,
        },
      );
      if (
        shadowSnapshot &&
        Number(shadowSnapshot.revision || 0) >=
          Number(commitMarkerMismatch.markerRevision || 0)
      ) {
        const shadowResult = applyShadowSnapshotToRuntime(
          normalizedChatId,
          shadowSnapshot,
          {
            source: `${source}:shadow-beats-commit-marker`,
            attemptIndex,
          },
        );
        if (shadowResult?.loaded && commitMarkerDiagnostic?.reason) {
          updateGraphPersistenceState({
            persistMismatchReason: commitMarkerDiagnostic.reason,
          });
        }
        return shadowResult;
      }
    }
    const shouldAllowOverride =
      allowOverride ||
      BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(
        graphPersistenceState.loadState,
      ) ||
      graphPersistenceState.storagePrimary === "indexeddb" ||
      snapshotRevision >=
        normalizeIndexedDbRevision(graphPersistenceState.revision);

    if (!shouldAllowOverride) {
      return {
        success: false,
        loaded: false,
        reason: "indexeddb-stale",
        chatId: normalizedChatId,
        attemptIndex,
        revision: snapshotRevision,
      };
    }

    if (getCurrentChatId() !== normalizedChatId) {
      return {
        success: false,
        loaded: false,
        reason: "indexeddb-chat-switched",
        chatId: normalizedChatId,
        attemptIndex,
        revision: snapshotRevision,
      };
    }

    const loadResult = applyIndexedDbSnapshotToRuntime(normalizedChatId, snapshot, {
      source,
      attemptIndex,
    });
    if (commitMarkerDiagnostic?.reason && loadResult?.loaded) {
      updateGraphPersistenceState({
        persistMismatchReason: commitMarkerDiagnostic.reason,
      });
    }
    return loadResult;
  } catch (error) {
    console.warn("[ST-BME] IndexedDB 读取失败，回退 metadata:", error);
    updateGraphPersistenceState({
      indexedDbLastError: error?.message || String(error),
      dualWriteLastResult: {
        action: "load",
        source: String(source || "indexeddb"),
        success: false,
        error: error?.message || String(error),
        at: Date.now(),
      },
    });
    return {
      success: false,
      loaded: false,
      reason: "indexeddb-read-failed",
      chatId: normalizedChatId,
      attemptIndex,
      error,
    };
  }
}

function scheduleIndexedDbGraphProbe(chatId, options = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (
    !normalizedChatId ||
    bmeIndexedDbLoadInFlightByChatId.has(normalizedChatId)
  ) {
    return;
  }

  scheduleBmeIndexedDbTask(() => {
    const loadPromise = loadGraphFromIndexedDb(normalizedChatId, options)
      .catch((error) => {
        console.warn("[ST-BME] IndexedDB 后台加载失败:", error);
      })
      .finally(() => {
        if (
          bmeIndexedDbLoadInFlightByChatId.get(normalizedChatId) === loadPromise
        ) {
          bmeIndexedDbLoadInFlightByChatId.delete(normalizedChatId);
        }
      });

    bmeIndexedDbLoadInFlightByChatId.set(normalizedChatId, loadPromise);
    return loadPromise;
  });
}

function resolveInjectionPromptType(settings = {}) {
  const normalized = String(settings?.injectPosition || "atDepth")
    .trim()
    .toLowerCase();

  switch (normalized) {
    case "none":
      return extension_prompt_types.NONE;
    case "beforeprompt":
    case "before_prompt":
    case "before-prompt":
      return extension_prompt_types.BEFORE_PROMPT;
    case "inprompt":
    case "in_prompt":
    case "in-prompt":
      return extension_prompt_types.IN_PROMPT;
    case "atdepth":
    case "at_depth":
    case "inchat":
    case "in_chat":
    case "chat":
    default:
      return extension_prompt_types.IN_CHAT;
  }
}

function resolveInjectionPromptRole(settings = {}) {
  switch (Number(settings?.injectRole)) {
    case 1:
      return extension_prompt_roles.USER;
    case 2:
      return extension_prompt_roles.ASSISTANT;
    default:
      return extension_prompt_roles.SYSTEM;
  }
}

function applyModuleInjectionPrompt(content = "", settings = getSettings()) {
  const position = resolveInjectionPromptType(settings);
  const depth =
    position === extension_prompt_types.IN_CHAT
      ? clampInt(settings?.injectDepth, 9999, 0, 9999)
      : 0;
  const role = resolveInjectionPromptRole(settings);
  const adapter = getHostAdapter?.();
  const injectionHost = adapter?.injection;

  if (
    typeof injectionHost?.setExtensionPrompt === "function" &&
    injectionHost.setExtensionPrompt(
      MODULE_NAME,
      content,
      position,
      depth,
      false,
      role,
    )
  ) {
    return {
      applied: true,
      source: "host-adapter",
      mode: injectionHost.readInjectionSupport?.()?.mode || "",
      position,
      depth,
      role,
    };
  }

  const context = getContext();
  if (typeof context?.setExtensionPrompt === "function") {
    context.setExtensionPrompt(
      MODULE_NAME,
      content,
      position,
      depth,
      false,
      role,
    );
    return {
      applied: true,
      source: "context",
      mode: "legacy-context-setter",
      position,
      depth,
      role,
    };
  }

  return {
    applied: false,
    source: "unavailable",
    mode: "unavailable",
    position,
    depth,
    role,
  };
}

function ensureCurrentGraphRuntimeState() {
  if (!currentGraph) {
    currentGraph = createEmptyGraph();
  }

  currentGraph = normalizeGraphRuntimeState(currentGraph, getCurrentChatId());
  return currentGraph;
}

function clearPendingGraphLoadRetry({ resetChatId = true } = {}) {
  if (pendingGraphLoadRetryTimer) {
    clearTimeout(pendingGraphLoadRetryTimer);
    pendingGraphLoadRetryTimer = null;
  }

  if (resetChatId) {
    pendingGraphLoadRetryChatId = "";
  }
}

function isGraphLoadRetryPending(chatId = getCurrentChatId()) {
  const normalizedChatId = String(chatId || "");
  return (
    Boolean(normalizedChatId) &&
    pendingGraphLoadRetryChatId === normalizedChatId
  );
}

function clearPendingAutoExtraction({ resetState = true } = {}) {
  if (pendingAutoExtractionTimer) {
    clearTimeout(pendingAutoExtractionTimer);
    pendingAutoExtractionTimer = null;
  }

  if (resetState) {
    pendingAutoExtraction = {
      chatId: "",
      messageId: null,
      reason: "",
      requestedAt: 0,
      attempts: 0,
      targetEndFloor: null,
      strategy: "normal",
    };
  }
}

function deferAutoExtraction(
  reason = "auto-extraction-deferred",
  {
    chatId = getCurrentChatId(),
    messageId = null,
    delayMs = null,
    targetEndFloor = null,
    strategy = "",
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    clearPendingAutoExtraction();
    return {
      scheduled: false,
      reason: "missing-chat-id",
      chatId: "",
    };
  }

  const sameChat = normalizedChatId === pendingAutoExtraction.chatId;
  const previousAttempts = sameChat
    ? Math.max(0, Math.floor(Number(pendingAutoExtraction.attempts) || 0))
    : 0;
  const nextAttempts = previousAttempts + 1;
  const resolvedDelayMs =
    delayMs !== null &&
    delayMs !== undefined &&
    Number.isFinite(Number(delayMs))
    ? Math.max(0, Math.floor(Number(delayMs)))
    : AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS[
        Math.min(
          previousAttempts,
          AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS.length - 1,
        )
      ];

  pendingAutoExtraction = {
    chatId: normalizedChatId,
    messageId: Number.isFinite(Number(messageId))
      ? Math.floor(Number(messageId))
      : sameChat
        ? pendingAutoExtraction.messageId
        : null,
    reason: String(reason || "auto-extraction-deferred"),
    requestedAt:
      sameChat && pendingAutoExtraction.requestedAt > 0
        ? pendingAutoExtraction.requestedAt
        : Date.now(),
    attempts: nextAttempts,
    targetEndFloor: Number.isFinite(Number(targetEndFloor))
      ? sameChat &&
        Number.isFinite(Number(pendingAutoExtraction.targetEndFloor))
        ? Math.max(
            Math.floor(Number(targetEndFloor)),
            Math.floor(Number(pendingAutoExtraction.targetEndFloor)),
          )
        : Math.floor(Number(targetEndFloor))
      : sameChat
        ? pendingAutoExtraction.targetEndFloor
        : null,
    strategy: String(strategy || "")
      ? String(strategy || "")
      : sameChat
        ? String(pendingAutoExtraction.strategy || "normal")
        : "normal",
  };

  if (pendingAutoExtractionTimer) {
    clearTimeout(pendingAutoExtractionTimer);
  }

  pendingAutoExtractionTimer = setTimeout(() => {
    pendingAutoExtractionTimer = null;
    void maybeResumePendingAutoExtraction(
      `retry:${pendingAutoExtraction.reason || "auto-extraction-deferred"}`,
    );
  }, resolvedDelayMs);
  console.debug?.("[ST-BME] auto extraction deferred", {
    reason: pendingAutoExtraction.reason,
    chatId: normalizedChatId,
    messageId: pendingAutoExtraction.messageId,
    targetEndFloor: pendingAutoExtraction.targetEndFloor,
    strategy: pendingAutoExtraction.strategy,
    attempts: nextAttempts,
    delayMs: resolvedDelayMs,
  });

  return {
    scheduled: true,
    chatId: normalizedChatId,
    messageId: pendingAutoExtraction.messageId,
    reason: pendingAutoExtraction.reason,
    targetEndFloor: pendingAutoExtraction.targetEndFloor,
    strategy: pendingAutoExtraction.strategy,
    attempts: nextAttempts,
    delayMs: resolvedDelayMs,
  };
}

function resolveAutoExtractionPlan({
  chat = null,
  settings = null,
  lastProcessedAssistantFloor = null,
  lockedEndFloor = null,
} = {}) {
  return resolveAutoExtractionPlanController(
    {
      getAssistantTurns,
      getSmartTriggerDecision,
    },
    {
      chat,
      settings,
      lastProcessedAssistantFloor:
        Number.isFinite(Number(lastProcessedAssistantFloor))
          ? Math.floor(Number(lastProcessedAssistantFloor))
          : getLastProcessedAssistantFloor(),
      lockedEndFloor,
    },
  );
}

function maybeResumePendingAutoExtraction(source = "auto-extraction-resume") {
  const pendingChatId = normalizeChatIdCandidate(pendingAutoExtraction.chatId);
  if (!pendingChatId) {
    return {
      resumed: false,
      reason: "no-pending-auto-extraction",
    };
  }

  if (isRestoreLockActive()) {
    return {
      resumed: false,
      reason: "restore-lock-active",
      restoreLock: cloneRuntimeDebugValue(
        normalizeRestoreLockState(graphPersistenceState.restoreLock),
        null,
      ),
    };
  }

  const currentChatId = normalizeChatIdCandidate(getCurrentChatId());
  if (!currentChatId || currentChatId !== pendingChatId) {
    clearPendingAutoExtraction();
    return {
      resumed: false,
      reason: "chat-switched",
      chatId: pendingChatId,
      currentChatId,
    };
  }

  if (isExtracting) {
    return deferAutoExtraction("extracting", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  if (isHostGenerationRunning) {
    return deferAutoExtraction("generation-running", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  const hostGenerationSettleRemainingMs =
    lastHostGenerationEndedAt > 0
      ? AUTO_EXTRACTION_HOST_SETTLE_MS -
        (Date.now() - lastHostGenerationEndedAt)
      : 0;
  if (hostGenerationSettleRemainingMs > 0) {
    return deferAutoExtraction("generation-settling", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      delayMs: hostGenerationSettleRemainingMs,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  if (isRecoveringHistory) {
    return deferAutoExtraction("history-recovering", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  if (!ensureGraphMutationReady("自动提取", { notify: false })) {
    console.debug?.(
      "[ST-BME] pending auto extraction resume blocked: graph-not-ready",
      {
        source,
        chatId: pendingChatId,
        attempts: pendingAutoExtraction.attempts || 0,
        loadState: graphPersistenceState.loadState || "",
      },
    );
    return deferAutoExtraction("graph-not-ready", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  const resumeContext = getContext();
  const resumeChat = resumeContext?.chat;
  const settings = getSettings();
  let lockedEndFloor = Number.isFinite(Number(pendingAutoExtraction.targetEndFloor))
    ? Math.floor(Number(pendingAutoExtraction.targetEndFloor))
    : null;
  if (
    Array.isArray(resumeChat) &&
    Number.isFinite(Number(pendingAutoExtraction.messageId))
  ) {
    const pendingMessageIndex = Math.floor(
      Number(pendingAutoExtraction.messageId),
    );
    const pendingMessage = resumeChat[pendingMessageIndex];
    if (
      isAssistantChatMessage(pendingMessage, {
        index: pendingMessageIndex,
        chat: resumeChat,
      }) &&
      !String(pendingMessage?.mes ?? "").trim()
    ) {
      return deferAutoExtraction("assistant-message-empty", {
        chatId: pendingChatId,
        messageId: pendingMessageIndex,
        delayMs: AUTO_EXTRACTION_HOST_SETTLE_MS,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }
  }

  if (Array.isArray(resumeChat) && resumeChat.length > 0 && lockedEndFloor != null) {
    const lockedPlan = resolveAutoExtractionPlan({
      chat: resumeChat,
      settings,
      lockedEndFloor,
    });
    if (
      !lockedPlan.canRun &&
      lockedPlan.candidateAssistantTurns.length === 0
    ) {
      const fallbackPlan = resolveAutoExtractionPlan({
        chat: resumeChat,
        settings,
      });
      lockedEndFloor = fallbackPlan.canRun
        ? fallbackPlan.plannedBatchEndFloor
        : null;
    }
  }

  const pendingRequest = { ...pendingAutoExtraction };
  clearPendingAutoExtraction();
  if (lockedEndFloor == null) {
    const currentPlan = resolveAutoExtractionPlan({
      chat: resumeChat,
      settings,
    });
    if (!currentPlan.canRun) {
      return {
        resumed: false,
        reason: "no-runnable-auto-extraction",
        source,
        ...pendingRequest,
      };
    }
    lockedEndFloor = currentPlan.plannedBatchEndFloor;
  }
  console.debug?.("[ST-BME] resuming pending auto extraction", {
    source,
    chatId: pendingRequest.chatId,
    messageId: pendingRequest.messageId,
    targetEndFloor: lockedEndFloor,
    attempts: pendingRequest.attempts || 0,
  });
  const enqueueMicrotask =
    typeof globalThis.queueMicrotask === "function"
      ? globalThis.queueMicrotask.bind(globalThis)
      : (task) => Promise.resolve().then(task);
  enqueueMicrotask(() => {
    void runExtraction({
      lockedEndFloor,
      triggerSource: source,
    }).catch((error) => {
      console.error("[ST-BME] 延迟自动提取失败:", error);
      notifyExtractionIssue(error?.message || String(error) || "自动提取失败");
    });
  });

  return {
    resumed: true,
    source,
    lockedEndFloor,
    ...pendingRequest,
  };
}

function markDryRunPromptPreview(ttlMs = GENERATION_RECALL_HOOK_BRIDGE_MS) {
  const resolvedTtlMs = Math.max(
    100,
    Math.floor(Number(ttlMs) || GENERATION_RECALL_HOOK_BRIDGE_MS),
  );
  skipBeforeCombineRecallUntil = Date.now() + resolvedTtlMs;
  return skipBeforeCombineRecallUntil;
}

function clearDryRunPromptPreview() {
  const hadPendingSkip = skipBeforeCombineRecallUntil > Date.now();
  skipBeforeCombineRecallUntil = 0;
  return hadPendingSkip;
}

function consumeDryRunPromptPreview(now = Date.now()) {
  if (skipBeforeCombineRecallUntil <= now) {
    if (skipBeforeCombineRecallUntil !== 0) {
      skipBeforeCombineRecallUntil = 0;
    }
    return false;
  }

  skipBeforeCombineRecallUntil = 0;
  return true;
}

function isGraphEffectivelyEmpty(graph) {
  if (!graph || typeof graph !== "object") {
    return true;
  }

  const stats = getGraphStats(graph);
  if ((stats.totalNodes || 0) > 0 || (stats.totalEdges || 0) > 0) {
    return false;
  }
  if (Number.isFinite(stats.lastProcessedSeq) && stats.lastProcessedSeq >= 0) {
    return false;
  }
  if (Array.isArray(graph.batchJournal) && graph.batchJournal.length > 0) {
    return false;
  }
  if (
    graph.lastRecallResult &&
    (!Array.isArray(graph.lastRecallResult) ||
      graph.lastRecallResult.length > 0)
  ) {
    return false;
  }
  if (
    Object.keys(graph?.historyState?.processedMessageHashes || {}).length > 0
  ) {
    return false;
  }
  if (Object.keys(graph?.vectorIndexState?.hashToNodeId || {}).length > 0) {
    return false;
  }

  return true;
}

function buildGraphPersistResult({
  saved = false,
  queued = false,
  blocked = false,
  accepted = false,
  recoverable = false,
  storageTier = "none",
  reason = "",
  loadState = graphPersistenceState.loadState,
  revision = graphPersistenceState.revision,
  saveMode = graphPersistenceState.lastPersistMode,
} = {}) {
  return {
    saved,
    queued,
    blocked,
    accepted,
    recoverable,
    storageTier: String(storageTier || "none"),
    reason: String(reason || ""),
    loadState,
    revision: Number.isFinite(revision) ? revision : 0,
    saveMode: String(saveMode || ""),
  };
}

function maybeCaptureGraphShadowSnapshot(
  reason = "runtime-shadow",
  {
    graph = currentGraph,
    chatId = graphPersistenceState.chatId || getCurrentChatId(),
    revision = graphPersistenceState.revision,
  } = {},
) {
  if (!chatId || !graph) return false;
  const hasMeaningfulGraphData =
    !isGraphEffectivelyEmpty(graph) ||
    graphPersistenceState.shadowSnapshotUsed ||
    graphPersistenceState.lastPersistedRevision > 0;
  if (!hasMeaningfulGraphData) return false;
  return writeGraphShadowSnapshot(chatId, graph, {
    revision,
    reason,
  });
}

function clearPendingGraphPersistRetry({ resetChatId = true } = {}) {
  if (pendingGraphPersistRetryTimer) {
    clearTimeout(pendingGraphPersistRetryTimer);
    pendingGraphPersistRetryTimer = null;
  }
  pendingGraphPersistRetryAttempt = 0;
  if (resetChatId) {
    pendingGraphPersistRetryChatId = "";
  }
}

function canPersistGraphToMetadataFallback(
  context = getContext(),
  graph = currentGraph,
) {
  if (isGraphMetadataWriteAllowed()) {
    return true;
  }

  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  if (!context || !graph || !activeChatId) {
    return false;
  }

  const identity = resolveCurrentChatIdentity(context);
  const runtimeGraphChatId = normalizeChatIdCandidate(
    graph?.historyState?.chatId,
  );
  const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
  const sameRuntimeChat =
    !runtimeGraphChatId ||
    areChatIdsEquivalentForResolvedIdentity(
      runtimeGraphChatId,
      activeChatId,
      identity,
    ) ||
    areChatIdsEquivalentForResolvedIdentity(
      activeChatId,
      runtimeGraphChatId,
      identity,
    );
  const sameStateChat =
    !stateChatId ||
    areChatIdsEquivalentForResolvedIdentity(
      stateChatId,
      activeChatId,
      identity,
    ) ||
    areChatIdsEquivalentForResolvedIdentity(
      activeChatId,
      stateChatId,
      identity,
    );

  return (
    graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT &&
    sameRuntimeChat &&
    sameStateChat &&
    typeof graph === "object" &&
    graph !== null
  );
}

function buildBatchPersistenceRecordFromPersistResult(persistResult = null) {
  const accepted = persistResult?.accepted === true;
  const queued = persistResult?.queued === true;
  const blocked = persistResult?.blocked === true;
  const recoverable = persistResult?.recoverable === true;
  let outcome = "failed";

  if (accepted && String(persistResult?.storageTier || "") === "indexeddb") {
    outcome = "saved";
  } else if (accepted) {
    outcome = "fallback";
  } else if (queued) {
    outcome = "queued";
  } else if (recoverable) {
    outcome = "recoverable";
  } else if (blocked) {
    outcome = "blocked";
  }

  return {
    outcome,
    accepted,
    recoverable,
    storageTier: String(persistResult?.storageTier || "none"),
    reason: String(persistResult?.reason || ""),
    revision: Number.isFinite(Number(persistResult?.revision))
      ? Number(persistResult.revision)
      : 0,
    saveMode: String(persistResult?.saveMode || ""),
    saved: persistResult?.saved === true,
    queued,
    blocked,
  };
}

function resolvePendingPersistLastProcessedAssistantFloor() {
  const processedRange = Array.isArray(
    currentGraph?.historyState?.lastBatchStatus?.processedRange,
  )
    ? currentGraph.historyState.lastBatchStatus.processedRange
    : [];
  const rangeEnd = Number(processedRange[1]);
  if (Number.isFinite(rangeEnd) && rangeEnd >= 0) {
    return Math.floor(rangeEnd);
  }

  const rangeStart = Number(processedRange[0]);
  if (Number.isFinite(rangeStart) && rangeStart >= 0) {
    return Math.floor(rangeStart);
  }

  return null;
}

function resolvePendingPersistGraphSource(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(
    chatId || graphPersistenceState.queuedPersistChatId || graphPersistenceState.chatId,
  );
  const targetRevision = Math.max(
    Number(graphPersistenceState.queuedPersistRevision || 0),
    Number(graphPersistenceState.revision || 0),
  );
  const shadowSnapshot = normalizedChatId
    ? readGraphShadowSnapshot(normalizedChatId)
    : null;

  if (
    shadowSnapshot &&
    Number(shadowSnapshot.revision || 0) >= targetRevision &&
    typeof shadowSnapshot.serializedGraph === "string" &&
    shadowSnapshot.serializedGraph
  ) {
    try {
      const shadowGraph = cloneGraphForPersistence(
        normalizeGraphRuntimeState(
          deserializeGraph(shadowSnapshot.serializedGraph),
          normalizedChatId,
        ),
        normalizedChatId,
      );
      return {
        graph: shadowGraph,
        source: "shadow",
        revision: Number(shadowSnapshot.revision || 0),
      };
    } catch (error) {
      console.warn("[ST-BME] pending persist shadow graph 恢复失败:", error);
    }
  }

  return {
    graph: currentGraph,
    source: "runtime",
    revision: Math.max(
      Number(getGraphPersistedRevision(currentGraph) || 0),
      targetRevision,
    ),
  };
}

function applyAcceptedPendingPersistState(
  persistResult,
  {
    lastProcessedAssistantFloor = resolvePendingPersistLastProcessedAssistantFloor(),
    persistedGraph = null,
  } = {},
) {
  ensureCurrentGraphRuntimeState();

  const persistenceRecord = buildBatchPersistenceRecordFromPersistResult(
    persistResult,
  );
  const batchStatus = currentGraph?.historyState?.lastBatchStatus;
  if (batchStatus && typeof batchStatus === "object") {
    batchStatus.persistence = persistenceRecord;
    batchStatus.historyAdvanceAllowed = persistenceRecord.accepted === true;
    batchStatus.historyAdvanced = persistenceRecord.accepted === true;
    currentGraph.historyState.lastBatchStatus = batchStatus;
  }

  if (
    persistedGraph &&
    typeof persistedGraph === "object" &&
    !Array.isArray(persistedGraph)
  ) {
    const persistedHistory =
      persistedGraph.historyState &&
      typeof persistedGraph.historyState === "object" &&
      !Array.isArray(persistedGraph.historyState)
        ? persistedGraph.historyState
        : null;
    if (persistedHistory) {
      currentGraph.historyState.processedMessageHashVersion =
        persistedHistory.processedMessageHashVersion ??
        currentGraph.historyState.processedMessageHashVersion;
      currentGraph.historyState.processedMessageHashes = cloneRuntimeDebugValue(
        persistedHistory.processedMessageHashes || {},
        currentGraph.historyState.processedMessageHashes || {},
      );
      currentGraph.historyState.processedMessageHashesNeedRefresh =
        persistedHistory.processedMessageHashesNeedRefresh === true;
    }
    if (Array.isArray(persistedGraph.batchJournal)) {
      currentGraph.batchJournal = cloneRuntimeDebugValue(
        persistedGraph.batchJournal,
        currentGraph.batchJournal || [],
      );
    }
  }

  if (
    persistenceRecord.accepted === true &&
    Number.isFinite(Number(lastProcessedAssistantFloor)) &&
    Number(lastProcessedAssistantFloor) >= 0
  ) {
    const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];
    const safeFloor = Math.floor(Number(lastProcessedAssistantFloor));
    if (typeof updateProcessedHistorySnapshot === "function") {
      updateProcessedHistorySnapshot(chat, safeFloor);
    } else {
      currentGraph.historyState.lastProcessedAssistantFloor = safeFloor;
      currentGraph.lastProcessedSeq = safeFloor;
    }
  }

  if (persistenceRecord.accepted === true) {
    updateGraphPersistenceState({
      acceptedStorageTier: String(persistenceRecord.storageTier || "none"),
      lastRecoverableStorageTier: "none",
      pendingPersist: false,
    });
    const safeFloor = Number.isFinite(Number(lastProcessedAssistantFloor))
      ? Math.floor(Number(lastProcessedAssistantFloor))
      : null;
    if (typeof setLastExtractionStatus === "function") {
      setLastExtractionStatus(
        "持久化已确认",
        [
          safeFloor != null ? `楼层 ${safeFloor}` : "",
          `rev ${Number(persistenceRecord.revision || 0)}`,
          String(persistenceRecord.storageTier || "none"),
          persistenceRecord.reason || "",
        ]
          .filter(Boolean)
          .join(" · "),
        "success",
        { syncRuntime: true, toastKind: "" },
      );
    }
  }

  refreshPanelLiveState();
}

function schedulePendingGraphPersistRetry(
  reason = "pending-graph-persist-retry",
  attempt = 0,
) {
  if (isRestoreLockActive()) {
    return false;
  }
  if (!graphPersistenceState.pendingPersist) {
    clearPendingGraphPersistRetry();
    return false;
  }

  const targetChatId = normalizeChatIdCandidate(
    graphPersistenceState.queuedPersistChatId ||
      graphPersistenceState.chatId ||
      getCurrentChatId(),
  );
  if (!targetChatId) {
    return false;
  }

  const normalizedAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  if (normalizedAttempt >= PENDING_GRAPH_PERSIST_MAX_RETRY_ATTEMPTS) {
    return false;
  }

  const delayIndex = Math.min(
    normalizedAttempt,
    PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS.length - 1,
  );
  const delayMs = PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS[delayIndex];
  clearPendingGraphPersistRetry({ resetChatId: false });
  pendingGraphPersistRetryChatId = targetChatId;
  pendingGraphPersistRetryAttempt = normalizedAttempt;

  pendingGraphPersistRetryTimer = setTimeout(() => {
    pendingGraphPersistRetryTimer = null;
    void retryPendingGraphPersist({
      reason: `${reason}:attempt-${normalizedAttempt + 1}`,
      retryAttempt: normalizedAttempt,
      scheduleRetryOnFailure: true,
    }).catch((error) => {
      console.warn("[ST-BME] 待确认持久化自动重试失败:", error);
    });
  }, delayMs);

  return true;
}

function persistGraphToChatMetadata(
  context = getContext(),
  {
    reason = "graph-persist",
    revision = graphPersistenceState.revision,
    immediate = false,
    graph = currentGraph,
  } = {},
) {
  if (!context || !graph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      recoverable: false,
      reason: "missing-context-or-graph",
      revision,
    });
  }

  const chatId = getCurrentChatId(context);
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      recoverable: false,
      reason: "missing-chat-id",
      revision,
    });
  }

  const nextIntegrity = getChatMetadataIntegrity(context);
  const persistedGraph = cloneGraphForPersistence(graph, chatId);
  stampGraphPersistenceMeta(persistedGraph, {
    revision,
    reason,
    chatId,
    integrity: nextIntegrity,
  });

  writeChatMetadataPatch(context, {
    [GRAPH_METADATA_KEY]: persistedGraph,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });

  updateGraphPersistenceState({
    lastPersistReason: String(reason || ""),
    lastPersistMode: `metadata-full:${saveMode}`,
    metadataIntegrity: String(nextIntegrity || graphPersistenceState.metadataIntegrity || ""),
    indexedDbLastError: graphPersistenceState.indexedDbLastError || "",
    lastRecoverableStorageTier: "metadata-full",
    dualWriteLastResult: {
      action: "save",
      target: "metadata",
      success: true,
      recoverable: true,
      chatId,
      revision: normalizeIndexedDbRevision(revision),
      reason: String(reason || "graph-persist"),
      at: Date.now(),
    },
  });
  rememberResolvedGraphIdentityAlias(context, chatId);

  return buildGraphPersistResult({
    saved: true,
    accepted: false,
    recoverable: true,
    reason,
    loadState: graphPersistenceState.loadState,
    revision,
    saveMode,
    storageTier: "metadata-full",
  });
}

function queueGraphPersist(
  reason = "graph-persist-blocked",
  revision = graphPersistenceState.revision,
  {
    immediate = true,
    graph = currentGraph,
    chatId = undefined,
    captureShadow = true,
    recoverableTier = "none",
  } = {},
) {
  const queuedChatId =
    String(chatId || graphPersistenceState.chatId || getCurrentChatId()) || "";
  const normalizedRevision = Math.max(
    1,
    allocateRequestedPersistRevision(revision, graph),
  );
  let effectiveRecoverableTier = isRecoveryOnlyPersistTier(recoverableTier)
    ? String(recoverableTier)
    : "none";

  if (captureShadow) {
    const shadowCaptured = maybeCaptureGraphShadowSnapshot(reason, {
      graph,
      chatId: queuedChatId,
      revision: normalizedRevision,
    });
    if (shadowCaptured && effectiveRecoverableTier === "none") {
      effectiveRecoverableTier = "shadow";
    }
  }

  updateGraphPersistenceState({
    queuedPersistRevision: Math.max(
      normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
      normalizedRevision,
    ),
    queuedPersistChatId: String(queuedChatId || ""),
    queuedPersistMode: immediate ? "immediate" : "debounced",
    queuedPersistRotateIntegrity: false,
    queuedPersistReason: String(reason || ""),
    pendingPersist: true,
    writesBlocked: true,
    lastPersistReason: String(reason || ""),
    lastPersistMode: immediate ? "pending-immediate" : "pending-debounced",
    lastRecoverableStorageTier: isRecoveryOnlyPersistTier(effectiveRecoverableTier)
      ? effectiveRecoverableTier
      : graphPersistenceState.lastRecoverableStorageTier,
  });
  schedulePendingGraphPersistRetry(String(reason || "graph-persist-blocked"), 0);

  return buildGraphPersistResult({
    queued: true,
    blocked: true,
    accepted: false,
    recoverable: isRecoveryOnlyPersistTier(effectiveRecoverableTier),
    reason,
    loadState: graphPersistenceState.loadState,
    revision: normalizedRevision,
    saveMode: immediate ? "immediate" : "debounced",
    storageTier: effectiveRecoverableTier !== "none" ? effectiveRecoverableTier : "none",
  });
}

function maybeFlushQueuedGraphPersist(reason = "queued-graph-persist") {
  const context = getContext();
  if (!currentGraph || !canPersistGraphToMetadataFallback(context)) {
    return buildGraphPersistResult({
      queued: graphPersistenceState.pendingPersist,
      blocked: !canPersistGraphToMetadataFallback(context),
      reason: canPersistGraphToMetadataFallback(context)
        ? "missing-current-graph"
        : "write-protected",
    });
  }

  if (
    !graphPersistenceState.pendingPersist &&
    graphPersistenceState.queuedPersistRevision <=
      graphPersistenceState.lastPersistedRevision
  ) {
    return buildGraphPersistResult({
      saved: false,
      reason: "no-queued-persist",
    });
  }

  const activeChatId = getCurrentChatId();
  const queuedChatId = String(graphPersistenceState.queuedPersistChatId || "");
  if (queuedChatId && activeChatId && queuedChatId !== activeChatId) {
    return buildGraphPersistResult({
      saved: false,
      queued: graphPersistenceState.pendingPersist,
      blocked: true,
      reason: "queued-chat-mismatch",
      revision: graphPersistenceState.queuedPersistRevision,
      saveMode: graphPersistenceState.queuedPersistMode,
    });
  }

  const targetRevision = Math.max(
    graphPersistenceState.revision || 0,
    graphPersistenceState.queuedPersistRevision || 0,
  );
  if (targetRevision > (graphPersistenceState.revision || 0)) {
    updateGraphPersistenceState({
      revision: targetRevision,
    });
  }

  return persistGraphToChatMetadata(context, {
    reason,
    revision: targetRevision,
    immediate: graphPersistenceState.queuedPersistMode !== "debounced",
  });
}

async function retryPendingGraphPersist({
  reason = "pending-graph-persist-retry",
  retryAttempt = 0,
  scheduleRetryOnFailure = false,
  ignoreRestoreLock = false,
} = {}) {
  ensureCurrentGraphRuntimeState();

  if (!ignoreRestoreLock && isRestoreLockActive()) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "restore-lock-active",
      revision: graphPersistenceState.revision,
      saveMode: graphPersistenceState.lastPersistMode,
      storageTier: "none",
    });
  }

  if (!graphPersistenceState.pendingPersist) {
    clearPendingGraphPersistRetry();
    return buildGraphPersistResult({
      saved: false,
      blocked: false,
      accepted: false,
      reason: "no-pending-persist",
      revision: graphPersistenceState.revision,
      saveMode: graphPersistenceState.lastPersistMode,
      storageTier: "none",
    });
  }

  const context = getContext();
  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  const queuedChatId = normalizeChatIdCandidate(
    graphPersistenceState.queuedPersistChatId ||
      graphPersistenceState.chatId ||
      activeChatId,
  );
  const currentIdentity = resolveCurrentChatIdentity(context);
  if (!currentGraph || !context || !activeChatId || !queuedChatId) {
    if (scheduleRetryOnFailure) {
      schedulePendingGraphPersistRetry(reason, Number(retryAttempt) + 1);
    }
    return buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "pending-persist-context-unavailable",
      revision: Math.max(
        Number(graphPersistenceState.queuedPersistRevision || 0),
        Number(graphPersistenceState.revision || 0),
      ),
      saveMode: graphPersistenceState.queuedPersistMode,
      storageTier: "none",
    });
  }

  if (
    !areChatIdsEquivalentForResolvedIdentity(
      queuedChatId,
      activeChatId,
      currentIdentity,
    ) &&
    !areChatIdsEquivalentForResolvedIdentity(
      activeChatId,
      queuedChatId,
      currentIdentity,
    )
  ) {
    if (scheduleRetryOnFailure) {
      schedulePendingGraphPersistRetry(reason, Number(retryAttempt) + 1);
    }
    return buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "queued-chat-mismatch",
      revision: Math.max(
        Number(graphPersistenceState.queuedPersistRevision || 0),
        Number(graphPersistenceState.revision || 0),
      ),
      saveMode: graphPersistenceState.queuedPersistMode,
      storageTier: "none",
    });
  }

  const pendingPersistGraphSource = resolvePendingPersistGraphSource(
    queuedChatId,
  );
  const pendingPersistGraph = pendingPersistGraphSource?.graph || currentGraph;
  const targetRevision = Math.max(
    Number(graphPersistenceState.queuedPersistRevision || 0),
    Number(graphPersistenceState.revision || 0),
    Number(graphPersistenceState.lastPersistedRevision || 0),
    Number(pendingPersistGraphSource?.revision || 0),
    Number(getGraphPersistedRevision(pendingPersistGraph) || 0),
  );
  const lastProcessedAssistantFloor =
    resolvePendingPersistLastProcessedAssistantFloor();
  const indexedDbResult = await saveGraphToIndexedDb(activeChatId, pendingPersistGraph, {
    revision: targetRevision,
    reason,
  });
  if (indexedDbResult?.saved) {
    if (canUseHostGraphChatStatePersistence(context)) {
      await persistGraphToHostChatState(context, {
        graph: pendingPersistGraph,
        revision: indexedDbResult.revision || targetRevision,
        reason: `${reason}:chat-state-mirror`,
        storageTier: "chat-state",
        accepted: true,
        lastProcessedAssistantFloor,
        extractionCount,
        mode: "mirror",
      });
    }
    clearPendingGraphPersistRetry();
    persistGraphCommitMarker(context, {
      reason,
      revision: indexedDbResult.revision || targetRevision,
      storageTier: "indexeddb",
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      immediate: true,
    });
    const persistResult = buildGraphPersistResult({
      saved: true,
      accepted: true,
      reason,
      revision: indexedDbResult.revision || targetRevision,
      saveMode: String(indexedDbResult.saveMode || "indexeddb-delta"),
      storageTier: "indexeddb",
    });
    applyAcceptedPendingPersistState(persistResult, {
      lastProcessedAssistantFloor,
      persistedGraph: pendingPersistGraph,
    });
    void maybeResumePendingAutoExtraction("pending-persist-resolved:indexeddb");
    return persistResult;
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    const chatStateResult = await persistGraphToHostChatState(context, {
      graph: pendingPersistGraph,
      revision: targetRevision,
      reason: `${reason}:chat-state-fallback`,
      storageTier: "chat-state",
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      mode: "primary",
    });
    if (chatStateResult?.saved) {
      clearPendingGraphPersistRetry();
      persistGraphCommitMarker(context, {
        reason: `${reason}:chat-state-fallback`,
        revision: chatStateResult.revision || targetRevision,
        storageTier: "chat-state",
        accepted: true,
        lastProcessedAssistantFloor,
        extractionCount,
        immediate: true,
      });
      updateGraphPersistenceState({
        revision: Math.max(
          Number(graphPersistenceState.revision || 0),
          Number(chatStateResult.revision || targetRevision),
        ),
        pendingPersist: false,
        persistMismatchReason: "",
        lastAcceptedRevision: Math.max(
          Number(graphPersistenceState.lastAcceptedRevision || 0),
          Number(chatStateResult.revision || targetRevision),
        ),
        acceptedStorageTier: "chat-state",
        lastRecoverableStorageTier: "none",
        lastPersistReason: `${reason}:chat-state-fallback`,
        lastPersistMode: String(chatStateResult.saveMode || "chat-state"),
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        queuedPersistMode: "",
        queuedPersistRotateIntegrity: false,
        queuedPersistReason: "",
        storagePrimary: "chat-state",
        storageMode: "chat-state",
      });
      const persistResult = buildGraphPersistResult({
        saved: true,
        accepted: true,
        reason: `${reason}:chat-state-fallback`,
        revision: Number(chatStateResult.revision || targetRevision),
        saveMode: String(chatStateResult.saveMode || "chat-state"),
        storageTier: "chat-state",
      });
      applyAcceptedPendingPersistState(persistResult, {
        lastProcessedAssistantFloor,
        persistedGraph: pendingPersistGraph,
      });
      queueGraphPersistToIndexedDb(activeChatId, pendingPersistGraph, {
        revision: Number(chatStateResult.revision || targetRevision),
        reason: `${reason}:chat-state-fallback:promote-indexeddb`,
      });
      void maybeResumePendingAutoExtraction("pending-persist-resolved:chat-state");
      return persistResult;
    }
  }

  let recoverableTier = "none";
  if (canPersistGraphToMetadataFallback(context, pendingPersistGraph)) {
    const metadataReason = `${reason}:metadata-full-fallback`;
    const metadataResult = persistGraphToChatMetadata(context, {
      reason: metadataReason,
      revision: targetRevision,
      immediate: true,
      graph: pendingPersistGraph,
    });
    if (metadataResult?.saved) {
      recoverableTier = "metadata-full";
    }
  }

  if (
    recoverableTier === "none" &&
    maybeCaptureGraphShadowSnapshot(`${reason}:shadow-fallback`, {
      graph: pendingPersistGraph,
      chatId: activeChatId,
      revision: targetRevision,
    })
  ) {
    recoverableTier = "shadow";
  }

  const queuedReason = `${reason}:still-pending`;
  const queuedResult = queueGraphPersist(queuedReason, targetRevision, {
    immediate: graphPersistenceState.queuedPersistMode !== "debounced",
    graph: pendingPersistGraph,
    chatId: activeChatId,
    captureShadow: recoverableTier === "none",
    recoverableTier,
  });
  if (recoverableTier !== "none") {
    updateGraphPersistenceState({
      lastPersistReason: queuedReason,
      lastRecoverableStorageTier: recoverableTier,
    });
  }
  if (scheduleRetryOnFailure && recoverableTier === "none") {
    schedulePendingGraphPersistRetry(reason, Number(retryAttempt) + 1);
  }
  return buildGraphPersistResult({
    saved: false,
    queued: true,
    blocked: true,
    accepted: false,
    recoverable:
      recoverableTier !== "none" || queuedResult?.recoverable === true,
    reason: queuedReason,
    revision: Number(queuedResult?.revision || targetRevision),
    saveMode: String(
      queuedResult?.saveMode || graphPersistenceState.queuedPersistMode || "immediate",
    ),
    storageTier:
      recoverableTier !== "none"
        ? recoverableTier
        : String(queuedResult?.storageTier || "none"),
  });
}

async function persistExtractionBatchResult({
  reason = "extraction-batch-complete",
  lastProcessedAssistantFloor = null,
  graphSnapshot = null,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const persistGraph =
    graphSnapshot && typeof graphSnapshot === "object"
      ? cloneGraphSnapshot(graphSnapshot)
      : currentGraph;
  if (!context || !persistGraph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-context-or-graph",
      storageTier: "none",
    });
  }

  const chatId = getCurrentChatId(context);
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-chat-id",
      storageTier: "none",
    });
  }

  const revision = allocateRequestedPersistRevision(0, persistGraph);
  const indexedDbResult = await saveGraphToIndexedDb(chatId, persistGraph, {
    revision,
    reason,
  });
  if (indexedDbResult?.saved) {
    if (canUseHostGraphChatStatePersistence(context)) {
      await persistGraphToHostChatState(context, {
        graph: persistGraph,
        revision: indexedDbResult.revision || revision,
        reason: `${reason}:chat-state-mirror`,
        storageTier: "chat-state",
        accepted: true,
        lastProcessedAssistantFloor,
        extractionCount,
        mode: "mirror",
      });
    }
    persistGraphCommitMarker(context, {
      reason,
      revision: indexedDbResult.revision || revision,
      storageTier: "indexeddb",
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      immediate: true,
    });
    clearPendingGraphPersistRetry();
    return buildGraphPersistResult({
      saved: true,
      accepted: true,
      reason,
      revision: indexedDbResult.revision || revision,
      saveMode: String(indexedDbResult.saveMode || "indexeddb-delta"),
      storageTier: "indexeddb",
    });
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    const chatStateResult = await persistGraphToHostChatState(context, {
      graph: persistGraph,
      revision,
      reason: `${reason}:chat-state-fallback`,
      storageTier: "chat-state",
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      mode: "primary",
    });
    if (chatStateResult?.saved) {
      persistGraphCommitMarker(context, {
        reason: `${reason}:chat-state-fallback`,
        revision: chatStateResult.revision || revision,
        storageTier: "chat-state",
        accepted: true,
        lastProcessedAssistantFloor,
        extractionCount,
        immediate: true,
      });
      updateGraphPersistenceState({
        revision: Math.max(
          Number(graphPersistenceState.revision || 0),
          Number(chatStateResult.revision || revision),
        ),
        pendingPersist: false,
        persistMismatchReason: "",
        lastAcceptedRevision: Math.max(
          Number(graphPersistenceState.lastAcceptedRevision || 0),
          Number(chatStateResult.revision || revision),
        ),
        acceptedStorageTier: "chat-state",
        lastRecoverableStorageTier: "none",
        lastPersistReason: `${reason}:chat-state-fallback`,
        lastPersistMode: String(chatStateResult.saveMode || "chat-state"),
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        queuedPersistMode: "",
        queuedPersistRotateIntegrity: false,
        queuedPersistReason: "",
        storagePrimary: "chat-state",
        storageMode: "chat-state",
      });
      clearPendingGraphPersistRetry();
      queueGraphPersistToIndexedDb(chatId, persistGraph, {
        revision: Number(chatStateResult.revision || revision),
        reason: `${reason}:chat-state-fallback:promote-indexeddb`,
      });
      return buildGraphPersistResult({
        saved: true,
        accepted: true,
        reason: `${reason}:chat-state-fallback`,
        revision: Number(chatStateResult.revision || revision),
        saveMode: String(chatStateResult.saveMode || "chat-state"),
        storageTier: "chat-state",
      });
    }
  }

  let recoverableTier = "none";
  if (
    maybeCaptureGraphShadowSnapshot(`${reason}:shadow-fallback`, {
      graph: persistGraph,
      chatId,
      revision,
    })
  ) {
    recoverableTier = "shadow";
  }

  if (canPersistGraphToMetadataFallback(context, persistGraph)) {
    const metadataReason = `${reason}:metadata-full-fallback`;
    const metadataResult = persistGraphToChatMetadata(context, {
      reason: metadataReason,
      revision,
      immediate: true,
      graph: persistGraph,
    });
    if (metadataResult?.saved) {
      recoverableTier = "metadata-full";
    }
  }

  const queuedResult = queueGraphPersist(`${reason}:pending`, revision, {
    immediate: true,
    graph: persistGraph,
    chatId,
    captureShadow: recoverableTier === "none",
    recoverableTier,
  });
  updateGraphPersistenceState({
    pendingPersist: true,
    lastPersistReason: String(queuedResult.reason || `${reason}:pending`),
    lastPersistMode: String(queuedResult.saveMode || ""),
    lastRecoverableStorageTier:
      recoverableTier !== "none"
        ? recoverableTier
        : String(queuedResult.storageTier || graphPersistenceState.lastRecoverableStorageTier || "none"),
  });
  return buildGraphPersistResult({
    saved: false,
    queued: Boolean(queuedResult?.queued),
    blocked: Boolean(queuedResult?.blocked),
    accepted: false,
    recoverable:
      recoverableTier !== "none" || queuedResult?.recoverable === true,
    reason: String(queuedResult?.reason || `${reason}:pending`),
    revision: Number(queuedResult?.revision || revision),
    saveMode: String(queuedResult?.saveMode || ""),
    storageTier:
      recoverableTier !== "none"
        ? recoverableTier
        : String(queuedResult?.storageTier || "none"),
  });
}

function scheduleGraphLoadRetry(
  chatId,
  reason = "metadata-pending",
  attemptIndex = 0,
  { allowPendingChat = false, expectedChatId = "" } = {},
) {
  const normalizedChatId = String(chatId || "");
  const normalizedExpectedChatId = String(
    expectedChatId || normalizedChatId || "",
  );
  const delayMs = GRAPH_LOAD_RETRY_DELAYS_MS[attemptIndex];
  if ((!normalizedChatId && !allowPendingChat) || !Number.isFinite(delayMs)) {
    clearPendingGraphLoadRetry();
    return false;
  }

  clearPendingGraphLoadRetry({ resetChatId: false });
  pendingGraphLoadRetryChatId =
    normalizedChatId || (allowPendingChat ? GRAPH_LOAD_PENDING_CHAT_ID : "");
  debugDebug(
    `[ST-BME] 图谱元数据尚未就绪，${delayMs}ms 后重试加载（chat=${normalizedChatId || "pending"}，attempt=${attemptIndex + 1}，reason=${reason}）`,
  );

  pendingGraphLoadRetryTimer = setTimeout(() => {
    pendingGraphLoadRetryTimer = null;
    const currentChatId = getCurrentChatId();
    if (
      normalizedExpectedChatId &&
      currentChatId &&
      currentChatId !== normalizedExpectedChatId
    ) {
      clearPendingGraphLoadRetry();
      return;
    }
    if (
      !allowPendingChat &&
      normalizedChatId &&
      currentChatId !== normalizedChatId
    ) {
      clearPendingGraphLoadRetry();
      return;
    }

    loadGraphFromChat({
      attemptIndex: attemptIndex + 1,
      expectedChatId: normalizedExpectedChatId,
      source: `retry:${reason}`,
    });
  }, delayMs);

  return true;
}

function shouldSyncGraphLoadFromLiveContext(
  context = getContext(),
  { force = false } = {},
) {
  if (force) return true;

  const chatIdentity = resolveCurrentChatIdentity(context);
  const liveChatId = chatIdentity.chatId;
  const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);

  if (
    !areChatIdsEquivalentForResolvedIdentity(
      liveChatId,
      stateChatId,
      chatIdentity,
    )
  ) {
    return true;
  }

  if (
    !liveChatId &&
    graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT
  ) {
    return true;
  }

  if (liveChatId && !graphPersistenceState.dbReady) return true;

  return false;
}

function syncGraphLoadFromLiveContext(options = {}) {
  const { source = "live-context-sync", force = false } = options;
  const context = getContext();
  syncCommitMarkerToPersistenceState(context);
  if (!shouldSyncGraphLoadFromLiveContext(context, { force })) {
    return {
      synced: false,
      reason: "no-sync-needed",
      loadState: graphPersistenceState.loadState,
      chatId: graphPersistenceState.chatId,
    };
  }

  const chatId = resolveCurrentChatIdentity(context).chatId;
  if (!chatId) {
    const result = loadGraphFromChat({
      source,
      attemptIndex: 0,
    });
    return {
      synced: true,
      ...result,
    };
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    scheduleGraphChatStateProbe(chatId, {
      source: `${source}:chat-state-probe`,
      attemptIndex: 0,
      allowOverride: true,
    });
  }

  const cachedSnapshot = readCachedIndexedDbSnapshot(chatId);
  if (isIndexedDbSnapshotMeaningful(cachedSnapshot)) {
    const result = applyIndexedDbSnapshotToRuntime(chatId, cachedSnapshot, {
      source: `${source}:indexeddb-cache`,
      attemptIndex: 0,
    });
    if (result?.reason === "indexeddb-stale-runtime") {
      return {
        synced: false,
        reason: "cached-indexeddb-stale-runtime",
        loadState: graphPersistenceState.loadState,
        chatId: graphPersistenceState.chatId,
        staleDetail: cloneRuntimeDebugValue(result?.staleDetail, null),
      };
    }
    return {
      synced: true,
      ...result,
    };
  }

  applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
    chatId,
    reason: `indexeddb-sync:${String(source || "live-context-sync")}`,
    attemptIndex: 0,
    dbReady: false,
    writesBlocked: true,
  });
  updateGraphPersistenceState({
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    dbReady: false,
    indexedDbLastError: "",
  });
  scheduleIndexedDbGraphProbe(chatId, {
    source: `${source}:indexeddb-probe`,
    allowOverride: true,
    applyEmptyState: true,
  });
  refreshPanelLiveState();

  return {
    synced: true,
    success: false,
    loaded: false,
    loadState: GRAPH_LOAD_STATES.LOADING,
    reason: "indexeddb-loading",
    chatId,
    attemptIndex: 0,
  };
}

function scheduleStartupGraphReconciliation() {
  for (const delayMs of GRAPH_STARTUP_RECONCILE_DELAYS_MS) {
    setTimeout(() => {
      syncGraphLoadFromLiveContext({
        source: `startup-reconcile:${delayMs}`,
      });
    }, delayMs);
  }
}

function clearInjectionState(options = {}) {
  const {
    preserveRecallStatus = false,
    preserveRuntimeStatus = preserveRecallStatus,
  } = options;
  lastInjectionContent = "";
  lastRecalledItems = [];
  if (!preserveRecallStatus) {
    lastRecallStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }
  if (!preserveRuntimeStatus) {
    runtimeStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }
  recordInjectionSnapshot("recall", {
    injectionText: "",
    selectedNodeIds: [],
    retrievalMeta: {},
    llmMeta: {},
    transport: {
      applied: false,
      source: "cleared",
      mode: "cleared",
    },
  });
  if (!isRecalling && !preserveRecallStatus) {
    dismissStageNotice("recall");
  }

  try {
    applyModuleInjectionPrompt("", getSettings());
  } catch (error) {
    console.warn("[ST-BME] 清理旧注入失�?", error);
  }

  refreshPanelLiveState();
}

function refreshPanelLiveState() {
  refreshPanelLiveStateController({
    getPanelModule: () => _panelModule,
  });
}

function notifyStatusToast(key, kind, message, title = "ST-BME") {
  const now = Date.now();
  if (now - (lastStatusToastAt[key] || 0) < STATUS_TOAST_THROTTLE_MS) return;
  lastStatusToastAt[key] = now;

  const method = typeof toastr?.[kind] === "function" ? kind : "info";
  toastr[method](message, title, { timeOut: 2200 });
}

function setRuntimeStatus(text, meta, level = "info") {
  runtimeStatus = createUiStatus(text, meta, level);
  refreshPanelLiveState();
  // 同步悬浮球状�?
  const fabStatus = level === "info" ? "idle" : level;
  _panelModule?.updateFloatingBallStatus?.(fabStatus, text || "BME 记忆图谱");
}

function setLastExtractionStatus(
  text,
  meta,
  level = "info",
  {
    syncRuntime = true,
    toastKind = "",
    toastTitle = "ST-BME 提取",
    noticeMarquee = false,
  } = {},
) {
  lastExtractionStatus = createUiStatus(text, meta, level);
  if (syncRuntime) {
    setRuntimeStatus(text, meta, level);
  } else {
    refreshPanelLiveState();
  }
  updateStageNotice("extraction", text, meta, level, {
    title: toastTitle,
    noticeMarquee,
  });
  if (toastKind) {
    notifyStatusToast(
      `extract:${toastKind}`,
      toastKind,
      meta || text,
      toastTitle,
    );
  }
}

function setLastVectorStatus(
  text,
  meta,
  level = "info",
  { syncRuntime = false, toastKind = "", toastTitle = "ST-BME 向量" } = {},
) {
  lastVectorStatus = createUiStatus(text, meta, level);
  if (syncRuntime) {
    setRuntimeStatus(text, meta, level);
  } else {
    refreshPanelLiveState();
  }
  updateStageNotice("vector", text, meta, level, {
    title: toastTitle,
  });
  if (toastKind) {
    notifyStatusToast(
      `vector:${toastKind}`,
      toastKind,
      meta || text,
      toastTitle,
    );
  }
}

function setLastRecallStatus(
  text,
  meta,
  level = "info",
  {
    syncRuntime = true,
    toastKind = "",
    toastTitle = "ST-BME 召回",
    noticeMarquee = false,
  } = {},
) {
  lastRecallStatus = createUiStatus(text, meta, level);
  if (syncRuntime) {
    setRuntimeStatus(text, meta, level);
  } else {
    refreshPanelLiveState();
  }
  updateStageNotice("recall", text, meta, level, {
    title: toastTitle,
    noticeMarquee,
  });
  if (toastKind) {
    notifyStatusToast(
      `recall:${toastKind}`,
      toastKind,
      meta || text,
      toastTitle,
    );
  }
}

function notifyExtractionIssue(message, title = "ST-BME 提取提示") {
  setLastExtractionStatus("提取失败", message, "warning", {
    syncRuntime: true,
  });
  const now = Date.now();
  if (now - lastExtractionWarningAt < 5000) return;
  lastExtractionWarningAt = now;
  toastr.warning(message, title, { timeOut: 4500 });
}

async function fetchLocalWithTimeout(
  url,
  options = {},
  timeoutMs = getConfiguredTimeoutMs(),
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `本地请求超时 (${Math.round(timeoutMs / 1000)}s)`,
          "AbortError",
        ),
      ),
    timeoutMs,
  );
  let signal = controller.signal;
  if (options.signal) {
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.any === "function"
    ) {
      signal = AbortSignal.any([options.signal, controller.signal]);
    } else {
      signal = controller.signal;
      options.signal.addEventListener(
        "abort",
        () => controller.abort(options.signal.reason),
        {
          once: true,
        },
      );
    }
  }

  try {
    return await fetch(url, {
      ...options,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function snapshotRuntimeUiState() {
  return {
    extractionCount,
    lastInjectionContent,
    lastExtractedItems: Array.isArray(lastExtractedItems)
      ? lastExtractedItems.map((item) => ({ ...item }))
      : [],
    lastRecalledItems: Array.isArray(lastRecalledItems)
      ? lastRecalledItems.map((item) => ({ ...item }))
      : [],
    runtimeStatus: { ...(runtimeStatus || {}) },
    lastExtractionStatus: { ...(lastExtractionStatus || {}) },
    lastVectorStatus: { ...(lastVectorStatus || {}) },
    lastRecallStatus: { ...(lastRecallStatus || {}) },
    graphPersistenceState: getGraphPersistenceLiveState(),
  };
}

function restoreRuntimeUiState(snapshot = {}) {
  extractionCount = Number.isFinite(snapshot.extractionCount)
    ? snapshot.extractionCount
    : 0;
  lastInjectionContent = String(snapshot.lastInjectionContent || "");
  lastExtractedItems = Array.isArray(snapshot.lastExtractedItems)
    ? snapshot.lastExtractedItems.map((item) => ({ ...item }))
    : [];
  lastRecalledItems = Array.isArray(snapshot.lastRecalledItems)
    ? snapshot.lastRecalledItems.map((item) => ({ ...item }))
    : [];
  runtimeStatus = {
    ...createUiStatus("待命", "准备就绪", "idle"),
    ...(snapshot.runtimeStatus || {}),
  };
  lastExtractionStatus = {
    ...createUiStatus("待命", "尚未执行提取", "idle"),
    ...(snapshot.lastExtractionStatus || {}),
  };
  lastVectorStatus = {
    ...createUiStatus("待命", "尚未执行向量任务", "idle"),
    ...(snapshot.lastVectorStatus || {}),
  };
  lastRecallStatus = {
    ...createUiStatus("待命", "尚未执行召回", "idle"),
    ...(snapshot.lastRecallStatus || {}),
  };
  if (snapshot.graphPersistenceState) {
    updateGraphPersistenceState(snapshot.graphPersistenceState);
  }
  refreshPanelLiveState();
}

function getLastProcessedAssistantFloor() {
  const historyFloor = Number(
    currentGraph?.historyState?.lastProcessedAssistantFloor,
  );
  if (Number.isFinite(historyFloor)) {
    return historyFloor;
  }

  const legacySeq = Number(currentGraph?.lastProcessedSeq);
  if (Number.isFinite(legacySeq)) return legacySeq;
  return -1;
}

async function recordGraphMutation({
  beforeSnapshot,
  processedRange = null,
  artifactTags = [],
  syncRange = null,
  signal = undefined,
  extractionCountBefore = extractionCount,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const vectorSync = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(getEmbeddingConfig()) && !syncRange,
    range: syncRange,
    signal,
  });
  const afterSnapshot = cloneGraphSnapshot(currentGraph);
  const effectiveRange = Array.isArray(processedRange)
    ? processedRange
    : [getLastProcessedAssistantFloor(), getLastProcessedAssistantFloor()];

  appendBatchJournal(
    currentGraph,
    createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
      processedRange: effectiveRange,
      postProcessArtifacts: computePostProcessArtifacts(
        beforeSnapshot,
        afterSnapshot,
        artifactTags,
      ),
      vectorHashesInserted: vectorSync?.insertedHashes || [],
      extractionCountBefore,
    }),
  );
  saveGraphToChat({ reason: "record-graph-mutation" });
  return vectorSync;
}

function noteMaintenanceGate(status, action, reason) {
  if (!status || typeof status !== "object") return;
  const normalizedAction = String(action || "").trim() || "unknown";
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) return;

  const nextDetail = {
    action: normalizedAction,
    reason: normalizedReason,
  };
  const previousDetails = Array.isArray(status.maintenanceGateDetails)
    ? status.maintenanceGateDetails
    : [];
  status.maintenanceGateApplied = true;
  status.maintenanceGateDetails = [...previousDetails, nextDetail];
  status.maintenanceGateReason = status.maintenanceGateDetails
    .map((item) => `${item.action}: ${item.reason}`)
    .join(" | ");
}

function evaluateAutoConsolidationGate(
  newNodeCount,
  analysis = null,
  settings = {},
) {
  const minNewNodes = clampInt(
    settings.consolidationAutoMinNewNodes,
    2,
    1,
    50,
  );
  const safeNewNodeCount = Math.max(0, Number(newNodeCount) || 0);
  if (safeNewNodeCount >= minNewNodes) {
    return {
      shouldRun: true,
      minNewNodes,
      reason: `本批新增 ${safeNewNodeCount} 个节点，达到自动整合门槛 ${minNewNodes}`,
      matchedScore: null,
      matchedNodeId: "",
    };
  }

  if (analysis?.triggered) {
    return {
      shouldRun: true,
      minNewNodes,
      reason:
        String(analysis.reason || "").trim() ||
        "检测到高重复风险，已触发自动整合",
      matchedScore: Number.isFinite(Number(analysis?.matchedScore))
        ? Number(analysis.matchedScore)
        : null,
      matchedNodeId: String(analysis?.matchedNodeId || ""),
    };
  }

  return {
    shouldRun: false,
    minNewNodes,
    reason:
      String(analysis?.reason || "").trim() ||
      `本批只新增 ${safeNewNodeCount} 个节点，低于自动整合门槛 ${minNewNodes}`,
    matchedScore: Number.isFinite(Number(analysis?.matchedScore))
      ? Number(analysis.matchedScore)
      : null,
    matchedNodeId: String(analysis?.matchedNodeId || ""),
  };
}

function evaluateAutoCompressionSchedule(
  currentExtractionCount,
  settings = {},
) {
  const enabled = settings.enableAutoCompression !== false;
  const everyN = clampInt(
    settings.compressionEveryN,
    defaultSettings.compressionEveryN,
    1,
    500,
  );
  const safeExtractionCount = Math.max(0, Number(currentExtractionCount) || 0);

  if (!enabled) {
    return {
      scheduled: false,
      everyN,
      nextExtractionCount: null,
      reason: "自动压缩开关已关闭",
    };
  }

  const remainder = safeExtractionCount % everyN;
  if (remainder !== 0) {
    return {
      scheduled: false,
      everyN,
      nextExtractionCount: safeExtractionCount + (everyN - remainder),
      reason: `当前为第 ${safeExtractionCount} 次提取，未到每 ${everyN} 次自动压缩周期`,
    };
  }

  return {
    scheduled: true,
    everyN,
    nextExtractionCount: safeExtractionCount + everyN,
    reason: "",
  };
}

function buildMaintenanceSummary(action, result, mode = "manual") {
  const prefix = mode === "auto" ? "自动" : "手动";
  switch (String(action || "")) {
    case "compress":
      return `${prefix}压缩：新增 ${result?.created || 0}，归档 ${result?.archived || 0}`;
    case "consolidate":
      return `${prefix}整合：合并 ${result?.merged || 0}，跳过 ${result?.skipped || 0}，保留 ${result?.kept || 0}，进化 ${result?.evolved || 0}，新链接 ${result?.connections || 0}，回溯更新 ${result?.updates || 0}`;
    case "sleep":
      return `${prefix}遗忘：归档 ${result?.forgotten || 0} 个节点`;
    default:
      return `${prefix}维护已执行`;
  }
}

function recordMaintenanceAction({
  action,
  beforeSnapshot,
  mode = "manual",
  summary = "",
} = {}) {
  if (!currentGraph || !beforeSnapshot) return null;
  ensureCurrentGraphRuntimeState();

  const entry = createMaintenanceJournalEntry(
    beforeSnapshot,
    cloneGraphSnapshot(currentGraph),
    {
      action,
      mode,
      summary,
    },
  );
  if (!entry) return null;

  appendMaintenanceJournal(currentGraph, entry);
  recordMaintenanceDebugSnapshot({
    lastAction: {
      id: entry.id,
      action: entry.action,
      mode: entry.mode,
      summary: entry.summary,
      createdAt: entry.createdAt,
      maintenanceJournalSize: currentGraph.maintenanceJournal?.length || 0,
    },
  });
  return entry;
}

function undoLastMaintenanceAction() {
  if (!currentGraph) {
    return { ok: false, reason: "当前没有加载的图谱", entry: null };
  }

  ensureCurrentGraphRuntimeState();
  const result = undoLatestMaintenance(currentGraph);
  recordMaintenanceDebugSnapshot({
    lastUndoResult: {
      ok: Boolean(result?.ok),
      reason: String(result?.reason || ""),
      action: result?.entry?.action || "",
      summary: result?.entry?.summary || "",
      createdAt: result?.entry?.createdAt || 0,
      maintenanceJournalSize: currentGraph.maintenanceJournal?.length || 0,
      updatedAt: new Date().toISOString(),
    },
  });
  return result;
}

function markVectorStateDirty(reason = "向量状态已标记为待重建") {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();
  currentGraph.vectorIndexState.dirty = true;
  currentGraph.vectorIndexState.lastWarning = reason;
}

function updateProcessedHistorySnapshot(chat, lastProcessedAssistantFloor) {
  ensureCurrentGraphRuntimeState();
  applyProcessedHistorySnapshotToGraph(
    currentGraph,
    chat,
    lastProcessedAssistantFloor,
  );
}

function shouldAdvanceProcessedHistory(batchStatus) {
  if (!batchStatus || typeof batchStatus !== "object") return false;
  if (batchStatus.historyAdvanceAllowed === true) {
    return true;
  }
  if (batchStatus.historyAdvanceAllowed === false) {
    return false;
  }
  return (
    batchStatus?.stages?.core?.outcome === "success" &&
    batchStatus?.stages?.finalize?.outcome === "success" &&
    batchStatus?.completed === true
  );
}

function computePostProcessArtifacts(
  beforeSnapshot,
  afterSnapshot,
  extraTags = [],
) {
  const beforeNodeIds = new Set(
    (beforeSnapshot?.nodes || []).map((node) => node.id),
  );
  const afterNodes = afterSnapshot?.nodes || [];
  const tags = new Set(extraTags.filter(Boolean));

  for (const node of afterNodes) {
    if (!beforeNodeIds.has(node.id)) {
      if (node.type === "synopsis") tags.add("synopsis");
      if (node.type === "reflection") tags.add("reflection");
      if (node.level > 0) tags.add("compression");
    }
  }

  const beforeNodes = new Map(
    (beforeSnapshot?.nodes || []).map((node) => [node.id, node]),
  );
  for (const node of afterNodes) {
    const beforeNode = beforeNodes.get(node.id);
    if (!beforeNode) continue;
    if (!beforeNode.archived && node.archived) {
      tags.add(node.level > 0 ? "compression-archive" : "sleep/archive");
    }
  }

  return [...tags];
}

async function syncVectorState({
  force = false,
  purge = false,
  range = null,
  signal = undefined,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const scopeLabel =
    range && Number.isFinite(range.start) && Number.isFinite(range.end)
      ? `范围 ${Math.min(range.start, range.end)}-${Math.max(range.start, range.end)}`
      : "当前聊天";
  setLastVectorStatus(
    "向量处理中",
    `${scopeLabel} · ${force ? "强制同步" : "增量同步"}`,
    "running",
    { syncRuntime: true },
  );
  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);

  if (!validation.valid) {
    currentGraph.vectorIndexState.lastWarning = validation.error;
    currentGraph.vectorIndexState.dirty = true;
    setLastVectorStatus("向量不可用", validation.error, "warning", {
      syncRuntime: true,
    });
    return {
      insertedHashes: [],
      stats: getVectorIndexStats(currentGraph),
      error: validation.error,
    };
  }

  try {
    const result = await syncGraphVectorIndex(currentGraph, config, {
      chatId: getCurrentChatId(),
      force,
      purge,
      range,
      signal,
    });
    setLastVectorStatus(
      "向量完成",
      `${scopeLabel} · indexed ${result.stats?.indexed ?? 0} · pending ${result.stats?.pending ?? 0}`,
      "success",
      { syncRuntime: true },
    );
    return result;
  } catch (error) {
    if (isAbortError(error)) {
      setLastVectorStatus("向量已终止", scopeLabel, "warning", {
        syncRuntime: true,
      });
      return {
        insertedHashes: [],
        stats: getVectorIndexStats(currentGraph),
        error: error?.message || "向量任务已终止",
        aborted: true,
      };
    }
    const message = error?.message || String(error) || "向量同步失败";
    markVectorStateDirty(message);
    console.error("[ST-BME] 向量同步失败:", error);
    setLastVectorStatus("向量失败", message, "error", {
      syncRuntime: true,
      toastKind: "error",
    });
    return {
      insertedHashes: [],
      stats: getVectorIndexStats(currentGraph),
      error: message,
    };
  }
}

async function ensureVectorReadyIfNeeded(
  reason = "vector-ready-check",
  signal = undefined,
) {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();
  if (!isGraphMetadataWriteAllowed()) return;

  if (!currentGraph.vectorIndexState?.dirty) return;

  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);
  if (!validation.valid) return;

  const result = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(config),
    signal,
  });

  if (result?.error) {
    currentGraph.vectorIndexState.lastWarning = result.error;
    saveGraphToChat({ reason: "vector-auto-repair-failed" });
    console.warn("[ST-BME] 向量状态自动修复失败:", reason, result.error);
    return result;
  }

  currentGraph.vectorIndexState.lastWarning = "";
  saveGraphToChat({ reason: "vector-auto-repair-succeeded" });
  debugLog("[ST-BME] 向量状态已自动修复:", reason, result.stats);
  return result;
}

async function resetVectorStateForConfigChange(reason = "向量配置已变更") {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();
  markVectorStateDirty(reason);
  currentGraph.vectorIndexState.hashToNodeId = {};
  currentGraph.vectorIndexState.nodeToHash = {};
  currentGraph.vectorIndexState.lastStats = {
    total: 0,
    indexed: 0,
    stale: 0,
    pending: 0,
  };
  saveGraphToChat({ reason: "vector-config-reset" });
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function loadServerSettings() {
  try {
    const response = await fetch(`${SERVER_SETTINGS_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(response.statusText || `HTTP ${response.status}`);
    }

    const loaded = await response.json();
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      extension_settings[MODULE_NAME] = mergePersistedSettings(loaded);
      globalThis.__stBmeDebugLoggingEnabled = Boolean(
        extension_settings[MODULE_NAME]?.debugLoggingEnabled,
      );
      saveSettingsDebounced();
    }
  } catch (error) {
    console.warn("[ST-BME] 读取服务端设置失败，回退到本地运行时设置:", error);
  }
}

async function saveServerSettings(settings = getSettings()) {
  const payload = JSON.stringify(
    getPersistedSettingsSnapshot(settings),
    null,
    2,
  );

  const response = await fetch("/api/files/upload", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      name: SERVER_SETTINGS_FILENAME,
      data: encodeBase64Utf8(payload),
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

function scheduleServerSettingsSave() {
  clearTimeout(serverSettingsSaveTimer);
  serverSettingsSaveTimer = setTimeout(async () => {
    try {
      await saveServerSettings();
    } catch (error) {
      console.error("[ST-BME] 保存服务端设置失败:", error);
    }
  }, 300);
}

function updateModuleSettings(patch = {}) {
  const vectorConfigKeys = new Set([
    "embeddingApiUrl",
    "embeddingApiKey",
    "embeddingModel",
    "embeddingTransportMode",
    "embeddingBackendSource",
    "embeddingBackendModel",
    "embeddingBackendApiUrl",
    "embeddingAutoSuffix",
  ]);
  const messageHideKeys = new Set([
    "hideOldMessagesEnabled",
    "hideOldMessagesKeepLastN",
  ]);
  const recallUiKeys = new Set(["recallCardUserInputDisplayMode"]);
  const noticeUiKeys = new Set(["noticeDisplayMode"]);
  const settings = getSettings();
  const previousCloudStorageMode = String(
    settings.cloudStorageMode || "automatic",
  );
  Object.assign(settings, patch);
  extension_settings[MODULE_NAME] = settings;
  globalThis.__stBmeDebugLoggingEnabled = Boolean(
    settings.debugLoggingEnabled,
  );
  saveSettingsDebounced();

  if (
    Object.prototype.hasOwnProperty.call(patch, "enabled") &&
    patch.enabled === false
  ) {
    abortAllRunningStages();
    dismissAllStageNotices();
    try {
      applyModuleInjectionPrompt("", settings);
      lastInjectionContent = "";
      lastRecalledItems = [];
      runtimeStatus = createUiStatus(
        "已停用",
        "插件已关闭，注入内容已清空",
        "idle",
      );
      lastExtractionStatus = createUiStatus(
        "已停用",
        "插件已关闭，自动提取已停止",
        "idle",
      );
      lastVectorStatus = createUiStatus(
        "已停用",
        "插件已关闭，向量任务已停止",
        "idle",
      );
      lastRecallStatus = createUiStatus(
        "已停用",
        "插件已关闭，注入内容已清空",
        "idle",
      );
      refreshPanelLiveState();
    } catch (error) {
      console.warn("[ST-BME] 关闭插件时清理注入失败:", error);
    }
  }

  if (Object.keys(patch).some((key) => vectorConfigKeys.has(key))) {
    void resetVectorStateForConfigChange(
      "Embedding 配置已变更，向量索引待重建",
    );
  }

  if (Object.keys(patch).some((key) => messageHideKeys.has(key))) {
    const hideSettings = getMessageHideSettings(settings);
    if (!hideSettings.enabled || hideSettings.hide_last_n <= 0) {
      void clearAllHiddenMessages("settings-updated-disable");
    } else {
      scheduleMessageHideApply("settings-updated", 30);
    }
  }

  if (Object.keys(patch).some((key) => recallUiKeys.has(key))) {
    schedulePersistedRecallMessageUiRefresh(30);
  }

  if (Object.keys(patch).some((key) => noticeUiKeys.has(key))) {
    refreshVisibleStageNotices();
  }

  const currentCloudStorageMode = String(
    settings.cloudStorageMode || "automatic",
  );
  if (
    previousCloudStorageMode !== "automatic"
    && currentCloudStorageMode === "automatic"
  ) {
    const chatId = getCurrentChatId();
    if (chatId) {
      scheduleBmeIndexedDbTask(async () => {
        try {
          await syncNow(
            chatId,
            buildBmeSyncRuntimeOptions({
              reason: "mode-switch-bootstrap",
              trigger: "settings:cloud-storage-mode-bootstrap",
            }),
          );
          await syncIndexedDbMetaToPersistenceState(chatId, {
            syncState: "idle",
            lastSyncError: "",
          });
        } catch (error) {
          await syncIndexedDbMetaToPersistenceState(chatId, {
            syncState: "error",
            lastSyncError: error?.message || String(error),
          });
        }
      });
    }
  }

  scheduleServerSettingsSave();
  return settings;
}

// ==================== 图状态持久化 ====================

function loadGraphFromChat(options = {}) {
  const {
    attemptIndex = 0,
    expectedChatId = "",
    source = "direct-load",
    allowMetadataFallback = true,
  } = options;
  const context = getContext();
  const chatIdentity = resolveCurrentChatIdentity(context);
  const chatId = chatIdentity.chatId;
  const commitMarker = syncCommitMarkerToPersistenceState(context);
  const shadowSnapshot = resolveCompatibleGraphShadowSnapshot(chatIdentity);
  const normalizedExpectedChatId = String(expectedChatId || "");
  if (attemptIndex === 0) {
    clearPendingGraphLoadRetry();
  }

  if (
    normalizedExpectedChatId &&
    chatId &&
    normalizedExpectedChatId !== chatId
  ) {
    clearPendingGraphLoadRetry();
    return {
      success: false,
      loaded: false,
      loadState: graphPersistenceState.loadState,
      reason: "expected-chat-mismatch",
      chatId,
      attemptIndex,
    };
  }

  if (!chatId) {
    if (chatIdentity.hasLikelySelectedChat) {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), "");
      extractionCount = 0;
      lastExtractedItems = [];
      lastRecalledItems = [];
      lastInjectionContent = "";
      runtimeStatus = createUiStatus(
        "图谱加载中",
        "正在等待当前聊天会话 ID 就绪",
        "running",
      );
      lastExtractionStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      lastVectorStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      lastRecallStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
        chatId: "",
        reason: "chat-id-missing",
        attemptIndex,
        revision: 0,
        lastPersistedRevision: 0,
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        pendingPersist: false,
        shadowSnapshotUsed: false,
        shadowSnapshotRevision: 0,
        shadowSnapshotUpdatedAt: "",
        shadowSnapshotReason: "",
        dbReady: false,
        writesBlocked: true,
      });
      refreshPanelLiveState();
      return {
        success: false,
        loaded: false,
        loadState: GRAPH_LOAD_STATES.LOADING,
        reason: "chat-id-missing",
        chatId: "",
        attemptIndex,
      };
    }

    clearPendingGraphLoadRetry();
    currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), "");
    extractionCount = 0;
    lastExtractedItems = [];
    lastRecalledItems = [];
    lastInjectionContent = "";
    runtimeStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    lastExtractionStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    lastVectorStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    lastRecallStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    applyGraphLoadState(GRAPH_LOAD_STATES.NO_CHAT, {
      chatId: "",
      reason: "no-chat",
      attemptIndex,
      revision: 0,
      lastPersistedRevision: 0,
      queuedPersistRevision: 0,
      queuedPersistChatId: "",
      pendingPersist: false,
      shadowSnapshotUsed: false,
      shadowSnapshotRevision: 0,
      shadowSnapshotUpdatedAt: "",
      shadowSnapshotReason: "",
      writesBlocked: true,
    });

    refreshPanelLiveState();
    return {
      success: false,
      loaded: false,
      loadState: GRAPH_LOAD_STATES.NO_CHAT,
      reason: "no-chat",
      chatId: "",
      attemptIndex,
    };
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    scheduleGraphChatStateProbe(chatId, {
      source: `${source}:chat-state-probe`,
      attemptIndex,
      allowOverride: true,
    });
  }

  const cachedSnapshot = readCachedIndexedDbSnapshot(chatId);
  if (isIndexedDbSnapshotMeaningful(cachedSnapshot)) {
    const cachedResult = applyIndexedDbSnapshotToRuntime(
      chatId,
      cachedSnapshot,
      {
        source: `${source}:indexeddb-cache`,
        attemptIndex,
      },
    );
    if (cachedResult?.reason === "indexeddb-stale-runtime") {
      clearPendingGraphLoadRetry();
      refreshPanelLiveState();
      return {
        success: false,
        loaded: false,
        loadState: graphPersistenceState.loadState,
        reason: "indexeddb-cache-stale-runtime",
        chatId,
        attemptIndex,
        staleDetail: cloneRuntimeDebugValue(cachedResult?.staleDetail, null),
      };
    }
    if (cachedResult?.loaded) {
      clearPendingGraphLoadRetry();
      return cachedResult;
    }
  }

  const savedData = allowMetadataFallback
    ? context?.chatMetadata?.[GRAPH_METADATA_KEY]
    : undefined;
  if (savedData != null && savedData !== "") {
    try {
      const officialGraph = cloneGraphForPersistence(
        normalizeGraphRuntimeState(deserializeGraph(savedData), chatId),
        chatId,
      );
      const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
        officialGraph,
        shadowSnapshot,
      );
      const officialRevision = Math.max(
        1,
        getGraphPersistedRevision(officialGraph),
      );
      const metadataCommitMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
        buildSnapshotFromGraph(officialGraph, {
          chatId,
          revision: officialRevision,
        }),
        commitMarker,
      );
      const officialRuntimeStaleDecision =
        detectStaleIndexedDbSnapshotAgainstRuntime(
          chatId,
          buildSnapshotFromGraph(officialGraph, {
            chatId,
            revision: officialRevision,
          }),
          {
            identity: chatIdentity,
          },
        );

      if (officialRuntimeStaleDecision.stale) {
        clearPendingGraphLoadRetry();
        updateGraphPersistenceState({
          metadataIntegrity: getChatMetadataIntegrity(context),
          dualWriteLastResult: {
            action: "load",
            source: `${source}:metadata-compat`,
            success: false,
            provisional: true,
            rejected: true,
            reason: "metadata-compat-stale-runtime",
            revision: officialRevision,
            staleDetail: cloneRuntimeDebugValue(
              officialRuntimeStaleDecision,
              null,
            ),
            at: Date.now(),
          },
        });
        refreshPanelLiveState();
        return {
          success: false,
          loaded: false,
          loadState: graphPersistenceState.loadState,
          reason: "metadata-compat-stale-runtime",
          chatId,
          attemptIndex,
          staleDetail: cloneRuntimeDebugValue(
            officialRuntimeStaleDecision,
            null,
          ),
        };
      }

      let metadataMismatchDiagnostic = null;
      if (metadataCommitMismatch.mismatched) {
        clearPendingGraphLoadRetry();
        metadataMismatchDiagnostic = recordPersistMismatchDiagnostic(
          metadataCommitMismatch,
          {
            source: `${source}:metadata-compat`,
          },
        );
        if (
          shadowSnapshot &&
          Number(shadowSnapshot.revision || 0) >=
            Number(metadataCommitMismatch.markerRevision || 0)
        ) {
          const shadowResult = applyShadowSnapshotToRuntime(chatId, shadowSnapshot, {
            source: `${source}:metadata-shadow`,
            attemptIndex,
          });
          if (shadowResult?.loaded && metadataMismatchDiagnostic?.reason) {
            updateGraphPersistenceState({
              persistMismatchReason: metadataMismatchDiagnostic.reason,
            });
          }
          return shadowResult;
        }
      }

      if (shadowSnapshot && shadowDecision?.reason) {
        updateGraphPersistenceState({
          dualWriteLastResult: {
            action: "shadow-compare",
            source: `${source}:metadata-shadow-compare`,
            success: Boolean(shadowDecision.prefer),
            reason: shadowDecision.reason,
            resultCode: String(shadowDecision.resultCode || ""),
            shadowRevision: Number(shadowSnapshot.revision || 0),
            officialRevision,
            at: Date.now(),
          },
        });
      }

      if (shadowSnapshot && shadowDecision?.prefer) {
        clearPendingGraphLoadRetry();
        return applyShadowSnapshotToRuntime(chatId, shadowSnapshot, {
          source: `${source}:metadata-shadow`,
          attemptIndex,
        });
      }

      clearPendingGraphLoadRetry();
      currentGraph = officialGraph;
      stampGraphPersistenceMeta(currentGraph, {
        revision: officialRevision,
        reason: `${source}:metadata-compat-provisional`,
        chatId,
        integrity: getChatMetadataIntegrity(context),
      });
      extractionCount = Number.isFinite(
        currentGraph?.historyState?.extractionCount,
      )
        ? currentGraph.historyState.extractionCount
        : 0;
      lastExtractedItems = [];
      const restoredRecallUi = restoreRecallUiStateFromPersistence(
        context?.chat,
      );
      runtimeStatus = createUiStatus(
        "图谱加载中",
        "已从兼容 metadata 暂载图谱，等待 IndexedDB 权威确认",
        "running",
      );
      lastExtractionStatus = createUiStatus(
        "待命",
        "兼容图谱暂载中，等待 IndexedDB 确认后再执行提取",
        "idle",
      );
      lastVectorStatus = createUiStatus(
        "待命",
        currentGraph.vectorIndexState?.lastWarning ||
          "兼容图谱暂载中，等待 IndexedDB 确认后再执行向量任务",
        "idle",
      );
      lastRecallStatus = createUiStatus(
        "待命",
        restoredRecallUi.restored
          ? "已从持久化召回记录恢复显示，等待 IndexedDB 权威确认"
          : "兼容图谱暂载中，等待 IndexedDB 确认后再执行召回",
        "idle",
      );
      applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
        chatId,
        reason: `${source}:metadata-compat-provisional`,
        attemptIndex,
        revision: officialRevision,
        lastPersistedRevision: officialRevision,
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        pendingPersist: false,
        shadowSnapshotUsed: false,
        shadowSnapshotRevision: Number(shadowSnapshot?.revision || 0),
        shadowSnapshotUpdatedAt: String(shadowSnapshot?.updatedAt || ""),
        shadowSnapshotReason: String(
          shadowDecision?.reason || shadowSnapshot?.reason || "",
        ),
        dbReady: false,
        writesBlocked: true,
      });
      updateGraphPersistenceState({
        metadataIntegrity: getChatMetadataIntegrity(context),
        storagePrimary: "indexeddb",
        storageMode: "indexeddb",
        dbReady: false,
        indexedDbLastError: "",
        persistMismatchReason:
          metadataMismatchDiagnostic?.reason ||
          graphPersistenceState.persistMismatchReason ||
          "",
        dualWriteLastResult: {
          action: "load",
          source: `${source}:metadata-compat`,
          success: true,
          provisional: true,
          revision: officialRevision,
          resultCode: "graph.load.metadata-compat.provisional",
          reason: `${source}:metadata-compat-provisional`,
          at: Date.now(),
        },
      });
      rememberResolvedGraphIdentityAlias(context, chatId);

      scheduleIndexedDbGraphProbe(chatId, {
        source: `${source}:indexeddb-probe`,
        attemptIndex,
        allowOverride: true,
        applyEmptyState: true,
      });

      refreshPanelLiveState();
      schedulePersistedRecallMessageUiRefresh(30);
      return {
        success: true,
        loaded: true,
        loadState: GRAPH_LOAD_STATES.LOADING,
        reason: `${source}:metadata-compat-provisional`,
        chatId,
        attemptIndex,
      };
    } catch (error) {
      console.warn(
        "[ST-BME] 兼容 metadata 图谱读取失败，将回退 IndexedDB:",
        error,
      );
    }
  }

  if (shadowSnapshot) {
    const acceptedCommitRevision = getAcceptedCommitMarkerRevision(commitMarker);
    let shadowOnlyMismatch = null;
    if (
      acceptedCommitRevision > 0 &&
      Number(shadowSnapshot.revision || 0) < acceptedCommitRevision
    ) {
      clearPendingGraphLoadRetry();
      shadowOnlyMismatch = recordPersistMismatchDiagnostic(
        {
          mismatched: true,
          reason: "persist-mismatch:indexeddb-behind-commit-marker",
          markerRevision: acceptedCommitRevision,
          snapshotRevision: Number(shadowSnapshot.revision || 0),
          marker: commitMarker,
        },
        {
          source: `${source}:shadow-no-official`,
          resolvedBy: "shadow",
        },
      );
    }
    clearPendingGraphLoadRetry();
    const shadowResult = applyShadowSnapshotToRuntime(chatId, shadowSnapshot, {
      source: `${source}:shadow-no-official`,
      attemptIndex,
    });
    if (shadowOnlyMismatch?.reason && shadowResult?.loaded) {
      updateGraphPersistenceState({
        persistMismatchReason: shadowOnlyMismatch.reason,
      });
    }
    return shadowResult;
  }

  applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
    chatId,
    reason: `indexeddb-probe-pending:${String(source || "direct-load")}`,
    attemptIndex,
    dbReady: false,
    writesBlocked: true,
  });
  updateGraphPersistenceState({
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    dbReady: false,
    indexedDbLastError: "",
  });
  scheduleIndexedDbGraphProbe(chatId, {
    source: `${source}:indexeddb-probe`,
    attemptIndex,
    allowOverride: true,
    applyEmptyState: true,
  });
  refreshPanelLiveState();

  return {
    success: false,
    loaded: false,
    loadState: GRAPH_LOAD_STATES.LOADING,
    reason: "indexeddb-probe-pending",
    chatId,
    attemptIndex,
  };
}

async function saveGraphToIndexedDb(
  chatId,
  graph,
  { revision = 0, reason = "graph-save" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !graph) {
    return {
      saved: false,
      chatId: normalizedChatId,
      reason: "indexeddb-missing-chat-or-graph",
      revision: normalizeIndexedDbRevision(revision),
    };
  }

  try {
    const manager = ensureBmeChatManager();
    if (!manager) {
      return {
        saved: false,
        chatId: normalizedChatId,
        reason: "indexeddb-manager-unavailable",
        revision: normalizeIndexedDbRevision(revision),
      };
    }
    const db = await manager.getCurrentDb(normalizedChatId);
    const currentIdentity = resolveCurrentChatIdentity(getContext());
    const baseSnapshot =
      readCachedIndexedDbSnapshot(normalizedChatId) ||
      (await db.exportSnapshot());
    const requestedRevision = resolvePersistRevisionFloor(revision, graph);
    const snapshot = buildSnapshotFromGraph(graph, {
      chatId: normalizedChatId,
      revision: requestedRevision,
      baseSnapshot,
      lastModified: Date.now(),
      meta: {
        storagePrimary: "indexeddb",
        lastMutationReason: String(reason || "graph-save"),
        integrity:
          currentIdentity.integrity || graphPersistenceState.metadataIntegrity,
        hostChatId: currentIdentity.hostChatId || "",
      },
    });
    const delta = buildPersistDelta(baseSnapshot, snapshot);
    const commitResult = await db.commitDelta(delta, {
      reason,
      requestedRevision,
      markSyncDirty: true,
    });

    let scheduleUploadWarning = "";
    snapshot.meta.revision = normalizeIndexedDbRevision(
      commitResult?.revision,
      requestedRevision,
    );
    snapshot.meta.lastModified = Number(commitResult?.lastModified || Date.now());
    snapshot.meta.lastMutationReason = String(reason || "graph-save");
    snapshot.meta.storagePrimary = "indexeddb";
    cacheIndexedDbSnapshot(normalizedChatId, snapshot);

    if (graph === currentGraph) {
      stampGraphPersistenceMeta(currentGraph, {
        revision: snapshot.meta.revision,
        reason: String(reason || "graph-save"),
        chatId: normalizedChatId,
        integrity:
          currentIdentity.integrity ||
          getChatMetadataIntegrity(getContext()) ||
          graphPersistenceState.metadataIntegrity,
      });
    }

    try {
      scheduleUpload(
        normalizedChatId,
        buildBmeSyncRuntimeOptions({
          trigger: `graph-mutation:${String(reason || "graph-save")}`,
        }),
      );
    } catch (error) {
      scheduleUploadWarning =
        error?.message || String(error) || "schedule-upload-failed";
      console.warn("[ST-BME] IndexedDB 已写入，但同步上传调度失败:", error);
    }

    updateGraphPersistenceState({
      revision: snapshot.meta.revision,
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      dbReady: true,
      lastPersistedRevision: snapshot.meta.revision,
      pendingPersist: false,
      queuedPersistRevision: 0,
      queuedPersistChatId: "",
      queuedPersistMode: "",
      queuedPersistRotateIntegrity: false,
      queuedPersistReason: "",
      indexedDbRevision: snapshot.meta.revision,
      metadataIntegrity:
        getChatMetadataIntegrity(getContext()) ||
          currentIdentity.integrity ||
          graphPersistenceState.metadataIntegrity,
      indexedDbLastError: "",
      lastSyncError: scheduleUploadWarning,
      syncDirty: true,
      syncDirtyReason: String(reason || "graph-save"),
      lastPersistReason: String(reason || "graph-save"),
      lastPersistMode: "indexeddb-delta",
      lastAcceptedRevision: Math.max(
        Number(graphPersistenceState.lastAcceptedRevision || 0),
        snapshot.meta.revision,
      ),
      acceptedStorageTier: "indexeddb",
      lastRecoverableStorageTier: "none",
      dualWriteLastResult: {
        action: "save",
        target: "indexeddb",
        success: true,
        chatId: normalizedChatId,
        revision: snapshot.meta.revision,
        reason: String(reason || "graph-save"),
        warning: scheduleUploadWarning || "",
        delta: cloneRuntimeDebugValue(commitResult?.delta, null),
        at: Date.now(),
      },
    });
    clearPendingGraphPersistRetry();
    if (
      graphPersistenceState.loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED &&
      areChatIdsEquivalentForResolvedIdentity(
        normalizedChatId,
        graphPersistenceState.chatId || getCurrentChatId(),
      )
    ) {
      applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, {
        chatId: normalizedChatId,
        reason: `shadow-promoted:${String(reason || "graph-save")}`,
        revision: snapshot.meta.revision,
        lastPersistedRevision: snapshot.meta.revision,
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        pendingPersist: false,
        shadowSnapshotUsed: true,
        shadowSnapshotRevision: Math.max(
          Number(graphPersistenceState.shadowSnapshotRevision || 0),
          snapshot.meta.revision,
        ),
        shadowSnapshotUpdatedAt: String(
          graphPersistenceState.shadowSnapshotUpdatedAt || "",
        ),
        shadowSnapshotReason: String(
          graphPersistenceState.shadowSnapshotReason ||
            "shadow-restore-promoted",
        ),
        dbReady: true,
        writesBlocked: false,
      });
    }
    rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

    return {
      saved: true,
      chatId: normalizedChatId,
      revision: snapshot.meta.revision,
      reason: String(reason || "graph-save"),
      saveMode: "indexeddb-delta",
      warning: scheduleUploadWarning || "",
      delta: cloneRuntimeDebugValue(commitResult?.delta, null),
      snapshot,
    };
  } catch (error) {
    console.warn("[ST-BME] IndexedDB 写入失败，保鐣?metadata 兜底:", error);
    updateGraphPersistenceState({
      indexedDbLastError: error?.message || String(error),
      dualWriteLastResult: {
        action: "save",
        target: "indexeddb",
        success: false,
        chatId: normalizedChatId,
        revision: normalizeIndexedDbRevision(revision),
        reason: String(reason || "graph-save"),
        error: error?.message || String(error),
        at: Date.now(),
      },
    });
    return {
      saved: false,
      chatId: normalizedChatId,
      revision: normalizeIndexedDbRevision(revision),
      reason: "indexeddb-write-failed",
      error,
    };
  }
}

function queueGraphPersistToIndexedDb(
  chatId,
  graph,
  { revision = 0, reason = "graph-save" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !graph) return;
  const graphSnapshot = cloneGraphForPersistence(graph, normalizedChatId);

  const normalizedRevision = normalizeIndexedDbRevision(revision);
  const latestQueuedRevision = normalizeIndexedDbRevision(
    bmeIndexedDbLatestQueuedRevisionByChatId.get(normalizedChatId),
  );
  bmeIndexedDbLatestQueuedRevisionByChatId.set(
    normalizedChatId,
    Math.max(latestQueuedRevision, normalizedRevision),
  );

  const previousWritePromise =
    bmeIndexedDbWriteInFlightByChatId.get(normalizedChatId) ||
    Promise.resolve();
  const nextWritePromise = previousWritePromise
    .catch(() => null)
    .then(async () => {
      const currentLatestRevision = normalizeIndexedDbRevision(
        bmeIndexedDbLatestQueuedRevisionByChatId.get(normalizedChatId),
      );
      if (
        normalizedRevision > 0 &&
        normalizedRevision < currentLatestRevision
      ) {
        return {
          saved: false,
          skipped: true,
          reason: "indexeddb-write-superseded",
          revision: normalizedRevision,
        };
      }
      return await saveGraphToIndexedDb(normalizedChatId, graphSnapshot, {
        revision: normalizedRevision,
        reason,
      });
    })
    .finally(() => {
      if (
        bmeIndexedDbWriteInFlightByChatId.get(normalizedChatId) ===
        nextWritePromise
      ) {
        bmeIndexedDbWriteInFlightByChatId.delete(normalizedChatId);
      }
    });

  bmeIndexedDbWriteInFlightByChatId.set(normalizedChatId, nextWritePromise);
}

function saveGraphToChat(options = {}) {
  const context = getContext();
  if (!context || !currentGraph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      reason: "missing-context-or-graph",
    });
  }
  const chatId = getCurrentChatId(context);
  const {
    reason = "graph-save",
    markMutation = true,
    persistMetadata = false,
    captureShadow = Boolean(persistMetadata),
    immediate = markMutation,
  } = options;

  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      reason: "missing-chat-id",
    });
  }

  const revision = markMutation
    ? allocateRequestedPersistRevision(0, currentGraph)
    : resolvePersistRevisionFloor(0, currentGraph);

  if (captureShadow) {
    maybeCaptureGraphShadowSnapshot(reason);
  }

  const shouldQueueIndexedDbPersist =
    markMutation || !isGraphEffectivelyEmpty(currentGraph);
  if (shouldQueueIndexedDbPersist) {
    queueGraphPersistToIndexedDb(chatId, currentGraph, {
      revision,
      reason,
    });
  }

  const metadataFallbackEnabled =
    Boolean(persistMetadata) || !ensureBmeChatManager();

  if (!markMutation) {
    const hasMeaningfulGraphData = !isGraphEffectivelyEmpty(currentGraph);
    if (
      !hasMeaningfulGraphData ||
      graphPersistenceState.loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
    ) {
      return buildGraphPersistResult({
        saved: false,
        blocked: false,
        reason: hasMeaningfulGraphData
          ? "passive-empty-confirmed-skipped"
          : "passive-empty-graph-skipped",
        revision,
      });
    }
  }

  if (!metadataFallbackEnabled) {
    const saveMode = shouldQueueIndexedDbPersist
      ? "indexeddb-queued"
      : "indexeddb-skip";
    updateGraphPersistenceState({
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      dbReady:
        graphPersistenceState.dbReady ??
        isGraphLoadStateDbReady(graphPersistenceState.loadState),
      lastPersistReason: String(reason || "graph-save"),
      lastPersistMode: saveMode,
      pendingPersist: false,
      queuedPersistChatId: "",
      queuedPersistMode: "",
      queuedPersistReason: "",
      queuedPersistRotateIntegrity: false,
      dualWriteLastResult: {
        action: "save",
        target: "indexeddb",
        queued: Boolean(shouldQueueIndexedDbPersist),
        success: true,
        chatId,
        revision: normalizeIndexedDbRevision(revision),
        reason: String(reason || "graph-save"),
        at: Date.now(),
      },
    });
    return buildGraphPersistResult({
      saved: false,
      queued: Boolean(shouldQueueIndexedDbPersist),
      blocked: false,
      accepted: false,
      reason: shouldQueueIndexedDbPersist
        ? "indexeddb-queued"
        : "indexeddb-empty-skip",
      revision,
      saveMode,
      storageTier: shouldQueueIndexedDbPersist ? "indexeddb" : "none",
    });
  }

  if (!isGraphMetadataWriteAllowed()) {
    console.warn(
      `[ST-BME] 图谱写回已被安全保护拦截（chat=${chatId}，state=${graphPersistenceState.loadState}，reason=${reason}）`,
    );
    return queueGraphPersist(reason, revision, { immediate });
  }

  const metadataPersistResult = persistGraphToChatMetadata(context, {
    reason,
    revision,
    immediate,
  });
  updateGraphPersistenceState({
    storageMode: "metadata-full",
    dualWriteLastResult: {
      action: "save",
      target: "metadata",
      success: Boolean(metadataPersistResult?.saved),
      queued: Boolean(metadataPersistResult?.queued),
      blocked: Boolean(metadataPersistResult?.blocked),
      chatId,
      revision: normalizeIndexedDbRevision(revision),
      reason: String(reason || "graph-save"),
      at: Date.now(),
    },
  });

  return metadataPersistResult;
}

function handleGraphShadowSnapshotPageHide() {
  saveGraphToChat({
    reason: "pagehide-passive-persist",
    markMutation: false,
    captureShadow: true,
    immediate: false,
  });
  maybeCaptureGraphShadowSnapshot("pagehide");
}

function handleGraphShadowSnapshotVisibilityChange() {
  if (document.visibilityState === "hidden") {
    saveGraphToChat({
      reason: "visibility-hidden-passive-persist",
      markMutation: false,
      captureShadow: true,
      immediate: false,
    });
    maybeCaptureGraphShadowSnapshot("visibility-hidden");
  }
}

// ==================== 核心流程 ====================

function getLatestUserChatMessage(chat) {
  if (!Array.isArray(chat)) return null;

  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (isSystemMessageForExtraction(message, { index, chat })) continue;
    if (message?.is_user) return message;
  }

  return null;
}

function getLastNonSystemChatMessage(chat) {
  if (!Array.isArray(chat)) return null;

  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (!isSystemMessageForExtraction(message, { index, chat })) {
      return message;
    }
  }

  return null;
}

function buildRecallRecentMessages(chat, limit, syntheticUserMessage = "") {
  return buildRecallRecentMessagesController(
    chat,
    limit,
    syntheticUserMessage,
    {
      formatRecallContextLine,
      normalizeRecallInputText,
    },
  );
}

function getRecallUserMessageSourceLabel(source) {
  return getRecallUserMessageSourceLabelController(source);
}

function resolveRecallInput(chat, recentContextMessageLimit, override = null) {
  return resolveRecallInputController(
    chat,
    recentContextMessageLimit,
    override,
    {
      buildRecallRecentMessages,
      getLastNonSystemChatMessage,
      getLatestUserChatMessage,
      getRecallUserMessageSourceLabel,
      isFreshRecallInputRecord,
      lastRecallSentUserMessage,
      normalizeRecallInputText,
      pendingRecallSendIntent,
    },
  );
}

function buildGenerationAfterCommandsRecallInput(type, params = {}, chat) {
  if (params?.automatic_trigger || params?.quiet_prompt) {
    return null;
  }

  const generationType = String(type || "").trim() || "normal";
  if (!["normal", "continue", "regenerate", "swipe"].includes(generationType)) {
    return null;
  }

  const targetUserMessageIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType,
  });

  // 对于 history 类型（continue/regenerate/swipe），必须�?chat 中的用户消息
  if (generationType !== "normal") {
    if (!Number.isFinite(targetUserMessageIndex)) {
      return {
        generationType,
        targetUserMessageIndex: null,
      };
    }
    const historyInput = buildHistoryGenerationRecallInput(chat);
    if (!historyInput) {
      return {
        generationType,
        targetUserMessageIndex,
      };
    }
    return {
      ...historyInput,
      generationType,
      targetUserMessageIndex,
    };
  }

  // 对于 normal 类型：GENERATION_AFTER_COMMANDS 触发时用户消息可能不�?chat 末尾
  // （ST 可能已追加空 assistant 消息）。如�?chat 中存在任何用户消息，
  // 继续�?buildNormalGenerationRecallInput，它会通过 latestUserText 兜底找到�?
  // 如果 chat 中完全没有用户消息，则延迟到 BEFORE_COMBINE_PROMPTS 处理�?
  if (!Number.isFinite(targetUserMessageIndex) && !getLatestUserChatMessage(chat)) {
    return {
      generationType,
      targetUserMessageIndex: null,
    };
  }

  const normalInput = buildNormalGenerationRecallInput(chat, {
    frozenInputSnapshot: params?.frozenInputSnapshot,
  });
  return normalInput;
}

function createTrivialRecallSkipSentinel(reason = "") {
  return {
    __trivialSkip: true,
    trivialReason: String(reason || ""),
  };
}

function buildNormalGenerationRecallInput(chat, options = {}) {
  const lastNonSystemMessage = getLastNonSystemChatMessage(chat);
  const tailUserText = lastNonSystemMessage?.is_user
    ? normalizeRecallInputText(lastNonSystemMessage?.mes || "")
    : "";
  // �?GENERATION_AFTER_COMMANDS 触发时，ST 可能已追加了�?assistant 消息�?
  // 导致 lastNonSystemMessage 不是 user。用 getLatestUserChatMessage 反向扫描
  // 定位真正的用户消息（�?shujuku 参考实现一致）�?
  const latestUserMessage = !tailUserText ? getLatestUserChatMessage(chat) : null;
  const latestUserText = latestUserMessage
    ? normalizeRecallInputText(latestUserMessage?.mes || "")
    : "";
  const targetUserMessageIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType: "normal",
  });
  const frozenInputSnapshot = isFreshRecallInputRecord(
    options?.frozenInputSnapshot,
  )
    ? options.frozenInputSnapshot
    : null;
  const pendingSendIntent = isFreshRecallInputRecord(pendingRecallSendIntent)
    ? pendingRecallSendIntent
    : null;
  const sendIntentText = normalizeRecallInputText(
    pendingSendIntent?.text || "",
  );
  const hostSnapshotText = normalizeRecallInputText(
    frozenInputSnapshot?.text || "",
  );
  const textareaText = normalizeRecallInputText(getSendTextareaValue());
  const sourceCandidates = [
    sendIntentText
      ? {
          text: sendIntentText,
          source: "send-intent",
          sourceLabel: "发送意图",
          reason: tailUserText
            ? "send-intent-overrides-chat-tail"
            : "send-intent-captured",
          includeSyntheticUserMessage: !tailUserText,
        }
      : null,
    hostSnapshotText
      ? {
          text: hostSnapshotText,
          source: String(
            frozenInputSnapshot?.source || "host-generation-lifecycle",
          ),
          sourceLabel: "宿主发送快照",
          reason: sendIntentText
            ? "host-snapshot-suppressed-by-send-intent"
            : tailUserText
              ? "host-snapshot-suppressed-by-chat-tail"
              : "host-snapshot-captured",
          includeSyntheticUserMessage: !tailUserText,
        }
      : null,
    tailUserText
      ? {
          text: tailUserText,
          source: "chat-tail-user",
          sourceLabel: "当前用户楼层",
          reason:
            sendIntentText || hostSnapshotText
              ? "chat-tail-deprioritized"
              : "chat-tail-fallback",
          includeSyntheticUserMessage: false,
        }
      : null,
    latestUserText
      ? {
          text: latestUserText,
          source: "chat-latest-user",
          sourceLabel: "最近用户消息",
          reason:
            sendIntentText || hostSnapshotText || tailUserText
              ? "latest-user-deprioritized"
              : "latest-user-fallback",
          includeSyntheticUserMessage: false,
        }
      : null,
    textareaText
      ? {
          text: textareaText,
          source: "textarea-live",
          sourceLabel: "输入框当前文本",
          reason:
            sendIntentText || hostSnapshotText || tailUserText
              ? "textarea-live-deprioritized"
              : "textarea-live-fallback",
          includeSyntheticUserMessage: !tailUserText,
        }
      : null,
  ].filter(Boolean);
  const activeTrivialSkip = getCurrentGenerationTrivialSkip();
  if (activeTrivialSkip) {
    clearPendingRecallSendIntent();
    clearPendingHostGenerationInputSnapshot();
    return createTrivialRecallSkipSentinel(activeTrivialSkip.reason);
  }

  const selectedCandidate = sourceCandidates[0] || null;
  if (!selectedCandidate?.text) return null;

  const trivialInputResult = isTrivialUserInput(selectedCandidate.text);

  if (trivialInputResult.trivial) {
    clearPendingRecallSendIntent();
    clearPendingHostGenerationInputSnapshot();
    markCurrentGenerationTrivialSkip({
      reason: trivialInputResult.reason,
      chatId: getCurrentChatId(),
      chatLength: Array.isArray(chat) ? chat.length : 0,
    });
    console.info?.(
      `[ST-BME] trivial-input skip: reason=${trivialInputResult.reason} len=${trivialInputResult.normalizedText.length} hook=build-normal-input`,
    );
    return createTrivialRecallSkipSentinel(trivialInputResult.reason);
  }

  return {
    overrideUserMessage: selectedCandidate.text,
    generationType: "normal",
    targetUserMessageIndex,
    overrideSource: selectedCandidate.source,
    overrideSourceLabel: selectedCandidate.sourceLabel,
    overrideReason: selectedCandidate.reason,
    sourceCandidates,
    includeSyntheticUserMessage: selectedCandidate.includeSyntheticUserMessage,
  };
}

function buildHistoryGenerationRecallInput(chat) {
  const latestUserText = normalizeRecallInputText(
    getLatestUserChatMessage(chat)?.mes || lastRecallSentUserMessage.text,
  );
  if (!latestUserText) return null;
  const targetUserMessageIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType: "history",
  });

  return {
    overrideUserMessage: latestUserText,
    generationType: "history",
    targetUserMessageIndex,
    overrideSource: Number.isFinite(targetUserMessageIndex)
      ? "chat-last-user"
      : "chat-last-user-missing",
    overrideSourceLabel: Number.isFinite(targetUserMessageIndex)
      ? "历史最后用户楼层"
      : "历史用户楼层缺失",
    includeSyntheticUserMessage: false,
  };
}

function cleanupPlannerRecallHandoffs(now = Date.now()) {
  for (const [chatId, handoff] of plannerRecallHandoffs.entries()) {
    if (
      !handoff ||
      String(handoff.chatId || "") !== String(chatId || "") ||
      now - Number(handoff.updatedAt || handoff.createdAt || 0) >
        PLANNER_RECALL_HANDOFF_TTL_MS
    ) {
      plannerRecallHandoffs.delete(chatId);
    }
  }
}

function peekPlannerRecallHandoff(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  cleanupPlannerRecallHandoffs(now);
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  const handoff = plannerRecallHandoffs.get(normalizedChatId) || null;
  if (!handoff) return null;
  if (
    now - Number(handoff.updatedAt || handoff.createdAt || 0) >
    PLANNER_RECALL_HANDOFF_TTL_MS
  ) {
    plannerRecallHandoffs.delete(normalizedChatId);
    return null;
  }
  return handoff;
}

function clearPlannerRecallHandoffsForChat(
  chatId = getCurrentChatId(),
  { clearAll = false } = {},
) {
  cleanupPlannerRecallHandoffs();
  if (clearAll) {
    const removed = plannerRecallHandoffs.size;
    plannerRecallHandoffs.clear();
    return removed;
  }

  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return 0;
  return plannerRecallHandoffs.delete(normalizedChatId) ? 1 : 0;
}

function consumePlannerRecallHandoff(
  chatId = getCurrentChatId(),
  { handoffId = "" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  const handoff = peekPlannerRecallHandoff(normalizedChatId);
  if (!handoff) return null;
  if (handoffId && String(handoff.id || "") !== String(handoffId || "")) {
    return null;
  }

  plannerRecallHandoffs.delete(normalizedChatId);
  return handoff;
}

function preparePlannerRecallHandoff({
  rawUserInput = "",
  plannerAugmentedMessage = "",
  plannerRecall = null,
  chatId = getCurrentChatId(),
} = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const normalizedRawUserInput = normalizeRecallInputText(rawUserInput);
  const normalizedPlannerAugmentedMessage = normalizeRecallInputText(
    plannerAugmentedMessage,
  );
  const result = plannerRecall?.result || null;
  if (!normalizedChatId || !normalizedRawUserInput || !result) {
    return null;
  }

  cleanupPlannerRecallHandoffs();
  const createdAt = Date.now();
  const injectionText = normalizeRecallInputText(
    plannerRecall?.memoryBlock || formatInjection(result, getSchema()),
  );
  const handoff = {
    id: [
      normalizedChatId,
      hashRecallInput(normalizedRawUserInput),
      createdAt,
    ].join(":"),
    chatId: normalizedChatId,
    rawUserInput: normalizedRawUserInput,
    plannerAugmentedMessage: normalizedPlannerAugmentedMessage,
    result,
    recentMessages: Array.isArray(plannerRecall?.recentMessages)
      ? plannerRecall.recentMessages.map((item) => String(item || ""))
      : [],
    injectionText,
    source: "planner-handoff",
    sourceLabel: "Planner handoff",
    createdAt,
    updatedAt: createdAt,
  };
  plannerRecallHandoffs.set(normalizedChatId, handoff);
  return handoff;
}

function buildPreGenerationRecallKey(type, options = {}) {
  const targetUserMessageIndex = Number.isFinite(options.targetUserMessageIndex)
    ? options.targetUserMessageIndex
    : "none";
  const seedText =
    options.overrideUserMessage ||
    options.userMessage ||
    `@target:${targetUserMessageIndex}`;

  const normalizedChatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId(),
  );

  return [
    normalizedChatId,
    String(type || "normal").trim() || "normal",
    hashRecallInput(seedText || ""),
  ].join(":");
}

function cleanupGenerationRecallTransactions(now = Date.now()) {
  for (const [
    transactionId,
    transaction,
  ] of generationRecallTransactions.entries()) {
    if (
      !transaction ||
      now - (transaction.updatedAt || 0) > GENERATION_RECALL_TRANSACTION_TTL_MS
    ) {
      generationRecallTransactions.delete(transactionId);
    }
  }
}

function getGenerationRecallPeerHookName(hookName = "") {
  const normalized = String(hookName || "").trim();
  if (normalized === "GENERATION_AFTER_COMMANDS") {
    return "GENERATE_BEFORE_COMBINE_PROMPTS";
  }
  if (normalized === "GENERATE_BEFORE_COMBINE_PROMPTS") {
    return "GENERATION_AFTER_COMMANDS";
  }
  return "";
}

function isGenerationRecallTransactionWithinBridgeWindow(
  transaction,
  now = Date.now(),
) {
  if (!transaction) return false;
  return (
    now - Number(transaction.updatedAt || transaction.createdAt || 0) <=
    GENERATION_RECALL_HOOK_BRIDGE_MS
  );
}

function normalizeGenerationRecallTransactionType(generationType = "normal") {
  const normalized = String(generationType || "normal").trim() || "normal";
  return normalized === "normal" ? "normal" : "history";
}

function resolveGenerationRecallDeliveryMode(
  hookName,
  generationType = "normal",
  recallOptions = {},
) {
  if (recallOptions?.forceImmediateDelivery === true) {
    return "immediate";
  }

  const normalizedType = normalizeGenerationRecallTransactionType(
    recallOptions?.generationType || generationType,
  );
  if (normalizedType !== "normal") {
    return "immediate";
  }

  // GENERATION_AFTER_COMMANDS: immediate —�?await 完召回后直接通过
  // setExtensionPrompt 注入记忆，与 shujuku 参考实现一致�?
  // GENERATE_BEFORE_COMBINE_PROMPTS: deferred —�?作为兜底，通过 promptData
  // rewrite 补救注入�?
  if (hookName === "GENERATE_BEFORE_COMBINE_PROMPTS") {
    return "deferred";
  }
  return "immediate";
}

function freezeGenerationRecallOptionsForTransaction(
  chat,
  generationType = "normal",
  recallOptions = {},
) {
  if (!Array.isArray(chat)) return null;

  const optionGenerationType =
    String(
      recallOptions?.generationType || generationType || "normal",
    ).trim() || "normal";
  const normalizedGenerationType = optionGenerationType;

  const overrideUserMessage = normalizeRecallInputText(
    recallOptions?.overrideUserMessage || recallOptions?.userMessage || "",
  );

  const source =
    String(
      recallOptions?.overrideSource || recallOptions?.source || "",
    ).trim() ||
    (normalizeGenerationRecallTransactionType(normalizedGenerationType) ===
    "normal"
      ? "chat-tail-user"
      : "chat-last-user");
  const sourceLabel =
    String(
      recallOptions?.overrideSourceLabel ||
        recallOptions?.sourceLabel ||
        getRecallUserMessageSourceLabel(source),
    ).trim() || getRecallUserMessageSourceLabel(source);
  const sourceReason =
    String(
      recallOptions?.overrideReason || recallOptions?.reason || "",
    ).trim() || "transaction-source-frozen";
  const sourceCandidates = Array.isArray(recallOptions?.sourceCandidates)
    ? recallOptions.sourceCandidates
        .map((candidate) => ({
          text: normalizeRecallInputText(candidate?.text || ""),
          source: String(candidate?.source || "").trim(),
          sourceLabel: String(candidate?.sourceLabel || "").trim(),
          reason: String(candidate?.reason || "").trim(),
          includeSyntheticUserMessage: Boolean(
            candidate?.includeSyntheticUserMessage,
          ),
        }))
        .filter((candidate) => candidate.text && candidate.source)
    : [];

  let targetUserMessageIndex = Number.isFinite(
    recallOptions?.targetUserMessageIndex,
  )
    ? Math.floor(Number(recallOptions.targetUserMessageIndex))
    : resolveGenerationTargetUserMessageIndex(chat, {
        generationType: normalizedGenerationType,
      });

  if (!Number.isFinite(targetUserMessageIndex)) {
    if (
      normalizeGenerationRecallTransactionType(normalizedGenerationType) ===
        "normal" &&
      overrideUserMessage
    ) {
      return {
        generationType: normalizedGenerationType,
        targetUserMessageIndex: null,
        overrideUserMessage,
        overrideSource: source,
        overrideSourceLabel: sourceLabel,
        overrideReason: sourceReason,
        sourceCandidates,
        lockedSource: source,
        lockedSourceLabel: sourceLabel,
        lockedReason: sourceReason,
        includeSyntheticUserMessage: Boolean(
          recallOptions?.includeSyntheticUserMessage,
        ),
      };
    }
    return null;
  }
  targetUserMessageIndex = Math.floor(targetUserMessageIndex);

  const targetUserMessage = chat[targetUserMessageIndex];
  if (!targetUserMessage?.is_user) {
    return null;
  }

  const frozenUserMessage = normalizeRecallInputText(
    targetUserMessage?.mes ||
      recallOptions?.overrideUserMessage ||
      recallOptions?.userMessage ||
      "",
  );
  if (!frozenUserMessage) {
    return null;
  }

  return {
    generationType: normalizedGenerationType,
    targetUserMessageIndex,
    overrideUserMessage: frozenUserMessage,
    overrideSource: source,
    overrideSourceLabel: sourceLabel,
    overrideReason:
      sourceReason ||
      (frozenUserMessage === overrideUserMessage
        ? "transaction-source-frozen"
        : "transaction-bound-to-chat-user-floor"),
    sourceCandidates,
    lockedSource: source,
    lockedSourceLabel: sourceLabel,
    lockedReason:
      sourceReason ||
      (frozenUserMessage === overrideUserMessage
        ? "transaction-source-frozen"
        : "transaction-bound-to-chat-user-floor"),
    includeSyntheticUserMessage: false,
  };
}

function buildGenerationRecallTransactionId(chatId, generationType, recallKey) {
  return [
    String(chatId || ""),
    String(generationType || "normal").trim() || "normal",
    String(recallKey || ""),
  ].join(":");
}

function beginGenerationRecallTransaction({
  chatId,
  generationType = "normal",
  recallKey = "",
  forceNew = false,
} = {}) {
  const normalizedChatId = String(chatId || "");
  const normalizedGenerationType =
    String(generationType || "normal").trim() || "normal";
  const normalizedRecallKey = String(recallKey || "");
  if (!normalizedChatId || !normalizedRecallKey) return null;

  cleanupGenerationRecallTransactions();
  const transactionId = buildGenerationRecallTransactionId(
    normalizedChatId,
    normalizedGenerationType,
    normalizedRecallKey,
  );

  const now = Date.now();
  const existingTransaction =
    generationRecallTransactions.get(transactionId) || null;
  if (
    existingTransaction &&
    isGenerationRecallTransactionWithinBridgeWindow(existingTransaction, now) &&
    !forceNew
  ) {
    existingTransaction.updatedAt = now;
    generationRecallTransactions.set(transactionId, existingTransaction);
    return existingTransaction;
  }

  const transaction = {
    id: transactionId,
    chatId: normalizedChatId,
    generationType: normalizedGenerationType,
    recallKey: normalizedRecallKey,
    hookStates: {},
    createdAt: now,
    frozenRecallOptions: null,
  };
  transaction.updatedAt = now;
  generationRecallTransactions.set(transactionId, transaction);
  return transaction;
}

function findRecentGenerationRecallTransactionForChat(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  let latestTransaction = null;
  for (const transaction of generationRecallTransactions.values()) {
    if (!transaction || String(transaction.chatId || "") !== normalizedChatId)
      continue;
    if (!isGenerationRecallTransactionWithinBridgeWindow(transaction, now))
      continue;
    if (
      !latestTransaction ||
      Number(transaction.updatedAt || 0) >
        Number(latestTransaction.updatedAt || 0)
    ) {
      latestTransaction = transaction;
    }
  }

  return latestTransaction;
}

function shouldReuseRecentGenerationRecallTransaction(
  transaction,
  hookName,
  recallKey = "",
  now = Date.now(),
) {
  if (!transaction || !hookName) return false;
  if (!isGenerationRecallTransactionWithinBridgeWindow(transaction, now)) {
    return false;
  }

  const hookStates = transaction.hookStates || {};
  const normalizedRecallKey = String(recallKey || "");
  const transactionRecallKey = String(transaction.recallKey || "");

  if (Object.values(hookStates).includes("running")) {
    return true;
  }

  const peerHookName = getGenerationRecallPeerHookName(hookName);
  const peerHookState = peerHookName ? hookStates[peerHookName] : "";
  if (peerHookState) {
    return true;
  }

  const ownState = hookStates[hookName];
  if (ownState) {
    return ownState === "running";
  }

  if (!Object.keys(hookStates).length) {
    if (!transactionRecallKey) {
      return true;
    }
    if (!normalizedRecallKey) {
      return false;
    }
    if (normalizedRecallKey !== transactionRecallKey) {
      return false;
    }
    return true;
  }

  return false;
}

function markGenerationRecallTransactionHookState(
  transaction,
  hookName,
  state = "completed",
) {
  if (!transaction?.id || !hookName) return transaction;
  transaction.hookStates ||= {};
  transaction.hookStates[hookName] = state;
  transaction.updatedAt = Date.now();
  generationRecallTransactions.set(transaction.id, transaction);
  return transaction;
}

function getGenerationRecallTransactionResult(transaction) {
  return transaction?.lastRecallResult || null;
}

function storeGenerationRecallTransactionResult(
  transaction,
  recallResult = null,
  meta = {},
) {
  if (!transaction?.id) return transaction;
  transaction.lastRecallResult = recallResult ? { ...recallResult } : null;
  transaction.lastRecallMeta =
    meta && typeof meta === "object" ? { ...meta } : {};
  transaction.lastDeliveryMode =
    String(meta?.deliveryMode || recallResult?.deliveryMode || "").trim() ||
    transaction.lastDeliveryMode ||
    "";
  transaction.finalResolution = null;
  transaction.updatedAt = Date.now();
  generationRecallTransactions.set(transaction.id, transaction);
  return transaction;
}

function clearGenerationRecallTransactionsForChat(
  chatId = getCurrentChatId(),
  { clearAll = false } = {},
) {
  let removed = 0;
  const normalizedChatId = String(chatId || "");
  if (clearAll || !normalizedChatId) {
    removed = generationRecallTransactions.size;
    generationRecallTransactions.clear();
    return removed;
  }

  for (const [
    transactionId,
    transaction,
  ] of generationRecallTransactions.entries()) {
    if (String(transaction?.chatId || "") !== normalizedChatId) continue;
    generationRecallTransactions.delete(transactionId);
    removed += 1;
  }

  return removed;
}

function invalidateRecallAfterHistoryMutation(reason = "聊天记录已变更") {
  if (isRestoreLockActive()) {
    return false;
  }

  const hadActiveRecall = Boolean(
    isRecalling ||
    (stageAbortControllers.recall &&
      !stageAbortControllers.recall.signal?.aborted),
  );
  if (hadActiveRecall) {
    abortRecallStageWithReason(`${reason}，当前召回已取消`);
  }

  clearGenerationRecallTransactionsForChat();
  clearRecallInputTracking();
  clearCurrentGenerationTrivialSkip("history-mutation");
  clearInjectionState({
    preserveRecallStatus: hadActiveRecall,
    preserveRuntimeStatus: hadActiveRecall,
  });

  if (hadActiveRecall) {
    setLastRecallStatus(
      "召回已取消",
      `${reason}，等待新的召回请求`,
      "warning",
      {
        syncRuntime: true,
      },
    );
  }

  return hadActiveRecall;
}

function createGenerationRecallContext({
  hookName,
  generationType = "normal",
  recallOptions = {},
  chatId = getCurrentChatId(),
} = {}) {
  const context = getContext();
  const chat = context?.chat;
  const normalizedChatId = normalizeChatIdCandidate(
    chatId || context?.chatId || getCurrentChatId(),
  );
  const effectiveGenerationType = normalizeGenerationRecallTransactionType(
    recallOptions?.generationType || generationType,
  );
  const plannerRecallHandoff =
    effectiveGenerationType === "normal"
      ? peekPlannerRecallHandoff(normalizedChatId)
      : null;
  const effectiveRecallOptions = plannerRecallHandoff
    ? {
        ...(recallOptions || {}),
        overrideUserMessage: plannerRecallHandoff.rawUserInput,
        overrideSource: plannerRecallHandoff.source || "planner-handoff",
        overrideSourceLabel:
          plannerRecallHandoff.sourceLabel || "Planner handoff",
        overrideReason: "planner-handoff-reuse",
        sourceCandidates: [
          {
            text: plannerRecallHandoff.rawUserInput,
            source: plannerRecallHandoff.source || "planner-handoff",
            sourceLabel:
              plannerRecallHandoff.sourceLabel || "Planner handoff",
            reason: "planner-handoff-reuse",
            includeSyntheticUserMessage: false,
          },
        ],
        includeSyntheticUserMessage: false,
      }
    : recallOptions;

  const frozenRecallOptions = freezeGenerationRecallOptionsForTransaction(
    chat,
    generationType,
    effectiveRecallOptions,
  );
  if (!frozenRecallOptions) {
    return {
      hookName,
      generationType,
      recallKey: "",
      transaction: null,
      recallOptions: null,
      shouldRun: false,
      guardReason: "missing-frozen-recall-options",
    };
  }

  const transactionGenerationType = normalizeGenerationRecallTransactionType(
    frozenRecallOptions.generationType || generationType,
  );
  const fallbackRecallKey =
    effectiveRecallOptions?.recallKey ||
    buildPreGenerationRecallKey(transactionGenerationType, {
      ...frozenRecallOptions,
      chatId: normalizedChatId,
      userMessage: frozenRecallOptions.overrideUserMessage,
    });

  if (!normalizedChatId || !String(fallbackRecallKey || "").trim()) {
    return {
      hookName,
      generationType: transactionGenerationType,
      recallKey: "",
      transaction: null,
      recallOptions: null,
      shouldRun: false,
      guardReason: !normalizedChatId ? "missing-chat-id" : "missing-recall-key",
    };
  }

  const now = Date.now();
  const recentTransaction = findRecentGenerationRecallTransactionForChat(
    normalizedChatId,
    now,
  );
  let transaction = recentTransaction;
  if (
    !shouldReuseRecentGenerationRecallTransaction(
      transaction,
      hookName,
      fallbackRecallKey,
      now,
    )
  ) {
    transaction = beginGenerationRecallTransaction({
      chatId: normalizedChatId,
      generationType: transactionGenerationType,
      recallKey: fallbackRecallKey,
      forceNew: true,
    });
  }

  if (!transaction) {
    return {
      hookName,
      generationType: transactionGenerationType,
      recallKey: "",
      transaction: null,
      recallOptions: null,
      shouldRun: false,
      guardReason: "transaction-unavailable",
    };
  }

  const normalizedTransactionChatId = normalizeChatIdCandidate(
    transaction.chatId,
  );
  const transactionRecallKey = String(transaction.recallKey || "").trim();
  if (
    normalizedTransactionChatId !== normalizedChatId ||
    !transactionRecallKey ||
    transactionRecallKey !== String(fallbackRecallKey)
  ) {
    return {
      hookName,
      generationType: transactionGenerationType,
      recallKey: String(fallbackRecallKey || ""),
      transaction,
      recallOptions: null,
      shouldRun: false,
      guardReason: "transaction-mismatch",
    };
  }

  if (
    !transaction.frozenRecallOptions ||
    typeof transaction.frozenRecallOptions !== "object"
  ) {
    transaction.frozenRecallOptions = {
      ...frozenRecallOptions,
      lockedSource:
        frozenRecallOptions?.lockedSource ||
        frozenRecallOptions?.overrideSource ||
        frozenRecallOptions?.source ||
        "",
      lockedSourceLabel:
        frozenRecallOptions?.lockedSourceLabel ||
        frozenRecallOptions?.overrideSourceLabel ||
        frozenRecallOptions?.sourceLabel ||
        "",
      lockedReason:
        frozenRecallOptions?.lockedReason ||
        frozenRecallOptions?.overrideReason ||
        frozenRecallOptions?.reason ||
        "",
      lockedAt: now,
    };
  }
  if (!String(transaction.generationType || "").trim()) {
    transaction.generationType = transactionGenerationType;
  }
  transaction.updatedAt = now;
  generationRecallTransactions.set(transaction.id, transaction);

  const boundRecallOptions = {
    ...(transaction.frozenRecallOptions || frozenRecallOptions),
    recallKey: transaction.recallKey,
    generationType:
      transaction.frozenRecallOptions?.generationType || generationType,
  };
  if (plannerRecallHandoff?.result) {
    boundRecallOptions.cachedRecallPayload = {
      handoffId: plannerRecallHandoff.id,
      chatId: plannerRecallHandoff.chatId,
      result: plannerRecallHandoff.result,
      recentMessages: Array.isArray(plannerRecallHandoff.recentMessages)
        ? plannerRecallHandoff.recentMessages.map((item) => String(item || ""))
        : [],
      injectionText: String(plannerRecallHandoff.injectionText || ""),
      source: plannerRecallHandoff.source || "planner-handoff",
      sourceLabel: plannerRecallHandoff.sourceLabel || "Planner handoff",
      reason: "planner-handoff-reuse",
    };
  }

  const recallKey = transactionRecallKey;
  const shouldRun = shouldRunRecallForTransaction(transaction, hookName);

  return {
    hookName,
    generationType: boundRecallOptions.generationType,
    recallKey,
    transaction,
    recallOptions: boundRecallOptions,
    shouldRun,
    guardReason: shouldRun ? "" : "transaction-not-runnable",
  };
}

function getCurrentChatSeq(context = getContext()) {
  const chat = context?.chat;
  if (Array.isArray(chat) && chat.length > 0) {
    return chat.length - 1;
  }
  return currentGraph?.lastProcessedSeq ?? 0;
}

async function handleExtractionSuccess(
  result,
  endIdx,
  settings,
  signal = undefined,
  status = createBatchStatusSkeleton({
    processedRange: [endIdx, endIdx],
    extractionCountBefore: extractionCount,
  }),
) {
  const postProcessArtifacts = [];
  const newNodeCount = Array.isArray(result?.newNodeIds)
    ? result.newNodeIds.length
    : 0;
  const resolveAutoConsolidationGate =
    typeof evaluateAutoConsolidationGate === "function"
      ? evaluateAutoConsolidationGate
      : (count, analysis = null, localSettings = {}) => {
          const minNewNodes = Math.max(
            1,
            Math.min(
              50,
              Math.floor(
                Number(localSettings?.consolidationAutoMinNewNodes ?? 2),
              ) || 2,
            ),
          );
          const safeCount = Math.max(0, Number(count) || 0);
          if (safeCount >= minNewNodes) {
            return {
              shouldRun: true,
              minNewNodes,
              reason: `本批新增 ${safeCount} 个节点，达到自动整合门槛 ${minNewNodes}`,
              matchedScore: null,
              matchedNodeId: "",
            };
          }
          if (analysis?.triggered) {
            return {
              shouldRun: true,
              minNewNodes,
              reason:
                String(analysis.reason || "").trim() ||
                "检测到高重复风险，已触发自动整合",
              matchedScore: Number.isFinite(Number(analysis?.matchedScore))
                ? Number(analysis.matchedScore)
                : null,
              matchedNodeId: String(analysis?.matchedNodeId || ""),
            };
          }
          return {
            shouldRun: false,
            minNewNodes,
            reason:
              String(analysis?.reason || "").trim() ||
              `本批新增少且无明显重复风险，跳过自动整合`,
            matchedScore: Number.isFinite(Number(analysis?.matchedScore))
              ? Number(analysis.matchedScore)
              : null,
            matchedNodeId: String(analysis?.matchedNodeId || ""),
          };
        };
  const analyzeConsolidationGate =
    typeof analyzeAutoConsolidationGate === "function"
      ? analyzeAutoConsolidationGate
      : async () => ({
          triggered: false,
          reason: "本批新增少且无明显重复风险，跳过自动整合",
          matchedScore: null,
          matchedNodeId: "",
        });
  const resolveAutoCompressionSchedule =
    typeof evaluateAutoCompressionSchedule === "function"
      ? evaluateAutoCompressionSchedule
      : (currentCount, localSettings = {}) => {
          const enabled = localSettings?.enableAutoCompression !== false;
          const parsedEveryN = Math.floor(Number(localSettings?.compressionEveryN));
          const everyN =
            Number.isFinite(parsedEveryN) && parsedEveryN >= 1
              ? Math.min(500, parsedEveryN)
              : 10;
          const safeCount = Math.max(0, Number(currentCount) || 0);
          if (!enabled) {
            return {
              scheduled: false,
              everyN,
              nextExtractionCount: null,
              reason: "自动压缩开关已关闭",
            };
          }
          const remainder = safeCount % everyN;
          if (remainder !== 0) {
            return {
              scheduled: false,
              everyN,
              nextExtractionCount: safeCount + (everyN - remainder),
              reason: `当前为第 ${safeCount} 次提取，未到每 ${everyN} 次自动压缩周期`,
            };
          }
          return {
            scheduled: true,
            everyN,
            nextExtractionCount: safeCount + everyN,
            reason: "",
          };
        };
  const inspectCompressionCandidates =
    typeof inspectAutoCompressionCandidates === "function"
      ? inspectAutoCompressionCandidates
      : () => ({
          hasCandidates: false,
          reason: "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组",
        });
  const applyMaintenanceGateNote =
    typeof noteMaintenanceGate === "function"
      ? noteMaintenanceGate
      : (batchStatus, action, reason) => {
          if (!batchStatus || !reason) return;
          batchStatus.maintenanceGateApplied = true;
          const details = Array.isArray(batchStatus.maintenanceGateDetails)
            ? batchStatus.maintenanceGateDetails
            : [];
          details.push({
            action: String(action || "").trim() || "unknown",
            reason: String(reason || ""),
          });
          batchStatus.maintenanceGateDetails = details;
          batchStatus.maintenanceGateReason = details
            .map((item) => `${item.action}: ${item.reason}`)
            .join(" | ");
        };
  const summarizeMaintenance =
    typeof buildMaintenanceSummary === "function"
      ? buildMaintenanceSummary
      : (action, maintenanceResult, mode = "manual") => {
          const prefix = mode === "auto" ? "自动" : "手动";
          switch (String(action || "")) {
            case "compress":
              return `${prefix}压缩：新增 ${maintenanceResult?.created || 0}，归档 ${maintenanceResult?.archived || 0}`;
            case "consolidate":
              return `${prefix}整合：合并 ${maintenanceResult?.merged || 0}，跳过 ${maintenanceResult?.skipped || 0}，保留 ${maintenanceResult?.kept || 0}，进化 ${maintenanceResult?.evolved || 0}，新链接 ${maintenanceResult?.connections || 0}，回溯更新 ${maintenanceResult?.updates || 0}`;
            case "sleep":
              return `${prefix}遗忘：归档 ${maintenanceResult?.forgotten || 0} 个节点`;
            default:
              return `${prefix}维护已执行`;
          }
        };
  const runSummaryPostProcess =
    typeof runHierarchicalSummaryPostProcess === "function"
      ? runHierarchicalSummaryPostProcess
      : typeof generateSynopsis === "function"
        ? async (params = {}) => {
            await generateSynopsis({
              graph: params.graph,
              schema: typeof getSchema === "function" ? getSchema() : [],
              currentSeq: params.currentAssistantFloor,
              settings: params.settings,
              signal: params.signal,
            });
            return {
              created: true,
              smallSummary: { created: true, reason: "" },
              rollup: null,
            };
          }
      : async () => ({
          created: false,
          smallSummary: {
            created: false,
            reason: "层级总结运行器不可用，已跳过",
          },
          rollup: null,
        });
  const summaryStageLabel =
    typeof runHierarchicalSummaryPostProcess === "function"
      ? "层级总结"
      : typeof generateSynopsis === "function"
        ? "概要生成"
        : "层级总结";
  const cloneMaintenanceSnapshot =
    typeof cloneGraphSnapshot === "function"
      ? cloneGraphSnapshot
      : (value) => JSON.parse(JSON.stringify(value ?? null));
  const persistMaintenanceAction =
    typeof recordMaintenanceAction === "function"
      ? recordMaintenanceAction
      : () => null;
  const updateExtractionPostProcessStatus = (
    text,
    meta,
    { noticeMarquee = false } = {},
  ) => {
    if (typeof setLastExtractionStatus !== "function") return;
    setLastExtractionStatus(text, meta, "running", {
      syncRuntime: true,
      noticeMarquee,
    });
  };
  throwIfAborted(signal, "提取已终止");
  extractionCount++;
  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;
  updateLastExtractedItems(result.newNodeIds || []);
  setBatchStageOutcome(status, "core", "success");
  updateExtractionPostProcessStatus(
    "提取收尾中",
    `已抽取 ${newNodeCount} 个新节点，正在处理后续阶段`,
  );

  if (settings.enableConsolidation && result.newNodeIds?.length > 0) {
    let consolidationAnalysis = null;
    const minNewNodes = Math.max(
      1,
      Math.min(
        50,
        Math.floor(Number(settings?.consolidationAutoMinNewNodes ?? 2)) || 2,
      ),
    );
    if (newNodeCount < minNewNodes) {
      updateExtractionPostProcessStatus(
        "整合判定中",
        `本批新增 ${newNodeCount} 个节点，正在检查是否需要自动整合/进化`,
      );
      consolidationAnalysis = await analyzeConsolidationGate({
        graph: currentGraph,
        newNodeIds: result.newNodeIds,
        embeddingConfig: getEmbeddingConfig(),
        schema: getSchema(),
        conflictThreshold: settings.consolidationThreshold,
        signal,
      });
    }
    const gate = resolveAutoConsolidationGate(
      newNodeCount,
      consolidationAnalysis,
      settings,
    );
    status.consolidationGateTriggered = Boolean(gate.shouldRun);
    status.consolidationGateReason = String(gate.reason || "");
    status.consolidationGateSimilarity = Number.isFinite(
      Number(gate.matchedScore),
    )
      ? Number(gate.matchedScore)
      : null;
    status.consolidationGateMatchedNodeId = String(gate.matchedNodeId || "");
    if (!gate.shouldRun) {
      applyMaintenanceGateNote(status, "consolidate", gate.reason);
      pushBatchStageArtifact(status, "structural", "consolidation-skipped");
    } else {
      try {
        updateExtractionPostProcessStatus(
          "整合/进化中",
          String(gate.reason || "").trim() || "正在自动整合新旧记忆",
        );
        const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
        const consolidationResult = await consolidateMemories({
          graph: currentGraph,
          newNodeIds: result.newNodeIds,
          embeddingConfig: getEmbeddingConfig(),
          options: {
            neighborCount: settings.consolidationNeighborCount,
            conflictThreshold: settings.consolidationThreshold,
          },
          settings,
          signal,
        });
        persistMaintenanceAction({
          action: "consolidate",
          beforeSnapshot,
          mode: "auto",
          summary: summarizeMaintenance(
            "consolidate",
            consolidationResult,
            "auto",
          ),
        });
        postProcessArtifacts.push("consolidation");
        pushBatchStageArtifact(status, "structural", "consolidation");
      } catch (e) {
        if (isAbortError(e)) throw e;
        const message = e?.message || String(e) || "记忆整合阶段失败";
        setBatchStageOutcome(
          status,
          "structural",
          "partial",
          `记忆整合失败: ${message}`,
        );
        console.error("[ST-BME] 记忆整合失败:", e);
      }
    }
  }

  if (settings.enableHierarchicalSummary !== false) {
    try {
      const currentChatMessages =
        typeof getContext === "function" && Array.isArray(getContext()?.chat)
          ? getContext().chat
          : [];
      updateExtractionPostProcessStatus(
        summaryStageLabel === "概要生成" ? "概要更新中" : "层级总结处理中",
        summaryStageLabel === "概要生成"
          ? `${extractionCount} 次提取，正在生成全局概要`
          : `${extractionCount} 次提取，正在检查小总结与折叠总结`,
      );
      const summaryResult = await runSummaryPostProcess({
        graph: currentGraph,
        chat: currentChatMessages,
        settings,
        signal,
        currentExtractionCount: extractionCount,
        currentAssistantFloor: endIdx,
        currentRange: result?.processedRange || [endIdx, endIdx],
        currentNodeIds: result?.changedNodeIds || result?.newNodeIds || [],
      });
      if (summaryResult?.smallSummary?.created) {
        postProcessArtifacts.push("summary");
        pushBatchStageArtifact(status, "semantic", "summary");
      } else if (summaryResult?.smallSummary?.reason) {
        applyMaintenanceGateNote(status, "summary", summaryResult.smallSummary.reason);
      }
      if (Number(summaryResult?.rollup?.createdCount || 0) > 0) {
        postProcessArtifacts.push("summary-rollup");
        pushBatchStageArtifact(status, "semantic", "summary-rollup");
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || `${summaryStageLabel}阶段失败`;
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `${summaryStageLabel}失败: ${message}`,
      );
      console.error(`[ST-BME] ${summaryStageLabel}失败:`, e);
    }
  }

  if (
    settings.enableReflection &&
    extractionCount % settings.reflectEveryN === 0
  ) {
    try {
      updateExtractionPostProcessStatus(
        "反思生成中",
        `${extractionCount} 次提取，正在生成长期反思`,
      );
      await generateReflection({
        graph: currentGraph,
        currentSeq: endIdx,
        settings,
        signal,
      });
      postProcessArtifacts.push("reflection");
      pushBatchStageArtifact(status, "semantic", "reflection");
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || "反思生成阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `反思生成失败: ${message}`,
      );
      console.error("[ST-BME] 反思生成失败:", e);
    }
  }

  if (
    settings.enableSleepCycle &&
    extractionCount % settings.sleepEveryN === 0
  ) {
    try {
      updateExtractionPostProcessStatus(
        "主动遗忘中",
        `${extractionCount} 次提取，正在归档低价值记忆`,
      );
      const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
      const sleepResult = sleepCycle(currentGraph, settings);
      if ((sleepResult?.forgotten || 0) > 0) {
        persistMaintenanceAction({
          action: "sleep",
          beforeSnapshot,
          mode: "auto",
          summary: summarizeMaintenance("sleep", sleepResult, "auto"),
        });
        postProcessArtifacts.push("sleep");
        pushBatchStageArtifact(status, "semantic", "sleep");
      }
    } catch (e) {
      const message = e?.message || String(e) || "主动遗忘阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `主动遗忘失败: ${message}`,
      );
      console.error("[ST-BME] 主动遗忘失败:", e);
    }
  }

  const compressionSchedule = resolveAutoCompressionSchedule(
    extractionCount,
    settings,
  );
  status.autoCompressionScheduled = Boolean(compressionSchedule.scheduled);
  status.nextCompressionAtExtractionCount =
    compressionSchedule.nextExtractionCount;
  status.autoCompressionSkippedReason = compressionSchedule.reason || "";

  try {
    throwIfAborted(signal, "提取已终止");
    if (compressionSchedule.scheduled) {
      const compressionInspection = inspectCompressionCandidates(
        currentGraph,
        getSchema(),
        false,
      );
      if (!compressionInspection?.hasCandidates) {
        status.autoCompressionSkippedReason =
          String(compressionInspection?.reason || "").trim() ||
          "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组";
        pushBatchStageArtifact(status, "structural", "compression-skipped");
      } else {
        updateExtractionPostProcessStatus(
          "自动压缩中",
          `已到第 ${extractionCount} 次提取周期，正在压缩层级记忆`,
        );
        status.autoCompressionSkippedReason = "";
        const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
        const compressionResult = await compressAll(
          currentGraph,
          getSchema(),
          getEmbeddingConfig(),
          false,
          undefined,
          signal,
          settings,
        );
        if (compressionResult.created > 0 || compressionResult.archived > 0) {
          persistMaintenanceAction({
            action: "compress",
            beforeSnapshot,
            mode: "auto",
            summary: summarizeMaintenance(
              "compress",
              compressionResult,
              "auto",
            ),
          });
          postProcessArtifacts.push("compression");
          pushBatchStageArtifact(status, "structural", "compression");
        } else {
          status.autoCompressionSkippedReason =
            "已尝试自动压缩，但本轮未产生可持久化变化";
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error?.message || String(error) || "压缩阶段失败";
    setBatchStageOutcome(
      status,
      "structural",
      "partial",
      `压缩阶段失败: ${message}`,
    );
    console.error("[ST-BME] 记忆压缩失败:", error);
  }

  let vectorSync = null;
  try {
    updateExtractionPostProcessStatus(
      "向量同步中",
      "正在同步本批提取后的向量索引",
    );
    vectorSync = await syncVectorState({ signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error?.message || String(error) || "向量同步阶段失败";
    setBatchStageOutcome(
      status,
      "finalize",
      "failed",
      `向量同步失败: ${message}`,
    );
    return {
      postProcessArtifacts,
      vectorHashesInserted: [],
      vectorStats: getVectorIndexStats(currentGraph),
      vectorError: message,
      warnings: status.warnings,
      batchStatus: finalizeBatchStatus(status, extractionCount),
    };
  }

  if (vectorSync?.aborted) {
    throw createAbortError(vectorSync.error || "提取已终止");
  }
  if (vectorSync?.error) {
    setBatchStageOutcome(
      status,
      "finalize",
      "failed",
      `向量同步失败: ${vectorSync.error}`,
    );
  } else {
    setBatchStageOutcome(status, "finalize", "success");
  }

  status.maintenanceJournalSize =
    currentGraph?.maintenanceJournal?.length || 0;
  if (
    status.maintenanceGateApplied &&
    !status.maintenanceGateReason &&
    Array.isArray(status.maintenanceGateDetails)
  ) {
    status.maintenanceGateReason = status.maintenanceGateDetails
      .map((item) => `${item.action}: ${item.reason}`)
      .join(" | ");
  }

  return {
    postProcessArtifacts,
    vectorHashesInserted: vectorSync?.insertedHashes || [],
    vectorStats: vectorSync?.stats || getVectorIndexStats(currentGraph),
    vectorError: vectorSync?.error || "",
    warnings: status.warnings,
    batchStatus: finalizeBatchStatus(status, extractionCount),
  };
}

function notifyHistoryDirty(dirtyFrom, reason) {
  updateStageNotice(
    "history",
    "检测到楼层历史变化",
    `将从楼层 ${dirtyFrom} 之后自动恢复${reason ? `\n${reason}` : ""}`,
    "warning",
    {
      persist: true,
      busy: true,
    },
  );
  const now = Date.now();
  if (now - lastHistoryWarningAt < 3000) return;
  lastHistoryWarningAt = now;
  toastr.warning(
    `检测到楼层历史变化，将从楼层 ${dirtyFrom} 之后自动恢复图谱`,
    reason || "ST-BME 历史回退保护",
  );
}

function clearPendingHistoryMutationChecks() {
  for (const timer of pendingHistoryMutationCheckTimers) {
    clearTimeout(timer);
  }
  pendingHistoryMutationCheckTimers = [];
}

function scheduleImmediateHistoryRecovery(
  trigger = "history-change",
  delayMs = HISTORY_RECOVERY_SETTLE_MS,
) {
  if (!getSettings().enabled) return;

  const scheduledChatId = getCurrentChatId();
  pendingHistoryRecoveryTrigger = trigger;
  clearTimeout(pendingHistoryRecoveryTimer);
  pendingHistoryRecoveryTimer = setTimeout(() => {
    pendingHistoryRecoveryTimer = null;
    const effectiveTrigger = pendingHistoryRecoveryTrigger || trigger;
    pendingHistoryRecoveryTrigger = "";
    if (!getSettings().enabled) return;
    if (getCurrentChatId() !== scheduledChatId) return;

    void recoverHistoryIfNeeded(`event:${effectiveTrigger}`)
      .then(() => {
        refreshPanelLiveState();
      })
      .catch((error) => {
        console.error("[ST-BME] 事件触发的历史恢复失败:", error);
        updateStageNotice(
          "history",
          "历史恢复失败",
          error?.message || String(error),
          "error",
          {
            busy: false,
            persist: false,
          },
        );
        toastr.error(`历史恢复失败: ${error?.message || error}`);
      });
  }, delayMs);
}

function scheduleHistoryMutationRecheck(
  trigger = "history-change",
  primaryArg = null,
  meta = null,
) {
  if (!getSettings().enabled) return;

  const scheduledChatId = getCurrentChatId();
  clearPendingHistoryMutationChecks();
  clearTimeout(pendingHistoryRecoveryTimer);
  pendingHistoryRecoveryTimer = null;
  pendingHistoryRecoveryTrigger = "";

  updateStageNotice(
    "history",
    "检测到楼层变动",
    "正在等待宿主楼层状态稳定后重新核对图谱",
    "warning",
    {
      persist: true,
      busy: true,
    },
  );

  for (const delayMs of HISTORY_MUTATION_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      pendingHistoryMutationCheckTimers =
        pendingHistoryMutationCheckTimers.filter(
          (candidate) => candidate !== timer,
        );
      if (!getSettings().enabled) return;
      if (getCurrentChatId() !== scheduledChatId) return;

      const detection = inspectHistoryMutation(
        `settled:${trigger}`,
        primaryArg,
        meta,
      );
      if (
        detection.dirty ||
        Number.isFinite(currentGraph?.historyState?.historyDirtyFrom)
      ) {
        clearPendingHistoryMutationChecks();
        scheduleImmediateHistoryRecovery(trigger, 0);
      } else if (pendingHistoryMutationCheckTimers.length === 0) {
        dismissStageNotice("history");
        refreshPanelLiveState();
      }
    }, delayMs);

    pendingHistoryMutationCheckTimers.push(timer);
  }
}

function inspectHistoryMutation(
  trigger = "history-change",
  primaryArg = null,
  meta = null,
) {
  if (!currentGraph)
    return { dirty: false, earliestAffectedFloor: null, reason: "" };

  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const chat = context?.chat;
  if (
    Array.isArray(chat) &&
    currentGraph.historyState?.processedMessageHashesNeedRefresh === true
  ) {
    rebindProcessedHistoryStateToChat(
      currentGraph,
      chat,
      getAssistantTurns(chat),
    );
    console.debug?.(
      "[ST-BME] refreshed processed message hashes after hash-version migration",
      {
        trigger,
        lastProcessedAssistantFloor:
          currentGraph.historyState.lastProcessedAssistantFloor ?? -1,
      },
    );
    if (isGraphMetadataWriteAllowed()) {
      saveGraphToChat({ reason: "processed-hash-version-migrated" });
    }
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
  }
  const metaDetection = resolveDirtyFloorFromMutationMeta(
    trigger,
    primaryArg,
    meta,
    chat,
  );
  const metaReason = String(trigger || "").includes("message-deleted")
    ? `${trigger} 元数据检测到删除边界变动`
    : `${trigger} 元数据检测到楼层变动`;
  if (
    metaDetection &&
    Number.isFinite(metaDetection.floor) &&
    metaDetection.floor <= getLastProcessedAssistantFloor()
  ) {
    clearInjectionState();
    markHistoryDirty(
      currentGraph,
      metaDetection.floor,
      metaReason,
      metaDetection.source,
    );
    saveGraphToChat({ reason: "history-dirty-meta-detection" });
    notifyHistoryDirty(metaDetection.floor, metaReason);
    return {
      dirty: true,
      earliestAffectedFloor: metaDetection.floor,
      reason: metaReason,
      source: metaDetection.source,
    };
  }
  const detection = detectHistoryMutation(chat, currentGraph.historyState);

  if (detection.dirty) {
    clearInjectionState();
    markHistoryDirty(
      currentGraph,
      detection.earliestAffectedFloor,
      detection.reason || trigger,
      "hash-recheck",
    );
    saveGraphToChat({ reason: "history-dirty-hash-recheck" });
    notifyHistoryDirty(detection.earliestAffectedFloor, detection.reason);
    return {
      ...detection,
      source: "hash-recheck",
    };
  }

  if (trigger === "message-edited" || trigger === "message-swiped") {
    clearInjectionState();
  }

  return detection;
}

async function purgeCurrentVectorCollection(signal = undefined) {
  if (!currentGraph?.vectorIndexState?.collectionId) return;

  const response = await fetchLocalWithTimeout("/api/vector/purge", {
    method: "POST",
    headers: getRequestHeaders(),
    signal,
    body: JSON.stringify({
      collectionId: currentGraph.vectorIndexState.collectionId,
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function prepareVectorStateForReplay(
  fullReset = false,
  signal = undefined,
  { skipBackendPurge = false } = {},
) {
  ensureCurrentGraphRuntimeState();
  const config = getEmbeddingConfig();

  if (isBackendVectorConfig(config)) {
    if (!skipBackendPurge) {
      try {
        await purgeCurrentVectorCollection(signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        console.warn("[ST-BME] 清理后端向量索引失败，继续本地恢复:", error);
      }
      currentGraph.vectorIndexState.hashToNodeId = {};
      currentGraph.vectorIndexState.nodeToHash = {};
    }
    currentGraph.vectorIndexState.dirty = true;
    if (!currentGraph.vectorIndexState.dirtyReason) {
      currentGraph.vectorIndexState.dirtyReason = skipBackendPurge
        ? "history-recovery-replay"
        : "history-recovery-reset";
    }
    if (fullReset) {
      currentGraph.vectorIndexState.replayRequiredNodeIds = [];
      currentGraph.vectorIndexState.pendingRepairFromFloor = 0;
    }
    currentGraph.vectorIndexState.lastWarning = skipBackendPurge
      ? "历史恢复后需要修复受影响后缀的后端向量索引"
      : "历史恢复后需要重建后端向量索引";
    return;
  }

  if (fullReset) {
    currentGraph.vectorIndexState.hashToNodeId = {};
    currentGraph.vectorIndexState.nodeToHash = {};
    currentGraph.vectorIndexState.replayRequiredNodeIds = [];
    currentGraph.vectorIndexState.dirty = true;
    currentGraph.vectorIndexState.dirtyReason = "history-recovery-reset";
    currentGraph.vectorIndexState.pendingRepairFromFloor = 0;
    currentGraph.vectorIndexState.lastWarning =
      "历史恢复后需要重嵌当前聊天向量";
  }
}

async function executeExtractionBatch({
  chat,
  startIdx,
  endIdx,
  settings,
  smartTriggerDecision = null,
  signal = undefined,
} = {}) {
  return await executeExtractionBatchController(
    {
      appendBatchJournal,
      applyProcessedHistorySnapshotToGraph,
      buildExtractionMessages,
      cloneGraphSnapshot,
      computePostProcessArtifacts,
      console,
      createBatchJournalEntry,
      createBatchStatusSkeleton,
      ensureCurrentGraphRuntimeState,
      extractMemories,
      finalizeBatchStatus,
      getCurrentGraph: () => currentGraph,
      getEmbeddingConfig,
      getExtractionCount: () => extractionCount,
      getLastProcessedAssistantFloor,
      getSchema,
      handleExtractionSuccess,
      persistExtractionBatchResult,
      setBatchStageOutcome,
      setLastExtractionStatus,
      shouldAdvanceProcessedHistory,
      throwIfAborted,
      updateProcessedHistorySnapshot,
    },
    { chat, startIdx, endIdx, settings, smartTriggerDecision, signal },
  );
}

async function replayExtractionFromHistory(
  chat,
  settings,
  signal = undefined,
  expectedChatId = undefined,
) {
  let replayedBatches = 0;

  while (true) {
    throwIfAborted(signal, "历史恢复已终止");
    assertRecoveryChatStillActive(expectedChatId, "replay-loop");
    const pendingAssistantTurns = getAssistantTurns(chat).filter(
      (index) => index > getLastProcessedAssistantFloor(),
    );
    if (pendingAssistantTurns.length === 0) break;

    const extractEvery = clampInt(settings.extractEvery, 1, 1, 50);
    const batchAssistantTurns = pendingAssistantTurns.slice(0, extractEvery);
    const startIdx = batchAssistantTurns[0];
    const endIdx = batchAssistantTurns[batchAssistantTurns.length - 1];

    const batchResult = await executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
      signal,
    });

    if (!batchResult.success) {
      throw new Error(
        batchResult.error ||
          batchResult?.result?.error ||
          "历史恢复回放过程中出现提取失败",
      );
    }

    replayedBatches++;
  }

  return replayedBatches;
}

function applyRecoveryPlanToVectorState(
  recoveryPlan,
  dirtyFallbackFloor = null,
) {
  ensureCurrentGraphRuntimeState();
  const vectorState = currentGraph.vectorIndexState;
  const replayRequiredNodeIds = new Set(
    Array.isArray(vectorState.replayRequiredNodeIds)
      ? vectorState.replayRequiredNodeIds.filter(Boolean)
      : [],
  );

  for (const nodeId of recoveryPlan?.replayRequiredNodeIds || []) {
    if (nodeId) replayRequiredNodeIds.add(nodeId);
  }

  const fallbackFloor = Number.isFinite(dirtyFallbackFloor)
    ? dirtyFallbackFloor
    : currentGraph.historyState?.historyDirtyFrom;
  const pendingRepairFromFloor = Number.isFinite(
    recoveryPlan?.pendingRepairFromFloor,
  )
    ? recoveryPlan.pendingRepairFromFloor
    : Number.isFinite(fallbackFloor)
      ? fallbackFloor
      : null;

  vectorState.replayRequiredNodeIds = [...replayRequiredNodeIds];
  vectorState.dirty = true;
  vectorState.dirtyReason =
    recoveryPlan?.dirtyReason ||
    vectorState.dirtyReason ||
    "history-recovery-replay";
  vectorState.pendingRepairFromFloor = pendingRepairFromFloor;
  vectorState.lastIntegrityIssue =
    recoveryPlan?.valid === false
      ? {
          scope: "history-recovery-plan",
          reason: String(recoveryPlan.invalidReason || "invalid-recovery-plan"),
          dirtyFallbackFloor: Number.isFinite(fallbackFloor)
            ? fallbackFloor
            : null,
          pendingRepairFromFloor,
          at: Date.now(),
        }
      : null;
  vectorState.lastWarning = recoveryPlan?.legacyGapFallback
    ? "历史恢复检测到 legacy-gap，向量索引需按受影响后缀修复"
    : "历史恢复后需要修复受影响后缀的向量索引";
}

async function rollbackGraphForReroll(targetFloor, context = getContext()) {
  ensureCurrentGraphRuntimeState();
  const chatId = getCurrentChatId(context);
  const buildRerollFailure = (
    recoveryPath,
    error,
    { resultCode = "reroll.rollback.failed", affectedBatchCount = 0 } = {},
  ) => ({
    success: false,
    rollbackPerformed: false,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor: null,
    recoveryPath,
    affectedBatchCount,
    resultCode,
    error,
  });
  const recoveryPoint = findJournalRecoveryPoint(currentGraph, targetFloor);

  if (!recoveryPoint) {
    return buildRerollFailure(
      "unavailable",
      "未找到可用的回滚点，无法安全重新提取。请先执行一次历史恢复或重新提取更早的批次。",
      {
        resultCode: "reroll.rollback.unavailable",
      },
    );
  }

  clearInjectionState();
  lastExtractedItems = [];

  const config = getEmbeddingConfig();
  const recoveryPath = recoveryPoint.path || "unknown";
  const affectedBatchCount = recoveryPoint.affectedBatchCount || 0;

  if (recoveryPath === "reverse-journal") {
    const recoveryPlan = buildReverseJournalRecoveryPlan(
      recoveryPoint.affectedJournals,
      targetFloor,
    );
    if (recoveryPlan?.valid === false) {
      const invalidReason = String(
        recoveryPlan.invalidReason || "unknown",
      ).trim();
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "reroll-rollback-rejected",
        {
          fromFloor: targetFloor,
          effectiveFromFloor: null,
          path: "reverse-journal",
          affectedBatchCount,
          detectionSource: "manual-reroll",
          reason: `回滚计划完整性校验失败: ${invalidReason}`,
          debugReason: `reroll-rollback-plan-invalid:${invalidReason}`,
          resultCode: "reroll.rollback.plan-invalid",
          invalidReason,
        },
      );
      saveGraphToChat({ reason: "reroll-rollback-rejected" });
      refreshPanelLiveState();
      return buildRerollFailure(
        "reverse-journal-rejected",
        `回滚计划完整性校验失败: ${invalidReason}`,
        {
          affectedBatchCount,
          resultCode: "reroll.rollback.plan-invalid",
        },
      );
    }
    rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
    currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
    extractionCount = currentGraph.historyState.extractionCount || 0;
    applyRecoveryPlanToVectorState(recoveryPlan, targetFloor);

    if (
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      assertRecoveryChatStillActive(chatId, "reroll-pre-vector");
      await deleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
      );
    }

    assertRecoveryChatStillActive(chatId, "reroll-pre-prepare");
    await prepareVectorStateForReplay(false, undefined, {
      skipBackendPurge: isBackendVectorConfig(config),
    });
  } else if (recoveryPath === "legacy-snapshot") {
    currentGraph = normalizeGraphRuntimeState(
      recoveryPoint.snapshotBefore,
      chatId,
    );
    extractionCount = currentGraph.historyState.extractionCount || 0;
    await prepareVectorStateForReplay(false);
  } else {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "reroll-rollback-rejected",
      {
        fromFloor: targetFloor,
        effectiveFromFloor: null,
        path: recoveryPath,
        affectedBatchCount,
        detectionSource: "manual-reroll",
        reason: `不支持的回滚路径: ${recoveryPath}`,
        debugReason: `reroll-rollback-unsupported:${recoveryPath}`,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
    saveGraphToChat({ reason: "reroll-rollback-rejected" });
    refreshPanelLiveState();
    return buildRerollFailure(
      recoveryPath,
      `不支持的回滚路径: ${recoveryPath}`,
      {
        affectedBatchCount,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
  }

  const effectiveFromFloor = Number.isFinite(
    currentGraph.historyState?.lastProcessedAssistantFloor,
  )
    ? currentGraph.historyState.lastProcessedAssistantFloor + 1
    : 0;

  clearHistoryDirty(
    currentGraph,
    buildRecoveryResult("reroll-rollback", {
      fromFloor: targetFloor,
      effectiveFromFloor,
      path: recoveryPath,
      affectedBatchCount,
      detectionSource: "manual-reroll",
      reason: "manual-reroll",
      resultCode: "reroll.rollback.applied",
    }),
  );
  if (
    Array.isArray(context?.chat) &&
    Number.isFinite(currentGraph.historyState?.lastProcessedAssistantFloor) &&
    currentGraph.historyState.lastProcessedAssistantFloor >= 0
  ) {
    // Preserve the rolled-back prefix immediately so a failed follow-up
    // re-extraction does not look like a generic "missing processed hashes"
    // corruption on the next history integrity check.
    updateProcessedHistorySnapshot(
      context.chat,
      currentGraph.historyState.lastProcessedAssistantFloor,
    );
  }
  pruneProcessedMessageHashesFromFloor(currentGraph, effectiveFromFloor);
  currentGraph.lastProcessedSeq =
    currentGraph.historyState?.lastProcessedAssistantFloor ?? -1;
  currentGraph.vectorIndexState.lastIntegrityIssue = null;
  saveGraphToChat({ reason: "reroll-rollback-complete" });
  refreshPanelLiveState();

  return {
    success: true,
    rollbackPerformed: true,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor,
    recoveryPath,
    affectedBatchCount,
    resultCode: "reroll.rollback.applied",
    error: "",
  };
}

async function recoverHistoryIfNeeded(trigger = "history-recovery") {
  if (!currentGraph || isRecoveringHistory) {
    return !isRecoveringHistory;
  }

  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) return true;

  const detection = inspectHistoryMutation(trigger);
  const dirtyFrom = currentGraph?.historyState?.historyDirtyFrom;
  if (!detection.dirty && !Number.isFinite(dirtyFrom)) {
    return true;
  }
  if (isRestoreLockActive()) {
    return false;
  }

  enterRestoreLock("history-recovery", trigger);
  isRecoveringHistory = true;
  clearInjectionState();

  const chatId = getCurrentChatId(context);
  const settings = getSettings();
  const initialDirtyFromRaw = Number.isFinite(dirtyFrom)
    ? dirtyFrom
    : detection.earliestAffectedFloor;
  const initialDirtyFrom = clampRecoveryStartFloor(chat, initialDirtyFromRaw);
  let replayedBatches = 0;
  let usedFullRebuild = false;
  let recoveryPath = "full-rebuild";
  let affectedBatchCount = 0;
  const historyController = beginStageAbortController("history");
  const historySignal = historyController.signal;

  updateStageNotice(
    "history",
    "历史恢复中",
    Number.isFinite(initialDirtyFrom)
      ? `受影响起点楼层 ${initialDirtyFrom} · 正在回滚并重放`
      : "正在回滚并重放受影响后缀",
    "running",
    {
      persist: true,
      busy: true,
    },
  );

  try {
    throwIfAborted(historySignal, "历史恢复已终止");
    const recoveryPoint = findJournalRecoveryPoint(
      currentGraph,
      initialDirtyFrom,
    );
    if (recoveryPoint?.path === "reverse-journal") {
      recoveryPath = "reverse-journal";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      const config = getEmbeddingConfig();
      const recoveryPlan = buildReverseJournalRecoveryPlan(
        recoveryPoint.affectedJournals,
        initialDirtyFrom,
      );
      if (recoveryPlan?.valid === false) {
        throw new Error(
          `reverse-journal recovery plan invalid: ${
            recoveryPlan.invalidReason || "unknown"
          }`,
        );
      }
      rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
      currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
      extractionCount = currentGraph.historyState.extractionCount || 0;
      applyRecoveryPlanToVectorState(recoveryPlan, initialDirtyFrom);

      if (
        isBackendVectorConfig(config) &&
        recoveryPlan.backendDeleteHashes.length > 0
      ) {
        assertRecoveryChatStillActive(chatId, "pre-backend-delete");
        await deleteBackendVectorHashesForRecovery(
          currentGraph.vectorIndexState.collectionId,
          config,
          recoveryPlan.backendDeleteHashes,
          historySignal,
        );
      }
      await prepareVectorStateForReplay(false, historySignal, {
        skipBackendPurge: isBackendVectorConfig(config),
      });
    } else if (recoveryPoint?.path === "legacy-snapshot") {
      recoveryPath = "legacy-snapshot";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      currentGraph = normalizeGraphRuntimeState(
        recoveryPoint.snapshotBefore,
        chatId,
      );
      extractionCount = currentGraph.historyState.extractionCount || 0;
      await prepareVectorStateForReplay(false, historySignal);
    } else {
      recoveryPath = "full-rebuild";
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      usedFullRebuild = true;
      extractionCount = 0;
      await prepareVectorStateForReplay(true, historySignal);
    }

    assertRecoveryChatStillActive(chatId, "pre-replay");
    replayedBatches = await replayExtractionFromHistory(
      chat,
      settings,
      historySignal,
      chatId,
    );

    clearHistoryDirty(
      currentGraph,
      buildRecoveryResult(usedFullRebuild ? "full-rebuild" : "replayed", {
        fromFloor: initialDirtyFrom,
        batches: replayedBatches,
        path: recoveryPath,
        detectionSource:
          detection.source ||
          currentGraph?.historyState?.lastMutationSource ||
          "hash-recheck",
        affectedBatchCount,
        replayedBatchCount: replayedBatches,
        reason:
          detection.reason ||
          currentGraph?.historyState?.lastMutationReason ||
          trigger,
      }),
    );
    const recoveredLastProcessedFloor = Number.isFinite(
      currentGraph?.historyState?.lastProcessedAssistantFloor,
    )
      ? currentGraph.historyState.lastProcessedAssistantFloor
      : -1;
    if (recoveredLastProcessedFloor >= 0) {
      // Recovery replay has rebuilt the graph state; restore processed hashes so
      // the next hash recheck does not immediately trigger another replay loop.
      updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
    }
    saveGraphToChat({ reason: "history-recovery-complete" });
    refreshPanelLiveState();
    settleExtractionStatusAfterHistoryRecovery(
      "提取完成",
      `历史恢复回放 ${replayedBatches} 批`,
      "success",
    );
    updateStageNotice(
      "history",
      usedFullRebuild ? "历史恢复完成（全量重建）" : "历史恢复完成",
      `path ${recoveryPath} · 起点楼层 ${initialDirtyFrom} · 受影响 ${affectedBatchCount} 批 · 回放 ${replayedBatches} 批`,
      usedFullRebuild ? "warning" : "success",
      {
        busy: false,
        persist: false,
      },
    );

    toastr.success(
      usedFullRebuild
        ? "历史变化已触发全量重建"
        : "历史变化已完成受影响后缀恢复",
    );
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("aborted", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: error?.message || "已手动终止当前恢复流程",
          debugReason: `history-recovery-aborted:${recoveryPath}`,
          resultCode: "history.recovery.aborted",
        }),
      );
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      currentGraph.vectorIndexState.lastWarning = "";
      currentGraph.vectorIndexState.pendingRepairFromFloor = null;
      currentGraph.vectorIndexState.replayRequiredNodeIds = [];
      currentGraph.vectorIndexState.dirty = false;
      currentGraph.vectorIndexState.dirtyReason = "";
      settleExtractionStatusAfterHistoryRecovery(
        "提取已终止",
        error?.message || "历史恢复已终止",
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已终止",
        error?.message || "已手动终止当前恢复流程",
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      saveGraphToChat({ reason: "history-recovery-aborted" });
      return false;
    }
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      extractionCount = 0;
      await prepareVectorStateForReplay(true, historySignal);
      assertRecoveryChatStillActive(chatId, "pre-fallback-replay");
      replayedBatches = await replayExtractionFromHistory(
        chat,
        settings,
        historySignal,
        chatId,
      );
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("full-rebuild", {
          fromFloor: 0,
          batches: replayedBatches,
          path: "full-rebuild",
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: `恢复失败后兜底全量重建: ${error?.message || error}`,
          debugReason: `history-recovery-fallback-full-rebuild:${recoveryPath}`,
          resultCode: "history.recovery.fallback-full-rebuild",
        }),
      );
      const recoveredLastProcessedFloor = Number.isFinite(
        currentGraph?.historyState?.lastProcessedAssistantFloor,
      )
        ? currentGraph.historyState.lastProcessedAssistantFloor
        : -1;
      if (recoveredLastProcessedFloor >= 0) {
        updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
      }
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      saveGraphToChat({ reason: "history-recovery-fallback-rebuild" });
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取完成",
        `历史恢复已退化为全量重建，回放 ${replayedBatches} 批`,
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已退化为全量重建",
        `path full-rebuild · 起点楼层 ${initialDirtyFrom} · 回放 ${replayedBatches} 批`,
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.warning("历史恢复已退化为全量重建");
      return true;
    } catch (fallbackError) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "failed",
        {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: String(fallbackError),
          debugReason: `history-recovery-failed:${recoveryPath}`,
          resultCode: "history.recovery.failed",
        },
      );
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      saveGraphToChat({ reason: "history-recovery-failed" });
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取失败",
        fallbackError?.message || String(fallbackError),
        "error",
      );
      updateStageNotice(
        "history",
        "历史恢复失败",
        fallbackError?.message || String(fallbackError),
        "error",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.error(`历史恢复失败: ${fallbackError?.message || fallbackError}`);
      return false;
    }
  } finally {
    finishStageAbortController("history", historyController);
    leaveRestoreLock("history-recovery");
    isRecoveringHistory = false;
    const enqueueMicrotask =
      typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
        : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      if (typeof maybeResumePendingAutoExtraction === "function") {
        void maybeResumePendingAutoExtraction("history-recovery-finished");
      }
    });
  }
}

function settleExtractionStatusAfterHistoryRecovery(
  text = "提取完成",
  meta = "",
  level = "success",
) {
  const statusSnapshot =
    typeof lastExtractionStatus === "object" && lastExtractionStatus
      ? lastExtractionStatus
      : null;
  if (!statusSnapshot || typeof setLastExtractionStatus !== "function") {
    return;
  }

  const currentText = String(statusSnapshot.text || "");
  const currentLevel = String(statusSnapshot.level || "");
  if (currentText !== "AI 生成中" && currentLevel !== "running") {
    return;
  }
  setLastExtractionStatus(text, meta, level, {
    syncRuntime: true,
    toastKind: "",
  });
}

/**
 * 提取管线：处理未提取的对话楼层
 */
async function runExtraction() {
  const options =
    arguments.length > 0 &&
    arguments[0] &&
    typeof arguments[0] === "object" &&
    !Array.isArray(arguments[0])
      ? arguments[0]
      : {};
  return await runExtractionController({
    beginStageAbortController,
    clampInt,
    console,
    deferAutoExtraction,
    ensureCurrentGraphRuntimeState,
    ensureGraphMutationReady,
    executeExtractionBatch,
    finishStageAbortController,
    getAssistantTurns,
    getContext,
    getCurrentGraph: () => currentGraph,
    getGraphPersistenceState: () => graphPersistenceState,
    getGraphMutationBlockReason,
    getIsExtracting: () => isExtracting,
    getIsRecoveringHistory: () => isRecoveringHistory,
    getLastProcessedAssistantFloor,
    getSettings,
    getSmartTriggerDecision,
    isAbortError,
    notifyExtractionIssue,
    recoverHistoryIfNeeded,
    resolveAutoExtractionPlan,
    retryPendingGraphPersist,
    setIsExtracting: (value) => {
      isExtracting = value;
    },
    setLastExtractionStatus,
  }, options);
}

function applyRecallInjection(settings, recallInput, recentMessages, result) {
  return applyRecallInjectionController(
    settings,
    recallInput,
    recentMessages,
    result,
    {
      persistRecallInjectionRecord,
      applyModuleInjectionPrompt,
      console,
      estimateTokens,
      formatInjection,
      getLastRecallFallbackNoticeAt: () => lastRecallFallbackNoticeAt,
      getRecallHookLabel,
      getSchema,
      recordInjectionSnapshot,
      saveGraphToChat,
      setCurrentGraphLastRecallResult: (selectedNodeIds) => {
        currentGraph.lastRecallResult = selectedNodeIds;
      },
      setLastInjectionContent: (value) => {
        lastInjectionContent = value;
      },
      setLastRecallFallbackNoticeAt: (value) => {
        lastRecallFallbackNoticeAt = value;
      },
      setLastRecallStatus,
      toastr,
      updateLastRecalledItems,
    },
  );
}

function buildRecallRetrieveOptions(settings, context) {
  return {
    topK: settings.recallTopK,
    maxRecallNodes: settings.recallMaxNodes,
    enableLLMRecall: settings.recallEnableLLM,
    enableVectorPrefilter: settings.recallEnableVectorPrefilter,
    enableGraphDiffusion: settings.recallEnableGraphDiffusion,
    diffusionTopK: settings.recallDiffusionTopK,
    llmCandidatePool: settings.recallLlmCandidatePool,
    recallPrompt: undefined,
    weights: {
      graphWeight: settings.graphWeight,
      vectorWeight: settings.vectorWeight,
      importanceWeight: settings.importanceWeight,
    },
    // v2 options
    enableVisibility: settings.enableVisibility ?? false,
    visibilityFilter: context.name2 || null,
    enableCrossRecall: settings.enableCrossRecall ?? false,
    enableProbRecall: settings.enableProbRecall ?? false,
    probRecallChance: settings.probRecallChance ?? 0.15,
    enableMultiIntent: settings.recallEnableMultiIntent ?? true,
    multiIntentMaxSegments: settings.recallMultiIntentMaxSegments ?? 4,
    enableContextQueryBlend: settings.recallEnableContextQueryBlend ?? true,
    contextAssistantWeight: settings.recallContextAssistantWeight ?? 0.2,
    contextPreviousUserWeight:
      settings.recallContextPreviousUserWeight ?? 0.1,
    enableLexicalBoost: settings.recallEnableLexicalBoost ?? true,
    lexicalWeight: settings.recallLexicalWeight ?? 0.18,
    teleportAlpha: settings.recallTeleportAlpha ?? 0.15,
    enableTemporalLinks: settings.recallEnableTemporalLinks ?? true,
    temporalLinkStrength: settings.recallTemporalLinkStrength ?? 0.2,
    enableDiversitySampling: settings.recallEnableDiversitySampling ?? true,
    dppCandidateMultiplier: settings.recallDppCandidateMultiplier ?? 3,
    dppQualityWeight: settings.recallDppQualityWeight ?? 1.0,
    enableCooccurrenceBoost: settings.recallEnableCooccurrenceBoost ?? false,
    cooccurrenceScale: settings.recallCooccurrenceScale ?? 0.1,
    cooccurrenceMaxNeighbors: settings.recallCooccurrenceMaxNeighbors ?? 10,
    enableResidualRecall: settings.recallEnableResidualRecall ?? false,
    residualBasisMaxNodes: settings.recallResidualBasisMaxNodes ?? 24,
    residualNmfTopics: settings.recallNmfTopics ?? 15,
    residualNmfNoveltyThreshold: settings.recallNmfNoveltyThreshold ?? 0.4,
    residualThreshold: settings.recallResidualThreshold ?? 0.3,
    residualTopK: settings.recallResidualTopK ?? 5,
    enableScopedMemory: settings.enableScopedMemory ?? true,
    enablePovMemory: settings.enablePovMemory ?? true,
    enableRegionScopedObjective:
      settings.enableRegionScopedObjective ?? true,
    enableCognitiveMemory: settings.enableCognitiveMemory ?? true,
    enableSpatialAdjacency: settings.enableSpatialAdjacency ?? true,
    enableStoryTimeline: settings.enableStoryTimeline ?? true,
    injectStoryTimeLabel: settings.injectStoryTimeLabel ?? true,
    storyTimeSoftDirecting: settings.storyTimeSoftDirecting ?? true,
    recallCharacterPovWeight: settings.recallCharacterPovWeight ?? 1.25,
    recallUserPovWeight: settings.recallUserPovWeight ?? 1.05,
    recallObjectiveCurrentRegionWeight:
      settings.recallObjectiveCurrentRegionWeight ?? 1.15,
    recallObjectiveAdjacentRegionWeight:
      settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
    recallObjectiveGlobalWeight:
      settings.recallObjectiveGlobalWeight ?? 0.75,
    injectUserPovMemory: settings.injectUserPovMemory ?? true,
    injectObjectiveGlobalMemory:
      settings.injectObjectiveGlobalMemory ?? true,
    injectLowConfidenceObjectiveMemory:
      settings.injectLowConfidenceObjectiveMemory ?? false,
    activeRegion:
      currentGraph?.historyState?.activeRegion ||
      currentGraph?.historyState?.lastExtractedRegion ||
      "",
    activeStorySegmentId:
      currentGraph?.historyState?.activeStorySegmentId || "",
    activeStoryTimeLabel:
      currentGraph?.historyState?.activeStoryTimeLabel || "",
    activeCharacterPovOwner:
      currentGraph?.historyState?.activeCharacterPovOwner || "",
    activeUserPovOwner:
      currentGraph?.historyState?.activeUserPovOwner ||
      context.name1 ||
      "",
  };
}

async function runPlannerRecallForEna({
  rawUserInput,
  signal = undefined,
  disableLlmRecall = false,
} = {}) {
  const userMessage = normalizeRecallInputText(rawUserInput || "");
  const trivialInputResult = isTrivialUserInput(userMessage);
  if (trivialInputResult.trivial) {
    console.info?.(
      `[ST-BME] trivial-input skip: reason=${trivialInputResult.reason} len=${trivialInputResult.normalizedText.length} hook=ena-planner`,
    );
    return {
      ok: false,
      reason: `trivial-user-input:${trivialInputResult.reason}`,
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  const settings = getSettings();
  if (!settings.enabled || !settings.recallEnabled) {
    return {
      ok: false,
      reason: "recall-disabled",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError("Ena Planner recall aborted");
  }

  if (!currentGraph || !isGraphReadableForRecall()) {
    return {
      ok: false,
      reason: "graph-not-readable",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (
    !Array.isArray(currentGraph.nodes) ||
    currentGraph.nodes.length === 0
  ) {
    return {
      ok: false,
      reason: "graph-empty",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (isGraphMetadataWriteAllowed()) {
    const recovered = await recoverHistoryIfNeeded("pre-ena-planner-recall");
    if (!recovered) {
      return {
        ok: false,
        reason: "history-recovery-not-ready",
        memoryBlock: "",
        recentMessages: [],
        result: null,
      };
    }
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError("Ena Planner recall aborted");
  }

  await ensureVectorReadyIfNeeded("pre-ena-planner-recall", signal);

  const context = getContext();
  const chat = context?.chat ?? [];
  const recentMessages = buildRecallRecentMessages(
    chat,
    clampInt(settings.recallLlmContextMessages, 4, 0, 20),
    userMessage,
  );
  const schema = getSchema();
  const baseOptions = buildRecallRetrieveOptions(settings, context);
  const options = {
    ...baseOptions,
    enableLLMRecall: disableLlmRecall
      ? false
      : baseOptions.enableLLMRecall,
  };

  const result = await retrieve({
    graph: currentGraph,
    userMessage,
    recentMessages,
    embeddingConfig: getEmbeddingConfig(),
    schema,
    settings,
    signal,
    options,
  });
  const memoryBlock = formatInjection(result, schema).trim();

  return {
    ok: Boolean(memoryBlock),
    reason: memoryBlock ? "completed" : "empty-memory-block",
    memoryBlock,
    recentMessages,
    result,
  };
}

/**
 * 召回管线：检索并注入记忆
 */
async function runRecall(options = {}) {
  if (!options?.ignoreRestoreLock && isRestoreLockActive()) {
    const message = getRestoreLockMessage("召回");
    setLastRecallStatus("召回已暂停", message, "warning", {
      syncRuntime: true,
    });
    return createRecallRunResult("skipped", {
      reason: "restore-lock-active",
      restoreLock: cloneRuntimeDebugValue(
        normalizeRestoreLockState(graphPersistenceState.restoreLock),
        null,
      ),
    });
  }
  return await runRecallController(
    {
      abortRecallStageWithReason,
      applyRecallInjection,
      beginStageAbortController,
      buildRecallRetrieveOptions,
      clampInt,
      console,
      consumePlannerRecallHandoff,
      createAbortError,
      createRecallInputRecord,
      createRecallRunResult,
      ensureVectorReadyIfNeeded,
      finishStageAbortController,
      getActiveRecallPromise: () => activeRecallPromise,
      getContext,
      getCurrentGraph: () => currentGraph,
      getEmbeddingConfig,
      getGraphMutationBlockReason,
      getIsRecalling: () => isRecalling,
      getRecallHookLabel,
      getSchema,
      getSettings,
      isAbortError,
      isGraphMetadataWriteAllowed,
      isGraphReadable,
      isGraphReadableForRecall,
      nextRecallRunSequence: () => ++recallRunSequence,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      resolveRecallInput,
      retrieve,
      setActiveRecallPromise: (value) => {
        activeRecallPromise = value;
      },
      setIsRecalling: (value) => {
        isRecalling = value;
      },
      setLastRecallStatus,
      setPendingRecallSendIntent: (value) => {
        pendingRecallSendIntent = value;
      },
      toastr,
      waitForActiveRecallToSettle,
    },
    options,
  );
}

// ==================== 事件钩子 ====================

function onChatChanged() {
  isHostGenerationRunning = false;
  lastHostGenerationEndedAt = 0;
  if (typeof clearMessageHideState === "function") {
    clearMessageHideState("chat-changed");
  }
  const result = onChatChangedController({
    abortAllRunningStages,
    clearCoreEventBindingState,
    clearGenerationRecallTransactionsForChat,
    clearInjectionState,
    clearPendingAutoExtraction,
    clearPendingGraphLoadRetry,
    clearPendingHistoryMutationChecks,
    clearCurrentGenerationTrivialSkip,
    clearRecallInputTracking,
    clearTimeout,
    dismissAllStageNotices,
    getPendingHistoryRecoveryTimer: () => pendingHistoryRecoveryTimer,
    installSendIntentHooks,
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    setLastPreGenerationRecallAt: (value) => {
      lastPreGenerationRecallAt = value;
    },
    setLastPreGenerationRecallKey: (value) => {
      lastPreGenerationRecallKey = value;
    },
    setPendingHistoryRecoveryTimer: (value) => {
      pendingHistoryRecoveryTimer = value;
    },
    setPendingHistoryRecoveryTrigger: (value) => {
      pendingHistoryRecoveryTrigger = value;
    },
    setSkipBeforeCombineRecallUntil: (value) => {
      skipBeforeCombineRecallUntil = value;
    },
    syncGraphLoadFromLiveContext,
  });

  scheduleBmeIndexedDbTask(async () => {
    const syncResult = await syncBmeChatManagerWithCurrentChat("chat-changed");
    if (syncResult?.chatId) {
      await runBmeAutoSyncForChat("chat-changed", syncResult.chatId);
      await loadGraphFromIndexedDb(syncResult.chatId, {
        source: "chat-changed",
        allowOverride: true,
        applyEmptyState: true,
      });
    }
  });

  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("chat-changed", 220);
  }

  return result;
}

function onChatLoaded() {
  const result = onChatLoadedController({
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    syncGraphLoadFromLiveContext,
  });

  scheduleBmeIndexedDbTask(async () => {
    const syncResult = await syncBmeChatManagerWithCurrentChat("chat-loaded");
    if (syncResult?.chatId) {
      await runBmeAutoSyncForChat("chat-loaded", syncResult.chatId);
      await loadGraphFromIndexedDb(syncResult.chatId, {
        source: "chat-loaded",
        allowOverride: true,
        applyEmptyState: true,
      });
    }
  });

  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("chat-loaded", 180);
  }

  return result;
}

function onMessageSent(messageId) {
  const result = onMessageSentController(
    {
      getContext,
      isTrivialUserInput,
      recordRecallSentUserMessage,
      rebindRecallRecordToNewUserMessage,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-sent", 40);
  }
  return result;
}

function onUserMessageRendered(messageId = null) {
  return onUserMessageRenderedController(
    {
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
  );
}

function onCharacterMessageRendered(messageId = null, type = "") {
  const result = onCharacterMessageRenderedController(
    {
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
    type,
  );
  void maybeResumePendingAutoExtraction("character-message-rendered");
  return result;
}

function onMessageDeleted(chatLengthOrMessageId, meta = null) {
  const result = onMessageDeletedController(
    {
      invalidateRecallAfterHistoryMutation,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleHistoryMutationRecheck,
    },
    chatLengthOrMessageId,
    meta,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-deleted", 80);
  }
  return result;
}

function onMessageEdited(messageId, meta = null) {
  const result = onMessageEditedController(
    {
      invalidateRecallAfterHistoryMutation,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleHistoryMutationRecheck,
    },
    messageId,
    meta,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-edited", 80);
  }
  return result;
}

async function onMessageSwiped(messageId, meta = null) {
  const result = await onMessageSwipedController(
    {
      invalidateRecallAfterHistoryMutation,
      onReroll,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleHistoryMutationRecheck,
    },
    messageId,
    meta,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-swiped", 80);
  }
  return result;
}

function onGenerationStarted(type, params = {}, dryRun = false) {
  const generationType = String(type || "normal").trim() || "normal";
  if (
    !dryRun &&
    !params?.automatic_trigger &&
    !params?.quiet_prompt &&
    generationType === "normal"
  ) {
    isHostGenerationRunning = true;
    lastHostGenerationEndedAt = 0;
  }
  return onGenerationStartedController(
    {
      clearDryRunPromptPreview,
      clearCurrentGenerationTrivialSkip,
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      freezeHostGenerationInputSnapshot,
      getContext,
      getPendingRecallSendIntent: () => pendingRecallSendIntent,
      getSendTextareaValue,
      isFreshRecallInputRecord,
      isTrivialUserInput,
      markDryRunPromptPreview,
      markCurrentGenerationTrivialSkip,
      normalizeRecallInputText,
    },
    type,
    params,
    dryRun,
  );
}

function onGenerationEnded(_chatLength = null) {
  isHostGenerationRunning = false;
  lastHostGenerationEndedAt = Date.now();
  const recentTransaction = findRecentGenerationRecallTransactionForChat();
  const recentRecallResult =
    getGenerationRecallTransactionResult(recentTransaction);
  ensurePersistedRecallRecordForGeneration({
    generationType: recentTransaction?.generationType || "normal",
    recallResult: recentRecallResult,
    transaction: recentTransaction,
    recallOptions: recentTransaction?.frozenRecallOptions || null,
    hookName:
      recentRecallResult?.hookName ||
      recentTransaction?.lastRecallMeta?.hookName ||
      "",
  });
  schedulePersistedRecallMessageUiRefresh(320);
  void maybeResumePendingAutoExtraction("generation-ended");
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("generation-ended", 180);
  }
}

async function onGenerationAfterCommands(type, params = {}, dryRun = false) {
  return await onGenerationAfterCommandsController(
    {
      applyFinalRecallInjectionForGeneration,
      buildGenerationAfterCommandsRecallInput,
      clearLiveRecallInjectionPromptForRewrite,
      consumeHostGenerationInputSnapshot,
      createGenerationRecallContext,
      ensurePersistedRecallRecordForGeneration,
      getContext,
      getGenerationRecallHookStateFromResult,
      getGenerationRecallTransactionResult,
      markGenerationRecallTransactionHookState,
      resolveGenerationRecallDeliveryMode,
      runRecall,
      storeGenerationRecallTransactionResult,
    },
    type,
    params,
    dryRun,
  );
}

async function onBeforeCombinePrompts(promptData = null) {
  return await onBeforeCombinePromptsController(
    {
      applyFinalRecallInjectionForGeneration,
      buildHistoryGenerationRecallInput,
      buildNormalGenerationRecallInput,
      clearLiveRecallInjectionPromptForRewrite,
      consumeDryRunPromptPreview,
      consumeHostGenerationInputSnapshot,
      createGenerationRecallContext,
      getContext,
      getGenerationRecallHookStateFromResult,
      getGenerationRecallTransactionResult,
      markGenerationRecallTransactionHookState,
      resolveGenerationRecallDeliveryMode,
      runRecall,
      storeGenerationRecallTransactionResult,
    },
    promptData,
  );
}

function onMessageReceived(messageId = null, type = "") {
  const result = onMessageReceivedController({
    console,
    consumeCurrentGenerationTrivialSkip,
    createRecallInputRecord,
    deferAutoExtraction,
    getContext,
    getCurrentGraph: () => currentGraph,
    getGraphPersistenceState: () => graphPersistenceState,
    getIsHostGenerationRunning: () => isHostGenerationRunning,
    getLastProcessedAssistantFloor,
    getPendingHostGenerationInputSnapshot,
    getPendingRecallSendIntent: () => pendingRecallSendIntent,
    getSettings,
    isAssistantChatMessage,
    isFreshRecallInputRecord,
    isGraphMetadataWriteAllowed,
    syncGraphLoadFromLiveContext,
    maybeCaptureGraphShadowSnapshot,
    maybeFlushQueuedGraphPersist,
    notifyExtractionIssue,
    queueMicrotask,
    resolveAutoExtractionPlan,
    runExtraction,
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    setPendingHostGenerationInputSnapshot: (record) => {
      pendingHostGenerationInputSnapshot = record;
    },
    setPendingRecallSendIntent: (record) => {
      pendingRecallSendIntent = record;
    },
  }, messageId, type);

  const hideSettings =
    typeof getMessageHideSettings === "function"
      ? getMessageHideSettings()
      : null;
  if (
    hideSettings?.enabled &&
    hideSettings?.hide_last_n > 0 &&
    typeof runIncrementalMessageHide === "function"
  ) {
    void runIncrementalMessageHide("message-received");
  }

  return result;
}

// ==================== UI 操作 ====================

async function onViewGraph() {
  return await onViewGraphController({
    getCurrentGraph: () => currentGraph,
    getGraphStats,
    toastr,
  });
}

async function onRebuild() {
  return await runWithRestoreLock(
    "manual-rebuild",
    "manual-rebuild",
    async () =>
      await onRebuildController({
        buildRecoveryResult,
        clearHistoryDirty,
        clearInjectionState,
        cloneGraphSnapshot,
        confirm: (message) => {
          if (typeof globalThis.confirm === "function") {
            return globalThis.confirm(message);
          }
          return false;
        },
        createEmptyGraph,
        ensureGraphMutationReady: (operationLabel, options = {}) =>
          ensureGraphMutationReady(operationLabel, {
            ...(options || {}),
            ignoreRestoreLock: true,
          }),
        getContext,
        getCurrentChatId,
        getCurrentGraph: () => currentGraph,
        getSettings,
        normalizeGraphRuntimeState,
        prepareVectorStateForReplay,
        refreshPanelLiveState,
        replayExtractionFromHistory,
        restoreRuntimeUiState,
        saveGraphToChat,
        updateProcessedHistorySnapshot,
        setCurrentGraph: (graph) => {
          currentGraph = graph;
        },
        setLastExtractionStatus,
        setRuntimeStatus,
        snapshotRuntimeUiState,
        toastr,
      }),
  );
}

async function onManualCompress() {
  return await onManualCompressController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    compressAll,
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getEmbeddingConfig,
    getSchema,
    getSettings,
    inspectCompressionCandidates: inspectAutoCompressionCandidates,
    refreshPanelLiveState,
    recordMaintenanceAction,
    recordGraphMutation,
    setRuntimeStatus,
    toastr,
  });
}

function onSavePanelGraphNode(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  const updates = payload.updates;
  if (!nodeId || !updates || typeof updates !== "object" || !currentGraph) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }
  const updated = updateNode(currentGraph, nodeId, updates);
  if (!updated) {
    return { ok: false, error: "update-failed" };
  }
  const persist = saveGraphToChat({ reason: "panel-node-edit" });
  return {
    ok: true,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onDeletePanelGraphNode(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  if (!nodeId || !currentGraph) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }
  const removed = removeNode(currentGraph, nodeId);
  if (!removed) {
    return { ok: false, error: "delete-failed" };
  }
  const persist = saveGraphToChat({ reason: "panel-node-delete" });
  return {
    ok: true,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onApplyPanelKnowledgeOverride(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  const ownerKey = String(payload.ownerKey || "");
  const ownerType = String(payload.ownerType || "");
  const ownerName = String(payload.ownerName || "");
  const mode = String(payload.mode || "").trim();

  if (!currentGraph || !nodeId || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("认知覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  if (!["known", "hidden", "mistaken"].includes(mode)) {
    return { ok: false, error: "invalid-mode" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }

  const result = applyManualKnowledgeOverride(currentGraph, {
    ownerKey,
    ownerType,
    ownerName,
    nodeId,
    mode,
  });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "override-failed" };
  }

  const persist = saveGraphToChat({ reason: `panel-knowledge-${mode}` });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || ownerKey,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onClearPanelKnowledgeOverride(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  const ownerKey = String(payload.ownerKey || "");
  const ownerType = String(payload.ownerType || "");
  const ownerName = String(payload.ownerName || "");

  if (!currentGraph || !nodeId || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("认知覆盖清理", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }

  const result = clearManualKnowledgeOverride(currentGraph, {
    ownerKey,
    ownerType,
    ownerName,
    nodeId,
  });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "clear-override-failed" };
  }

  const persist = saveGraphToChat({ reason: "panel-knowledge-clear" });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || ownerKey,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onSetPanelActiveRegion(payload = {}) {
  const region = String(payload.region || "").trim();
  if (!currentGraph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("地区覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = setManualActiveRegion(currentGraph, region);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "set-region-failed" };
  }

  const persist = saveGraphToChat({
    reason: region ? "panel-region-set" : "panel-region-clear",
  });
  refreshPanelLiveState();
  return {
    ok: true,
    activeRegion: result.activeRegion || "",
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onSetPanelActiveStoryTime(payload = {}) {
  const label = String(payload.label || "").trim();
  if (!currentGraph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("剧情时间覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  const result = setManualActiveStorySegment(currentGraph, { label });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "set-story-time-failed" };
  }
  const persist = saveGraphToChat({
    reason: label ? "panel-story-time-set" : "panel-story-time-clear",
  });
  refreshPanelLiveState();
  return {
    ok: true,
    activeStorySegmentId: result.activeStorySegmentId || "",
    activeStoryTimeLabel: result.activeStoryTimeLabel || "",
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onClearPanelActiveStoryTime() {
  if (!currentGraph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("剧情时间覆盖清理", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  const result = clearManualActiveStorySegment(currentGraph);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "clear-story-time-failed" };
  }
  const persist = saveGraphToChat({ reason: "panel-story-time-clear" });
  refreshPanelLiveState();
  return {
    ok: true,
    activeStorySegmentId: result.activeStorySegmentId || "",
    activeStoryTimeLabel: result.activeStoryTimeLabel || "",
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onUpdatePanelRegionAdjacency(payload = {}) {
  const fallbackRegion =
    currentGraph?.historyState?.activeRegion ||
    currentGraph?.regionState?.manualActiveRegion ||
    "";
  const region = String(payload.region || fallbackRegion).trim();
  const adjacent = Array.isArray(payload.adjacent)
    ? payload.adjacent
    : String(payload.adjacent || "")
        .split(/[,\n，]/)
        .map((value) => String(value || "").trim())
        .filter(Boolean);

  if (!currentGraph || !region) {
    return { ok: false, error: "missing-region" };
  }
  if (!ensureGraphMutationReady("地区邻接编辑", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = updateRegionAdjacencyManual(currentGraph, region, adjacent);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "update-adjacency-failed" };
  }

  const persist = saveGraphToChat({ reason: "panel-region-adjacency" });
  refreshPanelLiveState();
  return {
    ok: true,
    region,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

async function onExportGraph() {
  return await onExportGraphController({
    document,
    exportGraph,
    getCurrentGraph: () => currentGraph,
    toastr,
  });
}

async function onImportGraph() {
  return await runWithRestoreLock(
    "graph-import",
    "graph-import",
    async () =>
      await onImportGraphController({
        clearInjectionState,
        clearTimeout,
        document,
        ensureGraphMutationReady: (operationLabel, options = {}) =>
          ensureGraphMutationReady(operationLabel, {
            ...(options || {}),
            ignoreRestoreLock: true,
          }),
        getAssistantTurns,
        getContext,
        getCurrentChatId,
        importGraph,
        markVectorStateDirty,
        normalizeGraphRuntimeState,
        rebindProcessedHistoryStateToChat,
        saveGraphToChat,
        setCurrentGraph: (graph) => {
          currentGraph = graph;
        },
        setExtractionCount: (value) => {
          extractionCount = value;
        },
        setLastExtractedItems: (items) => {
          lastExtractedItems = items;
        },
        toastr,
        updateLastRecalledItems,
        window,
      }),
  );
}

async function onViewLastInjection() {
  return await onViewLastInjectionController({
    document,
    getLastInjectionContent: () => lastInjectionContent,
    toastr,
  });
}

async function onTestEmbedding() {
  return await onTestEmbeddingController({
    getCurrentChatId,
    getEmbeddingConfig,
    testVectorConnection,
    toastr,
    validateVectorConfig,
  });
}

async function onTestMemoryLLM() {
  return await onTestMemoryLLMController({
    testLLMConnection,
    toastr,
  });
}

async function onFetchMemoryLLMModels() {
  return await onFetchMemoryLLMModelsController({
    fetchMemoryLLMModels,
    toastr,
  });
}

async function onFetchEmbeddingModels(mode = null) {
  return await onFetchEmbeddingModelsController(
    {
      fetchAvailableEmbeddingModels,
      getEmbeddingConfig,
      toastr,
      validateVectorConfig,
    },
    mode,
  );
}

async function onManualExtract(options = {}) {
  return await onManualExtractController(
    {
      beginStageAbortController,
      clampInt,
      console,
      createEmptyGraph,
      ensureGraphMutationReady,
      executeExtractionBatch,
      finishStageAbortController,
      getAssistantTurns,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => currentGraph,
      getGraphPersistenceState: () => graphPersistenceState,
      getIsExtracting: () => isExtracting,
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      normalizeGraphRuntimeState,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      retryPendingGraphPersist,
      setCurrentGraph: (graph) => {
        currentGraph = graph;
      },
      setIsExtracting: (value) => {
        isExtracting = value;
      },
      setLastExtractionStatus,
      toastr,
    },
    options,
  );
}

async function onExtractionTask(options = {}) {
  return await onExtractionTaskController(
    {
      beginStageAbortController,
      clampInt,
      console,
      createEmptyGraph,
      ensureGraphMutationReady,
      executeExtractionBatch,
      finishStageAbortController,
      getAssistantTurns,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => currentGraph,
      getGraphMutationBlockReason,
      getGraphPersistenceState: () => graphPersistenceState,
      getIsExtracting: () => isExtracting,
      getLastExtractionStatusLevel: () => lastExtractionStatus?.level || "idle",
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      normalizeGraphRuntimeState,
      onManualExtract,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      retryPendingGraphPersist,
      rollbackGraphForReroll,
      setCurrentGraph: (graph) => {
        currentGraph = graph;
      },
      setIsExtracting: (value) => {
        isExtracting = value;
      },
      setLastExtractionStatus,
      setRuntimeStatus,
      toastr,
    },
    options,
  );
}

async function onReroll({ fromFloor } = {}) {
  return await onRerollController(
    {
      console,
      ensureGraphMutationReady,
      getAssistantTurns,
      getContext,
      getCurrentGraph: () => currentGraph,
      getGraphMutationBlockReason,
      getGraphPersistenceState: () => graphPersistenceState,
      getIsExtracting: () => isExtracting,
      getLastExtractionStatusLevel: () => lastExtractionStatus?.level || "idle",
      getLastProcessedAssistantFloor,
      isAbortError,
      onManualExtract,
      refreshPanelLiveState,
      rollbackGraphForReroll,
      setRuntimeStatus,
      toastr,
    },
    { fromFloor },
  );
}

async function onManualSleep() {
  return await onManualSleepController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getSettings,
    refreshPanelLiveState,
    recordMaintenanceAction,
    recordGraphMutation,
    setRuntimeStatus,
    sleepCycle,
    toastr,
  });
}

async function onManualSynopsis() {
  return await onManualSynopsisController({
    ensureGraphMutationReady,
    generateSmallSummary,
    getCurrentChatSeq,
    getCurrentGraph: () => currentGraph,
    getContext,
    getSettings,
    refreshPanelLiveState,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
  });
}

async function onManualSummaryRollup() {
  return await onManualSummaryRollupController({
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getSettings,
    refreshPanelLiveState,
    rollupSummaryFrontier,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
  });
}

async function onRebuildSummaryState(options = {}) {
  return await runWithRestoreLock(
    "summary-rebuild",
    "summary-rebuild",
    async () =>
      await onRebuildSummaryStateController(
        {
          ensureGraphMutationReady: (operationLabel, nextOptions = {}) =>
            ensureGraphMutationReady(operationLabel, {
              ...(nextOptions || {}),
              ignoreRestoreLock: true,
            }),
          getContext,
          getCurrentGraph: () => currentGraph,
          getSettings,
          rebuildHierarchicalSummaryState,
          refreshPanelLiveState,
          saveGraphToChat,
          setRuntimeStatus,
          toastr,
        },
        options,
      ),
  );
}

async function onClearSummaryState() {
  return await onClearSummaryStateController({
    confirm: (msg) => (typeof globalThis.confirm === "function" ? globalThis.confirm(msg) : false),
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    refreshPanelLiveState,
    resetHierarchicalSummaryState,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
  });
}

async function onManualEvolve() {
  return await onManualEvolveController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    consolidateMemories,
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getEmbeddingConfig,
    getLastExtractedItems: () => lastExtractedItems,
    getSettings,
    refreshPanelLiveState,
    recordMaintenanceAction,
    recordGraphMutation,
    setRuntimeStatus,
    toastr,
    validateVectorConfig,
  });
}

async function onUndoLastMaintenance() {
  return await onUndoLastMaintenanceController({
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    markVectorStateDirty,
    refreshPanelLiveState,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
    undoLastMaintenance: undoLastMaintenanceAction,
  });
}

async function onRebuildVectorIndex(range = null) {
  return await onRebuildVectorIndexController(
    {
      beginStageAbortController,
      ensureCurrentGraphRuntimeState,
      ensureGraphMutationReady,
      finishStageAbortController,
      getEmbeddingConfig,
      isBackendVectorConfig,
      refreshPanelLiveState,
      saveGraphToChat,
      syncVectorState,
      toastr,
      validateVectorConfig,
    },
    range,
  );
}

async function onReembedDirect() {
  return await onReembedDirectController({
    getEmbeddingConfig,
    isDirectVectorConfig,
    onRebuildVectorIndex: async () => await onRebuildVectorIndex(),
    toastr,
  });
}

// ==================== 数据清理 ====================

const _cleanupRuntime = () => ({
  confirm: (msg) => (typeof globalThis.confirm === "function" ? globalThis.confirm(msg) : false),
  prompt: (msg) => (typeof globalThis.prompt === "function" ? globalThis.prompt(msg) : null),
  createEmptyGraph,
  clearInjectionState,
  ensureGraphMutationReady,
  getCurrentChatId,
  getCurrentGraph: () => currentGraph,
  markVectorStateDirty: (reason) => {
    if (currentGraph?.vectorIndexState) {
      currentGraph.vectorIndexState.dirty = true;
      currentGraph.vectorIndexState.dirtyReason = reason;
    }
  },
  normalizeGraphRuntimeState,
  refreshPanelLiveState,
  removeNode: (graph, nodeId) => removeNode(graph, nodeId),
  saveGraphToChat,
  setCurrentGraph: (graph) => { currentGraph = graph; },
  setExtractionCount: (count) => {
    if (currentGraph?.historyState) {
      currentGraph.historyState.extractionCount = count;
    }
  },
  setLastExtractedItems: () => { lastExtractedItems = []; },
  buildBmeDbName,
  buildRestoreSafetyDbName: (chatId) =>
    buildBmeDbName(buildRestoreSafetyChatId(chatId)),
  closeBmeDb: null,
  deleteRemoteSyncFile: (chatId) => deleteRemoteSyncFile(chatId, {
    fetch: globalThis.fetch?.bind(globalThis),
    getRequestHeaders: typeof getRequestHeaders === "function" ? getRequestHeaders : undefined,
  }),
  toastr,
});

async function onClearGraph() {
  return await onClearGraphController(_cleanupRuntime());
}

async function onClearGraphRange(startSeq, endSeq) {
  return await onClearGraphRangeController(_cleanupRuntime(), startSeq, endSeq);
}

async function onClearVectorCache() {
  return await onClearVectorCacheController(_cleanupRuntime());
}

async function onClearBatchJournal() {
  return await onClearBatchJournalController(_cleanupRuntime());
}

async function onDeleteCurrentIdb() {
  return await onDeleteCurrentIdbController(_cleanupRuntime());
}

async function onDeleteAllIdb() {
  return await onDeleteAllIdbController(_cleanupRuntime());
}

async function onDeleteServerSyncFile() {
  return await onDeleteServerSyncFileController(_cleanupRuntime());
}

async function onBackupCurrentChatToCloud() {
  const chatId = getCurrentChatId();
  if (!chatId) {
    toastr.warning("当前没有聊天上下文");
    return { handledToast: true };
  }

  const result = await backupToServer(
    chatId,
    buildBmeSyncRuntimeOptions({
      reason: "manual-backup",
      trigger: "panel:manual-backup",
    }),
  );

  if (!result?.backedUp) {
    const backupFailureMessage =
      result?.reason === "backup-manifest-error"
        ? result?.backupUploaded
          ? "备份文件已上传，但服务器备份清单更新失败，请稍后重试"
          : "服务器备份清单更新失败，请稍后重试"
        : `备份失败: ${result?.error?.message || result?.reason || "未知原因"}`;
    toastr.error(backupFailureMessage);
    return { handledToast: true, result };
  }

  toastr.success("当前聊天已备份到云端");
  await syncIndexedDbMetaToPersistenceState(chatId, {
    syncState: "idle",
    lastSyncError: "",
  });
  return { handledToast: true, result };
}

async function onRestoreCurrentChatFromCloud() {
  return await runWithRestoreLock(
    "cloud-restore",
    "manual-restore",
    async () => {
      const chatId = getCurrentChatId();
      if (!chatId) {
        toastr.warning("当前没有聊天上下鏂?");
        return { handledToast: true };
      }

      const confirmed = globalThis.confirm?.(
        "这会用云端备份完整覆盖当前聊天的本地记忆，并先保留一份本地安全快照。确定继续吗锛?,
      );
      if (!confirmed) {
        return { cancelled: true };
      }

      const result = await restoreFromServer(
        chatId,
        buildBmeSyncRuntimeOptions({
          reason: "manual-restore",
          trigger: "panel:manual-restore",
        }),
      );

      if (!result?.restored) {
        const reasonMap = {
          "not-found": "服务器上没有找到当前聊天的备浠?,
          "backup-missing": "服务器上没有找到当前聊天的备浠?,
          "backup-version-mismatch": "备份版本与当前运行时不兼瀹?,
          "backup-chat-id-mismatch": "备份聊天 ID 与当前聊天不匹配",
          "snapshot-chat-id-mismatch": "备份内部快照与当前聊天不匹配",
        };
        toastr.error(
          reasonMap[result?.reason] ||
            `恢复失败: ${result?.error?.message || result?.reason || "未知原因"}`,
        );
        return { handledToast: true, result };
      }

      toastr.success("已从云端恢复当前聊天备份");
      await syncIndexedDbMetaToPersistenceState(chatId, {
        syncState: "idle",
        lastSyncError: "",
      });
      return { handledToast: true, result };
    },
  );
}

async function onManageServerBackups() {
  const chatId = getCurrentChatId();
  const { entries } = await listServerBackups(
    buildBmeSyncRuntimeOptions({
      reason: "manage-backups",
      trigger: "panel:manage-backups",
    }),
  );
  return {
    entries: Array.isArray(entries) ? entries : [],
    currentChatId: chatId,
    handledToast: true,
    skipDashboardRefresh: true,
  };
}

async function onDeleteServerBackupEntry(payload = {}) {
  const chatId = String(payload?.chatId || "").trim();
  const filename = String(payload?.filename || "").trim();
  const serverPath = String(payload?.serverPath || "").trim();
  if (!chatId) {
    return {
      deleted: false,
      reason: "missing-chat-id",
      filename,
      handledToast: true,
      skipDashboardRefresh: true,
    };
  }

  const deleteResult = await deleteServerBackup(
    chatId,
    buildBmeSyncRuntimeOptions({
      reason: "delete-backup",
      trigger: "panel:delete-backup",
      filename,
      serverPath,
    }),
  );

  const currentChatId = getCurrentChatId();
  if (
    deleteResult?.deleted &&
    currentChatId &&
    normalizeChatIdCandidate(currentChatId) ===
      normalizeChatIdCandidate(chatId)
  ) {
    await syncIndexedDbMetaToPersistenceState(chatId, {
      syncState: "idle",
      lastSyncError: "",
    });
  }

  return {
    ...deleteResult,
    filename: deleteResult?.filename || filename,
    handledToast: true,
    skipDashboardRefresh: true,
  };
}

// ==================== 初始�?====================

async function onGetRestoreSafetySnapshotStatus() {
  const chatId = getCurrentChatId();
  if (!chatId) {
    return {
      exists: false,
      chatId: "",
      createdAt: 0,
      reason: "missing-chat-id",
    };
  }

  return await getRestoreSafetySnapshotStatus(
    chatId,
    buildBmeSyncRuntimeOptions({
      reason: "manual-restore-safety-status",
      trigger: "panel:restore-safety-status",
    }),
  );
}

async function onRollbackLastRestore() {
  return await runWithRestoreLock(
    "restore-rollback",
    "manual-restore-rollback",
    async () => {
      const chatId = getCurrentChatId();
      if (!chatId) {
        toastr.warning("当前没有聊天上下鏂?");
        return { handledToast: true };
      }

      const safetyStatus = await onGetRestoreSafetySnapshotStatus();
      if (!safetyStatus?.exists) {
        toastr.info("当前聊天还没有可用的上次恢复回滚鐐?");
        return { handledToast: true, result: safetyStatus };
      }

      const confirmed = globalThis.confirm?.(
        "这会回滚到上次从云端恢复之前的本地状态。确定继续吗锛?,
      );
      if (!confirmed) {
        return { cancelled: true };
      }

      const result = await rollbackFromRestoreSafetySnapshot(
        chatId,
        buildBmeSyncRuntimeOptions({
          reason: "manual-restore-safety-rollback",
          trigger: "panel:rollback-last-restore",
        }),
      );

      if (!result?.restored) {
        toastr.error(
          `回滚失败: ${result?.error?.message || result?.reason || "未知原因"}`,
        );
        return { handledToast: true, result };
      }

      toastr.success("已回滚到上次恢复前的本地状鎬?");
      await syncIndexedDbMetaToPersistenceState(chatId, {
        syncState: "idle",
        lastSyncError: "",
      });
      return { handledToast: true, result };
    },
  );
}

async function onRetryPendingPersist() {
  const hadPending = graphPersistenceState.pendingPersist === true;
  const result = await retryPendingGraphPersist({
    reason: "panel-manual-persist-retry",
    scheduleRetryOnFailure: false,
    ignoreRestoreLock: true,
  });
  refreshPanelLiveState();

  if (result?.accepted === true) {
    toastr.success("最近一批持久化已确认");
    return { handledToast: true, result };
  }

  if (!hadPending && String(result?.reason || "") === "no-pending-persist") {
    toastr.info("当前没有待确认的持久化批次");
    return { handledToast: true, result };
  }

  toastr.warning(
    `持久化仍未确认: ${result?.reason || result?.loadState || "未知原因"}`,
  );
  return { handledToast: true, result };
}

async function onProbeGraphLoad() {
  const result = syncGraphLoadFromLiveContext({
    source: "panel-manual-graph-probe",
    force: true,
  });
  refreshPanelLiveState();

  if (graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING) {
    toastr.info("已重新探测当前聊天图谱，正在等待本地持久化加载");
    return { handledToast: true, result };
  }

  if (graphPersistenceState.loadState === GRAPH_LOAD_STATES.BLOCKED) {
    toastr.warning(
      `当前图谱仍处于保护模式: ${graphPersistenceState.reason || "metadata not ready"}`,
    );
    return { handledToast: true, result };
  }

  toastr.success("已重新探测当前聊天图谱");
  return { handledToast: true, result };
}
(async function init() {
  await loadServerSettings();
  syncGraphPersistenceDebugState();

  await initializePanelBridgeController({
    $,
    actions: {
      syncGraphLoad: () =>
        syncGraphLoadFromLiveContext({
          source: "panel-open-sync",
        }),
      extractTask: onExtractionTask,
      extract: onManualExtract,
      compress: onManualCompress,
      sleep: onManualSleep,
      synopsis: onManualSynopsis,
      summaryRollup: onManualSummaryRollup,
      rebuildSummaryState: onRebuildSummaryState,
      clearSummaryState: onClearSummaryState,
      retryPendingPersist: onRetryPendingPersist,
      probeGraphLoad: onProbeGraphLoad,
      export: onExportGraph,
      import: onImportGraph,
      rebuild: onRebuild,
      evolve: onManualEvolve,
      undoMaintenance: onUndoLastMaintenance,
      testEmbedding: onTestEmbedding,
      testMemoryLLM: onTestMemoryLLM,
      fetchMemoryLLMModels: onFetchMemoryLLMModels,
      fetchEmbeddingModels: onFetchEmbeddingModels,
      inspectTaskRegexReuse: (taskType) =>
        inspectTaskRegexReuse(getSettings(), taskType),
      applyCurrentHide: () => applyMessageHideNow("panel-manual-apply"),
      clearCurrentHide: () => clearAllHiddenMessages("panel-manual-clear"),
      saveGraphNode: onSavePanelGraphNode,
      deleteGraphNode: onDeletePanelGraphNode,
      applyKnowledgeOverride: onApplyPanelKnowledgeOverride,
      clearKnowledgeOverride: onClearPanelKnowledgeOverride,
      setActiveRegion: onSetPanelActiveRegion,
      setActiveStoryTime: onSetPanelActiveStoryTime,
      clearActiveStoryTime: onClearPanelActiveStoryTime,
      updateRegionAdjacency: onUpdatePanelRegionAdjacency,
      rebuildVectorIndex: () => onRebuildVectorIndex(),
      rebuildVectorRange: (range) => onRebuildVectorIndex(range),
      reembedDirect: onReembedDirect,
      reroll: onReroll,
      clearGraph: onClearGraph,
      clearGraphRange: (startSeq, endSeq) => onClearGraphRange(startSeq, endSeq),
      clearVectorCache: onClearVectorCache,
      clearBatchJournal: onClearBatchJournal,
      deleteCurrentIdb: onDeleteCurrentIdb,
      deleteAllIdb: onDeleteAllIdb,
      deleteServerSyncFile: onDeleteServerSyncFile,
      backupToCloud: onBackupCurrentChatToCloud,
      restoreFromCloud: onRestoreCurrentChatFromCloud,
      rollbackLastRestore: onRollbackLastRestore,
      manageServerBackups: onManageServerBackups,
      deleteServerBackupEntry: onDeleteServerBackupEntry,
      getRestoreSafetyStatus: onGetRestoreSafetySnapshotStatus,
    },
    console,
    document,
    getGraph: () => currentGraph,
    getGraphPersistenceState: () => getGraphPersistenceLiveState(),
    getLastBatchStatus: () =>
      currentGraph?.historyState?.lastBatchStatus || null,
    getLastExtract: () => lastExtractedItems,
    getLastExtractionStatus: () => lastExtractionStatus,
    getLastInjection: () => lastInjectionContent,
    getLastRecall: () => lastRecalledItems,
    getLastRecallStatus: () => lastRecallStatus,
    getLastVectorStatus: () => lastVectorStatus,
    getPanelModule: () => _panelModule,
    getRuntimeDebugSnapshot: (options = {}) =>
      getPanelRuntimeDebugSnapshot(options),
    getRuntimeStatus: () => getPanelRuntimeStatus(),
    getSettings,
    getThemesModule: () => _themesModule,
    importPanelModule: async () => await import("./ui/panel.js"),
    importThemesModule: async () => await import("./ui/themes.js"),
    setPanelModule: (module) => {
      _panelModule = module;
    },
    setThemesModule: (module) => {
      _themesModule = module;
    },
    updateSettings: updateModuleSettings,
  });

  try {
    ensureBmeChatManager();
    scheduleBmeIndexedDbWarmup("init");
    initializeHostCapabilityBridge();
    installSendIntentHooks();
    autoSyncOnVisibility(buildBmeSyncRuntimeOptions());
    scheduleMessageHideApply("init", 180);

    // 注册事件钩子
    registerCoreEventHooksController({
      console,
      eventSource,
      eventTypes: event_types,
      getCoreEventBindingState,
      handlers: {
        onBeforeCombinePrompts,
        onCharacterMessageRendered,
        onChatChanged,
        onChatLoaded,
        onGenerationAfterCommands,
        onGenerationEnded,
        onGenerationStarted,
        onMessageDeleted,
        onMessageEdited,
        onMessageReceived,
        onMessageSent,
        onMessageSwiped,
        onUserMessageRendered,
      },
      registerBeforeCombinePrompts,
      registerGenerationAfterCommands,
      setCoreEventBindingState,
    });

    // 加载当前聊天的图�?
    scheduleBmeIndexedDbTask(async () => {
      const syncResult = await syncBmeChatManagerWithCurrentChat("initial-load");
      if (!syncResult?.chatId) {
        syncGraphLoadFromLiveContext({
          source: "initial-load:no-chat",
          force: true,
        });
        return;
      }
      await runBmeAutoSyncForChat("initial-load", syncResult.chatId);
      await loadGraphFromIndexedDb(syncResult.chatId, {
        source: "initial-load",
        allowOverride: true,
        applyEmptyState: true,
      });
    });
  } catch (bootError) {
    console.error("[ST-BME] 核心初始化阶段失败（面板入口已保留）:", bootError);
  }

  schedulePersistedRecallMessageUiRefresh(120);
  try {
    const { initEnaPlanner } = await import("./ena-planner/ena-planner.js");
    await initEnaPlanner({
      getContext,
      getExtensionPath: () => `scripts/extensions/third-party/${MODULE_NAME}`,
      getPlannerRecallTimeoutMs,
      isTrivialUserInput,
      preparePlannerRecallHandoff,
      runPlannerRecallForEna,
    });
    debugLog("[ST-BME] Ena Planner module loaded");
  } catch (error) {
    console.warn("[ST-BME] Ena Planner module load failed:", error);
  }
  debugLog("[ST-BME] 初始化完成");
})();


