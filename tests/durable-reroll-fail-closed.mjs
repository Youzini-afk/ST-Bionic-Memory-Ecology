import assert from "node:assert/strict";

import { buildRecallHistoryFingerprint } from "../retrieval/recall-persistence.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";

function cachedUserFloor(text, injectionText) {
  const message = { is_user: true, mes: text };
  const historyFingerprint = buildRecallHistoryFingerprint([message], 0);
  message.extra = {
    bme_recall: {
      version: 4,
      completed: true,
      empty: false,
      injectionText,
      selectedNodeIds: ["memory:cached"],
      candidateNodeIds: ["memory:cached"],
      recallInput: text,
      boundUserFloorText: text,
      historyFingerprint,
      artifactHistoryFingerprint: historyFingerprint,
      artifactId: "artifact:missing-from-ledger",
      turnId: "turn:cached",
      inputFingerprint: "input:cached",
      memoryStateFingerprint: "memory-state:cached",
    },
  };
  return message;
}

function stalePromptData() {
  return {
    finalMesSend: [
      {
        injected: false,
        message: "reroll floor",
        extensionPrompts: [
          "[BEGIN ST-BME MEMORY CONTEXT]\nSTALE-PROMPT-CACHE\n[END ST-BME MEMORY CONTEXT]\n",
        ],
      },
    ],
  };
}

{
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.chat = [
    cachedUserFloor("reroll floor", "CACHE-SHOULD-NOT-INJECT"),
    { is_user: false, mes: "assistant", is_system: false },
  ];
  harness.result.beginGeneration("regenerate");
  harness.validateNoNewUserTurnArtifacts = async () => ({
    valid: false,
    reason: "missing-recall-artifact",
  });
  const promptData = stalePromptData();

  const result = await harness.result.onBeforeCombinePrompts(promptData);

  assert.equal(result.skipped, true);
  assert.equal(result.artifactUnavailable, true);
  assert.equal(result.applicationMode, "fail-closed");
  assert.equal(result.source, "none");
  assert.equal(harness.runRecallCalls.length, 0);
  assert.deepEqual(harness.moduleInjectionCalls, [""]);
  assert.equal(
    JSON.stringify(promptData).includes("ST-BME MEMORY CONTEXT"),
    false,
    "fail-closed reroll must scrub any already-built prompt payload",
  );
  assert.equal(
    harness.moduleInjectionCalls.includes("CACHE-SHOULD-NOT-INJECT"),
    false,
    "message cache must never bypass the durable artifact guard",
  );
}

{
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.chat = [
    cachedUserFloor("reroll floor", "CACHE-SHOULD-NOT-CROSS-CHAT"),
    { is_user: false, mes: "assistant", is_system: false },
  ];
  harness.result.beginGeneration("regenerate");
  let releaseValidation;
  harness.validateNoNewUserTurnArtifacts = () =>
    new Promise((resolve) => {
      releaseValidation = resolve;
    });
  const promptData = stalePromptData();
  const pending = harness.result.onBeforeCombinePrompts(promptData);
  await Promise.resolve();
  harness.enterConversation("chat:other");
  releaseValidation({ valid: false, reason: "missing-planner-artifact" });

  const result = await pending;

  assert.equal(result.stale, true);
  assert.equal(harness.moduleInjectionCalls.length, 0);
  assert.equal(JSON.stringify(promptData).includes("ST-BME MEMORY CONTEXT"), false);
}

console.log("durable reroll fail-closed tests passed");
