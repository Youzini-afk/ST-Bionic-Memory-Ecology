// ST-BME: 三层混合检索编排
// 融合向量预筛（PeroCore）+ 图扩散（PeroCore PEDSA）+ 可选 LLM 精确召回
// v2: + 认知边界过滤(RoleRAG) + 双记忆交叉检索(AriGraph) + 概率触发

import { diffuseAndRank } from "./diffusion.js";
import { hybridScore, reinforceAccessBatch } from "./dynamics.js";
import {
  buildTemporalAdjacencyMap,
  getActiveNodes,
  getNode,
  getNodeEdges,
} from "./graph.js";
import { callLLMForJSON } from "./llm.js";
import { buildTaskPrompt } from "./prompt-builder.js";
import { applyTaskRegex } from "./task-regex.js";
import { getSTContextForPrompt } from "./st-context.js";
import { findSimilarNodesByText, validateVectorConfig } from "./vector-index.js";

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
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError();
  }
}

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
  signal = undefined,
  options = {},
  settings = {},
}) {
  throwIfAborted(signal);
  const topK = options.topK ?? 20;
  const maxRecallNodes = options.maxRecallNodes ?? 8;
  const enableLLMRecall = options.enableLLMRecall ?? true;
  const enableVectorPrefilter = options.enableVectorPrefilter ?? true;
  const enableGraphDiffusion = options.enableGraphDiffusion ?? true;
  const diffusionTopK = options.diffusionTopK ?? 100;
  const llmCandidatePool = options.llmCandidatePool ?? 30;
  const weights = options.weights ?? {};

  // v2 options
  const enableVisibility = options.enableVisibility ?? false;
  const visibilityFilter = options.visibilityFilter ?? null;
  const enableCrossRecall = options.enableCrossRecall ?? false;
  const enableProbRecall = options.enableProbRecall ?? false;
  const probRecallChance = options.probRecallChance ?? 0.15;

  let activeNodes = getActiveNodes(graph).filter(
    (node) =>
      !node.archived &&
      Array.isArray(node.seqRange) &&
      Number.isFinite(node.seqRange[1]),
  );

  // v2 ⑦: 认知边界过滤（RoleRAG 启发）
  if (enableVisibility && visibilityFilter) {
    activeNodes = filterByVisibility(activeNodes, visibilityFilter);
  }

  const nodeCount = activeNodes.length;
  const normalizedTopK = Math.max(1, topK);
  const normalizedMaxRecallNodes = Math.max(1, maxRecallNodes);
  const normalizedDiffusionTopK = Math.max(1, diffusionTopK);
  const normalizedLlmCandidatePool = Math.max(
    normalizedMaxRecallNodes,
    llmCandidatePool,
  );
  console.log(
    `[ST-BME] 检索开始: ${nodeCount} 个活跃节点${enableVisibility ? " (认知边界已启用)" : ""}`,
  );

  let vectorResults = [];
  let diffusionResults = [];
  let useLLM = false;
  let llmMeta = {
    enabled: enableLLMRecall,
    status: enableLLMRecall ? "pending" : "disabled",
    reason: enableLLMRecall ? "" : "LLM 精排已关闭",
    candidatePool: 0,
    selectedSeedCount: 0,
  };

  if (nodeCount === 0) {
    return buildResult(graph, [], schema, {
      retrieval: {
        vectorHits: 0,
        diffusionHits: 0,
        scoredCandidates: 0,
        llm: {
          ...llmMeta,
          status: enableLLMRecall ? "skipped" : "disabled",
          reason: "当前没有可参与召回的活跃节点",
        },
      },
    });
  }

  // ========== 第 1 层：向量预筛 ==========
  if (
    enableVectorPrefilter &&
    validateVectorConfig(embeddingConfig).valid
  ) {
    console.log("[ST-BME] 第1层: 向量预筛");
    vectorResults = await vectorPreFilter(
      graph,
      userMessage,
      activeNodes,
      embeddingConfig,
      normalizedTopK,
      signal,
    );
  }

  // ========== 第 2 层：图扩散 ==========
  if (enableGraphDiffusion) {
    console.log("[ST-BME] 第2层: PEDSA 图扩散");
    const entityAnchors = extractEntityAnchors(userMessage, activeNodes);

    const seeds = [
      ...vectorResults.map((v) => ({ id: v.nodeId, energy: v.score })),
      ...entityAnchors.map((a) => ({ id: a.nodeId, energy: 2.0 })),
    ];

    // v2 ⑧: 双记忆交叉检索（AriGraph 启发）
    // 实体锚点命中后，沿边展开关联的情景节点作为额外种子
    if (enableCrossRecall && entityAnchors.length > 0) {
      for (const anchor of entityAnchors) {
        const connectedEdges = getNodeEdges(graph, anchor.nodeId);
        for (const edge of connectedEdges) {
          if (edge.invalidAt) continue;
          const neighborId =
            edge.fromId === anchor.nodeId ? edge.toId : edge.fromId;
          const neighbor = getNode(graph, neighborId);
          if (neighbor && !neighbor.archived && neighbor.type === "event") {
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
    const uniqueSeeds = [...seedMap.entries()].map(([id, energy]) => ({
      id,
      energy,
    }));

    if (uniqueSeeds.length > 0) {
      const adjacencyMap = buildTemporalAdjacencyMap(graph);
      diffusionResults = diffuseAndRank(adjacencyMap, uniqueSeeds, {
        maxSteps: 2,
        decayFactor: 0.6,
        topK: normalizedDiffusionTopK,
      }).filter((item) => {
        const node = getNode(graph, item.nodeId);
        return node && !node.archived;
      });
    }
  }

  // ========== 第 3 层：混合评分 + 可选 LLM 精确 ==========
  console.log("[ST-BME] 第3层: 混合评分");

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

  // 两个上游阶段都未产出候选时，退回到全部活跃节点参与评分
  if (scoreMap.size === 0) {
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

    const finalScore = hybridScore(
      {
        graphScore: scores.graphScore,
        vectorScore: scores.vectorScore,
        importance: node.importance,
        createdTime: node.createdTime,
      },
      weights,
    );

    scoredNodes.push({ nodeId, node, finalScore, ...scores });
  }

  scoredNodes.sort((a, b) => b.finalScore - a.finalScore);

  // 决定是否使用 LLM 精确召回
  useLLM = enableLLMRecall;

  let selectedNodeIds;

  if (useLLM && nodeCount > 0) {
    console.log("[ST-BME] LLM 精确召回");
    const candidateNodes = scoredNodes.slice(
      0,
      Math.min(normalizedLlmCandidatePool, scoredNodes.length),
    );
    const llmResult = await llmRecall(
      userMessage,
      recentMessages,
      candidateNodes,
      graph,
      schema,
      normalizedMaxRecallNodes,
      options.recallPrompt,
      settings,
      signal,
    );
    selectedNodeIds = llmResult.selectedNodeIds;
    llmMeta = {
      enabled: true,
      status: llmResult.status,
      reason: llmResult.reason,
      candidatePool: candidateNodes.length,
      selectedSeedCount: llmResult.selectedNodeIds.length,
    };
  } else {
    selectedNodeIds = scoredNodes
      .slice(0, Math.min(normalizedTopK, scoredNodes.length))
      .map((s) => s.nodeId);
    llmMeta = {
      enabled: false,
      status: "disabled",
      reason: "LLM 精排已关闭，直接采用评分排序",
      candidatePool: 0,
      selectedSeedCount: selectedNodeIds.length,
    };
  }

  selectedNodeIds = reconstructSceneNodeIds(
    graph,
    selectedNodeIds,
    normalizedTopK + 6,
  );

  // 访问强化
  const selectedNodes = selectedNodeIds
    .map((id) => getNode(graph, id))
    .filter(Boolean);

  reinforceAccessBatch(selectedNodes);

  console.log(`[ST-BME] 检索完成: 选中 ${selectedNodeIds.length} 个节点`);

  // v2 ⑧: 概率触发回忆
  // 未被选中的高重要性节点有概率随机激活
  if (enableProbRecall && probRecallChance > 0) {
    const selectedSet = new Set(selectedNodeIds);
    const probability = Math.max(0.01, Math.min(0.5, probRecallChance));
    const candidates = activeNodes
      .filter(
        (n) =>
          !selectedSet.has(n.id) &&
          n.importance >= 6 &&
          n.type !== "synopsis" &&
          n.type !== "rule",
      )
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 3);
    for (const c of candidates) {
      if (Math.random() < probability) {
        selectedNodeIds.push(c.id);
        console.log(
          `[ST-BME] 概率触发: ${c.fields?.name || c.fields?.summary || c.id}`,
        );
      }
    }
  }

  selectedNodeIds = uniqueNodeIds(selectedNodeIds);

  return buildResult(graph, selectedNodeIds, schema, {
    retrieval: {
      vectorHits: vectorResults.length,
      diffusionHits: diffusionResults.length,
      scoredCandidates: scoredNodes.length,
      llm: llmMeta,
    },
  });
}

/**
 * 向量预筛选
 */
async function vectorPreFilter(
  graph,
  userMessage,
  activeNodes,
  embeddingConfig,
  topK,
  signal,
) {
  try {
    return await findSimilarNodesByText(
      graph,
      userMessage,
      embeddingConfig,
      topK,
      activeNodes,
      signal,
    );
  } catch (e) {
    if (isAbortError(e)) {
      throw e;
    }
    console.error("[ST-BME] 向量预筛失败:", e);
    return [];
  }
}

/**
 * 实体锚点提取
 * 从用户消息中提取名词/实体，匹配图中的节点名称
 */
function extractEntityAnchors(userMessage, activeNodes) {
  const anchors = [];
  const seen = new Set();

  for (const node of activeNodes) {
    const candidates = [node.fields?.name, node.fields?.title]
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length >= 2);

    for (const candidate of candidates) {
      if (!userMessage.includes(candidate)) continue;
      const key = `${node.id}:${candidate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ nodeId: node.id, entity: candidate });
      break;
    }
  }

  return anchors;
}

/**
 * LLM 精确召回
 */
async function llmRecall(
  userMessage,
  recentMessages,
  candidates,
  graph,
  schema,
  maxNodes,
  customPrompt,
  settings = {},
  signal,
) {
  throwIfAborted(signal);
  const contextStr = recentMessages.join("\n---\n");
  const candidateDescriptions = candidates
    .map((c) => {
      const node = c.node;
      const typeDef = schema.find((s) => s.id === node.type);
      const typeLabel = typeDef?.label || node.type;
      const fieldsStr = Object.entries(node.fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `[${node.id}] 类型=${typeLabel}, ${fieldsStr} (评分=${c.finalScore.toFixed(3)})`;
    })
    .join("\n");

  const recallPromptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    recentMessages: contextStr || "(无)",
    userMessage,
    candidateNodes: candidateDescriptions,
    candidateText: candidateDescriptions,
    graphStats: `candidate_count=${candidates.length}`,
    ...getSTContextForPrompt(),
  });
  const systemPrompt = applyTaskRegex(
    settings,
    "recall",
    "finalPrompt",
    recallPromptBuild.systemPrompt || customPrompt || [
      "你是一个记忆召回分析器。",
      "根据用户最新输入和对话上下文，从候选记忆节点中选择最相关的节点。",
      "优先选择：(1) 直接相关的当前场景节点, (2) 因果关系连续性节点, (3) 有潜在影响的背景节点。",
      `最多选择 ${maxNodes} 个节点。`,
      "输出严格的 JSON 格式：",
      '{"selected_ids": ["id1", "id2", ...], "reason": "简要说明选择理由"}',
    ].join("\n"),
  );

  const userPrompt = [
    "## 最近对话上下文",
    contextStr || "(无)",
    "",
    "## 用户最新输入",
    userMessage,
    "",
    "## 候选记忆节点",
    candidateDescriptions,
    "",
    "请选择最相关的节点并输出 JSON。",
  ].join("\n");

  const result = await callLLMForJSON({
    systemPrompt,
    userPrompt,
    maxRetries: 1,
    signal,
    taskType: "recall",
    additionalMessages: [
      ...(recallPromptBuild.customMessages || []),
      ...(recallPromptBuild.additionalMessages || []),
    ],
  });

  if (result?.selected_ids && Array.isArray(result.selected_ids)) {
    // 校验 ID 有效性
    const validIds = uniqueNodeIds(
      result.selected_ids.filter((id) =>
        candidates.some((c) => c.nodeId === id),
      ),
    ).slice(0, maxNodes);

    if (validIds.length > 0 || result.selected_ids.length === 0) {
      return {
        selectedNodeIds: validIds,
        status: "llm",
        reason:
          validIds.length < result.selected_ids.length
            ? "LLM 返回了部分无效或超限 ID，已自动裁剪"
            : "LLM 精排完成",
      };
    }
  }

  // LLM 失败时回退到纯评分排序
  return {
    selectedNodeIds: candidates.slice(0, maxNodes).map((c) => c.nodeId),
    status: "fallback",
    reason: "LLM 未返回有效 JSON 或有效候选，已回退到评分排序",
  };
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
  if (!characterName || typeof characterName !== "string") return nodes;
  return nodes.filter((node) => {
    if (!node.fields?.visibility) return true;
    if (Array.isArray(node.fields.visibility)) {
      return (
        node.fields.visibility.includes(characterName) ||
        node.fields.visibility.includes("*")
      );
    }
    if (typeof node.fields.visibility === "string") {
      const visibleTo = node.fields.visibility
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return visibleTo.includes(characterName) || visibleTo.includes("*");
    }
    return true;
  });
}

/**
 * 构建最终检索结果
 * 分离常驻注入（Core）和召回注入（Recall）
 */
function buildResult(graph, selectedNodeIds, schema, meta = {}) {
  const coreNodes = [];
  const recallNodes = [];
  const selectedSet = new Set(uniqueNodeIds(selectedNodeIds));

  // 常驻注入节点（alwaysInject=true 的类型）
  const alwaysInjectTypes = new Set(
    schema.filter((s) => s.alwaysInject).map((s) => s.id),
  );

  const activeNodes = getActiveNodes(graph).filter((node) => !node.archived);

  for (const node of activeNodes) {
    if (alwaysInjectTypes.has(node.type)) {
      coreNodes.push(node);
    }
  }

  for (const nodeId of selectedSet) {
    const node = getNode(graph, nodeId);
    if (!node || node.archived) continue;
    if (!alwaysInjectTypes.has(node.type)) {
      recallNodes.push(node);
    }
  }

  coreNodes.sort(compareNodeRecallOrder);
  recallNodes.sort(compareNodeRecallOrder);
  const groupedRecallNodes = groupRecallNodes(recallNodes);

  return {
    coreNodes,
    recallNodes,
    groupedRecallNodes,
    selectedNodeIds: [...selectedSet],
    meta,
    stats: {
      totalActive: activeNodes.length,
      coreCount: coreNodes.length,
      recallCount: recallNodes.length,
      episodicCount: groupedRecallNodes.episodic.length,
      stateCount: groupedRecallNodes.state.length,
      reflectiveCount: groupedRecallNodes.reflective.length,
      ruleCount: groupedRecallNodes.rule.length,
    },
  };
}

function reconstructSceneNodeIds(graph, seedNodeIds, limit = 16) {
  const selected = [];
  const seen = new Set();

  function push(nodeId) {
    if (!nodeId || seen.has(nodeId) || selected.length >= limit) return;
    const node = getNode(graph, nodeId);
    if (!node || node.archived) return;
    seen.add(nodeId);
    selected.push(nodeId);
  }

  for (const nodeId of uniqueNodeIds(seedNodeIds)) {
    if (selected.length >= limit) break;
    push(nodeId);
    const node = getNode(graph, nodeId);
    if (!node) continue;

    if (node.type === "event") {
      expandEventScene(graph, node, push);
    } else if (node.type === "character" || node.type === "location") {
      const relatedEvents = getNodeEdges(graph, node.id)
        .filter(isUsableSceneEdge)
        .map((e) => (e.fromId === node.id ? e.toId : e.fromId))
        .map((id) => getNode(graph, id))
        .filter((n) => n && !n.archived && n.type === "event")
        .sort(compareNodeRecallOrder)
        .slice(0, 2);
      for (const eventNode of relatedEvents) {
        push(eventNode.id);
        expandEventScene(graph, eventNode, push);
      }
    }
  }

  return selected.slice(0, limit);
}

function expandEventScene(graph, eventNode, push) {
  const edges = getNodeEdges(graph, eventNode.id).filter(isUsableSceneEdge);
  for (const edge of edges) {
    const neighborId = edge.fromId === eventNode.id ? edge.toId : edge.fromId;
    const neighbor = getNode(graph, neighborId);
    if (!neighbor || neighbor.archived) continue;
    if (
      neighbor.type === "character" ||
      neighbor.type === "location" ||
      neighbor.type === "thread" ||
      neighbor.type === "reflection"
    ) {
      push(neighbor.id);
    }
  }

  const adjacentEvents = getTemporalNeighborEvents(
    graph,
    eventNode.seq,
    eventNode.id,
  );
  for (const neighborEvent of adjacentEvents) {
    push(neighborEvent.id);
  }
}

function getTemporalNeighborEvents(graph, seq, excludeId) {
  return getActiveNodes(graph, "event")
    .filter((n) => n.id !== excludeId && !n.archived)
    .sort((a, b) => {
      const distance =
        Math.abs((a.seq || 0) - seq) - Math.abs((b.seq || 0) - seq);
      if (distance !== 0) return distance;
      return (b.seq || 0) - (a.seq || 0);
    })
    .slice(0, 2);
}

function isUsableSceneEdge(edge) {
  return edge && !edge.invalidAt && !edge.expiredAt;
}

function compareNodeRecallOrder(a, b) {
  const aSeq = a?.seqRange?.[1] ?? a?.seq ?? 0;
  const bSeq = b?.seqRange?.[1] ?? b?.seq ?? 0;
  if (bSeq !== aSeq) return bSeq - aSeq;
  return (b.importance || 0) - (a.importance || 0);
}

function groupRecallNodes(nodes) {
  return {
    state: nodes.filter((n) => n.type === "character" || n.type === "location"),
    episodic: nodes.filter((n) => n.type === "event" || n.type === "thread"),
    reflective: nodes.filter(
      (n) => n.type === "reflection" || n.type === "synopsis",
    ),
    rule: nodes.filter((n) => n.type === "rule"),
    other: nodes.filter(
      (n) =>
        ![
          "character",
          "location",
          "event",
          "thread",
          "reflection",
          "synopsis",
          "rule",
        ].includes(n.type),
    ),
  };
}

function uniqueNodeIds(nodeIds) {
  return [...new Set(nodeIds)];
}
