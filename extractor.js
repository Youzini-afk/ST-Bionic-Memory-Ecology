// ST-BME: LLM 记忆提取管线（写入路径）
// 分析对话 → 提取节点和关系 → 更新图谱
// v2: 融合 Mem0 精确对照 + Graphiti 时序边 + MemoRAG 全局概要

import { createNode, addNode, updateNode, findLatestNode, createEdge, addEdge, getActiveNodes, invalidateEdge } from './graph.js';
import { embedText, embedBatch, searchSimilar } from './embedding.js';
import { callLLMForJSON } from './llm.js';
import { RELATION_TYPES } from './schema.js';

/**
 * 对未处理的对话楼层执行记忆提取
 *
 * @param {object} params
 * @param {object} params.graph - 当前图状态
 * @param {Array<{role: string, content: string}>} params.messages - 要处理的对话消息
 * @param {number} params.startSeq - 起始楼层号
 * @param {object[]} params.schema - 节点类型 Schema
 * @param {object} params.embeddingConfig - Embedding API 配置
 * @param {string} [params.extractPrompt] - 自定义提取提示词
 * @param {object} [params.v2Options] - v2 增强选项
 * @returns {Promise<{success: boolean, newNodes: number, updatedNodes: number, newEdges: number, newNodeIds: string[]}>}
 */
export async function extractMemories({
    graph,
    messages,
    startSeq,
    schema,
    embeddingConfig,
    extractPrompt,
    v2Options = {},
}) {
    if (!messages || messages.length === 0) {
        return { success: true, newNodes: 0, updatedNodes: 0, newEdges: 0, newNodeIds: [] };
    }

    const enablePreciseConflict = v2Options.enablePreciseConflict ?? true;
    const conflictThreshold = v2Options.conflictThreshold ?? 0.85;

    console.log(`[ST-BME] 提取开始: 楼层 ${startSeq}, ${messages.length} 条消息`);

    // 构建对话文本
    const dialogueText = messages
        .map(m => `[${m.role}]: ${m.content}`)
        .join('\n\n');

    // 构建当前图概览（让 LLM 知道已有哪些节点，避免重复）
    const graphOverview = buildGraphOverview(graph, schema);

    // 构建 Schema 描述
    const schemaDescription = buildSchemaDescription(schema);

    // 系统提示词
    const systemPrompt = extractPrompt || buildDefaultExtractPrompt(schema);

    // 用户提示词
    const userPrompt = [
        '## 当前对话内容（需提取记忆）',
        dialogueText,
        '',
        '## 当前图谱状态',
        graphOverview || '(空图谱，尚无节点)',
        '',
        '## 节点类型定义',
        schemaDescription,
        '',
        '请分析对话，按 JSON 格式输出操作列表。',
    ].join('\n');

    // 调用 LLM
    const result = await callLLMForJSON({ systemPrompt, userPrompt, maxRetries: 2 });

    if (!result || !result.operations) {
        console.warn('[ST-BME] 提取 LLM 未返回有效操作');
        return { success: false, newNodes: 0, updatedNodes: 0, newEdges: 0, newNodeIds: [] };
    }

    // ========== v2: Mem0 精确对照阶段 ==========
    if (enablePreciseConflict && embeddingConfig?.apiUrl) {
        await mem0ConflictCheck(graph, result.operations, embeddingConfig, conflictThreshold);
    }

    // 执行操作
    const stats = { newNodes: 0, updatedNodes: 0, newEdges: 0 };
    const newNodeIds = [];   // v2: 收集新建节点 ID（用于进化引擎）
    const refMap = new Map();

    for (const op of result.operations) {
        try {
            switch (op.action) {
                case 'create': {
                    const createdId = handleCreate(graph, op, startSeq, schema, refMap, stats);
                    if (createdId) newNodeIds.push(createdId);
                    break;
                }
                case 'update':
                    handleUpdate(graph, op, stats);
                    break;
                case 'delete':
                    handleDelete(graph, op, stats);
                    break;
                case '_skip':
                    // Mem0 对照判定为重复，跳过
                    break;
                default:
                    console.warn(`[ST-BME] 未知操作类型: ${op.action}`);
            }
        } catch (e) {
            console.error(`[ST-BME] 操作执行失败:`, op, e);
        }
    }

    // 为新建节点生成 embedding
    await generateNodeEmbeddings(graph, embeddingConfig);

    // 更新处理进度
    graph.lastProcessedSeq = startSeq + messages.filter(m => m.role === 'assistant').length;

    console.log(`[ST-BME] 提取完成: 新建 ${stats.newNodes}, 更新 ${stats.updatedNodes}, 新边 ${stats.newEdges}`);

    return { success: true, ...stats, newNodeIds };
}

/**
 * 处理 create 操作
 */
function handleCreate(graph, op, seq, schema, refMap, stats) {
    const typeDef = schema.find(s => s.id === op.type);
    if (!typeDef) {
        console.warn(`[ST-BME] 未知节点类型: ${op.type}`);
        return null;
    }

    // latestOnly 类型：检查是否已存在同名节点
    if (typeDef.latestOnly && op.fields?.name) {
        const existing = findLatestNode(graph, op.type, op.fields.name);
        if (existing) {
            // 转为更新操作
            updateNode(graph, existing.id, { fields: op.fields, seq });
            stats.updatedNodes++;

            if (op.ref) refMap.set(op.ref, existing.id);

            // 处理关联边
            if (op.links) {
                handleLinks(graph, existing.id, op.links, refMap, stats);
            }
            return null;
        }
    }

    // 创建新节点
    const node = createNode({
        type: op.type,
        fields: op.fields || {},
        seq,
        importance: op.importance ?? 5.0,
        clusters: op.clusters || [],
    });

    addNode(graph, node);
    stats.newNodes++;

    // 保存 ref 用于同批次引用
    if (op.ref) {
        refMap.set(op.ref, node.id);
    }

    // 处理关联边
    if (op.links) {
        handleLinks(graph, node.id, op.links, refMap, stats);
    }

    return node.id;
}

/**
 * 处理 update 操作
 */
function handleUpdate(graph, op, stats) {
    if (!op.nodeId) {
        console.warn('[ST-BME] update 操作缺少 nodeId');
        return;
    }

    const updated = updateNode(graph, op.nodeId, {
        fields: op.fields || {},
    });

    if (updated) {
        stats.updatedNodes++;
        const node = graph.nodes.find(n => n.id === op.nodeId);
        if (node) node.embedding = null;

        // v2 Graphiti: 标记旧的 updates/temporal_update 边为失效
        const oldEdges = graph.edges.filter(e =>
            (e.fromId === op.nodeId || e.toId === op.nodeId) &&
            (e.relation === 'updates' || e.relation === 'temporal_update') &&
            !e.invalidAt
        );
        for (const e of oldEdges) {
            invalidateEdge(e);
        }
    }
}

/**
 * 处理 delete 操作
 */
function handleDelete(graph, op, stats) {
    if (!op.nodeId) return;
    const node = graph.nodes.find(n => n.id === op.nodeId);
    if (node) {
        node.archived = true; // 软删除
    }
}

/**
 * 处理关联边
 */
function handleLinks(graph, sourceId, links, refMap, stats) {
    for (const link of links) {
        let targetId = link.targetNodeId || null;

        // 通过 ref 解析目标节点
        if (!targetId && link.targetRef) {
            targetId = refMap.get(link.targetRef);
        }

        if (!targetId) continue;

        // 验证关系类型
        const relation = RELATION_TYPES.includes(link.relation)
            ? link.relation
            : 'related';

        const edgeType = relation === 'contradicts' ? 255 : 0;

        const edge = createEdge({
            fromId: sourceId,
            toId: targetId,
            relation,
            strength: link.strength ?? 0.8,
            edgeType,
        });

        if (addEdge(graph, edge)) {
            stats.newEdges++;
        }
    }
}

/**
 * 为缺少 embedding 的节点生成向量
 */
async function generateNodeEmbeddings(graph, embeddingConfig) {
    if (!embeddingConfig?.apiUrl) return;

    const needsEmbedding = graph.nodes.filter(n => !n.embedding && !n.archived);

    if (needsEmbedding.length === 0) return;

    const texts = needsEmbedding.map(n => {
        // 用主要字段拼文本
        const parts = [];
        if (n.fields.summary) parts.push(n.fields.summary);
        if (n.fields.name) parts.push(n.fields.name);
        if (n.fields.title) parts.push(n.fields.title);
        if (n.fields.traits) parts.push(n.fields.traits);
        if (n.fields.state) parts.push(n.fields.state);
        if (n.fields.constraint) parts.push(n.fields.constraint);
        return parts.join(' | ') || n.type;
    });

    console.log(`[ST-BME] 为 ${texts.length} 个节点生成 embedding`);

    const embeddings = await embedBatch(texts, embeddingConfig);

    for (let i = 0; i < needsEmbedding.length; i++) {
        if (embeddings[i]) {
            needsEmbedding[i].embedding = Array.from(embeddings[i]);
        }
    }
}

/**
 * 构建图谱概览文本（给 LLM 看）
 */
function buildGraphOverview(graph, schema) {
    const activeNodes = graph.nodes.filter(n => !n.archived);
    if (activeNodes.length === 0) return '';

    const lines = [];
    for (const typeDef of schema) {
        const nodesOfType = activeNodes.filter(n => n.type === typeDef.id);
        if (nodesOfType.length === 0) continue;

        lines.push(`### ${typeDef.label} (${nodesOfType.length} 个节点)`);
        for (const node of nodesOfType.slice(-10)) { // 只展示最近 10 个
            const summary = node.fields.summary || node.fields.name || node.fields.title || '(无)';
            lines.push(`  - [${node.id}] ${summary}`);
        }
    }

    return lines.join('\n');
}

/**
 * 构建 Schema 描述文本
 */
function buildSchemaDescription(schema) {
    return schema.map(t => {
        const cols = t.columns.map(c => `${c.name}${c.required ? '(必填)' : ''}: ${c.hint}`).join('\n    ');
        return `类型 "${t.id}" (${t.label}):\n    ${cols}`;
    }).join('\n\n');
}

/**
 * 构建默认提取提示词
 */
function buildDefaultExtractPrompt(schema) {
    const typeNames = schema.map(s => `${s.id}(${s.label})`).join(', ');

    return [
        '你是一个记忆提取分析器。从对话中提取结构化记忆节点并存入知识图谱。',
        '',
        `支持的节点类型：${typeNames}`,
        '',
        '输出格式为严格 JSON：',
        '{',
        '  "thought": "你对本段对话的分析（事件/角色变化/新信息）",',
        '  "operations": [',
        '    {',
        '      "action": "create",',
        '      "type": "event",',
        '      "fields": {"summary": "...", "participants": "...", "status": "ongoing"},',
        '      "importance": 6,',
        '      "ref": "evt1",',
        '      "links": [',
        '        {"targetNodeId": "existing-id", "relation": "involved_in", "strength": 0.9},',
        '        {"targetRef": "char1", "relation": "occurred_at", "strength": 0.8}',
        '      ]',
        '    },',
        '    {',
        '      "action": "update",',
        '      "nodeId": "existing-node-id",',
        '      "fields": {"state": "新的状态"}',
        '    }',
        '  ]',
        '}',
        '',
        '规则：',
        '- 每批对话最多创建 1 个事件节点，多个子事件合并为一条',
        '- 角色/地点节点：如果图中已有同名节点，用 update 而非 create',
        `- 关系类型限定：${RELATION_TYPES.join(', ')}`,
        '- contradicts 关系用于矛盾/冲突信息',
        '- evolves 关系用于新信息揭示旧记忆需修正的情况',
        '- temporal_update 关系用于实体状态的时序变化',
        '- 不要虚构内容，只提取对话中有证据支持的信息',
        '- importance 范围 1-10，普通事件 5，关键转折 8+',
        '- summary 应该是摘要抽象，不要复制原文',
    ].join('\n');
}

// ==================== v2 增强功能 ====================

/**
 * Mem0 启发的精确对照
 * 对每条 create 操作搜索近邻，高相似度时让 LLM 判断 add/update/skip
 */
async function mem0ConflictCheck(graph, operations, embeddingConfig, threshold) {
    const activeNodes = getActiveNodes(graph).filter(n => n.embedding);
    if (activeNodes.length === 0) return;

    for (const op of operations) {
        if (op.action !== 'create') continue;

        const factText = op.fields?.summary || op.fields?.name || op.fields?.title || '';
        if (!factText) continue;

        try {
            const factVec = await embedText(factText, embeddingConfig);
            if (!factVec) continue;

            const candidates = activeNodes.map(n => ({ nodeId: n.id, embedding: n.embedding }));
            const similar = searchSimilar(factVec, candidates, 3);

            if (similar.length > 0 && similar[0].score > threshold) {
                const topMatch = graph.nodes.find(n => n.id === similar[0].nodeId);
                if (!topMatch) continue;

                const topFields = Object.entries(topMatch.fields)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');

                const decision = await callLLMForJSON({
                    systemPrompt: [
                        '判断新信息与已有记忆的关系。输出严格 JSON：',
                        '{"action": "add"|"update"|"skip", "targetId": "旧节点ID", "mergedFields": {}}',
                        '- add: 新信息完全不同，应新建',
                        '- update: 新信息是对旧记忆的修正/补充',
                        '- skip: 与旧记忆完全重复',
                    ].join('\n'),
                    userPrompt: [
                        `新信息: [${op.type}] ${factText}`,
                        `最相似旧记忆: [${topMatch.id}] 类型=${topMatch.type}, ${topFields}`,
                        `相似度: ${similar[0].score.toFixed(3)}`,
                    ].join('\n'),
                    maxRetries: 1,
                });

                if (decision?.action === 'update' && decision.targetId) {
                    console.log(`[ST-BME] Mem0对照: create->update (${decision.targetId})`);
                    op.action = 'update';
                    op.nodeId = decision.targetId;
                    if (decision.mergedFields) {
                        op.fields = { ...op.fields, ...decision.mergedFields };
                    }
                } else if (decision?.action === 'skip') {
                    console.log('[ST-BME] Mem0对照: create->skip (重复)');
                    op.action = '_skip';
                }
            }
        } catch (e) {
            console.warn('[ST-BME] Mem0对照失败，保持原操作:', e.message);
        }
    }
}

/**
 * 全局故事概要生成（MemoRAG 启发）
 * 基于图中事件/角色/主线自动生成/更新 synopsis 节点
 *
 * @param {object} params
 * @param {object} params.graph
 * @param {object[]} params.schema
 * @param {number} params.currentSeq
 * @returns {Promise<void>}
 */
export async function generateSynopsis({ graph, schema, currentSeq }) {
    const eventNodes = getActiveNodes(graph, 'event')
        .sort((a, b) => a.seq - b.seq);

    if (eventNodes.length < 3) return;

    const eventSummaries = eventNodes.map(n =>
        `[楼${n.seq}] ${n.fields.summary || '(无)'}`,
    ).join('\n');

    const characterNodes = getActiveNodes(graph, 'character');
    const charSummary = characterNodes.map(n =>
        `${n.fields.name}: ${n.fields.state || '(无状态)'}`,
    ).join('; ');

    const threadNodes = getActiveNodes(graph, 'thread');
    const threadSummary = threadNodes.map(n =>
        `${n.fields.title}: ${n.fields.status || 'active'}`,
    ).join('; ');

    const result = await callLLMForJSON({
        systemPrompt: [
            '你是故事概要生成器。根据事件线、角色和主线生成简洁的前情提要。',
            '输出 JSON：{"summary": "前情提要文本（200字以内）"}',
            '要求：涵盖核心冲突、关键转折、主要角色当前状态。',
        ].join('\n'),
        userPrompt: [
            '## 事件时间线',
            eventSummaries,
            '',
            '## 角色状态',
            charSummary || '(无)',
            '',
            '## 活跃主线',
            threadSummary || '(无)',
        ].join('\n'),
        maxRetries: 1,
    });

    if (!result?.summary) return;

    const existingSynopsis = graph.nodes.find(
        n => n.type === 'synopsis' && !n.archived,
    );

    if (existingSynopsis) {
        updateNode(graph, existingSynopsis.id, {
            fields: { summary: result.summary, scope: `楼 1 ~ ${currentSeq}` },
        });
        existingSynopsis.embedding = null;
        console.log('[ST-BME] 全局概要已更新');
    } else {
        const node = createNode({
            type: 'synopsis',
            fields: { summary: result.summary, scope: `楼 1 ~ ${currentSeq}` },
            seq: currentSeq,
            importance: 9.0,
        });
        addNode(graph, node);
        console.log('[ST-BME] 全局概要已创建');
    }
}
