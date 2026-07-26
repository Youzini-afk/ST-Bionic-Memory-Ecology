import assert from "node:assert/strict";
import { addNode, createEmptyGraph, createNode } from "../graph/graph.js";
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
    async embedText(text) {
      const seed = String(text || "").length || 1;
      return [seed / 100, 0.2, 0.3];
    },
  },
};

const { normalizeAuthorityVectorConfig } = await import(
  "../vector/authority-vector-primary-adapter.js"
);
const { resolveAuthorityRecallCandidates } = await import(
  "../retrieval/authority-candidate-provider.js"
);

function createRecallGraph() {
  const graph = createEmptyGraph();
  graph.historyState.chatId = "chat-authority-candidates";
  graph.vectorIndexState.collectionId = "st-bme:chat-authority-candidates:nodes";

  const first = createNode({
    type: "event",
    seq: 10,
    fields: { title: "Alice enters the archive", summary: "Alice reaches the archive gate" },
    importance: 6,
    scope: {
      layer: "objective",
      ownerType: "",
      ownerId: "",
      ownerName: "",
      bucket: "objectiveGlobal",
      regionKey: "archive",
    },
  });
  first.id = "node-archive";
  first.storySegmentId = "seg-archive";

  const second = createNode({
    type: "event",
    seq: 11,
    fields: { title: "Bob opens the vault", summary: "Bob unlocks the hidden vault" },
    importance: 7,
    scope: {
      layer: "objective",
      ownerType: "",
      ownerId: "",
      ownerName: "",
      bucket: "objectiveGlobal",
      regionKey: "archive",
    },
  });
  second.id = "node-vault";
  second.storySegmentId = "seg-archive";

  const third = createNode({
    type: "pov_memory",
    seq: 12,
    fields: { title: "Alice remembers the key", summary: "Alice knows where the silver key is" },
    importance: 9,
    scope: {
      layer: "pov",
      ownerType: "character",
      ownerId: "Alice",
      ownerName: "Alice",
      bucket: "characterPov",
      regionKey: "archive",
    },
  });
  third.id = "node-alice-memory";
  third.storySegmentId = "seg-archive";

  const fourth = createNode({
    type: "event",
    seq: 6,
    fields: { title: "Market rumor", summary: "A rumor spreads in the market" },
    importance: 2,
    scope: {
      layer: "objective",
      ownerType: "",
      ownerId: "",
      ownerName: "",
      bucket: "objectiveGlobal",
      regionKey: "market",
    },
  });
  fourth.id = "node-market";
  fourth.storySegmentId = "seg-market";

  addNode(graph, first);
  addNode(graph, second);
  addNode(graph, third);
  addNode(graph, fourth);
  return { graph, nodes: [first, second, third, fourth] };
}

function createMockTriviumClient({ failFilter = false, failSearch = false, failNeighbors = false } = {}) {
  const calls = [];
  return {
    calls,
    async filterWhere(payload = {}) {
      calls.push(["filterWhere", payload]);
      if (failFilter) {
        throw new Error("filter-down");
      }
      return {
        items: [
          { externalId: "node-archive" },
          { payload: { nodeId: "node-alice-memory" } },
        ],
      };
    },
    async search(payload = {}) {
      calls.push(["search", payload]);
      if (failSearch) {
        throw new Error("search-down");
      }
      return {
        results: [
          { nodeId: "node-alice-memory", score: 0.96 },
          { nodeId: "node-vault", score: 0.88 },
          { nodeId: "node-outside", score: 0.77 },
        ],
      };
    },
    async neighbors(payload = {}) {
      calls.push(["neighbors", payload]);
      if (failNeighbors) {
        throw new Error("neighbors-down");
      }
      return {
        neighbors: [
          { fromId: "node-alice-memory", toId: "node-vault" },
          { fromId: "node-alice-memory", toId: "node-archive" },
        ],
      };
    },
  };
}

// Phase 3: createMockTriviumClientWithBmeRecall — mock that exposes bmeRecallCandidates.
// Records the options argument (second parameter) so tests can assert that
// `signal` is wired through from the caller's abort context.
function createMockTriviumClientWithBmeRecall({
  recallCandidates = null,
  failBmeRecall = false,
  failBmeRecallAbort = false,
  failBmeRecallAuthorityAbort = false,
  failFilter = false,
  failSearch = false,
  failNeighbors = false,
} = {}) {
  const base = createMockTriviumClient({ failFilter, failSearch, failNeighbors });
  base.bmeRecallCandidates = async (payload = {}, options = {}) => {
    base.calls.push(["bmeRecallCandidates", payload, options]);
    if (failBmeRecallAuthorityAbort) {
      // Mirrors what runtime/authority-http-client.js throws when an
      // in-flight fetch is aborted: AuthorityHttpError with
      // category === "aborted" and code === "aborted". The candidate
      // provider MUST treat this as an abort (not a server failure),
      // regardless of failOpen.
      throw new AuthorityHttpError("Authority request aborted", {
        status: 0,
        code: "aborted",
        category: "aborted",
        path: "/modules/third-party.st-bme/transactions/recall.candidates",
        protocol: "server-plugin-v06",
      });
    }
    if (failBmeRecallAbort) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (failBmeRecall) {
      throw new Error("bme-recall-down");
    }
    const candidates = Array.isArray(recallCandidates)
      ? recallCandidates
      : [
          { externalId: "node-alice-memory", internalId: 1, namespace: "st-bme::chat-authority-candidates", score: 0.92, source: "search" },
          { externalId: "node-vault", internalId: 2, namespace: "st-bme::chat-authority-candidates", score: 0.88, source: "search" },
          { externalId: "node-archive", internalId: 3, namespace: "st-bme::chat-authority-candidates", score: 0.0, source: "expand" },
        ];
    return {
      ok: true,
      database: payload.database || "st_bme_vectors",
      collectionId: payload.collectionId || "",
      chatId: payload.chatId || "",
      graphRevision: Number(payload.graphRevision) || 0,
      modelScope: payload.modelScope || "",
      vectorSpaceId: payload.vectorSpaceId || "",
      observedDim: Number(payload.observedDim) || 0,
      candidates,
      queryCount: Number(payload.queryTexts?.length) || 0,
      searchedAt: "2024-01-01T00:00:00.000Z",
    };
  };
  return base;
}

{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClient();
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true,
    },
    { triviumClient },
  );
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "Alice 现在在 archive 里找 silver key 吗？",
    recentMessages: ["assistant: Alice just reached the archive gate."],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: {
      activeSegmentId: "seg-archive",
    },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [
      {
        ownerKey: "character:Alice",
        ownerName: "Alice",
      },
    ],
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
      enableMultiIntent: true,
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.used, true);
  assert.deepEqual(
    result.candidateNodes.map((node) => node.id),
    ["node-alice-memory", "node-vault", "node-archive"],
  );
  assert.equal(result.diagnostics.filteredCount, 2);
  assert.equal(result.diagnostics.searchHits, 2);
  assert.equal(result.diagnostics.neighborCount, 1);
  const filterCall = triviumClient.calls.find(([name]) => name === "filterWhere");
  assert.equal(filterCall?.[1]?.filters?.archived, false);
  assert.deepEqual(filterCall?.[1]?.filters?.regionKeys, ["archive"]);
  assert.deepEqual(filterCall?.[1]?.filters?.ownerKeys, ["character:Alice"]);
  assert.deepEqual(filterCall?.[1]?.filters?.storySegmentIds, ["seg-archive"]);
  const searchCall = triviumClient.calls.find(([name]) => name === "search");
  assert.ok(Array.isArray(searchCall?.[1]?.candidateIds));
  assert.ok(searchCall?.[1]?.candidateIds.includes("node-alice-memory"));
  const neighborCall = triviumClient.calls.find(([name]) => name === "neighbors");
  assert.deepEqual(neighborCall?.[1]?.nodeIds, ["node-alice-memory", "node-vault"]);
}

{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClient({
    failFilter: true,
    failSearch: true,
    failNeighbors: true,
  });
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true,
    },
    { triviumClient },
  );
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "archive",
    recentMessages: [],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: {
      activeSegmentId: "seg-archive",
    },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [
      {
        ownerKey: "character:Alice",
        ownerName: "Alice",
      },
    ],
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.used, false);
  assert.deepEqual(result.candidateNodes, []);
  assert.match(result.diagnostics.fallbackReason, /authority-candidate-(filter|search|neighbors)-failed/);
}

// Phase 3: fast path - server returns candidates → used directly, 3-round path skipped.
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall();
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true,
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "Alice 在 archive 里找 silver key 吗？",
    recentMessages: ["assistant: Alice just reached the archive gate."],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: { activeSegmentId: "seg-archive" },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
      enableMultiIntent: true,
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.diagnostics.bmeFastPathUsed, true, "bmeFastPathUsed should be true when fast path succeeded");
  assert.equal(result.diagnostics.filteredCount, 0, "filteredCount should be 0 (3-round path skipped)");
  // bmeRecallCandidates should have been called once.
  const bmeCall = triviumClient.calls.find(([name]) => name === "bmeRecallCandidates");
  assert.ok(bmeCall, "bmeRecallCandidates should have been called");
  assert.equal(bmeCall[1].database, "st_bme_vectors");
  // collectionId is normalized to buildVectorCollectionId(chatId) = "st-bme::chat-authority-candidates".
  assert.equal(bmeCall[1].collectionId, "st-bme::chat-authority-candidates");
  assert.equal(bmeCall[1].chatId, "chat-authority-candidates");
  assert.ok(Array.isArray(bmeCall[1].queryTexts) && bmeCall[1].queryTexts.length > 0);
  assert.ok(Array.isArray(bmeCall[1].queryVectors) && bmeCall[1].queryVectors.length === bmeCall[1].queryTexts.length);
  // 3-round path methods should NOT have been called.
  assert.equal(triviumClient.calls.some(([name]) => name === "filterWhere"), false, "filterWhere should be skipped on fast path");
  assert.equal(triviumClient.calls.some(([name]) => name === "search"), false, "search should be skipped on fast path");
  assert.equal(triviumClient.calls.some(([name]) => name === "neighbors"), false, "neighbors should be skipped on fast path");
}

// Phase 3: fast path - server error + failOpen (default) → falls back to 3-round path.
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall({ failBmeRecall: true });
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true, // default
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "archive",
    recentMessages: [],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: { activeSegmentId: "seg-archive" },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.diagnostics.bmeFastPathUsed, false, "bmeFastPathUsed should be false on server error");
  assert.match(result.diagnostics.fallbackReason, /authority-candidate-bme-failed/);
  // 3-round path should have been called as fallback.
  assert.ok(
    triviumClient.calls.some(([name]) => name === "filterWhere") || triviumClient.calls.some(([name]) => name === "search"),
    "3-round path should run on fallback",
  );
}

// Phase 3: fast path - server error + failOpen === false → throws.
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall({ failBmeRecall: true });
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: false, // fail CLOSED
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  let threw = null;
  try {
    await resolveAuthorityRecallCandidates({
      graph,
      userMessage: "archive",
      recentMessages: [],
      embeddingConfig: config,
      availableNodes: nodes,
      activeRegion: "archive",
      activeStoryContext: { activeSegmentId: "seg-archive" },
      activeRecallOwnerKeys: ["character:Alice"],
      sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
      options: {
        enabled: true,
        topK: 4,
        maxRecallNodes: 2,
        limit: 6,
        neighborLimit: 2,
        minimumUsedCandidateCount: 2,
      },
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "should throw when failOpen === false and fast path errors");
  assert.match(threw.message, /bme-recall-down/);
}

// Phase 3: fast path - AbortError always rethrows (even with failOpen true).
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall({ failBmeRecallAbort: true });
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true, // fail open should NOT swallow AbortError
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  let threw = null;
  try {
    await resolveAuthorityRecallCandidates({
      graph,
      userMessage: "archive",
      recentMessages: [],
      embeddingConfig: config,
      availableNodes: nodes,
      activeRegion: "archive",
      activeStoryContext: { activeSegmentId: "seg-archive" },
      activeRecallOwnerKeys: ["character:Alice"],
      sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
      options: {
        enabled: true,
        topK: 4,
        maxRecallNodes: 2,
        limit: 6,
        neighborLimit: 2,
        minimumUsedCandidateCount: 2,
      },
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "AbortError should always rethrow");
  assert.equal(threw.name, "AbortError");
}

// Phase 3: fast path - AuthorityHttpError { category: "aborted" } (the shape
// runtime/authority-http-client.js wraps fetch aborts in) is treated as an
// abort and rethrown even when failOpen is the default. This is the
// production-safe abort semantics blocker: without this, a real HTTP abort
// would be misclassified as a normal server failure and swallowed by the
// failOpen fallback, surfacing as a stale/empty result instead of
// propagating the cancel.
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall({ failBmeRecallAuthorityAbort: true });
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true, // fail open should NOT swallow a wrapped abort
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  let threw = null;
  try {
    await resolveAuthorityRecallCandidates({
      graph,
      userMessage: "archive",
      recentMessages: [],
      embeddingConfig: config,
      availableNodes: nodes,
      activeRegion: "archive",
      activeStoryContext: { activeSegmentId: "seg-archive" },
      activeRecallOwnerKeys: ["character:Alice"],
      sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
      options: {
        enabled: true,
        topK: 4,
        maxRecallNodes: 2,
        limit: 6,
        neighborLimit: 2,
        minimumUsedCandidateCount: 2,
      },
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "AuthorityHttpError { category: 'aborted' } should always rethrow");
  assert.ok(threw instanceof AuthorityHttpError, "should rethrow the original AuthorityHttpError");
  assert.equal(threw.category, "aborted", "rethrown error should preserve category 'aborted'");
  assert.equal(threw.code, "aborted", "rethrown error should preserve code 'aborted'");
  // 3-round path must NOT have been called as fallback for an abort.
  assert.equal(
    triviumClient.calls.some(([name]) => name === "filterWhere"),
    false,
    "filterWhere should NOT run as fallback for an abort",
  );
  assert.equal(
    triviumClient.calls.some(([name]) => name === "search"),
    false,
    "search should NOT run as fallback for an abort",
  );
}

// Phase 3: fast path - signal from the caller's abort context is threaded
// through bmeRecallCandidates(payload, { signal }) and reaches the underlying
// requestModuleTransaction options. This is the production-abort-wiring
// blocker: without it, aborting the candidate-provider's outer signal would
// only stop awaiting the promise while the production HTTP request kept
// running server-side.
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall();
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true,
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  const controller = new AbortController();
  const signal = controller.signal;
  await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "Alice 在 archive 里找 silver key 吗？",
    recentMessages: ["assistant: Alice just reached the archive gate."],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: { activeSegmentId: "seg-archive" },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
    signal,
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
      enableMultiIntent: true,
    },
  });
  const bmeCall = triviumClient.calls.find(([name]) => name === "bmeRecallCandidates");
  assert.ok(bmeCall, "bmeRecallCandidates should have been called");
  // bmeCall[2] is the options argument (the mock now records it).
  assert.ok(bmeCall[2], "bmeRecallCandidates should have received an options argument");
  assert.equal(
    bmeCall[2].signal,
    signal,
    "bmeRecallCandidates options.signal should be the caller's AbortSignal",
  );
}

// Phase 3: fast path - empty result from server → falls back to 3-round path.
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall({ recallCandidates: [] });
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true,
      bmeCandidateSearchReady: true,
    },
    { triviumClient },
  );
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "archive",
    recentMessages: [],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: { activeSegmentId: "seg-archive" },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.diagnostics.bmeFastPathUsed, false, "bmeFastPathUsed should be false on empty result");
  assert.match(result.diagnostics.fallbackReason, /authority-candidate-bme-empty/);
  // 3-round path should have been called as fallback.
  assert.ok(
    triviumClient.calls.some(([name]) => name === "filterWhere") || triviumClient.calls.some(([name]) => name === "search"),
    "3-round path should run on empty fallback",
  );
}

// Phase 3: fast path is gated on bmeCandidateSearchReady === true.
// When bmeCandidateSearchReady is false, the 3-round path runs as before
// (this is the existing behavior; this test confirms the gate works).
{
  const { graph, nodes } = createRecallGraph();
  const triviumClient = createMockTriviumClientWithBmeRecall();
  const config = normalizeAuthorityVectorConfig(
    {
      authorityBaseUrl: "/api/plugins/authority",
      authorityEmbeddingApiUrl: "https://example.com/v1",
      authorityEmbeddingModel: "test-embedding",
      authorityVectorFailOpen: true,
      // bmeCandidateSearchReady deliberately NOT set.
    },
    { triviumClient },
  );
  assert.equal(config.bmeCandidateSearchReady, false, "config should default bmeCandidateSearchReady to false");
  const result = await resolveAuthorityRecallCandidates({
    graph,
    userMessage: "archive",
    recentMessages: [],
    embeddingConfig: config,
    availableNodes: nodes,
    activeRegion: "archive",
    activeStoryContext: { activeSegmentId: "seg-archive" },
    activeRecallOwnerKeys: ["character:Alice"],
    sceneOwnerCandidates: [{ ownerKey: "character:Alice", ownerName: "Alice" }],
    options: {
      enabled: true,
      topK: 4,
      maxRecallNodes: 2,
      limit: 6,
      neighborLimit: 2,
      minimumUsedCandidateCount: 2,
    },
  });
  assert.equal(result.diagnostics.bmeFastPathUsed, false, "bmeFastPathUsed must be false when bmeCandidateSearchReady is false");
  // bmeRecallCandidates should NOT have been called.
  assert.equal(
    triviumClient.calls.some(([name]) => name === "bmeRecallCandidates"),
    false,
    "bmeRecallCandidates should not be called when bmeCandidateSearchReady is false",
  );
  // 3-round path should have been used.
  assert.ok(
    triviumClient.calls.some(([name]) => name === "filterWhere") || triviumClient.calls.some(([name]) => name === "search"),
    "3-round path should run when fast path is gated off",
  );
}

console.log("authority-recall-candidates tests passed");
