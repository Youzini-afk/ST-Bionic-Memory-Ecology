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


// 由 index.js 注入的引用
let _getGraph = null;
let _getSettings = null;
let _getLastExtract = null;
let _getLastRecall = null;
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
    getLastInjection,
    updateSettings,
    actions,
}) {
    _getGraph = getGraph;
    _getSettings = getSettings;
    _getLastExtract = getLastExtract;
    _getLastRecall = getLastRecall;
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
    _bindGraphControls();
    _bindActions();
    _bindConfigControls();
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

    _refreshDashboard();
    _refreshGraph();
    _buildLegend();
    _refreshConfigTab();
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
    panelEl?.querySelectorAll(".bme-tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabId);
    });

    panelEl?.querySelectorAll(".bme-tab-pane").forEach((pane) => {
        pane.classList.toggle("active", pane.id === `bme-pane-${tabId}`);
    });

    switch (tabId) {
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
    _setText(
        "bme-status-meta",
        `NODES: ${activeNodes.length} | EDGES: ${graph.edges.length}`,
    );

    const chatId = graph?.historyState?.chatId || "—";
    const lastProcessed = graph?.historyState?.lastProcessedAssistantFloor ?? -1;
    const dirtyFrom = graph?.historyState?.historyDirtyFrom;
    const vectorStats = getVectorIndexStats(graph);
    const vectorMode = graph?.vectorIndexState?.mode || "—";
    const vectorSource = graph?.vectorIndexState?.source || "—";
    const recovery = graph?.historyState?.lastRecoveryResult;

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
        }
    });
}

function _refreshConfigTab() {
    const settings = _getSettings?.() || {};

    _setCheckboxValue("bme-setting-enabled", settings.enabled ?? false);
    _setCheckboxValue("bme-setting-recall-enabled", settings.recallEnabled ?? true);
    _setInputValue("bme-setting-extract-every", settings.extractEvery ?? 1);
    _setInputValue(
        "bme-setting-extract-context-turns",
        settings.extractContextTurns ?? 2,
    );
    _setInputValue("bme-setting-inject-depth", settings.injectDepth ?? 4);

    _setInputValue("bme-setting-llm-url", settings.llmApiUrl || "");
    _setInputValue("bme-setting-llm-key", settings.llmApiKey || "");
    _setInputValue("bme-setting-llm-model", settings.llmModel || "");
    _setCheckboxValue("bme-setting-recall-llm", settings.recallEnableLLM ?? true);
    _setInputValue("bme-setting-recall-max-nodes", settings.recallMaxNodes ?? 8);

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
    // 主题调色盘高亮
    _highlightThemeDot(settings.panelTheme || "crimson");
}

function _bindConfigControls() {
    if (!panelEl || panelEl.dataset.bmeConfigBound === "true") return;

    bindCheckbox("bme-setting-enabled", (checked) =>
        _updateSettings?.({ enabled: checked }),
    );
    bindCheckbox("bme-setting-recall-enabled", (checked) =>
        _updateSettings?.({ recallEnabled: checked }),
    );
    bindNumber("bme-setting-extract-every", 1, 1, 50, (value) =>
        _updateSettings?.({ extractEvery: value }),
    );
    bindNumber("bme-setting-extract-context-turns", 2, 0, 20, (value) =>
        _updateSettings?.({ extractContextTurns: value }),
    );
    bindNumber("bme-setting-inject-depth", 4, 0, 9999, (value) =>
        _updateSettings?.({ injectDepth: value }),
    );

    bindText("bme-setting-llm-url", (value) =>
        _updateSettings?.({ llmApiUrl: value.trim() }),
    );
    bindText("bme-setting-llm-key", (value) =>
        _updateSettings?.({ llmApiKey: value.trim() }),
    );
    bindText("bme-setting-llm-model", (value) =>
        _updateSettings?.({ llmModel: value.trim() }),
    );
    bindCheckbox("bme-setting-recall-llm", (checked) =>
        _updateSettings?.({ recallEnableLLM: checked }),
    );
    bindNumber("bme-setting-recall-max-nodes", 8, 1, 50, (value) =>
        _updateSettings?.({ recallMaxNodes: value }),
    );

    bindText("bme-setting-embed-url", (value) =>
        _updateSettings?.({ embeddingApiUrl: value.trim() }),
    );
    bindText("bme-setting-embed-key", (value) =>
        _updateSettings?.({ embeddingApiKey: value.trim() }),
    );
    bindText("bme-setting-embed-model", (value) =>
        _updateSettings?.({ embeddingModel: value.trim() }),
    );
    bindText("bme-setting-embed-mode", (value) =>
        _updateSettings?.({ embeddingTransportMode: value }),
    );
    bindText("bme-setting-embed-backend-source", (value) => {
        const patch = { embeddingBackendSource: value };
        const settings = _getSettings?.() || {};
        const suggestedModel = getSuggestedBackendModel(value);
        if (!settings.embeddingBackendModel || settings.embeddingBackendModel === getSuggestedBackendModel(settings.embeddingBackendSource || "openai")) {
            patch.embeddingBackendModel = suggestedModel;
        }
        _updateSettings?.(patch);
        _setInputValue("bme-setting-embed-backend-model", patch.embeddingBackendModel || settings.embeddingBackendModel || "");
    });
    bindText("bme-setting-embed-backend-model", (value) =>
        _updateSettings?.({ embeddingBackendModel: value.trim() }),
    );
    bindText("bme-setting-embed-backend-url", (value) =>
        _updateSettings?.({ embeddingBackendApiUrl: value.trim() }),
    );
    bindCheckbox("bme-setting-embed-auto-suffix", (checked) =>
        _updateSettings?.({ embeddingAutoSuffix: checked }),
    );
    bindText("bme-setting-extract-prompt", (value) =>
        _updateSettings?.({ extractPrompt: value }),
    );
    bindText("bme-setting-recall-prompt", (value) =>
        _updateSettings?.({ recallPrompt: value }),
    );
    bindText("bme-setting-evolution-prompt", (value) =>
        _updateSettings?.({ evolutionPrompt: value }),
    );
    bindText("bme-setting-compress-prompt", (value) =>
        _updateSettings?.({ compressPrompt: value }),
    );
    bindText("bme-setting-synopsis-prompt", (value) =>
        _updateSettings?.({ synopsisPrompt: value }),
    );
    bindText("bme-setting-reflection-prompt", (value) =>
        _updateSettings?.({ reflectionPrompt: value }),
    );
    // 主题调色盘点击
    panelEl.querySelectorAll(".bme-theme-dot").forEach((dot) => {
        dot.addEventListener("click", () => {
            const theme = dot.dataset.theme;
            if (!theme) return;
            _updateSettings?.({ panelTheme: theme });
            _highlightThemeDot(theme);
        });
    });

    document.getElementById("bme-test-llm")?.addEventListener("click", async () => {
        await _actionHandlers.testMemoryLLM?.();
    });
    document.getElementById("bme-test-embedding")?.addEventListener("click", async () => {
        await _actionHandlers.testEmbedding?.();
    });

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

// ==================== 工具函数 ====================

function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
}

function _highlightThemeDot(themeName) {
    if (!panelEl) return;
    panelEl.querySelectorAll(".bme-theme-dot").forEach((dot) => {
        dot.classList.toggle("active", dot.dataset.theme === themeName);
    });
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
