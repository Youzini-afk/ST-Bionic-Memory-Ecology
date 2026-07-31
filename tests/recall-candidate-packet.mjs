import assert from "node:assert/strict";
import { createEmptyGraph } from "../graph/graph.js";
import { DEFAULT_NODE_SCHEMA } from "../graph/schema.js";
import {
  buildRecallCandidatePacket,
  collectVectorTailCandidates,
} from "../retrieval/recall-candidate-packet.js";

function node(id, seq, summary, extra = {}) {
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
    fields: { name: id, state: summary },
    embedding: extra.embedding || null,
    importance: extra.importance || 5,
    accessCount: 0,
    updatedAt: seq,
    lastAccessTime: seq,
    createdTime: seq,
    prevId: null,
    nextId: null,
    clusters: [],
    scope: { layer: "objective" },
    memoryRevisionId: `revision:${id}`,
    memoryLayer: "objective",
    memoryConfidence: 1,
  };
}

const graph = createEmptyGraph();
graph.nodes = [
  node("memory:old", 2, "waiting outside", { embedding: [1, 0] }),
  node("memory:new", 8, "entered the archive", { importance: 8 }),
  node("memory:newer", 10, "found the sealed door", { importance: 7 }),
];
graph.vectorIndexState = {
  mode: "backend",
  dirty: true,
  pendingRepairFromFloor: 8,
  replayRequiredNodeIds: ["memory:new"],
  nodeToHash: { "memory:old": "hash:old" },
  hashToNodeId: { "hash:old": "memory:old" },
};

const tail = collectVectorTailCandidates(graph, {
  excludeMemoryIds: ["memory:old"],
  limit: 5,
});
assert.deepEqual(tail.map((candidate) => candidate.memoryId), [
  "memory:newer",
  "memory:new",
]);
assert.ok(tail[0].channels.includes("vector-tail"));
assert.ok(tail[0].channels.includes("pending-repair-floor"));
assert.ok(tail[0].channels.includes("not-indexed"));

const generallyDirtyGraph = createEmptyGraph();
generallyDirtyGraph.nodes = [node("memory:mapped-but-dirty", 12, "new state", { embedding: [1, 0] })];
generallyDirtyGraph.vectorIndexState = {
  mode: "backend",
  dirty: true,
  nodeToHash: { "memory:mapped-but-dirty": "hash:mapped" },
};
assert.equal(
  collectVectorTailCandidates(generallyDirtyGraph, { limit: 2 })[0]?.channels.includes(
    "dirty-index-tail",
  ),
  true,
);

const packet = await buildRecallCandidatePacket({
  graph,
  userMessage: "What is behind the sealed door?",
  recentMessages: ["Mira entered the archive."],
  embeddingConfig: {},
  schema: DEFAULT_NODE_SCHEMA,
  settings: { authorityGraphQueryEnabled: false },
  options: {
    candidateLimit: 2,
    tailLimit: 3,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableDiversitySampling: false,
  },
  retrieveFn: async ({ graph: workingGraph }) => ({
    selectedNodeIds: ["memory:old"],
    stats: { recallCount: 1 },
    meta: {
      retrieval: { source: "test-programmatic" },
      scopeContext: { graph: workingGraph, enableScopedMemory: false },
    },
  }),
});
assert.equal(packet.channels.programmatic > 0, true);
assert.equal(packet.candidateMemoryIds.includes("memory:newer"), true);
assert.equal(packet.vectorState.dirty, true);
assert.equal("graph" in packet.baseline.scopeContext, false);
assert.deepEqual(graph.nodes.map((entry) => entry.accessCount), [0, 0, 0]);

console.log("recall candidate packet tests passed");
