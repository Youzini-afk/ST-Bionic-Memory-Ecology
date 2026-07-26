import {
  normalizeEdgeMemoryScope,
  normalizeNodeMemoryScope,
} from "../graph/memory-scope.js";
import {
  createDefaultKnowledgeState,
  createDefaultRegionState,
  normalizeGraphCognitiveState,
} from "../graph/knowledge-state.js";
import {
  createDefaultTimelineState,
  normalizeGraphStoryTimeline,
} from "../graph/story-timeline.js";
import {
  createDefaultSummaryState,
  normalizeGraphSummaryState,
} from "../graph/summary-state.js";

const BATCH_JOURNAL_LIMIT = 96;
const MAINTENANCE_JOURNAL_LIMIT = 20;
export const PROCESSED_MESSAGE_HASH_VERSION = 3;

export function buildVectorCollectionId(chatId) {
  return `st-bme-v9::${chatId || "unknown-chat"}`;
}

export function createDefaultHistoryState(chatId = "") {
  return {
    chatId: String(chatId || ""),
    lastProcessedAssistantFloor: -1,
    extractionCount: 0,
    lastExtractedRegion: "",
    activeRegion: "",
    activeRegionSource: "",
    activeStorySegmentId: "",
    activeStoryTimeLabel: "",
    activeStoryTimeSource: "",
    lastExtractedStorySegmentId: "",
    activeCharacterPovOwner: "",
    activeUserPovOwner: "",
    activeRecallOwnerKey: "",
    recentRecallOwnerKeys: [],
  };
}

export function createDefaultVectorIndexState(chatId = "") {
  return {
    mode: "direct",
    collectionId: buildVectorCollectionId(chatId),
    source: "",
    modelScope: "",
    hashToNodeId: {},
    nodeToHash: {},
    dirty: false,
    replayRequiredNodeIds: [],
    dirtyReason: "",
    pendingRepairFromFloor: null,
    lastSyncAt: 0,
    lastStats: { total: 0, indexed: 0, stale: 0, pending: 0 },
    currentVectorSpace: null,
    manifest: null,
    lastWarning: "",
    lastIntegrityIssue: null,
  };
}

export function createDefaultBatchJournal() {
  return [];
}

export function createDefaultMaintenanceJournal() {
  return [];
}

function plainObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function finiteInteger(value, fallback, minimum = Number.MIN_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.trunc(number)) : fallback;
}

function uniqueStrings(value, limit = Number.MAX_SAFE_INTEGER) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean))].slice(0, limit);
}

function normalizeHistoryState(value, chatId, lastProcessedSeq) {
  const history = {
    ...createDefaultHistoryState(chatId),
    ...plainObject(value),
  };
  history.chatId = String(chatId || history.chatId || "");
  history.lastProcessedAssistantFloor = finiteInteger(
    history.lastProcessedAssistantFloor,
    finiteInteger(lastProcessedSeq, -1),
    -1,
  );
  history.extractionCount = finiteInteger(history.extractionCount, 0, 0);
  for (const key of [
    "lastExtractedRegion",
    "activeRegion",
    "activeRegionSource",
    "activeStorySegmentId",
    "activeStoryTimeLabel",
    "activeStoryTimeSource",
    "lastExtractedStorySegmentId",
    "activeCharacterPovOwner",
    "activeUserPovOwner",
    "activeRecallOwnerKey",
  ]) history[key] = String(history[key] || "");
  history.recentRecallOwnerKeys = uniqueStrings(history.recentRecallOwnerKeys, 8);
  return history;
}

function normalizeVectorIndexState(value, chatId) {
  const defaults = createDefaultVectorIndexState(chatId);
  const state = { ...defaults, ...plainObject(value) };
  state.hashToNodeId = { ...plainObject(state.hashToNodeId) };
  state.nodeToHash = { ...plainObject(state.nodeToHash) };
  state.lastStats = { ...defaults.lastStats, ...plainObject(state.lastStats) };
  state.replayRequiredNodeIds = uniqueStrings(state.replayRequiredNodeIds);
  state.pendingRepairFromFloor = Number.isFinite(Number(state.pendingRepairFromFloor))
    ? Math.max(0, Math.trunc(Number(state.pendingRepairFromFloor)))
    : null;
  for (const key of ["mode", "source", "modelScope", "dirtyReason", "lastWarning"]) {
    state[key] = String(state[key] || "");
  }
  for (const key of ["currentVectorSpace", "manifest", "lastIntegrityIssue"]) {
    state[key] = state[key] === null ? null : plainObject(state[key], null);
  }
  const collectionId = buildVectorCollectionId(chatId);
  if (state.collectionId && state.collectionId !== collectionId) {
    state.hashToNodeId = {};
    state.nodeToHash = {};
    state.replayRequiredNodeIds = [];
    state.currentVectorSpace = null;
    state.manifest = null;
    state.dirty = true;
    state.dirtyReason = "chat-id-changed";
    state.lastWarning = "chat namespace changed; vector rebuild required";
  }
  state.collectionId = collectionId;
  return state;
}

export function normalizeGraphRuntimeState(graph, chatId = "") {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new TypeError("graph must be an object");
  }
  graph.nodes = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .filter((node) => node && typeof node === "object");
  graph.edges = (Array.isArray(graph.edges) ? graph.edges : [])
    .filter((edge) => edge && typeof edge === "object");
  graph.historyState = normalizeHistoryState(
    graph.historyState,
    chatId,
    graph.lastProcessedSeq,
  );
  graph.vectorIndexState = normalizeVectorIndexState(
    graph.vectorIndexState,
    graph.historyState.chatId,
  );
  for (const node of graph.nodes) normalizeNodeMemoryScope(node);
  for (const edge of graph.edges) normalizeEdgeMemoryScope(edge);
  graph.batchJournal = (Array.isArray(graph.batchJournal) ? graph.batchJournal : [])
    .filter((entry) => entry && typeof entry === "object")
    .slice(-BATCH_JOURNAL_LIMIT);
  graph.maintenanceJournal = (Array.isArray(graph.maintenanceJournal)
    ? graph.maintenanceJournal
    : [])
    .filter((entry) => entry && typeof entry === "object")
    .slice(-MAINTENANCE_JOURNAL_LIMIT);
  graph.knowledgeState = createDefaultKnowledgeState(graph.knowledgeState);
  graph.regionState = createDefaultRegionState(graph.regionState);
  graph.timelineState = createDefaultTimelineState(graph.timelineState);
  graph.summaryState = createDefaultSummaryState(graph.summaryState);
  normalizeGraphCognitiveState(graph);
  normalizeGraphStoryTimeline(graph);
  normalizeGraphSummaryState(graph);
  graph.lastProcessedSeq = graph.historyState.lastProcessedAssistantFloor;
  return graph;
}

// v9 persistence diffs normalized records directly; graph CRUD no longer tracks a second dirty journal.
export function stableHashString(text) {
  let hash = 2166136261;
  for (const char of String(text || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
