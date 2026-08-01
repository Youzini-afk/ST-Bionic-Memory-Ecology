export function ensurePanelGraphRenderers({
  GraphRenderer,
  document,
  isMobile = false,
  graphRenderer = null,
  mobileGraphRenderer = null,
  graphOptions = {},
  onNodeSelect = null,
} = {}) {
  const create = (canvas) => {
    if (!canvas || typeof GraphRenderer !== "function") return null;
    const renderer = new GraphRenderer(canvas, graphOptions);
    renderer.onNodeSelect = onNodeSelect;
    return renderer;
  };
  return {
    graphRenderer: !isMobile && !graphRenderer
      ? create(document?.getElementById?.("bme-graph-canvas"))
      : graphRenderer,
    mobileGraphRenderer: isMobile && !mobileGraphRenderer
      ? create(document?.getElementById?.("bme-mobile-graph-canvas"))
      : mobileGraphRenderer,
  };
}
