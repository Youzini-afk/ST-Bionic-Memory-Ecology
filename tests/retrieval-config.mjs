import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadRetrieve(stubs) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const retrieverPath = path.resolve(__dirname, "../retrieval/retriever.js");
  const source = await fs.readFile(retrieverPath, "utf8");
  const transformed = `${source
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replace("export async function retrieve", "async function retrieve")}
this.retrieve = retrieve;
`;

  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {} },
    debugLog() {},
    ...stubs,
  });
  new vm.Script(transformed).runInContext(context);
  return context.retrieve;
}

function createGraph() {
  const nodes = [
    {
      id: "rule-1",
      type: "rule",
      importance: 9,
      createdTime: 1,
      archived: false,
      fields: { title: "规则一" },
      seqRange: [1, 1],
    },
    {
      id: "rule-2",
      type: "rule",
      importance: 7,
      createdTime: 2,
      archived: false,
      fields: { title: "规则二" },
      seqRange: [2, 2],
    },
    {
      id: "rule-3",
      type: "rule",
      importance: 3,
      createdTime: 3,
      archived: false,
      fields: { title: "规则三" },
      seqRange: [3, 3],
    },
  ];
  return { nodes, edges: [] };
}

function createGraphHelpers(graph) {
  return {
    getActiveNodes(target, type = null) {
      const source = target?.nodes || graph.nodes;
      return source.filter(
        (node) => !node.archived && (!type || node.type === type),
      );
    },
    getNode(target, id) {
      return (target?.nodes || graph.nodes).find((node) => node.id === id) || null;
    },
    getNodeEdges(target, nodeId) {
      return (target?.edges || graph.edges).filter(
        (edge) => edge.fromId === nodeId || edge.toId === nodeId,
      );
    },
    buildTemporalAdjacencyMap() {
      return new Map();
    },
  };
}

const schema = [{ id: "rule", label: "规则", alwaysInject: false }];

const state = {
  vectorCalls: [],
  diffusionCalls: [],
  llmCalls: [],
  llmCandidateCount: 0,
  llmResponse: { selected_ids: ["rule-2", "rule-1"] },
  llmOptions: [],
};

const graph = createGraph();
const helpers = createGraphHelpers(graph);
const retrieve = await loadRetrieve({
  ...helpers,
  STORY_TEMPORAL_BUCKETS: {
    CURRENT: "current",
    ADJACENT_PAST: "adjacentPast",
    DISTANT_PAST: "distantPast",
    FLASHBACK: "flashback",
    FUTURE: "future",
    UNDATED: "undated",
  },
  MEMORY_SCOPE_BUCKETS: {
    CHARACTER_POV: "characterPov",
    USER_POV: "userPov",
    OBJECTIVE_CURRENT_REGION: "objectiveCurrentRegion",
    OBJECTIVE_ADJACENT_REGION: "objectiveAdjacentRegion",
    OBJECTIVE_GLOBAL: "objectiveGlobal",
    OTHER_POV: "otherPov",
  },
  normalizeMemoryScope(scope = {}) {
    return {
      layer: scope.layer === "pov" ? "pov" : "objective",
      ownerType: scope.ownerType || "",
      ownerId: scope.ownerId || "",
      ownerName: scope.ownerName || "",
      regionPrimary: scope.regionPrimary || "",
      regionPath: Array.isArray(scope.regionPath) ? scope.regionPath : [],
      regionSecondary: Array.isArray(scope.regionSecondary)
        ? scope.regionSecondary
        : [],
    };
  },
  getScopeRegionKey(scope = {}) {
    return String(scope.regionPrimary || "");
  },
  classifyNodeScopeBucket(node, { activeRegion = "" } = {}) {
    if (node?.scope?.layer === "pov") {
      return node?.scope?.ownerType === "user"
        ? "userPov"
        : "characterPov";
    }
    if (
      activeRegion &&
      String(node?.scope?.regionPrimary || "").trim() === String(activeRegion).trim()
    ) {
      return "objectiveCurrentRegion";
    }
    return "objectiveGlobal";
  },
  resolveScopeBucketWeight(bucket, overrides = {}) {
    return Number(overrides?.[bucket] ?? 1) || 1;
  },
  computeKnowledgeGateForNode(_graph, _node, _ownerKey, options = {}) {
    return {
      visible: true,
      anchored: false,
      rescued: false,
      suppressed: false,
      suppressedReason: "",
      visibilityScore:
        options.scopeBucket === "objectiveCurrentRegion" ? 0.8 : 0.45,
      mode: "soft-visible",
      threshold: 0.4,
    };
  },
  resolveKnowledgeOwner(_graph, input = {}) {
    const ownerType = String(input.ownerType || "").trim();
    const ownerName = String(input.ownerName || input.ownerId || "").trim();
    return {
      ownerType,
      ownerName,
      nodeId: String(input.nodeId || "").trim(),
      aliases: ownerName ? [ownerName] : [],
      ownerKey: ownerType && ownerName ? `${ownerType}:${ownerName}` : "",
    };
  },
  resolveKnowledgeOwnerKeyFromScope(_graph, scope = {}) {
    const ownerType = String(scope.ownerType || "").trim();
    const ownerName = String(scope.ownerName || scope.ownerId || "").trim();
    return ownerType && ownerName ? `${ownerType}:${ownerName}` : "";
  },
  listKnowledgeOwners(targetGraph) {
    return (targetGraph?.nodes || [])
      .filter((node) => node?.type === "character" && !node?.archived)
      .map((node) => ({
        ownerKey: `character:${String(node?.fields?.name || "").trim()}`,
        ownerType: "character",
        ownerName: String(node?.fields?.name || "").trim(),
        nodeId: String(node?.id || "").trim(),
        aliases: [String(node?.fields?.name || "").trim()].filter(Boolean),
        updatedAt: 0,
      }))
      .filter((entry) => entry.ownerKey && entry.ownerName);
  },
  resolveActiveRegionContext(graph, preferredRegion = "") {
    return {
      activeRegion:
        String(preferredRegion || graph?.historyState?.activeRegion || "").trim(),
      source: preferredRegion ? "runtime" : "history",
    };
  },
  resolveAdjacentRegions() {
    return {
      canonicalRegion: "",
      adjacentRegions: [],
    };
  },
  resolveActiveStoryContext(targetGraph, preferred = {}) {
    const preferredLabel = String(preferred?.label || "").trim();
    const preferredSegmentId = String(preferred?.segmentId || "").trim();
    const segments = Array.isArray(targetGraph?.timelineState?.segments)
      ? targetGraph.timelineState.segments
      : [];
    const segment =
      segments.find((item) => item.id === preferredSegmentId) ||
      segments.find((item) => item.label === preferredLabel) ||
      segments.find(
        (item) =>
          item.id === String(targetGraph?.historyState?.activeStorySegmentId || "").trim(),
      ) ||
      null;
    return {
      activeSegmentId: String(
        segment?.id || targetGraph?.historyState?.activeStorySegmentId || "",
      ).trim(),
      activeStoryTimeLabel: String(
        segment?.label || targetGraph?.historyState?.activeStoryTimeLabel || "",
      ).trim(),
      source: segment ? "history" : "",
      segment,
      resolved: Boolean(segment),
    };
  },
  resolveStoryCueMode(userMessage = "", recentMessages = []) {
    const text = [userMessage, ...(Array.isArray(recentMessages) ? recentMessages : [])]
      .map((value) => String(value || ""))
      .join("\n");
    if (/回忆|以前|过去/.test(text)) return "flashback";
    if (/以后|未来|计划|打算/.test(text)) return "future";
    return "";
  },
  describeNodeStoryTime(node = {}) {
    return String(node?.storyTime?.label || node?.storyTimeSpan?.startLabel || "").trim();
  },
  classifyStoryTemporalBucket(_graph, node, { activeSegmentId = "", cueMode = "" } = {}) {
    const label = String(node?.storyTime?.label || node?.storyTimeSpan?.startLabel || "").trim();
    if (!label) {
      return {
        bucket: "undated",
        weight: 0.88,
        suppressed: false,
        rescued: false,
        reason: "undated",
      };
    }
    if (label === activeSegmentId || label === "当前") {
      return {
        bucket: "current",
        weight: 1.15,
        suppressed: false,
        rescued: false,
        reason: "current",
      };
    }
    if (label === "未来计划") {
      return {
        bucket: "future",
        weight: cueMode === "future" ? 0.74 : 0.22,
        suppressed: cueMode !== "future",
        rescued: false,
        reason: cueMode === "future" ? "future-cue" : "future-suppressed",
      };
    }
    if (label === "往事") {
      return {
        bucket: cueMode === "flashback" ? "flashback" : "distantPast",
        weight: cueMode === "flashback" ? 1.02 : 0.64,
        suppressed: false,
        rescued: cueMode === "flashback",
        reason: cueMode === "flashback" ? "flashback-rescued" : "distant-past",
      };
    }
    return {
      bucket: "adjacentPast",
      weight: 1.0,
      suppressed: false,
      rescued: false,
      reason: "adjacent-past",
    };
  },
  pushRecentRecallOwner(historyState, ownerKey = "") {
    historyState.activeRecallOwnerKey = ownerKey;
    historyState.recentRecallOwnerKeys = ownerKey ? [ownerKey] : [];
  },
  describeMemoryScope(scope = {}) {
    return `${scope.layer || "objective"}:${scope.ownerType || ""}:${scope.regionPrimary || ""}`;
  },
  describeScopeBucket(bucket = "") {
    return String(bucket || "");
  },
  buildTaskPrompt() {
    return { systemPrompt: "" };
  },
  applyTaskRegex(_settings, _taskType, _stage, text) {
    return text;
  },
  splitIntentSegments(text) {
    if (String(text).includes("和")) {
      return String(text).split("和").map((item) => item.trim());
    }
    return [];
  },
  mergeVectorResults(groups, limit) {
    const merged = new Map();
    let rawHitCount = 0;
    for (const group of groups) {
      for (const item of group) {
        rawHitCount += 1;
        const existing = merged.get(item.nodeId);
        if (!existing || item.score > existing.score) {
          merged.set(item.nodeId, item);
        }
      }
    }
    return {
      rawHitCount,
      results: [...merged.values()].slice(0, limit),
    };
  },
  collectSupplementalAnchorNodeIds() {
    return [];
  },
  isEligibleAnchorNode(node) {
    return Boolean(node?.fields?.title || node?.fields?.name);
  },
  createCooccurrenceIndex() {
    return { map: new Map(), source: "batchJournal", batchCount: 0, pairCount: 0 };
  },
  applyCooccurrenceBoost(baseScores) {
    return { scores: new Map(baseScores), boostedNodes: [] };
  },
  applyDiversitySampling(candidates, { k }) {
    return {
      applied: true,
      reason: "",
      selected: candidates.slice(0, k).reverse(),
      beforeCount: candidates.length,
      afterCount: Math.min(k, candidates.length),
    };
  },
  async runResidualRecall() {
    return { triggered: false, hits: [], skipReason: "residual-disabled-test" };
  },
  hybridScore: ({
    graphScore = 0,
    vectorScore = 0,
    lexicalScore = 0,
    importance = 0,
  }) => graphScore + vectorScore + lexicalScore + importance,
  reinforceAccessBatch() {},
  validateVectorConfig() {
    return { valid: true };
  },
  async findSimilarNodesByText(_graph, message, _embeddingConfig, topK) {
    state.vectorCalls.push({ topK, message });
    return [
      { nodeId: "rule-1", score: 0.9 },
      { nodeId: "rule-2", score: 0.8 },
      { nodeId: "rule-3", score: 0.7 },
    ];
  },
  diffuseAndRank(_adjacencyMap, seeds, options) {
    state.diffusionCalls.push({ seeds, options });
    return [
      { nodeId: "rule-2", energy: 1.2 },
      { nodeId: "rule-3", energy: 0.9 },
    ];
  },
  async callLLMForJSON(params = {}) {
    const { userPrompt = "" } = params;
    state.llmOptions.push({ ...params });
    state.llmCalls.push(userPrompt);
    state.llmCandidateCount = userPrompt
      .split("\n")
      .filter((line) => line.trim().startsWith("[")).length;
    if (params.returnFailureDetails) {
      if (state.llmResponse?.ok === false) {
        return state.llmResponse;
      }
      return {
        ok: true,
        data: state.llmResponse,
        errorType: "",
        failureReason: "",
        attempts: 1,
      };
    }
    return state.llmResponse;
  },
    getSTContextForPrompt() {
      return {};
  },
});

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
const noStageResult = await retrieve({
  graph,
  userMessage: "只看当前规则",
  recentMessages: [],
  embeddingConfig: {},
  schema,
  options: {
    topK: 2,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
  },
});
assert.equal(state.vectorCalls.length, 0);
assert.equal(state.diffusionCalls.length, 0);
assert.equal(state.llmCalls.length, 0);
assert.deepEqual(Array.from(noStageResult.selectedNodeIds), ["rule-2", "rule-1"]);

state.vectorCalls.length = 0;
await retrieve({
  graph,
  userMessage: "他后来怎么做？",
  recentMessages: [
    "[assistant]: 他提到了规则二的限制",
    "[user]: 我们先看规则一",
    "[user]: 他后来怎么做？",
  ],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableMultiIntent: false,
    enableContextQueryBlend: true,
  },
});
assert.deepEqual(
  state.vectorCalls.map((item) => item.message),
  ["他后来怎么做？", "他提到了规则二的限制", "我们先看规则一"],
);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmCandidateCount = 0;
state.llmResponse = { selected_ids: ["rule-2", "rule-1"] };
const llmPoolResult = await retrieve({
  graph,
  userMessage: "请根据规则给出结论",
  recentMessages: ["用户：现在该怎么做？"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.deepEqual(state.vectorCalls, [
  { topK: 4, message: "请根据规则给出结论" },
  { topK: 4, message: "现在该怎么做？" },
]);
assert.equal(state.diffusionCalls.length, 0);
assert.equal(state.llmCandidateCount, 2);
assert.deepEqual(Array.from(llmPoolResult.selectedNodeIds), ["rule-2", "rule-1"]);
assert.equal(llmPoolResult.meta.retrieval.llm.status, "llm");
assert.equal(llmPoolResult.meta.retrieval.llm.candidatePool, 2);
assert.equal(llmPoolResult.meta.retrieval.vectorMergedHits, 3);
assert.equal(llmPoolResult.meta.retrieval.diversityApplied, true);
assert.equal(llmPoolResult.meta.retrieval.candidatePoolBeforeDpp, 3);
assert.equal(llmPoolResult.meta.retrieval.candidatePoolAfterDpp, 2);
assert.equal(state.llmOptions[0].returnFailureDetails, true);
assert.equal(state.llmOptions[0].maxRetries, 2);
assert.equal(state.llmOptions[0].maxCompletionTokens, 512);

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
await retrieve({
  graph,
  userMessage: "规则一和规则二有什么关联",
  recentMessages: [],
  embeddingConfig: {},
  schema,
  options: {
    topK: 3,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: true,
    diffusionTopK: 7,
    enableLLMRecall: false,
    enableMultiIntent: true,
    multiIntentMaxSegments: 4,
    enableTemporalLinks: true,
    temporalLinkStrength: 0.2,
    teleportAlpha: 0.15,
  },
});
assert.equal(state.vectorCalls.length, 3);
assert.deepEqual(
  state.vectorCalls.map((item) => item.topK),
  [3, 3, 3],
);
assert.equal(state.diffusionCalls.length, 1);
assert.equal(state.diffusionCalls[0].options.topK, 7);
assert.equal(state.diffusionCalls[0].options.teleportAlpha, 0.15);
assert.equal(noStageResult.meta.retrieval.llm.status, "disabled");

state.vectorCalls.length = 0;
state.diffusionCalls.length = 0;
state.llmCalls.length = 0;
state.llmOptions.length = 0;
state.llmResponse = {
  ok: false,
  errorType: "invalid-json",
  failureReason: "输出不是有效 JSON，请严格返回紧凑 JSON 对象",
};
const fallbackResult = await retrieve({
  graph,
  userMessage: "LLM 这次会坏掉",
  recentMessages: ["用户：请回忆相关规则"],
  embeddingConfig: {},
  schema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: true,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 2,
  },
});
assert.equal(fallbackResult.meta.retrieval.llm.status, "fallback");
assert.match(fallbackResult.meta.retrieval.llm.reason, /有效 JSON|回退到评分排序/);
assert.equal(fallbackResult.meta.retrieval.llm.fallbackType, "invalid-json");

const sceneGraph = {
  nodes: [
    {
      id: "event-1",
      type: "event",
      importance: 10,
      createdTime: 1,
      archived: false,
      fields: { title: "事件一" },
      seqRange: [1, 1],
    },
    {
      id: "character-1",
      type: "character",
      importance: 6,
      createdTime: 2,
      archived: false,
      fields: { name: "Alice" },
      seqRange: [1, 1],
    },
    {
      id: "location-1",
      type: "location",
      importance: 5,
      createdTime: 3,
      archived: false,
      fields: { title: "大厅" },
      seqRange: [1, 1],
    },
  ],
  edges: [
    { fromId: "event-1", toId: "character-1", relation: "mentions" },
    { fromId: "event-1", toId: "location-1", relation: "occurs_at" },
  ],
};
const sceneSchema = [
  { id: "event", label: "事件", alwaysInject: false },
  { id: "character", label: "角色", alwaysInject: false },
  { id: "location", label: "地点", alwaysInject: false },
];
const cappedResult = await retrieve({
  graph: sceneGraph,
  userMessage: "只看这一个场景",
  recentMessages: [],
  embeddingConfig: {},
  schema: sceneSchema,
  options: {
    topK: 3,
    maxRecallNodes: 1,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableProbRecall: false,
  },
});
assert.equal(cappedResult.selectedNodeIds.length, 1);

const lexicalGraph = {
  nodes: [
    {
      id: "char-1",
      type: "character",
      importance: 1,
      createdTime: 1,
      archived: false,
      fields: { name: "Alice", summary: "常驻角色" },
      seqRange: [1, 1],
    },
    {
      id: "char-2",
      type: "character",
      importance: 1,
      createdTime: 1,
      archived: false,
      fields: { name: "Bob", summary: "常驻角色" },
      seqRange: [1, 1],
    },
  ],
  edges: [],
};
const lexicalSchema = [{ id: "character", label: "角色", alwaysInject: false }];
const lexicalResult = await retrieve({
  graph: lexicalGraph,
  userMessage: "Alice 现在怎么样了",
  recentMessages: [],
  embeddingConfig: {},
  schema: lexicalSchema,
  options: {
    topK: 2,
    maxRecallNodes: 1,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableDiversitySampling: false,
    enableLexicalBoost: true,
  },
});
assert.deepEqual(Array.from(lexicalResult.selectedNodeIds), ["char-1"]);
assert.equal(lexicalResult.meta.retrieval.queryBlendActive, false);
assert.equal(lexicalResult.meta.retrieval.lexicalBoostedNodes, 1);
assert.equal(lexicalResult.meta.retrieval.lexicalTopHits[0]?.nodeId, "char-1");

const scopedGraph = {
  nodes: [
    {
      id: "obj-global",
      type: "event",
      importance: 8,
      createdTime: 1,
      archived: false,
      fields: { title: "旧王都事件" },
      seqRange: [1, 1],
      scope: { layer: "objective", regionPrimary: "旧城区" },
    },
    {
      id: "char-pov",
      type: "pov_memory",
      importance: 4,
      createdTime: 2,
      archived: false,
      fields: { summary: "艾琳觉得钟楼入口非常可疑" },
      seqRange: [2, 2],
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "艾琳",
        ownerName: "艾琳",
        regionPrimary: "钟楼",
      },
    },
  ],
  edges: [],
  historyState: {
    activeRegion: "钟楼",
    activeCharacterPovOwner: "艾琳",
    activeUserPovOwner: "玩家",
  },
};
const scopedSchema = [
  { id: "event", label: "事件", alwaysInject: true },
  { id: "pov_memory", label: "主观记忆", alwaysInject: false },
];
const scopedResult = await retrieve({
  graph: scopedGraph,
  userMessage: "钟楼里到底有什么",
  recentMessages: [],
  embeddingConfig: {},
  schema: scopedSchema,
  options: {
    topK: 2,
    maxRecallNodes: 1,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableDiversitySampling: false,
    enableScopedMemory: true,
    activeRegion: "钟楼",
    activeCharacterPovOwner: "艾琳",
  },
});
assert.deepEqual(Array.from(scopedResult.selectedNodeIds), ["char-pov"]);
assert.equal(scopedResult.meta.retrieval.activeRegion, "钟楼");
assert.ok(Array.isArray(scopedResult.scopeBuckets.characterPov));
assert.equal(scopedResult.scopeBuckets.characterPov[0]?.id, "char-pov");

const multiOwnerGraph = {
  nodes: [
    {
      id: "char-node-a",
      type: "character",
      importance: 6,
      createdTime: 1,
      archived: false,
      fields: { name: "艾琳" },
      seqRange: [1, 1],
    },
    {
      id: "char-node-b",
      type: "character",
      importance: 6,
      createdTime: 1,
      archived: false,
      fields: { name: "露西亚" },
      seqRange: [1, 1],
    },
    {
      id: "pov-a",
      type: "pov_memory",
      importance: 8,
      createdTime: 2,
      archived: false,
      fields: { summary: "艾琳觉得钟楼里还有第二条暗道" },
      seqRange: [2, 2],
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "艾琳",
        ownerName: "艾琳",
      },
    },
    {
      id: "pov-b",
      type: "pov_memory",
      importance: 7,
      createdTime: 3,
      archived: false,
      fields: { summary: "露西亚认为钟楼守卫在故意拖时间" },
      seqRange: [3, 3],
      scope: {
        layer: "pov",
        ownerType: "character",
        ownerId: "露西亚",
        ownerName: "露西亚",
      },
    },
  ],
  edges: [],
  historyState: {
    activeRegion: "",
    activeCharacterPovOwner: "",
    activeUserPovOwner: "玩家",
  },
};
const multiOwnerSchema = [
  { id: "character", label: "角色", alwaysInject: false },
  { id: "pov_memory", label: "主观记忆", alwaysInject: false },
];
state.llmResponse = {
  selected_ids: ["pov-a", "pov-b"],
  active_owner_keys: ["character:艾琳", "character:露西亚"],
  active_owner_scores: [
    { ownerKey: "character:艾琳", score: 0.91, reason: "她的 POV 直接命中当前追问" },
    { ownerKey: "character:露西亚", score: 0.83, reason: "她也在同一场景并提供互补判断" },
  ],
};
const multiOwnerResult = await retrieve({
  graph: multiOwnerGraph,
  userMessage: "艾琳和露西亚现在各自怎么看钟楼这件事",
  recentMessages: ["[assistant]: 她们刚刚一起进入钟楼大厅"],
  embeddingConfig: {},
  schema: multiOwnerSchema,
  options: {
    topK: 4,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: true,
    llmCandidatePool: 4,
  },
});
assert.deepEqual(
  Array.from(multiOwnerResult.meta.retrieval.activeRecallOwnerKeys),
  ["character:艾琳", "character:露西亚"],
);
assert.equal(multiOwnerResult.meta.retrieval.sceneOwnerResolutionMode, "llm");
assert.deepEqual(
  Array.from(multiOwnerResult.scopeBuckets.characterPovOwnerOrder),
  ["character:艾琳", "character:露西亚"],
);
assert.equal(
  multiOwnerResult.scopeBuckets.characterPovByOwner["character:艾琳"]?.[0]?.id,
  "pov-a",
);
assert.equal(
  multiOwnerResult.scopeBuckets.characterPovByOwner["character:露西亚"]?.[0]?.id,
  "pov-b",
);
assert.equal(
  multiOwnerResult.meta.retrieval.selectedByOwner["character:艾琳"]?.[0],
  "pov-a",
);

const temporalGraph = {
  nodes: [
    {
      id: "evt-current",
      type: "event",
      importance: 5,
      createdTime: 1,
      archived: false,
      fields: { title: "当前调查" },
      seqRange: [10, 10],
      storyTime: { label: "当前" },
    },
    {
      id: "evt-past",
      type: "event",
      importance: 6,
      createdTime: 2,
      archived: false,
      fields: { title: "旧冲突" },
      seqRange: [8, 8],
      storyTime: { label: "往事" },
    },
    {
      id: "evt-future",
      type: "event",
      importance: 10,
      createdTime: 3,
      archived: false,
      fields: { title: "未来计划" },
      seqRange: [12, 12],
      storyTime: { label: "未来计划", tense: "future" },
    },
  ],
  edges: [],
  historyState: {
    activeStorySegmentId: "当前",
    activeStoryTimeLabel: "当前",
    activeStoryTimeSource: "test",
  },
  timelineState: {
    segments: [
      { id: "当前", label: "当前", order: 2 },
      { id: "往事", label: "往事", order: 1 },
      { id: "未来计划", label: "未来计划", order: 3 },
    ],
  },
};
const temporalSchema = [{ id: "event", label: "事件", alwaysInject: false }];
const temporalResult = await retrieve({
  graph: temporalGraph,
  userMessage: "现在现场怎么样",
  recentMessages: [],
  embeddingConfig: {},
  schema: temporalSchema,
  options: {
    topK: 3,
    maxRecallNodes: 2,
    enableVectorPrefilter: false,
    enableGraphDiffusion: false,
    enableLLMRecall: false,
    enableDiversitySampling: false,
    enableStoryTimeline: true,
    storyTimeSoftDirecting: true,
    activeStorySegmentId: "当前",
    activeStoryTimeLabel: "当前",
  },
});
assert.equal(temporalResult.meta.retrieval.activeStorySegmentId, "当前");
assert.equal(temporalResult.meta.retrieval.activeStoryTimeLabel, "当前");
assert.ok(Array.isArray(temporalResult.meta.retrieval.temporalSuppressedNodes));
assert.ok(
  Array.isArray(temporalResult.meta.retrieval.temporalBuckets?.future) ||
    Array.isArray(temporalResult.meta.retrieval.temporalBuckets?.["future"]),
);
assert.ok(
  !Array.from(temporalResult.selectedNodeIds).includes("evt-future"),
);
assert.equal(
  temporalResult.meta.retrieval.temporalTopHits[0]?.nodeId,
  "evt-current",
);

console.log("retrieval-config tests passed");
