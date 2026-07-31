import assert from "node:assert/strict";
import {
  onBeforeCombinePromptsController,
  onGenerationAfterCommandsController,
} from "../host/event-binding.js";

function createRuntime(overrides = {}) {
  const calls = {
    applyFinalRecallInjectionForGeneration: 0,
    clearFinalRecallInjectionFailClosed: 0,
    buildGenerationAfterCommandsRecallInput: 0,
    buildHistoryGenerationRecallInput: 0,
    buildNormalGenerationRecallInput: 0,
    createGenerationRecallContext: 0,
    reapplyPersistedRecallBlock: 0,
    reportNoNewUserArtifactUnavailable: 0,
    runRecall: 0,
    validateNoNewUserTurnArtifacts: 0,
  };
  const runtime = {
    calls,
    applyFinalRecallInjectionForGeneration: () => {
      calls.applyFinalRecallInjectionForGeneration += 1;
      return { source: "default-final" };
    },
    buildGenerationAfterCommandsRecallInput: () => {
      calls.buildGenerationAfterCommandsRecallInput += 1;
      return { overrideUserMessage: "user floor" };
    },
    buildHistoryGenerationRecallInput: () => {
      calls.buildHistoryGenerationRecallInput += 1;
      return null;
    },
    buildNormalGenerationRecallInput: () => {
      calls.buildNormalGenerationRecallInput += 1;
      return { userMessage: "fresh normal" };
    },
    clearLiveRecallInjectionPromptForRewrite: () => {},
    clearFinalRecallInjectionFailClosed: () => {
      calls.clearFinalRecallInjectionFailClosed += 1;
      return { source: "none", applicationMode: "fail-closed", usedText: "" };
    },
    clearPendingHostGenerationInputSnapshot: () => {},
    clearPendingRecallSendIntent: () => {},
    consumeDryRunPromptPreview: () => false,
    consumeHostGenerationInputSnapshot: () => null,
    createGenerationRecallContext: () => {
      calls.createGenerationRecallContext += 1;
      return {
        shouldRun: true,
        transaction: { id: "tx-default" },
        recallOptions: { userMessage: "default recall" },
        generationType: "normal",
        hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
        recallKey: "recall-key-default",
      };
    },
    getContext: () => ({
      chat: [{ is_user: true, mes: "fresh normal" }],
      chatId: "chat-inject-decoupling",
    }),
    getCurrentChatId: () => "chat-inject-decoupling",
    getGenerationContext: () => null,
    getGenerationRecallHookStateFromResult: () => "completed",
    getGenerationRecallTransactionResult: () => null,
    getPendingHostGenerationInputSnapshot: () => null,
    isMvuExtraAnalysisGuardActive: () => false,
    isTavernHelperPromptViewerRefreshActive: () => false,
    markCurrentGenerationTrivialSkip: () => {},
    markGenerationRecallTransactionHookState: () => {},
    reapplyPersistedRecallBlock: () => {
      calls.reapplyPersistedRecallBlock += 1;
      return { applied: false, reason: "default-miss" };
    },
    reportNoNewUserArtifactUnavailable: () => {
      calls.reportNoNewUserArtifactUnavailable += 1;
    },
    resolveGenerationRecallDeliveryMode: () => "deferred",
    runRecall: async () => {
      calls.runRecall += 1;
      return {
        status: "completed",
        didRecall: true,
        injectionText: "fresh injection",
      };
    },
    storeGenerationRecallTransactionResult: () => {},
    validateNoNewUserTurnArtifacts: async () => {
      calls.validateNoNewUserTurnArtifacts += 1;
      return { valid: true };
    },
    ...overrides,
  };
  return runtime;
}

{
  const runtime = createRuntime({
    getGenerationContext: () => ({ kind: "no-new-user", type: "regenerate" }),
  });

  const result = await onGenerationAfterCommandsController(
    runtime,
    "regenerate",
    {},
    false,
  );

  assert.deepEqual(result, {
    skipped: true,
    reason: "no-new-user-deferred-to-before-combine",
  });
  assert.equal(runtime.calls.createGenerationRecallContext, 0);
  assert.equal(runtime.calls.runRecall, 0);
  assert.equal(runtime.calls.applyFinalRecallInjectionForGeneration, 0);
}

{
  const reapplied = {
    applied: true,
    source: "persisted",
    reason: "deterministic-reapply",
  };
  const runtime = createRuntime({
    getGenerationContext: () => ({ kind: "no-new-user", type: "regenerate" }),
    reapplyPersistedRecallBlock: () => {
      runtime.calls.reapplyPersistedRecallBlock += 1;
      return reapplied;
    },
  });

  const result = await onBeforeCombinePromptsController(runtime, {
    combinedPrompt: "prompt",
  });

  assert.equal(result, reapplied);
  assert.equal(runtime.calls.reapplyPersistedRecallBlock, 1);
  assert.equal(runtime.calls.createGenerationRecallContext, 0);
  assert.equal(runtime.calls.runRecall, 0);
}

{
  const finalSentinel = { source: "none", applicationMode: "fail-closed", usedText: "" };
  const runtime = createRuntime({
    clearFinalRecallInjectionFailClosed: (payload) => {
      runtime.calls.clearFinalRecallInjectionFailClosed += 1;
      assert.equal(payload.expectedChatId, "chat-inject-decoupling");
      assert.equal(payload.hookName, "GENERATE_BEFORE_COMBINE_PROMPTS");
      return finalSentinel;
    },
    getGenerationContext: () => ({ kind: "no-new-user", type: "regenerate" }),
    reapplyPersistedRecallBlock: () => {
      runtime.calls.reapplyPersistedRecallBlock += 1;
      return { applied: false, reason: "no-record" };
    },
  });

  const result = await onBeforeCombinePromptsController(runtime, {
    combinedPrompt: "prompt",
  });

  assert.deepEqual(result, {
    ...finalSentinel,
    skipped: true,
    artifactUnavailable: true,
    reason: "no-record",
  });
  assert.equal(runtime.calls.reapplyPersistedRecallBlock, 1);
  assert.equal(runtime.calls.createGenerationRecallContext, 0);
  assert.equal(runtime.calls.runRecall, 0);
  assert.equal(runtime.calls.applyFinalRecallInjectionForGeneration, 0);
  assert.equal(runtime.calls.clearFinalRecallInjectionFailClosed, 1);
  assert.equal(runtime.calls.reportNoNewUserArtifactUnavailable, 1);
}

{
  const runtime = createRuntime({
    getGenerationContext: () => ({ kind: "no-new-user", type: "swipe" }),
    validateNoNewUserTurnArtifacts: async () => {
      runtime.calls.validateNoNewUserTurnArtifacts += 1;
      return { valid: false, reason: "durable-planner-artifact-unavailable" };
    },
  });
  const result = await onBeforeCombinePromptsController(runtime, {});
  assert.equal(result.artifactUnavailable, true);
  assert.equal(result.reason, "durable-planner-artifact-unavailable");
  assert.equal(runtime.calls.reapplyPersistedRecallBlock, 0);
  assert.equal(runtime.calls.runRecall, 0);
  assert.equal(runtime.calls.reportNoNewUserArtifactUnavailable, 1);
  assert.equal(runtime.calls.clearFinalRecallInjectionFailClosed, 1);
}

{
  const normalSentinel = { source: "normal-final", applied: true };
  const runtime = createRuntime({
    applyFinalRecallInjectionForGeneration: () => {
      runtime.calls.applyFinalRecallInjectionForGeneration += 1;
      return normalSentinel;
    },
    createGenerationRecallContext: () => {
      runtime.calls.createGenerationRecallContext += 1;
      return {
        shouldRun: true,
        transaction: { id: "tx-normal" },
        recallOptions: { userMessage: "fresh normal" },
        generationType: "normal",
        hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
        recallKey: "recall-key-normal",
      };
    },
    getGenerationContext: () => ({ kind: "fresh", type: "normal" }),
    reapplyPersistedRecallBlock: () => {
      runtime.calls.reapplyPersistedRecallBlock += 1;
      return { applied: true, source: "should-not-run" };
    },
  });

  const result = await onBeforeCombinePromptsController(runtime, {
    combinedPrompt: "prompt",
  });

  assert.equal(result, normalSentinel);
  assert.equal(runtime.calls.reapplyPersistedRecallBlock, 0);
  assert.equal(runtime.calls.buildNormalGenerationRecallInput, 1);
  assert.equal(runtime.calls.createGenerationRecallContext, 1);
  assert.equal(runtime.calls.runRecall, 1);
  assert.equal(runtime.calls.applyFinalRecallInjectionForGeneration, 1);
}

console.log("recall-inject-decoupling tests passed");
