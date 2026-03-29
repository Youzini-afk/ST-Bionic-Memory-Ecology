// ST-BME: 持久化召回记录纯函数

export const BME_RECALL_EXTRA_KEY = "bme_recall";
export const BME_RECALL_VERSION = 1;

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
      : BME_RECALL_VERSION,
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
  { generationType = "normal" } = {},
) {
  if (!Array.isArray(chat) || chat.length === 0) return null;

  const normalizedType = String(generationType || "normal").trim() || "normal";

  if (normalizedType === "normal") {
    for (let index = chat.length - 1; index >= 0; index--) {
      const message = chat[index];
      if (message?.is_system) continue;
      return message?.is_user ? index : null;
    }
    return null;
  }

  for (let index = chat.length - 1; index >= 0; index--) {
    if (chat[index]?.is_user) return index;
  }

  return null;
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
