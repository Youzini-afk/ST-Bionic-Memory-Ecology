import assert from "node:assert/strict";

import {
  buildPersistDelta,
  evaluatePersistNativeDeltaGate,
  resolvePersistNativeDeltaBridgeMode,
  resolvePersistNativeDeltaGateOptions,
  shouldUseNativePersistDeltaForSnapshots,
} from "../sync/bme-db.js";

const beforeSnapshot = {
  meta: { chatId: "chat-native", revision: 1, lastModified: 1 },
  state: { lastProcessedFloor: 1, extractionCount: 1 },
  nodes: [{ id: "n1", type: "event", fields: { text: "before" }, updatedAt: 1 }],
  edges: [],
  tombstones: [],
};

const afterSnapshot = {
  meta: { chatId: "chat-native", revision: 2, lastModified: 2 },
  state: { lastProcessedFloor: 2, extractionCount: 2 },
  nodes: [{ id: "n1", type: "event", fields: { text: "after" }, updatedAt: 2 }],
  edges: [],
  tombstones: [],
};

let fallbackDiagnostics = null;
const fallbackDelta = buildPersistDelta(beforeSnapshot, afterSnapshot, {
  onDiagnostics(snapshot) {
    fallbackDiagnostics = snapshot;
  },
});
assert.equal(fallbackDelta.upsertNodes.length, 1);
assert.equal(fallbackDelta.deleteNodeIds.length, 0);
assert.equal(fallbackDiagnostics.path, "js");
assert.equal(fallbackDiagnostics.requestedNative, false);
assert.equal(fallbackDiagnostics.usedNative, false);
assert.equal(Number.isFinite(fallbackDiagnostics.buildMs), true);

const defaultGate = resolvePersistNativeDeltaGateOptions({});
assert.equal(defaultGate.minSnapshotRecords, 20000);
assert.equal(defaultGate.minStructuralDelta, 600);
assert.equal(defaultGate.minCombinedSerializedChars, 4000000);
assert.equal(resolvePersistNativeDeltaBridgeMode({}), "json");
assert.equal(resolvePersistNativeDeltaBridgeMode({ persistNativeDeltaBridgeMode: "hash" }), "hash");
assert.equal(resolvePersistNativeDeltaBridgeMode({ persistNativeDeltaBridgeMode: "unknown" }), "json");
assert.equal(
  shouldUseNativePersistDeltaForSnapshots(beforeSnapshot, afterSnapshot, defaultGate),
  false,
);
const payloadGate = evaluatePersistNativeDeltaGate(beforeSnapshot, afterSnapshot, {
  minSnapshotRecords: 0,
  minStructuralDelta: 0,
  minCombinedSerializedChars: 200,
  measuredCombinedSerializedChars: 120,
});
assert.equal(payloadGate.allowed, false);
assert.deepEqual(payloadGate.reasons, ["below-serialized-chars-threshold"]);
assert.equal(
  shouldUseNativePersistDeltaForSnapshots(beforeSnapshot, afterSnapshot, {
    minSnapshotRecords: 1,
    minStructuralDelta: 0,
  }),
  true,
);

const largeBeforeSnapshot = {
  nodes: new Array(20500).fill(0),
  edges: new Array(200).fill(0),
  tombstones: [],
};
const largeAfterSnapshot = {
  nodes: new Array(21120).fill(0),
  edges: new Array(200).fill(0),
  tombstones: [],
};
assert.equal(
  shouldUseNativePersistDeltaForSnapshots(
    largeBeforeSnapshot,
    largeAfterSnapshot,
    defaultGate,
  ),
  true,
);

const originalNativeBuilder = globalThis.__stBmeNativeBuildPersistDelta;

globalThis.__stBmeNativeBuildPersistDelta = () => ({
  upsertNodes: [{ id: "native-node" }],
  upsertEdges: [{ id: "native-edge" }],
  deleteNodeIds: ["native-delete-node"],
  deleteEdgeIds: ["native-delete-edge"],
  tombstones: [{ id: "node:native-delete-node", kind: "node", targetId: "native-delete-node" }],
  runtimeMetaPatch: { native: true },
});

let nativeDiagnostics = null;
const nativeDelta = buildPersistDelta(beforeSnapshot, afterSnapshot, {
  useNativeDelta: true,
  minSnapshotRecords: 0,
  minStructuralDelta: 0,
  minCombinedSerializedChars: 0,
  runtimeMetaPatch: { jsPatch: true },
  onDiagnostics(snapshot) {
    nativeDiagnostics = snapshot;
  },
});
assert.deepEqual(nativeDelta.upsertNodes, [{ id: "native-node" }]);
assert.deepEqual(nativeDelta.deleteNodeIds, ["native-delete-node"]);
assert.equal(nativeDelta.runtimeMetaPatch.native, true);
assert.equal(nativeDelta.runtimeMetaPatch.jsPatch, true);
assert.equal(nativeDiagnostics.path, "native-full");
assert.equal(nativeDiagnostics.requestedNative, true);
assert.equal(nativeDiagnostics.usedNative, true);

let payloadGateDiagnostics = null;
let payloadGateBuilderCalled = false;
globalThis.__stBmeNativeBuildPersistDelta = () => {
  payloadGateBuilderCalled = true;
  return { upsertNodes: [] };
};
const payloadGatedDelta = buildPersistDelta(beforeSnapshot, afterSnapshot, {
  useNativeDelta: true,
  minSnapshotRecords: 0,
  minStructuralDelta: 0,
  minCombinedSerializedChars: 1000,
  onDiagnostics(snapshot) {
    payloadGateDiagnostics = snapshot;
  },
});
assert.equal(payloadGateBuilderCalled, false);
assert.equal(payloadGatedDelta.upsertNodes.length, 1);
assert.equal(payloadGateDiagnostics.path, "js");
assert.equal(payloadGateDiagnostics.nativeAttemptStatus, "gated-out");
assert.equal(payloadGateDiagnostics.gateAllowed, false);
assert.deepEqual(payloadGateDiagnostics.gateReasons, ["below-serialized-chars-threshold"]);

globalThis.__stBmeNativeBuildPersistDelta = (_before, _after, options = {}) => {
  assert.equal(Boolean(options?.preparedDeltaInput), true);
  return {
    upsertNodeIds: ["n1"],
    upsertEdgeIds: [],
    deleteNodeIds: [],
    deleteEdgeIds: [],
    upsertTombstoneIds: [],
  };
};

let compactDiagnostics = null;
const compactNativeDelta = buildPersistDelta(beforeSnapshot, afterSnapshot, {
  useNativeDelta: true,
  minSnapshotRecords: 0,
  minStructuralDelta: 0,
  minCombinedSerializedChars: 0,
  runtimeMetaPatch: { compact: true },
  onDiagnostics(snapshot) {
    compactDiagnostics = snapshot;
  },
});
assert.deepEqual(compactNativeDelta.upsertNodes, [
  { id: "n1", type: "event", fields: { text: "after" }, updatedAt: 2 },
]);
assert.deepEqual(compactNativeDelta.upsertEdges, []);
assert.deepEqual(compactNativeDelta.deleteNodeIds, []);
assert.equal(compactNativeDelta.runtimeMetaPatch.compact, true);
assert.equal(compactNativeDelta.runtimeMetaPatch.chatId, "chat-native");
assert.equal(compactDiagnostics.path, "native-compact-json");
assert.equal(compactDiagnostics.preparedBridgeMode, "json");
assert.equal(compactDiagnostics.requestedBridgeMode, "json");
assert.equal(compactDiagnostics.usedNative, true);

let hashDiagnostics = null;
const hashNativeDelta = buildPersistDelta(beforeSnapshot, afterSnapshot, {
  useNativeDelta: true,
  minSnapshotRecords: 0,
  minStructuralDelta: 0,
  minCombinedSerializedChars: 0,
  persistNativeDeltaBridgeMode: "hash",
  runtimeMetaPatch: { hashMode: true },
  onDiagnostics(snapshot) {
    hashDiagnostics = snapshot;
  },
});
assert.deepEqual(hashNativeDelta.upsertNodes, [
  { id: "n1", type: "event", fields: { text: "after" }, updatedAt: 2 },
]);
assert.equal(hashNativeDelta.runtimeMetaPatch.hashMode, true);
assert.equal(hashDiagnostics.path, "native-compact-hash");
assert.equal(hashDiagnostics.preparedBridgeMode, "hash");
assert.equal(hashDiagnostics.requestedBridgeMode, "hash");
assert.equal(hashDiagnostics.usedNative, true);

delete globalThis.__stBmeNativeBuildPersistDelta;

let threwUnavailable = false;
try {
  buildPersistDelta(beforeSnapshot, afterSnapshot, {
    useNativeDelta: true,
    minSnapshotRecords: 0,
    minStructuralDelta: 0,
    minCombinedSerializedChars: 0,
    nativeFailOpen: false,
  });
} catch (error) {
  threwUnavailable =
    String(error?.message || "") === "native-persist-delta-builder-unavailable";
}
assert.equal(threwUnavailable, true);

if (typeof originalNativeBuilder === "function") {
  globalThis.__stBmeNativeBuildPersistDelta = originalNativeBuilder;
}

console.log("native-persist-delta-hook tests passed");
