// ST-BME: 操控面板交互逻辑

import { renderTemplateAsync } from "../../../templates.js";
import { GraphRenderer } from "./graph-renderer.js";
import { getNodeDisplayName } from "./node-labels.js";
import {
  cloneTaskProfile,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createLocalRegexRule,
  ensureTaskProfiles,
  exportTaskProfile as serializeTaskProfile,
  getBuiltinBlockDefinitions,
  getLegacyPromptFieldForTask,
  getTaskTypeOptions,
  importTaskProfile as parseImportedTaskProfile,
  restoreDefaultTaskProfile,
  setActiveTaskProfileId,
  upsertTaskProfile,
} from "./prompt-profiles.js";
import { getNodeColors } from "./themes.js";
import {
  getSuggestedBackendModel,
  getVectorIndexStats,
} from "./vector-index.js";

// ==================== 默认 Prompt 文本 ====================
// 这些文本会显示在配置页中，供用户查看和修改
const DEFAULT_PROMPTS = {
  extract: [
    "你是一个记忆提取分析器。从对话中提取结构化记忆节点并存入知识图谱。",
    "",
    "输出格式为严格 JSON：",
    "{",
    '  "thought": "你对本段对话的分析（事件/角色变化/新信息）",',
    '  "operations": [',
    "    {",
    '      "action": "create",',
    '      "type": "event",',
    '      "fields": {"title": "简短事件名", "summary": "...", "participants": "...", "status": "ongoing"},',
    '      "importance": 6,',
    '      "ref": "evt1",',
    '      "links": [',
    '        {"targetNodeId": "existing-id", "relation": "involved_in", "strength": 0.9}',
    "      ]",
    "    },",
    "    {",
    '      "action": "update",',
    '      "nodeId": "existing-node-id",',
    '      "fields": {"state": "新的状态"}',
    "    }",
    "  ]",
    "}",
    "",
    "规则：",
    "- 每批对话最多创建 1 个事件节点，多个子事件合并为一条",
    "- 角色/地点节点：如果图中已有同名节点，用 update 而非 create",
    "- 不要虚构内容，只提取对话中有证据支持的信息",
    "- importance 范围 1-10，普通事件 5，关键转折 8+",
    "- event.fields.title 需要是简短事件名，建议 6-18 字，只用于图谱和列表显示",
    "- summary 应该是摘要抽象，不要复制原文",
  ].join("\n"),

  recall: [
    "你是一个记忆召回分析器。",
    "根据用户最新输入和对话上下文，从候选记忆节点中选择最相关的节点。",
    "优先选择：(1) 直接相关的当前场景节点, (2) 因果关系连续性节点, (3) 有潜在影响的背景节点。",
    "输出严格的 JSON 格式：",
    '{"selected_ids": ["id1", "id2", ...], "reason": "简要说明选择理由"}',
  ].join("\n"),

  consolidation: [
    "你是一个记忆整合分析器。当新记忆加入知识图谱时，你需要同时完成两项任务：",
    "",
    "任务一：冲突检测",
    "- skip: 新记忆与已有记忆完全重复",
    "- merge: 新记忆是对旧记忆的修正/补充",
    "- keep: 新记忆是全新信息",
    "",
    "任务二：进化分析（仅 action=keep 时）",
    "- 建立关联连接",
    "- 反向更新旧记忆",
    "",
    "输出严格 JSON：",
    '{ "results": [',
    '  { "node_id": "新记忆节点ID",',
    '    "action": "keep"|"merge"|"skip",',
    '    "merge_target_id": "旧节点ID (仅merge)",',
    '    "reason": "理由",',
    '    "evolution": { "should_evolve": true/false, "connections": ["旧记忆ID"], "neighbor_updates": [...] }',
    "  }",
    "] }",
  ].join("\n"),

  compress: [
    "你是一个记忆压缩器。将多个同类型节点总结为一条更高层级的压缩节点。",
    "",
    "输出格式为严格 JSON：",
    '{"fields": {"summary": "...", ...}}',
    "",
    "规则：",
    "- 保留关键信息：因果关系、不可逆结果、未解决伏笔",
    "- 去除重复和低信息密度内容",
    "- 压缩后文本应精炼，目标 150 字左右",
  ].join("\n"),

  synopsis: [
    "你是故事概要生成器。根据事件线、角色和主线生成简洁的前情提要。",
    '输出 JSON：{"summary": "前情提要文本（200字以内）"}',
    "要求：涵盖核心冲突、关键转折、主要角色当前状态。",
  ].join("\n"),

  reflection: [
    "你是 RP 长期记忆系统的反思生成器。",
    '输出严格 JSON：{"insight":"...","trigger":"...","suggestion":"...","importance":1-10}',
    "insight 应总结最近情节中最值得长期保留的变化、关系趋势或潜在线索。",
    "trigger 说明触发这条反思的关键事件或矛盾。",
    "suggestion 给出后续检索或叙事上值得关注的提示。",
    "不要复述全部事件，要提炼高层结论。",
  ].join("\n"),
};

const TASK_PROFILE_TABS = [
  { id: "generation", label: "生成参数" },
  { id: "prompt", label: "Prompt 编排" },
  { id: "regex", label: "正则" },
];

const TASK_PROFILE_ROLE_OPTIONS = [
  { value: "system", label: "system" },
  { value: "user", label: "user" },
  { value: "assistant", label: "assistant" },
];

const TASK_PROFILE_INJECTION_OPTIONS = [
  { value: "append", label: "追加" },
  { value: "prepend", label: "前置" },
  { value: "relative", label: "相对" },
];

const TASK_PROFILE_BOOLEAN_OPTIONS = [
  { value: "", label: "跟随默认" },
  { value: "true", label: "开启" },
  { value: "false", label: "关闭" },
];

const TASK_PROFILE_GENERATION_GROUPS = [
  {
    title: "基础生成参数",
    fields: [
      { key: "max_context_tokens", label: "max_context_tokens", type: "number" },
      {
        key: "max_completion_tokens",
        label: "max_completion_tokens",
        type: "number",
      },
      { key: "reply_count", label: "reply_count", type: "number" },
      { key: "stream", label: "stream", type: "tri_bool" },
      {
        key: "temperature",
        label: "temperature",
        type: "number",
        step: "0.01",
      },
      { key: "top_p", label: "top_p", type: "number", step: "0.01" },
      { key: "top_k", label: "top_k", type: "number" },
      { key: "top_a", label: "top_a", type: "number", step: "0.01" },
      { key: "min_p", label: "min_p", type: "number", step: "0.01" },
      { key: "seed", label: "seed", type: "number" },
    ],
  },
  {
    title: "惩罚参数",
    fields: [
      {
        key: "frequency_penalty",
        label: "frequency_penalty",
        type: "number",
        step: "0.01",
      },
      {
        key: "presence_penalty",
        label: "presence_penalty",
        type: "number",
        step: "0.01",
      },
      {
        key: "repetition_penalty",
        label: "repetition_penalty",
        type: "number",
        step: "0.01",
      },
    ],
  },
  {
    title: "行为参数",
    fields: [
      {
        key: "squash_system_messages",
        label: "squash_system_messages",
        type: "tri_bool",
      },
      {
        key: "reasoning_effort",
        label: "reasoning_effort",
        type: "enum",
        options: [
          { value: "", label: "跟随默认" },
          { value: "minimal", label: "minimal" },
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" },
        ],
      },
      {
        key: "request_thoughts",
        label: "request_thoughts",
        type: "tri_bool",
      },
      {
        key: "enable_function_calling",
        label: "enable_function_calling",
        type: "tri_bool",
      },
      {
        key: "enable_web_search",
        label: "enable_web_search",
        type: "tri_bool",
      },
      {
        key: "character_name_prefix",
        label: "character_name_prefix",
        type: "text",
      },
      {
        key: "wrap_user_messages_in_quotes",
        label: "wrap_user_messages_in_quotes",
        type: "tri_bool",
      },
    ],
  },
];

const TASK_PROFILE_REGEX_STAGES = [
  { key: "finalPrompt", label: "finalPrompt", desc: "最终 system prompt" },
  {
    key: "input.userMessage",
    label: "input.userMessage",
    desc: "用户消息进入编排前",
  },
  {
    key: "input.recentMessages",
    label: "input.recentMessages",
    desc: "最近消息进入编排前",
  },
  {
    key: "input.candidateText",
    label: "input.candidateText",
    desc: "候选节点文本进入编排前",
  },
  {
    key: "input.finalPrompt",
    label: "input.finalPrompt",
    desc: "最终 assembled prompt",
  },
  { key: "rawResponse", label: "rawResponse", desc: "模型原始输出" },
  { key: "beforeParse", label: "beforeParse", desc: "解析 JSON 前" },
  {
    key: "output.rawResponse",
    label: "output.rawResponse",
    desc: "输出阶段原始响应",
  },
  {
    key: "output.beforeParse",
    label: "output.beforeParse",
    desc: "输出阶段解析前",
  },
];

let panelEl = null;
let overlayEl = null;
let graphRenderer = null;
let mobileGraphRenderer = null;
let currentTabId = "dashboard";
let currentConfigSectionId = "api";
let currentTaskProfileTaskType = "extract";
let currentTaskProfileTabId = "generation";
let currentTaskProfileBlockId = "";
let currentTaskProfileRuleId = "";
let fetchedMemoryLLMModels = [];
let fetchedBackendEmbeddingModels = [];
let fetchedDirectEmbeddingModels = [];

// 由 index.js 注入的引用
let _getGraph = null;
let _getSettings = null;
let _getLastExtract = null;
let _getLastRecall = null;
let _getRuntimeStatus = null;
let _getLastExtractionStatus = null;
let _getLastVectorStatus = null;
let _getLastRecallStatus = null;
let _getLastInjection = null;
let _updateSettings = null;
let _actionHandlers = {};

async function loadLocalTemplate(templateName) {
  const templatePath = new URL(`./${templateName}.html`, import.meta.url)
    .pathname;
  const html = await renderTemplateAsync(templatePath, {}, true, true, true);
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error(`Template render returned empty content: ${templatePath}`);
  }
  return html;
}

/**
 * 初始化面板（由 index.js 调用一次）
 */
export async function initPanel({
  getGraph,
  getSettings,
  getLastExtract,
  getLastRecall,
  getRuntimeStatus,
  getLastExtractionStatus,
  getLastVectorStatus,
  getLastRecallStatus,
  getLastInjection,
  updateSettings,
  actions,
}) {
  _getGraph = getGraph;
  _getSettings = getSettings;
  _getLastExtract = getLastExtract;
  _getLastRecall = getLastRecall;
  _getRuntimeStatus = getRuntimeStatus;
  _getLastExtractionStatus = getLastExtractionStatus;
  _getLastVectorStatus = getLastVectorStatus;
  _getLastRecallStatus = getLastRecallStatus;
  _getLastInjection = getLastInjection;
  _updateSettings = updateSettings;
  _actionHandlers = actions || {};

  overlayEl = document.getElementById("st-bme-panel-overlay");
  panelEl = document.getElementById("st-bme-panel");

  if (!overlayEl || !panelEl) {
    const html = await loadLocalTemplate("panel");
    $("body").append(html);
    overlayEl = document.getElementById("st-bme-panel-overlay");
    panelEl = document.getElementById("st-bme-panel");
    if (!overlayEl || !panelEl) {
      throw new Error(
        "Panel template rendered but required DOM nodes were not found",
      );
    }
  }

  _bindTabs();
  _bindClose();
  _bindResizeHandle();
  _bindGraphControls();
  _bindActions();
  _bindConfigControls();
  currentTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || "dashboard";
  _applyWorkspaceMode();
  _syncConfigSectionState();
  _refreshRuntimeStatus();
}

/**
 * 打开面板
 */
export function openPanel() {
  if (!overlayEl) return;
  overlayEl.classList.add("active");

  const isMobile = _isMobile();
  const settings = _getSettings?.() || {};
  const themeName = settings.panelTheme || "crimson";

  const canvas = document.getElementById("bme-graph-canvas");
  if (canvas && !graphRenderer && !isMobile) {
    graphRenderer = new GraphRenderer(canvas, themeName);
    graphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  const mobileCanvas = document.getElementById("bme-mobile-graph-canvas");
  if (mobileCanvas && !mobileGraphRenderer && isMobile) {
    mobileGraphRenderer = new GraphRenderer(mobileCanvas, themeName);
    mobileGraphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  const activeTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || currentTabId;
  _switchTab(activeTabId);
  _refreshRuntimeStatus();
  _refreshGraph();
  _buildLegend();
}

/**
 * 关闭面板
 */
export function closePanel() {
  if (!overlayEl) return;
  overlayEl.classList.remove("active");
}

/**
 * 更新主题
 */
export function updatePanelTheme(themeName) {
  graphRenderer?.setTheme(themeName);
  mobileGraphRenderer?.setTheme(themeName);
  _buildLegend();
  _highlightThemeChoice(themeName);
}

export function refreshLiveState() {
  if (!overlayEl?.classList.contains("active")) return;
  _refreshRuntimeStatus();

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "memory":
      _refreshMemoryBrowser();
      break;
    case "injection":
      void _refreshInjectionPreview();
      break;
    default:
      break;
  }

  _refreshGraph();
}

// ==================== Tab 切换 ====================

function _bindTabs() {
  panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      _switchTab(tabId);
    });
  });
}

function _switchTab(tabId) {
  currentTabId = tabId || "dashboard";
  panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === currentTabId);
  });

  panelEl?.querySelectorAll(".bme-tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === `bme-pane-${currentTabId}`);
  });

  _applyWorkspaceMode();

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "memory":
      _refreshMemoryBrowser();
      break;
    case "injection":
      void _refreshInjectionPreview();
      break;
    case "config":
      _refreshConfigTab();
      break;
    default:
      break;
  }
}

function _applyWorkspaceMode() {
  if (!panelEl) return;
  const isConfig = currentTabId === "config";
  panelEl.classList.toggle("config-mode", isConfig);
}

function _switchConfigSection(sectionId) {
  currentConfigSectionId = sectionId || "api";
  _syncConfigSectionState();
}

function _syncConfigSectionState() {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-config-nav-btn").forEach((btn) => {
    btn.classList.toggle(
      "active",
      btn.dataset.configSection === currentConfigSectionId,
    );
  });
  panelEl.querySelectorAll(".bme-config-section").forEach((section) => {
    section.classList.toggle(
      "active",
      section.dataset.configSection === currentConfigSectionId,
    );
  });
}

// ==================== 总览 Tab ====================

function _refreshDashboard() {
  const graph = _getGraph?.();
  if (!graph) return;

  const activeNodes = graph.nodes.filter((node) => !node.archived);
  const archivedCount = graph.nodes.filter((node) => node.archived).length;
  const totalNodes = graph.nodes.length;
  const fragRate =
    totalNodes > 0 ? Math.round((archivedCount / totalNodes) * 100) : 0;

  _setText("bme-stat-nodes", activeNodes.length);
  _setText("bme-stat-edges", graph.edges.length);
  _setText("bme-stat-archived", archivedCount);
  _setText("bme-stat-frag", `${fragRate}%`);

  const chatId = graph?.historyState?.chatId || "—";
  const lastProcessed = graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  const vectorStats = getVectorIndexStats(graph);
  const vectorMode = graph?.vectorIndexState?.mode || "—";
  const vectorSource = graph?.vectorIndexState?.source || "—";
  const recovery = graph?.historyState?.lastRecoveryResult;
  const extractionStatus = _getLastExtractionStatus?.() || {};
  const vectorStatus = _getLastVectorStatus?.() || {};
  const recallStatus = _getLastRecallStatus?.() || {};

  _setText("bme-status-chat-id", chatId);
  _setText(
    "bme-status-history",
    Number.isFinite(dirtyFrom)
      ? `脏区从楼层 ${dirtyFrom} 开始，已处理到 ${lastProcessed}`
      : `干净，已处理到楼层 ${lastProcessed}`,
  );
  _setText(
    "bme-status-vector",
    `${vectorMode}/${vectorSource} · total ${vectorStats.total} · indexed ${vectorStats.indexed} · stale ${vectorStats.stale} · pending ${vectorStats.pending}`,
  );
  _setText(
    "bme-status-recovery",
    recovery
      ? [
          recovery.status || "—",
          recovery.path ? `path ${recovery.path}` : "",
          recovery.detectionSource ? `src ${recovery.detectionSource}` : "",
          recovery.fromFloor != null ? `from ${recovery.fromFloor}` : "",
          recovery.affectedBatchCount != null
            ? `affected ${recovery.affectedBatchCount}`
            : "",
          recovery.replayedBatchCount != null
            ? `replayed ${recovery.replayedBatchCount}`
            : "",
          recovery.reason || "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "暂无恢复记录",
  );
  _setText("bme-status-last-extract", extractionStatus.meta || "尚未执行提取");
  _setText("bme-status-last-vector", vectorStatus.meta || "尚未执行向量任务");
  _setText("bme-status-last-recall", recallStatus.meta || "尚未执行召回");

  _renderRecentList("bme-recent-extract", _getLastExtract?.() || []);
  _renderRecentList("bme-recent-recall", _getLastRecall?.() || []);
}

function _renderRecentList(elementId, items) {
  const listEl = document.getElementById(elementId);
  if (!listEl) return;

  if (!items.length) {
    listEl.innerHTML =
      '<li class="bme-recent-item"><div class="bme-recent-text" style="color:var(--bme-on-surface-dim)">暂无数据</div></li>';
    return;
  }

  listEl.innerHTML = items
    .map((item) => {
      const secondary = item.meta || item.time || "";
      return `<li class="bme-recent-item">
                <span class="bme-type-badge ${item.type}">${_typeLabel(item.type)}</span>
                <div>
                    <div class="bme-recent-text">${_escHtml(item.name || "—")}</div>
                    <div class="bme-recent-meta">${_escHtml(secondary)}</div>
                </div>
            </li>`;
    })
    .join("");
}

// ==================== 记忆浏览器 ====================

function _refreshMemoryBrowser() {
  const graph = _getGraph?.();
  if (!graph) return;

  const searchInput = document.getElementById("bme-memory-search");
  const filterSelect = document.getElementById("bme-memory-filter");
  const listEl = document.getElementById("bme-memory-list");
  if (!listEl) return;

  const query = String(searchInput?.value || "")
    .trim()
    .toLowerCase();
  const filter = filterSelect?.value || "all";

  let nodes = graph.nodes.filter((node) => !node.archived);
  if (filter !== "all") {
    nodes = nodes.filter((node) => node.type === filter);
  }
  if (query) {
    nodes = nodes.filter((node) => {
      const name = getNodeDisplayName(node).toLowerCase();
      const text = JSON.stringify(node.fields || {}).toLowerCase();
      return name.includes(query) || text.includes(query);
    });
  }

  nodes.sort((a, b) => {
    const importanceDiff = (b.importance || 5) - (a.importance || 5);
    if (importanceDiff !== 0) return importanceDiff;
    return (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0);
  });

  listEl.innerHTML = nodes
    .slice(0, 100)
    .map((node) => {
      const name = getNodeDisplayName(node);
      const snippet = _getNodeSnippet(node);
      return `<li class="bme-memory-item" data-node-id="${node.id}">
                <span class="bme-type-badge ${node.type}">${_typeLabel(node.type)}</span>
                <div>
                    <div class="bme-memory-name">${_escHtml(name)}</div>
                    <div class="bme-memory-content">${_escHtml(snippet)}</div>
                    <div class="bme-memory-meta">
                        <span>imp: ${node.importance || 5}</span>
                        <span>acc: ${node.accessCount || 0}</span>
                        <span>seq: ${node.seqRange?.[1] ?? node.seq ?? 0}</span>
                    </div>
                </div>
            </li>`;
    })
    .join("");

  listEl.querySelectorAll(".bme-memory-item").forEach((el) => {
    el.addEventListener("click", () => {
      const nodeId = el.dataset.nodeId;
      graphRenderer?.highlightNode(nodeId);
      mobileGraphRenderer?.highlightNode(nodeId);
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (node) _showNodeDetail(node);
    });
  });

  if (searchInput && !searchInput._bmeBound) {
    let timer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => _refreshMemoryBrowser(), 200);
    });
    filterSelect?.addEventListener("change", () => _refreshMemoryBrowser());
    searchInput._bmeBound = true;
  }
}

// ==================== 注入预览 ====================

async function _refreshInjectionPreview() {
  const container = document.getElementById("bme-injection-content");
  const tokenEl = document.getElementById("bme-injection-tokens");
  if (!container) return;

  const injection = String(_getLastInjection?.() || "").trim();
  if (!injection) {
    container.innerHTML =
      '<div class="bme-injection-preview" style="color:var(--bme-on-surface-dim)">暂无注入内容。先完成一次召回或正常生成后再查看。</div>';
    if (tokenEl) tokenEl.textContent = "";
    return;
  }

  try {
    const { estimateTokens } = await import("./injector.js");
    const totalTokens = estimateTokens(injection);
    container.innerHTML = `<div class="bme-injection-preview">${_escHtml(injection)}</div>`;
    if (tokenEl) tokenEl.textContent = `≈ ${totalTokens} tokens`;
  } catch (error) {
    container.innerHTML = `<div class="bme-injection-preview" style="color:var(--bme-accent3)">预览生成失败: ${_escHtml(error.message)}</div>`;
    if (tokenEl) tokenEl.textContent = "";
  }
}

// ==================== 图谱 ====================

function _refreshGraph() {
  const graph = _getGraph?.();
  if (!graph) return;
  graphRenderer?.loadGraph(graph);
  mobileGraphRenderer?.loadGraph(graph);
}

function _buildLegend() {
  const legendEl = document.getElementById("bme-graph-legend");
  if (!legendEl) return;

  const settings = _getSettings?.() || {};
  const colors = getNodeColors(settings.panelTheme || "crimson");
  const types = [
    { key: "character", label: "角色" },
    { key: "event", label: "事件" },
    { key: "location", label: "地点" },
    { key: "thread", label: "主线" },
    { key: "rule", label: "规则" },
    { key: "synopsis", label: "概要" },
    { key: "reflection", label: "反思" },
  ];

  legendEl.innerHTML = types
    .map(
      (type) => `<span class="bme-legend-item">
            <span class="bme-legend-dot" style="background:${colors[type.key]}"></span>
            ${type.label}
        </span>`,
    )
    .join("");
}

function _bindGraphControls() {
  document
    .getElementById("bme-graph-zoom-in")
    ?.addEventListener("click", () => graphRenderer?.zoomIn());
  document
    .getElementById("bme-graph-zoom-out")
    ?.addEventListener("click", () => graphRenderer?.zoomOut());
  document
    .getElementById("bme-graph-reset")
    ?.addEventListener("click", () => graphRenderer?.resetView());
}

// ==================== 节点详情 ====================

function _showNodeDetail(node) {
  const detailEl = document.getElementById("bme-node-detail");
  const titleEl = document.getElementById("bme-detail-title");
  const bodyEl = document.getElementById("bme-detail-body");
  if (!detailEl || !titleEl || !bodyEl) return;

  const raw = node.raw || node;
  const fields = raw.fields || {};
  titleEl.textContent = getNodeDisplayName(raw);

  const items = [
    { label: "类型", value: _typeLabel(raw.type) },
    { label: "ID", value: raw.id || "—" },
    { label: "重要度", value: raw.importance || 5 },
    { label: "访问次数", value: raw.accessCount || 0 },
    { label: "序列号", value: raw.seqRange?.[1] ?? raw.seq ?? 0 },
  ];

  if (Array.isArray(raw.seqRange)) {
    items.push({
      label: "序列范围",
      value: `${raw.seqRange[0]} ~ ${raw.seqRange[1]}`,
    });
  }
  if (Array.isArray(raw.clusters) && raw.clusters.length > 0) {
    items.push({ label: "聚类标签", value: raw.clusters.join(", ") });
  }

  for (const [key, value] of Object.entries(fields)) {
    items.push({
      label: key,
      value: typeof value === "object" ? JSON.stringify(value, null, 2) : value,
    });
  }

  bodyEl.innerHTML = items
    .map(
      (item) => `<div class="bme-node-detail-field">
            <label>${_escHtml(item.label)}</label>
            <div class="value">${_escHtml(String(item.value ?? "—"))}</div>
        </div>`,
    )
    .join("");

  detailEl.classList.add("open");
}

function _bindClose() {
  document
    .getElementById("bme-panel-close")
    ?.addEventListener("click", closePanel);
  document.getElementById("bme-detail-close")?.addEventListener("click", () => {
    document.getElementById("bme-node-detail")?.classList.remove("open");
  });
  overlayEl?.addEventListener("click", (event) => {
    if (event.target === overlayEl) closePanel();
  });
}

function _bindResizeHandle() {
  const handle = document.getElementById("bme-resize-handle");
  const sidebar = panelEl?.querySelector(".bme-panel-sidebar");
  if (!handle || !sidebar) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(180, Math.min(600, startWidth + delta));
    sidebar.style.width = newWidth + "px";
    sidebar.style.minWidth = newWidth + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ==================== 操作绑定 ====================

function _bindActions() {
  const bindings = {
    "bme-act-extract": "extract",
    "bme-act-compress": "compress",
    "bme-act-sleep": "sleep",
    "bme-act-synopsis": "synopsis",
    "bme-act-export": "export",
    "bme-act-import": "import",
    "bme-act-rebuild": "rebuild",
    "bme-act-evolve": "evolve",
    "bme-act-vector-rebuild": "rebuildVectorIndex",
    "bme-act-vector-reembed": "reembedDirect",
  };

  const actionLabels = {
    extract: "手动提取",
    compress: "手动压缩",
    sleep: "执行遗忘",
    synopsis: "更新概要",
    export: "导出图谱",
    import: "导入图谱",
    rebuild: "重建图谱",
    evolve: "强制进化",
    rebuildVectorIndex: "重建向量",
    reembedDirect: "直连重嵌",
  };

  for (const [elementId, actionKey] of Object.entries(bindings)) {
    const btn = document.getElementById(elementId);
    if (!btn) continue;

    btn.addEventListener("click", async () => {
      const handler = _actionHandlers[actionKey];
      if (!handler) return;

      const label = actionLabels[actionKey] || actionKey;

      // 防止重复点击
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = "0.5";

      toastr.info(`${label} 进行中…`, "ST-BME", { timeOut: 2000 });

      try {
        await handler();
        _refreshDashboard();
        _refreshGraph();
        if (
          document
            .getElementById("bme-pane-memory")
            ?.classList.contains("active")
        ) {
          _refreshMemoryBrowser();
        }
        if (
          document
            .getElementById("bme-pane-injection")
            ?.classList.contains("active")
        ) {
          await _refreshInjectionPreview();
        }
        toastr.success(`${label} 完成`, "ST-BME");
      } catch (error) {
        console.error(`[ST-BME] Action ${actionKey} failed:`, error);
        toastr.error(`${label} 失败: ${error?.message || error}`, "ST-BME");
      } finally {
        btn.disabled = false;
        btn.style.opacity = "";
      }
    });
  }

  document
    .getElementById("bme-act-vector-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-vector-range");
      if (btn?.disabled) return;
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      toastr.info("范围重建 进行中…", "ST-BME", { timeOut: 2000 });

      try {
        const start = _parseOptionalInt(
          document.getElementById("bme-range-start")?.value,
        );
        const end = _parseOptionalInt(
          document.getElementById("bme-range-end")?.value,
        );
        await _actionHandlers.rebuildVectorRange?.(
          Number.isFinite(start) && Number.isFinite(end)
            ? { start, end }
            : null,
        );
        _refreshDashboard();
        _refreshGraph();
        toastr.success("范围重建 完成", "ST-BME");
      } catch (error) {
        console.error("[ST-BME] Action rebuildVectorRange failed:", error);
        toastr.error(`范围重建 失败: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.style.opacity = "";
        }
      }
    });
}

function _refreshConfigTab() {
  const settings = _getSettings?.() || {};

  _setCheckboxValue("bme-setting-enabled", settings.enabled ?? false);
  _setCheckboxValue(
    "bme-setting-recall-enabled",
    settings.recallEnabled ?? true,
  );
  _setCheckboxValue("bme-setting-recall-llm", settings.recallEnableLLM ?? true);
  _setCheckboxValue(
    "bme-setting-recall-vector-prefilter-enabled",
    settings.recallEnableVectorPrefilter ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-graph-diffusion-enabled",
    settings.recallEnableGraphDiffusion ?? true,
  );
  _setCheckboxValue(
    "bme-setting-consolidation-enabled",
    settings.enableConsolidation ?? true,
  );
  _setCheckboxValue(
    "bme-setting-synopsis-enabled",
    settings.enableSynopsis ?? true,
  );
  _setCheckboxValue(
    "bme-setting-visibility-enabled",
    settings.enableVisibility ?? false,
  );
  _setCheckboxValue(
    "bme-setting-cross-recall-enabled",
    settings.enableCrossRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-smart-trigger-enabled",
    settings.enableSmartTrigger ?? false,
  );
  _setCheckboxValue(
    "bme-setting-sleep-cycle-enabled",
    settings.enableSleepCycle ?? false,
  );
  _setCheckboxValue(
    "bme-setting-prob-recall-enabled",
    settings.enableProbRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-reflection-enabled",
    settings.enableReflection ?? false,
  );

  _setInputValue("bme-setting-extract-every", settings.extractEvery ?? 1);
  _setInputValue(
    "bme-setting-extract-context-turns",
    settings.extractContextTurns ?? 2,
  );
  _setInputValue("bme-setting-recall-top-k", settings.recallTopK ?? 20);
  _setInputValue("bme-setting-recall-max-nodes", settings.recallMaxNodes ?? 8);
  _setInputValue(
    "bme-setting-recall-diffusion-top-k",
    settings.recallDiffusionTopK ?? 100,
  );
  _setInputValue(
    "bme-setting-recall-llm-candidate-pool",
    settings.recallLlmCandidatePool ?? 30,
  );
  _setInputValue(
    "bme-setting-recall-llm-context-messages",
    settings.recallLlmContextMessages ?? 4,
  );
  _setInputValue("bme-setting-inject-depth", settings.injectDepth ?? 9999);
  _setInputValue("bme-setting-graph-weight", settings.graphWeight ?? 0.6);
  _setInputValue("bme-setting-vector-weight", settings.vectorWeight ?? 0.3);
  _setInputValue(
    "bme-setting-importance-weight",
    settings.importanceWeight ?? 0.1,
  );
  _setInputValue(
    "bme-setting-consolidation-neighbor-count",
    settings.consolidationNeighborCount ?? 5,
  );
  _setInputValue(
    "bme-setting-consolidation-threshold",
    settings.consolidationThreshold ?? 0.85,
  );
  _setInputValue("bme-setting-synopsis-every", settings.synopsisEveryN ?? 5);
  _setInputValue(
    "bme-setting-trigger-patterns",
    settings.triggerPatterns || "",
  );
  _setInputValue(
    "bme-setting-smart-trigger-threshold",
    settings.smartTriggerThreshold ?? 2,
  );
  _setInputValue(
    "bme-setting-forget-threshold",
    settings.forgetThreshold ?? 0.5,
  );
  _setInputValue("bme-setting-sleep-every", settings.sleepEveryN ?? 10);
  _setInputValue(
    "bme-setting-prob-recall-chance",
    settings.probRecallChance ?? 0.15,
  );
  _setInputValue("bme-setting-reflect-every", settings.reflectEveryN ?? 10);

  _setInputValue("bme-setting-llm-url", settings.llmApiUrl || "");
  _setInputValue("bme-setting-llm-key", settings.llmApiKey || "");
  _setInputValue("bme-setting-llm-model", settings.llmModel || "");
  _setInputValue("bme-setting-timeout-ms", settings.timeoutMs ?? 300000);

  _setInputValue("bme-setting-embed-url", settings.embeddingApiUrl || "");
  _setInputValue("bme-setting-embed-key", settings.embeddingApiKey || "");
  _setInputValue(
    "bme-setting-embed-model",
    settings.embeddingModel || "text-embedding-3-small",
  );
  _setInputValue(
    "bme-setting-embed-mode",
    settings.embeddingTransportMode || "backend",
  );
  _toggleEmbedFields(settings.embeddingTransportMode || "backend");
  _setInputValue(
    "bme-setting-embed-backend-source",
    settings.embeddingBackendSource || "openai",
  );
  _setInputValue(
    "bme-setting-embed-backend-model",
    settings.embeddingBackendModel ||
      getSuggestedBackendModel(settings.embeddingBackendSource || "openai"),
  );
  _setInputValue(
    "bme-setting-embed-backend-url",
    settings.embeddingBackendApiUrl || "",
  );
  _setCheckboxValue(
    "bme-setting-embed-auto-suffix",
    settings.embeddingAutoSuffix !== false,
  );

  _setInputValue(
    "bme-setting-extract-prompt",
    settings.extractPrompt || DEFAULT_PROMPTS.extract,
  );
  _setInputValue(
    "bme-setting-recall-prompt",
    settings.recallPrompt || DEFAULT_PROMPTS.recall,
  );
  _setInputValue(
    "bme-setting-consolidation-prompt",
    settings.consolidationPrompt || DEFAULT_PROMPTS.consolidation,
  );
  _setInputValue(
    "bme-setting-compress-prompt",
    settings.compressPrompt || DEFAULT_PROMPTS.compress,
  );
  _setInputValue(
    "bme-setting-synopsis-prompt",
    settings.synopsisPrompt || DEFAULT_PROMPTS.synopsis,
  );
  _setInputValue(
    "bme-setting-reflection-prompt",
    settings.reflectionPrompt || DEFAULT_PROMPTS.reflection,
  );

  _refreshFetchedModelSelects(settings);
  _refreshGuardedConfigStates(settings);
  _refreshStageCardStates(settings);
  _refreshPromptCardStates(settings);
  _refreshTaskProfileWorkspace(settings);
  _highlightThemeChoice(settings.panelTheme || "crimson");
  _syncConfigSectionState();
}

function _bindConfigControls() {
  if (!panelEl || panelEl.dataset.bmeConfigBound === "true") return;

  panelEl.querySelectorAll(".bme-config-nav-btn").forEach((btn) => {
    if (btn.dataset.bmeBound === "true") return;
    btn.addEventListener("click", () => {
      _switchConfigSection(btn.dataset.configSection || "api");
    });
    btn.dataset.bmeBound = "true";
  });

  bindCheckbox("bme-setting-enabled", (checked) => {
    _patchSettings({ enabled: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-recall-enabled", (checked) => {
    _patchSettings({ recallEnabled: checked });
    _refreshGuardedConfigStates();
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-llm", (checked) => {
    _patchSettings({ recallEnableLLM: checked });
    _refreshGuardedConfigStates();
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-vector-prefilter-enabled", (checked) => {
    _patchSettings({ recallEnableVectorPrefilter: checked });
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-recall-graph-diffusion-enabled", (checked) => {
    _patchSettings({ recallEnableGraphDiffusion: checked });
    _refreshStageCardStates();
  });
  bindCheckbox("bme-setting-consolidation-enabled", (checked) => {
    _patchSettings({ enableConsolidation: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-synopsis-enabled", (checked) => {
    _patchSettings({ enableSynopsis: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-visibility-enabled", (checked) =>
    _patchSettings({ enableVisibility: checked }),
  );
  bindCheckbox("bme-setting-cross-recall-enabled", (checked) =>
    _patchSettings({ enableCrossRecall: checked }),
  );
  bindCheckbox("bme-setting-smart-trigger-enabled", (checked) => {
    _patchSettings({ enableSmartTrigger: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-sleep-cycle-enabled", (checked) => {
    _patchSettings({ enableSleepCycle: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-prob-recall-enabled", (checked) => {
    _patchSettings({ enableProbRecall: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-reflection-enabled", (checked) => {
    _patchSettings({ enableReflection: checked });
    _refreshGuardedConfigStates();
  });

  bindNumber("bme-setting-extract-every", 1, 1, 50, (value) =>
    _patchSettings({ extractEvery: value }),
  );
  bindNumber("bme-setting-extract-context-turns", 2, 0, 20, (value) =>
    _patchSettings({ extractContextTurns: value }),
  );
  bindNumber("bme-setting-recall-top-k", 20, 1, 100, (value) =>
    _patchSettings({ recallTopK: value }),
  );
  bindNumber("bme-setting-recall-max-nodes", 8, 1, 50, (value) =>
    _patchSettings({ recallMaxNodes: value }),
  );
  bindNumber("bme-setting-recall-diffusion-top-k", 100, 1, 300, (value) =>
    _patchSettings({ recallDiffusionTopK: value }),
  );
  bindNumber("bme-setting-recall-llm-candidate-pool", 30, 1, 100, (value) =>
    _patchSettings({ recallLlmCandidatePool: value }),
  );
  bindNumber("bme-setting-recall-llm-context-messages", 4, 0, 20, (value) =>
    _patchSettings({ recallLlmContextMessages: value }),
  );
  bindNumber("bme-setting-inject-depth", 9999, 0, 9999, (value) =>
    _patchSettings({ injectDepth: value }),
  );
  bindFloat("bme-setting-graph-weight", 0.6, 0, 1, (value) =>
    _patchSettings({ graphWeight: value }),
  );
  bindFloat("bme-setting-vector-weight", 0.3, 0, 1, (value) =>
    _patchSettings({ vectorWeight: value }),
  );
  bindFloat("bme-setting-importance-weight", 0.1, 0, 1, (value) =>
    _patchSettings({ importanceWeight: value }),
  );
  bindNumber("bme-setting-consolidation-neighbor-count", 5, 1, 20, (value) =>
    _patchSettings({ consolidationNeighborCount: value }),
  );
  bindFloat("bme-setting-consolidation-threshold", 0.85, 0.5, 0.99, (value) =>
    _patchSettings({ consolidationThreshold: value }),
  );
  bindNumber("bme-setting-synopsis-every", 5, 1, 100, (value) =>
    _patchSettings({ synopsisEveryN: value }),
  );
  bindText("bme-setting-trigger-patterns", (value) =>
    _patchSettings({ triggerPatterns: value }),
  );
  bindNumber("bme-setting-smart-trigger-threshold", 2, 1, 10, (value) =>
    _patchSettings({ smartTriggerThreshold: value }),
  );
  bindFloat("bme-setting-forget-threshold", 0.5, 0.1, 1, (value) =>
    _patchSettings({ forgetThreshold: value }),
  );
  bindNumber("bme-setting-sleep-every", 10, 1, 200, (value) =>
    _patchSettings({ sleepEveryN: value }),
  );
  bindFloat("bme-setting-prob-recall-chance", 0.15, 0.01, 0.5, (value) =>
    _patchSettings({ probRecallChance: value }),
  );
  bindNumber("bme-setting-reflect-every", 10, 1, 200, (value) =>
    _patchSettings({ reflectEveryN: value }),
  );

  bindText("bme-setting-llm-url", (value) =>
    _patchSettings({ llmApiUrl: value.trim() }),
  );
  bindText("bme-setting-llm-key", (value) =>
    _patchSettings({ llmApiKey: value.trim() }),
  );
  bindText("bme-setting-llm-model", (value) =>
    _patchSettings({ llmModel: value.trim() }),
  );
  bindNumber("bme-setting-timeout-ms", 300000, 1000, 3600000, (value) =>
    _patchSettings({ timeoutMs: value }),
  );

  bindText("bme-setting-embed-url", (value) =>
    _patchSettings({ embeddingApiUrl: value.trim() }),
  );
  bindText("bme-setting-embed-key", (value) =>
    _patchSettings({ embeddingApiKey: value.trim() }),
  );
  bindText("bme-setting-embed-model", (value) =>
    _patchSettings({ embeddingModel: value.trim() }),
  );
  bindText("bme-setting-embed-mode", (value) => {
    _patchSettings({ embeddingTransportMode: value });
    _toggleEmbedFields(value);
  });
  bindText("bme-setting-embed-backend-source", (value) => {
    const settings = _getSettings?.() || {};
    const patch = { embeddingBackendSource: value };
    const suggestedModel = getSuggestedBackendModel(value);
    if (
      !settings.embeddingBackendModel ||
      settings.embeddingBackendModel ===
        getSuggestedBackendModel(settings.embeddingBackendSource || "openai")
    ) {
      patch.embeddingBackendModel = suggestedModel;
    }
    _patchSettings(patch);
    _setInputValue(
      "bme-setting-embed-backend-model",
      patch.embeddingBackendModel || settings.embeddingBackendModel || "",
    );
  });
  bindText("bme-setting-embed-backend-model", (value) =>
    _patchSettings({ embeddingBackendModel: value.trim() }),
  );
  bindText("bme-setting-embed-backend-url", (value) =>
    _patchSettings({ embeddingBackendApiUrl: value.trim() }),
  );
  bindCheckbox("bme-setting-embed-auto-suffix", (checked) =>
    _patchSettings({ embeddingAutoSuffix: checked }),
  );

  bindPromptText("bme-setting-extract-prompt", "extractPrompt", "extract");
  bindPromptText("bme-setting-recall-prompt", "recallPrompt", "recall");
  bindPromptText(
    "bme-setting-consolidation-prompt",
    "consolidationPrompt",
    "consolidation",
  );
  bindPromptText("bme-setting-compress-prompt", "compressPrompt", "compress");
  bindPromptText("bme-setting-synopsis-prompt", "synopsisPrompt", "synopsis");
  bindPromptText(
    "bme-setting-reflection-prompt",
    "reflectionPrompt",
    "reflection",
  );
  _bindTaskProfileWorkspace();

  panelEl.querySelectorAll(".bme-prompt-reset").forEach((button) => {
    if (button.dataset.bmeBound === "true") return;
    button.addEventListener("click", () => {
      const settingKey = button.dataset.settingKey;
      const promptKey = button.dataset.defaultPrompt;
      const targetId = button.dataset.targetId;
      if (!settingKey || !promptKey || !targetId) return;
      _patchSettings({ [settingKey]: "" }, { refreshPrompts: true });
      _setInputValue(targetId, DEFAULT_PROMPTS[promptKey] || "");
      _refreshPromptCardStates();
    });
    button.dataset.bmeBound = "true";
  });

  const pickerBtn = document.getElementById("bme-theme-picker-btn");
  const dropdown = document.getElementById("bme-theme-dropdown");
  if (pickerBtn && dropdown) {
    pickerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
    dropdown.querySelectorAll(".bme-theme-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const theme = opt.dataset.theme;
        if (!theme) return;
        _patchSettings({ panelTheme: theme }, { refreshTheme: true });
        dropdown.classList.remove("open");
      });
    });
    document.addEventListener("click", () => {
      dropdown.classList.remove("open");
    });
    dropdown.addEventListener("click", (e) => e.stopPropagation());
  }

  panelEl.querySelectorAll(".bme-theme-card").forEach((card) => {
    if (card.dataset.bmeBound === "true") return;
    card.addEventListener("click", () => {
      const theme = card.dataset.theme;
      if (!theme) return;
      _patchSettings({ panelTheme: theme }, { refreshTheme: true });
    });
    card.dataset.bmeBound = "true";
  });

  document
    .getElementById("bme-test-llm")
    ?.addEventListener("click", async () => {
      await _actionHandlers.testMemoryLLM?.();
    });
  document
    .getElementById("bme-test-embedding")
    ?.addEventListener("click", async () => {
      await _actionHandlers.testEmbedding?.();
    });
  document
    .getElementById("bme-fetch-llm-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchMemoryLLMModels?.();
      if (!result?.success) return;
      fetchedMemoryLLMModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-llm-model",
        fetchedMemoryLLMModels,
        (_getSettings?.() || {}).llmModel || "",
      );
    });
  document
    .getElementById("bme-fetch-embed-backend-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchEmbeddingModels?.("backend");
      if (!result?.success) return;
      fetchedBackendEmbeddingModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-embed-backend-model",
        fetchedBackendEmbeddingModels,
        (_getSettings?.() || {}).embeddingBackendModel || "",
      );
    });
  document
    .getElementById("bme-fetch-embed-direct-models")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.fetchEmbeddingModels?.("direct");
      if (!result?.success) return;
      fetchedDirectEmbeddingModels = result.models || [];
      _renderFetchedModelOptions(
        "bme-select-embed-direct-model",
        fetchedDirectEmbeddingModels,
        (_getSettings?.() || {}).embeddingModel || "",
      );
    });

  bindSelectModel("bme-select-llm-model", "bme-setting-llm-model", "llmModel");
  bindSelectModel(
    "bme-select-embed-backend-model",
    "bme-setting-embed-backend-model",
    "embeddingBackendModel",
  );
  bindSelectModel(
    "bme-select-embed-direct-model",
    "bme-setting-embed-model",
    "embeddingModel",
  );

  panelEl.dataset.bmeConfigBound = "true";
}

function bindText(id, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => onChange(element.value));
  element.addEventListener("change", () => onChange(element.value));
  element.dataset.bmeBound = "true";
}

function bindCheckbox(id, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("change", () => onChange(Boolean(element.checked)));
  element.dataset.bmeBound = "true";
}

function bindNumber(id, fallback, min, max, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => {
    let value = Number.parseInt(element.value, 10);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.min(max, Math.max(min, value));
    onChange(value);
  });
  element.dataset.bmeBound = "true";
}

function bindFloat(id, fallback, min, max, onChange) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("input", () => {
    let value = Number.parseFloat(element.value);
    if (!Number.isFinite(value)) value = fallback;
    value = Math.min(max, Math.max(min, value));
    onChange(value);
  });
  element.dataset.bmeBound = "true";
}

function bindPromptText(id, settingKey, promptKey) {
  const element = document.getElementById(id);
  if (!element || element.dataset.bmeBound === "true") return;
  const update = () => {
    _patchSettings({ [settingKey]: element.value }, { refreshPrompts: true });
  };
  element.addEventListener("input", update);
  element.addEventListener("change", update);
  element.addEventListener("blur", () => {
    if (!String(element.value || "").trim()) {
      _setInputValue(id, DEFAULT_PROMPTS[promptKey] || "");
    }
  });
  element.dataset.bmeBound = "true";
}

function bindSelectModel(selectId, inputId, settingKey) {
  const element = document.getElementById(selectId);
  if (!element || element.dataset.bmeBound === "true") return;
  element.addEventListener("change", () => {
    if (!element.value) return;
    _setInputValue(inputId, element.value);
    _patchSettings({ [settingKey]: element.value });
  });
  element.dataset.bmeBound = "true";
}

function _bindTaskProfileWorkspace() {
  const workspace = document.getElementById("bme-task-profile-workspace");
  const importInput = document.getElementById("bme-task-profile-import");
  if (!workspace) return;

  if (workspace.dataset.bmeBound !== "true") {
    workspace.addEventListener("click", (event) => {
      void _handleTaskProfileWorkspaceClick(event);
    });
    workspace.addEventListener("input", (event) => {
      _handleTaskProfileWorkspaceInput(event);
    });
    workspace.addEventListener("change", (event) => {
      _handleTaskProfileWorkspaceChange(event);
    });
    workspace.dataset.bmeBound = "true";
  }

  if (importInput && importInput.dataset.bmeBound !== "true") {
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const settings = _getSettings?.() || {};
        const imported = parseImportedTaskProfile(
          settings.taskProfiles || {},
          text,
        );
        currentTaskProfileTaskType = imported.taskType || currentTaskProfileTaskType;
        currentTaskProfileBlockId = imported.profile?.blocks?.[0]?.id || "";
        currentTaskProfileRuleId =
          imported.profile?.regex?.localRules?.[0]?.id || "";
        _patchTaskProfiles(imported.taskProfiles);
        toastr.success("预设导入成功", "ST-BME");
      } catch (error) {
        console.error("[ST-BME] 导入任务预设失败:", error);
        toastr.error(`预设导入失败: ${error?.message || error}`, "ST-BME");
      } finally {
        importInput.value = "";
      }
    });
    importInput.dataset.bmeBound = "true";
  }
}

function _handleTaskProfileWorkspaceInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === "bme-task-profile-name") {
    _updateCurrentTaskProfile(
      (draft) => {
        draft.name = String(target.value || "").trim() || draft.name;
      },
      { refresh: false },
    );
    return;
  }

  if (target.matches("[data-block-field]")) {
    _persistSelectedBlockField(target, false);
    return;
  }

  if (target.matches("[data-generation-key]")) {
    _persistGenerationField(target, false);
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    _persistSelectedRegexRuleField(target, false);
  }
}

function _handleTaskProfileWorkspaceChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === "bme-task-profile-select") {
    const settings = _getSettings?.() || {};
    const nextTaskProfiles = setActiveTaskProfileId(
      settings.taskProfiles || {},
      currentTaskProfileTaskType,
      target.value,
    );
    currentTaskProfileBlockId = "";
    currentTaskProfileRuleId = "";
    _patchTaskProfiles(nextTaskProfiles);
    return;
  }

  if (target.matches("[data-block-field]")) {
    _persistSelectedBlockField(target, true);
    return;
  }

  if (target.matches("[data-generation-key]")) {
    _persistGenerationField(target, true);
    return;
  }

  if (target.matches("[data-regex-field]")) {
    _persistRegexConfigField(target, false);
    return;
  }

  if (target.matches("[data-regex-source]")) {
    _persistRegexSourceField(target, false);
    return;
  }

  if (target.matches("[data-regex-stage]")) {
    _persistRegexStageField(target, false);
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    _persistSelectedRegexRuleField(target, true);
  }
}

function _getTaskProfileWorkspaceState(settings = _getSettings?.() || {}) {
  const taskProfiles = ensureTaskProfiles(settings);
  const taskTypeOptions = getTaskTypeOptions();

  if (!taskTypeOptions.some((item) => item.id === currentTaskProfileTaskType)) {
    currentTaskProfileTaskType = taskTypeOptions[0]?.id || "extract";
  }

  if (!TASK_PROFILE_TABS.some((item) => item.id === currentTaskProfileTabId)) {
    currentTaskProfileTabId = TASK_PROFILE_TABS[0]?.id || "generation";
  }

  const bucket = taskProfiles[currentTaskProfileTaskType] || {
    activeProfileId: "default",
    profiles: [],
  };
  const profile =
    bucket.profiles.find((item) => item.id === bucket.activeProfileId) ||
    bucket.profiles[0] ||
    null;
  const blocks = _sortTaskBlocks(profile?.blocks || []);
  const regexRules = Array.isArray(profile?.regex?.localRules)
    ? profile.regex.localRules
    : [];

  if (!blocks.some((block) => block.id === currentTaskProfileBlockId)) {
    currentTaskProfileBlockId = blocks[0]?.id || "";
  }
  if (!regexRules.some((rule) => rule.id === currentTaskProfileRuleId)) {
    currentTaskProfileRuleId = regexRules[0]?.id || "";
  }

  return {
    settings,
    taskProfiles,
    taskTypeOptions,
    taskType: currentTaskProfileTaskType,
    taskTabId: currentTaskProfileTabId,
    bucket,
    profile,
    blocks,
    selectedBlock:
      blocks.find((block) => block.id === currentTaskProfileBlockId) || null,
    regexRules,
    selectedRule:
      regexRules.find((rule) => rule.id === currentTaskProfileRuleId) || null,
    builtinBlockDefinitions: getBuiltinBlockDefinitions(),
  };
}

function _refreshTaskProfileWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-task-profile-workspace");
  if (!workspace) return;

  const state = _getTaskProfileWorkspaceState(settings);
  workspace.innerHTML = _renderTaskProfileWorkspace(state);
}

function _patchTaskProfiles(taskProfiles, extraPatch = {}, options = {}) {
  return _patchSettings(
    {
      taskProfilesVersion: 1,
      taskProfiles,
      ...extraPatch,
    },
    {
      refreshTaskWorkspace: options.refresh !== false,
    },
  );
}

async function _handleTaskProfileWorkspaceClick(event) {
  const actionEl = event.target.closest("[data-task-action]");
  if (!actionEl) return;

  const action = actionEl.dataset.taskAction || "";
  const state = _getTaskProfileWorkspaceState();
  const selectedProfile = state.profile;
  if (!selectedProfile && action !== "switch-task-type") return;

  switch (action) {
    case "switch-task-type":
      currentTaskProfileTaskType =
        actionEl.dataset.taskType || currentTaskProfileTaskType;
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _refreshTaskProfileWorkspace();
      return;
    case "switch-task-tab":
      currentTaskProfileTabId =
        actionEl.dataset.taskTab || currentTaskProfileTabId;
      _refreshTaskProfileWorkspace();
      return;
    case "select-block":
      currentTaskProfileBlockId = actionEl.dataset.blockId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "select-regex-rule":
      currentTaskProfileRuleId = actionEl.dataset.ruleId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "add-custom-block":
      _updateCurrentTaskProfile((draft, context) => {
        const nextBlock = createCustomPromptBlock(context.taskType, {
          name: `自定义块 ${draft.blocks.length + 1}`,
          order: draft.blocks.length,
        });
        draft.blocks.push(nextBlock);
        return { selectBlockId: nextBlock.id };
      });
      return;
    case "add-builtin-block": {
      const select = document.getElementById("bme-task-builtin-select");
      const sourceKey = String(select?.value || "").trim();
      if (!sourceKey) {
        toastr.info("先选择一个内置块来源", "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft, context) => {
        const nextBlock = createBuiltinPromptBlock(context.taskType, sourceKey, {
          order: draft.blocks.length,
        });
        draft.blocks.push(nextBlock);
        return { selectBlockId: nextBlock.id };
      });
      return;
    }
    case "move-block-up":
      _moveTaskBlock(actionEl.dataset.blockId, -1);
      return;
    case "move-block-down":
      _moveTaskBlock(actionEl.dataset.blockId, 1);
      return;
    case "toggle-block-enabled":
      _updateCurrentTaskProfile((draft) => {
        const blocks = _sortTaskBlocks(draft.blocks);
        const block = blocks.find((item) => item.id === actionEl.dataset.blockId);
        if (!block) return null;
        block.enabled = block.enabled === false;
        draft.blocks = _normalizeTaskBlocks(blocks);
        return { selectBlockId: block.id };
      });
      return;
    case "delete-block":
      _deleteTaskBlock(actionEl.dataset.blockId);
      return;
    case "save-profile":
      _patchTaskProfiles(state.taskProfiles, {}, { refresh: true });
      toastr.success("当前预设已保存", "ST-BME");
      return;
    case "rename-profile": {
      const nameInput = document.getElementById("bme-task-profile-name");
      const nextName = String(nameInput?.value || "").trim();
      if (!nextName) {
        toastr.info("预设名称不能为空", "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft) => {
        draft.name = nextName;
      });
      toastr.success("预设名称已更新", "ST-BME");
      return;
    }
    case "save-as-profile": {
      const suggestedName = `${selectedProfile.name || "预设"} 副本`;
      const nextName = window.prompt("请输入新预设名称", suggestedName);
      if (nextName == null) return;
      const trimmedName = String(nextName).trim();
      if (!trimmedName) {
        toastr.info("预设名称不能为空", "ST-BME");
        return;
      }
      const nextProfile = cloneTaskProfile(selectedProfile, {
        taskType: currentTaskProfileTaskType,
        name: trimmedName,
      });
      currentTaskProfileBlockId = nextProfile.blocks?.[0]?.id || "";
      currentTaskProfileRuleId = nextProfile.regex?.localRules?.[0]?.id || "";
      const nextTaskProfiles = upsertTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
        nextProfile,
        { setActive: true },
      );
      _patchTaskProfiles(nextTaskProfiles);
      toastr.success("已另存为新预设", "ST-BME");
      return;
    }
    case "export-profile":
      _downloadTaskProfile(state.taskProfiles, currentTaskProfileTaskType, selectedProfile);
      return;
    case "import-profile":
      document.getElementById("bme-task-profile-import")?.click();
      return;
    case "restore-default-profile": {
      const confirmed = window.confirm(
        "这会重建当前任务的默认预设，并切换到默认预设。是否继续？",
      );
      if (!confirmed) return;
      const nextTaskProfiles = restoreDefaultTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
      );
      const legacyField = getLegacyPromptFieldForTask(currentTaskProfileTaskType);
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _patchTaskProfiles(
        nextTaskProfiles,
        legacyField ? { [legacyField]: "" } : {},
      );
      toastr.success("默认预设已恢复", "ST-BME");
      return;
    }
    case "add-regex-rule":
      _updateCurrentTaskProfile((draft, context) => {
        const localRules = Array.isArray(draft.regex?.localRules)
          ? draft.regex.localRules
          : [];
        const nextRule = createLocalRegexRule(context.taskType, {
          script_name: `本地规则 ${localRules.length + 1}`,
        });
        draft.regex = {
          ...(draft.regex || {}),
          localRules: [...localRules, nextRule],
        };
        return { selectRuleId: nextRule.id };
      });
      return;
    case "delete-regex-rule":
      _deleteRegexRule(actionEl.dataset.ruleId);
      return;
    default:
      return;
  }
}

function _renderTaskProfileWorkspace(state) {
  if (!state.profile) {
    return `
      <div class="bme-config-card">
        <div class="bme-config-card-title">任务预设不可用</div>
        <div class="bme-config-help">当前没有可编辑的任务预设数据。</div>
      </div>
    `;
  }

  const taskMeta =
    state.taskTypeOptions.find((item) => item.id === state.taskType) ||
    state.taskTypeOptions[0];
  const profileUpdatedAt = _formatTaskProfileTime(state.profile.updatedAt);

  return `
    <div class="bme-task-shell">
      <div class="bme-task-header">
        <div class="bme-task-type-tabs">
          ${state.taskTypeOptions
            .map(
              (item) => `
                <button
                  class="bme-task-type-btn ${item.id === state.taskType ? "active" : ""}"
                  data-task-action="switch-task-type"
                  data-task-type="${_escHtml(item.id)}"
                  type="button"
                >
                  <span>${_escHtml(item.label)}</span>
                </button>
              `,
            )
            .join("")}
        </div>

        <div class="bme-config-card bme-task-header-card">
          <div class="bme-config-card-head">
            <div>
              <div class="bme-config-card-title">
                ${_escHtml(taskMeta?.label || state.taskType)} 任务预设
              </div>
              <div class="bme-config-card-subtitle">
                ${_escHtml(taskMeta?.description || "")}
              </div>
            </div>
            <div class="bme-task-profile-badges">
              <span class="bme-task-pill ${state.profile.builtin ? "is-builtin" : ""}">
                ${state.profile.builtin ? "内置" : "自定义"}
              </span>
              <span class="bme-task-pill">更新于 ${_escHtml(profileUpdatedAt)}</span>
            </div>
          </div>

          <div class="bme-task-header-fields">
            <div class="bme-config-row">
              <label for="bme-task-profile-select">当前预设</label>
              <select id="bme-task-profile-select" class="bme-config-input">
                ${state.bucket.profiles
                  .map(
                    (profile) => `
                      <option
                        value="${_escHtml(profile.id)}"
                        ${profile.id === state.profile.id ? "selected" : ""}
                      >
                        ${_escHtml(profile.name)}${profile.builtin ? " · 内置" : ""}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </div>
            <div class="bme-config-row">
              <label for="bme-task-profile-name">预设名称</label>
              <input
                id="bme-task-profile-name"
                class="bme-config-input"
                type="text"
                value="${_escHtml(state.profile.name || "")}"
                placeholder="输入预设名称"
              />
            </div>
          </div>

          <div class="bme-task-header-actions">
            <button class="bme-config-secondary-btn" data-task-action="save-profile" type="button">保存</button>
            <button class="bme-config-secondary-btn" data-task-action="rename-profile" type="button">重命名</button>
            <button class="bme-config-secondary-btn" data-task-action="save-as-profile" type="button">另存为</button>
            <span class="bme-task-action-sep"></span>
            <button class="bme-config-secondary-btn" data-task-action="import-profile" type="button">导入</button>
            <button class="bme-config-secondary-btn" data-task-action="export-profile" type="button">导出</button>
            <span class="bme-task-action-sep"></span>
            <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-default-profile" type="button">恢复默认</button>
          </div>
        </div>
      </div>

      <div class="bme-task-subtabs">
        ${TASK_PROFILE_TABS.map(
          (tab) => `
            <button
              class="bme-task-subtab-btn ${tab.id === state.taskTabId ? "active" : ""}"
              data-task-action="switch-task-tab"
              data-task-tab="${_escHtml(tab.id)}"
              type="button"
            >
              ${_escHtml(tab.label)}
            </button>
          `,
        ).join("")}
      </div>

      <div class="bme-task-tab-body">
        ${
          state.taskTabId === "generation"
            ? _renderTaskGenerationTab(state)
            : state.taskTabId === "regex"
              ? _renderTaskRegexTab(state)
              : _renderTaskPromptTab(state)
        }
      </div>
    </div>
  `;
}

function _renderTaskPromptTab(state) {
  return `
    <div class="bme-task-editor-grid">
      <div class="bme-config-card">
        <div class="bme-config-card-head">
          <div>
            <div class="bme-config-card-title">Prompt 块列表</div>
            <div class="bme-config-card-subtitle">
              通过顺序、启停与角色控制最终请求的编排方式。
            </div>
          </div>
        </div>

        <div class="bme-task-toolbar-row">
          <div class="bme-task-toolbar-inline">
            <button class="bme-config-secondary-btn" data-task-action="add-custom-block" type="button">
              + 自定义块
            </button>
            <span class="bme-task-action-sep"></span>
            <select id="bme-task-builtin-select" class="bme-config-input bme-task-builtin-select">
              ${state.builtinBlockDefinitions
                .map(
                  (item) => `
                    <option value="${_escHtml(item.sourceKey)}">
                      ${_escHtml(item.name)}
                    </option>
                  `,
                )
                .join("")}
            </select>
            <button class="bme-config-secondary-btn" data-task-action="add-builtin-block" type="button">
              + 内置块
            </button>
          </div>
          <span class="bme-task-block-count">${state.blocks.length} 个块</span>
        </div>

        <div class="bme-task-list">
          ${state.blocks.length
            ? state.blocks
                .map((block, index) => _renderTaskBlockListItem(block, index, state))
                .join("")
            : `
                <div class="bme-task-empty">
                  当前预设还没有块。可以先新增一个自定义块或内置块。
                </div>
              `}
        </div>
      </div>

      <div class="bme-config-card">
        ${_renderTaskBlockEditor(state)}
      </div>
    </div>
  `;
}

function _renderTaskGenerationTab(state) {
  return `
    <div class="bme-task-tab-body">
      ${TASK_PROFILE_GENERATION_GROUPS.map(
        (group) => `
          <div class="bme-config-card">
            <div class="bme-config-card-head">
              <div>
                <div class="bme-config-card-title">${_escHtml(group.title)}</div>
                <div class="bme-config-card-subtitle">
                  留空表示不强制下发，由模型或 provider 默认值决定。
                </div>
              </div>
            </div>
            <div class="bme-task-field-grid">
              ${group.fields
                .map((field) =>
                  _renderGenerationField(field, state.profile.generation?.[field.key]),
                )
                .join("")}
            </div>
          </div>
        `,
      ).join("")}
      <div class="bme-task-note">
        <strong>运行时说明</strong> — 这里配置的是完整版 generation options。实际请求发送前，仍会根据模型能力做过滤，避免把不支持的字段直接下发给 provider。
      </div>
    </div>
  `;
}

function _renderTaskRegexTab(state) {
  const regex = state.profile.regex || {};
  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-regex-top">
      <div class="bme-config-card">
        <div class="bme-config-card-head">
          <div>
            <div class="bme-config-card-title">复用与阶段</div>
            <div class="bme-config-card-subtitle">
              任务预设可复用酒馆正则，并叠加当前任务自己的附加规则。
            </div>
          </div>
        </div>

        <div class="bme-task-toggle-list">
          <label class="bme-toggle-item">
            <span class="bme-toggle-copy">
              <span class="bme-toggle-title">启用任务正则</span>
              <span class="bme-toggle-desc">关闭后当前预设不执行任何任务级正则。</span>
            </span>
            <input
              type="checkbox"
              data-regex-field="enabled"
              ${regex.enabled ? "checked" : ""}
            />
          </label>

          <label class="bme-toggle-item">
            <span class="bme-toggle-copy">
              <span class="bme-toggle-title">复用酒馆正则</span>
              <span class="bme-toggle-desc">读取 global / preset / character 正则来源。</span>
            </span>
            <input
              type="checkbox"
              data-regex-field="inheritStRegex"
              ${regex.inheritStRegex !== false ? "checked" : ""}
            />
          </label>
        </div>

        <div class="bme-task-section-label">复用来源</div>
        <div class="bme-task-toggle-list">
          ${[
            ["global", "全局"],
            ["preset", "当前预设"],
            ["character", "角色卡"],
          ]
            .map(
              ([key, label]) => `
                <label class="bme-toggle-item">
                  <span class="bme-toggle-copy">
                    <span class="bme-toggle-title">${label}</span>
                    <span class="bme-toggle-desc">启用 ${label} 来源的 Tavern 正则。</span>
                  </span>
                  <input
                    type="checkbox"
                    data-regex-source="${key}"
                    ${(regex.sources?.[key] ?? true) ? "checked" : ""}
                  />
                </label>
              `,
            )
            .join("")}
        </div>

        <div class="bme-task-section-label">输入阶段</div>
        <div class="bme-task-toggle-list">
          ${TASK_PROFILE_REGEX_STAGES.filter((s) => !s.key.startsWith("output.") && s.key !== "rawResponse" && s.key !== "beforeParse").map(
            (stage) => `
              <label class="bme-toggle-item">
                <span class="bme-toggle-copy">
                  <span class="bme-toggle-title">${_escHtml(stage.label)}</span>
                  <span class="bme-toggle-desc">${_escHtml(stage.desc)}</span>
                </span>
                <input
                  type="checkbox"
                  data-regex-stage="${_escHtml(stage.key)}"
                  ${(regex.stages?.[stage.key] ?? false) ? "checked" : ""}
                />
              </label>
            `,
          ).join("")}
        </div>

        <div class="bme-task-section-label">输出阶段</div>
        <div class="bme-task-toggle-list">
          ${TASK_PROFILE_REGEX_STAGES.filter((s) => s.key.startsWith("output.") || s.key === "rawResponse" || s.key === "beforeParse").map(
            (stage) => `
              <label class="bme-toggle-item">
                <span class="bme-toggle-copy">
                  <span class="bme-toggle-title">${_escHtml(stage.label)}</span>
                  <span class="bme-toggle-desc">${_escHtml(stage.desc)}</span>
                </span>
                <input
                  type="checkbox"
                  data-regex-stage="${_escHtml(stage.key)}"
                  ${(regex.stages?.[stage.key] ?? false) ? "checked" : ""}
                />
              </label>
            `,
          ).join("")}
        </div>
      </div>

      <div class="bme-config-card">
        <div class="bme-config-card-head">
          <div>
            <div class="bme-config-card-title">本地附加规则</div>
            <div class="bme-config-card-subtitle">
              本地规则只作用于当前任务预设，不会污染宿主酒馆配置。
            </div>
          </div>
          <button class="bme-config-secondary-btn" data-task-action="add-regex-rule" type="button">
            + 新增规则
          </button>
        </div>

        <div class="bme-task-list">
          ${state.regexRules.length
            ? state.regexRules
                .map((rule, index) => _renderRegexRuleListItem(rule, index, state))
                .join("")
            : `
                <div class="bme-task-empty">
                  当前预设还没有本地正则规则。
                </div>
              `}
        </div>
      </div>
      </div>

      <div class="bme-config-card">
        ${_renderRegexRuleEditor(state)}
      </div>
    </div>
  `;
}

function _renderTaskBlockListItem(block, index, state) {
  const isSelected = block.id === state.selectedBlock?.id;
  return `
    <div class="bme-task-list-entry">
      <button
        class="bme-task-list-item ${isSelected ? "active" : ""}"
        data-task-action="select-block"
        data-block-id="${_escHtml(block.id)}"
        type="button"
      >
        <span class="bme-task-list-index">#${index + 1}</span>
        <span class="bme-task-list-copy">
          <span class="bme-task-list-title">
            ${_escHtml(block.name || _getTaskBlockTypeLabel(block.type))}
          </span>
          <span class="bme-task-list-meta">
            ${_escHtml(_getTaskBlockTypeLabel(block.type))} · ${_escHtml(block.role || "system")} · ${block.enabled ? "启用" : "停用"}
          </span>
        </span>
      </button>
      <div class="bme-task-inline-actions">
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="move-block-up"
          data-block-id="${_escHtml(block.id)}"
          type="button"
        >
          上移
        </button>
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="move-block-down"
          data-block-id="${_escHtml(block.id)}"
          type="button"
        >
          下移
        </button>
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="toggle-block-enabled"
          data-block-id="${_escHtml(block.id)}"
          type="button"
        >
          ${block.enabled ? "停用" : "启用"}
        </button>
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="delete-block"
          data-block-id="${_escHtml(block.id)}"
          type="button"
          ${block.type === "custom" ? "" : "disabled"}
        >
          删除
        </button>
      </div>
    </div>
  `;
}

function _renderTaskBlockEditor(state) {
  const block = state.selectedBlock;
  if (!block) {
    return `
      <div class="bme-config-card-title">块详情</div>
      <div class="bme-config-help">从左侧列表选择一个块进行编辑。</div>
    `;
  }

  const builtinOptions = state.builtinBlockDefinitions
    .map(
      (item) => `
        <option
          value="${_escHtml(item.sourceKey)}"
          ${item.sourceKey === block.sourceKey ? "selected" : ""}
        >
          ${_escHtml(item.name)} · ${_escHtml(item.sourceKey)}
        </option>
      `,
    )
    .join("");
  const legacyField = getLegacyPromptFieldForTask(state.taskType);
  const legacyValue =
    legacyField && block.type === "legacyPrompt"
      ? state.settings?.[legacyField] || block.content || ""
      : block.content || "";

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">块详情</div>
        <div class="bme-config-card-subtitle">
          当前块会直接写回到任务预设中。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_getTaskBlockTypeLabel(block.type))}</span>
    </div>

    <div class="bme-config-row">
      <label>块名称</label>
      <input
        class="bme-config-input"
        type="text"
        data-block-field="name"
        value="${_escHtml(block.name || "")}"
        placeholder="用于工作区显示"
      />
    </div>

    <div class="bme-task-field-grid">
      <div class="bme-config-row">
        <label>角色</label>
        <select class="bme-config-input" data-block-field="role">
          ${TASK_PROFILE_ROLE_OPTIONS.map(
            (item) => `
              <option value="${item.value}" ${item.value === block.role ? "selected" : ""}>
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
      <div class="bme-config-row">
        <label>注入方式</label>
        <select class="bme-config-input" data-block-field="injectionMode">
          ${TASK_PROFILE_INJECTION_OPTIONS.map(
            (item) => `
              <option
                value="${item.value}"
                ${item.value === (block.injectionMode || "append") ? "selected" : ""}
              >
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
    </div>

    <label class="bme-toggle-item bme-task-editor-toggle">
      <span class="bme-toggle-copy">
        <span class="bme-toggle-title">启用此块</span>
        <span class="bme-toggle-desc">停用后会从最终 prompt 编排中跳过。</span>
      </span>
      <input
        type="checkbox"
        data-block-field="enabled"
        ${block.enabled ? "checked" : ""}
      />
    </label>

    ${
      block.type === "builtin"
        ? `
            <div class="bme-config-row">
              <label>内置来源</label>
              <select class="bme-config-input" data-block-field="sourceKey">
                ${builtinOptions}
              </select>
            </div>
            <div class="bme-config-row">
              <label>覆盖内容（可选）</label>
              <textarea
                class="bme-config-textarea"
                data-block-field="content"
                placeholder="留空时从 sourceKey 对应的任务上下文读取。"
              >${_escHtml(block.content || "")}</textarea>
            </div>
          `
        : block.type === "legacyPrompt"
          ? `
              <div class="bme-task-note">
                当前块与旧版 prompt 字段保持兼容。留空时运行时会回退到内置默认 prompt。
              </div>
              <div class="bme-config-row">
                <label>兼容字段</label>
                <input
                  class="bme-config-input"
                  type="text"
                  value="${_escHtml(legacyField || block.sourceField || "")}"
                  readonly
                />
              </div>
              <div class="bme-config-row">
                <label>兼容 prompt 内容</label>
                <textarea
                  class="bme-config-textarea"
                  data-block-field="content"
                  placeholder="留空 = 继续使用内置默认 prompt"
                >${_escHtml(legacyValue)}</textarea>
              </div>
            `
          : `
              <div class="bme-config-row">
                <label>块内容</label>
                <textarea
                  class="bme-config-textarea"
                  data-block-field="content"
                  placeholder="支持 {{userMessage}} / {{recentMessages}} / {{schema}} 等轻量变量。"
                >${_escHtml(block.content || "")}</textarea>
              </div>
            `
    }
  `;
}

function _renderGenerationField(field, value) {
  if (field.type === "tri_bool") {
    const currentValue =
      value === true ? "true" : value === false ? "false" : "";
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escHtml(field.key)}"
          data-value-type="tri_bool"
        >
          ${TASK_PROFILE_BOOLEAN_OPTIONS.map(
            (item) => `
              <option value="${item.value}" ${item.value === currentValue ? "selected" : ""}>
                ${item.label}
              </option>
            `,
          ).join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "enum") {
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escHtml(field.key)}"
          data-value-type="text"
        >
          ${(field.options || [])
            .map(
              (item) => `
                <option value="${_escHtml(item.value)}" ${item.value === String(value ?? "") ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
      </div>
    `;
  }

  return `
    <div class="bme-config-row">
      <label>${_escHtml(field.label)}</label>
      <input
        class="bme-config-input"
        type="${field.type === "text" ? "text" : "number"}"
        ${field.step ? `step="${field.step}"` : ""}
        value="${_escHtml(value ?? "")}"
        placeholder="留空 = 跟随默认"
        data-generation-key="${_escHtml(field.key)}"
        data-value-type="${field.type === "text" ? "text" : "number"}"
      />
    </div>
  `;
}

function _renderRegexRuleListItem(rule, index, state) {
  const isSelected = rule.id === state.selectedRule?.id;
  return `
    <div class="bme-task-list-entry">
      <button
        class="bme-task-list-item ${isSelected ? "active" : ""}"
        data-task-action="select-regex-rule"
        data-rule-id="${_escHtml(rule.id)}"
        type="button"
      >
        <span class="bme-task-list-index">#${index + 1}</span>
        <span class="bme-task-list-copy">
          <span class="bme-task-list-title">${_escHtml(rule.script_name || `本地规则 ${index + 1}`)}</span>
          <span class="bme-task-list-meta">
            ${rule.enabled ? "启用" : "停用"} · ${_escHtml(rule.find_regex || "(未填写 find_regex)")}
          </span>
        </span>
      </button>
      <div class="bme-task-inline-actions">
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="delete-regex-rule"
          data-rule-id="${_escHtml(rule.id)}"
          type="button"
        >
          删除
        </button>
      </div>
    </div>
  `;
}

function _renderRegexRuleEditor(state) {
  const rule = state.selectedRule;
  if (!rule) {
    return `
      <div class="bme-config-card-title">规则详情</div>
      <div class="bme-config-help">从左侧规则列表选择一条规则进行编辑。</div>
    `;
  }

  const trimStrings = Array.isArray(rule.trim_strings)
    ? rule.trim_strings.join("\n")
    : String(rule.trim_strings || "");

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">规则详情</div>
        <div class="bme-config-card-subtitle">
          字段尽量与 Tavern 正则结构保持对齐，方便后续导入导出与对照。
        </div>
      </div>
      <span class="bme-task-pill">${rule.enabled ? "启用中" : "已停用"}</span>
    </div>

    <div class="bme-config-row">
      <label>script_name</label>
      <input
        class="bme-config-input"
        type="text"
        data-regex-rule-field="script_name"
        value="${_escHtml(rule.script_name || "")}"
      />
    </div>

    <label class="bme-toggle-item bme-task-editor-toggle">
      <span class="bme-toggle-copy">
        <span class="bme-toggle-title">启用此规则</span>
        <span class="bme-toggle-desc">停用后该规则不再参与当前任务预设处理。</span>
      </span>
      <input
        type="checkbox"
        data-regex-rule-field="enabled"
        ${rule.enabled ? "checked" : ""}
      />
    </label>

    <div class="bme-config-row">
      <label>find_regex</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="find_regex"
        placeholder="/pattern/g"
      >${_escHtml(rule.find_regex || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>replace_string</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="replace_string"
        placeholder="替换后的文本"
      >${_escHtml(rule.replace_string || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>trim_strings</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="trim_strings"
        placeholder="每行一个要裁掉的字符串"
      >${_escHtml(trimStrings)}</textarea>
    </div>

    <div class="bme-task-field-grid">
      <div class="bme-config-row">
        <label>min_depth</label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="min_depth"
          value="${_escHtml(rule.min_depth ?? 0)}"
        />
      </div>
      <div class="bme-config-row">
        <label>max_depth</label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="max_depth"
          value="${_escHtml(rule.max_depth ?? 9999)}"
        />
      </div>
    </div>

    <div class="bme-task-section-label">source</div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">user_input</span>
          <span class="bme-toggle-desc">允许作用于 user / 输入侧文本。</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="user_input"
          ${(rule.source?.user_input ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">ai_output</span>
          <span class="bme-toggle-desc">允许作用于 assistant / 输出侧文本。</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="ai_output"
          ${(rule.source?.ai_output ?? true) ? "checked" : ""}
        />
      </label>
    </div>

    <div class="bme-task-section-label">destination</div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">prompt</span>
          <span class="bme-toggle-desc">应用到 prompt / 输入构建链路。</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="prompt"
          ${(rule.destination?.prompt ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">display</span>
          <span class="bme-toggle-desc">应用到展示层替换链路。</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="display"
          ${rule.destination?.display ? "checked" : ""}
        />
      </label>
    </div>
  `;
}

function _moveTaskBlock(blockId, direction) {
  if (!blockId || !Number.isFinite(direction) || direction === 0) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const index = blocks.findIndex((item) => item.id === blockId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= blocks.length) {
      return null;
    }
    [blocks[index], blocks[targetIndex]] = [blocks[targetIndex], blocks[index]];
    draft.blocks = _normalizeTaskBlocks(blocks);
    return { selectBlockId: blockId };
  });
}

function _deleteTaskBlock(blockId) {
  if (!blockId) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const index = blocks.findIndex((item) => item.id === blockId);
    if (index < 0) return null;
    const block = blocks[index];
    if (block.type !== "custom") {
      toastr.info("只有自定义块可以删除", "ST-BME");
      return null;
    }
    blocks.splice(index, 1);
    draft.blocks = _normalizeTaskBlocks(blocks);
    return {
      selectBlockId: blocks[Math.max(0, index - 1)]?.id || blocks[0]?.id || "",
    };
  });
}

function _deleteRegexRule(ruleId) {
  if (!ruleId) return;
  _updateCurrentTaskProfile((draft) => {
    const localRules = Array.isArray(draft.regex?.localRules)
      ? [...draft.regex.localRules]
      : [];
    const index = localRules.findIndex((item) => item.id === ruleId);
    if (index < 0) return null;
    localRules.splice(index, 1);
    draft.regex = {
      ...(draft.regex || {}),
      localRules,
    };
    return {
      selectRuleId:
        localRules[Math.max(0, index - 1)]?.id || localRules[0]?.id || "",
    };
  });
}

function _persistSelectedBlockField(target, refresh) {
  const field = target.dataset.blockField;
  if (!field) return;

  _updateCurrentTaskProfile(
    (draft, context) => {
      const blocks = _sortTaskBlocks(draft.blocks);
      const block = blocks.find((item) => item.id === currentTaskProfileBlockId);
      if (!block) return null;

      const rawValue =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : target.value;

      let extraSettingsPatch = {};
      if (field === "enabled") {
        block.enabled = Boolean(rawValue);
      } else if (field === "content" && block.type === "legacyPrompt") {
        block.content = String(rawValue || "");
        const legacyField = getLegacyPromptFieldForTask(context.taskType);
        if (legacyField) {
          extraSettingsPatch[legacyField] = block.content;
        }
      } else {
        block[field] = String(rawValue || "");
      }

      draft.blocks = _normalizeTaskBlocks(blocks);
      return {
        extraSettingsPatch,
        selectBlockId: block.id,
      };
    },
    { refresh },
  );
}

function _persistGenerationField(target, refresh) {
  const key = target.dataset.generationKey;
  const valueType = target.dataset.valueType || "text";
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.generation = {
        ...(draft.generation || {}),
        [key]: _parseTaskWorkspaceValue(target, valueType),
      };
    },
    { refresh },
  );
}

function _persistRegexConfigField(target, refresh) {
  const key = target.dataset.regexField;
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        [key]:
          target instanceof HTMLInputElement && target.type === "checkbox"
            ? Boolean(target.checked)
            : target.value,
      };
    },
    { refresh },
  );
}

function _persistRegexSourceField(target, refresh) {
  const sourceKey = target.dataset.regexSource;
  if (!sourceKey) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        sources: {
          ...(draft.regex?.sources || {}),
          [sourceKey]: Boolean(target.checked),
        },
      };
    },
    { refresh },
  );
}

function _persistRegexStageField(target, refresh) {
  const stageKey = target.dataset.regexStage;
  if (!stageKey) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.regex = {
        ...(draft.regex || {}),
        stages: {
          ...(draft.regex?.stages || {}),
          [stageKey]: Boolean(target.checked),
        },
      };
    },
    { refresh },
  );
}

function _persistSelectedRegexRuleField(target, refresh) {
  _updateCurrentTaskProfile(
    (draft) => {
      const localRules = Array.isArray(draft.regex?.localRules)
        ? [...draft.regex.localRules]
        : [];
      const rule = localRules.find((item) => item.id === currentTaskProfileRuleId);
      if (!rule) return null;

      if (target.dataset.regexRuleField) {
        const field = target.dataset.regexRuleField;
        if (target instanceof HTMLInputElement && target.type === "checkbox") {
          rule[field] = Boolean(target.checked);
        } else if (["min_depth", "max_depth"].includes(field)) {
          const parsed = Number.parseInt(String(target.value || "").trim(), 10);
          rule[field] = Number.isFinite(parsed) ? parsed : 0;
        } else if (field === "trim_strings") {
          rule[field] = String(target.value || "");
        } else {
          rule[field] = String(target.value || "");
        }
      }

      if (target.dataset.regexRuleSource) {
        const sourceKey = target.dataset.regexRuleSource;
        rule.source = {
          ...(rule.source || {}),
          [sourceKey]: Boolean(target.checked),
        };
      }

      if (target.dataset.regexRuleDestination) {
        const destinationKey = target.dataset.regexRuleDestination;
        rule.destination = {
          ...(rule.destination || {}),
          [destinationKey]: Boolean(target.checked),
        };
      }

      draft.regex = {
        ...(draft.regex || {}),
        localRules,
      };
      return { selectRuleId: rule.id };
    },
    { refresh },
  );
}

function _updateCurrentTaskProfile(mutator, options = {}) {
  const settings = _getSettings?.() || {};
  const taskProfiles = ensureTaskProfiles(settings);
  const taskType = currentTaskProfileTaskType;
  const bucket = taskProfiles[taskType];
  const activeProfile =
    bucket?.profiles?.find((item) => item.id === bucket.activeProfileId) ||
    bucket?.profiles?.[0];

  if (!activeProfile) return null;

  const draft = _normalizeTaskProfileDraft(_cloneJson(activeProfile));
  const mutationResult = mutator?.(draft, {
      settings,
      taskProfiles,
      taskType,
      bucket,
      activeProfile,
    });

  if (mutationResult === null) return null;

  const result = mutationResult || {};

  const nextProfile = _normalizeTaskProfileDraft(result.profile || draft);
  const nextTaskProfiles = upsertTaskProfile(taskProfiles, taskType, nextProfile, {
    setActive: true,
  });

  if (Object.prototype.hasOwnProperty.call(result, "selectBlockId")) {
    currentTaskProfileBlockId = result.selectBlockId || "";
  }
  if (Object.prototype.hasOwnProperty.call(result, "selectRuleId")) {
    currentTaskProfileRuleId = result.selectRuleId || "";
  }

  return _patchTaskProfiles(
    nextTaskProfiles,
    result.extraSettingsPatch || {},
    {
      refresh: result.refresh === undefined ? options.refresh !== false : result.refresh,
    },
  );
}

function _normalizeTaskProfileDraft(profile = {}) {
  const draft = profile || {};
  draft.blocks = _normalizeTaskBlocks(draft.blocks);
  draft.regex = {
    enabled: false,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      finalPrompt: true,
      "input.userMessage": false,
      "input.recentMessages": false,
      "input.candidateText": false,
      "input.finalPrompt": false,
      rawResponse: false,
      beforeParse: false,
      "output.rawResponse": false,
      "output.beforeParse": false,
    },
    localRules: [],
    ...(draft.regex || {}),
    sources: {
      global: true,
      preset: true,
      character: true,
      ...(draft.regex?.sources || {}),
    },
    stages: {
      finalPrompt: true,
      "input.userMessage": false,
      "input.recentMessages": false,
      "input.candidateText": false,
      "input.finalPrompt": false,
      rawResponse: false,
      beforeParse: false,
      "output.rawResponse": false,
      "output.beforeParse": false,
      ...(draft.regex?.stages || {}),
    },
    localRules: Array.isArray(draft.regex?.localRules)
      ? draft.regex.localRules.map((rule) => ({
          ...rule,
          source: {
            user_input: true,
            ai_output: true,
            ...(rule?.source || {}),
          },
          destination: {
            prompt: true,
            display: false,
            ...(rule?.destination || {}),
          },
        }))
      : [],
  };
  return draft;
}

function _normalizeTaskBlocks(blocks = []) {
  return _sortTaskBlocks(blocks).map((block, index) => ({
    ...block,
    order: index,
  }));
}

function _sortTaskBlocks(blocks = []) {
  return [...(Array.isArray(blocks) ? blocks : [])].sort((a, b) => {
    const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
    const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
    return orderA - orderB;
  });
}

function _parseTaskWorkspaceValue(target, valueType = "text") {
  if (valueType === "tri_bool") {
    if (target.value === "true") return true;
    if (target.value === "false") return false;
    return null;
  }

  if (valueType === "number") {
    const raw = String(target.value || "").trim();
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return String(target.value || "").trim();
}

function _downloadTaskProfile(taskProfiles, taskType, profile) {
  try {
    const payload = serializeTaskProfile(taskProfiles, taskType, profile?.id || "");
    const fileName = _sanitizeFileName(
      `st-bme-${taskType}-${profile?.name || "profile"}.json`,
    );
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastr.success("预设导出成功", "ST-BME");
  } catch (error) {
    console.error("[ST-BME] 导出任务预设失败:", error);
    toastr.error(`预设导出失败: ${error?.message || error}`, "ST-BME");
  }
}

function _sanitizeFileName(fileName = "profile.json") {
  return String(fileName || "profile.json").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
}

function _cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function _getTaskBlockTypeLabel(type) {
  const typeMap = {
    custom: "自定义块",
    builtin: "内置块",
    legacyPrompt: "兼容块",
  };
  return typeMap[type] || type || "块";
}

function _formatTaskProfileTime(raw) {
  if (!raw) return "刚刚";
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "刚刚";
    return date.toLocaleString("zh-CN", {
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "刚刚";
  }
}

// ==================== 工具函数 ====================

function _setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function _refreshRuntimeStatus() {
  const runtimeStatus = _getRuntimeStatus?.() || {};
  const text = runtimeStatus.text || "待命";
  const meta = runtimeStatus.meta || "准备就绪";
  _setText("bme-status-text", text);
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", text);
}

function _patchSettings(patch = {}, options = {}) {
  const settings = _updateSettings?.(patch) || _getSettings?.() || {};
  if (options.refreshGuards) _refreshGuardedConfigStates(settings);
  if (options.refreshPrompts) _refreshPromptCardStates(settings);
  if (options.refreshTaskWorkspace) _refreshTaskProfileWorkspace(settings);
  if (options.refreshTheme)
    _highlightThemeChoice(settings.panelTheme || "crimson");
  return settings;
}

function _highlightThemeChoice(themeName) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-theme-option").forEach((opt) => {
    opt.classList.toggle("active", opt.dataset.theme === themeName);
  });
  panelEl.querySelectorAll(".bme-theme-card").forEach((card) => {
    card.classList.toggle("active", card.dataset.theme === themeName);
  });
}

function _refreshGuardedConfigStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-guarded-card").forEach((card) => {
    const guardKeys = String(card.dataset.guardSettings || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const enabled = guardKeys.every((key) => Boolean(settings[key]));
    card.classList.toggle("is-disabled", !enabled);
    const note = card.querySelector(".bme-config-guard-note");
    note?.classList.toggle("visible", !enabled);
    card
      .querySelectorAll("input, select, textarea, button")
      .forEach((element) => {
        element.disabled = !enabled;
      });
  });
}

function _refreshStageCardStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-stage-card").forEach((card) => {
    const toggleId = card.dataset.stageToggleId;
    const toggle = toggleId ? document.getElementById(toggleId) : null;
    const cardDisabled = card.classList.contains("is-disabled");
    const stageEnabled =
      toggleId === "bme-setting-recall-llm"
        ? (settings.recallEnableLLM ?? true)
        : toggle
          ? Boolean(toggle.checked)
          : true;

    card.classList.toggle("stage-disabled", !cardDisabled && !stageEnabled);
    card.querySelectorAll(".bme-stage-param").forEach((section) => {
      section
        .querySelectorAll("input, select, textarea, button")
        .forEach((element) => {
          element.disabled = cardDisabled || !stageEnabled;
        });
    });
  });
}

function _refreshFetchedModelSelects(settings = _getSettings?.() || {}) {
  _renderFetchedModelOptions(
    "bme-select-llm-model",
    fetchedMemoryLLMModels,
    settings.llmModel || "",
  );
  _renderFetchedModelOptions(
    "bme-select-embed-backend-model",
    fetchedBackendEmbeddingModels,
    settings.embeddingBackendModel || "",
  );
  _renderFetchedModelOptions(
    "bme-select-embed-direct-model",
    fetchedDirectEmbeddingModels,
    settings.embeddingModel || "",
  );
}

function _renderFetchedModelOptions(selectId, models, currentValue = "") {
  const select = document.getElementById(selectId);
  if (!select) return;

  const normalized = Array.isArray(models) ? models : [];
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = normalized.length
    ? "从拉取结果中选择模型"
    : "暂无已拉取模型";
  select.appendChild(placeholder);

  normalized.forEach((model) => {
    const option = document.createElement("option");
    option.value = String(model?.id || "");
    option.textContent = String(model?.label || model?.id || "");
    select.appendChild(option);
  });

  if (
    currentValue &&
    normalized.some((model) => String(model?.id || "") === String(currentValue))
  ) {
    select.value = String(currentValue);
  } else {
    select.value = "";
  }

  select.style.display = normalized.length > 0 ? "" : "none";
}

function _refreshPromptCardStates(settings = _getSettings?.() || {}) {
  if (!panelEl) return;
  panelEl.querySelectorAll(".bme-prompt-card").forEach((card) => {
    const settingKey = card.dataset.settingKey;
    const statusEl = card.querySelector(".bme-prompt-status");
    const resetButton = card.querySelector(".bme-prompt-reset");
    const isCustom = Boolean(String(settings?.[settingKey] || "").trim());
    card.classList.toggle("is-custom", isCustom);
    if (statusEl) {
      statusEl.textContent = isCustom ? "已自定义" : "默认";
      statusEl.classList.toggle("is-custom", isCustom);
    }
    if (resetButton) {
      resetButton.disabled = !isCustom;
    }
  });
}

function _toggleEmbedFields(mode) {
  const backendEl = document.getElementById("bme-embed-backend-fields");
  const directEl = document.getElementById("bme-embed-direct-fields");
  if (backendEl) backendEl.style.display = mode === "backend" ? "" : "none";
  if (directEl) directEl.style.display = mode === "direct" ? "" : "none";
}

function _setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el && el.value !== String(value ?? "")) {
    el.value = String(value ?? "");
  }
}

function _setCheckboxValue(id, checked) {
  const el = document.getElementById(id);
  if (el) {
    el.checked = Boolean(checked);
  }
}

function _parseOptionalInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function _escHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function _typeLabel(type) {
  const map = {
    character: "角色",
    event: "事件",
    location: "地点",
    thread: "主线",
    rule: "规则",
    synopsis: "概要",
    reflection: "反思",
  };
  return map[type] || type || "—";
}

function _getNodeSnippet(node) {
  const fields = node.fields || {};
  if (fields.summary) return fields.summary;
  if (fields.state) return fields.state;
  if (fields.constraint) return fields.constraint;
  if (fields.insight) return fields.insight;
  if (fields.traits) return fields.traits;

  const entries = Object.entries(fields).filter(
    ([key]) => !["name", "title", "summary", "embedding"].includes(key),
  );
  if (entries.length > 0) {
    return entries
      .slice(0, 2)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
  }
  return "无补充字段";
}

function _isMobile() {
  return window.innerWidth <= 768;
}
