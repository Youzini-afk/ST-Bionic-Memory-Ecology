// ST-BME: regression tests — reroll should reuse persisted recall record
//
// Covers:
//   1. ensurePersistedRecallRecordForGeneration re-writes when existing record
//      has same injectionText/nodeIds but empty recallInput
//   2. resolveReusablePersistedRecallRecord (inside runRecallController) reuses
//      a persisted record when recallInput matches the user floor text
//   3. End-to-end: regenerate does NOT call retrieve when a valid persisted
//      record exists

import assert from "node:assert/strict";
import {
  buildPersistedRecallRecord,
  readPersistedRecallFromUserMessage,
  writePersistedRecallToUserMessage,
  BME_RECALL_EXTRA_KEY,
} from "../retrieval/recall-persistence.js";
import { runRecallController } from "../retrieval/recall-controller.js";
import { createGenerationRecallHarness } from "./helpers/generation-recall-harness.mjs";
import {
  normalizeRecallInputText,
  createRecallRunResult,
  createRecallInputRecord,
  isFreshRecallInputRecord,
} from "../ui/ui-status.js";
import { defaultSettings } from "../runtime/settings-defaults.js";

// ═══════════════════════════════════════════════════════════════
// 1. ensurePersistedRecallRecordForGeneration: empty recallInput override
// ═══════════════════════════════════════════════════════════════

const harness = await createGenerationRecallHarness({ realApplyFinal: true });

// Prime settings
Object.assign(harness.settings, {
  ...defaultSettings,
  enabled: true,
  recallEnabled: true,
});

harness.chat = [
  { is_user: true, mes: "楼层里的稳定用户输入" },
  { is_user: false, mes: "好的。", is_system: false },
];

const persistedWriteResult = harness.result.persistRecallInjectionRecord({
  recallInput: {
    userMessage: "发送前捕获的权威输入",
    source: "send-intent",
    hookName: "GENERATION_AFTER_COMMANDS",
    targetUserMessageIndex: 0,
    authoritativeInputUsed: true,
    boundUserFloorText: "楼层里的稳定用户输入",
  },
  result: {
    selectedNodeIds: ["node-write-1"],
  },
  injectionText: "注入:楼层里的稳定用户输入",
  tokenEstimate: 8,
});
assert.ok(persistedWriteResult?.record, "persistRecallInjectionRecord should write a record");
assert.equal(
  persistedWriteResult.record.authoritativeInputUsed,
  true,
  "initial persisted record should keep authoritativeInputUsed",
);
assert.equal(
  persistedWriteResult.record.boundUserFloorText,
  "楼层里的稳定用户输入",
  "initial persisted record should keep boundUserFloorText",
);

console.log("  ✓ persistRecallInjectionRecord stores authoritative input metadata");

// Set up chat: user + assistant
harness.chat = [
  { is_user: true, mes: "去摩耶山看夜景" },
  { is_user: false, mes: "好的，我们出发吧。", is_system: false },
];

// Pre-write a persisted record with EMPTY recallInput (simulates old bug)
const emptyRecallInputRecord = buildPersistedRecallRecord({
  injectionText: "注入:去摩耶山看夜景",
  selectedNodeIds: ["node-test-1"],
  recallInput: "",
  recallSource: "chat-tail-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 5,
  manuallyEdited: false,
});
writePersistedRecallToUserMessage(harness.chat, 0, emptyRecallInputRecord);

// Verify the record is written with empty recallInput
const beforeRecord = readPersistedRecallFromUserMessage(harness.chat, 0);
assert.ok(beforeRecord, "persisted record should exist before ensure");
assert.equal(beforeRecord.recallInput, "", "recallInput should be empty before fix");
assert.equal(
  beforeRecord.injectionText,
  "注入:去摩耶山看夜景",
  "injectionText should match",
);

// Build a mock recall result with the same injectionText
const mockRecallResult = {
  status: "completed",
  didRecall: true,
  ok: true,
  injectionText: "注入:去摩耶山看夜景",
  selectedNodeIds: ["node-test-1"],
  source: "chat-last-user",
  sourceLabel: "历史最后用户楼层",
  hookName: "GENERATION_AFTER_COMMANDS",
  authoritativeInputUsed: false,
  boundUserFloorText: "去摩耶山看夜景",
};

// Build frozen recall options with overrideUserMessage
const frozenRecallOptions = {
  generationType: "regenerate",
  targetUserMessageIndex: 0,
  overrideUserMessage: "去摩耶山看夜景",
  overrideSource: "chat-last-user",
  overrideSourceLabel: "历史最后用户楼层",
  lockedSource: "chat-last-user",
  lockedSourceLabel: "历史最后用户楼层",
  authoritativeInputUsed: false,
  boundUserFloorText: "去摩耶山看夜景",
};

// Call ensurePersistedRecallRecordForGeneration
const ensureResult = harness.result.ensurePersistedRecallRecordForGeneration({
  generationType: "regenerate",
  recallResult: mockRecallResult,
  transaction: { frozenRecallOptions },
  recallOptions: frozenRecallOptions,
  hookName: "GENERATION_AFTER_COMMANDS",
});

// After fix: the record should be overwritten because existing recallInput is empty
const afterRecord = readPersistedRecallFromUserMessage(harness.chat, 0);
assert.ok(afterRecord, "persisted record should still exist after ensure");
assert.equal(
  afterRecord.recallInput,
  "去摩耶山看夜景",
  "recallInput should now be populated after ensure overwrites empty-recallInput record",
);
assert.equal(
  afterRecord.boundUserFloorText,
  "去摩耶山看夜景",
  "boundUserFloorText should be populated",
);

console.log("  ✓ ensurePersistedRecallRecordForGeneration overwrites record with empty recallInput");

harness.chat = [
  { is_user: true, mes: "稳定楼层文本" },
  { is_user: false, mes: "好的。", is_system: false },
];
const staleMetadataRecord = buildPersistedRecallRecord({
  injectionText: "注入:稳定楼层文本",
  selectedNodeIds: ["node-stale-meta"],
  recallInput: "发送前捕获文本",
  recallSource: "send-intent",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 4,
  manuallyEdited: false,
});
writePersistedRecallToUserMessage(harness.chat, 0, staleMetadataRecord);
const staleMetadataEnsureResult = harness.result.ensurePersistedRecallRecordForGeneration({
  generationType: "regenerate",
  recallResult: {
    status: "completed",
    didRecall: true,
    ok: true,
    injectionText: "注入:稳定楼层文本",
    selectedNodeIds: ["node-stale-meta"],
    recallInput: "发送前捕获文本",
    source: "send-intent",
    hookName: "GENERATION_AFTER_COMMANDS",
    authoritativeInputUsed: false,
    boundUserFloorText: "稳定楼层文本",
  },
  transaction: {
    frozenRecallOptions: {
      generationType: "regenerate",
      targetUserMessageIndex: 0,
      overrideUserMessage: "稳定楼层文本",
      overrideSource: "chat-last-user",
      authoritativeInputUsed: false,
      boundUserFloorText: "稳定楼层文本",
    },
  },
  recallOptions: {
    generationType: "regenerate",
    targetUserMessageIndex: 0,
    overrideUserMessage: "稳定楼层文本",
    authoritativeInputUsed: false,
    boundUserFloorText: "稳定楼层文本",
  },
  hookName: "GENERATION_AFTER_COMMANDS",
});
assert.equal(
  staleMetadataEnsureResult.persisted,
  true,
  "ensure should rewrite records whose metadata is stale even when text/nodeIds match",
);
const repairedMetadataRecord = readPersistedRecallFromUserMessage(harness.chat, 0);
assert.equal(
  repairedMetadataRecord.boundUserFloorText,
  "稳定楼层文本",
  "ensure should repair missing boundUserFloorText",
);

console.log("  ✓ ensurePersistedRecallRecordForGeneration repairs stale metadata");

// ═══════════════════════════════════════════════════════════════
// 2. ensurePersistedRecallRecordForGeneration: populated recallInput skip
// ═══════════════════════════════════════════════════════════════

harness.chat = [
  { is_user: true, mes: "去摩耶山看夜景" },
  { is_user: false, mes: "好的，我们出发吧。", is_system: false },
];
writePersistedRecallToUserMessage(harness.chat, 0, afterRecord);

// Now the record has proper recallInput — calling ensure again should skip
const ensureResult2 = harness.result.ensurePersistedRecallRecordForGeneration({
  generationType: "regenerate",
  recallResult: mockRecallResult,
  transaction: { frozenRecallOptions },
  recallOptions: frozenRecallOptions,
  hookName: "GENERATION_AFTER_COMMANDS",
});
assert.equal(
  ensureResult2.reason,
  "already-up-to-date",
  "should skip when recallInput is already populated",
);

console.log("  ✓ ensurePersistedRecallRecordForGeneration skips when recallInput is populated");

harness.chat = [
  { is_user: true, mes: "继续写摩耶山夜景" },
  { is_user: false, mes: "前一次回复。", is_system: false },
];
harness.result.cleanupGenerationRecallTransactions(Date.now() + 60000);
const afterCommandsRecallOptions = harness.result.buildGenerationAfterCommandsRecallInput(
  "regenerate",
  {},
  harness.chat,
);
const afterCommandsContext = harness.result.createGenerationRecallContext({
  hookName: "GENERATION_AFTER_COMMANDS",
  generationType: "regenerate",
  recallOptions: afterCommandsRecallOptions,
});
assert.ok(
  afterCommandsContext.transaction,
  "after-commands should create a history transaction",
);
harness.result.markGenerationRecallTransactionHookState(
  afterCommandsContext.transaction,
  "GENERATION_AFTER_COMMANDS",
  "completed",
);
const beforeCombineNormalFallback = harness.result.buildNormalGenerationRecallInput(
  harness.chat,
);
const beforeCombineContext = harness.result.createGenerationRecallContext({
  hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
  generationType: "normal",
  recallOptions: beforeCombineNormalFallback,
});
assert.equal(
  beforeCombineContext.transaction,
  afterCommandsContext.transaction,
  "before-combine should reuse the existing history transaction despite normal fallback input",
);
assert.equal(
  beforeCombineContext.generationType,
  "regenerate",
  "before-combine should keep the transaction's history generation type",
);
assert.equal(
  beforeCombineContext.shouldRun,
  false,
  "before-combine should not run recall again after after-commands completed",
);

console.log("  ✓ before-combine reuses existing history transaction");

// ═══════════════════════════════════════════════════════════════
// 3. runRecallController: regenerate reuses persisted record
// ═══════════════════════════════════════════════════════════════

// Set up a fresh chat with a properly persisted recall record
const rerollChat = [
  { is_user: true, mes: "明日去摩耶山看夜景" },
  { is_user: false, mes: "好的，明天约好了。", is_system: false },
];

const validRecord = buildPersistedRecallRecord({
  injectionText: "注入:明日去摩耶山看夜景",
  selectedNodeIds: ["node-a"],
  recallInput: "发送意图中的扩展文本，不等于当前用户楼层",
  recallSource: "send-intent",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 5,
  manuallyEdited: false,
  boundUserFloorText: "明日去摩耶山看夜景",
});
writePersistedRecallToUserMessage(rerollChat, 0, validRecord);

let retrieveCalled = false;
const rerollRuntime = {
  getIsRecalling: () => false,
  getCurrentGraph: () => ({ nodes: [], edges: [] }),
  getSettings: () => ({
    ...defaultSettings,
    enabled: true,
    recallEnabled: true,
    recallLlmContextMessages: 5,
  }),
  isGraphReadableForRecall: () => true,
  isGraphMetadataWriteAllowed: () => true,
  recoverHistoryIfNeeded: async () => true,
  getContext: () => ({ chat: rerollChat, chatId: "chat-reroll" }),
  nextRecallRunSequence: () => 1,
  beginStageAbortController: () => ({ signal: { aborted: false } }),
  finishStageAbortController: () => {},
  setIsRecalling: () => {},
  setActiveRecallPromise: () => {},
  getActiveRecallPromise: () => null,
  setLastRecallStatus: () => {},
  clampInt: (v, f, mn, mx) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return f;
    return Math.min(mx, Math.max(mn, Math.trunc(n)));
  },
  normalizeRecallInputText,
  createRecallInputRecord,
  createRecallRunResult,
  isFreshRecallInputRecord,
  getLatestUserChatMessage: (chat = []) =>
    [...chat].reverse().find((m) => m?.is_user) || null,
  getLastNonSystemChatMessage: (chat = []) =>
    [...chat].reverse().find((m) => !m?.is_system) || null,
  getRecallUserMessageSourceLabel: (s) => s,
  buildRecallRecentMessages: () => [],
  readPersistedRecallFromUserMessage,
  bumpPersistedRecallGenerationCount: (chat, idx) => {
    // no-op in test; just return the record
    return readPersistedRecallFromUserMessage(chat, idx);
  },
  triggerChatMetadataSave: () => {},
  schedulePersistedRecallMessageUiRefresh: () => {},
  refreshPanelLiveState: () => {},
  ensureVectorReadyIfNeeded: async () => {},
  resolveRecallInput: (chat, limit, override) => {
    // Simulate resolveRecallInputController override path
    const overrideText = normalizeRecallInputText(
      override?.overrideUserMessage || override?.userMessage || "",
    );
    return {
      userMessage: overrideText,
      generationType: String(override?.generationType || "normal"),
      targetUserMessageIndex: Number.isFinite(override?.targetUserMessageIndex)
        ? override.targetUserMessageIndex
        : null,
      source: override?.overrideSource || "chat-last-user",
      sourceLabel: override?.overrideSourceLabel || "历史最后用户楼层",
      reason: "override-bound",
      authoritativeInputUsed: Boolean(override?.authoritativeInputUsed),
      boundUserFloorText: normalizeRecallInputText(
        override?.boundUserFloorText || "",
      ),
      recentMessages: [],
      hookName: override?.hookName || "",
      deliveryMode: "immediate",
    };
  },
  applyRecallInjection: (_settings, _input, _recent, result) => ({
    injectionText: result?.injectionText || "",
    applied: true,
    source: "persisted-reuse",
    mode: "module-injection",
  }),
  retrieve: async () => {
    retrieveCalled = true;
    return {
      injectionText: "should-not-appear",
      selectedNodeIds: ["node-b"],
    };
  },
  buildRecallRetrieveOptions: () => ({}),
  getEmbeddingConfig: () => ({}),
  getSchema: () => ({}),
  console,
  isAbortError: () => false,
  toastr: { error: () => {} },
  getRecallHookLabel: () => "",
  setPendingRecallSendIntent: () => {},
};

// Simulate regenerate: override with the user floor text and generationType regenerate
const rerollResult = await runRecallController(rerollRuntime, {
  overrideUserMessage: "明日去摩耶山看夜景",
  generationType: "regenerate",
  targetUserMessageIndex: 0,
  overrideSource: "chat-last-user",
  overrideSourceLabel: "历史最后用户楼层",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(rerollResult.status, "completed", "reroll should complete");
assert.equal(
  rerollResult.reason,
  "persisted-user-floor-reused",
  "reroll should reuse persisted record, not run fresh recall",
);
assert.equal(
  retrieveCalled,
  false,
  "retrieve() should NOT be called when persisted record is reused",
);
assert.equal(
  rerollResult.injectionText,
  "注入:明日去摩耶山看夜景",
  "injection text should come from persisted record",
);

console.log("  ✓ runRecallController reuses persisted record on regenerate");

const normalTypedReuseChat = [
  { is_user: true, mes: "重 Roll 但宿主仍标 normal" },
  { is_user: false, mes: "上一条回复。", is_system: false },
];
const normalTypedReuseRecord = buildPersistedRecallRecord({
  injectionText: "注入:重 Roll 但宿主仍标 normal",
  selectedNodeIds: ["node-normal-type"],
  recallInput: "旧捕获文本",
  recallSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 5,
  manuallyEdited: false,
  boundUserFloorText: "重 Roll 但宿主仍标 normal",
});
writePersistedRecallToUserMessage(normalTypedReuseChat, 0, normalTypedReuseRecord);

let normalTypedRetrieveCalled = false;
const normalTypedReuseRuntime = {
  ...rerollRuntime,
  getContext: () => ({ chat: normalTypedReuseChat, chatId: "chat-normal-typed-reroll" }),
  retrieve: async () => {
    normalTypedRetrieveCalled = true;
    return {
      injectionText: "不应出现的新召回",
      selectedNodeIds: ["node-new"],
    };
  },
};

const normalTypedReuseResult = await runRecallController(normalTypedReuseRuntime, {
  overrideUserMessage: "重 Roll 但宿主仍标 normal",
  generationType: "normal",
  targetUserMessageIndex: 0,
  overrideSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(
  normalTypedReuseResult.reason,
  "persisted-user-floor-reused",
  "normal-typed reroll should still reuse target user-floor recall",
);
assert.equal(
  normalTypedRetrieveCalled,
  false,
  "normal-typed reroll should not call retrieve when target user floor has recall",
);

console.log("  ✓ runRecallController reuses persisted record when host reports reroll as normal");

const legacyUnboundReuseChat = [
  { is_user: true, mes: "旧记录没有绑定楼层" },
  { is_user: false, mes: "上一条回复。", is_system: false },
];
const legacyUnboundRecord = buildPersistedRecallRecord({
  injectionText: "注入:旧记录没有绑定楼层",
  selectedNodeIds: ["node-legacy-unbound"],
  recallInput: "历史旧输入",
  recallSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 5,
  manuallyEdited: false,
});
writePersistedRecallToUserMessage(legacyUnboundReuseChat, 0, legacyUnboundRecord);

let legacyUnboundRetrieveCalled = false;
const legacyUnboundRuntime = {
  ...rerollRuntime,
  getContext: () => ({ chat: legacyUnboundReuseChat, chatId: "chat-legacy-unbound" }),
  retrieve: async () => {
    legacyUnboundRetrieveCalled = true;
    return {
      injectionText: "不应出现的旧记录新召回",
      selectedNodeIds: ["node-new"],
    };
  },
};

const legacyUnboundResult = await runRecallController(legacyUnboundRuntime, {
  overrideUserMessage: "旧记录没有绑定楼层",
  generationType: "normal",
  targetUserMessageIndex: 0,
  overrideSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(
  legacyUnboundResult.reason,
  "persisted-user-floor-reused",
  "legacy unbound user-floor recall should be reused for normal-typed history generation",
);
assert.equal(
  legacyUnboundRetrieveCalled,
  false,
  "legacy unbound user-floor recall should not call retrieve",
);

console.log("  ✓ runRecallController reuses legacy unbound user-floor recall");

const activeInputUnboundChat = [
  { is_user: true, mes: "主动新输入不应复用旧召回" },
  { is_user: false, mes: "上一条回复。", is_system: false },
];
const activeInputUnboundRecord = buildPersistedRecallRecord({
  injectionText: "旧注入:主动新输入不应复用旧召回",
  selectedNodeIds: ["node-active-old"],
  recallInput: "旧输入",
  recallSource: "send-intent",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 5,
  manuallyEdited: false,
});
writePersistedRecallToUserMessage(activeInputUnboundChat, 0, activeInputUnboundRecord);

let activeInputRetrieveCalled = false;
const activeInputRuntime = {
  ...rerollRuntime,
  getContext: () => ({ chat: activeInputUnboundChat, chatId: "chat-active-input" }),
  retrieve: async () => {
    activeInputRetrieveCalled = true;
    return {
      injectionText: "新召回:主动新输入不应复用旧召回",
      selectedNodeIds: ["node-active-new"],
    };
  },
};

const activeInputResult = await runRecallController(activeInputRuntime, {
  overrideUserMessage: "主动新输入不应复用旧召回",
  generationType: "normal",
  targetUserMessageIndex: 0,
  overrideSource: "send-intent",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(
  activeInputRetrieveCalled,
  true,
  "active send-intent input should not reuse an unbound stale record",
);
assert.equal(
  activeInputResult.injectionText,
  "新召回:主动新输入不应复用旧召回",
  "active send-intent input should use the fresh recall result",
);

console.log("  ✓ runRecallController does not reuse unbound record for active input");

const mismatchedBoundChat = [
  { is_user: true, mes: "已经编辑过的新楼层" },
  { is_user: false, mes: "上一条回复。", is_system: false },
];
const mismatchedBoundRecord = buildPersistedRecallRecord({
  injectionText: "旧注入:已经编辑过的新楼层",
  selectedNodeIds: ["node-mismatch-old"],
  recallInput: "已经编辑过的新楼层",
  recallSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 5,
  manuallyEdited: false,
  boundUserFloorText: "编辑前的旧楼层",
});
writePersistedRecallToUserMessage(mismatchedBoundChat, 0, mismatchedBoundRecord);

let mismatchedBoundRetrieveCalled = false;
const mismatchedBoundRuntime = {
  ...rerollRuntime,
  getContext: () => ({ chat: mismatchedBoundChat, chatId: "chat-bound-mismatch" }),
  retrieve: async () => {
    mismatchedBoundRetrieveCalled = true;
    return {
      injectionText: "新召回:已经编辑过的新楼层",
      selectedNodeIds: ["node-mismatch-new"],
    };
  },
};

const mismatchedBoundResult = await runRecallController(mismatchedBoundRuntime, {
  overrideUserMessage: "已经编辑过的新楼层",
  generationType: "normal",
  targetUserMessageIndex: 0,
  overrideSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(
  mismatchedBoundRetrieveCalled,
  true,
  "bound user-floor mismatch should force a fresh recall",
);
assert.equal(
  mismatchedBoundResult.injectionText,
  "新召回:已经编辑过的新楼层",
  "bound user-floor mismatch should not reuse stale persisted recall",
);

console.log("  ✓ runRecallController does not reuse record when bound user floor mismatches");

// ═══════════════════════════════════════════════════════════════
// 4. runRecallController: regenerate with empty recallInput reuses user-floor record
// ═══════════════════════════════════════════════════════════════

const noReuseChat = [
  { is_user: true, mes: "去看星星" },
  { is_user: false, mes: "好的。", is_system: false },
];
const emptyInputRecord = buildPersistedRecallRecord({
  injectionText: "注入:去看星星",
  selectedNodeIds: ["node-c"],
  recallInput: "",
  recallSource: "chat-tail-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 3,
  manuallyEdited: false,
});
writePersistedRecallToUserMessage(noReuseChat, 0, emptyInputRecord);

let noReuseRetrieveCalled = false;
const noReuseRuntime = {
  ...rerollRuntime,
  getContext: () => ({ chat: noReuseChat, chatId: "chat-no-reuse" }),
  readPersistedRecallFromUserMessage,
  retrieve: async () => {
    noReuseRetrieveCalled = true;
    return {
      injectionText: "新召回结果",
      selectedNodeIds: ["node-d"],
    };
  },
  resolveRecallInput: (chat, limit, override) => ({
    userMessage: normalizeRecallInputText(
      override?.overrideUserMessage || "",
    ),
    generationType: String(override?.generationType || "normal"),
    targetUserMessageIndex: Number.isFinite(override?.targetUserMessageIndex)
      ? override.targetUserMessageIndex
      : null,
    source: override?.overrideSource || "chat-last-user",
    sourceLabel: override?.overrideSourceLabel || "",
    reason: "override-bound",
    authoritativeInputUsed: false,
    boundUserFloorText: "",
    recentMessages: [],
    hookName: override?.hookName || "",
    deliveryMode: "immediate",
  }),
};

const noReuseResult = await runRecallController(noReuseRuntime, {
  overrideUserMessage: "去看星星",
  generationType: "regenerate",
  targetUserMessageIndex: 0,
  overrideSource: "chat-last-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(noReuseResult.status, "completed", "no-reuse should complete");
assert.equal(
  noReuseRetrieveCalled,
  false,
  "retrieve() should NOT be called when target user floor has a persisted recall record",
);
assert.equal(
  noReuseResult.reason,
  "persisted-user-floor-reused",
  "empty recallInput legacy records should still be reused from the user floor",
);

console.log("  ✓ runRecallController reuses user-floor record with empty recallInput");

// ═══════════════════════════════════════════════════════════════
// 5. runRecallController: normal generation below an assistant reuses user-floor record
// ═══════════════════════════════════════════════════════════════

const assistantTailChat = [
  { is_user: true, mes: "今晚去海边看烟花" },
  { is_user: false, mes: "好，我会准备好相机。", is_system: false },
];
const assistantTailRecord = buildPersistedRecallRecord({
  injectionText: "注入:今晚去海边看烟花",
  selectedNodeIds: ["node-fireworks"],
  recallInput: "今晚去海边看烟花",
  recallSource: "chat-latest-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  tokenEstimate: 4,
  manuallyEdited: false,
  boundUserFloorText: "今晚去海边看烟花",
});
writePersistedRecallToUserMessage(assistantTailChat, 0, assistantTailRecord);

let assistantTailRetrieveCalled = false;
const assistantTailRuntime = {
  ...rerollRuntime,
  getContext: () => ({ chat: assistantTailChat, chatId: "chat-assistant-tail" }),
  readPersistedRecallFromUserMessage,
  retrieve: async () => {
    assistantTailRetrieveCalled = true;
    return {
      injectionText: "fresh recall should not run",
      selectedNodeIds: ["node-fresh"],
    };
  },
  resolveRecallInput: (chat, limit, override) => ({
    userMessage: normalizeRecallInputText(
      override?.overrideUserMessage || override?.userMessage || "今晚去海边看烟花",
    ),
    generationType: String(override?.generationType || "normal"),
    targetUserMessageIndex: Number.isFinite(override?.targetUserMessageIndex)
      ? override.targetUserMessageIndex
      : null,
    source: override?.overrideSource || "chat-latest-user",
    sourceLabel: override?.overrideSourceLabel || "最近用户消息",
    reason: "assistant-tail-normal-generation",
    authoritativeInputUsed: Boolean(override?.authoritativeInputUsed),
    boundUserFloorText: normalizeRecallInputText(
      override?.boundUserFloorText || "今晚去海边看烟花",
    ),
    recentMessages: [],
    hookName: override?.hookName || "",
    deliveryMode: "immediate",
  }),
};

const assistantTailResult = await runRecallController(assistantTailRuntime, {
  overrideUserMessage: "今晚去海边看烟花",
  generationType: "normal",
  overrideSource: "chat-latest-user",
  hookName: "GENERATION_AFTER_COMMANDS",
  deliveryMode: "immediate",
});

assert.equal(assistantTailResult.status, "completed");
assert.equal(
  assistantTailRetrieveCalled,
  false,
  "normal generation below an assistant should find and reuse the matching user-floor persisted recall",
);
assert.equal(assistantTailResult.reason, "persisted-user-floor-reused");

console.log("  ✓ runRecallController reuses user-floor record below assistant tail");
console.log("recall-reroll-reuse tests passed");
