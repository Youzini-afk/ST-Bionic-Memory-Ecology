import assert from "node:assert/strict";
import { addNode, createEmptyGraph, createNode } from "../graph/graph.js";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

installResolveHooks([
  {
    specifiers: ["../../../../../script.js"],
    url: toDataModuleUrl("export function getRequestHeaders() { return {}; }"),
  },
  {
    specifiers: ["../../../../extensions.js"],
    url: toDataModuleUrl("export const extension_settings = { st_bme: {} };"),
  },
]);

let embeddingDim = 3;
let embeddingFailureIndexes = new Set();
globalThis.__stBmeTestOverrides = {
  embedding: {
    async embedBatch(texts = []) {
      return texts.map((text, index) =>
        embeddingFailureIndexes.has(index)
          ? null
          : Array.from({ length: embeddingDim }, (_, dimIndex) =>
              dimIndex === 0 ? 1 : (index + dimIndex + String(text || "").length) / 100,
            ),
      );
    },
    async embedText(text = "") {
      return Array.from({ length: embeddingDim }, (_, dimIndex) =>
        dimIndex === 0 ? 1 : (dimIndex + String(text || "").length) / 100,
      );
    },
  },
};

const {
  findSimilarNodesByText,
  getVectorModelScope,
  syncGraphVectorIndex,
} = await import("../vector/vector-index.js");

function createVectorGraph() {
  const graph = createEmptyGraph();
  graph.historyState.chatId = "chat-vector-manifest";
  const node = createNode({
    type: "event",
    fields: { summary: "Alice finds the old compass" },
    seq: 1,
  });
  node.id = "node-a";
  addNode(graph, node);
  return graph;
}

const baseConfig = {
  mode: "direct",
  apiUrl: "https://example.com/v1/embeddings",
  apiKey: "sk-hidden",
  model: "text-embedding-3-small",
};

{
  const graph = createVectorGraph();
  embeddingDim = 3;
  await syncGraphVectorIndex(graph, baseConfig, { chatId: graph.historyState.chatId, force: true });
  assert.equal(graph.vectorIndexState.manifest.status, "clean");
  assert.equal(graph.vectorIndexState.manifest.observedDim, 3);
  assert.equal(graph.vectorIndexState.manifest.model, "text-embedding-3-small");
  assert.equal(graph.vectorIndexState.manifest.vectorSpaceId.startsWith("vs_"), true);
  assert.equal(JSON.stringify(graph.vectorIndexState.manifest).includes("sk-hidden"), false);
}

{
  const graph = createVectorGraph();
  embeddingDim = 3;
  await syncGraphVectorIndex(graph, baseConfig, { chatId: graph.historyState.chatId, force: true });
  const oldSpaceId = graph.vectorIndexState.manifest.vectorSpaceId;
  const changedModelConfig = { ...baseConfig, model: "text-embedding-3-large" };
  const results = await findSimilarNodesByText(graph, "compass", changedModelConfig, 5);
  assert.deepEqual(results, []);
  assert.equal(graph.vectorIndexState.dirty, true);
  assert.equal(graph.vectorIndexState.dirtyReason, "vector-space-mismatch");
  assert.equal(graph.vectorIndexState.manifest.vectorSpaceId, oldSpaceId);
  assert.notEqual(getVectorModelScope(baseConfig), getVectorModelScope(changedModelConfig));
  assert.equal(graph.vectorIndexState.lastSearchTimings.reason, "vector-space-mismatch");
}

{
  const graph = createVectorGraph();
  embeddingDim = 3;
  await syncGraphVectorIndex(graph, baseConfig, { chatId: graph.historyState.chatId, force: true });
  embeddingDim = 4;
  const results = await findSimilarNodesByText(graph, "compass", baseConfig, 5);
  assert.deepEqual(results, []);
  assert.equal(graph.vectorIndexState.dirty, true);
  assert.equal(graph.vectorIndexState.dirtyReason, "query-dimension-mismatch");
  assert.equal(graph.vectorIndexState.manifest.status, "stale");
  assert.equal(graph.vectorIndexState.lastSearchTimings.reason, "query-dimension-mismatch");
}

{
  const graph = createVectorGraph();
  graph.nodes[0].embedding = [0.1, 0.2, 0.3];
  embeddingDim = 3;
  embeddingFailureIndexes = new Set();
  const changedModelConfig = { ...baseConfig, model: "text-embedding-3-large" };
  await syncGraphVectorIndex(graph, changedModelConfig, { chatId: graph.historyState.chatId });
  assert.equal(graph.vectorIndexState.manifest.status, "clean");
  assert.equal(graph.vectorIndexState.manifest.model, "text-embedding-3-large");
  assert.equal(graph.nodes[0].embedding.length, 3);
  assert.equal(graph.nodes[0].embedding[0], 1);
  assert.notDeepEqual(graph.nodes[0].embedding, [0.1, 0.2, 0.3]);
}

{
  const graph = createVectorGraph();
  graph.nodes[0].embedding = [0.1, 0.2, 0.3];
  graph.vectorIndexState.mode = "direct";
  graph.vectorIndexState.modelScope = getVectorModelScope(baseConfig);
  graph.vectorIndexState.collectionId = "st-bme-vector-chat-vector-manifest";
  graph.vectorIndexState.manifest = {
    status: "clean",
    vectorSpaceId: "old-space",
    observedDim: 3,
    model: baseConfig.model,
  };
  embeddingDim = 4;
  embeddingFailureIndexes = new Set([0]);
  const changedModelConfig = { ...baseConfig, model: "text-embedding-3-large" };
  await syncGraphVectorIndex(graph, changedModelConfig, { chatId: graph.historyState.chatId });
  assert.equal(graph.nodes[0].embedding, null);
  assert.equal(graph.vectorIndexState.dirty, true);
  assert.equal(graph.vectorIndexState.dirtyReason, "partial-embedding-failure");
  assert.equal(graph.vectorIndexState.lastStats.indexed, 0);

  embeddingFailureIndexes = new Set([0]);
  await syncGraphVectorIndex(graph, changedModelConfig, { chatId: graph.historyState.chatId });
  assert.equal(
    graph.vectorIndexState.lastStats.indexed,
    0,
    "模型变化后的旧 embedding 不应在后续非 force 同步中被重新登记",
  );
  assert.equal(graph.nodes[0].embedding, null);
}

{
  const graph = createVectorGraph();
  graph.nodes[0].embedding = [0.1, 0.2, 0.3];
  graph.vectorIndexState.mode = "direct";
  graph.vectorIndexState.source = "direct";
  graph.vectorIndexState.modelScope = getVectorModelScope(baseConfig);
  graph.vectorIndexState.collectionId = "st-bme-vector-chat-vector-manifest";
  graph.vectorIndexState.hashToNodeId = { oldHash: "node-a" };
  graph.vectorIndexState.nodeToHash = { "node-a": "oldHash" };
  graph.vectorIndexState.manifest = {
    status: "clean",
    vectorSpaceId: "old-space",
    observedDim: 3,
    model: baseConfig.model,
  };
  embeddingDim = 4;
  embeddingFailureIndexes = new Set([0]);
  await syncGraphVectorIndex(graph, baseConfig, {
    chatId: graph.historyState.chatId,
    force: true,
  });
  assert.equal(graph.nodes[0].embedding, null);
  assert.deepEqual(graph.vectorIndexState.nodeToHash, {});
  assert.deepEqual(graph.vectorIndexState.hashToNodeId, {});
  assert.equal(graph.vectorIndexState.lastStats.indexed, 0);
  assert.equal(graph.vectorIndexState.lastStats.pending, 1);
}

console.log("vector-manifest tests passed");
