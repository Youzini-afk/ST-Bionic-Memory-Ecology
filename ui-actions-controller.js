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
