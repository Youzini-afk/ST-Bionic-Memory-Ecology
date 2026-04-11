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
await testHostSnapshotCanRemainAuthoritativeQueryWhenFlagEnabled();
testResolveRecallInputControllerAppendsSyntheticAuthoritativeUserMessage();

console.log("recall-authoritative-generation-input tests passed");
