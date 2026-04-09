import assert from "node:assert/strict";

import {
  addNode,
  createEmptyGraph,
  createNode,
  deserializeGraph,
  findLatestNode,
  serializeGraph,
} from "../graph/graph.js";

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
  version: 6,
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
assert.equal(legacyGraph.version, 9);
assert.equal(legacyGraph.knowledgeState?.version, 1);
assert.equal(legacyGraph.regionState?.version, 1);
assert.equal(legacyGraph.timelineState?.version, 1);
assert.equal(legacyGraph.summaryState?.version, 1);
assert.equal(legacyGraph.historyState?.activeRegionSource, "");
assert.equal(legacyGraph.historyState?.activeStorySegmentId, "");
assert.equal(legacyGraph.historyState?.activeStoryTimeLabel, "");
assert.deepEqual(legacyGraph.historyState?.recentRecallOwnerKeys, []);
assert.deepEqual(legacyGraph.nodes[0]?.storyTime, {
  segmentId: "",
  label: "",
  tense: "unknown",
  relation: "unknown",
  anchorLabel: "",
  confidence: "medium",
  source: "derived",
});
assert.deepEqual(legacyGraph.nodes[0]?.storyTimeSpan, {
  startSegmentId: "",
  endSegmentId: "",
  startLabel: "",
  endLabel: "",
  mixed: false,
  source: "derived",
});

const restored = deserializeGraph(serializeGraph(graph));
assert.equal(restored.nodes.find((node) => node.id === povNode.id)?.scope?.ownerType, "character");
assert.equal(restored.nodes.find((node) => node.id === povNode.id)?.scope?.regionPrimary, "钟楼");
assert.equal(restored.knowledgeState?.version, 1);
assert.equal(restored.regionState?.version, 1);
assert.equal(restored.timelineState?.version, 1);

restored.knowledgeState.owners["character:艾琳"] = {
  ownerType: "character",
  ownerKey: "character:艾琳",
  ownerName: "艾琳",
  nodeId: "",
  aliases: ["艾琳"],
  knownNodeIds: [objectiveNode.id],
  mistakenNodeIds: [],
  visibilityScores: { [objectiveNode.id]: 1 },
  manualKnownNodeIds: [],
  manualHiddenNodeIds: [],
  updatedAt: Date.now(),
  lastSource: "test",
};
restored.regionState.adjacencyMap["钟楼"] = {
  adjacent: ["旧城区"],
  aliases: [],
  source: "test",
  updatedAt: Date.now(),
};
restored.timelineState.segments.push({
  id: "tl-1",
  label: "第二天清晨",
  normalizedKey: "第二天清晨",
  matcherKey: "第二天清晨::after",
  order: 1,
  aliases: ["次日清晨"],
  parentId: "",
  relationToParent: "after",
  anchorLabel: "",
  confidence: "high",
  source: "test",
  updatedAt: Date.now(),
});
restored.timelineState.manualActiveSegmentId = "tl-1";
restored.historyState.activeStorySegmentId = "tl-1";
restored.historyState.activeStoryTimeLabel = "第二天清晨";
const roundTrip = deserializeGraph(serializeGraph(restored));
assert.equal(
  roundTrip.knowledgeState?.owners?.["character:艾琳"]?.knownNodeIds?.[0],
  objectiveNode.id,
);
assert.equal(
  roundTrip.regionState?.adjacencyMap?.["钟楼"]?.adjacent?.[0],
  "旧城区",
);
assert.equal(roundTrip.timelineState?.segments?.[0]?.label, "第二天清晨");
assert.equal(roundTrip.timelineState?.manualActiveSegmentId, "tl-1");
assert.equal(roundTrip.historyState?.activeStoryTimeLabel, "第二天清晨");

console.log("scoped-memory tests passed");
