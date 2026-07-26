export function resolveVisibleGraphWorkspaceMode({
  overlayActive = false,
  isMobile = false,
  currentTabId = "dashboard",
  currentGraphView = "graph",
  currentMobileGraphView = "graph",
} = {}) {
  if (!overlayActive) return "hidden";
  if (isMobile) {
    if (currentTabId !== "graph") return "hidden";
    const mobileView = String(currentMobileGraphView || "graph").trim() || "graph";
    return mobileView === "cognition"
      ? "mobile:cognition"
      : mobileView === "summary"
        ? "mobile:summary"
        : "mobile:graph";
  }
  if (currentTabId === "config") return "hidden";
  const desktopView = String(currentGraphView || "graph").trim() || "graph";
  return desktopView === "cognition"
    ? "desktop:cognition"
    : desktopView === "summary"
      ? "desktop:summary"
      : "desktop:graph";
}

export function buildVisibleGraphRefreshToken({
  visibleMode = "hidden",
  chatId = "",
  loadState = "",
  revision = 0,
  nodeCount = -1,
  edgeCount = -1,
  lastProcessedSeq = -1,
} = {}) {
  const normalizedMode = String(visibleMode || "hidden").trim() || "hidden";
  if (normalizedMode === "hidden") return "hidden";
  const normalizedRevision = Number.isFinite(Number(revision))
    ? Math.trunc(Number(revision))
    : 0;
  const normalizedNodeCount = Number.isFinite(Number(nodeCount))
    ? Math.trunc(Number(nodeCount))
    : -1;
  const normalizedEdgeCount = Number.isFinite(Number(edgeCount))
    ? Math.trunc(Number(edgeCount))
    : -1;
  const normalizedLastProcessedSeq = Number.isFinite(Number(lastProcessedSeq))
    ? Math.trunc(Number(lastProcessedSeq))
    : -1;
  return [
    normalizedMode,
    String(chatId || "").trim(),
    String(loadState || "").trim() || "unknown",
    normalizedRevision,
    normalizedNodeCount,
    normalizedEdgeCount,
    normalizedLastProcessedSeq,
  ].join("|");
}

function graphCollectionToArray(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (collection instanceof Map) return Array.from(collection.values());
  if (typeof collection === "object") return Object.values(collection);
  return [];
}

function normalizeGraphIdentity(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function stableHash(input) {
  const text = String(input || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function hashParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return "0";
  return stableHash(parts.join("\u001f"));
}

function isArchivedNode(node) {
  if (!node || typeof node !== "object") return true;
  return Boolean(node.archived || node.archivedAt);
}

/**
 * Builds a compact, deterministic fingerprint of graph structure.
 *
 * The fingerprint intentionally omits large raw node/edge arrays. It includes
 * only active node ids and active edge identities, sorted before hashing.
 */
export function buildGraphStructureFingerprint(graph) {
  if (!graph) return "empty";

  const activeNodeIds = graphCollectionToArray(graph.nodes)
    .filter((node) => !isArchivedNode(node))
    .map((node) => normalizeGraphIdentity(node?.id ?? node?.nodeId ?? node?.key))
    .filter(Boolean)
    .sort();
  const activeNodeIdSet = new Set(activeNodeIds);

  const activeEdgeIdentities = graphCollectionToArray(graph.edges)
    .filter((edge) => edge && typeof edge === "object")
    .filter((edge) => !edge.invalidAt && !edge.expiredAt)
    .map((edge) => {
      const from = normalizeGraphIdentity(edge.from ?? edge.fromId);
      const to = normalizeGraphIdentity(edge.to ?? edge.toId);
      const relation = normalizeGraphIdentity(edge.relation ?? edge.type);
      if (!from || !to) return "";
      if (!activeNodeIdSet.has(from) || !activeNodeIdSet.has(to)) return "";
      return `${from}>${to}:${relation}`;
    })
    .filter(Boolean)
    .sort();

  return [
    `nodes:${activeNodeIds.length}:${hashParts(activeNodeIds)}`,
    `edges:${activeEdgeIdentities.length}:${hashParts(activeEdgeIdentities)}`,
  ].join("|");
}

export function classifyGraphRefresh({
  previousToken,
  nextToken,
  previousFingerprint,
  nextFingerprint,
  force = false,
  final = false,
  hard = false,
  visibleMode,
} = {}) {
  const normalizedVisibleMode = String(visibleMode || "").trim();
  const normalizedNextToken = String(nextToken || "").trim();
  const tokenChanged = previousToken !== nextToken;
  const structureChanged = previousFingerprint !== nextFingerprint;
  const forced = Boolean(force);
  const isFinal = Boolean(final);
  const isHard = Boolean(hard);

  const base = {
    tokenChanged,
    structureChanged,
    force: forced,
    final: isFinal,
    hard: isHard,
  };

  if (normalizedVisibleMode === "hidden" || normalizedNextToken === "hidden") {
    return { ...base, action: "hidden", reason: "hidden" };
  }
  if (isHard) return { ...base, action: "hard-refresh", reason: "hard" };
  if (isFinal) return { ...base, action: "final-refresh", reason: "final" };
  if (structureChanged) {
    return { ...base, action: "refresh", reason: "structure-changed" };
  }
  if (forced) return { ...base, action: "refresh", reason: "force" };
  if (tokenChanged) {
    return { ...base, action: "highlight-only", reason: "token-changed" };
  }
  return { ...base, action: "skip", reason: "unchanged" };
}

export function createGraphRefreshGovernor(options = {}) {
  const liveThrottleMs = Number.isFinite(Number(options.liveThrottleMs))
    ? Math.max(0, Number(options.liveThrottleMs))
    : 240;
  const extractionThrottleMs = Number.isFinite(Number(options.extractionThrottleMs))
    ? Math.max(0, Number(options.extractionThrottleMs))
    : 700;
  const layoutRestartWindowMs = Number.isFinite(Number(options.layoutRestartWindowMs))
    ? Math.max(0, Number(options.layoutRestartWindowMs))
    : 5000;
  const layoutRestartMax = Number.isFinite(Number(options.layoutRestartMax))
    ? Math.max(0, Math.trunc(Number(options.layoutRestartMax)))
    : 2;
  const layoutCooldownMs = Number.isFinite(Number(options.layoutCooldownMs))
    ? Math.max(0, Number(options.layoutCooldownMs))
    : 9000;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  const initialState = () => ({
    lastToken: undefined,
    lastFingerprint: undefined,
    lastRefreshAt: 0,
    coalescedCount: 0,
    cooldownUntil: 0,
    layoutStarts: [],
  });
  let state = initialState();

  function getCurrentTime(input = {}) {
    return Number.isFinite(Number(input.now)) ? Number(input.now) : Number(now());
  }

  function getState() {
    return {
      ...state,
      layoutStarts: [...state.layoutStarts],
    };
  }

  function reset() {
    state = initialState();
  }

  function noteRefresh(input = {}) {
    const timestamp = getCurrentTime(input);
    const classification = classifyGraphRefresh({
      previousToken: input.previousToken ?? state.lastToken,
      nextToken: input.nextToken,
      previousFingerprint: input.previousFingerprint ?? state.lastFingerprint,
      nextFingerprint: input.nextFingerprint,
      force: input.force,
      final: input.final,
      hard: input.hard,
      visibleMode: input.visibleMode,
    });
    const shouldRefresh = !["hidden", "skip"].includes(classification.action);
    const shouldLayout = ["refresh", "hard-refresh", "final-refresh"].includes(
      classification.action,
    );
    const delayMs = shouldRefresh
      ? (input.isExtracting ? extractionThrottleMs : liveThrottleMs)
      : 0;

    state.lastToken = input.nextToken;
    state.lastFingerprint = input.nextFingerprint;
    if (shouldRefresh) {
      state.lastRefreshAt = timestamp;
      state.coalescedCount = delayMs > 0 ? state.coalescedCount + 1 : 0;
    } else if (classification.action === "skip") {
      state.coalescedCount = 0;
    }

    return {
      shouldRefresh,
      shouldLayout,
      action: classification.action,
      delayMs,
      reason: classification.reason,
      coalescedCount: state.coalescedCount,
      cooldownUntil: state.cooldownUntil,
    };
  }

  function canStartLayout(input = {}) {
    const timestamp = getCurrentTime(input);
    if (timestamp < state.cooldownUntil) {
      return {
        allowed: false,
        reason: "cooldown",
        cooldownUntil: state.cooldownUntil,
      };
    }

    state.layoutStarts = state.layoutStarts.filter(
      (startedAt) => timestamp - startedAt < layoutRestartWindowMs,
    );

    if (state.layoutStarts.length >= layoutRestartMax) {
      state.cooldownUntil = timestamp + layoutCooldownMs;
      return {
        allowed: false,
        reason: "budget-exhausted",
        cooldownUntil: state.cooldownUntil,
      };
    }

    state.layoutStarts.push(timestamp);
    return {
      allowed: true,
      reason: "allowed",
      cooldownUntil: state.cooldownUntil,
    };
  }

  return { getState, reset, noteRefresh, canStartLayout };
}
