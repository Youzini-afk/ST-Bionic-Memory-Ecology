import assert from "node:assert/strict";
import { addEdge, addNode, createEdge, createEmptyGraph, createNode } from "../graph/graph.js";
import { AuthorityHttpError } from "../runtime/authority-http-client.js";
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
  searchAuthorityTriviumNodes,
  applyAuthorityBmeVectorManifest,
} = await import("../vector/authority-vector-primary-adapter.js");
const {
  findSimilarNodesByText: findSimilarNodesByTextFromIndex,
  syncGraphVectorIndex: syncGraphVectorIndexFromIndex,
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

function createMockTriviumClient({
  failBulkUpsert = false,
  failSearch = false,
  failBmeVectorApply = false,
  failBmeVectorApplyCompatibility = false,
  failBmeVectorManifest = false,
} = {}) {
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
        throw new AuthorityHttpError("trivium-down", {
          status: 503,
          category: "server",
          path: "/trivium/bulk-upsert",
        });
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
      if (failSearch) {
        throw new AuthorityHttpError("trivium search denied", {
          status: 403,
          category: "permission",
          path: "/trivium/search",
        });
      }
      return {
        results: [
          { nodeId: "node-a", namespace: "other-chat", score: 0.95 },
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
    async bmeVectorApply(payload) {
      calls.push(["bmeVectorApply", payload]);
      if (failBmeVectorApply) {
        throw new AuthorityHttpError("bme apply missing", {
          status: 404,
          category: "validation",
          path: "/bme/vector-apply",
        });
      }
      if (failBmeVectorApplyCompatibility) {
        throw new AuthorityHttpError("BME vector apply dimension mismatch", {
          status: 400,
          category: "validation",
          payload: { details: { category: "vector-dimension-mismatch" } },
          path: "/bme/vector-apply",
        });
      }
      const itemWithTopLevelId = payload.items?.find((item) => item?.id !== undefined);
      if (itemWithTopLevelId) {
        throw new Error("bmeVectorApply items must not send top-level Trivium id");
      }
      return {
        ok: true,
        database: payload.database || "st_bme_vectors",
        manifest: { database: payload.database || "st_bme_vectors", exists: true },
        upsert: { successCount: payload.items?.length || 0, failureCount: 0 },
        links: { successCount: payload.links?.length || 0, failureCount: 0 },
      };
    },
    async bmeVectorManifest(payload) {
      calls.push(["bmeVectorManifest", payload]);
      if (failBmeVectorManifest) {
        throw new AuthorityHttpError("bme manifest missing", {
          status: 404,
          category: "validation",
          path: "/modules/third-party.st-bme/transactions/vector.manifest",
        });
      }
      return {
        ok: true,
        database: payload.database || "st_bme_vectors",
        manifest: {
          database: payload.database || "st_bme_vectors",
          exists: true,
          status: "ready",
          nodeCount: 42,
          edgeCount: 7,
          mappingCount: 42,
          indexCount: 3,
          orphanMappingCount: 0,
          lastFlushAt: null,
          updatedAt: "2024-01-01T00:00:00.000Z",
          collectionId: payload.collectionId || "",
          chatId: payload.chatId || "",
          modelScope: payload.modelScope || "",
          graphRevision: Number(payload.graphRevision) || 0,
          vectorSpaceId: payload.vectorSpaceId || "",
          observedDim: Number(payload.observedDim) || 0,
          indexHealth: null,
        },
      };
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
  const { graph } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const applyConfig = { ...config, bmeVectorApplyReady: true };
  const result = await syncGraphVectorIndexFromIndex(graph, applyConfig, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  assert.equal(result.stats.indexed, 2);
  assert.equal(graph.vectorIndexState.dirty, false);
  assert.equal(graph.vectorIndexState.manifest.status, "clean");
  assert.equal(graph.vectorIndexState.manifest.backend, "authority");
  assert.equal(graph.vectorIndexState.manifest.observedDim, 2);
  assert.equal(triviumClient.calls.filter(([name]) => name === "bmeVectorApply").length, 1);
  assert.equal(triviumClient.calls.some(([name]) => name === "purge"), false);
  assert.equal(triviumClient.calls.some(([name]) => name === "bulkUpsert"), false);
  const applyCall = triviumClient.calls.find(([name]) => name === "bmeVectorApply")?.[1];
  assert.equal(applyCall.items.length, 2);
  assert.equal(applyCall.links.length, 1);
  assert.deepEqual(applyCall.links[0].src, {
    externalId: "node-a",
    namespace: "st-bme::chat-authority-vector",
  });
  assert.deepEqual(applyCall.links[0].dst, {
    externalId: "node-b",
    namespace: "st-bme::chat-authority-vector",
  });
  assert.equal(applyCall.links[0].label, "related");
  assert.equal(applyCall.links[0].weight, 0.75);
  assert.equal(applyCall.observedDim, 2);
  assert.equal(String(applyCall.vectorSpaceId || "").startsWith("vs_"), true);
  assert.equal(applyCall.items.every((item) => item.payload?.vectorSpaceId === applyCall.vectorSpaceId), true);
  assert.equal(applyCall.items.every((item) => item.payload?.observedDim === 2), true);
  assert.equal(applyCall.items.every((item) => Array.isArray(item.vector) && item.vector.length > 0), true);
  assert.equal(applyCall.items[0].id, undefined);
  assert.equal(applyCall.items[0].externalId, "node-a");
  assert.equal(applyCall.items[0].nodeId, "node-a");
  assert.equal(applyCall.items[0].payload.nodeId, "node-a");
  assert.equal(applyCall.items[0].payload.externalId, "node-a");
  assert.equal(result.timings.authorityDiagnostics.upsert.operation, "bmeVectorApply");
}

{
  const { graph } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const entries = [
    { nodeId: "node-a", text: "a", hash: "hash-a", index: 0 },
    { nodeId: "node-b", text: "b", hash: "hash-b", index: 1 },
  ];
  graph.nodes[0].embedding = [1, 0, 0];
  graph.nodes[1].embedding = [1, 0];
  await assert.rejects(
    () => applyAuthorityBmeVectorManifest(graph, { ...config, bmeVectorApplyReady: true }, entries, {
      namespace: "st-bme::chat-authority-vector",
      collectionId: "st-bme::chat-authority-vector",
      chatId: "chat-authority-vector",
      modelScope: "scope",
      triviumClient,
    }),
    /single vector dimension/,
  );
  assert.equal(triviumClient.calls.some(([name]) => name === "bmeVectorApply"), false);
}

{
  const { graph } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient({ failBmeVectorApplyCompatibility: true });
  const applyConfig = { ...config, bmeVectorApplyReady: true };
  const result = await syncGraphVectorIndexFromIndex(graph, applyConfig, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  assert.equal(graph.vectorIndexState.dirty, true);
  assert.equal(result.errorCategory, "validation");
  assert.equal(triviumClient.calls.filter(([name]) => name === "bmeVectorApply").length, 1);
  assert.equal(triviumClient.calls.some(([name]) => name === "purge"), false);
  assert.equal(triviumClient.calls.some(([name]) => name === "bulkUpsert"), false);
}

{
  const { graph, first, second } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient();
  const applyConfig = { ...config, bmeVectorApplyReady: true };
  await syncGraphVectorIndexFromIndex(graph, applyConfig, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });
  const changedModelConfig = { ...applyConfig, model: "other-embedding-model" };
  const results = await findSimilarNodesByTextFromIndex(
    graph,
    "archive door",
    changedModelConfig,
    5,
    [first, second],
  );
  assert.deepEqual(results, []);
  assert.equal(graph.vectorIndexState.dirtyReason, "authority-vector-space-mismatch");
  assert.equal(graph.vectorIndexState.lastSearchTimings.reason, "authority-vector-space-mismatch");
}

{
  const { graph } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient({ failBmeVectorApply: true });
  const applyConfig = { ...config, bmeVectorApplyReady: true };
  const result = await syncGraphVectorIndexFromIndex(graph, applyConfig, {
    chatId: "chat-authority-vector",
    purge: true,
    triviumClient,
  });

  assert.equal(result.stats.indexed, 2);
  assert.equal(graph.vectorIndexState.dirty, false);
  assert.equal(triviumClient.calls.filter(([name]) => name === "bmeVectorApply").length, 1);
  assert.equal(triviumClient.calls.filter(([name]) => name === "purge").length, 1);
  assert.ok(triviumClient.calls.some(([name]) => name === "bulkUpsert"));
  assert.ok(triviumClient.calls.some(([name]) => name === "linkMany"));
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
  assert.equal(searchCall?.[1]?.namespace, "st-bme::chat-authority-vector");
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
  assert.equal(result.errorCategory, "server");
  assert.equal(result.errorDomain, "authority");
  assert.equal(result.timings.errorCategory, "server");
  assert.equal(result.timings.authorityErrorCategory, "server");
  assert.equal(graph.vectorIndexState.lastErrorCategory, "server");
  assert.equal(graph.vectorIndexState.lastErrorDomain, "authority");
  assert.equal(result.timings.authorityDiagnostics.upsert.errorCategory, "server");
  assert.equal(result.timings.authorityDiagnostics.upsert.chunks[0].errorCategory, "server");
  assert.match(graph.vectorIndexState.lastWarning, /Authority Trivium 同步失败/);
}

{
  const previousOverrides = globalThis.__stBmeTestOverrides;
  globalThis.__stBmeTestOverrides = {
    embedding: {
      async embedBatch(texts = []) {
        return texts.map(() => null);
      },
      async embedText() {
        return null;
      },
    },
  };
  try {
    const { graph } = createAuthorityVectorGraph();
    graph.nodes.forEach((node) => {
      node.embedding = null;
    });
    const triviumClient = createMockTriviumClient();
    const result = await syncGraphVectorIndexFromIndex(graph, config, {
      chatId: "chat-authority-vector",
      purge: true,
      triviumClient,
    });
    assert.match(result.error, /Embedding provider failed/);
    assert.doesNotMatch(result.error, /Authority Trivium embedding failed/);
    assert.equal(result.errorCategory, "embedding-provider");
    assert.equal(result.errorDomain, "embedding");
    assert.equal(graph.vectorIndexState.dirtyReason, "embedding-provider-sync-failed");
    assert.equal(graph.vectorIndexState.lastErrorCategory, "embedding-provider");
    assert.equal(graph.vectorIndexState.lastErrorDomain, "embedding");
    assert.match(graph.vectorIndexState.lastWarning, /Embedding provider 同步失败/);
    assert.equal(triviumClient.calls.some(([name]) => name === "bulkUpsert"), false);
  } finally {
    globalThis.__stBmeTestOverrides = previousOverrides;
  }
}

{
  const { graph } = createAuthorityVectorGraph();
  const fetchCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    fetchCalls.push({ url: String(url), body });
    if (String(url).endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionToken: "test-session" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { externalId: "node-a", namespace: "other-chat", score: 0.99 },
          { externalId: "node-b", namespace: "st-bme::chat-authority-vector", score: 0.93 },
          { externalId: "node-c", score: 0.72 },
        ],
      }),
    };
  };

  const results = await searchAuthorityTriviumNodes(graph, "archive door", config, {
    namespace: "st-bme::chat-authority-vector",
    collectionId: "st-bme::chat-authority-vector",
    chatId: "chat-authority-vector",
    queryVector: [1, 0, 0],
    topK: 5,
    fetchImpl,
  });
  const searchCall = fetchCalls.find((call) => call.url.endsWith("/trivium/search-hybrid"));
  assert.equal(searchCall?.body?.namespace, "st-bme::chat-authority-vector");
  assert.equal(searchCall?.body?.collectionId, "st-bme::chat-authority-vector");
  assert.equal(searchCall?.body?.chatId, "chat-authority-vector");
  assert.deepEqual(
    results.map((entry) => entry.nodeId),
    ["node-b", "node-c"],
  );
}

{
  const { graph, first, second } = createAuthorityVectorGraph();
  const triviumClient = createMockTriviumClient({ failSearch: true });
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
  assert.deepEqual(results, []);
  assert.equal(graph.vectorIndexState.lastSearchTimings.errorCategory, "permission");
  assert.equal(graph.vectorIndexState.lastSearchTimings.authorityErrorCategory, "permission");
  assert.equal(graph.vectorIndexState.lastErrorCategory, "permission");
  assert.equal(graph.vectorIndexState.lastErrorDomain, "authority");
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

// Phase C: bmeVectorApply posts to /modules/third-party.st-bme/transactions/vector.apply
// (not /bme/vector-apply) when using a real AuthorityHttpClient with mock fetch.
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-bme" }; },
      };
    }
    if (url.includes("/modules/third-party.st-bme/transactions/vector.apply")) {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            ok: true,
            moduleId: "third-party.st-bme",
            transaction: "vector.apply",
            result: {
              ok: true,
              database: body.input?.database || "st_bme_vectors",
              manifest: { database: body.input?.database || "st_bme_vectors", exists: true },
              upsert: { successCount: body.input?.items?.length || 0, failureCount: 0 },
              links: { successCount: body.input?.links?.length || 0, failureCount: 0 },
            },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { AuthorityHttpClient, AuthorityHttpError } = await import("../runtime/authority-http-client.js");
  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");

  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  const result = await client.bmeVectorApply({
    database: "st_bme_vectors",
    items: [{ externalId: "node-a", vector: [1, 2, 3], payload: { text: "hello" } }],
    links: [{ fromId: "node-a", toId: "node-b", label: "related" }],
    idempotencyKey: "test-key-1",
  });

  // Verify the URL is the module transaction route, NOT /bme/vector-apply.
  const modCall = fetchCalls.find((c) => c.url.includes("/modules/"));
  assert.ok(modCall, "should have called /modules/ route");
  assert.ok(modCall.url.includes("/modules/third-party.st-bme/transactions/vector.apply"));
  assert.ok(!fetchCalls.some((c) => c.url.includes("/bme/")), "should NOT call /bme/ route");

  // Verify idempotencyKey is on the envelope, not just inside input.
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, "test-key-1");

  // Verify the result is unwrapped from response.result.
  assert.equal(result.ok, true);
  assert.equal(result.upsert.successCount, 1);
  assert.equal(result.links.successCount, 1);
}

// Phase C: bmeVectorApply enriches module_not_loaded errors.
{
  const mockFetch = async (url) => {
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-err" }; },
      };
    }
    if (url.includes("/modules/")) {
      return {
        ok: false,
        status: 409,
        headers: { get: () => "application/json" },
        async json() {
          return {
            error: "Module not loaded: third-party.st-bme",
            code: "validation_error",
            category: "validation",
            details: { code: "module_not_loaded", moduleId: "third-party.st-bme", status: "available" },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  let caught = null;
  try {
    await client.bmeVectorApply({ items: [{ externalId: "a", vector: [1, 2, 3] }] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthorityHttpError);
  assert.ok(caught.message.includes("BME companion module"), "error should mention BME companion module");
  assert.ok(caught.message.includes("not loaded"), "error should say not loaded");
}

// Phase 1: bmeVectorManifest posts to /modules/third-party.st-bme/transactions/vector.manifest
// (not /bme/vector-manifest) when using a real AuthorityHttpClient with mock fetch.
// vector.manifest is NOT idempotency-required, so the envelope must NOT carry idempotencyKey.
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-bme-manifest" }; },
      };
    }
    if (url.includes("/modules/third-party.st-bme/transactions/vector.manifest")) {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            ok: true,
            moduleId: "third-party.st-bme",
            transaction: "vector.manifest",
            result: {
              ok: true,
              appliedAt: "2024-01-01T00:00:00.000Z",
              database: body.input?.database || "st_bme_vectors",
              manifest: {
                database: body.input?.database || "st_bme_vectors",
                exists: true,
                status: "ready",
                nodeCount: 42,
                edgeCount: 7,
                mappingCount: 42,
                indexCount: 3,
                orphanMappingCount: 0,
                lastFlushAt: null,
                updatedAt: "2024-01-01T00:00:00.000Z",
                collectionId: body.input?.collectionId || "",
                chatId: body.input?.chatId || "",
                modelScope: body.input?.modelScope || "",
                graphRevision: Number(body.input?.graphRevision) || 0,
                vectorSpaceId: body.input?.vectorSpaceId || "",
                observedDim: Number(body.input?.observedDim) || 0,
                indexHealth: null,
              },
            },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  const result = await client.bmeVectorManifest({
    database: "st_bme_vectors",
    collectionId: "col-1",
    chatId: "chat-1",
    modelScope: "gpt-4",
    graphRevision: 5,
    vectorSpaceId: "vs-1",
    observedDim: 3,
    includeMappingIntegrity: true,
  });

  // Verify the URL is the module transaction route, NOT /bme/vector-manifest.
  const modCall = fetchCalls.find((c) => c.url.includes("/modules/"));
  assert.ok(modCall, "should have called /modules/ route");
  assert.ok(modCall.url.includes("/modules/third-party.st-bme/transactions/vector.manifest"));
  assert.ok(!fetchCalls.some((c) => c.url.includes("/bme/")), "should NOT call /bme/ route");

  // Verify NO idempotencyKey is on the envelope (vector.manifest is not idempotency-required).
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, undefined, "vector.manifest envelope must NOT carry idempotencyKey");
  assert.equal(body.input.collectionId, "col-1");
  assert.equal(body.input.vectorSpaceId, "vs-1");
  assert.equal(body.input.observedDim, 3);

  // Verify the result is unwrapped from response.result.
  assert.equal(result.ok, true);
  assert.equal(result.manifest.nodeCount, 42);
  assert.equal(result.manifest.collectionId, "col-1");
  assert.equal(result.manifest.vectorSpaceId, "vs-1");
  assert.equal(result.manifest.observedDim, 3);
}

// Phase 1: bmeVectorManifest enriches module_not_loaded errors.
{
  const mockFetch = async (url) => {
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-err-manifest" }; },
      };
    }
    if (url.includes("/modules/")) {
      return {
        ok: false,
        status: 409,
        headers: { get: () => "application/json" },
        async json() {
          return {
            error: "Module not loaded: third-party.st-bme",
            code: "validation_error",
            category: "validation",
            details: { code: "module_not_loaded", moduleId: "third-party.st-bme", status: "available" },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  let caught = null;
  try {
    await client.bmeVectorManifest({ database: "st_bme_vectors" });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthorityHttpError);
  assert.ok(caught.message.includes("BME companion module"), "manifest error should mention BME companion module");
  assert.ok(caught.message.includes("not loaded"), "manifest error should say not loaded");
  assert.ok(
    caught.path === "/modules/third-party.st-bme/transactions/vector.manifest",
    "manifest error path should reference vector.manifest transaction route",
  );
}

// Phase 1: fetchAuthorityBmeVectorManifest returns null when not ready
// (bmeVectorManifestReady !== true), and does not throw.
{
  const { fetchAuthorityBmeVectorManifest } = await import("../vector/authority-vector-primary-adapter.js");
  const result = await fetchAuthorityBmeVectorManifest(
    { ...config, bmeVectorManifestReady: false },
    { collectionId: "col-1", chatId: "chat-1" },
  );
  assert.equal(result, null, "fetchAuthorityBmeVectorManifest should return null when not ready");
}

// Phase 1: fetchAuthorityBmeVectorManifest returns null on error and does NOT throw.
// state.dirty is not set (no graph is passed, so this contract is structural).
{
  const triviumClient = createMockTriviumClient({ failBmeVectorManifest: true });
  const { fetchAuthorityBmeVectorManifest } = await import("../vector/authority-vector-primary-adapter.js");
  let threw = false;
  let result;
  try {
    result = await fetchAuthorityBmeVectorManifest(
      { ...config, bmeVectorManifestReady: true, triviumClient },
      { collectionId: "col-1", chatId: "chat-1" },
    );
  } catch (error) {
    threw = true;
  }
  assert.equal(threw, false, "fetchAuthorityBmeVectorManifest must NOT throw on error");
  assert.equal(result, null, "fetchAuthorityBmeVectorManifest must return null on error");
  assert.equal(
    triviumClient.calls.filter(([name]) => name === "bmeVectorManifest").length,
    1,
    "bmeVectorManifest should have been attempted once",
  );
}

// Phase 1: fetchAuthorityBmeVectorManifest returns the manifest object on success.
{
  const triviumClient = createMockTriviumClient();
  const { fetchAuthorityBmeVectorManifest } = await import("../vector/authority-vector-primary-adapter.js");
  const result = await fetchAuthorityBmeVectorManifest(
    { ...config, bmeVectorManifestReady: true, triviumClient },
    {
      collectionId: "col-1",
      chatId: "chat-1",
      namespace: "st-bme::chat-1",
      revision: 5,
      modelScope: "gpt-4",
      vectorSpaceId: "vs-1",
      observedDim: 3,
    },
  );
  assert.ok(result, "fetchAuthorityBmeVectorManifest should return the manifest on success");
  assert.equal(result.database, "st_bme_vectors");
  assert.equal(result.collectionId, "col-1");
  assert.equal(result.chatId, "chat-1");
  assert.equal(result.modelScope, "gpt-4");
  assert.equal(result.graphRevision, 5);
  assert.equal(result.vectorSpaceId, "vs-1");
  assert.equal(result.observedDim, 3);
  assert.equal(result.diagnostics.operation, "bmeVectorManifest");
  const manifestCall = triviumClient.calls.find(([name]) => name === "bmeVectorManifest")?.[1];
  assert.equal(manifestCall.collectionId, "col-1");
  assert.equal(manifestCall.vectorSpaceId, "vs-1");
  assert.equal(manifestCall.observedDim, 3);
}

// Phase 3: bmeRecallCandidates posts to /modules/third-party.st-bme/transactions/recall.candidates
// (not /bme/recall-candidates) when using a real AuthorityHttpClient with mock fetch.
// recall.candidates is NOT idempotency-required, so the envelope must NOT carry idempotencyKey.
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-recall" }; },
      };
    }
    if (url.includes("/modules/third-party.st-bme/transactions/recall.candidates")) {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            ok: true,
            moduleId: "third-party.st-bme",
            transaction: "recall.candidates",
            result: {
              ok: true,
              database: body.input?.database || "st_bme_vectors",
              collectionId: body.input?.collectionId || "",
              chatId: body.input?.chatId || "",
              graphRevision: Number(body.input?.graphRevision) || 0,
              modelScope: body.input?.modelScope || "",
              vectorSpaceId: body.input?.vectorSpaceId || "",
              observedDim: Number(body.input?.observedDim) || 0,
              candidates: [
                { externalId: "node-a", internalId: 1, namespace: "ns-1", score: 0.92, source: "search" },
                { externalId: "node-b", internalId: 2, namespace: "ns-1", score: 0.0, source: "expand" },
              ],
              queryCount: Number(body.input?.queryTexts?.length) || 0,
              searchedAt: "2024-01-01T00:00:00.000Z",
            },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  const result = await client.bmeRecallCandidates({
    database: "st_bme_vectors",
    collectionId: "col-1",
    chatId: "chat-1",
    graphRevision: 5,
    modelScope: "gpt-4",
    vectorSpaceId: "vs-1",
    observedDim: 3,
    queryTexts: ["hello"],
    queryVectors: [[1, 2, 3]],
    topK: 10,
    expandDepth: 2,
  });

  // Verify the URL is the module transaction route, NOT /bme/.
  const modCall = fetchCalls.find((c) => c.url.includes("/modules/"));
  assert.ok(modCall, "should have called /modules/ route");
  assert.ok(modCall.url.includes("/modules/third-party.st-bme/transactions/recall.candidates"));
  assert.ok(!fetchCalls.some((c) => c.url.includes("/bme/")), "should NOT call /bme/ route");

  // Verify NO idempotencyKey on the envelope (recall.candidates is not idempotency-required).
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, undefined, "recall.candidates envelope must NOT carry idempotencyKey");
  assert.equal(body.input.collectionId, "col-1");
  assert.equal(body.input.vectorSpaceId, "vs-1");
  assert.equal(body.input.observedDim, 3);
  assert.deepEqual(body.input.queryTexts, ["hello"]);
  assert.deepEqual(body.input.queryVectors, [[1, 2, 3]]);

  // Verify the result is unwrapped from response.result.
  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].externalId, "node-a");
  assert.equal(result.candidates[1].source, "expand");
}

// Phase 3: bmeRecallCandidates enriches module_not_loaded errors.
{
  const mockFetch = async (url) => {
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-err-recall" }; },
      };
    }
    if (url.includes("/modules/")) {
      return {
        ok: false,
        status: 409,
        headers: { get: () => "application/json" },
        async json() {
          return {
            error: "Module not loaded: third-party.st-bme",
            code: "validation_error",
            category: "validation",
            details: { code: "module_not_loaded", moduleId: "third-party.st-bme", status: "available" },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  let caught = null;
  try {
    await client.bmeRecallCandidates({ queryTexts: ["hello"] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthorityHttpError);
  assert.ok(caught.message.includes("BME companion module"), "recall error should mention BME companion module");
  assert.ok(caught.message.includes("not loaded"), "recall error should say not loaded");
  assert.ok(
    caught.path === "/modules/third-party.st-bme/transactions/recall.candidates",
    "recall error path should reference recall.candidates transaction route",
  );
}

// Phase 3: bmeRecallCandidates forwards the caller's signal through to
// requestModuleTransaction → requestJson → fetch, so a caller-side abort
// actually cancels the production HTTP request (not just the awaiting).
// This is the production-abort-wiring blocker: bmeRecallCandidates(payload, { signal })
// must thread `signal` into requestModuleTransaction options, which
// requestJson forwards into fetch via createRequestSignal.
//
// We spy directly on requestModuleTransaction (rather than checking the
// fetch-level signal) because createRequestSignal wraps the caller's
// signal in a fresh AbortController — the fetch-level signal is a
// different object linked via an abort listener, not the caller's signal.
{
  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() { return { ok: true, result: { ok: true, candidates: [] } }; },
    }),
  });

  let capturedModuleId = null;
  let capturedTransactionName = null;
  let capturedInput = null;
  let capturedOptions = null;
  let callCount = 0;
  // Replace requestModuleTransaction with a spy that records the options.
  client.http.requestModuleTransaction = async (moduleId, transactionName, input, options) => {
    callCount += 1;
    capturedModuleId = moduleId;
    capturedTransactionName = transactionName;
    capturedInput = input;
    capturedOptions = options;
    return { ok: true, result: { ok: true, candidates: [] } };
  };

  const controller = new AbortController();
  const callerSignal = controller.signal;
  await client.bmeRecallCandidates(
    { database: "st_bme_vectors", queryTexts: ["hello"], queryVectors: [[1, 2, 3]] },
    { signal: callerSignal, timeoutMs: 5000 },
  );

  assert.equal(callCount, 1, "bmeRecallCandidates should call requestModuleTransaction exactly once");
  assert.equal(capturedModuleId, "third-party.st-bme");
  assert.equal(capturedTransactionName, "recall.candidates");
  assert.equal(capturedInput.queryTexts[0], "hello");
  assert.ok(capturedOptions, "requestModuleTransaction should receive an options argument");
  assert.equal(
    capturedOptions.signal,
    callerSignal,
    "bmeRecallCandidates options.signal must be forwarded to requestModuleTransaction options.signal",
  );
  assert.equal(
    capturedOptions.timeoutMs,
    5000,
    "bmeRecallCandidates options.timeoutMs must be forwarded to requestModuleTransaction options.timeoutMs",
  );
}

// Phase 3: bmeRecallCandidates without an options argument still works
// (default behavior — no signal, no timeoutMs forwarded).
{
  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() { return { ok: true, result: { ok: true, candidates: [] } }; },
    }),
  });

  let capturedOptions = "not-called";
  client.http.requestModuleTransaction = async (moduleId, transactionName, input, options) => {
    capturedOptions = options;
    return { ok: true, result: { ok: true, candidates: [] } };
  };

  const result = await client.bmeRecallCandidates({ database: "st_bme_vectors", queryTexts: ["hello"], queryVectors: [[1, 2, 3]] });
  assert.equal(result.ok, true);
  assert.ok(capturedOptions, "requestModuleTransaction should receive an options argument even when bmeRecallCandidates is called without one");
  assert.equal(capturedOptions.signal, undefined, "no signal should be forwarded when bmeRecallCandidates is called without options");
  assert.equal(capturedOptions.timeoutMs, undefined, "no timeoutMs should be forwarded when bmeRecallCandidates is called without options");
}

// Phase 3: normalizeAuthorityVectorConfig surfaces bmeCandidateSearchReady.
{
  const cfg = normalizeAuthorityVectorConfig({
    authorityBaseUrl: "/api/plugins/authority",
    authorityEmbeddingApiUrl: "https://example.com/v1",
    authorityEmbeddingModel: "test-embedding",
    bmeCandidateSearchReady: true,
  });
  assert.equal(cfg.bmeCandidateSearchReady, true, "normalizeAuthorityVectorConfig must surface bmeCandidateSearchReady from source");

  const cfg2 = normalizeAuthorityVectorConfig({
    authorityBaseUrl: "/api/plugins/authority",
    authorityEmbeddingApiUrl: "https://example.com/v1",
    authorityEmbeddingModel: "test-embedding",
    authorityBmeCandidateSearchReady: true,
  });
  assert.equal(cfg2.bmeCandidateSearchReady, true, "normalizeAuthorityVectorConfig must surface authorityBmeCandidateSearchReady alias");

  const cfg3 = normalizeAuthorityVectorConfig({
    authorityBaseUrl: "/api/plugins/authority",
    authorityEmbeddingApiUrl: "https://example.com/v1",
    authorityEmbeddingModel: "test-embedding",
  });
  assert.equal(cfg3.bmeCandidateSearchReady, false, "normalizeAuthorityVectorConfig defaults bmeCandidateSearchReady to false");
}

// Phase F: bmeGraphCommit posts to /modules/third-party.st-bme/transactions/graph.commitDelta
// (not /bme/graph-commit) when using a real AuthorityHttpClient with mock fetch.
// graph.commitDelta has idempotency:"required" in .authority/module.json, so
// the envelope MUST carry idempotencyKey.
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-graph-commit" }; },
      };
    }
    if (url.includes("/modules/third-party.st-bme/transactions/graph.commitDelta")) {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            ok: true,
            moduleId: "third-party.st-bme",
            transaction: "graph.commitDelta",
            result: {
              ok: true,
              accepted: true,
              revision: 11,
              headHash: "sha256:server-head",
              committedAt: 1700000000000,
              chatId: body.input?.chatId || "",
              counts: { nodeCount: 3, edgeCount: 1, tombstoneCount: 0 },
              applied: {
                upsertedNodes: body.input?.delta?.upsertNodes?.length || 0,
                upsertedEdges: body.input?.delta?.upsertEdges?.length || 0,
                upsertedTombstones: body.input?.delta?.tombstones?.length || 0,
                deletedNodeIds: body.input?.delta?.deleteNodeIds?.length || 0,
                deletedEdgeIds: body.input?.delta?.deleteEdgeIds?.length || 0,
              },
              statementCount: 5,
            },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  const result = await client.bmeGraphCommit({
    chatId: "chat-graph-1",
    baseRevision: 10,
    delta: {
      upsertNodes: [{ id: "n-1", type: "event" }],
      deleteNodeIds: [],
    },
    options: { markSyncDirty: true, reason: "phase-f-test" },
    idempotencyKey: "graph-idem-1",
  });

  // Verify the URL is the module transaction route, NOT /bme/.
  const modCall = fetchCalls.find((c) => c.url.includes("/modules/"));
  assert.ok(modCall, "should have called /modules/ route");
  assert.ok(modCall.url.includes("/modules/third-party.st-bme/transactions/graph.commitDelta"));
  assert.ok(!fetchCalls.some((c) => c.url.includes("/bme/")), "should NOT call /bme/ route");

  // Verify idempotencyKey is on the envelope (graph.commitDelta is idempotency-required).
  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, "graph-idem-1", "envelope MUST carry idempotencyKey for graph.commitDelta");
  assert.equal(body.input.chatId, "chat-graph-1");
  assert.equal(body.input.baseRevision, 10);

  // Verify the result is unwrapped from response.result.
  assert.equal(result.ok, true);
  assert.equal(result.revision, 11);
  assert.equal(result.headHash, "sha256:server-head");
  assert.equal(result.counts.nodeCount, 3);
}

// Phase F: bmeGraphCommit enriches module_not_loaded errors.
{
  const mockFetch = async (url) => {
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-graph-commit-err" }; },
      };
    }
    if (url.includes("/modules/")) {
      return {
        ok: false,
        status: 409,
        headers: { get: () => "application/json" },
        async json() {
          return {
            error: "Module not loaded: third-party.st-bme",
            code: "validation_error",
            category: "validation",
            details: { code: "module_not_loaded", moduleId: "third-party.st-bme", status: "available" },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  let caught = null;
  try {
    await client.bmeGraphCommit({ chatId: "x", baseRevision: 0, delta: {} });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AuthorityHttpError);
  assert.ok(caught.message.includes("BME companion module"), "commit error should mention BME companion module");
  assert.ok(caught.message.includes("not loaded"), "commit error should say not loaded");
  assert.ok(
    caught.path === "/modules/third-party.st-bme/transactions/graph.commitDelta",
    "commit error path should reference graph.commitDelta transaction route",
  );
}

// Phase F: bmeGraphGetHead posts to /modules/third-party.st-bme/transactions/graph.getHead
// with envelope { input } only (NO idempotencyKey — graph.getHead has idempotency:"none").
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-graph-head" }; },
      };
    }
    if (url.includes("/modules/third-party.st-bme/transactions/graph.getHead")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            ok: true,
            moduleId: "third-party.st-bme",
            transaction: "graph.getHead",
            result: {
              ok: true,
              revision: 42,
              headHash: "sha256:head-42",
              chatId: "chat-graph-1",
              meta: { revision: 42, lastModified: 1700000000000 },
            },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  const result = await client.bmeGraphGetHead({ chatId: "chat-graph-1" });

  const modCall = fetchCalls.find((c) => c.url.includes("/modules/third-party.st-bme/transactions/graph.getHead"));
  assert.ok(modCall, "should have called graph.getHead module route");
  assert.ok(!fetchCalls.some((c) => c.url.includes("/bme/")), "should NOT call /bme/ route");

  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, undefined, "graph.getHead envelope must NOT carry idempotencyKey");
  assert.equal(body.input.chatId, "chat-graph-1");

  assert.equal(result.ok, true);
  assert.equal(result.revision, 42);
  assert.equal(result.headHash, "sha256:head-42");
}

// Phase F: bmeGraphLoadSnapshot posts to /modules/third-party.st-bme/transactions/graph.loadSnapshot
// with envelope { input } only (NO idempotencyKey — graph.loadSnapshot has idempotency:"none").
{
  const fetchCalls = [];
  const mockFetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (url.endsWith("/session/init")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() { return { sessionToken: "sess-graph-snapshot" }; },
      };
    }
    if (url.includes("/modules/third-party.st-bme/transactions/graph.loadSnapshot")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return {
            ok: true,
            moduleId: "third-party.st-bme",
            transaction: "graph.loadSnapshot",
            result: {
              ok: true,
              revision: 42,
              headHash: "sha256:head-42",
              chatId: "chat-graph-1",
              nodes: [],
              edges: [],
              tombstones: [],
              meta: { revision: 42 },
              state: { lastProcessedFloor: -1, extractionCount: 0 },
            },
          };
        },
      };
    }
    return { ok: false, status: 404, headers: { get: () => "application/json" }, async json() { return { error: "not found" }; } };
  };

  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: mockFetch,
  });

  const result = await client.bmeGraphLoadSnapshot({ chatId: "chat-graph-1" });

  const modCall = fetchCalls.find((c) => c.url.includes("/modules/third-party.st-bme/transactions/graph.loadSnapshot"));
  assert.ok(modCall, "should have called graph.loadSnapshot module route");
  assert.ok(!fetchCalls.some((c) => c.url.includes("/bme/")), "should NOT call /bme/ route");

  const body = JSON.parse(modCall.options.body);
  assert.equal(body.idempotencyKey, undefined, "graph.loadSnapshot envelope must NOT carry idempotencyKey");
  assert.equal(body.input.chatId, "chat-graph-1");

  assert.equal(result.ok, true);
  assert.equal(result.revision, 42);
  assert.deepEqual(result.nodes, []);
}

// Phase F: bmeGraphCommit forwards caller signal through to requestModuleTransaction.
{
  const { createAuthorityTriviumClient } = await import("../vector/authority-vector-primary-adapter.js");
  const client = createAuthorityTriviumClient({
    baseUrl: "https://authority.test",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      async json() { return { ok: true, result: { ok: true, revision: 1 } }; },
    }),
  });

  let capturedOptions = null;
  client.http.requestModuleTransaction = async (moduleId, transactionName, input, options) => {
    capturedOptions = options;
    return { ok: true, result: { ok: true, revision: 1 } };
  };

  const controller = new AbortController();
  const callerSignal = controller.signal;
  await client.bmeGraphCommit(
    { chatId: "x", baseRevision: 0, delta: {}, idempotencyKey: "k" },
    { signal: callerSignal, timeoutMs: 5000 },
  );

  assert.ok(capturedOptions, "requestModuleTransaction should receive an options argument");
  assert.equal(capturedOptions.signal, callerSignal, "signal must be forwarded");
  assert.equal(capturedOptions.timeoutMs, 5000, "timeoutMs must be forwarded");
  assert.equal(capturedOptions.idempotencyKey, "k", "idempotencyKey must be forwarded");
}

console.log("authority-vector-primary tests passed");
