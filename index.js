// ST-BME: 主入口
// 事件钩子、设置管理、流程调度

import {
  eventSource,
  event_types,
  extension_prompt_types,
  extension_prompt_roles,
  getRequestHeaders,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "../../../extensions.js";

import { compressAll, sleepCycle } from "./compressor.js";
import { consolidateMemories } from "./consolidator.js";
import {
  extractMemories,
  generateReflection,
  generateSynopsis,
} from "./extractor.js";
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
  createDefaultTaskProfiles,
  migrateLegacyTaskProfiles,
} from "./prompt-profiles.js";
import { retrieve } from "./retriever.js";
import {
  appendBatchJournal,
  buildReverseJournalRecoveryPlan,
  buildRecoveryResult,
  clearHistoryDirty,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
  markHistoryDirty,
  normalizeGraphRuntimeState,
  rollbackBatch,
  snapshotProcessedMessageHashes,
} from "./runtime-state.js";
import { DEFAULT_NODE_SCHEMA, validateSchema } from "./schema.js";
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
import { resolveConfiguredTimeoutMs } from "./request-timeout.js";

// 操控面板模块（动态加载，防止加载失败崩溃整个扩展）
let _panelModule = null;
let _themesModule = null;

const MODULE_NAME = "st_bme";
const GRAPH_METADATA_KEY = "st_bme_graph";
const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";
const SERVER_SETTINGS_URL = `/user/files/${SERVER_SETTINGS_FILENAME}`;

function cloneRuntimeDebugValue(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback ?? value;
  }
}

function getRuntimeDebugState() {
  const stateKey = "__stBmeRuntimeDebugState";
  if (
    !globalThis[stateKey] ||
    typeof globalThis[stateKey] !== "object"
  ) {
    globalThis[stateKey] = {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
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

function readRuntimeDebugSnapshot() {
  const state = getRuntimeDebugState();
  return cloneRuntimeDebugValue(
    {
      hostCapabilities: state.hostCapabilities,
      taskPromptBuilds: state.taskPromptBuilds,
      taskLlmRequests: state.taskLlmRequests,
      injections: state.injections,
      updatedAt: state.updatedAt,
    },
    {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      updatedAt: "",
    },
  );
}

// ==================== 默认设置 ====================

const defaultSettings = {
  enabled: false,
  timeoutMs: 300000,

  // 提取设置
  extractEvery: 1, // 每 N 条 assistant 回复提取一次
  extractContextTurns: 2, // 提取时包含的上下文楼层数

  // 召回设置
  recallEnabled: true,
  recallTopK: 20, // 向量预筛 Top-K
  recallMaxNodes: 8, // LLM 召回最大节点数
  recallEnableLLM: true, // 是否启用 LLM 精确召回
  recallEnableVectorPrefilter: true, // 是否启用向量预筛
  recallEnableGraphDiffusion: true, // 是否启用图扩散
  recallDiffusionTopK: 100, // 图扩散阶段保留的候选上限
  recallLlmCandidatePool: 30, // 传给 LLM 精排的候选池大小
  recallLlmContextMessages: 4, // 传给 LLM 精排的最近非系统消息数

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

  // UI 面板
  panelTheme: "crimson", // 面板主题 crimson|cyan|amber|violet
};

// ==================== 状态 ====================

let currentGraph = null;
let isExtracting = false;
let isRecalling = false;
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
let runtimeStatus = createUiStatus("待命", "准备就绪", "idle");
let lastExtractionStatus = createUiStatus("待命", "尚未执行提取", "idle");
let lastVectorStatus = createUiStatus("待命", "尚未执行向量任务", "idle");
let lastRecallStatus = createUiStatus("待命", "尚未执行召回", "idle");
const lastStatusToastAt = {};
let pendingRecallSendIntent = createRecallInputRecord();
let lastRecallSentUserMessage = createRecallInputRecord();
let sendIntentHookCleanup = [];
let sendIntentHookRetryTimer = null;
let pendingHistoryRecoveryTimer = null;
let pendingHistoryRecoveryTrigger = "";
let pendingHistoryMutationCheckTimers = [];
let pendingGraphLoadRetryTimer = null;
let pendingGraphLoadRetryChatId = "";
const generationRecallTransactions = new Map();
const GENERATION_RECALL_TRANSACTION_TTL_MS = 15000;
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

function createUiStatus(text = "待命", meta = "", level = "idle") {
  return {
    text: String(text || "待命"),
    meta: String(meta || ""),
    level,
    updatedAt: Date.now(),
  };
}

function normalizeStageNoticeLevel(level = "info") {
  if (level === "running" || level === "idle") return "info";
  if (level === "success" || level === "warning" || level === "error") {
    return level;
  }
  return "info";
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

function getStageNoticeTitle(stage) {
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

function getStageNoticeDuration(level = "info") {
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

function createNoticePanelAction() {
  if (!_panelModule?.openPanel) return undefined;
  return {
    label: "打开面板",
    kind: "neutral",
    onClick: () => {
      _panelModule?.openPanel?.();
    },
  };
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

function createRecallInputRecord(overrides = {}) {
  return {
    text: "",
    hash: "",
    messageId: null,
    source: "",
    at: 0,
    ...overrides,
  };
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

  lastRecalledItems = nodeIds
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

function normalizeRecallInputText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function hashRecallInput(text) {
  let hash = 0;
  const normalized = normalizeRecallInputText(text);
  for (let index = 0; index < normalized.length; index++) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return normalized ? String(hash) : "";
}

function isFreshRecallInputRecord(record) {
  return Boolean(
    record?.text &&
    record.at &&
    Date.now() - record.at <= RECALL_INPUT_RECORD_TTL_MS,
  );
}

function clearRecallInputTracking() {
  pendingRecallSendIntent = createRecallInputRecord();
  lastRecallSentUserMessage = createRecallInputRecord();
}

function recordRecallSendIntent(text, source = "dom-intent") {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return;

  pendingRecallSendIntent = createRecallInputRecord({
    text: normalized,
    hash: hashRecallInput(normalized),
    source,
    at: Date.now(),
  });
}

function recordRecallSentUserMessage(messageId, text, source = "message-sent") {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return;

  const hash = hashRecallInput(normalized);
  lastRecallSentUserMessage = createRecallInputRecord({
    text: normalized,
    hash,
    messageId: Number.isFinite(messageId) ? messageId : null,
    source,
    at: Date.now(),
  });

  if (pendingRecallSendIntent.hash && pendingRecallSendIntent.hash === hash) {
    pendingRecallSendIntent = createRecallInputRecord();
  }
}

function getSendTextareaValue() {
  return String(document.getElementById("send_textarea")?.value ?? "");
}

function scheduleSendIntentHookRetry(delayMs = 400) {
  clearTimeout(sendIntentHookRetryTimer);
  sendIntentHookRetryTimer = setTimeout(() => {
    sendIntentHookRetryTimer = null;
    installSendIntentHooks();
  }, delayMs);
}

function registerBeforeCombinePrompts(listener) {
  const makeFirst = globalThis.eventMakeFirst;
  if (typeof makeFirst === "function") {
    return makeFirst(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, listener);
  }

  console.warn("[ST-BME] eventMakeFirst 不可用，回退到普通事件注册");
  eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, listener);
  return null;
}

function registerGenerationAfterCommands(listener) {
  const makeFirst = globalThis.eventMakeFirst;
  if (typeof makeFirst === "function") {
    return makeFirst(event_types.GENERATION_AFTER_COMMANDS, listener);
  }

  console.warn(
    "[ST-BME] eventMakeFirst 不可用，GENERATION_AFTER_COMMANDS 回退到普通事件注册",
  );
  eventSource.on(event_types.GENERATION_AFTER_COMMANDS, listener);
  return null;
}

function installSendIntentHooks() {
  for (const cleanup of sendIntentHookCleanup.splice(
    0,
    sendIntentHookCleanup.length,
  )) {
    try {
      cleanup();
    } catch (error) {
      console.warn("[ST-BME] 清理发送意图钩子失败:", error);
    }
  }

  const sendButton = document.getElementById("send_but");
  const sendTextarea = document.getElementById("send_textarea");

  if (sendButton) {
    const captureSendIntent = () => {
      recordRecallSendIntent(getSendTextareaValue(), "send-button");
    };

    sendButton.addEventListener("click", captureSendIntent, true);
    sendButton.addEventListener("pointerup", captureSendIntent, true);
    sendButton.addEventListener("touchend", captureSendIntent, true);
    sendIntentHookCleanup.push(() => {
      sendButton.removeEventListener("click", captureSendIntent, true);
      sendButton.removeEventListener("pointerup", captureSendIntent, true);
      sendButton.removeEventListener("touchend", captureSendIntent, true);
    });
  }

  if (sendTextarea) {
    const captureEnterIntent = (event) => {
      if (
        (event.key === "Enter" || event.key === "NumpadEnter") &&
        !event.shiftKey
      ) {
        recordRecallSendIntent(getSendTextareaValue(), "textarea-enter");
      }
    };

    sendTextarea.addEventListener("keydown", captureEnterIntent, true);
    sendIntentHookCleanup.push(() => {
      sendTextarea.removeEventListener("keydown", captureEnterIntent, true);
    });
  }

  if (!sendButton || !sendTextarea) {
    scheduleSendIntentHookRetry();
  }
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

function getCurrentChatId(context = getContext()) {
  return String(context?.chatId || context?.getCurrentChatId?.() || "");
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
    context.setExtensionPrompt(MODULE_NAME, content, position, depth, false, role);
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
  return Boolean(normalizedChatId) && pendingGraphLoadRetryChatId === normalizedChatId;
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

function scheduleGraphLoadRetry(
  chatId,
  reason = "metadata-pending",
  attemptIndex = 0,
) {
  const normalizedChatId = String(chatId || "");
  const delayMs = GRAPH_LOAD_RETRY_DELAYS_MS[attemptIndex];
  if (!normalizedChatId || !Number.isFinite(delayMs)) {
    clearPendingGraphLoadRetry();
    return false;
  }

  clearPendingGraphLoadRetry({ resetChatId: false });
  pendingGraphLoadRetryChatId = normalizedChatId;
  console.debug(
    `[ST-BME] 图谱元数据尚未就绪，${delayMs}ms 后重试加载（chat=${normalizedChatId}，attempt=${attemptIndex + 1}，reason=${reason}）`,
  );

  pendingGraphLoadRetryTimer = setTimeout(() => {
    pendingGraphLoadRetryTimer = null;
    if (getCurrentChatId() !== normalizedChatId) {
      clearPendingGraphLoadRetry();
      return;
    }

    loadGraphFromChat({
      attemptIndex: attemptIndex + 1,
      expectedChatId: normalizedChatId,
      source: `retry:${reason}`,
    });
  }, delayMs);

  return true;
}

function clearInjectionState() {
  lastInjectionContent = "";
  lastRecalledItems = [];
  lastRecallStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  runtimeStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
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
  if (!isRecalling) {
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
  _panelModule?.refreshLiveState?.();
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
  { syncRuntime = true, toastKind = "", toastTitle = "ST-BME 提取", noticeMarquee = false } = {},
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
  { syncRuntime = true, toastKind = "", toastTitle = "ST-BME 召回", noticeMarquee = false } = {},
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
  refreshPanelLiveState();
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
  saveGraphToChat();
  return vectorSync;
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
  currentGraph.historyState.processedMessageHashes =
    snapshotProcessedMessageHashes(chat, lastProcessedAssistantFloor);
  currentGraph.lastProcessedSeq = lastProcessedAssistantFloor;
}

function shouldAdvanceProcessedHistory(batchStatus) {
  if (!batchStatus || typeof batchStatus !== "object") return false;
  return (
    batchStatus.completed === true &&
    batchStatus.outcome === "success" &&
    batchStatus.consistency === "strong"
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
      syncRuntime: false,
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
      { syncRuntime: false },
    );
    return result;
  } catch (error) {
    if (isAbortError(error)) {
      setLastVectorStatus("向量已终止", scopeLabel, "warning", {
        syncRuntime: false,
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
    saveGraphToChat();
    console.warn("[ST-BME] 向量状态自动修复失败:", reason, result.error);
    return result;
  }

  currentGraph.vectorIndexState.lastWarning = "";
  saveGraphToChat();
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
  saveGraphToChat();
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

  scheduleServerSettingsSave();
  return settings;
}

// ==================== 图状态持久化 ====================

function loadGraphFromChat(options = {}) {
  const {
    attemptIndex = 0,
    expectedChatId = "",
    source = "direct-load",
  } = options;
  const context = getContext();
  const chatId = getCurrentChatId(context);
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
    return false;
  }

  const hasChatMetadata =
    context?.chatMetadata &&
    typeof context.chatMetadata === "object" &&
    !Array.isArray(context.chatMetadata);
  const savedData = hasChatMetadata
    ? context.chatMetadata[GRAPH_METADATA_KEY]
    : undefined;
  const shouldRetry =
    Boolean(chatId) &&
    (savedData == null || savedData === "") &&
    attemptIndex < GRAPH_LOAD_RETRY_DELAYS_MS.length;

  if (savedData != null && savedData !== "") {
    clearPendingGraphLoadRetry();
    currentGraph = normalizeGraphRuntimeState(
      deserializeGraph(savedData),
      chatId,
    );
    extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount)
      ? currentGraph.historyState.extractionCount
      : 0;
    lastExtractedItems = [];
    updateLastRecalledItems(currentGraph.lastRecallResult || []);
    lastInjectionContent = "";
    runtimeStatus = createUiStatus(
      "待命",
      "已加载聊天图谱，等待下一次任务",
      "idle",
    );
    lastExtractionStatus = createUiStatus(
      "待命",
      "已加载聊天图谱，等待下一次提取",
      "idle",
    );
    lastVectorStatus = createUiStatus(
      "待命",
      currentGraph.vectorIndexState?.lastWarning ||
        "已加载聊天图谱，等待下一次向量任务",
      "idle",
    );
    lastRecallStatus = createUiStatus(
      "待命",
      "已加载聊天图谱，等待下一次召回",
      "idle",
    );

    console.log("[ST-BME] 从聊天数据加载图谱:", {
      chatId,
      source,
      attemptIndex,
      ...getGraphStats(currentGraph),
    });
    refreshPanelLiveState();
    return true;
  }

  if (shouldRetry) {
    currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
    extractionCount = 0;
    lastExtractedItems = [];
    lastRecalledItems = [];
    lastInjectionContent = "";
    runtimeStatus = createUiStatus(
      "待命",
      "正在等待聊天元数据加载，暂不覆盖现有图谱",
      "idle",
    );
    lastExtractionStatus = createUiStatus(
      "待命",
      "正在等待聊天元数据加载",
      "idle",
    );
    lastVectorStatus = createUiStatus(
      "待命",
      "正在等待聊天元数据加载",
      "idle",
    );
    lastRecallStatus = createUiStatus(
      "待命",
      "正在等待聊天元数据加载",
      "idle",
    );
    scheduleGraphLoadRetry(
      chatId,
      hasChatMetadata ? "graph-metadata-missing" : "chat-metadata-missing",
      attemptIndex,
    );
    refreshPanelLiveState();
    return false;
  }

  clearPendingGraphLoadRetry();
  currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
  extractionCount = 0;
  lastExtractedItems = [];
  lastRecalledItems = [];
  lastInjectionContent = "";

  const noChatLoaded = !chatId;
  runtimeStatus = createUiStatus(
    "待命",
    noChatLoaded ? "当前尚未进入聊天" : "当前聊天尚未建立记忆图谱",
    "idle",
  );
  lastExtractionStatus = createUiStatus(
    "待命",
    noChatLoaded ? "当前尚未进入聊天" : "当前聊天尚未执行提取",
    "idle",
  );
  lastVectorStatus = createUiStatus(
    "待命",
    noChatLoaded ? "当前尚未进入聊天" : "当前聊天尚未执行向量任务",
    "idle",
  );
  lastRecallStatus = createUiStatus(
    "待命",
    noChatLoaded ? "当前尚未进入聊天" : "当前聊天尚未建立记忆图谱",
    "idle",
  );
  refreshPanelLiveState();
  return false;
}

function saveGraphToChat() {
  const context = getContext();
  if (!context || !currentGraph) return false;
  const chatId = getCurrentChatId(context);

  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;

  if (isGraphLoadRetryPending(chatId) && isGraphEffectivelyEmpty(currentGraph)) {
    console.warn(
      `[ST-BME] 图谱元数据仍在加载中，已跳过空图写回（chat=${chatId}）`,
    );
    return false;
  }

  if (typeof context.updateChatMetadata === "function") {
    context.updateChatMetadata({ [GRAPH_METADATA_KEY]: currentGraph });
  } else {
    if (
      !context.chatMetadata ||
      typeof context.chatMetadata !== "object" ||
      Array.isArray(context.chatMetadata)
    ) {
      context.chatMetadata = {};
    }
    context.chatMetadata[GRAPH_METADATA_KEY] = currentGraph;
  }

  if (typeof context.saveMetadataDebounced === "function") {
    context.saveMetadataDebounced();
  } else {
    saveMetadataDebounced();
  }

  return true;
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
    .filter((msg) => !msg.is_system)
    .map((msg) => ({
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

function clampInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function clampFloat(value, fallback, min = 0, max = 1) {
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function formatRecallContextLine(message) {
  return `[${message.is_user ? "user" : "assistant"}]: ${message.mes || ""}`;
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
  if (!Array.isArray(chat) || limit <= 0) return [];

  const recentMessages = [];
  for (
    let index = chat.length - 1;
    index >= 0 && recentMessages.length < limit;
    index--
  ) {
    const message = chat[index];
    if (message?.is_system) continue;
    recentMessages.unshift(formatRecallContextLine(message));
  }

  const normalizedSynthetic = normalizeRecallInputText(syntheticUserMessage);
  if (!normalizedSynthetic) return recentMessages;

  const syntheticLine = `[user]: ${normalizedSynthetic}`;
  if (recentMessages[recentMessages.length - 1] !== syntheticLine) {
    recentMessages.push(syntheticLine);
    while (recentMessages.length > limit) {
      recentMessages.shift();
    }
  }

  return recentMessages;
}

function getRecallUserMessageSourceLabel(source) {
  switch (source) {
    case "send-intent":
      return "发送意图";
    case "chat-tail-user":
      return "当前用户楼层";
    case "message-sent":
      return "已发送用户楼层";
    case "chat-last-user":
      return "历史最后用户楼层";
    default:
      return "未知";
  }
}

function resolveRecallInput(chat, recentContextMessageLimit, override = null) {
  const overrideText = normalizeRecallInputText(override?.userMessage || "");
  if (overrideText) {
    return {
      userMessage: overrideText,
      source: String(override?.source || "override"),
      sourceLabel: String(override?.sourceLabel || "发送前拦截"),
      recentMessages: buildRecallRecentMessages(
        chat,
        recentContextMessageLimit,
        override?.includeSyntheticUserMessage === false ? "" : overrideText,
      ),
    };
  }

  const latestUserMessage = getLatestUserChatMessage(chat);
  const latestUserText = normalizeRecallInputText(latestUserMessage?.mes || "");
  const lastNonSystemMessage = getLastNonSystemChatMessage(chat);
  const tailUserText = lastNonSystemMessage?.is_user
    ? normalizeRecallInputText(lastNonSystemMessage?.mes || "")
    : "";
  const pendingIntentText = isFreshRecallInputRecord(pendingRecallSendIntent)
    ? pendingRecallSendIntent.text
    : "";
  const sentUserText = isFreshRecallInputRecord(lastRecallSentUserMessage)
    ? lastRecallSentUserMessage.text
    : "";

  let userMessage = "";
  let source = "";
  let syntheticUserMessage = "";

  if (pendingIntentText) {
    userMessage = pendingIntentText;
    source = "send-intent";
    syntheticUserMessage = pendingIntentText;
  } else if (tailUserText) {
    userMessage = tailUserText;
    source = "chat-tail-user";
  } else if (sentUserText) {
    userMessage = sentUserText;
    source = "message-sent";
    if (!latestUserText || latestUserText !== sentUserText) {
      syntheticUserMessage = sentUserText;
    }
  } else if (latestUserText) {
    userMessage = latestUserText;
    source = "chat-last-user";
  }

  return {
    userMessage,
    source,
    sourceLabel: getRecallUserMessageSourceLabel(source),
    recentMessages: buildRecallRecentMessages(
      chat,
      recentContextMessageLimit,
      syntheticUserMessage,
    ),
  };
}

function buildGenerationAfterCommandsRecallInput(type, params = {}, chat) {
  if (params?.automatic_trigger || params?.quiet_prompt) {
    return null;
  }

  const generationType = String(type || "").trim() || "normal";
  if (!["normal", "continue", "regenerate", "swipe"].includes(generationType)) {
    return null;
  }

  return generationType === "normal"
    ? buildNormalGenerationRecallInput(chat)
    : buildHistoryGenerationRecallInput(chat);
}

function buildNormalGenerationRecallInput(chat) {
  const lastNonSystemMessage = getLastNonSystemChatMessage(chat);
  const tailUserText = lastNonSystemMessage?.is_user
    ? normalizeRecallInputText(lastNonSystemMessage?.mes || "")
    : "";
  const textareaText = normalizeRecallInputText(
    pendingRecallSendIntent.text || getSendTextareaValue(),
  );
  const userMessage = tailUserText || textareaText;
  if (!userMessage) return null;

  return {
    overrideUserMessage: userMessage,
    overrideSource: tailUserText ? "chat-tail-user" : "send-intent",
    overrideSourceLabel: tailUserText ? "当前用户楼层" : "发送意图",
    includeSyntheticUserMessage: !tailUserText,
  };
}

function buildHistoryGenerationRecallInput(chat) {
  const latestUserText = normalizeRecallInputText(
    getLatestUserChatMessage(chat)?.mes || lastRecallSentUserMessage.text,
  );
  if (!latestUserText) return null;

  return {
    overrideUserMessage: latestUserText,
    overrideSource: "chat-last-user",
    overrideSourceLabel: "历史最后用户楼层",
    includeSyntheticUserMessage: false,
  };
}

function buildPreGenerationRecallKey(type, options = {}) {
  return [
    getCurrentChatId(),
    String(type || "normal").trim() || "normal",
    hashRecallInput(options.overrideUserMessage || ""),
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
  const transaction = generationRecallTransactions.get(transactionId) || {
    id: transactionId,
    chatId: normalizedChatId,
    generationType: normalizedGenerationType,
    recallKey: normalizedRecallKey,
    hookStates: {},
    createdAt: now,
  };
  transaction.updatedAt = now;
  generationRecallTransactions.set(transactionId, transaction);
  return transaction;
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

function shouldRunRecallForTransaction(transaction, hookName) {
  if (!hookName) return true;
  if (!transaction) return true;
  const hookStates = transaction.hookStates || {};
  if (hookStates[hookName] === "completed") {
    return false;
  }
  if (
    hookName === "GENERATE_BEFORE_COMBINE_PROMPTS" &&
    hookStates.GENERATION_AFTER_COMMANDS === "completed"
  ) {
    return false;
  }
  return true;
}

function createGenerationRecallContext({
  hookName,
  generationType = "normal",
  recallOptions = {},
  chatId = getCurrentChatId(),
} = {}) {
  const recallKey =
    recallOptions.recallKey ||
    buildPreGenerationRecallKey(generationType, recallOptions);
  const transaction = beginGenerationRecallTransaction({
    chatId,
    generationType,
    recallKey,
  });
  return {
    hookName,
    generationType,
    recallKey,
    transaction,
    shouldRun: shouldRunRecallForTransaction(transaction, hookName),
  };
}

function getCurrentChatSeq(context = getContext()) {
  const chat = context?.chat;
  if (Array.isArray(chat) && chat.length > 0) {
    return chat.length - 1;
  }
  return currentGraph?.lastProcessedSeq ?? 0;
}

const BATCH_STAGE_ORDER = ["core", "structural", "semantic", "finalize"];
const BATCH_STAGE_SEVERITY = {
  success: 0,
  partial: 1,
  failed: 2,
};

function createBatchStageStatus(stage, consistency = "strong") {
  return {
    stage,
    outcome: "success",
    consistency,
    warnings: [],
    errors: [],
    artifacts: [],
  };
}

function createBatchStatusSkeleton({ processedRange, extractionCountBefore }) {
  return {
    model: "layered-batch-v1",
    processedRange: Array.isArray(processedRange)
      ? [...processedRange]
      : [-1, -1],
    extractionCountBefore: Number.isFinite(extractionCountBefore)
      ? extractionCountBefore
      : extractionCount,
    extractionCountAfter: Number.isFinite(extractionCount)
      ? extractionCount
      : 0,
    stages: {
      core: createBatchStageStatus("core", "strong"),
      structural: createBatchStageStatus("structural", "weak"),
      semantic: createBatchStageStatus("semantic", "weak"),
      finalize: createBatchStageStatus("finalize", "strong"),
    },
    outcome: "success",
    consistency: "strong",
    completed: false,
    warnings: [],
    errors: [],
  };
}

function setBatchStageOutcome(status, stage, outcome, message = "") {
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

function pushBatchStageArtifact(status, stage, artifact) {
  const stageStatus = status?.stages?.[stage];
  if (!stageStatus || !artifact) return;
  if (!stageStatus.artifacts.includes(artifact)) {
    stageStatus.artifacts.push(artifact);
  }
}

function finalizeBatchStatus(status) {
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
  status.extractionCountAfter = Number.isFinite(extractionCount)
    ? extractionCount
    : status.extractionCountAfter;
  status.warnings = BATCH_STAGE_ORDER.flatMap(
    (stage) => stages[stage]?.warnings || [],
  );
  status.errors = BATCH_STAGE_ORDER.flatMap(
    (stage) => stages[stage]?.errors || [],
  );
  return status;
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
  throwIfAborted(signal, "提取已终止");
  extractionCount++;
  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;
  updateLastExtractedItems(result.newNodeIds || []);
  setBatchStageOutcome(status, "core", "success");

  if (settings.enableConsolidation && result.newNodeIds?.length > 0) {
    try {
      await consolidateMemories({
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
      sleepCycle(currentGraph, settings);
      postProcessArtifacts.push("sleep");
      pushBatchStageArtifact(status, "semantic", "sleep");
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
      postProcessArtifacts.push("compression");
      pushBatchStageArtifact(status, "structural", "compression");
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
      batchStatus: finalizeBatchStatus(status),
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

  return {
    postProcessArtifacts,
    vectorHashesInserted: vectorSync?.insertedHashes || [],
    vectorStats: vectorSync?.stats || getVectorIndexStats(currentGraph),
    vectorError: vectorSync?.error || "",
    warnings: status.warnings,
    batchStatus: finalizeBatchStatus(status),
  };
}

function isAssistantChatMessage(message) {
  return Boolean(message) && !message.is_user && !message.is_system;
}

function getAssistantTurns(chat) {
  const assistantTurns = [];
  // 从 index 1 开始：index 0 是角色卡首条消息（greeting），不参与提取
  for (let index = 1; index < chat.length; index++) {
    if (isAssistantChatMessage(chat[index])) {
      assistantTurns.push(index);
    }
  }
  return assistantTurns;
}

function buildExtractionMessages(chat, startIdx, endIdx, settings) {
  const contextTurns = clampInt(settings.extractContextTurns, 2, 0, 20);
  const contextStart = Math.max(0, startIdx - contextTurns * 2);
  const messages = [];

  for (
    let index = contextStart;
    index <= endIdx && index < chat.length;
    index++
  ) {
    const msg = chat[index];
    if (msg.is_system) continue;
    messages.push({
      seq: index,
      role: msg.is_user ? "user" : "assistant",
      content: msg.mes || "",
    });
  }

  return messages;
}

function getChatIndexForPlayableSeq(chat, playableSeq) {
  if (!Array.isArray(chat) || !Number.isFinite(playableSeq)) return null;

  let currentSeq = -1;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (message?.is_system) continue;
    currentSeq++;
    if (currentSeq >= playableSeq) {
      return index;
    }
  }

  return chat.length;
}

function getChatIndexForAssistantSeq(chat, assistantSeq) {
  if (!Array.isArray(chat) || !Number.isFinite(assistantSeq)) return null;

  let currentSeq = -1;
  for (let index = 0; index < chat.length; index++) {
    if (!isAssistantChatMessage(chat[index])) continue;
    currentSeq++;
    if (currentSeq >= assistantSeq) {
      return index;
    }
  }

  return chat.length;
}

function resolveDirtyFloorFromMutationMeta(trigger, primaryArg, meta, chat) {
  if (!meta || typeof meta !== "object") return null;

  const candidates = [];
  const isDeleteTrigger = String(trigger || "").includes("message-deleted");
  const minExtractableFloor = getMinExtractableAssistantFloor(chat);

  // 删除后 chat 已是收缩后的状态，删除事件携带的 seq 更接近“被删区间起点”，
  // 因此这里额外向前退一层，避免恢复仍停留在被删楼层对应的旧图谱边界。
  if (!isDeleteTrigger && Number.isFinite(meta.messageId)) {
    candidates.push({
      floor: meta.messageId,
      source: `${trigger}-meta`,
    });
  }
  if (Number.isFinite(meta.deletedPlayableSeqFrom)) {
    const floor = getChatIndexForPlayableSeq(chat, meta.deletedPlayableSeqFrom);
    if (Number.isFinite(floor)) {
      candidates.push({
        floor: Number.isFinite(minExtractableFloor)
          ? Math.max(minExtractableFloor, floor - 1)
          : Math.max(0, floor - 1),
        source: `${trigger}-meta-delete-boundary`,
      });
    }
  }
  if (Number.isFinite(meta.deletedAssistantSeqFrom)) {
    const floor = getChatIndexForAssistantSeq(
      chat,
      meta.deletedAssistantSeqFrom,
    );
    if (Number.isFinite(floor)) {
      candidates.push({
        floor: Number.isFinite(minExtractableFloor)
          ? Math.max(minExtractableFloor, floor - 1)
          : Math.max(0, floor - 1),
        source: `${trigger}-meta-delete-boundary`,
      });
    }
  }
  if (!isDeleteTrigger && Number.isFinite(meta.playableSeq)) {
    const floor = getChatIndexForPlayableSeq(chat, meta.playableSeq);
    if (Number.isFinite(floor)) {
      candidates.push({
        floor,
        source: `${trigger}-meta`,
      });
    }
  }
  if (!isDeleteTrigger && Number.isFinite(meta.assistantSeq)) {
    const floor = getChatIndexForAssistantSeq(chat, meta.assistantSeq);
    if (Number.isFinite(floor)) {
      candidates.push({
        floor,
        source: `${trigger}-meta`,
      });
    }
  }
  if (!isDeleteTrigger && Number.isFinite(primaryArg)) {
    candidates.push({
      floor: primaryArg,
      source: `${trigger}-meta`,
    });
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, current) =>
    current.floor < earliest.floor ? current : earliest,
  );
}

function getLastProcessedAssistantFloor() {
  ensureCurrentGraphRuntimeState();
  return Number.isFinite(
    currentGraph?.historyState?.lastProcessedAssistantFloor,
  )
    ? currentGraph.historyState.lastProcessedAssistantFloor
    : -1;
}

function getMinExtractableAssistantFloor(chat) {
  const assistantTurns = getAssistantTurns(chat);
  return assistantTurns.length > 0 ? assistantTurns[0] : null;
}

function clampRecoveryStartFloor(chat, floor) {
  if (!Number.isFinite(floor)) return floor;

  const minExtractableFloor = getMinExtractableAssistantFloor(chat);
  if (!Number.isFinite(minExtractableFloor)) {
    return floor;
  }

  return Math.max(floor, minExtractableFloor);
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

  pendingHistoryRecoveryTrigger = trigger;
  clearTimeout(pendingHistoryRecoveryTimer);
  pendingHistoryRecoveryTimer = setTimeout(() => {
    pendingHistoryRecoveryTimer = null;
    const effectiveTrigger = pendingHistoryRecoveryTrigger || trigger;
    pendingHistoryRecoveryTrigger = "";
    if (!getSettings().enabled) return;

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
    saveGraphToChat();
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
    saveGraphToChat();
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
  ensureCurrentGraphRuntimeState();
  throwIfAborted(signal, "提取已终止");
  const lastProcessed = getLastProcessedAssistantFloor();
  const extractionCountBefore = extractionCount;
  const beforeSnapshot = cloneGraphSnapshot(currentGraph);
  const messages = buildExtractionMessages(chat, startIdx, endIdx, settings);
  const batchStatus = createBatchStatusSkeleton({
    processedRange: [startIdx, endIdx],
    extractionCountBefore,
  });

  console.log(
    `[ST-BME] 开始提取: 楼层 ${startIdx}-${endIdx}` +
      (smartTriggerDecision?.triggered
        ? ` [智能触发 score=${smartTriggerDecision.score}; ${smartTriggerDecision.reasons.join(" / ")}]`
        : ""),
  );

  const result = await extractMemories({
    graph: currentGraph,
    messages,
    startSeq: startIdx,
    endSeq: endIdx,
    lastProcessedSeq: lastProcessed,
    schema: getSchema(),
    embeddingConfig: getEmbeddingConfig(),
    extractPrompt: undefined,
    settings,
    signal,
    onStreamProgress: ({ previewText, receivedChars }) => {
      const preview = previewText?.length > 60
        ? "…" + previewText.slice(-60)
        : previewText || "";
      setLastExtractionStatus(
        "AI 生成中",
        `${preview}  [${receivedChars}字]`,
        "running",
        { noticeMarquee: true },
      );
    },
  });

  if (!result.success) {
    setBatchStageOutcome(
      batchStatus,
      "core",
      "failed",
      result?.error || "提取阶段未返回有效操作",
    );
    finalizeBatchStatus(batchStatus);
    currentGraph.historyState.lastBatchStatus = batchStatus;
    return {
      success: false,
      result,
      effects: null,
      batchStatus,
      error: result?.error || "提取阶段未返回有效操作",
    };
  }

  setBatchStageOutcome(batchStatus, "core", "success");
  const effects = await handleExtractionSuccess(
    result,
    endIdx,
    settings,
    signal,
    batchStatus,
  );
  const finalizedBatchStatus =
    effects?.batchStatus || finalizeBatchStatus(batchStatus);
  currentGraph.historyState.lastBatchStatus = {
    ...finalizedBatchStatus,
    historyAdvanced: shouldAdvanceProcessedHistory(finalizedBatchStatus),
  };

  if (currentGraph.historyState.lastBatchStatus.historyAdvanced) {
    updateProcessedHistorySnapshot(chat, endIdx);
  }

  const afterSnapshot = cloneGraphSnapshot(currentGraph);
  const postProcessArtifacts = computePostProcessArtifacts(
    beforeSnapshot,
    afterSnapshot,
    effects?.postProcessArtifacts || [],
  );
  appendBatchJournal(
    currentGraph,
    createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
      processedRange: [startIdx, endIdx],
      postProcessArtifacts,
      vectorHashesInserted: effects?.vectorHashesInserted || [],
      extractionCountBefore,
    }),
  );
  saveGraphToChat();

  return {
    success: finalizedBatchStatus.completed,
    result,
    effects,
    batchStatus: finalizedBatchStatus,
    error: finalizedBatchStatus.completed
      ? ""
      : effects?.vectorError ||
        finalizedBatchStatus.errors?.[0] ||
        "批次未完成 finalize 闭环",
  };
}

async function replayExtractionFromHistory(chat, settings, signal = undefined) {
  let replayedBatches = 0;

  while (true) {
    throwIfAborted(signal, "历史恢复已终止");
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

  vectorState.replayRequiredNodeIds = [...replayRequiredNodeIds];
  vectorState.dirty = true;
  vectorState.dirtyReason =
    recoveryPlan?.dirtyReason ||
    vectorState.dirtyReason ||
    "history-recovery-replay";
  const fallbackFloor = Number.isFinite(dirtyFallbackFloor)
    ? dirtyFallbackFloor
    : currentGraph.historyState?.historyDirtyFrom;
  vectorState.pendingRepairFromFloor = Number.isFinite(
    recoveryPlan?.pendingRepairFromFloor,
  )
    ? recoveryPlan.pendingRepairFromFloor
    : Number.isFinite(fallbackFloor)
      ? fallbackFloor
      : null;
  vectorState.lastWarning = recoveryPlan?.legacyGapFallback
    ? "历史恢复检测到 legacy-gap，向量索引需按受影响后缀修复"
    : "历史恢复后需要修复受影响后缀的向量索引";
}

function rollbackAffectedJournals(graph, affectedJournals = []) {
  for (let index = affectedJournals.length - 1; index >= 0; index--) {
    rollbackBatch(graph, affectedJournals[index]);
  }
  graph.batchJournal = Array.isArray(graph.batchJournal)
    ? graph.batchJournal.slice(
        0,
        Math.max(0, graph.batchJournal.length - affectedJournals.length),
      )
    : [];
}

function pruneProcessedMessageHashesFromFloor(graph, fromFloor) {
  if (!graph?.historyState?.processedMessageHashes) return;
  if (!Number.isFinite(fromFloor)) return;

  const hashes = graph.historyState.processedMessageHashes;
  for (const key of Object.keys(hashes)) {
    if (Number(key) >= fromFloor) {
      delete hashes[key];
    }
  }
}

async function rollbackGraphForReroll(targetFloor, context = getContext()) {
  ensureCurrentGraphRuntimeState();
  const chatId = getCurrentChatId(context);
  const recoveryPoint = findJournalRecoveryPoint(currentGraph, targetFloor);

  if (!recoveryPoint) {
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: targetFloor,
      effectiveFromFloor: null,
      recoveryPath: "unavailable",
      affectedBatchCount: 0,
      error:
        "未找到可用的回滚点，无法安全重新提取。请先执行一次历史恢复或重新提取更早的批次。",
    };
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
    rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
    currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
    extractionCount = currentGraph.historyState.extractionCount || 0;
    applyRecoveryPlanToVectorState(recoveryPlan, targetFloor);

    if (
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      await deleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
      );
    }

    await prepareVectorStateForReplay(false, undefined, {
      skipBackendPurge: isBackendVectorConfig(config),
    });
  } else if (recoveryPath === "legacy-snapshot") {
    currentGraph = normalizeGraphRuntimeState(recoveryPoint.snapshotBefore, chatId);
    extractionCount = currentGraph.historyState.extractionCount || 0;
    await prepareVectorStateForReplay(false);
  } else {
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: targetFloor,
      effectiveFromFloor: null,
      recoveryPath,
      affectedBatchCount,
      error: `不支持的回滚路径: ${recoveryPath}`,
    };
  }

  const effectiveFromFloor = Number.isFinite(
    currentGraph.historyState?.lastProcessedAssistantFloor,
  )
    ? currentGraph.historyState.lastProcessedAssistantFloor + 1
    : 0;

  pruneProcessedMessageHashesFromFloor(currentGraph, effectiveFromFloor);
  currentGraph.lastProcessedSeq =
    currentGraph.historyState?.lastProcessedAssistantFloor ?? -1;
  clearHistoryDirty(
    currentGraph,
    buildRecoveryResult("reroll-rollback", {
      fromFloor: targetFloor,
      effectiveFromFloor,
      path: recoveryPath,
      affectedBatchCount,
      detectionSource: "manual-reroll",
      reason: "manual-reroll",
    }),
  );
  saveGraphToChat();
  refreshPanelLiveState();

  return {
    success: true,
    rollbackPerformed: true,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor,
    recoveryPath,
    affectedBatchCount,
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
      rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
      currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
      extractionCount = currentGraph.historyState.extractionCount || 0;
      applyRecoveryPlanToVectorState(recoveryPlan, initialDirtyFrom);

      if (
        isBackendVectorConfig(config) &&
        recoveryPlan.backendDeleteHashes.length > 0
      ) {
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

    replayedBatches = await replayExtractionFromHistory(
      chat,
      settings,
      historySignal,
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
    saveGraphToChat();
    refreshPanelLiveState();
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
      saveGraphToChat();
      return false;
    }
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      extractionCount = 0;
      await prepareVectorStateForReplay(true, historySignal);
      replayedBatches = await replayExtractionFromHistory(
        chat,
        settings,
        historySignal,
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
        }),
      );
      saveGraphToChat();
      refreshPanelLiveState();
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
        },
      );
      saveGraphToChat();
      refreshPanelLiveState();
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
  }
}

/**
 * 提取管线：处理未提取的对话楼层
 */
async function runExtraction() {
  if (isExtracting || !currentGraph) return;

  const settings = getSettings();
  if (!settings.enabled) return;
  if (!(await recoverHistoryIfNeeded("auto-extract"))) return;

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) return;

  const assistantTurns = getAssistantTurns(chat);
  const lastProcessed = getLastProcessedAssistantFloor();
  const unprocessedAssistantTurns = assistantTurns.filter(
    (i) => i > lastProcessed,
  );

  if (unprocessedAssistantTurns.length === 0) return;

  const extractEvery = clampInt(settings.extractEvery, 1, 1, 50);
  const smartTriggerDecision = settings.enableSmartTrigger
    ? getSmartTriggerDecision(chat, lastProcessed, settings)
    : { triggered: false, score: 0, reasons: [] };

  if (
    unprocessedAssistantTurns.length < extractEvery &&
    !smartTriggerDecision.triggered
  ) {
    return;
  }

  const batchAssistantTurns = smartTriggerDecision.triggered
    ? unprocessedAssistantTurns
    : unprocessedAssistantTurns.slice(0, extractEvery);
  const startIdx = batchAssistantTurns[0];
  const endIdx = batchAssistantTurns[batchAssistantTurns.length - 1];
  isExtracting = true;
  const extractionController = beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  setLastExtractionStatus(
    "提取中",
    `楼层 ${startIdx}-${endIdx}${smartTriggerDecision.triggered ? " · 智能触发" : ""}`,
    "running",
    { syncRuntime: true },
  );

  try {
    const batchResult = await executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
      smartTriggerDecision,
      signal: extractionSignal,
    });

    if (!batchResult.success) {
      const message =
        batchResult.error ||
        batchResult?.result?.error ||
        "提取批次未返回有效结果";
      console.warn("[ST-BME] 提取批次未返回有效结果:", message);
      notifyExtractionIssue(message);
      return;
    }

    setLastExtractionStatus(
      "提取完成",
      `楼层 ${startIdx}-${endIdx} · 新建 ${batchResult.result?.newNodes || 0} · 更新 ${batchResult.result?.updatedNodes || 0} · 新边 ${batchResult.result?.newEdges || 0}`,
      "success",
      { syncRuntime: true },
    );
  } catch (e) {
    if (isAbortError(e)) {
      setLastExtractionStatus(
        "提取已终止",
        e?.message || "已手动终止当前提取",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    console.error("[ST-BME] 提取失败:", e);
    notifyExtractionIssue(e?.message || String(e) || "自动提取失败");
  } finally {
    finishStageAbortController("extraction", extractionController);
    isExtracting = false;
  }
}

function getRecallHookLabel(hookName = "") {
  switch (hookName) {
    case "GENERATION_AFTER_COMMANDS":
      return "hook GENERATION_AFTER_COMMANDS";
    case "GENERATE_BEFORE_COMBINE_PROMPTS":
      return "hook GENERATE_BEFORE_COMBINE_PROMPTS";
    default:
      return "";
  }
}

function applyRecallInjection(settings, recallInput, recentMessages, result) {
  const injectionText = formatInjection(result, getSchema()).trim();
  lastInjectionContent = injectionText;
  const retrievalMeta = result?.meta?.retrieval || {};
  const llmMeta = retrievalMeta.llm || {
    status: settings.recallEnableLLM ? "unknown" : "disabled",
    reason: settings.recallEnableLLM ? "未提供 LLM 状态" : "LLM 精排已关闭",
    candidatePool: 0,
  };

  if (injectionText) {
    const tokens = estimateTokens(injectionText);
    console.log(
      `[ST-BME] 注入 ${tokens} 估算 tokens, Core=${result.stats.coreCount}, Recall=${result.stats.recallCount}`,
    );
  }

  const injectionTransport = applyModuleInjectionPrompt(injectionText, settings);
  recordInjectionSnapshot("recall", {
    taskType: "recall",
    source: recallInput.source,
    sourceLabel: recallInput.sourceLabel,
    hookName: recallInput.hookName,
    recentMessages,
    selectedNodeIds: result.selectedNodeIds || [],
    retrievalMeta,
    llmMeta,
    stats: result.stats || {},
    injectionText,
    transport: injectionTransport,
  });

  currentGraph.lastRecallResult = result.selectedNodeIds;
  updateLastRecalledItems(result.selectedNodeIds || []);
  saveGraphToChat();

  const llmLabel =
    llmMeta.status === "llm"
      ? "LLM 精排完成"
      : llmMeta.status === "fallback"
        ? "LLM 回退评分"
        : llmMeta.status === "disabled"
          ? "仅评分排序"
          : "召回完成";
  const hookLabel = getRecallHookLabel(recallInput.hookName);
  setLastRecallStatus(
    llmLabel,
    [
      hookLabel,
      recallInput.sourceLabel,
      `ctx ${recentMessages.length}`,
      `vector ${retrievalMeta.vectorHits ?? 0}`,
      `diffusion ${retrievalMeta.diffusionHits ?? 0}`,
      `llm pool ${llmMeta.candidatePool ?? 0}`,
      `recall ${result.stats.recallCount}`,
    ]
      .filter(Boolean)
      .join(" · "),
    llmMeta.status === "fallback" ? "warning" : "success",
    {
      syncRuntime: true,
      toastKind: "",
    },
  );

  if (llmMeta.status === "fallback") {
    const now = Date.now();
    if (now - lastRecallFallbackNoticeAt > 15000) {
      lastRecallFallbackNoticeAt = now;
      toastr.warning(
        llmMeta.reason || "LLM 精排未返回有效结果，已回退到评分排序",
        "ST-BME 召回提示",
        { timeOut: 4500 },
      );
    }
  }

  return { injectionText, retrievalMeta, llmMeta };
}

/**
 * 召回管线：检索并注入记忆
 */
async function runRecall(options = {}) {
  if (isRecalling || !currentGraph) return false;

  const settings = getSettings();
  if (!settings.enabled || !settings.recallEnabled) return false;
  if (!(await recoverHistoryIfNeeded("pre-recall"))) return false;

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) return false;

  isRecalling = true;
  const recallController = beginStageAbortController("recall");
  const recallSignal = recallController.signal;
  if (options.signal) {
    if (options.signal.aborted) {
      recallController.abort(
        options.signal.reason || createAbortError("宿主已终止生成"),
      );
    } else {
      options.signal.addEventListener(
        "abort",
        () =>
          recallController.abort(
            options.signal.reason || createAbortError("宿主已终止生成"),
          ),
        { once: true },
      );
    }
  }

  try {
    await ensureVectorReadyIfNeeded("pre-recall", recallSignal);
    const recentContextMessageLimit = clampInt(
      settings.recallLlmContextMessages,
      4,
      0,
      20,
    );
    const recallInput = resolveRecallInput(
      chat,
      recentContextMessageLimit,
      options,
    );
    const userMessage = recallInput.userMessage;
    const recentMessages = recallInput.recentMessages;

    if (!userMessage) return false;

    recallInput.hookName = options.hookName || "";

    console.log("[ST-BME] 开始召回", {
      source: recallInput.source,
      sourceLabel: recallInput.sourceLabel,
      hookName: recallInput.hookName,
      userMessageLength: userMessage.length,
      recentMessages: recentMessages.length,
    });
    setLastRecallStatus(
      "召回中",
      [
        getRecallHookLabel(recallInput.hookName),
        `来源 ${recallInput.sourceLabel}`,
        `上下文 ${recentMessages.length} 条`,
        `当前用户消息长度 ${userMessage.length}`,
      ]
        .filter(Boolean)
        .join(" · "),
      "running",
      { syncRuntime: true },
    );
    if (recallInput.source === "send-intent") {
      pendingRecallSendIntent = createRecallInputRecord();
    }

    const result = await retrieve({
      graph: currentGraph,
      userMessage,
      recentMessages,
      embeddingConfig: getEmbeddingConfig(),
      schema: getSchema(),
      signal: recallSignal,
      settings,
      onStreamProgress: ({ previewText, receivedChars }) => {
        const preview = previewText?.length > 60
          ? "…" + previewText.slice(-60)
          : previewText || "";
        setLastRecallStatus(
          "AI 生成中",
          `${preview}  [${receivedChars}字]`,
          "running",
          { syncRuntime: true, noticeMarquee: true },
        );
      },
      options: {
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
      },
    });

    applyRecallInjection(settings, recallInput, recentMessages, result);
    return true;
  } catch (e) {
    if (isAbortError(e)) {
      setLastRecallStatus(
        "召回已终止",
        e?.message || "已手动终止当前召回",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return false;
    }
    console.error("[ST-BME] 召回失败:", e);
    const message = e?.message || String(e);
    setLastRecallStatus("召回失败", message, "error", {
      syncRuntime: true,
      toastKind: "",
    });
    toastr.error(`召回失败: ${message}`);
    return false;
  } finally {
    finishStageAbortController("recall", recallController);
    isRecalling = false;
    refreshPanelLiveState();
  }
}

// ==================== 事件钩子 ====================

function onChatChanged() {
  clearPendingHistoryMutationChecks();
  clearTimeout(pendingHistoryRecoveryTimer);
  pendingHistoryRecoveryTimer = null;
  pendingHistoryRecoveryTrigger = "";
  clearPendingGraphLoadRetry();
  skipBeforeCombineRecallUntil = 0;
  lastPreGenerationRecallKey = "";
  lastPreGenerationRecallAt = 0;
  abortAllRunningStages();
  dismissAllStageNotices();
  loadGraphFromChat();
  clearInjectionState();
  clearRecallInputTracking();
  installSendIntentHooks();
}

function onMessageSent(messageId) {
  const context = getContext();
  const chat = context?.chat;
  const message =
    Array.isArray(chat) && Number.isFinite(messageId) ? chat[messageId] : null;

  if (!message?.is_user) return;
  recordRecallSentUserMessage(messageId, message.mes || "");
}

function onMessageDeleted(chatLengthOrMessageId, meta = null) {
  clearInjectionState();
  scheduleHistoryMutationRecheck(
    "message-deleted",
    chatLengthOrMessageId,
    meta,
  );
}

function onMessageEdited(messageId, meta = null) {
  clearInjectionState();
  scheduleHistoryMutationRecheck("message-edited", messageId, meta);
}

function onMessageSwiped(messageId, meta = null) {
  clearInjectionState();
  scheduleHistoryMutationRecheck("message-swiped", messageId, meta);
}

async function onGenerationAfterCommands(type, params = {}, dryRun = false) {
  if (dryRun) return;

  const context = getContext();
  const chat = context?.chat;
  const recallOptions = buildGenerationAfterCommandsRecallInput(
    type,
    params,
    chat,
  );
  if (!recallOptions?.overrideUserMessage) return;

  const recallContext = createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: String(type || "normal").trim() || "normal",
    recallOptions,
  });
  if (!recallContext.shouldRun) {
    return;
  }

  markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    "running",
  );
  const didRecall = await runRecall({
    ...recallOptions,
    recallKey: recallContext.recallKey,
    hookName: recallContext.hookName,
    signal: params?.signal,
  });

  markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    didRecall ? "completed" : "pending",
  );
}

async function onBeforeCombinePrompts() {
  const context = getContext();
  const chat = context?.chat;
  const recallOptions =
    buildNormalGenerationRecallInput(chat) ||
    buildHistoryGenerationRecallInput(chat) ||
    {};
  const recallContext = createGenerationRecallContext({
    hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
    generationType: "normal",
    recallOptions,
  });
  if (!recallContext.shouldRun) {
    return;
  }

  markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    "running",
  );
  const didRecall = await runRecall({
    ...recallOptions,
    recallKey: recallContext.recallKey,
    hookName: recallContext.hookName,
  });
  markGenerationRecallTransactionHookState(
    recallContext.transaction,
    recallContext.hookName,
    didRecall ? "completed" : "pending",
  );
}

function onMessageReceived() {
  // 新消息到达，图状态可能需要更新
  if (currentGraph) {
    saveGraphToChat();
  }

  if (
    pendingRecallSendIntent.text &&
    !isFreshRecallInputRecord(pendingRecallSendIntent)
  ) {
    pendingRecallSendIntent = createRecallInputRecord();
  }

  const context = getContext();
  const chat = context?.chat;
  const lastMessage =
    Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : null;

  if (isAssistantChatMessage(lastMessage)) {
    queueMicrotask(() => {
      void runExtraction().catch((error) => {
        console.error("[ST-BME] 异步自动提取失败:", error);
        notifyExtractionIssue(
          error?.message || String(error) || "自动提取失败",
        );
      });
    });
  }
}

// ==================== UI 操作 ====================

async function onViewGraph() {
  if (!currentGraph) {
    toastr.warning("当前没有加载的图谱");
    return;
  }

  const stats = getGraphStats(currentGraph);
  const statsText = [
    `节点: ${stats.activeNodes} 活跃 / ${stats.archivedNodes} 归档`,
    `边: ${stats.totalEdges}`,
    `最后处理楼层: ${stats.lastProcessedSeq}`,
    `类型分布: ${
      Object.entries(stats.typeCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(空)"
    }`,
  ].join("\n");

  toastr.info(statsText, "ST-BME 图谱状态", { timeOut: 10000 });
}

async function onRebuild() {
  if (!confirm("确定要从当前聊天重建图谱？这将清除现有图谱数据。")) return;

  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) {
    toastr.warning("当前聊天上下文不可用，无法重建");
    return;
  }

  const previousGraphSnapshot = currentGraph
    ? cloneGraphSnapshot(currentGraph)
    : cloneGraphSnapshot(
        normalizeGraphRuntimeState(createEmptyGraph(), getCurrentChatId()),
      );
  const previousUiState = snapshotRuntimeUiState();
  const settings = getSettings();

  currentGraph = normalizeGraphRuntimeState(
    createEmptyGraph(),
    getCurrentChatId(),
  );
  currentGraph.batchJournal = [];
  clearInjectionState();

  try {
    await prepareVectorStateForReplay(true);
    const replayedBatches = await replayExtractionFromHistory(chat, settings);
    clearHistoryDirty(
      currentGraph,
      buildRecoveryResult("full-rebuild", {
        fromFloor: 0,
        batches: replayedBatches,
        path: "full-rebuild",
        detectionSource: "manual-rebuild",
        affectedBatchCount: currentGraph.batchJournal?.length || 0,
        replayedBatchCount: replayedBatches,
        reason: "用户手动触发全量重建",
      }),
    );
    saveGraphToChat();

    if (currentGraph.vectorIndexState?.lastWarning) {
      toastr.warning(
        `图谱已重建，但向量索引仍待修复: ${currentGraph.vectorIndexState.lastWarning}`,
      );
    } else {
      toastr.success("图谱与向量索引已按当前聊天全量重建");
    }
  } catch (error) {
    currentGraph = normalizeGraphRuntimeState(
      previousGraphSnapshot,
      getCurrentChatId(),
    );
    restoreRuntimeUiState(previousUiState);
    saveGraphToChat();
    throw new Error(
      `图谱重建失败，已恢复到重建前状态: ${error?.message || error}`,
    );
  }
}

async function onManualCompress() {
  if (!currentGraph) return;
  const beforeSnapshot = cloneGraphSnapshot(currentGraph);

  const result = await compressAll(
    currentGraph,
    getSchema(),
    getEmbeddingConfig(),
    false,
    undefined,
    undefined,
    getSettings(),
  );
  await recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["compression"],
  });

  toastr.info(`压缩完成: 新建 ${result.created}, 归档 ${result.archived}`);
}

async function onExportGraph() {
  if (!currentGraph) return;

  const json = exportGraph(currentGraph);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `st-bme-graph-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  toastr.success("图谱已导出");
}

async function onImportGraph() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      currentGraph = normalizeGraphRuntimeState(
        importGraph(text),
        getCurrentChatId(),
      );
      markVectorStateDirty("导入图谱后需要重建向量索引");
      extractionCount = 0;
      lastExtractedItems = [];
      updateLastRecalledItems(currentGraph.lastRecallResult || []);
      clearInjectionState();
      saveGraphToChat();
      toastr.success("图谱已导入");
    } catch (err) {
      toastr.error(`导入失败: ${err.message}`);
    }
  };
  input.click();
}

async function onViewLastInjection() {
  if (!lastInjectionContent) {
    toastr.info("暂无注入内容");
    return;
  }

  // 简单弹窗显示
  const popup = document.createElement("div");
  popup.style.cssText =
    "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;color:#eee;padding:24px;border-radius:12px;max-width:80vw;max-height:80vh;overflow:auto;z-index:99999;white-space:pre-wrap;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.5);";
  popup.textContent = lastInjectionContent;

  const close = document.createElement("button");
  close.textContent = "关闭";
  close.style.cssText =
    "position:absolute;top:8px;right:12px;background:#e94560;color:white;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;";
  close.onclick = () => popup.remove();
  popup.appendChild(close);

  document.body.appendChild(popup);
}

async function onTestEmbedding() {
  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);
  if (!validation.valid) {
    toastr.warning(validation.error);
    return;
  }

  toastr.info("正在测试 Embedding API 连通性...");
  const result = await testVectorConnection(config, getCurrentChatId());

  if (result.success) {
    toastr.success(`连接成功！向量维度: ${result.dimensions}`);
  } else {
    toastr.error(`连接失败: ${result.error}`);
  }
}

async function onTestMemoryLLM() {
  toastr.info("正在测试记忆 LLM 连通性...");
  const result = await testLLMConnection();

  if (result.success) {
    toastr.success(`连接成功！模式: ${result.mode}`);
  } else {
    toastr.error(`连接失败: ${result.error}`);
  }
}

async function onFetchMemoryLLMModels() {
  toastr.info("正在拉取记忆 LLM 模型列表...");
  const result = await fetchMemoryLLMModels();

  if (result.success) {
    toastr.success(`已拉取 ${result.models.length} 个记忆 LLM 模型`);
  } else {
    toastr.error(`拉取失败: ${result.error}`);
  }

  return result;
}

async function onFetchEmbeddingModels(mode = null) {
  const config = getEmbeddingConfig(mode);
  const targetMode = mode || config?.mode || "direct";
  const validation = validateVectorConfig(config);
  if (!validation.valid) {
    toastr.warning(validation.error);
    return { success: false, models: [], error: validation.error };
  }

  toastr.info("正在拉取 Embedding 模型列表...");
  const result = await fetchAvailableEmbeddingModels(config);

  if (result.success) {
    const modeLabel = targetMode === "backend" ? "后端" : "直连";
    toastr.success(
      `已拉取 ${result.models.length} 个${modeLabel} Embedding 模型`,
    );
  } else {
    toastr.error(`拉取失败: ${result.error}`);
  }

  return result;
}

async function onManualExtract() {
  if (isExtracting) {
    toastr.info("记忆提取正在进行中，请稍候");
    return;
  }
  if (!(await recoverHistoryIfNeeded("manual-extract"))) return;
  if (!currentGraph)
    currentGraph = normalizeGraphRuntimeState(
      createEmptyGraph(),
      getCurrentChatId(),
    );

  const context = getContext();
  const chat = context.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    toastr.info("当前聊天为空，暂无可提取内容");
    return;
  }

  const assistantTurns = getAssistantTurns(chat);
  const lastProcessed = getLastProcessedAssistantFloor();
  const pendingAssistantTurns = assistantTurns.filter((i) => i > lastProcessed);
  if (pendingAssistantTurns.length === 0) {
    toastr.info("没有待提取的新回复");
    return;
  }

  const settings = getSettings();
  const extractEvery = clampInt(settings.extractEvery, 1, 1, 50);
  const totals = {
    newNodes: 0,
    updatedNodes: 0,
    newEdges: 0,
    batches: 0,
  };
  const warnings = [];

  isExtracting = true;
  const extractionController = beginStageAbortController("extraction");
  const extractionSignal = extractionController.signal;
  setLastExtractionStatus(
    "手动提取中",
    `待处理 assistant 楼层 ${pendingAssistantTurns.length} 条`,
    "running",
    { syncRuntime: true, toastKind: "info", toastTitle: "ST-BME 手动提取" },
  );
  try {
    while (true) {
      const pendingTurns = getAssistantTurns(chat).filter(
        (i) => i > getLastProcessedAssistantFloor(),
      );
      if (pendingTurns.length === 0) break;

      const batchAssistantTurns = pendingTurns.slice(0, extractEvery);
      const startIdx = batchAssistantTurns[0];
      const endIdx = batchAssistantTurns[batchAssistantTurns.length - 1];
      const batchResult = await executeExtractionBatch({
        chat,
        startIdx,
        endIdx,
        settings,
        signal: extractionSignal,
      });

      if (!batchResult.success) {
        throw new Error(
          batchResult.error ||
            batchResult?.result?.error ||
            "手动提取未返回有效结果",
        );
      }

      totals.newNodes += batchResult.result.newNodes || 0;
      totals.updatedNodes += batchResult.result.updatedNodes || 0;
      totals.newEdges += batchResult.result.newEdges || 0;
      totals.batches++;

      if (Array.isArray(batchResult.effects?.warnings)) {
        warnings.push(...batchResult.effects.warnings);
      }
    }

    if (totals.batches === 0) {
      toastr.info("没有待提取的新回复");
      return;
    }

    toastr.success(
      `提取完成：${totals.batches} 批，新建 ${totals.newNodes}，更新 ${totals.updatedNodes}，新边 ${totals.newEdges}`,
    );
    setLastExtractionStatus(
      "手动提取完成",
      `${totals.batches} 批 · 新建 ${totals.newNodes} · 更新 ${totals.updatedNodes} · 新边 ${totals.newEdges}`,
      "success",
      {
        syncRuntime: true,
        toastKind: "success",
        toastTitle: "ST-BME 手动提取",
      },
    );
    if (warnings.length > 0) {
      toastr.warning(warnings.slice(0, 2).join("；"), "ST-BME 提取警告", {
        timeOut: 5000,
      });
    }
  } catch (e) {
    if (isAbortError(e)) {
      setLastExtractionStatus(
        "手动提取已终止",
        e?.message || "已手动终止当前提取",
        "warning",
        {
          syncRuntime: true,
        },
      );
      return;
    }
    console.error("[ST-BME] 手动提取失败:", e);
    setLastExtractionStatus("手动提取失败", e?.message || String(e), "error", {
      syncRuntime: true,
      toastKind: "",
      toastTitle: "ST-BME 手动提取",
    });
    toastr.error(`手动提取失败: ${e.message || e}`);
  } finally {
    finishStageAbortController("extraction", extractionController);
    isExtracting = false;
  }
}

async function onReroll({ fromFloor } = {}) {
  if (isExtracting) {
    toastr.info("记忆提取正在进行中，请稍候");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "busy",
      affectedBatchCount: 0,
      error: "记忆提取正在进行中",
    };
  }
  if (!currentGraph) {
    toastr.info("图谱为空，无需重 Roll");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "empty-graph",
      affectedBatchCount: 0,
      error: "图谱为空",
    };
  }

  const context = getContext();
  const chat = context.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    toastr.info("当前聊天为空");
    return {
      success: false,
      rollbackPerformed: false,
      extractionTriggered: false,
      requestedFloor: null,
      effectiveFromFloor: null,
      recoveryPath: "empty-chat",
      affectedBatchCount: 0,
      error: "当前聊天为空",
    };
  }

  // 确定回滚起点
  let targetFloor = Number.isFinite(fromFloor) ? fromFloor : null;
  if (targetFloor === null) {
    // 默认：重做最新 AI 楼
    const assistantTurns = getAssistantTurns(chat);
    if (assistantTurns.length === 0) {
      toastr.info("聊天中没有 AI 回复");
      return {
        success: false,
        rollbackPerformed: false,
        extractionTriggered: false,
        requestedFloor: null,
        effectiveFromFloor: null,
        recoveryPath: "no-assistant-turn",
        affectedBatchCount: 0,
        error: "聊天中没有 AI 回复",
      };
    }
    targetFloor = assistantTurns[assistantTurns.length - 1];
  }

  const lastProcessed = getLastProcessedAssistantFloor();
  const alreadyExtracted = targetFloor <= lastProcessed;

  if (!alreadyExtracted) {
    // 目标楼层未提取过 → 直接走手动提取即可，不需要回滚
    toastr.info("该楼层尚未提取，直接执行提取…", "ST-BME 重 Roll", {
      timeOut: 2000,
    });
    await onManualExtract();
    return {
      success: true,
      rollbackPerformed: false,
      extractionTriggered: true,
      requestedFloor: targetFloor,
      effectiveFromFloor: lastProcessed + 1,
      recoveryPath: "direct-extract",
      affectedBatchCount: 0,
      extractionStatus: lastExtractionStatus?.level || "idle",
      error: "",
    };
  }

  console.log(`[ST-BME] 重 Roll 开始，目标楼层: ${targetFloor}`);
  const rollbackResult = await rollbackGraphForReroll(targetFloor, context);
  if (!rollbackResult.success) {
    toastr.error(rollbackResult.error, "ST-BME 重 Roll");
    return rollbackResult;
  }

  const rerollDesc =
    rollbackResult.effectiveFromFloor !== targetFloor
      ? `已按批次边界回滚到楼层 ${rollbackResult.effectiveFromFloor} 开始重新提取…`
      : `已回滚到楼层 ${targetFloor} 开始重新提取…`;
  toastr.info(rerollDesc, "ST-BME 重 Roll", {
    timeOut: 2500,
  });

  await onManualExtract();
  return {
    ...rollbackResult,
    extractionTriggered: true,
    extractionStatus: lastExtractionStatus?.level || "idle",
  };
}

async function onManualSleep() {
  if (!currentGraph) return;
  const beforeSnapshot = cloneGraphSnapshot(currentGraph);
  const result = sleepCycle(currentGraph, getSettings());
  await recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["sleep"],
  });
  toastr.info(`执行完成：归档 ${result.forgotten} 个节点`);
}

async function onManualSynopsis() {
  if (!currentGraph) return;
  const beforeSnapshot = cloneGraphSnapshot(currentGraph);
  await generateSynopsis({
    graph: currentGraph,
    schema: getSchema(),
    currentSeq: getCurrentChatSeq(),
    customPrompt: undefined,
    settings: getSettings(),
  });
  await recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["synopsis"],
  });
  toastr.success("概要生成完成");
}

async function onManualEvolve() {
  if (!currentGraph) return;

  const candidateIds = lastExtractedItems
    .map((item) => item.id)
    .filter(Boolean);
  if (candidateIds.length === 0) {
    toastr.info("暂无最近提取节点可用于进化");
    return;
  }

  const beforeSnapshot = cloneGraphSnapshot(currentGraph);
  const result = await consolidateMemories({
    graph: currentGraph,
    newNodeIds: candidateIds,
    embeddingConfig: getEmbeddingConfig(),
    customPrompt: undefined,
    settings: getSettings(),
    options: {
      neighborCount: getSettings().consolidationNeighborCount,
      conflictThreshold: getSettings().consolidationThreshold,
    },
  });
  await recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["consolidation"],
  });
  toastr.success(
    `整合完成：合并 ${result.merged}，跳过 ${result.skipped}，保留 ${result.kept}，进化 ${result.evolved}，新链接 ${result.connections}，回溯更新 ${result.updates}`,
  );
}

async function onRebuildVectorIndex(range = null) {
  ensureCurrentGraphRuntimeState();
  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);
  if (!validation.valid) {
    toastr.warning(validation.error);
    return;
  }

  const vectorController = beginStageAbortController("vector");
  try {
    const result = await syncVectorState({
      force: true,
      purge: isBackendVectorConfig(config) && !range,
      range,
      signal: vectorController.signal,
    });

    saveGraphToChat();
    if (result?.aborted) {
      return;
    }
    if (result?.error) {
      throw new Error(result.error);
    }
    toastr.success(
      range
        ? `范围向量重建完成：indexed=${result.stats.indexed}, pending=${result.stats.pending}`
        : `当前聊天向量重建完成：indexed=${result.stats.indexed}, pending=${result.stats.pending}`,
    );
  } finally {
    finishStageAbortController("vector", vectorController);
  }
}

async function onReembedDirect() {
  const config = getEmbeddingConfig();
  if (!isDirectVectorConfig(config)) {
    toastr.info("当前不是直连模式，无需执行重嵌");
    return;
  }

  await onRebuildVectorIndex();
}

// ==================== 初始化 ====================

(async function init() {
  await loadServerSettings();
  initializeHostCapabilityBridge();
  installSendIntentHooks();

  // 注册事件钩子
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  if (event_types.MESSAGE_SENT) {
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
  }
  registerGenerationAfterCommands(onGenerationAfterCommands);
  registerBeforeCombinePrompts(onBeforeCombinePrompts);
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
  eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
  eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
  if (event_types.MESSAGE_UPDATED) {
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageEdited);
  }

  // 加载当前聊天的图谱
  clearPendingGraphLoadRetry();
  loadGraphFromChat();

  // ==================== 操控面板初始化 ====================

  try {
    // 动态加载面板模块
    _panelModule = await import("./panel.js");
    _themesModule = await import("./themes.js");

    // 应用主题
    const settings = getSettings();
    _themesModule.applyTheme(settings.panelTheme || "crimson");

    // 初始化操控面板
    await _panelModule.initPanel({
      getGraph: () => currentGraph,
      getSettings: () => getSettings(),
      getLastExtract: () => lastExtractedItems,
      getLastRecall: () => lastRecalledItems,
      getRuntimeStatus: () => runtimeStatus,
      getLastExtractionStatus: () => lastExtractionStatus,
      getLastVectorStatus: () => lastVectorStatus,
      getLastRecallStatus: () => lastRecallStatus,
      getLastBatchStatus: () =>
        currentGraph?.historyState?.lastBatchStatus || null,
      getLastInjection: () => lastInjectionContent,
      getRuntimeDebugSnapshot: (options = {}) =>
        getPanelRuntimeDebugSnapshot(options),
      updateSettings: (patch) => {
        const settings = updateModuleSettings(patch);
        if (Object.prototype.hasOwnProperty.call(patch, "panelTheme")) {
          _themesModule?.applyTheme(settings.panelTheme || "crimson");
          _panelModule?.updatePanelTheme(settings.panelTheme || "crimson");
        }
        return settings;
      },
      actions: {
        extract: onManualExtract,
        compress: onManualCompress,
        sleep: onManualSleep,
        synopsis: onManualSynopsis,
        export: onExportGraph,
        import: onImportGraph,
        rebuild: onRebuild,
        evolve: onManualEvolve,
        testEmbedding: onTestEmbedding,
        testMemoryLLM: onTestMemoryLLM,
        fetchMemoryLLMModels: onFetchMemoryLLMModels,
        fetchEmbeddingModels: onFetchEmbeddingModels,
        rebuildVectorIndex: () => onRebuildVectorIndex(),
        rebuildVectorRange: (range) => onRebuildVectorIndex(range),
        reembedDirect: onReembedDirect,
        reroll: onReroll,
      },
    });

    // 注入三条杠 Options 菜单按钮
    if (!document.getElementById("option_st_bme_panel")) {
      const $menuItem = $(`
        <a id="option_st_bme_panel">
          <i class="fa-lg fa-solid fa-brain"></i>
          <span>记忆图谱</span>
        </a>
      `).on("click", () => {
        _panelModule?.openPanel();
        $("#options").hide();
      });

      const $optionsContent = $("#options .options-content");
      const $anchor = $("#option_toggle_logprobs");

      if ($anchor.length > 0) {
        $anchor.after($menuItem);
      } else if ($optionsContent.length > 0) {
        $optionsContent.append($menuItem);
      }
    }

    console.log("[ST-BME] 操控面板初始化完成");
  } catch (panelError) {
    console.error("[ST-BME] 操控面板加载失败（核心功能不受影响）:", panelError);
  }

  console.log("[ST-BME] 初始化完成");
})();
