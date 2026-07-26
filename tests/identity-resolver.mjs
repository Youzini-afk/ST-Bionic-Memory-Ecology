// ST-BME restrained rebirth — Phase 1 identity resolver characterization.

import assert from "node:assert/strict";
import {
  areChatIdsEquivalentForIdentityCore,
  canMutateRuntimeGraphForIdentityCore,
  doesChatIdMatchIdentityCore,
  planRuntimeGraphIdentityRepairCore,
  resolveActiveHostChatIdCore,
  resolveCurrentChatIdentityCore,
  resolveGraphOwnerIdentityCore,
  resolvePersistenceChatIdCore,
  resolveRuntimeGraphFallbackIdentityCore,
} from "../runtime/identity-resolver.js";

const context = {
  chatId: "host-chat",
  chatMetadata: {
    integrity: "integrity-chat",
  },
  chat: [{ mes: "hello" }],
};

assert.equal(resolveActiveHostChatIdCore({ context }), "host-chat");

const activeIdentity = resolveCurrentChatIdentityCore({
  context,
  resolveAliasByHostChatId: () => "alias-chat",
});
assert.deepEqual(activeIdentity, {
  chatId: "integrity-chat",
  hostChatId: "host-chat",
  integrity: "integrity-chat",
  identitySource: "integrity",
  hasLikelySelectedChat: true,
});

const aliasIdentity = resolveCurrentChatIdentityCore({
  context: { chatId: "host-only", chatMetadata: {}, characterId: "1" },
  resolveAliasByHostChatId: () => "persisted-by-alias",
});
assert.equal(aliasIdentity.chatId, "persisted-by-alias");
assert.equal(aliasIdentity.identitySource, "alias");

console.log("  ✓ active identity is resolved from context and aliases only");

const graph = { historyState: { chatId: "graph-chat" } };
const graphMeta = { chatId: "meta-chat", integrity: "meta-integrity" };
assert.deepEqual(resolveGraphOwnerIdentityCore({ graph, graphMeta }), {
  chatId: "graph-chat",
  source: "history-state",
  integrity: "meta-integrity",
});

assert.deepEqual(
  resolveRuntimeGraphFallbackIdentityCore({
    graph: { historyState: {} },
    graphMeta: {},
    persistenceState: {
      chatId: "state-chat",
      queuedPersistChatId: "queued-chat",
      commitMarker: { chatId: "marker-chat" },
    },
  }),
  { chatId: "state-chat", source: "runtime-fallback" },
);

assert.equal(
  resolvePersistenceChatIdCore({
    explicitChatId: "",
    activeIdentity: { chatId: "" },
    graph: { historyState: { chatId: "graph-owned" } },
    graphMeta: {},
    persistenceState: { chatId: "state-chat" },
  }),
  "graph-owned",
);

console.log("  ✓ graph-owner and runtime fallback identities stay separate");

const identity = {
  chatId: "integrity-chat",
  hostChatId: "host-chat",
  integrity: "integrity-chat",
};
const aliasCandidates = ["alias-chat", "old-host-chat"];
assert.equal(doesChatIdMatchIdentityCore("old-host-chat", { identity, aliasCandidates }), true);
assert.equal(doesChatIdMatchIdentityCore("other-chat", { identity, aliasCandidates }), false);
assert.equal(
  areChatIdsEquivalentForIdentityCore("host-chat", "old-host-chat", {
    identity,
    aliasCandidates,
  }),
  true,
);

console.log("  ✓ equivalence uses explicit identity evidence and aliases");

assert.equal(
  canMutateRuntimeGraphForIdentityCore({
    graph: { historyState: { chatId: "integrity-chat" } },
    activeIdentity: identity,
    graphOwnedChatId: "integrity-chat",
    persistenceState: { loadState: "loaded" },
  }),
  true,
);

assert.equal(
  canMutateRuntimeGraphForIdentityCore({
    graph: { historyState: { chatId: "graph-chat" } },
    activeIdentity: { chatId: "" },
    graphOwnedChatId: "graph-chat",
    persistenceState: {
      chatId: "graph-chat",
      commitMarker: { chatId: "other-chat" },
      loadState: "no-chat",
      dbReady: false,
    },
    allowNoChatState: true,
  }),
  false,
  "wrong-chat commit marker must block no-chat mutation fallback",
);

assert.equal(
  canMutateRuntimeGraphForIdentityCore({
    graph: { historyState: { chatId: "graph-chat" } },
    activeIdentity: { chatId: "" },
    graphOwnedChatId: "graph-chat",
    persistenceState: {
      chatId: "graph-chat",
      commitMarker: { chatId: "graph-chat" },
      loadState: "no-chat",
      dbReady: false,
    },
    allowNoChatState: true,
  }),
  true,
);

console.log("  ✓ runtime mutation fallback preserves no-chat safety checks");

assert.deepEqual(
  planRuntimeGraphIdentityRepairCore({
    graph: { historyState: {} },
    graphOwnedChatId: "",
    stateChatId: "state-chat",
    activeIdentity: { chatId: "" },
    markerChatId: "state-chat",
  }),
  { shouldRepair: true, reason: "repair", chatId: "state-chat" },
);

assert.equal(
  planRuntimeGraphIdentityRepairCore({
    graph: { historyState: {} },
    graphOwnedChatId: "",
    stateChatId: "state-chat",
    activeIdentity: { chatId: "live-chat" },
    markerChatId: "state-chat",
  }).reason,
  "live-chat-mismatch",
);

assert.equal(
  planRuntimeGraphIdentityRepairCore({
    graph: { historyState: {} },
    graphOwnedChatId: "",
    stateChatId: "state-chat",
    activeIdentity: { chatId: "" },
    markerChatId: "other-chat",
  }).reason,
  "commit-marker-chat-mismatch",
);

assert.deepEqual(
  planRuntimeGraphIdentityRepairCore({
    graph: { historyState: { chatId: "already-owned" } },
    graphOwnedChatId: "already-owned",
    stateChatId: "state-chat",
    activeIdentity: { chatId: "" },
  }),
  { shouldRepair: false, reason: "graph-identity-present", chatId: "already-owned" },
);

assert.deepEqual(
  planRuntimeGraphIdentityRepairCore({
    graph: { historyState: {} },
    graphOwnedChatId: "",
    stateChatId: "",
    activeIdentity: { chatId: "" },
  }),
  { shouldRepair: false, reason: "missing-persistence-chat-id" },
);

console.log("  ✓ graph identity repair is planned only with non-conflicting evidence");
console.log("identity-resolver tests passed");
