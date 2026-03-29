// ST-BME: 提取编排控制器（纯函数）
// 通过 runtime 依赖注入，避免直接访问 index.js 模块级状态。

export async function executeExtractionBatchController(
  runtime,
  {
    chat,
    startIdx,
    endIdx,
    settings,
    smartTriggerDecision = null,
    signal = undefined,
  } = {},
) {
  runtime.ensureCurrentGraphRuntimeState();
  runtime.throwIfAborted(signal, "提取已终止");

  const currentGraph = runtime.getCurrentGraph();
  const lastProcessed = runtime.getLastProcessedAssistantFloor();
  const extractionCountBefore = runtime.getExtractionCount();
  const beforeSnapshot = runtime.cloneGraphSnapshot(currentGraph);
  const messages = runtime.buildExtractionMessages(chat, startIdx, endIdx, settings);
  const batchStatus = runtime.createBatchStatusSkeleton({
    processedRange: [startIdx, endIdx],
    extractionCountBefore,
  });

  runtime.console.log(
    `[ST-BME] 开始提取: 楼层 ${startIdx}-${endIdx}` +
      (smartTriggerDecision?.triggered
        ? ` [智能触发 score=${smartTriggerDecision.score}; ${smartTriggerDecision.reasons.join(" / ")}]`
        : ""),
  );

  const result = await runtime.extractMemories({
    graph: currentGraph,
    messages,
    startSeq: startIdx,
    endSeq: endIdx,
    lastProcessedSeq: lastProcessed,
    schema: runtime.getSchema(),
    embeddingConfig: runtime.getEmbeddingConfig(),
    extractPrompt: undefined,
    settings,
    signal,
    onStreamProgress: ({ previewText, receivedChars }) => {
      const preview =
        previewText?.length > 60 ? "…" + previewText.slice(-60) : previewText || "";
      runtime.setLastExtractionStatus(
        "AI 生成中",
        `${preview}  [${receivedChars}字]`,
        "running",
        { noticeMarquee: true },
      );
    },
  });

  if (!result.success) {
    runtime.setBatchStageOutcome(
      batchStatus,
      "core",
      "failed",
      result?.error || "提取阶段未返回有效操作",
    );
    runtime.finalizeBatchStatus(batchStatus, runtime.getExtractionCount());
    runtime.getCurrentGraph().historyState.lastBatchStatus = batchStatus;
    return {
      success: false,
      result,
      effects: null,
      batchStatus,
      error: result?.error || "提取阶段未返回有效操作",
    };
  }

  runtime.setBatchStageOutcome(batchStatus, "core", "success");
  const effects = await runtime.handleExtractionSuccess(
    result,
    endIdx,
    settings,
    signal,
    batchStatus,
  );
  const finalizedBatchStatus =
    effects?.batchStatus ||
    runtime.finalizeBatchStatus(batchStatus, runtime.getExtractionCount());

  runtime.getCurrentGraph().historyState.lastBatchStatus = {
    ...finalizedBatchStatus,
    historyAdvanced: runtime.shouldAdvanceProcessedHistory(finalizedBatchStatus),
  };

  if (runtime.getCurrentGraph().historyState.lastBatchStatus.historyAdvanced) {
    runtime.updateProcessedHistorySnapshot(chat, endIdx);
  }

  const afterSnapshot = runtime.cloneGraphSnapshot(runtime.getCurrentGraph());
  const postProcessArtifacts = runtime.computePostProcessArtifacts(
    beforeSnapshot,
    afterSnapshot,
    effects?.postProcessArtifacts || [],
  );
  runtime.appendBatchJournal(
    runtime.getCurrentGraph(),
    runtime.createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
      processedRange: [startIdx, endIdx],
      postProcessArtifacts,
      vectorHashesInserted: effects?.vectorHashesInserted || [],
      extractionCountBefore,
    }),
  );
  runtime.saveGraphToChat({ reason: "extraction-batch-complete" });

  return {
    success: finalizedBatchStatus.completed,
    result,
    effects,
    batchStatus: finalizedBatchStatus,
    error: finalizedBatchStatus.completed
      ? ""
      : effects?.vectorError ||
        finalizedBatchStatus.errors?.[0] ||
        "批次未完成 finalize 闭环",
  };
}
