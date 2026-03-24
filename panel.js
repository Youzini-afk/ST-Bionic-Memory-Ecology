// ST-BME: 操控面板交互逻辑

import { renderTemplateAsync } from "../../../templates.js";
import { GraphRenderer } from "./graph-renderer.js";
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
        '      "fields": {"summary": "...", "participants": "...", "status": "ongoing"},',
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
        "- summary 应该是摘要抽象，不要复制原文",
    ].join("\n"),

    recall: [
        "你是一个记忆召回分析器。",
        "根据用户最新输入和对话上下文，从候选记忆节点中选择最相关的节点。",
        "优先选择：(1) 直接相关的当前场景节点, (2) 因果关系连续性节点, (3) 有潜在影响的背景节点。",
        "输出严格的 JSON 格式：",
        '{"selected_ids": ["id1", "id2", ...], "reason": "简要说明选择理由"}',
    ].join("\n"),

    evolution: [
        "你是一个记忆进化分析器。当新的记忆加入知识图谱时，你需要分析它与现有记忆的关系。",
        "",
        "你的任务：",
        "1. 判断新记忆是否揭示了与旧记忆相关的新信息",
        "2. 如果是，决定如何更新旧记忆的描述和分类",
        "3. 建立新旧记忆之间的有意义连接",
        "",
        "输出严格 JSON：",
        "{",
        '  "should_evolve": true/false,',
        '  "reason": "进化理由",',
        '  "suggested_connections": ["旧记忆ID"],',
        '  "neighbor_updates": [',
        '    {"nodeId": "旧节点ID", "newContext": "修正描述", "newTags": ["标签"]}',
        "  ]",
        "}",
        "",
        "进化规则：",
        "- 仅当新信息确实改变了对旧记忆的理解时才触发进化",
        "- 例如：揭露卧底身份 → 修正该角色之前事件中的动机描述",
        "- 不要对无关记忆强行建立联系",
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

let panelEl = null;
let overlayEl = null;
let graphRenderer = null;
let mobileGraphRenderer = null;
let currentTabId = "dashboard";
let currentConfigSectionId = "api";
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
    const templatePath = new URL(`./${templateName}.html`, import.meta.url).pathname;
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
            throw new Error("Panel template rendered but required DOM nodes were not found");
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
    const fragRate = totalNodes > 0 ? Math.round((archivedCount / totalNodes) * 100) : 0;

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
            ? `${recovery.status} · from ${recovery.fromFloor ?? "—"} · ${recovery.reason || "—"}`
            : "暂无恢复记录",
    );
    _setText(
        "bme-status-last-extract",
        extractionStatus.meta || "尚未执行提取",
    );
    _setText(
        "bme-status-last-vector",
        vectorStatus.meta || "尚未执行向量任务",
    );
    _setText(
        "bme-status-last-recall",
        recallStatus.meta || "尚未执行召回",
    );

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

    const query = String(searchInput?.value || "").trim().toLowerCase();
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
        items.push({ label: "序列范围", value: `${raw.seqRange[0]} ~ ${raw.seqRange[1]}` });
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
    document.getElementById("bme-panel-close")?.addEventListener("click", closePanel);
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

    for (const [elementId, actionKey] of Object.entries(bindings)) {
        document.getElementById(elementId)?.addEventListener("click", async () => {
            const handler = _actionHandlers[actionKey];
            if (!handler) return;

            try {
                await handler();
                _refreshDashboard();
                _refreshGraph();
                if (document.getElementById("bme-pane-memory")?.classList.contains("active")) {
                    _refreshMemoryBrowser();
                }
                if (document.getElementById("bme-pane-injection")?.classList.contains("active")) {
                    await _refreshInjectionPreview();
                }
            } catch (error) {
                console.error(`[ST-BME] Action ${actionKey} failed:`, error);
                toastr.error(`操作失败: ${error?.message || error}`);
            }
        });
    }

    document.getElementById("bme-act-vector-range")?.addEventListener("click", async () => {
        try {
            const start = _parseOptionalInt(document.getElementById("bme-range-start")?.value);
            const end = _parseOptionalInt(document.getElementById("bme-range-end")?.value);
            await _actionHandlers.rebuildVectorRange?.(
                Number.isFinite(start) && Number.isFinite(end)
                    ? { start, end }
                    : null,
            );
            _refreshDashboard();
            _refreshGraph();
        } catch (error) {
            console.error("[ST-BME] Action rebuildVectorRange failed:", error);
            toastr.error(`操作失败: ${error?.message || error}`);
        }
    });
}

function _refreshConfigTab() {
    const settings = _getSettings?.() || {};

    _setCheckboxValue("bme-setting-enabled", settings.enabled ?? false);
    _setCheckboxValue("bme-setting-recall-enabled", settings.recallEnabled ?? true);
    _setCheckboxValue("bme-setting-recall-llm", settings.recallEnableLLM ?? true);
    _setCheckboxValue(
        "bme-setting-recall-vector-prefilter-enabled",
        settings.recallEnableVectorPrefilter ?? true,
    );
    _setCheckboxValue(
        "bme-setting-recall-graph-diffusion-enabled",
        settings.recallEnableGraphDiffusion ?? true,
    );
    _setCheckboxValue("bme-setting-evolution-enabled", settings.enableEvolution ?? true);
    _setCheckboxValue(
        "bme-setting-precise-conflict-enabled",
        settings.enablePreciseConflict ?? true,
    );
    _setCheckboxValue("bme-setting-synopsis-enabled", settings.enableSynopsis ?? true);
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
        "bme-setting-evo-neighbor-count",
        settings.evoNeighborCount ?? 5,
    );
    _setInputValue(
        "bme-setting-evo-consolidate-every",
        settings.evoConsolidateEvery ?? 50,
    );
    _setInputValue(
        "bme-setting-conflict-threshold",
        settings.conflictThreshold ?? 0.85,
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
        settings.embeddingBackendModel || getSuggestedBackendModel(settings.embeddingBackendSource || "openai"),
    );
    _setInputValue(
        "bme-setting-embed-backend-url",
        settings.embeddingBackendApiUrl || "",
    );
    _setCheckboxValue(
        "bme-setting-embed-auto-suffix",
        settings.embeddingAutoSuffix !== false,
    );

    _setInputValue("bme-setting-extract-prompt", settings.extractPrompt || DEFAULT_PROMPTS.extract);
    _setInputValue("bme-setting-recall-prompt", settings.recallPrompt || DEFAULT_PROMPTS.recall);
    _setInputValue("bme-setting-evolution-prompt", settings.evolutionPrompt || DEFAULT_PROMPTS.evolution);
    _setInputValue("bme-setting-compress-prompt", settings.compressPrompt || DEFAULT_PROMPTS.compress);
    _setInputValue("bme-setting-synopsis-prompt", settings.synopsisPrompt || DEFAULT_PROMPTS.synopsis);
    _setInputValue("bme-setting-reflection-prompt", settings.reflectionPrompt || DEFAULT_PROMPTS.reflection);

    _refreshFetchedModelSelects(settings);
    _refreshGuardedConfigStates(settings);
    _refreshStageCardStates(settings);
    _refreshPromptCardStates(settings);
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
    bindCheckbox("bme-setting-evolution-enabled", (checked) => {
        _patchSettings({ enableEvolution: checked });
        _refreshGuardedConfigStates();
    });
    bindCheckbox("bme-setting-precise-conflict-enabled", (checked) => {
        _patchSettings({ enablePreciseConflict: checked });
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
    bindNumber("bme-setting-evo-neighbor-count", 5, 1, 20, (value) =>
        _patchSettings({ evoNeighborCount: value }),
    );
    bindNumber("bme-setting-evo-consolidate-every", 50, 1, 500, (value) =>
        _patchSettings({ evoConsolidateEvery: value }),
    );
    bindFloat("bme-setting-conflict-threshold", 0.85, 0.5, 0.99, (value) =>
        _patchSettings({ conflictThreshold: value }),
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

    bindPromptText(
        "bme-setting-extract-prompt",
        "extractPrompt",
        "extract",
    );
    bindPromptText(
        "bme-setting-recall-prompt",
        "recallPrompt",
        "recall",
    );
    bindPromptText(
        "bme-setting-evolution-prompt",
        "evolutionPrompt",
        "evolution",
    );
    bindPromptText(
        "bme-setting-compress-prompt",
        "compressPrompt",
        "compress",
    );
    bindPromptText(
        "bme-setting-synopsis-prompt",
        "synopsisPrompt",
        "synopsis",
    );
    bindPromptText(
        "bme-setting-reflection-prompt",
        "reflectionPrompt",
        "reflection",
    );

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

    document.getElementById("bme-test-llm")?.addEventListener("click", async () => {
        await _actionHandlers.testMemoryLLM?.();
    });
    document.getElementById("bme-test-embedding")?.addEventListener("click", async () => {
        await _actionHandlers.testEmbedding?.();
    });
    document.getElementById("bme-fetch-llm-models")?.addEventListener("click", async () => {
        const result = await _actionHandlers.fetchMemoryLLMModels?.();
        if (!result?.success) return;
        fetchedMemoryLLMModels = result.models || [];
        _renderFetchedModelOptions(
            "bme-select-llm-model",
            fetchedMemoryLLMModels,
            (_getSettings?.() || {}).llmModel || "",
        );
    });
    document.getElementById("bme-fetch-embed-backend-models")?.addEventListener("click", async () => {
        const result = await _actionHandlers.fetchEmbeddingModels?.("backend");
        if (!result?.success) return;
        fetchedBackendEmbeddingModels = result.models || [];
        _renderFetchedModelOptions(
            "bme-select-embed-backend-model",
            fetchedBackendEmbeddingModels,
            (_getSettings?.() || {}).embeddingBackendModel || "",
        );
    });
    document.getElementById("bme-fetch-embed-direct-models")?.addEventListener("click", async () => {
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
    if (options.refreshTheme) _highlightThemeChoice(settings.panelTheme || "crimson");
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
        card.querySelectorAll("input, select, textarea, button").forEach((element) => {
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
                ? settings.recallEnableLLM ?? true
                : toggle
                  ? Boolean(toggle.checked)
                  : true;

        card.classList.toggle("stage-disabled", !cardDisabled && !stageEnabled);
        card.querySelectorAll(".bme-stage-param").forEach((section) => {
            section.querySelectorAll("input, select, textarea, button").forEach((element) => {
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

function getNodeDisplayName(node) {
    return (
        node?.fields?.name ||
        node?.fields?.title ||
        node?.fields?.summary ||
        node?.fields?.insight ||
        node?.id?.slice(0, 8) ||
        "—"
    );
}

function _isMobile() {
    return window.innerWidth <= 768;
}
