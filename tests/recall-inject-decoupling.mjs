import assert from "node:assert/strict";
import {
  onBeforeCombinePromptsController,
  onGenerationAfterCommandsController,
} from "../host/event-binding.js";

function createRuntime(overrides = {}) {
  const calls = {
    applyFinalRecallInjectionForGeneration: 0,
    buildGenerationAfterCommandsRecallInput: 0,
    buildHistoryGenerationRecallInput: 0,
    buildNormalGenerationRecallInput: 0,
    createGenerationRecallContext: 0,
    reapplyPersistedRecallBlock: 0,
    runRecall: 0,
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
  const finalSentinel = { source: "fallback-final", applied: true };
  const transaction = { id: "tx-fallback" };
  const runtime = createRuntime({
    applyFinalRecallInjectionForGeneration: (payload) => {
      runtime.calls.applyFinalRecallInjectionForGeneration += 1;
      assert.equal(payload.transaction, transaction);
      assert.equal(payload.hookName, "GENERATE_BEFORE_COMBINE_PROMPTS");
      return finalSentinel;
    },
    createGenerationRecallContext: () => {
      runtime.calls.createGenerationRecallContext += 1;
      return {
        shouldRun: true,
        transaction,
        recallOptions: { userMessage: "fallback user" },
        generationType: "regenerate",
        hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
        recallKey: "recall-key-fallback",
      };
    },
    getGenerationContext: () => ({ kind: "no-new-user", type: "regenerate" }),
    reapplyPersistedRecallBlock: () => {
      runtime.calls.reapplyPersistedRecallBlock += 1;
      return { applied: false, reason: "no-record" };
    },
    runRecall: async (options) => {
      runtime.calls.runRecall += 1;
      assert.equal(options.hookName, "GENERATE_BEFORE_COMBINE_PROMPTS");
      return { status: "completed", didRecall: true, injectionText: "computed" };
    },
  });

  const result = await onBeforeCombinePromptsController(runtime, {
    combinedPrompt: "prompt",
  });

  assert.equal(result, finalSentinel);
  assert.equal(runtime.calls.reapplyPersistedRecallBlock, 1);
  assert.equal(runtime.calls.createGenerationRecallContext, 1);
  assert.equal(runtime.calls.runRecall, 1);
  assert.equal(runtime.calls.applyFinalRecallInjectionForGeneration, 1);
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
