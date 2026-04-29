const MODE_ALIASES = Object.freeze({
  1: "strict",
  strict: "strict",
  safe: "strict",
  serial: "strict",
  2: "balanced",
  balance: "balanced",
  balanced: "balanced",
  normal: "balanced",
  3: "fast",
  fast: "fast",
  async: "fast",
});

export const MAINTENANCE_EXECUTION_MODES = Object.freeze([
  "strict",
  "balanced",
  "fast",
]);

function clampInt(value, fallback, min = 1, max = 64) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeMaintenanceExecutionMode(value = "strict") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return MODE_ALIASES[normalized] || "strict";
}

export function getMaintenanceExecutionModeLevel(value = "strict") {
  switch (normalizeMaintenanceExecutionMode(value)) {
    case "balanced":
      return 2;
    case "fast":
      return 3;
    case "strict":
    default:
      return 1;
  }
}

export function isStrictMaintenanceMode(value = "strict") {
  return normalizeMaintenanceExecutionMode(value) === "strict";
}

export function isFastMaintenanceMode(value = "strict") {
  return normalizeMaintenanceExecutionMode(value) === "fast";
}

export function resolveConcurrencyConfig(settings = {}, modeOverride = null) {
  const mode = normalizeMaintenanceExecutionMode(
    modeOverride ?? settings?.maintenanceExecutionMode,
  );
  const strict = mode === "strict";
  return {
    mode,
    level: getMaintenanceExecutionModeLevel(mode),
    vectorQueryConcurrency: strict
      ? 1
      : clampInt(settings?.parallelVectorQueryConcurrency, 3, 1, 12),
    neighborQueryConcurrency: strict
      ? 1
      : clampInt(settings?.parallelNeighborQueryConcurrency, 3, 1, 12),
    llmConcurrency: strict
      ? 1
      : clampInt(settings?.parallelLlmConcurrency, 2, 1, 4),
    backgroundMaintenanceMaxRetries: clampInt(
      settings?.backgroundMaintenanceMaxRetries,
      2,
      0,
      10,
    ),
    backgroundMaintenanceRetryBaseMs: clampInt(
      settings?.backgroundMaintenanceRetryBaseMs,
      800,
      50,
      60000,
    ),
    backgroundMaintenanceMaxQueueItems: clampInt(
      settings?.backgroundMaintenanceMaxQueueItems,
      24,
      1,
      256,
    ),
  };
}

export function throwIfSignalAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(String(reason || "Operation aborted"), "AbortError");
}

export async function runLimited(
  items = [],
  worker,
  { concurrency = 1, signal = undefined, preserveOrder = true, failFast = true } = {},
) {
  const list = Array.isArray(items) ? items : [];
  const limit = clampInt(concurrency, 1, 1, Math.max(1, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;

  if (typeof worker !== "function" || list.length === 0) {
    return preserveOrder ? results : [];
  }

  async function runWorker() {
    while (cursor < list.length) {
      throwIfSignalAborted(signal);
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (failFast) throw error;
        results[index] = { error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, list.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return preserveOrder ? results : results.filter((item) => item !== undefined);
}

function delay(ms) {
  const safeMs = Math.max(0, Math.floor(Number(ms) || 0));
  if (safeMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

function buildQueueSnapshot(queueState) {
  return {
    state: queueState.active
      ? "running"
      : queueState.queue.length > 0
        ? "queued"
        : "idle",
    queued: queueState.queue.length,
    activeId: queueState.active?.id || "",
    activeName: queueState.active?.name || "",
    completed: queueState.completed,
    failed: queueState.failed,
    dropped: queueState.dropped,
    lastTask: queueState.lastTask ? { ...queueState.lastTask } : null,
    updatedAt: queueState.updatedAt,
  };
}

export function createBackgroundMaintenanceQueue(options = {}) {
  const queueState = {
    queue: [],
    active: null,
    completed: 0,
    failed: 0,
    dropped: 0,
    lastTask: null,
    updatedAt: Date.now(),
    nextId: 1,
    draining: false,
    maxItems: clampInt(options.maxItems, 24, 1, 256),
    maxRetries: clampInt(options.maxRetries, 2, 0, 10),
    retryBaseMs: clampInt(options.retryBaseMs, 800, 50, 60000),
    onStatus: typeof options.onStatus === "function" ? options.onStatus : null,
  };

  function emitStatus() {
    queueState.updatedAt = Date.now();
    const snapshot = buildQueueSnapshot(queueState);
    try {
      queueState.onStatus?.(snapshot);
    } catch {
    }
    return snapshot;
  }

  async function runTask(item) {
    queueState.active = item;
    item.status = "running";
    item.startedAt = Date.now();
    emitStatus();
    while (item.attempts <= item.maxRetries) {
      try {
        item.attempts += 1;
        const result = await item.run({
          attempt: item.attempts,
          maxRetries: item.maxRetries,
          id: item.id,
          name: item.name,
        });
        item.status = "success";
        item.finishedAt = Date.now();
        item.result = result;
        queueState.completed += 1;
        queueState.lastTask = {
          id: item.id,
          name: item.name,
          status: item.status,
          attempts: item.attempts,
          error: "",
          finishedAt: item.finishedAt,
        };
        return result;
      } catch (error) {
        if (error?.name === "AbortError") {
          item.status = "aborted";
          item.error = error?.message || String(error);
          break;
        }
        item.error = error?.message || String(error) || "background-task-failed";
        if (item.attempts > item.maxRetries) {
          item.status = "failed";
          break;
        }
        item.status = "retrying";
        emitStatus();
        await delay(item.retryBaseMs * Math.max(1, item.attempts));
        item.status = "running";
        emitStatus();
      }
    }
    item.finishedAt = Date.now();
    queueState.failed += 1;
    queueState.lastTask = {
      id: item.id,
      name: item.name,
      status: item.status,
      attempts: item.attempts,
      error: item.error || "",
      finishedAt: item.finishedAt,
    };
    return null;
  }

  async function drain() {
    if (queueState.draining) return;
    queueState.draining = true;
    try {
      while (queueState.queue.length > 0) {
        const item = queueState.queue.shift();
        await runTask(item);
        queueState.active = null;
        emitStatus();
      }
    } finally {
      queueState.active = null;
      queueState.draining = false;
      emitStatus();
    }
  }

  return {
    configure(nextOptions = {}) {
      queueState.maxItems = clampInt(nextOptions.maxItems, queueState.maxItems, 1, 256);
      queueState.maxRetries = clampInt(nextOptions.maxRetries, queueState.maxRetries, 0, 10);
      queueState.retryBaseMs = clampInt(nextOptions.retryBaseMs, queueState.retryBaseMs, 50, 60000);
      if (typeof nextOptions.onStatus === "function") {
        queueState.onStatus = nextOptions.onStatus;
      }
      return emitStatus();
    },
    enqueue(name, run, taskOptions = {}) {
      if (typeof run !== "function") {
        throw new TypeError("background maintenance task must be a function");
      }
      const occupiedSlots = queueState.queue.length + (queueState.active ? 1 : 0);
      if (occupiedSlots >= queueState.maxItems) {
        queueState.dropped += 1;
        const dropped = {
          id: "",
          name: String(name || "background-task"),
          status: "dropped",
          attempts: 0,
          error: "background-maintenance-queue-full",
          finishedAt: Date.now(),
        };
        queueState.lastTask = dropped;
        emitStatus();
        return {
          queued: false,
          reason: "background-maintenance-queue-full",
          snapshot: buildQueueSnapshot(queueState),
        };
      }
      const item = {
        id: String(taskOptions.id || `bg-${Date.now()}-${queueState.nextId++}`),
        name: String(name || taskOptions.name || "background-task"),
        run,
        attempts: 0,
        maxRetries: clampInt(taskOptions.maxRetries, queueState.maxRetries, 0, 10),
        retryBaseMs: clampInt(taskOptions.retryBaseMs, queueState.retryBaseMs, 50, 60000),
        status: "queued",
        createdAt: Date.now(),
      };
      queueState.queue.push(item);
      const snapshot = emitStatus();
      void drain();
      return {
        queued: true,
        id: item.id,
        snapshot,
      };
    },
    getSnapshot() {
      return buildQueueSnapshot(queueState);
    },
    get size() {
      return queueState.queue.length + (queueState.active ? 1 : 0);
    },
  };
}
