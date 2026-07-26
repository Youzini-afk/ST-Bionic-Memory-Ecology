// ST-BME: 三层混合检索编排
// 融合向量预筛（PeroCore）+ 图扩散（PeroCore PEDSA）+ 可选 LLM 精确召回
// v2: + 认知边界过滤(RoleRAG) + 双记忆交叉检索(AriGraph) + 概率触发

import { debugLog } from "../runtime/debug-logging.js";
import { diffuseAndRank } from "./diffusion.js";
import { hybridScore, reinforceAccessBatch } from "./dynamics.js";
import {
  buildTemporalAdjacencyMap,
  getActiveNodes,
  getNode,
  getNodeEdges,
} from "../graph/graph.js";
import { callLLMForJSON } from "../llm/llm.js";
import {
  buildTaskExecutionDebugContext,
  buildTaskLlmPayload,
  buildTaskPrompt,
  EXTRACTION_CONTEXT_REVIEW_HEADER,
  RECALL_TARGET_CONTENT_HEADER,
} from "../prompting/prompt-builder.js";
import {
  applyCooccurrenceBoost,
  applyDiversitySampling,
  collectSupplementalAnchorNodeIds,
  createCooccurrenceIndex,
  isEligibleAnchorNode,
  runResidualRecall,
} from "./retrieval-enhancer.js";
import {
  MEMORY_SCOPE_BUCKETS,
  classifyNodeScopeBucket,
  describeMemoryScope,
  describeScopeBucket,
  getScopeRegionKey,
  normalizeMemoryScope,
  resolveScopeBucketWeight,
} from "../graph/memory-scope.js";
import { resolveAuthorityRecallCandidates } from "./authority-candidate-provider.js";
import { rankNodesForTaskContext } from "./shared-ranking.js";
import {
  computeKnowledgeGateForNode,
  listKnowledgeOwners,
  pushRecentRecallOwner,
  resolveActiveRegionContext,
  resolveAdjacentRegions,
  resolveKnowledgeOwner,
  resolveKnowledgeOwnerKeyFromScope,
} from "../graph/knowledge-state.js";
import {
  classifyStoryTemporalBucket,
  describeNodeStoryTime,
  resolveActiveStoryContext,
  resolveStoryCueMode,
  STORY_TEMPORAL_BUCKETS,
} from "../graph/story-timeline.js";
import { getActiveSummaryEntries } from "../graph/summary-state.js";
import { applyTaskRegex } from "../prompting/task-regex.js";
import { createPromptNodeReferenceMap } from "../prompting/prompt-node-references.js";
import { getSTContextForPrompt } from "../host/st-context.js";

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

function buildRecallSectionedTranscript(recentMessages = []) {
  const lines = (Array.isArray(recentMessages) ? recentMessages : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  const targetLines = [lines[lines.length - 1]].filter(Boolean);
  const contextLines = lines.slice(0, -1).filter(Boolean);
  const sections = [];

  if (contextLines.length > 0) {
    sections.push(
      `${EXTRACTION_CONTEXT_REVIEW_HEADER}\n\n${contextLines.join("\n---\n")}`,
    );
  }
  if (targetLines.length > 0) {
    sections.push(
      `${RECALL_TARGET_CONTENT_HEADER}\n\n${targetLines.join("\n---\n")}`,
    );
  }

  return sections.join("\n\n");
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
    scopeBuckets: {},
    temporalBuckets: {},
    activeRegion: "",
    activeRegionSource: "",
    activeStorySegmentId: "",
    activeStoryTimeLabel: "",
    activeStoryTimeSource: "",
    activeCharacterPovOwner: "",
    activeUserPovOwner: "",
    activeRecallOwnerKey: "",
    activeRecallOwnerKeys: [],
    activeRecallOwnerScores: {},
    activeNodeCount: 0,
    rankingNodeCount: 0,
    sceneOwnerResolutionMode: "unresolved",
    sceneOwnerCandidates: [],
    bucketWeights: {},
    authorityCandidateProvider: "",
    authorityCandidateUsed: false,
    authorityCandidateCount: 0,
    authorityCandidateFilteredCount: 0,
    authorityCandidateSearchHits: 0,
    authorityCandidateNeighborCount: 0,
    authorityCandidateQueryTexts: [],
    authorityCandidateFallbackReason: "",
    selectedByBucket: {},
    knowledgeGateMode: "disabled",
    knowledgeAnchoredNodes: [],
    knowledgeSuppressedNodes: [],
    knowledgeRescuedNodes: [],
    knowledgeVisibleOwnersByNode: {},
    knowledgeSuppressedOwnersByNode: {},
    visibilityTopHits: [],
    visibilitySuppressedReasons: {},
    adjacentRegionMatches: [],
    temporalSuppressedNodes: [],
    temporalRescuedNodes: [],
    temporalTopHits: [],
    selectedByStoryTime: {},
    timelineAdvanceApplied: false,
    selectedByKnowledgeState: {},
    selectedByOwner: {},
    skipReasons: [],
    timings: {},
    llm: {
      enabled: enableLLMRecall,
      status: enableLLMRecall ? "pending" : "disabled",
      reason: enableLLMRecall ? "" : "LLM 精排已关闭",
      selectionProtocol: "",
      rawSelectedKeys: [],
      resolvedSelectedKeys: [],
      resolvedSelectedNodeIds: [],
      fallbackReason: "",
      fallbackType: "",
      emptySelectionAccepted: false,
      candidateKeyMapPreview: {},
      legacySelectionUsed: false,
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

function normalizeRecallSelectionList(values = [], maxLength = 64) {
  const normalized = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
    if (normalized.length >= maxLength) break;
  }
  return normalized;
}

function createRecallCandidateKeyMaps(candidates = []) {
  const referenceMap = createPromptNodeReferenceMap(candidates, {
    prefix: "R",
    maxLength: 80,
    buildMeta: ({ entry }) => ({
      scopeBucket: String(entry?.scopeBucket || ""),
      temporalBucket: String(entry?.temporalBucket || ""),
      score:
        Math.round(
          (Number(entry?.weightedScore ?? entry?.finalScore) || 0) * 1000,
        ) / 1000,
    }),
  });
  return {
    candidateKeyToNodeId: referenceMap.keyToNodeId,
    candidateKeyToCandidateMeta: referenceMap.keyToMeta,
    nodeIdToCandidateKey: referenceMap.nodeIdToKey,
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

function buildVisibilityTopHits(scoredNodes = [], maxCount = 6) {
  return scoredNodes
    .filter((item) => Number(item?.knowledgeVisibilityScore) > 0)
    .sort((a, b) => {
      const visibilityDelta =
        (Number(b?.knowledgeVisibilityScore) || 0) -
        (Number(a?.knowledgeVisibilityScore) || 0);
      if (visibilityDelta !== 0) return visibilityDelta;
      return (Number(b?.weightedScore) || 0) - (Number(a?.weightedScore) || 0);
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
      visibilityScore:
        Math.round((Number(item.knowledgeVisibilityScore) || 0) * 1000) / 1000,
      knowledgeMode: String(item.knowledgeMode || ""),
    }));
}

function pickActiveRegion(graph, optionValue = "") {
  const direct = String(optionValue || "").trim();
  if (direct) return direct;

  const historyRegion = String(
    graph?.historyState?.activeRegion || graph?.historyState?.lastExtractedRegion || "",
  ).trim();
  if (historyRegion) return historyRegion;

  const fallback = getActiveNodes(graph)
    .filter((node) => !node.archived)
    .sort((a, b) => (b.seqRange?.[1] ?? b.seq ?? 0) - (a.seqRange?.[1] ?? a.seq ?? 0))
    .find((node) => getScopeRegionKey(node?.scope));

  return String(getScopeRegionKey(fallback?.scope) || "").trim();
}

function buildScopeBucketWeightMap(options = {}) {
  return {
    [MEMORY_SCOPE_BUCKETS.CHARACTER_POV]: Number(
      options.recallCharacterPovWeight ?? 1.25,
    ),
    [MEMORY_SCOPE_BUCKETS.USER_POV]: Number(options.recallUserPovWeight ?? 1.05),
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION]: Number(
      options.recallObjectiveCurrentRegionWeight ?? 1.15,
    ),
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION]: Number(
      options.recallObjectiveAdjacentRegionWeight ?? 0.9,
    ),
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL]: Number(
      options.recallObjectiveGlobalWeight ?? 0.75,
    ),
    [MEMORY_SCOPE_BUCKETS.OTHER_POV]: 0.6,
  };
}

function createEmptyScopeBucketMap() {
  return {
    [MEMORY_SCOPE_BUCKETS.CHARACTER_POV]: [],
    [MEMORY_SCOPE_BUCKETS.USER_POV]: [],
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION]: [],
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION]: [],
    [MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL]: [],
  };
}

function createEmptyTemporalBucketMap() {
  return {
    [STORY_TEMPORAL_BUCKETS.CURRENT]: [],
    [STORY_TEMPORAL_BUCKETS.ADJACENT_PAST]: [],
    [STORY_TEMPORAL_BUCKETS.DISTANT_PAST]: [],
    [STORY_TEMPORAL_BUCKETS.FLASHBACK]: [],
    [STORY_TEMPORAL_BUCKETS.FUTURE]: [],
    [STORY_TEMPORAL_BUCKETS.UNDATED]: [],
  };
}

function pushScopeBucketDebug(map, bucket, value) {
  if (!Object.prototype.hasOwnProperty.call(map, bucket)) {
    map[bucket] = [];
  }
  map[bucket].push(value);
}

function getScopeBucketPriority(bucket) {
  switch (bucket) {
    case MEMORY_SCOPE_BUCKETS.CHARACTER_POV:
      return 5;
    case MEMORY_SCOPE_BUCKETS.USER_POV:
      return 4;
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION:
      return 3;
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION:
      return 2;
    case MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL:
      return 1;
    default:
      return 0;
  }
}

function getTemporalBucketPriority(bucket) {
  switch (bucket) {
    case STORY_TEMPORAL_BUCKETS.CURRENT:
      return 5;
    case STORY_TEMPORAL_BUCKETS.ADJACENT_PAST:
      return 4;
    case STORY_TEMPORAL_BUCKETS.UNDATED:
      return 3;
    case STORY_TEMPORAL_BUCKETS.FLASHBACK:
      return 2;
    case STORY_TEMPORAL_BUCKETS.DISTANT_PAST:
      return 1;
    case STORY_TEMPORAL_BUCKETS.FUTURE:
      return 0;
    default:
      return 0;
  }
}

function normalizeTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeOwnerKeyList(ownerKeys = []) {
  return [
    ...new Set(
      (Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys])
        .map((value) => normalizeTrimmedString(value))
        .filter(Boolean),
    ),
  ];
}

function roundOwnerScore(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function buildCharacterOwnerCatalog(graph) {
  return (listKnowledgeOwners(graph) || [])
    .filter((entry) => String(entry?.ownerType || "") === "character")
    .map((entry) => ({
      ownerKey: normalizeTrimmedString(entry.ownerKey),
      ownerName: normalizeTrimmedString(entry.ownerName),
      nodeId: normalizeTrimmedString(entry.nodeId),
      aliases: [
        ...new Set(
          [entry.ownerName, ...(entry.aliases || [])]
            .map((value) => normalizeTrimmedString(value))
            .filter(Boolean),
        ),
      ],
      updatedAt: Number(entry?.updatedAt || 0),
    }))
    .filter((entry) => entry.ownerKey && entry.ownerName);
}

function createSceneOwnerCandidateMap() {
  return new Map();
}

function addSceneOwnerCandidate(
  candidateMap,
  owner,
  { score = 0, source = "", reason = "" } = {},
) {
  if (!(candidateMap instanceof Map)) return;
  const ownerKey = normalizeTrimmedString(owner?.ownerKey);
  const ownerName = normalizeTrimmedString(owner?.ownerName);
  if (!ownerKey || !ownerName) return;

  const existing = candidateMap.get(ownerKey) || {
    ownerKey,
    ownerName,
    ownerType: "character",
    nodeId: normalizeTrimmedString(owner?.nodeId),
    aliases: [
      ...new Set(
        [ownerName, ...(owner?.aliases || [])]
          .map((value) => normalizeTrimmedString(value))
          .filter(Boolean),
      ),
    ],
    score: 0,
    sources: [],
    reasons: [],
  };

  existing.score += Math.max(0, Number(score) || 0);
  if (source && !existing.sources.includes(source)) {
    existing.sources.push(source);
  }
  if (reason && !existing.reasons.includes(reason)) {
    existing.reasons.push(reason);
  }
  candidateMap.set(ownerKey, existing);
}

function finalizeSceneOwnerCandidates(candidateMap, maxCount = 8) {
  if (!(candidateMap instanceof Map)) return [];
  return [...candidateMap.values()]
    .map((entry) => ({
      ...entry,
      score: roundOwnerScore(entry.score),
      aliases: [...new Set((entry.aliases || []).filter(Boolean))],
      sources: [...new Set((entry.sources || []).filter(Boolean))],
      reasons: [...new Set((entry.reasons || []).filter(Boolean))],
    }))
    .sort((left, right) => {
      const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(left.ownerName || "").localeCompare(
        String(right.ownerName || ""),
        "zh-Hans-CN",
      );
    })
    .slice(0, Math.max(1, maxCount));
}

function resolveLegacySceneOwner(graph, rawOwnerName = "") {
  const ownerName = normalizeTrimmedString(rawOwnerName);
  if (!ownerName) return null;
  const ownerCatalog = buildCharacterOwnerCatalog(graph);
  const matchedOwners = ownerCatalog.filter(
    (owner) =>
      String(owner.ownerName || "").trim() === ownerName &&
      String(owner.nodeId || "").trim(),
  );
  if (matchedOwners.length !== 1) {
    return null;
  }
  const resolved = resolveKnowledgeOwner(graph, {
    ownerType: "character",
    ownerName,
  });
  return resolved?.ownerKey ? resolved : null;
}

function collectOwnerCandidatesFromText(
  ownerCatalog,
  texts = [],
  { score = 0.8, source = "recent-message" } = {},
) {
  const candidateMap = createSceneOwnerCandidateMap();
  const normalizedTexts = (Array.isArray(texts) ? texts : [texts])
    .map((value) => normalizeQueryText(value, 800).toLowerCase())
    .filter(Boolean);
  if (normalizedTexts.length === 0) {
    return [];
  }

  for (const owner of ownerCatalog || []) {
    const alias = [...(owner.aliases || [])]
      .map((value) => normalizeTrimmedString(value))
      .filter((value) => value.length >= 2)
      .sort((left, right) => right.length - left.length)
      .find((value) =>
        normalizedTexts.some((text) => text.includes(value.toLowerCase())),
      );
    if (!alias) continue;
    addSceneOwnerCandidate(candidateMap, owner, {
      score,
      source,
      reason: `文本直接点名 ${alias}`,
    });
  }

  return finalizeSceneOwnerCandidates(candidateMap, 8);
}

function collectOwnerCandidatesFromNodes(
  graph,
  ownerCatalog,
  nodeEntries = [],
) {
  const candidateMap = createSceneOwnerCandidateMap();

  for (const entry of Array.isArray(nodeEntries) ? nodeEntries : []) {
    const node = entry?.node || entry;
    const baseScore = Math.max(0, Number(entry?.weightedScore ?? entry?.finalScore ?? 0) || 0);
    if (!node || node.archived) continue;

    if (node.type === "pov_memory" && String(node?.scope?.ownerType || "") === "character") {
      const resolvedOwner = resolveKnowledgeOwner(graph, {
        ownerType: "character",
        ownerName: node?.scope?.ownerName || node?.scope?.ownerId,
      });
      if (resolvedOwner.ownerKey) {
        addSceneOwnerCandidate(candidateMap, resolvedOwner, {
          score: 1.0 + Math.min(0.8, baseScore / 8),
          source: "candidate-pov-owner",
          reason: `候选 POV 命中 ${resolvedOwner.ownerName || resolvedOwner.ownerKey}`,
        });
      }
      continue;
    }

    const text = [
      node?.fields?.participants,
      node?.fields?.summary,
      node?.fields?.state,
      node?.fields?.title,
      node?.fields?.name,
      node?.fields?.status,
    ]
      .filter((value) => value != null)
      .join(" ");
    if (!text) continue;

    const matched = collectOwnerCandidatesFromText(ownerCatalog, [text], {
      score: 0.9 + Math.min(0.6, baseScore / 10),
      source: "objective-participant",
    });
    for (const owner of matched) {
      addSceneOwnerCandidate(candidateMap, owner, {
        score: owner.score,
        source: "objective-participant",
        reason: owner.reasons?.[0] || "高分客观节点提到该角色",
      });
    }
  }

  return finalizeSceneOwnerCandidates(candidateMap, 8);
}

function collectRecentActiveOwnerCandidates(
  graph,
  ownerCatalog,
  limit = 4,
) {
  const sorted = [...(ownerCatalog || [])].sort((left, right) => {
    const updatedDelta = Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    if (updatedDelta !== 0) return updatedDelta;
    const leftNode = left.nodeId ? getNode(graph, left.nodeId) : null;
    const rightNode = right.nodeId ? getNode(graph, right.nodeId) : null;
    return (Number(rightNode?.seqRange?.[1] ?? rightNode?.seq ?? 0) || 0)
      - (Number(leftNode?.seqRange?.[1] ?? leftNode?.seq ?? 0) || 0);
  });
  return sorted.slice(0, Math.max(1, limit)).map((owner) => ({
    ...owner,
    score: 0.35,
    sources: ["recent-active"],
    reasons: ["近期活跃角色"],
  }));
}

function mergeSceneOwnerCandidateLists(...lists) {
  const candidateMap = createSceneOwnerCandidateMap();
  for (const list of lists) {
    for (const owner of Array.isArray(list) ? list : []) {
      addSceneOwnerCandidate(candidateMap, owner, {
        score: owner.score,
        source: Array.isArray(owner.sources) ? owner.sources[0] || "" : "",
        reason: Array.isArray(owner.reasons) ? owner.reasons[0] || "" : "",
      });
      for (const source of Array.isArray(owner.sources) ? owner.sources : []) {
        addSceneOwnerCandidate(candidateMap, owner, {
          score: 0,
          source,
          reason: "",
        });
      }
      for (const reason of Array.isArray(owner.reasons) ? owner.reasons : []) {
        addSceneOwnerCandidate(candidateMap, owner, {
          score: 0,
          source: "",
          reason,
        });
      }
    }
  }
  return finalizeSceneOwnerCandidates(candidateMap, 8);
}

function resolveSceneOwnersHeuristically(
  sceneOwnerCandidates = [],
  { mode = "heuristic", maxOwners = 4, minScore = 0.55 } = {},
) {
  const filtered = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .filter(
      (candidate) =>
        candidate?.ownerKey && Number(candidate?.score || 0) >= Number(minScore || 0),
    )
    .slice(0, Math.max(1, maxOwners));
  return {
    ownerKeys: filtered.map((candidate) => candidate.ownerKey),
    ownerScores: Object.fromEntries(
      filtered.map((candidate) => [
        candidate.ownerKey,
        roundOwnerScore(Math.min(1, Number(candidate.score || 0))),
      ]),
    ),
    mode: filtered.length > 0 ? mode : "unresolved",
  };
}

function getSceneOwnerNamesByKeys(sceneOwnerCandidates = [], ownerKeys = []) {
  const keySet = new Set(normalizeOwnerKeyList(ownerKeys));
  if (keySet.size === 0) return [];
  return (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .filter((candidate) => keySet.has(candidate.ownerKey))
    .map((candidate) => candidate.ownerName)
    .filter(Boolean);
}

function buildSceneOwnerCandidateText(sceneOwnerCandidates = []) {
  const candidates = Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [];
  if (candidates.length === 0) {
    return "(当前没有足够可靠的具体角色候选；如果无法判断，请返回空数组)";
  }
  return candidates
    .map((candidate) => {
      const reasonText = Array.isArray(candidate.reasons) && candidate.reasons.length
        ? candidate.reasons.join("；")
        : "无";
      return `- ownerKey=${candidate.ownerKey}; ownerName=${candidate.ownerName}; score=${roundOwnerScore(candidate.score).toFixed(3)}; reasons=${reasonText}`;
    })
    .join("\n");
}

function resolveSceneOwnerKeyFromValue(sceneOwnerCandidates = [], value = "") {
  const normalizedValue = normalizeTrimmedString(value);
  if (!normalizedValue) return "";
  const directMatch = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .find((candidate) => candidate.ownerKey === normalizedValue);
  if (directMatch?.ownerKey) {
    return directMatch.ownerKey;
  }
  const lowered = normalizedValue.toLowerCase();
  const aliasMatch = (Array.isArray(sceneOwnerCandidates) ? sceneOwnerCandidates : [])
    .find((candidate) =>
      [candidate.ownerName, ...(candidate.aliases || [])]
        .map((item) => normalizeTrimmedString(item).toLowerCase())
        .includes(lowered),
    );
  return aliasMatch?.ownerKey || "";
}

function normalizeLlmSceneOwnerScores(
  sceneOwnerCandidates = [],
  rawScores = [],
) {
  const normalizedEntries = Array.isArray(rawScores)
    ? rawScores
    : rawScores && typeof rawScores === "object"
      ? Object.entries(rawScores).map(([ownerKey, score]) => ({
          ownerKey,
          score,
          reason: "",
        }))
      : [];
  const result = [];
  for (const entry of normalizedEntries) {
    const ownerKey = resolveSceneOwnerKeyFromValue(
      sceneOwnerCandidates,
      entry?.ownerKey || entry?.owner || entry?.owner_name || "",
    );
    if (!ownerKey) continue;
    result.push({
      ownerKey,
      score: clampRange(entry?.score, 0, 0, 1),
      reason: normalizeTrimmedString(entry?.reason),
    });
  }
  return result;
}

function buildSelectedByOwner(
  graph,
  selectedNodes = [],
  scoredNodes = [],
  sceneOwnerCandidates = [],
) {
  const scoredMap = new Map(
    (Array.isArray(scoredNodes) ? scoredNodes : []).map((item) => [item.nodeId, item]),
  );
  const result = {};
  for (const node of Array.isArray(selectedNodes) ? selectedNodes : []) {
    if (!node?.id) continue;
    const scored = scoredMap.get(node.id);
    const ownerKeys = normalizeOwnerKeyList([
      resolveKnowledgeOwnerKeyFromScope(graph, node?.scope),
      ...(scored?.knowledgeVisibleOwnerKeys || []),
    ])
      .map((ownerKey) => resolveSceneOwnerKeyFromValue(sceneOwnerCandidates, ownerKey) || ownerKey)
      .filter(Boolean);
    for (const ownerKey of ownerKeys) {
      result[ownerKey] ||= [];
      result[ownerKey].push(node.id);
    }
  }
  return result;
}

function augmentSelectedNodeIdsWithActiveOwnerPov(
  graph,
  selectedNodeIds = [],
  scoredNodes = [],
  activeOwnerKeys = [],
  limit = 8,
) {
  const ownerKeys = normalizeOwnerKeyList(activeOwnerKeys);
  if (ownerKeys.length === 0) {
    return uniqueNodeIds(selectedNodeIds).slice(0, Math.max(1, limit));
  }

  const selectedSet = new Set(uniqueNodeIds(selectedNodeIds));
  const ownerPovNodeIds = [];
  for (const ownerKey of ownerKeys) {
    const bestPov = (Array.isArray(scoredNodes) ? scoredNodes : []).find((item) => {
      if (!item?.node || item.node.archived || item.node.type !== "pov_memory") {
        return false;
      }
      const scopeOwnerKey = resolveKnowledgeOwnerKeyFromScope(graph, item.node.scope);
      return scopeOwnerKey === ownerKey;
    });
    if (!bestPov?.nodeId || selectedSet.has(bestPov.nodeId)) continue;
    selectedSet.add(bestPov.nodeId);
    ownerPovNodeIds.push(bestPov.nodeId);
  }

  return uniqueNodeIds([
    ...ownerPovNodeIds,
    ...selectedNodeIds,
  ]).slice(0, Math.max(1, limit));
}

function buildRecallSceneOwnerAugmentPrompt(maxNodes, sceneOwnerCandidateText = "") {
  return [
    "除了 selected_keys，你还需要同时判断这轮场景里真正参与当前回应的具体人物。",
    `最多返回 ${Math.max(1, Math.min(4, Number(maxNodes) || 4))} 个 active_owner_keys；如果无法可靠判断，可以返回空数组。`,
    "active_owner_keys 必须从给出的 ownerKey 候选里选择，不要用角色卡名替代具体人物。",
    "active_owner_scores 必须是数组，每项格式为 {\"ownerKey\":\"...\",\"score\":0.0,\"reason\":\"...\"}，score 范围 0..1。",
    "selected_keys 只能从当前候选短键里选；如果一个都不选，系统会回退到评分召回。",
    "如果某个客观事实只被部分人物知道，也要保留这些具体人物的判断，不要把所有人混成一个总角色。",
    "",
    "## 场景角色候选",
    sceneOwnerCandidateText || "(无)",
  ].join("\n");
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
  const enableScopedMemory = options.enableScopedMemory ?? true;
  const enablePovMemory = options.enablePovMemory ?? true;
  const enableRegionScopedObjective =
    options.enableRegionScopedObjective ?? true;
  const enableCognitiveMemory = options.enableCognitiveMemory ?? true;
  const enableSpatialAdjacency = options.enableSpatialAdjacency ?? true;
  const injectLowConfidenceObjectiveMemory =
    options.injectLowConfidenceObjectiveMemory ?? false;
  const injectUserPovMemory = options.injectUserPovMemory ?? true;
  const injectObjectiveGlobalMemory = options.injectObjectiveGlobalMemory ?? true;
  const enableStoryTimeline = options.enableStoryTimeline ?? true;
  const injectStoryTimeLabel = options.injectStoryTimeLabel ?? true;
  const storyTimeSoftDirecting = options.storyTimeSoftDirecting ?? true;
  const stPromptContext = getSTContextForPrompt();
  const ownerCatalog = buildCharacterOwnerCatalog(graph);
  const legacyOwnerCandidate =
    resolveLegacySceneOwner(graph, options.activeCharacterPovOwner) ||
    resolveLegacySceneOwner(graph, graph?.historyState?.activeCharacterPovOwner) ||
    resolveLegacySceneOwner(graph, stPromptContext?.charName);
  const activeCharacterPovOwner = String(
    legacyOwnerCandidate?.ownerName || "",
  ).trim();
  const activeUserPovOwner = String(
    options.activeUserPovOwner ||
      graph?.historyState?.activeUserPovOwner ||
      stPromptContext?.userName ||
      "",
  ).trim();
  const preliminarySceneOwnerCandidates = mergeSceneOwnerCandidateLists(
    legacyOwnerCandidate
      ? [
          {
            ...legacyOwnerCandidate,
            score: 0.6,
            sources: ["legacy-unique-match"],
            reasons: ["唯一映射到图内具体角色"],
          },
        ]
      : [],
    collectOwnerCandidatesFromText(ownerCatalog, [
      userMessage,
      ...recentMessages,
    ]),
    collectRecentActiveOwnerCandidates(graph, ownerCatalog),
  );
  const preliminarySceneOwnerResolution = resolveSceneOwnersHeuristically(
    preliminarySceneOwnerCandidates,
    {
      mode: "heuristic",
      maxOwners: 4,
      minScore: 0.55,
    },
  );
  let activeRecallOwnerKeys = normalizeOwnerKeyList(
    options.activeRecallOwnerKeys ||
      preliminarySceneOwnerResolution.ownerKeys ||
      [],
  );
  let activeRecallOwnerScores = {
    ...(preliminarySceneOwnerResolution.ownerScores || {}),
  };
  let sceneOwnerResolutionMode = activeRecallOwnerKeys.length
    ? preliminarySceneOwnerResolution.mode || "heuristic"
    : "unresolved";
  const activeRegionContext = resolveActiveRegionContext(
    graph,
    options.activeRegion || "",
  );
  const activeRegion = activeRegionContext.activeRegion || pickActiveRegion(graph, options.activeRegion);
  const adjacentRegionContext = enableSpatialAdjacency
    ? resolveAdjacentRegions(graph, activeRegion)
    : { adjacentRegions: [] };
  const storyCueMode = enableStoryTimeline
    ? resolveStoryCueMode(userMessage, recentMessages)
    : "";
  const activeStoryContext = enableStoryTimeline
    ? resolveActiveStoryContext(graph, {
        segmentId: options.activeStorySegmentId || "",
        label: options.activeStoryTimeLabel || "",
      })
    : {
        activeSegmentId: "",
        activeStoryTimeLabel: "",
        source: "",
        segment: null,
        resolved: false,
      };
  const bucketWeights = buildScopeBucketWeightMap(options);

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
  let rankingActiveNodes = activeNodes;
  const normalizedTopK = Math.max(1, topK);
  const normalizedMaxRecallNodes = Math.max(1, maxRecallNodes);
  const normalizedDiffusionTopK = Math.max(1, diffusionTopK);
  const normalizedLlmCandidatePool = Math.max(
    normalizedMaxRecallNodes,
    llmCandidatePool,
  );
  const retrievalMeta = createRetrievalMeta(enableLLMRecall);
  retrievalMeta.activeRegion = activeRegion;
  retrievalMeta.activeRegionSource = activeRegionContext.source || "";
  retrievalMeta.activeStorySegmentId = activeStoryContext.activeSegmentId || "";
  retrievalMeta.activeStoryTimeLabel = activeStoryContext.activeStoryTimeLabel || "";
  retrievalMeta.activeStoryTimeSource = activeStoryContext.source || "";
  retrievalMeta.activeCharacterPovOwner =
    activeCharacterPovOwner ||
    preliminarySceneOwnerCandidates[0]?.ownerName ||
    "";
  retrievalMeta.activeUserPovOwner = activeUserPovOwner;
  retrievalMeta.activeRecallOwnerKey = activeRecallOwnerKeys[0] || "";
  retrievalMeta.activeRecallOwnerKeys = [...activeRecallOwnerKeys];
  retrievalMeta.activeRecallOwnerScores = { ...activeRecallOwnerScores };
  retrievalMeta.activeNodeCount = nodeCount;
  retrievalMeta.rankingNodeCount = nodeCount;
  retrievalMeta.sceneOwnerResolutionMode = sceneOwnerResolutionMode;
  retrievalMeta.sceneOwnerCandidates = preliminarySceneOwnerCandidates.map((candidate) => ({
    ownerKey: candidate.ownerKey,
    ownerName: candidate.ownerName,
    score: roundOwnerScore(candidate.score),
    sources: [...(candidate.sources || [])],
    reasons: [...(candidate.reasons || [])],
  }));
  retrievalMeta.bucketWeights = { ...bucketWeights };
  retrievalMeta.temporalBuckets = createEmptyTemporalBucketMap();
  retrievalMeta.knowledgeGateMode = enableCognitiveMemory
    ? "anchored-soft-visibility"
    : "disabled";
  const authorityCandidateStartedAt = nowMs();
  const authorityCandidateResult = await resolveAuthorityRecallCandidates({
    graph,
    userMessage,
    recentMessages,
    embeddingConfig,
    availableNodes: activeNodes,
    activeRegion,
    activeStoryContext,
    activeRecallOwnerKeys,
    sceneOwnerCandidates: preliminarySceneOwnerCandidates,
    signal,
    options: {
      enabled: settings.authorityGraphQueryEnabled !== false,
      topK: normalizedTopK,
      maxRecallNodes: normalizedMaxRecallNodes,
      limit: options.authorityCandidateLimit,
      neighborLimit: options.authorityCandidateNeighborLimit,
      minimumUsedCandidateCount: options.authorityCandidateMinCount,
      queryConcurrency: options.authorityCandidateQueryConcurrency || options.vectorQueryConcurrency,
      enableContextQueryBlend,
      contextAssistantWeight,
      contextPreviousUserWeight,
      enableMultiIntent,
      multiIntentMaxSegments,
    },
  });
  retrievalMeta.authorityCandidateProvider =
    String(authorityCandidateResult?.diagnostics?.provider || "");
  retrievalMeta.authorityCandidateUsed = authorityCandidateResult?.used === true;
  retrievalMeta.authorityCandidateCount = Number(
    authorityCandidateResult?.diagnostics?.candidateCount || 0,
  );
  retrievalMeta.authorityCandidateFilteredCount = Number(
    authorityCandidateResult?.diagnostics?.filteredCount || 0,
  );
  retrievalMeta.authorityCandidateSearchHits = Number(
    authorityCandidateResult?.diagnostics?.searchHits || 0,
  );
  retrievalMeta.authorityCandidateNeighborCount = Number(
    authorityCandidateResult?.diagnostics?.neighborCount || 0,
  );
  retrievalMeta.authorityCandidateQueryTexts = Array.isArray(
    authorityCandidateResult?.diagnostics?.queryTexts,
  )
    ? [...authorityCandidateResult.diagnostics.queryTexts]
    : [];
  retrievalMeta.authorityCandidateFallbackReason = String(
    authorityCandidateResult?.diagnostics?.fallbackReason || "",
  );
  retrievalMeta.timings.authorityCandidates = Number(
    authorityCandidateResult?.diagnostics?.timings?.total || 0,
  );
  retrievalMeta.timings.authorityCandidateFilter = Number(
    authorityCandidateResult?.diagnostics?.timings?.filter || 0,
  );
  retrievalMeta.timings.authorityCandidateSearch = Number(
    authorityCandidateResult?.diagnostics?.timings?.search || 0,
  );
  retrievalMeta.timings.authorityCandidateNeighbors = Number(
    authorityCandidateResult?.diagnostics?.timings?.neighbors || 0,
  );
  if (authorityCandidateResult?.used && authorityCandidateResult?.candidateNodes?.length > 0) {
    rankingActiveNodes = authorityCandidateResult.candidateNodes;
    retrievalMeta.rankingNodeCount = rankingActiveNodes.length;
  } else if (retrievalMeta.authorityCandidateFallbackReason) {
    pushSkipReason(
      retrievalMeta,
      `authority-candidate:${retrievalMeta.authorityCandidateFallbackReason}`,
    );
  }
  if (!Number.isFinite(retrievalMeta.timings.authorityCandidates)) {
    retrievalMeta.timings.authorityCandidates = roundMs(
      nowMs() - authorityCandidateStartedAt,
    );
  }
  debugLog(
    `[ST-BME] 检索开始: ${nodeCount} 个活跃节点 -> ${rankingActiveNodes.length} 个候选${enableVisibility ? " (认知边界已启用)" : ""}`,
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
      scopeContext: {
        enableScopedMemory,
        enablePovMemory,
        enableRegionScopedObjective,
        enableCognitiveMemory,
        enableStoryTimeline,
        injectUserPovMemory,
        injectObjectiveGlobalMemory,
        activeRegion,
        activeRegionSource: activeRegionContext.source || "",
        activeStorySegmentId: activeStoryContext.activeSegmentId || "",
        activeStoryTimeLabel: activeStoryContext.activeStoryTimeLabel || "",
        activeStoryTimeSource: activeStoryContext.source || "",
        injectStoryTimeLabel,
        activeCharacterPovOwner,
        activeUserPovOwner,
        activeCharacterPovOwners: preliminarySceneOwnerCandidates.map(
          (candidate) => candidate.ownerName,
        ),
        activeRecallOwnerKey: activeRecallOwnerKeys[0] || "",
        activeRecallOwnerKeys: [...activeRecallOwnerKeys],
        activeRecallOwnerScores: { ...activeRecallOwnerScores },
        sceneOwnerResolutionMode,
        sceneOwnerCandidates: retrievalMeta.sceneOwnerCandidates,
        adjacentRegions: adjacentRegionContext.adjacentRegions,
        injectLowConfidenceObjectiveMemory,
        graph,
        bucketWeights,
      },
    });
  }
  const sharedRanking = await rankNodesForTaskContext({
    graph,
    userMessage,
    recentMessages,
    embeddingConfig,
    signal,
    options: {
      topK: normalizedTopK,
      diffusionTopK: normalizedDiffusionTopK,
      enableVectorPrefilter,
      enableGraphDiffusion,
      enableContextQueryBlend,
      enableMultiIntent,
      multiIntentMaxSegments,
      contextAssistantWeight,
      contextPreviousUserWeight,
      teleportAlpha,
      enableTemporalLinks,
      temporalLinkStrength,
      enableLexicalBoost,
      lexicalWeight,
      weights,
      vectorQueryConcurrency: options.vectorQueryConcurrency,
      activeNodes: rankingActiveNodes,
    },
  });
  const contextQueryBlend = sharedRanking.contextQueryBlend;
  const lexicalQuery = sharedRanking.lexicalQuery;
  retrievalMeta.queryBlendActive = Boolean(
    sharedRanking?.diagnostics?.queryBlendActive,
  );
  retrievalMeta.queryBlendParts = Array.isArray(
    sharedRanking?.diagnostics?.queryBlendParts,
  )
    ? [...sharedRanking.diagnostics.queryBlendParts]
    : [];
  retrievalMeta.queryBlendWeights = {
    ...(sharedRanking?.diagnostics?.queryBlendWeights || {}),
  };
  retrievalMeta.segmentsUsed = Array.isArray(sharedRanking?.diagnostics?.segmentsUsed)
    ? [...sharedRanking.diagnostics.segmentsUsed]
    : [];
  retrievalMeta.vectorHits = Number(sharedRanking?.diagnostics?.vectorHits || 0);
  retrievalMeta.vectorMergedHits = Number(
    sharedRanking?.diagnostics?.vectorMergedHits || 0,
  );
  retrievalMeta.seedCount = Number(sharedRanking?.diagnostics?.seedCount || 0);
  retrievalMeta.diffusionHits = Number(
    sharedRanking?.diagnostics?.diffusionHits || 0,
  );
  retrievalMeta.lexicalBoostedNodes = Number(
    sharedRanking?.diagnostics?.lexicalBoostedNodes || 0,
  );
  retrievalMeta.temporalSyntheticEdgeCount = Number(
    sharedRanking?.diagnostics?.temporalSyntheticEdgeCount || 0,
  );
  retrievalMeta.teleportAlpha = Number(
    sharedRanking?.diagnostics?.teleportAlpha || teleportAlpha,
  );
  retrievalMeta.lexicalTopHits = Array.isArray(
    sharedRanking?.diagnostics?.lexicalTopHits,
  )
    ? [...sharedRanking.diagnostics.lexicalTopHits]
    : [];
  retrievalMeta.timings.sharedQueryBlend = Number(
    sharedRanking?.diagnostics?.timings?.queryBlend || 0,
  );
  retrievalMeta.timings.sharedLexical = Number(
    sharedRanking?.diagnostics?.timings?.lexical || 0,
  );
  retrievalMeta.timings.sharedScoring = Number(
    sharedRanking?.diagnostics?.timings?.scoring || 0,
  );
  retrievalMeta.timings.sharedTotal = Number(
    sharedRanking?.diagnostics?.timings?.total || 0,
  );
  retrievalMeta.timings.sharedVector = Number(
    sharedRanking?.diagnostics?.timings?.vector || 0,
  );
  retrievalMeta.timings.sharedDiffusion = Number(
    sharedRanking?.diagnostics?.timings?.diffusion || 0,
  );
  retrievalMeta.timings.vector = Number(
    sharedRanking?.diagnostics?.timings?.vector || 0,
  );
  retrievalMeta.timings.diffusion = Number(
    sharedRanking?.diagnostics?.timings?.diffusion || 0,
  );
  for (const reason of sharedRanking?.diagnostics?.skipReasons || []) {
    pushSkipReason(retrievalMeta, reason);
  }
  vectorResults = Array.isArray(sharedRanking?.vectorResults)
    ? [...sharedRanking.vectorResults]
    : [];
  diffusionResults = Array.isArray(sharedRanking?.diffusionResults)
    ? [...sharedRanking.diffusionResults]
    : [];
  exactEntityAnchors.push(...(sharedRanking?.exactEntityAnchors || []));
  const anchorCollectStartedAt = nowMs();
  supplementalAnchorNodeIds = collectSupplementalAnchorNodeIds(
    graph,
    vectorResults,
    exactEntityAnchors.map((item) => item.nodeId),
    5,
  );
  retrievalMeta.timings.anchorCollect = roundMs(nowMs() - anchorCollectStartedAt);

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
  if (enableGraphDiffusion && (enableCrossRecall || residualResult.triggered)) {
    debugLog("[ST-BME] 第2层: PEDSA 图扩散");
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
    retrievalMeta.diffusionHits = diffusionResults.length;
  }
  if (enableGraphDiffusion && (enableCrossRecall || residualResult.triggered)) {
    retrievalMeta.timings.diffusion = roundMs(nowMs() - diffusionStartedAt);
  }

  debugLog("[ST-BME] 第3层: 混合评分");

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
    const scopeBucket = enableScopedMemory
      ? classifyNodeScopeBucket(node, {
          activeCharacterPovOwner,
          activeCharacterPovOwners: activeRecallOwnerKeys.map((ownerKey) =>
            preliminarySceneOwnerCandidates.find(
              (candidate) => candidate.ownerKey === ownerKey,
            )?.ownerName || "",
          ),
          activeUserPovOwner,
          activeRegion,
          adjacentRegions: adjacentRegionContext.adjacentRegions,
          enablePovMemory,
          enableRegionScopedObjective,
          allowImplicitCharacterPovFallback: false,
        })
      : MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL;
    const temporalDirector = enableStoryTimeline
      ? classifyStoryTemporalBucket(graph, node, {
          activeSegmentId: activeStoryContext.activeSegmentId,
          cueMode: storyCueMode,
        })
      : {
          bucket: STORY_TEMPORAL_BUCKETS.UNDATED,
          weight: 1,
          suppressed: false,
          rescued: false,
          reason: "disabled",
        };
    const knowledgeGate = enableCognitiveMemory
      ? computeKnowledgeGateForNode(
          graph,
          node,
          activeRecallOwnerKeys,
          {
            vectorScore: scores.vectorScore,
            graphScore: scores.graphScore,
            lexicalScore,
            scopeBucket,
            injectLowConfidenceObjectiveMemory,
          },
        )
      : {
          visible: true,
          anchored: false,
          rescued: false,
          suppressed: false,
          suppressedReason: "",
          visibilityScore: 0,
          mode: "disabled",
        };
    if (scopeBucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION) {
      retrievalMeta.adjacentRegionMatches.push(nodeId);
    }
    retrievalMeta.knowledgeVisibleOwnersByNode[nodeId] = [
      ...(knowledgeGate.visibleOwnerKeys || []),
    ];
    retrievalMeta.knowledgeSuppressedOwnersByNode[nodeId] = [
      ...(knowledgeGate.suppressedOwnerKeys || []),
    ];
    if (!knowledgeGate.visible) {
      retrievalMeta.knowledgeSuppressedNodes.push(nodeId);
      if (knowledgeGate.suppressedReason) {
        retrievalMeta.visibilitySuppressedReasons[nodeId] =
          knowledgeGate.suppressedReason;
      }
      continue;
    }
    if (knowledgeGate.anchored) {
      retrievalMeta.knowledgeAnchoredNodes.push(nodeId);
    }
    if (knowledgeGate.rescued) {
      retrievalMeta.knowledgeRescuedNodes.push(nodeId);
    }
    pushScopeBucketDebug(
      retrievalMeta.temporalBuckets,
      temporalDirector.bucket,
      nodeId,
    );
    if (storyTimeSoftDirecting && temporalDirector.suppressed) {
      retrievalMeta.temporalSuppressedNodes.push(nodeId);
      continue;
    }
    if (temporalDirector.rescued) {
      retrievalMeta.temporalRescuedNodes.push(nodeId);
    }
    const scopeWeight = enableScopedMemory
      ? resolveScopeBucketWeight(scopeBucket, bucketWeights)
      : 1;
    const knowledgeWeight = enableCognitiveMemory
      ? knowledgeGate.anchored
        ? 1.18
        : knowledgeGate.rescued
          ? 0.92
          : Math.max(0.35, 0.55 + Number(knowledgeGate.visibilityScore || 0) * 0.6)
      : 1;
    const ownerCoverageWeight = enableCognitiveMemory
      ? 1 + Math.max(0, Number(knowledgeGate.ownerCoverage || 0) - 1 / Math.max(1, activeRecallOwnerKeys.length || 1)) * 0.08
      : 1;
    const temporalWeight =
      enableStoryTimeline && storyTimeSoftDirecting
        ? Number(temporalDirector.weight || 1)
        : 1;
    const weightedScore =
      finalScore *
      scopeWeight *
      knowledgeWeight *
      ownerCoverageWeight *
      temporalWeight;

    scoredNodes.push({
      nodeId,
      node,
      finalScore,
      weightedScore,
      lexicalScore,
      scopeBucket,
      scopeWeight,
      knowledgeMode: knowledgeGate.mode,
      knowledgeVisibilityScore: Number(knowledgeGate.visibilityScore || 0),
      knowledgeWeight,
      knowledgeAnchored: Boolean(knowledgeGate.anchored),
      knowledgeRescued: Boolean(knowledgeGate.rescued),
      knowledgeOwnerCoverage: Number(knowledgeGate.ownerCoverage || 0),
      knowledgeVisibleOwnerKeys: [...(knowledgeGate.visibleOwnerKeys || [])],
      knowledgeSuppressedOwnerKeys: [...(knowledgeGate.suppressedOwnerKeys || [])],
      ownerCoverageWeight,
      storyTimeLabel: describeNodeStoryTime(node),
      temporalBucket: temporalDirector.bucket,
      temporalWeight,
      temporalSuppressed: Boolean(temporalDirector.suppressed),
      temporalRescued: Boolean(temporalDirector.rescued),
      temporalReason: String(temporalDirector.reason || ""),
      ...scores,
    });
    pushScopeBucketDebug(
      retrievalMeta.scopeBuckets,
      scopeBucket,
      nodeId,
    );
  }

  scoredNodes.sort((a, b) => {
    const bucketDelta =
      getScopeBucketPriority(b.scopeBucket) - getScopeBucketPriority(a.scopeBucket);
    if (bucketDelta !== 0) return bucketDelta;
    const temporalDelta =
      getTemporalBucketPriority(b.temporalBucket) -
      getTemporalBucketPriority(a.temporalBucket);
    if (temporalDelta !== 0) return temporalDelta;
    const weightedDelta =
      (Number(b.weightedScore) || 0) - (Number(a.weightedScore) || 0);
    if (weightedDelta !== 0) return weightedDelta;
    return (Number(b.finalScore) || 0) - (Number(a.finalScore) || 0);
  });
  retrievalMeta.scoredCandidates = scoredNodes.length;
  retrievalMeta.lexicalBoostedNodes = scoredNodes.filter(
    (item) => (Number(item.lexicalScore) || 0) > 0,
  ).length;
  retrievalMeta.lexicalTopHits = buildLexicalTopHits(scoredNodes);
  retrievalMeta.visibilityTopHits = buildVisibilityTopHits(scoredNodes);
  retrievalMeta.temporalTopHits = scoredNodes.slice(0, 8).map((item) => ({
    nodeId: item.nodeId,
    bucket: item.temporalBucket,
    weight: Math.round((Number(item.temporalWeight) || 0) * 1000) / 1000,
    label: item.storyTimeLabel || "",
    reason: item.temporalReason || "",
  }));
  const sceneOwnerCandidates = mergeSceneOwnerCandidateLists(
    preliminarySceneOwnerCandidates,
    collectOwnerCandidatesFromNodes(
      graph,
      ownerCatalog,
      scoredNodes.slice(0, Math.max(normalizedLlmCandidatePool, 12)),
    ),
  );
  retrievalMeta.sceneOwnerCandidates = sceneOwnerCandidates.map((candidate) => ({
    ownerKey: candidate.ownerKey,
    ownerName: candidate.ownerName,
    score: roundOwnerScore(candidate.score),
    sources: [...(candidate.sources || [])],
    reasons: [...(candidate.reasons || [])],
  }));
  retrievalMeta.timings.scoring = roundMs(nowMs() - scoringStartedAt);

  let selectedNodeIds;
  let llmCandidates = [];
  const diversityStartedAt = nowMs();
  let llmDurationMs = 0;

  if (enableLLMRecall && nodeCount > 0) {
    debugLog("[ST-BME] LLM 精确召回");
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
      sceneOwnerCandidates,
      activeStoryContext.activeStoryTimeLabel || "",
      settings,
      signal,
      onStreamProgress,
    );
    llmDurationMs = nowMs() - llmStartedAt;
    selectedNodeIds = llmResult.selectedNodeIds;
    const llmOwnerResolution =
      llmResult.activeOwnerKeys?.length > 0
        ? {
            ownerKeys: normalizeOwnerKeyList(llmResult.activeOwnerKeys).slice(0, 4),
            ownerScores: Object.fromEntries(
              normalizeOwnerKeyList(llmResult.activeOwnerKeys)
                .slice(0, 4)
                .map((ownerKey) => [
                  ownerKey,
                  roundOwnerScore(
                    Math.min(
                      1,
                      Number(llmResult.activeOwnerScores?.[ownerKey]) ||
                        Number(
                          sceneOwnerCandidates.find(
                            (candidate) => candidate.ownerKey === ownerKey,
                          )?.score || 0,
                        ),
                    ),
                  ),
                ]),
            ),
            mode: llmResult.sceneOwnerResolutionMode || "llm",
          }
        : resolveSceneOwnersHeuristically(sceneOwnerCandidates, {
            mode: "fallback",
            maxOwners: 4,
            minScore: 0.55,
          });
    activeRecallOwnerKeys = [...llmOwnerResolution.ownerKeys];
    activeRecallOwnerScores = { ...(llmOwnerResolution.ownerScores || {}) };
    sceneOwnerResolutionMode = llmOwnerResolution.mode || "unresolved";
    llmMeta = {
      ...retrievalMeta.llm,
      enabled: true,
      status: llmResult.status,
      reason: llmResult.reason,
      selectionProtocol: llmResult.selectionProtocol || "",
      rawSelectedKeys: Array.isArray(llmResult.rawSelectedKeys)
        ? [...llmResult.rawSelectedKeys]
        : [],
      resolvedSelectedKeys: Array.isArray(llmResult.resolvedSelectedKeys)
        ? [...llmResult.resolvedSelectedKeys]
        : [],
      resolvedSelectedNodeIds: Array.isArray(llmResult.resolvedSelectedNodeIds)
        ? [...llmResult.resolvedSelectedNodeIds]
        : [],
      fallbackReason: llmResult.fallbackReason || "",
      fallbackType: llmResult.fallbackType || "",
      emptySelectionAccepted: llmResult.emptySelectionAccepted === true,
      candidateKeyMapPreview: { ...(llmResult.candidateKeyMapPreview || {}) },
      legacySelectionUsed: llmResult.legacySelectionUsed === true,
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
    const heuristicResolution = resolveSceneOwnersHeuristically(
      sceneOwnerCandidates,
      {
        mode: "heuristic",
        maxOwners: 4,
        minScore: 0.55,
      },
    );
    activeRecallOwnerKeys = [...heuristicResolution.ownerKeys];
    activeRecallOwnerScores = { ...(heuristicResolution.ownerScores || {}) };
    sceneOwnerResolutionMode = heuristicResolution.mode || "unresolved";
    llmMeta = {
      ...retrievalMeta.llm,
      enabled: false,
      status: "disabled",
      reason: "LLM 精排已关闭，直接采用评分排序",
      candidatePool: 0,
      selectedSeedCount: selectedNodeIds.length,
    };
  }
  retrievalMeta.timings.diversity = roundMs(nowMs() - diversityStartedAt);
  retrievalMeta.timings.llm = roundMs(llmDurationMs);
  retrievalMeta.activeRecallOwnerKey = activeRecallOwnerKeys[0] || "";
  retrievalMeta.activeRecallOwnerKeys = [...activeRecallOwnerKeys];
  retrievalMeta.activeRecallOwnerScores = { ...activeRecallOwnerScores };
  retrievalMeta.sceneOwnerResolutionMode = sceneOwnerResolutionMode;
  retrievalMeta.activeCharacterPovOwner =
    getSceneOwnerNamesByKeys(sceneOwnerCandidates, activeRecallOwnerKeys)[0] || "";

  selectedNodeIds = augmentSelectedNodeIdsWithActiveOwnerPov(
    graph,
    selectedNodeIds,
    scoredNodes,
    activeRecallOwnerKeys,
    normalizedMaxRecallNodes,
  );
  selectedNodeIds = reconstructSceneNodeIds(
    graph,
    selectedNodeIds,
    normalizedMaxRecallNodes,
  );

  // 访问强化
  const selectedNodes = selectedNodeIds
    .map((id) => getNode(graph, id))
    .filter(Boolean);
  retrievalMeta.selectedByBucket = selectedNodes.reduce((acc, node) => {
    const bucket = enableScopedMemory
      ? classifyNodeScopeBucket(node, {
          activeCharacterPovOwner,
          activeCharacterPovOwners: getSceneOwnerNamesByKeys(
            sceneOwnerCandidates,
            activeRecallOwnerKeys,
          ),
          activeUserPovOwner,
          activeRegion,
          adjacentRegions: adjacentRegionContext.adjacentRegions,
          enablePovMemory,
          enableRegionScopedObjective,
          allowImplicitCharacterPovFallback: false,
        })
      : MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL;
    pushScopeBucketDebug(acc, bucket, node.id);
    return acc;
  }, createEmptyScopeBucketMap());
  retrievalMeta.selectedByKnowledgeState = Object.fromEntries(
    selectedNodes.map((node) => {
      const scored = scoredNodes.find((item) => item.nodeId === node.id);
      return [
        node.id,
        {
          mode: String(scored?.knowledgeMode || "selected"),
          anchored: Boolean(scored?.knowledgeAnchored),
          rescued: Boolean(scored?.knowledgeRescued),
          ownerCoverage:
            Math.round((Number(scored?.knowledgeOwnerCoverage) || 0) * 1000) /
            1000,
          visibilityScore:
            Math.round((Number(scored?.knowledgeVisibilityScore) || 0) * 1000) /
            1000,
          visibleOwners: [...(scored?.knowledgeVisibleOwnerKeys || [])],
          suppressedOwners: [...(scored?.knowledgeSuppressedOwnerKeys || [])],
        },
      ];
    }),
  );
  retrievalMeta.selectedByStoryTime = Object.fromEntries(
    selectedNodes.map((node) => {
      const scored = scoredNodes.find((item) => item.nodeId === node.id);
      return [
        node.id,
        {
          bucket: String(scored?.temporalBucket || STORY_TEMPORAL_BUCKETS.UNDATED),
          weight:
            Math.round((Number(scored?.temporalWeight) || 0) * 1000) / 1000,
          label: String(scored?.storyTimeLabel || ""),
          rescued: Boolean(scored?.temporalRescued),
          reason: String(scored?.temporalReason || ""),
        },
      ];
    }),
  );
  retrievalMeta.selectedByOwner = buildSelectedByOwner(
    graph,
    selectedNodes,
    scoredNodes,
    sceneOwnerCandidates,
  );
  if (graph?.historyState) {
    graph.historyState.activeRecallOwnerKey = activeRecallOwnerKeys[0] || "";
    if (activeRecallOwnerKeys.length > 0) {
      for (const ownerKey of [...activeRecallOwnerKeys].reverse()) {
        pushRecentRecallOwner(graph.historyState, ownerKey);
      }
    }
  }

  reinforceAccessBatch(selectedNodes);

  debugLog(`[ST-BME] 检索完成: 选中 ${selectedNodeIds.length} 个节点`);

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
        debugLog(
          `[ST-BME] 概率触发: ${c.fields?.name || c.fields?.summary || c.id}`,
        );
      }
    }
  }

  selectedNodeIds = uniqueNodeIds(selectedNodeIds).slice(
    0,
    normalizedMaxRecallNodes,
  );
  retrievalMeta.knowledgeAnchoredNodes = uniqueNodeIds(
    retrievalMeta.knowledgeAnchoredNodes,
  );
  retrievalMeta.knowledgeSuppressedNodes = uniqueNodeIds(
    retrievalMeta.knowledgeSuppressedNodes,
  );
  retrievalMeta.knowledgeRescuedNodes = uniqueNodeIds(
    retrievalMeta.knowledgeRescuedNodes,
  );
  retrievalMeta.adjacentRegionMatches = uniqueNodeIds(
    retrievalMeta.adjacentRegionMatches,
  );
  retrievalMeta.temporalSuppressedNodes = uniqueNodeIds(
    retrievalMeta.temporalSuppressedNodes,
  );
  retrievalMeta.temporalRescuedNodes = uniqueNodeIds(
    retrievalMeta.temporalRescuedNodes,
  );
  retrievalMeta.llm = llmMeta;
  retrievalMeta.timings.total = roundMs(nowMs() - startedAt);

  return buildResult(graph, selectedNodeIds, schema, {
    retrieval: {
      ...retrievalMeta,
    },
    scopeContext: {
      enableScopedMemory,
      enablePovMemory,
      enableRegionScopedObjective,
      enableCognitiveMemory,
      enableStoryTimeline,
      injectUserPovMemory,
      injectObjectiveGlobalMemory,
      activeRegion,
      activeRegionSource: activeRegionContext.source || "",
      activeStorySegmentId: activeStoryContext.activeSegmentId || "",
      activeStoryTimeLabel: activeStoryContext.activeStoryTimeLabel || "",
      activeStoryTimeSource: activeStoryContext.source || "",
      injectStoryTimeLabel,
      activeCharacterPovOwner:
        getSceneOwnerNamesByKeys(sceneOwnerCandidates, activeRecallOwnerKeys)[0] ||
        activeCharacterPovOwner,
      activeUserPovOwner,
      activeCharacterPovOwners: getSceneOwnerNamesByKeys(
        sceneOwnerCandidates,
        activeRecallOwnerKeys,
      ),
      activeRecallOwnerKey: activeRecallOwnerKeys[0] || "",
      activeRecallOwnerKeys: [...activeRecallOwnerKeys],
      activeRecallOwnerScores: { ...activeRecallOwnerScores },
      sceneOwnerResolutionMode,
      sceneOwnerCandidates: retrievalMeta.sceneOwnerCandidates,
      adjacentRegions: adjacentRegionContext.adjacentRegions,
      injectLowConfidenceObjectiveMemory,
      graph,
      bucketWeights,
    },
  });
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
  sceneOwnerCandidates = [],
  activeStoryTimeLabel = "",
  settings = {},
  signal,
  onStreamProgress = null,
) {
  throwIfAborted(signal);
  const contextStr = recentMessages.join("\n---\n");
  const sectionedContextStr =
    buildRecallSectionedTranscript(recentMessages) || contextStr;
  const sceneOwnerCandidateText = buildSceneOwnerCandidateText(sceneOwnerCandidates);
  const {
    candidateKeyToNodeId,
    candidateKeyToCandidateMeta,
    nodeIdToCandidateKey,
  } = createRecallCandidateKeyMaps(candidates);
  const candidateDescriptions = candidates
    .map((c, index) => {
      const node = c.node;
      const typeDef = schema.find((s) => s.id === node.type);
      const typeLabel = typeDef?.label || node.type;
      const storyTimeLabel = describeNodeStoryTime(node);
      const fieldsStr = Object.entries(node.fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const candidateKey =
        nodeIdToCandidateKey[String(c?.nodeId || node?.id || "").trim()] ||
        `R${index + 1}`;
      return `[${candidateKey}] 类型=${typeLabel}, 作用域=${describeMemoryScope(node.scope)}, 时间=${storyTimeLabel || "未标注"}, 时间桶=${String(c.temporalBucket || STORY_TEMPORAL_BUCKETS.UNDATED)}, 召回桶=${describeScopeBucket(c.scopeBucket)}, 认知=${String(c.knowledgeMode || "unknown")}, 可见性=${(Number(c.knowledgeVisibilityScore) || 0).toFixed(3)}, ${fieldsStr} (评分=${(c.weightedScore ?? c.finalScore).toFixed(3)})`;
    })
    .join("\n");

  const recallPromptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    recentMessages: sectionedContextStr || "(无)",
    userMessage,
    candidateNodes: candidateDescriptions,
    candidateText: candidateDescriptions,
    sceneOwnerCandidates: sceneOwnerCandidateText,
    activeStoryTimeLabel,
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
      "你还需要判断这轮真正参与当前回应的具体人物，并返回他们的 ownerKey。",
      "优先维持剧情时间一致，不要把未来信息当成当前已经发生的客观事实带入。",
      "优先选择：(1) 直接相关的当前场景节点, (2) 因果关系连续性节点, (3) 有潜在影响的背景节点。",
      `最多选择 ${maxNodes} 个节点。`,
      "候选节点使用短键标识（R1 / R2 / R3 ...），只能从给出的短键里选择。",
      "如果你一个都不选，系统会自动回退到评分召回。",
      "输出严格的 JSON 格式：",
      '{"selected_keys": ["R1", "R2"], "reason": "R1: 简要说明选择理由；R2: 简要说明选择理由", "active_owner_keys": ["character:alice"], "active_owner_scores": [{"ownerKey": "character:alice", "score": 0.92, "reason": "她在场并且 POV 最相关"}]}',
    ].join("\n"),
    recallRegexInput,
    "system",
  );

  const userPrompt = [
    "## 当前剧情时间",
    activeStoryTimeLabel || "(未确定)",
    "",
    "## 最近对话上下文",
    sectionedContextStr || contextStr || "(无)",
    "",
    "## 用户最新输入",
    userMessage,
    "",
    "## 候选记忆节点",
    candidateDescriptions,
    "",
    "## 场景角色候选",
    sceneOwnerCandidateText,
    "",
    "请选择最相关的节点，并同时返回这轮真正参与当前回应的具体人物 ownerKey。",
  ].join("\n");
  const promptPayload = resolveTaskPromptPayload(recallPromptBuild, userPrompt);
  const additionalMessages = Array.isArray(promptPayload.additionalMessages)
    ? [...promptPayload.additionalMessages]
    : [];
  additionalMessages.push({
    role: "system",
    content: buildRecallSceneOwnerAugmentPrompt(
      maxNodes,
      sceneOwnerCandidateText,
    ),
  });

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
    additionalMessages,
    onStreamProgress,
    maxCompletionTokens: Math.max(512, maxNodes * 160),
    returnFailureDetails: true,
  });
  const result = llmResult?.ok ? llmResult.data : null;
  const activeOwnerKeys = normalizeOwnerKeyList(
    (Array.isArray(result?.active_owner_keys) ? result.active_owner_keys : []).map(
      (value) => resolveSceneOwnerKeyFromValue(sceneOwnerCandidates, value),
    ),
  ).slice(0, 4);
  const activeOwnerScoreEntries = normalizeLlmSceneOwnerScores(
    sceneOwnerCandidates,
    result?.active_owner_scores,
  );
  const activeOwnerScores = Object.fromEntries(
    activeOwnerScoreEntries.map((entry) => [
      entry.ownerKey,
      roundOwnerScore(entry.score),
    ]),
  );

  const hasSelectedKeysField =
    result && Object.prototype.hasOwnProperty.call(result, "selected_keys");
  const hasSelectedIdsField =
    result && Object.prototype.hasOwnProperty.call(result, "selected_ids");
  const rawSelectedKeys = Array.isArray(result?.selected_keys)
    ? normalizeRecallSelectionList(result.selected_keys, maxNodes * 4)
    : [];
  const rawSelectedIds = Array.isArray(result?.selected_ids)
    ? normalizeRecallSelectionList(result.selected_ids, maxNodes * 4)
    : [];
  const selectionProtocol = hasSelectedKeysField
    ? "candidate-keys-v1"
    : hasSelectedIdsField
      ? "legacy-selected-ids"
      : "candidate-keys-v1";
  const legacySelectionUsed =
    !hasSelectedKeysField && hasSelectedIdsField && Array.isArray(result?.selected_ids);

  let resolvedSelectedKeys = [];
  let resolvedSelectedNodeIds = [];
  let fallbackReason = "";
  let fallbackType = "";

  if (hasSelectedKeysField) {
    if (!Array.isArray(result?.selected_keys)) {
      fallbackType = "invalid-candidate";
      fallbackReason = "LLM 返回的 selected_keys 结构无效，已回退到评分排序";
    } else if (rawSelectedKeys.length === 0) {
      fallbackType = "empty-selection";
      fallbackReason = "LLM 返回了空的 selected_keys，已回退到评分排序";
    } else {
      resolvedSelectedKeys = rawSelectedKeys
        .filter((key) => candidateKeyToNodeId[key])
        .slice(0, maxNodes);
      resolvedSelectedNodeIds = uniqueNodeIds(
        resolvedSelectedKeys
          .map((key) => candidateKeyToNodeId[key])
          .filter(Boolean),
      ).slice(0, maxNodes);
    }
  } else if (hasSelectedIdsField) {
    if (!Array.isArray(result?.selected_ids)) {
      fallbackType = "invalid-candidate";
      fallbackReason = "LLM 返回的 selected_ids 结构无效，已回退到评分排序";
    } else if (rawSelectedIds.length === 0) {
      fallbackType = "empty-selection";
      fallbackReason = "LLM 返回了空的 selected_ids，已回退到评分排序";
    } else {
      resolvedSelectedNodeIds = uniqueNodeIds(
        rawSelectedIds.filter((id) => candidates.some((c) => c.nodeId === id)),
      ).slice(0, maxNodes);
      resolvedSelectedKeys = resolvedSelectedNodeIds
        .map((nodeId) => nodeIdToCandidateKey[nodeId])
        .filter(Boolean)
        .slice(0, maxNodes);
    }
  } else if (llmResult?.ok) {
    fallbackType = "invalid-candidate";
    fallbackReason = "LLM 返回了无法识别的 JSON 结构，已回退到评分排序";
  }

  if (resolvedSelectedNodeIds.length > 0) {
    return {
      selectedNodeIds: resolvedSelectedNodeIds,
      status: "llm",
      activeOwnerKeys,
      activeOwnerScores,
      sceneOwnerResolutionMode: activeOwnerKeys.length > 0 ? "llm" : "fallback",
      reason:
        selectionProtocol === "legacy-selected-ids"
          ? resolvedSelectedNodeIds.length < rawSelectedIds.length
            ? "LLM 返回了部分无效或超限 selected_ids，已保留可解析结果"
            : "LLM 主导演选择完成（legacy selected_ids）"
          : resolvedSelectedNodeIds.length < rawSelectedKeys.length
            ? "LLM 返回了部分无效或超限 selected_keys，已保留可解析结果"
            : "LLM 主导演选择完成",
      selectionProtocol,
      rawSelectedKeys,
      resolvedSelectedKeys,
      resolvedSelectedNodeIds,
      legacySelectionUsed,
      emptySelectionAccepted: false,
      candidateKeyMapPreview: candidateKeyToCandidateMeta,
      fallbackReason: "",
    };
  }

  // LLM 失败时回退到纯评分排序
  fallbackReason ||= llmResult?.ok
    ? hasSelectedKeysField || hasSelectedIdsField
      ? "LLM 返回的候选短键或候选 ID 无法映射到当前候选，已回退到评分排序"
      : "LLM 返回了无法识别的 JSON 结构，已回退到评分排序"
    : buildRecallFallbackReason(llmResult);
  fallbackType ||= llmResult?.ok
    ? "invalid-candidate"
    : llmResult?.errorType || "unknown";
  return {
    selectedNodeIds: candidates.slice(0, maxNodes).map((c) => c.nodeId),
    status: "fallback",
    activeOwnerKeys: [],
    activeOwnerScores: {},
    sceneOwnerResolutionMode: "fallback",
    reason: fallbackReason,
    fallbackType,
    selectionProtocol,
    rawSelectedKeys,
    resolvedSelectedKeys,
    resolvedSelectedNodeIds,
    legacySelectionUsed,
    emptySelectionAccepted: false,
    candidateKeyMapPreview: candidateKeyToCandidateMeta,
    fallbackReason,
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
  const scopeContext = meta.scopeContext || {};
  const compareForResult = compareNodeRecallOrderWithContext(graph, scopeContext);
  const summaryEntries =
    typeof getActiveSummaryEntries === "function"
      ? getActiveSummaryEntries(graph)
      : [];

  // 常驻注入节点（alwaysInject=true 的类型）
  const alwaysInjectTypes = new Set(
    schema.filter((s) => s.alwaysInject).map((s) => s.id),
  );
  if (summaryEntries.length > 0) {
    alwaysInjectTypes.delete("synopsis");
  }

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

  coreNodes.sort(compareForResult);
  recallNodes.sort(compareForResult);
  const groupedRecallNodes = groupRecallNodes(recallNodes);
  const selectedNodes = [...selectedSet]
    .map((nodeId) => getNode(graph, nodeId))
    .filter((node) => node && !node.archived)
    .sort(compareForResult);
  const scopeBuckets = buildScopedInjectionBuckets(
    coreNodes,
    selectedNodes,
    scopeContext,
  );

  return {
    summaryEntries,
    coreNodes,
    recallNodes,
    groupedRecallNodes,
    scopeBuckets,
    selectedNodeIds: [...selectedSet],
    meta,
    stats: {
      totalActive: activeNodes.length,
      summaryCount: summaryEntries.length,
      coreCount: coreNodes.length,
      recallCount: recallNodes.length,
      characterPovCount: scopeBuckets.characterPov.length,
      userPovCount: scopeBuckets.userPov.length,
      objectiveCurrentRegionCount: scopeBuckets.objectiveCurrentRegion.length,
      objectiveGlobalCount: scopeBuckets.objectiveGlobal.length,
      episodicCount: groupedRecallNodes.episodic.length,
      stateCount: groupedRecallNodes.state.length,
      reflectiveCount: groupedRecallNodes.reflective.length,
      ruleCount: groupedRecallNodes.rule.length,
    },
  };
}

function buildScopedInjectionBuckets(coreNodes, selectedNodes, scopeContext = {}) {
  const buckets = {
    characterPov: [],
    characterPovByOwner: {},
    characterPovOwnerOrder: [],
    userPov: [],
    objectiveCurrentRegion: [],
    objectiveGlobal: [],
  };
  const activeRecallOwnerKeys = normalizeOwnerKeyList(
    scopeContext.activeRecallOwnerKeys || scopeContext.activeRecallOwnerKey || [],
  );
  const combinedNodes = [
    ...selectedNodes,
    ...coreNodes,
  ];
  const compareForBucket = compareNodeRecallOrderWithContext(
    scopeContext.graph,
    scopeContext,
  );
  const seen = new Set();
  const globalCandidates = [];

  for (const node of combinedNodes) {
    if (!node?.id || seen.has(node.id)) continue;
    seen.add(node.id);
    const bucket = classifyNodeScopeBucket(node, {
      activeCharacterPovOwner: scopeContext.activeCharacterPovOwner,
      activeCharacterPovOwners: scopeContext.activeCharacterPovOwners || [],
      activeUserPovOwner: scopeContext.activeUserPovOwner,
      activeRegion: scopeContext.activeRegion,
      adjacentRegions: scopeContext.adjacentRegions,
      enablePovMemory: scopeContext.enablePovMemory !== false,
      enableRegionScopedObjective:
        scopeContext.enableRegionScopedObjective !== false,
      allowImplicitCharacterPovFallback: false,
    });
    const knowledgeGate =
      scopeContext.enableCognitiveMemory !== false
        ? computeKnowledgeGateForNode(
            scopeContext.graph,
            node,
            activeRecallOwnerKeys,
            {
              scopeBucket: bucket,
              injectLowConfidenceObjectiveMemory:
                scopeContext.injectLowConfidenceObjectiveMemory === true,
            },
          )
        : { visible: true };
    if (!knowledgeGate.visible && String(node?.scope?.layer || "objective") === "objective") {
      continue;
    }

    if (bucket === MEMORY_SCOPE_BUCKETS.CHARACTER_POV) {
      if (scopeContext.sceneOwnerResolutionMode === "unresolved") {
        continue;
      }
      const ownerKey =
        resolveKnowledgeOwnerKeyFromScope(scopeContext.graph, node?.scope) ||
        "";
      if (activeRecallOwnerKeys.length > 0 && !activeRecallOwnerKeys.includes(ownerKey)) {
        continue;
      }
      buckets.characterPov.push(node);
      if (ownerKey) {
        buckets.characterPovByOwner[ownerKey] ||= [];
        buckets.characterPovByOwner[ownerKey].push(node);
        if (!buckets.characterPovOwnerOrder.includes(ownerKey)) {
          buckets.characterPovOwnerOrder.push(ownerKey);
        }
      }
      continue;
    }
    if (bucket === MEMORY_SCOPE_BUCKETS.USER_POV) {
      if (scopeContext.injectUserPovMemory !== false) {
        buckets.userPov.push(node);
      }
      continue;
    }
    if (bucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_CURRENT_REGION) {
      buckets.objectiveCurrentRegion.push(node);
      continue;
    }
    if (
      bucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_ADJACENT_REGION ||
      bucket === MEMORY_SCOPE_BUCKETS.OBJECTIVE_GLOBAL
    ) {
      globalCandidates.push(node);
    }
  }

  buckets.characterPov.sort(compareForBucket);
  for (const ownerKey of Object.keys(buckets.characterPovByOwner)) {
    buckets.characterPovByOwner[ownerKey].sort(compareForBucket);
  }
  buckets.characterPovOwnerOrder = [
    ...activeRecallOwnerKeys.filter((ownerKey) =>
      buckets.characterPovByOwner[ownerKey]?.length > 0,
    ),
    ...buckets.characterPovOwnerOrder.filter(
      (ownerKey) =>
        !activeRecallOwnerKeys.includes(ownerKey) &&
        buckets.characterPovByOwner[ownerKey]?.length > 0,
    ),
  ];
  buckets.userPov.sort(compareForBucket);
  buckets.objectiveCurrentRegion.sort(compareForBucket);
  const cappedGlobal = (scopeContext.injectObjectiveGlobalMemory === false
    ? []
    : globalCandidates.sort(compareForBucket).slice(0, 6));
  buckets.objectiveGlobal = cappedGlobal;

  return buckets;
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
    } else if (node.type === "pov_memory") {
      const relatedNodes = getNodeEdges(graph, node.id)
        .filter(isUsableSceneEdge)
        .map((e) => (e.fromId === node.id ? e.toId : e.fromId))
        .map((id) => getNode(graph, id))
        .filter(Boolean)
        .sort(compareNodeRecallOrder)
        .slice(0, 2);
      for (const relatedNode of relatedNodes) {
        push(relatedNode.id);
        if (relatedNode.type === "event") {
          expandEventScene(graph, relatedNode, push);
        }
      }
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
      neighbor.type === "reflection" ||
      neighbor.type === "pov_memory"
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

function compareNodeRecallOrderWithContext(graph, scopeContext = {}) {
  const activeStorySegmentId = String(scopeContext?.activeStorySegmentId || "").trim();
  const enableStoryTimeline = scopeContext?.enableStoryTimeline !== false;
  if (!enableStoryTimeline || !activeStorySegmentId) {
    return compareNodeRecallOrder;
  }
  return (a, b) => {
    const temporalDelta =
      getTemporalBucketPriority(
        classifyStoryTemporalBucket(graph, b, {
          activeSegmentId: activeStorySegmentId,
        }).bucket,
      ) -
      getTemporalBucketPriority(
        classifyStoryTemporalBucket(graph, a, {
          activeSegmentId: activeStorySegmentId,
        }).bucket,
      );
    if (temporalDelta !== 0) return temporalDelta;
    return compareNodeRecallOrder(a, b);
  };
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
