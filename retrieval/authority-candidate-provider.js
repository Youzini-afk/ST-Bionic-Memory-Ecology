import {
  buildContextQueryBlend,
  buildVectorQueryPlan,
  clampPositiveInt,
} from "./shared-ranking.js";
import {
  createAuthorityTriviumClient,
  filterAuthorityTriviumNodes,
  isAuthorityVectorConfig,
  queryAuthorityTriviumNeighbors,
  searchAuthorityTriviumNodes,
} from "../vector/authority-vector-primary-adapter.js";
import { embedText } from "../vector/embedding.js";
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

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueIds(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeRecordId(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

// Detects aborts from both raw AbortError (DOMException/AbortController)
// AND AuthorityHttpError-wrapped aborts from runtime/authority-http-client.js
// (which sets `category === "aborted"` and/or `code === "aborted"` with
// `name === "AuthorityHttpError"`). A real HTTP abort must ALWAYS rethrow,
// regardless of failOpen — otherwise an in-flight abort could be swallowed
// by failOpen fallback and surface as a stale/empty result.
function isAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error.category === "aborted") return true;
  if (error.code === "aborted") return true;
  if (error.signal?.aborted === true) return true;
  return false;
}

function buildAuthorityCandidateQueryPlan(userMessage, recentMessages = [], options = {}) {
  const queryBlend = buildContextQueryBlend(userMessage, recentMessages, {
    enabled: options.enableContextQueryBlend !== false,
    assistantWeight: Number(options.contextAssistantWeight ?? 0.2),
    previousUserWeight: Number(options.contextPreviousUserWeight ?? 0.1),
    maxTextLength: Number(options.maxTextLength || 400),
  });
  const vectorQueryPlan = buildVectorQueryPlan(queryBlend, {
    enableMultiIntent: options.enableMultiIntent !== false,
    maxSegments: clampPositiveInt(options.multiIntentMaxSegments, 4),
  });
  const maxQueryTexts = clampPositiveInt(options.maxQueryTexts, 6);
  const queries = [];
  const seen = new Set();
  for (const part of vectorQueryPlan.plan || []) {
    for (const queryText of part.queries || []) {
      const normalizedText = String(queryText || "").trim();
      const key = normalizedText.toLowerCase();
      if (!normalizedText || seen.has(key)) continue;
      seen.add(key);
      queries.push({
        text: normalizedText,
        weight: Math.max(0.05, Number(part.weight || 0) || 0.05),
      });
      if (queries.length >= maxQueryTexts) {
        return {
          queryBlend,
          vectorQueryPlan,
          queries,
        };
      }
    }
  }
  return {
    queryBlend,
    vectorQueryPlan,
    queries,
  };
}

function resolveSceneOwnerNames(sceneOwnerCandidates = [], ownerKeys = []) {
  const ownerKeySet = new Set(uniqueIds(ownerKeys));
  return uniqueIds(
    toArray(sceneOwnerCandidates)
      .filter((candidate) => ownerKeySet.has(normalizeRecordId(candidate?.ownerKey)))
      .map((candidate) => candidate?.ownerName)
      .filter(Boolean),
  );
}

function buildAuthorityCandidateFilters({
  ownerKeys = [],
  ownerNames = [],
  regionKeys = [],
  storySegmentIds = [],
} = {}) {
  return {
    archived: false,
    ownerKeys: uniqueIds(ownerKeys),
    ownerNames: uniqueIds(ownerNames),
    regionKeys: uniqueIds(regionKeys),
    storySegmentIds: uniqueIds(storySegmentIds),
  };
}

function mapCandidateNodes(candidateIds = [], availableNodes = []) {
  const nodeMap = new Map(
    toArray(availableNodes)
      .map((node) => [normalizeRecordId(node?.id), node])
      .filter(([nodeId]) => nodeId),
  );
  return uniqueIds(candidateIds)
    .map((nodeId) => nodeMap.get(nodeId))
    .filter(Boolean);
}

export async function resolveAuthorityRecallCandidates({
  graph,
  userMessage,
  recentMessages = [],
  embeddingConfig,
  availableNodes = [],
  activeRegion = "",
  activeStoryContext = {},
  activeRecallOwnerKeys = [],
  sceneOwnerCandidates = [],
  signal = undefined,
  options = {},
} = {}) {
  const startedAt = nowMs();
  const diagnostics = {
    provider: "authority-trivium",
    available: false,
    used: false,
    candidateCount: 0,
    filteredCount: 0,
    searchHits: 0,
    neighborCount: 0,
    queryTexts: [],
    fallbackReason: "",
    bmeFastPathUsed: false,
    timings: {
      total: 0,
      embed: 0,
      filter: 0,
      search: 0,
      neighbors: 0,
      bmeFastPath: 0,
    },
  };
  const candidateNodes = toArray(availableNodes).filter((node) => node && !node.archived);
  if (options.enabled === false) {
    diagnostics.fallbackReason = "authority-graph-query-disabled";
    diagnostics.timings.total = roundMs(nowMs() - startedAt);
    return {
      available: false,
      used: false,
      candidateNodes: [],
      diagnostics,
    };
  }
  if (!graph || candidateNodes.length === 0 || !isAuthorityVectorConfig(embeddingConfig)) {
    diagnostics.fallbackReason = "authority-vector-unavailable";
    diagnostics.timings.total = roundMs(nowMs() - startedAt);
    return {
      available: false,
      used: false,
      candidateNodes: [],
      diagnostics,
    };
  }

  diagnostics.available = true;
  const collectionId = normalizeRecordId(
    options.collectionId || graph?.vectorIndexState?.collectionId,
  );
  const chatId = normalizeRecordId(options.chatId || graph?.historyState?.chatId);
  if (!collectionId) {
    diagnostics.fallbackReason = "authority-collection-missing";
    diagnostics.timings.total = roundMs(nowMs() - startedAt);
    return {
      available: true,
      used: false,
      candidateNodes: [],
      diagnostics,
    };
  }

  const allowedIds = new Set(candidateNodes.map((node) => normalizeRecordId(node?.id)));
  const limit = clampPositiveInt(
    options.limit,
    Math.min(candidateNodes.length, Math.max(Number(options.topK || 0) * 4, 24)),
  );
  const neighborLimit = clampPositiveInt(
    options.neighborLimit,
    Math.min(limit, Math.max(4, Math.ceil(limit / 4))),
  );
  const minimumUsedCandidateCount = clampPositiveInt(
    options.minimumUsedCandidateCount,
    Math.min(candidateNodes.length, Math.max(Number(options.maxRecallNodes || 0), 6)),
  );
  const ownerKeys = uniqueIds(activeRecallOwnerKeys);
  const ownerNames = resolveSceneOwnerNames(sceneOwnerCandidates, ownerKeys);
  const regionKeys = uniqueIds([activeRegion]);
  const storySegmentIds = uniqueIds([activeStoryContext?.activeSegmentId]);
  const filterPayload = buildAuthorityCandidateFilters({
    ownerKeys,
    ownerNames,
    regionKeys,
    storySegmentIds,
  });
  const queryPlan = buildAuthorityCandidateQueryPlan(userMessage, recentMessages, options);
  diagnostics.queryTexts = queryPlan.queries.map((entry) => entry.text);

  // === Phase 3 fast path: BME companion module recall.candidates ===
  // When the DOA + BME companion module are available and the
  // `recall.candidates` transaction is loaded, BME recall can use ONE
  // server-side candidate search instead of the existing 3-round-trip
  // path (filterAuthorityTriviumNodes -> searchAuthorityTriviumNodes ->
  // queryAuthorityTriviumNeighbors). Local fallback must remain; failOpen
  // semantics must match existing patterns.
  let bmeFastPathActive = false;
  let bmeFastPathCandidates = [];
  const bmeFastPathStartedAt = nowMs();
  if (embeddingConfig.bmeCandidateSearchReady === true && queryPlan.queries.length > 0) {
    const queryTexts = queryPlan.queries.map((entry) => entry.text);
    const queryVectors = [];
    let embedMs2 = 0;
    let embedOk = true;
    for (const queryEntry of queryPlan.queries) {
      const embedStartedAt = nowMs();
      let queryVec = null;
      try {
        queryVec = await embedText(queryEntry.text, embeddingConfig, {
          signal,
          isQuery: true,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
      embedMs2 += nowMs() - embedStartedAt;
      if (!queryVec || queryVec.length === 0) {
        embedOk = false;
        queryVectors.push(null);
      } else {
        queryVectors.push(Array.from(queryVec));
      }
    }
    diagnostics.timings.embed = roundMs(embedMs2);
    if (!embedOk) {
      diagnostics.fallbackReason ||= "authority-candidate-query-embed-empty";
    }

    if (embedOk) {
      const bmePayload = {
        database: embeddingConfig.database,
        namespace: collectionId,
        collectionId,
        chatId,
        graphRevision: Math.max(0, Math.floor(Number(options.graphRevision ?? options.revision) || 0)),
        modelScope: String(options.modelScope || ""),
        vectorSpaceId: String(embeddingConfig.vectorSpaceId || options.vectorSpaceId || ""),
        observedDim: Math.max(0, Math.floor(Number(embeddingConfig.dim) || Number(options.observedDim) || 0)),
        queryTexts,
        queryVectors,
        topK: limit,
        expandDepth: neighborLimit,
        payloadFilter: filterPayload,
        filters: filterPayload,
      };

      try {
        const client = createAuthorityTriviumClient(embeddingConfig, { signal });
        if (typeof client?.bmeRecallCandidates !== "function") {
          // Client does not support recall.candidates (e.g. an older mock or
          // a third-party client). Fall back to the 3-round path.
          diagnostics.fallbackReason ||= "authority-candidate-bme-unavailable";
        } else {
          const response = await client.bmeRecallCandidates(bmePayload, { signal });
          const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
          if (candidates.length > 0) {
            bmeFastPathActive = true;
            bmeFastPathCandidates = candidates;
            diagnostics.bmeFastPathUsed = true;
          } else {
            // Empty result is NOT an error - fall back to 3-round path when
            // failOpen is the default.
            diagnostics.fallbackReason ||= "authority-candidate-bme-empty";
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        diagnostics.fallbackReason ||= "authority-candidate-bme-failed";
        if (embeddingConfig?.failOpen === false) {
          throw error;
        }
        // failOpen default: fall back to 3-round path; log at warn level.
        console.warn(
          "[ST-BME] BME recall.candidates 快速路径失败，回退 3-round 路径:",
          error?.message || error,
        );
      }
    }
  }
  diagnostics.timings.bmeFastPath = roundMs(nowMs() - bmeFastPathStartedAt);

  let filteredIds = [];
  const filterStartedAt = nowMs();
  if (!bmeFastPathActive) {
    try {
      filteredIds = (await filterAuthorityTriviumNodes(embeddingConfig, {
        namespace: collectionId,
        collectionId,
        chatId,
        limit,
        topK: limit,
        filters: filterPayload,
        filter: filterPayload,
        where: filterPayload,
        searchText: queryPlan.queries[0]?.text || String(userMessage || "").trim(),
        signal,
      }))
        .filter((nodeId) => allowedIds.has(normalizeRecordId(nodeId)))
        .slice(0, limit);
      diagnostics.filteredCount = filteredIds.length;
    } catch (error) {
      if (isAbortError(error)) throw error;
      diagnostics.fallbackReason = "authority-candidate-filter-failed";
      if (embeddingConfig?.failOpen === false) {
        throw error;
      }
    }
  }
  diagnostics.timings.filter = roundMs(nowMs() - filterStartedAt);

  const searchScores = new Map();
  let embedMs = 0;
  const searchStartedAt = nowMs();
  if (bmeFastPathActive) {
    // Map candidates returned by recall.candidates directly to searchScores.
    // The server already ran filter+search+expand; skip the 3-round path.
    const fallbackQueryWeight = queryPlan.queries[0]?.weight || 0.1;
    for (const candidate of bmeFastPathCandidates) {
      const nodeId = normalizeRecordId(candidate?.externalId || candidate?.internalId);
      if (!nodeId || !allowedIds.has(nodeId)) continue;
      const baseScore = Math.max(0.001, Number(candidate?.score || 0) || 0.001);
      const weightedScore = baseScore * Math.max(0.05, fallbackQueryWeight);
      const previous = Number(searchScores.get(nodeId) || 0) || 0;
      if (weightedScore > previous) {
        searchScores.set(nodeId, weightedScore);
      }
    }
    diagnostics.searchHits = searchScores.size;
  } else {
    const searchResultsByQuery = await runLimited(
      queryPlan.queries,
      async (queryEntry) => {
        const embedStartedAt = nowMs();
        const queryVec = await embedText(queryEntry.text, embeddingConfig, {
          signal,
          isQuery: true,
        });
        embedMs += nowMs() - embedStartedAt;
        if (!queryVec) {
          diagnostics.fallbackReason ||= "authority-candidate-query-embed-empty";
          return [];
        }
        const searchResults = await searchAuthorityTriviumNodes(
          graph,
          queryEntry.text,
          embeddingConfig,
          {
            namespace: collectionId,
            collectionId,
            chatId,
            topK: limit,
            candidateIds: filteredIds.length > 0 ? filteredIds : undefined,
            queryVector: Array.from(queryVec),
            signal,
          },
        );
        return searchResults.map((result) => ({ ...result, queryWeight: queryEntry.weight }));
      },
      {
        concurrency: Math.max(1, Math.floor(Number(options.queryConcurrency || 1)) || 1),
        signal,
        failFast: false,
      },
    );
    diagnostics.timings.embed = roundMs(embedMs);
    for (const searchResults of searchResultsByQuery) {
      if (searchResults?.error) {
        diagnostics.fallbackReason ||= "authority-candidate-search-failed";
        if (embeddingConfig?.failOpen === false) {
          throw searchResults.error;
        }
        continue;
      }
      for (const result of searchResults || []) {
        const nodeId = normalizeRecordId(result?.nodeId);
        if (!nodeId || !allowedIds.has(nodeId)) continue;
        const weightedScore =
          Math.max(0.001, Number(result?.score || 0) || 0) *
          Math.max(0.05, Number(result?.queryWeight || 0) || 0.05);
        const previous = Number(searchScores.get(nodeId) || 0) || 0;
        if (weightedScore > previous) {
          searchScores.set(nodeId, weightedScore);
        }
      }
    }
    for (const item of searchResultsByQuery) {
      if (item?.error) {
        const error = item.error;
        if (isAbortError(error)) throw error;
        diagnostics.fallbackReason ||= "authority-candidate-search-failed";
        if (embeddingConfig?.failOpen === false) {
          throw error;
        }
      }
    }
  }
  diagnostics.timings.search = roundMs(nowMs() - searchStartedAt);
  diagnostics.searchHits = searchScores.size;

  const seedIds = [...searchScores.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([nodeId]) => nodeId)
    .slice(0, Math.min(limit, Math.max(4, neighborLimit)));

  let neighborIds = [];
  const neighborsStartedAt = nowMs();
  if (bmeFastPathActive) {
    // Neighbors already expanded server-side (source: "expand"); pull them
    // from the candidates directly and skip the queryAuthorityTriviumNeighbors
    // round trip.
    const seen = new Set(seedIds);
    for (const candidate of bmeFastPathCandidates) {
      if (candidate?.source !== "expand") continue;
      const nodeId = normalizeRecordId(candidate?.externalId || candidate?.internalId);
      if (!nodeId || !allowedIds.has(nodeId) || seen.has(nodeId)) continue;
      seen.add(nodeId);
      neighborIds.push(nodeId);
      if (neighborIds.length >= neighborLimit) break;
    }
    diagnostics.neighborCount = neighborIds.length;
  } else if (seedIds.length > 0) {
    try {
      neighborIds = (await queryAuthorityTriviumNeighbors(embeddingConfig, seedIds, {
        namespace: collectionId,
        collectionId,
        chatId,
        limit: neighborLimit,
        topK: neighborLimit,
        candidateIds: filteredIds.length > 0 ? filteredIds : undefined,
        signal,
      }))
        .filter((nodeId) => allowedIds.has(normalizeRecordId(nodeId)))
        .slice(0, neighborLimit);
      diagnostics.neighborCount = neighborIds.length;
    } catch (error) {
      if (isAbortError(error)) throw error;
      diagnostics.fallbackReason ||= "authority-candidate-neighbors-failed";
      if (embeddingConfig?.failOpen === false) {
        throw error;
      }
    }
  }
  diagnostics.timings.neighbors = roundMs(nowMs() - neighborsStartedAt);

  const prioritizedNodeIds = uniqueIds([
    ...seedIds,
    ...filteredIds,
    ...neighborIds,
  ]).slice(0, limit);
  const resolvedCandidateNodes = mapCandidateNodes(prioritizedNodeIds, candidateNodes);
  diagnostics.candidateCount = resolvedCandidateNodes.length;
  diagnostics.used =
    resolvedCandidateNodes.length >= minimumUsedCandidateCount &&
    resolvedCandidateNodes.length < candidateNodes.length;
  if (!diagnostics.used && !diagnostics.fallbackReason) {
    diagnostics.fallbackReason =
      resolvedCandidateNodes.length === 0
        ? "authority-candidate-empty"
        : resolvedCandidateNodes.length >= candidateNodes.length
          ? "authority-candidate-not-reduced"
          : "authority-candidate-too-small";
  }
  diagnostics.timings.total = roundMs(nowMs() - startedAt);

  return {
    available: true,
    used: diagnostics.used,
    candidateNodes: diagnostics.used ? resolvedCandidateNodes : [],
    diagnostics,
  };
}
