import assert from "node:assert/strict";

import {
  BME_RUNTIME_HISTORY_META_KEY,
  BME_RUNTIME_RECORDS_NORMALIZED_META_KEY,
  BME_RUNTIME_VECTOR_META_KEY,
  buildGraphFromSnapshot,
  evaluateNativeHydrateGate,
  resolveNativeHydrateGateOptions,
} from "../sync/bme-db.js";

function cloneValue(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

const snapshot = {
  meta: {
    chatId: "chat-native-hydrate",
    revision: 3,
    [BME_RUNTIME_RECORDS_NORMALIZED_META_KEY]: true,
    [BME_RUNTIME_HISTORY_META_KEY]: {
      chatId: "chat-native-hydrate",
      lastProcessedAssistantFloor: 7,
      extractionCount: 2,
      processedMessageHashes: {},
      processedMessageHashVersion: 1,
      processedMessageHashesNeedRefresh: false,
      recentRecallOwnerKeys: [],
      activeRecallOwnerKey: "",
      activeRegion: "",
      activeRegionSource: "",
      activeStorySegmentId: "",
      activeStoryTimeLabel: "",
      activeStoryTimeSource: "",
      lastBatchStatus: null,
      lastMutationSource: "test",
      lastExtractedRegion: "",
      lastExtractedStorySegmentId: "",
      activeCharacterPovOwner: "",
      activeUserPovOwner: "",
    },
    [BME_RUNTIME_VECTOR_META_KEY]: {
      chatId: "chat-native-hydrate",
      collectionId: "",
      hashToNodeId: {},
      nodeToHash: {},
      replayRequiredNodeIds: [],
      dirty: false,
      dirtyReason: "",
      pendingRepairFromFloor: null,
      lastIntegrityIssue: null,
      lastStats: {
        nodesIndexed: 0,
        updatedAt: 0,
      },
    },
  },
  state: {
    lastProcessedFloor: 7,
    extractionCount: 2,
  },
  nodes: [
    {
      id: "native-node-1",
      type: "event",
      updatedAt: 10,
      fields: {
        title: "Native Node",
      },
      embedding: [1, 2, 3],
      scope: {
        ownerType: "character",
        ownerId: "owner-1",
        layer: "objective",
        regionPrimary: "camp",
        regionPath: ["camp"],
        regionSecondary: [],
      },
      storyTime: {
        label: "Dawn",
        tense: "unknown",
      },
      storyTimeSpan: {
        startLabel: "Dawn",
        endLabel: "Dawn",
        mixed: false,
      },
    },
  ],
  edges: [
    {
      id: "native-edge-1",
      fromId: "native-node-1",
      toId: "native-node-2",
      relation: "related",
      scope: {
        ownerType: "character",
        ownerId: "owner-1",
        layer: "objective",
        regionPrimary: "camp",
        regionPath: ["camp"],
        regionSecondary: [],
      },
    },
  ],
  tombstones: [],
};

const defaultGate = resolveNativeHydrateGateOptions({});
assert.equal(defaultGate.minSnapshotRecords, 30000);
const gatedSmall = evaluateNativeHydrateGate(snapshot, {});
assert.equal(gatedSmall.allowed, false);
assert.deepEqual(gatedSmall.reasons, ["below-min-snapshot-records"]);
const gatedLarge = evaluateNativeHydrateGate(
  {
    nodes: new Array(15000).fill({ id: "node-x" }),
    edges: new Array(15000).fill({ id: "edge-x" }),
  },
  {},
);
assert.equal(gatedLarge.allowed, true);
assert.deepEqual(gatedLarge.reasons, []);

const originalNativeBuilder = globalThis.__stBmeNativeHydrateSnapshotRecords;

globalThis.__stBmeNativeHydrateSnapshotRecords = (snapshotView = {}, options = {}) => {
  assert.equal(options.recordsNormalized, true);
  return {
    ok: true,
    usedNative: true,
    nodes: cloneValue(snapshotView.nodes).map((node) => ({
      ...node,
      nativeHydrated: true,
    })),
    edges: cloneValue(snapshotView.edges).map((edge) => ({
      ...edge,
      nativeHydrated: true,
    })),
    diagnostics: {
      solver: "test-native-hydrate",
      nodeCount: Array.isArray(snapshotView.nodes) ? snapshotView.nodes.length : 0,
      edgeCount: Array.isArray(snapshotView.edges) ? snapshotView.edges.length : 0,
      recordsNormalized: options.recordsNormalized === true,
    },
  };
};

let nativeDiagnostics = null;
const rebuilt = buildGraphFromSnapshot(snapshot, {
  chatId: "chat-native-hydrate",
  useNativeHydrate: true,
  minSnapshotRecords: 0,
  onDiagnostics(snapshotValue) {
    nativeDiagnostics = snapshotValue;
  },
});
assert.equal(rebuilt.nodes[0].nativeHydrated, true);
assert.equal(rebuilt.edges[0].nativeHydrated, true);
assert.equal(rebuilt.historyState.lastProcessedAssistantFloor, 7);
assert.equal(nativeDiagnostics.nativeRequested, true);
assert.equal(nativeDiagnostics.nativeUsed, true);
assert.equal(nativeDiagnostics.nativeStatus, "ok");
assert.equal(nativeDiagnostics.nativeGateAllowed, true);
assert.equal(nativeDiagnostics.nativeModuleDiagnostics?.solver, "test-native-hydrate");
assert.equal(Number.isFinite(nativeDiagnostics.nativeRecordsMs), true);
rebuilt.nodes[0].fields.title = "Mutated Native Node";
rebuilt.nodes[0].embedding[0] = 99;
assert.equal(snapshot.nodes[0].fields.title, "Native Node");
assert.equal(snapshot.nodes[0].embedding[0], 1);

delete globalThis.__stBmeNativeHydrateSnapshotRecords;

let fallbackDiagnostics = null;
const fallbackGraph = buildGraphFromSnapshot(snapshot, {
  chatId: "chat-native-hydrate",
  useNativeHydrate: true,
  minSnapshotRecords: 0,
  onDiagnostics(snapshotValue) {
    fallbackDiagnostics = snapshotValue;
  },
});
assert.equal(fallbackGraph.nodes.length, 1);
assert.equal(fallbackDiagnostics.nativeRequested, true);
assert.equal(fallbackDiagnostics.nativeUsed, false);
assert.equal(fallbackDiagnostics.nativeStatus, "builder-unavailable");

let threwUnavailable = false;
try {
  buildGraphFromSnapshot(snapshot, {
    chatId: "chat-native-hydrate",
    useNativeHydrate: true,
    minSnapshotRecords: 0,
    nativeFailOpen: false,
  });
} catch (error) {
  threwUnavailable =
    String(error?.message || "") === "native-hydrate-builder-unavailable";
}
assert.equal(threwUnavailable, true);

if (typeof originalNativeBuilder === "function") {
  globalThis.__stBmeNativeHydrateSnapshotRecords = originalNativeBuilder;
}

console.log("native-hydrate-hook tests passed");
