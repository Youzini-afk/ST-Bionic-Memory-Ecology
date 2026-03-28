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
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
} from "./prompt-builder.js";
import {
  applyCooccurrenceBoost,
  applyDiversitySampling,
  collectSupplementalAnchorNodeIds,
  createCooccurrenceIndex,
  isEligibleAnchorNode,
  mergeVectorResults,
  runResidualRecall,
  splitIntentSegments,
} from "./retrieval-enhancer.js";
import { applyTaskRegex } from "./task-regex.js";
import { getSTContextForPrompt } from "./st-context.js";
import { findSimilarNodesByText, validateVectorConfig } from "./vector-index.js";

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

function resolveTaskLlmSystemPrompt(promptPayload, fallbackSystemPrompt = "") {
  const hasPromptMessages =
    Array.isArray(promptPayload?.promptMessages) &&
    promptPayload.promptMessages.length > 0;
  if (hasPromptMessages) {
    return String(promptPayload?.systemPrompt || "");
  }
  return String(promptPayload?.systemPrompt || fallbackSystemPrompt || "");
}

function buildRecallFallbackReason(llmResult) {
  const failureType = String(llmResult?.errorType || "").trim();
  const failureReason = String(llmResult?.failureReason || "").trim();
  switch (failureType) {
    case "timeout":
      return "LLM 精排请求超时，已回退到评分排序";
    case "empty-response":
      return "LLM 精排返回空响应，已回退到评分排序";
    case "truncated-json":
      return "LLM 精排输出被截断，已回退到评分排序";
    case "invalid-json":
      return "LLM 精排未返回有效 JSON，已回退到评分排序";
    case "provider-error":
      return failureReason
        ? `LLM 精排调用失败（${failureReason}），已回退到评分排序`
        : "LLM 精排调用失败，已回退到评分排序";
    default:
      return failureReason || "LLM 精排未返回可用结果，已回退到评分排序";
  }
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

function nowMs() {
  return typeof performance !== "undefined" && performance?.now
    ? performance.now()
    : Date.now();
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function pushSkipReason(meta, reason) {
  if (!reason) return;
  if (!Array.isArray(meta.skipReasons)) {
    meta.skipReasons = [];
  }
  if (!meta.skipReasons.includes(reason)) {
    meta.skipReasons.push(reason);
  }
}

function createRetrievalMeta(enableLLMRecall) {
  return {
    vectorHits: 0,
    diffusionHits: 0,
    scoredCandidates: 0,
    segmentsUsed: [],
    vectorMergedHits: 0,
    seedCount: 0,
    temporalSyntheticEdgeCount: 0,
    teleportAlpha: 0,
    cooccurrenceBoostedNodes: 0,
    candidatePoolBeforeDpp: 0,
    candidatePoolAfterDpp: 0,
    diversityApplied: false,
    residualTriggered: false,
    residualHits: 0,
    skipReasons: [],
    timings: {},
    llm: {
      enabled: enableLLMRecall,
      status: enableLLMRecall ? "pending" : "disabled",
      reason: enableLLMRecall ? "" : "LLM 精排已关闭",
      candidatePool: 0,
      selectedSeedCount: 0,
    },
  };
}

function clampPositiveInt(value, fallback, min = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function clampRange(value, fallback, min = 0, max = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
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
  onStreamProgress = null,
}) {
  throwIfAborted(signal);
  const startedAt = nowMs();
  const topK = clampPositiveInt(options.topK, 20);
  const maxRecallNodes = clampPositiveInt(options.maxRecallNodes, 8);
  const enableLLMRecall = options.enableLLMRecall ?? true;
  const enableVectorPrefilter = options.enableVectorPrefilter ?? true;
  const enableGraphDiffusion = options.enableGraphDiffusion ?? true;
  const diffusionTopK = clampPositiveInt(options.diffusionTopK, 100);
  const llmCandidatePool = clampPositiveInt(options.llmCandidatePool, 30);
  const weights = options.weights ?? {};
  const enableVisibility = options.enableVisibility ?? false;
  const visibilityFilter = options.visibilityFilter ?? null;
  const enableCrossRecall = options.enableCrossRecall ?? false;
  const enableProbRecall = options.enableProbRecall ?? false;
  const probRecallChance = options.probRecallChance ?? 0.15;
  const enableMultiIntent = options.enableMultiIntent ?? true;
  const multiIntentMaxSegments = clampPositiveInt(
    options.multiIntentMaxSegments,
    4,
  );
  const teleportAlpha = clampRange(options.teleportAlpha, 0.15);
  const enableTemporalLinks = options.enableTemporalLinks ?? true;
  const temporalLinkStrength = clampRange(
    options.temporalLinkStrength,
    0.2,
  );
  const enableDiversitySampling = options.enableDiversitySampling ?? true;
  const dppCandidateMultiplier = clampPositiveInt(
    options.dppCandidateMultiplier,
    3,
  );
  const dppQualityWeight = clampRange(
    options.dppQualityWeight,
    1.0,
    0,
    10,
  );
  const enableCooccurrenceBoost = options.enableCooccurrenceBoost ?? false;
  const cooccurrenceScale = clampRange(
    options.cooccurrenceScale,
    0.1,
    0,
    10,
  );
  const cooccurrenceMaxNeighbors = clampPositiveInt(
    options.cooccurrenceMaxNeighbors,
    10,
  );
  const enableResidualRecall = options.enableResidualRecall ?? false;
  const residualBasisMaxNodes = clampPositiveInt(
    options.residualBasisMaxNodes,
    24,
    2,
  );
  const residualNmfTopics = clampPositiveInt(options.residualNmfTopics, 15);
  const residualNmfNoveltyThreshold = clampRange(
    options.residualNmfNoveltyThreshold,
    0.4,
  );
  const residualThreshold = clampRange(
    options.residualThreshold,
    0.3,
    0,
    10,
  );
  const residualTopK = clampPositiveInt(options.residualTopK, 5);

  let activeNodes = getActiveNodes(graph).filter(
    (node) =>
      !node.archived &&
      Array.isArray(node.seqRange) &&
      Number.isFinite(node.seqRange[1]),
  );

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
  const vectorValidation = validateVectorConfig(embeddingConfig);
  const retrievalMeta = createRetrievalMeta(enableLLMRecall);
  console.log(
    `[ST-BME] 检索开始: ${nodeCount} 个活跃节点${enableVisibility ? " (认知边界已启用)" : ""}`,
  );

  let vectorResults = [];
  let diffusionResults = [];
  let llmMeta = { ...retrievalMeta.llm };
  const exactEntityAnchors = [];
  let supplementalAnchorNodeIds = [];

  if (nodeCount === 0) {
    return buildResult(graph, [], schema, {
      retrieval: {
        ...retrievalMeta,
        llm: {
          ...llmMeta,
          status: enableLLMRecall ? "skipped" : "disabled",
          reason: "当前没有可参与召回的活跃节点",
        },
        timings: {
          total: roundMs(nowMs() - startedAt),
        },
      },
    });
  }

  const vectorStartedAt = nowMs();
  if (enableVectorPrefilter && vectorValidation.valid) {
    console.log("[ST-BME] 第1层: 向量预筛");
    const segments = enableMultiIntent
      ? splitIntentSegments(userMessage, {
          maxSegments: multiIntentMaxSegments,
        })
      : [];
    const queries = [userMessage, ...segments.filter((item) => item !== userMessage)];
    const groups = [];

    retrievalMeta.segmentsUsed = segments;
    for (const queryText of queries) {
      const results = await vectorPreFilter(
        graph,
        queryText,
        activeNodes,
        embeddingConfig,
        normalizedTopK,
        signal,
      );
      groups.push(results);
    }

    const merged = mergeVectorResults(
      groups,
      Math.max(normalizedTopK * 2, 24),
    );
    retrievalMeta.vectorHits = merged.rawHitCount;
    retrievalMeta.vectorMergedHits = merged.results.length;
    vectorResults = merged.results;
  } else if (enableVectorPrefilter) {
    pushSkipReason(retrievalMeta, "vector-config-invalid");
  }
  retrievalMeta.timings.vector = roundMs(nowMs() - vectorStartedAt);

  exactEntityAnchors.push(...extractEntityAnchors(userMessage, activeNodes));
  supplementalAnchorNodeIds = collectSupplementalAnchorNodeIds(
    graph,
    vectorResults,
    exactEntityAnchors.map((item) => item.nodeId),
    5,
  );

  let residualResult = {
    triggered: false,
    hits: [],
    skipReason: "",
  };
  const residualStartedAt = nowMs();
  if (enableResidualRecall) {
    const basisNodes = buildResidualBasisNodes(
      graph,
      exactEntityAnchors,
      vectorResults,
      residualBasisMaxNodes,
    );
    residualResult = await runResidualRecall({
      queryText: userMessage,
      graph,
      embeddingConfig,
      basisNodes,
      candidateNodes: activeNodes,
      basisLimit: residualBasisMaxNodes,
      nTopics: residualNmfTopics,
      noveltyThreshold: residualNmfNoveltyThreshold,
      residualThreshold,
      residualTopK,
      signal,
    });
    retrievalMeta.residualTriggered = Boolean(residualResult.triggered);
    retrievalMeta.residualHits = residualResult.hits?.length || 0;
    pushSkipReason(retrievalMeta, residualResult.skipReason);
  }
  retrievalMeta.timings.residual = roundMs(nowMs() - residualStartedAt);

  const diffusionStartedAt = nowMs();
  if (enableGraphDiffusion) {
    console.log("[ST-BME] 第2层: PEDSA 图扩散");
    const seeds = [
      ...vectorResults.map((v) => ({ id: v.nodeId, energy: v.score })),
      ...exactEntityAnchors.map((item) => ({ id: item.nodeId, energy: 2.0 })),
      ...(residualResult.hits || []).map((item) => ({
        id: item.nodeId,
        energy: item.score,
      })),
    ];

    if (enableCrossRecall && exactEntityAnchors.length > 0) {
      for (const anchor of exactEntityAnchors) {
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

    const seedMap = new Map();
    for (const s of seeds) {
      const existing = seedMap.get(s.id) || 0;
      if (s.energy > existing) seedMap.set(s.id, s.energy);
    }
    const uniqueSeeds = [...seedMap.entries()].map(([id, energy]) => ({
      id,
      energy,
    }));
    retrievalMeta.seedCount = uniqueSeeds.length;

    if (uniqueSeeds.length > 0) {
      const adjacencyMap = buildTemporalAdjacencyMap(graph, {
        includeTemporalLinks: enableTemporalLinks,
        temporalLinkStrength,
      });
      retrievalMeta.temporalSyntheticEdgeCount =
        Number(adjacencyMap.syntheticEdgeCount) || 0;
      retrievalMeta.teleportAlpha = teleportAlpha;
      diffusionResults = diffuseAndRank(adjacencyMap, uniqueSeeds, {
        maxSteps: 2,
        decayFactor: 0.6,
        topK: normalizedDiffusionTopK,
        teleportAlpha,
      }).filter((item) => {
        const node = getNode(graph, item.nodeId);
        return node && !node.archived;
      });
    }
  }
  retrievalMeta.diffusionHits = diffusionResults.length;
  retrievalMeta.timings.diffusion = roundMs(nowMs() - diffusionStartedAt);

  console.log("[ST-BME] 第3层: 混合评分");

  const scoreMap = new Map();

  for (const v of vectorResults) {
    const entry = scoreMap.get(v.nodeId) || { graphScore: 0, vectorScore: 0 };
    entry.vectorScore = v.score;
    scoreMap.set(v.nodeId, entry);
  }

  for (const d of diffusionResults) {
    const entry = scoreMap.get(d.nodeId) || { graphScore: 0, vectorScore: 0 };
    entry.graphScore = d.energy;
    scoreMap.set(d.nodeId, entry);
  }

  if (scoreMap.size === 0) {
    for (const node of activeNodes) {
      if (!scoreMap.has(node.id)) {
        scoreMap.set(node.id, { graphScore: 0, vectorScore: 0 });
      }
    }
  }

  const cooccurrenceStartedAt = nowMs();
  if (enableCooccurrenceBoost) {
    const anchorWeights = new Map();
    for (const anchor of exactEntityAnchors) {
      anchorWeights.set(anchor.nodeId, 2.0);
    }
    for (const nodeId of supplementalAnchorNodeIds) {
      const fallbackWeight =
        scoreMap.get(nodeId)?.vectorScore ||
        scoreMap.get(nodeId)?.graphScore ||
        0.5;
      anchorWeights.set(
        nodeId,
        Math.max(anchorWeights.get(nodeId) || 0, fallbackWeight),
      );
    }

    if (anchorWeights.size > 0) {
      const cooccurrenceIndex = createCooccurrenceIndex(graph, {
        maxAnchorsPerBatch: 10,
        eligibleNodes: activeNodes.filter(isEligibleAnchorNode),
      });
      const graphScores = new Map(
        [...scoreMap.entries()].map(([nodeId, value]) => [
          nodeId,
          value.graphScore || 0,
        ]),
      );
      const boosted = applyCooccurrenceBoost(
        graphScores,
        anchorWeights,
        cooccurrenceIndex,
        {
          scale: cooccurrenceScale,
          maxNeighbors: cooccurrenceMaxNeighbors,
        },
      );
      retrievalMeta.cooccurrenceBoostedNodes = boosted.boostedNodes.length;

      for (const [nodeId, boostedScore] of boosted.scores.entries()) {
        const entry = scoreMap.get(nodeId) || { graphScore: 0, vectorScore: 0 };
        entry.graphScore = boostedScore;
        scoreMap.set(nodeId, entry);
      }
      if (boosted.boostedNodes.length === 0) {
        pushSkipReason(retrievalMeta, "cooccurrence-no-neighbors");
      }
    } else {
      pushSkipReason(retrievalMeta, "cooccurrence-no-anchor");
    }
  }
  retrievalMeta.timings.cooccurrence = roundMs(nowMs() - cooccurrenceStartedAt);

  const scoringStartedAt = nowMs();
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
  retrievalMeta.scoredCandidates = scoredNodes.length;
  retrievalMeta.timings.scoring = roundMs(nowMs() - scoringStartedAt);

  let selectedNodeIds;
  let llmCandidates = [];
  const diversityStartedAt = nowMs();
  let llmDurationMs = 0;

  if (enableLLMRecall && nodeCount > 0) {
    console.log("[ST-BME] LLM 精确召回");
    llmCandidates = resolveCandidatePool(
      scoredNodes,
      normalizedLlmCandidatePool,
      dppCandidateMultiplier,
      enableDiversitySampling,
      dppQualityWeight,
      retrievalMeta,
    );
    const llmStartedAt = nowMs();
    const llmResult = await llmRecall(
      userMessage,
      recentMessages,
      llmCandidates,
      graph,
      schema,
      normalizedMaxRecallNodes,
      options.recallPrompt,
      settings,
      signal,
      onStreamProgress,
    );
    llmDurationMs = nowMs() - llmStartedAt;
    selectedNodeIds = llmResult.selectedNodeIds;
    llmMeta = {
      enabled: true,
      status: llmResult.status,
      reason: llmResult.reason,
      fallbackType: llmResult.fallbackType || "",
      candidatePool: llmCandidates.length,
      selectedSeedCount: llmResult.selectedNodeIds.length,
    };
  } else {
    const selectedCandidates = resolveCandidatePool(
      scoredNodes,
      normalizedTopK,
      dppCandidateMultiplier,
      enableDiversitySampling,
      dppQualityWeight,
      retrievalMeta,
    );
    selectedNodeIds = selectedCandidates.map((item) => item.nodeId);
    llmMeta = {
      enabled: false,
      status: "disabled",
      reason: "LLM 精排已关闭，直接采用评分排序",
      candidatePool: 0,
      selectedSeedCount: selectedNodeIds.length,
    };
  }
  retrievalMeta.timings.diversity = roundMs(nowMs() - diversityStartedAt);
  retrievalMeta.timings.llm = roundMs(llmDurationMs);

  selectedNodeIds = reconstructSceneNodeIds(
    graph,
    selectedNodeIds,
    normalizedMaxRecallNodes,
  );

  // 访问强化
  const selectedNodes = selectedNodeIds
    .map((id) => getNode(graph, id))
    .filter(Boolean);

  reinforceAccessBatch(selectedNodes);

  console.log(`[ST-BME] 检索完成: 选中 ${selectedNodeIds.length} 个节点`);

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

  selectedNodeIds = uniqueNodeIds(selectedNodeIds).slice(
    0,
    normalizedMaxRecallNodes,
  );
  retrievalMeta.llm = llmMeta;
  retrievalMeta.timings.total = roundMs(nowMs() - startedAt);

  return buildResult(graph, selectedNodeIds, schema, {
    retrieval: retrievalMeta,
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

function buildResidualBasisNodes(
  graph,
  exactEntityAnchors,
  vectorResults,
  maxNodes = 24,
) {
  const basis = [];
  const seen = new Set();

  for (const anchor of exactEntityAnchors || []) {
    const node = getNode(graph, anchor?.nodeId);
    if (
      !node ||
      seen.has(node.id) ||
      !Array.isArray(node.embedding) ||
      node.embedding.length === 0
    ) {
      continue;
    }
    seen.add(node.id);
    basis.push(node);
    if (basis.length >= maxNodes) return basis;
  }

  for (const result of vectorResults || []) {
    const node = getNode(graph, result?.nodeId);
    if (
      !isEligibleAnchorNode(node) ||
      seen.has(node?.id) ||
      !Array.isArray(node?.embedding) ||
      node.embedding.length === 0
    ) {
      continue;
    }
    seen.add(node.id);
    basis.push(node);
    if (basis.length >= maxNodes) break;
  }

  return basis;
}

function resolveCandidatePool(
  scoredNodes,
  targetCount,
  multiplier,
  enableDiversitySampling,
  qualityWeight,
  retrievalMeta,
) {
  const safeTarget = Math.max(1, targetCount);
  const fallback = scoredNodes.slice(0, Math.min(safeTarget, scoredNodes.length));
  retrievalMeta.candidatePoolBeforeDpp = fallback.length;
  retrievalMeta.candidatePoolAfterDpp = fallback.length;
  retrievalMeta.diversityApplied = false;

  if (!enableDiversitySampling) {
    return fallback;
  }

  const poolLimit = Math.min(
    scoredNodes.length,
    Math.max(safeTarget, safeTarget * Math.max(1, multiplier)),
  );
  const pool = scoredNodes.slice(0, poolLimit);
  retrievalMeta.candidatePoolBeforeDpp = pool.length;

  const diversity = applyDiversitySampling(pool, {
    k: safeTarget,
    qualityWeight,
  });
  retrievalMeta.candidatePoolAfterDpp = diversity.afterCount;
  retrievalMeta.diversityApplied = diversity.applied;
  pushSkipReason(retrievalMeta, diversity.reason);

  return diversity.applied ? diversity.selected : fallback;
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
  onStreamProgress = null,
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
  const recallRegexInput = { entries: [] };
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
    recallRegexInput,
    "system",
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
  const promptPayload = resolveTaskPromptPayload(recallPromptBuild, userPrompt);

  const llmResult = await callLLMForJSON({
    systemPrompt: resolveTaskLlmSystemPrompt(promptPayload, systemPrompt),
    userPrompt: promptPayload.userPrompt,
    maxRetries: 1,
    signal,
    taskType: "recall",
    debugContext: createTaskLlmDebugContext(
      recallPromptBuild,
      recallRegexInput,
    ),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayload.additionalMessages,
    onStreamProgress,
    returnFailureDetails: true,
  });
  const result = llmResult?.ok ? llmResult.data : null;

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
  const fallbackReason = llmResult?.ok
    ? Array.isArray(result?.selected_ids)
      ? "LLM 返回的候选 ID 无效，已回退到评分排序"
      : "LLM 返回了无法识别的 JSON 结构，已回退到评分排序"
    : buildRecallFallbackReason(llmResult);
  return {
    selectedNodeIds: candidates.slice(0, maxNodes).map((c) => c.nodeId),
    status: "fallback",
    reason: fallbackReason,
    fallbackType: llmResult?.ok ? "invalid-candidate" : llmResult?.errorType || "unknown",
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
