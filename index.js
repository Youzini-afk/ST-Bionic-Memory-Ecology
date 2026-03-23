// ST-BME: 主入口
// 事件钩子、设置管理、流程调度

import {
  eventSource,
  event_types,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
  saveMetadataDebounced,
} from "../../../extensions.js";

import { compressAll, sleepCycle } from "./compressor.js";
import { testConnection as testEmbeddingConnection } from "./embedding.js";
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
import { retrieve } from "./retriever.js";
import { DEFAULT_NODE_SCHEMA, validateSchema } from "./schema.js";

// 操控面板模块（动态加载，防止加载失败崩溃整个扩展）
let _panelModule = null;
let _themesModule = null;

const MODULE_NAME = "st_bme";
const GRAPH_METADATA_KEY = "st_bme_graph";
const TEMPLATE_PATH = "third-party/ST-BME";

// ==================== 默认设置 ====================

const defaultSettings = {
  enabled: false,

  // 提取设置
  extractEvery: 1, // 每 N 条 assistant 回复提取一次
  extractContextTurns: 2, // 提取时包含的上下文楼层数

  // 召回设置
  recallEnabled: true,
  recallTopK: 15, // 混合评分 Top-K
  recallMaxNodes: 8, // LLM 召回最大节点数
  recallEnableLLM: true, // 是否启用 LLM 精确召回

  // 注入设置
  injectPosition: "atDepth", // 注入位置
  injectDepth: 4, // 注入深度（atDepth 模式）
  injectRole: 0, // 0=system, 1=user, 2=assistant

  // 混合评分权重
  graphWeight: 0.6,
  vectorWeight: 0.3,
  importanceWeight: 0.1,

  // Embedding API 配置
  embeddingApiUrl: "",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-3-small",

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
  const settings = getSettings();
  return {
    apiUrl: settings.embeddingApiUrl,
    apiKey: settings.embeddingApiKey,
    model: settings.embeddingModel,
  };
}

// ==================== 图状态持久化 ====================

function loadGraphFromChat() {
  const context = getContext();
  if (!context.chatMetadata) {
    currentGraph = createEmptyGraph();
    lastExtractedItems = [];
    lastRecalledItems = [];
    lastInjectionContent = "";
    return;
  }

  const savedData = context.chatMetadata[GRAPH_METADATA_KEY];
  if (savedData) {
    currentGraph = deserializeGraph(savedData);
    console.log("[ST-BME] 从聊天数据加载图谱:", getGraphStats(currentGraph));
  } else {
    currentGraph = createEmptyGraph();
  }

  lastExtractedItems = [];
  updateLastRecalledItems(currentGraph.lastRecallResult || []);
  lastInjectionContent = "";
}

function saveGraphToChat() {
  const context = getContext();
  if (!context.chatMetadata || !currentGraph) return;

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
  extractionCount++;
  updateLastExtractedItems(result.newNodeIds || []);

  if (settings.enableEvolution && result.newNodeIds?.length > 0) {
    try {
      await evolveMemories({
        graph: currentGraph,
        newNodeIds: result.newNodeIds,
        embeddingConfig: getEmbeddingConfig(),
        options: { neighborCount: settings.evoNeighborCount },
      });
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
      });
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
      });
    } catch (e) {
      console.error("[ST-BME] 反思生成失败:", e);
    }
  }

  if (settings.enableSleepCycle && extractionCount % settings.sleepEveryN === 0) {
    try {
      sleepCycle(currentGraph, settings);
    } catch (e) {
      console.error("[ST-BME] 主动遗忘失败:", e);
    }
  }

  await compressAll(currentGraph, getSchema(), getEmbeddingConfig());
  saveGraphToChat();
}

/**
 * 提取管线：处理未提取的对话楼层
 */
async function runExtraction() {
  if (isExtracting || !currentGraph) return;

  const settings = getSettings();
  if (!settings.enabled) return;

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) return;

  // lastProcessedSeq / startSeq / endSeq 统一使用 chat 数组索引语义
  const assistantTurns = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i].is_user === false && !chat[i].is_system) {
      assistantTurns.push(i);
    }
  }

  const lastProcessed = Number.isFinite(currentGraph.lastProcessedSeq)
    ? currentGraph.lastProcessedSeq
    : -1;
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
    const contextTurns = clampInt(settings.extractContextTurns, 2, 0, 20);
    const contextStart = Math.max(0, startIdx - contextTurns * 2);
    const messages = [];
    for (let i = contextStart; i <= endIdx && i < chat.length; i++) {
      const msg = chat[i];
      if (msg.is_system) continue;
      messages.push({
        seq: i,
        role: msg.is_user ? "user" : "assistant",
        content: msg.mes || "",
      });
    }

    console.log(
      `[ST-BME] 开始提取: 楼层 ${startIdx}-${endIdx}` +
        (smartTriggerDecision.triggered
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

    if (result.success) {
      await handleExtractionSuccess(result, endIdx, settings);
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
      1, // extension_prompt_types.IN_PROMPT
      clampInt(settings.injectDepth, 4, 0, 9999),
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
  lastInjectionContent = "";
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

  currentGraph = createEmptyGraph();
  lastExtractedItems = [];
  lastRecalledItems = [];
  lastInjectionContent = "";
  saveGraphToChat();

  toastr.info("图谱已重置，将在下次生成时重新提取");
}

async function onManualCompress() {
  if (!currentGraph) return;

  const result = await compressAll(
    currentGraph,
    getSchema(),
    getEmbeddingConfig(),
    false,
  );
  saveGraphToChat();

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
      currentGraph = importGraph(text);
      lastExtractedItems = [];
      updateLastRecalledItems(currentGraph.lastRecallResult || []);
      lastInjectionContent = "";
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
  if (!config.apiUrl || !config.apiKey) {
    toastr.warning("请先配置 Embedding API 地址和 Key");
    return;
  }

  toastr.info("正在测试 Embedding API 连通性...");
  const result = await testEmbeddingConnection(config);

  if (result.success) {
    toastr.success(`连接成功！向量维度: ${result.dimensions}`);
  } else {
    toastr.error(`连接失败: ${result.error}`);
  }
}

async function onManualExtract() {
  if (isExtracting) return;
  if (!currentGraph) currentGraph = createEmptyGraph();

  const context = getContext();
  const chat = context.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    toastr.info("当前聊天为空，暂无可提取内容");
    return;
  }

  const assistantTurns = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i].is_user === false && !chat[i].is_system) {
      assistantTurns.push(i);
    }
  }

  const lastProcessed = Number.isFinite(currentGraph.lastProcessedSeq)
    ? currentGraph.lastProcessedSeq
    : -1;
  const pendingAssistantTurns = assistantTurns.filter((i) => i > lastProcessed);
  if (pendingAssistantTurns.length === 0) {
    toastr.info("没有待提取的新回复");
    return;
  }

  const startIdx = pendingAssistantTurns[0];
  const endIdx = pendingAssistantTurns[pendingAssistantTurns.length - 1];
  const settings = getSettings();
  const contextTurns = clampInt(settings.extractContextTurns, 2, 0, 20);
  const contextStart = Math.max(0, startIdx - contextTurns * 2);
  const messages = [];

  for (let i = contextStart; i <= endIdx && i < chat.length; i++) {
    const msg = chat[i];
    if (msg.is_system) continue;
    messages.push({
      seq: i,
      role: msg.is_user ? "user" : "assistant",
      content: msg.mes || "",
    });
  }

  isExtracting = true;
  try {
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
      toastr.warning("手动提取未返回有效结果");
      return;
    }

    await handleExtractionSuccess(result, endIdx, settings);
    toastr.success(
      `提取完成：新建 ${result.newNodes}，更新 ${result.updatedNodes}，新边 ${result.newEdges}`,
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
  const result = sleepCycle(currentGraph, getSettings());
  saveGraphToChat();
  toastr.info(`执行完成：归档 ${result.forgotten} 个节点`);
}

async function onManualSynopsis() {
  if (!currentGraph) return;
  await generateSynopsis({
    graph: currentGraph,
    schema: getSchema(),
    currentSeq: getCurrentChatSeq(),
  });
  saveGraphToChat();
  toastr.success("概要生成完成");
}

async function onManualEvolve() {
  if (!currentGraph) return;

  const candidateIds = lastExtractedItems.map((item) => item.id).filter(Boolean);
  if (candidateIds.length === 0) {
    toastr.info("暂无最近提取节点可用于进化");
    return;
  }

  const result = await evolveMemories({
    graph: currentGraph,
    newNodeIds: candidateIds,
    embeddingConfig: getEmbeddingConfig(),
    options: { neighborCount: getSettings().evoNeighborCount },
  });
  saveGraphToChat();
  toastr.success(
    `进化完成：${result.evolved} 次进化，${result.connections} 条链接，${result.updates} 个回溯更新`,
  );
}

// ==================== 设置 UI ====================

function bindSettingsUI() {
  const settings = getSettings();

  // 开关
  $("#st_bme_enabled")
    .prop("checked", settings.enabled)
    .on("change", function () {
      settings.enabled = $(this).prop("checked");
      saveSettingsDebounced();
    });

  // 提取频率
  $("#st_bme_extract_every")
    .val(settings.extractEvery)
    .on("input", function () {
      settings.extractEvery = clampInt($(this).val(), 1, 1, 50);
      saveSettingsDebounced();
    });
  $("#st_bme_extract_context_turns")
    .val(settings.extractContextTurns)
    .on("input", function () {
      settings.extractContextTurns = clampInt($(this).val(), 2, 0, 20);
      saveSettingsDebounced();
    });

  // 召回开关
  $("#st_bme_recall_enabled")
    .prop("checked", settings.recallEnabled)
    .on("change", function () {
      settings.recallEnabled = $(this).prop("checked");
      saveSettingsDebounced();
    });

  // LLM 精确召回
  $("#st_bme_recall_llm")
    .prop("checked", settings.recallEnableLLM)
    .on("change", function () {
      settings.recallEnableLLM = $(this).prop("checked");
      saveSettingsDebounced();
    });

  $("#st_bme_recall_top_k")
    .val(settings.recallTopK)
    .on("input", function () {
      settings.recallTopK = clampInt($(this).val(), 15, 1, 100);
      saveSettingsDebounced();
    });
  $("#st_bme_recall_max_nodes")
    .val(settings.recallMaxNodes)
    .on("input", function () {
      settings.recallMaxNodes = clampInt($(this).val(), 8, 1, 50);
      saveSettingsDebounced();
    });

  // 注入深度
  $("#st_bme_inject_depth")
    .val(settings.injectDepth)
    .on("input", function () {
      settings.injectDepth = clampInt($(this).val(), 4, 0, 9999);
      saveSettingsDebounced();
    });

  // 评分权重
  $("#st_bme_graph_weight")
    .val(settings.graphWeight)
    .on("input", function () {
      settings.graphWeight = clampFloat($(this).val(), 0.6, 0, 1);
      saveSettingsDebounced();
    });
  $("#st_bme_vector_weight")
    .val(settings.vectorWeight)
    .on("input", function () {
      settings.vectorWeight = clampFloat($(this).val(), 0.3, 0, 1);
      saveSettingsDebounced();
    });
  $("#st_bme_importance_weight")
    .val(settings.importanceWeight)
    .on("input", function () {
      settings.importanceWeight = clampFloat($(this).val(), 0.1, 0, 1);
      saveSettingsDebounced();
    });

  // Embedding API
  $("#st_bme_embed_url")
    .val(settings.embeddingApiUrl)
    .on("input", function () {
      settings.embeddingApiUrl = $(this).val().trim();
      saveSettingsDebounced();
    });
  $("#st_bme_embed_key")
    .val(settings.embeddingApiKey)
    .on("input", function () {
      settings.embeddingApiKey = $(this).val().trim();
      saveSettingsDebounced();
    });
  $("#st_bme_embed_model")
    .val(settings.embeddingModel)
    .on("input", function () {
      settings.embeddingModel = $(this).val().trim();
      saveSettingsDebounced();
    });

  // 操作按钮
  $("#st_bme_btn_view_graph").on("click", onViewGraph);
  $("#st_bme_btn_rebuild").on("click", onRebuild);
  $("#st_bme_btn_compress").on("click", onManualCompress);
  $("#st_bme_btn_export").on("click", onExportGraph);
  $("#st_bme_btn_import").on("click", onImportGraph);
  $("#st_bme_btn_view_injection").on("click", onViewLastInjection);
  $("#st_bme_btn_test_embed").on("click", onTestEmbedding);

  // ====== v2 增强设置 UI 绑定 ======

  // P0: 记忆进化
  $("#st_bme_evolution")
    .prop("checked", settings.enableEvolution)
    .on("change", function () {
      settings.enableEvolution = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_evo_neighbors")
    .val(settings.evoNeighborCount)
    .on("input", function () {
      settings.evoNeighborCount = clampInt($(this).val(), 5, 1, 20);
      saveSettingsDebounced();
    });
  $("#st_bme_evo_consolidate_every")
    .val(settings.evoConsolidateEvery)
    .on("input", function () {
      settings.evoConsolidateEvery = clampInt($(this).val(), 50, 1, 500);
      saveSettingsDebounced();
    });

  // P0: 精确对照
  $("#st_bme_precise_conflict")
    .prop("checked", settings.enablePreciseConflict)
    .on("change", function () {
      settings.enablePreciseConflict = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_conflict_threshold")
    .val(settings.conflictThreshold)
    .on("input", function () {
      settings.conflictThreshold = clampFloat($(this).val(), 0.85, 0.5, 0.99);
      saveSettingsDebounced();
    });

  // P0: 全局概要
  $("#st_bme_synopsis")
    .prop("checked", settings.enableSynopsis)
    .on("change", function () {
      settings.enableSynopsis = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_synopsis_every")
    .val(settings.synopsisEveryN)
    .on("input", function () {
      settings.synopsisEveryN = clampInt($(this).val(), 5, 1, 100);
      saveSettingsDebounced();
    });

  // P1: 认知边界
  $("#st_bme_visibility")
    .prop("checked", settings.enableVisibility ?? false)
    .on("change", function () {
      settings.enableVisibility = $(this).prop("checked");
      saveSettingsDebounced();
    });

  // P1: 交叉检索
  $("#st_bme_cross_recall")
    .prop("checked", settings.enableCrossRecall ?? false)
    .on("change", function () {
      settings.enableCrossRecall = $(this).prop("checked");
      saveSettingsDebounced();
    });

  // P2: 惊奇度分割
  $("#st_bme_smart_trigger")
    .prop("checked", settings.enableSmartTrigger)
    .on("change", function () {
      settings.enableSmartTrigger = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_trigger_patterns")
    .val(settings.triggerPatterns || "")
    .on("input", function () {
      settings.triggerPatterns = $(this).val();
      saveSettingsDebounced();
    });
  $("#st_bme_smart_trigger_threshold")
    .val(settings.smartTriggerThreshold)
    .on("input", function () {
      settings.smartTriggerThreshold = clampInt($(this).val(), 2, 1, 10);
      saveSettingsDebounced();
    });

  // P2: 主动遗忘
  $("#st_bme_sleep_cycle")
    .prop("checked", settings.enableSleepCycle)
    .on("change", function () {
      settings.enableSleepCycle = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_forget_threshold")
    .val(settings.forgetThreshold)
    .on("input", function () {
      settings.forgetThreshold = clampFloat($(this).val(), 0.5, 0.1, 1);
      saveSettingsDebounced();
    });
  $("#st_bme_sleep_every")
    .val(settings.sleepEveryN)
    .on("input", function () {
      settings.sleepEveryN = clampInt($(this).val(), 10, 1, 200);
      saveSettingsDebounced();
    });

  // P2: 概率触发
  $("#st_bme_prob_recall")
    .prop("checked", settings.enableProbRecall)
    .on("change", function () {
      settings.enableProbRecall = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_prob_chance")
    .val(settings.probRecallChance)
    .on("input", function () {
      settings.probRecallChance = clampFloat($(this).val(), 0.15, 0.01, 0.5);
      saveSettingsDebounced();
    });

  // P2: 反思条目
  $("#st_bme_reflection")
    .prop("checked", settings.enableReflection)
    .on("change", function () {
      settings.enableReflection = $(this).prop("checked");
      saveSettingsDebounced();
    });
  $("#st_bme_reflect_every")
    .val(settings.reflectEveryN)
    .on("input", function () {
      settings.reflectEveryN = clampInt($(this).val(), 10, 1, 200);
      saveSettingsDebounced();
    });
}

// ==================== 初始化 ====================

(async function init() {
  try {
    const settingsHtml = await renderExtensionTemplateAsync(
      TEMPLATE_PATH,
      "settings",
    );
    $("#extensions_settings2").append(settingsHtml);
    bindSettingsUI();
  } catch (settingsError) {
    console.error("[ST-BME] 设置面板加载失败:", settingsError);
  }

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
      actions: {
        extract: onManualExtract,
        compress: onManualCompress,
        sleep: onManualSleep,
        synopsis: onManualSynopsis,
        export: onExportGraph,
        import: onImportGraph,
        rebuild: onRebuild,
        evolve: onManualEvolve,
      },
    });

    // 注入 Options 菜单按钮
    const $menuItem = $('<div class="list-group-item flex-container flexGap5">')
      .append('<i class="fa-solid fa-brain"></i>')
      .append('<span>记忆图谱</span>')
      .on('click', () => {
        _panelModule?.openPanel();
        $('#options').hide();
      });
    $('#extensionsMenu .list-group').append($menuItem);

    // 主题选择绑定
    $('#st_bme_panel_theme')
      .val(settings.panelTheme || 'crimson')
      .on('change', function () {
        const theme = $(this).val();
        const s = getSettings();
        s.panelTheme = theme;
        extension_settings[MODULE_NAME].panelTheme = theme;
        _themesModule?.applyTheme(theme);
        _panelModule?.updatePanelTheme(theme);
        saveSettingsDebounced();
      });

    // 打开面板按钮
    $('#st_bme_btn_open_panel').on('click', () => _panelModule?.openPanel());

    console.log("[ST-BME] 操控面板初始化完成");
  } catch (panelError) {
    console.error("[ST-BME] 操控面板加载失败（核心功能不受影响）:", panelError);
  }

  console.log("[ST-BME] 初始化完成");
})();
