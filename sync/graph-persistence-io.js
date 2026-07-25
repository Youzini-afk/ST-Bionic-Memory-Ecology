// Extracted graph persistence IndexedDB I/O controllers.
// Dependencies are supplied by index.js/test harnesses through runtime.

import {
  GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED,
  normalizeGraphAuthorityMeta,
} from "./authority-graph-mode.js";

function createGraphPersistenceStateProxy(runtime = {}) {
  return new Proxy({}, {
    get(_target, prop) {
      return runtime.getGraphPersistenceState?.()?.[prop];
    },
    set(_target, prop, value) {
      const state = runtime.getGraphPersistenceState?.();
      if (state && typeof state === "object") {
        state[prop] = value;
      } else {
        runtime.setGraphPersistenceState?.({ [prop]: value });
      }
      return true;
    },
    has(_target, prop) {
      return prop in (runtime.getGraphPersistenceState?.() || {});
    },
  });
}

function enqueueGraphPersistWrite(runtime, chatId, task) {
  const writes = runtime.bmeIndexedDbWriteInFlightByChatId;
  const previousWrite = writes.get(chatId) || Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => null)
    .then(task)
    .finally(() => {
      if (writes.get(chatId) === nextWrite) {
        writes.delete(chatId);
      }
    });
  writes.set(chatId, nextWrite);
  return nextWrite;
}

function cloneGraphPersistPayload(runtime, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return typeof runtime.cloneRuntimeDebugValue === "function"
    ? runtime.cloneRuntimeDebugValue(payload, payload)
    : payload;
}

function createNativeHydrateInstallPromiseRef(runtime = {}) {
  return {
    get value() {
      return typeof runtime.getNativeHydrateInstallPromise === "function"
        ? runtime.getNativeHydrateInstallPromise()
        : undefined;
    },
    set value(nextValue) {
      if (typeof runtime.setNativeHydrateInstallPromise === "function") {
        runtime.setNativeHydrateInstallPromise(nextValue);
      }
    },
  };
}

function createNativePersistDeltaInstallPromiseRef(runtime = {}) {
  return {
    get value() {
      return typeof runtime.getNativePersistDeltaInstallPromise === "function"
        ? runtime.getNativePersistDeltaInstallPromise()
        : undefined;
    },
    set value(nextValue) {
      if (typeof runtime.setNativePersistDeltaInstallPromise === "function") {
        runtime.setNativePersistDeltaInstallPromise(nextValue);
      }
    },
  };
}

function importNativeCore(runtime = {}) {
  return typeof runtime.importNativeCore === "function"
    ? runtime.importNativeCore()
    : import("../vendor/wasm/stbme_core.js");
}

function isAuthorityModuleUnavailableError(error = null) {
  return Boolean(
    error &&
      (error.name === "AuthorityGraphModuleUnavailableError" ||
        String(error?.code || error?.payload?.code || "").toLowerCase() === "authority_module_unavailable"),
  );
}

function resolveAuthorityPersistenceMeta(state = {}, db = null) {
  return normalizeGraphAuthorityMeta({
    authorityOwned: state?.authorityOwned === true || db?.authorityOwned === true,
    graphOperationalMode: state?.graphOperationalMode || db?.graphOperationalMode,
  });
}

function isAuthorityPersistenceLocked(state = {}, db = null) {
  const meta = resolveAuthorityPersistenceMeta(state, db);
  return meta.authorityOwned || meta.graphOperationalMode === GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED;
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

export async function loadGraphFromIndexedDbImpl(runtime, 
  chatId,
  {
    source = "indexeddb-probe",
    attemptIndex = 0,
    allowOverride = false,
    applyEmptyState = false,
  } = {},
) {
  const graphPersistenceState = createGraphPersistenceStateProxy(runtime);
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const nativeHydrateInstallPromiseRef = createNativeHydrateInstallPromiseRef(runtime);
  const nativePersistDeltaInstallPromiseRef = createNativePersistDeltaInstallPromiseRef(runtime);
  const bmeIndexedDbLatestQueuedRevisionByChatId = runtime.bmeIndexedDbLatestQueuedRevisionByChatId;
  const bmeIndexedDbWriteInFlightByChatId = runtime.bmeIndexedDbWriteInFlightByChatId;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState || ((patch = {}) => runtime.setGraphPersistenceState?.({ ...(runtime.getGraphPersistenceState?.() || {}), ...(patch || {}) }));
  const AUTHORITY_GRAPH_STORE_KIND = runtime.AUTHORITY_GRAPH_STORE_KIND;
  const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = runtime.BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const applyAcceptedPendingPersistState = runtime.applyAcceptedPendingPersistState;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbEmptyToRuntime = runtime.applyIndexedDbEmptyToRuntime;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyPersistDeltaToSnapshot = runtime.applyPersistDeltaToSnapshot;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const areChatIdsEquivalentForResolvedIdentity = runtime.areChatIdsEquivalentForResolvedIdentity;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistDelta = runtime.buildPersistDelta;
  const buildPersistDeltaFromGraphDirtyState = runtime.buildPersistDeltaFromGraphDirtyState;
  const buildPersistObservabilitySummary = runtime.buildPersistObservabilitySummary;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const cacheIndexedDbSnapshot = runtime.cacheIndexedDbSnapshot;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const clearPendingGraphPersistRetry = runtime.clearPendingGraphPersistRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createShadowComparisonGraph = runtime.createShadowComparisonGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const evaluateNativeHydrateGate = runtime.evaluateNativeHydrateGate;
  const evaluatePersistNativeDeltaGate = runtime.evaluatePersistNativeDeltaGate;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const maybeCaptureGraphShadowSnapshot = runtime.maybeCaptureGraphShadowSnapshot;
  const maybeClearAcceptedPendingPersistState = runtime.maybeClearAcceptedPendingPersistState;
  const maybeImportLegacyIndexedDbSnapshotToLocalStore = runtime.maybeImportLegacyIndexedDbSnapshotToLocalStore;
  const maybeImportLegacyOpfsSnapshotToLocalStore = runtime.maybeImportLegacyOpfsSnapshotToLocalStore;
  const maybeMigrateLegacyGraphToIndexedDb = runtime.maybeMigrateLegacyGraphToIndexedDb;
  const maybeRecoverIndexedDbGraphFromStableIdentity = runtime.maybeRecoverIndexedDbGraphFromStableIdentity;
  const maybeResolveOrphanAcceptedCommitMarker = runtime.maybeResolveOrphanAcceptedCommitMarker;
  const maybeResumePendingAutoExtraction = runtime.maybeResumePendingAutoExtraction;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const normalizeIndexedDbRevision = runtime.normalizeIndexedDbRevision;
  const normalizeLoadDiagnosticsMs = runtime.normalizeLoadDiagnosticsMs;
  const normalizePersistDeltaDiagnosticsMs = runtime.normalizePersistDeltaDiagnosticsMs;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const pruneGraphPersistDirtyState = runtime.pruneGraphPersistDirtyState;
  const queueGraphPersist = runtime.queueGraphPersist;
  const queueRuntimeGraphLocalStoreRepair = runtime.queueRuntimeGraphLocalStoreRepair;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const readLoadDiagnosticsNow = runtime.readLoadDiagnosticsNow;
  const readLocalStoreDiagnosticsSync = runtime.readLocalStoreDiagnosticsSync;
  const readPersistDeltaDiagnosticsNow = runtime.readPersistDeltaDiagnosticsNow;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshCurrentChatLocalStoreBinding = runtime.refreshCurrentChatLocalStoreBinding;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolveDbGraphStorePresentation = runtime.resolveDbGraphStorePresentation;
  const resolveLocalStoreTierFromPresentation = runtime.resolveLocalStoreTierFromPresentation;
  const resolvePendingPersistGraphSource = runtime.resolvePendingPersistGraphSource;
  const resolvePendingPersistLastProcessedAssistantFloor = runtime.resolvePendingPersistLastProcessedAssistantFloor;
  const resolvePersistRevisionFloor = runtime.resolvePersistRevisionFloor;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const schedulePendingGraphPersistRetry = runtime.schedulePendingGraphPersistRetry;
  const scheduleUpload = runtime.scheduleUpload;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateLoadDiagnostics = runtime.updateLoadDiagnostics;
  const updatePersistDeltaDiagnostics = runtime.updatePersistDeltaDiagnostics;
  const console = runtime.console || globalThis.console;

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
        if (!nativeHydrateInstallPromiseRef.value) {
          nativeHydrateInstallPromiseRef.value = importNativeCore(runtime)
            .then((module) => module?.installNativeHydrateHook?.())
            .catch((error) => {
              nativeHydrateInstallPromiseRef.value = null;
              throw error;
            });
        }
        nativeHydrateModuleStatus = await nativeHydrateInstallPromiseRef.value;
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

export function maybeFlushQueuedGraphPersistImpl(runtime, reason = "queued-graph-persist") {
  const graphPersistenceState = createGraphPersistenceStateProxy(runtime);
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const nativeHydrateInstallPromiseRef = createNativeHydrateInstallPromiseRef(runtime);
  const nativePersistDeltaInstallPromiseRef = createNativePersistDeltaInstallPromiseRef(runtime);
  const bmeIndexedDbLatestQueuedRevisionByChatId = runtime.bmeIndexedDbLatestQueuedRevisionByChatId;
  const bmeIndexedDbWriteInFlightByChatId = runtime.bmeIndexedDbWriteInFlightByChatId;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState || ((patch = {}) => runtime.setGraphPersistenceState?.({ ...(runtime.getGraphPersistenceState?.() || {}), ...(patch || {}) }));
  const AUTHORITY_GRAPH_STORE_KIND = runtime.AUTHORITY_GRAPH_STORE_KIND;
  const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = runtime.BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const applyAcceptedPendingPersistState = runtime.applyAcceptedPendingPersistState;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbEmptyToRuntime = runtime.applyIndexedDbEmptyToRuntime;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyPersistDeltaToSnapshot = runtime.applyPersistDeltaToSnapshot;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const areChatIdsEquivalentForResolvedIdentity = runtime.areChatIdsEquivalentForResolvedIdentity;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistDelta = runtime.buildPersistDelta;
  const buildPersistDeltaFromGraphDirtyState = runtime.buildPersistDeltaFromGraphDirtyState;
  const buildPersistObservabilitySummary = runtime.buildPersistObservabilitySummary;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const cacheIndexedDbSnapshot = runtime.cacheIndexedDbSnapshot;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const clearPendingGraphPersistRetry = runtime.clearPendingGraphPersistRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createShadowComparisonGraph = runtime.createShadowComparisonGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const evaluateNativeHydrateGate = runtime.evaluateNativeHydrateGate;
  const evaluatePersistNativeDeltaGate = runtime.evaluatePersistNativeDeltaGate;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const maybeCaptureGraphShadowSnapshot = runtime.maybeCaptureGraphShadowSnapshot;
  const maybeClearAcceptedPendingPersistState = runtime.maybeClearAcceptedPendingPersistState;
  const maybeImportLegacyIndexedDbSnapshotToLocalStore = runtime.maybeImportLegacyIndexedDbSnapshotToLocalStore;
  const maybeImportLegacyOpfsSnapshotToLocalStore = runtime.maybeImportLegacyOpfsSnapshotToLocalStore;
  const maybeMigrateLegacyGraphToIndexedDb = runtime.maybeMigrateLegacyGraphToIndexedDb;
  const maybeRecoverIndexedDbGraphFromStableIdentity = runtime.maybeRecoverIndexedDbGraphFromStableIdentity;
  const maybeResolveOrphanAcceptedCommitMarker = runtime.maybeResolveOrphanAcceptedCommitMarker;
  const maybeResumePendingAutoExtraction = runtime.maybeResumePendingAutoExtraction;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const normalizeIndexedDbRevision = runtime.normalizeIndexedDbRevision;
  const normalizeLoadDiagnosticsMs = runtime.normalizeLoadDiagnosticsMs;
  const normalizePersistDeltaDiagnosticsMs = runtime.normalizePersistDeltaDiagnosticsMs;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const pruneGraphPersistDirtyState = runtime.pruneGraphPersistDirtyState;
  const queueGraphPersist = runtime.queueGraphPersist;
  const queueRuntimeGraphLocalStoreRepair = runtime.queueRuntimeGraphLocalStoreRepair;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const readLoadDiagnosticsNow = runtime.readLoadDiagnosticsNow;
  const readLocalStoreDiagnosticsSync = runtime.readLocalStoreDiagnosticsSync;
  const readPersistDeltaDiagnosticsNow = runtime.readPersistDeltaDiagnosticsNow;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshCurrentChatLocalStoreBinding = runtime.refreshCurrentChatLocalStoreBinding;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolveDbGraphStorePresentation = runtime.resolveDbGraphStorePresentation;
  const resolveLocalStoreTierFromPresentation = runtime.resolveLocalStoreTierFromPresentation;
  const resolvePendingPersistGraphSource = runtime.resolvePendingPersistGraphSource;
  const resolvePendingPersistLastProcessedAssistantFloor = runtime.resolvePendingPersistLastProcessedAssistantFloor;
  const resolvePersistRevisionFloor = runtime.resolvePersistRevisionFloor;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const schedulePendingGraphPersistRetry = runtime.schedulePendingGraphPersistRetry;
  const scheduleUpload = runtime.scheduleUpload;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateLoadDiagnostics = runtime.updateLoadDiagnostics;
  const updatePersistDeltaDiagnostics = runtime.updatePersistDeltaDiagnostics;
  const console = runtime.console || globalThis.console;

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

export async function retryPendingGraphPersistImpl(runtime, {
  reason = "pending-graph-persist-retry",
  retryAttempt = 0,
  scheduleRetryOnFailure = false,
  ignoreRestoreLock = false,
} = {}) {
  const graphPersistenceState = createGraphPersistenceStateProxy(runtime);
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const nativeHydrateInstallPromiseRef = createNativeHydrateInstallPromiseRef(runtime);
  const nativePersistDeltaInstallPromiseRef = createNativePersistDeltaInstallPromiseRef(runtime);
  const bmeIndexedDbLatestQueuedRevisionByChatId = runtime.bmeIndexedDbLatestQueuedRevisionByChatId;
  const bmeIndexedDbWriteInFlightByChatId = runtime.bmeIndexedDbWriteInFlightByChatId;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState || ((patch = {}) => runtime.setGraphPersistenceState?.({ ...(runtime.getGraphPersistenceState?.() || {}), ...(patch || {}) }));
  const AUTHORITY_GRAPH_STORE_KIND = runtime.AUTHORITY_GRAPH_STORE_KIND;
  const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = runtime.BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const applyAcceptedPendingPersistState = runtime.applyAcceptedPendingPersistState;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbEmptyToRuntime = runtime.applyIndexedDbEmptyToRuntime;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyPersistDeltaToSnapshot = runtime.applyPersistDeltaToSnapshot;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const areChatIdsEquivalentForResolvedIdentity = runtime.areChatIdsEquivalentForResolvedIdentity;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistDelta = runtime.buildPersistDelta;
  const buildPersistDeltaFromGraphDirtyState = runtime.buildPersistDeltaFromGraphDirtyState;
  const buildPersistObservabilitySummary = runtime.buildPersistObservabilitySummary;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const cacheIndexedDbSnapshot = runtime.cacheIndexedDbSnapshot;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const clearPendingGraphPersistRetry = runtime.clearPendingGraphPersistRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createShadowComparisonGraph = runtime.createShadowComparisonGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const evaluateNativeHydrateGate = runtime.evaluateNativeHydrateGate;
  const evaluatePersistNativeDeltaGate = runtime.evaluatePersistNativeDeltaGate;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const maybeCaptureGraphShadowSnapshot = runtime.maybeCaptureGraphShadowSnapshot;
  const maybeClearAcceptedPendingPersistState = runtime.maybeClearAcceptedPendingPersistState;
  const maybeImportLegacyIndexedDbSnapshotToLocalStore = runtime.maybeImportLegacyIndexedDbSnapshotToLocalStore;
  const maybeImportLegacyOpfsSnapshotToLocalStore = runtime.maybeImportLegacyOpfsSnapshotToLocalStore;
  const maybeMigrateLegacyGraphToIndexedDb = runtime.maybeMigrateLegacyGraphToIndexedDb;
  const maybeRecoverIndexedDbGraphFromStableIdentity = runtime.maybeRecoverIndexedDbGraphFromStableIdentity;
  const maybeResolveOrphanAcceptedCommitMarker = runtime.maybeResolveOrphanAcceptedCommitMarker;
  const maybeResumePendingAutoExtraction = runtime.maybeResumePendingAutoExtraction;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const normalizeIndexedDbRevision = runtime.normalizeIndexedDbRevision;
  const normalizeLoadDiagnosticsMs = runtime.normalizeLoadDiagnosticsMs;
  const normalizePersistDeltaDiagnosticsMs = runtime.normalizePersistDeltaDiagnosticsMs;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const pruneGraphPersistDirtyState = runtime.pruneGraphPersistDirtyState;
  const queueGraphPersist = runtime.queueGraphPersist;
  const queueRuntimeGraphLocalStoreRepair = runtime.queueRuntimeGraphLocalStoreRepair;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const readLoadDiagnosticsNow = runtime.readLoadDiagnosticsNow;
  const readLocalStoreDiagnosticsSync = runtime.readLocalStoreDiagnosticsSync;
  const readPersistDeltaDiagnosticsNow = runtime.readPersistDeltaDiagnosticsNow;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshCurrentChatLocalStoreBinding = runtime.refreshCurrentChatLocalStoreBinding;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolveDbGraphStorePresentation = runtime.resolveDbGraphStorePresentation;
  const resolveLocalStoreTierFromPresentation = runtime.resolveLocalStoreTierFromPresentation;
  const resolvePendingPersistGraphSource = runtime.resolvePendingPersistGraphSource;
  const resolvePendingPersistLastProcessedAssistantFloor = runtime.resolvePendingPersistLastProcessedAssistantFloor;
  const resolvePersistRevisionFloor = runtime.resolvePersistRevisionFloor;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const schedulePendingGraphPersistRetry = runtime.schedulePendingGraphPersistRetry;
  const scheduleUpload = runtime.scheduleUpload;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateLoadDiagnostics = runtime.updateLoadDiagnostics;
  const updatePersistDeltaDiagnostics = runtime.updatePersistDeltaDiagnostics;
  const console = runtime.console || globalThis.console;

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

  if (maybeClearAcceptedPendingPersistState(reason)) {
    return buildGraphPersistResult({
      saved: true,
      blocked: false,
      accepted: true,
      reason: `${String(reason || "pending-graph-persist-retry")}:accepted-revision`,
      revision: Math.max(
        Number(graphPersistenceState.lastAcceptedRevision || 0),
        Number(graphPersistenceState.revision || 0),
      ),
      saveMode: "accepted-revision-reconcile",
      storageTier: String(graphPersistenceState.acceptedStorageTier || "none"),
      acceptedBy: String(graphPersistenceState.acceptedStorageTier || "none"),
    });
  }

  const context = getContext();
  let authorityLocked = isAuthorityPersistenceLocked(graphPersistenceState);
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
  let acceptedPersistResult = null;
  try {
    acceptedPersistResult = await persistGraphToConfiguredDurableTier(
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
  } catch (error) {
    if (!isAuthorityModuleUnavailableError(error)) throw error;
    acceptedPersistResult = buildGraphPersistResult({
      saved: false,
      queued: true,
      blocked: true,
      accepted: false,
      reason: "authority-module-unavailable",
      revision: targetRevision,
      storageTier: "none",
      error,
    });
  }
  authorityLocked = authorityLocked || isAuthorityPersistenceLocked(graphPersistenceState) || isAuthorityLockedPersistResult(acceptedPersistResult);
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
  if (!authorityLocked && canPersistGraphToMetadataFallback(context, pendingPersistGraph)) {
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
    !authorityLocked &&
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
    captureShadow: !authorityLocked && recoverableTier === "none",
    recoverableTier,
  });
  if (recoverableTier !== "none" || authorityLocked) {
    updateGraphPersistenceState({
      lastPersistReason: queuedReason,
      lastRecoverableStorageTier: recoverableTier,
      authorityOwned: authorityLocked ? true : graphPersistenceState.authorityOwned,
      graphOperationalMode: authorityLocked ? GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED : graphPersistenceState.graphOperationalMode,
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

export async function saveGraphToIndexedDbImpl(runtime, chatId, graph, options = {}) {
  const normalizedChatId = runtime.normalizeChatIdCandidate(chatId);
  if (!normalizedChatId) {
    return await saveGraphToIndexedDbCoreImpl(runtime, chatId, graph, options);
  }

  const graphSource = options.graphSnapshot || graph;
  const graphSnapshot =
    graphSource && typeof runtime.cloneGraphForPersistence === "function"
      ? runtime.cloneGraphForPersistence(graphSource, normalizedChatId)
      : graphSource;
  const baseRevision =
    options.baseRevision != null && Number.isFinite(Number(options.baseRevision))
    ? Number(options.baseRevision)
    : graphSnapshot && typeof runtime.getGraphPersistedRevision === "function"
      ? runtime.getGraphPersistedRevision(graphSnapshot)
      : undefined;
  const persistDelta = cloneGraphPersistPayload(runtime, options.persistDelta);
  const persistSnapshot = cloneGraphPersistPayload(runtime, options.persistSnapshot);

  return await enqueueGraphPersistWrite(runtime, normalizedChatId, () =>
    saveGraphToIndexedDbCoreImpl(runtime, normalizedChatId, graph, {
      ...options,
      graphSnapshot,
      baseRevision,
      persistDelta,
      persistSnapshot,
    }),
  );
}

async function saveGraphToIndexedDbCoreImpl(runtime,
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
    baseRevision = undefined,
  } = {},
) {
  const graphPersistenceState = createGraphPersistenceStateProxy(runtime);
  const currentGraph = runtime.getCurrentGraph?.() || null;
  const nativeHydrateInstallPromiseRef = createNativeHydrateInstallPromiseRef(runtime);
  const nativePersistDeltaInstallPromiseRef = createNativePersistDeltaInstallPromiseRef(runtime);
  const bmeIndexedDbLatestQueuedRevisionByChatId = runtime.bmeIndexedDbLatestQueuedRevisionByChatId;
  const bmeIndexedDbWriteInFlightByChatId = runtime.bmeIndexedDbWriteInFlightByChatId;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState || ((patch = {}) => runtime.setGraphPersistenceState?.({ ...(runtime.getGraphPersistenceState?.() || {}), ...(patch || {}) }));
  const AUTHORITY_GRAPH_STORE_KIND = runtime.AUTHORITY_GRAPH_STORE_KIND;
  const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = runtime.BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET;
  const GRAPH_LOAD_STATES = runtime.GRAPH_LOAD_STATES;
  const applyAcceptedPendingPersistState = runtime.applyAcceptedPendingPersistState;
  const applyGraphLoadState = runtime.applyGraphLoadState;
  const applyIndexedDbEmptyToRuntime = runtime.applyIndexedDbEmptyToRuntime;
  const applyIndexedDbSnapshotToRuntime = runtime.applyIndexedDbSnapshotToRuntime;
  const applyPersistDeltaToSnapshot = runtime.applyPersistDeltaToSnapshot;
  const applyShadowSnapshotToRuntime = runtime.applyShadowSnapshotToRuntime;
  const areChatIdsEquivalentForResolvedIdentity = runtime.areChatIdsEquivalentForResolvedIdentity;
  const buildBmeSyncRuntimeOptions = runtime.buildBmeSyncRuntimeOptions;
  const buildGraphLocalStoreSelectorKey = runtime.buildGraphLocalStoreSelectorKey;
  const buildGraphPersistResult = runtime.buildGraphPersistResult;
  const buildPersistDelta = runtime.buildPersistDelta;
  const buildPersistDeltaFromGraphDirtyState = runtime.buildPersistDeltaFromGraphDirtyState;
  const buildPersistObservabilitySummary = runtime.buildPersistObservabilitySummary;
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const buildSnapshotFromGraph = runtime.buildSnapshotFromGraph;
  const cacheIndexedDbSnapshot = runtime.cacheIndexedDbSnapshot;
  const canPersistGraphToMetadataFallback = runtime.canPersistGraphToMetadataFallback;
  const clearPendingGraphPersistRetry = runtime.clearPendingGraphPersistRetry;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const cloneRuntimeDebugValue = runtime.cloneRuntimeDebugValue;
  const createShadowComparisonGraph = runtime.createShadowComparisonGraph;
  const detectIndexedDbSnapshotCommitMarkerMismatch = runtime.detectIndexedDbSnapshotCommitMarkerMismatch;
  const detectStaleIndexedDbSnapshotAgainstRuntime = runtime.detectStaleIndexedDbSnapshotAgainstRuntime;
  const ensureBmeChatManager = runtime.ensureBmeChatManager;
  const ensureCurrentGraphRuntimeState = runtime.ensureCurrentGraphRuntimeState;
  const evaluateNativeHydrateGate = runtime.evaluateNativeHydrateGate;
  const evaluatePersistNativeDeltaGate = runtime.evaluatePersistNativeDeltaGate;
  const getChatMetadataIntegrity = runtime.getChatMetadataIntegrity;
  const getContext = runtime.getContext;
  const getCurrentChatId = runtime.getCurrentChatId;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const getRequestedGraphLocalStorageMode = runtime.getRequestedGraphLocalStorageMode;
  const getSettings = runtime.getSettings;
  const hasMeaningfulRuntimeGraphForChat = runtime.hasMeaningfulRuntimeGraphForChat;
  const isAuthorityGraphStorePresentation = runtime.isAuthorityGraphStorePresentation;
  const isGraphLocalStorageModeOpfs = runtime.isGraphLocalStorageModeOpfs;
  const isIndexedDbSnapshotMeaningful = runtime.isIndexedDbSnapshotMeaningful;
  const isRestoreLockActive = runtime.isRestoreLockActive;
  const maybeCaptureGraphShadowSnapshot = runtime.maybeCaptureGraphShadowSnapshot;
  const maybeClearAcceptedPendingPersistState = runtime.maybeClearAcceptedPendingPersistState;
  const maybeImportLegacyIndexedDbSnapshotToLocalStore = runtime.maybeImportLegacyIndexedDbSnapshotToLocalStore;
  const maybeImportLegacyOpfsSnapshotToLocalStore = runtime.maybeImportLegacyOpfsSnapshotToLocalStore;
  const maybeMigrateLegacyGraphToIndexedDb = runtime.maybeMigrateLegacyGraphToIndexedDb;
  const maybeRecoverIndexedDbGraphFromStableIdentity = runtime.maybeRecoverIndexedDbGraphFromStableIdentity;
  const maybeResolveOrphanAcceptedCommitMarker = runtime.maybeResolveOrphanAcceptedCommitMarker;
  const maybeResumePendingAutoExtraction = runtime.maybeResumePendingAutoExtraction;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeGraphRuntimeState = runtime.normalizeGraphRuntimeState;
  const normalizeIndexedDbRevision = runtime.normalizeIndexedDbRevision;
  const normalizeLoadDiagnosticsMs = runtime.normalizeLoadDiagnosticsMs;
  const normalizePersistDeltaDiagnosticsMs = runtime.normalizePersistDeltaDiagnosticsMs;
  const persistGraphToChatMetadata = runtime.persistGraphToChatMetadata;
  const persistGraphToConfiguredDurableTier = runtime.persistGraphToConfiguredDurableTier;
  const pruneGraphPersistDirtyState = runtime.pruneGraphPersistDirtyState;
  const queueGraphPersist = runtime.queueGraphPersist;
  const queueRuntimeGraphLocalStoreRepair = runtime.queueRuntimeGraphLocalStoreRepair;
  const readCachedIndexedDbSnapshot = runtime.readCachedIndexedDbSnapshot;
  const readLoadDiagnosticsNow = runtime.readLoadDiagnosticsNow;
  const readLocalStoreDiagnosticsSync = runtime.readLocalStoreDiagnosticsSync;
  const readPersistDeltaDiagnosticsNow = runtime.readPersistDeltaDiagnosticsNow;
  const recordLocalPersistEarlyFailure = runtime.recordLocalPersistEarlyFailure;
  const recordPersistMismatchDiagnostic = runtime.recordPersistMismatchDiagnostic;
  const refreshCurrentChatLocalStoreBinding = runtime.refreshCurrentChatLocalStoreBinding;
  const rememberResolvedGraphIdentityAlias = runtime.rememberResolvedGraphIdentityAlias;
  const resolveCompatibleGraphShadowSnapshot = runtime.resolveCompatibleGraphShadowSnapshot;
  const resolveCurrentChatIdentity = runtime.resolveCurrentChatIdentity;
  const resolveDbGraphStorePresentation = runtime.resolveDbGraphStorePresentation;
  const resolveLocalStoreTierFromPresentation = runtime.resolveLocalStoreTierFromPresentation;
  const resolvePendingPersistGraphSource = runtime.resolvePendingPersistGraphSource;
  const resolvePendingPersistLastProcessedAssistantFloor = runtime.resolvePendingPersistLastProcessedAssistantFloor;
  const resolvePersistRevisionFloor = runtime.resolvePersistRevisionFloor;
  const resolveSnapshotGraphStorePresentation = runtime.resolveSnapshotGraphStorePresentation;
  const schedulePendingGraphPersistRetry = runtime.schedulePendingGraphPersistRetry;
  const scheduleUpload = runtime.scheduleUpload;
  const shouldPreferShadowSnapshotOverOfficial = runtime.shouldPreferShadowSnapshotOverOfficial;
  const stampGraphPersistenceMeta = runtime.stampGraphPersistenceMeta;
  const syncCommitMarkerToPersistenceState = runtime.syncCommitMarkerToPersistenceState;
  const updateLoadDiagnostics = runtime.updateLoadDiagnostics;
  const updatePersistDeltaDiagnostics = runtime.updatePersistDeltaDiagnostics;
  const console = runtime.console || globalThis.console;

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
    const expectedBaseRevision =
      baseRevision != null && Number.isFinite(Number(baseRevision))
      ? normalizeIndexedDbRevision(baseRevision)
      : null;
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
        if (!nativePersistDeltaInstallPromiseRef.value) {
          nativePersistDeltaInstallPromiseRef.value = importNativeCore(runtime)
            .then((module) => module?.installNativePersistDeltaHook?.())
            .catch((error) => {
              nativePersistDeltaInstallPromiseRef.value = null;
              throw error;
            });
        }
        nativePersistModuleStatus = await nativePersistDeltaInstallPromiseRef.value;
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
    // Phase F: when the resolved store is an AuthorityGraphStore that
    // dispatches to the BME companion module `graph.commitDelta`
    // transaction (bmeGraphCommitReady === true), the wrapper throws an
    // AuthorityGraphCommitConflictError on a 409 transaction_conflict. We
    // must NOT fall back to the local chunked path on this error — the
    // server has already refused the write because another writer
    // committed first, so writing locally would silently diverge from the
    // server's authoritative state. Instead, fetch a fresh snapshot/head
    // via db.exportSnapshot, rebuild the delta against the fresh revision,
    // and retry ONCE. If the retry also conflicts, surface the error — do
    // NOT advance the extraction floor / processed-message hashes.
    let commitResult = null;
    let conflictRetryAttempted = false;
    try {
      commitResult = await db.commitDelta(delta, {
        reason,
        requestedRevision,
        ...(expectedBaseRevision != null
          ? { baseRevision: expectedBaseRevision }
          : {}),
        markSyncDirty: true,
        committedSnapshot: snapshot,
      });
    } catch (commitError) {
      const isGraphCommitConflict = Boolean(
        commitError &&
          (commitError.name === "AuthorityGraphCommitConflictError" ||
            String(commitError?.code || commitError?.payload?.details?.code || commitError?.payload?.code || "").toLowerCase() === "transaction_conflict"),
      );
      if (!isGraphCommitConflict) {
        throw commitError;
      }
      // Fresh head fetch + delta rebuild + single retry.
      conflictRetryAttempted = true;
      let freshSnapshot = null;
      try {
        freshSnapshot = await db.exportSnapshot({ includeTombstones: true });
      } catch (exportError) {
        // If we can't even read the fresh head, we cannot safely retry.
        // Surface the original conflict error with the export failure as
        // cause so the caller can decide whether to re-queue or fail.
        console.warn(
          `[ST-BME] graph.commitDelta transaction_conflict 后无法读取最新 head:`,
          exportError?.message || exportError,
        );
        throw commitError;
      }
      const freshRevision = normalizeIndexedDbRevision(freshSnapshot?.meta?.revision);
      if (!Number.isFinite(freshRevision) || freshRevision < 0) {
        console.warn(
          `[ST-BME] graph.commitDelta transaction_conflict 后读取到非法 revision (${freshRevision}); 不再重试`,
        );
        throw commitError;
      }
      // Phase F conflict-retry: rebuild the delta against the fresh
      // snapshot if (and only if) we still have a persistGraphInput and
      // buildPersistDeltaFromGraphDirtyState is available. We must NOT
      // fall back to the original stale delta — that could advance a stale
      // runtimeMetaPatch / extraction floor past a conflicting commit. If
      // rebuild is unavailable or fails, surface the original conflict
      // error so the caller does NOT advance extraction floor / processed
      // hashes.
      let retryDelta = null;
      let retrySnapshot = snapshot;
      if (persistGraphInput && typeof buildPersistDeltaFromGraphDirtyState === "function") {
        try {
          const rebuiltDelta = buildPersistDeltaFromGraphDirtyState(freshSnapshot, persistGraphInput, {
            chatId: normalizedChatId,
            revision: freshRevision,
            lastModified: Date.now(),
            meta: {
              storagePrimary: localStore.storagePrimary,
              storageMode: localStore.storageMode,
              lastMutationReason: String(reason || "graph-save"),
              integrity:
                currentIdentity.integrity || graphPersistenceState.metadataIntegrity,
              hostChatId: currentIdentity.hostChatId || "",
            },
          });
          if (rebuiltDelta) {
            retryDelta = rebuiltDelta;
            retrySnapshot = applyPersistDeltaToSnapshot
              ? applyPersistDeltaToSnapshot(freshSnapshot, rebuiltDelta, {
                  chatId: normalizedChatId,
                  revision: freshRevision,
                  lastModified: Date.now(),
                  reason: String(reason || "graph-save"),
                })
              : retrySnapshot;
          }
        } catch (rebuildError) {
          // rebuild failed — surface the conflict, do NOT retry with the
          // stale original delta.
          console.warn(
            `[ST-BME] graph.commitDelta transaction_conflict 后 delta 重建失败; 抛出冲突错误而非用过期 delta 重试:`,
            rebuildError?.message || rebuildError,
          );
          throw commitError;
        }
      }
      if (!retryDelta) {
        // No rebuild path available (no persistGraphInput, no builder, or
        // rebuild returned null/undefined) — surface the conflict so the
        // caller does NOT advance extraction floor / processed hashes.
        console.warn(
          `[ST-BME] graph.commitDelta transaction_conflict 后无法重建 delta (persistGraphInput=${Boolean(persistGraphInput)}); 抛出冲突错误而非用过期 delta 重试`,
        );
        throw commitError;
      }
      // Only retry with a successfully rebuilt delta.
      try {
        commitResult = await db.commitDelta(retryDelta, {
          reason,
          requestedRevision: freshRevision,
          baseRevision: freshRevision,
          markSyncDirty: true,
          committedSnapshot: retrySnapshot,
        });
      } catch (retryError) {
        // Second conflict (or any error) — do NOT advance extraction
        // floor / processed hashes. Surface the retry error so the
        // caller's catch block records it via updatePersistDeltaDiagnostics
        // and does not promote the snapshot.
        console.warn(
          `[ST-BME] graph.commitDelta transaction_conflict 重试仍失败:`,
          retryError?.message || retryError,
        );
        throw retryError;
      }
      // Swap in the rebuilt delta/snapshot for downstream diagnostics.
      delta = retryDelta;
      snapshot = retrySnapshot;
      if (persistGraphInput && dirtyPersistDeltaVersion > 0 && sourceGraphInput && sourceGraphInput !== graph) {
        pruneGraphPersistDirtyState(sourceGraphInput, dirtyPersistDeltaVersion);
      }
    }
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
    const authorityLocked = isAuthorityPersistenceLocked(graphPersistenceState, db) || isAuthorityModuleUnavailableError(error);
    console.warn(
      authorityLocked
        ? `[ST-BME] ${localStore.statusLabel} 权威图谱写入失败，已进入降级队列:`
        : `[ST-BME] ${localStore.statusLabel} 写入失败，保留 metadata 兜底:`,
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
      authorityOwned: authorityLocked ? true : graphPersistenceState.authorityOwned,
      graphOperationalMode: authorityLocked ? GRAPH_OPERATIONAL_MODE_AUTHORITY_DEGRADED : graphPersistenceState.graphOperationalMode,
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
      queued: authorityLocked,
      blocked: authorityLocked,
      accepted: false,
      reason:
        authorityLocked
          ? "authority-module-unavailable"
          : persistRole === "cache-mirror"
          ? "cache-mirror-write-failed"
          : `${String(localStore?.reasonPrefix || "indexeddb")}-write-failed`,
      storageTier: authorityLocked ? "none" : undefined,
      error,
    };
  }

}

export function queueGraphPersistToIndexedDbImpl(runtime, 
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
  const graphPersistenceState = createGraphPersistenceStateProxy(runtime);
  const bmeIndexedDbLatestQueuedRevisionByChatId = runtime.bmeIndexedDbLatestQueuedRevisionByChatId;
  const updateGraphPersistenceState = runtime.updateGraphPersistenceState || ((patch = {}) => runtime.setGraphPersistenceState?.({ ...(runtime.getGraphPersistenceState?.() || {}), ...(patch || {}) }));
  const buildPersistenceEnvironment = runtime.buildPersistenceEnvironment;
  const cloneGraphForPersistence = runtime.cloneGraphForPersistence;
  const getContext = runtime.getContext;
  const getGraphPersistedRevision = runtime.getGraphPersistedRevision;
  const getPreferredGraphLocalStorePresentationSync = runtime.getPreferredGraphLocalStorePresentationSync;
  const normalizeChatIdCandidate = runtime.normalizeChatIdCandidate;
  const normalizeIndexedDbRevision = runtime.normalizeIndexedDbRevision;

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

  const persistGraphSnapshot = graphSnapshot
    ? cloneGraphForPersistence(graphSnapshot, normalizedChatId)
    : graph
      ? cloneGraphForPersistence(graph, normalizedChatId)
      : null;
  const baseRevision = persistGraphSnapshot
    ? getGraphPersistedRevision(persistGraphSnapshot)
    : undefined;
  const detachedPersistDelta = cloneGraphPersistPayload(runtime, persistDelta);
  const detachedPersistSnapshot = cloneGraphPersistPayload(runtime, persistSnapshot);
  return enqueueGraphPersistWrite(runtime, normalizedChatId, async () => {
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
      return await saveGraphToIndexedDbCoreImpl(runtime, normalizedChatId, graph, {
        revision: normalizedRevision,
        reason,
        persistRole,
        scheduleCloudUpload,
        persistDelta: detachedPersistDelta,
        graphSnapshot: persistGraphSnapshot,
        persistSnapshot: detachedPersistSnapshot,
        sourceGraph: graphDetached === true ? null : graph,
        baseRevision,
      });
    });

}
