import assert from "node:assert/strict";
import { addEdge, addNode, createEdge, createEmptyGraph, createNode } from "../graph/graph.js";
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

const {
  findSimilarNodesByText,
  isAuthorityVectorConfig,
  normalizeAuthorityVectorConfig,
  syncGraphVectorIndex,
} = await import("../vector/vector-index.js");

function createAuthorityVectorGraph() {
  const graph = createEmptyGraph();
  graph.historyState.chatId = "chat-authority-vector";
  const first = createNode({
    type: "event",
    fields: { summary: "Alice finds the silver key" },
    seq: 1,
  });
  first.id = "node-a";
  first.embedding = [0.1, 0.2];
  const second = createNode({
    type: "event",
    fields: { summary: "Bob guards the archive door" },
    seq: 2,
  });
  second.id = "node-b";
  second.embedding = [0.2, 0.3];
  addNode(graph, first);
  addNode(graph, second);
  addEdge(
    graph,
    createEdge({
      fromId: first.id,
      toId: second.id,
      relation: "related",
      strength: 0.75,
    }),
  );
  return { graph, first, second };
}

function createMockTriviumClient({ failBulkUpsert = false } = {}) {
  const calls = [];
  return {
    calls,
    async purge(payload) {
      calls.push(["purge", payload]);
      return { ok: true };
    },
    async bulkUpsert(payload) {
      calls.push(["bulkUpsert", payload]);
      if (failBulkUpsert) {
        throw new Error("trivium-down");
      }
      return { ok: true, upserted: payload.items?.length || 0 };
    },
    async deleteMany(payload) {
      calls.push(["deleteMany", payload]);
      return { ok: true };
    },
    async linkMany(payload) {
      calls.push(["linkMany", payload]);
      return { ok: true, linked: payload.links?.length || 0 };
    },
    async search(payload) {
      calls.push(["search", payload]);
      return {
        results: [
          { nodeId: "node-b", score: 0.91 },
          { nodeId: "node-outside", score: 0.88 },
        ],
      };
    },
    async stat(payload) {
      calls.push(["stat", payload]);
      return { ok: true };
    },
  };
}

const config = normalizeAuthorityVectorConfig({
  authorityBaseUrl: "/api/plugins/authority",
  authorityVectorSyncChunkSize: 1,
  authorityVectorFailOpen: true,
});
assert.equal(isAuthorityVectorConfig(config), true);

{
  const { graph, first, second } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const result = await syncGraphVectorIndex(graph, config, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  assert.equal(graph.vectorIndexState.mode, "authority");
  assert.equal(graph.vectorIndexState.source, "authority-trivium");
  assert.equal(graph.vectorIndexState.dirty, false);
  assert.equal(graph.vectorIndexState.lastWarning, "");
  assert.equal(result.insertedHashes.length, 2);
  assert.equal(result.stats.indexed, 2);
  assert.equal(result.stats.pending, 0);
  assert.equal(first.embedding, null);
  assert.equal(second.embedding, null);
  assert.equal(triviumClient.calls.filter(([name]) => name === "purge").length, 1);
  const upserts = triviumClient.calls.filter(([name]) => name === "bulkUpsert");
  assert.equal(upserts.length, 2);
  assert.deepEqual(
    upserts.flatMap(([, payload]) => payload.items.map((item) => item.nodeId)).sort(),
    ["node-a", "node-b"],
  );
  const linkCall = triviumClient.calls.find(([name]) => name === "linkMany");
  assert.equal(linkCall?.[1]?.links?.[0]?.fromId, "node-a");
  assert.equal(linkCall?.[1]?.links?.[0]?.toId, "node-b");
}

{
  const { graph, first, second } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const queryConfig = { ...config, triviumClient };
  await syncGraphVectorIndex(graph, queryConfig, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  const results = await findSimilarNodesByText(
    graph,
    "archive door",
    queryConfig,
    5,
    [first, second],
  );

  assert.deepEqual(results, [{ nodeId: "node-b", score: 0.91 }]);
  const searchCall = triviumClient.calls.find(([name]) => name === "search");
  assert.deepEqual(searchCall?.[1]?.candidateIds.sort(), ["node-a", "node-b"]);
  assert.equal(graph.vectorIndexState.lastSearchTimings.mode, "authority");
  assert.equal(graph.vectorIndexState.lastSearchTimings.success, true);
}

{
  const { graph } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient({ failBulkUpsert: true });
  const result = await syncGraphVectorIndex(graph, config, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  assert.match(result.error, /trivium-down/);
  assert.equal(graph.vectorIndexState.mode, "authority");
  assert.equal(graph.vectorIndexState.dirty, true);
  assert.equal(graph.vectorIndexState.dirtyReason, "authority-trivium-sync-failed");
  assert.match(graph.vectorIndexState.lastWarning, /Authority Trivium 同步失败/);
}

console.log("authority-vector-primary tests passed");
