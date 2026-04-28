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

console.log("authority-recall-candidates tests passed");
