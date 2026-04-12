import assert from "node:assert/strict";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = {};",
  "export function getContext() {",
  "  return {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: {},",
  "    characterId: null,",
  "    name1: '玩家',",
  "    name2: '艾琳',",
  "    chatId: 'test-chat',",
  "  };",
  "}",
].join("\n");

const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return {};",
  "}",
  "export function substituteParamsExtended(value) {",
  "  return String(value ?? '');",
  "}",
].join("\n");

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: toDataModuleUrl(scriptShimSource),
  },
]);

const { addEdge, addNode, createEdge, createEmptyGraph, createNode } = await import(
  "../graph/graph.js"
);
const { rankNodesForTaskContext } = await import("../retrieval/shared-ranking.js");

function setTestOverrides(overrides = {}) {
  globalThis.__stBmeTestOverrides = overrides;
  return () => {
    delete globalThis.__stBmeTestOverrides;
  };
}

const graph = createEmptyGraph();
const confession = addNode(
  graph,
  createNode({
    type: "event",
    seq: 10,
    importance: 8,
    fields: {
      title: "中文告白",
      summary: "她认真地说喜欢你，并要求你再说一遍。",
    },
  }),
);
const dateEvent = addNode(
  graph,
  createNode({
    type: "event",
    seq: 11,
    importance: 4,
    fields: {
      title: "节日约会",
      summary: "她们一起逛街吃饭。",
    },
  }),
);
const relationship = addNode(
  graph,
  createNode({
    type: "thread",
    seq: 12,
    importance: 7,
    fields: {
      title: "感情升温",
      summary: "两人的恋爱关系快速升温。",
    },
  }),
);
confession.embedding = [1, 0.3, 0.1];
dateEvent.embedding = [0.2, 0.9, 0.1];
relationship.embedding = [0.8, 0.6, 0.2];
addEdge(
  graph,
  createEdge({
    fromId: confession.id,
    toId: relationship.id,
    relation: "supports",
    strength: 0.9,
  }),
);

const graphBefore = JSON.stringify(graph);
const restore = setTestOverrides({
  embedding: {
    async embedText() {
      return [1, 0.5, 0.25];
    },
    searchSimilar(_queryVec, candidates) {
      assert.ok(candidates.some((item) => item.nodeId === confession.id));
      return [
        { nodeId: confession.id, score: 0.97 },
        { nodeId: dateEvent.id, score: 0.23 },
      ];
    },
  },
});

try {
  const config = {
    mode: "direct",
    source: "direct",
    apiUrl: "https://example.com/v1",
    apiKey: "",
    model: "test-embedding",
  };
  const first = await rankNodesForTaskContext({
    graph,
    userMessage: "[user]: 中文告白后的关系进展",
    embeddingConfig: config,
    options: {
      enableContextQueryBlend: false,
      topK: 8,
      diffusionTopK: 16,
    },
  });
  const second = await rankNodesForTaskContext({
    graph,
    userMessage: "[user]: 中文告白后的关系进展",
    embeddingConfig: config,
    options: {
      enableContextQueryBlend: false,
      topK: 8,
      diffusionTopK: 16,
    },
  });

  assert.equal(JSON.stringify(graph), graphBefore, "shared ranking should be side-effect-free");
  assert.equal(first.scoredNodes[0]?.nodeId, confession.id);
  assert.equal(second.scoredNodes[0]?.nodeId, confession.id);
  assert.deepEqual(
    first.scoredNodes.map((item) => item.nodeId),
    second.scoredNodes.map((item) => item.nodeId),
    "ranking order should stay deterministic under fixed inputs",
  );
  const propagated = first.scoredNodes.find((item) => item.nodeId === relationship.id);
  assert.ok(propagated, "diffusion should surface connected relationship node");
  assert.ok((Number(propagated?.graphScore) || 0) > 0, "connected node should receive graph diffusion score");
  assert.equal(first.diagnostics.vectorMergedHits, 2);
  assert.ok(first.diagnostics.diffusionHits >= 1);
} finally {
  restore();
}

console.log("shared-ranking tests passed");
