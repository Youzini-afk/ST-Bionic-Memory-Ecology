// Extracted graph mutation gate and graph persistence debug projection helpers.
// Dependencies are supplied by index.js/test harnesses through runtime.

export function readRuntimeDebugSnapshotImpl(runtime, ) {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

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

export function getGraphPersistenceLiveStateImpl(runtime, ) {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

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

export function getPanelRuntimeStatusImpl(runtime, ) {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

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

export function getGraphMutationBlockReasonImpl(runtime, operationLabel = "当前操作") {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

  if (isRestoreLockActive()) {
    return getRestoreLockMessage(operationLabel);
  }
  const loadState = graphPersistenceState.loadState;
  const hasRuntimeFallback = hasRuntimeGraphMutationContext(getContext());
  if (!getCurrentChatId() && !hasRuntimeFallback) {
    return `${operationLabel}已暂停：当前尚未进入聊天。`;
  }

  if (
    graphPersistenceState.dbReady ||
    isGraphLoadStateDbReady(loadState) ||
    hasRuntimeFallback
  ) {
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

export function applyGraphLoadStateImpl(runtime, loadState, {
    chatId = runtime.getCurrentChatId(),
    reason = "",
    attemptIndex = 0,
    shadowSnapshotUsed = false,
    shadowSnapshotRevision = 0,
    shadowSnapshotUpdatedAt = "",
    shadowSnapshotReason = "",
    revision = (runtime.getGraphPersistenceState?.() || {}).revision,
    lastPersistedRevision = (runtime.getGraphPersistenceState?.() || {}).lastPersistedRevision,
    queuedPersistRevision = (runtime.getGraphPersistenceState?.() || {}).queuedPersistRevision,
    pendingPersist = (runtime.getGraphPersistenceState?.() || {}).pendingPersist,
    dbReady = runtime.isGraphLoadStateDbReady(loadState),
    writesBlocked = !runtime.isGraphMetadataWriteAllowed(loadState),
    storagePrimary = (runtime.getGraphPersistenceState?.() || {}).storagePrimary || "indexeddb",
    storageMode =
      (runtime.getGraphPersistenceState?.() || {}).storageMode || runtime.BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB,
    hostProfile = (runtime.getGraphPersistenceState?.() || {}).hostProfile || runtime.resolvePersistenceHostProfile(),
    primaryStorageTier =
      (runtime.getGraphPersistenceState?.() || {}).primaryStorageTier ||
      runtime.buildPersistenceEnvironment(runtime.getContext(), {
        storagePrimary,
        storageMode,
      }).primaryStorageTier,
    cacheStorageTier =
      (runtime.getGraphPersistenceState?.() || {}).cacheStorageTier ||
      runtime.buildPersistenceEnvironment(runtime.getContext(), {
        storagePrimary,
        storageMode,
      }).cacheStorageTier,
  } = {},
) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) { return (runtime.getGraphPersistenceState?.() || {})[key]; },
    set(_target, key, value) { const state = runtime.getGraphPersistenceState?.() || {}; state[key] = value; return true; },
  });
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const maybeResumePendingAutoExtraction = runtime.maybeResumePendingAutoExtraction;
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

export function ensureGraphMutationReadyImpl(runtime, 
  operationLabel = "当前操作",
  { notify = true, ignoreRestoreLock = false, allowRuntimeGraphFallback = false } = {},
) {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

  if (!ignoreRestoreLock && isRestoreLockActive()) {
    if (notify) {
      toastr.info(getRestoreLockMessage(operationLabel), "ST-BME");
    }
    return false;
  }
  if (allowRuntimeGraphFallback === true) {
    repairRuntimeGraphIdentityFromPersistence(operationLabel, {
      reason: "graph-mutation-ready-fallback",
    });
  }
  if (
    graphPersistenceState.dbReady ||
    isGraphLoadStateDbReady() ||
    (allowRuntimeGraphFallback === true &&
      hasRuntimeGraphMutationContext(getContext(), currentGraph, {
        allowNoChatState: true,
      }))
  ) {
    return true;
  }
  if (notify) {
    toastr.info(getGraphMutationBlockReason(operationLabel), "ST-BME");
  }
  return false;

}

export function assertRecoveryChatStillActiveImpl(runtime, expectedChatId, label = "") {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

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

export function buildPanelOpenLocalStoreRefreshPlanImpl(runtime, 
  context = runtime.getContext(),
  settings = runtime.getSettings(),
) {
  const graphPersistenceState = runtime.getGraphPersistenceState?.() || {};
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const runtimeStatus = runtime.getRuntimeStatus?.();
  const bmeLocalStoreCapabilitySnapshot = runtime.getBmeLocalStoreCapabilitySnapshot?.() || {};
  const AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT = runtime.AUTHORITY_DIAGNOSTICS_MANIFEST_LIMIT;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createAbortError = runtime.createAbortError;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const doesChatIdMatchResolvedGraphIdentity = runtime.doesChatIdMatchResolvedGraphIdentity;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphMutationBlockReason = runtime.getGraphMutationBlockReason;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getRestoreLockMessage = runtime.getRestoreLockMessage;
  const getRuntimeDebugState = runtime.getRuntimeDebugState;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const hasRuntimeGraphMutationContext = runtime.hasRuntimeGraphMutationContext;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphSyncState = runtime.normalizeGraphSyncState;
  const normalizePersistenceHostProfile = runtime.normalizePersistenceHostProfile;
  const normalizePersistenceStorageTier = runtime.normalizePersistenceStorageTier;
  const normalizeRestoreLockState = runtime.normalizeRestoreLockState;
  const readGraphCommitMarker = runtime.readGraphCommitMarker;
  const repairRuntimeGraphIdentityFromPersistence = runtime.repairRuntimeGraphIdentityFromPersistence;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const syncBmeHostRuntimeFlags = runtime.syncBmeHostRuntimeFlags;
  const toastr = runtime.toastr;
  const console = runtime.console || globalThis.console;

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
