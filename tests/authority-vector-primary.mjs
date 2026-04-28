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

globalThis.__stBmeTestOverrides = {
  embedding: {
    async embedBatch(texts = []) {
      return texts.map((text, index) => [1, index / 10, String(text || "").length / 100]);
    },
    async embedText(text = "") {
      return [1, 0.5, String(text || "").length / 100];
    },
  },
};

const {
  filterAuthorityTriviumNodes,
  isAuthorityVectorConfig,
  normalizeAuthorityVectorConfig,
  queryAuthorityTriviumNeighbors,
} = await import("../vector/authority-vector-primary-adapter.js");
const { findSimilarNodesByText: findSimilarNodesByTextFromIndex, syncGraphVectorIndex: syncGraphVectorIndexFromIndex } = await import("../vector/vector-index.js");

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
      return {
        ok: true,
        diagnostics: {
          operation: "purge",
          pageSize: payload.purgePageSize || 200,
          maxPages: payload.purgeMaxPages || 1000,
          pages: 1,
          scanned: 0,
          deleted: 0,
          truncated: false,
        },
      };
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
    async filterWhere(payload) {
      calls.push(["filterWhere", payload]);
      return {
        items: [
          { externalId: "node-a" },
          { payload: { nodeId: "node-b" } },
        ],
      };
    },
    async neighbors(payload) {
      calls.push(["neighbors", payload]);
      return {
        neighbors: [
          { fromId: "node-a", toId: "node-b" },
          { fromId: "node-a", toId: "node-c" },
        ],
      };
    },
    async stat(payload) {
      calls.push(["stat", payload]);
      return { ok: true };
    },
  };
}

async function withMockFetch(handler, fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

const config = normalizeAuthorityVectorConfig({
  authorityBaseUrl: "/api/plugins/authority",
  authorityEmbeddingApiUrl: "https://example.com/v1",
  authorityEmbeddingModel: "test-embedding",
  authorityVectorSyncChunkSize: 1,
  authorityVectorFailOpen: true,
});
assert.equal(isAuthorityVectorConfig(config), true);

{
  const { graph, first, second } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const result = await syncGraphVectorIndexFromIndex(graph, config, {
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
  assert.equal(
    upserts.every(([, payload]) => payload.items.every((item) => Array.isArray(item.vector) && item.vector.length > 0)),
    true,
  );
  const linkCall = triviumClient.calls.find(([name]) => name === "linkMany");
  assert.equal(linkCall?.[1]?.links?.[0]?.fromId, "node-a");
  assert.equal(linkCall?.[1]?.links?.[0]?.toId, "node-b");
  assert.equal(result.timings.authorityDiagnostics.purge.operation, "purge");
  assert.equal(result.timings.authorityDiagnostics.upsert.operation, "bulkUpsert");
  assert.equal(result.timings.authorityDiagnostics.upsert.chunks.length, 2);
  assert.equal(result.timings.authorityDiagnostics.upsert.chunks.every((chunk) => chunk.ok), true);
  assert.ok(result.timings.authorityDiagnostics.upsert.totalBytes > 0);
  assert.equal(result.timings.authorityDiagnostics.link.operation, "linkMany");
  assert.equal(result.timings.authorityDiagnostics.link.totalItems, 1);
}

{
  const { graph, first, second } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const queryConfig = { ...config, triviumClient };
  await syncGraphVectorIndexFromIndex(graph, queryConfig, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  const results = await findSimilarNodesByTextFromIndex(
    graph,
    "archive door",
    queryConfig,
    5,
    [first, second],
  );

  assert.deepEqual(results, [{ nodeId: "node-b", score: 0.91 }]);
  const searchCall = triviumClient.calls.find(([name]) => name === "search");
  assert.deepEqual(searchCall?.[1]?.candidateIds.sort(), ["node-a", "node-b"]);
  assert.equal(Array.isArray(searchCall?.[1]?.queryVector), true);
  assert.ok(searchCall?.[1]?.queryVector.length > 0);
  assert.equal(graph.vectorIndexState.lastSearchTimings.mode, "authority");
  assert.equal(graph.vectorIndexState.lastSearchTimings.success, true);
}

{
  const { graph } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient({ failBulkUpsert: true });
  const result = await syncGraphVectorIndexFromIndex(graph, config, {
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

{
  const triviumClient = createMockTriviumClient();
  const queryConfig = { ...config, triviumClient };
  const filteredIds = await filterAuthorityTriviumNodes(queryConfig, {
    collectionId: "authority-filter",
    chatId: "chat-authority-vector",
    limit: 8,
    filters: {
      archived: false,
      ownerKeys: ["character:Alice"],
    },
    candidateIds: ["node-a"],
    searchText: "Alice archive",
  });
  assert.deepEqual(filteredIds, ["node-a", "node-b"]);
  const filterCall = triviumClient.calls.find(([name]) => name === "filterWhere");
  assert.equal(filterCall?.[1]?.collectionId, "authority-filter");
  assert.equal(filterCall?.[1]?.filters?.ownerKeys?.[0], "character:Alice");
  assert.deepEqual(filterCall?.[1]?.candidateIds, ["node-a"]);
  assert.equal(filterCall?.[1]?.searchText, "Alice archive");
}

{
  const triviumClient = createMockTriviumClient();
  const queryConfig = { ...config, triviumClient };
  const neighborIds = await queryAuthorityTriviumNeighbors(queryConfig, ["node-a"], {
    collectionId: "authority-filter",
    chatId: "chat-authority-vector",
    limit: 4,
  });
  assert.deepEqual(neighborIds, ["node-b", "node-c"]);
  const neighborCall = triviumClient.calls.find(([name]) => name === "neighbors");
  assert.deepEqual(neighborCall?.[1]?.nodeIds, ["node-a"]);
}

{
  const previousOverrides = globalThis.__stBmeTestOverrides;
  globalThis.__stBmeTestOverrides = {};
  const fetchCalls = [];
  try {
    await withMockFetch(async (url, options = {}) => {
      fetchCalls.push([url, JSON.parse(String(options.body || "{}"))]);
      return {
        ok: true,
        status: 200,
        async json() {
          const body = JSON.parse(String(options.body || "{}"));
          if (Array.isArray(body.texts)) {
            return {
              vectors: body.texts.map((text, index) => [1, index + 1, String(text || "").length / 100]),
            };
          }
          return {
            vector: [1, 9, String(body.text || "").length / 100],
          };
        },
        async text() {
          return "";
        },
      };
    }, async () => {
      const backendConfig = normalizeAuthorityVectorConfig({
        authorityBaseUrl: "/api/plugins/authority",
        embeddingTransportMode: "backend",
        embeddingBackendSource: "openai",
        embeddingBackendModel: "text-embedding-3-small",
        authorityVectorSyncChunkSize: 2,
      });
      const { graph, first, second } = createAuthorityVectorGraph();
      first.embedding = null;
      second.embedding = null;
      const triviumClient = createMockTriviumClient();
      await syncGraphVectorIndexFromIndex(graph, backendConfig, {
        chatId: "chat-authority-vector",
        purge: true,
        triviumClient,
      });
      const results = await findSimilarNodesByTextFromIndex(
        graph,
        "archive door",
        { ...backendConfig, triviumClient },
        5,
        [first, second],
      );
      assert.deepEqual(results, [{ nodeId: "node-b", score: 0.91 }]);
      const upsertCall = triviumClient.calls.find(([name]) => name === "bulkUpsert");
      assert.equal(
        upsertCall?.[1]?.items?.every((item) => Array.isArray(item.vector) && item.vector.length > 0),
        true,
      );
      const searchCall = triviumClient.calls.find(([name]) => name === "search");
      assert.equal(Array.isArray(searchCall?.[1]?.queryVector), true);
      assert.equal(fetchCalls.every(([url]) => url === "/api/vector/embed"), true);
      assert.equal(fetchCalls[0]?.[1]?.source, "openai");
      assert.equal(fetchCalls[0]?.[1]?.model, "text-embedding-3-small");
      assert.equal(Array.isArray(fetchCalls[0]?.[1]?.texts), true);
      assert.equal(fetchCalls[fetchCalls.length - 1]?.[1]?.isQuery, true);
    });
  } finally {
    globalThis.__stBmeTestOverrides = previousOverrides;
  }
}

console.log("authority-vector-primary tests passed");
