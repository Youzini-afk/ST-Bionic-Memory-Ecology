import assert from "node:assert/strict";

import { createEmptyGraph } from "../graph/graph.js";
import {
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
} from "../sync/bme-db.js";
import { createHostBranchInheritanceController } from "../runtime/host-branch-inheritance-controller.js";
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

const controllerSourceGraph = createEmptyGraph();
controllerSourceGraph.historyState.chatId = "parent-lineage-owner";
controllerSourceGraph.historyState.hostLineage = {
  conversationId: "conversation-parent",
  branchId: "branch-parent",
  hostRevision: 9,
};
controllerSourceGraph.nodes = [
  { id: "keep-node", type: "event", seq: 1, seqRange: [0, 1] },
  { id: "cut-node", type: "event", seq: 3, seqRange: [2, 3] },
];
controllerSourceGraph.edges = [
  { id: "cut-edge", fromId: "keep-node", toId: "cut-node", relation: "next" },
];
const sourceSnapshot = buildSnapshotFromGraph(controllerSourceGraph, {
  chatId: "parent-lineage-owner",
  revision: 9,
});
let targetSnapshot = null;
const controllerCalls = [];
const sourceDb = {
  async exportSnapshot(options) {
    controllerCalls.push(["source-export", options]);
    return sourceSnapshot;
  },
};
const targetDb = {
  async isEmpty() {
    return { empty: true };
  },
  async importSnapshot(snapshot, options) {
    controllerCalls.push(["target-import", options]);
    targetSnapshot = snapshot;
    return { revision: 1 };
  },
  async exportSnapshot() {
    return targetSnapshot;
  },
};
const controller = createHostBranchInheritanceController({
  getContext: () => context,
  resolveCurrentIdentity: () => identity,
  getRepository: () => ({
    getStoreForChat: async (chatId) =>
      chatId === "parent-lineage-owner" ? sourceDb : targetDb,
  }),
  getGraphOwnedChatId: (graph) => graph?.historyState?.chatId,
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
  isAuthorityStore: () => false,
  cacheLocalSnapshot: (chatId) => controllerCalls.push(["cache", chatId]),
  rememberIdentityAlias: (entry) => controllerCalls.push(["alias", entry]),
  persistCommitMarker: (_context, marker) => controllerCalls.push(["marker", marker]),
});
const controlled = await controller.ensure(identity, null);
assert.equal(controlled.inherited, true);
assert.deepEqual(
  controllerCalls.find(([kind]) => kind === "source-export")[1],
  { includeTombstones: true, allowCrossLineageRead: true },
);
assert.deepEqual(targetSnapshot.nodes.map((node) => node.id), ["keep-node"]);
assert.deepEqual(targetSnapshot.edges, []);
assert.equal(targetSnapshot.meta.hostBranchId, "branch-child");
assert.equal(controllerCalls.filter(([kind]) => kind === "alias").length, 1);
assert.equal(controllerCalls.filter(([kind]) => kind === "marker").length, 1);

console.log("host-branch-inheritance tests passed");
