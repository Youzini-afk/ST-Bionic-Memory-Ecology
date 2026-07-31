import assert from "node:assert/strict";
import {
  BME_CHAT_IDENTITY_METADATA_KEY,
  ConversationIdentityConflictError,
  ConversationIdentityRegistry,
  resolveConversationIdentity,
} from "../host/conversation-identity.js";

const registry = new ConversationIdentityRegistry();
const root = resolveConversationIdentity(
  {
    chatId: "erin-main.jsonl",
    chatMetadata: { integrity: "shared-integrity" },
  },
  { registry },
);
assert.equal(root.identity.parentChatId, "");
assert.equal(root.identity.branchCutoff, null);

// A second chat for the same character has a different integrity and storage id.
const otherChat = resolveConversationIdentity(
  {
    chatId: "erin-other.jsonl",
    chatMetadata: { integrity: "other-integrity" },
  },
  { registry },
);
assert.notEqual(otherChat.identity.chatId, root.identity.chatId);

// Rename keeps the root identity and records both host locators.
const renamed = resolveConversationIdentity(
  {
    chatId: "erin-renamed.jsonl",
    chatMetadata: { integrity: "shared-integrity" },
  },
  { registry },
);
assert.equal(renamed.identity.chatId, root.identity.chatId);
assert.deepEqual(
  new Set(renamed.identity.hostChatIds),
  new Set(["erin-main.jsonl", "erin-renamed.jsonl"]),
);

// ST branches inherit integrity. main_chat/branch metadata must still produce
// an independent chat id while retaining lineage and parent provenance.
const branch = resolveConversationIdentity(
  {
    chatId: "erin-branch.jsonl",
    chatMetadata: {
      integrity: "shared-integrity",
      main_chat: "erin-main.jsonl",
    },
  },
  { registry, branch: { cutoffFloor: 8, branchName: "route-b" } },
);
assert.notEqual(branch.identity.chatId, root.identity.chatId);
assert.equal(branch.identity.lineageId, root.identity.lineageId);
assert.equal(branch.identity.parentChatId, root.identity.chatId);
assert.equal(branch.identity.branchCutoff, 8);

const restoredBranch = resolveConversationIdentity(
  {
    chatId: "branch-renamed.jsonl",
    chatMetadata: {
      integrity: "shared-integrity",
      [BME_CHAT_IDENTITY_METADATA_KEY]: branch.identity,
    },
  },
  { registry },
);
assert.equal(restoredBranch.identity.chatId, branch.identity.chatId);
assert.ok(restoredBranch.identity.hostChatIds.includes("branch-renamed.jsonl"));

assert.throws(
  () =>
    registry.register({
      chatId: "chat:conflict",
      lineageId: "lineage:conflict",
      hostChatId: "erin-main.jsonl",
      integrity: "conflicting-integrity",
    }),
  ConversationIdentityConflictError,
);
assert.equal(registry.findByHostChatId("erin-main.jsonl").chatId, root.identity.chatId);

assert.throws(
  () =>
    resolveConversationIdentity(
      {
        chatId: "erin-main.jsonl",
        chatMetadata: { integrity: "conflicting-integrity" },
      },
      { registry },
    ),
  ConversationIdentityConflictError,
);

assert.throws(() => resolveConversationIdentity({}, { registry }), /requires hostChatId or integrity/);

console.log("vNext conversation identity tests passed");
