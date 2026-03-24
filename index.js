// ST-BME: 主入口
// 事件钩子、设置管理、流程调度

import {
  eventSource,
  event_types,
  extension_prompt_types,
  getRequestHeaders,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "../../../extensions.js";

import { compressAll, sleepCycle } from "./compressor.js";
import { evolveMemories } from "./evolution.js";
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
  importGraph,
  getNode,
} from "./graph.js";
import { estimateTokens, formatInjection } from "./injector.js";
import { testLLMConnection } from "./llm.js";
import { retrieve } from "./retriever.js";
import {
  appendBatchJournal,
  buildRecoveryResult,
  clearHistoryDirty,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
  markHistoryDirty,
  normalizeGraphRuntimeState,
  snapshotProcessedMessageHashes,
} from "./runtime-state.js";
import { DEFAULT_NODE_SCHEMA, validateSchema } from "./schema.js";
import {
  BACKEND_VECTOR_SOURCES,
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

const MODULE_NAME = "st_bme";
const GRAPH_METADATA_KEY = "st_bme_graph";
const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";
const SERVER_SETTINGS_URL = `/user/files/${SERVER_SETTINGS_FILENAME}`;

// ==================== 默认设置 ====================

const defaultSettings = {
  enabled: false,

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
  embeddingTransportMode: "backend",
  embeddingBackendSource: "openai",
  embeddingBackendModel: "text-embedding-3-small",
  embeddingBackendApiUrl: "",
  embeddingAutoSuffix: true,

  // Schema
  nodeTypeSchema: null, // null 表示使用默认

  // 自定义提示词
  extractPrompt: "",

  // ====== v2 增强设置 ======

  // ③ A-MEM 记忆进化
  enableEvolution: true, // 启用记忆进化
  evoNeighborCount: 5, // 近邻搜索数量
  evoConsolidateEvery: 50, // 每 N 次进化后整理

  // ② Mem0 精确对照
  enablePreciseConflict: true, // 启用精确对照
  conflictThreshold: 0.85, // 相似度阈值

  // ⑨ 全局故事概要
  enableSynopsis: true, // 启用全局概要
  synopsisEveryN: 5, // 每 N 次提取后更新概要

  // ⑥ 认知边界过滤（P1）
  enableVisibility: false, // 启用认知边界
  // ⑦ 双记忆交叉检索（P1）
  enableCrossRecall: false, // 启用交叉检索

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
  enableReflection: false, // 启用反思
  reflectEveryN: 10, // 每 N 次提取后反思

  // UI 面板
  panelTheme: "crimson", // 面板主题 crimson|cyan|amber|violet
};

// ==================== 状态 ====================

let currentGraph = null;
let isExtracting = false;
let isRecalling = false;
let lastInjectionContent = "";
let lastExtractedItems = [];  // 最近提取的节点（面板展示用）
let lastRecalledItems = [];   // 最近召回的节点（面板展示用）
let extractionCount = 0; // v2: 提取次数计数器（定期触发概要/遗忘/反思）
let serverSettingsSaveTimer = null;
let isRecoveringHistory = false;
let lastHistoryWarningAt = 0;

function getNodeDisplayName(node) {
  return (
    node?.fields?.name ||
    node?.fields?.title ||
    node?.fields?.summary ||
    node?.fields?.insight ||
    node?.id ||
    "—"
  );
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

// ==================== 设置管理 ====================

function getSettings() {
  const mergedSettings = {
    ...defaultSettings,
    ...(extension_settings[MODULE_NAME] || {}),
  };
  extension_settings[MODULE_NAME] = mergedSettings;
  return mergedSettings;
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

function getEmbeddingConfig() {
  return getVectorConfigFromSettings(getSettings());
}

function getCurrentChatId(context = getContext()) {
  return String(
    context?.chatId ||
      context?.getCurrentChatId?.() ||
      "",
  );
}

function ensureCurrentGraphRuntimeState() {
  if (!currentGraph) {
    currentGraph = createEmptyGraph();
  }

  currentGraph = normalizeGraphRuntimeState(currentGraph, getCurrentChatId());
  return currentGraph;
}

function clearInjectionState() {
  lastInjectionContent = "";
  lastRecalledItems = [];

  try {
    const context = getContext();
    context.setExtensionPrompt(
      MODULE_NAME,
      "",
      extension_prompt_types.IN_CHAT,
      0,
    );
  } catch (error) {
    console.warn("[ST-BME] 清理旧注入失败:", error);
  }
}

async function recordGraphMutation({
  beforeSnapshot,
  processedRange = null,
  artifactTags = [],
  syncRange = null,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const vectorSync = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(getEmbeddingConfig()) && !syncRange,
    range: syncRange,
  });
  const afterSnapshot = cloneGraphSnapshot(currentGraph);
  const effectiveRange = Array.isArray(processedRange)
    ? processedRange
    : [
        getLastProcessedAssistantFloor(),
        getLastProcessedAssistantFloor(),
      ];

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
  currentGraph.historyState.lastProcessedAssistantFloor = lastProcessedAssistantFloor;
  currentGraph.historyState.processedMessageHashes = snapshotProcessedMessageHashes(
    chat,
    lastProcessedAssistantFloor,
  );
  currentGraph.lastProcessedSeq = lastProcessedAssistantFloor;
}

function computePostProcessArtifacts(beforeSnapshot, afterSnapshot, extraTags = []) {
  const beforeNodeIds = new Set((beforeSnapshot?.nodes || []).map((node) => node.id));
  const afterNodes = afterSnapshot?.nodes || [];
  const tags = new Set(extraTags.filter(Boolean));

  for (const node of afterNodes) {
    if (!beforeNodeIds.has(node.id)) {
      if (node.type === "synopsis") tags.add("synopsis");
      if (node.type === "reflection") tags.add("reflection");
      if (node.level > 0) tags.add("compression");
    }
  }

  const beforeNodes = new Map((beforeSnapshot?.nodes || []).map((node) => [node.id, node]));
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
} = {}) {
  ensureCurrentGraphRuntimeState();
  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);

  if (!validation.valid) {
    currentGraph.vectorIndexState.lastWarning = validation.error;
    currentGraph.vectorIndexState.dirty = true;
    return {
      insertedHashes: [],
      stats: getVectorIndexStats(currentGraph),
      error: validation.error,
    };
  }

  try {
    return await syncGraphVectorIndex(currentGraph, config, {
      chatId: getCurrentChatId(),
      force,
      purge,
      range,
    });
  } catch (error) {
    markVectorStateDirty(error?.message || "向量同步失败");
    console.error("[ST-BME] 向量同步失败:", error);
    return {
      insertedHashes: [],
      stats: getVectorIndexStats(currentGraph),
      error: String(error),
    };
  }
}

async function ensureVectorReadyIfNeeded(reason = "vector-ready-check") {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();

  if (!currentGraph.vectorIndexState?.dirty) return;

  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);
  if (!validation.valid) return;

  const result = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(config),
  });
  currentGraph.vectorIndexState.lastWarning = "";
  saveGraphToChat();
  console.log("[ST-BME] 向量状态已自动修复:", reason, result.stats);
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
    const response = await fetch(
      `${SERVER_SETTINGS_URL}?t=${Date.now()}`,
      { cache: "no-store" },
    );

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
    try {
      const context = getContext();
      context.setExtensionPrompt(
        MODULE_NAME,
        "",
        extension_prompt_types.IN_CHAT,
        0,
      );
      lastInjectionContent = "";
      lastRecalledItems = [];
    } catch (error) {
      console.warn("[ST-BME] 关闭插件时清理注入失败:", error);
    }
  }

  if (Object.keys(patch).some((key) => vectorConfigKeys.has(key))) {
    void resetVectorStateForConfigChange("Embedding 配置已变更，向量索引待重建");
  }

  scheduleServerSettingsSave();
  return settings;
}

// ==================== 图状态持久化 ====================

function loadGraphFromChat() {
  const context = getContext();
  const chatId = getCurrentChatId(context);
  if (!context.chatMetadata) {
    currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
    lastExtractedItems = [];
    lastRecalledItems = [];
    lastInjectionContent = "";
    return;
  }

  const savedData = context.chatMetadata[GRAPH_METADATA_KEY];
  if (savedData) {
    currentGraph = normalizeGraphRuntimeState(deserializeGraph(savedData), chatId);
    console.log("[ST-BME] 从聊天数据加载图谱:", getGraphStats(currentGraph));
  } else {
    currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
  }

  extractionCount = 0;
  lastExtractedItems = [];
  updateLastRecalledItems(currentGraph.lastRecallResult || []);
  lastInjectionContent = "";
}

function saveGraphToChat() {
  const context = getContext();
  if (!context.chatMetadata || !currentGraph) return;

  ensureCurrentGraphRuntimeState();
  context.chatMetadata[GRAPH_METADATA_KEY] = currentGraph;
  saveMetadataDebounced();
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

function getCurrentChatSeq(context = getContext()) {
  const chat = context?.chat;
  if (Array.isArray(chat) && chat.length > 0) {
    return chat.length - 1;
  }
  return currentGraph?.lastProcessedSeq ?? 0;
}

async function handleExtractionSuccess(result, endIdx, settings) {
  const postProcessArtifacts = [];
  extractionCount++;
  updateLastExtractedItems(result.newNodeIds || []);

  if (settings.enableEvolution && result.newNodeIds?.length > 0) {
    try {
      await evolveMemories({
        graph: currentGraph,
        newNodeIds: result.newNodeIds,
        embeddingConfig: getEmbeddingConfig(),
        options: { neighborCount: settings.evoNeighborCount },
        customPrompt: settings.evolutionPrompt || undefined,
      });
      postProcessArtifacts.push("evolution");
    } catch (e) {
      console.error("[ST-BME] 记忆进化失败:", e);
    }
  }

  if (settings.enableSynopsis && extractionCount % settings.synopsisEveryN === 0) {
    try {
      await generateSynopsis({
        graph: currentGraph,
        schema: getSchema(),
        currentSeq: endIdx,
        customPrompt: settings.synopsisPrompt || undefined,
      });
      postProcessArtifacts.push("synopsis");
    } catch (e) {
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
        customPrompt: settings.reflectionPrompt || undefined,
      });
      postProcessArtifacts.push("reflection");
    } catch (e) {
      console.error("[ST-BME] 反思生成失败:", e);
    }
  }

  if (settings.enableSleepCycle && extractionCount % settings.sleepEveryN === 0) {
    try {
      sleepCycle(currentGraph, settings);
      postProcessArtifacts.push("sleep");
    } catch (e) {
      console.error("[ST-BME] 主动遗忘失败:", e);
    }
  }

  const compressionResult = await compressAll(
    currentGraph,
    getSchema(),
    getEmbeddingConfig(),
    false,
    settings.compressPrompt || undefined,
  );
  if (compressionResult.created > 0 || compressionResult.archived > 0) {
    postProcessArtifacts.push("compression");
  }

  const vectorSync = await syncVectorState();
  return {
    postProcessArtifacts,
    vectorHashesInserted: vectorSync?.insertedHashes || [],
    vectorStats: vectorSync?.stats || getVectorIndexStats(currentGraph),
  };
}

function getAssistantTurns(chat) {
  const assistantTurns = [];
  for (let index = 0; index < chat.length; index++) {
    if (chat[index].is_user === false && !chat[index].is_system) {
      assistantTurns.push(index);
    }
  }
  return assistantTurns;
}

function buildExtractionMessages(chat, startIdx, endIdx, settings) {
  const contextTurns = clampInt(settings.extractContextTurns, 2, 0, 20);
  const contextStart = Math.max(0, startIdx - contextTurns * 2);
  const messages = [];

  for (let index = contextStart; index <= endIdx && index < chat.length; index++) {
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

function getLastProcessedAssistantFloor() {
  ensureCurrentGraphRuntimeState();
  return Number.isFinite(currentGraph?.historyState?.lastProcessedAssistantFloor)
    ? currentGraph.historyState.lastProcessedAssistantFloor
    : -1;
}

function notifyHistoryDirty(dirtyFrom, reason) {
  const now = Date.now();
  if (now - lastHistoryWarningAt < 3000) return;
  lastHistoryWarningAt = now;
  toastr.warning(
    `检测到楼层历史变化，将从楼层 ${dirtyFrom} 之后自动恢复图谱`,
    reason || "ST-BME 历史回退保护",
  );
}

function inspectHistoryMutation(trigger = "history-change") {
  if (!currentGraph) return { dirty: false, earliestAffectedFloor: null, reason: "" };

  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const chat = context?.chat;
  const detection = detectHistoryMutation(chat, currentGraph.historyState);

  if (detection.dirty) {
    clearInjectionState();
    markHistoryDirty(
      currentGraph,
      detection.earliestAffectedFloor,
      detection.reason || trigger,
    );
    saveGraphToChat();
    notifyHistoryDirty(detection.earliestAffectedFloor, detection.reason);
    return detection;
  }

  if (trigger === "message-edited" || trigger === "message-swiped") {
    clearInjectionState();
  }

  return detection;
}

async function purgeCurrentVectorCollection() {
  if (!currentGraph?.vectorIndexState?.collectionId) return;

  const response = await fetch("/api/vector/purge", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      collectionId: currentGraph.vectorIndexState.collectionId,
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function prepareVectorStateForReplay(fullReset = false) {
  ensureCurrentGraphRuntimeState();
  const config = getEmbeddingConfig();

  if (isBackendVectorConfig(config)) {
    try {
      await purgeCurrentVectorCollection();
    } catch (error) {
      console.warn("[ST-BME] 清理后端向量索引失败，继续本地恢复:", error);
    }
    currentGraph.vectorIndexState.hashToNodeId = {};
    currentGraph.vectorIndexState.nodeToHash = {};
    currentGraph.vectorIndexState.dirty = true;
    currentGraph.vectorIndexState.lastWarning = "历史恢复后需要重建后端向量索引";
    return;
  }

  if (fullReset) {
    currentGraph.vectorIndexState.hashToNodeId = {};
    currentGraph.vectorIndexState.nodeToHash = {};
    currentGraph.vectorIndexState.dirty = true;
    currentGraph.vectorIndexState.lastWarning = "历史恢复后需要重嵌当前聊天向量";
  }
}

async function executeExtractionBatch({
  chat,
  startIdx,
  endIdx,
  settings,
  smartTriggerDecision = null,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const lastProcessed = getLastProcessedAssistantFloor();
  const beforeSnapshot = cloneGraphSnapshot(currentGraph);
  const messages = buildExtractionMessages(chat, startIdx, endIdx, settings);

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
    extractPrompt: settings.extractPrompt || undefined,
    v2Options: {
      enablePreciseConflict: settings.enablePreciseConflict,
      conflictThreshold: settings.conflictThreshold,
    },
  });

  if (!result.success) {
    return { success: false, result, effects: null };
  }

  const effects = await handleExtractionSuccess(result, endIdx, settings);
  updateProcessedHistorySnapshot(chat, endIdx);

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
    }),
  );
  saveGraphToChat();

  return { success: true, result, effects };
}

async function replayExtractionFromHistory(chat, settings) {
  let replayedBatches = 0;

  while (true) {
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
    });

    if (!batchResult.success) {
      throw new Error("历史恢复回放过程中出现提取失败");
    }

    replayedBatches++;
  }

  return replayedBatches;
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
  const initialDirtyFrom = Number.isFinite(dirtyFrom)
    ? dirtyFrom
    : detection.earliestAffectedFloor;
  let replayedBatches = 0;
  let usedFullRebuild = false;

  try {
    const recoveryPoint = findJournalRecoveryPoint(currentGraph, initialDirtyFrom);
    if (recoveryPoint) {
      currentGraph = normalizeGraphRuntimeState(
        recoveryPoint.snapshotBefore,
        chatId,
      );
    } else {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      usedFullRebuild = true;
    }

    await prepareVectorStateForReplay(usedFullRebuild);
    replayedBatches = await replayExtractionFromHistory(chat, settings);

    clearHistoryDirty(
      currentGraph,
      buildRecoveryResult(usedFullRebuild ? "full-rebuild" : "replayed", {
        fromFloor: initialDirtyFrom,
        batches: replayedBatches,
        reason: detection.reason || currentGraph?.historyState?.lastMutationReason || trigger,
      }),
    );
    saveGraphToChat();

    toastr.success(
      usedFullRebuild
        ? "历史变化已触发全量重建"
        : "历史变化已完成受影响后缀恢复",
    );
    return true;
  } catch (error) {
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      await prepareVectorStateForReplay(true);
      replayedBatches = await replayExtractionFromHistory(chat, settings);
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("full-rebuild", {
          fromFloor: 0,
          batches: replayedBatches,
          reason: `恢复失败后兜底全量重建: ${error?.message || error}`,
        }),
      );
      saveGraphToChat();
      toastr.warning("历史恢复已退化为全量重建");
      return true;
    } catch (fallbackError) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult("failed", {
        fromFloor: initialDirtyFrom,
        reason: String(fallbackError),
      });
      saveGraphToChat();
      toastr.error(`历史恢复失败: ${fallbackError?.message || fallbackError}`);
      return false;
    }
  } finally {
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
  await ensureVectorReadyIfNeeded("pre-extract");

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

  try {
    const batchResult = await executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
      smartTriggerDecision,
    });

    if (!batchResult.success) {
      console.warn("[ST-BME] 提取批次未返回有效结果");
    }
  } catch (e) {
    console.error("[ST-BME] 提取失败:", e);
  } finally {
    isExtracting = false;
  }
}

/**
 * 召回管线：检索并注入记忆
 */
async function runRecall() {
  if (isRecalling || !currentGraph) return;

  const settings = getSettings();
  if (!settings.enabled || !settings.recallEnabled) return;
  if (!(await recoverHistoryIfNeeded("pre-recall"))) return;

  await ensureVectorReadyIfNeeded("pre-recall");

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) return;

  isRecalling = true;

  try {
    // 获取最新用户消息
    let userMessage = "";
    const recentMessages = [];

    for (let i = chat.length - 1; i >= 0 && recentMessages.length < 4; i--) {
      const msg = chat[i];
      if (msg.is_system) continue;

      if (msg.is_user && !userMessage) {
        userMessage = msg.mes || "";
      }
      recentMessages.unshift(
        `[${msg.is_user ? "user" : "assistant"}]: ${msg.mes || ""}`,
      );
    }

    if (!userMessage) return;

    console.log("[ST-BME] 开始召回");

    const result = await retrieve({
      graph: currentGraph,
      userMessage,
      recentMessages,
      embeddingConfig: getEmbeddingConfig(),
      schema: getSchema(),
      options: {
        topK: settings.recallTopK,
        maxRecallNodes: settings.recallMaxNodes,
        enableLLMRecall: settings.recallEnableLLM,
        enableVectorPrefilter: settings.recallEnableVectorPrefilter,
        enableGraphDiffusion: settings.recallEnableGraphDiffusion,
        diffusionTopK: settings.recallDiffusionTopK,
        llmCandidatePool: settings.recallLlmCandidatePool,
        recallPrompt: settings.recallPrompt || undefined,
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

    // 格式化注入文本
    const injectionText = formatInjection(result, getSchema()).trim();
    lastInjectionContent = injectionText;

    if (injectionText) {
      const tokens = estimateTokens(injectionText);
      console.log(
        `[ST-BME] 注入 ${tokens} 估算 tokens, Core=${result.stats.coreCount}, Recall=${result.stats.recallCount}`,
      );
    }

    // 无结果时也要清空旧注入，避免脏 prompt 残留
    context.setExtensionPrompt(
      MODULE_NAME,
      injectionText,
      extension_prompt_types.IN_CHAT, // 当前注入走 IN_CHAT@Depth
      clampInt(settings.injectDepth, 9999, 0, 9999),
    );

    // 保存召回结果和访问强化
    currentGraph.lastRecallResult = result.selectedNodeIds;
    updateLastRecalledItems(result.selectedNodeIds || []);
    saveGraphToChat();
  } catch (e) {
    console.error("[ST-BME] 召回失败:", e);
  } finally {
    isRecalling = false;
  }
}

// ==================== 事件钩子 ====================

function onChatChanged() {
  loadGraphFromChat();
  clearInjectionState();
}

function onMessageDeleted() {
  inspectHistoryMutation("message-deleted");
}

function onMessageEdited() {
  inspectHistoryMutation("message-edited");
}

function onMessageSwiped() {
  inspectHistoryMutation("message-swiped");
}

async function onGenerationAfterCommands() {
  await runExtraction();
}

async function onBeforeCombinePrompts() {
  await runRecall();
}

function onMessageReceived() {
  // 新消息到达，图状态可能需要更新
  if (currentGraph) {
    saveGraphToChat();
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

  currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), getCurrentChatId());
  currentGraph.batchJournal = [];
  clearInjectionState();
  await prepareVectorStateForReplay(true);
  await replayExtractionFromHistory(chat, getSettings());
  clearHistoryDirty(
    currentGraph,
    buildRecoveryResult("full-rebuild", {
      fromFloor: 0,
      batches: currentGraph.batchJournal.length,
      reason: "用户手动触发全量重建",
    }),
  );
  saveGraphToChat();
  toastr.success("图谱与向量索引已按当前聊天全量重建");
}

async function onManualCompress() {
  if (!currentGraph) return;
  const beforeSnapshot = cloneGraphSnapshot(currentGraph);

  const result = await compressAll(
    currentGraph,
    getSchema(),
    getEmbeddingConfig(),
    false,
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

async function onManualExtract() {
  if (isExtracting) return;
  if (!(await recoverHistoryIfNeeded("manual-extract"))) return;
  await ensureVectorReadyIfNeeded("manual-extract");
  if (!currentGraph) currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), getCurrentChatId());

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

  const startIdx = pendingAssistantTurns[0];
  const endIdx = pendingAssistantTurns[pendingAssistantTurns.length - 1];
  const settings = getSettings();
  isExtracting = true;
  try {
    const batchResult = await executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
    });

    if (!batchResult.success) {
      toastr.warning("手动提取未返回有效结果");
      return;
    }

    toastr.success(
      `提取完成：新建 ${batchResult.result.newNodes}，更新 ${batchResult.result.updatedNodes}，新边 ${batchResult.result.newEdges}`,
    );
  } catch (e) {
    console.error("[ST-BME] 手动提取失败:", e);
    toastr.error(`手动提取失败: ${e.message || e}`);
  } finally {
    isExtracting = false;
  }
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
  });
  await recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["synopsis"],
  });
  toastr.success("概要生成完成");
}

async function onManualEvolve() {
  if (!currentGraph) return;

  const candidateIds = lastExtractedItems.map((item) => item.id).filter(Boolean);
  if (candidateIds.length === 0) {
    toastr.info("暂无最近提取节点可用于进化");
    return;
  }

  const beforeSnapshot = cloneGraphSnapshot(currentGraph);
  const result = await evolveMemories({
    graph: currentGraph,
    newNodeIds: candidateIds,
    embeddingConfig: getEmbeddingConfig(),
    options: { neighborCount: getSettings().evoNeighborCount },
  });
  await recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["evolution"],
  });
  toastr.success(
    `进化完成：${result.evolved} 次进化，${result.connections} 条链接，${result.updates} 个回溯更新`,
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

  const result = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(config) && !range,
    range,
  });

  saveGraphToChat();
  toastr.success(
    range
      ? `范围向量重建完成：indexed=${result.stats.indexed}, pending=${result.stats.pending}`
      : `当前聊天向量重建完成：indexed=${result.stats.indexed}, pending=${result.stats.pending}`,
  );
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

  // 注册事件钩子
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(
    event_types.GENERATION_AFTER_COMMANDS,
    onGenerationAfterCommands,
  );
  eventSource.on(
    event_types.GENERATE_BEFORE_COMBINE_PROMPTS,
    onBeforeCombinePrompts,
  );
  eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
  eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
  eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
  if (event_types.MESSAGE_UPDATED) {
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageEdited);
  }

  // 加载当前聊天的图谱
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
      getLastInjection: () => lastInjectionContent,
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
        rebuildVectorIndex: () => onRebuildVectorIndex(),
        rebuildVectorRange: (range) => onRebuildVectorIndex(range),
        reembedDirect: onReembedDirect,
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
