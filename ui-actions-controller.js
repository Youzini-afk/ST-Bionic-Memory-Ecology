function getTimerApi(runtime = {}) {
  const rawSetTimeout =
    typeof runtime.setTimeout === "function"
      ? runtime.setTimeout
      : globalThis.setTimeout;
  const rawClearTimeout =
    typeof runtime.clearTimeout === "function"
      ? runtime.clearTimeout
      : globalThis.clearTimeout;

  return {
    setTimeout(...args) {
      return Reflect.apply(rawSetTimeout, globalThis, args);
    },
    clearTimeout(...args) {
      return Reflect.apply(rawClearTimeout, globalThis, args);
    },
  };
}

function hasCompressionMutation(result = {}) {
  return (
    Math.max(0, Number(result?.created) || 0) > 0 ||
    Math.max(0, Number(result?.archived) || 0) > 0
  );
}

function hasSleepMutation(result = {}) {
  return Math.max(0, Number(result?.forgotten) || 0) > 0;
}

function hasConsolidationMutation(result = {}) {
  return (
    Math.max(0, Number(result?.merged) || 0) > 0 ||
    Math.max(0, Number(result?.skipped) || 0) > 0 ||
    Math.max(0, Number(result?.evolved) || 0) > 0 ||
    Math.max(0, Number(result?.connections) || 0) > 0 ||
    Math.max(0, Number(result?.updates) || 0) > 0
  );
}

function findGraphNode(graph, nodeId) {
  if (!graph || !Array.isArray(graph.nodes)) return null;
  return graph.nodes.find((node) => node?.id === nodeId) || null;
}

function isManualEvolutionCandidateNode(node) {
  if (!node || node.archived) return false;
  if (Number(node.level || 0) > 0) return false;
  return !["synopsis", "reflection"].includes(String(node.type || ""));
}

function normalizeManualEvolutionCandidateIds(graph, nodeIds = []) {
  const unique = new Set();
  for (const rawId of Array.isArray(nodeIds) ? nodeIds : []) {
    const nodeId = String(rawId || "").trim();
    if (!nodeId || unique.has(nodeId)) continue;
    const node = findGraphNode(graph, nodeId);
    if (!isManualEvolutionCandidateNode(node)) continue;
    unique.add(nodeId);
  }
  return [...unique];
}

function resolveManualEvolutionCandidates(runtime, graph) {
  const liveRecentIds = normalizeManualEvolutionCandidateIds(
    graph,
    runtime.getLastExtractedItems?.()
      ?.map((item) => item?.id)
      .filter(Boolean) || [],
  );
  if (liveRecentIds.length > 0) {
    return {
      ids: liveRecentIds,
      source: "recent-extract",
    };
  }

  const currentExtractionCount = Math.max(
    0,
    Number(graph?.historyState?.extractionCount) || 0,
  );
  const batchJournal = Array.isArray(graph?.batchJournal) ? graph.batchJournal : [];
  for (let index = batchJournal.length - 1; index >= 0; index -= 1) {
    const entry = batchJournal[index];
    const beforeExtractionCount = Math.max(
      0,
      Number(entry?.stateBefore?.extractionCount) || 0,
    );
    if (beforeExtractionCount >= currentExtractionCount) {
      continue;
    }
    const fallbackIds = normalizeManualEvolutionCandidateIds(
      graph,
      entry?.createdNodeIds || [],
    );
    if (fallbackIds.length > 0) {
      return {
        ids: fallbackIds,
        source: "latest-extraction-batch",
      };
    }
  }

  return {
    ids: [],
    source: "none",
  };
}

function describeManualEvolutionSource(source, count) {
  switch (String(source || "")) {
    case "recent-extract":
      return `使用最近提取的 ${count} 个节点`;
    case "latest-extraction-batch":
      return `使用最近一批提取落盘的 ${count} 个节点`;
    default:
      return `候选节点 ${count} 个`;
  }
}

function updateManualActionUiState(runtime, text, meta = "", level = "idle") {
  if (typeof runtime?.setRuntimeStatus === "function") {
    runtime.setRuntimeStatus(text, meta, level);
  }
  runtime?.refreshPanelLiveState?.();
}

function rebindImportedGraphToCurrentChat(runtime, importedGraph) {
  if (!importedGraph || typeof importedGraph !== "object") {
    return {
      rebound: false,
      reason: "missing-graph",
    };
  }

  const chat = runtime.getContext?.()?.chat;
  const assistantTurns =
    typeof runtime.getAssistantTurns === "function" && Array.isArray(chat)
      ? runtime.getAssistantTurns(chat)
      : [];

  if (typeof runtime.rebindProcessedHistoryStateToChat === "function") {
    return runtime.rebindProcessedHistoryStateToChat(
      importedGraph,
      chat,
      assistantTurns,
    );
  }

  importedGraph.historyState.processedMessageHashesNeedRefresh = true;
  return {
    rebound: false,
    reason: "missing-history-rebind-helper",
  };
}

export async function onViewGraphController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) {
    runtime.toastr.warning("当前没有加载的图谱");
    return;
  }

  const stats = runtime.getGraphStats(graph);
  const statsText = [
    `节点: ${stats.activeNodes} 活跃 / ${stats.archivedNodes} 归档`,
    `边: ${stats.totalEdges}`,
    `最后处理楼层: ${stats.lastProcessedSeq}`,
    `类型分布: ${
      Object.entries(stats.typeCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "(空)"
    }`,
  ].join("\n");

  runtime.toastr.info(statsText, "ST-BME 图谱状态", { timeOut: 10000 });
}

export async function onTestEmbeddingController(runtime) {
  const config = runtime.getEmbeddingConfig();
  const validation = runtime.validateVectorConfig(config);
  if (!validation.valid) {
    runtime.toastr.warning(validation.error);
    return;
  }

  runtime.toastr.info("正在测试 Embedding API 连通性...");
  const result = await runtime.testVectorConnection(config, runtime.getCurrentChatId());

  if (result.success) {
    runtime.toastr.success(`连接成功！向量维度: ${result.dimensions}`);
  } else {
    runtime.toastr.error(`连接失败: ${result.error}`);
  }
}

export async function onTestMemoryLLMController(runtime) {
  runtime.toastr.info("正在测试记忆 LLM 连通性...");
  const result = await runtime.testLLMConnection();

  if (result.success) {
    runtime.toastr.success(`连接成功！模式: ${result.mode}`);
  } else {
    runtime.toastr.error(`连接失败: ${result.error}`);
  }
}

export async function onFetchMemoryLLMModelsController(runtime) {
  runtime.toastr.info("正在拉取记忆 LLM 模型列表...");
  const result = await runtime.fetchMemoryLLMModels();

  if (result.success) {
    runtime.toastr.success(`已拉取 ${result.models.length} 个记忆 LLM 模型`);
  } else {
    runtime.toastr.error(`拉取失败: ${result.error}`);
  }

  return result;
}

export async function onFetchEmbeddingModelsController(runtime, mode = null) {
  const config = runtime.getEmbeddingConfig(mode);
  const targetMode = mode || config?.mode || "direct";
  const validation = runtime.validateVectorConfig(config);
  if (!validation.valid) {
    runtime.toastr.warning(validation.error);
    return { success: false, models: [], error: validation.error };
  }

  runtime.toastr.info("正在拉取 Embedding 模型列表...");
  const result = await runtime.fetchAvailableEmbeddingModels(config);

  if (result.success) {
    const modeLabel = targetMode === "backend" ? "后端" : "直连";
    runtime.toastr.success(
      `已拉取 ${result.models.length} 个${modeLabel} Embedding 模型`,
    );
  } else {
    runtime.toastr.error(`拉取失败: ${result.error}`);
  }

  return result;
}

export async function onManualCompressController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("手动压缩")) return;
  updateManualActionUiState(runtime, "手动压缩中", "正在检查可压缩候选组", "running");

  try {
    const schema = runtime.getSchema();
    const inspection = runtime.inspectCompressionCandidates?.(graph, schema, true);
    if (inspection && !inspection.hasCandidates) {
      const reason = String(
        inspection.reason || "当前没有可压缩候选组，本次未发起 LLM 压缩",
      );
      updateManualActionUiState(runtime, "手动压缩未执行", reason, "idle");
      runtime.toastr.info(reason);
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason,
      };
    }

    updateManualActionUiState(runtime, "手动压缩中", "正在请求 LLM 压缩候选组", "running");
    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    const result = await runtime.compressAll(
      graph,
      schema,
      runtime.getEmbeddingConfig(),
      true,
      undefined,
      undefined,
      runtime.getSettings(),
    );
    const mutated = hasCompressionMutation(result);
    if (mutated) {
      runtime.recordMaintenanceAction?.({
        action: "compress",
        beforeSnapshot,
        mode: "manual",
        summary: runtime.buildMaintenanceSummary?.("compress", result, "manual"),
      });
      await runtime.recordGraphMutation({
        beforeSnapshot,
        artifactTags: ["compression"],
      });
      updateManualActionUiState(
        runtime,
        "手动压缩完成",
        `新建 ${result.created}，归档 ${result.archived}`,
        "success",
      );
      runtime.toastr.success(
        `手动压缩完成：新建 ${result.created}，归档 ${result.archived}`,
      );
    } else {
      updateManualActionUiState(
        runtime,
        "手动压缩无变更",
        "已尝试压缩，但本轮没有产生可持久化变化",
        "idle",
      );
      runtime.toastr.info("已尝试手动压缩，但本轮没有产生可持久化变化");
    }

    return {
      handledToast: true,
      requestDispatched: true,
      mutated,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "手动压缩失败",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onExportGraphController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;

  const json = runtime.exportGraph(graph);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = runtime.document.createElement("a");
  a.href = url;
  a.download = `st-bme-graph-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);

  runtime.toastr.success("图谱已导出");
}

export async function onViewLastInjectionController(runtime) {
  const content = runtime.getLastInjectionContent();
  if (!content) {
    runtime.toastr.info("暂无注入内容");
    return;
  }

  const popup = runtime.document.createElement("div");
  popup.style.cssText =
    "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;color:#eee;padding:24px;border-radius:12px;max-width:80vw;max-height:80vh;overflow:auto;z-index:99999;white-space:pre-wrap;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,0.5);";
  popup.textContent = content;

  const close = runtime.document.createElement("button");
  close.textContent = "关闭";
  close.style.cssText =
    "position:absolute;top:8px;right:12px;background:#e94560;color:white;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;";
  close.onclick = () => popup.remove();
  popup.appendChild(close);

  runtime.document.body.appendChild(popup);
}

export async function onRebuildController(runtime) {
  if (!runtime.confirm("确定要从当前聊天重建图谱？这将清除现有图谱数据。")) {
    return;
  }
  if (!runtime.ensureGraphMutationReady("重建图谱")) return;

  const context = runtime.getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) {
    runtime.toastr.warning("当前聊天上下文不可用，无法重建");
    return;
  }

  const previousGraphSnapshot = runtime.getCurrentGraph()
    ? runtime.cloneGraphSnapshot(runtime.getCurrentGraph())
    : runtime.cloneGraphSnapshot(
        runtime.normalizeGraphRuntimeState(
          runtime.createEmptyGraph(),
          runtime.getCurrentChatId(),
        ),
      );
  const previousUiState = runtime.snapshotRuntimeUiState();
  const settings = runtime.getSettings();
  runtime.setRuntimeStatus(
    "图谱重建中",
    `当前聊天 ${Array.isArray(chat) ? chat.length : 0} 条消息`,
    "running",
  );

  const nextGraph = runtime.normalizeGraphRuntimeState(
    runtime.createEmptyGraph(),
    runtime.getCurrentChatId(),
  );
  nextGraph.batchJournal = [];
  runtime.setCurrentGraph(nextGraph);
  runtime.clearInjectionState();

  try {
    await runtime.prepareVectorStateForReplay(true);
    const replayedBatches = await runtime.replayExtractionFromHistory(chat, settings);
    runtime.clearHistoryDirty(
      runtime.getCurrentGraph(),
      runtime.buildRecoveryResult("full-rebuild", {
        fromFloor: 0,
        batches: replayedBatches,
        path: "full-rebuild",
        detectionSource: "manual-rebuild",
        affectedBatchCount: runtime.getCurrentGraph().batchJournal?.length || 0,
        replayedBatchCount: replayedBatches,
        reason: "用户手动触发全量重建",
      }),
    );
    runtime.saveGraphToChat({ reason: "manual-rebuild-complete" });
    runtime.setLastExtractionStatus(
      "图谱重建完成",
      `已回放 ${replayedBatches} 批提取`,
      "success",
      {
        syncRuntime: false,
      },
    );

    if (runtime.getCurrentGraph().vectorIndexState?.lastWarning) {
      runtime.setRuntimeStatus(
        "图谱重建完成",
        `已回放 ${replayedBatches} 批，但向量仍待修复`,
        "warning",
      );
      runtime.toastr.warning(
        `图谱已重建，但向量索引仍待修复: ${runtime.getCurrentGraph().vectorIndexState.lastWarning}`,
      );
    } else {
      runtime.setRuntimeStatus(
        "图谱重建完成",
        `已回放 ${replayedBatches} 批，图谱与向量索引已刷新`,
        "success",
      );
      runtime.toastr.success("图谱与向量索引已按当前聊天全量重建");
    }
  } catch (error) {
    runtime.setCurrentGraph(
      runtime.normalizeGraphRuntimeState(
        previousGraphSnapshot,
        runtime.getCurrentChatId(),
      ),
    );
    runtime.restoreRuntimeUiState(previousUiState);
    runtime.saveGraphToChat({ reason: "manual-rebuild-restore-previous" });
    runtime.setLastExtractionStatus("图谱重建失败", error?.message || String(error), "error", {
      syncRuntime: true,
    });
    throw new Error(
      `图谱重建失败，已恢复到重建前状态: ${error?.message || error}`,
    );
  } finally {
    runtime.refreshPanelLiveState();
  }
}

export async function onImportGraphController(runtime) {
  if (!runtime.ensureGraphMutationReady("导入图谱")) {
    return { cancelled: true };
  }

  const input = runtime.document.createElement("input");
  input.type = "file";
  input.accept = ".json";

  return await new Promise((resolve, reject) => {
    const timers = getTimerApi(runtime);
    let settled = false;
    let focusTimer = null;

    const cleanup = () => {
      if (focusTimer) {
        timers.clearTimeout(focusTimer);
        focusTimer = null;
      }
      input.onchange = null;
      runtime.window.removeEventListener("focus", onWindowFocus, true);
    };

    const finish = (value, isError = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    const onWindowFocus = () => {
      focusTimer = timers.setTimeout(() => {
        if (!settled) {
          finish({ cancelled: true });
        }
      }, 180);
    };

    runtime.window.addEventListener("focus", onWindowFocus, true);
    input.addEventListener(
      "cancel",
      () => {
        finish({ cancelled: true });
      },
      { once: true },
    );

    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        finish({ cancelled: true });
        return;
      }

      try {
        const text = await file.text();
        const importedGraph = runtime.normalizeGraphRuntimeState(
          runtime.importGraph(text),
          runtime.getCurrentChatId(),
        );
        const historyRebind = rebindImportedGraphToCurrentChat(
          runtime,
          importedGraph,
        );
        runtime.setCurrentGraph(importedGraph);
        runtime.markVectorStateDirty("导入图谱后需要重建向量索引");
        runtime.setExtractionCount(
          Math.max(0, Number(importedGraph?.historyState?.extractionCount) || 0),
        );
        runtime.setLastExtractedItems([]);
        runtime.updateLastRecalledItems(importedGraph.lastRecallResult || []);
        runtime.clearInjectionState();
        runtime.saveGraphToChat({ reason: "graph-import-complete" });
        runtime.toastr.success(
          historyRebind?.rebound === true
            ? "图谱已导入，并已重新绑定当前聊天历史"
            : "图谱已导入",
        );
        finish({ imported: true, handledToast: true });
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error(String(err || "导入失败"));
        runtime.toastr.error(`导入失败: ${error.message}`);
        error._stBmeToastHandled = true;
        finish(error, true);
      }
    };

    input.click();
  });
}

export async function onRebuildVectorIndexController(runtime, range = null) {
  if (!runtime.ensureGraphMutationReady(range ? "范围重建向量" : "重建向量")) return;
  runtime.ensureCurrentGraphRuntimeState();

  const config = runtime.getEmbeddingConfig();
  const validation = runtime.validateVectorConfig(config);
  if (!validation.valid) {
    runtime.toastr.warning(validation.error);
    return;
  }

  const vectorController = runtime.beginStageAbortController("vector");
  try {
    const result = await runtime.syncVectorState({
      force: true,
      purge: runtime.isBackendVectorConfig(config) && !range,
      range,
      signal: vectorController.signal,
    });

    runtime.saveGraphToChat({ reason: "vector-rebuild-complete" });
    if (result?.aborted) {
      return;
    }
    if (result?.error) {
      throw new Error(result.error);
    }
    runtime.toastr.success(
      range
        ? `范围向量重建完成：indexed=${result.stats.indexed}, pending=${result.stats.pending}`
        : `当前聊天向量重建完成：indexed=${result.stats.indexed}, pending=${result.stats.pending}`,
    );
  } finally {
    runtime.finishStageAbortController("vector", vectorController);
    runtime.refreshPanelLiveState();
  }
}

export async function onReembedDirectController(runtime) {
  const config = runtime.getEmbeddingConfig();
  if (!runtime.isDirectVectorConfig(config)) {
    runtime.toastr.info("当前不是直连模式，无需执行重嵌");
    return;
  }

  await runtime.onRebuildVectorIndex();
}

export async function onManualSleepController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("执行遗忘")) return;
  updateManualActionUiState(runtime, "执行遗忘中", "正在评估可归档节点", "running");

  try {
    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    const result = runtime.sleepCycle(graph, runtime.getSettings());
    const mutated = hasSleepMutation(result);
    if (mutated) {
      runtime.recordMaintenanceAction?.({
        action: "sleep",
        beforeSnapshot,
        mode: "manual",
        summary: runtime.buildMaintenanceSummary?.("sleep", result, "manual"),
      });
      await runtime.recordGraphMutation({
        beforeSnapshot,
        artifactTags: ["sleep"],
      });
      updateManualActionUiState(
        runtime,
        "执行遗忘完成",
        `归档 ${result.forgotten} 个节点`,
        "success",
      );
      runtime.toastr.success(`执行遗忘完成：归档 ${result.forgotten} 个节点`);
    } else {
      updateManualActionUiState(
        runtime,
        "执行遗忘无变更",
        "当前没有符合遗忘条件的节点",
        "idle",
      );
      runtime.toastr.info(
        "当前没有符合遗忘条件的节点。本操作只做本地图清理，不会发送 LLM 请求。",
      );
    }
    return {
      handledToast: true,
      requestDispatched: false,
      mutated,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "执行遗忘失败",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onManualSynopsisController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("更新概要")) return;
  updateManualActionUiState(runtime, "更新概要中", "正在生成新的概要节点", "running");

  try {
    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    await runtime.generateSynopsis({
      graph,
      schema: runtime.getSchema(),
      currentSeq: runtime.getCurrentChatSeq(),
      customPrompt: undefined,
      settings: runtime.getSettings(),
    });
    await runtime.recordGraphMutation({
      beforeSnapshot,
      artifactTags: ["synopsis"],
    });
    updateManualActionUiState(runtime, "概要生成完成", "概要节点已更新", "success");
    runtime.toastr.success("概要生成完成");
    return {
      handledToast: true,
      requestDispatched: true,
      mutated: true,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "概要生成失败",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onManualEvolveController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("强制进化")) return;
  updateManualActionUiState(runtime, "强制进化中", "正在整理候选节点", "running");

  try {
    const embeddingConfig = runtime.getEmbeddingConfig();
    const vectorValidation = runtime.validateVectorConfig?.(embeddingConfig);
    if (vectorValidation && !vectorValidation.valid) {
      updateManualActionUiState(
        runtime,
        "强制进化未执行",
        vectorValidation.error,
        "warning",
      );
      runtime.toastr.warning(vectorValidation.error);
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason: vectorValidation.error,
      };
    }

    const candidateResolution = resolveManualEvolutionCandidates(runtime, graph);
    const candidateIds = candidateResolution.ids;
    if (candidateIds.length === 0) {
      updateManualActionUiState(
        runtime,
        "强制进化未执行",
        "当前没有可用于进化的最近提取节点",
        "idle",
      );
      runtime.toastr.info("当前没有可用于进化的最近提取节点，本次未发起整合请求");
      return {
        handledToast: true,
        requestDispatched: false,
        mutated: false,
        reason: "no-candidates",
      };
    }

    const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
    const settings = runtime.getSettings();
    updateManualActionUiState(
      runtime,
      "强制进化中",
      `正在处理 ${candidateIds.length} 个候选节点`,
      "running",
    );
    const result = await runtime.consolidateMemories({
      graph,
      newNodeIds: candidateIds,
      embeddingConfig,
      customPrompt: undefined,
      settings,
      options: {
        neighborCount: settings.consolidationNeighborCount,
        conflictThreshold: settings.consolidationThreshold,
      },
    });
    const mutated = hasConsolidationMutation(result);
    const sourceLabel = describeManualEvolutionSource(
      candidateResolution.source,
      candidateIds.length,
    );
    if (mutated) {
      runtime.recordMaintenanceAction?.({
        action: "consolidate",
        beforeSnapshot,
        mode: "manual",
        summary: runtime.buildMaintenanceSummary?.("consolidate", result, "manual"),
      });
      await runtime.recordGraphMutation({
        beforeSnapshot,
        artifactTags: ["consolidation"],
      });
      updateManualActionUiState(
        runtime,
        "强制进化完成",
        `合并 ${result.merged}，进化 ${result.evolved}，更新 ${result.updates}`,
        "success",
      );
      runtime.toastr.success(
        `强制进化完成：合并 ${result.merged}，跳过 ${result.skipped}，保留 ${result.kept}，进化 ${result.evolved}，新链接 ${result.connections}，回溯更新 ${result.updates}。${sourceLabel}。`,
      );
    } else {
      updateManualActionUiState(
        runtime,
        "强制进化无变更",
        `已完成整合判定，但本轮没有图谱变化。${sourceLabel}。`,
        "idle",
      );
      runtime.toastr.info(
        `已完成整合判定，但本轮没有产生图谱变更。${sourceLabel}。`,
      );
    }

    return {
      handledToast: true,
      requestDispatched: true,
      mutated,
      result,
      candidateSource: candidateResolution.source,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "强制进化失败",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}

export async function onUndoLastMaintenanceController(runtime) {
  const graph = runtime.getCurrentGraph();
  if (!graph) return;
  if (!runtime.ensureGraphMutationReady("撤销最近维护")) return;
  updateManualActionUiState(runtime, "撤销最近维护中", "正在恢复上一条维护变更", "running");

  try {
    const result = runtime.undoLastMaintenance?.();
    if (!result?.ok) {
      updateManualActionUiState(
        runtime,
        "撤销最近维护失败",
        result?.reason || "当前没有可撤销的维护记录",
        "warning",
      );
      runtime.toastr.warning(result?.reason || "撤销最近维护失败");
      return { handledToast: true };
    }

    runtime.markVectorStateDirty?.("撤销维护后需要重建向量索引");
    runtime.saveGraphToChat?.({ reason: "maintenance-undo-complete" });
    updateManualActionUiState(
      runtime,
      "撤销最近维护完成",
      result.entry?.summary || result.entry?.action || "已恢复最近维护",
      "success",
    );
    runtime.toastr.success(
      `已撤销最近维护：${result.entry?.summary || result.entry?.action || "未知操作"}`,
    );
    return {
      handledToast: true,
      result,
    };
  } catch (error) {
    updateManualActionUiState(
      runtime,
      "撤销最近维护失败",
      error?.message || String(error),
      "error",
    );
    throw error;
  }
}
