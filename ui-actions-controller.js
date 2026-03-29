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

  const beforeSnapshot = runtime.cloneGraphSnapshot(graph);
  const result = await runtime.compressAll(
    graph,
    runtime.getSchema(),
    runtime.getEmbeddingConfig(),
    false,
    undefined,
    undefined,
    runtime.getSettings(),
  );
  await runtime.recordGraphMutation({
    beforeSnapshot,
    artifactTags: ["compression"],
  });

  runtime.toastr.info(`压缩完成: 新建 ${result.created}, 归档 ${result.archived}`);
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
