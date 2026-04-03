import assert from "node:assert/strict";

import {
  addNode,
  createEmptyGraph,
  createNode,
  deserializeGraph,
  findLatestNode,
  serializeGraph,
} from "../graph.js";

const graph = createEmptyGraph();
const objectiveNode = createNode({
  type: "character",
  fields: { name: "艾琳", state: "平静" },
  seq: 1,
});
const povNode = createNode({
  type: "character",
  fields: { name: "艾琳", state: "怀疑一切" },
  seq: 2,
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerId: "艾琳",
    ownerName: "艾琳",
    regionPrimary: "钟楼",
  },
});
addNode(graph, objectiveNode);
addNode(graph, povNode);

const latestObjective = findLatestNode(
  graph,
  "character",
  "艾琳",
  "name",
  { layer: "objective" },
);
const latestPov = findLatestNode(
  graph,
  "character",
  "艾琳",
  "name",
  {
    layer: "pov",
    ownerType: "character",
    ownerId: "艾琳",
    ownerName: "艾琳",
  },
);

assert.equal(latestObjective?.id, objectiveNode.id);
assert.equal(latestPov?.id, povNode.id);

const legacyGraph = deserializeGraph({
  version: 5,
  lastProcessedSeq: 0,
  nodes: [
    {
      id: "legacy-1",
      type: "event",
      fields: { title: "旧事件", summary: "旧摘要" },
      seq: 0,
      seqRange: [0, 0],
      archived: false,
      importance: 5,
      createdTime: 1,
      accessCount: 0,
      lastAccessTime: 1,
      level: 0,
      parentId: null,
      childIds: [],
      prevId: null,
      nextId: null,
      clusters: [],
    },
  ],
  edges: [],
});
assert.equal(legacyGraph.nodes[0]?.scope?.layer, "objective");
assert.equal(legacyGraph.version, 6);

const restored = deserializeGraph(serializeGraph(graph));
assert.equal(restored.nodes.find((node) => node.id === povNode.id)?.scope?.ownerType, "character");
assert.equal(restored.nodes.find((node) => node.id === povNode.id)?.scope?.regionPrimary, "钟楼");

console.log("scoped-memory tests passed");
