const DEFAULT_NATIVE_RUNTIME_OPTIONS = Object.freeze({
  graphUseNativeLayout: true,
  graphNativeLayoutThresholdNodes: 280,
  graphNativeLayoutThresholdEdges: 1600,
  graphNativeLayoutWorkerTimeoutMs: 260,
  nativeEngineFailOpen: true,
  graphNativeForceDisable: false,
});

function clampPositiveInt(value, fallback, { min = 1, max = 120000 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function normalizeGraphNativeRuntimeOptions(options = {}) {
  const source =
    options && typeof options === "object" && !Array.isArray(options)
      ? options
      : {};
  return {
    graphUseNativeLayout: normalizeBoolean(
      source.graphUseNativeLayout,
      DEFAULT_NATIVE_RUNTIME_OPTIONS.graphUseNativeLayout,
    ),
    graphNativeLayoutThresholdNodes: clampPositiveInt(
      source.graphNativeLayoutThresholdNodes,
      DEFAULT_NATIVE_RUNTIME_OPTIONS.graphNativeLayoutThresholdNodes,
      { min: 1, max: 20000 },
    ),
    graphNativeLayoutThresholdEdges: clampPositiveInt(
      source.graphNativeLayoutThresholdEdges,
      DEFAULT_NATIVE_RUNTIME_OPTIONS.graphNativeLayoutThresholdEdges,
      { min: 1, max: 50000 },
    ),
    graphNativeLayoutWorkerTimeoutMs: clampPositiveInt(
      source.graphNativeLayoutWorkerTimeoutMs,
      DEFAULT_NATIVE_RUNTIME_OPTIONS.graphNativeLayoutWorkerTimeoutMs,
      { min: 40, max: 15000 },
    ),
    nativeEngineFailOpen: normalizeBoolean(
      source.nativeEngineFailOpen,
      DEFAULT_NATIVE_RUNTIME_OPTIONS.nativeEngineFailOpen,
    ),
    graphNativeForceDisable: normalizeBoolean(
      source.graphNativeForceDisable,
      DEFAULT_NATIVE_RUNTIME_OPTIONS.graphNativeForceDisable,
    ),
  };
}

export class GraphNativeLayoutBridge {
  constructor(runtimeOptions = {}) {
    this.runtimeOptions = normalizeGraphNativeRuntimeOptions(runtimeOptions);
    this._worker = null;
    this._workerBootError = "";
    this._nextJobId = 1;
    this._pendingJobs = new Map();
    this._isDisposed = false;
  }

  updateRuntimeOptions(runtimeOptions = {}) {
    this.runtimeOptions = normalizeGraphNativeRuntimeOptions(runtimeOptions);
  }

  shouldRunForGraph(nodeCount = 0, edgeCount = 0) {
    if (this.runtimeOptions.graphNativeForceDisable) return false;
    if (!this.runtimeOptions.graphUseNativeLayout) return false;
    const normalizedNodes = Math.max(0, Number(nodeCount) || 0);
    const normalizedEdges = Math.max(0, Number(edgeCount) || 0);
    return (
      normalizedNodes >= this.runtimeOptions.graphNativeLayoutThresholdNodes ||
      normalizedEdges >= this.runtimeOptions.graphNativeLayoutThresholdEdges
    );
  }

  async solveLayout(payload = {}, { timeoutMs = null } = {}) {
    if (this._isDisposed) {
      return {
        ok: false,
        skipped: true,
        reason: "bridge-disposed",
      };
    }

    const worker = this._ensureWorker();
    if (!worker) {
      const result = {
        ok: false,
        skipped: true,
        reason: "worker-unavailable",
        error: this._workerBootError || "Graph worker unavailable",
      };
      if (this.runtimeOptions.nativeEngineFailOpen) {
        return result;
      }
      throw new Error(result.error);
    }

    const normalizedTimeoutMs = clampPositiveInt(
      timeoutMs,
      this.runtimeOptions.graphNativeLayoutWorkerTimeoutMs,
      { min: 40, max: 15000 },
    );

    const jobId = this._nextJobId++;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._worker) {
          this._worker.postMessage({
            type: "cancel-layout",
            jobId,
            reason: "native-layout-timeout",
          });
        }
        this._pendingJobs.delete(jobId);
        resolve({
          ok: false,
          skipped: true,
          reason: "native-layout-timeout",
          timeoutMs: normalizedTimeoutMs,
        });
      }, normalizedTimeoutMs);

      this._pendingJobs.set(jobId, {
        resolve,
        timer,
      });

      worker.postMessage({
        type: "solve-layout",
        jobId,
        payload: {
          ...payload,
          nativeRequested: true,
          timeoutMs: normalizedTimeoutMs,
        },
      });
    });
  }

  cancelPending(reason = "native-layout-canceled") {
    if (this._pendingJobs.size <= 0) return;
    const cancelReason = String(reason || "native-layout-canceled").trim() ||
      "native-layout-canceled";
    for (const [jobId, pending] of this._pendingJobs.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        skipped: true,
        reason: cancelReason,
      });
      if (this._worker) {
        this._worker.postMessage({
          type: "cancel-layout",
          jobId,
          reason: cancelReason,
        });
      }
    }
    this._pendingJobs.clear();
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.cancelPending("bridge-disposed");
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    if (this._isDisposed) return null;
    if (typeof Worker !== "function") {
      this._workerBootError = "Worker API unavailable";
      return null;
    }

    try {
      const worker = new Worker(new URL("./graph-layout-worker.js", import.meta.url), {
        type: "module",
      });
      worker.addEventListener("message", (event) => {
        this._handleWorkerMessage(event?.data || {});
      });
      worker.addEventListener("error", (event) => {
        const message =
          String(event?.message || "").trim() || "Graph layout worker error";
        this._workerBootError = message;
        this._resolveAllPending({
          ok: false,
          skipped: true,
          reason: "native-worker-error",
          error: message,
        });
      });
      this._worker = worker;
      return worker;
    } catch (error) {
      this._workerBootError = error?.message || String(error);
      return null;
    }
  }

  _handleWorkerMessage(data = {}) {
    if (!data || data.type !== "layout-result") return;
    const jobId = Number(data.jobId);
    if (!Number.isFinite(jobId)) return;
    const pending = this._pendingJobs.get(jobId);
    if (!pending) return;
    this._pendingJobs.delete(jobId);
    clearTimeout(pending.timer);

    const result = data.result || {};
    if (result?.positions && !(result.positions instanceof Float32Array)) {
      try {
        result.positions = Float32Array.from(result.positions);
      } catch {
        result.positions = null;
      }
    }
    pending.resolve(result);
  }

  _resolveAllPending(result = {}) {
    for (const pending of this._pendingJobs.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this._pendingJobs.clear();
  }
}
