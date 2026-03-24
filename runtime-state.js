// ST-BME: 运行时状态与历史恢复辅助

const BATCH_JOURNAL_LIMIT = 96;
export const BATCH_JOURNAL_VERSION = 2;

export function buildVectorCollectionId(chatId) {
  return `st-bme::${chatId || "unknown-chat"}`;
}

export function createDefaultHistoryState(chatId = "") {
  return {
    chatId,
    lastProcessedAssistantFloor: -1,
    processedMessageHashes: {},
    historyDirtyFrom: null,
    lastMutationReason: "",
    lastMutationSource: "",
    extractionCount: 0,
    lastRecoveryResult: null,
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
    lastSyncAt: 0,
    lastStats: {
      total: 0,
      indexed: 0,
      stale: 0,
      pending: 0,
    },
    lastWarning: "",
  };
}

export function createDefaultBatchJournal() {
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
    historyState.lastProcessedAssistantFloor = Number.isFinite(graph.lastProcessedSeq)
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
    !historyState.processedMessageHashes ||
    typeof historyState.processedMessageHashes !== "object" ||
    Array.isArray(historyState.processedMessageHashes)
  ) {
    historyState.processedMessageHashes = {};
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
  if (!vectorIndexState.lastStats || typeof vectorIndexState.lastStats !== "object") {
    vectorIndexState.lastStats = createDefaultVectorIndexState(chatId).lastStats;
  }

  const previousCollectionId = vectorIndexState.collectionId;
  vectorIndexState.collectionId = buildVectorCollectionId(chatId || historyState.chatId);

  if (previousCollectionId && previousCollectionId !== vectorIndexState.collectionId) {
    vectorIndexState.hashToNodeId = {};
    vectorIndexState.nodeToHash = {};
    vectorIndexState.dirty = true;
    vectorIndexState.lastWarning = "聊天标识变化，向量索引已标记为待重建";
  }

  graph.historyState = historyState;
  graph.vectorIndexState = vectorIndexState;
  graph.batchJournal = Array.isArray(graph.batchJournal)
    ? graph.batchJournal.slice(-BATCH_JOURNAL_LIMIT)
    : createDefaultBatchJournal();
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
    isSystem: Boolean(message?.is_system),
    text: String(message?.mes || ""),
    swipeId,
  });
  return String(stableHashString(payload));
}

export function snapshotProcessedMessageHashes(chat, lastProcessedAssistantFloor) {
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

export function detectHistoryMutation(chat, historyState) {
  const lastProcessedAssistantFloor =
    historyState?.lastProcessedAssistantFloor ?? -1;
  const processedMessageHashes = historyState?.processedMessageHashes || {};

  if (!Array.isArray(chat) || lastProcessedAssistantFloor < 0) {
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
  }

  const trackedFloors = Object.keys(processedMessageHashes)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (trackedFloors.length === 0) {
    return { dirty: false, earliestAffectedFloor: null, reason: "" };
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

  if (lastProcessedAssistantFloor >= chat.length) {
    return {
      dirty: true,
      earliestAffectedFloor: chat.length,
      reason: "已处理楼层超出当前聊天长度，检测到历史截断",
    };
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

function buildJournalStateBefore(snapshotBefore, meta = {}) {
  return {
    lastProcessedAssistantFloor:
      snapshotBefore?.historyState?.lastProcessedAssistantFloor ??
      snapshotBefore?.lastProcessedSeq ??
      -1,
    processedMessageHashes: clonePlain(
      snapshotBefore?.historyState?.processedMessageHashes || {},
    ),
    historyDirtyFrom: Number.isFinite(snapshotBefore?.historyState?.historyDirtyFrom)
      ? snapshotBefore.historyState.historyDirtyFrom
      : null,
    vectorIndexState: clonePlain(snapshotBefore?.vectorIndexState || {}),
    lastRecallResult: Array.isArray(snapshotBefore?.lastRecallResult)
      ? [...snapshotBefore.lastRecallResult]
      : null,
    extractionCount: Number.isFinite(meta.extractionCountBefore)
      ? meta.extractionCountBefore
      : snapshotBefore?.historyState?.extractionCount ?? 0,
  };
}

export function createBatchJournalEntry(snapshotBefore, snapshotAfter, meta = {}) {
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
    vectorDelta: {
      insertedHashes: Array.isArray(meta.vectorHashesInserted)
        ? [...new Set(meta.vectorHashesInserted)]
        : [],
    },
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
  historyState.processedMessageHashes = clonePlain(
    stateBefore.processedMessageHashes || {},
  );
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
    journal.previousEdgeSnapshots ||
    journal.invalidatedEdgeSnapshots ||
    [];

  graph.edges = (graph.edges || []).filter(
    (edge) =>
      !createdEdgeIds.has(edge.id) &&
      !createdNodeIds.has(edge.fromId) &&
      !createdNodeIds.has(edge.toId),
  );
  graph.nodes = (graph.nodes || []).filter((node) => !createdNodeIds.has(node.id));

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
      affectedJournals: affectedJournals.map((journal) => cloneGraphSnapshot(journal)),
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

export function buildRecoveryResult(status, extra = {}) {
  return {
    status,
    at: Date.now(),
    ...extra,
  };
}
