import assert from "node:assert/strict";

import { createEmptyGraph, createNode, addNode } from "../graph/graph.js";
import {
  applyCognitionUpdates,
  applyManualKnowledgeOverride,
  clearManualKnowledgeOverride,
  deleteKnowledgeOwner,
  mergeKnowledgeOwners,
  applyRegionUpdates,
  computeKnowledgeGateForNode,
  listKnowledgeOwners,
  renameKnowledgeOwner,
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

const renameGraph = createEmptyGraph();
const renameCharacter = createNode({
  type: "character",
  fields: { name: "艾琳", state: "守塔人" },
  seq: 1,
});
const renameObjectiveEvent = createNode({
  type: "event",
  fields: { title: "塔楼晨钟", summary: "晨钟再次响起" },
  seq: 2,
});
const renamePovMemory = createNode({
  type: "pov_memory",
  fields: { summary: "艾琳记得晨钟响起" },
  seq: 3,
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerName: "艾琳",
    ownerId: "艾琳",
  },
});
addNode(renameGraph, renameCharacter);
addNode(renameGraph, renameObjectiveEvent);
addNode(renameGraph, renamePovMemory);
applyCognitionUpdates(
  renameGraph,
  [
    {
      ownerType: "character",
      ownerName: "艾琳",
      ownerNodeId: renameCharacter.id,
      knownRefs: [renameObjectiveEvent.id],
      visibility: [{ ref: renameObjectiveEvent.id, score: 1 }],
    },
  ],
  { changedNodeIds: [renameObjectiveEvent.id] },
);
const renameOwner = resolveKnowledgeOwner(renameGraph, {
  ownerType: "character",
  ownerName: "艾琳",
  nodeId: renameCharacter.id,
});
renameGraph.historyState.activeCharacterPovOwner = "艾琳";
renameGraph.historyState.activeRecallOwnerKey = renameOwner.ownerKey;
renameGraph.historyState.recentRecallOwnerKeys = [renameOwner.ownerKey];
const renameResult = renameKnowledgeOwner(renameGraph, renameOwner.ownerKey, "艾琳娜");
assert.equal(renameResult.ok, true);
assert.equal(renameCharacter.fields.name, "艾琳娜");
assert.equal(renamePovMemory.scope.ownerName, "艾琳娜");
assert.equal(renamePovMemory.scope.ownerId, "艾琳娜");
assert.equal(renameGraph.historyState.activeCharacterPovOwner, "艾琳娜");
assert.equal(renameGraph.historyState.activeRecallOwnerKey, renameResult.ownerKey);
assert.equal(renameGraph.knowledgeState.owners[renameOwner.ownerKey], undefined);
assert.equal(renameGraph.knowledgeState.owners[renameResult.ownerKey].ownerName, "艾琳娜");
assert.equal(
  renameGraph.knowledgeState.owners[renameResult.ownerKey].aliases.includes("艾琳"),
  true,
);

const mergeGraph = createEmptyGraph();
const mergeSourceCharacter = createNode({
  type: "character",
  fields: { name: "艾琳", state: "旧身份" },
  seq: 1,
});
const mergeTargetCharacter = createNode({
  type: "character",
  fields: { name: "艾琳娜", state: "新身份" },
  seq: 2,
});
const mergeSourceEvent = createNode({
  type: "event",
  fields: { title: "旧钟楼记忆", summary: "她想起了旧钟楼" },
  seq: 3,
});
const mergeTargetEvent = createNode({
  type: "event",
  fields: { title: "新花园记忆", summary: "她想起了新花园" },
  seq: 4,
});
const mergeSourcePov = createNode({
  type: "pov_memory",
  fields: { summary: "艾琳的 POV 记忆" },
  seq: 5,
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerName: "艾琳",
    ownerId: "艾琳",
  },
});
addNode(mergeGraph, mergeSourceCharacter);
addNode(mergeGraph, mergeTargetCharacter);
addNode(mergeGraph, mergeSourceEvent);
addNode(mergeGraph, mergeTargetEvent);
addNode(mergeGraph, mergeSourcePov);
applyCognitionUpdates(
  mergeGraph,
  [
    {
      ownerType: "character",
      ownerName: "艾琳",
      ownerNodeId: mergeSourceCharacter.id,
      knownRefs: [mergeSourceEvent.id],
      visibility: [{ ref: mergeSourceEvent.id, score: 0.95 }],
    },
    {
      ownerType: "character",
      ownerName: "艾琳娜",
      ownerNodeId: mergeTargetCharacter.id,
      knownRefs: [mergeTargetEvent.id],
      visibility: [{ ref: mergeTargetEvent.id, score: 0.9 }],
    },
  ],
  { changedNodeIds: [mergeSourceEvent.id, mergeTargetEvent.id] },
);
const mergeSourceOwner = resolveKnowledgeOwner(mergeGraph, {
  ownerType: "character",
  ownerName: "艾琳",
  nodeId: mergeSourceCharacter.id,
});
const mergeTargetOwner = resolveKnowledgeOwner(mergeGraph, {
  ownerType: "character",
  ownerName: "艾琳娜",
  nodeId: mergeTargetCharacter.id,
});
mergeGraph.historyState.activeCharacterPovOwner = "艾琳";
mergeGraph.historyState.activeRecallOwnerKey = mergeSourceOwner.ownerKey;
mergeGraph.historyState.recentRecallOwnerKeys = [
  mergeSourceOwner.ownerKey,
  mergeTargetOwner.ownerKey,
];
const mergeResult = mergeKnowledgeOwners(mergeGraph, {
  sourceOwnerKey: mergeSourceOwner.ownerKey,
  targetOwnerKey: mergeTargetOwner.ownerKey,
});
assert.equal(mergeResult.ok, true);
assert.equal(mergeGraph.knowledgeState.owners[mergeSourceOwner.ownerKey], undefined);
assert.equal(mergeGraph.knowledgeState.owners[mergeTargetOwner.ownerKey].knownNodeIds.includes(mergeSourceEvent.id), true);
assert.equal(mergeGraph.knowledgeState.owners[mergeTargetOwner.ownerKey].knownNodeIds.includes(mergeTargetEvent.id), true);
assert.equal(mergeGraph.knowledgeState.owners[mergeTargetOwner.ownerKey].aliases.includes("艾琳"), true);
assert.equal(mergeSourcePov.scope.ownerName, "艾琳娜");
assert.equal(mergeSourcePov.scope.ownerId, "艾琳娜");
assert.equal(mergeSourceCharacter.archived, true);
assert.equal(mergeGraph.historyState.activeCharacterPovOwner, "艾琳娜");
assert.equal(mergeGraph.historyState.activeRecallOwnerKey, mergeTargetOwner.ownerKey);

const deleteOwnerOnlyGraph = createEmptyGraph();
const deleteOwnerOnlyCharacter = createNode({
  type: "character",
  fields: { name: "米娅", state: "书记官" },
  seq: 1,
});
const deleteOwnerOnlyEvent = createNode({
  type: "event",
  fields: { title: "记录密报", summary: "米娅记录了一份密报" },
  seq: 2,
});
const deleteOwnerOnlyPov = createNode({
  type: "pov_memory",
  fields: { summary: "米娅的 POV" },
  seq: 3,
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerName: "米娅",
    ownerId: "米娅",
  },
});
addNode(deleteOwnerOnlyGraph, deleteOwnerOnlyCharacter);
addNode(deleteOwnerOnlyGraph, deleteOwnerOnlyEvent);
addNode(deleteOwnerOnlyGraph, deleteOwnerOnlyPov);
applyCognitionUpdates(
  deleteOwnerOnlyGraph,
  [
    {
      ownerType: "character",
      ownerName: "米娅",
      ownerNodeId: deleteOwnerOnlyCharacter.id,
      knownRefs: [deleteOwnerOnlyEvent.id],
      visibility: [{ ref: deleteOwnerOnlyEvent.id, score: 0.85 }],
    },
  ],
  { changedNodeIds: [deleteOwnerOnlyEvent.id] },
);
const deleteOwnerOnly = resolveKnowledgeOwner(deleteOwnerOnlyGraph, {
  ownerType: "character",
  ownerName: "米娅",
  nodeId: deleteOwnerOnlyCharacter.id,
});
const deleteOwnerOnlyResult = deleteKnowledgeOwner(deleteOwnerOnlyGraph, deleteOwnerOnly.ownerKey, {
  mode: "owner-only",
});
assert.equal(deleteOwnerOnlyResult.ok, true);
assert.equal(deleteOwnerOnlyGraph.knowledgeState.owners[deleteOwnerOnly.ownerKey], undefined);
assert.equal(deleteOwnerOnlyCharacter.archived, false);
assert.equal(deleteOwnerOnlyPov.archived, false);

const deleteArchiveCharacterGraph = createEmptyGraph();
const deleteArchiveCharacterNode = createNode({
  type: "character",
  fields: { name: "诺拉", state: "侍女" },
  seq: 1,
});
const deleteArchiveCharacterEvent = createNode({
  type: "event",
  fields: { title: "诺拉送信", summary: "诺拉送出了一封信" },
  seq: 2,
});
const deleteArchiveCharacterPov = createNode({
  type: "pov_memory",
  fields: { summary: "诺拉的 POV" },
  seq: 3,
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerName: "诺拉",
    ownerId: "诺拉",
  },
});
addNode(deleteArchiveCharacterGraph, deleteArchiveCharacterNode);
addNode(deleteArchiveCharacterGraph, deleteArchiveCharacterEvent);
addNode(deleteArchiveCharacterGraph, deleteArchiveCharacterPov);
applyCognitionUpdates(
  deleteArchiveCharacterGraph,
  [
    {
      ownerType: "character",
      ownerName: "诺拉",
      ownerNodeId: deleteArchiveCharacterNode.id,
      knownRefs: [deleteArchiveCharacterEvent.id],
      visibility: [{ ref: deleteArchiveCharacterEvent.id, score: 0.82 }],
    },
  ],
  { changedNodeIds: [deleteArchiveCharacterEvent.id] },
);
const deleteArchiveCharacterOwner = resolveKnowledgeOwner(deleteArchiveCharacterGraph, {
  ownerType: "character",
  ownerName: "诺拉",
  nodeId: deleteArchiveCharacterNode.id,
});
const deleteArchiveCharacterResult = deleteKnowledgeOwner(
  deleteArchiveCharacterGraph,
  deleteArchiveCharacterOwner.ownerKey,
  { mode: "archive-character" },
);
assert.equal(deleteArchiveCharacterResult.ok, true);
assert.equal(deleteArchiveCharacterNode.archived, true);
assert.equal(deleteArchiveCharacterPov.archived, false);

const deleteArchiveAllGraph = createEmptyGraph();
const deleteArchiveAllCharacter = createNode({
  type: "character",
  fields: { name: "赛拉", state: "守卫" },
  seq: 1,
});
const deleteArchiveAllEvent = createNode({
  type: "event",
  fields: { title: "赛拉巡逻", summary: "赛拉完成了巡逻" },
  seq: 2,
});
const deleteArchiveAllPov = createNode({
  type: "pov_memory",
  fields: { summary: "赛拉的 POV" },
  seq: 3,
  scope: {
    layer: "pov",
    ownerType: "character",
    ownerName: "赛拉",
    ownerId: "赛拉",
  },
});
addNode(deleteArchiveAllGraph, deleteArchiveAllCharacter);
addNode(deleteArchiveAllGraph, deleteArchiveAllEvent);
addNode(deleteArchiveAllGraph, deleteArchiveAllPov);
applyCognitionUpdates(
  deleteArchiveAllGraph,
  [
    {
      ownerType: "character",
      ownerName: "赛拉",
      ownerNodeId: deleteArchiveAllCharacter.id,
      knownRefs: [deleteArchiveAllEvent.id],
      visibility: [{ ref: deleteArchiveAllEvent.id, score: 0.88 }],
    },
  ],
  { changedNodeIds: [deleteArchiveAllEvent.id] },
);
const deleteArchiveAllOwner = resolveKnowledgeOwner(deleteArchiveAllGraph, {
  ownerType: "character",
  ownerName: "赛拉",
  nodeId: deleteArchiveAllCharacter.id,
});
const deleteArchiveAllResult = deleteKnowledgeOwner(deleteArchiveAllGraph, deleteArchiveAllOwner.ownerKey, {
  mode: "archive-all",
});
assert.equal(deleteArchiveAllResult.ok, true);
assert.equal(deleteArchiveAllCharacter.archived, true);
assert.equal(deleteArchiveAllPov.archived, true);

console.log("knowledge-state tests passed");
