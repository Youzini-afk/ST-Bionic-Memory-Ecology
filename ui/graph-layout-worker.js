import { solveLayoutWithJs } from "./graph-layout-solver.js";

let nativeSolver = null;
let nativeLoadAttempted = false;
let nativeLoadError = "";
let readNativeModuleStatus = null;
const canceledJobIds = new Set();
const activeJobIds = new Set();

async function ensureNativeSolver() {
  if (nativeLoadAttempted) return nativeSolver;
  nativeLoadAttempted = true;

  try {
    const nativeModule = await import("../vendor/wasm/stbme_core.js");
    const solveLayout =
      nativeModule?.solveLayout || nativeModule?.default?.solveLayout || null;
    nativeSolver = typeof solveLayout === "function" ? solveLayout : null;
    readNativeModuleStatus =
      typeof nativeModule?.getNativeModuleStatus === "function"
        ? nativeModule.getNativeModuleStatus
        : null;
  } catch (error) {
    nativeLoadError = error?.message || String(error);
    nativeSolver = null;
  }

  return nativeSolver;
}

async function solveLayout(payload = {}) {
  const nativeRequested = payload?.nativeRequested === true;
  if (nativeRequested) {
    const solver = await ensureNativeSolver();
    if (solver) {
      try {
        const nativeResult = await solver(payload);
        const nativeStatus =
          typeof readNativeModuleStatus === "function"
            ? readNativeModuleStatus()
            : null;
        if (
          nativeResult &&
          nativeResult.ok === true &&
          nativeResult.positions instanceof Float32Array
        ) {
          return {
            ...nativeResult,
            usedNative: true,
            diagnostics: {
              ...(nativeResult.diagnostics || {}),
              solver: "rust-wasm",
              moduleSource: String(nativeStatus?.source || ""),
              nativeLoadError: String(nativeStatus?.error || nativeLoadError || ""),
            },
          };
        }
      } catch (error) {
        return {
          ok: false,
          skipped: true,
          reason: "native-solver-failed",
          error: error?.message || String(error),
          nativeLoadError,
        };
      }
    }
  }

  const jsResult = solveLayoutWithJs(payload);
  return {
    ...jsResult,
    usedNative: false,
    nativeLoadError,
  };
}

self.addEventListener("message", async (event) => {
  const message = event?.data || {};
  if (message.type === "cancel-layout") {
    const canceledJobId = Number(message.jobId);
    if (Number.isFinite(canceledJobId)) {
      canceledJobIds.add(canceledJobId);
    }
    return;
  }
  if (message.type !== "solve-layout") return;

  const jobId = Number(message.jobId);
  if (!Number.isFinite(jobId)) return;
  if (canceledJobIds.has(jobId)) {
    canceledJobIds.delete(jobId);
    return;
  }
  activeJobIds.add(jobId);
  const fallbackErrorResult = (errorMessage = "unknown-worker-error") => ({
    ok: false,
    skipped: true,
    reason: "worker-exception",
    error: String(errorMessage || "unknown-worker-error"),
  });

  try {
    const result = await solveLayout(message.payload || {});
    if (!activeJobIds.has(jobId) || canceledJobIds.has(jobId)) {
      activeJobIds.delete(jobId);
      canceledJobIds.delete(jobId);
      return;
    }
    activeJobIds.delete(jobId);
    if (result?.positions instanceof Float32Array) {
      self.postMessage(
        {
          type: "layout-result",
          jobId,
          result,
        },
        [result.positions.buffer],
      );
      return;
    }

    self.postMessage({
      type: "layout-result",
      jobId,
      result,
    });
  } catch (error) {
    if (!activeJobIds.has(jobId) || canceledJobIds.has(jobId)) {
      activeJobIds.delete(jobId);
      canceledJobIds.delete(jobId);
      return;
    }
    activeJobIds.delete(jobId);
    self.postMessage({
      type: "layout-result",
      jobId,
      result: fallbackErrorResult(error?.message || String(error)),
    });
  }
});
