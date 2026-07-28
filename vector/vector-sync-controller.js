// ST-BME vector sync orchestration controller.
//
// Extracted from index.js syncVectorState so it can be unit-tested by direct
// import instead of slicing index.js into a vm sandbox. All runtime
// dependencies (current graph, status setters, embedding config, vector index
// engine, host context) are injected explicitly; this module owns no
// module-level mutable state.

/**
 * Runs a vector index sync for the current graph and reports terminal status.
 *
 * @param {object} runtime injected dependencies
 * @param {() => void} runtime.ensureCurrentGraphRuntimeState
 * @param {() => object} runtime.getCurrentGraph
 * @param {(text: string, meta: string, level: string, opts?: object) => void} runtime.setLastVectorStatus
 * @param {() => object} runtime.getEmbeddingConfig
 * @param {(config: object) => {valid: boolean, error?: string}} runtime.validateVectorConfig
 * @param {(graph: object) => object} runtime.getVectorIndexStats
 * @param {(graph: object, config: object, opts: object) => Promise<object>} runtime.syncGraphVectorIndex
 * @param {(context: object, graph: object) => string} runtime.resolveOperationalChatId
 * @param {() => object} runtime.getContext
 * @param {(message: string) => void} runtime.markVectorStateDirty
 * @param {(error: unknown) => boolean} runtime.isAbortError
 * @param {(() => object)} [runtime.getRequestHeaders]
 * @param {Console} [runtime.console]
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @param {boolean} [options.purge]
 * @param {{start: number, end: number}|null} [options.range]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.expectedChatId]
 * @param {boolean} [options.silentStatus]
 */
export async function syncVectorStateController(runtime, options = {}) {
  const {
    ensureCurrentGraphRuntimeState,
    getCurrentGraph,
    getEmbeddingConfig,
    validateVectorConfig,
    getVectorIndexStats,
    syncGraphVectorIndex,
    resolveOperationalChatId,
    getContext,
    markVectorStateDirty,
    isAbortError,
    getRequestHeaders,
    console: logger = console,
  } = runtime;

  // Status setters are invoked via `runtime` (method-call style) so the runtime
  // object stays the single owner of status state, matching the extraction and
  // rebuild controllers.
  const {
    force = false,
    purge = false,
    range = null,
    signal = undefined,
    expectedChatId = "",
    silentStatus = false,
  } = options || {};
  const setLastVectorStatus = (...args) => {
    const level = String(args[2] || "");
    if (!silentStatus || level === "warning" || level === "error") {
      runtime.setLastVectorStatus(...args);
    }
  };

  ensureCurrentGraphRuntimeState();
  const currentGraph = getCurrentGraph();
  const syncChatId = String(
    expectedChatId || resolveOperationalChatId(getContext(), currentGraph) || "",
  ).trim();
  const isSyncContextCurrent = () => {
    const activeGraph = getCurrentGraph();
    const activeChatId = String(
      resolveOperationalChatId(getContext(), activeGraph) || "",
    ).trim();
    return (
      activeGraph === currentGraph &&
      (!syncChatId || !activeChatId || activeChatId === syncChatId)
    );
  };
  const buildStaleResult = (result = {}) => ({
    ...(result && typeof result === "object" ? result : {}),
    aborted: true,
    stale: true,
    error: "vector-sync-context-changed",
  });

  const scopeLabel =
    range && Number.isFinite(range.start) && Number.isFinite(range.end)
      ? `范围 ${Math.min(range.start, range.end)}-${Math.max(range.start, range.end)}`
      : "当前聊天";
  setLastVectorStatus(
    "向量处理中",
    `${scopeLabel} · ${force ? "强制同步" : "增量同步"}`,
    "running",
    { syncRuntime: true },
  );

  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);

  if (!validation.valid) {
    currentGraph.vectorIndexState.lastWarning = validation.error;
    currentGraph.vectorIndexState.dirty = true;
    setLastVectorStatus("向量不可用", validation.error, "warning", {
      syncRuntime: true,
    });
    return {
      insertedHashes: [],
      stats: getVectorIndexStats(currentGraph),
      error: validation.error,
    };
  }

  try {
    const result = await syncGraphVectorIndex(currentGraph, config, {
      chatId: syncChatId,
      force,
      purge,
      range,
      signal,
      headerProvider:
        typeof getRequestHeaders === "function"
          ? () => getRequestHeaders()
          : null,
    });
    if (signal?.aborted) {
      return {
        ...(result && typeof result === "object" ? result : {}),
        aborted: true,
        error:
          signal.reason instanceof Error
            ? signal.reason.message
            : "vector-sync-aborted",
      };
    }
    if (!isSyncContextCurrent()) {
      return buildStaleResult(result);
    }
    if (result?.error) {
      setLastVectorStatus("向量待修复", result.error, "warning", {
        syncRuntime: true,
      });
      return result;
    }
    setLastVectorStatus(
      "向量完成",
      `${scopeLabel} · indexed ${result.stats?.indexed ?? 0} · pending ${result.stats?.pending ?? 0}`,
      "success",
      { syncRuntime: true },
    );
    return result;
  } catch (error) {
    if (!isSyncContextCurrent()) {
      return buildStaleResult({
        insertedHashes: [],
        stats: getVectorIndexStats(currentGraph),
      });
    }
    if (isAbortError(error)) {
      setLastVectorStatus("向量已终止", scopeLabel, "warning", {
        syncRuntime: true,
      });
      return {
        insertedHashes: [],
        stats: getVectorIndexStats(currentGraph),
        error: error?.message || "向量任务已终止",
        aborted: true,
      };
    }
    const message = error?.message || String(error) || "向量同步失败";
    markVectorStateDirty(message);
    logger.error("[ST-BME] 向量同步失败:", error);
    setLastVectorStatus("向量失败", message, "error", {
      syncRuntime: true,
      toastKind: "error",
    });
    return {
      insertedHashes: [],
      stats: getVectorIndexStats(currentGraph),
      error: message,
    };
  }
}
