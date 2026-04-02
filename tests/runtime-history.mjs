import assert from "node:assert/strict";
import {
  appendBatchJournal,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
  rollbackBatch,
  snapshotProcessedMessageHashes,
} from "../runtime-state.js";
import { createEmptyGraph } from "../graph.js";

const chat = [
  { is_user: true, mes: "你好" },
  { is_user: false, mes: "我记住了。" },
  { is_user: true, mes: "继续" },
  { is_user: false, mes: "新的回复" },
];

const hashes = snapshotProcessedMessageHashes(chat, 3);
const cleanDetection = detectHistoryMutation(chat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashes: hashes,
});
assert.equal(cleanDetection.dirty, false);

const missingHashesDetection = detectHistoryMutation(chat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashes: {},
});
assert.equal(missingHashesDetection.dirty, true);
assert.equal(missingHashesDetection.earliestAffectedFloor, 0);

const sparseHashesDetection = detectHistoryMutation(chat, {
  lastProcessedAssistantFloor: 3,
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
  processedMessageHashes: hashes,
});
assert.equal(editedDetection.dirty, true);
assert.equal(editedDetection.earliestAffectedFloor, 1);

const bmeHiddenChat = structuredClone(chat);
bmeHiddenChat[1].is_system = true;
bmeHiddenChat[1].extra = { __st_bme_hide_managed: true };
const bmeHiddenDetection = detectHistoryMutation(bmeHiddenChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashes: hashes,
});
assert.equal(bmeHiddenDetection.dirty, false);

const realSystemFlipChat = structuredClone(chat);
realSystemFlipChat[1].is_system = true;
const realSystemFlipDetection = detectHistoryMutation(realSystemFlipChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashes: hashes,
});
assert.equal(realSystemFlipDetection.dirty, true);
assert.equal(realSystemFlipDetection.earliestAffectedFloor, 1);

const truncatedChat = chat.slice(0, 2);
const truncatedDetection = detectHistoryMutation(truncatedChat, {
  lastProcessedAssistantFloor: 3,
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

rollbackBatch(graph, recoveryPoint.affectedJournals[0]);
assert.equal(graph.nodes.length, 0);
assert.equal(graph.historyState.lastProcessedAssistantFloor, -1);
assert.equal(graph.historyState.extractionCount, 0);

console.log("runtime-history tests passed");
