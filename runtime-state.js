// ST-BME: 运行时状态与历史恢复辅助

const BATCH_JOURNAL_LIMIT = 24;

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

export function markHistoryDirty(graph, floor, reason = "") {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  const currentDirtyFrom = graph.historyState.historyDirtyFrom;

  if (!Number.isFinite(floor)) {
    floor = graph.historyState.lastProcessedAssistantFloor;
  }

  graph.historyState.historyDirtyFrom = Number.isFinite(currentDirtyFrom)
    ? Math.min(currentDirtyFrom, floor)
    : floor;
  graph.historyState.lastMutationReason = String(reason || "").trim();
  graph.historyState.lastRecoveryResult = {
    status: "pending",
    at: Date.now(),
    fromFloor: graph.historyState.historyDirtyFrom,
    reason: graph.historyState.lastMutationReason,
  };
}

export function clearHistoryDirty(graph, result = null) {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  graph.historyState.historyDirtyFrom = null;
  graph.historyState.lastMutationReason = "";
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

export function createBatchJournalEntry(snapshotBefore, snapshotAfter, meta = {}) {
  const beforeNodes = buildNodeMap(snapshotBefore?.nodes || []);
  const afterNodes = buildNodeMap(snapshotAfter?.nodes || []);
  const beforeEdges = buildEdgeMap(snapshotBefore?.edges || []);
  const afterEdges = buildEdgeMap(snapshotAfter?.edges || []);

  const createdNodeIds = [];
  const createdEdgeIds = [];
  const updatedNodeSnapshots = [];
  const archivedNodeSnapshots = [];
  const invalidatedEdgeSnapshots = [];

  for (const [nodeId, afterNode] of afterNodes.entries()) {
    if (!beforeNodes.has(nodeId)) {
      createdNodeIds.push(nodeId);
      continue;
    }

    const beforeNode = beforeNodes.get(nodeId);
    if (!hasMeaningfulNodeChange(beforeNode, afterNode)) continue;
    updatedNodeSnapshots.push(cloneGraphSnapshot(beforeNode));

    if (beforeNode.archived !== afterNode.archived) {
      archivedNodeSnapshots.push(cloneGraphSnapshot(beforeNode));
    }
  }

  for (const [edgeId, afterEdge] of afterEdges.entries()) {
    if (!beforeEdges.has(edgeId)) {
      createdEdgeIds.push(edgeId);
      continue;
    }

    const beforeEdge = beforeEdges.get(edgeId);
    if (!hasMeaningfulEdgeChange(beforeEdge, afterEdge)) continue;
    if (
      beforeEdge.invalidAt !== afterEdge.invalidAt ||
      beforeEdge.expiredAt !== afterEdge.expiredAt
    ) {
      invalidatedEdgeSnapshots.push(cloneGraphSnapshot(beforeEdge));
    }
  }

  return {
    id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    processedRange: meta.processedRange || [-1, -1],
    createdNodeIds,
    createdEdgeIds,
    updatedNodeSnapshots,
    archivedNodeSnapshots,
    invalidatedEdgeSnapshots,
    vectorHashesInserted: Array.isArray(meta.vectorHashesInserted)
      ? [...new Set(meta.vectorHashesInserted)]
      : [],
    postProcessArtifacts: Array.isArray(meta.postProcessArtifacts)
      ? meta.postProcessArtifacts
      : [],
    snapshotBefore,
  };
}

export function appendBatchJournal(graph, entry) {
  normalizeGraphRuntimeState(graph, graph?.historyState?.chatId || "");
  graph.batchJournal.push(entry);
  if (graph.batchJournal.length > BATCH_JOURNAL_LIMIT) {
    graph.batchJournal = graph.batchJournal.slice(-BATCH_JOURNAL_LIMIT);
  }
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

  const journal = journals[affectedIndex];
  if (!journal?.snapshotBefore) return null;

  return {
    affectedIndex,
    journal,
    snapshotBefore: cloneGraphSnapshot(journal.snapshotBefore),
  };
}

export function buildRecoveryResult(status, extra = {}) {
  return {
    status,
    at: Date.now(),
    ...extra,
  };
}
