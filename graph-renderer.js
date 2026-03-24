// ST-BME: Canvas 力导向图谱渲染器
// 零依赖，纯 Canvas 2D 实现

import { getNodeColors } from './themes.js';

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

const FORCE_CONFIG = {
    repulsion: 500,         // 库仑斥力常数
    springLength: 120,      // 弹簧自然长度
    springK: 0.08,          // 弹簧刚度
    damping: 0.85,          // 阻尼系数
    centerGravity: 0.01,    // 向心引力
    maxIterations: 300,     // 力导向最大迭代帧
    minNodeRadius: 6,       // 最小节点半径
    maxNodeRadius: 18,      // 最大节点半径
    labelFontSize: 10,
    gridSpacing: 40,
    gridColor: 'rgba(255,255,255,0.03)',
};

export class GraphRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {string} themeName
     */
    constructor(canvas, themeName = 'crimson') {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.nodes = [];
        this.edges = [];
        this.nodeMap = new Map();
        this.colors = getNodeColors(themeName);
        this.themeName = themeName;

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

        // Animation
        this.iteration = 0;
        this.animating = false;
        this.animId = null;

        // Callbacks
        this.onNodeSelect = null;

        this._bindEvents();
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(canvas.parentElement);
        this._resize();
    }

    /**
     * 加载图谱数据
     * @param {object} graph - 完整的 graph state
     */
    loadGraph(graph) {
        this.nodeMap.clear();
        const dpr = window.devicePixelRatio || 1;
        const viewportWidth = this.canvas.width / dpr;
        const viewportHeight = this.canvas.height / dpr;

        // 转换节点
        const activeNodes = graph.nodes.filter(n => !n.archived);
        this.nodes = activeNodes.map((n, i) => {
            const angle = (2 * Math.PI * i) / activeNodes.length;
            const r = Math.min(viewportWidth, viewportHeight) * 0.3;
            const node = {
                id: n.id,
                type: n.type || 'event',
                name: getNodeDisplayName(n),
                importance: n.importance || 5,
                x: viewportWidth / 2 + r * Math.cos(angle) + (Math.random() - 0.5) * 40,
                y: viewportHeight / 2 + r * Math.sin(angle) + (Math.random() - 0.5) * 40,
                vx: 0,
                vy: 0,
                pinned: false,
                raw: n,
            };
            this.nodeMap.set(n.id, node);
            return node;
        });

        // 转换边
        this.edges = graph.edges
            .filter(e => !e.invalidAt && !e.expiredAt && this.nodeMap.has(e.fromId) && this.nodeMap.has(e.toId))
            .map(e => ({
                from: this.nodeMap.get(e.fromId),
                to: this.nodeMap.get(e.toId),
                strength: e.strength || 0.5,
                relation: e.relation || 'related',
            }));

        this.iteration = 0;
        this.startAnimation();
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

    // ==================== 力导向计算 ====================

    _applyForces() {
        const { nodes, edges } = this;
        const W = this.canvas.width / window.devicePixelRatio;
        const H = this.canvas.height / window.devicePixelRatio;
        const cx = W / 2, cy = H / 2;

        // 斥力（节点间排斥）
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                let dx = b.x - a.x, dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                let force = FORCE_CONFIG.repulsion / (dist * dist);
                let fx = (dx / dist) * force;
                let fy = (dy / dist) * force;
                if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
                if (!b.pinned) { b.vx += fx; b.vy += fy; }
            }
        }

        // 弹簧力（边的引力）
        for (const edge of edges) {
            const { from, to, strength } = edge;
            let dx = to.x - from.x, dy = to.y - from.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            let displacement = dist - FORCE_CONFIG.springLength;
            let force = FORCE_CONFIG.springK * displacement * strength;
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            if (!from.pinned) { from.vx += fx; from.vy += fy; }
            if (!to.pinned)   { to.vx -= fx; to.vy -= fy; }
        }

        // 向心力
        for (const node of nodes) {
            if (node.pinned) continue;
            node.vx += (cx - node.x) * FORCE_CONFIG.centerGravity;
            node.vy += (cy - node.y) * FORCE_CONFIG.centerGravity;
        }

        // 更新位置
        for (const node of nodes) {
            if (node.pinned) continue;
            node.vx *= FORCE_CONFIG.damping;
            node.vy *= FORCE_CONFIG.damping;
            node.x += node.vx;
            node.y += node.vy;
            // 边界约束
            node.x = Math.max(20, Math.min(W - 20, node.x));
            node.y = Math.max(20, Math.min(H - 20, node.y));
        }
    }

    // ==================== 渲染 ====================

    _render() {
        const ctx = this.ctx;
        const dpr = window.devicePixelRatio || 1;
        const W = this.canvas.width / dpr;
        const H = this.canvas.height / dpr;

        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.scale(dpr, dpr);

        // 应用视图变换
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        // 背景网格
        this._drawGrid(W, H);

        // 边
        for (const edge of this.edges) {
            ctx.beginPath();
            ctx.moveTo(edge.from.x, edge.from.y);
            ctx.lineTo(edge.to.x, edge.to.y);
            ctx.strokeStyle = `rgba(255,255,255,${0.05 + edge.strength * 0.15})`;
            ctx.lineWidth = 0.5 + edge.strength * 1.5;
            ctx.stroke();
        }

        // 节点
        for (const node of this.nodes) {
            const r = this._nodeRadius(node);
            const color = this.colors[node.type] || this.colors.event;
            const isSelected = node === this.selectedNode;
            const isHovered = node === this.hoveredNode;

            // 发光效果
            if (isSelected || isHovered) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 8, 0, Math.PI * 2);
                const glow = ctx.createRadialGradient(node.x, node.y, r, node.x, node.y, r + 8);
                glow.addColorStop(0, color + '60');
                glow.addColorStop(1, color + '00');
                ctx.fillStyle = glow;
                ctx.fill();
            }

            // 节点圆
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? color : color + 'cc';
            ctx.fill();

            // 边框
            if (isSelected) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // 标签
            ctx.fillStyle = `rgba(255,255,255,${isHovered || isSelected ? 0.95 : 0.65})`;
            ctx.font = `${FORCE_CONFIG.labelFontSize}px Inter, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(node.name, node.x, node.y + r + 14);
        }

        ctx.restore();
    }

    _drawGrid(W, H) {
        const ctx = this.ctx;
        const sp = FORCE_CONFIG.gridSpacing;
        ctx.strokeStyle = FORCE_CONFIG.gridColor;
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
        const min = FORCE_CONFIG.minNodeRadius;
        const max = FORCE_CONFIG.maxNodeRadius;
        return min + ((node.importance || 5) / 10) * (max - min);
    }

    // ==================== 动画 ====================

    startAnimation() {
        if (this.animating) return;
        this.animating = true;
        this._tick();
    }

    stopAnimation() {
        this.animating = false;
        if (this.animId) cancelAnimationFrame(this.animId);
    }

    _tick() {
        if (!this.animating) return;
        if (this.iteration < FORCE_CONFIG.maxIterations) {
            this._applyForces();
            this.iteration++;
        }
        this._render();
        this.animId = requestAnimationFrame(() => this._tick());
    }

    // ==================== 交互 ====================

    _bindEvents() {
        const c = this.canvas;

        c.addEventListener('mousedown', (e) => this._onMouseDown(e));
        c.addEventListener('mousemove', (e) => this._onMouseMove(e));
        c.addEventListener('mouseup', (e) => this._onMouseUp(e));
        c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        c.addEventListener('dblclick', (e) => this._onDoubleClick(e));

        // Touch support
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
            const dx = n.x - wx, dy = n.y - wy;
            if (dx * dx + dy * dy <= (r + 4) * (r + 4)) return n;
        }
        return null;
    }

    _onMouseDown(e) {
        const { x, y } = this._canvasToWorld(e.clientX, e.clientY);
        const node = this._findNodeAt(x, y);
        this.lastMouse = { x: e.clientX, y: e.clientY };

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
            this.iteration = 0; // restart physics
            this.startAnimation();
        } else if (this.isPanning) {
            this.offsetX += e.clientX - this.lastMouse.x;
            this.offsetY += e.clientY - this.lastMouse.y;
            this._render();
        } else {
            // hover detection
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
            this.dragNode.pinned = false;
            if (this.isDragging) {
                // 如果拖动距离很小，视为点击选中
                this.selectedNode = this.dragNode;
                if (this.onNodeSelect) this.onNodeSelect(this.dragNode);
            }
        }
        this.dragNode = null;
        this.isDragging = false;
        this.isPanning = false;
    }

    _onWheel(e) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.2, Math.min(5, this.scale * factor));

        // 以鼠标点为中心缩放
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
            this._render();
        }
    }

    // ==================== 工具 ====================

    zoomIn()  { this.scale = Math.min(5, this.scale * 1.2); this._render(); }
    zoomOut() { this.scale = Math.max(0.2, this.scale * 0.8); this._render(); }
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
        this._render();
    }

    destroy() {
        this.stopAnimation();
        this._resizeObserver?.disconnect();
    }
}

function getNodeDisplayName(node) {
    return (
        node?.fields?.name ||
        node?.fields?.title ||
        node?.fields?.summary ||
        node?.fields?.insight ||
        node?.id?.slice(0, 8) ||
        '—'
    );
}
