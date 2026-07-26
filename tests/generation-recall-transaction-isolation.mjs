import assert from "node:assert/strict";
import { createGenerationRecallTransactions } from "../runtime/generation-recall-transactions.js";
import {
  hashRecallInput,
  shouldRunRecallForTransaction,
} from "../ui/ui-status.js";

const CHAT_ID = "chat-generation-transaction-isolation";
const GENERATION_AFTER_COMMANDS = "GENERATION_AFTER_COMMANDS";
const GENERATE_BEFORE_COMBINE_PROMPTS = "GENERATE_BEFORE_COMBINE_PROMPTS";

function createTransactionHarness({ activeGenerationId = "gen-A" } = {}) {
  let currentActiveGenerationId = activeGenerationId;
  const chat = [
    { is_user: true, mes: "first stable user floor" },
    { is_user: false, mes: "first assistant reply", is_system: false },
    { is_user: true, mes: "second fresh user floor" },
    { is_user: false, mes: "second assistant reply", is_system: false },
  ];

  const runtime = createGenerationRecallTransactions({
    getContext: () => ({ chatId: CHAT_ID, chat }),
    getCurrentChatId: () => CHAT_ID,
    getActiveGenerationId: () => currentActiveGenerationId,
    getRecallUserMessageSourceLabel: (source = "") => String(source || ""),
    getSettings: () => ({ recallUseAuthoritativeGenerationInput: false }),
    hashRecallInput,
    normalizeChatIdCandidate: (value = "") => String(value ?? "").trim(),
    normalizeRecallInputText: (value = "") => String(value ?? "").trim(),
    peekPlannerRecallHandoff: () => null,
    resolveGenerationTargetUserMessageIndex: (candidateChat = [], options = {}) => {
      const normalizedType = String(options?.generationType || "normal").trim() || "normal";
      for (let index = candidateChat.length - 1; index >= 0; index--) {
        if (candidateChat[index]?.is_user) return index;
      }
      return normalizedType === "normal" ? null : null;
    },
    shouldRunRecallForTransaction,
    GENERATION_RECALL_TRANSACTION_TTL_MS: 15000,
    GENERATION_RECALL_HOOK_BRIDGE_MS: 1200,
  });

  return {
    chat,
    runtime,
    setActiveGenerationId(value = "") {
      currentActiveGenerationId = String(value || "").trim();
    },
  };
}

function createNormalAfterCommandsContext(runtime) {
  return runtime.createGenerationRecallContext({
    hookName: GENERATION_AFTER_COMMANDS,
    generationType: "normal",
    recallOptions: {
      generationType: "normal",
      targetUserMessageIndex: 2,
      overrideUserMessage: "second fresh user floor",
      overrideSource: "chat-tail-user",
      overrideSourceLabel: "chat-tail-user",
      overrideReason: "test-normal-generation",
    },
  });
}

function createRegenerateAfterCommandsContext(runtime) {
  return runtime.createGenerationRecallContext({
    hookName: GENERATION_AFTER_COMMANDS,
    generationType: "regenerate",
    recallOptions: {
      generationType: "regenerate",
      targetUserMessageIndex: 0,
      overrideUserMessage: "first stable user floor",
      overrideSource: "chat-last-user",
      overrideSourceLabel: "chat-last-user",
      overrideReason: "test-regenerate-generation",
    },
  });
}

function createPeerBeforeCombineContext(runtime, recallOptions = {}) {
  return runtime.createGenerationRecallContext({
    hookName: GENERATE_BEFORE_COMBINE_PROMPTS,
    generationType: recallOptions.generationType || "normal",
    recallOptions: {
      generationType: "normal",
      targetUserMessageIndex: 2,
      overrideUserMessage: "second fresh user floor",
      overrideSource: "chat-tail-user",
      overrideSourceLabel: "chat-tail-user",
      overrideReason: "test-peer-generation",
      ...recallOptions,
    },
  });
}

{
  const { runtime, setActiveGenerationId } = createTransactionHarness({
    activeGenerationId: "gen-A",
  });

  const normalContext = createNormalAfterCommandsContext(runtime);
  assert.ok(normalContext.transaction, "normal generation should create a transaction");
  assert.equal(normalContext.shouldRun, true, "normal after-commands should run initially");
  assert.equal(
    normalContext.transaction.generationId,
    "gen-A",
    "normal transaction should be stamped with generation A",
  );

  runtime.markGenerationRecallTransactionHookState(
    normalContext.transaction,
    GENERATION_AFTER_COMMANDS,
    "completed",
  );
  runtime.markGenerationRecallTransactionHookState(
    normalContext.transaction,
    GENERATE_BEFORE_COMBINE_PROMPTS,
    "completed",
  );
  runtime.storeGenerationRecallTransactionResult(
    normalContext.transaction,
    {
      status: "completed",
      didRecall: true,
      injectionText: "fresh generation A recall result",
      hookName: GENERATION_AFTER_COMMANDS,
    },
    { hookName: GENERATION_AFTER_COMMANDS, deliveryMode: "immediate" },
  );

  setActiveGenerationId("gen-B");
  const regenerateContext = createRegenerateAfterCommandsContext(runtime);

  assert.ok(regenerateContext.transaction, "regenerate should create a transaction");
  assert.notEqual(
    regenerateContext.transaction.id,
    normalContext.transaction.id,
    "regenerate must not reuse the previous normal generation transaction",
  );
  assert.equal(
    regenerateContext.transaction.generationId,
    "gen-B",
    "regenerate transaction should be stamped with generation B",
  );
  assert.equal(
    regenerateContext.generationType,
    "regenerate",
    "regenerate context should keep the requested generation type",
  );
  assert.equal(
    regenerateContext.transaction.generationType,
    "history",
    "the transaction bucket for regenerate is normalized to history",
  );
  assert.equal(
    regenerateContext.recallOptions.targetUserMessageIndex,
    0,
    "regenerate recall options should bind to the requested target user floor",
  );
  assert.equal(
    regenerateContext.recallOptions.overrideUserMessage,
    "first stable user floor",
    "regenerate must not inherit the normal transaction's frozen user message",
  );
  assert.equal(
    runtime.getGenerationRecallTransactionResult(regenerateContext.transaction),
    null,
    "regenerate must not inherit the normal transaction's stored fresh result",
  );
  assert.equal(
    regenerateContext.shouldRun,
    true,
    "regenerate should run recall instead of being short-circuited by old peer hook states",
  );

  console.log("  ✓ cross-generation regenerate creates an isolated recall transaction");
}

{
  const { runtime } = createTransactionHarness({ activeGenerationId: "gen-A" });

  const afterCommandsContext = createNormalAfterCommandsContext(runtime);
  assert.ok(afterCommandsContext.transaction, "after-commands should create a transaction");
  assert.equal(afterCommandsContext.transaction.generationId, "gen-A");

  runtime.markGenerationRecallTransactionHookState(
    afterCommandsContext.transaction,
    GENERATION_AFTER_COMMANDS,
    "running",
  );
  runtime.markGenerationRecallTransactionHookState(
    afterCommandsContext.transaction,
    GENERATION_AFTER_COMMANDS,
    "completed",
  );

  const beforeCombineContext = createPeerBeforeCombineContext(runtime);

  assert.ok(beforeCombineContext.transaction, "before-combine should return a transaction");
  assert.equal(
    beforeCombineContext.transaction.id,
    afterCommandsContext.transaction.id,
    "same-generation peer hook should reuse the after-commands transaction",
  );
  assert.equal(
    beforeCombineContext.transaction.generationId,
    "gen-A",
    "same-generation peer bridge should preserve the generation id",
  );

  console.log("  ✓ same-generation peer hook bridge still reuses the transaction");
}

{
  const { runtime } = createTransactionHarness({ activeGenerationId: "" });

  const legacyContext = createNormalAfterCommandsContext(runtime);
  assert.ok(legacyContext.transaction, "legacy no-generation-id path should create a transaction");
  assert.equal(
    legacyContext.transaction.generationId,
    "",
    "legacy transaction should carry an empty generation id",
  );

  runtime.markGenerationRecallTransactionHookState(
    legacyContext.transaction,
    GENERATION_AFTER_COMMANDS,
    "completed",
  );

  const recentTransaction = runtime.findRecentGenerationRecallTransactionForChat(CHAT_ID);
  assert.equal(
    recentTransaction?.id,
    legacyContext.transaction.id,
    "empty active generation id should still find the recent same-chat transaction",
  );

  const legacyPeerContext = createPeerBeforeCombineContext(runtime, {
    generationType: "regenerate",
    targetUserMessageIndex: 0,
    overrideUserMessage: "first stable user floor",
    overrideSource: "chat-last-user",
    overrideSourceLabel: "chat-last-user",
    overrideReason: "test-legacy-regenerate-peer",
  });

  assert.equal(
    legacyPeerContext.transaction?.id,
    legacyContext.transaction.id,
    "empty generation id should preserve legacy same-chat peer bridging behavior",
  );

  console.log("  ✓ empty generation id preserves legacy same-chat bridging");
}

console.log("generation-recall-transaction-isolation tests passed");
