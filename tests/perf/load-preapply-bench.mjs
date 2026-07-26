import { performance } from "node:perf_hooks";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  BmeDatabase,
  buildBmeDbName,
  buildGraphFromSnapshot,
  buildSnapshotFromGraph,
  ensureDexieLoaded,
} from "../../sync/bme-db.js";
import {
  BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  OpfsGraphStore,
} from "../../sync/bme-opfs-store.js";
import { createMemoryOpfsRoot } from "../helpers/memory-opfs.mjs";

const RUNS = 4;
const outputJson = process.argv.includes("--json");
const projectRootHint = String(process.env.ST_BME_NODE_MODULES_ROOT || "").trim();
const requireFromProjectRoot = projectRootHint
  ? createRequire(path.join(projectRootHint, "package.json"))
  : null;
const SIZE_PRESETS = [
  { label: "M", seed: 17, nodeCount: 1200, edgeCount: 3600 },
  { label: "L", seed: 29, nodeCount: 3600, edgeCount: 10800 },
  { label: "XL", seed: 43, nodeCount: 7200, edgeCount: 21600 },
];

async function importWithProjectRootFallback(specifier) {
  try {
    return await import(specifier);
  } catch (error) {
    if (!requireFromProjectRoot) {
      throw error;
    }
    const resolved = requireFromProjectRoot.resolve(specifier);
    return await import(pathToFileURL(resolved).href);
  }
}

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

function buildBenchSnapshot({ label, seed, nodeCount, edgeCount }) {
  const chatId = `load-bench-${label.toLowerCase()}-${seed}`;
  const graph = buildRuntimeGraph(seed, nodeCount, edgeCount, chatId);
  return {
    chatId,
    snapshot: buildSnapshotFromGraph(graph, {
      chatId,
      revision: 1,
    }),
  };
}

async function setupIndexedDbTestEnv() {
  try {
    await importWithProjectRootFallback("fake-indexeddb/auto");
  } catch {
    // no-op
  }

  if (!globalThis.Dexie) {
    try {
      const imported = await importWithProjectRootFallback("dexie");
      globalThis.Dexie = imported?.default || imported?.Dexie || imported;
    } catch {
      await import("../../lib/dexie.min.js");
    }
  }

  await ensureDexieLoaded();
}

async function cleanupDatabase(chatId = "") {
  if (!chatId || typeof globalThis.Dexie?.delete !== "function") return;
  try {
    await globalThis.Dexie.delete(buildBmeDbName(chatId));
  } catch {
    // no-op
  }
}

async function prepareIndexedDb(chatId, snapshot) {
  await cleanupDatabase(chatId);
  const db = new BmeDatabase(chatId, { dexieClass: globalThis.Dexie });
  await db.open();
  await db.importSnapshot(snapshot, {
    mode: "replace",
    preserveRevision: true,
    markSyncDirty: false,
  });
  return db;
}

async function prepareOpfsStore(chatId, snapshot) {
  const rootDirectory = createMemoryOpfsRoot();
  const store = new OpfsGraphStore(chatId, {
    rootDirectoryFactory: async () => rootDirectory,
    storeMode: BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY,
  });
  await store.open();
  await store.importSnapshot(snapshot, {
    mode: "replace",
    preserveRevision: true,
    markSyncDirty: false,
  });
  return store;
}

async function readProbeOrFallback(store) {
  let inspectionSnapshot = null;
  let exportProbeMs = 0;
  let exportSnapshotMs = 0;
  let exportSource = "";

  if (typeof store.exportSnapshotProbe === "function") {
    const probeStartedAt = performance.now();
    inspectionSnapshot = await store.exportSnapshotProbe({ includeTombstones: false });
    exportProbeMs = performance.now() - probeStartedAt;
    exportSource = "probe";
  }

  if (!inspectionSnapshot) {
    const exportStartedAt = performance.now();
    inspectionSnapshot = await store.exportSnapshot({ includeTombstones: false });
    exportSnapshotMs = performance.now() - exportStartedAt;
    exportSource = "full-export";
  }

  return {
    inspectionSnapshot,
    exportProbeMs,
    exportSnapshotMs,
    exportSource,
  };
}

async function measureSuccessPreApply(store, chatId) {
  const startedAt = performance.now();
  const probeResult = await readProbeOrFallback(store);
  let snapshot = probeResult.inspectionSnapshot;
  let exportSnapshotMs = probeResult.exportSnapshotMs;
  let exportSource = probeResult.exportSource;

  if (snapshot?.__stBmeProbeOnly === true) {
    const exportStartedAt = performance.now();
    snapshot = await store.exportSnapshot({ includeTombstones: false });
    exportSnapshotMs += performance.now() - exportStartedAt;
    exportSource =
      probeResult.exportSource === "probe" ? "probe+full-export" : "full-export";
  }

  const preApplyMs = performance.now() - startedAt;
  const hydrateStartedAt = performance.now();
  buildGraphFromSnapshot(snapshot, { chatId });
  const hydrateMs = performance.now() - hydrateStartedAt;

  return {
    preApplyMs,
    exportProbeMs: probeResult.exportProbeMs,
    exportSnapshotMs,
    hydrateMs,
    exportSource,
  };
}

async function measureProbeRejectPreApply(store) {
  const startedAt = performance.now();
  const probeResult = await readProbeOrFallback(store);
  return {
    preApplyMs: performance.now() - startedAt,
    exportProbeMs: probeResult.exportProbeMs,
    exportSnapshotMs: probeResult.exportSnapshotMs,
    exportSource: probeResult.exportSource,
  };
}

async function runPreset(preset) {
  const indexedDbSuccessSamples = [];
  const indexedDbProbeRejectSamples = [];
  const indexedDbProbeSamples = [];
  const indexedDbExportSamples = [];
  const indexedDbHydrateSamples = [];
  const opfsSuccessSamples = [];
  const opfsProbeRejectSamples = [];
  const opfsProbeSamples = [];
  const opfsExportSamples = [];
  const opfsHydrateSamples = [];

  for (let run = 0; run < RUNS; run += 1) {
    const { chatId, snapshot } = buildBenchSnapshot({
      ...preset,
      seed: preset.seed + run * 17,
    });

    const indexedDbChatId = `${chatId}-indexeddb`;
    const db = await prepareIndexedDb(indexedDbChatId, snapshot);
    const indexedDbSuccess = await measureSuccessPreApply(db, indexedDbChatId);
    const indexedDbProbeReject = await measureProbeRejectPreApply(db);
    indexedDbSuccessSamples.push(indexedDbSuccess.preApplyMs);
    indexedDbProbeRejectSamples.push(indexedDbProbeReject.preApplyMs);
    indexedDbProbeSamples.push(indexedDbSuccess.exportProbeMs);
    indexedDbExportSamples.push(indexedDbSuccess.exportSnapshotMs);
    indexedDbHydrateSamples.push(indexedDbSuccess.hydrateMs);
    await db.close();
    await cleanupDatabase(indexedDbChatId);

    const opfsChatId = `${chatId}-opfs`;
    const opfsStore = await prepareOpfsStore(opfsChatId, snapshot);
    const opfsSuccess = await measureSuccessPreApply(opfsStore, opfsChatId);
    const opfsProbeReject = await measureProbeRejectPreApply(opfsStore);
    opfsSuccessSamples.push(opfsSuccess.preApplyMs);
    opfsProbeRejectSamples.push(opfsProbeReject.preApplyMs);
    opfsProbeSamples.push(opfsSuccess.exportProbeMs);
    opfsExportSamples.push(opfsSuccess.exportSnapshotMs);
    opfsHydrateSamples.push(opfsSuccess.hydrateMs);
    await opfsStore.close();
  }

  const result = {
    indexedDbPreApplySuccessMs: summarize(indexedDbSuccessSamples),
    indexedDbProbeRejectMs: summarize(indexedDbProbeRejectSamples),
    indexedDbExportProbeMs: summarize(indexedDbProbeSamples),
    indexedDbExportSnapshotMs: summarize(indexedDbExportSamples),
    indexedDbHydrateMs: summarize(indexedDbHydrateSamples),
    opfsPreApplySuccessMs: summarize(opfsSuccessSamples),
    opfsProbeRejectMs: summarize(opfsProbeRejectSamples),
    opfsExportProbeMs: summarize(opfsProbeSamples),
    opfsExportSnapshotMs: summarize(opfsExportSamples),
    opfsHydrateMs: summarize(opfsHydrateSamples),
  };

  if (!outputJson) {
    console.log(`\n[ST-BME][load-preapply-bench] ${preset.label}`);
    console.log(
      formatSummary("indexeddb-preapply-success", indexedDbSuccessSamples),
      `probeRejectP95=${result.indexedDbProbeRejectMs.p95.toFixed(2)}ms`,
      `probeP95=${result.indexedDbExportProbeMs.p95.toFixed(2)}ms`,
      `exportP95=${result.indexedDbExportSnapshotMs.p95.toFixed(2)}ms`,
    );
    console.log(
      formatSummary("opfs-preapply-success", opfsSuccessSamples),
      `probeRejectP95=${result.opfsProbeRejectMs.p95.toFixed(2)}ms`,
      `probeP95=${result.opfsExportProbeMs.p95.toFixed(2)}ms`,
      `exportP95=${result.opfsExportSnapshotMs.p95.toFixed(2)}ms`,
    );
    console.log(
      formatSummary("indexeddb-hydrate", indexedDbHydrateSamples),
      formatSummary("opfs-hydrate", opfsHydrateSamples),
    );
  }

  return result;
}

async function main() {
  await setupIndexedDbTestEnv();
  const results = {};
  for (const preset of SIZE_PRESETS) {
    results[preset.label] = await runPreset(preset);
  }
  if (outputJson) {
    console.log(
      JSON.stringify({
        runs: RUNS,
        presets: results,
      }),
    );
  }
}

await main();
