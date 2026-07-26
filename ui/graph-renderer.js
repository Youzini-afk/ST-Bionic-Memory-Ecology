// ST-BME: Canvas 图谱渲染器 — 分区「神经视图」布局
// 零依赖：客观层 / 角色 POV / 用户 POV 分区内 Vogel 初值 + 有预算的短力导向动画

import {
    getEdgeRelationColors,
    getNodeColors,
    getScopeColors,
    getTransientHighlightColors,
    LIGHT_PANEL_THEMES,
    THEMES,
} from './themes.js';
import {
    isUsableGraphCanvasSize,
    remapPositionBetweenRects,
} from './graph-renderer-utils.js';
import { getGraphNodeLabel, getNodeDisplayName } from '../graph/node-labels.js';
import { normalizeMemoryScope } from '../graph/memory-scope.js';
import {
    aliasSetMatchesValue,
    buildUserPovAliasNormalizedSet,
} from '../runtime/user-alias-utils.js';
import {
    GraphNativeLayoutBridge,
    normalizeGraphNativeRuntimeOptions,
} from './graph-native-bridge.js';
import { t as translateUi } from '../i18n/index.js';

/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} type
 * @property {string} name
 * @property {number} importance
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {boolean} pinned
 */

const DEFAULT_LAYOUT_CONFIG = {
    minNodeRadius: 6,
    maxNodeRadius: 17,
    labelFontSize: 10,
    gridSpacing: 48,
    gridColor: 'rgba(255,255,255,0.028)',
    /** 主画布左侧客观区占比（余下为右侧 POV 列） */
    objectiveWidthRatio: 0.62,
    /** 分区内类神经布局：力导向迭代次数 */
    neuralIterations: 120,
    neuralRepulsion: 2800,
    neuralSpringK: 0.048,
    neuralDamping: 0.88,
    neuralCenterGravity: 0.014,
    /** 节点最小间距（除半径外） */
    neuralMinGap: 12,
    /** 小/中图加载后短暂继续布局，模拟 GitNexus 式自然展开，但受预算硬限制 */
    animatedLayout: true,
    layoutAnimation: true,
    layoutAnimationEnabled: true,
    layoutAnimationMaxNodes: 520,
    layoutAnimationMaxEdges: 3600,
    layoutAnimationDurationMs: 1400,
    layoutAnimationMaxFrames: 120,
    layoutAnimationIterationsPerFrame: 2,
    layoutAnimationInitialIterationRatio: 0.38,
    layoutAnimationMinInitialIterations: 8,
    layoutAnimationRestartWindowMs: 5000,
    layoutAnimationRestartMax: 2,
    layoutAnimationCooldownMs: 9000,
    galaxyLayout: true,
    cameraFocusAnimation: true,
    cameraFocusDurationMs: 360,
    cameraFocusScale: 1.35,
    hideEdgesOnMove: true,
};

const ADAPTIVE_NEURAL_LAYOUT_POLICY = Object.freeze({
    reduceIterationsNodes: 220,
    reduceIterationsEdges: 1200,
    reduceIterationsCap: 56,
    strongReduceNodes: 360,
    strongReduceEdges: 2200,
    strongReduceCap: 24,
    skipSimulationNodes: 520,
    skipSimulationEdges: 3600,
});

const MIN_USABLE_CANVAS_DIMENSION = 48;
const RUNTIME_DEBUG_STATE_KEY = '__stBmeRuntimeDebugState';

function cloneGraphLayoutDebugValue(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof globalThis.structuredClone === 'function') {
        try {
            return globalThis.structuredClone(value);
        } catch {}
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function recordGraphLayoutDebugSnapshot(snapshot = null) {
    if (!globalThis || typeof globalThis !== 'object') return;
    if (!globalThis[RUNTIME_DEBUG_STATE_KEY] || typeof globalThis[RUNTIME_DEBUG_STATE_KEY] !== 'object') {
        globalThis[RUNTIME_DEBUG_STATE_KEY] = {
            updatedAt: '',
            graphLayout: null,
        };
    }
    const state = globalThis[RUNTIME_DEBUG_STATE_KEY];
    state.graphLayout = snapshot && typeof snapshot === 'object'
        ? {
            updatedAt: new Date().toISOString(),
            ...cloneGraphLayoutDebugValue(snapshot, {}),
        }
        : null;
    state.updatedAt = new Date().toISOString();
}

/** 兼容旧版 forceConfig（召回卡片等） */
function layoutKeysFromForceConfig(fc) {
    if (!fc || typeof fc !== 'object') return {};
    const o = {};
    if (fc.minNodeRadius != null) o.minNodeRadius = fc.minNodeRadius;
    if (fc.maxNodeRadius != null) o.maxNodeRadius = fc.maxNodeRadius;
    if (fc.labelFontSize != null) o.labelFontSize = fc.labelFontSize;
    if (fc.gridSpacing != null) o.gridSpacing = fc.gridSpacing;
    if (fc.gridColor != null) o.gridColor = fc.gridColor;
    if (fc.maxIterations != null) {
        o.neuralIterations = Math.min(
            160,
            Math.max(32, Math.round(fc.maxIterations * 0.85)),
        );
    }
    return o;
}

function roundRectPath(ctx, x, y, w, h, r) {
    const W = Math.max(0, Number(w) || 0);
    const H = Math.max(0, Number(h) || 0);
    const rr = Math.max(0, Number(r) || 0);
    const radius = Math.min(rr, W / 2, H / 2);
    if (W < 1 || H < 1) {
        ctx.rect(x, y, Math.max(1, W), Math.max(1, H));
        return;
    }
    if (radius < 1e-6) {
        ctx.rect(x, y, W, H);
        return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + W, y, x + W, y + H, radius);
    ctx.arcTo(x + W, y + H, x, y + H, radius);
    ctx.arcTo(x, y + H, x, y, radius);
    ctx.arcTo(x, y, x + W, y, radius);
    ctx.closePath();
}

function colorWithAlpha(color, alpha = 1) {
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    const hex = String(color || '').trim();
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (match) {
        let body = match[1];
        if (body.length === 3) {
            body = body.split('').map((c) => c + c).join('');
        }
        const value = Number.parseInt(body, 16);
        const r = (value >> 16) & 255;
        const g = (value >> 8) & 255;
        const b = value & 255;
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    if (hex.startsWith('rgb(')) {
        return hex.replace(/^rgb\((.*)\)$/i, `rgba($1, ${a})`);
    }
    if (hex.startsWith('rgba(')) return hex;
    return `rgba(255, 255, 255, ${a})`;
}

function edgeColorForRelation(relation, relationColors = {}) {
    const key = String(relation || 'related').trim().toLowerCase();
    return relationColors[key] || relationColors.related || relationColors.updates || '#7aa7ff';
}

function createCanvasGradient(ctx, methodName, args = [], stops = [], fallback = 'rgba(0, 0, 0, 0)') {
    if (ctx && typeof ctx[methodName] === 'function') {
        try {
            const gradient = ctx[methodName](...args);
            if (gradient && typeof gradient.addColorStop === 'function') {
                for (const [offset, color] of stops) {
                    gradient.addColorStop(offset, color);
                }
                return gradient;
            }
        } catch {}
    }
    return fallback;
}

function hashId(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return h;
}

/** 与 memory-scope 中 normalizeKey 一致，用于分区键（模块内未导出故本地复制） */
function normalizeKeyForPartition(value) {
    return String(value ?? '').trim().toLowerCase();
}

function scopeMatchesHostUserAliases(scope, aliasSet) {
    if (!(aliasSet instanceof Set) || aliasSet.size === 0) return false;
    for (const field of [scope.ownerName, scope.ownerId]) {
        if (aliasSetMatchesValue(aliasSet, field)) return true;
    }
    return false;
}

function characterPovLabelFromNodes(arr) {
    if (!arr?.length) return '·';
    for (const n of arr) {
        const s = normalizeMemoryScope(n.raw?.scope);
        if (s.ownerName) return s.ownerName;
    }
    for (const n of arr) {
        const s = normalizeMemoryScope(n.raw?.scope);
        if (s.ownerId) return s.ownerId;
    }
    return '·';
}

function partitionNodesByScope(nodes, userPovAliasSet = null) {
    const objective = [];
    const userPov = [];
    const charMap = new Map();
    const aliasSet =
        userPovAliasSet instanceof Set ? userPovAliasSet : new Set();

    for (const node of nodes) {
        const scope = normalizeMemoryScope(node.raw?.scope);
        if (scope.layer !== 'pov') {
            objective.push(node);
            node.regionKey = 'objective';
            continue;
        }
        // 优先：宿主用户显示名与 ownerName/ownerId 一致时一律归用户 POV（修正提取阶段误标 character）
        if (scopeMatchesHostUserAliases(scope, aliasSet)) {
            userPov.push(node);
            node.regionKey = 'user';
            continue;
        }
        if (scope.ownerType === 'user') {
            userPov.push(node);
            node.regionKey = 'user';
            continue;
        }
        if (scope.ownerType === 'character') {
            // 与 UUID+姓名、仅姓名 等存法兼容：优先用展示名归并，避免同一角色拆成多个 POV 区
            const nameKey = normalizeKeyForPartition(scope.ownerName);
            const idKey = normalizeKeyForPartition(scope.ownerId);
            const key = nameKey || idKey || '·';
            if (!charMap.has(key)) charMap.set(key, []);
            charMap.get(key).push(node);
            node.regionKey = `char:${key}`;
            continue;
        }
        objective.push(node);
        node.regionKey = 'objective';
    }

    return { objective, userPov, charMap };
}

function countRawNodesByScope(nodes, userPovAliasSet = null) {
    const aliasSet = userPovAliasSet instanceof Set ? userPovAliasSet : new Set();
    let objectiveNodeCount = 0;
    let userPovNodeCount = 0;
    let characterPovNodeCount = 0;
    const charKeys = new Set();

    for (const node of Array.isArray(nodes) ? nodes : []) {
        const scope = normalizeMemoryScope(node?.scope);
        if (scope.layer !== 'pov') {
            objectiveNodeCount += 1;
            continue;
        }
        if (scopeMatchesHostUserAliases(scope, aliasSet) || scope.ownerType === 'user') {
            userPovNodeCount += 1;
            continue;
        }
        if (scope.ownerType === 'character') {
            characterPovNodeCount += 1;
            const nameKey = normalizeKeyForPartition(scope.ownerName);
            const idKey = normalizeKeyForPartition(scope.ownerId);
            charKeys.add(nameKey || idKey || '·');
            continue;
        }
        objectiveNodeCount += 1;
    }

    return {
        objectiveNodeCount,
        userPovNodeCount,
        characterPovNodeCount,
        characterPovPanelCount: charKeys.size,
    };
}

export class GraphRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {string|object} [options] - 主题名称字符串（向后兼容）或配置对象
     *   options.theme {string} - 主题名称
     *   options.layoutConfig {object} - 布局参数覆盖
     *   options.forceConfig {object} - 兼容旧力导向配置（仅读取节点半径、网格、局部松弛次数等）
     *   options.onNodeClick {function} - 节点点击回调
     *   options.onNodeDoubleClick {function} - 节点双击回调
     */
    constructor(canvas, options = 'crimson') {
        const isLegacy = typeof options === 'string';
        const themeName = isLegacy ? options : (options?.theme || 'crimson');
        const layoutOverride = isLegacy ? {} : (options?.layoutConfig || {});
        const fromForce = isLegacy ? {} : layoutKeysFromForceConfig(options?.forceConfig);
        const runtimeConfig = isLegacy ? {} : (options?.runtimeConfig || {});

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.nodes = [];
        this.edges = [];
        this.nodeMap = new Map();
        this.colors = getNodeColors(themeName);
        this.scopeColors = getScopeColors(themeName);
        this.edgeRelationColors = getEdgeRelationColors(themeName);
        this.transientHighlightColors = getTransientHighlightColors(themeName);
        this.themeName = themeName;
        this.config = { ...DEFAULT_LAYOUT_CONFIG, ...fromForce, ...layoutOverride };
        this.runtimeConfig = normalizeGraphNativeRuntimeOptions(runtimeConfig);
        this._userPovAliasSet = buildUserPovAliasNormalizedSet(
            isLegacy ? null : options?.userPovAliases,
        );
        this._nativeLayoutBridge = null;
        this._layoutSolveRevision = 0;
        this._layoutAnimId = null;
        this._layoutAnimationState = null;
        this._layoutAnimationCooldownUntil = 0;
        this._layoutAnimationStarts = [];
        this._lastLayoutAnimationDiagnostics = {
            enabled: false,
            status: 'idle',
            reason: 'not-started',
            frameCount: 0,
        };
        this._cameraAnimId = null;
        this._cameraAnimationState = null;
        this._edgeInteractionDimUntil = 0;
        this._edgeInteractionRestoreTimer = null;
        this._lastLayoutDiagnostics = null;
        this._lastLayoutReuseStats = { reused: 0, total: 0, ratio: 0 };
        this._lastLayoutSeedModeCounts = {
            core: 0,
            topic: 0,
            anchoredFragment: 0,
            fallbackFragment: 0,
            reused: 0,
        };

        this._regionPanels = [];
        this._lastGraph = null;
        this._lastLayoutHints = {};
        this._lastCanvasCssWidth = 0;
        this._lastCanvasCssHeight = 0;
        this._lastDevicePixelRatio = window.devicePixelRatio || 1;

        // View transform
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        // Interaction state
        this.dragNode = null;
        this.hoveredNode = null;
        this.selectedNode = null;
        this.isDragging = false;
        this.isPanning = false;
        this.lastMouse = { x: 0, y: 0 };
        this._dragStartMouse = null;
        this._pointerDownNode = null;
        /** @type {{ startX: number, startY: number, lastX: number, lastY: number, nodeCandidate: object|null, moved: boolean } | null} */
        this._touchSession = null;
        this._suppressMouseUntil = 0;

        this.animId = null;
        this._highlightAnimId = null;
        this._highlightExpiryTimer = null;
        this._transientHighlights = new Map();
        this.enabled = true;

        // Callbacks
        this.onNodeSelect = isLegacy ? null : (options?.onNodeSelect || null);
        this.onNodeClick = isLegacy ? null : (options?.onNodeClick || null);
        this.onNodeDoubleClick = isLegacy ? null : (options?.onNodeDoubleClick || null);

        this._bindEvents();
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas.parentElement);
        this._resize();
    }

    /**
     * 加载图谱数据
     * @param {object} graph - 完整的 graph state
     */
    /**
     * @param {object} graph
     * @param {{ userPovAliases?: string|string[]|object }} [layoutHints]
     */
    loadGraph(graph, layoutHints = {}) {
        const loadStartedAt = performance.now();
        const prevSelectedId = this.selectedNode?.id || null;
        const solveRevision = this._nextLayoutSolveRevision();
        const previousLayoutSeedByNodeId = this._captureLayoutSeedByNodeId();
        this._cancelLayoutAnimation('graph-load-replaced');
        this._nativeLayoutBridge?.cancelPending?.('graph-load-replaced');
        this._lastGraph = graph;
        this._lastLayoutHints = layoutHints && typeof layoutHints === 'object'
            ? { ...layoutHints }
            : {};
        const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
        const rawNodeCount = rawNodes.length;
        const rawEdgeCount = rawEdges.length;
        const diagnosticCanvasBase = {
            canvasCssWidth: Number(this._lastCanvasCssWidth || 0),
            canvasCssHeight: Number(this._lastCanvasCssHeight || 0),
            devicePixelRatio: Number(window.devicePixelRatio || 1),
            enabled: this.enabled !== false,
        };
        if (layoutHints && Object.prototype.hasOwnProperty.call(layoutHints, 'userPovAliases')) {
            this._userPovAliasSet = buildUserPovAliasNormalizedSet(
                layoutHints.userPovAliases,
            );
        }
        const activeRawNodes = rawNodes.filter(n => !n.archived);
        const activeRawNodeIds = new Set(activeRawNodes.map((node) => node?.id).filter(Boolean));
        const activeRawEdges = rawEdges.filter(e => (
            !e?.invalidAt
            && !e?.expiredAt
            && activeRawNodeIds.has(e?.fromId)
            && activeRawNodeIds.has(e?.toId)
        ));
        const rawPartitionCounts = countRawNodesByScope(activeRawNodes, this._userPovAliasSet);

        if (!this.enabled) {
            this._clearTransientHighlights({ cancelAnimation: true });
            this._setLastLayoutDiagnostics({
                mode: 'skipped',
                nodeCount: 0,
                edgeCount: 0,
                rawNodeCount,
                rawEdgeCount,
                activeNodeCount: activeRawNodes.length,
                activeEdgeCount: activeRawEdges.length,
                visibleNodeCount: 0,
                visibleEdgeCount: 0,
                archivedNodeCount: Math.max(0, rawNodeCount - activeRawNodes.length),
                skippedEdgeCount: Math.max(0, rawEdgeCount - activeRawEdges.length),
                ...rawPartitionCounts,
                prepareMs: 0,
                layoutSeedMs: 0,
                solveMs: 0,
                totalMs: Math.max(0, performance.now() - loadStartedAt),
                layoutReuseCount: 0,
                layoutReuseTotal: 0,
                layoutReuseRatio: 0,
                sampled: false,
                capped: false,
                renderOnly: true,
                at: Date.now(),
                ...diagnosticCanvasBase,
                enabled: false,
                reason: 'disabled',
            });
            return;
        }

        this.nodeMap.clear();

        const dpr = window.devicePixelRatio || 1;
        const W = this.canvas.width / dpr;
        const H = this.canvas.height / dpr;

        this.nodes = activeRawNodes.map((n) => {
            const node = {
                id: n.id,
                type: n.type || 'event',
                name: getNodeDisplayName(n),
                label: getGraphNodeLabel(n),
                importance: n.importance || 5,
                x: 0,
                y: 0,
                vx: 0,
                vy: 0,
                pinned: false,
                raw: n,
                regionKey: 'objective',
                regionRect: null,
            };
            this.nodeMap.set(n.id, node);
            return node;
        });

        this.edges = rawEdges
            .filter(e => !e.invalidAt && !e.expiredAt && this.nodeMap.has(e.fromId) && this.nodeMap.has(e.toId))
            .map(e => ({
                from: this.nodeMap.get(e.fromId),
                to: this.nodeMap.get(e.toId),
                strength: e.strength || 0.5,
                relation: e.relation || 'related',
            }));
        const prepareFinishedAt = performance.now();

        const parts = partitionNodesByScope(this.nodes, this._userPovAliasSet);
        const characterPovNodeCount = [...parts.charMap.values()]
            .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
        this._regionPanels = this._computeRegionPanels(W, H, parts);
        const layoutReuse = this._applyPreviousLayoutSeed(previousLayoutSeedByNodeId);
        this._lastLayoutSeedModeCounts = {
            core: 0,
            topic: 0,
            anchoredFragment: 0,
            fallbackFragment: 0,
            reused: Number(layoutReuse?.reused || 0),
        };
        this._layoutAllPartitions(parts);
        const layoutFinishedAt = performance.now();
        const baseLayoutDiagnostics = {
            nodeCount: this.nodes.length,
            edgeCount: this.edges.length,
            rawNodeCount,
            rawEdgeCount,
            activeNodeCount: this.nodes.length,
            activeEdgeCount: this.edges.length,
            visibleNodeCount: this.nodes.length,
            visibleEdgeCount: this.edges.length,
            archivedNodeCount: Math.max(0, rawNodeCount - this.nodes.length),
            skippedEdgeCount: Math.max(0, rawEdgeCount - this.edges.length),
            objectiveNodeCount: parts.objective.length,
            userPovNodeCount: parts.userPov.length,
            characterPovNodeCount,
            characterPovPanelCount: parts.charMap.size,
            layoutSeedModeCounts: { ...this._lastLayoutSeedModeCounts },
            sampled: false,
            capped: false,
            renderOnly: true,
            ...diagnosticCanvasBase,
        };
        const neuralPlan = this._resolveNeuralSimulationPlan();
        const shouldTryNativeLayout = this._shouldTryNativeLayout(
            this.nodes.length,
            this.edges.length,
        );
        const animationPlan = this._resolveLayoutAnimationPlan(neuralPlan, {
            shouldTryNativeLayout,
            solveRevision,
        });

        let solvePath = neuralPlan.skip ? 'skipped' : 'js-main';
        let solveMs = 0;
        let nativeSolvePromise = null;

        if (!neuralPlan.skip && neuralPlan.iterations > 0) {
            if (shouldTryNativeLayout) {
                solvePath = 'native-worker-pending';
                nativeSolvePromise = this._simulateNeuralWithNativeBridge(
                    neuralPlan.iterations,
                    solveRevision,
                    {
                        loadStartedAt,
                        prepareFinishedAt,
                        layoutFinishedAt,
                        layoutReuse,
                        baseLayoutDiagnostics,
                    },
                );
            } else {
                const solveStartedAt = performance.now();
                this._simulateNeuralWithinRegions(
                    animationPlan.shouldAnimate
                        ? animationPlan.initialIterations
                        : neuralPlan.iterations,
                );
                solveMs = Math.max(0, performance.now() - solveStartedAt);
                if (animationPlan.shouldAnimate) solvePath = 'js-main-animated';
            }
        }

        if (prevSelectedId) {
            this.selectedNode = this.nodeMap.get(prevSelectedId) || null;
        }

        this._pruneTransientHighlights(this._nowMs());

        this._cancelAnim();
        this._render();

        if (!nativeSolvePromise) {
            this._setLastLayoutDiagnostics({
                mode: solvePath,
                ...baseLayoutDiagnostics,
                prepareMs: Math.max(0, prepareFinishedAt - loadStartedAt),
                layoutSeedMs: Math.max(0, layoutFinishedAt - prepareFinishedAt),
                solveMs,
                totalMs: Math.max(0, performance.now() - loadStartedAt),
                layoutReuseCount: Number(layoutReuse?.reused || 0),
                layoutReuseTotal: Number(layoutReuse?.total || this.nodes.length || 0),
                layoutReuseRatio: Number(layoutReuse?.ratio || 0),
                layoutAnimation: animationPlan.diagnostics,
                at: Date.now(),
            });
            if (animationPlan.shouldAnimate) {
                this._startAnimatedLayout({
                    ...animationPlan,
                    loadStartedAt,
                    prepareFinishedAt,
                    layoutFinishedAt,
                    solveStartedAt: performance.now(),
                    layoutReuse,
                    baseLayoutDiagnostics,
                });
            }
            return;
        }

        nativeSolvePromise
            .then((result) => {
                if (!result) return;
                this._setLastLayoutDiagnostics({
                    ...result.diagnostics,
                    at: Date.now(),
                });
                if (result.applied && this.enabled) {
                    this._scheduleRender();
                }
            })
            .catch(() => {
                // fail-open 路径由 bridge 内部控制
            });
    }

    /**
     * 切换主题
     */
    setTheme(themeName) {
        const wasGalaxyMode = this._isGalaxyMode();
        this.themeName = themeName;
        this.colors = getNodeColors(themeName);
        this.scopeColors = getScopeColors(themeName);
        this.edgeRelationColors = getEdgeRelationColors(themeName);
        this.transientHighlightColors = getTransientHighlightColors(themeName);
        const nextGalaxyMode = this._isGalaxyMode();
        if (!this.enabled) return;
        if (wasGalaxyMode !== nextGalaxyMode && this.nodes.length > 0) {
            this._nextLayoutSolveRevision();
            this._cancelLayoutAnimation('theme-layout-mode-changed');
            this._cancelCameraAnimation('theme-layout-mode-changed');
            this._nativeLayoutBridge?.cancelPending?.('theme-layout-mode-changed');
            const dpr = window.devicePixelRatio || 1;
            const W = Math.max(1, this.canvas.width / dpr);
            const H = Math.max(1, this.canvas.height / dpr);
            this._rebuildLayoutForCurrentViewport(W, H);
        }
        this._render();
    }

    setTransientHighlights(payload = {}) {
        const wasActive = this._transientHighlights?.size > 0;
        const ttlMs = Math.max(1, Math.min(60000, Number(payload?.ttlMs) || 1800));
        const reason = String(payload?.reason || '').trim();
        const now = this._nowMs();
        const next = new Map();
        const recallIds = this._normalizeTransientHighlightIds(payload?.recallNodeIds);
        const extractedIds = this._normalizeTransientHighlightIds(payload?.extractedNodeIds);

        for (const id of extractedIds) {
            next.set(id, {
                kind: 'extracted',
                startedAt: now,
                expiresAt: now + ttlMs,
                ttlMs,
                reason,
            });
        }
        for (const id of recallIds) {
            const existing = next.get(id);
            next.set(id, {
                kind: existing ? 'mixed' : 'recall',
                startedAt: now,
                expiresAt: now + ttlMs,
                ttlMs,
                reason,
            });
        }

        this._transientHighlights = next;
        this._cancelHighlightAnimationFrame();
        this._cancelHighlightExpiryTimer();

        if (!this.enabled) {
            this._clearTransientHighlights({ cancelAnimation: true });
            return;
        }
        if (next.size > 0) {
            this._scheduleRender();
            if (this._isReducedMotion()) {
                this._scheduleReducedMotionHighlightExpiry();
            }
        } else if (wasActive) {
            this._scheduleRender();
        }
    }

    getTransientHighlightDiagnostics() {
        const now = this._nowMs();
        this._pruneTransientHighlights(now);
        if (this._transientHighlights.size <= 0) {
            this._cancelHighlightAnimationFrame();
            this._cancelHighlightExpiryTimer();
        }
        return {
            count: this._transientHighlights.size,
            activeCount: this._transientHighlights.size,
            reducedMotion: this._isReducedMotion(),
            animationScheduled: !!this._highlightAnimId,
            expiryScheduled: !!this._highlightExpiryTimer,
        };
    }

    setRuntimeConfig(runtimeConfig = {}) {
        this.runtimeConfig = normalizeGraphNativeRuntimeOptions(runtimeConfig);
        if (this._nativeLayoutBridge) {
            this._nativeLayoutBridge.updateRuntimeOptions(this.runtimeConfig);
        }
    }

    getLastLayoutDiagnostics() {
        return this._lastLayoutDiagnostics
            ? { ...this._lastLayoutDiagnostics }
            : null;
    }

    _setLastLayoutDiagnostics(diagnostics = null) {
        this._lastLayoutDiagnostics = diagnostics && typeof diagnostics === 'object'
            ? { ...diagnostics }
            : null;
        recordGraphLayoutDebugSnapshot(
            this._lastLayoutDiagnostics
                ? {
                    ...this._lastLayoutDiagnostics,
                    enabled: this.enabled !== false,
                }
                : null,
        );
    }

    /**
     * 高亮指定节点
     */
    highlightNode(nodeId) {
        this.selectedNode = this.nodeMap.get(nodeId) || null;
        if (this.selectedNode) this._focusCameraOnNode(this.selectedNode);
        else if (this.enabled) this._render();
    }

    _focusCameraOnNode(node) {
        if (!this.enabled || !node) return;
        const rect = this.canvas.getBoundingClientRect?.() || {};
        const width = Math.max(1, Number(rect.width) || Number(this.canvas.width) || 1);
        const height = Math.max(1, Number(rect.height) || Number(this.canvas.height) || 1);
        const targetScale = Math.max(
            0.2,
            Math.min(5, Math.max(this.scale, Number(this.config.cameraFocusScale) || 1.35)),
        );
        const targetOffsetX = width * 0.5 - node.x * targetScale;
        const targetOffsetY = height * 0.46 - node.y * targetScale;
        if (
            this.config.cameraFocusAnimation === false
            || this._isReducedMotion()
        ) {
            this.scale = targetScale;
            this.offsetX = targetOffsetX;
            this.offsetY = targetOffsetY;
            this._render();
            return;
        }
        this._startCameraAnimation({
            targetScale,
            targetOffsetX,
            targetOffsetY,
            durationMs: Math.max(120, Math.min(900, Number(this.config.cameraFocusDurationMs) || 360)),
            reason: 'node-focus',
        });
    }

    _returnToOverview({ animate = true } = {}) {
        if (!this.enabled) return;
        this.selectedNode = null;
        if (this.onNodeSelect) this.onNodeSelect(null);
        const targetScale = 1;
        const targetOffsetX = 0;
        const targetOffsetY = 0;
        if (
            animate === false
            || this.config.cameraFocusAnimation === false
            || this._isReducedMotion()
        ) {
            this._cancelCameraAnimation('overview-immediate');
            this.scale = targetScale;
            this.offsetX = targetOffsetX;
            this.offsetY = targetOffsetY;
            this._render();
            return;
        }
        this._startCameraAnimation({
            targetScale,
            targetOffsetX,
            targetOffsetY,
            durationMs: Math.max(120, Math.min(900, Number(this.config.cameraFocusDurationMs) || 360)),
            reason: 'overview',
        });
    }

    _startCameraAnimation({ targetScale, targetOffsetX, targetOffsetY, durationMs = 360, reason = 'camera' } = {}) {
        this._cancelCameraAnimation('replaced');
        const startedAt = this._nowMs();
        this._cameraAnimationState = {
            startedAt,
            durationMs,
            startScale: this.scale,
            startOffsetX: this.offsetX,
            startOffsetY: this.offsetY,
            targetScale,
            targetOffsetX,
            targetOffsetY,
            reason,
        };
        this._scheduleCameraAnimationFrame();
    }

    _scheduleCameraAnimationFrame() {
        if (!this.enabled || this._cameraAnimId || !this._cameraAnimationState) return;
        this._cameraAnimId = requestAnimationFrame((timestamp) => {
            this._cameraAnimId = null;
            this._tickCameraAnimation(timestamp);
        });
    }

    _tickCameraAnimation(timestamp = this._nowMs()) {
        const state = this._cameraAnimationState;
        if (!state || !this.enabled) return;
        const elapsed = Math.max(0, Number(timestamp || this._nowMs()) - state.startedAt);
        const t = Math.min(1, elapsed / Math.max(1, state.durationMs));
        const eased = 1 - Math.pow(1 - t, 3);
        const lerp = (a, b) => a + (b - a) * eased;
        this.scale = lerp(state.startScale, state.targetScale);
        this.offsetX = lerp(state.startOffsetX, state.targetOffsetX);
        this.offsetY = lerp(state.startOffsetY, state.targetOffsetY);
        this._render();
        if (t >= 1) {
            this._cameraAnimationState = null;
            return;
        }
        this._scheduleCameraAnimationFrame();
    }

    _cancelCameraAnimation(_reason = 'cancelled') {
        if (this._cameraAnimId) {
            cancelAnimationFrame(this._cameraAnimId);
            this._cameraAnimId = null;
        }
        this._cameraAnimationState = null;
    }

    _clearCanvas() {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.canvas.style.cursor = 'default';
    }

    setEnabled(enabled = true) {
        const nextEnabled = enabled !== false;
        if (this.enabled === nextEnabled) {
            if (!nextEnabled) {
                this._clearTransientHighlights({ cancelAnimation: true });
                this._cancelCameraAnimation('renderer-disabled');
                this._cancelEdgeInteractionRestoreTimer();
                this._clearCanvas();
            }
            return;
        }
        this._nextLayoutSolveRevision();
        this._nativeLayoutBridge?.cancelPending?.('graph-renderer-state-changed');
        this.enabled = nextEnabled;
        if (this._lastLayoutDiagnostics) {
            this._setLastLayoutDiagnostics(this._lastLayoutDiagnostics);
        }
        this._cancelAnim();
        this._cancelLayoutAnimation('renderer-disabled');
        this._cancelCameraAnimation('renderer-disabled');
        this._cancelEdgeInteractionRestoreTimer();
        this.dragNode = null;
        this.isDragging = false;
        this.isPanning = false;
        this._touchSession = null;
        this._dragStartMouse = null;
        this.hoveredNode = null;
        if (!nextEnabled) {
            this._clearTransientHighlights({ cancelAnimation: true });
            this.nodeMap.clear();
            this.nodes = [];
            this.edges = [];
            this._regionPanels = [];
            this._clearCanvas();
            return;
        }
        this.canvas.style.cursor = 'grab';
        if (this._lastGraph) {
            this.loadGraph(this._lastGraph, this._lastLayoutHints);
        } else {
            this._render();
        }
    }

    // ==================== 分区布局 ====================

    _isGalaxyMode() {
        return this.config?.galaxyLayout !== false;
    }

    _isDarkGalaxyMode() {
        return this._isGalaxyMode();
    }

    _computeRegionPanels(W, H, { objective, userPov, charMap }) {
        if (this._isGalaxyMode()) {
            return this._computeGalaxyRegionPanels(W, H, { objective, userPov, charMap });
        }
        const scopeColors = this.scopeColors || getScopeColors(this.themeName);
        const pad = 14;
        const gutter = 10;
        const topPad = 20;
        const hasRight = userPov.length > 0 || charMap.size > 0;
        const splitX = hasRight ? W * this.config.objectiveWidthRatio : W;

        const panels = [];

        const objectivePanel = {
            x: pad,
            y: pad + 6,
            w: Math.max(
                0,
                (hasRight ? splitX : W) - pad * 2 - (hasRight ? gutter / 2 : 0),
            ),
            h: Math.max(0, H - pad * 2 - 6),
            label: 'Objective Layer',
            labelKey: 'graph.scope.objective',
            tint: colorWithAlpha(scopeColors.objective, 0.08),
            key: 'objective',
        };
        panels.push(objectivePanel);

        const innerObjective = {
            x: objectivePanel.x + 10,
            y: objectivePanel.y + topPad,
            w: Math.max(1, objectivePanel.w - 20),
            h: Math.max(1, objectivePanel.h - topPad - 10),
        };
        for (const n of objective) n.regionRect = innerObjective;

        if (!hasRight) return panels;

        const rightX = splitX + gutter / 2;
        const rightW = Math.max(0, W - pad - rightX);
        const yBottom = H - pad;
        let yTop = pad + 6;

        const charEntries = [...charMap.entries()].sort((a, b) =>
            String(a[0]).localeCompare(String(b[0]), 'zh'),
        );
        const charCount = charEntries.length;
        const hasUserStrip = userPov.length > 0;

        if (charCount === 0 && hasUserStrip) {
            const fullH = yBottom - yTop;
            panels.push({
                x: rightX,
                y: yTop,
                w: rightW,
                h: fullH,
                label: 'User POV',
                labelKey: 'graph.scope.userPov',
                tint: colorWithAlpha(scopeColors.user, 0.08),
                key: 'user',
            });
            const innerU = {
                x: rightX + 10,
                y: yTop + topPad,
                w: Math.max(1, rightW - 20),
                h: Math.max(1, fullH - topPad - 8),
            };
            for (const n of userPov) n.regionRect = innerU;
            return panels;
        }

        const userStripH = hasUserStrip
            ? Math.max(72, Math.min(108, (yBottom - yTop) * 0.2))
            : 0;
        const charZoneBottom = yBottom - (hasUserStrip ? userStripH + 8 : 0);
        const gap = 6;
        const charZoneH = charZoneBottom - yTop;
        const slice = charCount > 0
            ? (charZoneH - gap * Math.max(0, charCount - 1)) / charCount
            : 0;

        let yc = yTop;
        for (let i = 0; i < charCount; i++) {
            const [key, arr] = charEntries[i];
            const ph = Math.max(52, slice);
            const displayName = characterPovLabelFromNodes(arr);
            panels.push({
                x: rightX,
                y: yc,
                w: rightW,
                h: ph,
                label: `Character POV · ${displayName}`,
                labelKey: 'graph.scope.characterPov',
                labelParams: { name: displayName },
                tint: colorWithAlpha(scopeColors.character, 0.08),
                key: `char:${key}`,
            });
            const inner = {
                x: rightX + 10,
                y: yc + topPad,
                w: Math.max(1, rightW - 20),
                h: Math.max(1, ph - topPad - 8),
            };
            for (const n of arr) n.regionRect = inner;
            yc += ph + gap;
        }

        if (hasUserStrip) {
            const uy = yBottom - userStripH;
            panels.push({
                x: rightX,
                y: uy,
                w: rightW,
                h: userStripH,
                label: 'User POV',
                labelKey: 'graph.scope.userPov',
                tint: colorWithAlpha(scopeColors.user, 0.08),
                key: 'user',
            });
            const innerU = {
                x: rightX + 10,
                y: uy + topPad,
                w: Math.max(1, rightW - 20),
                h: Math.max(1, userStripH - topPad - 8),
            };
            for (const n of userPov) n.regionRect = innerU;
        }

        return panels;
    }

    _computeGalaxyRegionPanels(W, H, { objective, userPov, charMap }) {
        const width = Math.max(1, Number(W) || 1);
        const height = Math.max(1, Number(H) || 1);
        const safe = Math.max(18, Math.min(width, height) * 0.05);
        const makeRect = (cx, cy, rw, rh) => ({
            x: Math.max(safe, Math.min(width - safe - rw, cx - rw / 2)),
            y: Math.max(safe, Math.min(height - safe - rh, cy - rh / 2)),
            w: Math.max(80, Math.min(width - safe * 2, rw)),
            h: Math.max(80, Math.min(height - safe * 2, rh)),
        });
        const panels = [];
        const objectiveRect = makeRect(width * 0.5, height * 0.5, width * 0.82, height * 0.78);
        panels.push({ ...objectiveRect, label: 'Objective Layer', labelKey: 'graph.scope.objective', tint: 'rgba(87, 199, 255, 0.02)', key: 'objective' });
        for (const n of objective) n.regionRect = objectiveRect;

        if (userPov.length) {
            const userRect = makeRect(width * 0.68, height * 0.68, width * 0.44, height * 0.42);
            panels.push({ ...userRect, label: 'User POV', labelKey: 'graph.scope.userPov', tint: 'rgba(125, 255, 155, 0.02)', key: 'user' });
            for (const n of userPov) n.regionRect = userRect;
        }

        const charEntries = [...charMap.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh'));
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));
        const orbit = Math.min(width, height) * 0.26;
        charEntries.forEach(([owner, nodes], index) => {
            const t = index + 1;
            const angle = t * goldenAngle;
            const radius = orbit * Math.sqrt(t / Math.max(1, charEntries.length));
            const cx = width * 0.5 + Math.cos(angle) * radius;
            const cy = height * 0.5 + Math.sin(angle) * radius * 0.78;
            const rect = makeRect(cx, cy, width * 0.34, height * 0.36);
            const key = `char:${owner || 'unknown'}`;
            const displayName = characterPovLabelFromNodes(nodes) || owner || translateUi('graph.scope.unknownCharacter');
            panels.push({ ...rect, label: `Character POV · ${displayName}`, labelKey: 'graph.scope.characterPov', labelParams: { name: displayName }, tint: 'rgba(255, 179, 71, 0.02)', key });
            for (const n of nodes) n.regionRect = rect;
        });

        return panels;
    }

    _layoutAllPartitions({ objective, userPov, charMap }) {
        const layoutAdjacencyIndex = this._buildLayoutAdjacencyIndex();
        this._seedNeuralCloudInRect(
            objective.filter((node) => node._layoutSeedReused !== true),
            objective[0]?.regionRect,
            layoutAdjacencyIndex,
        );
        if (userPov.length) {
            this._seedNeuralCloudInRect(
                userPov.filter((node) => node._layoutSeedReused !== true),
                userPov[0]?.regionRect,
                layoutAdjacencyIndex,
            );
        }
        for (const [, arr] of charMap) {
            this._seedNeuralCloudInRect(
                arr.filter((node) => node._layoutSeedReused !== true),
                arr[0]?.regionRect,
                layoutAdjacencyIndex,
            );
        }
    }

    _captureLayoutSeedByNodeId() {
        const seedByNodeId = new Map();
        for (const node of Array.isArray(this.nodes) ? this.nodes : []) {
            if (!node?.id) continue;
            if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !node.regionRect) {
                continue;
            }
            seedByNodeId.set(node.id, {
                x: node.x,
                y: node.y,
                regionKey: node.regionKey || 'objective',
                regionRect: {
                    x: node.regionRect.x,
                    y: node.regionRect.y,
                    w: node.regionRect.w,
                    h: node.regionRect.h,
                },
            });
        }
        return seedByNodeId;
    }

    _applyPreviousLayoutSeed(seedByNodeId = null) {
        let reused = 0;
        const total = Array.isArray(this.nodes) ? this.nodes.length : 0;
        for (const node of this.nodes) {
            node._layoutSeedReused = false;
            const previousSeed = seedByNodeId instanceof Map ? seedByNodeId.get(node.id) : null;
            if (!previousSeed?.regionRect || !node.regionRect) continue;
            const nextPosition = remapPositionBetweenRects(
                previousSeed.x,
                previousSeed.y,
                previousSeed.regionRect,
                node.regionRect,
            );
            if (!Number.isFinite(nextPosition?.x) || !Number.isFinite(nextPosition?.y)) {
                continue;
            }
            node.x = nextPosition.x;
            node.y = nextPosition.y;
            node.vx = 0;
            node.vy = 0;
            node._layoutSeedReused = true;
            this._clampNodeToRegion(node);
            reused += 1;
        }
        this._lastLayoutReuseStats = {
            reused,
            total,
            ratio: total > 0 ? reused / total : 0,
        };
        return this._lastLayoutReuseStats;
    }

    _rebuildLayoutForCurrentViewport(W, H) {
        const previousRectsByRegion = new Map();
        for (const node of this.nodes) {
            if (!node?.regionKey || previousRectsByRegion.has(node.regionKey) || !node.regionRect) {
                continue;
            }
            previousRectsByRegion.set(node.regionKey, {
                x: node.regionRect.x,
                y: node.regionRect.y,
                w: node.regionRect.w,
                h: node.regionRect.h,
            });
        }

        const parts = partitionNodesByScope(this.nodes, this._userPovAliasSet);
        this._regionPanels = this._computeRegionPanels(W, H, parts);

        for (const node of this.nodes) {
            const nextRect = node.regionRect;
            const previousRect = previousRectsByRegion.get(node.regionKey) || nextRect;
            const nextPosition = remapPositionBetweenRects(
                node.x,
                node.y,
                previousRect,
                nextRect,
            );
            node.x = nextPosition.x;
            node.y = nextPosition.y;
            node.vx = 0;
            node.vy = 0;
            this._clampNodeToRegion(node);
        }
    }

    _getMemoryLayoutRole(node) {
        const importance = Number(node?.importance || 0);
        const type = String(node?.type || '').trim().toLowerCase();
        const raw = node?.raw || {};
        const accessCount = Number(raw.accessCount ?? raw.recallCount ?? raw.fields?.accessCount ?? raw.fields?.recallCount);
        const kind = String(raw.fields?.kind ?? raw.kind ?? '').trim().toLowerCase();

        if (
            importance >= 9
            || ['character', 'rule', 'synopsis'].includes(type)
            || (Number.isFinite(accessCount) && accessCount >= 5)
            || /\b(core|anchor|central|main|primary)\b/.test(kind)
        ) {
            return 'core';
        }
        if (
            importance >= 6
            || ['event', 'thread', 'location', 'reflection'].includes(type)
        ) {
            return 'topic';
        }
        return 'fragment';
    }

    _buildLayoutAdjacencyIndex() {
        const adjacency = new Map();
        const add = (node, neighbor, strength) => {
            if (!node?.id || !neighbor) return;
            const key = String(node.id);
            if (!adjacency.has(key)) adjacency.set(key, []);
            adjacency.get(key).push({ neighbor, strength });
        };

        for (const edge of Array.isArray(this.edges) ? this.edges : []) {
            if (!edge?.from?.id || !edge?.to?.id) continue;
            const strength = Math.max(0, Number(edge.strength) || 0);
            add(edge.from, edge.to, strength);
            add(edge.to, edge.from, strength);
        }

        return adjacency;
    }

    _findLayoutAnchorForNode(node, adjacencyIndex = null, roleCache = null) {
        if (!node?.regionKey) return null;
        const adjacent = adjacencyIndex instanceof Map
            ? adjacencyIndex.get(String(node.id)) || []
            : [];
        let best = null;
        const resolveRole = (neighbor) => {
            const key = String(neighbor?.id || '');
            if (roleCache instanceof Map && roleCache.has(key)) return roleCache.get(key);
            const role = this._getMemoryLayoutRole(neighbor);
            if (roleCache instanceof Map && key) roleCache.set(key, role);
            return role;
        };

        for (const entry of adjacent) {
            const neighbor = entry?.neighbor || null;
            if (!neighbor || neighbor.regionKey !== node.regionKey) continue;
            if (!Number.isFinite(neighbor.x) || !Number.isFinite(neighbor.y)) continue;
            const role = resolveRole(neighbor);
            const strength = Math.max(0, Number(entry.strength) || 0);
            const roleScore = role === 'core' ? 2 : (role === 'topic' ? 1 : 0);
            const score = roleScore * 1000 + strength;
            if (!best || score > best.score) {
                best = { node: neighbor, strength, score };
            }
        }
        return best;
    }

    _markLayoutSeedMode(mode) {
        if (!this._lastLayoutSeedModeCounts || typeof this._lastLayoutSeedModeCounts !== 'object') return;
        this._lastLayoutSeedModeCounts[mode] = Number(this._lastLayoutSeedModeCounts[mode] || 0) + 1;
    }

    /**
     * 记忆星系初值：core 居中，topic 环绕，fragment 靠近已定位锚点；Deterministic，无持久写入
     */
    _seedNeuralCloudInRect(nodes, rect, adjacencyIndex = null) {
        const candidates = Array.isArray(nodes)
            ? nodes.filter((node) => node && node._layoutSeedReused !== true)
            : [];
        if (!rect || !candidates.length) return;
        const pad = Math.max(10, this.config.neuralMinGap);
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const rx = Math.max(14, rect.w / 2 - pad);
        const ry = Math.max(14, rect.h / 2 - pad);
        const golden = Math.PI * (3 - Math.sqrt(5));
        const sorted = [...candidates].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const byRole = { core: [], topic: [], fragment: [] };
        const roleCache = new Map();
        for (const node of sorted) {
            const role = this._getMemoryLayoutRole(node);
            roleCache.set(String(node.id), role);
            byRole[role].push(node);
        }

        const placeNode = (node, x, y) => {
            node.x = Number.isFinite(x) ? x : cx;
            node.y = Number.isFinite(y) ? y : cy;
            node.vx = 0;
            node.vy = 0;
            this._clampNodeToRegion(node);
        };

        byRole.core.forEach((node, i) => {
            const h = hashId(node.id);
            const theta = i * golden + ((h & 0x3ff) / 1024) * Math.PI * 2;
            const radial = Math.min(rx, ry) * (0.035 + ((h >>> 10) & 0xff) / 255 * 0.14);
            placeNode(node, cx + Math.cos(theta) * radial, cy + Math.sin(theta) * radial);
            this._markLayoutSeedMode('core');
        });

        const topicCount = Math.max(1, byRole.topic.length);
        byRole.topic.forEach((node, i) => {
            const h = hashId(node.id);
            const theta = i * golden + ((h & 0x3ff) / 1024) * 0.8;
            const band = topicCount <= 1 ? 0.42 : 0.32 + (i % 5) * 0.08;
            const jitter = (((h >>> 10) & 0xff) / 255 - 0.5) * 0.08;
            const scale = Math.max(0.22, Math.min(0.74, band + jitter));
            placeNode(node, cx + Math.cos(theta) * rx * scale, cy + Math.sin(theta) * ry * scale);
            this._markLayoutSeedMode('topic');
        });

        const fragmentCount = Math.max(1, byRole.fragment.length);
        byRole.fragment.forEach((node, i) => {
            const anchor = this._findLayoutAnchorForNode(node, adjacencyIndex, roleCache);
            const h = hashId(node.id);
            if (anchor?.node) {
                const theta = ((h >>> 1) / 0x7fffffff) * Math.PI * 2 + golden;
                const maxLocalRadius = Math.max(14, Math.min(rx, ry) * 0.38);
                const strength = Math.max(0, Math.min(1, Number(anchor.strength) || 0));
                const rawRadius = 24 + (Math.abs(h) % 28) * (1.08 - strength * 0.28);
                const radius = Math.min(maxLocalRadius, rawRadius);
                placeNode(
                    node,
                    anchor.node.x + Math.cos(theta) * radius,
                    anchor.node.y + Math.sin(theta) * radius,
                );
                this._markLayoutSeedMode('anchoredFragment');
                return;
            }

            const t = (i + 0.5) / fragmentCount;
            const radScale = Math.sqrt(t) * 0.9;
            const phase = ((h & 0x3ff) / 1024) * 0.62;
            const theta = i * golden + phase;
            placeNode(node, cx + Math.cos(theta) * radScale * rx, cy + Math.sin(theta) * radScale * ry);
            this._markLayoutSeedMode('fallbackFragment');
        });
    }

    _idealSpringLengthsByRegion() {
        const countBy = new Map();
        for (const n of this.nodes) {
            const k = n.regionKey;
            countBy.set(k, (countBy.get(k) || 0) + 1);
        }
        const ideal = new Map();
        for (const n of this.nodes) {
            if (ideal.has(n.regionKey)) continue;
            const rect = n.regionRect;
            const c = Math.max(1, countBy.get(n.regionKey) || 1);
            const area = (rect?.w || 1) * (rect?.h || 1);
            const len = Math.max(
                36,
                Math.min(92, 0.78 * Math.sqrt(area / c)),
            );
            ideal.set(n.regionKey, len);
        }
        return ideal;
    }

    _resolveNeuralSimulationPlan() {
        const nodeCount = Array.isArray(this.nodes) ? this.nodes.length : 0;
        const edgeCount = Array.isArray(this.edges) ? this.edges.length : 0;
        const reuseRatio = Math.max(0, Math.min(1, Number(this._lastLayoutReuseStats?.ratio || 0)));
        const baseIterations = Math.max(
            8,
            Math.min(220, Number(this.config.neuralIterations) || 80),
        );

        let iterations = baseIterations;
        let skip = false;

        if (
            nodeCount >= ADAPTIVE_NEURAL_LAYOUT_POLICY.skipSimulationNodes ||
            edgeCount >= ADAPTIVE_NEURAL_LAYOUT_POLICY.skipSimulationEdges
        ) {
            skip = true;
            iterations = 0;
        } else if (
            nodeCount >= ADAPTIVE_NEURAL_LAYOUT_POLICY.strongReduceNodes ||
            edgeCount >= ADAPTIVE_NEURAL_LAYOUT_POLICY.strongReduceEdges
        ) {
            iterations = Math.min(
                iterations,
                ADAPTIVE_NEURAL_LAYOUT_POLICY.strongReduceCap,
            );
        } else if (
            nodeCount >= ADAPTIVE_NEURAL_LAYOUT_POLICY.reduceIterationsNodes ||
            edgeCount >= ADAPTIVE_NEURAL_LAYOUT_POLICY.reduceIterationsEdges
        ) {
            iterations = Math.min(
                iterations,
                ADAPTIVE_NEURAL_LAYOUT_POLICY.reduceIterationsCap,
            );
        }

        if (!skip && nodeCount >= 24) {
            if (reuseRatio >= 0.9) {
                iterations = Math.min(
                    iterations,
                    Math.max(8, Math.round(baseIterations * 0.18)),
                );
            } else if (reuseRatio >= 0.65) {
                iterations = Math.min(
                    iterations,
                    Math.max(10, Math.round(baseIterations * 0.35)),
                );
            }
        }

        return {
            skip,
            iterations,
        };
    }

    _nextLayoutSolveRevision() {
        this._layoutSolveRevision = Math.max(1, Number(this._layoutSolveRevision || 0) + 1);
        return this._layoutSolveRevision;
    }

    _isLayoutAnimationConfigEnabled() {
        return !(
            this.config?.animatedLayout === false
            || this.config?.layoutAnimation === false
            || this.config?.layoutAnimationEnabled === false
            || this.runtimeConfig?.graphAnimatedLayout === false
            || this.runtimeConfig?.graphLayoutAnimation === false
            || this.runtimeConfig?.graphLayoutAnimationEnabled === false
        );
    }

    _consumeLayoutAnimationBudget(now = this._nowMs()) {
        const windowMs = Math.max(0, Number(this.config.layoutAnimationRestartWindowMs) || 5000);
        const maxStarts = Math.max(0, Math.trunc(Number(this.config.layoutAnimationRestartMax) || 2));
        const cooldownMs = Math.max(0, Number(this.config.layoutAnimationCooldownMs) || 9000);
        if (now < Number(this._layoutAnimationCooldownUntil || 0)) {
            return {
                allowed: false,
                reason: 'cooldown',
                cooldownUntil: this._layoutAnimationCooldownUntil,
            };
        }
        this._layoutAnimationStarts = (this._layoutAnimationStarts || [])
            .filter((startedAt) => now - startedAt < windowMs);
        if (this._layoutAnimationStarts.length >= maxStarts) {
            this._layoutAnimationCooldownUntil = now + cooldownMs;
            return {
                allowed: false,
                reason: 'budget-exhausted',
                cooldownUntil: this._layoutAnimationCooldownUntil,
            };
        }
        this._layoutAnimationStarts.push(now);
        return {
            allowed: true,
            reason: 'allowed',
            cooldownUntil: this._layoutAnimationCooldownUntil,
        };
    }

    _resolveLayoutAnimationPlan(neuralPlan = {}, context = {}) {
        const iterations = Math.max(0, Math.trunc(Number(neuralPlan?.iterations) || 0));
        const baseDiagnostics = {
            enabled: false,
            status: 'disabled',
            reason: 'not-evaluated',
            reducedMotion: this._isReducedMotion(),
            frameCount: 0,
            remainingIterations: 0,
            cooldownUntil: Number(this._layoutAnimationCooldownUntil || 0),
        };

        const disabled = (reason, extra = {}) => ({
            shouldAnimate: false,
            initialIterations: iterations,
            remainingIterations: 0,
            diagnostics: {
                ...baseDiagnostics,
                ...extra,
                reason,
                status: 'disabled',
            },
        });

        if (neuralPlan?.skip || iterations <= 0) return disabled('simulation-skipped');
        if (!this.enabled) return disabled('renderer-disabled');
        if (!this._isLayoutAnimationConfigEnabled()) return disabled('config-disabled');
        if (baseDiagnostics.reducedMotion) return disabled('reduced-motion');
        if (context?.shouldTryNativeLayout) return disabled('native-worker');

        const nodeCount = this.nodes.length;
        const edgeCount = this.edges.length;
        const maxNodes = Math.max(0, Number(this.config.layoutAnimationMaxNodes) || 520);
        const maxEdges = Math.max(0, Number(this.config.layoutAnimationMaxEdges) || 3600);
        if (nodeCount > maxNodes || edgeCount > maxEdges) {
            return disabled('graph-too-large', { nodeCount, edgeCount, maxNodes, maxEdges });
        }

        const ratio = Math.max(0.05, Math.min(0.95, Number(this.config.layoutAnimationInitialIterationRatio) || 0.38));
        const minInitial = Math.max(1, Math.trunc(Number(this.config.layoutAnimationMinInitialIterations) || 8));
        const initialIterations = Math.max(
            1,
            Math.min(iterations, Math.max(minInitial, Math.round(iterations * ratio))),
        );
        const remainingIterations = Math.max(0, iterations - initialIterations);
        if (remainingIterations <= 0) {
            return disabled('no-remaining-iterations', { initialIterations });
        }

        const budget = this._consumeLayoutAnimationBudget(this._nowMs());
        if (!budget.allowed) {
            return disabled(budget.reason || 'layout-budget-denied', {
                cooldownUntil: budget.cooldownUntil,
            });
        }

        const maxMs = Math.max(160, Math.min(6000, Number(this.config.layoutAnimationDurationMs) || 1400));
        const maxFrames = Math.max(1, Math.min(360, Math.trunc(Number(this.config.layoutAnimationMaxFrames) || 120)));
        const iterationsPerFrame = Math.max(1, Math.min(8, Math.trunc(Number(this.config.layoutAnimationIterationsPerFrame) || 2)));
        return {
            shouldAnimate: true,
            solveRevision: context?.solveRevision,
            initialIterations,
            remainingIterations,
            maxMs,
            maxFrames,
            iterationsPerFrame,
            diagnostics: {
                ...baseDiagnostics,
                enabled: true,
                status: 'scheduled',
                reason: 'scheduled',
                initialIterations,
                remainingIterations,
                maxMs,
                maxFrames,
                iterationsPerFrame,
                cooldownUntil: budget.cooldownUntil,
            },
        };
    }

    _ensureNativeLayoutBridge() {
        if (this._nativeLayoutBridge) {
            this._nativeLayoutBridge.updateRuntimeOptions(this.runtimeConfig);
            return this._nativeLayoutBridge;
        }
        this._nativeLayoutBridge = new GraphNativeLayoutBridge(this.runtimeConfig);
        return this._nativeLayoutBridge;
    }

    _shouldTryNativeLayout(nodeCount = 0, edgeCount = 0) {
        // Galaxy mode currently uses weak cross-region springs in the JS solver.
        // Keep native/worker disabled until payload parity supports that spring model.
        if (this._isGalaxyMode()) return false;
        if (this.runtimeConfig.graphNativeForceDisable) return false;
        if (!this.runtimeConfig.graphUseNativeLayout) return false;
        const bridge = this._ensureNativeLayoutBridge();
        if (!bridge) return false;
        return bridge.shouldRunForGraph(nodeCount, edgeCount);
    }

    _buildNativeLayoutPayload(iterations) {
        const nodeIndexById = new Map();
        const nodes = this.nodes.map((node, index) => {
            nodeIndexById.set(node.id, index);
            return {
                x: node.x,
                y: node.y,
                vx: node.vx,
                vy: node.vy,
                pinned: node.pinned === true,
                radius: this._nodeRadius(node),
                regionKey: node.regionKey,
                regionRect: node.regionRect
                    ? {
                        x: node.regionRect.x,
                        y: node.regionRect.y,
                        w: node.regionRect.w,
                        h: node.regionRect.h,
                    }
                    : null,
            };
        });

        const edges = this.edges
            .map((edge) => {
                const from = nodeIndexById.get(edge.from?.id);
                const to = nodeIndexById.get(edge.to?.id);
                if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
                    return null;
                }
                return {
                    from,
                    to,
                    strength: edge.strength || 0.5,
                };
            })
            .filter(Boolean);

        return {
            nodes,
            edges,
            config: {
                iterations,
                repulsion: this.config.neuralRepulsion ?? 2800,
                springK: this.config.neuralSpringK ?? 0.048,
                damping: this.config.neuralDamping ?? 0.88,
                centerGravity: this.config.neuralCenterGravity ?? 0.014,
                minGap: this.config.neuralMinGap ?? 12,
                speedCap: 3.8,
            },
        };
    }

    _applyLayoutPositions(positions) {
        if (!(positions instanceof Float32Array)) return false;
        if (positions.length < this.nodes.length * 2) return false;

        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            if (!node || node.pinned) continue;
            node.x = positions[i * 2];
            node.y = positions[i * 2 + 1];
            node.vx = 0;
            node.vy = 0;
            this._clampNodeToRegion(node);
        }
        return true;
    }

    async _simulateNeuralWithNativeBridge(iterations, solveRevision, timings = {}) {
        const loadStartedAt = Number(timings.loadStartedAt) || performance.now();
        const prepareFinishedAt = Number(timings.prepareFinishedAt) || loadStartedAt;
        const layoutFinishedAt = Number(timings.layoutFinishedAt) || prepareFinishedAt;
        const layoutReuse = timings.layoutReuse && typeof timings.layoutReuse === 'object'
            ? timings.layoutReuse
            : this._lastLayoutReuseStats;
        const baseLayoutDiagnostics = timings.baseLayoutDiagnostics && typeof timings.baseLayoutDiagnostics === 'object'
            ? timings.baseLayoutDiagnostics
            : {};

        const bridge = this._ensureNativeLayoutBridge();
        const solveStartedAt = performance.now();
        let nativeResult = null;

        try {
            nativeResult = await bridge.solveLayout(this._buildNativeLayoutPayload(iterations), {
                timeoutMs: this.runtimeConfig.graphNativeLayoutWorkerTimeoutMs,
            });
        } catch (error) {
            nativeResult = {
                ok: false,
                skipped: true,
                reason: 'native-layout-bridge-error',
                error: error?.message || String(error),
            };
        }

        if (solveRevision !== this._layoutSolveRevision) {
            return {
                applied: false,
                diagnostics: {
                    mode: 'native-stale',
                    ...baseLayoutDiagnostics,
                    prepareMs: Math.max(0, prepareFinishedAt - loadStartedAt),
                    layoutSeedMs: Math.max(0, layoutFinishedAt - prepareFinishedAt),
                    solveMs: Math.max(0, performance.now() - solveStartedAt),
                    totalMs: Math.max(0, performance.now() - loadStartedAt),
                    layoutReuseCount: Number(layoutReuse?.reused || 0),
                    layoutReuseTotal: Number(layoutReuse?.total || this.nodes.length || 0),
                    layoutReuseRatio: Number(layoutReuse?.ratio || 0),
                    reason: 'stale-layout-result',
                },
            };
        }

        if (nativeResult?.ok && this._applyLayoutPositions(nativeResult.positions)) {
            const workerElapsedMs = Number(nativeResult?.diagnostics?.elapsedMs);
            return {
                applied: true,
                diagnostics: {
                    mode: nativeResult.usedNative ? 'rust-wasm-worker' : 'js-worker',
                    ...baseLayoutDiagnostics,
                    prepareMs: Math.max(0, prepareFinishedAt - loadStartedAt),
                    layoutSeedMs: Math.max(0, layoutFinishedAt - prepareFinishedAt),
                    solveMs: Math.max(0, performance.now() - solveStartedAt),
                    workerSolveMs: Number.isFinite(workerElapsedMs)
                        ? Math.max(0, workerElapsedMs)
                        : 0,
                    totalMs: Math.max(0, performance.now() - loadStartedAt),
                    layoutReuseCount: Number(layoutReuse?.reused || 0),
                    layoutReuseTotal: Number(layoutReuse?.total || this.nodes.length || 0),
                    layoutReuseRatio: Number(layoutReuse?.ratio || 0),
                    reason: '',
                },
            };
        }

        if (!this.runtimeConfig.nativeEngineFailOpen) {
            return {
                applied: false,
                diagnostics: {
                    mode: 'native-failed-hard',
                    ...baseLayoutDiagnostics,
                    prepareMs: Math.max(0, prepareFinishedAt - loadStartedAt),
                    layoutSeedMs: Math.max(0, layoutFinishedAt - prepareFinishedAt),
                    solveMs: Math.max(0, performance.now() - solveStartedAt),
                    totalMs: Math.max(0, performance.now() - loadStartedAt),
                    layoutReuseCount: Number(layoutReuse?.reused || 0),
                    layoutReuseTotal: Number(layoutReuse?.total || this.nodes.length || 0),
                    layoutReuseRatio: Number(layoutReuse?.ratio || 0),
                    reason: nativeResult?.reason || 'native-layout-failed',
                },
            };
        }

        const fallbackStartedAt = performance.now();
        this._simulateNeuralWithinRegions(iterations);
        const fallbackSolveMs = Math.max(0, performance.now() - fallbackStartedAt);
        return {
            applied: true,
            diagnostics: {
                mode: 'js-fallback',
                ...baseLayoutDiagnostics,
                prepareMs: Math.max(0, prepareFinishedAt - loadStartedAt),
                layoutSeedMs: Math.max(0, layoutFinishedAt - prepareFinishedAt),
                solveMs: Math.max(0, performance.now() - solveStartedAt) + fallbackSolveMs,
                fallbackSolveMs,
                totalMs: Math.max(0, performance.now() - loadStartedAt),
                layoutReuseCount: Number(layoutReuse?.reused || 0),
                layoutReuseTotal: Number(layoutReuse?.total || this.nodes.length || 0),
                layoutReuseRatio: Number(layoutReuse?.ratio || 0),
                reason: nativeResult?.reason || 'native-layout-failed',
            },
        };
    }

    _startAnimatedLayout(plan = {}) {
        if (!plan?.shouldAnimate || !this.enabled) return false;
        this._cancelLayoutAnimation('replaced');

        const startedAt = this._nowMs();
        const state = {
            solveRevision: Number(plan.solveRevision || this._layoutSolveRevision),
            startedAt,
            remainingIterations: Math.max(0, Math.trunc(Number(plan.remainingIterations) || 0)),
            maxMs: Math.max(1, Number(plan.maxMs) || 1400),
            maxFrames: Math.max(1, Math.trunc(Number(plan.maxFrames) || 120)),
            iterationsPerFrame: Math.max(1, Math.trunc(Number(plan.iterationsPerFrame) || 2)),
            frameCount: 0,
            solveMs: 0,
            loadStartedAt: Number(plan.loadStartedAt) || startedAt,
            prepareFinishedAt: Number(plan.prepareFinishedAt) || startedAt,
            layoutFinishedAt: Number(plan.layoutFinishedAt) || startedAt,
            layoutReuse: plan.layoutReuse && typeof plan.layoutReuse === 'object'
                ? plan.layoutReuse
                : this._lastLayoutReuseStats,
            baseLayoutDiagnostics: plan.baseLayoutDiagnostics && typeof plan.baseLayoutDiagnostics === 'object'
                ? { ...plan.baseLayoutDiagnostics }
                : {},
        };
        if (state.remainingIterations <= 0) return false;

        this._layoutAnimationState = state;
        this._updateLayoutAnimationDiagnostics({ status: 'scheduled', reason: 'scheduled' });
        this._scheduleLayoutAnimationFrame();
        return true;
    }

    _scheduleLayoutAnimationFrame() {
        if (!this.enabled || this._layoutAnimId || !this._layoutAnimationState) return;
        this._layoutAnimId = requestAnimationFrame((timestamp) => {
            this._layoutAnimId = null;
            this._tickLayoutAnimation(timestamp);
        });
    }

    _tickLayoutAnimation(timestamp = this._nowMs()) {
        const state = this._layoutAnimationState;
        if (!state) return;
        if (!this.enabled || state.solveRevision !== this._layoutSolveRevision) {
            this._cancelLayoutAnimation('stale-or-disabled');
            return;
        }

        const elapsedMs = Math.max(0, Number(timestamp || this._nowMs()) - state.startedAt);
        if (elapsedMs >= state.maxMs || state.frameCount >= state.maxFrames) {
            this._finishLayoutAnimation('budget-complete');
            return;
        }

        const iterations = Math.min(state.iterationsPerFrame, state.remainingIterations);
        const frameStartedAt = performance.now();
        this._simulateNeuralWithinRegions(iterations, { minIterations: 1 });
        state.solveMs += Math.max(0, performance.now() - frameStartedAt);
        state.remainingIterations = Math.max(0, state.remainingIterations - iterations);
        state.frameCount += 1;
        this._updateLayoutAnimationDiagnostics({ status: 'running', reason: 'running' });
        this._render();

        if (state.remainingIterations <= 0) {
            this._finishLayoutAnimation('settled');
            return;
        }
        this._scheduleLayoutAnimationFrame();
    }

    _finishLayoutAnimation(reason = 'settled') {
        const state = this._layoutAnimationState;
        if (!state) return;
        this._layoutAnimationState = null;
        this._updateLayoutAnimationDiagnostics({
            status: 'idle',
            reason,
            frameCount: state.frameCount,
            remainingIterations: state.remainingIterations,
            solveMs: state.solveMs,
        });
        this._setLastLayoutDiagnostics({
            mode: 'js-main-animated',
            ...state.baseLayoutDiagnostics,
            prepareMs: Math.max(0, state.prepareFinishedAt - state.loadStartedAt),
            layoutSeedMs: Math.max(0, state.layoutFinishedAt - state.prepareFinishedAt),
            solveMs: Math.max(0, Number(this._lastLayoutDiagnostics?.solveMs || 0) + state.solveMs),
            totalMs: Math.max(0, performance.now() - state.loadStartedAt),
            layoutReuseCount: Number(state.layoutReuse?.reused || 0),
            layoutReuseTotal: Number(state.layoutReuse?.total || this.nodes.length || 0),
            layoutReuseRatio: Number(state.layoutReuse?.ratio || 0),
            layoutAnimation: this._lastLayoutAnimationDiagnostics,
            at: Date.now(),
        });
        if (this.enabled) this._render();
    }

    _updateLayoutAnimationDiagnostics(patch = {}) {
        const state = this._layoutAnimationState;
        this._lastLayoutAnimationDiagnostics = {
            ...this._lastLayoutAnimationDiagnostics,
            enabled: Boolean(state || this._lastLayoutAnimationDiagnostics?.enabled),
            status: state ? 'running' : 'idle',
            reason: '',
            reducedMotion: this._isReducedMotion(),
            frameCount: Number(state?.frameCount || 0),
            remainingIterations: Number(state?.remainingIterations || 0),
            cooldownUntil: Number(this._layoutAnimationCooldownUntil || 0),
            ...patch,
        };
        if (this._lastLayoutDiagnostics) {
            this._lastLayoutDiagnostics = {
                ...this._lastLayoutDiagnostics,
                layoutAnimation: { ...this._lastLayoutAnimationDiagnostics },
            };
            recordGraphLayoutDebugSnapshot({
                ...this._lastLayoutDiagnostics,
                enabled: this.enabled !== false,
            });
        }
    }

    _cancelLayoutAnimation(reason = 'cancelled') {
        if (this._layoutAnimId) {
            cancelAnimationFrame(this._layoutAnimId);
            this._layoutAnimId = null;
        }
        if (this._layoutAnimationState) {
            const state = this._layoutAnimationState;
            this._layoutAnimationState = null;
            this._updateLayoutAnimationDiagnostics({
                enabled: true,
                status: 'cancelled',
                reason,
                frameCount: state.frameCount,
                remainingIterations: state.remainingIterations,
            });
        }
    }

    /**
     * 分区内力导向：斥力 + 同区边弹簧 + 弱向心。可一次性跑完，也可被短 RAF 动画分帧调用。
     */
    _simulateNeuralWithinRegions(iterations, options = {}) {
        const minIterations = Number.isFinite(Number(options.minIterations))
            ? Math.max(1, Math.trunc(Number(options.minIterations)))
            : 8;
        const iters = Math.max(minIterations, Math.min(220, Math.trunc(iterations || 80)));
        for (let it = 0; it < iters; it++) {
            this._simulateNeuralIteration();
        }
    }

    _simulateNeuralIteration() {
        const repulsion = this.config.neuralRepulsion ?? 2800;
        const springK = this.config.neuralSpringK ?? 0.048;
        const damping = this.config.neuralDamping ?? 0.88;
        const cg = this.config.neuralCenterGravity ?? 0.014;
        const extraGap = this.config.neuralMinGap ?? 12;
        const springIdeal = this._idealSpringLengthsByRegion();
        const nodes = this.nodes;

        for (const n of nodes) {
            n._fx = 0;
            n._fy = 0;
        }

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i];
                const b = nodes[j];
                if (a.regionKey !== b.regionKey) continue;
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let distSq = dx * dx + dy * dy;
                if (distSq < 0.25) distSq = 0.25;
                const dist = Math.sqrt(distSq);
                const minSep =
                    this._nodeRadius(a) + this._nodeRadius(b) + extraGap;
                let f = repulsion / distSq;
                if (dist < minSep) {
                    f += (minSep - dist) * 0.22;
                }
                const fx = (dx / dist) * f;
                const fy = (dy / dist) * f;
                a._fx -= fx;
                a._fy -= fy;
                b._fx += fx;
                b._fy += fy;
            }
        }

        for (const edge of this.edges) {
            const { from, to, strength } = edge;
            const sameRegion = from.regionKey === to.regionKey;
            if (!sameRegion && !this._isGalaxyMode()) continue;
            const ideal =
                springIdeal.get(sameRegion ? from.regionKey : 'objective') ?? 68;
            let dx = to.x - from.x;
            let dy = to.y - from.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
            const displacement = dist - ideal * (0.82 + 0.18 * strength);
            const crossScale = sameRegion ? 1 : 0.34;
            const f = springK * crossScale * displacement * (0.45 + 0.55 * strength);
            const fx = (dx / dist) * f;
            const fy = (dy / dist) * f;
            from._fx += fx;
            from._fy += fy;
            to._fx -= fx;
            to._fy -= fy;
        }

        for (const node of nodes) {
            const rect = node.regionRect;
            if (!rect) continue;
            const ccx = rect.x + rect.w / 2;
            const ccy = rect.y + rect.h / 2;
            node._fx += (ccx - node.x) * cg;
            node._fy += (ccy - node.y) * cg;
        }

        for (const node of nodes) {
            node.vx = (node.vx + node._fx) * damping;
            node.vy = (node.vy + node._fy) * damping;
            const sp = Math.hypot(node.vx, node.vy);
            const cap = 3.8;
            if (sp > cap) {
                node.vx = (node.vx / sp) * cap;
                node.vy = (node.vy / sp) * cap;
            }
            node.x += node.vx;
            node.y += node.vy;
            delete node._fx;
            delete node._fy;
            this._clampNodeToRegion(node);
        }
    }

    _clampNodeToRegion(node) {
        const rect = node.regionRect;
        if (!rect) return;
        const r = this._nodeRadius(node) + 6;
        node.x = Math.max(rect.x + r, Math.min(rect.x + rect.w - r, node.x));
        node.y = Math.max(rect.y + r, Math.min(rect.y + rect.h - r, node.y));
    }

    // ==================== 渲染 ====================

    _formatRegionPanelLabel(panel = {}) {
        if (panel?.labelKey) {
            return translateUi(panel.labelKey, panel.labelParams || {}, {
                fallback: panel.label || panel.labelKey,
            });
        }
        return String(panel?.label || '');
    }

    _drawRegionPanels(ctx) {
        if (this._isGalaxyMode()) return;
        if (!LIGHT_PANEL_THEMES.has(this.themeName)) return;
        const theme = THEMES[this.themeName] || THEMES.crimson;
        for (const p of this._regionPanels) {
            const pw = Number(p.w) || 0;
            const ph = Number(p.h) || 0;
            if (pw < 2 || ph < 2) continue;
            ctx.beginPath();
            roundRectPath(ctx, p.x, p.y, pw, ph, 16);
            ctx.fillStyle = createCanvasGradient(
                ctx,
                'createLinearGradient',
                [p.x, p.y, p.x + pw, p.y + ph],
                [
                    [0, p.tint],
                    [0.62, colorWithAlpha(theme.surfaceContainer || theme.surface, 0.22)],
                    [1, colorWithAlpha(theme.primary, 0.035)],
                ],
                p.tint,
            );
            ctx.fill();
            ctx.strokeStyle = colorWithAlpha(theme.primary, 0.14);
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = colorWithAlpha(theme.onSurface || '#dae5f2', 0.64);
            ctx.font = '700 10px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(this._formatRegionPanelLabel(p), p.x + 12, p.y + 16);
        }
    }

    _drawSynapseEdge(ctx, edge, idx, focus = null) {
        const { from, to, strength } = edge;
        const sameZone = from.regionKey === to.regionKey;
        const selectedNode = focus?.selectedNode || null;
        const isConnectedToSelection = !!selectedNode && (from === selectedNode || to === selectedNode);
        const isDimmed = !!selectedNode && !isConnectedToSelection;
        const isMoving = focus?.edgesDimmedOnMove === true;
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const sign = idx % 2 === 0 ? 1 : -1;
        let bend = sameZone ? 16 + strength * 22 : 32 + strength * 36;
        bend *= sign;
        const cx = mx + nx * bend;
        const cy = my + ny * bend;

        const isLightTheme = LIGHT_PANEL_THEMES.has(this.themeName);
        const theme = THEMES[this.themeName] || THEMES.crimson;
        const relationColor = edgeColorForRelation(edge.relation, this.edgeRelationColors);
        const edgeColor = relationColor;
        const unselectedColor = isLightTheme ? (theme.onSurface || edgeColor) : edgeColor;

        const baseAlpha = sameZone ? 0.04 + strength * 0.06 : 0.03 + strength * 0.05;
        let alpha = isDimmed ? (isLightTheme ? 0.012 : 0.01) : (isConnectedToSelection ? 0.35 + strength * 0.25 : baseAlpha);
        if (isMoving && !isConnectedToSelection) alpha *= 0.22;

        if (isConnectedToSelection) {
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.quadraticCurveTo(cx, cy, to.x, to.y);
            ctx.strokeStyle = colorWithAlpha(edgeColor, isLightTheme ? 0.055 + strength * 0.055 : 0.15 + strength * 0.15);
            ctx.lineWidth = 1.35 + strength * 0.95;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(cx, cy, to.x, to.y);
        ctx.strokeStyle = colorWithAlpha(isConnectedToSelection ? edgeColor : unselectedColor, alpha);
        ctx.lineWidth = isConnectedToSelection
            ? 0.7 + strength * 0.72
            : 0.28 + strength * 0.44;
        ctx.stroke();
    }

    _render() {
        if (!this.enabled) {
            this._clearCanvas();
            return;
        }
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const W = this.canvas.width / dpr;
        const H = this.canvas.height / dpr;
        this._pruneTransientHighlights(this._nowMs());

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this._drawDeepSpaceBackground(ctx, W, H);

        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        if (this._regionPanels.length) {
            this._drawRegionPanels(ctx);
        }

        this._drawGrid(W, H);

        const focus = this._buildFocusState();
        focus.edgesDimmedOnMove = this.config?.hideEdgesOnMove !== false
            && this._nowMs() < Number(this._edgeInteractionDimUntil || 0);

        this.edges.forEach((e, i) => this._drawSynapseEdge(ctx, e, i, focus));

        const isLightTheme = LIGHT_PANEL_THEMES.has(this.themeName);
        const isGalaxyMode = this._isGalaxyMode();
        const coreLabelNodes = !isGalaxyMode || isLightTheme
            ? null
            : new Set(
            [...this.nodes]
                .sort((a, b) => (b.importance || 0) - (a.importance || 0))
                .slice(0, 7)
        );

        for (const node of this.nodes) {
            const baseRadius = this._nodeVisualRadius(node);
            const color = this.colors[node.type] || this.colors.default || this.colors.event;
            const isSelected = node === this.selectedNode;
            const isHovered = node === this.hoveredNode;
            const isDimmed = focus.selectedNode && !focus.connectedNodes.has(node);
            const activeRadius = isSelected
                ? Math.min(10, baseRadius * 1.22, baseRadius + 1.8)
                : (isHovered ? Math.min(9, baseRadius * 1.12, baseRadius + 1.1) : baseRadius);
            const transientHighlight = this._transientHighlights.get(node.id) || null;
            const transientVisual = this._getTransientHighlightVisual(transientHighlight);
            const r = activeRadius * (isDimmed ? 0.62 : 1) * transientVisual.scale;
            const scope = normalizeMemoryScope(node.raw?.scope);
            const outlineColor = scope.layer === 'pov'
                ? (scope.ownerType === 'user'
                    ? this.scopeColors.user
                    : this.scopeColors.character)
                : this.scopeColors.objective;

            ctx.save();
            if (isDimmed) ctx.globalAlpha = 0.2;

            if (transientHighlight) {
                this._drawTransientHighlight(ctx, node, r, transientHighlight, transientVisual);
            }

            if (isSelected || isHovered) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + (isSelected ? 5.2 : 3.8), 0, Math.PI * 2);
                ctx.strokeStyle = colorWithAlpha(color, isSelected ? 0.54 : 0.36);
                ctx.lineWidth = isSelected ? 1.05 : 0.85;
                ctx.stroke();

                if (isSelected) {
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, r + 8.2, 0, Math.PI * 2);
                    ctx.strokeStyle = colorWithAlpha(color, 0.18);
                    ctx.lineWidth = 0.75;
                    ctx.stroke();
                }
            }

            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            ctx.fillStyle = colorWithAlpha(
                transientVisual.color || color,
                Math.min(1, (isSelected ? 0.96 : (isHovered ? 0.9 : 0.82)) * transientVisual.alpha),
            );
            ctx.fill();

            ctx.strokeStyle = isSelected
                ? colorWithAlpha(color, 0.72)
                : colorWithAlpha(outlineColor, isHovered ? 0.58 : 0.38);
            ctx.lineWidth = isSelected ? 1.15 : (isHovered ? 0.95 : 0.65);
            ctx.stroke();

            ctx.font = `${this.config.labelFontSize}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            const rect = node.regionRect;
            let maxLabelW = 118;
            if (rect) {
                const frac =
                    node.regionKey === 'user' ? 0.4
                    : node.regionKey.startsWith('char:') ? 0.46
                    : 0.52;
                maxLabelW = Math.max(36, Math.min(220, rect.w * frac));
            }
            const showLabel = !isGalaxyMode || isLightTheme || isHovered || isSelected || coreLabelNodes.has(node);
            if (showLabel) {
                const labelDraw = this._ellipsisLabel(
                    ctx,
                    node.label || node.name,
                    maxLabelW,
                );
                if (isHovered || isSelected) {
                    const metrics = ctx.measureText(labelDraw);
                    const pillW = Math.min(maxLabelW + 10, metrics.width + 12);
                    const pillH = 16;
                    const pillX = node.x - pillW / 2;
                    const pillY = node.y + r + 6.5;
                    ctx.beginPath();
                    roundRectPath(ctx, pillX, pillY, pillW, pillH, 5);
                    ctx.fillStyle = isSelected
                        ? colorWithAlpha((THEMES[this.themeName] || THEMES.crimson).surface || '#131316', 0.78)
                        : colorWithAlpha((THEMES[this.themeName] || THEMES.crimson).surface || '#131316', 0.62);
                    ctx.fill();
                    ctx.strokeStyle = colorWithAlpha(color, 0.16);
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
                ctx.fillStyle = colorWithAlpha(
                    (THEMES[this.themeName] || THEMES.crimson).onSurface || '#dae5f2',
                    isHovered || isSelected ? 0.88 : 0.52,
                );
                ctx.fillText(labelDraw, node.x, node.y + r + 14);
            }
            ctx.restore();
        }

        ctx.restore();
        this._afterRenderTransientHighlights();
    }

    _getTransientHighlightVisual(highlight) {
        if (!highlight) {
            return { scale: 1, alpha: 1, phase: 0, progress: 1, fade: 0, color: null };
        }
        const now = this._nowMs();
        const ttl = Math.max(1, Number(highlight.ttlMs) || 1);
        const progress = Math.max(0, Math.min(1, (now - Number(highlight.startedAt || now)) / ttl));
        const reducedMotion = this._isReducedMotion();
        const phase = reducedMotion ? 0.55 : (Math.sin(progress * Math.PI * 4) + 1) / 2;
        const fade = Math.max(0, 1 - progress);
        const kind = highlight.kind || 'recall';
        const transientColors = this.transientHighlightColors || getTransientHighlightColors(this.themeName);
        if (kind === 'extracted') {
            const birth = reducedMotion ? 1 : Math.min(1, progress / 0.42);
            return {
                scale: 0.64 + birth * 0.5 + phase * 0.16 * fade,
                alpha: 0.72 + birth * 0.28,
                phase,
                progress,
                fade,
                color: transientColors.extracted,
            };
        }
        if (kind === 'mixed') {
            return {
                scale: 1.16 + phase * 0.32 * fade,
                alpha: 1,
                phase,
                progress,
                fade,
                color: phase > 0.5 ? transientColors.mixedA : transientColors.mixedB,
            };
        }
        return {
            scale: 1.1 + phase * 0.28 * fade,
            alpha: 1,
            phase,
            progress,
            fade,
            color: transientColors.recall,
        };
    }

    _drawTransientHighlight(ctx, node, radius, highlight, visual = null) {
        if (!highlight || !node) return;
        const reducedMotion = this._isReducedMotion();
        const pulse = visual || this._getTransientHighlightVisual(highlight);
        const phase = pulse.phase;
        const fade = pulse.fade;
        const kind = highlight.kind || 'recall';
        const transientColors = this.transientHighlightColors || getTransientHighlightColors(this.themeName);
        const drawThinPulse = (color, offset, alphaScale = 1) => {
            const pulseAmount = reducedMotion ? 0.2 : phase;
            const ringRadius = radius + offset + pulseAmount * 2.4;

            ctx.beginPath();
            ctx.arc(node.x, node.y, ringRadius, 0, Math.PI * 2);
            ctx.strokeStyle = colorWithAlpha(color, (0.09 + phase * 0.1) * fade * alphaScale);
            ctx.lineWidth = 0.45 + phase * 0.25;
            ctx.stroke();
        };

        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 1.4 + phase * 1.2, 0, Math.PI * 2);
        ctx.strokeStyle = colorWithAlpha(pulse.color || transientColors.recall, (0.2 + phase * 0.16) * fade);
        ctx.lineWidth = 0.8 + phase * 0.28;
        ctx.stroke();

        if (kind === 'mixed') {
            drawThinPulse(transientColors.mixedA, 3.8, 0.55);
            drawThinPulse(transientColors.mixedB, 5.6, 0.42);
        } else if (kind === 'extracted') {
            drawThinPulse(transientColors.extracted, 3.6, 0.5);
            drawThinPulse(transientColors.created, 5.4, 0.28);
        } else {
            drawThinPulse(transientColors.recall, 4.0, 0.48);
        }
    }

    _afterRenderTransientHighlights() {
        if (!this.enabled) {
            this._clearTransientHighlights({ cancelAnimation: true });
            return;
        }
        const hasActive = this._pruneTransientHighlights(this._nowMs()) > 0;
        if (!hasActive) {
            this._cancelHighlightAnimationFrame();
            this._cancelHighlightExpiryTimer();
            return;
        }
        if (!this._isReducedMotion()) {
            this._scheduleHighlightAnimationFrame();
        } else {
            this._scheduleReducedMotionHighlightExpiry();
        }
    }

    _drawDeepSpaceBackground(ctx, W, H) {
        const width = Math.max(1, Number(W) || 1);
        const height = Math.max(1, Number(H) || 1);
        const theme = THEMES[this.themeName] || THEMES.crimson;
        ctx.fillStyle = theme.surfaceLowest || theme.surfaceLow || theme.surface || '#06060a';
        ctx.fillRect(0, 0, width, height);
    }

    _buildFocusState() {
        const selectedNode = this.selectedNode || null;
        const connectedNodes = new Set();
        if (selectedNode) {
            connectedNodes.add(selectedNode);
            for (const edge of this.edges) {
                if (edge.from === selectedNode && edge.to) connectedNodes.add(edge.to);
                if (edge.to === selectedNode && edge.from) connectedNodes.add(edge.from);
            }
        }
        return { selectedNode, connectedNodes };
    }

    _nowMs() {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    _isReducedMotion() {
        try {
            return window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
        } catch {
            return false;
        }
    }

    _normalizeTransientHighlightIds(input) {
        const source = Array.isArray(input) ? input : (input == null ? [] : [input]);
        const ids = new Set();
        for (const item of source) {
            let raw = item;
            if (item && typeof item === 'object') {
                raw = item.id ?? item.nodeId;
            }
            if (raw == null) continue;
            const id = String(raw).trim();
            if (id) ids.add(id);
        }
        return ids;
    }

    _pruneTransientHighlights(now = this._nowMs()) {
        for (const [nodeId, highlight] of this._transientHighlights) {
            if (!this.nodeMap.has(nodeId) || Number(highlight?.expiresAt || 0) <= now) {
                this._transientHighlights.delete(nodeId);
            }
        }
        return this._transientHighlights.size;
    }

    _clearTransientHighlights({ cancelAnimation = false } = {}) {
        this._transientHighlights.clear();
        if (cancelAnimation) {
            this._cancelHighlightAnimationFrame();
            this._cancelHighlightExpiryTimer();
        }
    }

    _cancelHighlightAnimationFrame() {
        if (this._highlightAnimId) {
            cancelAnimationFrame(this._highlightAnimId);
            this._highlightAnimId = null;
        }
    }

    _cancelHighlightExpiryTimer() {
        if (this._highlightExpiryTimer) {
            clearTimeout(this._highlightExpiryTimer);
            this._highlightExpiryTimer = null;
        }
    }

    _scheduleReducedMotionHighlightExpiry() {
        if (!this.enabled || this._highlightExpiryTimer || !this._isReducedMotion()) return;
        if (this._transientHighlights.size <= 0) return;
        const now = this._nowMs();
        let nextExpiresAt = Infinity;
        for (const highlight of this._transientHighlights.values()) {
            const expiresAt = Number(highlight?.expiresAt || 0);
            if (expiresAt > now) nextExpiresAt = Math.min(nextExpiresAt, expiresAt);
        }
        if (!Number.isFinite(nextExpiresAt)) return;
        const delay = Math.max(1, Math.ceil(nextExpiresAt - now) + 1);
        this._highlightExpiryTimer = setTimeout(() => {
            this._highlightExpiryTimer = null;
            if (!this.enabled) {
                this._clearTransientHighlights({ cancelAnimation: true });
                return;
            }
            const hadHighlights = this._transientHighlights.size > 0;
            const active = this._pruneTransientHighlights(this._nowMs());
            if (hadHighlights) this._scheduleRender();
            if (active > 0) this._scheduleReducedMotionHighlightExpiry();
        }, delay);
    }

    _scheduleHighlightAnimationFrame() {
        if (!this.enabled || this._highlightAnimId || this._isReducedMotion()) return;
        if (this._transientHighlights.size <= 0) return;
        this._highlightAnimId = requestAnimationFrame(() => {
            this._highlightAnimId = null;
            if (!this.enabled) {
                this._clearTransientHighlights({ cancelAnimation: true });
                return;
            }
            if (this._pruneTransientHighlights(this._nowMs()) <= 0) return;
            this._render();
        });
    }

    _scheduleRender() {
        if (!this.enabled || this.animId) return;
        this.animId = requestAnimationFrame(() => {
            this.animId = null;
            this._render();
        });
    }

    _drawGrid(W, H) {
        if (!LIGHT_PANEL_THEMES.has(this.themeName)) return;
        const sp = this.config.gridSpacing;
        if (!sp || sp <= 0) return;

        const ctx = this.ctx;
        ctx.strokeStyle = this.config.gridColor;
        ctx.lineWidth = 0.5;
        const startX = Math.floor(-this.offsetX / this.scale / sp) * sp;
        const startY = Math.floor(-this.offsetY / this.scale / sp) * sp;
        const endX = startX + W / this.scale + sp * 2;
        const endY = startY + H / this.scale + sp * 2;

        for (let x = startX; x < endX; x += sp) {
            ctx.beginPath();
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
            ctx.stroke();
        }
        for (let y = startY; y < endY; y += sp) {
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
        }
    }

    _nodeRadius(node) {
        const min = this.config.minNodeRadius;
        const max = this.config.maxNodeRadius;
        return min + ((node.importance || 5) / 10) * (max - min);
    }

    _nodeVisualRadius(node) {
        const base = this._nodeRadius(node);
        const importance = Number(node?.importance || 5);
        const type = String(node?.type || '').toLowerCase();
        let r;
        if (type === 'character' || importance >= 9) {
            r = base * 0.58;
            return Math.min(8, r);
        }
        if (importance >= 6) {
            r = base * 0.52;
            return Math.min(6.5, r);
        }
        r = base * 0.45;
        return Math.min(4.5, r);
    }

    _ellipsisLabel(ctx, text, maxW) {
        const s = String(text ?? "").trim() || "—";
        if (!maxW || maxW < 12) return s;
        if (ctx.measureText(s).width <= maxW) return s;
        const ell = "…";
        let lo = 0;
        let hi = s.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const trial = s.slice(0, mid) + ell;
            if (ctx.measureText(trial).width <= maxW) lo = mid;
            else hi = mid - 1;
        }
        return lo <= 0 ? ell : s.slice(0, lo) + ell;
    }

    _cancelAnim() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
    }

    stopAnimation() {
        this._cancelAnim();
        this._cancelLayoutAnimation('stop-animation');
        this._cancelHighlightAnimationFrame();
        this._cancelCameraAnimation('stop-animation');
    }

    _cancelEdgeInteractionRestoreTimer() {
        if (this._edgeInteractionRestoreTimer) {
            clearTimeout(this._edgeInteractionRestoreTimer);
            this._edgeInteractionRestoreTimer = null;
        }
    }

    _bindEvents() {
        const c = this.canvas;

        c.addEventListener('mousedown', (e) => this._onMouseDown(e));
        c.addEventListener('mousemove', (e) => this._onMouseMove(e));
        c.addEventListener('mouseup', (e) => this._onMouseUp(e));
        c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        c.addEventListener('dblclick', (e) => this._onDoubleClick(e));

        c.addEventListener('touchstart', (e) => {
            if (!this.enabled) return;
            if (e.touches.length !== 1) {
                this._touchSession = null;
                return;
            }
            e.preventDefault();
            this._markTouchInteraction();
            this.dragNode = null;
            this.isDragging = false;
            this.isPanning = false;
            this._dragStartMouse = null;
            const t = e.touches[0];
            const { x, y } = this._canvasToWorld(t.clientX, t.clientY);
            this._touchSession = {
                startX: t.clientX,
                startY: t.clientY,
                lastX: t.clientX,
                lastY: t.clientY,
                nodeCandidate: this._findNodeAt(x, y),
                moved: false,
            };
        }, { passive: false });
        c.addEventListener('touchmove', (e) => {
            if (!this.enabled || !this._touchSession || e.touches.length !== 1) return;
            e.preventDefault();
            this._markTouchInteraction();
            const t = e.touches[0];
            const dx = t.clientX - this._touchSession.lastX;
            const dy = t.clientY - this._touchSession.lastY;
            const fromStartX = t.clientX - this._touchSession.startX;
            const fromStartY = t.clientY - this._touchSession.startY;
            if (Math.abs(fromStartX) > 5 || Math.abs(fromStartY) > 5) {
                this._touchSession.moved = true;
            }
            this.offsetX += dx;
            this.offsetY += dy;
            this._touchSession.lastX = t.clientX;
            this._touchSession.lastY = t.clientY;
            this._scheduleRender();
        }, { passive: false });
        c.addEventListener('touchend', () => {
            if (!this.enabled || !this._touchSession) return;
            this._markTouchInteraction();
            const sess = this._touchSession;
            this._touchSession = null;
            this.dragNode = null;
            this.isDragging = false;
            this.isPanning = false;
            this._dragStartMouse = null;
            if (!sess.moved && sess.nodeCandidate) {
                this.selectedNode = sess.nodeCandidate;
                this._focusCameraOnNode(sess.nodeCandidate);
                if (this.onNodeSelect) this.onNodeSelect(sess.nodeCandidate);
                if (this.onNodeClick) this.onNodeClick(sess.nodeCandidate);
                this._render();
            } else if (!sess.moved && !sess.nodeCandidate && this.selectedNode) {
                this._returnToOverview();
            }
        });
        c.addEventListener('touchcancel', () => {
            if (!this.enabled) return;
            this._markTouchInteraction();
            this._touchSession = null;
            this.dragNode = null;
            this.isDragging = false;
            this.isPanning = false;
            this._dragStartMouse = null;
        });
    }

    _markTouchInteraction() {
        this._suppressMouseUntil = Date.now() + 650;
        this._markGraphMoveInteraction();
    }

    _markGraphMoveInteraction() {
        if (this.config?.hideEdgesOnMove !== false) {
            this._edgeInteractionDimUntil = this._nowMs() + 140;
            if (this._edgeInteractionRestoreTimer) clearTimeout(this._edgeInteractionRestoreTimer);
            this._edgeInteractionRestoreTimer = setTimeout(() => {
                this._edgeInteractionRestoreTimer = null;
                if (this.enabled) this._scheduleRender();
            }, 150);
        }
        this._cancelCameraAnimation('user-interaction');
    }

    _shouldIgnoreMouseEvent() {
        return !this.enabled || Date.now() < this._suppressMouseUntil;
    }

    _canvasToWorld(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = (clientX - rect.left - this.offsetX) / this.scale;
        const y = (clientY - rect.top - this.offsetY) / this.scale;
        return { x, y };
    }

    _findNodeAt(wx, wy) {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const n = this.nodes[i];
            const r = this._nodeRadius(n);
            const dx = n.x - wx;
            const dy = n.y - wy;
            if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return n;
        }
        return null;
    }

    _onMouseDown(e) {
        if (this._shouldIgnoreMouseEvent()) return;
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);
        const node = this._findNodeAt(x, y);
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this._dragStartMouse = { x: e.clientX, y: e.clientY };
        this._pointerDownNode = node || null;

        if (node) {
            this._markGraphMoveInteraction();
            this.dragNode = node;
            node.pinned = true;
            this.isDragging = true;
        } else {
            this._markGraphMoveInteraction();
            this.isPanning = true;
        }
    }

    _onMouseMove(e) {
        if (this._shouldIgnoreMouseEvent()) return;
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);

        if (this.isDragging && this.dragNode) {
            this._markGraphMoveInteraction();
            this.dragNode.x = x;
            this.dragNode.y = y;
            this._clampNodeToRegion(this.dragNode);
            this._scheduleRender();
        } else if (this.isPanning) {
            this._markGraphMoveInteraction();
            this.offsetX += e.clientX - this.lastMouse.x;
            this.offsetY += e.clientY - this.lastMouse.y;
            this._scheduleRender();
        } else {
            const node = this._findNodeAt(x, y);
            if (node !== this.hoveredNode) {
                this.hoveredNode = node;
                this.canvas.style.cursor = node ? 'pointer' : 'grab';
                this._scheduleRender();
            }
        }
        this.lastMouse = { x: e.clientX, y: e.clientY };
    }

    _onMouseUp() {
        if (this._shouldIgnoreMouseEvent()) return;
        if (this.dragNode) {
            this._clampNodeToRegion(this.dragNode);
            this.dragNode.pinned = false;
            if (this.isDragging) {
                const start = this._dragStartMouse || { x: 0, y: 0 };
                const dx = (this.lastMouse.x - start.x);
                const dy = (this.lastMouse.y - start.y);
                const movedDistance = Math.sqrt(dx * dx + dy * dy);
                if (movedDistance < 6) {
                    this.selectedNode = this.dragNode;
                    this._focusCameraOnNode(this.dragNode);
                    if (this.onNodeSelect) this.onNodeSelect(this.dragNode);
                    if (this.onNodeClick) this.onNodeClick(this.dragNode);
                }
            }
        } else if (this.isPanning && !this._pointerDownNode) {
            const start = this._dragStartMouse || { x: 0, y: 0 };
            const last = this.lastMouse || start;
            const dx = last.x - start.x;
            const dy = last.y - start.y;
            const movedDistance = Math.sqrt(dx * dx + dy * dy);
            if (movedDistance < 6 && this.selectedNode) {
                this._returnToOverview();
            }
        }
        this.dragNode = null;
        this.isDragging = false;
        this.isPanning = false;
        this._dragStartMouse = null;
        this._pointerDownNode = null;
        this._render();
    }

    _onWheel(e) {
        if (!this.enabled) return;
        e.preventDefault();
        this._markGraphMoveInteraction();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.2, Math.min(5, this.scale * factor));

        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        this.offsetX = mx - (mx - this.offsetX) * (newScale / this.scale);
        this.offsetY = my - (my - this.offsetY) * (newScale / this.scale);
        this.scale = newScale;
        this._render();
    }

    _onDoubleClick(e) {
        if (this._shouldIgnoreMouseEvent()) return;
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);
        const node = this._findNodeAt(x, y);
        if (node) {
            this.selectedNode = node;
            this._focusCameraOnNode(node);
            if (this.onNodeSelect) this.onNodeSelect(node);
            if (this.onNodeDoubleClick) this.onNodeDoubleClick(node);
            this._render();
        } else if (this.selectedNode) {
            this._returnToOverview();
        }
    }

    // ==================== 工具 ====================

    zoomIn() {
        if (!this.enabled) return;
        this._markGraphMoveInteraction();
        this.scale = Math.min(5, this.scale * 1.2);
        this._render();
    }

    zoomOut() {
        if (!this.enabled) return;
        this._markGraphMoveInteraction();
        this.scale = Math.max(0.2, this.scale * 0.8);
        this._render();
    }

    resetView() {
        if (!this.enabled) return;
        this._cancelCameraAnimation('reset-view');
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this._render();
    }

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const w = Math.round(parent.clientWidth || 0);
        const h = Math.round(parent.clientHeight || 0);
        if (!isUsableGraphCanvasSize(w, h, MIN_USABLE_CANVAS_DIMENSION)) {
            return;
        }

        if (
            w === this._lastCanvasCssWidth
            && h === this._lastCanvasCssHeight
            && dpr === this._lastDevicePixelRatio
        ) {
            return;
        }

        this._lastCanvasCssWidth = w;
        this._lastCanvasCssHeight = h;
        this._lastDevicePixelRatio = dpr;

        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';

        if (!this.enabled) {
            this._clearCanvas();
            return;
        }

        if (this.nodes.length > 0 && this._regionPanels.length > 0) {
            this._nextLayoutSolveRevision();
            this._nativeLayoutBridge?.cancelPending?.('viewport-resize-layout-reset');
            this._rebuildLayoutForCurrentViewport(w, h);
            this._render();
        } else if (this._lastGraph) {
            this.loadGraph(this._lastGraph, this._lastLayoutHints);
        } else {
            this._render();
        }
    }

    destroy() {
        this._nextLayoutSolveRevision();
        this._cancelAnim();
        this._cancelLayoutAnimation('destroy');
        this._cancelCameraAnimation('destroy');
        this._cancelEdgeInteractionRestoreTimer();
        this._clearTransientHighlights({ cancelAnimation: true });
        this._nativeLayoutBridge?.dispose?.();
        this._nativeLayoutBridge = null;
        recordGraphLayoutDebugSnapshot(
            this._lastLayoutDiagnostics
                ? {
                    ...this._lastLayoutDiagnostics,
                    enabled: false,
                    destroyed: true,
                }
                : {
                    enabled: false,
                    destroyed: true,
                },
        );
        this._resizeObserver?.disconnect();
    }
}
