import { performance } from "node:perf_hooks";

import {
  installResolveHooks,
  toDataModuleUrl,
} from "../helpers/register-hooks-compat.mjs";

installResolveHooks([
  {
    specifiers: ["../../../../../script.js"],
    url: toDataModuleUrl("export function getRequestHeaders() { return {}; }"),
  },
  {
    specifiers: ["../../../../extensions.js"],
    url: toDataModuleUrl("export const extension_settings = { st_bme: {} };") ,
  },
]);

globalThis.__stBmeTestOverrides = {
  embedding: {
    async embedText(text = "") {
      return [1, 0.25, String(text || "").length / 100];
    },
  },
};

const outputJson = process.argv.includes("--json");
const RUNS = 5;
const SIZE_PRESETS = [
  { label: "M", totalNodes: 1200 },
  { label: "L", totalNodes: 3600 },
  { label: "XL", totalNodes: 7200 },
];

const { normalizeAuthorityVectorConfig } = await import(
  "../../vector/authority-vector-primary-adapter.js"
);
const { resolveAuthorityRecallCandidates } = await import(
  "../../retrieval/authority-candidate-provider.js"
);

function summarize(values = []) {
  if (!values.length) {
    return { avg: 0, p95: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    avg: sum / sorted.length,
    p95: sorted[p95Index],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function formatSummary(label, summary = {}) {
  return `${label} avg=${Number(summary.avg || 0).toFixed(2)}ms p95=${Number(summary.p95 || 0).toFixed(2)}ms min=${Number(summary.min || 0).toFixed(2)}ms max=${Number(summary.max || 0).toFixed(2)}ms`;
}

function formatPercent(value = 0) {
  return `${(Math.max(0, Number(value) || 0) * 100).toFixed(1)}%`;
}

function buildNode(id, {
  title = "",
  summary = "",
  regionKey = "archive",
  storySegmentId = "seg-archive",
  ownerId = "",
  ownerName = "",
  type = "event",
  seq = 0,
} = {}) {
  return {
    id,
    type,
    archived: false,
    seq,
    importance: ownerId ? 8 : 4,
    fields: {
      title,
      summary,
    },
    scope: {
      layer: ownerId ? "pov" : "objective",
      ownerType: ownerId ? "character" : "",
      ownerId,
      ownerName,
      bucket: ownerId ? "characterPov" : "objectiveGlobal",
      regionKey,
    },
    storySegmentId,
  };
}

function createSyntheticRecallScenario({ label, totalNodes }) {
  const chatId = `bench-authority-recall-${label.toLowerCase()}`;
  const collectionId = `st-bme:${chatId}:nodes`;
  const relevantNodes = [
    buildNode("node-alice-memory", {
      title: "Alice remembers the silver key",
      summary: "Alice knows the silver key is hidden behind the archive ledger.",
      ownerId: "Alice",
      ownerName: "Alice",
      type: "pov_memory",
      seq: 11,
    }),
    buildNode("node-archive-gate", {
      title: "Archive gate opened",
      summary: "The archive gate has just been unlocked.",
      seq: 10,
    }),
    buildNode("node-vault", {
      title: "Vault mechanism",
      summary: "The hidden vault opens only after the archive gate is cleared.",
      seq: 12,
    }),
    buildNode("node-ledger", {
      title: "Ledger note",
      summary: "The ledger mentions a silver key and a hidden switch.",
      seq: 13,
    }),
    buildNode("node-guard", {
      title: "Archive guard patrol",
      summary: "A guard patrol circles the archive stairs every few minutes.",
      seq: 14,
    }),
    buildNode("node-context", {
      title: "Archive dust trail",
      summary: "Fresh dust suggests someone visited the archive recently.",
      seq: 15,
    }),
  ];
  const fillerNodes = [];
  for (let index = 0; index < Math.max(0, totalNodes - relevantNodes.length); index += 1) {
    const inArchive = index % 9 === 0;
    fillerNodes.push(
      buildNode(`node-filler-${index}`, {
        title: `Filler ${index}`,
        summary: `Background recall filler ${index}`,
        regionKey: inArchive ? "archive" : index % 2 === 0 ? "market" : "harbor",
        storySegmentId: inArchive ? "seg-archive" : index % 2 === 0 ? "seg-market" : "seg-harbor",
        seq: 100 + index,
      }),
    );
  }
  const nodes = [...relevantNodes, ...fillerNodes];
  const graph = {
    version: 1,
    nodes,
    edges: [],
    historyState: {
      chatId,
    },
    vectorIndexState: {
      collectionId,
      dirty: false,
    },
  };
  return {
    chatId,
    collectionId,
    graph,
    availableNodes: nodes,
    relevantIds: relevantNodes.map((node) => node.id),
    filterIds: [
      "node-alice-memory",
      "node-archive-gate",
      "node-vault",
      "node-ledger",
      "node-context",
      "node-filler-0",
      "node-filler-9",
    ],
    searchResults: [
      { nodeId: "node-alice-memory", score: 0.99 },
      { nodeId: "node-vault", score: 0.93 },
      { nodeId: "node-ledger", score: 0.9 },
      { nodeId: "node-context", score: 0.84 },
      { nodeId: "node-outside", score: 0.8 },
    ],
    neighbors: [
      { fromId: "node-alice-memory", toId: "node-vault" },
      { fromId: "node-vault", toId: "node-ledger" },
      { fromId: "node-ledger", toId: "node-context" },
      { fromId: "node-vault", toId: "node-archive-gate" },
    ],
  };
}

function createBenchTriviumClient(scenario) {
  return {
    async filterWhere() {
      return {
        items: scenario.filterIds.map((nodeId) => ({ externalId: nodeId })),
      };
    },
    async search() {
      return {
        results: scenario.searchResults,
      };
    },
    async neighbors() {
      return {
        neighbors: scenario.neighbors,
      };
    },
  };
}

function computeCoverage(candidateNodes = [], relevantIds = []) {
  const candidateSet = new Set(
    (Array.isArray(candidateNodes) ? candidateNodes : [])
      .map((node) => String(node?.id || "").trim())
      .filter(Boolean),
  );
  const normalizedRelevantIds = (Array.isArray(relevantIds) ? relevantIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!normalizedRelevantIds.length) {
    return 0;
  }
  const hits = normalizedRelevantIds.filter((value) => candidateSet.has(value)).length;
  return hits / normalizedRelevantIds.length;
}

async function runPreset(preset) {
  const scenario = createSyntheticRecallScenario(preset);
  const totalTimings = [];
  const filterTimings = [];
  const searchTimings = [];
  const neighborTimings = [];
  const coverages = [];
  const reductionRatios = [];
  const candidateCounts = [];
  let usedCount = 0;

  for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
    const triviumClient = createBenchTriviumClient(scenario);
    const config = normalizeAuthorityVectorConfig(
      {
        authorityBaseUrl: "/api/plugins/authority",
        authorityEmbeddingApiUrl: "https://example.com/v1",
        authorityEmbeddingModel: "test-embedding",
        authorityVectorFailOpen: true,
      },
      { triviumClient },
    );
    const startedAt = performance.now();
    const result = await resolveAuthorityRecallCandidates({
      graph: scenario.graph,
      userMessage: "Alice 现在在 archive 里找 silver key 和 hidden vault 吗？",
      recentMessages: [
        "assistant: Alice just unlocked the archive gate.",
        "assistant: The ledger may mention a hidden switch.",
      ],
      embeddingConfig: config,
      availableNodes: scenario.availableNodes,
      activeRegion: "archive",
      activeStoryContext: {
        activeSegmentId: "seg-archive",
      },
      activeRecallOwnerKeys: ["character:Alice"],
      sceneOwnerCandidates: [
        {
          ownerKey: "character:Alice",
          ownerName: "Alice",
        },
      ],
      options: {
        enabled: true,
        topK: 8,
        maxRecallNodes: 6,
        limit: 24,
        neighborLimit: 6,
        minimumUsedCandidateCount: 4,
        enableMultiIntent: true,
      },
    });
    totalTimings.push(performance.now() - startedAt);
    filterTimings.push(Number(result?.diagnostics?.timings?.filter || 0));
    searchTimings.push(Number(result?.diagnostics?.timings?.search || 0));
    neighborTimings.push(Number(result?.diagnostics?.timings?.neighbors || 0));
    coverages.push(computeCoverage(result?.candidateNodes, scenario.relevantIds));
    reductionRatios.push(
      scenario.availableNodes.length > 0
        ? Number((result?.candidateNodes?.length || 0) / scenario.availableNodes.length)
        : 0,
    );
    candidateCounts.push(Number(result?.candidateNodes?.length || 0));
    if (result?.used) {
      usedCount += 1;
    }
  }

  return {
    label: preset.label,
    totalNodes: scenario.availableNodes.length,
    relevantNodeCount: scenario.relevantIds.length,
    candidateCount: summarize(candidateCounts),
    timings: {
      total: summarize(totalTimings),
      filter: summarize(filterTimings),
      search: summarize(searchTimings),
      neighbors: summarize(neighborTimings),
    },
    quality: {
      coverage: summarize(coverages),
      reductionRatio: summarize(reductionRatios),
      usedRate: usedCount / RUNS,
    },
  };
}

const results = [];
for (const preset of SIZE_PRESETS) {
  results.push(await runPreset(preset));
}

if (outputJson) {
  console.log(JSON.stringify({
    kind: "st-bme-authority-recall-bench",
    runs: RUNS,
    results,
  }, null, 2));
} else {
  console.log(`Authority recall candidate bench (synthetic) · runs=${RUNS}`);
  for (const result of results) {
    console.log(`\n[${result.label}] nodes=${result.totalNodes} relevant=${result.relevantNodeCount}`);
    console.log(formatSummary("total", result.timings.total));
    console.log(formatSummary("filter", result.timings.filter));
    console.log(formatSummary("search", result.timings.search));
    console.log(formatSummary("neighbors", result.timings.neighbors));
    console.log(
      `coverage avg=${formatPercent(result.quality.coverage.avg)} reduction avg=${formatPercent(result.quality.reductionRatio.avg)} usedRate=${formatPercent(result.quality.usedRate)} candidate avg=${Number(result.candidateCount.avg || 0).toFixed(1)}`,
    );
  }
}
