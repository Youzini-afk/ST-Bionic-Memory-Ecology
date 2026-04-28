import { normalizeAuthorityBaseUrl } from "../runtime/authority-capabilities.js";
import { AuthorityHttpClient } from "../runtime/authority-http-client.js";

export const AUTHORITY_JOB_ENDPOINT = "/jobs";
export const AUTHORITY_JOB_STATUS_TERMINAL = new Set([
  "completed",
  "succeeded",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "timeout",
]);
export const AUTHORITY_JOB_STATUS_SUCCESS = new Set([
  "completed",
  "succeeded",
  "success",
]);

function toPlainData(value, fallbackValue = null) {
  if (value == null) return fallbackValue;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallbackValue;
  }
}

function normalizeRecordId(value) {
  return String(value ?? "").trim();
}

function normalizeInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeProgress(value = null) {
  if (typeof value === "number") {
    return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const direct = Number(value.progress ?? value.ratio ?? value.percent);
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(1, direct > 1 ? direct / 100 : direct));
  }
  const current = Number(value.current ?? value.done ?? value.completed ?? value.processed);
  const total = Number(value.total ?? value.count ?? value.expected);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(1, current / total));
  }
  return 0;
}

function normalizeJobStatus(value = "queued") {
  return String(value || "queued").trim().toLowerCase() || "queued";
}

function hasAsyncIterator(value = null) {
  return !!value && typeof value[Symbol.asyncIterator] === "function";
}

function hasIterator(value = null) {
  return !!value && typeof value[Symbol.iterator] === "function";
}

function readJobStreamPayload(event = null) {
  const source = event && typeof event === "object" && !Array.isArray(event) ? event : null;
  if (!source) return event;
  if (source.job && typeof source.job === "object" && !Array.isArray(source.job)) {
    return source.job;
  }
  if (source.result && typeof source.result === "object" && !Array.isArray(source.result)) {
    return source.result;
  }
  if (source.payload && typeof source.payload === "object" && !Array.isArray(source.payload)) {
    return source.payload;
  }
  if (source.data && typeof source.data === "object" && !Array.isArray(source.data)) {
    return source.data;
  }
  return source;
}

async function* normalizeAuthorityJobStream(source = null, options = {}) {
  if (hasAsyncIterator(source)) {
    for await (const event of source) {
      throwIfAborted(options.signal);
      const job = normalizeAuthorityJobRecord(readJobStreamPayload(event));
      if (job.id || job.status || job.error) {
        yield job;
      }
    }
    return;
  }
  if (hasIterator(source)) {
    for (const event of source) {
      throwIfAborted(options.signal);
      const job = normalizeAuthorityJobRecord(readJobStreamPayload(event));
      if (job.id || job.status || job.error) {
        yield job;
      }
    }
    return;
  }
  throw new Error("Authority Jobs stream unavailable");
}

function readJobRows(payload = null) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.jobs)) return payload.jobs;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.result?.jobs)) return payload.result.jobs;
  if (Array.isArray(payload.result?.items)) return payload.result.items;
  return [];
}

export function normalizeAuthorityJobRecord(input = null) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const id = normalizeRecordId(source.id || source.jobId || source.job_id || source.key);
  const status = normalizeJobStatus(source.status || source.state || source.phase);
  const progress = normalizeProgress(source.progress ?? source.progressRatio ?? source.percent);
  const kind = String(source.kind || source.type || source.name || "").trim();
  const lastEvent = source.lastEvent && typeof source.lastEvent === "object"
    ? toPlainData(source.lastEvent, null)
    : source.event && typeof source.event === "object"
      ? toPlainData(source.event, null)
      : null;
  return {
    id,
    kind,
    status,
    progress,
    terminal: AUTHORITY_JOB_STATUS_TERMINAL.has(status),
    success: AUTHORITY_JOB_STATUS_SUCCESS.has(status),
    error: String(source.error || source.lastError || source.message || ""),
    idempotencyKey: String(source.idempotencyKey || source.idempotency_key || ""),
    queue: String(source.queue || source.worker || ""),
    createdAt: source.createdAt || source.created_at || source.enqueuedAt || "",
    updatedAt: source.updatedAt || source.updated_at || source.finishedAt || "",
    lastEvent,
    raw: toPlainData(source, source),
  };
}

export function normalizeAuthorityJobList(payload = null) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const jobs = readJobRows(payload).map(normalizeAuthorityJobRecord).filter((job) => job.id);
  return {
    jobs,
    nextCursor: String(source.nextCursor || source.next_cursor || source.page?.nextCursor || source.cursor?.next || ""),
    hasMore: Boolean(source.hasMore || source.has_more || source.page?.hasMore || source.cursor?.hasMore),
    raw: toPlainData(payload, payload),
  };
}

export function normalizeAuthorityRecentJobRecord(input = null, options = {}) {
  const normalized = normalizeAuthorityJobRecord(input);
  const queueState = String(options.queueState || "").trim() ||
    (normalized.error
      ? "error"
      : normalized.terminal
        ? normalized.success
          ? "success"
          : "failed"
        : normalized.id
          ? "running"
          : "idle");
  return {
    ...normalized,
    updatedAt: String(normalized.updatedAt || options.updatedAt || ""),
    queueState,
  };
}

export function mergeAuthorityRecentJobs(existingJobs = [], incomingJobs = [], options = {}) {
  const limit = normalizeInteger(options.limit, 8, 1, 100);
  const updatedAt = String(options.updatedAt || "");
  const normalizedExisting = Array.isArray(existingJobs) ? existingJobs : [];
  const normalizedIncoming = Array.isArray(incomingJobs) ? incomingJobs : [incomingJobs];
  const seen = new Set();
  const merged = [];

  for (const item of normalizedIncoming) {
    const job = normalizeAuthorityRecentJobRecord(item, { updatedAt });
    if (!job.id || seen.has(job.id)) continue;
    seen.add(job.id);
    merged.push(job);
    if (merged.length >= limit) {
      return merged;
    }
  }

  for (const item of normalizedExisting) {
    const job = normalizeAuthorityRecentJobRecord(item);
    if (!job.id || seen.has(job.id)) continue;
    seen.add(job.id);
    merged.push(job);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

export function buildAuthorityJobIdempotencyKey({
  kind = "job",
  chatId = "",
  collectionId = "",
  revision = 0,
  range = null,
  suffix = "",
} = {}) {
  const normalizedRange = range && Number.isFinite(Number(range.start)) && Number.isFinite(Number(range.end))
    ? `${Math.min(Number(range.start), Number(range.end))}-${Math.max(Number(range.start), Number(range.end))}`
    : "all";
  return [
    "st-bme",
    normalizeRecordId(kind) || "job",
    normalizeRecordId(chatId) || "unknown-chat",
    normalizeRecordId(collectionId) || "unknown-collection",
    String(Math.max(0, Math.floor(Number(revision) || 0))),
    normalizedRange,
    normalizeRecordId(suffix),
  ].filter(Boolean).join(":");
}

export function normalizeAuthorityJobConfig(settings = {}, overrides = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return {
    baseUrl: normalizeAuthorityBaseUrl(source.authorityBaseUrl ?? source.baseUrl),
    enabled: source.authorityJobsEnabled !== false && source.jobsEnabled !== false,
    failOpen: source.authorityFailOpen !== false && source.failOpen !== false,
    preferStream: source.authorityJobPreferStream !== false && source.jobStreamPreferred !== false,
    pollIntervalMs: normalizeInteger(source.authorityJobPollIntervalMs ?? source.pollIntervalMs, 1200, 250, 30000),
    waitTimeoutMs: normalizeInteger(source.authorityJobWaitTimeoutMs ?? source.waitTimeoutMs, 0, 0, 3600000),
    ...overrides,
  };
}

export class AuthorityJobHttpClient {
  constructor(options = {}) {
    this.http = new AuthorityHttpClient({
      ...options,
      baseUrl: normalizeAuthorityBaseUrl(options.baseUrl),
    });
  }

  async request(path, payload = {}, options = {}) {
    return await this.http.requestJson(path, {
      method: options.method || "POST",
      body: payload,
      session: true,
      signal: options.signal,
    });
  }

  async submit(payload = {}) {
    return await this.request(`${AUTHORITY_JOB_ENDPOINT}/create`, {
      type: String(payload.type || payload.kind || "").trim(),
      payload: toPlainData(payload.payload, payload.payload),
      ...(payload.timeoutMs != null ? { timeoutMs: normalizeInteger(payload.timeoutMs, 0, 0, 3600000) } : {}),
      ...(payload.idempotencyKey ? { idempotencyKey: String(payload.idempotencyKey) } : {}),
      ...(payload.maxAttempts != null ? { maxAttempts: normalizeInteger(payload.maxAttempts, 1, 1, 1000) } : {}),
    });
  }

  async listPage(payload = {}) {
    return await this.request(`${AUTHORITY_JOB_ENDPOINT}/list`, {
      page: {
        ...(payload.cursor ? { cursor: String(payload.cursor) } : {}),
        limit: normalizeInteger(payload.limit, 20, 1, 100),
      },
      ...(payload.filter && typeof payload.filter === "object" && !Array.isArray(payload.filter) && Object.keys(payload.filter).length > 0
        ? { filter: toPlainData(payload.filter, {}) }
        : {}),
    });
  }

  async get(payload = {}) {
    const id = encodeURIComponent(normalizeRecordId(payload.jobId || payload.id));
    if (!id) {
      throw new Error("Authority Jobs get requires job id");
    }
    return await this.request(`${AUTHORITY_JOB_ENDPOINT}/${id}`, undefined, {
      method: "GET",
      signal: payload.signal,
    });
  }

  async requeue(payload = {}) {
    const id = encodeURIComponent(normalizeRecordId(payload.jobId || payload.id));
    if (!id) {
      throw new Error("Authority Jobs requeue requires job id");
    }
    return await this.request(`${AUTHORITY_JOB_ENDPOINT}/${id}/requeue`, {}, { signal: payload.signal });
  }

  async cancel(payload = {}) {
    const id = encodeURIComponent(normalizeRecordId(payload.jobId || payload.id));
    if (!id) {
      throw new Error("Authority Jobs cancel requires job id");
    }
    return await this.request(`${AUTHORITY_JOB_ENDPOINT}/${id}/cancel`, {}, { signal: payload.signal });
  }
}

export function createAuthorityJobClient(config = {}, options = {}) {
  const injected = options.jobClient || config.jobClient || globalThis.__stBmeAuthorityJobClient;
  if (injected) return injected;
  return new AuthorityJobHttpClient({
    baseUrl: config.baseUrl,
    fetchImpl: options.fetchImpl || config.fetchImpl,
    headerProvider: options.headerProvider || config.headerProvider,
  });
}

async function callClient(client, methodNames = [], action = "request", payload = {}) {
  for (const methodName of methodNames) {
    if (typeof client?.[methodName] === "function") {
      return await client[methodName](payload);
    }
  }
  if (typeof client?.request === "function") {
    return await client.request(action, payload);
  }
  if (typeof client === "function") {
    return await client({ action, ...payload });
  }
  throw new Error(`Authority Jobs ${action} unavailable`);
}

async function callStreamClient(client, methodNames = [], payload = {}) {
  for (const methodName of methodNames) {
    if (typeof client?.[methodName] === "function") {
      return await client[methodName](payload);
    }
  }
  throw new Error("Authority Jobs stream unavailable");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("操作已终止"), { name: "AbortError" });
  }
}

function sleep(ms, signal) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, Math.floor(Number(ms))));
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("操作已终止"), { name: "AbortError" }));
        },
        { once: true },
      );
    }
  });
}

export class AuthorityJobAdapter {
  constructor(config = {}, options = {}) {
    this.config = normalizeAuthorityJobConfig(config, options.configOverrides || {});
    this.client = createAuthorityJobClient(this.config, options);
  }

  async submit(kind, payload = {}, options = {}) {
    throwIfAborted(options.signal);
    const result = await callClient(this.client, ["submit", "enqueue"], "submit", {
      kind,
      type: kind,
      idempotencyKey: options.idempotencyKey || payload.idempotencyKey || "",
      payload,
    });
    return normalizeAuthorityJobRecord(result?.job || result?.result || result);
  }

  async listPage(options = {}) {
    throwIfAborted(options.signal);
    const result = await callClient(this.client, ["listPage", "list"], "listPage", {
      cursor: options.cursor || "",
      limit: normalizeInteger(options.limit, 20, 1, 100),
      filter: options.filter || {},
    });
    return normalizeAuthorityJobList(result);
  }

  async get(jobId, options = {}) {
    throwIfAborted(options.signal);
    const id = normalizeRecordId(jobId);
    if (!id) return normalizeAuthorityJobRecord(null);
    const result = await callClient(this.client, ["get", "status"], "get", { jobId: id, id });
    return normalizeAuthorityJobRecord(result?.job || result?.result || result);
  }

  async stream(jobId, options = {}) {
    throwIfAborted(options.signal);
    const id = normalizeRecordId(jobId);
    if (!id) {
      return normalizeAuthorityJobStream([], options);
    }
    const source = await callStreamClient(
      this.client,
      ["stream", "streamJob", "watch", "watchJob"],
      {
        jobId: id,
        id,
        signal: options.signal,
      },
    );
    return normalizeAuthorityJobStream(source, options);
  }

  async waitForCompletion(jobId, options = {}) {
    throwIfAborted(options.signal);
    const id = normalizeRecordId(jobId);
    if (!id) return normalizeAuthorityJobRecord(null);
    if (typeof this.client?.waitForCompletion === "function") {
      const result = await this.client.waitForCompletion({
        jobId: id,
        id,
        timeoutMs: normalizeInteger(options.timeoutMs, this.config.waitTimeoutMs, 0, 3600000),
      });
      return normalizeAuthorityJobRecord(result?.job || result?.result || result);
    }

    const startedAt = Date.now();
    const timeoutMs = normalizeInteger(options.timeoutMs, this.config.waitTimeoutMs, 0, 3600000);
    const pollIntervalMs = normalizeInteger(options.pollIntervalMs, this.config.pollIntervalMs, 250, 30000);
    while (true) {
      throwIfAborted(options.signal);
      const job = await this.get(id, options);
      if (job.terminal) return job;
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        return { ...job, status: "timeout", terminal: true, success: false, error: "wait timeout" };
      }
      await sleep(pollIntervalMs, options.signal);
    }
  }

  async requeue(jobId, options = {}) {
    throwIfAborted(options.signal);
    const id = normalizeRecordId(jobId);
    const result = await callClient(this.client, ["requeue", "safeRequeue"], "requeue", {
      jobId: id,
      id,
      safe: options.safe !== false,
    });
    return normalizeAuthorityJobRecord(result?.job || result?.result || result);
  }

  async cancel(jobId, options = {}) {
    throwIfAborted(options.signal);
    const id = normalizeRecordId(jobId);
    const result = await callClient(this.client, ["cancel", "cancelLike"], "cancel", {
      jobId: id,
      id,
    });
    return normalizeAuthorityJobRecord(result?.job || result?.result || result);
  }
}

export function createAuthorityJobAdapter(config = {}, options = {}) {
  return new AuthorityJobAdapter(config, options);
}
