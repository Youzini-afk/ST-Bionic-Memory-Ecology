import { addEdge, addNode, updateNode } from "../graph/graph.js";
import {
  createDefaultSummaryState,
  normalizeGraphSummaryState,
} from "../graph/summary-state.js";
import { cloneRuntimeDebugValue } from "../graph/graph-persistence.js";
import { resolveConcurrencyConfig } from "../runtime/concurrency.js";
import {
  cloneGraphPersistDirtyState,
  markGraphPersistEdgeUpsert,
  markGraphPersistNodeUpsert,
  markGraphPersistRuntimeMetaDirty,
} from "../runtime/runtime-state.js";
import { compressAll } from "./compressor.js";
import { generateReflection } from "./extractor.js";
import { runHierarchicalSummaryPostProcess } from "./hierarchical-summary.js";

export function clonePlanCommitValue(value, fallback = null) {
  return cloneRuntimeDebugValue(value, fallback);
}

function arePlanCommitValuesEqual(left, right) {
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return false;
  }
}

function normalizeSummaryStateForPlan(state = {}) {
  return createDefaultSummaryState(state);
}

function normalizeGraphSummaryStateForPlan(graph) {
  if (!graph || typeof graph !== "object") return graph;
  return normalizeGraphSummaryState(graph);
}

function commitPlannedSummaryState(targetGraph, beforeState = {}, draftState = {}) {
  const stats = {
    summaryEntriesAdded: 0,
    summaryEntriesUpdated: 0,
    summaryEntriesFolded: 0,
  };
  if (!targetGraph || typeof targetGraph !== "object") return stats;

  normalizeGraphSummaryStateForPlan(targetGraph);
  const before = normalizeSummaryStateForPlan(beforeState);
  const draft = normalizeSummaryStateForPlan(draftState);
  const target = normalizeSummaryStateForPlan(targetGraph.summaryState);
  const beforeMap = new Map(before.entries.map((entry) => [entry.id, entry]));
  const targetMap = new Map(target.entries.map((entry) => [entry.id, entry]));
  const activeIds = new Set(target.activeEntryIds || []);

  for (const draftEntry of draft.entries) {
    const entryId = String(draftEntry?.id || "").trim();
    if (!entryId) continue;
    const beforeEntry = beforeMap.get(entryId) || null;
    if (beforeEntry && arePlanCommitValuesEqual(beforeEntry, draftEntry)) continue;

    const clonedEntry = clonePlanCommitValue(draftEntry, draftEntry);
    const targetEntry = targetMap.get(entryId) || null;
    if (targetEntry) {
      Object.assign(targetEntry, clonedEntry);
      stats.summaryEntriesUpdated += 1;
    } else {
      target.entries.push(clonedEntry);
      targetMap.set(entryId, clonedEntry);
      stats.summaryEntriesAdded += 1;
    }

    if (String(clonedEntry.status || "active") === "folded") {
      activeIds.delete(entryId);
      if (beforeEntry && String(beforeEntry.status || "active") !== "folded") {
        stats.summaryEntriesFolded += 1;
      }
    } else {
      activeIds.add(entryId);
    }
  }

  target.lastSummarizedExtractionCount = Math.max(
    Number(target.lastSummarizedExtractionCount || 0),
    Number(draft.lastSummarizedExtractionCount || 0),
  );
  target.lastSummarizedAssistantFloor = Math.max(
    Number(target.lastSummarizedAssistantFloor ?? -1),
    Number(draft.lastSummarizedAssistantFloor ?? -1),
  );
  target.activeEntryIds = [...activeIds].filter(
    (entryId) => String(targetMap.get(entryId)?.status || "active") !== "folded",
  );
  targetGraph.summaryState = target;
  normalizeGraphSummaryStateForPlan(targetGraph);
  return stats;
}

export function commitPlannedGraphChanges({
  targetGraph = null,
  beforeSnapshot = null,
  draftGraph = null,
  includeSummaryState = true,
} = {}) {
  const stats = {
    nodesAdded: 0,
    nodesUpdated: 0,
    edgesAdded: 0,
    summaryEntriesAdded: 0,
    summaryEntriesUpdated: 0,
    summaryEntriesFolded: 0,
  };
  if (!targetGraph || !beforeSnapshot || !draftGraph) return stats;

  targetGraph.nodes ||= [];
  targetGraph.edges ||= [];
  const beforeNodes = new Map(
    (beforeSnapshot.nodes || []).map((node) => [String(node?.id || ""), node]),
  );
  const targetNodes = new Map(
    (targetGraph.nodes || []).map((node) => [String(node?.id || ""), node]),
  );

  for (const draftNode of draftGraph.nodes || []) {
    const nodeId = String(draftNode?.id || "").trim();
    if (!nodeId) continue;
    const beforeNode = beforeNodes.get(nodeId) || null;
    if (beforeNode && arePlanCommitValuesEqual(beforeNode, draftNode)) continue;

    const clonedNode = clonePlanCommitValue(draftNode, draftNode);
    const targetNode = targetNodes.get(nodeId) || null;
    if (!targetNode) {
      addNode(targetGraph, clonedNode);
      targetNodes.set(nodeId, clonedNode);
      stats.nodesAdded += 1;
    } else {
      updateNode(targetGraph, nodeId, clonePlanCommitValue(clonedNode, clonedNode));
      stats.nodesUpdated += 1;
    }
  }

  const beforeEdgeIds = new Set(
    (beforeSnapshot.edges || []).map((edge) => String(edge?.id || "").trim()),
  );
  const targetEdgeIds = new Set(
    (targetGraph.edges || []).map((edge) => String(edge?.id || "").trim()),
  );
  for (const draftEdge of draftGraph.edges || []) {
    const edgeId = String(draftEdge?.id || "").trim();
    if (!edgeId || beforeEdgeIds.has(edgeId) || targetEdgeIds.has(edgeId)) continue;
    addEdge(targetGraph, clonePlanCommitValue(draftEdge, draftEdge));
    targetEdgeIds.add(edgeId);
    stats.edgesAdded += 1;
  }

  if (includeSummaryState) {
    Object.assign(
      stats,
      commitPlannedSummaryState(
        targetGraph,
        beforeSnapshot.summaryState,
        draftGraph.summaryState,
      ),
    );
  }
  return stats;
}

export function getSummaryStageLabel() {
  return "层级总结";
}

export async function runSummaryPostProcessPlanCommit(params = {}) {
  if (resolveConcurrencyConfig(params.settings || {}).mode === "strict") {
    return await runHierarchicalSummaryPostProcess(params);
  }
  const beforeSnapshot = clonePlanCommitValue(params.graph, params.graph);
  const draftGraph = clonePlanCommitValue(params.graph, params.graph);
  const result = await runHierarchicalSummaryPostProcess({
    ...params,
    graph: draftGraph,
  });
  return {
    ...(result && typeof result === "object" && !Array.isArray(result)
      ? result
      : { created: Boolean(result) }),
    planCommit: commitPlannedGraphChanges({
      targetGraph: params.graph,
      beforeSnapshot,
      draftGraph,
    }),
  };
}

export async function runReflectionPostProcessPlanCommit(params = {}) {
  if (resolveConcurrencyConfig(params.settings || {}).mode === "strict") {
    return {
      reflectionId: await generateReflection(params),
      planCommit: null,
    };
  }
  const beforeSnapshot = clonePlanCommitValue(params.graph, params.graph);
  const draftGraph = clonePlanCommitValue(params.graph, params.graph);
  const reflectionId = await generateReflection({
    ...params,
    graph: draftGraph,
  });
  return {
    reflectionId,
    planCommit: commitPlannedGraphChanges({
      targetGraph: params.graph,
      beforeSnapshot,
      draftGraph,
    }),
  };
}

export async function runCompressionPostProcessPlanCommit({
  graph,
  schema = [],
  embeddingConfig = null,
  force = false,
  customPrompt = undefined,
  signal = undefined,
  settings = {},
} = {}) {
  if (resolveConcurrencyConfig(settings).mode === "strict") {
    return await compressAll(
      graph,
      schema,
      embeddingConfig,
      force,
      customPrompt,
      signal,
      settings,
    );
  }
  const beforeSnapshot = clonePlanCommitValue(graph, graph);
  const draftGraph = clonePlanCommitValue(graph, graph);
  const result = await compressAll(
    draftGraph,
    schema,
    embeddingConfig,
    force,
    customPrompt,
    signal,
    settings,
  );
  return {
    ...(result && typeof result === "object" && !Array.isArray(result)
      ? result
      : { created: 0, archived: 0 }),
    planCommit: commitPlannedGraphChanges({
      targetGraph: graph,
      beforeSnapshot,
      draftGraph,
      includeSummaryState: false,
    }),
  };
}

export function hasPlanCommitChanges(planCommit = null) {
  if (!planCommit || typeof planCommit !== "object") return false;
  return [
    "nodesAdded",
    "nodesUpdated",
    "edgesAdded",
    "summaryEntriesAdded",
    "summaryEntriesUpdated",
    "summaryEntriesFolded",
  ].some((key) => Number(planCommit[key] || 0) > 0);
}

const CONSOLIDATION_NON_SEMANTIC_NODE_KEYS = new Set([
  // Recall/vector sync and later appends may change these while the LLM plans.
  "embedding",
  "importance",
  "accessCount",
  "lastAccessTime",
  "updatedAt",
  "prevId",
  "nextId",
]);

function buildConsolidationSemanticNode(node = null) {
  if (!node || typeof node !== "object") return null;
  return Object.fromEntries(
    Object.entries(node).filter(
      ([key]) => !CONSOLIDATION_NON_SEMANTIC_NODE_KEYS.has(key),
    ),
  );
}

function buildChangedRecordPatch(beforeRecord = {}, draftRecord = {}) {
  const patch = {};
  for (const key of new Set([
    ...Object.keys(beforeRecord || {}),
    ...Object.keys(draftRecord || {}),
  ])) {
    if (arePlanCommitValuesEqual(beforeRecord?.[key], draftRecord?.[key])) continue;
    patch[key] = clonePlanCommitValue(draftRecord?.[key], draftRecord?.[key]);
  }
  return patch;
}

function buildConsolidationRebasePlan(baseGraph, draftGraph, latestGraph) {
  const baseNodes = new Map(
    (baseGraph?.nodes || []).map((node) => [String(node?.id || ""), node]),
  );
  const latestNodes = new Map(
    (latestGraph?.nodes || []).map((node) => [String(node?.id || ""), node]),
  );
  const nodeChanges = [];
  for (const draftNode of draftGraph?.nodes || []) {
    const nodeId = String(draftNode?.id || "").trim();
    const baseNode = baseNodes.get(nodeId);
    if (!nodeId || !baseNode || arePlanCommitValuesEqual(baseNode, draftNode)) continue;
    const latestNode = latestNodes.get(nodeId);
    if (
      !latestNode ||
      !arePlanCommitValuesEqual(
        buildConsolidationSemanticNode(baseNode),
        buildConsolidationSemanticNode(latestNode),
      )
    ) {
      // Keep the whole consolidation decision atomic: never archive its source
      // after a newer extraction changed the merge/evolution target.
      return { conflict: true, reason: `node-changed:${nodeId}` };
    }
    nodeChanges.push({
      nodeId,
      patch: buildChangedRecordPatch(baseNode, draftNode),
    });
  }

  const baseEdges = new Map(
    (baseGraph?.edges || []).map((edge) => [String(edge?.id || ""), edge]),
  );
  const latestEdges = new Map(
    (latestGraph?.edges || []).map((edge) => [String(edge?.id || ""), edge]),
  );
  const edgeChanges = [];
  for (const draftEdge of draftGraph?.edges || []) {
    const edgeId = String(draftEdge?.id || "").trim();
    if (!edgeId) continue;
    const baseEdge = baseEdges.get(edgeId) || null;
    if (baseEdge && arePlanCommitValuesEqual(baseEdge, draftEdge)) continue;
    const latestEdge = latestEdges.get(edgeId) || null;
    if (!baseEdge && latestEdge) {
      if (arePlanCommitValuesEqual(latestEdge, draftEdge)) continue;
      return { conflict: true, reason: `edge-id-collision:${edgeId}` };
    }
    if (baseEdge && !arePlanCommitValuesEqual(baseEdge, latestEdge)) {
      return { conflict: true, reason: `edge-changed:${edgeId}` };
    }
    edgeChanges.push({
      edgeId,
      baseEdge,
      draftEdge: clonePlanCommitValue(draftEdge, draftEdge),
      patch: baseEdge ? buildChangedRecordPatch(baseEdge, draftEdge) : null,
    });
  }

  return {
    conflict: false,
    nodeChanges,
    edgeChanges,
    changed: nodeChanges.length > 0 || edgeChanges.length > 0,
  };
}

function applyConsolidationRebasePlan(graph, plan) {
  const touchedNodeIds = [];
  let edgesAdded = 0;
  let edgesUpdated = 0;
  for (const change of plan?.nodeChanges || []) {
    const node = (graph?.nodes || []).find((item) => item?.id === change.nodeId);
    if (!node) continue;
    Object.assign(node, clonePlanCommitValue(change.patch, change.patch));
    markGraphPersistNodeUpsert(
      graph,
      node,
      "background-consolidation",
      "maintenance.consolidation",
    );
    touchedNodeIds.push(change.nodeId);
  }

  for (const change of plan?.edgeChanges || []) {
    if (!change.baseEdge) {
      const duplicate = (graph?.edges || []).some(
        (edge) =>
          edge?.fromId === change.draftEdge?.fromId &&
          edge?.toId === change.draftEdge?.toId &&
          edge?.relation === change.draftEdge?.relation &&
          arePlanCommitValuesEqual(edge?.scope || {}, change.draftEdge?.scope || {}) &&
          !edge?.invalidAt &&
          !edge?.expiredAt,
      );
      if (!duplicate && addEdge(graph, change.draftEdge)) edgesAdded += 1;
      continue;
    }
    const edge = (graph?.edges || []).find((item) => item?.id === change.edgeId);
    if (!edge) continue;
    Object.assign(edge, clonePlanCommitValue(change.patch, change.patch));
    markGraphPersistEdgeUpsert(
      graph,
      edge,
      "background-consolidation",
      "maintenance.consolidation",
    );
    edgesUpdated += 1;
  }
  return { touchedNodeIds, edgesAdded, edgesUpdated };
}

function mergeUniqueStrings(...values) {
  return [
    ...new Set(
      values
        .flat()
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
}

function mergeJournalSnapshots(original = [], incoming = [], createdIds = []) {
  const created = new Set(createdIds || []);
  const merged = Array.isArray(original) ? [...original] : [];
  const seen = new Set(merged.map((record) => String(record?.id || "")));
  for (const record of incoming || []) {
    const id = String(record?.id || "").trim();
    if (!id || created.has(id) || seen.has(id)) continue;
    merged.push(clonePlanCommitValue(record, record));
    seen.add(id);
  }
  return merged;
}

function mergeBatchJournalDelta(batchJournal, deltaJournal) {
  if (!batchJournal || !deltaJournal) return false;
  batchJournal.createdNodeIds = mergeUniqueStrings(
    batchJournal.createdNodeIds,
    deltaJournal.createdNodeIds,
  );
  batchJournal.createdEdgeIds = mergeUniqueStrings(
    batchJournal.createdEdgeIds,
    deltaJournal.createdEdgeIds,
  );
  batchJournal.previousNodeSnapshots = mergeJournalSnapshots(
    batchJournal.previousNodeSnapshots,
    deltaJournal.previousNodeSnapshots,
    batchJournal.createdNodeIds,
  );
  batchJournal.previousEdgeSnapshots = mergeJournalSnapshots(
    batchJournal.previousEdgeSnapshots,
    deltaJournal.previousEdgeSnapshots,
    batchJournal.createdEdgeIds,
  );
  batchJournal.touchedNodeIds = mergeUniqueStrings(
    batchJournal.touchedNodeIds,
    deltaJournal.touchedNodeIds,
  );
  batchJournal.postProcessArtifacts = mergeUniqueStrings(
    batchJournal.postProcessArtifacts,
    deltaJournal.postProcessArtifacts,
    ["consolidation"],
  );
  const originalVectorDelta = batchJournal.vectorDelta || {};
  const incomingVectorDelta = deltaJournal.vectorDelta || {};
  batchJournal.vectorDelta = {
    insertedHashes: mergeUniqueStrings(
      originalVectorDelta.insertedHashes,
      incomingVectorDelta.insertedHashes,
    ),
    removedHashes: mergeUniqueStrings(
      originalVectorDelta.removedHashes,
      incomingVectorDelta.removedHashes,
    ),
    replacedMappings: [
      ...(Array.isArray(originalVectorDelta.replacedMappings)
        ? originalVectorDelta.replacedMappings
        : []),
      ...(Array.isArray(incomingVectorDelta.replacedMappings)
        ? incomingVectorDelta.replacedMappings
        : []),
    ],
    touchedNodeIds: mergeUniqueStrings(
      originalVectorDelta.touchedNodeIds,
      incomingVectorDelta.touchedNodeIds,
    ),
    replayRequiredNodeIds: mergeUniqueStrings(
      originalVectorDelta.replayRequiredNodeIds,
      incomingVectorDelta.replayRequiredNodeIds,
    ),
    backendDeleteHashes: mergeUniqueStrings(
      originalVectorDelta.backendDeleteHashes,
      incomingVectorDelta.backendDeleteHashes,
    ),
  };
  return true;
}

function normalizeSourceRange(range = null) {
  if (!Array.isArray(range)) return null;
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return [
    Math.max(0, Math.floor(Math.min(start, end))),
    Math.max(0, Math.floor(Math.max(start, end))),
  ];
}

function scheduleBackgroundConsolidationTask(runtime, task, settings) {
  const {
    analyzeAutoConsolidationGate,
    buildChatHistoryFingerprint,
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    consolidateMemories,
    createBatchJournalEntry,
    enqueueBackgroundMaintenanceTask,
    evaluateAutoConsolidationGate,
    getContext,
    getCurrentChatId,
    getCurrentGraph,
    getEmbeddingConfig,
    getIsExtracting,
    getSchema,
    normalizeChatId,
    recordMaintenanceAction,
    saveGraphToChat,
    scheduleBackgroundVectorSync,
    setCurrentGraph,
  } = runtime;
  const scheduledSettings = clonePlanCommitValue(settings, settings) || settings;
  const baseGraph = cloneGraphSnapshot(getCurrentGraph());
  const scheduledChatId = normalizeChatId(
    getCurrentChatId() || baseGraph?.historyState?.chatId || "",
  );
  const payload = clonePlanCommitValue(task?.payload, {}) || {};
  const batchJournalId = String(payload.batchJournalId || "").trim();
  const sourceRange = normalizeSourceRange(payload.sourceChatIndexRange);
  const sourceHistoryFingerprint = String(payload.sourceHistoryFingerprint || "");
  const isSourceCurrent = () => {
    if (
      normalizeChatId(
        getCurrentChatId() || getCurrentGraph()?.historyState?.chatId || "",
      ) !== scheduledChatId
    ) {
      return false;
    }
    if (!sourceRange || !sourceHistoryFingerprint) return true;
    const chat = getContext?.()?.chat;
    if (!Array.isArray(chat)) return false;
    return (
      buildChatHistoryFingerprint(chat.slice(sourceRange[0], sourceRange[1] + 1)) ===
      sourceHistoryFingerprint
    );
  };
  const stale = (reason = "stale-background-consolidation") => ({
    skipped: true,
    reason,
  });

  return enqueueBackgroundMaintenanceTask(
    "consolidation",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!batchJournalId) return stale("missing-consolidation-batch-journal");
      if (!isSourceCurrent()) return stale();
      if (
        !(getCurrentGraph()?.batchJournal || []).some(
          (entry) => String(entry?.id || "") === batchJournalId,
        )
      ) {
        return stale("consolidation-source-batch-rolled-back");
      }
      const newNodeIds = mergeUniqueStrings(payload.newNodeIds);
      if (!newNodeIds.length) return stale("missing-consolidation-candidates");
      const embeddingConfig = getEmbeddingConfig();
      const schema = getSchema();

      const minNewNodes = Math.max(
        1,
        Math.min(
          50,
          Math.floor(
            Number(scheduledSettings?.consolidationAutoMinNewNodes ?? 2),
          ) || 2,
        ),
      );
      let analysis = null;
      if (newNodeIds.length < minNewNodes) {
        analysis = await analyzeAutoConsolidationGate({
          graph: baseGraph,
          newNodeIds,
          embeddingConfig,
          schema,
          conflictThreshold: scheduledSettings.consolidationThreshold,
        });
      }
      if (!isSourceCurrent()) return stale();
      const gate = evaluateAutoConsolidationGate(
        newNodeIds.length,
        analysis,
        scheduledSettings,
      );
      if (!gate?.shouldRun) {
        return stale(gate?.reason || "consolidation-gate-skipped");
      }

      const draftGraph = cloneGraphSnapshot(baseGraph);
      const result = await consolidateMemories({
        graph: draftGraph,
        newNodeIds,
        embeddingConfig,
        schema,
        options: {
          neighborCount: scheduledSettings.consolidationNeighborCount,
          conflictThreshold: scheduledSettings.consolidationThreshold,
        },
        settings: scheduledSettings,
      });
      if (!isSourceCurrent()) return stale();

      while (getIsExtracting?.()) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!isSourceCurrent()) return stale();
      }

      const latestGraph = getCurrentGraph();
      const latestJournal = (latestGraph?.batchJournal || []).find(
        (entry) => String(entry?.id || "") === batchJournalId,
      );
      if (!latestJournal) return stale("consolidation-source-batch-rolled-back");
      const rebasePlan = buildConsolidationRebasePlan(
        baseGraph,
        draftGraph,
        latestGraph,
      );
      if (rebasePlan.conflict) {
        return stale(`background-consolidation-conflict:${rebasePlan.reason}`);
      }
      if (!rebasePlan.changed) return { changed: false, result, gate };

      // No await between reading the latest graph and publishing its rebased clone.
      const commitGraph = cloneGraphSnapshot(latestGraph);
      cloneGraphPersistDirtyState(latestGraph, commitGraph);
      const commitStats = applyConsolidationRebasePlan(commitGraph, rebasePlan);
      const vectorSyncNeeded = commitStats.touchedNodeIds.length > 0;
      if (vectorSyncNeeded) {
        commitGraph.vectorIndexState ||= {};
        commitGraph.vectorIndexState.dirty = true;
        commitGraph.vectorIndexState.dirtyReason =
          "background-consolidation-vector-sync-queued";
        commitGraph.vectorIndexState.lastWarning =
          "后台整合已完成，向量索引正在后台同步";
      }
      const commitJournal = (commitGraph.batchJournal || []).find(
        (entry) => String(entry?.id || "") === batchJournalId,
      );
      const deltaJournal = createBatchJournalEntry(latestGraph, commitGraph, {
        processedRange: commitJournal?.processedRange,
        processedDialogueRange: commitJournal?.processedDialogueRange,
        sourceChatIndexRange: commitJournal?.sourceChatIndexRange,
        postProcessArtifacts: ["consolidation"],
        vectorTouchedNodeIds: commitStats.touchedNodeIds,
        vectorReplayRequiredNodeIds: commitStats.touchedNodeIds,
      });
      const baseNodes = new Map(
        (baseGraph?.nodes || []).map((node) => [String(node?.id || ""), node]),
      );
      const baseEdges = new Map(
        (baseGraph?.edges || []).map((edge) => [String(edge?.id || ""), edge]),
      );
      deltaJournal.previousNodeSnapshots = (
        deltaJournal.previousNodeSnapshots || []
      ).map((node) =>
        clonePlanCommitValue(
          baseNodes.get(String(node?.id || "")) || node,
          node,
        ),
      );
      deltaJournal.previousEdgeSnapshots = (
        deltaJournal.previousEdgeSnapshots || []
      ).map((edge) =>
        clonePlanCommitValue(
          baseEdges.get(String(edge?.id || "")) || edge,
          edge,
        ),
      );
      if (!mergeBatchJournalDelta(commitJournal, deltaJournal)) {
        return stale("consolidation-journal-merge-failed");
      }
      markGraphPersistRuntimeMetaDirty(
        commitGraph,
        "background-consolidation",
        "maintenance.consolidation",
      );
      recordMaintenanceAction?.({
        graph: commitGraph,
        action: "consolidate",
        beforeSnapshot: latestGraph,
        mode: "auto",
        summary:
          buildMaintenanceSummary?.("consolidate", result, "auto") ||
          "自动整合已完成",
      });
      setCurrentGraph(commitGraph);

      let vectorQueue = null;
      try {
        const processedRange = normalizeSourceRange(payload.processedRange);
        if (vectorSyncNeeded) {
          vectorQueue = scheduleBackgroundVectorSync?.(
            {
              id: `vector-sync:consolidation:${Date.now()}`,
              chatId: scheduledChatId,
              reason: "background-vector-sync-after-consolidation",
              range: processedRange
                ? { start: processedRange[0], end: processedRange[1] }
                : null,
            },
            scheduledSettings,
          );
        }
      } catch (error) {
        console.warn("[ST-BME] 后台整合向量同步入队失败:", error);
      }
      if (vectorSyncNeeded && vectorQueue?.queued !== true) {
        commitGraph.vectorIndexState.dirtyReason =
          "background-consolidation-vector-sync-queue-failed";
        commitGraph.vectorIndexState.lastWarning =
          vectorQueue?.reason || "后台整合后的向量同步未能入队";
      }
      markGraphPersistRuntimeMetaDirty(
        commitGraph,
        "background-consolidation-vector-state",
        "maintenance.consolidation",
      );
      try {
        Promise.resolve(
          saveGraphToChat({ reason: "background-consolidation" }),
        ).catch((error) =>
          console.warn("[ST-BME] 后台整合持久化失败，已交由持久化重试状态处理:", error),
        );
      } catch (error) {
        console.warn("[ST-BME] 后台整合持久化启动失败:", error);
      }
      return { changed: true, result, gate, commit: commitStats, vectorQueue };
    },
    scheduledSettings,
    { id: `consolidation:${String(task?.id || Date.now())}` },
  );
}

export function scheduleBackgroundMaintenancePostProcessController(
  runtime,
  tasks = [],
  settings = {},
) {
  const {
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    enqueueBackgroundMaintenanceTask,
    ensureCurrentGraphRuntimeState,
    getContext,
    getCurrentChatId,
    getCurrentGraph,
    getEmbeddingConfig,
    getExtractionCount,
    getSchema,
    normalizeChatId,
    recordMaintenanceAction,
    saveGraphToChat,
    setLastExtractionStatus,
    updateBackgroundMaintenanceQueueState,
  } = runtime;
  const taskList = Array.isArray(tasks)
    ? tasks.filter((task) => task && typeof task === "object" && task.type)
    : [];
  if (!taskList.length) {
    return {
      queued: false,
      reason: "no-background-maintenance-tasks",
      snapshot: updateBackgroundMaintenanceQueueState(null),
    };
  }

  const consolidationTasks = taskList.filter(
    (task) => String(task?.type || "").trim() === "consolidate",
  );
  if (consolidationTasks.length > 0) {
    const regularTasks = taskList.filter(
      (task) => String(task?.type || "").trim() !== "consolidate",
    );
    const queueResults = [];
    // Preserve the existing post-process order; consolidation rebases after it.
    if (regularTasks.length > 0) {
      queueResults.push(
        scheduleBackgroundMaintenancePostProcessController(
          runtime,
          regularTasks,
          settings,
        ),
      );
    }
    for (const task of consolidationTasks) {
      queueResults.push(scheduleBackgroundConsolidationTask(runtime, task, settings));
    }
    if (queueResults.length === 1) return queueResults[0];
    const failed = queueResults.find((result) => result?.queued !== true);
    return {
      queued: !failed,
      reason: failed?.reason || "",
      queues: queueResults,
      snapshot: queueResults[queueResults.length - 1]?.snapshot || null,
    };
  }

  const scheduledSettings = clonePlanCommitValue(settings, settings) || settings;
  const scheduledChatId = normalizeChatId(getCurrentChatId());
  const scheduledGraph = getCurrentGraph();
  const scheduledExtractionCount = getExtractionCount();
  const isScheduledContextActive = () =>
    getCurrentGraph() === scheduledGraph &&
    normalizeChatId(getCurrentChatId()) === scheduledChatId;
  const staleResult = () => ({
    skipped: true,
    reason: "stale-background-post-process",
  });
  const mode = resolveConcurrencyConfig(scheduledSettings).mode;
  const taskId = taskList.map((task) => String(task.id || task.type)).join("+");

  return enqueueBackgroundMaintenanceTask(
    "post-process",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!isScheduledContextActive()) return staleResult();
      ensureCurrentGraphRuntimeState();
      const details = [];
      let changed = false;
      setLastExtractionStatus?.(
        "后台维护中",
        `${mode} 模式 · 正在执行 ${taskList.map((task) => task.type).join(" / ")}`,
        "running",
        { syncRuntime: false },
      );

      for (const task of taskList) {
        const type = String(task.type || "").trim();
        const payload =
          task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
            ? task.payload
            : {};
        if (type === "summary") {
          const contextChat = getContext?.()?.chat;
          const result = await runSummaryPostProcessPlanCommit({
            graph: scheduledGraph,
            chat: Array.isArray(payload.chat)
              ? payload.chat
              : Array.isArray(contextChat)
                ? contextChat
                : [],
            settings: scheduledSettings,
            currentExtractionCount:
              Number(payload.currentExtractionCount || 0) ||
              scheduledExtractionCount,
            currentAssistantFloor: Number(payload.currentAssistantFloor ?? -1),
            currentRange: Array.isArray(payload.currentRange) ? payload.currentRange : null,
            currentNodeIds: Array.isArray(payload.currentNodeIds) ? payload.currentNodeIds : [],
          });
          if (!isScheduledContextActive()) return staleResult();
          const taskChanged =
            Boolean(result?.smallSummary?.created) ||
            Number(result?.rollup?.createdCount || 0) > 0 ||
            hasPlanCommitChanges(result?.planCommit);
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        } else if (type === "reflection") {
          const result = await runReflectionPostProcessPlanCommit({
            graph: scheduledGraph,
            currentSeq: Number(payload.currentSeq ?? -1),
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            settings: scheduledSettings,
          });
          if (!isScheduledContextActive()) return staleResult();
          const taskChanged =
            Boolean(result?.reflectionId) ||
            hasPlanCommitChanges(result?.planCommit);
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        } else if (type === "compression") {
          const beforeSnapshot = cloneGraphSnapshot(scheduledGraph);
          const result = await runCompressionPostProcessPlanCommit({
            graph: scheduledGraph,
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            force: Boolean(payload.force),
            customPrompt: payload.customPrompt ?? undefined,
            settings: scheduledSettings,
          });
          if (!isScheduledContextActive()) return staleResult();
          const taskChanged =
            Number(result?.created || 0) > 0 ||
            Number(result?.archived || 0) > 0 ||
            hasPlanCommitChanges(result?.planCommit);
          if (taskChanged) {
            const compressionSummary = buildMaintenanceSummary?.(
              "compress",
              result,
              "auto",
            ) || `自动压缩：新增 ${result?.created || 0}，归档 ${result?.archived || 0}`;
            recordMaintenanceAction?.({
              action: "compress",
              beforeSnapshot,
              mode: "auto",
              summary: compressionSummary,
            });
          }
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        }
      }

      if (!isScheduledContextActive()) return staleResult();
      if (changed) {
        saveGraphToChat({
          reason: `background-post-process:${taskList.map((task) => task.type).join("+")}`,
        });
      }
      setLastExtractionStatus?.(
        changed ? "后台维护完成" : "后台维护跳过",
        changed ? "后台维护已完成并持久化" : "后台维护未产生可持久化变化",
        changed ? "success" : "warning",
        { syncRuntime: false },
      );
      return { changed, details };
    },
    scheduledSettings,
    { id: `post-process:${taskId}` },
  );
}
