import { buildTemporalAdjacencyMap, getActiveNodes, getNode } from "../graph/graph.js";
import { findSimilarNodesByText, validateVectorConfig } from "../vector/vector-index.js";
import { hybridScore } from "./dynamics.js";
import { diffuseAndRank } from "./diffusion.js";
import { mergeVectorResults, splitIntentSegments } from "./retrieval-enhancer.js";
import { runLimited } from "../runtime/concurrency.js";

function nowMs() {
  if (typeof performance?.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

export function clampPositiveInt(value, fallback, min = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function clampRange(value, fallback, min = 0, max = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeQueryText(value, maxLength = 400) {
  const normalized = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.slice(0, Math.max(1, maxLength));
}

export function createTextPreview(text, maxLength = 120) {
  const normalized = normalizeQueryText(text, maxLength + 4);
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
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

function parseContextLine(line = "") {
  const raw = String(line ?? "").trim();
  if (!raw) return null;

  const bracketMatch = raw.match(/^\[(user|assistant)\]\s*:\s*([\s\S]*)$/i);
  if (bracketMatch) {
    const role = String(bracketMatch[1] || "").toLowerCase();
    const text = normalizeQueryText(bracketMatch[2] || "");
    return text ? { role, text } : null;
  }

  const plainMatch = raw.match(/^(user|assistant|用户|助手|ai)\s*[：:]\s*([\s\S]*)$/i);
  if (!plainMatch) return null;

  const roleToken = String(plainMatch[1] || "").toLowerCase();
  const role =
    roleToken === "assistant" || roleToken === "助手" || roleToken === "ai"
      ? "assistant"
      : "user";
  const text = normalizeQueryText(plainMatch[2] || "");
  return text ? { role, text } : null;
}

export function buildContextQueryBlend(
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
    ? recentMessages.map((line) => parseContextLine(line)).filter(Boolean)
    : [];

  for (let index = parsedMessages.length - 1; index >= 0; index -= 1) {
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
        ? Math.round(
            ((Math.max(0, Number(part.weight) || 0) || 0) / totalWeight) * 1000,
          ) / 1000
        : Math.round((1 / dedupedParts.length) * 1000) / 1000,
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

export function buildVectorQueryPlan(
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

export function buildLexicalQuerySources(
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
      for (let index = 0; index < token.length - 1; index += 1) {
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

export function computeLexicalScore(node, querySources = []) {
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

export function scaleVectorResults(results = [], weight = 1) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    ...item,
    score: (Number(item?.score) || 0) * Math.max(0, Number(weight) || 0),
  }));
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

export async function vectorPreFilter(
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
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    console.error("[ST-BME] 向量预筛失败:", error);
    return [];
  }
}

export function extractEntityAnchors(userMessage, activeNodes) {
  const anchors = [];
  const seen = new Set();

  for (const node of Array.isArray(activeNodes) ? activeNodes : []) {
    const candidates = [node?.fields?.name, node?.fields?.title]
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length >= 2);

    for (const candidate of candidates) {
      if (!String(userMessage || "").includes(candidate)) continue;
      const key = `${node.id}:${candidate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ nodeId: node.id, entity: candidate });
      break;
    }
  }

  return anchors;
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

export async function rankNodesForTaskContext({
  graph,
  userMessage,
  recentMessages = [],
  embeddingConfig,
  signal = undefined,
  options = {},
} = {}) {
  const topK = clampPositiveInt(options.topK, 20);
  const diffusionTopK = clampPositiveInt(options.diffusionTopK, 100);
  const enableVectorPrefilter = options.enableVectorPrefilter ?? true;
  const enableGraphDiffusion = options.enableGraphDiffusion ?? true;
  const enableContextQueryBlend = options.enableContextQueryBlend ?? true;
  const enableMultiIntent = options.enableMultiIntent ?? true;
  const multiIntentMaxSegments = clampPositiveInt(
    options.multiIntentMaxSegments,
    4,
  );
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
  const teleportAlpha = clampRange(options.teleportAlpha, 0.15);
  const enableTemporalLinks = options.enableTemporalLinks ?? true;
  const temporalLinkStrength = clampRange(
    options.temporalLinkStrength,
    0.2,
    0,
    1,
  );
  const maxTextLength = clampPositiveInt(options.maxTextLength, 400, 32);
  const weights = options.weights ?? {};
  const activeNodes = Array.isArray(options.activeNodes)
    ? options.activeNodes.filter((node) => node && !node.archived)
    : getActiveNodes(graph).filter((node) => node && !node.archived);
  const vectorValidation = validateVectorConfig(embeddingConfig);
  const rankingStartedAt = nowMs();
  const queryBlendStartedAt = nowMs();
  const contextQueryBlend = buildContextQueryBlend(userMessage, recentMessages, {
    enabled: enableContextQueryBlend,
    assistantWeight: contextAssistantWeight,
    previousUserWeight: contextPreviousUserWeight,
    maxTextLength,
  });
  const queryPlan = buildVectorQueryPlan(contextQueryBlend, {
    enableMultiIntent,
    maxSegments: multiIntentMaxSegments,
  });
  const lexicalQuery = buildLexicalQuerySources(
    contextQueryBlend.currentText || userMessage,
    {
      enableMultiIntent,
      maxSegments: multiIntentMaxSegments,
    },
  );
  const queryBlendMs = roundMs(nowMs() - queryBlendStartedAt);
  const diagnostics = {
    queryBlendActive: contextQueryBlend.active,
    queryBlendParts: (contextQueryBlend.parts || []).map((part) => ({
      kind: part.kind,
      label: part.label,
      weight: part.weight,
      text: createTextPreview(part.text),
      length: part.text.length,
    })),
    queryBlendWeights: Object.fromEntries(
      (contextQueryBlend.parts || []).map((part) => [part.kind, part.weight]),
    ),
    segmentsUsed: [...(queryPlan.currentSegments || [])],
    vectorValidation,
    vectorHits: 0,
    vectorMergedHits: 0,
    seedCount: 0,
    diffusionHits: 0,
    temporalSyntheticEdgeCount: 0,
    teleportAlpha,
    lexicalBoostedNodes: 0,
    lexicalTopHits: [],
    skipReasons: [],
    timings: {
      queryBlend: queryBlendMs,
      vector: 0,
      diffusion: 0,
      lexical: 0,
      scoring: 0,
      total: 0,
    },
  };

  if (!graph || activeNodes.length === 0) {
    diagnostics.timings.total = roundMs(nowMs() - rankingStartedAt);
    return {
      activeNodes,
      contextQueryBlend,
      queryPlan,
      lexicalQuery,
      vectorResults: [],
      exactEntityAnchors: [],
      diffusionResults: [],
      scoredNodes: [],
      diagnostics,
    };
  }

  let vectorResults = [];
  const vectorStartedAt = nowMs();
  if (enableVectorPrefilter && vectorValidation.valid) {
    const vectorTasks = [];
    for (const part of queryPlan.plan) {
      for (const queryText of part.queries) {
        vectorTasks.push({
          queryText,
          weight: part.weight || 1,
        });
      }
    }
    const vectorQueryConcurrency = clampPositiveInt(
      options.vectorQueryConcurrency,
      1,
    );
    const groups = await runLimited(
      vectorTasks,
      async ({ queryText, weight }) => {
        const results = await vectorPreFilter(
          graph,
          queryText,
          activeNodes,
          embeddingConfig,
          topK,
          signal,
        );
        return scaleVectorResults(results, weight);
      },
      {
        concurrency: vectorQueryConcurrency,
        signal,
      },
    );

    const merged = mergeVectorResults(groups, Math.max(topK * 2, 24));
    diagnostics.vectorHits = merged.rawHitCount;
    diagnostics.vectorMergedHits = merged.results.length;
    vectorResults = merged.results;
  } else if (enableVectorPrefilter) {
    diagnostics.skipReasons.push("vector-config-invalid");
  }
  diagnostics.timings.vector = roundMs(nowMs() - vectorStartedAt);

  const exactEntityAnchors = extractEntityAnchors(
    contextQueryBlend.currentText || userMessage,
    activeNodes,
  );

  let diffusionResults = [];
  const diffusionStartedAt = nowMs();
  if (enableGraphDiffusion) {
    const seeds = [
      ...vectorResults.map((item) => ({ id: item.nodeId, energy: item.score })),
      ...exactEntityAnchors.map((item) => ({ id: item.nodeId, energy: 2.0 })),
    ];
    const seedMap = new Map();
    for (const seed of seeds) {
      const existing = seedMap.get(seed.id) || 0;
      if (seed.energy > existing) {
        seedMap.set(seed.id, seed.energy);
      }
    }
    const uniqueSeeds = [...seedMap.entries()].map(([id, energy]) => ({
      id,
      energy,
    }));
    diagnostics.seedCount = uniqueSeeds.length;

    if (uniqueSeeds.length > 0) {
      const adjacencyMap = buildTemporalAdjacencyMap(graph, {
        includeTemporalLinks: enableTemporalLinks,
        temporalLinkStrength,
      });
      diagnostics.temporalSyntheticEdgeCount =
        Number(adjacencyMap?.syntheticEdgeCount) || 0;
      diffusionResults = diffuseAndRank(adjacencyMap, uniqueSeeds, {
        maxSteps: 2,
        decayFactor: 0.6,
        topK: diffusionTopK,
        teleportAlpha,
      }).filter((item) => {
        const node = getNode(graph, item.nodeId);
        return node && !node.archived;
      });
    }
  }
  diagnostics.diffusionHits = diffusionResults.length;
  diagnostics.timings.diffusion = roundMs(nowMs() - diffusionStartedAt);

  const scoreMap = new Map();
  for (const item of vectorResults) {
    const entry = scoreMap.get(item.nodeId) || { graphScore: 0, vectorScore: 0 };
    entry.vectorScore = item.score;
    scoreMap.set(item.nodeId, entry);
  }
  for (const item of diffusionResults) {
    const entry = scoreMap.get(item.nodeId) || { graphScore: 0, vectorScore: 0 };
    entry.graphScore = item.energy;
    scoreMap.set(item.nodeId, entry);
  }
  if (scoreMap.size === 0) {
    for (const node of activeNodes) {
      if (!scoreMap.has(node.id)) {
        scoreMap.set(node.id, { graphScore: 0, vectorScore: 0 });
      }
    }
  }

  const scoringStartedAt = nowMs();
  let lexicalMs = 0;
  const scoredNodes = [];
  for (const [nodeId, scores] of scoreMap.entries()) {
    const node = getNode(graph, nodeId);
    if (!node || node.archived) continue;
    const lexicalStartedAt = enableLexicalBoost ? nowMs() : 0;
    const lexicalScore = enableLexicalBoost
      ? computeLexicalScore(node, lexicalQuery.sources)
      : 0;
    if (enableLexicalBoost) {
      lexicalMs += nowMs() - lexicalStartedAt;
    }
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
      graphScore: scores.graphScore,
      vectorScore: scores.vectorScore,
      lexicalScore,
      finalScore,
      weightedScore: finalScore,
    });
  }
  diagnostics.timings.lexical = roundMs(lexicalMs);
  diagnostics.timings.scoring = roundMs(nowMs() - scoringStartedAt);

  scoredNodes.sort((left, right) => {
    const weightedDelta =
      (Number(right.weightedScore) || 0) - (Number(left.weightedScore) || 0);
    if (weightedDelta !== 0) return weightedDelta;
    const finalDelta =
      (Number(right.finalScore) || 0) - (Number(left.finalScore) || 0);
    if (finalDelta !== 0) return finalDelta;
    const lexicalDelta =
      (Number(right.lexicalScore) || 0) - (Number(left.lexicalScore) || 0);
    if (lexicalDelta !== 0) return lexicalDelta;
    return String(left.nodeId).localeCompare(String(right.nodeId));
  });

  diagnostics.lexicalBoostedNodes = scoredNodes.filter(
    (item) => (Number(item.lexicalScore) || 0) > 0,
  ).length;
  diagnostics.lexicalTopHits = buildLexicalTopHits(scoredNodes);
  diagnostics.timings.total = roundMs(nowMs() - rankingStartedAt);

  return {
    activeNodes,
    contextQueryBlend,
    queryPlan,
    lexicalQuery,
    vectorResults,
    exactEntityAnchors,
    diffusionResults,
    scoredNodes,
    diagnostics,
  };
}
