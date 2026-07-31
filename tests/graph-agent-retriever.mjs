import assert from "node:assert/strict";

import { createEmptyGraph } from "../graph/graph.js";
import { DEFAULT_NODE_SCHEMA } from "../graph/schema.js";
import { retrieveWithGraphAgent } from "../retrieval/graph-agent-retriever.js";

function node(id, seq, state) {
  return {
    id,
    type: "character",
    level: 0,
    parentId: null,
    childIds: [],
    seq,
    seqRange: [seq, seq],
    sourceFloor: seq,
    archived: false,
    fields: { name: id, state },
    embedding: null,
    importance: 6,
    accessCount: 0,
    updatedAt: seq,
    lastAccessTime: seq,
    createdTime: seq,
    prevId: null,
    nextId: null,
    clusters: [],
    scope: { layer: "objective" },
    memoryLayer: "objective",
    memoryConfidence: 1,
  };
}

const graph = createEmptyGraph();
graph.historyState.chatId = "chat:graph-agent";
graph.nodes = [
  node("memory:baseline", 2, "waited outside"),
  node("memory:deeper", 8, "found the archive key"),
];
const baseSettings = {
  agentContextWindowTokens: 128000,
  agentMaxToolCalls: 500,
  agentMaxRunMs: 480000,
};

const retrieveFn = async ({ graph: sourceGraph }) => ({
  selectedNodeIds: ["memory:baseline"],
  stats: { recallCount: 1 },
  meta: {
    retrieval: { source: "programmatic-test" },
    scopeContext: { graph: sourceGraph, enableScopedMemory: false },
  },
});
const resultBuilder = ({ graph: sourceGraph, selectedNodeIds, meta }) => {
  const recallNodes = sourceGraph.nodes.filter(
    (entry) =>
      selectedNodeIds.includes(entry.id) && entry.id !== "memory:private",
  );
  return {
    coreNodes: [],
    recallNodes,
    summaryEntries: [],
    scopeBuckets: {
      characterPov: [],
      userPov: [],
      objectiveCurrentRegion: [],
      objectiveGlobal: recallNodes,
    },
    selectedNodeIds: recallNodes.map((entry) => entry.id),
    meta,
    stats: {
      coreCount: 0,
      recallCount: recallNodes.length,
      totalActive: sourceGraph.nodes.length,
    },
  };
};

let modelCall = 0;
const selected = await retrieveWithGraphAgent({
  graph,
  userMessage: "Where is the archive key?",
  recentMessages: ["They entered the archive."],
  schema: DEFAULT_NODE_SCHEMA,
  settings: {
    agentContextWindowTokens: 128000,
    agentMaxToolCalls: 500,
    agentMaxRunMs: 480000,
  },
  options: { chatId: "chat:graph-agent", turnId: "turn:8" },
  retrieveFn,
  resultBuilder,
  countTokens: () => 100,
  model: async () => {
    modelCall += 1;
    if (modelCall === 1) {
      return {
        content: "",
        toolCalls: [{ id: "context", name: "recall_context", arguments: "{}" }],
      };
    }
    if (modelCall === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "search",
            name: "recall_search",
            arguments: JSON.stringify({ query: "archive key", limit: 10 }),
          },
        ],
      };
    }
    if (modelCall === 3) {
      return {
        content: "",
        toolCalls: [
          {
            id: "publish",
            name: "recall_publish",
            arguments: JSON.stringify({
              selectedMemoryIds: ["memory:deeper"],
              reason: "Directly answers the turn",
            }),
          },
        ],
      };
    }
    return { content: "published", toolCalls: [] };
  },
});

assert.deepEqual(selected.selectedNodeIds, ["memory:deeper"]);
assert.equal(selected.meta.retrieval.llm.status, "llm");
assert.equal(
  selected.meta.retrieval.llm.selectionProtocol,
  "graph-agent-tool-selection",
);
assert.equal(selected.meta.retrieval.agent.toolCallCount, 3);

const fallback = await retrieveWithGraphAgent({
  graph,
  userMessage: "Where is the archive key?",
  schema: DEFAULT_NODE_SCHEMA,
  settings: {
    agentContextWindowTokens: 128000,
    agentMaxToolCalls: 500,
    agentMaxRunMs: 480000,
  },
  options: { chatId: "chat:graph-agent", turnId: "turn:fallback" },
  retrieveFn,
  resultBuilder,
  countTokens: () => 100,
  model: async () => {
    throw new Error("provider unavailable");
  },
});

assert.deepEqual(fallback.selectedNodeIds, ["memory:baseline"]);
assert.equal(fallback.meta.retrieval.llm.status, "fallback");
assert.match(fallback.meta.retrieval.llm.reason, /程序召回/);

graph.nodes.push(node("memory:private", 9, "must remain outside this POV"));
let guardedModelCall = 0;
const guarded = await retrieveWithGraphAgent({
  graph,
  userMessage: "Read the private memory.",
  schema: DEFAULT_NODE_SCHEMA,
  settings: {
    agentContextWindowTokens: 128000,
    agentMaxToolCalls: 500,
    agentMaxRunMs: 480000,
  },
  options: { chatId: "chat:graph-agent", turnId: "turn:scope-guard" },
  retrieveFn,
  resultBuilder,
  countTokens: () => 100,
  model: async () => {
    guardedModelCall += 1;
    if (guardedModelCall === 1) {
      return {
        content: "",
        toolCalls: [
          {
            id: "private",
            name: "recall_publish",
            arguments: JSON.stringify({
              selectedMemoryIds: ["memory:private"],
              reason: "Attempt an out-of-scope selection",
            }),
          },
        ],
      };
    }
    if (guardedModelCall === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "safe",
            name: "recall_publish",
            arguments: JSON.stringify({
              selectedMemoryIds: ["memory:baseline"],
              reason: "Use an injectable memory instead",
            }),
          },
        ],
      };
    }
    return { content: "published", toolCalls: [] };
  },
});
assert.deepEqual(guarded.selectedNodeIds, ["memory:baseline"]);
assert.equal(guarded.meta.retrieval.agent.toolCallCount, 2);

let snapshotModelCall = 0;
const snapshotIsolated = await retrieveWithGraphAgent({
  graph,
  userMessage: "Use only memory available when recall begins.",
  schema: DEFAULT_NODE_SCHEMA,
  settings: baseSettings,
  options: { chatId: "chat:graph-agent", turnId: "turn:frozen-graph" },
  retrieveFn,
  resultBuilder,
  countTokens: () => 100,
  model: async () => {
    snapshotModelCall += 1;
    if (snapshotModelCall === 1) {
      graph.nodes.push(node("memory:late", 10, "landed during recall"));
      return {
        content: "",
        toolCalls: [
          {
            id: "late",
            name: "recall_publish",
            arguments: JSON.stringify({
              selectedMemoryIds: ["memory:late"],
              reason: "Try a memory committed after the frozen snapshot",
            }),
          },
        ],
      };
    }
    if (snapshotModelCall === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "snapshot-baseline",
            name: "recall_publish",
            arguments: JSON.stringify({
              selectedMemoryIds: ["memory:baseline"],
              reason: "Use the frozen snapshot",
            }),
          },
        ],
      };
    }
    return { content: "published", toolCalls: [] };
  },
});
assert.deepEqual(snapshotIsolated.selectedNodeIds, ["memory:baseline"]);

const explicitEmpty = await retrieveWithGraphAgent({
  graph,
  userMessage: "This turn does not need memory.",
  schema: DEFAULT_NODE_SCHEMA,
  settings: baseSettings,
  options: { chatId: "chat:graph-agent", turnId: "turn:empty-selection" },
  retrieveFn,
  resultBuilder,
  countTokens: () => 100,
  model: async () => ({
    content: "",
    toolCalls: [
      {
        id: "publish-empty",
        name: "recall_publish",
        arguments: JSON.stringify({
          selectedMemoryIds: [],
          reason: "No memory is relevant to this turn",
        }),
      },
    ],
  }),
});
assert.deepEqual(explicitEmpty.selectedNodeIds, []);
assert.equal(explicitEmpty.meta.retrieval.llm.status, "llm");

const empty = await retrieveWithGraphAgent({
  graph: createEmptyGraph(),
  userMessage: "Nothing has happened yet.",
  schema: DEFAULT_NODE_SCHEMA,
  settings: baseSettings,
  options: { chatId: "chat:empty", turnId: "turn:empty" },
  retrieveFn: async () => ({
    selectedNodeIds: [],
    stats: {},
    meta: { retrieval: {}, scopeContext: {} },
  }),
  resultBuilder,
  countTokens: () => 100,
  model: async () => {
    throw new Error("empty recall must not invoke the model");
  },
});
assert.deepEqual(empty.selectedNodeIds, []);

console.log("graph Agent retriever tests passed");
