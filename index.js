// ST-BME: 主入口
// 事件钩子、设置管理、流程调度

import {
  eventSource,
  event_types,
  saveSettingsDebounced,
} from "../../../script.js";
import {
  extension_settings,
  getContext,
  renderExtensionTemplateAsync,
  saveMetadataDebounced,
} from "../../extensions.js";

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
} from "./graph.js";
import { estimateTokens, formatInjection } from "./injector.js";
import { retrieve } from "./retriever.js";
import { DEFAULT_NODE_SCHEMA } from "./schema.js";

const MODULE_NAME = "st_bme";
const GRAPH_METADATA_KEY = "st_bme_graph";

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
};

// ==================== 状态 ====================

let currentGraph = null;
let isExtracting = false;
let isRecalling = false;
let lastInjectionContent = "";
let extractionCount = 0; // v2: 提取次数计数器（定期触发概要/遗忘/反思）

// ==================== 设置管理 ====================

function getSettings() {
  if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = { ...defaultSettings };
  }
  return extension_settings[MODULE_NAME];
}

function getSchema() {
  const settings = getSettings();
  return settings.nodeTypeSchema || DEFAULT_NODE_SCHEMA;
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
    return;
  }

  const savedData = context.chatMetadata[GRAPH_METADATA_KEY];
  if (savedData) {
    currentGraph = deserializeGraph(savedData);
    console.log("[ST-BME] 从聊天数据加载图谱:", getGraphStats(currentGraph));
  } else {
    currentGraph = createEmptyGraph();
  }
}

function saveGraphToChat() {
  const context = getContext();
  if (!context.chatMetadata || !currentGraph) return;

  context.chatMetadata[GRAPH_METADATA_KEY] = currentGraph;
  saveMetadataDebounced();
}

// ==================== 核心流程 ====================

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

  // 找出 assistant 楼层序号
  const assistantTurns = [];
  for (let i = 0; i < chat.length; i++) {
    if (chat[i].is_user === false && !chat[i].is_system) {
      assistantTurns.push(i);
    }
  }

  const lastProcessed = currentGraph.lastProcessedSeq;
  const unprocessedStarts = assistantTurns.filter((i) => i > lastProcessed);

  if (unprocessedStarts.length === 0) return;

  // 按 extractEvery 批次处理
  if (unprocessedStarts.length < settings.extractEvery) return;

  isExtracting = true;

  try {
    // 收集要处理的消息
    const startIdx = unprocessedStarts[0];
    const endIdx = unprocessedStarts[unprocessedStarts.length - 1];

    // 包含上下文
    const contextStart = Math.max(
      0,
      startIdx - settings.extractContextTurns * 2,
    );
    const messages = [];
    for (let i = contextStart; i <= endIdx && i < chat.length; i++) {
      const msg = chat[i];
      if (msg.is_system) continue;
      messages.push({
        role: msg.is_user ? "user" : "assistant",
        content: msg.mes || "",
      });
    }

    console.log(`[ST-BME] 开始提取: 楼层 ${startIdx}-${endIdx}`);

    const result = await extractMemories({
      graph: currentGraph,
      messages,
      startSeq: endIdx,
      schema: getSchema(),
      embeddingConfig: getEmbeddingConfig(),
      extractPrompt: settings.extractPrompt || undefined,
      v2Options: {
        enablePreciseConflict: settings.enablePreciseConflict,
        conflictThreshold: settings.conflictThreshold,
      },
    });

    if (result.success) {
      extractionCount++;

      // v2: A-MEM 记忆进化
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

      // v2: 全局故事概要（每 N 次提取更新一次）
      if (
        settings.enableSynopsis &&
        extractionCount % settings.synopsisEveryN === 0
      ) {
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

      // v2: 反思条目（每 N 次提取生成一次）
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

      // v2: 主动遗忘（每 N 次提取执行）
      if (
        settings.enableSleepCycle &&
        extractionCount % settings.sleepEveryN === 0
      ) {
        try {
          sleepCycle(currentGraph, settings);
        } catch (e) {
          console.error("[ST-BME] 主动遗忘失败:", e);
        }
      }

      // 压缩检查
      await compressAll(currentGraph, getSchema(), getEmbeddingConfig());
      saveGraphToChat();
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
    const injectionText = formatInjection(result, getSchema());
    lastInjectionContent = injectionText;

    if (injectionText) {
      const tokens = estimateTokens(injectionText);
      console.log(
        `[ST-BME] 注入 ${tokens} 估算 tokens, Core=${result.stats.coreCount}, Recall=${result.stats.recallCount}`,
      );

      // 使用 ST 的 extension prompt API 注入
      context.setExtensionPrompt(
        MODULE_NAME,
        injectionText,
        1, // extension_prompt_types.IN_PROMPT
        settings.injectDepth,
      );
    }

    // 保存召回结果和访问强化
    currentGraph.lastRecallResult = result.selectedNodeIds;
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
      settings.extractEvery = Math.max(1, parseInt($(this).val()) || 1);
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

  // 注入深度
  $("#st_bme_inject_depth")
    .val(settings.injectDepth)
    .on("input", function () {
      settings.injectDepth = Math.max(0, parseInt($(this).val()) || 4);
      saveSettingsDebounced();
    });

  // 评分权重
  $("#st_bme_graph_weight")
    .val(settings.graphWeight)
    .on("input", function () {
      settings.graphWeight = parseFloat($(this).val()) || 0.6;
      saveSettingsDebounced();
    });
  $("#st_bme_vector_weight")
    .val(settings.vectorWeight)
    .on("input", function () {
      settings.vectorWeight = parseFloat($(this).val()) || 0.3;
      saveSettingsDebounced();
    });
  $("#st_bme_importance_weight")
    .val(settings.importanceWeight)
    .on("input", function () {
      settings.importanceWeight = parseFloat($(this).val()) || 0.1;
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
      settings.evoNeighborCount = Math.max(1, parseInt($(this).val()) || 5);
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
      settings.conflictThreshold = parseFloat($(this).val()) || 0.85;
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
      settings.synopsisEveryN = Math.max(1, parseInt($(this).val()) || 5);
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
      settings.forgetThreshold = parseFloat($(this).val()) || 0.5;
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
      settings.probRecallChance = parseFloat($(this).val()) || 0.15;
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
      settings.reflectEveryN = Math.max(3, parseInt($(this).val()) || 10);
      saveSettingsDebounced();
    });
}

// ==================== 初始化 ====================

(async function init() {
  // 加载设置面板 HTML
  const settingsHtml = await renderExtensionTemplateAsync(
    "third-party/st-bme",
    "settings",
  );
  $("#extensions_settings2").append(settingsHtml);

  // 绑定 UI
  bindSettingsUI();

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

  console.log("[ST-BME] 初始化完成");
})();
