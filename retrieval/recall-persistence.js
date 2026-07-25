// ST-BME: 持久化召回记录纯函数

import { resolveGenerationParentUserFloor } from "../runtime/generation-context.js";
import { stableHashString } from "../runtime/runtime-state.js";

export const BME_RECALL_EXTRA_KEY = "bme_recall";
export const BME_RECALL_VERSION = 2;

function toIsoString(value) {
  if (typeof value === "string" && value.trim()) return value;
  return new Date().toISOString();
}

function cloneStringArray(value) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
}

function cloneRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...value };
}

function normalizeBoundUserFloorText(value = "") {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

export function buildRecallHistoryFingerprint(chat, userMessageIndex) {
  if (!Array.isArray(chat) || !Number.isFinite(userMessageIndex)) return "";
  const upperBound = Math.floor(Number(userMessageIndex));
  if (upperBound < 0 || !chat[upperBound]?.is_user) return "";

  const prefix = [];
  for (let index = 0; index <= upperBound; index++) {
    const message = chat[index];
    if (!message || typeof message !== "object") continue;
    prefix.push({
      isUser: Boolean(message.is_user),
      isSystem: Boolean(message.is_system),
      text: String(message.mes || "").replace(/\r\n/g, "\n"),
      swipeId: Number.isFinite(message.swipe_id)
        ? message.swipe_id
        : null,
    });
  }

  return `v1:${stableHashString(JSON.stringify(prefix))}`;
}

export function validatePersistedRecallForUserMessage(
  chat,
  userMessageIndex,
  persistedRecord = null,
) {
  if (!Array.isArray(chat) || !Number.isFinite(userMessageIndex)) {
    return { valid: false, reason: "target-unresolved", record: null };
  }

  const targetIndex = Math.floor(Number(userMessageIndex));
  const targetMessage = chat[targetIndex];
  if (!targetMessage?.is_user) {
    return { valid: false, reason: "parent-not-user", record: null };
  }

  const record =
    cloneRecord(persistedRecord) ||
    readPersistedRecallFromUserMessage(chat, targetIndex);
  if (!record?.injectionText) {
    return { valid: false, reason: "no-record", record: null };
  }
  const recordVersion = Number(record.version || 1);
  if (
    !Number.isFinite(recordVersion) ||
    recordVersion < 1 ||
    recordVersion > BME_RECALL_VERSION
  ) {
    return { valid: false, reason: "unsupported-recall-version", record };
  }

  const currentFloorText = normalizeBoundUserFloorText(targetMessage.mes || "");
  const boundFloorText = normalizeBoundUserFloorText(
    record.boundUserFloorText || "",
  );
  const legacyRecallInput = normalizeBoundUserFloorText(record.recallInput || "");
  if (boundFloorText && boundFloorText !== currentFloorText) {
    return { valid: false, reason: "bound-mismatch", record };
  }
  if (!boundFloorText && legacyRecallInput && legacyRecallInput !== currentFloorText) {
    return { valid: false, reason: "legacy-recall-input-mismatch", record };
  }

  const expectedFingerprint = buildRecallHistoryFingerprint(chat, targetIndex);
  const storedFingerprint = String(record.historyFingerprint || "").trim();
  if (!storedFingerprint) {
    return {
      valid: false,
      reason: "missing-history-fingerprint",
      record,
      expectedFingerprint,
    };
  }
  if (storedFingerprint !== expectedFingerprint) {
    return {
      valid: false,
      reason: "history-fingerprint-mismatch",
      record,
      expectedFingerprint,
    };
  }

  return {
    valid: true,
    reason: "validated",
    record,
    expectedFingerprint,
  };
}

export function readPersistedRecallFromUserMessage(chat, userMessageIndex) {
  if (!Array.isArray(chat) || !Number.isFinite(userMessageIndex)) return null;
  const message = chat[userMessageIndex];
  const raw = message?.extra?.[BME_RECALL_EXTRA_KEY];
  const record = cloneRecord(raw);
  if (!record) return null;

  const injectionText = String(record.injectionText || "").trim();
  if (!injectionText) return null;

  return {
    version: Number.isFinite(Number(record.version))
      ? Number(record.version)
      : 1,
    injectionText,
    selectedNodeIds: cloneStringArray(record.selectedNodeIds),
    recallInput: String(record.recallInput || ""),
    recallSource: String(record.recallSource || ""),
    hookName: String(record.hookName || ""),
    tokenEstimate: Number.isFinite(Number(record.tokenEstimate))
      ? Number(record.tokenEstimate)
      : 0,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
    generationCount: Math.max(0, Number.parseInt(record.generationCount, 10) || 0),
    manuallyEdited: Boolean(record.manuallyEdited),
    authoritativeInputUsed: Boolean(record.authoritativeInputUsed),
    boundUserFloorText: String(record.boundUserFloorText || ""),
    historyFingerprint: String(record.historyFingerprint || ""),
  };
}

export function buildPersistedRecallRecord(payload = {}, existingRecord = null) {
  const nowIso = toIsoString(payload.nowIso);
  const previous = cloneRecord(existingRecord) || {};
  const injectionText = String(payload.injectionText || "").trim();

  return {
    version: BME_RECALL_VERSION,
    injectionText,
    selectedNodeIds: cloneStringArray(payload.selectedNodeIds),
    recallInput: String(payload.recallInput || ""),
    recallSource: String(payload.recallSource || ""),
    hookName: String(payload.hookName || ""),
    tokenEstimate: Number.isFinite(Number(payload.tokenEstimate))
      ? Number(payload.tokenEstimate)
      : 0,
    createdAt: toIsoString(previous.createdAt || nowIso),
    updatedAt: nowIso,
    generationCount: 0,
    manuallyEdited: Boolean(payload.manuallyEdited),
    authoritativeInputUsed: Boolean(payload.authoritativeInputUsed),
    boundUserFloorText: String(payload.boundUserFloorText || ""),
    historyFingerprint: String(payload.historyFingerprint || ""),
  };
}

export function writePersistedRecallToUserMessage(chat, userMessageIndex, record) {
  if (!Array.isArray(chat) || !Number.isFinite(userMessageIndex)) return false;
  const message = chat[userMessageIndex];
  if (!message || !message.is_user) return false;

  const normalized = cloneRecord(record);
  if (!normalized || !String(normalized.injectionText || "").trim()) return false;

  message.extra ||= {};
  message.extra[BME_RECALL_EXTRA_KEY] = normalized;
  return true;
}

export function removePersistedRecallFromUserMessage(chat, userMessageIndex) {
  if (!Array.isArray(chat) || !Number.isFinite(userMessageIndex)) return false;
  const message = chat[userMessageIndex];
  if (!message?.extra || typeof message.extra !== "object") return false;
  if (!(BME_RECALL_EXTRA_KEY in message.extra)) return false;
  delete message.extra[BME_RECALL_EXTRA_KEY];
  return true;
}

export function markPersistedRecallManualEdit(
  chat,
  userMessageIndex,
  manuallyEdited = true,
  nowIso = new Date().toISOString(),
) {
  const current = readPersistedRecallFromUserMessage(chat, userMessageIndex);
  if (!current) return null;
  const nextRecord = {
    ...current,
    manuallyEdited: Boolean(manuallyEdited),
    updatedAt: toIsoString(nowIso),
  };
  if (!writePersistedRecallToUserMessage(chat, userMessageIndex, nextRecord)) {
    return null;
  }
  return nextRecord;
}

export function bumpPersistedRecallGenerationCount(chat, userMessageIndex) {
  const current = readPersistedRecallFromUserMessage(chat, userMessageIndex);
  if (!current) return null;
  const nextRecord = {
    ...current,
    generationCount: Math.max(0, Number(current.generationCount || 0)) + 1,
  };
  if (!writePersistedRecallToUserMessage(chat, userMessageIndex, nextRecord)) {
    return null;
  }
  return nextRecord;
}

export function resolveGenerationTargetUserMessageIndex(
  chat,
  { generationType = "normal", generationContext = null } = {},
) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  return resolveGenerationParentUserFloor(
    chat,
    generationContext && typeof generationContext === "object"
      ? { ...generationContext, type: generationContext.type || generationType }
      : { type: generationType },
  );
}

export function resolveFinalRecallInjectionSource({
  freshRecallResult = null,
  persistedRecord = null,
} = {}) {
  const freshInjection = String(freshRecallResult?.injectionText || "").trim();
  if (
    freshRecallResult?.status === "completed" &&
    freshRecallResult?.didRecall &&
    freshInjection
  ) {
    return {
      source: "fresh",
      injectionText: freshInjection,
      record: null,
    };
  }

  const persistedInjection = String(persistedRecord?.injectionText || "").trim();
  if (persistedInjection) {
    return {
      source: "persisted",
      injectionText: persistedInjection,
      record: persistedRecord,
    };
  }

  return {
    source: "none",
    injectionText: "",
    record: null,
  };
}
