import { performance } from "node:perf_hooks";

import { buildPersistDelta } from "../../sync/bme-db.js";
import {
  getNativeModuleStatus,
  installNativePersistDeltaHook,
} from "../../vendor/wasm/stbme_core.js";

const RUNS = 5;

function buildSnapshots(seed = 5, nodeCount = 5000, edgeCount = 12000, churn = 0.1) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  const beforeNodes = [];
  for (let i = 0; i < nodeCount; i++) {
    beforeNodes.push({
      id: `n-${i}`,
      type: "event",
      fields: {
        text: `node-${i}`,
        v: Math.floor(rand() * 1000),
      },
      archived: false,
      updatedAt: 1000 + i,
    });
  }

  const beforeEdges = [];
  for (let i = 0; i < edgeCount; i++) {
    const from = Math.floor(rand() * nodeCount);
    let to = Math.floor(rand() * nodeCount);
    if (to === from) to = (to + 1) % nodeCount;
    beforeEdges.push({
      id: `e-${i}`,
      fromId: `n-${from}`,
      toId: `n-${to}`,
      relation: "related",
      strength: rand(),
      updatedAt: 1000 + i,
    });
  }

  const afterNodes = beforeNodes.map((node) => ({ ...node, fields: { ...node.fields } }));
  const afterEdges = beforeEdges.map((edge) => ({ ...edge }));

  const mutateNodeCount = Math.floor(nodeCount * churn);
  for (let i = 0; i < mutateNodeCount; i++) {
    const index = Math.floor(rand() * afterNodes.length);
    afterNodes[index].fields.v = Math.floor(rand() * 5000);
    afterNodes[index].updatedAt += 100;
  }

  const addNodeCount = Math.max(1, Math.floor(nodeCount * churn * 0.25));
  const baseNodeId = afterNodes.length;
  for (let i = 0; i < addNodeCount; i++) {
    afterNodes.push({
      id: `n-new-${baseNodeId + i}`,
      type: "event",
      fields: { text: `new-${i}`, v: Math.floor(rand() * 3000) },
      archived: false,
      updatedAt: 5000 + i,
    });
  }

  const removeEdgeCount = Math.max(1, Math.floor(edgeCount * churn * 0.2));
  afterEdges.splice(0, removeEdgeCount);

  return {
    before: {
      meta: { chatId: "bench-chat", revision: 1, lastModified: 1000 },
      state: { lastProcessedFloor: 1, extractionCount: 1 },
      nodes: beforeNodes,
      edges: beforeEdges,
      tombstones: [],
    },
    after: {
      meta: { chatId: "bench-chat", revision: 2, lastModified: 2000 },
      state: { lastProcessedFloor: 2, extractionCount: 2 },
      nodes: afterNodes,
      edges: afterEdges,
      tombstones: [],
    },
  };
}

function summarize(values = []) {
  if (!values.length) return { avg: 0, p95: 0, min: 0, max: 0 };
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

async function main() {
  await installNativePersistDeltaHook();
  const nativeStatus = getNativeModuleStatus();
  const jsSamples = [];
  const nativeJsonSamples = [];
  const nativeHashSamples = [];
  for (let run = 0; run < RUNS; run++) {
    const snapshots = buildSnapshots(17 + run, 5000, 12000, 0.12);
    const jsStartedAt = performance.now();
    const jsDelta = buildPersistDelta(snapshots.before, snapshots.after, {
      useNativeDelta: false,
    });
    const jsElapsedMs = performance.now() - jsStartedAt;
    jsSamples.push({
      elapsedMs: jsElapsedMs,
      upsertNodes: jsDelta.upsertNodes.length,
      upsertEdges: jsDelta.upsertEdges.length,
      deleteNodeIds: jsDelta.deleteNodeIds.length,
      deleteEdgeIds: jsDelta.deleteEdgeIds.length,
    });

    const nativeJsonStartedAt = performance.now();
    const nativeJsonDelta = buildPersistDelta(snapshots.before, snapshots.after, {
      useNativeDelta: true,
      minSnapshotRecords: 0,
      minStructuralDelta: 0,
      minCombinedSerializedChars: 0,
      persistNativeDeltaBridgeMode: "json",
      nativeFailOpen: false,
    });
    const nativeJsonElapsedMs = performance.now() - nativeJsonStartedAt;
    nativeJsonSamples.push({
      elapsedMs: nativeJsonElapsedMs,
      upsertNodes: nativeJsonDelta.upsertNodes.length,
      upsertEdges: nativeJsonDelta.upsertEdges.length,
      deleteNodeIds: nativeJsonDelta.deleteNodeIds.length,
      deleteEdgeIds: nativeJsonDelta.deleteEdgeIds.length,
    });

    const nativeHashStartedAt = performance.now();
    const nativeHashDelta = buildPersistDelta(snapshots.before, snapshots.after, {
      useNativeDelta: true,
      minSnapshotRecords: 0,
      minStructuralDelta: 0,
      minCombinedSerializedChars: 0,
      persistNativeDeltaBridgeMode: "hash",
      nativeFailOpen: false,
    });
    const nativeHashElapsedMs = performance.now() - nativeHashStartedAt;
    nativeHashSamples.push({
      elapsedMs: nativeHashElapsedMs,
      upsertNodes: nativeHashDelta.upsertNodes.length,
      upsertEdges: nativeHashDelta.upsertEdges.length,
      deleteNodeIds: nativeHashDelta.deleteNodeIds.length,
      deleteEdgeIds: nativeHashDelta.deleteEdgeIds.length,
    });
  }

  const jsTimingSummary = summarize(jsSamples.map((sample) => sample.elapsedMs));
  const nativeJsonTimingSummary = summarize(
    nativeJsonSamples.map((sample) => sample.elapsedMs),
  );
  const nativeHashTimingSummary = summarize(
    nativeHashSamples.map((sample) => sample.elapsedMs),
  );
  const avgUpserts =
    jsSamples.reduce((acc, sample) => acc + sample.upsertNodes + sample.upsertEdges, 0) /
    jsSamples.length;
  const avgDeletes =
    jsSamples.reduce((acc, sample) => acc + sample.deleteNodeIds + sample.deleteEdgeIds, 0) /
    jsSamples.length;

  console.log(
    `[ST-BME][bench] persist-delta native-source=${nativeStatus.source || "unknown"}`,
  );
  console.log(
    `[ST-BME][bench] persist-delta runs=${RUNS} | js avg=${jsTimingSummary.avg.toFixed(2)}ms p95=${jsTimingSummary.p95.toFixed(2)}ms min=${jsTimingSummary.min.toFixed(2)}ms max=${jsTimingSummary.max.toFixed(2)}ms | native-json avg=${nativeJsonTimingSummary.avg.toFixed(2)}ms p95=${nativeJsonTimingSummary.p95.toFixed(2)}ms min=${nativeJsonTimingSummary.min.toFixed(2)}ms max=${nativeJsonTimingSummary.max.toFixed(2)}ms | native-hash avg=${nativeHashTimingSummary.avg.toFixed(2)}ms p95=${nativeHashTimingSummary.p95.toFixed(2)}ms min=${nativeHashTimingSummary.min.toFixed(2)}ms max=${nativeHashTimingSummary.max.toFixed(2)}ms | avgUpserts=${avgUpserts.toFixed(1)} avgDeletes=${avgDeletes.toFixed(1)}`,
  );
}

main().catch((error) => {
  console.error("[ST-BME][bench] persist-delta failed:", error?.message || String(error));
  process.exitCode = 1;
});
