import assert from "node:assert/strict";

import {
  defaultSettings,
  mergePersistedSettings,
} from "../runtime/settings-defaults.js";
import {
  evaluateNativeHydrateGate,
  evaluatePersistNativeDeltaGate,
  resolveNativeHydrateGateOptions,
  resolvePersistNativeDeltaGateOptions,
} from "../sync/bme-db.js";
import {
  GraphNativeLayoutBridge,
  normalizeGraphNativeRuntimeOptions,
} from "../ui/graph-native-bridge.js";

const migratedLegacy = mergePersistedSettings({
  graphUseNativeLayout: false,
  persistUseNativeDelta: false,
  loadUseNativeHydrate: false,
});
assert.equal(migratedLegacy.graphUseNativeLayout, true);
assert.equal(migratedLegacy.persistUseNativeDelta, true);
assert.equal(migratedLegacy.loadUseNativeHydrate, true);
assert.equal(migratedLegacy.loadNativeHydrateThresholdRecords, 30000);
assert.equal(migratedLegacy.nativeRolloutVersion, defaultSettings.nativeRolloutVersion);

const preservedManualOptOut = mergePersistedSettings({
  nativeRolloutVersion: defaultSettings.nativeRolloutVersion,
  graphUseNativeLayout: false,
  persistUseNativeDelta: false,
  loadUseNativeHydrate: false,
  graphNativeForceDisable: true,
});
assert.equal(preservedManualOptOut.graphUseNativeLayout, false);
assert.equal(preservedManualOptOut.persistUseNativeDelta, false);
assert.equal(preservedManualOptOut.loadUseNativeHydrate, false);
assert.equal(preservedManualOptOut.graphNativeForceDisable, true);

const migratedLegacyHydrateThreshold = mergePersistedSettings({
  nativeRolloutVersion: 1,
  loadNativeHydrateThresholdRecords: 12000,
});
assert.equal(migratedLegacyHydrateThreshold.loadNativeHydrateThresholdRecords, 30000);

const preservedCustomHydrateThreshold = mergePersistedSettings({
  nativeRolloutVersion: 1,
  loadNativeHydrateThresholdRecords: 42000,
});
assert.equal(preservedCustomHydrateThreshold.loadNativeHydrateThresholdRecords, 42000);

const normalizedRuntimeOptions = normalizeGraphNativeRuntimeOptions({
  graphNativeLayoutThresholdNodes: 0,
  graphNativeLayoutThresholdEdges: 999999,
  graphNativeLayoutWorkerTimeoutMs: 10,
  nativeEngineFailOpen: 0,
  graphNativeForceDisable: "true",
});
assert.equal(normalizedRuntimeOptions.graphNativeLayoutThresholdNodes, 1);
assert.equal(normalizedRuntimeOptions.graphNativeLayoutThresholdEdges, 50000);
assert.equal(normalizedRuntimeOptions.graphNativeLayoutWorkerTimeoutMs, 40);
assert.equal(normalizedRuntimeOptions.nativeEngineFailOpen, false);
assert.equal(normalizedRuntimeOptions.graphNativeForceDisable, true);

const layoutBridge = new GraphNativeLayoutBridge({
  graphUseNativeLayout: true,
  graphNativeLayoutThresholdNodes: 280,
  graphNativeLayoutThresholdEdges: 1600,
});
assert.equal(layoutBridge.shouldRunForGraph(279, 1599), false);
assert.equal(layoutBridge.shouldRunForGraph(280, 0), true);
assert.equal(layoutBridge.shouldRunForGraph(0, 1600), true);
layoutBridge.updateRuntimeOptions({ graphNativeForceDisable: true });
assert.equal(layoutBridge.shouldRunForGraph(500, 5000), false);

const hydrateGateDefaults = resolveNativeHydrateGateOptions({});
assert.equal(hydrateGateDefaults.minSnapshotRecords, 30000);

const hydrateBlocked = evaluateNativeHydrateGate(
  { nodes: new Array(29999).fill({}), edges: [] },
  { loadNativeHydrateThresholdRecords: 30000 },
);
assert.equal(hydrateBlocked.allowed, false);
assert.deepEqual(hydrateBlocked.reasons, ["below-min-snapshot-records"]);
assert.equal(hydrateBlocked.recordCount, 29999);

const hydrateAllowed = evaluateNativeHydrateGate(
  { nodes: new Array(30000).fill({}), edges: [] },
  { loadNativeHydrateThresholdRecords: 30000 },
);
assert.equal(hydrateAllowed.allowed, true);
assert.deepEqual(hydrateAllowed.reasons, []);
assert.equal(hydrateAllowed.recordCount, 30000);

const persistGateDefaults = resolvePersistNativeDeltaGateOptions({});
assert.equal(persistGateDefaults.minSnapshotRecords, 20000);
assert.equal(persistGateDefaults.minStructuralDelta, 600);
assert.equal(persistGateDefaults.minCombinedSerializedChars, 4000000);

const persistBlocked = evaluatePersistNativeDeltaGate(
  {
    nodes: new Array(500).fill({}),
    edges: new Array(200).fill({}),
    tombstones: [],
  },
  {
    nodes: new Array(520).fill({}),
    edges: new Array(210).fill({}),
    tombstones: [],
  },
  {
    persistNativeDeltaThresholdRecords: 20000,
    persistNativeDeltaThresholdStructuralDelta: 600,
    persistNativeDeltaThresholdSerializedChars: 4000000,
    measuredCombinedSerializedChars: 1024,
  },
);
assert.equal(persistBlocked.allowed, false);
assert.deepEqual(persistBlocked.reasons, [
  "below-record-threshold",
  "below-structural-delta-threshold",
  "below-serialized-chars-threshold",
]);
assert.equal(persistBlocked.maxSnapshotRecords, 730);
assert.equal(persistBlocked.structuralDelta, 30);
assert.equal(persistBlocked.combinedSerializedChars, 1024);

const persistAllowed = evaluatePersistNativeDeltaGate(
  {
    nodes: new Array(10000).fill({}),
    edges: new Array(10000).fill({}),
    tombstones: [],
  },
  {
    nodes: new Array(10400).fill({}),
    edges: new Array(10400).fill({}),
    tombstones: new Array(250).fill({}),
  },
  {
    persistNativeDeltaThresholdRecords: 20000,
    persistNativeDeltaThresholdStructuralDelta: 600,
    persistNativeDeltaThresholdSerializedChars: 4000000,
    measuredCombinedSerializedChars: 5000000,
  },
);
assert.equal(persistAllowed.allowed, true);
assert.deepEqual(persistAllowed.reasons, []);
assert.equal(persistAllowed.maxSnapshotRecords, 21050);
assert.equal(persistAllowed.structuralDelta, 1050);
assert.equal(persistAllowed.combinedSerializedChars, 5000000);

console.log("native-rollout-matrix tests passed");
