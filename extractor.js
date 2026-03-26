// ST-BME: LLM 记忆提取管线（写入路径）
// 分析对话 → 提取节点和关系 → 更新图谱
// v2: 融合 Mem0 精确对照 + Graphiti 时序边 + MemoRAG 全局概要

import { embedBatch } from "./embedding.js";
import {
  addEdge,
  addNode,
  createEdge,
  createNode,
  findLatestNode,
  getActiveNodes,
  getNode,
  invalidateEdge,
  updateNode,
} from "./graph.js";
import { callLLMForJSON } from "./llm.js";
import { ensureEventTitle, getNodeDisplayName } from "./node-labels.js";
import { buildTaskPrompt } from "./prompt-builder.js";
import { RELATION_TYPES } from "./schema.js";
import { applyTaskRegex } from "./task-regex.js";
import { getSTContextForPrompt } from "./st-context.js";
import { buildNodeVectorText, isDirectVectorConfig } from "./vector-index.js";

function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

/**
 * 对未处理的对话楼层执行记忆提取
 *
 * @param {object} params
 * @param {object} params.graph - 当前图状态
 * @param {Array<{seq?: number, role: string, content: string}>} params.messages - 要处理的对话消息
 * @param {number} params.startSeq - 本批处理的首个 assistant 消息 chat 索引
 * @param {number} params.endSeq - 本批处理的末个 assistant 消息 chat 索引
 * @param {number} [params.lastProcessedSeq] - 上次处理到的 chat 索引
 * @param {object[]} params.schema - 节点类型 Schema
 * @param {object} params.embeddingConfig - Embedding API 配置
 * @param {string} [params.extractPrompt] - 自定义提取提示词
 * @param {object} [params.v2Options] - v2 增强选项
 * @returns {Promise<{success: boolean, newNodes: number, updatedNodes: number, newEdges: number, newNodeIds: string[], processedRange: [number, number]}>}
 */
export async function extractMemories({
  graph,
  messages,
  startSeq,
  endSeq,
  lastProcessedSeq = -1,
  schema,
  embeddingConfig,
  extractPrompt,
  signal = undefined,
  settings = {},
}) {
  throwIfAborted(signal);
  if (!messages || messages.length === 0) {
    return {
      success: true,
      newNodes: 0,
      updatedNodes: 0,
      newEdges: 0,
      newNodeIds: [],
      processedRange: [lastProcessedSeq, lastProcessedSeq],
    };
  }

  const effectiveStartSeq = Number.isFinite(startSeq)
    ? startSeq
    : (messages.find((m) => Number.isFinite(m.seq))?.seq ??
      lastProcessedSeq + 1);
  const effectiveEndSeq = Number.isFinite(endSeq)
    ? endSeq
    : ([...messages].reverse().find((m) => Number.isFinite(m.seq))?.seq ??
      effectiveStartSeq);
  const currentSeq = effectiveEndSeq;

  console.log(
    `[ST-BME] 提取开始: chat[${effectiveStartSeq}..${effectiveEndSeq}], ${messages.length} 条消息`,
  );

  // 构建对话文本
  const dialogueText = messages
    .map((m) => {
      const seqLabel = Number.isFinite(m.seq) ? `#${m.seq}` : "#?";
      return `${seqLabel} [${m.role}]: ${m.content}`;
    })
    .join("\n\n");

  // 构建当前图概览（让 LLM 知道已有哪些节点，避免重复）
  const graphOverview = buildGraphOverview(graph, schema);

  // 构建 Schema 描述
  const schemaDescription = buildSchemaDescription(schema);
  const currentRange =
    messages.length > 0
      ? `${messages[0]?.seq ?? "?"} ~ ${messages[messages.length - 1]?.seq ?? "?"}`
      : "";

  const promptBuild = buildTaskPrompt(settings, "extract", {
    taskName: "extract",
    schema: schemaDescription,
    schemaDescription,
    recentMessages: dialogueText,
    dialogueText,
    graphStats: graphOverview,
    graphOverview,
    currentRange,
    ...getSTContextForPrompt(),
  });

  // 系统提示词
  const systemPrompt = applyTaskRegex(
    settings,
    "extract",
    "finalPrompt",
    promptBuild.systemPrompt ||
      extractPrompt ||
      buildDefaultExtractPrompt(schema),
  );

  // 用户提示词
  const userPrompt = [
    "## 当前对话内容（需提取记忆）",
    dialogueText,
    "",
    "## 当前图谱状态",
    graphOverview || "(空图谱，尚无节点)",
    "",
    "## 节点类型定义",
    schemaDescription,
    "",
    "请分析对话，按 JSON 格式输出操作列表。",
  ].join("\n");

  // 调用 LLM
  const result = await callLLMForJSON({
    systemPrompt,
    userPrompt,
    maxRetries: 2,
    signal,
    taskType: "extract",
    additionalMessages: promptBuild.customMessages || [],
  });
  throwIfAborted(signal);

  if (!result || !Array.isArray(result.operations)) {
    console.warn("[ST-BME] 提取 LLM 未返回有效操作");
    return {
      success: false,
      error: "提取 LLM 未返回有效操作",
      newNodes: 0,
      updatedNodes: 0,
      newEdges: 0,
      newNodeIds: [],
      processedRange: [lastProcessedSeq, lastProcessedSeq],
    };
  }

  // 执行操作
  const stats = { newNodes: 0, updatedNodes: 0, newEdges: 0 };
  const newNodeIds = []; // v2: 收集新建节点 ID（用于进化引擎）
  const refMap = new Map();
  const operationErrors = [];

  for (const op of result.operations) {
    try {
      switch (op.action) {
        case "create": {
          const createdId = handleCreate(
            graph,
            op,
            currentSeq,
            schema,
            refMap,
            stats,
          );
          if (createdId) newNodeIds.push(createdId);
          break;
        }
        case "update":
          handleUpdate(graph, op, currentSeq, stats);
          break;
        case "delete":
          handleDelete(graph, op, stats);
          break;
        case "_skip":
          // Mem0 对照判定为重复，跳过
          break;
        default: {
          const message = `[ST-BME] 未知操作类型: ${op?.action ?? "<missing>"}`;
          console.warn(message, op);
          operationErrors.push(message);
          break;
        }
      }
    } catch (e) {
      console.error(`[ST-BME] 操作执行失败:`, op, e);
      operationErrors.push(e?.message || String(e));
    }
  }

  if (operationErrors.length > 0) {
    return {
      success: false,
      error: operationErrors.join(" | "),
      ...stats,
      newNodeIds,
      processedRange: [effectiveStartSeq, effectiveEndSeq],
    };
  }

  // 为新建节点生成 embedding。失败不应回滚整批图谱写入。
  try {
    await generateNodeEmbeddings(graph, embeddingConfig, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    console.error("[ST-BME] 节点 embedding 生成失败，保留图谱写入:", error);
  }

  // 更新处理进度：统一记录为已处理到的末个 chat 索引
  graph.lastProcessedSeq = Math.max(
    graph.lastProcessedSeq ?? -1,
    effectiveEndSeq,
  );

  console.log(
    `[ST-BME] 提取完成: 新建 ${stats.newNodes}, 更新 ${stats.updatedNodes}, 新边 ${stats.newEdges}, lastProcessedSeq=${graph.lastProcessedSeq}`,
  );

  return {
    success: true,
    error: "",
    ...stats,
    newNodeIds,
    processedRange: [effectiveStartSeq, effectiveEndSeq],
  };
}

/**
 * 处理 create 操作
 */
function handleCreate(graph, op, seq, schema, refMap, stats) {
  const normalizedFields =
    op.type === "event" ? ensureEventTitle(op.fields || {}) : op.fields || {};
  const typeDef = schema.find((s) => s.id === op.type);
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
    fields: normalizedFields,
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
function handleUpdate(graph, op, currentSeq, stats) {
  if (!op.nodeId) {
    console.warn("[ST-BME] update 操作缺少 nodeId");
    return;
  }

  const previousNode = getNode(graph, op.nodeId);
  if (!previousNode) {
    console.warn(`[ST-BME] update 目标节点不存在: ${op.nodeId}`);
    return;
  }

  const previousFields = { ...(previousNode.fields || {}) };
  const nextFields =
    previousNode.type === "event"
      ? ensureEventTitle({ ...previousFields, ...(op.fields || {}) })
      : { ...previousFields, ...(op.fields || {}) };
  const changeSummary = buildFieldChangeSummary(previousFields, nextFields);

  const updateSeq = Number.isFinite(op.seq) ? op.seq : currentSeq;
  const updated = updateNode(graph, op.nodeId, {
    fields: op.fields || {},
    seq: Math.max(previousNode.seq || 0, updateSeq),
  });

  if (updated) {
    stats.updatedNodes++;
    const node = getNode(graph, op.nodeId);
    if (node) {
      node.embedding = null;
      node.seq = Math.max(node.seq || 0, updateSeq);
      node.seqRange = [
        Math.min(node.seqRange?.[0] ?? node.seq, updateSeq),
        Math.max(node.seqRange?.[1] ?? node.seq, updateSeq),
      ];
    }

    // v2 Graphiti: 标记旧的 updates/temporal_update 边为失效
    const oldEdges = graph.edges.filter(
      (e) =>
        !e.invalidAt &&
        ((e.relation === "updates" && e.toId === op.nodeId) ||
          (e.relation === "temporal_update" &&
            e.toId === op.nodeId &&
            op.sourceNodeId &&
            e.fromId === op.sourceNodeId)),
    );
    for (const e of oldEdges) {
      invalidateEdge(e);
    }

    if (op.sourceNodeId && op.sourceNodeId !== op.nodeId) {
      const temporalEdge = createEdge({
        fromId: op.sourceNodeId,
        toId: op.nodeId,
        relation: "temporal_update",
        strength: op.temporalStrength ?? 0.95,
        edgeType: 0,
      });
      if (addEdge(graph, temporalEdge)) {
        stats.newEdges++;
      }
    }

    if (changeSummary) {
      const updateEventNode = createNode({
        type: "event",
        fields: {
          title: `${previousNode.fields?.name || previousNode.fields?.title || previousNode.type} 状态更新`,
          summary: `${previousNode.type} 状态更新：${changeSummary}`,
          participants:
            previousNode.fields?.name ||
            previousNode.fields?.title ||
            previousNode.id,
          status: "resolved",
        },
        seq: updateSeq,
        importance: Math.max(
          4,
          Math.min(8, op.importance ?? previousNode.importance ?? 5),
        ),
      });
      addNode(graph, updateEventNode);
      stats.newNodes++;

      const updateEdge = createEdge({
        fromId: updateEventNode.id,
        toId: op.nodeId,
        relation: "updates",
        strength: 0.9,
        edgeType: 0,
      });
      if (addEdge(graph, updateEdge)) {
        stats.newEdges++;
      }
    }
  }
}

function buildFieldChangeSummary(previousFields = {}, nextFields = {}) {
  const changes = [];
  const keys = new Set([
    ...Object.keys(previousFields),
    ...Object.keys(nextFields),
  ]);

  for (const key of keys) {
    const before = previousFields[key];
    const after = nextFields[key];
    if (before === after) continue;

    const beforeText = before == null || before === "" ? "空" : String(before);
    const afterText = after == null || after === "" ? "空" : String(after);
    changes.push(`${key}: ${beforeText} -> ${afterText}`);
  }

  return changes.slice(0, 3).join("；");
}

/**
 * 处理 delete 操作
 */
function handleDelete(graph, op, stats) {
  if (!op.nodeId) return;
  const node = graph.nodes.find((n) => n.id === op.nodeId);
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
      : "related";

    const edgeType = relation === "contradicts" ? 255 : 0;

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
async function generateNodeEmbeddings(graph, embeddingConfig, signal) {
  if (!isDirectVectorConfig(embeddingConfig)) return;
  throwIfAborted(signal);

  const needsEmbedding = graph.nodes.filter(
    (n) =>
      !n.archived && (!Array.isArray(n.embedding) || n.embedding.length === 0),
  );

  if (needsEmbedding.length === 0) return;

  const texts = needsEmbedding.map(
    (node) => buildNodeVectorText(node) || node.type,
  );

  console.log(`[ST-BME] 为 ${texts.length} 个节点生成 embedding`);

  const embeddings = await embedBatch(texts, embeddingConfig, { signal });

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
  const activeNodes = graph.nodes
    .filter((n) => !n.archived)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  if (activeNodes.length === 0) return "";

  const lines = [];
  for (const typeDef of schema) {
    const nodesOfType = activeNodes.filter((n) => n.type === typeDef.id);
    if (nodesOfType.length === 0) continue;

    lines.push(`### ${typeDef.label} (${nodesOfType.length} 个节点)`);
    for (const node of nodesOfType.slice(-10)) {
      // 只展示最近 10 个
      lines.push(`  - [${node.id}] ${getNodeDisplayName(node)}`);
    }
  }

  return lines.join("\n");
}

/**
 * 构建 Schema 描述文本
 */
function buildSchemaDescription(schema) {
  return schema
    .map((t) => {
      const cols = t.columns
        .map((c) => `${c.name}${c.required ? "(必填)" : ""}: ${c.hint}`)
        .join("\n    ");
      return `类型 "${t.id}" (${t.label}):\n    ${cols}`;
    })
    .join("\n\n");
}

/**
 * 构建默认提取提示词
 */
function buildDefaultExtractPrompt(schema) {
  const typeNames = schema.map((s) => `${s.id}(${s.label})`).join(", ");

  return [
    "你是一个记忆提取分析器。从对话中提取结构化记忆节点并存入知识图谱。",
    "",
    `支持的节点类型：${typeNames}`,
    "",
    "输出格式为严格 JSON：",
    "{",
    '  "thought": "你对本段对话的分析（事件/角色变化/新信息）",',
    '  "operations": [',
    "    {",
    '      "action": "create",',
    '      "type": "event",',
    '      "fields": {"title": "简短事件名", "summary": "...", "participants": "...", "status": "ongoing"},',
    '      "importance": 6,',
    '      "ref": "evt1",',
    '      "links": [',
    '        {"targetNodeId": "existing-id", "relation": "involved_in", "strength": 0.9},',
    '        {"targetRef": "char1", "relation": "occurred_at", "strength": 0.8}',
    "      ]",
    "    },",
    "    {",
    '      "action": "update",',
    '      "nodeId": "existing-node-id",',
    '      "fields": {"state": "新的状态"}',
    "    }",
    "  ]",
    "}",
    "",
    "规则：",
    "- 每批对话最多创建 1 个事件节点，多个子事件合并为一条",
    "- 角色/地点节点：如果图中已有同名节点，用 update 而非 create",
    `- 关系类型限定：${RELATION_TYPES.join(", ")}`,
    "- contradicts 关系用于矛盾/冲突信息",
    "- evolves 关系用于新信息揭示旧记忆需修正的情况",
    "- temporal_update 关系用于实体状态的时序变化",
    "- 不要虚构内容，只提取对话中有证据支持的信息",
    "- importance 范围 1-10，普通事件 5，关键转折 8+",
    "- event.fields.title 需要是简短事件名，建议 6-18 字，只用于图谱和列表显示",
    "- summary 应该是摘要抽象，不要复制原文",
  ].join("\n");
}

// ==================== v2 增强功能 ====================

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
export async function generateSynopsis({
  graph,
  schema,
  currentSeq,
  customPrompt,
  signal,
  settings = {},
}) {
  const eventNodes = getActiveNodes(graph, "event").sort(
    (a, b) => a.seq - b.seq,
  );

  if (eventNodes.length < 3) return;

  const eventSummaries = eventNodes
    .map((n) => `[楼${n.seq}] ${n.fields.summary || "(无)"}`)
    .join("\n");

  const characterNodes = getActiveNodes(graph, "character");
  const charSummary = characterNodes
    .map((n) => `${n.fields.name}: ${n.fields.state || "(无状态)"}`)
    .join("; ");

  const threadNodes = getActiveNodes(graph, "thread");
  const threadSummary = threadNodes
    .map((n) => `${n.fields.title}: ${n.fields.status || "active"}`)
    .join("; ");

  const synopsisPromptBuild = buildTaskPrompt(settings, "synopsis", {
    taskName: "synopsis",
    eventSummary: eventSummaries,
    characterSummary: charSummary || "(无)",
    threadSummary: threadSummary || "(无)",
    graphStats: `event=${eventNodes.length}, character=${characterNodes.length}, thread=${threadNodes.length}`,
    ...getSTContextForPrompt(),
  });
  const synopsisSystemPrompt = applyTaskRegex(
    settings,
    "synopsis",
    "finalPrompt",
    synopsisPromptBuild.systemPrompt ||
      customPrompt ||
      [
        "你是故事概要生成器。根据事件线、角色和主线生成简洁的前情提要。",
        '输出 JSON：{"summary": "前情提要文本（200字以内）"}',
        "要求：涵盖核心冲突、关键转折、主要角色当前状态。",
      ].join("\n"),
  );

  const result = await callLLMForJSON({
    systemPrompt: synopsisSystemPrompt,
    userPrompt: [
      "## 事件时间线",
      eventSummaries,
      "",
      "## 角色状态",
      charSummary || "(无)",
      "",
      "## 活跃主线",
      threadSummary || "(无)",
    ].join("\n"),
    maxRetries: 1,
    signal,
    taskType: "synopsis",
    additionalMessages: synopsisPromptBuild.customMessages || [],
  });

  if (!result?.summary) return;

  const existingSynopsis = graph.nodes.find(
    (n) => n.type === "synopsis" && !n.archived,
  );

  if (existingSynopsis) {
    updateNode(graph, existingSynopsis.id, {
      fields: { summary: result.summary, scope: `楼 1 ~ ${currentSeq}` },
      seq: Math.max(existingSynopsis.seq || 0, currentSeq),
    });
    existingSynopsis.seqRange = [
      Math.min(existingSynopsis.seqRange?.[0] ?? currentSeq, currentSeq),
      Math.max(existingSynopsis.seqRange?.[1] ?? currentSeq, currentSeq),
    ];
    existingSynopsis.embedding = null;
    console.log("[ST-BME] 全局概要已更新");
  } else {
    const node = createNode({
      type: "synopsis",
      fields: { summary: result.summary, scope: `楼 1 ~ ${currentSeq}` },
      seq: currentSeq,
      importance: 9.0,
    });
    addNode(graph, node);
    console.log("[ST-BME] 全局概要已创建");
  }
}

export async function generateReflection({
  graph,
  currentSeq,
  customPrompt,
  signal,
  settings = {},
}) {
  const recentEvents = getActiveNodes(graph, "event")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 6)
    .reverse();

  if (recentEvents.length < 2) return null;

  const recentCharacters = getActiveNodes(graph, "character")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 5);

  const recentThreads = getActiveNodes(graph, "thread")
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 4);

  const contradictEdges = graph.edges
    .filter((e) => e.relation === "contradicts" && !e.invalidAt)
    .slice(-5);

  const eventSummary = recentEvents
    .map((n) => `[楼${n.seq}] ${n.fields.summary || "(无)"}`)
    .join("\n");
  const characterSummary = recentCharacters
    .map(
      (n) =>
        `${n.fields.name || n.fields.title || n.id}: ${n.fields.state || n.fields.summary || "(无)"}`,
    )
    .join("\n");
  const threadSummary = recentThreads
    .map(
      (n) =>
        `${n.fields.title || n.fields.name || n.id}: ${n.fields.status || n.fields.summary || "active"}`,
    )
    .join("\n");
  const contradictionSummary = contradictEdges
    .map((e) => `${e.fromId} -> ${e.toId} (${e.relation})`)
    .join("\n");

  const reflectionPromptBuild = buildTaskPrompt(settings, "reflection", {
    taskName: "reflection",
    eventSummary,
    characterSummary: characterSummary || "(无)",
    threadSummary: threadSummary || "(无)",
    contradictionSummary: contradictionSummary || "(无)",
    graphStats: `event=${recentEvents.length}, character=${recentCharacters.length}, thread=${recentThreads.length}`,
    ...getSTContextForPrompt(),
  });
  const reflectionSystemPrompt = applyTaskRegex(
    settings,
    "reflection",
    "finalPrompt",
    reflectionPromptBuild.systemPrompt ||
      customPrompt ||
      [
        "你是 RP 长期记忆系统的反思生成器。",
        '输出严格 JSON：{"insight":"...","trigger":"...","suggestion":"...","importance":1-10}',
        "insight 应总结最近情节中最值得长期保留的变化、关系趋势或潜在线索。",
        "trigger 说明触发这条反思的关键事件或矛盾。",
        "suggestion 给出后续检索或叙事上值得关注的提示。",
        "不要复述全部事件，要提炼高层结论。",
      ].join("\n"),
  );

  const result = await callLLMForJSON({
    systemPrompt: reflectionSystemPrompt,
    userPrompt: [
      "## 最近事件",
      eventSummary,
      "",
      "## 近期角色状态",
      characterSummary || "(无)",
      "",
      "## 当前主线",
      threadSummary || "(无)",
      "",
      "## 已知矛盾",
      contradictionSummary || "(无)",
    ].join("\n"),
    maxRetries: 1,
    signal,
    taskType: "reflection",
    additionalMessages: reflectionPromptBuild.customMessages || [],
  });

  if (!result?.insight) return null;

  const reflectionNode = createNode({
    type: "reflection",
    fields: {
      insight: result.insight,
      trigger:
        result.trigger ||
        recentEvents[recentEvents.length - 1]?.fields?.summary ||
        "",
      suggestion: result.suggestion || "",
    },
    seq: currentSeq,
    importance: Math.max(5, Math.min(10, result.importance ?? 7)),
  });
  addNode(graph, reflectionNode);

  for (const eventNode of recentEvents.slice(-3)) {
    const edge = createEdge({
      fromId: reflectionNode.id,
      toId: eventNode.id,
      relation: "evolves",
      strength: 0.75,
      edgeType: 0,
    });
    addEdge(graph, edge);
  }

  console.log("[ST-BME] 反思条目已生成");
  return reflectionNode.id;
}
