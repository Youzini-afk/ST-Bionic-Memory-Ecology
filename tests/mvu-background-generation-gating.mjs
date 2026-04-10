import assert from "node:assert/strict";
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

async function testMvuExtraAnalysisSkipsRecallHooks() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "主线用户输入" }];
  harness.__sendTextareaValue = "主线用户输入";
  harness.Mvu = {
    isDuringExtraAnalysis: () => true,
  };

  const started = harness.result.onGenerationStarted("normal", {}, false);
  assert.equal(started, null);

  const workload = harness.result.getCurrentGenerationWorkload();
  assert.equal(workload?.kind, "background-plugin");
  assert.equal(workload?.backgroundReason, "mvu-extra-analysis");
  assert.ok(workload?.sourceEvidence.includes("mvu-runtime-method"));
  assertEmptyRecallInputRecord(
    harness.result.getPendingHostGenerationInputSnapshot(),
  );

  const afterCommands = await harness.result.onGenerationAfterCommands(
    "normal",
    {},
    false,
  );
  assert.deepEqual(afterCommands, {
    skipped: true,
    reason: "background-generation:mvu-extra-analysis",
  });

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.deepEqual(beforeCombine, {
    skipped: true,
    reason: "background-generation:mvu-extra-analysis",
  });

  assert.equal(harness.runRecallCalls.length, 0);
}

async function testBackgroundGenerationMessageReceiveDoesNotTriggerExtraction() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [
    { is_user: true, mes: "用户输入" },
    { is_user: false, mes: "后台生成回复" },
  ];
  harness.currentGraph = {
    nodes: [{ id: "node-a" }],
    edges: [],
    historyState: {},
  };
  harness.result.setGraphPersistenceState({
    loadState: "loaded",
    dbReady: true,
  });
  harness.Mvu = {
    isDuringExtraAnalysis: () => true,
  };

  harness.result.onGenerationStarted("normal", {}, false);
  harness.invokeOnMessageReceived(1, "");

  assert.equal(harness.runExtractionCalls.length, 0);
  const pendingAutoExtraction = harness.result.getPendingAutoExtraction();
  assert.equal(pendingAutoExtraction.reason, "");
  assert.equal(pendingAutoExtraction.messageId, null);
}

async function testQuietPromptGenerationAlsoSkipsRecall() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "普通用户输入" }];
  harness.__sendTextareaValue = "普通用户输入";

  const started = harness.result.onGenerationStarted(
    "normal",
    { quiet_prompt: "quiet system" },
    false,
  );
  assert.equal(started, null);
  assert.equal(
    harness.result.getCurrentGenerationWorkload()?.kind,
    "background-quiet",
  );

  const beforeCombine = await harness.result.onBeforeCombinePrompts();
  assert.deepEqual(beforeCombine, {
    skipped: true,
    reason: "background-generation:quiet-prompt",
  });
  assert.equal(harness.runRecallCalls.length, 0);
}

await testMvuExtraAnalysisSkipsRecallHooks();
await testBackgroundGenerationMessageReceiveDoesNotTriggerExtraction();
await testQuietPromptGenerationAlsoSkipsRecall();

console.log("mvu-background-generation-gating tests passed");
