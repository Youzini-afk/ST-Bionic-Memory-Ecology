import assert from "node:assert/strict";

import { MODULE_NAME } from "../graph/graph-persistence.js";
import {
  buildRecallRecentMessagesController,
  resolveRecallInputController,
} from "../retrieval/recall-controller.js";
import { runRecallController } from "../retrieval/recall-controller.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";
import { defaultSettings } from "../runtime/settings-defaults.js";
import {
  createRecallInputRecord,
  createRecallRunResult,
  isFreshRecallInputRecord,
  normalizeRecallInputText,
} from "../ui/ui-status.js";

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
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, null);
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);

  const transaction = harness.result.getGenerationRecallTransaction();
  assert.ok(transaction);
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "刚触发发送的新输入",
  );
  assert.equal(transaction.frozenRecallOptions.lockedSource, "send-intent");
  assert.equal(transaction.frozenRecallOptions.targetUserMessageIndex, null);
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testPlannerHandoffCanRemainAuthoritativeQueryWhenFlagEnabled() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "楼层里的稳定用户输入" }];

  const handoff = harness.result.preparePlannerTurnHandoff({
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
    recallOptions: {
      overrideUserMessage: "planner 增强后的输入",
      overrideSource: "send-intent",
    },
    chatId: "chat-main",
  });

  assert.equal(recallContext.shouldRun, true);
  assert.equal(recallContext.recallOptions.overrideUserMessage, "planner 原始输入");
  assert.equal(recallContext.recallOptions.overrideSource, "planner-handoff");
  assert.equal(recallContext.recallOptions.authoritativeInputUsed, true);
  assert.equal(
    recallContext.recallOptions.boundUserFloorText,
    "",
  );
  assert.equal(recallContext.recallOptions.includeSyntheticUserMessage, true);
  assert.ok(recallContext.recallOptions.cachedRecallPayload);
  assert.equal(
    recallContext.recallOptions.cachedRecallPayload.source,
    "planner-handoff",
  );
  assert.ok(
    harness.result.peekPlannerTurnHandoff("chat-main")?.matchedGenerationId,
    "validated planner input must be tied to the active generation",
  );
  harness.pendingRecallSendIntent = {
    text: "planner 增强后的输入",
    hash: "hash-planner-augmented",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(harness.runRecallCalls.length, 1);
  assert.equal(harness.runRecallCalls[0].overrideUserMessage, "planner 原始输入");
  assert.equal(harness.runRecallCalls[0].overrideSource, "planner-handoff");
  assert.equal(harness.runRecallCalls[0].authoritativeInputUsed, true);
  assert.equal(
    harness.runRecallCalls[0].boundUserFloorText,
    "",
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
  assert.equal(harness.runRecallCalls[0].boundUserFloorText, "");

  const transaction = harness.result.getGenerationRecallTransaction();
  assert.ok(transaction);
  assert.equal(
    transaction.frozenRecallOptions.overrideUserMessage,
    "第一次权威输入",
  );
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "");
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
  assert.equal(harness.runRecallCalls[0].targetUserMessageIndex, null);
  assert.equal(harness.runRecallCalls[0].includeSyntheticUserMessage, true);
  assert.equal(
    JSON.stringify(
      harness.runRecallCalls[0].sourceCandidates.map((candidate) => candidate.source),
    ),
    JSON.stringify(["host-generation-lifecycle", "chat-tail-user"]),
  );

  const transaction = harness.result.getGenerationRecallTransaction();
  assert.ok(transaction);
  assert.equal(transaction.frozenRecallOptions.overrideUserMessage, "宿主快照输入");
  assert.equal(
    transaction.frozenRecallOptions.lockedSource,
    "host-generation-lifecycle",
  );
  assert.equal(transaction.frozenRecallOptions.targetUserMessageIndex, null);
  assert.equal(transaction.frozenRecallOptions.authoritativeInputUsed, true);
  assert.equal(transaction.frozenRecallOptions.boundUserFloorText, "");
  assert.equal(transaction.frozenRecallOptions.includeSyntheticUserMessage, true);
}

async function testGenerationAfterCommandsWritesBackAuthoritativePromptWhenPreserved() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "旧的 chat tail" }];
  harness.pendingRecallSendIntent = {
    text: "发送前权威输入",
    hash: "hash-phase4-writeback",
    at: Date.now(),
    source: "dom-intent",
  };
  const params = {
    prompt: "旧 prompt",
    user_input: "旧 user_input",
  };

  await harness.result.onGenerationAfterCommands("normal", params, false);

  assert.equal(params.prompt, "发送前权威输入");
  assert.equal(params.user_input, "发送前权威输入");
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
await testGenerationAfterCommandsWritesBackAuthoritativePromptWhenPreserved();
testResolveRecallInputControllerAppendsSyntheticAuthoritativeUserMessage();

// ═══════════════════════════════════════════════════════════════════
// Planner-recall handoff coexistence regression tests
//
// Bug: when 剧情规划 (ena-planner) was enabled, recall (召回) stopped
// working and recall cards didn't display. Root cause was an accidental
// short-circuit in the planner-recall handoff path: when planner recall
// returned a `result` object but `formatInjection(result)` produced an
// empty memory block (e.g. retrieval selected zero nodes), the handoff
// was still registered, `cachedRecallPayload` was still set, and the
// main recall was short-circuited without running a fresh retrieval.
//
// Intended behaviour (docs/features/ena-planner.md:44-50,76): planner
// and recall COEXIST via the handoff. The handoff reuses a VALID cached
// result. When the cached result is EMPTY (empty injectionText), it
// must fall through to a fresh recall — NOT suppress recall entirely.
// ═══════════════════════════════════════════════════════════════════

// ─── Helper: minimal runtime for runRecallController direct invocation
function buildPlannerHandoffControllerRuntime({
  chat,
  injectionText = "",
  selectedNodeIds = [],
  cachedResult = null,
  cachedRecentMessages = null,
  cachedInjectionText = "",
} = {}) {
  let retrieveCalled = false;
  let retrieveCallCount = 0;
  const runtime = {
    getIsRecalling: () => false,
    getCurrentGraph: () => ({ nodes: [{ id: "node-a" }], edges: [] }),
    getSettings: () => ({
      ...defaultSettings,
      enabled: true,
      recallEnabled: true,
      recallLlmContextMessages: 4,
    }),
    isGraphReadableForRecall: () => true,
    isGraphReadable: () => true,
    isGraphMetadataWriteAllowed: () => true,
    recoverHistoryIfNeeded: async () => true,
    ensureVectorReadyIfNeeded: async () => true,
    getContext: () => ({ chat, chatId: "chat-handoff-regression" }),
    nextRecallRunSequence: () => 1,
    beginStageAbortController: () => ({ signal: { aborted: false } }),
    finishStageAbortController: () => {},
    setIsRecalling: () => {},
    setActiveRecallPromise: () => {},
    getActiveRecallPromise: () => null,
    setLastRecallStatus: () => {},
    getRecallHookLabel: () => "GENERATION_AFTER_COMMANDS",
    clampInt: (v, f, mn, mx) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return f;
      return Math.min(mx, Math.max(mn, Math.trunc(n)));
    },
    normalizeRecallInputText,
    createRecallInputRecord,
    createRecallRunResult,
    isFreshRecallInputRecord,
    getLatestUserChatMessage: (chatArr = []) =>
      [...chatArr].reverse().find((m) => m?.is_user) || null,
    getLastNonSystemChatMessage: (chatArr = []) =>
      [...chatArr].reverse().find((m) => !m?.is_system) || null,
    getRecallUserMessageSourceLabel: (s) => s,
    buildRecallRecentMessages: () =>
      cachedRecentMessages && Array.isArray(cachedRecentMessages)
        ? cachedRecentMessages
        : [],
    readPersistedRecallFromUserMessage: () => null,
    bumpPersistedRecallGenerationCount: () => null,
    triggerChatMetadataSave: () => {},
    schedulePersistedRecallMessageUiRefresh: () => {},
    refreshPanelLiveState: () => {},
    resolveRecallInput: (chatArr, _limit, override) => ({
      userMessage: normalizeRecallInputText(
        override?.overrideUserMessage || override?.userMessage || "",
      ),
      generationType: String(override?.generationType || "normal"),
      targetUserMessageIndex: Number.isFinite(override?.targetUserMessageIndex)
        ? override.targetUserMessageIndex
        : null,
      source: override?.overrideSource || "planner-handoff",
      sourceLabel: override?.overrideSourceLabel || "Planner handoff",
      reason: "override-bound",
      authoritativeInputUsed: Boolean(override?.authoritativeInputUsed),
      boundUserFloorText: normalizeRecallInputText(
        override?.boundUserFloorText || "",
      ),
      recentMessages: [],
      hookName: override?.hookName || "",
      deliveryMode: "immediate",
    }),
    applyRecallInjection: (_settings, _input, _recent, result) => ({
      injectionText:
        String(result?.injectionText || "").trim() ||
        String(cachedInjectionText || "").trim(),
      applied: true,
      source: "module-injection",
      mode: "module-injection",
      transport: { applied: false, source: "none", mode: "none" },
      deliveryMode: "immediate",
      retrievalMeta: {},
      llmMeta: {},
    }),
    retrieve: async () => {
      retrieveCalled = true;
      retrieveCallCount += 1;
      return {
        injectionText,
        selectedNodeIds,
        stats: { coreCount: selectedNodeIds.length, recallCount: selectedNodeIds.length },
        meta: { retrieval: { vectorHits: selectedNodeIds.length } },
      };
    },
    buildRecallRetrieveOptions: () => ({}),
    getEmbeddingConfig: () => ({}),
    getSchema: () => [],
    console,
    isAbortError: () => false,
    toastr: { error: () => {} },
    setPendingRecallSendIntent: () => {},
  };
  return {
    runtime,
    wasRetrieveCalled: () => retrieveCalled,
    retrieveCallCount: () => retrieveCallCount,
  };
}

// ─── Test A: cachedRecallPayload with empty injectionText falls through to fresh recall (Fix 1)
async function testCachedPayloadWithEmptyInjectionTextFallsThroughToFreshRecall() {
  const chat = [{ is_user: true, mes: "规划过的用户输入" }];
  const { runtime, wasRetrieveCalled } = buildPlannerHandoffControllerRuntime({
    chat,
    injectionText: "fresh-recall-block",
    selectedNodeIds: ["node-fresh-1"],
    // Simulate the bug scenario: cached payload has a `result` object
    // but formatInjection produced an empty memory block.
    cachedResult: {
      selectedNodeIds: [],
      stats: { coreCount: 0, recallCount: 0 },
      meta: { retrieval: { vectorHits: 0 } },
    },
    cachedInjectionText: "",
  });

  const result = await runRecallController(runtime, {
    overrideUserMessage: "规划过的用户输入",
    overrideSource: "planner-handoff",
    hookName: "GENERATION_AFTER_COMMANDS",
    deliveryMode: "immediate",
    cachedRecallPayload: {
      result: {
        selectedNodeIds: [],
        stats: { coreCount: 0, recallCount: 0 },
      },
      injectionText: "",
      recentMessages: [],
      source: "planner-handoff",
      sourceLabel: "Planner handoff",
      reason: "planner-handoff-reused",
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(
    wasRetrieveCalled(),
    true,
    "Fresh retrieve() must run when cached payload has empty injectionText (Fix 1)",
  );
  assert.equal(
    String(result.injectionText || "").trim(),
    "fresh-recall-block",
    "Fresh recall should produce non-empty injectionText",
  );
  assert.deepEqual(result.selectedNodeIds, ["node-fresh-1"]);
}

// ─── Test B: cachedRecallPayload with non-empty injectionText short-circuits (happy path, no double recall)
async function testCachedPayloadWithNonEmptyInjectionTextShortCircuits() {
  const chat = [{ is_user: true, mes: "规划过的用户输入" }];
  const { runtime, wasRetrieveCalled } = buildPlannerHandoffControllerRuntime({
    chat,
    injectionText: "should-not-be-used",
    selectedNodeIds: ["node-should-not-run"],
    // The cached payload carries a non-empty memory block — the handoff
    // is valid and the main recall should reuse it without running fresh.
    cachedResult: {
      selectedNodeIds: ["node-planner-1"],
      stats: { coreCount: 1, recallCount: 1 },
      meta: { retrieval: { vectorHits: 1 } },
    },
    cachedInjectionText: "planner-cached-memory-block",
  });

  const result = await runRecallController(runtime, {
    overrideUserMessage: "规划过的用户输入",
    overrideSource: "planner-handoff",
    hookName: "GENERATION_AFTER_COMMANDS",
    deliveryMode: "immediate",
    cachedRecallPayload: {
      result: {
        selectedNodeIds: ["node-planner-1"],
        stats: { coreCount: 1, recallCount: 1 },
      },
      injectionText: "planner-cached-memory-block",
      recentMessages: [],
      source: "planner-handoff",
      sourceLabel: "Planner handoff",
      reason: "planner-handoff-reused",
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(
    wasRetrieveCalled(),
    false,
    "Fresh retrieve() must NOT run when cached payload has non-empty injectionText (happy path)",
  );
  assert.equal(
    String(result.injectionText || "").trim(),
    "planner-cached-memory-block",
    "Cached memory block should be reused",
  );
  assert.deepEqual(result.selectedNodeIds, ["node-planner-1"]);
  assert.equal(result.reason, "planner-handoff-reused");
}

// ─── Test C: runPlannerRecallForEna nulls `result` when memoryBlock is empty (Fix 2)
async function testPlannerRecallForEnaNullsResultOnEmptyMemoryBlock() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    enabled: true,
    recallEnabled: true,
  };
  harness.result.setGraphPersistenceState({
    loadState: "loaded",
    dbReady: true,
  });
  // Graph has nodes (so we get past graph-empty), but the harness's
  // `retrieve` returns `{ entries: [], items: [], nodes: [] }` and
  // `formatInjection` returns "" — simulating zero retrieval hits.
  harness.currentGraph = {
    nodes: [{ id: "node-a" }, { id: "node-b" }],
    edges: [],
    historyState: {},
  };

  const recall = await harness.result.runPlannerRecallForEna({
    rawUserInput: "查询不到任何节点的用户输入",
  });

  assert.equal(recall.ok, false);
  assert.equal(recall.reason, "empty-memory-block");
  assert.equal(recall.memoryBlock, "");
  assert.equal(
    recall.result,
    null,
    "Planner recall must null `result` when memoryBlock is empty so the handoff is not registered (Fix 2)",
  );
}

// ─── Test D: an empty planner recall keeps the turn mapping without suppressing fresh recall
async function testHandoffWithEmptyInjectionTextDoesNotSetCachedRecallPayload() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "稳定 chat tail" }];

  const handoff = harness.result.preparePlannerTurnHandoff({
    rawUserInput: "planner 原始输入",
    plannerAugmentedMessage: "planner 增强后的输入",
    plannerRecall: {
      memoryBlock: "",
      recentMessages: ["[user]: planner 原始输入"],
      result: {
        selectedNodeIds: [],
        stats: { coreCount: 0, recallCount: 0 },
        meta: { retrieval: { vectorHits: 0 } },
      },
    },
    plannerPlotRecord: { plotText: "<plot>继续推进</plot>" },
    chatId: "chat-main",
  });

  assert.ok(handoff, "plot data keeps the planner turn mapping alive");
  assert.equal(handoff.injectionText, "");

  const recallContext = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "normal",
    recallOptions: {
      overrideUserMessage: "planner 增强后的输入",
      overrideSource: "send-intent",
    },
    chatId: "chat-main",
  });

  assert.equal(recallContext.shouldRun, true);
  assert.equal(recallContext.recallOptions.overrideUserMessage, "planner 原始输入");
  assert.equal(
    recallContext.recallOptions.cachedRecallPayload,
    undefined,
    "cachedRecallPayload must NOT be set when handoff injectionText is empty (Fix 3)",
  );
}

// ─── Test E: happy path — handoff with non-empty injectionText still sets cachedRecallPayload
async function testHandoffWithNonEmptyInjectionTextSetsCachedRecallPayload() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "稳定 chat tail" }];

  const handoff = harness.result.preparePlannerTurnHandoff({
    rawUserInput: "planner 原始输入",
    plannerAugmentedMessage: "planner 增强后的输入",
    plannerRecall: {
      memoryBlock: "规划记忆块",
      recentMessages: ["[user]: planner 原始输入", "[assistant]: 记忆命中"],
      result: {
        selectedNodeIds: ["node-planner-1"],
        stats: { coreCount: 1, recallCount: 1 },
        meta: { retrieval: { vectorHits: 1 } },
      },
    },
    chatId: "chat-main",
  });

  assert.ok(handoff);
  assert.equal(handoff.injectionText, "规划记忆块");

  const recallContext = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "normal",
    recallOptions: {
      overrideUserMessage: "planner 增强后的输入",
      overrideSource: "send-intent",
    },
    chatId: "chat-main",
  });

  assert.equal(recallContext.shouldRun, true);
  assert.ok(
    recallContext.recallOptions.cachedRecallPayload,
    "cachedRecallPayload must be set when handoff injectionText is non-empty (happy path)",
  );
  assert.equal(
    recallContext.recallOptions.cachedRecallPayload.injectionText,
    "规划记忆块",
  );
  assert.equal(
    recallContext.recallOptions.cachedRecallPayload.source,
    "planner-handoff",
  );
}

// ─── Test F: regression — fresh recall produces a persistable record (hasRecall would be true)
async function testFreshRecallAfterEmptyHandoffProducesPersistableRecord() {
  const harness = await createGenerationRecallHarness({ realApplyFinal: true });
  harness.extension_settings[MODULE_NAME] = {
    ...defaultSettings,
    enabled: true,
    recallEnabled: true,
    recallUseAuthoritativeGenerationInput: true,
  };
  harness.chat = [{ is_user: true, mes: "稳定 chat tail" }];

  // Simulate the bug scenario: planner prepared a handoff with empty
  // memoryBlock. After Fixes 1+3, createGenerationRecallContext does NOT
  // set cachedRecallPayload, so the main recall falls through to the
  // harness's `runRecall` mock which returns a non-empty injectionText.
  harness.result.preparePlannerTurnHandoff({
    rawUserInput: "planner 原始输入",
    plannerAugmentedMessage: "planner 增强后的输入",
    plannerRecall: {
      memoryBlock: "",
      recentMessages: ["[user]: planner 原始输入"],
      result: {
        selectedNodeIds: [],
        stats: { coreCount: 0, recallCount: 0 },
      },
    },
    plannerPlotRecord: { plotText: "<plot>继续推进</plot>" },
    chatId: "chat-main",
  });
  harness.pendingRecallSendIntent = {
    text: "planner 增强后的输入",
    hash: "hash-planner-augmented",
    at: Date.now(),
    source: "dom-intent",
  };

  await harness.result.onGenerationAfterCommands("normal", {}, false);

  assert.equal(
    harness.runRecallCalls.length,
    1,
    "Main recall must be invoked once after empty-handoff fallthrough",
  );
  assert.equal(
    harness.runRecallCalls[0].cachedRecallPayload,
    undefined,
    "cachedRecallPayload must not be passed to runRecall when handoff injectionText is empty",
  );
  assert.equal(
    harness.runRecallCalls[0].overrideUserMessage,
    "planner 原始输入",
  );

  // MESSAGE_SENT supplies the stable floor after recall has completed.
  harness.chat.push({ is_user: true, mes: "planner 原始输入" });
  const transaction = harness.result.getGenerationRecallTransaction();
  const persistResult =
    harness.result.bindGenerationRecallTransactionToUserMessage(transaction, 1);

  assert.equal(
    persistResult.persisted,
    true,
    "Fresh recall must attach after MESSAGE_SENT supplies the stable user floor",
  );
  assert.ok(
    String(persistResult.record?.injectionText || "").trim(),
    "Persisted record must carry non-empty injectionText",
  );
  // hasRecall in ui/recall-message-ui-controller.js:513 is
  // `Boolean(record?.injectionText)` — verify that condition holds.
  assert.equal(
    Boolean(persistResult.record?.injectionText),
    true,
    "hasRecall would be true (recall card displays)",
  );
}

async function testRerollDoesNotReadOrConsumePlannerTurnHandoff() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "稳定的历史用户楼层" }];
  const handoff = harness.result.preparePlannerTurnHandoff({
    rawUserInput: "planner 原始输入",
    plannerAugmentedMessage: "planner 增强后的输入",
    plannerRecall: {
      memoryBlock: "规划记忆块",
      result: { selectedNodeIds: ["node-planner-1"] },
    },
    plannerPlotRecord: { plotText: "<plot>规划</plot>" },
    chatId: "chat-main",
  });

  const recallContext = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "regenerate",
    recallOptions: {
      generationType: "regenerate",
      overrideUserMessage: "稳定的历史用户楼层",
      overrideSource: "chat-last-user",
      targetUserMessageIndex: 0,
    },
    chatId: "chat-main",
  });

  assert.equal(recallContext.recallOptions.overrideUserMessage, "稳定的历史用户楼层");
  assert.equal(recallContext.recallOptions.cachedRecallPayload, undefined);
  assert.equal(harness.result.peekPlannerTurnHandoff("chat-main")?.id, handoff.id);
  assert.equal(
    harness.result.peekPlannerTurnHandoff("chat-main")?.matchedGenerationId || "",
    "",
    "reroll must not claim the pending planner turn",
  );
}

async function testPlannerHandoffCannotMoveToAnotherFreshGeneration() {
  const harness = await createGenerationRecallHarness();
  harness.chat = [{ is_user: true, mes: "稳定的用户楼层" }];
  harness.result.preparePlannerTurnHandoff({
    rawUserInput: "planner 原始输入",
    plannerAugmentedMessage: "planner 增强后的输入",
    plannerPlotRecord: { plotText: "<plot>规划</plot>" },
    chatId: "chat-main",
  });

  const first = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "normal",
    recallOptions: { overrideUserMessage: "planner 增强后的输入" },
    chatId: "chat-main",
  });
  assert.equal(first.recallOptions.overrideUserMessage, "planner 原始输入");

  harness.result.clearGeneration("test-next-generation");
  harness.result.beginGeneration("normal");
  const second = harness.result.createGenerationRecallContext({
    hookName: "GENERATION_AFTER_COMMANDS",
    generationType: "normal",
    recallOptions: { overrideUserMessage: "planner 增强后的输入" },
    chatId: "chat-main",
  });
  assert.equal(second.recallOptions.overrideUserMessage, "稳定的用户楼层");
  assert.equal(second.recallOptions.cachedRecallPayload, undefined);
  assert.equal(harness.result.peekPlannerTurnHandoff("chat-main"), null);
}

async function testPlannerRecallAbortsWhenConversationChanges() {
  const harness = await createGenerationRecallHarness();
  harness.extension_settings[MODULE_NAME] = {
    ...defaultSettings,
    enabled: true,
    recallEnabled: true,
  };
  harness.currentGraph = {
    nodes: [{ id: "node-a" }],
    edges: [],
    historyState: {},
  };
  harness.retrieveImpl = async () => {
    harness.enterConversation("chat-other");
    return { injectionText: "不应跨聊天返回" };
  };

  await assert.rejects(
    harness.result.runPlannerRecallForEna({ rawUserInput: "继续剧情" }),
    (error) => error?.name === "AbortError" && /conversation changed/i.test(error.message),
  );
}

await testCachedPayloadWithEmptyInjectionTextFallsThroughToFreshRecall();
await testCachedPayloadWithNonEmptyInjectionTextShortCircuits();
await testPlannerRecallForEnaNullsResultOnEmptyMemoryBlock();
await testHandoffWithEmptyInjectionTextDoesNotSetCachedRecallPayload();
await testHandoffWithNonEmptyInjectionTextSetsCachedRecallPayload();
await testFreshRecallAfterEmptyHandoffProducesPersistableRecord();
await testRerollDoesNotReadOrConsumePlannerTurnHandoff();
await testPlannerHandoffCannotMoveToAnotherFreshGeneration();
await testPlannerRecallAbortsWhenConversationChanges();

console.log("recall-authoritative-generation-input tests passed");
