import { normalizeHostLineage } from "./host-transaction-context.js";

function normalizeIdentifier(value = "") {
  return String(value ?? "").trim();
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
