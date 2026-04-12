import assert from "node:assert/strict";
import {
  MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY,
  appendBatchJournal,
  clearHistoryDirty,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
  normalizeGraphRuntimeState,
  PROCESSED_MESSAGE_HASH_VERSION,
  rebindProcessedHistoryStateToChat,
  rollbackBatch,
  snapshotProcessedMessageHashes,
} from "../runtime/runtime-state.js";
import { createEmptyGraph } from "../graph/graph.js";
import { normalizeKnowledgeState } from "../graph/knowledge-state.js";

const chat = [
  { is_user: true, mes: "你好" },
  { is_user: false, mes: "我记住了。" },
  { is_user: true, mes: "继续" },
  { is_user: false, mes: "新的回复" },
];

const hashes = snapshotProcessedMessageHashes(chat, 3);
const cleanDetection = detectHistoryMutation(chat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: hashes,
});
assert.equal(cleanDetection.dirty, false);

const missingHashesDetection = detectHistoryMutation(chat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: {},
});
assert.equal(missingHashesDetection.dirty, true);
assert.equal(missingHashesDetection.earliestAffectedFloor, 0);

const sparseHashesDetection = detectHistoryMutation(chat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: {
    0: hashes[0],
    2: hashes[2],
    3: hashes[3],
  },
});
assert.equal(sparseHashesDetection.dirty, true);
assert.equal(sparseHashesDetection.earliestAffectedFloor, 1);

const editedChat = structuredClone(chat);
editedChat[1].mes = "我改过内容了。";
const editedDetection = detectHistoryMutation(editedChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: hashes,
});
assert.equal(editedDetection.dirty, true);
assert.equal(editedDetection.earliestAffectedFloor, 1);

const bmeHiddenChat = structuredClone(chat);
bmeHiddenChat[1].is_system = true;
bmeHiddenChat[1].extra = { __st_bme_hide_managed: true };
const bmeHiddenDetection = detectHistoryMutation(bmeHiddenChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: hashes,
});
assert.equal(bmeHiddenDetection.dirty, false);

const realSystemFlipChat = structuredClone(chat);
realSystemFlipChat[1].is_system = true;
const realSystemFlipDetection = detectHistoryMutation(realSystemFlipChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: hashes,
});
assert.equal(realSystemFlipDetection.dirty, false);

const migratedGraph = normalizeGraphRuntimeState({
  historyState: {
    chatId: "chat-history-test",
    lastProcessedAssistantFloor: 3,
    processedMessageHashVersion: 1,
    processedMessageHashes: hashes,
  },
});
assert.equal(
  migratedGraph.historyState.processedMessageHashVersion,
  PROCESSED_MESSAGE_HASH_VERSION,
);
assert.deepEqual(migratedGraph.historyState.processedMessageHashes, {});
assert.equal(migratedGraph.historyState.processedMessageHashesNeedRefresh, true);

const migratedDetection = detectHistoryMutation(chat, migratedGraph.historyState);
assert.equal(migratedDetection.dirty, false);

const emptyHashGraph = normalizeGraphRuntimeState({
  historyState: {
    chatId: "chat-history-test",
    lastProcessedAssistantFloor: 3,
    processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
    processedMessageHashes: {},
    processedMessageHashesNeedRefresh: false,
  },
});
assert.equal(emptyHashGraph.historyState.processedMessageHashesNeedRefresh, true);

const importedGraph = normalizeGraphRuntimeState({
  historyState: {
    chatId: "chat-history-test",
    lastProcessedAssistantFloor: 99,
    processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
    processedMessageHashes: {},
    processedMessageHashesNeedRefresh: true,
  },
});
const reboundResult = rebindProcessedHistoryStateToChat(importedGraph, chat, [
  1,
  3,
]);
assert.equal(reboundResult.rebound, true);
assert.equal(reboundResult.lastProcessedAssistantFloor, 3);
assert.equal(reboundResult.clamped, true);
assert.equal(importedGraph.historyState.processedMessageHashesNeedRefresh, false);
assert.deepEqual(
  importedGraph.historyState.processedMessageHashes,
  snapshotProcessedMessageHashes(chat, 3),
);

const danglingKnowledgeGraph = createEmptyGraph();
danglingKnowledgeGraph.nodes.push({
  id: "live-node",
  type: "event",
  fields: { title: "仍存在", summary: "仍存在的节点" },
  seq: 1,
  seqRange: [1, 1],
  archived: false,
  embedding: null,
  importance: 5,
  accessCount: 0,
  lastAccessTime: Date.now(),
  createdTime: Date.now(),
  level: 0,
  parentId: null,
  childIds: [],
  prevId: null,
  nextId: null,
  clusters: [],
});
danglingKnowledgeGraph.knowledgeState.owners["character:艾琳"] = {
  ownerType: "character",
  ownerKey: "character:艾琳",
  ownerName: "艾琳",
  nodeId: "ghost-owner-node",
  knownNodeIds: ["ghost-node", "live-node"],
  mistakenNodeIds: ["ghost-mistaken"],
  manualKnownNodeIds: ["ghost-manual-known"],
  manualHiddenNodeIds: ["ghost-manual-hidden"],
  visibilityScores: {
    "ghost-node": 1,
    "live-node": 0.9,
  },
};
const normalizedKnowledgeState = normalizeKnowledgeState(
  danglingKnowledgeGraph.knowledgeState,
  danglingKnowledgeGraph,
);
assert.deepEqual(
  normalizedKnowledgeState.owners["character:艾琳"]?.knownNodeIds,
  ["live-node"],
);
assert.deepEqual(
  normalizedKnowledgeState.owners["character:艾琳"]?.mistakenNodeIds,
  [],
);
assert.deepEqual(
  normalizedKnowledgeState.owners["character:艾琳"]?.manualKnownNodeIds,
  [],
);
assert.deepEqual(
  normalizedKnowledgeState.owners["character:艾琳"]?.manualHiddenNodeIds,
  [],
);
assert.deepEqual(
  normalizedKnowledgeState.owners["character:艾琳"]?.visibilityScores,
  { "live-node": 0.9 },
);
assert.equal(
  normalizedKnowledgeState.owners["character:艾琳"]?.nodeId || "",
  "",
);

const clearedGraph = normalizeGraphRuntimeState({
  historyState: {
    chatId: "chat-history-test",
    lastProcessedAssistantFloor: 3,
    processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
    processedMessageHashes: hashes,
    processedMessageHashesNeedRefresh: false,
  },
});
clearHistoryDirty(clearedGraph, { status: "replayed" });
assert.deepEqual(clearedGraph.historyState.processedMessageHashes, {});
assert.equal(clearedGraph.historyState.processedMessageHashesNeedRefresh, true);

const truncatedChat = chat.slice(0, 2);
const truncatedDetection = detectHistoryMutation(truncatedChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: hashes,
});
assert.equal(truncatedDetection.dirty, true);
assert.equal(truncatedDetection.earliestAffectedFloor, 2);

const graph = createEmptyGraph();
graph.historyState.chatId = "chat-history-test";
const beforeSnapshot = cloneGraphSnapshot(graph);
graph.nodes.push({
  id: "node-1",
  type: "event",
  fields: { title: "旧事件", summary: "旧摘要" },
  seq: 1,
  seqRange: [1, 1],
  archived: false,
  embedding: null,
  importance: 5,
  accessCount: 0,
  lastAccessTime: Date.now(),
  createdTime: Date.now(),
  level: 0,
  parentId: null,
  childIds: [],
  prevId: null,
  nextId: null,
  clusters: [],
});
graph.lastProcessedSeq = 3;
graph.historyState.lastProcessedAssistantFloor = 3;
graph.historyState.processedMessageHashes = hashes;
graph.historyState.extractionCount = 4;
graph.knowledgeState.owners["character:艾琳"] = {
  ownerType: "character",
  ownerKey: "character:艾琳",
  ownerName: "艾琳",
  knownNodeIds: ["node-1"],
  visibilityScores: { "node-1": 1 },
};
const afterSnapshot = cloneGraphSnapshot(graph);
appendBatchJournal(
  graph,
  createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
    processedRange: [1, 3],
    postProcessArtifacts: ["compression"],
    vectorHashesInserted: [1234],
    extractionCountBefore: 0,
  }),
);

const recoveryPoint = findJournalRecoveryPoint(graph, 2);
assert.ok(recoveryPoint);
assert.equal(recoveryPoint.path, "reverse-journal");
assert.equal(recoveryPoint.affectedJournals[0].processedRange[1], 3);

const truncatedCoverageGraph = createEmptyGraph();
truncatedCoverageGraph.historyState.chatId = "chat-truncated-history-test";
truncatedCoverageGraph.historyState[MANUAL_BACKUP_BATCH_JOURNAL_COVERAGE_KEY] = {
  truncated: true,
  earliestRetainedFloor: 4,
  retainedCount: 4,
};
truncatedCoverageGraph.batchJournal = [
  { id: "journal-4", journalVersion: 2, processedRange: [4, 4] },
  { id: "journal-5", journalVersion: 2, processedRange: [5, 5] },
  { id: "journal-6", journalVersion: 2, processedRange: [6, 6] },
  { id: "journal-7", journalVersion: 2, processedRange: [7, 7] },
];
assert.equal(
  findJournalRecoveryPoint(truncatedCoverageGraph, 3),
  null,
  "dirty floor earlier than retained backup coverage should reject partial rollback",
);
const retainedCoverageRecoveryPoint = findJournalRecoveryPoint(
  truncatedCoverageGraph,
  5,
);
assert.ok(retainedCoverageRecoveryPoint);
assert.equal(retainedCoverageRecoveryPoint.path, "reverse-journal");
assert.equal(retainedCoverageRecoveryPoint.affectedJournals.length, 3);

rollbackBatch(graph, recoveryPoint.affectedJournals[0]);
assert.equal(graph.nodes.length, 0);
assert.equal(graph.historyState.lastProcessedAssistantFloor, -1);
assert.equal(graph.historyState.extractionCount, 0);
assert.equal(
  Object.keys(graph.knowledgeState?.owners || {}).length,
  0,
);

console.log("runtime-history tests passed");
