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
    queryBlendActive: false,
    queryBlendParts: [],
    queryBlendWeights: {},
    vectorMergedHits: 0,
    seedCount: 0,
    temporalSyntheticEdgeCount: 0,
    teleportAlpha: 0,
    lexicalBoostedNodes: 0,
    lexicalTopHits: [],
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

function normalizeQueryText(value, maxLength = 400) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, Math.max(1, maxLength));
}

function createTextPreview(text, maxLength = 120) {
  const normalized = normalizeQueryText(text, maxLength + 4);
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function roundBlendWeight(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function uniqueStrings(values = [], maxLength = 400) {
  const result = [];
  const seen = new Set();

  for (const value of values) {
    const text = normalizeQueryText(value, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

function parseRecallContextLine(line = "") {
  const raw = String(line ?? "").trim();
  if (!raw) return null;

  const bracketMatch = raw.match(/^\[(user|assistant)\]\s*:\s*([\s\S]*)$/i);
  if (bracketMatch) {
    const role = String(bracketMatch[1] || "").toLowerCase();
    const text = normalizeQueryText(bracketMatch[2] || "");
    return text ? { role, text } : null;
  }

  const plainMatch = raw.match(
    /^(user|assistant|用户|助手|ai)\s*[：:]\s*([\s\S]*)$/i,
  );
  if (!plainMatch) return null;

  const roleToken = String(plainMatch[1] || "").toLowerCase();
  const role =
    roleToken === "assistant" || roleToken === "助手" || roleToken === "ai"
      ? "assistant"
      : "user";
  const text = normalizeQueryText(plainMatch[2] || "");
  return text ? { role, text } : null;
}

function buildContextQueryBlend(
  userMessage,
  recentMessages = [],
  {
    enabled = true,
    assistantWeight = 0.2,
    previousUserWeight = 0.1,
    maxTextLength = 400,
  } = {},
) {
  const currentText = normalizeQueryText(userMessage, maxTextLength);
  const normalizedAssistantWeight = clampRange(assistantWeight, 0.2, 0, 1);
  const normalizedPreviousUserWeight = clampRange(
    previousUserWeight,
    0.1,
    0,
    1,
  );
  const currentWeight = Math.max(
    0,
    1 - normalizedAssistantWeight - normalizedPreviousUserWeight,
  );

  let assistantText = "";
  let previousUserText = "";
  const parsedMessages = Array.isArray(recentMessages)
    ? recentMessages.map((line) => parseRecallContextLine(line)).filter(Boolean)
    : [];

  for (let index = parsedMessages.length - 1; index >= 0; index--) {
    const item = parsedMessages[index];
    if (!assistantText && item.role === "assistant") {
      assistantText = normalizeQueryText(item.text, maxTextLength);
    }
    if (
      !previousUserText &&
      item.role === "user" &&
      normalizeQueryText(item.text, maxTextLength).toLowerCase() !==
        currentText.toLowerCase()
    ) {
      previousUserText = normalizeQueryText(item.text, maxTextLength);
    }
    if (assistantText && previousUserText) break;
  }

  const rawParts = [
    {
      kind: "currentUser",
      label: "当前用户消息",
      text: currentText,
      weight: enabled ? currentWeight : 1,
    },
  ];

  if (enabled && assistantText) {
    rawParts.push({
      kind: "assistantContext",
      label: "最近 assistant 回复",
      text: assistantText,
      weight: normalizedAssistantWeight,
    });
  }

  if (enabled && previousUserText) {
    rawParts.push({
      kind: "previousUser",
      label: "上一条 user 消息",
      text: previousUserText,
      weight: normalizedPreviousUserWeight,
    });
  }

  const dedupedParts = [];
  const seen = new Set();
  for (const part of rawParts) {
    const text = normalizeQueryText(part.text, maxTextLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    dedupedParts.push({
      ...part,
      text,
    });
  }

  if (dedupedParts.length === 0) {
    return {
      active: false,
      parts: [],
      currentText: "",
      assistantText: "",
      previousUserText: "",
      combinedText: "",
    };
  }

  const totalWeight = dedupedParts.reduce(
    (sum, part) => sum + Math.max(0, Number(part.weight) || 0),
    0,
  );
  const normalizedParts = dedupedParts.map((part) => ({
    ...part,
    weight:
      totalWeight > 0
        ? roundBlendWeight((Math.max(0, Number(part.weight) || 0) || 0) / totalWeight)
        : roundBlendWeight(1 / dedupedParts.length),
  }));
  const combinedText =
    normalizedParts.length <= 1
      ? normalizedParts[0]?.text || ""
      : normalizedParts
          .map((part) => `${part.label}:\n${part.text}`)
          .join("\n\n");

  return {
    active: enabled && normalizedParts.length > 1,
    parts: normalizedParts,
    currentText: currentText || normalizedParts[0]?.text || "",
    assistantText,
    previousUserText,
    combinedText,
  };
}

function buildVectorQueryPlan(
  blendPlan,
  { enableMultiIntent = true, maxSegments = 4 } = {},
) {
  const plan = [];
  let currentSegments = [];

  for (const part of blendPlan?.parts || []) {
    let queries = [part.text];
    if (part.kind === "currentUser" && enableMultiIntent) {
      currentSegments = splitIntentSegments(part.text, { maxSegments });
      queries = uniqueStrings([
        part.text,
        ...currentSegments.filter((item) => item !== part.text),
      ]);
    } else {
      queries = uniqueStrings([part.text]);
    }

    plan.push({
      kind: part.kind,
      label: part.label,
      weight: part.weight,
      queries,
    });
  }

  return {
    plan,
    currentSegments,
  };
}

function buildLexicalQuerySources(
  userMessage,
  { enableMultiIntent = true, maxSegments = 4 } = {},
) {
  const currentText = normalizeQueryText(userMessage, 400);
  const segments = enableMultiIntent
    ? splitIntentSegments(currentText, { maxSegments })
    : [];
  return {
    sources: uniqueStrings([currentText, ...segments]),
    segments,
  };
}

function normalizeLexicalText(value = "") {
  return normalizeQueryText(value, 600).toLowerCase();
}

function buildLexicalUnits(text = "") {
  const normalized = normalizeLexicalText(text);
  if (!normalized) return [];

  const rawTokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  const units = [];

  for (const token of rawTokens) {
    if (token.length >= 2) {
      units.push(token);
    }
    if (/[\u4e00-\u9fff]/.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index++) {
        units.push(token.slice(index, index + 2));
      }
    }
  }

  return [...new Set(units)];
}

function computeTokenOverlapScore(sourceUnits = [], targetUnits = []) {
  if (!sourceUnits.length || !targetUnits.length) return 0;
  const targetSet = new Set(targetUnits);
  let overlap = 0;
  for (const unit of sourceUnits) {
    if (targetSet.has(unit)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(1, sourceUnits.length);
}

function scoreFieldMatch(
  fieldText,
  querySources = [],
  { exact = 1, includes = 0.9, overlap = 0.6 } = {},
) {
  const normalizedField = normalizeLexicalText(fieldText);
  if (!normalizedField) return 0;

  const fieldUnits = buildLexicalUnits(normalizedField);
  let best = 0;

  for (const sourceText of querySources) {
    const normalizedSource = normalizeLexicalText(sourceText);
    if (!normalizedSource) continue;

    if (normalizedSource === normalizedField) {
      best = Math.max(best, exact);
      continue;
    }

    if (
      Math.min(normalizedSource.length, normalizedField.length) >= 2 &&
      (normalizedSource.includes(normalizedField) ||
        normalizedField.includes(normalizedSource))
    ) {
      best = Math.max(best, includes);
    }

    const overlapScore = computeTokenOverlapScore(
      buildLexicalUnits(normalizedSource),
      fieldUnits,
    );
    best = Math.max(best, overlapScore * overlap);
  }

  return Math.min(1, best);
}

function collectNodeLexicalTexts(node, fieldNames = []) {
  const values = [];
  for (const fieldName of fieldNames) {
    const value = node?.fields?.[fieldName];
    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          values.push(item.trim());
        }
      }
    }
  }
  return values;
}

function computeLexicalScore(node, querySources = []) {
  if (!node || !Array.isArray(querySources) || querySources.length === 0) {
    return 0;
  }

  const primaryTexts = collectNodeLexicalTexts(node, ["name", "title"]);
  const secondaryTexts = collectNodeLexicalTexts(node, [
    "summary",
    "insight",
    "state",
    "traits",
    "participants",
    "status",
  ]);
  const combinedText = [...primaryTexts, ...secondaryTexts].join(" ");

  const primaryScore = primaryTexts.reduce(
    (best, value) =>
      Math.max(
        best,
        scoreFieldMatch(value, querySources, {
          exact: 1,
          includes: 0.92,
          overlap: 0.72,
        }),
      ),
    0,
  );
  const secondaryScore = secondaryTexts.reduce(
    (best, value) =>
      Math.max(
        best,
        scoreFieldMatch(value, querySources, {
          exact: 0.82,
          includes: 0.68,
          overlap: 0.52,
        }),
      ),
    0,
  );
  const tokenScore = scoreFieldMatch(combinedText, querySources, {
    exact: 0.65,
    includes: 0.55,
    overlap: 0.45,
  });

  if (primaryScore <= 0 && secondaryScore <= 0 && tokenScore <= 0) {
    return 0;
  }

  return Math.min(
    1,
    Math.max(
      primaryScore,
      secondaryScore * 0.82,
      tokenScore * 0.7,
      primaryScore * 0.75 + secondaryScore * 0.35 + tokenScore * 0.2,
    ),
  );
}

function buildLexicalTopHits(scoredNodes = [], maxCount = 5) {
  return scoredNodes
    .filter((item) => (Number(item?.lexicalScore) || 0) > 0)
    .sort((a, b) => {
      const lexicalDelta =
        (Number(b?.lexicalScore) || 0) - (Number(a?.lexicalScore) || 0);
      if (lexicalDelta !== 0) return lexicalDelta;
      return (Number(b?.finalScore) || 0) - (Number(a?.finalScore) || 0);
    })
    .slice(0, Math.max(1, maxCount))
    .map((item) => ({
      nodeId: item.nodeId,
      type: item.node?.type || "",
      label:
        item.node?.fields?.name ||
        item.node?.fields?.title ||
        item.node?.fields?.summary ||
        item.nodeId,
      lexicalScore: Math.round((Number(item.lexicalScore) || 0) * 1000) / 1000,
      finalScore: Math.round((Number(item.finalScore) || 0) * 1000) / 1000,
    }));
}

function scaleVectorResults(results = [], weight = 1) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    ...item,
    score: (Number(item?.score) || 0) * Math.max(0, Number(weight) || 0),
  }));
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
  const enableContextQueryBlend = options.enableContextQueryBlend ?? true;
  const contextAssistantWeight = clampRange(
    options.contextAssistantWeight,
    0.2,
    0,
    1,
  );
  const contextPreviousUserWeight = clampRange(
    options.contextPreviousUserWeight,
    0.1,
    0,
    1,
  );
  const enableLexicalBoost = options.enableLexicalBoost ?? true;
  const lexicalWeight = clampRange(options.lexicalWeight, 0.18, 0, 10);

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
  const contextQueryBlend = buildContextQueryBlend(userMessage, recentMessages, {
    enabled: enableContextQueryBlend,
    assistantWeight: contextAssistantWeight,
    previousUserWeight: contextPreviousUserWeight,
  });
  retrievalMeta.queryBlendActive = contextQueryBlend.active;
  retrievalMeta.queryBlendParts = (contextQueryBlend.parts || []).map((part) => ({
    kind: part.kind,
    label: part.label,
    weight: part.weight,
    text: createTextPreview(part.text),
    length: part.text.length,
  }));
  retrievalMeta.queryBlendWeights = Object.fromEntries(
    (contextQueryBlend.parts || []).map((part) => [part.kind, part.weight]),
  );
  const lexicalQuery = buildLexicalQuerySources(
    contextQueryBlend.currentText || userMessage,
    {
      enableMultiIntent,
      maxSegments: multiIntentMaxSegments,
    },
  );
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
    const queryPlan = buildVectorQueryPlan(contextQueryBlend, {
      enableMultiIntent,
      maxSegments: multiIntentMaxSegments,
    });
    const groups = [];

    retrievalMeta.segmentsUsed = queryPlan.currentSegments;
    for (const part of queryPlan.plan) {
      for (const queryText of part.queries) {
        const results = await vectorPreFilter(
          graph,
          queryText,
          activeNodes,
          embeddingConfig,
          normalizedTopK,
          signal,
        );
        groups.push(scaleVectorResults(results, part.weight || 1));
      }
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

  exactEntityAnchors.push(
    ...extractEntityAnchors(
      contextQueryBlend.currentText || userMessage,
      activeNodes,
    ),
  );
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
      queryText: contextQueryBlend.combinedText || userMessage,
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
    const lexicalScore = enableLexicalBoost
      ? computeLexicalScore(node, lexicalQuery.sources)
      : 0;

    const finalScore = hybridScore(
      {
        graphScore: scores.graphScore,
        vectorScore: scores.vectorScore,
        lexicalScore,
        importance: node.importance,
        createdTime: node.createdTime,
      },
      {
        ...weights,
        lexicalWeight: enableLexicalBoost ? lexicalWeight : 0,
      },
    );

    scoredNodes.push({
      nodeId,
      node,
      finalScore,
      lexicalScore,
      ...scores,
    });
  }

  scoredNodes.sort((a, b) => b.finalScore - a.finalScore);
  retrievalMeta.scoredCandidates = scoredNodes.length;
  retrievalMeta.lexicalBoostedNodes = scoredNodes.filter(
    (item) => (Number(item.lexicalScore) || 0) > 0,
  ).length;
  retrievalMeta.lexicalTopHits = buildLexicalTopHits(scoredNodes);
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
    maxRetries: 2,
    signal,
    taskType: "recall",
    debugContext: createTaskLlmDebugContext(
      recallPromptBuild,
      recallRegexInput,
    ),
    promptMessages: promptPayload.promptMessages,
    additionalMessages: promptPayload.additionalMessages,
    onStreamProgress,
    maxCompletionTokens: Math.max(512, maxNodes * 160),
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
