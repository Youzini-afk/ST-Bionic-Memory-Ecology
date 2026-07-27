import assert from "node:assert/strict";

import { ConversationRepository } from "../sync/conversation-repository.js";

let selectedKey = "indexeddb:indexeddb";
let resolveCount = 0;
let createCount = 0;
const closed = [];

const repository = new ConversationRepository({
  resolveBinding: async () => {
    resolveCount += 1;
    const [storagePrimary, storageMode] = selectedKey.split(":");
    return { storagePrimary, storageMode };
  },
  bindingKey: (presentation) =>
    `${presentation.storagePrimary}:${presentation.storageMode}`,
  storeFactory: async (chatId, binding) => {
    createCount += 1;
    return {
      chatId,
      binding,
      openCount: 0,
      async open() {
        this.openCount += 1;
      },
      async close() {
        closed.push(`${chatId}:${binding.key}`);
      },
    };
  },
});

const [first, concurrent] = await Promise.all([
  repository.getStore("chat-a"),
  repository.getStore("chat-a"),
]);
assert.equal(first, concurrent);
assert.equal(resolveCount, 1);
assert.equal(createCount, 1);
assert.equal(first.openCount, 1);
assert.equal(repository.getBinding("chat-a").key, "indexeddb:indexeddb");

selectedKey = "opfs:opfs-primary";
assert.equal(await repository.getStore("chat-a"), first);
assert.equal(resolveCount, 1, "ordinary access must not silently change the durable primary");

const rebound = await repository.rebind("chat-a");
assert.notEqual(rebound, first);
assert.equal(repository.getBinding("chat-a").key, "opfs:opfs-primary");
assert.deepEqual(closed, ["chat-a:indexeddb:indexeddb"]);

await repository.switchChat("chat-b");
assert.equal(repository.getCurrentChatId(), "chat-b");
await repository.closeAll();
assert.equal(repository.getCurrentChatId(), "");
assert.deepEqual(closed.sort(), [
  "chat-a:indexeddb:indexeddb",
  "chat-a:opfs:opfs-primary",
  "chat-b:opfs:opfs-primary",
]);

console.log("conversation-repository tests passed");
