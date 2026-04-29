// ST-BME: 层级压缩引擎
// 超过阈值的节点被 LLM 总结为更高层级的压缩节点

import { debugLog } from "../runtime/debug-logging.js";
import { embedText } from "../vector/embedding.js";
import {
  addEdge,
  addNode,
  createEdge,
  createNode,
  getActiveNodes,
  getNode,
} from "../graph/graph.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  getScopeOwnerKey,
  getScopeRegionKey,
  normalizeMemoryScope,
} from "../graph/memory-scope.js";
import { ensureEventTitle, getNodeDisplayName } from "../graph/node-labels.js";
import {
  deriveStoryTimeSpanFromNodes,
  describeNodeStoryTime,
  normalizeStoryTime,
} from "../graph/story-timeline.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "../prompting/prompt-builder.js";
import { getSTContextForPrompt } from "../host/st-context.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { buildTaskGraphStats } from "./task-graph-stats.js";
import { isDirectVectorConfig } from "../vector/vector-index.js";

function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTaskLlmDebugContext(promptBuild, regexInput) {
  return typeof buildTaskExecutionDebugContext === "function"
    ? buildTaskExecutionDebugContext(promptBuild, { regexInput })
    : null;
}

function resolveTaskPromptPayload(promptBuild, fallbackUserPrompt = "") {
  if (typeof buildTaskLlmPayload === "function") {
    return buildTaskLlmPayload(promptBuild, fallbackUserPrompt);
  }

  return {
    systemPrompt: String(promptBuild?.systemPrompt || ""),
    userPrompt: String(fallbackUserPrompt || ""),
    promptMessages: [],
    additionalMessages: Array.isArray(promptBuild?.privateTaskMessages)
      ? promptBuild.privateTaskMessages
      : [],
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

function resolveCompressionWindow(compression = {}, force = false) {
  const fanIn = Number.isFinite(Number(compression?.fanIn))
    ? Math.max(2, Number(compression.fanIn))
    : 2;
  const threshold = force
    ? fanIn
    : Number.isFinite(Number(compression?.threshold))
      ? Math.max(2, Number(compression.threshold))
      : fanIn;
  const keepRecent = force
    ? 0
    : Number.isFinite(Number(compression?.keepRecentLeaves))
      ? Math.max(0, Number(compression.keepRecentLeaves))
      : 0;

  return {
    fanIn,
    threshold,
    keepRecent,
  };
}

function normalizeCompressionFieldValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeCompressionFieldValue(item))
      .filter(Boolean)
      .join("；");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

function buildCompressionRankingQueryText(nodes = [], typeDef = {}) {
  const typeLabel = String(typeDef?.label || typeDef?.id || "节点").trim() || "节点";
  const lines = (Array.isArray(nodes) ? nodes : [])
    .map((node, index) => {
      const fieldsText = Object.entries(node?.fields || {})
        .map(([key, value]) => {
          const normalizedValue = normalizeCompressionFieldValue(value);
          return normalizedValue ? `${key}: ${normalizedValue}` : "";
        })
        .filter(Boolean)
        .join(" | ");
      const storyTimeLabel = describeNodeStoryTime(node);
      return [
        `${typeLabel}#${index + 1}`,
        storyTimeLabel ? `剧情时间=${storyTimeLabel}` : "",
        fieldsText,
      ]
        .filter(Boolean)
        .join(" | ");
    })
    .filter(Boolean);
  return lines.length > 0 ? [`压缩批次 ${typeLabel}`, ...lines].join("\n") : "";
}

function buildCompressionFallbackSummary(batch = []) {
  return batch
    .map((node) =>
      normalizeCompressionFieldValue(
        node?.fields?.summary ||
          node?.fields?.title ||
          node?.fields?.name ||
          node?.fields?.insight ||
          getNodeDisplayName(node),
      ),
    )
    .filter(Boolean)
    .slice(0, 6)
    .join("；");
}

function normalizeCompressedFields(summaryResult, typeDef, batch = []) {
  const rawFields =
    summaryResult?.fields &&
    typeof summaryResult.fields === "object" &&
    !Array.isArray(summaryResult.fields)
      ? summaryResult.fields
      : summaryResult && typeof summaryResult === "object" && !Array.isArray(summaryResult)
        ? summaryResult
        : {};
  const columns = Array.isArray(typeDef?.columns) ? typeDef.columns : [];
  const normalized = {};

  for (const column of columns) {
    const key = String(column?.name || "").trim();
    if (!key) continue;
    const normalizedValue = normalizeCompressionFieldValue(rawFields[key]);
    if (normalizedValue) {
      normalized[key] = normalizedValue;
    }
  }

  const fallbackSummary = buildCompressionFallbackSummary(batch);
  if (!normalized.summary && columns.some((column) => column?.name === "summary")) {
    normalized.summary = fallbackSummary || "压缩批次摘要缺失";
  }
  if (!normalized.insight && columns.some((column) => column?.name === "insight")) {
    normalized.insight = fallbackSummary || "压缩批次洞察缺失";
  }
  if (!normalized.title && columns.some((column) => column?.name === "title")) {
    const titled = ensureEventTitle({ title: rawFields?.title, summary: normalized.summary });
    normalized.title =
      normalizeCompressionFieldValue(titled?.title) ||
      normalizeCompressionFieldValue(rawFields?.name) ||
      normalizeCompressionFieldValue(batch[batch.length - 1]?.fields?.title) ||
      normalizeCompressionFieldValue(batch[batch.length - 1]?.fields?.name) ||
      "压缩节点";
  }
  if (!normalized.name && columns.some((column) => column?.name === "name")) {
    normalized.name =
      normalizeCompressionFieldValue(rawFields?.title) ||
      normalizeCompressionFieldValue(rawFields?.name) ||
      normalizeCompressionFieldValue(batch[batch.length - 1]?.fields?.name) ||
      "压缩节点";
  }

  return normalized;
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
  schema = [],
  force = false,
  customPrompt,
  signal,
  settings = {},
}) {
  const compression = typeDef.compression;
  if (!compression || compression.mode !== "hierarchical") {
    return { created: 0, archived: 0 };
  }
  const maxDepth = Number.isFinite(Number(compression.maxDepth))
    ? Math.max(1, Number(compression.maxDepth))
    : 1;

  let totalCreated = 0;
  let totalArchived = 0;

  // 从最低层级开始逐层压缩
  for (let level = 0; level < maxDepth; level++) {
    throwIfAborted(signal);
    const result = await compressLevel({
      graph,
      typeDef,
      level,
      embeddingConfig,
      schema,
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
  schema = [],
  force,
  customPrompt,
  signal,
  settings = {},
}) {
  const compression = typeDef.compression;
  const { fanIn, threshold, keepRecent } = resolveCompressionWindow(
    compression,
    force,
  );
  throwIfAborted(signal);

  // 获取该层级的活跃叶子节点
  const levelNodes = getActiveNodes(graph, typeDef.id)
    .filter((n) => n.level === level)
    .sort((a, b) => a.seq - b.seq);
  let created = 0;
  let archived = 0;

  for (const group of groupCompressionCandidates(levelNodes)) {
    if (force ? group.length < fanIn : group.length <= threshold) {
      continue;
    }

    const compressible = group.slice(0, Math.max(0, group.length - keepRecent));
    if (compressible.length < fanIn) {
      continue;
    }

    for (let i = 0; i < compressible.length; i += fanIn) {
      const batch = compressible.slice(i, i + fanIn);
      if (batch.length < 2) break;

      const summaryResult = await summarizeBatch(
        batch,
        typeDef,
        graph,
        embeddingConfig,
        schema,
        customPrompt,
        signal,
        settings,
      );
      if (!summaryResult) continue;
      const normalizedFields = normalizeCompressedFields(
        summaryResult,
        typeDef,
        batch,
      );
      if (Object.keys(normalizedFields).length === 0) {
        throw new Error(
          `压缩结果缺少可用 fields，无法创建 ${typeDef?.label || typeDef?.id || "压缩"} 节点`,
        );
      }

      const compressedNode = createNode({
        type: typeDef.id,
        fields: normalizedFields,
        seq: batch[batch.length - 1].seq,
        seqRange: [
          batch[0].seqRange?.[0] ?? batch[0].seq,
          batch[batch.length - 1].seqRange?.[1] ?? batch[batch.length - 1].seq,
        ],
        importance: Math.max(...batch.map((n) => n.importance)),
        scope: normalizeMemoryScope(batch[0]?.scope),
      });

      compressedNode.level = level + 1;
      compressedNode.childIds = batch.map((n) => n.id);
      compressedNode.storyTime = normalizeStoryTime();
      compressedNode.storyTimeSpan = deriveStoryTimeSpanFromNodes(
        graph,
        batch,
        "derived",
      );

      const embeddingText =
        normalizeCompressionFieldValue(
          normalizedFields.summary ||
            normalizedFields.insight ||
            normalizedFields.title ||
            normalizedFields.name,
        ) || "";
      if (isDirectVectorConfig(embeddingConfig) && embeddingText) {
        const vec = await embedText(
          embeddingText,
          embeddingConfig,
          { signal },
        );
        if (vec) compressedNode.embedding = Array.from(vec);
      }

      addNode(graph, compressedNode);
      migrateBatchEdges(graph, batch, compressedNode);
      created++;

      for (const child of batch) {
        child.archived = true;
        child.parentId = compressedNode.id;
        archived++;
      }
    }
  }

  return { created, archived };
}

function groupCompressionCandidates(nodes = []) {
  const groups = new Map();
  for (const node of nodes) {
    const normalizedScope = normalizeMemoryScope(node?.scope);
    const key =
      normalizedScope.layer === "pov"
        ? [
            "pov",
            getScopeOwnerKey(normalizedScope) || "owner:none",
            node.type || "",
          ].join("::")
        : [
            "objective",
            getScopeRegionKey(normalizedScope) || "region:global",
            node.type || "",
          ].join("::");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(node);
  }
  return [...groups.values()].map((group) =>
    group.sort((a, b) => a.seq - b.seq),
  );
}

function inspectCompressibleGroup(group = [], compression = {}, force = false) {
  const { fanIn, threshold, keepRecent } = resolveCompressionWindow(
    compression,
    force,
  );
  if (force ? group.length < fanIn : group.length <= threshold) {
    return null;
  }

  const compressible = group.slice(0, Math.max(0, group.length - keepRecent));
  if (compressible.length < fanIn) {
    return null;
  }

  return {
    candidateCount: compressible.length,
    fanIn,
    threshold,
    keepRecent,
  };
}

export function inspectAutoCompressionCandidates(
  graph,
  schema = [],
  force = false,
) {
  const safeSchema = Array.isArray(schema) ? schema : [];
  for (const typeDef of safeSchema) {
    if (typeDef?.compression?.mode !== "hierarchical") continue;
    const maxDepth = Number.isFinite(Number(typeDef?.compression?.maxDepth))
      ? Math.max(1, Number(typeDef.compression.maxDepth))
      : 1;

    for (let level = 0; level < maxDepth; level++) {
      const levelNodes = getActiveNodes(graph, typeDef.id)
        .filter((node) => Number(node?.level || 0) === level)
        .sort((a, b) => a.seq - b.seq);

      for (const group of groupCompressionCandidates(levelNodes)) {
        const summary = inspectCompressibleGroup(
          group,
          typeDef.compression,
          force,
        );
        if (!summary) continue;
        return {
          hasCandidates: true,
          typeId: String(typeDef.id || ""),
          level,
          candidateCount: summary.candidateCount,
          threshold: summary.threshold,
          fanIn: summary.fanIn,
          keepRecent: summary.keepRecent,
          reason: "",
        };
      }
    }
  }

  return {
    hasCandidates: false,
    typeId: "",
    level: null,
    candidateCount: 0,
    threshold: 0,
    fanIn: 0,
    keepRecent: 0,
    reason: "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组",
  };
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
      scope: edge.scope,
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
  graph,
  embeddingConfig,
  schema = [],
  customPrompt,
  signal,
  settings = {},
) {
  const nodeDescriptions = nodes
    .map((n, i) => {
      const storyTimeLabel = describeNodeStoryTime(n);
      const fieldsStr = Object.entries(n.fields)
        .filter(([_, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n    ");
      return `节点 ${i + 1} [楼层 ${n.seq}]${storyTimeLabel ? ` [剧情时间 ${storyTimeLabel}]` : ""}:\n    ${fieldsStr}`;
    })
    .join("\n\n");

  const instruction =
    typeDef.compression.instruction || "将以下节点压缩总结为一条精炼记录。";
  const excludedNodeIds = new Set(
    (Array.isArray(nodes) ? nodes : []).map((node) => String(node?.id || "").trim()),
  );
  const compressionGraphStats = await buildTaskGraphStats({
    graph,
    schema: Array.isArray(schema) && schema.length > 0 ? schema : [typeDef],
    userMessage: buildCompressionRankingQueryText(nodes, typeDef),
    recentMessages: [],
    embeddingConfig,
    signal,
    activeNodes: getActiveNodes(graph).filter(
      (node) => !excludedNodeIds.has(String(node?.id || "").trim()),
    ),
    settings,
    rankingOptions: {
      topK: 12,
      diffusionTopK: 48,
      enableContextQueryBlend: false,
      enableMultiIntent: true,
      maxTextLength: 1200,
    },
    relevantHeading: "与当前压缩批次最相关的既有节点",
  });

  const compressPromptBuild = await buildTaskPrompt(settings, "compress", {
    taskName: "compress",
    nodeContent: nodeDescriptions,
    candidateNodes: nodeDescriptions,
    currentRange: `${nodes[0]?.seq ?? "?"} ~ ${nodes[nodes.length - 1]?.seq ?? "?"}`,
    graphStats: compressionGraphStats.graphStats,
    ...getSTContextForPrompt(),
  });
  const compressRegexInput = { entries: [] };
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
        "- 必须保持剧情时间顺序，不要把不同阶段的内容写反",
        "- 不要把未来计划写成已经发生的客观事实",
      ].join("\n"),
    compressRegexInput,
    "system",
  );

  const userPrompt = `请压缩以下 ${nodes.length} 个 "${typeDef.label}" 节点：\n\n${nodeDescriptions}`;
  const promptPayload = resolveTaskPromptPayload(
    compressPromptBuild,
    userPrompt,
  );
  const llmSystemPrompt =
    Array.isArray(promptPayload.promptMessages) &&
    promptPayload.promptMessages.length > 0
      ? String(promptPayload.systemPrompt || "")
      : String(promptPayload.systemPrompt || systemPrompt || "");

  return await callLLMForJSON({
    systemPrompt: llmSystemPrompt,
    userPrompt: promptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType: "compress",
    debugContext: createTaskLlmDebugContext(
      compressPromptBuild,
      compressRegexInput,
    ),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayload.additionalMessages,
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
        schema,
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
    debugLog(`[ST-BME] 主动遗忘: ${forgotten} 个低价值节点已归档`);
  }

  return { forgotten };
}
