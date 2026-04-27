const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function normalizeMode(value = "minimal") {
  const normalized = String(value || "minimal").trim().toLowerCase();
  return ["minimal", "off", "emergency-snapshot"].includes(normalized)
    ? normalized
    : "minimal";
}

function estimateJsonBytes(value) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value ?? null) || "null";
  } catch {
    serialized = String(value ?? "");
  }
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(serialized).byteLength;
  }
  return serialized.length * 2;
}

function normalizeQueueItem(item = {}, nowMs = Date.now()) {
  const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const payload = source.payload && typeof source.payload === "object" ? source.payload : source;
  const rawCreatedAt = Number(source.createdAt ?? nowMs);
  const createdAt = Number.isFinite(rawCreatedAt)
    ? Math.max(0, rawCreatedAt)
    : nowMs;
  const rawBytes = Number(source.bytes ?? estimateJsonBytes(payload));
  const bytes = Number.isFinite(rawBytes) ? Math.max(0, rawBytes) : 0;
  return {
    id: String(source.id || `offline-${createdAt}-${Math.random().toString(36).slice(2, 8)}`),
    kind: String(source.kind || "mutation"),
    reason: String(source.reason || "authority-offline"),
    createdAt,
    bytes,
    payload,
  };
}

function pruneQueue(queue = [], policy = {}, nowMs = Date.now()) {
  const maxAgeMs = Math.max(0, Number(policy.maxAgeMs || DEFAULT_MAX_AGE_MS) || 0);
  if (!Array.isArray(queue)) return [];
  return queue
    .map((item) => normalizeQueueItem(item, nowMs))
    .filter((item) => maxAgeMs <= 0 || nowMs - item.createdAt <= maxAgeMs)
    .sort((left, right) => left.createdAt - right.createdAt);
}

function summarizeQueue(queue = []) {
  const items = Array.isArray(queue) ? queue : [];
  const bytes = items.reduce((sum, item) => sum + Math.max(0, Number(item?.bytes || 0) || 0), 0);
  return {
    items: items.length,
    bytes,
  };
}

export function getAuthorityBrowserStoragePolicy(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return {
    mode: normalizeMode(source.authorityBrowserCacheMode),
    offlineWritePolicy: String(source.authorityOfflineWritePolicy || "queue-local-dirty"),
    maxBytes: clampInteger(source.authorityOfflineQueueMaxBytes, DEFAULT_MAX_BYTES, 0, 64 * 1024 * 1024),
    maxItems: clampInteger(source.authorityOfflineQueueMaxItems, DEFAULT_MAX_ITEMS, 0, 100000),
    maxAgeMs: clampInteger(source.authorityOfflineQueueMaxAgeMs, DEFAULT_MAX_AGE_MS, 0, 30 * 24 * 60 * 60 * 1000),
  };
}

export function createAuthorityBrowserState(overrides = {}) {
  return {
    mode: "minimal",
    serverRevision: 0,
    serverIntegrity: "",
    lastProbeAt: 0,
    lastCommitAt: 0,
    lastError: "",
    offlineQueue: [],
    offlineQueueBytes: 0,
    offlineQueueItems: 0,
    offlineQueueOverflow: false,
    offlineQueueOverflowReason: "",
    updatedAt: "",
    ...overrides,
  };
}

export function normalizeAuthorityBrowserState(input = {}, settings = {}, nowMs = Date.now()) {
  const policy = getAuthorityBrowserStoragePolicy(settings);
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const queue = pruneQueue(source.offlineQueue, policy, nowMs);
  const summary = summarizeQueue(queue);
  return createAuthorityBrowserState({
    mode: policy.mode,
    serverRevision: Math.max(0, Number(source.serverRevision || 0) || 0),
    serverIntegrity: String(source.serverIntegrity || ""),
    lastProbeAt: Math.max(0, Number(source.lastProbeAt || 0) || 0),
    lastCommitAt: Math.max(0, Number(source.lastCommitAt || 0) || 0),
    lastError: String(source.lastError || ""),
    offlineQueue: queue,
    offlineQueueBytes: summary.bytes,
    offlineQueueItems: summary.items,
    offlineQueueOverflow: Boolean(source.offlineQueueOverflow),
    offlineQueueOverflowReason: String(source.offlineQueueOverflowReason || ""),
    updatedAt: String(source.updatedAt || ""),
  });
}

export function recordAuthorityAcceptedRevision(state = {}, accepted = {}, settings = {}, nowMs = Date.now()) {
  const current = normalizeAuthorityBrowserState(state, settings, nowMs);
  return createAuthorityBrowserState({
    ...current,
    serverRevision: Math.max(current.serverRevision, Number(accepted.revision || 0) || 0),
    serverIntegrity: String(accepted.integrity || current.serverIntegrity || ""),
    lastCommitAt: Math.max(0, Number(accepted.committedAt || nowMs) || nowMs),
    lastError: "",
    updatedAt: new Date(nowMs).toISOString(),
  });
}

export function enqueueAuthorityOfflineMutation(state = {}, mutation = {}, settings = {}, nowMs = Date.now()) {
  const policy = getAuthorityBrowserStoragePolicy(settings);
  const current = normalizeAuthorityBrowserState(state, settings, nowMs);
  if (policy.mode === "off" || policy.offlineWritePolicy === "off") {
    const nextState = createAuthorityBrowserState({
      ...current,
      offlineQueueOverflow: true,
      offlineQueueOverflowReason: "offline-queue-disabled",
      updatedAt: new Date(nowMs).toISOString(),
    });
    return { accepted: false, reason: "offline-queue-disabled", state: nextState };
  }

  const item = normalizeQueueItem(mutation, nowMs);
  const nextItems = [...current.offlineQueue, item];
  const nextSummary = summarizeQueue(nextItems);
  if (policy.maxItems > 0 && nextSummary.items > policy.maxItems) {
    const nextState = createAuthorityBrowserState({
      ...current,
      offlineQueueOverflow: true,
      offlineQueueOverflowReason: "max-items-exceeded",
      updatedAt: new Date(nowMs).toISOString(),
    });
    return { accepted: false, reason: "max-items-exceeded", state: nextState };
  }
  if (policy.maxBytes > 0 && nextSummary.bytes > policy.maxBytes) {
    const nextState = createAuthorityBrowserState({
      ...current,
      offlineQueueOverflow: true,
      offlineQueueOverflowReason: "max-bytes-exceeded",
      updatedAt: new Date(nowMs).toISOString(),
    });
    return { accepted: false, reason: "max-bytes-exceeded", state: nextState };
  }

  const nextState = createAuthorityBrowserState({
    ...current,
    offlineQueue: nextItems,
    offlineQueueBytes: nextSummary.bytes,
    offlineQueueItems: nextSummary.items,
    offlineQueueOverflow: false,
    offlineQueueOverflowReason: "",
    updatedAt: new Date(nowMs).toISOString(),
  });
  return { accepted: true, reason: "queued", item, state: nextState };
}

export function clearAuthorityOfflineQueue(state = {}, settings = {}, nowMs = Date.now()) {
  const current = normalizeAuthorityBrowserState(state, settings, nowMs);
  return createAuthorityBrowserState({
    ...current,
    offlineQueue: [],
    offlineQueueBytes: 0,
    offlineQueueItems: 0,
    offlineQueueOverflow: false,
    offlineQueueOverflowReason: "",
    updatedAt: new Date(nowMs).toISOString(),
  });
}

export function getAuthorityBrowserStateSnapshot(state = {}, settings = {}, nowMs = Date.now()) {
  const normalized = normalizeAuthorityBrowserState(state, settings, nowMs);
  return {
    mode: normalized.mode,
    serverRevision: normalized.serverRevision,
    serverIntegrity: normalized.serverIntegrity,
    lastProbeAt: normalized.lastProbeAt,
    lastCommitAt: normalized.lastCommitAt,
    lastError: normalized.lastError,
    offlineQueueBytes: normalized.offlineQueueBytes,
    offlineQueueItems: normalized.offlineQueueItems,
    offlineQueueOverflow: normalized.offlineQueueOverflow,
    offlineQueueOverflowReason: normalized.offlineQueueOverflowReason,
    updatedAt: normalized.updatedAt,
  };
}
