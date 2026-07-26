import assert from "node:assert/strict";
import { saveGraphToIndexedDbImpl } from "../sync/graph-persistence-io.js";

// Phase 5b: this smoke test used to slice saveGraphToIndexedDb out of index.js
// into a temp module. saveGraphToIndexedDbImpl is now a real import, so the test
// builds a fake persistence-io runtime and calls the impl directly — no
// index.js slicing, no temp module.

const GRAPH_LOAD_STATES = { SHADOW_RESTORED: "shadow-restored", LOADED: "loaded" };
const AUTHORITY_GRAPH_STORE_KIND = "authority";
const BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET = new Set([
  "idle",
  "loading",
  "blocked",
  "shadow-restored",
]);

function createSmokeRuntime() {
  const state = {
    currentGraph: null,
    graphPersistenceState: {
      metadataIntegrity: "",
      loadState: "loaded",
      revision: 0,
      lastPersistedRevision: 0,
      lastAcceptedRevision: 0,
      cacheMirrorState: "idle",
      persistDiagnosticTier: "none",
      hostProfile: "generic-st",
      primaryStorageTier: "indexeddb",
      cacheStorageTier: "none",
      shadowSnapshotRevision: 0,
      shadowSnapshotUpdatedAt: "",
      shadowSnapshotReason: "",
    },
    nativePersistDeltaInstallPromise: null,
    nativeHydrateInstallPromise: null,
    commitShouldThrow: false,
  };
  const bmeIndexedDbLatestQueuedRevisionByChatId = new Map();
  const bmeIndexedDbWriteInFlightByChatId = new Map();

  return {
    state,
    runtime: {
      AUTHORITY_GRAPH_STORE_KIND,
      BME_INDEXEDDB_FALLBACK_LOAD_STATE_SET,
      GRAPH_LOAD_STATES,
      applyGraphLoadState() {},
      areChatIdsEquivalentForResolvedIdentity() {
        return false;
      },
      bmeIndexedDbLatestQueuedRevisionByChatId,
      bmeIndexedDbWriteInFlightByChatId,
      buildBmeSyncRuntimeOptions() {
        return {};
      },
      buildPersistDelta() {
        return {
          upsertNodes: [],
          upsertEdges: [],
          deleteNodeIds: [],
          deleteEdgeIds: [],
          tombstones: [],
          runtimeMetaPatch: {},
        };
      },
      buildPersistDeltaFromGraphDirtyState() {
        return null;
      },
      buildPersistObservabilitySummary() {
        return { totalSamples: 1 };
      },
      buildPersistenceEnvironment() {
        return {
          hostProfile: "generic-st",
          primaryStorageTier: "indexeddb",
          cacheStorageTier: "none",
        };
      },
      buildSnapshotFromGraph(graph, options = {}) {
        return {
          meta: {
            revision: Number(options.revision || 1),
            storagePrimary: "indexeddb",
            storageMode: "indexeddb",
            integrity: "meta-esm",
          },
          nodes: [],
          edges: [],
          tombstones: [],
          state: { lastProcessedFloor: -1, extractionCount: 0 },
        };
      },
      cacheIndexedDbSnapshot() {},
      clearPendingGraphPersistRetry() {},
      cloneRuntimeDebugValue(value, fallback = null) {
        return value == null ? fallback : JSON.parse(JSON.stringify(value));
      },
      console,
      ensureBmeChatManager() {
        return {
          async getCurrentDb() {
            return {
              async exportSnapshot() {
                return {
                  meta: { revision: 0 },
                  nodes: [],
                  edges: [],
                  tombstones: [],
                  state: { lastProcessedFloor: -1, extractionCount: 0 },
                };
              },
              async commitDelta(delta, options = {}) {
                if (state.commitShouldThrow) {
                  throw new Error("commit-failed");
                }
                return {
                  revision: Number(options.requestedRevision || 1),
                  lastModified: Date.now(),
                  delta,
                };
              },
            };
          },
        };
      },
      evaluatePersistNativeDeltaGate() {
        return {
          allowed: false,
          reasons: [],
          minSnapshotRecords: 0,
          minStructuralDelta: 0,
          minCombinedSerializedChars: 0,
          beforeRecordCount: 0,
          afterRecordCount: 0,
          maxSnapshotRecords: 0,
          structuralDelta: 0,
        };
      },
      getChatMetadataIntegrity() {
        return "meta-esm";
      },
      getContext() {
        return { chatId: "chat-esm", chatMetadata: {}, characterId: "char-esm" };
      },
      getCurrentChatId: () => "chat-esm",
      getCurrentGraph() {
        return state.currentGraph;
      },
      getGraphPersistenceState() {
        return state.graphPersistenceState;
      },
      getNativeHydrateInstallPromise() {
        return state.nativeHydrateInstallPromise;
      },
      getNativePersistDeltaInstallPromise() {
        return state.nativePersistDeltaInstallPromise;
      },
      getPreferredGraphLocalStorePresentationSync() {
        return {
          storagePrimary: "indexeddb",
          storageMode: "indexeddb",
          statusLabel: "IndexedDB",
          reasonPrefix: "indexeddb",
        };
      },
      getSettings() {
        return {
          persistNativeDeltaBridgeMode: "json",
          persistUseNativeDelta: false,
          graphNativeForceDisable: false,
          nativeEngineFailOpen: true,
        };
      },
      normalizeChatIdCandidate(value = "") {
        return String(value ?? "").trim();
      },
      normalizeIndexedDbRevision(value, fallbackValue = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0
          ? Math.floor(parsed)
          : Math.max(0, Number(fallbackValue) || 0);
      },
      normalizePersistDeltaDiagnosticsMs(value = 0) {
        return Math.round((Number(value) || 0) * 10) / 10;
      },
      pruneGraphPersistDirtyState() {
        return null;
      },
      readCachedIndexedDbSnapshot() {
        return null;
      },
      readPersistDeltaDiagnosticsNow() {
        return Date.now();
      },
      recordLocalPersistEarlyFailure: () => {},
      rememberResolvedGraphIdentityAlias() {},
      resolveCurrentChatIdentity() {
        return { integrity: "meta-esm", hostChatId: "host-esm" };
      },
      resolveDbGraphStorePresentation() {
        return {
          storagePrimary: "indexeddb",
          storageMode: "indexeddb",
          statusLabel: "IndexedDB",
          reasonPrefix: "indexeddb",
        };
      },
      resolveLocalStoreTierFromPresentation() {
        return "indexeddb";
      },
      resolvePersistRevisionFloor(revision = 0) {
        return Number(revision) || 1;
      },
      scheduleUpload() {},
      setCurrentGraph(graph) {
        state.currentGraph = graph;
        return state.currentGraph;
      },
      setGraphPersistenceState(patch = {}) {
        state.graphPersistenceState = {
          ...state.graphPersistenceState,
          ...(patch || {}),
        };
        return state.graphPersistenceState;
      },
      setNativeHydrateInstallPromise(promise) {
        state.nativeHydrateInstallPromise = promise;
      },
      setNativePersistDeltaInstallPromise(promise) {
        state.nativePersistDeltaInstallPromise = promise;
      },
      stampGraphPersistenceMeta() {},
      updateGraphPersistenceState(patch = {}) {
        state.graphPersistenceState = {
          ...state.graphPersistenceState,
          ...(patch || {}),
        };
        return state.graphPersistenceState;
      },
      updatePersistDeltaDiagnostics() {},
    },
  };
}

const { state, runtime } = createSmokeRuntime();

const success = await saveGraphToIndexedDbImpl(runtime, "chat-esm", { historyState: {} }, {
  revision: 2,
  reason: "esm-success",
});
assert.equal(success.saved, true);
assert.equal(success.accepted, true);

state.commitShouldThrow = true;
const failed = await saveGraphToIndexedDbImpl(runtime, "chat-esm", { historyState: {} }, {
  revision: 3,
  reason: "esm-failure",
});
assert.equal(failed.saved, false);
assert.equal(failed.reason, "indexeddb-write-failed");

console.log("index-esm-entry-smoke tests passed");
