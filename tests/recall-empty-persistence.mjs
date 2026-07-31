import assert from "node:assert/strict";
import {
  BME_RECALL_STATUS,
  BME_RECALL_VERSION,
  buildPersistedRecallRecord,
  buildRecallHistoryFingerprint,
  bumpPersistedRecallGenerationCount,
  readPersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  validatePersistedRecallForUserMessage,
  writePersistedRecallToUserMessage,
} from "../retrieval/recall-persistence.js";
import { createFinalRecallInjection } from "../runtime/final-recall-injection.js";

const chat = [{ is_user: true, mes: "First turn", extra: {} }];
const historyFingerprint = buildRecallHistoryFingerprint(chat, 0);
const emptyRecord = buildPersistedRecallRecord({
  empty: true,
  selectedNodeIds: [],
  candidateNodeIds: [],
  recallInput: "First turn",
  recallSource: "recall-agent",
  boundUserFloorText: "First turn",
  historyFingerprint,
  artifactId: "artifact:empty",
  turnId: "turn:first",
  inputFingerprint: "input:first",
  memoryStateFingerprint: "memory:empty",
});
assert.equal(emptyRecord.version, BME_RECALL_VERSION);
assert.equal(emptyRecord.status, BME_RECALL_STATUS.EMPTY);
assert.equal(writePersistedRecallToUserMessage(chat, 0, emptyRecord), true);
const loadedEmpty = readPersistedRecallFromUserMessage(chat, 0);
assert.equal(loadedEmpty.completed, true);
assert.equal(loadedEmpty.empty, true);
assert.equal(loadedEmpty.injectionText, "");
assert.equal(loadedEmpty.artifactId, "artifact:empty");
assert.equal(validatePersistedRecallForUserMessage(chat, 0).valid, true);
assert.equal(bumpPersistedRecallGenerationCount(chat, 0).generationCount, 1);
assert.throws(
  () => buildPersistedRecallRecord({ injectionText: "" }),
  /explicit empty completion/,
);
assert.equal(
  writePersistedRecallToUserMessage(
    [{ is_user: true, mes: "legacy", extra: {} }],
    0,
    { version: 2, status: BME_RECALL_STATUS.EMPTY, injectionText: "" },
  ),
  false,
);

assert.equal(
  readPersistedRecallFromUserMessage(
    [{ is_user: true, mes: "legacy", extra: { bme_recall: { version: 2 } } }],
    0,
  ),
  null,
);
assert.equal(
  readPersistedRecallFromUserMessage(
    [{ is_user: true, mes: "legacy", extra: { bme_recall: { version: 2, injectionText: "memory" } } }],
    0,
  )?.status,
  BME_RECALL_STATUS.READY,
);

const freshEmpty = resolveFinalRecallInjectionSource({
  freshRecallResult: { status: "completed", empty: true, injectionText: "" },
  persistedRecord: { status: BME_RECALL_STATUS.READY, injectionText: "stale" },
});
assert.equal(freshEmpty.source, "fresh-empty");
assert.equal(freshEmpty.injectionText, "");
const persistedEmpty = resolveFinalRecallInjectionSource({
  persistedRecord: loadedEmpty,
});
assert.equal(persistedEmpty.source, "persisted-empty");

const finalChat = [{ is_user: true, mes: "No prior memory", extra: {} }];
const finalRecall = createFinalRecallInjection({
  normalizeRecallInputText: (value) => String(value || "").trim(),
  getContext: () => ({ chat: finalChat }),
  getLastRecallSentUserMessage: () => ({}),
  readPersistedRecallFromUserMessage,
  buildPersistedRecallRecord,
  writePersistedRecallToUserMessage,
  triggerChatMetadataSave: () => {},
  schedulePersistedRecallMessageUiRefresh: () => {},
  resolveRecallPersistenceTargetUserMessageIndex: () => 0,
  normalizeRecallNodeIdList: (values) => [...new Set(values || [])],
  areRecallNodeIdListsEqual: (left, right) =>
    JSON.stringify(left || []) === JSON.stringify(right || []),
  estimateTokens: () => 0,
});
const ensured = finalRecall.ensurePersistedRecallRecordForGeneration({
  generationType: "normal",
  stableTargetUserMessageIndex: 0,
  recallResult: {
    status: "completed",
    didRecall: false,
    empty: true,
    injectionText: "",
    selectedNodeIds: [],
    candidateMemoryIds: [],
    artifactId: "artifact:first-floor",
    turnId: "turn:first-floor",
    inputFingerprint: "input:first-floor",
    memoryStateFingerprint: "memory:none",
    recallInput: "No prior memory",
    source: "recall-agent",
  },
});
assert.equal(ensured.persisted, true);
assert.equal(finalChat[0].extra.bme_recall.status, BME_RECALL_STATUS.EMPTY);
assert.equal(finalChat[0].extra.bme_recall.artifactId, "artifact:first-floor");

console.log("empty recall persistence tests passed");
