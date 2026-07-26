// ST-BME: 消息级召回卡片 UI
// 纯 DOM 构建模块，不含模块级 mutable state

import { getContext } from "../../../../extensions.js";
import { GraphRenderer } from "./graph-renderer.js";
import { t } from "../i18n/index.js";

function _hostUserPovAliasHintsForRecallCanvas() {
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

// ==================== 常量 ====================

export const RECALL_CARD_UI_VERSION = "recall-tabs-v4";

export const RECALL_CARD_FORCE_CONFIG = {
  repulsion: 1200,
  springLength: 50,
  springK: 0.04,
  damping: 0.85,
  centerGravity: 0.08,
  maxIterations: 80,
  minNodeRadius: 6,
  maxNodeRadius: 14,
  labelFontSize: 11,
  gridSpacing: 0,
  gridColor: "transparent",
};

const DELETE_CONFIRM_TIMEOUT_MS = 3000;

// ==================== 子图构建 ====================

/**
 * 从完整图谱中提取召回节点子图
 * @param {object} graph - currentGraph
 * @param {string[]} selectedNodeIds
 * @returns {{ nodes: Array, edges: Array }}
 */
export function buildRecallSubGraph(graph, selectedNodeIds) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(selectedNodeIds)) {
    return { nodes: [], edges: [] };
  }

  const idSet = new Set(selectedNodeIds);
  const nodes = graph.nodes
    .filter((n) => idSet.has(n.id) && !n.archived)
    .map((n) => ({ ...n }));

  const edges = (graph.edges || [])
    .filter(
      (e) =>
        !e.invalidAt &&
        !e.expiredAt &&
        idSet.has(e.fromId) &&
        idSet.has(e.toId),
    );

  return { nodes, edges };
}

// ==================== 辅助 DOM ====================

function el(tag, className, textContent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent !== undefined) element.textContent = textContent;
  return element;
}

function defaultEstimateTokens(text = "") {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length || 0;
}

function resolveEstimateTokens(callbacks = {}) {
  return typeof callbacks.estimateTokens === "function"
    ? callbacks.estimateTokens
    : defaultEstimateTokens;
}

function formatTokenHint(tokenEstimate) {
  if (!Number.isFinite(tokenEstimate) || tokenEstimate <= 0) return "";
  return `~${tokenEstimate} tokens`;
}

function formatMetaLine(record) {
  const parts = [];
  if (record.recallSource && !buildRecallSourceLabel(record)) {
    parts.push(t("recall.card.meta.source", { source: record.recallSource }));
  }
  if (record.authoritativeInputUsed) parts.push(t("recall.card.meta.authoritativeInput"));
  if (record.tokenEstimate > 0) parts.push(`~${record.tokenEstimate} tokens`);
  if (Number.isFinite(record.generationCount) && record.generationCount > 0) {
    parts.push(t("recall.card.meta.fallbackCount", { count: record.generationCount }));
  }
  if (record.updatedAt) {
    const dateStr = String(record.updatedAt).replace(/T/, " ").replace(/\.\d+Z$/, "");
    parts.push(dateStr);
  }
  return parts.join(" · ");
}

function normalizeUserInputDisplayMode(mode) {
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

function stableSerialize(value) {
  if (value === null || value === undefined) return "null";
  const type = typeof value;
  if (type === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (type === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function normalizeSelectedNodeIds(selectedNodeIds = []) {
  return Array.isArray(selectedNodeIds)
    ? selectedNodeIds
        .map((id) => String(id || "").trim())
        .filter(Boolean)
        .sort()
    : [];
}

function summarizeSubGraphForSignature(subGraph) {
  const nodes = Array.isArray(subGraph?.nodes)
    ? subGraph.nodes
        .map((node) => ({
          id: String(node?.id || ""),
          type: String(node?.type || ""),
          archived: Boolean(node?.archived),
          seq: Number.isFinite(node?.seq) ? node.seq : 0,
          seqRange: Array.isArray(node?.seqRange)
            ? [
                Number.isFinite(node.seqRange[0]) ? node.seqRange[0] : 0,
                Number.isFinite(node.seqRange[1]) ? node.seqRange[1] : 0,
              ]
            : [],
          fields: node?.fields && typeof node.fields === "object" ? { ...node.fields } : {},
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    : [];

  const edges = Array.isArray(subGraph?.edges)
    ? subGraph.edges
        .map((edge) => ({
          fromId: String(edge?.fromId || ""),
          toId: String(edge?.toId || ""),
          relation: String(edge?.relation || ""),
          strength: Number.isFinite(edge?.strength) ? edge.strength : 0,
        }))
        .sort((left, right) => {
          const leftKey = `${left.fromId}->${left.toId}:${left.relation}`;
          const rightKey = `${right.fromId}->${right.toId}:${right.relation}`;
          return leftKey.localeCompare(rightKey);
        })
    : [];

  return { nodes, edges };
}

function summarizePlotRecordForSignature(plotRecord) {
  if (!plotRecord || typeof plotRecord !== "object") return null;
  return {
    inputHash: String(plotRecord.inputHash || ""),
    plotText: String(plotRecord.plotText || ""),
    plotBlocks: Array.isArray(plotRecord.plotBlocks)
      ? plotRecord.plotBlocks.map((b) => String(b || ""))
      : [],
    rawUserInput: String(plotRecord.rawUserInput || ""),
    plannerAugmentedMessage: String(plotRecord.plannerAugmentedMessage || ""),
    promptProfileId: String(plotRecord.promptProfileId || ""),
    recallHandoffId: String(plotRecord.recallHandoffId || ""),
    taskResults: Array.isArray(plotRecord.taskResults)
      ? plotRecord.taskResults.map((task) => ({
          taskName: String(task?.taskName || ""),
          status: String(task?.status || ""),
        }))
      : [],
    createdAt: Number.isFinite(Number(plotRecord.createdAt)) ? Number(plotRecord.createdAt) : 0,
  };
}

function getPlotRecordBlocks(plotRecord) {
  if (!plotRecord || typeof plotRecord !== "object") return [];
  const blocks = [];
  const seen = new Set();
  const pushBlock = (value) => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  pushBlock(plotRecord.plotText);
  if (Array.isArray(plotRecord.plotBlocks)) {
    for (const item of plotRecord.plotBlocks) pushBlock(item);
  }
  return blocks;
}

function hasPlotRecordContent(plotRecord) {
  return getPlotRecordBlocks(plotRecord).length > 0;
}

function extractTaggedPlannerBlocks(plotRecord) {
  const source = getPlotRecordBlocks(plotRecord).join("\n\n").trim();
  const buckets = {
    plot: [],
    note: [],
    state: [],
    plotLog: [],
  };
  if (!source) return { ...buckets, fallback: "" };

  const re = /<(plot|note|state|plot-log)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match = null;
  while ((match = re.exec(source))) {
    const tag = String(match[1] || "").toLowerCase();
    const text = String(match[2] || "").trim();
    if (!text) continue;
    if (tag === "plot-log") buckets.plotLog.push(text);
    else buckets[tag]?.push(text);
  }

  const hasTaggedContent = Object.values(buckets).some((items) => items.length > 0);
  return { ...buckets, fallback: hasTaggedContent ? "" : source };
}

function isPlannerRecallSource(record = {}) {
  const recallSource = String(record?.recallSource || "").trim().toLowerCase();
  const hookName = String(record?.hookName || "").trim().toLowerCase();
  return recallSource.startsWith("planner") || hookName.includes("planner") || hookName.includes("ena");
}

function buildRecallSourceLabel(record = {}) {
  if (isPlannerRecallSource(record)) return "ENA Planner";
  return "";
}

function classifyInjectionLine(line = "") {
  const text = String(line || "");
  const trimmed = text.trim();
  if (!trimmed) return { kind: "blank", text };
  if (/^\[[^\]]+\]$/.test(trimmed)) return { kind: "section", text: trimmed };
  if (/^#{2,6}\s+/.test(trimmed)) {
    return { kind: "subsection", text: trimmed.replace(/^#{2,6}\s+/, "") };
  }
  if (/^\|.*\|$/.test(trimmed)) return { kind: "table", text };
  return { kind: "line", text };
}

function appendInjectionPreviewContent(container, injectionText = "") {
  const lines = String(injectionText || "").replace(/\r\n/g, "\n").split("\n");
  let tableBuffer = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const pre = el("pre", "bme-recall-injection-table", tableBuffer.join("\n"));
    container.appendChild(pre);
    tableBuffer = [];
  };

  for (const rawLine of lines) {
    const classified = classifyInjectionLine(rawLine);
    if (classified.kind === "table") {
      tableBuffer.push(classified.text);
      continue;
    }

    flushTable();

    if (classified.kind === "blank") {
      container.appendChild(el("div", "bme-recall-injection-spacer"));
      continue;
    }
    if (classified.kind === "section") {
      container.appendChild(
        el("div", "bme-recall-injection-section-title", classified.text),
      );
      continue;
    }
    if (classified.kind === "subsection") {
      container.appendChild(
        el("div", "bme-recall-injection-subsection", classified.text),
      );
      continue;
    }
    container.appendChild(el("div", "bme-recall-injection-line", classified.text));
  }

  flushTable();
}

function buildInjectionPreviewBlock(record = {}, { forcePlain = false } = {}) {
  const injectionText = String(record?.injectionText || "").trim();
  if (!injectionText) return null;

  const isEna = !forcePlain && isPlannerRecallSource(record);
  const wrap = el(
    "div",
    `bme-recall-injection-preview${isEna ? " is-ena" : ""}`,
  );
  const header = el("button", "bme-recall-injection-toggle");
  header.type = "button";
  const defaultExpanded = isEna;
  header.setAttribute("aria-expanded", defaultExpanded ? "true" : "false");
  header.innerHTML = `
    <span class="bme-recall-injection-toggle-label">${isEna ? t("recall.card.injectionPreview.ena") : t("recall.card.injectionPreview")}</span>
    <span class="bme-recall-injection-toggle-arrow">▶</span>
  `;
  wrap.appendChild(header);

  const content = el("div", "bme-recall-injection-content");
  if (isEna) {
    content.appendChild(
      el("div", "bme-recall-injection-note", t("recall.card.enaNote")),
    );
  }
  appendInjectionPreviewContent(content, injectionText);
  wrap.appendChild(content);
  wrap.classList.toggle("expanded", defaultExpanded);

  header.addEventListener("click", (event) => {
    event.stopPropagation();
    const expanded = wrap.classList.toggle("expanded");
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
  });

  return wrap;
}

function buildExpandedRenderSignature({
  record,
  userMessageText,
  selectedNodeIds,
  subGraph,
  plotRecord,
  activeTab,
} = {}) {
  return stableSerialize({
    updatedAt: String(record?.updatedAt || ""),
    manuallyEdited: Boolean(record?.manuallyEdited),
    authoritativeInputUsed: Boolean(record?.authoritativeInputUsed),
    boundUserFloorText: String(record?.boundUserFloorText || ""),
    generationCount: Number.isFinite(record?.generationCount)
      ? record.generationCount
      : 0,
    tokenEstimate: Number.isFinite(record?.tokenEstimate) ? record.tokenEstimate : 0,
    recallSource: String(record?.recallSource || ""),
    hookName: String(record?.hookName || ""),
    injectionText: String(record?.injectionText || ""),
    selectedNodeIds: normalizeSelectedNodeIds(selectedNodeIds),
    userMessageText: String(userMessageText || ""),
    subGraph: summarizeSubGraphForSignature(subGraph),
    plotRecord: summarizePlotRecordForSignature(plotRecord),
    activeTab: String(activeTab || "recall"),
  });
}

// ==================== Plot / Planner pane ====================

function formatPlotDate(value) {
  if (!value) return "";
  if (Number.isFinite(Number(value))) {
    try {
      const date = new Date(Number(value));
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString().replace(/T/, " ").replace(/\.\d+Z$/, "");
      }
    } catch {
      // fall through
    }
  }
  const dateStr = String(value).replace(/T/, " ").replace(/\.\d+Z$/, "");
  return dateStr;
}

function buildPlannerMeta(plotRecord) {
  const parts = [];
  if (plotRecord?.promptProfileId) {
    parts.push(t("recall.planner.profile", { profile: plotRecord.promptProfileId }));
  }
  const createdAt = formatPlotDate(plotRecord?.createdAt);
  if (createdAt) parts.push(createdAt);
  if (!parts.length) return null;
  const wrap = el("div", "bme-recall-planner-meta");
  for (const part of parts) {
    wrap.appendChild(el("span", "bme-recall-planner-meta-item", part));
  }
  return wrap;
}

function buildPlannerRawTags(plotRecord) {
  const details = el("details", "bme-recall-planner-raw");
  const summary = el("summary", "bme-recall-planner-raw-summary", t("recall.planner.rawTags"));
  details.appendChild(summary);

  const chunks = [];
  if (plotRecord?.plotText) chunks.push(String(plotRecord.plotText));
  if (Array.isArray(plotRecord?.plotBlocks) && plotRecord.plotBlocks.length > 0) {
    chunks.push(...plotRecord.plotBlocks.map((b) => String(b || "")));
  }
  const rawText = chunks.join("\n\n").trim() || t("common.emptyParenthetical");
  details.appendChild(el("pre", "bme-recall-planner-raw-content", rawText));
  return details;
}

function appendPlannerTextSection(pane, className, label, entries = []) {
  const normalizedEntries = entries.map((item) => String(item || "").trim()).filter(Boolean);
  if (!normalizedEntries.length) return false;
  const section = el("div", "bme-recall-planner-section");
  section.appendChild(el("div", "bme-recall-planner-section-label", label));
  for (const text of normalizedEntries) {
    section.appendChild(el("pre", className, text));
  }
  pane.appendChild(section);
  return true;
}

function appendPlannerPlotList(pane, label, entries = []) {
  const normalizedEntries = entries.map((item) => String(item || "").trim()).filter(Boolean);
  if (!normalizedEntries.length) return false;
  const section = el("div", "bme-recall-planner-section");
  section.appendChild(el("div", "bme-recall-planner-section-label", label));
  const list = el("ol", "bme-recall-planner-plot-list");
  for (const text of normalizedEntries) {
    const item = el("li", "bme-recall-planner-plot-item", text);
    list.appendChild(item);
  }
  section.appendChild(list);
  pane.appendChild(section);
  return true;
}

function buildPlannerPane(
  plotRecord,
  { estimateTokens = defaultEstimateTokens, callbacks = {}, messageIndex = null } = {},
) {
  const pane = el("div", "bme-recall-pane bme-recall-planner-pane");

  if (!hasPlotRecordContent(plotRecord)) {
    pane.appendChild(el("div", "bme-recall-planner-empty", t("recall.planner.empty")));
    return pane;
  }

  const tagged = extractTaggedPlannerBlocks(plotRecord);
  appendPlannerPlotList(
    pane,
    t("recall.planner.guidance"),
    tagged.plot.length ? tagged.plot : [tagged.fallback],
  );
  appendPlannerTextSection(
    pane,
    "bme-recall-planner-note",
    t("recall.planner.notes"),
    tagged.note,
  );
  appendPlannerTextSection(
    pane,
    "bme-recall-planner-block",
    t("recall.planner.state"),
    tagged.state,
  );
  appendPlannerTextSection(
    pane,
    "bme-recall-planner-block",
    t("recall.planner.plotLog"),
    tagged.plotLog,
  );

  // 任务状态
  const taskResults = Array.isArray(plotRecord.taskResults) ? plotRecord.taskResults : [];
  if (taskResults.length) {
    const stateSection = el("div", "bme-recall-planner-section");
    stateSection.appendChild(el("div", "bme-recall-planner-section-label", t("recall.planner.state")));
    const taskList = el("ul", "bme-recall-planner-task-list");
    for (const task of taskResults) {
      const item = el("li", "bme-recall-planner-task-item");
      const status = el("span", `bme-recall-planner-task-status ${String(task?.status || "").trim().replace(/\s+/g, "-") || "unknown"}`, String(task?.status || "-"));
      const name = el("span", "bme-recall-planner-task-name", String(task?.taskName || ""));
      item.appendChild(status);
      item.appendChild(name);
      taskList.appendChild(item);
    }
    stateSection.appendChild(taskList);
    pane.appendChild(stateSection);
  }

  // Token hint for plot
  const plotTokenText = getPlotRecordBlocks(plotRecord).join("\n\n");
  const plotTokens = estimateTokens(plotTokenText);
  if (plotTokens > 0) {
    pane.appendChild(el("div", "bme-recall-planner-token-hint", formatTokenHint(plotTokens)));
  }

  const meta = buildPlannerMeta(plotRecord);
  if (meta) pane.appendChild(meta);

  pane.appendChild(buildPlannerRawTags(plotRecord));

  // Actions row
  const actions = el("div", "bme-recall-actions");
  const removeBtn = el("button", "bme-recall-action-btn danger");
  removeBtn.type = "button";
  removeBtn.innerHTML = `<span class="bme-recall-btn-icon">🗑</span> ${t("recall.card.removePlot")}`;
  setupDeleteConfirmation(removeBtn, () => {
    if (typeof callbacks.onRemovePlannerPlot === "function") {
      callbacks.onRemovePlannerPlot(messageIndex);
    }
  });
  actions.appendChild(removeBtn);
  pane.appendChild(actions);

  return pane;
}

// ==================== 卡片 DOM 构建 ====================

function buildRecallPane({
  activeRecord,
  activeUserMessageText,
  activeGraph,
  themeName,
  activeCallbacks,
  messageIndex,
  hasPlot = false,
}) {
  const pane = el("div", "bme-recall-pane bme-recall-recall-pane");

  if (activeRecord?.injectionText) {
    const resolvedSubGraph = activeGraph
      ? buildRecallSubGraph(activeGraph, activeRecord?.selectedNodeIds || [])
      : { nodes: [], edges: [] };

    if (resolvedSubGraph.nodes.length === 0) {
      const emptyMsg = el(
        "div",
        "bme-recall-empty",
        activeGraph ? t("recall.card.empty.nodesMissing") : t("recall.card.empty.graphNotReady"),
      );
      pane.appendChild(emptyMsg);
    } else {
      // Canvas 容器
      const canvasWrap = el("div", "bme-recall-canvas-wrap");
      const canvas = document.createElement("canvas");
      canvasWrap.appendChild(canvas);
      pane.appendChild(canvasWrap);

      // 创建小画布 GraphRenderer（渲染器由调用方持有并清理）
      const renderer = new GraphRenderer(canvas, {
        theme: themeName,
        forceConfig: RECALL_CARD_FORCE_CONFIG,
        userPovAliases: _hostUserPovAliasHintsForRecallCanvas(),
        onNodeClick: (node) => {
          if (typeof activeCallbacks.onNodeClick === "function") {
            activeCallbacks.onNodeClick(messageIndex, node);
          }
        },
        onNodeDoubleClick: (node) => {
          if (typeof activeCallbacks.onNodeClick === "function") {
            activeCallbacks.onNodeClick(messageIndex, node);
          }
        },
      });
      renderer.loadGraph(resolvedSubGraph, {
        userPovAliases: _hostUserPovAliasHintsForRecallCanvas(),
      });
      pane._bmeRenderer = renderer;
    }

    // 元信息行
    const meta = el("div", "bme-recall-meta");
    const sourceLabel = buildRecallSourceLabel(activeRecord || {});
    const metaText = formatMetaLine(activeRecord || {});
    if (typeof HTMLElement === "undefined" || !(meta instanceof HTMLElement)) {
      meta.textContent = metaText;
    }
    const showEnaSource = isPlannerRecallSource(activeRecord);
    if (sourceLabel) {
      const sourceTag = el(
        "span",
        `bme-recall-meta-tag${showEnaSource ? " is-ena" : ""}`,
        showEnaSource ? `🧭 ${sourceLabel}` : sourceLabel,
      );
      meta.appendChild(sourceTag);
    }
    if (metaText) {
      meta.appendChild(el("span", "bme-recall-meta-text", metaText));
    }
    if (activeRecord?.manuallyEdited) {
      const tag = el("span", "bme-recall-meta-tag", `✍ ${t("recall.card.meta.manualEdit")}`);
      meta.appendChild(tag);
    }
    pane.appendChild(meta);

    const injectionPreviewBlock = buildInjectionPreviewBlock(activeRecord || {}, {
      forcePlain: false,
    });
    if (injectionPreviewBlock) {
      pane.appendChild(injectionPreviewBlock);
    }

    // 操作按钮行
    const actions = el("div", "bme-recall-actions");

    const editBtn = el("button", "bme-recall-action-btn");
    editBtn.innerHTML = `<span class="bme-recall-btn-icon">✏️</span> ${t("common.edit")}`;
    editBtn.type = "button";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      activeCallbacks.onEdit?.(messageIndex);
    });
    actions.appendChild(editBtn);

    const deleteBtn = el("button", "bme-recall-action-btn");
    deleteBtn.innerHTML = `<span class="bme-recall-btn-icon">🗑</span> ${t("common.delete")}`;
    deleteBtn.type = "button";
    setupDeleteConfirmation(deleteBtn, () => {
      activeCallbacks.onDelete?.(messageIndex);
    });
    actions.appendChild(deleteBtn);

    const recallBtn = el("button", "bme-recall-action-btn");
    recallBtn.innerHTML = `<span class="bme-recall-btn-icon">🔄</span> ${t("recall.card.rerun")}`;
    recallBtn.type = "button";
    recallBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      setRecallButtonLoading(recallBtn, true);
      try {
        await activeCallbacks.onRerunRecall?.(messageIndex);
      } finally {
        setRecallButtonLoading(recallBtn, false);
      }
    });
    actions.appendChild(recallBtn);

    pane.appendChild(actions);
  } else {
    pane.appendChild(el("div", "bme-recall-empty", t("recall.card.empty.graphNotReady")));
  }

  return pane;
}

/**
 * 创建消息级召回卡片 DOM
 * @param {object} params
 * @param {number} params.messageIndex
 * @param {object} params.record - bme_recall record
 * @param {object|null} params.plotRecord - st_bme_plot record
 * @param {string} params.userMessageText
 * @param {object|null} params.graph - currentGraph
 * @param {string} params.themeName
 * @param {object} params.callbacks
 * @returns {HTMLElement}
 */
export function createRecallCardElement({
  messageIndex,
  record,
  plotRecord = null,
  userMessageText = "",
  graph = null,
  themeName = "crimson",
  userInputDisplayMode = "beautify_only",
  callbacks = {},
} = {}) {
  const card = el("div", "bme-recall-card");
  card.dataset.messageIndex = String(messageIndex);
  card.dataset.bmeUiVersion = RECALL_CARD_UI_VERSION;
  card.dataset.updatedAt = String(record?.updatedAt || "");
  card.dataset.expandedRenderSignature = "";

  let hasRecall = Boolean(record?.injectionText);
  let hasPlot = hasPlotRecordContent(plotRecord);

  let activeRecord = record || {};
  let activePlotRecord = plotRecord || null;
  let activeUserMessageText = String(userMessageText || "");
  let activeGraph = graph || null;
  let activeCallbacks = callbacks || {};
  let activeUserInputDisplayMode = normalizeUserInputDisplayMode(
    userInputDisplayMode,
  );
  let expandedRenderSignature = "";
  let isEditingUserInput = false;
  const estimateTokens = (text) => resolveEstimateTokens(activeCallbacks)(text);

  // Default active tab: planner if plot text exists, otherwise recall
  let activeTab = hasPlot ? "planner" : "recall";

  // -- 用户消息区 --
  const userLabel = el("div", "bme-recall-user-label");
  const userLabelText = el("div", "bme-recall-user-label-text");
  userLabelText.innerHTML = `💬 <span>${t("recall.card.userInput")}</span>`;
  userLabel.appendChild(userLabelText);

  const userLabelActions = el("div", "bme-recall-user-label-actions");
  const editUserInputBtn = el("button", "bme-recall-user-edit-btn");
  editUserInputBtn.type = "button";
  editUserInputBtn.innerHTML = `<span class="bme-recall-btn-icon">✏️</span><span>${t("common.edit")}</span>`;
  userLabelActions.appendChild(editUserInputBtn);
  userLabel.appendChild(userLabelActions);
  card.appendChild(userLabel);

  const userText = el("div", "bme-recall-user-text", activeUserMessageText || t("common.emptyParenthetical"));
  card.appendChild(userText);

  const userEditWrap = el("div", "bme-recall-user-edit-wrap");
  const userEditTextarea = document.createElement("textarea");
  userEditTextarea.className = "bme-recall-user-edit-textarea";
  userEditWrap.appendChild(userEditTextarea);
  const userEditActions = el("div", "bme-recall-user-edit-actions");
  const userEditSaveBtn = el("button", "bme-recall-user-edit-action primary", t("common.save"));
  userEditSaveBtn.type = "button";
  const userEditCancelBtn = el("button", "bme-recall-user-edit-action secondary", t("common.cancel"));
  userEditCancelBtn.type = "button";
  userEditActions.appendChild(userEditSaveBtn);
  userEditActions.appendChild(userEditCancelBtn);
  userEditWrap.appendChild(userEditActions);
  card.appendChild(userEditWrap);

  // -- 横向 tabs (保留 .bme-recall-bar 用于兼容) --
  const bar = el("div", "bme-recall-bar bme-recall-tabs");

  const recallTab = el("button", "bme-recall-tab bme-recall-tab-recall");
  recallTab.type = "button";
  recallTab.setAttribute("aria-pressed", "false");
  const initialNodeCount = Array.isArray(activeRecord?.selectedNodeIds)
    ? activeRecord.selectedNodeIds.length
    : 0;
  const recallBadgeText = initialNodeCount > 0
    ? t("recall.card.memoryCount", { count: initialNodeCount })
    : t("recall.card.memoryReady");
  const recallTabIcon = el("span", "bme-recall-tab-icon", "🧠");
  const recallTabTitle = el("span", "bme-recall-tab-title", t("recall.tab.recall"));
  const recallBadge = el("span", "bme-recall-tab-badge bme-recall-count-badge", recallBadgeText);
  recallTab.appendChild(recallTabIcon);
  recallTab.appendChild(recallTabTitle);
  recallTab.appendChild(recallBadge);
  bar.appendChild(recallTab);

  const plannerTab = el("button", "bme-recall-tab bme-recall-tab-planner");
  plannerTab.type = "button";
  plannerTab.setAttribute("aria-pressed", "false");
  const plannerTabIcon = el("span", "bme-recall-tab-icon", "🧭");
  const plannerTabTitle = el("span", "bme-recall-tab-title", t("recall.tab.planner"));
  const plannerTabBadge = el("span", "bme-recall-tab-badge", t("recall.tab.plotLabel"));
  plannerTab.appendChild(plannerTabIcon);
  plannerTab.appendChild(plannerTabTitle);
  plannerTab.appendChild(plannerTabBadge);
  bar.appendChild(plannerTab);

  const tokenHint = el("span", "bme-recall-token-hint", "");
  bar.appendChild(tokenHint);

  const arrow = el("span", "bme-recall-expand-arrow", "▶");
  bar.appendChild(arrow);

  card.appendChild(bar);

  // -- 展开内容区 --
  const body = el("div", "bme-recall-body");
  card.appendChild(body);

  function setUserInputEditMode(editing = false) {
    isEditingUserInput = Boolean(editing);
    card.classList.toggle("bme-recall-user-input-editing", isEditingUserInput);
    userText.hidden = isEditingUserInput;
    userEditWrap.hidden = !isEditingUserInput;
    editUserInputBtn.disabled = isEditingUserInput;
    if (!isEditingUserInput) return;

    userEditTextarea.value = activeUserMessageText || "";
    const lineCount = Math.max(3, String(activeUserMessageText || "").split(/\n/).length);
    if (userEditTextarea.style && typeof userEditTextarea.style === "object") {
      userEditTextarea.style.minHeight = `${Math.min(12, lineCount) * 22}px`;
    }
    userEditTextarea.focus?.();
  }

  function destroyRenderer() {
    const pane = body.querySelector(".bme-recall-recall-pane");
    if (pane?._bmeRenderer) {
      pane._bmeRenderer.stopAnimation();
      pane._bmeRenderer.destroy();
      pane._bmeRenderer = null;
    }
  }

  function updateBarState() {
    const showRecall = hasRecall || !hasPlot;
    const showPlanner = hasPlot || !hasRecall;
    recallTab.hidden = !showRecall;
    plannerTab.hidden = !showPlanner;
    recallTab.classList.toggle("active", activeTab === "recall");
    plannerTab.classList.toggle("active", activeTab === "planner");
    recallTab.setAttribute("aria-pressed", activeTab === "recall" ? "true" : "false");
    plannerTab.setAttribute("aria-pressed", activeTab === "planner" ? "true" : "false");

    const nodeCount = Array.isArray(activeRecord?.selectedNodeIds)
      ? activeRecord.selectedNodeIds.length
      : 0;
    if (recallBadge) {
      recallBadge.textContent = nodeCount > 0
        ? t("recall.card.memoryCount", { count: nodeCount })
        : t("recall.card.memoryReady");
    }

    const currentEstimate = activeTab === "planner" && hasPlotRecordContent(activePlotRecord)
      ? estimateTokens(getPlotRecordBlocks(activePlotRecord).join("\n\n"))
      : activeRecord?.tokenEstimate;
    tokenHint.textContent = formatTokenHint(currentEstimate);
  }

  function buildExpandedContent(nextSignature = "") {
    destroyRenderer();
    body.innerHTML = "";
    body.classList.toggle("active-tab-recall", activeTab === "recall");
    body.classList.toggle("active-tab-planner", activeTab === "planner");

    let pane = null;
    if (activeTab === "planner" && activePlotRecord) {
      pane = buildPlannerPane(activePlotRecord, {
        estimateTokens,
        callbacks: activeCallbacks,
        messageIndex,
      });
    } else {
      pane = buildRecallPane({
        activeRecord,
        activeUserMessageText,
        activeGraph,
        themeName,
        activeCallbacks,
        messageIndex,
        hasPlot,
      });
    }
    body.appendChild(pane);

    expandedRenderSignature =
      nextSignature ||
      buildExpandedRenderSignature({
        record: activeRecord,
        userMessageText: activeUserMessageText,
        selectedNodeIds: activeRecord?.selectedNodeIds || [],
        subGraph: activeGraph
          ? buildRecallSubGraph(activeGraph, activeRecord?.selectedNodeIds || [])
          : { nodes: [], edges: [] },
        plotRecord: activePlotRecord,
        activeTab,
      });
    card.dataset.expandedRenderSignature = expandedRenderSignature;
  }

  function switchTab(tabName) {
    if (tabName !== "recall" && tabName !== "planner") return;
    const requestedAvailable =
      (tabName === "recall" && (hasRecall || !hasPlot)) ||
      (tabName === "planner" && (hasPlot || !hasRecall));
    if (!requestedAvailable) return;

    const wasExpanded = card.classList.contains("expanded");
    const sameTab = tabName === activeTab;
    activeTab = tabName;
    updateBarState();
    card.dataset.activeTab = activeTab;

    if (!wasExpanded) {
      card.classList.add("expanded");
    }
    if (sameTab && wasExpanded && body.childElementCount > 0) return;
    buildExpandedContent();
  }

  function applyCardRuntimeData(next = {}, { skipExpandedRerender = false } = {}) {
    if (next.record && typeof next.record === "object") {
      activeRecord = next.record;
    }
    if (Object.prototype.hasOwnProperty.call(next, "plotRecord")) {
      activePlotRecord = next.plotRecord || null;
    }
    if (Object.prototype.hasOwnProperty.call(next, "userMessageText")) {
      activeUserMessageText = String(next.userMessageText || "");
    }
    if (Object.prototype.hasOwnProperty.call(next, "userInputDisplayMode")) {
      activeUserInputDisplayMode = normalizeUserInputDisplayMode(
        next.userInputDisplayMode,
      );
    }
    if (Object.prototype.hasOwnProperty.call(next, "graph")) {
      activeGraph = next.graph || null;
    }
    if (next.callbacks && typeof next.callbacks === "object") {
      activeCallbacks = next.callbacks;
    }

    const nextHasRecall = Boolean(activeRecord?.injectionText);
    const nextHasPlot = hasPlotRecordContent(activePlotRecord);
    hasRecall = nextHasRecall;
    hasPlot = nextHasPlot;

    const dataUpdate =
      Object.prototype.hasOwnProperty.call(next, "record") ||
      Object.prototype.hasOwnProperty.call(next, "plotRecord");
    if (dataUpdate) {
      activeTab = nextHasPlot ? "planner" : nextHasRecall ? "recall" : activeTab;
    } else {
      const currentAvailable =
        (activeTab === "planner" && nextHasPlot) ||
        (activeTab === "recall" && nextHasRecall);
      activeTab = currentAvailable ? activeTab : nextHasPlot ? "planner" : "recall";
    }

    card.dataset.updatedAt = String(activeRecord?.updatedAt || "");
    card.dataset.activeTab = activeTab;
    card.dataset.expandedRenderSignature = expandedRenderSignature;
    card.dataset.userInputDisplayMode = activeUserInputDisplayMode;
    card.classList.toggle(
      "bme-recall-hide-user-input",
      activeUserInputDisplayMode === "off",
    );
    userText.textContent = activeUserMessageText || t("common.emptyParenthetical");
    if (isEditingUserInput) {
      userEditTextarea.value = activeUserMessageText || "";
    }

    updateBarState();

    if (skipExpandedRerender || !card.classList.contains("expanded")) return;

    const nextSignature = buildExpandedRenderSignature({
      record: activeRecord,
      userMessageText: activeUserMessageText,
      selectedNodeIds: activeRecord?.selectedNodeIds || [],
      subGraph: activeGraph
        ? buildRecallSubGraph(activeGraph, activeRecord?.selectedNodeIds || [])
        : { nodes: [], edges: [] },
      plotRecord: activePlotRecord,
      activeTab,
    });
    if (nextSignature === expandedRenderSignature) return;

    buildExpandedContent(nextSignature);
  }

  card._bmeUpdateRecallCard = applyCardRuntimeData;

  editUserInputBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setUserInputEditMode(true);
  });

  userEditCancelBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    setUserInputEditMode(false);
  });

  userEditSaveBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const result = await activeCallbacks.onEditUserInput?.(
      messageIndex,
      userEditTextarea.value,
    );
    if (result?.ok) {
      if (Object.prototype.hasOwnProperty.call(result, "nextText")) {
        activeUserMessageText = String(result.nextText || "");
        userText.textContent = activeUserMessageText || t("common.emptyParenthetical");
      }
      setUserInputEditMode(false);
    }
  });

  const BAR_INTERACTION_TYPES = new Set(["click", "pointerup", "touchend"]);
  let lastPointerHandledAt = 0;
  let lastPointerHandledType = "";
  let lastPointerHandledTarget = null;

  function isBarInteractionEvent(type = "") {
    return BAR_INTERACTION_TYPES.has(String(type || "").toLowerCase());
  }

  function markPointerHandled(event) {
    if (event.type === "pointerup" || event.type === "touchend") {
      lastPointerHandledAt = Date.now();
      lastPointerHandledType = String(event.type || "");
      lastPointerHandledTarget = resolveComparableInteractionTarget(event);
    }
  }

  function shouldSkipDuplicatePointerEvent(event) {
    const type = String(event?.type || "");
    if (type !== "click" && type !== "touchend") return false;
    if (!lastPointerHandledAt || Date.now() - lastPointerHandledAt >= 750) return false;
    const target = resolveComparableInteractionTarget(event);
    if (!target || target !== lastPointerHandledTarget) return false;
    // Suppress the touchend + synthetic click that can follow pointerup on real touch devices.
    return type === "click" || (type === "touchend" && lastPointerHandledType === "pointerup");
  }

  function handleTabInteraction(event, tabName) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    switchTab(tabName);
    markPointerHandled(event);
  }

  function resolveTabFromBarEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : null;
    if (Array.isArray(path)) {
      for (const node of path) {
        if (node === bar) break;
        if (
          node &&
          node.nodeType === 1 &&
          typeof node.classList?.contains === "function" &&
          node.classList.contains("bme-recall-tab")
        ) {
          return node;
        }
      }
    }
    if (event.target && typeof event.target.closest === "function") {
      return event.target.closest(".bme-recall-tab") || null;
    }
    return null;
  }

  function resolveComparableInteractionTarget(event) {
    return resolveTabFromBarEvent(event) || event?.target || null;
  }

  // Direct listeners cover normal button clicks and the test harness DOM.
  // pointerup/touchend delegates on the bar cover real ST touch/pen interactions
  // where the host message wrapper may retarget or intercept events.
  recallTab.addEventListener("click", (event) => handleTabInteraction(event, "recall"));
  plannerTab.addEventListener("click", (event) => handleTabInteraction(event, "planner"));

  // 点击 bar：tab 区域切换并展开；非 tab 区域仅展开/折叠当前 tab。
  // 使用 bubble 阶段，避免 capture stopPropagation 阻断内部 button 的 fallback 行为。
  function handleBarInteraction(event) {
    if (!isBarInteractionEvent(event.type)) return;
    if (shouldSkipDuplicatePointerEvent(event)) {
      if (event.type === "click") {
        lastPointerHandledAt = 0;
        lastPointerHandledType = "";
        lastPointerHandledTarget = null;
      }
      return;
    }

    const tab = resolveTabFromBarEvent(event);
    if (tab) {
      if (tab === recallTab) handleTabInteraction(event, "recall");
      if (tab === plannerTab) handleTabInteraction(event, "planner");
      return;
    }

    event.preventDefault?.();
    event.stopPropagation?.();
    markPointerHandled(event);

    const isExpanded = card.classList.toggle("expanded");
    if (isExpanded) {
      applyCardRuntimeData({}, { skipExpandedRerender: true });
      buildExpandedContent();
    } else {
      destroyRenderer();
      body.innerHTML = "";
      expandedRenderSignature = "";
      card.dataset.expandedRenderSignature = "";
    }
  }

  bar.addEventListener("click", handleBarInteraction);
  bar.addEventListener("pointerup", handleBarInteraction);
  bar.addEventListener("touchend", handleBarInteraction);

  applyCardRuntimeData({}, { skipExpandedRerender: true });
  setUserInputEditMode(false);

  // 暴露清理方法
  card._bmeDestroyRenderer = () => {
    destroyRenderer();
    expandedRenderSignature = "";
    card.dataset.expandedRenderSignature = "";
  };

  return card;
}


/**
 * 更新已有卡片的 badge / token hint / meta（不重建整个卡片）
 */
export function updateRecallCardData(cardElement, record, options = {}) {
  if (!cardElement || !record) return;
  if (cardElement.dataset?.bmeUiVersion !== RECALL_CARD_UI_VERSION) {
    return false;
  }

  if (typeof cardElement._bmeUpdateRecallCard === "function") {
    cardElement._bmeUpdateRecallCard({
      record,
      plotRecord: options?.plotRecord,
      userMessageText: options?.userMessageText,
      userInputDisplayMode: options?.userInputDisplayMode,
      graph: options?.graph,
      callbacks: options?.callbacks,
    });
    return true;
  }

  cardElement.dataset.updatedAt = String(record.updatedAt || "");
  return true;
}

// ==================== 删除二次确认 ====================

export function setupDeleteConfirmation(button, onConfirm) {
  let confirmTimer = null;
  let pendingConfirm = false;
  const originalHTML = button.innerHTML;

  function reset() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    pendingConfirm = false;
    button.innerHTML = originalHTML;
    button.classList.remove("danger");
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pendingConfirm) {
      reset();
      onConfirm();
      return;
    }
    pendingConfirm = true;
    button.textContent = t("recall.card.confirmDeleteShort");
    button.classList.add("danger");
    confirmTimer = setTimeout(reset, DELETE_CONFIRM_TIMEOUT_MS);
  });
}

// ==================== Loading 状态 ====================

export function setRecallButtonLoading(button, loading) {
  if (loading) {
    button._bmeOriginalHTML = button.innerHTML;
    button.innerHTML =
      `<span class="bme-recall-btn-icon" style="display:inline-block">⟳</span> ${t("recall.card.rerunning")}`;
    button.classList.add("loading");
    button.disabled = true;
  } else {
    button.innerHTML = button._bmeOriginalHTML || button.innerHTML;
    button.classList.remove("loading");
    button.disabled = false;
  }
}

// ==================== 侧边栏 ====================

let sidebarBackdrop = null;
let sidebarElement = null;

function ensureSidebarDOM() {
  if (sidebarBackdrop && sidebarElement) return;

  sidebarBackdrop = el("div", "bme-recall-sidebar-backdrop");
  sidebarBackdrop.addEventListener("click", () => closeRecallSidebar());

  sidebarElement = el("div", "bme-recall-sidebar");

  document.body.appendChild(sidebarBackdrop);
  document.body.appendChild(sidebarElement);
}

/**
 * 打开召回编辑/查看侧边栏
 * @param {object} params
 * @param {'view'|'edit'} params.mode
 * @param {number} params.messageIndex
 * @param {object} params.record
 * @param {object|null} params.node - 点击的节点（view 模式）
 * @param {object|null} params.graph
 * @param {object} params.callbacks
 */
export function openRecallSidebar({
  mode = "edit",
  messageIndex,
  record,
  node = null,
  graph = null,
  callbacks = {},
}) {
  ensureSidebarDOM();
  sidebarElement.innerHTML = "";

  // Header
  const header = el("div", "bme-recall-sidebar-header");
  const headerTitle = el("div", "bme-recall-sidebar-header-title");
  headerTitle.textContent =
    mode === "edit" ? `📝 ${t("recall.sidebar.editTitle")}` : `🔍 ${t("recall.sidebar.nodeTitle")}`;
  header.appendChild(headerTitle);

  const closeBtn = el("button", "bme-recall-sidebar-close");
  closeBtn.innerHTML = "✕";
  closeBtn.type = "button";
  closeBtn.addEventListener("click", () => closeRecallSidebar());
  header.appendChild(closeBtn);

  sidebarElement.appendChild(header);

  // Node info (if viewing a specific node)
  if (node && mode === "view") {
    const nodeInfo = el("div", "bme-recall-sidebar-node-info");
    const rows = [
      [t("recall.sidebar.nodeType"), node.type || node.raw?.type || "-"],
      [t("recall.sidebar.nodeName"), node.name || node.raw?.name || "-"],
      [t("recall.sidebar.nodeImportance"), String(node.importance ?? node.raw?.importance ?? "-")],
    ];
    for (const [label, value] of rows) {
      const row = el("div", "bme-recall-sidebar-node-info-row");
      const labelEl = el("span", "bme-recall-sidebar-node-info-label", label);
      const valueEl = el("span", "", value);
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      nodeInfo.appendChild(row);
    }

    // Show edges to other recalled nodes
    if (graph && record?.selectedNodeIds) {
      const idSet = new Set(record.selectedNodeIds);
      const relatedEdges = (graph.edges || []).filter(
        (e) =>
          !e.invalidAt &&
          !e.expiredAt &&
          ((e.fromId === node.id && idSet.has(e.toId)) ||
            (e.toId === node.id && idSet.has(e.fromId))),
      );
      if (relatedEdges.length > 0) {
        const edgeRow = el("div", "bme-recall-sidebar-node-info-row");
        const edgeLabel = el("span", "bme-recall-sidebar-node-info-label", t("recall.sidebar.related"));
        const edgeValue = el("span", "", t("recall.sidebar.edgeCount", { count: relatedEdges.length }));
        edgeRow.appendChild(edgeLabel);
        edgeRow.appendChild(edgeValue);
        nodeInfo.appendChild(edgeRow);
      }
    }

    sidebarElement.appendChild(nodeInfo);
  }

  // Body
  const body = el("div", "bme-recall-sidebar-body");
  const sectionLabel = el(
    "div",
    "bme-recall-sidebar-section-label",
    mode === "edit" ? t("recall.sidebar.injectionEditable") : t("recall.sidebar.injectionText"),
  );
  body.appendChild(sectionLabel);

  let textarea = null;
  const injectionText = record?.injectionText || "";

  if (mode === "edit") {
    textarea = document.createElement("textarea");
    textarea.className = "bme-recall-sidebar-textarea";
    textarea.value = injectionText;
    textarea.placeholder = t("recall.sidebar.inputPlaceholder");
    body.appendChild(textarea);

    const tokenHint = el("div", "bme-recall-sidebar-token-hint");
    const updateTokenHint = () => {
      const count =
        typeof callbacks.estimateTokens === "function"
          ? callbacks.estimateTokens(textarea.value)
          : defaultEstimateTokens(textarea.value);
      tokenHint.textContent = `~${count} tokens`;
    };
    updateTokenHint();

    let debounceTimer = null;
    textarea.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(updateTokenHint, 300);
    });
    body.appendChild(tokenHint);
  } else {
    const readonlyEl = el("div", "bme-recall-sidebar-readonly", injectionText || t("common.emptyParenthetical"));
    body.appendChild(readonlyEl);
  }

  sidebarElement.appendChild(body);

  // Footer
  const footer = el("div", "bme-recall-sidebar-footer");

  if (mode === "edit") {
    const saveBtn = el("button", "bme-recall-sidebar-btn primary", t("common.save"));
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => {
      const newText = textarea?.value || "";
      callbacks.onSave?.(messageIndex, newText);
      closeRecallSidebar();
    });
    footer.appendChild(saveBtn);

    const cancelBtn = el("button", "bme-recall-sidebar-btn secondary", t("common.cancel"));
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => closeRecallSidebar());
    footer.appendChild(cancelBtn);
  } else {
    // View mode: offer edit button
    const editBtn = el("button", "bme-recall-sidebar-btn primary", `✏️ ${t("common.edit")}`);
    editBtn.type = "button";
    editBtn.addEventListener("click", () => {
      openRecallSidebar({
        mode: "edit",
        messageIndex,
        record,
        node: null,
        graph,
        callbacks,
      });
    });
    footer.appendChild(editBtn);

    const closeFooterBtn = el("button", "bme-recall-sidebar-btn secondary", t("common.close"));
    closeFooterBtn.type = "button";
    closeFooterBtn.addEventListener("click", () => closeRecallSidebar());
    footer.appendChild(closeFooterBtn);
  }

  sidebarElement.appendChild(footer);

  // Animate in
  requestAnimationFrame(() => {
    sidebarBackdrop.classList.add("open");
    sidebarElement.classList.add("open");
    if (textarea) textarea.focus();
  });
}

export function closeRecallSidebar() {
  if (sidebarBackdrop) sidebarBackdrop.classList.remove("open");
  if (sidebarElement) sidebarElement.classList.remove("open");
}
