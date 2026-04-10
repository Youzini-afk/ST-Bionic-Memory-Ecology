import assert from "node:assert/strict";

import { createEmptyGraph, createNode, addNode } from "../graph/graph.js";
import {
  applyCognitionUpdates,
  applyManualKnowledgeOverride,
  clearManualKnowledgeOverride,
  applyRegionUpdates,
  computeKnowledgeGateForNode,
  listKnowledgeOwners,
  resolveActiveRegionContext,
  resolveAdjacentRegions,
  resolveKnowledgeOwner,
  setManualActiveRegion,
} from "../graph/knowledge-state.js";

globalThis.SillyTavern = {
  getContext() {
    return {
      name1: "露西亚",
    };
  },
};

const graph = createEmptyGraph();
const erinA = createNode({
  type: "character",
  fields: { name: "艾琳", state: "守塔人" },
  seq: 1,
});
const erinB = createNode({
  type: "character",
  fields: { name: "艾琳", state: "伪装者" },
  seq: 2,
});
const lucia = createNode({
  type: "character",
  fields: { name: "露西亚", state: "旁观者" },
  seq: 2,
});
const bellEvent = createNode({
  type: "event",
  fields: { title: "钟楼异响", summary: "钟楼深夜传出异响" },
  seq: 3,
  scope: { layer: "objective", regionPrimary: "钟楼" },
});
addNode(graph, erinA);
addNode(graph, erinB);
addNode(graph, lucia);
addNode(graph, bellEvent);

const ownerA = resolveKnowledgeOwner(graph, {
  ownerType: "character",
  ownerName: "艾琳",
  nodeId: erinA.id,
});
const ownerB = resolveKnowledgeOwner(graph, {
  ownerType: "character",
  ownerName: "艾琳",
  nodeId: erinB.id,
});
assert.notEqual(ownerA.ownerKey, ownerB.ownerKey);

applyCognitionUpdates(
  graph,
  [
    {
      ownerType: "character",
      ownerName: "艾琳",
      ownerNodeId: erinA.id,
      knownRefs: [bellEvent.id],
      visibility: [{ ref: bellEvent.id, score: 1 }],
    },
  ],
  {
    changedNodeIds: [bellEvent.id],
    scopeRuntime: {
      activeCharacterOwner: "艾琳",
      activeUserOwner: "玩家",
    },
  },
);

const gateVisible = computeKnowledgeGateForNode(graph, bellEvent, ownerA.ownerKey, {
  scopeBucket: "objectiveCurrentRegion",
});
assert.equal(gateVisible.visible, true);
assert.equal(gateVisible.anchored, true);

applyManualKnowledgeOverride(graph, {
  ownerKey: ownerA.ownerKey,
  nodeId: bellEvent.id,
  mode: "mistaken",
});
const gateSuppressed = computeKnowledgeGateForNode(graph, bellEvent, ownerA.ownerKey, {
  scopeBucket: "objectiveCurrentRegion",
});
assert.equal(gateSuppressed.visible, false);
assert.equal(gateSuppressed.suppressedReason, "mistaken-objective");

const clearedOverride = clearManualKnowledgeOverride(graph, {
  ownerKey: ownerA.ownerKey,
  nodeId: bellEvent.id,
});
assert.equal(clearedOverride.ok, true);
const gateRestored = computeKnowledgeGateForNode(graph, bellEvent, ownerA.ownerKey, {
  scopeBucket: "objectiveCurrentRegion",
});
assert.equal(gateRestored.visible, true);
assert.notEqual(gateRestored.suppressedReason, "mistaken-objective");

applyCognitionUpdates(
  graph,
  [
    {
      ownerType: "character",
      ownerName: "露西亚",
      ownerNodeId: lucia.id,
      knownRefs: [bellEvent.id],
      visibility: [{ ref: bellEvent.id, score: 1 }],
    },
  ],
  { changedNodeIds: [bellEvent.id] },
);
applyCognitionUpdates(
  graph,
  [
    {
      ownerType: "user",
      ownerName: "露西亚",
      knownRefs: [bellEvent.id],
      visibility: [{ ref: bellEvent.id, score: 0.8 }],
    },
  ],
  { changedNodeIds: [bellEvent.id] },
);
applyManualKnowledgeOverride(graph, {
  ownerKey: ownerA.ownerKey,
  nodeId: bellEvent.id,
  mode: "mistaken",
});
const gateUnion = computeKnowledgeGateForNode(
  graph,
  bellEvent,
  [ownerA.ownerKey, `character:露西亚`],
  {
    scopeBucket: "objectiveCurrentRegion",
  },
);
assert.equal(gateUnion.visible, true);
assert.deepEqual(gateUnion.visibleOwnerKeys, ["character:露西亚"]);
assert.deepEqual(gateUnion.suppressedOwnerKeys, [ownerA.ownerKey]);

applyRegionUpdates(graph, {
  activeRegionHint: "钟楼",
  adjacency: [{ region: "钟楼", adjacent: ["旧城区", "内廷"] }],
});
assert.equal(resolveActiveRegionContext(graph).activeRegion, "钟楼");
assert.deepEqual(resolveAdjacentRegions(graph, "钟楼").adjacentRegions, ["旧城区", "内廷"]);

setManualActiveRegion(graph, "旧城区");
assert.equal(resolveActiveRegionContext(graph).source, "manual");
assert.equal(resolveActiveRegionContext(graph).activeRegion, "旧城区");

const ownerList = listKnowledgeOwners(graph);
assert.ok(ownerList.some((entry) => entry.ownerKey === ownerA.ownerKey));
assert.ok(
  ownerList.some(
    (entry) => entry.ownerName === "露西亚" && entry.knownCount >= 1,
  ),
);
const sameNameOwners = ownerList.filter((entry) => entry.ownerName === "露西亚");
assert.equal(sameNameOwners.length, 2);
assert.deepEqual(
  sameNameOwners.map((entry) => entry.ownerType).sort(),
  ["character", "user"],
);

const aliasMatchedUserOwner = resolveKnowledgeOwner(graph, {
  ownerType: "character",
  ownerName: "露 西 亚",
});
assert.equal(aliasMatchedUserOwner.ownerType, "user");
assert.equal(aliasMatchedUserOwner.ownerName, "露西亚");

const syntheticGraph = createEmptyGraph();
syntheticGraph.historyState.activeUserPovOwner = "玩家";
addNode(
  syntheticGraph,
  createNode({
    type: "character",
    fields: { name: "玩 家" },
    seq: 1,
  }),
);
const syntheticOwners = listKnowledgeOwners(syntheticGraph);
assert.equal(syntheticOwners.some((entry) => entry.ownerType === "character"), false);

const roleCardGraph = createEmptyGraph();
const roleCardEvent = createNode({
  type: "event",
  fields: { title: "天气变化", summary: "窗外下起了雨" },
  seq: 1,
});
addNode(roleCardGraph, roleCardEvent);
applyCognitionUpdates(
  roleCardGraph,
  [],
  {
    changedNodeIds: [roleCardEvent.id],
    scopeRuntime: {
      activeCharacterOwner: "旁白卡",
      activeUserOwner: "玩家",
    },
  },
);
const roleCardOwners = listKnowledgeOwners(roleCardGraph);
assert.equal(
  roleCardOwners.some(
    (entry) =>
      entry.ownerType === "character" && entry.ownerName === "旁白卡",
  ),
  false,
);

const characterNodeGraph = createEmptyGraph();
const plainCharacterNode = createNode({
  type: "character",
  fields: { name: "旁白卡", state: "仅角色卡实体" },
  seq: 1,
});
addNode(characterNodeGraph, plainCharacterNode);
applyCognitionUpdates(
  characterNodeGraph,
  [],
  {
    changedNodeIds: [plainCharacterNode.id],
    scopeRuntime: {
      activeCharacterOwner: "旁白卡",
      activeUserOwner: "玩家",
    },
  },
);
const characterNodeOwners = listKnowledgeOwners(characterNodeGraph);
assert.equal(
  characterNodeOwners.some(
    (entry) =>
      entry.ownerType === "character" && entry.ownerName === "旁白卡",
  ),
  false,
);

const duplicateCharacterGraph = createEmptyGraph();
const roleCardNameNode = createNode({
  type: "character",
  fields: { name: "艾 琳" },
  seq: 1,
});
const watchedEvent = createNode({
  type: "event",
  fields: { title: "看见钟楼", summary: "艾琳看见钟楼方向出现火光" },
  seq: 2,
});
addNode(duplicateCharacterGraph, roleCardNameNode);
addNode(duplicateCharacterGraph, watchedEvent);
applyCognitionUpdates(
  duplicateCharacterGraph,
  [
    {
      ownerType: "character",
      ownerName: "艾琳",
      knownRefs: [watchedEvent.id],
      visibility: [{ ref: watchedEvent.id, score: 0.9 }],
    },
  ],
  { changedNodeIds: [watchedEvent.id] },
);
const dedupedCharacterOwners = listKnowledgeOwners(duplicateCharacterGraph).filter(
  (entry) => entry.ownerType === "character",
);
assert.equal(dedupedCharacterOwners.length, 1);
assert.equal(dedupedCharacterOwners[0].knownCount >= 1, true);
assert.equal(
  dedupedCharacterOwners[0].ownerName,
  "艾琳",
);
assert.equal(
  dedupedCharacterOwners[0].aliases.includes("艾琳"),
  true,
);

console.log("knowledge-state tests passed");
