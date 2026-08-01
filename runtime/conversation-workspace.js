function createFallbackStatus() {
  return { text: "", meta: "", level: "idle" };
}

export function createConversationWorkspace({
  session,
  createPersistenceState = () => ({}),
  createStatus = createFallbackStatus,
  clearTimeout: clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!session || typeof session.enterChat !== "function") {
    throw new TypeError("ConversationWorkspace requires a ConversationSession");
  }

  const workspace = {
    session,
    graph: null,
    graphPersistenceState: createPersistenceState(),
    isExtracting: false,
    isRecalling: false,
    activeRecallPromise: null,
    recallRunSequence: 0,
    lastInjectionContent: "",
    lastExtractedItems: [],
    lastRecalledItems: [],
    extractionCount: 0,
    runtimeStatus: createStatus("runtime"),
    lastExtractionStatus: createStatus("extraction"),
    lastVectorStatus: createStatus("vector"),
    lastRecallStatus: createStatus("recall"),
    isRecoveringHistory: false,
    historyRecoveryCoordinator: null,
    hostGeneration: {
      running: false,
      endedAt: 0,
      skipBeforeCombineRecallUntil: 0,
      mvuExtraAnalysisGuardUntil: 0,
      lastPreGenerationRecallKey: "",
      lastPreGenerationRecallAt: 0,
    },
    timers: {
      historyRecovery: null,
      historyRecoveryTrigger: "",
      historyMutationChecks: [],
      deferredHistoryMutationRecheck: null,
      deferredHistoryMutationPayload: null,
      graphLoadRetry: null,
      graphLoadRetryChatId: "",
    },
  };

  function clearConversationTimers() {
    const handles = [
      workspace.timers.historyRecovery,
      workspace.timers.deferredHistoryMutationRecheck,
      workspace.timers.graphLoadRetry,
      ...workspace.timers.historyMutationChecks,
    ];
    if (typeof clearTimeoutImpl === "function") {
      for (const handle of handles) {
        if (handle != null) clearTimeoutImpl(handle);
      }
    }
    workspace.timers.historyRecovery = null;
    workspace.timers.historyRecoveryTrigger = "";
    workspace.timers.historyMutationChecks = [];
    workspace.timers.deferredHistoryMutationRecheck = null;
    workspace.timers.deferredHistoryMutationPayload = null;
    workspace.timers.graphLoadRetry = null;
    workspace.timers.graphLoadRetryChatId = "";
  }

  function resetConversationState() {
    workspace.historyRecoveryCoordinator?.clear?.("conversation-changed");
    clearConversationTimers();
    workspace.graph = null;
    workspace.graphPersistenceState = createPersistenceState();
    workspace.isExtracting = false;
    workspace.isRecalling = false;
    workspace.activeRecallPromise = null;
    workspace.recallRunSequence = 0;
    workspace.lastInjectionContent = "";
    workspace.lastExtractedItems = [];
    workspace.lastRecalledItems = [];
    workspace.extractionCount = 0;
    workspace.runtimeStatus = createStatus("runtime");
    workspace.lastExtractionStatus = createStatus("extraction");
    workspace.lastVectorStatus = createStatus("vector");
    workspace.lastRecallStatus = createStatus("recall");
    workspace.isRecoveringHistory = false;
    workspace.historyRecoveryCoordinator = null;
    workspace.hostGeneration.running = false;
    workspace.hostGeneration.endedAt = 0;
    workspace.hostGeneration.skipBeforeCombineRecallUntil = 0;
    workspace.hostGeneration.mvuExtraAnalysisGuardUntil = 0;
    workspace.hostGeneration.lastPreGenerationRecallKey = "";
    workspace.hostGeneration.lastPreGenerationRecallAt = 0;
  }

  workspace.enterChat = (identity, options = {}) => {
    const result = session.enterChat(identity, options);
    if (result.changed) resetConversationState();
    return result;
  };
  workspace.captureLease = (options = {}) =>
    session.captureLease({
      revision: workspace.graphPersistenceState?.revision || 0,
      ...options,
    });
  workspace.isLeaseCurrent = (...args) => session.isLeaseCurrent(...args);
  workspace.publishGraph = (graph, { lease = null, requireGeneration = false } = {}) => {
    if (lease && !session.isLeaseCurrent(lease, { requireGeneration })) return false;
    workspace.graph = graph || null;
    return true;
  };
  workspace.resetConversationState = resetConversationState;
  workspace.clearConversationTimers = clearConversationTimers;

  return workspace;
}
