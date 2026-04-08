// ST-BME: 运行时状态与历史恢复辅助
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

const BATCH_JOURNAL_LIMIT = 96;
const MAINTENANCE_JOURNAL_LIMIT = 20;
export const BATCH_JOURNAL_VERSION = 2;
export const PROCESSED_MESSAGE_HASH_VERSION = 2;

export function buildVectorCollectionId(chatId) {
  return `st-bme::${chatId || "unknown-chat"}`;
}

export function createDefaultHistoryState(chatId = "") {
  return {
    chatId,
    lastProcessedAssistantFloor: -1,
    processedMessageHashVersion: PROCESSED_MESSAGE_HASH_VERSION,
    processedMessageHashes: {},
    processedMessageHashesNeedRefresh: false,
    historyDirtyFrom: null,
    lastMutationReason: "",
    lastMutationSource: "",
    extractionCount: 0,
    lastRecoveryResult: null,
    lastBatchStatus: null,
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
    mode: "backend",
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
    lastStats: {
      total: 0,
      indexed: 0,
      stale: 0,
      pending: 0,
    },
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

export function normalizeGraphRuntimeState(graph, chatId = "") {
  if (!graph || typeof graph !== "object") {
    return graph;
  }

  const historyState = {
    ...createDefaultHistoryState(chatId),
    ...(graph.historyState || {}),
  };
  const vectorIndexState = {
    ...createDefaultVectorIndexState(chatId),
    ...(graph.vectorIndexState || {}),
  };

  historyState.chatId = chatId || historyState.chatId || "";
  if (!Number.isFinite(historyState.lastProcessedAssistantFloor)) {
    historyState.lastProcessedAssistantFloor = Number.isFinite(
      graph.lastProcessedSeq,
    )
      ? graph.lastProcessedSeq
      : -1;
  }
  if (!Number.isFinite(historyState.extractionCount)) {
    historyState.extractionCount = 0;
  }
  if (typeof historyState.lastMutationSource !== "string") {
    historyState.lastMutationSource = "";
  }
  if (
    !historyState.lastBatchStatus ||
    typeof historyState.lastBatchStatus !== "object" ||
    Array.isArray(historyState.lastBatchStatus)
  ) {
    historyState.lastBatchStatus = null;
  } else if (
    typeof historyState.lastBatchStatus.historyAdvanced !== "boolean"
  ) {
    historyState.lastBatchStatus = {
      ...historyState.lastBatchStatus,
      historyAdvanced: false,
    };
  }
  if (typeof historyState.lastExtractedRegion !== "string") {
    historyState.lastExtractedRegion = "";
  }
  if (typeof historyState.activeRegion !== "string") {
    historyState.activeRegion = historyState.lastExtractedRegion || "";
  }
  if (typeof historyState.activeRegionSource !== "string") {
    historyState.activeRegionSource = historyState.activeRegion ? "history" : "";
  }
  if (typeof historyState.activeStorySegmentId !== "string") {
    historyState.activeStorySegmentId = "";
  }
  if (typeof historyState.activeStoryTimeLabel !== "string") {
    historyState.activeStoryTimeLabel = "";
  }
  if (typeof historyState.activeStoryTimeSource !== "string") {
    historyState.activeStoryTimeSource =
      historyState.activeStorySegmentId || historyState.activeStoryTimeLabel
        ? "history"
        : "";
  }
  if (typeof historyState.lastExtractedStorySegmentId !== "string") {
    historyState.lastExtractedStorySegmentId = "";
  }
  if (typeof historyState.activeCharacterPovOwner !== "string") {
    historyState.activeCharacterPovOwner = "";
  }
  if (typeof historyState.activeUserPovOwner !== "string") {
    historyState.activeUserPovOwner = "";
  }
  if (typeof historyState.activeRecallOwnerKey !== "string") {
    historyState.activeRecallOwnerKey = "";
  }
  if (!Array.isArray(historyState.recentRecallOwnerKeys)) {
    historyState.recentRecallOwnerKeys = [];
  } else {
    historyState.recentRecallOwnerKeys = [
      ...new Set(
        historyState.recentRecallOwnerKeys
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    ].slice(0, 8);
  }

  if (
    !historyState.processedMessageHashes ||
    typeof historyState.processedMessageHashes !== "object" ||
    Array.isArray(historyState.processedMessageHashes)
  ) {
    historyState.processedMessageHashes = {};
  }
  if (!Number.isFinite(historyState.processedMessageHashVersion)) {
    historyState.processedMessageHashVersion = 1;
  }
  historyState.processedMessageHashVersion = Math.max(
    1,
    Math.floor(historyState.processedMessageHashVersion),
  );
  historyState.processedMessageHashesNeedRefresh =
    historyState.processedMessageHashesNeedRefresh === true;
  if (
    historyState.processedMessageHashVersion !== PROCESSED_MESSAGE_HASH_VERSION
  ) {
    historyState.processedMessageHashes = {};
    historyState.processedMessageHashVersion = PROCESSED_MESSAGE_HASH_VERSION;
    historyState.processedMessageHashesNeedRefresh = true;
  }

  if (
    !vectorIndexState.hashToNodeId ||
    typeof vectorIndexState.hashToNodeId !== "object" ||
    Array.isArray(vectorIndexState.hashToNodeId)
  ) {
    vectorIndexState.hashToNodeId = {};
  }
  if (
    !vectorIndexState.nodeToHash ||
    typeof vectorIndexState.nodeToHash !== "object" ||
    Array.isArray(vectorIndexState.nodeToHash)
  ) {
    vectorIndexState.nodeToHash = {};
  }
  if (
    !vectorIndexState.lastStats ||
    typeof vectorIndexState.lastStats !== "object"
  ) {
    vectorIndexState.lastStats =
      createDefaultVectorIndexState(chatId).lastStats;
  }
  if (!Array.isArray(vectorIndexState.replayRequiredNodeIds)) {
    vectorIndexState.replayRequiredNodeIds = [];
  } else {
    vectorIndexState.replayRequiredNodeIds = [
      ...new Set(vectorIndexState.replayRequiredNodeIds.filter(Boolean)),
    ];
  }
  if (typeof vectorIndexState.dirtyReason !== "string") {
    vectorIndexState.dirtyReason = "";
  }
  if (!Number.isFinite(vectorIndexState.pendingRepairFromFloor)) {
    vectorIndexState.pendingRepairFromFloor = null;
  }
  if (
    vectorIndexState.lastIntegrityIssue != null &&
    (typeof vectorIndexState.lastIntegrityIssue !== "object" ||
      Array.isArray(vectorIndexState.lastIntegrityIssue))
  ) {
    vectorIndexState.lastIntegrityIssue = null;
  }

  const previousCollectionId = vectorIndexState.collectionId;
  vectorIndexState.collectionId = buildVectorCollectionId(
    chatId || historyState.chatId,
  );

  if (
    previousCollectionId &&
    previousCollectionId !== vectorIndexState.collectionId
  ) {
    vectorIndexState.hashToNodeId = {};
    vectorIndexState.nodeToHash = {};
    vectorIndexState.replayRequiredNodeIds = [];
    vectorIndexState.dirty = true;
    vectorIndexState.dirtyReason = "chat-id-changed";
    vectorIndexState.pendingRepairFromFloor = 0;
    vectorIndexState.lastWarning = "聊天标识变化，向量索引已标记为待重建";
  }

  graph.historyState = historyState;
  graph.vectorIndexState = vectorIndexState;
  if (Array.isArray(graph.nodes)) {
    graph.nodes.forEach((node) => normalizeNodeMemoryScope(node));
  }
  if (Array.isArray(graph.edges)) {
    graph.edges.forEach((edge) => normalizeEdgeMemoryScope(edge));
  }
  graph.batchJournal = Array.isArray(graph.batchJournal)
    ? graph.batchJournal.slice(-BATCH_JOURNAL_LIMIT)
    : createDefaultBatchJournal();
  graph.maintenanceJournal = Array.isArray(graph.maintenanceJournal)
    ? graph.maintenanceJournal
        .filter((entry) => entry && typeof entry === "object")
        .slice(-MAINTENANCE_JOURNAL_LIMIT)
    : createDefaultMaintenanceJournal();
  graph.knowledgeState = createDefaultKnowledgeState(graph.knowledgeState);
  graph.regionState = createDefaultRegionState(graph.regionState);
  graph.timelineState = createDefaultTimelineState(graph.timelineState);
  normalizeGraphCognitiveState(graph);
  normalizeGraphStoryTimeline(graph);
  graph.lastProcessedSeq = historyState.lastProcessedAssistantFloor;
  return graph;
}

export function cloneGraphSnapshot(graph) {
  const snapshot = JSON.parse(JSON.stringify(graph));

  if (Array.isArray(snapshot.batchJournal)) {
    snapshot.batchJournal = snapshot.batchJournal.map((journal) => {
      if (!journal?.snapshotBefore) return journal;
      return {
        ...journal,
        snapshotBefore: {
          ...journal.snapshotBefore,
          batchJournal: [],
        },
      };
    });
  }

  return snapshot;
}

export function stableHashString(text) {
  let hash = 2166136261;
  for (const char of String(text || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function buildMessageHash(message) {
  const swipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : null;
  const payload = JSON.stringify({
    isUser: Boolean(message?.is_user),
    text: String(message?.mes || ""),
    swipeId,
  });
  return String(stableHashString(payload));
}

export function snapshotProcessedMessageHashes(
  chat,
  lastProcessedAssistantFloor,
) {
  const result = {};
  if (!Array.isArray(chat) || lastProcessedAssistantFloor < 0) {
    return result;
  }

  const upperBound = Math.min(lastProcessedAssistantFloor, chat.length - 1);
  for (let index = 0; index <= upperBound; index++) {
    result[index] = buildMessageHash(chat[index]);
  }
  return result;
}

export function rebindProcessedHistoryStateToChat(
  graph,
  chat,
  assistantTurns = [],
) {
  if (!graph || typeof graph !== "object") {
    return {
      rebound: false,
      reason: "missing-graph",
      lastProcessedAssistantFloor: -1,
      maxAssistantFloor: -1,
      clamped: false,
    };
  }

  const historyState =
    graph.historyState && typeof graph.historyState === "object"
      ? graph.historyState
      : createDefaultHistoryState();
  graph.historyState = historyState;

  const normalizedAssistantTurns = Array.isArray(assistantTurns)
    ? assistantTurns
        .map((value) => Number.parseInt(value, 10))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
    : [];
  const maxAssistantFloor =
    normalizedAssistantTurns.length > 0
      ? normalizedAssistantTurns[normalizedAssistantTurns.length - 1]
      : -1;
  const rawLastProcessedAssistantFloor = Number.isFinite(
    historyState.lastProcessedAssistantFloor,
  )
    ? Math.floor(historyState.lastProcessedAssistantFloor)
    : -1;

  let safeLastProcessedAssistantFloor = rawLastProcessedAssistantFloor;
  if (!Array.isArray(chat) || chat.length === 0 || maxAssistantFloor < 0) {
    safeLastProcessedAssistantFloor = -1;
  } else if (safeLastProcessedAssistantFloor > maxAssistantFloor) {
    safeLastProcessedAssistantFloor = maxAssistantFloor;
  }

  historyState.lastProcessedAssistantFloor = safeLastProcessedAssistantFloor;
  historyState.processedMessageHashVersion = PROCESSED_MESSAGE_HASH_VERSION;
  historyState.processedMessageHashes =
    safeLastProcessedAssistantFloor >= 0
      ? snapshotProcessedMessageHashes(chat, safeLastProcessedAssistantFloor)
      : {};
  historyState.processedMessageHashesNeedRefresh = false;
  graph.lastProcessedSeq = safeLastProcessedAssistantFloor;

  return {
    rebound: true,
    reason:
      safeLastProcessedAssistantFloor < 0
        ? "no-processed-assistant-floor"
        : "ok",
    lastProcessedAssistantFloor: safeLastProcessedAssistantFloor,
    maxAssistantFloor,
    clamped:
      safeLastProcessedAssistantFloor !== rawLastProcessedAssistantFloor,
  };
}

export function detectHistoryMutation(chat, historyState) {
  const lastProcessedAssistantFloor =
    historyState?.lastProcessedAssistantFloor ?? -1;
  const processedMessageHashVersion = Number.isFinite(
    historyState?.processedMessageHashVersion,
  )
    ? Math.max(1, Math.floor(historyState.processedMessageHashVersion))
    : 1;
  const processedMessageHashesNeedRefresh =
    historyState?.processedMessageHashesNeedRefresh === true;

  const processedMessageHashes =
    historyState?.processedMessageHashes &&
    typeof historyState.processedMessageHashes === "object" &&
    !Array.isArray(historyState.processedMessageHashes)
      ? historyState.processedMessageHashes
      : {};

  if (!Array.isArray(chat) || lastProcessedAssistantFloor < 0) {
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
  }
  if (
    processedMessageHashesNeedRefresh ||
    processedMessageHashVersion !== PROCESSED_MESSAGE_HASH_VERSION
  ) {
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
  }

  if (lastProcessedAssistantFloor >= chat.length) {
    return {
      dirty: true,
      earliestAffectedFloor: chat.length,
      reason: "已处理楼层超出当前聊天长度，检测到历史截断",
    };
  }

  const trackedFloors = Object.keys(processedMessageHashes)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (trackedFloors.length === 0 && lastProcessedAssistantFloor >= 0) {
    return {
      dirty: true,
      earliestAffectedFloor: 0,
      reason: "已处理楼层存在，但 processedMessageHashes 缺失，执行保守重放",
    };
  }

  for (let floor = 0; floor <= lastProcessedAssistantFloor; floor++) {
    if (
      !Object.prototype.hasOwnProperty.call(
        processedMessageHashes,
        String(floor),
      )
    ) {
      return {
        dirty: true,
        earliestAffectedFloor: floor,
        reason: `楼层 ${floor} 缺少已处理哈希，执行保守重放`,
      };
    }
  }

  for (const floor of trackedFloors) {
    if (floor >= chat.length) {
      return {
        dirty: true,
        earliestAffectedFloor: floor,
        reason: `楼层 ${floor} 已不存在，检测到历史删除/截断`,
      };
    }

    const currentHash = buildMessageHash(chat[floor]);
    if (currentHash !== processedMessageHashes[floor]) {
      return {
        dirty: true,
        earliestAffectedFloor: floor,
        reason: `楼层 ${floor} 内容或 swipe 已变化`,
      };
    }
  }

  return { dirty: false, earliestAffectedFloor: null, reason: "" };
}

export function markHistoryDirty(graph, floor, reason = "", source = "") {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  const currentDirtyFrom = graph.historyState.historyDirtyFrom;

  if (!Number.isFinite(floor)) {
    floor = graph.historyState.lastProcessedAssistantFloor;
  }

  graph.historyState.historyDirtyFrom = Number.isFinite(currentDirtyFrom)
    ? Math.min(currentDirtyFrom, floor)
    : floor;
  graph.historyState.lastMutationReason = String(reason || "").trim();
  graph.historyState.lastMutationSource = String(source || "").trim();
  graph.historyState.lastRecoveryResult = {
    status: "pending",
    at: Date.now(),
    fromFloor: graph.historyState.historyDirtyFrom,
    reason: graph.historyState.lastMutationReason,
    detectionSource: graph.historyState.lastMutationSource || "",
  };
}

export function clearHistoryDirty(graph, result = null) {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  graph.historyState.historyDirtyFrom = null;
  graph.historyState.lastMutationReason = "";
  graph.historyState.lastMutationSource = "";
  graph.historyState.processedMessageHashVersion =
    PROCESSED_MESSAGE_HASH_VERSION;
  graph.historyState.processedMessageHashes = {};
  graph.historyState.processedMessageHashesNeedRefresh = false;
  if (result) {
    graph.historyState.lastRecoveryResult = result;
  }
}

function buildNodeMap(nodes = []) {
  return new Map(nodes.map((node) => [node.id, node]));
}

function buildEdgeMap(edges = []) {
  return new Map(edges.map((edge) => [edge.id, edge]));
}

function hasMeaningfulNodeChange(beforeNode, afterNode) {
  return JSON.stringify(beforeNode) !== JSON.stringify(afterNode);
}

function hasMeaningfulEdgeChange(beforeEdge, afterEdge) {
  return JSON.stringify(beforeEdge) !== JSON.stringify(afterEdge);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function normalizeMappingArray(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const mappings = [];
  for (const entry of values) {
    if (!entry || typeof entry !== "object") continue;
    const nodeId = entry.nodeId ? String(entry.nodeId) : "";
    const previousHash = entry.previousHash ? String(entry.previousHash) : "";
    const nextHash = entry.nextHash ? String(entry.nextHash) : "";
    if (!nodeId && !previousHash && !nextHash) continue;
    const key = JSON.stringify([nodeId, previousHash, nextHash]);
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push({ nodeId, previousHash, nextHash });
  }
  return mappings;
}

function buildVectorDelta(snapshotBefore, snapshotAfter, meta = {}) {
  const beforeState = snapshotBefore?.vectorIndexState || {};
  const afterState = snapshotAfter?.vectorIndexState || {};
  const beforeNodeToHash = beforeState.nodeToHash || {};
  const afterNodeToHash = afterState.nodeToHash || {};
  const beforeHashSet = new Set(
    Object.values(beforeState.hashToNodeId || {}).filter(Boolean),
  );
  const afterHashSet = new Set(
    Object.values(afterState.hashToNodeId || {}).filter(Boolean),
  );
  const insertedHashes = new Set(
    normalizeStringArray(meta.vectorHashesInserted),
  );
  const removedHashes = new Set(normalizeStringArray(meta.vectorHashesRemoved));
  const touchedNodeIds = new Set(
    normalizeStringArray(meta.vectorTouchedNodeIds),
  );
  const replayRequiredNodeIds = new Set(
    normalizeStringArray(meta.vectorReplayRequiredNodeIds),
  );
  const backendDeleteHashes = new Set(
    normalizeStringArray(meta.vectorBackendDeleteHashes),
  );
  const replacedMappings = normalizeMappingArray(meta.vectorReplacedMappings);
  const nodeIds = new Set([
    ...Object.keys(beforeNodeToHash),
    ...Object.keys(afterNodeToHash),
  ]);

  for (const hash of Object.keys(afterState.hashToNodeId || {})) {
    if (!beforeHashSet.has(hash)) insertedHashes.add(hash);
  }
  for (const hash of Object.keys(beforeState.hashToNodeId || {})) {
    if (!afterHashSet.has(hash)) removedHashes.add(hash);
  }

  for (const nodeId of nodeIds) {
    const previousHash = beforeNodeToHash[nodeId]
      ? String(beforeNodeToHash[nodeId])
      : "";
    const nextHash = afterNodeToHash[nodeId]
      ? String(afterNodeToHash[nodeId])
      : "";
    if (previousHash === nextHash) continue;
    touchedNodeIds.add(String(nodeId));
    if (previousHash) {
      removedHashes.add(previousHash);
      backendDeleteHashes.add(previousHash);
    }
    if (nextHash) {
      insertedHashes.add(nextHash);
    }
    if (previousHash || nextHash) {
      const key = JSON.stringify([String(nodeId), previousHash, nextHash]);
      const exists = replacedMappings.some(
        (entry) =>
          JSON.stringify([entry.nodeId, entry.previousHash, entry.nextHash]) ===
          key,
      );
      if (!exists) {
        replacedMappings.push({
          nodeId: String(nodeId),
          previousHash,
          nextHash,
        });
      }
    }
  }

  for (const nodeId of normalizeStringArray(afterState.replayRequiredNodeIds)) {
    replayRequiredNodeIds.add(nodeId);
  }

  return {
    insertedHashes: [...insertedHashes],
    removedHashes: [...removedHashes],
    replacedMappings,
    touchedNodeIds: [...touchedNodeIds],
    replayRequiredNodeIds: [...replayRequiredNodeIds],
    backendDeleteHashes: [...backendDeleteHashes],
  };
}

function buildJournalStateBefore(snapshotBefore, meta = {}) {
  return {
    lastProcessedAssistantFloor:
      snapshotBefore?.historyState?.lastProcessedAssistantFloor ??
      snapshotBefore?.lastProcessedSeq ??
      -1,
    processedMessageHashVersion: Number.isFinite(
      snapshotBefore?.historyState?.processedMessageHashVersion,
    )
      ? Math.max(
          1,
          Math.floor(snapshotBefore.historyState.processedMessageHashVersion),
        )
      : PROCESSED_MESSAGE_HASH_VERSION,
    processedMessageHashes: clonePlain(
      snapshotBefore?.historyState?.processedMessageHashes || {},
    ),
    processedMessageHashesNeedRefresh:
      snapshotBefore?.historyState?.processedMessageHashesNeedRefresh === true,
    historyDirtyFrom: Number.isFinite(
      snapshotBefore?.historyState?.historyDirtyFrom,
    )
      ? snapshotBefore.historyState.historyDirtyFrom
      : null,
    vectorIndexState: clonePlain(snapshotBefore?.vectorIndexState || {}),
    lastRecallResult: Array.isArray(snapshotBefore?.lastRecallResult)
      ? [...snapshotBefore.lastRecallResult]
      : null,
    extractionCount: Number.isFinite(meta.extractionCountBefore)
      ? meta.extractionCountBefore
      : (snapshotBefore?.historyState?.extractionCount ?? 0),
  };
}

export function createBatchJournalEntry(
  snapshotBefore,
  snapshotAfter,
  meta = {},
) {
  const beforeNodes = buildNodeMap(snapshotBefore?.nodes || []);
  const afterNodes = buildNodeMap(snapshotAfter?.nodes || []);
  const beforeEdges = buildEdgeMap(snapshotBefore?.edges || []);
  const afterEdges = buildEdgeMap(snapshotAfter?.edges || []);

  const createdNodeIds = [];
  const createdEdgeIds = [];
  const previousNodeSnapshots = [];
  const previousEdgeSnapshots = [];

  for (const [nodeId, afterNode] of afterNodes.entries()) {
    if (!beforeNodes.has(nodeId)) {
      createdNodeIds.push(nodeId);
      continue;
    }

    const beforeNode = beforeNodes.get(nodeId);
    if (!hasMeaningfulNodeChange(beforeNode, afterNode)) continue;
    previousNodeSnapshots.push(cloneGraphSnapshot(beforeNode));
  }

  for (const [edgeId, afterEdge] of afterEdges.entries()) {
    if (!beforeEdges.has(edgeId)) {
      createdEdgeIds.push(edgeId);
      continue;
    }

    const beforeEdge = beforeEdges.get(edgeId);
    if (!hasMeaningfulEdgeChange(beforeEdge, afterEdge)) continue;
    previousEdgeSnapshots.push(cloneGraphSnapshot(beforeEdge));
  }

  const entry = {
    id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    journalVersion: BATCH_JOURNAL_VERSION,
    createdAt: Date.now(),
    processedRange: meta.processedRange || [-1, -1],
    createdNodeIds,
    createdEdgeIds,
    previousNodeSnapshots,
    previousEdgeSnapshots,
    stateBefore: buildJournalStateBefore(snapshotBefore, meta),
    vectorDelta: buildVectorDelta(snapshotBefore, snapshotAfter, meta),
    postProcessArtifacts: Array.isArray(meta.postProcessArtifacts)
      ? meta.postProcessArtifacts
      : [],
  };

  if (meta.includeLegacySnapshotBefore) {
    entry.snapshotBefore = snapshotBefore;
  }

  return entry;
}

export function appendBatchJournal(graph, entry) {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  graph.batchJournal.push(entry);
  if (graph.batchJournal.length > BATCH_JOURNAL_LIMIT) {
    graph.batchJournal = graph.batchJournal.slice(-BATCH_JOURNAL_LIMIT);
  }
}

export function createMaintenanceJournalEntry(
  snapshotBefore,
  snapshotAfter,
  meta = {},
) {
  const normalizedChatId = String(
    meta.chatId ||
      snapshotAfter?.historyState?.chatId ||
      snapshotBefore?.historyState?.chatId ||
      "",
  ).trim();
  const normalizedBefore = normalizeGraphRuntimeState(
    cloneGraphSnapshot(snapshotBefore || { nodes: [], edges: [] }),
    normalizedChatId,
  );
  const normalizedAfter = normalizeGraphRuntimeState(
    cloneGraphSnapshot(snapshotAfter || { nodes: [], edges: [] }),
    normalizedChatId,
  );

  const beforeNodes = buildNodeMap(normalizedBefore?.nodes || []);
  const afterNodes = buildNodeMap(normalizedAfter?.nodes || []);
  const beforeEdges = buildEdgeMap(normalizedBefore?.edges || []);
  const afterEdges = buildEdgeMap(normalizedAfter?.edges || []);

  const restoreNodes = [];
  const restoreEdges = [];
  const deleteNodeIds = [];
  const deleteEdgeIds = [];
  const postNodes = [];
  const postEdges = [];

  for (const [nodeId, beforeNode] of beforeNodes.entries()) {
    const afterNode = afterNodes.get(nodeId);
    if (!afterNode) {
      restoreNodes.push(cloneGraphSnapshot(beforeNode));
      continue;
    }
    if (!hasMeaningfulNodeChange(beforeNode, afterNode)) continue;
    restoreNodes.push(cloneGraphSnapshot(beforeNode));
    postNodes.push(cloneGraphSnapshot(afterNode));
  }

  for (const [nodeId, afterNode] of afterNodes.entries()) {
    if (beforeNodes.has(nodeId)) continue;
    deleteNodeIds.push(nodeId);
    postNodes.push(cloneGraphSnapshot(afterNode));
  }

  for (const [edgeId, beforeEdge] of beforeEdges.entries()) {
    const afterEdge = afterEdges.get(edgeId);
    if (!afterEdge) {
      restoreEdges.push(cloneGraphSnapshot(beforeEdge));
      continue;
    }
    if (!hasMeaningfulEdgeChange(beforeEdge, afterEdge)) continue;
    restoreEdges.push(cloneGraphSnapshot(beforeEdge));
    postEdges.push(cloneGraphSnapshot(afterEdge));
  }

  for (const [edgeId, afterEdge] of afterEdges.entries()) {
    if (beforeEdges.has(edgeId)) continue;
    deleteEdgeIds.push(edgeId);
    postEdges.push(cloneGraphSnapshot(afterEdge));
  }

  if (
    restoreNodes.length === 0 &&
    restoreEdges.length === 0 &&
    deleteNodeIds.length === 0 &&
    deleteEdgeIds.length === 0
  ) {
    return null;
  }

  return {
    id: `maintenance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    action: String(meta.action || "unknown"),
    mode:
      meta.mode === "auto" || meta.mode === "manual" ? meta.mode : "manual",
    summary: String(meta.summary || ""),
    inversePatch: {
      restoreNodes,
      restoreEdges,
      deleteNodeIds,
      deleteEdgeIds,
    },
    postCheck: {
      nodes: postNodes,
      edges: postEdges,
    },
  };
}

export function appendMaintenanceJournal(graph, entry) {
  if (!entry || typeof entry !== "object") return;
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  graph.maintenanceJournal.push(entry);
  if (graph.maintenanceJournal.length > MAINTENANCE_JOURNAL_LIMIT) {
    graph.maintenanceJournal = graph.maintenanceJournal.slice(
      -MAINTENANCE_JOURNAL_LIMIT,
    );
  }
}

export function getLatestMaintenanceJournalEntry(graph) {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  const journal = Array.isArray(graph?.maintenanceJournal)
    ? graph.maintenanceJournal
    : [];
  return journal.length > 0 ? journal[journal.length - 1] : null;
}

function validateMaintenanceUndoState(graph, entry) {
  const currentNodes = buildNodeMap(graph?.nodes || []);
  const currentEdges = buildEdgeMap(graph?.edges || []);
  const expectedNodes = entry?.postCheck?.nodes || [];
  const expectedEdges = entry?.postCheck?.edges || [];

  for (const snapshot of expectedNodes) {
    const current = currentNodes.get(snapshot?.id);
    if (!current) {
      return {
        ok: false,
        reason: `节点 ${snapshot?.id || "unknown"} 已被后续操作改写`,
      };
    }
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
      return {
        ok: false,
        reason: `节点 ${snapshot?.id || "unknown"} 当前状态已变化，无法安全撤销`,
      };
    }
  }

  for (const snapshot of expectedEdges) {
    const current = currentEdges.get(snapshot?.id);
    if (!current) {
      return {
        ok: false,
        reason: `边 ${snapshot?.id || "unknown"} 已被后续操作改写`,
      };
    }
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
      return {
        ok: false,
        reason: `边 ${snapshot?.id || "unknown"} 当前状态已变化，无法安全撤销`,
      };
    }
  }

  return { ok: true, reason: "" };
}

export function applyMaintenanceInversePatch(graph, inversePatch = {}) {
  if (!graph || !inversePatch || typeof inversePatch !== "object") {
    return graph;
  }

  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");

  const deleteNodeIds = new Set(inversePatch.deleteNodeIds || []);
  const deleteEdgeIds = new Set(inversePatch.deleteEdgeIds || []);
  const restoreNodes = Array.isArray(inversePatch.restoreNodes)
    ? inversePatch.restoreNodes
    : [];
  const restoreEdges = Array.isArray(inversePatch.restoreEdges)
    ? inversePatch.restoreEdges
    : [];

  graph.edges = (graph.edges || []).filter(
    (edge) =>
      !deleteEdgeIds.has(edge.id) &&
      !deleteNodeIds.has(edge.fromId) &&
      !deleteNodeIds.has(edge.toId),
  );
  graph.nodes = (graph.nodes || []).filter((node) => !deleteNodeIds.has(node.id));

  for (const nodeSnapshot of restoreNodes) {
    upsertById(graph.nodes, cloneGraphSnapshot(nodeSnapshot));
  }
  for (const edgeSnapshot of restoreEdges) {
    upsertById(graph.edges, cloneGraphSnapshot(edgeSnapshot));
  }

  sanitizeGraphReferences(graph);
  return graph;
}

export function undoLatestMaintenance(graph) {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  const entry = getLatestMaintenanceJournalEntry(graph);
  if (!entry) {
    return {
      ok: false,
      reason: "当前没有可撤销的维护记录",
      entry: null,
    };
  }

  const validation = validateMaintenanceUndoState(graph, entry);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      entry,
    };
  }

  applyMaintenanceInversePatch(graph, entry.inversePatch || {});
  graph.maintenanceJournal = graph.maintenanceJournal.slice(0, -1);

  return {
    ok: true,
    reason: "",
    entry,
    remaining: graph.maintenanceJournal.length,
  };
}

function upsertById(list, item) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
    list[index] = item;
  } else {
    list.push(item);
  }
}

function sanitizeGraphReferences(graph) {
  const nodeIds = new Set((graph?.nodes || []).map((node) => node.id));
  graph.nodes = (graph.nodes || []).map((node) => ({
    ...node,
    parentId: nodeIds.has(node.parentId) ? node.parentId : null,
    childIds: Array.isArray(node.childIds)
      ? node.childIds.filter((id) => nodeIds.has(id))
      : [],
    prevId: nodeIds.has(node.prevId) ? node.prevId : null,
    nextId: nodeIds.has(node.nextId) ? node.nextId : null,
  }));
  graph.edges = (graph.edges || []).filter(
    (edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId),
  );
}

function applyJournalStateBefore(graph, stateBefore = {}) {
  const historyState = {
    ...createDefaultHistoryState(graph?.historyState?.chatId || ""),
    ...(graph.historyState || {}),
  };
  historyState.lastProcessedAssistantFloor = Number.isFinite(
    stateBefore.lastProcessedAssistantFloor,
  )
    ? stateBefore.lastProcessedAssistantFloor
    : historyState.lastProcessedAssistantFloor;
  historyState.processedMessageHashVersion = Number.isFinite(
    stateBefore.processedMessageHashVersion,
  )
    ? Math.max(1, Math.floor(stateBefore.processedMessageHashVersion))
    : historyState.processedMessageHashVersion;
  historyState.processedMessageHashes = clonePlain(
    stateBefore.processedMessageHashes || {},
  );
  historyState.processedMessageHashesNeedRefresh =
    stateBefore.processedMessageHashesNeedRefresh === true;
  historyState.historyDirtyFrom = Number.isFinite(stateBefore.historyDirtyFrom)
    ? stateBefore.historyDirtyFrom
    : null;
  historyState.extractionCount = Number.isFinite(stateBefore.extractionCount)
    ? stateBefore.extractionCount
    : historyState.extractionCount;
  graph.historyState = historyState;

  graph.vectorIndexState = {
    ...createDefaultVectorIndexState(graph?.historyState?.chatId || ""),
    ...clonePlain(stateBefore.vectorIndexState || {}),
  };
  graph.lastRecallResult = Array.isArray(stateBefore.lastRecallResult)
    ? [...stateBefore.lastRecallResult]
    : null;
  graph.lastProcessedSeq = historyState.lastProcessedAssistantFloor;
}

export function rollbackBatch(graph, journal) {
  if (!graph || !journal) return graph;

  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");

  const createdNodeIds = new Set(journal.createdNodeIds || []);
  const createdEdgeIds = new Set(journal.createdEdgeIds || []);
  const previousNodeSnapshots =
    journal.previousNodeSnapshots ||
    journal.updatedNodeSnapshots ||
    journal.archivedNodeSnapshots ||
    [];
  const previousEdgeSnapshots =
    journal.previousEdgeSnapshots || journal.invalidatedEdgeSnapshots || [];

  graph.edges = (graph.edges || []).filter(
    (edge) =>
      !createdEdgeIds.has(edge.id) &&
      !createdNodeIds.has(edge.fromId) &&
      !createdNodeIds.has(edge.toId),
  );
  graph.nodes = (graph.nodes || []).filter(
    (node) => !createdNodeIds.has(node.id),
  );

  for (const nodeSnapshot of previousNodeSnapshots) {
    upsertById(graph.nodes, cloneGraphSnapshot(nodeSnapshot));
  }
  for (const edgeSnapshot of previousEdgeSnapshots) {
    upsertById(graph.edges, cloneGraphSnapshot(edgeSnapshot));
  }

  applyJournalStateBefore(graph, journal.stateBefore || {});
  sanitizeGraphReferences(graph);
  return graph;
}

export function findJournalRecoveryPoint(graph, dirtyFromFloor) {
  const journals = Array.isArray(graph?.batchJournal) ? graph.batchJournal : [];
  const affectedIndex = journals.findIndex((journal) => {
    const range = Array.isArray(journal?.processedRange)
      ? journal.processedRange
      : [-1, -1];
    return Number.isFinite(range[1]) && range[1] >= dirtyFromFloor;
  });

  if (affectedIndex < 0) return null;

  const affectedJournals = journals.slice(affectedIndex);
  const canReverse = affectedJournals.every(
    (journal) => Number(journal?.journalVersion || 0) >= BATCH_JOURNAL_VERSION,
  );
  if (canReverse) {
    return {
      path: "reverse-journal",
      affectedIndex,
      affectedJournals: affectedJournals.map((journal) =>
        cloneGraphSnapshot(journal),
      ),
      affectedBatchCount: affectedJournals.length,
    };
  }

  const journal = journals[affectedIndex];
  if (journal?.snapshotBefore) {
    return {
      path: "legacy-snapshot",
      affectedIndex,
      journal: cloneGraphSnapshot(journal),
      snapshotBefore: cloneGraphSnapshot(journal.snapshotBefore),
      affectedBatchCount: affectedJournals.length,
    };
  }

  return null;
}

export function buildReverseJournalRecoveryPlan(
  affectedJournals = [],
  dirtyFromFloor = null,
) {
  const backendDeleteHashes = new Set();
  const replayRequiredNodeIds = new Set();
  const touchedNodeIds = new Set();
  let hasLegacyGap = false;
  let minProcessedFloor = Number.isFinite(dirtyFromFloor)
    ? dirtyFromFloor
    : null;
  let invalidJournalReason = "";

  if (!Array.isArray(affectedJournals) || affectedJournals.length === 0) {
    invalidJournalReason = "affected-journals-empty";
  }

  for (const journal of affectedJournals) {
    const vectorDelta = journal?.vectorDelta || {};
    const insertedHashes = normalizeStringArray(
      vectorDelta.insertedHashes || journal?.vectorHashesInserted || [],
    );
    const removedHashes = normalizeStringArray(vectorDelta.removedHashes);
    const backendDeletes = normalizeStringArray(
      vectorDelta.backendDeleteHashes,
    );
    const touchedNodes = normalizeStringArray(vectorDelta.touchedNodeIds);
    const replayNodes = normalizeStringArray(vectorDelta.replayRequiredNodeIds);
    const replacedMappings = normalizeMappingArray(
      vectorDelta.replacedMappings,
    );
    const range = Array.isArray(journal?.processedRange)
      ? journal.processedRange
      : [-1, -1];

    if (
      !invalidJournalReason &&
      (!Number.isFinite(range[0]) || !Number.isFinite(range[1]))
    ) {
      invalidJournalReason = "processed-range-missing";
    }

    if (Number.isFinite(range[0])) {
      minProcessedFloor = Number.isFinite(minProcessedFloor)
        ? Math.min(minProcessedFloor, range[0])
        : range[0];
    }

    for (const hash of insertedHashes) {
      backendDeleteHashes.add(hash);
    }
    for (const hash of removedHashes) {
      backendDeleteHashes.add(hash);
    }
    for (const hash of backendDeletes) {
      backendDeleteHashes.add(hash);
    }
    for (const nodeId of touchedNodes) {
      touchedNodeIds.add(nodeId);
      replayRequiredNodeIds.add(nodeId);
    }
    for (const nodeId of replayNodes) {
      replayRequiredNodeIds.add(nodeId);
    }
    for (const entry of replacedMappings) {
      if (entry.nodeId) {
        touchedNodeIds.add(entry.nodeId);
        replayRequiredNodeIds.add(entry.nodeId);
      }
      if (entry.previousHash) backendDeleteHashes.add(entry.previousHash);
      if (entry.nextHash) backendDeleteHashes.add(entry.nextHash);
    }

    if (
      !Array.isArray(vectorDelta.removedHashes) ||
      !Array.isArray(vectorDelta.replacedMappings) ||
      !Array.isArray(vectorDelta.touchedNodeIds) ||
      !Array.isArray(vectorDelta.replayRequiredNodeIds) ||
      !Array.isArray(vectorDelta.backendDeleteHashes)
    ) {
      hasLegacyGap = true;
    }
  }

  const pendingRepairFromFloor = Number.isFinite(minProcessedFloor)
    ? minProcessedFloor
    : null;

  return {
    backendDeleteHashes: [...backendDeleteHashes],
    replayRequiredNodeIds: [...replayRequiredNodeIds],
    touchedNodeIds: [...touchedNodeIds],
    pendingRepairFromFloor,
    legacyGapFallback: hasLegacyGap,
    dirtyReason: hasLegacyGap ? "legacy-gap" : "history-recovery-replay",
    valid:
      !invalidJournalReason &&
      Number.isFinite(pendingRepairFromFloor) &&
      pendingRepairFromFloor >= 0,
    invalidReason:
      invalidJournalReason ||
      (!Number.isFinite(pendingRepairFromFloor)
        ? "pending-repair-floor-missing"
        : pendingRepairFromFloor < 0
          ? "pending-repair-floor-negative"
          : ""),
  };
}

export function buildRecoveryResult(status, extra = {}) {
  return {
    status,
    at: Date.now(),
    debugReason:
      typeof extra?.debugReason === "string" && extra.debugReason.trim()
        ? extra.debugReason.trim()
        : typeof extra?.reason === "string"
          ? extra.reason
          : "",
    ...extra,
  };
}
