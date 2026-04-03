// ST-BME: 主入口
// 事件钩子、设置管理、流程调度

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

import { BmeChatManager } from "./bme-chat-manager.js";
import {
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
  ensureDexieLoaded,
} from "./bme-db.js";
import {
  autoSyncOnChatChange,
  autoSyncOnVisibility,
  scheduleUpload,
  syncNow,
} from "./bme-sync.js";
import {
  buildExtractionMessages,
  clampRecoveryStartFloor,
  getAssistantTurns,
  isAssistantChatMessage,
  isSystemMessageForExtraction,
  pruneProcessedMessageHashesFromFloor,
  resolveDirtyFloorFromMutationMeta,
  rollbackAffectedJournals,
} from "./chat-history.js";
import { compressAll, sleepCycle } from "./compressor.js";
import { consolidateMemories } from "./consolidator.js";
import {
  installSendIntentHooksController,
  onBeforeCombinePromptsController,
  onChatChangedController,
  onChatLoadedController,
  onGenerationAfterCommandsController,
  onGenerationStartedController,
  onMessageDeletedController,
  onMessageEditedController,
  onMessageReceivedController,
  onMessageSentController,
  onMessageSwipedController,
  registerBeforeCombinePromptsController,
  registerCoreEventHooksController,
  registerGenerationAfterCommandsController,
  scheduleSendIntentHookRetryController,
} from "./event-binding.js";
import {
  executeExtractionBatchController,
  onManualExtractController,
  onRerollController,
  runExtractionController,
} from "./extraction-controller.js";
import {
  extractMemories,
  generateReflection,
  generateSynopsis,
} from "./extractor.js";
import {
  GRAPH_LOAD_PENDING_CHAT_ID,
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_STARTUP_RECONCILE_DELAYS_MS,
  MODULE_NAME,
  cloneGraphForPersistence,
  cloneRuntimeDebugValue,
  getGraphPersistedRevision,
  removeGraphShadowSnapshot,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphShadowSnapshot,
} from "./graph-persistence.js";
import {
  applyHideSettings,
  getHideStateSnapshot,
  resetHideState,
  runIncrementalHideCheck,
  scheduleHideSettingsApply,
  unhideAll,
} from "./hide-engine.js";
import {
  createEmptyGraph,
  deserializeGraph,
  exportGraph,
  getGraphStats,
  getNode,
  importGraph,
} from "./graph.js";
import {
  HOST_ADAPTER_STATE_SEMANTICS,
  getHostAdapter,
  getHostCapabilitySnapshot,
  initializeHostAdapter,
  readHostCapability,
  refreshHostCapabilitySnapshot,
} from "./host-adapter/index.js";
import { estimateTokens, formatInjection } from "./injector.js";
import { fetchMemoryLLMModels, testLLMConnection } from "./llm.js";
import { getNodeDisplayName } from "./node-labels.js";
import { showManagedBmeNotice } from "./notice.js";
import {
  createNoticePanelActionController,
  initializePanelBridgeController,
  refreshPanelLiveStateController,
} from "./panel-bridge.js";
import {
  createDefaultTaskProfiles,
  migrateLegacyTaskProfiles,
} from "./prompt-profiles.js";
import {
  applyRecallInjectionController,
  buildRecallRecentMessagesController,
  getRecallUserMessageSourceLabelController,
  resolveRecallInputController,
  runRecallController,
} from "./recall-controller.js";
import {
  createRecallCardElement,
  openRecallSidebar,
  updateRecallCardData,
} from "./recall-message-ui.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  markPersistedRecallManualEdit,
  readPersistedRecallFromUserMessage,
  removePersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  resolveGenerationTargetUserMessageIndex,
  writePersistedRecallToUserMessage,
} from "./recall-persistence.js";
import { resolveConfiguredTimeoutMs } from "./request-timeout.js";
import { retrieve } from "./retriever.js";
import {
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
  snapshotProcessedMessageHashes,
  undoLatestMaintenance,
} from "./runtime-state.js";
import { DEFAULT_NODE_SCHEMA, validateSchema } from "./schema.js";
import {
  onExportGraphController,
  onFetchEmbeddingModelsController,
  onFetchMemoryLLMModelsController,
  onImportGraphController,
  onManualCompressController,
  onManualEvolveController,
  onManualSleepController,
  onManualSynopsisController,
  onUndoLastMaintenanceController,
  onRebuildController,
  onRebuildVectorIndexController,
  onReembedDirectController,
  onTestEmbeddingController,
  onTestMemoryLLMController,
  onViewGraphController,
  onViewLastInjectionController,
} from "./ui-actions-controller.js";
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
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  pushBatchStageArtifact,
  setBatchStageOutcome,
  shouldRunRecallForTransaction,
} from "./ui-status.js";
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
} from "./vector-index.js";

// 操控面板模块（动态加载，防止加载失败崩溃整个扩展）
let _panelModule = null;
let _themesModule = null;

const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";
const SERVER_SETTINGS_URL = `/user/files/${SERVER_SETTINGS_FILENAME}`;

function getChatMetadataIntegrity(context = getContext()) {
  return normalizeChatIdCandidate(context?.chatMetadata?.integrity);
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
      maintenance: state.maintenance,
      graphPersistence: state.graphPersistence,
      updatedAt: state.updatedAt,
    },
    {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      maintenance: {
        lastAction: null,
        lastUndoResult: null,
      },
      graphPersistence: null,
      updatedAt: "",
    },
  );
}

// ==================== 默认设置 ====================

const defaultSettings = {
  enabled: true,
  timeoutMs: 300000,
  hideOldMessagesEnabled: false,
  hideOldMessagesKeepLastN: 12,

  // 提取设置
  extractEvery: 1, // 每 N 条 assistant 回复提取一次
  extractContextTurns: 2, // 提取时包含的上下文楼层数

  // 召回设置
  recallEnabled: true,
  recallCardUserInputDisplayMode: "beautify_only",
  recallTopK: 20, // 向量预筛 Top-K
  recallMaxNodes: 8, // LLM 召回最大节点数
  recallEnableLLM: true, // 是否启用 LLM 精确召回
  recallEnableVectorPrefilter: true, // 是否启用向量预筛
  recallEnableGraphDiffusion: true, // 是否启用图扩散
  recallDiffusionTopK: 100, // 图扩散阶段保留的候选上限
  recallLlmCandidatePool: 30, // 传给 LLM 精排的候选池大小
  recallLlmContextMessages: 4, // 传给 LLM 精排的最近非系统消息数
  recallEnableMultiIntent: true,
  recallMultiIntentMaxSegments: 4,
  recallEnableContextQueryBlend: true,
  recallContextAssistantWeight: 0.2,
  recallContextPreviousUserWeight: 0.1,
  recallEnableLexicalBoost: true,
  recallLexicalWeight: 0.18,
  recallTeleportAlpha: 0.15,
  recallEnableTemporalLinks: true,
  recallTemporalLinkStrength: 0.2,
  recallEnableDiversitySampling: true,
  recallDppCandidateMultiplier: 3,
  recallDppQualityWeight: 1.0,
  recallEnableCooccurrenceBoost: false,
  recallCooccurrenceScale: 0.1,
  recallCooccurrenceMaxNeighbors: 10,
  recallEnableResidualRecall: false,
  recallResidualBasisMaxNodes: 24,
  recallNmfTopics: 15,
  recallNmfNoveltyThreshold: 0.4,
  recallResidualThreshold: 0.3,
  recallResidualTopK: 5,
  enableScopedMemory: true,
  enablePovMemory: true,
  enableRegionScopedObjective: true,
  recallCharacterPovWeight: 1.25,
  recallUserPovWeight: 1.05,
  recallObjectiveCurrentRegionWeight: 1.15,
  recallObjectiveAdjacentRegionWeight: 0.9,
  recallObjectiveGlobalWeight: 0.75,
  injectUserPovMemory: true,
  injectObjectiveGlobalMemory: true,

  // 注入设置
  injectPosition: "atDepth", // 注入位置
  injectDepth: 9999, // IN_CHAT@Depth 注入深度，数值越大越靠前
  injectRole: 0, // 0=system, 1=user, 2=assistant

  // 混合评分权重
  graphWeight: 0.6,
  vectorWeight: 0.3,
  importanceWeight: 0.1,

  // 记忆 LLM（留空时复用当前酒馆模型）
  llmApiUrl: "",
  llmApiKey: "",
  llmModel: "",

  // Embedding API 配置
  embeddingApiUrl: "",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",
  embeddingTransportMode: "direct",
  embeddingBackendSource: "openai",
  embeddingBackendModel: "text-embedding-3-small",
  embeddingBackendApiUrl: "",
  embeddingAutoSuffix: true,

  // Schema
  nodeTypeSchema: null, // null 表示使用默认

  // 自定义提示词
  extractPrompt: "",
  recallPrompt: "",
  consolidationPrompt: "",
  compressPrompt: "",
  synopsisPrompt: "",
  reflectionPrompt: "",
  taskProfilesVersion: 3,
  taskProfiles: createDefaultTaskProfiles(),

  // ====== v2 增强设置 ======

  // ③ 记忆整合（合并精确对照 + 记忆进化）
  enableConsolidation: true, // 启用记忆整合
  consolidationNeighborCount: 5, // 近邻搜索数量
  consolidationThreshold: 0.85, // 冲突判定相似度阈值

  // ⑨ 全局故事概要
  enableSynopsis: true, // 启用全局概要
  synopsisEveryN: 5, // 每 N 次提取后更新概要

  // ⑥ 认知边界过滤（P1）
  enableVisibility: true, // 启用认知边界
  // ⑦ 双记忆交叉检索（P1）
  enableCrossRecall: true, // 启用交叉检索

  // ① 惊奇度分割（P2）
  enableSmartTrigger: false, // 启用惊奇度分割
  triggerPatterns: "", // 自定义触发正则
  smartTriggerThreshold: 2, // 轻量触发阈值

  // ⑤ 主动遗忘（P2）
  enableSleepCycle: false, // 启用主动遗忘
  forgetThreshold: 0.5, // 保留价值阈值
  sleepEveryN: 10, // 每 N 次提取后执行

  // ⑧ 概率触发回忆（P2）
  enableProbRecall: false, // 启用概率触发
  probRecallChance: 0.15, // 触发概率

  // ⑩ 反思条目（P2）
  enableReflection: true, // 启用反思
  reflectEveryN: 10, // 每 N 次提取后反思
  maintenanceAutoMinNewNodes: 3,

  // UI 面板
  panelTheme: "crimson", // 面板主题 crimson|cyan|amber|violet
};

// ==================== 状态 ====================

let currentGraph = null;
let isExtracting = false;
let isRecalling = false;
let activeRecallPromise = null;
let recallRunSequence = 0;
let lastInjectionContent = "";
let lastExtractedItems = []; // 最近提取的节点（面板展示用）
let lastRecalledItems = []; // 最近召回的节点（面板展示用）
let extractionCount = 0; // v2: 提取次数计数器（定期触发概要/遗忘/反思）
let serverSettingsSaveTimer = null;
let isRecoveringHistory = false;
let lastHistoryWarningAt = 0;
let lastRecallFallbackNoticeAt = 0;
let lastExtractionWarningAt = 0;
const LOCAL_VECTOR_TIMEOUT_MS = 300000;
const STATUS_TOAST_THROTTLE_MS = 1500;
const RECALL_INPUT_RECORD_TTL_MS = 60000;
const HISTORY_RECOVERY_SETTLE_MS = 80;
const HISTORY_MUTATION_RETRY_DELAYS_MS = [80, 220, 500, 900];
const GRAPH_LOAD_RETRY_DELAYS_MS = [120, 450, 1200, 2500];
const AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS = [120, 320, 800, 1600, 2800];
let runtimeStatus = createUiStatus("待命", "准备就绪", "idle");
let lastExtractionStatus = createUiStatus("待命", "尚未执行提取", "idle");
let lastVectorStatus = createUiStatus("待命", "尚未执行向量任务", "idle");
let lastRecallStatus = createUiStatus("待命", "尚未执行召回", "idle");
let graphPersistenceState = createGraphPersistenceState();
const lastStatusToastAt = {};
let pendingRecallSendIntent = createRecallInputRecord();
let lastRecallSentUserMessage = createRecallInputRecord();
let pendingHostGenerationInputSnapshot = createRecallInputRecord();
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
let pendingAutoExtractionTimer = null;
let pendingAutoExtraction = {
  chatId: "",
  messageId: null,
  reason: "",
  requestedAt: 0,
  attempts: 0,
};
let skipBeforeCombineRecallUntil = 0;
let lastPreGenerationRecallKey = "";
let lastPreGenerationRecallAt = 0;
const generationRecallTransactions = new Map();
const plannerRecallHandoffs = new Map();
let persistedRecallUiRefreshTimer = null;
let persistedRecallUiRefreshObserver = null;
let persistedRecallUiRefreshSession = 0;
const PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS = [0, 80, 180, 320, 500];
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
    lastSyncUploadedAt: Number(graphPersistenceState.lastSyncUploadedAt) || 0,
    lastSyncDownloadedAt:
      Number(graphPersistenceState.lastSyncDownloadedAt) || 0,
    lastSyncedRevision: Number(graphPersistenceState.lastSyncedRevision) || 0,
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

  // chatId 匹配验证：如果两者都有，必须一致
  if (activeChatId && runtimeChatId) {
    return runtimeChatId === activeChatId;
  }

  // 兜底：chatId 不可用（ST 插件环境可能无法获取 chatId），
  // 但 currentGraph 结构完整且有节点数据 → 允许召回。
  // 这对应用户能在 UI 看到图谱但 getCurrentChatId() 返回空的场景。
  return currentGraph.nodes.length > 0 || currentGraph.edges.length > 0;
}

function isGraphReadableForRecall(
  loadState = graphPersistenceState.loadState,
  chatId = getCurrentChatId(),
) {
  if (isGraphReadable(loadState)) {
    return true;
  }

  // 当 loadState 不在正常可读状态时（如 NO_CHAT、LOADING），
  // 仍检查运行时图谱的实际结构。持久化状态机可能失同步
  // （如 getCurrentChatId 在某些 ST 环境下返回空导致 loadState 卡在 NO_CHAT），
  // 但 currentGraph 已经通过其他路径（IndexedDB probe / metadata fallback）加载了数据。
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
        "当前图谱尚未完成 IndexedDB 初始化",
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
  { notify = true } = {},
) {
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
  const currentId = getCurrentChatId();
  if (currentId && currentId !== expectedChatId) {
    throw createAbortError(
      `历史恢复已终止：聊天已从 ${expectedChatId} 切换到 ${currentId}${label ? ` (${label})` : ""}`,
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
  pendingRecallSendIntent = createRecallInputRecord();
  lastRecallSentUserMessage = createRecallInputRecord();
  pendingHostGenerationInputSnapshot = createRecallInputRecord();
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

  // 注意：不再在 MESSAGE_SENT 阶段清空 pendingRecallSendIntent /
  // pendingHostGenerationInputSnapshot / transactions。
  // 这些数据在 GENERATION_AFTER_COMMANDS 中被消费；MESSAGE_SENT 先于
  // GENERATION_AFTER_COMMANDS 触发，提前清空会导致召回拿不到用户输入。
  // 真正的消费发生在 recall 执行后（runRecallController 内部）。

  return lastRecallSentUserMessage;
}

function getMessageRecallRecord(messageIndex) {
  const chat = getContext()?.chat;
  return readPersistedRecallFromUserMessage(chat, messageIndex);
}

function debugWithThrottle(cache, key, ...args) {
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
  // （命令展开、包装显示、助手 UI 处理等），导致 hash 已无法精确匹配。
  // 这时仍应优先回绑到“当前最新 user 楼层”，否则召回记录虽然生成了，
  // 但 Recall Card 会因为找不到目标楼层而消失。
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
  if (summary.renderedCount > 0) return "rendered";
  if (summary.waitingMessageIndices.length > 0) return "waiting_dom";
  if (summary.anchorFailureIndices.length > 0) return "missing_message_anchor";
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
      debugPersistedRecallUi(
        "检测到重复消息 DOM 索引，保留首个锚点",
        {
          messageIndex,
        },
        `duplicate-message-index:${messageIndex}`,
      );
      cleanupRecallArtifacts(messageElement);
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
    attributeFilter: ["mesid", "data-mesid", "data-message-id"],
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

    const shouldRetry =
      (summary.status === "missing_chat_root" ||
        summary.status === "waiting_dom" ||
        summary.status === "missing_message_anchor") &&
      attemptIndex < retryDelays.length - 1;

    if (!shouldRetry) {
      clearPersistedRecallMessageUiObserver();
      return;
    }

    armPersistedRecallMessageUiObserver(sessionId, runAttempt);
    attemptIndex += 1;
    persistedRecallUiRefreshTimer = setTimeout(
      runAttempt,
      retryDelays[attemptIndex],
    );
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
  const mergedSettings = {
    ...defaultSettings,
    ...(extension_settings[MODULE_NAME] || {}),
  };
  const migrated = migrateLegacyTaskProfiles(mergedSettings);
  mergedSettings.taskProfilesVersion = migrated.taskProfilesVersion;
  mergedSettings.taskProfiles = migrated.taskProfiles;
  extension_settings[MODULE_NAME] = mergedSettings;
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
    console.log("[ST-BME] 已应用旧楼层隐藏:", reason, result);
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
      console.log("[ST-BME] 已增量更新旧楼层隐藏:", reason, result);
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
    console.log("[ST-BME] 已重置旧楼层隐藏状态:", reason);
  } catch (error) {
    console.warn("[ST-BME] 重置旧楼层隐藏状态失败:", reason, error);
  }
}

async function clearAllHiddenMessages(reason = "manual-clear") {
  try {
    const result = await unhideAll(getHideRuntimeAdapters());
    console.log("[ST-BME] 已取消全部旧楼层隐藏:", reason, result);
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
  // 仅接受宿主“强信号”，避免把中间态/占位 metadata 误判为 ready。
  if (hasHostMetadataReadySignal(metadata)) return true;

  return false;
}

function resolveCurrentChatIdentity(context = getContext()) {
  const candidates = [
    context?.chatId,
    context?.getCurrentChatId?.(),
    readGlobalCurrentChatId(),
    context?.chatMetadata?.chat_id,
    context?.chatMetadata?.chatId,
    context?.chatMetadata?.session_id,
    context?.chatMetadata?.sessionId,
  ];

  const chatId =
    candidates
      .map((candidate) => normalizeChatIdCandidate(candidate))
      .find(Boolean) || "";

  return {
    chatId,
    hasLikelySelectedChat: hasLikelySelectedChatContext(context),
  };
}

function getCurrentChatId(context = getContext()) {
  return resolveCurrentChatIdentity(context).chatId;
}

async function refreshRuntimeGraphAfterSyncApplied(syncPayload = {}) {
  const action = String(syncPayload?.action || "")
    .trim()
    .toLowerCase();
  if (action !== "download" && action !== "merge") {
    return {
      refreshed: false,
      reason: "action-not-supported",
      action,
    };
  }

  const syncedChatId = normalizeChatIdCandidate(syncPayload?.chatId);
  const activeChatId = normalizeChatIdCandidate(getCurrentChatId());
  const targetChatId = syncedChatId || activeChatId;

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
      lastSyncUploadedAt,
      lastSyncDownloadedAt,
      lastSyncedRevision,
    ] = await Promise.all([
      db.getRevision(),
      db.getMeta("lastSyncUploadedAt", 0),
      db.getMeta("lastSyncDownloadedAt", 0),
      db.getMeta("lastSyncedRevision", 0),
    ]);

    const patch = {
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      indexedDbRevision: normalizeIndexedDbRevision(revision),
      syncState: normalizeGraphSyncState(syncState),
      lastSyncUploadedAt: Number(lastSyncUploadedAt) || 0,
      lastSyncDownloadedAt: Number(lastSyncDownloadedAt) || 0,
      lastSyncedRevision: Number(lastSyncedRevision) || 0,
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
      syncState: syncResult?.synced ? "idle" : "warning",
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
    console.debug("[ST-BME] IndexedDB 会话已关闭（无活动聊天）", {
      source,
    });
    return {
      chatId: "",
      opened: false,
      skipped: false,
    };
  }

  const db = await manager.switchChat(chatId);
  console.debug("[ST-BME] IndexedDB 会话已同步", {
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
      console.debug("[ST-BME] legacy chat_metadata 图谱迁移完成", {
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
  { source = "indexeddb", attemptIndex = 0 } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot)) {
    return {
      success: false,
      loaded: false,
      reason: "indexeddb-empty",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const revision = Math.max(
    1,
    normalizeIndexedDbRevision(snapshot?.meta?.revision),
  );
  let graphFromSnapshot = null;
  try {
    graphFromSnapshot = buildGraphFromSnapshot(snapshot, {
      chatId: normalizedChatId,
    });
  } catch (error) {
    const failureReason =
      error?.code === "BME_SNAPSHOT_INTEGRITY_ERROR"
        ? "indexeddb-snapshot-integrity-rejected"
        : "indexeddb-snapshot-load-failed";
    updateGraphPersistenceState({
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      dbReady: true,
      indexedDbRevision: revision,
      indexedDbLastError: error?.message || String(error),
      dualWriteLastResult: {
        action: "load",
        source: String(source || "indexeddb"),
        success: false,
        rejected: true,
        reason: failureReason,
        revision,
        at: Date.now(),
      },
    });
    console.warn("[ST-BME] IndexedDB 图谱快照已拒绝加载", {
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
  currentGraph.vectorIndexState.lastIntegrityIssue = null;

  extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount)
    ? currentGraph.historyState.extractionCount
    : 0;
  lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  runtimeStatus = createUiStatus("待命", "已从 IndexedDB 加载聊天图谱", "idle");
  lastExtractionStatus = createUiStatus(
    "待命",
    "已从 IndexedDB 加载聊天图谱，等待下一次提取",
    "idle",
  );
  lastVectorStatus = createUiStatus(
    "待命",
    currentGraph.vectorIndexState?.lastWarning ||
      "已从 IndexedDB 加载聊天图谱，等待下一次向量任务",
    "idle",
  );
  lastRecallStatus = createUiStatus(
    "待命",
    restoredRecallUi.restored
      ? "已从持久化召回记录恢复显示，等待下一次召回"
      : "已从 IndexedDB 加载聊天图谱，等待下一次召回",
    "idle",
  );

  applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, {
    chatId: normalizedChatId,
    reason: `indexeddb:${source}`,
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
  updateGraphPersistenceState({
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    dbReady: true,
    indexedDbRevision: revision,
    metadataIntegrity:
      getChatMetadataIntegrity(getContext()) ||
      graphPersistenceState.metadataIntegrity,
    indexedDbLastError: "",
    lastSyncError: "",
    dualWriteLastResult: {
      action: "load",
      source: String(source || "indexeddb"),
      success: true,
      reason: "indexeddb-loaded",
      revision,
      at: Date.now(),
    },
  });

  removeGraphShadowSnapshot(normalizedChatId);
  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh(30);
  console.debug("[ST-BME] 已从 IndexedDB 加载图谱", {
    chatId: normalizedChatId,
    source,
    revision,
    ...getGraphStats(currentGraph),
  });

  return {
    success: true,
    loaded: true,
    loadState: GRAPH_LOAD_STATES.LOADED,
    reason: `indexeddb:${source}`,
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

    const migrationResult = await maybeMigrateLegacyGraphToIndexedDb(
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

    const snapshot = migrationResult?.snapshot || (await db.exportSnapshot());
    cacheIndexedDbSnapshot(normalizedChatId, snapshot);

    if (!isIndexedDbSnapshotMeaningful(snapshot)) {
      if (applyEmptyState && getCurrentChatId() === normalizedChatId) {
        return applyIndexedDbEmptyToRuntime(normalizedChatId, {
          source,
          attemptIndex,
        });
      }
      return {
        success: false,
        loaded: false,
        reason: "indexeddb-empty",
        chatId: normalizedChatId,
        attemptIndex,
      };
    }

    const snapshotRevision = normalizeIndexedDbRevision(
      snapshot?.meta?.revision,
    );
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

    return applyIndexedDbSnapshotToRuntime(normalizedChatId, snapshot, {
      source,
      attemptIndex,
    });
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
    };
  }
}

function deferAutoExtraction(
  reason = "auto-extraction-deferred",
  { chatId = getCurrentChatId(), messageId = null, delayMs = null } = {},
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
  const resolvedDelayMs = Number.isFinite(Number(delayMs))
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
    attempts: nextAttempts,
    delayMs: resolvedDelayMs,
  });

  return {
    scheduled: true,
    chatId: normalizedChatId,
    messageId: pendingAutoExtraction.messageId,
    reason: pendingAutoExtraction.reason,
    attempts: nextAttempts,
    delayMs: resolvedDelayMs,
  };
}

function maybeResumePendingAutoExtraction(source = "auto-extraction-resume") {
  const pendingChatId = normalizeChatIdCandidate(pendingAutoExtraction.chatId);
  if (!pendingChatId) {
    return {
      resumed: false,
      reason: "no-pending-auto-extraction",
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
    });
  }

  if (isRecoveringHistory) {
    return deferAutoExtraction("history-recovering", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
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
    });
  }

  const pendingRequest = { ...pendingAutoExtraction };
  clearPendingAutoExtraction();
  console.debug?.("[ST-BME] resuming pending auto extraction", {
    source,
    chatId: pendingRequest.chatId,
    messageId: pendingRequest.messageId,
    attempts: pendingRequest.attempts || 0,
  });
  const enqueueMicrotask =
    typeof globalThis.queueMicrotask === "function"
      ? globalThis.queueMicrotask.bind(globalThis)
      : (task) => Promise.resolve().then(task);
  enqueueMicrotask(() => {
    void runExtraction().catch((error) => {
      console.error("[ST-BME] 延迟自动提取失败:", error);
      notifyExtractionIssue(error?.message || String(error) || "自动提取失败");
    });
  });

  return {
    resumed: true,
    source,
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
  reason = "",
  loadState = graphPersistenceState.loadState,
  revision = graphPersistenceState.revision,
  saveMode = graphPersistenceState.lastPersistMode,
} = {}) {
  return {
    saved,
    queued,
    blocked,
    reason: String(reason || ""),
    loadState,
    revision: Number.isFinite(revision) ? revision : 0,
    saveMode: String(saveMode || ""),
  };
}

function maybeCaptureGraphShadowSnapshot(reason = "runtime-shadow") {
  const chatId = graphPersistenceState.chatId || getCurrentChatId();
  if (!chatId || !currentGraph) return false;
  const hasMeaningfulGraphData =
    !isGraphEffectivelyEmpty(currentGraph) ||
    graphPersistenceState.shadowSnapshotUsed ||
    graphPersistenceState.lastPersistedRevision > 0;
  if (!hasMeaningfulGraphData) return false;
  return writeGraphShadowSnapshot(chatId, currentGraph, {
    revision: graphPersistenceState.revision,
    reason,
  });
}

function persistGraphToChatMetadata(
  context = getContext(),
  {
    reason = "graph-persist",
    revision = graphPersistenceState.revision,
    immediate = false,
  } = {},
) {
  if (!context || !currentGraph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      reason: "missing-context-or-graph",
      revision,
    });
  }

  const chatId = getCurrentChatId(context);
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      reason: "missing-chat-id",
      revision,
    });
  }

  const nextIntegrity = getChatMetadataIntegrity(context);
  const persistedGraph = cloneGraphForPersistence(currentGraph, chatId);
  stampGraphPersistenceMeta(persistedGraph, {
    revision,
    reason,
    chatId,
    integrity: nextIntegrity,
  });
  stampGraphPersistenceMeta(currentGraph, {
    revision,
    reason,
    chatId,
    integrity: nextIntegrity,
  });
  writeChatMetadataPatch(context, {
    [GRAPH_METADATA_KEY]: persistedGraph,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });

  applyGraphLoadState(graphPersistenceState.loadState, {
    chatId,
    reason: graphPersistenceState.reason,
    attemptIndex: graphPersistenceState.attemptIndex,
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    revision,
    lastPersistedRevision: revision,
    queuedPersistRevision: 0,
    queuedPersistChatId: "",
    pendingPersist: false,
    writesBlocked: false,
  });
  removeGraphShadowSnapshot(chatId);
  updateGraphPersistenceState({
    lastPersistReason: String(reason || ""),
    lastPersistMode: saveMode,
    metadataIntegrity: String(nextIntegrity || ""),
    storagePrimary: "metadata",
    storageMode: "metadata",
    indexedDbLastError: "",
    queuedPersistChatId: "",
    queuedPersistMode: "",
    queuedPersistRotateIntegrity: false,
    queuedPersistReason: "",
  });

  return buildGraphPersistResult({
    saved: true,
    reason,
    loadState: graphPersistenceState.loadState,
    revision,
    saveMode,
  });
}

function queueGraphPersist(
  reason = "graph-persist-blocked",
  revision = graphPersistenceState.revision,
  { immediate = true } = {},
) {
  const queuedChatId = graphPersistenceState.chatId || getCurrentChatId();
  maybeCaptureGraphShadowSnapshot(reason);
  updateGraphPersistenceState({
    queuedPersistRevision: Math.max(
      graphPersistenceState.queuedPersistRevision || 0,
      revision || 0,
    ),
    queuedPersistChatId: String(queuedChatId || ""),
    queuedPersistMode: immediate ? "immediate" : "debounced",
    queuedPersistRotateIntegrity: false,
    queuedPersistReason: String(reason || ""),
    pendingPersist: true,
    writesBlocked: true,
    lastPersistReason: String(reason || ""),
  });

  return buildGraphPersistResult({
    queued: true,
    blocked: true,
    reason,
    loadState: graphPersistenceState.loadState,
    revision,
    saveMode: immediate ? "immediate" : "debounced",
  });
}

function maybeFlushQueuedGraphPersist(reason = "queued-graph-persist") {
  if (!currentGraph || !isGraphMetadataWriteAllowed()) {
    return buildGraphPersistResult({
      queued: graphPersistenceState.pendingPersist,
      blocked: !isGraphMetadataWriteAllowed(),
      reason: isGraphMetadataWriteAllowed()
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

  return persistGraphToChatMetadata(getContext(), {
    reason,
    revision: targetRevision,
    immediate: graphPersistenceState.queuedPersistMode !== "debounced",
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
  console.debug(
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

  if (liveChatId !== stateChatId) return true;

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

  const cachedSnapshot = readCachedIndexedDbSnapshot(chatId);
  if (isIndexedDbSnapshotMeaningful(cachedSnapshot)) {
    const result = applyIndexedDbSnapshotToRuntime(chatId, cachedSnapshot, {
      source: `${source}:indexeddb-cache`,
      attemptIndex: 0,
    });
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
    console.warn("[ST-BME] 清理旧注入失败:", error);
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
  // 同步悬浮球状态
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

function evaluateAutoMaintenanceGate(action, newNodeCount, settings = {}) {
  const normalizedAction = String(action || "").trim();
  if (!["consolidate", "compress"].includes(normalizedAction)) {
    return { blocked: false, reason: "", minNewNodes: 0 };
  }
  if (settings?.maintenanceAutoMinNewNodes == null) {
    return { blocked: false, reason: "", minNewNodes: 0 };
  }

  const minNewNodes = clampInt(settings.maintenanceAutoMinNewNodes, 3, 1, 50);
  const safeNewNodeCount = Math.max(0, Number(newNodeCount) || 0);
  if (safeNewNodeCount >= minNewNodes) {
    return { blocked: false, reason: "", minNewNodes };
  }

  return {
    blocked: true,
    minNewNodes,
    reason: `本批只新增 ${safeNewNodeCount} 个节点，低于门槛 ${minNewNodes}`,
  };
}

function buildMaintenanceSummary(action, result, mode = "manual") {
  const prefix = mode === "auto" ? "自动" : "手动";
  switch (String(action || "")) {
    case "compress":
      return `${prefix}压缩：新建 ${result?.created || 0}，归档 ${result?.archived || 0}`;
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
  currentGraph.historyState.lastProcessedAssistantFloor =
    lastProcessedAssistantFloor;
  currentGraph.historyState.processedMessageHashVersion =
    PROCESSED_MESSAGE_HASH_VERSION;
  currentGraph.historyState.processedMessageHashes =
    snapshotProcessedMessageHashes(chat, lastProcessedAssistantFloor);
  currentGraph.historyState.processedMessageHashesNeedRefresh = false;
  currentGraph.lastProcessedSeq = lastProcessedAssistantFloor;
}

function shouldAdvanceProcessedHistory(batchStatus) {
  if (!batchStatus || typeof batchStatus !== "object") return false;
  return batchStatus?.stages?.core?.outcome === "success";
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
  console.log("[ST-BME] 向量状态已自动修复:", reason, result.stats);
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

function getPersistedSettingsSnapshot(settings = getSettings()) {
  const persisted = {};
  for (const key of Object.keys(defaultSettings)) {
    persisted[key] = settings[key];
  }
  return persisted;
}

function mergePersistedSettings(loaded = {}) {
  const merged = { ...defaultSettings };
  for (const key of Object.keys(defaultSettings)) {
    if (Object.prototype.hasOwnProperty.call(loaded, key)) {
      merged[key] = loaded[key];
    }
  }
  return merged;
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
  const settings = getSettings();
  Object.assign(settings, patch);
  extension_settings[MODULE_NAME] = settings;
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
      const shadowSnapshot = readGraphShadowSnapshot(chatId);
      const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
        officialGraph,
        shadowSnapshot,
      );
      const officialRevision = Math.max(
        1,
        getGraphPersistedRevision(officialGraph),
      );

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

      clearPendingGraphLoadRetry();
      currentGraph = officialGraph;
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
    const baseSnapshot =
      readCachedIndexedDbSnapshot(normalizedChatId) ||
      (await db.exportSnapshot());
    const snapshot = buildSnapshotFromGraph(graph, {
      chatId: normalizedChatId,
      revision,
      baseSnapshot,
      lastModified: Date.now(),
      meta: {
        storagePrimary: "indexeddb",
        lastMutationReason: String(reason || "graph-save"),
      },
    });
    const importResult = await db.importSnapshot(snapshot, {
      mode: "replace",
      preserveRevision: true,
      revision,
      markSyncDirty: true,
    });
    await db.markSyncDirty(reason);

    snapshot.meta.revision = normalizeIndexedDbRevision(
      importResult?.revision,
      revision,
    );
    cacheIndexedDbSnapshot(normalizedChatId, snapshot);
    scheduleUpload(
      normalizedChatId,
      buildBmeSyncRuntimeOptions({
        trigger: `graph-mutation:${String(reason || "graph-save")}`,
      }),
    );

    updateGraphPersistenceState({
      storagePrimary: "indexeddb",
      storageMode: "indexeddb",
      dbReady: true,
      indexedDbRevision: snapshot.meta.revision,
      metadataIntegrity:
        getChatMetadataIntegrity(getContext()) ||
        graphPersistenceState.metadataIntegrity,
      indexedDbLastError: "",
      lastSyncError: "",
      dualWriteLastResult: {
        action: "save",
        target: "indexeddb",
        success: true,
        chatId: normalizedChatId,
        revision: snapshot.meta.revision,
        reason: String(reason || "graph-save"),
        at: Date.now(),
      },
    });

    return {
      saved: true,
      chatId: normalizedChatId,
      revision: snapshot.meta.revision,
      reason: String(reason || "graph-save"),
    };
  } catch (error) {
    console.warn("[ST-BME] IndexedDB 写入失败，保留 metadata 兜底:", error);
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
    ? bumpGraphRevision(reason)
    : graphPersistenceState.revision || 0;

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
      saved: Boolean(shouldQueueIndexedDbPersist),
      queued: false,
      blocked: false,
      reason: shouldQueueIndexedDbPersist
        ? "indexeddb-queued"
        : "indexeddb-empty-skip",
      revision,
      saveMode,
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
    storagePrimary: "metadata",
    storageMode: "metadata",
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
  maybeCaptureGraphShadowSnapshot("pagehide");
}

function handleGraphShadowSnapshotVisibilityChange() {
  if (document.visibilityState === "hidden") {
    maybeCaptureGraphShadowSnapshot("visibility-hidden");
  }
}

// ==================== 核心流程 ====================

const DEFAULT_TRIGGER_KEYWORDS = [
  "突然",
  "没想到",
  "原来",
  "其实",
  "发现",
  "背叛",
  "死亡",
  "复活",
  "恢复记忆",
  "失忆",
  "告白",
  "暴露",
  "秘密",
  "计划",
  "规则",
  "契约",
  "位置",
  "地点",
  "离开",
  "来到",
];

export function getSmartTriggerDecision(chat, lastProcessed, settings) {
  const pendingMessages = chat
    .slice(Math.max(0, (lastProcessed ?? -1) + 1))
    .map((msg, offset) => ({
      msg,
      index: Math.max(0, (lastProcessed ?? -1) + 1) + offset,
    }))
    .filter(({ msg, index }) => !isSystemMessageForExtraction(msg, { index, chat }))
    .map(({ msg }) => ({
      role: msg.is_user ? "user" : "assistant",
      content: msg.mes || "",
    }))
    .filter((msg) => msg.content.trim().length > 0);

  if (pendingMessages.length === 0) {
    return { triggered: false, score: 0, reasons: [] };
  }

  const reasons = [];
  let score = 0;
  const combinedText = pendingMessages.map((m) => m.content).join("\n");

  const keywordHits = DEFAULT_TRIGGER_KEYWORDS.filter((keyword) =>
    combinedText.includes(keyword),
  );
  if (keywordHits.length > 0) {
    score += Math.min(2, keywordHits.length);
    reasons.push(`关键词: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  const customPatterns = String(settings.triggerPatterns || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pattern of customPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(combinedText)) {
        score += 2;
        reasons.push(`自定义触发: ${pattern}`);
        break;
      }
    } catch {
      // 忽略无效正则，避免影响主流程
    }
  }

  const roleSwitchCount = pendingMessages.reduce((count, message, index) => {
    if (index === 0) return count;
    return count + (message.role !== pendingMessages[index - 1].role ? 1 : 0);
  }, 0);
  if (roleSwitchCount >= 2) {
    score += 1;
    reasons.push("多轮往返互动");
  }

  const punctuationHits = (combinedText.match(/[!?！？]/g) || []).length;
  if (punctuationHits >= 2) {
    score += 1;
    reasons.push("情绪/冲突波动");
  }

  const entityLikeHits =
    combinedText.match(
      /[A-Z][a-z]{2,}|[\u4e00-\u9fff]{2,6}(先生|小姐|王国|城|镇|村|学院|组织|公司|小队|军团)/g,
    ) || [];
  if (entityLikeHits.length > 0) {
    score += 1;
    reasons.push("疑似新实体/新地点");
  }

  const threshold = Math.max(1, settings.smartTriggerThreshold || 2);
  return {
    triggered: score >= threshold,
    score,
    reasons,
  };
}

function getLatestUserChatMessage(chat) {
  if (!Array.isArray(chat)) return null;

  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (message?.is_system) continue;
    if (message?.is_user) return message;
  }

  return null;
}

function getLastNonSystemChatMessage(chat) {
  if (!Array.isArray(chat)) return null;

  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (!message?.is_system) return message;
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

  // 对于 history 类型（continue/regenerate/swipe），必须有 chat 中的用户消息
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

  // 对于 normal 类型：GENERATION_AFTER_COMMANDS 触发时用户消息可能不在 chat 末尾
  // （ST 可能已追加空 assistant 消息）。如果 chat 中存在任何用户消息，
  // 继续走 buildNormalGenerationRecallInput，它会通过 latestUserText 兜底找到。
  // 如果 chat 中完全没有用户消息，则延迟到 BEFORE_COMBINE_PROMPTS 处理。
  if (!Number.isFinite(targetUserMessageIndex) && !getLatestUserChatMessage(chat)) {
    return {
      generationType,
      targetUserMessageIndex: null,
    };
  }

  return buildNormalGenerationRecallInput(chat, {
    frozenInputSnapshot: params?.frozenInputSnapshot,
  });
}

function buildNormalGenerationRecallInput(chat, options = {}) {
  const lastNonSystemMessage = getLastNonSystemChatMessage(chat);
  const tailUserText = lastNonSystemMessage?.is_user
    ? normalizeRecallInputText(lastNonSystemMessage?.mes || "")
    : "";
  // 当 GENERATION_AFTER_COMMANDS 触发时，ST 可能已追加了空 assistant 消息，
  // 导致 lastNonSystemMessage 不是 user。用 getLatestUserChatMessage 反向扫描
  // 定位真正的用户消息（与 shujuku 参考实现一致）。
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
  const selectedCandidate = sourceCandidates[0] || null;
  if (!selectedCandidate?.text) return null;

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

  // GENERATION_AFTER_COMMANDS: immediate —— await 完召回后直接通过
  // setExtensionPrompt 注入记忆，与 shujuku 参考实现一致。
  // GENERATE_BEFORE_COMBINE_PROMPTS: deferred —— 作为兜底，通过 promptData
  // rewrite 补救注入。
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
  const resolveAutoMaintenanceGate =
    typeof evaluateAutoMaintenanceGate === "function"
      ? evaluateAutoMaintenanceGate
      : (action, count, localSettings = {}) => {
          const normalizedAction = String(action || "").trim();
          if (!["consolidate", "compress"].includes(normalizedAction)) {
            return { blocked: false, reason: "", minNewNodes: 0 };
          }
          if (localSettings?.maintenanceAutoMinNewNodes == null) {
            return { blocked: false, reason: "", minNewNodes: 0 };
          }
          const parsedMinNewNodes = Math.floor(
            Number(localSettings.maintenanceAutoMinNewNodes),
          );
          const minNewNodes =
            Number.isFinite(parsedMinNewNodes) && parsedMinNewNodes >= 1
              ? Math.min(50, parsedMinNewNodes)
              : 3;
          const safeCount = Math.max(0, Number(count) || 0);
          return safeCount >= minNewNodes
            ? { blocked: false, reason: "", minNewNodes }
            : {
                blocked: true,
                minNewNodes,
                reason: `本批只新增 ${safeCount} 个节点，低于门槛 ${minNewNodes}`,
              };
        };
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
              return `${prefix}压缩：新建 ${maintenanceResult?.created || 0}，归档 ${maintenanceResult?.archived || 0}`;
            case "consolidate":
              return `${prefix}整合：合并 ${maintenanceResult?.merged || 0}，跳过 ${maintenanceResult?.skipped || 0}，保留 ${maintenanceResult?.kept || 0}，进化 ${maintenanceResult?.evolved || 0}，新链接 ${maintenanceResult?.connections || 0}，回溯更新 ${maintenanceResult?.updates || 0}`;
            case "sleep":
              return `${prefix}遗忘：归档 ${maintenanceResult?.forgotten || 0} 个节点`;
            default:
              return `${prefix}维护已执行`;
          }
        };
  const cloneMaintenanceSnapshot =
    typeof cloneGraphSnapshot === "function"
      ? cloneGraphSnapshot
      : (value) => JSON.parse(JSON.stringify(value ?? null));
  const persistMaintenanceAction =
    typeof recordMaintenanceAction === "function"
      ? recordMaintenanceAction
      : () => null;
  throwIfAborted(signal, "提取已终止");
  extractionCount++;
  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;
  updateLastExtractedItems(result.newNodeIds || []);
  setBatchStageOutcome(status, "core", "success");

  if (settings.enableConsolidation && result.newNodeIds?.length > 0) {
    const gate = resolveAutoMaintenanceGate(
      "consolidate",
      newNodeCount,
      settings,
    );
    if (gate.blocked) {
      applyMaintenanceGateNote(status, "consolidate", gate.reason);
      pushBatchStageArtifact(status, "structural", "consolidation-skipped");
    } else {
      try {
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

  if (
    settings.enableSynopsis &&
    extractionCount % settings.synopsisEveryN === 0
  ) {
    try {
      await generateSynopsis({
        graph: currentGraph,
        schema: getSchema(),
        currentSeq: endIdx,
        settings,
        signal,
      });
      postProcessArtifacts.push("synopsis");
      pushBatchStageArtifact(status, "semantic", "synopsis");
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || "概要生成阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `概要生成失败: ${message}`,
      );
      console.error("[ST-BME] 概要生成失败:", e);
    }
  }

  if (
    settings.enableReflection &&
    extractionCount % settings.reflectEveryN === 0
  ) {
    try {
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

  try {
    throwIfAborted(signal, "提取已终止");
    const gate = resolveAutoMaintenanceGate(
      "compress",
      newNodeCount,
      settings,
    );
    if (gate.blocked) {
      applyMaintenanceGateNote(status, "compress", gate.reason);
      pushBatchStageArtifact(status, "structural", "compression-skipped");
    } else {
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
    updateProcessedHistorySnapshot(
      chat,
      currentGraph.historyState.lastProcessedAssistantFloor ?? -1,
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
      saveGraphToChat,
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
    getGraphMutationBlockReason,
    getIsExtracting: () => isExtracting,
    getIsRecoveringHistory: () => isRecoveringHistory,
    getLastProcessedAssistantFloor,
    getSettings,
    getSmartTriggerDecision,
    isAbortError,
    notifyExtractionIssue,
    recoverHistoryIfNeeded,
    setIsExtracting: (value) => {
      isExtracting = value;
    },
    setLastExtractionStatus,
  });
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
    activeRegion:
      currentGraph?.historyState?.activeRegion ||
      currentGraph?.historyState?.lastExtractedRegion ||
      "",
    activeCharacterPovOwner:
      currentGraph?.historyState?.activeCharacterPovOwner ||
      context.name2 ||
      "",
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
  if (!userMessage) {
    return {
      ok: false,
      reason: "empty-user-input",
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
      recordRecallSentUserMessage,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-sent", 40);
  }
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
  return onGenerationStartedController(
    {
      clearDryRunPromptPreview,
      freezeHostGenerationInputSnapshot,
      getPendingRecallSendIntent: () => pendingRecallSendIntent,
      getSendTextareaValue,
      isFreshRecallInputRecord,
      markDryRunPromptPreview,
      normalizeRecallInputText,
    },
    type,
    params,
    dryRun,
  );
}

function onGenerationEnded(_chatLength = null) {
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
    createRecallInputRecord,
    getContext,
    getCurrentGraph: () => currentGraph,
    getGraphPersistenceState: () => graphPersistenceState,
    getPendingHostGenerationInputSnapshot,
    getPendingRecallSendIntent: () => pendingRecallSendIntent,
    isAssistantChatMessage,
    isFreshRecallInputRecord,
    isGraphMetadataWriteAllowed,
    syncGraphLoadFromLiveContext,
    maybeCaptureGraphShadowSnapshot,
    maybeFlushQueuedGraphPersist,
    notifyExtractionIssue,
    queueMicrotask,
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
  return await onRebuildController({
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
    ensureGraphMutationReady,
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
    setCurrentGraph: (graph) => {
      currentGraph = graph;
    },
    setLastExtractionStatus,
    setRuntimeStatus,
    snapshotRuntimeUiState,
    toastr,
  });
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
    recordMaintenanceAction,
    recordGraphMutation,
    toastr,
  });
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
  return await onImportGraphController({
    clearInjectionState,
    clearTimeout,
    document,
    ensureGraphMutationReady,
    getCurrentChatId,
    importGraph,
    markVectorStateDirty,
    normalizeGraphRuntimeState,
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
  });
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
      getIsExtracting: () => isExtracting,
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      normalizeGraphRuntimeState,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
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
    recordMaintenanceAction,
    recordGraphMutation,
    sleepCycle,
    toastr,
  });
}

async function onManualSynopsis() {
  return await onManualSynopsisController({
    cloneGraphSnapshot,
    ensureGraphMutationReady,
    generateSynopsis,
    getCurrentChatSeq,
    getCurrentGraph: () => currentGraph,
    getSchema,
    getSettings,
    recordGraphMutation,
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
    recordMaintenanceAction,
    recordGraphMutation,
    toastr,
  });
}

async function onUndoLastMaintenance() {
  return await onUndoLastMaintenanceController({
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    markVectorStateDirty,
    refreshPanelLiveState,
    saveGraphToChat,
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

// ==================== 初始化 ====================

(async function init() {
  await loadServerSettings();
  syncGraphPersistenceDebugState();

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
    },
    registerBeforeCombinePrompts,
    registerGenerationAfterCommands,
    setCoreEventBindingState,
  });

  // 加载当前聊天的图谱
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

  // ==================== 操控面板初始化 ====================

  await initializePanelBridgeController({
    $,
    actions: {
      syncGraphLoad: () =>
        syncGraphLoadFromLiveContext({
          source: "panel-open-sync",
        }),
      extract: onManualExtract,
      compress: onManualCompress,
      sleep: onManualSleep,
      synopsis: onManualSynopsis,
      export: onExportGraph,
      import: onImportGraph,
      rebuild: onRebuild,
      evolve: onManualEvolve,
      undoMaintenance: onUndoLastMaintenance,
      testEmbedding: onTestEmbedding,
      testMemoryLLM: onTestMemoryLLM,
      fetchMemoryLLMModels: onFetchMemoryLLMModels,
      fetchEmbeddingModels: onFetchEmbeddingModels,
      applyCurrentHide: () => applyMessageHideNow("panel-manual-apply"),
      clearCurrentHide: () => clearAllHiddenMessages("panel-manual-clear"),
      rebuildVectorIndex: () => onRebuildVectorIndex(),
      rebuildVectorRange: (range) => onRebuildVectorIndex(range),
      reembedDirect: onReembedDirect,
      reroll: onReroll,
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
    importPanelModule: async () => await import("./panel.js"),
    importThemesModule: async () => await import("./themes.js"),
    setPanelModule: (module) => {
      _panelModule = module;
    },
    setThemesModule: (module) => {
      _themesModule = module;
    },
    updateSettings: updateModuleSettings,
  });

  schedulePersistedRecallMessageUiRefresh(120);
  try {
    const { initEnaPlanner } = await import("./ena-planner/ena-planner.js");
    await initEnaPlanner({
      getContext,
      getExtensionPath: () => `scripts/extensions/third-party/${MODULE_NAME}`,
      preparePlannerRecallHandoff,
      runPlannerRecallForEna,
    });
    console.log("[ST-BME] Ena Planner module loaded");
  } catch (error) {
    console.warn("[ST-BME] Ena Planner module load failed:", error);
  }
  console.log("[ST-BME] 初始化完成");
})();
