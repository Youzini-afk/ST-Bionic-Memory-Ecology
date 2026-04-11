import assert from "node:assert/strict";

import { MODULE_NAME } from "../graph/graph-persistence.js";
import {
  buildRecallRecentMessagesController,
  resolveRecallInputController,
} from "../retrieval/recall-controller.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";

async function testSendIntentCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "旧的 chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "刚触发发送的新输入",
    hash: "hash-phase4-send-intent",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "刚触发发送的新输入");
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, 0);
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);

  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.ok(transaction);
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "刚触发发送的新输入",
  );
  assert.equal(transaction.frozenRecallOptions.lockedSource, "send-intent");
  assert.equal(transaction.frozenRecallOptions.targetUserMessageIndex, 0);
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "旧的 chat tail");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testPlannerHandoffCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "楼层里的稳定用户输入" }];

  const handoff = harness.result.preparePlannerRecallHandoff({
    rawUserInput: "planner 原始输入",
    plannerAugmentedMessage: "planner 增强后的输入",
    plannerRecall: {
      memoryBlock: "规划记忆块",
      recentMessages: ["[user]: planner 原始输入", "[assistant]: 记忆命中"],
      result: {
        selectedNodeIds: ["node-planner-1"],
        stats: {
          coreCount: 1,
          recallCount: 1,
        },
        meta: {
          retrieval: {
            vectorHits: 1,
            vectorMergedHits: 0,
            diffusionHits: 0,
            candidatePoolAfterDpp: 1,
            llm: {
              status: "disabled",
              candidatePool: 0,
            },
          },
        },
      },
    },
    chatId: "chat-main",
  });

  assert.ok(handoff);

  const recallContext = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "normal",
    recallOptions: {},
    chatId: "chat-main",
  });

  assert.equal(recallContext.shouldRun, true);
  assert.equal(recallContext.recallOptions.overrideUserMessage, "planner 原始输入");
  assert.equal(recallContext.recallOptions.overrideSource, "planner-handoff");
  assert.equal(recallContext.recallOptions.authoritativeInputUsed, true);
  assert.equal(
    recallContext.recallOptions.boundUserFloorText,
    "楼层里的稳定用户输入",
  );
  assert.equal(recallContext.recallOptions.includeSyntheticUserMessage, true);
  assert.ok(recallContext.recallOptions.cachedRecallPayload);
  assert.equal(
    recallContext.recallOptions.cachedRecallPayload.source,
    "planner-handoff",
  );

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "planner 原始输入");
  assert.equal(harness.runRecallCalls[0].overrideSource, "planner-handoff");
  assert.equal(harness.runRecallCalls[0].authoritativeInputUsed, true);
  assert.equal(
    harness.runRecallCalls[0].boundUserFloorText,
    "楼层里的稳定用户输入",
  );
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);
  assert.ok(harness.runRecallCalls[0].cachedRecallPayload);
}

async function testAuthoritativeSendIntentStaysFrozenAcrossHooksWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "稳定 chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "第一次权威输入",
    hash: "hash-phase4-frozen-a",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  harness.pendingRecallSendIntent = {
    text: "第二次漂移输入",
    hash: "hash-phase4-frozen-b",
    at: Date.now(),
    source: "dom-intent",
  };
  await harness.result.onBeforeCombinePrompts();

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "第一次权威输入");
  assert.equal(harness.runRecallCalls[0].overrideSource, "send-intent");
  assert.equal(harness.runRecallCalls[0].authoritativeInputUsed, true);
  assert.equal(harness.runRecallCalls[0].boundUserFloorText, "稳定 chat tail");

  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.ok(transaction);
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "第一次权威输入",
  );
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "稳定 chat tail");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testHostSnapshotCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "旧的 chat tail" }];
  const frozenSnapshot = harness.result.freezeHostGenerationInputSnapshot(
    "宿主快照输入",
  );

  await harness.result.onGenerationAfterCommands(
    "normal",
    { frozenInputSnapshot: frozenSnapshot },
    false,
  );

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "宿主快照输入");
  assert.equal(
    harness.runRecallCalls[0].overrideSource,
    "host-generation-lifecycle",
  );
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, 0);
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);
  assert.equal(
    JSON.stringify(
      harness.runRecallCalls[0].sourceCandidates.map((candidate) => candidate.source),
    ),
    JSON.stringify(["host-generation-lifecycle", "chat-tail-user"]),
  );

  const transaction = [...harness.result.generationRecallTransactions.values()][0];
  assert.ok(transaction);
  assert.equal(transaction.frozenRecallOptions.overrideUserMessage, "宿主快照输入");
  assert.equal(
    transaction.frozenRecallOptions.lockedSource,
    "host-generation-lifecycle",
  );
  assert.equal(transaction.frozenRecallOptions.targetUserMessageIndex, 0);
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "旧的 chat tail");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

function testResolveRecallInputControllerAppendsSyntheticAuthoritativeUserMessage() {
  const runtime = {
    normalizeRecallInputText(value = "") {
      return String(value || "").trim();
    },
    buildRecallRecentMessages(chat, limit, syntheticUserMessage = "") {
      return buildRecallRecentMessagesController(chat, limit, syntheticUserMessage, {
        formatRecallContextLine(message) {
          return `[${message?.is_user ? "user" : "assistant"}]: ${String(message?.mes || "")}`;
        },
        normalizeRecallInputText(value = "") {
          return String(value || "").trim();
        },
      });
    },
  };
  const result = resolveRecallInputController(
    [{ is_user: true, mes: "旧的 chat tail" }],
    4,
    {
      overrideUserMessage: "权威输入",
      overrideSource: "send-intent",
      includeSyntheticUserMessage: true,
    },
    runtime,
  );

  assert.equal(result.userMessage, "权威输入");
  assert.equal(result.source, "send-intent");
  assert.equal(result.authoritativeInputUsed, false);
  assert.equal(result.boundUserFloorText, "");
  assert.deepEqual(result.recentMessages, [
    "[user]: 旧的 chat tail",
    "[user]: 权威输入",
  ]);
}

await testSendIntentCanRemainAuthoritativeQueryWhenFlagEnabled();
await testPlannerHandoffCanRemainAuthoritativeQueryWhenFlagEnabled();
await testAuthoritativeSendIntentStaysFrozenAcrossHooksWhenFlagEnabled();
await testHostSnapshotCanRemainAuthoritativeQueryWhenFlagEnabled();
testResolveRecallInputControllerAppendsSyntheticAuthoritativeUserMessage();

console.log("recall-authoritative-generation-input tests passed");
