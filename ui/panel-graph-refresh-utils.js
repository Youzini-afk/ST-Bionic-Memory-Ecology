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
