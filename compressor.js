// ST-BME: 层级压缩引擎
// 超过阈值的节点被 LLM 总结为更高层级的压缩节点

import { embedText } from "./embedding.js";
import {
  addEdge,
  addNode,
  createEdge,
  createNode,
  getActiveNodes,
  getNode,
} from "./graph.js";
import { callLLMForJSON } from "./llm.js";
import { buildTaskPrompt } from "./prompt-builder.js";
import { getSTContextForPrompt } from "./st-context.js";
import { applyTaskRegex } from "./task-regex.js";
import { isDirectVectorConfig } from "./vector-index.js";

function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

/**
 * 对指定类型执行层级压缩
 *
 * @param {object} params
 * @param {object} params.graph - 当前图状态
 * @param {object} params.typeDef - 要压缩的类型定义
 * @param {object} params.embeddingConfig - Embedding API 配置
 * @param {boolean} [params.force=false] - 忽略阈值强制压缩
 * @returns {Promise<{created: number, archived: number}>}
 */
export async function compressType({
  graph,
  typeDef,
  embeddingConfig,
  force = false,
  customPrompt,
  signal,
  settings = {},
}) {
  const compression = typeDef.compression;
  if (!compression || compression.mode !== "hierarchical") {
    return { created: 0, archived: 0 };
  }

  let totalCreated = 0;
  let totalArchived = 0;

  // 从最低层级开始逐层压缩
  for (let level = 0; level < compression.maxDepth; level++) {
    throwIfAborted(signal);
    const result = await compressLevel({
      graph,
      typeDef,
      level,
      embeddingConfig,
      force,
      customPrompt,
      signal,
      settings,
    });

    totalCreated += result.created;
    totalArchived += result.archived;

    // 如果这一层没有压缩发生，停止
    if (result.created === 0) break;
  }

  return { created: totalCreated, archived: totalArchived };
}

/**
 * 压缩特定层级的节点
 */
async function compressLevel({
  graph,
  typeDef,
  level,
  embeddingConfig,
  force,
  customPrompt,
  signal,
  settings = {},
}) {
  const compression = typeDef.compression;
  throwIfAborted(signal);

  // 获取该层级的活跃叶子节点
  const levelNodes = getActiveNodes(graph, typeDef.id)
    .filter((n) => n.level === level)
    .sort((a, b) => a.seq - b.seq);

  const threshold = force
    ? Math.max(2, compression.fanIn)
    : compression.threshold;
  const keepRecent = force ? 0 : compression.keepRecentLeaves;

  // 不够阈值，无需压缩
  if (levelNodes.length <= threshold) {
    return { created: 0, archived: 0 };
  }

  // 排除最近的节点
  const compressible = levelNodes.slice(0, levelNodes.length - keepRecent);
  if (compressible.length < compression.fanIn) {
    return { created: 0, archived: 0 };
  }

  let created = 0;
  let archived = 0;

  // 按 fanIn 分组压缩
  for (let i = 0; i < compressible.length; i += compression.fanIn) {
    const batch = compressible.slice(i, i + compression.fanIn);
    if (batch.length < 2) break; // 至少 2 个才压缩

    // 调用 LLM 总结
    const summaryResult = await summarizeBatch(
      batch,
      typeDef,
      customPrompt,
      signal,
      settings,
    );
    if (!summaryResult) continue;

    // 创建压缩节点
    const compressedNode = createNode({
      type: typeDef.id,
      fields: summaryResult.fields,
      seq: batch[batch.length - 1].seq,
      seqRange: [
        batch[0].seqRange?.[0] ?? batch[0].seq,
        batch[batch.length - 1].seqRange?.[1] ?? batch[batch.length - 1].seq,
      ],
      importance: Math.max(...batch.map((n) => n.importance)),
    });

    compressedNode.level = level + 1;
    compressedNode.childIds = batch.map((n) => n.id);

    // 生成 embedding
    if (isDirectVectorConfig(embeddingConfig) && summaryResult.fields.summary) {
      const vec = await embedText(
        summaryResult.fields.summary,
        embeddingConfig,
        { signal },
      );
      if (vec) compressedNode.embedding = Array.from(vec);
    }

    addNode(graph, compressedNode);
    migrateBatchEdges(graph, batch, compressedNode);
    created++;

    // 归档子节点
    for (const child of batch) {
      child.archived = true;
      child.parentId = compressedNode.id;
      archived++;
    }
  }

  return { created, archived };
}

function migrateBatchEdges(graph, batch, compressedNode) {
  const batchIds = new Set(batch.map((node) => node.id));

  for (const edge of graph.edges) {
    if (edge.invalidAt || edge.expiredAt) continue;

    const fromInside = batchIds.has(edge.fromId);
    const toInside = batchIds.has(edge.toId);
    if (!fromInside && !toInside) continue;
    if (fromInside && toInside) continue;

    const newFromId = fromInside ? compressedNode.id : edge.fromId;
    const newToId = toInside ? compressedNode.id : edge.toId;

    if (newFromId === newToId) continue;
    if (!getNode(graph, newFromId) || !getNode(graph, newToId)) continue;

    const migratedEdge = createEdge({
      fromId: newFromId,
      toId: newToId,
      relation: edge.relation,
      strength: edge.strength,
      edgeType: edge.edgeType,
    });
    migratedEdge.validAt = edge.validAt ?? migratedEdge.validAt;
    migratedEdge.invalidAt = edge.invalidAt ?? migratedEdge.invalidAt;
    migratedEdge.expiredAt = edge.expiredAt ?? migratedEdge.expiredAt;

    addEdge(graph, migratedEdge);
  }
}

/**
 * 调用 LLM 总结一批节点
 */
async function summarizeBatch(
  nodes,
  typeDef,
  customPrompt,
  signal,
  settings = {},
) {
  const nodeDescriptions = nodes
    .map((n, i) => {
      const fieldsStr = Object.entries(n.fields)
        .filter(([_, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n    ");
      return `节点 ${i + 1} [楼层 ${n.seq}]:\n    ${fieldsStr}`;
    })
    .join("\n\n");

  const instruction =
    typeDef.compression.instruction || "将以下节点压缩总结为一条精炼记录。";

  const compressPromptBuild = await buildTaskPrompt(settings, "compress", {
    taskName: "compress",
    nodeContent: nodeDescriptions,
    candidateNodes: nodeDescriptions,
    currentRange: `${nodes[0]?.seq ?? "?"} ~ ${nodes[nodes.length - 1]?.seq ?? "?"}`,
    graphStats: `node_count=${nodes.length}, node_type=${typeDef.id}`,
    ...getSTContextForPrompt(),
  });
  const systemPrompt = applyTaskRegex(
    settings,
    "compress",
    "finalPrompt",
    compressPromptBuild.systemPrompt ||
      customPrompt ||
      [
        "你是一个记忆压缩器。将多个同类型节点总结为一条更高层级的压缩节点。",
        instruction,
        "",
        "输出格式为严格 JSON：",
        `{"fields": {${typeDef.columns.map((c) => `"${c.name}": "..."`).join(", ")}}}`,
        "",
        "规则：",
        "- 保留关键信息：因果关系、不可逆结果、未解决伏笔",
        "- 去除重复和低信息密度内容",
        "- 压缩后文本应精炼，目标 150 字左右",
      ].join("\n"),
  );

  const userPrompt = `请压缩以下 ${nodes.length} 个 "${typeDef.label}" 节点：\n\n${nodeDescriptions}`;

  return await callLLMForJSON({
    systemPrompt,
    userPrompt,
    maxRetries: 1,
    signal,
    taskType: "compress",
    additionalMessages: [
      ...(compressPromptBuild.customMessages || []),
      ...(compressPromptBuild.additionalMessages || []),
    ],
  });
}

/**
 * 对所有支持压缩的类型执行压缩
 *
 * @param {object} graph
 * @param {object[]} schema
 * @param {object} embeddingConfig
 * @param {boolean} [force=false]
 * @returns {Promise<{created: number, archived: number}>}
 */
export async function compressAll(
  graph,
  schema,
  embeddingConfig,
  force = false,
  customPrompt,
  signal,
  settings = {},
) {
  let totalCreated = 0;
  let totalArchived = 0;

  for (const typeDef of schema) {
    throwIfAborted(signal);
    if (typeDef.compression?.mode === "hierarchical") {
      const result = await compressType({
        graph,
        typeDef,
        embeddingConfig,
        force,
        customPrompt,
        signal,
        settings,
      });
      totalCreated += result.created;
      totalArchived += result.archived;
    }
  }

  return { created: totalCreated, archived: totalArchived };
}

// ==================== v2: 主动遗忘（SleepGate 启发） ====================

/**
 * 睡眠清理周期
 * 评估每个节点的保留价值，低于阈值的归档（遗忘）
 *
 * @param {object} graph - 图状态
 * @param {object} settings - 包含 forgetThreshold 的设置
 * @returns {{forgotten: number}} 本次遗忘的节点数
 */
export function sleepCycle(graph, settings) {
  const threshold = settings.forgetThreshold ?? 0.5;
  const nodes = getActiveNodes(graph);
  const now = Date.now();
  let forgotten = 0;

  for (const node of nodes) {
    // 跳过常驻类型（synopsis, rule 等重要节点不应被遗忘）
    if (
      node.type === "synopsis" ||
      node.type === "rule" ||
      node.type === "thread"
    )
      continue;
    // 跳过高重要性节点
    if (node.importance >= 8) continue;
    // 跳过最近创建的节点（< 1 小时）
    if (now - node.createdTime < 3600000) continue;

    // 计算保留价值 = importance × recency × (1 + accessFreq)
    const ageHours = (now - node.createdTime) / 3600000;
    const recency = 1 / (1 + Math.log10(1 + ageHours));
    const accessFreq = node.accessCount / Math.max(1, ageHours / 24);
    const retentionValue = (node.importance / 10) * recency * (1 + accessFreq);

    if (retentionValue < threshold) {
      node.archived = true;
      forgotten++;
    }
  }

  if (forgotten > 0) {
    console.log(`[ST-BME] 主动遗忘: ${forgotten} 个低价值节点已归档`);
  }

  return { forgotten };
}
