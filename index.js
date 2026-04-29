// ST-BME: 主入口
// 事件钩子、设置管理、流程调度

import {
  eventSource,
  event_types,
  extension_prompt_roles,
  extension_prompt_types,
  getRequestHeaders,
  saveMetadata,
  saveSettingsDebounced,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "../../../extensions.js";

import { BmeChatManager } from "./sync/bme-chat-manager.js";
import {
  BmeDatabase,
  buildBmeDbName,
  buildPersistDelta,
  buildPersistDeltaFromGraphDirtyState,
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
  evaluateNativeHydrateGate,
  evaluatePersistNativeDeltaGate,
  ensureDexieLoaded,
} from "./sync/bme-db.js";
import {
  BME_GRAPH_LOCAL_STORAGE_MODE_AUTO,
  BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW,
  deleteAllOpfsStorage,
  deleteOpfsChatStorage,
  OpfsGraphStore,
  detectOpfsSupport,
  isGraphLocalStorageModeOpfs,
  normalizeGraphLocalStorageMode,
} from "./sync/bme-opfs-store.js";
import {
  AUTHORITY_GRAPH_STORE_KIND,
  AUTHORITY_GRAPH_STORE_MODE,
  AuthorityGraphStore,
} from "./sync/authority-graph-store.js";
import {
  autoSyncOnChatChange,
  autoSyncOnVisibility,
  backupToServer,
  buildRestoreSafetyChatId,
  createRestoreSafetySnapshot,
  deleteRemoteSyncFile,
  deleteServerBackup,
  getRestoreSafetySnapshotStatus,
  listServerBackups,
  rollbackFromRestoreSafetySnapshot,
  restoreFromServer,
  scheduleUpload,
  syncNow,
} from "./sync/bme-sync.js";
import {
  buildExtractionMessages,
  clampRecoveryStartFloor,
  getAssistantTurns,
  isAssistantChatMessage,
  isSystemMessageForExtraction,
  pruneProcessedMessageHashesFromFloor,
  resolveDirtyFloorFromMutationMeta,
  rollbackAffectedJournals,
} from "./maintenance/chat-history.js";
import {
  compressAll,
  inspectAutoCompressionCandidates,
  sleepCycle,
} from "./maintenance/compressor.js";
import {
  analyzeAutoConsolidationGate,
  consolidateMemories,
} from "./maintenance/consolidator.js";
import {
  installSendIntentHooksController,
  onBeforeCombinePromptsController,
  onCharacterMessageRenderedController,
  onChatChangedController,
  onChatLoadedController,
  onGenerationAfterCommandsController,
  onGenerationStartedController,
  onMessageDeletedController,
  onMessageEditedController,
  onMessageUpdatedController,
  onMessageReceivedController,
  onMessageSentController,
  onMessageSwipedController,
  onUserMessageRenderedController,
  registerBeforeCombinePromptsController,
  registerCoreEventHooksController,
  registerGenerationAfterCommandsController,
  scheduleSendIntentHookRetryController,
} from "./host/event-binding.js";
import {
  BME_HOST_PROFILE_LUKER,
  getBmeHostAdapter,
  isBmeLightweightHostMode,
  normalizeBmeChatStateTarget,
  resolveBmeHostProfile,
  resolveChatStateTargetChatId,
  resolveCurrentBmeChatStateTarget,
  serializeBmeChatStateTarget,
} from "./host/runtime-host-adapter.js";
import {
  executeExtractionBatchController,
  onExtractionTaskController,
  onManualExtractController,
  onRerollController,
  resolveAutoExtractionPlanController,
  runExtractionController,
} from "./maintenance/extraction-controller.js";
import {
  DEFAULT_TRIGGER_KEYWORDS,
  getSmartTriggerDecision,
} from "./maintenance/smart-trigger.js";
import {
  debugDebug,
  debugLog,
} from "./runtime/debug-logging.js";
import {
  extractMemories,
  generateReflection,
} from "./maintenance/extractor.js";
import {
  generateSmallSummary,
  rebuildHierarchicalSummaryState,
  resetHierarchicalSummaryState,
  rollupSummaryFrontier,
  runHierarchicalSummaryPostProcess,
} from "./maintenance/hierarchical-summary.js";
import {
  createDefaultSummaryState,
  normalizeGraphSummaryState,
} from "./graph/summary-state.js";
import {
  appendLukerGraphJournalEntryV2,
  buildGraphCommitMarker,
  buildLukerGraphCheckpointV2,
  buildLukerGraphJournalEntry,
  buildLukerGraphJournalV2,
  buildLukerGraphManifestV2,
  canUseGraphChatState,
  deleteGraphChatStateNamespace,
  detectIndexedDbSnapshotCommitMarkerMismatch,
  findGraphShadowSnapshotByIntegrity,
  getAcceptedCommitMarkerRevision,
  GRAPH_CHAT_STATE_NAMESPACE,
  GRAPH_LOAD_PENDING_CHAT_ID,
  GRAPH_LOAD_STATES,
  GRAPH_COMMIT_MARKER_KEY,
  GRAPH_METADATA_KEY,
  GRAPH_STARTUP_RECONCILE_DELAYS_MS,
  LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  LUKER_GRAPH_JOURNAL_COMPACTION_BYTES,
  LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH,
  LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP,
  LUKER_GRAPH_JOURNAL_NAMESPACE,
  LUKER_GRAPH_MANIFEST_NAMESPACE,
  LUKER_PROJECTION_STATE_NAMESPACE,
  LUKER_DEBUG_STATE_NAMESPACE,
  LUKER_GRAPH_SIDECAR_V2_FORMAT,
  MODULE_NAME,
  cloneGraphForPersistence,
  cloneRuntimeDebugValue,
  getGraphPersistedRevision,
  getGraphPersistenceMeta,
  getGraphIdentityAliasCandidates,
  readGraphChatStateNamespaces,
  readGraphShadowSnapshot,
  removeGraphShadowSnapshot,
  rememberGraphIdentityAlias,
  readGraphCommitMarker,
  normalizeGraphCommitMarker,
  readGraphChatStateSnapshot,
  readLukerGraphSidecarV2,
  replaceLukerGraphJournalV2,
  resolveGraphIdentityAliasByHostChatId,
  shouldPreferShadowSnapshotOverOfficial,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphChatStatePayload,
  writeGraphChatStateSnapshot,
  writeLukerGraphCheckpointV2,
  writeLukerGraphManifestV2,
  writeGraphShadowSnapshot,
} from "./graph/graph-persistence.js";
import {
  applyHideSettings,
  getHideStateSnapshot,
  resetHideState,
  runIncrementalHideCheck,
  scheduleHideSettingsApply,
  unhideAll,
} from "./ui/hide-engine.js";
import {
  addEdge,
  addNode,
  createEmptyGraph,
  deserializeGraph,
  exportGraph,
  getGraphStats,
  getNode,
  importGraph,
  removeNode,
  updateNode,
} from "./graph/graph.js";
import {
  HOST_ADAPTER_STATE_SEMANTICS,
  getHostAdapter,
  getHostCapabilitySnapshot,
  initializeHostAdapter,
  readHostCapability,
  refreshHostCapabilitySnapshot,
} from "./host/adapter/index.js";
import { estimateTokens, formatInjection } from "./retrieval/injector.js";
import { fetchMemoryLLMModels, testLLMConnection } from "./llm/llm.js";
import { getNodeDisplayName } from "./graph/node-labels.js";
import { showManagedBmeNotice } from "./ui/notice.js";
import {
  createNoticePanelActionController,
  initializePanelBridgeController,
  refreshPanelLiveStateController,
} from "./ui/panel-bridge.js";
import {
  migrateLegacyTaskProfiles,
  migratePerTaskRegexToGlobal,
} from "./prompting/prompt-profiles.js";
import { inspectTaskRegexReuse } from "./prompting/task-regex.js";
import {
  applyRecallInjectionController,
  buildRecallRecentMessagesController,
  getRecallUserMessageSourceLabelController,
  resolveRecallInputController,
  runRecallController,
} from "./retrieval/recall-controller.js";
import {
  createRecallCardElement,
  openRecallSidebar,
  updateRecallCardData,
} from "./ui/recall-message-ui.js";
import {
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount,
  markPersistedRecallManualEdit,
  readPersistedRecallFromUserMessage,
  removePersistedRecallFromUserMessage,
  resolveFinalRecallInjectionSource,
  resolveGenerationTargetUserMessageIndex,
  writePersistedRecallToUserMessage,
} from "./retrieval/recall-persistence.js";
import { resolveConfiguredTimeoutMs } from "./runtime/request-timeout.js";
import {
  defaultSettings,
  getPersistedSettingsSnapshot,
  mergePersistedSettings,
} from "./runtime/settings-defaults.js";
import {
  createBackgroundMaintenanceQueue,
  resolveConcurrencyConfig,
} from "./runtime/concurrency.js";
import {
  createDefaultAuthorityCapabilityState,
  normalizeAuthoritySettings,
  normalizeAuthorityCapabilityState,
  probeAuthorityCapabilities,
} from "./runtime/authority-capabilities.js";
import {
  createAuthorityBrowserState,
  getAuthorityBrowserStateSnapshot,
  normalizeAuthorityBrowserState,
  recordAuthorityAcceptedRevision,
} from "./sync/authority-browser-state.js";
import { retrieve } from "./retrieval/retriever.js";
import {
  applyProcessedHistorySnapshotToGraph,
  appendBatchJournal,
  appendMaintenanceJournal,
  buildRecoveryResult,
  buildReverseJournalRecoveryPlan,
  clearHistoryDirty,
  cloneGraphSnapshot,
  createBatchJournalEntry,
  createMaintenanceJournalEntry,
  detectHistoryMutation,
  findJournalRecoveryPoint,
  hasGraphPersistDirtyState,
  markHistoryDirty,
  normalizeGraphRuntimeState,
  pruneGraphPersistDirtyState,
  PROCESSED_MESSAGE_HASH_VERSION,
  rebindProcessedHistoryStateToChat,
  snapshotProcessedMessageHashes,
  undoLatestMaintenance,
  buildVectorCollectionId,
} from "./runtime/runtime-state.js";
import { DEFAULT_NODE_SCHEMA, validateSchema } from "./graph/schema.js";
import {
  applyManualKnowledgeOverride,
  clearManualKnowledgeOverride,
  deleteKnowledgeOwner,
  mergeKnowledgeOwners,
  renameKnowledgeOwner,
  setManualActiveRegion,
  updateRegionAdjacencyManual,
} from "./graph/knowledge-state.js";
import {
  clearManualActiveStorySegment,
  setManualActiveStorySegment,
} from "./graph/story-timeline.js";
import {
  onExportGraphController,
  onFetchEmbeddingModelsController,
  onFetchMemoryLLMModelsController,
  onImportGraphController,
  onManualCompressController,
  onManualEvolveController,
  onManualSummaryRollupController,
  onManualSleepController,
  onManualSynopsisController,
  onRebuildSummaryStateController,
  onClearSummaryStateController,
  onUndoLastMaintenanceController,
  onRebuildController,
  onRebuildVectorIndexController,
  onReembedDirectController,
  onTestEmbeddingController,
  onTestMemoryLLMController,
  onViewGraphController,
  onViewLastInjectionController,
  onClearGraphController,
  onClearGraphRangeController,
  onClearVectorCacheController,
  onClearBatchJournalController,
  onDeleteCurrentIdbController,
  onDeleteAllIdbController,
  onExportDiagnosticsBundleController,
  onDeleteServerSyncFileController,
} from "./ui/ui-actions-controller.js";
import {
  clampInt,
  createBatchStatusSkeleton,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  finalizeBatchStatus,
  formatRecallContextLine,
  getGenerationRecallHookStateFromResult,
  getRecallHookLabel,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  isTrivialUserInput,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
  pushBatchStageArtifact,
  setBatchStageOutcome,
  shouldRunRecallForTransaction,
} from "./ui/ui-status.js";
import {
  deleteBackendVectorHashesForRecovery,
  fetchAvailableEmbeddingModels,
  getVectorConfigFromSettings,
  getVectorIndexStats,
  getVectorModelScope,
  isAuthorityVectorConfig,
  isBackendVectorConfig,
  isDirectVectorConfig,
  normalizeAuthorityVectorConfig,
  syncGraphVectorIndex,
  testVectorConnection,
  validateVectorConfig,
} from "./vector/vector-index.js";
import { createAuthorityTriviumClient } from "./vector/authority-vector-primary-adapter.js";
import {
  buildAuthorityJobIdempotencyKey,
  createAuthorityJobAdapter,
  mergeAuthorityRecentJobs,
  normalizeAuthorityJobConfig,
} from "./maintenance/authority-job-adapter.js";
import { trackAuthorityJobUntilTerminal } from "./maintenance/authority-job-tracker.js";
import {
  applyAuthorityCheckpointToStore,
  buildAuthorityConsistencyRepairPlan,
  buildAuthorityConsistencyAudit,
} from "./maintenance/authority-consistency.js";
import {
  createAuthorityBlobAdapter,
  normalizeAuthorityBlobConfig,
} from "./maintenance/authority-blob-adapter.js";
import {
  AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
  buildAuthorityDiagnosticsBundle,
  buildAuthorityDiagnosticsBundlePath,
  buildAuthorityDiagnosticsManifestPath,
  buildAuthorityPerformanceBaseline,
  buildAuthorityPerformanceBaselineComparison,
  readAuthorityDiagnosticsManifest,
  removeAuthorityDiagnosticsManifestEntry,
  upsertAuthorityDiagnosticsManifestEntry,
  writeAuthorityDiagnosticsBundle as writeAuthorityDiagnosticsBundleFile,
} from "./maintenance/authority-diagnostics-bundle.js";

export { DEFAULT_TRIGGER_KEYWORDS, getSmartTriggerDecision };

// 操控面板模块（动态加载，防止加载失败崩溃整个扩展）
let _panelModule = null;
let _themesModule = null;

const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";
const SERVER_SETTINGS_URL = `/user/files/${SERVER_SETTINGS_FILENAME}`;

function normalizeChatIdCandidate(value = "") {
  return String(value ?? "").trim();
}

function getActiveBmeHostAdapter(context = getContext()) {
  if (typeof getBmeHostAdapter === "function") {
    return getBmeHostAdapter(context);
  }
  return {
    hostProfile: resolvePersistenceHostProfile(context),
    resolveCurrentTarget() {
      return resolveCurrentChatStateTarget(context);
    },
    isLightweightHostMode() {
      return false;
    },
  };
}

function resolveCurrentChatStateTarget(
  context = getContext(),
  explicitTarget = null,
) {
  if (
    typeof normalizeBmeChatStateTarget === "function" &&
    typeof resolveCurrentBmeChatStateTarget === "function"
  ) {
    return normalizeBmeChatStateTarget(
      resolveCurrentBmeChatStateTarget(context, explicitTarget),
    );
  }
  if (explicitTarget && typeof explicitTarget === "object") {
    return explicitTarget;
  }
  const activeContext =
    context && typeof context === "object" ? context : getContext();
  const chatId = normalizeChatIdCandidate(
    activeContext?.chatId ||
      (typeof activeContext?.getCurrentChatId === "function"
        ? activeContext.getCurrentChatId()
        : ""),
  );
  if (activeContext?.groupId != null && String(activeContext.groupId || "").trim()) {
    return chatId ? { is_group: true, id: chatId } : null;
  }
  return null;
}

function syncBmeHostRuntimeFlags(context = getContext()) {
  const adapter = getActiveBmeHostAdapter(context);
  const target = adapter.resolveCurrentTarget();
  const lightweightHostMode =
    typeof adapter.isLightweightHostMode === "function"
      ? adapter.isLightweightHostMode()
      : false;
  globalThis.__stBmeLightweightHostMode = lightweightHostMode === true;
  return {
    adapter,
    target,
    lightweightHostMode,
  };
}

function readGlobalCurrentChatId() {
  try {
    return normalizeChatIdCandidate(
      globalThis.SillyTavern?.getCurrentChatId?.() ||
        globalThis.getCurrentChatId?.() ||
        "",
    );
  } catch {
    return "";
  }
}

function hasLikelySelectedChatContext(context = getContext()) {
  if (!context || typeof context !== "object") {
    return false;
  }

  const hasMeaningfulChatMetadata =
    context.chatMetadata &&
    typeof context.chatMetadata === "object" &&
    !Array.isArray(context.chatMetadata) &&
    Object.keys(context.chatMetadata).length > 0;
  const hasChatMessages =
    Array.isArray(context.chat) && context.chat.length > 0;
  const hasCharacterId =
    context.characterId !== undefined &&
    context.characterId !== null &&
    String(context.characterId).trim() !== "";
  const hasGroupId =
    context.groupId !== undefined &&
    context.groupId !== null &&
    String(context.groupId).trim() !== "";

  return (
    hasMeaningfulChatMetadata || hasChatMessages || hasCharacterId || hasGroupId
  );
}

function getChatMetadataIntegrity(context = getContext()) {
  return normalizeChatIdCandidate(context?.chatMetadata?.integrity);
}

function getChatCommitMarker(context = getContext()) {
  return readGraphCommitMarker(context);
}

function resolveCurrentHostChatId(context = getContext()) {
  const candidates = [
    context?.chatId,
    context?.getCurrentChatId?.(),
    readGlobalCurrentChatId(),
    context?.chatMetadata?.chat_id,
    context?.chatMetadata?.chatId,
    context?.chatMetadata?.session_id,
    context?.chatMetadata?.sessionId,
  ];

  return (
    candidates
      .map((candidate) => normalizeChatIdCandidate(candidate))
      .find(Boolean) || ""
  );
}

function resolveCurrentChatIdentity(context = getContext()) {
  const hostChatId = resolveCurrentHostChatId(context);
  const integrity =
    typeof getChatMetadataIntegrity === "function"
      ? getChatMetadataIntegrity(context)
      : normalizeChatIdCandidate(
          context?.chatMetadata?.integrity ||
            context?.chatMetadata?.chat_id ||
            context?.chatMetadata?.chatId ||
            "",
        );
  const aliasedChatId =
    !integrity &&
    hostChatId &&
    typeof resolveGraphIdentityAliasByHostChatId === "function"
      ? resolveGraphIdentityAliasByHostChatId(hostChatId)
      : "";
  const chatId = integrity || aliasedChatId || hostChatId;

  return {
    chatId,
    hostChatId,
    integrity,
    identitySource: integrity
      ? "integrity"
      : aliasedChatId
        ? "alias"
        : hostChatId
          ? "host-chat-id"
          : "",
    hasLikelySelectedChat: hasLikelySelectedChatContext(context),
  };
}

function getCurrentChatId(context = getContext()) {
  return resolveCurrentChatIdentity(context).chatId;
}

function resolvePersistenceChatId(
  context = getContext(),
  graph = currentGraph,
  explicitChatId = "",
) {
  const directChatId = normalizeChatIdCandidate(explicitChatId);
  if (directChatId) return directChatId;

  const resolvedIdentity = resolveCurrentChatIdentity(context);
  const resolvedChatId = normalizeChatIdCandidate(resolvedIdentity.chatId);
  if (resolvedChatId) return resolvedChatId;

  const graphMeta = getGraphPersistenceMeta(graph) || {};
  const fallbackCandidates = [
    graph?.historyState?.chatId,
    graphMeta.chatId,
    currentGraph?.historyState?.chatId,
    getGraphPersistenceMeta(currentGraph)?.chatId,
    graphPersistenceState.chatId,
    graphPersistenceState.queuedPersistChatId,
    graphPersistenceState.commitMarker?.chatId,
    context?.chatMetadata?.integrity,
    context?.chatMetadata?.chat_id,
    context?.chatMetadata?.chatId,
    context?.chatMetadata?.session_id,
    context?.chatMetadata?.sessionId,
  ];

  return (
    fallbackCandidates
      .map((candidate) => normalizeChatIdCandidate(candidate))
      .find(Boolean) || ""
  );
}

function rememberResolvedGraphIdentityAlias(
  context = getContext(),
  persistenceChatId = getCurrentChatId(context),
) {
  const identity = resolveCurrentChatIdentity(context);
  if (!identity.integrity || !persistenceChatId) {
    return null;
  }

  return rememberGraphIdentityAlias({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId,
  });
}

function doesChatIdMatchResolvedGraphIdentity(
  candidateChatId,
  identity = resolveCurrentChatIdentity(getContext()),
) {
  const normalizedCandidate = normalizeChatIdCandidate(candidateChatId);
  if (!normalizedCandidate || !identity || typeof identity !== "object") {
    return false;
  }

  const knownChatIds = new Set();
  const addKnownChatId = (value) => {
    const normalized = normalizeChatIdCandidate(value);
    if (normalized) {
      knownChatIds.add(normalized);
    }
  };

  addKnownChatId(identity.chatId);
  addKnownChatId(identity.hostChatId);
  addKnownChatId(identity.integrity);

  for (const aliasCandidate of getGraphIdentityAliasCandidates({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId: identity.chatId,
  })) {
    addKnownChatId(aliasCandidate);
  }

  return knownChatIds.has(normalizedCandidate);
}

function areChatIdsEquivalentForResolvedIdentity(
  candidateChatId,
  referenceChatId,
  identity = resolveCurrentChatIdentity(getContext()),
) {
  const normalizedCandidate = normalizeChatIdCandidate(candidateChatId);
  const normalizedReference = normalizeChatIdCandidate(referenceChatId);
  if (!normalizedCandidate || !normalizedReference) {
    return normalizedCandidate === normalizedReference;
  }
  if (normalizedCandidate === normalizedReference) {
    return true;
  }
  return (
    doesChatIdMatchResolvedGraphIdentity(normalizedCandidate, identity) &&
    doesChatIdMatchResolvedGraphIdentity(normalizedReference, identity)
  );
}

function syncCommitMarkerToPersistenceState(context = getContext()) {
  const marker = getChatCommitMarker(context);
  updateGraphPersistenceState({
    commitMarker: cloneRuntimeDebugValue(marker, null),
  });
  return marker;
}

function clearCurrentChatCommitMarker(
  {
    context = getContext(),
    reason = "manual-clear-commit-marker",
    immediate = true,
    resetAcceptedRevision = false,
  } = {},
) {
  if (!context) {
    return {
      cleared: false,
      reason: "missing-context",
      saveMode: "",
      marker: null,
    };
  }

  const marker = getChatCommitMarker(context);
  const acceptedRevision = getAcceptedCommitMarkerRevision(marker);
  writeChatMetadataPatch(context, {
    [GRAPH_COMMIT_MARKER_KEY]: null,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });
  const shouldResetAcceptedRevision = resetAcceptedRevision === true;
  updateGraphPersistenceState({
    commitMarker: null,
    persistMismatchReason: "",
    lastPersistReason: String(reason || "manual-clear-commit-marker"),
    lastPersistMode: `commit-marker-clear:${saveMode}`,
    acceptedStorageTier: shouldResetAcceptedRevision
      ? "none"
      : String(graphPersistenceState.acceptedStorageTier || "none"),
    lastAcceptedRevision: shouldResetAcceptedRevision
      ? 0
      : Number(graphPersistenceState.lastAcceptedRevision || 0),
  });

  return {
    cleared: Boolean(marker),
    reason: String(reason || "manual-clear-commit-marker"),
    saveMode,
    marker: cloneRuntimeDebugValue(marker, null),
    acceptedRevision,
  };
}

function clearCurrentChatMetadataGraphFallback(
  {
    context = getContext(),
    reason = "manual-clear-graph-metadata-fallback",
    immediate = true,
    clearPendingPersist = false,
  } = {},
) {
  if (!context) {
    return {
      cleared: false,
      reason: "missing-context",
      saveMode: "",
    };
  }

  const hadGraphMetadata =
    context?.chatMetadata &&
    Object.prototype.hasOwnProperty.call(context.chatMetadata, GRAPH_METADATA_KEY) &&
    context.chatMetadata[GRAPH_METADATA_KEY] != null;
  writeChatMetadataPatch(context, {
    [GRAPH_METADATA_KEY]: null,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });
  updateGraphPersistenceState({
    persistMismatchReason: "",
    lastPersistReason: String(
      reason || "manual-clear-graph-metadata-fallback",
    ),
    lastPersistMode: `metadata-full-clear:${saveMode}`,
    lastRecoverableStorageTier:
      graphPersistenceState.lastRecoverableStorageTier === "metadata-full"
        ? "none"
        : graphPersistenceState.lastRecoverableStorageTier,
    pendingPersist:
      clearPendingPersist === true ? false : graphPersistenceState.pendingPersist,
    writesBlocked:
      clearPendingPersist === true ? false : graphPersistenceState.writesBlocked,
    queuedPersistRevision:
      clearPendingPersist === true ? 0 : graphPersistenceState.queuedPersistRevision,
    queuedPersistChatId:
      clearPendingPersist === true ? "" : graphPersistenceState.queuedPersistChatId,
    queuedPersistMode:
      clearPendingPersist === true ? "" : graphPersistenceState.queuedPersistMode,
    queuedPersistRotateIntegrity:
      clearPendingPersist === true
        ? false
        : graphPersistenceState.queuedPersistRotateIntegrity,
    queuedPersistReason:
      clearPendingPersist === true ? "" : graphPersistenceState.queuedPersistReason,
  });
  if (clearPendingPersist === true) {
    clearPendingGraphPersistRetry();
  }

  return {
    cleared: hadGraphMetadata,
    reason: String(reason || "manual-clear-graph-metadata-fallback"),
    saveMode,
  };
}

function clearCurrentChatRecoveryAnchors(
  {
    context = getContext(),
    chatId = getCurrentChatId(context),
    reason = "manual-clear-recovery-anchors",
    immediate = true,
    clearMetadataFull = true,
    clearCommitMarker = true,
    clearPendingPersist = true,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const shadowCleared = normalizedChatId
    ? removeGraphShadowSnapshot(normalizedChatId)
    : false;
  const metadataResult = clearMetadataFull
    ? clearCurrentChatMetadataGraphFallback({
        context,
        reason: `${reason}:metadata-full`,
        immediate,
        clearPendingPersist,
      })
    : {
        cleared: false,
        reason: "metadata-full-retained",
        saveMode: "",
      };
  const markerResult = clearCommitMarker
    ? clearCurrentChatCommitMarker({
        context,
        reason: `${reason}:commit-marker`,
        immediate,
        resetAcceptedRevision: clearPendingPersist === true,
      })
    : {
        cleared: false,
        reason: "commit-marker-retained",
        saveMode: "",
        marker: null,
      };

  updateGraphPersistenceState({
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    lastRecoverableStorageTier:
      shadowCleared || metadataResult?.cleared ? "none" : graphPersistenceState.lastRecoverableStorageTier,
    pendingPersist:
      clearPendingPersist === true ? false : graphPersistenceState.pendingPersist,
    writesBlocked:
      clearPendingPersist === true ? false : graphPersistenceState.writesBlocked,
    queuedPersistRevision:
      clearPendingPersist === true ? 0 : graphPersistenceState.queuedPersistRevision,
    queuedPersistChatId:
      clearPendingPersist === true ? "" : graphPersistenceState.queuedPersistChatId,
    queuedPersistMode:
      clearPendingPersist === true ? "" : graphPersistenceState.queuedPersistMode,
    queuedPersistRotateIntegrity:
      clearPendingPersist === true
        ? false
        : graphPersistenceState.queuedPersistRotateIntegrity,
    queuedPersistReason:
      clearPendingPersist === true ? "" : graphPersistenceState.queuedPersistReason,
  });
  if (clearPendingPersist === true) {
    clearPendingGraphPersistRetry();
  }

  return {
    chatId: normalizedChatId,
    shadowCleared,
    metadataCleared: metadataResult?.cleared === true,
    markerCleared: markerResult?.cleared === true,
    metadataResult,
    markerResult,
  };
}

function isAcceptedPersistTier(storageTier = "none") {
  const normalizedTier = String(storageTier || "none").trim().toLowerCase();
  return normalizedTier === "indexeddb" || normalizedTier === "chat-state";
}

function isRecoveryOnlyPersistTier(storageTier = "none") {
  const normalizedTier = String(storageTier || "none").trim().toLowerCase();
  return normalizedTier === "shadow" || normalizedTier === "metadata-full";
}

function resolvePersistRevisionFloor(
  requestedRevision = 0,
  graph = currentGraph,
) {
  return Math.max(
    normalizeIndexedDbRevision(requestedRevision),
    normalizeIndexedDbRevision(graphPersistenceState.revision),
    normalizeIndexedDbRevision(graphPersistenceState.lastPersistedRevision),
    normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
    normalizeIndexedDbRevision(graph ? getGraphPersistedRevision(graph) : 0),
  );
}

function allocateRequestedPersistRevision(
  requestedRevision = 0,
  graph = currentGraph,
) {
  return Math.max(1, resolvePersistRevisionFloor(requestedRevision, graph) + 1);
}

function normalizeRestoreLockState(lock = null) {
  const source = String(lock?.source || "").trim();
  const reason = String(lock?.reason || "").trim();
  const startedAt = Number(lock?.startedAt);
  const depth = Math.max(0, Math.floor(Number(lock?.depth) || 0));
  const active = lock?.active === true || depth > 0;
  return {
    active,
    depth: active ? Math.max(1, depth || 1) : 0,
    source,
    reason,
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
  };
}

function isRestoreLockActive() {
  return normalizeRestoreLockState(graphPersistenceState.restoreLock).active;
}

function getRestoreLockMessage(operationLabel = "当前操作") {
  const lock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  if (!lock.active) return "";
  const details = [lock.reason, lock.source].filter(Boolean).join(" / ");
  return `${operationLabel}已暂停：当前处于恢复锁${details ? `（${details}）` : ""}`;
}

function enterRestoreLock(source = "runtime", reason = "") {
  const currentLock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  const nextLock = {
    active: true,
    depth: currentLock.depth + 1,
    source: String(source || currentLock.source || "runtime"),
    reason: String(reason || currentLock.reason || ""),
    startedAt: currentLock.startedAt || Date.now(),
  };
  updateGraphPersistenceState({
    restoreLock: nextLock,
  });
  return cloneRuntimeDebugValue(nextLock, nextLock);
}

function leaveRestoreLock(source = "runtime") {
  const currentLock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  if (!currentLock.active) {
    return currentLock;
  }
  const nextDepth = Math.max(0, currentLock.depth - 1);
  const nextLock =
    nextDepth > 0
      ? {
          ...currentLock,
          depth: nextDepth,
          source: String(source || currentLock.source || ""),
        }
      : {
          active: false,
          depth: 0,
          source: "",
          reason: "",
          startedAt: 0,
        };
  updateGraphPersistenceState({
    restoreLock: nextLock,
  });
  return cloneRuntimeDebugValue(nextLock, nextLock);
}

async function runWithRestoreLock(source, reason, task) {
  enterRestoreLock(source, reason);
  try {
    return await task();
  } finally {
    leaveRestoreLock(source);
  }
}

function recordPersistMismatchDiagnostic(
  mismatch = null,
  { source = "persist-mismatch", resolvedBy = "" } = {},
) {
  const normalizedReason = String(mismatch?.reason || "").trim();
  const marker = cloneRuntimeDebugValue(mismatch?.marker, null) || getChatCommitMarker();
  updateGraphPersistenceState({
    persistMismatchReason: normalizedReason,
    commitMarker: marker,
    dualWriteLastResult: {
      action: "load",
      source: String(source || "persist-mismatch"),
      success: false,
      diagnostic: true,
      reason: normalizedReason,
      markerRevision: Number(mismatch?.markerRevision || 0),
      snapshotRevision: Number(mismatch?.snapshotRevision || 0),
      resolvedBy: String(resolvedBy || ""),
      at: Date.now(),
    },
  });
  return {
    reason: normalizedReason,
    marker,
  };
}

function persistGraphCommitMarker(
  context = getContext(),
  {
    reason = "graph-commit-marker",
    revision = graphPersistenceState.revision,
    storageTier = "none",
    accepted = false,
    lastProcessedAssistantFloor = null,
    extractionCount: nextExtractionCount = null,
    immediate = true,
  } = {},
) {
  if (!context) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-context",
      revision,
      storageTier,
    });
  }

  const chatId = getCurrentChatId(context);
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-chat-id",
      revision,
      storageTier,
    });
  }

  const marker = buildGraphCommitMarker(currentGraph, {
    revision,
    storageTier,
    accepted,
    reason,
    chatId,
    integrity: getChatMetadataIntegrity(context),
    lastProcessedAssistantFloor,
    extractionCount: nextExtractionCount,
  });
  if (!marker) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "marker-build-failed",
      revision,
      storageTier,
    });
  }

  writeChatMetadataPatch(context, {
    [GRAPH_COMMIT_MARKER_KEY]: marker,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });
  updateGraphPersistenceState({
    commitMarker: cloneRuntimeDebugValue(marker, null),
    lastPersistReason: String(reason || ""),
    lastPersistMode: `commit-marker:${saveMode}`,
  });
  return buildGraphPersistResult({
    saved: true,
    blocked: false,
    accepted,
    reason,
    revision: Number(marker.revision || revision || 0),
    saveMode,
    storageTier,
  });
}

function applyPersistMismatchBlockedState(
  chatId,
  mismatch = null,
  { source = "persist-mismatch", attemptIndex = 0, resolvedBy = "" } = {},
) {
  const marker = cloneRuntimeDebugValue(mismatch?.marker, null) || getChatCommitMarker();
  const markerRevision = Number(mismatch?.markerRevision || 0);
  const snapshotRevision = Number(mismatch?.snapshotRevision || 0);
  const diagnostic = recordPersistMismatchDiagnostic(
    {
      ...(mismatch || {}),
      marker,
    },
    {
      source,
      resolvedBy,
    },
  );
  refreshPanelLiveState();
  return {
    success: false,
    loaded: false,
    loadState: graphPersistenceState.loadState,
    reason:
      diagnostic.reason ||
      String(
        mismatch?.reason ||
          "persist-mismatch:indexeddb-behind-commit-marker",
      ),
    chatId,
    attemptIndex,
    markerRevision,
    snapshotRevision,
    diagnosticOnly: true,
  };
}

function triggerChatMetadataSave(
  context = getContext(),
  { immediate = false } = {},
) {
  if (immediate) {
    const immediateSave =
      typeof context?.saveMetadata === "function"
        ? context.saveMetadata
        : saveMetadata;
    if (typeof immediateSave === "function") {
      try {
        const result = immediateSave.call(context);
        if (result && typeof result.catch === "function") {
          result.catch((error) => {
            console.error("[ST-BME] 立即保存聊天元数据失败:", error);
          });
        }
        return "immediate";
      } catch (error) {
        console.error("[ST-BME] 触发立即保存聊天元数据失败:", error);
      }
    }
  }

  if (typeof context?.saveMetadataDebounced === "function") {
    context.saveMetadataDebounced();
    return "debounced";
  }
  saveMetadataDebounced();
  return "debounced";
}

function getRuntimeDebugState() {
  const stateKey = "__stBmeRuntimeDebugState";
  if (!globalThis[stateKey] || typeof globalThis[stateKey] !== "object") {
    globalThis[stateKey] = {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      taskTimeline: [],
      messageTrace: {
        lastSentUserMessage: null,
      },
      maintenance: {
        lastAction: null,
        lastUndoResult: null,
      },
      graphPersistence: null,
      graphLayout: null,
      updatedAt: "",
    };
  }
  return globalThis[stateKey];
}

function touchRuntimeDebugState() {
  const state = getRuntimeDebugState();
  state.updatedAt = new Date().toISOString();
  return state;
}

function recordHostCapabilitySnapshot(snapshot = null) {
  const state = touchRuntimeDebugState();
  state.hostCapabilities = cloneRuntimeDebugValue(snapshot, null);
}

function recordInjectionSnapshot(kind, snapshot = {}) {
  const normalizedKind = String(kind || "").trim() || "default";
  const state = touchRuntimeDebugState();
  state.injections[normalizedKind] = {
    updatedAt: new Date().toISOString(),
    ...cloneRuntimeDebugValue(snapshot, {}),
  };
}

function recordMessageTraceSnapshot(patch = {}) {
  const state = touchRuntimeDebugState();
  const previous = state.messageTrace || {
    lastSentUserMessage: null,
  };
  state.messageTrace = {
    ...previous,
    ...cloneRuntimeDebugValue(patch, {}),
  };
}

function recordGraphPersistenceSnapshot(snapshot = null) {
  const state = touchRuntimeDebugState();
  state.graphPersistence = cloneRuntimeDebugValue(snapshot, null);
}

function recordMaintenanceDebugSnapshot(patch = {}) {
  const state = touchRuntimeDebugState();
  const previous = state.maintenance || {
    lastAction: null,
    lastUndoResult: null,
  };
  state.maintenance = {
    ...previous,
    ...cloneRuntimeDebugValue(patch, {}),
  };
}

function readRuntimeDebugSnapshot() {
  const state = getRuntimeDebugState();
  return cloneRuntimeDebugValue(
    {
      hostCapabilities: state.hostCapabilities,
      taskPromptBuilds: state.taskPromptBuilds,
      taskLlmRequests: state.taskLlmRequests,
      injections: state.injections,
      taskTimeline: state.taskTimeline,
      messageTrace: state.messageTrace,
      maintenance: state.maintenance,
      graphPersistence: state.graphPersistence,
      graphLayout: state.graphLayout,
      updatedAt: state.updatedAt,
    },
    {
      hostCapabilities: null,
      taskPromptBuilds: {},
      taskLlmRequests: {},
      injections: {},
      taskTimeline: [],
      messageTrace: {
        lastSentUserMessage: null,
      },
      maintenance: {
        lastAction: null,
        lastUndoResult: null,
      },
      graphPersistence: null,
      graphLayout: null,
      updatedAt: "",
    },
  );
}

// ==================== 状态 ====================

let currentGraph = null;
let isExtracting = false;
let isRecalling = false;
let activeRecallPromise = null;
let recallRunSequence = 0;
let nativePersistDeltaInstallPromise = null;
let nativeHydrateInstallPromise = null;
let lastInjectionContent = "";
let lastExtractedItems = []; // 最近提取的节点（面板展示用）
let lastRecalledItems = []; // 最近召回的节点（面板展示用）
let extractionCount = 0; // v2: 提取次数计数器（定期触发概要/遗忘/反思）
let serverSettingsSaveTimer = null;
let isRecoveringHistory = false;
let lastRecallFallbackNoticeAt = 0;
let lastExtractionWarningAt = 0;
const LOCAL_VECTOR_TIMEOUT_MS = 300000;
const EXTRACTION_VECTOR_SYNC_TIMEOUT_MS = 300000;
const STATUS_TOAST_THROTTLE_MS = 1500;
const RECALL_INPUT_RECORD_TTL_MS = 60000;
const TRIVIAL_GENERATION_SKIP_TTL_MS = 60000;
const HISTORY_RECOVERY_SETTLE_MS = 80;
const HISTORY_MUTATION_RETRY_DELAYS_MS = [80, 220, 500, 900];
const GRAPH_LOAD_RETRY_DELAYS_MS = [120, 450, 1200, 2500];
const AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS = [120, 320, 800, 1600, 2800];
const AUTO_EXTRACTION_HOST_SETTLE_MS = 120;
const AUTHORITY_RECENT_JOBS_LIMIT = 8;
let runtimeStatus = createUiStatus("待命", "准备就绪", "idle");
let lastExtractionStatus = createUiStatus("待命", "尚未执行提取", "idle");
let lastVectorStatus = createUiStatus("待命", "尚未执行向量任务", "idle");
let lastRecallStatus = createUiStatus("待命", "尚未执行召回", "idle");
let graphPersistenceState = createGraphPersistenceState();
let authorityCapabilityState = createDefaultAuthorityCapabilityState();
let authorityBrowserState = createAuthorityBrowserState();
let authorityProbePromise = null;
const backgroundMaintenanceQueue =
  typeof createBackgroundMaintenanceQueue === "function"
    ? createBackgroundMaintenanceQueue()
    : null;
const lastStatusToastAt = {};
let pendingRecallSendIntent = createRecallInputRecord();
let lastRecallSentUserMessage = createRecallInputRecord();
let pendingHostGenerationInputSnapshot = createRecallInputRecord();
let currentGenerationTrivialSkip = null;
let coreEventBindingState = {
  registered: false,
  cleanups: [],
  registeredAt: 0,
};
let sendIntentHookCleanup = [];
let sendIntentHookRetryTimer = null;
let pendingHistoryRecoveryTimer = null;
let pendingHistoryRecoveryTrigger = "";
let pendingHistoryMutationCheckTimers = [];
let pendingGraphLoadRetryTimer = null;
let pendingGraphLoadRetryChatId = "";
let pendingGraphPersistRetryTimer = null;
let pendingGraphPersistRetryChatId = "";
let pendingGraphPersistRetryAttempt = 0;
let pendingAutoExtractionTimer = null;
let authorityJobPollAbortController = null;
let authorityJobPollJobId = "";
let authorityJobPollChatId = "";
let authorityJobPollPromise = null;
let pendingAutoExtraction = {
  chatId: "",
  messageId: null,
  reason: "",
  requestedAt: 0,
  attempts: 0,
  targetEndFloor: null,
  strategy: "normal",
};
let isHostGenerationRunning = false;
let lastHostGenerationEndedAt = 0;
let skipBeforeCombineRecallUntil = 0;
let mvuExtraAnalysisGuardUntil = 0;
let lastPreGenerationRecallKey = "";
let lastPreGenerationRecallAt = 0;
const generationRecallTransactions = new Map();
const plannerRecallHandoffs = new Map();
let persistedRecallUiRefreshTimer = null;
let persistedRecallUiRefreshObserver = null;
let persistedRecallUiRefreshSession = 0;
const PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS = [
  0,
  80,
  180,
  320,
  500,
  850,
  1300,
  2000,
  3000,
  4200,
];
const PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS = 1500;
const persistedRecallUiDiagnosticTimestamps = new Map();
const persistedRecallPersistDiagnosticTimestamps = new Map();
const GENERATION_RECALL_TRANSACTION_TTL_MS = 15000;
const PLANNER_RECALL_HANDOFF_TTL_MS = GENERATION_RECALL_TRANSACTION_TTL_MS;
const GENERATION_RECALL_HOOK_BRIDGE_MS = 1200;
const MVU_EXTRA_ANALYSIS_GUARD_TTL_MS = 2500;
const stageNoticeHandles = {
  extraction: null,
  vector: null,
  recall: null,
  history: null,
};
const stageAbortControllers = {
  extraction: null,
  vector: null,
  recall: null,
  history: null,
};
let bmeChatManager = null;
let bmeChatManagerUnavailableWarned = false;
let bmeLocalStoreCapabilityPromise = null;
let bmeLocalStoreCapabilitySnapshot = {
  checked: false,
  checkedAt: 0,
  opfsAvailable: false,
  reason: "unprobed",
};
let bmeLocalStoreCapabilityWarningShown = false;
const BME_LOCAL_STORE_CAPABILITY_FAILURE_RETRY_MS = 4000;
const bmeIndexedDbSnapshotCacheByChatId = new Map();
const bmeIndexedDbLoadInFlightByChatId = new Map();
const bmeIndexedDbWriteInFlightByChatId = new Map();
const bmeIndexedDbRuntimeRepairInFlightByChatId = new Set();
const bmeIndexedDbLegacyMigrationInFlightByChatId = new Map();
const bmeIndexedDbLocalStoreMigrationInFlightByChatId = new Map();
const bmeIndexedDbOpfsMigrationInFlightByChatId = new Map();
const bmeIndexedDbLatestQueuedRevisionByChatId = new Map();
const bmeChatStateManifestCacheByChatId = new Map();
const bmeChatStateLoadInFlightByChatId = new Map();
const bmeLukerSidecarCompactionByChatId = new Map();
const bmeLukerSidecarWriteByChatId = new Map();
const PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS = [500, 1500, 5000];
const PENDING_GRAPH_PERSIST_MAX_RETRY_ATTEMPTS = 5;
const LUKER_SIDECAR_CONSISTENCY_RETRY_DELAYS_MS = [80, 220];
const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = new Set([
  GRAPH_LOAD_STATES.LOADING,
  GRAPH_LOAD_STATES.BLOCKED,
  GRAPH_LOAD_STATES.NO_CHAT,
  GRAPH_LOAD_STATES.SHADOW_RESTORED,
]);

function isGraphLoadStateDbReady(loadState = graphPersistenceState.loadState) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
  );
}

function normalizeGraphSyncState(value = "idle") {
  const normalized = String(value || "idle")
    .trim()
    .toLowerCase();
  if (["idle", "syncing", "warning", "error"].includes(normalized))
    return normalized;
  return "idle";
}

function normalizePersistenceHostProfile(value = "generic-st") {
  const normalized = String(value || "generic-st")
    .trim()
    .toLowerCase();
  return normalized === "luker" ? "luker" : "generic-st";
}

function normalizePersistenceStorageTier(value = "none") {
  const normalized = String(value || "none")
    .trim()
    .toLowerCase();
  if (
    [
      "indexeddb",
      "opfs",
      "authority-sql",
      "chat-state",
      "luker-chat-state",
      "shadow",
      "metadata-full",
      "none",
    ].includes(normalized)
  ) {
    return normalized;
  }
  return "none";
}

function resolveLocalStoreTierFromPresentation(
  presentation = getPreferredGraphLocalStorePresentationSync(),
) {
  const normalizedPresentation =
    presentation && typeof presentation === "object"
      ? presentation
      : getPreferredGraphLocalStorePresentationSync();
  if (normalizedPresentation.storagePrimary === AUTHORITY_GRAPH_STORE_KIND) {
    return "authority-sql";
  }
  return normalizedPresentation.storagePrimary === "opfs" ? "opfs" : "indexeddb";
}

function hasValidLukerChatStateTarget(context = getContext()) {
  return resolveCurrentChatStateTarget(context) !== null;
}

function resolvePersistenceHostProfile(context = getContext()) {
  if (typeof resolveBmeHostProfile === "function") {
    return resolveBmeHostProfile(context);
  }
  const activeContext =
    context && typeof context === "object" ? context : getContext();
  const hasLukerApi =
    !!globalThis.Luker && typeof globalThis.Luker?.getContext === "function";
  if (
    hasLukerApi &&
    canUseGraphChatState(activeContext) &&
    normalizeChatIdCandidate(
      activeContext?.chatId ||
        (typeof activeContext?.getCurrentChatId === "function"
          ? activeContext.getCurrentChatId()
          : ""),
    )
  ) {
    return "luker";
  }
  return "generic-st";
}

function buildPersistenceEnvironment(
  context = getContext(),
  presentation = getPreferredGraphLocalStorePresentationSync(),
) {
  const hostProfile = resolvePersistenceHostProfile(context);
  const localStoreTier = resolveLocalStoreTierFromPresentation(presentation);
  const authorityPrimary = localStoreTier === "authority-sql";
  return {
    hostProfile,
    localStoreTier,
    primaryStorageTier: authorityPrimary
      ? "authority-sql"
      : hostProfile === "luker"
        ? "luker-chat-state"
        : localStoreTier,
    cacheStorageTier: authorityPrimary
      ? "none"
      : hostProfile === "luker"
        ? localStoreTier
        : "none",
  };
}

function isLukerPrimaryPersistenceHost(context = getContext()) {
  return resolvePersistenceHostProfile(context) === "luker";
}

function getAuthorityRuntimeSnapshot(settings = getSettings()) {
  authorityCapabilityState = normalizeAuthorityCapabilityState(
    authorityCapabilityState,
    settings,
  );
  authorityBrowserState = normalizeAuthorityBrowserState(
    authorityBrowserState,
    settings,
  );
  return {
    capability: authorityCapabilityState,
    browserState: getAuthorityBrowserStateSnapshot(authorityBrowserState, settings),
  };
}

function buildAuthorityPersistenceStatePatch(settings = getSettings()) {
  const { capability, browserState } = getAuthorityRuntimeSnapshot(settings);
  return {
    authority: cloneRuntimeDebugValue(capability, null),
    authorityBrowserState: cloneRuntimeDebugValue(browserState, null),
    authorityInstalled: Boolean(capability.installed),
    authorityHealthy: Boolean(capability.healthy),
    authorityServerPrimaryReady: Boolean(capability.serverPrimaryReady),
    authorityStoragePrimaryReady: Boolean(capability.storagePrimaryReady),
    authorityTriviumPrimaryReady: Boolean(capability.triviumPrimaryReady),
    authorityJobsReady: Boolean(capability.jobsReady),
    authorityBlobReady: Boolean(capability.blobReady),
    authorityBrowserCacheMode: String(browserState.mode || "minimal"),
    authorityOfflineQueueBytes: Number(browserState.offlineQueueBytes || 0),
    authorityOfflineQueueItems: Number(browserState.offlineQueueItems || 0),
    authorityDegradedReason: capability.serverPrimaryReady
      ? ""
      : String(capability.reason || capability.lastError || ""),
  };
}

function isAuthorityGraphStorePresentation(presentation = null) {
  if (!presentation || typeof presentation !== "object") return false;
  return (
    presentation.storagePrimary === AUTHORITY_GRAPH_STORE_KIND ||
    presentation.storageMode === AUTHORITY_GRAPH_STORE_MODE
  );
}

function isAuthorityGraphStoreDb(db = null) {
  return (
    db?.storeKind === AUTHORITY_GRAPH_STORE_KIND ||
    db?.storeMode === AUTHORITY_GRAPH_STORE_MODE
  );
}

function recordAuthorityAcceptedRevisionPointer({
  revision = 0,
  integrity = "",
  committedAt = Date.now(),
} = {}) {
  const settings = getSettings();
  authorityBrowserState = recordAuthorityAcceptedRevision(
    authorityBrowserState,
    {
      revision: normalizeIndexedDbRevision(revision),
      integrity: String(integrity || ""),
      committedAt,
    },
    settings,
    committedAt,
  );
  updateGraphPersistenceState(buildAuthorityPersistenceStatePatch(settings));
  return authorityBrowserState;
}

async function captureAuthorityMigrationSafetySnapshot(
  chatId,
  snapshot,
  { source = "authority-migration", reason = "authority-migration-safety" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot)) {
    return {
      captured: false,
      reason: "authority-migration-safety-source-empty",
      chatId: normalizedChatId || "",
    };
  }

  try {
    await createRestoreSafetySnapshot(
      normalizedChatId,
      snapshot,
      buildBmeSyncRuntimeOptions({
        reason,
        trigger: String(source || "authority-migration"),
      }),
    );
    const migrationGraph = buildGraphFromSnapshot(snapshot, {
      chatId: normalizedChatId,
    });
    const revision = normalizeIndexedDbRevision(snapshot?.meta?.revision);
    const identity = resolveCurrentChatIdentity(getContext());
    const integrity = String(
      snapshot?.meta?.integrity || identity?.integrity || "",
    ).trim();
    let shadowCaptured = false;
    try {
      shadowCaptured = writeGraphShadowSnapshot(normalizedChatId, migrationGraph, {
        revision,
        reason,
        integrity,
        debugReason: String(source || "authority-migration"),
      });
    } catch (shadowError) {
      console.warn("[ST-BME] Authority 迁移影子安全快照创建失败:", shadowError);
    }
    let blobCaptured = false;
    try {
      const blobAdapter = getAuthorityBlobAdapter();
      if (blobAdapter && typeof blobAdapter.writeJson === "function") {
        await blobAdapter.writeJson(
          `ST-BME/migration-safety/${normalizedChatId}.json`,
          snapshot,
          { namespace: "st-bme-safety" },
        );
        blobCaptured = true;
      }
    } catch (blobError) {
      console.warn("[ST-BME] 安全快照写入 Authority blob 失败（非致命）:", blobError);
    }
    return {
      captured: true,
      restoreSafetyCaptured: true,
      shadowCaptured,
      blobCaptured,
      reason: "authority-migration-restore-safety-created",
      chatId: normalizedChatId,
      revision,
      integrity,
    };
  } catch (error) {
    console.warn("[ST-BME] Authority 迁移安全快照创建失败:", error);
    return {
      captured: false,
      reason: "authority-migration-safety-failed",
      chatId: normalizedChatId,
      error: error?.message || String(error),
    };
  }
}

async function refreshAuthorityRuntimeState({
  force = false,
  source = "authority-refresh",
} = {}) {
  if (authorityProbePromise && !force) {
    return await authorityProbePromise;
  }
  const settings = getSettings();
  authorityBrowserState = normalizeAuthorityBrowserState(
    authorityBrowserState,
    settings,
  );
  updateGraphPersistenceState({
    ...buildAuthorityPersistenceStatePatch(settings),
    authorityLastRefreshSource: String(source || "authority-refresh"),
  });

  const allowRelativeUrl =
    typeof window === "object" &&
    Boolean(window?.location) &&
    typeof window.location.href === "string";
  authorityProbePromise = probeAuthorityCapabilities({
    settings,
    fetchImpl:
      typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null,
    headerProvider:
      typeof getRequestHeaders === "function" ? getRequestHeaders : null,
    allowRelativeUrl,
    nowMs: Date.now(),
  })
    .then((snapshot) => {
      authorityCapabilityState = normalizeAuthorityCapabilityState(
        snapshot,
        settings,
      );
      authorityBrowserState = normalizeAuthorityBrowserState(
        {
          ...authorityBrowserState,
          lastProbeAt: authorityCapabilityState.lastProbeAt,
          lastError: authorityCapabilityState.lastError,
        },
        settings,
      );
      updateGraphPersistenceState({
        ...buildAuthorityPersistenceStatePatch(settings),
        authorityLastRefreshSource: String(source || "authority-refresh"),
      });
      return authorityCapabilityState;
    })
    .catch((error) => {
      authorityCapabilityState = normalizeAuthorityCapabilityState(
        {
          installed: false,
          healthy: false,
          reason: "probe-failed",
          lastError: error?.message || String(error),
          lastProbeAt: Date.now(),
          updatedAt: new Date().toISOString(),
        },
        settings,
      );
      updateGraphPersistenceState({
        ...buildAuthorityPersistenceStatePatch(settings),
        authorityLastRefreshSource: String(source || "authority-refresh"),
      });
      return authorityCapabilityState;
    })
    .finally(() => {
      authorityProbePromise = null;
    });
  return await authorityProbePromise;
}

function getGraphPersistenceLiveState() {
  const liveCommitMarker =
    cloneRuntimeDebugValue(graphPersistenceState.commitMarker, null) ||
    readGraphCommitMarker(getContext());
  const restoreLock = normalizeRestoreLockState(graphPersistenceState.restoreLock);
  const persistenceEnvironment = buildPersistenceEnvironment(
    getContext(),
    getPreferredGraphLocalStorePresentationSync(),
  );
  const adapterRuntime = syncBmeHostRuntimeFlags(getContext());
  const hostProfile = normalizePersistenceHostProfile(
    graphPersistenceState.hostProfile ||
      adapterRuntime.adapter.hostProfile ||
      persistenceEnvironment.hostProfile,
  );
  const authorityRuntime = getAuthorityRuntimeSnapshot();
  const primaryStorageTier = normalizePersistenceStorageTier(
    graphPersistenceState.primaryStorageTier ||
      persistenceEnvironment.primaryStorageTier,
  );
  const cacheStorageTier = normalizePersistenceStorageTier(
    graphPersistenceState.cacheStorageTier ||
      persistenceEnvironment.cacheStorageTier,
  );
  const runtimeGraphReadable = hasMeaningfulRuntimeGraphForChat(
    graphPersistenceState.chatId || getCurrentChatId(),
  );
  const snapshot = {
    loadState: graphPersistenceState.loadState,
    chatId: graphPersistenceState.chatId,
    reason: graphPersistenceState.reason,
    attemptIndex: graphPersistenceState.attemptIndex,
    graphRevision: graphPersistenceState.revision,
    lastPersistedRevision: graphPersistenceState.lastPersistedRevision,
    queuedPersistRevision: graphPersistenceState.queuedPersistRevision,
    queuedPersistChatId: graphPersistenceState.queuedPersistChatId,
    shadowSnapshotUsed: graphPersistenceState.shadowSnapshotUsed,
    shadowSnapshotRevision: graphPersistenceState.shadowSnapshotRevision,
    shadowSnapshotUpdatedAt: graphPersistenceState.shadowSnapshotUpdatedAt,
    shadowSnapshotReason: graphPersistenceState.shadowSnapshotReason,
    lastPersistReason: graphPersistenceState.lastPersistReason,
    lastPersistMode: graphPersistenceState.lastPersistMode,
    metadataIntegrity: graphPersistenceState.metadataIntegrity,
    writesBlocked: graphPersistenceState.writesBlocked,
    pendingPersist: graphPersistenceState.pendingPersist,
    lastAcceptedRevision: Number(graphPersistenceState.lastAcceptedRevision || 0),
    acceptedStorageTier: String(graphPersistenceState.acceptedStorageTier || "none"),
    hostProfile,
    primaryStorageTier,
    cacheStorageTier,
    cacheMirrorState: String(graphPersistenceState.cacheMirrorState || "idle"),
    cacheLag: Number(graphPersistenceState.cacheLag || 0),
    chatStateTarget: cloneRuntimeDebugValue(
      graphPersistenceState.chatStateTarget || adapterRuntime.target,
      null,
    ),
    lightweightHostMode:
      graphPersistenceState.lightweightHostMode ??
      adapterRuntime.lightweightHostMode,
    persistDiagnosticTier: String(
      graphPersistenceState.persistDiagnosticTier || "none",
    ),
    acceptedBy: String(graphPersistenceState.acceptedBy || "none"),
    lastRecoverableStorageTier: String(
      graphPersistenceState.lastRecoverableStorageTier || "none",
    ),
    persistMismatchReason: String(graphPersistenceState.persistMismatchReason || ""),
    commitMarker: cloneRuntimeDebugValue(liveCommitMarker, null),
    restoreLock,
    backgroundMaintenance: cloneRuntimeDebugValue(
      graphPersistenceState.backgroundMaintenance,
      {
        state: "idle",
        queued: 0,
        activeId: "",
        activeName: "",
        completed: 0,
        failed: 0,
        dropped: 0,
        lastTask: null,
        updatedAt: 0,
      },
    ),
    queuedPersistMode: graphPersistenceState.queuedPersistMode,
    queuedPersistRotateIntegrity:
      graphPersistenceState.queuedPersistRotateIntegrity,
    queuedPersistReason: graphPersistenceState.queuedPersistReason,
    canWriteToMetadata: isGraphMetadataWriteAllowed(
      graphPersistenceState.loadState,
    ),
    updatedAt: graphPersistenceState.updatedAt,
    storagePrimary: graphPersistenceState.storagePrimary || "indexeddb",
    storageMode: graphPersistenceState.storageMode || "indexeddb",
    authority: cloneRuntimeDebugValue(authorityRuntime.capability, null),
    authorityBrowserState: cloneRuntimeDebugValue(
      authorityRuntime.browserState,
      null,
    ),
    authorityInstalled: Boolean(authorityRuntime.capability.installed),
    authorityHealthy: Boolean(authorityRuntime.capability.healthy),
    authorityServerPrimaryReady: Boolean(
      authorityRuntime.capability.serverPrimaryReady,
    ),
    authorityStoragePrimaryReady: Boolean(
      authorityRuntime.capability.storagePrimaryReady,
    ),
    authorityTriviumPrimaryReady: Boolean(
      authorityRuntime.capability.triviumPrimaryReady,
    ),
    authorityJobsReady: Boolean(authorityRuntime.capability.jobsReady),
    authorityJobQueueState: String(graphPersistenceState.authorityJobQueueState || "idle"),
    authorityLastJob: cloneRuntimeDebugValue(
      graphPersistenceState.authorityLastJob,
      null,
    ),
    authorityLastJobId: String(graphPersistenceState.authorityLastJobId || ""),
    authorityLastJobKind: String(graphPersistenceState.authorityLastJobKind || ""),
    authorityLastJobStatus: String(graphPersistenceState.authorityLastJobStatus || ""),
    authorityLastJobProgress: Number(
      graphPersistenceState.authorityLastJobProgress || 0,
    ),
    authorityLastJobError: String(graphPersistenceState.authorityLastJobError || ""),
    authorityLastJobUpdatedAt: String(
      graphPersistenceState.authorityLastJobUpdatedAt || "",
    ),
    authorityJobTrackingMode: String(
      graphPersistenceState.authorityJobTrackingMode || "idle",
    ),
    authorityJobTrackingReason: String(
      graphPersistenceState.authorityJobTrackingReason || "",
    ),
    authorityJobTrackingUpdatedAt: String(
      graphPersistenceState.authorityJobTrackingUpdatedAt || "",
    ),
    authorityRecentJobs: cloneRuntimeDebugValue(
      graphPersistenceState.authorityRecentJobs,
      [],
    ),
    authorityRecentJobsUpdatedAt: String(
      graphPersistenceState.authorityRecentJobsUpdatedAt || "",
    ),
    authorityRecentJobsError: String(
      graphPersistenceState.authorityRecentJobsError || "",
    ),
    authorityRecentJobsNextCursor: String(
      graphPersistenceState.authorityRecentJobsNextCursor || "",
    ),
    authorityRecentJobsHasMore: Boolean(
      graphPersistenceState.authorityRecentJobsHasMore,
    ),
    authorityBlobReady: Boolean(authorityRuntime.capability.blobReady),
    authorityBlobState: String(graphPersistenceState.authorityBlobState || "idle"),
    authorityLastBlobEvent: cloneRuntimeDebugValue(
      graphPersistenceState.authorityLastBlobEvent,
      null,
    ),
    authorityLastBlobAction: String(graphPersistenceState.authorityLastBlobAction || ""),
    authorityLastBlobBackend: String(graphPersistenceState.authorityLastBlobBackend || ""),
    authorityLastBlobPath: String(graphPersistenceState.authorityLastBlobPath || ""),
    authorityLastBlobReason: String(graphPersistenceState.authorityLastBlobReason || ""),
    authorityLastBlobError: String(graphPersistenceState.authorityLastBlobError || ""),
    authorityLastBlobUpdatedAt: String(
      graphPersistenceState.authorityLastBlobUpdatedAt || "",
    ),
    authorityBlobCheckpointPath: String(
      graphPersistenceState.authorityBlobCheckpointPath || "",
    ),
    authorityBlobCheckpointRevision: Number(
      graphPersistenceState.authorityBlobCheckpointRevision || 0,
    ),
    authorityBlobCheckpointUpdatedAt: String(
      graphPersistenceState.authorityBlobCheckpointUpdatedAt || "",
    ),
    authorityConsistencyState: String(
      graphPersistenceState.authorityConsistencyState || "idle",
    ),
    authorityConsistencyAudit: cloneRuntimeDebugValue(
      graphPersistenceState.authorityConsistencyAudit,
      null,
    ),
    authorityConsistencyUpdatedAt: String(
      graphPersistenceState.authorityConsistencyUpdatedAt || "",
    ),
    authorityConsistencyError: String(
      graphPersistenceState.authorityConsistencyError || "",
    ),
    authorityCheckpointRestoreState: String(
      graphPersistenceState.authorityCheckpointRestoreState || "idle",
    ),
    authorityCheckpointRestoreResult: cloneRuntimeDebugValue(
      graphPersistenceState.authorityCheckpointRestoreResult,
      null,
    ),
    authorityCheckpointRestoreUpdatedAt: String(
      graphPersistenceState.authorityCheckpointRestoreUpdatedAt || "",
    ),
    authorityCheckpointRestoreError: String(
      graphPersistenceState.authorityCheckpointRestoreError || "",
    ),
    authorityRepairState: String(graphPersistenceState.authorityRepairState || "idle"),
    authorityRepairResult: cloneRuntimeDebugValue(
      graphPersistenceState.authorityRepairResult,
      null,
    ),
    authorityRepairUpdatedAt: String(
      graphPersistenceState.authorityRepairUpdatedAt || "",
    ),
    authorityRepairError: String(graphPersistenceState.authorityRepairError || ""),
    authorityPerformanceBaseline: cloneRuntimeDebugValue(
      graphPersistenceState.authorityPerformanceBaseline,
      null,
    ),
    authorityPerformanceBaselineComparison: cloneRuntimeDebugValue(
      graphPersistenceState.authorityPerformanceBaselineComparison,
      null,
    ),
    authorityPerformanceBaselineUpdatedAt: String(
      graphPersistenceState.authorityPerformanceBaselineUpdatedAt || "",
    ),
    authorityPerformanceBaselineReason: String(
      graphPersistenceState.authorityPerformanceBaselineReason || "",
    ),
    authorityBrowserCacheMode: String(
      authorityRuntime.browserState.mode || "minimal",
    ),
    authorityOfflineQueueBytes: Number(
      authorityRuntime.browserState.offlineQueueBytes || 0,
    ),
    authorityOfflineQueueItems: Number(
      authorityRuntime.browserState.offlineQueueItems || 0,
    ),
    authorityDegradedReason: authorityRuntime.capability.serverPrimaryReady
      ? ""
      : String(
          authorityRuntime.capability.reason ||
            authorityRuntime.capability.lastError ||
            "",
        ),
    authorityMigrationState: String(
      graphPersistenceState.authorityMigrationState || "idle",
    ),
    authorityMigrationSource: String(
      graphPersistenceState.authorityMigrationSource || "",
    ),
    authorityMigrationRevision: Number(
      graphPersistenceState.authorityMigrationRevision || 0,
    ),
    authorityMigrationLastError: String(
      graphPersistenceState.authorityMigrationLastError || "",
    ),
    lastAuthorityMigrationResult: cloneRuntimeDebugValue(
      graphPersistenceState.lastAuthorityMigrationResult,
      null,
    ),
    resolvedLocalStore: String(
      graphPersistenceState.resolvedLocalStore ||
        buildGraphLocalStoreSelectorKey(getPreferredGraphLocalStorePresentationSync()),
    ),
    lukerSidecarFormatVersion:
      Number(graphPersistenceState.lukerSidecarFormatVersion || 0) || 0,
    lukerManifestRevision: Number(graphPersistenceState.lukerManifestRevision || 0),
    lukerJournalDepth: Number(graphPersistenceState.lukerJournalDepth || 0),
    lukerJournalBytes: Number(graphPersistenceState.lukerJournalBytes || 0),
    lukerCheckpointRevision: Number(
      graphPersistenceState.lukerCheckpointRevision || 0,
    ),
    projectionState: cloneRuntimeDebugValue(
      graphPersistenceState.projectionState,
      null,
    ),
    lastHookPhase: String(graphPersistenceState.lastHookPhase || ""),
    lastRequestRescanReason: String(
      graphPersistenceState.lastRequestRescanReason || "",
    ),
    lastIgnoredMutationEvent: String(
      graphPersistenceState.lastIgnoredMutationEvent || "",
    ),
    lastIgnoredMutationReason: String(
      graphPersistenceState.lastIgnoredMutationReason || "",
    ),
    lastChatStateConflict: cloneRuntimeDebugValue(
      graphPersistenceState.lastChatStateConflict,
      null,
    ),
    lastBranchInheritResult: cloneRuntimeDebugValue(
      graphPersistenceState.lastBranchInheritResult,
      null,
    ),
    localStoreFormatVersion: Number(graphPersistenceState.localStoreFormatVersion || 0) || 1,
    localStoreMigrationState: String(
      graphPersistenceState.localStoreMigrationState || "idle",
    ),
    opfsWriteLockState: cloneRuntimeDebugValue(
      graphPersistenceState.opfsWriteLockState,
      null,
    ),
    opfsWalDepth: Number(graphPersistenceState.opfsWalDepth || 0),
    opfsPendingBytes: Number(graphPersistenceState.opfsPendingBytes || 0),
    opfsCompactionState: cloneRuntimeDebugValue(
      graphPersistenceState.opfsCompactionState,
      null,
    ),
    runtimeGraphReadable,
    remoteSyncFormatVersion: Number(graphPersistenceState.remoteSyncFormatVersion || 0) || 1,
    dbReady:
      graphPersistenceState.dbReady ??
      isGraphLoadStateDbReady(graphPersistenceState.loadState),
    indexedDbRevision: graphPersistenceState.indexedDbRevision || 0,
    indexedDbLastError: graphPersistenceState.indexedDbLastError || "",
    syncState: normalizeGraphSyncState(graphPersistenceState.syncState),
    syncDirty: Boolean(graphPersistenceState.syncDirty),
    syncDirtyReason: String(graphPersistenceState.syncDirtyReason || ""),
    lastSyncUploadedAt: Number(graphPersistenceState.lastSyncUploadedAt) || 0,
    lastSyncDownloadedAt:
      Number(graphPersistenceState.lastSyncDownloadedAt) || 0,
    lastSyncedRevision: Number(graphPersistenceState.lastSyncedRevision) || 0,
    lastBackupUploadedAt:
      Number(graphPersistenceState.lastBackupUploadedAt) || 0,
    lastBackupRestoredAt:
      Number(graphPersistenceState.lastBackupRestoredAt) || 0,
    lastBackupRollbackAt:
      Number(graphPersistenceState.lastBackupRollbackAt) || 0,
    lastBackupFilename: String(graphPersistenceState.lastBackupFilename || ""),
    lastSyncError: String(graphPersistenceState.lastSyncError || ""),
    dualWriteLastResult: cloneRuntimeDebugValue(
      graphPersistenceState.dualWriteLastResult,
      null,
    ),
    persistDelta: cloneRuntimeDebugValue(graphPersistenceState.persistDelta, null),
    loadDiagnostics: cloneRuntimeDebugValue(
      graphPersistenceState.loadDiagnostics,
      null,
    ),
    authorityDiagnosticsBundlePath: String(
      graphPersistenceState.authorityDiagnosticsBundlePath || "",
    ),
    authorityDiagnosticsBundleReason: String(
      graphPersistenceState.authorityDiagnosticsBundleReason || "",
    ),
    authorityDiagnosticsBundleUpdatedAt: String(
      graphPersistenceState.authorityDiagnosticsBundleUpdatedAt || "",
    ),
    authorityDiagnosticsBundleSize: Number(
      graphPersistenceState.authorityDiagnosticsBundleSize || 0,
    ),
    authorityDiagnosticsManifestPath: String(
      graphPersistenceState.authorityDiagnosticsManifestPath || "",
    ),
    authorityDiagnosticsArtifacts: cloneRuntimeDebugValue(
      graphPersistenceState.authorityDiagnosticsArtifacts,
      [],
    ),
    authorityDiagnosticsArtifactsUpdatedAt: String(
      graphPersistenceState.authorityDiagnosticsArtifactsUpdatedAt || "",
    ),
    authorityDiagnosticsArtifactsError: String(
      graphPersistenceState.authorityDiagnosticsArtifactsError || "",
    ),
    authorityDiagnosticsRetentionLimit: Number(
      graphPersistenceState.authorityDiagnosticsRetentionLimit ||
        AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
    ),
    authorityDiagnosticsLastPrunedCount: Number(
      graphPersistenceState.authorityDiagnosticsLastPrunedCount || 0,
    ),
    authorityDiagnosticsLastPrunedAt: String(
      graphPersistenceState.authorityDiagnosticsLastPrunedAt || "",
    ),
    authorityDiagnosticsLastPruneError: String(
      graphPersistenceState.authorityDiagnosticsLastPruneError || "",
    ),
  };

  return cloneRuntimeDebugValue(snapshot, snapshot);
}

function syncGraphPersistenceDebugState() {
  recordGraphPersistenceSnapshot(getGraphPersistenceLiveState());
}

function updateGraphPersistenceState(patch = {}) {
  graphPersistenceState = {
    ...graphPersistenceState,
    ...(patch || {}),
    updatedAt: new Date().toISOString(),
  };
  syncGraphPersistenceDebugState();
  return graphPersistenceState;
}

function getAuthorityJobAdapter(options = {}) {
  const settings = getSettings();
  const config = normalizeAuthorityJobConfig(settings);
  return createAuthorityJobAdapter(config, {
    fetchImpl: globalThis.fetch?.bind(globalThis),
    headerProvider:
      typeof getRequestHeaders === "function" ? () => getRequestHeaders() : null,
    ...options,
  });
}

function shouldUseAuthorityJobs(config = null) {
  const settings = getSettings();
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  const jobConfig = normalizeAuthorityJobConfig(settings);
  return Boolean(
    jobConfig.enabled &&
      capability.jobsReady &&
      settings.authorityJobsEnabled !== false &&
      isAuthorityVectorConfig(config),
  );
}

function mergeAuthorityRecentJobsIntoState(incomingJobs = [], options = {}) {
  const updatedAt = String(options.updatedAt || new Date().toISOString());
  const nextRecentJobs = mergeAuthorityRecentJobs(
    options.replace === true ? [] : graphPersistenceState.authorityRecentJobs,
    incomingJobs,
    {
      limit: Number.isFinite(Number(options.limit))
        ? Math.max(1, Math.floor(Number(options.limit)))
        : AUTHORITY_RECENT_JOBS_LIMIT,
      updatedAt,
    },
  );
  updateGraphPersistenceState({
    authorityRecentJobs: cloneRuntimeDebugValue(nextRecentJobs, []),
    authorityRecentJobsUpdatedAt: updatedAt,
    authorityRecentJobsError:
      options.error !== undefined
        ? String(options.error || "")
        : String(graphPersistenceState.authorityRecentJobsError || ""),
    authorityRecentJobsNextCursor:
      options.nextCursor !== undefined
        ? String(options.nextCursor || "")
        : String(graphPersistenceState.authorityRecentJobsNextCursor || ""),
    authorityRecentJobsHasMore:
      options.hasMore !== undefined
        ? Boolean(options.hasMore)
        : Boolean(graphPersistenceState.authorityRecentJobsHasMore),
  });
  return nextRecentJobs;
}

function setAuthorityJobTrackingState(mode = "idle", reason = "") {
  updateGraphPersistenceState({
    authorityJobTrackingMode: String(mode || "idle"),
    authorityJobTrackingReason: String(reason || ""),
    authorityJobTrackingUpdatedAt: new Date().toISOString(),
  });
}

async function refreshAuthorityRecentJobs(options = {}) {
  const settings = getSettings();
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  const updatedAt = new Date().toISOString();
  const currentChatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  const limit = Number.isFinite(Number(options.limit))
    ? Math.max(1, Math.floor(Number(options.limit)))
    : AUTHORITY_RECENT_JOBS_LIMIT;
  if (!capability.jobsReady || settings.authorityJobsEnabled === false) {
    updateGraphPersistenceState({
      authorityRecentJobsError: "Authority Jobs unavailable",
      authorityRecentJobsUpdatedAt: updatedAt,
    });
    refreshPanelLiveState();
    return {
      success: false,
      reason: "authority-jobs-unavailable",
      error: "Authority Jobs unavailable",
    };
  }
  try {
    const adapter = getAuthorityJobAdapter();
    const filter =
      options.filter && typeof options.filter === "object" && !Array.isArray(options.filter)
        ? { ...options.filter }
        : {};
    if (currentChatId && !String(filter.chatId || "").trim()) {
      filter.chatId = currentChatId;
    }
    const page = await adapter.listPage({
      limit,
      cursor: String(options.cursor || ""),
      filter,
      signal: options.signal,
    });
    const jobs = mergeAuthorityRecentJobsIntoState(page.jobs, {
      replace: options.replace === true,
      limit,
      updatedAt,
      error: "",
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    });
    refreshPanelLiveState();
    return {
      success: true,
      jobs,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  } catch (error) {
    const message =
      error?.message || String(error) || "Authority Jobs 列表刷新失败";
    updateGraphPersistenceState({
      authorityRecentJobsError: message,
      authorityRecentJobsUpdatedAt: updatedAt,
    });
    refreshPanelLiveState();
    return { success: false, error: message };
  }
}

function recordAuthorityJobSnapshot(job = null, options = {}) {
  const normalizedJob =
    job && typeof job === "object" && !Array.isArray(job) ? job : {};
  const progress = Number(normalizedJob.progress || 0);
  const status = String(normalizedJob.status || options.status || "");
  const error = String(normalizedJob.error || options.error || "");
  const updatedAt = new Date().toISOString();
  const queueState =
    options.queueState ||
    (error
      ? "error"
      : normalizedJob.terminal
        ? normalizedJob.success
          ? "success"
          : "failed"
        : normalizedJob.id
          ? "running"
          : "idle");
  const recentJobsPatch = normalizedJob.id
    ? {
        authorityRecentJobs: cloneRuntimeDebugValue(
          mergeAuthorityRecentJobs(
            graphPersistenceState.authorityRecentJobs,
            [
              {
                ...normalizedJob,
                kind: normalizedJob.kind || options.kind || "",
                status,
                progress: Number.isFinite(progress)
                  ? Math.max(0, Math.min(1, progress))
                  : 0,
                error,
                updatedAt,
              },
            ],
            {
              limit: AUTHORITY_RECENT_JOBS_LIMIT,
              updatedAt,
            },
          ),
          [],
        ),
        authorityRecentJobsUpdatedAt: updatedAt,
        authorityRecentJobsError:
          options.recentJobsError !== undefined
            ? String(options.recentJobsError || "")
            : String(graphPersistenceState.authorityRecentJobsError || ""),
      }
    : options.recentJobsError !== undefined
      ? {
          authorityRecentJobsError: String(options.recentJobsError || ""),
          authorityRecentJobsUpdatedAt: updatedAt,
        }
      : {};
  updateGraphPersistenceState({
    authorityJobQueueState: queueState,
    authorityLastJob: cloneRuntimeDebugValue(normalizedJob, null),
    authorityLastJobId: String(normalizedJob.id || options.jobId || ""),
    authorityLastJobKind: String(normalizedJob.kind || options.kind || ""),
    authorityLastJobStatus: status,
    authorityLastJobProgress: Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : 0,
    authorityLastJobError: error,
    authorityLastJobUpdatedAt: updatedAt,
    ...recentJobsPatch,
  });
}

function recordAuthorityBlobSnapshot(event = {}) {
  const normalizedEvent =
    event && typeof event === "object" && !Array.isArray(event) ? event : {};
  updateGraphPersistenceState({
    authorityBlobState: normalizedEvent.ok === false ? "error" : "active",
    authorityLastBlobEvent: cloneRuntimeDebugValue(normalizedEvent, null),
    authorityLastBlobAction: String(normalizedEvent.action || ""),
    authorityLastBlobBackend: String(normalizedEvent.backend || ""),
    authorityLastBlobPath: String(normalizedEvent.path || ""),
    authorityLastBlobReason: String(normalizedEvent.reason || ""),
    authorityLastBlobError: String(normalizedEvent.error || ""),
    authorityLastBlobUpdatedAt: String(
      normalizedEvent.updatedAt || new Date().toISOString(),
    ),
  });
}

function buildAuthorityBlobFileHash(input = "") {
  let hash = 2166136261;
  const text = String(input ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildAuthorityBlobSafeSlug(input = "", fallback = "unknown") {
  const normalized = String(input || fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function shouldUseAuthorityBlobCheckpoint() {
  const settings = getSettings();
  const authoritySettings = normalizeAuthoritySettings(settings);
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  return Boolean(
    authoritySettings.enabled &&
      authoritySettings.blobCheckpointEnabled &&
      capability.blobReady,
  );
}

function shouldUseAuthorityDiagnosticsBundle() {
  const settings = getSettings();
  const authoritySettings = normalizeAuthoritySettings(settings);
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  return Boolean(
    authoritySettings.enabled &&
      settings.authorityDiagnosticsEnabled !== false &&
      capability.blobReady,
  );
}

function getAuthorityBlobAdapter(options = {}) {
  const settings = getSettings();
  const config = normalizeAuthorityBlobConfig(settings);
  return createAuthorityBlobAdapter(config, {
    fetchImpl: globalThis.fetch?.bind(globalThis),
    headerProvider:
      typeof getRequestHeaders === "function" ? () => getRequestHeaders() : null,
    ...options,
  });
}

async function enforceAuthorityDiagnosticsRetention(adapter, prunedEntries = [], options = {}) {
  const normalizedEntries = Array.isArray(prunedEntries)
    ? prunedEntries.filter((entry) => entry && typeof entry === "object")
    : [];
  const results = [];
  const errors = [];
  for (const entry of normalizedEntries) {
    const artifactPath = String(entry?.path || "").trim();
    if (!artifactPath) {
      continue;
    }
    try {
      const deleteResult = await adapter.delete(artifactPath, {
        signal: options.signal,
      });
      const ok = deleteResult?.ok !== false;
      results.push({
        path: artifactPath,
        ok,
        deleted: deleteResult?.deleted === true,
        missing: deleteResult?.missing === true,
      });
      if (!ok) {
        errors.push(`${artifactPath}: ${deleteResult?.error || deleteResult?.reason || "delete failed"}`);
      }
    } catch (error) {
      const message = error?.message || String(error) || "delete failed";
      results.push({
        path: artifactPath,
        ok: false,
        error: message,
      });
      errors.push(`${artifactPath}: ${message}`);
    }
  }
  return {
    ok: errors.length === 0,
    count: results.filter((item) => item.ok !== false).length,
    results,
    error: errors.join(" | "),
  };
}

function buildAuthorityPerformanceBaselineSnapshot(options = {}) {
  const liveGraphPersistence = getGraphPersistenceLiveState();
  return buildAuthorityPerformanceBaseline({
    chatId:
      normalizeChatIdCandidate(options.chatId) ||
      normalizeChatIdCandidate(getCurrentChatId()) ||
      normalizeChatIdCandidate(graphPersistenceState.chatId),
    graphPersistence: liveGraphPersistence,
    graph: currentGraph,
    consistencyAudit: liveGraphPersistence.authorityConsistencyAudit,
  });
}

function captureAuthorityPerformanceBaseline(options = {}) {
  const previousBaseline =
    graphPersistenceState.authorityPerformanceBaseline &&
    typeof graphPersistenceState.authorityPerformanceBaseline === "object" &&
    !Array.isArray(graphPersistenceState.authorityPerformanceBaseline)
      ? graphPersistenceState.authorityPerformanceBaseline
      : null;
  const baseline = buildAuthorityPerformanceBaselineSnapshot(options);
  const comparison = buildAuthorityPerformanceBaselineComparison(previousBaseline, baseline);
  const capturedAt = String(baseline?.capturedAt || new Date().toISOString());
  const reason = String(options.reason || "manual-authority-performance-baseline");
  updateGraphPersistenceState({
    authorityPerformanceBaseline: cloneRuntimeDebugValue(baseline, null),
    authorityPerformanceBaselineComparison: cloneRuntimeDebugValue(comparison, null),
    authorityPerformanceBaselineUpdatedAt: capturedAt,
    authorityPerformanceBaselineReason: reason,
  });
  refreshPanelLiveState();
  return {
    ok: true,
    baseline,
  };
}

async function exportAuthorityDiagnosticsBundle(options = {}) {
  const settings = getSettings();
  if (!shouldUseAuthorityDiagnosticsBundle()) {
    return {
      ok: false,
      reason: "authority-diagnostics-unavailable",
    };
  }
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  if (!chatId) {
    return {
      ok: false,
      reason: "missing-chat-id",
    };
  }
  const reason = String(options.reason || "diagnostics-bundle").trim() || "diagnostics-bundle";
  const liveGraphPersistence = getGraphPersistenceLiveState();
  const previousBaseline =
    liveGraphPersistence.authorityPerformanceBaseline &&
    typeof liveGraphPersistence.authorityPerformanceBaseline === "object" &&
    !Array.isArray(liveGraphPersistence.authorityPerformanceBaseline)
      ? liveGraphPersistence.authorityPerformanceBaseline
      : null;
  const baseline = buildAuthorityPerformanceBaseline({
    chatId,
    graphPersistence: liveGraphPersistence,
    graph: currentGraph,
    consistencyAudit: liveGraphPersistence.authorityConsistencyAudit,
  });
  const baselineComparison = buildAuthorityPerformanceBaselineComparison(previousBaseline, baseline);
  const bundle = buildAuthorityDiagnosticsBundle({
    chatId,
    reason,
    settings,
    runtimeStatus,
    runtimeDebug: readRuntimeDebugSnapshot(),
    graphPersistence: {
      ...liveGraphPersistence,
      authorityPerformanceBaseline: cloneRuntimeDebugValue(baseline, null),
      authorityPerformanceBaselineUpdatedAt: String(baseline?.capturedAt || ""),
      authorityPerformanceBaselineReason: reason,
    },
    graph: currentGraph,
    lastExtractionStatus,
    lastVectorStatus,
    lastRecallStatus,
    lastBatchStatus: cloneRuntimeDebugValue(currentGraph?.historyState?.lastBatchStatus, null),
    lastInjection: lastInjectionContent,
    lastExtract: lastExtractedItems,
    lastRecall: lastRecalledItems,
    performanceBaseline: baseline,
    performanceBaselineComparison: baselineComparison,
  });
  const path = buildAuthorityDiagnosticsBundlePath(chatId, reason);
  const manifestPath = buildAuthorityDiagnosticsManifestPath(chatId);
  const adapter = getAuthorityBlobAdapter();
  try {
    const result = await writeAuthorityDiagnosticsBundleFile(adapter, bundle, {
      chatId,
      reason,
      path,
      signal: options.signal,
    });
    const updatedAt = new Date().toISOString();
    const bundleSize = (() => {
      if (Number.isFinite(Number(result?.result?.size))) {
        return Number(result.result.size);
      }
      try {
        return JSON.stringify(bundle).length;
      } catch {
        return 0;
      }
    })();
    const manifestEntry = {
      chatId,
      path: String(result?.path || path),
      reason,
      size: bundleSize,
      bundleVersion: Number(bundle?.bundleVersion || 1),
      createdAt: String(bundle?.createdAt || updatedAt),
      updatedAt,
    };
    const manifestResult = await upsertAuthorityDiagnosticsManifestEntry(adapter, manifestEntry, {
      chatId,
      path: manifestPath,
      signal: options.signal,
    }).catch(() => null);
    const retentionResult = manifestResult
      ? await enforceAuthorityDiagnosticsRetention(
          adapter,
          manifestResult?.prunedEntries,
          {
            signal: options.signal,
          },
        )
      : {
          ok: true,
          count: 0,
          results: [],
          error: "",
        };
    const nextArtifactEntries = manifestResult?.entries || [
      manifestEntry,
      ...((Array.isArray(graphPersistenceState.authorityDiagnosticsArtifacts)
        ? graphPersistenceState.authorityDiagnosticsArtifacts
        : []
      ).filter((entry) => String(entry?.path || "") !== manifestEntry.path)),
    ];
    recordAuthorityBlobSnapshot({
      action: "diagnostics-write",
      ok: result?.ok !== false,
      backend: "authority-blob",
      path: result?.path || path,
      reason,
    });
    updateGraphPersistenceState({
      authorityPerformanceBaseline: cloneRuntimeDebugValue(baseline, null),
      authorityPerformanceBaselineComparison: cloneRuntimeDebugValue(baselineComparison, null),
      authorityPerformanceBaselineUpdatedAt: String(baseline?.capturedAt || updatedAt),
      authorityPerformanceBaselineReason: reason,
      authorityDiagnosticsBundlePath: String(result?.path || path),
      authorityDiagnosticsBundleReason: reason,
      authorityDiagnosticsBundleUpdatedAt: updatedAt,
      authorityDiagnosticsBundleSize: bundleSize,
      authorityDiagnosticsManifestPath: String(manifestResult?.path || manifestPath),
      authorityDiagnosticsArtifacts: cloneRuntimeDebugValue(nextArtifactEntries, []),
      authorityDiagnosticsArtifactsUpdatedAt: String(
        manifestResult?.manifest?.updatedAt || updatedAt,
      ),
      authorityDiagnosticsArtifactsError: "",
      authorityDiagnosticsRetentionLimit: AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
      authorityDiagnosticsLastPrunedCount: Number(retentionResult?.count || 0),
      authorityDiagnosticsLastPrunedAt:
        Number(retentionResult?.count || 0) > 0 ? updatedAt : String(graphPersistenceState.authorityDiagnosticsLastPrunedAt || ""),
      authorityDiagnosticsLastPruneError: String(retentionResult?.error || ""),
    });
    if (options.refreshHost !== false) {
      refreshPanelLiveState();
    }
    return {
      ok: result?.ok !== false,
      path: String(result?.path || path),
      size: bundleSize,
      baseline,
      bundle,
      retention: retentionResult,
    };
  } catch (error) {
    const message =
      error?.message || String(error) || "Authority diagnostics bundle failed";
    recordAuthorityBlobSnapshot({
      action: "diagnostics-write",
      ok: false,
      backend: "authority-blob",
      path,
      reason,
      error: message,
    });
    return {
      ok: false,
      reason: "authority-diagnostics-bundle-error",
      error,
    };
  }
}

async function refreshAuthorityDiagnosticsArtifacts(options = {}) {
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  if (!chatId) {
    return {
      ok: false,
      error: "missing-chat-id",
    };
  }
  if (!shouldUseAuthorityDiagnosticsBundle()) {
    return {
      ok: false,
      error: "authority-diagnostics-unavailable",
    };
  }
  const adapter = getAuthorityBlobAdapter();
  const manifestPath = buildAuthorityDiagnosticsManifestPath(chatId);
  try {
    const result = await readAuthorityDiagnosticsManifest(adapter, {
      chatId,
      path: manifestPath,
      signal: options.signal,
    });
    updateGraphPersistenceState({
      authorityDiagnosticsManifestPath: String(result?.path || manifestPath),
      authorityDiagnosticsArtifacts: cloneRuntimeDebugValue(result?.entries, []),
      authorityDiagnosticsArtifactsUpdatedAt: String(
        result?.manifest?.updatedAt || new Date().toISOString(),
      ),
      authorityDiagnosticsArtifactsError: "",
      authorityDiagnosticsRetentionLimit: AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
    });
    if (options.refreshHost !== false) {
      refreshPanelLiveState();
    }
    return {
      ok: true,
      entries: result?.entries || [],
      path: String(result?.path || manifestPath),
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority diagnostics manifest failed";
    updateGraphPersistenceState({
      authorityDiagnosticsManifestPath: manifestPath,
      authorityDiagnosticsArtifactsError: message,
      authorityDiagnosticsArtifactsUpdatedAt: new Date().toISOString(),
      authorityDiagnosticsRetentionLimit: AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
    });
    if (options.refreshHost !== false) {
      refreshPanelLiveState();
    }
    return {
      ok: false,
      error: message,
    };
  }
}

async function readAuthorityDiagnosticsArtifact(path = "", options = {}) {
  const normalizedPath = String(path || "").trim();
  if (!normalizedPath) {
    return {
      ok: false,
      error: "missing-artifact-path",
    };
  }
  const adapter = getAuthorityBlobAdapter();
  try {
    const result = await adapter.readJson(normalizedPath, {
      signal: options.signal,
    });
    if (!result?.exists || !result?.payload) {
      return {
        ok: false,
        error: "artifact-not-found",
      };
    }
    return {
      ok: true,
      path: String(result.path || normalizedPath),
      payload: result.payload,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error) || "Authority diagnostics artifact read failed",
    };
  }
}

async function deleteAuthorityDiagnosticsArtifact(path = "", options = {}) {
  const normalizedPath = String(path || "").trim();
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  if (!normalizedPath) {
    return {
      ok: false,
      error: "missing-artifact-path",
    };
  }
  const adapter = getAuthorityBlobAdapter();
  const manifestPath = buildAuthorityDiagnosticsManifestPath(chatId);
  try {
    const deleteResult = await adapter.delete(normalizedPath, {
      signal: options.signal,
    });
    const manifestResult = chatId
      ? await removeAuthorityDiagnosticsManifestEntry(adapter, normalizedPath, {
          chatId,
          path: manifestPath,
          signal: options.signal,
        }).catch(() => null)
      : null;
    const updatedAt = new Date().toISOString();
    const wasLatestArtifact =
      String(graphPersistenceState.authorityDiagnosticsBundlePath || "") === normalizedPath;
    const nextArtifactEntries = manifestResult?.entries ||
      (Array.isArray(graphPersistenceState.authorityDiagnosticsArtifacts)
        ? graphPersistenceState.authorityDiagnosticsArtifacts
        : []
      ).filter((entry) => String(entry?.path || "") !== normalizedPath);
    updateGraphPersistenceState({
      authorityDiagnosticsManifestPath: String(manifestResult?.path || manifestPath),
      authorityDiagnosticsArtifacts: cloneRuntimeDebugValue(nextArtifactEntries, []),
      authorityDiagnosticsArtifactsUpdatedAt: String(
        manifestResult?.manifest?.updatedAt || updatedAt,
      ),
      authorityDiagnosticsArtifactsError: "",
      authorityDiagnosticsRetentionLimit: AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
      authorityDiagnosticsBundlePath: wasLatestArtifact ? "" : graphPersistenceState.authorityDiagnosticsBundlePath,
      authorityDiagnosticsBundleReason: wasLatestArtifact ? "" : graphPersistenceState.authorityDiagnosticsBundleReason,
      authorityDiagnosticsBundleUpdatedAt: wasLatestArtifact ? "" : graphPersistenceState.authorityDiagnosticsBundleUpdatedAt,
      authorityDiagnosticsBundleSize: wasLatestArtifact ? 0 : graphPersistenceState.authorityDiagnosticsBundleSize,
    });
    recordAuthorityBlobSnapshot({
      action: "diagnostics-delete",
      ok: deleteResult?.ok !== false,
      backend: "authority-blob",
      path: normalizedPath,
      reason: "manual-diagnostics-delete",
    });
    if (options.refreshHost !== false) {
      refreshPanelLiveState();
    }
    return {
      ok: deleteResult?.ok !== false,
      deleted: deleteResult?.deleted === true,
      missing: deleteResult?.missing === true,
      path: normalizedPath,
      entries: manifestResult?.entries || [],
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority diagnostics artifact delete failed";
    updateGraphPersistenceState({
      authorityDiagnosticsArtifactsError: message,
      authorityDiagnosticsArtifactsUpdatedAt: new Date().toISOString(),
    });
    if (options.refreshHost !== false) {
      refreshPanelLiveState();
    }
    return {
      ok: false,
      error: message,
    };
  }
}

async function writeAuthorityLukerCheckpointBlob(
  checkpoint = null,
  { chatId = "", reason = "luker-checkpoint", signal = undefined } = {},
) {
  if (!checkpoint || !shouldUseAuthorityBlobCheckpoint()) {
    return {
      ok: false,
      reason: "authority-blob-unavailable",
    };
  }
  const normalizedChatId = normalizeChatIdCandidate(chatId || checkpoint.chatId);
  const safeChatId = buildAuthorityBlobSafeSlug(normalizedChatId);
  const hash = buildAuthorityBlobFileHash(normalizedChatId || safeChatId);
  const path = `user/files/ST-BME_luker_checkpoint_${safeChatId}-${hash}.json`;
  try {
    const adapter = getAuthorityBlobAdapter();
    const result = await adapter.writeJson(path, checkpoint, {
      signal,
      metadata: {
        chatId: normalizedChatId,
        revision: Number(checkpoint?.revision || 0),
        reason: String(reason || ""),
        kind: "luker-checkpoint",
      },
    });
    const event = {
      action: "checkpoint-write",
      ok: result?.ok !== false,
      backend: "authority-blob",
      path: result?.path || path,
      reason: String(reason || ""),
      revision: Number(checkpoint?.revision || 0),
    };
    recordAuthorityBlobSnapshot(event);
    updateGraphPersistenceState({
      authorityBlobCheckpointPath: event.path,
      authorityBlobCheckpointRevision: event.revision,
      authorityBlobCheckpointUpdatedAt: new Date().toISOString(),
    });
    return {
      ok: event.ok,
      path: event.path,
      result,
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Blob checkpoint failed";
    recordAuthorityBlobSnapshot({
      action: "checkpoint-write",
      ok: false,
      backend: "authority-blob",
      path,
      reason: String(reason || ""),
      error: message,
      revision: Number(checkpoint?.revision || 0),
    });
    return {
      ok: false,
      path,
      reason: "authority-blob-checkpoint-error",
      error,
    };
  }
}

async function readAuthorityLukerCheckpointBlob(chatId = "", options = {}) {
  if (!shouldUseAuthorityBlobCheckpoint()) {
    return {
      ok: false,
      exists: false,
      reason: "authority-blob-unavailable",
    };
  }
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      ok: false,
      exists: false,
      reason: "missing-chat-id",
    };
  }
  const safeChatId = buildAuthorityBlobSafeSlug(normalizedChatId);
  const hash = buildAuthorityBlobFileHash(normalizedChatId || safeChatId);
  const path = `user/files/ST-BME_luker_checkpoint_${safeChatId}-${hash}.json`;
  try {
    const adapter = getAuthorityBlobAdapter();
    const result = await adapter.readJson(path, options);
    const exists = Boolean(result?.exists && result?.payload);
    recordAuthorityBlobSnapshot({
      action: "checkpoint-read",
      ok: result?.ok !== false,
      backend: "authority-blob",
      path: result?.path || path,
      reason: exists ? "checkpoint-found" : "checkpoint-missing",
      revision: Number(result?.payload?.revision || 0),
    });
    updateGraphPersistenceState({
      authorityBlobCheckpointPath: result?.path || path,
      authorityBlobCheckpointRevision: Number(result?.payload?.revision || 0),
      authorityBlobCheckpointUpdatedAt: new Date().toISOString(),
    });
    return {
      ok: result?.ok !== false,
      exists,
      path: result?.path || path,
      checkpoint: exists ? result.payload : null,
      result,
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Blob checkpoint read failed";
    recordAuthorityBlobSnapshot({
      action: "checkpoint-read",
      ok: false,
      backend: "authority-blob",
      path,
      reason: "authority-blob-checkpoint-read-error",
      error: message,
    });
    return {
      ok: false,
      exists: false,
      path,
      reason: "authority-blob-checkpoint-read-error",
      error,
    };
  }
}

async function readLukerGraphSidecarV2WithAuthorityBlob(context = null, options = {}) {
  const sidecar = await readLukerGraphSidecarV2(context, options);
  if (sidecar?.checkpoint) return sidecar;
  const chatId =
    normalizeChatIdCandidate(options.chatId) ||
    normalizeChatIdCandidate(sidecar?.manifest?.chatId) ||
    normalizeChatIdCandidate(getCurrentChatId());
  const blobResult = await readAuthorityLukerCheckpointBlob(chatId);
  if (!blobResult?.exists || !blobResult?.checkpoint) return sidecar;
  return {
    ...(sidecar || {}),
    checkpoint: blobResult.checkpoint,
    authorityBlobCheckpoint: {
      path: blobResult.path,
      backend: "authority-blob",
    },
  };
}

async function exportAuthoritySqlSnapshotProbe(chatId = "", settings = getSettings()) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const db = new AuthorityGraphStore(
    normalizedChatId,
    buildAuthorityGraphStoreOptions(settings),
  );
  try {
    await db.open();
    return await db.exportSnapshotProbe();
  } finally {
    await db.close?.().catch(() => null);
  }
}

async function readAuthorityTriviumStat({
  chatId = "",
  collectionId = "",
  settings = getSettings(),
} = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const normalizedCollectionId =
    normalizeChatIdCandidate(collectionId) ||
    buildVectorCollectionId(normalizedChatId);
  const config = normalizeAuthorityVectorConfig(
    settings,
    buildAuthorityGraphStoreOptions(settings),
  );
  const client = createAuthorityTriviumClient(config, {
    fetchImpl: globalThis.fetch?.bind(globalThis),
    headerProvider:
      typeof getRequestHeaders === "function" ? () => getRequestHeaders() : null,
  });
  return await client.stat({
    namespace: normalizedCollectionId,
    collectionId: normalizedCollectionId,
    chatId: normalizedChatId,
  });
}

async function runAuthorityConsistencyAudit(options = {}) {
  const settings = getSettings();
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  const updatedAt = new Date().toISOString();
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  if (!chatId) {
    return {
      success: false,
      error: "missing-chat-id",
    };
  }

  updateGraphPersistenceState({
    authorityConsistencyState: "running",
    authorityConsistencyUpdatedAt: updatedAt,
    authorityConsistencyError: "",
  });
  refreshPanelLiveState();

  try {
    const collectionId =
      normalizeChatIdCandidate(options.collectionId) ||
      normalizeChatIdCandidate(currentGraph?.vectorIndexState?.collectionId) ||
      buildVectorCollectionId(chatId);
    const [sqlProbe, triviumProbe, blobProbe] = await Promise.all([
      capability.storagePrimaryReady
        ? exportAuthoritySqlSnapshotProbe(chatId, settings)
            .then((value) => ({ value, error: null }))
            .catch((error) => ({ value: null, error }))
        : Promise.resolve({ value: null, error: null }),
      capability.triviumPrimaryReady
        ? readAuthorityTriviumStat({
            chatId,
            collectionId,
            settings,
          })
            .then((value) => ({ value, error: null }))
            .catch((error) => ({ value: null, error }))
        : Promise.resolve({ value: null, error: null }),
      capability.blobReady
        ? readAuthorityLukerCheckpointBlob(chatId)
            .then((value) => ({ value, error: null }))
            .catch((error) => ({ value: null, error }))
        : Promise.resolve({ value: null, error: null }),
    ]);
    const audit = buildAuthorityConsistencyAudit({
      updatedAt,
      chatId,
      collectionId,
      capability,
      runtimeGraph: currentGraph,
      graphPersistenceState,
      sqlSnapshot: sqlProbe.value,
      sqlError: sqlProbe.error,
      triviumStat: triviumProbe.value,
      triviumError: triviumProbe.error,
      blobResult: blobProbe.value,
      blobError: blobProbe.error,
      lastJob: graphPersistenceState.authorityLastJob,
    });
    updateGraphPersistenceState({
      authorityConsistencyState: audit.summary.level,
      authorityConsistencyAudit: cloneRuntimeDebugValue(audit, null),
      authorityConsistencyUpdatedAt: updatedAt,
      authorityConsistencyError: "",
    });
    refreshPanelLiveState();
    return {
      success: true,
      audit,
    };
  } catch (error) {
    const message =
      error?.message || String(error) || "Authority consistency audit failed";
    updateGraphPersistenceState({
      authorityConsistencyState: "error",
      authorityConsistencyUpdatedAt: updatedAt,
      authorityConsistencyError: message,
    });
    refreshPanelLiveState();
    return {
      success: false,
      error: message,
    };
  }
}

async function restoreAuthorityCheckpointFromBlob(options = {}) {
  const settings = getSettings();
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  const updatedAt = new Date().toISOString();
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  if (!chatId) {
    return {
      success: false,
      error: "missing-chat-id",
    };
  }
  if (!capability.storagePrimaryReady) {
    updateGraphPersistenceState({
      authorityCheckpointRestoreState: "error",
      authorityCheckpointRestoreUpdatedAt: updatedAt,
      authorityCheckpointRestoreError: "Authority SQL unavailable",
    });
    refreshPanelLiveState();
    return {
      success: false,
      error: "Authority SQL unavailable",
    };
  }

  updateGraphPersistenceState({
    authorityCheckpointRestoreState: "running",
    authorityCheckpointRestoreUpdatedAt: updatedAt,
    authorityCheckpointRestoreError: "",
  });
  refreshPanelLiveState();

  let targetDb = null;
  try {
    const blobResult = await readAuthorityLukerCheckpointBlob(chatId);
    if (!blobResult?.exists || !blobResult?.checkpoint) {
      const message = blobResult?.reason || "Authority checkpoint missing";
      updateGraphPersistenceState({
        authorityCheckpointRestoreState: "error",
        authorityCheckpointRestoreUpdatedAt: updatedAt,
        authorityCheckpointRestoreError: message,
      });
      refreshPanelLiveState();
      return {
        success: false,
        error: message,
      };
    }

    targetDb = new AuthorityGraphStore(chatId, buildAuthorityGraphStoreOptions(settings));
    const restoreResult = await applyAuthorityCheckpointToStore(
      targetDb,
      blobResult.checkpoint,
      {
        chatId,
        path: blobResult.path,
        source: "authority-blob-checkpoint-restore",
        storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
        storageMode: AUTHORITY_GRAPH_STORE_MODE,
        markSyncDirty: false,
      },
    );
    await targetDb.close?.().catch(() => null);
    targetDb = null;

    const preferredStore = getPreferredGraphLocalStorePresentationSync(settings);
    const authorityActive =
      isAuthorityGraphStorePresentation(preferredStore) ||
      isAuthorityGraphStoreDb(currentDb);
    if (authorityActive) {
      await refreshCurrentChatLocalStoreBinding({
        chatId,
        forceCapabilityRefresh: true,
        reopenCurrentDb: true,
        source: "authority-checkpoint-restore",
      });
      syncGraphLoadFromLiveContext({
        source: "authority-checkpoint-restore",
        force: true,
      });
    }

    const auditResult = await runAuthorityConsistencyAudit({ chatId });
    const result = {
      restored: restoreResult.restored === true,
      revision: Number(restoreResult.revision || 0),
      path: blobResult.path,
      checkpointRevision: Number(blobResult?.checkpoint?.revision || 0),
      reloadApplied: authorityActive,
      auditSummary: auditResult?.audit?.summary || null,
      auditDrift: auditResult?.audit?.drift || null,
    };
    updateGraphPersistenceState({
      authorityCheckpointRestoreState: restoreResult.restored === true ? "success" : "error",
      authorityCheckpointRestoreResult: cloneRuntimeDebugValue(result, null),
      authorityCheckpointRestoreUpdatedAt: updatedAt,
      authorityCheckpointRestoreError:
        restoreResult.restored === true
          ? ""
          : String(restoreResult.reason || restoreResult.error || "restore-failed"),
      authorityBlobCheckpointPath: blobResult.path,
      authorityBlobCheckpointRevision: Number(blobResult?.checkpoint?.revision || 0),
      authorityBlobCheckpointUpdatedAt: updatedAt,
    });
    refreshPanelLiveState();
    return {
      success: restoreResult.restored === true,
      result,
    };
  } catch (error) {
    const message =
      error?.message || String(error) || "Authority checkpoint restore failed";
    updateGraphPersistenceState({
      authorityCheckpointRestoreState: "error",
      authorityCheckpointRestoreUpdatedAt: updatedAt,
      authorityCheckpointRestoreError: message,
    });
    refreshPanelLiveState();
    return {
      success: false,
      error: message,
    };
  } finally {
    await targetDb?.close?.().catch(() => null);
  }
}

async function writeAuthorityCheckpointFromCurrentGraph(options = {}) {
  const settings = getSettings();
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  const updatedAt = new Date().toISOString();
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId || currentGraph?.chatId,
  );
  if (!chatId) {
    return {
      success: false,
      error: "missing-chat-id",
    };
  }
  if (!capability.blobReady || !shouldUseAuthorityBlobCheckpoint()) {
    return {
      success: false,
      error: "Authority Blob unavailable",
    };
  }

  ensureCurrentGraphRuntimeState();
  if (!currentGraph) {
    return {
      success: false,
      error: "Authority runtime graph unavailable",
    };
  }

  const revision = Math.max(
    1,
    Number(options.revision || 0),
    Number(currentGraph?.meta?.revision || 0),
    Number(getGraphPersistedRevision(currentGraph) || 0),
    Number(graphPersistenceState.revision || 0),
  );
  const integrity =
    normalizeChatIdCandidate(options.integrity) ||
    normalizeChatIdCandidate(getGraphPersistenceMeta(currentGraph)?.integrity) ||
    getChatMetadataIntegrity(getContext()) ||
    graphPersistenceState.metadataIntegrity;
  const reason = String(options.reason || "manual-authority-checkpoint");
  const checkpoint = buildLukerGraphCheckpointV2(currentGraph, {
    revision,
    chatId,
    integrity,
    reason,
    storageTier: "authority-sql-primary",
    persistedAt: updatedAt,
  });
  if (!checkpoint) {
    return {
      success: false,
      error: "Authority checkpoint payload unavailable",
    };
  }

  const writeResult = await writeAuthorityLukerCheckpointBlob(checkpoint, {
    chatId,
    reason,
    signal: options.signal,
  });
  if (!writeResult?.ok) {
    return {
      success: false,
      error:
        writeResult?.error?.message ||
        writeResult?.reason ||
        "authority-blob-checkpoint-write-failed",
    };
  }

  const auditResult = await runAuthorityConsistencyAudit({
    chatId,
    collectionId:
      normalizeChatIdCandidate(options.collectionId) ||
      normalizeChatIdCandidate(currentGraph?.vectorIndexState?.collectionId) ||
      buildVectorCollectionId(chatId),
  }).catch(() => null);
  return {
    success: true,
    result: {
      path: writeResult.path,
      revision,
      checkpointRevision: Number(checkpoint.revision || revision || 0),
      auditSummary: auditResult?.audit?.summary || null,
      auditActions: auditResult?.audit?.actions || [],
    },
  };
}

async function rebuildAuthorityTrivium(options = {}) {
  const vectorConfig = options.config || getEmbeddingConfig();
  const validation = validateVectorConfig(vectorConfig);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || "Authority Trivium 配置无效",
    };
  }

  const range = options.range || null;
  const reason = String(options.reason || "authority-trivium-rebuild");
  if (!range && options.useJobs !== false && shouldUseAuthorityJobs(vectorConfig)) {
    const jobResult = await submitAuthorityVectorRebuildJob({
      config: vectorConfig,
      range,
      purge: options.purge !== false,
      signal: options.signal,
    });
    if (jobResult?.submitted) {
      saveGraphToChat({ reason: `${reason}-job-submitted` });
      return {
        success: true,
        submitted: true,
        terminal: false,
        mode: "job",
        job: jobResult.job,
      };
    }
    if (jobResult?.error) {
      const fallbackResult = await syncVectorState({
        force: true,
        purge: isBackendVectorConfig(vectorConfig) || isAuthorityVectorConfig(vectorConfig),
        range,
        signal: options.signal,
      });
      if (fallbackResult?.aborted) {
        return {
          success: false,
          aborted: true,
          error: "aborted",
        };
      }
      if (fallbackResult?.error) {
        return {
          success: false,
          error: fallbackResult.error,
        };
      }
      saveGraphToChat({ reason: `${reason}-complete` });
      return {
        success: true,
        submitted: false,
        terminal: true,
        mode: "local-fallback",
        fallbackError: jobResult.error,
        result: fallbackResult,
        stats: fallbackResult?.stats || getVectorIndexStats(currentGraph),
      };
    }
  }

  const result = await syncVectorState({
    force: true,
    purge: !range && (isBackendVectorConfig(vectorConfig) || isAuthorityVectorConfig(vectorConfig)),
    range,
    signal: options.signal,
  });
  if (result?.aborted) {
    return {
      success: false,
      aborted: true,
      error: "aborted",
    };
  }
  if (result?.error) {
    return {
      success: false,
      error: result.error,
    };
  }
  saveGraphToChat({ reason: `${reason}-complete` });
  return {
    success: true,
    submitted: false,
    terminal: true,
    mode: "local",
    result,
    stats: result?.stats || getVectorIndexStats(currentGraph),
  };
}

async function runAuthorityConsistencyRepairPlan(options = {}) {
  const updatedAt = new Date().toISOString();
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || graphPersistenceState.chatId,
  );
  if (!chatId) {
    return {
      success: false,
      error: "missing-chat-id",
    };
  }

  let audit =
    options.audit && typeof options.audit === "object" && !Array.isArray(options.audit)
      ? options.audit
      : graphPersistenceState.authorityConsistencyAudit &&
          typeof graphPersistenceState.authorityConsistencyAudit === "object" &&
          !Array.isArray(graphPersistenceState.authorityConsistencyAudit)
        ? graphPersistenceState.authorityConsistencyAudit
        : null;
  if (!audit) {
    const auditResult = await runAuthorityConsistencyAudit({
      chatId,
      collectionId: options.collectionId,
    });
    if (!auditResult?.success || !auditResult?.audit) {
      updateGraphPersistenceState({
        authorityRepairState: "error",
        authorityRepairUpdatedAt: updatedAt,
        authorityRepairError: auditResult?.error || "Authority 审计失败，无法继续修复",
      });
      refreshPanelLiveState();
      return {
        success: false,
        error: auditResult?.error || "Authority 审计失败，无法继续修复",
      };
    }
    audit = auditResult.audit;
  }

  const plan = buildAuthorityConsistencyRepairPlan(audit);
  if (plan.blockedIssueCodes.length > 0 && options.force !== true) {
    const message = `存在阻塞问题：${plan.blockedIssueCodes.join(", ")}`;
    updateGraphPersistenceState({
      authorityRepairState: "error",
      authorityRepairUpdatedAt: updatedAt,
      authorityRepairError: message,
      authorityRepairResult: cloneRuntimeDebugValue(
        {
          plan,
          steps: [],
          auditSummary: audit.summary || null,
        },
        null,
      ),
    });
    refreshPanelLiveState();
    return {
      success: false,
      error: message,
      plan,
      audit,
    };
  }

  if (!plan.ok) {
    const result = {
      plan,
      steps: [],
      auditSummary: audit.summary || null,
      handoffRequired: false,
      finalAuditSummary: audit.summary || null,
      finalAuditDrift: audit.drift || null,
    };
    updateGraphPersistenceState({
      authorityRepairState: "success",
      authorityRepairUpdatedAt: updatedAt,
      authorityRepairError: "",
      authorityRepairResult: cloneRuntimeDebugValue(result, null),
    });
    refreshPanelLiveState();
    return {
      success: true,
      plan,
      results: [],
      audit,
      handoffRequired: false,
      repairResult: result,
    };
  }

  updateGraphPersistenceState({
    authorityRepairState: "running",
    authorityRepairUpdatedAt: updatedAt,
    authorityRepairError: "",
    authorityRepairResult: cloneRuntimeDebugValue(
      {
        plan,
        steps: [],
        auditSummary: audit.summary || null,
      },
      null,
    ),
  });
  refreshPanelLiveState();

  try {
    const stepResults = [];
    let handoffRequired = false;
    for (const step of plan.steps) {
      let stepOutcome = null;
      if (step.action === "write-authority-checkpoint") {
        stepOutcome = await writeAuthorityCheckpointFromCurrentGraph({
          chatId,
          collectionId: options.collectionId,
          reason: "authority-repair-write-checkpoint",
          signal: options.signal,
        });
        stepResults.push({
          action: step.action,
          label: step.label,
          detail: step.detail,
          success: stepOutcome?.success === true,
          submitted: false,
          terminal: true,
          result: stepOutcome?.result || null,
          error: stepOutcome?.error || "",
        });
      } else if (step.action === "restore-from-authority-blob-checkpoint") {
        stepOutcome = await restoreAuthorityCheckpointFromBlob({
          chatId,
          reason: "authority-repair-restore-checkpoint",
          signal: options.signal,
        });
        stepResults.push({
          action: step.action,
          label: step.label,
          detail: step.detail,
          success: stepOutcome?.success === true,
          submitted: false,
          terminal: true,
          result: stepOutcome?.result || null,
          error: stepOutcome?.error || "",
        });
      } else if (step.action === "rebuild-authority-trivium") {
        stepOutcome = await rebuildAuthorityTrivium({
          chatId,
          reason: "authority-repair-trivium-rebuild",
          signal: options.signal,
        });
        handoffRequired = stepOutcome?.submitted === true && stepOutcome?.terminal === false;
        stepResults.push({
          action: step.action,
          label: step.label,
          detail: step.detail,
          success: stepOutcome?.success === true,
          submitted: stepOutcome?.submitted === true,
          terminal: stepOutcome?.terminal !== false,
          mode: stepOutcome?.mode || "",
          job: cloneRuntimeDebugValue(stepOutcome?.job, null),
          result: stepOutcome?.result || null,
          stats: cloneRuntimeDebugValue(stepOutcome?.stats, null),
          fallbackError: stepOutcome?.fallbackError || "",
          error: stepOutcome?.error || "",
        });
      } else {
        stepResults.push({
          action: step.action,
          label: step.label,
          detail: step.detail,
          success: false,
          submitted: false,
          terminal: true,
          error: `unsupported action: ${step.action}`,
        });
      }

      const latestStep = stepResults[stepResults.length - 1];
      if (!latestStep?.success) {
        const failedResult = {
          plan,
          steps: stepResults,
          auditSummary: audit.summary || null,
          handoffRequired: false,
          finalAuditSummary: null,
          finalAuditDrift: null,
        };
        updateGraphPersistenceState({
          authorityRepairState: "error",
          authorityRepairUpdatedAt: new Date().toISOString(),
          authorityRepairError: latestStep?.error || `${step.label} 失败`,
          authorityRepairResult: cloneRuntimeDebugValue(failedResult, null),
        });
        refreshPanelLiveState();
        return {
          success: false,
          error: latestStep?.error || `${step.label} 失败`,
          plan,
          results: stepResults,
          audit,
          handoffRequired: false,
          repairResult: failedResult,
        };
      }
      if (handoffRequired) {
        break;
      }
    }

    const finalAuditResult = handoffRequired
      ? null
      : await runAuthorityConsistencyAudit({
          chatId,
          collectionId: options.collectionId,
        }).catch(() => null);
    const finishedAt = new Date().toISOString();
    const repairResult = {
      plan,
      steps: stepResults,
      auditSummary: audit.summary || null,
      handoffRequired,
      finalAuditSummary: finalAuditResult?.audit?.summary || null,
      finalAuditDrift: finalAuditResult?.audit?.drift || null,
    };
    updateGraphPersistenceState({
      authorityRepairState: handoffRequired ? "running" : "success",
      authorityRepairUpdatedAt: finishedAt,
      authorityRepairError: "",
      authorityRepairResult: cloneRuntimeDebugValue(repairResult, null),
    });
    refreshPanelLiveState();
    return {
      success: true,
      plan,
      results: stepResults,
      audit: finalAuditResult?.audit || audit,
      handoffRequired,
      repairResult,
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority repair orchestration failed";
    updateGraphPersistenceState({
      authorityRepairState: "error",
      authorityRepairUpdatedAt: new Date().toISOString(),
      authorityRepairError: message,
    });
    refreshPanelLiveState();
    return {
      success: false,
      error: message,
      plan,
      audit,
    };
  }
}

async function submitAuthorityVectorRebuildJob({
  config = null,
  range = null,
  purge = true,
  signal = undefined,
} = {}) {
  const vectorConfig = config || getEmbeddingConfig();
  if (!shouldUseAuthorityJobs(vectorConfig)) {
    return {
      submitted: false,
      fallbackRequired: true,
      reason: "authority-jobs-unavailable",
    };
  }

  ensureCurrentGraphRuntimeState();
  const chatId = getCurrentChatId();
  const collectionId =
    currentGraph?.vectorIndexState?.collectionId || buildVectorCollectionId(chatId);
  const kind = range
    ? "authority.vector.rebuild-range"
    : "authority.vector.rebuild";
  const idempotencyKey = buildAuthorityJobIdempotencyKey({
    kind,
    chatId,
    collectionId,
    revision:
      currentGraph?.meta?.revision ||
      currentGraph?.historyState?.extractionCount ||
      graphPersistenceState?.revision ||
      0,
    range,
  });
  const payload = {
    chatId,
    collectionId,
    namespace: collectionId,
    modelScope: getVectorModelScope(vectorConfig),
    source: "authority-trivium",
    purge: Boolean(purge),
    range: range || null,
    graphRevision:
      currentGraph?.meta?.revision || graphPersistenceState?.revision || 0,
    idempotencyKey,
  };

  try {
    const adapter = getAuthorityJobAdapter();
    const job = await adapter.submit(kind, payload, {
      idempotencyKey,
      signal,
    });
    recordAuthorityJobSnapshot(job, { kind, queueState: "running" });
    if (currentGraph?.vectorIndexState) {
      currentGraph.vectorIndexState.dirty = true;
      currentGraph.vectorIndexState.dirtyReason = "authority-vector-rebuild-job-submitted";
      currentGraph.vectorIndexState.lastWarning =
        "Authority 向量重建 Job 已提交，等待服务端完成";
      currentGraph.vectorIndexState.lastRebuildJob =
        cloneRuntimeDebugValue(job, null);
    }
    setLastVectorStatus(
      "向量重建 Job 已提交",
      `${kind} · ${job.id || "pending"} · ${job.status || "queued"}`,
      "running",
      { syncRuntime: true },
    );
    void refreshAuthorityRecentJobs({ reason: "authority-job-submitted" });
    void startTrackingAuthorityJob(job, { kind, chatId });
    return {
      submitted: true,
      fallbackRequired: false,
      job,
      stats: getVectorIndexStats(currentGraph),
      insertedHashes: [],
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Job 提交失败";
    recordAuthorityJobSnapshot(null, {
      kind,
      queueState: "fallback",
      error: message,
    });
    return {
      submitted: false,
      fallbackRequired: true,
      error: message,
    };
  }
}

function createAbortTrackingError(reason = "authority-job-tracking-stopped") {
  if (typeof DOMException !== "undefined") {
    return new DOMException(reason, "AbortError");
  }
  return Object.assign(new Error(reason), { name: "AbortError" });
}

function stopTrackingAuthorityJob(reason = "authority-job-tracking-stopped") {
  if (authorityJobPollAbortController) {
    try {
      authorityJobPollAbortController.abort(createAbortTrackingError(reason));
    } catch {
    }
  }
  authorityJobPollAbortController = null;
  authorityJobPollJobId = "";
  authorityJobPollChatId = "";
  authorityJobPollPromise = null;
  setAuthorityJobTrackingState("idle", reason);
}

function buildAuthorityJobStatusMeta(job = null, fallbackKind = "") {
  const normalizedJob =
    job && typeof job === "object" && !Array.isArray(job) ? job : {};
  const progress = Number(normalizedJob.progress || 0);
  return [
    String(fallbackKind || normalizedJob.kind || "").trim(),
    normalizedJob.id ? `job ${normalizedJob.id}` : "",
    String(normalizedJob.status || "").trim(),
    Number.isFinite(progress) && progress > 0
      ? `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`
      : "",
    String(normalizedJob.error || "").trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}

function syncAuthorityVectorJobState(job = null) {
  if (!currentGraph?.vectorIndexState) return;
  const normalizedJob =
    job && typeof job === "object" && !Array.isArray(job) ? job : {};
  currentGraph.vectorIndexState.lastRebuildJob =
    cloneRuntimeDebugValue(normalizedJob, null);
  currentGraph.vectorIndexState.lastAuthorityJobId = String(normalizedJob.id || "");
  currentGraph.vectorIndexState.lastAuthorityJobStatus = String(
    normalizedJob.status || "",
  );
  currentGraph.vectorIndexState.lastAuthorityJobProgress = Number(
    normalizedJob.progress || 0,
  );
  if (!normalizedJob.id) {
    return;
  }
  if (normalizedJob.terminal) {
    if (normalizedJob.success) {
      currentGraph.vectorIndexState.dirty = false;
      currentGraph.vectorIndexState.dirtyReason = "";
      currentGraph.vectorIndexState.lastWarning = "";
    } else {
      currentGraph.vectorIndexState.dirty = true;
      currentGraph.vectorIndexState.dirtyReason =
        String(normalizedJob.status || "failed") || "failed";
      currentGraph.vectorIndexState.lastWarning =
        String(normalizedJob.error || normalizedJob.status || "Authority Job 失败") ||
        "Authority Job 失败";
    }
    return;
  }
  currentGraph.vectorIndexState.dirty = true;
  currentGraph.vectorIndexState.dirtyReason =
    "authority-vector-rebuild-job-running";
  currentGraph.vectorIndexState.lastWarning =
    buildAuthorityJobStatusMeta(normalizedJob, normalizedJob.kind) ||
    "Authority Job 运行中";
}

async function startTrackingAuthorityJob(job = null, options = {}) {
  const normalizedJob =
    job && typeof job === "object" && !Array.isArray(job) ? job : {};
  const jobId = String(normalizedJob.id || "").trim();
  const trackedChatId =
    normalizeChatIdCandidate(options.chatId) ||
    normalizeChatIdCandidate(getCurrentChatId()) ||
    normalizeChatIdCandidate(graphPersistenceState.chatId);
  if (!jobId || !trackedChatId) {
    return null;
  }

  stopTrackingAuthorityJob("authority-job-replaced");
  const controller = new AbortController();
  authorityJobPollAbortController = controller;
  authorityJobPollJobId = jobId;
  authorityJobPollChatId = trackedChatId;
  const effectiveKind = String(options.kind || normalizedJob.kind || "").trim();
  const jobConfig = normalizeAuthorityJobConfig(getSettings());
  setAuthorityJobTrackingState(
    jobConfig.preferStream !== false ? "stream" : "polling",
    jobConfig.preferStream !== false ? "stream-first" : "polling-only",
  );

  const applyTrackedJobUpdate = async (nextJob, state = {}) => {
    const normalizedNextJob =
      nextJob && typeof nextJob === "object" && !Array.isArray(nextJob) ? nextJob : {};
    const queueState = normalizedNextJob.terminal
      ? normalizedNextJob.success
        ? "success"
        : "failed"
      : normalizedNextJob.id
        ? "running"
        : "idle";
    recordAuthorityJobSnapshot(normalizedNextJob, {
      kind: effectiveKind || normalizedNextJob.kind || "",
      queueState,
    });
    syncAuthorityVectorJobState(normalizedNextJob);
    const meta = buildAuthorityJobStatusMeta(
      normalizedNextJob,
      effectiveKind || normalizedNextJob.kind,
    );
    if (normalizedNextJob.terminal) {
      setLastVectorStatus(
        normalizedNextJob.success ? "Authority Job 已完成" : "Authority Job 失败",
        meta,
        normalizedNextJob.success ? "success" : "error",
        { syncRuntime: true },
      );
      void refreshAuthorityRecentJobs({
        reason: normalizedNextJob.success
          ? "authority-job-completed"
          : "authority-job-failed",
      });
      const activeChatId =
        normalizeChatIdCandidate(getCurrentChatId()) ||
        normalizeChatIdCandidate(graphPersistenceState.chatId);
      if (activeChatId && activeChatId === trackedChatId) {
        saveGraphToChat({
          reason: normalizedNextJob.success
            ? "authority-vector-rebuild-job-completed"
            : "authority-vector-rebuild-job-failed",
        });
      }
    } else {
      setLastVectorStatus(
        state.phase === "initial" ? "Authority Job 已提交" : "Authority Job 运行中",
        meta,
        "running",
        { syncRuntime: true },
      );
    }
    refreshPanelLiveState();
  };

  authorityJobPollPromise = trackAuthorityJobUntilTerminal({
    initialJob: normalizedJob,
    pollIntervalMs: jobConfig.pollIntervalMs,
    timeoutMs: jobConfig.waitTimeoutMs,
    signal: controller.signal,
    streamJob:
      jobConfig.preferStream !== false
        ? async (targetJobId) => {
            const adapter = getAuthorityJobAdapter();
            return await adapter.stream(targetJobId, { signal: controller.signal });
          }
        : null,
    loadJob: async (targetJobId) => {
      const activeChatId =
        normalizeChatIdCandidate(getCurrentChatId()) ||
        normalizeChatIdCandidate(graphPersistenceState.chatId);
      if (activeChatId && activeChatId !== trackedChatId) {
        controller.abort(createAbortTrackingError("authority-job-chat-changed"));
        throw controller.signal.reason;
      }
      const adapter = getAuthorityJobAdapter();
      return await adapter.get(targetJobId, { signal: controller.signal });
    },
    onUpdate: applyTrackedJobUpdate,
    onModeChange: async ({ mode, reason }) => {
      if (authorityJobPollAbortController !== controller) {
        return;
      }
      setAuthorityJobTrackingState(mode, reason);
      refreshPanelLiveState();
    },
  })
    .catch((error) => {
      if (isAbortError(error)) {
        if (authorityJobPollAbortController === controller) {
          const abortReason = String(
            controller.signal?.reason?.message || controller.signal?.reason || "authority-job-tracking-stopped",
          );
          setAuthorityJobTrackingState("idle", abortReason);
          refreshPanelLiveState();
        }
        return null;
      }
      const message = error?.message || String(error) || "Authority Job 状态轮询失败";
      const failedJob = {
        ...normalizedJob,
        id: jobId,
        kind: effectiveKind || normalizedJob.kind || "",
        status: "error",
        terminal: true,
        success: false,
        error: message,
      };
      recordAuthorityJobSnapshot(failedJob, {
        kind: effectiveKind || normalizedJob.kind || "",
        queueState: "error",
      });
      syncAuthorityVectorJobState(failedJob);
      setAuthorityJobTrackingState("error", message);
      setLastVectorStatus(
        "Authority Job 失败",
        buildAuthorityJobStatusMeta(failedJob, effectiveKind || normalizedJob.kind),
        "error",
        { syncRuntime: true },
      );
      refreshPanelLiveState();
      return failedJob;
    })
    .finally(() => {
      if (authorityJobPollAbortController === controller) {
        authorityJobPollAbortController = null;
        authorityJobPollJobId = "";
        authorityJobPollChatId = "";
        authorityJobPollPromise = null;
      }
    });
  return authorityJobPollPromise;
}

async function requeueAuthorityJob(jobId, options = {}) {
  try {
    const adapter = getAuthorityJobAdapter();
    const job = await adapter.requeue(jobId, options);
    recordAuthorityJobSnapshot(job, { queueState: "running" });
    syncAuthorityVectorJobState(job);
    saveGraphToChat({ reason: "authority-vector-rebuild-job-requeued" });
    void refreshAuthorityRecentJobs({ reason: "authority-job-requeued" });
    void startTrackingAuthorityJob(job, {
      kind: job?.kind || graphPersistenceState.authorityLastJobKind,
      chatId: getCurrentChatId(),
    });
    return { success: true, job };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Job 重试失败";
    recordAuthorityJobSnapshot(null, { queueState: "error", error: message });
    return { success: false, error: message };
  }
}

function recordIgnoredMutationEvent(eventName = "", detail = {}) {
  updateGraphPersistenceState({
    lastIgnoredMutationEvent: String(eventName || ""),
    lastIgnoredMutationReason: String(
      detail?.reason || detail?.message || "lightweight-only",
    ),
  });
}

function recordLukerHookPhase(phase = "", detail = {}) {
  updateGraphPersistenceState({
    lastHookPhase: String(phase || ""),
    chatStateTarget:
      cloneRuntimeDebugValue(detail?.chatStateTarget, null) ||
      graphPersistenceState.chatStateTarget ||
      resolveCurrentChatStateTarget(getContext()),
    lightweightHostMode:
      detail?.lightweightHostMode ??
      graphPersistenceState.lightweightHostMode ??
      isBmeLightweightHostMode(getContext()),
  });
}

function updateLukerProjectionState(patch = {}) {
  const previous =
    graphPersistenceState.projectionState &&
    typeof graphPersistenceState.projectionState === "object" &&
    !Array.isArray(graphPersistenceState.projectionState)
      ? graphPersistenceState.projectionState
      : {
          runtime: { status: "idle", updatedAt: 0, reason: "" },
          persistent: { status: "idle", updatedAt: 0, reason: "" },
        };
  const nextState = {
    ...cloneRuntimeDebugValue(previous, previous),
    ...cloneRuntimeDebugValue(patch, {}),
  };
  updateGraphPersistenceState({
    projectionState: nextState,
  });
  return nextState;
}

function readPersistDeltaDiagnosticsNow() {
  if (typeof performance === "object" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function readLoadDiagnosticsNow() {
  return readPersistDeltaDiagnosticsNow();
}

function normalizeLoadDiagnosticsMs(value = 0) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function normalizePersistDeltaDiagnosticsMs(value = 0) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function updatePersistDeltaDiagnostics(snapshot = null) {
  const nextSnapshot =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? {
          ...(graphPersistenceState.persistDelta &&
          typeof graphPersistenceState.persistDelta === "object" &&
          !Array.isArray(graphPersistenceState.persistDelta)
            ? cloneRuntimeDebugValue(graphPersistenceState.persistDelta, {})
            : {}),
          ...cloneRuntimeDebugValue(snapshot, {}),
          updatedAt: new Date().toISOString(),
        }
      : null;
  updateGraphPersistenceState({ persistDelta: nextSnapshot });
  return nextSnapshot;
}

function updateLoadDiagnostics(snapshot = null) {
  const nextSnapshot =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? {
          ...(graphPersistenceState.loadDiagnostics &&
          typeof graphPersistenceState.loadDiagnostics === "object" &&
          !Array.isArray(graphPersistenceState.loadDiagnostics)
            ? cloneRuntimeDebugValue(graphPersistenceState.loadDiagnostics, {})
            : {}),
          ...cloneRuntimeDebugValue(snapshot, {}),
          updatedAt: new Date().toISOString(),
        }
      : null;
  updateGraphPersistenceState({ loadDiagnostics: nextSnapshot });
  return nextSnapshot;
}

function bumpGraphRevision(reason = "graph-mutation") {
  const nextRevision =
    Math.max(
      graphPersistenceState.revision || 0,
      graphPersistenceState.lastPersistedRevision || 0,
      graphPersistenceState.queuedPersistRevision || 0,
    ) + 1;
  updateGraphPersistenceState({
    revision: nextRevision,
    lastPersistReason: String(
      reason || graphPersistenceState.lastPersistReason || "",
    ),
  });
  return nextRevision;
}

function isGraphMetadataWriteAllowed(
  loadState = graphPersistenceState.loadState,
) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
  );
}

function isGraphReadable(loadState = graphPersistenceState.loadState) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED ||
    loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
    (loadState === GRAPH_LOAD_STATES.BLOCKED &&
      graphPersistenceState.shadowSnapshotUsed)
  );
}

function hasReadableRuntimeGraphForRecall(chatId = getCurrentChatId()) {
  if (
    !currentGraph ||
    typeof currentGraph !== "object" ||
    !Array.isArray(currentGraph.nodes) ||
    !Array.isArray(currentGraph.edges) ||
    !currentGraph.historyState ||
    typeof currentGraph.historyState !== "object" ||
    Array.isArray(currentGraph.historyState)
  ) {
    return false;
  }

  const activeChatId = normalizeChatIdCandidate(chatId);
  const runtimeChatId = normalizeChatIdCandidate(
    currentGraph.historyState.chatId,
  );

  // chatId 匹配验证：如果两者都有，必须一致
  if (activeChatId && runtimeChatId) {
    return runtimeChatId === activeChatId;
  }

  // 兜底：chatId 不可用（ST 插件环境可能无法获取 chatId），
  // 只要 currentGraph 结构完整且有节点数据，就允许召回。
  // 这对应用户能在 UI 看到图谱，但 getCurrentChatId() 返回空的场景。
  return currentGraph.nodes.length > 0 || currentGraph.edges.length > 0;
}

function hasMeaningfulRuntimeGraphForChat(
  chatId = getCurrentChatId(),
  identity = resolveCurrentChatIdentity(getContext()),
) {
  if (
    !currentGraph ||
    typeof currentGraph !== "object" ||
    !Array.isArray(currentGraph.nodes) ||
    !Array.isArray(currentGraph.edges) ||
    !currentGraph.historyState ||
    typeof currentGraph.historyState !== "object" ||
    Array.isArray(currentGraph.historyState)
  ) {
    return false;
  }

  const normalizedTargetChatId = normalizeChatIdCandidate(chatId);
  const runtimeChatId = normalizeChatIdCandidate(
    currentGraph.historyState.chatId,
  );

  if (normalizedTargetChatId && runtimeChatId) {
    const sameChat =
      areChatIdsEquivalentForResolvedIdentity(
        runtimeChatId,
        normalizedTargetChatId,
        identity,
      ) ||
      areChatIdsEquivalentForResolvedIdentity(
        normalizedTargetChatId,
        runtimeChatId,
        identity,
      );
    if (!sameChat) {
      return false;
    }
  } else if (
    normalizedTargetChatId &&
    !doesChatIdMatchResolvedGraphIdentity(normalizedTargetChatId, identity)
  ) {
    return false;
  }

  return !isGraphEffectivelyEmpty(currentGraph);
}

function isGraphReadableForRecall(
  loadState = graphPersistenceState.loadState,
  chatId = getCurrentChatId(),
) {
  if (isGraphReadable(loadState)) {
    return true;
  }

  // 当 loadState 不在正常可读状态时（如 NO_CHAT、LOADING），
  // 仍检查运行时图谱的实际结构。持久化状态机可能失同步
  // （如 getCurrentChatId 在某些 ST 环境下返回空导致 loadState 卡在 NO_CHAT），
  // 但 currentGraph 已经通过其他路径（IndexedDB probe / metadata fallback）加载了数据。
  return hasReadableRuntimeGraphForRecall(chatId);
}

function createGraphLoadUiStatus() {
  const state = graphPersistenceState.loadState;
  const chatId = graphPersistenceState.chatId || getCurrentChatId();
  switch (state) {
    case GRAPH_LOAD_STATES.NO_CHAT:
      return createUiStatus("待命", "当前尚未进入聊天", "idle");
    case GRAPH_LOAD_STATES.LOADING:
      if (hasMeaningfulRuntimeGraphForChat(chatId)) {
        return createUiStatus(
          "图谱已暂载",
          chatId
            ? `已读到聊天 ${chatId} 的临时图谱，正在确认本地存储`
            : "已读到临时图谱，正在确认本地存储",
          "warning",
        );
      }
      return createUiStatus(
        "图谱加载中",
        chatId
          ? `正在读取聊天 ${chatId} 的 IndexedDB 图谱`
          : "正在等待聊天上下文准备完成",
        "running",
      );
    case GRAPH_LOAD_STATES.SHADOW_RESTORED:
      return createUiStatus(
        "图谱临时恢复",
        "已从本次会话临时恢复，正在等待正式聊天元数据",
        "warning",
      );
    case GRAPH_LOAD_STATES.EMPTY_CONFIRMED:
      return createUiStatus(
        "图谱待命",
        chatId ? "当前聊天还没有图谱" : "当前尚未进入聊天",
        "idle",
      );
    case GRAPH_LOAD_STATES.BLOCKED:
      return createUiStatus(
        "图谱加载受阻",
        "当前图谱未能完成 IndexedDB 确认，请稍后重试",
        "warning",
      );
    case GRAPH_LOAD_STATES.LOADED:
    default:
      return createUiStatus("待命", "已加载聊天图谱，等待下一次任务", "idle");
  }
}

function getPanelRuntimeStatus() {
  const graphStatus = createGraphLoadUiStatus();
  if (
    !graphPersistenceState.dbReady ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.BLOCKED ||
    graphPersistenceState.loadState === GRAPH_LOAD_STATES.NO_CHAT
  ) {
    return graphStatus;
  }
  return runtimeStatus;
}

function getGraphMutationBlockReason(operationLabel = "当前操作") {
  if (isRestoreLockActive()) {
    return getRestoreLockMessage(operationLabel);
  }
  const loadState = graphPersistenceState.loadState;
  if (!getCurrentChatId()) {
    return `${operationLabel}已暂停：当前尚未进入聊天。`;
  }

  if (graphPersistenceState.dbReady || isGraphLoadStateDbReady(loadState)) {
    return `${operationLabel}暂不可用。`;
  }

  switch (graphPersistenceState.loadState) {
    case GRAPH_LOAD_STATES.LOADING:
      return hasMeaningfulRuntimeGraphForChat()
        ? `${operationLabel}已暂停：当前图谱已暂载，正在确认本地存储。`
        : `${operationLabel}已暂停：正在加载 IndexedDB 图谱。`;
    case GRAPH_LOAD_STATES.SHADOW_RESTORED:
      return `${operationLabel}已暂停：当前图谱仍处于旧恢复状态，请等待 IndexedDB 初始化完成。`;
    case GRAPH_LOAD_STATES.BLOCKED:
      return `${operationLabel}已暂停：IndexedDB 初始化受阻，请稍后重试。`;
    case GRAPH_LOAD_STATES.NO_CHAT:
      return `${operationLabel}已暂停：当前尚未进入聊天。`;
    default:
      return `${operationLabel}已暂停：图谱尚未完成初始化。`;
  }
}

function ensureGraphMutationReady(
  operationLabel = "当前操作",
  { notify = true, ignoreRestoreLock = false } = {},
) {
  if (!ignoreRestoreLock && isRestoreLockActive()) {
    if (notify) {
      toastr.info(getRestoreLockMessage(operationLabel), "ST-BME");
    }
    return false;
  }
  if (graphPersistenceState.dbReady || isGraphLoadStateDbReady()) return true;
  if (notify) {
    toastr.info(getGraphMutationBlockReason(operationLabel), "ST-BME");
  }
  return false;
}

function applyGraphLoadState(
  loadState,
  {
    chatId = getCurrentChatId(),
    reason = "",
    attemptIndex = 0,
    shadowSnapshotUsed = false,
    shadowSnapshotRevision = 0,
    shadowSnapshotUpdatedAt = "",
    shadowSnapshotReason = "",
    revision = graphPersistenceState.revision,
    lastPersistedRevision = graphPersistenceState.lastPersistedRevision,
    queuedPersistRevision = graphPersistenceState.queuedPersistRevision,
    pendingPersist = graphPersistenceState.pendingPersist,
    dbReady = isGraphLoadStateDbReady(loadState),
    writesBlocked = !isGraphMetadataWriteAllowed(loadState),
    storagePrimary = graphPersistenceState.storagePrimary || "indexeddb",
    storageMode =
      graphPersistenceState.storageMode || BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
    hostProfile = graphPersistenceState.hostProfile || resolvePersistenceHostProfile(),
    primaryStorageTier =
      graphPersistenceState.primaryStorageTier ||
      buildPersistenceEnvironment(getContext(), {
        storagePrimary,
        storageMode,
      }).primaryStorageTier,
    cacheStorageTier =
      graphPersistenceState.cacheStorageTier ||
      buildPersistenceEnvironment(getContext(), {
        storagePrimary,
        storageMode,
      }).cacheStorageTier,
  } = {},
) {
  updateGraphPersistenceState({
    loadState,
    chatId: String(chatId || ""),
    reason: String(reason || ""),
    attemptIndex,
    revision,
    lastPersistedRevision,
    queuedPersistRevision,
    shadowSnapshotUsed,
    shadowSnapshotRevision,
    shadowSnapshotUpdatedAt,
    shadowSnapshotReason,
    pendingPersist,
    writesBlocked,
    dbReady,
    storagePrimary,
    storageMode,
    hostProfile,
    primaryStorageTier,
    cacheStorageTier,
  });

  if (dbReady && isGraphLoadStateDbReady(loadState)) {
    const enqueueMicrotask =
      typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
        : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      if (typeof maybeResumePendingAutoExtraction === "function") {
        void maybeResumePendingAutoExtraction(`graph-ready:${loadState}`);
      }
    });
  }
}

function createAbortError(message = "操作已终止") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfAborted(signal, message = "操作已终止") {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : createAbortError(message);
  }
}

function assertRecoveryChatStillActive(expectedChatId, label = "") {
  if (!expectedChatId) return;
  const currentIdentity = resolveCurrentChatIdentity(getContext());
  const currentId = normalizeChatIdCandidate(currentIdentity.chatId);
  const normalizedExpectedChatId = normalizeChatIdCandidate(expectedChatId);
  if (
    currentId &&
    normalizedExpectedChatId &&
    !doesChatIdMatchResolvedGraphIdentity(
      normalizedExpectedChatId,
      currentIdentity,
    )
  ) {
    throw createAbortError(
      `历史恢复已终止：聊天已从 ${normalizedExpectedChatId} 切换到 ${currentId}${label ? ` (${label})` : ""}`,
    );
  }
}

function getStageAbortLabel(stage) {
  switch (stage) {
    case "extraction":
      return "提取";
    case "vector":
      return "向量";
    case "recall":
      return "召回";
    case "history":
      return "历史恢复";
    default:
      return "当前流程";
  }
}

function beginStageAbortController(stage) {
  const controller = new AbortController();
  stageAbortControllers[stage] = controller;
  syncStageNoticeAbortAction(stage);
  return controller;
}

function finishStageAbortController(stage, controller = null) {
  if (!controller || stageAbortControllers[stage] === controller) {
    stageAbortControllers[stage] = null;
  }
}

function findAbortableStageForNotice(stage) {
  const preferred = [stage];
  if (stage === "vector") {
    preferred.push("history", "extraction", "recall");
  }

  for (const candidate of preferred) {
    const controller = stageAbortControllers[candidate];
    if (controller && !controller.signal.aborted) {
      return candidate;
    }
  }

  return null;
}

function abortStage(stage) {
  const controller = stageAbortControllers[stage];
  if (!controller || controller.signal.aborted) return false;
  controller.abort(createAbortError(`${getStageAbortLabel(stage)}已终止`));
  return true;
}

function abortRecallStageWithReason(reason = "召回已终止") {
  const controller = stageAbortControllers.recall;
  if (!controller || controller.signal.aborted) return false;
  controller.abort(createAbortError(reason));
  return true;
}

async function waitForActiveRecallToSettle(timeoutMs = 1800) {
  const pending = activeRecallPromise;
  if (!pending) {
    return {
      settled: !isRecalling,
      timedOut: false,
    };
  }

  let settled = false;
  await Promise.race([
    Promise.resolve(pending)
      .catch(() => {})
      .then(() => {
        settled = true;
      }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  return {
    settled: settled || !isRecalling,
    timedOut: !settled && isRecalling,
  };
}

function buildAbortStageAction(stage) {
  const abortStageName = findAbortableStageForNotice(stage);
  if (!abortStageName) return undefined;

  return {
    label: `终止${getStageAbortLabel(abortStageName)}`,
    kind: "danger",
    onClick: () => {
      abortStage(abortStageName);
    },
  };
}

function createNoticePanelAction() {
  return createNoticePanelActionController({
    getPanelModule: () => _panelModule,
  });
}

function dismissStageNotice(stage) {
  stageNoticeHandles[stage]?.dismiss?.();
  stageNoticeHandles[stage] = null;
}

function dismissAllStageNotices() {
  for (const stage of Object.keys(stageNoticeHandles)) {
    dismissStageNotice(stage);
  }
}

function abortAllRunningStages() {
  for (const stage of Object.keys(stageAbortControllers)) {
    abortStage(stage);
  }
}

function getStageUiStatus(stage) {
  switch (stage) {
    case "extraction":
      return lastExtractionStatus;
    case "vector":
      return lastVectorStatus;
    case "recall":
      return lastRecallStatus;
    default:
      return null;
  }
}

function syncStageNoticeAbortAction(stage) {
  const status = getStageUiStatus(stage);
  if (!status || !stageNoticeHandles[stage]) return;
  updateStageNotice(stage, status.text, status.meta, status.level, {
    title: getStageNoticeTitle(stage),
  });
}

function getStageNoticeDisplayMode(level = "info") {
  const configuredMode = getSettings()?.noticeDisplayMode;
  if (
    configuredMode === "compact" &&
    level !== "warning" &&
    level !== "error"
  ) {
    return "compact";
  }
  return "normal";
}

function refreshVisibleStageNotices() {
  for (const stage of Object.keys(stageNoticeHandles)) {
    const handle = stageNoticeHandles[stage];
    if (!handle || handle.isClosed?.()) continue;
    const status = getStageUiStatus(stage);
    if (!status) continue;
    updateStageNotice(stage, status.text, status.meta, status.level, {
      title: getStageNoticeTitle(stage),
    });
  }
}

function updateStageNotice(
  stage,
  text,
  meta = "",
  level = "info",
  options = {},
) {
  const noticeLevel = normalizeStageNoticeLevel(level);
  const busy = options.busy ?? level === "running";
  const persist = options.persist ?? busy;
  const title = options.title || getStageNoticeTitle(stage);
  const message = [text, meta].filter(Boolean).join("\n");
  const input = {
    title,
    message,
    displayMode: options.displayMode || getStageNoticeDisplayMode(noticeLevel),
    level: noticeLevel,
    busy,
    persist,
    marquee: options.noticeMarquee ?? false,
    duration_ms: options.duration_ms ?? getStageNoticeDuration(noticeLevel),
    action:
      options.action === undefined
        ? busy
          ? buildAbortStageAction(stage)
          : noticeLevel === "warning" || noticeLevel === "error"
            ? createNoticePanelAction()
            : undefined
        : options.action,
  };

  const currentHandle = stageNoticeHandles[stage];
  if (!currentHandle || currentHandle.isClosed?.()) {
    stageNoticeHandles[stage] = showManagedBmeNotice(input);
    return;
  }

  currentHandle.update(input);
}

function toPanelNodeItem(node, meta = "") {
  return {
    id: node.id,
    type: node.type,
    name: getNodeDisplayName(node),
    meta,
  };
}

function updateLastExtractedItems(nodeIds = []) {
  if (!currentGraph || !Array.isArray(nodeIds)) {
    lastExtractedItems = [];
    return;
  }

  lastExtractedItems = nodeIds
    .map((id) => getNode(currentGraph, id))
    .filter(Boolean)
    .slice(-5)
    .reverse()
    .map((node) =>
      toPanelNodeItem(
        node,
        `seq ${node.seqRange?.[1] ?? node.seq ?? 0} · ${new Date(
          node.createdTime || Date.now(),
        ).toLocaleTimeString()}`,
      ),
    );
}

function updateLastRecalledItems(nodeIds = []) {
  if (!currentGraph || !Array.isArray(nodeIds)) {
    lastRecalledItems = [];
    return;
  }

  lastRecalledItems = normalizeRecallNodeIdList(nodeIds)
    .map((id) => getNode(currentGraph, id))
    .filter(Boolean)
    .slice(0, 8)
    .map((node) =>
      toPanelNodeItem(
        node,
        `imp ${node.importance ?? 5} · seq ${node.seqRange?.[1] ?? node.seq ?? 0}`,
      ),
    );
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

function getLatestPersistedRecallDisplayRecord(chat = getContext()?.chat) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  for (let index = chat.length - 1; index >= 0; index--) {
    if (!chat[index]?.is_user) continue;
    const record = readPersistedRecallFromUserMessage(chat, index);
    if (record?.injectionText) {
      return {
        messageIndex: index,
        record,
      };
    }
  }
  return null;
}

function restoreRecallUiStateFromPersistence(chat = getContext()?.chat) {
  const latestPersisted = getLatestPersistedRecallDisplayRecord(chat);
  const graphRecallNodeIds = normalizeRecallNodeIdList(
    currentGraph?.lastRecallResult,
  );
  const persistedNodeIds = normalizeRecallNodeIdList(
    latestPersisted?.record?.selectedNodeIds,
  );
  const effectiveNodeIds = graphRecallNodeIds.length
    ? graphRecallNodeIds
    : persistedNodeIds;

  updateLastRecalledItems(effectiveNodeIds);
  lastInjectionContent = String(latestPersisted?.record?.injectionText || "").trim();

  return {
    restored: Boolean(lastInjectionContent || effectiveNodeIds.length),
    latestPersistedMessageIndex: Number.isFinite(latestPersisted?.messageIndex)
      ? latestPersisted.messageIndex
      : null,
    selectedNodeIds: effectiveNodeIds,
    injectionTextLength: lastInjectionContent.length,
  };
}

function clearRecallInputTracking() {
  clearPendingRecallSendIntent();
  lastRecallSentUserMessage = createRecallInputRecord();
  clearPendingHostGenerationInputSnapshot();
  if (typeof recordMessageTraceSnapshot === "function") {
    recordMessageTraceSnapshot({
      lastSentUserMessage: null,
    });
  }
  clearPlannerRecallHandoffsForChat("", { clearAll: true });
}

function getCoreEventBindingState() {
  return coreEventBindingState;
}

function setCoreEventBindingState(nextState = {}) {
  coreEventBindingState = {
    registered: Boolean(nextState?.registered),
    cleanups: Array.isArray(nextState?.cleanups) ? nextState.cleanups : [],
    registeredAt: Number(nextState?.registeredAt) || 0,
  };
  return coreEventBindingState;
}

function clearCoreEventBindingState() {
  const cleanups = Array.isArray(coreEventBindingState?.cleanups)
    ? coreEventBindingState.cleanups.splice(
        0,
        coreEventBindingState.cleanups.length,
      )
    : [];
  for (const cleanup of cleanups) {
    try {
      cleanup?.();
    } catch (error) {
      console.warn("[ST-BME] 清理核心事件绑定失败:", error);
    }
  }
  coreEventBindingState = {
    registered: false,
    cleanups: [],
    registeredAt: 0,
  };
  return coreEventBindingState;
}

function freezeHostGenerationInputSnapshot(
  text,
  source = "host-generation-lifecycle",
) {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return null;

  pendingHostGenerationInputSnapshot = createRecallInputRecord({
    text: normalized,
    hash: hashRecallInput(normalized),
    source,
    at: Date.now(),
  });
  return pendingHostGenerationInputSnapshot;
}

function consumeHostGenerationInputSnapshot(options = {}) {
  const { preserve = false } = options;
  if (!isFreshRecallInputRecord(pendingHostGenerationInputSnapshot)) {
    if (!preserve) {
      pendingHostGenerationInputSnapshot = createRecallInputRecord();
    }
    return createRecallInputRecord();
  }

  const snapshot = createRecallInputRecord({
    ...pendingHostGenerationInputSnapshot,
  });
  if (!preserve) {
    pendingHostGenerationInputSnapshot = createRecallInputRecord();
  }
  return snapshot;
}

function getPendingHostGenerationInputSnapshot() {
  return pendingHostGenerationInputSnapshot;
}

function clearPendingRecallSendIntent() {
  pendingRecallSendIntent = createRecallInputRecord();
  return pendingRecallSendIntent;
}

function clearPendingHostGenerationInputSnapshot() {
  pendingHostGenerationInputSnapshot = createRecallInputRecord();
  return pendingHostGenerationInputSnapshot;
}

function getCurrentGenerationTrivialSkip(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  if (!currentGenerationTrivialSkip) return null;

  const setAtMs = Number(currentGenerationTrivialSkip.setAtMs) || 0;
  if (
    !setAtMs ||
    now - setAtMs > TRIVIAL_GENERATION_SKIP_TTL_MS
  ) {
    currentGenerationTrivialSkip = null;
    return null;
  }

  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const activeChatId = normalizeChatIdCandidate(
    currentGenerationTrivialSkip.chatId,
  );
  if (normalizedChatId && activeChatId && normalizedChatId !== activeChatId) {
    return null;
  }

  return currentGenerationTrivialSkip;
}

function markCurrentGenerationTrivialSkip({
  reason = "",
  chatId = getCurrentChatId(),
  chatLength = 0,
} = {}) {
  currentGenerationTrivialSkip = {
    chatId: normalizeChatIdCandidate(chatId),
    setAtMs: Date.now(),
    reason: String(reason || ""),
    generationStartMinChatIndex: Math.max(
      0,
      Math.floor(Number(chatLength) || 0),
    ),
  };
  return currentGenerationTrivialSkip;
}

function clearCurrentGenerationTrivialSkip(_reason = "") {
  const previous = currentGenerationTrivialSkip;
  currentGenerationTrivialSkip = null;
  return previous;
}

function consumeCurrentGenerationTrivialSkip(
  targetMessageIndex,
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  const activeSkip = getCurrentGenerationTrivialSkip(chatId, now);
  if (!activeSkip) return false;

  const normalizedTargetIndex = Number.isFinite(Number(targetMessageIndex))
    ? Math.floor(Number(targetMessageIndex))
    : null;
  if (!Number.isFinite(normalizedTargetIndex)) {
    return false;
  }

  if (
    normalizedTargetIndex <
    Math.max(0, Math.floor(Number(activeSkip.generationStartMinChatIndex) || 0))
  ) {
    return false;
  }

  currentGenerationTrivialSkip = null;
  return true;
}

function recordRecallSendIntent(text, source = "dom-intent") {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return createRecallInputRecord();

  const hash = hashRecallInput(normalized);
  const previousRecord = isFreshRecallInputRecord(pendingRecallSendIntent)
    ? pendingRecallSendIntent
    : null;
  const previousHash = String(previousRecord?.hash || "");
  const previousText = String(previousRecord?.text || "");

  if (previousHash && previousHash === hash && previousText === normalized) {
    pendingRecallSendIntent = createRecallInputRecord({
      ...previousRecord,
      at: Date.now(),
      source: String(source || previousRecord.source || "dom-intent"),
    });
    return pendingRecallSendIntent;
  }

  pendingRecallSendIntent = createRecallInputRecord({
    text: normalized,
    hash,
    source,
    at: Date.now(),
  });
  return pendingRecallSendIntent;
}

function recordRecallSentUserMessage(messageId, text, source = "message-sent") {
  const normalized = normalizeRecallInputText(text);
  if (!normalized) return createRecallInputRecord();

  const hash = hashRecallInput(normalized);
  lastRecallSentUserMessage = createRecallInputRecord({
    text: normalized,
    hash,
    messageId: Number.isFinite(messageId) ? messageId : null,
    source,
    at: Date.now(),
  });
  if (typeof recordMessageTraceSnapshot === "function") {
    recordMessageTraceSnapshot({
      lastSentUserMessage: {
        text: normalized,
        hash,
        messageId: Number.isFinite(messageId) ? messageId : null,
        source,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  // 注意：不再在 MESSAGE_SENT 阶段清空 pendingRecallSendIntent /
  // pendingHostGenerationInputSnapshot / transactions。
  // 这些数据在 GENERATION_AFTER_COMMANDS 中被消费；MESSAGE_SENT 先于
  // GENERATION_AFTER_COMMANDS 触发，提前清空会导致召回拿不到用户输入。
  // 真正的消费发生在 recall 执行后（runRecallController 内部）。

  return lastRecallSentUserMessage;
}

function getMessageRecallRecord(messageIndex) {
  const chat = getContext()?.chat;
  return readPersistedRecallFromUserMessage(chat, messageIndex);
}

function debugWithThrottle(cache, key, ...args) {
  if (!globalThis.__stBmeDebugLoggingEnabled) return;
  const now = Date.now();
  const lastAt = cache.get(key) || 0;
  if (now - lastAt < PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS) return;
  cache.set(key, now);
  console.debug(...args);
}

function debugPersistedRecallUi(reason, details = null, throttleKey = reason) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    persistedRecallUiDiagnosticTimestamps,
    `ui:${throttleKey}`,
    `[ST-BME] Recall Card UI: ${reason}${suffix}`,
  );
}

function debugPersistedRecallPersistence(
  reason,
  details = null,
  throttleKey = reason,
) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    persistedRecallPersistDiagnosticTimestamps,
    `persist:${throttleKey}`,
    `[ST-BME] Recall Card persist: ${reason}${suffix}`,
  );
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

function rebindRecallRecordToNewUserMessage(newUserMessageIndex) {
  const chat = getContext()?.chat;
  if (
    !Array.isArray(chat) ||
    !Number.isFinite(newUserMessageIndex) ||
    !chat[newUserMessageIndex]?.is_user
  ) {
    return;
  }
  if (readPersistedRecallFromUserMessage(chat, newUserMessageIndex)) {
    return;
  }
  const recentTransaction = findRecentGenerationRecallTransactionForChat();
  const recallResult = getGenerationRecallTransactionResult(recentTransaction);
  if (
    !recallResult ||
    recallResult.status !== "completed" ||
    !recallResult.didRecall ||
    !String(recallResult.injectionText || "").trim()
  ) {
    return;
  }
  const frozenOpts = recentTransaction?.frozenRecallOptions;
  const record = buildPersistedRecallRecord(
    {
      injectionText: String(recallResult.injectionText || "").trim(),
      selectedNodeIds: recallResult.selectedNodeIds || [],
      recallInput: String(
        recallResult.recallInput ||
          recallResult.userMessage ||
          frozenOpts?.overrideUserMessage ||
          frozenOpts?.userMessage ||
          "",
      ),
      recallSource: String(
        recallResult.source ||
          frozenOpts?.lockedSource ||
          frozenOpts?.overrideSource ||
          "",
      ),
      hookName: String(
        recallResult.hookName ||
          recentTransaction?.lastRecallMeta?.hookName ||
          "",
      ),
      tokenEstimate: estimateTokens(
        String(recallResult.injectionText || "").trim(),
      ),
      manuallyEdited: false,
      authoritativeInputUsed: Boolean(
        recallResult.authoritativeInputUsed ?? frozenOpts?.authoritativeInputUsed,
      ),
      boundUserFloorText: String(
        recallResult.boundUserFloorText || frozenOpts?.boundUserFloorText || "",
      ),
    },
    null,
  );
  if (writePersistedRecallToUserMessage(chat, newUserMessageIndex, record)) {
    triggerChatMetadataSave(getContext(), { immediate: false });
  }
}

function resolveRecallPersistenceTargetUserMessageIndex(
  chat,
  {
    generationType = "normal",
    explicitTargetUserMessageIndex = null,
    candidateTexts = [],
    preferredRecord = null,
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
      if (
        doesChatUserMessageMatchRecallCandidates(message, candidateHashes)
      ) {
        return index;
      }
    }
  }

  // 正常生成阶段里，ST 可能会在真正发送前改写用户文本
  // （命令展开、包装显示、辅助 UI 处理等），导致 hash 已无法精确匹配。
  // 这时仍应优先回绑到“当前最新 user 楼层”，否则召回记录虽然生成了，
  // Recall Card 会因为找不到目标楼层而消失。
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

function persistRecallInjectionRecord({
  recallInput = {},
  result = {},
  injectionText = "",
  tokenEstimate = 0,
} = {}) {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return null;

  const generationType =
    String(recallInput?.generationType || "normal").trim() || "normal";
  let resolvedTargetIndex = resolveRecallPersistenceTargetUserMessageIndex(
    chat,
    {
      generationType,
      explicitTargetUserMessageIndex: recallInput?.targetUserMessageIndex,
      candidateTexts: [
        recallInput?.userMessage,
        recallInput?.overrideUserMessage,
        lastRecallSentUserMessage?.text,
      ],
      preferredRecord: lastRecallSentUserMessage,
    },
  );

  if (!Number.isFinite(resolvedTargetIndex)) {
    debugPersistedRecallPersistence("目标 user 楼层解析失败", {
      generationType,
      explicitTargetUserMessageIndex: recallInput?.targetUserMessageIndex,
      lastSentUserMessageId: lastRecallSentUserMessage?.messageId,
      recallInputSource: String(recallInput?.source || ""),
    });
    return null;
  }

  if (!chat[resolvedTargetIndex]?.is_user) {
    debugPersistedRecallPersistence("目标楼层不是 user 消息，跳过持久化", {
      targetUserMessageIndex: resolvedTargetIndex,
      messageKeys: Object.keys(chat[resolvedTargetIndex] || {}),
    });
    return null;
  }

  const targetUserFloorText = normalizeRecallInputText(
    chat[resolvedTargetIndex]?.mes || "",
  );
  const boundUserFloorText = normalizeRecallInputText(
    recallInput?.boundUserFloorText || targetUserFloorText,
  );
  const record = buildPersistedRecallRecord(
    {
      injectionText,
      selectedNodeIds: result?.selectedNodeIds || [],
      recallInput: String(recallInput?.userMessage || ""),
      recallSource: String(recallInput?.source || ""),
      hookName: String(recallInput?.hookName || ""),
      tokenEstimate,
      manuallyEdited: false,
      authoritativeInputUsed: Boolean(recallInput?.authoritativeInputUsed),
      boundUserFloorText,
    },
    readPersistedRecallFromUserMessage(chat, resolvedTargetIndex),
  );
  if (!String(record?.injectionText || "").trim()) {
    debugPersistedRecallPersistence("无有效 injectionText，跳过持久化", {
      targetUserMessageIndex: resolvedTargetIndex,
      selectedNodeCount: Array.isArray(result?.selectedNodeIds)
        ? result.selectedNodeIds.length
        : 0,
    });
    return null;
  }
  if (!writePersistedRecallToUserMessage(chat, resolvedTargetIndex, record)) {
    debugPersistedRecallPersistence("写入 user 楼层失败", {
      targetUserMessageIndex: resolvedTargetIndex,
    });
    return null;
  }

  triggerChatMetadataSave(getContext(), { immediate: false });
  schedulePersistedRecallMessageUiRefresh();
  debugPersistedRecallPersistence(
    "召回记录已写入 user 楼层",
    {
      targetUserMessageIndex: resolvedTargetIndex,
      injectionTextLength: String(record?.injectionText || "").length,
      selectedNodeCount: Array.isArray(record?.selectedNodeIds)
        ? record.selectedNodeIds.length
        : 0,
    },
    `persist-success:${resolvedTargetIndex}`,
  );
  return {
    index: resolvedTargetIndex,
    record,
  };
}

function ensurePersistedRecallRecordForGeneration({
  generationType = "normal",
  recallResult = null,
  transaction = null,
  recallOptions = null,
  hookName = "",
} = {}) {
  const injectionText = String(recallResult?.injectionText || "").trim();
  if (
    recallResult?.status !== "completed" ||
    !recallResult?.didRecall ||
    !injectionText
  ) {
    return {
      persisted: false,
      reason: "no-fresh-recall",
      targetUserMessageIndex: null,
      record: null,
    };
  }

  const chat = getContext()?.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    return {
      persisted: false,
      reason: "missing-chat",
      targetUserMessageIndex: null,
      record: null,
    };
  }

  const frozenRecallOptions =
    transaction?.frozenRecallOptions &&
    typeof transaction.frozenRecallOptions === "object"
      ? transaction.frozenRecallOptions
      : null;
  const targetUserMessageIndex = resolveRecallPersistenceTargetUserMessageIndex(
    chat,
    {
      generationType,
      explicitTargetUserMessageIndex:
        frozenRecallOptions?.targetUserMessageIndex ??
        recallOptions?.targetUserMessageIndex ??
        recallOptions?.explicitTargetUserMessageIndex ??
        null,
      candidateTexts: [
        frozenRecallOptions?.overrideUserMessage,
        frozenRecallOptions?.userMessage,
        recallOptions?.overrideUserMessage,
        recallOptions?.userMessage,
        recallResult?.recallInput,
        recallResult?.userMessage,
        ...(Array.isArray(recallResult?.sourceCandidates)
          ? recallResult.sourceCandidates.map((candidate) => candidate?.text)
          : []),
        lastRecallSentUserMessage?.text,
      ],
      preferredRecord: lastRecallSentUserMessage,
    },
  );

  if (
    !Number.isFinite(targetUserMessageIndex) ||
    !chat[targetUserMessageIndex]?.is_user
  ) {
    return {
      persisted: false,
      reason: "target-unresolved",
      targetUserMessageIndex: Number.isFinite(targetUserMessageIndex)
        ? targetUserMessageIndex
        : null,
      record: null,
    };
  }

  const selectedNodeIds = normalizeRecallNodeIdList(
    recallResult?.selectedNodeIds || [],
  );
  const existingRecord = readPersistedRecallFromUserMessage(
    chat,
    targetUserMessageIndex,
  );
  const nextAuthoritativeInputUsed = Boolean(
    recallResult?.authoritativeInputUsed ??
      frozenRecallOptions?.authoritativeInputUsed ??
      recallOptions?.authoritativeInputUsed,
  );
  const targetUserFloorText = normalizeRecallInputText(
    chat[targetUserMessageIndex]?.mes || "",
  );
  const nextBoundUserFloorText = normalizeRecallInputText(
    recallResult?.boundUserFloorText ||
      frozenRecallOptions?.boundUserFloorText ||
      recallOptions?.boundUserFloorText ||
      targetUserFloorText ||
      "",
  );
  const existingBoundUserFloorText = normalizeRecallInputText(
    existingRecord?.boundUserFloorText || "",
  );
  const existingMetadataUpToDate =
    Boolean(existingRecord?.authoritativeInputUsed) === nextAuthoritativeInputUsed &&
    (!nextBoundUserFloorText ||
      existingBoundUserFloorText === nextBoundUserFloorText);
  if (
    existingRecord &&
    String(existingRecord.injectionText || "").trim() === injectionText &&
    areRecallNodeIdListsEqual(existingRecord.selectedNodeIds, selectedNodeIds) &&
    String(existingRecord.recallInput || "").trim() &&
    existingMetadataUpToDate
  ) {
    return {
      persisted: false,
      reason: "already-up-to-date",
      targetUserMessageIndex,
      record: existingRecord,
    };
  }

  const nextRecord = buildPersistedRecallRecord(
    {
      injectionText,
      selectedNodeIds,
      recallInput: String(
        recallResult?.recallInput ||
          recallResult?.userMessage ||
          frozenRecallOptions?.overrideUserMessage ||
          recallOptions?.overrideUserMessage ||
          recallOptions?.userMessage ||
          "",
      ),
      recallSource: String(
        recallResult?.source ||
          frozenRecallOptions?.lockedSource ||
          frozenRecallOptions?.overrideSource ||
          recallOptions?.overrideSource ||
          "",
      ),
      hookName: String(
        hookName ||
          recallResult?.hookName ||
          frozenRecallOptions?.hookName ||
          recallOptions?.hookName ||
          "",
      ),
      tokenEstimate: estimateTokens(injectionText),
      manuallyEdited: false,
      authoritativeInputUsed: nextAuthoritativeInputUsed,
      boundUserFloorText: nextBoundUserFloorText,
    },
    existingRecord,
  );

  if (!writePersistedRecallToUserMessage(chat, targetUserMessageIndex, nextRecord)) {
    return {
      persisted: false,
      reason: "write-failed",
      targetUserMessageIndex,
      record: null,
    };
  }

  triggerChatMetadataSave(getContext(), { immediate: false });
  schedulePersistedRecallMessageUiRefresh();
  debugPersistedRecallPersistence(
    "最终阶段已补写召回记录",
    {
      targetUserMessageIndex,
      hookName:
        String(
          hookName ||
            recallResult?.hookName ||
            frozenRecallOptions?.hookName ||
            recallOptions?.hookName ||
            "",
        ) || "",
      injectionTextLength: injectionText.length,
      selectedNodeCount: selectedNodeIds.length,
    },
    `finalize-persist:${targetUserMessageIndex}`,
  );

  return {
    persisted: true,
    reason: "backfilled",
    targetUserMessageIndex,
    record: nextRecord,
  };
}

function removeMessageRecallRecord(messageIndex) {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return false;
  const removed = removePersistedRecallFromUserMessage(chat, messageIndex);
  if (removed) {
    triggerChatMetadataSave(getContext(), { immediate: false });
  }
  return removed;
}

function editMessageRecallRecord(messageIndex, nextInjectionText) {
  const chat = getContext()?.chat;
  if (!Array.isArray(chat)) return null;
  const current = readPersistedRecallFromUserMessage(chat, messageIndex);
  if (!current) return null;

  const normalizedText = normalizeRecallInputText(nextInjectionText);
  if (!normalizedText) return null;
  const nowIso = new Date().toISOString();
  const nextRecord = {
    ...current,
    injectionText: normalizedText,
    tokenEstimate: estimateTokens(normalizedText),
    updatedAt: nowIso,
  };
  if (!writePersistedRecallToUserMessage(chat, messageIndex, nextRecord)) {
    return null;
  }
  const edited = markPersistedRecallManualEdit(
    chat,
    messageIndex,
    true,
    nowIso,
  );
  if (!edited) return null;

  triggerChatMetadataSave(getContext(), { immediate: false });
  return edited;
}

function syncEditedUserMessageDom(messageIndex, nextText) {
  const chatRoot = document?.getElementById?.("chat");
  if (!chatRoot?.querySelectorAll) return false;

  for (const messageElement of Array.from(chatRoot.querySelectorAll(".mes") || [])) {
    if (resolveMessageIndexFromElement(messageElement) !== messageIndex) continue;
    const userTextElement = messageElement.querySelector?.(".mes_text");
    if (!userTextElement) return false;
    userTextElement.textContent = String(nextText || "");
    return true;
  }
  return false;
}

function persistEditedUserMessage(context = getContext()) {
  const candidates = [
    ["saveChatConditional", context?.saveChatConditional],
    ["saveChat", context?.saveChat],
  ];

  for (const [label, handler] of candidates) {
    if (typeof handler !== "function") continue;
    try {
      const result = handler.call(context);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          console.error(`[ST-BME] 保存用户输入编辑失败 (${label}):`, error);
        });
      }
      return label;
    } catch (error) {
      console.error(`[ST-BME] 调用 ${label} 保存用户输入编辑失败:`, error);
    }
  }

  return triggerChatMetadataSave(context, { immediate: true });
}

function editMessageUserInputText(messageIndex, nextUserInputText) {
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) {
    return { ok: false, error: "missing-chat" };
  }

  const message = chat[messageIndex];
  if (!message?.is_user) {
    return { ok: false, error: "not-user-message" };
  }

  const normalizedText = normalizeRecallInputText(nextUserInputText);
  if (!normalizedText) {
    return { ok: false, error: "empty-user-input" };
  }

  const previousText = normalizeRecallInputText(message.mes || "");
  const currentRecord = readPersistedRecallFromUserMessage(chat, messageIndex);
  const recallBoundText = normalizeRecallInputText(
    currentRecord?.boundUserFloorText || previousText,
  );
  const recallMayBeStale = Boolean(currentRecord) && recallBoundText !== normalizedText;

  message.mes = normalizedText;
  const swipeIndex = Number.isFinite(Number(message?.swipe_id))
    ? Math.max(0, Math.floor(Number(message.swipe_id)))
    : null;
  if (
    Array.isArray(message?.swipes) &&
    swipeIndex !== null &&
    swipeIndex < message.swipes.length
  ) {
    message.swipes[swipeIndex] = normalizedText;
  }

  if (message.extra && typeof message.extra === "object") {
    if (typeof message.extra.display_text === "string") {
      message.extra.display_text = normalizedText;
    }
    if (typeof message.extra.current_display_text === "string") {
      message.extra.current_display_text = normalizedText;
    }
  }

  const saveMode = persistEditedUserMessage(context);
  const domSynced = syncEditedUserMessageDom(messageIndex, normalizedText);

  return {
    ok: true,
    nextText: normalizedText,
    recallMayBeStale,
    unchanged: previousText === normalizedText,
    saveMode,
    domSynced,
  };
}

function rewriteRecallPayloadWithInjection(
  promptData = null,
  injectionText = "",
) {
  const normalizedInjectionText = normalizeRecallInputText(injectionText);
  if (!normalizedInjectionText) {
    return {
      applied: false,
      path: "",
      field: "",
      reason: "empty-injection-text",
    };
  }

  const finalMesSend = Array.isArray(promptData?.finalMesSend)
    ? promptData.finalMesSend
    : null;
  if (Array.isArray(finalMesSend) && finalMesSend.length > 0) {
    for (let index = finalMesSend.length - 1; index >= 0; index--) {
      const entry = finalMesSend[index];
      if (!entry || typeof entry !== "object") continue;
      if (entry.injected === true) continue;
      const messageText = normalizeRecallInputText(
        entry.message || entry.mes || entry.content || "",
      );
      if (!messageText) continue;

      entry.extensionPrompts = Array.isArray(entry.extensionPrompts)
        ? entry.extensionPrompts
        : [];
      const alreadyPresent = entry.extensionPrompts.some((chunk) =>
        String(chunk || "").includes(normalizedInjectionText),
      );
      if (!alreadyPresent) {
        entry.extensionPrompts.push(`${normalizedInjectionText}\n`);
      }
      return {
        applied: true,
        path: "finalMesSend",
        field: `finalMesSend[${index}].extensionPrompts`,
        reason: alreadyPresent
          ? "rewrite-already-present"
          : "finalMesSend-extensionPrompt-appended",
        targetIndex: index,
      };
    }

    return {
      applied: false,
      path: "finalMesSend",
      field: "",
      reason: "no-rewritable-finalMesSend-entry",
    };
  }

  if (
    typeof promptData?.combinedPrompt === "string" &&
    promptData.combinedPrompt.trim()
  ) {
    if (!promptData.combinedPrompt.includes(normalizedInjectionText)) {
      promptData.combinedPrompt = `${normalizedInjectionText}\n\n${promptData.combinedPrompt}`;
    }
    return {
      applied: true,
      path: "combinedPrompt",
      field: "combinedPrompt",
      reason: "combinedPrompt-prefixed",
    };
  }

  if (typeof promptData?.prompt === "string" && promptData.prompt.trim()) {
    if (!promptData.prompt.includes(normalizedInjectionText)) {
      promptData.prompt = `${normalizedInjectionText}\n\n${promptData.prompt}`;
    }
    return {
      applied: true,
      path: "prompt",
      field: "prompt",
      reason: "prompt-prefixed",
    };
  }

  return {
    applied: false,
    path: "",
    field: "",
    reason: "prompt-payload-unavailable",
  };
}

function rewriteRecallPayloadWithAuthoritativeUserInput(
  promptData = null,
  authoritativeText = "",
  boundUserFloorText = "",
) {
  const normalizedAuthoritativeText = normalizeRecallInputText(authoritativeText);
  const normalizedBoundUserFloorText = normalizeRecallInputText(boundUserFloorText);
  if (!normalizedAuthoritativeText) {
    return {
      applied: false,
      changed: false,
      path: "",
      field: "",
      reason: "empty-authoritative-text",
    };
  }

  const finalMesSend = Array.isArray(promptData?.finalMesSend)
    ? promptData.finalMesSend
    : null;
  if (!Array.isArray(finalMesSend) || finalMesSend.length <= 0) {
    return {
      applied: false,
      changed: false,
      path: "",
      field: "",
      reason: "finalMesSend-unavailable",
    };
  }

  let fallbackIndex = -1;
  let matchedIndex = -1;
  for (let index = finalMesSend.length - 1; index >= 0; index--) {
    const entry = finalMesSend[index];
    if (!entry || typeof entry !== "object") continue;
    if (entry.injected === true) continue;

    const messageText = normalizeRecallInputText(
      entry.message || entry.mes || entry.content || "",
    );
    if (!messageText) continue;

    if (fallbackIndex < 0) {
      fallbackIndex = index;
    }

    if (
      messageText === normalizedAuthoritativeText ||
      (normalizedBoundUserFloorText &&
        messageText === normalizedBoundUserFloorText)
    ) {
      matchedIndex = index;
      break;
    }
  }

  const targetIndex =
    matchedIndex >= 0
      ? matchedIndex
      : normalizedBoundUserFloorText
        ? -1
        : fallbackIndex;
  if (targetIndex < 0) {
    return {
      applied: false,
      changed: false,
      path: "finalMesSend",
      field: "",
      reason: normalizedBoundUserFloorText
        ? "bound-user-floor-text-not-found"
        : "no-rewritable-finalMesSend-entry",
    };
  }

  const entry = finalMesSend[targetIndex];
  const fieldName = Object.prototype.hasOwnProperty.call(entry, "message")
    ? "message"
    : Object.prototype.hasOwnProperty.call(entry, "mes")
      ? "mes"
      : Object.prototype.hasOwnProperty.call(entry, "content")
        ? "content"
        : "message";
  const previousText = normalizeRecallInputText(
    entry?.[fieldName] || entry?.message || entry?.mes || entry?.content || "",
  );
  const changed = previousText !== normalizedAuthoritativeText;
  if (changed) {
    entry[fieldName] = normalizedAuthoritativeText;
  }

  return {
    applied: true,
    changed,
    path: "finalMesSend",
    field: `finalMesSend[${targetIndex}].${fieldName}`,
    reason: changed
      ? "finalMesSend-authoritative-user-rewritten"
      : "authoritative-user-already-matched",
    targetIndex,
  };
}

function readGenerationRecallTransactionFinalResolution(transaction) {
  return transaction?.finalResolution || null;
}

function storeGenerationRecallTransactionFinalResolution(
  transaction,
  finalResolution = null,
) {
  if (!transaction?.id) return transaction;
  transaction.finalResolution = finalResolution ? { ...finalResolution } : null;
  transaction.updatedAt = Date.now();
  generationRecallTransactions.set(transaction.id, transaction);
  return transaction;
}

function applyFinalRecallInjectionForGeneration({
  generationType = "normal",
  freshRecallResult = null,
  transaction = null,
  promptData = null,
  hookName = "",
} = {}) {
  const existingFinalResolution =
    readGenerationRecallTransactionFinalResolution(transaction);
  if (existingFinalResolution) {
    if (
      promptData &&
      transaction?.frozenRecallOptions?.authoritativeInputUsed === true
    ) {
      const recallResult =
        freshRecallResult ||
        getGenerationRecallTransactionResult(transaction) ||
        null;
      const inputRewrite = rewriteRecallPayloadWithAuthoritativeUserInput(
        promptData,
        transaction?.frozenRecallOptions?.overrideUserMessage || "",
        transaction?.frozenRecallOptions?.boundUserFloorText || "",
      );
      const rewrite = rewriteRecallPayloadWithInjection(
        promptData,
        existingFinalResolution.usedText || recallResult?.injectionText || "",
      );
      const nextFinalResolution = {
        ...existingFinalResolution,
        deliveryMode: "deferred",
        applicationMode:
          rewrite.applied || inputRewrite.applied
            ? "rewrite"
            : existingFinalResolution.applicationMode,
        rewrite,
        inputRewrite,
      };
      recordInjectionSnapshot("recall", {
        taskType: "recall",
        source:
          String(
            recallResult?.source ||
              transaction?.frozenRecallOptions?.lockedSource ||
              transaction?.frozenRecallOptions?.overrideSource ||
              "",
          ).trim() || "unknown",
        sourceLabel:
          String(
            recallResult?.sourceLabel ||
              transaction?.frozenRecallOptions?.lockedSourceLabel ||
              transaction?.frozenRecallOptions?.overrideSourceLabel ||
              "",
          ).trim() || "未知",
        reason:
          String(
            recallResult?.reason ||
              transaction?.frozenRecallOptions?.lockedReason ||
              transaction?.frozenRecallOptions?.overrideReason ||
              "",
          ).trim() || "final-application-reused",
        sourceCandidates: Array.isArray(recallResult?.sourceCandidates)
          ? recallResult.sourceCandidates.map((candidate) => ({ ...candidate }))
          : Array.isArray(transaction?.frozenRecallOptions?.sourceCandidates)
            ? transaction.frozenRecallOptions.sourceCandidates.map((candidate) => ({
                ...candidate,
              }))
            : [],
        hookName: String(hookName || recallResult?.hookName || "").trim(),
        selectedNodeIds: recallResult?.selectedNodeIds || [],
        retrievalMeta: recallResult?.retrievalMeta || {},
        llmMeta: recallResult?.llmMeta || {},
        stats: recallResult?.stats || {},
        injectionText: nextFinalResolution.usedText || "",
        deliveryMode: nextFinalResolution.deliveryMode || "",
        applicationMode: nextFinalResolution.applicationMode || "none",
        transport: nextFinalResolution.transport || {
          applied: false,
          source: "none",
          mode: "none",
        },
        rewrite: nextFinalResolution.rewrite || {
          applied: false,
          path: "",
          field: "",
          reason: "final-resolution-reused",
        },
        inputRewrite,
        targetUserMessageIndex: nextFinalResolution.targetUserMessageIndex,
        sourceKind: nextFinalResolution.source || "none",
        authoritativeInputUsed: true,
        boundUserFloorText: String(
          transaction?.frozenRecallOptions?.boundUserFloorText || "",
        ),
      });
      storeGenerationRecallTransactionFinalResolution(
        transaction,
        nextFinalResolution,
      );
      refreshPanelLiveState();
      schedulePersistedRecallMessageUiRefresh();
      return nextFinalResolution;
    }
    return existingFinalResolution;
  }

  const recallResult =
    freshRecallResult ||
    getGenerationRecallTransactionResult(transaction) ||
    null;
  const hookResolvedDeliveryMode =
    String(
      resolveGenerationRecallDeliveryMode(
        hookName,
        generationType,
        transaction?.frozenRecallOptions || {},
      ),
    ).trim() || "immediate";
  const deliveryMode =
    String(
      promptData && hookName === "GENERATE_BEFORE_COMBINE_PROMPTS"
        ? hookResolvedDeliveryMode
        : recallResult?.deliveryMode ||
            transaction?.lastDeliveryMode ||
            hookResolvedDeliveryMode,
    ).trim() || "immediate";
  const chat = getContext()?.chat;

  let transport = {
    applied: false,
    source: "none",
    mode: "none",
  };
  let targetUserMessageIndex = null;
  let resolved = {
    source: "none",
    injectionText: "",
    record: null,
  };
  const authoritativeInputRewrite =
    deliveryMode === "deferred" &&
    transaction?.frozenRecallOptions?.authoritativeInputUsed === true
      ? rewriteRecallPayloadWithAuthoritativeUserInput(
          promptData,
          transaction?.frozenRecallOptions?.overrideUserMessage || "",
          transaction?.frozenRecallOptions?.boundUserFloorText || "",
        )
      : {
          applied: false,
          changed: false,
          path: "",
          field: "",
          reason:
            deliveryMode === "deferred"
              ? "authoritative-input-unused"
              : "non-deferred-delivery",
        };
  const rewrite = {
    applied: false,
    path: "",
    field: "",
    reason: "no-recall-source",
  };
  let applicationMode = "none";

  if (!Array.isArray(chat)) {
    transport = applyModuleInjectionPrompt("", getSettings()) || transport;
    const emptyResolution = {
      source: "none",
      isFallback: false,
      targetUserMessageIndex: null,
      usedText: "",
      deliveryMode,
      applicationMode: "none",
      rewrite,
      transport,
    };
    storeGenerationRecallTransactionFinalResolution(
      transaction,
      emptyResolution,
    );
    return emptyResolution;
  }

  const ensuredPersistence = ensurePersistedRecallRecordForGeneration({
    generationType,
    recallResult,
    transaction,
    recallOptions: transaction?.frozenRecallOptions || null,
    hookName,
  });

  targetUserMessageIndex = resolveRecallPersistenceTargetUserMessageIndex(chat, {
    generationType,
    explicitTargetUserMessageIndex:
      transaction?.frozenRecallOptions?.targetUserMessageIndex,
    candidateTexts: [
      transaction?.frozenRecallOptions?.overrideUserMessage,
      recallResult?.recallInput,
      recallResult?.userMessage,
      recallResult?.sourceCandidates?.[0]?.text,
      lastRecallSentUserMessage?.text,
    ],
    preferredRecord: lastRecallSentUserMessage,
  });
  if (Number.isFinite(ensuredPersistence?.targetUserMessageIndex)) {
    targetUserMessageIndex = ensuredPersistence.targetUserMessageIndex;
  }

  const persistedRecord = Number.isFinite(targetUserMessageIndex)
    ? readPersistedRecallFromUserMessage(chat, targetUserMessageIndex)
    : null;
  resolved = resolveFinalRecallInjectionSource({
    freshRecallResult: recallResult,
    persistedRecord,
  });

  if (resolved.source === "fresh" && deliveryMode === "deferred") {
    const rewriteResult = rewriteRecallPayloadWithInjection(
      promptData,
      resolved.injectionText || "",
    );
    Object.assign(rewrite, rewriteResult);
    lastInjectionContent = resolved.injectionText || "";
    if (rewriteResult.applied) {
      applicationMode = "rewrite";
      transport = clearLiveRecallInjectionPromptForRewrite() || {
        applied: false,
        source: "rewrite-cleared",
        mode: "rewrite-cleared",
      };
      runtimeStatus = createUiStatus(
        "召回已改写",
        `本轮发送载荷已 rewrite · ${rewriteResult.path || rewriteResult.field || "payload"}`,
        "success",
      );
    } else {
      applicationMode = "fallback-injection";
      transport =
        applyModuleInjectionPrompt(
          resolved.injectionText || "",
          getSettings(),
        ) || transport;
      runtimeStatus = createUiStatus(
        "召回回退",
        `rewrite 未命中，已回退注入 · ${rewriteResult.reason}`,
        "warning",
      );
    }
  } else if (resolved.source === "fresh") {
    applicationMode = "injection";
    transport =
      applyModuleInjectionPrompt(resolved.injectionText || "", getSettings()) ||
      transport;
    lastInjectionContent = resolved.injectionText || "";
    rewrite.reason = "immediate-injection";
    runtimeStatus = createUiStatus(
      "召回已注入",
      "本轮已使用最新召回结果",
      "success",
    );
  } else if (resolved.source === "persisted") {
    applicationMode = "persisted-injection";
    transport =
      applyModuleInjectionPrompt(resolved.injectionText || "", getSettings()) ||
      transport;
    lastInjectionContent = resolved.injectionText || "";
    rewrite.reason = "persisted-record-fallback";
    runtimeStatus = createUiStatus(
      "召回回退",
      "已使用消息楼层持久化注入",
      "info",
    );
  } else {
    transport = applyModuleInjectionPrompt("", getSettings()) || transport;
    lastInjectionContent = "";
    runtimeStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }

  if (
    resolved.source === "persisted" &&
    Number.isFinite(targetUserMessageIndex)
  ) {
    bumpPersistedRecallGenerationCount(chat, targetUserMessageIndex);
    triggerChatMetadataSave(getContext(), { immediate: false });
  }

  recordInjectionSnapshot("recall", {
    taskType: "recall",
    source:
      String(
        recallResult?.source ||
          transaction?.frozenRecallOptions?.lockedSource ||
          transaction?.frozenRecallOptions?.overrideSource ||
          "",
      ).trim() || "unknown",
    sourceLabel:
      String(
        recallResult?.sourceLabel ||
          transaction?.frozenRecallOptions?.lockedSourceLabel ||
          transaction?.frozenRecallOptions?.overrideSourceLabel ||
          "",
      ).trim() || "未知",
    reason:
      String(
        recallResult?.reason ||
          transaction?.frozenRecallOptions?.lockedReason ||
          transaction?.frozenRecallOptions?.overrideReason ||
          "",
      ).trim() || "final-application",
    sourceCandidates: Array.isArray(recallResult?.sourceCandidates)
      ? recallResult.sourceCandidates.map((candidate) => ({ ...candidate }))
      : Array.isArray(transaction?.frozenRecallOptions?.sourceCandidates)
        ? transaction.frozenRecallOptions.sourceCandidates.map((candidate) => ({
            ...candidate,
          }))
        : [],
    hookName: String(hookName || recallResult?.hookName || "").trim(),
    selectedNodeIds: recallResult?.selectedNodeIds || [],
    retrievalMeta: recallResult?.retrievalMeta || {},
    llmMeta: recallResult?.llmMeta || {},
    stats: recallResult?.stats || {},
    injectionText: resolved.injectionText || "",
    deliveryMode,
    applicationMode,
    transport,
    rewrite,
    inputRewrite: authoritativeInputRewrite,
    targetUserMessageIndex,
    sourceKind: resolved.source,
    authoritativeInputUsed: Boolean(
      recallResult?.authoritativeInputUsed ??
        transaction?.frozenRecallOptions?.authoritativeInputUsed,
    ),
    boundUserFloorText: String(
      recallResult?.boundUserFloorText ||
        transaction?.frozenRecallOptions?.boundUserFloorText ||
        "",
    ),
  });

  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh();

  const finalResolution = {
    source: resolved.source,
    isFallback:
      resolved.source === "persisted" ||
      applicationMode === "fallback-injection",
    targetUserMessageIndex,
    usedText: resolved.injectionText || "",
    deliveryMode,
    applicationMode,
    rewrite,
    transport,
    inputRewrite: authoritativeInputRewrite,
    authoritativeInputUsed: Boolean(
      recallResult?.authoritativeInputUsed ??
        transaction?.frozenRecallOptions?.authoritativeInputUsed,
    ),
    boundUserFloorText: String(
      recallResult?.boundUserFloorText ||
        transaction?.frozenRecallOptions?.boundUserFloorText ||
        "",
    ),
  };
  storeGenerationRecallTransactionFinalResolution(transaction, finalResolution);
  return finalResolution;
}

function clearLiveRecallInjectionPromptForRewrite() {
  try {
    return (
      applyModuleInjectionPrompt("", getSettings()) || {
        applied: false,
        source: "rewrite-clear",
        mode: "rewrite-clear",
      }
    );
  } catch (error) {
    console.warn("[ST-BME] 清理 rewrite 前旧注入失败:", error);
    return {
      applied: false,
      source: "rewrite-clear-error",
      mode: "rewrite-clear-error",
      error: error instanceof Error ? error.message : String(error || ""),
    };
  }
}

function clearPersistedRecallMessageUiObserver() {
  try {
    persistedRecallUiRefreshObserver?.disconnect?.();
  } catch (error) {
    console.warn("[ST-BME] Recall Card UI observer disconnect 失败:", error);
  }
  persistedRecallUiRefreshObserver = null;
}

function isDomNodeAttached(node) {
  if (!node) return false;
  if (node.isConnected === true) return true;
  return typeof document?.contains === "function"
    ? document.contains(node)
    : true;
}

function cleanupRecallCardElement(cardElement) {
  if (!cardElement) return;
  const messageElement = cardElement.closest?.(".mes") || null;
  if (messageElement) {
    restoreRecallCardUserInputDisplay(messageElement);
  }
  try {
    cardElement._bmeDestroyRenderer?.();
  } catch (error) {
    console.warn("[ST-BME] Recall Card renderer 清理失败:", error);
  }
  cardElement.remove?.();
}

function cleanupLegacyRecallBadges(messageElement) {
  if (!messageElement?.querySelectorAll) return;
  const oldBadges = Array.from(
    messageElement.querySelectorAll(".st-bme-recall-badge") || [],
  );
  for (const oldBadge of oldBadges) oldBadge.remove();
}

function cleanupRecallArtifacts(messageElement, keepMessageIndex = null) {
  if (!messageElement?.querySelectorAll) return;

  cleanupLegacyRecallBadges(messageElement);
  restoreRecallCardUserInputDisplay(messageElement);

  const existingCards = Array.from(
    messageElement.querySelectorAll(".bme-recall-card") || [],
  );
  for (const card of existingCards) {
    if (
      keepMessageIndex !== null &&
      card.dataset?.messageIndex === String(keepMessageIndex)
    ) {
      continue;
    }
    cleanupRecallCardElement(card);
  }
}

function parseStableMessageIndex(candidate) {
  const normalized = String(candidate ?? "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveMessageIndexFromElement(messageElement) {
  if (!messageElement) return null;

  const candidates = [
    messageElement.getAttribute?.("mesid"),
    messageElement.getAttribute?.("data-mesid"),
    messageElement.getAttribute?.("data-message-id"),
    messageElement.dataset?.mesid,
    messageElement.dataset?.messageId,
  ];

  for (const candidate of candidates) {
    const parsed = parseStableMessageIndex(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

function resolveRecallCardAnchor(messageElement) {
  if (!messageElement || !isDomNodeAttached(messageElement)) return null;
  const mesBlock = messageElement.querySelector?.(".mes_block");
  if (isDomNodeAttached(mesBlock)) return mesBlock;

  const mesTextParent =
    messageElement.querySelector?.(".mes_text")?.parentElement;
  if (isDomNodeAttached(mesTextParent)) return mesTextParent;

  return isDomNodeAttached(messageElement) ? messageElement : null;
}

function getRecallMessageElementPriority(messageElement) {
  if (!messageElement || !isDomNodeAttached(messageElement)) return -1;

  let priority = 0;
  const anchor = resolveRecallCardAnchor(messageElement);
  if (anchor === messageElement) priority += 1;
  else if (anchor) priority += 3;

  if (messageElement.querySelector?.(".mes_text")) priority += 1;
  if (messageElement.classList?.contains("last_mes")) priority += 2;
  if (
    messageElement.getAttribute?.("is_user") === "true" ||
    messageElement.dataset?.isUser === "true" ||
    messageElement.classList?.contains("user_mes")
  ) {
    priority += 1;
  }

  return priority;
}

function normalizeRecallCardUserInputDisplayMode(mode) {
  const normalized = String(mode || "").trim();
  if (
    normalized === "off" ||
    normalized === "beautify_only" ||
    normalized === "mirror"
  ) {
    return normalized;
  }
  return "beautify_only";
}

function applyRecallCardUserInputDisplayMode(messageElement, mode) {
  if (!messageElement?.querySelector) return;
  const userTextElement = messageElement.querySelector(".mes_text");
  if (!userTextElement) return;
  userTextElement.classList.toggle(
    "bme-hide-original-user-text",
    normalizeRecallCardUserInputDisplayMode(mode) === "beautify_only",
  );
}

function restoreRecallCardUserInputDisplay(messageElement) {
  if (!messageElement?.querySelector) return;
  const userTextElement = messageElement.querySelector(".mes_text");
  userTextElement?.classList?.remove("bme-hide-original-user-text");
}

function buildPersistedRecallUiRetryDelays(initialDelayMs = 0) {
  const normalizedInitial = Math.max(
    0,
    Number.parseInt(initialDelayMs, 10) || 0,
  );
  if (!normalizedInitial)
    return [...PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS];
  return [
    normalizedInitial,
    ...PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS.filter(
      (delay) => delay > normalizedInitial,
    ),
  ];
}

function summarizePersistedRecallRefreshStatus(summary) {
  if (summary.waitingMessageIndices.length > 0) return "waiting_dom";
  if (summary.anchorFailureIndices.length > 0) return "missing_message_anchor";
  if (summary.renderedCount > 0) return "rendered";
  if (summary.skippedNonUserIndices.length > 0) return "skipped_non_user";
  if (summary.persistedRecordCount === 0) return "missing_recall_record";
  return "missing_message_anchor";
}

function refreshPersistedRecallMessageUi() {
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat) || typeof document?.getElementById !== "function") {
    return {
      status: "missing_chat_root",
      renderedCount: 0,
      persistedRecordCount: 0,
      waitingMessageIndices: [],
      anchorFailureIndices: [],
      skippedNonUserIndices: [],
    };
  }

  const chatRoot = document.getElementById("chat");
  if (!chatRoot) {
    debugPersistedRecallUi("缺少 #chat 根节点");
    return {
      status: "missing_chat_root",
      renderedCount: 0,
      persistedRecordCount: 0,
      waitingMessageIndices: [],
      anchorFailureIndices: [],
      skippedNonUserIndices: [],
    };
  }

  const settings = getSettings();
  const themeName = settings?.panelTheme || "crimson";
  const recallCardUserInputDisplayMode =
    normalizeRecallCardUserInputDisplayMode(
      settings?.recallCardUserInputDisplayMode,
    );
  const callbacks = getRecallCardCallbacks();
  const messageElementMap = new Map();
  const messageElements = Array.from(chatRoot.querySelectorAll(".mes"));
  for (const messageElement of messageElements) {
    cleanupLegacyRecallBadges(messageElement);
    const messageIndex = resolveMessageIndexFromElement(messageElement);
    if (!Number.isFinite(messageIndex)) {
      debugPersistedRecallUi(
        "消息 DOM 缺少稳定索引属性，跳过挂载",
        {
          className: messageElement.className || "",
        },
        "missing-stable-message-index",
      );
      continue;
    }
    if (messageElementMap.has(messageIndex)) {
      const previousElement = messageElementMap.get(messageIndex) || null;
      const previousPriority = getRecallMessageElementPriority(previousElement);
      const nextPriority = getRecallMessageElementPriority(messageElement);
      const shouldReplace = nextPriority >= previousPriority;
      debugPersistedRecallUi(
        "检测到重复消息 DOM 索引，已挑选更可靠的锚点",
        {
          messageIndex,
          previousPriority,
          nextPriority,
          replaced: shouldReplace,
        },
        `duplicate-message-index:${messageIndex}`,
      );
      if (shouldReplace) {
        cleanupRecallArtifacts(previousElement);
        messageElementMap.set(messageIndex, messageElement);
      } else {
        cleanupRecallArtifacts(messageElement);
      }
      continue;
    }
    messageElementMap.set(messageIndex, messageElement);
  }

  const summary = {
    status: "missing_recall_record",
    renderedCount: 0,
    persistedRecordCount: 0,
    waitingMessageIndices: [],
    anchorFailureIndices: [],
    skippedNonUserIndices: [],
  };

  for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
    const message = chat[messageIndex];
    const messageElement = messageElementMap.get(messageIndex) || null;
    const existingCard =
      messageElement?.querySelector?.(
        `.bme-recall-card[data-message-index="${messageIndex}"]`,
      ) || null;

    if (!message?.is_user) {
      if (messageElement) {
        restoreRecallCardUserInputDisplay(messageElement);
      }
      if (existingCard) cleanupRecallCardElement(existingCard);
      const unexpectedRecord = readPersistedRecallFromUserMessage(
        chat,
        messageIndex,
      );
      if (unexpectedRecord) {
        summary.skippedNonUserIndices.push(messageIndex);
        debugPersistedRecallUi(
          "非 user 楼层存在持久召回记录，已跳过挂载",
          {
            messageIndex,
          },
          `skipped-non-user:${messageIndex}`,
        );
      }
      continue;
    }

    const record = readPersistedRecallFromUserMessage(chat, messageIndex);
    if (!record?.injectionText) {
      if (messageElement) {
        restoreRecallCardUserInputDisplay(messageElement);
      }
      if (existingCard) cleanupRecallCardElement(existingCard);
      continue;
    }

    summary.persistedRecordCount += 1;
    if (!messageElement) {
      summary.waitingMessageIndices.push(messageIndex);
      debugPersistedRecallUi(
        "目标 user 楼层 DOM 未就绪，等待后续刷新",
        {
          messageIndex,
        },
        `waiting-dom:${messageIndex}`,
      );
      continue;
    }

    const anchor = resolveRecallCardAnchor(messageElement);
    if (!anchor) {
      restoreRecallCardUserInputDisplay(messageElement);
      cleanupRecallCardElement(existingCard);
      summary.anchorFailureIndices.push(messageIndex);
      debugPersistedRecallUi(
        "目标 user 楼层锚点解析失败，跳过挂载",
        {
          messageIndex,
        },
        `missing-anchor:${messageIndex}`,
      );
      continue;
    }

    cleanupRecallArtifacts(messageElement, messageIndex);
    const currentCard =
      messageElement.querySelector?.(
        `.bme-recall-card[data-message-index="${messageIndex}"]`,
      ) || null;

    if (currentCard) {
      updateRecallCardData(currentCard, record, {
        userMessageText: message.mes || "",
        userInputDisplayMode: recallCardUserInputDisplayMode,
        graph: currentGraph,
        themeName,
        callbacks,
      });
    } else {
      const card = createRecallCardElement({
        messageIndex,
        record,
        userMessageText: message.mes || "",
        userInputDisplayMode: recallCardUserInputDisplayMode,
        graph: currentGraph,
        themeName,
        callbacks,
      });
      anchor.appendChild(card);
    }
    applyRecallCardUserInputDisplayMode(
      messageElement,
      recallCardUserInputDisplayMode,
    );
    summary.renderedCount += 1;
  }

  summary.status = summarizePersistedRecallRefreshStatus(summary);
  if (summary.status === "missing_recall_record") {
    debugPersistedRecallUi("当前无有效持久召回记录可渲染");
  } else if (summary.renderedCount > 0) {
    debugPersistedRecallUi(
      "Recall Card 挂载完成",
      {
        renderedCount: summary.renderedCount,
        persistedRecordCount: summary.persistedRecordCount,
        waitingDom: summary.waitingMessageIndices.length,
      },
      `rendered:${summary.renderedCount}`,
    );
  }
  return summary;
}

function getRecallCardCallbacks() {
  return {
    onEdit: (messageIndex) => {
      const record = getMessageRecallRecord(messageIndex);
      if (!record) return;
      openRecallSidebar({
        mode: "edit",
        messageIndex,
        record,
        node: null,
        graph: currentGraph,
        callbacks: {
          onSave: (idx, newText) => {
            const edited = editMessageRecallRecord(idx, newText);
            if (edited) {
              toastr.success("已保存手动编辑");
            } else {
              toastr.warning("编辑失败：注入文本不能为空");
            }
            schedulePersistedRecallMessageUiRefresh();
          },
          estimateTokens,
        },
      });
    },
    onEditUserInput: (messageIndex, nextUserInputText) => {
      const result = editMessageUserInputText(messageIndex, nextUserInputText);
      if (!result?.ok) {
        toastr.warning("编辑失败：内容不能为空或此楼层非用户消息");
        return result;
      }

      if (result.unchanged) {
        toastr.info("用户输入未变化");
      } else {
        toastr.success("已更新本轮用户输入");
      }
      if (result.recallMayBeStale) {
        toastr.info("输入已改，当前召回结果可能需要重新召回");
      }
      schedulePersistedRecallMessageUiRefresh();
      return result;
    },
    onDelete: (messageIndex) => {
      if (removeMessageRecallRecord(messageIndex)) {
        toastr.success("已删除持久召回注入");
        schedulePersistedRecallMessageUiRefresh();
      }
    },
    onRerunRecall: async (messageIndex) => {
      const result = await rerunRecallForMessage(messageIndex);
      if (result?.status === "completed") {
        toastr.success("重新召回完成");
      }
      schedulePersistedRecallMessageUiRefresh();
    },
    onNodeClick: (messageIndex, node) => {
      const record = getMessageRecallRecord(messageIndex);
      if (!record) return;
      openRecallSidebar({
        mode: "view",
        messageIndex,
        record,
        node,
        graph: currentGraph,
        callbacks: {
          onSave: (idx, newText) => {
            const edited = editMessageRecallRecord(idx, newText);
            if (edited) toastr.success("已保存手动编辑");
            else toastr.warning("编辑失败：注入文本不能为空");
            schedulePersistedRecallMessageUiRefresh();
          },
          estimateTokens,
        },
      });
    },
  };
}

function armPersistedRecallMessageUiObserver(sessionId, runAttempt) {
  clearPersistedRecallMessageUiObserver();
  const chatRoot = document?.getElementById?.("chat");
  const ObserverCtor = globalThis.MutationObserver;
  if (!chatRoot || typeof ObserverCtor !== "function") return false;

  persistedRecallUiRefreshObserver = new ObserverCtor(() => {
    if (sessionId !== persistedRecallUiRefreshSession) return;
    clearPersistedRecallMessageUiObserver();
    runAttempt();
  });
  persistedRecallUiRefreshObserver.observe(chatRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "mesid",
      "data-mesid",
      "data-message-id",
      "class",
      "is_user",
    ],
  });
  return true;
}

function schedulePersistedRecallMessageUiRefresh(delayMs = 0) {
  clearTimeout(persistedRecallUiRefreshTimer);
  clearPersistedRecallMessageUiObserver();

  const retryDelays = buildPersistedRecallUiRetryDelays(delayMs);
  const sessionId = ++persistedRecallUiRefreshSession;
  let attemptIndex = 0;

  const runAttempt = () => {
    if (sessionId !== persistedRecallUiRefreshSession) return;
    if (persistedRecallUiRefreshTimer) {
      clearTimeout(persistedRecallUiRefreshTimer);
      persistedRecallUiRefreshTimer = null;
    }

    const summary = refreshPersistedRecallMessageUi();

    const shouldRetryForPending =
      (summary.status === "missing_chat_root" ||
        summary.status === "waiting_dom" ||
        summary.status === "missing_message_anchor") &&
      attemptIndex < retryDelays.length - 1;

    // 勿在「已成功渲染」时长期监听 MutationObserver：chat 的 class/流式更新会疯狂触发
    // runAttempt，造成满屏刷新与日志；显式事件（USER_MESSAGE_RENDERED 等）仍会 schedule 刷新。
    const shouldWatchForRepaint = false;

    if (!shouldRetryForPending && !shouldWatchForRepaint) {
      clearPersistedRecallMessageUiObserver();
      return;
    }

    armPersistedRecallMessageUiObserver(sessionId, runAttempt);
    if (shouldRetryForPending) {
      attemptIndex += 1;
      persistedRecallUiRefreshTimer = setTimeout(
        runAttempt,
        retryDelays[attemptIndex],
      );
      return;
    }

    const lingerMs = retryDelays[retryDelays.length - 1] || 0;
    if (lingerMs <= 0) {
      clearPersistedRecallMessageUiObserver();
      return;
    }
    persistedRecallUiRefreshTimer = setTimeout(() => {
      if (sessionId !== persistedRecallUiRefreshSession) return;
      clearPersistedRecallMessageUiObserver();
      persistedRecallUiRefreshTimer = null;
    }, lingerMs);
  };

  persistedRecallUiRefreshTimer = setTimeout(
    runAttempt,
    retryDelays[attemptIndex],
  );
}

function cleanupPersistedRecallMessageUi() {
  clearTimeout(persistedRecallUiRefreshTimer);
  persistedRecallUiRefreshTimer = null;
  clearPersistedRecallMessageUiObserver();
  const chatRoot = document.getElementById("chat");
  if (!chatRoot?.querySelectorAll) return;
  for (const messageElement of Array.from(chatRoot.querySelectorAll(".mes"))) {
    cleanupRecallArtifacts(messageElement);
  }
}

async function rerunRecallForMessage(messageIndex) {
  const chat = getContext()?.chat;
  const message = Array.isArray(chat) ? chat[messageIndex] : null;
  cleanupPersistedRecallMessageUi();
  if (!message?.is_user) {
    toastr.info("仅用户消息支持重新召回");
    return null;
  }

  const userMessage = normalizeRecallInputText(message.mes || "");
  if (!userMessage) {
    toastr.info("该楼层内容为空，无法重新召回");
    return null;
  }

  const result = await runRecall({
    overrideUserMessage: userMessage,
    overrideSource: "message-floor-rerecall",
    overrideSourceLabel: `用户楼层 ${messageIndex}`,
    generationType: "history",
    targetUserMessageIndex: messageIndex,
    includeSyntheticUserMessage: false,
    hookName: "MESSAGE_RECALL_BADGE_RERUN",
  });
  applyFinalRecallInjectionForGeneration({
    generationType: "history",
    freshRecallResult: result,
  });
  return result;
}

function getSendTextareaValue() {
  return String(document.getElementById("send_textarea")?.value ?? "");
}

function scheduleSendIntentHookRetry(delayMs = 400) {
  return scheduleSendIntentHookRetryController(
    {
      clearTimeout,
      getSendIntentHookRetryTimer: () => sendIntentHookRetryTimer,
      installSendIntentHooks,
      setSendIntentHookRetryTimer: (timer) => {
        sendIntentHookRetryTimer = timer;
      },
      setTimeout,
    },
    delayMs,
  );
}

function registerBeforeCombinePrompts(listener) {
  return registerBeforeCombinePromptsController(
    {
      console,
      eventSource,
      eventTypes: event_types,
      getEventMakeFirst: () => globalThis.eventMakeFirst,
    },
    listener,
  );
}

function registerGenerationAfterCommands(listener) {
  return registerGenerationAfterCommandsController(
    {
      console,
      eventSource,
      eventTypes: event_types,
      getEventMakeFirst: () => globalThis.eventMakeFirst,
    },
    listener,
  );
}

function installSendIntentHooks() {
  return installSendIntentHooksController({
    console,
    consumeSendIntentHookCleanup: () =>
      sendIntentHookCleanup.splice(0, sendIntentHookCleanup.length),
    document,
    getSendTextareaValue,
    pushSendIntentHookCleanup: (cleanup) => {
      sendIntentHookCleanup.push(cleanup);
    },
    recordRecallSendIntent,
    scheduleSendIntentHookRetry,
  });
}

// ==================== 设置管理 ====================

function getSettings() {
  const mergedSettings = mergePersistedSettings(
    extension_settings[MODULE_NAME] || {},
  );
  const migrated = migrateLegacyTaskProfiles(mergedSettings);
  mergedSettings.taskProfilesVersion = migrated.taskProfilesVersion;
  mergedSettings.taskProfiles = migrated.taskProfiles;
  const regexMigration = migratePerTaskRegexToGlobal(mergedSettings);
  if (regexMigration.changed) {
    mergedSettings.globalTaskRegex = regexMigration.settings.globalTaskRegex;
    mergedSettings.taskProfiles = regexMigration.settings.taskProfiles;
  }
  extension_settings[MODULE_NAME] = mergedSettings;
  globalThis.__stBmeDebugLoggingEnabled = Boolean(
    mergedSettings.debugLoggingEnabled,
  );
  return mergedSettings;
}

function buildIndexedDbStorePresentation() {
  return {
    storagePrimary: "indexeddb",
    storageMode: BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
    statusLabel: "IndexedDB",
    reasonPrefix: "indexeddb",
  };
}

function buildOpfsStorePresentation(
  mode = BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
) {
  const normalizedMode = normalizeGraphLocalStorageMode(
    mode,
    BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  );
  return {
    storagePrimary: "opfs",
    storageMode:
      normalizedMode === BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW
        ? BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY
        : normalizedMode,
    statusLabel: "OPFS",
    reasonPrefix: "opfs",
  };
}

function buildAuthorityStorePresentation() {
  return {
    storagePrimary: AUTHORITY_GRAPH_STORE_KIND,
    storageMode: AUTHORITY_GRAPH_STORE_MODE,
    statusLabel: "Authority SQL",
    reasonPrefix: "authority-sql",
  };
}

function getRequestedGraphLocalStorageMode(settings = getSettings()) {
  const sourceSettings =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings
      : {};
  return normalizeGraphLocalStorageMode(
    sourceSettings.graphLocalStorageMode,
    "auto",
  );
}

function shouldUseAuthorityGraphStore(settings = getSettings(), capability = authorityCapabilityState) {
  const normalizedSettings = normalizeAuthoritySettings(settings);
  const normalizedCapability = normalizeAuthorityCapabilityState(capability, settings);
  return (
    normalizedSettings.enabled &&
    normalizedSettings.primaryWhenAvailable &&
    normalizedSettings.sqlPrimary &&
    normalizedSettings.storageMode !== "local-primary" &&
    normalizedSettings.storageMode !== "off" &&
    normalizedCapability.serverPrimaryReady &&
    normalizedCapability.storagePrimaryReady
  );
}

function shouldProbeAuthorityForStoreSelection(settings = getSettings()) {
  const normalizedSettings = normalizeAuthoritySettings(settings);
  if (
    !normalizedSettings.enabled ||
    !normalizedSettings.primaryWhenAvailable ||
    !normalizedSettings.sqlPrimary ||
    normalizedSettings.storageMode === "local-primary" ||
    normalizedSettings.storageMode === "off"
  ) {
    return false;
  }
  if (authorityProbePromise) return true;
  const lastProbeAt = Number(authorityCapabilityState?.lastProbeAt || 0);
  if (!lastProbeAt) return true;
  return Date.now() - lastProbeAt >= normalizedSettings.probeIntervalMs;
}

async function resolveAuthorityCapabilityForStoreSelection(settings = getSettings()) {
  if (shouldProbeAuthorityForStoreSelection(settings)) {
    return await refreshAuthorityRuntimeState({
      source: "store-selection",
    });
  }
  authorityCapabilityState = normalizeAuthorityCapabilityState(
    authorityCapabilityState,
    settings,
  );
  return authorityCapabilityState;
}

function buildAuthorityGraphStoreOptions(settings = getSettings()) {
  const normalizedSettings = normalizeAuthoritySettings(settings);
  return {
    baseUrl: normalizedSettings.baseUrl,
    headerProvider:
      typeof getRequestHeaders === "function" ? () => getRequestHeaders() : null,
  };
}

function resolveDbGraphStorePresentation(db = null) {
  if (
    db?.storeKind === AUTHORITY_GRAPH_STORE_KIND ||
    db?.storeMode === AUTHORITY_GRAPH_STORE_MODE
  ) {
    return buildAuthorityStorePresentation();
  }
  if (db?.storeKind === "opfs" || isGraphLocalStorageModeOpfs(db?.storeMode)) {
    return buildOpfsStorePresentation(db?.storeMode);
  }
  return buildIndexedDbStorePresentation();
}

function readLocalStoreDiagnosticsSync(
  db = null,
  presentation = buildIndexedDbStorePresentation(),
) {
  const resolvedPresentation =
    presentation && typeof presentation === "object"
      ? presentation
      : resolveDbGraphStorePresentation(db);
  const rawDiagnostics =
    typeof db?.getStorageDiagnosticsSync === "function"
      ? db.getStorageDiagnosticsSync()
      : null;
  return {
    resolvedLocalStore: buildGraphLocalStoreSelectorKey(resolvedPresentation),
    localStoreFormatVersion:
      Number(rawDiagnostics?.formatVersion || 0) ||
      (resolvedPresentation.storagePrimary === "opfs" ? 2 : 1),
    localStoreMigrationState:
      String(rawDiagnostics?.migrationState || "").trim() || "idle",
    opfsWalDepth: Number(rawDiagnostics?.walCount || 0),
    opfsPendingBytes: Number(rawDiagnostics?.walTotalBytes || 0),
    opfsCompactionState: cloneRuntimeDebugValue(
      rawDiagnostics?.compactionState || null,
      null,
    ),
  };
}

function resolveSnapshotGraphStorePresentation(
  snapshot = null,
  fallbackPresentation = buildIndexedDbStorePresentation(),
) {
  const normalizedFallback =
    fallbackPresentation && typeof fallbackPresentation === "object"
      ? fallbackPresentation
      : buildIndexedDbStorePresentation();
  const snapshotPrimary = String(snapshot?.meta?.storagePrimary || "")
    .trim()
    .toLowerCase();
  const snapshotStorageMode = String(snapshot?.meta?.storageMode || "")
    .trim()
    .toLowerCase();
  if (
    snapshotPrimary === AUTHORITY_GRAPH_STORE_KIND ||
    snapshotStorageMode === AUTHORITY_GRAPH_STORE_MODE
  ) {
    return buildAuthorityStorePresentation();
  }
  const snapshotMode = normalizeGraphLocalStorageMode(
    snapshot?.meta?.storageMode,
    normalizedFallback.storageMode,
  );
  if (snapshotPrimary === "opfs" || isGraphLocalStorageModeOpfs(snapshotMode)) {
    return buildOpfsStorePresentation(snapshotMode);
  }
  return buildIndexedDbStorePresentation();
}

function buildGraphLocalStoreSelectorKey(
  presentation = buildIndexedDbStorePresentation(),
) {
  const normalizedPresentation =
    presentation && typeof presentation === "object"
      ? presentation
      : buildIndexedDbStorePresentation();
  if (
    normalizedPresentation.storagePrimary === AUTHORITY_GRAPH_STORE_KIND ||
    normalizedPresentation.storageMode === AUTHORITY_GRAPH_STORE_MODE
  ) {
    return `${AUTHORITY_GRAPH_STORE_KIND}:${AUTHORITY_GRAPH_STORE_MODE}`;
  }
  const storagePrimary =
    normalizedPresentation.storagePrimary === "opfs" ||
    isGraphLocalStorageModeOpfs(normalizedPresentation.storageMode)
      ? "opfs"
      : "indexeddb";
  const storageMode =
        storagePrimary === "opfs"
      ? normalizeGraphLocalStorageMode(
          normalizedPresentation.storageMode,
          BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
        )
      : BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB;
  return `${storagePrimary}:${storageMode}`;
}

function isGraphLocalStorePresentationCompatible(left, right) {
  return (
    buildGraphLocalStoreSelectorKey(left) ===
    buildGraphLocalStoreSelectorKey(right)
  );
}

function isCachedIndexedDbSnapshotCompatible(snapshot = null, expectedStore = null) {
  if (!expectedStore || typeof expectedStore !== "object") return true;
  const snapshotStore = resolveSnapshotGraphStorePresentation(snapshot, expectedStore);
  return isGraphLocalStorePresentationCompatible(snapshotStore, expectedStore);
}

async function getGraphLocalStoreCapability(forceRefresh = false) {
  const settings =
    arguments.length > 1 && arguments[1] && typeof arguments[1] === "object"
      ? arguments[1].settings || getSettings()
      : getSettings();
  const eagerRetry =
    arguments.length > 1 &&
    arguments[1] &&
    typeof arguments[1] === "object" &&
    arguments[1].eagerRetry === true;
  const requestedMode = getRequestedGraphLocalStorageMode(settings);
  const usesOpfsPreference =
    requestedMode === "auto" || isGraphLocalStorageModeOpfs(requestedMode);
  const capabilityReason = String(
    bmeLocalStoreCapabilitySnapshot?.reason || "",
  ).trim();
  const capabilityFailureStable =
    capabilityReason === "missing-directory-handle" ||
    capabilityReason === "OPFS 不可用" ||
    /not.?supported/i.test(capabilityReason) ||
    /missing.+getdirectory/i.test(capabilityReason);
  const capabilityFailureRetryable =
    usesOpfsPreference &&
    bmeLocalStoreCapabilitySnapshot.checked === true &&
    bmeLocalStoreCapabilitySnapshot.opfsAvailable !== true &&
    capabilityFailureStable !== true;
  const capabilityFailureAgeMs = Math.max(
    0,
    Date.now() - Number(bmeLocalStoreCapabilitySnapshot?.checkedAt || 0),
  );
  const shouldRetryFailedProbe =
    forceRefresh !== true &&
    capabilityFailureRetryable &&
    (eagerRetry === true ||
      capabilityFailureAgeMs >= BME_LOCAL_STORE_CAPABILITY_FAILURE_RETRY_MS);

  if (
    !forceRefresh &&
    !shouldRetryFailedProbe &&
    bmeLocalStoreCapabilitySnapshot.checked
  ) {
    return bmeLocalStoreCapabilitySnapshot;
  }
  if (!forceRefresh && !shouldRetryFailedProbe && bmeLocalStoreCapabilityPromise) {
    return await bmeLocalStoreCapabilityPromise;
  }

  bmeLocalStoreCapabilityPromise = detectOpfsSupport()
     .then((result) => {
        bmeLocalStoreCapabilitySnapshot = {
          checked: true,
          checkedAt: Date.now(),
          opfsAvailable: Boolean(result?.available),
          reason: String(result?.reason || (result?.available ? "ok" : "unavailable")),
        };
        if (bmeLocalStoreCapabilitySnapshot.opfsAvailable) {
          bmeLocalStoreCapabilityWarningShown = false;
        }
        return bmeLocalStoreCapabilitySnapshot;
      })
    .catch((error) => {
      bmeLocalStoreCapabilitySnapshot = {
        checked: true,
        checkedAt: Date.now(),
        opfsAvailable: false,
        reason: error?.message || String(error),
      };
      return bmeLocalStoreCapabilitySnapshot;
    })
    .finally(() => {
      bmeLocalStoreCapabilityPromise = null;
    });

  return await bmeLocalStoreCapabilityPromise;
}

function getPreferredGraphLocalStorePresentationSync(settings = getSettings()) {
  if (shouldUseAuthorityGraphStore(settings, authorityCapabilityState)) {
    return buildAuthorityStorePresentation();
  }
  const requestedMode = getRequestedGraphLocalStorageMode(settings);
  if (
    requestedMode === "auto" &&
    bmeLocalStoreCapabilitySnapshot?.opfsAvailable
  ) {
    return buildOpfsStorePresentation(BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY);
  }
  if (
    isGraphLocalStorageModeOpfs(requestedMode) &&
    bmeLocalStoreCapabilitySnapshot?.opfsAvailable
  ) {
    return buildOpfsStorePresentation(requestedMode);
  }
  return buildIndexedDbStorePresentation();
}

async function resolvePreferredGraphLocalStorePresentation(
  settings = getSettings(),
) {
  const authorityCapability =
    await resolveAuthorityCapabilityForStoreSelection(settings);
  if (shouldUseAuthorityGraphStore(settings, authorityCapability)) {
    return buildAuthorityStorePresentation();
  }
  const requestedMode = getRequestedGraphLocalStorageMode(settings);
  if (requestedMode === "auto") {
    const capability = await getGraphLocalStoreCapability(false, {
      settings,
    });
    return capability.opfsAvailable
      ? buildOpfsStorePresentation(BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY)
      : buildIndexedDbStorePresentation();
  }
  if (!isGraphLocalStorageModeOpfs(requestedMode)) {
    return buildIndexedDbStorePresentation();
  }

  const capability = await getGraphLocalStoreCapability(false, {
    settings,
  });
  if (capability.opfsAvailable) {
    return buildOpfsStorePresentation(requestedMode);
  }

  if (!bmeLocalStoreCapabilityWarningShown) {
    console.warn("[ST-BME] OPFS 不可用，已回退到 IndexedDB:", capability.reason);
    bmeLocalStoreCapabilityWarningShown = true;
  }
  return buildIndexedDbStorePresentation();
}

async function createPreferredGraphLocalStore(
  chatId,
  settings = getSettings(),
) {
  const preferredLocalStore =
    await resolvePreferredGraphLocalStorePresentation(settings);
  if (
    preferredLocalStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND &&
    typeof AuthorityGraphStore === "function"
  ) {
    return new AuthorityGraphStore(chatId, buildAuthorityGraphStoreOptions(settings));
  }
  if (
    preferredLocalStore.storagePrimary === "opfs" &&
    typeof OpfsGraphStore === "function"
  ) {
    return new OpfsGraphStore(chatId, {
      storeMode: preferredLocalStore.storageMode,
    });
  }
  return new BmeDatabase(chatId);
}

async function refreshCurrentChatLocalStoreBinding(
  {
    chatId = getCurrentChatId(getContext()),
    forceCapabilityRefresh = false,
    reopenCurrentDb = false,
    source = "manual-refresh",
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const settings = getSettings();
  const requestedMode = getRequestedGraphLocalStorageMode(settings);
  const authorityCapability =
    await resolveAuthorityCapabilityForStoreSelection(settings);
  const authorityPrimary = shouldUseAuthorityGraphStore(
    settings,
    authorityCapability,
  );
  const shouldProbeCapability =
    !authorityPrimary &&
    (forceCapabilityRefresh === true ||
      !bmeLocalStoreCapabilitySnapshot.checked ||
      requestedMode === "auto" ||
      isGraphLocalStorageModeOpfs(requestedMode));

  if (shouldProbeCapability) {
    await getGraphLocalStoreCapability(forceCapabilityRefresh === true, {
      settings,
      eagerRetry: forceCapabilityRefresh === true,
    });
  }

  const preferredLocalStore =
    await resolvePreferredGraphLocalStorePresentation(settings);
  let resolvedLocalStore = preferredLocalStore;
  let localStoreDiagnostics = {
    resolvedLocalStore: buildGraphLocalStoreSelectorKey(preferredLocalStore),
    localStoreFormatVersion:
      preferredLocalStore.storagePrimary === "opfs" ? 2 : 1,
    localStoreMigrationState: "idle",
    opfsWalDepth: 0,
    opfsPendingBytes: 0,
    opfsCompactionState: null,
  };
  let opfsWriteLockState = cloneRuntimeDebugValue(
    graphPersistenceState.opfsWriteLockState,
    null,
  );
  let reopenError = "";

  if (
    reopenCurrentDb === true &&
    normalizedChatId &&
    bmeChatManager &&
    typeof bmeChatManager.getCurrentChatId === "function" &&
    typeof bmeChatManager.closeCurrent === "function" &&
    bmeChatManager.getCurrentChatId() === normalizedChatId
  ) {
    await bmeChatManager.closeCurrent();
  }

  if (normalizedChatId) {
    clearCachedIndexedDbSnapshot(normalizedChatId);
    try {
      const manager = ensureBmeChatManager();
      if (manager) {
        const db = await manager.getCurrentDb(normalizedChatId);
        resolvedLocalStore = resolveDbGraphStorePresentation(db);
        localStoreDiagnostics = readLocalStoreDiagnosticsSync(
          db,
          resolvedLocalStore,
        );
        opfsWriteLockState =
          typeof db?.getWriteLockSnapshot === "function"
            ? cloneRuntimeDebugValue(db.getWriteLockSnapshot(), null)
            : opfsWriteLockState;
      }
    } catch (error) {
      reopenError = error?.message || String(error);
      console.warn(
        "[ST-BME] 刷新当前聊天本地存储绑定失败:",
        {
          chatId: normalizedChatId,
          source,
          requestedMode,
          error: reopenError,
        },
      );
    }
  }

  const persistenceEnvironment = buildPersistenceEnvironment(
    getContext(),
    resolvedLocalStore,
  );
  updateGraphPersistenceState({
    hostProfile: persistenceEnvironment.hostProfile,
    primaryStorageTier: persistenceEnvironment.primaryStorageTier,
    cacheStorageTier: persistenceEnvironment.cacheStorageTier,
    storagePrimary: resolvedLocalStore.storagePrimary,
    storageMode: resolvedLocalStore.storageMode,
    resolvedLocalStore: localStoreDiagnostics.resolvedLocalStore,
    localStoreFormatVersion: localStoreDiagnostics.localStoreFormatVersion,
    localStoreMigrationState: localStoreDiagnostics.localStoreMigrationState,
    opfsWriteLockState,
    opfsWalDepth: localStoreDiagnostics.opfsWalDepth,
    opfsPendingBytes: localStoreDiagnostics.opfsPendingBytes,
    opfsCompactionState: localStoreDiagnostics.opfsCompactionState,
    indexedDbLastError: reopenError ? reopenError : "",
  });

  return {
    capability: cloneRuntimeDebugValue(bmeLocalStoreCapabilitySnapshot, null),
    requestedMode,
    resolvedLocalStore,
    localStoreDiagnostics,
    reopenError,
  };
}

function buildPanelOpenLocalStoreRefreshPlan(
  context = getContext(),
  settings = getSettings(),
) {
  const requestedMode = getRequestedGraphLocalStorageMode(settings);
  const usesOpfsPreference =
    requestedMode === "auto" || isGraphLocalStorageModeOpfs(requestedMode);
  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  const preferredLocalStore = getPreferredGraphLocalStorePresentationSync(settings);
  const resolvedLocalStoreKey = String(
    graphPersistenceState.resolvedLocalStore ||
      buildGraphLocalStoreSelectorKey(preferredLocalStore),
  ).trim();
  const resolvedIsOpfs = resolvedLocalStoreKey.startsWith("opfs:");
  const preferredIsOpfs = preferredLocalStore.storagePrimary === "opfs";
  const capabilityUnchecked = bmeLocalStoreCapabilitySnapshot.checked !== true;
  const capabilityRetryRecommended =
    usesOpfsPreference &&
    bmeLocalStoreCapabilitySnapshot.checked === true &&
    bmeLocalStoreCapabilitySnapshot.opfsAvailable !== true &&
    !(
      String(bmeLocalStoreCapabilitySnapshot.reason || "") ===
        "missing-directory-handle" ||
      String(bmeLocalStoreCapabilitySnapshot.reason || "") === "OPFS 不可用" ||
      /not.?supported/i.test(
        String(bmeLocalStoreCapabilitySnapshot.reason || ""),
      ) ||
      /missing.+getdirectory/i.test(
        String(bmeLocalStoreCapabilitySnapshot.reason || ""),
      )
    );
  const pendingPersist = graphPersistenceState.pendingPersist === true;
  const writesBlocked = graphPersistenceState.writesBlocked === true;
  const loadState = String(graphPersistenceState.loadState || "");
  const loadingWithoutDb =
    loadState === GRAPH_LOAD_STATES.LOADING && graphPersistenceState.dbReady !== true;
  const blocked = loadState === GRAPH_LOAD_STATES.BLOCKED;
  const persistError = String(graphPersistenceState.indexedDbLastError || "").trim();
  const localStoreMismatch =
    Boolean(activeChatId) &&
    preferredIsOpfs &&
    Boolean(resolvedLocalStoreKey) &&
    !resolvedIsOpfs;
  const shouldRefresh =
    usesOpfsPreference &&
    (capabilityUnchecked ||
      capabilityRetryRecommended ||
      pendingPersist ||
      writesBlocked ||
      blocked ||
      loadingWithoutDb ||
      Boolean(persistError) ||
      localStoreMismatch);
  const forceCapabilityRefresh =
    capabilityUnchecked ||
    capabilityRetryRecommended ||
    pendingPersist ||
    blocked ||
    loadingWithoutDb ||
    Boolean(persistError) ||
    localStoreMismatch;
  const reopenCurrentDb =
    Boolean(activeChatId) &&
    (pendingPersist || writesBlocked || blocked || Boolean(persistError) || localStoreMismatch);
  const reasons = [];
  if (capabilityUnchecked) reasons.push("capability-unchecked");
  if (capabilityRetryRecommended) reasons.push("capability-retryable-failure");
  if (pendingPersist) reasons.push("pending-persist");
  if (writesBlocked) reasons.push("writes-blocked");
  if (blocked) reasons.push("load-blocked");
  if (loadingWithoutDb) reasons.push("loading-without-db");
  if (persistError) reasons.push("local-store-error");
  if (localStoreMismatch) reasons.push("resolved-store-mismatch");

  return {
    shouldRefresh,
    forceCapabilityRefresh,
    reopenCurrentDb,
    requestedMode,
    resolvedLocalStoreKey,
    preferredLocalStore,
    reasons,
  };
}

function getMessageHideSettings(settings = null) {
  let sourceSettings = settings;
  if (!sourceSettings || typeof sourceSettings !== "object") {
    try {
      sourceSettings =
        typeof getSettings === "function" ? getSettings() : {};
    } catch {
      sourceSettings = {};
    }
  }
  return {
    enabled: Boolean(sourceSettings.hideOldMessagesEnabled),
    hide_last_n: Math.max(
      0,
      Math.trunc(Number(sourceSettings.hideOldMessagesKeepLastN ?? 0) || 0),
    ),
  };
}

function getMessageRenderLimitSettings(settings = null) {
  let sourceSettings = settings;
  if (!sourceSettings || typeof sourceSettings !== "object") {
    try {
      sourceSettings =
        typeof getSettings === "function" ? getSettings() : {};
    } catch {
      sourceSettings = {};
    }
  }
  return {
    enabled:
      sourceSettings.enabled !== false &&
      Boolean(sourceSettings.hideOldMessagesRenderLimitEnabled),
    render_last_n: Math.max(
      0,
      Math.trunc(Number(sourceSettings.hideOldMessagesRenderLimit ?? 0) || 0),
    ),
  };
}

function getHostPowerUserSettings() {
  try {
    const context = typeof getContext === "function" ? getContext() : null;
    return (
      context?.power_user ||
      context?.powerUserSettings ||
      globalThis.power_user ||
      null
    );
  } catch {
    return globalThis.power_user || null;
  }
}

function applyMessageRenderLimit(settings = null, options = {}) {
  const normalized = getMessageRenderLimitSettings(settings);
  const shouldClear = options.clearWhenDisabled === true;
  if (!normalized.enabled && !shouldClear) {
    return {
      active: false,
      renderLimit: 0,
      applied: false,
      skipped: true,
    };
  }

  const renderLimit =
    normalized.enabled && normalized.render_last_n > 0
      ? normalized.render_last_n
      : 0;
  let applied = false;
  const powerUserSettings = getHostPowerUserSettings();
  if (powerUserSettings && typeof powerUserSettings === "object") {
    powerUserSettings.chat_truncation = renderLimit;
    applied = true;
  }

  try {
    const jq = typeof $ === "function" ? $ : null;
    if (jq) {
      const value = String(renderLimit);
      const truncationInput = jq("#chat_truncation");
      if (
        truncationInput &&
        Number(truncationInput.length || 0) > 0 &&
        typeof truncationInput.val === "function"
      ) {
        truncationInput.val(value);
        if (typeof truncationInput.trigger === "function") {
          truncationInput.trigger("change");
        }
        applied = true;
      }
      const truncationCounter = jq("#chat_truncation_counter");
      if (
        truncationCounter &&
        Number(truncationCounter.length || 0) > 0 &&
        typeof truncationCounter.val === "function"
      ) {
        truncationCounter.val(value);
        applied = true;
      }
    }
  } catch (error) {
    console.warn("[ST-BME] 同步聊天区渲染楼层限制失败:", error);
  }

  if (options.reloadCurrentChat === true) {
    try {
      const context = typeof getContext === "function" ? getContext() : null;
      if (typeof context?.reloadCurrentChat === "function") {
        context.reloadCurrentChat();
      }
    } catch (error) {
      console.warn("[ST-BME] 重新加载聊天区渲染楼层失败:", error);
    }
  }

  return {
    active: renderLimit > 0,
    renderLimit,
    applied,
    skipped: false,
  };
}

function getActiveMessageRenderLimitForHistoryGuard(settings = null) {
  const normalized = getMessageRenderLimitSettings(settings);
  const configuredLimit =
    normalized.enabled && normalized.render_last_n > 0
      ? normalized.render_last_n
      : 0;
  let hostLimit = 0;
  try {
    const powerUserSettings = getHostPowerUserSettings();
    hostLimit = Math.max(
      0,
      Math.trunc(Number(powerUserSettings?.chat_truncation ?? 0) || 0),
    );
  } catch {
    hostLimit = 0;
  }

  if (configuredLimit > 0 && hostLimit > 0) {
    return Math.min(configuredLimit, hostLimit);
  }
  return Math.max(configuredLimit, hostLimit);
}

function getHighestTrackedProcessedHistoryFloor(historyState = {}) {
  const lastProcessed = Number.isFinite(
    Number(historyState?.lastProcessedAssistantFloor),
  )
    ? Math.floor(Number(historyState.lastProcessedAssistantFloor))
    : -1;
  const hashes =
    historyState?.processedMessageHashes &&
    typeof historyState.processedMessageHashes === "object" &&
    !Array.isArray(historyState.processedMessageHashes)
      ? historyState.processedMessageHashes
      : {};
  const maxHashFloor = Object.keys(hashes).reduce((maxFloor, key) => {
    const floor = Number.parseInt(key, 10);
    return Number.isFinite(floor) ? Math.max(maxFloor, floor) : maxFloor;
  }, -1);

  return Math.max(lastProcessed, maxHashFloor);
}

function getRenderLimitedHistoryRecoveryGuard(
  chat,
  { settings = null, historyState = currentGraph?.historyState } = {},
) {
  const renderLimit = getActiveMessageRenderLimitForHistoryGuard(settings);
  if (!Array.isArray(chat) || renderLimit <= 0) {
    return { blocked: false };
  }

  const chatLength = chat.length;
  const highestProcessedFloor =
    getHighestTrackedProcessedHistoryFloor(historyState);
  const renderWindowTolerance = renderLimit + 1;
  if (
    chatLength > renderWindowTolerance ||
    highestProcessedFloor < chatLength
  ) {
    return { blocked: false };
  }

  return {
    blocked: true,
    chatLength,
    highestProcessedFloor,
    renderLimit,
    reason: "render-limited-chat-slice",
    message:
      `当前聊天区最多只渲染最近 ${renderLimit} 条消息，当前可见 ${chatLength} 条；` +
      `图谱已处理到楼层 ${highestProcessedFloor}。为避免把截断视图误判为历史删除并清空运行时图谱，已暂停历史恢复。` +
      "请临时关闭“限制聊天区渲染楼层”或调大渲染数量并刷新后再提取。",
  };
}

function notifyRenderLimitedHistoryRecoveryBlocked(guard, trigger = "") {
  if (!guard?.blocked) return;
  console.warn?.("[ST-BME] 历史恢复因聊天渲染限制暂停:", {
    trigger,
    chatLength: guard.chatLength,
    highestProcessedFloor: guard.highestProcessedFloor,
    renderLimit: guard.renderLimit,
  });
  updateStageNotice(
    "history",
    "历史恢复已暂停",
    guard.message,
    "warning",
    {
      busy: false,
      persist: true,
    },
  );
}

function getHideRuntimeAdapters() {
  return {
    $,
    clearTimeout,
    getContext,
    refreshPanelLiveState,
    setTimeout,
  };
}

async function applyMessageHideNow(reason = "manual-apply") {
  try {
    const result = await applyHideSettings(
      getMessageHideSettings(),
      getHideRuntimeAdapters(),
    );
    debugLog("[ST-BME] 已应用旧楼层隐藏:", reason, result);
    refreshPanelLiveState();
    return result;
  } catch (error) {
    console.warn("[ST-BME] 应用旧楼层隐藏失败:", reason, error);
    return {
      active: false,
      error: error instanceof Error ? error.message : String(error || "未知错误"),
    };
  }
}

function scheduleMessageHideApply(reason = "scheduled", delayMs = 120) {
  try {
    scheduleHideSettingsApply(
      getMessageHideSettings(),
      getHideRuntimeAdapters(),
      delayMs,
    );
  } catch (error) {
    console.warn("[ST-BME] 调度旧楼层隐藏失败:", reason, error);
  }
}

async function runIncrementalMessageHide(reason = "incremental") {
  try {
    const result = await runIncrementalHideCheck(
      getMessageHideSettings(),
      getHideRuntimeAdapters(),
    );
    if (result?.active) {
      debugLog("[ST-BME] 已增量更新旧楼层隐藏:", reason, result);
    }
    refreshPanelLiveState();
    return result;
  } catch (error) {
    console.warn("[ST-BME] 增量更新旧楼层隐藏失败:", reason, error);
    return {
      active: false,
      error: error instanceof Error ? error.message : String(error || "未知错误"),
    };
  }
}

function clearMessageHideState(reason = "reset") {
  try {
    resetHideState(getHideRuntimeAdapters());
    debugLog("[ST-BME] 已重置旧楼层隐藏状态:", reason);
    refreshPanelLiveState();
  } catch (error) {
    console.warn("[ST-BME] 重置旧楼层隐藏状态失败:", reason, error);
  }
}

async function clearAllHiddenMessages(reason = "manual-clear") {
  try {
    const result = await unhideAll(getHideRuntimeAdapters());
    debugLog("[ST-BME] 已取消全部旧楼层隐藏:", reason, result);
    refreshPanelLiveState();
    return result;
  } catch (error) {
    console.warn("[ST-BME] 取消全部旧楼层隐藏失败:", reason, error);
    return {
      active: false,
      error: error instanceof Error ? error.message : String(error || "未知错误"),
    };
  }
}

function initializeHostCapabilityBridge(options = {}) {
  try {
    initializeHostAdapter({
      getContext,
      ...options,
    });
  } catch (error) {
    console.warn("[ST-BME] 宿主桥接初始化失败:", error);
  }

  return getHostCapabilityStatus();
}

function buildHostCapabilityErrorStatus(error) {
  const snapshot = {
    available: false,
    mode: "error",
    fallbackReason:
      error instanceof Error ? error.message : String(error || "未知错误"),
    versionHints: {
      stateSemantics: HOST_ADAPTER_STATE_SEMANTICS,
      refreshMode: "manual-rebuild",
    },
    stateSemantics: HOST_ADAPTER_STATE_SEMANTICS,
    refreshMode: "manual-rebuild",
    snapshotRevision: -1,
    snapshotCreatedAt: "",
  };
  recordHostCapabilitySnapshot(snapshot);
  return snapshot;
}

export function getHostCapabilityStatus(options = {}) {
  const normalizedOptions =
    options && typeof options === "object" ? { ...options } : {};
  const shouldRefresh = normalizedOptions.refresh === true;

  delete normalizedOptions.refresh;

  try {
    const snapshot = shouldRefresh
      ? refreshHostCapabilitySnapshot(normalizedOptions)
      : getHostCapabilitySnapshot();
    recordHostCapabilitySnapshot(snapshot);
    return snapshot;
  } catch (error) {
    console.warn("[ST-BME] 读取宿主桥接状态失败:", error);
    return buildHostCapabilityErrorStatus(error);
  }
}

export function refreshHostCapabilityStatus(options = {}) {
  return getHostCapabilityStatus({
    ...options,
    refresh: true,
  });
}

export function getHostCapability(name, options = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;

  try {
    return readHostCapability(normalizedName, options) || null;
  } catch (error) {
    console.warn("[ST-BME] 读取宿主桥接能力失败:", error);
    return getHostCapabilityStatus(options)?.[normalizedName] || null;
  }
}

export function getPanelRuntimeDebugSnapshot(options = {}) {
  const shouldRefreshHost = options?.refreshHost === true;
  const hostCapabilities = shouldRefreshHost
    ? refreshHostCapabilityStatus()
    : getHostCapabilityStatus();

  return {
    hostCapabilities,
    messageHiding: getHideStateSnapshot(),
    runtimeDebug: readRuntimeDebugSnapshot(),
  };
}

function getSchema() {
  const settings = getSettings();
  const schema = settings.nodeTypeSchema || DEFAULT_NODE_SCHEMA;
  const validation = validateSchema(schema);
  if (!validation.valid) {
    console.warn("[ST-BME] Schema 非法，回退到默认 Schema:", validation.errors);
    return DEFAULT_NODE_SCHEMA;
  }
  return schema;
}

function getConfiguredTimeoutMs(settings = getSettings()) {
  return typeof resolveConfiguredTimeoutMs === "function"
    ? resolveConfiguredTimeoutMs(settings, LOCAL_VECTOR_TIMEOUT_MS)
    : (() => {
        const timeoutMs = Number(settings?.timeoutMs);
        return Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : LOCAL_VECTOR_TIMEOUT_MS;
      })();
}

function getPlannerRecallTimeoutMs() {
  return getConfiguredTimeoutMs(getSettings());
}

function getEmbeddingConfig(mode = null) {
  const settings = getSettings();
  if (!mode) {
    const authorityRuntime = getAuthorityRuntimeSnapshot(settings);
    const vectorMode = String(settings.authorityVectorMode || "auto-primary");
    if (
      settings.authorityTriviumPrimary !== false &&
      vectorMode !== "off" &&
      vectorMode !== "local-fallback" &&
      authorityRuntime.capability.triviumPrimaryReady
    ) {
      return normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
    }
  }
  return getVectorConfigFromSettings(
    mode ? { ...settings, embeddingTransportMode: mode } : settings,
  );
}

async function doesIndexedDbChatStoreExist(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return false;

  const DexieCtor = globalThis.Dexie || (await ensureDexieLoaded());
  if (typeof DexieCtor?.exists === "function") {
    return await DexieCtor.exists(buildBmeDbName(normalizedChatId));
  }

  if (typeof DexieCtor?.getDatabaseNames === "function") {
    const names = await DexieCtor.getDatabaseNames();
    return Array.isArray(names)
      ? names.includes(buildBmeDbName(normalizedChatId))
      : false;
  }

  return false;
}

async function exportIndexedDbSnapshotForChat(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return null;
  }

  if (!(await doesIndexedDbChatStoreExist(normalizedChatId))) {
    return null;
  }

  const DexieCtor = globalThis.Dexie || (await ensureDexieLoaded());
  const db = new BmeDatabase(normalizedChatId, {
    dexieClass: DexieCtor,
  });

  try {
    await db.open();
    return await db.exportSnapshot();
  } finally {
    await db.close();
  }
}

async function exportOpfsSnapshotForChat(chatId) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  if (!bmeLocalStoreCapabilitySnapshot?.opfsAvailable) return null;
  try {
    if (typeof OpfsGraphStore !== "function") return null;
    const opfsDb = new OpfsGraphStore(normalizedChatId);
    await opfsDb.open();
    try {
      const emptyStatus = await opfsDb.isEmpty();
      if (emptyStatus?.empty) return null;
      const snapshot = await opfsDb.exportSnapshot({ includeTombstones: true });
      if (!isIndexedDbSnapshotMeaningful(snapshot)) return null;
      snapshot.meta = {
        ...snapshot.meta,
        migratedFromStoragePrimary: "opfs",
        migratedFromStorageMode: opfsDb.storeMode || "opfs-primary",
      };
      return snapshot;
    } finally {
      if (typeof opfsDb.close === "function") await opfsDb.close();
    }
  } catch (error) {
    console.warn("[ST-BME] 导出 OPFS 旧快照失败:", error);
    return null;
  }
}

function buildRecoveredSnapshotForChatIdentity(
  graph,
  targetChatId,
  {
    revision = 0,
    integrity = "",
    source = "identity-recovery",
    legacyChatId = "",
  } = {},
) {
  const normalizedTargetChatId = normalizeChatIdCandidate(targetChatId);
  const normalizedIntegrity = normalizeChatIdCandidate(integrity);
  const normalizedLegacyChatId = normalizeChatIdCandidate(legacyChatId);
  const effectiveRevision = Math.max(
    1,
    normalizeIndexedDbRevision(
      revision || graphPersistenceState.revision || getGraphPersistedRevision(graph),
    ),
  );

  return buildSnapshotFromGraph(graph, {
    chatId: normalizedTargetChatId,
    revision: effectiveRevision,
    lastModified: Date.now(),
    meta: {
      storagePrimary: "indexeddb",
      lastMutationReason: String(source || "identity-recovery"),
      integrity: normalizedIntegrity,
      migratedFromChatId: normalizedLegacyChatId,
      identityMigrationSource: String(source || "identity-recovery"),
    },
  });
}

async function importRecoveredSnapshotToIndexedDb(
  targetDb,
  targetChatId,
  graph,
  {
    revision = 0,
    integrity = "",
    source = "identity-recovery",
    legacyChatId = "",
    markSyncDirty = true,
    beforeImport = null,
  } = {},
) {
  const snapshot = buildRecoveredSnapshotForChatIdentity(graph, targetChatId, {
    revision,
    integrity,
    source,
    legacyChatId,
  });
  if (typeof beforeImport === "function") {
    await beforeImport(snapshot);
  }
  const importResult = await targetDb.importSnapshot(snapshot, {
    mode: "replace",
    preserveRevision: true,
    revision: snapshot.meta.revision,
    markSyncDirty,
  });
  snapshot.meta.revision = normalizeIndexedDbRevision(
    importResult?.revision,
    snapshot.meta.revision,
  );
  return snapshot;
}

function getIndexedDbSnapshotHistoryState(snapshot = null) {
  const snapshotState =
    snapshot?.meta?.runtimeHistoryState &&
    typeof snapshot.meta.runtimeHistoryState === "object" &&
    !Array.isArray(snapshot.meta.runtimeHistoryState)
      ? snapshot.meta.runtimeHistoryState
      : null;

  return {
    lastProcessedAssistantFloor: Number.isFinite(
      Number(snapshot?.state?.lastProcessedFloor),
    )
      ? Number(snapshot.state.lastProcessedFloor)
      : Number.isFinite(Number(snapshotState?.lastProcessedAssistantFloor))
        ? Number(snapshotState.lastProcessedAssistantFloor)
        : -1,
    extractionCount: Number.isFinite(Number(snapshot?.state?.extractionCount))
      ? Number(snapshot.state.extractionCount)
      : Number.isFinite(Number(snapshotState?.extractionCount))
        ? Number(snapshotState.extractionCount)
        : 0,
  };
}

function detectStaleIndexedDbSnapshotAgainstRuntime(
  chatId,
  snapshot,
  { identity = resolveCurrentChatIdentity(getContext()) } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot) || !currentGraph) {
    return {
      stale: false,
      reason: "",
    };
  }

  const runtimeChatId = normalizeChatIdCandidate(
    currentGraph?.historyState?.chatId ||
      getGraphPersistenceMeta(currentGraph)?.chatId ||
      graphPersistenceState.chatId,
  );
  if (
    !runtimeChatId ||
    !areChatIdsEquivalentForResolvedIdentity(
      normalizedChatId,
      runtimeChatId,
      identity,
    )
  ) {
    return {
      stale: false,
      reason: "",
    };
  }

  const runtimeRevision = Math.max(
    normalizeIndexedDbRevision(graphPersistenceState.revision),
    normalizeIndexedDbRevision(graphPersistenceState.lastPersistedRevision),
    normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
    getGraphPersistedRevision(currentGraph),
  );
  const snapshotRevision = normalizeIndexedDbRevision(snapshot?.meta?.revision);
  if (runtimeRevision > snapshotRevision) {
    return {
      stale: true,
      reason: "runtime-revision-newer",
      runtimeRevision,
      snapshotRevision,
    };
  }

  if (runtimeRevision < snapshotRevision) {
    return {
      stale: false,
      reason: "",
      runtimeRevision,
      snapshotRevision,
    };
  }

  const runtimeLastProcessedFloor = Number.isFinite(
    Number(currentGraph?.historyState?.lastProcessedAssistantFloor),
  )
    ? Number(currentGraph.historyState.lastProcessedAssistantFloor)
    : Number.isFinite(Number(currentGraph?.lastProcessedSeq))
      ? Number(currentGraph.lastProcessedSeq)
      : -1;
  const runtimeExtractionCount = Number.isFinite(
    Number(currentGraph?.historyState?.extractionCount),
  )
    ? Number(currentGraph.historyState.extractionCount)
    : Number.isFinite(Number(extractionCount))
      ? Number(extractionCount)
      : 0;
  const snapshotHistoryState = getIndexedDbSnapshotHistoryState(snapshot);

  if (runtimeLastProcessedFloor > snapshotHistoryState.lastProcessedAssistantFloor) {
    return {
      stale: true,
      reason: "runtime-last-processed-newer",
      runtimeRevision,
      snapshotRevision,
      runtimeLastProcessedFloor,
      snapshotLastProcessedFloor: snapshotHistoryState.lastProcessedAssistantFloor,
      runtimeExtractionCount,
      snapshotExtractionCount: snapshotHistoryState.extractionCount,
    };
  }

  if (runtimeExtractionCount > snapshotHistoryState.extractionCount) {
    return {
      stale: true,
      reason: "runtime-extraction-count-newer",
      runtimeRevision,
      snapshotRevision,
      runtimeLastProcessedFloor,
      snapshotLastProcessedFloor: snapshotHistoryState.lastProcessedAssistantFloor,
      runtimeExtractionCount,
      snapshotExtractionCount: snapshotHistoryState.extractionCount,
    };
  }

  return {
    stale: false,
    reason: "",
    runtimeRevision,
    snapshotRevision,
    runtimeLastProcessedFloor,
    snapshotLastProcessedFloor: snapshotHistoryState.lastProcessedAssistantFloor,
    runtimeExtractionCount,
    snapshotExtractionCount: snapshotHistoryState.extractionCount,
  };
}

function resolveCompatibleGraphShadowSnapshot(
  identity = resolveCurrentChatIdentity(getContext()),
) {
  if (!identity || typeof identity !== "object") {
    return null;
  }

  const directSnapshot = readGraphShadowSnapshot(identity.chatId);
  if (directSnapshot) {
    return directSnapshot;
  }

  const seenChatIds = new Set(
    [identity.chatId].map((value) => normalizeChatIdCandidate(value)).filter(Boolean),
  );
  const readByChatId = (value) => {
    const normalized = normalizeChatIdCandidate(value);
    if (!normalized || seenChatIds.has(normalized)) {
      return null;
    }
    seenChatIds.add(normalized);
    return readGraphShadowSnapshot(normalized);
  };

  const hostSnapshot = readByChatId(identity.hostChatId);
  if (hostSnapshot) {
    return hostSnapshot;
  }

  for (const aliasCandidate of getGraphIdentityAliasCandidates({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId: identity.chatId,
  })) {
    const aliasSnapshot = readByChatId(aliasCandidate);
    if (aliasSnapshot) {
      return aliasSnapshot;
    }
  }

  return findGraphShadowSnapshotByIntegrity(identity.integrity, {
    excludeChatIds: Array.from(seenChatIds),
  });
}

function createShadowComparisonGraph({
  chatId = "",
  revision = 0,
  integrity = "",
} = {}) {
  const graph = createEmptyGraph();
  stampGraphPersistenceMeta(graph, {
    revision: Math.max(0, normalizeIndexedDbRevision(revision)),
    chatId: String(chatId || ""),
    integrity: String(integrity || ""),
    reason: "shadow-compare-reference",
  });
  return graph;
}

function applyShadowSnapshotToRuntime(
  chatId,
  shadowSnapshot,
  {
    source = "shadow-restore",
    attemptIndex = 0,
    promoteToIndexedDb = true,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(
    chatId || shadowSnapshot?.chatId,
  );
  if (!normalizedChatId || !shadowSnapshot?.serializedGraph) {
    return {
      success: false,
      loaded: false,
      loadState: graphPersistenceState.loadState,
      reason: "shadow-invalid",
      chatId: normalizedChatId || "",
      attemptIndex,
    };
  }

  let shadowGraph = null;
  try {
    shadowGraph = normalizeGraphRuntimeState(
      deserializeGraph(shadowSnapshot.serializedGraph),
      normalizedChatId,
    );
  } catch (error) {
    console.warn("[ST-BME] shadow snapshot 恢复失败:", error);
    return {
      success: false,
      loaded: false,
      loadState: graphPersistenceState.loadState,
      reason: "shadow-deserialize-failed",
      detail: error?.message || String(error),
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const shadowRevision = Math.max(
    1,
    normalizeIndexedDbRevision(shadowSnapshot.revision),
  );
  stampGraphPersistenceMeta(shadowGraph, {
    revision: shadowRevision,
    reason: `shadow:${String(source || "shadow-restore")}`,
    chatId: normalizedChatId,
    integrity:
      String(shadowSnapshot.integrity || "").trim() ||
      getChatMetadataIntegrity(getContext()) ||
      graphPersistenceState.metadataIntegrity,
  });

  currentGraph = shadowGraph;
  extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount)
    ? currentGraph.historyState.extractionCount
    : 0;
  lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  runtimeStatus = createUiStatus(
    "图谱临时恢复",
    "已从本次会话临时快照恢复最近图谱，正在补写 IndexedDB",
    "warning",
  );
  lastExtractionStatus = createUiStatus(
    "待命",
    "已从会话快照恢复最近图谱，等待下一次提取",
    "idle",
  );
  lastVectorStatus = createUiStatus(
    "待命",
    currentGraph.vectorIndexState?.lastWarning ||
      "已从会话快照恢复最近图谱，等待下一次向量任务",
    "idle",
  );
  lastRecallStatus = createUiStatus(
    "待命",
    restoredRecallUi.restored
      ? "已从持久化召回记录恢复显示，并已恢复最近图谱"
      : "已从会话快照恢复最近图谱，等待下一次召回",
    "idle",
  );

  applyGraphLoadState(GRAPH_LOAD_STATES.SHADOW_RESTORED, {
    chatId: normalizedChatId,
    reason: `shadow:${String(source || "shadow-restore")}`,
    attemptIndex,
    revision: shadowRevision,
    lastPersistedRevision: Math.max(
      normalizeIndexedDbRevision(graphPersistenceState.lastPersistedRevision),
      shadowRevision,
    ),
    queuedPersistRevision: Math.max(
      normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
      shadowRevision,
    ),
    queuedPersistChatId: normalizedChatId,
    pendingPersist: Boolean(promoteToIndexedDb),
    shadowSnapshotUsed: true,
    shadowSnapshotRevision: shadowRevision,
    shadowSnapshotUpdatedAt: String(shadowSnapshot.updatedAt || ""),
    shadowSnapshotReason: String(
      shadowSnapshot.debugReason || shadowSnapshot.reason || source || "",
    ),
    dbReady: true,
    writesBlocked: false,
  });
  updateGraphPersistenceState({
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
    dbReady: true,
    indexedDbLastError: "",
    metadataIntegrity:
      getChatMetadataIntegrity(getContext()) ||
      graphPersistenceState.metadataIntegrity,
    dualWriteLastResult: {
      action: "load",
      source: `${String(source || "shadow-restore")}:shadow`,
      success: true,
      provisional: true,
      revision: shadowRevision,
      resultCode: "graph.load.shadow-restored",
      reason: `shadow:${String(source || "shadow-restore")}`,
      at: Date.now(),
    },
  });
  rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

  if (promoteToIndexedDb) {
    queueGraphPersistToIndexedDb(normalizedChatId, currentGraph, {
      revision: shadowRevision,
      reason: `shadow-restore-promote:${String(source || "shadow-restore")}`,
    });
  }

  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh(30);
  return {
    success: true,
    loaded: true,
    loadState: GRAPH_LOAD_STATES.SHADOW_RESTORED,
    reason: `shadow:${String(source || "shadow-restore")}`,
    chatId: normalizedChatId,
    attemptIndex,
    revision: shadowRevision,
    shadowRestored: true,
  };
}

async function refreshRuntimeGraphAfterSyncApplied(syncPayload = {}) {
  const action = String(syncPayload?.action || "")
    .trim()
    .toLowerCase();
  if (
    action !== "download" &&
    action !== "merge" &&
    action !== "restore-backup"
  ) {
    return {
      refreshed: false,
      reason: "action-not-supported",
      action,
    };
  }

  const syncedChatId = normalizeChatIdCandidate(syncPayload?.chatId);
  const activeIdentity = resolveCurrentChatIdentity(getContext());
  const activeChatId = normalizeChatIdCandidate(activeIdentity.chatId);
  const targetChatId =
    activeChatId &&
    syncedChatId &&
    doesChatIdMatchResolvedGraphIdentity(syncedChatId, activeIdentity)
      ? activeChatId
      : syncedChatId || activeChatId;

  if (!targetChatId) {
    return {
      refreshed: false,
      reason: "missing-chat-id",
      action,
    };
  }

  if (activeChatId && targetChatId !== activeChatId) {
    return {
      refreshed: false,
      reason: "chat-switched",
      action,
      chatId: targetChatId,
      activeChatId,
    };
  }

  const loadResult = await loadGraphFromIndexedDb(targetChatId, {
    source: `sync-post-refresh:${action}`,
    allowOverride: true,
    applyEmptyState: true,
  });

  return {
    refreshed: Boolean(loadResult?.loaded || loadResult?.emptyConfirmed),
    action,
    chatId: targetChatId,
    ...loadResult,
  };
}

function buildBmeSyncRuntimeOptions(extra = {}) {
  const normalizedExtra =
    extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
  const settings = getSettings();
  const authoritySettings = normalizeAuthoritySettings(settings);
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  const defaultOptions = {
    getDb: async (chatId) => {
      const manager = ensureBmeChatManager();
      if (!manager) {
        throw new Error("BmeChatManager 不可用");
      }
      return await manager.getCurrentDb(chatId);
    },
    getSafetyDb: async (chatId) => {
      const safetyChatId = buildRestoreSafetyChatId(chatId);
      const safetyStore = await resolvePreferredGraphLocalStorePresentation();
      const safetyDb = isAuthorityGraphStorePresentation(safetyStore)
        ? new BmeDatabase(safetyChatId)
        : await createPreferredGraphLocalStore(safetyChatId);
      await safetyDb.open();
      return safetyDb;
    },
    getCurrentChatId: () => getCurrentChatId(),
    getCloudStorageMode: () => getSettings().cloudStorageMode || "automatic",
    getRequestHeaders,
    authorityBlobEnabled: Boolean(
      authoritySettings.enabled &&
        authoritySettings.blobCheckpointEnabled &&
        capability.blobReady,
    ),
    authorityBlobFailOpen: authoritySettings.failOpen,
    authorityBlobConfig: {
      ...authoritySettings,
    },
    onAuthorityBlobEvent: recordAuthorityBlobSnapshot,
    onSyncApplied: async (payload = {}) => {
      await refreshRuntimeGraphAfterSyncApplied(payload);
    },
  };

  if (typeof normalizedExtra.onSyncApplied !== "function") {
    return {
      ...defaultOptions,
      ...normalizedExtra,
    };
  }

  return {
    ...defaultOptions,
    ...normalizedExtra,
    onSyncApplied: async (payload = {}) => {
      await defaultOptions.onSyncApplied(payload);
      await normalizedExtra.onSyncApplied(payload);
    },
  };
}

async function syncIndexedDbMetaToPersistenceState(
  chatId,
  { syncState = "idle", lastSyncError = "" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return null;
  }

  try {
    const manager = ensureBmeChatManager();
    if (!manager) {
      return null;
    }

    const db = await manager.getCurrentDb(normalizedChatId);
    if (!db) {
      return null;
    }

    const storePresentation = resolveDbGraphStorePresentation(db);
    const localStoreDiagnostics =
      typeof readLocalStoreDiagnosticsSync === "function"
        ? readLocalStoreDiagnosticsSync(db, storePresentation)
        : {
            resolvedLocalStore: `${storePresentation?.storagePrimary || "indexeddb"}:${storePresentation?.storageMode || "indexeddb"}`,
            localStoreFormatVersion:
              storePresentation.storagePrimary === "opfs" ? 2 : 1,
            localStoreMigrationState: "idle",
            opfsWalDepth: 0,
            opfsPendingBytes: 0,
            opfsCompactionState: null,
          };
    const persistenceEnvironment = buildPersistenceEnvironment(
      getContext(),
      storePresentation,
    );
    const [
      revision,
      syncDirty,
      syncDirtyReason,
      lastSyncUploadedAt,
      lastSyncDownloadedAt,
      lastSyncedRevision,
      lastBackupUploadedAt,
      lastBackupRestoredAt,
      lastBackupRollbackAt,
      lastBackupFilename,
      remoteSyncFormatVersion,
    ] = await Promise.all([
      typeof db.getRevision === "function" ? db.getRevision() : 0,
      typeof db.getMeta === "function" ? db.getMeta("syncDirty", false) : false,
      typeof db.getMeta === "function" ? db.getMeta("syncDirtyReason", "") : "",
      typeof db.getMeta === "function"
        ? db.getMeta("lastSyncUploadedAt", 0)
        : 0,
      typeof db.getMeta === "function"
        ? db.getMeta("lastSyncDownloadedAt", 0)
        : 0,
      typeof db.getMeta === "function" ? db.getMeta("lastSyncedRevision", 0) : 0,
      typeof db.getMeta === "function"
        ? db.getMeta("lastBackupUploadedAt", 0)
        : 0,
      typeof db.getMeta === "function"
        ? db.getMeta("lastBackupRestoredAt", 0)
        : 0,
      typeof db.getMeta === "function"
        ? db.getMeta("lastBackupRollbackAt", 0)
        : 0,
      typeof db.getMeta === "function" ? db.getMeta("lastBackupFilename", "") : "",
      typeof db.getMeta === "function" ? db.getMeta("remoteSyncFormatVersion", 1) : 1,
    ]);

    const patch = {
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
      storagePrimary: storePresentation.storagePrimary,
      storageMode: storePresentation.storageMode,
      resolvedLocalStore: localStoreDiagnostics.resolvedLocalStore,
      localStoreFormatVersion: localStoreDiagnostics.localStoreFormatVersion,
      localStoreMigrationState: localStoreDiagnostics.localStoreMigrationState,
      opfsWalDepth: localStoreDiagnostics.opfsWalDepth,
      opfsPendingBytes: localStoreDiagnostics.opfsPendingBytes,
      opfsCompactionState: localStoreDiagnostics.opfsCompactionState,
      indexedDbRevision: normalizeIndexedDbRevision(revision),
      syncState: normalizeGraphSyncState(syncState),
      syncDirty: Boolean(syncDirty),
      syncDirtyReason: String(syncDirtyReason || ""),
      lastSyncUploadedAt: Number(lastSyncUploadedAt) || 0,
      lastSyncDownloadedAt: Number(lastSyncDownloadedAt) || 0,
      lastSyncedRevision: Number(lastSyncedRevision) || 0,
      lastBackupUploadedAt: Number(lastBackupUploadedAt) || 0,
      lastBackupRestoredAt: Number(lastBackupRestoredAt) || 0,
      lastBackupRollbackAt: Number(lastBackupRollbackAt) || 0,
      lastBackupFilename: String(lastBackupFilename || ""),
      remoteSyncFormatVersion:
        Number(remoteSyncFormatVersion || 0) ||
        Number(graphPersistenceState.remoteSyncFormatVersion || 0) ||
        1,
      lastSyncError: String(lastSyncError || ""),
      opfsWriteLockState:
        typeof db.getWriteLockSnapshot === "function"
          ? cloneRuntimeDebugValue(db.getWriteLockSnapshot(), null)
          : graphPersistenceState.opfsWriteLockState,
    };

    updateGraphPersistenceState(patch);
    return patch;
  } catch (error) {
    console.warn("[ST-BME] 读取本地图库同步元数据失败:", error);
    updateGraphPersistenceState({
      syncState: "error",
      lastSyncError: error?.message || String(error),
    });
    return null;
  }
}

async function runBmeAutoSyncForChat(source = "unknown", chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      synced: false,
      chatId: "",
      reason: "missing-chat-id",
    };
  }

  if (isLukerPrimaryPersistenceHost(getContext())) {
    updateGraphPersistenceState({
      syncState: "idle",
      lastSyncError: "",
    });
    return {
      synced: false,
      skipped: true,
      chatId: normalizedChatId,
      reason: "luker-host-sync-disabled",
    };
  }

  updateGraphPersistenceState({
    syncState: "syncing",
    lastSyncError: "",
  });

  try {
    const syncResult = await autoSyncOnChatChange(
      normalizedChatId,
      buildBmeSyncRuntimeOptions({
        trigger: String(source || "chat-change"),
        reason: String(source || "chat-change"),
      }),
    );

    const syncState =
      syncResult?.synced ||
      syncResult?.reason === "manual-cloud-mode" ||
      syncResult?.reason === "missing-chat-id"
        ? "idle"
        : syncResult?.error
          ? "warning"
          : "idle";
    await syncIndexedDbMetaToPersistenceState(normalizedChatId, {
      syncState,
      lastSyncError: syncResult?.error || "",
    });

    return syncResult;
  } catch (error) {
    await syncIndexedDbMetaToPersistenceState(normalizedChatId, {
      syncState: "error",
      lastSyncError: error?.message || String(error),
    });
    throw error;
  }
}

function ensureBmeChatManager() {
  if (typeof BmeChatManager !== "function") {
    if (!bmeChatManagerUnavailableWarned) {
      console.warn("[ST-BME] BmeChatManager 不可用，IndexedDB 能力暂时停用");
      bmeChatManagerUnavailableWarned = true;
    }
    return null;
  }

  if (!bmeChatManager) {
    bmeChatManager = new BmeChatManager({
      databaseFactory: async (chatId) =>
        await createPreferredGraphLocalStore(chatId),
      selectorKeyResolver: async () =>
        buildGraphLocalStoreSelectorKey(
          await resolvePreferredGraphLocalStorePresentation(),
        ),
    });
  }
  return bmeChatManager;
}

function recordLocalPersistEarlyFailure(
  reason = "indexeddb-unavailable",
  {
    chatId = "",
    storagePrimary = graphPersistenceState.storagePrimary || "indexeddb",
    storageMode = graphPersistenceState.storageMode || "indexeddb",
    revision = 0,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const normalizedReason = String(reason || "indexeddb-unavailable").trim();
  updateGraphPersistenceState({
    storagePrimary,
    storageMode,
    indexedDbLastError: normalizedReason,
    dualWriteLastResult: {
      action: "save",
      target: storagePrimary,
      success: false,
      chatId: normalizedChatId,
      revision: normalizeIndexedDbRevision(revision),
      reason: normalizedReason,
      at: Date.now(),
    },
  });
  return normalizedReason;
}

function scheduleBmeIndexedDbTask(task) {
  const scheduler =
    typeof globalThis.queueMicrotask === "function"
      ? globalThis.queueMicrotask.bind(globalThis)
      : (callback) => setTimeout(callback, 0);

  scheduler(() => {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        console.warn("[ST-BME] IndexedDB 后台任务失败:", error);
      });
  });
}

async function syncBmeChatManagerWithCurrentChat(
  source = "unknown",
  context = getContext(),
) {
  const currentSettings = getSettings();
  const requestedMode = getRequestedGraphLocalStorageMode(currentSettings);
  if (
    requestedMode === "auto" ||
    isGraphLocalStorageModeOpfs(requestedMode)
  ) {
    await getGraphLocalStoreCapability(false, {
      settings: currentSettings,
      eagerRetry: true,
    });
  }

  const manager = ensureBmeChatManager();
  if (!manager) {
    return {
      chatId: "",
      opened: false,
      skipped: true,
      reason: "manager-unavailable",
    };
  }
  const chatId = getCurrentChatId(context);

  if (!chatId) {
    await manager.closeCurrent();
    debugDebug("[ST-BME] IndexedDB 会话已关闭（无活动聊天）", {
      source,
    });
    return {
      chatId: "",
      opened: false,
      skipped: false,
    };
  }

  const db = await manager.switchChat(chatId);
  debugDebug("[ST-BME] IndexedDB 会话已同步", {
    source,
    chatId,
  });
  return {
    chatId,
    opened: Boolean(db),
    skipped: false,
  };
}

function scheduleBmeIndexedDbWarmup(source = "init") {
  scheduleBmeIndexedDbTask(async () => {
    const preferredLocalStore = await resolvePreferredGraphLocalStorePresentation();
    if (preferredLocalStore.storagePrimary === "indexeddb") {
      await ensureDexieLoaded();
    }
    await syncBmeChatManagerWithCurrentChat(source);
  });
}

function normalizeIndexedDbRevision(value, fallbackValue = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Number(fallbackValue) || 0);
  }
  return Math.floor(parsed);
}

function isIndexedDbSnapshotMeaningful(snapshot = null) {
  if (!snapshot || typeof snapshot !== "object") return false;

  if (Array.isArray(snapshot.nodes) && snapshot.nodes.length > 0) return true;
  if (Array.isArray(snapshot.edges) && snapshot.edges.length > 0) return true;
  if (
    snapshot.__stBmeTombstonesOmitted === true &&
    Number(snapshot?.meta?.tombstoneCount || 0) > 0
  ) {
    return true;
  }
  if (Array.isArray(snapshot.tombstones) && snapshot.tombstones.length > 0)
    return true;

  const state = snapshot.state || {};
  if (
    Number.isFinite(Number(state.lastProcessedFloor)) &&
    Number(state.lastProcessedFloor) >= 0
  ) {
    return true;
  }
  if (
    Number.isFinite(Number(state.extractionCount)) &&
    Number(state.extractionCount) > 0
  ) {
    return true;
  }

  const runtimeHistoryState = snapshot.meta?.runtimeHistoryState;
  if (
    runtimeHistoryState &&
    typeof runtimeHistoryState === "object" &&
    !Array.isArray(runtimeHistoryState)
  ) {
    if (
      Number.isFinite(
        Number(runtimeHistoryState.lastProcessedAssistantFloor),
      ) &&
      Number(runtimeHistoryState.lastProcessedAssistantFloor) >= 0
    ) {
      return true;
    }
    if (
      runtimeHistoryState.processedMessageHashes &&
      typeof runtimeHistoryState.processedMessageHashes === "object" &&
      !Array.isArray(runtimeHistoryState.processedMessageHashes) &&
      Object.keys(runtimeHistoryState.processedMessageHashes).length > 0
    ) {
      return true;
    }
  }

  return false;
}

function cacheIndexedDbSnapshot(chatId, snapshot = null) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !snapshot || typeof snapshot !== "object") return;
  if (snapshot.__stBmeTombstonesOmitted === true) return;
  const snapshotStore = resolveSnapshotGraphStorePresentation(snapshot);
  if (snapshotStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND) return;
  bmeIndexedDbSnapshotCacheByChatId.set(normalizedChatId, {
    chatId: normalizedChatId,
    revision: normalizeIndexedDbRevision(snapshot?.meta?.revision),
    selectorKey: buildGraphLocalStoreSelectorKey(snapshotStore),
    snapshot,
    updatedAt: Date.now(),
  });
}

function readCachedIndexedDbSnapshot(chatId, expectedStore = null) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const cacheEntry = bmeIndexedDbSnapshotCacheByChatId.get(normalizedChatId);
  if (!cacheEntry?.snapshot) return null;
  if (expectedStore && typeof expectedStore === "object") {
    const expectedSelectorKey = buildGraphLocalStoreSelectorKey(expectedStore);
    if (cacheEntry.selectorKey && cacheEntry.selectorKey !== expectedSelectorKey) {
      return null;
    }
    if (
      !cacheEntry.selectorKey &&
      !isCachedIndexedDbSnapshotCompatible(cacheEntry.snapshot, expectedStore)
    ) {
      return null;
    }
  }
  return cacheEntry.snapshot;
}

function clearCachedIndexedDbSnapshot(chatId) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return false;
  return bmeIndexedDbSnapshotCacheByChatId.delete(normalizedChatId);
}

function clearAllCachedIndexedDbSnapshots() {
  const hadEntries = bmeIndexedDbSnapshotCacheByChatId.size > 0;
  bmeIndexedDbSnapshotCacheByChatId.clear();
  return hadEntries;
}

function cacheChatStateManifest(chatId, manifest = null) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || !manifest || typeof manifest !== "object") return;
  bmeChatStateManifestCacheByChatId.set(normalizedChatId, {
    chatId: normalizedChatId,
    manifest: cloneRuntimeDebugValue(manifest, manifest),
    revision: Number(
      manifest?.headRevision || manifest?.revision || manifest?.checkpointRevision || 0,
    ),
    updatedAt: Date.now(),
  });
  if (bmeChatStateManifestCacheByChatId.size <= 2) return;

  const entries = Array.from(bmeChatStateManifestCacheByChatId.entries()).sort(
    (left, right) =>
      Number(left?.[1]?.updatedAt || 0) - Number(right?.[1]?.updatedAt || 0),
  );
  while (entries.length > 2) {
    const [key] = entries.shift();
    bmeChatStateManifestCacheByChatId.delete(key);
  }
}

function readCachedChatStateManifest(chatId) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const cacheEntry = bmeChatStateManifestCacheByChatId.get(normalizedChatId);
  if (!cacheEntry?.manifest) return null;
  return cloneRuntimeDebugValue(cacheEntry.manifest, cacheEntry.manifest);
}

function clearCachedChatStateManifest(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return false;
  return bmeChatStateManifestCacheByChatId.delete(normalizedChatId);
}

function buildLukerJournalCompactionState(
  state = "idle",
  extra = {},
) {
  return {
    state: String(state || "idle"),
    queued: extra?.queued === true,
    lastAt: Number(extra?.lastAt || Date.now()),
    lastReason: String(extra?.lastReason || ""),
    error: String(extra?.error || ""),
  };
}

function applyPersistDeltaToSnapshot(snapshot = null, delta = null, options = {}) {
  const baseSnapshot =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? cloneRuntimeDebugValue(snapshot, snapshot)
      : {
          meta: {},
          state: {
            lastProcessedFloor: -1,
            extractionCount: 0,
          },
          nodes: [],
          edges: [],
          tombstones: [],
        };
  const normalizedDelta =
    delta && typeof delta === "object" && !Array.isArray(delta)
      ? cloneRuntimeDebugValue(delta, delta)
      : {};
  const nodeMap = new Map(
    (Array.isArray(baseSnapshot.nodes) ? baseSnapshot.nodes : [])
      .filter((record) => record?.id)
      .map((record) => [String(record.id), cloneRuntimeDebugValue(record, record)]),
  );
  const edgeMap = new Map(
    (Array.isArray(baseSnapshot.edges) ? baseSnapshot.edges : [])
      .filter((record) => record?.id)
      .map((record) => [String(record.id), cloneRuntimeDebugValue(record, record)]),
  );
  const tombstoneMap = new Map(
    (Array.isArray(baseSnapshot.tombstones) ? baseSnapshot.tombstones : [])
      .filter((record) => record?.id)
      .map((record) => [String(record.id), cloneRuntimeDebugValue(record, record)]),
  );

  for (const edgeId of Array.isArray(normalizedDelta.deleteEdgeIds) ? normalizedDelta.deleteEdgeIds : []) {
    edgeMap.delete(String(edgeId));
  }
  for (const nodeId of Array.isArray(normalizedDelta.deleteNodeIds) ? normalizedDelta.deleteNodeIds : []) {
    nodeMap.delete(String(nodeId));
  }
  for (const record of Array.isArray(normalizedDelta.upsertNodes) ? normalizedDelta.upsertNodes : []) {
    if (!record?.id) continue;
    nodeMap.set(String(record.id), cloneRuntimeDebugValue(record, record));
  }
  for (const record of Array.isArray(normalizedDelta.upsertEdges) ? normalizedDelta.upsertEdges : []) {
    if (!record?.id) continue;
    edgeMap.set(String(record.id), cloneRuntimeDebugValue(record, record));
  }
  for (const record of Array.isArray(normalizedDelta.tombstones) ? normalizedDelta.tombstones : []) {
    if (!record?.id) continue;
    tombstoneMap.set(String(record.id), cloneRuntimeDebugValue(record, record));
  }

  const runtimeMetaPatch =
    normalizedDelta.runtimeMetaPatch &&
    typeof normalizedDelta.runtimeMetaPatch === "object" &&
    !Array.isArray(normalizedDelta.runtimeMetaPatch)
      ? cloneRuntimeDebugValue(normalizedDelta.runtimeMetaPatch, {})
      : {};
  const requestedRevision = Number(options?.revision || 0);
  const lastModified = Number(options?.lastModified || Date.now());

  const nextSnapshot = {
    meta: {
      ...(baseSnapshot.meta && typeof baseSnapshot.meta === "object" ? baseSnapshot.meta : {}),
      ...runtimeMetaPatch,
      revision:
        Number.isFinite(requestedRevision) && requestedRevision > 0
          ? Math.floor(requestedRevision)
          : Number(baseSnapshot?.meta?.revision || 0),
      lastModified,
      lastMutationReason: String(options?.reason || runtimeMetaPatch.lastMutationReason || baseSnapshot?.meta?.lastMutationReason || ""),
    },
    state: {
      ...(baseSnapshot.state && typeof baseSnapshot.state === "object" ? baseSnapshot.state : {}),
      lastProcessedFloor: Number.isFinite(Number(runtimeMetaPatch.lastProcessedFloor))
        ? Number(runtimeMetaPatch.lastProcessedFloor)
        : Number(baseSnapshot?.state?.lastProcessedFloor ?? -1),
      extractionCount: Number.isFinite(Number(runtimeMetaPatch.extractionCount))
        ? Number(runtimeMetaPatch.extractionCount)
        : Number(baseSnapshot?.state?.extractionCount ?? 0),
    },
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
    tombstones: Array.from(tombstoneMap.values()),
  };

  nextSnapshot.meta.nodeCount = nextSnapshot.nodes.length;
  nextSnapshot.meta.edgeCount = nextSnapshot.edges.length;
  nextSnapshot.meta.tombstoneCount = nextSnapshot.tombstones.length;
  if (options?.chatId) {
    nextSnapshot.meta.chatId = String(options.chatId);
  }
  return nextSnapshot;
}

function shouldQueueLukerSidecarCompaction(manifest = null) {
  const normalizedManifest =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest
      : null;
  if (!normalizedManifest) return false;
  const journalDepth = Number(normalizedManifest.journalDepth || 0);
  const journalBytes = Number(normalizedManifest.journalBytes || 0);
  const revisionGap =
    Number(normalizedManifest.headRevision || 0) -
    Number(normalizedManifest.baseRevision || 0);
  return (
    journalDepth >= LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH ||
    journalBytes >= LUKER_GRAPH_JOURNAL_COMPACTION_BYTES ||
    revisionGap >= LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP
  );
}

function canUseHostGraphChatStatePersistence(context = getContext()) {
  return canUseGraphChatState(context);
}

function selectPreferredCommitMarker(...candidates) {
  let bestMarker = null;
  let bestRevision = 0;

  for (const candidate of candidates) {
    const revision = getAcceptedCommitMarkerRevision(candidate);
    if (revision > bestRevision) {
      bestRevision = revision;
      bestMarker = candidate;
    }
  }

  return bestMarker || null;
}

function buildLukerManifestStatePatch(
  manifest = null,
  {
    cacheMirrorState = graphPersistenceState.cacheMirrorState,
    cacheLag = null,
    persistMismatchReason = graphPersistenceState.persistMismatchReason,
    lastPersistReason = graphPersistenceState.lastPersistReason,
    lastPersistMode = graphPersistenceState.lastPersistMode,
    persistDiagnosticTier = graphPersistenceState.persistDiagnosticTier,
    dualWriteLastResult = graphPersistenceState.dualWriteLastResult,
    acceptedStorageTier = graphPersistenceState.acceptedStorageTier,
    acceptedBy = graphPersistenceState.acceptedBy,
  } = {},
) {
  const normalizedManifest =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest
      : null;
  const manifestRevision = Number(normalizedManifest?.headRevision || 0);
  const cacheRevision = Number(graphPersistenceState.indexedDbRevision || 0);
  return {
    hostProfile: "luker",
    primaryStorageTier: "luker-chat-state",
    chatStateTarget:
      cloneRuntimeDebugValue(graphPersistenceState.chatStateTarget, null) ||
      resolveCurrentChatStateTarget(getContext()),
    lightweightHostMode:
      graphPersistenceState.lightweightHostMode ??
      isBmeLightweightHostMode(getContext()),
    cacheStorageTier: buildPersistenceEnvironment(
      getContext(),
      getPreferredGraphLocalStorePresentationSync(),
    ).cacheStorageTier,
    cacheMirrorState,
    lastAcceptedRevision: Math.max(
      Number(graphPersistenceState.lastAcceptedRevision || 0),
      manifestRevision,
    ),
    acceptedStorageTier,
    acceptedBy,
    persistDiagnosticTier,
    persistMismatchReason: String(persistMismatchReason || ""),
    lastPersistReason: String(lastPersistReason || ""),
    lastPersistMode: String(lastPersistMode || ""),
    lukerSidecarFormatVersion:
      Number(normalizedManifest?.formatVersion || 0) || LUKER_GRAPH_SIDECAR_V2_FORMAT,
    lukerManifestRevision: manifestRevision,
    lukerJournalDepth: Number(normalizedManifest?.journalDepth || 0),
    lukerJournalBytes: Number(normalizedManifest?.journalBytes || 0),
    lukerCheckpointRevision: Number(normalizedManifest?.checkpointRevision || 0),
    cacheLag:
      cacheLag != null
        ? Math.max(0, Number(cacheLag || 0))
        : Math.max(0, manifestRevision - cacheRevision),
    dualWriteLastResult: cloneRuntimeDebugValue(dualWriteLastResult, null),
  };
}

async function readLocalCacheSnapshotForChat(chatId, source = "luker-sidecar-load") {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const localStore = getPreferredGraphLocalStorePresentationSync();
  const cached = readCachedIndexedDbSnapshot(normalizedChatId, localStore);
  if (cached) return cached;

  try {
    const manager = ensureBmeChatManager();
    if (!manager) return null;
    const db = await manager.getCurrentDb(normalizedChatId);
    const snapshot = await db.exportSnapshot({ includeTombstones: false });
    return snapshot;
  } catch (error) {
    console.warn("[ST-BME] 读取 Luker 本地缓存快照失败:", source, error);
    return null;
  }
}

function resolveLukerBaseRevision(manifest = null, checkpoint = null) {
  return Math.max(
    0,
    Number(manifest?.baseRevision || 0),
    Number(manifest?.checkpointRevision || 0),
    Number(checkpoint?.revision || 0),
  );
}

function resolveLukerHeadRevision(manifest = null, checkpoint = null) {
  return Math.max(
    resolveLukerBaseRevision(manifest, checkpoint),
    Number(manifest?.headRevision || 0),
  );
}

function queueLukerSidecarWrite(chatId, operation, { chatStateTarget = null } = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const normalizedTarget = normalizeBmeChatStateTarget(chatStateTarget);
  const queueKey =
    serializeBmeChatStateTarget(normalizedTarget) ||
    normalizedChatId;
  if (!queueKey || typeof operation !== "function") {
    return Promise.resolve().then(() => operation());
  }

  const previous = bmeLukerSidecarWriteByChatId.get(queueKey) || Promise.resolve();
  let settled = null;
  const queued = previous
    .catch(() => null)
    .then(() => operation());
  settled = queued.finally(() => {
    if (bmeLukerSidecarWriteByChatId.get(queueKey) === settled) {
      bmeLukerSidecarWriteByChatId.delete(queueKey);
    }
  });
  bmeLukerSidecarWriteByChatId.set(queueKey, settled);
  return settled;
}

function buildSnapshotFromLukerSidecarState(
  sidecar = null,
  {
    chatId = "",
    source = "luker-sidecar-snapshot",
    manifest = sidecar?.manifest || null,
  } = {},
) {
  const normalizedChatId =
    normalizeChatIdCandidate(chatId) ||
    normalizeChatIdCandidate(manifest?.chatId) ||
    normalizeChatIdCandidate(sidecar?.checkpoint?.chatId);
  const normalizedManifest =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest
      : null;
  if (!normalizedManifest) {
    return {
      ok: false,
      reason: "luker-chat-state-v2-empty",
      snapshot: null,
      manifest: null,
      baseRevision: 0,
      headRevision: 0,
    };
  }

  const baseRevision = resolveLukerBaseRevision(normalizedManifest, sidecar?.checkpoint);
  const checkpointRevision = Number(sidecar?.checkpoint?.revision || 0);
  let snapshot = null;
  if (sidecar?.checkpoint?.serializedGraph) {
    try {
      const checkpointGraph = normalizeGraphRuntimeState(
        deserializeGraph(sidecar.checkpoint.serializedGraph),
        normalizedChatId,
      );
      snapshot = buildSnapshotFromGraph(checkpointGraph, {
        chatId: normalizedChatId,
        revision: Math.max(checkpointRevision, baseRevision, 0),
        meta: {
          integrity:
            sidecar.checkpoint.integrity ||
            normalizedManifest.integrity ||
            graphPersistenceState.metadataIntegrity,
          storagePrimary: "chat-state",
          storageMode: "luker-chat-state",
          lastMutationReason: String(
            sidecar.checkpoint.reason || `${source}:luker-checkpoint`,
          ),
        },
      });
    } catch (error) {
      return {
        ok: false,
        reason: "luker-sidecar-checkpoint-invalid",
        error,
        snapshot: null,
        manifest: normalizedManifest,
        baseRevision,
        headRevision: Number(normalizedManifest.headRevision || 0),
      };
    }
  } else if (baseRevision > 0) {
    return {
      ok: false,
      reason: "luker-sidecar-checkpoint-missing",
      snapshot: null,
      manifest: normalizedManifest,
      baseRevision,
      headRevision: Number(normalizedManifest.headRevision || 0),
    };
  } else {
    const emptyGraph = normalizeGraphRuntimeState(
      createEmptyGraph(),
      normalizedChatId,
    );
    snapshot = buildSnapshotFromGraph(emptyGraph, {
      chatId: normalizedChatId,
      revision: 0,
      meta: {
        integrity: normalizedManifest.integrity || graphPersistenceState.metadataIntegrity,
        storagePrimary: "chat-state",
        storageMode: "luker-chat-state",
        lastMutationReason: `${source}:luker-empty-base`,
      },
    });
  }

  const journalEntries = Array.isArray(sidecar?.journal?.entries)
    ? sidecar.journal.entries
        .filter(
          (entry) =>
            Number(entry?.revision || 0) > baseRevision &&
            Number(entry?.revision || 0) <= Number(normalizedManifest.headRevision || 0),
        )
        .sort((left, right) => Number(left?.revision || 0) - Number(right?.revision || 0))
    : [];

  if (Number(normalizedManifest.headRevision || 0) > baseRevision) {
    let expectedRevision = baseRevision + 1;
    for (const entry of journalEntries) {
      if (Number(entry?.revision || 0) !== expectedRevision) {
        return {
          ok: false,
          reason: "luker-sidecar-journal-gap",
          snapshot: null,
          manifest: normalizedManifest,
          baseRevision,
          headRevision: Number(normalizedManifest.headRevision || 0),
          expectedRevision,
        };
      }
      snapshot = applyPersistDeltaToSnapshot(snapshot, entry.persistDelta, {
        revision: entry.revision,
        reason: entry.reason,
        chatId: normalizedChatId,
        lastModified: Date.now(),
      });
      expectedRevision += 1;
    }
    if (expectedRevision - 1 !== Number(normalizedManifest.headRevision || 0)) {
      return {
        ok: false,
        reason: "luker-sidecar-journal-incomplete",
        snapshot: null,
        manifest: normalizedManifest,
        baseRevision,
        headRevision: Number(normalizedManifest.headRevision || 0),
        expectedRevision,
      };
    }
  }

  snapshot.meta = {
    ...(snapshot.meta || {}),
    revision: Number(normalizedManifest.headRevision || snapshot?.meta?.revision || 0),
    chatId: normalizedChatId,
    integrity: normalizedManifest.integrity || snapshot?.meta?.integrity || "",
    storagePrimary: "chat-state",
    storageMode: "luker-chat-state",
    lastMutationReason: String(normalizedManifest.reason || source || "luker-chat-state"),
  };
  return {
    ok: true,
    reason: "luker-sidecar-snapshot-ready",
    snapshot,
    manifest: normalizedManifest,
    journalEntries,
    baseRevision,
    headRevision: Number(normalizedManifest.headRevision || 0),
  };
}

async function compactLukerGraphSidecarV2(
  context = getContext(),
  {
    graph = currentGraph,
    chatId = getCurrentChatId(context),
    revision = graphPersistenceState.lukerManifestRevision || graphPersistenceState.revision,
    reason = "luker-chat-state-compaction",
    integrity = "",
    chatStateTarget = null,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  if (
    !normalizedChatId ||
    !graph ||
    !canUseHostGraphChatStatePersistence(context)
  ) {
    return {
      ok: false,
      reason: "luker-sidecar-compaction-unavailable",
    };
  }

  return await queueLukerSidecarWrite(normalizedChatId, async () => {
    const normalizedIntegrity =
      normalizeChatIdCandidate(integrity) ||
      getChatMetadataIntegrity(context) ||
      graphPersistenceState.metadataIntegrity;
    const revisionFloor = Math.max(
      1,
      Number(revision || 0),
      Number(getGraphPersistedRevision(graph) || 0),
      Number(graphPersistenceState.lukerManifestRevision || 0),
      Number(graphPersistenceState.revision || 0),
    );
    const startedAt = Date.now();
    updateGraphPersistenceState({
      ...buildLukerManifestStatePatch(readCachedChatStateManifest(normalizedChatId), {
        cacheMirrorState: graphPersistenceState.cacheMirrorState,
        lastPersistReason: reason,
        lastPersistMode: "luker-chat-state-v2-compacting",
      }),
      opfsCompactionState: buildLukerJournalCompactionState("running", {
        lastAt: startedAt,
        lastReason: reason,
      }),
    });

    const checkpoint = buildLukerGraphCheckpointV2(graph, {
      revision: revisionFloor,
      chatId: normalizedChatId,
      integrity: normalizedIntegrity,
      reason,
      storageTier: "luker-chat-state",
      persistedAt: new Date(startedAt).toISOString(),
    });
    const checkpointResult = await writeLukerGraphCheckpointV2(context, checkpoint, {
      namespace: LUKER_GRAPH_CHECKPOINT_NAMESPACE,
      chatStateTarget: normalizedTarget,
    });
    if (!checkpointResult?.ok || !checkpointResult?.checkpoint) {
      updateGraphPersistenceState({
        opfsCompactionState: buildLukerJournalCompactionState("error", {
          lastAt: startedAt,
          lastReason: reason,
          error:
            checkpointResult?.error?.message ||
            checkpointResult?.reason ||
            "luker-sidecar-checkpoint-failed",
        }),
      });
      return {
        ok: false,
        reason: checkpointResult?.reason || "luker-sidecar-checkpoint-failed",
        error: checkpointResult?.error || null,
      };
    }
    await writeAuthorityLukerCheckpointBlob(checkpointResult.checkpoint, {
      chatId: normalizedChatId,
      reason,
    });

    const emptyJournal = buildLukerGraphJournalV2([], {
      chatId: normalizedChatId,
      integrity: normalizedIntegrity,
      headRevision: revisionFloor,
      updatedAt: checkpointResult.checkpoint.persistedAt,
    });
    const journalResult = await replaceLukerGraphJournalV2(context, emptyJournal, {
      namespace: LUKER_GRAPH_JOURNAL_NAMESPACE,
      chatStateTarget: normalizedTarget,
    });
    if (!journalResult?.ok || !journalResult?.journal) {
      updateGraphPersistenceState({
        opfsCompactionState: buildLukerJournalCompactionState("error", {
          lastAt: startedAt,
          lastReason: reason,
          error:
            journalResult?.error?.message ||
            journalResult?.reason ||
            "luker-sidecar-journal-reset-failed",
        }),
      });
      return {
        ok: false,
        reason: journalResult?.reason || "luker-sidecar-journal-reset-failed",
        error: journalResult?.error || null,
      };
    }

    const manifest = buildLukerGraphManifestV2(graph, {
      baseRevision: revisionFloor,
      headRevision: revisionFloor,
      checkpointRevision: revisionFloor,
      lastCompactedRevision: revisionFloor,
      journalDepth: 0,
      journalBytes: 0,
      chatId: normalizedChatId,
      integrity: normalizedIntegrity,
      reason,
      storageTier: "luker-chat-state",
      accepted: true,
      persistedAt: checkpointResult.checkpoint.persistedAt,
      lastProcessedAssistantFloor:
        graph?.historyState?.lastProcessedAssistantFloor ?? null,
      extractionCount: graph?.historyState?.extractionCount ?? null,
      compactionState: buildLukerJournalCompactionState("idle", {
        lastAt: startedAt,
        lastReason: reason,
      }),
    });
    const manifestResult = await writeLukerGraphManifestV2(context, manifest, {
      namespace: LUKER_GRAPH_MANIFEST_NAMESPACE,
      chatStateTarget: normalizedTarget,
    });
    if (!manifestResult?.ok || !manifestResult?.manifest) {
      updateGraphPersistenceState({
        opfsCompactionState: buildLukerJournalCompactionState("error", {
          lastAt: startedAt,
          lastReason: reason,
          error:
            manifestResult?.error?.message ||
            manifestResult?.reason ||
            "luker-sidecar-manifest-save-failed",
        }),
      });
      return {
        ok: false,
        reason: manifestResult?.reason || "luker-sidecar-manifest-save-failed",
        error: manifestResult?.error || null,
      };
    }

    cacheChatStateManifest(normalizedChatId, manifestResult.manifest);
    updateGraphPersistenceState({
      ...buildLukerManifestStatePatch(manifestResult.manifest, {
        cacheMirrorState: graphPersistenceState.cacheMirrorState,
        lastPersistReason: reason,
        lastPersistMode: "luker-chat-state-v2-compacted",
        acceptedStorageTier: "luker-chat-state",
        acceptedBy: "luker-chat-state",
        dualWriteLastResult: {
          action: "compact",
          target: "luker-chat-state",
          success: true,
          chatId: normalizedChatId,
          revision: revisionFloor,
          reason,
          at: Date.now(),
        },
      }),
      revision: revisionFloor,
      lastPersistedRevision: revisionFloor,
      lastAcceptedRevision: revisionFloor,
      opfsCompactionState: buildLukerJournalCompactionState("idle", {
        lastAt: startedAt,
        lastReason: reason,
      }),
    });
    return {
      ok: true,
      reason,
      manifest: manifestResult.manifest,
      checkpoint: checkpointResult.checkpoint,
    };
  }, {
    chatStateTarget: normalizedTarget,
  });
}

function scheduleLukerGraphSidecarCompaction(
  chatId,
  options = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const queueKey =
    serializeBmeChatStateTarget(options?.chatStateTarget) ||
    normalizedChatId;
  if (!normalizedChatId || bmeLukerSidecarCompactionByChatId.has(queueKey)) {
    return;
  }
  updateGraphPersistenceState({
    opfsCompactionState: buildLukerJournalCompactionState("queued", {
      queued: true,
      lastAt: Date.now(),
      lastReason: String(options?.reason || "luker-chat-state-compaction"),
    }),
  });
  const promise = Promise.resolve()
    .then(() => compactLukerGraphSidecarV2(getContext(), {
      ...options,
      chatId: normalizedChatId,
    }))
    .catch((error) => {
      console.warn("[ST-BME] Luker sidecar 压实失败:", error);
      updateGraphPersistenceState({
        opfsCompactionState: buildLukerJournalCompactionState("error", {
          lastAt: Date.now(),
          lastReason: String(options?.reason || "luker-chat-state-compaction"),
          error: error?.message || String(error),
        }),
      });
      return null;
    })
    .finally(() => {
      if (bmeLukerSidecarCompactionByChatId.get(queueKey) === promise) {
        bmeLukerSidecarCompactionByChatId.delete(queueKey);
      }
    });
  bmeLukerSidecarCompactionByChatId.set(queueKey, promise);
}

async function persistGraphToLukerSidecarV2(
  context = getContext(),
  {
    graph = currentGraph,
    chatId: explicitChatId = "",
    revision = graphPersistenceState.revision,
    reason = "luker-chat-state-save",
    accepted = true,
    lastProcessedAssistantFloor = null,
    extractionCount: nextExtractionCount = null,
    mode = "primary",
    persistDelta = null,
    chatStateTarget = null,
  } = {},
) {
  if (!context || !graph || !canUseHostGraphChatStatePersistence(context)) {
    return {
      saved: false,
      accepted: false,
      reason: "chat-state-unavailable",
      revision,
      storageTier: "luker-chat-state",
    };
  }

  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  const chatId = resolvePersistenceChatId(
    context,
    graph,
    explicitChatId ||
      resolveChatStateTargetChatId(normalizedTarget) ||
      "",
  );
  if (!chatId) {
    return {
      saved: false,
      accepted: false,
      reason: "missing-chat-id",
      revision,
      storageTier: "luker-chat-state",
    };
  }

  const resolvedIdentity = resolveCurrentChatIdentity(context);
  const currentTargetKey = serializeBmeChatStateTarget(
    resolveCurrentChatStateTarget(context),
  );
  const requestedTargetKey = serializeBmeChatStateTarget(normalizedTarget);
  const shouldRememberAlias =
    !requestedTargetKey || requestedTargetKey === currentTargetKey;
  const nextIntegrity =
    getGraphPersistenceMeta(graph)?.integrity ||
    getChatMetadataIntegrity(context) ||
    normalizeChatIdCandidate(resolvedIdentity?.integrity) ||
    graphPersistenceState.metadataIntegrity;

  return await queueLukerSidecarWrite(chatId, async () => {
    const directDelta =
      persistDelta &&
      typeof persistDelta === "object" &&
      !Array.isArray(persistDelta)
        ? cloneRuntimeDebugValue(persistDelta, persistDelta)
        : null;

    const existingSidecar = await readLukerGraphSidecarV2WithAuthorityBlob(context, {
      manifestNamespace: LUKER_GRAPH_MANIFEST_NAMESPACE,
      journalNamespace: LUKER_GRAPH_JOURNAL_NAMESPACE,
      checkpointNamespace: LUKER_GRAPH_CHECKPOINT_NAMESPACE,
      chatStateTarget: normalizedTarget,
      chatId,
    });
    if (existingSidecar?.manifest) {
      cacheChatStateManifest(chatId, existingSidecar.manifest);
    }

    const previousManifest =
      existingSidecar?.manifest || readCachedChatStateManifest(chatId);
    const previousHeadRevision = resolveLukerHeadRevision(
      previousManifest,
      existingSidecar?.checkpoint,
    );
    const shouldBootstrapCheckpoint =
      !existingSidecar?.manifest && !existingSidecar?.checkpoint;
    const effectiveRevision = shouldBootstrapCheckpoint
      ? Math.max(1, Number(revision || 0))
      : Math.max(1, previousHeadRevision + 1);

    let resolvedPersistDelta =
      directDelta && Number(revision || 0) === effectiveRevision
        ? directDelta
        : null;
    if (!shouldBootstrapCheckpoint && !resolvedPersistDelta) {
      const baseResult = buildSnapshotFromLukerSidecarState(existingSidecar, {
        chatId,
        source: `${reason}:luker-sidecar-base`,
      });
      if (!baseResult?.ok || !baseResult?.snapshot) {
        updateGraphPersistenceState({
          ...buildLukerManifestStatePatch(previousManifest, {
            persistMismatchReason:
              baseResult?.reason || "luker-sidecar-base-load-failed",
            lastPersistReason: String(reason || ""),
            lastPersistMode: "luker-chat-state-v2-base-rebuild-failed",
          }),
        });
        return {
          saved: false,
          accepted: false,
          reason: baseResult?.reason || "luker-sidecar-base-load-failed",
          revision: effectiveRevision,
          storageTier: "luker-chat-state",
          error: baseResult?.error || null,
        };
      }

      const nextSnapshot = buildSnapshotFromGraph(graph, {
        chatId,
        revision: effectiveRevision,
        baseSnapshot: baseResult.snapshot,
        lastModified: Date.now(),
        meta: {
          integrity: nextIntegrity,
          storagePrimary: "chat-state",
          storageMode: "luker-chat-state",
          lastMutationReason: reason,
          hostChatId: resolvedIdentity?.hostChatId || "",
        },
      });
      resolvedPersistDelta = buildPersistDelta(baseResult.snapshot, nextSnapshot, {
        useNativeDelta: false,
      });
    }

    if (shouldBootstrapCheckpoint) {
      const checkpoint = buildLukerGraphCheckpointV2(graph, {
        revision: effectiveRevision,
        chatId,
        integrity: nextIntegrity,
        reason: `${reason}:bootstrap`,
        storageTier: "luker-chat-state",
      });
      const checkpointResult = await writeLukerGraphCheckpointV2(context, checkpoint, {
        namespace: LUKER_GRAPH_CHECKPOINT_NAMESPACE,
        chatStateTarget: normalizedTarget,
      });
      if (!checkpointResult?.ok || !checkpointResult?.checkpoint) {
        return {
          saved: false,
          accepted: false,
          reason:
            checkpointResult?.reason || "luker-sidecar-bootstrap-checkpoint-failed",
          revision: effectiveRevision,
          storageTier: "luker-chat-state",
          error: checkpointResult?.error || null,
        };
      }
      await writeAuthorityLukerCheckpointBlob(checkpointResult.checkpoint, {
        chatId,
        reason: `${reason}:bootstrap`,
      });
      const emptyJournal = buildLukerGraphJournalV2([], {
        chatId,
        integrity: nextIntegrity,
        headRevision: effectiveRevision,
        updatedAt: checkpointResult.checkpoint.persistedAt,
      });
      const bootstrapJournalResult = await replaceLukerGraphJournalV2(
        context,
        emptyJournal,
        {
          namespace: LUKER_GRAPH_JOURNAL_NAMESPACE,
          chatStateTarget: normalizedTarget,
        },
      );
      if (!bootstrapJournalResult?.ok || !bootstrapJournalResult?.journal) {
        return {
          saved: false,
          accepted: false,
          reason:
            bootstrapJournalResult?.reason ||
            "luker-sidecar-bootstrap-journal-reset-failed",
          revision: effectiveRevision,
          storageTier: "luker-chat-state",
          error: bootstrapJournalResult?.error || null,
        };
      }
      const bootstrapManifest = buildLukerGraphManifestV2(graph, {
        baseRevision: Number(effectiveRevision || 0),
        headRevision: Number(effectiveRevision || 0),
        checkpointRevision: Number(effectiveRevision || 0),
        lastCompactedRevision: Number(effectiveRevision || 0),
        journalDepth: 0,
        journalBytes: 0,
        chatId,
        integrity: nextIntegrity,
        reason: `${reason}:bootstrap`,
        storageTier: "luker-chat-state",
        accepted,
        lastProcessedAssistantFloor,
        extractionCount: nextExtractionCount,
        compactionState: buildLukerJournalCompactionState("idle", {
          lastAt: Date.now(),
          lastReason: `${reason}:bootstrap`,
        }),
      });
      const manifestResult = await writeLukerGraphManifestV2(context, bootstrapManifest, {
        namespace: LUKER_GRAPH_MANIFEST_NAMESPACE,
        chatStateTarget: normalizedTarget,
      });
      if (!manifestResult?.ok || !manifestResult?.manifest) {
        return {
          saved: false,
          accepted: false,
          reason:
            manifestResult?.reason || "luker-sidecar-bootstrap-manifest-failed",
          revision: effectiveRevision,
          storageTier: "luker-chat-state",
          error: manifestResult?.error || null,
        };
      }
      cacheChatStateManifest(chatId, manifestResult.manifest);
      if (shouldRememberAlias) {
        rememberResolvedGraphIdentityAlias(context, chatId);
      }
      updateGraphPersistenceState({
        ...buildLukerManifestStatePatch(manifestResult.manifest, {
          cacheMirrorState:
            mode === "mirror" ? "saved" : graphPersistenceState.cacheMirrorState,
          lastPersistReason: String(reason || ""),
          lastPersistMode: "luker-chat-state-v2-bootstrap",
          acceptedStorageTier:
            accepted === true
              ? "luker-chat-state"
              : graphPersistenceState.acceptedStorageTier,
          acceptedBy:
            accepted === true ? "luker-chat-state" : graphPersistenceState.acceptedBy,
          dualWriteLastResult: {
            action: mode === "mirror" ? "cache-mirror" : "save",
            target: "luker-chat-state",
            success: true,
            chatId,
            revision: Number(effectiveRevision || 0),
            reason: `${reason}:bootstrap`,
            mode: String(mode || "primary"),
            at: Date.now(),
          },
        }),
        metadataIntegrity: String(
          nextIntegrity || graphPersistenceState.metadataIntegrity || "",
        ),
        revision: Number(effectiveRevision || 0),
        lastPersistedRevision: Number(effectiveRevision || 0),
        lastAcceptedRevision:
          accepted === true
            ? Number(effectiveRevision || 0)
            : Number(graphPersistenceState.lastAcceptedRevision || 0),
        pendingPersist: false,
        persistMismatchReason: "",
        persistDiagnosticTier: "none",
      });
      if (mode !== "mirror") {
        clearPendingGraphPersistRetry();
      }
      return {
        saved: true,
        accepted,
        chatId,
        revision: Number(effectiveRevision || 0),
        manifestRevision: Number(effectiveRevision || 0),
        journalDepth: 0,
        checkpointRevision: Number(effectiveRevision || 0),
        reason: String(reason || "luker-chat-state-save"),
        saveMode: "luker-chat-state-v2-bootstrap",
        storageTier: "luker-chat-state",
        manifest: manifestResult.manifest,
      };
    }

    const journalEntry = buildLukerGraphJournalEntry(resolvedPersistDelta, {
      revision: effectiveRevision,
      reason,
      storageTier: "luker-chat-state",
      chatId,
      integrity: nextIntegrity,
    });
    const journalResult = await appendLukerGraphJournalEntryV2(context, journalEntry, {
      namespace: LUKER_GRAPH_JOURNAL_NAMESPACE,
      chatId,
      integrity: nextIntegrity,
      chatStateTarget: normalizedTarget,
    });
    if (!journalResult?.ok || !journalResult?.journal || !journalResult?.entry) {
      updateGraphPersistenceState({
        dualWriteLastResult: {
          action: "save",
          target: "luker-chat-state",
          success: false,
          chatId,
          revision: Number(effectiveRevision || 0),
          reason: String(reason || "luker-chat-state-save"),
          mode: String(mode || "primary"),
          error:
            journalResult?.error?.message ||
            journalResult?.reason ||
            "luker-sidecar-journal-save-failed",
          at: Date.now(),
        },
      });
      return {
        saved: false,
        accepted: false,
        reason: journalResult?.reason || "luker-sidecar-journal-save-failed",
        revision: effectiveRevision,
        storageTier: "luker-chat-state",
        error: journalResult?.error || null,
      };
    }

    const checkpointRevision = Math.max(
      Number(existingSidecar?.checkpoint?.revision || 0),
      Number(previousManifest?.checkpointRevision || 0),
    );
    const manifest = buildLukerGraphManifestV2(graph, {
      baseRevision: resolveLukerBaseRevision(previousManifest, existingSidecar?.checkpoint),
      headRevision: Number(journalResult.entry.revision || effectiveRevision || 0),
      checkpointRevision,
      lastCompactedRevision: Math.max(
        Number(previousManifest?.lastCompactedRevision || 0),
        checkpointRevision,
      ),
      journalDepth: Number(journalResult.journal.entryCount || 0),
      journalBytes: Number(journalResult.journal.totalBytes || 0),
      chatId,
      integrity: nextIntegrity,
      reason,
      storageTier: "luker-chat-state",
      accepted,
      lastProcessedAssistantFloor,
      extractionCount: nextExtractionCount,
      compactionState:
        previousManifest?.compactionState ||
        buildLukerJournalCompactionState("idle", {
          lastAt: Date.now(),
          lastReason: reason,
        }),
    });
    const manifestResult = await writeLukerGraphManifestV2(context, manifest, {
      namespace: LUKER_GRAPH_MANIFEST_NAMESPACE,
      chatStateTarget: normalizedTarget,
    });
    if (!manifestResult?.ok || !manifestResult?.manifest) {
      updateGraphPersistenceState({
        ...buildLukerManifestStatePatch(previousManifest, {
          persistMismatchReason: "luker-manifest-pending-after-journal",
          lastPersistReason: reason,
          lastPersistMode: "luker-chat-state-v2-journal-only",
          dualWriteLastResult: {
            action: "save",
            target: "luker-chat-state",
            success: false,
            chatId,
            revision: Number(effectiveRevision || 0),
            reason: String(reason || "luker-chat-state-save"),
            mode: String(mode || "primary"),
            error:
              manifestResult?.error?.message ||
              manifestResult?.reason ||
              "luker-sidecar-manifest-save-failed",
            at: Date.now(),
          },
        }),
      });
      return {
        saved: false,
        accepted: false,
        reason: manifestResult?.reason || "luker-sidecar-manifest-save-failed",
        revision: effectiveRevision,
        storageTier: "luker-chat-state",
        error: manifestResult?.error || null,
      };
    }

    cacheChatStateManifest(chatId, manifestResult.manifest);
    if (shouldRememberAlias) {
      rememberResolvedGraphIdentityAlias(context, chatId);
    }
    updateGraphPersistenceState({
      ...buildLukerManifestStatePatch(manifestResult.manifest, {
        cacheMirrorState:
          mode === "mirror" ? "saved" : graphPersistenceState.cacheMirrorState,
        lastPersistReason: String(reason || ""),
        lastPersistMode:
          mode === "mirror"
            ? "luker-chat-state-v2-mirror"
            : "luker-chat-state-v2",
        acceptedStorageTier:
          accepted === true
            ? "luker-chat-state"
            : graphPersistenceState.acceptedStorageTier,
        acceptedBy:
          accepted === true ? "luker-chat-state" : graphPersistenceState.acceptedBy,
        dualWriteLastResult: {
          action: mode === "mirror" ? "cache-mirror" : "save",
          target: "luker-chat-state",
          success: true,
          chatId,
          revision: Number(
            manifestResult.manifest.headRevision || effectiveRevision || 0,
          ),
          reason: String(reason || "luker-chat-state-save"),
          mode: String(mode || "primary"),
          at: Date.now(),
        },
      }),
      metadataIntegrity: String(
        nextIntegrity || graphPersistenceState.metadataIntegrity || "",
      ),
      revision: Number(manifestResult.manifest.headRevision || effectiveRevision || 0),
      lastPersistedRevision: Number(
        manifestResult.manifest.headRevision || effectiveRevision || 0,
      ),
      lastAcceptedRevision:
        accepted === true
          ? Number(manifestResult.manifest.headRevision || effectiveRevision || 0)
          : Number(graphPersistenceState.lastAcceptedRevision || 0),
      pendingPersist: false,
      persistMismatchReason: "",
      persistDiagnosticTier: "none",
    });
    if (mode !== "mirror") {
      clearPendingGraphPersistRetry();
    }
    if (shouldQueueLukerSidecarCompaction(manifestResult.manifest)) {
      scheduleLukerGraphSidecarCompaction(chatId, {
        graph: cloneGraphForPersistence(graph, chatId),
        revision: manifestResult.manifest.headRevision,
        reason: `${reason}:auto-compact`,
        integrity: nextIntegrity,
        chatStateTarget: normalizedTarget,
      });
    }

    return {
      saved: true,
      accepted,
      chatId,
      revision: Number(manifestResult.manifest.headRevision || effectiveRevision || 0),
      manifestRevision: Number(
        manifestResult.manifest.headRevision || effectiveRevision || 0,
      ),
      journalDepth: Number(manifestResult.manifest.journalDepth || 0),
      checkpointRevision: Number(manifestResult.manifest.checkpointRevision || 0),
      reason: String(reason || "luker-chat-state-save"),
      saveMode:
        mode === "mirror"
          ? "luker-chat-state-v2-mirror"
          : "luker-chat-state-v2",
      storageTier: "luker-chat-state",
      manifest: manifestResult.manifest,
    };
  }, {
    chatStateTarget: normalizedTarget,
  });
}

async function loadGraphFromLukerSidecarV2(
  chatId,
  {
    source = "luker-chat-state-probe",
    attemptIndex = 0,
    allowOverride = false,
    consistencyRetryIndex = 0,
    consistencyRetryDelays = LUKER_SIDECAR_CONSISTENCY_RETRY_DELAYS_MS,
    chatStateTarget = null,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const context = getContext();
  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  if (!normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "luker-chat-state-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
  }

  const sidecar = await readLukerGraphSidecarV2WithAuthorityBlob(context, {
    manifestNamespace: LUKER_GRAPH_MANIFEST_NAMESPACE,
    journalNamespace: LUKER_GRAPH_JOURNAL_NAMESPACE,
    checkpointNamespace: LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    chatStateTarget: normalizedTarget,
    chatId: normalizedChatId,
  });
  const manifest = sidecar?.manifest || null;
  if (!manifest) {
    return {
      success: false,
      loaded: false,
      reason: "luker-chat-state-v2-empty",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }
  cacheChatStateManifest(normalizedChatId, manifest);

  const localSnapshot = await readLocalCacheSnapshotForChat(
    normalizedChatId,
    `${source}:luker-local-cache-read`,
  );
  const localSnapshotRevision = Number(localSnapshot?.meta?.revision || 0);
  const localSnapshotIntegrity = normalizeChatIdCandidate(localSnapshot?.meta?.integrity);
  if (
    localSnapshot &&
    localSnapshotRevision >= Number(manifest.headRevision || 0) &&
    (!manifest.integrity ||
      !localSnapshotIntegrity ||
      localSnapshotIntegrity === manifest.integrity)
  ) {
    const cachedResult = applyIndexedDbSnapshotToRuntime(normalizedChatId, localSnapshot, {
      source: `${source}:luker-local-cache-hit`,
      attemptIndex,
      storagePrimary: "chat-state",
      storageMode: "luker-chat-state",
      statusLabel: "Luker 本地缓存",
      reasonPrefix: "luker-chat-state",
    });
    if (cachedResult?.loaded) {
      updateGraphPersistenceState({
        ...buildLukerManifestStatePatch(manifest, {
          cacheMirrorState: "saved",
          acceptedStorageTier: "luker-chat-state",
          acceptedBy: "luker-chat-state",
        }),
        metadataIntegrity: String(
          manifest.integrity || graphPersistenceState.metadataIntegrity || "",
        ),
        reason: `${source}:luker-local-cache-hit`,
      });
    }
    return cachedResult;
  }

  const baseResult = buildSnapshotFromLukerSidecarState(sidecar, {
    chatId: normalizedChatId,
    source,
    manifest,
  });
  const nextConsistencyRetryDelay =
    consistencyRetryIndex < consistencyRetryDelays.length
      ? Number(
          consistencyRetryDelays[consistencyRetryIndex] || 0,
        )
      : null;
  if (!baseResult?.ok || !baseResult?.snapshot) {
    if (
      (baseResult?.reason === "luker-sidecar-journal-gap" ||
        baseResult?.reason === "luker-sidecar-journal-incomplete") &&
      Number.isFinite(nextConsistencyRetryDelay) &&
      nextConsistencyRetryDelay >= 0
    ) {
      if (nextConsistencyRetryDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, nextConsistencyRetryDelay));
      } else {
        await Promise.resolve();
      }
      return await loadGraphFromLukerSidecarV2(normalizedChatId, {
        source,
        attemptIndex,
        allowOverride,
        consistencyRetryIndex: consistencyRetryIndex + 1,
        consistencyRetryDelays,
        chatStateTarget: normalizedTarget,
      });
    }
    const blockedReason = String(
      baseResult?.reason || "luker-sidecar-load-invalid",
    );
    if (baseResult?.error) {
      console.warn(`[ST-BME] Luker sidecar 加载失败: ${blockedReason}`, baseResult.error);
    }
    applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
      chatId: normalizedChatId,
      reason: blockedReason,
      attemptIndex,
      dbReady: false,
      writesBlocked: true,
      hostProfile: "luker",
      primaryStorageTier: "luker-chat-state",
      cacheStorageTier: buildPersistenceEnvironment(
        context,
        getPreferredGraphLocalStorePresentationSync(),
      ).cacheStorageTier,
    });
    updateGraphPersistenceState({
      ...buildLukerManifestStatePatch(manifest, {
        persistMismatchReason: blockedReason,
      }),
    });
    return {
      success: false,
      loaded: false,
      reason: blockedReason,
      chatId: normalizedChatId,
      attemptIndex,
      error: baseResult?.error || null,
    };
  }

  const snapshot = baseResult.snapshot;
  const shouldAllowOverride =
    allowOverride ||
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(graphPersistenceState.loadState) ||
    graphPersistenceState.storagePrimary === "chat-state" ||
    Number(manifest.headRevision || 0) >=
      normalizeIndexedDbRevision(graphPersistenceState.revision);
  if (!shouldAllowOverride) {
    return {
      success: false,
      loaded: false,
      reason: "luker-chat-state-stale",
      chatId: normalizedChatId,
      attemptIndex,
      revision: Number(manifest.headRevision || 0),
    };
  }
  if (getCurrentChatId() !== normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "luker-chat-state-chat-switched",
      chatId: normalizedChatId,
      attemptIndex,
      revision: Number(manifest.headRevision || 0),
    };
  }

  const loadResult = applyIndexedDbSnapshotToRuntime(normalizedChatId, snapshot, {
    source,
    attemptIndex,
    storagePrimary: "chat-state",
    storageMode: "luker-chat-state",
    statusLabel: "Luker 侧车",
    reasonPrefix: "luker-chat-state",
  });
  if (loadResult?.loaded) {
    updateGraphPersistenceState({
      ...buildLukerManifestStatePatch(manifest, {
        cacheMirrorState:
          localSnapshotRevision > 0 &&
          localSnapshotRevision >= Number(manifest.headRevision || 0)
            ? "saved"
            : graphPersistenceState.cacheMirrorState,
        acceptedStorageTier: "luker-chat-state",
        acceptedBy: "luker-chat-state",
      }),
      chatStateTarget: cloneRuntimeDebugValue(normalizedTarget, null),
      metadataIntegrity: String(
        manifest.integrity || graphPersistenceState.metadataIntegrity || "",
      ),
      reason: `${source}:luker-chat-state`,
      revision: Math.max(
        Number(graphPersistenceState.revision || 0),
        Number(manifest.headRevision || 0),
      ),
    });
  }
  return loadResult;
}

async function persistGraphToHostChatState(
  context = getContext(),
  {
    graph = currentGraph,
    chatId: explicitChatId = "",
    revision = graphPersistenceState.revision,
    reason = "graph-chat-state",
    storageTier = "chat-state",
    accepted = true,
    lastProcessedAssistantFloor = null,
    extractionCount: nextExtractionCount = null,
    mode = "primary",
    persistDelta = null,
    chatStateTarget = null,
    graphDetached = false,
  } = {},
) {
  if (!context || !graph || !canUseHostGraphChatStatePersistence(context)) {
    return {
      saved: false,
      accepted: false,
      reason: "chat-state-unavailable",
      revision,
      storageTier,
    };
  }

  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  const chatId = resolvePersistenceChatId(
    context,
    graph,
    explicitChatId ||
      resolveChatStateTargetChatId(normalizedTarget) ||
      "",
  );
  if (!chatId) {
    return {
      saved: false,
      accepted: false,
      reason: "missing-chat-id",
      revision,
      storageTier,
    };
  }

  const resolvedIdentity = resolveCurrentChatIdentity(context);
  const persistenceEnvironment = buildPersistenceEnvironment(
    context,
    getPreferredGraphLocalStorePresentationSync(),
  );
  if (persistenceEnvironment.hostProfile === "luker") {
    return await persistGraphToLukerSidecarV2(context, {
      graph,
      chatId,
      revision,
      reason,
      accepted,
      lastProcessedAssistantFloor,
      extractionCount: nextExtractionCount,
      mode,
      persistDelta,
      chatStateTarget: normalizedTarget,
    });
  }
  const effectiveStorageTier =
    storageTier === "chat-state" && persistenceEnvironment.hostProfile === "luker"
      ? "luker-chat-state"
      : storageTier;
  const nextIntegrity =
    getChatMetadataIntegrity(context) ||
    normalizeChatIdCandidate(resolvedIdentity?.integrity) ||
    graphPersistenceState.metadataIntegrity;
  const persistedGraph =
    graphDetached === true
      ? normalizeGraphRuntimeState(graph, chatId)
      : cloneGraphForPersistence(graph, chatId);
  stampGraphPersistenceMeta(persistedGraph, {
    revision,
    reason: `chat-state:${String(reason || "graph-chat-state")}`,
    chatId,
    integrity: nextIntegrity,
  });

  const writeResult = await writeGraphChatStateSnapshot(
    context,
    persistedGraph,
    {
      namespace: GRAPH_CHAT_STATE_NAMESPACE,
      revision,
      storageTier: effectiveStorageTier,
      accepted,
      reason,
      chatId,
      integrity: nextIntegrity,
      lastProcessedAssistantFloor,
      extractionCount: nextExtractionCount,
      target: normalizedTarget,
    },
  );

  if (!writeResult?.ok || !writeResult?.snapshot) {
    updateGraphPersistenceState({
      dualWriteLastResult: {
        action: "save",
        target: "chat-state",
        success: false,
        chatId,
        revision: Number(revision || 0),
        reason: String(reason || "graph-chat-state"),
        mode: String(mode || "primary"),
        error: writeResult?.error?.message || writeResult?.reason || "chat-state-save-failed",
        at: Date.now(),
      },
    });
    return {
      saved: false,
      accepted: false,
      reason: writeResult?.reason || "chat-state-save-failed",
      revision,
      storageTier: effectiveStorageTier,
      error: writeResult?.error || null,
    };
  }

  rememberResolvedGraphIdentityAlias(context, chatId);
  updateGraphPersistenceState({
    hostProfile: persistenceEnvironment.hostProfile,
    primaryStorageTier: persistenceEnvironment.primaryStorageTier,
    cacheStorageTier: persistenceEnvironment.cacheStorageTier,
    cacheMirrorState:
      mode === "mirror" && persistenceEnvironment.hostProfile === "luker"
        ? writeResult?.updated === false
          ? "saved"
          : "saved"
        : graphPersistenceState.cacheMirrorState,
    metadataIntegrity: String(nextIntegrity || graphPersistenceState.metadataIntegrity || ""),
    lastPersistReason: String(reason || ""),
    lastPersistMode:
      mode === "mirror" ? "chat-state-mirror" : "chat-state",
    lastAcceptedRevision:
      accepted === true
        ? Math.max(
            Number(graphPersistenceState.lastAcceptedRevision || 0),
            Number(writeResult.snapshot.revision || revision || 0),
          )
        : Number(graphPersistenceState.lastAcceptedRevision || 0),
    acceptedStorageTier:
      accepted === true
        ? normalizePersistenceStorageTier(effectiveStorageTier)
        : graphPersistenceState.acceptedStorageTier,
    acceptedBy:
      accepted === true
        ? normalizePersistenceStorageTier(effectiveStorageTier)
        : graphPersistenceState.acceptedBy,
    dualWriteLastResult: {
      action: mode === "mirror" ? "cache-mirror" : "save",
      target: "chat-state",
      success: true,
      chatId,
      revision: Number(writeResult.snapshot.revision || revision || 0),
      reason: String(reason || "graph-chat-state"),
      mode: String(mode || "primary"),
      at: Date.now(),
    },
  });
  if (mode !== "mirror") {
    clearPendingGraphPersistRetry();
  }

  return {
    saved: true,
    accepted,
    chatId,
    revision: Number(writeResult.snapshot.revision || revision || 0),
    reason: String(reason || "graph-chat-state"),
    saveMode: mode === "mirror" ? "chat-state-mirror" : "chat-state",
    storageTier: effectiveStorageTier,
    snapshot: writeResult.snapshot,
  };
}

async function loadGraphFromChatState(
  chatId,
  {
    source = "chat-state-probe",
    attemptIndex = 0,
    allowOverride = false,
    chatStateTarget = null,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const context = getContext();
  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  const shouldFallbackToLocalStore = isLukerPrimaryPersistenceHost(context);
  if (!normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
  }
  if (!canUseHostGraphChatStatePersistence(context)) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-unavailable",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  if (shouldFallbackToLocalStore) {
    const lukerResult = await loadGraphFromLukerSidecarV2(normalizedChatId, {
      source,
      attemptIndex,
      allowOverride,
      chatStateTarget: normalizedTarget,
    });
    if (lukerResult?.loaded || lukerResult?.reason !== "luker-chat-state-v2-empty") {
      return lukerResult;
    }
  }

  const payload =
    (await readGraphChatStateSnapshot(context, {
      namespace: GRAPH_CHAT_STATE_NAMESPACE,
      target: normalizedTarget,
    })) || null;
  if (!payload?.serializedGraph) {
    if (shouldFallbackToLocalStore) {
      scheduleIndexedDbGraphProbe(normalizedChatId, {
        source: `${source}:luker-local-cache-fallback`,
        attemptIndex,
        allowOverride: true,
        applyEmptyState: true,
      });
    }
    return {
      success: false,
      loaded: false,
      reason: "chat-state-empty",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  let chatStateGraph = null;
  try {
    chatStateGraph = normalizeGraphRuntimeState(
      deserializeGraph(payload.serializedGraph),
      normalizedChatId,
    );
  } catch (error) {
    console.warn("[ST-BME] 聊天侧车图谱反序列化失败:", error);
    if (shouldFallbackToLocalStore) {
      scheduleIndexedDbGraphProbe(normalizedChatId, {
        source: `${source}:luker-local-cache-fallback`,
        attemptIndex,
        allowOverride: true,
        applyEmptyState: true,
      });
    }
    return {
      success: false,
      loaded: false,
      reason: "chat-state-deserialize-failed",
      chatId: normalizedChatId,
      attemptIndex,
      error,
    };
  }

  if (isGraphEffectivelyEmpty(chatStateGraph)) {
    if (shouldFallbackToLocalStore) {
      scheduleIndexedDbGraphProbe(normalizedChatId, {
        source: `${source}:luker-local-cache-fallback`,
        attemptIndex,
        allowOverride: true,
        applyEmptyState: true,
      });
    }
    return {
      success: false,
      loaded: false,
      reason: "chat-state-empty",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  const revision = Math.max(
    1,
    Number(payload.revision || getGraphPersistedRevision(chatStateGraph) || 1),
  );
  const integrity =
    normalizeChatIdCandidate(payload.integrity) ||
    getChatMetadataIntegrity(context) ||
    graphPersistenceState.metadataIntegrity;
  stampGraphPersistenceMeta(chatStateGraph, {
    revision,
    reason: `chat-state:${String(source || "chat-state-probe")}`,
    chatId: normalizedChatId,
    integrity,
  });

  const snapshot = buildSnapshotFromGraph(chatStateGraph, {
    chatId: normalizedChatId,
    revision,
    meta: {
      storagePrimary: "chat-state",
      lastMutationReason: String(payload.reason || source || "chat-state"),
      integrity,
    },
  });
  const shadowSnapshot = resolveCompatibleGraphShadowSnapshot(
    resolveCurrentChatIdentity(context),
  );
  const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
    chatStateGraph,
    shadowSnapshot,
  );
  if (shadowSnapshot && shadowDecision?.prefer) {
    return applyShadowSnapshotToRuntime(normalizedChatId, shadowSnapshot, {
      source: `${source}:shadow-over-chat-state`,
      attemptIndex,
    });
  }

  const effectiveCommitMarker = selectPreferredCommitMarker(
    payload.commitMarker,
    getChatCommitMarker(context),
  );
  const commitMarkerMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
    snapshot,
    effectiveCommitMarker,
  );
  let commitMarkerDiagnostic = null;
  if (commitMarkerMismatch.mismatched) {
    commitMarkerDiagnostic = recordPersistMismatchDiagnostic(
      {
        ...commitMarkerMismatch,
        marker: commitMarkerMismatch.marker || effectiveCommitMarker,
      },
      {
        source: `${source}:chat-state-marker`,
      },
    );
    if (
      shadowSnapshot &&
      Number(shadowSnapshot.revision || 0) >=
        Number(commitMarkerMismatch.markerRevision || 0)
    ) {
      const shadowResult = applyShadowSnapshotToRuntime(normalizedChatId, shadowSnapshot, {
        source: `${source}:shadow-beats-chat-state-marker`,
        attemptIndex,
      });
      if (shadowResult?.loaded && commitMarkerDiagnostic?.reason) {
        updateGraphPersistenceState({
          persistMismatchReason: commitMarkerDiagnostic.reason,
        });
      }
      return shadowResult;
    }
  }

  const shouldAllowOverride =
    allowOverride ||
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(graphPersistenceState.loadState) ||
    graphPersistenceState.storagePrimary === "chat-state" ||
    revision >= normalizeIndexedDbRevision(graphPersistenceState.revision);
  if (!shouldAllowOverride) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-stale",
      chatId: normalizedChatId,
      attemptIndex,
      revision,
    };
  }

  if (getCurrentChatId() !== normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "chat-state-chat-switched",
      chatId: normalizedChatId,
      attemptIndex,
      revision,
    };
  }

  const loadResult = applyIndexedDbSnapshotToRuntime(normalizedChatId, snapshot, {
    source,
    attemptIndex,
    storagePrimary: "chat-state",
    storageMode:
      shouldFallbackToLocalStore === true ? "luker-chat-state" : "chat-state",
    statusLabel:
      shouldFallbackToLocalStore === true ? "Luker 侧车" : "聊天侧车",
    reasonPrefix:
      shouldFallbackToLocalStore === true ? "luker-chat-state" : "chat-state",
  });
  if (commitMarkerDiagnostic?.reason && loadResult?.loaded) {
    updateGraphPersistenceState({
      persistMismatchReason: commitMarkerDiagnostic.reason,
    });
  }
  return loadResult;
}

function getNodeBranchCutoffSeq(node = null) {
  if (!node || typeof node !== "object") return -1;
  if (Array.isArray(node.seqRange) && Number.isFinite(Number(node.seqRange[1]))) {
    return Number(node.seqRange[1]);
  }
  return Number.isFinite(Number(node.seq)) ? Number(node.seq) : -1;
}

function deriveBranchGraphFromSourceGraph(
  sourceGraph = null,
  {
    targetChatId = "",
    cutoffFloor = null,
    assistantMessageCount = null,
  } = {},
) {
  if (!sourceGraph) return null;
  const nextChatId =
    normalizeChatIdCandidate(targetChatId) ||
    normalizeChatIdCandidate(sourceGraph?.historyState?.chatId);
  const branchGraph = cloneGraphForPersistence(sourceGraph, nextChatId);

  const safeCutoff =
    Number.isFinite(Number(cutoffFloor)) && Number(cutoffFloor) >= 0
      ? Math.floor(Number(cutoffFloor))
      : null;
  if (safeCutoff != null) {
    const allowedNodeIds = new Set(
      (Array.isArray(branchGraph.nodes) ? branchGraph.nodes : [])
        .filter((node) => {
          const nodeCutoffSeq = getNodeBranchCutoffSeq(node);
          return nodeCutoffSeq < 0 || nodeCutoffSeq <= safeCutoff;
        })
        .map((node) => String(node.id || "")),
    );

    branchGraph.nodes = (Array.isArray(branchGraph.nodes) ? branchGraph.nodes : []).filter(
      (node) => allowedNodeIds.has(String(node.id || "")),
    );
    branchGraph.edges = (Array.isArray(branchGraph.edges) ? branchGraph.edges : []).filter(
      (edge) =>
        allowedNodeIds.has(String(edge?.fromId || "")) &&
        allowedNodeIds.has(String(edge?.toId || "")),
    );
    branchGraph.batchJournal = (Array.isArray(branchGraph.batchJournal)
      ? branchGraph.batchJournal
      : []
    ).filter((journal) => {
      const rangeEnd = Number(journal?.processedRange?.[1]);
      return !Number.isFinite(rangeEnd) || rangeEnd <= safeCutoff;
    });

    const summaryEntries = Array.isArray(branchGraph.summaryState?.entries)
      ? branchGraph.summaryState.entries
      : [];
    branchGraph.summaryState.entries = summaryEntries.filter((entry) => {
      const messageRangeEnd = Number(entry?.messageRange?.[1]);
      return !Number.isFinite(messageRangeEnd) || messageRangeEnd <= safeCutoff;
    });
    branchGraph.summaryState.activeEntryIds = (branchGraph.summaryState.activeEntryIds || [])
      .filter((entryId) =>
        branchGraph.summaryState.entries.some((entry) => entry.id === entryId),
      );
    branchGraph.summaryState.lastSummarizedAssistantFloor = Math.max(
      -1,
      ...branchGraph.summaryState.entries.map((entry) =>
        Number.isFinite(Number(entry?.messageRange?.[1]))
          ? Number(entry.messageRange[1])
          : -1,
      ),
    );

    pruneProcessedMessageHashesFromFloor(branchGraph, safeCutoff + 1);
    branchGraph.historyState.lastProcessedAssistantFloor = Math.min(
      Number(branchGraph.historyState.lastProcessedAssistantFloor ?? safeCutoff),
      safeCutoff,
    );
    if (
      Array.isArray(branchGraph.historyState?.lastBatchStatus?.processedRange) &&
      Number(branchGraph.historyState.lastBatchStatus.processedRange[1]) > safeCutoff
    ) {
      branchGraph.historyState.lastBatchStatus = null;
    }
  }

  const extractionCountCeiling =
    Number.isFinite(Number(assistantMessageCount)) && Number(assistantMessageCount) >= 0
      ? Math.floor(Number(assistantMessageCount))
      : Number.isFinite(Number(branchGraph.historyState.extractionCount))
        ? Number(branchGraph.historyState.extractionCount)
        : 0;
  branchGraph.historyState.chatId = nextChatId;
  branchGraph.historyState.extractionCount = Math.max(
    0,
    Math.min(
      Number(branchGraph.historyState.extractionCount || 0),
      extractionCountCeiling,
    ),
  );
  branchGraph.historyState.lastRecoveryResult = null;
  branchGraph.historyState.lastBatchStatus = null;
  branchGraph.historyState.historyDirtyFrom = null;
  branchGraph.historyState.lastMutationSource = "chat-branch-created";
  branchGraph.historyState.lastMutationReason = "chat-branch-created";
  branchGraph.lastRecallResult = null;
  return normalizeGraphRuntimeState(branchGraph, nextChatId);
}

async function readPersistedGraphForChatStateTarget(
  context = getContext(),
  chatStateTarget = null,
) {
  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  const targetChatId = resolveChatStateTargetChatId(normalizedTarget);
  if (!normalizedTarget || !targetChatId) {
    return null;
  }

  const sidecar = await readLukerGraphSidecarV2WithAuthorityBlob(context, {
    chatStateTarget: normalizedTarget,
    chatId: targetChatId,
  });
  const sidecarResult = buildSnapshotFromLukerSidecarState(sidecar, {
    chatId: targetChatId,
    source: "branch-source-sidecar",
  });
  if (sidecarResult?.ok && sidecarResult?.snapshot) {
    try {
      return buildGraphFromSnapshot(sidecarResult.snapshot, {
        chatId: targetChatId,
      });
    } catch (error) {
      console.warn("[ST-BME] 读取 Luker branch source snapshot 失败:", error);
    }
  }

  const legacySnapshot = await readGraphChatStateSnapshot(context, {
    namespace: GRAPH_CHAT_STATE_NAMESPACE,
    target: normalizedTarget,
  });
  if (legacySnapshot?.serializedGraph) {
    try {
      return normalizeGraphRuntimeState(
        deserializeGraph(legacySnapshot.serializedGraph),
        targetChatId,
      );
    } catch (error) {
      console.warn("[ST-BME] 读取 Luker branch source legacy snapshot 失败:", error);
    }
  }

  return null;
}

async function persistLukerAuxStateNamespace(
  namespace,
  payload,
  {
    chatStateTarget = null,
    maxOperations = 1024,
  } = {},
) {
  const context = getContext();
  if (!isLukerPrimaryPersistenceHost(context)) {
    return false;
  }
  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  if (!normalizedTarget) {
    return false;
  }
  const result = await writeGraphChatStatePayload(
    context,
    namespace,
    payload,
    {
      maxOperations,
      asyncDiff: false,
      target: normalizedTarget,
    },
  );
  return result?.ok === true;
}

async function onChatBranchCreated(payload = {}) {
  const context = getContext();
  if (!isLukerPrimaryPersistenceHost(context)) {
    return { skipped: true, reason: "not-luker" };
  }

  const sourceTarget = resolveCurrentChatStateTarget(context, payload?.sourceTarget);
  const targetTarget = resolveCurrentChatStateTarget(context, payload?.targetTarget);
  const targetChatId =
    resolveChatStateTargetChatId(targetTarget) ||
    normalizeChatIdCandidate(payload?.branchName);
  const cutoffFloor = Number.isFinite(Number(payload?.mesId))
    ? Math.floor(Number(payload.mesId))
    : null;
  const assistantMessageCount = Number.isFinite(Number(payload?.assistantMessageCount))
    ? Math.max(0, Math.floor(Number(payload.assistantMessageCount)))
    : null;

  if (!sourceTarget || !targetTarget || !targetChatId) {
    const skipped = {
      ok: false,
      reason: "invalid-branch-target",
      sourceTarget: cloneRuntimeDebugValue(sourceTarget, null),
      targetTarget: cloneRuntimeDebugValue(targetTarget, null),
    };
    updateGraphPersistenceState({
      lastBranchInheritResult: skipped,
    });
    return skipped;
  }

  const sourceGraph = await readPersistedGraphForChatStateTarget(
    context,
    sourceTarget,
  );
  if (!sourceGraph) {
    const missing = {
      ok: false,
      reason: "source-graph-unavailable",
      targetChatId,
      cutoffFloor,
      assistantMessageCount,
    };
    updateGraphPersistenceState({
      lastBranchInheritResult: missing,
    });
    return missing;
  }

  const branchGraph = deriveBranchGraphFromSourceGraph(sourceGraph, {
    targetChatId,
    cutoffFloor,
    assistantMessageCount,
  });
  const branchRevision = Math.max(
    1,
    Number(getGraphPersistedRevision(sourceGraph) || 0) + 1,
  );
  const persistResult = await persistGraphToLukerSidecarV2(context, {
    graph: branchGraph,
    chatId: targetChatId,
    revision: branchRevision,
    reason: "chat-branch-created",
    accepted: true,
    lastProcessedAssistantFloor:
      branchGraph?.historyState?.lastProcessedAssistantFloor ?? null,
    extractionCount: branchGraph?.historyState?.extractionCount ?? null,
    mode: "primary",
    chatStateTarget: targetTarget,
  });

  await persistLukerAuxStateNamespace(
    LUKER_PROJECTION_STATE_NAMESPACE,
    {
      version: 1,
      runtime: {
        status: "idle",
        updatedAt: Date.now(),
        reason: "chat-branch-created",
      },
      persistent: {
        status: "idle",
        updatedAt: Date.now(),
        reason: "chat-branch-created",
      },
      targetChatId,
      derivedFrom: resolveChatStateTargetChatId(sourceTarget),
    },
    { chatStateTarget: targetTarget },
  );
  await persistLukerAuxStateNamespace(
    LUKER_DEBUG_STATE_NAMESPACE,
    {
      version: 1,
      updatedAt: Date.now(),
      lastBranchInheritResult: {
        targetChatId,
        cutoffFloor,
        assistantMessageCount,
      },
    },
    { chatStateTarget: targetTarget },
  );

  const result = {
    ok: persistResult?.saved === true,
    reason: persistResult?.reason || "",
    targetChatId,
    cutoffFloor,
    assistantMessageCount,
    sourceTarget: cloneRuntimeDebugValue(sourceTarget, null),
    targetTarget: cloneRuntimeDebugValue(targetTarget, null),
    revision: Number(persistResult?.revision || branchRevision || 0),
  };
  updateGraphPersistenceState({
    lastBranchInheritResult: result,
  });
  return result;
}

function scheduleGraphChatStateProbe(chatId, options = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (
    !normalizedChatId ||
    !canUseHostGraphChatStatePersistence(getContext()) ||
    bmeChatStateLoadInFlightByChatId.has(normalizedChatId)
  ) {
    return;
  }

  scheduleBmeIndexedDbTask(() => {
    const loadPromise = loadGraphFromChatState(normalizedChatId, options)
      .catch((error) => {
        console.warn("[ST-BME] 聊天侧车后台加载失败:", error);
      })
      .finally(() => {
        if (
          bmeChatStateLoadInFlightByChatId.get(normalizedChatId) === loadPromise
        ) {
          bmeChatStateLoadInFlightByChatId.delete(normalizedChatId);
        }
      });

    bmeChatStateLoadInFlightByChatId.set(normalizedChatId, loadPromise);
    return loadPromise;
  });
}

function isChatMetadataMigratedToAuthority(context = null) {
  const marker = readGraphCommitMarker(context || getContext());
  return marker?.migratedToAuthority === true;
}

function readLegacyGraphFromChatMetadata(chatId, context = getContext()) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  if (isChatMetadataMigratedToAuthority(context)) {
    return null;
  }

  const legacyGraph = context?.chatMetadata?.[GRAPH_METADATA_KEY];
  if (!legacyGraph) return null;

  try {
    const hydratedLegacyGraph =
      typeof legacyGraph === "string"
        ? deserializeGraph(legacyGraph)
        : legacyGraph;
    const normalizedLegacyGraph = normalizeGraphRuntimeState(
      hydratedLegacyGraph,
      normalizedChatId,
    );
    return typeof legacyGraph === "string"
      ? normalizedLegacyGraph
      : cloneGraphForPersistence(normalizedLegacyGraph, normalizedChatId);
  } catch (error) {
    console.warn("[ST-BME] 读取 legacy chat_metadata 图谱失败:", error);
    return null;
  }
}

function buildLegacyGraphIdentityCandidates(
  targetChatId,
  context = getContext(),
  { shadowSnapshot = null } = {},
) {
  const normalizedTargetChatId = normalizeChatIdCandidate(targetChatId);
  const identity = resolveCurrentChatIdentity(context);
  const candidates = new Set();
  const addCandidate = (value) => {
    const normalized = normalizeChatIdCandidate(value);
    if (!normalized || normalized === normalizedTargetChatId) return;
    candidates.add(normalized);
  };

  addCandidate(identity.hostChatId);
  for (const aliasCandidate of getGraphIdentityAliasCandidates({
    integrity: identity.integrity,
    hostChatId: identity.hostChatId,
    persistenceChatId: normalizedTargetChatId,
  })) {
    addCandidate(aliasCandidate);
  }

  const currentGraphMeta = getGraphPersistenceMeta(currentGraph) || {};
  const runtimeGraphIntegrity = normalizeChatIdCandidate(
    currentGraphMeta.integrity || graphPersistenceState.metadataIntegrity,
  );
  if (
    identity.integrity &&
    runtimeGraphIntegrity &&
    runtimeGraphIntegrity === identity.integrity
  ) {
    addCandidate(graphPersistenceState.chatId);
    addCandidate(currentGraph?.historyState?.chatId);
    addCandidate(currentGraphMeta.chatId);
  }

  addCandidate(shadowSnapshot?.chatId);
  addCandidate(shadowSnapshot?.persistedChatId);
  return Array.from(candidates);
}

async function maybeRecoverIndexedDbGraphFromStableIdentity(
  chatId,
  context = getContext(),
  { source = "unknown", db = null } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      migrated: false,
      reason: "identity-recovery-missing-chat-id",
      chatId: "",
    };
  }

  const identity = resolveCurrentChatIdentity(context);
  if (!identity.integrity) {
    return {
      migrated: false,
      reason: "identity-recovery-integrity-missing",
      chatId: normalizedChatId,
    };
  }

  const manager = ensureBmeChatManager();
  if (!manager) {
    return {
      migrated: false,
      reason: "identity-recovery-manager-unavailable",
      chatId: normalizedChatId,
    };
  }

  const targetDb = db || (await manager.getCurrentDb(normalizedChatId));
  if (!targetDb) {
    return {
      migrated: false,
      reason: "identity-recovery-db-unavailable",
      chatId: normalizedChatId,
    };
  }
  const targetStore = resolveDbGraphStorePresentation(targetDb);
  const authorityTarget = isAuthorityGraphStorePresentation(targetStore);

  const emptyStatus = await targetDb.isEmpty();
  if (!emptyStatus?.empty) {
    return {
      migrated: false,
      reason: "identity-recovery-target-not-empty",
      chatId: normalizedChatId,
      emptyStatus,
    };
  }

  const finalizeMigration = async (
    graph,
    {
      revision = 0,
      legacyChatId = "",
      migrationSource = "identity-recovery",
      shadowChatId = "",
    } = {},
  ) => {
    let safetySnapshotResult = null;
    const snapshot = await importRecoveredSnapshotToIndexedDb(
      targetDb,
      normalizedChatId,
      graph,
      {
        revision,
        integrity: identity.integrity,
        source: migrationSource,
        legacyChatId,
        markSyncDirty: !authorityTarget,
        beforeImport: authorityTarget
          ? async (candidateSnapshot) => {
              safetySnapshotResult = await captureAuthorityMigrationSafetySnapshot(
                normalizedChatId,
                candidateSnapshot,
                {
                  source: migrationSource,
                  reason: "authority-identity-recovery-safety",
                },
              );
            }
          : null,
      },
    );
    if (!authorityTarget) {
      cacheIndexedDbSnapshot(normalizedChatId, snapshot);
    }
    rememberResolvedGraphIdentityAlias(context, normalizedChatId);

    if (shadowChatId && shadowChatId !== normalizedChatId) {
      removeGraphShadowSnapshot(shadowChatId);
    }

    let syncResult = {
      synced: false,
      reason: "identity-recovery-sync-skipped",
      chatId: normalizedChatId,
    };
    if (authorityTarget) {
      const acceptedRevision = normalizeIndexedDbRevision(snapshot?.meta?.revision);
      recordAuthorityAcceptedRevisionPointer({
        revision: acceptedRevision,
        integrity: snapshot?.meta?.integrity || identity.integrity,
      });
      syncResult = {
        synced: false,
        reason: "authority-primary-legacy-sync-skipped",
        chatId: normalizedChatId,
      };
    } else {
      try {
        syncResult = await syncNow(
          normalizedChatId,
          buildBmeSyncRuntimeOptions({
            reason: "identity-recovery",
            trigger: `${String(source || "identity-recovery")}:identity-recovery`,
          }),
        );
      } catch (syncError) {
        console.warn("[ST-BME] 身份恢复后的同步失败:", syncError);
        syncResult = {
          synced: false,
          reason: "identity-recovery-sync-failed",
          chatId: normalizedChatId,
          error: syncError?.message || String(syncError),
        };
      }
    }

    return {
      migrated: true,
      reason: authorityTarget
        ? "authority-identity-recovery-completed"
        : "identity-recovery-completed",
      chatId: normalizedChatId,
      legacyChatId: normalizeChatIdCandidate(legacyChatId),
      source: migrationSource,
      snapshot,
      syncResult,
      safetySnapshotResult,
      targetStore,
    };
  };

  const currentGraphMeta = getGraphPersistenceMeta(currentGraph) || {};
  const runtimeGraphIntegrity = normalizeChatIdCandidate(
    currentGraphMeta.integrity || graphPersistenceState.metadataIntegrity,
  );
  const runtimeGraphChatId = normalizeChatIdCandidate(
    currentGraph?.historyState?.chatId ||
      currentGraphMeta.chatId ||
      graphPersistenceState.chatId,
  );

  if (
    currentGraph &&
    !isGraphEffectivelyEmpty(currentGraph) &&
    runtimeGraphIntegrity &&
    runtimeGraphIntegrity === identity.integrity &&
    runtimeGraphChatId &&
    runtimeGraphChatId !== normalizedChatId
  ) {
    return await finalizeMigration(currentGraph, {
      revision: Math.max(
        graphPersistenceState.revision || 0,
        getGraphPersistedRevision(currentGraph),
        1,
      ),
      legacyChatId: runtimeGraphChatId,
      migrationSource: "runtime-identity-promotion",
    });
  }

  const aliasShadowSnapshot = findGraphShadowSnapshotByIntegrity(
    identity.integrity,
    {
      excludeChatIds: [normalizedChatId],
    },
  );
  if (aliasShadowSnapshot?.serializedGraph) {
    try {
      const shadowGraph = normalizeGraphRuntimeState(
        deserializeGraph(aliasShadowSnapshot.serializedGraph),
        normalizedChatId,
      );
      if (!isGraphEffectivelyEmpty(shadowGraph)) {
        return await finalizeMigration(shadowGraph, {
          revision: Math.max(
            Number(aliasShadowSnapshot.revision || 0),
            getGraphPersistedRevision(shadowGraph),
            1,
          ),
          legacyChatId:
            aliasShadowSnapshot.persistedChatId || aliasShadowSnapshot.chatId,
          migrationSource: "shadow-identity-recovery",
          shadowChatId: aliasShadowSnapshot.chatId,
        });
      }
    } catch (error) {
      console.warn("[ST-BME] 通过影子快照恢复聊天身份失败:", error);
    }
  }

  const legacyCandidates = buildLegacyGraphIdentityCandidates(
    normalizedChatId,
    context,
    {
      shadowSnapshot: aliasShadowSnapshot,
    },
  );

  for (const legacyChatId of legacyCandidates) {
    try {
      const legacySnapshot = await exportIndexedDbSnapshotForChat(legacyChatId);
      if (!isIndexedDbSnapshotMeaningful(legacySnapshot)) {
        continue;
      }

      const legacyGraph = buildGraphFromSnapshot(legacySnapshot, {
        chatId: legacyChatId,
      });
      if (isGraphEffectivelyEmpty(legacyGraph)) {
        continue;
      }

      return await finalizeMigration(legacyGraph, {
        revision: Math.max(
          normalizeIndexedDbRevision(legacySnapshot?.meta?.revision),
          getGraphPersistedRevision(legacyGraph),
          1,
        ),
        legacyChatId,
        migrationSource: "indexeddb-identity-alias",
      });
    } catch (error) {
      console.warn("[ST-BME] 读取旧身份 IndexedDB 图谱失败:", {
        legacyChatId,
        error,
      });
    }
  }

  return {
    migrated: false,
    reason: "identity-recovery-no-match",
    chatId: normalizedChatId,
  };
}

async function maybeMigrateLegacyGraphToIndexedDb(
  chatId,
  context = getContext(),
  { source = "unknown", db = null } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      migrated: false,
      reason: "migration-missing-chat-id",
      chatId: "",
    };
  }

  const inFlightMigration =
    bmeIndexedDbLegacyMigrationInFlightByChatId.get(normalizedChatId);
  if (inFlightMigration) {
    return await inFlightMigration;
  }

  const migrationTask = (async () => {
    try {
      const manager = ensureBmeChatManager();
      if (!manager) {
        return {
          migrated: false,
          reason: "migration-manager-unavailable",
          chatId: normalizedChatId,
        };
      }

      const targetDb = db || (await manager.getCurrentDb(normalizedChatId));
      if (!targetDb) {
        return {
          migrated: false,
          reason: "migration-db-unavailable",
          chatId: normalizedChatId,
        };
      }
      const targetStore = resolveDbGraphStorePresentation(targetDb);
      const authorityTarget = isAuthorityGraphStorePresentation(targetStore);

      const contextChatId = resolveCurrentChatIdentity(context).chatId;
      if (contextChatId && contextChatId !== normalizedChatId) {
        return {
          migrated: false,
          reason: "migration-context-chat-mismatch",
          chatId: normalizedChatId,
          contextChatId,
        };
      }

      const migrationCompletedAt = Number(
        await targetDb.getMeta("migrationCompletedAt", 0),
      );
      if (Number.isFinite(migrationCompletedAt) && migrationCompletedAt > 0) {
        return {
          migrated: false,
          reason: "migration-already-completed",
          chatId: normalizedChatId,
          migrationCompletedAt,
        };
      }

      const legacyGraph = readLegacyGraphFromChatMetadata(
        normalizedChatId,
        context,
      );
      if (!legacyGraph) {
        return {
          migrated: false,
          reason: "migration-legacy-graph-missing",
          chatId: normalizedChatId,
        };
      }

      const emptyStatus = await targetDb.isEmpty();
      if (!emptyStatus?.empty) {
        const existingNodes = Number(emptyStatus?.nodes || 0);
        const existingEdges = Number(emptyStatus?.edges || 0);
        if (existingNodes + existingEdges < 5) {
          console.warn(
            "[ST-BME] Authority store 非空但数据量极少，可能是残留数据。" +
            `节点: ${existingNodes}, 边: ${existingEdges}。` +
            "如需强制重新迁移，请在面板中清除 Authority 数据后重试。",
            { chatId: normalizedChatId, emptyStatus },
          );
        }
        return {
          migrated: false,
          reason: "migration-indexeddb-not-empty",
          chatId: normalizedChatId,
          emptyStatus,
        };
      }

      const legacyRevision = Math.max(
        normalizeIndexedDbRevision(getGraphPersistedRevision(legacyGraph), 0),
        1,
      );
      const safetySnapshotResult = authorityTarget
        ? await captureAuthorityMigrationSafetySnapshot(
            normalizedChatId,
            buildSnapshotFromGraph(legacyGraph, {
              chatId: normalizedChatId,
              revision: legacyRevision,
              meta: {
                migrationSource: "chat_metadata",
              },
            }),
            {
              source: "chat_metadata",
              reason: "authority-chat-metadata-migration-safety",
            },
          )
        : null;
      const migrationResult = await targetDb.importLegacyGraph(legacyGraph, {
        source: "chat_metadata",
        revision: legacyRevision,
        markSyncDirty: !authorityTarget,
      });
      if (!migrationResult?.migrated) {
        return {
          migrated: false,
          reason: migrationResult?.reason || "migration-skipped",
          chatId: normalizedChatId,
          migrationResult,
        };
      }

      const postMigrationSnapshot = await targetDb.exportSnapshot();
      if (!authorityTarget) {
        cacheIndexedDbSnapshot(normalizedChatId, postMigrationSnapshot);
      }
      if (authorityTarget) {
        recordAuthorityAcceptedRevisionPointer({
          revision:
            postMigrationSnapshot?.meta?.revision ||
            migrationResult?.revision ||
            legacyRevision,
          integrity: postMigrationSnapshot?.meta?.integrity,
        });
      }

      if (authorityTarget && migrationResult?.migrated) {
        try {
          writeChatMetadataPatch(context, {
            [GRAPH_COMMIT_MARKER_KEY]: {
              ...normalizeGraphCommitMarker(readGraphCommitMarker(context)),
              migratedToAuthority: true,
              migratedAt: new Date().toISOString(),
              migratedRevision: migrationResult.revision || legacyRevision,
            },
          });
        } catch (markerError) {
          console.warn("[ST-BME] 写入迁移完成标记失败（非致命）:", markerError);
        }
      }

      if (authorityTarget && migrationResult?.migrated) {
        try {
          await targetDb.patchMeta({
            runtimeVectorIndexState: {
              dirty: true,
              dirtyReason: "authority-migration-trivium-rebuild",
              triviumRebuildRequired: true,
              lastWarning: "Authority 迁移完成，Trivium 向量需重建",
            },
          });
        } catch (metaError) {
          console.warn("[ST-BME] 写入 Trivium 重建标记失败（非致命）:", metaError);
        }
        try {
          const settings = getSettings();
          if (shouldUseAuthorityJobs(settings)) {
            const vectorConfig = normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
            if (vectorConfig?.mode === "authority") {
              await submitAuthorityVectorRebuildJob({
                config: vectorConfig,
                purge: true,
                reason: "authority-migration-trivium-rebuild",
              });
            }
          }
        } catch (vectorJobError) {
          console.warn("[ST-BME] 迁移后触发 Trivium 重建 Job 失败（非阻塞）:", vectorJobError);
        }
      }

      debugDebug("[ST-BME] legacy chat_metadata 图谱迁移完成", {
        source,
        chatId: normalizedChatId,
        revision:
          postMigrationSnapshot?.meta?.revision ||
          migrationResult?.revision ||
          0,
        imported: migrationResult.imported,
      });

      let syncResult = {
        synced: false,
        reason: "post-migration-sync-skipped",
        chatId: normalizedChatId,
      };
      if (authorityTarget) {
        syncResult = {
          synced: false,
          reason: "authority-primary-legacy-sync-skipped",
          chatId: normalizedChatId,
        };
      } else {
        try {
          syncResult = await syncNow(
            normalizedChatId,
            buildBmeSyncRuntimeOptions({
              reason: "post-migration",
              trigger: `${String(source || "migration")}:post-migration`,
            }),
          );
        } catch (syncError) {
          console.warn("[ST-BME] legacy 迁移后立即同步失败:", syncError);
          syncResult = {
            synced: false,
            reason: "post-migration-sync-failed",
            chatId: normalizedChatId,
            error: syncError?.message || String(syncError),
          };
        }
      }

      return {
        migrated: true,
        reason: authorityTarget
          ? "authority-chat-metadata-migration-completed"
          : "migration-completed",
        chatId: normalizedChatId,
        migrationResult,
        snapshot: postMigrationSnapshot,
        syncResult,
        safetySnapshotResult,
        targetStore,
      };
    } catch (error) {
      console.warn("[ST-BME] legacy chat_metadata 迁移失败:", error);
      return {
        migrated: false,
        reason: "migration-failed",
        chatId: normalizedChatId,
        error: error?.message || String(error),
      };
    }
  })().finally(() => {
    if (
      bmeIndexedDbLegacyMigrationInFlightByChatId.get(normalizedChatId) ===
      migrationTask
    ) {
      bmeIndexedDbLegacyMigrationInFlightByChatId.delete(normalizedChatId);
    }
  });

  bmeIndexedDbLegacyMigrationInFlightByChatId.set(
    normalizedChatId,
    migrationTask,
  );
  return await migrationTask;
}

async function maybeImportLegacyIndexedDbSnapshotToLocalStore(
  chatId,
  targetDb,
  { source = "unknown" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      migrated: false,
      reason: "migration-local-store-missing-chat-id",
      chatId: "",
    };
  }

  const inFlightMigration =
    bmeIndexedDbLocalStoreMigrationInFlightByChatId.get(normalizedChatId);
  if (inFlightMigration) {
    return await inFlightMigration;
  }

  const migrationTask = (async () => {
    try {
      if (
        !targetDb ||
        typeof targetDb.isEmpty !== "function" ||
        typeof targetDb.importSnapshot !== "function" ||
        typeof targetDb.exportSnapshot !== "function"
      ) {
        return {
          migrated: false,
          reason: "migration-local-store-unavailable",
          chatId: normalizedChatId,
        };
      }

      const targetStore = resolveDbGraphStorePresentation(targetDb);
      const authorityTarget = isAuthorityGraphStorePresentation(targetStore);
      if (targetStore.storagePrimary === "indexeddb") {
        return {
          migrated: false,
          reason: "migration-local-store-indexeddb-active",
          chatId: normalizedChatId,
        };
      }

      const emptyStatus = await targetDb.isEmpty();
      if (!emptyStatus?.empty) {
        const existingNodes = Number(emptyStatus?.nodes || 0);
        const existingEdges = Number(emptyStatus?.edges || 0);
        if (existingNodes + existingEdges < 5) {
          console.warn(
            "[ST-BME] 本地存储非空但数据量极少，可能是残留数据。" +
            `节点: ${existingNodes}, 边: ${existingEdges}。` +
            "如需强制重新迁移，请在面板中清除数据后重试。",
            { chatId: normalizedChatId, emptyStatus },
          );
        }
        return {
          migrated: false,
          reason: "migration-local-store-not-empty",
          chatId: normalizedChatId,
          emptyStatus,
        };
      }

      const legacySnapshot = await exportIndexedDbSnapshotForChat(
        normalizedChatId,
      );
      if (!isIndexedDbSnapshotMeaningful(legacySnapshot)) {
        return {
          migrated: false,
          reason: "migration-local-store-legacy-indexeddb-missing",
          chatId: normalizedChatId,
        };
      }

      const nowMs = Date.now();
      const normalizedRevision = Math.max(
        normalizeIndexedDbRevision(legacySnapshot?.meta?.revision),
        1,
      );
      const legacyMeta =
        legacySnapshot?.meta &&
        typeof legacySnapshot.meta === "object" &&
        !Array.isArray(legacySnapshot.meta)
          ? legacySnapshot.meta
          : {};
      const legacyState =
        legacySnapshot?.state &&
        typeof legacySnapshot.state === "object" &&
        !Array.isArray(legacySnapshot.state)
          ? legacySnapshot.state
          : {};
      const migrationSource = authorityTarget
        ? "legacy_indexeddb_to_authority"
        : "legacy_indexeddb_snapshot";
      const safetySnapshotResult = authorityTarget
        ? await captureAuthorityMigrationSafetySnapshot(normalizedChatId, legacySnapshot, {
            source: migrationSource,
            reason: "authority-indexeddb-migration-safety",
          })
        : null;
      const importSnapshot = {
        meta: {
          ...legacyMeta,
          chatId: normalizedChatId,
          migrationCompletedAt: nowMs,
          migrationSource,
          migratedFromStoragePrimary: "indexeddb",
          migratedFromStorageMode: BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
          migratedToStoragePrimary: authorityTarget
            ? AUTHORITY_GRAPH_STORE_KIND
            : targetStore.storagePrimary,
          migratedToStorageMode: authorityTarget
            ? AUTHORITY_GRAPH_STORE_MODE
            : targetStore.storageMode,
        },
        state: {
          ...legacyState,
        },
        nodes: Array.isArray(legacySnapshot?.nodes)
          ? legacySnapshot.nodes.map((node) =>
              cloneRuntimeDebugValue(node, node),
            )
          : [],
        edges: Array.isArray(legacySnapshot?.edges)
          ? legacySnapshot.edges.map((edge) =>
              cloneRuntimeDebugValue(edge, edge),
            )
          : [],
        tombstones: Array.isArray(legacySnapshot?.tombstones)
          ? legacySnapshot.tombstones.map((record) =>
              cloneRuntimeDebugValue(record, record),
            )
          : [],
      };

      const migrationResult = await targetDb.importSnapshot(importSnapshot, {
        mode: "replace",
        preserveRevision: true,
        revision: normalizedRevision,
        markSyncDirty: authorityTarget ? false : Boolean(legacyMeta.syncDirty),
      });
      const snapshot = await targetDb.exportSnapshot();
      if (authorityTarget) {
        recordAuthorityAcceptedRevisionPointer({
          revision: snapshot?.meta?.revision || migrationResult?.revision || normalizedRevision,
          integrity: snapshot?.meta?.integrity || legacyMeta.integrity,
        });
      }

      if (authorityTarget && migrationResult?.imported !== undefined) {
        try {
          const ctx = getContext();
          writeChatMetadataPatch(ctx, {
            [GRAPH_COMMIT_MARKER_KEY]: {
              ...normalizeGraphCommitMarker(readGraphCommitMarker(ctx)),
              migratedToAuthority: true,
              migratedAt: new Date().toISOString(),
              migratedRevision: migrationResult.revision || normalizedRevision,
              migrationSource: migrationSource,
            },
          });
        } catch (markerError) {
          console.warn("[ST-BME] 写入 IndexedDB→Authority 迁移完成标记失败（非致命）:", markerError);
        }
      }

      if (authorityTarget) {
        try {
          await targetDb.patchMeta({
            runtimeVectorIndexState: {
              dirty: true,
              dirtyReason: "authority-migration-trivium-rebuild",
              triviumRebuildRequired: true,
              lastWarning: "Authority 迁移完成，Trivium 向量需重建",
            },
          });
        } catch (metaError) {
          console.warn("[ST-BME] 写入 Trivium 重建标记失败（非致命）:", metaError);
        }
        try {
          const settings = getSettings();
          if (shouldUseAuthorityJobs(settings)) {
            const vectorConfig = normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
            if (vectorConfig?.mode === "authority") {
              await submitAuthorityVectorRebuildJob({
                config: vectorConfig,
                purge: true,
                reason: "authority-migration-trivium-rebuild",
              });
            }
          }
        } catch (vectorJobError) {
          console.warn("[ST-BME] 迁移后触发 Trivium 重建 Job 失败（非阻塞）:", vectorJobError);
        }
      }

      debugDebug("[ST-BME] 已将 legacy IndexedDB 快照迁移到当前本地存储", {
        source,
        chatId: normalizedChatId,
        targetStore: cloneRuntimeDebugValue(targetStore, null),
        revision:
          snapshot?.meta?.revision || migrationResult?.revision || normalizedRevision,
      });

      return {
        migrated: true,
        reason: authorityTarget
          ? "authority-indexeddb-migration-completed"
          : "migration-local-store-completed",
        source: migrationSource,
        chatId: normalizedChatId,
        migrationResult,
        snapshot,
        targetStore,
        safetySnapshotResult,
      };
    } catch (error) {
      console.warn("[ST-BME] 迁移 legacy IndexedDB 快照到当前本地存储失败:", {
        chatId: normalizedChatId,
        error,
      });
      return {
        migrated: false,
        reason: "migration-local-store-failed",
        chatId: normalizedChatId,
        error: error?.message || String(error),
      };
    }
  })().finally(() => {
    if (
      bmeIndexedDbLocalStoreMigrationInFlightByChatId.get(normalizedChatId) ===
      migrationTask
    ) {
      bmeIndexedDbLocalStoreMigrationInFlightByChatId.delete(
        normalizedChatId,
      );
    }
  });

  bmeIndexedDbLocalStoreMigrationInFlightByChatId.set(
    normalizedChatId,
    migrationTask,
  );
  return await migrationTask;
}

async function maybeImportLegacyOpfsSnapshotToLocalStore(
  chatId,
  targetDb,
  { source = "unknown" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      migrated: false,
      reason: "migration-opfs-missing-chat-id",
      chatId: "",
    };
  }

  const inFlightMigration =
    bmeIndexedDbOpfsMigrationInFlightByChatId.get(normalizedChatId);
  if (inFlightMigration) {
    return await inFlightMigration;
  }

  const migrationTask = (async () => {
    try {
      if (
        !targetDb ||
        typeof targetDb.isEmpty !== "function" ||
        typeof targetDb.importSnapshot !== "function" ||
        typeof targetDb.exportSnapshot !== "function"
      ) {
        return {
          migrated: false,
          reason: "migration-opfs-store-unavailable",
          chatId: normalizedChatId,
        };
      }

      const targetStore = resolveDbGraphStorePresentation(targetDb);
      const authorityTarget = isAuthorityGraphStorePresentation(targetStore);
      if (targetStore.storagePrimary === "opfs") {
        return {
          migrated: false,
          reason: "migration-opfs-same-storage",
          chatId: normalizedChatId,
        };
      }

      const migrationCompletedAt = Number(
        await targetDb.getMeta("migrationCompletedAt", 0),
      );
      if (Number.isFinite(migrationCompletedAt) && migrationCompletedAt > 0) {
        return {
          migrated: false,
          reason: "migration-already-completed",
          chatId: normalizedChatId,
          migrationCompletedAt,
        };
      }

      const emptyStatus = await targetDb.isEmpty();
      if (!emptyStatus?.empty) {
        const existingNodes = Number(emptyStatus?.nodes || 0);
        const existingEdges = Number(emptyStatus?.edges || 0);
        if (existingNodes + existingEdges < 5) {
          console.warn(
            "[ST-BME] OPFS 迁移目标非空但数据量极少，可能是残留数据。" +
            `节点: ${existingNodes}, 边: ${existingEdges}。` +
            "如需强制重新迁移，请在面板中清除数据后重试。",
            { chatId: normalizedChatId, emptyStatus },
          );
        }
        return {
          migrated: false,
          reason: "migration-opfs-target-not-empty",
          chatId: normalizedChatId,
          emptyStatus,
        };
      }

      const legacySnapshot = await exportOpfsSnapshotForChat(normalizedChatId);
      if (!isIndexedDbSnapshotMeaningful(legacySnapshot)) {
        return {
          migrated: false,
          reason: "migration-opfs-legacy-snapshot-missing",
          chatId: normalizedChatId,
        };
      }

      const nowMs = Date.now();
      const normalizedRevision = Math.max(
        normalizeIndexedDbRevision(legacySnapshot?.meta?.revision),
        1,
      );
      const legacyMeta =
        legacySnapshot?.meta &&
        typeof legacySnapshot.meta === "object" &&
        !Array.isArray(legacySnapshot.meta)
          ? legacySnapshot.meta
          : {};
      const legacyState =
        legacySnapshot?.state &&
        typeof legacySnapshot.state === "object" &&
        !Array.isArray(legacySnapshot.state)
          ? legacySnapshot.state
          : {};
      const migrationSource = authorityTarget
        ? "legacy_opfs_to_authority"
        : "legacy_opfs_snapshot";
      const safetySnapshotResult = authorityTarget
        ? await captureAuthorityMigrationSafetySnapshot(normalizedChatId, legacySnapshot, {
            source: migrationSource,
            reason: "authority-opfs-migration-safety",
          })
        : null;
      const importSnapshot = {
        meta: {
          ...legacyMeta,
          chatId: normalizedChatId,
          migrationCompletedAt: nowMs,
          migrationSource,
          migratedFromStoragePrimary: "opfs",
          migratedFromStorageMode: legacyMeta.migratedFromStorageMode || "opfs-primary",
          migratedToStoragePrimary: authorityTarget
            ? AUTHORITY_GRAPH_STORE_KIND
            : targetStore.storagePrimary,
          migratedToStorageMode: authorityTarget
            ? AUTHORITY_GRAPH_STORE_MODE
            : targetStore.storageMode,
          opfsMigrationCompletedAt: nowMs,
        },
        state: {
          ...legacyState,
        },
        nodes: Array.isArray(legacySnapshot?.nodes)
          ? legacySnapshot.nodes.map((node) =>
              cloneRuntimeDebugValue(node, node),
            )
          : [],
        edges: Array.isArray(legacySnapshot?.edges)
          ? legacySnapshot.edges.map((edge) =>
              cloneRuntimeDebugValue(edge, edge),
            )
          : [],
        tombstones: Array.isArray(legacySnapshot?.tombstones)
          ? legacySnapshot.tombstones.map((record) =>
              cloneRuntimeDebugValue(record, record),
            )
          : [],
      };

      const migrationResult = await targetDb.importSnapshot(importSnapshot, {
        mode: "replace",
        preserveRevision: true,
        revision: normalizedRevision,
        markSyncDirty: authorityTarget ? false : Boolean(legacyMeta.syncDirty),
      });
      const snapshot = await targetDb.exportSnapshot();
      if (authorityTarget) {
        recordAuthorityAcceptedRevisionPointer({
          revision: snapshot?.meta?.revision || migrationResult?.revision || normalizedRevision,
          integrity: snapshot?.meta?.integrity || legacyMeta.integrity,
        });
      }

      if (authorityTarget) {
        try {
          const ctx = getContext();
          writeChatMetadataPatch(ctx, {
            [GRAPH_COMMIT_MARKER_KEY]: {
              ...normalizeGraphCommitMarker(readGraphCommitMarker(ctx)),
              migratedToAuthority: true,
              migratedAt: new Date().toISOString(),
              migratedRevision: migrationResult.revision || normalizedRevision,
              migrationSource: migrationSource,
            },
          });
        } catch (markerError) {
          console.warn("[ST-BME] 写入 OPFS→Authority 迁移完成标记失败（非致命）:", markerError);
        }
      }

      if (authorityTarget) {
        try {
          await targetDb.patchMeta({
            runtimeVectorIndexState: {
              dirty: true,
              dirtyReason: "authority-migration-trivium-rebuild",
              triviumRebuildRequired: true,
              lastWarning: "Authority 迁移完成，Trivium 向量需重建",
            },
          });
        } catch (metaError) {
          console.warn("[ST-BME] 写入 Trivium 重建标记失败（非致命）:", metaError);
        }
        try {
          const settings = getSettings();
          if (shouldUseAuthorityJobs(settings)) {
            const vectorConfig = normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
            if (vectorConfig?.mode === "authority") {
              await submitAuthorityVectorRebuildJob({
                config: vectorConfig,
                purge: true,
                reason: "authority-migration-trivium-rebuild",
              });
            }
          }
        } catch (vectorJobError) {
          console.warn("[ST-BME] 迁移后触发 Trivium 重建 Job 失败（非阻塞）:", vectorJobError);
        }
      }

      debugDebug("[ST-BME] 已将 legacy OPFS 快照迁移到当前本地存储", {
        source,
        chatId: normalizedChatId,
        targetStore: cloneRuntimeDebugValue(targetStore, null),
        revision:
          snapshot?.meta?.revision || migrationResult?.revision || normalizedRevision,
      });

      return {
        migrated: true,
        reason: authorityTarget
          ? "authority-opfs-migration-completed"
          : "migration-opfs-completed",
        source: migrationSource,
        chatId: normalizedChatId,
        migrationResult,
        snapshot,
        targetStore,
        safetySnapshotResult,
      };
    } catch (error) {
      console.warn("[ST-BME] 迁移 legacy OPFS 快照到当前本地存储失败:", {
        chatId: normalizedChatId,
        error,
      });
      return {
        migrated: false,
        reason: "migration-opfs-failed",
        chatId: normalizedChatId,
        error: error?.message || String(error),
      };
    }
  })().finally(() => {
    if (
      bmeIndexedDbOpfsMigrationInFlightByChatId.get(normalizedChatId) ===
      migrationTask
    ) {
      bmeIndexedDbOpfsMigrationInFlightByChatId.delete(
        normalizedChatId,
      );
    }
  });

  bmeIndexedDbOpfsMigrationInFlightByChatId.set(
    normalizedChatId,
    migrationTask,
  );
  return await migrationTask;
}

function applyIndexedDbEmptyToRuntime(
  chatId,
  { source = "indexeddb-empty", attemptIndex = 0 } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return {
      success: false,
      loaded: false,
      reason: "indexeddb-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
  }

  currentGraph = normalizeGraphRuntimeState(
    createEmptyGraph(),
    normalizedChatId,
  );
  extractionCount = 0;
  lastExtractedItems = [];
  lastRecalledItems = [];
  lastInjectionContent = "";
  runtimeStatus = createUiStatus("待命", "当前聊天还没有图谱", "idle");
  lastExtractionStatus = createUiStatus("待命", "当前聊天尚未执行提取", "idle");
  lastVectorStatus = createUiStatus("待命", "当前聊天尚未执行向量任务", "idle");
  lastRecallStatus = createUiStatus("待命", "当前聊天尚未建立记忆图谱", "idle");
  const activeStore = getPreferredGraphLocalStorePresentationSync();

  applyGraphLoadState(GRAPH_LOAD_STATES.EMPTY_CONFIRMED, {
    chatId: normalizedChatId,
    reason: `indexeddb-empty:${String(source || "indexeddb-empty")}`,
    attemptIndex,
    revision: 0,
    lastPersistedRevision: 0,
    queuedPersistRevision: 0,
    queuedPersistChatId: "",
    pendingPersist: false,
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    dbReady: true,
    writesBlocked: false,
    storagePrimary: activeStore.storagePrimary,
    storageMode: activeStore.storageMode,
  });

  updateGraphPersistenceState({
    storagePrimary: activeStore.storagePrimary,
    storageMode: activeStore.storageMode,
    dbReady: true,
    persistMismatchReason: "",
    indexedDbRevision: 0,
    indexedDbLastError: "",
    dualWriteLastResult: {
      action: "load",
      source: String(source || "indexeddb-empty"),
      success: true,
      empty: true,
      at: Date.now(),
    },
  });

  refreshPanelLiveState();
  return {
    success: true,
    loaded: false,
    emptyConfirmed: true,
    loadState: GRAPH_LOAD_STATES.EMPTY_CONFIRMED,
    reason: `indexeddb-empty:${String(source || "indexeddb-empty")}`,
    chatId: normalizedChatId,
    attemptIndex,
  };
}

function queueRuntimeGraphLocalStoreRepair(
  chatId,
  {
    source = "runtime-local-store-repair",
    scheduleCloudUpload = false,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const identity = resolveCurrentChatIdentity(getContext());
  if (
    !normalizedChatId ||
    bmeIndexedDbRuntimeRepairInFlightByChatId.has(normalizedChatId) ||
    !hasMeaningfulRuntimeGraphForChat(normalizedChatId, identity)
  ) {
    return {
      queued: false,
      chatId: normalizedChatId || "",
      reason: !normalizedChatId
        ? "missing-chat-id"
        : bmeIndexedDbRuntimeRepairInFlightByChatId.has(normalizedChatId)
          ? "already-running"
          : "runtime-graph-unavailable",
    };
  }

  const graphSnapshot = cloneGraphForPersistence(currentGraph, normalizedChatId);
  const requestedRevision = Math.max(
    1,
    Number(getGraphPersistedRevision(graphSnapshot) || 0),
    Number(graphPersistenceState.revision || 0),
    Number(graphPersistenceState.lastAcceptedRevision || 0),
    Number(graphPersistenceState.lastPersistedRevision || 0),
  );
  const repairReason = `${String(source || "runtime-local-store-repair")}:repair-local-store`;
  bmeIndexedDbRuntimeRepairInFlightByChatId.add(normalizedChatId);
  updateGraphPersistenceState({
    indexedDbLastError: "",
    lastPersistReason: repairReason,
    lastPersistMode: "runtime-local-store-repair-queued",
  });

  scheduleBmeIndexedDbTask(async () => {
    try {
      const result = await saveGraphToIndexedDb(normalizedChatId, graphSnapshot, {
        revision: requestedRevision,
        reason: repairReason,
        scheduleCloudUpload,
      });
      if (
        result?.accepted !== true &&
        graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING &&
        hasMeaningfulRuntimeGraphForChat(normalizedChatId, identity)
      ) {
        applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
          chatId: normalizedChatId,
          reason: result?.reason || "runtime-local-store-repair-failed",
          revision: Math.max(
            Number(graphPersistenceState.revision || 0),
            Number(result?.revision || requestedRevision),
          ),
          lastPersistedRevision: Math.max(
            Number(graphPersistenceState.lastPersistedRevision || 0),
            Number(result?.revision || 0),
          ),
          pendingPersist: false,
          dbReady: false,
          writesBlocked: true,
        });
      }
    } catch (error) {
      if (
        graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING &&
        hasMeaningfulRuntimeGraphForChat(normalizedChatId, identity)
      ) {
        applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
          chatId: normalizedChatId,
          reason: error?.message || "runtime-local-store-repair-failed",
          pendingPersist: false,
          dbReady: false,
          writesBlocked: true,
        });
      }
    } finally {
      bmeIndexedDbRuntimeRepairInFlightByChatId.delete(normalizedChatId);
      refreshPanelLiveState();
    }
  });

  return {
    queued: true,
    chatId: normalizedChatId,
    reason: repairReason,
    revision: requestedRevision,
  };
}

async function maybeResolveOrphanAcceptedCommitMarker(
  chatId,
  {
    source = "indexeddb-probe",
    attemptIndex = 0,
    commitMarker = null,
    migrationResult = null,
    shadowSnapshot = null,
    applyEmptyState = false,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const context = getContext();
  const activeIdentity = resolveCurrentChatIdentity(context);
  const activePersistenceChatId =
    normalizeChatIdCandidate(activeIdentity?.chatId) || normalizedChatId;
  const acceptedRevision = getAcceptedCommitMarkerRevision(commitMarker);
  if (!normalizedChatId || acceptedRevision <= 0) {
    return {
      resolved: false,
      reason: "marker-not-accepted",
      result: null,
      chatId: normalizedChatId || "",
    };
  }

  if (!doesChatIdMatchResolvedGraphIdentity(normalizedChatId, activeIdentity)) {
    return {
      resolved: false,
      reason: "chat-switched",
      result: null,
      chatId: normalizedChatId,
    };
  }

  let chatStateResult = null;
  if (canUseHostGraphChatStatePersistence(context)) {
    chatStateResult = await loadGraphFromChatState(activePersistenceChatId, {
      source: `${source}:orphan-chat-state-fallback`,
      attemptIndex,
      allowOverride: true,
    });
    if (chatStateResult?.loaded) {
      return {
        resolved: true,
        reason: "chat-state-loaded",
        result: chatStateResult,
        chatId: normalizedChatId,
        chatStateResult,
        orphanCleared: false,
      };
    }

    const chatStateReason = String(chatStateResult?.reason || "");
    if (
      chatStateReason &&
      chatStateReason !== "chat-state-empty" &&
      chatStateReason !== "chat-state-unavailable"
    ) {
      return {
        resolved: false,
        reason: chatStateReason,
        result: null,
        chatId: normalizedChatId,
        chatStateResult,
      };
    }
  }

  if (shadowSnapshot) {
    return {
      resolved: false,
      reason: "shadow-available",
      result: null,
      chatId: normalizedChatId,
      chatStateResult,
    };
  }

  if (String(migrationResult?.reason || "").trim() === "migration-failed") {
    return {
      resolved: false,
      reason: "migration-failed",
      result: null,
      chatId: normalizedChatId,
      chatStateResult,
    };
  }

  const clearResult = clearCurrentChatCommitMarker({
    context,
    reason: `orphan-accepted-marker:${source}`,
    immediate: true,
    resetAcceptedRevision: true,
  });
  debugDebug("[ST-BME] 已自动清理孤儿 accepted commit marker", {
    chatId: normalizedChatId,
    source,
    acceptedRevision,
    migrationReason: String(migrationResult?.reason || ""),
    chatStateReason: String(chatStateResult?.reason || ""),
  });

  if (applyEmptyState) {
    const emptyResult = applyIndexedDbEmptyToRuntime(activePersistenceChatId, {
      source: `${source}:orphan-accepted-marker`,
      attemptIndex,
    });
    return {
      resolved: true,
      reason: "orphan-accepted-marker-cleared",
      result: {
        ...emptyResult,
        orphanCommitMarkerCleared: true,
        clearedMarkerRevision: acceptedRevision,
      },
      chatId: normalizedChatId,
      chatStateResult,
      clearResult,
      orphanCleared: true,
    };
  }

  return {
    resolved: true,
    reason: "orphan-accepted-marker-cleared",
    result: {
      success: false,
      loaded: false,
      reason: "indexeddb-empty",
      chatId: normalizedChatId,
      attemptIndex,
      orphanCommitMarkerCleared: true,
      clearedMarkerRevision: acceptedRevision,
    },
    chatId: normalizedChatId,
    chatStateResult,
    clearResult,
    orphanCleared: true,
  };
}

function applyIndexedDbSnapshotToRuntime(
  chatId,
  snapshot,
  {
    source = "indexeddb",
    attemptIndex = 0,
    storagePrimary = "indexeddb",
    storageMode = storagePrimary,
    statusLabel = "IndexedDB",
    reasonPrefix = "indexeddb",
    currentSettings = null,
    nativeHydrateRequested = null,
    nativeHydrateForceDisabled = null,
    nativeHydrateGate = null,
    nativeHydratePreloadStatus = "",
    nativeHydratePreloadMs = 0,
    nativeHydratePreloadError = "",
    nativeHydrateModuleStatus = null,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  syncCommitMarkerToPersistenceState(getContext());
  const loadStartedAt = readLoadDiagnosticsNow();
  const recordLoadDiagnostics = (patch = {}) =>
    updateLoadDiagnostics({
      stage: "apply-indexeddb-snapshot",
      source: String(source || reasonPrefix),
      reasonPrefix: String(reasonPrefix || "indexeddb"),
      statusLabel: String(statusLabel || "IndexedDB"),
      chatId: normalizedChatId || "",
      attemptIndex: Number.isFinite(Number(attemptIndex))
        ? Math.max(0, Math.floor(Number(attemptIndex)))
        : 0,
      storagePrimary: String(storagePrimary || "indexeddb"),
      storageMode: String(storageMode || storagePrimary || "indexeddb"),
      ...cloneRuntimeDebugValue(patch, {}),
      totalMs: normalizeLoadDiagnosticsMs(readLoadDiagnosticsNow() - loadStartedAt),
    });
  let hydrateMs = 0;
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot)) {
    const result = {
      success: false,
      loaded: false,
      reason: `${reasonPrefix}-empty`,
      chatId: normalizedChatId,
      attemptIndex,
    };
    recordLoadDiagnostics({
      success: false,
      loaded: false,
      reason: result.reason,
    });
    return result;
  }

  const revision = Math.max(
    1,
    normalizeIndexedDbRevision(snapshot?.meta?.revision),
  );
  const staleDecision = detectStaleIndexedDbSnapshotAgainstRuntime(
    normalizedChatId,
    snapshot,
  );
  if (staleDecision.stale) {
    const persistencePatch = {
      storagePrimary: graphPersistenceState.storagePrimary || storagePrimary,
      storageMode: graphPersistenceState.storageMode || storageMode,
      metadataIntegrity:
        getChatMetadataIntegrity(getContext()) ||
        graphPersistenceState.metadataIntegrity,
      indexedDbLastError: "",
      dualWriteLastResult: {
        action: "load",
        source: String(source || reasonPrefix),
        success: false,
        rejected: true,
        reason: `${reasonPrefix}-stale-runtime`,
        revision,
        staleDetail: cloneRuntimeDebugValue(staleDecision, null),
        at: Date.now(),
      },
    };
    if (storagePrimary === "indexeddb") {
      persistencePatch.indexedDbRevision = Math.max(
        graphPersistenceState.indexedDbRevision || 0,
        revision,
      );
    }
    updateGraphPersistenceState({
      ...persistencePatch,
    });
    debugDebug(`[ST-BME] 已拒绝用较旧 ${statusLabel} 快照覆盖当前运行时图谱`, {
      chatId: normalizedChatId,
      source,
      revision,
      staleDetail: staleDecision,
    });
    const result = {
      success: false,
      loaded: false,
      reason: `${reasonPrefix}-stale-runtime`,
      chatId: normalizedChatId,
      attemptIndex,
      revision,
      staleDetail: cloneRuntimeDebugValue(staleDecision, null),
    };
    recordLoadDiagnostics({
      success: false,
      loaded: false,
      reason: result.reason,
      revision,
      staleDetail: cloneRuntimeDebugValue(staleDecision, null),
    });
    return result;
  }
  let graphFromSnapshot = null;
  let hydrateDiagnostics = null;
  const effectiveSettings = currentSettings || getSettings();
  const resolvedNativeHydrateRequested =
    nativeHydrateRequested == null
      ? effectiveSettings.loadUseNativeHydrate === true
      : nativeHydrateRequested === true;
  const resolvedNativeHydrateForceDisabled =
    nativeHydrateForceDisabled == null
      ? effectiveSettings.graphNativeForceDisable === true
      : nativeHydrateForceDisabled === true;
  const resolvedNativeHydrateGate =
    nativeHydrateGate && typeof nativeHydrateGate === "object"
      ? nativeHydrateGate
      : evaluateNativeHydrateGate(snapshot, effectiveSettings);
  const shouldUseNativeHydrate =
    resolvedNativeHydrateRequested &&
    resolvedNativeHydrateForceDisabled !== true &&
    resolvedNativeHydrateGate.allowed;
  const resolvedNativeHydratePreloadStatus = String(
    nativeHydratePreloadStatus ||
      (resolvedNativeHydrateRequested ? "not-preloaded" : "not-requested"),
  );
  try {
    const hydrateStartedAt = readLoadDiagnosticsNow();
    graphFromSnapshot = buildGraphFromSnapshot(snapshot, {
      chatId: normalizedChatId,
      useNativeHydrate: shouldUseNativeHydrate,
      nativeFailOpen: effectiveSettings.nativeEngineFailOpen !== false,
      loadNativeHydrateThresholdRecords:
        effectiveSettings.loadNativeHydrateThresholdRecords,
      onDiagnostics(snapshotValue) {
        hydrateDiagnostics =
          snapshotValue &&
          typeof snapshotValue === "object" &&
          !Array.isArray(snapshotValue)
            ? snapshotValue
            : null;
      },
    });
    hydrateMs = readLoadDiagnosticsNow() - hydrateStartedAt;
  } catch (error) {
    const failureReason =
      error?.code === "BME_SNAPSHOT_INTEGRITY_ERROR"
        ? `${reasonPrefix}-snapshot-integrity-rejected`
        : `${reasonPrefix}-snapshot-load-failed`;
    const persistencePatch = {
      storagePrimary,
      storageMode,
      dbReady: true,
      indexedDbLastError: error?.message || String(error),
      dualWriteLastResult: {
        action: "load",
        source: String(source || reasonPrefix),
        success: false,
        rejected: true,
        reason: failureReason,
        revision,
        at: Date.now(),
      },
    };
    if (storagePrimary === "indexeddb") {
      persistencePatch.indexedDbRevision = revision;
    }
    updateGraphPersistenceState({
      ...persistencePatch,
    });
    console.warn(`[ST-BME] ${statusLabel} 图谱快照已拒绝加载`, {
      chatId: normalizedChatId,
      source,
      revision,
      reason: failureReason,
      detail: error?.message || String(error),
      integrityReasons: Array.isArray(error?.reasons) ? error.reasons : [],
    });
    const result = {
      success: false,
      loaded: false,
      reason: failureReason,
      detail: error?.message || String(error),
      integrityReasons: Array.isArray(error?.reasons) ? error.reasons : [],
      chatId: normalizedChatId,
      attemptIndex,
      hydrateDiagnostics: cloneRuntimeDebugValue(hydrateDiagnostics, null),
      nativeHydrateRequested: resolvedNativeHydrateRequested,
      nativeHydrateForceDisabled: resolvedNativeHydrateForceDisabled,
      nativeHydrateGate: cloneRuntimeDebugValue(resolvedNativeHydrateGate, null),
      nativeHydratePreloadStatus: resolvedNativeHydratePreloadStatus,
      nativeHydratePreloadMs: nativeHydratePreloadMs,
      nativeHydratePreloadError: nativeHydratePreloadError,
      nativeHydrateModuleStatus: cloneRuntimeDebugValue(
        nativeHydrateModuleStatus,
        null,
      ),
    };
    recordLoadDiagnostics({
      success: false,
      loaded: false,
      reason: failureReason,
      revision,
      hydrateMs: normalizeLoadDiagnosticsMs(hydrateMs),
      hydrateNodesMs: normalizeLoadDiagnosticsMs(hydrateDiagnostics?.nodesMs),
      hydrateEdgesMs: normalizeLoadDiagnosticsMs(hydrateDiagnostics?.edgesMs),
      hydrateRuntimeMetaMs: normalizeLoadDiagnosticsMs(
        hydrateDiagnostics?.runtimeMetaMs,
      ),
      hydrateStateMs: normalizeLoadDiagnosticsMs(hydrateDiagnostics?.stateMs),
      hydrateNormalizeMs: normalizeLoadDiagnosticsMs(
        hydrateDiagnostics?.normalizeMs,
      ),
      hydrateIntegrityMs: normalizeLoadDiagnosticsMs(
        hydrateDiagnostics?.integrityMs,
      ),
      hydrateNativeRequested: resolvedNativeHydrateRequested,
      hydrateNativeForceDisabled: resolvedNativeHydrateForceDisabled,
      hydrateNativeGateAllowed: resolvedNativeHydrateGate.allowed === true,
      hydrateNativeGateReasons: cloneRuntimeDebugValue(
        resolvedNativeHydrateGate.reasons,
        [],
      ),
      hydrateNativePreloadStatus: resolvedNativeHydratePreloadStatus,
      hydrateNativePreloadMs: normalizeLoadDiagnosticsMs(nativeHydratePreloadMs),
      hydrateNativePreloadError: String(nativeHydratePreloadError || ""),
      hydrateNativeModuleLoaded: Boolean(nativeHydrateModuleStatus?.loaded),
      hydrateNativeModuleSource: String(nativeHydrateModuleStatus?.source || ""),
      hydrateNativeModuleError: String(
        nativeHydrateModuleStatus?.error || nativeHydratePreloadError || "",
      ),
      hydrateNativeUsed: hydrateDiagnostics?.nativeUsed === true,
      hydrateNativeStatus: String(hydrateDiagnostics?.nativeStatus || ""),
      hydrateNativeError: String(hydrateDiagnostics?.nativeError || ""),
      hydrateNativeRecordsMs: normalizeLoadDiagnosticsMs(
        hydrateDiagnostics?.nativeRecordsMs,
      ),
      error: error?.message || String(error),
      integrityReasons: Array.isArray(error?.reasons) ? [...error.reasons] : [],
    });
    return result;
  }
  const applyRuntimeStartedAt = readLoadDiagnosticsNow();
  currentGraph = graphFromSnapshot;
  stampGraphPersistenceMeta(currentGraph, {
    revision,
    reason: `${reasonPrefix}:${String(source || reasonPrefix)}`,
    chatId: normalizedChatId,
    integrity:
      normalizeChatIdCandidate(snapshot?.meta?.integrity) ||
      getChatMetadataIntegrity(getContext()),
  });
  currentGraph.vectorIndexState.lastIntegrityIssue = null;

  extractionCount = Number.isFinite(currentGraph?.historyState?.extractionCount)
    ? currentGraph.historyState.extractionCount
    : 0;
  lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  runtimeStatus = createUiStatus("待命", `已从${statusLabel}加载聊天图谱`, "idle");
  lastExtractionStatus = createUiStatus(
    "待命",
    `已从${statusLabel}加载聊天图谱，等待下一次提取`,
    "idle",
  );
  lastVectorStatus = createUiStatus(
    "待命",
    currentGraph.vectorIndexState?.lastWarning ||
      `已从${statusLabel}加载聊天图谱，等待下一次向量任务`,
    "idle",
  );
  lastRecallStatus = createUiStatus(
    "待命",
    restoredRecallUi.restored
      ? "已从持久化召回记录恢复显示，等待下一次召回"
      : `已从${statusLabel}加载聊天图谱，等待下一次召回`,
    "idle",
  );

  applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, {
    chatId: normalizedChatId,
    reason: `${reasonPrefix}:${source}`,
    attemptIndex,
    revision,
    lastPersistedRevision: Math.max(
      graphPersistenceState.lastPersistedRevision || 0,
      revision,
    ),
    queuedPersistRevision: 0,
    pendingPersist: false,
    shadowSnapshotUsed: false,
    shadowSnapshotRevision: 0,
    shadowSnapshotUpdatedAt: "",
    shadowSnapshotReason: "",
    writesBlocked: false,
  });
  const persistencePatch = {
    storagePrimary,
    storageMode,
    dbReady: true,
    persistMismatchReason: "",
    metadataIntegrity:
      getChatMetadataIntegrity(getContext()) ||
        graphPersistenceState.metadataIntegrity,
    indexedDbLastError: storagePrimary === "indexeddb" ? "" : graphPersistenceState.indexedDbLastError,
    lastAcceptedRevision: Math.max(
      Number(graphPersistenceState.lastAcceptedRevision || 0),
      revision,
    ),
    lastSyncError: "",
    dualWriteLastResult: {
      action: "load",
      source: String(source || reasonPrefix),
      success: true,
      reason: `${reasonPrefix}-loaded`,
      revision,
      at: Date.now(),
    },
  };
  if (storagePrimary === "indexeddb") {
    persistencePatch.indexedDbRevision = revision;
  }
  updateGraphPersistenceState(persistencePatch);
  const shouldPersistPostLoadRepairs = hasGraphPersistDirtyState(currentGraph);
  rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

  if (shouldPersistPostLoadRepairs) {
    const repairedNodeCount = Number(hydrateDiagnostics?.scopeRepairNodeCount) || 0;
    const repairedEdgeCount = Number(hydrateDiagnostics?.scopeRepairEdgeCount) || 0;
    void Promise.resolve().then(() => {
      if (currentGraph !== graphFromSnapshot) {
        return;
      }
      if (
        normalizeChatIdCandidate(currentGraph?.historyState?.chatId) !== normalizedChatId
      ) {
        return;
      }
      debugDebug("[ST-BME] 已检测到加载后作用域自愈，后台写回修复结果", {
        chatId: normalizedChatId,
        repairedNodeCount,
        repairedEdgeCount,
        source,
      });
      saveGraphToChat({
        reason: "scope-auto-repair-after-load",
        markMutation: false,
        immediate: false,
      });
    });
  }

  removeGraphShadowSnapshot(normalizedChatId);
  refreshPanelLiveState();
  schedulePersistedRecallMessageUiRefresh(30);
  debugDebug(`[ST-BME] 已从${statusLabel}加载图谱`, {
    chatId: normalizedChatId,
    source,
    revision,
    ...getGraphStats(currentGraph),
  });

  const result = {
    success: true,
    loaded: true,
    loadState: GRAPH_LOAD_STATES.LOADED,
    reason: `${reasonPrefix}:${source}`,
    chatId: normalizedChatId,
    attemptIndex,
    shadowSnapshotUsed: false,
    revision,
    hydrateDiagnostics: cloneRuntimeDebugValue(hydrateDiagnostics, null),
    nativeHydrateRequested: resolvedNativeHydrateRequested,
    nativeHydrateForceDisabled: resolvedNativeHydrateForceDisabled,
    nativeHydrateGate: cloneRuntimeDebugValue(resolvedNativeHydrateGate, null),
    nativeHydratePreloadStatus: resolvedNativeHydratePreloadStatus,
    nativeHydratePreloadMs: nativeHydratePreloadMs,
    nativeHydratePreloadError: nativeHydratePreloadError,
    nativeHydrateModuleStatus: cloneRuntimeDebugValue(
      nativeHydrateModuleStatus,
      null,
    ),
  };
  recordLoadDiagnostics({
    success: true,
    loaded: true,
    reason: result.reason,
    revision,
    hydrateMs: normalizeLoadDiagnosticsMs(hydrateMs),
    hydrateNodesMs: normalizeLoadDiagnosticsMs(hydrateDiagnostics?.nodesMs),
    hydrateEdgesMs: normalizeLoadDiagnosticsMs(hydrateDiagnostics?.edgesMs),
    hydrateRuntimeMetaMs: normalizeLoadDiagnosticsMs(
      hydrateDiagnostics?.runtimeMetaMs,
    ),
    hydrateStateMs: normalizeLoadDiagnosticsMs(hydrateDiagnostics?.stateMs),
    hydrateNormalizeMs: normalizeLoadDiagnosticsMs(
      hydrateDiagnostics?.normalizeMs,
    ),
    hydrateIntegrityMs: normalizeLoadDiagnosticsMs(
      hydrateDiagnostics?.integrityMs,
    ),
    hydrateNativeRequested: resolvedNativeHydrateRequested,
    hydrateNativeForceDisabled: resolvedNativeHydrateForceDisabled,
    hydrateNativeGateAllowed: resolvedNativeHydrateGate.allowed === true,
    hydrateNativeGateReasons: cloneRuntimeDebugValue(
      resolvedNativeHydrateGate.reasons,
      [],
    ),
    hydrateNativePreloadStatus: resolvedNativeHydratePreloadStatus,
    hydrateNativePreloadMs: normalizeLoadDiagnosticsMs(nativeHydratePreloadMs),
    hydrateNativePreloadError: String(nativeHydratePreloadError || ""),
    hydrateNativeModuleLoaded: Boolean(nativeHydrateModuleStatus?.loaded),
    hydrateNativeModuleSource: String(nativeHydrateModuleStatus?.source || ""),
    hydrateNativeModuleError: String(
      nativeHydrateModuleStatus?.error || nativeHydratePreloadError || "",
    ),
    hydrateNativeUsed: hydrateDiagnostics?.nativeUsed === true,
    hydrateNativeStatus: String(hydrateDiagnostics?.nativeStatus || ""),
    hydrateNativeError: String(hydrateDiagnostics?.nativeError || ""),
    hydrateNativeRecordsMs: normalizeLoadDiagnosticsMs(
      hydrateDiagnostics?.nativeRecordsMs,
    ),
    applyRuntimeMs: normalizeLoadDiagnosticsMs(
      readLoadDiagnosticsNow() - applyRuntimeStartedAt,
    ),
  });
  return result;
}

async function loadGraphFromIndexedDb(
  chatId,
  {
    source = "indexeddb-probe",
    attemptIndex = 0,
    allowOverride = false,
    applyEmptyState = false,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const commitMarker = syncCommitMarkerToPersistenceState(getContext());
  const loadStartedAt = readLoadDiagnosticsNow();
  const recordLoadDiagnostics = (patch = {}) =>
    updateLoadDiagnostics({
      stage: "load-indexeddb",
      source: String(source || "indexeddb-probe"),
      chatId: normalizedChatId || "",
      attemptIndex: Number.isFinite(Number(attemptIndex))
        ? Math.max(0, Math.floor(Number(attemptIndex)))
        : 0,
      ...cloneRuntimeDebugValue(patch, {}),
      totalMs: normalizeLoadDiagnosticsMs(readLoadDiagnosticsNow() - loadStartedAt),
    });
  let exportSnapshotMs = 0;
  let exportProbeMs = 0;
  let preApplyMs = 0;
  let exportSnapshotSource = "";
  const currentSettings = getSettings();
  if (!normalizedChatId) {
    const result = {
      success: false,
      loaded: false,
      reason: "indexeddb-missing-chat-id",
      chatId: "",
      attemptIndex,
    };
    recordLoadDiagnostics({
      success: false,
      loaded: false,
      reason: result.reason,
    });
    return result;
  }

  let localStore = getPreferredGraphLocalStorePresentationSync();
  try {
    const manager = ensureBmeChatManager();
    if (!manager) {
      const result = {
        success: false,
        loaded: false,
        reason: "indexeddb-manager-unavailable",
        chatId: normalizedChatId,
        attemptIndex,
      };
      recordLoadDiagnostics({
        success: false,
        loaded: false,
        reason: result.reason,
        storagePrimary: localStore.storagePrimary,
        storageMode: localStore.storageMode,
      });
      return result;
    }
    const db = await manager.getCurrentDb(normalizedChatId);
    localStore = resolveDbGraphStorePresentation(db);

    const identityRecoveryResult =
      await maybeRecoverIndexedDbGraphFromStableIdentity(
        normalizedChatId,
        getContext(),
        {
          source,
          db,
        },
      );

    if (identityRecoveryResult?.migrated) {
      const recoveredStore = resolveSnapshotGraphStorePresentation(
        identityRecoveryResult?.snapshot,
        localStore,
      );
      const recoveredAuthorityStore =
        isAuthorityGraphStorePresentation(recoveredStore);
      const recoveredRevision = normalizeIndexedDbRevision(
        identityRecoveryResult?.snapshot?.meta?.revision,
      );
      updateGraphPersistenceState({
        storagePrimary: recoveredStore.storagePrimary,
        storageMode: recoveredStore.storageMode,
        resolvedLocalStore: buildGraphLocalStoreSelectorKey(recoveredStore),
        localStoreFormatVersion:
          recoveredStore.storagePrimary === "opfs" ? 2 : 1,
        localStoreMigrationState: "completed",
        authorityMigrationState: recoveredAuthorityStore ? "completed" : graphPersistenceState.authorityMigrationState,
        authorityMigrationSource: recoveredAuthorityStore
          ? String(identityRecoveryResult?.source || "identity-recovery")
          : graphPersistenceState.authorityMigrationSource,
        authorityMigrationRevision: recoveredAuthorityStore
          ? recoveredRevision
          : graphPersistenceState.authorityMigrationRevision,
        authorityMigrationLastError: recoveredAuthorityStore
          ? ""
          : graphPersistenceState.authorityMigrationLastError,
        lastAuthorityMigrationResult: recoveredAuthorityStore
          ? cloneRuntimeDebugValue(identityRecoveryResult, null)
          : graphPersistenceState.lastAuthorityMigrationResult,
        indexedDbRevision: recoveredRevision,
        indexedDbLastError: "",
        lastSyncError: "",
        dualWriteLastResult: {
          action: "identity-recovery",
          source: String(identityRecoveryResult?.source || recoveredStore.reasonPrefix),
          success: true,
          chatId: normalizedChatId,
          legacyChatId: String(identityRecoveryResult?.legacyChatId || ""),
          revision: recoveredRevision,
          reason: String(
            identityRecoveryResult?.reason || "identity-recovery",
          ),
          at: Date.now(),
          syncResult: cloneRuntimeDebugValue(
            identityRecoveryResult?.syncResult,
            null,
          ),
        },
      });
    }

    const opfsMigrationResult = identityRecoveryResult?.migrated
      ? {
          migrated: false,
          reason: "identity-recovery-already-applied",
          chatId: normalizedChatId,
        }
      : await maybeImportLegacyOpfsSnapshotToLocalStore(
          normalizedChatId,
          db,
          {
            source,
          },
        );

    const localStoreMigrationResult =
      identityRecoveryResult?.migrated || opfsMigrationResult?.migrated
        ? {
            migrated: false,
            reason: opfsMigrationResult?.migrated
              ? "opfs-migration-already-applied"
              : "identity-recovery-already-applied",
            chatId: normalizedChatId,
          }
        : await maybeImportLegacyIndexedDbSnapshotToLocalStore(
            normalizedChatId,
            db,
            {
              source,
            },
          );

    const migrationResult =
      identityRecoveryResult?.migrated ||
      opfsMigrationResult?.migrated ||
      localStoreMigrationResult?.migrated ||
      localStoreMigrationResult?.reason === "migration-local-store-failed"
        ? localStoreMigrationResult
        : await maybeMigrateLegacyGraphToIndexedDb(
            normalizedChatId,
            getContext(),
            {
              source,
              db,
            },
        );

    if (migrationResult?.migrated) {
      const migratedStore = resolveSnapshotGraphStorePresentation(
        migrationResult?.snapshot,
        localStore,
      );
      const migratedAuthorityStore =
        isAuthorityGraphStorePresentation(migratedStore);
      const migratedRevision = normalizeIndexedDbRevision(
        migrationResult?.snapshot?.meta?.revision ||
          migrationResult?.migrationResult?.revision,
      );
      updateGraphPersistenceState({
        storagePrimary: migratedStore.storagePrimary,
        storageMode: migratedStore.storageMode,
        resolvedLocalStore: buildGraphLocalStoreSelectorKey(migratedStore),
        localStoreFormatVersion:
          migratedStore.storagePrimary === "opfs" ? 2 : 1,
        localStoreMigrationState: "completed",
        authorityMigrationState: migratedAuthorityStore ? "completed" : graphPersistenceState.authorityMigrationState,
        authorityMigrationSource: migratedAuthorityStore
          ? String(migrationResult?.source || migrationResult?.reason || "")
          : graphPersistenceState.authorityMigrationSource,
        authorityMigrationRevision: migratedAuthorityStore
          ? migratedRevision
          : graphPersistenceState.authorityMigrationRevision,
        authorityMigrationLastError: migratedAuthorityStore
          ? ""
          : graphPersistenceState.authorityMigrationLastError,
        lastAuthorityMigrationResult: migratedAuthorityStore
          ? cloneRuntimeDebugValue(migrationResult, null)
          : graphPersistenceState.lastAuthorityMigrationResult,
        indexedDbRevision: migratedRevision,
        indexedDbLastError: "",
        lastSyncError: "",
        dualWriteLastResult: {
          action: "migration",
          source: String(migrationResult?.source || "chat_metadata"),
          success: true,
          chatId: normalizedChatId,
          revision: migratedRevision,
          reason: migrationResult?.reason || "migration-completed",
          at: Date.now(),
          syncResult: cloneRuntimeDebugValue(migrationResult?.syncResult, null),
        },
      });
    } else if (
      migrationResult?.reason === "migration-failed" ||
      migrationResult?.reason === "migration-local-store-failed"
    ) {
      updateGraphPersistenceState({
        indexedDbLastError: String(
          migrationResult?.error || "migration-failed",
        ),
        localStoreMigrationState: "failed",
        authorityMigrationState:
          localStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND
            ? "failed"
            : graphPersistenceState.authorityMigrationState,
        authorityMigrationLastError:
          localStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND
            ? String(migrationResult?.error || migrationResult?.reason || "migration-failed")
            : graphPersistenceState.authorityMigrationLastError,
        lastAuthorityMigrationResult:
          localStore.storagePrimary === AUTHORITY_GRAPH_STORE_KIND
            ? cloneRuntimeDebugValue(migrationResult, null)
            : graphPersistenceState.lastAuthorityMigrationResult,
        dualWriteLastResult: {
          action: "migration",
          source: "chat_metadata",
          success: false,
          error: String(migrationResult?.error || "migration-failed"),
          at: Date.now(),
        },
      });
    }
    let snapshot = null;
    let inspectionSnapshot = null;
    if (identityRecoveryResult?.snapshot) {
      snapshot = identityRecoveryResult.snapshot;
      inspectionSnapshot = snapshot;
      exportSnapshotSource = "identity-recovery";
    } else if (localStoreMigrationResult?.snapshot) {
      snapshot = localStoreMigrationResult.snapshot;
      inspectionSnapshot = snapshot;
      exportSnapshotSource = "local-store-migration";
    } else if (migrationResult?.snapshot) {
      snapshot = migrationResult.snapshot;
      inspectionSnapshot = snapshot;
      exportSnapshotSource = "legacy-migration";
    } else {
      if (typeof db.exportSnapshotProbe === "function") {
        const probeStartedAt = readLoadDiagnosticsNow();
        inspectionSnapshot = await db.exportSnapshotProbe({ includeTombstones: false });
        exportProbeMs = readLoadDiagnosticsNow() - probeStartedAt;
        exportSnapshotSource = "indexeddb-probe";
      }
      if (!inspectionSnapshot) {
        const exportStartedAt = readLoadDiagnosticsNow();
        snapshot = await db.exportSnapshot({ includeTombstones: false });
        exportSnapshotMs = readLoadDiagnosticsNow() - exportStartedAt;
        inspectionSnapshot = snapshot;
        exportSnapshotSource = "indexeddb-export";
      }
    }
    const shadowSnapshot = resolveCompatibleGraphShadowSnapshot(
      resolveCurrentChatIdentity(getContext()),
    );

    const snapshotStore = resolveSnapshotGraphStorePresentation(
      inspectionSnapshot || snapshot,
      localStore,
    );

    const commitMarkerMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
      inspectionSnapshot,
      commitMarker,
    );
    let commitMarkerDiagnostic = null;
    if (!isIndexedDbSnapshotMeaningful(inspectionSnapshot)) {
      if (commitMarkerMismatch.mismatched) {
        commitMarkerDiagnostic = recordPersistMismatchDiagnostic(
          commitMarkerMismatch,
          {
            source: `${source}:indexeddb-empty`,
          },
        );
        if (
          shadowSnapshot &&
          Number(shadowSnapshot.revision || 0) >=
            Number(commitMarkerMismatch.markerRevision || 0)
        ) {
          const shadowRestoreResult = applyShadowSnapshotToRuntime(
            normalizedChatId,
            shadowSnapshot,
            {
              source: `${source}:shadow-indexeddb-empty`,
              attemptIndex,
            },
          );
          if (shadowRestoreResult?.loaded) {
            updateGraphPersistenceState({
              persistMismatchReason: commitMarkerDiagnostic.reason,
            });
            return shadowRestoreResult;
          }
        }
      }
      if (shadowSnapshot) {
        const shadowRestoreResult = applyShadowSnapshotToRuntime(
          normalizedChatId,
          shadowSnapshot,
          {
            source: `${source}:shadow-indexeddb-empty`,
            attemptIndex,
          },
        );
        if (shadowRestoreResult?.loaded) {
          return shadowRestoreResult;
        }
      }
      if (commitMarkerDiagnostic?.reason) {
        const orphanMarkerResolution =
          await maybeResolveOrphanAcceptedCommitMarker(normalizedChatId, {
            source,
            attemptIndex,
            commitMarker,
            migrationResult,
            shadowSnapshot,
            applyEmptyState,
          });
        if (orphanMarkerResolution?.result) {
          if (
            !orphanMarkerResolution.orphanCleared &&
            orphanMarkerResolution.result?.loaded
          ) {
            updateGraphPersistenceState({
              persistMismatchReason: commitMarkerDiagnostic.reason,
            });
          }
          return orphanMarkerResolution.result;
        }
      }
      const runtimeRepair = queueRuntimeGraphLocalStoreRepair(normalizedChatId, {
        source: `${source}:empty-local-store`,
        scheduleCloudUpload: false,
      });
      if (runtimeRepair.queued) {
        return {
          success: true,
          loaded: false,
          repairQueued: true,
          loadState: GRAPH_LOAD_STATES.LOADING,
          reason: `${snapshotStore.reasonPrefix}-repair-queued`,
          chatId: normalizedChatId,
          attemptIndex,
          revision: Number(runtimeRepair.revision || 0),
        };
      }
      if (
        applyEmptyState &&
        !commitMarkerDiagnostic?.reason &&
        getCurrentChatId() === normalizedChatId
      ) {
        return applyIndexedDbEmptyToRuntime(normalizedChatId, {
          source,
          attemptIndex,
        });
      }
      return {
        success: false,
        loaded: false,
        reason: commitMarkerDiagnostic?.reason || `${snapshotStore.reasonPrefix}-empty`,
        chatId: normalizedChatId,
        attemptIndex,
      };
    }

    const snapshotRevision = normalizeIndexedDbRevision(
      inspectionSnapshot?.meta?.revision,
    );
    const snapshotIntegrity = String(inspectionSnapshot?.meta?.integrity || "").trim();
    const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
      createShadowComparisonGraph({
        chatId: normalizedChatId,
        revision: snapshotRevision,
        integrity: snapshotIntegrity,
      }),
      shadowSnapshot,
    );
    if (shadowSnapshot && shadowDecision?.reason) {
      updateGraphPersistenceState({
        dualWriteLastResult: {
          action: "shadow-compare",
          source: `${source}:indexeddb-shadow-compare`,
          success: Boolean(shadowDecision.prefer),
          reason: shadowDecision.reason,
          resultCode: String(shadowDecision.resultCode || ""),
          shadowRevision: Number(shadowSnapshot.revision || 0),
          officialRevision: snapshotRevision,
          at: Date.now(),
        },
      });
    }
    if (shadowSnapshot && shadowDecision?.prefer) {
      return applyShadowSnapshotToRuntime(
        normalizedChatId,
        shadowSnapshot,
        {
          source: `${source}:shadow-newer-than-indexeddb`,
          attemptIndex,
        },
      );
    }
    if (commitMarkerMismatch.mismatched) {
      commitMarkerDiagnostic = recordPersistMismatchDiagnostic(
        {
          ...commitMarkerMismatch,
          marker: commitMarkerMismatch.marker || commitMarker,
        },
        {
          source: `${source}:indexeddb-commit-marker`,
        },
      );
      if (
        shadowSnapshot &&
        Number(shadowSnapshot.revision || 0) >=
          Number(commitMarkerMismatch.markerRevision || 0)
      ) {
        const shadowResult = applyShadowSnapshotToRuntime(
          normalizedChatId,
          shadowSnapshot,
          {
            source: `${source}:shadow-beats-commit-marker`,
            attemptIndex,
          },
        );
        if (shadowResult?.loaded && commitMarkerDiagnostic?.reason) {
          updateGraphPersistenceState({
            persistMismatchReason: commitMarkerDiagnostic.reason,
          });
        }
        return shadowResult;
      }
    }
    const shouldAllowOverride =
      allowOverride ||
      BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(
        graphPersistenceState.loadState,
      ) ||
      graphPersistenceState.storagePrimary === snapshotStore.storagePrimary ||
      snapshotRevision >=
        normalizeIndexedDbRevision(graphPersistenceState.revision);

    if (!shouldAllowOverride) {
      return {
        success: false,
        loaded: false,
        reason: `${snapshotStore.reasonPrefix}-stale`,
        chatId: normalizedChatId,
        attemptIndex,
        revision: snapshotRevision,
      };
    }

    if (getCurrentChatId() !== normalizedChatId) {
      return {
        success: false,
        loaded: false,
        reason: `${snapshotStore.reasonPrefix}-chat-switched`,
        chatId: normalizedChatId,
        attemptIndex,
        revision: snapshotRevision,
      };
    }

    const staleDecision = detectStaleIndexedDbSnapshotAgainstRuntime(
      normalizedChatId,
      inspectionSnapshot,
    );
    if (staleDecision.stale) {
      const result = {
        success: false,
        loaded: false,
        reason: `${snapshotStore.reasonPrefix}-stale-runtime`,
        chatId: normalizedChatId,
        attemptIndex,
        revision: snapshotRevision,
        staleDetail: cloneRuntimeDebugValue(staleDecision, null),
      };
      updateGraphPersistenceState({
        storagePrimary: snapshotStore.storagePrimary,
        storageMode: snapshotStore.storageMode,
        indexedDbLastError: "",
        dualWriteLastResult: {
          action: "load",
          source: String(source || snapshotStore.reasonPrefix),
          success: false,
          rejected: true,
          reason: result.reason,
          revision: snapshotRevision,
          staleDetail: cloneRuntimeDebugValue(staleDecision, null),
          at: Date.now(),
        },
      });
      recordLoadDiagnostics({
        success: false,
        loaded: false,
        reason: result.reason,
        revision: snapshotRevision,
        storagePrimary: snapshotStore.storagePrimary,
        storageMode: snapshotStore.storageMode,
        exportSnapshotSource: exportSnapshotSource || "snapshot-probe",
        exportProbeMs: normalizeLoadDiagnosticsMs(exportProbeMs),
        exportSnapshotMs: normalizeLoadDiagnosticsMs(exportSnapshotMs),
        preApplyMs: normalizeLoadDiagnosticsMs(readLoadDiagnosticsNow() - loadStartedAt),
        preApplyOtherMs: normalizeLoadDiagnosticsMs(
          Math.max(
            0,
            readLoadDiagnosticsNow() - loadStartedAt - exportSnapshotMs - exportProbeMs,
          ),
        ),
        staleDetail: cloneRuntimeDebugValue(staleDecision, null),
      });
      return result;
    }

    if (!snapshot) {
      const exportStartedAt = readLoadDiagnosticsNow();
      snapshot = await db.exportSnapshot({ includeTombstones: false });
      exportSnapshotMs += readLoadDiagnosticsNow() - exportStartedAt;
      exportSnapshotSource =
        exportSnapshotSource === "indexeddb-probe"
          ? "indexeddb-probe+indexeddb-export"
          : exportSnapshotSource || "indexeddb-export";
    }
    cacheIndexedDbSnapshot(normalizedChatId, snapshot);

    const nativeHydrateRequested = currentSettings.loadUseNativeHydrate === true;
    const nativeHydrateForceDisabled =
      currentSettings.graphNativeForceDisable === true;
    const nativeHydrateGate = evaluateNativeHydrateGate(snapshot, currentSettings);
    const shouldUseNativeHydrate =
      nativeHydrateRequested &&
      nativeHydrateForceDisabled !== true &&
      nativeHydrateGate.allowed;
    let nativeHydrateModuleStatus = null;
    let nativeHydratePreloadStatus = nativeHydrateRequested
      ? nativeHydrateForceDisabled
        ? "force-disabled"
        : nativeHydrateGate.allowed
          ? "pending"
          : "gated-out"
      : "not-requested";
    let nativeHydratePreloadError = "";
    let nativeHydratePreloadMs = 0;
    if (shouldUseNativeHydrate) {
      const preloadStartedAt = readLoadDiagnosticsNow();
      try {
        if (!nativeHydrateInstallPromise) {
          nativeHydrateInstallPromise = import("./vendor/wasm/stbme_core.js")
            .then((module) => module?.installNativeHydrateHook?.())
            .catch((error) => {
              nativeHydrateInstallPromise = null;
              throw error;
            });
        }
        nativeHydrateModuleStatus = await nativeHydrateInstallPromise;
        nativeHydratePreloadStatus = nativeHydrateModuleStatus?.loaded
          ? "loaded"
          : "not-loaded";
        nativeHydratePreloadMs =
          readLoadDiagnosticsNow() - preloadStartedAt;
      } catch (error) {
        nativeHydratePreloadStatus = "failed";
        nativeHydratePreloadMs =
          readLoadDiagnosticsNow() - preloadStartedAt;
        nativeHydratePreloadError = error?.message || String(error);
        if (currentSettings.nativeEngineFailOpen !== false) {
          console.warn(
            "[ST-BME] native hydrate preload failed, fallback to JS hydrate:",
            error,
          );
        } else {
          throw error;
        }
      }
    }

    preApplyMs = readLoadDiagnosticsNow() - loadStartedAt;
    const applyInvokeStartedAt = readLoadDiagnosticsNow();
    const loadResult = applyIndexedDbSnapshotToRuntime(normalizedChatId, snapshot, {
      source,
      attemptIndex,
      storagePrimary: snapshotStore.storagePrimary,
      storageMode: snapshotStore.storageMode,
      statusLabel: snapshotStore.statusLabel,
      reasonPrefix: snapshotStore.reasonPrefix,
      currentSettings,
      nativeHydrateRequested,
      nativeHydrateForceDisabled,
      nativeHydrateGate,
      nativeHydratePreloadStatus,
      nativeHydratePreloadMs,
      nativeHydratePreloadError,
      nativeHydrateModuleStatus,
    });
    const applyInvokeMs = readLoadDiagnosticsNow() - applyInvokeStartedAt;
    const totalLoadMs = readLoadDiagnosticsNow() - loadStartedAt;
    const loadAccountedMs = preApplyMs + applyInvokeMs;
    if (commitMarkerDiagnostic?.reason && loadResult?.loaded) {
      updateGraphPersistenceState({
        persistMismatchReason: commitMarkerDiagnostic.reason,
      });
    }
    recordLoadDiagnostics({
      success: loadResult?.success === true,
      loaded: loadResult?.loaded === true,
      reason: String(loadResult?.reason || ""),
      revision: Number.isFinite(Number(loadResult?.revision))
        ? Number(loadResult.revision)
        : snapshotRevision,
      storagePrimary: snapshotStore.storagePrimary,
      storageMode: snapshotStore.storageMode,
      commitMarkerMismatched: commitMarkerMismatch.mismatched === true,
      exportSnapshotSource: exportSnapshotSource || "snapshot-prepared",
      exportProbeMs: normalizeLoadDiagnosticsMs(exportProbeMs),
      exportSnapshotMs: normalizeLoadDiagnosticsMs(exportSnapshotMs),
      preApplyMs: normalizeLoadDiagnosticsMs(preApplyMs),
      preApplyOtherMs: normalizeLoadDiagnosticsMs(
        Math.max(0, preApplyMs - exportSnapshotMs - exportProbeMs),
      ),
      hydrateNativeRequested: loadResult?.nativeHydrateRequested === true,
      hydrateNativeForceDisabled: loadResult?.nativeHydrateForceDisabled === true,
      hydrateNativeGateAllowed: loadResult?.nativeHydrateGate?.allowed === true,
      hydrateNativeGateReasons: cloneRuntimeDebugValue(
        loadResult?.nativeHydrateGate?.reasons,
        [],
      ),
      hydrateNativePreloadStatus: String(
        loadResult?.nativeHydratePreloadStatus || nativeHydratePreloadStatus || "",
      ),
      hydrateNativePreloadMs: normalizeLoadDiagnosticsMs(
        loadResult?.nativeHydratePreloadMs,
      ),
      hydrateNativePreloadError: String(
        loadResult?.nativeHydratePreloadError || "",
      ),
      hydrateNativeModuleLoaded: Boolean(
        loadResult?.nativeHydrateModuleStatus?.loaded,
      ),
      hydrateNativeModuleSource: String(
        loadResult?.nativeHydrateModuleStatus?.source || "",
      ),
      hydrateNativeModuleError: String(
        loadResult?.nativeHydrateModuleStatus?.error || "",
      ),
      hydrateNativeUsed: loadResult?.hydrateDiagnostics?.nativeUsed === true,
      hydrateNativeStatus: String(
        loadResult?.hydrateDiagnostics?.nativeStatus || "",
      ),
      hydrateNativeError: String(loadResult?.hydrateDiagnostics?.nativeError || ""),
      hydrateNativeRecordsMs: normalizeLoadDiagnosticsMs(
        loadResult?.hydrateDiagnostics?.nativeRecordsMs,
      ),
      applyInvokeMs: normalizeLoadDiagnosticsMs(applyInvokeMs),
      untrackedMs: normalizeLoadDiagnosticsMs(
        Math.max(0, totalLoadMs - loadAccountedMs),
      ),
    });
    return loadResult;
  } catch (error) {
    console.warn(`[ST-BME] ${localStore.statusLabel} 读取失败，回退 metadata:`, error);
    updateGraphPersistenceState({
      storagePrimary: localStore.storagePrimary,
      storageMode: localStore.storageMode,
      indexedDbLastError: error?.message || String(error),
      dualWriteLastResult: {
        action: "load",
        source: String(source || localStore.reasonPrefix),
        success: false,
        error: error?.message || String(error),
        at: Date.now(),
      },
    });
    const result = {
      success: false,
      loaded: false,
      reason: `${localStore.reasonPrefix}-read-failed`,
      chatId: normalizedChatId,
      attemptIndex,
      error,
    };
    recordLoadDiagnostics({
      success: false,
      loaded: false,
      reason: result.reason,
      storagePrimary: localStore.storagePrimary,
      storageMode: localStore.storageMode,
      error: error?.message || String(error),
      exportSnapshotSource: exportSnapshotSource || "unknown",
      exportProbeMs: normalizeLoadDiagnosticsMs(exportProbeMs),
      exportSnapshotMs: normalizeLoadDiagnosticsMs(exportSnapshotMs),
      preApplyMs: normalizeLoadDiagnosticsMs(
        preApplyMs || (readLoadDiagnosticsNow() - loadStartedAt),
      ),
      preApplyOtherMs: normalizeLoadDiagnosticsMs(
        Math.max(
          0,
          (preApplyMs || (readLoadDiagnosticsNow() - loadStartedAt)) -
            exportSnapshotMs -
            exportProbeMs,
        ),
      ),
    });
    return result;
  }
}

function scheduleIndexedDbGraphProbe(chatId, options = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const attemptIndex = Math.max(0, Math.floor(Number(options?.attemptIndex) || 0));
  if (
    !normalizedChatId ||
    bmeIndexedDbLoadInFlightByChatId.has(normalizedChatId)
  ) {
    return;
  }

  scheduleBmeIndexedDbTask(() => {
    const loadPromise = loadGraphFromIndexedDb(normalizedChatId, options)
      .then((result) =>
        reconcileIndexedDbProbeFailureState(normalizedChatId, result, {
          attemptIndex,
        }),
      )
      .catch((error) => {
        console.warn("[ST-BME] IndexedDB 后台加载失败:", error);
        return reconcileIndexedDbProbeFailureState(
          normalizedChatId,
          {
            success: false,
            loaded: false,
            reason: "indexeddb-read-failed",
            chatId: normalizedChatId,
            attemptIndex,
            error,
          },
          {
            attemptIndex,
          },
        );
      })
      .finally(() => {
        if (
          bmeIndexedDbLoadInFlightByChatId.get(normalizedChatId) === loadPromise
        ) {
          bmeIndexedDbLoadInFlightByChatId.delete(normalizedChatId);
        }
      });

    bmeIndexedDbLoadInFlightByChatId.set(normalizedChatId, loadPromise);
    return loadPromise;
  });
}

function resolveInjectionPromptType(settings = {}) {
  const normalized = String(settings?.injectPosition || "atDepth")
    .trim()
    .toLowerCase();

  switch (normalized) {
    case "none":
      return extension_prompt_types.NONE;
    case "beforeprompt":
    case "before_prompt":
    case "before-prompt":
      return extension_prompt_types.BEFORE_PROMPT;
    case "inprompt":
    case "in_prompt":
    case "in-prompt":
      return extension_prompt_types.IN_PROMPT;
    case "atdepth":
    case "at_depth":
    case "inchat":
    case "in_chat":
    case "chat":
    default:
      return extension_prompt_types.IN_CHAT;
  }
}

function resolveInjectionPromptRole(settings = {}) {
  switch (Number(settings?.injectRole)) {
    case 1:
      return extension_prompt_roles.USER;
    case 2:
      return extension_prompt_roles.ASSISTANT;
    default:
      return extension_prompt_roles.SYSTEM;
  }
}

function applyModuleInjectionPrompt(content = "", settings = getSettings()) {
  const position = resolveInjectionPromptType(settings);
  const depth =
    position === extension_prompt_types.IN_CHAT
      ? clampInt(settings?.injectDepth, 9999, 0, 9999)
      : 0;
  const role = resolveInjectionPromptRole(settings);
  const adapter = getHostAdapter?.();
  const injectionHost = adapter?.injection;

  if (
    typeof injectionHost?.setExtensionPrompt === "function" &&
    injectionHost.setExtensionPrompt(
      MODULE_NAME,
      content,
      position,
      depth,
      false,
      role,
    )
  ) {
    return {
      applied: true,
      source: "host-adapter",
      mode: injectionHost.readInjectionSupport?.()?.mode || "",
      position,
      depth,
      role,
    };
  }

  const context = getContext();
  if (typeof context?.setExtensionPrompt === "function") {
    context.setExtensionPrompt(
      MODULE_NAME,
      content,
      position,
      depth,
      false,
      role,
    );
    return {
      applied: true,
      source: "context",
      mode: "legacy-context-setter",
      position,
      depth,
      role,
    };
  }

  return {
    applied: false,
    source: "unavailable",
    mode: "unavailable",
    position,
    depth,
    role,
  };
}

function ensureCurrentGraphRuntimeState() {
  if (!currentGraph) {
    currentGraph = createEmptyGraph();
  }

  currentGraph = normalizeGraphRuntimeState(currentGraph, getCurrentChatId());
  return currentGraph;
}

function clearPendingGraphLoadRetry({ resetChatId = true } = {}) {
  if (pendingGraphLoadRetryTimer) {
    clearTimeout(pendingGraphLoadRetryTimer);
    pendingGraphLoadRetryTimer = null;
  }

  if (resetChatId) {
    pendingGraphLoadRetryChatId = "";
  }
}

function isGraphLoadRetryPending(chatId = getCurrentChatId()) {
  const normalizedChatId = String(chatId || "");
  return (
    Boolean(normalizedChatId) &&
    pendingGraphLoadRetryChatId === normalizedChatId
  );
}

function clearPendingAutoExtraction({ resetState = true } = {}) {
  if (pendingAutoExtractionTimer) {
    clearTimeout(pendingAutoExtractionTimer);
    pendingAutoExtractionTimer = null;
  }

  if (resetState) {
    pendingAutoExtraction = {
      chatId: "",
      messageId: null,
      reason: "",
      requestedAt: 0,
      attempts: 0,
      targetEndFloor: null,
      strategy: "normal",
    };
  }
}

function deferAutoExtraction(
  reason = "auto-extraction-deferred",
  {
    chatId = getCurrentChatId(),
    messageId = null,
    delayMs = null,
    targetEndFloor = null,
    strategy = "",
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    clearPendingAutoExtraction();
    return {
      scheduled: false,
      reason: "missing-chat-id",
      chatId: "",
    };
  }

  const sameChat = normalizedChatId === pendingAutoExtraction.chatId;
  const previousAttempts = sameChat
    ? Math.max(0, Math.floor(Number(pendingAutoExtraction.attempts) || 0))
    : 0;
  const nextAttempts = previousAttempts + 1;
  const resolvedDelayMs =
    delayMs !== null &&
    delayMs !== undefined &&
    Number.isFinite(Number(delayMs))
    ? Math.max(0, Math.floor(Number(delayMs)))
    : AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS[
        Math.min(
          previousAttempts,
          AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS.length - 1,
        )
      ];

  pendingAutoExtraction = {
    chatId: normalizedChatId,
    messageId: Number.isFinite(Number(messageId))
      ? Math.floor(Number(messageId))
      : sameChat
        ? pendingAutoExtraction.messageId
        : null,
    reason: String(reason || "auto-extraction-deferred"),
    requestedAt:
      sameChat && pendingAutoExtraction.requestedAt > 0
        ? pendingAutoExtraction.requestedAt
        : Date.now(),
    attempts: nextAttempts,
    targetEndFloor: Number.isFinite(Number(targetEndFloor))
      ? sameChat &&
        Number.isFinite(Number(pendingAutoExtraction.targetEndFloor))
        ? Math.max(
            Math.floor(Number(targetEndFloor)),
            Math.floor(Number(pendingAutoExtraction.targetEndFloor)),
          )
        : Math.floor(Number(targetEndFloor))
      : sameChat
        ? pendingAutoExtraction.targetEndFloor
        : null,
    strategy: String(strategy || "")
      ? String(strategy || "")
      : sameChat
        ? String(pendingAutoExtraction.strategy || "normal")
        : "normal",
  };

  if (pendingAutoExtractionTimer) {
    clearTimeout(pendingAutoExtractionTimer);
  }

  pendingAutoExtractionTimer = setTimeout(() => {
    pendingAutoExtractionTimer = null;
    void maybeResumePendingAutoExtraction(
      `retry:${pendingAutoExtraction.reason || "auto-extraction-deferred"}`,
    );
  }, resolvedDelayMs);
  console.debug?.("[ST-BME] auto extraction deferred", {
    reason: pendingAutoExtraction.reason,
    chatId: normalizedChatId,
    messageId: pendingAutoExtraction.messageId,
    targetEndFloor: pendingAutoExtraction.targetEndFloor,
    strategy: pendingAutoExtraction.strategy,
    attempts: nextAttempts,
    delayMs: resolvedDelayMs,
  });

  return {
    scheduled: true,
    chatId: normalizedChatId,
    messageId: pendingAutoExtraction.messageId,
    reason: pendingAutoExtraction.reason,
    targetEndFloor: pendingAutoExtraction.targetEndFloor,
    strategy: pendingAutoExtraction.strategy,
    attempts: nextAttempts,
    delayMs: resolvedDelayMs,
  };
}

function resolveAutoExtractionPlan({
  chat = null,
  settings = null,
  lastProcessedAssistantFloor = null,
  lockedEndFloor = null,
} = {}) {
  return resolveAutoExtractionPlanController(
    {
      getAssistantTurns,
      getSmartTriggerDecision,
    },
    {
      chat,
      settings,
      lastProcessedAssistantFloor:
        Number.isFinite(Number(lastProcessedAssistantFloor))
          ? Math.floor(Number(lastProcessedAssistantFloor))
          : getLastProcessedAssistantFloor(),
      lockedEndFloor,
    },
  );
}

function maybeResumePendingAutoExtraction(source = "auto-extraction-resume") {
  const pendingChatId = normalizeChatIdCandidate(pendingAutoExtraction.chatId);
  if (!pendingChatId) {
    return {
      resumed: false,
      reason: "no-pending-auto-extraction",
    };
  }

  if (isRestoreLockActive()) {
    return {
      resumed: false,
      reason: "restore-lock-active",
      restoreLock: cloneRuntimeDebugValue(
        normalizeRestoreLockState(graphPersistenceState.restoreLock),
        null,
      ),
    };
  }

  const currentChatId = normalizeChatIdCandidate(getCurrentChatId());
  if (!currentChatId || currentChatId !== pendingChatId) {
    clearPendingAutoExtraction();
    return {
      resumed: false,
      reason: "chat-switched",
      chatId: pendingChatId,
      currentChatId,
    };
  }

  if (isExtracting) {
    return deferAutoExtraction("extracting", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  if (isHostGenerationRunning) {
    return deferAutoExtraction("generation-running", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  const hostGenerationSettleRemainingMs =
    lastHostGenerationEndedAt > 0
      ? AUTO_EXTRACTION_HOST_SETTLE_MS -
        (Date.now() - lastHostGenerationEndedAt)
      : 0;
  if (hostGenerationSettleRemainingMs > 0) {
    return deferAutoExtraction("generation-settling", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      delayMs: hostGenerationSettleRemainingMs,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  if (isRecoveringHistory) {
    return deferAutoExtraction("history-recovering", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  if (!ensureGraphMutationReady("自动提取", { notify: false })) {
    console.debug?.(
      "[ST-BME] pending auto extraction resume blocked: graph-not-ready",
      {
        source,
        chatId: pendingChatId,
        attempts: pendingAutoExtraction.attempts || 0,
        loadState: graphPersistenceState.loadState || "",
      },
    );
    return deferAutoExtraction("graph-not-ready", {
      chatId: pendingChatId,
      messageId: pendingAutoExtraction.messageId,
      targetEndFloor: pendingAutoExtraction.targetEndFloor,
      strategy: pendingAutoExtraction.strategy,
    });
  }

  const resumeContext = getContext();
  const resumeChat = resumeContext?.chat;
  const settings = getSettings();
  let lockedEndFloor = Number.isFinite(Number(pendingAutoExtraction.targetEndFloor))
    ? Math.floor(Number(pendingAutoExtraction.targetEndFloor))
    : null;
  if (
    Array.isArray(resumeChat) &&
    Number.isFinite(Number(pendingAutoExtraction.messageId))
  ) {
    const pendingMessageIndex = Math.floor(
      Number(pendingAutoExtraction.messageId),
    );
    const pendingMessage = resumeChat[pendingMessageIndex];
    if (
      isAssistantChatMessage(pendingMessage, {
        index: pendingMessageIndex,
        chat: resumeChat,
      }) &&
      !String(pendingMessage?.mes ?? "").trim()
    ) {
      return deferAutoExtraction("assistant-message-empty", {
        chatId: pendingChatId,
        messageId: pendingMessageIndex,
        delayMs: AUTO_EXTRACTION_HOST_SETTLE_MS,
        targetEndFloor: pendingAutoExtraction.targetEndFloor,
        strategy: pendingAutoExtraction.strategy,
      });
    }
  }

  if (Array.isArray(resumeChat) && resumeChat.length > 0 && lockedEndFloor != null) {
    const lockedPlan = resolveAutoExtractionPlan({
      chat: resumeChat,
      settings,
      lockedEndFloor,
    });
    if (
      !lockedPlan.canRun &&
      lockedPlan.candidateAssistantTurns.length === 0
    ) {
      const fallbackPlan = resolveAutoExtractionPlan({
        chat: resumeChat,
        settings,
      });
      lockedEndFloor = fallbackPlan.canRun
        ? fallbackPlan.plannedBatchEndFloor
        : null;
    }
  }

  const pendingRequest = { ...pendingAutoExtraction };
  clearPendingAutoExtraction();
  if (lockedEndFloor == null) {
    const currentPlan = resolveAutoExtractionPlan({
      chat: resumeChat,
      settings,
    });
    if (!currentPlan.canRun) {
      return {
        resumed: false,
        reason: "no-runnable-auto-extraction",
        source,
        ...pendingRequest,
      };
    }
    lockedEndFloor = currentPlan.plannedBatchEndFloor;
  }
  console.debug?.("[ST-BME] resuming pending auto extraction", {
    source,
    chatId: pendingRequest.chatId,
    messageId: pendingRequest.messageId,
    targetEndFloor: lockedEndFloor,
    attempts: pendingRequest.attempts || 0,
  });
  const enqueueMicrotask =
    typeof globalThis.queueMicrotask === "function"
      ? globalThis.queueMicrotask.bind(globalThis)
      : (task) => Promise.resolve().then(task);
  enqueueMicrotask(() => {
    void runExtraction({
      lockedEndFloor,
      triggerSource: source,
    }).catch((error) => {
      console.error("[ST-BME] 延迟自动提取失败:", error);
      notifyExtractionIssue(error?.message || String(error) || "自动提取失败");
    });
  });

  return {
    resumed: true,
    source,
    lockedEndFloor,
    ...pendingRequest,
  };
}

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

function readMvuExtraAnalysisFlag() {
  try {
    const sameFrameMvu = globalThis?.window?.Mvu;
    if (typeof sameFrameMvu?.isDuringExtraAnalysis === "function") {
      return Boolean(sameFrameMvu.isDuringExtraAnalysis());
    }
  } catch {}

  try {
    const parentMvu = globalThis?.window?.parent?.Mvu;
    if (typeof parentMvu?.isDuringExtraAnalysis === "function") {
      return Boolean(parentMvu.isDuringExtraAnalysis());
    }
  } catch {}

  try {
    const getActivePinia =
      globalThis?.window?.getActivePinia ??
      globalThis?.window?.parent?.getActivePinia;
    if (typeof getActivePinia === "function") {
      const pinia = getActivePinia();
      return Boolean(
        pinia?.state?.value?.["MVU变量框架"]?.runtimes?.is_during_extra_analysis,
      );
    }
  } catch {}

  return false;
}

function isMvuExtraAnalysisGuardActive(now = Date.now()) {
  if (readMvuExtraAnalysisFlag()) {
    mvuExtraAnalysisGuardUntil = Math.max(
      mvuExtraAnalysisGuardUntil,
      now + MVU_EXTRA_ANALYSIS_GUARD_TTL_MS,
    );
  }

  if (mvuExtraAnalysisGuardUntil <= now) {
    if (mvuExtraAnalysisGuardUntil !== 0) {
      mvuExtraAnalysisGuardUntil = 0;
    }
    return false;
  }

  return true;
}

function isTavernHelperPromptViewerRefreshActive() {
  try {
    const doc = globalThis?.document;
    if (!doc?.querySelectorAll) return false;

    const dialogs = Array.from(doc.querySelectorAll('[role="dialog"]'));
    for (const dialog of dialogs) {
      const dialogText = String(dialog?.textContent || "");
      if (!/(提示词查看器|prompt\s*viewer)/i.test(dialogText)) {
        continue;
      }

      if (dialog.querySelector(".fa-rotate-right.animate-spin")) {
        return true;
      }
    }
  } catch {}

  return false;
}

function isGraphEffectivelyEmpty(graph) {
  if (!graph || typeof graph !== "object") {
    return true;
  }

  const stats = getGraphStats(graph);
  if ((stats.totalNodes || 0) > 0 || (stats.totalEdges || 0) > 0) {
    return false;
  }
  if (Number.isFinite(stats.lastProcessedSeq) && stats.lastProcessedSeq >= 0) {
    return false;
  }
  if (Array.isArray(graph.batchJournal) && graph.batchJournal.length > 0) {
    return false;
  }
  if (
    graph.lastRecallResult &&
    (!Array.isArray(graph.lastRecallResult) ||
      graph.lastRecallResult.length > 0)
  ) {
    return false;
  }
  if (
    Object.keys(graph?.historyState?.processedMessageHashes || {}).length > 0
  ) {
    return false;
  }
  if (Object.keys(graph?.vectorIndexState?.hashToNodeId || {}).length > 0) {
    return false;
  }

  return true;
}

function buildGraphPersistResult({
  saved = false,
  queued = false,
  blocked = false,
  accepted = false,
  recoverable = false,
  storageTier = "none",
  acceptedBy = "none",
  primaryTier = graphPersistenceState.primaryStorageTier,
  cacheTier = graphPersistenceState.cacheStorageTier,
  cacheMirrored = false,
  diagnosticTier = graphPersistenceState.persistDiagnosticTier,
  reason = "",
  loadState = graphPersistenceState.loadState,
  revision = graphPersistenceState.revision,
  saveMode = graphPersistenceState.lastPersistMode,
  manifestRevision = graphPersistenceState.lukerManifestRevision || 0,
  journalDepth = graphPersistenceState.lukerJournalDepth || 0,
  checkpointRevision = graphPersistenceState.lukerCheckpointRevision || 0,
  cacheLag = graphPersistenceState.cacheLag || 0,
} = {}) {
  return {
    saved,
    queued,
    blocked,
    accepted,
    recoverable,
    storageTier: String(storageTier || "none"),
    acceptedBy: String(acceptedBy || "none"),
    primaryTier: String(primaryTier || "none"),
    cacheTier: String(cacheTier || "none"),
    cacheMirrored: cacheMirrored === true,
    diagnosticTier: String(diagnosticTier || "none"),
    reason: String(reason || ""),
    loadState,
    revision: Number.isFinite(revision) ? revision : 0,
    saveMode: String(saveMode || ""),
    manifestRevision: Number.isFinite(manifestRevision) ? manifestRevision : 0,
    journalDepth: Number.isFinite(journalDepth) ? journalDepth : 0,
    checkpointRevision: Number.isFinite(checkpointRevision)
      ? checkpointRevision
      : 0,
    cacheLag: Number.isFinite(cacheLag) ? cacheLag : 0,
  };
}

function maybeCaptureGraphShadowSnapshot(
  reason = "runtime-shadow",
  {
    graph = currentGraph,
    chatId = graphPersistenceState.chatId || getCurrentChatId(),
    revision = graphPersistenceState.revision,
  } = {},
) {
  if (!chatId || !graph) return false;
  const hasMeaningfulGraphData =
    !isGraphEffectivelyEmpty(graph) ||
    graphPersistenceState.shadowSnapshotUsed ||
    graphPersistenceState.lastPersistedRevision > 0;
  if (!hasMeaningfulGraphData) return false;
  return writeGraphShadowSnapshot(chatId, graph, {
    revision,
    reason,
  });
}

function clearPendingGraphPersistRetry({ resetChatId = true } = {}) {
  if (pendingGraphPersistRetryTimer) {
    clearTimeout(pendingGraphPersistRetryTimer);
    pendingGraphPersistRetryTimer = null;
  }
  pendingGraphPersistRetryAttempt = 0;
  if (resetChatId) {
    pendingGraphPersistRetryChatId = "";
  }
}

function canPersistGraphToMetadataFallback(
  context = getContext(),
  graph = currentGraph,
) {
  if (isGraphMetadataWriteAllowed()) {
    return true;
  }

  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  if (!context || !graph || !activeChatId) {
    return false;
  }

  const identity = resolveCurrentChatIdentity(context);
  const runtimeGraphChatId = normalizeChatIdCandidate(
    graph?.historyState?.chatId,
  );
  const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
  const sameRuntimeChat =
    !runtimeGraphChatId ||
    areChatIdsEquivalentForResolvedIdentity(
      runtimeGraphChatId,
      activeChatId,
      identity,
    ) ||
    areChatIdsEquivalentForResolvedIdentity(
      activeChatId,
      runtimeGraphChatId,
      identity,
    );
  const sameStateChat =
    !stateChatId ||
    areChatIdsEquivalentForResolvedIdentity(
      stateChatId,
      activeChatId,
      identity,
    ) ||
    areChatIdsEquivalentForResolvedIdentity(
      activeChatId,
      stateChatId,
      identity,
    );

  return (
    graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT &&
    sameRuntimeChat &&
    sameStateChat &&
    typeof graph === "object" &&
    graph !== null
  );
}

function buildBatchPersistenceRecordFromPersistResult(persistResult = null) {
  const accepted = persistResult?.accepted === true;
  const queued = persistResult?.queued === true;
  const blocked = persistResult?.blocked === true;
  const recoverable = persistResult?.recoverable === true;
  let outcome = "failed";

  if (
    accepted &&
    ["indexeddb", "opfs", "luker-chat-state"].includes(
      String(persistResult?.storageTier || ""),
    )
  ) {
    outcome = "saved";
  } else if (accepted) {
    outcome = "fallback";
  } else if (queued) {
    outcome = "queued";
  } else if (recoverable) {
    outcome = "recoverable";
  } else if (blocked) {
    outcome = "blocked";
  }

  return {
    outcome,
    accepted,
    recoverable,
    storageTier: String(persistResult?.storageTier || "none"),
    reason: String(persistResult?.reason || ""),
    revision: Number.isFinite(Number(persistResult?.revision))
      ? Number(persistResult.revision)
      : 0,
    saveMode: String(persistResult?.saveMode || ""),
    saved: persistResult?.saved === true,
    queued,
    blocked,
  };
}

async function persistGraphToConfiguredDurableTier(
  context,
  graph,
  {
    chatId,
    revision,
    reason,
    lastProcessedAssistantFloor = null,
    persistDelta = null,
    graphSnapshot = null,
    persistSnapshot = null,
    chatStateTarget = null,
    graphDetached = false,
  } = {},
) {
  const preferredLocalStore = getPreferredGraphLocalStorePresentationSync();
  const persistenceEnvironment = buildPersistenceEnvironment(
    context,
    preferredLocalStore,
  );
  const localStoreTier = resolveLocalStoreTierFromPresentation(preferredLocalStore);

  if (
    persistenceEnvironment.hostProfile === "luker" &&
    canUseHostGraphChatStatePersistence(context)
  ) {
    const chatStateResult = await persistGraphToHostChatState(context, {
      graph,
      chatId,
      revision,
      reason,
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      mode: "primary",
      persistDelta,
      chatStateTarget,
      graphDetached,
    });
    if (chatStateResult?.saved) {
      const acceptedRevision = Number(chatStateResult.revision || revision);
      persistGraphCommitMarker(context, {
        reason,
        revision: acceptedRevision,
        storageTier: "luker-chat-state",
        accepted: true,
        lastProcessedAssistantFloor,
        extractionCount,
        immediate: true,
      });
      stampGraphPersistenceMeta(graph, {
        revision: acceptedRevision,
        reason: `luker-chat-state:${String(reason || "graph-persist")}`,
        chatId,
        integrity:
          getChatMetadataIntegrity(context) ||
          graphPersistenceState.metadataIntegrity,
      });
      updateGraphPersistenceState({
        hostProfile: persistenceEnvironment.hostProfile,
        primaryStorageTier: persistenceEnvironment.primaryStorageTier,
        cacheStorageTier: persistenceEnvironment.cacheStorageTier,
        cacheMirrorState:
          persistenceEnvironment.cacheStorageTier !== "none" ? "queued" : "idle",
        revision: acceptedRevision,
        lastPersistedRevision: acceptedRevision,
        pendingPersist: false,
        persistMismatchReason: "",
        lastAcceptedRevision: acceptedRevision,
        acceptedStorageTier: "luker-chat-state",
        acceptedBy: "luker-chat-state",
        lastRecoverableStorageTier: "none",
        lastPersistReason: reason,
        lastPersistMode: String(chatStateResult.saveMode || "chat-state"),
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        queuedPersistMode: "",
        queuedPersistRotateIntegrity: false,
        queuedPersistReason: "",
        persistDiagnosticTier: "none",
        lukerSidecarFormatVersion: Number(
          chatStateResult?.manifest?.formatVersion || LUKER_GRAPH_SIDECAR_V2_FORMAT,
        ),
        lukerManifestRevision: Number(
          chatStateResult?.manifestRevision || acceptedRevision,
        ),
        lukerJournalDepth: Number(chatStateResult?.journalDepth || 0),
        lukerJournalBytes: Number(chatStateResult?.manifest?.journalBytes || 0),
        lukerCheckpointRevision: Number(chatStateResult?.checkpointRevision || 0),
        cacheLag: Math.max(
          0,
          Number(chatStateResult?.manifestRevision || acceptedRevision) -
            Number(graphPersistenceState.indexedDbRevision || 0),
        ),
      });
      clearPendingGraphPersistRetry();
      if (persistenceEnvironment.cacheStorageTier !== "none") {
        queueGraphPersistToIndexedDb(chatId, graph, {
          revision: acceptedRevision,
          reason: `${reason}:local-cache-mirror`,
          persistRole: "cache-mirror",
          scheduleCloudUpload: false,
          persistDelta,
          graphSnapshot,
          persistSnapshot,
          graphDetached,
        });
      }
      return buildGraphPersistResult({
        saved: true,
        accepted: true,
        reason,
        revision: acceptedRevision,
        saveMode: String(chatStateResult.saveMode || "chat-state"),
        storageTier: "luker-chat-state",
        acceptedBy: "luker-chat-state",
        primaryTier: persistenceEnvironment.primaryStorageTier,
        cacheTier: persistenceEnvironment.cacheStorageTier,
        cacheMirrored: persistenceEnvironment.cacheStorageTier === "none",
        manifestRevision: Number(chatStateResult?.manifestRevision || acceptedRevision),
        journalDepth: Number(chatStateResult?.journalDepth || 0),
        checkpointRevision: Number(chatStateResult?.checkpointRevision || 0),
        cacheLag: Math.max(
          0,
          Number(chatStateResult?.manifestRevision || acceptedRevision) -
            Number(graphPersistenceState.indexedDbRevision || 0),
        ),
      });
    }
  }

  const indexedDbResult = await saveGraphToIndexedDb(chatId, graph, {
    revision,
    reason,
    persistDelta,
    graphSnapshot,
    persistSnapshot,
    sourceGraph: graph,
  });
  if (indexedDbResult?.saved) {
    persistGraphCommitMarker(context, {
      reason,
      revision: indexedDbResult.revision || revision,
      storageTier: indexedDbResult.storageTier || localStoreTier,
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      immediate: true,
    });
    clearPendingGraphPersistRetry();
    return buildGraphPersistResult({
      saved: true,
      accepted: true,
      reason,
      revision: indexedDbResult.revision || revision,
      saveMode: String(indexedDbResult.saveMode || "indexeddb-delta"),
      storageTier: indexedDbResult.storageTier || localStoreTier,
      acceptedBy: indexedDbResult.storageTier || localStoreTier,
      primaryTier: persistenceEnvironment.primaryStorageTier,
      cacheTier: persistenceEnvironment.cacheStorageTier,
    });
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    const chatStateResult = await persistGraphToHostChatState(context, {
      graph,
      chatId,
      revision,
      reason: `${reason}:chat-state-fallback`,
      storageTier: "chat-state",
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount,
      mode: "primary",
      persistDelta,
      chatStateTarget,
      graphDetached,
    });
    if (chatStateResult?.saved) {
      const acceptedRevision = Number(chatStateResult.revision || revision);
      persistGraphCommitMarker(context, {
        reason: `${reason}:chat-state-fallback`,
        revision: acceptedRevision,
        storageTier: "chat-state",
        accepted: true,
        lastProcessedAssistantFloor,
        extractionCount,
        immediate: true,
      });
      updateGraphPersistenceState({
        hostProfile: persistenceEnvironment.hostProfile,
        primaryStorageTier: persistenceEnvironment.primaryStorageTier,
        cacheStorageTier: persistenceEnvironment.cacheStorageTier,
        revision: Math.max(
          Number(graphPersistenceState.revision || 0),
          acceptedRevision,
        ),
        pendingPersist: false,
        persistMismatchReason: "",
        lastAcceptedRevision: Math.max(
          Number(graphPersistenceState.lastAcceptedRevision || 0),
          acceptedRevision,
        ),
        acceptedStorageTier: "chat-state",
        acceptedBy: "chat-state",
        lastRecoverableStorageTier: "none",
        lastPersistReason: `${reason}:chat-state-fallback`,
        lastPersistMode: String(chatStateResult.saveMode || "chat-state"),
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        queuedPersistMode: "",
        queuedPersistRotateIntegrity: false,
        queuedPersistReason: "",
        persistDiagnosticTier: "none",
      });
      clearPendingGraphPersistRetry();
      queueGraphPersistToIndexedDb(chatId, graph, {
        revision: acceptedRevision,
        reason: `${reason}:chat-state-fallback:promote-indexeddb`,
        persistDelta,
        graphDetached,
      });
      return buildGraphPersistResult({
        saved: true,
        accepted: true,
        reason: `${reason}:chat-state-fallback`,
        revision: acceptedRevision,
        saveMode: String(chatStateResult.saveMode || "chat-state"),
        storageTier: "chat-state",
        acceptedBy: "chat-state",
        primaryTier: persistenceEnvironment.primaryStorageTier,
        cacheTier: persistenceEnvironment.cacheStorageTier,
      });
    }
  }

  return null;
}

function resolvePendingPersistLastProcessedAssistantFloor() {
  const processedRange = Array.isArray(
    currentGraph?.historyState?.lastBatchStatus?.processedRange,
  )
    ? currentGraph.historyState.lastBatchStatus.processedRange
    : [];
  const rangeEnd = Number(processedRange[1]);
  if (Number.isFinite(rangeEnd) && rangeEnd >= 0) {
    return Math.floor(rangeEnd);
  }

  const rangeStart = Number(processedRange[0]);
  if (Number.isFinite(rangeStart) && rangeStart >= 0) {
    return Math.floor(rangeStart);
  }

  return null;
}

function resolvePendingPersistGraphSource(chatId = "") {
  const normalizedChatId = normalizeChatIdCandidate(
    chatId || graphPersistenceState.queuedPersistChatId || graphPersistenceState.chatId,
  );
  const targetRevision = Math.max(
    Number(graphPersistenceState.queuedPersistRevision || 0),
    Number(graphPersistenceState.revision || 0),
  );
  const shadowSnapshot = normalizedChatId
    ? readGraphShadowSnapshot(normalizedChatId)
    : null;

  if (
    shadowSnapshot &&
    Number(shadowSnapshot.revision || 0) >= targetRevision &&
    typeof shadowSnapshot.serializedGraph === "string" &&
    shadowSnapshot.serializedGraph
  ) {
    try {
      const shadowGraph = normalizeGraphRuntimeState(
        deserializeGraph(shadowSnapshot.serializedGraph),
        normalizedChatId,
      );
      return {
        graph: shadowGraph,
        source: "shadow",
        revision: Number(shadowSnapshot.revision || 0),
      };
    } catch (error) {
      console.warn("[ST-BME] pending persist shadow graph 恢复失败:", error);
    }
  }

  return {
    graph: currentGraph,
    source: "runtime",
    revision: Math.max(
      Number(getGraphPersistedRevision(currentGraph) || 0),
      targetRevision,
    ),
  };
}

function applyAcceptedPendingPersistState(
  persistResult,
  {
    lastProcessedAssistantFloor = resolvePendingPersistLastProcessedAssistantFloor(),
    persistedGraph = null,
  } = {},
) {
  ensureCurrentGraphRuntimeState();

  const persistenceRecord = buildBatchPersistenceRecordFromPersistResult(
    persistResult,
  );
  const batchStatus = currentGraph?.historyState?.lastBatchStatus;
  if (batchStatus && typeof batchStatus === "object") {
    batchStatus.persistence = persistenceRecord;
    batchStatus.historyAdvanceAllowed = persistenceRecord.accepted === true;
    batchStatus.historyAdvanced = persistenceRecord.accepted === true;
    currentGraph.historyState.lastBatchStatus = batchStatus;
  }

  if (
    persistedGraph &&
    typeof persistedGraph === "object" &&
    !Array.isArray(persistedGraph)
  ) {
    const persistedHistory =
      persistedGraph.historyState &&
      typeof persistedGraph.historyState === "object" &&
      !Array.isArray(persistedGraph.historyState)
        ? persistedGraph.historyState
        : null;
    if (persistedHistory) {
      currentGraph.historyState.processedMessageHashVersion =
        persistedHistory.processedMessageHashVersion ??
        currentGraph.historyState.processedMessageHashVersion;
      currentGraph.historyState.processedMessageHashes = cloneRuntimeDebugValue(
        persistedHistory.processedMessageHashes || {},
        currentGraph.historyState.processedMessageHashes || {},
      );
      currentGraph.historyState.processedMessageHashesNeedRefresh =
        persistedHistory.processedMessageHashesNeedRefresh === true;
    }
    if (Array.isArray(persistedGraph.batchJournal)) {
      currentGraph.batchJournal = cloneRuntimeDebugValue(
        persistedGraph.batchJournal,
        currentGraph.batchJournal || [],
      );
    }
  }

  if (
    persistenceRecord.accepted === true &&
    Number.isFinite(Number(lastProcessedAssistantFloor)) &&
    Number(lastProcessedAssistantFloor) >= 0
  ) {
    const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];
    const safeFloor = Math.floor(Number(lastProcessedAssistantFloor));
    if (typeof updateProcessedHistorySnapshot === "function") {
      updateProcessedHistorySnapshot(chat, safeFloor);
    } else {
      currentGraph.historyState.lastProcessedAssistantFloor = safeFloor;
      currentGraph.lastProcessedSeq = safeFloor;
    }
  }

  if (persistenceRecord.accepted === true) {
    updateGraphPersistenceState({
      acceptedStorageTier: String(persistenceRecord.storageTier || "none"),
      lastRecoverableStorageTier: "none",
      pendingPersist: false,
    });
    const safeFloor = Number.isFinite(Number(lastProcessedAssistantFloor))
      ? Math.floor(Number(lastProcessedAssistantFloor))
      : null;
    if (typeof setLastExtractionStatus === "function") {
      setLastExtractionStatus(
        "持久化已确认",
        [
          safeFloor != null ? `楼层 ${safeFloor}` : "",
          `rev ${Number(persistenceRecord.revision || 0)}`,
          String(persistenceRecord.storageTier || "none"),
          persistenceRecord.reason || "",
        ]
          .filter(Boolean)
          .join(" · "),
        "success",
        { syncRuntime: true, toastKind: "" },
      );
    }
  }

  refreshPanelLiveState();
}

function schedulePendingGraphPersistRetry(
  reason = "pending-graph-persist-retry",
  attempt = 0,
) {
  if (isRestoreLockActive()) {
    return false;
  }
  if (!graphPersistenceState.pendingPersist) {
    clearPendingGraphPersistRetry();
    return false;
  }

  const targetChatId = normalizeChatIdCandidate(
    graphPersistenceState.queuedPersistChatId ||
      graphPersistenceState.chatId ||
      getCurrentChatId(),
  );
  if (!targetChatId) {
    return false;
  }

  const normalizedAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  if (normalizedAttempt >= PENDING_GRAPH_PERSIST_MAX_RETRY_ATTEMPTS) {
    return false;
  }

  const delayIndex = Math.min(
    normalizedAttempt,
    PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS.length - 1,
  );
  const delayMs = PENDING_GRAPH_PERSIST_RETRY_DELAYS_MS[delayIndex];
  clearPendingGraphPersistRetry({ resetChatId: false });
  pendingGraphPersistRetryChatId = targetChatId;
  pendingGraphPersistRetryAttempt = normalizedAttempt;

  pendingGraphPersistRetryTimer = setTimeout(() => {
    pendingGraphPersistRetryTimer = null;
    void retryPendingGraphPersist({
      reason: `${reason}:attempt-${normalizedAttempt + 1}`,
      retryAttempt: normalizedAttempt,
      scheduleRetryOnFailure: true,
    }).catch((error) => {
      console.warn("[ST-BME] 待确认持久化自动重试失败:", error);
    });
  }, delayMs);

  return true;
}

function persistGraphToChatMetadata(
  context = getContext(),
  {
    reason = "graph-persist",
    revision = graphPersistenceState.revision,
    immediate = false,
    graph = currentGraph,
  } = {},
) {
  if (!context || !graph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      recoverable: false,
      reason: "missing-context-or-graph",
      revision,
    });
  }

  const chatId = resolvePersistenceChatId(context, graph);
  if (!chatId) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      recoverable: false,
      reason: "missing-chat-id",
      revision,
    });
  }

  const nextIntegrity = getChatMetadataIntegrity(context);
  const persistedGraph = cloneGraphForPersistence(graph, chatId);
  stampGraphPersistenceMeta(persistedGraph, {
    revision,
    reason,
    chatId,
    integrity: nextIntegrity,
  });

  writeChatMetadataPatch(context, {
    [GRAPH_METADATA_KEY]: persistedGraph,
  });
  const saveMode = triggerChatMetadataSave(context, { immediate });

  updateGraphPersistenceState({
    lastPersistReason: String(reason || ""),
    lastPersistMode: `metadata-full:${saveMode}`,
    metadataIntegrity: String(nextIntegrity || graphPersistenceState.metadataIntegrity || ""),
    indexedDbLastError: graphPersistenceState.indexedDbLastError || "",
    lastRecoverableStorageTier: "metadata-full",
    dualWriteLastResult: {
      action: "save",
      target: "metadata",
      success: true,
      recoverable: true,
      chatId,
      revision: normalizeIndexedDbRevision(revision),
      reason: String(reason || "graph-persist"),
      at: Date.now(),
    },
  });
  rememberResolvedGraphIdentityAlias(context, chatId);

  return buildGraphPersistResult({
    saved: true,
    accepted: false,
    recoverable: true,
    reason,
    loadState: graphPersistenceState.loadState,
    revision,
    saveMode,
    storageTier: "metadata-full",
  });
}

function queueGraphPersist(
  reason = "graph-persist-blocked",
  revision = graphPersistenceState.revision,
  {
    immediate = true,
    graph = currentGraph,
    chatId = undefined,
    captureShadow = true,
    recoverableTier = "none",
  } = {},
) {
  const queuedChatId =
    String(chatId || graphPersistenceState.chatId || getCurrentChatId()) || "";
  const normalizedRevision = Math.max(
    1,
    allocateRequestedPersistRevision(revision, graph),
  );
  let effectiveRecoverableTier = isRecoveryOnlyPersistTier(recoverableTier)
    ? String(recoverableTier)
    : "none";

  if (captureShadow) {
    const shadowCaptured = maybeCaptureGraphShadowSnapshot(reason, {
      graph,
      chatId: queuedChatId,
      revision: normalizedRevision,
    });
    if (shadowCaptured && effectiveRecoverableTier === "none") {
      effectiveRecoverableTier = "shadow";
    }
  }

  updateGraphPersistenceState({
    queuedPersistRevision: Math.max(
      normalizeIndexedDbRevision(graphPersistenceState.queuedPersistRevision),
      normalizedRevision,
    ),
    queuedPersistChatId: String(queuedChatId || ""),
    queuedPersistMode: immediate ? "immediate" : "debounced",
    queuedPersistRotateIntegrity: false,
    queuedPersistReason: String(reason || ""),
    pendingPersist: true,
    writesBlocked: !isRecoveryOnlyPersistTier(effectiveRecoverableTier),
    lastPersistReason: String(reason || ""),
    lastPersistMode: immediate ? "pending-immediate" : "pending-debounced",
    lastRecoverableStorageTier: isRecoveryOnlyPersistTier(effectiveRecoverableTier)
      ? effectiveRecoverableTier
      : graphPersistenceState.lastRecoverableStorageTier,
  });
  schedulePendingGraphPersistRetry(String(reason || "graph-persist-blocked"), 0);

  return buildGraphPersistResult({
    queued: true,
    blocked: true,
    accepted: false,
    recoverable: isRecoveryOnlyPersistTier(effectiveRecoverableTier),
    reason,
    loadState: graphPersistenceState.loadState,
    revision: normalizedRevision,
    saveMode: immediate ? "immediate" : "debounced",
    storageTier: effectiveRecoverableTier !== "none" ? effectiveRecoverableTier : "none",
  });
}

function maybeFlushQueuedGraphPersist(reason = "queued-graph-persist") {
  const context = getContext();
  if (!currentGraph || !canPersistGraphToMetadataFallback(context)) {
    return buildGraphPersistResult({
      queued: graphPersistenceState.pendingPersist,
      blocked: !canPersistGraphToMetadataFallback(context),
      reason: canPersistGraphToMetadataFallback(context)
        ? "missing-current-graph"
        : "write-protected",
    });
  }

  if (
    !graphPersistenceState.pendingPersist &&
    graphPersistenceState.queuedPersistRevision <=
      graphPersistenceState.lastPersistedRevision
  ) {
    return buildGraphPersistResult({
      saved: false,
      reason: "no-queued-persist",
    });
  }

  const activeChatId = getCurrentChatId();
  const queuedChatId = String(graphPersistenceState.queuedPersistChatId || "");
  if (queuedChatId && activeChatId && queuedChatId !== activeChatId) {
    return buildGraphPersistResult({
      saved: false,
      queued: graphPersistenceState.pendingPersist,
      blocked: true,
      reason: "queued-chat-mismatch",
      revision: graphPersistenceState.queuedPersistRevision,
      saveMode: graphPersistenceState.queuedPersistMode,
    });
  }

  const targetRevision = Math.max(
    graphPersistenceState.revision || 0,
    graphPersistenceState.queuedPersistRevision || 0,
  );
  if (targetRevision > (graphPersistenceState.revision || 0)) {
    updateGraphPersistenceState({
      revision: targetRevision,
    });
  }

  return persistGraphToChatMetadata(context, {
    reason,
    revision: targetRevision,
    immediate: graphPersistenceState.queuedPersistMode !== "debounced",
  });
}

async function retryPendingGraphPersist({
  reason = "pending-graph-persist-retry",
  retryAttempt = 0,
  scheduleRetryOnFailure = false,
  ignoreRestoreLock = false,
} = {}) {
  ensureCurrentGraphRuntimeState();

  if (!ignoreRestoreLock && isRestoreLockActive()) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "restore-lock-active",
      revision: graphPersistenceState.revision,
      saveMode: graphPersistenceState.lastPersistMode,
      storageTier: "none",
    });
  }

  if (!graphPersistenceState.pendingPersist) {
    clearPendingGraphPersistRetry();
    return buildGraphPersistResult({
      saved: false,
      blocked: false,
      accepted: false,
      reason: "no-pending-persist",
      revision: graphPersistenceState.revision,
      saveMode: graphPersistenceState.lastPersistMode,
      storageTier: "none",
    });
  }

  const context = getContext();
  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  const queuedChatId = normalizeChatIdCandidate(
    graphPersistenceState.queuedPersistChatId ||
      graphPersistenceState.chatId ||
      activeChatId,
  );
  const currentIdentity = resolveCurrentChatIdentity(context);
  if (!currentGraph || !context || !activeChatId || !queuedChatId) {
    if (scheduleRetryOnFailure) {
      schedulePendingGraphPersistRetry(reason, Number(retryAttempt) + 1);
    }
    return buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "pending-persist-context-unavailable",
      revision: Math.max(
        Number(graphPersistenceState.queuedPersistRevision || 0),
        Number(graphPersistenceState.revision || 0),
      ),
      saveMode: graphPersistenceState.queuedPersistMode,
      storageTier: "none",
    });
  }

  if (
    !areChatIdsEquivalentForResolvedIdentity(
      queuedChatId,
      activeChatId,
      currentIdentity,
    ) &&
    !areChatIdsEquivalentForResolvedIdentity(
      activeChatId,
      queuedChatId,
      currentIdentity,
    )
  ) {
    if (scheduleRetryOnFailure) {
      schedulePendingGraphPersistRetry(reason, Number(retryAttempt) + 1);
    }
    return buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "queued-chat-mismatch",
      revision: Math.max(
        Number(graphPersistenceState.queuedPersistRevision || 0),
        Number(graphPersistenceState.revision || 0),
      ),
      saveMode: graphPersistenceState.queuedPersistMode,
      storageTier: "none",
    });
  }

  const requestedLocalStoreMode = getRequestedGraphLocalStorageMode(
    getSettings(),
  );
  if (
    requestedLocalStoreMode === "auto" ||
    isGraphLocalStorageModeOpfs(requestedLocalStoreMode)
  ) {
    await refreshCurrentChatLocalStoreBinding({
      chatId: activeChatId,
      forceCapabilityRefresh: true,
      reopenCurrentDb: true,
      source: reason,
    });
  }

  const pendingPersistGraphSource = resolvePendingPersistGraphSource(
    queuedChatId,
  );
  const pendingPersistGraph = pendingPersistGraphSource?.graph || currentGraph;
  const pendingPersistGraphDetached =
    Boolean(pendingPersistGraph) &&
    typeof pendingPersistGraph === "object" &&
    pendingPersistGraph !== currentGraph;
  const targetRevision = Math.max(
    Number(graphPersistenceState.queuedPersistRevision || 0),
    Number(graphPersistenceState.revision || 0),
    Number(graphPersistenceState.lastPersistedRevision || 0),
    Number(pendingPersistGraphSource?.revision || 0),
    Number(getGraphPersistedRevision(pendingPersistGraph) || 0),
  );
  const lastProcessedAssistantFloor =
    resolvePendingPersistLastProcessedAssistantFloor();
  const acceptedPersistResult = await persistGraphToConfiguredDurableTier(
    context,
    pendingPersistGraph,
    {
      chatId: activeChatId,
      revision: targetRevision,
      reason,
      lastProcessedAssistantFloor,
      graphDetached: pendingPersistGraphDetached,
    },
  );
  if (acceptedPersistResult?.accepted) {
    applyAcceptedPendingPersistState(acceptedPersistResult, {
      lastProcessedAssistantFloor,
      persistedGraph: pendingPersistGraph,
    });
    void maybeResumePendingAutoExtraction(
      `pending-persist-resolved:${acceptedPersistResult.acceptedBy || acceptedPersistResult.storageTier || "accepted"}`,
    );
    return acceptedPersistResult;
  }

  let recoverableTier = "none";
  if (canPersistGraphToMetadataFallback(context, pendingPersistGraph)) {
    const metadataReason = `${reason}:metadata-full-fallback`;
    const metadataResult = persistGraphToChatMetadata(context, {
      reason: metadataReason,
      revision: targetRevision,
      immediate: true,
      graph: pendingPersistGraph,
    });
    if (metadataResult?.saved) {
      recoverableTier = "metadata-full";
    }
  }

  if (
    recoverableTier === "none" &&
    maybeCaptureGraphShadowSnapshot(`${reason}:shadow-fallback`, {
      graph: pendingPersistGraph,
      chatId: activeChatId,
      revision: targetRevision,
    })
  ) {
    recoverableTier = "shadow";
  }

  const queuedReason = `${reason}:still-pending`;
  const queuedResult = queueGraphPersist(queuedReason, targetRevision, {
    immediate: graphPersistenceState.queuedPersistMode !== "debounced",
    graph: pendingPersistGraph,
    chatId: activeChatId,
    captureShadow: recoverableTier === "none",
    recoverableTier,
  });
  if (recoverableTier !== "none") {
    updateGraphPersistenceState({
      lastPersistReason: queuedReason,
      lastRecoverableStorageTier: recoverableTier,
    });
  }
  if (scheduleRetryOnFailure && recoverableTier === "none") {
    schedulePendingGraphPersistRetry(reason, Number(retryAttempt) + 1);
  }
  return buildGraphPersistResult({
    saved: false,
    queued: true,
    blocked: true,
    accepted: false,
    recoverable:
      recoverableTier !== "none" || queuedResult?.recoverable === true,
    reason: queuedReason,
    revision: Number(queuedResult?.revision || targetRevision),
    saveMode: String(
      queuedResult?.saveMode || graphPersistenceState.queuedPersistMode || "immediate",
    ),
    storageTier:
      recoverableTier !== "none"
        ? recoverableTier
        : String(queuedResult?.storageTier || "none"),
  });
}

async function persistExtractionBatchResult({
  reason = "extraction-batch-complete",
  lastProcessedAssistantFloor = null,
  graphSnapshot = null,
  persistSnapshot = null,
  persistDelta = null,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const persistGraphDetached =
    Boolean(graphSnapshot) &&
    typeof graphSnapshot === "object" &&
    graphSnapshot !== currentGraph;
  const persistGraph =
    graphSnapshot && typeof graphSnapshot === "object"
      ? graphSnapshot === currentGraph
        ? cloneGraphSnapshot(graphSnapshot)
        : graphSnapshot
      : currentGraph;
  if (!context || !persistGraph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-context-or-graph",
      storageTier: "none",
    });
  }

  const chatId = resolvePersistenceChatId(context, persistGraph);
  if (!chatId) {
    recordLocalPersistEarlyFailure("missing-chat-id", {
      chatId,
      revision: 0,
    });
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "missing-chat-id",
      storageTier: "none",
    });
  }

  const revision = allocateRequestedPersistRevision(0, persistGraph);
  const acceptedPersistResult = await persistGraphToConfiguredDurableTier(
    context,
    persistGraph,
    {
      chatId,
      revision,
      reason,
      lastProcessedAssistantFloor,
      persistDelta,
      graphSnapshot,
      persistSnapshot,
      graphDetached: persistGraphDetached,
    },
  );
  if (acceptedPersistResult?.accepted) {
    return acceptedPersistResult;
  }

  let recoverableTier = "none";
  if (
    maybeCaptureGraphShadowSnapshot(`${reason}:shadow-fallback`, {
      graph: persistGraph,
      chatId,
      revision,
    })
  ) {
    recoverableTier = "shadow";
  }

  if (canPersistGraphToMetadataFallback(context, persistGraph)) {
    const metadataReason = `${reason}:metadata-full-fallback`;
    const metadataResult = persistGraphToChatMetadata(context, {
      reason: metadataReason,
      revision,
      immediate: true,
      graph: persistGraph,
    });
    if (metadataResult?.saved) {
      recoverableTier = "metadata-full";
    }
  }

  const queuedResult = queueGraphPersist(`${reason}:pending`, revision, {
    immediate: true,
    graph: persistGraph,
    chatId,
    captureShadow: recoverableTier === "none",
    recoverableTier,
  });
  updateGraphPersistenceState({
    pendingPersist: true,
    lastPersistReason: String(queuedResult.reason || `${reason}:pending`),
    lastPersistMode: String(queuedResult.saveMode || ""),
    lastRecoverableStorageTier:
      recoverableTier !== "none"
        ? recoverableTier
        : String(queuedResult.storageTier || graphPersistenceState.lastRecoverableStorageTier || "none"),
  });
  return buildGraphPersistResult({
    saved: false,
    queued: Boolean(queuedResult?.queued),
    blocked: Boolean(queuedResult?.blocked),
    accepted: false,
    recoverable:
      recoverableTier !== "none" || queuedResult?.recoverable === true,
    reason: String(queuedResult?.reason || `${reason}:pending`),
    revision: Number(queuedResult?.revision || revision),
    saveMode: String(queuedResult?.saveMode || ""),
    storageTier:
      recoverableTier !== "none"
        ? recoverableTier
        : String(queuedResult?.storageTier || "none"),
  });
}

function scheduleGraphLoadRetry(
  chatId,
  reason = "metadata-pending",
  attemptIndex = 0,
  { allowPendingChat = false, expectedChatId = "" } = {},
) {
  const normalizedChatId = String(chatId || "");
  const normalizedExpectedChatId = String(
    expectedChatId || normalizedChatId || "",
  );
  const delayMs = GRAPH_LOAD_RETRY_DELAYS_MS[attemptIndex];
  if ((!normalizedChatId && !allowPendingChat) || !Number.isFinite(delayMs)) {
    clearPendingGraphLoadRetry();
    return false;
  }

  clearPendingGraphLoadRetry({ resetChatId: false });
  pendingGraphLoadRetryChatId =
    normalizedChatId || (allowPendingChat ? GRAPH_LOAD_PENDING_CHAT_ID : "");
  debugDebug(
    `[ST-BME] 图谱元数据尚未就绪，${delayMs}ms 后重试加载（chat=${normalizedChatId || "pending"}，attempt=${attemptIndex + 1}，reason=${reason}）`,
  );

  pendingGraphLoadRetryTimer = setTimeout(() => {
    pendingGraphLoadRetryTimer = null;
    const currentChatId = getCurrentChatId();
    if (
      normalizedExpectedChatId &&
      currentChatId &&
      currentChatId !== normalizedExpectedChatId
    ) {
      clearPendingGraphLoadRetry();
      return;
    }
    if (
      !allowPendingChat &&
      normalizedChatId &&
      currentChatId !== normalizedChatId
    ) {
      clearPendingGraphLoadRetry();
      return;
    }

    loadGraphFromChat({
      attemptIndex: attemptIndex + 1,
      expectedChatId: normalizedExpectedChatId,
      source: `retry:${reason}`,
    });
  }, delayMs);

  return true;
}

function reconcileIndexedDbProbeFailureState(
  chatId,
  result = {},
  { attemptIndex = 0 } = {},
) {
  if (result?.loaded || result?.emptyConfirmed || result?.repairQueued) {
    clearPendingGraphLoadRetry();
    return result;
  }

  const normalizedChatId = normalizeChatIdCandidate(chatId || result?.chatId);
  const normalizedReason = String(result?.reason || "").trim();
  if (!normalizedChatId || !normalizedReason) {
    return result;
  }

  const isIndexedDbProbeFailureReason =
    normalizedReason.startsWith("indexeddb-") ||
    normalizedReason.startsWith("persist-mismatch:indexeddb-");
  if (
    !isIndexedDbProbeFailureReason ||
    normalizedReason === "indexeddb-stale" ||
    normalizedReason === "indexeddb-chat-switched"
  ) {
    return result;
  }

  if (graphPersistenceState.loadState !== GRAPH_LOAD_STATES.LOADING) {
    return result;
  }

  const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);
  if (stateChatId && stateChatId !== normalizedChatId) {
    return result;
  }

  const currentChatId = getCurrentChatId();
  if (currentChatId && currentChatId !== normalizedChatId) {
    return result;
  }

  if (
    scheduleGraphLoadRetry(normalizedChatId, normalizedReason, attemptIndex, {
      expectedChatId: normalizedChatId,
    })
  ) {
    return {
      ...result,
      retryScheduled: true,
    };
  }

  applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
    chatId: normalizedChatId,
    reason: normalizedReason,
    attemptIndex,
    dbReady: false,
    writesBlocked: true,
  });
  runtimeStatus = createGraphLoadUiStatus();
  refreshPanelLiveState();

  return {
    ...result,
    loadState: GRAPH_LOAD_STATES.BLOCKED,
    blocked: true,
    reason: normalizedReason,
  };
}

function shouldSyncGraphLoadFromLiveContext(
  context = getContext(),
  { force = false } = {},
) {
  if (force) return true;

  const chatIdentity = resolveCurrentChatIdentity(context);
  const liveChatId = chatIdentity.chatId;
  const stateChatId = normalizeChatIdCandidate(graphPersistenceState.chatId);

  if (
    !areChatIdsEquivalentForResolvedIdentity(
      liveChatId,
      stateChatId,
      chatIdentity,
    )
  ) {
    return true;
  }

  if (
    !liveChatId &&
    graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT
  ) {
    return true;
  }

  if (liveChatId && !graphPersistenceState.dbReady) return true;

  return false;
}

function syncGraphLoadFromLiveContext(options = {}) {
  const { source = "live-context-sync", force = false } = options;
  const attemptIndex = Math.max(
    0,
    Math.floor(Number(options?.attemptIndex) || 0),
  );
  const context = getContext();
  syncCommitMarkerToPersistenceState(context);
  if (!shouldSyncGraphLoadFromLiveContext(context, { force })) {
    return {
      synced: false,
      reason: "no-sync-needed",
      loadState: graphPersistenceState.loadState,
      chatId: graphPersistenceState.chatId,
    };
  }

  const chatId = resolveCurrentChatIdentity(context).chatId;
  if (!chatId) {
    const result = loadGraphFromChat({
      source,
      attemptIndex: 0,
    });
    return {
      synced: true,
      ...result,
    };
  }

  const persistenceEnvironment = buildPersistenceEnvironment(
    context,
    getPreferredGraphLocalStorePresentationSync(),
  );
  if (
    persistenceEnvironment.hostProfile === "luker" &&
    canUseHostGraphChatStatePersistence(context)
  ) {
    scheduleGraphChatStateProbe(chatId, {
      source: `${source}:luker-chat-state-probe`,
      attemptIndex,
      allowOverride: true,
    });
    applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
      chatId,
      reason: `luker-chat-state-probe-pending:${String(source || "direct-load")}`,
      attemptIndex,
      dbReady: false,
      writesBlocked: true,
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
    });
    updateGraphPersistenceState({
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
      storagePrimary: getPreferredGraphLocalStorePresentationSync().storagePrimary,
      storageMode: getPreferredGraphLocalStorePresentationSync().storageMode,
      dbReady: false,
      indexedDbLastError: "",
    });
    refreshPanelLiveState();
    return {
      success: false,
      loaded: false,
      loadState: GRAPH_LOAD_STATES.LOADING,
      reason: "luker-chat-state-probe-pending",
      chatId,
      attemptIndex,
    };
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    scheduleGraphChatStateProbe(chatId, {
      source: `${source}:chat-state-probe`,
      attemptIndex: 0,
      allowOverride: true,
    });
  }

  const cachedPreferredLocalStore = getPreferredGraphLocalStorePresentationSync();
  const cachedSnapshot = readCachedIndexedDbSnapshot(
    chatId,
    cachedPreferredLocalStore,
  );
  if (isIndexedDbSnapshotMeaningful(cachedSnapshot)) {
    const cachedStore = resolveSnapshotGraphStorePresentation(
      cachedSnapshot,
      cachedPreferredLocalStore,
    );
    const result = applyIndexedDbSnapshotToRuntime(chatId, cachedSnapshot, {
      source: `${source}:indexeddb-cache`,
      attemptIndex: 0,
      storagePrimary: cachedStore.storagePrimary,
      storageMode: cachedStore.storageMode,
      statusLabel: cachedStore.statusLabel,
      reasonPrefix: cachedStore.reasonPrefix,
    });
    if (result?.reason === `${cachedStore.reasonPrefix}-stale-runtime`) {
      return {
        synced: false,
        reason: "cached-indexeddb-stale-runtime",
        loadState: graphPersistenceState.loadState,
        chatId: graphPersistenceState.chatId,
        staleDetail: cloneRuntimeDebugValue(result?.staleDetail, null),
      };
    }
    return {
      synced: true,
      ...result,
    };
  }

  const preferredLocalStore = getPreferredGraphLocalStorePresentationSync();
  applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
    chatId,
    reason: `indexeddb-sync:${String(source || "live-context-sync")}`,
    attemptIndex: 0,
    dbReady: false,
    writesBlocked: true,
  });
  updateGraphPersistenceState({
    storagePrimary: preferredLocalStore.storagePrimary,
    storageMode: preferredLocalStore.storageMode,
    dbReady: false,
    indexedDbLastError: "",
  });
  scheduleIndexedDbGraphProbe(chatId, {
    source: `${source}:indexeddb-probe`,
    allowOverride: true,
    applyEmptyState: true,
  });
  refreshPanelLiveState();

  return {
    synced: true,
    success: false,
    loaded: false,
    loadState: GRAPH_LOAD_STATES.LOADING,
    reason: "indexeddb-loading",
    chatId,
    attemptIndex: 0,
  };
}

function scheduleStartupGraphReconciliation() {
  for (const delayMs of GRAPH_STARTUP_RECONCILE_DELAYS_MS) {
    setTimeout(() => {
      syncGraphLoadFromLiveContext({
        source: `startup-reconcile:${delayMs}`,
      });
    }, delayMs);
  }
}

function clearInjectionState(options = {}) {
  const {
    preserveRecallStatus = false,
    preserveRuntimeStatus = preserveRecallStatus,
  } = options;
  lastInjectionContent = "";
  lastRecalledItems = [];
  if (!preserveRecallStatus) {
    lastRecallStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }
  if (!preserveRuntimeStatus) {
    runtimeStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }
  recordInjectionSnapshot("recall", {
    injectionText: "",
    selectedNodeIds: [],
    retrievalMeta: {},
    llmMeta: {},
    transport: {
      applied: false,
      source: "cleared",
      mode: "cleared",
    },
  });
  if (!isRecalling && !preserveRecallStatus) {
    dismissStageNotice("recall");
  }

  try {
    applyModuleInjectionPrompt("", getSettings());
  } catch (error) {
    console.warn("[ST-BME] 清理旧注入失败:", error);
  }

  refreshPanelLiveState();
}

function refreshPanelLiveState() {
  refreshPanelLiveStateController({
    getPanelModule: () => _panelModule,
  });
}

function getMessageHideStateSnapshotForPanel() {
  return getHideStateSnapshot();
}

function notifyStatusToast(key, kind, message, title = "ST-BME") {
  const now = Date.now();
  if (now - (lastStatusToastAt[key] || 0) < STATUS_TOAST_THROTTLE_MS) return;
  lastStatusToastAt[key] = now;

  const method = typeof toastr?.[kind] === "function" ? kind : "info";
  toastr[method](message, title, { timeOut: 2200 });
}

function setRuntimeStatus(text, meta, level = "info") {
  runtimeStatus = createUiStatus(text, meta, level);
  refreshPanelLiveState();
  // 同步悬浮球状态
  const fabStatus = level === "info" ? "idle" : level;
  _panelModule?.updateFloatingBallStatus?.(fabStatus, text || "BME 记忆图谱");
}

function setLastExtractionStatus(
  text,
  meta,
  level = "info",
  {
    syncRuntime = true,
    toastKind = "",
    toastTitle = "ST-BME 提取",
    noticeMarquee = false,
  } = {},
) {
  lastExtractionStatus = createUiStatus(text, meta, level);
  if (syncRuntime) {
    setRuntimeStatus(text, meta, level);
  } else {
    refreshPanelLiveState();
  }
  updateStageNotice("extraction", text, meta, level, {
    title: toastTitle,
    noticeMarquee,
  });
  if (toastKind) {
    notifyStatusToast(
      `extract:${toastKind}`,
      toastKind,
      meta || text,
      toastTitle,
    );
  }
}

function setLastVectorStatus(
  text,
  meta,
  level = "info",
  { syncRuntime = false, toastKind = "", toastTitle = "ST-BME 向量" } = {},
) {
  lastVectorStatus = createUiStatus(text, meta, level);
  if (syncRuntime) {
    setRuntimeStatus(text, meta, level);
  } else {
    refreshPanelLiveState();
  }
  updateStageNotice("vector", text, meta, level, {
    title: toastTitle,
  });
  if (toastKind) {
    notifyStatusToast(
      `vector:${toastKind}`,
      toastKind,
      meta || text,
      toastTitle,
    );
  }
}

function setLastRecallStatus(
  text,
  meta,
  level = "info",
  {
    syncRuntime = true,
    toastKind = "",
    toastTitle = "ST-BME 召回",
    noticeMarquee = false,
  } = {},
) {
  lastRecallStatus = createUiStatus(text, meta, level);
  if (syncRuntime) {
    setRuntimeStatus(text, meta, level);
  } else {
    refreshPanelLiveState();
  }
  updateStageNotice("recall", text, meta, level, {
    title: toastTitle,
    noticeMarquee,
  });
  if (toastKind) {
    notifyStatusToast(
      `recall:${toastKind}`,
      toastKind,
      meta || text,
      toastTitle,
    );
  }
}

function notifyExtractionIssue(message, title = "ST-BME 提取提示") {
  setLastExtractionStatus("提取失败", message, "warning", {
    syncRuntime: true,
  });
  const now = Date.now();
  if (now - lastExtractionWarningAt < 5000) return;
  lastExtractionWarningAt = now;
  toastr.warning(message, title, { timeOut: 4500 });
}

async function fetchLocalWithTimeout(
  url,
  options = {},
  timeoutMs = getConfiguredTimeoutMs(),
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `本地请求超时 (${Math.round(timeoutMs / 1000)}s)`,
          "AbortError",
        ),
      ),
    timeoutMs,
  );
  let signal = controller.signal;
  if (options.signal) {
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.any === "function"
    ) {
      signal = AbortSignal.any([options.signal, controller.signal]);
    } else {
      signal = controller.signal;
      options.signal.addEventListener(
        "abort",
        () => controller.abort(options.signal.reason),
        {
          once: true,
        },
      );
    }
  }

  try {
    return await fetch(url, {
      ...options,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function snapshotRuntimeUiState() {
  return {
    extractionCount,
    lastInjectionContent,
    lastExtractedItems: Array.isArray(lastExtractedItems)
      ? lastExtractedItems.map((item) => ({ ...item }))
      : [],
    lastRecalledItems: Array.isArray(lastRecalledItems)
      ? lastRecalledItems.map((item) => ({ ...item }))
      : [],
    runtimeStatus: { ...(runtimeStatus || {}) },
    lastExtractionStatus: { ...(lastExtractionStatus || {}) },
    lastVectorStatus: { ...(lastVectorStatus || {}) },
    lastRecallStatus: { ...(lastRecallStatus || {}) },
    graphPersistenceState: getGraphPersistenceLiveState(),
  };
}

function restoreRuntimeUiState(snapshot = {}) {
  extractionCount = Number.isFinite(snapshot.extractionCount)
    ? snapshot.extractionCount
    : 0;
  lastInjectionContent = String(snapshot.lastInjectionContent || "");
  lastExtractedItems = Array.isArray(snapshot.lastExtractedItems)
    ? snapshot.lastExtractedItems.map((item) => ({ ...item }))
    : [];
  lastRecalledItems = Array.isArray(snapshot.lastRecalledItems)
    ? snapshot.lastRecalledItems.map((item) => ({ ...item }))
    : [];
  runtimeStatus = {
    ...createUiStatus("待命", "准备就绪", "idle"),
    ...(snapshot.runtimeStatus || {}),
  };
  lastExtractionStatus = {
    ...createUiStatus("待命", "尚未执行提取", "idle"),
    ...(snapshot.lastExtractionStatus || {}),
  };
  lastVectorStatus = {
    ...createUiStatus("待命", "尚未执行向量任务", "idle"),
    ...(snapshot.lastVectorStatus || {}),
  };
  lastRecallStatus = {
    ...createUiStatus("待命", "尚未执行召回", "idle"),
    ...(snapshot.lastRecallStatus || {}),
  };
  if (snapshot.graphPersistenceState) {
    updateGraphPersistenceState(snapshot.graphPersistenceState);
  }
  refreshPanelLiveState();
}

function getLastProcessedAssistantFloor() {
  const historyFloor = Number(
    currentGraph?.historyState?.lastProcessedAssistantFloor,
  );
  if (Number.isFinite(historyFloor)) {
    return historyFloor;
  }

  const legacySeq = Number(currentGraph?.lastProcessedSeq);
  if (Number.isFinite(legacySeq)) return legacySeq;
  return -1;
}

async function recordGraphMutation({
  beforeSnapshot,
  processedRange = null,
  artifactTags = [],
  syncRange = null,
  signal = undefined,
  extractionCountBefore = extractionCount,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const vectorSync = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(getEmbeddingConfig()) && !syncRange,
    range: syncRange,
    signal,
  });
  const afterSnapshot = cloneGraphSnapshot(currentGraph);
  const effectiveRange = Array.isArray(processedRange)
    ? processedRange
    : [getLastProcessedAssistantFloor(), getLastProcessedAssistantFloor()];

  appendBatchJournal(
    currentGraph,
    createBatchJournalEntry(beforeSnapshot, afterSnapshot, {
      processedRange: effectiveRange,
      postProcessArtifacts: computePostProcessArtifacts(
        beforeSnapshot,
        afterSnapshot,
        artifactTags,
      ),
      vectorHashesInserted: vectorSync?.insertedHashes || [],
      extractionCountBefore,
    }),
  );
  saveGraphToChat({ reason: "record-graph-mutation" });
  return vectorSync;
}

function noteMaintenanceGate(status, action, reason) {
  if (!status || typeof status !== "object") return;
  const normalizedAction = String(action || "").trim() || "unknown";
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) return;

  const nextDetail = {
    action: normalizedAction,
    reason: normalizedReason,
  };
  const previousDetails = Array.isArray(status.maintenanceGateDetails)
    ? status.maintenanceGateDetails
    : [];
  status.maintenanceGateApplied = true;
  status.maintenanceGateDetails = [...previousDetails, nextDetail];
  status.maintenanceGateReason = status.maintenanceGateDetails
    .map((item) => `${item.action}: ${item.reason}`)
    .join(" | ");
}

function evaluateAutoConsolidationGate(
  newNodeCount,
  analysis = null,
  settings = {},
) {
  const minNewNodes = clampInt(
    settings.consolidationAutoMinNewNodes,
    2,
    1,
    50,
  );
  const safeNewNodeCount = Math.max(0, Number(newNodeCount) || 0);
  if (safeNewNodeCount >= minNewNodes) {
    return {
      shouldRun: true,
      minNewNodes,
      reason: `本批新增 ${safeNewNodeCount} 个节点，达到自动整合门槛 ${minNewNodes}`,
      matchedScore: null,
      matchedNodeId: "",
    };
  }

  if (analysis?.triggered) {
    return {
      shouldRun: true,
      minNewNodes,
      reason:
        String(analysis.reason || "").trim() ||
        "检测到高重复风险，已触发自动整合",
      matchedScore: Number.isFinite(Number(analysis?.matchedScore))
        ? Number(analysis.matchedScore)
        : null,
      matchedNodeId: String(analysis?.matchedNodeId || ""),
    };
  }

  return {
    shouldRun: false,
    minNewNodes,
    reason:
      String(analysis?.reason || "").trim() ||
      `本批只新增 ${safeNewNodeCount} 个节点，低于自动整合门槛 ${minNewNodes}`,
    matchedScore: Number.isFinite(Number(analysis?.matchedScore))
      ? Number(analysis.matchedScore)
      : null,
    matchedNodeId: String(analysis?.matchedNodeId || ""),
  };
}

function evaluateAutoCompressionSchedule(
  currentExtractionCount,
  settings = {},
) {
  const enabled = settings.enableAutoCompression !== false;
  const everyN = clampInt(
    settings.compressionEveryN,
    defaultSettings.compressionEveryN,
    1,
    500,
  );
  const safeExtractionCount = Math.max(0, Number(currentExtractionCount) || 0);

  if (!enabled) {
    return {
      scheduled: false,
      everyN,
      nextExtractionCount: null,
      reason: "自动压缩开关已关闭",
    };
  }

  const remainder = safeExtractionCount % everyN;
  if (remainder !== 0) {
    return {
      scheduled: false,
      everyN,
      nextExtractionCount: safeExtractionCount + (everyN - remainder),
      reason: `当前为第 ${safeExtractionCount} 次提取，未到每 ${everyN} 次自动压缩周期`,
    };
  }

  return {
    scheduled: true,
    everyN,
    nextExtractionCount: safeExtractionCount + everyN,
    reason: "",
  };
}

function buildMaintenanceSummary(action, result, mode = "manual") {
  const prefix = mode === "auto" ? "自动" : "手动";
  switch (String(action || "")) {
    case "compress":
      return `${prefix}压缩：新增 ${result?.created || 0}，归档 ${result?.archived || 0}`;
    case "consolidate":
      return `${prefix}整合：合并 ${result?.merged || 0}，跳过 ${result?.skipped || 0}，保留 ${result?.kept || 0}，进化 ${result?.evolved || 0}，新链接 ${result?.connections || 0}，回溯更新 ${result?.updates || 0}`;
    case "sleep":
      return `${prefix}遗忘：归档 ${result?.forgotten || 0} 个节点`;
    default:
      return `${prefix}维护已执行`;
  }
}

function recordMaintenanceAction({
  action,
  beforeSnapshot,
  mode = "manual",
  summary = "",
} = {}) {
  if (!currentGraph || !beforeSnapshot) return null;
  ensureCurrentGraphRuntimeState();

  const entry = createMaintenanceJournalEntry(
    beforeSnapshot,
    cloneGraphSnapshot(currentGraph),
    {
      action,
      mode,
      summary,
    },
  );
  if (!entry) return null;

  appendMaintenanceJournal(currentGraph, entry);
  recordMaintenanceDebugSnapshot({
    lastAction: {
      id: entry.id,
      action: entry.action,
      mode: entry.mode,
      summary: entry.summary,
      createdAt: entry.createdAt,
      maintenanceJournalSize: currentGraph.maintenanceJournal?.length || 0,
    },
  });
  return entry;
}

function undoLastMaintenanceAction() {
  if (!currentGraph) {
    return { ok: false, reason: "当前没有加载的图谱", entry: null };
  }

  ensureCurrentGraphRuntimeState();
  const result = undoLatestMaintenance(currentGraph);
  recordMaintenanceDebugSnapshot({
    lastUndoResult: {
      ok: Boolean(result?.ok),
      reason: String(result?.reason || ""),
      action: result?.entry?.action || "",
      summary: result?.entry?.summary || "",
      createdAt: result?.entry?.createdAt || 0,
      maintenanceJournalSize: currentGraph.maintenanceJournal?.length || 0,
      updatedAt: new Date().toISOString(),
    },
  });
  return result;
}

function markVectorStateDirty(reason = "向量状态已标记为待重建") {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();
  currentGraph.vectorIndexState.dirty = true;
  currentGraph.vectorIndexState.lastWarning = reason;
}

function updateProcessedHistorySnapshot(chat, lastProcessedAssistantFloor) {
  ensureCurrentGraphRuntimeState();
  applyProcessedHistorySnapshotToGraph(
    currentGraph,
    chat,
    lastProcessedAssistantFloor,
  );
}

function shouldAdvanceProcessedHistory(batchStatus) {
  if (!batchStatus || typeof batchStatus !== "object") return false;
  if (batchStatus.historyAdvanceAllowed === true) {
    return true;
  }
  if (batchStatus.historyAdvanceAllowed === false) {
    return false;
  }
  return (
    batchStatus?.stages?.core?.outcome === "success" &&
    batchStatus?.stages?.finalize?.outcome === "success" &&
    batchStatus?.completed === true
  );
}

function resolveMaintenancePostProcessConcurrency(settings = {}) {
  if (typeof resolveConcurrencyConfig === "function") {
    try {
      return resolveConcurrencyConfig(settings);
    } catch {
    }
  }
  const mode = String(settings?.maintenanceExecutionMode || "strict")
    .trim()
    .toLowerCase();
  const strict = mode !== "balanced" && mode !== "fast";
  return {
    mode: strict ? "strict" : mode,
    level: strict ? 1 : mode === "balanced" ? 2 : 3,
    backgroundMaintenanceMaxRetries: Math.max(
      0,
      Math.min(10, Math.floor(Number(settings?.backgroundMaintenanceMaxRetries ?? 2)) || 0),
    ),
    backgroundMaintenanceRetryBaseMs: Math.max(
      50,
      Math.min(60000, Math.floor(Number(settings?.backgroundMaintenanceRetryBaseMs ?? 800)) || 800),
    ),
    backgroundMaintenanceMaxQueueItems: Math.max(
      1,
      Math.min(256, Math.floor(Number(settings?.backgroundMaintenanceMaxQueueItems ?? 24)) || 24),
    ),
  };
}

function shouldDeferExtractionVectorSync(settings = {}) {
  return resolveMaintenancePostProcessConcurrency(settings).mode !== "strict";
}

function shouldDeferExtractionMaintenance(settings = {}) {
  return resolveMaintenancePostProcessConcurrency(settings).mode !== "strict";
}

function clonePlanCommitValue(value, fallback = null) {
  try {
    if (typeof cloneRuntimeDebugValue === "function") {
      return cloneRuntimeDebugValue(value, fallback);
    }
  } catch {
  }
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

function arePlanCommitValuesEqual(left, right) {
  try {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  } catch {
    return false;
  }
}

function normalizeSummaryStateForPlan(state = {}) {
  try {
    if (typeof createDefaultSummaryState === "function") {
      return createDefaultSummaryState(state);
    }
  } catch {
  }
  const source =
    state && typeof state === "object" && !Array.isArray(state) ? state : {};
  return {
    version: Number(source.version || 1) || 1,
    enabled: source.enabled !== false,
    entries: Array.isArray(source.entries)
      ? clonePlanCommitValue(source.entries, [])
      : [],
    activeEntryIds: Array.isArray(source.activeEntryIds)
      ? [...new Set(source.activeEntryIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [],
    lastSummarizedExtractionCount: Number.isFinite(
      Number(source.lastSummarizedExtractionCount),
    )
      ? Math.max(0, Number(source.lastSummarizedExtractionCount))
      : 0,
    lastSummarizedAssistantFloor: Number.isFinite(
      Number(source.lastSummarizedAssistantFloor),
    )
      ? Number(source.lastSummarizedAssistantFloor)
      : -1,
  };
}

function normalizeGraphSummaryStateForPlan(graph) {
  if (!graph || typeof graph !== "object") return graph;
  try {
    if (typeof normalizeGraphSummaryState === "function") {
      return normalizeGraphSummaryState(graph);
    }
  } catch {
  }
  graph.summaryState = normalizeSummaryStateForPlan(graph.summaryState);
  return graph;
}

function commitPlannedSummaryState(targetGraph, beforeState = {}, draftState = {}) {
  if (!targetGraph || typeof targetGraph !== "object") {
    return {
      summaryEntriesAdded: 0,
      summaryEntriesUpdated: 0,
      summaryEntriesFolded: 0,
    };
  }
  normalizeGraphSummaryStateForPlan(targetGraph);
  const before = normalizeSummaryStateForPlan(beforeState);
  const draft = normalizeSummaryStateForPlan(draftState);
  const target = normalizeSummaryStateForPlan(targetGraph.summaryState);
  const beforeMap = new Map(before.entries.map((entry) => [entry.id, entry]));
  const targetMap = new Map(target.entries.map((entry) => [entry.id, entry]));
  const activeIds = new Set(target.activeEntryIds || []);
  let summaryEntriesAdded = 0;
  let summaryEntriesUpdated = 0;
  let summaryEntriesFolded = 0;

  for (const draftEntry of draft.entries) {
    const entryId = String(draftEntry?.id || "").trim();
    if (!entryId) continue;
    const beforeEntry = beforeMap.get(entryId) || null;
    if (beforeEntry && arePlanCommitValuesEqual(beforeEntry, draftEntry)) {
      continue;
    }
    const clonedEntry = clonePlanCommitValue(draftEntry, draftEntry);
    const targetEntry = targetMap.get(entryId) || null;
    if (targetEntry) {
      Object.assign(targetEntry, clonedEntry);
      summaryEntriesUpdated += 1;
    } else {
      target.entries.push(clonedEntry);
      targetMap.set(entryId, clonedEntry);
      summaryEntriesAdded += 1;
    }
    if (String(clonedEntry.status || "active") === "folded") {
      activeIds.delete(entryId);
      if (beforeEntry && String(beforeEntry.status || "active") !== "folded") {
        summaryEntriesFolded += 1;
      }
    } else {
      activeIds.add(entryId);
    }
  }

  target.lastSummarizedExtractionCount = Math.max(
    Number(target.lastSummarizedExtractionCount || 0),
    Number(draft.lastSummarizedExtractionCount || 0),
  );
  target.lastSummarizedAssistantFloor = Math.max(
    Number(target.lastSummarizedAssistantFloor ?? -1),
    Number(draft.lastSummarizedAssistantFloor ?? -1),
  );
  target.activeEntryIds = [...activeIds].filter(
    (entryId) => String(targetMap.get(entryId)?.status || "active") !== "folded",
  );
  targetGraph.summaryState = target;
  normalizeGraphSummaryStateForPlan(targetGraph);
  return {
    summaryEntriesAdded,
    summaryEntriesUpdated,
    summaryEntriesFolded,
  };
}

function commitPlannedGraphChanges({
  targetGraph = currentGraph,
  beforeSnapshot = null,
  draftGraph = null,
  includeSummaryState = true,
} = {}) {
  const stats = {
    nodesAdded: 0,
    nodesUpdated: 0,
    edgesAdded: 0,
    summaryEntriesAdded: 0,
    summaryEntriesUpdated: 0,
    summaryEntriesFolded: 0,
  };
  if (!targetGraph || !beforeSnapshot || !draftGraph) return stats;
  targetGraph.nodes ||= [];
  targetGraph.edges ||= [];
  const beforeNodes = new Map(
    (beforeSnapshot.nodes || []).map((node) => [String(node?.id || ""), node]),
  );
  const targetNodes = new Map(
    (targetGraph.nodes || []).map((node) => [String(node?.id || ""), node]),
  );

  for (const draftNode of draftGraph.nodes || []) {
    const nodeId = String(draftNode?.id || "").trim();
    if (!nodeId) continue;
    const beforeNode = beforeNodes.get(nodeId) || null;
    if (beforeNode && arePlanCommitValuesEqual(beforeNode, draftNode)) continue;
    const clonedNode = clonePlanCommitValue(draftNode, draftNode);
    const targetNode = targetNodes.get(nodeId) || null;
    if (!targetNode) {
      if (typeof addNode === "function") {
        addNode(targetGraph, clonedNode);
      } else {
        targetGraph.nodes.push(clonedNode);
      }
      targetNodes.set(nodeId, clonedNode);
      stats.nodesAdded += 1;
    } else {
      if (typeof updateNode === "function") {
        updateNode(targetGraph, nodeId, clonePlanCommitValue(clonedNode, clonedNode));
      } else {
        Object.assign(targetNode, clonedNode);
      }
      stats.nodesUpdated += 1;
    }
  }

  const beforeEdgeIds = new Set(
    (beforeSnapshot.edges || []).map((edge) => String(edge?.id || "").trim()),
  );
  const targetEdgeIds = new Set(
    (targetGraph.edges || []).map((edge) => String(edge?.id || "").trim()),
  );
  for (const draftEdge of draftGraph.edges || []) {
    const edgeId = String(draftEdge?.id || "").trim();
    if (!edgeId || beforeEdgeIds.has(edgeId) || targetEdgeIds.has(edgeId)) continue;
    const clonedEdge = clonePlanCommitValue(draftEdge, draftEdge);
    if (typeof addEdge === "function") {
      addEdge(targetGraph, clonedEdge);
    } else {
      targetGraph.edges.push(clonedEdge);
    }
    targetEdgeIds.add(edgeId);
    stats.edgesAdded += 1;
  }

  if (includeSummaryState) {
    Object.assign(
      stats,
      commitPlannedSummaryState(
        targetGraph,
        beforeSnapshot.summaryState,
        draftGraph.summaryState,
      ),
    );
  }
  return stats;
}

function getSummaryPostProcessRunner() {
  if (typeof runHierarchicalSummaryPostProcess === "function") {
    return runHierarchicalSummaryPostProcess;
  }
  if (typeof generateSynopsis === "function") {
    return async (params = {}) => {
      await generateSynopsis({
        graph: params.graph,
        schema: typeof getSchema === "function" ? getSchema() : [],
        currentSeq: params.currentAssistantFloor,
        settings: params.settings,
        signal: params.signal,
      });
      return {
        created: true,
        smallSummary: { created: true, reason: "" },
        rollup: null,
      };
    };
  }
  return async () => ({
    created: false,
    smallSummary: {
      created: false,
      reason: "层级总结运行器不可用，已跳过",
    },
    rollup: null,
  });
}

function getSummaryStageLabel() {
  if (typeof runHierarchicalSummaryPostProcess === "function") return "层级总结";
  if (typeof generateSynopsis === "function") return "旧式全局概要生成";
  return "层级总结";
}

async function runSummaryPostProcessPlanCommit(params = {}) {
  const runner = getSummaryPostProcessRunner();
  const settings = params.settings || {};
  if (resolveMaintenancePostProcessConcurrency(settings).mode === "strict") {
    return await runner(params);
  }
  const beforeSnapshot = clonePlanCommitValue(params.graph, params.graph);
  const draftGraph = clonePlanCommitValue(params.graph, params.graph);
  const result = await runner({
    ...params,
    graph: draftGraph,
  });
  const planCommit = commitPlannedGraphChanges({
    targetGraph: params.graph,
    beforeSnapshot,
    draftGraph,
  });
  return {
    ...(result && typeof result === "object" && !Array.isArray(result)
      ? result
      : { created: Boolean(result) }),
    planCommit,
  };
}

async function runReflectionPostProcessPlanCommit(params = {}) {
  const settings = params.settings || {};
  if (resolveMaintenancePostProcessConcurrency(settings).mode === "strict") {
    const reflectionId = await generateReflection(params);
    return { reflectionId, planCommit: null };
  }
  const beforeSnapshot = clonePlanCommitValue(params.graph, params.graph);
  const draftGraph = clonePlanCommitValue(params.graph, params.graph);
  const reflectionId = await generateReflection({
    ...params,
    graph: draftGraph,
  });
  const planCommit = commitPlannedGraphChanges({
    targetGraph: params.graph,
    beforeSnapshot,
    draftGraph,
  });
  return { reflectionId, planCommit };
}

async function runCompressionPostProcessPlanCommit({
  graph,
  schema = [],
  embeddingConfig = null,
  force = false,
  customPrompt = undefined,
  signal = undefined,
  settings = {},
} = {}) {
  if (resolveMaintenancePostProcessConcurrency(settings).mode === "strict") {
    return await compressAll(
      graph,
      schema,
      embeddingConfig,
      force,
      customPrompt,
      signal,
      settings,
    );
  }
  const beforeSnapshot = clonePlanCommitValue(graph, graph);
  const draftGraph = clonePlanCommitValue(graph, graph);
  const result = await compressAll(
    draftGraph,
    schema,
    embeddingConfig,
    force,
    customPrompt,
    signal,
    settings,
  );
  const planCommit = commitPlannedGraphChanges({
    targetGraph: graph,
    beforeSnapshot,
    draftGraph,
    includeSummaryState: false,
  });
  return {
    ...(result && typeof result === "object" && !Array.isArray(result)
      ? result
      : { created: 0, archived: 0 }),
    planCommit,
  };
}

function updateBackgroundMaintenanceQueueState(snapshot = null) {
  const normalized =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? {
          state: String(snapshot.state || "idle"),
          queued: Math.max(0, Math.floor(Number(snapshot.queued || 0)) || 0),
          activeId: String(snapshot.activeId || ""),
          activeName: String(snapshot.activeName || ""),
          completed: Math.max(0, Math.floor(Number(snapshot.completed || 0)) || 0),
          failed: Math.max(0, Math.floor(Number(snapshot.failed || 0)) || 0),
          dropped: Math.max(0, Math.floor(Number(snapshot.dropped || 0)) || 0),
          lastTask:
            snapshot.lastTask && typeof snapshot.lastTask === "object"
              ? { ...snapshot.lastTask }
              : null,
          updatedAt: Number(snapshot.updatedAt || Date.now()) || Date.now(),
        }
      : {
          state: "idle",
          queued: 0,
          activeId: "",
          activeName: "",
          completed: 0,
          failed: 0,
          dropped: 0,
          lastTask: null,
          updatedAt: Date.now(),
        };
  if (typeof updateGraphPersistenceState === "function") {
    updateGraphPersistenceState({ backgroundMaintenance: normalized });
  }
  if (typeof recordMaintenanceDebugSnapshot === "function") {
    recordMaintenanceDebugSnapshot({ backgroundQueue: normalized });
  }
  if (typeof refreshPanelLiveState === "function") {
    refreshPanelLiveState();
  }
  return normalized;
}

function enqueueBackgroundMaintenanceTask(name, run, settings = {}, options = {}) {
  const concurrency = resolveMaintenancePostProcessConcurrency(settings);
  const queue =
    typeof backgroundMaintenanceQueue !== "undefined"
      ? backgroundMaintenanceQueue
      : null;
  if (!queue || typeof queue.enqueue !== "function") {
    return {
      queued: false,
      reason: "background-maintenance-queue-unavailable",
      snapshot: updateBackgroundMaintenanceQueueState(null),
    };
  }
  if (typeof queue.configure === "function") {
    queue.configure({
      maxItems: concurrency.backgroundMaintenanceMaxQueueItems,
      maxRetries: concurrency.backgroundMaintenanceMaxRetries,
      retryBaseMs: concurrency.backgroundMaintenanceRetryBaseMs,
      onStatus: updateBackgroundMaintenanceQueueState,
    });
  }
  return queue.enqueue(name, run, {
    maxRetries: concurrency.backgroundMaintenanceMaxRetries,
    retryBaseMs: concurrency.backgroundMaintenanceRetryBaseMs,
    ...(options || {}),
  });
}

function computePostProcessArtifacts(
  beforeSnapshot,
  afterSnapshot,
  extraTags = [],
) {
  const beforeNodeIds = new Set(
    (beforeSnapshot?.nodes || []).map((node) => node.id),
  );
  const afterNodes = afterSnapshot?.nodes || [];
  const tags = new Set(extraTags.filter(Boolean));

  for (const node of afterNodes) {
    if (!beforeNodeIds.has(node.id)) {
      if (node.type === "synopsis") tags.add("synopsis");
      if (node.type === "reflection") tags.add("reflection");
      if (node.level > 0) tags.add("compression");
    }
  }

  const beforeNodes = new Map(
    (beforeSnapshot?.nodes || []).map((node) => [node.id, node]),
  );
  for (const node of afterNodes) {
    const beforeNode = beforeNodes.get(node.id);
    if (!beforeNode) continue;
    if (!beforeNode.archived && node.archived) {
      tags.add(node.level > 0 ? "compression-archive" : "sleep/archive");
    }
  }

  return [...tags];
}

async function syncVectorState({
  force = false,
  purge = false,
  range = null,
  signal = undefined,
} = {}) {
  ensureCurrentGraphRuntimeState();
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
      chatId: getCurrentChatId(),
      force,
      purge,
      range,
      signal,
      headerProvider:
        typeof getRequestHeaders === "function" ? () => getRequestHeaders() : null,
    });
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
    console.error("[ST-BME] 向量同步失败:", error);
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

function scheduleBackgroundVectorSync(task = null, settings = {}) {
  const normalizedTask =
    task && typeof task === "object" && !Array.isArray(task) ? task : {};
  const range =
    normalizedTask.range &&
    Number.isFinite(Number(normalizedTask.range.start)) &&
    Number.isFinite(Number(normalizedTask.range.end))
      ? {
          start: Math.floor(Number(normalizedTask.range.start)),
          end: Math.floor(Number(normalizedTask.range.end)),
        }
      : null;
  const reason =
    String(normalizedTask.reason || "background-vector-sync").trim() ||
    "background-vector-sync";
  const mode =
    String(
      normalizedTask.mode ||
        resolveMaintenancePostProcessConcurrency(settings).mode ||
        "balanced",
    ).trim() || "balanced";
  return enqueueBackgroundMaintenanceTask(
    "vector-sync",
    async () => {
      setLastVectorStatus(
        "后台向量同步中",
        `${mode} 模式 · 正在同步提取后的向量索引`,
        "running",
        { syncRuntime: false },
      );
      const result = await syncVectorState({ range });
      if (result?.aborted) {
        throw createAbortError(result.error || "后台向量同步已终止");
      }
      if (result?.error) {
        throw new Error(result.error);
      }
      saveGraphToChat({ reason });
      return result;
    },
    settings,
    {
      id: String(normalizedTask.id || ""),
    },
  );
}

function hasPlanCommitChanges(planCommit = null) {
  if (!planCommit || typeof planCommit !== "object") return false;
  return [
    "nodesAdded",
    "nodesUpdated",
    "edgesAdded",
    "summaryEntriesAdded",
    "summaryEntriesUpdated",
    "summaryEntriesFolded",
  ].some((key) => Number(planCommit[key] || 0) > 0);
}

function scheduleBackgroundMaintenancePostProcess(tasks = [], settings = {}) {
  const taskList = Array.isArray(tasks)
    ? tasks.filter((task) => task && typeof task === "object" && task.type)
    : [];
  if (!taskList.length) {
    return {
      queued: false,
      reason: "no-background-maintenance-tasks",
      snapshot: updateBackgroundMaintenanceQueueState(null),
    };
  }
  const scheduledSettings = clonePlanCommitValue(settings, settings) || settings;
  const mode = resolveMaintenancePostProcessConcurrency(scheduledSettings).mode;
  const taskId = taskList.map((task) => String(task.id || task.type)).join("+");
  return enqueueBackgroundMaintenanceTask(
    "post-process",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      ensureCurrentGraphRuntimeState();
      const details = [];
      let changed = false;
      if (typeof setLastExtractionStatus === "function") {
        setLastExtractionStatus(
          "后台维护中",
          `${mode} 模式 · 正在执行 ${taskList.map((task) => task.type).join(" / ")}`,
          "running",
          { syncRuntime: false },
        );
      }
      for (const task of taskList) {
        const type = String(task.type || "").trim();
        const payload =
          task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
            ? task.payload
            : {};
        if (type === "summary") {
          const result = await runSummaryPostProcessPlanCommit({
            graph: currentGraph,
            chat: Array.isArray(payload.chat)
              ? payload.chat
              : typeof getContext === "function" && Array.isArray(getContext()?.chat)
                ? getContext().chat
                : [],
            settings: scheduledSettings,
            currentExtractionCount: Number(payload.currentExtractionCount || 0) || extractionCount,
            currentAssistantFloor: Number(payload.currentAssistantFloor ?? -1),
            currentRange: Array.isArray(payload.currentRange) ? payload.currentRange : null,
            currentNodeIds: Array.isArray(payload.currentNodeIds) ? payload.currentNodeIds : [],
          });
          const taskChanged =
            Boolean(result?.smallSummary?.created) ||
            Number(result?.rollup?.createdCount || 0) > 0 ||
            hasPlanCommitChanges(result?.planCommit);
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        } else if (type === "reflection") {
          const result = await runReflectionPostProcessPlanCommit({
            graph: currentGraph,
            currentSeq: Number(payload.currentSeq ?? -1),
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            settings: scheduledSettings,
          });
          const taskChanged =
            Boolean(result?.reflectionId) || hasPlanCommitChanges(result?.planCommit);
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        } else if (type === "compression") {
          const beforeSnapshot =
            typeof cloneGraphSnapshot === "function"
              ? cloneGraphSnapshot(currentGraph)
              : clonePlanCommitValue(currentGraph, currentGraph);
          const result = await runCompressionPostProcessPlanCommit({
            graph: currentGraph,
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            force: Boolean(payload.force),
            customPrompt: payload.customPrompt ?? undefined,
            settings: scheduledSettings,
          });
          const taskChanged =
            Number(result?.created || 0) > 0 ||
            Number(result?.archived || 0) > 0 ||
            hasPlanCommitChanges(result?.planCommit);
          if (taskChanged) {
            const compressionSummary =
              typeof buildMaintenanceSummary === "function"
                ? buildMaintenanceSummary("compress", result, "auto")
                : `自动压缩：新增 ${result?.created || 0}，归档 ${result?.archived || 0}`;
            if (typeof recordMaintenanceAction === "function") {
              recordMaintenanceAction({
                action: "compress",
                beforeSnapshot,
                mode: "auto",
                summary: compressionSummary,
              });
            }
          }
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        }
      }
      if (changed) {
        saveGraphToChat({
          reason: `background-post-process:${taskList.map((task) => task.type).join("+")}`,
        });
      }
      if (typeof setLastExtractionStatus === "function") {
        setLastExtractionStatus(
          changed ? "后台维护完成" : "后台维护跳过",
          changed ? "后台维护已完成并持久化" : "后台维护未产生可持久化变化",
          changed ? "success" : "warning",
          { syncRuntime: false },
        );
      }
      return { changed, details };
    },
    scheduledSettings,
    {
      id: `post-process:${taskId}`,
    },
  );
}

async function ensureVectorReadyIfNeeded(
  reason = "vector-ready-check",
  signal = undefined,
) {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();
  if (!isGraphMetadataWriteAllowed()) return;

  if (!currentGraph.vectorIndexState?.dirty) return;

  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);
  if (!validation.valid) return;

  const result = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(config),
    signal,
  });

  if (result?.error) {
    currentGraph.vectorIndexState.lastWarning = result.error;
    saveGraphToChat({ reason: "vector-auto-repair-failed" });
    console.warn("[ST-BME] 向量状态自动修复失败:", reason, result.error);
    return result;
  }

  currentGraph.vectorIndexState.lastWarning = "";
  saveGraphToChat({ reason: "vector-auto-repair-succeeded" });
  debugLog("[ST-BME] 向量状态已自动修复:", reason, result.stats);
  return result;
}

async function resetVectorStateForConfigChange(reason = "向量配置已变更") {
  if (!currentGraph) return;
  ensureCurrentGraphRuntimeState();
  markVectorStateDirty(reason);
  currentGraph.vectorIndexState.hashToNodeId = {};
  currentGraph.vectorIndexState.nodeToHash = {};
  currentGraph.vectorIndexState.lastStats = {
    total: 0,
    indexed: 0,
    stale: 0,
    pending: 0,
  };
  saveGraphToChat({ reason: "vector-config-reset" });
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function loadServerSettings() {
  try {
    const response = await fetch(`${SERVER_SETTINGS_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(response.statusText || `HTTP ${response.status}`);
    }

    const loaded = await response.json();
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      extension_settings[MODULE_NAME] = mergePersistedSettings(loaded);
      globalThis.__stBmeDebugLoggingEnabled = Boolean(
        extension_settings[MODULE_NAME]?.debugLoggingEnabled,
      );
      saveSettingsDebounced();
    }
  } catch (error) {
    console.warn("[ST-BME] 读取服务端设置失败，回退到本地运行时设置:", error);
  }
}

async function saveServerSettings(settings = getSettings()) {
  const payload = JSON.stringify(
    getPersistedSettingsSnapshot(settings),
    null,
    2,
  );

  const response = await fetch("/api/files/upload", {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({
      name: SERVER_SETTINGS_FILENAME,
      data: encodeBase64Utf8(payload),
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

function scheduleServerSettingsSave() {
  clearTimeout(serverSettingsSaveTimer);
  serverSettingsSaveTimer = setTimeout(async () => {
    try {
      await saveServerSettings();
    } catch (error) {
      console.error("[ST-BME] 保存服务端设置失败:", error);
    }
  }, 300);
}

function updateModuleSettings(patch = {}) {
  const vectorConfigKeys = new Set([
    "embeddingApiUrl",
    "embeddingApiKey",
    "embeddingModel",
    "embeddingTransportMode",
    "embeddingBackendSource",
    "embeddingBackendModel",
    "embeddingBackendApiUrl",
    "embeddingAutoSuffix",
  ]);
  const messageHideKeys = new Set([
    "hideOldMessagesEnabled",
    "hideOldMessagesKeepLastN",
  ]);
  const messageRenderLimitKeys = new Set([
    "enabled",
    "hideOldMessagesRenderLimitEnabled",
    "hideOldMessagesRenderLimit",
  ]);
  const recallUiKeys = new Set(["recallCardUserInputDisplayMode"]);
  const noticeUiKeys = new Set(["noticeDisplayMode"]);
  const authorityKeys = new Set([
    "authorityEnabled",
    "authorityBaseUrl",
    "authorityPrimaryWhenAvailable",
    "authorityStorageMode",
    "authorityVectorMode",
    "authoritySqlPrimary",
    "authorityTriviumPrimary",
    "authorityGraphQueryEnabled",
    "authorityJobsEnabled",
    "authorityBlobCheckpointEnabled",
    "authorityBrowserCacheMode",
    "authorityOfflineWritePolicy",
    "authorityOfflineQueueMaxBytes",
    "authorityOfflineQueueMaxItems",
    "authorityOfflineQueueMaxAgeMs",
    "authorityVectorSyncChunkSize",
    "authorityVectorFailOpen",
    "authorityDiagnosticsEnabled",
    "authorityProbeIntervalMs",
  ]);
  const settings = getSettings();
  const previousCloudStorageMode = String(
    settings.cloudStorageMode || "automatic",
  );
  const previousGraphLocalStorageMode = getRequestedGraphLocalStorageMode(
    settings,
  );
  Object.assign(settings, patch);
  extension_settings[MODULE_NAME] = settings;
  globalThis.__stBmeDebugLoggingEnabled = Boolean(
    settings.debugLoggingEnabled,
  );
  saveSettingsDebounced();

  if (
    Object.prototype.hasOwnProperty.call(patch, "enabled") &&
    patch.enabled === false
  ) {
    abortAllRunningStages();
    dismissAllStageNotices();
    try {
      applyModuleInjectionPrompt("", settings);
      lastInjectionContent = "";
      lastRecalledItems = [];
      runtimeStatus = createUiStatus(
        "已停用",
        "插件已关闭，注入内容已清空",
        "idle",
      );
      lastExtractionStatus = createUiStatus(
        "已停用",
        "插件已关闭，自动提取已停止",
        "idle",
      );
      lastVectorStatus = createUiStatus(
        "已停用",
        "插件已关闭，向量任务已停止",
        "idle",
      );
      lastRecallStatus = createUiStatus(
        "已停用",
        "插件已关闭，注入内容已清空",
        "idle",
      );
      refreshPanelLiveState();
    } catch (error) {
      console.warn("[ST-BME] 关闭插件时清理注入失败:", error);
    }
  }

  if (Object.keys(patch).some((key) => vectorConfigKeys.has(key))) {
    void resetVectorStateForConfigChange(
      "Embedding 配置已变更，向量索引待重建",
    );
  }

  if (Object.keys(patch).some((key) => messageHideKeys.has(key))) {
    const hideSettings = getMessageHideSettings(settings);
    if (!hideSettings.enabled || hideSettings.hide_last_n <= 0) {
      void clearAllHiddenMessages("settings-updated-disable");
    } else {
      scheduleMessageHideApply("settings-updated", 30);
    }
  }

  if (Object.keys(patch).some((key) => messageRenderLimitKeys.has(key))) {
    const renderResult = applyMessageRenderLimit(settings, {
      clearWhenDisabled: true,
      reloadCurrentChat: true,
    });
    debugLog("[ST-BME] 已同步聊天区渲染楼层限制:", renderResult);
  }

  if (Object.keys(patch).some((key) => recallUiKeys.has(key))) {
    schedulePersistedRecallMessageUiRefresh(30);
  }

  if (Object.keys(patch).some((key) => noticeUiKeys.has(key))) {
    refreshVisibleStageNotices();
  }

  if (Object.keys(patch).some((key) => authorityKeys.has(key))) {
    void refreshAuthorityRuntimeState({
      force: true,
      source: "settings-updated",
    });
  }

  const currentGraphLocalStorageMode = getRequestedGraphLocalStorageMode(
    settings,
  );
  if (previousGraphLocalStorageMode !== currentGraphLocalStorageMode) {
    clearAllCachedIndexedDbSnapshots();
    scheduleBmeIndexedDbTask(async () => {
      if (bmeChatManager && typeof bmeChatManager.closeAll === "function") {
        await bmeChatManager.closeAll();
      }
      await syncBmeChatManagerWithCurrentChat(
        "settings:graph-local-storage-mode-changed",
      );
    });
  }

  const currentCloudStorageMode = String(
    settings.cloudStorageMode || "automatic",
  );
  if (
    previousCloudStorageMode !== "automatic"
    && currentCloudStorageMode === "automatic"
  ) {
    const chatId = getCurrentChatId();
    if (chatId) {
      scheduleBmeIndexedDbTask(async () => {
        try {
          await syncNow(
            chatId,
            buildBmeSyncRuntimeOptions({
              reason: "mode-switch-bootstrap",
              trigger: "settings:cloud-storage-mode-bootstrap",
            }),
          );
          await syncIndexedDbMetaToPersistenceState(chatId, {
            syncState: "idle",
            lastSyncError: "",
          });
        } catch (error) {
          await syncIndexedDbMetaToPersistenceState(chatId, {
            syncState: "error",
            lastSyncError: error?.message || String(error),
          });
        }
      });
    }
  }

  scheduleServerSettingsSave();
  return settings;
}

// ==================== 图状态持久化 ====================

function loadGraphFromChat(options = {}) {
  const {
    attemptIndex = 0,
    expectedChatId = "",
    source = "direct-load",
    allowMetadataFallback = true,
  } = options;
  const context = getContext();
  const chatIdentity = resolveCurrentChatIdentity(context);
  const chatId = chatIdentity.chatId;
  const commitMarker = syncCommitMarkerToPersistenceState(context);
  const shadowSnapshot = resolveCompatibleGraphShadowSnapshot(chatIdentity);
  const normalizedExpectedChatId = String(expectedChatId || "");
  if (attemptIndex === 0) {
    clearPendingGraphLoadRetry();
  }

  if (
    normalizedExpectedChatId &&
    chatId &&
    normalizedExpectedChatId !== chatId
  ) {
    clearPendingGraphLoadRetry();
    return {
      success: false,
      loaded: false,
      loadState: graphPersistenceState.loadState,
      reason: "expected-chat-mismatch",
      chatId,
      attemptIndex,
    };
  }

  if (!chatId) {
    if (chatIdentity.hasLikelySelectedChat) {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), "");
      extractionCount = 0;
      lastExtractedItems = [];
      lastRecalledItems = [];
      lastInjectionContent = "";
      runtimeStatus = createUiStatus(
        "图谱加载中",
        "正在等待当前聊天会话 ID 就绪",
        "running",
      );
      lastExtractionStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      lastVectorStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      lastRecallStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
        chatId: "",
        reason: "chat-id-missing",
        attemptIndex,
        revision: 0,
        lastPersistedRevision: 0,
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        pendingPersist: false,
        shadowSnapshotUsed: false,
        shadowSnapshotRevision: 0,
        shadowSnapshotUpdatedAt: "",
        shadowSnapshotReason: "",
        dbReady: false,
        writesBlocked: true,
      });
      refreshPanelLiveState();
      return {
        success: false,
        loaded: false,
        loadState: GRAPH_LOAD_STATES.LOADING,
        reason: "chat-id-missing",
        chatId: "",
        attemptIndex,
      };
    }

    clearPendingGraphLoadRetry();
    currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), "");
    extractionCount = 0;
    lastExtractedItems = [];
    lastRecalledItems = [];
    lastInjectionContent = "";
    runtimeStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    lastExtractionStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    lastVectorStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    lastRecallStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    applyGraphLoadState(GRAPH_LOAD_STATES.NO_CHAT, {
      chatId: "",
      reason: "no-chat",
      attemptIndex,
      revision: 0,
      lastPersistedRevision: 0,
      queuedPersistRevision: 0,
      queuedPersistChatId: "",
      pendingPersist: false,
      shadowSnapshotUsed: false,
      shadowSnapshotRevision: 0,
      shadowSnapshotUpdatedAt: "",
      shadowSnapshotReason: "",
      writesBlocked: true,
    });

    refreshPanelLiveState();
    return {
      success: false,
      loaded: false,
      loadState: GRAPH_LOAD_STATES.NO_CHAT,
      reason: "no-chat",
      chatId: "",
      attemptIndex,
    };
  }

  if (canUseHostGraphChatStatePersistence(context)) {
    scheduleGraphChatStateProbe(chatId, {
      source: `${source}:chat-state-probe`,
      attemptIndex,
      allowOverride: true,
    });
  }

  const preferredLocalStore = getPreferredGraphLocalStorePresentationSync();
  const cachedSnapshot = readCachedIndexedDbSnapshot(
    chatId,
    preferredLocalStore,
  );
  if (isIndexedDbSnapshotMeaningful(cachedSnapshot)) {
    const cachedStore = resolveSnapshotGraphStorePresentation(
      cachedSnapshot,
      preferredLocalStore,
    );
    const cachedResult = applyIndexedDbSnapshotToRuntime(
      chatId,
      cachedSnapshot,
      {
        source: `${source}:indexeddb-cache`,
        attemptIndex,
        storagePrimary: cachedStore.storagePrimary,
        storageMode: cachedStore.storageMode,
        statusLabel: cachedStore.statusLabel,
        reasonPrefix: cachedStore.reasonPrefix,
      },
    );
    if (cachedResult?.reason === `${cachedStore.reasonPrefix}-stale-runtime`) {
      clearPendingGraphLoadRetry();
      refreshPanelLiveState();
      return {
        success: false,
        loaded: false,
        loadState: graphPersistenceState.loadState,
        reason: "indexeddb-cache-stale-runtime",
        chatId,
        attemptIndex,
        staleDetail: cloneRuntimeDebugValue(cachedResult?.staleDetail, null),
      };
    }
    if (cachedResult?.loaded) {
      clearPendingGraphLoadRetry();
      return cachedResult;
    }
  }

  const savedData = allowMetadataFallback
    ? context?.chatMetadata?.[GRAPH_METADATA_KEY]
    : undefined;
  if (savedData != null && savedData !== "") {
    try {
      const hydratedOfficialGraph = normalizeGraphRuntimeState(
        deserializeGraph(savedData),
        chatId,
      );
      const officialGraph =
        typeof savedData === "string"
          ? hydratedOfficialGraph
          : cloneGraphForPersistence(hydratedOfficialGraph, chatId);
      const shadowDecision = shouldPreferShadowSnapshotOverOfficial(
        officialGraph,
        shadowSnapshot,
      );
      const officialRevision = Math.max(
        1,
        getGraphPersistedRevision(officialGraph),
      );
      const officialSnapshot = buildSnapshotFromGraph(officialGraph, {
        chatId,
        revision: officialRevision,
      });
      const metadataCommitMismatch = detectIndexedDbSnapshotCommitMarkerMismatch(
        officialSnapshot,
        commitMarker,
      );
      const officialRuntimeStaleDecision =
        detectStaleIndexedDbSnapshotAgainstRuntime(
          chatId,
          officialSnapshot,
          {
            identity: chatIdentity,
          },
        );

      if (officialRuntimeStaleDecision.stale) {
        clearPendingGraphLoadRetry();
        updateGraphPersistenceState({
          metadataIntegrity: getChatMetadataIntegrity(context),
          dualWriteLastResult: {
            action: "load",
            source: `${source}:metadata-compat`,
            success: false,
            provisional: true,
            rejected: true,
            reason: "metadata-compat-stale-runtime",
            revision: officialRevision,
            staleDetail: cloneRuntimeDebugValue(
              officialRuntimeStaleDecision,
              null,
            ),
            at: Date.now(),
          },
        });
        refreshPanelLiveState();
        return {
          success: false,
          loaded: false,
          loadState: graphPersistenceState.loadState,
          reason: "metadata-compat-stale-runtime",
          chatId,
          attemptIndex,
          staleDetail: cloneRuntimeDebugValue(
            officialRuntimeStaleDecision,
            null,
          ),
        };
      }

      let metadataMismatchDiagnostic = null;
      if (metadataCommitMismatch.mismatched) {
        clearPendingGraphLoadRetry();
        metadataMismatchDiagnostic = recordPersistMismatchDiagnostic(
          metadataCommitMismatch,
          {
            source: `${source}:metadata-compat`,
          },
        );
        if (
          shadowSnapshot &&
          Number(shadowSnapshot.revision || 0) >=
            Number(metadataCommitMismatch.markerRevision || 0)
        ) {
          const shadowResult = applyShadowSnapshotToRuntime(chatId, shadowSnapshot, {
            source: `${source}:metadata-shadow`,
            attemptIndex,
          });
          if (shadowResult?.loaded && metadataMismatchDiagnostic?.reason) {
            updateGraphPersistenceState({
              persistMismatchReason: metadataMismatchDiagnostic.reason,
            });
          }
          return shadowResult;
        }
      }

      if (shadowSnapshot && shadowDecision?.reason) {
        updateGraphPersistenceState({
          dualWriteLastResult: {
            action: "shadow-compare",
            source: `${source}:metadata-shadow-compare`,
            success: Boolean(shadowDecision.prefer),
            reason: shadowDecision.reason,
            resultCode: String(shadowDecision.resultCode || ""),
            shadowRevision: Number(shadowSnapshot.revision || 0),
            officialRevision,
            at: Date.now(),
          },
        });
      }

      if (shadowSnapshot && shadowDecision?.prefer) {
        clearPendingGraphLoadRetry();
        return applyShadowSnapshotToRuntime(chatId, shadowSnapshot, {
          source: `${source}:metadata-shadow`,
          attemptIndex,
        });
      }

      clearPendingGraphLoadRetry();
      currentGraph = officialGraph;
      stampGraphPersistenceMeta(currentGraph, {
        revision: officialRevision,
        reason: `${source}:metadata-compat-provisional`,
        chatId,
        integrity: getChatMetadataIntegrity(context),
      });
      extractionCount = Number.isFinite(
        currentGraph?.historyState?.extractionCount,
      )
        ? currentGraph.historyState.extractionCount
        : 0;
      lastExtractedItems = [];
      const restoredRecallUi = restoreRecallUiStateFromPersistence(
        context?.chat,
      );
      runtimeStatus = createUiStatus(
        "图谱加载中",
        "已从兼容 metadata 暂载图谱，等待 IndexedDB 权威确认",
        "running",
      );
      lastExtractionStatus = createUiStatus(
        "待命",
        "兼容图谱暂载中，等待 IndexedDB 确认后再执行提取",
        "idle",
      );
      lastVectorStatus = createUiStatus(
        "待命",
        currentGraph.vectorIndexState?.lastWarning ||
          "兼容图谱暂载中，等待 IndexedDB 确认后再执行向量任务",
        "idle",
      );
      lastRecallStatus = createUiStatus(
        "待命",
        restoredRecallUi.restored
          ? "已从持久化召回记录恢复显示，等待 IndexedDB 权威确认"
          : "兼容图谱暂载中，等待 IndexedDB 确认后再执行召回",
        "idle",
      );
      applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
        chatId,
        reason: `${source}:metadata-compat-provisional`,
        attemptIndex,
        revision: officialRevision,
        lastPersistedRevision: officialRevision,
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        pendingPersist: false,
        shadowSnapshotUsed: false,
        shadowSnapshotRevision: Number(shadowSnapshot?.revision || 0),
        shadowSnapshotUpdatedAt: String(shadowSnapshot?.updatedAt || ""),
        shadowSnapshotReason: String(
          shadowDecision?.reason || shadowSnapshot?.reason || "",
        ),
        dbReady: false,
        writesBlocked: true,
      });
      updateGraphPersistenceState({
        metadataIntegrity: getChatMetadataIntegrity(context),
        storagePrimary: getPreferredGraphLocalStorePresentationSync().storagePrimary,
        storageMode: getPreferredGraphLocalStorePresentationSync().storageMode,
        dbReady: false,
        indexedDbLastError: "",
        persistMismatchReason:
          metadataMismatchDiagnostic?.reason ||
          graphPersistenceState.persistMismatchReason ||
          "",
        dualWriteLastResult: {
          action: "load",
          source: `${source}:metadata-compat`,
          success: true,
          provisional: true,
          revision: officialRevision,
          resultCode: "graph.load.metadata-compat.provisional",
          reason: `${source}:metadata-compat-provisional`,
          at: Date.now(),
        },
      });
      rememberResolvedGraphIdentityAlias(context, chatId);

      scheduleIndexedDbGraphProbe(chatId, {
        source: `${source}:indexeddb-probe`,
        attemptIndex,
        allowOverride: true,
        applyEmptyState: true,
      });

      refreshPanelLiveState();
      schedulePersistedRecallMessageUiRefresh(30);
      return {
        success: true,
        loaded: true,
        loadState: GRAPH_LOAD_STATES.LOADING,
        reason: `${source}:metadata-compat-provisional`,
        chatId,
        attemptIndex,
      };
    } catch (error) {
      console.warn(
        "[ST-BME] 兼容 metadata 图谱读取失败，将回退 IndexedDB:",
        error,
      );
    }
  }

  if (shadowSnapshot) {
    const acceptedCommitRevision = getAcceptedCommitMarkerRevision(commitMarker);
    let shadowOnlyMismatch = null;
    if (
      acceptedCommitRevision > 0 &&
      Number(shadowSnapshot.revision || 0) < acceptedCommitRevision
    ) {
      clearPendingGraphLoadRetry();
      shadowOnlyMismatch = recordPersistMismatchDiagnostic(
        {
          mismatched: true,
          reason: "persist-mismatch:indexeddb-behind-commit-marker",
          markerRevision: acceptedCommitRevision,
          snapshotRevision: Number(shadowSnapshot.revision || 0),
          marker: commitMarker,
        },
        {
          source: `${source}:shadow-no-official`,
          resolvedBy: "shadow",
        },
      );
    }
    clearPendingGraphLoadRetry();
    const shadowResult = applyShadowSnapshotToRuntime(chatId, shadowSnapshot, {
      source: `${source}:shadow-no-official`,
      attemptIndex,
    });
    if (shadowOnlyMismatch?.reason && shadowResult?.loaded) {
      updateGraphPersistenceState({
        persistMismatchReason: shadowOnlyMismatch.reason,
      });
    }
    return shadowResult;
  }

  applyGraphLoadState(GRAPH_LOAD_STATES.LOADING, {
    chatId,
    reason: `indexeddb-probe-pending:${String(source || "direct-load")}`,
    attemptIndex,
    dbReady: false,
    writesBlocked: true,
  });
  updateGraphPersistenceState({
    storagePrimary: getPreferredGraphLocalStorePresentationSync().storagePrimary,
    storageMode: getPreferredGraphLocalStorePresentationSync().storageMode,
    dbReady: false,
    indexedDbLastError: "",
  });
  scheduleIndexedDbGraphProbe(chatId, {
    source: `${source}:indexeddb-probe`,
    attemptIndex,
    allowOverride: true,
    applyEmptyState: true,
  });
  refreshPanelLiveState();

  return {
    success: false,
    loaded: false,
    loadState: GRAPH_LOAD_STATES.LOADING,
    reason: "indexeddb-probe-pending",
    chatId,
    attemptIndex,
  };
}

async function saveGraphToIndexedDb(
  chatId,
  graph,
  {
    revision = 0,
    reason = "graph-save",
    persistRole = "primary",
    scheduleCloudUpload: scheduleCloudUploadOption = undefined,
    persistDelta = null,
    graphSnapshot = null,
    persistSnapshot = null,
    sourceGraph = null,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || (!graph && !persistDelta)) {
    recordLocalPersistEarlyFailure("indexeddb-missing-chat-graph-or-delta", {
      chatId: normalizedChatId,
      revision,
    });
    return {
      saved: false,
      chatId: normalizedChatId,
      reason: "indexeddb-missing-chat-graph-or-delta",
      revision: normalizeIndexedDbRevision(revision),
    };
  }

  const context = getContext();
  let db = null;
  let localStore = getPreferredGraphLocalStorePresentationSync();
  try {
    const manager = ensureBmeChatManager();
    if (!manager) {
      recordLocalPersistEarlyFailure("indexeddb-manager-unavailable", {
        chatId: normalizedChatId,
        revision,
      });
      return {
        saved: false,
        chatId: normalizedChatId,
        reason: "indexeddb-manager-unavailable",
        revision: normalizeIndexedDbRevision(revision),
      };
    }
    db = await manager.getCurrentDb(normalizedChatId);
    if (!db) {
      recordLocalPersistEarlyFailure("indexeddb-db-unavailable", {
        chatId: normalizedChatId,
        revision,
      });
      return {
        saved: false,
        chatId: normalizedChatId,
        reason: "indexeddb-db-unavailable",
        revision: normalizeIndexedDbRevision(revision),
      };
    }
    localStore = resolveDbGraphStorePresentation(db);
    const persistenceEnvironment = buildPersistenceEnvironment(context, localStore);
    const localStoreTier = resolveLocalStoreTierFromPresentation(localStore);
    const currentIdentity = resolveCurrentChatIdentity(context);
    const requestedRevision = resolvePersistRevisionFloor(revision, graph);
    const currentSettings = getSettings();
    const shouldScheduleCloudUpload =
      scheduleCloudUploadOption != null
        ? scheduleCloudUploadOption === true
        : persistenceEnvironment.primaryStorageTier !== "authority-sql" &&
          persistenceEnvironment.hostProfile !== "luker" &&
          persistRole !== "cache-mirror";
    const directPersistDelta =
      persistDelta &&
      typeof persistDelta === "object" &&
      !Array.isArray(persistDelta)
        ? cloneRuntimeDebugValue(persistDelta, persistDelta)
        : null;
    const detachedGraphSnapshot =
      graphSnapshot &&
      typeof graphSnapshot === "object" &&
      !Array.isArray(graphSnapshot)
        ? graphSnapshot
        : null;
    const prebuiltPersistSnapshot =
      persistSnapshot &&
      typeof persistSnapshot === "object" &&
      !Array.isArray(persistSnapshot)
        ? persistSnapshot
        : null;
    const sourceGraphInput =
      sourceGraph && typeof sourceGraph === "object" && !Array.isArray(sourceGraph)
        ? sourceGraph
        : null;
    const persistGraphInput = detachedGraphSnapshot || graph;
    let baseSnapshot = null;
    let snapshot = prebuiltPersistSnapshot;
    let delta = directPersistDelta;
    let persistDeltaBuildDiagnostics = null;
    let dirtyPersistDeltaVersion = 0;
    let dirtyPersistUsed = false;
    let nativePersistModuleStatus = null;
    let nativePersistPreloadStatus = "not-requested";
    let nativePersistPreloadError = "";
    let nativePersistPreloadMs = 0;
    let baseSnapshotReadMs = 0;
    let graphSnapshotBuildMs = 0;
    let snapshotBuildDiagnostics = null;
    const persistDeltaStartedAt = readPersistDeltaDiagnosticsNow();

    if (!delta) {
      const baseSnapshotReadStartedAt = readPersistDeltaDiagnosticsNow();
      baseSnapshot = readCachedIndexedDbSnapshot(normalizedChatId, localStore);
      if (!baseSnapshot) {
        baseSnapshot = await db.exportSnapshot();
      }
      baseSnapshotReadMs =
        readPersistDeltaDiagnosticsNow() - baseSnapshotReadStartedAt;
      if (persistGraphInput) {
        delta = buildPersistDeltaFromGraphDirtyState(baseSnapshot, persistGraphInput, {
          chatId: normalizedChatId,
          revision: requestedRevision,
          lastModified: Date.now(),
          meta: {
            storagePrimary: localStore.storagePrimary,
            storageMode: localStore.storageMode,
            lastMutationReason: String(reason || "graph-save"),
            integrity:
              currentIdentity.integrity || graphPersistenceState.metadataIntegrity,
            hostChatId: currentIdentity.hostChatId || "",
          },
          onDiagnostics(snapshotValue) {
            persistDeltaBuildDiagnostics =
              snapshotValue &&
              typeof snapshotValue === "object" &&
              !Array.isArray(snapshotValue)
                ? snapshotValue
                : null;
          },
        });
        dirtyPersistUsed = Boolean(delta);
        dirtyPersistDeltaVersion = Math.max(
          0,
          Math.floor(Number(persistDeltaBuildDiagnostics?.dirtyStateVersion || 0)),
        );
        if (dirtyPersistUsed) {
          snapshot = applyPersistDeltaToSnapshot(baseSnapshot, delta, {
            chatId: normalizedChatId,
            revision: requestedRevision,
            lastModified: Date.now(),
            reason: String(reason || "graph-save"),
          });
        }
      }
      if (!snapshot) {
        const graphSnapshotBuildStartedAt = readPersistDeltaDiagnosticsNow();
        snapshot = buildSnapshotFromGraph(persistGraphInput, {
          chatId: normalizedChatId,
          revision: requestedRevision,
          baseSnapshot,
          lastModified: Date.now(),
          meta: {
            storagePrimary: localStore.storagePrimary,
            storageMode: localStore.storageMode,
            lastMutationReason: String(reason || "graph-save"),
            integrity:
              currentIdentity.integrity || graphPersistenceState.metadataIntegrity,
            hostChatId: currentIdentity.hostChatId || "",
          },
          onDiagnostics(snapshotValue) {
            snapshotBuildDiagnostics =
              snapshotValue &&
              typeof snapshotValue === "object" &&
              !Array.isArray(snapshotValue)
                ? snapshotValue
                : null;
          },
        });
        graphSnapshotBuildMs =
          readPersistDeltaDiagnosticsNow() - graphSnapshotBuildStartedAt;
      }
    }
    const nativePersistBridgeMode = String(
      currentSettings.persistNativeDeltaBridgeMode || "json",
    );
    const nativePersistRequested =
      !directPersistDelta && !dirtyPersistUsed && currentSettings.persistUseNativeDelta === true;
    const nativePersistForceDisabled = currentSettings.graphNativeForceDisable === true;
    const nativePersistGate =
      !delta && baseSnapshot && snapshot
        ? evaluatePersistNativeDeltaGate(baseSnapshot, snapshot, currentSettings)
        : {
            allowed: false,
            reasons: [
              directPersistDelta
                ? "direct-delta"
                : dirtyPersistUsed
                  ? "dirty-runtime"
                  : "delta-prebuilt",
            ],
            minSnapshotRecords: Number(
              currentSettings.persistNativeDeltaThresholdRecords || 0,
            ),
            minStructuralDelta: Number(
              currentSettings.persistNativeDeltaThresholdStructuralDelta || 0,
            ),
            minCombinedSerializedChars: Number(
              currentSettings.persistNativeDeltaThresholdSerializedChars || 0,
            ),
            beforeRecordCount: 0,
            afterRecordCount: 0,
            maxSnapshotRecords: 0,
            structuralDelta: 0,
          };
    const shouldUseNativePersistDelta =
      nativePersistRequested &&
      nativePersistForceDisabled !== true &&
      nativePersistGate.allowed;
    if (!directPersistDelta) {
      nativePersistPreloadStatus = nativePersistRequested
        ? nativePersistForceDisabled
          ? "force-disabled"
          : nativePersistGate.allowed
            ? "pending"
            : "gated-out"
        : "not-requested";
    }
    updatePersistDeltaDiagnostics({
      chatId: normalizedChatId,
      saveReason: String(reason || "graph-save"),
      requestedRevision,
      requestedNative: nativePersistRequested,
      requestedBridgeMode: directPersistDelta
        ? "direct-delta"
        : dirtyPersistUsed
          ? "dirty-runtime"
          : nativePersistBridgeMode,
      nativeForceDisabled: nativePersistForceDisabled,
      nativeFailOpen: currentSettings.nativeEngineFailOpen !== false,
      gateAllowed: directPersistDelta || dirtyPersistUsed ? true : nativePersistGate.allowed,
      gateReasons: cloneRuntimeDebugValue(
        directPersistDelta
          ? ["direct-delta"]
          : dirtyPersistUsed
            ? ["dirty-runtime"]
            : nativePersistGate.reasons,
        [],
      ),
      preloadGateAllowed:
        directPersistDelta || dirtyPersistUsed ? true : nativePersistGate.allowed,
      preloadGateReasons: cloneRuntimeDebugValue(
        directPersistDelta
          ? ["direct-delta"]
          : dirtyPersistUsed
            ? ["dirty-runtime"]
            : nativePersistGate.reasons,
        [],
      ),
      minSnapshotRecords: nativePersistGate.minSnapshotRecords,
      minStructuralDelta: nativePersistGate.minStructuralDelta,
      minCombinedSerializedChars: nativePersistGate.minCombinedSerializedChars,
      beforeRecordCount: nativePersistGate.beforeRecordCount,
      afterRecordCount: nativePersistGate.afterRecordCount,
      maxSnapshotRecords: nativePersistGate.maxSnapshotRecords,
      structuralDelta: nativePersistGate.structuralDelta,
      preloadStatus: nativePersistPreloadStatus,
      preloadMs: 0,
      preloadError: "",
      status: "building",
      path: directPersistDelta
        ? "direct-delta"
        : dirtyPersistUsed
          ? "dirty-runtime"
          : undefined,
    });
    if (!directPersistDelta && shouldUseNativePersistDelta) {
      const preloadStartedAt = readPersistDeltaDiagnosticsNow();
      try {
        if (!nativePersistDeltaInstallPromise) {
          nativePersistDeltaInstallPromise = import("./vendor/wasm/stbme_core.js")
            .then((module) => module?.installNativePersistDeltaHook?.())
            .catch((error) => {
              nativePersistDeltaInstallPromise = null;
              throw error;
            });
        }
        nativePersistModuleStatus = await nativePersistDeltaInstallPromise;
        nativePersistPreloadStatus = nativePersistModuleStatus?.loaded
          ? "loaded"
          : "not-loaded";
        nativePersistPreloadMs =
          readPersistDeltaDiagnosticsNow() - preloadStartedAt;
      } catch (error) {
        nativePersistPreloadStatus = "failed";
        nativePersistPreloadMs =
          readPersistDeltaDiagnosticsNow() - preloadStartedAt;
        nativePersistPreloadError = error?.message || String(error);
        if (currentSettings.nativeEngineFailOpen !== false) {
          console.warn(
            "[ST-BME] native persist delta preload failed, fallback to JS delta:",
            error,
          );
        } else {
          throw error;
        }
      }
    }
    if (!delta) {
      delta = buildPersistDelta(baseSnapshot, snapshot, {
        useNativeDelta: shouldUseNativePersistDelta,
        nativeFailOpen: currentSettings.nativeEngineFailOpen !== false,
        persistNativeDeltaThresholdRecords:
          currentSettings.persistNativeDeltaThresholdRecords,
        persistNativeDeltaThresholdStructuralDelta:
          currentSettings.persistNativeDeltaThresholdStructuralDelta,
        persistNativeDeltaThresholdSerializedChars:
          currentSettings.persistNativeDeltaThresholdSerializedChars,
        persistNativeDeltaBridgeMode: nativePersistBridgeMode,
        onDiagnostics(snapshotValue) {
          persistDeltaBuildDiagnostics = snapshotValue;
        },
      });
    } else if (!persistDeltaBuildDiagnostics) {
      persistDeltaBuildDiagnostics = {
        requestedNative: false,
        requestedBridgeMode: directPersistDelta
          ? "direct-delta"
          : dirtyPersistUsed
            ? "dirty-runtime"
            : "prebuilt-delta",
        usedNative: false,
        path: directPersistDelta
          ? "direct-delta"
          : dirtyPersistUsed
            ? "dirty-runtime"
            : "prebuilt-delta",
        gateAllowed: true,
        gateReasons: [
          directPersistDelta
            ? "direct-delta"
            : dirtyPersistUsed
              ? "dirty-runtime"
              : "prebuilt-delta",
        ],
        nativeAttemptStatus: "not-requested",
        nativeError: "",
        beforeRecordCount: Number(
          delta?.countDelta?.previous?.nodes || 0,
        ) + Number(delta?.countDelta?.previous?.edges || 0),
        afterRecordCount: Number(
          delta?.countDelta?.next?.nodes || 0,
        ) + Number(delta?.countDelta?.next?.edges || 0),
        maxSnapshotRecords: Math.max(
          Number(delta?.countDelta?.previous?.nodes || 0) +
            Number(delta?.countDelta?.previous?.edges || 0),
          Number(delta?.countDelta?.next?.nodes || 0) +
            Number(delta?.countDelta?.next?.edges || 0),
        ),
        structuralDelta:
          Number(delta?.upsertNodes?.length || 0) +
          Number(delta?.upsertEdges?.length || 0) +
          Number(delta?.deleteNodeIds?.length || 0) +
          Number(delta?.deleteEdgeIds?.length || 0),
        beforeSerializedChars: 0,
        afterSerializedChars: 0,
        combinedSerializedChars: 0,
        prepareMs: 0,
        nativeAttemptMs: 0,
        lookupMs: 0,
        jsDiffMs: 0,
        hydrateMs: 0,
        serializationCacheObjectHits: 0,
        serializationCacheTokenHits: 0,
        serializationCacheMisses: 0,
        serializationCacheHits: 0,
        preparedRecordSetCacheHits: 0,
        preparedRecordSetCacheMisses: 0,
        minCombinedSerializedChars: 0,
        upsertNodeCount: Number(delta?.upsertNodes?.length || 0),
        upsertEdgeCount: Number(delta?.upsertEdges?.length || 0),
        deleteNodeCount: Number(delta?.deleteNodeIds?.length || 0),
        deleteEdgeCount: Number(delta?.deleteEdgeIds?.length || 0),
        tombstoneCount: Number(delta?.tombstones?.length || 0),
        dirtyStateVersion: dirtyPersistDeltaVersion,
      };
    }
    const commitResult = await db.commitDelta(delta, {
      reason,
      requestedRevision,
      markSyncDirty: true,
      committedSnapshot: snapshot,
    });
    const commitDiagnostics =
      commitResult?.diagnostics &&
      typeof commitResult.diagnostics === "object" &&
      !Array.isArray(commitResult.diagnostics)
        ? cloneRuntimeDebugValue(commitResult.diagnostics, {})
        : null;
    const committedRevision = normalizeIndexedDbRevision(
      commitResult?.revision,
      requestedRevision,
    );
    const committedLastModified = Number(commitResult?.lastModified || Date.now());

    let scheduleUploadWarning = "";
    if (persistGraphInput) {
      if (!snapshot) {
        const graphSnapshotBuildStartedAt = readPersistDeltaDiagnosticsNow();
        snapshot = buildSnapshotFromGraph(persistGraphInput, {
          chatId: normalizedChatId,
          revision: committedRevision,
          baseSnapshot: baseSnapshot || undefined,
          lastModified: committedLastModified,
          meta: {
            storagePrimary: localStore.storagePrimary,
            storageMode: localStore.storageMode,
            lastMutationReason: String(reason || "graph-save"),
            integrity:
              currentIdentity.integrity || graphPersistenceState.metadataIntegrity,
            hostChatId: currentIdentity.hostChatId || "",
          },
          onDiagnostics(snapshotValue) {
            snapshotBuildDiagnostics =
              snapshotValue &&
              typeof snapshotValue === "object" &&
              !Array.isArray(snapshotValue)
                ? snapshotValue
                : null;
          },
        });
        graphSnapshotBuildMs +=
          readPersistDeltaDiagnosticsNow() - graphSnapshotBuildStartedAt;
      }
      if (!snapshot.meta || typeof snapshot.meta !== "object" || Array.isArray(snapshot.meta)) {
        snapshot.meta = {};
      }
      snapshot.meta.revision = committedRevision;
      snapshot.meta.lastModified = committedLastModified;
      snapshot.meta.lastMutationReason = String(reason || "graph-save");
      snapshot.meta.storagePrimary = localStore.storagePrimary;
      snapshot.meta.storageMode = localStore.storageMode;
      if (localStore.storagePrimary !== AUTHORITY_GRAPH_STORE_KIND) {
        cacheIndexedDbSnapshot(normalizedChatId, snapshot);
      }
    }

    if (dirtyPersistDeltaVersion > 0) {
      pruneGraphPersistDirtyState(graph, dirtyPersistDeltaVersion);
      if (sourceGraphInput && sourceGraphInput !== graph) {
        pruneGraphPersistDirtyState(sourceGraphInput, dirtyPersistDeltaVersion);
      }
    }

    if (graph === currentGraph) {
      stampGraphPersistenceMeta(currentGraph, {
        revision: committedRevision,
        reason: String(reason || "graph-save"),
        chatId: normalizedChatId,
        integrity:
          currentIdentity.integrity ||
          getChatMetadataIntegrity(context) ||
          graphPersistenceState.metadataIntegrity,
      });
    }

    if (shouldScheduleCloudUpload) {
      try {
        scheduleUpload(
          normalizedChatId,
          buildBmeSyncRuntimeOptions({
            trigger: `graph-mutation:${String(reason || "graph-save")}`,
          }),
        );
      } catch (error) {
        scheduleUploadWarning =
          error?.message || String(error) || "schedule-upload-failed";
        console.warn(
          `[ST-BME] ${localStore.statusLabel} 已写入，但同步上传调度失败:`,
          error,
        );
      }
    }

    const persistTotalMs = readPersistDeltaDiagnosticsNow() - persistDeltaStartedAt;
    const persistAccountedMs =
      Number(nativePersistPreloadMs || 0) +
      Number(baseSnapshotReadMs || 0) +
      Number(graphSnapshotBuildMs || 0) +
      Number(persistDeltaBuildDiagnostics?.buildMs || 0) +
      Number(commitDiagnostics?.queueWaitMs || 0) +
      Number(commitDiagnostics?.commitMs || 0);
    const persistDeltaDiagnostics = {
      ...cloneRuntimeDebugValue(persistDeltaBuildDiagnostics, {}),
      chatId: normalizedChatId,
      saveReason: String(reason || "graph-save"),
      requestedRevision,
      requestedNative: nativePersistRequested,
      requestedBridgeMode:
        persistDeltaBuildDiagnostics?.requestedBridgeMode ||
        (directPersistDelta ? "direct-delta" : nativePersistBridgeMode),
      buildRequestedNative: Boolean(persistDeltaBuildDiagnostics?.requestedNative),
      nativeForceDisabled: nativePersistForceDisabled,
      nativeFailOpen: currentSettings.nativeEngineFailOpen !== false,
      gateAllowed:
        persistDeltaBuildDiagnostics?.gateAllowed ??
        (directPersistDelta ? true : nativePersistGate.allowed),
      gateReasons: cloneRuntimeDebugValue(
        persistDeltaBuildDiagnostics?.gateReasons,
        directPersistDelta ? ["direct-delta"] : nativePersistGate.reasons,
      ),
      preloadGateAllowed: directPersistDelta ? true : nativePersistGate.allowed,
      preloadGateReasons: cloneRuntimeDebugValue(
        directPersistDelta ? ["direct-delta"] : nativePersistGate.reasons,
        [],
      ),
      minSnapshotRecords: nativePersistGate.minSnapshotRecords,
      minStructuralDelta: nativePersistGate.minStructuralDelta,
      minCombinedSerializedChars:
        persistDeltaBuildDiagnostics?.minCombinedSerializedChars ??
        nativePersistGate.minCombinedSerializedChars,
      beforeRecordCount:
        persistDeltaBuildDiagnostics?.beforeRecordCount ??
        nativePersistGate.beforeRecordCount,
      afterRecordCount:
        persistDeltaBuildDiagnostics?.afterRecordCount ??
        nativePersistGate.afterRecordCount,
      maxSnapshotRecords:
        persistDeltaBuildDiagnostics?.maxSnapshotRecords ??
        nativePersistGate.maxSnapshotRecords,
      structuralDelta:
        persistDeltaBuildDiagnostics?.structuralDelta ??
        nativePersistGate.structuralDelta,
      preloadStatus: nativePersistPreloadStatus,
      preloadMs: nativePersistPreloadMs,
      preloadError: nativePersistPreloadError,
      moduleLoaded: Boolean(nativePersistModuleStatus?.loaded),
      moduleSource: String(nativePersistModuleStatus?.source || ""),
      moduleError: String(
        nativePersistModuleStatus?.error || nativePersistPreloadError || "",
      ),
      baseSnapshotReadMs: normalizePersistDeltaDiagnosticsMs(baseSnapshotReadMs),
      snapshotBuildMs: normalizePersistDeltaDiagnosticsMs(graphSnapshotBuildMs),
      snapshotNodesMs: normalizePersistDeltaDiagnosticsMs(
        snapshotBuildDiagnostics?.nodesMs,
      ),
      snapshotEdgesMs: normalizePersistDeltaDiagnosticsMs(
        snapshotBuildDiagnostics?.edgesMs,
      ),
      snapshotTombstonesMs: normalizePersistDeltaDiagnosticsMs(
        snapshotBuildDiagnostics?.tombstonesMs,
      ),
      snapshotStateMs: normalizePersistDeltaDiagnosticsMs(
        snapshotBuildDiagnostics?.stateMs,
      ),
      snapshotMetaMs: normalizePersistDeltaDiagnosticsMs(
        snapshotBuildDiagnostics?.metaMs,
      ),
      snapshotNodeCount: Math.max(
        0,
        Math.floor(Number(snapshotBuildDiagnostics?.nodeCount || 0)),
      ),
      snapshotEdgeCount: Math.max(
        0,
        Math.floor(Number(snapshotBuildDiagnostics?.edgeCount || 0)),
      ),
      snapshotTombstoneCount: Math.max(
        0,
        Math.floor(Number(snapshotBuildDiagnostics?.tombstoneCount || 0)),
      ),
      commitStorageKind: String(
        commitDiagnostics?.storageKind || localStore.storagePrimary || "",
      ),
      commitStoreMode: String(
        commitDiagnostics?.storeMode || localStore.storageMode || "",
      ),
      commitQueueWaitMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.queueWaitMs,
      ),
      commitMs: normalizePersistDeltaDiagnosticsMs(commitDiagnostics?.commitMs),
      commitTxMs: normalizePersistDeltaDiagnosticsMs(commitDiagnostics?.txMs),
      commitSnapshotReadMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.snapshotReadMs,
      ),
      commitSnapshotWriteMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.snapshotWriteMs,
      ),
      commitManifestReadMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.manifestReadMs,
      ),
      commitWalSerializeMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.walSerializeMs,
      ),
      commitWalFileWriteMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.walFileWriteMs,
      ),
      commitWalWriteMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.walWriteMs,
      ),
      commitManifestSerializeMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.manifestSerializeMs,
      ),
      commitManifestFileWriteMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.manifestFileWriteMs,
      ),
      commitManifestWriteMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.manifestWriteMs,
      ),
      commitCacheApplyMs: normalizePersistDeltaDiagnosticsMs(
        commitDiagnostics?.cacheApplyMs,
      ),
      commitPayloadBytes: Math.max(
        0,
        Math.floor(Number(commitDiagnostics?.payloadBytes || 0)),
      ),
      commitWalBytes: Math.max(
        0,
        Math.floor(Number(commitDiagnostics?.walBytes || 0)),
      ),
      commitRuntimeMetaKeyCount: Math.max(
        0,
        Math.floor(Number(commitDiagnostics?.runtimeMetaKeyCount || 0)),
      ),
      status: "committed",
      commitRevision: normalizeIndexedDbRevision(
        commitResult?.revision,
        requestedRevision,
      ),
      commitDelta: cloneRuntimeDebugValue(commitResult?.delta, null),
      totalMs: normalizePersistDeltaDiagnosticsMs(persistTotalMs),
      untrackedMs: normalizePersistDeltaDiagnosticsMs(
        Math.max(0, persistTotalMs - persistAccountedMs),
      ),
    };
    persistDeltaDiagnostics.fallbackReason =
      persistDeltaDiagnostics.requestedNative && !persistDeltaDiagnostics.usedNative
        ? String(
            (persistDeltaDiagnostics.preloadStatus !== "loaded" &&
            persistDeltaDiagnostics.preloadStatus !== "pending"
              ? persistDeltaDiagnostics.preloadStatus
              : persistDeltaDiagnostics.nativeAttemptStatus) ||
              "js",
          )
        : "";
    const persistObservability = buildPersistObservabilitySummary(
      persistDeltaDiagnostics,
    );
    persistDeltaDiagnostics.pathKey = String(
      persistObservability?.lastPathKey || "unknown",
    );
    persistDeltaDiagnostics.reasonKey = String(
      persistObservability?.lastReasonKey || "graph-save",
    );
    persistDeltaDiagnostics.pathReasonKey = String(
      persistObservability?.lastPathReasonKey || "unknown::graph-save",
    );
    persistDeltaDiagnostics.pathSampleCount = Math.max(
      0,
      Math.floor(
        Number(
          persistObservability?.byPath?.[persistDeltaDiagnostics.pathKey]?.count || 0,
        ),
      ),
    );
    persistDeltaDiagnostics.reasonSampleCount = Math.max(
      0,
      Math.floor(
        Number(
          persistObservability?.byReason?.[persistDeltaDiagnostics.reasonKey]?.count || 0,
        ),
      ),
    );

    const opfsWriteLockState =
      typeof db?.getWriteLockSnapshot === "function"
        ? cloneRuntimeDebugValue(db.getWriteLockSnapshot(), null)
        : null;
    const localStoreDiagnostics =
      typeof readLocalStoreDiagnosticsSync === "function"
        ? readLocalStoreDiagnosticsSync(db, localStore)
        : {
            resolvedLocalStore: `${localStore?.storagePrimary || "indexeddb"}:${localStore?.storageMode || "indexeddb"}`,
            localStoreFormatVersion:
              localStore.storagePrimary === "opfs" ? 2 : 1,
            localStoreMigrationState: "idle",
            opfsWalDepth: 0,
            opfsPendingBytes: 0,
            opfsCompactionState: null,
          };

    if (persistRole === "cache-mirror") {
      updateGraphPersistenceState({
        hostProfile: persistenceEnvironment.hostProfile,
        primaryStorageTier: persistenceEnvironment.primaryStorageTier,
        cacheStorageTier: persistenceEnvironment.cacheStorageTier,
        cacheMirrorState: "saved",
        cacheLag: Math.max(
          0,
          Number(graphPersistenceState.lukerManifestRevision || 0) -
            normalizeIndexedDbRevision(commitResult?.revision, requestedRevision),
        ),
        storagePrimary: localStore.storagePrimary,
        storageMode: localStore.storageMode,
        resolvedLocalStore: localStoreDiagnostics.resolvedLocalStore,
        localStoreFormatVersion: localStoreDiagnostics.localStoreFormatVersion,
        localStoreMigrationState: localStoreDiagnostics.localStoreMigrationState,
        indexedDbRevision: normalizeIndexedDbRevision(
          commitResult?.revision,
          requestedRevision,
        ),
        indexedDbLastError: "",
        lastSyncError: scheduleUploadWarning,
        opfsWriteLockState,
        opfsWalDepth: localStoreDiagnostics.opfsWalDepth,
        opfsPendingBytes: localStoreDiagnostics.opfsPendingBytes,
        opfsCompactionState: localStoreDiagnostics.opfsCompactionState,
        persistObservability,
        dualWriteLastResult: {
          action: "cache-mirror",
          target: localStore.storagePrimary,
          success: true,
          chatId: normalizedChatId,
          revision: normalizeIndexedDbRevision(
            commitResult?.revision,
            requestedRevision,
          ),
          reason: String(reason || "graph-save"),
          warning: scheduleUploadWarning || "",
          delta: cloneRuntimeDebugValue(commitResult?.delta, null),
          at: Date.now(),
        },
        persistDelta: persistDeltaDiagnostics,
      });
      return {
        saved: true,
        accepted: false,
        mirrored: true,
        chatId: normalizedChatId,
        revision: normalizeIndexedDbRevision(
          commitResult?.revision,
          requestedRevision,
        ),
        reason: String(reason || "graph-save"),
        saveMode: `${localStore.reasonPrefix}-cache-mirror`,
        storageTier: localStoreTier,
        warning: scheduleUploadWarning || "",
        delta: cloneRuntimeDebugValue(commitResult?.delta, null),
        snapshot,
      };
    }

    updateGraphPersistenceState({
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
      cacheMirrorState:
        persistenceEnvironment.hostProfile === "luker" ? "idle" : "none",
      cacheLag:
        persistenceEnvironment.hostProfile === "luker"
          ? Math.max(
              0,
              Number(graphPersistenceState.lukerManifestRevision || 0) -
                normalizeIndexedDbRevision(commitResult?.revision, requestedRevision),
            )
          : Number(graphPersistenceState.cacheLag || 0),
      revision: normalizeIndexedDbRevision(
        commitResult?.revision,
        requestedRevision,
      ),
      storagePrimary: localStore.storagePrimary,
      storageMode: localStore.storageMode,
      resolvedLocalStore: localStoreDiagnostics.resolvedLocalStore,
      localStoreFormatVersion: localStoreDiagnostics.localStoreFormatVersion,
      localStoreMigrationState: localStoreDiagnostics.localStoreMigrationState,
      dbReady: true,
      lastPersistedRevision: normalizeIndexedDbRevision(
        commitResult?.revision,
        requestedRevision,
      ),
      pendingPersist: false,
      queuedPersistRevision: 0,
      queuedPersistChatId: "",
      queuedPersistMode: "",
      queuedPersistRotateIntegrity: false,
      queuedPersistReason: "",
      indexedDbRevision: normalizeIndexedDbRevision(
        commitResult?.revision,
        requestedRevision,
      ),
      metadataIntegrity:
        getChatMetadataIntegrity(context) ||
          currentIdentity.integrity ||
          graphPersistenceState.metadataIntegrity,
      indexedDbLastError: "",
      lastSyncError: scheduleUploadWarning,
      syncDirty: true,
      syncDirtyReason: String(reason || "graph-save"),
      lastPersistReason: String(reason || "graph-save"),
      lastPersistMode: directPersistDelta
        ? `${localStore.reasonPrefix}-direct-delta`
        : `${localStore.reasonPrefix}-delta`,
      lastAcceptedRevision: Math.max(
        Number(graphPersistenceState.lastAcceptedRevision || 0),
        normalizeIndexedDbRevision(commitResult?.revision, requestedRevision),
      ),
      acceptedStorageTier: localStoreTier,
      acceptedBy: localStoreTier,
      lastRecoverableStorageTier: "none",
      persistDiagnosticTier: "none",
      opfsWriteLockState,
      opfsWalDepth: localStoreDiagnostics.opfsWalDepth,
      opfsPendingBytes: localStoreDiagnostics.opfsPendingBytes,
      opfsCompactionState: localStoreDiagnostics.opfsCompactionState,
      persistObservability,
      dualWriteLastResult: {
        action: "save",
        target: localStore.storagePrimary,
        success: true,
        chatId: normalizedChatId,
        revision: normalizeIndexedDbRevision(
          commitResult?.revision,
          requestedRevision,
        ),
        reason: String(reason || "graph-save"),
        warning: scheduleUploadWarning || "",
        delta: cloneRuntimeDebugValue(commitResult?.delta, null),
        at: Date.now(),
      },
      persistDelta: persistDeltaDiagnostics,
    });
    clearPendingGraphPersistRetry();
    if (
      (graphPersistenceState.loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
        (graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING &&
          hasMeaningfulRuntimeGraphForChat(normalizedChatId, currentIdentity))) &&
      (areChatIdsEquivalentForResolvedIdentity(
        normalizedChatId,
        graphPersistenceState.chatId || getCurrentChatId(),
        currentIdentity,
      ) ||
        areChatIdsEquivalentForResolvedIdentity(
          graphPersistenceState.chatId || getCurrentChatId(),
          normalizedChatId,
          currentIdentity,
        ))
    ) {
      applyGraphLoadState(GRAPH_LOAD_STATES.LOADED, {
        chatId: normalizedChatId,
        reason:
          graphPersistenceState.loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED
            ? `shadow-promoted:${String(reason || "graph-save")}`
            : `local-store-confirmed:${String(reason || "graph-save")}`,
        revision: normalizeIndexedDbRevision(
          commitResult?.revision,
          requestedRevision,
        ),
        lastPersistedRevision: normalizeIndexedDbRevision(
          commitResult?.revision,
          requestedRevision,
        ),
        queuedPersistRevision: 0,
        queuedPersistChatId: "",
        pendingPersist: false,
        shadowSnapshotUsed: true,
        shadowSnapshotRevision: Math.max(
          Number(graphPersistenceState.shadowSnapshotRevision || 0),
          normalizeIndexedDbRevision(commitResult?.revision, requestedRevision),
        ),
        shadowSnapshotUpdatedAt: String(
          graphPersistenceState.shadowSnapshotUpdatedAt || "",
        ),
        shadowSnapshotReason: String(
          graphPersistenceState.shadowSnapshotReason ||
            "shadow-restore-promoted",
        ),
        dbReady: true,
        writesBlocked: false,
      });
    }
    rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

    return {
      saved: true,
      accepted: true,
      chatId: normalizedChatId,
      revision: normalizeIndexedDbRevision(
        commitResult?.revision,
        requestedRevision,
      ),
      reason: String(reason || "graph-save"),
      saveMode: directPersistDelta
        ? `${localStore.reasonPrefix}-direct-delta`
        : `${localStore.reasonPrefix}-delta`,
      storageTier: localStoreTier,
      warning: scheduleUploadWarning || "",
      delta: cloneRuntimeDebugValue(commitResult?.delta, null),
      snapshot,
    };
  } catch (error) {
    console.warn(
      `[ST-BME] ${localStore.statusLabel} 写入失败，保留 metadata 兜底:`,
      error,
    );
    updatePersistDeltaDiagnostics({
      status: "failed",
      error: error?.message || String(error),
      failedAt: Date.now(),
    });
    const persistenceEnvironment = buildPersistenceEnvironment(context, localStore);
    const opfsWriteLockState =
      typeof db?.getWriteLockSnapshot === "function"
        ? cloneRuntimeDebugValue(db.getWriteLockSnapshot(), null)
        : null;
    const localStoreDiagnostics =
      typeof readLocalStoreDiagnosticsSync === "function"
        ? readLocalStoreDiagnosticsSync(db, localStore)
        : {
            resolvedLocalStore: `${localStore?.storagePrimary || "indexeddb"}:${localStore?.storageMode || "indexeddb"}`,
            localStoreFormatVersion:
              localStore?.storagePrimary === "opfs" ? 2 : 1,
            localStoreMigrationState: "idle",
            opfsWalDepth: 0,
            opfsPendingBytes: 0,
            opfsCompactionState: null,
          };
    updateGraphPersistenceState({
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
      cacheMirrorState:
        persistRole === "cache-mirror"
          ? "error"
          : graphPersistenceState.cacheMirrorState,
      storagePrimary: localStore.storagePrimary,
      storageMode: localStore.storageMode,
      resolvedLocalStore: localStoreDiagnostics.resolvedLocalStore,
      localStoreFormatVersion: localStoreDiagnostics.localStoreFormatVersion,
      localStoreMigrationState: localStoreDiagnostics.localStoreMigrationState,
      indexedDbLastError: error?.message || String(error),
      opfsWriteLockState,
      opfsWalDepth: localStoreDiagnostics.opfsWalDepth,
      opfsPendingBytes: localStoreDiagnostics.opfsPendingBytes,
      opfsCompactionState: localStoreDiagnostics.opfsCompactionState,
      dualWriteLastResult: {
        action: persistRole === "cache-mirror" ? "cache-mirror" : "save",
        target: localStore.storagePrimary,
        success: false,
        chatId: normalizedChatId,
        revision: normalizeIndexedDbRevision(revision),
        reason: String(reason || "graph-save"),
        error: error?.message || String(error),
        at: Date.now(),
      },
    });
    return {
      saved: false,
      chatId: normalizedChatId,
      revision: normalizeIndexedDbRevision(revision),
      reason:
        persistRole === "cache-mirror"
          ? "cache-mirror-write-failed"
          : `${String(localStore?.reasonPrefix || "indexeddb")}-write-failed`,
      error,
    };
  }
}

function normalizePersistObservabilityKey(value = "", fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || String(fallback || "unknown");
}

function trimPersistObservabilityBuckets(buckets = {}, maxEntries = 16) {
  const entries = Object.values(buckets || {}).filter(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
  );
  entries.sort((left, right) => {
    const countDelta = Number(right?.count || 0) - Number(left?.count || 0);
    if (countDelta !== 0) return countDelta;
    return String(right?.lastAt || "").localeCompare(String(left?.lastAt || ""));
  });
  return Object.fromEntries(
    entries.slice(0, Math.max(1, Math.floor(Number(maxEntries) || 16))).map((entry) => [
      String(entry.key || "unknown"),
      entry,
    ]),
  );
}

function buildPersistObservabilitySummary(diagnostics = null) {
  const source =
    diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
      ? diagnostics
      : {};
  const previous =
    graphPersistenceState.persistObservability &&
    typeof graphPersistenceState.persistObservability === "object" &&
    !Array.isArray(graphPersistenceState.persistObservability)
      ? cloneRuntimeDebugValue(graphPersistenceState.persistObservability, {})
      : {};
  const totalMs = normalizePersistDeltaDiagnosticsMs(
    source.totalMs || source.buildMs || 0,
  );
  const pathKey = normalizePersistObservabilityKey(
    source.path || source.requestedBridgeMode || "unknown",
    "unknown",
  );
  const reasonKey = normalizePersistObservabilityKey(
    source.saveReason || "graph-save",
    "graph-save",
  );
  const pathReasonKey = `${pathKey}::${reasonKey}`;
  const recordedAt = new Date().toISOString();
  const recordBucket = (buckets = {}, key = "unknown") => {
    const current =
      buckets[key] && typeof buckets[key] === "object" && !Array.isArray(buckets[key])
        ? buckets[key]
        : null;
    const count = Math.max(0, Math.floor(Number(current?.count || 0))) + 1;
    const totalBucketMs = normalizePersistDeltaDiagnosticsMs(
      Number(current?.totalMs || 0) + totalMs,
    );
    buckets[key] = {
      key,
      count,
      totalMs: totalBucketMs,
      avgMs: normalizePersistDeltaDiagnosticsMs(totalBucketMs / count),
      maxMs: normalizePersistDeltaDiagnosticsMs(
        Math.max(Number(current?.maxMs || 0), totalMs),
      ),
      lastMs: totalMs,
      lastAt: recordedAt,
    };
    return buckets;
  };
  const nextByPath = recordBucket(
    cloneRuntimeDebugValue(previous.byPath || {}, {}),
    pathKey,
  );
  const nextByReason = recordBucket(
    cloneRuntimeDebugValue(previous.byReason || {}, {}),
    reasonKey,
  );
  const nextByPathReason = recordBucket(
    cloneRuntimeDebugValue(previous.byPathReason || {}, {}),
    pathReasonKey,
  );
  return {
    totalSamples: Math.max(0, Math.floor(Number(previous.totalSamples || 0))) + 1,
    byPath: trimPersistObservabilityBuckets(nextByPath, 12),
    byReason: trimPersistObservabilityBuckets(nextByReason, 16),
    byPathReason: trimPersistObservabilityBuckets(nextByPathReason, 24),
    lastPathKey: pathKey,
    lastReasonKey: reasonKey,
    lastPathReasonKey: pathReasonKey,
    lastRecordedAt: recordedAt,
  };
}

function queueGraphPersistToIndexedDb(
  chatId,
  graph,
  {
    revision = 0,
    reason = "graph-save",
    persistRole = "primary",
    scheduleCloudUpload = undefined,
    persistDelta = null,
    graphSnapshot = null,
    persistSnapshot = null,
    graphDetached = false,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId || (!graph && !persistDelta)) return;

  if (persistRole === "cache-mirror") {
    const persistenceEnvironment = buildPersistenceEnvironment(
      getContext(),
      getPreferredGraphLocalStorePresentationSync(),
    );
    updateGraphPersistenceState({
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
      cacheMirrorState: "queued",
    });
  }

  const normalizedRevision = normalizeIndexedDbRevision(revision);
  const latestQueuedRevision = normalizeIndexedDbRevision(
    bmeIndexedDbLatestQueuedRevisionByChatId.get(normalizedChatId),
  );
  bmeIndexedDbLatestQueuedRevisionByChatId.set(
    normalizedChatId,
    Math.max(latestQueuedRevision, normalizedRevision),
  );

  const previousWritePromise =
    bmeIndexedDbWriteInFlightByChatId.get(normalizedChatId) ||
    Promise.resolve();
  const nextWritePromise = previousWritePromise
    .catch(() => null)
    .then(async () => {
      const currentLatestRevision = normalizeIndexedDbRevision(
        bmeIndexedDbLatestQueuedRevisionByChatId.get(normalizedChatId),
      );
      if (
        normalizedRevision > 0 &&
        normalizedRevision < currentLatestRevision
      ) {
        return {
          saved: false,
          skipped: true,
          reason: "indexeddb-write-superseded",
          revision: normalizedRevision,
        };
      }
      const persistGraphSnapshot = graphSnapshot
        ? graphSnapshot
        : graph
          ? graphDetached === true
            ? normalizeGraphRuntimeState(graph, normalizedChatId)
            : cloneGraphForPersistence(graph, normalizedChatId)
          : null;
      return await saveGraphToIndexedDb(normalizedChatId, persistGraphSnapshot, {
        revision: normalizedRevision,
        reason,
        persistRole,
        scheduleCloudUpload,
        persistDelta,
        graphSnapshot: persistGraphSnapshot,
        persistSnapshot,
        sourceGraph: graphDetached === true ? null : graph,
      });
    })
    .finally(() => {
      if (
        bmeIndexedDbWriteInFlightByChatId.get(normalizedChatId) ===
        nextWritePromise
      ) {
        bmeIndexedDbWriteInFlightByChatId.delete(normalizedChatId);
      }
    });

  bmeIndexedDbWriteInFlightByChatId.set(normalizedChatId, nextWritePromise);
}

function saveGraphToChat(options = {}) {
  const context = getContext();
  if (!context || !currentGraph) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      reason: "missing-context-or-graph",
    });
  }
  const chatId = resolvePersistenceChatId(context, currentGraph);
  const {
    reason = "graph-save",
    markMutation = true,
    persistMetadata = false,
    captureShadow = Boolean(persistMetadata),
    immediate = markMutation,
  } = options;

  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;
  if (!chatId) {
    recordLocalPersistEarlyFailure("missing-chat-id", {
      chatId,
      revision: 0,
    });
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      reason: "missing-chat-id",
    });
  }

  const revision = markMutation
    ? allocateRequestedPersistRevision(0, currentGraph)
    : resolvePersistRevisionFloor(0, currentGraph);
  const persistenceEnvironment = buildPersistenceEnvironment(
    context,
    getPreferredGraphLocalStorePresentationSync(),
  );

  if (captureShadow) {
    maybeCaptureGraphShadowSnapshot(reason);
  }

  const shouldQueueIndexedDbPersist =
    (persistenceEnvironment.hostProfile !== "luker" ||
      persistenceEnvironment.primaryStorageTier === "authority-sql") &&
    (markMutation || !isGraphEffectivelyEmpty(currentGraph));
  if (shouldQueueIndexedDbPersist) {
    queueGraphPersistToIndexedDb(chatId, currentGraph, {
      revision,
      reason,
    });
  }

  const metadataFallbackEnabled =
    Boolean(persistMetadata) || !ensureBmeChatManager();

  if (!markMutation) {
    const hasMeaningfulGraphData = !isGraphEffectivelyEmpty(currentGraph);
    if (
      !hasMeaningfulGraphData ||
      graphPersistenceState.loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
    ) {
      return buildGraphPersistResult({
        saved: false,
        blocked: false,
        reason: hasMeaningfulGraphData
          ? "passive-empty-confirmed-skipped"
          : "passive-empty-graph-skipped",
        revision,
      });
    }
  }

  if (persistenceEnvironment.primaryStorageTier === "luker-chat-state") {
    const persistGraph = cloneGraphForPersistence(currentGraph, chatId);
    const chatStateTarget = resolveCurrentChatStateTarget(context);
    const lastProcessedAssistantFloor = Number.isFinite(
      Number(persistGraph?.historyState?.lastProcessedAssistantFloor),
    )
      ? Number(persistGraph.historyState.lastProcessedAssistantFloor)
      : null;
    scheduleBmeIndexedDbTask(async () => {
      const persistResult = await persistGraphToConfiguredDurableTier(
        context,
        persistGraph,
        {
          chatId,
          revision,
          reason,
          lastProcessedAssistantFloor,
          chatStateTarget,
          graphDetached: true,
        },
      );
      if (!persistResult?.accepted) {
        queueGraphPersist(reason, revision, {
          immediate,
          graph: persistGraph,
          chatId,
          captureShadow,
        });
      }
      refreshPanelLiveState();
    });
    updateGraphPersistenceState({
      hostProfile: persistenceEnvironment.hostProfile,
      primaryStorageTier: persistenceEnvironment.primaryStorageTier,
      cacheStorageTier: persistenceEnvironment.cacheStorageTier,
      lastPersistReason: String(reason || "graph-save"),
      lastPersistMode: "luker-chat-state-queued",
    });
    return buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: false,
      accepted: false,
      reason: "luker-chat-state-queued",
      revision,
      saveMode: "luker-chat-state-queued",
      storageTier: "luker-chat-state",
      primaryTier: persistenceEnvironment.primaryStorageTier,
      cacheTier: persistenceEnvironment.cacheStorageTier,
    });
  }

  if (!metadataFallbackEnabled) {
    const preferredLocalStore = getPreferredGraphLocalStorePresentationSync();
    const saveMode = shouldQueueIndexedDbPersist
      ? `${preferredLocalStore.reasonPrefix}-queued`
      : `${preferredLocalStore.reasonPrefix}-skip`;
    updateGraphPersistenceState({
      storagePrimary: preferredLocalStore.storagePrimary,
      storageMode: preferredLocalStore.storageMode,
      dbReady:
        graphPersistenceState.dbReady ??
        isGraphLoadStateDbReady(graphPersistenceState.loadState),
      lastPersistReason: String(reason || "graph-save"),
      lastPersistMode: saveMode,
      pendingPersist: false,
      queuedPersistChatId: "",
      queuedPersistMode: "",
      queuedPersistReason: "",
      queuedPersistRotateIntegrity: false,
      dualWriteLastResult: {
        action: "save",
        target: preferredLocalStore.storagePrimary,
        queued: Boolean(shouldQueueIndexedDbPersist),
        success: true,
        chatId,
        revision: normalizeIndexedDbRevision(revision),
        reason: String(reason || "graph-save"),
        at: Date.now(),
      },
    });
    return buildGraphPersistResult({
      saved: false,
      queued: Boolean(shouldQueueIndexedDbPersist),
      blocked: false,
      accepted: false,
      reason: shouldQueueIndexedDbPersist
        ? `${preferredLocalStore.reasonPrefix}-queued`
        : `${preferredLocalStore.reasonPrefix}-empty-skip`,
      revision,
      saveMode,
      storageTier: shouldQueueIndexedDbPersist
        ? preferredLocalStore.storagePrimary
        : "none",
    });
  }

  if (!isGraphMetadataWriteAllowed()) {
    console.warn(
      `[ST-BME] 图谱写回已被安全保护拦截（chat=${chatId}，state=${graphPersistenceState.loadState}，reason=${reason}）`,
    );
    return queueGraphPersist(reason, revision, { immediate });
  }

  const metadataPersistResult = persistGraphToChatMetadata(context, {
    reason,
    revision,
    immediate,
  });
  updateGraphPersistenceState({
    storageMode: "metadata-full",
    dualWriteLastResult: {
      action: "save",
      target: "metadata",
      success: Boolean(metadataPersistResult?.saved),
      queued: Boolean(metadataPersistResult?.queued),
      blocked: Boolean(metadataPersistResult?.blocked),
      chatId,
      revision: normalizeIndexedDbRevision(revision),
      reason: String(reason || "graph-save"),
      at: Date.now(),
    },
  });

  return metadataPersistResult;
}

function handleGraphShadowSnapshotPageHide() {
  saveGraphToChat({
    reason: "pagehide-passive-persist",
    markMutation: false,
    captureShadow: true,
    immediate: false,
  });
  maybeCaptureGraphShadowSnapshot("pagehide");
}

function handleGraphShadowSnapshotVisibilityChange() {
  if (document.visibilityState === "hidden") {
    saveGraphToChat({
      reason: "visibility-hidden-passive-persist",
      markMutation: false,
      captureShadow: true,
      immediate: false,
    });
    maybeCaptureGraphShadowSnapshot("visibility-hidden");
  }
}

// ==================== 核心流程 ====================

function getLatestUserChatMessage(chat) {
  if (!Array.isArray(chat)) return null;

  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (isSystemMessageForExtraction(message, { index, chat })) continue;
    if (message?.is_user) return message;
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

function buildRecallRecentMessages(chat, limit, syntheticUserMessage = "") {
  return buildRecallRecentMessagesController(
    chat,
    limit,
    syntheticUserMessage,
    {
      formatRecallContextLine,
      normalizeRecallInputText,
    },
  );
}

function getRecallUserMessageSourceLabel(source) {
  return getRecallUserMessageSourceLabelController(source);
}

function resolveRecallInput(chat, recentContextMessageLimit, override = null) {
  return resolveRecallInputController(
    chat,
    recentContextMessageLimit,
    override,
    {
      buildRecallRecentMessages,
      getLastNonSystemChatMessage,
      getLatestUserChatMessage,
      getRecallUserMessageSourceLabel,
      isFreshRecallInputRecord,
      lastRecallSentUserMessage,
      normalizeRecallInputText,
      pendingRecallSendIntent,
    },
  );
}

function buildGenerationAfterCommandsRecallInput(type, params = {}, chat) {
  if (params?.automatic_trigger || params?.quiet_prompt) {
    return null;
  }

  const generationType = String(type || "").trim() || "normal";
  if (!["normal", "continue", "regenerate", "swipe"].includes(generationType)) {
    return null;
  }

  const targetUserMessageIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType,
  });

  // 对于 history 类型（continue/regenerate/swipe），必须依赖 chat 中的用户消息
  if (generationType !== "normal") {
    if (!Number.isFinite(targetUserMessageIndex)) {
      return {
        generationType,
        targetUserMessageIndex: null,
      };
    }
    const historyInput = buildHistoryGenerationRecallInput(chat);
    if (!historyInput) {
      return {
        generationType,
        targetUserMessageIndex,
      };
    }
    return {
      ...historyInput,
      generationType,
      targetUserMessageIndex,
    };
  }

  // 对于 normal 类型：GENERATION_AFTER_COMMANDS 触发时用户消息可能不在 chat 末尾
  // （ST 可能已追加空 assistant 消息）。如果 chat 中存在任何用户消息，
  // 继续走 buildNormalGenerationRecallInput，它会通过 latestUserText 兜底找到。
  // 如果 chat 中完全没有用户消息，则延迟到 BEFORE_COMBINE_PROMPTS 处理。
  if (!Number.isFinite(targetUserMessageIndex) && !getLatestUserChatMessage(chat)) {
    return {
      generationType,
      targetUserMessageIndex: null,
    };
  }

  const normalInput = buildNormalGenerationRecallInput(chat, {
    frozenInputSnapshot: params?.frozenInputSnapshot,
  });
  return normalInput;
}

function createTrivialRecallSkipSentinel(reason = "") {
  return {
    __trivialSkip: true,
    trivialReason: String(reason || ""),
  };
}

function buildNormalGenerationRecallInput(chat, options = {}) {
  const lastNonSystemMessage = getLastNonSystemChatMessage(chat);
  const tailUserText = lastNonSystemMessage?.is_user
    ? normalizeRecallInputText(lastNonSystemMessage?.mes || "")
    : "";
  // 当 GENERATION_AFTER_COMMANDS 触发时，ST 可能已追加了空 assistant 消息。
  // 导致 lastNonSystemMessage 不是 user。用 getLatestUserChatMessage 反向扫描
  // 定位真正的用户消息（与 shujuku 参考实现一致）。
  const latestUserMessage = !tailUserText ? getLatestUserChatMessage(chat) : null;
  const latestUserText = latestUserMessage
    ? normalizeRecallInputText(latestUserMessage?.mes || "")
    : "";
  const targetUserMessageIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType: "normal",
  });
  const frozenInputSnapshot = isFreshRecallInputRecord(
    options?.frozenInputSnapshot,
  )
    ? options.frozenInputSnapshot
    : null;
  const pendingSendIntent = isFreshRecallInputRecord(pendingRecallSendIntent)
    ? pendingRecallSendIntent
    : null;
  const sendIntentText = normalizeRecallInputText(
    pendingSendIntent?.text || "",
  );
  const hostSnapshotText = normalizeRecallInputText(
    frozenInputSnapshot?.text || "",
  );
  const textareaText = normalizeRecallInputText(getSendTextareaValue());
  const sourceCandidates = [
    sendIntentText
      ? {
          text: sendIntentText,
          source: "send-intent",
          sourceLabel: "发送意图",
          reason: tailUserText
            ? "send-intent-overrides-chat-tail"
            : "send-intent-captured",
          includeSyntheticUserMessage: !tailUserText,
        }
      : null,
    hostSnapshotText
      ? {
          text: hostSnapshotText,
          source: String(
            frozenInputSnapshot?.source || "host-generation-lifecycle",
          ),
          sourceLabel: "宿主发送快照",
          reason: sendIntentText
            ? "host-snapshot-suppressed-by-send-intent"
            : tailUserText
              ? "host-snapshot-suppressed-by-chat-tail"
              : "host-snapshot-captured",
          includeSyntheticUserMessage: !tailUserText,
        }
      : null,
    tailUserText
      ? {
          text: tailUserText,
          source: "chat-tail-user",
          sourceLabel: "当前用户楼层",
          reason:
            sendIntentText || hostSnapshotText
              ? "chat-tail-deprioritized"
              : "chat-tail-fallback",
          includeSyntheticUserMessage: false,
        }
      : null,
    latestUserText
      ? {
          text: latestUserText,
          source: "chat-latest-user",
          sourceLabel: "最近用户消息",
          reason:
            sendIntentText || hostSnapshotText || tailUserText
              ? "latest-user-deprioritized"
              : "latest-user-fallback",
          includeSyntheticUserMessage: false,
        }
      : null,
    textareaText
      ? {
          text: textareaText,
          source: "textarea-live",
          sourceLabel: "输入框当前文本",
          reason:
            sendIntentText || hostSnapshotText || tailUserText
              ? "textarea-live-deprioritized"
              : "textarea-live-fallback",
          includeSyntheticUserMessage: !tailUserText,
        }
      : null,
  ].filter(Boolean);
  const activeTrivialSkip = getCurrentGenerationTrivialSkip();
  if (activeTrivialSkip) {
    clearPendingRecallSendIntent();
    clearPendingHostGenerationInputSnapshot();
    return createTrivialRecallSkipSentinel(activeTrivialSkip.reason);
  }

  const selectedCandidate = sourceCandidates[0] || null;
  if (!selectedCandidate?.text) return null;

  const trivialInputResult = isTrivialUserInput(selectedCandidate.text);

  if (trivialInputResult.trivial) {
    clearPendingRecallSendIntent();
    clearPendingHostGenerationInputSnapshot();
    markCurrentGenerationTrivialSkip({
      reason: trivialInputResult.reason,
      chatId: getCurrentChatId(),
      chatLength: Array.isArray(chat) ? chat.length : 0,
    });
    console.info?.(
      `[ST-BME] trivial-input skip: reason=${trivialInputResult.reason} len=${trivialInputResult.normalizedText.length} hook=build-normal-input`,
    );
    return createTrivialRecallSkipSentinel(trivialInputResult.reason);
  }

  return {
    overrideUserMessage: selectedCandidate.text,
    generationType: "normal",
    targetUserMessageIndex,
    overrideSource: selectedCandidate.source,
    overrideSourceLabel: selectedCandidate.sourceLabel,
    overrideReason: selectedCandidate.reason,
    sourceCandidates,
    includeSyntheticUserMessage: selectedCandidate.includeSyntheticUserMessage,
  };
}

function buildHistoryGenerationRecallInput(chat) {
  const latestUserText = normalizeRecallInputText(
    getLatestUserChatMessage(chat)?.mes || lastRecallSentUserMessage.text,
  );
  if (!latestUserText) return null;
  const targetUserMessageIndex = resolveGenerationTargetUserMessageIndex(chat, {
    generationType: "history",
  });

  return {
    overrideUserMessage: latestUserText,
    generationType: "history",
    targetUserMessageIndex,
    overrideSource: Number.isFinite(targetUserMessageIndex)
      ? "chat-last-user"
      : "chat-last-user-missing",
    overrideSourceLabel: Number.isFinite(targetUserMessageIndex)
      ? "历史最后用户楼层"
      : "历史用户楼层缺失",
    includeSyntheticUserMessage: false,
  };
}

function cleanupPlannerRecallHandoffs(now = Date.now()) {
  for (const [chatId, handoff] of plannerRecallHandoffs.entries()) {
    if (
      !handoff ||
      String(handoff.chatId || "") !== String(chatId || "") ||
      now - Number(handoff.updatedAt || handoff.createdAt || 0) >
        PLANNER_RECALL_HANDOFF_TTL_MS
    ) {
      plannerRecallHandoffs.delete(chatId);
    }
  }
}

function peekPlannerRecallHandoff(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  cleanupPlannerRecallHandoffs(now);
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  const handoff = plannerRecallHandoffs.get(normalizedChatId) || null;
  if (!handoff) return null;
  if (
    now - Number(handoff.updatedAt || handoff.createdAt || 0) >
    PLANNER_RECALL_HANDOFF_TTL_MS
  ) {
    plannerRecallHandoffs.delete(normalizedChatId);
    return null;
  }
  return handoff;
}

function clearPlannerRecallHandoffsForChat(
  chatId = getCurrentChatId(),
  { clearAll = false } = {},
) {
  cleanupPlannerRecallHandoffs();
  if (clearAll) {
    const removed = plannerRecallHandoffs.size;
    plannerRecallHandoffs.clear();
    return removed;
  }

  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return 0;
  return plannerRecallHandoffs.delete(normalizedChatId) ? 1 : 0;
}

function consumePlannerRecallHandoff(
  chatId = getCurrentChatId(),
  { handoffId = "" } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  const handoff = peekPlannerRecallHandoff(normalizedChatId);
  if (!handoff) return null;
  if (handoffId && String(handoff.id || "") !== String(handoffId || "")) {
    return null;
  }

  plannerRecallHandoffs.delete(normalizedChatId);
  return handoff;
}

function preparePlannerRecallHandoff({
  rawUserInput = "",
  plannerAugmentedMessage = "",
  plannerRecall = null,
  chatId = getCurrentChatId(),
} = {}) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const normalizedRawUserInput = normalizeRecallInputText(rawUserInput);
  const normalizedPlannerAugmentedMessage = normalizeRecallInputText(
    plannerAugmentedMessage,
  );
  const result = plannerRecall?.result || null;
  if (!normalizedChatId || !normalizedRawUserInput || !result) {
    return null;
  }

  cleanupPlannerRecallHandoffs();
  const createdAt = Date.now();
  const injectionText = normalizeRecallInputText(
    plannerRecall?.memoryBlock || formatInjection(result, getSchema()),
  );
  const handoff = {
    id: [
      normalizedChatId,
      hashRecallInput(normalizedRawUserInput),
      createdAt,
    ].join(":"),
    chatId: normalizedChatId,
    rawUserInput: normalizedRawUserInput,
    plannerAugmentedMessage: normalizedPlannerAugmentedMessage,
    result,
    recentMessages: Array.isArray(plannerRecall?.recentMessages)
      ? plannerRecall.recentMessages.map((item) => String(item || ""))
      : [],
    injectionText,
    source: "planner-handoff",
    sourceLabel: "Planner handoff",
    createdAt,
    updatedAt: createdAt,
  };
  plannerRecallHandoffs.set(normalizedChatId, handoff);
  return handoff;
}

function buildPreGenerationRecallKey(type, options = {}) {
  const targetUserMessageIndex = Number.isFinite(options.targetUserMessageIndex)
    ? options.targetUserMessageIndex
    : "none";
  const seedText =
    options.overrideUserMessage ||
    options.userMessage ||
    `@target:${targetUserMessageIndex}`;

  const normalizedChatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId(),
  );

  return [
    normalizedChatId,
    String(type || "normal").trim() || "normal",
    hashRecallInput(seedText || ""),
  ].join(":");
}

function cleanupGenerationRecallTransactions(now = Date.now()) {
  for (const [
    transactionId,
    transaction,
  ] of generationRecallTransactions.entries()) {
    if (
      !transaction ||
      now - (transaction.updatedAt || 0) > GENERATION_RECALL_TRANSACTION_TTL_MS
    ) {
      generationRecallTransactions.delete(transactionId);
    }
  }
}

function getGenerationRecallPeerHookName(hookName = "") {
  const normalized = String(hookName || "").trim();
  if (normalized === "GENERATION_AFTER_COMMANDS") {
    return "GENERATE_BEFORE_COMBINE_PROMPTS";
  }
  if (normalized === "GENERATE_BEFORE_COMBINE_PROMPTS") {
    return "GENERATION_AFTER_COMMANDS";
  }
  return "";
}

function isGenerationRecallTransactionWithinBridgeWindow(
  transaction,
  now = Date.now(),
) {
  if (!transaction) return false;
  return (
    now - Number(transaction.updatedAt || transaction.createdAt || 0) <=
    GENERATION_RECALL_HOOK_BRIDGE_MS
  );
}

function normalizeGenerationRecallTransactionType(generationType = "normal") {
  const normalized = String(generationType || "normal").trim() || "normal";
  return normalized === "normal" ? "normal" : "history";
}

function resolveGenerationRecallDeliveryMode(
  hookName,
  generationType = "normal",
  recallOptions = {},
) {
  if (recallOptions?.forceImmediateDelivery === true) {
    return "immediate";
  }

  const normalizedType = normalizeGenerationRecallTransactionType(
    recallOptions?.generationType || generationType,
  );
  if (normalizedType !== "normal") {
    return "immediate";
  }

  // GENERATION_AFTER_COMMANDS: immediate —— await 完召回后直接通过
  // setExtensionPrompt 注入记忆，与 shujuku 参考实现一致。
  // GENERATE_BEFORE_COMBINE_PROMPTS: deferred —— 作为兜底，通过 promptData
  // rewrite 补救注入。
  if (hookName === "GENERATE_BEFORE_COMBINE_PROMPTS") {
    return "deferred";
  }
  return "immediate";
}

function shouldUseAuthoritativeGenerationRecallInput(recallOptions = {}) {
  const normalizedGenerationType = normalizeGenerationRecallTransactionType(
    recallOptions?.generationType || "normal",
  );
  if (normalizedGenerationType !== "normal") {
    return false;
  }
  return Boolean(getSettings()?.recallUseAuthoritativeGenerationInput);
}

function shouldPreserveAuthoritativeGenerationRecallText(
  source,
  overrideUserMessage,
  targetUserMessageText,
  recallOptions = {},
) {
  if (!shouldUseAuthoritativeGenerationRecallInput(recallOptions)) {
    return false;
  }
  const normalizedOverride = normalizeRecallInputText(overrideUserMessage);
  const normalizedTarget = normalizeRecallInputText(targetUserMessageText);
  if (!normalizedOverride || !normalizedTarget || normalizedOverride === normalizedTarget) {
    return false;
  }
  const normalizedSource = String(source || "").trim();
  return [
    "send-intent",
    "generation-started-send-intent",
    "generation-started-textarea",
    "host-generation-lifecycle",
    "textarea-live",
    "planner-handoff",
  ].includes(normalizedSource);
}

function freezeGenerationRecallOptionsForTransaction(
  chat,
  generationType = "normal",
  recallOptions = {},
) {
  if (!Array.isArray(chat)) return null;

  const optionGenerationType =
    String(
      recallOptions?.generationType || generationType || "normal",
    ).trim() || "normal";
  const normalizedGenerationType = optionGenerationType;

  const overrideUserMessage = normalizeRecallInputText(
    recallOptions?.overrideUserMessage || recallOptions?.userMessage || "",
  );

  const source =
    String(
      recallOptions?.overrideSource || recallOptions?.source || "",
    ).trim() ||
    (normalizeGenerationRecallTransactionType(normalizedGenerationType) ===
    "normal"
      ? "chat-tail-user"
      : "chat-last-user");
  const sourceLabel =
    String(
      recallOptions?.overrideSourceLabel ||
        recallOptions?.sourceLabel ||
        getRecallUserMessageSourceLabel(source),
    ).trim() || getRecallUserMessageSourceLabel(source);
  const sourceReason =
    String(
      recallOptions?.overrideReason || recallOptions?.reason || "",
    ).trim() || "transaction-source-frozen";
  const sourceCandidates = Array.isArray(recallOptions?.sourceCandidates)
    ? recallOptions.sourceCandidates
        .map((candidate) => ({
          text: normalizeRecallInputText(candidate?.text || ""),
          source: String(candidate?.source || "").trim(),
          sourceLabel: String(candidate?.sourceLabel || "").trim(),
          reason: String(candidate?.reason || "").trim(),
          includeSyntheticUserMessage: Boolean(
            candidate?.includeSyntheticUserMessage,
          ),
        }))
        .filter((candidate) => candidate.text && candidate.source)
    : [];

  let targetUserMessageIndex = Number.isFinite(
    recallOptions?.targetUserMessageIndex,
  )
    ? Math.floor(Number(recallOptions.targetUserMessageIndex))
    : resolveGenerationTargetUserMessageIndex(chat, {
        generationType: normalizedGenerationType,
      });

  if (!Number.isFinite(targetUserMessageIndex)) {
    if (
      normalizeGenerationRecallTransactionType(normalizedGenerationType) ===
        "normal" &&
      overrideUserMessage
    ) {
      return {
        generationType: normalizedGenerationType,
        targetUserMessageIndex: null,
        overrideUserMessage,
        overrideSource: source,
        overrideSourceLabel: sourceLabel,
        overrideReason: sourceReason,
        sourceCandidates,
        lockedSource: source,
        lockedSourceLabel: sourceLabel,
        lockedReason: sourceReason,
        authoritativeInputUsed: false,
        boundUserFloorText: "",
        includeSyntheticUserMessage: Boolean(
          recallOptions?.includeSyntheticUserMessage,
        ),
      };
    }
    return null;
  }
  targetUserMessageIndex = Math.floor(targetUserMessageIndex);

  const targetUserMessage = chat[targetUserMessageIndex];
  if (!targetUserMessage?.is_user) {
    return null;
  }

  const targetUserMessageText = normalizeRecallInputText(targetUserMessage?.mes || "");
  const preserveAuthoritativeText = shouldPreserveAuthoritativeGenerationRecallText(
    source,
    overrideUserMessage,
    targetUserMessageText,
    recallOptions,
  );
  const frozenUserMessage = preserveAuthoritativeText
    ? normalizeRecallInputText(overrideUserMessage)
    : normalizeRecallInputText(
        targetUserMessage?.mes ||
          recallOptions?.overrideUserMessage ||
          recallOptions?.userMessage ||
          "",
      );
  if (!frozenUserMessage) {
    return null;
  }

  return {
    generationType: normalizedGenerationType,
    targetUserMessageIndex,
    overrideUserMessage: frozenUserMessage,
    overrideSource: source,
    overrideSourceLabel: sourceLabel,
    overrideReason:
      sourceReason ||
      (frozenUserMessage === overrideUserMessage
        ? "transaction-source-frozen"
        : "transaction-bound-to-chat-user-floor"),
    sourceCandidates,
    lockedSource: source,
    lockedSourceLabel: sourceLabel,
    lockedReason:
      sourceReason ||
      (frozenUserMessage === overrideUserMessage
        ? "transaction-source-frozen"
        : "transaction-bound-to-chat-user-floor"),
    authoritativeInputUsed: preserveAuthoritativeText,
    boundUserFloorText: targetUserMessageText,
    includeSyntheticUserMessage: preserveAuthoritativeText,
  };
}

function buildGenerationRecallTransactionId(chatId, generationType, recallKey) {
  return [
    String(chatId || ""),
    String(generationType || "normal").trim() || "normal",
    String(recallKey || ""),
  ].join(":");
}

function beginGenerationRecallTransaction({
  chatId,
  generationType = "normal",
  recallKey = "",
  forceNew = false,
} = {}) {
  const normalizedChatId = String(chatId || "");
  const normalizedGenerationType =
    String(generationType || "normal").trim() || "normal";
  const normalizedRecallKey = String(recallKey || "");
  if (!normalizedChatId || !normalizedRecallKey) return null;

  cleanupGenerationRecallTransactions();
  const transactionId = buildGenerationRecallTransactionId(
    normalizedChatId,
    normalizedGenerationType,
    normalizedRecallKey,
  );

  const now = Date.now();
  const existingTransaction =
    generationRecallTransactions.get(transactionId) || null;
  if (
    existingTransaction &&
    isGenerationRecallTransactionWithinBridgeWindow(existingTransaction, now) &&
    !forceNew
  ) {
    existingTransaction.updatedAt = now;
    generationRecallTransactions.set(transactionId, existingTransaction);
    return existingTransaction;
  }

  const transaction = {
    id: transactionId,
    chatId: normalizedChatId,
    generationType: normalizedGenerationType,
    recallKey: normalizedRecallKey,
    hookStates: {},
    createdAt: now,
    frozenRecallOptions: null,
  };
  transaction.updatedAt = now;
  generationRecallTransactions.set(transactionId, transaction);
  return transaction;
}

function findRecentGenerationRecallTransactionForChat(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;

  let latestTransaction = null;
  for (const transaction of generationRecallTransactions.values()) {
    if (!transaction || String(transaction.chatId || "") !== normalizedChatId)
      continue;
    if (!isGenerationRecallTransactionWithinBridgeWindow(transaction, now))
      continue;
    if (
      !latestTransaction ||
      Number(transaction.updatedAt || 0) >
        Number(latestTransaction.updatedAt || 0)
    ) {
      latestTransaction = transaction;
    }
  }

  return latestTransaction;
}

function shouldReuseRecentGenerationRecallTransaction(
  transaction,
  hookName,
  recallKey = "",
  now = Date.now(),
) {
  if (!transaction || !hookName) return false;
  if (!isGenerationRecallTransactionWithinBridgeWindow(transaction, now)) {
    return false;
  }

  const hookStates = transaction.hookStates || {};
  const normalizedRecallKey = String(recallKey || "");
  const transactionRecallKey = String(transaction.recallKey || "");

  if (Object.values(hookStates).includes("running")) {
    return true;
  }

  const peerHookName = getGenerationRecallPeerHookName(hookName);
  const peerHookState = peerHookName ? hookStates[peerHookName] : "";
  if (peerHookState) {
    return true;
  }

  const ownState = hookStates[hookName];
  if (ownState) {
    return ownState === "running";
  }

  if (!Object.keys(hookStates).length) {
    if (!transactionRecallKey) {
      return true;
    }
    if (!normalizedRecallKey) {
      return false;
    }
    if (normalizedRecallKey !== transactionRecallKey) {
      return false;
    }
    return true;
  }

  return false;
}

function markGenerationRecallTransactionHookState(
  transaction,
  hookName,
  state = "completed",
) {
  if (!transaction?.id || !hookName) return transaction;
  transaction.hookStates ||= {};
  transaction.hookStates[hookName] = state;
  transaction.updatedAt = Date.now();
  generationRecallTransactions.set(transaction.id, transaction);
  return transaction;
}

function getGenerationRecallTransactionResult(transaction) {
  return transaction?.lastRecallResult || null;
}

function storeGenerationRecallTransactionResult(
  transaction,
  recallResult = null,
  meta = {},
) {
  if (!transaction?.id) return transaction;
  transaction.lastRecallResult = recallResult ? { ...recallResult } : null;
  transaction.lastRecallMeta =
    meta && typeof meta === "object" ? { ...meta } : {};
  transaction.lastDeliveryMode =
    String(meta?.deliveryMode || recallResult?.deliveryMode || "").trim() ||
    transaction.lastDeliveryMode ||
    "";
  transaction.finalResolution = null;
  transaction.updatedAt = Date.now();
  generationRecallTransactions.set(transaction.id, transaction);
  return transaction;
}

function clearGenerationRecallTransactionsForChat(
  chatId = getCurrentChatId(),
  { clearAll = false } = {},
) {
  let removed = 0;
  const normalizedChatId = String(chatId || "");
  if (clearAll || !normalizedChatId) {
    removed = generationRecallTransactions.size;
    generationRecallTransactions.clear();
    return removed;
  }

  for (const [
    transactionId,
    transaction,
  ] of generationRecallTransactions.entries()) {
    if (String(transaction?.chatId || "") !== normalizedChatId) continue;
    generationRecallTransactions.delete(transactionId);
    removed += 1;
  }

  return removed;
}

function invalidateRecallAfterHistoryMutation(reason = "聊天记录已变更") {
  if (isRestoreLockActive()) {
    return false;
  }

  const hadActiveRecall = Boolean(
    isRecalling ||
    (stageAbortControllers.recall &&
      !stageAbortControllers.recall.signal?.aborted),
  );
  if (hadActiveRecall) {
    abortRecallStageWithReason(`${reason}，当前召回已取消`);
  }

  clearGenerationRecallTransactionsForChat();
  clearRecallInputTracking();
  clearCurrentGenerationTrivialSkip("history-mutation");
  clearInjectionState({
    preserveRecallStatus: hadActiveRecall,
    preserveRuntimeStatus: hadActiveRecall,
  });

  if (hadActiveRecall) {
    setLastRecallStatus(
      "召回已取消",
      `${reason}，等待新的召回请求`,
      "warning",
      {
        syncRuntime: true,
      },
    );
  }

  return hadActiveRecall;
}

function createGenerationRecallContext({
  hookName,
  generationType = "normal",
  recallOptions = {},
  chatId = getCurrentChatId(),
} = {}) {
  const context = getContext();
  const chat = context?.chat;
  const normalizedChatId = normalizeChatIdCandidate(
    chatId || context?.chatId || getCurrentChatId(),
  );
  const effectiveGenerationType = normalizeGenerationRecallTransactionType(
    recallOptions?.generationType || generationType,
  );
  const plannerRecallHandoff =
    effectiveGenerationType === "normal"
      ? peekPlannerRecallHandoff(normalizedChatId)
      : null;
  const effectiveRecallOptions = plannerRecallHandoff
    ? {
        ...(recallOptions || {}),
        overrideUserMessage: plannerRecallHandoff.rawUserInput,
        overrideSource: plannerRecallHandoff.source || "planner-handoff",
        overrideSourceLabel:
          plannerRecallHandoff.sourceLabel || "Planner handoff",
        overrideReason: "planner-handoff-reuse",
        sourceCandidates: [
          {
            text: plannerRecallHandoff.rawUserInput,
            source: plannerRecallHandoff.source || "planner-handoff",
            sourceLabel:
              plannerRecallHandoff.sourceLabel || "Planner handoff",
            reason: "planner-handoff-reuse",
            includeSyntheticUserMessage: false,
          },
        ],
        includeSyntheticUserMessage: false,
      }
    : recallOptions;

  const frozenRecallOptions = freezeGenerationRecallOptionsForTransaction(
    chat,
    generationType,
    effectiveRecallOptions,
  );
  if (!frozenRecallOptions) {
    return {
      hookName,
      generationType,
      recallKey: "",
      transaction: null,
      recallOptions: null,
      shouldRun: false,
      guardReason: "missing-frozen-recall-options",
    };
  }

  const transactionGenerationType = normalizeGenerationRecallTransactionType(
    frozenRecallOptions.generationType || generationType,
  );
  const fallbackRecallKey =
    effectiveRecallOptions?.recallKey ||
    buildPreGenerationRecallKey(transactionGenerationType, {
      ...frozenRecallOptions,
      chatId: normalizedChatId,
      userMessage: frozenRecallOptions.overrideUserMessage,
    });

  if (!normalizedChatId || !String(fallbackRecallKey || "").trim()) {
    return {
      hookName,
      generationType: transactionGenerationType,
      recallKey: "",
      transaction: null,
      recallOptions: null,
      shouldRun: false,
      guardReason: !normalizedChatId ? "missing-chat-id" : "missing-recall-key",
    };
  }

  const now = Date.now();
  const recentTransaction = findRecentGenerationRecallTransactionForChat(
    normalizedChatId,
    now,
  );
  let transaction = recentTransaction;
  if (
    !shouldReuseRecentGenerationRecallTransaction(
      transaction,
      hookName,
      fallbackRecallKey,
      now,
    )
  ) {
    transaction = beginGenerationRecallTransaction({
      chatId: normalizedChatId,
      generationType: transactionGenerationType,
      recallKey: fallbackRecallKey,
      forceNew: true,
    });
  }

  if (!transaction) {
    return {
      hookName,
      generationType: transactionGenerationType,
      recallKey: "",
      transaction: null,
      recallOptions: null,
      shouldRun: false,
      guardReason: "transaction-unavailable",
    };
  }

  const normalizedTransactionChatId = normalizeChatIdCandidate(
    transaction.chatId,
  );
  const transactionRecallKey = String(transaction.recallKey || "").trim();
  const peerHookName = getGenerationRecallPeerHookName(hookName);
  const hasPeerHookState = Boolean(
    peerHookName && transaction.hookStates?.[peerHookName],
  );
  if (
    normalizedTransactionChatId !== normalizedChatId ||
    !transactionRecallKey ||
    (!hasPeerHookState && transactionRecallKey !== String(fallbackRecallKey))
  ) {
    return {
      hookName,
      generationType: transactionGenerationType,
      recallKey: String(fallbackRecallKey || ""),
      transaction,
      recallOptions: null,
      shouldRun: false,
      guardReason: "transaction-mismatch",
    };
  }

  if (
    !transaction.frozenRecallOptions ||
    typeof transaction.frozenRecallOptions !== "object"
  ) {
    transaction.frozenRecallOptions = {
      ...frozenRecallOptions,
      lockedSource:
        frozenRecallOptions?.lockedSource ||
        frozenRecallOptions?.overrideSource ||
        frozenRecallOptions?.source ||
        "",
      lockedSourceLabel:
        frozenRecallOptions?.lockedSourceLabel ||
        frozenRecallOptions?.overrideSourceLabel ||
        frozenRecallOptions?.sourceLabel ||
        "",
      lockedReason:
        frozenRecallOptions?.lockedReason ||
        frozenRecallOptions?.overrideReason ||
        frozenRecallOptions?.reason ||
        "",
      lockedAt: now,
    };
  }
  if (!String(transaction.generationType || "").trim()) {
    transaction.generationType = transactionGenerationType;
  }
  transaction.updatedAt = now;
  generationRecallTransactions.set(transaction.id, transaction);

  const boundRecallOptions = {
    ...(transaction.frozenRecallOptions || frozenRecallOptions),
    recallKey: transaction.recallKey,
    generationType:
      transaction.frozenRecallOptions?.generationType || generationType,
  };
  if (plannerRecallHandoff?.result) {
    boundRecallOptions.cachedRecallPayload = {
      handoffId: plannerRecallHandoff.id,
      chatId: plannerRecallHandoff.chatId,
      result: plannerRecallHandoff.result,
      recentMessages: Array.isArray(plannerRecallHandoff.recentMessages)
        ? plannerRecallHandoff.recentMessages.map((item) => String(item || ""))
        : [],
      injectionText: String(plannerRecallHandoff.injectionText || ""),
      source: plannerRecallHandoff.source || "planner-handoff",
      sourceLabel: plannerRecallHandoff.sourceLabel || "Planner handoff",
      reason: "planner-handoff-reuse",
    };
  }

  const recallKey = transactionRecallKey;
  const shouldRun = shouldRunRecallForTransaction(transaction, hookName);

  return {
    hookName,
    generationType: boundRecallOptions.generationType,
    recallKey,
    transaction,
    recallOptions: boundRecallOptions,
    shouldRun,
    guardReason: shouldRun ? "" : "transaction-not-runnable",
  };
}

function getCurrentChatSeq(context = getContext()) {
  const chat = context?.chat;
  if (Array.isArray(chat) && chat.length > 0) {
    return chat.length - 1;
  }
  return currentGraph?.lastProcessedSeq ?? 0;
}

async function handleExtractionSuccess(
  result,
  endIdx,
  settings,
  signal = undefined,
  status = createBatchStatusSkeleton({
    processedRange: [endIdx, endIdx],
    extractionCountBefore: extractionCount,
  }),
  postProcessContext = null,
) {
  const postProcessArtifacts = [];
  const newNodeCount = Array.isArray(result?.newNodeIds)
    ? result.newNodeIds.length
    : 0;
  const resolveAutoConsolidationGate =
    typeof evaluateAutoConsolidationGate === "function"
      ? evaluateAutoConsolidationGate
      : (count, analysis = null, localSettings = {}) => {
          const minNewNodes = Math.max(
            1,
            Math.min(
              50,
              Math.floor(
                Number(localSettings?.consolidationAutoMinNewNodes ?? 2),
              ) || 2,
            ),
          );
          const safeCount = Math.max(0, Number(count) || 0);
          if (safeCount >= minNewNodes) {
            return {
              shouldRun: true,
              minNewNodes,
              reason: `本批新增 ${safeCount} 个节点，达到自动整合门槛 ${minNewNodes}`,
              matchedScore: null,
              matchedNodeId: "",
            };
          }
          if (analysis?.triggered) {
            return {
              shouldRun: true,
              minNewNodes,
              reason:
                String(analysis.reason || "").trim() ||
                "检测到高重复风险，已触发自动整合",
              matchedScore: Number.isFinite(Number(analysis?.matchedScore))
                ? Number(analysis.matchedScore)
                : null,
              matchedNodeId: String(analysis?.matchedNodeId || ""),
            };
          }
          return {
            shouldRun: false,
            minNewNodes,
            reason:
              String(analysis?.reason || "").trim() ||
              `本批新增少且无明显重复风险，跳过自动整合`,
            matchedScore: Number.isFinite(Number(analysis?.matchedScore))
              ? Number(analysis.matchedScore)
              : null,
            matchedNodeId: String(analysis?.matchedNodeId || ""),
          };
        };
  const analyzeConsolidationGate =
    typeof analyzeAutoConsolidationGate === "function"
      ? analyzeAutoConsolidationGate
      : async () => ({
          triggered: false,
          reason: "本批新增少且无明显重复风险，跳过自动整合",
          matchedScore: null,
          matchedNodeId: "",
        });
  const resolveAutoCompressionSchedule =
    typeof evaluateAutoCompressionSchedule === "function"
      ? evaluateAutoCompressionSchedule
      : (currentCount, localSettings = {}) => {
          const enabled = localSettings?.enableAutoCompression !== false;
          const parsedEveryN = Math.floor(Number(localSettings?.compressionEveryN));
          const everyN =
            Number.isFinite(parsedEveryN) && parsedEveryN >= 1
              ? Math.min(500, parsedEveryN)
              : 10;
          const safeCount = Math.max(0, Number(currentCount) || 0);
          if (!enabled) {
            return {
              scheduled: false,
              everyN,
              nextExtractionCount: null,
              reason: "自动压缩开关已关闭",
            };
          }
          const remainder = safeCount % everyN;
          if (remainder !== 0) {
            return {
              scheduled: false,
              everyN,
              nextExtractionCount: safeCount + (everyN - remainder),
              reason: `当前为第 ${safeCount} 次提取，未到每 ${everyN} 次自动压缩周期`,
            };
          }
          return {
            scheduled: true,
            everyN,
            nextExtractionCount: safeCount + everyN,
            reason: "",
          };
        };
  const inspectCompressionCandidates =
    typeof inspectAutoCompressionCandidates === "function"
      ? inspectAutoCompressionCandidates
      : () => ({
          hasCandidates: false,
          reason: "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组",
        });
  const applyMaintenanceGateNote =
    typeof noteMaintenanceGate === "function"
      ? noteMaintenanceGate
      : (batchStatus, action, reason) => {
          if (!batchStatus || !reason) return;
          batchStatus.maintenanceGateApplied = true;
          const details = Array.isArray(batchStatus.maintenanceGateDetails)
            ? batchStatus.maintenanceGateDetails
            : [];
          details.push({
            action: String(action || "").trim() || "unknown",
            reason: String(reason || ""),
          });
          batchStatus.maintenanceGateDetails = details;
          batchStatus.maintenanceGateReason = details
            .map((item) => `${item.action}: ${item.reason}`)
            .join(" | ");
        };
  const summarizeMaintenance =
    typeof buildMaintenanceSummary === "function"
      ? buildMaintenanceSummary
      : (action, maintenanceResult, mode = "manual") => {
          const prefix = mode === "auto" ? "自动" : "手动";
          switch (String(action || "")) {
            case "compress":
              return `${prefix}压缩：新增 ${maintenanceResult?.created || 0}，归档 ${maintenanceResult?.archived || 0}`;
            case "consolidate":
              return `${prefix}整合：合并 ${maintenanceResult?.merged || 0}，跳过 ${maintenanceResult?.skipped || 0}，保留 ${maintenanceResult?.kept || 0}，进化 ${maintenanceResult?.evolved || 0}，新链接 ${maintenanceResult?.connections || 0}，回溯更新 ${maintenanceResult?.updates || 0}`;
            case "sleep":
              return `${prefix}遗忘：归档 ${maintenanceResult?.forgotten || 0} 个节点`;
            default:
              return `${prefix}维护已执行`;
          }
        };
  const runSummaryPostProcess = runSummaryPostProcessPlanCommit;
  const summaryStageLabel = getSummaryStageLabel();
  const cloneMaintenanceSnapshot =
    typeof cloneGraphSnapshot === "function"
      ? cloneGraphSnapshot
      : (value) => JSON.parse(JSON.stringify(value ?? null));
  const persistMaintenanceAction =
    typeof recordMaintenanceAction === "function"
      ? recordMaintenanceAction
      : () => null;
  const updateExtractionPostProcessStatus = (
    text,
    meta,
    { noticeMarquee = false } = {},
  ) => {
    if (typeof setLastExtractionStatus !== "function") return;
    setLastExtractionStatus(text, meta, "running", {
      syncRuntime: true,
      noticeMarquee,
    });
  };
  const deferredMaintenance = [];
  const maintenancePostProcessConcurrency =
    resolveMaintenancePostProcessConcurrency(settings);
  const enqueueDeferredMaintenance = (task) => {
    if (!task || typeof task !== "object" || !task.type) return null;
    const normalizedTask = {
      id: String(task.id || `${task.type}:${Date.now()}:${endIdx}`),
      type: String(task.type),
      mode: maintenancePostProcessConcurrency.mode,
      reason: String(task.reason || `background-${task.type}-after-extraction`),
      payload:
        task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
          ? clonePlanCommitValue(task.payload, {})
          : {},
    };
    deferredMaintenance.push(normalizedTask);
    status.backgroundMaintenanceQueued = true;
    status.backgroundMaintenanceMode = normalizedTask.mode;
    status.backgroundMaintenanceTasks = deferredMaintenance.map((item) => ({
      id: item.id,
      type: item.type,
      reason: item.reason,
    }));
    pushBatchStageArtifact(status, "finalize", `${normalizedTask.type}-queued`);
    return normalizedTask;
  };
  throwIfAborted(signal, "提取已终止");
  extractionCount++;
  ensureCurrentGraphRuntimeState();
  currentGraph.historyState.extractionCount = extractionCount;
  updateLastExtractedItems(result.newNodeIds || []);
  setBatchStageOutcome(status, "core", "success");
  updateExtractionPostProcessStatus(
    "提取收尾中",
    `已抽取 ${newNodeCount} 个新节点，正在处理后续阶段`,
  );

  const consolidationCandidateNodeIds = Array.from(
    new Set(
      [
        ...(Array.isArray(postProcessContext?.pendingAutoConsolidationNodeIds)
          ? postProcessContext.pendingAutoConsolidationNodeIds
          : []),
        ...(Array.isArray(result?.newNodeIds) ? result.newNodeIds : []),
      ]
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );
  const consolidationCandidateCount = consolidationCandidateNodeIds.length;

  if (settings.enableConsolidation && consolidationCandidateCount > 0) {
    const suppressAutoConsolidation =
      postProcessContext?.suppressAutoConsolidation === true;
    if (suppressAutoConsolidation) {
      const reason =
        String(postProcessContext?.autoConsolidationSuppressReason || "").trim() ||
        "批量提取进行中，已跳过本批自动整合";
      status.consolidationGateTriggered = false;
      status.consolidationGateReason = reason;
      status.consolidationGateSimilarity = null;
      status.consolidationGateMatchedNodeId = "";
      applyMaintenanceGateNote(status, "consolidate", reason);
      pushBatchStageArtifact(status, "structural", "consolidation-skipped");
    } else {
      let consolidationAnalysis = null;
      const minNewNodes = Math.max(
        1,
        Math.min(
          50,
          Math.floor(Number(settings?.consolidationAutoMinNewNodes ?? 2)) || 2,
        ),
      );
      if (consolidationCandidateCount < minNewNodes) {
        updateExtractionPostProcessStatus(
          "整合判定中",
          `本窗口候选 ${consolidationCandidateCount} 个节点，正在检查是否需要自动整合/进化`,
        );
        consolidationAnalysis = await analyzeConsolidationGate({
          graph: currentGraph,
          newNodeIds: consolidationCandidateNodeIds,
          embeddingConfig: getEmbeddingConfig(),
          schema: getSchema(),
          conflictThreshold: settings.consolidationThreshold,
          signal,
        });
      }
      const gate = resolveAutoConsolidationGate(
        consolidationCandidateCount,
        consolidationAnalysis,
        settings,
      );
      status.consolidationGateTriggered = Boolean(gate.shouldRun);
      status.consolidationGateReason = String(gate.reason || "");
      status.consolidationGateSimilarity = Number.isFinite(
        Number(gate.matchedScore),
      )
        ? Number(gate.matchedScore)
        : null;
      status.consolidationGateMatchedNodeId = String(gate.matchedNodeId || "");
      if (!gate.shouldRun) {
        applyMaintenanceGateNote(status, "consolidate", gate.reason);
        pushBatchStageArtifact(status, "structural", "consolidation-skipped");
      } else {
        try {
          updateExtractionPostProcessStatus(
            "整合/进化中",
            String(gate.reason || "").trim() || "正在自动整合新旧记忆",
          );
          const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
          const consolidationResult = await consolidateMemories({
            graph: currentGraph,
            newNodeIds: consolidationCandidateNodeIds,
            embeddingConfig: getEmbeddingConfig(),
            options: {
              neighborCount: settings.consolidationNeighborCount,
              conflictThreshold: settings.consolidationThreshold,
            },
            settings,
            signal,
          });
          persistMaintenanceAction({
            action: "consolidate",
            beforeSnapshot,
            mode: "auto",
            summary: summarizeMaintenance(
              "consolidate",
              consolidationResult,
              "auto",
            ),
          });
          postProcessArtifacts.push("consolidation");
          pushBatchStageArtifact(status, "structural", "consolidation");
        } catch (e) {
          if (isAbortError(e)) throw e;
          const message = e?.message || String(e) || "记忆整合阶段失败";
          setBatchStageOutcome(
            status,
            "structural",
            "partial",
            `记忆整合失败: ${message}`,
          );
          console.error("[ST-BME] 记忆整合失败:", e);
        }
      }
    }
  }

  if (settings.enableHierarchicalSummary !== false) {
    try {
      const currentChatMessages =
        typeof getContext === "function" && Array.isArray(getContext()?.chat)
          ? getContext().chat
          : [];
      const summaryPayload = {
        chat: clonePlanCommitValue(currentChatMessages, []),
        currentExtractionCount: extractionCount,
        currentAssistantFloor: endIdx,
        currentRange: result?.processedRange || [endIdx, endIdx],
        currentNodeIds: result?.changedNodeIds || result?.newNodeIds || [],
      };
      if (shouldDeferExtractionMaintenance(settings)) {
        enqueueDeferredMaintenance({
          type: "summary",
          reason: "background-summary-after-extraction",
          payload: summaryPayload,
        });
        updateExtractionPostProcessStatus(
          "层级总结已排队",
          `${maintenancePostProcessConcurrency.mode} 模式：层级总结将在批次持久化后后台执行`,
        );
        pushBatchStageArtifact(status, "semantic", "summary-queued");
      } else {
        updateExtractionPostProcessStatus(
          summaryStageLabel === "旧式全局概要生成" ? "旧式全局概要更新中" : "层级总结处理中",
          summaryStageLabel === "旧式全局概要生成"
            ? `${extractionCount} 次提取，正在生成旧式全局概要`
            : `${extractionCount} 次提取，正在检查小总结与折叠总结`,
        );
        const summaryResult = await runSummaryPostProcess({
          graph: currentGraph,
          chat: currentChatMessages,
          settings,
          signal,
          ...summaryPayload,
        });
        if (summaryResult?.smallSummary?.created) {
          postProcessArtifacts.push("summary");
          pushBatchStageArtifact(status, "semantic", "summary");
        } else if (summaryResult?.smallSummary?.reason) {
          applyMaintenanceGateNote(status, "summary", summaryResult.smallSummary.reason);
        }
        if (Number(summaryResult?.rollup?.createdCount || 0) > 0) {
          postProcessArtifacts.push("summary-rollup");
          pushBatchStageArtifact(status, "semantic", "summary-rollup");
        }
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || `${summaryStageLabel}阶段失败`;
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `${summaryStageLabel}失败: ${message}`,
      );
      console.error(`[ST-BME] ${summaryStageLabel}失败:`, e);
    }
  }

  if (
    settings.enableReflection &&
    extractionCount % settings.reflectEveryN === 0
  ) {
    try {
      const reflectionPayload = { currentSeq: endIdx };
      if (shouldDeferExtractionMaintenance(settings)) {
        enqueueDeferredMaintenance({
          type: "reflection",
          reason: "background-reflection-after-extraction",
          payload: reflectionPayload,
        });
        updateExtractionPostProcessStatus(
          "反思生成已排队",
          `${maintenancePostProcessConcurrency.mode} 模式：长期反思将在批次持久化后后台执行`,
        );
        pushBatchStageArtifact(status, "semantic", "reflection-queued");
      } else {
        updateExtractionPostProcessStatus(
          "反思生成中",
          `${extractionCount} 次提取，正在生成长期反思`,
        );
        const reflectionResult = await runReflectionPostProcessPlanCommit({
          graph: currentGraph,
          currentSeq: endIdx,
          schema: getSchema(),
          embeddingConfig: getEmbeddingConfig(),
          settings,
          signal,
        });
        if (reflectionResult?.reflectionId) {
          postProcessArtifacts.push("reflection");
          pushBatchStageArtifact(status, "semantic", "reflection");
        }
      }
    } catch (e) {
      if (isAbortError(e)) throw e;
      const message = e?.message || String(e) || "反思生成阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `反思生成失败: ${message}`,
      );
      console.error("[ST-BME] 反思生成失败:", e);
    }
  }

  if (
    settings.enableSleepCycle &&
    extractionCount % settings.sleepEveryN === 0
  ) {
    try {
      updateExtractionPostProcessStatus(
        "主动遗忘中",
        `${extractionCount} 次提取，正在归档低价值记忆`,
      );
      const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
      const sleepResult = sleepCycle(currentGraph, settings);
      if ((sleepResult?.forgotten || 0) > 0) {
        persistMaintenanceAction({
          action: "sleep",
          beforeSnapshot,
          mode: "auto",
          summary: summarizeMaintenance("sleep", sleepResult, "auto"),
        });
        postProcessArtifacts.push("sleep");
        pushBatchStageArtifact(status, "semantic", "sleep");
      }
    } catch (e) {
      const message = e?.message || String(e) || "主动遗忘阶段失败";
      setBatchStageOutcome(
        status,
        "semantic",
        "failed",
        `主动遗忘失败: ${message}`,
      );
      console.error("[ST-BME] 主动遗忘失败:", e);
    }
  }

  const compressionSchedule = resolveAutoCompressionSchedule(
    extractionCount,
    settings,
  );
  status.autoCompressionScheduled = Boolean(compressionSchedule.scheduled);
  status.nextCompressionAtExtractionCount =
    compressionSchedule.nextExtractionCount;
  status.autoCompressionSkippedReason = compressionSchedule.reason || "";

  try {
    throwIfAborted(signal, "提取已终止");
    if (compressionSchedule.scheduled) {
      const compressionInspection = inspectCompressionCandidates(
        currentGraph,
        getSchema(),
        false,
      );
      if (!compressionInspection?.hasCandidates) {
        status.autoCompressionSkippedReason =
          String(compressionInspection?.reason || "").trim() ||
          "已到自动压缩周期，但当前没有达到内部压缩阈值的候选组";
        pushBatchStageArtifact(status, "structural", "compression-skipped");
      } else {
        status.autoCompressionSkippedReason = "";
        if (shouldDeferExtractionMaintenance(settings)) {
          enqueueDeferredMaintenance({
            type: "compression",
            reason: "background-compression-after-extraction",
            payload: {
              force: false,
              customPrompt: null,
            },
          });
          updateExtractionPostProcessStatus(
            "自动压缩已排队",
            `${maintenancePostProcessConcurrency.mode} 模式：层级压缩将在批次持久化后后台执行`,
          );
          pushBatchStageArtifact(status, "structural", "compression-queued");
        } else {
          updateExtractionPostProcessStatus(
            "自动压缩中",
            `已到第 ${extractionCount} 次提取周期，正在压缩层级记忆`,
          );
          const beforeSnapshot = cloneMaintenanceSnapshot(currentGraph);
          const compressionResult = await runCompressionPostProcessPlanCommit({
            graph: currentGraph,
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            force: false,
            customPrompt: undefined,
            signal,
            settings,
          });
          if (compressionResult.created > 0 || compressionResult.archived > 0) {
            persistMaintenanceAction({
              action: "compress",
              beforeSnapshot,
              mode: "auto",
              summary: summarizeMaintenance(
                "compress",
                compressionResult,
                "auto",
              ),
            });
            postProcessArtifacts.push("compression");
            pushBatchStageArtifact(status, "structural", "compression");
          } else {
            status.autoCompressionSkippedReason =
              "已尝试自动压缩，但本轮未产生可持久化变化";
          }
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error?.message || String(error) || "压缩阶段失败";
    setBatchStageOutcome(
      status,
      "structural",
      "partial",
      `压缩阶段失败: ${message}`,
    );
    console.error("[ST-BME] 记忆压缩失败:", error);
  }

  let vectorSync = null;
  let backgroundVectorSync = null;
  const vectorSyncRangeSource = Array.isArray(result?.processedRange)
    ? result.processedRange
    : Array.isArray(status?.processedRange)
      ? status.processedRange
      : [endIdx, endIdx];
  const vectorSyncRange = {
    start: Math.min(
      Number(vectorSyncRangeSource[0] ?? endIdx),
      Number(vectorSyncRangeSource[1] ?? endIdx),
    ),
    end: Math.max(
      Number(vectorSyncRangeSource[0] ?? endIdx),
      Number(vectorSyncRangeSource[1] ?? endIdx),
    ),
  };
  if (shouldDeferExtractionVectorSync(settings)) {
    const concurrency = resolveMaintenancePostProcessConcurrency(settings);
    ensureCurrentGraphRuntimeState();
    currentGraph.vectorIndexState ||= {};
    currentGraph.vectorIndexState.dirty = true;
    currentGraph.vectorIndexState.dirtyReason = "background-vector-sync-queued";
    currentGraph.vectorIndexState.lastWarning =
      `${concurrency.mode} 模式已将本批向量同步放入后台队列`;
    backgroundVectorSync = {
      enabled: true,
      mode: concurrency.mode,
      id: `vector-sync:${Date.now()}:${endIdx}`,
      reason: "background-vector-sync-after-extraction",
      range: vectorSyncRange,
    };
    status.backgroundVectorSyncQueued = true;
    status.backgroundVectorSyncMode = concurrency.mode;
    status.backgroundVectorSyncTaskId = backgroundVectorSync.id;
    updateExtractionPostProcessStatus(
      "向量同步已排队",
      `${concurrency.mode} 模式：本批向量将在持久化后后台同步`,
    );
    if (typeof setLastVectorStatus === "function") {
      setLastVectorStatus(
        "后台向量已排队",
        `${concurrency.mode} 模式 · 等待批次持久化确认`,
        "running",
        { syncRuntime: false },
      );
    }
    pushBatchStageArtifact(status, "finalize", "vector-sync-queued");
    setBatchStageOutcome(status, "finalize", "success");
  } else {
    try {
      updateExtractionPostProcessStatus(
        "向量同步中",
        "正在同步本批提取后的向量索引",
      );
      const vectorSyncTimeoutController = new AbortController();
      const vectorSyncTimeout = setTimeout(
        () => vectorSyncTimeoutController.abort(
          new DOMException(
            `向量同步超时 (${Math.round(EXTRACTION_VECTOR_SYNC_TIMEOUT_MS / 1000)}s)`,
            "AbortError",
          ),
        ),
        EXTRACTION_VECTOR_SYNC_TIMEOUT_MS,
      );
      let vectorSyncSignal = vectorSyncTimeoutController.signal;
      if (signal) {
        try {
          if (typeof AbortSignal.any === "function") {
            vectorSyncSignal = AbortSignal.any([signal, vectorSyncTimeoutController.signal]);
          }
        } catch {}
      }
      try {
        vectorSync = await syncVectorState({ signal: vectorSyncSignal });
      } finally {
        clearTimeout(vectorSyncTimeout);
      }
    } catch (error) {
      if (isAbortError(error)) {
        const isVectorSyncTimeout = error?.name === "AbortError" &&
          typeof error?.message === "string" &&
          error.message.includes("向量同步超时");
        if (!isVectorSyncTimeout) throw error;
      }
      const message = error?.message || String(error) || "向量同步阶段失败";
      setBatchStageOutcome(
        status,
        "finalize",
        "failed",
        `向量同步失败: ${message}`,
      );
      return {
        postProcessArtifacts,
        vectorHashesInserted: [],
        vectorStats: getVectorIndexStats(currentGraph),
        vectorError: message,
        warnings: status.warnings,
        batchStatus: finalizeBatchStatus(status, extractionCount),
        backgroundVectorSync: null,
        backgroundMaintenance: deferredMaintenance,
      };
    }

    if (vectorSync?.aborted) {
      throw createAbortError(vectorSync.error || "提取已终止");
    }
    if (vectorSync?.error) {
      setBatchStageOutcome(
        status,
        "finalize",
        "failed",
        `向量同步失败: ${vectorSync.error}`,
      );
    } else {
      setBatchStageOutcome(status, "finalize", "success");
    }
  }

  status.maintenanceJournalSize =
    currentGraph?.maintenanceJournal?.length || 0;
  if (
    status.maintenanceGateApplied &&
    !status.maintenanceGateReason &&
    Array.isArray(status.maintenanceGateDetails)
  ) {
    status.maintenanceGateReason = status.maintenanceGateDetails
      .map((item) => `${item.action}: ${item.reason}`)
      .join(" | ");
  }

  return {
    postProcessArtifacts,
    vectorHashesInserted: vectorSync?.insertedHashes || [],
    vectorStats: vectorSync?.stats || getVectorIndexStats(currentGraph),
    vectorError: vectorSync?.error || "",
    warnings: status.warnings,
    batchStatus: finalizeBatchStatus(status, extractionCount),
    backgroundVectorSync,
    backgroundMaintenance: deferredMaintenance,
  };
}

function notifyHistoryDirty(dirtyFrom, reason) {
  updateStageNotice(
    "history",
    "检测到楼层历史变化",
    `将从楼层 ${dirtyFrom} 之后自动恢复${reason ? `\n${reason}` : ""}`,
    "warning",
    {
      persist: true,
      busy: true,
    },
  );
}

function clearPendingHistoryMutationChecks() {
  for (const timer of pendingHistoryMutationCheckTimers) {
    clearTimeout(timer);
  }
  pendingHistoryMutationCheckTimers = [];
}

function scheduleImmediateHistoryRecovery(
  trigger = "history-change",
  delayMs = HISTORY_RECOVERY_SETTLE_MS,
) {
  if (!getSettings().enabled) return;

  const scheduledChatId = getCurrentChatId();
  pendingHistoryRecoveryTrigger = trigger;
  clearTimeout(pendingHistoryRecoveryTimer);
  pendingHistoryRecoveryTimer = setTimeout(() => {
    pendingHistoryRecoveryTimer = null;
    const effectiveTrigger = pendingHistoryRecoveryTrigger || trigger;
    pendingHistoryRecoveryTrigger = "";
    if (!getSettings().enabled) return;
    if (getCurrentChatId() !== scheduledChatId) return;

    void recoverHistoryIfNeeded(`event:${effectiveTrigger}`)
      .then(() => {
        refreshPanelLiveState();
      })
      .catch((error) => {
        console.error("[ST-BME] 事件触发的历史恢复失败:", error);
        updateStageNotice(
          "history",
          "历史恢复失败",
          error?.message || String(error),
          "error",
          {
            busy: false,
            persist: false,
          },
        );
        toastr.error(`历史恢复失败: ${error?.message || error}`);
      });
  }, delayMs);
}

function scheduleHistoryMutationRecheck(
  trigger = "history-change",
  primaryArg = null,
  meta = null,
) {
  if (!getSettings().enabled) return;

  const scheduledChatId = getCurrentChatId();
  clearPendingHistoryMutationChecks();
  clearTimeout(pendingHistoryRecoveryTimer);
  pendingHistoryRecoveryTimer = null;
  pendingHistoryRecoveryTrigger = "";

  updateStageNotice(
    "history",
    "检测到楼层变动",
    "正在等待宿主楼层状态稳定后重新核对图谱",
    "warning",
    {
      persist: true,
      busy: true,
    },
  );

  for (const delayMs of HISTORY_MUTATION_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      pendingHistoryMutationCheckTimers =
        pendingHistoryMutationCheckTimers.filter(
          (candidate) => candidate !== timer,
        );
      if (!getSettings().enabled) return;
      if (getCurrentChatId() !== scheduledChatId) return;

      const detection = inspectHistoryMutation(
        `settled:${trigger}`,
        primaryArg,
        meta,
      );
      if (
        detection.dirty ||
        Number.isFinite(currentGraph?.historyState?.historyDirtyFrom)
      ) {
        clearPendingHistoryMutationChecks();
        scheduleImmediateHistoryRecovery(trigger, 0);
      } else if (pendingHistoryMutationCheckTimers.length === 0) {
        dismissStageNotice("history");
        refreshPanelLiveState();
      }
    }, delayMs);

    pendingHistoryMutationCheckTimers.push(timer);
  }
}

function inspectHistoryMutation(
  trigger = "history-change",
  primaryArg = null,
  meta = null,
) {
  if (!currentGraph)
    return { dirty: false, earliestAffectedFloor: null, reason: "" };

  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const chat = context?.chat;
  const renderLimitedGuard = getRenderLimitedHistoryRecoveryGuard(chat);
  if (renderLimitedGuard.blocked) {
    notifyRenderLimitedHistoryRecoveryBlocked(renderLimitedGuard, trigger);
    return {
      dirty: false,
      earliestAffectedFloor: null,
      reason: renderLimitedGuard.reason,
      source: "render-limit-guard",
      skipped: true,
    };
  }
  if (
    Array.isArray(chat) &&
    currentGraph.historyState?.processedMessageHashesNeedRefresh === true
  ) {
    rebindProcessedHistoryStateToChat(
      currentGraph,
      chat,
      getAssistantTurns(chat),
    );
    console.debug?.(
      "[ST-BME] refreshed processed message hashes after hash-version migration",
      {
        trigger,
        lastProcessedAssistantFloor:
          currentGraph.historyState.lastProcessedAssistantFloor ?? -1,
      },
    );
    if (isGraphMetadataWriteAllowed()) {
      saveGraphToChat({ reason: "processed-hash-version-migrated" });
    }
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
  }
  const metaDetection = resolveDirtyFloorFromMutationMeta(
    trigger,
    primaryArg,
    meta,
    chat,
  );
  const metaReason = String(trigger || "").includes("message-deleted")
    ? `${trigger} 元数据检测到删除边界变动`
    : `${trigger} 元数据检测到楼层变动`;
  if (
    metaDetection &&
    Number.isFinite(metaDetection.floor) &&
    metaDetection.floor <= getLastProcessedAssistantFloor()
  ) {
    clearInjectionState();
    markHistoryDirty(
      currentGraph,
      metaDetection.floor,
      metaReason,
      metaDetection.source,
    );
    saveGraphToChat({ reason: "history-dirty-meta-detection" });
    notifyHistoryDirty(metaDetection.floor, metaReason);
    return {
      dirty: true,
      earliestAffectedFloor: metaDetection.floor,
      reason: metaReason,
      source: metaDetection.source,
    };
  }
  const detection = detectHistoryMutation(chat, currentGraph.historyState);

  if (detection.dirty) {
    clearInjectionState();
    markHistoryDirty(
      currentGraph,
      detection.earliestAffectedFloor,
      detection.reason || trigger,
      "hash-recheck",
    );
    saveGraphToChat({ reason: "history-dirty-hash-recheck" });
    notifyHistoryDirty(detection.earliestAffectedFloor, detection.reason);
    return {
      ...detection,
      source: "hash-recheck",
    };
  }

  if (trigger === "message-edited" || trigger === "message-swiped") {
    clearInjectionState();
  }

  return detection;
}

async function purgeCurrentVectorCollection(signal = undefined) {
  if (!currentGraph?.vectorIndexState?.collectionId) return;

  const response = await fetchLocalWithTimeout("/api/vector/purge", {
    method: "POST",
    headers: getRequestHeaders(),
    signal,
    body: JSON.stringify({
      collectionId: currentGraph.vectorIndexState.collectionId,
    }),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(message || `HTTP ${response.status}`);
  }
}

async function prepareVectorStateForReplay(
  fullReset = false,
  signal = undefined,
  { skipBackendPurge = false } = {},
) {
  ensureCurrentGraphRuntimeState();
  const config = getEmbeddingConfig();

  if (isBackendVectorConfig(config)) {
    if (!skipBackendPurge) {
      try {
        await purgeCurrentVectorCollection(signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        console.warn("[ST-BME] 清理后端向量索引失败，继续本地恢复:", error);
      }
      currentGraph.vectorIndexState.hashToNodeId = {};
      currentGraph.vectorIndexState.nodeToHash = {};
    }
    currentGraph.vectorIndexState.dirty = true;
    if (!currentGraph.vectorIndexState.dirtyReason) {
      currentGraph.vectorIndexState.dirtyReason = skipBackendPurge
        ? "history-recovery-replay"
        : "history-recovery-reset";
    }
    if (fullReset) {
      currentGraph.vectorIndexState.replayRequiredNodeIds = [];
      currentGraph.vectorIndexState.pendingRepairFromFloor = 0;
    }
    currentGraph.vectorIndexState.lastWarning = skipBackendPurge
      ? "历史恢复后需要修复受影响后缀的后端向量索引"
      : "历史恢复后需要重建后端向量索引";
    return;
  }

  if (fullReset) {
    currentGraph.vectorIndexState.hashToNodeId = {};
    currentGraph.vectorIndexState.nodeToHash = {};
    currentGraph.vectorIndexState.replayRequiredNodeIds = [];
    currentGraph.vectorIndexState.dirty = true;
    currentGraph.vectorIndexState.dirtyReason = "history-recovery-reset";
    currentGraph.vectorIndexState.pendingRepairFromFloor = 0;
    currentGraph.vectorIndexState.lastWarning =
      "历史恢复后需要重嵌当前聊天向量";
  }
}

async function executeExtractionBatch({
  chat,
  startIdx,
  endIdx,
  settings,
  smartTriggerDecision = null,
  signal = undefined,
  postProcessContext = null,
} = {}) {
  return await executeExtractionBatchController(
    {
      appendBatchJournal,
      applyProcessedHistorySnapshotToGraph,
      buildPersistDelta,
      buildExtractionMessages,
      cloneGraphSnapshot,
      computePostProcessArtifacts,
      console,
      createBatchJournalEntry,
      createBatchStatusSkeleton,
      ensureCurrentGraphRuntimeState,
      extractMemories,
      finalizeBatchStatus,
      getCurrentGraph: () => currentGraph,
      getEmbeddingConfig,
      getExtractionCount: () => extractionCount,
      getLastProcessedAssistantFloor,
      getSettings,
      getSchema,
      handleExtractionSuccess,
      persistExtractionBatchResult,
      scheduleBackgroundMaintenancePostProcess,
      scheduleBackgroundVectorSync,
      setBatchStageOutcome,
      setLastExtractionStatus,
      shouldAdvanceProcessedHistory,
      throwIfAborted,
      updateProcessedHistorySnapshot,
    },
    {
      chat,
      startIdx,
      endIdx,
      settings,
      smartTriggerDecision,
      signal,
      postProcessContext,
    },
  );
}

async function replayExtractionFromHistory(
  chat,
  settings,
  signal = undefined,
  expectedChatId = undefined,
) {
  let replayedBatches = 0;

  while (true) {
    throwIfAborted(signal, "历史恢复已终止");
    assertRecoveryChatStillActive(expectedChatId, "replay-loop");
    const pendingAssistantTurns = getAssistantTurns(chat).filter(
      (index) => index > getLastProcessedAssistantFloor(),
    );
    if (pendingAssistantTurns.length === 0) break;

    const extractEvery = clampInt(settings.extractEvery, 1, 1, 50);
    const batchAssistantTurns = pendingAssistantTurns.slice(0, extractEvery);
    const startIdx = batchAssistantTurns[0];
    const endIdx = batchAssistantTurns[batchAssistantTurns.length - 1];

    const batchResult = await executeExtractionBatch({
      chat,
      startIdx,
      endIdx,
      settings,
      signal,
    });

    if (!batchResult.success) {
      throw new Error(
        batchResult.error ||
          batchResult?.result?.error ||
          "历史恢复回放过程中出现提取失败",
      );
    }

    replayedBatches++;
  }

  return replayedBatches;
}

function applyRecoveryPlanToVectorState(
  recoveryPlan,
  dirtyFallbackFloor = null,
) {
  ensureCurrentGraphRuntimeState();
  const vectorState = currentGraph.vectorIndexState;
  const replayRequiredNodeIds = new Set(
    Array.isArray(vectorState.replayRequiredNodeIds)
      ? vectorState.replayRequiredNodeIds.filter(Boolean)
      : [],
  );

  for (const nodeId of recoveryPlan?.replayRequiredNodeIds || []) {
    if (nodeId) replayRequiredNodeIds.add(nodeId);
  }

  const fallbackFloor = Number.isFinite(dirtyFallbackFloor)
    ? dirtyFallbackFloor
    : currentGraph.historyState?.historyDirtyFrom;
  const pendingRepairFromFloor = Number.isFinite(
    recoveryPlan?.pendingRepairFromFloor,
  )
    ? recoveryPlan.pendingRepairFromFloor
    : Number.isFinite(fallbackFloor)
      ? fallbackFloor
      : null;

  vectorState.replayRequiredNodeIds = [...replayRequiredNodeIds];
  vectorState.dirty = true;
  vectorState.dirtyReason =
    recoveryPlan?.dirtyReason ||
    vectorState.dirtyReason ||
    "history-recovery-replay";
  vectorState.pendingRepairFromFloor = pendingRepairFromFloor;
  vectorState.lastIntegrityIssue =
    recoveryPlan?.valid === false
      ? {
          scope: "history-recovery-plan",
          reason: String(recoveryPlan.invalidReason || "invalid-recovery-plan"),
          dirtyFallbackFloor: Number.isFinite(fallbackFloor)
            ? fallbackFloor
            : null,
          pendingRepairFromFloor,
          at: Date.now(),
        }
      : null;
  vectorState.lastWarning = recoveryPlan?.legacyGapFallback
    ? "历史恢复检测到 legacy-gap，向量索引需按受影响后缀修复"
    : "历史恢复后需要修复受影响后缀的向量索引";
}

async function rollbackGraphForReroll(targetFloor, context = getContext()) {
  ensureCurrentGraphRuntimeState();
  const chatId = getCurrentChatId(context);
  const buildRerollFailure = (
    recoveryPath,
    error,
    { resultCode = "reroll.rollback.failed", affectedBatchCount = 0 } = {},
  ) => ({
    success: false,
    rollbackPerformed: false,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor: null,
    recoveryPath,
    affectedBatchCount,
    resultCode,
    error,
  });
  const recoveryPoint = findJournalRecoveryPoint(currentGraph, targetFloor);

  if (!recoveryPoint) {
    return buildRerollFailure(
      "unavailable",
      "未找到可用的回滚点，无法安全重新提取。请先执行一次历史恢复或重新提取更早的批次。",
      {
        resultCode: "reroll.rollback.unavailable",
      },
    );
  }

  clearInjectionState();
  lastExtractedItems = [];

  const config = getEmbeddingConfig();
  const recoveryPath = recoveryPoint.path || "unknown";
  const affectedBatchCount = recoveryPoint.affectedBatchCount || 0;

  if (recoveryPath === "reverse-journal") {
    const recoveryPlan = buildReverseJournalRecoveryPlan(
      recoveryPoint.affectedJournals,
      targetFloor,
    );
    if (recoveryPlan?.valid === false) {
      const invalidReason = String(
        recoveryPlan.invalidReason || "unknown",
      ).trim();
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "reroll-rollback-rejected",
        {
          fromFloor: targetFloor,
          effectiveFromFloor: null,
          path: "reverse-journal",
          affectedBatchCount,
          detectionSource: "manual-reroll",
          reason: `回滚计划完整性校验失败: ${invalidReason}`,
          debugReason: `reroll-rollback-plan-invalid:${invalidReason}`,
          resultCode: "reroll.rollback.plan-invalid",
          invalidReason,
        },
      );
      saveGraphToChat({ reason: "reroll-rollback-rejected" });
      refreshPanelLiveState();
      return buildRerollFailure(
        "reverse-journal-rejected",
        `回滚计划完整性校验失败: ${invalidReason}`,
        {
          affectedBatchCount,
          resultCode: "reroll.rollback.plan-invalid",
        },
      );
    }
    rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
    currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
    extractionCount = currentGraph.historyState.extractionCount || 0;
    applyRecoveryPlanToVectorState(recoveryPlan, targetFloor);

    if (
      isBackendVectorConfig(config) &&
      recoveryPlan.backendDeleteHashes.length > 0
    ) {
      setRuntimeStatus(
        "重新提取准备中",
        `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
        "running",
      );
      assertRecoveryChatStillActive(chatId, "reroll-pre-vector");
      await tryDeleteBackendVectorHashesForRecovery(
        currentGraph.vectorIndexState.collectionId,
        config,
        recoveryPlan.backendDeleteHashes,
        undefined,
        {
          source: "reroll",
        },
      );
    }

    if (isBackendVectorConfig(config)) {
      setRuntimeStatus(
        "重新提取准备中",
        "正在准备向量回放状态",
        "running",
      );
    }
    assertRecoveryChatStillActive(chatId, "reroll-pre-prepare");
    await prepareVectorStateForReplay(false, undefined, {
      skipBackendPurge: isBackendVectorConfig(config),
    });
  } else if (recoveryPath === "legacy-snapshot") {
    currentGraph = normalizeGraphRuntimeState(
      recoveryPoint.snapshotBefore,
      chatId,
    );
    extractionCount = currentGraph.historyState.extractionCount || 0;
    await prepareVectorStateForReplay(false);
  } else {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "reroll-rollback-rejected",
      {
        fromFloor: targetFloor,
        effectiveFromFloor: null,
        path: recoveryPath,
        affectedBatchCount,
        detectionSource: "manual-reroll",
        reason: `不支持的回滚路径: ${recoveryPath}`,
        debugReason: `reroll-rollback-unsupported:${recoveryPath}`,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
    saveGraphToChat({ reason: "reroll-rollback-rejected" });
    refreshPanelLiveState();
    return buildRerollFailure(
      recoveryPath,
      `不支持的回滚路径: ${recoveryPath}`,
      {
        affectedBatchCount,
        resultCode: "reroll.rollback.path-unsupported",
      },
    );
  }

  const effectiveFromFloor = Number.isFinite(
    currentGraph.historyState?.lastProcessedAssistantFloor,
  )
    ? currentGraph.historyState.lastProcessedAssistantFloor + 1
    : 0;

  clearHistoryDirty(
    currentGraph,
    buildRecoveryResult("reroll-rollback", {
      fromFloor: targetFloor,
      effectiveFromFloor,
      path: recoveryPath,
      affectedBatchCount,
      detectionSource: "manual-reroll",
      reason: "manual-reroll",
      resultCode: "reroll.rollback.applied",
    }),
  );
  if (
    Array.isArray(context?.chat) &&
    Number.isFinite(currentGraph.historyState?.lastProcessedAssistantFloor) &&
    currentGraph.historyState.lastProcessedAssistantFloor >= 0
  ) {
    // Preserve the rolled-back prefix immediately so a failed follow-up
    // re-extraction does not look like a generic "missing processed hashes"
    // corruption on the next history integrity check.
    updateProcessedHistorySnapshot(
      context.chat,
      currentGraph.historyState.lastProcessedAssistantFloor,
    );
  }
  pruneProcessedMessageHashesFromFloor(currentGraph, effectiveFromFloor);
  currentGraph.lastProcessedSeq =
    currentGraph.historyState?.lastProcessedAssistantFloor ?? -1;
  currentGraph.vectorIndexState.lastIntegrityIssue = null;
  saveGraphToChat({ reason: "reroll-rollback-complete" });
  refreshPanelLiveState();

  return {
    success: true,
    rollbackPerformed: true,
    extractionTriggered: false,
    requestedFloor: targetFloor,
    effectiveFromFloor,
    recoveryPath,
    affectedBatchCount,
    resultCode: "reroll.rollback.applied",
    error: "",
  };
}

const VECTOR_RECOVERY_PREP_TIMEOUT_MS = 15000;

async function tryDeleteBackendVectorHashesForRecovery(
  collectionId,
  config,
  hashes,
  signal = undefined,
  { source = "recovery" } = {},
) {
  if (
    !collectionId ||
    !isBackendVectorConfig(config) ||
    !Array.isArray(hashes) ||
    hashes.length === 0
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "no-backend-hashes",
    };
  }

  const canAbortWithTimeout =
    typeof AbortController !== "undefined" &&
    typeof DOMException !== "undefined";
  const controller = canAbortWithTimeout ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(
        () =>
          controller.abort(
            new DOMException(
              `向量恢复准备超时 (${Math.round(VECTOR_RECOVERY_PREP_TIMEOUT_MS / 1000)}s)`,
              "AbortError",
            ),
          ),
        VECTOR_RECOVERY_PREP_TIMEOUT_MS,
      )
    : null;
  let combinedSignal = controller?.signal;
  if (signal && controller) {
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.any === "function"
    ) {
      combinedSignal = AbortSignal.any([signal, controller.signal]);
    } else {
      combinedSignal = controller.signal;
      signal.addEventListener(
        "abort",
        () => controller.abort(signal.reason),
        { once: true },
      );
    }
  } else if (signal) {
    combinedSignal = signal;
  }

  try {
    await deleteBackendVectorHashesForRecovery(
      collectionId,
      config,
      hashes,
      combinedSignal,
    );
    return {
      ok: true,
      skipped: false,
      reason: "",
    };
  } catch (error) {
    if (isAbortError(error) && signal?.aborted) {
      throw error;
    }
    console.warn("[ST-BME] 向量恢复预清理失败，已降级为后续修复:", {
      source,
      collectionId,
      hashCount: hashes.length,
      error,
    });
    if (currentGraph?.vectorIndexState) {
      currentGraph.vectorIndexState.dirty = true;
      currentGraph.vectorIndexState.dirtyReason =
        currentGraph.vectorIndexState.dirtyReason ||
        "history-recovery-replay";
      currentGraph.vectorIndexState.lastWarning =
        "向量恢复预清理失败，已跳过并标记为后续修复";
    }
    return {
      ok: false,
      skipped: false,
      reason: error?.message || String(error),
      error,
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function recoverHistoryIfNeeded(trigger = "history-recovery") {
  if (!currentGraph || isRecoveringHistory) {
    return !isRecoveringHistory;
  }

  ensureCurrentGraphRuntimeState();
  const context = getContext();
  const chat = context?.chat;
  if (!Array.isArray(chat)) return true;
  const renderLimitedGuard = getRenderLimitedHistoryRecoveryGuard(chat);
  if (renderLimitedGuard.blocked) {
    currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
      "paused",
      {
        fromFloor: currentGraph.historyState?.historyDirtyFrom ?? null,
        path: "render-limit-guard",
        detectionSource:
          currentGraph.historyState?.lastMutationSource || "render-limit-guard",
        reason: renderLimitedGuard.message,
        resultCode: "history.recovery.paused.render-limit",
        chatLength: renderLimitedGuard.chatLength,
        renderLimit: renderLimitedGuard.renderLimit,
        highestProcessedFloor: renderLimitedGuard.highestProcessedFloor,
      },
    );
    notifyRenderLimitedHistoryRecoveryBlocked(renderLimitedGuard, trigger);
    refreshPanelLiveState();
    return false;
  }

  const detection = inspectHistoryMutation(trigger);
  const dirtyFrom = currentGraph?.historyState?.historyDirtyFrom;
  if (!detection.dirty && !Number.isFinite(dirtyFrom)) {
    return true;
  }
  if (isRestoreLockActive()) {
    return false;
  }

  enterRestoreLock("history-recovery", trigger);
  isRecoveringHistory = true;
  clearInjectionState();

  const chatId = getCurrentChatId(context);
  const settings = getSettings();
  const initialDirtyFromRaw = Number.isFinite(dirtyFrom)
    ? dirtyFrom
    : detection.earliestAffectedFloor;
  const initialDirtyFrom = clampRecoveryStartFloor(chat, initialDirtyFromRaw);
  let replayedBatches = 0;
  let usedFullRebuild = false;
  let recoveryPath = "full-rebuild";
  let affectedBatchCount = 0;
  const historyController = beginStageAbortController("history");
  const historySignal = historyController.signal;

  updateStageNotice(
    "history",
    "历史恢复中",
    Number.isFinite(initialDirtyFrom)
      ? `受影响起点楼层 ${initialDirtyFrom} · 正在回滚并重放`
      : "正在回滚并重放受影响后缀",
    "running",
    {
      persist: true,
      busy: true,
    },
  );

  try {
    throwIfAborted(historySignal, "历史恢复已终止");
    const recoveryPoint = findJournalRecoveryPoint(
      currentGraph,
      initialDirtyFrom,
    );
    if (recoveryPoint?.path === "reverse-journal") {
      recoveryPath = "reverse-journal";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      const config = getEmbeddingConfig();
      const recoveryPlan = buildReverseJournalRecoveryPlan(
        recoveryPoint.affectedJournals,
        initialDirtyFrom,
      );
      if (recoveryPlan?.valid === false) {
        throw new Error(
          `reverse-journal recovery plan invalid: ${
            recoveryPlan.invalidReason || "unknown"
          }`,
        );
      }
      rollbackAffectedJournals(currentGraph, recoveryPoint.affectedJournals);
      currentGraph = normalizeGraphRuntimeState(currentGraph, chatId);
      extractionCount = currentGraph.historyState.extractionCount || 0;
      applyRecoveryPlanToVectorState(recoveryPlan, initialDirtyFrom);

      if (
        isBackendVectorConfig(config) &&
        recoveryPlan.backendDeleteHashes.length > 0
      ) {
        updateStageNotice(
          "history",
          "历史恢复中",
          `正在整理向量恢复状态（${recoveryPlan.backendDeleteHashes.length} 项）`,
          "running",
          {
            persist: true,
            busy: true,
          },
        );
        assertRecoveryChatStillActive(chatId, "pre-backend-delete");
        await tryDeleteBackendVectorHashesForRecovery(
          currentGraph.vectorIndexState.collectionId,
          config,
          recoveryPlan.backendDeleteHashes,
          historySignal,
          {
            source: "history-recovery",
          },
        );
      }
      if (isBackendVectorConfig(config)) {
        updateStageNotice(
          "history",
          "历史恢复中",
          "正在准备向量回放状态",
          "running",
          {
            persist: true,
            busy: true,
          },
        );
      }
      await prepareVectorStateForReplay(false, historySignal, {
        skipBackendPurge: isBackendVectorConfig(config),
      });
    } else if (recoveryPoint?.path === "legacy-snapshot") {
      recoveryPath = "legacy-snapshot";
      affectedBatchCount = recoveryPoint.affectedBatchCount || 0;
      currentGraph = normalizeGraphRuntimeState(
        recoveryPoint.snapshotBefore,
        chatId,
      );
      extractionCount = currentGraph.historyState.extractionCount || 0;
      await prepareVectorStateForReplay(false, historySignal);
    } else {
      recoveryPath = "full-rebuild";
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      usedFullRebuild = true;
      extractionCount = 0;
      await prepareVectorStateForReplay(true, historySignal);
    }

    assertRecoveryChatStillActive(chatId, "pre-replay");
    replayedBatches = await replayExtractionFromHistory(
      chat,
      settings,
      historySignal,
      chatId,
    );

    clearHistoryDirty(
      currentGraph,
      buildRecoveryResult(usedFullRebuild ? "full-rebuild" : "replayed", {
        fromFloor: initialDirtyFrom,
        batches: replayedBatches,
        path: recoveryPath,
        detectionSource:
          detection.source ||
          currentGraph?.historyState?.lastMutationSource ||
          "hash-recheck",
        affectedBatchCount,
        replayedBatchCount: replayedBatches,
        reason:
          detection.reason ||
          currentGraph?.historyState?.lastMutationReason ||
          trigger,
      }),
    );
    const recoveredLastProcessedFloor = Number.isFinite(
      currentGraph?.historyState?.lastProcessedAssistantFloor,
    )
      ? currentGraph.historyState.lastProcessedAssistantFloor
      : -1;
    if (recoveredLastProcessedFloor >= 0) {
      // Recovery replay has rebuilt the graph state; restore processed hashes so
      // the next hash recheck does not immediately trigger another replay loop.
      updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
    }
    saveGraphToChat({ reason: "history-recovery-complete" });
    refreshPanelLiveState();
    settleExtractionStatusAfterHistoryRecovery(
      "提取完成",
      `历史恢复回放 ${replayedBatches} 批`,
      "success",
    );
    updateStageNotice(
      "history",
      usedFullRebuild ? "历史恢复完成（全量重建）" : "历史恢复完成",
      `path ${recoveryPath} · 起点楼层 ${initialDirtyFrom} · 受影响 ${affectedBatchCount} 批 · 回放 ${replayedBatches} 批`,
      usedFullRebuild ? "warning" : "success",
      {
        busy: false,
        persist: false,
      },
    );
    if (usedFullRebuild) {
      toastr.warning("历史变化已触发全量重建");
    }
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("aborted", {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: error?.message || "已手动终止当前恢复流程",
          debugReason: `history-recovery-aborted:${recoveryPath}`,
          resultCode: "history.recovery.aborted",
        }),
      );
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      currentGraph.vectorIndexState.lastWarning = "";
      currentGraph.vectorIndexState.pendingRepairFromFloor = null;
      currentGraph.vectorIndexState.replayRequiredNodeIds = [];
      currentGraph.vectorIndexState.dirty = false;
      currentGraph.vectorIndexState.dirtyReason = "";
      settleExtractionStatusAfterHistoryRecovery(
        "提取已终止",
        error?.message || "历史恢复已终止",
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已终止",
        error?.message || "已手动终止当前恢复流程",
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      saveGraphToChat({ reason: "history-recovery-aborted" });
      return false;
    }
    console.error("[ST-BME] 历史恢复失败，尝试全量重建:", error);

    try {
      currentGraph = normalizeGraphRuntimeState(createEmptyGraph(), chatId);
      extractionCount = 0;
      await prepareVectorStateForReplay(true, historySignal);
      assertRecoveryChatStillActive(chatId, "pre-fallback-replay");
      replayedBatches = await replayExtractionFromHistory(
        chat,
        settings,
        historySignal,
        chatId,
      );
      clearHistoryDirty(
        currentGraph,
        buildRecoveryResult("full-rebuild", {
          fromFloor: 0,
          batches: replayedBatches,
          path: "full-rebuild",
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: `恢复失败后兜底全量重建: ${error?.message || error}`,
          debugReason: `history-recovery-fallback-full-rebuild:${recoveryPath}`,
          resultCode: "history.recovery.fallback-full-rebuild",
        }),
      );
      const recoveredLastProcessedFloor = Number.isFinite(
        currentGraph?.historyState?.lastProcessedAssistantFloor,
      )
        ? currentGraph.historyState.lastProcessedAssistantFloor
        : -1;
      if (recoveredLastProcessedFloor >= 0) {
        updateProcessedHistorySnapshot(chat, recoveredLastProcessedFloor);
      }
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      saveGraphToChat({ reason: "history-recovery-fallback-rebuild" });
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取完成",
        `历史恢复已退化为全量重建，回放 ${replayedBatches} 批`,
        "warning",
      );
      updateStageNotice(
        "history",
        "历史恢复已退化为全量重建",
        `path full-rebuild · 起点楼层 ${initialDirtyFrom} · 回放 ${replayedBatches} 批`,
        "warning",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.warning("历史恢复已退化为全量重建");
      return true;
    } catch (fallbackError) {
      currentGraph.historyState.lastRecoveryResult = buildRecoveryResult(
        "failed",
        {
          fromFloor: initialDirtyFrom,
          path: recoveryPath,
          detectionSource:
            detection.source ||
            currentGraph?.historyState?.lastMutationSource ||
            "hash-recheck",
          affectedBatchCount,
          replayedBatchCount: replayedBatches,
          reason: String(fallbackError),
          debugReason: `history-recovery-failed:${recoveryPath}`,
          resultCode: "history.recovery.failed",
        },
      );
      currentGraph.vectorIndexState.lastIntegrityIssue = null;
      saveGraphToChat({ reason: "history-recovery-failed" });
      refreshPanelLiveState();
      settleExtractionStatusAfterHistoryRecovery(
        "提取失败",
        fallbackError?.message || String(fallbackError),
        "error",
      );
      updateStageNotice(
        "history",
        "历史恢复失败",
        fallbackError?.message || String(fallbackError),
        "error",
        {
          busy: false,
          persist: false,
        },
      );
      toastr.error(`历史恢复失败: ${fallbackError?.message || fallbackError}`);
      return false;
    }
  } finally {
    finishStageAbortController("history", historyController);
    leaveRestoreLock("history-recovery");
    isRecoveringHistory = false;
    const enqueueMicrotask =
      typeof globalThis.queueMicrotask === "function"
        ? globalThis.queueMicrotask.bind(globalThis)
        : (task) => Promise.resolve().then(task);
    enqueueMicrotask(() => {
      if (typeof maybeResumePendingAutoExtraction === "function") {
        void maybeResumePendingAutoExtraction("history-recovery-finished");
      }
    });
  }
}

function settleExtractionStatusAfterHistoryRecovery(
  text = "提取完成",
  meta = "",
  level = "success",
) {
  const statusSnapshot =
    typeof lastExtractionStatus === "object" && lastExtractionStatus
      ? lastExtractionStatus
      : null;
  if (!statusSnapshot || typeof setLastExtractionStatus !== "function") {
    return;
  }

  const currentText = String(statusSnapshot.text || "");
  const currentLevel = String(statusSnapshot.level || "");
  if (currentText !== "AI 生成中" && currentLevel !== "running") {
    return;
  }
  setLastExtractionStatus(text, meta, level, {
    syncRuntime: true,
    toastKind: "",
  });
}

/**
 * 提取管线：处理未提取的对话楼层
 */
async function runExtraction() {
  const options =
    arguments.length > 0 &&
    arguments[0] &&
    typeof arguments[0] === "object" &&
    !Array.isArray(arguments[0])
      ? arguments[0]
      : {};
  return await runExtractionController({
    beginStageAbortController,
    clampInt,
    console,
    deferAutoExtraction,
    ensureCurrentGraphRuntimeState,
    ensureGraphMutationReady,
    executeExtractionBatch,
    finishStageAbortController,
    getAssistantTurns,
    getContext,
    getCurrentGraph: () => currentGraph,
    getGraphPersistenceState: () => graphPersistenceState,
    getGraphMutationBlockReason,
    getIsExtracting: () => isExtracting,
    getIsRecoveringHistory: () => isRecoveringHistory,
    getLastProcessedAssistantFloor,
    getSettings,
    getSmartTriggerDecision,
    isAbortError,
    notifyExtractionIssue,
    recoverHistoryIfNeeded,
    resolveAutoExtractionPlan,
    retryPendingGraphPersist,
    setIsExtracting: (value) => {
      isExtracting = value;
    },
    setLastExtractionStatus,
  }, options);
}

function applyRecallInjection(settings, recallInput, recentMessages, result) {
  const injectionResult = applyRecallInjectionController(
    settings,
    recallInput,
    recentMessages,
    result,
    {
      persistRecallInjectionRecord,
      applyModuleInjectionPrompt,
      console,
      estimateTokens,
      formatInjection,
      getLastRecallFallbackNoticeAt: () => lastRecallFallbackNoticeAt,
      getRecallHookLabel,
      getSchema,
      recordInjectionSnapshot,
      saveGraphToChat,
      setCurrentGraphLastRecallResult: (selectedNodeIds) => {
        currentGraph.lastRecallResult = selectedNodeIds;
      },
      setLastInjectionContent: (value) => {
        lastInjectionContent = value;
      },
      setLastRecallFallbackNoticeAt: (value) => {
        lastRecallFallbackNoticeAt = value;
      },
      setLastRecallStatus,
      toastr,
      updateLastRecalledItems,
    },
  );
  if (
    isLukerPrimaryPersistenceHost(getContext()) &&
    String(injectionResult?.injectionText || "").trim()
  ) {
    updateLukerProjectionState({
      runtime: {
        status: "pending",
        updatedAt: Date.now(),
        reason:
          String(recallInput?.hookName || "").trim() || "recall-injection",
      },
    });
  }
  return injectionResult;
}

function buildRecallRetrieveOptions(settings, context) {
  const concurrency = resolveConcurrencyConfig(settings);
  return {
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
    // v2 options
    enableVisibility: settings.enableVisibility ?? false,
    visibilityFilter: context.name2 || null,
    enableCrossRecall: settings.enableCrossRecall ?? false,
    enableProbRecall: settings.enableProbRecall ?? false,
    probRecallChance: settings.probRecallChance ?? 0.15,
    enableMultiIntent: settings.recallEnableMultiIntent ?? true,
    multiIntentMaxSegments: settings.recallMultiIntentMaxSegments ?? 4,
    enableContextQueryBlend: settings.recallEnableContextQueryBlend ?? true,
    contextAssistantWeight: settings.recallContextAssistantWeight ?? 0.2,
    contextPreviousUserWeight:
      settings.recallContextPreviousUserWeight ?? 0.1,
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
    vectorQueryConcurrency: concurrency.vectorQueryConcurrency,
    authorityCandidateQueryConcurrency: concurrency.vectorQueryConcurrency,
    enableScopedMemory: settings.enableScopedMemory ?? true,
    enablePovMemory: settings.enablePovMemory ?? true,
    enableRegionScopedObjective:
      settings.enableRegionScopedObjective ?? true,
    enableCognitiveMemory: settings.enableCognitiveMemory ?? true,
    enableSpatialAdjacency: settings.enableSpatialAdjacency ?? true,
    enableStoryTimeline: settings.enableStoryTimeline ?? true,
    injectStoryTimeLabel: settings.injectStoryTimeLabel ?? true,
    storyTimeSoftDirecting: settings.storyTimeSoftDirecting ?? true,
    recallCharacterPovWeight: settings.recallCharacterPovWeight ?? 1.25,
    recallUserPovWeight: settings.recallUserPovWeight ?? 1.05,
    recallObjectiveCurrentRegionWeight:
      settings.recallObjectiveCurrentRegionWeight ?? 1.15,
    recallObjectiveAdjacentRegionWeight:
      settings.recallObjectiveAdjacentRegionWeight ?? 0.9,
    recallObjectiveGlobalWeight:
      settings.recallObjectiveGlobalWeight ?? 0.75,
    injectUserPovMemory: settings.injectUserPovMemory ?? true,
    injectObjectiveGlobalMemory:
      settings.injectObjectiveGlobalMemory ?? true,
    injectLowConfidenceObjectiveMemory:
      settings.injectLowConfidenceObjectiveMemory ?? false,
    activeRegion:
      currentGraph?.historyState?.activeRegion ||
      currentGraph?.historyState?.lastExtractedRegion ||
      "",
    activeStorySegmentId:
      currentGraph?.historyState?.activeStorySegmentId || "",
    activeStoryTimeLabel:
      currentGraph?.historyState?.activeStoryTimeLabel || "",
    activeCharacterPovOwner:
      currentGraph?.historyState?.activeCharacterPovOwner || "",
    activeUserPovOwner:
      currentGraph?.historyState?.activeUserPovOwner ||
      context.name1 ||
      "",
  };
}

async function runPlannerRecallForEna({
  rawUserInput,
  signal = undefined,
  disableLlmRecall = false,
} = {}) {
  const userMessage = normalizeRecallInputText(rawUserInput || "");
  const trivialInputResult = isTrivialUserInput(userMessage);
  if (trivialInputResult.trivial) {
    console.info?.(
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

  const settings = getSettings();
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
      : createAbortError("Ena Planner recall aborted");
  }

  if (!currentGraph || !isGraphReadableForRecall()) {
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

  if (isGraphMetadataWriteAllowed()) {
    const recovered = await recoverHistoryIfNeeded("pre-ena-planner-recall");
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
      : createAbortError("Ena Planner recall aborted");
  }

  await ensureVectorReadyIfNeeded("pre-ena-planner-recall", signal);

  const context = getContext();
  const chat = context?.chat ?? [];
  const recentMessages = buildRecallRecentMessages(
    chat,
    clampInt(settings.recallLlmContextMessages, 4, 0, 20),
    userMessage,
  );
  const schema = getSchema();
  const baseOptions = buildRecallRetrieveOptions(settings, context);
  const options = {
    ...baseOptions,
    enableLLMRecall: disableLlmRecall
      ? false
      : baseOptions.enableLLMRecall,
  };

  const result = await retrieve({
    graph: currentGraph,
    userMessage,
    recentMessages,
    embeddingConfig: getEmbeddingConfig(),
    schema,
    settings,
    signal,
    options,
  });
  const memoryBlock = formatInjection(result, schema).trim();

  return {
    ok: Boolean(memoryBlock),
    reason: memoryBlock ? "completed" : "empty-memory-block",
    memoryBlock,
    recentMessages,
    result,
  };
}

/**
 * 召回管线：检索并注入记忆
 */
async function runRecall(options = {}) {
  if (!options?.ignoreRestoreLock && isRestoreLockActive()) {
    const message = getRestoreLockMessage("召回");
    setLastRecallStatus("召回已暂停", message, "warning", {
      syncRuntime: true,
    });
    return createRecallRunResult("skipped", {
      reason: "restore-lock-active",
      restoreLock: cloneRuntimeDebugValue(
        normalizeRestoreLockState(graphPersistenceState.restoreLock),
        null,
      ),
    });
  }
  return await runRecallController(
    {
      abortRecallStageWithReason,
      applyRecallInjection,
      beginStageAbortController,
      bumpPersistedRecallGenerationCount,
      buildRecallRetrieveOptions,
      clampInt,
      console,
      consumePlannerRecallHandoff,
      createAbortError,
      createRecallInputRecord,
      createRecallRunResult,
      ensureVectorReadyIfNeeded,
      finishStageAbortController,
      getActiveRecallPromise: () => activeRecallPromise,
      getContext,
      getCurrentGraph: () => currentGraph,
      getEmbeddingConfig,
      getGraphMutationBlockReason,
      getIsRecalling: () => isRecalling,
      getRecallHookLabel,
      getSchema,
      getSettings,
      isAbortError,
      isGraphMetadataWriteAllowed,
      isGraphReadable,
      isGraphReadableForRecall,
      nextRecallRunSequence: () => ++recallRunSequence,
      readPersistedRecallFromUserMessage,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      resolveRecallInput,
      retrieve,
      schedulePersistedRecallMessageUiRefresh,
      setActiveRecallPromise: (value) => {
        activeRecallPromise = value;
      },
      setIsRecalling: (value) => {
        isRecalling = value;
      },
      setLastRecallStatus,
      setPendingRecallSendIntent: (value) => {
        pendingRecallSendIntent = value;
      },
      toastr,
      triggerChatMetadataSave,
      waitForActiveRecallToSettle,
    },
    options,
  );
}

// ==================== 事件钩子 ====================

function onChatChanged() {
  isHostGenerationRunning = false;
  lastHostGenerationEndedAt = 0;
  const { target, lightweightHostMode, adapter } = syncBmeHostRuntimeFlags(getContext());
  updateGraphPersistenceState({
    hostProfile: adapter.hostProfile,
    chatStateTarget: cloneRuntimeDebugValue(target, null),
    lightweightHostMode,
  });
  if (typeof clearMessageHideState === "function") {
    clearMessageHideState("chat-changed");
  }
  const result = onChatChangedController({
    abortAllRunningStages,
    clearCoreEventBindingState,
    clearGenerationRecallTransactionsForChat,
    clearInjectionState,
    clearPendingAutoExtraction,
    clearPendingGraphLoadRetry,
    clearPendingHistoryMutationChecks,
    clearCurrentGenerationTrivialSkip,
    clearRecallInputTracking,
    clearTimeout,
    dismissAllStageNotices,
    getPendingHistoryRecoveryTimer: () => pendingHistoryRecoveryTimer,
    installSendIntentHooks,
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    setLastPreGenerationRecallAt: (value) => {
      lastPreGenerationRecallAt = value;
    },
    setLastPreGenerationRecallKey: (value) => {
      lastPreGenerationRecallKey = value;
    },
    setPendingHistoryRecoveryTimer: (value) => {
      pendingHistoryRecoveryTimer = value;
    },
    setPendingHistoryRecoveryTrigger: (value) => {
      pendingHistoryRecoveryTrigger = value;
    },
    setSkipBeforeCombineRecallUntil: (value) => {
      skipBeforeCombineRecallUntil = value;
    },
    syncGraphLoadFromLiveContext,
  });

  scheduleBmeIndexedDbTask(async () => {
    const syncResult = await syncBmeChatManagerWithCurrentChat("chat-changed");
    if (syncResult?.chatId) {
      await runBmeAutoSyncForChat("chat-changed", syncResult.chatId);
      await loadGraphFromIndexedDb(syncResult.chatId, {
        source: "chat-changed",
        allowOverride: true,
        applyEmptyState: true,
      });
    }
  });

  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("chat-changed", 220);
  }

  return result;
}

function onChatLoaded() {
  const { target, lightweightHostMode, adapter } = syncBmeHostRuntimeFlags(getContext());
  updateGraphPersistenceState({
    hostProfile: adapter.hostProfile,
    chatStateTarget: cloneRuntimeDebugValue(target, null),
    lightweightHostMode,
  });
  const result = onChatLoadedController({
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    syncGraphLoadFromLiveContext,
  });

  scheduleBmeIndexedDbTask(async () => {
    const syncResult = await syncBmeChatManagerWithCurrentChat("chat-loaded");
    if (syncResult?.chatId) {
      await runBmeAutoSyncForChat("chat-loaded", syncResult.chatId);
      await loadGraphFromIndexedDb(syncResult.chatId, {
        source: "chat-loaded",
        allowOverride: true,
        applyEmptyState: true,
      });
    }
  });

  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("chat-loaded", 180);
  }

  return result;
}

function onMessageSent(messageId) {
  const result = onMessageSentController(
    {
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      estimateTokens,
      getContext,
      isTrivialUserInput,
      markCurrentGenerationTrivialSkip,
      recordRecallSentUserMessage,
      rebindRecallRecordToNewUserMessage,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-sent", 40);
  }
  return result;
}

function onUserMessageRendered(messageId = null) {
  return onUserMessageRenderedController(
    {
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
  );
}

function onCharacterMessageRendered(messageId = null, type = "") {
  const result = onCharacterMessageRenderedController(
    {
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
    type,
  );
  void maybeResumePendingAutoExtraction("character-message-rendered");
  return result;
}

function onMessageDeleted(chatLengthOrMessageId, meta = null) {
  const result = onMessageDeletedController(
    {
      invalidateRecallAfterHistoryMutation,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleHistoryMutationRecheck,
    },
    chatLengthOrMessageId,
    meta,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-deleted", 80);
  }
  return result;
}

function onMessageEdited(messageId, meta = null) {
  const result = onMessageEditedController(
    {
      invalidateRecallAfterHistoryMutation,
      isMvuExtraAnalysisGuardActive,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleHistoryMutationRecheck,
    },
    messageId,
    meta,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-edited", 80);
  }
  return result;
}

function onMessageUpdated(messageId, meta = null) {
  const result = onMessageUpdatedController(
    {
      recordIgnoredMutationEvent,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    },
    messageId,
    meta,
  );
  return result;
}

async function onMessageSwiped(messageId, meta = null) {
  const result = await onMessageSwipedController(
    {
      invalidateRecallAfterHistoryMutation,
      onReroll,
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleHistoryMutationRecheck,
    },
    messageId,
    meta,
  );
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("message-swiped", 80);
  }
  return result;
}

function onGenerationContextReady(payload = {}) {
  const { target, lightweightHostMode } = syncBmeHostRuntimeFlags(getContext());
  recordLukerHookPhase("GENERATION_CONTEXT_READY", {
    chatStateTarget: target,
    lightweightHostMode,
  });
  updateLukerProjectionState({
    runtime: {
      ...(graphPersistenceState.projectionState?.runtime || {}),
      status: "context-ready",
      updatedAt: Date.now(),
      reason: "generation-context-ready",
    },
  });
  return {
    phase: "GENERATION_CONTEXT_READY",
    lightweightHostMode,
  };
}

function onGenerationBeforeWorldInfoScan(payload = {}) {
  const { target, lightweightHostMode } = syncBmeHostRuntimeFlags(getContext());
  recordLukerHookPhase("GENERATION_BEFORE_WORLD_INFO_SCAN", {
    chatStateTarget: target,
    lightweightHostMode,
  });
  return {
    phase: "GENERATION_BEFORE_WORLD_INFO_SCAN",
    lightweightHostMode,
  };
}

function onGenerationAfterWorldInfoScan(payload = {}) {
  const { target, lightweightHostMode } = syncBmeHostRuntimeFlags(getContext());
  recordLukerHookPhase("GENERATION_AFTER_WORLD_INFO_SCAN", {
    chatStateTarget: target,
    lightweightHostMode,
  });
  if (String(graphPersistenceState.projectionState?.runtime?.status || "") === "pending") {
    payload.__stBmeProjectionRequestedRescan = true;
  }
  return {
    phase: "GENERATION_AFTER_WORLD_INFO_SCAN",
    requestRescan: payload?.__stBmeProjectionRequestedRescan === true,
  };
}

function onGenerationWorldInfoFinalized(payload = {}) {
  const { target, lightweightHostMode } = syncBmeHostRuntimeFlags(getContext());
  recordLukerHookPhase("GENERATION_WORLD_INFO_FINALIZED", {
    chatStateTarget: target,
    lightweightHostMode,
  });

  if (
    isLukerPrimaryPersistenceHost(getContext()) &&
    graphPersistenceState.projectionState?.runtime?.status === "pending"
  ) {
    payload.requestRescan = true;
    const reason =
      graphPersistenceState.projectionState?.runtime?.reason ||
      "runtime-projection-pending";
    updateGraphPersistenceState({
      lastRequestRescanReason: String(reason || ""),
    });
    updateLukerProjectionState({
      runtime: {
        ...(graphPersistenceState.projectionState?.runtime || {}),
        status: "rescan-requested",
        updatedAt: Date.now(),
        reason,
      },
    });
  }

  return {
    phase: "GENERATION_WORLD_INFO_FINALIZED",
    requestRescan: payload?.requestRescan === true,
  };
}

function onGenerationBeforeApiRequest(payload = {}) {
  const { target, lightweightHostMode } = syncBmeHostRuntimeFlags(getContext());
  recordLukerHookPhase("GENERATION_BEFORE_API_REQUEST", {
    chatStateTarget: target,
    lightweightHostMode,
  });
  return {
    phase: "GENERATION_BEFORE_API_REQUEST",
    lightweightHostMode,
  };
}

function onGenerationStarted(type, params = {}, dryRun = false) {
  const generationType = String(type || "normal").trim() || "normal";
  if (
    !dryRun &&
    !params?.automatic_trigger &&
    !params?.quiet_prompt &&
    generationType === "normal"
  ) {
    isHostGenerationRunning = true;
    lastHostGenerationEndedAt = 0;
  }
  return onGenerationStartedController(
    {
      clearDryRunPromptPreview,
      clearCurrentGenerationTrivialSkip,
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      freezeHostGenerationInputSnapshot,
      getContext,
      getPendingRecallSendIntent: () => pendingRecallSendIntent,
      getSendTextareaValue,
      isFreshRecallInputRecord,
      isTavernHelperPromptViewerRefreshActive,
      isTrivialUserInput,
      markDryRunPromptPreview,
      markCurrentGenerationTrivialSkip,
      normalizeRecallInputText,
    },
    type,
    params,
    dryRun,
  );
}

function onGenerationEnded(_chatLength = null) {
  isHostGenerationRunning = false;
  lastHostGenerationEndedAt = Date.now();
  if (isLukerPrimaryPersistenceHost(getContext())) {
    updateLukerProjectionState({
      runtime: {
        ...(graphPersistenceState.projectionState?.runtime || {}),
        status: "idle",
        updatedAt: Date.now(),
        reason: "generation-ended",
      },
    });
  }
  const recentTransaction = findRecentGenerationRecallTransactionForChat();
  const recentRecallResult =
    getGenerationRecallTransactionResult(recentTransaction);
  ensurePersistedRecallRecordForGeneration({
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
  void maybeResumePendingAutoExtraction("generation-ended");
  if (typeof scheduleMessageHideApply === "function") {
    scheduleMessageHideApply("generation-ended", 180);
  }
}

async function onGenerationAfterCommands(type, params = {}, dryRun = false) {
  return await onGenerationAfterCommandsController(
    {
      applyFinalRecallInjectionForGeneration,
      buildGenerationAfterCommandsRecallInput,
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      clearLiveRecallInjectionPromptForRewrite,
      consumeHostGenerationInputSnapshot,
      createGenerationRecallContext,
      ensurePersistedRecallRecordForGeneration,
      getContext,
      getGenerationRecallHookStateFromResult,
      getGenerationRecallTransactionResult,
      getCurrentChatId,
      getPendingRecallSendIntent: () => pendingRecallSendIntent,
      isFreshRecallInputRecord,
      isMvuExtraAnalysisGuardActive,
      isTavernHelperPromptViewerRefreshActive,
      markCurrentGenerationTrivialSkip,
      markGenerationRecallTransactionHookState,
      resolveGenerationRecallDeliveryMode,
      runRecall,
      storeGenerationRecallTransactionResult,
    },
    type,
    params,
    dryRun,
  );
}

async function onBeforeCombinePrompts(promptData = null) {
  return await onBeforeCombinePromptsController(
    {
      applyFinalRecallInjectionForGeneration,
      buildHistoryGenerationRecallInput,
      buildNormalGenerationRecallInput,
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      clearLiveRecallInjectionPromptForRewrite,
      consumeDryRunPromptPreview,
      consumeHostGenerationInputSnapshot,
      createGenerationRecallContext,
      getContext,
      getGenerationRecallHookStateFromResult,
      getGenerationRecallTransactionResult,
      getCurrentChatId,
      getPendingRecallSendIntent: () => pendingRecallSendIntent,
      isFreshRecallInputRecord,
      isMvuExtraAnalysisGuardActive,
      isTavernHelperPromptViewerRefreshActive,
      markCurrentGenerationTrivialSkip,
      markGenerationRecallTransactionHookState,
      resolveGenerationRecallDeliveryMode,
      runRecall,
      storeGenerationRecallTransactionResult,
    },
    promptData,
  );
}

function onMessageReceived(messageId = null, type = "") {
  const result = onMessageReceivedController({
    console,
    consumeCurrentGenerationTrivialSkip,
    createRecallInputRecord,
    deferAutoExtraction,
    getContext,
    getCurrentGraph: () => currentGraph,
    getGraphPersistenceState: () => graphPersistenceState,
    getIsHostGenerationRunning: () => isHostGenerationRunning,
    getLastProcessedAssistantFloor,
    getPendingHostGenerationInputSnapshot,
    getPendingRecallSendIntent: () => pendingRecallSendIntent,
    getSettings,
    isAssistantChatMessage,
    isFreshRecallInputRecord,
    isGraphMetadataWriteAllowed,
    syncGraphLoadFromLiveContext,
    maybeCaptureGraphShadowSnapshot,
    maybeFlushQueuedGraphPersist,
    notifyExtractionIssue,
    queueMicrotask,
    resolveAutoExtractionPlan,
    runExtraction,
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    setPendingHostGenerationInputSnapshot: (record) => {
      pendingHostGenerationInputSnapshot = record;
    },
    setPendingRecallSendIntent: (record) => {
      pendingRecallSendIntent = record;
    },
  }, messageId, type);

  const hideSettings =
    typeof getMessageHideSettings === "function"
      ? getMessageHideSettings()
      : null;
  if (
    hideSettings?.enabled &&
    hideSettings?.hide_last_n > 0 &&
    typeof runIncrementalMessageHide === "function"
  ) {
    void runIncrementalMessageHide("message-received");
  }

  return result;
}

// ==================== UI 操作 ====================

async function onViewGraph() {
  return await onViewGraphController({
    getCurrentGraph: () => currentGraph,
    getGraphStats,
    toastr,
  });
}

async function onRebuild() {
  return await runWithRestoreLock(
    "manual-rebuild",
    "manual-rebuild",
    async () =>
      await onRebuildController({
        buildRecoveryResult,
        clearHistoryDirty,
        clearInjectionState,
        cloneGraphSnapshot,
        confirm: (message) => {
          if (typeof globalThis.confirm === "function") {
            return globalThis.confirm(message);
          }
          return false;
        },
        createEmptyGraph,
        ensureGraphMutationReady: (operationLabel, options = {}) =>
          ensureGraphMutationReady(operationLabel, {
            ...(options || {}),
            ignoreRestoreLock: true,
          }),
        getContext,
        getCurrentChatId,
        getCurrentGraph: () => currentGraph,
        getSettings,
        normalizeGraphRuntimeState,
        prepareVectorStateForReplay,
        refreshPanelLiveState,
        replayExtractionFromHistory,
        restoreRuntimeUiState,
        saveGraphToChat,
        updateProcessedHistorySnapshot,
        setCurrentGraph: (graph) => {
          currentGraph = graph;
        },
        setLastExtractionStatus,
        setRuntimeStatus,
        snapshotRuntimeUiState,
        toastr,
      }),
  );
}

async function onManualCompress() {
  return await onManualCompressController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    compressAll,
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getEmbeddingConfig,
    getSchema,
    getSettings,
    inspectCompressionCandidates: inspectAutoCompressionCandidates,
    refreshPanelLiveState,
    recordMaintenanceAction,
    recordGraphMutation,
    setRuntimeStatus,
    toastr,
  });
}

function onSavePanelGraphNode(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  const updates = payload.updates;
  if (!nodeId || !updates || typeof updates !== "object" || !currentGraph) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }
  const updated = updateNode(currentGraph, nodeId, updates);
  if (!updated) {
    return { ok: false, error: "update-failed" };
  }
  const persist = saveGraphToChat({ reason: "panel-node-edit" });
  return {
    ok: true,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onDeletePanelGraphNode(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  if (!nodeId || !currentGraph) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }
  const removed = removeNode(currentGraph, nodeId);
  if (!removed) {
    return { ok: false, error: "delete-failed" };
  }
  const persist = saveGraphToChat({ reason: "panel-node-delete" });
  return {
    ok: true,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onApplyPanelKnowledgeOverride(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  const ownerKey = String(payload.ownerKey || "");
  const ownerType = String(payload.ownerType || "");
  const ownerName = String(payload.ownerName || "");
  const mode = String(payload.mode || "").trim();

  if (!currentGraph || !nodeId || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("认知覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  if (!["known", "hidden", "mistaken"].includes(mode)) {
    return { ok: false, error: "invalid-mode" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }

  const result = applyManualKnowledgeOverride(currentGraph, {
    ownerKey,
    ownerType,
    ownerName,
    nodeId,
    mode,
  });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "override-failed" };
  }

  const persist = saveGraphToChat({ reason: `panel-knowledge-${mode}` });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || ownerKey,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onClearPanelKnowledgeOverride(payload = {}) {
  const nodeId = String(payload.nodeId || "");
  const ownerKey = String(payload.ownerKey || "");
  const ownerType = String(payload.ownerType || "");
  const ownerName = String(payload.ownerName || "");

  if (!currentGraph || !nodeId || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("认知覆盖清理", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  if (!getNode(currentGraph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }

  const result = clearManualKnowledgeOverride(currentGraph, {
    ownerKey,
    ownerType,
    ownerName,
    nodeId,
  });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "clear-override-failed" };
  }

  const persist = saveGraphToChat({ reason: "panel-knowledge-clear" });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || ownerKey,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onRenamePanelKnowledgeOwner(payload = {}) {
  const ownerKey = String(payload.ownerKey || "").trim();
  const nextName = String(payload.nextName || "").trim();
  if (!currentGraph || !ownerKey || !nextName) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("角色认知重命名", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = renameKnowledgeOwner(currentGraph, ownerKey, nextName);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "rename-owner-failed" };
  }

  const persist = saveGraphToChat({ reason: "panel-knowledge-owner-rename" });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || ownerKey,
    previousOwnerKey: result.previousOwnerKey || ownerKey,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onMergePanelKnowledgeOwners(payload = {}) {
  const sourceOwnerKey = String(payload.sourceOwnerKey || payload.ownerKey || "").trim();
  const targetOwnerKey = String(payload.targetOwnerKey || "").trim();
  if (!currentGraph || !sourceOwnerKey || !targetOwnerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("角色认知合并", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = mergeKnowledgeOwners(currentGraph, {
    sourceOwnerKey,
    targetOwnerKey,
  });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "merge-owner-failed" };
  }

  const persist = saveGraphToChat({ reason: "panel-knowledge-owner-merge" });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || targetOwnerKey,
    sourceOwnerKey: result.sourceOwnerKey || sourceOwnerKey,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onDeletePanelKnowledgeOwner(payload = {}) {
  const ownerKey = String(payload.ownerKey || "").trim();
  const mode = String(payload.mode || "owner-only").trim() || "owner-only";
  if (!currentGraph || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("角色认知删除", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = deleteKnowledgeOwner(currentGraph, ownerKey, { mode });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "delete-owner-failed" };
  }

  const persist = saveGraphToChat({
    reason: `panel-knowledge-owner-delete-${result.mode || mode}`,
  });
  refreshPanelLiveState();
  return {
    ok: true,
    ownerKey: result.ownerKey || ownerKey,
    mode: result.mode || mode,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onSetPanelActiveRegion(payload = {}) {
  const region = String(payload.region || "").trim();
  if (!currentGraph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("地区覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = setManualActiveRegion(currentGraph, region);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "set-region-failed" };
  }

  const persist = saveGraphToChat({
    reason: region ? "panel-region-set" : "panel-region-clear",
  });
  refreshPanelLiveState();
  return {
    ok: true,
    activeRegion: result.activeRegion || "",
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onSetPanelActiveStoryTime(payload = {}) {
  const label = String(payload.label || "").trim();
  if (!currentGraph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("剧情时间覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  const result = setManualActiveStorySegment(currentGraph, { label });
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "set-story-time-failed" };
  }
  const persist = saveGraphToChat({
    reason: label ? "panel-story-time-set" : "panel-story-time-clear",
  });
  refreshPanelLiveState();
  return {
    ok: true,
    activeStorySegmentId: result.activeStorySegmentId || "",
    activeStoryTimeLabel: result.activeStoryTimeLabel || "",
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onClearPanelActiveStoryTime() {
  if (!currentGraph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("剧情时间覆盖清理", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  const result = clearManualActiveStorySegment(currentGraph);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "clear-story-time-failed" };
  }
  const persist = saveGraphToChat({ reason: "panel-story-time-clear" });
  refreshPanelLiveState();
  return {
    ok: true,
    activeStorySegmentId: result.activeStorySegmentId || "",
    activeStoryTimeLabel: result.activeStoryTimeLabel || "",
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

function onUpdatePanelRegionAdjacency(payload = {}) {
  const fallbackRegion =
    currentGraph?.historyState?.activeRegion ||
    currentGraph?.regionState?.manualActiveRegion ||
    "";
  const region = String(payload.region || fallbackRegion).trim();
  const adjacent = Array.isArray(payload.adjacent)
    ? payload.adjacent
    : String(payload.adjacent || "")
        .split(/[,\n，]/)
        .map((value) => String(value || "").trim())
        .filter(Boolean);

  if (!currentGraph || !region) {
    return { ok: false, error: "missing-region" };
  }
  if (!ensureGraphMutationReady("地区邻接编辑", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = updateRegionAdjacencyManual(currentGraph, region, adjacent);
  if (!result?.ok) {
    return { ok: false, error: result?.reason || "update-adjacency-failed" };
  }

  const persist = saveGraphToChat({ reason: "panel-region-adjacency" });
  refreshPanelLiveState();
  return {
    ok: true,
    region,
    persist,
    persistBlocked: Boolean(persist?.blocked),
  };
}

async function onExportGraph() {
  return await onExportGraphController({
    document,
    exportGraph,
    getCurrentGraph: () => currentGraph,
    toastr,
  });
}

async function onImportGraph() {
  return await runWithRestoreLock(
    "graph-import",
    "graph-import",
    async () =>
      await onImportGraphController({
        clearInjectionState,
        clearTimeout,
        document,
        ensureGraphMutationReady: (operationLabel, options = {}) =>
          ensureGraphMutationReady(operationLabel, {
            ...(options || {}),
            ignoreRestoreLock: true,
          }),
        getAssistantTurns,
        getContext,
        getCurrentChatId,
        importGraph,
        markVectorStateDirty,
        normalizeGraphRuntimeState,
        rebindProcessedHistoryStateToChat,
        saveGraphToChat,
        setCurrentGraph: (graph) => {
          currentGraph = graph;
        },
        setExtractionCount: (value) => {
          extractionCount = value;
        },
        setLastExtractedItems: (items) => {
          lastExtractedItems = items;
        },
        toastr,
        updateLastRecalledItems,
        window,
      }),
  );
}

async function onViewLastInjection() {
  return await onViewLastInjectionController({
    document,
    getLastInjectionContent: () => lastInjectionContent,
    toastr,
  });
}

async function onTestEmbedding() {
  return await onTestEmbeddingController({
    getCurrentChatId,
    getEmbeddingConfig,
    testVectorConnection,
    toastr,
    validateVectorConfig,
  });
}

async function onTestMemoryLLM() {
  return await onTestMemoryLLMController({
    testLLMConnection,
    toastr,
  });
}

async function onFetchMemoryLLMModels() {
  return await onFetchMemoryLLMModelsController({
    fetchMemoryLLMModels,
    toastr,
  });
}

async function onFetchEmbeddingModels(mode = null) {
  return await onFetchEmbeddingModelsController(
    {
      fetchAvailableEmbeddingModels,
      getEmbeddingConfig,
      toastr,
      validateVectorConfig,
    },
    mode,
  );
}

async function onManualExtract(options = {}) {
  return await onManualExtractController(
    {
      beginStageAbortController,
      clampInt,
      console,
      createEmptyGraph,
      ensureGraphMutationReady,
      executeExtractionBatch,
      finishStageAbortController,
      getAssistantTurns,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => currentGraph,
      getGraphPersistenceState: () => graphPersistenceState,
      getIsExtracting: () => isExtracting,
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      normalizeGraphRuntimeState,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      retryPendingGraphPersist,
      setCurrentGraph: (graph) => {
        currentGraph = graph;
      },
      setIsExtracting: (value) => {
        isExtracting = value;
      },
      setLastExtractionStatus,
      toastr,
    },
    options,
  );
}

async function onExtractionTask(options = {}) {
  return await onExtractionTaskController(
    {
      beginStageAbortController,
      clampInt,
      console,
      createEmptyGraph,
      ensureGraphMutationReady,
      executeExtractionBatch,
      finishStageAbortController,
      getAssistantTurns,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => currentGraph,
      getGraphMutationBlockReason,
      getGraphPersistenceState: () => graphPersistenceState,
      getIsExtracting: () => isExtracting,
      getLastExtractionStatusLevel: () => lastExtractionStatus?.level || "idle",
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      normalizeGraphRuntimeState,
      onManualExtract,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      retryPendingGraphPersist,
      rollbackGraphForReroll,
      setCurrentGraph: (graph) => {
        currentGraph = graph;
      },
      setIsExtracting: (value) => {
        isExtracting = value;
      },
      setLastExtractionStatus,
      setRuntimeStatus,
      toastr,
    },
    options,
  );
}

async function onReroll({ fromFloor } = {}) {
  return await onRerollController(
    {
      console,
      ensureGraphMutationReady,
      getAssistantTurns,
      getContext,
      getCurrentGraph: () => currentGraph,
      getGraphMutationBlockReason,
      getGraphPersistenceState: () => graphPersistenceState,
      getIsExtracting: () => isExtracting,
      getLastExtractionStatusLevel: () => lastExtractionStatus?.level || "idle",
      getLastProcessedAssistantFloor,
      isAbortError,
      onManualExtract,
      refreshPanelLiveState,
      rollbackGraphForReroll,
      setLastExtractionStatus,
      setRuntimeStatus,
      toastr,
    },
    { fromFloor },
  );
}

async function onManualSleep() {
  return await onManualSleepController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getSettings,
    refreshPanelLiveState,
    recordMaintenanceAction,
    recordGraphMutation,
    setRuntimeStatus,
    sleepCycle,
    toastr,
  });
}

async function onManualSynopsis() {
  return await onManualSynopsisController({
    ensureGraphMutationReady,
    generateSmallSummary,
    getCurrentChatSeq,
    getCurrentGraph: () => currentGraph,
    getContext,
    getSettings,
    refreshPanelLiveState,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
  });
}

async function onManualSummaryRollup() {
  return await onManualSummaryRollupController({
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getSettings,
    refreshPanelLiveState,
    rollupSummaryFrontier,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
  });
}

async function onRebuildSummaryState(options = {}) {
  return await runWithRestoreLock(
    "summary-rebuild",
    "summary-rebuild",
    async () =>
      await onRebuildSummaryStateController(
        {
          ensureGraphMutationReady: (operationLabel, nextOptions = {}) =>
            ensureGraphMutationReady(operationLabel, {
              ...(nextOptions || {}),
              ignoreRestoreLock: true,
            }),
          getContext,
          getCurrentGraph: () => currentGraph,
          getSettings,
          rebuildHierarchicalSummaryState,
          refreshPanelLiveState,
          saveGraphToChat,
          setRuntimeStatus,
          toastr,
        },
        options,
      ),
  );
}

async function onClearSummaryState() {
  return await onClearSummaryStateController({
    confirm: (msg) => (typeof globalThis.confirm === "function" ? globalThis.confirm(msg) : false),
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    refreshPanelLiveState,
    resetHierarchicalSummaryState,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
  });
}

async function onManualEvolve() {
  return await onManualEvolveController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    consolidateMemories,
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    getEmbeddingConfig,
    getLastExtractedItems: () => lastExtractedItems,
    getSettings,
    refreshPanelLiveState,
    recordMaintenanceAction,
    recordGraphMutation,
    setRuntimeStatus,
    toastr,
    validateVectorConfig,
  });
}

async function onUndoLastMaintenance() {
  return await onUndoLastMaintenanceController({
    ensureGraphMutationReady,
    getCurrentGraph: () => currentGraph,
    markVectorStateDirty,
    refreshPanelLiveState,
    saveGraphToChat,
    setRuntimeStatus,
    toastr,
    undoLastMaintenance: undoLastMaintenanceAction,
  });
}

async function onRebuildVectorIndex(range = null) {
  return await onRebuildVectorIndexController(
    {
      beginStageAbortController,
      ensureCurrentGraphRuntimeState,
      ensureGraphMutationReady,
      finishStageAbortController,
      getEmbeddingConfig,
      isAuthorityVectorConfig,
      isBackendVectorConfig,
      refreshPanelLiveState,
      saveGraphToChat,
      shouldUseAuthorityJobs,
      submitAuthorityVectorRebuildJob,
      syncVectorState,
      toastr,
      validateVectorConfig,
    },
    range,
  );
}

async function onRefreshAuthorityJobs() {
  return await refreshAuthorityRecentJobs({
    replace: true,
    reason: "panel-authority-jobs-refresh",
  });
}

async function onRunAuthorityConsistencyAudit() {
  return await runAuthorityConsistencyAudit({
    reason: "panel-authority-consistency-audit",
  });
}

async function onRunAuthorityConsistencyRepairPlan() {
  return await runAuthorityConsistencyRepairPlan({
    reason: "panel-authority-consistency-repair-plan",
  });
}

async function onWriteAuthorityCheckpoint() {
  return await writeAuthorityCheckpointFromCurrentGraph({
    reason: "panel-authority-checkpoint-write",
  });
}

async function onRestoreAuthorityCheckpoint() {
  return await restoreAuthorityCheckpointFromBlob({
    reason: "panel-authority-checkpoint-restore",
  });
}

async function onCaptureAuthorityPerformanceBaseline() {
  return captureAuthorityPerformanceBaseline({
    reason: "panel-authority-performance-baseline",
  });
}

async function onRefreshAuthorityDiagnosticsArtifacts() {
  return await refreshAuthorityDiagnosticsArtifacts({
    refreshHost: true,
  });
}

async function onReadAuthorityDiagnosticsArtifact(path = "") {
  return await readAuthorityDiagnosticsArtifact(path, {
    refreshHost: true,
  });
}

async function onDeleteAuthorityDiagnosticsArtifact(path = "") {
  return await deleteAuthorityDiagnosticsArtifact(path, {
    refreshHost: true,
  });
}

async function onReembedDirect() {
  return await onReembedDirectController({
    getEmbeddingConfig,
    isDirectVectorConfig,
    onRebuildVectorIndex: async () => await onRebuildVectorIndex(),
    toastr,
  });
}

// ==================== 数据清理 ====================

const _cleanupRuntime = () => ({
  confirm: (msg) => (typeof globalThis.confirm === "function" ? globalThis.confirm(msg) : false),
  prompt: (msg) => (typeof globalThis.prompt === "function" ? globalThis.prompt(msg) : null),
  createEmptyGraph,
  clearInjectionState,
  ensureGraphMutationReady,
  exportDiagnosticsBundle: async (options = {}) => await exportAuthorityDiagnosticsBundle(options),
  getCurrentChatId,
  getCurrentGraph: () => currentGraph,
  markVectorStateDirty: (reason) => {
    if (currentGraph?.vectorIndexState) {
      currentGraph.vectorIndexState.dirty = true;
      currentGraph.vectorIndexState.dirtyReason = reason;
    }
  },
  normalizeGraphRuntimeState,
  refreshPanelLiveState,
  removeNode: (graph, nodeId) => removeNode(graph, nodeId),
  saveGraphToChat,
  syncGraphLoadFromLiveContext,
  setCurrentGraph: (graph) => { currentGraph = graph; },
  setRuntimeStatus,
  setExtractionCount: (count) => {
    if (currentGraph?.historyState) {
      currentGraph.historyState.extractionCount = count;
    }
  },
  setLastExtractedItems: () => { lastExtractedItems = []; },
  buildBmeDbName,
  buildRestoreSafetyDbName: (chatId) =>
    buildBmeDbName(buildRestoreSafetyChatId(chatId)),
  buildRestoreSafetyChatId,
  closeBmeDb: async (chatId) => {
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId || !bmeChatManager) return;
    if (
      typeof bmeChatManager.getCurrentChatId === "function" &&
      bmeChatManager.getCurrentChatId() === normalizedChatId &&
      typeof bmeChatManager.closeCurrent === "function"
    ) {
      await bmeChatManager.closeCurrent();
    }
  },
  closeAllBmeDbs: async () => {
    if (bmeChatManager && typeof bmeChatManager.closeAll === "function") {
      await bmeChatManager.closeAll();
    }
  },
  clearCachedIndexedDbSnapshot,
  clearAllCachedIndexedDbSnapshots,
  clearCurrentChatCommitMarker,
  clearCurrentChatRecoveryAnchors,
  refreshCurrentChatLocalStoreBinding,
  deleteCurrentChatOpfsStorage: async (chatId) =>
    await deleteOpfsChatStorage(chatId),
  deleteAllOpfsStorage: async () =>
    await deleteAllOpfsStorage(),
  deleteRemoteSyncFile: (chatId) => deleteRemoteSyncFile(chatId, {
    fetch: globalThis.fetch?.bind(globalThis),
    getRequestHeaders: typeof getRequestHeaders === "function" ? getRequestHeaders : undefined,
  }),
  getGraphPersistenceState: () => graphPersistenceState,
  getSettings,
  toastr,
});

async function onClearGraph() {
  return await onClearGraphController(_cleanupRuntime());
}

async function onClearGraphRange(startSeq, endSeq) {
  return await onClearGraphRangeController(_cleanupRuntime(), startSeq, endSeq);
}

async function onClearVectorCache() {
  return await onClearVectorCacheController(_cleanupRuntime());
}

async function onClearBatchJournal() {
  return await onClearBatchJournalController(_cleanupRuntime());
}

async function onDeleteCurrentIdb() {
  return await onDeleteCurrentIdbController(_cleanupRuntime());
}

async function onDeleteAllIdb() {
  return await onDeleteAllIdbController(_cleanupRuntime());
}

async function onDeleteServerSyncFile() {
  return await onDeleteServerSyncFileController(_cleanupRuntime());
}

async function onExportDiagnosticsBundle() {
  return await onExportDiagnosticsBundleController(_cleanupRuntime());
}

async function onBackupCurrentChatToCloud() {
  const chatId = getCurrentChatId();
  if (!chatId) {
    toastr.warning("当前没有聊天上下文");
    return { handledToast: true };
  }

  const result = await backupToServer(
    chatId,
    buildBmeSyncRuntimeOptions({
      reason: "manual-backup",
      trigger: "panel:manual-backup",
    }),
  );

  if (!result?.backedUp) {
    const backupFailureMessage =
      result?.reason === "backup-manifest-error"
        ? result?.backupUploaded
          ? "备份文件已上传，但服务器备份清单更新失败，请稍后重试"
          : "服务器备份清单更新失败，请稍后重试"
        : `备份失败: ${result?.error?.message || result?.reason || "未知原因"}`;
    toastr.error(backupFailureMessage);
    return { handledToast: true, result };
  }

  toastr.success("当前聊天已备份到云端");
  await syncIndexedDbMetaToPersistenceState(chatId, {
    syncState: "idle",
    lastSyncError: "",
  });
  return { handledToast: true, result };
}

async function onRestoreCurrentChatFromCloud() {
  return await runWithRestoreLock(
    "cloud-restore",
    "manual-restore",
    async () => {
      const chatId = getCurrentChatId();
      if (!chatId) {
        toastr.warning("当前没有聊天上下文");
        return { handledToast: true };
      }

      const confirmed = globalThis.confirm?.(
        "这会用云端备份完整覆盖当前聊天的本地记忆，并先保留一份本地安全快照。确定继续吗？",
      );
      if (!confirmed) {
        return { cancelled: true };
      }

      const result = await restoreFromServer(
        chatId,
        buildBmeSyncRuntimeOptions({
          reason: "manual-restore",
          trigger: "panel:manual-restore",
        }),
      );

      if (!result?.restored) {
        const reasonMap = {
          "not-found": "服务器上没有找到当前聊天的备份",
          "backup-missing": "服务器上没有找到当前聊天的备份",
          "backup-version-mismatch": "备份版本与当前运行时不兼容",
          "backup-chat-id-mismatch": "备份聊天 ID 与当前聊天不匹配",
          "snapshot-chat-id-mismatch": "备份内部快照与当前聊天不匹配",
        };
        toastr.error(
          reasonMap[result?.reason] ||
            `恢复失败: ${result?.error?.message || result?.reason || "未知原因"}`,
        );
        return { handledToast: true, result };
      }

      toastr.success("已从云端恢复当前聊天备份");
      await syncIndexedDbMetaToPersistenceState(chatId, {
        syncState: "idle",
        lastSyncError: "",
      });
      return { handledToast: true, result };
    },
  );
}

async function onManageServerBackups() {
  const chatId = getCurrentChatId();
  const { entries } = await listServerBackups(
    buildBmeSyncRuntimeOptions({
      reason: "manage-backups",
      trigger: "panel:manage-backups",
    }),
  );
  return {
    entries: Array.isArray(entries) ? entries : [],
    currentChatId: chatId,
    handledToast: true,
    skipDashboardRefresh: true,
  };
}

async function onDeleteServerBackupEntry(payload = {}) {
  const chatId = String(payload?.chatId || "").trim();
  const filename = String(payload?.filename || "").trim();
  const serverPath = String(payload?.serverPath || "").trim();
  if (!chatId) {
    return {
      deleted: false,
      reason: "missing-chat-id",
      filename,
      handledToast: true,
      skipDashboardRefresh: true,
    };
  }

  const deleteResult = await deleteServerBackup(
    chatId,
    buildBmeSyncRuntimeOptions({
      reason: "delete-backup",
      trigger: "panel:delete-backup",
      filename,
      serverPath,
    }),
  );

  const currentChatId = getCurrentChatId();
  if (
    deleteResult?.deleted &&
    currentChatId &&
    normalizeChatIdCandidate(currentChatId) ===
      normalizeChatIdCandidate(chatId)
  ) {
    await syncIndexedDbMetaToPersistenceState(chatId, {
      syncState: "idle",
      lastSyncError: "",
    });
  }

  return {
    ...deleteResult,
    filename: deleteResult?.filename || filename,
    handledToast: true,
    skipDashboardRefresh: true,
  };
}

// ==================== 恢复快照 ====================

async function onGetRestoreSafetySnapshotStatus() {
  const chatId = getCurrentChatId();
  if (!chatId) {
    return {
      exists: false,
      chatId: "",
      createdAt: 0,
      reason: "missing-chat-id",
    };
  }

  return await getRestoreSafetySnapshotStatus(
    chatId,
    buildBmeSyncRuntimeOptions({
      reason: "manual-restore-safety-status",
      trigger: "panel:restore-safety-status",
    }),
  );
}

async function onRollbackLastRestore() {
  return await runWithRestoreLock(
    "restore-rollback",
    "manual-restore-rollback",
    async () => {
      const chatId = getCurrentChatId();
      if (!chatId) {
        toastr.warning("当前没有聊天上下文");
        return { handledToast: true };
      }

      const safetyStatus = await onGetRestoreSafetySnapshotStatus();
      if (!safetyStatus?.exists) {
        toastr.info("当前聊天还没有可用的上次恢复回滚点");
        return { handledToast: true, result: safetyStatus };
      }

      const confirmed = globalThis.confirm?.(
        "这会回滚到上次从云端恢复之前的本地状态。确定继续吗？",
      );
      if (!confirmed) {
        return { cancelled: true };
      }

      const result = await rollbackFromRestoreSafetySnapshot(
        chatId,
        buildBmeSyncRuntimeOptions({
          reason: "manual-restore-safety-rollback",
          trigger: "panel:rollback-last-restore",
        }),
      );

      if (!result?.restored) {
        toastr.error(
          `回滚失败: ${result?.error?.message || result?.reason || "未知原因"}`,
        );
        return { handledToast: true, result };
      }

      toastr.success("已回滚到上次恢复前的本地状态");
      await syncIndexedDbMetaToPersistenceState(chatId, {
        syncState: "idle",
        lastSyncError: "",
      });
      return { handledToast: true, result };
    },
  );
}

async function onRetryPendingPersist() {
  await refreshCurrentChatLocalStoreBinding({
    forceCapabilityRefresh: true,
    reopenCurrentDb: true,
    source: "panel-manual-persist-retry",
  });
  const hadPending = graphPersistenceState.pendingPersist === true;
  const result = await retryPendingGraphPersist({
    reason: "panel-manual-persist-retry",
    scheduleRetryOnFailure: false,
    ignoreRestoreLock: true,
  });
  refreshPanelLiveState();

  if (result?.accepted === true) {
    toastr.success("最近一批持久化已确认");
    return { handledToast: true, result };
  }

  if (!hadPending && String(result?.reason || "") === "no-pending-persist") {
    toastr.info("当前没有待重试的持久化批次");
    return { handledToast: true, result };
  }

  toastr.warning(
    `重试持久化仍未成功: ${result?.reason || result?.loadState || "未知原因"}`,
  );
  return { handledToast: true, result };
}

async function onProbeGraphLoad() {
  await refreshCurrentChatLocalStoreBinding({
    forceCapabilityRefresh: true,
    reopenCurrentDb: true,
    source: "panel-manual-graph-probe",
  });
  const result = syncGraphLoadFromLiveContext({
    source: "panel-manual-graph-probe",
    force: true,
  });
  refreshPanelLiveState();

  if (graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING) {
    toastr.info("已重新探测当前聊天图谱，正在等待本地持久化加载");
    return { handledToast: true, result };
  }

  if (graphPersistenceState.loadState === GRAPH_LOAD_STATES.BLOCKED) {
    toastr.warning(
      `当前图谱仍处于保护模式: ${graphPersistenceState.reason || "metadata not ready"}`,
    );
    return { handledToast: true, result };
  }

  toastr.success("已重新探测当前聊天图谱");
  return { handledToast: true, result };
}

async function onRebuildLocalCacheFromLukerSidecar() {
  const context = getContext();
  const chatStateTarget = resolveCurrentChatStateTarget(context);
  if (!isLukerPrimaryPersistenceHost(context)) {
    toastr.info("当前宿主不是 Luker，无需从主 sidecar 重建本地缓存");
    return { handledToast: true, reason: "not-luker" };
  }
  const chatId = getCurrentChatId(context);
  if (!chatId) {
    toastr.warning("当前没有聊天上下文");
    return { handledToast: true, reason: "missing-chat-id" };
  }

  const loadResult = await loadGraphFromLukerSidecarV2(chatId, {
    source: "panel-manual-luker-cache-rebuild",
    allowOverride: true,
    chatStateTarget,
  });
  if (!loadResult?.loaded || !currentGraph) {
    toastr.warning(
      `无法从 Luker 主 sidecar 重建本地缓存: ${loadResult?.reason || "sidecar not available"}`,
    );
    return { handledToast: true, result: loadResult };
  }

  queueGraphPersistToIndexedDb(chatId, cloneGraphForPersistence(currentGraph, chatId), {
    revision: Math.max(
      Number(graphPersistenceState.lukerManifestRevision || 0),
      Number(getGraphPersistedRevision(currentGraph) || 0),
      Number(graphPersistenceState.revision || 0),
    ),
    reason: "panel-manual-luker-cache-rebuild",
    persistRole: "cache-mirror",
    scheduleCloudUpload: false,
    graphDetached: true,
  });
  refreshPanelLiveState();
  toastr.success("已开始从 Luker 主 sidecar 重建本地缓存");
  return { handledToast: true, result: loadResult };
}

async function onRepairLukerSidecar() {
  const context = getContext();
  const chatStateTarget = resolveCurrentChatStateTarget(context);
  if (!isLukerPrimaryPersistenceHost(context)) {
    toastr.info("当前宿主不是 Luker，无需修复主 sidecar");
    return { handledToast: true, reason: "not-luker" };
  }
  const chatId = getCurrentChatId(context);
  if (!chatId) {
    toastr.warning("当前没有聊天上下文");
    return { handledToast: true, reason: "missing-chat-id" };
  }

  if (
    (!currentGraph || normalizeChatIdCandidate(currentGraph?.historyState?.chatId) !== normalizeChatIdCandidate(chatId)) &&
    !(await loadGraphFromLukerSidecarV2(chatId, {
      source: "panel-manual-luker-sidecar-repair",
      allowOverride: true,
      chatStateTarget,
    }))?.loaded
  ) {
    toastr.warning("当前无法从 Luker 主 sidecar 恢复运行时图谱，暂时不能修复");
    return { handledToast: true, reason: "sidecar-load-failed" };
  }

  const result = await compactLukerGraphSidecarV2(context, {
    graph: cloneGraphForPersistence(currentGraph, chatId),
    chatId,
    revision: Math.max(
      Number(graphPersistenceState.lukerManifestRevision || 0),
      Number(getGraphPersistedRevision(currentGraph) || 0),
      Number(graphPersistenceState.revision || 0),
    ),
    reason: "panel-manual-luker-sidecar-repair",
    integrity:
      getChatMetadataIntegrity(context) || graphPersistenceState.metadataIntegrity,
    chatStateTarget,
  });
  refreshPanelLiveState();
  if (result?.ok) {
    toastr.success("Luker 主 sidecar 已重新修复并压实");
    return { handledToast: true, result };
  }

  toastr.warning(`Luker 主 sidecar 修复失败: ${result?.reason || "unknown"}`);
  return { handledToast: true, result };
}

async function onCompactLukerSidecar() {
  const context = getContext();
  const chatStateTarget = resolveCurrentChatStateTarget(context);
  if (!isLukerPrimaryPersistenceHost(context)) {
    toastr.info("当前宿主不是 Luker，无需压实主 sidecar");
    return { handledToast: true, reason: "not-luker" };
  }
  const chatId = getCurrentChatId(context);
  if (!chatId || !currentGraph) {
    toastr.warning("当前没有可压实的图谱");
    return { handledToast: true, reason: "missing-graph" };
  }

  const result = await compactLukerGraphSidecarV2(context, {
    graph: cloneGraphForPersistence(currentGraph, chatId),
    chatId,
    revision: Math.max(
      Number(graphPersistenceState.lukerManifestRevision || 0),
      Number(getGraphPersistedRevision(currentGraph) || 0),
      Number(graphPersistenceState.revision || 0),
    ),
    reason: "panel-manual-luker-sidecar-compact",
    integrity:
      getChatMetadataIntegrity(context) || graphPersistenceState.metadataIntegrity,
    chatStateTarget,
  });
  refreshPanelLiveState();
  if (result?.ok) {
    toastr.success("Luker 主 sidecar 压实完成");
    return { handledToast: true, result };
  }
  toastr.warning(`Luker 主 sidecar 压实失败: ${result?.reason || "unknown"}`);
  return { handledToast: true, result };
}

(async function init() {
  await loadServerSettings();
  void refreshAuthorityRuntimeState({
    force: true,
    source: "init",
  });
  const { target, lightweightHostMode, adapter } = syncBmeHostRuntimeFlags(getContext());
  updateGraphPersistenceState({
    hostProfile: adapter.hostProfile,
    chatStateTarget: cloneRuntimeDebugValue(target, null),
    lightweightHostMode,
  });
  syncGraphPersistenceDebugState();

  await initializePanelBridgeController({
    $,
    actions: {
      syncGraphLoad: async () => {
        const refreshPlan = buildPanelOpenLocalStoreRefreshPlan();
        if (refreshPlan.shouldRefresh) {
          await refreshCurrentChatLocalStoreBinding({
            forceCapabilityRefresh: refreshPlan.forceCapabilityRefresh,
            reopenCurrentDb: refreshPlan.reopenCurrentDb,
            source: `panel-open-sync:${refreshPlan.reasons.join(",") || "refresh"}`,
          });
        }
        return syncGraphLoadFromLiveContext({
          source: "panel-open-sync",
        });
      },
      extractTask: onExtractionTask,
      extract: onManualExtract,
      compress: onManualCompress,
      sleep: onManualSleep,
      synopsis: onManualSynopsis,
      summaryRollup: onManualSummaryRollup,
      rebuildSummaryState: onRebuildSummaryState,
      clearSummaryState: onClearSummaryState,
      retryPendingPersist: onRetryPendingPersist,
      probeGraphLoad: onProbeGraphLoad,
      rebuildLukerLocalCache: onRebuildLocalCacheFromLukerSidecar,
      repairLukerSidecar: onRepairLukerSidecar,
      compactLukerSidecar: onCompactLukerSidecar,
      export: onExportGraph,
      import: onImportGraph,
      rebuild: onRebuild,
      evolve: onManualEvolve,
      undoMaintenance: onUndoLastMaintenance,
      testEmbedding: onTestEmbedding,
      testMemoryLLM: onTestMemoryLLM,
      fetchMemoryLLMModels: onFetchMemoryLLMModels,
      fetchEmbeddingModels: onFetchEmbeddingModels,
      inspectTaskRegexReuse: (taskType) =>
        inspectTaskRegexReuse(getSettings(), taskType),
      applyCurrentHide: () => applyMessageHideNow("panel-manual-apply"),
      clearCurrentHide: () => clearAllHiddenMessages("panel-manual-clear"),
      saveGraphNode: onSavePanelGraphNode,
      deleteGraphNode: onDeletePanelGraphNode,
      applyKnowledgeOverride: onApplyPanelKnowledgeOverride,
      clearKnowledgeOverride: onClearPanelKnowledgeOverride,
      renameKnowledgeOwner: onRenamePanelKnowledgeOwner,
      mergeKnowledgeOwners: onMergePanelKnowledgeOwners,
      deleteKnowledgeOwner: onDeletePanelKnowledgeOwner,
      setActiveRegion: onSetPanelActiveRegion,
      setActiveStoryTime: onSetPanelActiveStoryTime,
      clearActiveStoryTime: onClearPanelActiveStoryTime,
      updateRegionAdjacency: onUpdatePanelRegionAdjacency,
      rebuildVectorIndex: () => onRebuildVectorIndex(),
      rebuildVectorRange: (range) => onRebuildVectorIndex(range),
      requeueAuthorityJob: async (jobId) => await requeueAuthorityJob(jobId),
      refreshAuthorityJobs: onRefreshAuthorityJobs,
      runAuthorityConsistencyAudit: onRunAuthorityConsistencyAudit,
      runAuthorityConsistencyRepairPlan: onRunAuthorityConsistencyRepairPlan,
      writeAuthorityCheckpoint: onWriteAuthorityCheckpoint,
      restoreAuthorityCheckpoint: onRestoreAuthorityCheckpoint,
      captureAuthorityPerformanceBaseline: onCaptureAuthorityPerformanceBaseline,
      refreshAuthorityDiagnosticsArtifacts: onRefreshAuthorityDiagnosticsArtifacts,
      readAuthorityDiagnosticsArtifact: onReadAuthorityDiagnosticsArtifact,
      deleteAuthorityDiagnosticsArtifact: onDeleteAuthorityDiagnosticsArtifact,
      reembedDirect: onReembedDirect,
      reroll: onReroll,
      clearGraph: onClearGraph,
      clearGraphRange: (startSeq, endSeq) => onClearGraphRange(startSeq, endSeq),
      clearVectorCache: onClearVectorCache,
      clearBatchJournal: onClearBatchJournal,
      deleteCurrentIdb: onDeleteCurrentIdb,
      deleteAllIdb: onDeleteAllIdb,
      exportDiagnosticsBundle: onExportDiagnosticsBundle,
      deleteServerSyncFile: onDeleteServerSyncFile,
      backupToCloud: onBackupCurrentChatToCloud,
      restoreFromCloud: onRestoreCurrentChatFromCloud,
      rollbackLastRestore: onRollbackLastRestore,
      manageServerBackups: onManageServerBackups,
      deleteServerBackupEntry: onDeleteServerBackupEntry,
      getRestoreSafetyStatus: onGetRestoreSafetySnapshotStatus,
    },
    console,
    document,
    getGraph: () => currentGraph,
    getGraphPersistenceState: () => getGraphPersistenceLiveState(),
    getHideStateSnapshot: () => getMessageHideStateSnapshotForPanel(),
    getLastBatchStatus: () =>
      currentGraph?.historyState?.lastBatchStatus || null,
    getLastExtract: () => lastExtractedItems,
    getLastExtractionStatus: () => lastExtractionStatus,
    getLastInjection: () => lastInjectionContent,
    getLastRecall: () => lastRecalledItems,
    getLastRecallStatus: () => lastRecallStatus,
    getLastVectorStatus: () => lastVectorStatus,
    getPanelModule: () => _panelModule,
    getRuntimeDebugSnapshot: (options = {}) =>
      getPanelRuntimeDebugSnapshot(options),
    getRuntimeStatus: () => getPanelRuntimeStatus(),
    getSettings,
    getThemesModule: () => _themesModule,
    importPanelModule: async () => await import("./ui/panel.js"),
    importThemesModule: async () => await import("./ui/themes.js"),
    setPanelModule: (module) => {
      _panelModule = module;
    },
    setThemesModule: (module) => {
      _themesModule = module;
    },
    updateSettings: updateModuleSettings,
  });

  try {
    ensureBmeChatManager();
    scheduleBmeIndexedDbWarmup("init");
    initializeHostCapabilityBridge();
    installSendIntentHooks();
    applyMessageRenderLimit(getSettings());
    autoSyncOnVisibility(buildBmeSyncRuntimeOptions());
    scheduleMessageHideApply("init", 180);

    // 注册事件钩子
    registerCoreEventHooksController({
      console,
      eventSource,
      eventTypes: event_types,
      getCoreEventBindingState,
      handlers: {
        onBeforeCombinePrompts,
        onCharacterMessageRendered,
        onChatBranchCreated,
        onChatChanged,
        onChatLoaded,
        onGenerationBeforeApiRequest,
        onGenerationBeforeWorldInfoScan,
        onGenerationAfterCommands,
        onGenerationAfterWorldInfoScan,
        onGenerationContextReady,
        onGenerationEnded,
        onGenerationStarted,
        onGenerationWorldInfoFinalized,
        onMessageDeleted,
        onMessageEdited,
        onMessageUpdated,
        onMessageReceived,
        onMessageSent,
        onMessageSwiped,
        onUserMessageRendered,
      },
      registerBeforeCombinePrompts,
      registerGenerationAfterCommands,
      setCoreEventBindingState,
    });

    // 加载当前聊天的图谱
    scheduleBmeIndexedDbTask(async () => {
      const syncResult = await syncBmeChatManagerWithCurrentChat("initial-load");
      if (!syncResult?.chatId) {
        syncGraphLoadFromLiveContext({
          source: "initial-load:no-chat",
          force: true,
        });
        return;
      }
      await runBmeAutoSyncForChat("initial-load", syncResult.chatId);
      await loadGraphFromIndexedDb(syncResult.chatId, {
        source: "initial-load",
        allowOverride: true,
        applyEmptyState: true,
      });
    });
  } catch (bootError) {
    console.error("[ST-BME] 核心初始化阶段失败（面板入口已保留）:", bootError);
  }

  schedulePersistedRecallMessageUiRefresh(120);
  try {
    const { initEnaPlanner } = await import("./ena-planner/ena-planner.js");
    await initEnaPlanner({
      getContext,
      getExtensionPath: () => `scripts/extensions/third-party/${MODULE_NAME}`,
      getPlannerRecallTimeoutMs,
      isTrivialUserInput,
      preparePlannerRecallHandoff,
      runPlannerRecallForEna,
    });
    debugLog("[ST-BME] Ena Planner module loaded");
  } catch (error) {
    console.warn("[ST-BME] Ena Planner module load failed:", error);
  }
  debugLog("[ST-BME] 初始化完成");
})();


