// ST-BME: Canvas 图谱渲染器 — 分区「神经视图」布局
// 零依赖：客观层 / 角色 POV / 用户 POV 分区内 Vogel 初值 + 一次性力导向稳定，无帧循环抖动

import { getNodeColors } from './themes.js';
import { getGraphNodeLabel, getNodeDisplayName } from './node-labels.js';
import { normalizeMemoryScope } from './memory-scope.js';

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
    /** 分区内类神经布局：力导向迭代次数（无持续动画，仅一次性稳定） */
    neuralIterations: 120,
    neuralRepulsion: 2800,
    neuralSpringK: 0.048,
    neuralDamping: 0.88,
    neuralCenterGravity: 0.014,
    /** 节点最小间距（除半径外） */
    neuralMinGap: 12,
};

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

const SCOPE_OUTLINE_COLORS = {
    objective: '#57c7ff',
    character: '#ffb347',
    user: '#7dff9b',
};

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

/**
 * 宿主别名与 POV owner 比对：忽略大小写、多空格、常见中英文标点/符号差（NFKC）。
 * 不用于 charMap 主键，仅用于「是否同一用户」的宽松匹配。
 */
function normalizeAliasMatchKey(value) {
    let s = String(value ?? '');
    if (typeof s.normalize === 'function') {
        try {
            s = s.normalize('NFKC');
        } catch {
            /* ignore */
        }
    }
    s = s.trim().toLowerCase();
    // 标点、间隔号、各类空白等统一成空格，再压成单空格
    s = s.replace(
        /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\u00b7\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2000-\u206f\u2e00-\u2e7f]+/g,
        ' ',
    );
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/** 同一名称的多种可比形式（兼容老数据只做了 trim+lower） */
function collectAliasMatchVariants(raw) {
    const variants = [];
    const leg = normalizeKeyForPartition(raw);
    if (leg) variants.push(leg);
    const soft = normalizeAliasMatchKey(raw);
    if (soft) {
        variants.push(soft);
        const compact = soft.replace(/\s/g, '');
        if (compact && compact !== soft) variants.push(compact);
    }
    return variants;
}

function addAliasMatchVariantsToSet(set, raw) {
    for (const k of collectAliasMatchVariants(raw)) {
        if (k) set.add(k);
    }
}

/**
 * 将宿主侧「用户显示名」候选归一为分区用 Set，用于把误标为 character 的用户 POV 拉回用户区。
 * @param {string|string[]|{name1?:string,userName?:string,personaName?:string,aliases?:string[]}|null|undefined} hints
 * @returns {Set<string>}
 */
export function buildUserPovAliasNormalizedSet(hints) {
    const set = new Set();
    if (hints == null) return set;
    const ingest = (v) => addAliasMatchVariantsToSet(set, v);
    if (typeof hints === 'string') {
        ingest(hints);
        return set;
    }
    if (Array.isArray(hints)) {
        for (const item of hints) ingest(item);
        return set;
    }
    if (typeof hints === 'object') {
        ingest(hints.name1);
        ingest(hints.userName);
        ingest(hints.personaName);
        if (Array.isArray(hints.aliases)) {
            for (const a of hints.aliases) ingest(a);
        }
    }
    return set;
}

function scopeMatchesHostUserAliases(scope, aliasSet) {
    if (!(aliasSet instanceof Set) || aliasSet.size === 0) return false;
    for (const field of [scope.ownerName, scope.ownerId]) {
        for (const k of collectAliasMatchVariants(field)) {
            if (k && aliasSet.has(k)) return true;
        }
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

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.nodes = [];
        this.edges = [];
        this.nodeMap = new Map();
        this.colors = getNodeColors(themeName);
        this.themeName = themeName;
        this.config = { ...DEFAULT_LAYOUT_CONFIG, ...fromForce, ...layoutOverride };
        this._userPovAliasSet = buildUserPovAliasNormalizedSet(
            isLegacy ? null : options?.userPovAliases,
        );

        this._regionPanels = [];
        this._lastGraph = null;

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

        this.animId = null;

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
        const prevSelectedId = this.selectedNode?.id || null;
        this.nodeMap.clear();
        this._lastGraph = graph;
        if (layoutHints && Object.prototype.hasOwnProperty.call(layoutHints, 'userPovAliases')) {
            this._userPovAliasSet = buildUserPovAliasNormalizedSet(
                layoutHints.userPovAliases,
            );
        }

        const dpr = window.devicePixelRatio || 1;
        const W = this.canvas.width / dpr;
        const H = this.canvas.height / dpr;

        const activeNodes = graph.nodes.filter(n => !n.archived);
        this.nodes = activeNodes.map((n) => {
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

        this.edges = graph.edges
            .filter(e => !e.invalidAt && !e.expiredAt && this.nodeMap.has(e.fromId) && this.nodeMap.has(e.toId))
            .map(e => ({
                from: this.nodeMap.get(e.fromId),
                to: this.nodeMap.get(e.toId),
                strength: e.strength || 0.5,
                relation: e.relation || 'related',
            }));

        const parts = partitionNodesByScope(this.nodes, this._userPovAliasSet);
        this._regionPanels = this._computeRegionPanels(W, H, parts);
        this._layoutAllPartitions(parts);
        this._simulateNeuralWithinRegions(this.config.neuralIterations);

        if (prevSelectedId) {
            this.selectedNode = this.nodeMap.get(prevSelectedId) || null;
        }

        this._cancelAnim();
        this._render();
    }

    /**
     * 切换主题
     */
    setTheme(themeName) {
        this.themeName = themeName;
        this.colors = getNodeColors(themeName);
        this._render();
    }

    /**
     * 高亮指定节点
     */
    highlightNode(nodeId) {
        this.selectedNode = this.nodeMap.get(nodeId) || null;
        this._render();
    }

    // ==================== 分区布局 ====================

    _computeRegionPanels(W, H, { objective, userPov, charMap }) {
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
            label: '客观层',
            tint: 'rgba(26, 35, 50, 0.42)',
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
                label: '用户 POV',
                tint: 'rgba(32, 48, 40, 0.42)',
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
                label: `角色 POV · ${displayName}`,
                tint: 'rgba(55, 42, 28, 0.38)',
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
                label: '用户 POV',
                tint: 'rgba(32, 48, 40, 0.42)',
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

    _layoutAllPartitions({ objective, userPov, charMap }) {
        this._seedNeuralCloudInRect(objective, objective[0]?.regionRect);
        if (userPov.length) {
            this._seedNeuralCloudInRect(userPov, userPov[0]?.regionRect);
        }
        for (const [, arr] of charMap) {
            this._seedNeuralCloudInRect(arr, arr[0]?.regionRect);
        }
    }

    /**
     * 椭圆 Vogel 螺旋初值：有机疏密，Deterministic，无网格感
     */
    _seedNeuralCloudInRect(nodes, rect) {
        if (!rect || !nodes.length) return;
        const pad = Math.max(10, this.config.neuralMinGap);
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        const rx = Math.max(14, rect.w / 2 - pad);
        const ry = Math.max(14, rect.h / 2 - pad);
        const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
        const n = sorted.length;
        const golden = Math.PI * (3 - Math.sqrt(5));
        sorted.forEach((node, i) => {
            const t = (i + 0.5) / Math.max(n, 1);
            const radScale = Math.sqrt(t) * 0.9;
            const phase = ((hashId(node.id) & 0x3ff) / 1024) * 0.62;
            const theta = i * golden + phase;
            node.x = cx + Math.cos(theta) * radScale * rx;
            node.y = cy + Math.sin(theta) * radScale * ry;
            node.vx = 0;
            node.vy = 0;
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

    /**
     * 分区内一次性力导向：斥力 + 同区边弹簧 + 弱向心，稳定后停止（无帧循环）
     */
    _simulateNeuralWithinRegions(iterations) {
        const iters = Math.max(8, Math.min(220, iterations || 80));
        const repulsion = this.config.neuralRepulsion ?? 2800;
        const springK = this.config.neuralSpringK ?? 0.048;
        const damping = this.config.neuralDamping ?? 0.88;
        const cg = this.config.neuralCenterGravity ?? 0.014;
        const extraGap = this.config.neuralMinGap ?? 12;
        const springIdeal = this._idealSpringLengthsByRegion();
        const nodes = this.nodes;

        for (let it = 0; it < iters; it++) {
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
                if (from.regionKey !== to.regionKey) continue;
                const ideal =
                    springIdeal.get(from.regionKey) ?? 68;
                let dx = to.x - from.x;
                let dy = to.y - from.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
                const displacement = dist - ideal * (0.82 + 0.18 * strength);
                const f = springK * displacement * (0.45 + 0.55 * strength);
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
    }

    _clampNodeToRegion(node) {
        const rect = node.regionRect;
        if (!rect) return;
        const r = this._nodeRadius(node) + 6;
        node.x = Math.max(rect.x + r, Math.min(rect.x + rect.w - r, node.x));
        node.y = Math.max(rect.y + r, Math.min(rect.y + rect.h - r, node.y));
    }

    // ==================== 渲染 ====================

    _drawRegionPanels(ctx) {
        for (const p of this._regionPanels) {
            const pw = Number(p.w) || 0;
            const ph = Number(p.h) || 0;
            if (pw < 2 || ph < 2) continue;
            ctx.beginPath();
            roundRectPath(ctx, p.x, p.y, pw, ph, 12);
            ctx.fillStyle = p.tint;
            ctx.fill();
            ctx.strokeStyle = 'rgba(87, 199, 255, 0.12)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = 'rgba(228, 225, 230, 0.55)';
            ctx.font = '600 10px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(p.label, p.x + 12, p.y + 16);
        }
    }

    _drawSynapseEdge(ctx, edge, idx) {
        const { from, to, strength } = edge;
        const sameZone = from.regionKey === to.regionKey;
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

        const alpha = sameZone ? 0.06 + strength * 0.14 : 0.05 + strength * 0.1;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(cx, cy, to.x, to.y);
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = 0.45 + strength * 1.35;
        ctx.stroke();
    }

    _render() {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const W = this.canvas.width / dpr;
        const H = this.canvas.height / dpr;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.scale(dpr, dpr);

        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        if (this._regionPanels.length) {
            this._drawRegionPanels(ctx);
        }

        this._drawGrid(W, H);

        this.edges.forEach((e, i) => this._drawSynapseEdge(ctx, e, i));

        for (const node of this.nodes) {
            const r = this._nodeRadius(node);
            const color = this.colors[node.type] || this.colors.event;
            const isSelected = node === this.selectedNode;
            const isHovered = node === this.hoveredNode;
            const scope = normalizeMemoryScope(node.raw?.scope);
            const outlineColor = scope.layer === 'pov'
                ? (scope.ownerType === 'user'
                    ? SCOPE_OUTLINE_COLORS.user
                    : SCOPE_OUTLINE_COLORS.character)
                : SCOPE_OUTLINE_COLORS.objective;

            if (isSelected || isHovered) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 9, 0, Math.PI * 2);
                const glow = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, r + 9);
                glow.addColorStop(0, color + '55');
                glow.addColorStop(1, color + '00');
                ctx.fillStyle = glow;
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? color : color + 'dd';
            ctx.fill();

            ctx.strokeStyle = isSelected ? '#fff' : outlineColor;
            ctx.lineWidth = isSelected ? 2.25 : 1.35;
            ctx.stroke();

            ctx.fillStyle = `rgba(255,255,255,${isHovered || isSelected ? 0.94 : 0.66})`;
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
            const labelDraw = this._ellipsisLabel(
                ctx,
                node.label || node.name,
                maxLabelW,
            );
            ctx.fillText(labelDraw, node.x, node.y + r + 14);
        }

        ctx.restore();
    }

    _drawGrid(W, H) {
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

    /** @deprecated 力导向动画已移除；保留空实现以兼容旧调用 */
    stopAnimation() {
        this._cancelAnim();
    }

    // ==================== 交互 ====================

    _bindEvents() {
        const c = this.canvas;

        c.addEventListener('mousedown', (e) => this._onMouseDown(e));
        c.addEventListener('mousemove', (e) => this._onMouseMove(e));
        c.addEventListener('mouseup', (e) => this._onMouseUp(e));
        c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        c.addEventListener('dblclick', (e) => this._onDoubleClick(e));

        c.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                const t = e.touches[0];
                this._onMouseDown({ clientX: t.clientX, clientY: t.clientY, button: 0 });
            }
        }, { passive: true });
        c.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1) {
                const t = e.touches[0];
                this._onMouseMove({ clientX: t.clientX, clientY: t.clientY });
            }
        }, { passive: true });
        c.addEventListener('touchend', () => this._onMouseUp({}));
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
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);
        const node = this._findNodeAt(x, y);
        this.lastMouse = { x: e.clientX, y: e.clientY };
        this._dragStartMouse = { x: e.clientX, y: e.clientY };

        if (node) {
            this.dragNode = node;
            node.pinned = true;
            this.isDragging = true;
        } else {
            this.isPanning = true;
        }
    }

    _onMouseMove(e) {
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);

        if (this.isDragging && this.dragNode) {
            this.dragNode.x = x;
            this.dragNode.y = y;
            this._clampNodeToRegion(this.dragNode);
            this._render();
        } else if (this.isPanning) {
            this.offsetX += e.clientX - this.lastMouse.x;
            this.offsetY += e.clientY - this.lastMouse.y;
            this._render();
        } else {
            const node = this._findNodeAt(x, y);
            if (node !== this.hoveredNode) {
                this.hoveredNode = node;
                this.canvas.style.cursor = node ? 'pointer' : 'grab';
                this._render();
            }
        }
        this.lastMouse = { x: e.clientX, y: e.clientY };
    }

    _onMouseUp() {
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
                    if (this.onNodeSelect) this.onNodeSelect(this.dragNode);
                    if (this.onNodeClick) this.onNodeClick(this.dragNode);
                }
            }
        }
        this.dragNode = null;
        this.isDragging = false;
        this.isPanning = false;
        this._dragStartMouse = null;
        this._render();
    }

    _onWheel(e) {
        e.preventDefault();
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
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);
        const node = this._findNodeAt(x, y);
        if (node) {
            this.selectedNode = node;
            if (this.onNodeSelect) this.onNodeSelect(node);
            if (this.onNodeDoubleClick) this.onNodeDoubleClick(node);
            this._render();
        }
    }

    // ==================== 工具 ====================

    zoomIn() {
        this.scale = Math.min(5, this.scale * 1.2);
        this._render();
    }

    zoomOut() {
        this.scale = Math.max(0.2, this.scale * 0.8);
        this._render();
    }

    resetView() {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this._render();
    }

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';

        if (this._lastGraph) {
            this.loadGraph(this._lastGraph);
        } else {
            this._render();
        }
    }

    destroy() {
        this._cancelAnim();
        this._resizeObserver?.disconnect();
    }
}
