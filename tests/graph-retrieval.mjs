import assert from "node:assert/strict";
import { diffuseAndRank } from "../diffusion.js";
import {
  addEdge,
  addNode,
  buildTemporalAdjacencyMap,
  createEdge,
  createEmptyGraph,
  createNode,
  invalidateEdge,
} from "../graph.js";

const graph = createEmptyGraph();

const event1 = createNode({
  type: "event",
  seq: 1,
  fields: { summary: "初始事件" },
  importance: 5,
});
const event2 = createNode({
  type: "event",
  seq: 2,
  fields: { summary: "后续事件" },
  importance: 6,
});
const character = createNode({
  type: "character",
  seq: 2,
  fields: { name: "艾琳", state: "警觉" },
  importance: 7,
});

addNode(graph, event1);
addNode(graph, event2);
addNode(graph, character);

const currentEdge = createEdge({
  fromId: event2.id,
  toId: character.id,
  relation: "involved_in",
  strength: 0.9,
});
assert.ok(addEdge(graph, currentEdge));

const historicalEdge = createEdge({
  fromId: event1.id,
  toId: character.id,
  relation: "involved_in",
  strength: 0.4,
});
assert.ok(addEdge(graph, historicalEdge));
invalidateEdge(historicalEdge);

const replacementEdge = createEdge({
  fromId: event1.id,
  toId: character.id,
  relation: "involved_in",
  strength: 0.7,
});
assert.ok(addEdge(graph, replacementEdge));
assert.notEqual(replacementEdge.id, historicalEdge.id);

const adjacencyMap = buildTemporalAdjacencyMap(graph, {
  includeTemporalLinks: true,
  temporalLinkStrength: 0.2,
});
const event1Neighbors = adjacencyMap.get(event1.id) || [];
assert.equal(adjacencyMap.syntheticEdgeCount, 1);
assert.ok(
  event1Neighbors.some(
    (item) => item.targetId === character.id && item.strength === 0.7,
  ),
);
assert.ok(
  event1Neighbors.some(
    (item) => item.targetId === event2.id && item.strength === 0.2,
  ),
);

const diffusion = diffuseAndRank(adjacencyMap, [
  { id: event2.id, energy: 1 },
  { id: event2.id, energy: 0.5 },
], {
  teleportAlpha: 0.15,
});
assert.ok(diffusion.some((item) => item.nodeId === character.id));
assert.ok(diffusion.some((item) => item.nodeId === event1.id));

console.log("graph-retrieval tests passed");
