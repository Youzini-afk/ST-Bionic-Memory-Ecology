import assert from "node:assert/strict";
import {
  appendBatchJournal,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
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

const editedChat = structuredClone(chat);
editedChat[1].mes = "我改过内容了。";
const editedDetection = detectHistoryMutation(editedChat, {
  lastProcessedAssistantFloor: 3,
  processedMessageHashes: hashes,
});
assert.equal(editedDetection.dirty, true);
assert.equal(editedDetection.earliestAffectedFloor, 1);

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
graph.lastProcessedSeq = 3;
graph.historyState.lastProcessedAssistantFloor = 3;
const afterSnapshot = cloneGraphSnapshot(graph);
appendBatchJournal(
  graph,
  createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
    processedRange: [1, 3],
    postProcessArtifacts: ["compression"],
    vectorHashesInserted: [1234],
  }),
);

const recoveryPoint = findJournalRecoveryPoint(graph, 2);
assert.ok(recoveryPoint);
assert.equal(recoveryPoint.journal.processedRange[1], 3);
assert.equal(
  recoveryPoint.snapshotBefore.historyState.lastProcessedAssistantFloor,
  -1,
);

console.log("runtime-history tests passed");
