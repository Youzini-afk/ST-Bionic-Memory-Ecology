import {
  onBeforeCombinePromptsController,
  onGenerationAfterCommandsController,
  onGenerationStartedController,
  onMessageReceivedController,
  onMessageSentController,
} from "../../host/event-binding.js";
import { isSystemMessageForExtraction } from "../../maintenance/chat-history.js";
import { resolveAutoExtractionPlanController } from "../../maintenance/extraction-controller.js";
import { GRAPH_LOAD_STATES, MODULE_NAME } from "../../graph/graph-persistence.js";
import { getSmartTriggerDecision } from "../../maintenance/smart-trigger.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  readPersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  resolveGenerationTargetUserMessageIndex,
  writePersistedRecallToUserMessage,
} from "../../retrieval/recall-persistence.js";
import {
  buildRecallRecentMessagesController,
  getRecallUserMessageSourceLabelController,
} from "../../retrieval/recall-controller.js";
import {
  clampInt,
  createRecallInputRecord,
  createUiStatus,
  formatRecallContextLine,
  getGenerationRecallHookStateFromResult,
  hashRecallInput,
  isFreshRecallInputRecord,
  isTrivialUserInput,
  normalizeRecallInputText,
  shouldRunRecallForTransaction,
} from "../../ui/ui-status.js";
import { defaultSettings, mergePersistedSettings } from "../../runtime/settings-defaults.js";
import { createRecallInputState } from "../../runtime/recall-input-state.js";
import { createRerollRecallInput } from "../../runtime/reroll-recall-input.js";
import { createConversationSession } from "../../runtime/conversation-session.js";
import { createGenerationRecallTransactions } from "../../runtime/generation-recall-transactions.js";
import { createFinalRecallInjection } from "../../runtime/final-recall-injection.js";
import { createAutoExtractionDefer } from "../../runtime/auto-extraction-defer.js";
import { runPlannerRecallForEnaController } from "../../runtime/planner-recall-controller.js";

const RECALL_INPUT_RECORD_TTL_MS = 60000;
const TRIVIAL_GENERATION_SKIP_TTL_MS = 60000;
const GENERATION_RECALL_TRANSACTION_TTL_MS = 15000;
const PLANNER_RECALL_HANDOFF_TTL_MS = GENERATION_RECALL_TRANSACTION_TTL_MS;
const GENERATION_RECALL_HOOK_BRIDGE_MS = 1200;
const AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS = [120, 320, 800, 1600, 2800];
const AUTO_EXTRACTION_HOST_SETTLE_MS = 120;

function createTrivialRecallSkipSentinel(reason = "") {
  return {
    __trivialSkip: true,
    trivialReason: String(reason || ""),
  };
}

function findLatestUserChatMessageWithIndex(chat) {
  if (!Array.isArray(chat)) return null;
  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (isSystemMessageForExtraction(message, { index, chat })) continue;
    if (message?.is_user) return { message, index };
  }
  return null;
}

function getLastNonSystemChatMessage(chat) {
  if (!Array.isArray(chat)) return null;
  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (!isSystemMessageForExtraction(message, { index, chat })) {
      return message;
    }
  }
  return null;
}

function normalizeRecallNodeIdList(nodeIds = []) {
  if (!Array.isArray(nodeIds)) return [];
  return nodeIds
    .map((entry) => {
      if (typeof entry === "string" || typeof entry === "number") {
        return String(entry).trim();
      }
      if (entry && typeof entry === "object") {
        return String(entry.id || entry.nodeId || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function areRecallNodeIdListsEqual(left = [], right = []) {
  const normalizedLeft = normalizeRecallNodeIdList(left);
  const normalizedRight = normalizeRecallNodeIdList(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  for (let index = 0; index < normalizedLeft.length; index++) {
    if (normalizedLeft[index] !== normalizedRight[index]) return false;
  }
  return true;
}

function buildRecallTargetCandidateHashes(candidateTexts = []) {
  const hashes = new Set();
  for (const text of candidateTexts) {
    const normalized = normalizeRecallInputText(text);
    if (!normalized) continue;
    const hash = hashRecallInput(normalized);
    if (hash) hashes.add(hash);
  }
  return hashes;
}

function doesChatUserMessageMatchRecallCandidates(message, candidateHashes) {
  if (!message?.is_user || !(candidateHashes instanceof Set) || !candidateHashes.size) {
    return false;
  }
  const normalizedMessage = normalizeRecallInputText(message?.mes || "");
  if (!normalizedMessage) return false;
  return candidateHashes.has(hashRecallInput(normalizedMessage));
}

function resolveRecallPersistenceTargetUserMessageIndex(
  chat,
  {
    generationType = "normal",
    explicitTargetUserMessageIndex = null,
    candidateTexts = [],
    preferredRecord = null,
    requireStableTarget = false,
  } = {},
) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  const normalizedGenerationType =
    String(generationType || "normal").trim() || "normal";

  const explicitIndex = Number.isFinite(explicitTargetUserMessageIndex)
    ? Math.floor(Number(explicitTargetUserMessageIndex))
    : null;
  if (Number.isFinite(explicitIndex) && chat[explicitIndex]?.is_user) {
    return explicitIndex;
  }
  if (requireStableTarget) return null;

  const candidateHashes = buildRecallTargetCandidateHashes(candidateTexts);
  const latestUserIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType: "history",
  });

  const hasFreshPreferredRecord = isFreshRecallInputRecord(preferredRecord);
  const preferredMessageId =
    hasFreshPreferredRecord && Number.isFinite(preferredRecord?.messageId)
      ? Math.floor(Number(preferredRecord.messageId))
      : null;

  if (
    Number.isFinite(preferredMessageId) &&
    chat[preferredMessageId]?.is_user &&
    (!candidateHashes.size ||
      doesChatUserMessageMatchRecallCandidates(
        chat[preferredMessageId],
        candidateHashes,
      ))
  ) {
    return preferredMessageId;
  }

  if (
    candidateHashes.size &&
    Number.isFinite(latestUserIndex) &&
    chat[latestUserIndex]?.is_user &&
    doesChatUserMessageMatchRecallCandidates(
      chat[latestUserIndex],
      candidateHashes,
    )
  ) {
    return latestUserIndex;
  }

  if (hasFreshPreferredRecord && candidateHashes.size) {
    for (let index = chat.length - 1; index >= 0; index--) {
      const message = chat[index];
      if (doesChatUserMessageMatchRecallCandidates(message, candidateHashes)) {
        return index;
      }
    }
  }

  if (
    normalizedGenerationType === "normal" &&
    Number.isFinite(latestUserIndex) &&
    chat[latestUserIndex]?.is_user
  ) {
    return latestUserIndex;
  }

  if (
    normalizedGenerationType === "normal" &&
    Number.isFinite(preferredMessageId) &&
    chat[preferredMessageId]?.is_user
  ) {
    return preferredMessageId;
  }

  if (
    normalizedGenerationType !== "normal" &&
    Number.isFinite(latestUserIndex) &&
    chat[latestUserIndex]?.is_user
  ) {
    return latestUserIndex;
  }

  return null;
}

export async function createGenerationRecallHarness(options = {}) {
  const { realApplyFinal = false } = options;

  let isHostGenerationRunning = false;
  let lastHostGenerationEndedAt = 0;
  let skipBeforeCombineRecallUntil = 0;
  let graphPersistenceState = {
    loadState: GRAPH_LOAD_STATES.LOADED,
    dbReady: true,
    chatId: "chat-main",
    restoreLock: null,
  };
  let runtimeStatus = createUiStatus("待命", "准备就绪", "idle");
  let lastInjectionContent = "";

  const harness = {
    console,
    Date,
    Map,
    setTimeout,
    clearTimeout,
    __sendTextareaValue: "",
    document: {
      getElementById(id) {
        if (
          id === "send_textarea" &&
          typeof harness.__sendTextareaValue === "string" &&
          harness.__sendTextareaValue
        ) {
          return { value: harness.__sendTextareaValue };
        }
        return null;
      },
    },
    result: null,
    currentGraph: {},
    extension_settings: { [MODULE_NAME]: {} },
    settings: {},
    chat: [],
    runRecallCalls: [],
    runExtractionCalls: [],
    extractionIssues: [],
    applyFinalCalls: [],
    moduleInjectionCalls: [],
    recordedInjectionSnapshots: [],
    refreshPanelCalls: 0,
    hideScheduleCalls: [],
    metadataSaveCalls: 0,
    recallUiRefreshCalls: 0,
    artifactUnavailableReports: [],
    retrieveCalls: [],
    retrieveImpl: null,
    isExtracting: false,
    isRecoveringHistory: false,
    activeChatId: "chat-main",
  };

  const normalizeChatIdCandidate = (value = "") => String(value ?? "").trim();
  const getCurrentChatId = () => harness.activeChatId;
  const getContext = () => ({
    chatId: harness.activeChatId,
    chat: harness.chat,
  });
  const conversationSession = createConversationSession({
    rerollInferenceWindowMs: GENERATION_RECALL_TRANSACTION_TTL_MS,
  });
  conversationSession.enterChat({
    chatId: getCurrentChatId(),
    hostChatId: getCurrentChatId(),
  });
  conversationSession.beginGeneration("normal");
  harness.enterConversation = (chatId) => {
    harness.activeChatId = String(chatId || "");
    return conversationSession.enterChat(
      { chatId, hostChatId: chatId },
      { forceNewEpoch: true, reason: "test-chat-change" },
    );
  };
  const readConversationInput = (name) =>
    conversationSession.getInput(name) || createRecallInputRecord();
  const writeConversationInput = (name, record) =>
    conversationSession.setInput(name, record || createRecallInputRecord());
  const getSettings = () => {
    const merged = mergePersistedSettings({
      ...(harness.settings || {}),
      ...(harness.extension_settings?.[MODULE_NAME] || {}),
    });
    harness.settings = merged;
    harness.extension_settings[MODULE_NAME] = merged;
    return merged;
  };
  const getSendTextareaValue = () => harness.__sendTextareaValue;
  const triggerChatMetadataSave = () => {
    harness.metadataSaveCalls += 1;
    return "debounced";
  };
  const refreshPanelLiveState = () => {
    harness.refreshPanelCalls += 1;
  };
  const schedulePersistedRecallMessageUiRefresh = () => {
    harness.recallUiRefreshCalls += 1;
  };
  const recordInjectionSnapshot = (_kind, snapshot = {}) => {
    harness.recordedInjectionSnapshots.push({ ...snapshot });
  };
  const recordMessageTraceSnapshot = () => {};
  const applyModuleInjectionPrompt = (text = "") => {
    const normalizedText = String(text || "");
    harness.moduleInjectionCalls.push(normalizedText);
    return {
      applied: Boolean(normalizedText.trim()),
      source: normalizedText.trim() ? "module-injection" : "rewrite-clear",
      mode: normalizedText.trim() ? "module-injection" : "rewrite-clear",
    };
  };
  const clearLiveRecallInjectionPromptForRewrite = () => {
    try {
      return (
        applyModuleInjectionPrompt("", getSettings()) || {
          applied: false,
          source: "rewrite-clear",
          mode: "rewrite-clear",
        }
      );
    } catch (error) {
      return {
        applied: false,
        source: "rewrite-clear-error",
        mode: "rewrite-clear-error",
        error: error instanceof Error ? error.message : String(error || ""),
      };
    }
  };
  const buildRecallRecentMessages = (chat, limit, syntheticUserMessage = "") =>
    buildRecallRecentMessagesController(chat, limit, syntheticUserMessage, {
      formatRecallContextLine,
      normalizeRecallInputText,
    });
  const buildRecallRetrieveOptions = (settings, context) => ({
    topK: settings.recallTopK,
    maxRecallNodes: settings.recallMaxNodes,
    enableLLMRecall: settings.recallEnableLLM,
    enableVectorPrefilter: settings.recallEnableVectorPrefilter,
    enableGraphDiffusion: settings.recallEnableGraphDiffusion,
    diffusionTopK: settings.recallDiffusionTopK,
    llmCandidatePool: settings.recallLlmCandidatePool,
    recallPrompt: undefined,
    weights: {
      graphWeight: settings.graphWeight,
      vectorWeight: settings.vectorWeight,
      importanceWeight: settings.importanceWeight,
    },
    enableVisibility: settings.enableVisibility ?? false,
    visibilityFilter: context.name2 || null,
    enableCrossRecall: settings.enableCrossRecall ?? false,
    enableProbRecall: settings.enableProbRecall ?? false,
    probRecallChance: settings.probRecallChance ?? 0.15,
    enableMultiIntent: settings.recallEnableMultiIntent ?? true,
    multiIntentMaxSegments: settings.recallMultiIntentMaxSegments ?? 4,
    enableContextQueryBlend: settings.recallEnableContextQueryBlend ?? true,
    contextAssistantWeight: settings.recallContextAssistantWeight ?? 0.2,
    contextPreviousUserWeight: settings.recallContextPreviousUserWeight ?? 0.1,
    enableLexicalBoost: settings.recallEnableLexicalBoost ?? true,
    lexicalWeight: settings.recallLexicalWeight ?? 0.18,
    teleportAlpha: settings.recallTeleportAlpha ?? 0.15,
    enableTemporalLinks: settings.recallEnableTemporalLinks ?? true,
    temporalLinkStrength: settings.recallTemporalLinkStrength ?? 0.2,
    enableDiversitySampling: settings.recallEnableDiversitySampling ?? true,
    dppCandidateMultiplier: settings.recallDppCandidateMultiplier ?? 3,
    dppQualityWeight: settings.recallDppQualityWeight ?? 1.0,
    enableCooccurrenceBoost: settings.recallEnableCooccurrenceBoost ?? false,
    cooccurrenceScale: settings.recallCooccurrenceScale ?? 0.1,
    cooccurrenceMaxNeighbors: settings.recallCooccurrenceMaxNeighbors ?? 10,
    enableResidualRecall: settings.recallEnableResidualRecall ?? false,
    residualBasisMaxNodes: settings.recallResidualBasisMaxNodes ?? 24,
    residualNmfTopics: settings.recallNmfTopics ?? 15,
    residualNmfNoveltyThreshold: settings.recallNmfNoveltyThreshold ?? 0.4,
    residualThreshold: settings.recallResidualThreshold ?? 0.3,
    residualTopK: settings.recallResidualTopK ?? 5,
    vectorQueryConcurrency: settings.vectorQueryConcurrency ?? 4,
    authorityCandidateQueryConcurrency: settings.vectorQueryConcurrency ?? 4,
    enableScopedMemory: settings.enableScopedMemory ?? true,
    enablePovMemory: settings.enablePovMemory ?? true,
    enableRegionScopedObjective: settings.enableRegionScopedObjective ?? true,
    enableCognitiveMemory: settings.enableCognitiveMemory ?? true,
    enableSpatialAdjacency: settings.enableSpatialAdjacency ?? true,
    enableStoryTimeline: settings.enableStoryTimeline ?? true,
    injectStoryTimeLabel: settings.injectStoryTimeLabel ?? true,
    storyTimeSoftDirecting: settings.storyTimeSoftDirecting ?? true,
    recallCharacterPovWeight: settings.recallCharacterPovWeight ?? 1.25,
    recallUserPovWeight: settings.recallUserPovWeight ?? 1.05,
    recallObjectiveCurrentRegionWeight: settings.recallObjectiveCurrentRegionWeight ?? 1.15,
    recallObjectiveAdjacentRegionWeight: settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
    recallObjectiveGlobalWeight: settings.recallObjectiveGlobalWeight ?? 0.75,
    injectUserPovMemory: settings.injectUserPovMemory ?? true,
    injectObjectiveGlobalMemory: settings.injectObjectiveGlobalMemory ?? true,
    injectLowConfidenceObjectiveMemory: settings.injectLowConfidenceObjectiveMemory ?? false,
    activeRegion:
      harness.currentGraph?.historyState?.activeRegion ||
      harness.currentGraph?.historyState?.lastExtractedRegion ||
      "",
    activeStorySegmentId: harness.currentGraph?.historyState?.activeStorySegmentId || "",
    activeStoryTimeLabel: harness.currentGraph?.historyState?.activeStoryTimeLabel || "",
    activeCharacterPovOwner: harness.currentGraph?.historyState?.activeCharacterPovOwner || "",
    activeUserPovOwner: harness.currentGraph?.historyState?.activeUserPovOwner || context.name1 || "",
  });
  const retrieve = async (...args) => {
    harness.retrieveCalls.push(args);
    if (typeof harness.retrieveImpl === "function") {
      return await harness.retrieveImpl(...args);
    }
    return { entries: [], items: [], nodes: [] };
  };
  const formatInjection = (result = null) =>
    String(result?.injectionText || result?.memoryBlock || "");
  const getSchema = () => [];
  const getEmbeddingConfig = () => ({});
  const createAbortError = (message = "aborted") => {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  };
  const isGraphMetadataWriteAllowed = (loadState = graphPersistenceState.loadState) =>
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED;
  const isGraphReadable = (loadState = graphPersistenceState.loadState) =>
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED ||
    loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
    (loadState === GRAPH_LOAD_STATES.BLOCKED && graphPersistenceState.shadowSnapshotUsed);
  const isGraphReadableForRecall = (loadState = graphPersistenceState.loadState) =>
    isGraphReadable(loadState) || Boolean(harness.currentGraph?.nodes && harness.currentGraph?.edges);
  const ensureVectorReadyIfNeeded = async () => true;
  const recoverHistoryIfNeeded = async () => true;
  const isAssistantChatMessage = (message) =>
    Boolean(message) && !message.is_user && !message.is_system;
  const isTavernHelperPromptViewerRefreshActive = () => {
    try {
      const doc = harness.document;
      if (!doc?.querySelectorAll) return false;
      const dialogs = Array.from(doc.querySelectorAll('[role="dialog"]'));
      for (const dialog of dialogs) {
        const dialogText = String(dialog?.textContent || "");
        if (!/(提示词查看器|prompt\s*viewer)/i.test(dialogText)) continue;
        if (dialog?.querySelector?.(".fa-rotate-right.animate-spin")) return true;
      }
    } catch {}
    return false;
  };

  let recallInputState;
  let rerollRecallInput;
  let generationRecallTransactionRuntime;
  let finalRecallInjectionRuntime;
  let autoExtractionDeferRuntime;

  const clearPlannerTurnHandoffsForChat = (chatId = getCurrentChatId(), opts = {}) =>
    rerollRecallInput.clearPlannerTurnHandoffsForChat(chatId, opts);

  recallInputState = createRecallInputState({
    createRecallInputRecord,
    getCurrentChatId,
    getLastRecallSentUserMessage: () =>
      readConversationInput("lastRecallSentUserMessage"),
    getPendingHostGenerationInputSnapshot: () =>
      readConversationInput("pendingHostGenerationInputSnapshot"),
    getPendingRecallSendIntent: () =>
      readConversationInput("pendingRecallSendIntent"),
    getCurrentGenerationTrivialSkip: () => conversationSession.getTrivialSkip(),
    hashRecallInput,
    isFreshRecallInputRecord,
    normalizeChatIdCandidate,
    normalizeRecallInputText,
    recordMessageTraceSnapshot,
    setLastRecallSentUserMessage: (record) =>
      writeConversationInput("lastRecallSentUserMessage", record),
    setPendingHostGenerationInputSnapshot: (record) =>
      writeConversationInput("pendingHostGenerationInputSnapshot", record),
    setPendingRecallSendIntent: (record) =>
      writeConversationInput("pendingRecallSendIntent", record),
    setCurrentGenerationTrivialSkip: (record) =>
      conversationSession.setTrivialSkip(record),
    clearPlannerTurnHandoffsForChat,
    TRIVIAL_GENERATION_SKIP_TTL_MS,
  });

  rerollRecallInput = createRerollRecallInput({
    clearPendingHostGenerationInputSnapshot: (...args) =>
      recallInputState.clearPendingHostGenerationInputSnapshot(...args),
    clearPendingRecallSendIntent: (...args) =>
      recallInputState.clearPendingRecallSendIntent(...args),
    console,
    createTrivialRecallSkipSentinel,
    findLatestUserChatMessageWithIndex,
    formatInjection,
    getContext,
    getCurrentChatId,
    getCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.getCurrentGenerationTrivialSkip(...args),
    getLastNonSystemChatMessage,
    getLastRecallSentUserMessage: () =>
      readConversationInput("lastRecallSentUserMessage"),
    getLatestUserChatMessage: (chat = []) =>
      [...chat].reverse().find((message) => message?.is_user) || null,
    getPendingRecallSendIntent: () =>
      readConversationInput("pendingRecallSendIntent"),
    getSchema,
    getSendTextareaValue,
    hashRecallInput,
    isFreshRecallInputRecord,
    isTrivialUserInput,
    markCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.markCurrentGenerationTrivialSkip(...args),
    normalizeChatIdCandidate,
    normalizeRecallInputText,
    readPersistedRecallFromUserMessage,
    resolveGenerationTargetUserMessageIndex,
    GENERATION_RECALL_TRANSACTION_TTL_MS,
    PLANNER_RECALL_HANDOFF_TTL_MS,
  });

  generationRecallTransactionRuntime = createGenerationRecallTransactions({
    getContext,
    getCurrentChatId,
    getActiveGenerationId: () => conversationSession.getGeneration()?.id || "",
    getGenerationRecallTransaction: () =>
      conversationSession.getRecallTransaction(),
    setGenerationRecallTransaction: (transaction) =>
      conversationSession.setRecallTransaction(transaction),
    clearGenerationRecallTransaction: () =>
      conversationSession.clearRecallTransaction(),
    getRecallUserMessageSourceLabel: (...args) =>
      getRecallUserMessageSourceLabelController(...args),
    getSettings,
    hashRecallInput,
    normalizeChatIdCandidate,
    normalizeRecallInputText,
    peekPlannerTurnHandoff: (...args) =>
      rerollRecallInput.peekPlannerTurnHandoff(...args),
    clearPlannerTurnHandoffsForChat,
    markPlannerTurnHandoffMatched: (...args) =>
      rerollRecallInput.markPlannerTurnHandoffMatched(...args),
    resolveGenerationTargetUserMessageIndex,
    shouldRunRecallForTransaction,
  });

  finalRecallInjectionRuntime = createFinalRecallInjection({
    applyModuleInjectionPrompt,
    areRecallNodeIdListsEqual,
    buildPersistedRecallRecord,
    bumpPersistedRecallGenerationCount,
    clearLiveRecallInjectionPromptForRewrite,
    createUiStatus,
    debugPersistedRecallPersistence: () => {},
    estimateTokens: (text = "") =>
      normalizeRecallInputText(text).split(/\s+/).filter(Boolean).length ||
      (normalizeRecallInputText(text) ? 1 : 0),
    getContext,
    getGenerationRecallTransactionResult: (...args) =>
      generationRecallTransactionRuntime.getGenerationRecallTransactionResult(...args),
    getLastInjectionContent: () => lastInjectionContent,
    getLastRecallSentUserMessage: () =>
      readConversationInput("lastRecallSentUserMessage"),
    getRuntimeStatus: () => runtimeStatus,
    getSettings,
    isRecallChatIdCurrent: (chatId) =>
      normalizeChatIdCandidate(chatId) ===
      normalizeChatIdCandidate(getCurrentChatId()),
    normalizeRecallInputText,
    normalizeRecallNodeIdList,
    readGenerationRecallTransactionFinalResolution: (...args) =>
      generationRecallTransactionRuntime.readGenerationRecallTransactionFinalResolution(...args),
    readPersistedRecallFromUserMessage,
    recordInjectionSnapshot,
    refreshPanelLiveState,
    resolveFinalRecallInjectionSource,
    resolveGenerationRecallDeliveryMode: (...args) =>
      generationRecallTransactionRuntime.resolveGenerationRecallDeliveryMode(...args),
    resolveGenerationTargetUserMessageIndex,
    resolveRecallPersistenceTargetUserMessageIndex,
    schedulePersistedRecallMessageUiRefresh,
    setLastInjectionContent: (value = "") => {
      lastInjectionContent = String(value || "");
    },
    setRuntimeStatus: (status) => {
      runtimeStatus = status;
    },
    storeGenerationRecallTransactionFinalResolution: (...args) =>
      generationRecallTransactionRuntime.storeGenerationRecallTransactionFinalResolution(...args),
    triggerChatMetadataSave,
    writePersistedRecallToUserMessage,
  });

  autoExtractionDeferRuntime = createAutoExtractionDefer({
    clearTimeout,
    cloneRuntimeDebugValue: (value) => value == null ? null : JSON.parse(JSON.stringify(value)),
    console,
    ensureGraphMutationReady: () => true,
    getContext,
    getCurrentChatId,
    getCurrentGraph: () => harness.currentGraph,
    getGraphPersistenceState: () => graphPersistenceState,
    getIsExtracting: () => harness.isExtracting,
    getIsHostGenerationRunning: () => isHostGenerationRunning,
    getIsRecoveringHistory: () => harness.isRecoveringHistory,
    getLastHostGenerationEndedAt: () => lastHostGenerationEndedAt,
    getSettings,
    isAssistantChatMessage,
    isRestoreLockActive: () => false,
    normalizeChatIdCandidate,
    normalizeRestoreLockState: (value) => value || null,
    notifyExtractionIssue: (message) => {
      harness.extractionIssues.push(String(message || ""));
    },
    resolveAutoExtractionPlan: (options = {}) =>
      resolveAutoExtractionPlanController(
        {
          getAssistantTurns(chat = []) {
            return chat.flatMap((message, index) =>
              !message?.is_user && !message?.is_system ? [index] : [],
            );
          },
          getLastProcessedAssistantFloor: () => -1,
          getSettings,
          getSmartTriggerDecision: () => ({
            triggered: false,
            score: 0,
            reasons: [],
          }),
        },
        options,
      ),
    runExtraction: (...args) => harness.runExtraction(...args),
    setTimeout,
    AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS,
    AUTO_EXTRACTION_HOST_SETTLE_MS,
  });

  const hookRuntime = () => ({
    applyFinalRecallInjectionForGeneration: (...args) =>
      harness.result.applyFinalRecallInjectionForGeneration(...args),
    buildGenerationAfterCommandsRecallInput: (...args) =>
      rerollRecallInput.buildGenerationAfterCommandsRecallInput(...args),
    buildHistoryGenerationRecallInput: (...args) =>
      rerollRecallInput.buildHistoryGenerationRecallInput(...args),
    buildNormalGenerationRecallInput: (...args) =>
      rerollRecallInput.buildNormalGenerationRecallInput(...args),
    clearDryRunPromptPreview,
    clearPendingHostGenerationInputSnapshot: (...args) =>
      recallInputState.clearPendingHostGenerationInputSnapshot(...args),
    clearPendingRecallSendIntent: (...args) =>
      recallInputState.clearPendingRecallSendIntent(...args),
    clearLiveRecallInjectionPromptForRewrite,
    clearFinalRecallInjectionFailClosed: (...args) =>
      finalRecallInjectionRuntime.clearFinalRecallInjectionFailClosed(...args),
    clearCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.clearCurrentGenerationTrivialSkip(...args),
    consumeDryRunPromptPreview,
    consumeHostGenerationInputSnapshot: (...args) =>
      recallInputState.consumeHostGenerationInputSnapshot(...args),
    createGenerationRecallContext: (...args) =>
      generationRecallTransactionRuntime.createGenerationRecallContext(...args),
    createRecallInputRecord,
    ensurePersistedRecallRecordForGeneration: (...args) =>
      finalRecallInjectionRuntime.ensurePersistedRecallRecordForGeneration(...args),
    bindGenerationRecallTransactionToUserMessage: (...args) =>
      finalRecallInjectionRuntime.bindGenerationRecallTransactionToUserMessage(...args),
    freezeHostGenerationInputSnapshot: (...args) =>
      recallInputState.freezeHostGenerationInputSnapshot(...args),
    getContext,
    getCurrentChatId,
    getGenerationContext: () => conversationSession.getGeneration(),
    getGenerationRecallHookStateFromResult,
    getGenerationRecallTransactionResult: (...args) =>
      generationRecallTransactionRuntime.getGenerationRecallTransactionResult(...args),
    getPendingHostGenerationInputSnapshot: (...args) =>
      recallInputState.getPendingHostGenerationInputSnapshot(...args),
    getPendingRecallSendIntent: () =>
      readConversationInput("pendingRecallSendIntent"),
    getSendTextareaValue,
    isFreshRecallInputRecord,
    isMvuExtraAnalysisGuardActive: () => false,
    isTavernHelperPromptViewerRefreshActive,
    isTrivialUserInput,
    markDryRunPromptPreview,
    markCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.markCurrentGenerationTrivialSkip(...args),
    markGenerationRecallTransactionHookState: (...args) =>
      generationRecallTransactionRuntime.markGenerationRecallTransactionHookState(...args),
    normalizeRecallInputText,
    reapplyPersistedRecallBlock: (...args) =>
      finalRecallInjectionRuntime.reapplyPersistedRecallBlock(...args),
    validateNoNewUserTurnArtifacts: (...args) =>
      typeof harness.validateNoNewUserTurnArtifacts === "function"
        ? harness.validateNoNewUserTurnArtifacts(...args)
        : { valid: false, reason: "durable-turn-artifacts-unavailable" },
    reportNoNewUserArtifactUnavailable: (reason) => {
      harness.artifactUnavailableReports.push(String(reason || ""));
    },
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    resolveGenerationRecallDeliveryMode: (...args) =>
      generationRecallTransactionRuntime.resolveGenerationRecallDeliveryMode(...args),
    runRecall: (...args) => harness.runRecall(...args),
    storeGenerationRecallTransactionResult: (...args) =>
      generationRecallTransactionRuntime.storeGenerationRecallTransactionResult(...args),
  });

  function markDryRunPromptPreview(ttlMs = GENERATION_RECALL_HOOK_BRIDGE_MS) {
    const resolvedTtlMs = Math.max(
      100,
      Math.floor(Number(ttlMs) || GENERATION_RECALL_HOOK_BRIDGE_MS),
    );
    skipBeforeCombineRecallUntil = Date.now() + resolvedTtlMs;
    return skipBeforeCombineRecallUntil;
  }
  function clearDryRunPromptPreview() {
    const hadPendingSkip = skipBeforeCombineRecallUntil > Date.now();
    skipBeforeCombineRecallUntil = 0;
    return hadPendingSkip;
  }
  function consumeDryRunPromptPreview(now = Date.now()) {
    if (skipBeforeCombineRecallUntil <= now) {
      if (skipBeforeCombineRecallUntil !== 0) {
        skipBeforeCombineRecallUntil = 0;
      }
      return false;
    }
    skipBeforeCombineRecallUntil = 0;
    return true;
  }

  function onGenerationStarted(type, params = {}, dryRun = false) {
    const generationType = String(type || "normal").trim() || "normal";
    const pendingRecallSendIntent = readConversationInput(
      "pendingRecallSendIntent",
    );
    conversationSession.beginGeneration(
      generationType,
      {
        ...params,
        __stBmeFreshInputHint: Boolean(
          pendingRecallSendIntent?.text || pendingRecallSendIntent?.rawText,
        ),
      },
      { dryRun, phase: "GENERATION_STARTED" },
    );
    if (
      !dryRun &&
      !params?.automatic_trigger &&
      !params?.quiet_prompt &&
      generationType === "normal"
    ) {
      isHostGenerationRunning = true;
      lastHostGenerationEndedAt = 0;
    }
    return onGenerationStartedController(hookRuntime(), type, params, dryRun);
  }

  function onGenerationEnded(_chatLength = null) {
    isHostGenerationRunning = false;
    lastHostGenerationEndedAt = Date.now();
    const recentTransaction =
      generationRecallTransactionRuntime.findRecentGenerationRecallTransactionForChat();
    const recentRecallResult =
      generationRecallTransactionRuntime.getGenerationRecallTransactionResult(recentTransaction);
    finalRecallInjectionRuntime.ensurePersistedRecallRecordForGeneration({
      generationType: recentTransaction?.generationType || "normal",
      recallResult: recentRecallResult,
      transaction: recentTransaction,
      recallOptions: recentTransaction?.frozenRecallOptions || null,
      hookName:
        recentRecallResult?.hookName ||
        recentTransaction?.lastRecallMeta?.hookName ||
        "",
    });
    schedulePersistedRecallMessageUiRefresh(320);
    void autoExtractionDeferRuntime.maybeResumePendingAutoExtraction("generation-ended");
    harness.hideScheduleCalls.push([{}, {}, 180]);
    conversationSession.clearGeneration("generation-ended");
  }

  async function onGenerationAfterCommands(type, params = {}, dryRun = false) {
    conversationSession.updateGeneration(type, params, {
      dryRun,
      phase: "GENERATION_AFTER_COMMANDS",
    });
    return await onGenerationAfterCommandsController(
      hookRuntime(),
      type,
      params,
      dryRun,
    );
  }

  async function onBeforeCombinePrompts(promptData = null) {
    return await onBeforeCombinePromptsController(hookRuntime(), promptData);
  }

  harness.runRecall = async (options = {}) => {
    harness.runRecallCalls.push({ ...options });
    const overrideUserMessage = String(
      options.overrideUserMessage || options.userMessage || "",
    );
    return {
      status: "completed",
      didRecall: true,
      ok: true,
      injectionText: `注入:${overrideUserMessage}`,
      deliveryMode: String(options.deliveryMode || "immediate"),
      source: options.overrideSource,
      sourceLabel: options.overrideSourceLabel,
      reason: options.overrideReason,
      hookName: options.hookName,
      recallInput: overrideUserMessage,
      userMessage: overrideUserMessage,
      authoritativeInputUsed: Boolean(options.authoritativeInputUsed),
      boundUserFloorText: String(options.boundUserFloorText || ""),
      sourceCandidates: Array.isArray(options.sourceCandidates)
        ? options.sourceCandidates.map((candidate) => ({ ...candidate }))
        : [],
      selectedNodeIds: ["node-test-1"],
      retrievalMeta: {
        vectorHits: 1,
        vectorMergedHits: 0,
        diffusionHits: 0,
        candidatePoolAfterDpp: 1,
      },
      llmMeta: {
        status: "disabled",
        reason: "test-disabled",
        candidatePool: 0,
      },
      stats: {
        coreCount: 1,
        recallCount: 1,
      },
    };
  };
  harness.runExtraction = async (...args) => {
    harness.runExtractionCalls.push(args);
    return { ok: true };
  };

  const originalApplyFinalRecallInjectionForGeneration = (payload = {}) =>
    finalRecallInjectionRuntime.applyFinalRecallInjectionForGeneration(payload);

  harness.result = {
    hashRecallInput,
    buildPreGenerationRecallKey: (...args) =>
      generationRecallTransactionRuntime.buildPreGenerationRecallKey(...args),
    buildGenerationAfterCommandsRecallInput: (...args) =>
      rerollRecallInput.buildGenerationAfterCommandsRecallInput(...args),
    buildNormalGenerationRecallInput: (...args) =>
      rerollRecallInput.buildNormalGenerationRecallInput(...args),
    beginGenerationRecallTransaction: (...args) =>
      generationRecallTransactionRuntime.beginGenerationRecallTransaction(...args),
    markGenerationRecallTransactionHookState: (...args) =>
      generationRecallTransactionRuntime.markGenerationRecallTransactionHookState(...args),
    shouldRunRecallForTransaction,
    createGenerationRecallContext: (...args) =>
      generationRecallTransactionRuntime.createGenerationRecallContext(...args),
    onGenerationStarted,
    onGenerationEnded,
    onGenerationAfterCommands,
    onBeforeCombinePrompts,
    applyFinalRecallInjectionForGeneration: (payload = {}) => {
      harness.applyFinalCalls.push({ ...payload });
      if (realApplyFinal) return originalApplyFinalRecallInjectionForGeneration(payload);
      return { source: "fresh", targetUserMessageIndex: null };
    },
    persistRecallInjectionRecord: (...args) =>
      finalRecallInjectionRuntime.persistRecallInjectionRecord(...args),
    ensurePersistedRecallRecordForGeneration: (...args) =>
      finalRecallInjectionRuntime.ensurePersistedRecallRecordForGeneration(...args),
    bindGenerationRecallTransactionToUserMessage: (...args) =>
      finalRecallInjectionRuntime.bindGenerationRecallTransactionToUserMessage(...args),
    reapplyPersistedRecallBlock: (...args) =>
      finalRecallInjectionRuntime.reapplyPersistedRecallBlock(...args),
    findRecentGenerationRecallTransactionForChat: (...args) =>
      generationRecallTransactionRuntime.findRecentGenerationRecallTransactionForChat(...args),
    getGenerationRecallTransactionResult: (...args) =>
      generationRecallTransactionRuntime.getGenerationRecallTransactionResult(...args),
    getGenerationRecallTransaction: () =>
      conversationSession.getRecallTransaction(),
    setGenerationRecallTransaction: (transaction) =>
      conversationSession.setRecallTransaction(transaction),
    clearGenerationRecallTransaction: () =>
      conversationSession.clearRecallTransaction(),
    getGenerationContext: () => conversationSession.getGeneration(),
    beginGeneration: (...args) => conversationSession.beginGeneration(...args),
    clearGeneration: (...args) => conversationSession.clearGeneration(...args),
    freezeHostGenerationInputSnapshot: (...args) =>
      recallInputState.freezeHostGenerationInputSnapshot(...args),
    consumeHostGenerationInputSnapshot: (...args) =>
      recallInputState.consumeHostGenerationInputSnapshot(...args),
    getPendingHostGenerationInputSnapshot: (...args) =>
      recallInputState.getPendingHostGenerationInputSnapshot(...args),
    clearPendingHostGenerationInputSnapshot: (...args) =>
      recallInputState.clearPendingHostGenerationInputSnapshot(...args),
    recordRecallSendIntent: (...args) =>
      recallInputState.recordRecallSendIntent(...args),
    clearPendingRecallSendIntent: (...args) =>
      recallInputState.clearPendingRecallSendIntent(...args),
    recordRecallSentUserMessage: (...args) =>
      recallInputState.recordRecallSentUserMessage(...args),
    getPendingRecallSendIntent: () =>
      readConversationInput("pendingRecallSendIntent"),
    getLastRecallSentUserMessage: () =>
      readConversationInput("lastRecallSentUserMessage"),
    getCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.getCurrentGenerationTrivialSkip(...args),
    markCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.markCurrentGenerationTrivialSkip(...args),
    clearCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.clearCurrentGenerationTrivialSkip(...args),
    consumeCurrentGenerationTrivialSkip: (...args) =>
      recallInputState.consumeCurrentGenerationTrivialSkip(...args),
    deferAutoExtraction: (...args) =>
      autoExtractionDeferRuntime.deferAutoExtraction(...args),
    maybeResumePendingAutoExtraction: (...args) =>
      autoExtractionDeferRuntime.maybeResumePendingAutoExtraction(...args),
    clearPendingAutoExtraction: (...args) =>
      autoExtractionDeferRuntime.clearPendingAutoExtraction(...args),
    getPendingAutoExtraction: (...args) =>
      autoExtractionDeferRuntime.getPendingAutoExtraction(...args),
    getIsHostGenerationRunning: () => isHostGenerationRunning,
    preparePlannerTurnHandoff: (...args) =>
      rerollRecallInput.preparePlannerTurnHandoff(...args),
    peekPlannerTurnHandoff: (...args) =>
      rerollRecallInput.peekPlannerTurnHandoff(...args),
    clearPlannerTurnHandoffsForChat,
    runPlannerRecallForEna: (args = {}) =>
      runPlannerRecallForEnaController(
        {
          buildRecallRecentMessages,
          buildRecallRetrieveOptions,
          captureConversationLease: (...args) =>
            conversationSession.captureLease(...args),
          clampInt,
          console,
          createAbortError,
          ensureVectorReadyIfNeeded,
          formatInjection,
          getContext,
          getCurrentGraph: () => harness.currentGraph,
          getEmbeddingConfig,
          getSchema,
          getSettings,
          isGraphMetadataWriteAllowed,
          isGraphReadableForRecall,
          isConversationLeaseCurrent: (...args) =>
            conversationSession.isLeaseCurrent(...args),
          isTrivialUserInput,
          normalizeRecallInputText,
          recoverHistoryIfNeeded,
          retrieve,
        },
        args,
      ),
    getGraphPersistenceState: () => graphPersistenceState,
    setGraphPersistenceState: (value = {}) => {
      graphPersistenceState = { ...graphPersistenceState, ...(value || {}) };
      return graphPersistenceState;
    },
  };

  Object.defineProperties(harness.result, {
    pendingRecallSendIntent: {
      get() {
        return readConversationInput("pendingRecallSendIntent");
      },
      set(value) {
        writeConversationInput(
          "pendingRecallSendIntent",
          value?.text
            ? { ...createRecallInputRecord(), ...value }
            : createRecallInputRecord(),
        );
      },
      configurable: true,
    },
    lastRecallSentUserMessage: {
      get() {
        return readConversationInput("lastRecallSentUserMessage");
      },
      set(value) {
        writeConversationInput(
          "lastRecallSentUserMessage",
          value?.text
            ? { ...createRecallInputRecord(), ...value }
            : createRecallInputRecord(),
        );
      },
      configurable: true,
    },
  });

  Object.defineProperties(harness, {
    pendingRecallSendIntent: {
      get() {
        return readConversationInput("pendingRecallSendIntent");
      },
      set(value) {
        writeConversationInput(
          "pendingRecallSendIntent",
          value?.text
            ? { ...createRecallInputRecord(), ...value }
            : createRecallInputRecord(),
        );
      },
      configurable: true,
    },
    lastRecallSentUserMessage: {
      get() {
        return readConversationInput("lastRecallSentUserMessage");
      },
      set(value) {
        writeConversationInput(
          "lastRecallSentUserMessage",
          value?.text
            ? { ...createRecallInputRecord(), ...value }
            : createRecallInputRecord(),
        );
      },
      configurable: true,
    },
    graphPersistenceState: {
      get() {
        return graphPersistenceState;
      },
      set(value) {
        graphPersistenceState = { ...graphPersistenceState, ...(value || {}) };
      },
      configurable: true,
    },
  });

  harness.recordRecallSentUserMessage = (...args) =>
    harness.result.recordRecallSentUserMessage(...args);
  harness.invokeOnMessageSent = (messageId = null) =>
    onMessageSentController(
      {
        getContext,
        isTrivialUserInput,
        recordRecallSentUserMessage: harness.result.recordRecallSentUserMessage,
        refreshPersistedRecallMessageUi: () => {
          harness.recallUiRefreshCalls += 1;
        },
      },
      messageId,
    );
  harness.invokeOnMessageReceived = (messageId = null, type = "") =>
    onMessageReceivedController(
      {
        console,
        consumeCurrentGenerationTrivialSkip:
          harness.result.consumeCurrentGenerationTrivialSkip,
        createRecallInputRecord,
        deferAutoExtraction: harness.result.deferAutoExtraction,
        getContext,
        getCurrentGraph: () => harness.currentGraph,
        getGraphPersistenceState: () => graphPersistenceState,
        getIsHostGenerationRunning: () => isHostGenerationRunning,
        getPendingHostGenerationInputSnapshot:
          harness.result.getPendingHostGenerationInputSnapshot,
        getPendingRecallSendIntent: () =>
          readConversationInput("pendingRecallSendIntent"),
        getLastProcessedAssistantFloor: () => -1,
        getSettings,
        isAssistantChatMessage,
        isFreshRecallInputRecord,
        isGraphMetadataWriteAllowed,
        syncGraphLoadFromLiveContext: () => {},
        maybeCaptureGraphShadowSnapshot: () => {},
        maybeFlushQueuedGraphPersist: () => {},
        notifyExtractionIssue: (message) => {
          harness.extractionIssues.push(String(message || ""));
        },
        queueMicrotask: (task) => task(),
        resolveAutoExtractionPlan: (options = {}) =>
          resolveAutoExtractionPlanController(
            {
              getAssistantTurns(chat = []) {
                return chat.flatMap((message, index) =>
                  !message?.is_user && !message?.is_system ? [index] : [],
                );
              },
              getLastProcessedAssistantFloor: () => -1,
              getSettings,
              getSmartTriggerDecision: () => ({
                triggered: false,
                score: 0,
                reasons: [],
              }),
            },
            options,
          ),
        runExtraction: harness.runExtraction,
        refreshPersistedRecallMessageUi: () => {
          harness.recallUiRefreshCalls += 1;
        },
        setPendingHostGenerationInputSnapshot: (record) => {
          writeConversationInput("pendingHostGenerationInputSnapshot", record);
        },
        setPendingRecallSendIntent: (record) => {
          writeConversationInput("pendingRecallSendIntent", record);
        },
      },
      messageId,
      type,
    );

  return harness;
}
