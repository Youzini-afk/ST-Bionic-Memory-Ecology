import { cloneDomainValue } from "../domain/memory-id.js";
import { getActiveNodes } from "../graph/graph.js";

async function loadDefaultRetriever() {
  return (await import("./retriever.js")).retrieve;
}

function positiveInteger(value, fallback, maximum = 200) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(maximum, Math.floor(numeric))
    : fallback;
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function projectedCandidate(node, channels, rank = null) {
  return {
    memoryId: String(node.id || ""),
    revisionId: String(node.memoryRevisionId || ""),
    memoryType: String(node.type || ""),
    layer: String(node.memoryLayer || node.scope?.layer || "objective"),
    fields: cloneDomainValue(node.fields, {}),
    scope: cloneDomainValue(node.scope, {}),
    storyTime: cloneDomainValue(node.storyTime, {}),
    storyTimeSpan: cloneDomainValue(node.storyTimeSpan, {}),
    importance: Number(node.importance || 0),
    confidence: Number(node.memoryConfidence ?? 1),
    sourceFloor: Number(node.sourceFloor ?? node.seq ?? 0),
    channels: uniqueStrings(channels),
    rank,
  };
}

export function collectVectorTailCandidates(
  graph,
  { excludeMemoryIds = [], limit = 12 } = {},
) {
  const excluded = new Set(uniqueStrings(excludeMemoryIds));
  const state = graph?.vectorIndexState || {};
  const replayRequired = new Set(uniqueStrings(state.replayRequiredNodeIds));
  const pendingFloor = Number(state.pendingRepairFromFloor);
  const hasPendingFloor = state.dirty === true && Number.isFinite(pendingFloor);
  const hasExplicitDirtyTargets = replayRequired.size > 0 || hasPendingFloor;
  const indexed = state.nodeToHash && typeof state.nodeToHash === "object"
    ? state.nodeToHash
    : {};
  const expectsIndexMapping = ["backend", "authority"].includes(
    String(state.mode || "").trim(),
  );
  return getActiveNodes(graph)
    .filter((node) => node && !node.archived && !excluded.has(String(node.id || "")))
    .map((node) => {
      const reasons = [];
      if (replayRequired.has(node.id)) reasons.push("replay-required");
      if (hasPendingFloor && Number(node.sourceFloor ?? node.seq ?? -1) >= pendingFloor) {
        reasons.push("pending-repair-floor");
      }
      if (expectsIndexMapping && !indexed[node.id]) reasons.push("not-indexed");
      if (!Array.isArray(node.embedding) || node.embedding.length === 0) {
        reasons.push("embedding-unavailable");
      }
      if (state.dirty === true && !hasExplicitDirtyTargets) {
        reasons.push("dirty-index-tail");
      }
      return { node, reasons: uniqueStrings(reasons) };
    })
    .filter((entry) => entry.reasons.length > 0)
    .sort((left, right) => {
      const floorDelta =
        Number(right.node.sourceFloor ?? right.node.seq ?? 0) -
        Number(left.node.sourceFloor ?? left.node.seq ?? 0);
      if (floorDelta !== 0) return floorDelta;
      const importanceDelta =
        Number(right.node.importance || 0) - Number(left.node.importance || 0);
      return importanceDelta || String(left.node.id).localeCompare(String(right.node.id), "en");
    })
    .slice(0, positiveInteger(limit, 12, 80))
    .map((entry, index) =>
      projectedCandidate(entry.node, ["vector-tail", ...entry.reasons], index + 1),
    );
}

export async function buildRecallCandidatePacket({
  graph,
  graphIsFrozen = false,
  userMessage = "",
  recentMessages = [],
  embeddingConfig = {},
  schema = [],
  settings = {},
  options = {},
  retrieveFn = null,
  signal,
} = {}) {
  if (!graph || typeof graph !== "object") {
    throw new TypeError("buildRecallCandidatePacket requires graph");
  }
  const candidateLimit = positiveInteger(options.candidateLimit, 36, 120);
  const tailLimit = positiveInteger(options.tailLimit, 12, 80);
  const workingGraph = graphIsFrozen ? graph : cloneDomainValue(graph, graph);
  const runRetrieve = typeof retrieveFn === "function"
    ? retrieveFn
    : await loadDefaultRetriever();
  const baselineResult = await runRetrieve({
    graph: workingGraph,
    userMessage,
    recentMessages,
    embeddingConfig,
    schema,
    settings,
    signal,
    options: {
      ...options,
      topK: candidateLimit,
      maxRecallNodes: candidateLimit,
      llmCandidatePool: candidateLimit,
      enableLLMRecall: false,
      enableProbRecall: false,
    },
  });
  const baselineIds = uniqueStrings(baselineResult.selectedNodeIds).slice(0, candidateLimit);
  const baselineCandidates = baselineIds
    .map((memoryId, index) => {
      const node = workingGraph.nodes?.find((candidate) => candidate.id === memoryId);
      return node
        ? projectedCandidate(node, ["programmatic"], index + 1)
        : null;
    })
    .filter(Boolean);
  const tailCandidates = collectVectorTailCandidates(workingGraph, {
    excludeMemoryIds: baselineIds,
    limit: tailLimit,
  });
  const candidates = [...baselineCandidates, ...tailCandidates];
  const candidateMemoryIds = uniqueStrings(candidates.map((candidate) => candidate.memoryId));
  const { graph: _scopeGraph, ...scopeContext } =
    baselineResult.meta?.scopeContext || {};
  return {
    candidateMemoryIds,
    initialSelectedMemoryIds: baselineIds,
    candidates,
    channels: {
      programmatic: baselineCandidates.length,
      vectorTail: tailCandidates.length,
    },
    vectorState: {
      mode: String(graph.vectorIndexState?.mode || ""),
      dirty: graph.vectorIndexState?.dirty === true,
      pendingRepairFromFloor: Number.isFinite(
        Number(graph.vectorIndexState?.pendingRepairFromFloor),
      )
        ? Number(graph.vectorIndexState.pendingRepairFromFloor)
        : null,
      replayRequiredCount: Array.isArray(graph.vectorIndexState?.replayRequiredNodeIds)
        ? graph.vectorIndexState.replayRequiredNodeIds.length
        : 0,
    },
    baseline: {
      selectedMemoryIds: baselineIds,
      stats: cloneDomainValue(baselineResult.stats, {}),
      retrievalMeta: cloneDomainValue(baselineResult.meta?.retrieval, {}),
      scopeContext: cloneDomainValue(scopeContext, {}),
    },
  };
}
