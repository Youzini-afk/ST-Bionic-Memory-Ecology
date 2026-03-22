// ST-BME: 记忆进化引擎（A-MEM 启发）
// 新节点写入后触发，回溯更新相关旧节点的 context/tags/links

import { getActiveNodes, getNode, createEdge, addEdge } from './graph.js';
import { searchSimilar } from './embedding.js';
import { callLLMForJSON } from './llm.js';

/**
 * 进化系统提示词
 * 参考 A-MEM process_memory() 的进化决策 Prompt
 */
const EVOLUTION_SYSTEM_PROMPT = `你是一个记忆进化分析器。当新的记忆加入知识图谱时，你需要分析它与现有记忆的关系。

你的任务：
1. 判断新记忆是否揭示了与旧记忆相关的新信息
2. 如果是，决定如何更新旧记忆的描述和分类
3. 建立新旧记忆之间的有意义连接

输出严格 JSON：
{
  "should_evolve": true/false,
  "reason": "进化理由（简述）",
  "suggested_connections": ["需要建立链接的旧记忆ID列表"],
  "neighbor_updates": [
    {
      "nodeId": "需更新的旧节点ID",
      "newContext": "基于新信息修正后的描述（如不需修改则为null）",
      "newTags": ["更新后的分类标签，如不需修改则为null"]
    }
  ]
}

进化规则：
- 仅当新信息确实改变了对旧记忆的理解时才触发进化
- 例如：揭露卧底身份 → 修正该角色之前事件中的动机描述
- 例如：发现地点的隐藏特性 → 更新地点节点的描述
- 不要对无关记忆强行建立联系
- neighbor_updates 中每条必须有实际意义的修改`;

/**
 * 记忆进化主函数
 *
 * @param {object} params
 * @param {object} params.graph - 当前图状态
 * @param {string[]} params.newNodeIds - 本次新创建的节点 ID 列表
 * @param {object} params.embeddingConfig - Embedding API 配置
 * @param {object} [params.options]
 * @returns {Promise<{evolved: number, connections: number, updates: number}>}
 */
export async function evolveMemories({
    graph,
    newNodeIds,
    embeddingConfig,
    options = {},
}) {
    const neighborCount = options.neighborCount ?? 5;
    const stats = { evolved: 0, connections: 0, updates: 0 };

    if (!newNodeIds || newNodeIds.length === 0) return stats;
    if (!embeddingConfig?.apiUrl) {
        console.log('[ST-BME] 记忆进化跳过：未配置 Embedding API');
        return stats;
    }

    const activeNodes = getActiveNodes(graph);
    if (activeNodes.length < 2) return stats; // 至少需要 2 个节点才有进化意义

    for (const newId of newNodeIds) {
        const newNode = getNode(graph, newId);
        if (!newNode || !newNode.embedding) continue;

        // 找最近邻（排除自身）
        const candidates = activeNodes
            .filter(n => n.id !== newId && n.embedding)
            .map(n => ({ nodeId: n.id, embedding: n.embedding }));

        if (candidates.length === 0) continue;

        const neighbors = searchSimilar(newNode.embedding, candidates, neighborCount);
        if (neighbors.length === 0) continue;

        // 构建 LLM 上下文
        const neighborsContext = neighbors.map(n => {
            const node = getNode(graph, n.nodeId);
            if (!node) return null;
            const fieldsStr = Object.entries(node.fields)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            return `[${node.id}] 类型=${node.type}, ${fieldsStr}, 分类=${(node.clusters || []).join('/')}`;
        }).filter(Boolean).join('\n');

        const newNodeFieldsStr = Object.entries(newNode.fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');

        const userPrompt = [
            '## 新加入的记忆',
            `[${newNode.id}] 类型=${newNode.type}, ${newNodeFieldsStr}`,
            '',
            '## 最近邻的已有记忆',
            neighborsContext,
            '',
            `共 ${neighbors.length} 条近邻记忆。请分析新记忆是否揭示了关于旧记忆的新信息。`,
        ].join('\n');

        try {
            const decision = await callLLMForJSON({
                systemPrompt: EVOLUTION_SYSTEM_PROMPT,
                userPrompt,
                maxRetries: 1,
            });

            if (!decision || !decision.should_evolve) continue;

            stats.evolved++;
            console.log(`[ST-BME] 记忆进化触发: ${decision.reason || '(无理由)'}`);

            // 1. 建立链接（strengthen）
            if (decision.suggested_connections && Array.isArray(decision.suggested_connections)) {
                for (const targetId of decision.suggested_connections) {
                    // 验证目标节点存在
                    if (!getNode(graph, targetId)) continue;
                    const edge = createEdge({
                        fromId: newId,
                        toId: targetId,
                        relation: 'related',
                        strength: 0.7,
                    });
                    if (addEdge(graph, edge)) {
                        stats.connections++;
                    }
                }
            }

            // 2. 反向更新旧节点（update_neighbor）
            if (decision.neighbor_updates && Array.isArray(decision.neighbor_updates)) {
                for (const update of decision.neighbor_updates) {
                    if (!update.nodeId) continue;
                    const oldNode = getNode(graph, update.nodeId);
                    if (!oldNode) continue;

                    let changed = false;

                    // 更新 context/state 字段
                    if (update.newContext && typeof update.newContext === 'string') {
                        // 根据节点类型选择更新哪个字段
                        if (oldNode.fields.state !== undefined) {
                            oldNode.fields.state = update.newContext;
                            changed = true;
                        } else if (oldNode.fields.summary !== undefined) {
                            oldNode.fields.summary = update.newContext;
                            changed = true;
                        } else if (oldNode.fields.core_note !== undefined) {
                            oldNode.fields.core_note = update.newContext;
                            changed = true;
                        }
                    }

                    // 更新分类标签
                    if (update.newTags && Array.isArray(update.newTags)) {
                        oldNode.clusters = update.newTags;
                        changed = true;
                    }

                    if (changed) {
                        // 标记需要重新生成 embedding
                        oldNode.embedding = null;
                        // 记录进化历史
                        if (!oldNode._evolutionHistory) oldNode._evolutionHistory = [];
                        oldNode._evolutionHistory.push({
                            triggeredBy: newId,
                            timestamp: Date.now(),
                            reason: decision.reason || '',
                        });
                        stats.updates++;
                    }
                }
            }

        } catch (e) {
            console.error(`[ST-BME] 记忆进化失败 (${newId}):`, e);
        }
    }

    if (stats.evolved > 0) {
        console.log(
            `[ST-BME] 记忆进化完成: ${stats.evolved} 次进化, ` +
            `${stats.connections} 条新链接, ${stats.updates} 个节点回溯更新`,
        );
    }

    return stats;
}
