import assert from "node:assert/strict";

import { MemoryLedgerStoreRouter } from "../host/memory-ledger-store-router.js";

let localCalls = 0;
const localStore = { kind: "local" };
const localConversationRepository = {
  async getStoreForChat() {
    localCalls += 1;
    return localStore;
  },
};

const generic = new MemoryLedgerStoreRouter({
  localConversationRepository,
  resolveHostBinding: async () => ({ hostProfile: "generic-st" }),
});
assert.equal(await generic.getStoreForChat("chat:generic"), localStore);
assert.equal(localCalls, 1);

const unavailable = new MemoryLedgerStoreRouter({
  localConversationRepository,
  resolveHostBinding: async () => ({ hostProfile: "luker", target: null }),
});
await assert.rejects(
  unavailable.getStoreForChat("chat:luker"),
  (error) => error?.code === "luker_memory_ledger_unavailable",
);
assert.equal(localCalls, 1, "Luker must never fall back to browser-local storage");

const fallbackTargets = [];
const lateBinding = new MemoryLedgerStoreRouter({
  localConversationRepository,
  resolveHostBinding: async () => ({
    hostProfile: "luker",
    target: { is_group: true, id: "chat-b" },
    hostAdapter: {
      async readChatState(_namespace, options = {}) {
        fallbackTargets.push(options.target);
        return null;
      },
      async updateChatState() {
        throw new Error("not used");
      },
    },
  }),
});
await assert.rejects(
  lateBinding.getStoreForChat("chat-a"),
  (error) => error?.code === "luker_memory_ledger_unavailable",
  "a late current-host lookup must not bind chat A to chat B",
);
assert.deepEqual(fallbackTargets, [], "an uncaptured Luker target must never be opened");

const capturedTargets = [];
const capturedAdapter = {
  async readChatState(_namespace, options = {}) {
    capturedTargets.push(options.target);
    return null;
  },
  async updateChatState() {
    throw new Error("not used");
  },
};
lateBinding.registerHostBinding("chat-a", {
  hostProfile: "luker",
  target: { is_group: true, id: "chat-a" },
  hostAdapter: capturedAdapter,
});
const capturedStore = await lateBinding.getStoreForChat("chat-a");
assert.equal(capturedStore.targetKey, "group:chat-a");
assert.deepEqual(capturedTargets, [{ is_group: true, id: "chat-a" }]);

console.log("memory ledger store router tests passed");
