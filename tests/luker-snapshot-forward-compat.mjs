// ST-BME restrained rebirth — Phase 3c Luker sidecar forward-compat tests.
//
// Luker stores the graph as a serialized graph blob inside the checkpoint, not as
// the durable snapshot shape. This test proves the IMPORTANT property: unknown
// future fields on graph nodes/edges survive a Luker checkpoint round-trip
// (build -> normalize -> deserialize). It also documents the intentional boundary
// that the sidecar ENVELOPE metadata (manifest stats, checkpoint meta) is
// normalized/whitelisted on purpose — those are rebuildable operational metrics,
// not graph data.

import assert from "node:assert/strict";

import {
  buildLukerGraphCheckpointV2,
  normalizeLukerGraphCheckpointV2,
} from "../graph/graph-persistence.js";
import {
  addEdge,
  addNode,
  createEdge,
  createNode,
  createEmptyGraph,
  deserializeGraph,
} from "../graph/graph.js";

// Build a graph and inject unknown FUTURE fields onto a node and an edge.
const graph = createEmptyGraph();
const nodeA = addNode(
  graph,
  createNode({ type: "char", fields: { name: "恬恬" }, seq: 1 }),
);
const nodeB = addNode(
  graph,
  createNode({ type: "event", fields: { title: "相遇" }, seq: 2 }),
);
// Simulate a future writer adding new fields the current build does not know.
nodeA.futureNodeField = { trait: "playful", version: 99 };
const edge = addEdge(
  graph,
  createEdge({ fromId: nodeA.id, toId: nodeB.id, relation: "participatesIn" }),
);
edge.futureEdgeField = "edge-keep-me";

// 1. Checkpoint round-trip preserves unknown graph record fields.
const checkpoint = buildLukerGraphCheckpointV2(graph, {
  revision: 7,
  chatId: "chat-luker-fc",
  integrity: "integrity-luker",
  reason: "test",
});
assert.ok(checkpoint, "checkpoint built");
assert.ok(checkpoint.serializedGraph, "checkpoint carries serialized graph");

const restored = deserializeGraph(checkpoint.serializedGraph);
const restoredNodeA = restored.nodes.find((n) => n.id === nodeA.id);
const restoredEdge = restored.edges.find((e) => e.fromId === nodeA.id);
assert.ok(restoredNodeA, "node survived Luker checkpoint round-trip");
assert.deepEqual(
  restoredNodeA.futureNodeField,
  { trait: "playful", version: 99 },
  "unknown future node field preserved through Luker checkpoint",
);
assert.ok(restoredEdge, "edge survived Luker checkpoint round-trip");
assert.equal(
  restoredEdge.futureEdgeField,
  "edge-keep-me",
  "unknown future edge field preserved through Luker checkpoint",
);
console.log("  ✓ Luker checkpoint preserves unknown future graph record fields");

// 2. normalize re-parse of a checkpoint payload preserves the serialized graph
// verbatim (so unknown fields inside it are never touched by the envelope layer).
const reNormalized = normalizeLukerGraphCheckpointV2({
  ...checkpoint,
  // A future writer may add an unknown ENVELOPE field. It is intentionally
  // dropped (rebuildable operational metadata), but graph data must be intact.
  futureEnvelopeField: "envelope-meta-can-be-dropped",
});
assert.equal(
  reNormalized.serializedGraph,
  checkpoint.serializedGraph,
  "serialized graph blob is preserved verbatim by the envelope normalizer",
);
const reRestoredNode = deserializeGraph(reNormalized.serializedGraph).nodes.find(
  (n) => n.id === nodeA.id,
);
assert.deepEqual(
  reRestoredNode.futureNodeField,
  { trait: "playful", version: 99 },
  "graph record unknown fields still intact after envelope re-normalize",
);
assert.equal(
  "futureEnvelopeField" in reNormalized,
  false,
  "envelope-level unknown metadata is intentionally normalized away (rebuildable)",
);
console.log("  ✓ Luker envelope normalize keeps graph data intact while normalizing metadata");

console.log("luker-snapshot-forward-compat tests passed");
