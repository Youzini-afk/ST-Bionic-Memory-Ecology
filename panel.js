// ST-BME: 操控面板交互逻辑

import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { getContext } from "../../../extensions.js";
import { renderTemplateAsync } from "../../../templates.js";
import { GraphRenderer } from "./graph-renderer.js";
import { getNodeDisplayName } from "./node-labels.js";
import {
  buildRegionLine,
  buildScopeBadgeText,
  normalizeMemoryScope,
} from "./memory-scope.js";
import {
  resolveActiveLlmPresetName,
  sanitizeLlmPresetSettings,
} from "./llm-preset-utils.js";
import {
  cloneTaskProfile,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createLocalRegexRule,
  DEFAULT_TASK_BLOCKS,
  ensureTaskProfiles,
  exportTaskProfile as serializeTaskProfile,
  getBuiltinBlockDefinitions,
  getLegacyPromptFieldForTask,
  getTaskTypeOptions,
  importTaskProfile as parseImportedTaskProfile,
  isTaskRegexStageEnabled,
  normalizeTaskRegexStages,
  restoreDefaultTaskProfile,
  setActiveTaskProfileId,
  upsertTaskProfile,
} from "./prompt-profiles.js";
import { getNodeColors } from "./themes.js";
import {
  getSuggestedBackendModel,
  getVectorIndexStats,
} from "./vector-index.js";

let defaultPromptCache = null;

function getDefaultPrompts() {
  if (defaultPromptCache) {
    return defaultPromptCache;
  }

  const prompts = {};
  for (const [key, block] of Object.entries(DEFAULT_TASK_BLOCKS || {})) {
    prompts[key] = [block?.role, block?.format, block?.rules]
      .filter(Boolean)
      .join("\n\n");
  }

  defaultPromptCache = prompts;
  return prompts;
}

function getDefaultPromptText(taskType = "") {
  return getDefaultPrompts()[taskType] || "";
}

const TASK_PROFILE_TABS = [
  { id: "generation", label: "生成参数" },
  { id: "prompt", label: "Prompt 编排" },
  { id: "regex", label: "正则" },
  { id: "debug", label: "调试预览" },
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

const GRAPH_WRITE_ACTION_IDS = [
  "bme-act-extract",
  "bme-act-compress",
  "bme-act-sleep",
  "bme-act-synopsis",
  "bme-act-evolve",
  "bme-act-undo-maintenance",
  "bme-act-import",
  "bme-act-rebuild",
  "bme-act-vector-rebuild",
  "bme-act-vector-range",
  "bme-act-vector-reembed",
  "bme-act-reroll",
  "bme-detail-delete",
  "bme-detail-save",
];

const TASK_PROFILE_GENERATION_GROUPS = [
  {
    title: "API 配置",
    fields: [
      {
        key: "llm_preset",
        label: "API 配置模板",
        type: "llm_preset",
        defaultValue: "",
        help: "留空表示跟随当前 API；选中已保存模板后，这个任务会独立使用那套 URL / Key / Model。",
      },
    ],
  },
  {
    title: "基础生成参数",
    fields: [
      { key: "max_context_tokens", label: "最大上下文 Tokens", type: "number", defaultValue: "" },
      { key: "max_completion_tokens", label: "最大补全 Tokens", type: "number", defaultValue: "" },
      { key: "reply_count", label: "回复次数", type: "number", defaultValue: 1 },
      { key: "stream", label: "流式输出", type: "tri_bool", defaultValue: false },
      { key: "temperature", label: "温度 (Temperature)", type: "range", min: 0, max: 2, step: 0.01, defaultValue: 1 },
      { key: "top_p", label: "Top P", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 1 },
      { key: "top_k", label: "Top K", type: "number", defaultValue: 0 },
      { key: "top_a", label: "Top A", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 0 },
      { key: "min_p", label: "Min P", type: "range", min: 0, max: 1, step: 0.01, defaultValue: 0 },
      { key: "seed", label: "随机种子 (Seed)", type: "number", defaultValue: "" },
    ],
  },
  {
    title: "惩罚参数",
    fields: [
      { key: "frequency_penalty", label: "频率惩罚", type: "range", min: -2, max: 2, step: 0.01, defaultValue: 0 },
      { key: "presence_penalty", label: "存在惩罚", type: "range", min: -2, max: 2, step: 0.01, defaultValue: 0 },
      { key: "repetition_penalty", label: "重复惩罚", type: "range", min: 0, max: 3, step: 0.01, defaultValue: 1 },
    ],
  },
  {
    title: "行为参数",
    fields: [
      { key: "squash_system_messages", label: "合并系统消息", type: "tri_bool", defaultValue: false },
      {
        key: "reasoning_effort",
        label: "推理强度",
        type: "enum",
        options: [
          { value: "", label: "跟随默认" },
          { value: "minimal", label: "最低" },
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
        ],
        defaultValue: "",
      },
      { key: "request_thoughts", label: "请求思考过程", type: "tri_bool", defaultValue: false },
      { key: "enable_function_calling", label: "函数调用", type: "tri_bool", defaultValue: false },
      { key: "enable_web_search", label: "网页搜索", type: "tri_bool", defaultValue: false },
      { key: "character_name_prefix", label: "角色名前缀", type: "text", defaultValue: "" },
      { key: "wrap_user_messages_in_quotes", label: "用户消息加引号", type: "tri_bool", defaultValue: false },
    ],
  },
];

const TASK_PROFILE_REGEX_STAGES = [
  {
    key: "input",
    label: "输入总开关",
    desc: "控制全部输入阶段；未单独覆写的细分阶段会跟随它。",
  },
  {
    key: "input.userMessage",
    label: "输入: 用户消息",
    desc: "处理当前 userMessage。",
  },
  {
    key: "input.recentMessages",
    label: "输入: 最近上下文",
    desc: "处理 recentMessages、chatMessages、dialogueText。",
  },
  {
    key: "input.candidateText",
    label: "输入: 候选与摘要",
    desc: "处理 candidateText、candidateNodes、nodeContent 和各类摘要。",
  },
  {
    key: "input.finalPrompt",
    label: "输入: 发送前最终消息",
    desc: "在最终 messages 全部组装完成、真正发送给 LLM 前统一清洗。",
  },
  {
    key: "output",
    label: "输出总开关",
    desc: "控制全部输出阶段；未单独覆写的细分阶段会跟随它。",
  },
  {
    key: "output.rawResponse",
    label: "输出: 原始响应",
    desc: "LLM 原始文本到手后先清洗一次。",
  },
  {
    key: "output.beforeParse",
    label: "输出: 解析前",
    desc: "在 JSON 提取/解析前再清洗一次。",
  },
];

let panelEl = null;
let overlayEl = null;
let graphRenderer = null;
let mobileGraphRenderer = null;
let currentTabId = "dashboard";
let currentConfigSectionId = "toggles";
let currentTaskProfileTaskType = "extract";
let currentTaskProfileTabId = "generation";
let currentTaskProfileBlockId = "";
let currentTaskProfileRuleId = "";
let fetchedMemoryLLMModels = [];
let fetchedBackendEmbeddingModels = [];
let fetchedDirectEmbeddingModels = [];
let viewportSyncBound = false;

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
let _getRuntimeDebugSnapshot = null;
let _getGraphPersistenceState = null;
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

function mountPanelHtml(html) {
  const markup = String(html || "").trim();
  if (!markup) {
    throw new Error("Panel template markup is empty");
  }

  if (document.body?.insertAdjacentHTML) {
    document.body.insertAdjacentHTML("beforebegin", markup);
    return;
  }

  const template = document.createElement("template");
  template.innerHTML = markup;
  const fragment = template.content.cloneNode(true);
  document.documentElement?.appendChild(fragment);
}

function ensureNodeMountedAtRoot(node, { beforeBody = false } = {}) {
  if (!node) return;
  const root = document.documentElement;
  const body = document.body;
  if (!root) return;

  if (beforeBody && body?.parentElement === root) {
    if (node.parentElement === root && node.nextElementSibling === body) {
      return;
    }
    root.insertBefore(node, body);
    return;
  }

  if (node.parentElement === root) {
    return;
  }

  root.appendChild(node);
}

function ensureOverlayMountedAtRoot() {
  ensureNodeMountedAtRoot(overlayEl, { beforeBody: true });
}

function ensureFabMountedAtRoot() {
  ensureNodeMountedAtRoot(_fabEl);
}

function getViewportMetrics() {
  const viewport = window.visualViewport;
  return {
    width: Math.max(
      1,
      Math.round(viewport?.width || window.innerWidth || 0),
    ),
    height: Math.max(
      1,
      Math.round(viewport?.height || window.innerHeight || 0),
    ),
  };
}

function syncViewportCssVars() {
  const rootStyle = document.documentElement?.style;
  if (!rootStyle) return;

  const { width, height } = getViewportMetrics();

  rootStyle.setProperty("--bme-viewport-width", `${width}px`);
  rootStyle.setProperty("--bme-viewport-height", `${height}px`);
}

function getFabFallbackSize() {
  return _isMobile() ? 54 : 46;
}

function getFabSize(fab = _fabEl) {
  if (fab) {
    const rect = fab.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return {
        width: rect.width,
        height: rect.height,
      };
    }
  }

  const fallback = getFabFallbackSize();
  return {
    width: fallback,
    height: fallback,
  };
}

function getDefaultFabPosition(fab = _fabEl) {
  const { width: viewportWidth, height: viewportHeight } = getViewportMetrics();
  const { width, height } = getFabSize(fab);
  const sideGap = _isMobile() ? 14 : 16;
  const bottomGap = _isMobile() ? 96 : 80;

  return {
    x: Math.max(sideGap, viewportWidth - width - sideGap),
    y: Math.max(sideGap, viewportHeight - height - bottomGap),
  };
}

function clampFabPosition(position = {}, fab = _fabEl) {
  const { width: viewportWidth, height: viewportHeight } = getViewportMetrics();
  const { width, height } = getFabSize(fab);
  const margin = _isMobile() ? 10 : 8;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  const x = Number.isFinite(position?.x) ? position.x : maxX;
  const y = Number.isFinite(position?.y) ? position.y : maxY;

  return {
    x: Math.min(Math.max(margin, Math.round(x)), Math.round(maxX)),
    y: Math.min(Math.max(margin, Math.round(y)), Math.round(maxY)),
  };
}

function applyFabPosition(position = {}, fab = _fabEl) {
  if (!fab) return;
  const clamped = clampFabPosition(position, fab);
  fab.style.left = `${clamped.x}px`;
  fab.style.top = `${clamped.y}px`;
  fab.style.right = "auto";
  fab.style.bottom = "auto";
}

function syncFabPosition() {
  if (!_fabEl) return;

  ensureFabMountedAtRoot();
  const mode = _fabEl.dataset.positionMode || "default";
  if (mode === "saved") {
    const currentX = Number.parseFloat(_fabEl.style.left);
    const currentY = Number.parseFloat(_fabEl.style.top);
    const fallback =
      _loadFabPosition() ||
      getDefaultFabPosition(_fabEl);
    const next = clampFabPosition(
      {
        x: Number.isFinite(currentX) ? currentX : fallback.x,
        y: Number.isFinite(currentY) ? currentY : fallback.y,
      },
      _fabEl,
    );
    applyFabPosition(next, _fabEl);
    _saveFabPosition(next.x, next.y);
    return;
  }

  applyFabPosition(getDefaultFabPosition(_fabEl), _fabEl);
}

function bindViewportSync() {
  if (viewportSyncBound) return;
  viewportSyncBound = true;

  const update = () => {
    syncViewportCssVars();
    syncFabPosition();
  };
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
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
  getRuntimeDebugSnapshot,
  getGraphPersistenceState,
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
  _getRuntimeDebugSnapshot = getRuntimeDebugSnapshot;
  _getGraphPersistenceState = getGraphPersistenceState;
  _updateSettings = updateSettings;
  _actionHandlers = actions || {};

  overlayEl = document.getElementById("st-bme-panel-overlay");
  panelEl = document.getElementById("st-bme-panel");

  if (!overlayEl || !panelEl) {
    const html = await loadLocalTemplate("panel");
    mountPanelHtml(html);
    overlayEl = document.getElementById("st-bme-panel-overlay");
    panelEl = document.getElementById("st-bme-panel");
    if (!overlayEl || !panelEl) {
      throw new Error(
        "Panel template rendered but required DOM nodes were not found",
      );
    }
  }

  ensureOverlayMountedAtRoot();
  bindViewportSync();
  syncViewportCssVars();

  _bindTabs();
  _bindClose();
  _bindNodeDetailPanel();
  _bindResizeHandle();
  _bindPanelResize();
  _bindGraphControls();
  _bindActions();
  _bindConfigControls();
  _bindPlannerLauncher();
  currentTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || "dashboard";
  _applyWorkspaceMode();
  _syncConfigSectionState();
  _refreshRuntimeStatus();
  _initFloatingBall();
  _bindFabToggle();
}

// ==================== 悬浮球 ====================

const FAB_STORAGE_KEY = "bme-fab-position";
const FAB_VISIBLE_KEY = "bme-fab-visible";
let _fabEl = null;

function _getFabVisible() {
  try {
    const val = localStorage.getItem(FAB_VISIBLE_KEY);
    return val === null ? true : val === "true";
  } catch { return true; }
}

function _setFabVisible(visible) {
  try { localStorage.setItem(FAB_VISIBLE_KEY, String(visible)); } catch {}
  if (_fabEl) {
    ensureFabMountedAtRoot();
    _fabEl.style.display = visible ? "flex" : "none";
    if (visible) {
      syncFabPosition();
    }
  }
  const btn = panelEl?.querySelector("#bme-fab-toggle-btn");
  if (btn) btn.setAttribute("data-active", String(visible));
}

function _bindFabToggle() {
  const btn = panelEl?.querySelector("#bme-fab-toggle-btn");
  if (!btn) return;
  btn.setAttribute("data-active", String(_getFabVisible()));
  btn.addEventListener("click", () => {
    const next = !_getFabVisible();
    _setFabVisible(next);
  });
}

function _initFloatingBall() {
  const existing = document.getElementById("bme-floating-ball");
  if (existing) {
    _fabEl = existing;
    ensureFabMountedAtRoot();
    syncFabPosition();
    return;
  }

  const fab = document.createElement("div");
  fab.id = "bme-floating-ball";
  fab.setAttribute("data-status", "idle");
  fab.innerHTML = `
    <i class="fa-solid fa-brain bme-fab-icon"></i>
    <span class="bme-fab-tooltip">BME 记忆图谱</span>
  `;
  _fabEl = fab;
  ensureFabMountedAtRoot();

  // 应用可见性
  if (!_getFabVisible()) fab.style.display = "none";

  // 恢复位置
  const saved = _loadFabPosition();
  if (saved) {
    fab.dataset.positionMode = "saved";
    applyFabPosition(saved, fab);
  } else {
    fab.dataset.positionMode = "default";
    syncFabPosition();
  }

  // 拖拽 + 点击逻辑
  let isDragging = false;
  let hasMoved = false;
  let startX = 0, startY = 0;
  let fabStartX = 0, fabStartY = 0;
  let clickTimer = null;

  const DRAG_THRESHOLD = 5;
  const DBLCLICK_DELAY = 280;

  function onPointerDown(e) {
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    fabStartX = rect.left;
    fabStartY = rect.top;
    fab.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!hasMoved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    hasMoved = true;

    applyFabPosition(
      {
        x: fabStartX + dx,
        y: fabStartY + dy,
      },
      fab,
    );
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    fab.releasePointerCapture(e.pointerId);

    if (hasMoved) {
      // 拖拽结束 → 保存位置
      fab.dataset.positionMode = "saved";
      _saveFabPosition(
        Number.parseInt(fab.style.left, 10),
        Number.parseInt(fab.style.top, 10),
      );
      return;
    }

    // 非拖拽 → 处理单击/双击
    if (clickTimer) {
      // 第二次点击 → 双击 → 重 Roll
      clearTimeout(clickTimer);
      clickTimer = null;
      _onFabDoubleClick();
    } else {
      // 第一次点击 → 等待双击
      clickTimer = setTimeout(() => {
        clickTimer = null;
        _onFabSingleClick();
      }, DBLCLICK_DELAY);
    }
  }

  fab.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
}

function _onFabSingleClick() {
  openPanel();
}

async function _onFabDoubleClick() {
  if (!_actionHandlers.reroll) return;

  try {
    _fabEl?.setAttribute("data-status", "running");
    await _actionHandlers.reroll({});
    _fabEl?.setAttribute("data-status", "success");
    _refreshDashboard();
    _refreshGraph();
    setTimeout(() => {
      const status = _getRuntimeStatus?.() || {};
      _fabEl?.setAttribute("data-status", status.status || "idle");
    }, 3000);
  } catch (err) {
    console.error("[ST-BME] FAB reroll failed:", err);
    _fabEl?.setAttribute("data-status", "error");
  }
}

function _loadFabPosition() {
  try {
    const raw = localStorage.getItem(FAB_STORAGE_KEY);
    if (!raw) return null;
    const pos = JSON.parse(raw);
    if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
  } catch {}
  return null;
}

function _saveFabPosition(x, y) {
  try {
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ x, y }));
  } catch {}
}

export function updateFloatingBallStatus(status = "idle", tooltipText = "") {
  if (!_fabEl) return;
  _fabEl.setAttribute("data-status", status);
  if (tooltipText) {
    const tip = _fabEl.querySelector(".bme-fab-tooltip");
    if (tip) tip.textContent = tooltipText;
  }
}

/**
 * 打开面板
 */
export function openPanel() {
  if (!overlayEl) return;
  ensureOverlayMountedAtRoot();
  syncViewportCssVars();
  _actionHandlers.syncGraphLoad?.();
  overlayEl.classList.add("active");

  _restorePanelSize();

  const isMobile = _isMobile();
  const settings = _getSettings?.() || {};
  const themeName = settings.panelTheme || "crimson";

  const graphOpts = {
    theme: themeName,
    userPovAliases: _hostUserPovAliasHintsForGraph(),
  };
  const canvas = document.getElementById("bme-graph-canvas");
  if (canvas && !graphRenderer && !isMobile) {
    graphRenderer = new GraphRenderer(canvas, graphOpts);
    graphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
  }

  const mobileCanvas = document.getElementById("bme-mobile-graph-canvas");
  if (mobileCanvas && !mobileGraphRenderer && isMobile) {
    mobileGraphRenderer = new GraphRenderer(mobileCanvas, graphOpts);
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

  if (
    currentTabId === "config" &&
    currentConfigSectionId === "prompts" &&
    currentTaskProfileTabId === "debug"
  ) {
    _refreshTaskProfileWorkspace();
  }
  if (currentTabId === "config" && currentConfigSectionId === "trace") {
    _refreshMessageTraceWorkspace();
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

  // ⑥ 移动端图谱 tab 全屏覆盖
  const mainEl = panelEl?.querySelector(".bme-panel-main");
  if (mainEl) {
    mainEl.classList.toggle("mobile-visible", currentTabId === "graph");
  }

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

function _getPlannerApi() {
  return globalThis?.stBmeEnaPlanner || null;
}

function _refreshPlannerLauncher() {
  const button = document.getElementById("bme-open-ena-planner");
  const hint = document.getElementById("bme-open-ena-planner-hint");
  if (!button || !hint) return;

  const plannerApi = _getPlannerApi();
  const ready = typeof plannerApi?.openSettings === "function";

  button.disabled = !ready;
  button.classList.toggle("is-runtime-disabled", !ready);
  hint.textContent = ready
    ? "已加载，可打开独立的 Ena Planner 设置页。"
    : "未检测到 Ena Planner 模块，请重载 ST-BME 后再试。";
}

function _bindPlannerLauncher() {
  const button = document.getElementById("bme-open-ena-planner");
  if (!button || button.dataset.bmeBound === "true") {
    _refreshPlannerLauncher();
    return;
  }

  button.addEventListener("click", () => {
    const plannerApi = _getPlannerApi();
    if (typeof plannerApi?.openSettings === "function") {
      plannerApi.openSettings();
    }
    _refreshPlannerLauncher();
  });

  button.dataset.bmeBound = "true";
  _refreshPlannerLauncher();
}

function _applyWorkspaceMode() {
  if (!panelEl) return;
  const isConfig = currentTabId === "config";
  panelEl.classList.toggle("config-mode", isConfig);
}

function _switchConfigSection(sectionId) {
  currentConfigSectionId = sectionId || "toggles";
  _syncConfigSectionState();
  if (currentConfigSectionId === "prompts") {
    _refreshTaskProfileWorkspace();
  } else if (currentConfigSectionId === "trace") {
    _refreshMessageTraceWorkspace();
  }
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
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  if (!_canRenderGraphData(loadInfo) && loadInfo.loadState !== "empty-confirmed") {
    _setText("bme-stat-nodes", "—");
    _setText("bme-stat-edges", "—");
    _setText("bme-stat-archived", "—");
    _setText("bme-stat-frag", "—");
    _setText("bme-status-chat-id", loadInfo.chatId || "—");
    _setText("bme-status-history", _getGraphLoadLabel(loadInfo.loadState));
    _setText("bme-status-vector", "等待聊天图谱元数据加载");
    _setText("bme-status-recovery", "等待聊天图谱元数据加载");
    _setText("bme-status-last-extract", "等待聊天图谱元数据加载");
    _setText("bme-status-last-vector", "等待聊天图谱元数据加载");
    _setText("bme-status-last-recall", "等待聊天图谱元数据加载");
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-extract"),
      _getGraphLoadLabel(loadInfo.loadState),
    );
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-recall"),
      _getGraphLoadLabel(loadInfo.loadState),
    );
    return;
  }

  const activeNodes = graph.nodes.filter((node) => !node.archived);
  const archivedCount = graph.nodes.filter((node) => node.archived).length;
  const totalNodes = graph.nodes.length;
  const fragRate =
    totalNodes > 0 ? Math.round((archivedCount / totalNodes) * 100) : 0;

  _setText("bme-stat-nodes", activeNodes.length);
  _setText("bme-stat-edges", graph.edges.length);
  _setText("bme-stat-archived", archivedCount);
  _setText("bme-stat-frag", `${fragRate}%`);

  const chatId = loadInfo.chatId || graph?.historyState?.chatId || "—";
  const lastProcessed = graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  const vectorStats = getVectorIndexStats(graph);
  const vectorMode = graph?.vectorIndexState?.mode || "—";
  const vectorSource = graph?.vectorIndexState?.source || "—";
  const recovery = graph?.historyState?.lastRecoveryResult;
  const extractionStatus = _getLastExtractionStatus?.() || {};
  const vectorStatus = _getLastVectorStatus?.() || {};
  const recallStatus = _getLastRecallStatus?.() || {};
  const historyPrefix =
    loadInfo.loadState === "shadow-restored"
      ? "临时恢复 · "
      : loadInfo.loadState === "blocked" && loadInfo.shadowSnapshotUsed
        ? "保护模式 · "
        : "";

  _setText("bme-status-chat-id", chatId);
  _setText(
    "bme-status-history",
    `${historyPrefix}${
      Number.isFinite(dirtyFrom)
        ? `脏区从楼层 ${dirtyFrom} 开始，已处理到 ${lastProcessed}`
        : `干净，已处理到楼层 ${lastProcessed}`
    }`,
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
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    const text = document.createElement("div");
    text.className = "bme-recent-text";
    text.style.color = "var(--bme-on-surface-dim)";
    text.textContent = "暂无数据";
    li.appendChild(text);
    listEl.replaceChildren(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const secondary = item.meta || item.time || "";
    const li = document.createElement("li");
    li.className = "bme-recent-item";

    const badge = document.createElement("span");
    badge.className = `bme-type-badge ${_safeCssToken(item.type)}`;
    badge.textContent = _typeLabel(item.type);
    li.appendChild(badge);

    const content = document.createElement("div");
    const title = document.createElement("div");
    title.className = "bme-recent-text";
    title.textContent = item.name || "—";
    const meta = document.createElement("div");
    meta.className = "bme-recent-meta";
    meta.textContent = secondary;
    content.append(title, meta);
    li.appendChild(content);

    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);
}

// ==================== 记忆浏览器 ====================

function _refreshMemoryBrowser() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const searchInput = document.getElementById("bme-memory-search");
  const regionInput = document.getElementById("bme-memory-region-filter");
  const filterSelect = document.getElementById("bme-memory-filter");
  const listEl = document.getElementById("bme-memory-list");
  if (!listEl) return;

  const canRenderGraph = _canRenderGraphData(loadInfo);
  if (searchInput) searchInput.disabled = !canRenderGraph;
  if (regionInput) regionInput.disabled = !canRenderGraph;
  if (filterSelect) filterSelect.disabled = !canRenderGraph;

  if (!canRenderGraph && loadInfo.loadState !== "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, _getGraphLoadLabel(loadInfo.loadState));
    return;
  }

  const query = String(searchInput?.value || "")
    .trim()
    .toLowerCase();
  const regionQuery = String(regionInput?.value || "")
    .trim()
    .toLowerCase();
  const filter = filterSelect?.value || "all";

  let nodes = graph.nodes.filter((node) => !node.archived);
  if (filter !== "all") {
    nodes = nodes.filter((node) => _matchesMemoryFilter(node, filter));
  }
  if (query) {
    nodes = nodes.filter((node) => {
      const name = getNodeDisplayName(node).toLowerCase();
      const text = JSON.stringify(node.fields || {}).toLowerCase();
      return name.includes(query) || text.includes(query);
    });
  }
  if (regionQuery) {
    nodes = nodes.filter((node) => {
      const scope = normalizeMemoryScope(node.scope);
      const regionText = [
        scope.regionPrimary,
        ...(scope.regionPath || []),
        ...(scope.regionSecondary || []),
      ]
        .join(" ")
        .toLowerCase();
      return regionText.includes(regionQuery);
    });
  }

  nodes.sort((a, b) => {
    const importanceDiff = (b.importance || 5) - (a.importance || 5);
    if (importanceDiff !== 0) return importanceDiff;
    return (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0);
  });

  if (!nodes.length && loadInfo.loadState === "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, "当前聊天还没有图谱");
    return;
  }

  const fragment = document.createDocumentFragment();
  nodes.slice(0, 100).forEach((node) => {
    const name = getNodeDisplayName(node);
    const snippetText = _getNodeSnippet(node);
    const li = document.createElement("li");
    li.className = "bme-memory-item";
    li.dataset.nodeId = String(node.id || "");

    const card = document.createElement("div");
    card.className = "bme-memory-card";

    const head = document.createElement("div");
    head.className = "bme-memory-card-head";

    const badge = document.createElement("span");
    badge.className = `bme-type-badge ${_safeCssToken(node.type)}`;
    badge.textContent = _typeLabel(node.type);

    const scopeChip = document.createElement("span");
    scopeChip.className = "bme-memory-scope-chip";
    scopeChip.textContent = buildScopeBadgeText(node.scope);

    head.append(badge, scopeChip);

    const titleEl = document.createElement("div");
    titleEl.className = "bme-memory-name";
    titleEl.textContent = name;

    const snippetEl = document.createElement("div");
    snippetEl.className = "bme-memory-content";
    snippetEl.textContent = snippetText;

    const foot = document.createElement("div");
    foot.className = "bme-memory-foot";

    const stats = document.createElement("div");
    stats.className = "bme-memory-stats";

    const impSpan = document.createElement("span");
    impSpan.className = "bme-memory-stat-pill";
    impSpan.textContent = `重要度 ${_formatMemoryMetricNumber(node.importance, {
      fallback: 5,
      maxFrac: 2,
    })}`;

    const accSpan = document.createElement("span");
    accSpan.className = "bme-memory-stat-pill";
    accSpan.textContent = `访问 ${_formatMemoryInt(node.accessCount, 0)}`;

    const seqSpan = document.createElement("span");
    seqSpan.className = "bme-memory-stat-pill";
    seqSpan.textContent = `序列 ${_formatMemoryInt(
      node.seqRange?.[1] ?? node.seq,
      0,
    )}`;

    stats.append(impSpan, accSpan, seqSpan);
    foot.appendChild(stats);

    const regionMeta = _buildScopeMetaText(node);
    if (regionMeta) {
      const regionEl = document.createElement("div");
      regionEl.className = "bme-memory-region";
      regionEl.textContent = regionMeta;
      foot.appendChild(regionEl);
    }

    card.append(head, titleEl, snippetEl, foot);
    li.appendChild(card);
    fragment.appendChild(li);
  });
  listEl.replaceChildren(fragment);

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
    regionInput?.addEventListener("input", () => {
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
    const empty = document.createElement("div");
    empty.className = "bme-injection-preview";
    empty.style.color = "var(--bme-on-surface-dim)";
    empty.textContent = "暂无注入内容。先完成一次召回或正常生成后再查看。";
    container.replaceChildren(empty);
    if (tokenEl) tokenEl.textContent = "";
    return;
  }

  try {
    const { estimateTokens } = await import("./injector.js");
    const totalTokens = estimateTokens(injection);
    const preview = document.createElement("div");
    preview.className = "bme-injection-preview";
    preview.textContent = injection;
    container.replaceChildren(preview);
    if (tokenEl) tokenEl.textContent = `≈ ${totalTokens} tokens`;
  } catch (error) {
    const failure = document.createElement("div");
    failure.className = "bme-injection-preview";
    failure.style.color = "var(--bme-accent3)";
    failure.textContent = `预览生成失败: ${error.message}`;
    container.replaceChildren(failure);
    if (tokenEl) tokenEl.textContent = "";
  }
}

// ==================== 图谱 ====================

/** SillyTavern 用户显示名（name1），用于图谱分区：误标为角色的用户 POV 强制归用户区 */
function _hostUserPovAliasHintsForGraph() {
  try {
    const ctx = typeof getContext === "function" ? getContext() : null;
    const out = [];
    if (ctx?.name1 && String(ctx.name1).trim()) {
      out.push(String(ctx.name1).trim());
    }
    return out;
  } catch {
    return [];
  }
}

function _refreshGraph() {
  const graph = _getGraph?.();
  if (!graph) return;
  const hints = { userPovAliases: _hostUserPovAliasHintsForGraph() };
  graphRenderer?.loadGraph(graph, hints);
  mobileGraphRenderer?.loadGraph(graph, hints);
}

function _buildLegend() {
  const legendEl = document.getElementById("bme-graph-legend");
  if (!legendEl) return;

  const settings = _getSettings?.() || {};
  const colors = getNodeColors(settings.panelTheme || "crimson");
  const scopeColors = {
    objective: "#57c7ff",
    characterPov: "#ffb347",
    userPov: "#7dff9b",
  };
  const layers = [
    { key: "objective", label: "客观层" },
    { key: "characterPov", label: "角色 POV" },
    { key: "userPov", label: "用户 POV" },
  ];
  const types = [
    { key: "character", label: "角色" },
    { key: "event", label: "事件" },
    { key: "location", label: "地点" },
    { key: "thread", label: "主线" },
    { key: "rule", label: "规则" },
    { key: "synopsis", label: "概要" },
    { key: "reflection", label: "反思" },
    { key: "pov_memory", label: "主观记忆" },
  ];

  const fragment = document.createDocumentFragment();
  layers.forEach((type) => {
    const item = document.createElement("span");
    item.className = "bme-legend-item";
    const dot = document.createElement("span");
    dot.className = "bme-legend-dot";
    dot.style.background = scopeColors[type.key] || "";
    item.appendChild(dot);
    item.append(document.createTextNode(type.label));
    fragment.appendChild(item);
  });
  types.forEach((type) => {
    const item = document.createElement("span");
    item.className = "bme-legend-item";
    const dot = document.createElement("span");
    dot.className = "bme-legend-dot";
    dot.style.background = colors[type.key] || "";
    item.appendChild(dot);
    item.append(document.createTextNode(type.label));
    fragment.appendChild(item);
  });
  legendEl.replaceChildren(fragment);
}

function _getActiveGraphRenderer() {
  return mobileGraphRenderer || graphRenderer;
}

function _bindGraphControls() {
  document
    .getElementById("bme-graph-zoom-in")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.zoomIn());
  document
    .getElementById("bme-graph-zoom-out")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.zoomOut());
  document
    .getElementById("bme-graph-reset")
    ?.addEventListener("click", () => _getActiveGraphRenderer()?.resetView());
}

// ==================== 节点详情 ====================

function _appendNodeDetailReadOnly(container, labelText, valueText) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const value = document.createElement("div");
  value.className = "value";
  value.textContent = String(valueText ?? "—");
  row.append(label, value);
  container.appendChild(row);
}

function _appendNodeDetailNumberInput(
  container,
  labelText,
  inputId,
  value,
  { min, max, step } = {},
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.id = inputId;
  input.className = "bme-node-detail-input";
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  if (step != null) input.step = String(step);
  input.value =
    value === undefined || value === null ? "" : String(Number(value));
  row.append(label, input);
  container.appendChild(row);
}

function _appendNodeDetailTextInput(container, labelText, inputId, value) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.id = inputId;
  input.className = "bme-node-detail-input";
  input.value = String(value ?? "");
  row.append(label, input);
  container.appendChild(row);
}

function _appendNodeDetailTextareaField(
  container,
  labelText,
  fieldKey,
  fieldType,
  text,
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  const ta = document.createElement("textarea");
  ta.className = "bme-node-detail-textarea";
  ta.dataset.bmeFieldKey = fieldKey;
  ta.dataset.bmeFieldType = fieldType;
  ta.rows = String(text || "").length > 160 ? 6 : 3;
  ta.value = text;
  row.append(label, ta);
  container.appendChild(row);
}

function _showNodeDetail(node) {
  const detailEl = document.getElementById("bme-node-detail");
  const titleEl = document.getElementById("bme-detail-title");
  const bodyEl = document.getElementById("bme-detail-body");
  if (!detailEl || !titleEl || !bodyEl) return;

  const raw = node.raw || node;
  const fields = raw.fields || {};
  titleEl.textContent = getNodeDisplayName(raw);
  detailEl.dataset.editNodeId = raw.id || "";

  const fragment = document.createDocumentFragment();

  _appendNodeDetailReadOnly(fragment, "类型", _typeLabel(raw.type));
  _appendNodeDetailReadOnly(
    fragment,
    "作用域",
    buildScopeBadgeText(raw.scope),
  );
  _appendNodeDetailReadOnly(fragment, "ID", raw.id || "—");
  _appendNodeDetailReadOnly(
    fragment,
    "序列号",
    raw.seqRange?.[1] ?? raw.seq ?? 0,
  );

  const scope = normalizeMemoryScope(raw.scope);
  if (scope.layer === "pov") {
    _appendNodeDetailReadOnly(
      fragment,
      "POV 归属",
      `${scope.ownerType || "unknown"} / ${scope.ownerName || scope.ownerId || "—"}`,
    );
  }
  const regionLine = buildRegionLine(scope);
  if (regionLine) {
    _appendNodeDetailReadOnly(fragment, "地区", regionLine);
  }
  if (Array.isArray(raw.seqRange)) {
    _appendNodeDetailReadOnly(
      fragment,
      "序列范围",
      `${raw.seqRange[0]} ~ ${raw.seqRange[1]}`,
    );
  }

  _appendNodeDetailNumberInput(
    fragment,
    "重要度 (0–10)",
    "bme-detail-importance",
    raw.importance ?? 5,
    { min: 0, max: 10, step: 0.1 },
  );
  _appendNodeDetailNumberInput(
    fragment,
    "访问次数",
    "bme-detail-accesscount",
    raw.accessCount ?? 0,
    { min: 0, step: 1 },
  );

  const clustersStr = Array.isArray(raw.clusters)
    ? raw.clusters.join(", ")
    : "";
  _appendNodeDetailTextInput(
    fragment,
    "聚类标签 (逗号分隔)",
    "bme-detail-clusters",
    clustersStr,
  );

  const section = document.createElement("div");
  section.className = "bme-node-detail-section";
  section.textContent = "记忆字段";
  fragment.appendChild(section);

  for (const [key, value] of Object.entries(fields)) {
    const isJson = typeof value === "object" && value !== null;
    const displayVal = isJson
      ? JSON.stringify(value, null, 2)
      : String(value ?? "");
    _appendNodeDetailTextareaField(
      fragment,
      key,
      key,
      isJson ? "json" : "string",
      displayVal,
    );
  }
  bodyEl.replaceChildren(fragment);

  detailEl.classList.add("open");
}

function _saveNodeDetail() {
  const detailEl = document.getElementById("bme-node-detail");
  const bodyEl = document.getElementById("bme-detail-body");
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId || !bodyEl) return;
  if (_isGraphWriteBlocked()) {
    toastr.error("当前图谱不可写入，请稍后再试", "ST-BME");
    return;
  }

  const updates = { fields: {} };
  const impEl = document.getElementById("bme-detail-importance");
  if (impEl && impEl.value !== "") {
    const imp = Number.parseFloat(impEl.value);
    if (Number.isFinite(imp)) {
      updates.importance = Math.max(0, Math.min(10, imp));
    }
  }
  const accessEl = document.getElementById("bme-detail-accesscount");
  if (accessEl && accessEl.value !== "") {
    const ac = Number.parseInt(accessEl.value, 10);
    if (Number.isFinite(ac)) {
      updates.accessCount = Math.max(0, ac);
    }
  }
  const clustersEl = document.getElementById("bme-detail-clusters");
  if (clustersEl) {
    updates.clusters = clustersEl.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const fieldEls = bodyEl.querySelectorAll("[data-bme-field-key]");
  for (const el of fieldEls) {
    const key = el.dataset.bmeFieldKey;
    const type = el.dataset.bmeFieldType || "string";
    const rawVal = el.value;
    if (type === "json") {
      try {
        updates.fields[key] = JSON.parse(rawVal || "null");
      } catch {
        toastr.error(`字段「${key}」须为合法 JSON`, "ST-BME");
        return;
      }
    } else {
      updates.fields[key] = rawVal;
    }
  }

  const result = _actionHandlers.saveGraphNode?.({
    nodeId,
    updates,
  });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found"
        ? "节点已不存在，请关闭后重试"
        : "保存失败",
      "ST-BME",
    );
    return;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "内容已更新，但写回聊天元数据可能被拦截，请查看图谱状态",
      "ST-BME",
    );
  } else {
    toastr.success("节点已保存", "ST-BME");
  }

  const r = _getActiveGraphRenderer();
  const sel = r?.selectedNode;
  if (sel?.id === nodeId && sel.raw) {
    _showNodeDetail(sel);
  } else {
    const g = _getGraph?.();
    const rawN = g?.nodes?.find((n) => n.id === nodeId);
    if (rawN) {
      _showNodeDetail({ raw: rawN, id: rawN.id });
    }
  }
  refreshLiveState();
}

function _bindNodeDetailPanel() {
  const saveBtn = document.getElementById("bme-detail-save");
  if (saveBtn && saveBtn.dataset.bmeBound !== "true") {
    saveBtn.addEventListener("click", () => _saveNodeDetail());
    saveBtn.dataset.bmeBound = "true";
  }
  const deleteBtn = document.getElementById("bme-detail-delete");
  if (deleteBtn && deleteBtn.dataset.bmeBound !== "true") {
    deleteBtn.addEventListener("click", () => _deleteNodeDetail());
    deleteBtn.dataset.bmeBound = "true";
  }
}

function _deleteNodeDetail() {
  const detailEl = document.getElementById("bme-node-detail");
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId) return;
  if (_isGraphWriteBlocked()) {
    toastr.error("当前图谱不可写入，请稍后再试", "ST-BME");
    return;
  }
  const g = _getGraph?.();
  const node = g?.nodes?.find((n) => n.id === nodeId);
  const label = node ? getNodeDisplayName(node) : nodeId;
  if (
    !confirm(
      `确定删除节点「${label}」？\n\n若该节点有层级子节点，将一并删除。此操作不可在本面板内撤销。`,
    )
  ) {
    return;
  }
  const result = _actionHandlers.deleteGraphNode?.({ nodeId });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found" ? "节点已不存在" : "删除失败",
      "ST-BME",
    );
    return;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "节点已从图中移除，但写回可能被拦截，请查看图谱状态",
      "ST-BME",
    );
  } else {
    toastr.success("节点已删除", "ST-BME");
  }
  detailEl?.classList.remove("open");
  if (detailEl) delete detailEl.dataset.editNodeId;
  graphRenderer?.highlightNode?.("__cleared__");
  mobileGraphRenderer?.highlightNode?.("__cleared__");
  refreshLiveState();
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

const PANEL_SIZE_KEY = "st-bme-panel-size";
let _panelResizeTimer = null;

function _bindPanelResize() {
  if (!panelEl || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => {
    clearTimeout(_panelResizeTimer);
    _panelResizeTimer = setTimeout(() => {
      if (!overlayEl?.classList.contains("active")) return;
      const w = panelEl.offsetWidth;
      const h = panelEl.offsetHeight;
      if (w > 0 && h > 0) {
        try {
          localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ w, h }));
        } catch { /* ignore */ }
      }
    }, 300);
  });
  observer.observe(panelEl);
}

function _restorePanelSize() {
  if (!panelEl) return;
  if (_isMobile()) {
    panelEl.style.width = "";
    panelEl.style.height = "";
    return;
  }
  try {
    const raw = localStorage.getItem(PANEL_SIZE_KEY);
    if (!raw) return;
    const { w, h } = JSON.parse(raw);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 200 && h > 200) {
      panelEl.style.width = w + "px";
      panelEl.style.height = h + "px";
    }
  } catch { /* ignore */ }
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
    "bme-act-undo-maintenance": "undoMaintenance",
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
    undoMaintenance: "撤销最近维护",
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

      _showActionProgressUi(label);
      toastr.info(`${label} 进行中…`, "ST-BME", { timeOut: 2000 });

      try {
        const result = await handler();
        if (result?.cancelled) {
          return;
        }
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
        if (!result?.handledToast) {
          toastr.success(`${label} 完成`, "ST-BME");
        }
      } catch (error) {
        console.error(`[ST-BME] Action ${actionKey} failed:`, error);
        if (!error?._stBmeToastHandled) {
          toastr.error(`${label} 失败: ${error?.message || error}`, "ST-BME");
        }
      } finally {
        btn.style.opacity = "";
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
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

      _showActionProgressUi("范围重建");
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
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // 重新提取 (reroll) 绑定
  document
    .getElementById("bme-act-reroll")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-reroll");
      if (btn?.disabled) return;

      const floorStr = document.getElementById("bme-reroll-floor")?.value;
      const fromFloor = _parseOptionalInt(floorStr);
      const desc = Number.isFinite(fromFloor)
        ? `从楼层 ${fromFloor} 开始回滚并重新提取`
        : "回滚最新 AI 楼并重新提取";

      if (!confirm(`确认要重新提取吗？\n\n${desc}\n\n已提取的记忆节点将被回滚。`)) {
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("重新提取");
      try {
        await _actionHandlers.reroll?.({
          fromFloor: Number.isFinite(fromFloor) ? fromFloor : undefined,
        });
        _refreshDashboard();
        _refreshGraph();
        if (
          document
            .getElementById("bme-pane-memory")
            ?.classList.contains("active")
        ) {
          _refreshMemoryBrowser();
        }
      } catch (error) {
        console.error("[ST-BME] Action reroll failed:", error);
        toastr.error(`重新提取失败: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });
}

function _refreshConfigTab() {
  const settings = _resolveAndPersistActiveLlmPreset(_getSettings?.() || {});
  const resolvedActiveLlmPreset = String(settings.llmActivePreset || "");
  _refreshPlannerLauncher();

  _setCheckboxValue("bme-setting-enabled", settings.enabled ?? true);
  _setCheckboxValue(
    "bme-setting-debug-logging-enabled",
    settings.debugLoggingEnabled ?? false,
  );
  _setCheckboxValue(
    "bme-setting-hide-old-messages-enabled",
    settings.hideOldMessagesEnabled ?? false,
  );
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
    "bme-setting-recall-multi-intent-enabled",
    settings.recallEnableMultiIntent ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-context-query-blend-enabled",
    settings.recallEnableContextQueryBlend ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-lexical-boost-enabled",
    settings.recallEnableLexicalBoost ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-temporal-links-enabled",
    settings.recallEnableTemporalLinks ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-diversity-enabled",
    settings.recallEnableDiversitySampling ?? true,
  );
  _setCheckboxValue(
    "bme-setting-recall-cooccurrence-enabled",
    settings.recallEnableCooccurrenceBoost ?? false,
  );
  _setCheckboxValue(
    "bme-setting-recall-residual-enabled",
    settings.recallEnableResidualRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-scoped-memory-enabled",
    settings.enableScopedMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-pov-memory-enabled",
    settings.enablePovMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-region-scoped-objective-enabled",
    settings.enableRegionScopedObjective ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-user-pov-memory",
    settings.injectUserPovMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-objective-global-memory",
    settings.injectObjectiveGlobalMemory ?? true,
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
    "bme-setting-auto-compression-enabled",
    settings.enableAutoCompression ?? true,
  );
  _setCheckboxValue(
    "bme-setting-prob-recall-enabled",
    settings.enableProbRecall ?? false,
  );
  _setCheckboxValue(
    "bme-setting-reflection-enabled",
    settings.enableReflection ?? false,
  );
  _setInputValue(
    "bme-setting-recall-card-user-input-display-mode",
    settings.recallCardUserInputDisplayMode ?? "beautify_only",
  );
  _setInputValue(
    "bme-setting-notice-display-mode",
    settings.noticeDisplayMode ?? "normal",
  );
  _setInputValue(
    "bme-setting-wi-filter-mode",
    settings.worldInfoFilterMode || "default",
  );
  _setInputValue(
    "bme-setting-wi-filter-keywords",
    settings.worldInfoFilterCustomKeywords || "",
  );
  const wiFilterCustomSection = panelEl?.querySelector(
    "#bme-wi-filter-custom-section",
  );
  if (wiFilterCustomSection) {
    wiFilterCustomSection.style.display =
      (settings.worldInfoFilterMode || "default") === "custom" ? "" : "none";
  }

  _setInputValue("bme-setting-extract-every", settings.extractEvery ?? 1);
  _setInputValue(
    "bme-setting-hide-old-messages-keep-last-n",
    settings.hideOldMessagesKeepLastN ?? 12,
  );
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
  _setInputValue(
    "bme-setting-recall-multi-intent-max-segments",
    settings.recallMultiIntentMaxSegments ?? 4,
  );
  _setInputValue(
    "bme-setting-recall-context-assistant-weight",
    settings.recallContextAssistantWeight ?? 0.2,
  );
  _setInputValue(
    "bme-setting-recall-context-previous-user-weight",
    settings.recallContextPreviousUserWeight ?? 0.1,
  );
  _setInputValue(
    "bme-setting-recall-lexical-weight",
    settings.recallLexicalWeight ?? 0.18,
  );
  _setInputValue(
    "bme-setting-recall-teleport-alpha",
    settings.recallTeleportAlpha ?? 0.15,
  );
  _setInputValue(
    "bme-setting-recall-temporal-link-strength",
    settings.recallTemporalLinkStrength ?? 0.2,
  );
  _setInputValue(
    "bme-setting-recall-dpp-candidate-multiplier",
    settings.recallDppCandidateMultiplier ?? 3,
  );
  _setInputValue(
    "bme-setting-recall-dpp-quality-weight",
    settings.recallDppQualityWeight ?? 1.0,
  );
  _setInputValue(
    "bme-setting-recall-cooccurrence-scale",
    settings.recallCooccurrenceScale ?? 0.1,
  );
  _setInputValue(
    "bme-setting-recall-cooccurrence-max-neighbors",
    settings.recallCooccurrenceMaxNeighbors ?? 10,
  );
  _setInputValue(
    "bme-setting-recall-residual-basis-max-nodes",
    settings.recallResidualBasisMaxNodes ?? 24,
  );
  _setInputValue(
    "bme-setting-recall-nmf-topics",
    settings.recallNmfTopics ?? 15,
  );
  _setInputValue(
    "bme-setting-recall-nmf-novelty-threshold",
    settings.recallNmfNoveltyThreshold ?? 0.4,
  );
  _setInputValue(
    "bme-setting-recall-residual-threshold",
    settings.recallResidualThreshold ?? 0.3,
  );
  _setInputValue(
    "bme-setting-recall-residual-top-k",
    settings.recallResidualTopK ?? 5,
  );
  _setInputValue(
    "bme-setting-recall-character-pov-weight",
    settings.recallCharacterPovWeight ?? 1.25,
  );
  _setInputValue(
    "bme-setting-recall-user-pov-weight",
    settings.recallUserPovWeight ?? 1.05,
  );
  _setInputValue(
    "bme-setting-recall-objective-current-region-weight",
    settings.recallObjectiveCurrentRegionWeight ?? 1.15,
  );
  _setInputValue(
    "bme-setting-recall-objective-adjacent-region-weight",
    settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
  );
  _setInputValue(
    "bme-setting-recall-objective-global-weight",
    settings.recallObjectiveGlobalWeight ?? 0.75,
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
  _setInputValue(
    "bme-setting-consolidation-auto-min-new-nodes",
    settings.consolidationAutoMinNewNodes ?? 2,
  );
  _setInputValue(
    "bme-setting-compression-every",
    settings.compressionEveryN ?? 10,
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
  _populateLlmPresetSelect(settings.llmPresets || {}, resolvedActiveLlmPreset);
  _syncLlmPresetControls(resolvedActiveLlmPreset);
  _setInputValue("bme-setting-timeout-ms", settings.timeoutMs ?? 300000);

  _setInputValue("bme-setting-embed-url", settings.embeddingApiUrl || "");
  _setInputValue("bme-setting-embed-key", settings.embeddingApiKey || "");
  _setInputValue(
    "bme-setting-embed-model",
    settings.embeddingModel || "text-embedding-3-small",
  );
  _setInputValue(
    "bme-setting-embed-mode",
    settings.embeddingTransportMode || "direct",
  );
  _toggleEmbedFields(settings.embeddingTransportMode || "direct");
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
    settings.extractPrompt || getDefaultPromptText("extract"),
  );
  _setInputValue(
    "bme-setting-recall-prompt",
    settings.recallPrompt || getDefaultPromptText("recall"),
  );
  _setInputValue(
    "bme-setting-consolidation-prompt",
    settings.consolidationPrompt || getDefaultPromptText("consolidation"),
  );
  _setInputValue(
    "bme-setting-compress-prompt",
    settings.compressPrompt || getDefaultPromptText("compress"),
  );
  _setInputValue(
    "bme-setting-synopsis-prompt",
    settings.synopsisPrompt || getDefaultPromptText("synopsis"),
  );
  _setInputValue(
    "bme-setting-reflection-prompt",
    settings.reflectionPrompt || getDefaultPromptText("reflection"),
  );

  _refreshFetchedModelSelects(settings);
  _refreshGuardedConfigStates(settings);
  _refreshStageCardStates(settings);
  _refreshPromptCardStates(settings);
  _refreshTaskProfileWorkspace(settings);
  _refreshMessageTraceWorkspace(settings);
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
  bindCheckbox("bme-setting-debug-logging-enabled", (checked) => {
    _patchSettings({ debugLoggingEnabled: checked });
  });
  bindCheckbox("bme-setting-hide-old-messages-enabled", (checked) => {
    _patchSettings({ hideOldMessagesEnabled: checked });
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
  bindCheckbox("bme-setting-recall-multi-intent-enabled", (checked) => {
    _patchSettings({ recallEnableMultiIntent: checked });
  });
  bindCheckbox("bme-setting-recall-context-query-blend-enabled", (checked) => {
    _patchSettings({ recallEnableContextQueryBlend: checked });
  });
  bindCheckbox("bme-setting-recall-lexical-boost-enabled", (checked) => {
    _patchSettings({ recallEnableLexicalBoost: checked });
  });
  bindCheckbox("bme-setting-recall-temporal-links-enabled", (checked) => {
    _patchSettings({ recallEnableTemporalLinks: checked });
  });
  bindCheckbox("bme-setting-recall-diversity-enabled", (checked) => {
    _patchSettings({ recallEnableDiversitySampling: checked });
  });
  bindCheckbox("bme-setting-recall-cooccurrence-enabled", (checked) => {
    _patchSettings({ recallEnableCooccurrenceBoost: checked });
  });
  bindCheckbox("bme-setting-recall-residual-enabled", (checked) => {
    _patchSettings({ recallEnableResidualRecall: checked });
  });
  bindCheckbox("bme-setting-scoped-memory-enabled", (checked) => {
    _patchSettings({ enableScopedMemory: checked });
  });
  bindCheckbox("bme-setting-pov-memory-enabled", (checked) => {
    _patchSettings({ enablePovMemory: checked });
  });
  bindCheckbox(
    "bme-setting-region-scoped-objective-enabled",
    (checked) => {
      _patchSettings({ enableRegionScopedObjective: checked });
    },
  );
  bindCheckbox("bme-setting-inject-user-pov-memory", (checked) => {
    _patchSettings({ injectUserPovMemory: checked });
  });
  bindCheckbox("bme-setting-inject-objective-global-memory", (checked) => {
    _patchSettings({ injectObjectiveGlobalMemory: checked });
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
  bindCheckbox("bme-setting-auto-compression-enabled", (checked) => {
    _patchSettings({ enableAutoCompression: checked });
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
  const recallCardUserInputDisplayModeEl = document.getElementById(
    "bme-setting-recall-card-user-input-display-mode",
  );
  if (
    recallCardUserInputDisplayModeEl &&
    recallCardUserInputDisplayModeEl.dataset.bmeBound !== "true"
  ) {
    recallCardUserInputDisplayModeEl.addEventListener("change", () => {
      _patchSettings({
        recallCardUserInputDisplayMode:
          recallCardUserInputDisplayModeEl.value || "beautify_only",
      });
    });
    recallCardUserInputDisplayModeEl.dataset.bmeBound = "true";
  }
  const noticeDisplayModeEl = document.getElementById(
    "bme-setting-notice-display-mode",
  );
  if (noticeDisplayModeEl && noticeDisplayModeEl.dataset.bmeBound !== "true") {
    noticeDisplayModeEl.addEventListener("change", () => {
      _patchSettings({
        noticeDisplayMode: noticeDisplayModeEl.value || "normal",
      });
    });
    noticeDisplayModeEl.dataset.bmeBound = "true";
  }
  const wiFilterModeEl = document.getElementById("bme-setting-wi-filter-mode");
  if (wiFilterModeEl && wiFilterModeEl.dataset.bmeBound !== "true") {
    wiFilterModeEl.addEventListener("change", () => {
      const nextValue = wiFilterModeEl.value || "default";
      _patchSettings({ worldInfoFilterMode: nextValue });
      const section = panelEl?.querySelector("#bme-wi-filter-custom-section");
      if (section) {
        section.style.display = nextValue === "custom" ? "" : "none";
      }
    });
    wiFilterModeEl.dataset.bmeBound = "true";
  }
  const wiFilterKeywordsEl = document.getElementById(
    "bme-setting-wi-filter-keywords",
  );
  if (wiFilterKeywordsEl && wiFilterKeywordsEl.dataset.bmeBound !== "true") {
    wiFilterKeywordsEl.addEventListener("change", () => {
      _patchSettings({
        worldInfoFilterCustomKeywords: wiFilterKeywordsEl.value || "",
      });
    });
    wiFilterKeywordsEl.dataset.bmeBound = "true";
  }

  bindNumber("bme-setting-extract-every", 1, 1, 50, (value) =>
    _patchSettings({ extractEvery: value }),
  );
  bindNumber(
    "bme-setting-hide-old-messages-keep-last-n",
    12,
    0,
    200,
    (value) => _patchSettings({ hideOldMessagesKeepLastN: value }),
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
  bindNumber(
    "bme-setting-recall-multi-intent-max-segments",
    4,
    1,
    8,
    (value) => _patchSettings({ recallMultiIntentMaxSegments: value }),
  );
  bindFloat(
    "bme-setting-recall-context-assistant-weight",
    0.2,
    0,
    1,
    (value) => _patchSettings({ recallContextAssistantWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-context-previous-user-weight",
    0.1,
    0,
    1,
    (value) => _patchSettings({ recallContextPreviousUserWeight: value }),
  );
  bindFloat("bme-setting-recall-lexical-weight", 0.18, 0, 1, (value) =>
    _patchSettings({ recallLexicalWeight: value }),
  );
  bindFloat("bme-setting-recall-teleport-alpha", 0.15, 0, 1, (value) =>
    _patchSettings({ recallTeleportAlpha: value }),
  );
  bindFloat(
    "bme-setting-recall-temporal-link-strength",
    0.2,
    0,
    1,
    (value) => _patchSettings({ recallTemporalLinkStrength: value }),
  );
  bindNumber(
    "bme-setting-recall-dpp-candidate-multiplier",
    3,
    1,
    10,
    (value) => _patchSettings({ recallDppCandidateMultiplier: value }),
  );
  bindFloat("bme-setting-recall-dpp-quality-weight", 1.0, 0, 10, (value) =>
    _patchSettings({ recallDppQualityWeight: value }),
  );
  bindFloat("bme-setting-recall-cooccurrence-scale", 0.1, 0, 10, (value) =>
    _patchSettings({ recallCooccurrenceScale: value }),
  );
  bindNumber(
    "bme-setting-recall-cooccurrence-max-neighbors",
    10,
    1,
    50,
    (value) => _patchSettings({ recallCooccurrenceMaxNeighbors: value }),
  );
  bindNumber(
    "bme-setting-recall-residual-basis-max-nodes",
    24,
    2,
    64,
    (value) => _patchSettings({ recallResidualBasisMaxNodes: value }),
  );
  bindNumber("bme-setting-recall-nmf-topics", 15, 2, 64, (value) =>
    _patchSettings({ recallNmfTopics: value }),
  );
  bindFloat(
    "bme-setting-recall-nmf-novelty-threshold",
    0.4,
    0,
    1,
    (value) => _patchSettings({ recallNmfNoveltyThreshold: value }),
  );
  bindFloat("bme-setting-recall-residual-threshold", 0.3, 0, 10, (value) =>
    _patchSettings({ recallResidualThreshold: value }),
  );
  bindNumber("bme-setting-recall-residual-top-k", 5, 1, 20, (value) =>
    _patchSettings({ recallResidualTopK: value }),
  );
  bindFloat("bme-setting-recall-character-pov-weight", 1.25, 0, 3, (value) =>
    _patchSettings({ recallCharacterPovWeight: value }),
  );
  bindFloat("bme-setting-recall-user-pov-weight", 1.05, 0, 3, (value) =>
    _patchSettings({ recallUserPovWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-current-region-weight",
    1.15,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveCurrentRegionWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-adjacent-region-weight",
    0.9,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveAdjacentRegionWeight: value }),
  );
  bindFloat(
    "bme-setting-recall-objective-global-weight",
    0.75,
    0,
    3,
    (value) => _patchSettings({ recallObjectiveGlobalWeight: value }),
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
  bindNumber(
    "bme-setting-consolidation-auto-min-new-nodes",
    2,
    1,
    50,
    (value) => _patchSettings({ consolidationAutoMinNewNodes: value }),
  );
  bindNumber(
    "bme-setting-compression-every",
    10,
    0,
    500,
    (value) => _patchSettings({ compressionEveryN: value }),
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

  const llmPresetSelect = document.getElementById("bme-llm-preset-select");
  if (llmPresetSelect && llmPresetSelect.dataset.bmeBound !== "true") {
    llmPresetSelect.addEventListener("change", () => {
      const selectedName = String(llmPresetSelect.value || "");
      if (!selectedName) {
        const currentActivePreset = String(
          (_getSettings?.() || {}).llmActivePreset || "",
        );
        if (currentActivePreset) {
          _patchSettings({ llmActivePreset: "" });
        }
        _syncLlmPresetControls("");
        return;
      }

      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const preset = settings.llmPresets?.[selectedName];
      if (!preset) {
        _patchSettings({ llmActivePreset: "" }, { refreshTaskWorkspace: true });
        _populateLlmPresetSelect(settings.llmPresets || {}, "");
        _syncLlmPresetControls("");
        toastr.warning("选中的模板不存在，已切回手动模式", "ST-BME");
        return;
      }

      _patchSettings({
        llmApiUrl: preset.llmApiUrl,
        llmApiKey: preset.llmApiKey,
        llmModel: preset.llmModel,
        llmActivePreset: selectedName,
      });
      _setInputValue("bme-setting-llm-url", preset.llmApiUrl);
      _setInputValue("bme-setting-llm-key", preset.llmApiKey);
      _setInputValue("bme-setting-llm-model", preset.llmModel);
      _clearFetchedLlmModels();
      _syncLlmPresetControls(selectedName);
    });
    llmPresetSelect.dataset.bmeBound = "true";
  }

  const llmPresetSaveBtn = document.getElementById("bme-llm-preset-save");
  if (llmPresetSaveBtn && llmPresetSaveBtn.dataset.bmeBound !== "true") {
    llmPresetSaveBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      if (!activePreset) {
        document.getElementById("bme-llm-preset-save-as")?.click();
        return;
      }

      const nextPresets = {
        ...(settings.llmPresets || {}),
        [activePreset]: _getLlmConfigInputSnapshot(),
      };
      _patchSettings({ llmPresets: nextPresets }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, activePreset);
      _syncLlmPresetControls(activePreset);
      toastr.success("当前模板已保存", "ST-BME");
    });
    llmPresetSaveBtn.dataset.bmeBound = "true";
  }

  const llmPresetSaveAsBtn = document.getElementById("bme-llm-preset-save-as");
  if (llmPresetSaveAsBtn && llmPresetSaveAsBtn.dataset.bmeBound !== "true") {
    llmPresetSaveAsBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      const suggestedName = activePreset
        ? `${activePreset} 副本`
        : "新模板";
      const nextName = window.prompt("请输入新模板名称", suggestedName);
      if (nextName == null) return;

      const trimmedName = String(nextName).trim();
      if (!trimmedName) {
        toastr.info("模板名称不能为空", "ST-BME");
        return;
      }
      if (trimmedName in (settings.llmPresets || {})) {
        toastr.info("模板名称已存在，请换一个", "ST-BME");
        return;
      }

      const nextPresets = {
        ...(settings.llmPresets || {}),
        [trimmedName]: _getLlmConfigInputSnapshot(),
      };
      _patchSettings({
        llmPresets: nextPresets,
        llmActivePreset: trimmedName,
      }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, trimmedName);
      _syncLlmPresetControls(trimmedName);
      toastr.success("已另存为新模板", "ST-BME");
    });
    llmPresetSaveAsBtn.dataset.bmeBound = "true";
  }

  const llmPresetDeleteBtn = document.getElementById("bme-llm-preset-delete");
  if (llmPresetDeleteBtn && llmPresetDeleteBtn.dataset.bmeBound !== "true") {
    llmPresetDeleteBtn.addEventListener("click", () => {
      const settings = _normalizeLlmPresetSettings(_getSettings?.() || {});
      const activePreset = String(settings.llmActivePreset || "");
      if (!activePreset) {
        toastr.info("当前处于手动模式，没有可删除的模板", "ST-BME");
        return;
      }

      const confirmed = window.confirm(
        `确定要删除模板“${activePreset}”吗？当前输入框里的值会保留。`,
      );
      if (!confirmed) return;

      const nextPresets = { ...(settings.llmPresets || {}) };
      delete nextPresets[activePreset];
      _patchSettings({
        llmPresets: nextPresets,
        llmActivePreset: "",
      }, { refreshTaskWorkspace: true });
      _populateLlmPresetSelect(nextPresets, "");
      _syncLlmPresetControls("");
      toastr.success("模板已删除", "ST-BME");
    });
    llmPresetDeleteBtn.dataset.bmeBound = "true";
  }

  bindText("bme-setting-llm-url", (value) => {
    _patchSettings({ llmApiUrl: value.trim() });
    _markLlmPresetDirty({ clearFetchedModels: true });
  });
  bindText("bme-setting-llm-key", (value) => {
    _patchSettings({ llmApiKey: value.trim() });
    _markLlmPresetDirty({ clearFetchedModels: true });
  });
  bindText("bme-setting-llm-model", (value) => {
    _patchSettings({ llmModel: value.trim() });
    _markLlmPresetDirty();
  });
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
      _setInputValue(targetId, getDefaultPromptText(promptKey));
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
    .getElementById("bme-apply-hide-settings")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.applyCurrentHide?.();
      if (result?.error) {
        toastr.error(result.error, "ST-BME");
        return;
      }
      toastr.success("当前聊天的隐藏设置已重新应用", "ST-BME");
    });
  document
    .getElementById("bme-clear-hide-settings")
    ?.addEventListener("click", async () => {
      const result = await _actionHandlers.clearCurrentHide?.();
      if (result?.error) {
        toastr.error(result.error, "ST-BME");
        return;
      }
      toastr.info("已取消当前聊天里由 ST-BME 应用的隐藏", "ST-BME");
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
      _setInputValue(id, getDefaultPromptText(promptKey));
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

  const importAllInput = document.getElementById("bme-task-profile-import-all");
  if (importAllInput && importAllInput.dataset.bmeBound !== "true") {
    importAllInput.addEventListener("change", async () => {
      const file = importAllInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (parsed?.format !== "st-bme-all-task-profiles" || !parsed?.profiles) {
          throw new Error("文件格式不正确，请选择「导出全部」生成的文件");
        }
        const settings = _getSettings?.() || {};
        let mergedProfiles = settings.taskProfiles || {};
        let importedCount = 0;
        for (const [taskType, entry] of Object.entries(parsed.profiles)) {
          try {
            const imported = parseImportedTaskProfile(
              mergedProfiles,
              entry,
              taskType,
            );
            mergedProfiles = imported.taskProfiles;
            importedCount++;
          } catch (innerError) {
            console.warn(`[ST-BME] 跳过导入任务 ${taskType}:`, innerError);
          }
        }
        if (importedCount === 0) {
          toastr.warning("没有成功导入任何预设", "ST-BME");
          return;
        }
        _patchTaskProfiles(mergedProfiles);
        toastr.success(`已导入 ${importedCount} 个任务预设`, "ST-BME");
      } catch (error) {
        console.error("[ST-BME] 导入全部预设失败:", error);
        toastr.error(`导入全部预设失败: ${error?.message || error}`, "ST-BME");
      } finally {
        importAllInput.value = "";
      }
    });
    importAllInput.dataset.bmeBound = "true";
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
    // 滑动条 ↔ 数字输入 同步
    const group = target.closest(".bme-range-group");
    if (group) {
      const key = target.dataset.generationKey;
      const sibling = group.querySelector(
        target.type === "range" ? `.bme-range-number` : `.bme-range-input`,
      );
      if (sibling) sibling.value = target.value;
      // 更新 label 上的值显示
      const row = target.closest(".bme-config-row");
      const badge = row?.querySelector(".bme-range-value");
      if (badge) badge.textContent = target.value || "默认";
    }
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
  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {
    hostCapabilities: null,
    runtimeDebug: null,
  };

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
    runtimeDebug,
  };
}

function _refreshTaskProfileWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-task-profile-workspace");
  if (!workspace) return;

  const state = _getTaskProfileWorkspaceState(settings);
  workspace.innerHTML = _renderTaskProfileWorkspace(state);
}

function _getMessageTraceWorkspaceState(settings = _getSettings?.() || {}) {
  const panelDebug = _getRuntimeDebugSnapshot?.() || {
    hostCapabilities: null,
    runtimeDebug: null,
  };
  const runtimeDebug = panelDebug.runtimeDebug || {};

  return {
    settings,
    panelDebug,
    runtimeDebug,
    recallInjection: runtimeDebug?.injections?.recall || null,
    messageTrace: runtimeDebug?.messageTrace || null,
    recallLlmRequest: runtimeDebug?.taskLlmRequests?.recall || null,
    recallPromptBuild: runtimeDebug?.taskPromptBuilds?.recall || null,
    extractLlmRequest: runtimeDebug?.taskLlmRequests?.extract || null,
    extractPromptBuild: runtimeDebug?.taskPromptBuilds?.extract || null,
  };
}

function _refreshMessageTraceWorkspace(settings = _getSettings?.() || {}) {
  const workspace = document.getElementById("bme-message-trace-workspace");
  if (!workspace) return;

  const state = _getMessageTraceWorkspaceState(settings);
  workspace.innerHTML = _renderMessageTraceWorkspace(state);
}

function _renderMessageTraceWorkspace(state) {
  const updatedCandidates = [
    state.recallInjection?.updatedAt,
    state.recallLlmRequest?.updatedAt,
    state.extractLlmRequest?.updatedAt,
    state.extractPromptBuild?.updatedAt,
  ]
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => Number.isFinite(value));
  const updatedAt = updatedCandidates.length
    ? new Date(Math.max(...updatedCandidates)).toISOString()
    : "";

  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-toolbar-row">
        <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(updatedAt))}</span>
      </div>

      <div class="bme-task-debug-grid">
        <div class="bme-config-card">
          ${_renderMessageTraceRecallCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderMessageTraceExtractCard(state)}
        </div>
      </div>
    </div>
  `;
}

function _renderMessageTraceRecallCard(state) {
  const injectionSnapshot = state.recallInjection || null;
  const recentMessages = Array.isArray(injectionSnapshot?.recentMessages)
    ? injectionSnapshot.recentMessages.map((item) => String(item || ""))
    : [];
  const lastSentUserMessage = String(
    state.messageTrace?.lastSentUserMessage?.text || "",
  ).trim();
  const triggeredUserMessage =
    lastSentUserMessage ||
    _extractTriggeredUserMessageFromRecentMessages(recentMessages);
  const hostPayloadText = _buildMainAiTraceText(
    triggeredUserMessage,
    injectionSnapshot?.injectionText || "",
  );
  const missingUserMessageNotice =
    injectionSnapshot && !triggeredUserMessage
      ? `
        <div class="bme-config-help">
          这次没有可靠捕获到主 AI 那边的用户消息，因此这里只展示真实记录到的记忆注入文本，不再用 recall 模型请求去反推，避免误导排查。
        </div>
      `
      : "";

  if (!injectionSnapshot) {
    return `
      <div class="bme-config-card-title">最后注入给主 AI 的内容</div>
      <div class="bme-config-help">
        还没有可用的召回注入快照。先正常发一条消息，让插件跑完一轮召回即可。
      </div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">最后注入给主 AI 的内容</div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(injectionSnapshot.updatedAt))}</span>
    </div>
    ${missingUserMessageNotice}
    ${_renderMessageTraceTextBlock(
      "发送给主 AI 的内容",
      hostPayloadText,
      "这次没有捕获到主 AI 侧的注入内容。",
    )}
  `;
}

function _renderMessageTraceExtractCard(state) {
  const extractLlmRequest = state.extractLlmRequest || null;
  const extractPromptBuild = state.extractPromptBuild || null;
  const extractPayloadText = _buildTraceMessagePayloadText(
    extractLlmRequest?.messages,
    extractPromptBuild,
  );

  if (!extractLlmRequest && !extractPromptBuild) {
    return `
      <div class="bme-config-card-title">最后送去提取模型的内容</div>
      <div class="bme-config-help">
        还没有可用的提取请求快照。等 assistant 正常回完一轮，自动提取跑过后这里就会出现。
      </div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">最后送去提取模型的内容</div>
      </div>
      <span class="bme-task-pill">${_escHtml(
        _formatTaskProfileTime(extractLlmRequest?.updatedAt || extractPromptBuild?.updatedAt),
      )}</span>
    </div>
    ${_renderMessageTraceTextBlock(
      "发送去提取模型的内容",
      extractPayloadText,
      "这次没有捕获到提取请求内容。",
    )}
  `;
}

function _renderMessageTraceTextBlock(title, text, emptyText = "暂无内容") {
  const normalized = String(text || "").trim();
  return `
    <div class="bme-task-section-label">${_escHtml(title)}</div>
    ${
      normalized
        ? `<pre class="bme-debug-pre">${_escHtml(normalized)}</pre>`
        : `<div class="bme-debug-empty">${_escHtml(emptyText)}</div>`
    }
  `;
}

function _normalizeDebugMessages(messages = []) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const role = String(message.role || "").trim().toLowerCase();
      const content = String(message.content || "").trim();
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean);
}

function _stringifyTraceMessages(messages = []) {
  const normalizedMessages = _normalizeDebugMessages(messages);
  if (!normalizedMessages.length) return "";

  return normalizedMessages
    .map(
      (message) => `【${message.role}】\n${message.content}`,
    )
    .join("\n\n---\n\n");
}

function _buildMainAiTraceText(triggeredUserMessage = "", injectionText = "") {
  const sections = [];
  const normalizedUserMessage = String(triggeredUserMessage || "").trim();
  const normalizedInjectionText = String(injectionText || "").trim();

  if (normalizedUserMessage) {
    sections.push(`【user】\n${normalizedUserMessage}`);
  }
  if (normalizedInjectionText) {
    sections.push(`【memory injection】\n${normalizedInjectionText}`);
  }

  return sections.join("\n\n---\n\n").trim();
}

function _buildTraceMessagePayloadText(messages = [], promptBuild = null) {
  const normalizedMessages = _normalizeDebugMessages(messages);
  if (normalizedMessages.length) {
    return _stringifyTraceMessages(normalizedMessages);
  }

  const fallbackMessages = [];
  const fallbackSystemPrompt = String(promptBuild?.systemPrompt || "").trim();
  if (fallbackSystemPrompt) {
    fallbackMessages.push({ role: "system", content: fallbackSystemPrompt });
  }

  for (const message of promptBuild?.privateTaskMessages || []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").trim().toLowerCase();
    const content = String(message.content || "").trim();
    if (!role || !content) continue;
    fallbackMessages.push({ role, content });
  }

  return _stringifyTraceMessages(fallbackMessages);
}

function _extractTriggeredUserMessageFromRecentMessages(recentMessages = []) {
  if (!Array.isArray(recentMessages)) return "";

  for (let index = recentMessages.length - 1; index >= 0; index--) {
    const line = String(recentMessages[index] || "").trim();
    if (!line) continue;
    if (line.startsWith("[user]:")) {
      return line.replace(/^\[user\]:\s*/i, "").trim();
    }
  }
  return "";
}

function _patchTaskProfiles(taskProfiles, extraPatch = {}, options = {}) {
  return _patchSettings(
    {
      taskProfilesVersion: 3,
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
    case "refresh-task-debug":
      if (typeof _getRuntimeDebugSnapshot === "function") {
        _getRuntimeDebugSnapshot({ refreshHost: true });
      }
      _refreshTaskProfileWorkspace();
      return;
    case "inspect-tavern-regex":
      await _openRegexReuseInspector(state.taskType);
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
    case "export-all-profiles":
      _downloadAllTaskProfiles(state.taskProfiles);
      return;
    case "import-all-profiles":
      document.getElementById("bme-task-profile-import-all")?.click();
      return;
    case "restore-all-profiles": {
      const confirmed = window.confirm(
        "这会将全部 6 个任务的默认预设恢复为出厂状态。已保存的自定义预设不受影响。是否继续？",
      );
      if (!confirmed) return;
      const taskTypes = getTaskTypeOptions().map((t) => t.id);
      let restored = state.taskProfiles;
      const extraPatch = {};
      for (const tt of taskTypes) {
        restored = restoreDefaultTaskProfile(restored, tt);
        const lf = getLegacyPromptFieldForTask(tt);
        if (lf) extraPatch[lf] = "";
      }
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _patchTaskProfiles(restored, extraPatch);
      toastr.success(`已恢复全部 ${taskTypes.length} 个任务的默认预设`, "ST-BME");
      return;
    }
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
                  data-task-type="${_escAttr(item.id)}"
                  type="button"
                >
                  <span>${_escHtml(item.label)}</span>
                </button>
              `,
            )
            .join("")}
          <span style="flex:1"></span>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn bme-task-btn-danger" data-task-action="restore-all-profiles" type="button" title="恢复全部 6 个任务的默认预设">
            <i class="fa-solid fa-arrows-rotate" style="margin-right:4px"></i>恢复全部
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="export-all-profiles" type="button" title="导出全部 6 个任务预设">
            <i class="fa-solid fa-file-export" style="margin-right:4px"></i>导出全部
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="import-all-profiles" type="button" title="导入全部预设（覆盖当前）">
            <i class="fa-solid fa-file-import" style="margin-right:4px"></i>导入全部
          </button>
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
                        value="${_escAttr(profile.id)}"
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
                value="${_escAttr(state.profile.name || "")}"
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
              data-task-tab="${_escAttr(tab.id)}"
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
              : state.taskTabId === "debug"
                ? _renderTaskDebugTab(state)
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
                    <option value="${_escAttr(item.sourceKey)}">
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
                  _renderGenerationField(
                    field,
                    state.profile.generation?.[field.key],
                    state,
                  ),
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
  const normalizedStages = normalizeTaskRegexStages(regex.stages || {});
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
          <button class="bme-config-secondary-btn" data-task-action="inspect-tavern-regex" type="button">
            查看当前复用规则
          </button>
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

        <div class="bme-task-section-label">执行阶段</div>
        <div class="bme-task-toggle-list">
          ${TASK_PROFILE_REGEX_STAGES.map(
            (stage) => `
              <label class="bme-toggle-item">
                <span class="bme-toggle-copy">
                  <span class="bme-toggle-title">${_escHtml(stage.label)}</span>
                  <span class="bme-toggle-desc">${_escHtml(stage.desc)}</span>
                </span>
                  <input
                    type="checkbox"
                    data-regex-stage="${_escAttr(stage.key)}"
                    ${isTaskRegexStageEnabled(normalizedStages, stage.key) ? "checked" : ""}
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

function _formatRegexReuseSourceState(source = {}) {
  const states = [];
  states.push(source.enabled ? "已启用" : "已关闭");
  states.push(source.allowed === false ? "未获酒馆允许" : "允许参与");
  states.push(
    source.resolvedVia === "bridge"
      ? "通过桥接读取"
      : source.resolvedVia === "fallback"
        ? "通过 fallback 读取"
        : "来源未知",
  );
  return states.join(" · ");
}

function _formatRegexReuseSourceLabel(sourceType = "") {
  if (sourceType === "global") return "全局";
  if (sourceType === "preset") return "预设";
  if (sourceType === "character") return "角色卡";
  if (sourceType === "local") return "任务本地";
  return sourceType ? String(sourceType) : "未知";
}

function _formatRegexReuseReplaceText(rule = {}) {
  if (rule.promptStageMode === "clear") {
    return "（美化/展示正则，ST-BME 请求阶段清空）";
  }
  if (typeof rule.effectivePromptReplaceString === "string" && rule.effectivePromptReplaceString.length > 0) {
    return rule.effectivePromptReplaceString;
  }
  if (typeof rule.replaceString === "string" && rule.replaceString.length > 0) {
    return rule.replaceString;
  }
  return "（空 - 删除匹配内容）";
}

function _renderRegexReuseBadges(rule = {}) {
  const badges = [];
  if (rule.promptStageMode === "clear") {
    badges.push({
      className: "is-clear",
      text: "美化 -> 清空",
    });
  } else if (rule.promptStageMode === "replace") {
    badges.push({
      className: "is-transform",
      text: "转义",
    });
  } else {
    badges.push({
      className: "is-skip",
      text: "当前阶段跳过",
    });
  }
  if (rule.markdownOnly) {
    badges.push({
      className: "is-skip",
      text: "跳过(MD)",
    });
  }
  if (rule.promptOnly) {
    badges.push({
      className: "is-prompt",
      text: "仅 Prompt",
    });
  }
  if (rule.promptStageMode !== "skip" && rule.promptStageApplies === false) {
    badges.push({
      className: "is-skip",
      text: "当前任务未启用",
    });
  }
  return badges
    .map(
      (badge) => `<span class="bme-regex-preview-item__badge ${badge.className}">${_escHtml(badge.text)}</span>`,
    )
    .join("");
}

function _renderRegexReuseRuleList(rules = [], emptyText = "无", options = {}) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return `<div class="bme-task-empty">${_escHtml(emptyText)}</div>`;
  }

  const {
    showSource = false,
    showReason = false,
    startIndex = 0,
    muted = false,
  } = options || {};

  return rules
    .map((rule, index) => {
      const placementText = Array.isArray(rule.placementLabels) && rule.placementLabels.length
        ? rule.placementLabels.join("，")
        : "未声明作用域";
      const sourceLabel = _formatRegexReuseSourceLabel(rule.sourceType || "");
      const metaBits = [];
      if (showSource) {
        metaBits.push(`来源：${sourceLabel}`);
      }
      if (showReason && rule.reason) {
        metaBits.push(rule.reason);
      }
      return `
        <div class="bme-regex-preview-item ${muted ? "is-muted" : ""}">
          <div class="bme-regex-preview-item__head">
            <div class="bme-regex-preview-item__title-group">
              <span class="bme-regex-preview-item__index">#${startIndex + index + 1}</span>
              <span class="bme-regex-preview-item__name">${_escHtml(rule.name || rule.id || "未命名规则")}</span>
            </div>
            <div class="bme-regex-preview-item__badges">
              ${_renderRegexReuseBadges(rule)}
            </div>
          </div>
          <div class="bme-regex-preview-item__details">
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">查找</span>
              <code>${_escHtml(rule.findRegex || "(空 findRegex)")}</code>
            </div>
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">替换</span>
              <code>${_escHtml(_formatRegexReuseReplaceText(rule))}</code>
            </div>
            <div class="bme-regex-preview-item__row">
              <span class="bme-regex-preview-item__label">作用域</span>
              <span>${_escHtml(placementText)}</span>
            </div>
            ${showSource ? `
              <div class="bme-regex-preview-item__row">
                <span class="bme-regex-preview-item__label">来源</span>
                <span>${_escHtml(sourceLabel)}</span>
              </div>
            ` : ""}
          </div>
          ${metaBits.length ? `
            <div class="bme-regex-preview-item__meta">${_escHtml(metaBits.join(" · "))}</div>
          ` : ""}
        </div>
      `;
    })
    .join("");
}

function _buildRegexReusePopupContent(snapshot = {}) {
  const container = document.createElement("div");
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  const activeRules = Array.isArray(snapshot.activeRules) ? snapshot.activeRules : [];
  const stageConfig = snapshot.stageConfig && typeof snapshot.stageConfig === "object"
    ? snapshot.stageConfig
    : {};
  const sourceConfig = snapshot.sourceConfig && typeof snapshot.sourceConfig === "object"
    ? snapshot.sourceConfig
    : {};
  const sourceSummaryText = [
    `global=${sourceConfig.global === false ? "关" : "开"}`,
    `preset=${sourceConfig.preset === false ? "关" : "开"}`,
    `character=${sourceConfig.character === false ? "关" : "开"}`,
  ].join(" / ");
  const stageSummaryText =
    Object.entries(stageConfig)
      .map(([key, value]) => `${key}=${value ? "on" : "off"}`)
      .join(" | ") || "无";

  container.innerHTML = `
    <div class="bme-task-tab-body bme-regex-preview-screen">
      <div class="bme-regex-preview-hero">
        <div class="bme-regex-preview-hero__title">当前正则脚本一览</div>
        <div class="bme-regex-preview-hero__subtitle">
          这里展示的是当前任务预设下，ST-BME 实际会复用到请求链里的 Tavern 正则。展示/美化类规则在请求阶段会按空字符串替换。
        </div>
        <div class="bme-regex-preview-summary">
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">任务</span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.taskType || "—")}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">预设</span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.profileName || snapshot.profileId || "—")}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">任务正则</span>
            <span class="bme-regex-preview-summary__value">${snapshot.regexEnabled ? "已启用" : "已关闭"}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">复用 Tavern</span>
            <span class="bme-regex-preview-summary__value">${snapshot.inheritStRegex ? "已启用" : "已关闭"}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">已收集规则</span>
            <span class="bme-regex-preview-summary__value">${Number(snapshot.activeRuleCount || activeRules.length || 0)}</span>
          </div>
          <div class="bme-regex-preview-summary__item">
            <span class="bme-regex-preview-summary__label">桥接模式</span>
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.host?.sourceLabel || "unknown")} · ${_escHtml(snapshot.host?.capabilityStatus?.mode || snapshot.host?.mode || "unknown")}${snapshot.host?.fallback ? " · fallback" : ""}</span>
          </div>
        </div>
      </div>

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">当前启用规则</div>
            <div class="bme-regex-preview-panel__subtitle">EW 风格平铺展示，优先看你这次请求里真正会进入链路的规则。</div>
          </div>
        </div>
        <div class="bme-task-note">
          来源开关：${_escHtml(sourceSummaryText)}<br>
          阶段开关：${_escHtml(stageSummaryText)}
        </div>
        <div class="bme-regex-preview-list">
          ${_renderRegexReuseRuleList(activeRules, "当前没有复用到任何酒馆正则", {
            showSource: true,
          })}
        </div>
      </div>

      <details class="bme-debug-details bme-regex-preview-details">
        <summary>来源与排除明细</summary>
        <div class="bme-regex-preview-details__body">
        ${
          sources.length
            ? sources.map((source) => `
                <div class="bme-regex-preview-source">
                  <div class="bme-regex-preview-source__head">
                    <div class="bme-regex-preview-source__title">${_escHtml(source.label || source.type || "未知来源")}</div>
                    <div class="bme-regex-preview-source__meta">${_escHtml(_formatRegexReuseSourceState(source))}</div>
                  </div>
                  <div class="bme-task-note">
                    raw=${Number(source.rawRuleCount || 0)} / active=${Number(source.activeRuleCount || 0)}
                    ${source.reason ? `<br>${_escHtml(source.reason)}` : ""}
                  </div>
                  <div class="bme-task-section-label">本来源规则总览</div>
                  <div class="bme-regex-preview-list">
                    ${_renderRegexReuseRuleList(source.previewRules || source.rules, "该来源当前没有可展示的规则")}
                  </div>
                  <div class="bme-task-section-label">未纳入最终任务链</div>
                  <div class="bme-regex-preview-list">
                    ${_renderRegexReuseRuleList(source.ignoredRules, "没有额外被排除的规则", {
                      showReason: true,
                      muted: true,
                    })}
                  </div>
                </div>
              `).join("")
            : `<div class="bme-task-empty">当前没有可展示的酒馆正则来源。</div>`
        }
        </div>
      </details>
    </div>
  `;

  return container;
}

async function _openRegexReuseInspector(taskType) {
  if (typeof _actionHandlers.inspectTaskRegexReuse !== "function") {
    toastr.info("当前运行时没有接入正则复用诊断入口", "ST-BME");
    return;
  }

  try {
    const snapshot = await _actionHandlers.inspectTaskRegexReuse(taskType);
    const content = _buildRegexReusePopupContent(snapshot || {});
    await callGenericPopup(content, POPUP_TYPE.TEXT, "", {
      okButton: "关闭",
      wide: true,
      large: true,
      allowVerticalScrolling: true,
    });
  } catch (error) {
    console.error("[ST-BME] 打开正则复用检查弹窗失败:", error);
    toastr.error("打开正则复用检查弹窗失败", "ST-BME");
  }
}

function _renderTaskDebugTab(state) {
  const hostCapabilities = state.runtimeDebug?.hostCapabilities || null;
  const runtimeDebug = state.runtimeDebug?.runtimeDebug || {};
  const promptBuild = runtimeDebug?.taskPromptBuilds?.[state.taskType] || null;
  const llmRequest = runtimeDebug?.taskLlmRequests?.[state.taskType] || null;
  const recallInjection = runtimeDebug?.injections?.recall || null;
  const maintenanceDebug = runtimeDebug?.maintenance || null;
  const graphPersistence = runtimeDebug?.graphPersistence || null;

  return `
    <div class="bme-task-tab-body">
      <div class="bme-task-toolbar-row">
        <div class="bme-task-note">
          这里展示的是最近一次真实运行留下的调试快照，不是静态配置推演。没有数据时，先跑一次对应任务即可。
        </div>
        <button class="bme-config-secondary-btn" data-task-action="refresh-task-debug" type="button">
          刷新状态
        </button>
      </div>

      <div class="bme-task-debug-grid">
        <div class="bme-config-card">
          ${_renderTaskDebugHostCard(hostCapabilities)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugGraphPersistenceCard(graphPersistence)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugMaintenanceCard(maintenanceDebug)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugPromptCard(state.taskType, promptBuild)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugLlmCard(state.taskType, llmRequest)}
        </div>
        <div class="bme-config-card">
          ${_renderTaskDebugInjectionCard(recallInjection)}
        </div>
      </div>
    </div>
  `;
}

function _renderTaskDebugMaintenanceCard(maintenanceDebug) {
  const lastAction = maintenanceDebug?.lastAction || null;
  const lastUndoResult = maintenanceDebug?.lastUndoResult || null;

  if (!lastAction && !lastUndoResult) {
    return `
      <div class="bme-config-card-title">维护账本状态</div>
      <div class="bme-config-help">当前还没有最近维护或撤销快照。</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">维护账本状态</div>
        <div class="bme-config-card-subtitle">
          最近一次维护记录和最近一次撤销结果。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(lastAction?.action || lastUndoResult?.action || "maintenance")}</span>
    </div>
    ${_renderDebugDetails("最近维护", lastAction)}
    ${_renderDebugDetails("最近撤销", lastUndoResult)}
  `;
}

function _renderTaskDebugGraphPersistenceCard(graphPersistence) {
  if (!graphPersistence) {
    return `
      <div class="bme-config-card-title">图谱持久化状态</div>
      <div class="bme-config-help">当前还没有图谱加载/持久化快照。</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">图谱持久化状态</div>
        <div class="bme-config-card-subtitle">
          最近一次图谱加载与写回协调结果。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(graphPersistence.loadState || "unknown")}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">聊天</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.chatId || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">原因</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.reason || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">尝试次数</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.attemptIndex ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">当前 revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.graphRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">最近已持久化 revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.lastPersistedRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">排队中的 revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.queuedPersistRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">影子快照</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.shadowSnapshotUsed ? "已接管" : "未使用")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">写保护</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.writesBlocked ? "已启用" : "未启用")}</span>
      </div>
    </div>
    ${_renderDebugDetails("图谱持久化详情", graphPersistence)}
  `;
}

function _renderTaskDebugHostCard(hostCapabilities) {
  if (!hostCapabilities) {
    return `
      <div class="bme-config-card-title">宿主桥接状态</div>
      <div class="bme-config-help">当前还没有宿主桥接快照。</div>
    `;
  }

  const capabilityNames = ["context", "worldbook", "regex", "injection"];
  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">宿主桥接状态</div>
        <div class="bme-config-card-subtitle">
          当前插件和 SillyTavern 的接轨情况。
        </div>
      </div>
      <span class="bme-task-pill ${hostCapabilities.available ? "is-builtin" : ""}">
        ${hostCapabilities.mode || (hostCapabilities.available ? "available" : "unavailable")}
      </span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">总状态</span>
        <span class="bme-debug-kv-value">${_escHtml(hostCapabilities.available ? "可用" : "不可用")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">说明</span>
        <span class="bme-debug-kv-value">${_escHtml(hostCapabilities.fallbackReason || "无")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">快照版本</span>
        <span class="bme-debug-kv-value">${_escHtml(String(hostCapabilities.snapshotRevision ?? "—"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">快照时间</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatTaskProfileTime(hostCapabilities.snapshotCreatedAt))}</span>
      </div>
    </div>
    <div class="bme-task-section-label">分项能力</div>
    <div class="bme-debug-capability-list">
      ${capabilityNames
        .map((name) => {
          const capability = hostCapabilities[name] || {};
          return `
            <div class="bme-debug-capability-item">
              <div class="bme-debug-capability-head">
                <span class="bme-debug-capability-title">${_escHtml(name)}</span>
                <span class="bme-task-pill ${capability.available ? "is-builtin" : ""}">
                  ${_escHtml(capability.mode || (capability.available ? "available" : "unavailable"))}
                </span>
              </div>
              <div class="bme-debug-capability-desc">
                ${_escHtml(capability.fallbackReason || "无")}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function _renderTaskDebugPromptCard(taskType, promptBuild) {
  if (!promptBuild) {
    return `
      <div class="bme-config-card-title">最近 Prompt 组装</div>
      <div class="bme-config-help">当前任务还没有最近一次 prompt 组装快照。</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">最近 Prompt 组装</div>
        <div class="bme-config-card-subtitle">
          任务 ${_escHtml(taskType)} 最近一次真实编排结果。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(promptBuild.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">预设</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.profileName || promptBuild.profileId || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">块数量</span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.renderedBlockCount ?? promptBuild.renderedBlocks?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">注入计划</span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.hostInjectionPlanCount ?? promptBuild.debug?.hostInjectionCount ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">私有消息</span>
        <span class="bme-debug-kv-value">${_escHtml(String(promptBuild.debug?.executionMessageCount ?? promptBuild.executionMessages?.length ?? promptBuild.privateTaskMessages?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">EJS 状态</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.ejsRuntimeStatus || "unknown")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">世界书</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.effectivePath?.worldInfo || "unknown")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">世界书缓存</span>
        <span class="bme-debug-kv-value">${_escHtml(promptBuild.debug?.worldInfoCacheHit ? "命中" : "未命中")}</span>
      </div>
    </div>
    ${_renderDebugDetails("实际投递路径", promptBuild.debug?.effectivePath || null)}
    ${_renderDebugDetails("渲染后的块（按配置顺序）", promptBuild.renderedBlocks)}
    ${_renderDebugDetails("实际执行消息序列", promptBuild.executionMessages || promptBuild.privateTaskMessages || null)}
    ${_renderDebugDetails("系统提示词（兼容视图，不含 atDepth 消息）", promptBuild.systemPrompt || "")}
    ${_renderDebugDetails("世界书桶内容（诊断）", promptBuild.hostInjections)}
    ${_renderDebugDetails("世界书块命中计划（诊断）", promptBuild.hostInjectionPlan || null)}
    ${_renderDebugDetails("世界书调试", promptBuild.worldInfo?.debug || promptBuild.worldInfoResolution?.debug || null)}
  `;
}

function _renderTaskDebugLlmCard(taskType, llmRequest) {
  if (!llmRequest) {
    return `
      <div class="bme-config-card-title">最近实际下发参数</div>
      <div class="bme-config-help">当前任务还没有最近一次 LLM 请求快照。</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">最近实际下发参数</div>
        <div class="bme-config-card-subtitle">
          任务 ${_escHtml(taskType)} 最近一次走私有请求层时的实际发送信息。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(llmRequest.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">请求来源</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.requestSource || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">请求路径</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.route || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">模型</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.model || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">API 配置来源</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmConfigSourceLabel || llmRequest.llmConfigSource || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">任务 API 模板</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmPresetName || (llmRequest.requestedLlmPresetName ? `缺失: ${llmRequest.requestedLlmPresetName}` : "跟随当前 API"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">能力过滤模式</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.capabilityMode || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">调试脱敏</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.redacted ? "已脱敏" : "未标记")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">实际路径</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.effectiveRoute?.llm || llmRequest.route || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">输出清洗</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.responseCleaning?.applied ? "已生效" : "未生效")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">发送前输入清洗</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.requestCleaning?.applied ? "已生效" : "未生效")}</span>
      </div>
    </div>
    ${_renderDebugDetails("提示词执行摘要", llmRequest.promptExecution || null)}
    ${_renderDebugDetails("发送前输入清洗", llmRequest.requestCleaning || null)}
    ${_renderDebugDetails("实际请求路径", llmRequest.effectiveRoute || null)}
    ${_renderDebugDetails("输出清洗", llmRequest.responseCleaning || null)}
    ${_renderDebugDetails("API 配置解析", {
      llmConfigSource: llmRequest.llmConfigSource || "",
      llmConfigSourceLabel: llmRequest.llmConfigSourceLabel || "",
      requestedLlmPresetName: llmRequest.requestedLlmPresetName || "",
      llmPresetName: llmRequest.llmPresetName || "",
      llmPresetFallbackReason: llmRequest.llmPresetFallbackReason || "",
    })}
    ${_renderDebugDetails("实际保留参数", llmRequest.filteredGeneration || {})}
    ${_renderDebugDetails("被过滤掉的参数", llmRequest.removedGeneration || [])}
    ${_renderDebugDetails("最终消息列表", llmRequest.messages || [])}
    ${_renderDebugDetails("最终请求体", llmRequest.requestBody || null)}
  `;
}

function _renderTaskDebugInjectionCard(injectionSnapshot) {
  if (!injectionSnapshot) {
    return `
      <div class="bme-config-card-title">最近注入结果</div>
      <div class="bme-config-help">还没有最近一次召回注入快照。</div>
    `;
  }

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">最近注入结果</div>
        <div class="bme-config-card-subtitle">
          展示最近一次召回后的注入文本和宿主投递方式。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(injectionSnapshot.updatedAt))}</span>
    </div>
    <div class="bme-debug-kv-list">
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">来源</span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.sourceLabel || injectionSnapshot.source || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">触发钩子</span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.hookName || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">选中节点数</span>
        <span class="bme-debug-kv-value">${_escHtml(String(injectionSnapshot.selectedNodeIds?.length ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">宿主投递</span>
        <span class="bme-debug-kv-value">${_escHtml(injectionSnapshot.transport?.source || "—")} / ${_escHtml(injectionSnapshot.transport?.mode || "—")}</span>
      </div>
    </div>
    ${_renderDebugDetails("召回统计", {
      retrievalMeta: injectionSnapshot.retrievalMeta || {},
      llmMeta: injectionSnapshot.llmMeta || {},
      stats: injectionSnapshot.stats || {},
      transport: injectionSnapshot.transport || {},
    })}
    ${_renderDebugDetails("最终注入文本", injectionSnapshot.injectionText || "")}
  `;
}

function _renderDebugDetails(title, value) {
  const isEmptyArray = Array.isArray(value) && value.length === 0;
  const isEmptyObject =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
  const isEmpty = value == null || value === "" || isEmptyArray || isEmptyObject;

  return `
    <details class="bme-debug-details" ${isEmpty ? "" : "open"}>
      <summary>${_escHtml(title)}</summary>
      ${
        isEmpty
          ? '<div class="bme-debug-empty">暂无内容</div>'
          : `<pre class="bme-debug-pre">${_escHtml(_stringifyDebugValue(value))}</pre>`
      }
    </details>
  `;
}

function _stringifyDebugValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function _renderTaskBlockListItem(block, index, state) {
  const isSelected = block.id === state.selectedBlock?.id;
  return `
    <div class="bme-task-list-entry">
      <button
        class="bme-task-list-item ${isSelected ? "active" : ""}"
        data-task-action="select-block"
        data-block-id="${_escAttr(block.id)}"
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
          data-block-id="${_escAttr(block.id)}"
          type="button"
        >
          上移
        </button>
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="move-block-down"
          data-block-id="${_escAttr(block.id)}"
          type="button"
        >
          下移
        </button>
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="toggle-block-enabled"
          data-block-id="${_escAttr(block.id)}"
          type="button"
        >
          ${block.enabled ? "停用" : "启用"}
        </button>
        <button
          class="bme-config-secondary-btn bme-task-mini-btn"
          data-task-action="delete-block"
          data-block-id="${_escAttr(block.id)}"
          type="button"
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
          value="${_escAttr(item.sourceKey)}"
          ${item.sourceKey === block.sourceKey ? "selected" : ""}
        >
          ${_escHtml(item.name)}
        </option>
      `,
    )
    .join("");
  const legacyField = getLegacyPromptFieldForTask(state.taskType);
  const legacyValue =
    legacyField && block.type === "legacyPrompt"
      ? state.settings?.[legacyField] || block.content || getDefaultPromptText(state.taskType) || ""
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
      ${block.type === "builtin" ? _helpTip(
        (state.builtinBlockDefinitions.find((d) => d.sourceKey === block.sourceKey) || {}).description || ""
      ) : ""}
    </div>

    <div class="bme-config-row">
      <label>块名称</label>
        <input
          class="bme-config-input"
          type="text"
          data-block-field="name"
          value="${_escAttr(block.name || "")}"
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
        ? (() => {
            const externalSourceMap = {
              charDescription: "角色卡描述",
              userPersona: "用户 Persona 设定",
              worldInfoBefore: "World Info (↑ Char)",
              worldInfoAfter: "World Info (↓ Char)",
            };
            const externalLabel = externalSourceMap[block.sourceKey];
            return `
            <div class="bme-config-row">
              <label>内置来源${_helpTip("运行时自动从任务上下文注入的数据。不同任务类型使用不同来源。")}</label>
              <select class="bme-config-input" data-block-field="sourceKey">
                ${builtinOptions}
              </select>
            </div>
            ${externalLabel
              ? `<div class="bme-task-note" style="text-align:center;padding:1rem;opacity:0.7;">
                   此提示词的内容是从其他地方提取的，无法在此处进行编辑。<br/>
                   来源：<strong>${externalLabel}</strong>
                 </div>`
              : `<div class="bme-config-row">
                   <label>覆盖内容（可选）${_helpTip("留空时自动从 sourceKey 对应的上下文数据读取。填写后将覆盖自动注入的内容。")}</label>
                   <textarea
                     class="bme-config-textarea"
                     data-block-field="content"
                     placeholder="留空时从 sourceKey 对应的任务上下文读取。"
                   >${_escHtml(block.content || "")}</textarea>
                 </div>`
            }`;
          })()
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
                  value="${_escAttr(legacyField || block.sourceField || "")}"
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

function _renderGenerationField(field, value, state = {}) {
  const effectiveValue = (value != null && value !== "") ? value : field.defaultValue;

  if (field.type === "llm_preset") {
    const presetMap =
      state?.settings && typeof state.settings === "object"
        ? state.settings.llmPresets || {}
        : {};
    const presetNames = Object.keys(presetMap).sort((left, right) =>
      left.localeCompare(right, "zh-Hans-CN"),
    );
    const currentValue = String(effectiveValue || "");
    const hasCurrentPreset =
      !currentValue || presetNames.includes(currentValue);
    const currentLabel = !currentValue
      ? "跟随当前 API"
      : hasCurrentPreset
        ? currentValue
        : `${currentValue}（已丢失，将回退当前 API）`;
    const options = [
      {
        value: "",
        label: "跟随当前 API",
      },
      ...(!currentValue || hasCurrentPreset
        ? []
        : [{ value: currentValue, label: currentLabel }]),
      ...presetNames.map((name) => ({
        value: name,
        label: name,
      })),
    ];

    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${options
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === currentValue ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
        ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
      </div>
    `;
  }

  if (field.type === "tri_bool") {
    const currentValue =
      effectiveValue === true ? "true" : effectiveValue === false ? "false" : "";
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-generation-key="${_escAttr(field.key)}"
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
          data-generation-key="${_escAttr(field.key)}"
          data-value-type="text"
        >
          ${(field.options || [])
            .map(
              (item) => `
                <option value="${_escAttr(item.value)}" ${item.value === String(effectiveValue ?? "") ? "selected" : ""}>
                  ${_escHtml(item.label)}
                </option>
              `,
            )
            .join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "range") {
    const numValue = effectiveValue != null && effectiveValue !== "" ? Number(effectiveValue) : "";
    const displayValue = numValue !== "" ? numValue : field.min ?? 0;
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)} <span class="bme-range-value">${numValue !== "" ? numValue : "默认"}</span></label>
        <div class="bme-range-group">
          <input
            class="bme-range-input"
            type="range"
            min="${field.min ?? 0}"
            max="${field.max ?? 1}"
            step="${field.step ?? 0.01}"
            value="${displayValue}"
            data-generation-key="${_escAttr(field.key)}"
            data-value-type="number"
          />
          <input
            class="bme-config-input bme-range-number"
            type="number"
            min="${field.min ?? 0}"
            max="${field.max ?? 1}"
            step="${field.step ?? 0.01}"
            value="${_escAttr(numValue)}"
            placeholder="默认"
            data-generation-key="${_escAttr(field.key)}"
            data-value-type="number"
          />
        </div>
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
        value="${_escAttr(effectiveValue ?? "")}"
        placeholder="留空 = 跟随默认"
        data-generation-key="${_escAttr(field.key)}"
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
        data-rule-id="${_escAttr(rule.id)}"
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
          data-rule-id="${_escAttr(rule.id)}"
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
      <label>规则名称</label>
        <input
          class="bme-config-input"
          type="text"
          data-regex-rule-field="script_name"
          value="${_escAttr(rule.script_name || "")}"
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
      <label>查找正则 (find_regex)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="find_regex"
        placeholder="/pattern/g"
      >${_escHtml(rule.find_regex || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>替换文本 (replace_string)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="replace_string"
        placeholder="替换后的文本"
      >${_escHtml(rule.replace_string || "")}</textarea>
    </div>

    <div class="bme-config-row">
      <label>裁剪字符串 (trim_strings)</label>
      <textarea
        class="bme-config-textarea"
        data-regex-rule-field="trim_strings"
        placeholder="每行一个要裁掉的字符串"
      >${_escHtml(trimStrings)}</textarea>
    </div>

    <div class="bme-task-field-grid">
      <div class="bme-config-row">
        <label>最小深度</label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="min_depth"
          value="${_escAttr(rule.min_depth ?? 0)}"
        />
      </div>
      <div class="bme-config-row">
        <label>最大深度</label>
        <input
          class="bme-config-input"
          type="number"
          data-regex-rule-field="max_depth"
          value="${_escAttr(rule.max_depth ?? 9999)}"
        />
      </div>
    </div>

    <div class="bme-task-section-label">数据来源</div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">用户输入</span>
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
          <span class="bme-toggle-title">AI 输出</span>
          <span class="bme-toggle-desc">允许作用于 assistant / 输出侧文本。</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-source="ai_output"
          ${(rule.source?.ai_output ?? true) ? "checked" : ""}
        />
      </label>
    </div>

    <div class="bme-task-section-label">作用目标</div>
    <div class="bme-task-toggle-list">
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">Prompt 构建</span>
          <span class="bme-toggle-desc">应用到 prompt 输入构建链路。</span>
        </span>
        <input
          type="checkbox"
          data-regex-rule-destination="prompt"
          ${(rule.destination?.prompt ?? true) ? "checked" : ""}
        />
      </label>
      <label class="bme-toggle-item">
        <span class="bme-toggle-copy">
          <span class="bme-toggle-title">界面展示</span>
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
    // 直接重新编号，不要再 sort（否则会按旧 order 排回去）
    draft.blocks = blocks.map((block, i) => ({ ...block, order: i }));
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
    enabled: true,
    inheritStRegex: true,
    sources: {
      global: true,
      preset: true,
      character: true,
    },
    stages: {
      input: true,
      output: true,
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
      input: true,
      output: true,
      ...normalizeTaskRegexStages(draft.regex?.stages || {}),
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

function _downloadAllTaskProfiles(taskProfiles) {
  try {
    const taskTypes = getTaskTypeOptions().map((t) => t.id);
    const profiles = {};
    for (const taskType of taskTypes) {
      try {
        const exported = serializeTaskProfile(taskProfiles, taskType);
        profiles[taskType] = exported;
      } catch {
        // skip missing
      }
    }
    if (Object.keys(profiles).length === 0) {
      toastr.warning("没有可导出的预设", "ST-BME");
      return;
    }
    const payload = {
      format: "st-bme-all-task-profiles",
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = _sanitizeFileName("st-bme-all-profiles.json");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toastr.success(`已导出 ${Object.keys(profiles).length} 个任务预设`, "ST-BME");
  } catch (error) {
    console.error("[ST-BME] 导出全部预设失败:", error);
    toastr.error(`导出全部预设失败: ${error?.message || error}`, "ST-BME");
  }
}

function _cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function _helpTip(text) {
  if (!text) return "";
  return `<span class="bme-help-tip"><button type="button" class="bme-help-tip__trigger" aria-label="帮助">?</button><span class="bme-help-tip__bubble">${_escHtml(text)}</span></span>`;
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

function _getGraphPersistenceSnapshot() {
  return _getGraphPersistenceState?.() || {
    loadState: "no-chat",
    reason: "",
    writesBlocked: true,
    shadowSnapshotUsed: false,
    pendingPersist: false,
    chatId: "",
    storageMode: "indexeddb",
    dbReady: false,
    syncState: "idle",
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastSyncError: "",
  };
}

function _getGraphLoadLabel(loadState = "") {
  switch (loadState) {
    case "loading":
      return "正在加载当前聊天图谱";
    case "shadow-restored":
      return "已从本次会话临时恢复，正在等待正式聊天元数据";
    case "empty-confirmed":
      return "当前聊天还没有图谱";
    case "blocked":
      return "聊天元数据未就绪，已暂停图谱写回以保护旧数据";
    case "loaded":
      return "聊天图谱已加载";
    case "no-chat":
    default:
      return "当前尚未进入聊天";
  }
}

function _canRenderGraphData(loadInfo = _getGraphPersistenceSnapshot()) {
  return (
    loadInfo.dbReady === true ||
    loadInfo.loadState === "loaded" ||
    loadInfo.loadState === "empty-confirmed" ||
    loadInfo.shadowSnapshotUsed === true
  );
}

function _isGraphWriteBlocked(loadInfo = _getGraphPersistenceSnapshot()) {
  if (typeof loadInfo.dbReady === "boolean" && !loadInfo.dbReady) {
    return true;
  }
  return Boolean(loadInfo.writesBlocked);
}

function _renderStatefulListPlaceholder(listEl, text) {
  if (!listEl) return;
  const li = document.createElement("li");
  li.className = "bme-recent-item";
  const content = document.createElement("div");
  content.className = "bme-recent-text";
  content.style.color = "var(--bme-on-surface-dim)";
  content.textContent = text;
  li.appendChild(content);
  listEl.replaceChildren(li);
}

function _refreshGraphAvailabilityState() {
  const loadInfo = _getGraphPersistenceSnapshot();
  const banner = document.getElementById("bme-action-guard-banner");
  const graphOverlay = document.getElementById("bme-graph-overlay");
  const graphOverlayText = document.getElementById("bme-graph-overlay-text");
  const mobileOverlay = document.getElementById("bme-mobile-graph-overlay");
  const mobileOverlayText = document.getElementById("bme-mobile-graph-overlay-text");
  const blocked = _isGraphWriteBlocked(loadInfo);
  const loadLabel = _getGraphLoadLabel(loadInfo.loadState);

  GRAPH_WRITE_ACTION_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = blocked;
    button.classList.toggle("is-runtime-disabled", blocked);
    button.title = blocked ? loadLabel : "";
  });

  if (banner) {
    const shouldShowBanner = blocked;
    banner.hidden = !shouldShowBanner;
    banner.textContent = shouldShowBanner ? loadLabel : "";
  }

  const shouldShowOverlay =
    blocked ||
    loadInfo.syncState === "syncing" ||
    loadInfo.loadState === "loading" ||
    loadInfo.loadState === "shadow-restored" ||
    loadInfo.loadState === "blocked";

  if (graphOverlay) {
    graphOverlay.hidden = !shouldShowOverlay;
    graphOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (graphOverlayText) {
    graphOverlayText.textContent = shouldShowOverlay ? loadLabel : "";
  }
  if (mobileOverlay) {
    mobileOverlay.hidden = !shouldShowOverlay;
    mobileOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (mobileOverlayText) {
    mobileOverlayText.textContent = shouldShowOverlay ? loadLabel : "";
  }
}

function _refreshRuntimeStatus() {
  const runtimeStatus = _getRuntimeStatus?.() || {};
  const text = runtimeStatus.text || "待命";
  const meta = runtimeStatus.meta || "准备就绪";
  _setText("bme-status-text", text);
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", text);
  _refreshGraphAvailabilityState();
}

function _showActionProgressUi(label, meta = "请稍候…") {
  _setText("bme-status-text", `${label}中`);
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", `${label}中`);
  updateFloatingBallStatus("running", `${label}中`);
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

function _normalizeLlmPresetSettings(settings = _getSettings?.() || {}) {
  const normalized = sanitizeLlmPresetSettings(settings);

  if (!normalized.changed) {
    return settings;
  }

  return _patchSettings({
    llmPresets: normalized.presets,
    llmActivePreset: normalized.activePreset,
  }, {
    refreshTaskWorkspace: true,
  });
}

function _resolveAndPersistActiveLlmPreset(settings = _getSettings?.() || {}) {
  const normalizedSettings = _normalizeLlmPresetSettings(settings);
  const resolvedActivePreset = resolveActiveLlmPresetName(normalizedSettings);
  if (
    resolvedActivePreset !==
    String(normalizedSettings?.llmActivePreset || "")
  ) {
    return _patchSettings({ llmActivePreset: resolvedActivePreset });
  }
  return normalizedSettings;
}

function _getLlmConfigInputSnapshot() {
  const settings = _getSettings?.() || {};
  return {
    llmApiUrl: String(
      document.getElementById("bme-setting-llm-url")?.value ?? settings.llmApiUrl ?? "",
    ).trim(),
    llmApiKey: String(
      document.getElementById("bme-setting-llm-key")?.value ?? settings.llmApiKey ?? "",
    ).trim(),
    llmModel: String(
      document.getElementById("bme-setting-llm-model")?.value ?? settings.llmModel ?? "",
    ).trim(),
  };
}

function _populateLlmPresetSelect(presets = {}, activePreset = "") {
  const select = document.getElementById("bme-llm-preset-select");
  if (!select) return;

  while (select.options.length > 1) {
    select.remove(1);
  }

  Object.keys(presets)
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

  select.value = activePreset || "";
}

function _syncLlmPresetControls(activePreset = "") {
  const select = document.getElementById("bme-llm-preset-select");
  if (select) {
    select.value = activePreset || "";
  }

  const deleteBtn = document.getElementById("bme-llm-preset-delete");
  if (deleteBtn) {
    deleteBtn.disabled = !activePreset;
    deleteBtn.title = activePreset ? "删除当前模板" : "手动模式下没有可删除的模板";
  }
}

function _clearFetchedLlmModels() {
  fetchedMemoryLLMModels.length = 0;
  const modelSelect = document.getElementById("bme-select-llm-model");
  if (!modelSelect) return;
  while (modelSelect.options.length > 1) {
    modelSelect.remove(1);
  }
  modelSelect.value = "";
  modelSelect.style.display = "none";
}

function _markLlmPresetDirty(options = {}) {
  if (options.clearFetchedModels) {
    _clearFetchedLlmModels();
  }

  const settings = _resolveAndPersistActiveLlmPreset(_getSettings?.() || {});
  _syncLlmPresetControls(String(settings?.llmActivePreset || ""));
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

function _escAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function _safeCssToken(value, fallback = "unknown") {
  const token = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
}

function _matchesMemoryFilter(node, filter = "all") {
  if (!node || filter === "all") return true;
  const scope = normalizeMemoryScope(node.scope);
  switch (filter) {
    case "scope:objective":
      return scope.layer === "objective";
    case "scope:characterPov":
      return scope.layer === "pov" && scope.ownerType === "character";
    case "scope:userPov":
      return scope.layer === "pov" && scope.ownerType === "user";
    default:
      return node.type === filter;
  }
}

function _buildScopeMetaText(node) {
  const scope = normalizeMemoryScope(node?.scope);
  const parts = [];
  if (scope.layer === "pov") {
    parts.push(
      `${scope.ownerType === "user" ? "用户 POV" : "角色 POV"}: ${scope.ownerName || scope.ownerId || "未命名"}`,
    );
  }
  const regionLine = buildRegionLine(scope);
  if (regionLine) parts.push(regionLine);
  return parts.join(" · ");
}

/** 记忆列表等指标：避免浮点误差打出 9.499999999999998 */
function _formatMemoryMetricNumber(value, { fallback = 0, maxFrac = 2 } = {}) {
  const x =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isFinite(x)) return "—";
  const rounded = Number.parseFloat(x.toFixed(maxFrac));
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function _formatMemoryInt(value, fallback = 0) {
  const x =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isFinite(x)) return "—";
  return String(Math.trunc(x));
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
    pov_memory: "主观记忆",
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
