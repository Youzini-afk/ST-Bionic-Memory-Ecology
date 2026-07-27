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

console.log("post-process-controller tests passed");
