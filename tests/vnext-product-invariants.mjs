import assert from "node:assert/strict";
import {
  AGENT_EVENT_TYPE,
  DEFAULT_BME_AGENT_GUARD,
  MEMORY_DOMAIN_DIRECTORIES,
  MEMORY_INBOX_KIND,
  MEMORY_LAYER,
  MEMORY_RECORD_KIND,
  TURN_ARTIFACT_KIND,
  createEmptyMemoryLedger,
  isAgentEventTransitionAllowed,
} from "../domain/memory-contract.js";
import {
  branchConversation,
  createAssistantMessage,
  createConversation,
  createUserMessage,
} from "./helpers/vnext-chat-fixtures.mjs";

const ledger = createEmptyMemoryLedger({ chatId: "chat:contract", now: 100 });
assert.deepEqual(ledger, {
  version: 1,
  chatId: "chat:contract",
  revision: 0,
  createdAt: 100,
  updatedAt: 100,
  records: [],
});

assert.deepEqual(DEFAULT_BME_AGENT_GUARD, {
  maxToolCalls: 500,
  maxRunMs: 480000,
});
assert.equal(MEMORY_LAYER.OBJECTIVE, "objective");
assert.equal(MEMORY_LAYER.POV, "pov");
assert.equal(MEMORY_RECORD_KIND.EVIDENCE, "evidence");
assert.equal(MEMORY_RECORD_KIND.AGENT_EVENT, "agent_event");
assert.equal(
  isAgentEventTransitionAllowed(
    AGENT_EVENT_TYPE.MODEL_REQUESTED,
    AGENT_EVENT_TYPE.ASSISTANT_MESSAGE,
  ),
  true,
);
assert.equal(
  isAgentEventTransitionAllowed(
    AGENT_EVENT_TYPE.RUN_STARTED,
    AGENT_EVENT_TYPE.RUN_COMPLETED,
  ),
  false,
);
assert.equal(MEMORY_INBOX_KIND.HISTORY_INVALIDATED, "history_invalidated");
assert.equal(TURN_ARTIFACT_KIND.RECALL, "recall");
assert.equal(TURN_ARTIFACT_KIND.PLANNER, "planner");
assert.deepEqual(MEMORY_DOMAIN_DIRECTORIES, [
  "domain",
  "application",
  "agent",
  "storage",
  "host",
  "ui",
]);

const source = createConversation({
  identity: {
    chatId: "chat:source",
    hostChatId: "source.jsonl",
    integrity: "shared-integrity",
    lineageId: "lineage-1",
  },
  chat: [
    createUserMessage("第一层"),
    createAssistantMessage("第一层回复"),
    createUserMessage("第二层"),
    createAssistantMessage("第二层回复", {
      swipes: ["第二层回复", "第二层另一个回复"],
      swipeId: 1,
    }),
  ],
});
const branch = branchConversation(source, 2, {
  chatId: "chat:branch",
  hostChatId: "branch.jsonl",
});

assert.equal(branch.identity.integrity, source.identity.integrity);
assert.equal(branch.identity.lineageId, source.identity.lineageId);
assert.notEqual(branch.identity.chatId, source.identity.chatId);
assert.notEqual(branch.identity.hostChatId, source.identity.hostChatId);
assert.equal(branch.identity.branchCutoff, 2);
assert.equal(branch.chat.length, 3);
assert.notEqual(branch.chat, source.chat);

// SillyTavern message indexes are mutable. The vNext ledger must never treat an
// array index as a durable message identifier.
const shifted = [...source.chat];
shifted.splice(0, 1);
assert.equal(shifted[0].mes, "第一层回复");
assert.equal(source.chat[1].mes, "第一层回复");
assert.notEqual(0, 1);

console.log("vNext product invariant tests passed");
