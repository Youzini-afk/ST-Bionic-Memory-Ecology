// wired into npm run test:all
import assert from "node:assert/strict";
import { MODULE_NAME } from "../graph/graph-persistence.js";
import { isTrivialUserInput } from "../ui/ui-status.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";

function assertEmptyRecallInputRecord(record) {
  assert.deepEqual(record, {
    text: "",
    hash: "",
    messageId: null,
    source: "",
    at: 0,
  });
}

function testIsTrivialUserInputTable() {
  const cases = [
    ["", true, "empty"],
    ["   \n\t ", true, "empty"],
    ["/echo hello", true, "slash-command"],
    ["/", true, "slash-command"],
    [" /echo", true, "slash-command"],
    ["a", false, ""],
    ["好", false, ""],
    ["ok", false, ""],
    ["ok a", false, ""],
    ["好的", false, ""],
    ["好的呀", false, ""],
    ["hello world", false, ""],
    ["你好", false, ""],
  ];

  for (const [input, trivial, reason] of cases) {
    const result = isTrivialUserInput(input);
    assert.equal(result.trivial, trivial, `trivial mismatch for ${JSON.stringify(input)}`);
    assert.equal(result.reason, reason, `reason mismatch for ${JSON.stringify(input)}`);
  }
}

async function testSlashCommandSkipsRecallAndExtraction() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [];
  harness.__sendTextareaValue = "/echo test";

  const startResult = harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(startResult, null);
  assertEmptyRecallInputRecord(harness.result.getPendingHostGenerationInputSnapshot());
  assertEmptyRecallInputRecord(harness.pendingRecallSendIntent);
  assert.equal(
    harness.result.getCurrentGenerationTrivialSkip()?.generationStartMinChatIndex,
    0,
  );

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  assert.equal(harness.runRecallCalls.length, 0);

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.deepEqual(beforeCombine, {
    skipped: true,
    reason: "trivial:slash-command",
  });
  assert.equal(harness.runRecallCalls.length, 0);

  harness.chat.push({ is_user: false, mes: "assistant reply" });
  harness.invokeOnMessageReceived(0, "");
  assert.equal(harness.runExtractionCalls.length, 0);
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);
}

async function testEmptyInputSkipsPriorHistoryFallback() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "older real user message" }];
  harness.__sendTextareaValue = "   ";

  const startResult = harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(startResult, null);
  assert.equal(
    harness.result.getCurrentGenerationTrivialSkip()?.reason,
    "empty",
  );

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  assert.equal(harness.runRecallCalls.length, 0);

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.deepEqual(beforeCombine, {
    skipped: true,
    reason: "trivial:empty",
  });
}

async function testNormalInputStillRecalls() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [];
  harness.__sendTextareaValue = "好的呀";

  const snapshot = harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(snapshot?.text, "好的呀");
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.equal(beforeCombine?.source, "fresh");
  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "好的呀");
}

async function testSentinelBlocksHistoryFallback() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "真实旧消息" }];
  harness.pendingRecallSendIntent = {
    text: "/echo hidden",
    source: "send-button",
    at: Date.now(),
  };

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.deepEqual(beforeCombine, {
    skipped: true,
    reason: "trivial:slash-command",
  });
  assert.equal(harness.runRecallCalls.length, 0);
}

async function testAfterCommandsTrivialSentinelMarksExtractionBypass() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "/echo from chat tail" }];

  await harness.result.onGenerationAfterCommands("normal", {}, false);
  assert.equal(harness.runRecallCalls.length, 0);
  assert.equal(
    harness.result.getCurrentGenerationTrivialSkip()?.generationStartMinChatIndex,
    1,
  );

  harness.chat.push({ is_user: false, mes: "assistant after bypass flag" });
  harness.invokeOnMessageReceived(1, "");
  assert.equal(harness.runExtractionCalls.length, 0);
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);
}

async function testPlannerRecallTrivialAndNonTrivialPaths() {
  const harness = await createGenerationRecallHarness();

  let recall = await harness.result.runPlannerRecallForEna({
    rawUserInput: "",
  });
  assert.equal(recall.reason, "trivial-user-input:empty");

  recall = await harness.result.runPlannerRecallForEna({
    rawUserInput: "/echo",
  });
  assert.equal(recall.reason, "trivial-user-input:slash-command");

  harness.extension_settings[MODULE_NAME] = {
    enabled: true,
    recallEnabled: true,
  };
  harness.result.setGraphPersistenceState({
    loadState: "loaded",
    dbReady: true,
  });
  harness.currentGraph = {
    nodes: [],
    edges: [],
    historyState: {},
  };
  recall = await harness.result.runPlannerRecallForEna({
    rawUserInput: "好的呀",
  });
  assert.equal(recall.reason, "graph-empty");
}

async function testOnMessageSentSkipsTrivialText() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "/echo" }];

  harness.invokeOnMessageSent(0);

  assert.equal(harness.lastRecallSentUserMessage.text, "");
}

async function testNonTrivialGenerationClearsResidualTrivialSkip() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [];
  harness.result.setGraphPersistenceState({
    loadState: "loaded",
    dbReady: true,
  });
  harness.currentGraph = {
    nodes: [],
    edges: [],
    historyState: {},
  };
  harness.__sendTextareaValue = "/echo";
  harness.result.onGenerationStarted("normal", {}, false);
  assert.ok(harness.result.getCurrentGenerationTrivialSkip());

  harness.__sendTextareaValue = "hello world";
  const snapshot = harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(snapshot?.text, "hello world");
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);

  harness.chat.push({ is_user: false, mes: "assistant after non-trivial" });
  harness.invokeOnMessageReceived(0, "");
  const pending = harness.result.getPendingAutoExtraction();
  assert.equal(pending?.messageId, 0);
  assert.equal(pending?.reason, "generation-running");
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);
  harness.result.clearPendingAutoExtraction();
}

async function testNonTargetMessageIdDoesNotConsumeFlag() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [
    { is_user: true, mes: "u0" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "old assistant" },
    { is_user: true, mes: "u4" },
  ];
  harness.result.setGraphPersistenceState({
    loadState: "loaded",
    dbReady: true,
  });
  harness.currentGraph = {
    nodes: [],
    edges: [],
    historyState: {},
  };
  harness.__sendTextareaValue = "/echo";
  harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(
    harness.result.getCurrentGenerationTrivialSkip()?.generationStartMinChatIndex,
    5,
  );

  harness.invokeOnMessageReceived(3, "");
  const pendingBeforeTarget = harness.result.getPendingAutoExtraction();
  assert.equal(pendingBeforeTarget?.messageId, 3);
  assert.equal(pendingBeforeTarget?.reason, "generation-running");
  assert.equal(harness.runExtractionCalls.length, 0);
  assert.ok(harness.result.getCurrentGenerationTrivialSkip());

  harness.chat.push({ is_user: false, mes: "target assistant" });
  harness.invokeOnMessageReceived(5, "");
  assert.equal(harness.runExtractionCalls.length, 0);
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);
  harness.result.clearPendingAutoExtraction();
}

async function testNullMessageIdFallsBackToLastAssistantIndex() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [
    { is_user: true, mes: "u0" },
    { is_user: false, mes: "a1" },
    { is_user: true, mes: "u2" },
    { is_user: false, mes: "a3" },
    { is_user: true, mes: "u4" },
  ];
  harness.__sendTextareaValue = "/echo";
  harness.result.onGenerationStarted("normal", {}, false);

  harness.chat.push({ is_user: false, mes: "latest assistant" });
  harness.invokeOnMessageReceived(null, "");
  assert.equal(harness.runExtractionCalls.length, 0);
  assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);
}

async function testSkipFlagTtlExpires() {
  const harness = await createGenerationRecallHarness();
  harness.result.markCurrentGenerationTrivialSkip({
    reason: "slash-command",
    chatId: "chat-main",
    chatLength: 2,
  });
  const originalNow = Date.now;
  Date.now = () => originalNow() + 60001;
  try {
    assert.equal(harness.result.consumeCurrentGenerationTrivialSkip(2), false);
    assert.equal(harness.result.getCurrentGenerationTrivialSkip(), null);
  } finally {
    Date.now = originalNow;
  }
}

async function testPromptViewerSyntheticGenerationSkipsRecall() {
  const harness = await createGenerationRecallHarness();
  const fakeDialog = {
    textContent: "Prompt Viewer",
    querySelector(selector) {
      if (selector === ".fa-rotate-right.animate-spin") {
        return {};
      }
      return null;
    },
  };
  harness.document.querySelectorAll = (selector) =>
    selector === '[role="dialog"]' ? [fakeDialog] : [];
  harness.__sendTextareaValue = "hello world";

  const startResult = harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(startResult, null);
  assert.equal(
    harness.result.getCurrentGenerationTrivialSkip()?.reason,
    "tavern-helper-prompt-viewer",
  );

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.deepEqual(beforeCombine, {
    skipped: true,
    reason: "tavern-helper-prompt-viewer",
  });
  assert.equal(harness.runRecallCalls.length, 0);
}

await Promise.resolve();
testIsTrivialUserInputTable();
await testSlashCommandSkipsRecallAndExtraction();
await testEmptyInputSkipsPriorHistoryFallback();
await testNormalInputStillRecalls();
await testSentinelBlocksHistoryFallback();
await testAfterCommandsTrivialSentinelMarksExtractionBypass();
await testPlannerRecallTrivialAndNonTrivialPaths();
await testOnMessageSentSkipsTrivialText();
await testNonTrivialGenerationClearsResidualTrivialSkip();
await testNonTargetMessageIdDoesNotConsumeFlag();
await testNullMessageIdFallsBackToLastAssistantIndex();
await testSkipFlagTtlExpires();
await testPromptViewerSyntheticGenerationSkipsRecall();

console.log("trivial-user-input tests passed");
