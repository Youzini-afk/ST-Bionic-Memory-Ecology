// ST-BME: 记忆动力学模块
// 实现访问强化、时间衰减、混合评分 — 来自 PeroCore 的核心创新

/**
 * 访问强化：节点被召回/注入时调用
 * - accessCount += 1
 * - importance += 0.1（上限 10）
 * - lastAccessTime 更新
 *
 * @param {object} node
 */
export function reinforceAccess(node) {
    node.accessCount = (node.accessCount || 0) + 1;
    node.importance = Math.min(10, (node.importance || 5) + 0.1);
    node.lastAccessTime = Date.now();
}

/**
 * 计算时间衰减因子
 * 使用对数衰减（PeroCore 方式）而非指数衰减：
 * factor = 0.8 + 0.2 / (1 + ln(1 + Δt_days))
 *
 * 特点：久远但重要的记忆不会快速消失
 * - Δt = 0天 → factor = 1.0
 * - Δt = 1天 → factor ≈ 0.93
 * - Δt = 7天 → factor ≈ 0.89
 * - Δt = 30天 → factor ≈ 0.85
 * - Δt = 365天 → factor ≈ 0.83
 *
 * @param {number} createdTime - 创建时间戳(ms)
 * @param {number} [now] - 当前时间戳(ms)
 * @returns {number} 衰减因子 [0.8, 1.0]
 */
export function timeDecayFactor(createdTime, now = Date.now()) {
    const deltaDays = Math.max(0, (now - createdTime) / (1000 * 60 * 60 * 24));
    return 0.8 + 0.2 / (1 + Math.log(1 + deltaDays));
}

/**
 * 混合评分公式
 * FinalScore = (GraphScore×α + VecScore×β + ImportanceNorm×γ) × TimeDecay
 *
 * 默认权重：α=0.6, β=0.3, γ=0.1
 *
 * @param {object} params
 * @param {number} params.graphScore - 图扩散能量得分 [0, 2]
 * @param {number} params.vectorScore - 向量相似度 [0, 1]
 * @param {number} params.importance - 节点重要性 [0, 10]
 * @param {number} params.createdTime - 节点创建时间
 * @param {object} [weights] - 权重配置
 * @returns {number} 最终得分
 */
export function hybridScore({
    graphScore = 0,
    vectorScore = 0,
    lexicalScore = 0,
    importance = 5,
    createdTime = Date.now(),
}, weights = {}) {
    const alpha = weights.graphWeight ?? 0.6;
    const beta = weights.vectorWeight ?? 0.3;
    const gamma = weights.importanceWeight ?? 0.1;
    const delta = weights.lexicalWeight ?? 0;

    // 归一化
    const normGraph = Math.max(0, Math.min(1, graphScore / 2.0)); // PEDSA 能量范围 [-2, 2] → [0, 1]
    const normVec = Math.max(0, Math.min(1, vectorScore));
    const normLexical = Math.max(0, Math.min(1, lexicalScore));
    const normImportance = Math.max(0, Math.min(1, importance / 10.0));
    const totalWeight = Math.max(
        1e-6,
        Math.max(0, alpha) + Math.max(0, beta) + Math.max(0, gamma) + Math.max(0, delta),
    );

    const baseScore =
        (normGraph * alpha +
            normVec * beta +
            normLexical * delta +
            normImportance * gamma) /
        totalWeight;
    const decay = timeDecayFactor(createdTime);

    return baseScore * decay;
}

/**
 * 边权衰减：长期未被激活的边降低强度
 * 只降低到最低 0.1，不会归零
 *
 * @param {object[]} edges
 * @param {Set<string>} activatedEdgeIds - 最近被激活（出现在扩散路径上）的边 ID
 * @param {number} [decayRate=0.02] - 每次调用的衰减量
 */
export function decayEdgeWeights(edges, activatedEdgeIds = new Set(), decayRate = 0.02) {
    for (const edge of edges) {
        if (activatedEdgeIds.has(edge.id)) {
            // 被激活的边轻微加强
            edge.strength = Math.min(1.0, edge.strength + decayRate * 0.5);
        } else {
            // 未被激活的边轻微衰减
            edge.strength = Math.max(0.1, edge.strength - decayRate);
        }
    }
}

/**
 * 批量对选中节点执行访问强化
 * @param {object[]} nodes - 被召回的节点列表
 */
export function reinforceAccessBatch(nodes) {
    for (const node of nodes) {
        reinforceAccess(node);
    }
}
