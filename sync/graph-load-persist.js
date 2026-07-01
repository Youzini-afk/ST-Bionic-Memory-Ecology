// Extracted graph load/persist and Authority routing orchestration helpers.
// Dependencies are supplied by index.js/test harnesses through runtime.

import {
  GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
  normalizeGraphAuthorityMeta,
} from "./authority-graph-mode.js";

function isAuthorityPersistenceLocked(state = {}, snapshot = null) {
  const meta = normalizeGraphAuthorityMeta({
    authorityOwned: state?.authorityOwned === true || snapshot?.meta?.authorityOwned === true,
    graphOperationalMode: state?.graphOperationalMode || snapshot?.meta?.graphOperationalMode,
  });
  return meta.authorityOwned || meta.graphOperationalMode === GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED;
}

function isAuthorityModuleUnavailableError(error = null) {
  return Boolean(
    error &&
      (error.name === "AuthorityGraphModuleUnavailableError" ||
        String(error?.code || error?.payload?.code || "").toLowerCase() === "authority_module_unavailable"),
  );
}

function isAuthorityLockedPersistResult(result = null) {
  if (!result || typeof result !== "object") return false;
  const mode = String(result.graphOperationalMode || result.meta?.graphOperationalMode || "").toLowerCase();
  const reason = String(result.reason || result.code || result.payload?.code || "").toLowerCase();
  return (
    result.authorityOwned === true ||
    mode === GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED ||
    reason.includes("authority_module_unavailable") ||
    reason.includes("authority-module-unavailable") ||
    isAuthorityModuleUnavailableError(result.error)
  );
}

function hasExtractionCommitBatchData(options = {}) {
  return Boolean(
    options?.persistDelta &&
      options?.committedBatchJournalEntry,
  );
}

function resolveAuthorityExtractionMeta(graphPersistenceState = {}, persistSnapshot = null, db = null) {
  return normalizeGraphAuthorityMeta({
    authorityOwned: graphPersistenceState?.authorityOwned === true || persistSnapshot?.meta?.authorityOwned === true || db?.authorityOwned === true,
    graphOperationalMode: graphPersistenceState?.graphOperationalMode || persistSnapshot?.meta?.graphOperationalMode || db?.graphOperationalMode,
  });
}

function shouldRouteExtractionCommitBatch(runtime = {}, graphPersistenceState = {}, persistSnapshot = null, db = null, options = {}) {
  if (!hasExtractionCommitBatchData(options)) return false;
  const authorityMeta = resolveAuthorityExtractionMeta(graphPersistenceState, persistSnapshot, db);
  if (!authorityMeta.authorityOwned) return false;
  const capability = runtime.getAuthorityCapabilityState?.() || {};
  return Boolean(
    capability.bmeExtractionCommitBatchReady === true ||
      db?.bmeExtractionCommitBatchReady === true ||
      db?.isAuthorityModuleExtractionCommitBatchReady === true,
  );
}

function buildAuthorityBlockedPersistResult(buildGraphPersistResult, { reason = "authority-module-unavailable", revision = 0, error = null } = {}) {
  return {
    ...buildGraphPersistResult({
    saved: false,
    queued: false,
    blocked: true,
    accepted: false,
    reason,
    revision,
    storageTier: "none",
    acceptedBy: "none",
    }),
    authorityOwned: true,
    graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
    error,
  };
}

export function shouldUseAuthorityJobsImpl(runtime, config = null, kind = AUTHORITY_VECTOR_REBUILD_JOB_TYPE) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

  const settings = getSettings();
  const { capability } = getAuthorityRuntimeSnapshot(settings);
  if (
    !capability.jobsReady ||
    settings.authorityJobsEnabled === false ||
    !isAuthorityJobTypeSupported(capability, kind) ||
    !isAuthorityVectorConfig(config)
  ) {
    return false;
  }
  const jobConfig = normalizeAuthorityJobConfig(settings);
  return Boolean(jobConfig.enabled);

}

export function shouldUseAuthorityGraphStoreImpl(runtime, settings = runtime.getSettings(), capability = runtime.getAuthorityCapabilityState?.()) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

  const normalizedSettings = normalizeAuthoritySettings(settings);
  const normalizedCapability = normalizeAuthorityCapabilityState(capability, settings);
  return (
    normalizedSettings.enabled &&
    normalizedSettings.primaryWhenAvailable &&
    normalizedSettings.sqlPrimary &&
    normalizedSettings.storageMode !== "local-primary" &&
    normalizedSettings.storageMode !== "off" &&
    normalizedCapability.storagePrimaryReady
  );

}

export async function writeAuthorityCheckpointFromCurrentGraphImpl(runtime, options = {}) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

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

  const reason = String(options.reason || "manual-authority-checkpoint");
  const authoritySqlPrimary = shouldUseAuthorityGraphStore(settings, capability);
  const authoritySqlCanonical =
    authoritySqlPrimary ||
    [
      graphPersistenceState.acceptedBy,
      graphPersistenceState.acceptedStorageTier,
      graphPersistenceState.primaryStorageTier,
    ].some((value) => String(value || "").trim() === "authority-sql");
  let checkpointGraph = null;
  let revision = 0;
  let integrity = "";
  let checkpointSource = "runtime";

  if (authoritySqlCanonical) {
    try {
      const sqlSnapshot = await exportAuthoritySqlSnapshotForCheckpoint(chatId, settings);
      const sqlRevision = Number(sqlSnapshot?.meta?.revision || 0);
      if (!Number.isFinite(sqlRevision) || sqlRevision <= 0) {
        return {
          success: false,
          error: "authority-sql-checkpoint-source-empty",
        };
      }
      checkpointGraph = buildGraphFromSnapshot(sqlSnapshot, { chatId });
      revision = sqlRevision;
      integrity =
        normalizeChatIdCandidate(options.integrity) ||
        normalizeChatIdCandidate(sqlSnapshot?.meta?.integrity) ||
        getChatMetadataIntegrity(getContext()) ||
        graphPersistenceState.metadataIntegrity;
      checkpointSource = "authority-sql";
    } catch (error) {
      return {
        success: false,
        error: error?.message || String(error) || "authority-sql-checkpoint-source-failed",
      };
    }
  }

  if (!checkpointGraph) {
    ensureCurrentGraphRuntimeState();
    currentGraph = runtime.getCurrentGraph?.() || null;
    if (!currentGraph) {
      return {
        success: false,
        error: "Authority runtime graph unavailable",
      };
    }
    checkpointGraph = currentGraph;
    revision = Math.max(
      1,
      Number(options.revision || 0),
      Number(currentGraph?.meta?.revision || 0),
      Number(getGraphPersistedRevision(currentGraph) || 0),
      Number(graphPersistenceState.revision || 0),
    );
    integrity =
      normalizeChatIdCandidate(options.integrity) ||
      normalizeChatIdCandidate(getGraphPersistenceMeta(currentGraph)?.integrity) ||
      getChatMetadataIntegrity(getContext()) ||
      graphPersistenceState.metadataIntegrity;
  }

  const checkpoint = buildLukerGraphCheckpointV2(checkpointGraph, {
    revision,
    chatId,
    integrity,
    reason,
    storageTier: authoritySqlCanonical ? "authority-sql-primary" : "runtime-checkpoint",
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
      source: checkpointSource,
      auditSummary: auditResult?.audit?.summary || null,
      auditActions: auditResult?.audit?.actions || [],
    },
  };

}

export function buildBmeSyncRuntimeOptionsImpl(runtime, extra = {}) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

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

export function maybeCaptureGraphShadowSnapshotImpl(runtime, 
  reason = "runtime-shadow",
  {
    graph = runtime.getCurrentGraph?.(),
    chatId = (runtime.getGraphPersistenceState?.() || {}).chatId || runtime.getCurrentChatId(),
    revision = (runtime.getGraphPersistenceState?.() || {}).revision,
  } = {},
) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

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

export async function persistExtractionBatchResultImpl(runtime, {
  reason = "extraction-batch-complete",
  lastProcessedAssistantFloor = null,
  graphSnapshot = null,
  persistSnapshot = null,
  persistDelta = null,
  committedBatchJournalEntry = null,
  processedRange = null,
  extractionCountBefore = null,
  extractionCountAfter = null,
  previousLastProcessedFloor = null,
  messageHashes = [],
  pruneMessageHashesFromFloor = null,
  vectorDirty = undefined,
  dirtyFromFloor = undefined,
} = {}) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

  ensureCurrentGraphRuntimeState();
  currentGraph = runtime.getCurrentGraph?.() || null;
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
  let authorityLocked = isAuthorityPersistenceLocked(graphPersistenceState, persistSnapshot);
  let extractionDb = null;
  if (hasExtractionCommitBatchData({ persistDelta, committedBatchJournalEntry })) {
    try {
      const manager = ensureBmeChatManager?.();
      extractionDb = typeof manager?.getCurrentDb === "function"
        ? await manager.getCurrentDb(chatId)
        : await createPreferredGraphLocalStore(chatId);
      const authorityExtractionMeta = resolveAuthorityExtractionMeta(graphPersistenceState, persistSnapshot, extractionDb);
      if (authorityExtractionMeta.authorityOwned && shouldRouteExtractionCommitBatch(runtime, graphPersistenceState, persistSnapshot, extractionDb, {
        persistDelta,
        committedBatchJournalEntry,
      })) {
        if (typeof extractionDb?.commitExtractionBatch !== "function") {
          throw Object.assign(new Error("BME extraction.commitBatch store capability unavailable"), { code: "authority_module_unavailable" });
        }
        const commitResult = await extractionDb.commitExtractionBatch({
          persistDelta,
          committedBatchJournalEntry,
          processedRange,
          lastProcessedAssistantFloor,
          previousLastProcessedFloor,
          extractionCountBefore,
          extractionCountAfter,
          messageHashes,
          pruneMessageHashesFromFloor,
          vectorDirty,
          dirtyFromFloor,
          reason,
        }, { reason, vectorDirty, dirtyFromFloor });
        if (commitResult?.accepted === true) {
          updateGraphPersistenceState({
            pendingPersist: false,
            authorityOwned: true,
            graphOperationalMode: commitResult.graphOperationalMode || "authority-primary",
            lastAcceptedRevision: Number(commitResult.revision || revision),
            acceptedStorageTier: String(commitResult.storageTier || "authority-sql"),
            lastPersistReason: reason,
            lastPersistMode: String(commitResult.saveMode || "extraction.commitBatch"),
          });
          return commitResult;
        }
        return commitResult;
      }
      if (authorityExtractionMeta.authorityOwned) {
        updateGraphPersistenceState({
          pendingPersist: false,
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
          lastPersistReason: "authority-extraction-commitbatch-unavailable",
          lastPersistMode: "extraction.commitBatch",
        });
        return buildAuthorityBlockedPersistResult(buildGraphPersistResult, {
          reason: "authority-extraction-commitbatch-unavailable",
          revision,
        });
      }
    } catch (error) {
      if (isAuthorityModuleUnavailableError(error) || String(error?.code || "").toLowerCase() === "transaction_conflict") {
        updateGraphPersistenceState({
          pendingPersist: false,
          authorityOwned: true,
          graphOperationalMode: GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
          lastPersistReason: String(error?.code || "authority-module-unavailable"),
          lastPersistMode: "extraction.commitBatch",
        });
        return buildAuthorityBlockedPersistResult(buildGraphPersistResult, {
          reason: String(error?.code || "authority-module-unavailable").replace(/_/g, "-"),
          revision,
          error,
        });
      }
      throw error;
    }
  }
  let acceptedPersistResult = null;
  try {
    acceptedPersistResult = await persistGraphToConfiguredDurableTier(
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
  } catch (error) {
    if (!isAuthorityModuleUnavailableError(error)) throw error;
    acceptedPersistResult = buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "authority-module-unavailable",
      revision,
      storageTier: "none",
      error,
    });
  }
  authorityLocked = authorityLocked || isAuthorityPersistenceLocked(graphPersistenceState, persistSnapshot) || isAuthorityLockedPersistResult(acceptedPersistResult);
  if (acceptedPersistResult?.accepted) {
    return acceptedPersistResult;
  }

  let recoverableTier = "none";
  if (
    !authorityLocked &&
    maybeCaptureGraphShadowSnapshotImpl(runtime, `${reason}:shadow-fallback`, {
      graph: persistGraph,
      chatId,
      revision,
    })
  ) {
    recoverableTier = "shadow";
  }

  if (!authorityLocked && canPersistGraphToMetadataFallback(context, persistGraph)) {
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
    captureShadow: !authorityLocked && recoverableTier === "none",
    recoverableTier,
  });
  updateGraphPersistenceState({
    pendingPersist: true,
    authorityOwned: authorityLocked ? true : graphPersistenceState.authorityOwned,
    graphOperationalMode: authorityLocked ? GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED : graphPersistenceState.graphOperationalMode,
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

export function syncGraphLoadFromLiveContextImpl(runtime, options = {}) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

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

export function loadGraphFromChatImpl(runtime, options = {}) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  let extractionCount = runtime.getExtractionCount?.() || 0;
  let lastExtractedItems = runtime.getLastExtractedItems?.() || [];
  let lastRecalledItems = runtime.getLastRecalledItems?.() || [];
  let lastInjectionContent = runtime.getLastInjectionContent?.() || "";
  let runtimeStatus = runtime.getRuntimeStatus?.();
  let lastExtractionStatus = runtime.getLastExtractionStatus?.();
  let lastVectorStatus = runtime.getLastVectorStatus?.();
  let lastRecallStatus = runtime.getLastRecallStatus?.();
  const AUTHORITY_VECTOR_REBUILD_JOB_TYPE = runtime.AUTHORITY_VECTOR_REBUILD_JOB_TYPE;
  const BmeDatabase = runtime.BmeDatabase;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const GRAPH_METADATA_KEY = runtime.GRAPH_METADATA_KEY;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphFromSnapshot = runtime.buildGraphFromSnapshot;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildLukerGraphCheckpointV2 = runtime.buildLukerGraphCheckpointV2;
  const buildRestoreSafetyChatId = runtime.buildRestoreSafetyChatId;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const buildVectorCollectionId = runtime.buildVectorCollectionId;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const canUseHostGraphChatStatePersistence = runtime.canUseHostGraphChatStatePersistence;
  const clearPendingGraphLoadRetry = runtime.clearPendingGraphLoadRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneGraphSnapshot = runtime.cloneGraphSnapshot;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createEmptyGraph = runtime.createEmptyGraph;
  const createGraphLoadUiStatus = runtime.createGraphLoadUiStatus;
  const createPreferredGraphLocalStore = runtime.createPreferredGraphLocalStore;
  const createUiStatus = runtime.createUiStatus;
  const deserializeGraph = runtime.deserializeGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const exportAuthoritySqlSnapshotForCheckpoint = runtime.exportAuthoritySqlSnapshotForCheckpoint;
  const getAcceptedCommitMarkerRevision = runtime.getAcceptedCommitMarkerRevision;
  const getAuthorityRuntimeSnapshot = runtime.getAuthorityRuntimeSnapshot;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getGraphPersistenceMeta = runtime.getGraphPersistenceMeta;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestHeaders = runtime.getRequestHeaders;
  const getSettings = runtime.getSettings;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isAuthorityJobTypeSupported = runtime.isAuthorityJobTypeSupported;
  const isAuthorityVectorConfig = runtime.isAuthorityVectorConfig;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const loadGraphFromChat = runtime.loadGraphFromChat;
  const loadGraphFromIndexedDb = runtime.loadGraphFromIndexedDb;
  const normalizeAuthorityCapabilityState = runtime.normalizeAuthorityCapabilityState;
  const normalizeAuthorityJobConfig = runtime.normalizeAuthorityJobConfig;
  const normalizeAuthoritySettings = runtime.normalizeAuthoritySettings;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const refreshRuntimeGraphAfterSyncApplied = runtime.refreshRuntimeGraphAfterSyncApplied;
  const recordAuthorityBlobSnapshot = runtime.recordAuthorityBlobSnapshot;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const resolvePreferredGraphLocalStorePresentation = runtime.resolvePreferredGraphLocalStorePresentation;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const restoreRecallUiStateFromPersistence = runtime.restoreRecallUiStateFromPersistence;
  const runAuthorityConsistencyAudit = runtime.runAuthorityConsistencyAudit;
  const scheduleGraphChatStateProbe = runtime.scheduleGraphChatStateProbe;
  const scheduleIndexedDbGraphProbe = runtime.scheduleIndexedDbGraphProbe;
  const schedulePersistedRecallMessageUiRefresh = runtime.schedulePersistedRecallMessageUiRefresh;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const shouldSyncGraphLoadFromLiveContext = runtime.shouldSyncGraphLoadFromLiveContext;
  const shouldUseAuthorityBlobCheckpoint = runtime.shouldUseAuthorityBlobCheckpoint;
  const shouldUseAuthorityGraphStore = runtime.shouldUseAuthorityGraphStore;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const writeAuthorityLukerCheckpointBlob = runtime.writeAuthorityLukerCheckpointBlob;
  const writeGraphShadowSnapshot = runtime.writeGraphShadowSnapshot;
  const console = runtime.console || globalThis.console;

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
      runtime.setCurrentGraph?.(currentGraph);
      extractionCount = 0;
      runtime.setExtractionCount?.(extractionCount);
      lastExtractedItems = [];
      runtime.setLastExtractedItems?.(lastExtractedItems);
      lastRecalledItems = [];
      runtime.setLastRecalledItems?.(lastRecalledItems);
      lastInjectionContent = "";
      runtime.setLastInjectionContent?.(lastInjectionContent);
      runtimeStatus = createUiStatus(
        "图谱加载中",
        "正在等待当前聊天会话 ID 就绪",
        "running",
      );
      runtime.setRuntimeStatus?.(runtimeStatus);
      lastExtractionStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      runtime.setLastExtractionStatus?.(lastExtractionStatus);
      lastVectorStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      runtime.setLastVectorStatus?.(lastVectorStatus);
      lastRecallStatus = createUiStatus(
        "待命",
        "正在等待当前聊天会话 ID 就绪",
        "idle",
      );
      runtime.setLastRecallStatus?.(lastRecallStatus);
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
      runtime.setCurrentGraph?.(currentGraph);
    extractionCount = 0;
      runtime.setExtractionCount?.(extractionCount);
    lastExtractedItems = [];
      runtime.setLastExtractedItems?.(lastExtractedItems);
    lastRecalledItems = [];
      runtime.setLastRecalledItems?.(lastRecalledItems);
    lastInjectionContent = "";
      runtime.setLastInjectionContent?.(lastInjectionContent);
    runtimeStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    runtime.setRuntimeStatus?.(runtimeStatus);
    lastExtractionStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    runtime.setLastExtractionStatus?.(lastExtractionStatus);
    lastVectorStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    runtime.setLastVectorStatus?.(lastVectorStatus);
    lastRecallStatus = createUiStatus("待命", "当前尚未进入聊天", "idle");
    runtime.setLastRecallStatus?.(lastRecallStatus);
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
      runtime.setCurrentGraph?.(currentGraph);
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
      runtime.setExtractionCount?.(extractionCount);
      lastExtractedItems = [];
      runtime.setLastExtractedItems?.(lastExtractedItems);
      const restoredRecallUi = restoreRecallUiStateFromPersistence(
        context?.chat,
      );
      runtimeStatus = createUiStatus(
        "图谱加载中",
        "已从兼容 metadata 暂载图谱，等待 IndexedDB 权威确认",
        "running",
      );
      runtime.setRuntimeStatus?.(runtimeStatus);
      lastExtractionStatus = createUiStatus(
        "待命",
        "兼容图谱暂载中，等待 IndexedDB 确认后再执行提取",
        "idle",
      );
      runtime.setLastExtractionStatus?.(lastExtractionStatus);
      lastVectorStatus = createUiStatus(
        "待命",
        currentGraph.vectorIndexState?.lastWarning ||
          "兼容图谱暂载中，等待 IndexedDB 确认后再执行向量任务",
        "idle",
      );
      runtime.setLastVectorStatus?.(lastVectorStatus);
      lastRecallStatus = createUiStatus(
        "待命",
        restoredRecallUi.restored
          ? "已从持久化召回记录恢复显示，等待 IndexedDB 权威确认"
          : "兼容图谱暂载中，等待 IndexedDB 确认后再执行召回",
        "idle",
      );
      runtime.setLastRecallStatus?.(lastRecallStatus);
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

export function saveGraphToChatImpl(runtime, options = {}) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const allocateRequestedPersistRevision = runtime.allocateRequestedPersistRevision;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const getContext = runtime.getContext;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const isGraphEffectivelyEmpty = runtime.isGraphEffectivelyEmpty;
  const isGraphLoadStateDbReady = runtime.isGraphLoadStateDbReady;
  const isGraphMetadataWriteAllowed = runtime.isGraphMetadataWriteAllowed;
  const normalizeIndexedDbRevision = runtime.normalizeIndexedDbRevision;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const queueGraphPersist = runtime.queueGraphPersist;
  const queueGraphPersistToIndexedDb = runtime.queueGraphPersistToIndexedDb;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const resolveCurrentChatStateTarget = runtime.resolveCurrentChatStateTarget;
  const resolvePersistRevisionFloor = runtime.resolvePersistRevisionFloor;
  const resolvePersistenceChatId = runtime.resolvePersistenceChatId;
  const scheduleBmeIndexedDbTask = runtime.scheduleBmeIndexedDbTask;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState;
  const console = runtime.console || globalThis.console;

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
  currentGraph = runtime.getCurrentGraph?.() || null;
  currentGraph.historyState.extractionCount = runtime.getExtractionCount?.() || 0;
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
    maybeCaptureGraphShadowSnapshotImpl(runtime, reason);
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

export async function onRebuildLocalCacheFromLukerSidecarImpl(runtime) {
  const graphPersistenceState = new Proxy({}, {
    get(_target, key) {
      return (runtime.getGraphPersistenceState?.() || {})[key];
    },
    set(_target, key, value) {
      const state = runtime.getGraphPersistenceState?.() || {};
      state[key] = value;
      return true;
    },
  });
  let currentGraph = runtime.getCurrentGraph?.() || null;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const isLukerPrimaryPersistenceHost = runtime.isLukerPrimaryPersistenceHost;
  const loadGraphFromLukerSidecarV2 = runtime.loadGraphFromLukerSidecarV2;
  const queueGraphPersistToIndexedDb = runtime.queueGraphPersistToIndexedDb;
  const refreshPanelLiveState = runtime.refreshPanelLiveState;
  const resolveCurrentChatStateTarget = runtime.resolveCurrentChatStateTarget;
  const toastr = runtime.toastr;

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
  currentGraph = runtime.getCurrentGraph?.() || null;
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
