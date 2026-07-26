import assert from "node:assert/strict";
import { createConversationSession } from "../runtime/conversation-session.js";
import { createGenerationRecallTransactions } from "../runtime/generation-recall-transactions.js";
import {
  hashRecallInput,
  shouldRunRecallForTransaction,
} from "../ui/ui-status.js";

const CHAT_ID = "chat-generation-transaction-isolation";
const GENERATION_AFTER_COMMANDS = "GENERATION_AFTER_COMMANDS";
const GENERATE_BEFORE_COMBINE_PROMPTS = "GENERATE_BEFORE_COMBINE_PROMPTS";

function createTransactionHarness({ startGeneration = true } = {}) {
  let clock = 1000;
  const chat = [
    { is_user: true, mes: "first stable user floor" },
    { is_user: false, mes: "first assistant reply", is_system: false },
    { is_user: true, mes: "second fresh user floor" },
    { is_user: false, mes: "second assistant reply", is_system: false },
  ];
  const session = createConversationSession({ now: () => clock });
  session.enterChat({ chatId: CHAT_ID, hostChatId: CHAT_ID });
  if (startGeneration) session.beginGeneration("normal");

  const runtime = createGenerationRecallTransactions({
    getContext: () => ({ chatId: CHAT_ID, chat }),
    getCurrentChatId: () => CHAT_ID,
    getActiveGenerationId: () => session.getGeneration()?.id || "",
    getGenerationRecallTransaction: () => session.getRecallTransaction(),
    setGenerationRecallTransaction: (transaction) =>
      session.setRecallTransaction(transaction),
    clearGenerationRecallTransaction: () => session.clearRecallTransaction(),
    getRecallUserMessageSourceLabel: (source = "") => String(source || ""),
    getSettings: () => ({ recallUseAuthoritativeGenerationInput: false }),
    hashRecallInput,
    normalizeChatIdCandidate: (value = "") => String(value ?? "").trim(),
    normalizeRecallInputText: (value = "") => String(value ?? "").trim(),
    peekPlannerRecallHandoff: () => null,
    resolveGenerationTargetUserMessageIndex: (candidateChat = []) => {
      for (let index = candidateChat.length - 1; index >= 0; index--) {
        if (candidateChat[index]?.is_user) return index;
      }
      return null;
    },
    shouldRunRecallForTransaction,
  });

  return {
    runtime,
    session,
    startGeneration(type = "normal") {
      session.clearGeneration("test-next-generation");
      clock += 1;
      return session.beginGeneration(type);
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

function createPeerBeforeCombineContext(runtime) {
  return runtime.createGenerationRecallContext({
    hookName: GENERATE_BEFORE_COMBINE_PROMPTS,
    generationType: "normal",
    recallOptions: {
      generationType: "normal",
      targetUserMessageIndex: 2,
      overrideUserMessage: "second fresh user floor",
      overrideSource: "chat-tail-user",
      overrideSourceLabel: "chat-tail-user",
      overrideReason: "test-peer-generation",
    },
  });
}

{
  const { runtime, session, startGeneration } = createTransactionHarness();
  const generationAId = session.getGeneration().id;
  const normalContext = createNormalAfterCommandsContext(runtime);
  assert.ok(normalContext.transaction);
  assert.equal(normalContext.shouldRun, true);
  assert.equal(normalContext.transaction.generationId, generationAId);

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

  const generationB = startGeneration("regenerate");
  const regenerateContext = createRegenerateAfterCommandsContext(runtime);
  assert.ok(regenerateContext.transaction);
  assert.notEqual(regenerateContext.transaction.id, normalContext.transaction.id);
  assert.equal(regenerateContext.transaction.generationId, generationB.id);
  assert.equal(regenerateContext.generationType, "regenerate");
  assert.equal(regenerateContext.transaction.generationType, "history");
  assert.equal(regenerateContext.recallOptions.targetUserMessageIndex, 0);
  assert.equal(
    regenerateContext.recallOptions.overrideUserMessage,
    "first stable user floor",
  );
  assert.equal(
    runtime.getGenerationRecallTransactionResult(regenerateContext.transaction),
    null,
  );
  assert.equal(regenerateContext.shouldRun, true);
  console.log("  ok cross-generation recall transaction isolation");
}

{
  const { runtime, session } = createTransactionHarness();
  const generationId = session.getGeneration().id;
  const afterCommandsContext = createNormalAfterCommandsContext(runtime);
  assert.ok(afterCommandsContext.transaction);
  assert.equal(afterCommandsContext.transaction.generationId, generationId);

  runtime.markGenerationRecallTransactionHookState(
    afterCommandsContext.transaction,
    GENERATION_AFTER_COMMANDS,
    "completed",
  );
  const beforeCombineContext = createPeerBeforeCombineContext(runtime);
  assert.equal(
    beforeCombineContext.transaction?.id,
    afterCommandsContext.transaction.id,
  );
  assert.equal(beforeCombineContext.transaction?.generationId, generationId);
  console.log("  ok same-generation peer hook transaction reuse");
}

{
  const { runtime } = createTransactionHarness({ startGeneration: false });
  const context = createNormalAfterCommandsContext(runtime);
  assert.equal(context.transaction, null);
  assert.equal(context.shouldRun, false);
  assert.equal(context.guardReason, "transaction-unavailable");
  console.log("  ok no floating transaction without an active generation");
}

console.log("generation-recall-transaction-isolation tests passed");
