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

  const conversationLease = runtime.captureConversationLease?.() || null;
  const assertRunCurrent = (graph = null) => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : runtime.createAbortError("Ena Planner recall aborted");
    }
    if (
      conversationLease &&
      !runtime.isConversationLeaseCurrent?.(conversationLease, {
        requireGeneration: false,
      })
    ) {
      throw runtime.createAbortError("Ena Planner conversation changed");
    }
    if (graph && runtime.getCurrentGraph() !== graph) {
      throw runtime.createAbortError("Ena Planner graph changed");
    }
    if (runtime.isHistoryRollbackPending?.()) {
      throw runtime.createAbortError("Ena Planner history rollback pending");
    }
    if (runtime.isRestoreLockActive?.()) {
      throw runtime.createAbortError("Ena Planner restore lock active");
    }
  };

  if (runtime.isRestoreLockActive?.()) {
    return {
      ok: false,
      reason: "restore-lock-active",
      memoryBlock: "",
      recentMessages: [],
      result: null,
    };
  }

  if (
    runtime.isHistoryRollbackPending?.() ||
    runtime.isGraphMetadataWriteAllowed()
  ) {
    const recovered = await runtime.recoverHistoryIfNeeded("pre-ena-planner-recall");
    if (!recovered) {
      return {
        ok: false,
        reason: "history-rollback-not-ready",
        memoryBlock: "",
        recentMessages: [],
        result: null,
      };
    }
    assertRunCurrent();
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

  await runtime.ensureVectorReadyIfNeeded("pre-ena-planner-recall", signal);
  assertRunCurrent(currentGraph);

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
  assertRunCurrent(currentGraph);
  const memoryBlock = runtime.formatInjection(result, schema).trim();

  const empty = !memoryBlock;
  return {
    ok: true,
    empty,
    reason: empty ? "completed-empty" : "completed",
    memoryBlock,
    recentMessages,
    result: {
      ...result,
      injectionText: memoryBlock,
      empty,
    },
  };
}
