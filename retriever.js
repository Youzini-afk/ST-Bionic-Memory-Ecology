// ST-BME: 三层混合检索编排
// 融合向量预筛（PeroCore）+ 图扩散（PeroCore PEDSA）+ 可选 LLM 精确召回
// v2: + 认知边界过滤(RoleRAG) + 双记忆交叉检索(AriGraph) + 概率触发

import { getActiveNodes, buildAdjacencyMap, buildTemporalAdjacencyMap, getNode, getNodeEdges } from './graph.js';
import { propagateActivation, diffuseAndRank } from './diffusion.js';
import { embedText, searchSimilar } from './embedding.js';
import { hybridScore, reinforceAccessBatch } from './dynamics.js';
import { callLLMForJSON } from './llm.js';

/**
 * 自适应阈值
 */
const STRATEGY_THRESHOLDS = {
    SMALL: 20,    // < 20 节点：跳过向量，全图 + LLM
    MEDIUM: 200,  // 20-200 节点：向量 + 图扩散 + 评分（不调 LLM）
    // > 200 节点：三层全开
};

/**
 * 三层混合检索管线
 *
 * @param {object} params
 * @param {object} params.graph - 当前图状态
 * @param {string} params.userMessage - 用户输入
 * @param {string[]} params.recentMessages - 最近几轮对话内容
 * @param {object} params.embeddingConfig - Embedding API 配置
 * @param {object[]} params.schema - 节点类型 Schema
 * @param {object} [params.options] - 检索选项
 * @returns {Promise<RetrievalResult>}
 */
export async function retrieve({
    graph,
    userMessage,
    recentMessages = [],
    embeddingConfig,
    schema,
    options = {},
}) {
    const topK = options.topK ?? 15;
    const maxRecallNodes = options.maxRecallNodes ?? 8;
    const enableLLMRecall = options.enableLLMRecall ?? true;
    const weights = options.weights ?? {};

    // v2 options
    const enableVisibility = options.enableVisibility ?? false;
    const visibilityFilter = options.visibilityFilter ?? null;
    const enableCrossRecall = options.enableCrossRecall ?? false;
    const enableProbRecall = options.enableProbRecall ?? false;
    const probRecallChance = options.probRecallChance ?? 0.15;

    let activeNodes = getActiveNodes(graph);

    // v2 ⑦: 认知边界过滤（RoleRAG 启发）
    if (enableVisibility && visibilityFilter) {
        activeNodes = filterByVisibility(activeNodes, visibilityFilter);
    }

    const nodeCount = activeNodes.length;
    console.log(`[ST-BME] 检索开始: ${nodeCount} 个活跃节点${enableVisibility ? ' (认知边界已启用)' : ''}`);

    let vectorResults = [];
    let diffusionResults = [];
    let useLLM = false;

    if (nodeCount === 0) {
        return buildResult(graph, [], schema);
    }

    // ========== 第 1 层：向量预筛 ==========
    if (nodeCount >= STRATEGY_THRESHOLDS.SMALL && embeddingConfig?.apiUrl) {
        console.log('[ST-BME] 第1层: 向量预筛');
        vectorResults = await vectorPreFilter(userMessage, activeNodes, embeddingConfig, topK);
    }

    // ========== 第 2 层：图扩散 ==========
    if (nodeCount >= STRATEGY_THRESHOLDS.SMALL) {
        console.log('[ST-BME] 第2层: PEDSA 图扩散');
        const entityAnchors = extractEntityAnchors(userMessage, activeNodes);

        const seeds = [
            ...vectorResults.map(v => ({ id: v.nodeId, energy: v.score })),
            ...entityAnchors.map(a => ({ id: a.nodeId, energy: 2.0 })),
        ];

        // v2 ⑧: 双记忆交叉检索（AriGraph 启发）
        // 实体锚点命中后，沿边展开关联的情景节点作为额外种子
        if (enableCrossRecall && entityAnchors.length > 0) {
            for (const anchor of entityAnchors) {
                const connectedEdges = getNodeEdges(graph, anchor.nodeId);
                for (const edge of connectedEdges) {
                    if (edge.invalidAt) continue;
                    const neighborId = edge.fromId === anchor.nodeId ? edge.toId : edge.fromId;
                    const neighbor = getNode(graph, neighborId);
                    if (neighbor && !neighbor.archived && neighbor.type === 'event') {
                        seeds.push({ id: neighborId, energy: 1.5 * edge.strength });
                    }
                }
            }
        }

        // 去重种子
        const seedMap = new Map();
        for (const s of seeds) {
            const existing = seedMap.get(s.id) || 0;
            if (s.energy > existing) seedMap.set(s.id, s.energy);
        }
        const uniqueSeeds = [...seedMap.entries()].map(([id, energy]) => ({ id, energy }));

        if (uniqueSeeds.length > 0) {
            const adjacencyMap = buildTemporalAdjacencyMap(graph);
            diffusionResults = diffuseAndRank(adjacencyMap, uniqueSeeds, {
                maxSteps: 2,
                decayFactor: 0.6,
                topK: 100,
            });
        }
    }

    // ========== 第 3 层：混合评分 + 可选 LLM 精确 ==========
    console.log('[ST-BME] 第3层: 混合评分');

    // 构建评分表
    const scoreMap = new Map();

    // 添加向量得分
    for (const v of vectorResults) {
        const entry = scoreMap.get(v.nodeId) || { graphScore: 0, vectorScore: 0 };
        entry.vectorScore = v.score;
        scoreMap.set(v.nodeId, entry);
    }

    // 添加图扩散得分
    for (const d of diffusionResults) {
        const entry = scoreMap.get(d.nodeId) || { graphScore: 0, vectorScore: 0 };
        entry.graphScore = d.energy;
        scoreMap.set(d.nodeId, entry);
    }

    // 小图模式：所有节点都参与评分
    if (nodeCount < STRATEGY_THRESHOLDS.SMALL) {
        for (const node of activeNodes) {
            if (!scoreMap.has(node.id)) {
                scoreMap.set(node.id, { graphScore: 0, vectorScore: 0 });
            }
        }
    }

    // 计算混合得分
    const scoredNodes = [];
    for (const [nodeId, scores] of scoreMap) {
        const node = getNode(graph, nodeId);
        if (!node || node.archived) continue;

        const finalScore = hybridScore({
            graphScore: scores.graphScore,
            vectorScore: scores.vectorScore,
            importance: node.importance,
            createdTime: node.createdTime,
        }, weights);

        scoredNodes.push({ nodeId, node, finalScore, ...scores });
    }

    scoredNodes.sort((a, b) => b.finalScore - a.finalScore);

    // 决定是否使用 LLM 精确召回
    useLLM = enableLLMRecall && (
        nodeCount < STRATEGY_THRESHOLDS.SMALL ||  // 小图：直接 LLM
        nodeCount > STRATEGY_THRESHOLDS.MEDIUM     // 大图：LLM 精确
    );

    let selectedNodeIds;

    if (useLLM && nodeCount > 0) {
        console.log('[ST-BME] LLM 精确召回');
        const candidateNodes = scoredNodes.slice(0, Math.min(30, scoredNodes.length));
        selectedNodeIds = await llmRecall(
            userMessage,
            recentMessages,
            candidateNodes,
            graph,
            schema,
            maxRecallNodes,
        );
    } else {
        // 中等图：直接取 Top-N
        selectedNodeIds = scoredNodes
            .slice(0, topK)
            .map(s => s.nodeId);
    }

    // 访问强化
    const selectedNodes = selectedNodeIds
        .map(id => getNode(graph, id))
        .filter(Boolean);

    reinforceAccessBatch(selectedNodes);

    console.log(`[ST-BME] 检索完成: 选中 ${selectedNodeIds.length} 个节点`);

    // v2 ⑧: 概率触发回忆
    // 未被选中的高重要性节点有概率随机激活
    if (enableProbRecall && probRecallChance > 0) {
        const selectedSet = new Set(selectedNodeIds);
        const candidates = activeNodes.filter(n =>
            !selectedSet.has(n.id) &&
            n.importance >= 6 &&
            n.type !== 'synopsis' &&
            n.type !== 'rule',
        );
        for (const c of candidates) {
            if (Math.random() < probRecallChance) {
                selectedNodeIds.push(c.id);
                console.log(`[ST-BME] 概率触发: ${c.fields?.name || c.fields?.summary || c.id}`);
            }
        }
    }

    return buildResult(graph, selectedNodeIds, schema);
}

/**
 * 向量预筛选
 */
async function vectorPreFilter(userMessage, activeNodes, embeddingConfig, topK) {
    try {
        const queryVec = await embedText(userMessage, embeddingConfig);
        if (!queryVec) return [];

        const candidates = activeNodes
            .filter(n => n.embedding)
            .map(n => ({ nodeId: n.id, embedding: n.embedding }));

        return searchSimilar(queryVec, candidates, topK);
    } catch (e) {
        console.error('[ST-BME] 向量预筛失败:', e);
        return [];
    }
}

/**
 * 实体锚点提取
 * 从用户消息中提取名词/实体，匹配图中的节点名称
 */
function extractEntityAnchors(userMessage, activeNodes) {
    const anchors = [];

    for (const node of activeNodes) {
        // 检查 name 字段
        const name = node.fields?.name;
        if (name && userMessage.includes(name)) {
            anchors.push({ nodeId: node.id, entity: name });
            continue;
        }

        // 检查 title 字段
        const title = node.fields?.title;
        if (title && userMessage.includes(title)) {
            anchors.push({ nodeId: node.id, entity: title });
        }
    }

    return anchors;
}

/**
 * LLM 精确召回
 */
async function llmRecall(userMessage, recentMessages, candidates, graph, schema, maxNodes) {
    const contextStr = recentMessages.join('\n---\n');
    const candidateDescriptions = candidates.map(c => {
        const node = c.node;
        const typeDef = schema.find(s => s.id === node.type);
        const typeLabel = typeDef?.label || node.type;
        const fieldsStr = Object.entries(node.fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
        return `[${node.id}] 类型=${typeLabel}, ${fieldsStr} (评分=${c.finalScore.toFixed(3)})`;
    }).join('\n');

    const systemPrompt = [
        '你是一个记忆召回分析器。',
        '根据用户最新输入和对话上下文，从候选记忆节点中选择最相关的节点。',
        '优先选择：(1) 直接相关的当前场景节点, (2) 因果关系连续性节点, (3) 有潜在影响的背景节点。',
        `最多选择 ${maxNodes} 个节点。`,
        '输出严格的 JSON 格式：',
        '{"selected_ids": ["id1", "id2", ...], "reason": "简要说明选择理由"}',
    ].join('\n');

    const userPrompt = [
        '## 最近对话上下文',
        contextStr || '(无)',
        '',
        '## 用户最新输入',
        userMessage,
        '',
        '## 候选记忆节点',
        candidateDescriptions,
        '',
        '请选择最相关的节点并输出 JSON。',
    ].join('\n');

    const result = await callLLMForJSON({ systemPrompt, userPrompt, maxRetries: 1 });

    if (result?.selected_ids && Array.isArray(result.selected_ids)) {
        // 校验 ID 有效性
        const validIds = result.selected_ids.filter(
            id => candidates.some(c => c.nodeId === id),
        );
        return validIds;
    }

    // LLM 失败时回退到纯评分排序
    return candidates.slice(0, maxNodes).map(c => c.nodeId);
}

// ==================== v2 辅助函数 ====================

/**
 * ⑥ 认知边界过滤（RoleRAG 启发）
 * 过滤掉设置了 visibility 但不包含当前角色的节点
 * @param {object[]} nodes
 * @param {string} characterName - 当前视角角色名
 * @returns {object[]}
 */
function filterByVisibility(nodes, characterName) {
    return nodes.filter(node => {
        // 没有 visibility 字段 → 对所有人可见
        if (!node.fields?.visibility) return true;
        // visibility 是数组 → 检查当前角色是否在列表中
        if (Array.isArray(node.fields.visibility)) {
            return node.fields.visibility.includes(characterName);
        }
        // visibility 是字符串（逗号分隔）→ 解析后检查
        if (typeof node.fields.visibility === 'string') {
            const visibleTo = node.fields.visibility.split(',').map(s => s.trim());
            return visibleTo.includes(characterName) || visibleTo.includes('*');
        }
        return true;
    });
}

/**
 * 构建最终检索结果
 * 分离常驻注入（Core）和召回注入（Recall）
 */
function buildResult(graph, selectedNodeIds, schema) {
    const coreNodes = [];    // 常驻注入
    const recallNodes = [];  // 召回注入

    // 常驻注入节点（alwaysInject=true 的类型）
    const alwaysInjectTypes = new Set(
        schema.filter(s => s.alwaysInject).map(s => s.id),
    );

    const activeNodes = getActiveNodes(graph);

    for (const node of activeNodes) {
        if (alwaysInjectTypes.has(node.type)) {
            coreNodes.push(node);
        }
    }

    // 召回注入节点
    const selectedSet = new Set(selectedNodeIds);
    for (const nodeId of selectedNodeIds) {
        const node = getNode(graph, nodeId);
        if (!node) continue;
        // 已在 Core 中的不重复添加
        if (!alwaysInjectTypes.has(node.type)) {
            recallNodes.push(node);
        }
    }

    return {
        coreNodes,
        recallNodes,
        selectedNodeIds: [...selectedNodeIds],
        stats: {
            totalActive: activeNodes.length,
            coreCount: coreNodes.length,
            recallCount: recallNodes.length,
        },
    };
}
