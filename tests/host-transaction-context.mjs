import assert from "node:assert/strict";
import {
  areHostContextsInSameBranch,
  buildHostTransactionFence,
  captureHostTransactionContext,
  getActiveSwipeUid,
  getMessageUid,
  normalizeHostTransactionContext,
} from "../runtime/host-transaction-context.js";
import {
  buildChatHistoryFingerprint,
  detectHistoryMutation,
  PROCESSED_MESSAGE_HASH_VERSION,
  snapshotProcessedMessageHashes,
} from "../runtime/runtime-state.js";
import { createConversationSession } from "../runtime/conversation-session.js";
import {
  getGraphIdentityAliasCandidates,
  rememberGraphIdentityAlias,
  resolveGraphIdentityAliasByHostLineage,
} from "../graph/graph-persistence.js";

function hostContext(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: "snapshot",
    conversationId: "conversation-a",
    branchId: "branch-a",
    hostRevision: 7,
    baseHostRevision: 6,
    commitEventId: "commit-7",
    capturedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

assert.deepEqual(normalizeHostTransactionContext(hostContext()), hostContext());
assert.equal(
  normalizeHostTransactionContext(hostContext({ conversationId: "" })),
  null,
);
assert.equal(
  areHostContextsInSameBranch(hostContext(), hostContext({ hostRevision: 8 })),
  true,
);
assert.equal(
  areHostContextsInSameBranch(hostContext(), hostContext({ branchId: "branch-b" })),
  false,
);
assert.deepEqual(
  buildHostTransactionFence(hostContext(), hostContext({ hostRevision: 8, baseHostRevision: 7 })),
  {
    schemaVersion: 1,
    conversationId: "conversation-a",
    branchId: "branch-a",
    sourceHostRevision: 7,
    validatedHostRevision: 8,
    sourceEventId: "commit-7",
    validatedCommitEventId: "commit-7",
  },
);

const metadataContext = {
  chatMetadata: {
    authority: {
      conversationId: "conversation-meta",
      branchId: "branch-meta",
      revision: 3,
      lastEventId: "commit-meta",
    },
  },
  chat: [],
};
const capturedFromMetadata = captureHostTransactionContext({
  context: metadataContext,
  bridge: null,
});
assert.equal(capturedFromMetadata.conversationId, "conversation-meta");
assert.equal(capturedFromMetadata.hostRevision, 3);

const chat = [
  {
    is_user: true,
    mes: "原始文字",
    authority: { messageUid: "message-user" },
  },
  {
    is_user: false,
    mes: "原始回复",
    swipe_id: 0,
    swipe_info: [{ authority: { swipeUid: "swipe-a" } }],
    authority: { messageUid: "message-assistant" },
  },
];
assert.equal(getMessageUid(chat[1]), "message-assistant");
assert.equal(getActiveSwipeUid(chat[1]), "swipe-a");

const processed = snapshotProcessedMessageHashes(chat, 1);
const enrichedChat = structuredClone(chat);
enrichedChat[1].mes += "\n<!-- plugin draft -->";
enrichedChat[1].extra = { generatedImage: "image://late-attachment" };
assert.equal(
  buildChatHistoryFingerprint(enrichedChat),
  buildChatHistoryFingerprint(chat),
  "post-generation content enrichment must not invalidate structural work",
);
const integrityOnly = detectHistoryMutation(enrichedChat, {
  lastProcessedAssistantFloor: 1,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: processed,
});
assert.equal(integrityOnly.dirty, false);
assert.deepEqual(integrityOnly.integrityDriftFloors, [1]);

const rerolledChat = structuredClone(chat);
rerolledChat[1].swipe_info[0].authority.swipeUid = "swipe-b";
const rerolled = detectHistoryMutation(rerolledChat, {
  lastProcessedAssistantFloor: 1,
  processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
  processedMessageHashes: processed,
});
assert.equal(rerolled.dirty, true);
assert.equal(rerolled.earliestAffectedFloor, 1);

const session = createConversationSession();
session.enterChat({
  chatId: "memory-owner",
  hostChatId: "host-chat",
  hostLineage: {
    conversationId: "conversation-a",
    branchId: "branch-a",
    hostRevision: 7,
  },
});
const lease = session.captureLease();
session.enterChat({
  chatId: "memory-owner",
  hostChatId: "host-chat",
  hostLineage: {
    conversationId: "conversation-a",
    branchId: "branch-b",
    hostRevision: 8,
  },
});
assert.equal(session.isLeaseCurrent(lease), false);

const storage = new Map();
globalThis.localStorage = {
  get length() {
    return storage.size;
  },
  key(index) {
    return [...storage.keys()][index] ?? null;
  },
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(String(key), String(value));
  },
};
rememberGraphIdentityAlias({
  integrity: "legacy-memory-owner",
  hostChatId: "host-chat",
  persistenceChatId: "legacy-memory-owner",
  hostConversationId: "conversation-a",
  hostBranchId: "branch-a",
});
assert.deepEqual(
  getGraphIdentityAliasCandidates({
    integrity: "legacy-memory-owner",
    hostChatId: "unregistered-branch-file",
    persistenceChatId: "st-bme-host::conversation-unregistered::branch-unregistered",
    hostConversationId: "conversation-unregistered",
    hostBranchId: "branch-unregistered",
  }),
  [
    "unregistered-branch-file",
    "st-bme-host::conversation-unregistered::branch-unregistered",
  ],
  "a newly discovered branch must not treat its copied parent integrity as an equivalent owner",
);
rememberGraphIdentityAlias({
  integrity: "legacy-memory-owner",
  hostChatId: "branch-file",
  persistenceChatId: "st-bme-host::conversation-child::branch-child",
  hostConversationId: "conversation-child",
  hostBranchId: "branch-child",
});
assert.equal(
  resolveGraphIdentityAliasByHostLineage({
    conversationId: "conversation-a",
    branchId: "branch-a",
  }),
  "legacy-memory-owner",
  "Host Bridge lineage must continue to resolve the existing data owner",
);
assert.equal(
  resolveGraphIdentityAliasByHostLineage({
    conversationId: "conversation-child",
    branchId: "branch-child",
  }),
  "st-bme-host::conversation-child::branch-child",
  "branches sharing an integrity marker must retain their own data owner",
);
assert.equal(
  resolveGraphIdentityAliasByHostLineage({
    conversationId: "conversation-a",
    branchId: "branch-a",
  }),
  "legacy-memory-owner",
  "registering a child lineage must not overwrite its parent owner",
);
rememberGraphIdentityAlias({
  hostChatId: "group-chat-file",
  persistenceChatId: "st-bme-host::conversation-group::branch-group",
  hostConversationId: "conversation-group",
  hostBranchId: "branch-group",
});
assert.equal(
  resolveGraphIdentityAliasByHostLineage({
    conversationId: "conversation-group",
    branchId: "branch-group",
  }),
  "st-bme-host::conversation-group::branch-group",
  "host lineage must remain a usable owner key even when legacy integrity is absent",
);
assert.deepEqual(
  getGraphIdentityAliasCandidates({
    integrity: "legacy-memory-owner",
    hostChatId: "branch-file",
    persistenceChatId: "st-bme-host::conversation-child::branch-child",
    hostConversationId: "conversation-child",
    hostBranchId: "branch-child",
  }),
  [
    "st-bme-host::conversation-child::branch-child",
    "branch-file",
  ],
  "current branch equivalence must not include the parent integrity owner",
);
delete globalThis.localStorage;

console.log("host-transaction-context tests passed");
