import { cloneGraphForPersistence } from "../graph/graph-persistence.js";
import { normalizeHostLineage } from "./host-transaction-context.js";
import { normalizeGraphRuntimeState } from "./runtime-state.js";

function normalizeIdentifier(value = "") {
  return String(value ?? "").trim();
}

function getNodeBranchCutoffSeq(node = null) {
  if (!node || typeof node !== "object") return -1;
  if (Array.isArray(node.seqRange) && Number.isFinite(Number(node.seqRange[1]))) {
    return Number(node.seqRange[1]);
  }
  return Number.isFinite(Number(node.seq)) ? Number(node.seq) : -1;
}

function pruneProcessedMessageRecordsFromFloor(graph = null, fromFloor = NaN) {
  const records = graph?.historyState?.processedMessageHashes;
  if (!records || !Number.isFinite(Number(fromFloor))) return;
  for (const key of Object.keys(records)) {
    if (Number(key) >= Number(fromFloor)) delete records[key];
  }
}

export function deriveBranchGraphFromSourceGraph(
  sourceGraph = null,
  {
    targetChatId = "",
    cutoffFloor = null,
    assistantMessageCount = null,
  } = {},
) {
  if (!sourceGraph) return null;
  const nextChatId =
    normalizeIdentifier(targetChatId) ||
    normalizeIdentifier(sourceGraph?.historyState?.chatId);
  const branchGraph = cloneGraphForPersistence(sourceGraph, nextChatId);

  const safeCutoff =
    Number.isFinite(Number(cutoffFloor)) && Number(cutoffFloor) >= 0
      ? Math.floor(Number(cutoffFloor))
      : null;
  if (safeCutoff != null) {
    const allowedNodeIds = new Set(
      (Array.isArray(branchGraph.nodes) ? branchGraph.nodes : [])
        .filter((node) => {
          const nodeCutoffSeq = getNodeBranchCutoffSeq(node);
          return nodeCutoffSeq < 0 || nodeCutoffSeq <= safeCutoff;
        })
        .map((node) => String(node.id || "")),
    );

    branchGraph.nodes = (Array.isArray(branchGraph.nodes) ? branchGraph.nodes : []).filter(
      (node) => allowedNodeIds.has(String(node.id || "")),
    );
    branchGraph.edges = (Array.isArray(branchGraph.edges) ? branchGraph.edges : []).filter(
      (edge) =>
        allowedNodeIds.has(String(edge?.fromId || "")) &&
        allowedNodeIds.has(String(edge?.toId || "")),
    );
    branchGraph.batchJournal = (Array.isArray(branchGraph.batchJournal)
      ? branchGraph.batchJournal
      : []
    ).filter((journal) => {
      const rangeEnd = Number(journal?.processedRange?.[1]);
      return !Number.isFinite(rangeEnd) || rangeEnd <= safeCutoff;
    });

    const summaryEntries = Array.isArray(branchGraph.summaryState?.entries)
      ? branchGraph.summaryState.entries
      : [];
    branchGraph.summaryState.entries = summaryEntries.filter((entry) => {
      const messageRangeEnd = Number(entry?.messageRange?.[1]);
      return !Number.isFinite(messageRangeEnd) || messageRangeEnd <= safeCutoff;
    });
    branchGraph.summaryState.activeEntryIds = (branchGraph.summaryState.activeEntryIds || [])
      .filter((entryId) =>
        branchGraph.summaryState.entries.some((entry) => entry.id === entryId),
      );
    branchGraph.summaryState.lastSummarizedAssistantFloor = Math.max(
      -1,
      ...branchGraph.summaryState.entries.map((entry) =>
        Number.isFinite(Number(entry?.messageRange?.[1]))
          ? Number(entry.messageRange[1])
          : -1,
      ),
    );

    pruneProcessedMessageRecordsFromFloor(branchGraph, safeCutoff + 1);
    branchGraph.historyState.lastProcessedAssistantFloor = Math.min(
      Number(branchGraph.historyState.lastProcessedAssistantFloor ?? safeCutoff),
      safeCutoff,
    );
    if (
      Array.isArray(branchGraph.historyState?.lastBatchStatus?.processedRange) &&
      Number(branchGraph.historyState.lastBatchStatus.processedRange[1]) > safeCutoff
    ) {
      branchGraph.historyState.lastBatchStatus = null;
    }
  }

  const extractionCountCeiling =
    Number.isFinite(Number(assistantMessageCount)) && Number(assistantMessageCount) >= 0
      ? Math.floor(Number(assistantMessageCount))
      : Number.isFinite(Number(branchGraph.historyState.extractionCount))
        ? Number(branchGraph.historyState.extractionCount)
        : 0;
  branchGraph.historyState.chatId = nextChatId;
  branchGraph.historyState.extractionCount = Math.max(
    0,
    Math.min(
      Number(branchGraph.historyState.extractionCount || 0),
      extractionCountCeiling,
    ),
  );
  branchGraph.historyState.lastRecoveryResult = null;
  branchGraph.historyState.lastBatchStatus = null;
  branchGraph.historyState.historyDirtyFrom = null;
  branchGraph.historyState.lastMutationSource = "chat-branch-created";
  branchGraph.historyState.lastMutationReason = "chat-branch-created";
  branchGraph.lastRecallResult = null;
  return normalizeGraphRuntimeState(branchGraph, nextChatId);
}

export function getHostBranchParentLineage(identity = null) {
  const lineage = normalizeHostLineage(identity?.hostLineage);
  if (!lineage?.parentConversationId) return null;
  return {
    conversationId: lineage.parentConversationId,
    branchId: lineage.parentBranchId,
    hostRevision: Number(lineage.parentRevision || 0),
  };
}

export function isSameHostLineage(left = null, right = null) {
  const a = normalizeHostLineage(left);
  const b = normalizeHostLineage(right);
  return Boolean(
    a &&
      b &&
      a.conversationId === b.conversationId &&
      a.branchId === b.branchId,
  );
}

export async function inheritHostBranchGraph({
  identity = null,
  currentChat = [],
  sourceGraph = null,
  isSourceGraphCompatible = () => false,
  isTargetEmpty = null,
  loadSourceGraph = null,
  deriveBranchGraph = null,
  persistBranchGraph = null,
  rememberIdentityAlias = null,
  isCurrent = () => true,
} = {}) {
  const lineage = normalizeHostLineage(identity?.hostLineage);
  const parentLineage = getHostBranchParentLineage(identity);
  const targetChatId = normalizeIdentifier(identity?.chatId);
  const sourceChatId = normalizeIdentifier(identity?.parentPersistenceChatId);
  if (!lineage || !parentLineage || !targetChatId || !sourceChatId) {
    return { inherited: false, skipped: true, reason: "not-host-branch" };
  }
  if (
    typeof isTargetEmpty !== "function" ||
    typeof loadSourceGraph !== "function" ||
    typeof deriveBranchGraph !== "function" ||
    typeof persistBranchGraph !== "function"
  ) {
    throw new TypeError("Host branch inheritance requires storage and graph adapters");
  }
  if (!isCurrent()) {
    return { inherited: false, skipped: true, reason: "stale-host-branch" };
  }

  const targetEmpty = await isTargetEmpty(targetChatId);
  if (!targetEmpty) {
    await rememberIdentityAlias?.(targetChatId, lineage);
    return {
      inherited: false,
      skipped: true,
      reason: "target-already-initialized",
      targetChatId,
      sourceChatId,
    };
  }

  let effectiveSourceGraph = sourceGraph;
  if (!isSourceGraphCompatible(effectiveSourceGraph, sourceChatId, parentLineage)) {
    effectiveSourceGraph = await loadSourceGraph(sourceChatId, parentLineage);
  }
  if (!effectiveSourceGraph) {
    return {
      inherited: false,
      skipped: true,
      reason: "parent-graph-unavailable",
      targetChatId,
      sourceChatId,
    };
  }
  if (!isCurrent()) {
    return { inherited: false, skipped: true, reason: "stale-host-branch" };
  }

  const chat = Array.isArray(currentChat) ? currentChat : [];
  const cutoffFloor = chat.length > 0 ? chat.length - 1 : null;
  const assistantMessageCount = chat.filter(
    (message) => message && message.is_user !== true && message.is_system !== true,
  ).length;
  const branchGraph = deriveBranchGraph(effectiveSourceGraph, {
    targetChatId,
    cutoffFloor,
    assistantMessageCount,
  });
  if (!branchGraph) {
    return {
      inherited: false,
      skipped: true,
      reason: "branch-derivation-failed",
      targetChatId,
      sourceChatId,
    };
  }
  branchGraph.historyState ||= {};
  branchGraph.historyState.hostLineage = lineage;

  if (!isCurrent()) {
    return { inherited: false, skipped: true, reason: "stale-host-branch" };
  }
  const persistence = await persistBranchGraph(branchGraph, {
    targetChatId,
    sourceChatId,
    lineage,
    parentLineage,
    cutoffFloor,
    assistantMessageCount,
  });
  if (persistence?.accepted === false || persistence?.saved === false) {
    return {
      inherited: false,
      skipped: false,
      reason: persistence?.reason || "branch-persist-rejected",
      targetChatId,
      sourceChatId,
      persistence,
    };
  }
  const stillCurrent = isCurrent();
  await rememberIdentityAlias?.(targetChatId, lineage, {
    branchGraph,
    persistence,
    stillCurrent,
  });
  return {
    inherited: true,
    skipped: false,
    reason: "host-branch-inherited",
    targetChatId,
    sourceChatId,
    cutoffFloor,
    assistantMessageCount,
    persistence,
    stillCurrent,
  };
}
