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
} from "./host/st-script.js";
import {
  extension_settings,
  getContext,
  saveMetadataDebounced,
} from "./host/st-extensions.js";

import { ConversationRepository } from "./sync/conversation-repository.js";
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
import { GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED } from "./sync/authority-graph-mode.js";
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
  isAcceptedLegacyPersistenceTier,
  isRecoveryOnlyLegacyPersistenceTier,
  repairLegacyLastBatchPersistenceStatus,
} from "./sync/legacy-persistence-repair.js";
import {
  PERSISTENCE_EVENT_TYPES,
  applyPersistenceRecordToBatchStatus as reducePersistenceRecordToBatchStatus,
  buildBatchPersistenceRecordFromPersistResult as reduceBatchPersistenceRecordFromPersistResult,
  planAcceptedPendingClear,
  reducePersistenceStatePatch,
} from "./sync/persistence-reducer.js";
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
  readStructuredPlotRecordFromMessage,
  writeStructuredPlotRecordToMessage,
} from "./ena-planner/planner-plot-history.js";
import {
  BME_HOST_PROFILE_LUKER,
  getBmeHostAdapter,
  isBmeLightweightHostMode,
  isLukerHostContext,
  normalizeBmeChatStateTarget,
  resolveBmeHostProfile,
  resolveChatStateTargetChatId,
  resolveCurrentBmeChatStateTarget,
  serializeBmeChatStateTarget,
} from "./host/runtime-host-adapter.js";
import {
  getEventMakeFirst,
  getHostCurrentChatId,
  getHostDocument,
  getHostMutationObserver,
  getHostWindow,
  readHostMvuExtraAnalysisFlag,
  readSendTextareaValue,
} from "./host/st-runtime.js";
import {
  recoverHistoryIfNeededController,
  rollbackGraphForRerollController,
} from "./maintenance/reroll-recovery-controller.js";
import {
  handleExtractionSuccessController,
  shouldAdvanceProcessedHistory as shouldAdvanceProcessedHistoryController,
} from "./maintenance/extraction-success-controller.js";
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
  areChatIdsEquivalentForIdentityCore,
  canMutateRuntimeGraphForIdentityCore,
  doesChatIdMatchIdentityCore,
  planRuntimeGraphIdentityRepairCore,
  resolveActiveHostChatIdCore,
  resolveCurrentChatIdentityCore,
  resolveGraphOwnerIdentityCore,
  resolvePersistenceChatIdCore,
  resolveRuntimeGraphFallbackIdentityCore,
} from "./runtime/identity-resolver.js";
import { createRecallInputState } from "./runtime/recall-input-state.js";
import { createRerollRecallInput } from "./runtime/reroll-recall-input.js";
import { createConversationSession } from "./runtime/conversation-session.js";
import { createConversationWorkspace } from "./runtime/conversation-workspace.js";
import { createGenerationRecallTransactions } from "./runtime/generation-recall-transactions.js";
import { createFinalRecallInjection } from "./runtime/final-recall-injection.js";
import { createAutoExtractionDefer } from "./runtime/auto-extraction-defer.js";
import { runPlannerRecallForEnaController } from "./runtime/planner-recall-controller.js";
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
import { notifyHistoryDirtyNotice } from "./ui/history-notice.js";
import {
  applyMessageRenderLimit as applyMessageRenderLimitCore,
  getActiveMessageRenderLimitForHistoryGuard as getActiveMessageRenderLimitForHistoryGuardCore,
  getHighestTrackedProcessedHistoryFloor as getHighestTrackedProcessedHistoryFloorCore,
  getMessageRenderLimitSettings as getMessageRenderLimitSettingsCore,
  getRenderLimitedHistoryRecoveryGuard as getRenderLimitedHistoryRecoveryGuardCore,
} from "./ui/message-render-limit.js";
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
import { createRecallMessageUiController } from "./ui/recall-message-ui-controller.js?v=recall-tabs-v4";
import {
  createRecallCardElement,
  openRecallSidebar,
  updateRecallCardData,
} from "./ui/recall-message-ui.js?v=recall-tabs-v4";
import {
  buildRecallHistoryFingerprint,
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
import { deriveAuthorityUpgradeState } from "./runtime/authority-upgrade-state.js";
import { createVectorSyncCoalescer as createImportedVectorSyncCoalescer } from "./runtime/vector-sync-coalescer.js";
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
  loadGraphFromIndexedDbImpl,
  maybeFlushQueuedGraphPersistImpl,
  queueGraphPersistToIndexedDbImpl,
  retryPendingGraphPersistImpl,
  saveGraphToIndexedDbImpl,
} from "./sync/graph-persistence-io.js";

import {
  assertRecoveryChatStillActiveImpl,
  applyGraphLoadStateImpl,
  buildPanelOpenLocalStoreRefreshPlanImpl,
  ensureGraphMutationReadyImpl,
  getGraphMutationBlockReasonImpl,
  getGraphPersistenceLiveStateImpl,
  getPanelRuntimeStatusImpl,
  readRuntimeDebugSnapshotImpl,
} from "./sync/graph-mutation-gate.js";

import {
  buildBmeSyncRuntimeOptionsImpl,
  loadGraphFromChatImpl,
  maybeCaptureGraphShadowSnapshotImpl,
  onRebuildLocalCacheFromLukerSidecarImpl,
  persistExtractionBatchResultImpl,
  saveGraphToChatImpl,
  shouldUseAuthorityGraphStoreImpl,
  shouldUseAuthorityJobsImpl,
  syncGraphLoadFromLiveContextImpl,
  writeAuthorityCheckpointFromCurrentGraphImpl,
} from "./sync/graph-load-persist.js";
import {
  applyProcessedHistorySnapshotToGraph,
  appendBatchJournal,
  appendMaintenanceJournal,
  buildChatHistoryFingerprint,
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
import { planVectorReadyCheck } from "./vector/vector-gate.js";
import { syncVectorStateController } from "./vector/vector-sync-controller.js";
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
  isAuthorityReplicaSyncRepairAction,
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
const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = "authority.vector.rebuild";
const AUTHORITY_VECTOR_REBUILD_RANGE_JOB_TYPE = "authority.vector.rebuild-range";

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
    return normalizeChatIdCandidate(getHostCurrentChatId());
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
  return resolveActiveHostChatIdCore({ context, readGlobalCurrentChatId });
}

function resolveCurrentChatIdentity(context = getContext()) {
  return resolveCurrentChatIdentityCore({
    context,
    readGlobalCurrentChatId,
    resolveAliasByHostChatId: resolveGraphIdentityAliasByHostChatId,
    resolveIntegrity: getChatMetadataIntegrity,
    hasLikelySelectedChat: hasLikelySelectedChatContext,
  });
}

function getCurrentChatId(context = getContext()) {
  return resolveCurrentChatIdentity(context).chatId;
}

function getRuntimeGraphChatIdFallback(graph = conversationWorkspace.graph) {
  const graphMeta = getGraphPersistenceMeta(graph) || {};
  return resolveRuntimeGraphFallbackIdentityCore({
    graph,
    graphMeta,
    persistenceState: conversationWorkspace.graphPersistenceState,
  }).chatId;
}

function getGraphOwnedChatId(graph = conversationWorkspace.graph) {
  const graphMeta = getGraphPersistenceMeta(graph) || {};
  return resolveGraphOwnerIdentityCore({ graph, graphMeta }).chatId;
}

function resolveOperationalChatId(
  context = getContext(),
  graph = conversationWorkspace.graph,
  explicitChatId = "",
) {
  return (
    normalizeChatIdCandidate(explicitChatId) ||
    normalizeChatIdCandidate(getCurrentChatId(context)) ||
    getRuntimeGraphChatIdFallback(graph)
  );
}

function resolvePersistenceChatId(
  context = getContext(),
  graph = conversationWorkspace.graph,
  explicitChatId = "",
) {
  return resolvePersistenceChatIdCore({
    explicitChatId,
    activeIdentity: resolveCurrentChatIdentity(context),
    graph,
    graphMeta: getGraphPersistenceMeta(graph) || {},
    currentGraph: conversationWorkspace.graph,
    currentGraphMeta: getGraphPersistenceMeta(conversationWorkspace.graph) || {},
    persistenceState: conversationWorkspace.graphPersistenceState,
    context,
  });
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
  return doesChatIdMatchIdentityCore(candidateChatId, {
    identity,
    aliasCandidates: getGraphIdentityAliasCandidates({
      integrity: identity?.integrity,
      hostChatId: identity?.hostChatId,
      persistenceChatId: identity?.chatId,
    }),
  });
}

function areChatIdsEquivalentForResolvedIdentity(
  candidateChatId,
  referenceChatId,
  identity = resolveCurrentChatIdentity(getContext()),
) {
  return areChatIdsEquivalentForIdentityCore(candidateChatId, referenceChatId, {
    identity,
    aliasCandidates: getGraphIdentityAliasCandidates({
      integrity: identity?.integrity,
      hostChatId: identity?.hostChatId,
      persistenceChatId: identity?.chatId,
    }),
  });
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
      : String(conversationWorkspace.graphPersistenceState.acceptedStorageTier || "none"),
    lastAcceptedRevision: shouldResetAcceptedRevision
      ? 0
      : Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
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
      conversationWorkspace.graphPersistenceState.lastRecoverableStorageTier === "metadata-full"
        ? "none"
        : conversationWorkspace.graphPersistenceState.lastRecoverableStorageTier,
    pendingPersist:
      clearPendingPersist === true ? false : conversationWorkspace.graphPersistenceState.pendingPersist,
    writesBlocked:
      clearPendingPersist === true ? false : conversationWorkspace.graphPersistenceState.writesBlocked,
    queuedPersistRevision:
      clearPendingPersist === true ? 0 : conversationWorkspace.graphPersistenceState.queuedPersistRevision,
    queuedPersistChatId:
      clearPendingPersist === true ? "" : conversationWorkspace.graphPersistenceState.queuedPersistChatId,
    queuedPersistMode:
      clearPendingPersist === true ? "" : conversationWorkspace.graphPersistenceState.queuedPersistMode,
    queuedPersistRotateIntegrity:
      clearPendingPersist === true
        ? false
        : conversationWorkspace.graphPersistenceState.queuedPersistRotateIntegrity,
    queuedPersistReason:
      clearPendingPersist === true ? "" : conversationWorkspace.graphPersistenceState.queuedPersistReason,
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
      shadowCleared || metadataResult?.cleared ? "none" : conversationWorkspace.graphPersistenceState.lastRecoverableStorageTier,
    pendingPersist:
      clearPendingPersist === true ? false : conversationWorkspace.graphPersistenceState.pendingPersist,
    writesBlocked:
      clearPendingPersist === true ? false : conversationWorkspace.graphPersistenceState.writesBlocked,
    queuedPersistRevision:
      clearPendingPersist === true ? 0 : conversationWorkspace.graphPersistenceState.queuedPersistRevision,
    queuedPersistChatId:
      clearPendingPersist === true ? "" : conversationWorkspace.graphPersistenceState.queuedPersistChatId,
    queuedPersistMode:
      clearPendingPersist === true ? "" : conversationWorkspace.graphPersistenceState.queuedPersistMode,
    queuedPersistRotateIntegrity:
      clearPendingPersist === true
        ? false
        : conversationWorkspace.graphPersistenceState.queuedPersistRotateIntegrity,
    queuedPersistReason:
      clearPendingPersist === true ? "" : conversationWorkspace.graphPersistenceState.queuedPersistReason,
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
  return isAcceptedLegacyPersistenceTier(storageTier);
}

function isRecoveryOnlyPersistTier(storageTier = "none") {
  return isRecoveryOnlyLegacyPersistenceTier(storageTier);
}

function resolvePersistRevisionFloor(
  requestedRevision = 0,
  graph = conversationWorkspace.graph,
) {
  return Math.max(
    normalizeIndexedDbRevision(requestedRevision),
    normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.revision),
    normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.lastPersistedRevision),
    normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.queuedPersistRevision),
    normalizeIndexedDbRevision(graph ? getGraphPersistedRevision(graph) : 0),
  );
}

function allocateRequestedPersistRevision(
  requestedRevision = 0,
  graph = conversationWorkspace.graph,
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
  return normalizeRestoreLockState(conversationWorkspace.graphPersistenceState.restoreLock).active;
}

function getRestoreLockMessage(operationLabel = "当前操作") {
  const lock = normalizeRestoreLockState(conversationWorkspace.graphPersistenceState.restoreLock);
  if (!lock.active) return "";
  const details = [lock.reason, lock.source].filter(Boolean).join(" / ");
  return `${operationLabel}已暂停：当前处于恢复锁${details ? `（${details}）` : ""}`;
}

function enterRestoreLock(source = "runtime", reason = "") {
  const currentLock = normalizeRestoreLockState(conversationWorkspace.graphPersistenceState.restoreLock);
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
  const currentLock = normalizeRestoreLockState(conversationWorkspace.graphPersistenceState.restoreLock);
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
    revision = conversationWorkspace.graphPersistenceState.revision,
    storageTier = "none",
    accepted = false,
    lastProcessedAssistantFloor = null,
    extractionCount: nextExtractionCount = null,
    graph = conversationWorkspace.graph,
    chatId: explicitChatId = "",
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

  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  const chatId = normalizeChatIdCandidate(explicitChatId || activeChatId);
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
  const identity = resolveCurrentChatIdentity(context);
  if (
    activeChatId &&
    !areChatIdsEquivalentForResolvedIdentity(chatId, activeChatId, identity) &&
    !areChatIdsEquivalentForResolvedIdentity(activeChatId, chatId, identity)
  ) {
    return buildGraphPersistResult({
      saved: false,
      blocked: true,
      accepted: false,
      reason: "commit-marker-target-not-active",
      revision,
      storageTier,
    });
  }

  const marker = buildGraphCommitMarker(graph, {
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
    loadState: conversationWorkspace.graphPersistenceState.loadState,
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
  return readRuntimeDebugSnapshotImpl(
    createGraphMutationGateRuntime(),
  );
}

// ==================== 状态 ====================

let nativePersistDeltaInstallPromise = null;
let nativeHydrateInstallPromise = null;

function createGraphMutationGateRuntime() {
  return {
    AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT,
    BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
    GRAPH_LOAD_STATES,
    buildGraphLocalStoreSelectorKey,
    buildPersistenceEnvironment,
    cloneRuntimeDebugValue,
    console,
    createAbortError,
    createGraphLoadUiStatus,
    doesChatIdMatchResolvedGraphIdentity,
    getAuthorityRuntimeSnapshot,
    getContext,
    getCurrentChatId,
    getCurrentGraph: () => conversationWorkspace.graph,
    getBmeLocalStoreCapabilitySnapshot: () => bmeLocalStoreCapabilitySnapshot,
    getGraphMutationBlockReason,
    getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
    getPreferredGraphLocalStorePresentationSync,
    getRequestedGraphLocalStorageMode,
    getRestoreLockMessage,
    getRuntimeDebugState,
    getRuntimeStatus: () => conversationWorkspace.runtimeStatus,
    getSettings,
    hasMeaningfulRuntimeGraphForChat,
    hasRuntimeGraphMutationContext,
    isGraphLoadStateDbReady,
    isGraphLocalStorageModeOpfs,
    isGraphMetadataWriteAllowed,
    isRestoreLockActive,
    normalizeChatIdCandidate,
    normalizeGraphSyncState,
    normalizePersistenceHostProfile,
    normalizePersistenceStorageTier,
    normalizeRestoreLockState,
    resolvePersistenceHostProfile,
    readGraphCommitMarker,
    repairRuntimeGraphIdentityFromPersistence,
    resolveCurrentChatIdentity,
    syncBmeHostRuntimeFlags,
    maybeResumePendingAutoExtraction,
    updateGraphPersistenceState,
    toastr,
  };
}

function createGraphLoadPersistRuntime() {
  return {
    AUTHORITY_VECTOR_REBUILD_JOB_TYPE,
    BmeDatabase,
    GRAPH_LOAD_STATES,
    GRAPH_METADATA_KEY,
    applyGraphLoadState,
    applyIndexedDbSnapshotToRuntime,
    applyShadowSnapshotToRuntime,
    allocateRequestedPersistRevision,
    buildBmeSyncRuntimeOptions,
    buildGraphFromSnapshot,
    buildGraphPersistResult,
    buildPersistenceEnvironment,
    buildLukerGraphCheckpointV2,
    buildRestoreSafetyChatId,
    buildSnapshotFromGraph,
    buildVectorCollectionId,
    canPersistGraphToMetadataFallback,
    canUseHostGraphChatStatePersistence,
    clearPendingGraphLoadRetry,
    cloneGraphForPersistence,
    cloneGraphSnapshot,
    cloneRuntimeDebugValue,
    console,
    createEmptyGraph,
    createGraphLoadUiStatus,
    createPreferredGraphLocalStore,
    createUiStatus,
    deserializeGraph,
    detectIndexedDbSnapshotCommitMarkerMismatch,
    detectStaleIndexedDbSnapshotAgainstRuntime,
    ensureConversationRepository,
    ensureCurrentGraphRuntimeState,
    exportAuthoritySqlSnapshotForCheckpoint,
    getAcceptedCommitMarkerRevision,
    getAuthorityCapabilityState: () => authorityCapabilityState,
    getAuthorityRuntimeSnapshot,
    getChatMetadataIntegrity,
    getContext,
    getCurrentChatId,
    getCurrentGraph: () => conversationWorkspace.graph,
    setCurrentGraph: (graph) => { conversationWorkspace.graph = graph; },
    getExtractionCount: () => conversationWorkspace.extractionCount,
    setExtractionCount: (value) => { conversationWorkspace.extractionCount = value; },
    getGraphPersistedRevision,
    getGraphPersistenceMeta,
    getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
    getLastExtractedItems: () => conversationWorkspace.lastExtractedItems,
    setLastExtractedItems: (value) => { conversationWorkspace.lastExtractedItems = value; },
    getLastRecalledItems: () => conversationWorkspace.lastRecalledItems,
    setLastRecalledItems: (value) => { conversationWorkspace.lastRecalledItems = value; },
    getLastInjectionContent: () => conversationWorkspace.lastInjectionContent,
    setLastInjectionContent: (value) => { conversationWorkspace.lastInjectionContent = value; },
    getRuntimeStatus: () => conversationWorkspace.runtimeStatus,
    setRuntimeStatus: (value) => { conversationWorkspace.runtimeStatus = value; },
    getLastExtractionStatus: () => conversationWorkspace.lastExtractionStatus,
    setLastExtractionStatus: (value) => { conversationWorkspace.lastExtractionStatus = value; },
    getLastVectorStatus: () => conversationWorkspace.lastVectorStatus,
    setLastVectorStatus: (value) => { conversationWorkspace.lastVectorStatus = value; },
    getLastRecallStatus: () => conversationWorkspace.lastRecallStatus,
    setLastRecallStatus: (value) => { conversationWorkspace.lastRecallStatus = value; },
    getPreferredGraphLocalStorePresentationSync,
    getRequestHeaders,
    getSettings,
    isAuthorityGraphStorePresentation,
    isAuthorityJobTypeSupported,
    isAuthorityVectorConfig,
    isGraphEffectivelyEmpty,
    isGraphLoadStateDbReady,
    isGraphMetadataWriteAllowed,
    isIndexedDbSnapshotMeaningful,
    isLukerPrimaryPersistenceHost,
    loadGraphFromLukerSidecarV2,
    loadGraphFromChat,
    loadGraphFromIndexedDb,
    normalizeIndexedDbRevision,
    normalizeAuthorityCapabilityState,
    normalizeAuthorityJobConfig,
    normalizeAuthoritySettings,
    normalizeChatIdCandidate,
    normalizeGraphRuntimeState,
    persistGraphToChatMetadata,
    persistGraphToConfiguredDurableTier,
    queueGraphPersist,
    queueGraphPersistToIndexedDb,
    readCachedIndexedDbSnapshot,
    recordLocalPersistEarlyFailure,
    recordAuthorityBlobSnapshot,
    recordPersistMismatchDiagnostic,
    refreshPanelLiveState,
    refreshRuntimeGraphAfterSyncApplied,
    rememberResolvedGraphIdentityAlias,
    resolveCompatibleGraphShadowSnapshot,
    resolveCurrentChatIdentity,
    resolveCurrentChatStateTarget,
    resolvePersistRevisionFloor,
    resolvePersistenceChatId,
    resolvePreferredGraphLocalStorePresentation,
    resolveSnapshotGraphStorePresentation,
    restoreRecallUiStateFromPersistence,
    runAuthorityConsistencyAudit,
    scheduleBmeIndexedDbTask,
    scheduleGraphChatStateProbe,
    scheduleIndexedDbGraphProbe,
    schedulePersistedRecallMessageUiRefresh,
    shouldPreferShadowSnapshotOverOfficial,
    shouldSyncGraphLoadFromLiveContext,
    shouldUseAuthorityBlobCheckpoint,
    shouldUseAuthorityGraphStore,
    stampGraphPersistenceMeta,
    syncCommitMarkerToPersistenceState,
    updateGraphPersistenceState,
    toastr,
    writeAuthorityLukerCheckpointBlob,
    writeGraphShadowSnapshot,
  };
}

function createGraphPersistenceIoRuntime() {
  return {
    AUTHORITY_GRAPH_STORE_KIND,
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET,
    GRAPH_LOAD_STATES,
    applyAcceptedPendingPersistState,
    applyGraphLoadState,
    applyIndexedDbEmptyToRuntime,
    applyIndexedDbSnapshotToRuntime,
    applyPersistDeltaToSnapshot,
    applyShadowSnapshotToRuntime,
    areChatIdsEquivalentForResolvedIdentity,
    buildBmeSyncRuntimeOptions,
    buildGraphLocalStoreSelectorKey,
    buildGraphPersistResult,
    buildPersistDelta,
    buildPersistDeltaFromGraphDirtyState,
    buildPersistObservabilitySummary,
    buildPersistenceEnvironment,
    buildSnapshotFromGraph,
    bmeIndexedDbLatestQueuedRevisionByChatId,
    bmeIndexedDbWriteInFlightByChatId,
    cacheIndexedDbSnapshot,
    canPersistGraphToMetadataFallback,
    clearPendingGraphPersistRetry,
    cloneGraphForPersistence,
    cloneRuntimeDebugValue,
    console,
    createShadowComparisonGraph,
    detectIndexedDbSnapshotCommitMarkerMismatch,
    detectStaleIndexedDbSnapshotAgainstRuntime,
    ensureConversationRepository,
    ensureCurrentGraphRuntimeState,
    evaluateNativeHydrateGate,
    evaluatePersistNativeDeltaGate,
    getChatMetadataIntegrity,
    getContext,
    getCurrentChatId,
    getCurrentGraph: () => conversationWorkspace.graph,
    getGraphPersistedRevision,
    getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
    getNativeHydrateInstallPromise: () => nativeHydrateInstallPromise,
    getNativePersistDeltaInstallPromise: () => nativePersistDeltaInstallPromise,
    getPreferredGraphLocalStorePresentationSync,
    getRequestedGraphLocalStorageMode,
    getSettings,
    hasMeaningfulRuntimeGraphForChat,
    importNativeCore: () => import("./vendor/wasm/stbme_core.js"),
    isAuthorityGraphStorePresentation,
    isGraphLocalStorageModeOpfs,
    isIndexedDbSnapshotMeaningful,
    isRestoreLockActive,
    maybeCaptureGraphShadowSnapshot,
    maybeClearAcceptedPendingPersistState,
    maybeFlushQueuedGraphPersist,
    maybeImportLegacyIndexedDbSnapshotToLocalStore,
    maybeImportLegacyOpfsSnapshotToLocalStore,
    maybeMigrateLegacyGraphToIndexedDb,
    maybeRecoverIndexedDbGraphFromStableIdentity,
    maybeResolveOrphanAcceptedCommitMarker,
    maybeResumePendingAutoExtraction,
    normalizeChatIdCandidate,
    normalizeGraphRuntimeState,
    normalizeIndexedDbRevision,
    normalizeLoadDiagnosticsMs,
    normalizePersistDeltaDiagnosticsMs,
    persistGraphToChatMetadata,
    persistGraphToConfiguredDurableTier,
    pruneGraphPersistDirtyState,
    queueGraphPersist,
    queueRuntimeGraphLocalStoreRepair,
    readCachedIndexedDbSnapshot,
    readLoadDiagnosticsNow,
    readLocalStoreDiagnosticsSync,
    readPersistDeltaDiagnosticsNow,
    recordLocalPersistEarlyFailure,
    recordPersistMismatchDiagnostic,
    refreshCurrentChatLocalStoreBinding,
    rememberResolvedGraphIdentityAlias,
    resolveCompatibleGraphShadowSnapshot,
    resolveCurrentChatIdentity,
    resolveDbGraphStorePresentation,
    resolveLocalStoreTierFromPresentation,
    resolvePendingPersistGraphSource,
    resolvePendingPersistLastProcessedAssistantFloor,
    resolvePersistRevisionFloor,
    resolveSnapshotGraphStorePresentation,
    schedulePendingGraphPersistRetry,
    scheduleUpload,
    setCurrentGraph: (nextGraph) => { conversationWorkspace.graph = nextGraph; },
    setGraphPersistenceState: (nextStateOrPatch = {}) => {
      conversationWorkspace.graphPersistenceState = {
        ...conversationWorkspace.graphPersistenceState,
        ...(nextStateOrPatch || {}),
      };
      syncGraphPersistenceDebugState();
      return conversationWorkspace.graphPersistenceState;
    },
    setNativeHydrateInstallPromise: (promise) => { nativeHydrateInstallPromise = promise; },
    setNativePersistDeltaInstallPromise: (promise) => { nativePersistDeltaInstallPromise = promise; },
    shouldPreferShadowSnapshotOverOfficial,
    stampGraphPersistenceMeta,
    syncCommitMarkerToPersistenceState,
    updateGraphPersistenceState,
    updateLoadDiagnostics,
    updatePersistDeltaDiagnostics,
  };
}
let serverSettingsSaveTimer = null;
let lastRecallFallbackNoticeAt = 0;
let lastExtractionWarningAt = 0;
const LOCAL_VECTOR_TIMEOUT_MS = 300000;
const EXTRACTION_VECTOR_SYNC_TIMEOUT_MS = 300000;
const STATUS_TOAST_THROTTLE_MS = 1500;
const STAGE_NOTICE_USER_DISMISS_COOLDOWN_MS = 5 * 60 * 1000;
const RECALL_INPUT_RECORD_TTL_MS = 60000;
const TRIVIAL_GENERATION_SKIP_TTL_MS = 60000;
const GENERATION_RECALL_TRANSACTION_TTL_MS = 15000;
const PLANNER_RECALL_HANDOFF_TTL_MS = GENERATION_RECALL_TRANSACTION_TTL_MS;
const GENERATION_RECALL_HOOK_BRIDGE_MS = 1200;
const HISTORY_RECOVERY_SETTLE_MS = 80;
const HISTORY_MUTATION_RETRY_DELAYS_MS = [80, 220, 500, 900];
const GRAPH_LOAD_RETRY_DELAYS_MS = [120, 450, 1200, 2500];
const AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS = [120, 320, 800, 1600, 2800];
const AUTO_EXTRACTION_HOST_SETTLE_MS = 120;
const AUTHORITY_RECENT_JOBS_LIMIT = 8;
function createInitialUiStatus(kind = "runtime") {
  const metaKey = kind === "extraction"
    ? "status.initial.extraction.detail"
    : kind === "vector"
      ? "status.initial.vector.detail"
      : kind === "recall"
        ? "status.initial.recall.detail"
        : "status.initial.runtime.detail";
  const metaFallback = kind === "extraction"
    ? "尚未执行提取"
    : kind === "vector"
      ? "尚未执行向量任务"
      : kind === "recall"
        ? "尚未执行召回"
        : "准备就绪";
  return createUiStatus({
    textKey: "status.idle",
    textFallback: "待命",
    metaKey,
    metaFallback,
    level: "idle",
  });
}
let authorityCapabilityState = createDefaultAuthorityCapabilityState();
let authorityBrowserState = createAuthorityBrowserState();
let authorityProbePromise = null;
const backgroundMaintenanceQueue =
  typeof createBackgroundMaintenanceQueue === "function"
    ? createBackgroundMaintenanceQueue()
    : null;
const backgroundVectorSyncCoalescer =
  typeof createImportedVectorSyncCoalescer === "function"
    ? createImportedVectorSyncCoalescer()
    : {
        clear() {},
        getActive() {
          return null;
        },
        getPending() {
          return null;
        },
        enqueue(task = {}) {
          return {
            scheduled: true,
            coalesced: false,
            task: {
              ...(task || {}),
              stale: false,
            },
          };
        },
        start(task = null) {
          return Boolean(task && !task.stale);
        },
        complete() {
          return true;
        },
        drop(task = null) {
          if (task) task.stale = true;
          return Boolean(task);
        },
        isStale(task = null, chatId = "") {
          return Boolean(
            !task ||
              task.stale ||
              (chatId && task.chatId && String(chatId) !== String(task.chatId)),
          );
        },
      };
const lastStatusToastAt = {};
const dismissedStageNoticeSignatures = new Map();
const conversationSession = createConversationSession({
  rerollInferenceWindowMs: GENERATION_RECALL_TRANSACTION_TTL_MS,
});
const conversationWorkspace = createConversationWorkspace({
  session: conversationSession,
  createPersistenceState: createGraphPersistenceState,
  createStatus: createInitialUiStatus,
  clearTimeout,
});
conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
  reason: "runtime-init",
});
function isConversationTargetCurrent(
  chatId,
  lease,
  chatStateTarget = null,
) {
  if (
    !conversationWorkspace.isLeaseCurrent(lease, {
      requireGeneration: false,
    })
  ) {
    return false;
  }
  const activeContext = getContext();
  const activeTargetKey = serializeBmeChatStateTarget(
    resolveCurrentChatStateTarget(activeContext),
  );
  const targetKey = serializeBmeChatStateTarget(chatStateTarget);
  if (targetKey && activeTargetKey !== targetKey) return false;
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(activeContext));
  const identity = resolveCurrentChatIdentity(activeContext);
  return Boolean(
    normalizedChatId &&
      activeChatId &&
      (areChatIdsEquivalentForResolvedIdentity(
        normalizedChatId,
        activeChatId,
        identity,
      ) ||
        areChatIdsEquivalentForResolvedIdentity(
          activeChatId,
          normalizedChatId,
          identity,
        )),
  );
}
const readConversationInput = (name) =>
  conversationSession.getInput(name) || createRecallInputRecord();
const writeConversationInput = (name, record) =>
  conversationSession.setInput(name, record || createRecallInputRecord());
const recallInputState = createRecallInputState({
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
  recordMessageTraceSnapshot: (patch) => recordMessageTraceSnapshot(patch),
  setLastRecallSentUserMessage: (record) =>
    writeConversationInput("lastRecallSentUserMessage", record),
  setPendingHostGenerationInputSnapshot: (record) =>
    writeConversationInput("pendingHostGenerationInputSnapshot", record),
  setPendingRecallSendIntent: (record) =>
    writeConversationInput("pendingRecallSendIntent", record),
  setCurrentGenerationTrivialSkip: (record) =>
    conversationSession.setTrivialSkip(record),
  clearPlannerTurnHandoffsForChat: (...args) =>
    clearPlannerTurnHandoffsForChat(...args),
  TRIVIAL_GENERATION_SKIP_TTL_MS,
});
const rerollRecallInput = createRerollRecallInput({
  clearPendingHostGenerationInputSnapshot: (...args) =>
    clearPendingHostGenerationInputSnapshot(...args),
  clearPendingRecallSendIntent: (...args) => clearPendingRecallSendIntent(...args),
  console,
  createTrivialRecallSkipSentinel: (...args) =>
    createTrivialRecallSkipSentinel(...args),
  findLatestUserChatMessageWithIndex: (...args) =>
    findLatestUserChatMessageWithIndex(...args),
  formatInjection: (...args) => formatInjection(...args),
  getContext,
  getCurrentChatId,
  getCurrentGenerationTrivialSkip: (...args) =>
    getCurrentGenerationTrivialSkip(...args),
  getLastNonSystemChatMessage: (...args) => getLastNonSystemChatMessage(...args),
  getLastRecallSentUserMessage: () =>
    readConversationInput("lastRecallSentUserMessage"),
  getLatestUserChatMessage: (...args) => getLatestUserChatMessage(...args),
  getPendingRecallSendIntent: () =>
    readConversationInput("pendingRecallSendIntent"),
  getSchema: (...args) => getSchema(...args),
  getSendTextareaValue: (...args) => getSendTextareaValue(...args),
  hashRecallInput,
  isFreshRecallInputRecord,
  isTrivialUserInput: (...args) => isTrivialUserInput(...args),
  markCurrentGenerationTrivialSkip: (...args) =>
    markCurrentGenerationTrivialSkip(...args),
  normalizeChatIdCandidate,
  normalizeRecallInputText,
  readPersistedRecallFromUserMessage: (...args) =>
    readPersistedRecallFromUserMessage(...args),
  resolveGenerationTargetUserMessageIndex: (...args) =>
    resolveGenerationTargetUserMessageIndex(...args),
  GENERATION_RECALL_TRANSACTION_TTL_MS,
  PLANNER_RECALL_HANDOFF_TTL_MS,
});
let coreEventBindingState = {
  registered: false,
  cleanups: [],
  registeredAt: 0,
};
let sendIntentHookCleanup = [];
let sendIntentHookRetryTimer = null;
let pendingGraphPersistRetryTimer = null;
let pendingGraphPersistRetryChatId = "";
let pendingGraphPersistRetryAttempt = 0;
let authorityJobPollAbortController = null;
let authorityJobPollJobId = "";
let authorityJobPollChatId = "";
let authorityJobPollPromise = null;
let enaPlannerApi = null;
const generationRecallTransactionRuntime = createGenerationRecallTransactions({
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
    getRecallUserMessageSourceLabel(...args),
  getSettings,
  hashRecallInput,
  normalizeChatIdCandidate,
  normalizeRecallInputText,
  clearPlannerTurnHandoffsForChat: (...args) =>
    clearPlannerTurnHandoffsForChat(...args),
  markPlannerTurnHandoffMatched: (...args) =>
    rerollRecallInput.markPlannerTurnHandoffMatched(...args),
  peekPlannerTurnHandoff: (...args) => peekPlannerTurnHandoff(...args),
  resolveGenerationTargetUserMessageIndex: (...args) =>
    resolveGenerationTargetUserMessageIndex(...args),
  shouldRunRecallForTransaction,
});
const finalRecallInjectionRuntime = createFinalRecallInjection({
  applyModuleInjectionPrompt: (...args) => applyModuleInjectionPrompt(...args),
  areRecallNodeIdListsEqual: (...args) => areRecallNodeIdListsEqual(...args),
  buildPersistedRecallRecord,
  bumpPersistedRecallGenerationCount: (...args) =>
    bumpPersistedRecallGenerationCount(...args),
  clearLiveRecallInjectionPromptForRewrite: (...args) =>
    clearLiveRecallInjectionPromptForRewrite(...args),
  createUiStatus,
  debugPersistedRecallPersistence: (...args) =>
    debugPersistedRecallPersistence(...args),
  estimateTokens,
  getContext,
  getGenerationRecallTransactionResult: (...args) =>
    getGenerationRecallTransactionResult(...args),
  getLastInjectionContent: () => conversationWorkspace.lastInjectionContent,
  getLastRecallSentUserMessage: () =>
    readConversationInput("lastRecallSentUserMessage"),
  getRuntimeStatus: () => conversationWorkspace.runtimeStatus,
  getSettings,
  normalizeRecallInputText,
  normalizeRecallNodeIdList: (...args) => normalizeRecallNodeIdList(...args),
  readGenerationRecallTransactionFinalResolution: (...args) =>
    readGenerationRecallTransactionFinalResolution(...args),
  readPersistedRecallFromUserMessage,
  recordInjectionSnapshot: (...args) => recordInjectionSnapshot(...args),
  refreshPanelLiveState: (...args) => refreshPanelLiveState(...args),
  resolveFinalRecallInjectionSource,
  resolveGenerationRecallDeliveryMode: (...args) =>
    resolveGenerationRecallDeliveryMode(...args),
  resolveGenerationTargetUserMessageIndex: (...args) =>
    resolveGenerationTargetUserMessageIndex(...args),
  resolveRecallPersistenceTargetUserMessageIndex: (...args) =>
    resolveRecallPersistenceTargetUserMessageIndex(...args),
  schedulePersistedRecallMessageUiRefresh: (...args) =>
    schedulePersistedRecallMessageUiRefresh(...args),
  setLastInjectionContent: (value = "") => {
    conversationWorkspace.lastInjectionContent = String(value || "");
  },
  setRuntimeStatus: (status) => {
    conversationWorkspace.runtimeStatus = status;
  },
  storeGenerationRecallTransactionFinalResolution: (...args) =>
    storeGenerationRecallTransactionFinalResolution(...args),
  triggerChatMetadataSave,
  writePersistedRecallToUserMessage,
});
const autoExtractionDeferRuntime = createAutoExtractionDefer({
  clearTimeout,
  cloneRuntimeDebugValue: (...args) => cloneRuntimeDebugValue(...args),
  console,
  ensureGraphMutationReady: (...args) => ensureGraphMutationReady(...args),
  getContext,
  getCurrentChatId,
  getCurrentGraph: () => conversationWorkspace.graph,
  getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
  getIsExtracting: () => conversationWorkspace.isExtracting,
  getIsHostGenerationRunning: () => conversationWorkspace.hostGeneration.running,
  getIsRecoveringHistory: () => conversationWorkspace.isRecoveringHistory,
  getLastHostGenerationEndedAt: () => conversationWorkspace.hostGeneration.endedAt,
  getSettings,
  isAssistantChatMessage: (...args) => isAssistantChatMessage(...args),
  isRestoreLockActive: (...args) => isRestoreLockActive(...args),
  normalizeChatIdCandidate,
  normalizeRestoreLockState: (...args) => normalizeRestoreLockState(...args),
  notifyExtractionIssue: (...args) => notifyExtractionIssue(...args),
  resolveAutoExtractionPlan: (...args) => resolveAutoExtractionPlan(...args),
  runExtraction: (...args) => runExtraction(...args),
  setTimeout,
  AUTO_EXTRACTION_DEFER_RETRY_DELAYS_MS,
  AUTO_EXTRACTION_HOST_SETTLE_MS,
});
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
const recallMessageUiController = createRecallMessageUiController({
  getContext,
  getSettings,
  getCurrentGraph: () => conversationWorkspace.graph,
  get document() {
    return getHostDocument();
  },
  get MutationObserver() {
    return getHostMutationObserver();
  },
  console,
  setTimeout,
  clearTimeout,
  toastr,
  estimateTokens,
  triggerChatMetadataSave,
  openRecallSidebar,
  readPersistedRecallFromUserMessage,
  removePersistedRecallFromUserMessage,
  writePersistedRecallToUserMessage,
  buildPersistedRecallRecord,
  markPersistedRecallManualEdit,
  createRecallCardElement,
  updateRecallCardData,
  normalizeRecallInputText,
  rerunRecallForMessage: (messageIndex) => rerunRecallForMessage(messageIndex),
  readStructuredPlotRecordFromMessage,
  PERSISTED_RECALL_UI_REFRESH_RETRY_DELAYS_MS,
  PERSISTED_RECALL_UI_DIAGNOSTIC_THROTTLE_MS,
});
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
let conversationRepository = null;
let conversationRepositoryUnavailableWarned = false;
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

function isGraphLoadStateDbReady(loadState = conversationWorkspace.graphPersistenceState.loadState) {
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
  const hasLukerApi = isLukerHostContext(activeContext);
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
        ? "none"
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
  const upgradeState =
    typeof deriveAuthorityUpgradeState === "function"
      ? deriveAuthorityUpgradeState({
          settings,
          capability,
          browserState,
        })
      : {
          mode: capability?.serverPrimaryReady
            ? "authority-enhanced"
            : capability?.installed
              ? "authority-degraded"
              : "standalone",
          text: capability?.serverPrimaryReady
            ? "服务端增强已启用"
            : capability?.installed
              ? "已自动回退"
              : "纯前端模式",
          meta: capability?.serverPrimaryReady
            ? "图谱与向量存储已自动升级到 DOA/Authority 增强路径"
            : capability?.installed
              ? `服务端增强暂不可用：${String(capability?.reason || capability?.lastError || "unknown")}`
              : "未检测到 DOA/Authority，已自动使用本地稳定路径",
          level: capability?.serverPrimaryReady
            ? "success"
            : capability?.installed
              ? "warning"
              : "idle",
          ready: Boolean(capability?.serverPrimaryReady),
        };
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
    authorityBmeProtocolVersion: Math.max(0, Number(capability.bmeProtocolVersion) || 0),
    authorityBmeVectorManifestReady: Boolean(capability.bmeVectorManifestReady),
    authorityBmeVectorApplyReady: Boolean(capability.bmeVectorApplyReady),
    authorityBmeVectorApplyJobsReady: Boolean(capability.bmeVectorApplyJobsReady),
    authorityBmeServerEmbeddingProbeReady: Boolean(capability.bmeServerEmbeddingProbeReady),
    authorityBmeCandidateSearchReady: Boolean(capability.bmeCandidateSearchReady),
    authorityBrowserCacheMode: String(browserState.mode || "minimal"),
    authorityOfflineQueueBytes: Number(browserState.offlineQueueBytes || 0),
    authorityOfflineQueueItems: Number(browserState.offlineQueueItems || 0),
    authorityDegradedReason: capability.serverPrimaryReady
      ? ""
      : String(capability.reason || capability.lastError || ""),
    authorityUpgradeState: cloneRuntimeDebugValue(upgradeState, null),
    authorityUpgradeMode: String(upgradeState.mode || "standalone"),
    authorityUpgradeText: String(upgradeState.text || "纯前端模式"),
    authorityUpgradeMeta: String(upgradeState.meta || ""),
    authorityUpgradeLevel: String(upgradeState.level || "idle"),
    authorityUpgradeReady: Boolean(upgradeState.ready),
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

  const hostWindow = getHostWindow();
  const allowRelativeUrl =
    Boolean(hostWindow?.location) && typeof hostWindow.location.href === "string";
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
  return getGraphPersistenceLiveStateImpl(
    createGraphMutationGateRuntime(),
  );
}

function syncGraphPersistenceDebugState() {
  recordGraphPersistenceSnapshot(getGraphPersistenceLiveState());
}

function updateGraphPersistenceState(patch = {}) {
  conversationWorkspace.graphPersistenceState = {
    ...conversationWorkspace.graphPersistenceState,
    ...(patch || {}),
    updatedAt: new Date().toISOString(),
  };
  syncGraphPersistenceDebugState();
  return conversationWorkspace.graphPersistenceState;
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

function normalizeAuthorityJobType(kind = "") {
  return String(kind || "").trim().toLowerCase();
}

function shouldUseAuthorityJobs(config = null, kind = AUTHORITY_VECTOR_REBUILD_JOB_TYPE) {
  return shouldUseAuthorityJobsImpl(
    createGraphLoadPersistRuntime(),
    config, kind,
  );
}

function isAuthorityJobTypeSupported(capability = {}, kind = "") {
  if (!capability?.supportedJobTypesKnown) return true;
  const normalizedKind = normalizeAuthorityJobType(kind);
  if (!normalizedKind) return true;
  return Array.isArray(capability.supportedJobTypes) && capability.supportedJobTypes.includes(normalizedKind);
}

function mergeAuthorityRecentJobsIntoState(incomingJobs = [], options = {}) {
  const updatedAt = String(options.updatedAt || new Date().toISOString());
  const nextRecentJobs = mergeAuthorityRecentJobs(
    options.replace === true ? [] : conversationWorkspace.graphPersistenceState.authorityRecentJobs,
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
        : String(conversationWorkspace.graphPersistenceState.authorityRecentJobsError || ""),
    authorityRecentJobsNextCursor:
      options.nextCursor !== undefined
        ? String(options.nextCursor || "")
        : String(conversationWorkspace.graphPersistenceState.authorityRecentJobsNextCursor || ""),
    authorityRecentJobsHasMore:
      options.hasMore !== undefined
        ? Boolean(options.hasMore)
        : Boolean(conversationWorkspace.graphPersistenceState.authorityRecentJobsHasMore),
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
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
            conversationWorkspace.graphPersistenceState.authorityRecentJobs,
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
            : String(conversationWorkspace.graphPersistenceState.authorityRecentJobsError || ""),
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
      normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId),
    graphPersistence: liveGraphPersistence,
    graph: conversationWorkspace.graph,
    consistencyAudit: liveGraphPersistence.authorityConsistencyAudit,
  });
}

function captureAuthorityPerformanceBaseline(options = {}) {
  const previousBaseline =
    conversationWorkspace.graphPersistenceState.authorityPerformanceBaseline &&
    typeof conversationWorkspace.graphPersistenceState.authorityPerformanceBaseline === "object" &&
    !Array.isArray(conversationWorkspace.graphPersistenceState.authorityPerformanceBaseline)
      ? conversationWorkspace.graphPersistenceState.authorityPerformanceBaseline
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
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
    graph: conversationWorkspace.graph,
    consistencyAudit: liveGraphPersistence.authorityConsistencyAudit,
  });
  const baselineComparison = buildAuthorityPerformanceBaselineComparison(previousBaseline, baseline);
  const bundle = buildAuthorityDiagnosticsBundle({
    chatId,
    reason,
    settings,
    runtimeStatus: conversationWorkspace.runtimeStatus,
    runtimeDebug: readRuntimeDebugSnapshot(),
    graphPersistence: {
      ...liveGraphPersistence,
      authorityPerformanceBaseline: cloneRuntimeDebugValue(baseline, null),
      authorityPerformanceBaselineUpdatedAt: String(baseline?.capturedAt || ""),
      authorityPerformanceBaselineReason: reason,
    },
    graph: conversationWorkspace.graph,
    lastExtractionStatus: conversationWorkspace.lastExtractionStatus,
    lastVectorStatus: conversationWorkspace.lastVectorStatus,
    lastRecallStatus: conversationWorkspace.lastRecallStatus,
    lastBatchStatus: cloneRuntimeDebugValue(conversationWorkspace.graph?.historyState?.lastBatchStatus, null),
    lastInjection: conversationWorkspace.lastInjectionContent,
    lastExtract: conversationWorkspace.lastExtractedItems,
    lastRecall: conversationWorkspace.lastRecalledItems,
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
      ...((Array.isArray(conversationWorkspace.graphPersistenceState.authorityDiagnosticsArtifacts)
        ? conversationWorkspace.graphPersistenceState.authorityDiagnosticsArtifacts
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
        Number(retentionResult?.count || 0) > 0 ? updatedAt : String(conversationWorkspace.graphPersistenceState.authorityDiagnosticsLastPrunedAt || ""),
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
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
      String(conversationWorkspace.graphPersistenceState.authorityDiagnosticsBundlePath || "") === normalizedPath;
    const nextArtifactEntries = manifestResult?.entries ||
      (Array.isArray(conversationWorkspace.graphPersistenceState.authorityDiagnosticsArtifacts)
        ? conversationWorkspace.graphPersistenceState.authorityDiagnosticsArtifacts
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
      authorityDiagnosticsBundlePath: wasLatestArtifact ? "" : conversationWorkspace.graphPersistenceState.authorityDiagnosticsBundlePath,
      authorityDiagnosticsBundleReason: wasLatestArtifact ? "" : conversationWorkspace.graphPersistenceState.authorityDiagnosticsBundleReason,
      authorityDiagnosticsBundleUpdatedAt: wasLatestArtifact ? "" : conversationWorkspace.graphPersistenceState.authorityDiagnosticsBundleUpdatedAt,
      authorityDiagnosticsBundleSize: wasLatestArtifact ? 0 : conversationWorkspace.graphPersistenceState.authorityDiagnosticsBundleSize,
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
  const publicationLease = conversationWorkspace.captureLease();
  const canPublishResult = () =>
    isConversationTargetCurrent(normalizedChatId, publicationLease);
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
    if (canPublishResult()) {
      recordAuthorityBlobSnapshot(event);
      updateGraphPersistenceState({
        authorityBlobCheckpointPath: event.path,
        authorityBlobCheckpointRevision: event.revision,
        authorityBlobCheckpointUpdatedAt: new Date().toISOString(),
      });
    }
    return {
      ok: event.ok,
      path: event.path,
      result,
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Blob checkpoint failed";
    if (canPublishResult()) {
      recordAuthorityBlobSnapshot({
        action: "checkpoint-write",
        ok: false,
        backend: "authority-blob",
        path,
        reason: String(reason || ""),
        error: message,
        revision: Number(checkpoint?.revision || 0),
      });
    }
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
  const publicationLease = conversationWorkspace.captureLease();
  const canPublishResult = () =>
    isConversationTargetCurrent(normalizedChatId, publicationLease);
  const safeChatId = buildAuthorityBlobSafeSlug(normalizedChatId);
  const hash = buildAuthorityBlobFileHash(normalizedChatId || safeChatId);
  const path = `user/files/ST-BME_luker_checkpoint_${safeChatId}-${hash}.json`;
  try {
    const adapter = getAuthorityBlobAdapter();
    const result = await adapter.readJson(path, options);
    const exists = Boolean(result?.exists && result?.payload);
    if (canPublishResult()) {
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
    }
    return {
      ok: result?.ok !== false,
      exists,
      path: result?.path || path,
      checkpoint: exists ? result.payload : null,
      result,
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Blob checkpoint read failed";
    if (canPublishResult()) {
      recordAuthorityBlobSnapshot({
        action: "checkpoint-read",
        ok: false,
        backend: "authority-blob",
        path,
        reason: "authority-blob-checkpoint-read-error",
        error: message,
      });
    }
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

async function exportAuthoritySqlSnapshotForCheckpoint(chatId = "", settings = getSettings()) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) return null;
  const db = new AuthorityGraphStore(
    normalizedChatId,
    buildAuthorityGraphStoreOptions(settings),
  );
  try {
    await db.open();
    return await db.exportSnapshot({ includeTombstones: false });
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
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
      normalizeChatIdCandidate(conversationWorkspace.graph?.vectorIndexState?.collectionId) ||
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
      runtimeGraph: conversationWorkspace.graph,
      graphPersistenceState: conversationWorkspace.graphPersistenceState,
      sqlSnapshot: sqlProbe.value,
      sqlError: sqlProbe.error,
      triviumStat: triviumProbe.value,
      triviumError: triviumProbe.error,
      blobResult: blobProbe.value,
      blobError: blobProbe.error,
      lastJob: conversationWorkspace.graphPersistenceState.authorityLastJob,
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
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
  return await writeAuthorityCheckpointFromCurrentGraphImpl(
    createGraphLoadPersistRuntime(),
    options,
  );
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
  if (!range && options.useJobs !== false && shouldUseAuthorityJobs(vectorConfig, AUTHORITY_VECTOR_REBUILD_JOB_TYPE)) {
    const jobResult = await submitAuthorityVectorRebuildJob({
      config: vectorConfig,
      range,
      purge: options.purge !== false,
      signal: options.signal,
    });
    if (jobResult?.stale) {
      return {
        success: jobResult.submitted === true,
        submitted: jobResult.submitted === true,
        stale: true,
        terminal: false,
        mode: "job",
        job: jobResult.job || null,
        error: jobResult.error || "",
      };
    }
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
        stats: fallbackResult?.stats || getVectorIndexStats(conversationWorkspace.graph),
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
    stats: result?.stats || getVectorIndexStats(conversationWorkspace.graph),
  };
}

async function runAuthorityConsistencyRepairPlan(options = {}) {
  const updatedAt = new Date().toISOString();
  const chatId = normalizeChatIdCandidate(
    options.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
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
      : conversationWorkspace.graphPersistenceState.authorityConsistencyAudit &&
          typeof conversationWorkspace.graphPersistenceState.authorityConsistencyAudit === "object" &&
          !Array.isArray(conversationWorkspace.graphPersistenceState.authorityConsistencyAudit)
        ? conversationWorkspace.graphPersistenceState.authorityConsistencyAudit
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
    let nonBlockingFailureCount = 0;
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
        const canContinueAfterFailure = isAuthorityReplicaSyncRepairAction(latestStep?.action);
        if (canContinueAfterFailure) {
          nonBlockingFailureCount += 1;
          continue;
        }
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
    const successStepCount = stepResults.filter((step) => step?.success).length;
    const failedStepCount = stepResults.filter((step) => !step?.success).length;
    const partialFailure = failedStepCount > 0 && successStepCount > 0;
    const allFailed = failedStepCount > 0 && successStepCount === 0 && !handoffRequired;
    const outcome = allFailed
      ? "error"
      : handoffRequired
        ? partialFailure ? "warning" : "running"
        : partialFailure
          ? "warning"
          : "success";
    const repairResult = {
      plan,
      steps: stepResults,
      auditSummary: audit.summary || null,
      handoffRequired,
      outcome,
      partialFailure,
      failedStepCount,
      nonBlockingFailureCount,
      finalAuditSummary: finalAuditResult?.audit?.summary || null,
      finalAuditDrift: finalAuditResult?.audit?.drift || null,
    };
    updateGraphPersistenceState({
      authorityRepairState: outcome,
      authorityRepairUpdatedAt: finishedAt,
      authorityRepairError: allFailed
        ? stepResults.find((step) => !step?.success)?.error || "Authority 副本同步失败"
        : partialFailure
          ? "部分副本同步失败；已继续执行其它可独立同步步骤"
          : "",
      authorityRepairResult: cloneRuntimeDebugValue(repairResult, null),
    });
    refreshPanelLiveState();
    return {
      success: !allFailed,
      outcome,
      partialFailure,
      error: allFailed ? stepResults.find((step) => !step?.success)?.error || "Authority 副本同步失败" : "",
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
  const kind = range
    ? AUTHORITY_VECTOR_REBUILD_RANGE_JOB_TYPE
    : AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const { capability } = getAuthorityRuntimeSnapshot(getSettings());
  if (!shouldUseAuthorityJobs(vectorConfig, kind)) {
    if (!isAuthorityJobTypeSupported(capability, kind)) {
      const message = `Authority Job type ${kind} is not supported by this Authority runtime`;
      return {
        submitted: false,
        fallbackRequired: true,
        reason: "authority-job-type-unsupported",
        error: message,
      };
    }
    return {
      submitted: false,
      fallbackRequired: true,
      reason: "authority-jobs-unavailable",
    };
  }

  ensureCurrentGraphRuntimeState();
  const chatId = getCurrentChatId();
  const taskGraph = conversationWorkspace.graph;
  const conversationLease = conversationWorkspace.captureLease();
  const isTaskCurrent = () =>
    conversationWorkspace.graph === taskGraph &&
    conversationWorkspace.isLeaseCurrent(conversationLease, {
      requireGeneration: false,
    });
  const collectionId =
    taskGraph?.vectorIndexState?.collectionId || buildVectorCollectionId(chatId);
  const idempotencyKey = buildAuthorityJobIdempotencyKey({
    kind,
    chatId,
    collectionId,
    revision:
      taskGraph?.meta?.revision ||
      taskGraph?.historyState?.extractionCount ||
      conversationWorkspace.graphPersistenceState?.revision ||
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
      taskGraph?.meta?.revision || conversationWorkspace.graphPersistenceState?.revision || 0,
    idempotencyKey,
  };

  try {
    const adapter = getAuthorityJobAdapter();
    const job = await adapter.submit(kind, payload, {
      idempotencyKey,
      signal,
    });
    if (!isTaskCurrent()) {
      return {
        submitted: true,
        fallbackRequired: false,
        stale: true,
        job,
        stats: getVectorIndexStats(taskGraph),
        insertedHashes: [],
      };
    }
    recordAuthorityJobSnapshot(job, { kind, queueState: "running" });
    if (taskGraph?.vectorIndexState) {
      taskGraph.vectorIndexState.dirty = true;
      taskGraph.vectorIndexState.dirtyReason = "authority-vector-rebuild-job-submitted";
      taskGraph.vectorIndexState.lastWarning =
        "Authority 向量重建 Job 已提交，等待服务端完成";
      taskGraph.vectorIndexState.lastRebuildJob =
        cloneRuntimeDebugValue(job, null);
    }
    setLastVectorStatus(
      "向量重建 Job 已提交",
      `${kind} · ${job.id || "pending"} · ${job.status || "queued"}`,
      "running",
      { syncRuntime: true },
    );
    void refreshAuthorityRecentJobs({ reason: "authority-job-submitted" });
    void startTrackingAuthorityJob(job, {
      kind,
      chatId,
      graph: taskGraph,
      lease: conversationLease,
    });
    return {
      submitted: true,
      fallbackRequired: false,
      job,
      stats: getVectorIndexStats(taskGraph),
      insertedHashes: [],
    };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Job 提交失败";
    if (!isTaskCurrent()) {
      return {
        submitted: false,
        fallbackRequired: false,
        stale: true,
        error: message,
      };
    }
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

function syncAuthorityVectorJobState(job = null, graph = conversationWorkspace.graph) {
  if (!graph?.vectorIndexState) return;
  const normalizedJob =
    job && typeof job === "object" && !Array.isArray(job) ? job : {};
  graph.vectorIndexState.lastRebuildJob =
    cloneRuntimeDebugValue(normalizedJob, null);
  graph.vectorIndexState.lastAuthorityJobId = String(normalizedJob.id || "");
  graph.vectorIndexState.lastAuthorityJobStatus = String(
    normalizedJob.status || "",
  );
  graph.vectorIndexState.lastAuthorityJobProgress = Number(
    normalizedJob.progress || 0,
  );
  if (!normalizedJob.id) {
    return;
  }
  if (normalizedJob.terminal) {
    if (normalizedJob.success) {
      graph.vectorIndexState.dirty = false;
      graph.vectorIndexState.dirtyReason = "";
      graph.vectorIndexState.lastWarning = "";
    } else {
      graph.vectorIndexState.dirty = true;
      graph.vectorIndexState.dirtyReason =
        String(normalizedJob.status || "failed") || "failed";
      graph.vectorIndexState.lastWarning =
        String(normalizedJob.error || normalizedJob.status || "Authority Job 失败") ||
        "Authority Job 失败";
    }
    return;
  }
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.dirtyReason =
    "authority-vector-rebuild-job-running";
  graph.vectorIndexState.lastWarning =
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
    normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId);
  if (!jobId || !trackedChatId) {
    return null;
  }
  const trackedGraph = options.graph || conversationWorkspace.graph;
  const trackedLease = options.lease || conversationWorkspace.captureLease();
  const isTrackedContextActive = () => {
    const context = getContext();
    const activeChatId =
      normalizeChatIdCandidate(getCurrentChatId(context)) ||
      normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId);
    const identity = resolveCurrentChatIdentity(context);
    return Boolean(
      conversationWorkspace.graph === trackedGraph &&
        conversationWorkspace.isLeaseCurrent(trackedLease, {
          requireGeneration: false,
        }) &&
        activeChatId &&
        (areChatIdsEquivalentForResolvedIdentity(
          trackedChatId,
          activeChatId,
          identity,
        ) ||
          areChatIdsEquivalentForResolvedIdentity(
            activeChatId,
            trackedChatId,
            identity,
          )),
    );
  };

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
    if (!isTrackedContextActive()) {
      controller.abort(createAbortTrackingError("authority-job-chat-changed"));
      return;
    }
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
    syncAuthorityVectorJobState(normalizedNextJob, trackedGraph);
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
      saveGraphToChat({
        reason: normalizedNextJob.success
          ? "authority-vector-rebuild-job-completed"
          : "authority-vector-rebuild-job-failed",
      });
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
      if (!isTrackedContextActive()) {
        controller.abort(createAbortTrackingError("authority-job-chat-changed"));
        throw controller.signal.reason;
      }
      const adapter = getAuthorityJobAdapter();
      return await adapter.get(targetJobId, { signal: controller.signal });
    },
    onUpdate: applyTrackedJobUpdate,
    onModeChange: async ({ mode, reason }) => {
      if (
        authorityJobPollAbortController !== controller ||
        !isTrackedContextActive()
      ) {
        return;
      }
      setAuthorityJobTrackingState(mode, reason);
      refreshPanelLiveState();
    },
  })
    .catch((error) => {
      if (isAbortError(error)) {
        if (
          authorityJobPollAbortController === controller &&
          isTrackedContextActive()
        ) {
          const abortReason = String(
            controller.signal?.reason?.message || controller.signal?.reason || "authority-job-tracking-stopped",
          );
          setAuthorityJobTrackingState("idle", abortReason);
          refreshPanelLiveState();
        }
        return null;
      }
      const message = error?.message || String(error) || "Authority Job 状态轮询失败";
      if (!isTrackedContextActive()) {
        return null;
      }
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
      syncAuthorityVectorJobState(failedJob, trackedGraph);
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
  const taskGraph = conversationWorkspace.graph;
  const chatId = getCurrentChatId();
  const lease = conversationWorkspace.captureLease();
  const isTaskCurrent = () =>
    conversationWorkspace.graph === taskGraph &&
    conversationWorkspace.isLeaseCurrent(lease, { requireGeneration: false });
  try {
    const adapter = getAuthorityJobAdapter();
    const job = await adapter.requeue(jobId, options);
    if (!isTaskCurrent()) {
      return { success: true, stale: true, job };
    }
    recordAuthorityJobSnapshot(job, { queueState: "running" });
    syncAuthorityVectorJobState(job, taskGraph);
    saveGraphToChat({ reason: "authority-vector-rebuild-job-requeued" });
    void refreshAuthorityRecentJobs({ reason: "authority-job-requeued" });
    void startTrackingAuthorityJob(job, {
      kind: job?.kind || conversationWorkspace.graphPersistenceState.authorityLastJobKind,
      chatId,
      graph: taskGraph,
      lease,
    });
    return { success: true, job };
  } catch (error) {
    const message = error?.message || String(error) || "Authority Job 重试失败";
    if (!isTaskCurrent()) {
      return { success: false, stale: true, error: message };
    }
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
      conversationWorkspace.graphPersistenceState.chatStateTarget ||
      resolveCurrentChatStateTarget(getContext()),
    lightweightHostMode:
      detail?.lightweightHostMode ??
      conversationWorkspace.graphPersistenceState.lightweightHostMode ??
      isBmeLightweightHostMode(getContext()),
  });
}

function updateLukerProjectionState(patch = {}) {
  const previous =
    conversationWorkspace.graphPersistenceState.projectionState &&
    typeof conversationWorkspace.graphPersistenceState.projectionState === "object" &&
    !Array.isArray(conversationWorkspace.graphPersistenceState.projectionState)
      ? conversationWorkspace.graphPersistenceState.projectionState
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
          ...(conversationWorkspace.graphPersistenceState.persistDelta &&
          typeof conversationWorkspace.graphPersistenceState.persistDelta === "object" &&
          !Array.isArray(conversationWorkspace.graphPersistenceState.persistDelta)
            ? cloneRuntimeDebugValue(conversationWorkspace.graphPersistenceState.persistDelta, {})
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
          ...(conversationWorkspace.graphPersistenceState.loadDiagnostics &&
          typeof conversationWorkspace.graphPersistenceState.loadDiagnostics === "object" &&
          !Array.isArray(conversationWorkspace.graphPersistenceState.loadDiagnostics)
            ? cloneRuntimeDebugValue(conversationWorkspace.graphPersistenceState.loadDiagnostics, {})
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
      conversationWorkspace.graphPersistenceState.revision || 0,
      conversationWorkspace.graphPersistenceState.lastPersistedRevision || 0,
      conversationWorkspace.graphPersistenceState.queuedPersistRevision || 0,
    ) + 1;
  updateGraphPersistenceState({
    revision: nextRevision,
    lastPersistReason: String(
      reason || conversationWorkspace.graphPersistenceState.lastPersistReason || "",
    ),
  });
  return nextRevision;
}

function isGraphMetadataWriteAllowed(
  loadState = conversationWorkspace.graphPersistenceState.loadState,
) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED
  );
}

function isGraphReadable(loadState = conversationWorkspace.graphPersistenceState.loadState) {
  return (
    loadState === GRAPH_LOAD_STATES.LOADED ||
    loadState === GRAPH_LOAD_STATES.EMPTY_CONFIRMED ||
    loadState === GRAPH_LOAD_STATES.SHADOW_RESTORED ||
    (loadState === GRAPH_LOAD_STATES.BLOCKED &&
      conversationWorkspace.graphPersistenceState.shadowSnapshotUsed)
  );
}

function hasReadableRuntimeGraphForRecall(chatId = getCurrentChatId()) {
  if (
    !conversationWorkspace.graph ||
    typeof conversationWorkspace.graph !== "object" ||
    !Array.isArray(conversationWorkspace.graph.nodes) ||
    !Array.isArray(conversationWorkspace.graph.edges) ||
    !conversationWorkspace.graph.historyState ||
    typeof conversationWorkspace.graph.historyState !== "object" ||
    Array.isArray(conversationWorkspace.graph.historyState)
  ) {
    return false;
  }

  const activeChatId = normalizeChatIdCandidate(chatId);
  const runtimeChatId = normalizeChatIdCandidate(
    conversationWorkspace.graph.historyState.chatId,
  );

  // chatId 匹配验证：如果两者都有，必须一致
  if (activeChatId && runtimeChatId) {
    return runtimeChatId === activeChatId;
  }

  // 兜底：chatId 不可用（ST 插件环境可能无法获取 chatId），
  // 只要 currentGraph 结构完整且有节点数据，就允许召回。
  // 这对应用户能在 UI 看到图谱，但 getCurrentChatId() 返回空的场景。
  return conversationWorkspace.graph.nodes.length > 0 || conversationWorkspace.graph.edges.length > 0;
}

function hasMeaningfulRuntimeGraphForChat(
  chatId = getCurrentChatId(),
  identity = resolveCurrentChatIdentity(getContext()),
) {
  if (
    !conversationWorkspace.graph ||
    typeof conversationWorkspace.graph !== "object" ||
    !Array.isArray(conversationWorkspace.graph.nodes) ||
    !Array.isArray(conversationWorkspace.graph.edges) ||
    !conversationWorkspace.graph.historyState ||
    typeof conversationWorkspace.graph.historyState !== "object" ||
    Array.isArray(conversationWorkspace.graph.historyState)
  ) {
    return false;
  }

  const normalizedTargetChatId = normalizeChatIdCandidate(chatId);
  const runtimeChatId = normalizeChatIdCandidate(
    conversationWorkspace.graph.historyState.chatId,
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

  return !isGraphEffectivelyEmpty(conversationWorkspace.graph);
}

function hasRuntimeGraphMutationContext(
  context = getContext(),
  graph = conversationWorkspace.graph,
  { allowNoChatState = false } = {},
) {
  if (
    !graph ||
    typeof graph !== "object" ||
    !graph.historyState ||
    typeof graph.historyState !== "object" ||
    Array.isArray(graph.historyState)
  ) {
    return false;
  }

  const identity = resolveCurrentChatIdentity(context);
  const graphOwnedChatId = getGraphOwnedChatId(graph);
  return canMutateRuntimeGraphForIdentityCore({
    graph,
    activeIdentity: identity,
    graphOwnedChatId,
    persistenceState: conversationWorkspace.graphPersistenceState,
    aliasCandidates: getGraphIdentityAliasCandidates({
      integrity: identity.integrity,
      hostChatId: identity.hostChatId,
      persistenceChatId: identity.chatId,
    }),
    loadedStates: [
      GRAPH_LOAD_STATES.LOADED,
      GRAPH_LOAD_STATES.EMPTY_CONFIRMED,
    ],
    allowNoChatState,
    noChatState: GRAPH_LOAD_STATES.NO_CHAT,
  });
}

function repairRuntimeGraphIdentityFromPersistence(
  operationLabel = "当前操作",
  {
    context = getContext(),
    graph = conversationWorkspace.graph,
    reason = "runtime-graph-identity-repair",
  } = {},
) {
  if (
    !graph ||
    typeof graph !== "object" ||
    Array.isArray(graph) ||
    !graph.historyState ||
    typeof graph.historyState !== "object" ||
    Array.isArray(graph.historyState)
  ) {
    return { repaired: false, reason: "missing-runtime-graph" };
  }

  const graphOwnedChatId = getGraphOwnedChatId(graph);
  const stateChatId = normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId);
  const identity = resolveCurrentChatIdentity(context);
  const markerChatId = normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.commitMarker?.chatId);
  const repairPlan = planRuntimeGraphIdentityRepairCore({
    graph,
    graphOwnedChatId,
    stateChatId,
    activeIdentity: identity,
    markerChatId,
    aliasCandidates: getGraphIdentityAliasCandidates({
      integrity: identity.integrity,
      hostChatId: identity.hostChatId,
      persistenceChatId: identity.chatId,
    }),
  });
  if (!repairPlan.shouldRepair) {
    return {
      repaired: false,
      reason: repairPlan.reason,
      chatId: repairPlan.chatId,
      liveChatId: repairPlan.liveChatId,
      markerChatId: repairPlan.markerChatId,
    };
  }

  graph.historyState.chatId = repairPlan.chatId;
  stampGraphPersistenceMeta(graph, {
    revision: conversationWorkspace.graphPersistenceState.revision || graph?.meta?.revision || graph?.revision || 0,
    reason: String(reason || operationLabel || "runtime-graph-identity-repair"),
    chatId: repairPlan.chatId,
    integrity:
      normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.commitMarker?.integrity) ||
      getChatMetadataIntegrity(context),
  });
  debugDebug("[ST-BME] 已补齐运行时图谱聊天身份", {
    operationLabel,
    chatId: repairPlan.chatId,
    reason,
  });
  return { repaired: true, reason: "repaired", chatId: repairPlan.chatId };
}

function isGraphReadableForRecall(
  loadState = conversationWorkspace.graphPersistenceState.loadState,
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
  const state = conversationWorkspace.graphPersistenceState.loadState;
  const chatId = conversationWorkspace.graphPersistenceState.chatId || getCurrentChatId();
  switch (state) {
    case GRAPH_LOAD_STATES.NO_CHAT:
      if (hasMeaningfulRuntimeGraphForChat(chatId)) {
        return createUiStatus({
          textKey: "status.graphLoad.title",
          textFallback: "图谱已加载",
          metaKey: chatId
            ? "status.graphLoad.noHostChat.detail"
            : "status.graphLoad.noHostChatNoId.detail",
          metaParams: { chatId },
          metaFallback: chatId
            ? `已读取聊天 ${chatId} 的图谱；宿主当前聊天 ID 暂不可用，维护操作会使用图谱身份继续`
            : "已读取当前图谱；宿主当前聊天 ID 暂不可用，维护操作会使用图谱身份继续",
          level: "warning",
        });
      }
      return createUiStatus({
        textKey: "status.idle",
        textFallback: "待命",
        metaKey: "status.graphLoad.noChat.detail",
        metaFallback: "当前尚未进入聊天",
        level: "idle",
      });
    case GRAPH_LOAD_STATES.LOADING:
      if (hasMeaningfulRuntimeGraphForChat(chatId)) {
        return createUiStatus({
          textKey: "status.graphLoad.temp.title",
          textFallback: "图谱已暂载",
          metaKey: chatId
            ? "status.graphLoad.loadingTemp.detail"
            : "status.graphLoad.loadingTempNoChat.detail",
          metaParams: { chatId },
          metaFallback: chatId
            ? `已读到聊天 ${chatId} 的临时图谱，正在确认本地存储`
            : "已读到临时图谱，正在确认本地存储",
          level: "warning",
        });
      }
      return createUiStatus({
        textKey: "status.loading",
        textFallback: "图谱加载中",
        metaKey: chatId
          ? "status.graphLoad.loading.detail"
          : "status.graphLoad.loadingNoChat.detail",
        metaParams: { chatId },
        metaFallback: chatId
          ? `正在读取聊天 ${chatId} 的 IndexedDB 图谱`
          : "正在等待聊天上下文准备完成",
        level: "running",
      });
    case GRAPH_LOAD_STATES.SHADOW_RESTORED:
      return createUiStatus({
        textKey: "status.graphLoad.shadow.title",
        textFallback: "图谱临时恢复",
        metaKey: "status.graphLoad.shadow.detail",
        metaFallback: "已从本次会话临时恢复，正在等待正式聊天元数据",
        level: "warning",
      });
    case GRAPH_LOAD_STATES.EMPTY_CONFIRMED:
      return createUiStatus({
        textKey: "status.graphLoad.waiting.title",
        textFallback: "图谱待命",
        metaKey: chatId
          ? "status.graphLoad.empty.detail"
          : "status.graphLoad.noChat.detail",
        metaFallback: chatId ? "当前聊天还没有图谱" : "当前尚未进入聊天",
        level: "idle",
      });
    case GRAPH_LOAD_STATES.BLOCKED:
      return createUiStatus({
        textKey: "status.graphLoad.blocked.title",
        textFallback: "图谱加载受阻",
        metaKey: "status.graphLoad.blocked.detail",
        metaFallback: "当前图谱未能完成 IndexedDB 确认，请稍后重试",
        level: "warning",
      });
    case GRAPH_LOAD_STATES.LOADED:
    default:
      return createUiStatus({
        textKey: "status.idle",
        textFallback: "待命",
        metaKey: "status.graphLoad.loaded.detail",
        metaFallback: "已加载聊天图谱，等待下一次任务",
        level: "idle",
      });
  }
}

function getPanelRuntimeStatus() {
  return getPanelRuntimeStatusImpl(
    createGraphMutationGateRuntime(),
  );
}

function getGraphMutationBlockReason(operationLabel = "当前操作") {
  return getGraphMutationBlockReasonImpl(
    createGraphMutationGateRuntime(),
    operationLabel,
  );
}

function ensureGraphMutationReady(
  operationLabel = "当前操作",
  { notify = true, ignoreRestoreLock = false, allowRuntimeGraphFallback = false } = {},
) {
  return ensureGraphMutationReadyImpl(
    createGraphMutationGateRuntime(),
    operationLabel, { notify, ignoreRestoreLock, allowRuntimeGraphFallback },
  );
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
    revision = conversationWorkspace.graphPersistenceState.revision,
    lastPersistedRevision = conversationWorkspace.graphPersistenceState.lastPersistedRevision,
    queuedPersistRevision = conversationWorkspace.graphPersistenceState.queuedPersistRevision,
    pendingPersist = conversationWorkspace.graphPersistenceState.pendingPersist,
    dbReady = isGraphLoadStateDbReady(loadState),
    writesBlocked = !isGraphMetadataWriteAllowed(loadState),
    storagePrimary = conversationWorkspace.graphPersistenceState.storagePrimary || "indexeddb",
    storageMode =
      conversationWorkspace.graphPersistenceState.storageMode || BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
    hostProfile = conversationWorkspace.graphPersistenceState.hostProfile || resolvePersistenceHostProfile(),
    primaryStorageTier =
      conversationWorkspace.graphPersistenceState.primaryStorageTier ||
      buildPersistenceEnvironment(getContext(), {
        storagePrimary,
        storageMode,
      }).primaryStorageTier,
    cacheStorageTier =
      conversationWorkspace.graphPersistenceState.cacheStorageTier ||
      buildPersistenceEnvironment(getContext(), {
        storagePrimary,
        storageMode,
      }).cacheStorageTier,
  } = {},
) {
  return applyGraphLoadStateImpl(
    createGraphMutationGateRuntime(),
    loadState,
    {
      chatId,
      reason,
      attemptIndex,
      shadowSnapshotUsed,
      shadowSnapshotRevision,
      shadowSnapshotUpdatedAt,
      shadowSnapshotReason,
      revision,
      lastPersistedRevision,
      queuedPersistRevision,
      pendingPersist,
      dbReady,
      writesBlocked,
      storagePrimary,
      storageMode,
      hostProfile,
      primaryStorageTier,
      cacheStorageTier,
    },
  );
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
  return assertRecoveryChatStillActiveImpl(
    createGraphMutationGateRuntime(),
    expectedChatId, label,
  );
}

function assertRecoveryHistoryStillCurrent(
  expectedChatId,
  expectedHistoryFingerprint,
  label = "",
) {
  assertRecoveryChatStillActive(expectedChatId, label);
  const activeFingerprint = buildChatHistoryFingerprint(getContext()?.chat);
  if (activeFingerprint === expectedHistoryFingerprint) return true;
  throw createAbortError(
    `历史恢复期间聊天内容再次变化${label ? ` (${label})` : ""}`,
  );
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
  const pending = conversationWorkspace.activeRecallPromise;
  if (!pending) {
    return {
      settled: !conversationWorkspace.isRecalling,
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
    settled: settled || !conversationWorkspace.isRecalling,
    timedOut: !settled && conversationWorkspace.isRecalling,
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
      return conversationWorkspace.lastExtractionStatus;
    case "vector":
      return conversationWorkspace.lastVectorStatus;
    case "recall":
      return conversationWorkspace.lastRecallStatus;
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

function buildStageNoticeSignature(stage, input = {}) {
  return [
    String(stage || ""),
    String(input?.title || ""),
    String(input?.level || ""),
    String(input?.message || ""),
    String(input?.action?.label || ""),
  ].join("\u001f");
}

function isStageNoticeDismissedByUser(stage, signature) {
  if (!stage || !signature) return false;
  const record = dismissedStageNoticeSignatures.get(stage);
  if (!record || record.signature !== signature) return false;
  const dismissedAt = Number(record.dismissedAt || 0);
  if (Date.now() - dismissedAt <= STAGE_NOTICE_USER_DISMISS_COOLDOWN_MS) {
    return true;
  }
  dismissedStageNoticeSignatures.delete(stage);
  return false;
}

function rememberStageNoticeUserDismiss(stage, signature) {
  if (!stage || !signature) return;
  dismissedStageNoticeSignatures.set(stage, {
    signature,
    dismissedAt: Date.now(),
  });
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
  let signature = "";
  input.onDismiss = ({ reason } = {}) => {
    if (reason === "user") {
      rememberStageNoticeUserDismiss(stage, signature);
    }
    if (stageNoticeHandles[stage]?.isClosed?.()) {
      stageNoticeHandles[stage] = null;
    }
  };
  signature = buildStageNoticeSignature(stage, input);

  const currentHandle = stageNoticeHandles[stage];
  if (!currentHandle || currentHandle.isClosed?.()) {
    if (isStageNoticeDismissedByUser(stage, signature)) return;
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
  if (!conversationWorkspace.graph || !Array.isArray(nodeIds)) {
    conversationWorkspace.lastExtractedItems = [];
    return;
  }

  conversationWorkspace.lastExtractedItems = nodeIds
    .map((id) => getNode(conversationWorkspace.graph, id))
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
  if (!conversationWorkspace.graph || !Array.isArray(nodeIds)) {
    conversationWorkspace.lastRecalledItems = [];
    return;
  }

  conversationWorkspace.lastRecalledItems = normalizeRecallNodeIdList(nodeIds)
    .map((id) => getNode(conversationWorkspace.graph, id))
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
    conversationWorkspace.graph?.lastRecallResult,
  );
  const persistedNodeIds = normalizeRecallNodeIdList(
    latestPersisted?.record?.selectedNodeIds,
  );
  const effectiveNodeIds = graphRecallNodeIds.length
    ? graphRecallNodeIds
    : persistedNodeIds;

  updateLastRecalledItems(effectiveNodeIds);
  conversationWorkspace.lastInjectionContent = String(latestPersisted?.record?.injectionText || "").trim();

  return {
    restored: Boolean(conversationWorkspace.lastInjectionContent || effectiveNodeIds.length),
    latestPersistedMessageIndex: Number.isFinite(latestPersisted?.messageIndex)
      ? latestPersisted.messageIndex
      : null,
    selectedNodeIds: effectiveNodeIds,
    injectionTextLength: conversationWorkspace.lastInjectionContent.length,
  };
}

function clearRecallInputTracking() {
  return recallInputState.clearRecallInputTracking();
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
  return recallInputState.freezeHostGenerationInputSnapshot(text, source);
}

function consumeHostGenerationInputSnapshot(options = {}) {
  return recallInputState.consumeHostGenerationInputSnapshot(options);
}

function getPendingHostGenerationInputSnapshot() {
  return recallInputState.getPendingHostGenerationInputSnapshot();
}

function clearPendingRecallSendIntent() {
  return recallInputState.clearPendingRecallSendIntent();
}

function clearPendingHostGenerationInputSnapshot() {
  return recallInputState.clearPendingHostGenerationInputSnapshot();
}

function getCurrentGenerationTrivialSkip(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  return recallInputState.getCurrentGenerationTrivialSkip(chatId, now);
}

function markCurrentGenerationTrivialSkip({
  reason = "",
  chatId = getCurrentChatId(),
  chatLength = 0,
} = {}) {
  return recallInputState.markCurrentGenerationTrivialSkip({
    reason,
    chatId,
    chatLength,
  });
}

function clearCurrentGenerationTrivialSkip(_reason = "") {
  return recallInputState.clearCurrentGenerationTrivialSkip(_reason);
}

function consumeCurrentGenerationTrivialSkip(
  targetMessageIndex,
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  return recallInputState.consumeCurrentGenerationTrivialSkip(
    targetMessageIndex,
    chatId,
    now,
  );
}

function recordRecallSendIntent(text, source = "dom-intent") {
  return recallInputState.recordRecallSendIntent(text, source);
}

function recordRecallSentUserMessage(messageId, text, source = "message-sent") {
  return recallInputState.recordRecallSentUserMessage(messageId, text, source);
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
  if (!globalThis.__stBmeDebugLoggingEnabled) return;
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    recallMessageUiController.uiDiagnosticTimestamps || new Map(),
    `ui:${throttleKey}`,
    `[ST-BME] Recall Card UI: ${reason}${suffix}`,
  );
}

function debugPersistedRecallPersistence(
  reason,
  details = null,
  throttleKey = reason,
) {
  if (!globalThis.__stBmeDebugLoggingEnabled) return;
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  debugWithThrottle(
    recallMessageUiController.persistDiagnosticTimestamps || new Map(),
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
    return null;
  }
  const activeGenerationId = String(
    conversationSession.getGeneration()?.id || "",
  ).trim();
  if (!activeGenerationId) return null;

  const recentTransaction = findRecentGenerationRecallTransactionForChat();
  if (
    !recentTransaction ||
    recentTransaction.generationType !== "normal" ||
    String(recentTransaction.generationId || "") !== activeGenerationId
  ) {
    return null;
  }

  return finalRecallInjectionRuntime.bindGenerationRecallTransactionToUserMessage(
    recentTransaction,
    newUserMessageIndex,
  );
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
  return finalRecallInjectionRuntime.persistRecallInjectionRecord({
    recallInput,
    result,
    injectionText,
    tokenEstimate,
  });
}

function ensurePersistedRecallRecordForGeneration({
  generationType = "normal",
  recallResult = null,
  transaction = null,
  recallOptions = null,
  hookName = "",
  stableTargetUserMessageIndex = null,
} = {}) {
  return finalRecallInjectionRuntime.ensurePersistedRecallRecordForGeneration({
    generationType,
    recallResult,
    transaction,
    recallOptions,
    hookName,
    stableTargetUserMessageIndex,
  });
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
  const chatRoot = getHostDocument()?.getElementById?.("chat");
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
  return finalRecallInjectionRuntime.rewriteRecallPayloadWithInjection(
    promptData,
    injectionText,
  );
}

function rewriteRecallPayloadWithAuthoritativeUserInput(
  promptData = null,
  authoritativeText = "",
  boundUserFloorText = "",
) {
  return finalRecallInjectionRuntime.rewriteRecallPayloadWithAuthoritativeUserInput(
    promptData,
    authoritativeText,
    boundUserFloorText,
  );
}
function readGenerationRecallTransactionFinalResolution(transaction) {
  return generationRecallTransactionRuntime.readGenerationRecallTransactionFinalResolution(
    transaction,
  );
}

function storeGenerationRecallTransactionFinalResolution(
  transaction,
  finalResolution = null,
) {
  return generationRecallTransactionRuntime.storeGenerationRecallTransactionFinalResolution(
    transaction,
    finalResolution,
  );
}
function applyFinalRecallInjectionForGeneration({
  generationType = "normal",
  freshRecallResult = null,
  transaction = null,
  promptData = null,
  hookName = "",
} = {}) {
  return finalRecallInjectionRuntime.applyFinalRecallInjectionForGeneration({
    generationType,
    freshRecallResult,
    transaction,
    promptData,
    hookName,
  });
}
function reapplyPersistedRecallBlock(args = {}) {
  return finalRecallInjectionRuntime.reapplyPersistedRecallBlock(args);
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

function resolveMessageIndexFromElement(messageElement) {
  return recallMessageUiController.resolveMessageIndexFromElement(messageElement);
}

function resolveRecallCardAnchor(messageElement) {
  return recallMessageUiController.resolveRecallCardAnchor(messageElement);
}

function refreshPersistedRecallMessageUi() {
  return recallMessageUiController.refreshPersistedRecallMessageUi();
}

function schedulePersistedRecallMessageUiRefresh(delayMs = 0) {
  return recallMessageUiController.schedulePersistedRecallMessageUiRefresh(delayMs);
}

function cleanupPersistedRecallMessageUi() {
  return recallMessageUiController.cleanupPersistedRecallMessageUi();
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
    forceFreshRecall: true,
  });
  applyFinalRecallInjectionForGeneration({
    generationType: "history",
    freshRecallResult: result,
  });
  return result;
}

function getSendTextareaValue() {
  return readSendTextareaValue();
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
      getEventMakeFirst,
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
      getEventMakeFirst,
    },
    listener,
  );
}

function installSendIntentHooks() {
  return installSendIntentHooksController({
    console,
    consumeSendIntentHookCleanup: () =>
      sendIntentHookCleanup.splice(0, sendIntentHookCleanup.length),
    document: getHostDocument(),
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
  return shouldUseAuthorityGraphStoreImpl(
    createGraphLoadPersistRuntime(),
    settings, capability,
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
  const capability = normalizeAuthorityCapabilityState(authorityCapabilityState, settings);
  return {
    baseUrl: normalizedSettings.baseUrl,
    bmeVectorManifestReady: Boolean(capability.bmeVectorManifestReady),
    bmeVectorApplyReady: Boolean(capability.bmeVectorApplyReady),
    bmeCandidateSearchReady: Boolean(capability.bmeCandidateSearchReady),
    bmeGraphCommitReady: Boolean(capability.bmeGraphCommitReady),
    isAuthorityModuleGraphCommitReady: Boolean(capability.bmeGraphCommitReady),
    bmeExtractionCommitBatchReady: Boolean(capability.bmeExtractionCommitBatchReady),
    isAuthorityModuleExtractionCommitBatchReady: Boolean(capability.bmeExtractionCommitBatchReady),
    bmeProtocolVersion: Math.max(0, Number(capability.bmeProtocolVersion) || 0),
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

async function createPreferredGraphLocalStore(chatId, settings = getSettings(), preferredStore = null) {
  const preferredLocalStore =
    preferredStore || (await resolvePreferredGraphLocalStorePresentation(settings));
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
    conversationWorkspace.graphPersistenceState.opfsWriteLockState,
    null,
  );
  let reopenError = "";
  const canRebind = reopenCurrentDb === true && conversationWorkspace.graphPersistenceState.pendingPersist !== true;

  if (normalizedChatId) {
    clearCachedIndexedDbSnapshot(normalizedChatId);
    try {
      const repository = ensureConversationRepository();
      if (repository) {
        const db = canRebind
          ? await repository.rebind(
              normalizedChatId,
              repository.getBinding(normalizedChatId)?.presentation || preferredLocalStore,
            )
          : await repository.getStore(normalizedChatId);
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
  return buildPanelOpenLocalStoreRefreshPlanImpl(
    createGraphMutationGateRuntime(),
    context, settings,
  );
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
  return getMessageRenderLimitSettingsCore(
    settings,
    typeof getSettings === "function" ? getSettings : null,
  );
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

function getMessageRenderLimitHostAdapter() {
  return {
    getPowerUser: getHostPowerUserSettings,
    jq: typeof $ === "function" ? $ : null,
    reloadCurrentChat: () => {
      const context = typeof getContext === "function" ? getContext() : null;
      if (typeof context?.reloadCurrentChat === "function") {
        context.reloadCurrentChat();
      }
    },
    resolveSettings: typeof getSettings === "function" ? getSettings : null,
    console,
  };
}

function applyMessageRenderLimit(settings = null, options = {}) {
  return applyMessageRenderLimitCore(
    settings,
    options,
    getMessageRenderLimitHostAdapter(),
  );
}

function getActiveMessageRenderLimitForHistoryGuard(settings = null) {
  return getActiveMessageRenderLimitForHistoryGuardCore(
    settings,
    getMessageRenderLimitHostAdapter(),
  );
}

function getHighestTrackedProcessedHistoryFloor(historyState = {}) {
  return getHighestTrackedProcessedHistoryFloorCore(historyState);
}

function getRenderLimitedHistoryRecoveryGuard(
  chat,
  { settings = null, historyState = conversationWorkspace.graph?.historyState } = {},
) {
  return getRenderLimitedHistoryRecoveryGuardCore(chat, {
    settings,
    historyState,
    host: getMessageRenderLimitHostAdapter(),
  });
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
      revision || conversationWorkspace.graphPersistenceState.revision || getGraphPersistedRevision(graph),
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
  if (!normalizedChatId || !isIndexedDbSnapshotMeaningful(snapshot) || !conversationWorkspace.graph) {
    return {
      stale: false,
      reason: "",
    };
  }

  const runtimeChatId = normalizeChatIdCandidate(
    conversationWorkspace.graph?.historyState?.chatId ||
      getGraphPersistenceMeta(conversationWorkspace.graph)?.chatId ||
      conversationWorkspace.graphPersistenceState.chatId,
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
    normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.revision),
    normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.lastPersistedRevision),
    normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.queuedPersistRevision),
    getGraphPersistedRevision(conversationWorkspace.graph),
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
    Number(conversationWorkspace.graph?.historyState?.lastProcessedAssistantFloor),
  )
    ? Number(conversationWorkspace.graph.historyState.lastProcessedAssistantFloor)
    : Number.isFinite(Number(conversationWorkspace.graph?.lastProcessedSeq))
      ? Number(conversationWorkspace.graph.lastProcessedSeq)
      : -1;
  const runtimeExtractionCount = Number.isFinite(
    Number(conversationWorkspace.graph?.historyState?.extractionCount),
  )
    ? Number(conversationWorkspace.graph.historyState.extractionCount)
    : Number.isFinite(Number(conversationWorkspace.extractionCount))
      ? Number(conversationWorkspace.extractionCount)
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
      loadState: conversationWorkspace.graphPersistenceState.loadState,
      reason: "shadow-invalid",
      chatId: normalizedChatId || "",
      attemptIndex,
    };
  }
  const activeIdentity = resolveCurrentChatIdentity(getContext());
  if (
    normalizedChatId &&
    normalizeChatIdCandidate(activeIdentity.chatId) &&
    !doesChatIdMatchResolvedGraphIdentity(normalizedChatId, activeIdentity)
  ) {
    return {
      success: false,
      loaded: false,
      loadState: conversationWorkspace.graphPersistenceState.loadState,
      reason: "shadow-chat-switched",
      chatId: normalizedChatId,
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
      loadState: conversationWorkspace.graphPersistenceState.loadState,
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
      conversationWorkspace.graphPersistenceState.metadataIntegrity,
  });

  conversationWorkspace.graph = shadowGraph;
  conversationWorkspace.extractionCount = Number.isFinite(conversationWorkspace.graph?.historyState?.extractionCount)
    ? conversationWorkspace.graph.historyState.extractionCount
    : 0;
  conversationWorkspace.lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  conversationWorkspace.runtimeStatus = createUiStatus(
    "图谱临时恢复",
    "已从本次会话临时快照恢复最近图谱，正在补写 IndexedDB",
    "warning",
  );
  conversationWorkspace.lastExtractionStatus = createUiStatus(
    "待命",
    "已从会话快照恢复最近图谱，等待下一次提取",
    "idle",
  );
  conversationWorkspace.lastVectorStatus = createUiStatus(
    "待命",
    conversationWorkspace.graph.vectorIndexState?.lastWarning ||
      "已从会话快照恢复最近图谱，等待下一次向量任务",
    "idle",
  );
  conversationWorkspace.lastRecallStatus = createUiStatus(
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
      normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.lastPersistedRevision),
      shadowRevision,
    ),
    queuedPersistRevision: Math.max(
      normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.queuedPersistRevision),
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
      conversationWorkspace.graphPersistenceState.metadataIntegrity,
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
    queueGraphPersistToIndexedDb(normalizedChatId, conversationWorkspace.graph, {
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
  return buildBmeSyncRuntimeOptionsImpl(
    createGraphLoadPersistRuntime(),
    extra,
  );
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
    const repository = ensureConversationRepository();
    if (!repository) {
      return null;
    }

    const db = await repository.getStore(normalizedChatId);
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
        Number(conversationWorkspace.graphPersistenceState.remoteSyncFormatVersion || 0) ||
        1,
      lastSyncError: String(lastSyncError || ""),
      opfsWriteLockState:
        typeof db.getWriteLockSnapshot === "function"
          ? cloneRuntimeDebugValue(db.getWriteLockSnapshot(), null)
          : conversationWorkspace.graphPersistenceState.opfsWriteLockState,
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

function ensureConversationRepository() {
  if (typeof ConversationRepository !== "function") {
    if (!conversationRepositoryUnavailableWarned) {
      console.warn("[ST-BME] ConversationRepository 不可用，图谱持久化暂时停用");
      conversationRepositoryUnavailableWarned = true;
    }
    return null;
  }

  if (!conversationRepository) {
    conversationRepository = new ConversationRepository({
      resolveBinding: resolvePreferredGraphLocalStorePresentation,
      bindingKey: buildGraphLocalStoreSelectorKey,
      storeFactory: async (chatId, binding) =>
        await createPreferredGraphLocalStore(
          chatId,
          getSettings(),
          binding.presentation,
        ),
    });
  }
  return conversationRepository;
}

function recordLocalPersistEarlyFailure(
  reason = "indexeddb-unavailable",
  {
    chatId = "",
    storagePrimary = conversationWorkspace.graphPersistenceState.storagePrimary || "indexeddb",
    storageMode = conversationWorkspace.graphPersistenceState.storageMode || "indexeddb",
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
        console.warn("[ST-BME] 持久化后台任务失败:", error);
      });
  });
}

async function syncConversationRepositoryWithCurrentChat(
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

  const repository = ensureConversationRepository();
  if (!repository) {
    return {
      chatId: "",
      opened: false,
      skipped: true,
      reason: "conversation-repository-unavailable",
    };
  }
  const chatId = getCurrentChatId(context);

  if (!chatId) {
    await repository.closeCurrent();
    debugDebug("[ST-BME] 会话存储已关闭（无活动聊天）", {
      source,
    });
    return {
      chatId: "",
      opened: false,
      skipped: false,
    };
  }

  const db = await repository.switchChat(chatId);
  debugDebug("[ST-BME] 会话存储已同步", {
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
    await syncConversationRepositoryWithCurrentChat(source);
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
    cacheMirrorState = conversationWorkspace.graphPersistenceState.cacheMirrorState,
    cacheLag = null,
    persistMismatchReason = conversationWorkspace.graphPersistenceState.persistMismatchReason,
    lastPersistReason = conversationWorkspace.graphPersistenceState.lastPersistReason,
    lastPersistMode = conversationWorkspace.graphPersistenceState.lastPersistMode,
    persistDiagnosticTier = conversationWorkspace.graphPersistenceState.persistDiagnosticTier,
    dualWriteLastResult = conversationWorkspace.graphPersistenceState.dualWriteLastResult,
    acceptedStorageTier = conversationWorkspace.graphPersistenceState.acceptedStorageTier,
    acceptedBy = conversationWorkspace.graphPersistenceState.acceptedBy,
  } = {},
) {
  const normalizedManifest =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest
      : null;
  const manifestRevision = Number(normalizedManifest?.headRevision || 0);
  const cacheRevision = Number(conversationWorkspace.graphPersistenceState.indexedDbRevision || 0);
  return {
    hostProfile: "luker",
    primaryStorageTier: "luker-chat-state",
    chatStateTarget:
      cloneRuntimeDebugValue(conversationWorkspace.graphPersistenceState.chatStateTarget, null) ||
      resolveCurrentChatStateTarget(getContext()),
    lightweightHostMode:
      conversationWorkspace.graphPersistenceState.lightweightHostMode ??
      isBmeLightweightHostMode(getContext()),
    cacheStorageTier: buildPersistenceEnvironment(
      getContext(),
      getPreferredGraphLocalStorePresentationSync(),
    ).cacheStorageTier,
    cacheMirrorState,
    lastAcceptedRevision: Math.max(
      Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
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
    const repository = ensureConversationRepository();
    if (!repository) return null;
    const db = await repository.getStore(normalizedChatId);
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
            conversationWorkspace.graphPersistenceState.metadataIntegrity,
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
        integrity: normalizedManifest.integrity || conversationWorkspace.graphPersistenceState.metadataIntegrity,
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
    graph = conversationWorkspace.graph,
    chatId = getCurrentChatId(context),
    revision = conversationWorkspace.graphPersistenceState.lukerManifestRevision || conversationWorkspace.graphPersistenceState.revision,
    reason = "luker-chat-state-compaction",
    integrity = "",
    chatStateTarget = null,
  } = {},
) {
  const normalizedChatId = normalizeChatIdCandidate(chatId);
  const normalizedTarget = resolveCurrentChatStateTarget(context, chatStateTarget);
  const compactionLease = conversationWorkspace.captureLease();
  const isTargetActive = () =>
    isConversationTargetCurrent(
      normalizedChatId,
      compactionLease,
      normalizedTarget,
    );
  const updateTargetPersistenceState = (patch) =>
    isTargetActive() ? updateGraphPersistenceState(patch) : conversationWorkspace.graphPersistenceState;
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
      normalizeChatIdCandidate(getGraphPersistenceMeta(graph)?.integrity) ||
      getChatMetadataIntegrity(context);
    const revisionFloor = Math.max(
      1,
      Number(revision || 0),
      Number(getGraphPersistedRevision(graph) || 0),
    );
    const startedAt = Date.now();
    updateTargetPersistenceState({
      ...buildLukerManifestStatePatch(readCachedChatStateManifest(normalizedChatId), {
        cacheMirrorState: conversationWorkspace.graphPersistenceState.cacheMirrorState,
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
      updateTargetPersistenceState({
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
      updateTargetPersistenceState({
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
      updateTargetPersistenceState({
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
    updateTargetPersistenceState({
      ...buildLukerManifestStatePatch(manifestResult.manifest, {
        cacheMirrorState: conversationWorkspace.graphPersistenceState.cacheMirrorState,
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
  const compactionLease = conversationWorkspace.captureLease();
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
      if (
        isConversationTargetCurrent(
          normalizedChatId,
          compactionLease,
          options?.chatStateTarget,
        )
      ) {
        updateGraphPersistenceState({
          opfsCompactionState: buildLukerJournalCompactionState("error", {
            lastAt: Date.now(),
            lastReason: String(options?.reason || "luker-chat-state-compaction"),
            error: error?.message || String(error),
          }),
        });
      }
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
    graph = conversationWorkspace.graph,
    chatId: explicitChatId = "",
    revision = conversationWorkspace.graphPersistenceState.revision,
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
  const persistenceLease = conversationWorkspace.captureLease();
  const isTargetActive = () =>
    isConversationTargetCurrent(chatId, persistenceLease, normalizedTarget);
  const updateTargetPersistenceState = (patch) =>
    isTargetActive() ? updateGraphPersistenceState(patch) : conversationWorkspace.graphPersistenceState;

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
    conversationWorkspace.graphPersistenceState.metadataIntegrity;

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
        updateTargetPersistenceState({
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
      if (shouldRememberAlias && isTargetActive()) {
        rememberResolvedGraphIdentityAlias(context, chatId);
      }
      updateTargetPersistenceState({
        ...buildLukerManifestStatePatch(manifestResult.manifest, {
          cacheMirrorState:
            mode === "mirror" ? "saved" : conversationWorkspace.graphPersistenceState.cacheMirrorState,
          lastPersistReason: String(reason || ""),
          lastPersistMode: "luker-chat-state-v2-bootstrap",
          acceptedStorageTier:
            accepted === true
              ? "luker-chat-state"
              : conversationWorkspace.graphPersistenceState.acceptedStorageTier,
          acceptedBy:
            accepted === true ? "luker-chat-state" : conversationWorkspace.graphPersistenceState.acceptedBy,
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
          nextIntegrity || conversationWorkspace.graphPersistenceState.metadataIntegrity || "",
        ),
        revision: Number(effectiveRevision || 0),
        lastPersistedRevision: Number(effectiveRevision || 0),
        lastAcceptedRevision:
          accepted === true
            ? Number(effectiveRevision || 0)
            : Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
        pendingPersist: false,
        persistMismatchReason: "",
        persistDiagnosticTier: "none",
      });
      if (mode !== "mirror" && isTargetActive()) {
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
      updateTargetPersistenceState({
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
      updateTargetPersistenceState({
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
    if (shouldRememberAlias && isTargetActive()) {
      rememberResolvedGraphIdentityAlias(context, chatId);
    }
    updateTargetPersistenceState({
      ...buildLukerManifestStatePatch(manifestResult.manifest, {
        cacheMirrorState:
          mode === "mirror" ? "saved" : conversationWorkspace.graphPersistenceState.cacheMirrorState,
        lastPersistReason: String(reason || ""),
        lastPersistMode:
          mode === "mirror"
            ? "luker-chat-state-v2-mirror"
            : "luker-chat-state-v2",
        acceptedStorageTier:
          accepted === true
            ? "luker-chat-state"
            : conversationWorkspace.graphPersistenceState.acceptedStorageTier,
        acceptedBy:
          accepted === true ? "luker-chat-state" : conversationWorkspace.graphPersistenceState.acceptedBy,
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
        nextIntegrity || conversationWorkspace.graphPersistenceState.metadataIntegrity || "",
      ),
      revision: Number(manifestResult.manifest.headRevision || effectiveRevision || 0),
      lastPersistedRevision: Number(
        manifestResult.manifest.headRevision || effectiveRevision || 0,
      ),
      lastAcceptedRevision:
        accepted === true
          ? Number(manifestResult.manifest.headRevision || effectiveRevision || 0)
          : Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
      pendingPersist: false,
      persistMismatchReason: "",
      persistDiagnosticTier: "none",
    });
    if (mode !== "mirror" && isTargetActive()) {
      clearPendingGraphPersistRetry();
    }
    if (
      isTargetActive() &&
      shouldQueueLukerSidecarCompaction(manifestResult.manifest)
    ) {
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
  const buildChatSwitchedResult = () => ({
    success: false,
    loaded: false,
    reason: "luker-chat-state-chat-switched",
    chatId: normalizedChatId,
    attemptIndex,
    revision: Number(manifest.headRevision || 0),
  });

  const localSnapshot = await readLocalCacheSnapshotForChat(
    normalizedChatId,
    `${source}:luker-local-cache-read`,
  );
  if (normalizeChatIdCandidate(getCurrentChatId()) !== normalizedChatId) {
    return buildChatSwitchedResult();
  }
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
          manifest.integrity || conversationWorkspace.graphPersistenceState.metadataIntegrity || "",
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
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(conversationWorkspace.graphPersistenceState.loadState) ||
    conversationWorkspace.graphPersistenceState.storagePrimary === "chat-state" ||
    Number(manifest.headRevision || 0) >=
      normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.revision);
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
  if (normalizeChatIdCandidate(getCurrentChatId()) !== normalizedChatId) {
    return buildChatSwitchedResult();
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
            : conversationWorkspace.graphPersistenceState.cacheMirrorState,
        acceptedStorageTier: "luker-chat-state",
        acceptedBy: "luker-chat-state",
      }),
      chatStateTarget: cloneRuntimeDebugValue(normalizedTarget, null),
      metadataIntegrity: String(
        manifest.integrity || conversationWorkspace.graphPersistenceState.metadataIntegrity || "",
      ),
      reason: `${source}:luker-chat-state`,
      revision: Math.max(
        Number(conversationWorkspace.graphPersistenceState.revision || 0),
        Number(manifest.headRevision || 0),
      ),
    });
  }
  return loadResult;
}

async function persistGraphToHostChatState(
  context = getContext(),
  {
    graph = conversationWorkspace.graph,
    chatId: explicitChatId = "",
    revision = conversationWorkspace.graphPersistenceState.revision,
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
    conversationWorkspace.graphPersistenceState.metadataIntegrity;
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
        : conversationWorkspace.graphPersistenceState.cacheMirrorState,
    metadataIntegrity: String(nextIntegrity || conversationWorkspace.graphPersistenceState.metadataIntegrity || ""),
    lastPersistReason: String(reason || ""),
    lastPersistMode:
      mode === "mirror" ? "chat-state-mirror" : "chat-state",
    lastAcceptedRevision:
      accepted === true
        ? Math.max(
            Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
            Number(writeResult.snapshot.revision || revision || 0),
          )
        : Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
    acceptedStorageTier:
      accepted === true
        ? normalizePersistenceStorageTier(effectiveStorageTier)
        : conversationWorkspace.graphPersistenceState.acceptedStorageTier,
    acceptedBy:
      accepted === true
        ? normalizePersistenceStorageTier(effectiveStorageTier)
        : conversationWorkspace.graphPersistenceState.acceptedBy,
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
    conversationWorkspace.graphPersistenceState.metadataIntegrity;
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
    BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET.has(conversationWorkspace.graphPersistenceState.loadState) ||
    conversationWorkspace.graphPersistenceState.storagePrimary === "chat-state" ||
    revision >= normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.revision);
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

  const currentGraphMeta = getGraphPersistenceMeta(conversationWorkspace.graph) || {};
  const runtimeGraphIntegrity = normalizeChatIdCandidate(
    currentGraphMeta.integrity || conversationWorkspace.graphPersistenceState.metadataIntegrity,
  );
  if (
    identity.integrity &&
    runtimeGraphIntegrity &&
    runtimeGraphIntegrity === identity.integrity
  ) {
    addCandidate(conversationWorkspace.graphPersistenceState.chatId);
    addCandidate(conversationWorkspace.graph?.historyState?.chatId);
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

  const repository = ensureConversationRepository();
  if (!repository) {
    return {
      migrated: false,
      reason: "identity-recovery-repository-unavailable",
      chatId: normalizedChatId,
    };
  }

  const targetDb = db || (await repository.getStore(normalizedChatId));
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

  const currentGraphMeta = getGraphPersistenceMeta(conversationWorkspace.graph) || {};
  const runtimeGraphIntegrity = normalizeChatIdCandidate(
    currentGraphMeta.integrity || conversationWorkspace.graphPersistenceState.metadataIntegrity,
  );
  const runtimeGraphChatId = normalizeChatIdCandidate(
    conversationWorkspace.graph?.historyState?.chatId ||
      currentGraphMeta.chatId ||
      conversationWorkspace.graphPersistenceState.chatId,
  );

  if (
    conversationWorkspace.graph &&
    !isGraphEffectivelyEmpty(conversationWorkspace.graph) &&
    runtimeGraphIntegrity &&
    runtimeGraphIntegrity === identity.integrity &&
    runtimeGraphChatId &&
    runtimeGraphChatId !== normalizedChatId
  ) {
    return await finalizeMigration(conversationWorkspace.graph, {
      revision: Math.max(
        conversationWorkspace.graphPersistenceState.revision || 0,
        getGraphPersistedRevision(conversationWorkspace.graph),
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
      const repository = ensureConversationRepository();
      if (!repository) {
        return {
          migrated: false,
          reason: "migration-repository-unavailable",
          chatId: normalizedChatId,
        };
      }

      const targetDb = db || (await repository.getStore(normalizedChatId));
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
          const vectorConfig = normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
          if (shouldUseAuthorityJobs(vectorConfig, AUTHORITY_VECTOR_REBUILD_JOB_TYPE)) {
            await submitAuthorityVectorRebuildJob({
              config: vectorConfig,
              purge: true,
              reason: "authority-migration-trivium-rebuild",
            });
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
          const vectorConfig = normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
          if (shouldUseAuthorityJobs(vectorConfig, AUTHORITY_VECTOR_REBUILD_JOB_TYPE)) {
            await submitAuthorityVectorRebuildJob({
              config: vectorConfig,
              purge: true,
              reason: "authority-migration-trivium-rebuild",
            });
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
          const vectorConfig = normalizeAuthorityVectorConfig(settings, buildAuthorityGraphStoreOptions(settings));
          if (shouldUseAuthorityJobs(vectorConfig, AUTHORITY_VECTOR_REBUILD_JOB_TYPE)) {
            await submitAuthorityVectorRebuildJob({
              config: vectorConfig,
              purge: true,
              reason: "authority-migration-trivium-rebuild",
            });
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
  const activeIdentity = resolveCurrentChatIdentity(getContext());
  if (
    normalizeChatIdCandidate(activeIdentity.chatId) &&
    !doesChatIdMatchResolvedGraphIdentity(normalizedChatId, activeIdentity)
  ) {
    return {
      success: false,
      loaded: false,
      reason: "indexeddb-chat-switched",
      chatId: normalizedChatId,
      attemptIndex,
    };
  }

  conversationWorkspace.graph = normalizeGraphRuntimeState(
    createEmptyGraph(),
    normalizedChatId,
  );
  conversationWorkspace.extractionCount = 0;
  conversationWorkspace.lastExtractedItems = [];
  conversationWorkspace.lastRecalledItems = [];
  conversationWorkspace.lastInjectionContent = "";
  conversationWorkspace.runtimeStatus = createUiStatus("待命", "当前聊天还没有图谱", "idle");
  conversationWorkspace.lastExtractionStatus = createUiStatus("待命", "当前聊天尚未执行提取", "idle");
  conversationWorkspace.lastVectorStatus = createUiStatus("待命", "当前聊天尚未执行向量任务", "idle");
  conversationWorkspace.lastRecallStatus = createUiStatus("待命", "当前聊天尚未建立记忆图谱", "idle");
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

  const graphSnapshot = cloneGraphForPersistence(conversationWorkspace.graph, normalizedChatId);
  const requestedRevision = Math.max(
    1,
    Number(getGraphPersistedRevision(graphSnapshot) || 0),
    Number(conversationWorkspace.graphPersistenceState.revision || 0),
    Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
    Number(conversationWorkspace.graphPersistenceState.lastPersistedRevision || 0),
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
        conversationWorkspace.graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING &&
        hasMeaningfulRuntimeGraphForChat(normalizedChatId, identity)
      ) {
        applyGraphLoadState(GRAPH_LOAD_STATES.BLOCKED, {
          chatId: normalizedChatId,
          reason: result?.reason || "runtime-local-store-repair-failed",
          revision: Math.max(
            Number(conversationWorkspace.graphPersistenceState.revision || 0),
            Number(result?.revision || requestedRevision),
          ),
          lastPersistedRevision: Math.max(
            Number(conversationWorkspace.graphPersistenceState.lastPersistedRevision || 0),
            Number(result?.revision || 0),
          ),
          pendingPersist: false,
          dbReady: false,
          writesBlocked: true,
        });
      }
    } catch (error) {
      if (
        conversationWorkspace.graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING &&
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
  const activeIdentity = resolveCurrentChatIdentity(getContext());
  if (
    normalizedChatId &&
    normalizeChatIdCandidate(activeIdentity.chatId) &&
    !doesChatIdMatchResolvedGraphIdentity(normalizedChatId, activeIdentity)
  ) {
    return {
      success: false,
      loaded: false,
      reason: `${reasonPrefix}-chat-switched`,
      chatId: normalizedChatId,
      attemptIndex,
    };
  }
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
      storagePrimary: conversationWorkspace.graphPersistenceState.storagePrimary || storagePrimary,
      storageMode: conversationWorkspace.graphPersistenceState.storageMode || storageMode,
      metadataIntegrity:
        getChatMetadataIntegrity(getContext()) ||
        conversationWorkspace.graphPersistenceState.metadataIntegrity,
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
        conversationWorkspace.graphPersistenceState.indexedDbRevision || 0,
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
  conversationWorkspace.graph = graphFromSnapshot;
  stampGraphPersistenceMeta(conversationWorkspace.graph, {
    revision,
    reason: `${reasonPrefix}:${String(source || reasonPrefix)}`,
    chatId: normalizedChatId,
    integrity:
      normalizeChatIdCandidate(snapshot?.meta?.integrity) ||
      getChatMetadataIntegrity(getContext()),
  });
  const currentCommitMarker = getChatCommitMarker(getContext());
  const currentCommitMarkerChatId = normalizeChatIdCandidate(currentCommitMarker?.chatId);
  const currentIdentity = resolveCurrentChatIdentity(getContext());
  const legacyBatchRepair = repairLegacyLastBatchPersistenceStatus({
    batchStatus: conversationWorkspace.graph.historyState?.lastBatchStatus || null,
    persistenceState: conversationWorkspace.graphPersistenceState,
    commitMarker: currentCommitMarker,
    activeChatId: normalizedChatId,
    commitMarkerChatMatchesActive:
      Boolean(currentCommitMarkerChatId) &&
      (areChatIdsEquivalentForResolvedIdentity(
        currentCommitMarkerChatId,
        normalizedChatId,
        currentIdentity,
      ) ||
        areChatIdsEquivalentForResolvedIdentity(
          normalizedChatId,
          currentCommitMarkerChatId,
          currentIdentity,
        )),
  });
  if (legacyBatchRepair.repaired && conversationWorkspace.graph.historyState) {
    conversationWorkspace.graph.historyState.lastBatchStatus = legacyBatchRepair.batchStatus;
  }
  conversationWorkspace.graph.vectorIndexState.lastIntegrityIssue = null;

  conversationWorkspace.extractionCount = Number.isFinite(conversationWorkspace.graph?.historyState?.extractionCount)
    ? conversationWorkspace.graph.historyState.extractionCount
    : 0;
  conversationWorkspace.lastExtractedItems = [];
  const restoredRecallUi = restoreRecallUiStateFromPersistence(
    getContext()?.chat,
  );
  conversationWorkspace.runtimeStatus = createUiStatus("待命", `已从${statusLabel}加载聊天图谱`, "idle");
  conversationWorkspace.lastExtractionStatus = createUiStatus(
    "待命",
    `已从${statusLabel}加载聊天图谱，等待下一次提取`,
    "idle",
  );
  conversationWorkspace.lastVectorStatus = createUiStatus(
    "待命",
    conversationWorkspace.graph.vectorIndexState?.lastWarning ||
      `已从${statusLabel}加载聊天图谱，等待下一次向量任务`,
    "idle",
  );
  conversationWorkspace.lastRecallStatus = createUiStatus(
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
      conversationWorkspace.graphPersistenceState.lastPersistedRevision || 0,
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
        conversationWorkspace.graphPersistenceState.metadataIntegrity,
    indexedDbLastError: storagePrimary === "indexeddb" ? "" : conversationWorkspace.graphPersistenceState.indexedDbLastError,
    lastAcceptedRevision: Math.max(
      Number(conversationWorkspace.graphPersistenceState.lastAcceptedRevision || 0),
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
  const shouldPersistPostLoadRepairs =
    hasGraphPersistDirtyState(conversationWorkspace.graph) || legacyBatchRepair.repaired === true;
  rememberResolvedGraphIdentityAlias(getContext(), normalizedChatId);

  if (shouldPersistPostLoadRepairs) {
    const repairedNodeCount = Number(hydrateDiagnostics?.scopeRepairNodeCount) || 0;
    const repairedEdgeCount = Number(hydrateDiagnostics?.scopeRepairEdgeCount) || 0;
    void Promise.resolve().then(() => {
      if (conversationWorkspace.graph !== graphFromSnapshot) {
        return;
      }
      if (
        normalizeChatIdCandidate(conversationWorkspace.graph?.historyState?.chatId) !== normalizedChatId
      ) {
        return;
      }
      debugDebug("[ST-BME] 已检测到加载后图谱自愈，后台写回修复结果", {
        chatId: normalizedChatId,
        repairedNodeCount,
        repairedEdgeCount,
        legacyBatchPersistenceRepaired: legacyBatchRepair.repaired === true,
        source,
      });
      saveGraphToChat({
        reason: legacyBatchRepair.repaired
          ? "legacy-persistence-auto-repair-after-load"
          : "scope-auto-repair-after-load",
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
    ...getGraphStats(conversationWorkspace.graph),
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
  return await loadGraphFromIndexedDbImpl(
    createGraphPersistenceIoRuntime(),
    chatId, { source, attemptIndex, allowOverride, applyEmptyState },
  );
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

function ensureCurrentGraphRuntimeState({ chatId = getCurrentChatId() } = {}) {
  if (!conversationWorkspace.graph) {
    conversationWorkspace.graph = createEmptyGraph();
  }

  conversationWorkspace.graph = normalizeGraphRuntimeState(conversationWorkspace.graph, chatId);
  return conversationWorkspace.graph;
}

function clearPendingGraphLoadRetry({ resetChatId = true } = {}) {
  if (conversationWorkspace.timers.graphLoadRetry) {
    clearTimeout(conversationWorkspace.timers.graphLoadRetry);
    conversationWorkspace.timers.graphLoadRetry = null;
  }

  if (resetChatId) {
    conversationWorkspace.timers.graphLoadRetryChatId = "";
  }
}

function isGraphLoadRetryPending(chatId = getCurrentChatId()) {
  const normalizedChatId = String(chatId || "");
  return (
    Boolean(normalizedChatId) &&
    conversationWorkspace.timers.graphLoadRetryChatId === normalizedChatId
  );
}

function clearPendingAutoExtraction({ resetState = true } = {}) {
  return autoExtractionDeferRuntime.clearPendingAutoExtraction({ resetState });
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
  return autoExtractionDeferRuntime.deferAutoExtraction(reason, {
    chatId,
    messageId,
    delayMs,
    targetEndFloor,
    strategy,
  });
}

function getPendingAutoExtraction() {
  return autoExtractionDeferRuntime.getPendingAutoExtraction();
}

function maybeResumePendingAutoExtraction(source = "auto-extraction-resume") {
  return autoExtractionDeferRuntime.maybeResumePendingAutoExtraction(source);
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

function markDryRunPromptPreview(ttlMs = GENERATION_RECALL_HOOK_BRIDGE_MS) {
  const resolvedTtlMs = Math.max(
    100,
    Math.floor(Number(ttlMs) || GENERATION_RECALL_HOOK_BRIDGE_MS),
  );
  conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil = Date.now() + resolvedTtlMs;
  return conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil;
}

function clearDryRunPromptPreview() {
  const hadPendingSkip = conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil > Date.now();
  conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil = 0;
  return hadPendingSkip;
}

function consumeDryRunPromptPreview(now = Date.now()) {
  if (conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil <= now) {
    if (conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil !== 0) {
      conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil = 0;
    }
    return false;
  }

  conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil = 0;
  return true;
}

function readMvuExtraAnalysisFlag() {
  return readHostMvuExtraAnalysisFlag();
}

function isMvuExtraAnalysisGuardActive(now = Date.now()) {
  if (readMvuExtraAnalysisFlag()) {
    conversationWorkspace.hostGeneration.mvuExtraAnalysisGuardUntil = Math.max(
      conversationWorkspace.hostGeneration.mvuExtraAnalysisGuardUntil,
      now + MVU_EXTRA_ANALYSIS_GUARD_TTL_MS,
    );
  }

  if (conversationWorkspace.hostGeneration.mvuExtraAnalysisGuardUntil <= now) {
    if (conversationWorkspace.hostGeneration.mvuExtraAnalysisGuardUntil !== 0) {
      conversationWorkspace.hostGeneration.mvuExtraAnalysisGuardUntil = 0;
    }
    return false;
  }

  return true;
}

function isTavernHelperPromptViewerRefreshActive() {
  try {
    const doc = getHostDocument();
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
  primaryTier = conversationWorkspace.graphPersistenceState.primaryStorageTier,
  cacheTier = conversationWorkspace.graphPersistenceState.cacheStorageTier,
  cacheMirrored = false,
  diagnosticTier = conversationWorkspace.graphPersistenceState.persistDiagnosticTier,
  reason = "",
  loadState = conversationWorkspace.graphPersistenceState.loadState,
  revision = conversationWorkspace.graphPersistenceState.revision,
  saveMode = conversationWorkspace.graphPersistenceState.lastPersistMode,
  manifestRevision = conversationWorkspace.graphPersistenceState.lukerManifestRevision || 0,
  journalDepth = conversationWorkspace.graphPersistenceState.lukerJournalDepth || 0,
  checkpointRevision = conversationWorkspace.graphPersistenceState.lukerCheckpointRevision || 0,
  cacheLag = conversationWorkspace.graphPersistenceState.cacheLag || 0,
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

function isAuthorityModuleUnavailablePersistenceError(error = null) {
  return Boolean(
    error &&
      (error.name === "AuthorityGraphModuleUnavailableError" ||
        String(error?.code || error?.payload?.code || "").toLowerCase() === "authority_module_unavailable"),
  );
}

function isAuthorityBlockedPersistenceResult(result = null) {
  if (!result || typeof result !== "object") return false;
  const mode = String(result.graphOperationalMode || result.meta?.graphOperationalMode || "").toLowerCase();
  const reason = String(result.reason || result.code || result.payload?.code || "").toLowerCase();
  return (
    result.authorityOwned === true ||
    mode === GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED ||
    reason.includes("authority_module_unavailable") ||
    reason.includes("authority-module-unavailable") ||
    isAuthorityModuleUnavailablePersistenceError(result.error)
  );
}

function maybeCaptureGraphShadowSnapshot(
  reason = "runtime-shadow",
  {
    graph = conversationWorkspace.graph,
    chatId = conversationWorkspace.graphPersistenceState.chatId || getCurrentChatId(),
    revision = conversationWorkspace.graphPersistenceState.revision,
  } = {},
) {
  return maybeCaptureGraphShadowSnapshotImpl(
    createGraphLoadPersistRuntime(),
    reason,
    { graph, chatId, revision },
  );
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
  graph = conversationWorkspace.graph,
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
  const stateChatId = normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId);
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
    conversationWorkspace.graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT &&
    sameRuntimeChat &&
    sameStateChat &&
    typeof graph === "object" &&
    graph !== null
  );
}

function buildBatchPersistenceRecordFromPersistResult(persistResult = null) {
  return reduceBatchPersistenceRecordFromPersistResult(persistResult);
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
  const persistedExtractionCount = Number.isFinite(
    Number(graph?.historyState?.extractionCount),
  )
    ? Number(graph.historyState.extractionCount)
    : Number(conversationWorkspace.extractionCount || 0);
  const isPersistTargetActive = () => {
    const activeContext = getContext();
    const activeChatId = normalizeChatIdCandidate(getCurrentChatId(activeContext));
    const targetChatId = normalizeChatIdCandidate(chatId);
    const identity = resolveCurrentChatIdentity(activeContext);
    return Boolean(
      activeChatId &&
        targetChatId &&
        (areChatIdsEquivalentForResolvedIdentity(
          targetChatId,
          activeChatId,
          identity,
        ) ||
          areChatIdsEquivalentForResolvedIdentity(
            activeChatId,
            targetChatId,
            identity,
          )),
    );
  };
  const persistenceEnvironment = buildPersistenceEnvironment(
    context,
    preferredLocalStore,
  );
  const localStoreTier = resolveLocalStoreTierFromPresentation(preferredLocalStore);

  if (
    persistenceEnvironment.hostProfile === "luker" &&
    persistenceEnvironment.primaryStorageTier === "luker-chat-state" &&
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
      extractionCount: persistedExtractionCount,
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
        extractionCount: persistedExtractionCount,
        graph,
        chatId,
        immediate: true,
      });
      stampGraphPersistenceMeta(graph, {
        revision: acceptedRevision,
        reason: `luker-chat-state:${String(reason || "graph-persist")}`,
        chatId,
        integrity:
          getChatMetadataIntegrity(context) ||
          conversationWorkspace.graphPersistenceState.metadataIntegrity,
      });
      if (isPersistTargetActive()) updateGraphPersistenceState({
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
            Number(conversationWorkspace.graphPersistenceState.indexedDbRevision || 0),
        ),
      });
      if (isPersistTargetActive()) clearPendingGraphPersistRetry();
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
            Number(conversationWorkspace.graphPersistenceState.indexedDbRevision || 0),
        ),
      });
    }
    return buildGraphPersistResult({
      saved: false,
      queued: chatStateResult?.queued === true,
      blocked: chatStateResult?.blocked === true,
      accepted: false,
      recoverable: chatStateResult?.recoverable === true,
      reason: chatStateResult?.reason || `${reason}:luker-primary-save-failed`,
      revision: Number(chatStateResult?.revision || revision || 0),
      saveMode: String(chatStateResult?.saveMode || "luker-chat-state"),
      storageTier: "luker-chat-state",
      acceptedBy: "none",
      primaryTier: persistenceEnvironment.primaryStorageTier,
      cacheTier: persistenceEnvironment.cacheStorageTier,
    });
  }

  let indexedDbResult = null;
  try {
    indexedDbResult = await saveGraphToIndexedDb(chatId, graph, {
      revision,
      reason,
      persistDelta,
      graphSnapshot,
      persistSnapshot,
      sourceGraph: graph,
    });
  } catch (error) {
    if (!isAuthorityModuleUnavailablePersistenceError(error)) throw error;
    return buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "authority-module-unavailable",
      revision,
      storageTier: "none",
      acceptedBy: "none",
      primaryTier: persistenceEnvironment.primaryStorageTier,
      cacheTier: persistenceEnvironment.cacheStorageTier,
    });
  }
  if (indexedDbResult?.saved) {
    persistGraphCommitMarker(context, {
      reason,
      revision: indexedDbResult.revision || revision,
      storageTier: indexedDbResult.storageTier || localStoreTier,
      accepted: true,
      lastProcessedAssistantFloor,
      extractionCount: persistedExtractionCount,
      graph,
      chatId,
      immediate: true,
    });
    if (isPersistTargetActive()) clearPendingGraphPersistRetry();
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

  if (isAuthorityBlockedPersistenceResult(indexedDbResult)) {
    return indexedDbResult;
  }

  return null;
}

function resolvePendingPersistLastProcessedAssistantFloor(graph = conversationWorkspace.graph) {
  const processedRange = Array.isArray(
    graph?.historyState?.lastBatchStatus?.processedRange,
  )
    ? graph.historyState.lastBatchStatus.processedRange
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
    chatId || conversationWorkspace.graphPersistenceState.queuedPersistChatId || conversationWorkspace.graphPersistenceState.chatId,
  );
  const targetRevision = Math.max(
    Number(conversationWorkspace.graphPersistenceState.queuedPersistRevision || 0),
    Number(conversationWorkspace.graphPersistenceState.revision || 0),
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

  const metadataGraph = readLegacyGraphFromChatMetadata(
    normalizedChatId,
    getContext(),
  );
  const metadataRevision = Number(getGraphPersistedRevision(metadataGraph) || 0);
  if (metadataGraph && metadataRevision >= targetRevision) {
    return {
      graph: metadataGraph,
      source: "metadata-full",
      revision: metadataRevision,
    };
  }

  const runtimeGraphChatId = normalizeChatIdCandidate(
    conversationWorkspace.graph?.historyState?.chatId,
  );
  const identity = resolveCurrentChatIdentity(getContext());
  if (
    conversationWorkspace.graph &&
    runtimeGraphChatId &&
    (areChatIdsEquivalentForResolvedIdentity(
      normalizedChatId,
      runtimeGraphChatId,
      identity,
    ) ||
      areChatIdsEquivalentForResolvedIdentity(
        runtimeGraphChatId,
        normalizedChatId,
        identity,
      ))
  ) {
    return {
      graph: conversationWorkspace.graph,
      source: "runtime",
      revision: Math.max(
        Number(getGraphPersistedRevision(conversationWorkspace.graph) || 0),
        targetRevision,
      ),
    };
  }

  return null;
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
  const pendingBatchStatus = conversationWorkspace.graph?.historyState?.lastBatchStatus;
  let promotedPersistedGraph = false;

  if (
    persistenceRecord.accepted === true &&
    persistedGraph &&
    typeof persistedGraph === "object" &&
    !Array.isArray(persistedGraph)
  ) {
    const promotedChatId = normalizeChatIdCandidate(
      persistedGraph?.historyState?.chatId ||
        conversationWorkspace.graphPersistenceState.queuedPersistChatId ||
        conversationWorkspace.graphPersistenceState.chatId ||
        getCurrentChatId(),
    );
    conversationWorkspace.graph = normalizeGraphRuntimeState(
      cloneGraphSnapshot(persistedGraph),
      promotedChatId,
    );
    stampGraphPersistenceMeta(conversationWorkspace.graph, {
      revision: persistenceRecord.revision,
      reason: persistenceRecord.reason || "pending-persist-accepted",
      chatId: promotedChatId,
      integrity: conversationWorkspace.graphPersistenceState.metadataIntegrity,
    });
    conversationWorkspace.extractionCount = Number(
      conversationWorkspace.graph?.historyState?.extractionCount || conversationWorkspace.extractionCount || 0,
    );
    const latestBatchEntry = Array.isArray(conversationWorkspace.graph.batchJournal)
      ? conversationWorkspace.graph.batchJournal[conversationWorkspace.graph.batchJournal.length - 1]
      : null;
    updateLastExtractedItems(latestBatchEntry?.createdNodeIds || []);
    promotedPersistedGraph = true;
  }

  const batchStatus =
    pendingBatchStatus && typeof pendingBatchStatus === "object"
      ? pendingBatchStatus
      : conversationWorkspace.graph?.historyState?.lastBatchStatus;
  if (batchStatus && typeof batchStatus === "object") {
    conversationWorkspace.graph.historyState.lastBatchStatus = reducePersistenceRecordToBatchStatus(
      batchStatus,
      persistenceRecord,
    );
  }

  if (
    persistenceRecord.accepted === true &&
    Number.isFinite(Number(lastProcessedAssistantFloor)) &&
    Number(lastProcessedAssistantFloor) >= 0
  ) {
    const chat = Array.isArray(getContext()?.chat) ? getContext().chat : [];
    const safeFloor = Math.floor(Number(lastProcessedAssistantFloor));
    if (!promotedPersistedGraph && typeof updateProcessedHistorySnapshot === "function") {
      updateProcessedHistorySnapshot(chat, safeFloor);
    } else if (!promotedPersistedGraph) {
      conversationWorkspace.graph.historyState.lastProcessedAssistantFloor = safeFloor;
      conversationWorkspace.graph.lastProcessedSeq = safeFloor;
    }
  }

  if (persistenceRecord.accepted === true) {
    updateGraphPersistenceState(
      reducePersistenceStatePatch(conversationWorkspace.graphPersistenceState, {
        type: PERSISTENCE_EVENT_TYPES.ACCEPTED,
        persistenceRecord,
        clearQueued: false,
      }),
    );
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

function maybeClearAcceptedPendingPersistState(
  source = "accepted-pending-persist-reconcile",
) {
  ensureCurrentGraphRuntimeState();
  if (conversationWorkspace.graphPersistenceState.pendingPersist !== true) {
    return false;
  }

  const batchStatus = conversationWorkspace.graph?.historyState?.lastBatchStatus || null;
  const persistence = batchStatus?.persistence || null;

  const commitMarker = syncCommitMarkerToPersistenceState(getContext());
  const context = getContext();
  const activeChatId = normalizeChatIdCandidate(getCurrentChatId(context));
  const queuedChatId = normalizeChatIdCandidate(
    conversationWorkspace.graphPersistenceState.queuedPersistChatId ||
      conversationWorkspace.graphPersistenceState.chatId ||
      activeChatId,
  );
  const currentIdentity = resolveCurrentChatIdentity(context);
  if (
    !activeChatId ||
    !queuedChatId ||
    (!areChatIdsEquivalentForResolvedIdentity(
      queuedChatId,
      activeChatId,
      currentIdentity,
    ) &&
      !areChatIdsEquivalentForResolvedIdentity(
        activeChatId,
        queuedChatId,
        currentIdentity,
      ))
  ) {
    return false;
  }
  const markerChatId = normalizeChatIdCandidate(commitMarker?.chatId);
  const markerAcceptedRevision = getAcceptedCommitMarkerRevision(commitMarker);
  const markerAcceptedForQueuedChat =
    markerAcceptedRevision > 0 &&
    markerChatId &&
    (areChatIdsEquivalentForResolvedIdentity(markerChatId, queuedChatId, currentIdentity) ||
      areChatIdsEquivalentForResolvedIdentity(
        queuedChatId,
        markerChatId,
        currentIdentity,
      ));
  const plan = planAcceptedPendingClear({
    batchPersistence: persistence,
    persistenceState: conversationWorkspace.graphPersistenceState,
    commitMarker,
    activeChatId,
    queuedChatId,
    markerChatMatchesQueued: markerAcceptedForQueuedChat,
  });
  if (plan.action !== "clear-stale-pending") {
    return false;
  }
  const pendingGraphSource = resolvePendingPersistGraphSource(queuedChatId);
  if (!pendingGraphSource?.graph) {
    return false;
  }

  const acceptedResult = buildGraphPersistResult({
    saved: true,
    accepted: true,
    reason: `${String(source || "accepted-pending-persist-reconcile")}:accepted-revision`,
    revision: plan.targetRevision,
    saveMode: "accepted-revision-reconcile",
    storageTier: plan.tier,
    acceptedBy: plan.tier,
  });
  applyAcceptedPendingPersistState(acceptedResult, {
    lastProcessedAssistantFloor: resolvePendingPersistLastProcessedAssistantFloor(
      pendingGraphSource.graph,
    ),
    persistedGraph: pendingGraphSource.graph,
  });
  clearPendingGraphPersistRetry();
  return true;
}

function schedulePendingGraphPersistRetry(
  reason = "pending-graph-persist-retry",
  attempt = 0,
) {
  if (isRestoreLockActive()) {
    return false;
  }
  if (!conversationWorkspace.graphPersistenceState.pendingPersist) {
    clearPendingGraphPersistRetry();
    return false;
  }

  const targetChatId = normalizeChatIdCandidate(
    conversationWorkspace.graphPersistenceState.queuedPersistChatId ||
      conversationWorkspace.graphPersistenceState.chatId ||
      getCurrentChatId(),
  );
  if (!targetChatId) {
    return false;
  }
  const conversationLease = conversationWorkspace.captureLease();

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
    if (
      pendingGraphPersistRetryChatId !== targetChatId ||
      !conversationWorkspace.isLeaseCurrent(conversationLease, {
        requireGeneration: false,
      })
    ) {
      return;
    }
    void retryPendingGraphPersist({
      reason: `${reason}:attempt-${normalizedAttempt + 1}`,
      retryAttempt: normalizedAttempt,
      scheduleRetryOnFailure: true,
      targetChatId,
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
    revision = conversationWorkspace.graphPersistenceState.revision,
    immediate = false,
    graph = conversationWorkspace.graph,
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
    metadataIntegrity: String(nextIntegrity || conversationWorkspace.graphPersistenceState.metadataIntegrity || ""),
    indexedDbLastError: conversationWorkspace.graphPersistenceState.indexedDbLastError || "",
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
    loadState: conversationWorkspace.graphPersistenceState.loadState,
    revision,
    saveMode,
    storageTier: "metadata-full",
  });
}

function queueGraphPersist(
  reason = "graph-persist-blocked",
  revision = conversationWorkspace.graphPersistenceState.revision,
  {
    immediate = true,
    graph = conversationWorkspace.graph,
    chatId = undefined,
    captureShadow = true,
    recoverableTier = "none",
  } = {},
) {
  const queuedChatId =
    String(chatId || conversationWorkspace.graphPersistenceState.chatId || getCurrentChatId()) || "";
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

  updateGraphPersistenceState(
    reducePersistenceStatePatch(conversationWorkspace.graphPersistenceState, {
      type: PERSISTENCE_EVENT_TYPES.QUEUED,
      reason,
      revision: normalizedRevision,
      chatId: queuedChatId,
      immediate,
      recoverableTier: effectiveRecoverableTier,
    }),
  );
  schedulePendingGraphPersistRetry(String(reason || "graph-persist-blocked"), 0);

  return buildGraphPersistResult({
    queued: true,
    blocked: true,
    accepted: false,
    recoverable: isRecoveryOnlyPersistTier(effectiveRecoverableTier),
    reason,
    loadState: conversationWorkspace.graphPersistenceState.loadState,
    revision: normalizedRevision,
    saveMode: immediate ? "immediate" : "debounced",
    storageTier: effectiveRecoverableTier !== "none" ? effectiveRecoverableTier : "none",
  });
}

function maybeFlushQueuedGraphPersist(reason = "queued-graph-persist") {
  return maybeFlushQueuedGraphPersistImpl(
    createGraphPersistenceIoRuntime(),
    reason,
  );
}

async function retryPendingGraphPersist({
  reason = "pending-graph-persist-retry",
  retryAttempt = 0,
  scheduleRetryOnFailure = false,
  ignoreRestoreLock = false,
  targetChatId = "",
} = {}) {
  return await retryPendingGraphPersistImpl(
    createGraphPersistenceIoRuntime(),
    {
      reason,
      retryAttempt,
      scheduleRetryOnFailure,
      ignoreRestoreLock,
      targetChatId,
    },
  );
}

async function persistExtractionBatchResult(options = {}) {
  return await persistExtractionBatchResultImpl(
    createGraphLoadPersistRuntime(),
    options,
  );
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
  conversationWorkspace.timers.graphLoadRetryChatId =
    normalizedChatId || (allowPendingChat ? GRAPH_LOAD_PENDING_CHAT_ID : "");
  debugDebug(
    `[ST-BME] 图谱元数据尚未就绪，${delayMs}ms 后重试加载（chat=${normalizedChatId || "pending"}，attempt=${attemptIndex + 1}，reason=${reason}）`,
  );

  conversationWorkspace.timers.graphLoadRetry = setTimeout(() => {
    conversationWorkspace.timers.graphLoadRetry = null;
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

  if (conversationWorkspace.graphPersistenceState.loadState !== GRAPH_LOAD_STATES.LOADING) {
    return result;
  }

  const stateChatId = normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId);
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
  conversationWorkspace.runtimeStatus = createGraphLoadUiStatus();
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
  const stateChatId = normalizeChatIdCandidate(conversationWorkspace.graphPersistenceState.chatId);

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
    conversationWorkspace.graphPersistenceState.loadState !== GRAPH_LOAD_STATES.NO_CHAT
  ) {
    return true;
  }

  if (liveChatId && !conversationWorkspace.graphPersistenceState.dbReady) return true;

  return false;
}

function syncGraphLoadFromLiveContext(options = {}) {
  return syncGraphLoadFromLiveContextImpl(
    createGraphLoadPersistRuntime(),
    options,
  );
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
  conversationWorkspace.lastInjectionContent = "";
  conversationWorkspace.lastRecalledItems = [];
  if (!preserveRecallStatus) {
    conversationWorkspace.lastRecallStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
  }
  if (!preserveRuntimeStatus) {
    conversationWorkspace.runtimeStatus = createUiStatus("待命", "当前无有效注入内容", "idle");
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
  if (!conversationWorkspace.isRecalling && !preserveRecallStatus) {
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
  conversationWorkspace.runtimeStatus = createUiStatus(text, meta, level);
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
  conversationWorkspace.lastExtractionStatus = createUiStatus(text, meta, level);
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
  conversationWorkspace.lastVectorStatus = createUiStatus(text, meta, level);
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
  conversationWorkspace.lastRecallStatus = createUiStatus(text, meta, level);
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
    extractionCount: conversationWorkspace.extractionCount,
    lastInjectionContent: conversationWorkspace.lastInjectionContent,
    lastExtractedItems: Array.isArray(conversationWorkspace.lastExtractedItems)
      ? conversationWorkspace.lastExtractedItems.map((item) => ({ ...item }))
      : [],
    lastRecalledItems: Array.isArray(conversationWorkspace.lastRecalledItems)
      ? conversationWorkspace.lastRecalledItems.map((item) => ({ ...item }))
      : [],
    runtimeStatus: { ...(conversationWorkspace.runtimeStatus || {}) },
    lastExtractionStatus: { ...(conversationWorkspace.lastExtractionStatus || {}) },
    lastVectorStatus: { ...(conversationWorkspace.lastVectorStatus || {}) },
    lastRecallStatus: { ...(conversationWorkspace.lastRecallStatus || {}) },
    graphPersistenceState: getGraphPersistenceLiveState(),
  };
}

function restoreRuntimeUiState(snapshot = {}) {
  conversationWorkspace.extractionCount = Number.isFinite(snapshot.extractionCount)
    ? snapshot.extractionCount
    : 0;
  conversationWorkspace.lastInjectionContent = String(snapshot.lastInjectionContent || "");
  conversationWorkspace.lastExtractedItems = Array.isArray(snapshot.lastExtractedItems)
    ? snapshot.lastExtractedItems.map((item) => ({ ...item }))
    : [];
  conversationWorkspace.lastRecalledItems = Array.isArray(snapshot.lastRecalledItems)
    ? snapshot.lastRecalledItems.map((item) => ({ ...item }))
    : [];
  conversationWorkspace.runtimeStatus = {
    ...createInitialUiStatus("runtime"),
    ...(snapshot.runtimeStatus || {}),
  };
  conversationWorkspace.lastExtractionStatus = {
    ...createInitialUiStatus("extraction"),
    ...(snapshot.lastExtractionStatus || {}),
  };
  conversationWorkspace.lastVectorStatus = {
    ...createInitialUiStatus("vector"),
    ...(snapshot.lastVectorStatus || {}),
  };
  conversationWorkspace.lastRecallStatus = {
    ...createInitialUiStatus("recall"),
    ...(snapshot.lastRecallStatus || {}),
  };
  if (snapshot.graphPersistenceState) {
    updateGraphPersistenceState(snapshot.graphPersistenceState);
  }
  refreshPanelLiveState();
}

function getLastProcessedAssistantFloor() {
  const historyFloor = Number(
    conversationWorkspace.graph?.historyState?.lastProcessedAssistantFloor,
  );
  if (Number.isFinite(historyFloor)) {
    return historyFloor;
  }

  const legacySeq = Number(conversationWorkspace.graph?.lastProcessedSeq);
  if (Number.isFinite(legacySeq)) return legacySeq;
  return -1;
}

async function recordGraphMutation({
  beforeSnapshot,
  processedRange = null,
  artifactTags = [],
  syncRange = null,
  signal = undefined,
  extractionCountBefore = conversationWorkspace.extractionCount,
} = {}) {
  ensureCurrentGraphRuntimeState();
  const mutationGraph = conversationWorkspace.graph;
  const mutationChatId = normalizeChatIdCandidate(getCurrentChatId());
  const mutationLastProcessedFloor = getLastProcessedAssistantFloor();
  const mutationRevision =
    Math.max(
      normalizeIndexedDbRevision(conversationWorkspace.graphPersistenceState.revision),
      normalizeIndexedDbRevision(getGraphPersistedRevision(mutationGraph)),
    ) + 1;
  const vectorSync = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(getEmbeddingConfig()) && !syncRange,
    range: syncRange,
    signal,
  });
  const contextChanged =
    conversationWorkspace.graph !== mutationGraph ||
    normalizeChatIdCandidate(getCurrentChatId()) !== mutationChatId;
  const afterSnapshot = cloneGraphSnapshot(mutationGraph);
  const effectiveRange = Array.isArray(processedRange)
    ? processedRange
    : [mutationLastProcessedFloor, mutationLastProcessedFloor];

  appendBatchJournal(
    mutationGraph,
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
  if (contextChanged) {
    const recoverable = maybeCaptureGraphShadowSnapshot(
      "graph-mutation-context-changed",
      {
        graph: mutationGraph,
        chatId: mutationChatId,
        revision: mutationRevision,
      },
    );
    return {
      ...(vectorSync && typeof vectorSync === "object" ? vectorSync : {}),
      aborted: true,
      stale: true,
      recoverable,
      error: vectorSync?.error || "graph-mutation-context-changed",
    };
  }
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
  graph = conversationWorkspace.graph,
} = {}) {
  if (!graph || !beforeSnapshot) return null;
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || getCurrentChatId());

  const entry = createMaintenanceJournalEntry(
    beforeSnapshot,
    cloneGraphSnapshot(graph),
    {
      action,
      mode,
      summary,
    },
  );
  if (!entry) return null;

  appendMaintenanceJournal(graph, entry);
  if (graph === conversationWorkspace.graph) {
    recordMaintenanceDebugSnapshot({
      lastAction: {
        id: entry.id,
        action: entry.action,
        mode: entry.mode,
        summary: entry.summary,
        createdAt: entry.createdAt,
        maintenanceJournalSize: graph.maintenanceJournal?.length || 0,
      },
    });
  }
  return entry;
}

function undoLastMaintenanceAction() {
  if (!conversationWorkspace.graph) {
    return { ok: false, reason: "当前没有加载的图谱", entry: null };
  }

  ensureCurrentGraphRuntimeState();
  const result = undoLatestMaintenance(conversationWorkspace.graph);
  recordMaintenanceDebugSnapshot({
    lastUndoResult: {
      ok: Boolean(result?.ok),
      reason: String(result?.reason || ""),
      action: result?.entry?.action || "",
      summary: result?.entry?.summary || "",
      createdAt: result?.entry?.createdAt || 0,
      maintenanceJournalSize: conversationWorkspace.graph.maintenanceJournal?.length || 0,
      updatedAt: new Date().toISOString(),
    },
  });
  return result;
}

function markGraphVectorStateDirty(
  graph,
  reason = "向量状态已标记为待重建",
) {
  if (!graph) return;
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || getCurrentChatId());
  graph.vectorIndexState.dirty = true;
  graph.vectorIndexState.dirtyReason = reason;
  graph.vectorIndexState.lastWarning = reason;
}

function markVectorStateDirty(reason = "向量状态已标记为待重建") {
  markGraphVectorStateDirty(conversationWorkspace.graph, reason);
}

function updateProcessedHistorySnapshot(chat, lastProcessedAssistantFloor) {
  ensureCurrentGraphRuntimeState();
  applyProcessedHistorySnapshotToGraph(
    conversationWorkspace.graph,
    chat,
    lastProcessedAssistantFloor,
  );
}

function shouldAdvanceProcessedHistory(batchStatus) {
  return shouldAdvanceProcessedHistoryController(batchStatus);
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
  targetGraph = conversationWorkspace.graph,
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

async function syncVectorState(options = {}) {
  const targetGraph =
    options?.graph && typeof options.graph === "object" ? options.graph : null;
  const controllerOptions = { ...(options || {}) };
  delete controllerOptions.graph;
  return await syncVectorStateController(
    {
      ensureCurrentGraphRuntimeState: targetGraph
        ? () => normalizeGraphRuntimeState(
            targetGraph,
            targetGraph?.historyState?.chatId || controllerOptions.expectedChatId || "",
          )
        : ensureCurrentGraphRuntimeState,
      getCurrentGraph: () => targetGraph || conversationWorkspace.graph,
      setLastVectorStatus,
      getEmbeddingConfig,
      validateVectorConfig,
      getVectorIndexStats,
      syncGraphVectorIndex,
      resolveOperationalChatId,
      getContext,
      markVectorStateDirty: targetGraph
        ? (reason) => markGraphVectorStateDirty(targetGraph, reason)
        : markVectorStateDirty,
      isAbortError,
      getRequestHeaders:
        typeof getRequestHeaders === "function" ? getRequestHeaders : undefined,
      console,
    },
    controllerOptions,
  );
}

function scheduleBackgroundVectorSync(task = null, settings = {}) {
  const normalizedTask =
    task && typeof task === "object" && !Array.isArray(task) ? task : {};
  const config = getEmbeddingConfig();
  const chatId = normalizeChatIdCandidate(
    normalizedTask.chatId || getCurrentChatId() || conversationWorkspace.graphPersistenceState.chatId,
  );
  const mode =
    String(
      normalizedTask.mode ||
        resolveMaintenancePostProcessConcurrency(settings).mode ||
        "balanced",
    ).trim() || "balanced";
  const coalesced = backgroundVectorSyncCoalescer.enqueue({
    ...normalizedTask,
    chatId,
    modelScope: getVectorModelScope(config),
    mode,
    reason:
      String(normalizedTask.reason || "background-vector-sync").trim() ||
      "background-vector-sync",
  });
  const scheduledTask = coalesced.task;

  if (!coalesced.scheduled) {
    return {
      queued: true,
      coalesced: true,
      id: scheduledTask.id,
      snapshot: updateBackgroundMaintenanceQueueState(
        typeof backgroundMaintenanceQueue?.getSnapshot === "function"
          ? backgroundMaintenanceQueue.getSnapshot()
          : null,
      ),
    };
  }

  const queuedResult = enqueueBackgroundMaintenanceTask(
    "vector-sync",
    async () => {
      backgroundVectorSyncCoalescer.start(scheduledTask);
      try {
        const activeChatId = normalizeChatIdCandidate(getCurrentChatId());
        if (backgroundVectorSyncCoalescer.isStale(scheduledTask, activeChatId)) {
          return { skipped: true, reason: "stale-background-vector-sync" };
        }
        setLastVectorStatus(
          "后台向量同步中",
          `${scheduledTask.mode} 模式 · 正在同步提取后的向量索引`,
          "running",
          { syncRuntime: false },
        );
        const result = await syncVectorState({
          range: scheduledTask.range,
          expectedChatId: scheduledTask.chatId,
        });
        const completedChatId = normalizeChatIdCandidate(getCurrentChatId());
        if (
          result?.stale ||
          backgroundVectorSyncCoalescer.isStale(
            scheduledTask,
            completedChatId,
          )
        ) {
          return { skipped: true, reason: "stale-background-vector-sync" };
        }
        if (result?.aborted) {
          throw createAbortError(result.error || "后台向量同步已终止");
        }
        if (result?.error) {
          throw new Error(result.error);
        }
        saveGraphToChat({ reason: scheduledTask.reason });
        return result;
      } finally {
        backgroundVectorSyncCoalescer.complete(scheduledTask);
      }
    },
    settings,
    {
      id: scheduledTask.id,
    },
  );
  if (queuedResult?.queued !== true) {
    backgroundVectorSyncCoalescer.drop?.(
      scheduledTask,
      queuedResult?.reason || "background-vector-sync-queue-rejected",
    );
  }
  return queuedResult;
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
  const scheduledChatId = normalizeChatIdCandidate(getCurrentChatId());
  const scheduledGraph = conversationWorkspace.graph;
  const scheduledExtractionCount = conversationWorkspace.extractionCount;
  const isScheduledContextActive = () =>
    conversationWorkspace.graph === scheduledGraph &&
    normalizeChatIdCandidate(getCurrentChatId()) === scheduledChatId;
  const staleResult = () => ({
    skipped: true,
    reason: "stale-background-post-process",
  });
  const mode = resolveMaintenancePostProcessConcurrency(scheduledSettings).mode;
  const taskId = taskList.map((task) => String(task.id || task.type)).join("+");
  return enqueueBackgroundMaintenanceTask(
    "post-process",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!isScheduledContextActive()) return staleResult();
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
            graph: scheduledGraph,
            chat: Array.isArray(payload.chat)
              ? payload.chat
              : typeof getContext === "function" && Array.isArray(getContext()?.chat)
                ? getContext().chat
                : [],
            settings: scheduledSettings,
            currentExtractionCount:
              Number(payload.currentExtractionCount || 0) ||
              scheduledExtractionCount,
            currentAssistantFloor: Number(payload.currentAssistantFloor ?? -1),
            currentRange: Array.isArray(payload.currentRange) ? payload.currentRange : null,
            currentNodeIds: Array.isArray(payload.currentNodeIds) ? payload.currentNodeIds : [],
          });
          if (!isScheduledContextActive()) return staleResult();
          const taskChanged =
            Boolean(result?.smallSummary?.created) ||
            Number(result?.rollup?.createdCount || 0) > 0 ||
            hasPlanCommitChanges(result?.planCommit);
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        } else if (type === "reflection") {
          const result = await runReflectionPostProcessPlanCommit({
            graph: scheduledGraph,
            currentSeq: Number(payload.currentSeq ?? -1),
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            settings: scheduledSettings,
          });
          if (!isScheduledContextActive()) return staleResult();
          const taskChanged =
            Boolean(result?.reflectionId) || hasPlanCommitChanges(result?.planCommit);
          changed = changed || taskChanged;
          details.push({ type, changed: taskChanged, result });
        } else if (type === "compression") {
          const beforeSnapshot =
            typeof cloneGraphSnapshot === "function"
              ? cloneGraphSnapshot(scheduledGraph)
              : clonePlanCommitValue(scheduledGraph, scheduledGraph);
          const result = await runCompressionPostProcessPlanCommit({
            graph: scheduledGraph,
            schema: getSchema(),
            embeddingConfig: getEmbeddingConfig(),
            force: Boolean(payload.force),
            customPrompt: payload.customPrompt ?? undefined,
            settings: scheduledSettings,
          });
          if (!isScheduledContextActive()) return staleResult();
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
      if (!isScheduledContextActive()) return staleResult();
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
  if (!conversationWorkspace.graph) return;
  let metadataWriteAllowed = isGraphMetadataWriteAllowed();
  let mutationContextAllowed = hasRuntimeGraphMutationContext(getContext(), conversationWorkspace.graph, {
    allowNoChatState: true,
  });
  let gate = planVectorReadyCheck({
    hasGraph: Boolean(conversationWorkspace.graph),
    metadataWriteAllowed,
    mutationContextAllowed,
    repairAttempted: false,
    dirty: conversationWorkspace.graph?.vectorIndexState?.dirty === true,
    configValid: true,
  });
  if (gate.action === "skip" || gate.action === "block") return;

  if (gate.action === "repair-identity") {
    repairRuntimeGraphIdentityFromPersistence("向量准备", {
      reason: "vector-ready-fallback",
    });
    metadataWriteAllowed = isGraphMetadataWriteAllowed();
    mutationContextAllowed = hasRuntimeGraphMutationContext(getContext(), conversationWorkspace.graph, {
      allowNoChatState: true,
    });
    gate = planVectorReadyCheck({
      hasGraph: Boolean(conversationWorkspace.graph),
      metadataWriteAllowed,
      mutationContextAllowed,
      repairAttempted: true,
      dirty: conversationWorkspace.graph?.vectorIndexState?.dirty === true,
      configValid: true,
    });
    if (gate.action === "skip" || gate.action === "block") return;
  }

  ensureCurrentGraphRuntimeState({
    chatId: getGraphOwnedChatId(conversationWorkspace.graph) || getCurrentChatId(),
  });

  const config = getEmbeddingConfig();
  const validation = validateVectorConfig(config);
  // Permission/identity gate has already passed above; this final plan only
  // decides whether dirty state + config validity should trigger sync.
  gate = planVectorReadyCheck({
    hasGraph: Boolean(conversationWorkspace.graph),
    metadataWriteAllowed: true,
    mutationContextAllowed: true,
    repairAttempted: true,
    dirty: conversationWorkspace.graph?.vectorIndexState?.dirty === true,
    configValid: validation.valid,
  });
  if (gate.action !== "sync") return;

  const result = await syncVectorState({
    force: true,
    purge: isBackendVectorConfig(config),
    signal,
  });

  if (result?.aborted) return result;
  if (result?.error) {
    conversationWorkspace.graph.vectorIndexState.lastWarning = result.error;
    saveGraphToChat({ reason: "vector-auto-repair-failed" });
    console.warn("[ST-BME] 向量状态自动修复失败:", reason, result.error);
    return result;
  }

  conversationWorkspace.graph.vectorIndexState.lastWarning = "";
  saveGraphToChat({ reason: "vector-auto-repair-succeeded" });
  debugLog("[ST-BME] 向量状态已自动修复:", reason, result.stats);
  return result;
}

async function resetVectorStateForConfigChange(reason = "向量配置已变更") {
  if (!conversationWorkspace.graph) return;
  ensureCurrentGraphRuntimeState();
  markVectorStateDirty(reason);
  for (const node of conversationWorkspace.graph.nodes || []) {
    if (Array.isArray(node?.embedding) && node.embedding.length > 0) {
      node.embedding = null;
    }
  }
  conversationWorkspace.graph.vectorIndexState.hashToNodeId = {};
  conversationWorkspace.graph.vectorIndexState.nodeToHash = {};
  conversationWorkspace.graph.vectorIndexState.currentVectorSpace = null;
  if (
    conversationWorkspace.graph.vectorIndexState.manifest &&
    typeof conversationWorkspace.graph.vectorIndexState.manifest === "object"
  ) {
    conversationWorkspace.graph.vectorIndexState.manifest = {
      ...conversationWorkspace.graph.vectorIndexState.manifest,
      status: "stale",
      lastError: "vector-config-changed",
    };
  }
  conversationWorkspace.graph.vectorIndexState.lastStats = {
    total: Array.isArray(conversationWorkspace.graph.nodes) ? conversationWorkspace.graph.nodes.length : 0,
    indexed: 0,
    stale: 0,
    pending: Array.isArray(conversationWorkspace.graph.nodes) ? conversationWorkspace.graph.nodes.length : 0,
  };
  setLastVectorStatus(
    "向量需要重建",
    `${reason}；旧向量已停用，请点击“重建向量”。如果重建失败，先用“测试 Embedding”检查模型/API key/余额。`,
    "warning",
    { syncRuntime: false },
  );
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
      conversationWorkspace.lastInjectionContent = "";
      conversationWorkspace.lastRecalledItems = [];
      conversationWorkspace.runtimeStatus = createUiStatus(
        "已停用",
        "插件已关闭，注入内容已清空",
        "idle",
      );
      conversationWorkspace.lastExtractionStatus = createUiStatus(
        "已停用",
        "插件已关闭，自动提取已停止",
        "idle",
      );
      conversationWorkspace.lastVectorStatus = createUiStatus(
        "已停用",
        "插件已关闭，向量任务已停止",
        "idle",
      );
      conversationWorkspace.lastRecallStatus = createUiStatus(
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
      if (
        conversationWorkspace.graphPersistenceState.pendingPersist !== true &&
        conversationRepository &&
        typeof conversationRepository.closeAll === "function"
      ) {
        await conversationRepository.closeAll();
      }
      await syncConversationRepositoryWithCurrentChat(
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
  return loadGraphFromChatImpl(
    createGraphLoadPersistRuntime(),
    options,
  );
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
  return await saveGraphToIndexedDbImpl(
    createGraphPersistenceIoRuntime(),
    chatId, graph, { revision, reason, persistRole, scheduleCloudUpload: scheduleCloudUploadOption, persistDelta, graphSnapshot, persistSnapshot, sourceGraph },
  );
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
    conversationWorkspace.graphPersistenceState.persistObservability &&
    typeof conversationWorkspace.graphPersistenceState.persistObservability === "object" &&
    !Array.isArray(conversationWorkspace.graphPersistenceState.persistObservability)
      ? cloneRuntimeDebugValue(conversationWorkspace.graphPersistenceState.persistObservability, {})
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
  return queueGraphPersistToIndexedDbImpl(
    createGraphPersistenceIoRuntime(),
    chatId, graph, { revision, reason, persistRole, scheduleCloudUpload, persistDelta, graphSnapshot, persistSnapshot, graphDetached },
  );
}

function saveGraphToChat(options = {}) {
  return saveGraphToChatImpl(createGraphLoadPersistRuntime(), options);
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
  if (getHostDocument()?.visibilityState === "hidden") {
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
      lastRecallSentUserMessage: readConversationInput(
        "lastRecallSentUserMessage",
      ),
      normalizeRecallInputText,
      pendingRecallSendIntent: readConversationInput(
        "pendingRecallSendIntent",
      ),
    },
  );
}

function buildGenerationAfterCommandsRecallInput(type, params = {}, chat) {
  return rerollRecallInput.buildGenerationAfterCommandsRecallInput(
    type,
    params,
    chat,
  );
}

function createTrivialRecallSkipSentinel(reason = "") {
  return {
    __trivialSkip: true,
    trivialReason: String(reason || ""),
  };
}

function buildNormalGenerationRecallInput(chat, options = {}) {
  return rerollRecallInput.buildNormalGenerationRecallInput(chat, options);
}

function buildHistoryGenerationRecallInput(chat) {
  return rerollRecallInput.buildHistoryGenerationRecallInput(chat);
}

function peekPlannerTurnHandoff(
  chatId = getCurrentChatId(),
  now = Date.now(),
) {
  return rerollRecallInput.peekPlannerTurnHandoff(chatId, now);
}

function clearPlannerTurnHandoffsForChat(
  chatId = getCurrentChatId(),
  { clearAll = false } = {},
) {
  return rerollRecallInput.clearPlannerTurnHandoffsForChat(chatId, {
    clearAll,
  });
}

function preparePlannerTurnHandoff({
  rawUserInput = "",
  plannerAugmentedMessage = "",
  plannerRecall = null,
  plannerPlotRecord = null,
  chatId = getCurrentChatId(),
} = {}) {
  return rerollRecallInput.preparePlannerTurnHandoff({
    rawUserInput,
    plannerAugmentedMessage,
    plannerRecall,
    plannerPlotRecord,
    chatId,
  });
}

function persistPlannerTurnHandoffToUserMessage(newUserMessageIndex) {
  const context = getContext();
  const chat = context?.chat;
  if (
    !Array.isArray(chat) ||
    !Number.isFinite(newUserMessageIndex) ||
    !chat[newUserMessageIndex]?.is_user
  ) {
    return false;
  }
  const chatId = context?.chatId || getCurrentChatId();
  const handoff = rerollRecallInput.consumePlannerTurnHandoffForGeneration(
    chatId,
    conversationSession.getGeneration()?.id,
  );
  if (!handoff) return false;

  const targetUserFloorText = normalizeRecallInputText(
    chat[newUserMessageIndex]?.mes || "",
  );

  let wroteRecall = false;
  const injectionText = String(handoff?.injectionText || "").trim();
  const result = handoff?.result || null;
  if (
    injectionText &&
    result &&
    !readPersistedRecallFromUserMessage(chat, newUserMessageIndex)
  ) {
    wroteRecall = writePersistedRecallToUserMessage(
      chat,
      newUserMessageIndex,
      buildPersistedRecallRecord({
        injectionText,
        selectedNodeIds: result?.selectedNodeIds || [],
        recallInput: String(handoff.rawUserInput || ""),
        recallSource: String(handoff.source || "planner-handoff"),
        hookName: "MESSAGE_SENT",
        tokenEstimate: estimateTokens(injectionText),
        manuallyEdited: false,
        authoritativeInputUsed: true,
        boundUserFloorText: targetUserFloorText,
        historyFingerprint: buildRecallHistoryFingerprint(
          chat,
          newUserMessageIndex,
        ),
      }),
    );
  }

  const plannerPlotRecord = handoff.plannerPlotRecord;
  const wrotePlot = Boolean(
    plannerPlotRecord &&
      writeStructuredPlotRecordToMessage(chat[newUserMessageIndex], {
        ...plannerPlotRecord,
        recallHandoffId:
          handoff.id || plannerPlotRecord.recallHandoffId || "",
      }),
  );
  if (wroteRecall || wrotePlot) {
    triggerChatMetadataSave(context, { immediate: false });
  }
  return wroteRecall || wrotePlot;
}

function buildPreGenerationRecallKey(type, options = {}) {
  return generationRecallTransactionRuntime.buildPreGenerationRecallKey(
    type,
    options,
  );
}

function resolveGenerationRecallDeliveryMode(
  hookName,
  generationType = "normal",
  recallOptions = {},
) {
  return generationRecallTransactionRuntime.resolveGenerationRecallDeliveryMode(
    hookName,
    generationType,
    recallOptions,
  );
}

function findRecentGenerationRecallTransactionForChat(
  chatId = getCurrentChatId(),
) {
  return generationRecallTransactionRuntime.findRecentGenerationRecallTransactionForChat(
    chatId,
  );
}

function markGenerationRecallTransactionHookState(
  transaction,
  hookName,
  state = "completed",
) {
  return generationRecallTransactionRuntime.markGenerationRecallTransactionHookState(
    transaction,
    hookName,
    state,
  );
}

function getGenerationRecallTransactionResult(transaction) {
  return generationRecallTransactionRuntime.getGenerationRecallTransactionResult(
    transaction,
  );
}

function storeGenerationRecallTransactionResult(
  transaction,
  recallResult = null,
  meta = {},
) {
  return generationRecallTransactionRuntime.storeGenerationRecallTransactionResult(
    transaction,
    recallResult,
    meta,
  );
}

function clearGenerationRecallTransactionsForChat(
  chatId = getCurrentChatId(),
  { clearAll = false } = {},
) {
  return generationRecallTransactionRuntime.clearGenerationRecallTransactionsForChat(
    chatId,
    { clearAll },
  );
}
function invalidateRecallAfterHistoryMutation(reason = "聊天记录已变更") {
  if (isRestoreLockActive()) {
    return false;
  }

  const hadActiveRecall = Boolean(
    conversationWorkspace.isRecalling ||
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
  return generationRecallTransactionRuntime.createGenerationRecallContext({
    hookName,
    generationType,
    recallOptions,
    chatId,
  });
}
function getCurrentChatSeq(context = getContext()) {
  const chat = context?.chat;
  if (Array.isArray(chat) && chat.length > 0) {
    return chat.length - 1;
  }
  return conversationWorkspace.graph?.lastProcessedSeq ?? 0;
}

async function handleExtractionSuccess(
  result,
  endIdx,
  settings,
  signal = undefined,
  status = undefined,
  postProcessContext = null,
  taskContext = null,
) {
  const taskGraph = taskContext?.graph || conversationWorkspace.graph;
  const taskBaseGraph = taskContext?.baseGraph || conversationWorkspace.graph;
  let taskExtractionCount = Number.isFinite(
    Number(taskContext?.extractionCountBefore),
  )
    ? Number(taskContext.extractionCountBefore)
    : Number(conversationWorkspace.extractionCount || 0);
  const taskChatId = normalizeChatIdCandidate(
    taskContext?.chatId || getCurrentChatId(),
  );
  const taskLease = taskContext?.conversationLease || null;
  const taskHostContext = getContext();
  const isTaskContextActive = () =>
    conversationWorkspace.graph === taskBaseGraph &&
    (taskLease
      ? conversationWorkspace.isLeaseCurrent(taskLease, {
          requireGeneration: false,
        })
      : !taskChatId ||
        normalizeChatIdCandidate(getCurrentChatId()) === taskChatId);
  const syncTaskVectorState = (options = {}) =>
    isTaskContextActive()
      ? syncVectorState({
          ...options,
          graph: taskGraph,
          expectedChatId: taskChatId,
        })
      : Promise.resolve({
          aborted: true,
          stale: true,
          error: "extraction-context-changed",
        });
  return await handleExtractionSuccessController(
    {
      // local fns
      clonePlanCommitValue,
      consolidateMemories,
      createAbortError,
      createBatchStatusSkeleton,
      ensureCurrentGraphRuntimeState: () =>
        normalizeGraphRuntimeState(taskGraph, taskChatId),
      evaluateAutoConsolidationGate,
      evaluateAutoCompressionSchedule,
      finalizeBatchStatus,
      getContext: () => taskHostContext,
      getEmbeddingConfig,
      getSchema,
      getSummaryStageLabel,
      getVectorIndexStats,
      inspectAutoCompressionCandidates,
      isAbortError,
      noteMaintenanceGate,
      pushBatchStageArtifact,
      resolveMaintenancePostProcessConcurrency,
      runCompressionPostProcessPlanCommit,
      runReflectionPostProcessPlanCommit,
      setBatchStageOutcome,
      setLastExtractionStatus: (...args) =>
        isTaskContextActive() ? setLastExtractionStatus(...args) : null,
      setLastVectorStatus: (...args) =>
        isTaskContextActive() ? setLastVectorStatus(...args) : null,
      shouldDeferExtractionMaintenance,
      shouldDeferExtractionVectorSync,
      sleepCycle,
      syncVectorState: syncTaskVectorState,
      throwIfAborted,
      updateLastExtractedItems: () => null,
      // imported/local maintenance fns
      analyzeAutoConsolidationGate,
      cloneMaintenanceSnapshot: cloneGraphSnapshot,
      persistMaintenanceAction: (...args) =>
        isTaskContextActive()
          ? recordMaintenanceAction({ ...(args[0] || {}), graph: taskGraph })
          : null,
      runSummaryPostProcess: runSummaryPostProcessPlanCommit,
      summarizeMaintenance: buildMaintenanceSummary,
      // state accessors
      getExtractionCount: () => taskExtractionCount,
      setExtractionCount: (n) => { taskExtractionCount = n; },
      getCurrentGraph: () => taskGraph,
      // consts
      EXTRACTION_VECTOR_SYNC_TIMEOUT_MS,
    },
    { result, endIdx, settings, signal, status, postProcessContext },
  );
}
function notifyHistoryDirty(dirtyFrom, reason) {
  notifyHistoryDirtyNotice({ dirtyFrom, reason, updateStageNotice });
}

function clearPendingHistoryMutationChecks() {
  for (const timer of conversationWorkspace.timers.historyMutationChecks) {
    clearTimeout(timer);
  }
  conversationWorkspace.timers.historyMutationChecks = [];
}

function scheduleImmediateHistoryRecovery(
  trigger = "history-change",
  delayMs = HISTORY_RECOVERY_SETTLE_MS,
) {
  if (!getSettings().enabled) return;

  const scheduledChatId = getCurrentChatId();
  conversationWorkspace.timers.historyRecoveryTrigger = trigger;
  clearTimeout(conversationWorkspace.timers.historyRecovery);
  conversationWorkspace.timers.historyRecovery = setTimeout(() => {
    conversationWorkspace.timers.historyRecovery = null;
    const effectiveTrigger = conversationWorkspace.timers.historyRecoveryTrigger || trigger;
    conversationWorkspace.timers.historyRecoveryTrigger = "";
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
  clearTimeout(conversationWorkspace.timers.historyRecovery);
  conversationWorkspace.timers.historyRecovery = null;
  conversationWorkspace.timers.historyRecoveryTrigger = "";

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
      conversationWorkspace.timers.historyMutationChecks =
        conversationWorkspace.timers.historyMutationChecks.filter(
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
        Number.isFinite(conversationWorkspace.graph?.historyState?.historyDirtyFrom)
      ) {
        clearPendingHistoryMutationChecks();
        scheduleImmediateHistoryRecovery(trigger, 0);
      } else if (conversationWorkspace.timers.historyMutationChecks.length === 0) {
        dismissStageNotice("history");
        refreshPanelLiveState();
      }
    }, delayMs);

    conversationWorkspace.timers.historyMutationChecks.push(timer);
  }
}

function clearDeferredHistoryMutationRecheck() {
  if (conversationWorkspace.timers.deferredHistoryMutationRecheck) {
    clearTimeout(conversationWorkspace.timers.deferredHistoryMutationRecheck);
  }
  conversationWorkspace.timers.deferredHistoryMutationRecheck = null;
  conversationWorkspace.timers.deferredHistoryMutationPayload = null;
}

function scheduleDeferredHistoryMutationRecheck(
  trigger = "history-change-deferred",
  primaryArg = null,
  meta = null,
  delayMs = 2500,
) {
  if (!getSettings().enabled) return;
  clearDeferredHistoryMutationRecheck();
  conversationWorkspace.timers.deferredHistoryMutationPayload = { trigger, primaryArg, meta };
  conversationWorkspace.timers.deferredHistoryMutationRecheck = setTimeout(() => {
    const payload = conversationWorkspace.timers.deferredHistoryMutationPayload;
    clearDeferredHistoryMutationRecheck();
    if (!payload) return;
    scheduleHistoryMutationRecheck(payload.trigger, payload.primaryArg, payload.meta);
  }, Math.max(250, Math.floor(Number(delayMs) || 2500)));
}

function flushDeferredHistoryMutationRecheck(reason = "generation-boundary") {
  const payload = conversationWorkspace.timers.deferredHistoryMutationPayload;
  if (!payload) return false;
  clearDeferredHistoryMutationRecheck();
  scheduleHistoryMutationRecheck(`${payload.trigger}:${reason}`, payload.primaryArg, payload.meta);
  return true;
}

function persistHistoryDirtyCheckpoint(reason) {
  void Promise.resolve()
    .then(() => saveGraphToChat({ reason, awaitDurable: true }))
    .catch((error) => {
      console.warn("[ST-BME] 历史脏检查点持久化失败，等待恢复流程重试:", error);
    });
}

function inspectHistoryMutation(
  trigger = "history-change",
  primaryArg = null,
  meta = null,
) {
  if (!conversationWorkspace.graph)
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
    Array.isArray(chat) &&
    conversationWorkspace.graph.historyState?.processedMessageHashesNeedRefresh === true
  ) {
    const lastProcessedFloor = getLastProcessedAssistantFloor();
    const migrationDirtyFloor =
      Number.isFinite(metaDetection?.floor) &&
      metaDetection.floor <= lastProcessedFloor
        ? metaDetection.floor
        : !Number.isFinite(metaDetection?.floor) && lastProcessedFloor >= 0
          ? 0
          : null;
    if (Number.isFinite(migrationDirtyFloor)) {
      const migrationReason = metaDetection
        ? metaReason
        : `${trigger} 发生在历史哈希升级期间，执行保守恢复`;
      clearInjectionState();
      markHistoryDirty(
        conversationWorkspace.graph,
        migrationDirtyFloor,
        migrationReason,
        metaDetection?.source || "hash-version-migration",
      );
      persistHistoryDirtyCheckpoint("history-dirty-hash-version-migration");
      notifyHistoryDirty(migrationDirtyFloor, migrationReason);
      return {
        dirty: true,
        earliestAffectedFloor: migrationDirtyFloor,
        reason: migrationReason,
        source: metaDetection?.source || "hash-version-migration",
      };
    }
    rebindProcessedHistoryStateToChat(
      conversationWorkspace.graph,
      chat,
      getAssistantTurns(chat),
    );
    console.debug?.(
      "[ST-BME] refreshed processed message hashes after hash-version migration",
      {
        trigger,
        lastProcessedAssistantFloor:
          conversationWorkspace.graph.historyState.lastProcessedAssistantFloor ?? -1,
      },
    );
    if (isGraphMetadataWriteAllowed()) {
      saveGraphToChat({ reason: "processed-hash-version-migrated" });
    }
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
  }
  if (
    metaDetection &&
    Number.isFinite(metaDetection.floor) &&
    metaDetection.floor <= getLastProcessedAssistantFloor()
  ) {
    clearInjectionState();
    markHistoryDirty(
      conversationWorkspace.graph,
      metaDetection.floor,
      metaReason,
      metaDetection.source,
    );
    persistHistoryDirtyCheckpoint("history-dirty-meta-detection");
    notifyHistoryDirty(metaDetection.floor, metaReason);
    return {
      dirty: true,
      earliestAffectedFloor: metaDetection.floor,
      reason: metaReason,
      source: metaDetection.source,
    };
  }
  const detection = detectHistoryMutation(chat, conversationWorkspace.graph.historyState);

  if (detection.dirty) {
    clearInjectionState();
    markHistoryDirty(
      conversationWorkspace.graph,
      detection.earliestAffectedFloor,
      detection.reason || trigger,
      "hash-recheck",
    );
    persistHistoryDirtyCheckpoint("history-dirty-hash-recheck");
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
  if (!conversationWorkspace.graph?.vectorIndexState?.collectionId) return;

  const response = await fetchLocalWithTimeout("/api/vector/purge", {
    method: "POST",
    headers: getRequestHeaders(),
    signal,
    body: JSON.stringify({
      collectionId: conversationWorkspace.graph.vectorIndexState.collectionId,
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
      conversationWorkspace.graph.vectorIndexState.hashToNodeId = {};
      conversationWorkspace.graph.vectorIndexState.nodeToHash = {};
    }
    conversationWorkspace.graph.vectorIndexState.dirty = true;
    if (!conversationWorkspace.graph.vectorIndexState.dirtyReason) {
      conversationWorkspace.graph.vectorIndexState.dirtyReason = skipBackendPurge
        ? "history-recovery-replay"
        : "history-recovery-reset";
    }
    if (fullReset) {
      conversationWorkspace.graph.vectorIndexState.replayRequiredNodeIds = [];
      conversationWorkspace.graph.vectorIndexState.pendingRepairFromFloor = 0;
    }
    conversationWorkspace.graph.vectorIndexState.lastWarning = skipBackendPurge
      ? "历史恢复后需要修复受影响后缀的后端向量索引"
      : "历史恢复后需要重建后端向量索引";
    return;
  }

  if (fullReset) {
    conversationWorkspace.graph.vectorIndexState.hashToNodeId = {};
    conversationWorkspace.graph.vectorIndexState.nodeToHash = {};
    conversationWorkspace.graph.vectorIndexState.replayRequiredNodeIds = [];
    conversationWorkspace.graph.vectorIndexState.dirty = true;
    conversationWorkspace.graph.vectorIndexState.dirtyReason = "history-recovery-reset";
    conversationWorkspace.graph.vectorIndexState.pendingRepairFromFloor = 0;
    conversationWorkspace.graph.vectorIndexState.lastWarning =
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
      buildChatHistoryFingerprint,
      buildPersistDelta,
      buildExtractionMessages,
      cloneGraphSnapshot,
      computePostProcessArtifacts,
      console,
      createAbortError,
      createBatchJournalEntry,
      createBatchStatusSkeleton,
      captureConversationLease: (...args) =>
        conversationWorkspace.captureLease(...args),
      ensureCurrentGraphRuntimeState,
      extractMemories,
      finalizeBatchStatus,
      getContext,
      getCurrentGraph: () => conversationWorkspace.graph,
      getCurrentChatId,
      getEmbeddingConfig,
      getExtractionCount: () => conversationWorkspace.extractionCount,
      getLastProcessedAssistantFloor,
      getSettings,
      getSchema,
      handleExtractionSuccess,
      isConversationLeaseCurrent: (...args) =>
        conversationWorkspace.isLeaseCurrent(...args),
      markHistoryDirty,
      persistExtractionBatchResult,
      resolveCurrentChatStateTarget,
      scheduleBackgroundMaintenancePostProcess,
      scheduleBackgroundVectorSync,
      saveGraphToChat,
      setBatchStageOutcome,
      setCurrentGraph: (graph) => { conversationWorkspace.graph = graph; },
      setExtractionCount: (value) => { conversationWorkspace.extractionCount = value; },
      setLastExtractionStatus,
      stampGraphPersistenceMeta,
      shouldAdvanceProcessedHistory,
      throwIfAborted,
      updateLastExtractedItems,
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
  expectedHistoryFingerprint = undefined,
) {
  let replayedBatches = 0;

  while (true) {
    throwIfAborted(signal, "历史恢复已终止");
    assertRecoveryHistoryStillCurrent(
      expectedChatId,
      expectedHistoryFingerprint,
      "replay-loop",
    );
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
    assertRecoveryHistoryStillCurrent(
      expectedChatId,
      expectedHistoryFingerprint,
      "replay-batch-complete",
    );

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
  const vectorState = conversationWorkspace.graph.vectorIndexState;
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
    : conversationWorkspace.graph.historyState?.historyDirtyFrom;
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
  return await rollbackGraphForRerollController(
    {
      applyRecoveryPlanToVectorState,
      assertRecoveryHistoryStillCurrent,
      buildChatHistoryFingerprint,
      buildRecoveryResult,
      buildReverseJournalRecoveryPlan,
      clearInjectionState,
      cloneGraphSnapshot,
      detectHistoryMutation,
      ensureCurrentGraphRuntimeState,
      findJournalRecoveryPoint,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => conversationWorkspace.graph,
      getEmbeddingConfig,
      isBackendVectorConfig,
      markHistoryDirty,
      normalizeGraphRuntimeState,
      prepareVectorStateForReplay,
      pruneProcessedMessageHashesFromFloor,
      refreshPanelLiveState,
      rollbackAffectedJournals,
      saveGraphToChat,
      setCurrentGraph: (graph) => { conversationWorkspace.graph = graph; },
      setExtractionCount: (count) => { conversationWorkspace.extractionCount = count; },
      setLastExtractedItems: (items) => { conversationWorkspace.lastExtractedItems = items; },
      setRuntimeStatus,
      tryDeleteBackendVectorHashesForRecovery,
      updateProcessedHistorySnapshot,
    },
    { targetFloor, context },
  );
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
    if (conversationWorkspace.graph?.vectorIndexState) {
      conversationWorkspace.graph.vectorIndexState.dirty = true;
      conversationWorkspace.graph.vectorIndexState.dirtyReason =
        conversationWorkspace.graph.vectorIndexState.dirtyReason ||
        "history-recovery-replay";
      conversationWorkspace.graph.vectorIndexState.lastWarning =
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
  return await recoverHistoryIfNeededController(
    {
      applyRecoveryPlanToVectorState,
      assertRecoveryHistoryStillCurrent,
      beginStageAbortController,
      buildChatHistoryFingerprint,
      buildRecoveryResult,
      buildReverseJournalRecoveryPlan,
      clampRecoveryStartFloor,
      clearHistoryDirty,
      clearInjectionState,
      cloneGraphSnapshot,
      console,
      createEmptyGraph,
      ensureCurrentGraphRuntimeState,
      enterRestoreLock,
      findJournalRecoveryPoint,
      finishStageAbortController,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => conversationWorkspace.graph,
      getEmbeddingConfig,
      getExtractionCount: () => conversationWorkspace.extractionCount,
      getIsRecoveringHistory: () => conversationWorkspace.isRecoveringHistory,
      getRenderLimitedHistoryRecoveryGuard,
      getSettings,
      inspectHistoryMutation,
      isAbortError,
      isBackendVectorConfig,
      isRestoreLockActive,
      leaveRestoreLock,
      markHistoryDirty,
      maybeResumePendingAutoExtraction,
      normalizeGraphRuntimeState,
      notifyRenderLimitedHistoryRecoveryBlocked,
      prepareVectorStateForReplay,
      queueMicrotask: globalThis.queueMicrotask?.bind?.(globalThis),
      refreshPanelLiveState,
      replayExtractionFromHistory,
      rollbackAffectedJournals,
      saveGraphToChat,
      setCurrentGraph: (graph) => { conversationWorkspace.graph = graph; },
      setExtractionCount: (count) => { conversationWorkspace.extractionCount = count; },
      setIsRecoveringHistory: (value) => { conversationWorkspace.isRecoveringHistory = value; },
      settleExtractionStatusAfterHistoryRecovery,
      throwIfAborted,
      toastr,
      tryDeleteBackendVectorHashesForRecovery,
      updateProcessedHistorySnapshot,
      updateStageNotice,
    },
    { trigger },
  );
}
function settleExtractionStatusAfterHistoryRecovery(
  text = "提取完成",
  meta = "",
  level = "success",
) {
  const statusSnapshot =
    typeof conversationWorkspace.lastExtractionStatus === "object" && conversationWorkspace.lastExtractionStatus
      ? conversationWorkspace.lastExtractionStatus
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
    getCurrentGraph: () => conversationWorkspace.graph,
    getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
    getGraphMutationBlockReason,
    getIsExtracting: () => conversationWorkspace.isExtracting,
    getIsRecoveringHistory: () => conversationWorkspace.isRecoveringHistory,
    getLastProcessedAssistantFloor,
    getSettings,
    getSmartTriggerDecision,
    isAbortError,
    notifyExtractionIssue,
    recoverHistoryIfNeeded,
    resolveAutoExtractionPlan,
    retryPendingGraphPersist,
    setIsExtracting: (value) => {
      conversationWorkspace.isExtracting = value;
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
        conversationWorkspace.graph.lastRecallResult = selectedNodeIds;
      },
      setLastInjectionContent: (value) => {
        conversationWorkspace.lastInjectionContent = value;
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
      conversationWorkspace.graph?.historyState?.activeRegion ||
      conversationWorkspace.graph?.historyState?.lastExtractedRegion ||
      "",
    activeStorySegmentId:
      conversationWorkspace.graph?.historyState?.activeStorySegmentId || "",
    activeStoryTimeLabel:
      conversationWorkspace.graph?.historyState?.activeStoryTimeLabel || "",
    activeCharacterPovOwner:
      conversationWorkspace.graph?.historyState?.activeCharacterPovOwner || "",
    activeUserPovOwner:
      conversationWorkspace.graph?.historyState?.activeUserPovOwner ||
      context.name1 ||
      "",
  };
}

async function runPlannerRecallForEna({
  rawUserInput,
  signal = undefined,
  disableLlmRecall = false,
} = {}) {
  return await runPlannerRecallForEnaController(
    {
      buildRecallRecentMessages,
      buildRecallRetrieveOptions,
      captureConversationLease: (...args) =>
        conversationWorkspace.captureLease(...args),
      clampInt,
      console,
      createAbortError,
      ensureVectorReadyIfNeeded,
      formatInjection,
      getContext,
      getCurrentGraph: () => conversationWorkspace.graph,
      getEmbeddingConfig,
      getSchema,
      getSettings,
      isGraphMetadataWriteAllowed,
      isGraphReadableForRecall,
      isConversationLeaseCurrent: (...args) =>
        conversationWorkspace.isLeaseCurrent(...args),
      isTrivialUserInput,
      normalizeRecallInputText,
      recoverHistoryIfNeeded,
      retrieve,
    },
    {
      rawUserInput,
      signal,
      disableLlmRecall,
    },
  );
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
        normalizeRestoreLockState(conversationWorkspace.graphPersistenceState.restoreLock),
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
      captureConversationLease: (...args) =>
        conversationWorkspace.captureLease(...args),
      clampInt,
      console,
      createAbortError,
      createRecallInputRecord,
      createRecallRunResult,
      ensureVectorReadyIfNeeded,
      finishStageAbortController,
      getActiveRecallPromise: () => conversationWorkspace.activeRecallPromise,
      getContext,
      getCurrentGraph: () => conversationWorkspace.graph,
      getEmbeddingConfig,
      getGraphMutationBlockReason,
      getIsRecalling: () => conversationWorkspace.isRecalling,
      getRecallHookLabel,
      getSchema,
      getSettings,
      isAbortError,
      isConversationLeaseCurrent: (...args) =>
        conversationWorkspace.isLeaseCurrent(...args),
      isGraphMetadataWriteAllowed,
      isGraphReadable,
      isGraphReadableForRecall,
      nextRecallRunSequence: () => ++conversationWorkspace.recallRunSequence,
      readPersistedRecallFromUserMessage,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      resolveRecallInput,
      retrieve,
      schedulePersistedRecallMessageUiRefresh,
      setActiveRecallPromise: (value) => {
        conversationWorkspace.activeRecallPromise = value;
      },
      setIsRecalling: (value) => {
        conversationWorkspace.isRecalling = value;
      },
      setLastRecallStatus,
      setPendingRecallSendIntent: (value) => {
        writeConversationInput("pendingRecallSendIntent", value);
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
  enaPlannerApi?.cancelPlanning?.("chat-changed");
  conversationWorkspace.hostGeneration.running = false;
  conversationWorkspace.hostGeneration.endedAt = 0;
  conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
    forceNewEpoch: true,
    reason: "chat-changed",
  });
  clearDeferredHistoryMutationRecheck();
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
    clearPendingBackgroundVectorSync: () => backgroundVectorSyncCoalescer.clear("chat-changed"),
    clearPendingGraphLoadRetry,
    clearPendingHistoryMutationChecks,
    clearCurrentGenerationTrivialSkip,
    clearRecallInputTracking,
    clearTimeout,
    dismissAllStageNotices,
    getPendingHistoryRecoveryTimer: () => conversationWorkspace.timers.historyRecovery,
    installSendIntentHooks,
    refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
    setLastPreGenerationRecallAt: (value) => {
      conversationWorkspace.hostGeneration.lastPreGenerationRecallAt = value;
    },
    setLastPreGenerationRecallKey: (value) => {
      conversationWorkspace.hostGeneration.lastPreGenerationRecallKey = value;
    },
    setPendingHistoryRecoveryTimer: (value) => {
      conversationWorkspace.timers.historyRecovery = value;
    },
    setPendingHistoryRecoveryTrigger: (value) => {
      conversationWorkspace.timers.historyRecoveryTrigger = value;
    },
    setSkipBeforeCombineRecallUntil: (value) => {
      conversationWorkspace.hostGeneration.skipBeforeCombineRecallUntil = value;
    },
    syncGraphLoadFromLiveContext,
  });

  scheduleBmeIndexedDbTask(async () => {
    const syncResult = await syncConversationRepositoryWithCurrentChat("chat-changed");
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
  enaPlannerApi?.cancelPlanning?.("chat-loaded");
  conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
    reason: "chat-loaded",
  });
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
    const syncResult = await syncConversationRepositoryWithCurrentChat("chat-loaded");
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
      persistPlannerTurnHandoffToUserMessage,
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
  conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
    reason: "message-deleted",
  });
  const result = onMessageDeletedController(
    {
      checkpointHistoryMutation: inspectHistoryMutation,
      getGenerationContext: () => conversationSession.getGeneration(),
      getContext,
      invalidateRecallAfterHistoryMutation,
      markGenerationContextExpectedMutation: (...args) =>
        conversationSession.markExpectedMutation(...args),
      noteAssistantTailDelete: (...args) =>
        conversationSession.noteAssistantTailDelete(...args),
      refreshPersistedRecallMessageUi: schedulePersistedRecallMessageUiRefresh,
      scheduleDeferredHistoryMutationRecheck,
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
      checkpointHistoryMutation: inspectHistoryMutation,
      invalidateRecallAfterHistoryMutation,
      isMvuExtraAnalysisGuardActive,
      removeMessageRecallRecord,
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
  conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
    reason: "message-swiped",
  });
  conversationSession.noteSwipe(messageId, meta);
  const result = await onMessageSwipedController(
    {
      checkpointHistoryMutation: inspectHistoryMutation,
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
      ...(conversationWorkspace.graphPersistenceState.projectionState?.runtime || {}),
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
  if (String(conversationWorkspace.graphPersistenceState.projectionState?.runtime?.status || "") === "pending") {
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
    conversationWorkspace.graphPersistenceState.projectionState?.runtime?.status === "pending"
  ) {
    payload.requestRescan = true;
    const reason =
      conversationWorkspace.graphPersistenceState.projectionState?.runtime?.reason ||
      "runtime-projection-pending";
    updateGraphPersistenceState({
      lastRequestRescanReason: String(reason || ""),
    });
    updateLukerProjectionState({
      runtime: {
        ...(conversationWorkspace.graphPersistenceState.projectionState?.runtime || {}),
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
  conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
    reason: "generation-started",
  });
  const generationType = String(type || "normal").trim() || "normal";
  const pendingRecallSendIntent = readConversationInput(
    "pendingRecallSendIntent",
  );
  const freshInputHint = Boolean(
    pendingRecallSendIntent?.text || pendingRecallSendIntent?.rawText,
  );
  conversationSession.beginGeneration(
    generationType,
    {
      ...params,
      __stBmeFreshInputHint: freshInputHint,
    },
    {
    dryRun,
    phase: "GENERATION_STARTED",
    },
  );
  if (
    !dryRun &&
    !params?.automatic_trigger &&
    !params?.quiet_prompt &&
    generationType === "normal"
  ) {
    conversationWorkspace.hostGeneration.running = true;
    conversationWorkspace.hostGeneration.endedAt = 0;
  }
  return onGenerationStartedController(
    {
      clearDryRunPromptPreview,
      clearCurrentGenerationTrivialSkip,
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      freezeHostGenerationInputSnapshot,
      getContext,
      getPendingRecallSendIntent: () =>
        readConversationInput("pendingRecallSendIntent"),
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
  conversationWorkspace.hostGeneration.running = false;
  conversationWorkspace.hostGeneration.endedAt = Date.now();
  if (isLukerPrimaryPersistenceHost(getContext())) {
    updateLukerProjectionState({
      runtime: {
        ...(conversationWorkspace.graphPersistenceState.projectionState?.runtime || {}),
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
  flushDeferredHistoryMutationRecheck("generation-ended");
  conversationSession.clearGeneration("generation-ended");
}

async function onGenerationAfterCommands(type, params = {}, dryRun = false) {
  conversationWorkspace.enterChat(resolveCurrentChatIdentity(), {
    reason: "generation-after-commands",
  });
  conversationSession.updateGeneration(type, params, {
    dryRun,
    phase: "GENERATION_AFTER_COMMANDS",
  });
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
      getGenerationContext: () => conversationSession.getGeneration(),
      getContext,
      getGenerationRecallHookStateFromResult,
      getGenerationRecallTransactionResult,
      getCurrentChatId,
      getPendingRecallSendIntent: () =>
        readConversationInput("pendingRecallSendIntent"),
      isFreshRecallInputRecord,
      isMvuExtraAnalysisGuardActive,
      isTavernHelperPromptViewerRefreshActive,
      markCurrentGenerationTrivialSkip,
      markGenerationRecallTransactionHookState,
      reapplyPersistedRecallBlock,
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
      buildGenerationAfterCommandsRecallInput,
      buildHistoryGenerationRecallInput,
      buildNormalGenerationRecallInput,
      clearPendingHostGenerationInputSnapshot,
      clearPendingRecallSendIntent,
      clearLiveRecallInjectionPromptForRewrite,
      consumeDryRunPromptPreview,
      consumeHostGenerationInputSnapshot,
      createGenerationRecallContext,
      getGenerationContext: () => conversationSession.getGeneration(),
      getContext,
      getGenerationRecallHookStateFromResult,
      getGenerationRecallTransactionResult,
      getCurrentChatId,
      getPendingRecallSendIntent: () =>
        readConversationInput("pendingRecallSendIntent"),
      isFreshRecallInputRecord,
      isMvuExtraAnalysisGuardActive,
      isTavernHelperPromptViewerRefreshActive,
      markCurrentGenerationTrivialSkip,
      markGenerationRecallTransactionHookState,
      reapplyPersistedRecallBlock,
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
    getCurrentGraph: () => conversationWorkspace.graph,
    getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
    getIsHostGenerationRunning: () => conversationWorkspace.hostGeneration.running,
    getLastProcessedAssistantFloor,
    getPendingHostGenerationInputSnapshot,
    getPendingRecallSendIntent: () =>
      readConversationInput("pendingRecallSendIntent"),
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
      writeConversationInput("pendingHostGenerationInputSnapshot", record);
    },
    setPendingRecallSendIntent: (record) => {
      writeConversationInput("pendingRecallSendIntent", record);
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
    getCurrentGraph: () => conversationWorkspace.graph,
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
        getCurrentGraph: () => conversationWorkspace.graph,
        getSettings,
        normalizeGraphRuntimeState,
        prepareVectorStateForReplay,
        refreshPanelLiveState,
        replayExtractionFromHistory,
        restoreRuntimeUiState,
        saveGraphToChat,
        updateProcessedHistorySnapshot,
        setCurrentGraph: (graph) => {
          conversationWorkspace.graph = graph;
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
    getCurrentGraph: () => conversationWorkspace.graph,
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
  if (!nodeId || !updates || typeof updates !== "object" || !conversationWorkspace.graph) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!getNode(conversationWorkspace.graph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }
  const updated = updateNode(conversationWorkspace.graph, nodeId, updates);
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
  if (!nodeId || !conversationWorkspace.graph) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!getNode(conversationWorkspace.graph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }
  const removed = removeNode(conversationWorkspace.graph, nodeId);
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

  if (!conversationWorkspace.graph || !nodeId || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("认知覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  if (!["known", "hidden", "mistaken"].includes(mode)) {
    return { ok: false, error: "invalid-mode" };
  }
  if (!getNode(conversationWorkspace.graph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }

  const result = applyManualKnowledgeOverride(conversationWorkspace.graph, {
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

  if (!conversationWorkspace.graph || !nodeId || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("认知覆盖清理", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  if (!getNode(conversationWorkspace.graph, nodeId)) {
    return { ok: false, error: "node-not-found" };
  }

  const result = clearManualKnowledgeOverride(conversationWorkspace.graph, {
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
  if (!conversationWorkspace.graph || !ownerKey || !nextName) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("角色认知重命名", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = renameKnowledgeOwner(conversationWorkspace.graph, ownerKey, nextName);
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
  if (!conversationWorkspace.graph || !sourceOwnerKey || !targetOwnerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("角色认知合并", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = mergeKnowledgeOwners(conversationWorkspace.graph, {
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
  if (!conversationWorkspace.graph || !ownerKey) {
    return { ok: false, error: "invalid-payload" };
  }
  if (!ensureGraphMutationReady("角色认知删除", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = deleteKnowledgeOwner(conversationWorkspace.graph, ownerKey, { mode });
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
  if (!conversationWorkspace.graph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("地区覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = setManualActiveRegion(conversationWorkspace.graph, region);
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
  if (!conversationWorkspace.graph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("剧情时间覆盖", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  const result = setManualActiveStorySegment(conversationWorkspace.graph, { label });
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
  if (!conversationWorkspace.graph) {
    return { ok: false, error: "missing-graph" };
  }
  if (!ensureGraphMutationReady("剧情时间覆盖清理", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }
  const result = clearManualActiveStorySegment(conversationWorkspace.graph);
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
    conversationWorkspace.graph?.historyState?.activeRegion ||
    conversationWorkspace.graph?.regionState?.manualActiveRegion ||
    "";
  const region = String(payload.region || fallbackRegion).trim();
  const adjacent = Array.isArray(payload.adjacent)
    ? payload.adjacent
    : String(payload.adjacent || "")
        .split(/[,\n，]/)
        .map((value) => String(value || "").trim())
        .filter(Boolean);

  if (!conversationWorkspace.graph || !region) {
    return { ok: false, error: "missing-region" };
  }
  if (!ensureGraphMutationReady("地区邻接编辑", { notify: false })) {
    return { ok: false, error: "graph-write-blocked" };
  }

  const result = updateRegionAdjacencyManual(conversationWorkspace.graph, region, adjacent);
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
    document: getHostDocument(),
    exportGraph,
    getCurrentGraph: () => conversationWorkspace.graph,
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
        document: getHostDocument(),
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
          conversationWorkspace.graph = graph;
        },
        setExtractionCount: (value) => {
          conversationWorkspace.extractionCount = value;
        },
        setLastExtractedItems: (items) => {
          conversationWorkspace.lastExtractedItems = items;
        },
        toastr,
        updateLastRecalledItems,
        window: getHostWindow(),
      }),
  );
}

async function onViewLastInjection() {
  return await onViewLastInjectionController({
    document: getHostDocument(),
    getLastInjectionContent: () => conversationWorkspace.lastInjectionContent,
    toastr,
  });
}

async function onTestEmbedding() {
  return await onTestEmbeddingController({
    getCurrentChatId,
    getEmbeddingConfig,
    getSettings,
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
      getCurrentGraph: () => conversationWorkspace.graph,
      getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
      getIsExtracting: () => conversationWorkspace.isExtracting,
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      normalizeGraphRuntimeState,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      retryPendingGraphPersist,
      setCurrentGraph: (graph) => {
        conversationWorkspace.graph = graph;
      },
      setIsExtracting: (value) => {
        conversationWorkspace.isExtracting = value;
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
      buildRecoveryResult,
      clampInt,
      clearHistoryDirty,
      console,
      createEmptyGraph,
      ensureGraphMutationReady,
      executeExtractionBatch,
      finishStageAbortController,
      getAssistantTurns,
      getContext,
      getCurrentChatId,
      getCurrentGraph: () => conversationWorkspace.graph,
      getGraphMutationBlockReason,
      getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
      getIsExtracting: () => conversationWorkspace.isExtracting,
      getLastExtractionStatusLevel: () => conversationWorkspace.lastExtractionStatus?.level || "idle",
      getLastProcessedAssistantFloor,
      getSettings,
      isAbortError,
      markHistoryDirty,
      normalizeGraphRuntimeState,
      onManualExtract,
      recoverHistoryIfNeeded,
      refreshPanelLiveState,
      retryPendingGraphPersist,
      rollbackGraphForReroll,
      saveGraphToChat,
      setCurrentGraph: (graph) => {
        conversationWorkspace.graph = graph;
      },
      setIsExtracting: (value) => {
        conversationWorkspace.isExtracting = value;
      },
      setLastExtractionStatus,
      setRuntimeStatus,
      toastr,
      updateProcessedHistorySnapshot,
    },
    options,
  );
}

async function onReroll({ fromFloor } = {}) {
  return await onRerollController(
    {
      console,
      buildRecoveryResult,
      clearHistoryDirty,
      ensureGraphMutationReady,
      getAssistantTurns,
      getContext,
      getCurrentGraph: () => conversationWorkspace.graph,
      getGraphMutationBlockReason,
      getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
      getIsExtracting: () => conversationWorkspace.isExtracting,
      getLastExtractionStatusLevel: () => conversationWorkspace.lastExtractionStatus?.level || "idle",
      getLastProcessedAssistantFloor,
      isAbortError,
      markHistoryDirty,
      onManualExtract,
      refreshPanelLiveState,
      rollbackGraphForReroll,
      saveGraphToChat,
      setLastExtractionStatus,
      setRuntimeStatus,
      toastr,
      updateProcessedHistorySnapshot,
    },
    { fromFloor },
  );
}

async function onManualSleep() {
  return await onManualSleepController({
    buildMaintenanceSummary,
    cloneGraphSnapshot,
    ensureGraphMutationReady,
    getCurrentGraph: () => conversationWorkspace.graph,
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
    getCurrentGraph: () => conversationWorkspace.graph,
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
    getCurrentGraph: () => conversationWorkspace.graph,
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
          getCurrentGraph: () => conversationWorkspace.graph,
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
    getCurrentGraph: () => conversationWorkspace.graph,
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
    getCurrentGraph: () => conversationWorkspace.graph,
    getEmbeddingConfig,
    getLastExtractedItems: () => conversationWorkspace.lastExtractedItems,
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
    getCurrentGraph: () => conversationWorkspace.graph,
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
      getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
      getGraphMutationBlockReason,
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
  getCurrentGraph: () => conversationWorkspace.graph,
  setLastVectorStatus,
  markVectorStateDirty: (reason) => {
    if (conversationWorkspace.graph?.vectorIndexState) {
      conversationWorkspace.graph.vectorIndexState.dirty = true;
      conversationWorkspace.graph.vectorIndexState.dirtyReason = reason;
      conversationWorkspace.graph.vectorIndexState.lastWarning = reason;
    }
  },
  normalizeGraphRuntimeState,
  refreshPanelLiveState,
  removeNode: (graph, nodeId) => removeNode(graph, nodeId),
  saveGraphToChat,
  syncGraphLoadFromLiveContext,
  setCurrentGraph: (graph) => { conversationWorkspace.graph = graph; },
  setRuntimeStatus,
  setExtractionCount: (count) => {
    if (conversationWorkspace.graph?.historyState) {
      conversationWorkspace.graph.historyState.extractionCount = count;
    }
  },
  setLastExtractedItems: () => { conversationWorkspace.lastExtractedItems = []; },
  buildBmeDbName,
  buildRestoreSafetyDbName: (chatId) =>
    buildBmeDbName(buildRestoreSafetyChatId(chatId)),
  buildRestoreSafetyChatId,
  closeBmeDb: async (chatId) => {
    const normalizedChatId = normalizeChatIdCandidate(chatId);
    if (!normalizedChatId || !conversationRepository) return;
    if (
      typeof conversationRepository.getCurrentChatId === "function" &&
      conversationRepository.getCurrentChatId() === normalizedChatId &&
      typeof conversationRepository.closeCurrent === "function"
    ) {
      await conversationRepository.closeCurrent();
    }
  },
  closeAllBmeDbs: async () => {
    if (conversationRepository && typeof conversationRepository.closeAll === "function") {
      await conversationRepository.closeAll();
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
  getGraphPersistenceState: () => conversationWorkspace.graphPersistenceState,
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
  const hadPending = conversationWorkspace.graphPersistenceState.pendingPersist === true;
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

  if (conversationWorkspace.graphPersistenceState.loadState === GRAPH_LOAD_STATES.LOADING) {
    toastr.info("已重新探测当前聊天图谱，正在等待本地持久化加载");
    return { handledToast: true, result };
  }

  if (conversationWorkspace.graphPersistenceState.loadState === GRAPH_LOAD_STATES.BLOCKED) {
    toastr.warning(
      `当前图谱仍处于保护模式: ${conversationWorkspace.graphPersistenceState.reason || "metadata not ready"}`,
    );
    return { handledToast: true, result };
  }

  toastr.success("已重新探测当前聊天图谱");
  return { handledToast: true, result };
}

async function onRebuildLocalCacheFromLukerSidecar() {
  return await onRebuildLocalCacheFromLukerSidecarImpl(createGraphLoadPersistRuntime());
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
    (!conversationWorkspace.graph || normalizeChatIdCandidate(getGraphOwnedChatId(conversationWorkspace.graph)) !== normalizeChatIdCandidate(chatId)) &&
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
    graph: cloneGraphForPersistence(conversationWorkspace.graph, chatId),
    chatId,
    revision: Math.max(
      Number(conversationWorkspace.graphPersistenceState.lukerManifestRevision || 0),
      Number(getGraphPersistedRevision(conversationWorkspace.graph) || 0),
      Number(conversationWorkspace.graphPersistenceState.revision || 0),
    ),
    reason: "panel-manual-luker-sidecar-repair",
    integrity:
      getChatMetadataIntegrity(context) || conversationWorkspace.graphPersistenceState.metadataIntegrity,
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
  if (!chatId || !conversationWorkspace.graph) {
    toastr.warning("当前没有可压实的图谱");
    return { handledToast: true, reason: "missing-graph" };
  }

  if (
    normalizeChatIdCandidate(getGraphOwnedChatId(conversationWorkspace.graph)) !==
      normalizeChatIdCandidate(chatId) &&
    !(await loadGraphFromLukerSidecarV2(chatId, {
      source: "panel-manual-luker-sidecar-compact",
      allowOverride: true,
      chatStateTarget,
    }))?.loaded
  ) {
    toastr.warning("当前图谱不属于这个聊天，且无法从 Luker 主 sidecar 重新加载，未执行压实");
    return { handledToast: true, reason: "sidecar-load-failed" };
  }

  const result = await compactLukerGraphSidecarV2(context, {
    graph: cloneGraphForPersistence(conversationWorkspace.graph, chatId),
    chatId,
    revision: Math.max(
      Number(conversationWorkspace.graphPersistenceState.lukerManifestRevision || 0),
      Number(getGraphPersistedRevision(conversationWorkspace.graph) || 0),
      Number(conversationWorkspace.graphPersistenceState.revision || 0),
    ),
    reason: "panel-manual-luker-sidecar-compact",
    integrity:
      getChatMetadataIntegrity(context) || conversationWorkspace.graphPersistenceState.metadataIntegrity,
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
      getPlannerApi: () => enaPlannerApi,
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
    document: getHostDocument(),
    getGraph: () => conversationWorkspace.graph,
    getGraphPersistenceState: () => getGraphPersistenceLiveState(),
    getHideStateSnapshot: () => getMessageHideStateSnapshotForPanel(),
    getLastBatchStatus: () =>
      conversationWorkspace.graph?.historyState?.lastBatchStatus || null,
    getLastExtract: () => conversationWorkspace.lastExtractedItems,
    getLastExtractionStatus: () => conversationWorkspace.lastExtractionStatus,
    getLastInjection: () => conversationWorkspace.lastInjectionContent,
    getLastRecall: () => conversationWorkspace.lastRecalledItems,
    getLastRecallStatus: () => conversationWorkspace.lastRecallStatus,
    getLastVectorStatus: () => conversationWorkspace.lastVectorStatus,
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
    ensureConversationRepository();
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
      const syncResult = await syncConversationRepositoryWithCurrentChat("initial-load");
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
    enaPlannerApi = await initEnaPlanner({
      captureConversationLease: (...args) =>
        conversationWorkspace.captureLease(...args),
      getContext,
      getExtensionPath: () => `scripts/extensions/third-party/${MODULE_NAME}`,
      getPlannerRecallTimeoutMs,
      getSettings,
      isConversationLeaseCurrent: (...args) =>
        conversationWorkspace.isLeaseCurrent(...args),
      isTrivialUserInput,
      preparePlannerTurnHandoff,
      runPlannerRecallForEna,
      shouldSendOnEnter: () => {
        const decision = getContext()?.shouldSendOnEnter?.();
        return decision == null ? true : decision === true;
      },
    });
    _panelModule?.refreshPlannerState?.();
    debugLog("[ST-BME] Ena Planner module loaded");
  } catch (error) {
    console.warn("[ST-BME] Ena Planner module load failed:", error);
  }
  debugLog("[ST-BME] 初始化完成");
})();
