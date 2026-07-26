import assert from "node:assert/strict";

import { ConversationEngine } from "../../src/core/conversation-engine.js";
import { getHistoryPrefixHash } from "../../src/core/history.js";
import { MemoryStateStore } from "../../src/core/memory-store.js";
import { GenerationCoordinator } from "../../src/generation/generation-coordinator.js";
import {
  classifyGeneration,
  StHostAdapter,
} from "../../src/host/st-host-adapter.js";

const tests = [];
const test = (name, run) => tests.push({ name, run });
const quietLogger = { error() {}, warn() {} };

const userMessage = (text, extra = {}) => ({
  is_user: true,
  is_system: false,
  name: "User",
  mes: text,
  ...extra,
});
const assistantMessage = (text, extra = {}) => ({
  is_user: false,
  is_system: false,
  name: "Assistant",
  mes: text,
  ...extra,
});

function createRuntime(recall) {
  const state = {
    chatId: "chat-a",
    chat: [],
    injections: [],
  };
  const context = {
    get chatId() { return state.chatId; },
    get chat() { return state.chat; },
    name1: "User",
    name2: "Assistant",
    setExtensionPrompt(...args) {
      state.injections.push(args);
    },
  };
  let clock = 1000;
  let id = 0;
  const store = new MemoryStateStore({ now: () => ++clock, id: () => `tx-${++id}` });
  const engine = new ConversationEngine({ store });
  const host = new StHostAdapter({ getContext: () => context, logger: quietLogger });
  const coordinator = new GenerationCoordinator({
    engine,
    host,
    recall,
    logger: quietLogger,
  });
  return { state, context, store, engine, host, coordinator };
}

function nonEmptyInjections(runtime) {
  return runtime.state.injections.map(([, value]) => value).filter(Boolean);
}

test("generation classification has one explicit no-new-user path", () => {
  assert.equal(classifyGeneration("normal").kind, "fresh-candidate");
  for (const type of ["swipe", "regenerate", "continue"]) {
    assert.equal(classifyGeneration(type).kind, "no-new-user");
  }
  assert.equal(classifyGeneration("quiet").kind, "skip");
  assert.equal(classifyGeneration("normal", { automatic_trigger: true }).kind, "skip");
  assert.equal(classifyGeneration("normal", {}, true).kind, "skip");
});

test("host snapshots use stable message ids and ignore unrelated metadata", () => {
  const runtime = createRuntime(async () => ({}));
  runtime.state.chat.push(
    userMessage("same", { send_date: 1, extra: { transient: true } }),
    { is_user: false, is_system: true, name: "System", mes: "hidden", extra: { isSmallSys: true } },
    assistantMessage("reply", { swipe_id: 9 }),
  );
  const snapshot = runtime.host.snapshotConversation();
  assert.deepEqual(snapshot.messages.map(({ role, text, hostIndex }) => ({ role, text, hostIndex })), [
    { role: "user", text: "same", hostIndex: 0 },
    { role: "assistant", text: "reply", hostIndex: 2 },
  ]);
  assert.equal(runtime.host.findUserByHostIndex(snapshot, 0).text, "same");
  assert.equal(runtime.host.findUserByHostIndex(snapshot, 1), null);
});

test("reroll replays the exact first recall and rolls back the old assistant transaction", async () => {
  let recallCalls = 0;
  const runtime = createRuntime(async ({ input }) => {
    recallCalls += 1;
    return {
      selectedNodeIds: ["memory-1"],
      injectionText: `MEMORY:${input}`,
      tokenEstimate: 4,
    };
  });
  await runtime.coordinator.onChatChanged();
  await runtime.coordinator.onGenerationStarted("normal");
  runtime.state.chat.push(userMessage("question"));
  const fresh = await runtime.coordinator.onMessageSent(0);
  assert.equal(fresh.source, "fresh");
  assert.equal(fresh.injectionText, "MEMORY:question");
  runtime.state.chat.push(assistantMessage("first answer"));
  await runtime.coordinator.onMessageReceived(1, "normal");
  runtime.coordinator.onGenerationFinished();

  let conversation = await runtime.store.readConversation("chat-a");
  await runtime.store.commit({
    chatKey: "chat-a",
    expectedRevision: conversation.head.revision,
    operation: "extract",
    basisHistoryLength: 2,
    basisHistoryHash: getHistoryPrefixHash(conversation.head.history, 2),
    processedThroughAfter: 1,
    changeSet: {
      changes: [
        { collection: "nodes", id: "old-answer", before: null, after: { id: "old-answer" } },
      ],
    },
  });

  runtime.state.chat[1] = assistantMessage("");
  await runtime.coordinator.onGenerationStarted("swipe");
  const reroll = await runtime.coordinator.onBeforeCombinePrompts();
  conversation = await runtime.store.readConversation("chat-a");
  assert.equal(reroll.source, "replay", reroll.error?.stack);
  assert.equal(reroll.injectionText, fresh.injectionText);
  assert.deepEqual(reroll.selectedNodeIds, fresh.selectedNodeIds);
  assert.equal(recallCalls, 1);
  assert.equal(conversation.collections.nodes.has("old-answer"), false);
  assert.equal(nonEmptyInjections(runtime).at(-1), "MEMORY:question");

  runtime.coordinator.onGenerationFinished();
  await runtime.coordinator.onGenerationStarted("normal");
  const inferredReroll = await runtime.coordinator.onBeforeCombinePrompts();
  assert.equal(inferredReroll.source, "replay");
  assert.equal(recallCalls, 1);
});

test("a missing reroll record performs one fresh fallback and persists it", async () => {
  let recallCalls = 0;
  const runtime = createRuntime(async ({ input }) => {
    recallCalls += 1;
    return { injectionText: `FALLBACK:${input}`, selectedNodeIds: [], tokenEstimate: 1 };
  });
  runtime.state.chat.push(userMessage("orphan"));
  await runtime.coordinator.onChatChanged();
  await runtime.coordinator.onGenerationStarted("regenerate");
  const fallback = await runtime.coordinator.onBeforeCombinePrompts();
  assert.equal(fallback.source, "fresh-fallback");
  runtime.coordinator.onGenerationFinished();

  await runtime.coordinator.onGenerationStarted("regenerate");
  const replay = await runtime.coordinator.onBeforeCombinePrompts();
  assert.equal(replay.source, "replay");
  assert.equal(replay.injectionText, fallback.injectionText);
  assert.equal(recallCalls, 1);
});

test("a late recall from chat A cannot inject or persist after switching to chat B", async () => {
  let releaseRecall;
  let recallStarted;
  const started = new Promise((resolve) => { recallStarted = resolve; });
  const runtime = createRuntime(async () => {
    recallStarted();
    await new Promise((resolve) => { releaseRecall = resolve; });
    return { injectionText: "LATE-A", selectedNodeIds: ["late"], tokenEstimate: 1 };
  });
  await runtime.coordinator.onChatChanged();
  await runtime.coordinator.onGenerationStarted("normal");
  runtime.state.chat.push(userMessage("chat a"));
  const pending = runtime.coordinator.onMessageSent(0);
  await started;

  runtime.state.chatId = "chat-b";
  runtime.state.chat = [userMessage("chat b")];
  await runtime.coordinator.onChatChanged();
  releaseRecall();
  const result = await pending;

  assert.equal(result.status, "aborted");
  assert.equal(nonEmptyInjections(runtime).includes("LATE-A"), false);
  assert.equal((await runtime.store.readConversation("chat-a")).recallRecords.size, 0);
  assert.equal((await runtime.store.readConversation("chat-b")).recallRecords.size, 0);
});

test("editing the parent user invalidates the old recall before reroll fallback", async () => {
  let recallCalls = 0;
  const runtime = createRuntime(async ({ input }) => {
    recallCalls += 1;
    return { injectionText: `R${recallCalls}:${input}`, selectedNodeIds: [], tokenEstimate: 1 };
  });
  await runtime.coordinator.onChatChanged();
  await runtime.coordinator.onGenerationStarted("normal");
  runtime.state.chat.push(userMessage("original"));
  await runtime.coordinator.onMessageSent(0);
  runtime.coordinator.onGenerationFinished();

  runtime.state.chat[0] = userMessage("edited");
  await runtime.coordinator.onHistoryChanged("edited", 0);
  await runtime.coordinator.onGenerationStarted("regenerate");
  const result = await runtime.coordinator.onBeforeCombinePrompts();
  assert.equal(result.source, "fresh-fallback");
  assert.equal(result.injectionText, "R2:edited");
  assert.equal(recallCalls, 2);
});

test("a manual edit while recall is running prevents the late result from injecting", async () => {
  let releaseRecall;
  let recallStarted;
  const started = new Promise((resolve) => { recallStarted = resolve; });
  const runtime = createRuntime(async () => {
    recallStarted();
    await new Promise((resolve) => { releaseRecall = resolve; });
    return { injectionText: "STALE", selectedNodeIds: [], tokenEstimate: 1 };
  });
  await runtime.coordinator.onChatChanged();
  await runtime.coordinator.onGenerationStarted("normal");
  runtime.state.chat.push(userMessage("before edit"));
  const pending = runtime.coordinator.onMessageSent(0);
  await started;

  runtime.state.chat[0] = userMessage("after edit");
  await runtime.coordinator.onHistoryChanged("edited", 0);
  releaseRecall();
  const result = await pending;
  assert.equal(result.status, "aborted");
  assert.equal(nonEmptyInjections(runtime).includes("STALE"), false);
  assert.equal((await runtime.store.readConversation("chat-a")).recallRecords.size, 0);
});

let passed = 0;
for (const { name, run } of tests) {
  await run();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}
console.log(`vNext generation: ${passed}/${tests.length} passed`);
