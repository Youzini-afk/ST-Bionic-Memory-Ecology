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
