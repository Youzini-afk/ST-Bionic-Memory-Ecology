// ST-BME: 操控面板交互逻辑

import { GraphRenderer } from "./graph-renderer.js";
import {
  buildVisibleGraphRefreshToken,
  resolveVisibleGraphWorkspaceMode,
} from "./panel-graph-refresh-utils.js";
import {
  initPlannerSections,
  refreshPlannerSections,
} from "./panel-ena-sections.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import {
  buildRegionLine,
  buildScopeBadgeText,
  normalizeMemoryScope,
} from "../graph/memory-scope.js";
import { listKnowledgeOwners } from "../graph/knowledge-state.js";
import { getHostUserAliasHints } from "../runtime/user-alias-utils.js";
import {
  normalizeStoryTime,
  normalizeStoryTimeSpan,
} from "../graph/story-timeline.js";
import {
  compareSummaryEntriesForDisplay,
  getActiveSummaryEntries,
  getSummaryEntriesByStatus,
} from "../graph/summary-state.js";
import {
  resolveActiveLlmPresetName,
  resolveDedicatedLlmProviderConfig,
  sanitizeLlmPresetSettings,
} from "../llm/llm-preset-utils.js";
import {
  cloneTaskProfile,
  createDefaultGlobalTaskRegex,
  createBuiltinPromptBlock,
  createCustomPromptBlock,
  createLocalRegexRule,
  DEFAULT_TASK_BLOCKS,
  dedupeRegexRules,
  ensureTaskProfiles,
  exportTaskProfile as serializeTaskProfile,
  getBuiltinBlockDefinitions,
  getLegacyPromptFieldForTask,
  getTaskTypeOptions,
  importTaskProfile as parseImportedTaskProfile,
  isTaskRegexStageEnabled,
  migrateLegacyProfileRegexToGlobal,
  normalizeGlobalTaskRegex,
  normalizeTaskRegexStages,
  restoreDefaultTaskProfile,
  setActiveTaskProfileId,
  upsertTaskProfile,
} from "../prompting/prompt-profiles.js";
import { getNodeColors } from "./themes.js";
import {
  getSuggestedBackendModel,
  getVectorIndexStats,
} from "../vector/vector-index.js";

let defaultPromptCache = null;

function _refreshMemoryLlmProviderHelp(urlValue = null) {
  const helpEl = document.getElementById("bme-memory-llm-provider-help");
  if (!helpEl) return;

  const settings = _getSettings?.() || {};
  const rawUrl = String(
    urlValue ??
      document.getElementById("bme-setting-llm-url")?.value ??
      settings.llmApiUrl ??
      "",
  ).trim();

  if (!rawUrl) {
    helpEl.textContent =
      "留空时复用当前聊天模型。支持自动识别 OpenAI 兼容渠道、Anthropic Claude、Google AI Studio / Gemini；填写完整 endpoint 时会自动规整为可复用的 base URL。";
    return;
  }

  const resolved = resolveDedicatedLlmProviderConfig(rawUrl);
  const parts = [];

  if (resolved.isKnownProvider) {
    parts.push(`已识别渠道：${resolved.providerLabel || resolved.providerId || "未知渠道"}`);
  } else {
    parts.push("未识别为特定渠道，将按自定义 OpenAI 兼容接口处理");
  }

  if (resolved.transportLabel) {
    parts.push(`请求通道：${resolved.transportLabel}`);
  }

  if (resolved.apiUrl && resolved.apiUrl !== rawUrl) {
    parts.push(`规范化地址：${resolved.apiUrl}`);
  }

  if (resolved.supportsModelFetch !== true) {
    parts.push("该渠道暂不支持自动拉取模型，请手动填写模型名");
  }

  helpEl.textContent = parts.join("；");
}

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
  "bme-act-summary-rollup",
  "bme-act-summary-rebuild",
  "bme-act-evolve",
  "bme-act-undo-maintenance",
  "bme-act-import",
  "bme-act-rebuild",
  "bme-act-vector-rebuild",
  "bme-act-vector-range",
  "bme-act-vector-reembed",
  "bme-detail-delete",
  "bme-detail-save",
  "bme-cog-region-apply",
  "bme-cog-region-clear",
  "bme-cog-adjacency-save",
  "bme-cog-story-time-apply",
  "bme-cog-story-time-clear",
];

const TASK_PROFILE_GENERATION_GROUPS = [
  {
    title: "API 配置",
    excludeTaskTypes: ["planner"],
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

const TASK_PROFILE_INPUT_GROUPS = {
  synopsis: [
    {
      title: "总结输入",
      fields: [
        {
          key: "rawChatContextFloors",
          label: "额外原文上下文楼层",
          type: "number",
          defaultValue: 0,
          help: "在主消息范围之外额外补多少楼原文上下文，只影响小总结任务。",
        },
        {
          key: "rawChatSourceMode",
          label: "原文来源模式",
          type: "enum",
          options: [
            { value: "ignore_bme_hide", label: "忽略 BME 隐藏助手" },
          ],
          defaultValue: "ignore_bme_hide",
          help: "固定绕过 BME 自己的隐藏助手裁剪，只用于小总结原文读取。",
        },
      ],
    },
  ],
  summary_rollup: [
    {
      title: "折叠输入",
      fields: [
        {
          key: "rawChatSourceMode",
          label: "原文来源模式",
          type: "enum",
          options: [
            { value: "ignore_bme_hide", label: "忽略 BME 隐藏助手（仅保留兼容位）" },
          ],
          defaultValue: "ignore_bme_hide",
          help: "折叠总结默认不直接读取原文聊天；这里保留输入配置兼容位。",
        },
      ],
    },
  ],
};

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
let currentTaskSectionId = "pipeline";
let currentSelectedMemoryNodeId = "";
let taskMemorySearchDraft = _createTaskMemorySearchState();
let taskMemorySearchApplied = _createTaskMemorySearchState();
let currentTaskProfileTaskType = "extract";
let currentTaskProfileTabId = "generation";
let currentTaskProfileBlockId = "";
let currentTaskProfileDragBlockId = "";
let currentTaskProfileRuleId = "";
let currentTaskProfileDragRuleId = "";
let currentTaskProfileDragRuleIsGlobal = false;
let showGlobalRegexPanel = false;
let currentGlobalRegexRuleId = "";
let currentCognitionOwnerKey = "";
let currentGraphView = "graph";
let currentMobileGraphView = "graph";
let fetchedMemoryLLMModels = [];
let fetchedBackendEmbeddingModels = [];
let fetchedDirectEmbeddingModels = [];
let viewportSyncBound = false;
let popupRuntimePromise = null;
const GRAPH_LIVE_REFRESH_THROTTLE_MS = 240;
let pendingVisibleGraphRefreshTimer = null;
let pendingVisibleGraphRefreshToken = "";
let pendingVisibleGraphRefreshForce = false;
let lastVisibleGraphRefreshToken = "";
let lastVisibleGraphRefreshAt = 0;
let graphRenderingEnabled = true;

function _isPluginEnabled(settings = _getSettings?.() || {}) {
  return settings?.enabled !== false;
}

function _notifyPluginDisabled(actionLabel = "该操作") {
  toastr.info(
    `ST-BME 已关闭，暂时不能执行${actionLabel}。请先在配置页顶部打开“插件总开关”。`,
    "ST-BME",
  );
  _refreshRuntimeStatus();
}

function _ensurePluginEnabledForAction(actionLabel = "该操作") {
  if (_isPluginEnabled()) {
    return true;
  }
  _notifyPluginDisabled(actionLabel);
  return false;
}

// 由 index.js 注入的引用
let _getGraph = null;
let _getSettings = null;
let _getLastExtract = null;
let _getLastBatchStatus = null;
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
  const templateUrl = new URL(`./${templateName}.html`, import.meta.url);
  const response = await fetch(templateUrl.href, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Template request failed: ${templateUrl.pathname} (${response.status} ${response.statusText})`,
    );
  }
  const html = await response.text();
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error(`Template returned empty content: ${templateUrl.pathname}`);
  }
  return html;
}

async function getPopupRuntime() {
  if (!popupRuntimePromise) {
    popupRuntimePromise = import("../../../../popup.js");
  }
  return await popupRuntimePromise;
}

function _ensureCloudBackupManagerStyles() {
  if (document.getElementById("bme-cloud-backup-manager-styles")) return;
  const style = document.createElement("style");
  style.id = "bme-cloud-backup-manager-styles";
  style.textContent = `
    .bme-cloud-backup-modal {
      width: min(920px, 88vw);
      max-width: 100%;
      color: var(--SmartThemeBodyColor, #f2efe8);
    }
    .bme-cloud-backup-modal__header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 14px;
    }
    .bme-cloud-backup-modal__title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
    }
    .bme-cloud-backup-modal__subtitle {
      opacity: 0.78;
      line-height: 1.5;
      margin-top: 6px;
    }
    .bme-cloud-backup-modal__tools {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .bme-cloud-backup-modal__btn {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      background: var(--SmartThemeBlurTintColor, rgba(255,255,255,0.06));
      color: inherit;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .bme-cloud-backup-modal__btn:hover:not(:disabled) {
      border-color: rgba(255, 181, 71, 0.65);
    }
    .bme-cloud-backup-modal__btn:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .bme-cloud-backup-modal__list {
      display: grid;
      gap: 12px;
      max-height: 62vh;
      overflow: auto;
      padding-right: 4px;
    }
    .bme-cloud-backup-modal__empty,
    .bme-cloud-backup-modal__loading {
      border: 1px dashed var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      border-radius: 14px;
      padding: 18px;
      opacity: 0.85;
      text-align: center;
    }
    .bme-cloud-backup-card {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.18));
      border-radius: 14px;
      padding: 14px;
      background: rgba(255,255,255,0.03);
    }
    .bme-cloud-backup-card.is-current-chat {
      border-color: rgba(255, 181, 71, 0.78);
      box-shadow: 0 0 0 1px rgba(255, 181, 71, 0.22) inset;
    }
    .bme-cloud-backup-card__top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .bme-cloud-backup-card__title {
      font-size: 16px;
      font-weight: 700;
      word-break: break-all;
    }
    .bme-cloud-backup-card__badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(255, 181, 71, 0.18);
      color: #ffcd73;
      flex-shrink: 0;
    }
    .bme-cloud-backup-card__meta {
      display: grid;
      gap: 4px;
      font-size: 13px;
      opacity: 0.86;
      margin-bottom: 10px;
    }
    .bme-cloud-backup-card__filename {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      opacity: 0.75;
      word-break: break-all;
      margin-bottom: 12px;
    }
    .bme-cloud-backup-card__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .bme-cloud-backup-card__danger {
      border-color: rgba(255, 99, 99, 0.45);
    }
    .bme-cloud-backup-card__danger:hover:not(:disabled) {
      border-color: rgba(255, 99, 99, 0.72);
    }
    @media (max-width: 720px) {
      .bme-cloud-backup-modal__header {
        flex-direction: column;
      }
      .bme-cloud-backup-modal__tools {
        justify-content: flex-start;
      }
      .bme-cloud-backup-card__top {
        flex-direction: column;
      }
    }
  `;
  document.head?.appendChild(style);
}

function mountPanelHtml(html) {
  const markup = String(html || "").trim();
  if (!markup) {
    throw new Error("Panel template markup is empty");
  }

  if (document.body?.insertAdjacentHTML) {
    document.body.insertAdjacentHTML("beforeend", markup);
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
    if (!_isMobile() && currentTabId === "graph") {
      _switchTab("dashboard");
    }
  };
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
}

function _getVisibleGraphWorkspaceMode() {
  return resolveVisibleGraphWorkspaceMode({
    overlayActive: overlayEl?.classList.contains("active") === true,
    isMobile: _isMobile(),
    currentTabId,
    currentGraphView,
    currentMobileGraphView,
  });
}

function _getCurrentGraphRefreshToken() {
  const graph = _getGraph?.();
  const persistence = _getGraphPersistenceSnapshot();
  return buildVisibleGraphRefreshToken({
    visibleMode: _getVisibleGraphWorkspaceMode(),
    chatId: persistence?.chatId,
    loadState: persistence?.loadState,
    revision:
      persistence?.revision ??
      persistence?.lastAcceptedRevision ??
      persistence?.lastSyncedRevision ??
      0,
    nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : -1,
    edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : -1,
    lastProcessedSeq: graph?.historyState?.lastProcessedAssistantFloor ?? -1,
  });
}

function _clearScheduledVisibleGraphRefresh() {
  if (pendingVisibleGraphRefreshTimer) {
    clearTimeout(pendingVisibleGraphRefreshTimer);
    pendingVisibleGraphRefreshTimer = null;
  }
  pendingVisibleGraphRefreshToken = "";
  pendingVisibleGraphRefreshForce = false;
}

function _isGraphRenderingEnabled() {
  return graphRenderingEnabled !== false;
}

function _buildGraphRuntimeConfig(settings = _getSettings?.() || {}) {
  return {
    graphUseNativeLayout: settings.graphUseNativeLayout === true,
    graphNativeLayoutThresholdNodes: Number.isFinite(
      Number(settings.graphNativeLayoutThresholdNodes),
    )
      ? Math.max(1, Math.floor(Number(settings.graphNativeLayoutThresholdNodes)))
      : 280,
    graphNativeLayoutThresholdEdges: Number.isFinite(
      Number(settings.graphNativeLayoutThresholdEdges),
    )
      ? Math.max(1, Math.floor(Number(settings.graphNativeLayoutThresholdEdges)))
      : 1600,
    graphNativeLayoutWorkerTimeoutMs: Number.isFinite(
      Number(settings.graphNativeLayoutWorkerTimeoutMs),
    )
      ? Math.max(40, Math.floor(Number(settings.graphNativeLayoutWorkerTimeoutMs)))
      : 260,
    nativeEngineFailOpen: settings.nativeEngineFailOpen !== false,
    graphNativeForceDisable: settings.graphNativeForceDisable === true,
  };
}

function _applyGraphRuntimeConfig(settings = _getSettings?.() || {}) {
  const runtimeConfig = _buildGraphRuntimeConfig(settings);
  graphRenderer?.setRuntimeConfig?.(runtimeConfig);
  mobileGraphRenderer?.setRuntimeConfig?.(runtimeConfig);
  return runtimeConfig;
}

function _refreshGraphRenderToggleUi() {
  const enabled = _isGraphRenderingEnabled();
  const syncButton = (button) => {
    if (!button) return;
    const title = enabled ? "暂停图谱渲染" : "恢复图谱渲染";
    button.classList.toggle("is-paused", !enabled);
    button.classList.toggle("is-active", enabled);
    button.title = title;
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    const icon = button.querySelector("i");
    if (icon) {
      icon.className = enabled ? "fa-solid fa-pause" : "fa-solid fa-play";
    }
  };
  syncButton(document.getElementById("bme-graph-render-toggle"));
  syncButton(document.getElementById("bme-mobile-render-toggle"));
}

function _applyGraphRenderEnabledState({ forceRefresh = false } = {}) {
  const enabled = _isGraphRenderingEnabled();
  graphRenderer?.setEnabled?.(enabled);
  mobileGraphRenderer?.setEnabled?.(enabled);
  _refreshGraphRenderToggleUi();
  if (!enabled) {
    _clearScheduledVisibleGraphRefresh();
    return;
  }
  if (forceRefresh) {
    _scheduleVisibleGraphWorkspaceRefresh({ force: true });
  }
}

function _toggleGraphRenderingEnabled() {
  graphRenderingEnabled = !_isGraphRenderingEnabled();
  _applyGraphRenderEnabledState({ forceRefresh: graphRenderingEnabled });
  _refreshGraphAvailabilityState();
}

function _refreshVisibleGraphWorkspace({ force = false } = {}) {
  const visibleMode = _getVisibleGraphWorkspaceMode();
  if (visibleMode === "hidden") {
    _refreshGraphLayoutDiagnosticsUi();
    return { refreshed: false, reason: "hidden" };
  }

  const graph = _getGraph?.();
  const nextToken = _getCurrentGraphRefreshToken();
  if (!force && nextToken === lastVisibleGraphRefreshToken) {
    return { refreshed: false, reason: "unchanged", token: nextToken };
  }

  const hints = { userPovAliases: _hostUserPovAliasHintsForGraph() };
  if (visibleMode === "desktop:graph") {
    if (graph && graphRenderer) {
      graphRenderer.loadGraph(graph, hints);
    }
  } else if (visibleMode === "desktop:cognition") {
    _refreshCognitionWorkspace();
  } else if (visibleMode === "desktop:summary") {
    _refreshSummaryWorkspace();
  } else if (visibleMode === "mobile:graph") {
    if (graph && mobileGraphRenderer) {
      mobileGraphRenderer.loadGraph(graph, hints);
    }
    _buildMobileLegend();
  } else if (visibleMode === "mobile:cognition") {
    _refreshMobileCognitionFull();
  } else if (visibleMode === "mobile:summary") {
    _refreshMobileSummaryFull();
  }

  _refreshGraphLayoutDiagnosticsUi();

  lastVisibleGraphRefreshToken = nextToken;
  lastVisibleGraphRefreshAt = Date.now();
  return {
    refreshed: true,
    reason: force ? "forced" : "changed",
    token: nextToken,
    visibleMode,
  };
}

function _flushScheduledVisibleGraphRefresh() {
  const shouldForce = pendingVisibleGraphRefreshForce === true;
  _clearScheduledVisibleGraphRefresh();
  return _refreshVisibleGraphWorkspace({ force: shouldForce });
}

function _scheduleVisibleGraphWorkspaceRefresh({ force = false } = {}) {
  const nextToken = _getCurrentGraphRefreshToken();
  if (nextToken === "hidden") {
    _clearScheduledVisibleGraphRefresh();
    return { scheduled: false, reason: "hidden" };
  }

  if (force) {
    _clearScheduledVisibleGraphRefresh();
    return _refreshVisibleGraphWorkspace({ force: true });
  }

  if (nextToken === lastVisibleGraphRefreshToken) {
    return { scheduled: false, reason: "unchanged", token: nextToken };
  }

  if (
    pendingVisibleGraphRefreshTimer &&
    pendingVisibleGraphRefreshToken === nextToken &&
    pendingVisibleGraphRefreshForce !== true
  ) {
    return { scheduled: true, reason: "pending", token: nextToken };
  }

  const delay = Math.max(
    0,
    GRAPH_LIVE_REFRESH_THROTTLE_MS - (Date.now() - lastVisibleGraphRefreshAt),
  );
  pendingVisibleGraphRefreshToken = nextToken;
  pendingVisibleGraphRefreshForce = false;

  if (pendingVisibleGraphRefreshTimer) {
    clearTimeout(pendingVisibleGraphRefreshTimer);
    pendingVisibleGraphRefreshTimer = null;
  }

  if (delay <= 0) {
    return _flushScheduledVisibleGraphRefresh();
  }

  pendingVisibleGraphRefreshTimer = setTimeout(() => {
    _flushScheduledVisibleGraphRefresh();
  }, delay);

  return {
    scheduled: true,
    reason: "throttled",
    token: nextToken,
    delay,
  };
}

/**
 * 初始化面板（由 index.js 调用一次）
 */
export async function initPanel({
  getGraph,
  getSettings,
  getLastExtract,
  getLastBatchStatus,
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
  _getLastBatchStatus = getLastBatchStatus;
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
  _bindMemoryPopup();
  _bindResizeHandle();
  _bindPanelResize();
  _bindGraphControls();
  _bindActions();
  _bindDashboardControls();
  _bindConfigControls();
  _bindTaskNavigation();
  _bindPlannerLauncher();
  currentTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || "dashboard";
  _applyWorkspaceMode();
  _syncConfigSectionState();
  _syncTaskSectionState();
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
  let fab = document.getElementById("bme-floating-ball");
  if (!fab) {
    fab = document.createElement("div");
    fab.id = "bme-floating-ball";
    fab.setAttribute("data-status", "idle");
    fab.innerHTML = `
      <i class="fa-solid fa-brain bme-fab-icon"></i>
      <span class="bme-fab-tooltip">BME 记忆图谱</span>
    `;
  } else if (!fab.querySelector(".bme-fab-icon")) {
    fab.innerHTML = `
      <i class="fa-solid fa-brain bme-fab-icon"></i>
      <span class="bme-fab-tooltip">BME 记忆图谱</span>
    `;
  }
  _fabEl = fab;
  ensureFabMountedAtRoot();

  // 应用可见性
  if (!_getFabVisible()) fab.style.display = "none";

  // 恢复位置
  const saved = _loadFabPosition();
  if (saved) {
    fab.dataset.positionMode = "saved";
    applyFabPosition(saved, fab);
  } else if (!fab.style.left || !fab.style.top) {
    fab.dataset.positionMode = "default";
    syncFabPosition();
  }

  if (fab.dataset.bmeFabBound === "true") {
    return;
  }
  fab.dataset.bmeFabBound = "true";
  delete fab.dataset.bmeBootstrap;

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
  if (!_actionHandlers.extractTask) return;
  if (!_ensurePluginEnabledForAction("重新提取")) return;

  try {
    _fabEl?.setAttribute("data-status", "running");
    await _actionHandlers.extractTask({ mode: "rerun" });
    _fabEl?.setAttribute("data-status", "success");
    _refreshDashboard();
    _refreshGraph();
    setTimeout(() => {
      const status = _getRuntimeStatus?.() || {};
      _fabEl?.setAttribute("data-status", status.status || "idle");
    }, 3000);
  } catch (err) {
    console.error("[ST-BME] FAB extract task failed:", err);
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
    runtimeConfig: _buildGraphRuntimeConfig(settings),
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

  _applyGraphRuntimeConfig(settings);

  _applyGraphRenderEnabledState();

  const activeTabId =
    panelEl?.querySelector(".bme-tab-btn.active")?.dataset.tab || currentTabId;
  _switchTab(activeTabId);
  _refreshRuntimeStatus();
  _buildLegend();
}

/**
 * 关闭面板
 */
export function closePanel() {
  if (!overlayEl) return;
  overlayEl.classList.remove("active");
  _closeMemoryPopup();
  _clearScheduledVisibleGraphRefresh();
  lastVisibleGraphRefreshToken = "";
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
  _applyGraphRuntimeConfig(_getSettings?.() || {});
  _refreshRuntimeStatus();
  _refreshNativeRolloutStatusUi(_getSettings?.() || {});

  switch (currentTabId) {
    case "dashboard":
      _refreshDashboard();
      break;
    case "task":
      _refreshTaskMonitor();
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

  _scheduleVisibleGraphWorkspaceRefresh();
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
  const previousVisibleGraphMode = _getVisibleGraphWorkspaceMode();
  let next = tabId || "dashboard";
  // 「图谱」仅移动端底部 Tab 可用；桌面端图谱在右侧主工作区，侧栏不设该 Tab
  if (!_isMobile() && next === "graph") {
    next = "dashboard";
  }
  currentTabId = next;
  _closeNodeDetailUi();
  _closeMemoryPopup();
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
    case "task":
      _refreshTaskMonitor();
      break;
    case "config":
      _refreshConfigTab();
      break;
    case "graph":
      break;
    default:
      break;
  }

  const nextVisibleGraphMode = _getVisibleGraphWorkspaceMode();
  if (nextVisibleGraphMode !== previousVisibleGraphMode) {
    _scheduleVisibleGraphWorkspaceRefresh({ force: true });
  } else {
    _scheduleVisibleGraphWorkspaceRefresh();
  }
}

function _refreshPlannerLauncher() {
  try {
    refreshPlannerSections({
      getSettings: _getSettings,
    });
  } catch (err) {
    console.warn("[ST-BME] planner section refresh failed:", err);
  }
}

function _bindPlannerLauncher() {
  try {
    initPlannerSections(panelEl || document, {
      getSettings: _getSettings,
    });
  } catch (err) {
    console.warn("[ST-BME] planner section init failed:", err);
  }
}

function _applyWorkspaceMode() {
  if (!panelEl) return;
  const isConfig = currentTabId === "config";
  const isTask = currentTabId === "task";
  panelEl.classList.toggle("config-mode", isConfig);
  panelEl.classList.toggle("task-mode", isTask);
}

// ==================== 任务监控工作区 ====================

const TASK_SECTION_META = {
  pipeline: { kicker: "管线总览", title: "管线总览", desc: "实时查看所有任务管线的运行状态与当前批次进度。" },
  timeline: { kicker: "任务流水", title: "任务流水", desc: "按时间轴追踪每次提取、召回、向量索引等任务的执行记录。" },
  memory: { kicker: "记忆浏览", title: "记忆浏览", desc: "浏览和检索图谱中的所有记忆节点。" },
  injection: { kicker: "注入预览", title: "注入预览", desc: "查看最近一次注入到主 AI 的内容预览与 token 用量。" },
  trace: { kicker: "消息追踪", title: "消息追踪", desc: "这一轮到底发了什么？查看召回注入快照和提取请求详情。" },
  persistence: { kicker: "持久化", title: "持久化状态", desc: "图谱加载状态、存储层级、commit marker 与修复操作。" },
};

function _bindTaskNavigation() {
  panelEl?.querySelectorAll(".bme-task-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _switchTaskSection(btn.dataset.taskSection);
    });
  });
  panelEl?.querySelectorAll(".bme-task-nav-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      _switchTaskSection(btn.dataset.taskSection);
    });
  });
}

function _switchTaskSection(sectionId) {
  currentTaskSectionId = sectionId || "pipeline";
  _closeMemoryPopup();
  _syncTaskSectionState();
  _refreshTaskMonitor();
}

function _syncTaskSectionState() {
  panelEl?.querySelectorAll(".bme-task-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.taskSection === currentTaskSectionId);
  });
  panelEl?.querySelectorAll(".bme-task-nav-pill").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.taskSection === currentTaskSectionId);
  });
  panelEl?.querySelectorAll(".bme-task-section").forEach((section) => {
    section.classList.toggle("active", section.dataset.taskSection === currentTaskSectionId);
  });
  const meta = TASK_SECTION_META[currentTaskSectionId] || TASK_SECTION_META.pipeline;
  const kicker = document.getElementById("bme-task-ws-kicker");
  const title = document.getElementById("bme-task-ws-title");
  const desc = document.getElementById("bme-task-ws-desc");
  if (kicker) kicker.textContent = meta.kicker;
  if (title) title.textContent = meta.title;
  if (desc) desc.textContent = meta.desc;
}

function _refreshTaskMonitor() {
  switch (currentTaskSectionId) {
    case "pipeline":
      _refreshTaskPipelineOverview();
      break;
    case "timeline":
      _refreshTaskTimeline();
      break;
    case "memory":
      _refreshTaskMemoryBrowser();
      break;
    case "injection":
      _refreshTaskInjectionPreview();
      break;
    case "trace":
      _refreshTaskMessageTrace();
      break;
    case "persistence":
      _refreshTaskPersistence();
      break;
  }
}

// ---------- Pipeline Overview ----------

function _resolvePipelineStatus(statusObj) {
  if (!statusObj) return { label: "UNKNOWN", color: "amber", detail: "—" };
  const text = String(statusObj.text || "");
  const meta = String(statusObj.meta || "");
  const level = String(statusObj.level || "info");
  let color = "green";
  if (level === "warn") color = "amber";
  else if (level === "error") color = "red";
  else if (text.toLowerCase().includes("running") || text.toLowerCase().includes("进行中") || text.includes("正在")) color = "cyan";
  return { label: text || "IDLE", color, detail: meta };
}

function _readPersistenceDiagnosticObject(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  return snapshot;
}

function _formatNativeHydrateGateReasonText(reasons = []) {
  const labels = {
    "below-min-snapshot-records": "记录数不足",
  };
  const normalized = Array.isArray(reasons)
    ? reasons.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!normalized.length) return "—";
  return normalized.map((item) => labels[item] || item).join(" · ");
}

function _formatNativeHydrateGateText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") return "—";
  if (diagnostics.hydrateNativeRequested !== true) return "未请求 native";
  if (diagnostics.hydrateNativeForceDisabled === true) return "已强制关闭";
  if (diagnostics.hydrateNativeGateAllowed === true) return "通过";
  return `已拦截 · ${_formatNativeHydrateGateReasonText(diagnostics.hydrateNativeGateReasons)}`;
}

function _formatNativeHydrateResultText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") return "暂无";
  if (diagnostics.hydrateNativeRequested !== true) return "未请求 native";
  if (diagnostics.hydrateNativeForceDisabled === true) return "已强制关闭";
  if (diagnostics.hydrateNativeGateAllowed !== true) return "已拦截";
  if (diagnostics.hydrateNativeUsed === true) {
    const status = String(diagnostics.hydrateNativeStatus || "").trim();
    return status ? `已命中 · ${status}` : "已命中";
  }
  const fallbackReason =
    String(diagnostics.hydrateNativeStatus || "").trim() ||
    String(diagnostics.hydrateNativePreloadStatus || "").trim() ||
    "js";
  return `已回退 · ${fallbackReason}`;
}

function _formatNativeHydrateModuleText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") return "—";
  const parts = [];
  const preload = String(diagnostics.hydrateNativePreloadStatus || "").trim();
  const source = String(diagnostics.hydrateNativeModuleSource || "").trim();
  if (preload) parts.push(`preload ${preload}`);
  if (diagnostics.hydrateNativeModuleLoaded === true) parts.push("loaded");
  if (source) parts.push(source);
  return parts.join(" · ") || "—";
}

function _formatNativeLayoutStatusSummary(layout = null, settings = _getSettings?.() || {}) {
  if (settings.graphNativeForceDisable === true) return "已强制关闭";
  if (settings.graphUseNativeLayout !== true) return "已关闭";
  if (!layout || typeof layout !== "object") return "暂无最近布局诊断";
  const parts = [String(layout.mode || layout.solver || "unknown").trim() || "unknown"];
  const totalText = _formatDurationMs(layout.totalMs);
  const moduleSource = String(layout.moduleSource || "").trim();
  const reason = String(layout.reason || "").trim();
  if (totalText !== "—") parts.push(totalText);
  if (moduleSource) parts.push(moduleSource);
  if (reason && reason !== parts[0]) parts.push(reason);
  return parts.join(" · ");
}

function _formatNativePersistStatusSummary(diagnostics = null, settings = _getSettings?.() || {}) {
  if (settings.graphNativeForceDisable === true) return "已强制关闭";
  if (settings.persistUseNativeDelta !== true) return "已关闭";
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "暂无最近写回诊断";
  const parts = [String(snapshot.path || "pending")];
  const gateText = String(_formatPersistDeltaGateText(snapshot) || "").trim();
  const fallbackReason = String(snapshot.fallbackReason || "").trim();
  if (gateText && gateText !== "—") parts.push(gateText);
  if (fallbackReason) parts.push(`回退 ${fallbackReason}`);
  return parts.join(" · ");
}

function _formatNativeHydrateStatusSummary(diagnostics = null, settings = _getSettings?.() || {}) {
  if (settings.graphNativeForceDisable === true) return "已强制关闭";
  if (settings.loadUseNativeHydrate !== true) return "已关闭";
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "暂无最近加载诊断";
  const parts = [_formatNativeHydrateResultText(snapshot)];
  const gateText = String(_formatNativeHydrateGateText(snapshot) || "").trim();
  const preload = String(snapshot.hydrateNativePreloadStatus || "").trim();
  if (gateText && gateText !== "—" && gateText !== "通过") parts.push(gateText);
  if (preload && preload !== "loaded" && preload !== "not-requested") {
    parts.push(`preload ${preload}`);
  }
  return Array.from(new Set(parts.filter(Boolean))).join(" · ");
}

function _refreshNativeRolloutStatusUi(
  settings = _getSettings?.() || {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const summaryEl = document.getElementById("bme-native-rollout-status");
  const layoutEl = document.getElementById("bme-native-layout-status");
  const persistEl = document.getElementById("bme-native-persist-status");
  const hydrateEl = document.getElementById("bme-native-hydrate-status");
  if (!summaryEl && !layoutEl && !persistEl && !hydrateEl) return;

  const panelDebug = _getRuntimeDebugSnapshot?.() || {};
  const runtimeDebug = panelDebug.runtimeDebug || {};
  const layout = runtimeDebug?.graphLayout || null;
  const persistDelta = _readPersistenceDiagnosticObject(
    loadInfo?.persistDelta || runtimeDebug?.graphPersistence?.persistDelta,
  );
  const loadDiagnostics = _readPersistenceDiagnosticObject(
    loadInfo?.loadDiagnostics || runtimeDebug?.graphPersistence?.loadDiagnostics,
  );
  const rolloutVersion = Math.max(
    0,
    Math.floor(Number(settings?.nativeRolloutVersion || 0)),
  );
  const summaryText = settings.graphNativeForceDisable === true
    ? `rollout v${rolloutVersion} · 全局强制关闭 · ${settings.nativeEngineFailOpen !== false ? "fail-open 已启用" : "严格模式"}`
    : `rollout v${rolloutVersion} · 按阈值自动尝试 native · ${settings.nativeEngineFailOpen !== false ? "fail-open 已启用" : "严格模式"}`;
  if (summaryEl) summaryEl.textContent = summaryText;
  if (layoutEl) {
    layoutEl.textContent = `Layout：${_formatNativeLayoutStatusSummary(layout, settings)}`;
  }
  if (persistEl) {
    persistEl.textContent = `Persist：${_formatNativePersistStatusSummary(persistDelta, settings)}`;
  }
  if (hydrateEl) {
    hydrateEl.textContent = `Hydrate：${_formatNativeHydrateStatusSummary(loadDiagnostics, settings)}`;
  }
}

function _formatLoadDiagnosticsStageLabel(stage = "") {
  const normalized = String(stage || "").trim();
  if (!normalized) return "—";
  const labels = {
    "load-indexeddb": "IndexedDB 加载",
    "apply-indexeddb-snapshot": "快照应用",
  };
  return labels[normalized] || normalized;
}

function _formatPipelineLoadDiagnosticsMeta(loadDiagnostics = null) {
  const diagnostics = _readPersistenceDiagnosticObject(loadDiagnostics);
  if (!diagnostics) return "";
  const totalText = _formatDurationMs(diagnostics.totalMs);
  if (totalText !== "—") return `load ${totalText}`;
  const stageLabel = _formatLoadDiagnosticsStageLabel(diagnostics.stage);
  return stageLabel === "—" ? "" : stageLabel;
}

function _formatPipelinePersistDeltaMeta(persistDelta = null) {
  const diagnostics = _readPersistenceDiagnosticObject(persistDelta);
  if (!diagnostics) return "";

  const parts = [];
  const totalText = _formatDurationMs(diagnostics.totalMs || diagnostics.buildMs);
  if (totalText !== "—") {
    parts.push(`delta ${totalText}`);
  }

  const gateText = String(_formatPersistDeltaGateText(diagnostics) || "").trim();
  if (gateText) {
    const compactGate = gateText.startsWith("已拦截") ? "已拦截" : gateText;
    parts.push(`native ${compactGate}`);
  }

  return parts.join(" · ");
}

function _formatPersistenceLoadSummary(loadDiagnostics = null) {
  const diagnostics = _readPersistenceDiagnosticObject(loadDiagnostics);
  if (!diagnostics) return "暂无";

  const statusText =
    diagnostics.success === true
      ? "成功"
      : diagnostics.success === false
        ? "失败"
        : "未知";
  const totalText = _formatDurationMs(diagnostics.totalMs);
  const stageLabel = _formatLoadDiagnosticsStageLabel(diagnostics.stage);
  const reasonText = String(diagnostics.reason || "").trim();
  const parts = [statusText];
  if (stageLabel !== "—") parts.push(stageLabel);
  if (totalText !== "—") parts.push(`total ${totalText}`);
  if (diagnostics.hydrateNativeRequested === true) {
    parts.push(`native ${_formatNativeHydrateResultText(diagnostics)}`);
  }
  if (reasonText) parts.push(reasonText);
  return parts.join(" · ");
}

function _formatPersistencePersistDeltaSummary(persistDelta = null) {
  const diagnostics = _readPersistenceDiagnosticObject(persistDelta);
  if (!diagnostics) return "暂无";

  const pathText = String(diagnostics.path || "").trim() || "—";
  const totalText = _formatDurationMs(diagnostics.totalMs || diagnostics.buildMs);
  const commitText = _formatDurationMs(diagnostics.commitMs);
  const gateText = String(_formatPersistDeltaGateText(diagnostics) || "").trim();
  const parts = [pathText];
  if (totalText !== "—") parts.push(totalText);
  if (commitText !== "—") parts.push(`commit ${commitText}`);
  if (gateText) parts.push(`native ${gateText}`);
  return parts.join(" · ");
}

function _formatPersistCommitPhaseText(diagnostics = null) {
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "—";
  const queueText = _formatDurationMs(snapshot.commitQueueWaitMs);
  const commitText = _formatDurationMs(snapshot.commitMs);
  if (queueText === "—" && commitText === "—") return "—";
  return `${queueText} / ${commitText}`;
}

function _formatPersistCommitBreakdownText(diagnostics = null) {
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "—";
  const parts = [
    snapshot.commitTxMs ? `tx ${_formatDurationMs(snapshot.commitTxMs)}` : "",
    snapshot.commitSnapshotReadMs
      ? `snapshot-read ${_formatDurationMs(snapshot.commitSnapshotReadMs)}`
      : "",
    snapshot.commitSnapshotWriteMs
      ? `snapshot-write ${_formatDurationMs(snapshot.commitSnapshotWriteMs)}`
      : "",
    snapshot.commitManifestReadMs
      ? `manifest-read ${_formatDurationMs(snapshot.commitManifestReadMs)}`
      : "",
    snapshot.commitWalSerializeMs
      ? `wal-serialize ${_formatDurationMs(snapshot.commitWalSerializeMs)}`
      : "",
    snapshot.commitWalFileWriteMs
      ? `wal-file ${_formatDurationMs(snapshot.commitWalFileWriteMs)}`
      : snapshot.commitWalWriteMs
        ? `wal ${_formatDurationMs(snapshot.commitWalWriteMs)}`
        : "",
    snapshot.commitManifestSerializeMs
      ? `manifest-serialize ${_formatDurationMs(snapshot.commitManifestSerializeMs)}`
      : "",
    snapshot.commitManifestFileWriteMs
      ? `manifest-file ${_formatDurationMs(snapshot.commitManifestFileWriteMs)}`
      : snapshot.commitManifestWriteMs
        ? `manifest-write ${_formatDurationMs(snapshot.commitManifestWriteMs)}`
        : "",
    snapshot.commitCacheApplyMs
      ? `cache ${_formatDurationMs(snapshot.commitCacheApplyMs)}`
      : "",
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function _formatPersistSnapshotBuildBreakdownText(diagnostics = null) {
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "—";
  const parts = [
    snapshot.snapshotNodesMs
      ? `nodes ${_formatDurationMs(snapshot.snapshotNodesMs)}`
      : "",
    snapshot.snapshotEdgesMs
      ? `edges ${_formatDurationMs(snapshot.snapshotEdgesMs)}`
      : "",
    snapshot.snapshotTombstonesMs
      ? `tombstones ${_formatDurationMs(snapshot.snapshotTombstonesMs)}`
      : "",
    snapshot.snapshotStateMs
      ? `state ${_formatDurationMs(snapshot.snapshotStateMs)}`
      : "",
    snapshot.snapshotMetaMs
      ? `meta ${_formatDurationMs(snapshot.snapshotMetaMs)}`
      : "",
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function _formatLoadHydrateBreakdownText(diagnostics = null) {
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "—";
  const parts = [
    snapshot.hydrateNodesMs
      ? `nodes ${_formatDurationMs(snapshot.hydrateNodesMs)}`
      : "",
    snapshot.hydrateEdgesMs
      ? `edges ${_formatDurationMs(snapshot.hydrateEdgesMs)}`
      : "",
    snapshot.hydrateRuntimeMetaMs
      ? `meta ${_formatDurationMs(snapshot.hydrateRuntimeMetaMs)}`
      : "",
    snapshot.hydrateStateMs
      ? `state ${_formatDurationMs(snapshot.hydrateStateMs)}`
      : "",
    snapshot.hydrateNormalizeMs
      ? `normalize ${_formatDurationMs(snapshot.hydrateNormalizeMs)}`
      : "",
    snapshot.hydrateIntegrityMs
      ? `integrity ${_formatDurationMs(snapshot.hydrateIntegrityMs)}`
      : "",
  ].filter(Boolean);
  return parts.join(" · ") || "—";
}

function _formatPersistObservabilityText(diagnostics = null) {
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "—";
  const parts = [];
  const pathKey = String(snapshot.pathKey || snapshot.path || "").trim();
  const reasonKey = String(snapshot.reasonKey || snapshot.saveReason || "").trim();
  const pathCount = Number(snapshot.pathSampleCount || 0);
  const reasonCount = Number(snapshot.reasonSampleCount || 0);
  if (pathKey) parts.push(`path ${pathKey}`);
  if (pathCount > 0) parts.push(`${pathCount} samples`);
  if (reasonKey) parts.push(`reason ${reasonKey}`);
  if (reasonCount > 0) parts.push(`${reasonCount} reason-hits`);
  return parts.join(" · ") || "—";
}

function _formatPersistCommitBytesText(diagnostics = null) {
  const snapshot = _readPersistenceDiagnosticObject(diagnostics);
  if (!snapshot) return "—";
  const parts = [];
  const payloadText = _formatDataSizeBytes(snapshot.commitPayloadBytes);
  const walText = _formatDataSizeBytes(snapshot.commitWalBytes);
  const metaKeyCount = Number(snapshot.commitRuntimeMetaKeyCount || 0);
  if (payloadText !== "—") parts.push(`payload ${payloadText}`);
  if (walText !== "—") parts.push(`wal ${walText}`);
  if (metaKeyCount > 0) parts.push(`meta ${metaKeyCount} keys`);
  return parts.join(" · ") || "—";
}

function _buildLoadDiagnosticRows(loadDiagnostics = null) {
  const diagnostics = _readPersistenceDiagnosticObject(loadDiagnostics);
  if (!diagnostics) {
    return [["Load 诊断", "无"]];
  }

  const statusText =
    diagnostics.success === true
      ? "成功"
      : diagnostics.success === false
        ? "失败"
        : "未知";
  const updatedAtText = diagnostics.updatedAt
    ? _formatTaskProfileTime(diagnostics.updatedAt)
    : "—";
  const nativeErrorText = String(
    diagnostics.hydrateNativeModuleError ||
      diagnostics.hydrateNativePreloadError ||
      diagnostics.hydrateNativeError ||
      "",
  ).trim();

  return [
    ["Load 阶段", _formatLoadDiagnosticsStageLabel(diagnostics.stage)],
    ["Load 来源", String(diagnostics.source || diagnostics.statusLabel || "—")],
    ["Load 状态", statusText],
    ["Load 原因", String(diagnostics.reason || "—")],
    ["Load 总耗时", _formatDurationMs(diagnostics.totalMs)],
    ["Load 前置", _formatDurationMs(diagnostics.preApplyMs)],
    ["导出快照", _formatDurationMs(diagnostics.exportSnapshotMs)],
    ["前置（除导出）", _formatDurationMs(diagnostics.preApplyOtherMs)],
    ["Hydrate", _formatDurationMs(diagnostics.hydrateMs)],
    ["Hydrate 细分", _formatLoadHydrateBreakdownText(diagnostics)],
    ["Hydrate Native Gate", _formatNativeHydrateGateText(diagnostics)],
    ["Hydrate Native 结果", _formatNativeHydrateResultText(diagnostics)],
    ["Hydrate Native Module", _formatNativeHydrateModuleText(diagnostics)],
    ["Hydrate Native Records", _formatDurationMs(diagnostics.hydrateNativeRecordsMs)],
    ["Hydrate Native 错误", nativeErrorText || "—"],
    ["Apply 调用", _formatDurationMs(diagnostics.applyInvokeMs)],
    ["Apply 运行", _formatDurationMs(diagnostics.applyRuntimeMs)],
    ["Load 未归因", _formatDurationMs(diagnostics.untrackedMs)],
    ["Load 更新时间", updatedAtText],
  ];
}

function _buildPersistDeltaDiagnosticRows(persistDelta = null) {
  const diagnostics = _readPersistenceDiagnosticObject(persistDelta);
  if (!diagnostics) {
    return [["Persist Delta 诊断", "无"]];
  }

  const errorText = String(
    diagnostics.moduleError || diagnostics.preloadError || diagnostics.nativeError || "",
  ).trim();
  const bridgeText = `${String(diagnostics.requestedBridgeMode || "none")} → ${String(
    diagnostics.preparedBridgeMode || "none",
  )}`;
  const deltaSizeText = `${Number(diagnostics.upsertNodeCount || 0)}N / ${Number(
    diagnostics.upsertEdgeCount || 0,
  )}E / ${Number(diagnostics.deleteNodeCount || 0)}DN / ${Number(
    diagnostics.deleteEdgeCount || 0,
  )}DE`;
  const commitStoreText = `${String(diagnostics.commitStorageKind || "—")} / ${String(
    diagnostics.commitStoreMode || "—",
  )}`;
  const commitPhaseText = _formatPersistCommitPhaseText(diagnostics);
  const commitBreakdownText = _formatPersistCommitBreakdownText(diagnostics);
  const commitBytesText = _formatPersistCommitBytesText(diagnostics);
  const updatedAtText = diagnostics.updatedAt
    ? _formatTaskProfileTime(diagnostics.updatedAt)
    : "—";

  return [
    ["Persist 路径", String(diagnostics.path || "—")],
    ["Native Gate", _formatPersistDeltaGateText(diagnostics)],
    ["Bridge 模式", bridgeText],
    ["Commit 存储", commitStoreText],
    ["Persist 总耗时", _formatDurationMs(diagnostics.totalMs || diagnostics.buildMs)],
    ["构建耗时", _formatDurationMs(diagnostics.buildMs)],
    ["Base 快照读取", _formatDurationMs(diagnostics.baseSnapshotReadMs)],
    ["图谱快照构建", _formatDurationMs(diagnostics.snapshotBuildMs)],
    ["快照构建细分", _formatPersistSnapshotBuildBreakdownText(diagnostics)],
    [
      "Prepare / Native",
      `${_formatDurationMs(diagnostics.prepareMs)} / ${_formatDurationMs(diagnostics.nativeAttemptMs)}`,
    ],
    [
      "Lookup / JS Diff",
      `${_formatDurationMs(diagnostics.lookupMs)} / ${_formatDurationMs(diagnostics.jsDiffMs)}`,
    ],
    ["Hydrate", _formatDurationMs(diagnostics.hydrateMs)],
    ["Commit 排队 / 提交", commitPhaseText],
    ["Commit 细分", commitBreakdownText],
    ["Commit Payload", commitBytesText],
    ["样本聚合", _formatPersistObservabilityText(diagnostics)],
    ["Preload", String(diagnostics.preloadStatus || "—")],
    ["Native 来源", String(diagnostics.moduleSource || "—")],
    ["Fallback 原因", String(diagnostics.fallbackReason || "—")],
    ["Preload / Native 错误", errorText || "—"],
    ["增量规模", deltaSizeText],
    ["Persist 未归因", _formatDurationMs(diagnostics.untrackedMs)],
    ["Persist 更新时间", updatedAtText],
  ];
}

function _refreshTaskPipelineOverview() {
  const el = document.getElementById("bme-task-pipeline");
  if (!el) return;

  const graph = _getGraph?.() || {};
  const historyState = graph.runtimeState?.historyState || graph.historyState || {};
  const loadInfo = _getGraphPersistenceSnapshot();

  const extraction = _resolvePipelineStatus(_getLastExtractionStatus?.());
  const vector = _resolvePipelineStatus(_getLastVectorStatus?.());
  const recall = _resolvePipelineStatus(_getLastRecallStatus?.());
  const persistLevel = loadInfo.loadState === "loaded" ? "info" : loadInfo.loadState === "loading" ? "info" : "warn";
  const persistenceMetaParts = [`rev ${loadInfo.revision || 0}`];
  const pipelineLoadMeta = _formatPipelineLoadDiagnosticsMeta(
    loadInfo.loadDiagnostics,
  );
  if (pipelineLoadMeta) {
    persistenceMetaParts.push(pipelineLoadMeta);
  }
  const pipelinePersistDeltaMeta = _formatPipelinePersistDeltaMeta(
    loadInfo.persistDelta,
  );
  if (pipelinePersistDeltaMeta) {
    persistenceMetaParts.push(pipelinePersistDeltaMeta);
  }
  const persistence = _resolvePipelineStatus({
    text: loadInfo.loadState || "unknown",
    meta: persistenceMetaParts.join(" · "),
    level: persistLevel,
  });

  const batchStatus = _getLatestBatchStatusSnapshot() || {};
  const stages = [
    { key: "core", label: "Core" },
    { key: "structural", label: "结构" },
    { key: "semantic", label: "语义" },
    { key: "finalize", label: "定稿" },
  ];

  const stageHtml = stages.map((s, i) => {
    const outcome = batchStatus.stageOutcomes?.[s.key];
    let dotClass = "";
    let lineClass = "";
    let icon = '<i class="fa-solid fa-hourglass"></i>';
    if (outcome === "success" || outcome === "skipped") {
      dotClass = "done";
      icon = '<i class="fa-solid fa-check"></i>';
      lineClass = "done";
    } else if (outcome === "running" || outcome === "partial") {
      dotClass = "running";
      icon = '<i class="fa-solid fa-spinner fa-spin"></i>';
      lineClass = "running";
    }
    const linePart = i < stages.length - 1 ? `<div class="bme-batch-stage-line ${lineClass}"></div>` : "";
    return `
      <div class="bme-batch-stage">
        <div class="bme-batch-stage-dot ${dotClass}">${icon}</div>
        <div class="bme-batch-stage-label">${_escHtml(s.label)}</div>
        <div class="bme-batch-stage-detail">${outcome ? _escHtml(outcome) : "pending"}</div>
        ${linePart}
      </div>
    `;
  }).join("");

  const batchMeta = batchStatus.persistenceOutcome
    ? `<span><i class="fa-solid fa-database"></i> ${_escHtml(batchStatus.persistenceOutcome)}</span>`
    : "";
  const batchWarnings = (batchStatus.warnings || []).length;
  const batchErrors = (batchStatus.errors || []).length;
  const batchMetaExtra = [
    batchWarnings ? `<span><i class="fa-solid fa-triangle-exclamation"></i> ${batchWarnings} warnings</span>` : "",
    batchErrors ? `<span><i class="fa-solid fa-circle-exclamation"></i> ${batchErrors} errors</span>` : "",
  ].filter(Boolean).join("");

  const statusRows = [
    { label: "提取", color: extraction.color, value: extraction.label + (extraction.detail ? ` — ${extraction.detail}` : "") },
    { label: "向量", color: vector.color, value: vector.label + (vector.detail ? ` — ${vector.detail}` : "") },
    { label: "召回", color: recall.color, value: recall.label + (recall.detail ? ` — ${recall.detail}` : "") },
    { label: "持久化", color: persistence.color, value: persistence.label + (persistence.detail ? ` — ${persistence.detail}` : "") },
  ];

  const pipelineCard = (name, s, icon) => `
    <div class="bme-pipeline-card" data-status="${s.color === "green" ? "idle" : s.color === "cyan" ? "running" : s.color === "amber" ? "warning" : "error"}">
      <div class="bme-pipeline-dot ${s.color}"></div>
      <div class="bme-pipeline-info">
        <div class="bme-pipeline-name"><i class="fa-solid fa-${icon}" style="margin-right:4px;opacity:.5"></i>${_escHtml(name)}</div>
        <div class="bme-pipeline-status ${s.color}">${_escHtml(s.label)}</div>
        <div class="bme-pipeline-detail">${_escHtml(s.detail)}</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="bme-pipeline-grid">
      ${pipelineCard("提取 Extraction", extraction, "scissors")}
      ${pipelineCard("向量 Vector", vector, "share-nodes")}
      ${pipelineCard("召回 Recall", recall, "magnifying-glass")}
      ${pipelineCard("持久化 Persistence", persistence, "database")}
    </div>
    <div class="bme-batch-progress">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:12px;font-weight:700;color:var(--bme-on-surface)"><i class="fa-solid fa-timeline" style="margin-right:6px;color:var(--bme-primary)"></i>Active Batch Progress</span>
        <span style="font-size:10px;color:var(--bme-on-surface-dim)">ID: ${_escHtml(String(batchStatus.batchId || "—"))}</span>
      </div>
      <div class="bme-batch-stages">${stageHtml}</div>
      <div class="bme-batch-meta">${batchMeta}${batchMetaExtra}</div>
    </div>
    <div class="bme-status-summary">
      <div class="bme-status-summary-title"><i class="fa-solid fa-list"></i> Recent Status</div>
      ${statusRows.map((r) => `
        <div class="bme-status-row">
          <div class="bme-status-row-label"><span class="bme-sdot" style="background:${r.color === "green" ? "#2ecc71" : r.color === "cyan" ? "#00d4ff" : r.color === "amber" ? "#f39c12" : "#e74c3c"}"></span>${_escHtml(r.label)}</div>
          <div class="bme-status-row-value">${_escHtml(r.value)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

// ---------- Task Timeline ----------

function _getTaskTimelineEntrySeverity(entry = {}) {
  const explicitLevel = String(entry?.level || "").trim().toLowerCase();
  if (explicitLevel) return explicitLevel;

  const status = String(entry?.status || "").trim().toLowerCase();
  if (status.includes("error") || status.includes("fail")) return "error";
  if (status.includes("warn")) return "warn";
  return "info";
}

function _buildTaskTimelineDetailState(entry = {}) {
  const detailLines = [];
  const legacyDetail = String(entry?.text || entry?.meta || "").trim();
  const routeInfo = _formatMonitorRouteInfo(entry);
  const governanceLines = _summarizeMonitorGovernance(entry);
  const messageCount = Array.isArray(entry?.messages) ? entry.messages.length : 0;
  const rawPreviewText = _buildMonitorMessagesPreview(entry?.messages || []);
  const previewText =
    rawPreviewText.length > 480
      ? `${rawPreviewText.slice(0, 480)}\n\n...（详情已截断）`
      : rawPreviewText;

  if (legacyDetail) {
    detailLines.push(legacyDetail);
  }
  if (routeInfo && routeInfo !== "未记录路由信息") {
    detailLines.push(`路由: ${routeInfo}`);
  }
  for (const line of governanceLines) {
    const normalized = String(line || "").trim();
    if (normalized) detailLines.push(normalized);
  }
  if (messageCount > 0) {
    detailLines.push(`消息快照: ${messageCount} 条`);
  }

  const uniqueLines = [];
  for (const line of detailLines) {
    if (!uniqueLines.includes(line)) {
      uniqueLines.push(line);
    }
  }

  return {
    detailLines: uniqueLines,
    previewText,
    hasRenderableDetail: uniqueLines.length > 0 || Boolean(previewText),
  };
}

function _refreshTaskTimeline() {
  const el = document.getElementById("bme-task-timeline");
  if (!el) return;

  const debug = _getRuntimeDebugSnapshot?.() || {};
  const rd = debug.runtimeDebug || {};
  const timeline = Array.isArray(rd.taskTimeline) ? rd.taskTimeline : [];

  if (!timeline.length) {
    el.innerHTML = '<div class="bme-timeline-bottom-bar">暂无任务记录</div>';
    return;
  }

  const entries = timeline.slice().reverse().map((entry, idx) => {
    const t = entry.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString() : "";
    const taskType = String(entry?.taskType || entry?.stage || "task");
    const title = entry?.taskType
      ? _getMonitorTaskTypeLabel(taskType)
      : taskType;
    const statusText = entry.status || "";
    const durationMs = entry.durationMs;
    const durationStr = _formatDurationMs(durationMs);
    const { detailLines, previewText, hasRenderableDetail } =
      _buildTaskTimelineDetailState(entry);
    const level = _getTaskTimelineEntrySeverity(entry);
    const levelIcon = level === "error" ? "circle-exclamation" : level === "warn" ? "triangle-exclamation" : "circle-check";
    const levelColor = level === "error" ? "#e74c3c" : level === "warn" ? "#f39c12" : "#2ecc71";
    const metaParts = [
      durationStr && durationStr !== "—" ? durationStr : "",
      t,
    ].filter(Boolean);

    const substages = Array.isArray(entry.substages) ? entry.substages.map((sub) => `
      <div class="bme-timeline-substage">
        <i class="fa-solid fa-angle-right" style="color:${levelColor}"></i>
        <span>${_escHtml(sub.label || sub.stage || "")}</span>
        <span style="margin-left:auto;opacity:.5">${_escHtml(sub.outcome || sub.status || "")}</span>
      </div>
    `).join("") : "";

    return `
      <div class="bme-timeline-entry${idx > 5 ? " is-collapsed" : ""}" data-entry-idx="${idx}">
        <div class="bme-timeline-entry__head">
          <i class="fa-solid fa-${levelIcon}" style="color:${levelColor};font-size:12px"></i>
          <span class="bme-timeline-entry__title">${_escHtml(title)}${statusText ? ` — ${_escHtml(_getMonitorStatusLabel(statusText))}` : ""}</span>
          <span class="bme-timeline-entry__meta">${_escHtml(metaParts.join(" "))}</span>
          <button class="bme-timeline-entry__toggle" type="button"><i class="fa-solid fa-chevron-down"></i></button>
        </div>
        <div class="bme-timeline-entry__detail">
          ${detailLines.map((line) => `<div class="bme-timeline-entry__line">${_escHtml(line)}</div>`).join("")}
          ${substages}
          ${previewText ? `<div class="bme-timeline-entry__preview">${_escHtml(previewText)}</div>` : ""}
          ${!hasRenderableDetail && !substages ? `<div class="bme-timeline-entry__empty">这条记录没有捕获到更多详情，通常表示当前只保留了任务状态快照。</div>` : ""}
        </div>
      </div>
    `;
  }).join("");

  el.innerHTML = `
    <div class="bme-timeline-toolbar">
      <i class="fa-solid fa-filter" style="color:var(--bme-on-surface-dim);font-size:11px"></i>
      <span style="font-size:11px;color:var(--bme-on-surface-dim)">${timeline.length} 条记录</span>
    </div>
    <div class="bme-timeline-stack">${entries}</div>
  `;
}

// ---------- Memory Browser (Master-Detail) ----------

function _getMemoryNodeTypeClass(type) {
  switch (type) {
    case "pov_memory":
    case "character":
      return "type-character";
    case "event":
      return "type-event";
    case "location":
      return "type-location";
    case "rule":
      return "type-rule";
    case "thread":
      return "type-thread";
    default:
      return "type-default";
  }
}

function _parseFloorFilter(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const ranges = [];
  for (const part of text.split(/[,，\s]+/)) {
    const rangeParts = part.split(/[-~]/);
    if (rangeParts.length === 2) {
      const lo = parseInt(rangeParts[0], 10);
      const hi = parseInt(rangeParts[1], 10);
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) {
        ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
      }
    } else {
      const n = parseInt(part, 10);
      if (!Number.isNaN(n)) ranges.push([n, n]);
    }
  }
  return ranges.length ? ranges : null;
}

function _matchesFloorFilter(node, ranges) {
  const seq = node.seq ?? -1;
  const seqLo = node.seqRange?.[0] ?? seq;
  const seqHi = node.seqRange?.[1] ?? seq;
  for (const [lo, hi] of ranges) {
    if (seqHi >= lo && seqLo <= hi) return true;
  }
  return false;
}

function _createTaskMemorySearchState(overrides = {}) {
  return {
    query: String(overrides.query || ""),
    floorQuery: String(overrides.floorQuery || ""),
    filter: String(overrides.filter || "all") || "all",
  };
}

function _readTaskMemoryDraftFromControls() {
  taskMemorySearchDraft = _createTaskMemorySearchState({
    query: document.getElementById("bme-task-memory-search")?.value,
    floorQuery: document.getElementById("bme-task-memory-floor")?.value,
    filter: document.getElementById("bme-task-memory-filter")?.value,
  });
  return _createTaskMemorySearchState(taskMemorySearchDraft);
}

function _applyTaskMemorySearchDraft() {
  taskMemorySearchApplied = _readTaskMemoryDraftFromControls();
  _refreshTaskMemoryBrowser();
}

function _ensureTaskMemoryBrowserShell(el) {
  if (!el) return null;

  let listEl = document.getElementById("bme-task-memory-list");
  let detailEl = document.getElementById("bme-task-memory-detail");
  if (!listEl || !detailEl) {
    const draft = _createTaskMemorySearchState(taskMemorySearchDraft);
    el.innerHTML = `
      <div class="bme-memory-master-detail">
        <div class="bme-memory-list-panel">
          <div class="bme-memory-list-filters">
            <input type="text" class="bme-search-input" id="bme-task-memory-search" placeholder="搜索记忆节点..." value="${_escHtml(draft.query)}" />
            <input type="text" class="bme-search-input bme-floor-input" id="bme-task-memory-floor" placeholder="楼层 (如 4, 3-10)" value="${_escHtml(draft.floorQuery)}" />
            <select class="bme-filter-select" id="bme-task-memory-filter">
              <option value="all"${draft.filter === "all" ? " selected" : ""}>全部</option>
              <option value="scope:objective"${draft.filter === "scope:objective" ? " selected" : ""}>客观</option>
              <option value="scope:characterPov"${draft.filter === "scope:characterPov" ? " selected" : ""}>角色 POV</option>
              <option value="scope:userPov"${draft.filter === "scope:userPov" ? " selected" : ""}>用户 POV</option>
              <option value="pov_memory"${draft.filter === "pov_memory" ? " selected" : ""}>主观记忆</option>
              <option value="event"${draft.filter === "event" ? " selected" : ""}>事件</option>
              <option value="location"${draft.filter === "location" ? " selected" : ""}>地点</option>
              <option value="thread"${draft.filter === "thread" ? " selected" : ""}>线索</option>
              <option value="rule"${draft.filter === "rule" ? " selected" : ""}>规则</option>
            </select>
            <button
              type="button"
              class="bme-config-secondary-btn bme-task-memory-search-btn"
              id="bme-task-memory-apply"
            >
              <i class="fa-solid fa-magnifying-glass"></i>
              <span>搜索</span>
            </button>
          </div>
          <div class="bme-memory-list-scroll" id="bme-task-memory-list"></div>
        </div>
        <div class="bme-memory-detail-panel" id="bme-task-memory-detail"></div>
      </div>
    `;
    listEl = document.getElementById("bme-task-memory-list");
    detailEl = document.getElementById("bme-task-memory-detail");
  }

  const searchInput = document.getElementById("bme-task-memory-search");
  const floorInput = document.getElementById("bme-task-memory-floor");
  const filterSelect = document.getElementById("bme-task-memory-filter");
  const applyButton = document.getElementById("bme-task-memory-apply");
  if (searchInput && !searchInput._bmeBound) {
    const syncDraft = () => {
      _readTaskMemoryDraftFromControls();
    };
    searchInput.addEventListener("input", syncDraft);
    floorInput?.addEventListener("input", syncDraft);
    filterSelect?.addEventListener("change", syncDraft);
    applyButton?.addEventListener("click", () => _applyTaskMemorySearchDraft());
    searchInput._bmeBound = true;
  }

  return { listEl, detailEl };
}

function _refreshTaskMemoryBrowser() {
  const el = document.getElementById("bme-task-memory");
  if (!el) return;

  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph || !_canRenderGraphData(loadInfo)) {
    el.innerHTML = '<div class="bme-memory-detail-empty">图谱未加载</div>';
    return;
  }

  const shell = _ensureTaskMemoryBrowserShell(el);
  const listEl = shell?.listEl;
  if (!listEl) return;

  const currentQuery = String(taskMemorySearchApplied.query || "");
  const normalizedQuery = currentQuery.trim().toLowerCase();
  const currentFilter = taskMemorySearchApplied.filter || "all";
  const currentFloorQuery = String(taskMemorySearchApplied.floorQuery || "").trim();

  let nodes = Array.isArray(graph.nodes)
    ? graph.nodes.filter((node) => !node?.archived)
    : [];

  if (currentFilter !== "all") {
    nodes = nodes.filter((node) => _matchesMemoryFilter(node, currentFilter));
  }

  if (normalizedQuery) {
    nodes = nodes.filter((node) => {
      const name = getNodeDisplayName(node).toLowerCase();
      const snippet = _getNodeSnippet(node).toLowerCase();
      const fieldsText = JSON.stringify(node?.fields || {}).toLowerCase();
      return (
        name.includes(normalizedQuery) ||
        snippet.includes(normalizedQuery) ||
        fieldsText.includes(normalizedQuery)
      );
    });
  }

  if (currentFloorQuery) {
    const floorFilter = _parseFloorFilter(currentFloorQuery);
    if (floorFilter) {
      nodes = nodes.filter((node) => _matchesFloorFilter(node, floorFilter));
    }
  }

  const sorted = nodes.slice().sort((a, b) => {
    const importanceDiff = (b.importance || 5) - (a.importance || 5);
    if (importanceDiff !== 0) return importanceDiff;
    return (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0);
  });

  if (!sorted.some((node) => node.id === currentSelectedMemoryNodeId)) {
    currentSelectedMemoryNodeId = sorted[0]?.id || "";
  }

  const listItems = sorted.map((node) => {
    const sel = node.id === currentSelectedMemoryNodeId ? "selected" : "";
    const preview = _getNodeSnippet(node);
    const scopeBadge = buildScopeBadgeText(node.scope);
    const metaText = _buildScopeMetaText(node);
    const displayName = getNodeDisplayName(node);
    return `
      <div class="bme-memory-node-item ${sel}" data-node-id="${_escHtml(node.id)}">
        <div class="bme-memory-node-item__header">
          <span class="bme-memory-node-item__type ${_getMemoryNodeTypeClass(node.type)}">${_escHtml(_typeLabel(node.type))}</span>
          <span class="bme-memory-node-item__imp">IMP: ${typeof node.importance === "number" ? node.importance.toFixed(1) : "—"}</span>
        </div>
        <div class="bme-memory-node-item__title">${_escHtml(displayName)}</div>
        <div class="bme-memory-node-item__preview">${_escHtml(preview)}</div>
        <div class="bme-memory-node-item__meta">
          <span>${_escHtml(scopeBadge)}</span>
          <span>SEQ: ${_formatMemoryInt(node.seqRange?.[1] ?? node.seq, 0)}</span>
        </div>
        ${metaText ? `<div class="bme-memory-node-item__meta">${_escHtml(metaText)}</div>` : ""}
      </div>`;
  }).join("");

  listEl.innerHTML =
    listItems ||
    '<div style="padding:16px;font-size:12px;color:var(--bme-on-surface-dim)">鏃犺妭鐐?/div>';

  _renderTaskMemoryDetailSelection(graph);
  _bindTaskMemoryListClick();
  return;

  el.innerHTML = `
    <div class="bme-memory-master-detail">
      <div class="bme-memory-list-panel">
        <div class="bme-memory-list-filters">
          <input type="text" class="bme-search-input" id="bme-task-memory-search" placeholder="搜索记忆节点..." value="${_escHtml(currentQuery)}" />
          <input type="text" class="bme-search-input bme-floor-input" id="bme-task-memory-floor" placeholder="楼层 (如 4, 3-10)" value="${_escHtml(currentFloorQuery)}" />
          <select class="bme-filter-select" id="bme-task-memory-filter">
            <option value="all"${currentFilter === "all" ? " selected" : ""}>全部</option>
            <option value="scope:objective"${currentFilter === "scope:objective" ? " selected" : ""}>客观</option>
            <option value="scope:characterPov"${currentFilter === "scope:characterPov" ? " selected" : ""}>角色 POV</option>
            <option value="scope:userPov"${currentFilter === "scope:userPov" ? " selected" : ""}>用户 POV</option>
            <option value="pov_memory"${currentFilter === "pov_memory" ? " selected" : ""}>主观记忆</option>
            <option value="event"${currentFilter === "event" ? " selected" : ""}>事件</option>
            <option value="location"${currentFilter === "location" ? " selected" : ""}>地点</option>
            <option value="thread"${currentFilter === "thread" ? " selected" : ""}>线索</option>
            <option value="rule"${currentFilter === "rule" ? " selected" : ""}>规则</option>
          </select>
        </div>
        <div class="bme-memory-list-scroll" id="bme-task-memory-list">
          ${listItems || '<div style="padding:16px;font-size:12px;color:var(--bme-on-surface-dim)">无节点</div>'}
        </div>
      </div>
      <div class="bme-memory-detail-panel" id="bme-task-memory-detail"></div>
    </div>
  `;

  _renderTaskMemoryDetailSelection(graph);
  _bindTaskMemoryListClick();
}

function _bindTaskMemoryListClick() {
  const list = document.getElementById("bme-task-memory-list");
  if (!list || list._bmeBound) return;
  list.addEventListener("click", (e) => {
    const item = e.target.closest(".bme-memory-node-item");
    if (!item) return;
    currentSelectedMemoryNodeId = item.dataset.nodeId || "";
    list.querySelectorAll(".bme-memory-node-item").forEach((n) => n.classList.toggle("selected", n.dataset.nodeId === currentSelectedMemoryNodeId));
    const graph = _getGraph?.();
    if (_isMobile()) {
      const node = (graph?.nodes || []).find((c) => c.id === currentSelectedMemoryNodeId) || null;
      if (node) _openMemoryPopup(node, graph);
    } else {
      _renderTaskMemoryDetailSelection(graph);
    }
  });
  list._bmeBound = true;
}

function _renderTaskMemoryDetailSelection(graph = _getGraph?.()) {
  const detailEl = document.getElementById("bme-task-memory-detail");
  if (!detailEl) return;

  const node = (graph?.nodes || []).find((candidate) => candidate.id === currentSelectedMemoryNodeId) || null;
  if (!node) {
    detailEl.innerHTML = '<div class="bme-memory-detail-empty"><i class="fa-solid fa-arrow-left" style="margin-right:6px"></i>选择左侧节点查看详情</div>';
    return;
  }

  _renderTaskMemoryDetailPanel(detailEl, node, graph);
}

function _renderTaskMemoryDetailPanel(detailEl, node, graph) {
  if (!detailEl) return;

  const edges = (graph?.edges || []).filter(
    (e) =>
      !e?.invalidAt &&
      !e?.expiredAt &&
      (e?.fromId === node.id || e?.toId === node.id),
  );
  const detailSummary = _getNodeSnippet(node);
  const scopeBadge = buildScopeBadgeText(node.scope);
  const displayName = getNodeDisplayName(node);
  const writeBlocked = _isGraphWriteBlocked();
  const disabledAttr = writeBlocked ? " disabled" : "";
  const badges = [
    node.type ? `<span class="bme-memory-node-item__type ${_getMemoryNodeTypeClass(node.type)}">${_escHtml(_typeLabel(node.type))}</span>` : "",
    scopeBadge ? `<span class="bme-memory-node-item__type type-default">${_escHtml(scopeBadge)}</span>` : "",
    node.archived ? '<span class="bme-memory-node-item__type type-default">ARCHIVED</span>' : "",
  ].filter(Boolean).join("");

  detailEl.innerHTML = `
    <div class="bme-memory-detail__header">
      <div class="bme-memory-detail__title">${_escHtml(displayName)}</div>
      <div class="bme-memory-detail__header-actions">
        <button class="bme-detail-action-btn" data-task-memory-action="save" type="button" title="保存修改"${disabledAttr}>
          <i class="fa-solid fa-floppy-disk"></i>
        </button>
        <button class="bme-detail-action-btn bme-detail-action-danger" data-task-memory-action="delete" type="button" title="删除节点"${disabledAttr}>
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
    <div class="bme-memory-detail__badges">${badges}</div>
    <div class="bme-memory-detail__desc">${_escHtml(detailSummary || "无补充字段")}</div>
    <div class="bme-memory-detail__stats">
      <span><i class="fa-solid fa-link" style="margin-right:4px;opacity:.5"></i>${edges.length} 条连接</span>
      <span><i class="fa-solid fa-eye" style="margin-right:4px;opacity:.5"></i>访问 ${_formatMemoryInt(node.accessCount, 0)}</span>
    </div>
    <div id="bme-task-memory-editor-body"></div>
  `;

  const editorBody = detailEl.querySelector("#bme-task-memory-editor-body");
  if (editorBody) {
    editorBody.replaceChildren(
      _buildNodeDetailEditorFragment(node, { idPrefix: "bme-task-detail" }),
    );
  }

  detailEl
    .querySelector('[data-task-memory-action="save"]')
    ?.addEventListener("click", () => _saveTaskMemoryDetail());
  detailEl
    .querySelector('[data-task-memory-action="delete"]')
    ?.addEventListener("click", () => _deleteTaskMemoryDetail());
}

function _saveTaskMemoryDetail() {
  const popupBody = document.getElementById("bme-memory-popup-body");
  const popupOpen = document.getElementById("bme-memory-popup")?.classList.contains("open");
  const detailEl = popupOpen ? null : document.getElementById("bme-task-memory-detail");
  const bodyEl = popupOpen
    ? popupBody
    : detailEl?.querySelector("#bme-task-memory-editor-body");
  const nodeId = currentSelectedMemoryNodeId;
  if (!nodeId || !bodyEl) return;

  const idPrefix = popupOpen ? "bme-popup-detail" : "bme-task-detail";
  const collected = _collectNodeDetailEditorUpdates(bodyEl, { idPrefix });
  if (!collected.ok) {
    toastr.error(collected.errorMessage || "保存失败", "ST-BME");
    return;
  }

  _persistNodeDetailEdits(nodeId, collected.updates, {
    afterSuccess: () => {
      if (popupOpen) {
        const graph = _getGraph?.();
        const refreshedNode = (graph?.nodes || []).find((n) => n.id === nodeId);
        if (refreshedNode) _openMemoryPopup(refreshedNode, graph);
      }
    },
  });
}

function _deleteTaskMemoryDetail() {
  const nodeId = currentSelectedMemoryNodeId;
  if (!nodeId) return;

  _deleteGraphNodeById(nodeId, {
    afterSuccess: () => {
      currentSelectedMemoryNodeId = "";
      _closeMemoryPopup();
    },
  });
}

function _openMemoryPopup(node, graph) {
  const popup = document.getElementById("bme-memory-popup");
  const scrim = document.getElementById("bme-memory-popup-scrim");
  const titleEl = document.getElementById("bme-memory-popup-title");
  const badgesEl = document.getElementById("bme-memory-popup-badges");
  const bodyEl = document.getElementById("bme-memory-popup-body");
  if (!popup || !bodyEl) return;

  const displayName = getNodeDisplayName(node);
  const scopeBadge = buildScopeBadgeText(node.scope);
  const badges = [
    node.type ? `<span class="bme-memory-node-item__type ${_getMemoryNodeTypeClass(node.type)}">${_escHtml(_typeLabel(node.type))}</span>` : "",
    scopeBadge ? `<span class="bme-memory-node-item__type type-default">${_escHtml(scopeBadge)}</span>` : "",
    node.archived ? '<span class="bme-memory-node-item__type type-default">ARCHIVED</span>' : "",
  ].filter(Boolean).join("");

  if (titleEl) titleEl.textContent = displayName;
  if (badgesEl) badgesEl.innerHTML = badges;

  bodyEl.replaceChildren(
    _buildNodeDetailEditorFragment(node, { idPrefix: "bme-popup-detail" }),
  );

  scrim?.removeAttribute("hidden");
  popup.classList.add("open");
}

function _closeMemoryPopup() {
  const popup = document.getElementById("bme-memory-popup");
  const scrim = document.getElementById("bme-memory-popup-scrim");
  popup?.classList.remove("open");
  scrim?.setAttribute("hidden", "");
}

function _bindMemoryPopup() {
  const closeBtn = document.getElementById("bme-memory-popup-close");
  const scrim = document.getElementById("bme-memory-popup-scrim");
  const saveBtn = document.getElementById("bme-memory-popup-save");
  const deleteBtn = document.getElementById("bme-memory-popup-delete");

  closeBtn?.addEventListener("click", () => _closeMemoryPopup());
  scrim?.addEventListener("click", () => _closeMemoryPopup());
  saveBtn?.addEventListener("click", () => _saveTaskMemoryDetail());
  deleteBtn?.addEventListener("click", () => _deleteTaskMemoryDetail());
}

// ---------- Injection Preview ----------

function _refreshTaskInjectionPreview() {
  const el = document.getElementById("bme-task-injection");
  if (!el) return;

  const injectionText = String(_getLastInjection?.() || "").trim();
  if (!injectionText) {
    el.innerHTML = '<div class="bme-memory-detail-empty">暂无注入数据——等待第一次召回注入后显示。</div>';
    return;
  }

  const debug = _getRuntimeDebugSnapshot?.() || {};
  const rd = debug.runtimeDebug || {};
  const recallSnap = rd?.injections?.recall || {};
  const totalTokens = recallSnap.tokenCount || 0;
  const budgetTokens = recallSnap.budgetTokens || totalTokens || 1;
  const pct = totalTokens > 0 ? Math.min(100, Math.round((totalTokens / budgetTokens) * 100)) : 0;

  const wrapper = document.createDocumentFragment();

  if (totalTokens > 0) {
    const bar = document.createElement("div");
    bar.className = "bme-injection-token-bar";
    bar.innerHTML = `
      <span class="bme-injection-token-bar__label">${totalTokens} / ${budgetTokens} tok</span>
      <div class="bme-injection-token-bar__track">
        <div class="bme-injection-token-bar__fill" style="width:${pct}%"></div>
      </div>
      <span class="bme-injection-token-bar__breakdown">${pct}%</span>`;
    wrapper.appendChild(bar);
  }

  wrapper.appendChild(_buildInjectionPreviewNode(injectionText));
  el.replaceChildren(wrapper);
}

// ---------- Message Trace ----------

function _refreshTaskMessageTrace() {
  const el = document.getElementById("bme-task-trace");
  if (!el) return;

  const settings = _getSettings?.() || {};
  const state = _getMessageTraceWorkspaceState(settings);
  el.innerHTML = _renderMessageTraceWorkspace(state);
}

// ---------- Persistence Status ----------

function _refreshTaskPersistence() {
  const el = document.getElementById("bme-task-persistence");
  if (!el) return;

  const graph = _getGraph?.() || {};
  const ps = _getGraphPersistenceSnapshot();
  const rs = graph.runtimeState || {};
  const loadDiagnostics = _readPersistenceDiagnosticObject(ps.loadDiagnostics);
  const persistDeltaDiagnostics = _readPersistenceDiagnosticObject(ps.persistDelta);

  const LOAD_STATE_LABELS = {
    "no-chat": "无聊天",
    loading: "加载中",
    loaded: "已加载",
    blocked: "已阻塞",
    error: "错误",
  };

  const STORAGE_TIER_LABELS = {
    none: "无",
    metadata: "元数据",
    "metadata-full": "完整 metadata",
    indexeddb: "IndexedDB",
    opfs: "OPFS",
    "chat-state": "聊天侧车",
    "luker-chat-state": "Luker 侧车主存储",
    shadow: "影子快照",
  };
  const HOST_PROFILE_LABELS = {
    "generic-st": "通用 ST",
    luker: "Luker",
  };
  const CACHE_MIRROR_LABELS = {
    idle: "空闲",
    none: "无",
    queued: "排队中",
    saved: "已更新",
    error: "失败",
  };

  const loadStateLabel = LOAD_STATE_LABELS[ps.loadState] || ps.loadState || "未知";
  const acceptedTierLabel =
    STORAGE_TIER_LABELS[ps.acceptedStorageTier || ps.storageTier] ||
    ps.acceptedStorageTier ||
    ps.storageTier ||
    "—";
  const primaryTierLabel =
    STORAGE_TIER_LABELS[ps.primaryStorageTier] || ps.primaryStorageTier || "—";
  const cacheTierLabel =
    STORAGE_TIER_LABELS[ps.cacheStorageTier] || ps.cacheStorageTier || "—";
  const hostProfileLabel =
    HOST_PROFILE_LABELS[ps.hostProfile] || ps.hostProfile || "未知";
  const opfsLock = ps.opfsWriteLockState || null;
  const opfsLockLabel = opfsLock
    ? opfsLock.active
      ? `活跃中 · queue ${Number(opfsLock.queueDepth || 0)}`
      : `空闲 · queue ${Number(opfsLock.queueDepth || 0)}`
    : "—";
  const opfsCompactionState = String(ps.opfsCompactionState?.state || "").trim();
  const opfsCompactionLabel = opfsCompactionState || "—";
  const sidecarFormatLabel =
    ps.hostProfile === "luker"
      ? `v${Number(ps.lukerSidecarFormatVersion || 0) || 1}`
      : "—";
  const manifestRevisionLabel =
    ps.hostProfile === "luker" ? String(Number(ps.lukerManifestRevision || 0)) : "—";
  const journalStateLabel =
    ps.hostProfile === "luker"
      ? `${Number(ps.lukerJournalDepth || 0)} 条 / ${Number(ps.lukerJournalBytes || 0)} B`
      : "—";
  const checkpointRevisionLabel =
    ps.hostProfile === "luker" ? String(Number(ps.lukerCheckpointRevision || 0)) : "—";
  const cacheLagLabel =
    ps.hostProfile === "luker" ? String(Number(ps.cacheLag || 0)) : "—";
  const verboseDebugLabel = globalThis.__stBmeVerboseDebug === true ? "开启" : "关闭";
  const projectionLabel =
    ps?.projectionState?.runtime?.status || ps?.projectionState?.persistent?.status || "—";
  const compactTargetLabel = (() => {
    const target = ps.chatStateTarget;
    if (!target || typeof target !== "object") return "未绑定";
    if (target.is_group === true) {
      return `群聊 · ${String(target.id || "—")}`;
    }
    return `角色聊天 · ${String(target.file_name || "—")}`;
  })();
  const mirrorLabel =
    CACHE_MIRROR_LABELS[ps.cacheMirrorState] || ps.cacheMirrorState || "—";
  const acceptedSummaryLabel =
    ps.pendingPersist === true
      ? "待确认"
      : ps.persistMismatchReason
        ? "一致性异常"
        : acceptedTierLabel !== "—" && acceptedTierLabel !== "无"
          ? acceptedTierLabel
          : ps.shadowSnapshotUsed
            ? "仅恢复锚点"
            : "未确认";
  const healthLabel = ps.pendingPersist === true
    ? "等待正式持久化确认"
    : ps.persistMismatchReason
      ? _formatPersistMismatchReason(ps.persistMismatchReason)
      : ps.blockedReason || (ps.loadState === "blocked" ? ps.reason : "") || "正常";
  const localEngineLabel =
    ps.resolvedLocalStore
      ? String(ps.resolvedLocalStore).replace(":", " / ")
      : cacheTierLabel;
  const sidecarSummaryLabel =
    ps.hostProfile === "luker"
      ? `rev ${manifestRevisionLabel} · ${journalStateLabel}`
      : "—";
  const historyState = graph?.historyState || {};
  const summaryState = graph?.summaryState || {};
  const journalCount = Array.isArray(graph?.batchJournal) ? graph.batchJournal.length : 0;
  const summaryCount = Array.isArray(summaryState?.entries) ? summaryState.entries.length : 0;
  const activeSummaryCount = Array.isArray(summaryState?.activeEntryIds)
    ? summaryState.activeEntryIds.length
    : 0;
  const processedFloorLabel = Number.isFinite(Number(historyState?.lastProcessedAssistantFloor))
    ? String(Number(historyState.lastProcessedAssistantFloor))
    : "—";
  const extractionCountLabel = Number.isFinite(Number(historyState?.extractionCount))
    ? String(Number(historyState.extractionCount))
    : "0";
  const activeRegionLabel = String(
    historyState?.activeRegion ||
      historyState?.lastExtractedRegion ||
      "—",
  );
  const dirtyFromLabel = Number.isFinite(Number(historyState?.historyDirtyFrom))
    ? String(Number(historyState.historyDirtyFrom))
    : "无";

  const summaryPills = [
    `加载 · ${loadStateLabel}`,
    `宿主 · ${hostProfileLabel}`,
    `主存储 · ${primaryTierLabel}`,
    `确认 · ${acceptedSummaryLabel}`,
  ];
  const collectVisibleRows = (rows = []) =>
    rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  const renderRow = ([key, value]) =>
    `<div class="bme-persist-kv__row"><span>${_escHtml(String(key))}</span><strong>${_escHtml(String(value))}</strong></div>`;
  const renderRows = (rows = []) =>
    collectVisibleRows(rows)
      .map(renderRow)
      .join("");
  const renderRowsTwoColumn = (rows = []) => {
    const visibleRows = collectVisibleRows(rows);
    if (!visibleRows.length) return "";
    const splitIndex = Math.ceil(visibleRows.length / 2);
    return `
      <div class="bme-persist-kv-columns">
        <div class="bme-persist-kv-column">${visibleRows.slice(0, splitIndex).map(renderRow).join("")}</div>
        <div class="bme-persist-kv-column">${visibleRows.slice(splitIndex).map(renderRow).join("")}</div>
      </div>
    `;
  };

  const primaryRows = [
    ["当前状态", acceptedSummaryLabel],
    ["健康状态", healthLabel],
    ["Load 诊断", _formatPersistenceLoadSummary(loadDiagnostics)],
    ["Persist Delta", _formatPersistencePersistDeltaSummary(persistDeltaDiagnostics)],
    ["Chat Target", compactTargetLabel],
    ["主 durable", primaryTierLabel],
    ps.hostProfile === "luker"
      ? ["Luker Sidecar", sidecarSummaryLabel]
      : ["本地引擎", localEngineLabel],
    ps.hostProfile === "luker"
      ? ["本地缓存", `${cacheTierLabel} · ${mirrorLabel}`]
      : ["恢复锚点", ps.shadowSnapshotUsed ? "影子快照已接管" : "无"],
  ];

  const runtimeRows = [
    ["图谱节点", String((graph.nodes || []).length)],
    ["图谱边", String((graph.edges || []).length)],
    ["批次日志", String(journalCount)],
    ["提取次数", extractionCountLabel],
    ["已处理楼层", processedFloorLabel],
    ["总结条目", `${summaryCount}（活跃 ${activeSummaryCount}）`],
    ["当前区域", activeRegionLabel],
    ["脏区起点", dirtyFromLabel],
    ["运行版本", String(rs.graphRevision ?? "—")],
  ];

  const diagnosticRows = [
    ["宿主档案", hostProfileLabel],
    ["accepted by", ps.acceptedBy || "—"],
    ["诊断层", STORAGE_TIER_LABELS[ps.persistDiagnosticTier] || ps.persistDiagnosticTier || "无"],
    ["提交标记", ps.commitMarker ? "存在（诊断锚点）" : "无"],
    ["版本号", ps.revision ?? "—"],
    ["本地格式", `v${Number(ps.localStoreFormatVersion || 0) || 1}`],
    ["本地迁移", ps.localStoreMigrationState || "—"],
    ["轻量模式", ps.lightweightHostMode ? "开启" : "关闭"],
    ["Verbose Debug", verboseDebugLabel],
    ["Luker Hook", ps.lastHookPhase || "—"],
    ["Projection", projectionLabel],
    ["Rescan 原因", ps.lastRequestRescanReason || "—"],
    ["忽略变更", ps.lastIgnoredMutationEvent || "—"],
    ["影子快照", ps.shadowSnapshotUsed ? "已使用" : "未使用"],
    ["OPFS 写锁", opfsLockLabel],
    ["OPFS WAL", `${Number(ps.opfsWalDepth || 0)} 条 / ${Number(ps.opfsPendingBytes || 0)} B`],
    ["OPFS 压实", opfsCompactionLabel],
    ["远端同步格式", `v${Number(ps.remoteSyncFormatVersion || 0) || 1}`],
  ];
  if (ps.hostProfile === "luker") {
    diagnosticRows.splice(5, 0,
      ["Sidecar 格式", sidecarFormatLabel],
      ["Manifest rev", manifestRevisionLabel],
      ["Journal", journalStateLabel],
      ["Checkpoint rev", checkpointRevisionLabel],
      ["缓存落后", cacheLagLabel],
    );
  }
  diagnosticRows.push(
    ..._buildLoadDiagnosticRows(loadDiagnostics),
    ..._buildPersistDeltaDiagnosticRows(persistDeltaDiagnostics),
  );

  el.innerHTML = `
    <div class="bme-persist-grid">
      <div class="bme-persist-kv">
        <div style="font-size:12px;font-weight:700;color:var(--bme-on-surface);margin-bottom:10px"><i class="fa-solid fa-database" style="margin-right:6px;color:var(--bme-primary)"></i>持久化状态</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          ${summaryPills.map((pill) => `<span class="bme-task-pill">${_escHtml(pill)}</span>`).join("")}
        </div>
        <div class="bme-config-help" style="margin-bottom:12px">
          这里只保留日常最常用的持久化信息。更偏技术性的字段已下沉到诊断细节，避免和右侧运行概览失衡。
        </div>
        ${renderRows(primaryRows)}
        <details style="margin-top:14px;border-top:1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.10));padding-top:12px">
          <summary style="cursor:pointer;font-size:12px;font-weight:700;color:var(--bme-on-surface);list-style:none">
            <i class="fa-solid fa-stethoscope" style="margin-right:6px;color:var(--bme-primary)"></i>查看诊断细节
          </summary>
          <div style="margin-top:12px">
            ${renderRowsTwoColumn(diagnosticRows)}
          </div>
        </details>
      </div>
      <div class="bme-persist-kv">
        <div style="font-size:12px;font-weight:700;color:var(--bme-on-surface);margin-bottom:10px"><i class="fa-solid fa-chart-bar" style="margin-right:6px;color:var(--bme-primary)"></i>运行概览</div>
        <div class="bme-config-help" style="margin-bottom:12px">
          右侧专门展示当前图谱规模、处理进度和运行态前沿，减少左侧“持久化状态”承担太多运行职责。
        </div>
        ${renderRows(runtimeRows)}
      </div>
    </div>
  `;
}

// ==================== 图谱视图切换 ====================

function _switchGraphView(view) {
  currentGraphView = view || "graph";
  panelEl?.querySelectorAll(".bme-graph-view-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.graphView === currentGraphView);
  });

  const canvas = document.getElementById("bme-graph-canvas");
  const legend = document.getElementById("bme-graph-legend");
  const statusbar = panelEl?.querySelector(".bme-graph-statusbar");
  const nodeDetail = document.getElementById("bme-node-detail");
  const cogWorkspace = document.getElementById("bme-cognition-workspace");
  const summaryWorkspace = document.getElementById("bme-summary-workspace");
  const graphControls = panelEl?.querySelector(".bme-graph-controls");

  const isGraph = currentGraphView === "graph";
  const isCognition = currentGraphView === "cognition";
  const isSummary = currentGraphView === "summary";
  if (canvas) canvas.style.display = isGraph ? "" : "none";
  if (legend) legend.style.display = isGraph ? "" : "none";
  if (statusbar) statusbar.style.display = isGraph ? "" : "none";
  if (nodeDetail) nodeDetail.style.display = isGraph ? "" : "none";
  if (!isGraph) {
    nodeDetail?.classList.remove("open");
  }
  if (graphControls) graphControls.style.display = isGraph ? "" : "none";
  if (cogWorkspace) cogWorkspace.hidden = !isCognition;
  if (summaryWorkspace) summaryWorkspace.hidden = !isSummary;
  if (cogWorkspace) cogWorkspace.style.display = isCognition ? "" : "none";
  if (summaryWorkspace) summaryWorkspace.style.display = isSummary ? "" : "none";

  _refreshGraph({ force: true });
}

// ==================== 移动端图谱 Tab ====================

function _switchMobileGraphSubView(view) {
  currentMobileGraphView = view || "graph";
  const pane = document.getElementById("bme-pane-graph");
  if (!pane) return;

  pane.querySelectorAll(".bme-graph-subtab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mobileGraphView === currentMobileGraphView);
  });
  pane.querySelectorAll(".bme-mobile-graph-pane").forEach((p) => {
    p.classList.toggle("active", p.dataset.mobileGraphView === currentMobileGraphView);
  });

  if (currentMobileGraphView !== "graph") {
    _closeNodeDetailUi();
  }

  _refreshMobileGraphTab();
}

function _refreshMobileGraphTab() {
  _refreshGraph({ force: true });
}

function _buildMobileLegend() {
  const legend = document.getElementById("bme-mobile-graph-legend");
  if (!legend) return;
  const desktopLegend = document.getElementById("bme-graph-legend");
  if (desktopLegend) {
    legend.innerHTML = desktopLegend.innerHTML;
  }
}

function _refreshMobileCognitionFull() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const canRender =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");

  _renderCogStatusStrip(graph, loadInfo, canRender, document.getElementById("bme-mobile-cog-status-strip"));
  _renderCogOwnerList(graph, canRender, document.getElementById("bme-mobile-cog-owner-list"));
  _renderCogOwnerDetail(graph, loadInfo, canRender, document.getElementById("bme-mobile-cog-owner-detail"));
  _renderCogSpaceTools(graph, loadInfo, canRender, document.getElementById("bme-mobile-cog-space-tools"));
}

function _refreshMobileSummaryFull() {
  _refreshSummaryWorkspace(document.getElementById("bme-mobile-summary-full"));
}

function _ownerAvatarHsl(name) {
  let hash = 0;
  const str = String(name || "");
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

function _normalizeOwnerUiType(ownerType = "") {
  const normalized = String(ownerType || "").trim();
  if (normalized === "user") return "user";
  if (normalized === "character") return "character";
  return "";
}

function _inferOwnerTypeFromKey(ownerKey = "") {
  const normalizedOwnerKey = String(ownerKey || "").trim().toLowerCase();
  if (normalizedOwnerKey.startsWith("user:")) return "user";
  if (normalizedOwnerKey.startsWith("character:")) return "character";
  return "";
}

function _getOwnerTypeDisplayLabel(ownerType = "") {
  const normalizedType = _normalizeOwnerUiType(ownerType);
  if (normalizedType === "user") return "用户";
  if (normalizedType === "character") return "角色";
  return "Owner";
}

function _buildOwnerCollisionIndex(owners = []) {
  const collisionIndex = new Map();
  for (const owner of Array.isArray(owners) ? owners : []) {
    const baseName =
      String(owner?.ownerName || owner?.ownerKey || "未命名角色").trim() ||
      "未命名角色";
    const nameKey = baseName.toLocaleLowerCase("zh-Hans-CN");
    const ownerType = _normalizeOwnerUiType(owner?.ownerType) || "unknown";
    const entry = collisionIndex.get(nameKey) || {
      count: 0,
      typeCounts: new Map(),
    };
    entry.count += 1;
    entry.typeCounts.set(ownerType, (entry.typeCounts.get(ownerType) || 0) + 1);
    collisionIndex.set(nameKey, entry);
  }
  return collisionIndex;
}

function _shortOwnerNodeId(owner = {}) {
  const nodeId = String(owner?.nodeId || "").trim();
  if (!nodeId) return "";
  return nodeId.length > 6 ? nodeId.slice(0, 6) : nodeId;
}

function _getOwnerDisplayInfo(owner = {}, collisionIndex = null) {
  const baseName =
    String(owner?.ownerName || owner?.ownerKey || "未命名角色").trim() ||
    "未命名角色";
  const ownerKey = String(owner?.ownerKey || "").trim();
  const ownerType =
    _normalizeOwnerUiType(owner?.ownerType) || _inferOwnerTypeFromKey(ownerKey);
  const typeLabel = _getOwnerTypeDisplayLabel(ownerType);
  const collisionInfo =
    collisionIndex instanceof Map
      ? collisionIndex.get(baseName.toLocaleLowerCase("zh-Hans-CN")) || null
      : null;
  const typeCounts =
    collisionInfo?.typeCounts instanceof Map ? collisionInfo.typeCounts : new Map();
  const totalCount = Number(collisionInfo?.count || 0);
  const sameTypeCount = Number(typeCounts.get(ownerType || "unknown") || 0);
  const hasCrossTypeCollision = totalCount > 1 && typeCounts.size > 1;
  const shortNodeId = ownerType === "character" ? _shortOwnerNodeId(owner) : "";

  let title = baseName;
  if (hasCrossTypeCollision) {
    title = `${baseName}（${typeLabel}）`;
  } else if (sameTypeCount > 1) {
    title =
      ownerType === "character" && shortNodeId
        ? `${baseName}（${typeLabel} ${shortNodeId}）`
        : `${baseName}（${typeLabel}）`;
  }

  const subtitleParts = [typeLabel];
  if (ownerType === "character" && shortNodeId) {
    subtitleParts.push(`#${shortNodeId}`);
  }

  return {
    title,
    typeLabel,
    subtitle: subtitleParts.join(" · "),
    avatarText: baseName.charAt(0) || "?",
    avatarSeed: ownerKey || `${ownerType}:${baseName}`,
    tooltip: [title, ownerKey && ownerKey !== title ? ownerKey : ""]
      .filter(Boolean)
      .join(" · "),
  };
}

// ==================== 认知视图工作区 ====================

function _refreshCognitionWorkspace() {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  if (!graph) return;

  const canRender =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");

  _renderCogStatusStrip(graph, loadInfo, canRender);
  _renderCogOwnerList(graph, canRender);
  _renderCogOwnerDetail(graph, loadInfo, canRender);
  _renderCogSpaceTools(graph, loadInfo, canRender);
}

function _renderCogStatusStrip(graph, loadInfo, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-status-strip");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = `<div class="bme-cog-status-card" style="grid-column:1/-1"><div class="bme-cog-status-card__value">${_escHtml(_getGraphLoadLabel(loadInfo))}</div></div>`;
    return;
  }

  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const timelineState = graph?.timelineState || {};
  const { owners, activeOwnerKey, activeOwner, activeOwnerLabels } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const activeRegion = String(
    historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "",
  ).trim();
  const activeRegionLabel = activeRegion
    ? `${activeRegion}${historyState.activeRegionSource ? ` · ${historyState.activeRegionSource}` : ""}`
    : "—";
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];
  const activeStoryTimeLabel = String(
    historyState.activeStoryTimeLabel || "",
  ).trim();
  const activeStoryTimeMeta = activeStoryTimeLabel
    ? `${activeStoryTimeLabel}${historyState.activeStoryTimeSource ? ` · ${historyState.activeStoryTimeSource}` : ""}`
    : "—";
  const recentStorySegments = Array.isArray(timelineState?.recentSegmentIds)
    ? timelineState.recentSegmentIds
        .map((segmentId) =>
          timelineState.segments?.find((segment) => segment.id === segmentId)?.label || "",
        )
        .filter(Boolean)
        .slice(0, 3)
    : [];

  el.innerHTML = `
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-user"></i> 当前场景锚点</div>
      <div class="bme-cog-status-card__value">${_escHtml(
        activeOwnerLabels.length > 0
          ? activeOwnerLabels.join(" / ")
          : activeOwner
            ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
            : activeOwnerKey || "—",
      )}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-users"></i> 认知角色数</div>
      <div class="bme-cog-status-card__value">${owners.length}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-clock"></i> 当前剧情时间</div>
      <div class="bme-cog-status-card__value">${_escHtml(activeStoryTimeMeta)}</div>
    </div>
    <div class="bme-cog-status-card">
      <div class="bme-cog-status-card__label"><i class="fa-solid fa-timeline"></i> 最近时间段</div>
      <div class="bme-cog-status-card__value">${_escHtml(recentStorySegments.length ? recentStorySegments.join(" / ") : "—")}</div>
    </div>
  `;
}

function _renderCogOwnerList(graph, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-owner-list");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = "";
    return;
  }

  const { owners, activeOwnerKey, activeOwnerKeys } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);

  if (!owners.length) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">暂无认知角色</div>`;
    return;
  }

  el.innerHTML = owners
    .map((owner) => {
      const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
      const bgColor = _ownerAvatarHsl(displayInfo.avatarSeed);
      const selected = owner.ownerKey === currentCognitionOwnerKey ? "is-selected" : "";
      const anchor =
        owner.ownerKey === activeOwnerKey ||
        activeOwnerKeys.includes(owner.ownerKey)
          ? "is-active-anchor"
          : "";
      return `
        <div class="bme-cog-owner-card ${selected} ${anchor}"
             data-owner-key="${_escHtml(String(owner.ownerKey || ""))}"
             role="button" tabindex="0"
             title="${_escHtml(displayInfo.tooltip)}">
          <div class="bme-cog-avatar" style="background:${bgColor}">${_escHtml(displayInfo.avatarText)}</div>
          <div class="bme-cog-owner-card__info">
            <div class="bme-cog-owner-card__name-row">
              <div class="bme-cog-owner-card__name">${_escHtml(displayInfo.title)}</div>
              <span class="bme-cog-owner-card__badge">${_escHtml(displayInfo.typeLabel)}</span>
            </div>
            <div class="bme-cog-owner-card__stats">已知 ${Number(owner.knownCount || 0)} · 误解 ${Number(owner.mistakenCount || 0)} · 隐藏 ${Number(owner.manualHiddenCount || 0)}</div>
          </div>
        </div>`;
    })
    .join("");
}

function _renderCogOwnerDetail(graph, loadInfo, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-owner-detail");
  if (!el) return;

  if (!canRender) {
    el.innerHTML = "";
    return;
  }

  const { selectedOwner, activeOwnerKey, activeOwnerKeys } =
    _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(
    _getCognitionOwnerCollection(graph),
  );

  if (!selectedOwner) {
    el.innerHTML = `<div class="bme-cog-monitor-empty">选择上方角色查看详情，或等待提取产生认知数据。</div>`;
    return;
  }

  const ownerState = graph?.knowledgeState?.owners?.[selectedOwner.ownerKey] || {
    aliases: selectedOwner.aliases || [],
    visibilityScores: {},
    manualKnownNodeIds: [],
    manualHiddenNodeIds: [],
    mistakenNodeIds: [],
    knownNodeIds: [],
    updatedAt: 0,
  };
  const visibilityEntries = Object.entries(ownerState.visibilityScores || {})
    .map(([nodeId, score]) => ({ nodeId: String(nodeId || ""), score: Number(score || 0) }))
    .filter((e) => e.nodeId)
    .sort((a, b) => b.score - a.score);
  const strongVisibleNames = _collectNodeNames(
    graph,
    visibilityEntries.filter((e) => e.score >= 0.68).map((e) => e.nodeId),
    { limit: 6 },
  );
  const suppressedNames = _collectNodeNames(
    graph,
    [...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])],
    { limit: 6 },
  );
  const selectedNode = _getSelectedGraphNode(graph);
  const selectedNodeLabel = selectedNode ? getNodeDisplayName(selectedNode) : "";
  const selectedNodeState = selectedNode
    ? ownerState.manualKnownNodeIds?.includes(selectedNode.id)
      ? "known"
      : ownerState.manualHiddenNodeIds?.includes(selectedNode.id)
        ? "hidden"
        : ownerState.mistakenNodeIds?.includes(selectedNode.id)
          ? "mistaken"
          : "none"
    : "";
  const stateLabels = { known: "强制已知", hidden: "强制隐藏", mistaken: "误解", none: "未覆盖" };
  const selectedNodeStateLabel = stateLabels[selectedNodeState] || "未选中节点";
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const suppressedCount = new Set([...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])]).size;
  const disabledAttr = !selectedNode || writeBlocked ? "disabled" : "";
  const displayInfo = _getOwnerDisplayInfo(selectedOwner, collisionIndex);
  const isCharacterOwner = String(selectedOwner.ownerType || "") === "character";
  const ownerActionDisabledAttr = writeBlocked || !isCharacterOwner ? "disabled" : "";
  const mergeCandidates = _getCognitionOwnerCollection(graph).filter(
    (entry) =>
      String(entry?.ownerType || "") === "character" &&
      String(entry?.ownerKey || "") !== String(selectedOwner.ownerKey || ""),
  );
  const mergeOptions = mergeCandidates.length
    ? mergeCandidates
        .map((entry) => {
          const targetDisplayInfo = _getOwnerDisplayInfo(entry, collisionIndex);
          return `<option value="${_escAttr(entry.ownerKey || "")}">${_escHtml(targetDisplayInfo.title)}</option>`;
        })
        .join("")
    : '<option value="">暂无可合并目标</option>';
  const mergeDisabledAttr =
    writeBlocked || !isCharacterOwner || mergeCandidates.length === 0 ? "disabled" : "";
  const ownerManagementSection = isCharacterOwner
    ? `
    <div class="bme-cog-override-section">
      <div class="bme-cog-override-title">角色认知管理</div>
      <div class="bme-cog-space-row">
        <label>重命名角色认知</label>
        <input class="bme-config-input" type="text" data-bme-cognition-owner-rename-input
               placeholder="输入新的角色名称..." value="${_escHtml(selectedOwner.ownerName || "")}" ${ownerActionDisabledAttr} />
        <div class="bme-config-help" style="font-size:10px;margin-top:2px">会同步更新 owner 名称、角色节点名和 POV scope，并把旧名加入 aliases。</div>
        <button class="bme-cog-btn bme-cog-btn--known" type="button" data-bme-cognition-owner-action="rename" ${ownerActionDisabledAttr}>重命名</button>
      </div>
      <div class="bme-cog-space-row">
        <label>合并到其他角色认知</label>
        <select class="bme-config-input" data-bme-cognition-owner-merge-target ${mergeDisabledAttr}>${mergeOptions}</select>
        <div class="bme-config-help" style="font-size:10px;margin-top:2px">会把当前角色的 POV scope 改写到目标角色，并合并认知状态与 aliases。</div>
        <button class="bme-cog-btn bme-cog-btn--mistaken" type="button" data-bme-cognition-owner-action="merge" ${mergeDisabledAttr}>合并到目标角色</button>
      </div>
      <div class="bme-cog-space-row">
        <label>删除范围</label>
        <select class="bme-config-input" data-bme-cognition-owner-delete-mode ${ownerActionDisabledAttr}>
          <option value="owner-only">只删除 owner，保留角色节点与 POV</option>
          <option value="archive-character">删除 owner，并归档角色节点</option>
          <option value="archive-all">删除 owner，并归档角色节点与 POV 记忆</option>
        </select>
        <div class="bme-config-help" style="font-size:10px;margin-top:2px">删除前会再次确认；不会无提示直接删除。</div>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" data-bme-cognition-owner-action="delete" ${ownerActionDisabledAttr}>删除角色认知</button>
      </div>
    </div>`
    : `
    <div class="bme-cog-override-section">
      <div class="bme-cog-override-title">角色认知管理</div>
      <div class="bme-cog-override-status">当前条目不是角色 owner，暂不支持重命名、合并或删除。</div>
    </div>`;

  const visChips = strongVisibleNames.length
    ? strongVisibleNames.map((n) => `<span class="bme-cog-chip is-visible">${_escHtml(n)}</span>`).join("")
    : '<span class="bme-cog-chip is-empty">暂无</span>';
  const supChips = suppressedNames.length
    ? suppressedNames.map((n) => `<span class="bme-cog-chip is-suppressed">${_escHtml(n)}</span>`).join("")
    : '<span class="bme-cog-chip is-empty">暂无</span>';

  el.innerHTML = `
    <div class="bme-cog-detail-header">
      <div class="bme-cog-detail-title-wrap">
        <div class="bme-cog-detail-name" title="${_escHtml(displayInfo.tooltip)}">${_escHtml(displayInfo.title)}</div>
        <div class="bme-cog-detail-meta">${_escHtml(
          [displayInfo.subtitle, selectedOwner.ownerKey || ""].filter(Boolean).join(" · "),
        )}</div>
      </div>
      ${
        selectedOwner.ownerKey === activeOwnerKey ||
        activeOwnerKeys.includes(selectedOwner.ownerKey)
          ? '<span class="bme-cog-detail-badge">当前场景锚点</span>'
          : ""
      }
    </div>

    <div class="bme-cog-metrics">
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-known"></span> 已知锚点</div>
        <div class="bme-cog-metric__value">${Number(selectedOwner.knownCount || 0)}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-mistaken"></span> 误解节点</div>
        <div class="bme-cog-metric__value">${Number(selectedOwner.mistakenCount || 0)}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-visible"></span> 强可见</div>
        <div class="bme-cog-metric__value">${strongVisibleNames.length}</div>
      </div>
      <div class="bme-cog-metric">
        <div class="bme-cog-metric__label"><span class="bme-cog-metric-dot dot-suppressed"></span> 被压制</div>
        <div class="bme-cog-metric__value">${suppressedCount}</div>
      </div>
    </div>

    <div class="bme-cog-chip-section">
      <div class="bme-cog-chip-label">强可见节点 · ACTIVE VISIBILITY</div>
      <div class="bme-cog-chip-wrap">${visChips}</div>
    </div>
    <div class="bme-cog-chip-section">
      <div class="bme-cog-chip-label">被压制节点 · SUPPRESSED</div>
      <div class="bme-cog-chip-wrap">${supChips}</div>
    </div>

    ${ownerManagementSection}

    <div class="bme-cog-override-section">
      <div class="bme-cog-override-title">对当前选中节点做手动覆盖</div>
      <div class="bme-cog-override-status">${
        selectedNode
          ? `当前节点：${_escHtml(selectedNodeLabel)} · <span class="bme-cog-status-pill is-${selectedNodeState}">${_escHtml(selectedNodeStateLabel)}</span>`
          : "先在实时图谱或记忆列表中选中一个节点。"
      }</div>
      <div class="bme-cog-override-actions">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" data-bme-cognition-node-action="known" ${disabledAttr}>强制已知</button>
        <button class="bme-cog-btn bme-cog-btn--hidden" type="button" data-bme-cognition-node-action="hidden" ${disabledAttr}>强制隐藏</button>
        <button class="bme-cog-btn bme-cog-btn--mistaken" type="button" data-bme-cognition-node-action="mistaken" ${disabledAttr}>标记误解</button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" data-bme-cognition-node-action="clear" ${disabledAttr}>清除覆盖</button>
      </div>
    </div>
  `;
}

function _renderCogSpaceTools(graph, loadInfo, canRender, targetEl) {
  const el = targetEl || document.getElementById("bme-cog-space-tools");
  if (!el) return;

  if (!canRender) { el.innerHTML = ""; return; }

  const regionState = graph?.regionState || {};
  const historyState = graph?.historyState || {};
  const timelineState = graph?.timelineState || {};
  const activeRegion = String(
    historyState.activeRegion || historyState.lastExtractedRegion || regionState.manualActiveRegion || "",
  ).trim();
  const activeStoryTimeLabel = String(
    historyState.activeStoryTimeLabel || "",
  ).trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent : [];
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const disabledAttr = writeBlocked ? "disabled" : "";
  const manualStorySegmentId = String(timelineState.manualActiveSegmentId || "").trim();

  el.innerHTML = `
    <div class="bme-cog-space-row">
      <label>手动当前地区</label>
      <input class="bme-config-input" type="text" id="bme-cog-manual-region"
             placeholder="输入地区名称..." value="${_escHtml(regionState.manualActiveRegion || activeRegion || "")}" ${disabledAttr} />
      <div class="bme-cog-space-btn-row">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-region-apply" ${disabledAttr}>
          <i class="fa-solid fa-location-dot"></i> 设为当前地区
        </button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" id="bme-cog-region-clear" ${disabledAttr}>
          <i class="fa-solid fa-rotate-left"></i> 恢复自动
        </button>
      </div>
    </div>
    <div class="bme-cog-space-row">
      <label>当前地区邻接</label>
      <input class="bme-config-input" type="text" id="bme-cog-adjacency-input"
             placeholder="例如：内廷, 港口, 花园" value="${_escHtml(adjacentRegions.join(", "))}" ${disabledAttr} />
      <div class="bme-config-help" style="font-size:10px;margin-top:2px">使用 "," 分隔多个地区。保存后更新该地区的邻接关系。</div>
      <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-adjacency-save" ${disabledAttr}>
        <i class="fa-solid fa-diagram-project"></i> 保存当前地区邻接
      </button>
    </div>
    <div class="bme-cog-space-row">
      <label>手动当前剧情时间</label>
      <input class="bme-config-input" type="text" id="bme-cog-manual-story-time"
             placeholder="例如：第二天清晨 / 昨夜之后 / 回忆里的童年" value="${_escHtml(manualStorySegmentId ? activeStoryTimeLabel : activeStoryTimeLabel || "")}" ${disabledAttr} />
      <div class="bme-config-help" style="font-size:10px;margin-top:2px">留空表示恢复自动维护；这里只维护当前剧情时间，不会改写所有节点。</div>
      <div class="bme-cog-space-btn-row">
        <button class="bme-cog-btn bme-cog-btn--known" type="button" id="bme-cog-story-time-apply" ${disabledAttr}>
          <i class="fa-solid fa-clock"></i> 设为当前剧情时间
        </button>
        <button class="bme-cog-btn bme-cog-btn--clear" type="button" id="bme-cog-story-time-clear" ${disabledAttr}>
          <i class="fa-solid fa-rotate-left"></i> 恢复自动
        </button>
      </div>
    </div>
  `;
}

function _formatSummaryEntryCard(entry = {}) {
  const messageRange = Array.isArray(entry?.dialogueRange)
    ? entry.dialogueRange
    : Array.isArray(entry?.messageRange)
      ? entry.messageRange
      : ["?", "?"];
  const extractionRange = Array.isArray(entry?.extractionRange)
    ? entry.extractionRange
    : ["?", "?"];
  const spanLabel = _describeStoryTimeSpanDisplay(entry?.storyTimeSpan);
  const meta = [
    `L${Math.max(0, Number(entry?.level || 0))}`,
    String(entry?.kind || "small"),
    `提取 ${extractionRange[0]} ~ ${extractionRange[1]}`,
    `楼 ${messageRange[0]} ~ ${messageRange[1]}`,
  ].join(" · ");
  const hintLine = [
    Array.isArray(entry?.regionHints) && entry.regionHints.length
      ? `地区: ${entry.regionHints.join(" / ")}`
      : "",
    Array.isArray(entry?.ownerHints) && entry.ownerHints.length
      ? `角色: ${entry.ownerHints.join(" / ")}`
      : "",
    spanLabel ? `时间: ${spanLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <div class="bme-cog-monitor-entry is-success" style="border-left-color:var(--bme-primary)">
      <span class="bme-cog-monitor-badge">${_escHtml(`L${Math.max(0, Number(entry?.level || 0))}`)}</span>
      <span class="bme-cog-monitor-info">${_escHtml(meta)}</span>
      <span class="bme-cog-monitor-duration">${_escHtml(String(entry?.kind || ""))}</span>
      <div class="bme-ai-monitor-entry__summary" style="grid-column:1/-1;margin-top:6px">
        ${_escHtml(String(entry?.text || ""))}
      </div>
      ${
        hintLine
          ? `<div class="bme-config-help" style="grid-column:1/-1;margin-top:4px">${_escHtml(hintLine)}</div>`
          : ""
      }
    </div>
  `;
}

function _refreshSummaryWorkspace(targetEl) {
  const graph = _getGraph?.();
  const loadInfo = _getGraphPersistenceSnapshot();
  const workspace = targetEl || document.getElementById("bme-summary-workspace");
  if (!workspace) return;

  if (!graph || !_canRenderGraphData(loadInfo)) {
    workspace.innerHTML = `
      <div class="bme-cog-monitor-empty">${_escHtml(_getGraphLoadLabel(loadInfo))}</div>
    `;
    return;
  }

  const activeEntries = getActiveSummaryEntries(graph);
  const foldedEntries = getSummaryEntriesByStatus(graph, "folded")
    .sort(compareSummaryEntriesForDisplay)
    .slice(-12)
    .reverse();
  const summaryState = graph?.summaryState || {};
  const historyState = graph?.historyState || {};
  const debugText = [
    `最近已总结提取计数: ${Number(summaryState.lastSummarizedExtractionCount || 0)}`,
    `最近已总结 assistant 楼层: ${Number(summaryState.lastSummarizedAssistantFloor || -1)}`,
    `当前 extractionCount: ${Number(historyState.extractionCount || 0)}`,
  ].join(" · ");

  workspace.innerHTML = `
    <div class="bme-cog-status-strip" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">活跃前沿</div>
        <div class="bme-cog-status-card__value">${activeEntries.length}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">折叠历史</div>
        <div class="bme-cog-status-card__value">${getSummaryEntriesByStatus(graph, "folded").length}</div>
      </div>
      <div class="bme-cog-status-card">
        <div class="bme-cog-status-card__label">summaryState</div>
        <div class="bme-cog-status-card__value">${summaryState.enabled === false ? "off" : "on"}</div>
      </div>
    </div>

    <div class="bme-task-toolbar-row" style="margin-bottom:12px">
      <div class="bme-task-toolbar-inline">
        <button class="bme-config-secondary-btn" id="bme-summary-generate" type="button">立即生成小总结</button>
        <button class="bme-config-secondary-btn" id="bme-summary-rollup" type="button">立即执行折叠</button>
        <button class="bme-config-secondary-btn" id="bme-summary-rebuild" type="button">重建总结状态</button>
      </div>
    </div>

    <div class="bme-config-help" style="margin-bottom:12px">${_escHtml(debugText)}</div>

    <div class="bme-cog-section-title"><i class="fa-solid fa-layer-group"></i> 活跃总结前沿</div>
    <div class="bme-cog-monitor-mini" style="margin-bottom:14px">
      ${activeEntries.length > 0
        ? activeEntries.map((entry) => _formatSummaryEntryCard(entry)).join("")
        : '<div class="bme-cog-monitor-empty">当前还没有活跃总结前沿。</div>'}
    </div>

    <div class="bme-cog-section-title"><i class="fa-solid fa-box-archive"></i> 折叠历史</div>
    <div class="bme-cog-monitor-mini">
      ${foldedEntries.length > 0
        ? foldedEntries.map((entry) => _formatSummaryEntryCard(entry)).join("")
        : '<div class="bme-cog-monitor-empty">当前还没有折叠历史。</div>'}
    </div>
  `;
}

function _openFullscreenGraph() {
  const overlay = document.getElementById("bme-fullscreen-graph");
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function _closeFullscreenGraph() {
  const overlay = document.getElementById("bme-fullscreen-graph");
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}



function _switchConfigSection(sectionId) {
  currentConfigSectionId = sectionId || "toggles";
  _syncConfigSectionState();
  if (currentConfigSectionId === "prompts") {
    _refreshTaskProfileWorkspace();
  } else if (currentConfigSectionId === "trace") {
    _refreshMessageTraceWorkspace();
  } else if (currentConfigSectionId === "planner") {
    _refreshPlannerLauncher();
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
    _setText("bme-status-history", _getGraphLoadLabel(loadInfo));
    _setText("bme-status-vector", "等待聊天图谱元数据加载");
    _setText("bme-status-recovery", "等待聊天图谱元数据加载");
    _setText("bme-status-last-extract", "等待聊天图谱元数据加载");
    _setText("bme-status-last-persist", "等待聊天图谱元数据加载");
    _setText("bme-status-last-vector", "等待聊天图谱元数据加载");
    _setText("bme-status-last-recall", "等待聊天图谱元数据加载");
    _refreshPersistenceRepairUi(loadInfo, null);
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-extract"),
      _getGraphLoadLabel(loadInfo),
    );
    _renderStatefulListPlaceholder(
      document.getElementById("bme-recent-recall"),
      _getGraphLoadLabel(loadInfo),
    );
    _refreshCognitionDashboard(graph, loadInfo);
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
  const lastBatchStatus = _getLatestBatchStatusSnapshot();
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
    `${historyPrefix}${_formatDashboardHistoryMeta(graph, loadInfo, lastBatchStatus)}`,
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
  _setText(
    "bme-status-last-persist",
    _formatDashboardPersistMeta(loadInfo, lastBatchStatus),
  );
  _refreshPersistenceRepairUi(loadInfo, lastBatchStatus);
  _setText("bme-status-last-vector", vectorStatus.meta || "尚未执行向量任务");
  _setText("bme-status-last-recall", recallStatus.meta || "尚未执行召回");

  _refreshCognitionDashboard(graph);
  _renderRecentList("bme-recent-extract", _getLastExtract?.() || []);
  _renderRecentList("bme-recent-recall", _getLastRecall?.() || []);
}

function _setInputValueIfIdle(elementId, value = "") {
  const input = document.getElementById(elementId);
  if (!input) return;
  if (document.activeElement === input) return;
  input.value = String(value || "");
}

function _getSelectedGraphNode(graph = _getGraph?.()) {
  const detailNodeId = String(
    document.getElementById("bme-node-detail")?.dataset?.editNodeId ||
      document.getElementById("bme-mobile-node-detail")?.dataset?.editNodeId ||
      "",
  ).trim();
  const rendererNodeId = String(
    _getActiveGraphRenderer()?.selectedNode?.id || "",
  ).trim();
  const nodeId = detailNodeId || rendererNodeId;
  if (!nodeId || !Array.isArray(graph?.nodes)) return null;
  return graph.nodes.find((node) => String(node?.id || "") === nodeId) || null;
}

function _getCognitionOwnerCollection(graph) {
  return typeof listKnowledgeOwners === "function" ? listKnowledgeOwners(graph) : [];
}

function _getLatestRecallOwnerInfo(graph) {
  const runtimeDebug = _getRuntimeDebugSnapshot?.() || {};
  const recallInjection =
    runtimeDebug?.runtimeDebug?.injections?.recall || {};
  const retrievalMeta = recallInjection?.retrievalMeta || {};
  const owners = _getCognitionOwnerCollection(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const ownerCandidates = Array.isArray(retrievalMeta.sceneOwnerCandidates)
    ? retrievalMeta.sceneOwnerCandidates
    : [];
  const ownerKeys = Array.isArray(retrievalMeta.activeRecallOwnerKeys)
    ? retrievalMeta.activeRecallOwnerKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const fallbackOwnerKey = String(graph?.historyState?.activeRecallOwnerKey || "").trim();
  const normalizedOwnerKeys = ownerKeys.length > 0
    ? [...new Set(ownerKeys)]
    : fallbackOwnerKey
      ? [fallbackOwnerKey]
      : [];
  const ownerLabels = normalizedOwnerKeys.map((ownerKey) => {
    const ownerEntry = owners.find((entry) => entry.ownerKey === ownerKey);
    if (ownerEntry) {
      return _getOwnerDisplayInfo(ownerEntry, collisionIndex).title;
    }
    const candidateMatch = ownerCandidates.find(
      (candidate) => String(candidate?.ownerKey || "").trim() === ownerKey,
    );
    if (candidateMatch?.ownerName) {
      return _getOwnerDisplayInfo(
        {
          ownerKey,
          ownerName: candidateMatch.ownerName,
          ownerType: _inferOwnerTypeFromKey(ownerKey),
        },
        collisionIndex,
      ).title;
    }
    return _getOwnerDisplayInfo({ ownerKey }, collisionIndex).title;
  });

  return {
    ownerKeys: normalizedOwnerKeys,
    ownerLabels,
    resolutionMode: String(retrievalMeta.sceneOwnerResolutionMode || "").trim() || "fallback",
  };
}

function _getCurrentCognitionOwnerSummary(graph) {
  const owners = _getCognitionOwnerCollection(graph);
  const recallOwnerInfo = _getLatestRecallOwnerInfo(graph);
  const activeOwnerKey = String(recallOwnerInfo.ownerKeys[0] || "").trim();
  if (!owners.some((entry) => entry.ownerKey === currentCognitionOwnerKey)) {
    currentCognitionOwnerKey =
      activeOwnerKey && owners.some((entry) => entry.ownerKey === activeOwnerKey)
        ? activeOwnerKey
        : owners[0]?.ownerKey || "";
  }
  const selectedOwner =
    owners.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  const activeOwner =
    owners.find((entry) => entry.ownerKey === activeOwnerKey) || null;
  return {
    owners,
    activeOwnerKeys: recallOwnerInfo.ownerKeys,
    activeOwnerLabels: recallOwnerInfo.ownerLabels,
    sceneOwnerResolutionMode: recallOwnerInfo.resolutionMode,
    activeOwnerKey,
    selectedOwner,
    activeOwner,
  };
}

function _collectNodeNames(graph, nodeIds = [], { limit = 4 } = {}) {
  const seen = new Set();
  const result = [];
  for (const nodeId of Array.isArray(nodeIds) ? nodeIds : []) {
    const normalizedNodeId = String(nodeId || "").trim();
    if (!normalizedNodeId || seen.has(normalizedNodeId)) continue;
    seen.add(normalizedNodeId);
    const node =
      Array.isArray(graph?.nodes)
        ? graph.nodes.find((item) => String(item?.id || "") === normalizedNodeId)
        : null;
    result.push(node ? getNodeDisplayName(node) : normalizedNodeId);
    if (result.length >= limit) break;
  }
  return result;
}

function _renderCognitionOwnerList(
  graph,
  { owners = [], activeOwnerKey = "", activeOwnerKeys = [] } = {},
) {
  const listEl = document.getElementById("bme-cognition-owner-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const collisionIndex = _buildOwnerCollisionIndex(owners);

  if (!owners.length) {
    const li = document.createElement("li");
    li.className = "bme-recent-item";
    li.textContent = "暂无认知角色";
    listEl.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const owner of owners) {
    const displayInfo = _getOwnerDisplayInfo(owner, collisionIndex);
    const li = document.createElement("li");
    li.className = "bme-cognition-owner-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "bme-cognition-owner-btn";
    if (owner.ownerKey === currentCognitionOwnerKey) {
      button.classList.add("is-selected");
    }
    if (owner.ownerKey === activeOwnerKey || activeOwnerKeys.includes(owner.ownerKey)) {
      button.classList.add("is-active-anchor");
    }
    button.dataset.ownerKey = String(owner.ownerKey || "");
    button.title = displayInfo.tooltip;

    const title = document.createElement("div");
    title.className = "bme-cognition-owner-btn__title";
    title.textContent = displayInfo.title;

    const meta = document.createElement("div");
    meta.className = "bme-cognition-owner-btn__meta";
    meta.textContent = [
      displayInfo.subtitle,
      `已知 ${Number(owner.knownCount || 0)}`,
      `误解 ${Number(owner.mistakenCount || 0)}`,
      `隐藏 ${Number(owner.manualHiddenCount || 0)}`,
    ].join(" · ");

    button.append(title, meta);
    li.appendChild(button);
    fragment.appendChild(li);
  }
  listEl.appendChild(fragment);
}

function _renderCognitionDetail(
  graph,
  {
    selectedOwner = null,
    activeOwnerKey = "",
    activeOwnerKeys = [],
    activeRegion = "",
    adjacentRegions = [],
  } = {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const detailEl = document.getElementById("bme-cognition-detail");
  if (!detailEl) return;

  if (!selectedOwner) {
    detailEl.innerHTML = `
      <div class="bme-cognition-empty">
        还没有可查看的角色认知。进入一段正常对话并完成提取后，这里会出现角色列表和认知详情。
      </div>
    `;
    return;
  }

  const ownerState =
    graph?.knowledgeState?.owners?.[selectedOwner.ownerKey] || {
      aliases: selectedOwner.aliases || [],
      visibilityScores: {},
      manualKnownNodeIds: [],
      manualHiddenNodeIds: [],
      mistakenNodeIds: [],
      knownNodeIds: [],
      updatedAt: 0,
      lastSource: "",
    };
  const visibilityEntries = Object.entries(ownerState.visibilityScores || {})
    .map(([nodeId, score]) => ({
      nodeId: String(nodeId || ""),
      score: Number(score || 0),
    }))
    .filter((entry) => entry.nodeId)
    .sort((left, right) => right.score - left.score);
  const strongVisibleNames = _collectNodeNames(
    graph,
    visibilityEntries.filter((entry) => entry.score >= 0.68).map((entry) => entry.nodeId),
    { limit: 5 },
  );
  const suppressedNames = _collectNodeNames(
    graph,
    [
      ...(ownerState.manualHiddenNodeIds || []),
      ...(ownerState.mistakenNodeIds || []),
    ],
    { limit: 5 },
  );
  const selectedNode = _getSelectedGraphNode(graph);
  const selectedNodeLabel = selectedNode ? getNodeDisplayName(selectedNode) : "";
  const selectedNodeState = selectedNode
    ? ownerState.manualKnownNodeIds?.includes(selectedNode.id)
      ? "强制已知"
      : ownerState.manualHiddenNodeIds?.includes(selectedNode.id)
        ? "强制隐藏"
        : ownerState.mistakenNodeIds?.includes(selectedNode.id)
          ? "误解"
          : "未覆盖"
    : "未选中节点";
  const writeBlocked = _isGraphWriteBlocked(loadInfo);
  const aliases = Array.isArray(ownerState.aliases) ? ownerState.aliases : [];
  const collisionIndex = _buildOwnerCollisionIndex(_getCognitionOwnerCollection(graph));
  const displayInfo = _getOwnerDisplayInfo(selectedOwner, collisionIndex);

  detailEl.innerHTML = `
    <div class="bme-cognition-detail-card">
      <div class="bme-config-card-head">
        <div>
          <div class="bme-config-card-title">${_escHtml(
            displayInfo.title,
          )}</div>
          <div class="bme-config-card-subtitle">
            ${_escHtml(
              [displayInfo.subtitle, String(selectedOwner.ownerKey || "")]
                .filter(Boolean)
                .join(" · "),
            )}
          </div>
        </div>
        ${
          selectedOwner.ownerKey === activeOwnerKey ||
          activeOwnerKeys.includes(selectedOwner.ownerKey)
            ? '<span class="bme-task-pill">当前场景锚点</span>'
            : ""
        }
      </div>

      <div class="bme-cognition-metrics">
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">已知锚点</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(selectedOwner.knownCount || 0),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">误解节点</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(selectedOwner.mistakenCount || 0),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">强可见</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(strongVisibleNames.length),
          )}</strong>
        </div>
        <div class="bme-cognition-metric">
          <span class="bme-cognition-metric__label">被压制</span>
          <strong class="bme-cognition-metric__value">${_escHtml(
            String(new Set([...(ownerState.manualHiddenNodeIds || []), ...(ownerState.mistakenNodeIds || [])]).size),
          )}</strong>
        </div>
      </div>

      <div class="bme-cognition-line-list">
        <div class="bme-cognition-line">
          <span>别名</span>
          <strong>${_escHtml(aliases.length ? aliases.join(" / ") : "—")}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>当前地区</span>
          <strong>${_escHtml(activeRegion || "—")}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>邻接地区</span>
          <strong>${_escHtml(adjacentRegions.length ? adjacentRegions.join(" / ") : "—")}</strong>
        </div>
        <div class="bme-cognition-line">
          <span>最近更新</span>
          <strong>${_escHtml(
            ownerState.updatedAt ? _formatTaskProfileTime(new Date(ownerState.updatedAt).toISOString()) : "暂无",
          )}</strong>
        </div>
      </div>

      <div class="bme-cognition-chip-group">
        <div class="bme-cognition-chip-group__label">强可见节点</div>
        <div class="bme-cognition-chip-wrap">
          ${
            strongVisibleNames.length
              ? strongVisibleNames
                  .map((name) => `<span class="bme-cognition-chip">${_escHtml(name)}</span>`)
                  .join("")
              : '<span class="bme-cognition-chip is-empty">暂无</span>'
          }
        </div>
      </div>

      <div class="bme-cognition-chip-group">
        <div class="bme-cognition-chip-group__label">被压制节点</div>
        <div class="bme-cognition-chip-wrap">
          ${
            suppressedNames.length
              ? suppressedNames
                  .map((name) => `<span class="bme-cognition-chip is-muted">${_escHtml(name)}</span>`)
                  .join("")
              : '<span class="bme-cognition-chip is-empty">暂无</span>'
          }
        </div>
      </div>

      <div class="bme-cognition-node-override">
        <div class="bme-cognition-node-override__title">对当前选中节点做手动覆盖</div>
        <div class="bme-config-help">
          ${
            selectedNode
              ? `当前节点：${_escHtml(selectedNodeLabel)} · 该角色当前状态：${_escHtml(selectedNodeState)}`
              : "先在图谱或记忆列表中点一个节点，再回来做手动覆盖。"
          }
        </div>
        <div class="bme-cognition-node-actions">
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="known"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            强制已知
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="hidden"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            强制隐藏
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="mistaken"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            标记误解
          </button>
          <button
            class="bme-config-secondary-btn"
            type="button"
            data-bme-cognition-node-action="clear"
            ${!selectedNode || writeBlocked ? "disabled" : ""}
          >
            清除覆盖
          </button>
        </div>
      </div>
    </div>
  `;
}

function _refreshCognitionDashboard(
  graph,
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const canRenderGraph =
    Boolean(graph) &&
    (_canRenderGraphData(loadInfo) || loadInfo.loadState === "empty-confirmed");
  const manualRegionInput = document.getElementById("bme-cognition-manual-region");
  const adjacencyInput = document.getElementById("bme-cognition-adjacency-input");
  if (manualRegionInput) manualRegionInput.disabled = !canRenderGraph || _isGraphWriteBlocked(loadInfo);
  if (adjacencyInput) adjacencyInput.disabled = !canRenderGraph || _isGraphWriteBlocked(loadInfo);

  if (!canRenderGraph) {
    _setText("bme-cognition-active-owner", "—");
    _setText("bme-cognition-active-region", _getGraphLoadLabel(loadInfo));
    _setText("bme-cognition-adjacent-regions", "—");
    _setText("bme-cognition-owner-count", "—");
    _renderStatefulListPlaceholder(
      document.getElementById("bme-cognition-owner-list"),
      _getGraphLoadLabel(loadInfo),
    );
    const detailEl = document.getElementById("bme-cognition-detail");
    if (detailEl) {
      detailEl.innerHTML = `
        <div class="bme-cognition-empty">${_escHtml(_getGraphLoadLabel(loadInfo))}</div>
      `;
    }
    _setInputValueIfIdle("bme-cognition-manual-region", "");
    _setInputValueIfIdle("bme-cognition-adjacency-input", "");
    return;
  }

  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const {
    owners,
    activeOwnerKey,
    activeOwnerLabels,
    selectedOwner,
    activeOwner,
  } = _getCurrentCognitionOwnerSummary(graph);
  const collisionIndex = _buildOwnerCollisionIndex(owners);
  const activeRegion = String(
    historyState.activeRegion ||
      historyState.lastExtractedRegion ||
      regionState.manualActiveRegion ||
      "",
  ).trim();
  const activeRegionLabel = activeRegion
    ? `${activeRegion}${
        historyState.activeRegionSource ? ` · ${historyState.activeRegionSource}` : ""
      }`
    : "—";
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];

  _setText(
    "bme-cognition-active-owner",
    activeOwnerLabels.length > 0
      ? activeOwnerLabels.join(" / ")
      : activeOwner
        ? _getOwnerDisplayInfo(activeOwner, collisionIndex).title
        : activeOwnerKey || "—",
  );
  _setText("bme-cognition-active-region", activeRegionLabel || "—");
  _setText(
    "bme-cognition-adjacent-regions",
    adjacentRegions.length > 0 ? adjacentRegions.join(" / ") : "—",
  );
  _setText("bme-cognition-owner-count", owners.length);
  // Cognition view workspace refresh (if visible)
  if (currentGraphView === "cognition") {
    _refreshCognitionWorkspace();
  }
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
  const floorInput = document.getElementById("bme-memory-floor-filter");
  const filterSelect = document.getElementById("bme-memory-filter");
  const listEl = document.getElementById("bme-memory-list");
  if (!listEl) return;

  const canRenderGraph = _canRenderGraphData(loadInfo);
  if (searchInput) searchInput.disabled = !canRenderGraph;
  if (regionInput) regionInput.disabled = !canRenderGraph;
  if (floorInput) floorInput.disabled = !canRenderGraph;
  if (filterSelect) filterSelect.disabled = !canRenderGraph;

  if (!canRenderGraph && loadInfo.loadState !== "empty-confirmed") {
    _renderStatefulListPlaceholder(listEl, _getGraphLoadLabel(loadInfo));
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
        ...(Array.isArray(scope.regionPath) ? scope.regionPath : []),
        ...(Array.isArray(scope.regionSecondary) ? scope.regionSecondary : []),
      ]
        .join(" ")
        .toLowerCase();
      return regionText.includes(regionQuery);
    });
  }

  const floorQuery = String(floorInput?.value || "").trim();
  if (floorQuery) {
    const floorFilter = _parseFloorFilter(floorQuery);
    if (floorFilter) {
      nodes = nodes.filter((node) => _matchesFloorFilter(node, floorFilter));
    }
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
    floorInput?.addEventListener("input", () => {
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
    const { estimateTokens } = await import("../retrieval/injector.js");
    const totalTokens = estimateTokens(injection);
    const preview = _buildInjectionPreviewNode(injection);
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

function _buildInjectionPreviewNode(injectionText = "") {
  const parsed = _parseInjectionPreview(String(injectionText || ""));
  if (!parsed.sections.length) {
    const preview = document.createElement("div");
    preview.className = "bme-injection-preview";
    preview.textContent = injectionText;
    return preview;
  }

  const root = document.createElement("div");
  root.className = "bme-injection-rich";

  const hint = document.createElement("div");
  hint.className = "bme-injection-rich__hint";
  hint.textContent = "这里是结构化预览，便于阅读；实际发给模型的仍是原始注入文本。";
  root.appendChild(hint);

  for (const section of parsed.sections) {
    const card = document.createElement("section");
    card.className = `bme-injection-card ${_getInjectionSectionFlavor(section.title)}`;

    const title = document.createElement("div");
    title.className = "bme-injection-card__title";
    title.textContent = section.title;
    card.appendChild(title);

    if (section.note) {
      const note = document.createElement("div");
      note.className = "bme-injection-card__note";
      note.textContent = section.note;
      card.appendChild(note);
    }

    for (const block of section.blocks) {
      if (block.type === "table") {
        card.appendChild(_buildInjectionTableNode(block));
      } else if (block.type === "text" && block.text) {
        const text = document.createElement("div");
        text.className = "bme-injection-card__text";
        text.textContent = block.text;
        card.appendChild(text);
      }
    }

    root.appendChild(card);
  }

  return root;
}

function _parseInjectionPreview(injectionText = "") {
  const lines = String(injectionText || "").replace(/\r/g, "").split("\n");
  const sections = [];
  let index = 0;
  let currentSection = null;

  function ensureSection(title = "Memory") {
    if (!currentSection) {
      currentSection = {
        title,
        note: "",
        blocks: [],
      };
      sections.push(currentSection);
    }
    return currentSection;
  }

  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    const sectionMatch = line.match(/^\[(Memory\s*-\s*.+)]$/i);
    if (sectionMatch) {
      currentSection = {
        title: sectionMatch[1],
        note: "",
        blocks: [],
      };
      sections.push(currentSection);
      index += 1;

      const noteCandidate = (lines[index] ?? "").trim();
      if (
        noteCandidate &&
        !noteCandidate.startsWith("[") &&
        !noteCandidate.endsWith(":") &&
        !noteCandidate.startsWith("|") &&
        !noteCandidate.startsWith("## ")
      ) {
        currentSection.note = noteCandidate;
        index += 1;
      }
      continue;
    }

    const section = ensureSection();

    if (line.endsWith(":") && String(lines[index + 1] || "").trim().startsWith("|")) {
      const tableName = line.slice(0, -1).trim();
      const tableLines = [];
      index += 1;
      while (index < lines.length) {
        const tableLine = String(lines[index] || "");
        if (!tableLine.trim().startsWith("|")) {
          break;
        }
        tableLines.push(tableLine.trim());
        index += 1;
      }
      const parsedTable = _parseInjectionTable(tableName, tableLines);
      if (parsedTable) {
        section.blocks.push(parsedTable);
      }
      continue;
    }

    const textLines = [];
    while (index < lines.length) {
      const candidate = String(lines[index] || "").trim();
      if (!candidate) {
        index += 1;
        if (textLines.length > 0) {
          break;
        }
        continue;
      }
      if (
        /^\[(Memory\s*-\s*.+)]$/i.test(candidate) ||
        (candidate.endsWith(":") && String(lines[index + 1] || "").trim().startsWith("|"))
      ) {
        break;
      }
      textLines.push(candidate);
      index += 1;
    }
    if (textLines.length > 0) {
      section.blocks.push({
        type: "text",
        text: textLines.join("\n"),
      });
    }
  }

  return { sections };
}

function _parseInjectionTable(tableName, tableLines = []) {
  if (!Array.isArray(tableLines) || tableLines.length < 2) {
    return null;
  }

  const headerCells = _splitInjectionTableRow(tableLines[0]);
  if (!headerCells.length) {
    return null;
  }

  const rows = tableLines
    .slice(2)
    .map((row) => _splitInjectionTableRow(row))
    .filter((cells) => cells.length > 0);

  return {
    type: "table",
    name: tableName,
    headers: headerCells,
    rows,
  };
}

function _splitInjectionTableRow(row = "") {
  const text = String(row || "").trim();
  if (!text.startsWith("|")) {
    return [];
  }

  const inner = text.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;

  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }

  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function _buildInjectionTableNode(table) {
  const wrap = document.createElement("div");
  wrap.className = "bme-injection-table-wrap";

  const name = document.createElement("div");
  name.className = "bme-injection-table-name";
  name.textContent = table.name;
  wrap.appendChild(name);

  const tableEl = document.createElement("table");
  tableEl.className = "bme-injection-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of table.headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    const normalizedCells = table.headers.map((_, idx) => row[idx] ?? "");
    for (const cell of normalizedCells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tableEl.appendChild(tbody);
  wrap.appendChild(tableEl);
  return wrap;
}

function _getInjectionSectionFlavor(title = "") {
  const normalized = String(title || "").toLowerCase();
  if (normalized.includes("character pov")) return "character-pov";
  if (normalized.includes("user pov")) return "user-pov";
  if (normalized.includes("current region")) return "objective-current";
  if (normalized.includes("global")) return "objective-global";
  return "generic";
}

// ==================== 图谱 ====================

/** SillyTavern 用户显示名（name1），用于图谱分区：误标为角色的用户 POV 强制归用户区 */
function _hostUserPovAliasHintsForGraph() {
  return getHostUserAliasHints();
}

function _refreshGraph(options = {}) {
  return _refreshVisibleGraphWorkspace({ force: options.force !== false });
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
    { key: "synopsis", label: "全局概要（旧）" },
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

function _resolveVisibleGraphRenderer() {
  const visibleMode = _getVisibleGraphWorkspaceMode();
  if (visibleMode.startsWith("mobile:")) {
    return mobileGraphRenderer || graphRenderer;
  }
  if (visibleMode.startsWith("desktop:")) {
    return graphRenderer || mobileGraphRenderer;
  }
  return _getActiveGraphRenderer();
}

function _formatGraphLayoutDiagnosticsText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return "LAYOUT: --";
  }

  const modeRaw = String(
    diagnostics.mode || diagnostics.solver || "",
  ).trim();
  const modeMap = {
    "js-main": "JS-main",
    "js-worker": "JS-worker",
    "rust-wasm-worker": "Rust-WASM",
    "js-fallback": "JS-fallback",
    skipped: "skipped",
    "native-stale": "stale",
    "native-failed-hard": "native-failed",
  };
  const modeLabel = modeMap[modeRaw] || modeRaw || "unknown";

  const totalMs = Number(
    diagnostics.totalMs ?? diagnostics.solveMs ?? diagnostics.workerSolveMs,
  );
  const nodeCount = Number(diagnostics.nodeCount);
  const edgeCount = Number(diagnostics.edgeCount);

  const parts = [`LAYOUT: ${modeLabel}`];
  if (Number.isFinite(totalMs)) {
    parts.push(`${Math.max(0, Math.round(totalMs))}ms`);
  }
  if (Number.isFinite(nodeCount) && Number.isFinite(edgeCount)) {
    parts.push(
      `${Math.max(0, Math.floor(nodeCount))}/${Math.max(
        0,
        Math.floor(edgeCount),
      )}`,
    );
  }

  return parts.join(" · ");
}

function _refreshGraphLayoutDiagnosticsUi() {
  const desktopMeta = document.getElementById("bme-graph-layout-meta");
  const mobileMeta = document.getElementById("bme-mobile-graph-layout-meta");
  if (!desktopMeta && !mobileMeta) return;

  const renderer = _resolveVisibleGraphRenderer();
  const diagnostics = renderer?.getLastLayoutDiagnostics?.() || null;
  const text = _formatGraphLayoutDiagnosticsText(diagnostics);
  const title = diagnostics?.reason
    ? `layout reason: ${String(diagnostics.reason).trim()}`
    : "";

  if (desktopMeta) {
    desktopMeta.textContent = text;
    if (title) {
      desktopMeta.title = title;
    } else {
      desktopMeta.removeAttribute("title");
    }
  }

  if (mobileMeta) {
    mobileMeta.textContent = text;
    if (title) {
      mobileMeta.title = title;
    } else {
      mobileMeta.removeAttribute("title");
    }
  }
}

function _bindGraphControls() {
  document
    .getElementById("bme-graph-render-toggle")
    ?.addEventListener("click", () => _toggleGraphRenderingEnabled());
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

const STORY_TIME_TENSE_OPTIONS = Object.freeze([
  { value: "past", label: "过去" },
  { value: "ongoing", label: "进行中" },
  { value: "future", label: "未来" },
  { value: "flashback", label: "闪回" },
  { value: "hypothetical", label: "假设" },
  { value: "unknown", label: "未知" },
]);

const STORY_TIME_RELATION_OPTIONS = Object.freeze([
  { value: "same", label: "同一时点" },
  { value: "after", label: "在锚点之后" },
  { value: "before", label: "在锚点之前" },
  { value: "parallel", label: "与锚点并行" },
  { value: "unknown", label: "未知" },
]);

const STORY_TIME_CONFIDENCE_OPTIONS = Object.freeze([
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
]);

const STORY_TIME_SOURCE_OPTIONS = Object.freeze([
  { value: "extract", label: "提取" },
  { value: "derived", label: "推导" },
  { value: "manual", label: "手动" },
]);

const STORY_TIME_MIXED_OPTIONS = Object.freeze([
  { value: "false", label: "否" },
  { value: "true", label: "是" },
]);

function _resolveNodeDetailOptionLabel(options = [], value, fallback = "") {
  return (
    options.find((option) => option.value === String(value ?? ""))?.label ||
    fallback ||
    String(value ?? "")
  );
}

function _describeStoryTimeDisplay(storyTime = {}) {
  const normalized = normalizeStoryTime(storyTime);
  if (!normalized.label) return "";

  const parts = [normalized.label];
  if (normalized.tense && normalized.tense !== "unknown") {
    parts.push(
      _resolveNodeDetailOptionLabel(STORY_TIME_TENSE_OPTIONS, normalized.tense),
    );
  }
  if (
    normalized.relation &&
    normalized.relation !== "unknown" &&
    normalized.relation !== "same"
  ) {
    const relationLabel = _resolveNodeDetailOptionLabel(
      STORY_TIME_RELATION_OPTIONS,
      normalized.relation,
    );
    parts.push(
      normalized.anchorLabel
        ? `${relationLabel} · ${normalized.anchorLabel}`
        : relationLabel,
    );
  } else if (normalized.anchorLabel) {
    parts.push(`锚点 · ${normalized.anchorLabel}`);
  }

  return parts.join(" · ");
}

function _describeStoryTimeSpanDisplay(storyTimeSpan = {}) {
  const normalized = normalizeStoryTimeSpan(storyTimeSpan);
  const label =
    normalized.startLabel &&
    normalized.endLabel &&
    normalized.startLabel !== normalized.endLabel
      ? `${normalized.startLabel} → ${normalized.endLabel}`
      : normalized.startLabel || normalized.endLabel || "";

  if (!label) {
    return normalized.mixed ? "混合时间" : "";
  }
  return normalized.mixed ? `${label} · 混合` : label;
}

function _describeNodeStoryTimeDisplay(node = {}) {
  return (
    _describeStoryTimeDisplay(node.storyTime) ||
    _describeStoryTimeSpanDisplay(node.storyTimeSpan) ||
    ""
  );
}

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

function _appendNodeDetailSelectInput(
  container,
  labelText,
  inputId,
  value,
  options = [],
) {
  const row = document.createElement("div");
  row.className = "bme-node-detail-field";
  const label = document.createElement("label");
  label.setAttribute("for", inputId);
  label.textContent = labelText;
  const select = document.createElement("select");
  select.id = inputId;
  select.className = "bme-node-detail-input";
  options.forEach((option) => {
    const optEl = document.createElement("option");
    optEl.value = option.value;
    optEl.textContent = option.label;
    select.appendChild(optEl);
  });
  select.value = String(value ?? "");
  row.append(label, select);
  container.appendChild(row);
}

function _parseNodeDetailScopeList(rawValue, { allowSlash = true } = {}) {
  const normalized = String(rawValue ?? "")
    .replace(/[＞>→]+/g, "/")
    .replace(/\r/g, "\n");
  const separatorPattern = allowSlash ? /[,\n，/\\]+/ : /[,\n，]+/;
  const values = normalized
    .split(separatorPattern)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(values)];
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

function _buildNodeDetailEditorFragment(raw, { idPrefix = "bme-detail" } = {}) {
  const fields = raw.fields || {};
  const scope = normalizeMemoryScope(raw.scope);
  const storyTime = normalizeStoryTime(raw.storyTime);
  const storyTimeSpan = normalizeStoryTimeSpan(raw.storyTimeSpan);
  const fragment = document.createDocumentFragment();
  const inputId = (suffix) => `${idPrefix}-${suffix}`;

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
  _appendNodeDetailTextInput(
    fragment,
    "主地区",
    inputId("scope-region-primary"),
    scope.regionPrimary || "",
  );
  _appendNodeDetailTextInput(
    fragment,
    "地区路径 (用 / 分隔)",
    inputId("scope-region-path"),
    Array.isArray(scope.regionPath) ? scope.regionPath.join(" / ") : "",
  );
  _appendNodeDetailTextInput(
    fragment,
    "次级地区 (用逗号或 / 分隔)",
    inputId("scope-region-secondary"),
    Array.isArray(scope.regionSecondary)
      ? scope.regionSecondary.join(", ")
      : "",
  );
  if (Array.isArray(raw.seqRange)) {
    _appendNodeDetailReadOnly(
      fragment,
      "序列范围",
      `${raw.seqRange[0]} ~ ${raw.seqRange[1]}`,
    );
  }
  const storyTimeSection = document.createElement("div");
  storyTimeSection.className = "bme-node-detail-section";
  storyTimeSection.textContent = "剧情时间";
  fragment.appendChild(storyTimeSection);
  _appendNodeDetailReadOnly(
    fragment,
    "当前摘要",
    _describeStoryTimeDisplay(storyTime) || "—",
  );
  _appendNodeDetailTextInput(
    fragment,
    "时间标签",
    inputId("story-time-label"),
    storyTime.label,
  );
  _appendNodeDetailSelectInput(
    fragment,
    "时态",
    inputId("story-time-tense"),
    storyTime.tense,
    STORY_TIME_TENSE_OPTIONS,
  );

  const storyTimeAdvanced = document.createElement("details");
  storyTimeAdvanced.className = "bme-node-detail-collapse";
  const storyTimeAdvancedSummary = document.createElement("summary");
  storyTimeAdvancedSummary.textContent = "高级";
  storyTimeAdvanced.appendChild(storyTimeAdvancedSummary);
  _appendNodeDetailSelectInput(
    storyTimeAdvanced,
    "相对关系",
    inputId("story-time-relation"),
    storyTime.relation,
    STORY_TIME_RELATION_OPTIONS,
  );
  _appendNodeDetailTextInput(
    storyTimeAdvanced,
    "锚点标签",
    inputId("story-time-anchor-label"),
    storyTime.anchorLabel,
  );
  _appendNodeDetailSelectInput(
    storyTimeAdvanced,
    "置信度",
    inputId("story-time-confidence"),
    storyTime.confidence,
    STORY_TIME_CONFIDENCE_OPTIONS,
  );
  _appendNodeDetailSelectInput(
    storyTimeAdvanced,
    "来源",
    inputId("story-time-source"),
    storyTime.source,
    STORY_TIME_SOURCE_OPTIONS,
  );
  _appendNodeDetailTextInput(
    storyTimeAdvanced,
    "段 ID",
    inputId("story-time-segment-id"),
    storyTime.segmentId,
  );
  fragment.appendChild(storyTimeAdvanced);

  const storyTimeSpanCollapse = document.createElement("details");
  storyTimeSpanCollapse.className = "bme-node-detail-collapse";
  const storyTimeSpanSummaryEl = document.createElement("summary");
  storyTimeSpanSummaryEl.className = "bme-node-detail-section";
  storyTimeSpanSummaryEl.textContent = "剧情时间范围";
  storyTimeSpanCollapse.appendChild(storyTimeSpanSummaryEl);
  _appendNodeDetailReadOnly(
    storyTimeSpanCollapse,
    "当前范围",
    _describeStoryTimeSpanDisplay(storyTimeSpan) || "—",
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "起点标签",
    inputId("story-time-span-start-label"),
    storyTimeSpan.startLabel,
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "终点标签",
    inputId("story-time-span-end-label"),
    storyTimeSpan.endLabel,
  );
  _appendNodeDetailSelectInput(
    storyTimeSpanCollapse,
    "混合时间",
    inputId("story-time-span-mixed"),
    storyTimeSpan.mixed ? "true" : "false",
    STORY_TIME_MIXED_OPTIONS,
  );
  _appendNodeDetailSelectInput(
    storyTimeSpanCollapse,
    "来源",
    inputId("story-time-span-source"),
    storyTimeSpan.source,
    STORY_TIME_SOURCE_OPTIONS,
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "起点段 ID",
    inputId("story-time-span-start-segment-id"),
    storyTimeSpan.startSegmentId,
  );
  _appendNodeDetailTextInput(
    storyTimeSpanCollapse,
    "终点段 ID",
    inputId("story-time-span-end-segment-id"),
    storyTimeSpan.endSegmentId,
  );
  fragment.appendChild(storyTimeSpanCollapse);

  _appendNodeDetailNumberInput(
    fragment,
    "重要度 (0–10)",
    inputId("importance"),
    raw.importance ?? 5,
    { min: 0, max: 10, step: 0.1 },
  );
  _appendNodeDetailNumberInput(
    fragment,
    "访问次数",
    inputId("accesscount"),
    raw.accessCount ?? 0,
    { min: 0, step: 1 },
  );

  const clustersStr = Array.isArray(raw.clusters)
    ? raw.clusters.join(", ")
    : "";
  _appendNodeDetailTextInput(
    fragment,
    "聚类标签 (逗号分隔)",
    inputId("clusters"),
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

  return fragment;
}

function _collectNodeDetailEditorUpdates(bodyEl, { idPrefix = "bme-detail" } = {}) {
  if (!bodyEl) {
    return { ok: false, errorMessage: "未找到可编辑表单" };
  }

  const findInput = (suffix) =>
    bodyEl.querySelector(`#${idPrefix}-${suffix}`);
  const updates = { fields: {} };
  const impEl = findInput("importance");
  if (impEl && impEl.value !== "") {
    const imp = Number.parseFloat(impEl.value);
    if (Number.isFinite(imp)) {
      updates.importance = Math.max(0, Math.min(10, imp));
    }
  }
  const accessEl = findInput("accesscount");
  if (accessEl && accessEl.value !== "") {
    const ac = Number.parseInt(accessEl.value, 10);
    if (Number.isFinite(ac)) {
      updates.accessCount = Math.max(0, ac);
    }
  }
  const clustersEl = findInput("clusters");
  if (clustersEl) {
    updates.clusters = clustersEl.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const regionPrimaryEl = findInput("scope-region-primary");
  const regionPathEl = findInput("scope-region-path");
  const regionSecondaryEl = findInput("scope-region-secondary");
  if (regionPrimaryEl || regionPathEl || regionSecondaryEl) {
    updates.scope = {
      regionPrimary: String(regionPrimaryEl?.value || "").trim(),
      regionPath: _parseNodeDetailScopeList(regionPathEl?.value, {
        allowSlash: true,
      }),
      regionSecondary: _parseNodeDetailScopeList(regionSecondaryEl?.value, {
        allowSlash: true,
      }),
    };
  }

  const storyTimeLabelEl = findInput("story-time-label");
  const storyTimeTenseEl = findInput("story-time-tense");
  const storyTimeRelationEl = findInput("story-time-relation");
  const storyTimeAnchorLabelEl = findInput("story-time-anchor-label");
  const storyTimeConfidenceEl = findInput("story-time-confidence");
  const storyTimeSourceEl = findInput("story-time-source");
  const storyTimeSegmentIdEl = findInput("story-time-segment-id");
  if (
    storyTimeLabelEl ||
    storyTimeTenseEl ||
    storyTimeRelationEl ||
    storyTimeAnchorLabelEl ||
    storyTimeConfidenceEl ||
    storyTimeSourceEl ||
    storyTimeSegmentIdEl
  ) {
    updates.storyTime = normalizeStoryTime({
      segmentId: String(storyTimeSegmentIdEl?.value || "").trim(),
      label: String(storyTimeLabelEl?.value || "").trim(),
      tense: String(storyTimeTenseEl?.value || ""),
      relation: String(storyTimeRelationEl?.value || ""),
      anchorLabel: String(storyTimeAnchorLabelEl?.value || "").trim(),
      confidence: String(storyTimeConfidenceEl?.value || ""),
      source: String(storyTimeSourceEl?.value || ""),
    });
  }

  const storyTimeSpanStartLabelEl = findInput("story-time-span-start-label");
  const storyTimeSpanEndLabelEl = findInput("story-time-span-end-label");
  const storyTimeSpanMixedEl = findInput("story-time-span-mixed");
  const storyTimeSpanSourceEl = findInput("story-time-span-source");
  const storyTimeSpanStartSegmentIdEl = findInput(
    "story-time-span-start-segment-id",
  );
  const storyTimeSpanEndSegmentIdEl = findInput(
    "story-time-span-end-segment-id",
  );
  if (
    storyTimeSpanStartLabelEl ||
    storyTimeSpanEndLabelEl ||
    storyTimeSpanMixedEl ||
    storyTimeSpanSourceEl ||
    storyTimeSpanStartSegmentIdEl ||
    storyTimeSpanEndSegmentIdEl
  ) {
    updates.storyTimeSpan = normalizeStoryTimeSpan({
      startSegmentId: String(storyTimeSpanStartSegmentIdEl?.value || "").trim(),
      endSegmentId: String(storyTimeSpanEndSegmentIdEl?.value || "").trim(),
      startLabel: String(storyTimeSpanStartLabelEl?.value || "").trim(),
      endLabel: String(storyTimeSpanEndLabelEl?.value || "").trim(),
      mixed: String(storyTimeSpanMixedEl?.value || "false") === "true",
      source: String(storyTimeSpanSourceEl?.value || ""),
    });
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
        return {
          ok: false,
          errorMessage: `字段「${key}」须为合法 JSON`,
        };
      }
    } else {
      updates.fields[key] = rawVal;
    }
  }

  return { ok: true, updates };
}

function _persistNodeDetailEdits(nodeId, updates, { afterSuccess } = {}) {
  if (!nodeId) return false;
  if (!_ensurePluginEnabledForAction("节点编辑")) {
    return false;
  }
  if (_isGraphWriteBlocked()) {
    toastr.error("当前图谱不可写入，请稍后再试", "ST-BME");
    return false;
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
    return false;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "内容已更新，但写回聊天元数据可能被拦截，请查看图谱状态",
      "ST-BME",
    );
  } else {
    toastr.success("节点已保存", "ST-BME");
  }

  afterSuccess?.();
  refreshLiveState();
  return true;
}

function _deleteGraphNodeById(nodeId, { afterSuccess } = {}) {
  if (!nodeId) return false;
  if (!_ensurePluginEnabledForAction("节点删除")) {
    return false;
  }
  if (_isGraphWriteBlocked()) {
    toastr.error("当前图谱不可写入，请稍后再试", "ST-BME");
    return false;
  }

  const g = _getGraph?.();
  const node = g?.nodes?.find((n) => n.id === nodeId);
  const label = node ? getNodeDisplayName(node) : nodeId;
  if (
    !confirm(
      `确定删除节点「${label}」？\n\n若该节点有层级子节点，将一并删除。此操作不可在本面板内撤销。`,
    )
  ) {
    return false;
  }

  const result = _actionHandlers.deleteGraphNode?.({ nodeId });
  if (!result?.ok) {
    toastr.error(
      result?.error === "node-not-found" ? "节点已不存在" : "删除失败",
      "ST-BME",
    );
    return false;
  }
  if (result.persistBlocked) {
    toastr.warning(
      "节点已从图中移除，但写回可能被拦截，请查看图谱状态",
      "ST-BME",
    );
  } else {
    toastr.success("节点已删除", "ST-BME");
  }

  afterSuccess?.();
  refreshLiveState();
  return true;
}

function _useMobileGraphNodeDetail() {
  return _isMobile() && currentTabId === "graph";
}

function _getNodeDetailEls() {
  const mobile = _useMobileGraphNodeDetail();
  const detailEl = document.getElementById(
    mobile ? "bme-mobile-node-detail" : "bme-node-detail",
  );
  const titleEl = document.getElementById(
    mobile ? "bme-mobile-detail-title" : "bme-detail-title",
  );
  const bodyEl = document.getElementById(
    mobile ? "bme-mobile-detail-body" : "bme-detail-body",
  );
  const scrimEl = mobile
    ? document.getElementById("bme-mobile-node-detail-scrim")
    : null;
  if (!detailEl || !titleEl || !bodyEl) return null;
  return { detailEl, titleEl, bodyEl, scrimEl, mobile };
}

function _closeNodeDetailUi() {
  document.getElementById("bme-node-detail")?.classList.remove("open");
  document.getElementById("bme-mobile-node-detail")?.classList.remove("open");
  document.getElementById("bme-mobile-node-detail-scrim")?.setAttribute("hidden", "");
}

function _showNodeDetail(node) {
  const els = _getNodeDetailEls();
  if (!els) return;
  const { detailEl, titleEl, bodyEl, scrimEl, mobile } = els;

  if (mobile) {
    document.getElementById("bme-node-detail")?.classList.remove("open");
  } else {
    document.getElementById("bme-mobile-node-detail")?.classList.remove("open");
    document.getElementById("bme-mobile-node-detail-scrim")?.setAttribute("hidden", "");
  }

  const raw = node.raw || node;
  titleEl.textContent = getNodeDisplayName(raw);
  detailEl.dataset.editNodeId = raw.id || "";
  bodyEl.replaceChildren(_buildNodeDetailEditorFragment(raw));

  if (mobile) {
    scrimEl?.removeAttribute("hidden");
  }
  detailEl.classList.add("open");
}

function _saveNodeDetail() {
  const els = _getNodeDetailEls();
  const detailEl = els?.detailEl;
  const bodyEl = els?.bodyEl;
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId || !bodyEl) return;
  const collected = _collectNodeDetailEditorUpdates(bodyEl);
  if (!collected.ok) {
    toastr.error(collected.errorMessage || "保存失败", "ST-BME");
    return;
  }

  _persistNodeDetailEdits(nodeId, collected.updates, {
    afterSuccess: () => {
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
    },
  });
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
  const saveMob = document.getElementById("bme-mobile-detail-save");
  if (saveMob && saveMob.dataset.bmeBound !== "true") {
    saveMob.addEventListener("click", () => _saveNodeDetail());
    saveMob.dataset.bmeBound = "true";
  }
  const delMob = document.getElementById("bme-mobile-detail-delete");
  if (delMob && delMob.dataset.bmeBound !== "true") {
    delMob.addEventListener("click", () => _deleteNodeDetail());
    delMob.dataset.bmeBound = "true";
  }
}

function _deleteNodeDetail() {
  const els = _getNodeDetailEls();
  const detailEl = els?.detailEl;
  const nodeId = detailEl?.dataset?.editNodeId;
  if (!nodeId) return;

  _deleteGraphNodeById(nodeId, {
    afterSuccess: () => {
      _closeNodeDetailUi();
      const dDesk = document.getElementById("bme-node-detail");
      const dMob = document.getElementById("bme-mobile-node-detail");
      if (dDesk) delete dDesk.dataset.editNodeId;
      if (dMob) delete dMob.dataset.editNodeId;
      graphRenderer?.highlightNode?.("__cleared__");
      mobileGraphRenderer?.highlightNode?.("__cleared__");
    },
  });
}

function _bindClose() {
  document
    .getElementById("bme-panel-close")
    ?.addEventListener("click", closePanel);
  document.getElementById("bme-detail-close")?.addEventListener("click", () => {
    _closeNodeDetailUi();
  });
  document.getElementById("bme-mobile-detail-close")?.addEventListener("click", () => {
    _closeNodeDetailUi();
  });
  document.getElementById("bme-mobile-node-detail-scrim")?.addEventListener("click", () => {
    _closeNodeDetailUi();
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

async function _runCognitionNodeOverrideAction(mode = "") {
  const graph = _getGraph?.();
  const ownerEntries = _getCognitionOwnerCollection(graph);
  const ownerEntry =
    ownerEntries.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  const selectedNode = _getSelectedGraphNode(graph);

  if (!ownerEntry) {
    toastr.info("先选择一个角色，再设置认知覆盖", "ST-BME");
    return;
  }
  if (!selectedNode?.id) {
    toastr.info("先在图谱或记忆列表里点一个节点", "ST-BME");
    return;
  }

  let result = null;
  if (mode === "clear") {
    result = await _actionHandlers.clearKnowledgeOverride?.({
      ownerKey: ownerEntry.ownerKey,
      ownerType: ownerEntry.ownerType,
      ownerName: ownerEntry.ownerName,
      nodeId: selectedNode.id,
    });
  } else {
    result = await _actionHandlers.applyKnowledgeOverride?.({
      ownerKey: ownerEntry.ownerKey,
      ownerType: ownerEntry.ownerType,
      ownerName: ownerEntry.ownerName,
      nodeId: selectedNode.id,
      mode,
    });
  }

  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "当前图谱还在保护写入阶段，请稍后再试",
      "node-not-found": "这个节点已经不存在了，请重新选择",
      "owner-not-found": "没有找到这个角色的认知状态，请先让她参与一轮提取",
    };
    toastr.error(messageMap[result?.error] || "认知覆盖失败", "ST-BME");
    return;
  }

  const successMap = {
    known: "已标记为强制已知",
    hidden: "已标记为强制隐藏",
    mistaken: "已标记为误解",
    clear: "已清除该节点的手动覆盖",
  };
  if (result.persistBlocked) {
    toastr.warning(
      `${successMap[mode] || "认知覆盖已更新"}，但正式写回可能仍在等待图谱就绪`,
      "ST-BME",
    );
  } else {
    toastr.success(successMap[mode] || "认知覆盖已更新", "ST-BME");
  }
  _refreshCognitionSurfaces();
}

function _refreshCognitionSurfaces() {
  _refreshDashboard();
  _refreshCognitionWorkspace();
  _refreshMobileCognitionFull();
}

async function _callAction(actionKey = "", payload = {}) {
  const handler = _actionHandlers?.[String(actionKey || "")];
  if (typeof handler !== "function") {
    return { ok: false, error: "missing-action-handler" };
  }
  if (!_ensurePluginEnabledForAction("该操作")) {
    return { ok: false, error: "plugin-disabled", handledToast: true };
  }
  const result = await handler(payload);
  _refreshCognitionSurfaces();
  return result;
}

async function _runCognitionOwnerManagementAction(mode = "", triggerEl = null) {
  if (!_ensurePluginEnabledForAction("认知管理")) return;
  const graph = _getGraph?.();
  const ownerEntries = _getCognitionOwnerCollection(graph);
  const ownerEntry =
    ownerEntries.find((entry) => entry.ownerKey === currentCognitionOwnerKey) || null;
  if (!ownerEntry) {
    toastr.info("先选择一个角色，再管理认知条目", "ST-BME");
    return;
  }
  if (String(ownerEntry.ownerType || "") !== "character") {
    toastr.info("当前只支持角色 owner 的重命名、合并和删除", "ST-BME");
    return;
  }

  const container =
    triggerEl?.closest?.(".bme-cog-owner-detail") ||
    document.getElementById("bme-cog-owner-detail") ||
    document.getElementById("bme-mobile-cog-owner-detail");
  const collisionIndex = _buildOwnerCollisionIndex(ownerEntries);
  const displayInfo = _getOwnerDisplayInfo(ownerEntry, collisionIndex);
  let result = null;

  if (mode === "rename") {
    const input = container?.querySelector?.("[data-bme-cognition-owner-rename-input]");
    const nextName = String(input?.value || "").trim();
    if (!nextName) {
      toastr.info("先输入新的角色名称", "ST-BME");
      return;
    }
    if (nextName === String(ownerEntry.ownerName || "").trim()) {
      toastr.info("新名称与当前名称相同，无需重命名", "ST-BME");
      return;
    }
    if (
      !window.confirm(
        `确定将角色认知「${displayInfo.title}」重命名为「${nextName}」吗？\n\n这会同步更新 owner 名称、角色节点名和 POV scope。`,
      )
    ) {
      return;
    }
    result = await _actionHandlers.renameKnowledgeOwner?.({
      ownerKey: ownerEntry.ownerKey,
      nextName,
    });
  } else if (mode === "merge") {
    const select = container?.querySelector?.("[data-bme-cognition-owner-merge-target]");
    const targetOwnerKey = String(select?.value || "").trim();
    if (!targetOwnerKey) {
      toastr.info("先选择要合并到的目标角色", "ST-BME");
      return;
    }
    if (targetOwnerKey === ownerEntry.ownerKey) {
      toastr.info("不能把角色合并到自己", "ST-BME");
      return;
    }
    const targetEntry =
      ownerEntries.find((entry) => String(entry.ownerKey || "") === targetOwnerKey) || null;
    const targetDisplayInfo = targetEntry
      ? _getOwnerDisplayInfo(targetEntry, collisionIndex)
      : { title: targetOwnerKey };
    if (
      !window.confirm(
        `确定将角色认知「${displayInfo.title}」合并到「${targetDisplayInfo.title}」吗？\n\n这会把当前角色的 POV scope 改写到目标角色，并合并认知状态。`,
      )
    ) {
      return;
    }
    result = await _actionHandlers.mergeKnowledgeOwners?.({
      sourceOwnerKey: ownerEntry.ownerKey,
      targetOwnerKey,
    });
  } else if (mode === "delete") {
    const select = container?.querySelector?.("[data-bme-cognition-owner-delete-mode]");
    const deleteMode = String(select?.value || "owner-only").trim() || "owner-only";
    const deleteModeLabelMap = {
      "owner-only": "只删除 owner，保留角色节点与 POV",
      "archive-character": "删除 owner，并归档角色节点",
      "archive-all": "删除 owner，并归档角色节点与 POV 记忆",
    };
    if (
      !window.confirm(
        `确定删除角色认知「${displayInfo.title}」吗？\n\n删除范围：${deleteModeLabelMap[deleteMode] || deleteMode}\n\n此操作会立即写回图谱。`,
      )
    ) {
      return;
    }
    result = await _actionHandlers.deleteKnowledgeOwner?.({
      ownerKey: ownerEntry.ownerKey,
      mode: deleteMode,
    });
  } else {
    return;
  }

  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "当前图谱还在保护写入阶段，请稍后再试",
      "owner-not-found": "没有找到这个角色的认知状态，请先让她参与一轮提取",
      "same-owner": "不能把角色合并到自己",
      "missing-owner-or-name": "缺少角色或新名称",
      "invalid-delete-mode": "删除范围无效，请重新选择",
      "unsupported-owner-type": "当前只支持角色 owner 操作",
    };
    toastr.error(messageMap[result?.error] || "角色认知操作失败", "ST-BME");
    return;
  }

  if (mode === "rename") {
    currentCognitionOwnerKey = String(result.ownerKey || ownerEntry.ownerKey || "").trim();
  } else if (mode === "merge") {
    currentCognitionOwnerKey = String(result.ownerKey || "").trim();
  } else if (mode === "delete") {
    currentCognitionOwnerKey = "";
  }

  const successMap = {
    rename: "角色认知已重命名",
    merge: "角色认知已合并",
    delete: "角色认知已删除",
  };
  if (result.persistBlocked) {
    toastr.warning(
      `${successMap[mode] || "角色认知已更新"}，但正式写回可能仍在等待图谱就绪`,
      "ST-BME",
    );
  } else {
    toastr.success(successMap[mode] || "角色认知已更新", "ST-BME");
  }

  _refreshCognitionSurfaces();
}

async function _applyManualActiveRegionFromDashboard(clear = false) {
  if (!_ensurePluginEnabledForAction(clear ? "清除当前地区" : "设置当前地区")) {
    return;
  }
  const input = document.getElementById("bme-cognition-manual-region");
  const region = clear ? "" : String(input?.value || "").trim();
  const result = await _actionHandlers.setActiveRegion?.({ region });
  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "图谱还在保护写入阶段，暂时不能改地区",
      "missing-graph": "当前没有可用图谱",
    };
    toastr.error(messageMap[result?.error] || "更新当前地区失败", "ST-BME");
    return;
  }

  if (result.persistBlocked) {
    toastr.warning(
      clear ? "已恢复自动地区，但正式写回还在等待图谱就绪" : "当前地区已更新，但正式写回还在等待图谱就绪",
      "ST-BME",
    );
  } else {
    toastr.success(clear ? "已恢复自动地区判断" : "当前地区已更新", "ST-BME");
  }
  _refreshDashboard();
}

async function _saveRegionAdjacencyFromDashboard() {
  if (!_ensurePluginEnabledForAction("保存地区邻接")) {
    return;
  }
  const graph = _getGraph?.();
  const regionInput = document.getElementById("bme-cognition-manual-region");
  const adjacencyInput = document.getElementById("bme-cognition-adjacency-input");
  const historyState = graph?.historyState || {};
  const region = String(
    regionInput?.value ||
      historyState.activeRegion ||
      graph?.regionState?.manualActiveRegion ||
      "",
  ).trim();
  const adjacent = String(adjacencyInput?.value || "")
    .split(/[,\n，]/)
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!region) {
    toastr.info("先填一个当前地区，再保存邻接关系", "ST-BME");
    return;
  }

  const result = await _actionHandlers.updateRegionAdjacency?.({
    region,
    adjacent,
  });
  if (!result?.ok) {
    const messageMap = {
      "graph-write-blocked": "图谱还在保护写入阶段，暂时不能改邻接关系",
      "missing-region": "缺少地区名，无法保存邻接",
    };
    toastr.error(messageMap[result?.error] || "保存地区邻接失败", "ST-BME");
    return;
  }

  if (result.persistBlocked) {
    toastr.warning("邻接关系已更新，但正式写回还在等待图谱就绪", "ST-BME");
  } else {
    toastr.success("当前地区邻接已保存", "ST-BME");
  }
  _refreshDashboard();
}

function _bindDashboardControls() {
  const ownerList = document.getElementById("bme-cognition-owner-list");
  if (ownerList && ownerList.dataset.bmeBound !== "true") {
    ownerList.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-owner-key]");
      if (!button) return;
      const ownerKey = String(button.dataset.ownerKey || "").trim();
      if (!ownerKey) return;
      currentCognitionOwnerKey = ownerKey;
      _refreshDashboard();
    });
    ownerList.dataset.bmeBound = "true";
  }

  const detail = document.getElementById("bme-cognition-detail");
  if (detail && detail.dataset.bmeBound !== "true") {
    detail.addEventListener("click", async (event) => {
      const button = event.target.closest?.("[data-bme-cognition-node-action]");
      if (!button || button.disabled) return;
      await _runCognitionNodeOverrideAction(
        String(button.dataset.bmeCognitionNodeAction || ""),
      );
    });
    detail.dataset.bmeBound = "true";
  }

  const regionApply = document.getElementById("bme-cognition-region-apply");
  if (regionApply && regionApply.dataset.bmeBound !== "true") {
    regionApply.addEventListener("click", async () => {
      await _applyManualActiveRegionFromDashboard(false);
    });
    regionApply.dataset.bmeBound = "true";
  }

  const regionClear = document.getElementById("bme-cognition-region-clear");
  if (regionClear && regionClear.dataset.bmeBound !== "true") {
    regionClear.addEventListener("click", async () => {
      await _applyManualActiveRegionFromDashboard(true);
    });
    regionClear.dataset.bmeBound = "true";
  }

  const adjacencySave = document.getElementById("bme-cognition-adjacency-save");
  if (adjacencySave && adjacencySave.dataset.bmeBound !== "true") {
    adjacencySave.addEventListener("click", async () => {
      await _saveRegionAdjacencyFromDashboard();
    });
    adjacencySave.dataset.bmeBound = "true";
  }
}

// ==================== 操作绑定 ====================

function _bindActions() {
  const bindings = {
    "bme-act-compress": "compress",
    "bme-act-sleep": "sleep",
    "bme-act-synopsis": "synopsis",
    "bme-act-summary-rollup": "summaryRollup",
    "bme-act-retry-persist": "retryPendingPersist",
    "bme-act-probe-graph-load": "probeGraphLoad",
    "bme-act-rebuild-luker-cache": "rebuildLukerLocalCache",
    "bme-act-repair-luker-sidecar": "repairLukerSidecar",
    "bme-act-compact-luker-sidecar": "compactLukerSidecar",
    "bme-act-export": "export",
    "bme-act-import": "import",
    "bme-act-rebuild": "rebuild",
    "bme-act-evolve": "evolve",
    "bme-act-undo-maintenance": "undoMaintenance",
    "bme-act-vector-rebuild": "rebuildVectorIndex",
    "bme-act-vector-reembed": "reembedDirect",
    "bme-act-clear-graph": "clearGraph",
    "bme-act-clear-vector-cache": "clearVectorCache",
    "bme-act-clear-batch-journal": "clearBatchJournal",
    "bme-act-delete-current-idb": "deleteCurrentIdb",
    "bme-act-delete-all-idb": "deleteAllIdb",
    "bme-act-delete-server-sync": "deleteServerSyncFile",
    "bme-act-backup-to-cloud": "backupToCloud",
    "bme-act-restore-from-cloud": "restoreFromCloud",
    "bme-act-manage-server-backups": "manageServerBackups",
    "bme-act-rollback-last-restore": "rollbackLastRestore",
  };

  const actionLabels = {
    compress: "手动压缩",
    sleep: "执行遗忘",
    synopsis: "生成小总结",
    summaryRollup: "执行总结折叠",
    retryPendingPersist: "重试持久化",
    probeGraphLoad: "重新探测图谱",
    rebuildLukerLocalCache: "重建本地缓存",
    repairLukerSidecar: "修复主 Sidecar",
    compactLukerSidecar: "压实主 Sidecar",
    rebuildSummaryState: "重建总结状态",
    export: "导出图谱",
    import: "导入图谱",
    rebuild: "重建图谱",
    evolve: "强制进化",
    undoMaintenance: "撤销最近维护",
    rebuildVectorIndex: "重建向量",
    reembedDirect: "直连重嵌",
    clearGraph: "清空图谱",
    clearVectorCache: "清空向量缓存",
    clearBatchJournal: "清空提取历史",
    deleteCurrentIdb: "清空当前本地存储",
    deleteAllIdb: "清空全部本地存储",
    deleteServerSyncFile: "清空服务端同步数据",
    backupToCloud: "\u5907\u4efd\u5230\u4e91\u7aef",
    restoreFromCloud: "\u4ece\u4e91\u7aef\u83b7\u53d6\u5907\u4efd",
    manageServerBackups: "\u7ba1\u7406\u670d\u52a1\u5668\u5907\u4efd",
    rollbackLastRestore: "\u56de\u6eda\u4e0a\u6b21\u6062\u590d",
  };

  const manualCloudFabBehaviors = {
    backupToCloud: {
      successStatus: "cloud-success",
      successTooltip: "备份云端完成",
      errorTooltip: "备份到云端失败",
    },
    restoreFromCloud: {
      successStatus: "cloud-success",
      successTooltip: "云端备份已提取",
      errorTooltip: "从云端获取备份失败",
    },
    manageServerBackups: {
      suppressFab: true,
    },
    rollbackLastRestore: {
      successStatus: "cloud-success",
      successTooltip: "回滚完成",
      errorTooltip: "回滚上次恢复失败",
    },
  };

  for (const [elementId, actionKey] of Object.entries(bindings)) {
    const btn = document.getElementById(elementId);
    if (!btn) continue;

    btn.addEventListener("click", async () => {
      if (!_ensurePluginEnabledForAction(actionLabels[actionKey] || actionKey)) {
        return;
      }
      const handler =
        actionKey === "manageServerBackups"
          ? _openServerBackupManagerModal
          : _actionHandlers[actionKey];
      if (!handler) return;

      const label = actionLabels[actionKey] || actionKey;
      const fabBehavior = manualCloudFabBehaviors[actionKey] || null;
      const suppressFab = fabBehavior?.suppressFab === true;

      // 防止重复点击
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = "0.5";

      _showActionProgressUi(label);
      if (suppressFab) {
        _syncFloatingBallWithRuntimeStatus();
      }
      toastr.info(`${label} 进行中…`, "ST-BME", { timeOut: 2000 });

      try {
        const result = await handler();
        if (result?.cancelled) {
          if (!suppressFab) {
            _syncFloatingBallWithRuntimeStatus();
          }
          return;
        }
        if (!result?.skipDashboardRefresh) {
          _refreshDashboard();
          _refreshGraph();
          if (currentTabId === "task") {
            _refreshTaskMonitor();
          }
        }
        if (!result?.handledToast) {
          toastr.success(`${label} 完成`, "ST-BME");
        }
        if (fabBehavior?.successTooltip) {
          updateFloatingBallStatus(
            fabBehavior.successStatus || "success",
            fabBehavior.successTooltip,
          );
        }
        void _refreshCloudBackupManualUi();
      } catch (error) {
        console.error(`[ST-BME] Action ${actionKey} failed:`, error);
        if (!suppressFab) {
          updateFloatingBallStatus(
            fabBehavior?.errorStatus || "error",
            fabBehavior?.errorTooltip || `${label}失败`,
          );
        }
        if (!error?._stBmeToastHandled) {
          toastr.error(`${label} 失败: ${error?.message || error}`, "ST-BME");
        }
      } finally {
        btn.disabled = false;
        btn.style.opacity = "";
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
        void _refreshCloudBackupManualUi();
      }
    });
  }

  document
    .getElementById("bme-act-extract")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-extract");
      if (btn?.disabled) return;
      if (!_ensurePluginEnabledForAction("重新提取")) return;
      const mode =
        String(
          document.getElementById("bme-extract-mode")?.value ||
            (_getSettings?.() || {}).extractActionMode ||
            "pending",
        )
          .trim()
          .toLowerCase() === "rerun"
          ? "rerun"
          : "pending";
      const startFloor = _parseOptionalInt(
        document.getElementById("bme-extract-start-floor")?.value,
      );
      const endFloor = _parseOptionalInt(
        document.getElementById("bme-extract-end-floor")?.value,
      );
      const desc =
        mode === "pending"
          ? "提取当前尚未处理的内容"
          : Number.isFinite(startFloor) || Number.isFinite(endFloor)
            ? `重提范围 ${Number.isFinite(startFloor) ? startFloor : "当前"} ~ ${Number.isFinite(endFloor) ? endFloor : "最新"}`
            : "当前重提";

      if (!confirm(`确认要执行吗？\n\n${desc}`)) {
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("重新提取");
      try {
        await _actionHandlers.extractTask?.({
          mode,
          startFloor: Number.isFinite(startFloor) ? startFloor : undefined,
          endFloor: Number.isFinite(endFloor) ? endFloor : undefined,
        });
        _refreshDashboard();
        _refreshGraph();
        if (currentTabId === "task") _refreshTaskMonitor();
      } catch (error) {
        console.error("[ST-BME] Action extractTask failed:", error);
        toastr.error(`重新提取失败: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  document
    .getElementById("bme-act-vector-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-vector-range");
      if (btn?.disabled) return;
      if (!_ensurePluginEnabledForAction("范围重建")) return;
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

  document
    .getElementById("bme-act-summary-rebuild")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-summary-rebuild");
      if (btn?.disabled) return;
      if (!_ensurePluginEnabledForAction("重建总结状态")) return;
      const startFloor = _parseOptionalInt(
        document.getElementById("bme-extract-start-floor")?.value,
      );
      const endFloor = _parseOptionalInt(
        document.getElementById("bme-extract-end-floor")?.value,
      );
      const desc = Number.isFinite(startFloor) || Number.isFinite(endFloor)
        ? `按范围 ${Number.isFinite(startFloor) ? startFloor : "当前"} ~ ${Number.isFinite(endFloor) ? endFloor : "最新"} 重建总结状态`
        : "按当前总结相关范围重建总结状态";

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("重建总结状态");
      try {
        await _actionHandlers.rebuildSummaryState?.({
          startFloor: Number.isFinite(startFloor) ? startFloor : undefined,
          endFloor: Number.isFinite(endFloor) ? endFloor : undefined,
        });
        _refreshDashboard();
        _refreshGraph();
        if (currentTabId === "task") _refreshTaskMonitor();
      } catch (error) {
        console.error("[ST-BME] Action rebuildSummaryState failed:", error);
        toastr.error(`重建总结状态失败: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // 按楼层范围清理 (cleanup)
  document
    .getElementById("bme-act-clear-graph-range")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("bme-act-clear-graph-range");
      if (btn?.disabled) return;
      if (!_ensurePluginEnabledForAction("按楼层范围清理")) return;

      const startStr = document.getElementById("bme-cleanup-range-start")?.value;
      const endStr = document.getElementById("bme-cleanup-range-end")?.value;
      const startSeq = _parseOptionalInt(startStr);
      const endSeq = _parseOptionalInt(endStr);

      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.5";
      }

      _showActionProgressUi("按楼层范围清理");
      try {
        await _actionHandlers.clearGraphRange?.(
          Number.isFinite(startSeq) ? startSeq : null,
          Number.isFinite(endSeq) ? endSeq : null,
        );
        _refreshDashboard();
        _refreshGraph();
        if (currentTabId === "task") _refreshTaskMonitor();
      } catch (error) {
        console.error("[ST-BME] Action clearGraphRange failed:", error);
        toastr.error(`按楼层范围清理失败: ${error?.message || error}`, "ST-BME");
      } finally {
        if (btn) {
          btn.style.opacity = "";
        }
        _refreshRuntimeStatus();
        _refreshGraphAvailabilityState();
      }
    });

  // ==================== AI Monitor Trace 折叠 ====================

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest(".bme-ai-monitor-entry__toggle");
    if (!toggle) return;
    const entry = toggle.closest(".bme-ai-monitor-entry");
    if (entry) entry.classList.toggle("is-collapsed");
  });

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest(
      ".bme-timeline-entry__toggle, .bme-timeline-entry__head",
    );
    if (!toggle) return;
    const entry = toggle.closest(".bme-timeline-entry");
    if (entry) entry.classList.toggle("is-collapsed");
  });

  // ==================== 认知视图绑定 ====================

  // 图谱/认知视图 tab 切换
  panelEl?.querySelectorAll(".bme-graph-view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _switchGraphView(tab.dataset.graphView);
    });
  });

  // 移动端图谱子 Tab 切换
  document.querySelectorAll(".bme-graph-subtab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _switchMobileGraphSubView(tab.dataset.mobileGraphView);
    });
  });

  // 移动端图谱浮动控件
  document.getElementById("bme-mobile-render-toggle")?.addEventListener("click", () => {
    _toggleGraphRenderingEnabled();
  });
  document.getElementById("bme-mobile-zoom-in")?.addEventListener("click", () => {
    const r = _getActiveGraphRenderer?.();
    r?.zoomIn?.();
  });
  document.getElementById("bme-mobile-zoom-out")?.addEventListener("click", () => {
    const r = _getActiveGraphRenderer?.();
    r?.zoomOut?.();
  });
  document.getElementById("bme-mobile-zoom-reset")?.addEventListener("click", () => {
    const r = _getActiveGraphRenderer?.();
    r?.resetView?.();
  });

  // 全屏图谱
  document.getElementById("bme-fs-close")?.addEventListener("click", _closeFullscreenGraph);

  // 认知视图角色列表点击（桌面端）
  document.getElementById("bme-cog-owner-list")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-owner-key]");
    if (!card) return;
    currentCognitionOwnerKey = card.dataset.ownerKey;
    _refreshCognitionWorkspace();
  });

  // 认知视图角色列表点击（移动端）
  document.getElementById("bme-mobile-cog-owner-list")?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-owner-key]");
    if (!card) return;
    currentCognitionOwnerKey = card.dataset.ownerKey;
    _refreshMobileCognitionFull();
  });

  const cogOwnerDetail = document.getElementById("bme-cog-owner-detail");
  if (cogOwnerDetail && cogOwnerDetail.dataset.bmeOwnerActionsBound !== "true") {
    cogOwnerDetail.addEventListener("click", async (e) => {
      const ownerActionBtn = e.target.closest("[data-bme-cognition-owner-action]");
      if (!ownerActionBtn || ownerActionBtn.disabled) return;
      await _runCognitionOwnerManagementAction(
        String(ownerActionBtn.dataset.bmeCognitionOwnerAction || ""),
        ownerActionBtn,
      );
    });
    cogOwnerDetail.dataset.bmeOwnerActionsBound = "true";
  }

  const mobileCogOwnerDetail = document.getElementById("bme-mobile-cog-owner-detail");
  if (
    mobileCogOwnerDetail &&
    mobileCogOwnerDetail.dataset.bmeOwnerActionsBound !== "true"
  ) {
    mobileCogOwnerDetail.addEventListener("click", async (e) => {
      const ownerActionBtn = e.target.closest("[data-bme-cognition-owner-action]");
      if (ownerActionBtn && !ownerActionBtn.disabled) {
        await _runCognitionOwnerManagementAction(
          String(ownerActionBtn.dataset.bmeCognitionOwnerAction || ""),
          ownerActionBtn,
        );
        return;
      }

      const nodeActionBtn = e.target.closest("[data-bme-cognition-node-action]");
      if (!nodeActionBtn || nodeActionBtn.disabled) return;
      await _runCognitionNodeOverrideAction(
        String(nodeActionBtn.dataset.bmeCognitionNodeAction || ""),
      );
    });
    mobileCogOwnerDetail.dataset.bmeOwnerActionsBound = "true";
  }

  // Dashboard 跳转认知视图
  document.getElementById("bme-cognition-jump-to-view")?.addEventListener("click", () => {
    _switchTab("dashboard");
    _switchGraphView("cognition");
  });

  // 认知视图空间工具 (delegate)
  document.getElementById("bme-cognition-workspace")?.addEventListener("click", (e) => {
    const regionApply = e.target.closest("#bme-cog-region-apply");
    const regionClear = e.target.closest("#bme-cog-region-clear");
    const adjSave = e.target.closest("#bme-cog-adjacency-save");
    const storyApply = e.target.closest("#bme-cog-story-time-apply");
    const storyClear = e.target.closest("#bme-cog-story-time-clear");

    if (regionApply) {
      const manualRegion = document.getElementById("bme-cog-manual-region")?.value?.trim();
      if (manualRegion) _callAction("setActiveRegion", { region: manualRegion });
    }
    if (regionClear) {
      _callAction("setActiveRegion", { region: "" });
    }
    if (adjSave) {
      const adjInput = document.getElementById("bme-cog-adjacency-input")?.value?.trim() || "";
      const adjList = adjInput.split(/[,，\/\\]/).map((s) => s.trim()).filter(Boolean);
      const graph = _getGraph?.();
      const activeRegion = String(
        graph?.historyState?.activeRegion || graph?.historyState?.lastExtractedRegion || graph?.regionState?.manualActiveRegion || "",
      ).trim();
      if (activeRegion) _callAction("updateRegionAdjacency", { region: activeRegion, adjacent: adjList });
    }
    if (storyApply) {
      const storyLabel = document.getElementById("bme-cog-manual-story-time")?.value?.trim();
      if (storyLabel) _callAction("setActiveStoryTime", { label: storyLabel });
    }
    if (storyClear) {
      _callAction("clearActiveStoryTime", {});
    }

    // 手动覆盖按钮
    const actionBtn = e.target.closest("[data-bme-cognition-node-action]");
    if (actionBtn) {
      const mode = actionBtn.dataset.bmeCognitionNodeAction;
      if (!mode) return;
      const graph = _getGraph?.();
      const selectedNode = _getSelectedGraphNode(graph);
      if (!selectedNode) return;
      const { selectedOwner } = _getCurrentCognitionOwnerSummary(graph);
      if (!selectedOwner) return;

      if (mode === "clear") {
        _callAction("clearKnowledgeOverride", { nodeId: selectedNode.id, ownerKey: selectedOwner.ownerKey });
      } else {
        _callAction("applyKnowledgeOverride", {
          nodeId: selectedNode.id,
          ownerKey: selectedOwner.ownerKey,
          ownerType: selectedOwner.ownerType || "",
          ownerName: selectedOwner.ownerName || "",
          mode,
        });
      }
      _refreshCognitionWorkspace();
    }
  });

  document.getElementById("bme-summary-workspace")?.addEventListener("click", async (e) => {
    const generateBtn = e.target.closest("#bme-summary-generate");
    const rollupBtn = e.target.closest("#bme-summary-rollup");
    const rebuildBtn = e.target.closest("#bme-summary-rebuild");
    const actionMap = new Map([
      [generateBtn, "synopsis"],
      [rollupBtn, "summaryRollup"],
      [rebuildBtn, "rebuildSummaryState"],
    ]);
    const matched = [...actionMap.entries()].find(([element]) => Boolean(element));
    if (!matched) return;

    const [, actionKey] = matched;
    const handler = _actionHandlers[actionKey];
    if (!handler) return;
    const actionLabels = {
      synopsis: "生成小总结",
      summaryRollup: "执行总结折叠",
      rebuildSummaryState: "重建总结状态",
    };
    if (!_ensurePluginEnabledForAction(actionLabels[actionKey] || "总结操作")) {
      return;
    }

    try {
      await handler();
      _refreshDashboard();
      _refreshGraph();
      _refreshSummaryWorkspace();
      if (currentTabId === "task") _refreshTaskMonitor();
    } catch (error) {
      console.error(`[ST-BME] summary workspace action failed: ${actionKey}`, error);
      toastr.error(String(error?.message || error || "操作失败"), "ST-BME");
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
    "bme-setting-graph-native-force-disable",
    settings.graphNativeForceDisable === true,
  );
  _setCheckboxValue(
    "bme-setting-native-engine-fail-open",
    settings.nativeEngineFailOpen !== false,
  );
  _setCheckboxValue(
    "bme-setting-graph-use-native-layout",
    settings.graphUseNativeLayout === true,
  );
  _setCheckboxValue(
    "bme-setting-persist-use-native-delta",
    settings.persistUseNativeDelta === true,
  );
  _setCheckboxValue(
    "bme-setting-load-use-native-hydrate",
    settings.loadUseNativeHydrate === true,
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
    "bme-setting-cognitive-memory-enabled",
    settings.enableCognitiveMemory ?? true,
  );
  _setCheckboxValue(
    "bme-setting-spatial-adjacency-enabled",
    settings.enableSpatialAdjacency ?? true,
  );
  _setCheckboxValue(
    "bme-setting-enable-story-timeline",
    settings.enableStoryTimeline ?? true,
  );
  _setCheckboxValue(
    "bme-setting-story-time-soft-directing",
    settings.storyTimeSoftDirecting ?? true,
  );
  _setCheckboxValue(
    "bme-setting-inject-story-time-label",
    settings.injectStoryTimeLabel ?? true,
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
    "bme-setting-inject-low-confidence-objective-memory",
    settings.injectLowConfidenceObjectiveMemory ?? false,
  );
  _setCheckboxValue(
    "bme-setting-consolidation-enabled",
    settings.enableConsolidation ?? true,
  );
  _setCheckboxValue(
    "bme-setting-synopsis-enabled",
    settings.enableHierarchicalSummary ?? settings.enableSynopsis ?? true,
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
    "bme-setting-cloud-storage-mode",
    settings.cloudStorageMode || "automatic",
  );
  _refreshCloudStorageModeUi(settings);
  _setInputValue(
    "bme-setting-wi-filter-mode",
    settings.worldInfoFilterMode || "default",
  );
  _setInputValue(
    "bme-setting-wi-filter-keywords",
    settings.worldInfoFilterCustomKeywords || "",
  );
  _setInputValue(
    "bme-extract-mode",
    settings.extractActionMode || "pending",
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
  _setCheckboxValue(
    "bme-setting-extract-auto-delay-latest-assistant",
    settings.extractAutoDelayLatestAssistant === true,
  );
  _setInputValue(
    "bme-setting-extract-recent-message-cap",
    settings.extractRecentMessageCap ?? 0,
  );
  _setInputValue(
    "bme-setting-extract-prompt-structured-mode",
    settings.extractPromptStructuredMode || "both",
  );
  _setInputValue(
    "bme-setting-extract-worldbook-mode",
    settings.extractWorldbookMode || "active",
  );
  _setCheckboxValue(
    "bme-setting-extract-include-summaries",
    settings.extractIncludeSummaries !== false,
  );
  _setCheckboxValue(
    "bme-setting-extract-include-story-time",
    settings.extractIncludeStoryTime !== false,
  );
  _setInputValue("bme-setting-recall-top-k", settings.recallTopK ?? 20);
  _setInputValue("bme-setting-recall-max-nodes", settings.recallMaxNodes ?? 12);
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
  _setCheckboxValue(
    "bme-setting-recall-use-authoritative-generation-input",
    settings.recallUseAuthoritativeGenerationInput === true,
  );
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
  _setInputValue(
    "bme-setting-synopsis-every",
    settings.smallSummaryEveryNExtractions ?? settings.synopsisEveryN ?? 3,
  );
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
  _setInputValue(
    "bme-setting-graph-native-layout-threshold-nodes",
    settings.graphNativeLayoutThresholdNodes ?? 280,
  );
  _setInputValue(
    "bme-setting-graph-native-layout-threshold-edges",
    settings.graphNativeLayoutThresholdEdges ?? 1600,
  );
  _setInputValue(
    "bme-setting-graph-native-layout-worker-timeout-ms",
    settings.graphNativeLayoutWorkerTimeoutMs ?? 260,
  );
  _setInputValue(
    "bme-setting-persist-native-delta-threshold-records",
    settings.persistNativeDeltaThresholdRecords ?? 20000,
  );
  _setInputValue(
    "bme-setting-persist-native-delta-threshold-structural-delta",
    settings.persistNativeDeltaThresholdStructuralDelta ?? 600,
  );
  _setInputValue(
    "bme-setting-persist-native-delta-threshold-serialized-chars",
    settings.persistNativeDeltaThresholdSerializedChars ?? 4000000,
  );
  _setInputValue(
    "bme-setting-load-native-hydrate-threshold-records",
    settings.loadNativeHydrateThresholdRecords ?? 12000,
  );

  _setInputValue("bme-setting-llm-url", settings.llmApiUrl || "");
  _setInputValue("bme-setting-llm-key", settings.llmApiKey || "");
  _setInputValue("bme-setting-llm-model", settings.llmModel || "");
  _refreshMemoryLlmProviderHelp(settings.llmApiUrl || "");
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
  _refreshNativeRolloutStatusUi(settings);
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
    _refreshStageCardStates();
    _refreshRuntimeStatus();
  });
  bindCheckbox("bme-setting-debug-logging-enabled", (checked) => {
    _patchSettings({ debugLoggingEnabled: checked });
  });
  bindCheckbox("bme-setting-graph-native-force-disable", (checked) => {
    _patchSettings({ graphNativeForceDisable: checked });
  });
  bindCheckbox("bme-setting-native-engine-fail-open", (checked) => {
    _patchSettings({ nativeEngineFailOpen: checked });
  });
  bindCheckbox("bme-setting-graph-use-native-layout", (checked) => {
    _patchSettings({ graphUseNativeLayout: checked });
  });
  bindCheckbox("bme-setting-persist-use-native-delta", (checked) => {
    _patchSettings({ persistUseNativeDelta: checked });
  });
  bindCheckbox("bme-setting-load-use-native-hydrate", (checked) => {
    _patchSettings({ loadUseNativeHydrate: checked });
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
  bindCheckbox("bme-setting-cognitive-memory-enabled", (checked) => {
    _patchSettings({ enableCognitiveMemory: checked });
  });
  bindCheckbox("bme-setting-spatial-adjacency-enabled", (checked) => {
    _patchSettings({ enableSpatialAdjacency: checked });
  });
  bindCheckbox("bme-setting-enable-story-timeline", (checked) => {
    _patchSettings({ enableStoryTimeline: checked });
  });
  bindCheckbox("bme-setting-story-time-soft-directing", (checked) => {
    _patchSettings({ storyTimeSoftDirecting: checked });
  });
  bindCheckbox("bme-setting-inject-story-time-label", (checked) => {
    _patchSettings({ injectStoryTimeLabel: checked });
  });
  bindCheckbox("bme-setting-inject-user-pov-memory", (checked) => {
    _patchSettings({ injectUserPovMemory: checked });
  });
  bindCheckbox("bme-setting-inject-objective-global-memory", (checked) => {
    _patchSettings({ injectObjectiveGlobalMemory: checked });
  });
  bindCheckbox("bme-setting-inject-low-confidence-objective-memory", (checked) => {
    _patchSettings({ injectLowConfidenceObjectiveMemory: checked });
  });
  bindCheckbox("bme-setting-consolidation-enabled", (checked) => {
    _patchSettings({ enableConsolidation: checked });
    _refreshGuardedConfigStates();
  });
  bindCheckbox("bme-setting-synopsis-enabled", (checked) => {
    _patchSettings({
      enableHierarchicalSummary: checked,
      enableSynopsis: checked,
    });
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
  const extractModeEl = document.getElementById("bme-extract-mode");
  if (extractModeEl && extractModeEl.dataset.bmeBound !== "true") {
    extractModeEl.addEventListener("change", () => {
      _patchSettings({
        extractActionMode:
          String(extractModeEl.value || "pending").trim().toLowerCase() ===
          "rerun"
            ? "rerun"
            : "pending",
      });
    });
    extractModeEl.dataset.bmeBound = "true";
  }
  const cloudStorageModeEl = document.getElementById(
    "bme-setting-cloud-storage-mode",
  );
  if (cloudStorageModeEl && cloudStorageModeEl.dataset.bmeBound !== "true") {
    cloudStorageModeEl.addEventListener("change", () => {
      const settings = _patchSettings({
        cloudStorageMode: cloudStorageModeEl.value || "automatic",
      });
      _refreshCloudStorageModeUi(settings);
    });
    cloudStorageModeEl.dataset.bmeBound = "true";
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
  bindCheckbox(
    "bme-setting-extract-auto-delay-latest-assistant",
    (checked) =>
      _patchSettings({ extractAutoDelayLatestAssistant: checked }),
  );
  bindNumber("bme-setting-extract-recent-message-cap", 0, 0, 200, (value) =>
    _patchSettings({ extractRecentMessageCap: value }),
  );
  const extractStructuredModeEl = document.getElementById(
    "bme-setting-extract-prompt-structured-mode",
  );
  if (extractStructuredModeEl && extractStructuredModeEl.dataset.bmeBound !== "true") {
    extractStructuredModeEl.addEventListener("change", () => {
      _patchSettings({ extractPromptStructuredMode: extractStructuredModeEl.value || "both" });
    });
    extractStructuredModeEl.dataset.bmeBound = "true";
  }
  const extractWorldbookModeEl = document.getElementById(
    "bme-setting-extract-worldbook-mode",
  );
  if (extractWorldbookModeEl && extractWorldbookModeEl.dataset.bmeBound !== "true") {
    extractWorldbookModeEl.addEventListener("change", () => {
      _patchSettings({ extractWorldbookMode: extractWorldbookModeEl.value || "active" });
    });
    extractWorldbookModeEl.dataset.bmeBound = "true";
  }
  bindCheckbox(
    "bme-setting-extract-include-summaries",
    (checked) => _patchSettings({ extractIncludeSummaries: checked }),
  );
  bindCheckbox(
    "bme-setting-extract-include-story-time",
    (checked) => _patchSettings({ extractIncludeStoryTime: checked }),
  );
  bindNumber("bme-setting-recall-top-k", 20, 1, 100, (value) =>
    _patchSettings({ recallTopK: value }),
  );
  bindNumber("bme-setting-recall-max-nodes", 12, 1, 50, (value) =>
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
  bindCheckbox(
    "bme-setting-recall-use-authoritative-generation-input",
    (checked) =>
      _patchSettings({ recallUseAuthoritativeGenerationInput: checked }),
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
  bindNumber("bme-setting-synopsis-every", 3, 1, 100, (value) =>
    _patchSettings({
      smallSummaryEveryNExtractions: value,
      synopsisEveryN: value,
    }),
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
  bindNumber(
    "bme-setting-graph-native-layout-threshold-nodes",
    280,
    1,
    20000,
    (value) => _patchSettings({ graphNativeLayoutThresholdNodes: value }),
  );
  bindNumber(
    "bme-setting-graph-native-layout-threshold-edges",
    1600,
    1,
    50000,
    (value) => _patchSettings({ graphNativeLayoutThresholdEdges: value }),
  );
  bindNumber(
    "bme-setting-graph-native-layout-worker-timeout-ms",
    260,
    40,
    15000,
    (value) => _patchSettings({ graphNativeLayoutWorkerTimeoutMs: value }),
  );
  bindNumber(
    "bme-setting-persist-native-delta-threshold-records",
    20000,
    0,
    200000,
    (value) => _patchSettings({ persistNativeDeltaThresholdRecords: value }),
  );
  bindNumber(
    "bme-setting-persist-native-delta-threshold-structural-delta",
    600,
    0,
    200000,
    (value) => _patchSettings({ persistNativeDeltaThresholdStructuralDelta: value }),
  );
  bindNumber(
    "bme-setting-persist-native-delta-threshold-serialized-chars",
    4000000,
    0,
    50000000,
    (value) => _patchSettings({ persistNativeDeltaThresholdSerializedChars: value }),
  );
  bindNumber(
    "bme-setting-load-native-hydrate-threshold-records",
    12000,
    0,
    200000,
    (value) => _patchSettings({ loadNativeHydrateThresholdRecords: value }),
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
      _refreshMemoryLlmProviderHelp(preset.llmApiUrl);
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
    _refreshMemoryLlmProviderHelp(value);
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
      if (!_ensurePluginEnabledForAction("应用消息隐藏")) return;
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
      if (!_ensurePluginEnabledForAction("清除消息隐藏")) return;
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
    workspace.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest(".bme-task-drag-handle");
      const row = target.closest(".bme-task-block-row");
      if (!handle || !(row instanceof HTMLElement)) return;
      const blockId = String(row.dataset.blockId || "").trim();
      if (!blockId) return;
      currentTaskProfileDragBlockId = blockId;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
        event.dataTransfer.setData("text/plain", blockId);
      }
      window.requestAnimationFrame(() => {
        row.classList.add("dragging");
      });
    });
    workspace.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !currentTaskProfileDragBlockId) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const position = _getTaskBlockDropPosition(row, event.clientY);
      _setTaskBlockDragIndicator(workspace, row, position);
    });
    workspace.addEventListener("dragleave", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && row.contains(relatedTarget)) {
        return;
      }
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });
    workspace.addEventListener("drop", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-task-block-row");
      if (!(row instanceof HTMLElement)) return;
      event.preventDefault();
      const sourceId =
        currentTaskProfileDragBlockId ||
        String(event.dataTransfer?.getData("text/plain") || "").trim();
      const targetId = String(row.dataset.blockId || "").trim();
      const position = _getTaskBlockDropPosition(row, event.clientY);
      _clearTaskBlockDragIndicators(workspace);
      currentTaskProfileDragBlockId = "";
      if (!sourceId || !targetId || sourceId === targetId) return;
      _reorderTaskBlocks(sourceId, targetId, position);
    });
    workspace.addEventListener("dragend", () => {
      currentTaskProfileDragBlockId = "";
      _clearTaskBlockDragIndicators(workspace);
    });
    workspace.addEventListener("dragstart", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const handle = target.closest(".bme-regex-drag-handle");
      const row = target.closest(".bme-regex-rule-row");
      if (!handle || !(row instanceof HTMLElement)) return;
      const ruleId = String(row.dataset.ruleId || "").trim();
      if (!ruleId) return;
      currentTaskProfileDragRuleId = ruleId;
      currentTaskProfileDragRuleIsGlobal = _isGlobalRegexPanelTarget(row);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.dropEffect = "move";
        event.dataTransfer.setData("text/plain", ruleId);
      }
      window.requestAnimationFrame(() => {
        row.classList.add("dragging");
      });
    });
    workspace.addEventListener("dragover", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !currentTaskProfileDragRuleId) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const isGlobalRow = _isGlobalRegexPanelTarget(row);
      if (isGlobalRow !== currentTaskProfileDragRuleIsGlobal) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      const position = _getRegexRuleDropPosition(row, event.clientY);
      _setRegexRuleDragIndicator(workspace, row, position);
    });
    workspace.addEventListener("dragleave", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && row.contains(relatedTarget)) {
        return;
      }
      row.classList.remove("drag-over-top", "drag-over-bottom");
    });
    workspace.addEventListener("drop", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const row = target.closest(".bme-regex-rule-row");
      if (!(row instanceof HTMLElement)) return;
      const isGlobalRow = _isGlobalRegexPanelTarget(row);
      if (isGlobalRow !== currentTaskProfileDragRuleIsGlobal) return;
      event.preventDefault();
      const sourceId =
        currentTaskProfileDragRuleId ||
        String(event.dataTransfer?.getData("text/plain") || "").trim();
      const targetId = String(row.dataset.ruleId || "").trim();
      const position = _getRegexRuleDropPosition(row, event.clientY);
      _clearRegexRuleDragIndicators(workspace);
      currentTaskProfileDragRuleId = "";
      currentTaskProfileDragRuleIsGlobal = false;
      if (!sourceId || !targetId || sourceId === targetId) return;
      _reorderRegexRules(sourceId, targetId, position, isGlobalRow);
    });
    workspace.addEventListener("dragend", () => {
      currentTaskProfileDragRuleId = "";
      currentTaskProfileDragRuleIsGlobal = false;
      _clearRegexRuleDragIndicators(workspace);
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
        const parsed = JSON.parse(text);
        let nextGlobalTaskRegex = _normalizeGlobalRegexDraft(
          settings.globalTaskRegex || {},
        );
        const importedGlobalMerge = _mergeImportedGlobalRegex(
          nextGlobalTaskRegex,
          parsed?.globalTaskRegex,
        );
        nextGlobalTaskRegex = importedGlobalMerge.globalTaskRegex;
        let imported = parseImportedTaskProfile(
          settings.taskProfiles || {},
          parsed,
        );
        const legacyRuleMerge = _mergeProfileRegexRulesIntoGlobal(
          nextGlobalTaskRegex,
          imported.profile,
          {
            applyLegacyConfig: !importedGlobalMerge.replacedConfig,
          },
        );
        nextGlobalTaskRegex = legacyRuleMerge.globalTaskRegex;
        if (legacyRuleMerge.clearedLegacyRules) {
          imported = {
            ...imported,
            profile: legacyRuleMerge.profile,
            taskProfiles: upsertTaskProfile(
              imported.taskProfiles,
              imported.taskType,
              legacyRuleMerge.profile,
              { setActive: true },
            ),
          };
        }
        currentTaskProfileTaskType = imported.taskType || currentTaskProfileTaskType;
        currentTaskProfileBlockId = imported.profile?.blocks?.[0]?.id || "";
        currentTaskProfileRuleId =
          imported.profile?.regex?.localRules?.[0]?.id || "";
        _patchSettings(
          {
            taskProfilesVersion: 3,
            taskProfiles: imported.taskProfiles,
            globalTaskRegex: nextGlobalTaskRegex,
          },
          {
            refreshTaskWorkspace: true,
          },
        );
        const mergedRuleCount =
          importedGlobalMerge.mergedRuleCount + legacyRuleMerge.mergedRuleCount;
        toastr.success(
          mergedRuleCount > 0
            ? `预设导入成功，${mergedRuleCount} 条正则规则已合并到通用正则规则`
            : "预设导入成功",
          "ST-BME",
        );
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
        let nextGlobalTaskRegex = _normalizeGlobalRegexDraft(
          settings.globalTaskRegex || {},
        );
        const importedGlobalMerge = _mergeImportedGlobalRegex(
          nextGlobalTaskRegex,
          parsed?.globalTaskRegex,
        );
        nextGlobalTaskRegex = importedGlobalMerge.globalTaskRegex;
        let importedCount = 0;
        let mergedLegacyRuleCount = 0;
        let legacyConfigImported = Boolean(importedGlobalMerge.replacedConfig);
        let skippedLegacyConfigCount = 0;
        for (const [taskType, entry] of Object.entries(parsed.profiles)) {
          try {
            let imported = parseImportedTaskProfile(
              mergedProfiles,
              entry,
              taskType,
            );
            const legacyRuleMerge = _mergeProfileRegexRulesIntoGlobal(
              nextGlobalTaskRegex,
              imported.profile,
              {
                applyLegacyConfig: !legacyConfigImported,
              },
            );
            nextGlobalTaskRegex = legacyRuleMerge.globalTaskRegex;
            mergedLegacyRuleCount += legacyRuleMerge.mergedRuleCount;
            if (legacyRuleMerge.appliedLegacyConfig) {
              legacyConfigImported = true;
            } else if (legacyRuleMerge.hasConfigDiff && legacyConfigImported) {
              skippedLegacyConfigCount += 1;
            }
            if (legacyRuleMerge.clearedLegacyRules) {
              imported = {
                ...imported,
                profile: legacyRuleMerge.profile,
                taskProfiles: upsertTaskProfile(
                  imported.taskProfiles,
                  imported.taskType,
                  legacyRuleMerge.profile,
                  { setActive: true },
                ),
              };
            }
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
        _patchSettings(
          {
            taskProfilesVersion: 3,
            taskProfiles: mergedProfiles,
            globalTaskRegex: nextGlobalTaskRegex,
          },
          {
            refreshTaskWorkspace: true,
          },
        );
        const mergedRuleCount =
          importedGlobalMerge.mergedRuleCount + mergedLegacyRuleCount;
        if (skippedLegacyConfigCount > 0) {
          console.warn(
            `[ST-BME] 导入全部旧版预设时检测到 ${skippedLegacyConfigCount} 份额外任务级正则配置冲突，已保留第一份迁移到通用正则的配置，其余仅合并规则。`,
          );
        }
        toastr.success(
          mergedRuleCount > 0
            ? `已导入 ${importedCount} 个任务预设，并合并 ${mergedRuleCount} 条通用正则规则`
            : `已导入 ${importedCount} 个任务预设`,
          "ST-BME",
        );
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
  const isGlobalRegexPanel = _isGlobalRegexPanelTarget(target);

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

  if (target.matches("[data-input-key]")) {
    _persistTaskInputField(target, false);
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    if (isGlobalRegexPanel) {
      _persistSelectedGlobalRegexRuleField(target, false);
    } else {
      _persistSelectedRegexRuleField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-rule-row-enabled]")) {
    const ruleId = String(target.dataset.ruleId || "").trim();
    if (!ruleId) return;
    _persistRegexRuleEnabledById(ruleId, Boolean(target.checked), isGlobalRegexPanel, false);
  }
}

function _handleTaskProfileWorkspaceChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const isGlobalRegexPanel = _isGlobalRegexPanelTarget(target);

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

  if (target.matches("[data-input-key]")) {
    _persistTaskInputField(target, true);
    return;
  }

  if (target.matches("[data-regex-field]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexField(target, false);
    } else {
      _persistRegexConfigField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-source]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexSourceField(target, false);
    } else {
      _persistRegexSourceField(target, false);
    }
    return;
  }

  if (target.matches("[data-regex-stage]")) {
    if (isGlobalRegexPanel) {
      _persistGlobalRegexStageField(target, false);
    } else {
      _persistRegexStageField(target, false);
    }
    return;
  }

  if (
    target.matches("[data-regex-rule-field]") ||
    target.matches("[data-regex-rule-source]") ||
    target.matches("[data-regex-rule-destination]")
  ) {
    if (isGlobalRegexPanel) {
      _persistSelectedGlobalRegexRuleField(target, true);
    } else {
      _persistSelectedRegexRuleField(target, true);
    }
    return;
  }

  if (target.matches("[data-regex-rule-row-enabled]")) {
    const ruleId = String(target.dataset.ruleId || "").trim();
    if (!ruleId) return;
    _persistRegexRuleEnabledById(ruleId, Boolean(target.checked), isGlobalRegexPanel, true);
  }
}

function _getTaskProfileWorkspaceState(settings = _getSettings?.() || {}) {
  const taskProfiles = ensureTaskProfiles(settings);
  const globalTaskRegex = _normalizeGlobalRegexDraft(settings.globalTaskRegex || {});
  const globalRegexRules = Array.isArray(globalTaskRegex.localRules)
    ? globalTaskRegex.localRules
    : [];
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

  if (currentTaskProfileBlockId && !blocks.some((block) => block.id === currentTaskProfileBlockId)) {
    currentTaskProfileBlockId = blocks[0]?.id || "";
  }
  if (currentTaskProfileRuleId && !regexRules.some((rule) => rule.id === currentTaskProfileRuleId)) {
    currentTaskProfileRuleId = regexRules[0]?.id || "";
  }
  if (currentGlobalRegexRuleId && !globalRegexRules.some((rule) => rule.id === currentGlobalRegexRuleId)) {
    currentGlobalRegexRuleId = globalRegexRules[0]?.id || "";
  }

  const builtinBlockDefinitions = getBuiltinBlockDefinitions(currentTaskProfileTaskType);

  return {
    settings,
    taskProfiles,
    globalTaskRegex,
    globalRegexRules,
    showGlobalRegex: showGlobalRegexPanel,
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
    selectedGlobalRegexRule:
      globalRegexRules.find((rule) => rule.id === currentGlobalRegexRuleId) || null,
    builtinBlockDefinitions,
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
  const graphPersistence = _getGraphPersistenceSnapshot();

  return {
    settings,
    panelDebug,
    runtimeDebug,
    recallInjection: runtimeDebug?.injections?.recall || null,
    graphLayout: runtimeDebug?.graphLayout || null,
    persistDelta:
      graphPersistence?.persistDelta || runtimeDebug?.graphPersistence?.persistDelta || null,
    loadDiagnostics:
      graphPersistence?.loadDiagnostics ||
      runtimeDebug?.graphPersistence?.loadDiagnostics ||
      null,
    messageTrace: runtimeDebug?.messageTrace || null,
    recallLlmRequest: runtimeDebug?.taskLlmRequests?.recall || null,
    recallPromptBuild: runtimeDebug?.taskPromptBuilds?.recall || null,
    extractLlmRequest: runtimeDebug?.taskLlmRequests?.extract || null,
    extractPromptBuild: runtimeDebug?.taskPromptBuilds?.extract || null,
    taskTimeline: Array.isArray(runtimeDebug?.taskTimeline)
      ? runtimeDebug.taskTimeline
      : [],
    graph: _getGraph?.() || null,
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
    state.graphLayout?.updatedAt,
    state.persistDelta?.updatedAt,
    state.loadDiagnostics?.updatedAt,
    state.recallLlmRequest?.updatedAt,
    state.extractLlmRequest?.updatedAt,
    state.extractPromptBuild?.updatedAt,
    ...(Array.isArray(state.taskTimeline)
      ? state.taskTimeline.map((entry) => entry?.updatedAt)
      : []),
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
        <div class="bme-config-card">
          ${_renderAiMonitorTraceCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderAiMonitorCognitionCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderGraphLayoutTraceCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderPersistDeltaTraceCard(state)}
        </div>
        <div class="bme-config-card">
          ${_renderHydrateNativeTraceCard(state)}
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

function _formatDurationMs(durationMs) {
  const normalized = Number(durationMs);
  if (!Number.isFinite(normalized) || normalized <= 0) return "—";
  if (normalized < 1000) return `${Math.round(normalized)}ms`;
  return `${(normalized / 1000).toFixed(normalized >= 10000 ? 0 : 1)}s`;
}

function _formatDataSizeBytes(byteCount) {
  const normalized = Number(byteCount);
  if (!Number.isFinite(normalized) || normalized <= 0) return "—";
  if (normalized < 1024) return `${Math.round(normalized)} B`;
  if (normalized < 1024 * 1024) {
    return `${(normalized / 1024).toFixed(normalized >= 10 * 1024 ? 0 : 1)} KB`;
  }
  return `${(normalized / (1024 * 1024)).toFixed(normalized >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function _getMonitorTaskTypeLabel(taskType = "") {
  const normalized = String(taskType || "").trim().toLowerCase();
  const labels = {
    extract: "提取",
    recall: "召回",
    consolidation: "整合",
    compress: "压缩",
    synopsis: "小总结",
    summary_rollup: "总结折叠",
    reflection: "反思",
    sleep: "遗忘",
    evolve: "进化",
    embed: "向量",
    rebuild: "重建",
  };
  return labels[normalized] || String(taskType || "未知任务");
}

function _getMonitorStatusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "未知状态";
  if (normalized.includes("error") || normalized.includes("fail")) return "失败";
  if (normalized.includes("run")) return "运行中";
  if (normalized.includes("queue")) return "排队中";
  if (normalized.includes("pending")) return "等待中";
  if (normalized.includes("skip")) return "已跳过";
  if (normalized.includes("fallback")) return "已回退";
  if (normalized.includes("disable")) return "已关闭";
  if (
    normalized.includes("success") ||
    normalized.includes("complete") ||
    normalized.includes("done") ||
    normalized === "ok"
  ) {
    return "成功";
  }
  return String(status || "未知状态");
}

function _getMonitorRoleLabel(role = "") {
  const normalized = String(role || "").trim().toLowerCase();
  const labels = {
    system: "系统",
    user: "用户",
    assistant: "助手",
    tool: "工具",
  };
  return labels[normalized] || String(role || "未知");
}

function _getMonitorRouteLabel(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const labels = {
    "dedicated-openai-compatible": "专用 OpenAI 兼容接口",
    "dedicated-anthropic-claude": "Anthropic Claude 接口",
    "dedicated-google-ai-studio": "Google AI Studio / Gemini 接口",
    "sillytavern-current-model": "酒馆当前模型",
    "dedicated-memory-llm": "专用记忆模型",
    global: "跟随当前 API",
    "task-preset": "任务专用模板",
    "global-fallback-missing-task-preset": "任务模板缺失，已回退当前 API",
    "global-fallback-invalid-task-preset": "任务模板不完整，已回退当前 API",
  };
  return labels[normalized] || normalized;
}

function _getMonitorStageLabel(stage = "") {
  const normalized = String(stage || "").trim();
  if (!normalized) return "—";
  const labels = {
    "input.userMessage": "输入阶段: 当前用户消息",
    "input.recentMessages": "输入阶段: 最近消息",
    "input.candidateText": "输入阶段: 候选文本",
    "input.finalPrompt": "输入阶段: 最终提示词",
    "output.rawResponse": "输出阶段: 原始响应",
    "output.beforeParse": "输出阶段: 解析前",
    "world-info-rendered": "世界书渲染后",
    "final-injection-safe": "注入内容最终清洗",
    "host:user_input": "宿主注入: 用户输入",
    "host:ai_output": "宿主注入: AI 输出",
    "host:world_info": "宿主注入: 世界书",
    "host:reasoning": "宿主注入: 思维链/推理",
  };
  return labels[normalized] || normalized;
}

function _formatMonitorStageList(stages = []) {
  if (!Array.isArray(stages) || !stages.length) return "—";
  return stages
    .map((entry) => _getMonitorStageLabel(entry?.stage || entry))
    .filter(Boolean)
    .join("、") || "—";
}

function _getMonitorEjsStatusLabel(status = "") {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return "";
  const labels = {
    primary: "主运行时",
    fallback: "回退运行时",
    failed: "不可用",
  };
  return labels[normalized] || String(status || "");
}

function _formatMonitorRouteInfo(entry = {}) {
  const parts = [
    _getMonitorRouteLabel(entry?.routeLabel || entry?.route),
    String(entry?.llmProviderLabel || "").trim(),
    _getMonitorRouteLabel(entry?.llmConfigSourceLabel),
    String(entry?.model || "").trim() ? `模型：${String(entry.model).trim()}` : "",
  ].filter(Boolean);
  const uniqueParts = [];
  for (const part of parts) {
    if (!uniqueParts.includes(part)) uniqueParts.push(part);
  }
  return uniqueParts.join(" · ") || "未记录路由信息";
}

function _summarizeMonitorGovernance(entry = {}) {
  const promptExecution = entry?.promptExecution || {};
  const worldInfo = promptExecution?.worldInfo || null;
  const regexInput = Array.isArray(promptExecution?.regexInput)
    ? promptExecution.regexInput
    : [];
  const requestCleaning = entry?.requestCleaning || null;
  const responseCleaning = entry?.responseCleaning || null;
  const persistence = entry?.batchStatus?.persistence || entry?.persistence || null;
  const lines = [];

  if (worldInfo) {
    lines.push(
      `世界书: ${worldInfo.hit ? "命中" : "未命中"} · 前置 ${Number(worldInfo.beforeCount || 0)} · 后置 ${Number(worldInfo.afterCount || 0)} · 深度 ${Number(worldInfo.atDepthCount || 0)}`,
    );
  }
  if (promptExecution?.ejsRuntimeStatus) {
    lines.push(`EJS: ${_getMonitorEjsStatusLabel(promptExecution.ejsRuntimeStatus)}`);
  }
  if (regexInput.length > 0) {
    const appliedRuleCount = regexInput.reduce(
      (sum, item) => sum + Number(item?.appliedRules?.length || 0),
      0,
    );
    lines.push(`输入治理: ${regexInput.length} 段 · 命中 ${appliedRuleCount} 条规则`);
  }
  if (requestCleaning) {
    lines.push(
      `发送前清洗: ${requestCleaning.changed ? "有改动" : "无改动"} · 阶段 ${_formatMonitorStageList(requestCleaning.stages)}`,
    );
  }
  if (responseCleaning) {
    lines.push(
      `响应清洗: ${responseCleaning.changed ? "有改动" : "无改动"} · 阶段 ${_formatMonitorStageList(responseCleaning.stages)}`,
    );
  }
  if (entry?.jsonFailure?.failureReason) {
    lines.push(`失败原因: ${String(entry.jsonFailure.failureReason || "")}`);
  }
  if (persistence) {
    lines.push(
      `持久化: ${_formatPersistenceOutcomeLabel(persistence.outcome)} · ${String(persistence.storageTier || "none")}${persistence.reason ? ` · ${String(persistence.reason)}` : ""}`,
    );
  }
  return lines;
}

function _buildMonitorMessagesPreview(messages = []) {
  const text = _stringifyTraceMessages(messages);
  if (!text) return "";
  if (text.length <= 1800) return text;
  return `${text.slice(0, 1800)}\n\n...（已截断）`;
}

function _renderAiMonitorTraceCard(state) {
  const timeline = Array.isArray(state.taskTimeline) ? state.taskTimeline : [];

  if (!timeline.length) {
    return `
      <div class="bme-config-card-title">最近任务快照</div>
      <div class="bme-config-help">
        还没有任务流水。等提取、召回或维护任务跑过一轮后，这里就会出现最近记录。
      </div>
    `;
  }

  const cards = timeline
    .slice(-8)
    .reverse()
    .map((entry, idx) => {
      const summaryLines = _summarizeMonitorGovernance(entry);
      const previewText = _buildMonitorMessagesPreview(entry?.messages || []);
      const modelLabel =
        String(entry?.llmPresetName || "").trim() ||
        String(entry?.llmConfigSourceLabel || "").trim() ||
        String(entry?.model || "").trim() ||
        "未知模型";
      const taskType = String(entry?.taskType || "unknown");
      const taskLabel = _getMonitorTaskTypeLabel(taskType);
      const status = String(entry?.status || "").toLowerCase();
      const dotClass = status.includes("error") || status.includes("fail")
        ? "dot-error"
        : status.includes("run")
          ? "dot-running"
          : "dot-success";
      const routeInfo = _formatMonitorRouteInfo(entry);

      // Governance tags
      const govTags = [];
      const pe = entry?.promptExecution || {};
      if (pe.worldInfo?.hit) govTags.push({ cls: "tag-worldinfo", label: `世界书 ${Number(pe.worldInfo.beforeCount || 0) + Number(pe.worldInfo.afterCount || 0) + Number(pe.worldInfo.atDepthCount || 0)}条` });
      if (pe.ejsRuntimeStatus) govTags.push({ cls: "tag-ejs", label: "EJS" });
      if (Array.isArray(pe.regexInput) && pe.regexInput.length) {
        const ruleCount = pe.regexInput.reduce((s, i) => s + Number(i?.appliedRules?.length || 0), 0);
        govTags.push({ cls: "tag-regex", label: `正则 ${ruleCount}条` });
      }
      if (entry?.requestCleaning?.changed) govTags.push({ cls: "tag-cleaning", label: "发送清洗" });
      if (entry?.responseCleaning?.changed) govTags.push({ cls: "tag-cleaning", label: "响应清洗" });
      if (entry?.jsonFailure?.failureReason) govTags.push({ cls: "tag-error", label: "JSON失败" });

      const govTagsHtml = govTags.length
        ? `<div class="bme-ai-monitor-governance-tags">${govTags.map(t => `<span class="bme-ai-monitor-gov-tag ${t.cls}">${_escHtml(t.label)}</span>`).join("")}</div>`
        : "";

      const connector = idx < 7 ? `<div class="bme-ai-monitor-timeline-connector"></div>` : "";

      return `
        <div class="bme-ai-monitor-entry is-collapsed" data-bme-trace-idx="${idx}">
          <div class="bme-ai-monitor-entry__head">
            <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
              <div class="bme-ai-monitor-status-dot ${dotClass}"></div>
              <div style="min-width:0;flex:1">
                <div class="bme-ai-monitor-entry__title">${_escHtml(taskLabel)}
                  <span style="font-weight:400;opacity:0.5;font-size:11px;margin-left:4px">${_escHtml(_formatDurationMs(entry?.durationMs))}</span>
                </div>
                <div class="bme-ai-monitor-entry__meta">
                  ${_escHtml(
                    [
                      _getMonitorStatusLabel(entry?.status),
                      _formatTaskProfileTime(entry?.updatedAt),
                    ].filter(Boolean).join(" · "),
                  )}
                </div>
              </div>
            </div>
            <span class="bme-task-pill">${_escHtml(modelLabel)}</span>
            <button class="bme-ai-monitor-entry__toggle" type="button" title="展开/折叠">
              <i class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
          ${govTagsHtml}
          <div class="bme-ai-monitor-entry__detail">
            <div class="bme-config-help">${_escHtml(routeInfo)}</div>
            ${
              summaryLines.length
                ? `<div class="bme-ai-monitor-entry__summary">${summaryLines
                    .map((line) => `<div>${_escHtml(line)}</div>`)
                    .join("")}</div>`
                : ""
            }
            ${_renderMessageTraceTextBlock(
              "最终发送消息预览",
              previewText,
              "这条任务没有捕获到完整的消息预览。",
            )}
          </div>
        </div>
        ${connector}
      `;
    })
    .join("");

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">最近任务快照</div>
        <div class="bme-config-card-subtitle">
          最近 ${Math.min(timeline.length, 8)} 条任务快照 · 点击展开查看详情
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(String(timeline.length))} 条</span>
    </div>
    <div class="bme-ai-monitor-stack">
      ${cards}
    </div>
  `;
}


function _renderAiMonitorCognitionCard(state) {
  const graph = state.graph || null;
  const historyState = graph?.historyState || {};
  const regionState = graph?.regionState || {};
  const owners = _getCognitionOwnerCollection(graph);
  const latestRecallOwnerInfo = _getLatestRecallOwnerInfo(graph);
  const activeRegion = String(
    historyState.activeRegion ||
      historyState.lastExtractedRegion ||
      regionState.manualActiveRegion ||
      "",
  ).trim();
  const adjacentRegions = Array.isArray(regionState?.adjacencyMap?.[activeRegion]?.adjacent)
    ? regionState.adjacencyMap[activeRegion].adjacent
    : [];

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">认知 / 空间运行快照</div>
        <div class="bme-config-card-subtitle">
          这里展示当前聊天最新落地的认知锚点和空间上下文，不再靠前端临时猜。
        </div>
      </div>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>当前场景锚点</span>
        <strong>${_escHtml(
          latestRecallOwnerInfo.ownerLabels.length > 0
            ? latestRecallOwnerInfo.ownerLabels.join(" / ")
            : "—",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>兼容旧锚点</span>
        <strong>${_escHtml(
          Array.isArray(historyState.recentRecallOwnerKeys) &&
            historyState.recentRecallOwnerKeys.length
            ? historyState.recentRecallOwnerKeys.join(" / ")
            : "—",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>当前地区</span>
        <strong>${_escHtml(
          activeRegion
            ? `${activeRegion}${
                historyState.activeRegionSource
                  ? ` · ${historyState.activeRegionSource}`
                  : ""
              }`
            : "—",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>邻接地区</span>
        <strong>${_escHtml(adjacentRegions.length ? adjacentRegions.join(" / ") : "—")}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>认知角色数</span>
        <strong>${_escHtml(String(owners.length || 0))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>最后提取地区</span>
        <strong>${_escHtml(String(historyState.lastExtractedRegion || "—"))}</strong>
      </div>
    </div>
  `;
}

function _renderGraphLayoutTraceCard(state) {
  const layout = state.graphLayout || null;
  if (!layout) {
    return `
      <div class="bme-config-card-title">图布局 / Native 诊断</div>
      <div class="bme-config-help">
        还没有图布局诊断快照。打开图谱页并触发一次布局后，这里会显示实际执行路径、耗时和 native 模块来源。
      </div>
    `;
  }

  const mode = String(layout.mode || layout.solver || 'unknown').trim() || 'unknown';
  const moduleSource = String(layout.moduleSource || '').trim() || '—';
  const reason = String(layout.reason || '').trim() || '—';
  const nativeLoadError = String(layout.nativeLoadError || '').trim();

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">图布局 / Native 诊断</div>
        <div class="bme-config-card-subtitle">
          记录最近一次图布局走了哪条路径，以及 native 模块是 wasm-pack 产物还是 fallback loader。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(layout.updatedAt || layout.at))}</span>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>布局路径</span>
        <strong>${_escHtml(mode)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>节点 / 边</span>
        <strong>${_escHtml(`${Number(layout.nodeCount || 0)} / ${Number(layout.edgeCount || 0)}`)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>总耗时</span>
        <strong>${_escHtml(_formatDurationMs(layout.totalMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>求解耗时</span>
        <strong>${_escHtml(_formatDurationMs(layout.solveMs || layout.workerSolveMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>迭代次数</span>
        <strong>${_escHtml(String(layout.iterations || '—'))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native 来源</span>
        <strong>${_escHtml(moduleSource)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>状态原因</span>
        <strong>${_escHtml(reason)}</strong>
      </div>
    </div>
    ${_renderMessageTraceTextBlock(
      'Native load error',
      nativeLoadError,
      '当前没有 native load error。',
    )}
  `;
}

function _formatPersistDeltaGateReasonText(reasons = []) {
  const labels = {
    "below-record-threshold": "记录数不足",
    "below-structural-delta-threshold": "结构变化不足",
    "below-serialized-chars-threshold": "序列化体积不足",
  };
  const normalized = Array.isArray(reasons)
    ? reasons
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  if (!normalized.length) return "—";
  return normalized.map((item) => labels[item] || item).join(" · ");
}

function _formatPersistDeltaGateText(diagnostics = null) {
  if (!diagnostics || typeof diagnostics !== "object") return "—";
  if (diagnostics.requestedNative !== true) return "未请求 native";
  if (diagnostics.nativeForceDisabled === true) return "已强制关闭";
  if (diagnostics.gateAllowed === true) return "通过";
  return `已拦截 · ${_formatPersistDeltaGateReasonText(diagnostics.gateReasons)}`;
}

function _renderPersistDeltaTraceCard(state) {
  const diagnostics = state.persistDelta || null;
  if (!diagnostics) {
    return `
      <div class="bme-config-card-title">Persist Delta / Native 诊断</div>
      <div class="bme-config-help">
        还没有 persist delta 诊断快照。等图谱完成一次 IndexedDB 写回后，这里会显示 gate、执行路径、耗时和 fallback 原因。
      </div>
    `;
  }

  const moduleSource = String(diagnostics.moduleSource || "").trim() || "—";
  const fallbackReason = String(diagnostics.fallbackReason || "").trim();
  const errorText = String(
    diagnostics.moduleError || diagnostics.preloadError || diagnostics.nativeError || "",
  ).trim();
  const payloadCharsText = diagnostics.combinedSerializedChars
    ? `${Number(diagnostics.combinedSerializedChars || 0)} / ${Number(diagnostics.minCombinedSerializedChars || 0)}`
    : "—";
  const snapshotBuildText = `${_formatDurationMs(diagnostics.baseSnapshotReadMs)} / ${_formatDurationMs(
    diagnostics.snapshotBuildMs,
  )}`;
  const commitPhaseText = _formatPersistCommitPhaseText(diagnostics);
  const commitBreakdownText = _formatPersistCommitBreakdownText(diagnostics);
  const commitBytesText = _formatPersistCommitBytesText(diagnostics);
  const cacheText = `${Number(diagnostics.serializationCacheHits || 0)}H / ${Number(
    diagnostics.serializationCacheMisses || 0,
  )}M`;
  const preparedSetCacheText = `${Number(
    diagnostics.preparedRecordSetCacheHits || 0,
  )}H / ${Number(diagnostics.preparedRecordSetCacheMisses || 0)}M`;

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Persist Delta / Native 诊断</div>
        <div class="bme-config-card-subtitle">
          记录最近一次图谱增量写回的 gate 判定、真实执行路径，以及 native preload / fallback 情况。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(diagnostics.updatedAt))}</span>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>执行路径</span>
        <strong>${_escHtml(String(diagnostics.path || "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Bridge 模式</span>
        <strong>${_escHtml(
          `${String(diagnostics.requestedBridgeMode || "none")} → ${String(diagnostics.preparedBridgeMode || "none")}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native Gate</span>
        <strong>${_escHtml(_formatPersistDeltaGateText(diagnostics))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>快照记录数</span>
        <strong>${_escHtml(`${Number(diagnostics.beforeRecordCount || 0)} → ${Number(diagnostics.afterRecordCount || 0)}`)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>结构变化量</span>
        <strong>${_escHtml(String(diagnostics.structuralDelta ?? "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Payload chars</span>
        <strong>${_escHtml(payloadCharsText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>总耗时</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.totalMs || diagnostics.buildMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>构建耗时</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.buildMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Base / Snapshot</span>
        <strong>${_escHtml(snapshotBuildText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Prepare / Native</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.prepareMs)} / ${_formatDurationMs(diagnostics.nativeAttemptMs)}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Lookup / JS Diff</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.lookupMs)} / ${_formatDurationMs(diagnostics.jsDiffMs)}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Hydrate / Cache</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.hydrateMs)} / ${cacheText}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Commit 排队 / 提交</span>
        <strong>${_escHtml(commitPhaseText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Commit 细分</span>
        <strong>${_escHtml(commitBreakdownText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Commit Payload</span>
        <strong>${_escHtml(commitBytesText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>PreparedSet Cache</span>
        <strong>${_escHtml(preparedSetCacheText)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Preload</span>
        <strong>${_escHtml(String(diagnostics.preloadStatus || "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native 来源</span>
        <strong>${_escHtml(moduleSource)}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>增量规模</span>
        <strong>${_escHtml(
          `${Number(diagnostics.upsertNodeCount || 0)}N / ${Number(diagnostics.upsertEdgeCount || 0)}E / ${Number(diagnostics.deleteNodeCount || 0)}DN / ${Number(diagnostics.deleteEdgeCount || 0)}DE`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>未归因</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.untrackedMs))}</strong>
      </div>
    </div>
    ${_renderMessageTraceTextBlock(
      "Fallback reason",
      fallbackReason,
      "这次没有发生 native fallback。",
    )}
    ${_renderMessageTraceTextBlock(
      "Preload / native error",
      errorText,
      "当前没有 preload / native error。",
    )}
  `;
}

function _renderHydrateNativeTraceCard(state) {
  const diagnostics = _readPersistenceDiagnosticObject(state.loadDiagnostics);
  if (!diagnostics) {
    return `
      <div class="bme-config-card-title">Hydrate / Native 诊断</div>
      <div class="bme-config-help">
        还没有 hydrate 诊断快照。等图谱完成一次真实加载后，这里会显示 load hydrate 是否命中 native、是否被 gate 拦截，以及 preload / module / fallback 状态。
      </div>
    `;
  }

  const errorText = String(
    diagnostics.hydrateNativeModuleError ||
      diagnostics.hydrateNativePreloadError ||
      diagnostics.hydrateNativeError ||
      diagnostics.error ||
      "",
  ).trim();

  return `
    <div class="bme-config-card-head">
      <div>
        <div class="bme-config-card-title">Hydrate / Native 诊断</div>
        <div class="bme-config-card-subtitle">
          记录最近一次图谱加载的 hydrate 是否尝试 native、是否命中、以及 preload / module / fallback 明细。
        </div>
      </div>
      <span class="bme-task-pill">${_escHtml(_formatTaskProfileTime(diagnostics.updatedAt))}</span>
    </div>
    <div class="bme-ai-monitor-kv">
      <div class="bme-ai-monitor-kv__row">
        <span>Load 阶段</span>
        <strong>${_escHtml(_formatLoadDiagnosticsStageLabel(diagnostics.stage))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Load 来源</span>
        <strong>${_escHtml(String(diagnostics.source || diagnostics.statusLabel || "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Load 状态</span>
        <strong>${_escHtml(
          diagnostics.success === true
            ? "成功"
            : diagnostics.success === false
              ? "失败"
              : "未知",
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Hydrate Native Gate</span>
        <strong>${_escHtml(_formatNativeHydrateGateText(diagnostics))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Hydrate Native 结果</span>
        <strong>${_escHtml(_formatNativeHydrateResultText(diagnostics))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Preload</span>
        <strong>${_escHtml(String(diagnostics.hydrateNativePreloadStatus || "—"))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Module</span>
        <strong>${_escHtml(_formatNativeHydrateModuleText(diagnostics))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Load / Hydrate</span>
        <strong>${_escHtml(
          `${_formatDurationMs(diagnostics.totalMs)} / ${_formatDurationMs(diagnostics.hydrateMs)}`,
        )}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Hydrate 细分</span>
        <strong>${_escHtml(_formatLoadHydrateBreakdownText(diagnostics))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>Native Records</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.hydrateNativeRecordsMs))}</strong>
      </div>
      <div class="bme-ai-monitor-kv__row">
        <span>未归因</span>
        <strong>${_escHtml(_formatDurationMs(diagnostics.untrackedMs))}</strong>
      </div>
    </div>
    ${_renderMessageTraceTextBlock(
      "Hydrate / native error",
      errorText,
      "当前没有 hydrate / native error。",
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
      (message) => `【${_getMonitorRoleLabel(message.role)}】\n${message.content}`,
    )
    .join("\n\n---\n\n");
}

function _buildMainAiTraceText(triggeredUserMessage = "", injectionText = "") {
  const sections = [];
  const normalizedUserMessage = String(triggeredUserMessage || "").trim();
  const normalizedInjectionText = String(injectionText || "").trim();

  if (normalizedUserMessage) {
    sections.push(`【用户】\n${normalizedUserMessage}`);
  }
  if (normalizedInjectionText) {
    sections.push(`【记忆注入】\n${normalizedInjectionText}`);
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
  if (
    !selectedProfile &&
    action !== "switch-task-type" &&
    action !== "switch-global-regex"
  ) return;

  switch (action) {
    case "switch-task-type":
      currentTaskProfileTaskType =
        actionEl.dataset.taskType || currentTaskProfileTaskType;
      showGlobalRegexPanel = false;
      currentTaskProfileBlockId = "";
      currentTaskProfileRuleId = "";
      _refreshTaskProfileWorkspace();
      return;
    case "switch-global-regex":
      showGlobalRegexPanel = true;
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
    case "toggle-block-expand": {
      // Ignore if the click originated from a toggle switch, delete button, or drag handle
      const originEl = event.target;
      if (originEl.closest(".bme-task-row-toggle") || originEl.closest(".bme-task-row-btn-danger") || originEl.closest(".bme-task-drag-handle")) {
        return;
      }
      const blockId = actionEl.dataset.blockId || "";
      if (currentTaskProfileBlockId === blockId) {
        currentTaskProfileBlockId = "";
      } else {
        currentTaskProfileBlockId = blockId;
      }
      _refreshTaskProfileWorkspace();
      return;
    }
    case "toggle-regex-rule-expand": {
      const originEl = event.target;
      if (
        originEl.closest(".bme-task-row-toggle") ||
        originEl.closest(".bme-task-row-btn-danger") ||
        originEl.closest(".bme-regex-drag-handle")
      ) {
        return;
      }
      const ruleId = actionEl.dataset.ruleId || "";
      if (_isGlobalRegexPanelTarget(actionEl)) {
        currentGlobalRegexRuleId =
          currentGlobalRegexRuleId === ruleId ? "" : ruleId;
      } else {
        currentTaskProfileRuleId =
          currentTaskProfileRuleId === ruleId ? "" : ruleId;
      }
      _refreshTaskProfileWorkspace();
      return;
    }
    case "select-regex-rule":
      if (_isGlobalRegexPanelTarget(actionEl)) {
        currentGlobalRegexRuleId = actionEl.dataset.ruleId || "";
      } else {
        currentTaskProfileRuleId = actionEl.dataset.ruleId || "";
      }
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
    case "toggle-block-enabled-cb":
      _updateCurrentTaskProfile((draft) => {
        const blocks = _sortTaskBlocks(draft.blocks);
        const block = blocks.find((item) => item.id === actionEl.dataset.blockId);
        if (!block) return null;
        block.enabled = actionEl.checked;
        draft.blocks = _normalizeTaskBlocks(blocks);
        return { selectBlockId: currentTaskProfileBlockId };
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
      const current = String(selectedProfile?.name || "").trim();
      const nextName = window.prompt("请输入预设名称", current);
      if (nextName == null) return;
      const trimmed = String(nextName).trim();
      if (!trimmed) {
        toastr.info("预设名称不能为空", "ST-BME");
        return;
      }
      _updateCurrentTaskProfile((draft) => {
        draft.name = trimmed;
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
      _downloadTaskProfile(
        state.taskProfiles,
        currentTaskProfileTaskType,
        selectedProfile,
        state.globalTaskRegex,
      );
      return;
    case "import-profile":
      document.getElementById("bme-task-profile-import")?.click();
      return;
    case "export-all-profiles":
      _downloadAllTaskProfiles(state.taskProfiles, state.globalTaskRegex);
      return;
    case "import-all-profiles":
      document.getElementById("bme-task-profile-import-all")?.click();
      return;
    case "restore-all-profiles": {
      const taskTypes = getTaskTypeOptions().map((t) => t.id);
      const confirmed = window.confirm(
        `这会将全部 ${taskTypes.length} 个任务的默认预设恢复为出厂状态。已保存的自定义预设不受影响，通用正则规则也不受影响。是否继续？`,
      );
      if (!confirmed) return;
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
    case "add-global-regex-rule":
      _updateGlobalTaskRegex((draft) => {
        const localRules = Array.isArray(draft.localRules) ? draft.localRules : [];
        const nextRule = createLocalRegexRule("global", {
          script_name: `通用规则 ${localRules.length + 1}`,
        });
        draft.localRules = [...localRules, nextRule];
        return { selectRuleId: nextRule.id };
      });
      return;
    case "delete-global-regex-rule":
      _deleteGlobalRegexRule(actionEl.dataset.ruleId);
      return;
    case "select-global-regex-rule":
      currentGlobalRegexRuleId = actionEl.dataset.ruleId || "";
      _refreshTaskProfileWorkspace();
      return;
    case "restore-global-regex-defaults": {
      const confirmed = window.confirm(
        "这会将通用正则规则恢复为默认配置。是否继续？",
      );
      if (!confirmed) return;
      currentGlobalRegexRuleId = "";
      _patchGlobalTaskRegex(createDefaultGlobalTaskRegex(), { refresh: true });
      toastr.success("通用正则规则已恢复默认", "ST-BME");
      return;
    }
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
  const totalTaskTypes = Array.isArray(state.taskTypeOptions) ? state.taskTypeOptions.length : 0;

  return `
    <div class="bme-task-shell">
      <div class="bme-task-action-bar">
        <div class="bme-task-nav-groups">
          <div class="bme-task-segmented-control">
            ${state.taskTypeOptions
              .map(
                (item) => `
                  <button
                    class="bme-task-type-btn ${item.id === state.taskType && !state.showGlobalRegex ? "active" : ""}"
                    data-task-action="switch-task-type"
                    data-task-type="${_escAttr(item.id)}"
                    type="button"
                  >${_escHtml(item.label)}</button>
                `,
              )
              .join("")}
          </div>
          <div class="bme-task-segmented-control bme-task-segmented-control--solo">
            <button
              class="bme-task-type-btn ${state.showGlobalRegex ? "active" : ""}"
              data-task-action="switch-global-regex"
              type="button"
            >
              通用正则
            </button>
          </div>
        </div>
        <div class="bme-task-action-bar-right">
          <button class="bme-config-secondary-btn bme-bulk-profile-btn bme-task-btn-danger" data-task-action="restore-all-profiles" type="button" title="恢复全部 ${_escAttr(String(totalTaskTypes || 0))} 个任务的默认预设">
            <i class="fa-solid fa-arrows-rotate"></i><span>恢复全部</span>
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="export-all-profiles" type="button" title="导出全部 ${_escAttr(String(totalTaskTypes || 0))} 个任务预设">
            <i class="fa-solid fa-file-export"></i><span>导出全部</span>
          </button>
          <button class="bme-config-secondary-btn bme-bulk-profile-btn" data-task-action="import-all-profiles" type="button" title="导入全部预设（覆盖当前）">
            <i class="fa-solid fa-file-import"></i><span>导入全部</span>
          </button>
        </div>
      </div>

      ${state.showGlobalRegex
        ? _renderGlobalRegexPanel(state)
        : `
      <div class="bme-task-master-detail">
        <div class="bme-task-profile-editor">
          <div class="bme-task-editor-header">
            <div class="bme-task-editor-kicker">${_escHtml(taskMeta?.label || state.taskType)}</div>
            <div class="bme-task-editor-title-row">
              <label class="bme-visually-hidden" for="bme-task-profile-select">当前预设</label>
              <select id="bme-task-profile-select" class="bme-config-input bme-task-editor-preset-select" title="切换预设">
                ${state.bucket.profiles
                  .map(
                    (profile) => `
                  <option
                    value="${_escAttr(profile.id)}"
                    ${profile.id === state.profile.id ? "selected" : ""}
                  >
                    ${_escHtml(profile.name)}${profile.builtin ? "（内置）" : ""}
                  </option>
                `,
                  )
                  .join("")}
              </select>
              <div class="bme-task-profile-badges">
                <span class="bme-task-pill ${state.profile.builtin ? "is-builtin" : ""}">
                  ${state.profile.builtin ? "内置" : "自定义"}
                </span>
                <span class="bme-task-pill">更新于 ${_escHtml(profileUpdatedAt)}</span>
              </div>
            </div>
            <div class="bme-task-editor-actions">
              <button class="bme-config-secondary-btn" data-task-action="save-profile" type="button"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
              <button class="bme-config-secondary-btn" data-task-action="rename-profile" type="button"><i class="fa-solid fa-pen"></i><span>重命名</span></button>
              <button class="bme-config-secondary-btn" data-task-action="save-as-profile" type="button"><i class="fa-solid fa-copy"></i><span>另存为</span></button>
              <button class="bme-config-secondary-btn" data-task-action="import-profile" type="button"><i class="fa-solid fa-file-import"></i><span>导入</span></button>
              <button class="bme-config-secondary-btn" data-task-action="export-profile" type="button"><i class="fa-solid fa-file-export"></i><span>导出</span></button>
              <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-default-profile" type="button"><i class="fa-solid fa-arrows-rotate"></i><span>恢复默认</span></button>
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
                : state.taskTabId === "debug"
                  ? _renderTaskDebugTab(state)
                  : _renderTaskPromptTab(state)
            }
          </div>
        </div>
      </div>
      `}
    </div>
  `;
}
function _renderTaskPromptTab(state) {
  return `
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

    <div class="bme-task-block-rows">
      ${state.blocks.length
        ? state.blocks
            .map((block, index) => _renderTaskBlockRow(block, index, state))
            .join("")
        : `
            <div class="bme-task-empty">
              当前预设还没有块。可以先新增一个自定义块或内置块。
            </div>
          `}
    </div>
  `;
}

function _renderTaskGenerationTab(state) {
  const inputGroups = TASK_PROFILE_INPUT_GROUPS[state.taskType] || [];
  const generationGroups = TASK_PROFILE_GENERATION_GROUPS.filter(
    (group) => !Array.isArray(group.excludeTaskTypes) || !group.excludeTaskTypes.includes(state.taskType),
  );
  return `
    <div class="bme-task-tab-body">
      ${generationGroups.map(
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
      ${inputGroups
        .map(
          (group) => `
            <div class="bme-config-card">
              <div class="bme-config-card-head">
                <div>
                  <div class="bme-config-card-title">${_escHtml(group.title)}</div>
                  <div class="bme-config-card-subtitle">
                    这里配置任务自带的输入收集规则，不跟随全局提取上下文。
                  </div>
                </div>
              </div>
              <div class="bme-task-field-grid">
                ${group.fields
                  .map((field) =>
                    _renderTaskInputField(
                      field,
                      state.profile.input?.[field.key],
                    ),
                  )
                  .join("")}
              </div>
            </div>
          `,
        )
        .join("")}
      <div class="bme-task-note">
        <strong>运行时说明</strong> — 这里配置的是完整版 generation options。实际请求发送前，仍会根据模型能力做过滤，避免把不支持的字段直接下发给 provider。
      </div>
    </div>
  `;
}

function _renderTaskRegexTab(state, options = {}) {
  const regex = options.regex || state.profile?.regex || {};
  const regexRules = Array.isArray(options.regexRules)
    ? options.regexRules
    : state.regexRules;
  const selectedRule =
    options.selectedRule === undefined ? state.selectedRule : options.selectedRule;
  const normalizedStages = normalizeTaskRegexStages(regex.stages || {});
  const deleteAction = options.deleteAction || "delete-regex-rule";
  const addAction = options.addAction || "add-regex-rule";
  const addButtonLabel = options.addButtonLabel || "+ 新增规则";
  const wrapperClassName = options.wrapperClassName
    ? ` ${options.wrapperClassName}`
    : "";
  const sectionTitle = options.sectionTitle || "复用与阶段";
  const sectionSubtitle =
    options.sectionSubtitle ||
    "任务预设可复用酒馆正则，并叠加当前任务自己的附加规则。";
  const rulesTitle = options.rulesTitle || "本地附加规则";
  const rulesSubtitle =
    options.rulesSubtitle ||
    "本地规则只作用于当前任务预设，不会污染宿主酒馆配置。";
  const emptyText = options.emptyText || "当前预设还没有本地正则规则。";
  const defaultNamePrefix = options.defaultNamePrefix || "本地规则";
  const headerExtraActions = options.extraHeaderActions || "";
  const enableToggleTitle = options.enableToggleTitle || "启用任务正则";
  const enableToggleDesc =
    options.enableToggleDesc || "关闭后当前配置不执行任何任务级正则。";
  const editorState = {
    ...state,
    selectedRule,
  };

  return `
    <div class="bme-task-tab-body${wrapperClassName}">
      <div class="bme-regex-settings-stack">
        <div class="bme-config-card bme-regex-settings-card">
          <div class="bme-config-card-head">
            <div>
              <div class="bme-config-card-title">${_escHtml(sectionTitle)}</div>
              <div class="bme-config-card-subtitle">
                ${_escHtml(sectionSubtitle)}
              </div>
            </div>
            <div class="bme-task-inline-actions">
              <button class="bme-config-secondary-btn" data-task-action="inspect-tavern-regex" type="button">
                查看当前复用规则
              </button>
              ${headerExtraActions}
            </div>
          </div>

          <div class="bme-task-toggle-list">
            <label class="bme-toggle-item">
              <span class="bme-toggle-copy">
                <span class="bme-toggle-title">${_escHtml(enableToggleTitle)}</span>
                <span class="bme-toggle-desc">${_escHtml(enableToggleDesc)}</span>
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
        </div>

        <div class="bme-config-card bme-regex-settings-card">
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
        </div>

        <div class="bme-config-card bme-regex-settings-card">
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
      </div>

      <div class="bme-config-card bme-regex-rule-card">
        <div class="bme-config-card-head">
          <div>
            <div class="bme-config-card-title">${_escHtml(rulesTitle)}</div>
            <div class="bme-config-card-subtitle">
              ${_escHtml(rulesSubtitle)}
            </div>
          </div>
          <button class="bme-config-secondary-btn" data-task-action="${_escAttr(addAction)}" type="button">
            ${_escHtml(addButtonLabel)}
          </button>
        </div>

        <div class="bme-regex-rule-rows">
          ${regexRules.length
            ? regexRules
                .map((rule, index) =>
                  _renderRegexRuleRow(rule, index, editorState, {
                    deleteAction,
                    defaultNamePrefix,
                  })
                )
                .join("")
            : `
                <div class="bme-task-empty">
                  ${_escHtml(emptyText)}
                </div>
              `}
        </div>
      </div>
    </div>
  `;
}

function _renderGlobalRegexPanel(state) {
  return _renderTaskRegexTab(
    {
      ...state,
      selectedRule: state.selectedGlobalRegexRule,
    },
    {
      regex: state.globalTaskRegex,
      regexRules: state.globalRegexRules,
      selectedRule: state.selectedGlobalRegexRule,
      addAction: "add-global-regex-rule",
      selectAction: "select-global-regex-rule",
      deleteAction: "delete-global-regex-rule",
      addButtonLabel: "+ 新增通用规则",
      wrapperClassName: "bme-global-regex-panel",
      sectionTitle: "通用正则设置",
      sectionSubtitle: "所有任务共享同一套任务正则开关、复用来源、执行阶段与附加规则。",
      enableToggleTitle: "启用通用正则",
      enableToggleDesc: "关闭后所有任务都不执行任何共享正则配置。",
      rulesTitle: "通用附加规则",
      rulesSubtitle: "这里维护所有任务共享的附加规则。",
      emptyText: "当前还没有通用正则规则。",
      defaultNamePrefix: "通用规则",
      extraHeaderActions: `
        <button class="bme-config-secondary-btn bme-task-btn-danger" data-task-action="restore-global-regex-defaults" type="button">
          恢复默认
        </button>
      `,
    },
  );
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
  if (rule.promptStageMode === "display-only") {
    return "（仅显示类规则，不进入 Memory LLM 请求）";
  }
  if (rule.promptStageMode === "fallback-skip-beautify") {
    return "（美化型替换，fallback 模式下不会进入 Prompt）";
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
  if (rule.promptStageMode === "display-only") {
    badges.push({
      className: "is-clear",
      text: "仅显示",
    });
  } else if (rule.promptStageMode === "host-real") {
    badges.push({
      className: "is-transform",
      text: "宿主真实执行",
    });
  } else if (rule.promptStageMode === "host-helper") {
    badges.push({
      className: "is-prompt",
      text: "Helper 兼容执行",
    });
  } else if (rule.promptStageMode === "host-fallback") {
    badges.push({
      className: "is-prompt",
      text: "插件兼容执行",
    });
  } else if (rule.promptStageMode === "fallback-skip-beautify") {
    badges.push({
      className: "is-skip",
      text: "fallback 跳过美化",
    });
  } else if (rule.promptStageMode === "replace") {
    badges.push({
      className: "is-transform",
      text: "本地最终正则",
    });
  } else {
    badges.push({
      className: "is-skip",
      text: "当前不执行",
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
  if (
    rule.sourceType === "local" &&
    rule.promptStageMode !== "skip" &&
    rule.promptStageApplies === false
  ) {
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
          这里展示的是当前任务预设下，ST-BME 对宿主注入内容会复用哪些 Tavern 正则，以及最终发送前还会执行哪些本地任务正则。
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
            <span class="bme-regex-preview-summary__value">${_escHtml(snapshot.host?.sourceLabel || "unknown")} · ${_escHtml(snapshot.host?.executionMode || snapshot.host?.capabilityStatus?.mode || snapshot.host?.mode || "unknown")}${snapshot.host?.bridgeTier ? ` · ${_escHtml(snapshot.host.bridgeTier)}` : ""}${snapshot.host?.formatterAvailable ? " · formatter" : ""}${snapshot.host?.fallback ? " · fallback" : ""}</span>
          </div>
        </div>
      </div>

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">宿主注入复用规则</div>
            <div class="bme-regex-preview-panel__subtitle">这里只显示会参与“宿主注入文本”处理的 Tavern 规则；仅显示类规则会明确标注出来。</div>
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

      <div class="bme-regex-preview-panel">
        <div class="bme-regex-preview-panel__head">
          <div>
            <div class="bme-regex-preview-panel__title">任务本地最终正则</div>
            <div class="bme-regex-preview-panel__subtitle">这一组只在最终请求发送前的 <code>input.finalPrompt</code> 阶段执行，不参与宿主注入清洗。</div>
          </div>
        </div>
        <div class="bme-regex-preview-list">
          ${_renderRegexReuseRuleList(snapshot.localRules, "当前没有任务本地最终正则", {
            showSource: false,
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
    const { callGenericPopup, POPUP_TYPE } = await getPopupRuntime();
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

  const persistDelta = graphPersistence.persistDelta || null;
  const loadDiagnostics = _readPersistenceDiagnosticObject(
    graphPersistence.loadDiagnostics,
  );
  const hydrateNativeError = String(
    loadDiagnostics?.hydrateNativeModuleError ||
      loadDiagnostics?.hydrateNativePreloadError ||
      loadDiagnostics?.hydrateNativeError ||
      "",
  ).trim();

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
        <span class="bme-debug-kv-key">最近已接受 revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.lastAcceptedRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">宿主档案</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.hostProfile || "generic-st"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">主 durable</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.primaryStorageTier || "none"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">本地缓存</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.cacheStorageTier || "none"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Luker Sidecar</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.hostProfile === "luker"
            ? `v${Number(graphPersistence.lukerSidecarFormatVersion || 0) || 1}`
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Manifest / Checkpoint</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.hostProfile === "luker"
            ? `rev ${Number(graphPersistence.lukerManifestRevision || 0)} / cp ${Number(graphPersistence.lukerCheckpointRevision || 0)}`
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Journal / Cache Lag</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.hostProfile === "luker"
            ? `${Number(graphPersistence.lukerJournalDepth || 0)} 条 / lag ${Number(graphPersistence.cacheLag || 0)}`
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">排队中的 revision</span>
        <span class="bme-debug-kv-value">${_escHtml(String(graphPersistence.queuedPersistRevision ?? 0))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">待确认写入</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.pendingPersist ? "是" : "否")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">影子快照</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.shadowSnapshotUsed ? "已接管" : "未使用")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">写保护</span>
        <span class="bme-debug-kv-value">${_escHtml(graphPersistence.writesBlocked ? "已启用" : "未启用")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">一致性异常</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatPersistMismatchReason(graphPersistence.persistMismatchReason))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Commit Marker</span>
        <span class="bme-debug-kv-value">${_escHtml(
          graphPersistence.commitMarker
            ? [
                `rev ${Number(graphPersistence.commitMarker.revision || 0)}`,
                graphPersistence.commitMarker.accepted === true ? "accepted" : "pending",
                graphPersistence.commitMarker.storageTier || "",
              ]
                .filter(Boolean)
                .join(" · ")
            : "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Hydrate Native Gate</span>
        <span class="bme-debug-kv-value">${_escHtml(
          _formatNativeHydrateGateText(loadDiagnostics),
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Hydrate Native 结果</span>
        <span class="bme-debug-kv-value">${_escHtml(
          _formatNativeHydrateResultText(loadDiagnostics),
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Hydrate Native Module</span>
        <span class="bme-debug-kv-value">${_escHtml(
          _formatNativeHydrateModuleText(loadDiagnostics),
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Hydrate Native 错误</span>
        <span class="bme-debug-kv-value">${_escHtml(
          hydrateNativeError || "—",
        )}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Delta 路径</span>
        <span class="bme-debug-kv-value">${_escHtml(String(persistDelta?.path || "—"))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Native Gate</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatPersistDeltaGateText(persistDelta))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Delta 耗时</span>
        <span class="bme-debug-kv-value">${_escHtml(_formatDurationMs(persistDelta?.totalMs || persistDelta?.buildMs))}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">Persist Native 来源</span>
        <span class="bme-debug-kv-value">${_escHtml(String(persistDelta?.moduleSource || "—"))}</span>
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
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.routeLabel || _getMonitorRouteLabel(llmRequest.route || "") || llmRequest.route || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">识别渠道</span>
        <span class="bme-debug-kv-value">${_escHtml(llmRequest.llmProviderLabel || llmRequest.llmProvider || "—")}</span>
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

  const llmMeta = injectionSnapshot.llmMeta || {};
  const rawSelectedKeys = Array.isArray(llmMeta.rawSelectedKeys)
    ? llmMeta.rawSelectedKeys.join(", ")
    : "";
  const resolvedSelectedNodeIds = Array.isArray(llmMeta.resolvedSelectedNodeIds)
    ? llmMeta.resolvedSelectedNodeIds.join(", ")
    : "";

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
        <span class="bme-debug-kv-key">LLM 选择协议</span>
        <span class="bme-debug-kv-value">${_escHtml(llmMeta.selectionProtocol || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">原始短键</span>
        <span class="bme-debug-kv-value">${_escHtml(rawSelectedKeys || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">解析节点</span>
        <span class="bme-debug-kv-value">${_escHtml(resolvedSelectedNodeIds || "—")}</span>
      </div>
      <div class="bme-debug-kv-item">
        <span class="bme-debug-kv-key">回退类型</span>
        <span class="bme-debug-kv-value">${_escHtml(llmMeta.fallbackType || "—")}</span>
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

function _getBlockTypeIcon(type) {
  switch (type) {
    case "builtin": return `<i class="fa-solid fa-thumbtack"></i>`;
    case "legacyPrompt": return `<i class="fa-solid fa-scroll"></i>`;
    default: return `<i class="fa-regular fa-file-lines"></i>`;
  }
}

function _getInjectModeLabel(mode) {
  switch (mode) {
    case "append": return "追加";
    case "relative":
    default: return "相对";
  }
}

function _renderTaskBlockRow(block, index, state) {
  const isExpanded = block.id === state.selectedBlock?.id;
  const roleClass = `bme-badge-role-${block.role || "system"}`;
  const disabledClass = block.enabled ? "" : "is-disabled";
  const expandedClass = isExpanded ? "is-expanded" : "";

  return `
    <div
      class="bme-task-block-row ${disabledClass} ${expandedClass}"
      data-block-id="${_escAttr(block.id)}"
    >
      <div class="bme-task-block-row-header" data-task-action="toggle-block-expand" data-block-id="${_escAttr(block.id)}">
        <span
          class="bme-task-drag-handle"
          title="拖拽排序"
          aria-label="拖拽排序"
          draggable="true"
        >
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="bme-task-block-icon">
          ${_getBlockTypeIcon(block.type)}
        </span>
        <span class="bme-task-block-name">
          ${_escHtml(block.name || _getTaskBlockTypeLabel(block.type))}
        </span>
        <span class="bme-task-block-badge ${roleClass}">
          ${_escHtml(block.role || "system")}
        </span>
        <span class="bme-task-block-badge">
          ${_escHtml(_getInjectModeLabel(block.injectionMode))}
        </span>
        <span class="bme-task-block-row-spacer"></span>
        <button
          class="bme-task-row-btn"
          data-task-action="toggle-block-expand"
          data-block-id="${_escAttr(block.id)}"
          type="button"
          title="编辑"
        >
          <i class="fa-solid fa-pen"></i>
        </button>
        <button
          class="bme-task-row-btn bme-task-row-btn-danger"
          data-task-action="delete-block"
          data-block-id="${_escAttr(block.id)}"
          type="button"
          title="删除"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        <label class="bme-task-row-toggle" title="${block.enabled ? "已启用" : "已停用"}">
          <input
            type="checkbox"
            data-task-action="toggle-block-enabled-cb"
            data-block-id="${_escAttr(block.id)}"
            ${block.enabled ? "checked" : ""}
          />
          <span class="bme-task-row-toggle-slider"></span>
        </label>
      </div>
      ${isExpanded ? `
        <div class="bme-task-block-expand">
          ${_renderTaskBlockInlineEditor(block, state)}
        </div>
      ` : ""}
    </div>
  `;
}

function _renderTaskBlockInlineEditor(block, state) {
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

    <div class="bme-task-expand-row2">
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
              <label>内置来源${_helpTip("运行时自动从任务上下文注入的数据。")}</label>
              <select class="bme-config-input" data-block-field="sourceKey">
                ${builtinOptions}
              </select>
            </div>
            ${externalLabel
              ? `<div class="bme-task-note" style="text-align:center;padding:0.75rem;opacity:0.7;">
                   内容来源：<strong>${externalLabel}</strong>，无法在此编辑。
                 </div>`
              : `<div class="bme-config-row">
                   <label>覆盖内容（可选）${_helpTip("留空时自动从 sourceKey 对应的上下文数据读取。")}</label>
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
                <input class="bme-config-input" type="text" value="${_escAttr(legacyField || block.sourceField || "")}" readonly />
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

    <div class="bme-task-expand-footer">
      <button class="bme-config-secondary-btn" data-task-action="toggle-block-expand" data-block-id="${_escAttr(block.id)}" type="button">
        <i class="fa-solid fa-chevron-up"></i> 收起
      </button>
    </div>
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

function _formatRegexRulePreview(findRegex = "") {
  const collapsed = String(findRegex || "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || "(未填写 find_regex)";
}

function _renderRegexRuleRow(rule, index, state, options = {}) {
  const isExpanded = rule.id === state.selectedRule?.id;
  const deleteAction = options.deleteAction || "delete-regex-rule";
  const defaultNamePrefix = options.defaultNamePrefix || "本地规则";
  const statusLabel = rule.enabled ? "启用" : "停用";
  const previewText = _formatRegexRulePreview(rule.find_regex);

  return `
    <div
      class="bme-regex-rule-row ${isExpanded ? "is-expanded" : ""} ${rule.enabled ? "" : "is-disabled"}"
      data-rule-id="${_escAttr(rule.id)}"
    >
      <div
        class="bme-regex-rule-row-header"
        data-task-action="toggle-regex-rule-expand"
        data-rule-id="${_escAttr(rule.id)}"
      >
        <span
          class="bme-task-drag-handle bme-regex-drag-handle"
          title="拖拽排序"
          aria-label="拖拽排序"
          draggable="true"
        >
          <i class="fa-solid fa-grip-vertical"></i>
        </span>
        <span class="bme-regex-rule-name">
          ${_escHtml(rule.script_name || `${defaultNamePrefix} ${index + 1}`)}
        </span>
        <span class="bme-regex-rule-status ${rule.enabled ? "is-enabled" : "is-disabled"}">
          ${_escHtml(statusLabel)}
        </span>
        <span class="bme-regex-rule-preview" title="${_escAttr(previewText)}">
          ${_escHtml(previewText)}
        </span>
        <button
          class="bme-task-row-btn"
          data-task-action="toggle-regex-rule-expand"
          data-rule-id="${_escAttr(rule.id)}"
          type="button"
          title="编辑"
        >
          <i class="fa-solid fa-pen"></i>
        </button>
        <button
          class="bme-task-row-btn bme-task-row-btn-danger"
          data-task-action="${_escAttr(deleteAction)}"
          data-rule-id="${_escAttr(rule.id)}"
          type="button"
          title="删除"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
        <label class="bme-task-row-toggle" title="${rule.enabled ? "已启用" : "已停用"}">
          <input
            type="checkbox"
            data-regex-rule-row-enabled="true"
            data-rule-id="${_escAttr(rule.id)}"
            ${rule.enabled ? "checked" : ""}
          />
          <span class="bme-task-row-toggle-slider"></span>
        </label>
      </div>
      ${isExpanded
        ? `
            <div class="bme-regex-rule-expand">
              ${_renderRegexRuleInlineEditor(rule)}
            </div>
          `
        : ""}
    </div>
  `;
}

function _renderRegexRuleInlineEditor(rule) {
  const trimStrings = Array.isArray(rule.trim_strings)
    ? rule.trim_strings.join("\n")
    : String(rule.trim_strings || "");

  return `
    <div class="bme-task-note">
      字段尽量与 Tavern 正则结构保持对齐，方便后续导入导出与对照。
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

    <div class="bme-task-expand-footer">
      <button
        class="bme-config-secondary-btn"
        data-task-action="toggle-regex-rule-expand"
        data-rule-id="${_escAttr(rule.id)}"
        type="button"
      >
        <i class="fa-solid fa-chevron-up"></i> 收起
      </button>
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

function _getTaskBlockDropPosition(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function _clearTaskBlockDragIndicators(workspace = document) {
  workspace
    .querySelectorAll(".bme-task-block-row.dragging, .bme-task-block-row.drag-over-top, .bme-task-block-row.drag-over-bottom")
    .forEach((row) => {
      row.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    });
}

function _setTaskBlockDragIndicator(workspace, activeRow, position) {
  workspace.querySelectorAll(".bme-task-block-row").forEach((row) => {
    if (row !== activeRow) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
      return;
    }
    row.classList.toggle("drag-over-top", position === "before");
    row.classList.toggle("drag-over-bottom", position === "after");
  });
}

function _reorderTaskBlocks(sourceBlockId, targetBlockId, position = "before") {
  if (!sourceBlockId || !targetBlockId || sourceBlockId === targetBlockId) return;
  _updateCurrentTaskProfile((draft) => {
    const blocks = _sortTaskBlocks(draft.blocks);
    const sourceIndex = blocks.findIndex((item) => item.id === sourceBlockId);
    const targetIndex = blocks.findIndex((item) => item.id === targetBlockId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }

    const [sourceBlock] = blocks.splice(sourceIndex, 1);
    let insertIndex = targetIndex;

    if (sourceIndex < targetIndex) {
      insertIndex -= 1;
    }
    if (position === "after") {
      insertIndex += 1;
    }

    insertIndex = Math.max(0, Math.min(blocks.length, insertIndex));
    blocks.splice(insertIndex, 0, sourceBlock);
    draft.blocks = blocks.map((block, index) => ({ ...block, order: index }));
    return { selectBlockId: sourceBlockId };
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

function _getRegexRuleDropPosition(row, clientY) {
  const rect = row.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function _clearRegexRuleDragIndicators(workspace = document) {
  workspace
    .querySelectorAll(".bme-regex-rule-row.dragging, .bme-regex-rule-row.drag-over-top, .bme-regex-rule-row.drag-over-bottom")
    .forEach((row) => {
      row.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
    });
}

function _setRegexRuleDragIndicator(workspace, activeRow, position) {
  workspace.querySelectorAll(".bme-regex-rule-row").forEach((row) => {
    if (row !== activeRow) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
      return;
    }
    row.classList.toggle("drag-over-top", position === "before");
    row.classList.toggle("drag-over-bottom", position === "after");
  });
}

function _reorderRegexRules(sourceRuleId, targetRuleId, position = "before", isGlobal = false) {
  if (!sourceRuleId || !targetRuleId || sourceRuleId === targetRuleId) return;
  const applyReorder = (rules = []) => {
    const nextRules = Array.isArray(rules) ? [...rules] : [];
    const sourceIndex = nextRules.findIndex((item) => item.id === sourceRuleId);
    const targetIndex = nextRules.findIndex((item) => item.id === targetRuleId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return null;
    }

    const [sourceRule] = nextRules.splice(sourceIndex, 1);
    let insertIndex = targetIndex;
    if (sourceIndex < targetIndex) {
      insertIndex -= 1;
    }
    if (position === "after") {
      insertIndex += 1;
    }
    insertIndex = Math.max(0, Math.min(nextRules.length, insertIndex));
    nextRules.splice(insertIndex, 0, sourceRule);
    return nextRules;
  };

  if (isGlobal) {
    _updateGlobalTaskRegex((draft) => {
      const localRules = applyReorder(draft.localRules);
      if (!localRules) return null;
      draft.localRules = localRules;
      return { selectRuleId: sourceRuleId };
    });
    return;
  }

  _updateCurrentTaskProfile((draft) => {
    const localRules = applyReorder(draft.regex?.localRules);
    if (!localRules) return null;
    draft.regex = {
      ...(draft.regex || {}),
      localRules,
    };
    return { selectRuleId: sourceRuleId };
  });
}

function _persistRegexRuleEnabledById(ruleId, enabled, isGlobal = false, refresh = true) {
  if (!ruleId) return;

  if (isGlobal) {
    _updateGlobalTaskRegex(
      (draft) => {
        const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
        const rule = localRules.find((item) => item.id === ruleId);
        if (!rule) return null;
        rule.enabled = Boolean(enabled);
        draft.localRules = localRules;
        return { selectRuleId: currentGlobalRegexRuleId };
      },
      { refresh },
    );
    return;
  }

  _updateCurrentTaskProfile(
    (draft) => {
      const localRules = Array.isArray(draft.regex?.localRules)
        ? [...draft.regex.localRules]
        : [];
      const rule = localRules.find((item) => item.id === ruleId);
      if (!rule) return null;
      rule.enabled = Boolean(enabled);
      draft.regex = {
        ...(draft.regex || {}),
        localRules,
      };
      return { selectRuleId: currentTaskProfileRuleId };
    },
    { refresh },
  );
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

function _persistTaskInputField(target, refresh) {
  const key = target.dataset.inputKey;
  const valueType = target.dataset.valueType || "text";
  if (!key) return;

  _updateCurrentTaskProfile(
    (draft) => {
      draft.input = {
        ...(draft.input || {}),
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

function _deleteGlobalRegexRule(ruleId) {
  if (!ruleId) return;
  _updateGlobalTaskRegex((draft) => {
    const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
    const index = localRules.findIndex((item) => item.id === ruleId);
    if (index < 0) return null;
    localRules.splice(index, 1);
    draft.localRules = localRules;
    return {
      selectRuleId:
        localRules[Math.max(0, index - 1)]?.id || localRules[0]?.id || "",
    };
  });
}

function _persistGlobalRegexField(target, refresh) {
  const key = target.dataset.regexField;
  if (!key) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft[key] =
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? Boolean(target.checked)
          : target.value;
    },
    { refresh },
  );
}

function _persistGlobalRegexSourceField(target, refresh) {
  const sourceKey = target.dataset.regexSource;
  if (!sourceKey) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft.sources = {
        ...(draft.sources || {}),
        [sourceKey]: Boolean(target.checked),
      };
    },
    { refresh },
  );
}

function _persistGlobalRegexStageField(target, refresh) {
  const stageKey = target.dataset.regexStage;
  if (!stageKey) return;

  _updateGlobalTaskRegex(
    (draft) => {
      draft.stages = {
        ...(draft.stages || {}),
        [stageKey]: Boolean(target.checked),
      };
    },
    { refresh },
  );
}

function _persistSelectedGlobalRegexRuleField(target, refresh) {
  _updateGlobalTaskRegex(
    (draft) => {
      const localRules = Array.isArray(draft.localRules) ? [...draft.localRules] : [];
      const rule = localRules.find((item) => item.id === currentGlobalRegexRuleId);
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

      draft.localRules = localRules;
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

function _isGlobalRegexPanelTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest(".bme-global-regex-panel"));
}

function _normalizeGlobalRegexDraft(regex = {}) {
  const normalized = normalizeGlobalTaskRegex(regex || {}, "global");
  return {
    ...normalized,
    sources: {
      ...(normalized.sources || {}),
    },
    stages: {
      ...normalizeTaskRegexStages(normalized.stages || {}),
    },
    localRules: Array.isArray(normalized.localRules)
      ? normalized.localRules.map((rule, index) =>
          createLocalRegexRule("global", {
            ...rule,
            id: String(rule?.id || `global-rule-${index + 1}`),
          }),
        )
      : [],
  };
}

function _mergeImportedGlobalRegex(currentGlobalRegex = {}, importedGlobalRegex = null) {
  const current = _normalizeGlobalRegexDraft(currentGlobalRegex);
  if (
    !importedGlobalRegex ||
    typeof importedGlobalRegex !== "object" ||
    Array.isArray(importedGlobalRegex)
  ) {
    return {
      globalTaskRegex: current,
      mergedRuleCount: 0,
      replacedConfig: false,
    };
  }

  const imported = _normalizeGlobalRegexDraft(importedGlobalRegex);
  const mergedRules = dedupeRegexRules(
    [
      ...(Array.isArray(current.localRules) ? current.localRules : []),
      ...(Array.isArray(imported.localRules) ? imported.localRules : []),
    ],
    "global",
  );

  return {
    globalTaskRegex: {
      ...imported,
      localRules: mergedRules,
    },
    mergedRuleCount: Math.max(
      0,
      mergedRules.length -
        (Array.isArray(current.localRules) ? current.localRules.length : 0),
    ),
    replacedConfig: true,
  };
}

function _mergeProfileRegexRulesIntoGlobal(
  currentGlobalRegex = {},
  profile = null,
  options = {},
) {
  const merged = migrateLegacyProfileRegexToGlobal(
    _normalizeGlobalRegexDraft(currentGlobalRegex),
    profile,
    options,
  );
  return {
    ...merged,
    globalTaskRegex: _normalizeGlobalRegexDraft(merged.globalTaskRegex || {}),
  };
}

function _renderTaskInputField(field, value) {
  const effectiveValue = value != null && value !== "" ? value : field.defaultValue;

  if (field.type === "enum") {
    return `
      <div class="bme-config-row">
        <label>${_escHtml(field.label)}</label>
        <select
          class="bme-config-input"
          data-input-key="${_escAttr(field.key)}"
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
        ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
      </div>
    `;
  }

  return `
    <div class="bme-config-row">
      <label>${_escHtml(field.label)}</label>
      <input
        class="bme-config-input"
        type="number"
        min="0"
        value="${_escAttr(effectiveValue ?? "")}"
        data-input-key="${_escAttr(field.key)}"
        data-value-type="number"
      />
      ${field.help ? `<div class="bme-config-help">${_escHtml(field.help)}</div>` : ""}
    </div>
  `;
}

function _patchGlobalTaskRegex(globalTaskRegex, options = {}) {
  return _patchSettings(
    {
      globalTaskRegex: _normalizeGlobalRegexDraft(globalTaskRegex),
    },
    {
      refreshTaskWorkspace: options.refresh !== false,
    },
  );
}

function _updateGlobalTaskRegex(mutator, options = {}) {
  const settings = _getSettings?.() || {};
  const draft = _normalizeGlobalRegexDraft(_cloneJson(settings.globalTaskRegex || {}));
  const mutationResult = mutator?.(draft, { settings });
  if (mutationResult === null) return null;

  const result = mutationResult || {};
  const nextRegex = _normalizeGlobalRegexDraft(result.globalTaskRegex || draft);
  if (Object.prototype.hasOwnProperty.call(result, "selectRuleId")) {
    currentGlobalRegexRuleId = result.selectRuleId || "";
  }

  return _patchSettings(
    {
      globalTaskRegex: nextRegex,
      ...(result.extraSettingsPatch || {}),
    },
    {
      refreshTaskWorkspace:
        result.refresh === undefined ? options.refresh !== false : result.refresh,
    },
  );
}

function _downloadTaskProfile(taskProfiles, taskType, profile, globalTaskRegex = {}) {
  try {
    const payload = serializeTaskProfile(taskProfiles, taskType, profile?.id || "");
    payload.globalTaskRegex = _normalizeGlobalRegexDraft(globalTaskRegex || {});
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

function _downloadAllTaskProfiles(taskProfiles, globalTaskRegex = {}) {
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
      globalTaskRegex: _normalizeGlobalRegexDraft(globalTaskRegex || {}),
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
    revision: 0,
    loadState: "no-chat",
    reason: "",
    writesBlocked: true,
    shadowSnapshotUsed: false,
    pendingPersist: false,
    lastAcceptedRevision: 0,
    hostProfile: "generic-st",
    primaryStorageTier: "indexeddb",
    cacheStorageTier: "none",
    cacheMirrorState: "idle",
    cacheLag: 0,
    acceptedBy: "none",
    persistDiagnosticTier: "none",
    persistMismatchReason: "",
    commitMarker: null,
    lukerSidecarFormatVersion: 0,
    lukerManifestRevision: 0,
    lukerJournalDepth: 0,
    lukerJournalBytes: 0,
    lukerCheckpointRevision: 0,
    chatId: "",
    storageMode: "indexeddb",
    resolvedLocalStore: "indexeddb:indexeddb",
    localStoreFormatVersion: 1,
    localStoreMigrationState: "idle",
    opfsWriteLockState: null,
    opfsWalDepth: 0,
    opfsPendingBytes: 0,
    opfsCompactionState: null,
    remoteSyncFormatVersion: 1,
    dbReady: false,
    syncState: "idle",
    syncDirty: false,
    syncDirtyReason: "",
    lastSyncUploadedAt: 0,
    lastSyncDownloadedAt: 0,
    lastSyncedRevision: 0,
    lastBackupUploadedAt: 0,
    lastBackupRestoredAt: 0,
    lastBackupRollbackAt: 0,
    lastBackupFilename: "",
    lastSyncError: "",
    persistDelta: null,
    loadDiagnostics: null,
  };
}

function _getLatestBatchStatusSnapshot() {
  return _getLastBatchStatus?.() || null;
}

function _formatPersistenceOutcomeLabel(outcome = "") {
  switch (String(outcome || "")) {
    case "saved":
      return "已保存";
    case "fallback":
      return "兜底已保存";
    case "not-attempted":
      return "未尝试";
    case "queued":
      return "已排队";
    case "blocked":
      return "已阻塞";
    case "failed":
      return "失败";
    case "recoverable":
      return "已捕获恢复锚点";
    default:
      return "未知";
  }
}

function _formatPersistMismatchReason(reason = "") {
  const normalized = String(reason || "").trim();
  if (!normalized) return "—";
  switch (normalized) {
    case "persist-mismatch:indexeddb-behind-commit-marker":
      return "本地图谱存储版本落后于当前聊天已确认版本";
    default:
      return normalized;
  }
}

function _formatPersistMismatchHelp(reason = "") {
  const normalized = String(reason || "").trim();
  switch (normalized) {
    case "persist-mismatch:indexeddb-behind-commit-marker":
      return "当前聊天记录显示图谱已经确认到更高版本，但本地 OPFS / IndexedDB 存储里还没有对应数据。常见于刚清空本地缓存，或写入确认还没完成。建议先点“重新探测图谱”；如果仍异常，再点“重试持久化”或执行重建/恢复。";
    default:
      return `检测到持久化一致性异常：${_formatPersistMismatchReason(normalized)}。建议先重新探测图谱；如果仍异常，再执行重建或恢复。`;
  }
}

function _hasMeaningfulPersistenceRecord(persistence = null) {
  if (!persistence || typeof persistence !== "object") return false;
  if (persistence.attempted === true) return true;
  const revision = Number(persistence?.revision || 0);
  if (Number.isFinite(revision) && revision > 0) return true;
  if (String(persistence?.storageTier || "").trim() && persistence.storageTier !== "none") {
    return true;
  }
  if (String(persistence?.saveMode || "").trim()) return true;
  if (String(persistence?.reason || "").trim()) return true;
  return (
    persistence.saved === true ||
    persistence.queued === true ||
    persistence.blocked === true
  );
}

function _isPersistenceRevisionAccepted(persistence = null, loadInfo = {}) {
  if (!persistence || persistence.accepted === true) return true;
  if (!_hasMeaningfulPersistenceRecord(persistence)) return true;
  if (loadInfo?.pendingPersist === true) return false;
  const persistenceRevision = Number(persistence?.revision || 0);
  if (!Number.isFinite(persistenceRevision) || persistenceRevision <= 0) {
    return false;
  }
  const lastAcceptedRevision = Number(loadInfo?.lastAcceptedRevision || 0);
  return Number.isFinite(lastAcceptedRevision) && lastAcceptedRevision >= persistenceRevision;
}

function _formatDashboardPersistMeta(loadInfo = {}, batchStatus = null) {
  const persistence = batchStatus?.persistence || null;
  const localPersistError = String(loadInfo?.indexedDbLastError || "").trim();
  if (_hasMeaningfulPersistenceRecord(persistence)) {
    const accepted = _isPersistenceRevisionAccepted(persistence, loadInfo);
    const parts = [
      accepted
        ? "已确认"
        : persistence.recoverable === true
          ? "已捕获恢复锚点"
          : _formatPersistenceOutcomeLabel(persistence.outcome),
      persistence.storageTier ? `tier ${persistence.storageTier}` : "",
      Number.isFinite(Number(persistence.revision)) && Number(persistence.revision) > 0
        ? `rev ${Number(persistence.revision)}`
        : "",
      persistence.reason || "",
      !accepted && localPersistError ? `本地错误 ${localPersistError}` : "",
    ].filter(Boolean);
    return parts.join(" · ") || "尚无持久化记录";
  }

  const dualWrite = loadInfo?.dualWriteLastResult || null;
  if (dualWrite) {
    return [
      dualWrite.success === true ? "最近写入成功" : "最近写入失败",
      dualWrite.target || dualWrite.source || "",
      Number.isFinite(Number(dualWrite.revision)) && Number(dualWrite.revision) > 0
        ? `rev ${Number(dualWrite.revision)}`
        : "",
      _formatPersistMismatchReason(dualWrite.reason || dualWrite.error || ""),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (loadInfo?.persistMismatchReason) {
    return `一致性异常 · ${_formatPersistMismatchReason(loadInfo.persistMismatchReason)}`;
  }

  if (String(batchStatus?.outcome || "") === "failed") {
    return "本批未进入持久化";
  }

  return "尚未执行持久化";
}

function _formatDashboardHistoryMeta(graph = null, loadInfo = {}, batchStatus = null) {
  const lastConfirmedFloor =
    graph?.historyState?.lastProcessedAssistantFloor ?? -1;
  const persistence = batchStatus?.persistence || null;
  const accepted = _isPersistenceRevisionAccepted(persistence, loadInfo);
  const localPersistError = String(loadInfo?.indexedDbLastError || "").trim();
  const processedRange = Array.isArray(batchStatus?.processedRange)
    ? batchStatus.processedRange
    : [];
  const pendingFloor =
    processedRange.length > 1 && Number.isFinite(Number(processedRange[1]))
      ? Number(processedRange[1])
      : null;

  if (_hasMeaningfulPersistenceRecord(persistence) && !accepted && pendingFloor != null) {
    return `持久化待确认：本地已抽取到楼层 ${pendingFloor}，已确认楼层 ${lastConfirmedFloor}${localPersistError ? ` · 本地错误 ${localPersistError}` : ""}`;
  }

  if (loadInfo?.persistMismatchReason) {
    return `持久化一致性异常：${_formatPersistMismatchReason(loadInfo.persistMismatchReason)} · 已确认楼层 ${lastConfirmedFloor}`;
  }

  if (String(batchStatus?.outcome || "") === "failed") {
    return `最近一批提取失败，已确认处理到楼层 ${lastConfirmedFloor}`;
  }

  const dirtyFrom = graph?.historyState?.historyDirtyFrom;
  if (Number.isFinite(dirtyFrom)) {
    return `脏区从楼层 ${dirtyFrom} 开始，已确认处理到楼层 ${lastConfirmedFloor}`;
  }

  return `干净，已确认处理到楼层 ${lastConfirmedFloor}`;
}

function _getGraphLoadLabel(loadInfoOrState = "") {
  const loadInfo =
    loadInfoOrState && typeof loadInfoOrState === "object"
      ? loadInfoOrState
      : null;
  const loadState = String(
    loadInfo ? loadInfo.loadState || "" : loadInfoOrState || "",
  );
  switch (loadState) {
    case "loading":
      return loadInfo?.runtimeGraphReadable === true
        ? "图谱已暂载，正在确认本地存储"
        : "正在加载当前聊天图谱";
    case "shadow-restored":
      return "已从本次会话临时恢复，正在等待正式聊天元数据";
    case "empty-confirmed":
      return "当前聊天还没有图谱";
    case "blocked":
      return "当前聊天图谱未能完成正式持久化确认，请稍后重试";
    case "loaded":
      return "聊天图谱已加载";
    case "no-chat":
    default:
      return "当前尚未进入聊天";
  }
}

function _refreshPersistenceRepairUi(
  loadInfo = _getGraphPersistenceSnapshot(),
  batchStatus = _getLatestBatchStatusSnapshot(),
) {
  const help = document.getElementById("bme-persist-repair-help");
  const lukerGroup = document.getElementById("bme-luker-sidecar-group");
  const actionHelp = document.getElementById("bme-actions-persist-repair-help");
  const lukerCacheBtn = document.getElementById("bme-act-rebuild-luker-cache");
  const lukerRepairBtn = document.getElementById("bme-act-repair-luker-sidecar");
  const lukerCompactBtn = document.getElementById("bme-act-compact-luker-sidecar");
  const retryBtn = document.getElementById("bme-act-retry-persist");
  const probeBtn = document.getElementById("bme-act-probe-graph-load");
  if (!help) return;

  const persistence = batchStatus?.persistence || null;
  const accepted = _isPersistenceRevisionAccepted(persistence, loadInfo);
  const shouldShow =
    loadInfo?.pendingPersist === true ||
    Boolean(loadInfo?.persistMismatchReason) ||
    (_hasMeaningfulPersistenceRecord(persistence) && !accepted);

  help.hidden = !shouldShow;
  const isLuker = String(loadInfo?.hostProfile || "") === "luker";
  if (lukerGroup) lukerGroup.hidden = false;
  if (retryBtn) retryBtn.hidden = false;
  if (probeBtn) probeBtn.hidden = false;
  if (lukerCacheBtn) lukerCacheBtn.hidden = !isLuker;
  if (lukerRepairBtn) lukerRepairBtn.hidden = !isLuker;
  if (lukerCompactBtn) lukerCompactBtn.hidden = !isLuker;
  if (!shouldShow) {
    help.textContent = "";
    if (actionHelp) {
      actionHelp.textContent = isLuker
        ? "这里集中放持久化修复入口。通用情况先用“重试持久化”和“重新探测图谱”；如果是 Luker 主 sidecar 脱节，再用右侧 3 个专项修复按钮。"
        : "这里集中放持久化修复入口。通常先用“重试持久化”，状态没恢复再试“重新探测图谱”。";
    }
    return;
  }

  let helpText = "";
  if (loadInfo?.pendingPersist === true) {
    helpText =
      isLuker
        ? "最近一批提取已经完成，但 Luker manifest 还没确认。先试“重试持久化”，如果仍未确认，再到“操作”页的 Luker Sidecar 区域做“修复主 Sidecar”或“重建本地缓存”。"
        : "最近一批提取已经完成，但正式写回还没确认。先试“重试持久化”，如果状态没变化，再试“重新探测图谱”。";
    if (loadInfo?.indexedDbLastError) {
      helpText = `${helpText}\n本地错误：${loadInfo.indexedDbLastError}`;
    }
  } else if (loadInfo?.persistMismatchReason) {
    helpText = _formatPersistMismatchHelp(loadInfo.persistMismatchReason);
  } else {
    helpText =
      persistence?.recoverable === true
        ? isLuker
          ? "最近一批已经捕获了恢复锚点，但 Luker 主 sidecar 还没确认。可以先重试持久化；必要时再到“操作”页的持久化修复区域执行更深修复。"
          : "最近一批已经捕获了恢复锚点，但还没有进入正式 accepted 存储。可以先重试持久化；如果仍未确认，再重新探测图谱。"
        : isLuker
          ? "最近一批持久化没有被 Luker manifest 接受。可以先重试持久化；如果主 sidecar 与本地缓存脱节，再到“操作”页的持久化修复区域执行更深修复。"
          : "最近一批持久化没有被接受。可以先重试持久化；如果宿主延迟加载了本地存储，再重新探测图谱。";
  }
  help.textContent = helpText;
  if (actionHelp) {
    actionHelp.textContent = helpText;
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
  const loadLabel = _getGraphLoadLabel(loadInfo);
  const pausedLabel = "图谱渲染已暂停，可点击工具栏按钮恢复。";
  const renderingPaused = !_isGraphRenderingEnabled();

  GRAPH_WRITE_ACTION_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = blocked;
    button.classList.toggle("is-runtime-disabled", blocked);
    button.title = blocked ? loadLabel : "";
  });
  _refreshGraphRenderToggleUi();

  if (banner) {
    const shouldShowBanner = blocked;
    banner.hidden = !shouldShowBanner;
    banner.textContent = shouldShowBanner ? loadLabel : "";
  }

  const shouldShowRuntimeOverlay =
    blocked ||
    loadInfo.syncState === "syncing" ||
    loadInfo.loadState === "loading" ||
    loadInfo.loadState === "shadow-restored" ||
    loadInfo.loadState === "blocked";

  const shouldShowOverlay = shouldShowRuntimeOverlay || renderingPaused;
  const overlayLabel = shouldShowRuntimeOverlay
    ? loadLabel
    : renderingPaused
      ? pausedLabel
      : "";

  if (graphOverlay) {
    graphOverlay.hidden = !shouldShowOverlay;
    graphOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (graphOverlayText) {
    graphOverlayText.textContent = overlayLabel;
  }
  if (mobileOverlay) {
    mobileOverlay.hidden = !shouldShowOverlay;
    mobileOverlay.classList.toggle("active", shouldShowOverlay);
  }
  if (mobileOverlayText) {
    mobileOverlayText.textContent = overlayLabel;
  }

  _refreshGraphLayoutDiagnosticsUi();
}

function _formatCloudTimeLabel(timestamp) {
  const normalized = Number(timestamp);
  if (!Number.isFinite(normalized) || normalized <= 0) return "";
  try {
    return new Date(normalized).toLocaleString();
  } catch {
    return "";
  }
}

function _renderCloudStorageModeStatus(
  settings = _getSettings?.() || {},
  loadInfo = _getGraphPersistenceSnapshot(),
) {
  const statusEl = document.getElementById("bme-cloud-storage-mode-status");
  if (!statusEl) return;

  const mode = String(settings?.cloudStorageMode || "automatic");
  if (mode !== "manual") {
    statusEl.style.display = "none";
    statusEl.textContent = "";
    return;
  }

  const lines = [];
  const syncDirty = Boolean(loadInfo?.syncDirty);
  const dirtyReason = String(loadInfo?.syncDirtyReason || "").trim();
  const backupUploadedAt = Number(loadInfo?.lastBackupUploadedAt) || 0;
  const backupRestoredAt = Number(loadInfo?.lastBackupRestoredAt) || 0;
  const backupRollbackAt = Number(loadInfo?.lastBackupRollbackAt) || 0;
  const backupFilename = String(loadInfo?.lastBackupFilename || "").trim();
  const dualWrite = loadInfo?.dualWriteLastResult || null;
  const dualWriteAt = Number(dualWrite?.at) || 0;
  const needsPostRecoveryBackup =
    Boolean(dualWrite?.success) &&
    ["migration", "identity-recovery"].includes(String(dualWrite?.action || "")) &&
    dualWriteAt > backupUploadedAt;

  if (syncDirty) {
    lines.push(
      dirtyReason
        ? `\u672c\u5730\u6709\u672a\u5907\u4efd\u7684\u6539\u52a8\uff0c\u7b49\u5f85\u4f60\u624b\u52a8\u4e0a\u4f20\u3002\u539f\u56e0\uff1a${dirtyReason}`
        : "\u672c\u5730\u6709\u672a\u5907\u4efd\u7684\u6539\u52a8\uff0c\u7b49\u5f85\u4f60\u624b\u52a8\u4e0a\u4f20\u3002",
    );
  } else if (backupUploadedAt > 0) {
    const uploadedAtText = _formatCloudTimeLabel(backupUploadedAt);
    lines.push(
      uploadedAtText
        ? `\u4e0a\u6b21\u5907\u4efd\u4e8e ${uploadedAtText}${backupFilename ? `\uff0c\u6587\u4ef6\uff1a${backupFilename}` : ""}`
        : "\u5f53\u524d\u804a\u5929\u5df2\u6709\u4e91\u7aef\u5907\u4efd\u8bb0\u5f55\u3002",
    );
  } else {
    lines.push("\u8fd8\u6ca1\u6709\u4e3a\u5f53\u524d\u804a\u5929\u4e0a\u4f20\u8fc7\u624b\u52a8\u5907\u4efd\u3002");
  }

  if (backupRestoredAt > 0) {
    const restoredAtText = _formatCloudTimeLabel(backupRestoredAt);
    if (restoredAtText) {
      lines.push(`\u4e0a\u6b21\u4ece\u4e91\u7aef\u6062\u590d\u4e8e ${restoredAtText}${backupFilename ? `\uff0c\u6587\u4ef6\uff1a${backupFilename}` : ""}`);
    }
  }

  if (backupRollbackAt > 0) {
    const rollbackAtText = _formatCloudTimeLabel(backupRollbackAt);
    if (rollbackAtText) {
      lines.push(`\u6700\u8fd1\u4e00\u6b21\u5df2\u56de\u6eda\u5230\u6062\u590d\u524d\u7684\u672c\u5730\u5feb\u7167\uff0c\u65f6\u95f4\uff1a${rollbackAtText}`);
    }
  }

  if (needsPostRecoveryBackup) {
    const actionLabel =
      String(dualWrite?.action || "") === "identity-recovery"
        ? "\u8eab\u4efd\u6062\u590d"
        : "\u8fc1\u79fb";
    lines.push(`\u5df2\u5b8c\u6210${actionLabel}\uff0c\u4f46\u4e91\u7aef\u5907\u4efd\u8fd8\u6ca1\u8ddf\u4e0a\u8fd9\u6b21\u53d8\u66f4\u3002\u5982\u679c\u4f60\u8981\u5728 A/B \u8bbe\u5907\u95f4\u63a5\u529b\uff0c\u8bf7\u518d\u70b9\u4e00\u6b21\u201c\u5907\u4efd\u5230\u4e91\u7aef\u201d\u3002`);
  }

  statusEl.style.display = lines.length ? "" : "none";
  statusEl.innerHTML = lines.map((line) => `<div>${_escHtml(line)}</div>`).join("");
}

async function _refreshCloudBackupManualUi(settings = _getSettings?.() || {}) {
  const mode = String(settings?.cloudStorageMode || "automatic");
  const rollbackButton = document.getElementById("bme-act-rollback-last-restore");
  if (!rollbackButton) return;

  if (mode !== "manual") {
    rollbackButton.disabled = true;
    rollbackButton.title = "";
    return;
  }

  if (typeof _actionHandlers.getRestoreSafetyStatus !== "function") {
    rollbackButton.disabled = true;
    rollbackButton.title = "";
    return;
  }

  rollbackButton.disabled = true;
  rollbackButton.title = "\u6b63\u5728\u68c0\u67e5\u662f\u5426\u5b58\u5728\u53ef\u7528\u7684\u56de\u6eda\u5feb\u7167...";
  try {
    const status = await _actionHandlers.getRestoreSafetyStatus();
    const hasSafety = Boolean(status?.exists);
    rollbackButton.disabled = !hasSafety;
    rollbackButton.title = hasSafety
      ? status?.createdAt
        ? `\u5df2\u68c0\u6d4b\u5230\u4e0a\u6b21\u6062\u590d\u524d\u7684\u672c\u5730\u5b89\u5168\u5feb\u7167\uff0c\u521b\u5efa\u65f6\u95f4\uff1a${new Date(status.createdAt).toLocaleString()}`
        : "\u5df2\u68c0\u6d4b\u5230\u4e0a\u6b21\u6062\u590d\u524d\u7684\u672c\u5730\u5b89\u5168\u5feb\u7167\uff0c\u53ef\u4ee5\u56de\u6eda\u3002"
      : "\u5f53\u524d\u804a\u5929\u8fd8\u6ca1\u6709\u53ef\u7528\u7684\u56de\u6eda\u5feb\u7167\u3002";
  } catch (error) {
    console.error("[ST-BME] failed to read restore safety snapshot status:", error);
    rollbackButton.disabled = true;
    rollbackButton.title = "\u8bfb\u53d6\u56de\u6eda\u5feb\u7167\u72b6\u6001\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002";
  }
}

function _refreshCloudStorageModeUi(settings = _getSettings?.() || {}) {
  const mode = String(settings?.cloudStorageMode || "automatic");
  const manualActions = document.getElementById(
    "bme-cloud-backup-manual-actions",
  );
  const helpText = document.getElementById("bme-cloud-storage-mode-help");
  if (manualActions) {
    manualActions.style.display = mode === "manual" ? "" : "none";
  }
  if (helpText) {
    helpText.textContent =
      mode === "manual"
        ? "\u624b\u52a8\u50a8\u5b58\u53ea\u4fdd\u7559\u672c\u5730 OPFS / IndexedDB \u5199\u5165\uff0c\u4e0d\u4f1a\u81ea\u52a8\u4e0a\u4f20\u6216\u8986\u76d6\u4e91\u7aef\u3002\u9700\u8981\u63a5\u529b\u65f6\uff0c\u8bf7\u624b\u52a8\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u3002"
        : "\u81ea\u52a8\u50a8\u5b58\u4f1a\u7ee7\u7eed\u6cbf\u7528\u5f53\u524d\u955c\u50cf\u540c\u6b65\u903b\u8f91\u4e0e\u95f4\u9694\uff1b\u624b\u52a8\u50a8\u5b58\u53ea\u4fdd\u7559\u672c\u5730\u5199\u5165\uff0c\u9700\u8981\u4f60\u4e3b\u52a8\u5907\u4efd\u548c\u6062\u590d\u3002";
  }
  _renderCloudStorageModeStatus(settings, _getGraphPersistenceSnapshot());
  void _refreshCloudBackupManualUi(settings);
}

function _refreshRuntimeStatus() {
  const runtimeStatus = _getRuntimeStatus?.() || {};
  const text = runtimeStatus.text || "待命";
  const meta = runtimeStatus.meta || "准备就绪";
  _setText("bme-status-text", text);
  _setText("bme-status-meta", meta);
  _setText("bme-mobile-status-text", text);
  _setText("bme-mobile-status-meta", meta);
  _setText("bme-panel-status", text);
  _renderCloudStorageModeStatus(_getSettings?.() || {}, _getGraphPersistenceSnapshot());
  _refreshGraphAvailabilityState();
}

function _showActionProgressUi(label, meta = "请稍候…") {
  _setText("bme-status-text", `${label}中`);
  _setText("bme-status-meta", meta);
  _setText("bme-panel-status", `${label}中`);
  updateFloatingBallStatus("running", `${label}中`);
}

function _syncFloatingBallWithRuntimeStatus() {
  const status = _getRuntimeStatus?.() || {};
  const level = String(status.level || "idle");
  const fabStatus = level === "info" ? "idle" : level;
  updateFloatingBallStatus(fabStatus, status.text || "BME 记忆图谱");
}

function _patchSettings(patch = {}, options = {}) {
  const settings = _updateSettings?.(patch) || _getSettings?.() || {};
  if (options.refreshGuards) _refreshGuardedConfigStates(settings);
  if (options.refreshPrompts) _refreshPromptCardStates(settings);
  if (options.refreshTaskWorkspace) _refreshTaskProfileWorkspace(settings);
  if (options.refreshTheme)
    _highlightThemeChoice(settings.panelTheme || "crimson");
  _refreshCloudStorageModeUi(settings);
  _refreshNativeRolloutStatusUi(settings);
  return settings;
}

function _formatBackupManagerTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) {
    return "\u672a\u8bb0\u5f55";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "\u672a\u8bb0\u5f55";
  }
}

function _buildCloudBackupManagerHtml(state = {}) {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const currentChatId = String(state.currentChatId || "").trim();
  if (state.loading) {
    return `
      <div class="bme-cloud-backup-modal__loading">
        <i class="fa-solid fa-spinner fa-spin"></i> \u6b63\u5728\u8bfb\u53d6\u670d\u52a1\u5668\u5907\u4efd\u5217\u8868...
      </div>
    `;
  }

  if (!entries.length) {
    return `
      <div class="bme-cloud-backup-modal__empty">
        \u670d\u52a1\u5668\u4e0a\u8fd8\u6ca1\u6709 ST-BME \u5907\u4efd\u3002<br />
        \u5148\u5728\u5f53\u524d\u804a\u5929\u70b9\u4e00\u6b21\u201c\u5907\u4efd\u5230\u4e91\u7aef\u201d\u5c31\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002
      </div>
    `;
  }

  return entries
    .map((entry) => {
      const chatId = String(entry?.chatId || "").trim();
      const filename = String(entry?.filename || "").trim();
      const isCurrentChat = currentChatId && chatId === currentChatId;
      const backupTime = _formatBackupManagerTime(entry?.backupTime);
      const lastModified = _formatBackupManagerTime(entry?.lastModified);
      const sizeLabel =
        Number.isFinite(Number(entry?.size)) && Number(entry.size) > 0
          ? `${Number(entry.size)} B`
          : "\u672a\u77e5\u5927\u5c0f";
      return `
        <div class="bme-cloud-backup-card ${isCurrentChat ? "is-current-chat" : ""}">
          <div class="bme-cloud-backup-card__top">
            <div class="bme-cloud-backup-card__title">${_escHtml(chatId || "(unknown chat)")}</div>
            ${isCurrentChat ? '<div class="bme-cloud-backup-card__badge"><i class="fa-solid fa-location-dot"></i><span>\u5f53\u524d\u804a\u5929</span></div>' : ""}
          </div>
          <div class="bme-cloud-backup-card__meta">
            <div>Revision: ${_escHtml(String(entry?.revision ?? 0))}</div>
            <div>\u5907\u4efd\u65f6\u95f4: ${_escHtml(backupTime)}</div>
            <div>\u6700\u540e\u4fee\u6539: ${_escHtml(lastModified)}</div>
            <div>\u6587\u4ef6\u5927\u5c0f: ${_escHtml(sizeLabel)}</div>
          </div>
          <div class="bme-cloud-backup-card__filename">${_escHtml(filename)}</div>
          <div class="bme-cloud-backup-card__actions">
          <button
              type="button"
              class="bme-cloud-backup-modal__btn bme-cloud-backup-card__danger"
              data-bme-backup-action="delete"
              data-chat-id="${_escHtml(chatId)}"
              data-filename="${_escHtml(filename)}"
              data-server-path="${_escHtml(String(entry?.serverPath || ""))}"
              ${state.busy ? "disabled" : ""}
            >
              <i class="fa-solid fa-trash-can"></i>
              <span>\u5220\u9664\u5907\u4efd</span>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function _openServerBackupManagerModal() {
  if (typeof _actionHandlers.manageServerBackups !== "function") {
    toastr.info("\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709\u63a5\u5165\u670d\u52a1\u5668\u5907\u4efd\u7ba1\u7406\u5165\u53e3", "ST-BME");
    return { handledToast: true, skipDashboardRefresh: true };
  }

  _ensureCloudBackupManagerStyles();
  const { callGenericPopup, POPUP_TYPE } = await getPopupRuntime();
  const state = {
    loading: true,
    busy: false,
    entries: [],
    currentChatId: "",
  };

  const container = document.createElement("div");
  container.className = "bme-cloud-backup-modal";
  container.innerHTML = `
    <div class="bme-cloud-backup-modal__header">
      <div>
        <div class="bme-cloud-backup-modal__title">\u7ba1\u7406\u670d\u52a1\u5668\u5907\u4efd</div>
        <div class="bme-cloud-backup-modal__subtitle">
          \u8fd9\u91cc\u5c55\u793a\u7684\u662f\u624b\u52a8\u5907\u4efd\u6587\u4ef6\uff0c\u4e0d\u4f1a\u628a\u81ea\u52a8\u540c\u6b65\u955c\u50cf\u6df7\u8fdb\u6765\u3002<br />
          \u5220\u9664\u64cd\u4f5c\u53ea\u5f71\u54cd\u4e91\u7aef\u5907\u4efd\uff0c\u4e0d\u4f1a\u6539\u52a8\u5f53\u524d\u8bbe\u5907\u7684\u672c\u5730 IndexedDB\u3002
        </div>
      </div>
      <div class="bme-cloud-backup-modal__tools">
        <button type="button" class="bme-cloud-backup-modal__btn" data-bme-backup-action="refresh">
          <i class="fa-solid fa-rotate"></i>
          <span>\u5237\u65b0\u5217\u8868</span>
        </button>
      </div>
    </div>
    <div class="bme-cloud-backup-modal__list"></div>
  `;

  const listEl = container.querySelector(".bme-cloud-backup-modal__list");
  const render = () => {
    if (!listEl) return;
    listEl.innerHTML = _buildCloudBackupManagerHtml(state);
    const refreshBtn = container.querySelector('[data-bme-backup-action="refresh"]');
    if (refreshBtn) refreshBtn.disabled = Boolean(state.busy || state.loading);
  };

  const refreshEntries = async ({ showToast = false } = {}) => {
    state.loading = true;
    render();
    try {
      const result = await _actionHandlers.manageServerBackups();
      state.entries = Array.isArray(result?.entries) ? result.entries : [];
      state.currentChatId = String(result?.currentChatId || "").trim();
      if (showToast) {
        toastr.success("\u670d\u52a1\u5668\u5907\u4efd\u5217\u8868\u5df2\u5237\u65b0", "ST-BME");
      }
    } catch (error) {
      console.error("[ST-BME] failed to load server backups:", error);
      toastr.error(`\u8bfb\u53d6\u670d\u52a1\u5668\u5907\u4efd\u5931\u8d25: ${error?.message || error}`, "ST-BME");
    } finally {
      state.loading = false;
      render();
    }
  };

  const deleteEntry = async (chatId, filename, serverPath = "") => {
    if (typeof _actionHandlers.deleteServerBackupEntry !== "function") {
      toastr.error("\u5f53\u524d\u8fd0\u884c\u65f6\u6ca1\u6709\u63a5\u5165\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd\u5165\u53e3", "ST-BME");
      return;
    }

    if (!globalThis.confirm?.(`\u786e\u5b9a\u8981\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd ${filename} \u5417\uff1f\u6b64\u64cd\u4f5c\u4e0d\u53ef\u64a4\u9500\u3002`)) {
      return;
    }

    state.busy = true;
    render();
    try {
      const result = await _actionHandlers.deleteServerBackupEntry({
        chatId,
        filename,
        serverPath,
      });
      if (!result?.deleted) {
        const message =
          result?.reason === "delete-backup-manifest-error"
            ? result?.backupDeleted
              ? "\u5907\u4efd\u6587\u4ef6\u5df2\u5220\u9664\uff0c\u4f46\u670d\u52a1\u5668\u5907\u4efd\u6e05\u5355\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5"
              : "\u670d\u52a1\u5668\u5907\u4efd\u6e05\u5355\u66f4\u65b0\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5"
            : `\u5220\u9664\u5931\u8d25: ${result?.error?.message || result?.reason || "\u672a\u77e5\u539f\u56e0"}`;
        toastr.error(message, "ST-BME");
        return;
      }
      toastr.success(`\u5df2\u5220\u9664\u670d\u52a1\u5668\u5907\u4efd\uff1a${filename}`, "ST-BME");
      await refreshEntries();
    } catch (error) {
      console.error("[ST-BME] failed to delete server backup:", error);
      toastr.error(`\u5220\u9664\u5931\u8d25: ${error?.message || error}`, "ST-BME");
    } finally {
      state.busy = false;
      render();
      _refreshRuntimeStatus();
      void _refreshCloudBackupManualUi();
    }
  };

  container.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-bme-backup-action]");
    if (!button || button.disabled) return;
    const action = String(button.dataset.bmeBackupAction || "");
    if (action === "refresh") {
      await refreshEntries({ showToast: true });
      return;
    }
    if (action === "delete") {
      await deleteEntry(
        String(button.dataset.chatId || "").trim(),
        String(button.dataset.filename || "").trim(),
        String(button.dataset.serverPath || "").trim(),
      );
    }
  });

  await refreshEntries();
  await callGenericPopup(container, POPUP_TYPE.TEXT, "", {
    okButton: "\u5173\u95ed",
    wide: true,
    large: true,
    allowVerticalScrolling: true,
  });
  return { handledToast: true, skipDashboardRefresh: true };
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
  const storyTime = _describeNodeStoryTimeDisplay(node);
  if (storyTime) parts.push(`剧情时间: ${storyTime}`);
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
    synopsis: "全局概要（旧）",
    reflection: "反思",
    pov_memory: "主观记忆",
  };
  return map[type] || type || "—";
}

function _getNodeSnippet(node) {
  const fields = node.fields || {};
  const storyTime = _describeNodeStoryTimeDisplay(node);
  if (fields.summary) return fields.summary;
  if (fields.state) return fields.state;
  if (fields.constraint) return fields.constraint;
  if (fields.insight) return fields.insight;
  if (fields.traits) return fields.traits;
  if (storyTime) return `剧情时间: ${storyTime}`;

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


