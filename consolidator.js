// ST-BME: 统一记忆整合引擎
// 合并 Mem0 精确对照 + A-MEM 记忆进化为单一阶段
// 每个新节点只需 1 次 embed + 1 次 LLM 调用

import { addEdge, createEdge, getActiveNodes, getNode } from './graph.js';
import { callLLMForJSON } from './llm.js';
import {
    buildNodeVectorText,
    findSimilarNodesByText,
    validateVectorConfig,
} from './vector-index.js';

function createAbortError(message = '操作已终止') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : createAbortError();
    }
}

/**
 * 统一记忆整合系统提示词
 * 同时完成 Mem0 冲突判定 + A-MEM 进化分析
 */
const CONSOLIDATION_SYSTEM_PROMPT = `你是一个记忆整合分析器。当新记忆加入知识图谱时，你需要同时完成两项任务：

**任务一：冲突检测**
判断新记忆与最近邻的已有记忆是否冲突或重复：
- skip: 新记忆与已有记忆完全重复，应丢弃
- merge: 新记忆是对旧记忆的修正或补充，应合并
- keep: 新记忆是全新信息，应保留

**任务二：进化分析**（仅当 action=keep 时需要）
分析新记忆是否揭示了关于旧记忆的新信息：
- 建立有意义的关联连接
- 反向更新旧记忆的描述或分类

输出严格 JSON：
{
  "action": "keep" | "merge" | "skip",
  "merge_target_id": "仅 action=merge 时必填：要合并到的旧节点 ID",
  "merged_fields": { "仅 action=merge 时可选：合并后的字段更新" },
  "reason": "判定理由（简述）",
  "evolution": {
    "should_evolve": true/false,
    "connections": ["需要建立链接的旧记忆 ID 列表"],
    "neighbor_updates": [
      {
        "nodeId": "需更新的旧节点 ID",
        "newContext": "基于新信息修正后的描述（不需修改则为 null）",
        "newTags": ["更新后的分类标签，不需修改则为 null"]
      }
    ]
  }
}

整合规则：
- 当 action=skip 时，evolution 可省略或设 should_evolve=false
- 当 action=merge 时，evolution 可省略或设 should_evolve=false
- 仅当 action=keep 且新信息确实改变了对旧记忆的理解时，才设 should_evolve=true
- 例如：揭露卧底身份 → 修正该角色之前事件中的动机描述
- 例如：发现地点的隐藏特性 → 更新地点节点的描述
- 不要对无关记忆强行建立联系
- neighbor_updates 中每条必须有实际意义的修改`;

/**
 * 统一记忆整合主函数
 *
 * 合并了原先的 mem0ConflictCheck（精确对照）和 evolveMemories（进化），
 * 实现"1 次 embed + 1 次 LLM"完成冲突检测 + 进化分析。
 *
 * @param {object} params
 * @param {object} params.graph - 当前图状态
 * @param {string[]} params.newNodeIds - 本次新创建的节点 ID 列表
 * @param {object} params.embeddingConfig - Embedding API 配置
 * @param {object} [params.options]
 * @param {number} [params.options.neighborCount=5]  - 近邻搜索数量
 * @param {number} [params.options.conflictThreshold=0.85] - 冲突判定阈值（低于此值跳过冲突检测）
 * @param {string} [params.customPrompt] - 自定义提示词
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{merged: number, skipped: number, kept: number, evolved: number, connections: number, updates: number}>}
 */
export async function consolidateMemories({
    graph,
    newNodeIds,
    embeddingConfig,
    options = {},
    customPrompt,
    signal,
}) {
    const neighborCount = options.neighborCount ?? 5;
    const conflictThreshold = options.conflictThreshold ?? 0.85;
    const stats = {
        merged: 0,
        skipped: 0,
        kept: 0,
        evolved: 0,
        connections: 0,
        updates: 0,
    };

    if (!newNodeIds || newNodeIds.length === 0) return stats;
    if (!validateVectorConfig(embeddingConfig).valid) {
        console.log('[ST-BME] 记忆整合跳过：向量配置不可用');
        return stats;
    }

    const activeNodes = getActiveNodes(graph).filter(n => {
        const text = buildNodeVectorText(n);
        return typeof text === 'string' && text.length > 0;
    });

    if (activeNodes.length < 2) return stats;

    for (const newId of newNodeIds) {
        throwIfAborted(signal);
        const newNode = getNode(graph, newId);
        if (!newNode || newNode.archived) continue;

        const queryText = buildNodeVectorText(newNode);
        if (!queryText) continue;

        // 排除自身的候选池
        const candidates = activeNodes.filter(n => n.id !== newId);
        if (candidates.length === 0) {
            stats.kept++;
            continue;
        }

        try {
            // ── 1次 Embed：查近邻 ──
            const neighbors = await findSimilarNodesByText(
                graph,
                queryText,
                embeddingConfig,
                neighborCount,
                candidates,
                signal,
            );

            if (neighbors.length === 0) {
                stats.kept++;
                continue;
            }

            // 构建近邻描述文本
            const neighborsContext = neighbors.map(n => {
                const node = getNode(graph, n.nodeId);
                if (!node) return null;
                const fieldsStr = Object.entries(node.fields)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                return `[${node.id}] 类型=${node.type}, ${fieldsStr}, 相似度=${n.score.toFixed(3)}${
                    (node.clusters || []).length > 0 ? `, 分类=${node.clusters.join('/')}` : ''
                }`;
            }).filter(Boolean).join('\n');

            const newNodeFieldsStr = Object.entries(newNode.fields)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');

            // 检查是否有高相似度命中（决定是否启用冲突检测部分的提示）
            const hasHighSimilarity = neighbors[0].score > conflictThreshold;

            const userPrompt = [
                '## 新加入的记忆',
                `[${newNode.id}] 类型=${newNode.type}, ${newNodeFieldsStr}`,
                '',
                '## 最近邻的已有记忆',
                neighborsContext,
                '',
                `共 ${neighbors.length} 条近邻记忆。`,
                hasHighSimilarity
                    ? `最高相似度 ${neighbors[0].score.toFixed(3)} 超过阈值 ${conflictThreshold}，请先判断是否冲突/重复，再分析进化关系。`
                    : '相似度均较低，请重点分析新记忆是否揭示了关于旧记忆的新信息。',
            ].join('\n');

            // ── 1次 LLM：统一判定 ──
            const decision = await callLLMForJSON({
                systemPrompt: customPrompt || CONSOLIDATION_SYSTEM_PROMPT,
                userPrompt,
                maxRetries: 1,
                signal,
            });

            if (!decision) {
                stats.kept++;
                continue;
            }

            // ── 处理 action ──
            switch (decision.action) {
                case 'skip': {
                    console.log(`[ST-BME] 记忆整合: skip (重复) — ${newId}`);
                    newNode.archived = true;
                    stats.skipped++;
                    break;
                }

                case 'merge': {
                    const targetId = decision.merge_target_id;
                    const targetNode = targetId ? getNode(graph, targetId) : null;

                    if (targetNode && !targetNode.archived) {
                        console.log(`[ST-BME] 记忆整合: merge ${newId} → ${targetId}`);

                        // 合并字段到旧节点
                        if (decision.merged_fields && typeof decision.merged_fields === 'object') {
                            for (const [key, value] of Object.entries(decision.merged_fields)) {
                                if (value != null && value !== '') {
                                    targetNode.fields[key] = value;
                                }
                            }
                        } else {
                            // 如果没提供 merged_fields，将新节点的非空字段补充到旧节点
                            for (const [key, value] of Object.entries(newNode.fields)) {
                                if (value != null && value !== '' && !targetNode.fields[key]) {
                                    targetNode.fields[key] = value;
                                }
                            }
                        }

                        // 更新旧节点的 seq 为更新的值
                        if (Number.isFinite(newNode.seq) && newNode.seq > (targetNode.seq || 0)) {
                            targetNode.seq = newNode.seq;
                        }

                        // 标记旧节点需要 re-embed
                        targetNode.embedding = null;

                        // 归档新节点
                        newNode.archived = true;
                        stats.merged++;
                    } else {
                        // merge target 无效，回退为 keep
                        console.warn(`[ST-BME] 记忆整合: merge target ${targetId} 不存在，回退为 keep`);
                        stats.kept++;
                    }
                    break;
                }

                case 'keep':
                default: {
                    stats.kept++;
                    break;
                }
            }

            // ── 处理 evolution（仅 keep 时有意义，但也容错处理其它 action） ──
            const evolution = decision.evolution;
            if (evolution?.should_evolve && !newNode.archived) {
                stats.evolved++;
                console.log(`[ST-BME] 记忆整合/进化触发: ${decision.reason || '(无理由)'}`);

                // 建立关联边
                if (Array.isArray(evolution.connections)) {
                    for (const targetId of evolution.connections) {
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

                // 反向更新旧节点
                if (Array.isArray(evolution.neighbor_updates)) {
                    for (const update of evolution.neighbor_updates) {
                        if (!update.nodeId) continue;
                        const oldNode = getNode(graph, update.nodeId);
                        if (!oldNode || oldNode.archived) continue;

                        let changed = false;

                        // 更新 context/state 字段
                        if (update.newContext && typeof update.newContext === 'string') {
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
                            oldNode.embedding = null;
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
            }
        } catch (e) {
            if (isAbortError(e)) throw e;
            console.error(`[ST-BME] 记忆整合失败 (${newId}):`, e);
            stats.kept++;
        }
    }

    const actionSummary = [];
    if (stats.merged > 0) actionSummary.push(`合并 ${stats.merged}`);
    if (stats.skipped > 0) actionSummary.push(`跳过 ${stats.skipped}`);
    if (stats.kept > 0) actionSummary.push(`保留 ${stats.kept}`);
    if (stats.evolved > 0) actionSummary.push(`进化 ${stats.evolved}`);
    if (stats.connections > 0) actionSummary.push(`新链接 ${stats.connections}`);
    if (stats.updates > 0) actionSummary.push(`回溯更新 ${stats.updates}`);

    if (actionSummary.length > 0) {
        console.log(`[ST-BME] 记忆整合完成: ${actionSummary.join(', ')}`);
    }

    return stats;
}
