// ST-BME: JS 版 PEDSA 扩散激活引擎
// 从 PeroCore 的 Rust CognitiveGraphEngine 移植核心算法到纯 JS
// 适配 ST 场景（<1万节点，不需要并行/SIMD）

/**
 * PEDSA 扩散激活引擎
 *
 * 算法：Parallel Energy-Decay Spreading Activation
 * 本质：在有向加权图上的能量传播模型
 *
 * 核心公式：
 *   E_{t+1}(j) = Σ_{i∈N(j)} E_t(i) × W_ij × D_decay
 *
 * 特点（保留自 PeroCore）：
 * - 能量衰减：每步传播乘以衰减因子
 * - 动态剪枝：每步只保留 Top-K 活跃节点
 * - 抑制机制：特殊边类型传递负能量
 * - 能量钳位：限制在 [-2.0, 2.0] 范围
 *
 * 与 PeroCore Rust 版的差异：
 * - 无 Rayon 并行（JS 单线程，ST 场景不需要）
 * - 无 u16 量化（直接 f64，内存不是瓶颈）
 * - 无 SIMD（普通数组运算）
 */

/**
 * 抑制边类型标记
 */
const INHIBIT_EDGE_TYPE = 255;

/**
 * 默认配置
 */
const DEFAULT_OPTIONS = {
  maxSteps: 2, // 最大扩散步数
  decayFactor: 0.6, // 每步衰减因子
  topK: 100, // 每步保留的最大活跃节点数
  minEnergy: 0.01, // 最小有效能量（低于此值视为不活跃）
  maxEnergy: 2.0, // 能量上限
  minEnergy_clamp: -2.0, // 能量下限（抑制）
};

/**
 * 执行 PEDSA 扩散激活
 *
 * @param {Map<string, Array<{targetId: string, strength: number, edgeType: number}>>} adjacencyMap
 *   邻接表：nodeId → [{targetId, strength, edgeType}]
 *   可通过 graph.buildAdjacencyMap() 构建
 *
 * @param {Array<{id: string, energy: number}>} seedNodes
 *   初始种子节点及其能量
 *   - 向量检索命中的节点：energy = vectorScore (0~1)
 *   - 实体锚点节点：energy = 2.0（最大值）
 *
 * @param {object} [options] - 配置选项
 *
 * @returns {Map<string, number>} 所有被激活节点的最终能量
 *   nodeId → energy（正值=激活，负值=抑制）
 */
export function propagateActivation(adjacencyMap, seedNodes, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  /** @type {Map<string, number>} */
  let currentEnergy = new Map();

  for (const seed of seedNodes || []) {
    if (!seed?.id) continue;
    const clamped = clampEnergy(Number(seed.energy) || 0, opts);
    if (Math.abs(clamped) >= opts.minEnergy) {
      const existing = currentEnergy.get(seed.id) || 0;
      currentEnergy.set(seed.id, clampEnergy(existing + clamped, opts));
    }
  }

  // 累积结果（所有步骤的最大能量）
  /** @type {Map<string, number>} */
  const result = new Map(currentEnergy);

  // Step 1~N: 逐步扩散
  for (let step = 0; step < opts.maxSteps; step++) {
    /** @type {Map<string, number>} */
    const nextEnergy = new Map();

    // 对每个当前活跃节点，传播能量到邻居
    for (const [nodeId, energy] of currentEnergy) {
      const neighbors = adjacencyMap.get(nodeId);
      if (!Array.isArray(neighbors) || neighbors.length === 0) continue;

      for (const neighbor of neighbors) {
        if (!neighbor?.targetId) continue;
        let propagated =
          energy * (Number(neighbor.strength) || 0) * opts.decayFactor;

        // 抑制边：传递负能量
        if (neighbor.edgeType === INHIBIT_EDGE_TYPE) {
          propagated = -Math.abs(propagated);
        }

        // 累加到邻居节点
        const existing = nextEnergy.get(neighbor.targetId) || 0;
        nextEnergy.set(neighbor.targetId, existing + propagated);
      }
    }

    // 钳位 + 过滤低能量
    for (const [nodeId, energy] of nextEnergy) {
      const clamped = clampEnergy(energy, opts);
      if (Math.abs(clamped) < opts.minEnergy) {
        nextEnergy.delete(nodeId);
      } else {
        nextEnergy.set(nodeId, clamped);
      }
    }

    // 动态剪枝：只保留 Top-K
    if (nextEnergy.size > opts.topK) {
      const sorted = [...nextEnergy.entries()].sort(
        (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
      );

      nextEnergy.clear();
      for (let i = 0; i < opts.topK && i < sorted.length; i++) {
        nextEnergy.set(sorted[i][0], sorted[i][1]);
      }
    }

    // 更新累积结果（取各步骤最大绝对值能量）
    for (const [nodeId, energy] of nextEnergy) {
      const existing = result.get(nodeId) || 0;
      if (Math.abs(energy) > Math.abs(existing)) {
        result.set(nodeId, energy);
      }
    }

    // 准备下一步
    currentEnergy = nextEnergy;

    // 如果没有活跃节点了，提前终止
    if (currentEnergy.size === 0) break;
  }

  return result;
}

/**
 * 能量钳位
 * @param {number} energy
 * @param {object} opts
 * @returns {number}
 */
function clampEnergy(energy, opts) {
  return Math.max(opts.minEnergy_clamp, Math.min(opts.maxEnergy, energy));
}

/**
 * 快捷方法：从种子列表创建扩散并返回按能量排序的结果
 *
 * @param {Map} adjacencyMap - 邻接表
 * @param {Array<{id: string, energy: number}>} seeds - 种子节点
 * @param {object} [options]
 * @returns {Array<{nodeId: string, energy: number}>} 按能量降序排列
 */
export function diffuseAndRank(adjacencyMap, seeds, options = {}) {
  const energyMap = propagateActivation(adjacencyMap, seeds, options);

  return [...energyMap.entries()]
    .filter(([_, energy]) => energy > 0)
    .map(([nodeId, energy]) => ({ nodeId, energy }))
    .sort((a, b) => {
      if (b.energy !== a.energy) return b.energy - a.energy;
      return String(a.nodeId).localeCompare(String(b.nodeId));
    });
}
