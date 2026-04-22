import { performance } from "node:perf_hooks";

import {
  buildGraphFromSnapshot,
  buildPersistDelta,
  buildSnapshotFromGraph,
} from "../../sync/bme-db.js";
import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  OpfsGraphStore,
} from "../../sync/bme-opfs-store.js";
import { createMemoryOpfsRoot } from "../helpers/memory-opfs.mjs";

const RUNS = 4;
const SIZE_PRESETS = [
  { label: "M", seed: 17, nodeCount: 1200, edgeCount: 3600, churn: 0.08 },
  { label: "L", seed: 29, nodeCount: 3600, edgeCount: 10800, churn: 0.1 },
  { label: "XL", seed: 43, nodeCount: 7200, edgeCount: 21600, churn: 0.12 },
];

function summarize(values = []) {
  if (!values.length) {
    return { avg: 0, p95: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    avg: sum / sorted.length,
    p95: sorted[p95Index],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function formatSummary(label, values = []) {
  const summary = summarize(values);
  return `${label} avg=${summary.avg.toFixed(2)}ms p95=${summary.p95.toFixed(2)}ms min=${summary.min.toFixed(2)}ms max=${summary.max.toFixed(2)}ms`;
}

function createRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function buildRuntimeGraph(seed = 1, nodeCount = 100, edgeCount = 200, chatId = "bench-chat") {
  const rand = createRandom(seed);
  const nodes = [];
  const edges = [];
  for (let index = 0; index < nodeCount; index += 1) {
    nodes.push({
      id: `node-${index}`,
      type: "event",
      updatedAt: 1000 + index,
      archived: false,
      sourceFloor: index,
      fields: {
        title: `Node ${index}`,
        text: `node-${index}-${Math.floor(rand() * 100000)}`,
      },
    });
  }
  for (let index = 0; index < edgeCount; index += 1) {
    const fromIndex = Math.floor(rand() * nodeCount);
    let toIndex = Math.floor(rand() * nodeCount);
    if (toIndex === fromIndex) {
      toIndex = (toIndex + 1) % nodeCount;
    }
    edges.push({
      id: `edge-${index}`,
      fromId: `node-${fromIndex}`,
      toId: `node-${toIndex}`,
      relation: "related",
      strength: rand(),
      updatedAt: 2000 + index,
    });
  }
  return {
    version: 1,
    nodes,
    edges,
    historyState: {
      chatId,
      lastProcessedAssistantFloor: Math.max(0, Math.floor(nodeCount / 12)),
      extractionCount: Math.max(1, Math.floor(nodeCount / 40)),
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
      lastMutationSource: "bench",
      lastExtractedRegion: "",
      lastExtractedStorySegmentId: "",
      activeCharacterPovOwner: "",
      activeUserPovOwner: "",
    },
    vectorIndexState: {
      chatId,
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
    knowledgeState: {
      owners: {},
      activeOwnerKey: "",
    },
    regionState: {
      activeRegion: "",
      knownRegions: {},
      manualActiveRegion: "",
    },
    timelineState: {
      activeSegmentId: "",
      manualActiveSegmentId: "",
      segments: [],
    },
    summaryState: {
      updatedAt: 0,
      entries: [],
    },
    batchJournal: [],
    maintenanceJournal: [],
    lastRecallResult: null,
    lastProcessedSeq: Math.max(0, Math.floor(nodeCount / 12)),
  };
}

function mutateRuntimeGraph(baseGraph, seed = 1, churn = 0.1) {
  const rand = createRandom(seed);
  const nextGraph = structuredClone(baseGraph);
  const mutateNodeCount = Math.max(1, Math.floor(nextGraph.nodes.length * churn));
  const mutateEdgeCount = Math.max(1, Math.floor(nextGraph.edges.length * churn * 0.5));
  for (let index = 0; index < mutateNodeCount; index += 1) {
    const nodeIndex = Math.floor(rand() * nextGraph.nodes.length);
    const node = nextGraph.nodes[nodeIndex];
    node.updatedAt += 100 + index;
    node.fields.text = `${node.fields.text}-mut-${index}`;
  }
  for (let index = 0; index < mutateEdgeCount; index += 1) {
    const edgeIndex = Math.floor(rand() * nextGraph.edges.length);
    const edge = nextGraph.edges[edgeIndex];
    edge.updatedAt += 80 + index;
    edge.strength = rand();
  }
  const addNodeCount = Math.max(1, Math.floor(nextGraph.nodes.length * churn * 0.12));
  const baseNodeId = nextGraph.nodes.length;
  for (let index = 0; index < addNodeCount; index += 1) {
    nextGraph.nodes.push({
      id: `node-new-${baseNodeId + index}`,
      type: "event",
      updatedAt: 5000 + index,
      archived: false,
      sourceFloor: baseNodeId + index,
      fields: {
        title: `Node new ${index}`,
        text: `new-node-${index}`,
      },
    });
  }
  const deleteEdgeCount = Math.max(1, Math.floor(nextGraph.edges.length * churn * 0.08));
  nextGraph.edges.splice(0, deleteEdgeCount);
  nextGraph.historyState.lastProcessedAssistantFloor += 1;
  nextGraph.historyState.extractionCount += 1;
  nextGraph.lastProcessedSeq = nextGraph.historyState.lastProcessedAssistantFloor;
  nextGraph.summaryState.updatedAt += 1;
  return nextGraph;
}

function buildBenchPair({ label, seed, nodeCount, edgeCount, churn }) {
  const chatId = `bench-${label.toLowerCase()}`;
  const beforeGraph = buildRuntimeGraph(seed, nodeCount, edgeCount, chatId);
  const afterGraph = mutateRuntimeGraph(beforeGraph, seed + 101, churn);
  return {
    label,
    chatId,
    beforeGraph,
    afterGraph,
  };
}

function measureSnapshotBuild(graph, options) {
  let diagnostics = null;
  const startedAt = performance.now();
  const snapshot = buildSnapshotFromGraph(graph, {
    ...options,
    onDiagnostics(snapshotValue) {
      diagnostics = snapshotValue;
    },
  });
  return {
    elapsedMs: performance.now() - startedAt,
    snapshot,
    diagnostics,
  };
}

function measureHydrate(snapshot, chatId) {
  let diagnostics = null;
  const startedAt = performance.now();
  buildGraphFromSnapshot(snapshot, {
    chatId,
    onDiagnostics(snapshotValue) {
      diagnostics = snapshotValue;
    },
  });
  return {
    elapsedMs: performance.now() - startedAt,
    diagnostics,
  };
}

async function measureOpfsCommit(baseSnapshot, afterSnapshot, delta, chatId) {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore(chatId, {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();
  await store.importSnapshot(baseSnapshot, {
    mode: "replace",
    preserveRevision: true,
    markSyncDirty: false,
  });
  const startedAt = performance.now();
  const result = await store.commitDelta(delta, {
    reason: "bench-commit",
    requestedRevision: Number(afterSnapshot?.meta?.revision || 0),
    markSyncDirty: true,
    committedSnapshot: afterSnapshot,
  });
  const elapsedMs = performance.now() - startedAt;
  await store.close();
  return {
    elapsedMs,
    diagnostics: result?.diagnostics || {},
  };
}

async function runPreset(preset) {
  const snapshotBuildSamples = [];
  const hydrateSamples = [];
  const opfsCommitSamples = [];
  const snapshotNodesSamples = [];
  const hydrateRuntimeMetaSamples = [];
  const walFileWriteSamples = [];
  const manifestFileWriteSamples = [];

  for (let run = 0; run < RUNS; run += 1) {
    const pair = buildBenchPair({
      ...preset,
      seed: preset.seed + run * 17,
    });
    const beforeSnapshotResult = measureSnapshotBuild(pair.beforeGraph, {
      chatId: pair.chatId,
      revision: 1,
    });
    const afterSnapshotResult = measureSnapshotBuild(pair.afterGraph, {
      chatId: pair.chatId,
      revision: 2,
      baseSnapshot: beforeSnapshotResult.snapshot,
    });
    const delta = buildPersistDelta(
      beforeSnapshotResult.snapshot,
      afterSnapshotResult.snapshot,
      { useNativeDelta: false },
    );
    const hydrateResult = measureHydrate(afterSnapshotResult.snapshot, pair.chatId);
    const opfsCommitResult = await measureOpfsCommit(
      beforeSnapshotResult.snapshot,
      afterSnapshotResult.snapshot,
      delta,
      pair.chatId,
    );

    snapshotBuildSamples.push(afterSnapshotResult.elapsedMs);
    hydrateSamples.push(hydrateResult.elapsedMs);
    opfsCommitSamples.push(opfsCommitResult.elapsedMs);
    snapshotNodesSamples.push(Number(afterSnapshotResult.diagnostics?.nodesMs || 0));
    hydrateRuntimeMetaSamples.push(Number(hydrateResult.diagnostics?.runtimeMetaMs || 0));
    walFileWriteSamples.push(Number(opfsCommitResult.diagnostics?.walFileWriteMs || 0));
    manifestFileWriteSamples.push(
      Number(opfsCommitResult.diagnostics?.manifestFileWriteMs || 0),
    );
  }

  console.log(`\n[ST-BME][persist-load-bench] ${preset.label}`);
  console.log(
    formatSummary("snapshot-build", snapshotBuildSamples),
    `nodesPhaseP95=${summarize(snapshotNodesSamples).p95.toFixed(2)}ms`,
  );
  console.log(
    formatSummary("hydrate", hydrateSamples),
    `runtimeMetaP95=${summarize(hydrateRuntimeMetaSamples).p95.toFixed(2)}ms`,
  );
  console.log(
    formatSummary("opfs-commit", opfsCommitSamples),
    `walFileP95=${summarize(walFileWriteSamples).p95.toFixed(2)}ms`,
    `manifestFileP95=${summarize(manifestFileWriteSamples).p95.toFixed(2)}ms`,
  );
}

async function main() {
  for (const preset of SIZE_PRESETS) {
    await runPreset(preset);
  }
}

await main();
