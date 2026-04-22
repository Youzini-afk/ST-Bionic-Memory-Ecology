// ST-BME: 消息级召回卡片 UI
// 纯 DOM 构建模块，不含模块级 mutable state

import { getContext } from "../../../../extensions.js";
import { GraphRenderer } from "./graph-renderer.js";

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

function formatTokenHint(tokenEstimate) {
  if (!Number.isFinite(tokenEstimate) || tokenEstimate <= 0) return "";
  return `~${tokenEstimate} tokens`;
}

function formatMetaLine(record) {
  const parts = [];
  if (record.recallSource && !buildRecallSourceLabel(record)) {
    parts.push(`来源: ${record.recallSource}`);
  }
  if (record.authoritativeInputUsed) parts.push("权威输入");
  if (record.tokenEstimate > 0) parts.push(`~${record.tokenEstimate} tokens`);
  if (Number.isFinite(record.generationCount) && record.generationCount > 0) {
    parts.push(`回退 ${record.generationCount} 次`);
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

function buildInjectionPreviewBlock(record = {}) {
  const injectionText = String(record?.injectionText || "").trim();
  if (!injectionText) return null;

  const isEna = isPlannerRecallSource(record);
  const wrap = el(
    "div",
    `bme-recall-injection-preview${isEna ? " is-ena" : ""}`,
  );
  const header = el("button", "bme-recall-injection-toggle");
  header.type = "button";
  const defaultExpanded = isEna;
  header.setAttribute("aria-expanded", defaultExpanded ? "true" : "false");
  header.innerHTML = `
    <span class="bme-recall-injection-toggle-label">${isEna ? "ENA 注入预览" : "注入预览"}</span>
    <span class="bme-recall-injection-toggle-arrow">▶</span>
  `;
  wrap.appendChild(header);

  const content = el("div", "bme-recall-injection-content");
  if (isEna) {
    content.appendChild(
      el("div", "bme-recall-injection-note", "由 Ena Planner 触发的本轮记忆块"),
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
  });
}

// ==================== 卡片 DOM 构建 ====================

/**
 * 创建消息级召回卡片 DOM
 * @param {object} params
 * @param {number} params.messageIndex
 * @param {object} params.record - bme_recall record
 * @param {string} params.userMessageText
 * @param {object|null} params.graph - currentGraph
 * @param {string} params.themeName
 * @param {object} params.callbacks
 * @returns {HTMLElement}
 */
export function createRecallCardElement({
  messageIndex,
  record,
  userMessageText = "",
  graph = null,
  themeName = "crimson",
  userInputDisplayMode = "beautify_only",
  callbacks = {},
}) {
  const card = el("div", "bme-recall-card");
  card.dataset.messageIndex = String(messageIndex);
  card.dataset.updatedAt = String(record?.updatedAt || "");
  card.dataset.expandedRenderSignature = "";

  let activeRecord = record || {};
  let activeUserMessageText = String(userMessageText || "");
  let activeGraph = graph || null;
  let activeCallbacks = callbacks || {};
  let activeUserInputDisplayMode = normalizeUserInputDisplayMode(
    userInputDisplayMode,
  );
  let expandedRenderSignature = "";
  let isEditingUserInput = false;

  // -- 用户消息区 --
  const userLabel = el("div", "bme-recall-user-label");
  const userLabelText = el("div", "bme-recall-user-label-text");
  userLabelText.innerHTML = "💬 <span>本轮用户输入</span>";
  userLabel.appendChild(userLabelText);

  const userLabelActions = el("div", "bme-recall-user-label-actions");
  const editUserInputBtn = el("button", "bme-recall-user-edit-btn");
  editUserInputBtn.type = "button";
  editUserInputBtn.innerHTML = '<span class="bme-recall-btn-icon">✏️</span><span>编辑</span>';
  userLabelActions.appendChild(editUserInputBtn);
  userLabel.appendChild(userLabelActions);
  card.appendChild(userLabel);

  const userText = el("div", "bme-recall-user-text", activeUserMessageText || "(empty)");
  card.appendChild(userText);

  const userEditWrap = el("div", "bme-recall-user-edit-wrap");
  const userEditTextarea = document.createElement("textarea");
  userEditTextarea.className = "bme-recall-user-edit-textarea";
  userEditWrap.appendChild(userEditTextarea);
  const userEditActions = el("div", "bme-recall-user-edit-actions");
  const userEditSaveBtn = el("button", "bme-recall-user-edit-action primary", "保存");
  userEditSaveBtn.type = "button";
  const userEditCancelBtn = el("button", "bme-recall-user-edit-action secondary", "取消");
  userEditCancelBtn.type = "button";
  userEditActions.appendChild(userEditSaveBtn);
  userEditActions.appendChild(userEditCancelBtn);
  userEditWrap.appendChild(userEditActions);
  card.appendChild(userEditWrap);

  // -- 召回条 --
  const initialNodeCount = Array.isArray(activeRecord?.selectedNodeIds)
    ? activeRecord.selectedNodeIds.length
    : 0;
  const bar = el("div", "bme-recall-bar");

  const barIcon = el("span", "bme-recall-bar-icon", "🧠");
  bar.appendChild(barIcon);

  const barTitle = el("span", "bme-recall-bar-title", "相关记忆召回");
  bar.appendChild(barTitle);

  const badge = el(
    "span",
    "bme-recall-count-badge",
    initialNodeCount > 0 ? `记忆 ${initialNodeCount}` : "记忆 ✓",
  );
  bar.appendChild(badge);

  const tokenHint = el(
    "span",
    "bme-recall-token-hint",
    formatTokenHint(activeRecord?.tokenEstimate),
  );

  bar.appendChild(tokenHint);

  const arrow = el("span", "bme-recall-expand-arrow", "▶");
  bar.appendChild(arrow);

  card.appendChild(bar);

  // -- 展开内容区 --
  const body = el("div", "bme-recall-body");
  card.appendChild(body);

  // renderer 实例管理
  let renderer = null;

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
    if (renderer) {
      renderer.stopAnimation();
      renderer.destroy();
      renderer = null;
    }
  }

  function buildExpandedContent(subGraph = null, nextSignature = "") {
    body.innerHTML = "";

    const resolvedSubGraph =
      subGraph ||
      (activeGraph
        ? buildRecallSubGraph(activeGraph, activeRecord?.selectedNodeIds || [])
        : { nodes: [], edges: [] });

    if (resolvedSubGraph.nodes.length === 0) {
      const emptyMsg = el(
        "div",
        "bme-recall-empty",
        activeGraph ? "召回节点已不存在或图谱已重建" : "图谱未就绪",
      );
      body.appendChild(emptyMsg);
    } else {
      // Canvas 容器
      const canvasWrap = el("div", "bme-recall-canvas-wrap");
      const canvas = document.createElement("canvas");
      canvasWrap.appendChild(canvas);
      body.appendChild(canvasWrap);

      // 创建小画布 GraphRenderer
      renderer = new GraphRenderer(canvas, {
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
    }

    // 元信息行
    const meta = el("div", "bme-recall-meta");
    const sourceLabel = buildRecallSourceLabel(activeRecord || {});
    const metaText = formatMetaLine(activeRecord || {});
    if (typeof HTMLElement === "undefined" || !(meta instanceof HTMLElement)) {
      meta.textContent = metaText;
    }
    if (sourceLabel) {
      const sourceTag = el(
        "span",
        `bme-recall-meta-tag${isPlannerRecallSource(activeRecord) ? " is-ena" : ""}`,
        isPlannerRecallSource(activeRecord) ? `🧭 ${sourceLabel}` : sourceLabel,
      );
      meta.appendChild(sourceTag);
    }
    if (metaText) {
      meta.appendChild(el("span", "bme-recall-meta-text", metaText));
    }
    if (activeRecord?.manuallyEdited) {
      const tag = el("span", "bme-recall-meta-tag", "✍ 手动编辑");
      meta.appendChild(tag);
    }
    body.appendChild(meta);

    const injectionPreviewBlock = buildInjectionPreviewBlock(activeRecord || {});
    if (injectionPreviewBlock) {
      body.appendChild(injectionPreviewBlock);
    }

    // 操作按钮行
    const actions = el("div", "bme-recall-actions");

    const editBtn = el("button", "bme-recall-action-btn");
    editBtn.innerHTML = '<span class="bme-recall-btn-icon">✏️</span> 编辑';
    editBtn.type = "button";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      activeCallbacks.onEdit?.(messageIndex);
    });
    actions.appendChild(editBtn);

    const deleteBtn = el("button", "bme-recall-action-btn");
    deleteBtn.innerHTML = '<span class="bme-recall-btn-icon">🗑</span> 删除';
    deleteBtn.type = "button";
    setupDeleteConfirmation(deleteBtn, () => {
      activeCallbacks.onDelete?.(messageIndex);
    });
    actions.appendChild(deleteBtn);

    const recallBtn = el("button", "bme-recall-action-btn");
    recallBtn.innerHTML = '<span class="bme-recall-btn-icon">🔄</span> 重新召回';
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

    body.appendChild(actions);

    expandedRenderSignature =
      nextSignature ||
      buildExpandedRenderSignature({
        record: activeRecord,
        userMessageText: activeUserMessageText,
        selectedNodeIds: activeRecord?.selectedNodeIds || [],
        subGraph: resolvedSubGraph,
      });
    card.dataset.expandedRenderSignature = expandedRenderSignature;
  }

  function applyCardRuntimeData(next = {}, { skipExpandedRerender = false } = {}) {
    if (next.record && typeof next.record === "object") {
      activeRecord = next.record;
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

    card.dataset.updatedAt = String(activeRecord?.updatedAt || "");
    card.dataset.expandedRenderSignature = expandedRenderSignature;
    card.dataset.userInputDisplayMode = activeUserInputDisplayMode;
    card.classList.toggle(
      "bme-recall-hide-user-input",
      activeUserInputDisplayMode === "off",
    );
    userText.textContent = activeUserMessageText || "(empty)";
    if (isEditingUserInput) {
      userEditTextarea.value = activeUserMessageText || "";
    }

    const nodeCount = Array.isArray(activeRecord?.selectedNodeIds)
      ? activeRecord.selectedNodeIds.length
      : 0;
    badge.textContent = nodeCount > 0 ? `记忆 ${nodeCount}` : "记忆 ✓";
    tokenHint.textContent = formatTokenHint(activeRecord?.tokenEstimate);

    if (skipExpandedRerender || !card.classList.contains("expanded")) return;

    const nextSubGraph = activeGraph
      ? buildRecallSubGraph(activeGraph, activeRecord?.selectedNodeIds || [])
      : { nodes: [], edges: [] };
    const nextSignature = buildExpandedRenderSignature({
      record: activeRecord,
      userMessageText: activeUserMessageText,
      selectedNodeIds: activeRecord?.selectedNodeIds || [],
      subGraph: nextSubGraph,
    });
    if (nextSignature === expandedRenderSignature) return;

    destroyRenderer();
    buildExpandedContent(nextSubGraph, nextSignature);
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
        userText.textContent = activeUserMessageText || "(empty)";
      }
      setUserInputEditMode(false);
    }
  });

  // 点击召回条 toggle 展开/折叠
  bar.addEventListener("click", (e) => {
    e.stopPropagation();
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
  });

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

  if (typeof cardElement._bmeUpdateRecallCard === "function") {
    cardElement._bmeUpdateRecallCard({
      record,
      userMessageText: options?.userMessageText,
      userInputDisplayMode: options?.userInputDisplayMode,
      graph: options?.graph,
      callbacks: options?.callbacks,
    });
    return;
  }

  cardElement.dataset.updatedAt = String(record.updatedAt || "");
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
    button.textContent = "确认删除？";
    button.classList.add("danger");
    confirmTimer = setTimeout(reset, DELETE_CONFIRM_TIMEOUT_MS);
  });
}

// ==================== Loading 状态 ====================

export function setRecallButtonLoading(button, loading) {
  if (loading) {
    button._bmeOriginalHTML = button.innerHTML;
    button.innerHTML =
      '<span class="bme-recall-btn-icon" style="display:inline-block">⟳</span> 召回中...';
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
    mode === "edit" ? "📝 编辑召回注入" : "🔍 节点详情";
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
      ["类型", node.type || node.raw?.type || "-"],
      ["名称", node.name || node.raw?.name || "-"],
      ["重要度", String(node.importance ?? node.raw?.importance ?? "-")],
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
        const edgeLabel = el("span", "bme-recall-sidebar-node-info-label", "关联");
        const edgeValue = el("span", "", `${relatedEdges.length} 条边`);
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
    mode === "edit" ? "注入文本（可编辑）" : "注入文本",
  );
  body.appendChild(sectionLabel);

  let textarea = null;
  const injectionText = record?.injectionText || "";

  if (mode === "edit") {
    textarea = document.createElement("textarea");
    textarea.className = "bme-recall-sidebar-textarea";
    textarea.value = injectionText;
    textarea.placeholder = "输入注入文本...";
    body.appendChild(textarea);

    const tokenHint = el("div", "bme-recall-sidebar-token-hint");
    const updateTokenHint = () => {
      const count =
        typeof callbacks.estimateTokens === "function"
          ? callbacks.estimateTokens(textarea.value)
          : textarea.value.length;
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
    const readonlyEl = el("div", "bme-recall-sidebar-readonly", injectionText || "(empty)");
    body.appendChild(readonlyEl);
  }

  sidebarElement.appendChild(body);

  // Footer
  const footer = el("div", "bme-recall-sidebar-footer");

  if (mode === "edit") {
    const saveBtn = el("button", "bme-recall-sidebar-btn primary", "保存");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => {
      const newText = textarea?.value || "";
      callbacks.onSave?.(messageIndex, newText);
      closeRecallSidebar();
    });
    footer.appendChild(saveBtn);

    const cancelBtn = el("button", "bme-recall-sidebar-btn secondary", "取消");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => closeRecallSidebar());
    footer.appendChild(cancelBtn);
  } else {
    // View mode: offer edit button
    const editBtn = el("button", "bme-recall-sidebar-btn primary", "✏️ 编辑");
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

    const closeFooterBtn = el("button", "bme-recall-sidebar-btn secondary", "关闭");
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
