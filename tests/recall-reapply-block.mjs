import assert from "node:assert/strict";
import { createFinalRecallInjection } from "../runtime/final-recall-injection.js";
import { buildRecallHistoryFingerprint } from "../retrieval/recall-persistence.js";

function normalizeRecallInputText(value = "") {
  return String(value || "").trim();
}

function createHarness({
  chat = [],
  parentIndex = 0,
  settings = { enabled: true, recallEnabled: true },
} = {}) {
  const calls = {
    applied: [],
    rewritesCleared: 0,
    metadataSaves: 0,
    snapshots: [],
    refreshes: 0,
    uiRefreshes: 0,
    statuses: [],
  };
  const runtime = createFinalRecallInjection({
    applyModuleInjectionPrompt: (injectionText = "") => {
      calls.applied.push(String(injectionText || ""));
      return {
        applied: Boolean(String(injectionText || "").trim()),
        source: "module-injection",
        mode: "extension-prompt",
        injectionText: String(injectionText || ""),
      };
    },
    bumpPersistedRecallGenerationCount: (targetChat, userMessageIndex) => {
      const record = targetChat[userMessageIndex]?.extra?.bme_recall;
      if (record) {
        record.generationCount = Number(record.generationCount || 0) + 1;
      }
      return record || null;
    },
    clearLiveRecallInjectionPromptForRewrite: () => {
      calls.rewritesCleared += 1;
    },
    createUiStatus: (title, message, tone) => ({ title, message, tone }),
    getContext: () => ({ chat, chatId: "chat-reapply-test" }),
    getSettings: () => settings,
    normalizeRecallInputText,
    readPersistedRecallFromUserMessage: (targetChat, userMessageIndex) => {
      const record = targetChat[userMessageIndex]?.extra?.bme_recall;
      if (!record || !String(record.injectionText || "").trim()) return null;
      return { ...record };
    },
    recordInjectionSnapshot: (type, payload) => {
      calls.snapshots.push({ type, payload });
    },
    refreshPanelLiveState: () => {
      calls.refreshes += 1;
    },
    resolveGenerationTargetUserMessageIndex: () => parentIndex,
    schedulePersistedRecallMessageUiRefresh: () => {
      calls.uiRefreshes += 1;
    },
    setLastInjectionContent: (value = "") => {
      calls.lastInjectionContent = String(value || "");
    },
    setRuntimeStatus: (status) => {
      calls.statuses.push(status);
    },
    triggerChatMetadataSave: () => {
      calls.metadataSaves += 1;
    },
  });

  return { calls, runtime };
}

function userMessage(mes = "", record = null) {
  const message = { is_user: true, mes };
  if (record) {
    if (Number(record.version) >= 2 && !record.historyFingerprint) {
      record.historyFingerprint = buildRecallHistoryFingerprint([message], 0);
    }
    message.extra = { bme_recall: record };
  }
  return message;
}

function recallRecord(overrides = {}) {
  return {
    version: 2,
    injectionText: "[recall] stable memory",
    selectedNodeIds: ["node-a"],
    recallInput: "stable floor",
    boundUserFloorText: "stable floor",
    generationCount: 0,
    ...overrides,
  };
}

{
  const chat = [userMessage("stable floor", recallRecord())];
  const { calls, runtime } = createHarness({
    chat,
    parentIndex: 0,
    settings: { enabled: false, recallEnabled: true },
  });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "disabled");
  assert.deepEqual(calls.applied, []);
  assert.equal(calls.rewritesCleared, 0);
  assert.equal(calls.snapshots.length, 0);
}

{
  const chat = [
    userMessage("stable floor", recallRecord()),
    { is_user: false, mes: "assistant", is_system: false },
  ];
  const promptData = {
    finalMesSend: [{ message: "stable floor", extensionPrompts: [] }],
  };
  const { calls, runtime } = createHarness({ chat, parentIndex: 0 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
    promptData,
    hookName: "GENERATE_BEFORE_COMBINE_PROMPTS",
  });

  assert.equal(result.applied, true);
  assert.equal(result.source, "persisted");
  assert.equal(result.injectionText, "[recall] stable memory");
  assert.match(promptData.finalMesSend[0].extensionPrompts[0], /\[BEGIN ST-BME MEMORY CONTEXT\]/);
  assert.match(promptData.finalMesSend[0].extensionPrompts[0], /\[recall\] stable memory/);
  assert.match(promptData.finalMesSend[0].extensionPrompts[0], /\[END ST-BME MEMORY CONTEXT\]/);
  assert.deepEqual(calls.applied, [], "rewrite path should not use module injection");
  assert.equal(calls.rewritesCleared, 1);
  assert.equal(chat[0].extra.bme_recall.generationCount, 1);
}

{
  const chat = [userMessage("edited floor", recallRecord())];
  const { calls, runtime } = createHarness({ chat, parentIndex: 0 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "bound-mismatch");
  assert.deepEqual(calls.applied, []);
  assert.equal(calls.snapshots.length, 0);
}

{
  const chat = [
    userMessage("earlier user"),
    { is_user: false, mes: "earlier assistant", is_system: false },
    userMessage("stable floor"),
  ];
  const record = recallRecord();
  record.historyFingerprint = buildRecallHistoryFingerprint(chat, 2);
  chat[2].extra = { bme_recall: record };
  chat[1].mes = "edited earlier assistant";
  const { calls, runtime } = createHarness({ chat, parentIndex: 2 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "history-fingerprint-mismatch");
  assert.deepEqual(calls.applied, []);
}

{
  const chat = [userMessage("stable floor")];
  const { calls, runtime } = createHarness({ chat, parentIndex: 0 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "no-record");
  assert.deepEqual(calls.applied, []);
}

{
  const chat = [
    userMessage("legacy floor", recallRecord({
      version: 1,
      injectionText: "legacy memory",
      recallInput: "legacy floor",
      boundUserFloorText: "",
    })),
  ];
  const { calls, runtime } = createHarness({ chat, parentIndex: 0 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "missing-history-fingerprint");
  assert.deepEqual(calls.applied, []);
}

{
  const chat = [
    userMessage("edited legacy floor", recallRecord({
      version: 1,
      injectionText: "stale legacy memory",
      recallInput: "old legacy floor",
      boundUserFloorText: "",
    })),
  ];
  const { calls, runtime } = createHarness({ chat, parentIndex: 0 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "legacy-recall-input-mismatch");
  assert.deepEqual(calls.applied, []);
}

{
  const chat = [
    userMessage("future floor", recallRecord({
      version: 99,
      injectionText: "future memory",
      recallInput: "future floor",
      boundUserFloorText: "future floor",
    })),
  ];
  const { calls, runtime } = createHarness({ chat, parentIndex: 0 });

  const result = runtime.reapplyPersistedRecallBlock({
    generationType: "regenerate",
    generationContext: { kind: "no-new-user", type: "regenerate" },
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "unsupported-recall-version");
  assert.deepEqual(calls.applied, []);
}

console.log("recall-reapply-block tests passed");
