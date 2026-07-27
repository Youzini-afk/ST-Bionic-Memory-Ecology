import assert from "node:assert/strict";

import { createConversationSession } from "../runtime/conversation-session.js";
import { createConversationWorkspace } from "../runtime/conversation-workspace.js";

let now = 100;
const clearedTimers = [];
const session = createConversationSession({ now: () => now });
const workspace = createConversationWorkspace({
  session,
  createPersistenceState: () => ({ loadState: "idle", revision: 0 }),
  createStatus: (kind) => ({ kind, level: "idle" }),
  clearTimeout: (handle) => clearedTimers.push(handle),
});

workspace.enterChat({ chatId: "chat-a", hostChatId: "file-a" });
workspace.graph = { chatId: "chat-a", nodes: [{ id: "a" }] };
workspace.graphPersistenceState = { loadState: "loaded", revision: 4 };
workspace.lastExtractedItems = [{ id: "a" }];
workspace.isExtracting = true;
workspace.timers.historyRecovery = 11;
workspace.timers.historyMutationChecks = [12, 13];
workspace.timers.deferredHistoryMutationRecheck = 14;
workspace.timers.graphLoadRetry = 15;
session.beginGeneration("normal", {});
session.setInput("pendingRecallSendIntent", { text: "hello" });
const staleLease = workspace.captureLease();

now += 1;
const switched = workspace.enterChat(
  { chatId: "chat-b", hostChatId: "file-b" },
  { forceNewEpoch: true },
);
assert.equal(switched.changed, true);
assert.equal(workspace.graph, null);
assert.deepEqual(workspace.graphPersistenceState, { loadState: "idle", revision: 0 });
assert.deepEqual(workspace.lastExtractedItems, []);
assert.equal(workspace.isExtracting, false);
assert.deepEqual(clearedTimers, [11, 14, 15, 12, 13]);
assert.deepEqual(workspace.timers.historyMutationChecks, []);
assert.equal(session.getGeneration(), null);
assert.equal(session.getInput("pendingRecallSendIntent"), null);
assert.equal(workspace.isLeaseCurrent(staleLease), false);
assert.equal(workspace.publishGraph({ chatId: "chat-a" }, { lease: staleLease }), false);
assert.equal(workspace.graph, null);

const currentLease = workspace.captureLease();
const committedGraph = { chatId: "chat-b", nodes: [{ id: "b" }] };
assert.equal(workspace.publishGraph(committedGraph, { lease: currentLease }), true);
assert.equal(workspace.graph, committedGraph);

const promotedSession = createConversationSession({ now: () => now });
const promotedWorkspace = createConversationWorkspace({ session: promotedSession });
const initial = promotedWorkspace.enterChat({ chatId: "host-id", hostChatId: "same-file" });
const promoted = promotedWorkspace.enterChat({ chatId: "integrity-id", hostChatId: "same-file" });
assert.equal(promoted.changed, false);
assert.equal(promoted.epoch, initial.epoch);

console.log("conversation-workspace tests passed");
