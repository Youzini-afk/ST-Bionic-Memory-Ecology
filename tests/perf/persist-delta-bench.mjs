import { performance } from "node:perf_hooks";

import {
  buildPersistDelta,
  resetPersistRecordSerializationCaches,
} from "../../sync/bme-db.js";
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

function summarizeDiagnostics(samples = []) {
  const summary = {
    prepareMs: 0,
    nativeAttemptMs: 0,
    lookupMs: 0,
    jsDiffMs: 0,
    hydrateMs: 0,
    serializationCacheHits: 0,
    serializationCacheMisses: 0,
    preparedRecordSetCacheHits: 0,
    preparedRecordSetCacheMisses: 0,
  };
  if (!samples.length) return summary;
  for (const sample of samples) {
    summary.prepareMs += Number(sample?.prepareMs || 0);
    summary.nativeAttemptMs += Number(sample?.nativeAttemptMs || 0);
    summary.lookupMs += Number(sample?.lookupMs || 0);
    summary.jsDiffMs += Number(sample?.jsDiffMs || 0);
    summary.hydrateMs += Number(sample?.hydrateMs || 0);
    summary.serializationCacheHits += Number(sample?.serializationCacheHits || 0);
    summary.serializationCacheMisses += Number(sample?.serializationCacheMisses || 0);
    summary.preparedRecordSetCacheHits += Number(
      sample?.preparedRecordSetCacheHits || 0,
    );
    summary.preparedRecordSetCacheMisses += Number(
      sample?.preparedRecordSetCacheMisses || 0,
    );
  }
  for (const key of Object.keys(summary)) {
    summary[key] /= samples.length;
  }
  return summary;
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

function buildModeOptions(mode, onDiagnostics, extraOptions = {}) {
  if (mode === "native-json") {
    return {
      useNativeDelta: true,
      minSnapshotRecords: 0,
      minStructuralDelta: 0,
      minCombinedSerializedChars: 0,
      persistNativeDeltaBridgeMode: "json",
      nativeFailOpen: false,
      onDiagnostics,
      ...extraOptions,
    };
  }
  if (mode === "native-hash") {
    return {
      useNativeDelta: true,
      minSnapshotRecords: 0,
      minStructuralDelta: 0,
      minCombinedSerializedChars: 0,
      persistNativeDeltaBridgeMode: "hash",
      nativeFailOpen: false,
      onDiagnostics,
      ...extraOptions,
    };
  }
  return {
    useNativeDelta: false,
    onDiagnostics,
    ...extraOptions,
  };
}

function runMeasuredPersistDeltaSample(
  snapshots,
  mode,
  { resetCaches = true, usePreparedRecordSetCache = true } = {},
) {
  if (resetCaches) {
    resetPersistRecordSerializationCaches();
  }
  let diagnostics = null;
  const startedAt = performance.now();
  const delta = buildPersistDelta(
    snapshots.before,
    snapshots.after,
    buildModeOptions(
      mode,
      (snapshot) => {
        diagnostics = snapshot;
      },
      { usePreparedRecordSetCache },
    ),
  );
  const elapsedMs = performance.now() - startedAt;
  return {
    elapsedMs,
    upsertNodes: delta.upsertNodes.length,
    upsertEdges: delta.upsertEdges.length,
    deleteNodeIds: delta.deleteNodeIds.length,
    deleteEdgeIds: delta.deleteEdgeIds.length,
    prepareMs: diagnostics?.prepareMs,
    nativeAttemptMs: diagnostics?.nativeAttemptMs,
    lookupMs: diagnostics?.lookupMs,
    jsDiffMs: diagnostics?.jsDiffMs,
    hydrateMs: diagnostics?.hydrateMs,
    serializationCacheHits: diagnostics?.serializationCacheHits,
    serializationCacheMisses: diagnostics?.serializationCacheMisses,
    preparedRecordSetCacheHits: diagnostics?.preparedRecordSetCacheHits,
    preparedRecordSetCacheMisses: diagnostics?.preparedRecordSetCacheMisses,
  };
}

function primePersistDeltaCaches(snapshots, mode) {
  buildPersistDelta(
    snapshots.before,
    snapshots.after,
    buildModeOptions(mode, undefined, {
      usePreparedRecordSetCache: true,
      onDiagnostics() {},
    }),
  );
}

function formatTimingSummary(label, samples = []) {
  const timingSummary = summarize(samples.map((sample) => sample.elapsedMs));
  return `${label} avg=${timingSummary.avg.toFixed(2)}ms p95=${timingSummary.p95.toFixed(2)}ms min=${timingSummary.min.toFixed(2)}ms max=${timingSummary.max.toFixed(2)}ms`;
}

function formatStageSummary(label, samples = []) {
  const diagnosticsSummary = summarizeDiagnostics(samples);
  return `${label} prepare=${diagnosticsSummary.prepareMs.toFixed(2)}ms native=${diagnosticsSummary.nativeAttemptMs.toFixed(2)}ms lookup=${diagnosticsSummary.lookupMs.toFixed(2)}ms diff=${diagnosticsSummary.jsDiffMs.toFixed(2)}ms hydrate=${diagnosticsSummary.hydrateMs.toFixed(2)}ms ser-cache=${diagnosticsSummary.serializationCacheHits.toFixed(1)}H/${diagnosticsSummary.serializationCacheMisses.toFixed(1)}M set-cache=${diagnosticsSummary.preparedRecordSetCacheHits.toFixed(1)}H/${diagnosticsSummary.preparedRecordSetCacheMisses.toFixed(1)}M`;
}

async function main() {
  await installNativePersistDeltaHook();
  const nativeStatus = getNativeModuleStatus();
  const coldSamplesByMode = {
    js: [],
    "native-json": [],
    "native-hash": [],
  };
  const warmSamplesByMode = {
    js: [],
    "native-json": [],
    "native-hash": [],
  };
  const modes = ["js", "native-json", "native-hash"];
  for (let run = 0; run < RUNS; run++) {
    const snapshots = buildSnapshots(17 + run, 5000, 12000, 0.12);
    for (const mode of modes) {
      coldSamplesByMode[mode].push(
        runMeasuredPersistDeltaSample(snapshots, mode, {
          resetCaches: true,
          usePreparedRecordSetCache: false,
        }),
      );
      resetPersistRecordSerializationCaches();
      primePersistDeltaCaches(snapshots, mode);
      warmSamplesByMode[mode].push(
        runMeasuredPersistDeltaSample(snapshots, mode, {
          resetCaches: false,
          usePreparedRecordSetCache: true,
        }),
      );
    }
  }

  const avgUpserts =
    coldSamplesByMode.js.reduce(
      (acc, sample) => acc + sample.upsertNodes + sample.upsertEdges,
      0,
    ) / coldSamplesByMode.js.length;
  const avgDeletes =
    coldSamplesByMode.js.reduce(
      (acc, sample) => acc + sample.deleteNodeIds + sample.deleteEdgeIds,
      0,
    ) / coldSamplesByMode.js.length;

  console.log(
    `[ST-BME][bench] persist-delta native-source=${nativeStatus.source || "unknown"}`,
  );
  console.log(
    `[ST-BME][bench] persist-delta cold runs=${RUNS} | ${formatTimingSummary("js", coldSamplesByMode.js)} | ${formatTimingSummary("native-json", coldSamplesByMode["native-json"])} | ${formatTimingSummary("native-hash", coldSamplesByMode["native-hash"])} | avgUpserts=${avgUpserts.toFixed(1)} avgDeletes=${avgDeletes.toFixed(1)}`,
  );
  console.log(
    `[ST-BME][bench] persist-delta cold stages | ${formatStageSummary("js", coldSamplesByMode.js)} | ${formatStageSummary("native-json", coldSamplesByMode["native-json"])} | ${formatStageSummary("native-hash", coldSamplesByMode["native-hash"])} `,
  );
  console.log(
    `[ST-BME][bench] persist-delta warm runs=${RUNS} | ${formatTimingSummary("js", warmSamplesByMode.js)} | ${formatTimingSummary("native-json", warmSamplesByMode["native-json"])} | ${formatTimingSummary("native-hash", warmSamplesByMode["native-hash"])} `,
  );
  console.log(
    `[ST-BME][bench] persist-delta warm stages | ${formatStageSummary("js", warmSamplesByMode.js)} | ${formatStageSummary("native-json", warmSamplesByMode["native-json"])} | ${formatStageSummary("native-hash", warmSamplesByMode["native-hash"])} `,
  );
}

main().catch((error) => {
  console.error("[ST-BME][bench] persist-delta failed:", error?.message || String(error));
  process.exitCode = 1;
});
