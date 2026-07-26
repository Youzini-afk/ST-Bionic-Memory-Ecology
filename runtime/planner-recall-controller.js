export async function runPlannerRecallForEnaController(runtime = {}, {
  rawUserInput,
  signal = undefined,
  disableLlmRecall = false,
} = {}) {
  const userMessage = runtime.normalizeRecallInputText(rawUserInput || "");
  const trivialInputResult = runtime.isTrivialUserInput(userMessage);
  if (trivialInputResult.trivial) {
    runtime.console.info?.(
      `[ST-BME] trivial-input skip: reason=${trivialInputResult.reason} len=${trivialInputResult.normalizedText.length} hook=ena-planner`,
    );
    return {
      ok: false,
      reason: `trivial-user-input:${trivialInputResult.reason}`,
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  const settings = runtime.getSettings();
  if (!settings.enabled || !settings.recallEnabled) {
    return {
      ok: false,
      reason: "recall-disabled",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : runtime.createAbortError("Ena Planner recall aborted");
  }

  const currentGraph = runtime.getCurrentGraph();
  if (!currentGraph || !runtime.isGraphReadableForRecall()) {
    return {
      ok: false,
      reason: "graph-not-readable",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (
    !Array.isArray(currentGraph.nodes) ||
    currentGraph.nodes.length === 0
  ) {
    return {
      ok: false,
      reason: "graph-empty",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (runtime.isGraphMetadataWriteAllowed()) {
    const recovered = await runtime.recoverHistoryIfNeeded("pre-ena-planner-recall");
    if (!recovered) {
      return {
        ok: false,
        reason: "history-recovery-not-ready",
        memoryBlock: "",
        recentMessages: [],
        result: null,
      };
    }
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : runtime.createAbortError("Ena Planner recall aborted");
  }

  await runtime.ensureVectorReadyIfNeeded("pre-ena-planner-recall", signal);

  const context = runtime.getContext();
  const chat = context?.chat ?? [];
  const recentMessages = runtime.buildRecallRecentMessages(
    chat,
    runtime.clampInt(settings.recallLlmContextMessages, 4, 0, 20),
    userMessage,
  );
  const schema = runtime.getSchema();
  const baseOptions = runtime.buildRecallRetrieveOptions(settings, context);
  const options = {
    ...baseOptions,
    enableLLMRecall: disableLlmRecall
      ? false
      : baseOptions.enableLLMRecall,
  };

  const result = await runtime.retrieve({
    graph: currentGraph,
    userMessage,
    recentMessages,
    embeddingConfig: runtime.getEmbeddingConfig(),
    schema,
    settings,
    signal,
    options,
  });
  const memoryBlock = runtime.formatInjection(result, schema).trim();

  // Belt-and-braces: when formatInjection produced an empty memory block
  // (e.g. retrieval selected zero nodes), do NOT advertise a usable handoff
  // result. Callers (ena-planner-runtime-utils.js:65) gate on
  // `plannerRecall?.result` truthiness; nulling it here prevents an empty
  // cached payload from short-circuiting the main recall. The main recall
  // should run fresh instead (docs/features/ena-planner.md:44-50,76).
  return {
    ok: Boolean(memoryBlock),
    reason: memoryBlock ? "completed" : "empty-memory-block",
    memoryBlock,
    recentMessages,
    result: memoryBlock ? result : null,
  };
}
