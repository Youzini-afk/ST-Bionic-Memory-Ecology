import {
  buildContextQueryBlend,
  buildVectorQueryPlan,
  clampPositiveInt,
} from "./shared-ranking.js";
import {
  isAuthorityVectorConfig,
  searchAuthorityTriviumNodes,
} from "../vector/authority-vector-primary-adapter.js";
import { embedText } from "../vector/embedding.js";
import { runLimited } from "../runtime/concurrency.js";

function nowMs() {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function isAbortError(error) {
  return error?.name === "AbortError" ||
    error?.category === "aborted" ||
    error?.code === "aborted";
}

function queryPlan(userMessage, recentMessages, options) {
  const blend = buildContextQueryBlend(userMessage, recentMessages, {
    enabled: options.enableContextQueryBlend !== false,
    assistantWeight: Number(options.contextAssistantWeight ?? 0.2),
    previousUserWeight: Number(options.contextPreviousUserWeight ?? 0.1),
    maxTextLength: 400,
  });
  const plan = buildVectorQueryPlan(blend, {
    enableMultiIntent: options.enableMultiIntent !== false,
    maxSegments: clampPositiveInt(options.multiIntentMaxSegments, 4),
  });
  const queries = [];
  const seen = new Set();
  for (const part of plan.plan || []) {
    for (const value of part.queries || []) {
      const text = String(value || "").trim();
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      queries.push({ text, weight: Math.max(0.05, Number(part.weight) || 0.05) });
      if (queries.length >= 6) return queries;
    }
  }
  return queries;
}

function emptyResult(startedAt, reason, available = false) {
  return {
    available,
    used: false,
    candidateNodes: [],
    diagnostics: {
      provider: "authority-v9",
      available,
      used: false,
      candidateCount: 0,
      filteredCount: 0,
      searchHits: 0,
      neighborCount: 0,
      queryTexts: [],
      fallbackReason: reason,
      timings: { total: roundMs(nowMs() - startedAt), embed: 0, search: 0 },
    },
  };
}

export async function resolveAuthorityRecallCandidates({
  graph,
  userMessage,
  recentMessages = [],
  embeddingConfig,
  availableNodes = [],
  signal,
  options = {},
} = {}) {
  const startedAt = nowMs();
  const nodes = availableNodes.filter((node) => node && !node.archived);
  if (options.enabled === false) return emptyResult(startedAt, "disabled");
  if (!graph || !nodes.length || !isAuthorityVectorConfig(embeddingConfig)) {
    return emptyResult(startedAt, "unavailable");
  }
  const queries = queryPlan(userMessage, recentMessages, options);
  if (!queries.length) return emptyResult(startedAt, "empty-query", true);

  const allowed = new Map(nodes.map((node) => [String(node.id || ""), node]));
  const limit = clampPositiveInt(
    options.limit,
    Math.min(nodes.length, Math.max(Number(options.topK || 0) * 4, 24)),
  );
  const minimum = clampPositiveInt(
    options.minimumUsedCandidateCount,
    Math.min(nodes.length, Math.max(Number(options.maxRecallNodes || 0), 6)),
  );
  const scores = new Map();
  let embedMs = 0;
  const searchStartedAt = nowMs();
  try {
    const results = await runLimited(
      queries,
      async (query) => {
        const embedStartedAt = nowMs();
        const vector = await embedText(query.text, embeddingConfig, {
          signal,
          isQuery: true,
        });
        embedMs += nowMs() - embedStartedAt;
        if (!vector?.length) return [];
        return (await searchAuthorityTriviumNodes(graph, query.text, embeddingConfig, {
          collectionId: graph?.vectorIndexState?.collectionId,
          chatId: graph?.historyState?.chatId,
          modelScope: graph?.vectorIndexState?.modelScope,
          topK: limit,
          expandDepth: Math.min(5, Math.max(0, Number(options.neighborLimit) || 0)),
          queryVector: Array.from(vector),
          signal,
        })).map((item) => ({ ...item, weight: query.weight }));
      },
      {
        concurrency: Math.max(1, Math.floor(Number(options.queryConcurrency) || 1)),
        signal,
        failFast: false,
      },
    );
    for (const result of results) {
      if (result?.error) {
        if (isAbortError(result.error)) throw result.error;
        continue;
      }
      for (const item of result || []) {
        const nodeId = String(item.nodeId || "");
        if (!allowed.has(nodeId)) continue;
        const score = Math.max(0, Number(item.score) || 0) * Number(item.weight || 1);
        if (score > Number(scores.get(nodeId) || 0)) scores.set(nodeId, score);
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    const result = emptyResult(startedAt, "query-failed", true);
    result.diagnostics.queryTexts = queries.map(({ text }) => text);
    result.diagnostics.timings.embed = roundMs(embedMs);
    result.diagnostics.timings.search = roundMs(nowMs() - searchStartedAt);
    return result;
  }

  const candidateNodes = [...scores]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([nodeId]) => allowed.get(nodeId));
  const used = candidateNodes.length >= minimum && candidateNodes.length < nodes.length;
  return {
    available: true,
    used,
    candidateNodes: used ? candidateNodes : [],
    diagnostics: {
      provider: "authority-v9",
      available: true,
      used,
      candidateCount: candidateNodes.length,
      filteredCount: 0,
      searchHits: scores.size,
      neighborCount: 0,
      queryTexts: queries.map(({ text }) => text),
      fallbackReason: used ? "" : candidateNodes.length ? "not-reduced" : "empty",
      timings: {
        total: roundMs(nowMs() - startedAt),
        embed: roundMs(embedMs),
        search: roundMs(nowMs() - searchStartedAt),
      },
    },
  };
}
