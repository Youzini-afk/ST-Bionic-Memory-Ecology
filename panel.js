// ST-BME: 操控面板交互逻辑

import { renderExtensionTemplateAsync } from '../../extensions.js';
import { GraphRenderer } from './graph-renderer.js';
import { getNodeColors } from './themes.js';

let panelEl = null;
let overlayEl = null;
let graphRenderer = null;
let mobileGraphRenderer = null;
let isOpen = false;

// 由 index.js 注入的引用
let _getGraph = null;
let _getSettings = null;
let _getLastExtract = null;
let _getLastRecall = null;
let _actionHandlers = {};

/**
 * 初始化面板（由 index.js 调用一次）
 */
export async function initPanel({ getGraph, getSettings, getLastExtract, getLastRecall, actions }) {
    _getGraph = getGraph;
    _getSettings = getSettings;
    _getLastExtract = getLastExtract;
    _getLastRecall = getLastRecall;
    _actionHandlers = actions || {};

    // 加载 HTML 模板
    const html = await renderExtensionTemplateAsync('third-party/st-bme', 'panel');
    $('body').append(html);

    overlayEl = document.getElementById('st-bme-panel-overlay');
    panelEl = document.getElementById('st-bme-panel');

    _bindTabs();
    _bindClose();
    _bindGraphControls();
    _bindActions();
}

/**
 * 打开面板
 */
export function openPanel() {
    if (!overlayEl) return;
    overlayEl.classList.add('active');
    isOpen = true;

    const isMobile = _isMobile();

    // 初始化桌面端图谱渲染器
    const canvas = document.getElementById('bme-graph-canvas');
    if (canvas && !graphRenderer && !isMobile) {
        const settings = _getSettings?.() || {};
        graphRenderer = new GraphRenderer(canvas, settings.panelTheme || 'crimson');
        graphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
    }

    // 初始化移动端 mini 图谱渲染器
    const mobileCanvas = document.getElementById('bme-mobile-graph-canvas');
    if (mobileCanvas && !mobileGraphRenderer && isMobile) {
        const settings = _getSettings?.() || {};
        mobileGraphRenderer = new GraphRenderer(mobileCanvas, settings.panelTheme || 'crimson');
        mobileGraphRenderer.onNodeSelect = (node) => _showNodeDetail(node);
    }

    _refreshDashboard();
    _refreshGraph();
    _buildLegend();
}

/**
 * 关闭面板
 */
export function closePanel() {
    if (!overlayEl) return;
    overlayEl.classList.remove('active');
    isOpen = false;
}

/**
 * 更新主题
 */
export function updatePanelTheme(themeName) {
    if (graphRenderer) graphRenderer.setTheme(themeName);
    if (mobileGraphRenderer) mobileGraphRenderer.setTheme(themeName);
}

// ==================== Tab 切换 ====================

function _bindTabs() {
    // 桌面端 sidebar tabs + 手机端 bottom tabs
    document.querySelectorAll('.bme-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            _switchTab(tabId);
        });
    });
}

function _switchTab(tabId) {
    // 更新所有 tab 按钮状态
    document.querySelectorAll('.bme-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tabId);
    });

    // 更新 pane 显示
    document.querySelectorAll('.bme-tab-pane').forEach(p => {
        p.classList.toggle('active', p.id === `bme-pane-${tabId}`);
    });

    // 按需刷新内容
    switch (tabId) {
        case 'dashboard': _refreshDashboard(); break;
        case 'memory':    _refreshMemoryBrowser(); break;
        case 'injection': _refreshInjectionPreview(); break;
    }
}

// ==================== 总览 Tab ====================

function _refreshDashboard() {
    const graph = _getGraph?.();
    if (!graph) return;

    const activeNodes = graph.nodes.filter(n => !n.archived);
    const archived = graph.nodes.filter(n => n.archived).length;
    const total = graph.nodes.length;
    const fragRate = total > 0 ? Math.round((archived / total) * 100) : 0;

    _setText('bme-stat-nodes', activeNodes.length);
    _setText('bme-stat-edges', graph.edges.length);
    _setText('bme-stat-archived', archived);
    _setText('bme-stat-frag', fragRate + '%');
    _setText('bme-status-meta', `NODES: ${activeNodes.length} | EDGES: ${graph.edges.length}`);

    // 最近提取
    const extractList = document.getElementById('bme-recent-extract');
    if (extractList) {
        const items = _getLastExtract?.() || [];
        extractList.innerHTML = items.length ? items.map(item =>
            `<li class="bme-recent-item">
                <span class="bme-type-badge ${item.type}">${_typeLabel(item.type)}</span>
                <div>
                    <div class="bme-recent-text">${_escHtml(item.name || item.content?.name || '—')}</div>
                    <div class="bme-recent-meta">${item.time || ''}</div>
                </div>
            </li>`
        ).join('') : '<li class="bme-recent-item"><div class="bme-recent-text" style="color:var(--bme-on-surface-dim)">暂无数据</div></li>';
    }

    // 最近召回
    const recallList = document.getElementById('bme-recent-recall');
    if (recallList) {
        const items = _getLastRecall?.() || [];
        recallList.innerHTML = items.length ? items.map(item =>
            `<li class="bme-recent-item">
                <span class="bme-type-badge ${item.type}">${_typeLabel(item.type)}</span>
                <div>
                    <div class="bme-recent-text">${_escHtml(item.name || '—')}</div>
                    <div class="bme-recent-meta">score: ${(item.score || 0).toFixed(2)}</div>
                </div>
            </li>`
        ).join('') : '<li class="bme-recent-item"><div class="bme-recent-text" style="color:var(--bme-on-surface-dim)">暂无数据</div></li>';
    }
}

// ==================== 记忆浏览器 ====================

function _refreshMemoryBrowser() {
    const graph = _getGraph?.();
    if (!graph) return;

    const searchInput = document.getElementById('bme-memory-search');
    const filterSelect = document.getElementById('bme-memory-filter');
    const listEl = document.getElementById('bme-memory-list');
    if (!listEl) return;

    const query = (searchInput?.value || '').toLowerCase();
    const filter = filterSelect?.value || 'all';

    let nodes = graph.nodes.filter(n => !n.archived);
    if (filter !== 'all') {
        nodes = nodes.filter(n => n.type === filter);
    }
    if (query) {
        nodes = nodes.filter(n => {
            const name = (n.content?.name || n.content?.title || '').toLowerCase();
            const text = JSON.stringify(n.content || {}).toLowerCase();
            return name.includes(query) || text.includes(query);
        });
    }

    // 按 importance 降序
    nodes.sort((a, b) => (b.importance || 5) - (a.importance || 5));

    listEl.innerHTML = nodes.slice(0, 100).map(n => {
        const name = n.content?.name || n.content?.title || n.id.slice(0, 8);
        const snippet = _getNodeSnippet(n);
        return `<li class="bme-memory-item" data-node-id="${n.id}">
            <span class="bme-type-badge ${n.type}">${_typeLabel(n.type)}</span>
            <div>
                <div class="bme-memory-name">${_escHtml(name)}</div>
                <div class="bme-memory-content">${_escHtml(snippet)}</div>
                <div class="bme-memory-meta">
                    <span>imp: ${n.importance || 5}</span>
                    <span>acc: ${n.accessCount || 0}</span>
                    <span>seq: ${n.seq || 0}</span>
                </div>
            </div>
        </li>`;
    }).join('');

    // 点击事件
    listEl.querySelectorAll('.bme-memory-item').forEach(el => {
        el.addEventListener('click', () => {
            const nodeId = el.dataset.nodeId;
            if (graphRenderer) graphRenderer.highlightNode(nodeId);
            const node = graph.nodes.find(n => n.id === nodeId);
            if (node) _showNodeDetail({ raw: node, type: node.type, name: node.content?.name || '' });
        });
    });

    // 搜索绑定（防抖）
    if (!searchInput._bmeBound) {
        let timer;
        searchInput.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => _refreshMemoryBrowser(), 200);
        });
        filterSelect?.addEventListener('change', () => _refreshMemoryBrowser());
        searchInput._bmeBound = true;
    }
}

// ==================== 注入预览 ====================

async function _refreshInjectionPreview() {
    const graph = _getGraph?.();
    const settings = _getSettings?.();
    if (!graph || !settings) return;

    const container = document.getElementById('bme-injection-content');
    const tokenEl = document.getElementById('bme-injection-tokens');
    if (!container) return;

    try {
        // 动态导入注入器模块
        const { estimateTokens, formatInjection } = await import('./injector.js');
        const injection = formatInjection(graph, settings.nodeSchema || []);
        const totalTokens = estimateTokens(injection);

        container.innerHTML = `<div class="bme-injection-preview">${_escHtml(injection)}</div>`;
        if (tokenEl) tokenEl.textContent = `≈ ${totalTokens} tokens`;
    } catch (e) {
        container.innerHTML = `<div class="bme-injection-preview" style="color:var(--bme-accent3)">预览生成失败: ${_escHtml(e.message)}</div>`;
    }
}

// ==================== 图谱 ====================

function _refreshGraph() {
    const graph = _getGraph?.();
    if (!graph) return;
    if (graphRenderer) graphRenderer.loadGraph(graph);
    if (mobileGraphRenderer) mobileGraphRenderer.loadGraph(graph);
}

function _buildLegend() {
    const legendEl = document.getElementById('bme-graph-legend');
    if (!legendEl) return;

    const settings = _getSettings?.() || {};
    const colors = getNodeColors(settings.panelTheme || 'crimson');
    const types = [
        { key: 'character', label: '角色' },
        { key: 'event',     label: '事件' },
        { key: 'location',  label: '地点' },
        { key: 'thread',    label: '线索' },
        { key: 'rule',      label: '规则' },
        { key: 'synopsis',  label: '概要' },
    ];

    legendEl.innerHTML = types.map(t =>
        `<span class="bme-legend-item">
            <span class="bme-legend-dot" style="background:${colors[t.key]}"></span>
            ${t.label}
        </span>`
    ).join('');
}

function _bindGraphControls() {
    document.getElementById('bme-graph-zoom-in')?.addEventListener('click', () => graphRenderer?.zoomIn());
    document.getElementById('bme-graph-zoom-out')?.addEventListener('click', () => graphRenderer?.zoomOut());
    document.getElementById('bme-graph-reset')?.addEventListener('click', () => graphRenderer?.resetView());
}

// ==================== 节点详情 ====================

function _showNodeDetail(node) {
    const detailEl = document.getElementById('bme-node-detail');
    const titleEl = document.getElementById('bme-detail-title');
    const bodyEl = document.getElementById('bme-detail-body');
    if (!detailEl || !titleEl || !bodyEl) return;

    const raw = node.raw || node;
    const name = raw.content?.name || raw.content?.title || raw.id?.slice(0, 8) || '—';
    titleEl.textContent = name;

    const fields = [
        { label: '类型', value: _typeLabel(raw.type) },
        { label: 'ID', value: raw.id?.slice(0, 12) + '...' },
        { label: '重要度', value: raw.importance || 5 },
        { label: '访问次数', value: raw.accessCount || 0 },
        { label: '序列号', value: raw.seq || 0 },
    ];

    // 展示 content 字段
    if (raw.content) {
        for (const [k, v] of Object.entries(raw.content)) {
            if (k === 'embedding') continue;
            fields.push({ label: k, value: typeof v === 'object' ? JSON.stringify(v, null, 2) : v });
        }
    }

    bodyEl.innerHTML = fields.map(f =>
        `<div class="bme-node-detail-field">
            <label>${_escHtml(f.label)}</label>
            <div class="value">${_escHtml(String(f.value))}</div>
        </div>`
    ).join('');

    detailEl.classList.add('open');
}

function _bindClose() {
    document.getElementById('bme-panel-close')?.addEventListener('click', closePanel);
    document.getElementById('bme-detail-close')?.addEventListener('click', () => {
        document.getElementById('bme-node-detail')?.classList.remove('open');
    });
    // 点击遮罩关闭
    overlayEl?.addEventListener('click', (e) => {
        if (e.target === overlayEl) closePanel();
    });
}

// ==================== 操作绑定 ====================

function _bindActions() {
    const bindings = {
        'bme-act-extract':  'extract',
        'bme-act-compress': 'compress',
        'bme-act-sleep':    'sleep',
        'bme-act-synopsis': 'synopsis',
        'bme-act-export':   'export',
        'bme-act-import':   'import',
        'bme-act-rebuild':  'rebuild',
        'bme-act-evolve':   'evolve',
    };

    for (const [elId, actionKey] of Object.entries(bindings)) {
        document.getElementById(elId)?.addEventListener('click', async () => {
            const handler = _actionHandlers[actionKey];
            if (handler) {
                try {
                    await handler();
                    // 刷新面板
                    _refreshDashboard();
                    _refreshGraph();
                } catch (e) {
                    console.error(`[ST-BME] Action ${actionKey} failed:`, e);
                }
            }
        });
    }
}

// ==================== 工具函数 ====================

function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
}

function _escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function _typeLabel(type) {
    const map = {
        character: '角色', event: '事件', location: '地点',
        thread: '线索', rule: '规则', synopsis: '概要', reflection: '反思',
    };
    return map[type] || type || '—';
}

function _getNodeSnippet(node) {
    const c = node.content || {};
    if (c.description) return c.description;
    if (c.summary) return c.summary;
    if (c.what) return c.what;
    const entries = Object.entries(c).filter(([k]) => k !== 'name' && k !== 'title' && k !== 'embedding');
    if (entries.length) {
        return entries.slice(0, 2).map(([k, v]) => `${k}: ${v}`).join('; ');
    }
    return '';
}

function _isMobile() {
    return window.innerWidth <= 768;
}
