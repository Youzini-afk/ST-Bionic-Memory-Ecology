import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl([
      "export const extension_settings = {};",
      "export function getContext() { return null; }",
    ].join("\n")),
  },
  {
    specifiers: ["../../../../script.js", "../../../../../script.js"],
    url: toDataModuleUrl([
      "export function getRequestHeaders() { return {}; }",
      "export function substituteParamsExtended(value) { return String(value ?? ''); }",
    ].join("\n")),
  },
  {
    specifiers: ["../../../openai.js", "../../../../openai.js"],
    url: toDataModuleUrl([
      "export const chat_completion_sources = { OPENAI: 'openai' };",
      "export async function sendOpenAIRequest() { throw new Error('unexpected LLM request'); }",
    ].join("\n")),
  },
]);

const {
  addNode,
  createEdge,
  createEmptyGraph,
  createNode,
} = await import("../graph/graph.js");
const {
  commitPlannedGraphChanges,
  scheduleBackgroundMaintenancePostProcessController,
} = await import("../maintenance/post-process-controller.js");
const {
  appendBatchJournal,
  buildChatHistoryFingerprint,
  createBatchJournalEntry,
  rollbackBatch,
} = await import("../runtime/runtime-state.js");

{
  const targetGraph = createEmptyGraph();
  const existingNode = createNode({
    type: "event",
    fields: { summary: "before" },
    seq: 1,
  });
  addNode(targetGraph, existingNode);
  const beforeSnapshot = structuredClone(targetGraph);
  const draftGraph = structuredClone(targetGraph);
  draftGraph.nodes[0].fields.summary = "after";
  const addedNode = createNode({
    type: "pov_memory",
    fields: { summary: "new" },
    seq: 2,
  });
  draftGraph.nodes.push(addedNode);
  draftGraph.edges.push(createEdge({
    fromId: existingNode.id,
    toId: addedNode.id,
  }));
  draftGraph.summaryState.entries.push({
    id: "summary-1",
    level: 0,
    kind: "small",
    status: "active",
    text: "summary",
  });
  draftGraph.summaryState.activeEntryIds.push("summary-1");

  const stats = commitPlannedGraphChanges({
    targetGraph,
    beforeSnapshot,
    draftGraph,
  });

  assert.equal(stats.nodesAdded, 1);
  assert.equal(stats.nodesUpdated, 1);
  assert.equal(stats.edgesAdded, 1);
  assert.equal(stats.summaryEntriesAdded, 1);
  assert.equal(targetGraph.nodes.find((node) => node.id === existingNode.id)?.fields.summary, "after");
  assert.ok(targetGraph.nodes.some((node) => node.id === addedNode.id));
  assert.ok(targetGraph.summaryState.activeEntryIds.includes("summary-1"));
}

{
  const graphA = createEmptyGraph();
  let currentGraph = graphA;
  let currentChatId = "chat-a";
  let queuedRun = null;
  let saved = 0;
  let statusUpdates = 0;
  const queued = scheduleBackgroundMaintenancePostProcessController(
    {
      buildMaintenanceSummary: () => "",
      cloneGraphSnapshot: structuredClone,
      enqueueBackgroundMaintenanceTask: (_name, run) => {
        queuedRun = run;
        return { queued: true, id: "post-process:test" };
      },
      ensureCurrentGraphRuntimeState: () => {},
      getContext: () => ({ chat: [] }),
      getCurrentChatId: () => currentChatId,
      getCurrentGraph: () => currentGraph,
      getEmbeddingConfig: () => null,
      getExtractionCount: () => 1,
      getSchema: () => [],
      normalizeChatId: (value) => String(value || ""),
      recordMaintenanceAction: () => {},
      saveGraphToChat: () => { saved += 1; },
      setLastExtractionStatus: () => { statusUpdates += 1; },
      updateBackgroundMaintenanceQueueState: () => null,
    },
    [{ type: "summary", id: "summary" }],
    { maintenanceExecutionMode: "balanced" },
  );

  assert.equal(queued.queued, true);
  assert.equal(typeof queuedRun, "function");
  currentGraph = createEmptyGraph();
  currentChatId = "chat-b";
  assert.deepEqual(await queuedRun(), {
    skipped: true,
    reason: "stale-background-post-process",
  });
  assert.equal(saved, 0);
  assert.equal(statusUpdates, 0);
}

function createConsolidationHarness({ conflict = false } = {}) {
  const chat = [
    { is_user: true, mes: "hello" },
    { is_user: false, mes: "world" },
  ];
  const beforeGraph = createEmptyGraph();
  beforeGraph.historyState.chatId = "chat-a";
  const targetNode = createNode({
    type: "event",
    fields: { summary: "before" },
    seq: 1,
  });
  addNode(beforeGraph, targetNode);
  const graphA = structuredClone(beforeGraph);
  const sourceNode = createNode({
    type: "thread",
    fields: { summary: "duplicate" },
    seq: 2,
  });
  addNode(graphA, sourceNode);
  const journal = createBatchJournalEntry(beforeGraph, graphA, {
    processedRange: [0, 1],
    sourceChatIndexRange: [0, 1],
  });
  appendBatchJournal(graphA, journal);

  let currentGraph = graphA;
  let extracting = true;
  let queuedRun = null;
  let saved = 0;
  let statusUpdates = 0;
  let vectorSchedules = 0;
  const runtime = {
    analyzeAutoConsolidationGate: async () => ({ triggered: true }),
    buildChatHistoryFingerprint,
    buildMaintenanceSummary: () => "自动整合",
    cloneGraphSnapshot: structuredClone,
    consolidateMemories: async ({ graph }) => {
      graph.nodes.find((node) => node.id === sourceNode.id).archived = true;
      graph.nodes.find((node) => node.id === targetNode.id).fields.summary = "merged";
      graph.nodes.find((node) => node.id === targetNode.id).embedding = null;
      return { merged: 1, skipped: 0, kept: 0 };
    },
    createBatchJournalEntry,
    enqueueBackgroundMaintenanceTask: (_name, run) => {
      queuedRun = run;
      return { queued: true, id: "consolidation:test" };
    },
    evaluateAutoConsolidationGate: () => ({ shouldRun: true, reason: "test" }),
    getContext: () => ({ chat }),
    getCurrentChatId: () => "chat-a",
    getCurrentGraph: () => currentGraph,
    getEmbeddingConfig: () => ({ source: "test" }),
    getIsExtracting: () => extracting,
    getSchema: () => [],
    normalizeChatId: (value) => String(value || ""),
    recordMaintenanceAction: () => {},
    saveGraphToChat: () => { saved += 1; },
    scheduleBackgroundVectorSync: () => {
      vectorSchedules += 1;
      return { queued: true, id: "vector:test" };
    },
    setCurrentGraph: (graph) => { currentGraph = graph; },
    setLastExtractionStatus: () => { statusUpdates += 1; },
    updateBackgroundMaintenanceQueueState: () => null,
  };
  const queued = scheduleBackgroundMaintenancePostProcessController(
    runtime,
    [{
      type: "consolidate",
      id: "consolidate-a",
      payload: {
        newNodeIds: [sourceNode.id],
        batchJournalId: journal.id,
        processedRange: [0, 1],
        sourceChatIndexRange: [0, 1],
        sourceHistoryFingerprint: buildChatHistoryFingerprint(chat),
      },
    }],
    { consolidationAutoMinNewNodes: 1 },
  );

  const beforeGraphB = structuredClone(graphA);
  const graphB = structuredClone(graphA);
  const targetB = graphB.nodes.find((node) => node.id === targetNode.id);
  targetB.accessCount = 7;
  if (conflict) targetB.fields.summary = "changed-by-new-extraction";
  const laterNode = createNode({
    type: "event",
    fields: { summary: "later" },
    seq: 3,
  });
  addNode(graphB, laterNode);
  const laterJournal = createBatchJournalEntry(beforeGraphB, graphB, {
    processedRange: [2, 3],
    sourceChatIndexRange: [2, 3],
  });
  appendBatchJournal(graphB, laterJournal);
  currentGraph = graphB;

  return {
    queued,
    run: () => queuedRun(),
    releaseExtraction: () => { extracting = false; },
    getCurrentGraph: () => currentGraph,
    getSaved: () => saved,
    getStatusUpdates: () => statusUpdates,
    getVectorSchedules: () => vectorSchedules,
    sourceNode,
    targetNode,
    laterNode,
    laterJournal,
    journal,
  };
}

{
  const harness = createConsolidationHarness();
  assert.equal(harness.queued.queued, true);
  const running = harness.run();
  const early = await Promise.race([
    running.then(() => "finished"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]);
  assert.equal(early, "waiting", "commit must wait for an active extraction");
  harness.releaseExtraction();
  const result = await running;
  assert.equal(result.changed, true);
  const graph = harness.getCurrentGraph();
  assert.equal(graph.nodes.find((node) => node.id === harness.sourceNode.id).archived, true);
  assert.equal(graph.nodes.find((node) => node.id === harness.targetNode.id).fields.summary, "merged");
  assert.equal(graph.nodes.find((node) => node.id === harness.targetNode.id).accessCount, 7);
  assert.ok(graph.nodes.some((node) => node.id === harness.laterNode.id));
  const journal = graph.batchJournal.find((entry) => entry.id === harness.journal.id);
  assert.ok(journal.postProcessArtifacts.includes("consolidation"));
  assert.equal(
    journal.previousNodeSnapshots.find((node) => node.id === harness.targetNode.id)?.fields.summary,
    "before",
  );
  assert.equal(harness.getSaved(), 1);
  assert.equal(harness.getVectorSchedules(), 1);
  assert.equal(harness.getStatusUpdates(), 0, "background consolidation stays silent");
  assert.equal(
    graph.vectorIndexState.dirtyReason,
    "background-consolidation-vector-sync-queued",
  );
  const rolledBack = structuredClone(graph);
  rollbackBatch(rolledBack, harness.laterJournal);
  rollbackBatch(rolledBack, journal);
  assert.equal(
    rolledBack.nodes.find((node) => node.id === harness.targetNode.id)?.fields.summary,
    "before",
  );
  assert.equal(
    rolledBack.nodes.some((node) => node.id === harness.sourceNode.id),
    false,
  );
}

{
  const harness = createConsolidationHarness({ conflict: true });
  harness.releaseExtraction();
  const result = await harness.run();
  assert.equal(result.skipped, true);
  assert.match(result.reason, /background-consolidation-conflict/);
  const graph = harness.getCurrentGraph();
  assert.equal(
    graph.nodes.find((node) => node.id === harness.targetNode.id).fields.summary,
    "changed-by-new-extraction",
  );
  assert.equal(graph.nodes.find((node) => node.id === harness.sourceNode.id).archived, false);
  assert.equal(harness.getSaved(), 0);
  assert.equal(harness.getVectorSchedules(), 0);
}

console.log("post-process-controller tests passed");
