import assert from "node:assert/strict";

import { inheritHostBranchGraph } from "../runtime/host-branch-inheritance.js";
import { resolveCurrentChatIdentityCore } from "../runtime/identity-resolver.js";

const context = {
  chatId: "branch-file",
  chatMetadata: {
    integrity: "root-memory-owner",
    st_bme_commit_marker: { chatId: "parent-memory-owner" },
    authority: {
      conversationId: "conversation-child",
      branchId: "branch-child",
      revision: 1,
      lastEventId: "commit-child-1",
      parentConversationId: "conversation-parent",
      parentBranchId: "branch-parent",
      parentRevision: 9,
    },
  },
  chat: [
    { is_user: true, mes: "user" },
    { is_user: false, mes: "assistant" },
  ],
  characterId: "1",
};

const identity = resolveCurrentChatIdentityCore({
  context,
  resolveAliasByHostLineage(lineage) {
    return lineage.conversationId === "conversation-parent"
      ? "parent-lineage-owner"
      : "";
  },
});
assert.equal(
  identity.chatId,
  "st-bme-host::conversation-child::branch-child",
);
assert.equal(identity.identitySource, "host-lineage-branch");
assert.equal(identity.parentPersistenceChatId, "parent-lineage-owner");
assert.equal(identity.hostLineage.parentConversationId, "conversation-parent");

const calls = [];
const sourceGraph = {
  nodes: [{ id: "parent-node" }],
  edges: [],
  historyState: {
    chatId: "parent-lineage-owner",
    hostLineage: {
      conversationId: "conversation-parent",
      branchId: "branch-parent",
      hostRevision: 9,
    },
  },
};
const result = await inheritHostBranchGraph({
  identity,
  currentChat: context.chat,
  sourceGraph,
  isCurrent: () => true,
  isTargetEmpty: async (chatId) => {
    calls.push(["empty", chatId]);
    return true;
  },
  isSourceGraphCompatible: () => true,
  loadSourceGraph: async () => {
    throw new Error("compatible source should be reused");
  },
  deriveBranchGraph(graph, options) {
    calls.push(["derive", options]);
    return structuredClone({
      ...graph,
      historyState: { ...graph.historyState, chatId: options.targetChatId },
    });
  },
  persistBranchGraph: async (graph, branchContext) => {
    calls.push(["persist", graph, branchContext]);
    return { accepted: true, saved: true, revision: 1 };
  },
  rememberIdentityAlias: async (chatId, lineage) => {
    calls.push(["alias", chatId, lineage]);
  },
});
assert.equal(result.inherited, true);
assert.equal(result.sourceChatId, "parent-lineage-owner");
assert.equal(result.cutoffFloor, 1);
assert.equal(result.assistantMessageCount, 1);
const persistedGraph = calls.find(([kind]) => kind === "persist")[1];
assert.equal(
  persistedGraph.historyState.hostLineage.conversationId,
  "conversation-child",
);
assert.equal(calls.filter(([kind]) => kind === "alias").length, 1);

let derived = false;
const existing = await inheritHostBranchGraph({
  identity,
  currentChat: context.chat,
  isTargetEmpty: async () => false,
  loadSourceGraph: async () => sourceGraph,
  deriveBranchGraph: () => {
    derived = true;
  },
  persistBranchGraph: async () => ({ accepted: true, saved: true }),
});
assert.equal(existing.reason, "target-already-initialized");
assert.equal(derived, false);

console.log("host-branch-inheritance tests passed");
