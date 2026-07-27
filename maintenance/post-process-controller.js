import { addEdge, addNode, updateNode } from "../graph/graph.js";
import {
  createDefaultSummaryState,
  normalizeGraphSummaryState,
} from "../graph/summary-state.js";
import { cloneRuntimeDebugValue } from "../graph/graph-persistence.js";
import { resolveConcurrencyConfig } from "../runtime/concurrency.js";
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
