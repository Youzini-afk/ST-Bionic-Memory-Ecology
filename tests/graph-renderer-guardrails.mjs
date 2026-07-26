import assert from "node:assert/strict";

globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
let mockNow = 1000;
globalThis.performance = { now: () => mockNow };
let rafId = 0;
const rafCallbacks = new Map();
let timerId = 0;
const timerCallbacks = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = ++rafId;
  rafCallbacks.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafCallbacks.delete(id);
};
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++timerId;
  timerCallbacks.set(id, { callback, dueAt: mockNow + Math.max(0, Number(delay) || 0) });
  return id;
};
globalThis.clearTimeout = (id) => {
  timerCallbacks.delete(id);
};
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  disconnect() {}
};

const canvasMockStats = {
  radialGradientCalls: 0,
  linearGradientCalls: 0,
  strokeCalls: 0,
  fillTextCalls: 0,
  shadowBlurValues: [],
  arcRadii: [],
};

function flushNextRaf(ms = 16) {
  const [id, callback] = rafCallbacks.entries().next().value || [];
  if (!id) return false;
  rafCallbacks.delete(id);
  mockNow += ms;
  callback(mockNow);
  return true;
}

function flushRafsUntilIdle({ maxFrames = 80, ms = 16 } = {}) {
  let frames = 0;
  while (flushNextRaf(ms)) {
    frames += 1;
    assert.ok(frames <= maxFrames, `RAF loop exceeded ${maxFrames} frames`);
  }
  return frames;
}

function assertNoPendingRafOrTimers(reason) {
  assert.equal(rafCallbacks.size, 0, `${reason}: pending RAF callbacks remain`);
  assert.equal(timerCallbacks.size, 0, `${reason}: pending timers remain`);
}

function advanceMockTime(ms = 0) {
  mockNow += ms;
  let ran = false;
  for (const [id, timer] of [...timerCallbacks.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)) {
    if (timer.dueAt <= mockNow) {
      timerCallbacks.delete(id);
      timer.callback();
      ran = true;
    }
  }
  return ran;
}

function createNoopContext() {
  const noop = () => {};
  return {
    setTransform: noop,
    clearRect: noop,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    beginPath: noop,
    arc: (_x, _y, radius) => {
      canvasMockStats.arcRadii.push(Number(radius) || 0);
    },
    arcTo: noop,
    fill: noop,
    stroke: () => {
      canvasMockStats.strokeCalls += 1;
    },
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    fillText: () => {
      canvasMockStats.fillTextCalls += 1;
    },
    closePath: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    measureText: (text = "") => ({ width: String(text).length * 6 }),
    createRadialGradient: () => {
      canvasMockStats.radialGradientCalls += 1;
      return { addColorStop: noop };
    },
    createLinearGradient: () => {
      canvasMockStats.linearGradientCalls += 1;
      return { addColorStop: noop };
    },
    set fillStyle(_value) {},
    set strokeStyle(_value) {},
    set lineWidth(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
    set textBaseline(_value) {},
    set globalAlpha(_value) {},
    set lineCap(_value) {},
    set lineJoin(_value) {},
    set shadowColor(_value) {},
    set shadowBlur(value) {
      canvasMockStats.shadowBlurValues.push(Number(value) || 0);
    },
  };
}

function createCanvas() {
  return {
    parentElement: { clientWidth: 640, clientHeight: 360 },
    width: 0,
    height: 0,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    getContext: (type) => (type === "2d" ? createNoopContext() : null),
  };
}

function createGraphFixture() {
  return {
    nodes: [
      { id: "objective-1", type: "event", name: "Objective", importance: 6, scope: { layer: "objective" } },
      { id: "user-1", type: "concept", name: "User POV", importance: 5, scope: { layer: "pov", ownerType: "user", ownerName: "Host" } },
      { id: "char-1", type: "character", name: "Character POV", importance: 7, scope: { layer: "pov", ownerType: "character", ownerName: "Alice" } },
      { id: "archived-1", type: "event", name: "Archived", archived: true, scope: { layer: "objective" } },
    ],
    edges: [
      { fromId: "objective-1", toId: "user-1", relation: "related", strength: 0.7 },
      { fromId: "user-1", toId: "char-1", relation: "related", strength: 0.6 },
      { fromId: "objective-1", toId: "missing-node", relation: "invalid-target" },
      { fromId: "objective-1", toId: "char-1", relation: "invalidated", invalidAt: "2026-01-01T00:00:00.000Z" },
      { fromId: "char-1", toId: "user-1", relation: "expired", expiredAt: "2026-01-02T00:00:00.000Z" },
      { fromId: "archived-1", toId: "objective-1", relation: "archived-edge" },
    ],
  };
}

function createStarSeedGraph({ includeFragment = false } = {}) {
  const graph = {
    nodes: [
      { id: "star-core", type: "character", name: "Core", importance: 10, scope: { layer: "objective" } },
      { id: "star-topic", type: "event", name: "Topic", importance: 7, scope: { layer: "objective" } },
      { id: "star-topic-2", type: "thread", name: "Topic 2", importance: 6, scope: { layer: "objective" } },
    ],
    edges: [
      { fromId: "star-core", toId: "star-topic", relation: "related", strength: 0.9 },
      { fromId: "star-core", toId: "star-topic-2", relation: "related", strength: 0.7 },
    ],
  };
  if (includeFragment) {
    graph.nodes.push({
      id: "star-fragment",
      type: "concept",
      name: "Fragment",
      importance: 2,
      scope: { layer: "objective" },
    });
    graph.edges.push({ fromId: "star-topic", toId: "star-fragment", relation: "related", strength: 0.95 });
  }
  return graph;
}

function createLabelBudgetGraph(count = 12) {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push({
      id: `label-${i}`,
      type: i % 3 === 0 ? "character" : (i % 3 === 1 ? "event" : "reflection"),
      name: `Label Node ${i}`,
      importance: count - i,
      scope: { layer: "objective" },
    });
    if (i > 0) {
      edges.push({ fromId: "label-0", toId: `label-${i}`, relation: "related", strength: 0.5 });
    }
  }
  return { nodes, edges };
}

function assertInputUnchanged(graph, beforeJson) {
  assert.equal(JSON.stringify(graph), beforeJson);
  for (const node of graph.nodes) {
    for (const key of ["x", "y", "regionKey", "diagnostics", "highlight"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(node, key), false, `${node.id} gained ${key}`);
    }
  }
}

function resetCanvasStats() {
  canvasMockStats.radialGradientCalls = 0;
  canvasMockStats.linearGradientCalls = 0;
  canvasMockStats.strokeCalls = 0;
  canvasMockStats.fillTextCalls = 0;
  canvasMockStats.shadowBlurValues = [];
  canvasMockStats.arcRadii = [];
}

function assertRendererNodesInsideRegions(renderer) {
  for (const node of renderer.nodes) {
    assert.equal(Number.isFinite(node.x), true, `${node.id} x is finite`);
    assert.equal(Number.isFinite(node.y), true, `${node.id} y is finite`);
    assert.ok(node.regionRect, `${node.id} has regionRect`);
    const r = node.regionRect;
    assert.ok(node.x >= r.x - 0.001 && node.x <= r.x + r.w + 0.001, `${node.id} x inside region`);
    assert.ok(node.y >= r.y - 0.001 && node.y <= r.y + r.h + 0.001, `${node.id} y inside region`);
  }
}

function createAnimatedLayoutRenderer({ reducedMotion = false, configOff = false } = {}) {
  const previousMatchMedia = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => ({
    matches: Boolean(reducedMotion),
    addEventListener() {},
    removeEventListener() {},
  });
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: {
      graphUseNativeLayout: false,
      graphNativeForceDisable: true,
      graphAnimatedLayout: !configOff,
      graphLayoutAnimation: !configOff,
      graphLayoutAnimationEnabled: !configOff,
    },
    layoutConfig: {
      neuralIterations: 24,
      animatedLayout: !configOff,
      layoutAnimation: !configOff,
      layoutAnimationEnabled: !configOff,
      layoutAnimationDurationMs: 64,
      layoutAnimationMaxFrames: 8,
      layoutAnimationIterationsPerFrame: 3,
      layoutAnimationMinInitialIterations: 4,
    },
  });
  return {
    renderer,
    restoreMatchMedia: () => {
      globalThis.window.matchMedia = previousMatchMedia;
    },
  };
}

function readLayoutAnimationDiagnostics(renderer) {
  const diagnostics = renderer.getLastLayoutDiagnostics?.() || null;
  const animationDiagnostics = diagnostics?.layoutAnimation
    ?? diagnostics?.layoutAnimationDiagnostics
    ?? diagnostics?.animation
    ?? null;
  return { diagnostics, animationDiagnostics };
}

function assertLayoutAnimationNotRunning(renderer, reason) {
  const { diagnostics, animationDiagnostics } = readLayoutAnimationDiagnostics(renderer);
  if (!animationDiagnostics || typeof animationDiagnostics !== "object") return;
  const mode = animationDiagnostics.mode ?? diagnostics?.layoutAnimationMode;
  const status = animationDiagnostics.status ?? diagnostics?.layoutAnimationStatus;
  if (mode != null) assert.equal(typeof mode, "string", `${reason}: layout animation mode is string`);
  if (status != null) assert.equal(typeof status, "string", `${reason}: layout animation status is string`);
  assert.notEqual(status, "running", `${reason}: layout animation is not running`);
  assert.notEqual(status, "scheduled", `${reason}: layout animation is not scheduled`);
}

function assertLayoutAnimationDiagnosticsShape(renderer) {
  const { diagnostics, animationDiagnostics } = readLayoutAnimationDiagnostics(renderer);
  assert.ok(diagnostics, "layout diagnostics exist");
  if (!animationDiagnostics || typeof animationDiagnostics !== "object") return;
  const mode = animationDiagnostics.mode ?? diagnostics.layoutAnimationMode;
  const status = animationDiagnostics.status ?? diagnostics.layoutAnimationStatus;
  if (mode != null) assert.equal(typeof mode, "string");
  if (status != null) assert.equal(typeof status, "string");
  if (animationDiagnostics.reducedMotion != null) {
    assert.equal(typeof animationDiagnostics.reducedMotion, "boolean");
  }
  if (animationDiagnostics.frameCount != null) {
    assert.equal(Number.isFinite(Number(animationDiagnostics.frameCount)), true);
  }
}

const { GraphRenderer } = await import("../ui/graph-renderer.js");
const { setLocale } = await import("../i18n/index.js");

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  assertInputUnchanged(graph, before);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  const diagnostics = renderer.getLastLayoutDiagnostics();
  assert.ok(diagnostics);
  assert.equal(diagnostics.rawNodeCount, 4);
  assert.equal(diagnostics.archivedNodeCount, 1);
  assert.equal(diagnostics.activeNodeCount, 3);
  assert.equal(diagnostics.visibleNodeCount, 3);
  assert.equal(diagnostics.nodeCount, 3);
  assert.equal(diagnostics.rawEdgeCount, 6);
  assert.equal(diagnostics.skippedEdgeCount, 4);
  assert.equal(diagnostics.activeEdgeCount, 2);
  assert.equal(diagnostics.visibleEdgeCount, 2);
  assert.equal(diagnostics.edgeCount, 2);
  assert.equal(diagnostics.objectiveNodeCount, 1);
  assert.equal(diagnostics.userPovNodeCount, 1);
  assert.equal(diagnostics.characterPovNodeCount, 1);
  assert.equal(diagnostics.characterPovPanelCount, 1);
  assert.equal(diagnostics.sampled, false);
  assert.equal(diagnostics.capped, false);
  assert.equal(diagnostics.renderOnly, true);
  assert.equal(Number.isFinite(diagnostics.totalMs), true);
  assert.ok(["js-main", "skipped"].includes(diagnostics.mode));
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });
  renderer.setTheme("paperDawn");
  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  const charPanel = renderer._regionPanels.find((panel) => String(panel.key || "").startsWith("char:"));
  assert.ok(charPanel, "character panel exists for label i18n test");

  setLocale("en-US");
  assert.equal(renderer._formatRegionPanelLabel(charPanel), "Character POV · Alice");
  const objectivePanel = renderer._regionPanels.find((panel) => panel.key === "objective");
  assert.equal(renderer._formatRegionPanelLabel(objectivePanel), "Objective Layer");

  setLocale("zh-CN");
  assert.equal(renderer._formatRegionPanelLabel(objectivePanel), "客观层");
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.setEnabled(false);
  assert.doesNotThrow(() => renderer.loadGraph(graph));
  assertInputUnchanged(graph, before);
  const diagnostics = renderer.getLastLayoutDiagnostics();
  assert.ok(diagnostics);
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.renderOnly, true);
  assert.equal(diagnostics.reason, "disabled");
  assert.equal(diagnostics.mode, "skipped");
  assert.equal(diagnostics.rawNodeCount, 4);
  assert.equal(diagnostics.rawEdgeCount, 6);
  assert.equal(diagnostics.activeNodeCount, 3);
  assert.equal(diagnostics.activeEdgeCount, 2);
  assert.equal(diagnostics.archivedNodeCount, 1);
  assert.equal(diagnostics.skippedEdgeCount, 4);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: {
      minNodeRadius: 4,
      maxNodeRadius: 14,
      neuralIterations: 8,
    },
  });

  const radius = renderer._nodeRadius({ type: "character", importance: 10 });
  const visualRadius = renderer._nodeVisualRadius({ type: "character", importance: 10 });
  assert.equal(radius, 14);
  assert.ok(visualRadius <= 8, "visual radius stays small and crisp");
  assert.ok(visualRadius < radius, "visual radius does not affect layout/collision radius");
  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.highlightNode("char-1");
  assertInputUnchanged(graph, before);
  assert.equal(canvasMockStats.radialGradientCalls, 0, "graph background should stay flat without blurred radial blobs");
  assert.equal(
    Math.max(0, ...canvasMockStats.shadowBlurValues),
    0,
    "node visuals should not reintroduce heavy crystal-ball shadow blur",
  );
  renderer.destroy();
}

{
  resetCanvasStats();
  const graph = createLabelBudgetGraph(12);
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph);
  assertInputUnchanged(graph, before);
  assert.ok(
    canvasMockStats.fillTextCalls <= 7,
    "galaxy mode limits default dark-theme labels to a small core budget",
  );
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    theme: "paperDawn",
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  assert.doesNotThrow(() => renderer.loadGraph(graph, { userPovAliases: ["Host"] }));
  renderer.highlightNode("objective-1");
  assertInputUnchanged(graph, before);
  renderer.destroy();
}

{
  resetCanvasStats();
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.setTransientHighlights({
    recallNodeIds: ["objective-1", { nodeId: "user-1" }],
    extractedNodeIds: [{ id: "char-1" }, "objective-1"],
    ttlMs: 80,
    reason: "test",
  });
  assertInputUnchanged(graph, before);
  let diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 3);
  assert.equal(diagnostics.activeCount, 3);
  assert.equal(diagnostics.reducedMotion, false);
  assert.ok(flushNextRaf());
  assert.equal(canvasMockStats.radialGradientCalls, 0, "transient highlights should not reintroduce blurred radial blobs");
  assert.ok(canvasMockStats.strokeCalls > 0);
  assert.ok(
    Math.max(0, ...canvasMockStats.arcRadii) <= 18,
    "transient recall/extraction highlights stay close to node body, not large crystal-ball rings",
  );
  diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 3);
  mockNow += 120;
  diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.animationScheduled, false);
  renderer.destroy();
}

{
  const graph = createGraphFixture();
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.setTransientHighlights({ recallNodeIds: ["objective-1"], ttlMs: 1000 });
  assert.equal(renderer.getTransientHighlightDiagnostics().count, 1);
  renderer.setEnabled(false);
  const diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.animationScheduled, false);
  renderer.destroy();
}

{
  const previousMatchMedia = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const graph = createGraphFixture();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  resetCanvasStats();
  renderer.setTransientHighlights({ recallNodeIds: ["objective-1"], ttlMs: 1000 });
  flushNextRaf();
  let diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.reducedMotion, true);
  assert.equal(diagnostics.count, 1);
  assert.equal(diagnostics.animationScheduled, false);
  assert.equal(diagnostics.expiryScheduled, true);
  assert.ok(canvasMockStats.strokeCalls > 0);
  advanceMockTime(1002);
  assert.ok(flushNextRaf());
  diagnostics = renderer.getTransientHighlightDiagnostics();
  assert.equal(diagnostics.count, 0);
  assert.equal(diagnostics.animationScheduled, false);
  assert.equal(diagnostics.expiryScheduled, false);
  assertInputUnchanged(graph, before);
  renderer.destroy();
  globalThis.window.matchMedia = previousMatchMedia;
}

{
  const graph = createStarSeedGraph();
  const before = JSON.stringify(graph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  assertInputUnchanged(graph, before);
  assertRendererNodesInsideRegions(renderer);
  let diagnostics = renderer.getLastLayoutDiagnostics();
  assert.equal(diagnostics.layoutSeedModeCounts.core, 1);
  assert.equal(diagnostics.layoutSeedModeCounts.topic, 2);
  assert.equal(diagnostics.layoutSeedModeCounts.reused, 0);

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  assertInputUnchanged(graph, before);
  assertRendererNodesInsideRegions(renderer);
  diagnostics = renderer.getLastLayoutDiagnostics();
  assert.equal(diagnostics.layoutReuseCount, diagnostics.visibleNodeCount);
  assert.equal(diagnostics.layoutSeedModeCounts.reused, diagnostics.visibleNodeCount);
  renderer.destroy();
}

{
  const initialGraph = createStarSeedGraph();
  const nextGraph = createStarSeedGraph({ includeFragment: true });
  const before = JSON.stringify(nextGraph);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(initialGraph, { userPovAliases: ["Host"] });
  renderer.loadGraph(nextGraph, { userPovAliases: ["Host"] });
  assertInputUnchanged(nextGraph, before);
  assertRendererNodesInsideRegions(renderer);
  const diagnostics = renderer.getLastLayoutDiagnostics();
  assert.equal(diagnostics.layoutSeedModeCounts.anchoredFragment, 1);
  assert.equal(diagnostics.layoutSeedModeCounts.fallbackFragment, 0);
  assert.equal(diagnostics.layoutSeedModeCounts.reused, 3);
  renderer.destroy();
}

{
  const graph = createStarSeedGraph({ includeFragment: true });
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: {
      neuralIterations: 8,
      cameraFocusDurationMs: 120,
    },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.highlightNode("star-core");
  renderer.destroy();
  assertNoPendingRafOrTimers("destroy cancels unsettled camera focus animation");
}

{
  const graph = createStarSeedGraph({ includeFragment: true });
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: {
      neuralIterations: 8,
      cameraFocusDurationMs: 32,
    },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.highlightNode("star-core");
  const frames = flushRafsUntilIdle({ maxFrames: 10, ms: 16 });
  assert.ok(frames > 0, "camera focus uses bounded RAF animation");
  assert.ok(renderer.scale >= 1, "camera focus does not zoom out selected node");
  assertNoPendingRafOrTimers("camera focus animation settles");
  renderer.destroy();
}

{
  const graph = createStarSeedGraph({ includeFragment: true });
  const selections = [];
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: {
      neuralIterations: 8,
      cameraFocusDurationMs: 32,
    },
    onNodeSelect: (node) => selections.push(node?.id || null),
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.highlightNode("star-core");
  flushRafsUntilIdle({ maxFrames: 10, ms: 16 });
  assert.equal(renderer.selectedNode?.id, "star-core");
  assert.ok(renderer.scale > 1, "selected node focus zooms in before overview reset");
  renderer._onMouseDown({ clientX: 639, clientY: 359 });
  renderer._onMouseUp();
  assert.equal(renderer.selectedNode, null, "blank click clears selected node focus");
  assert.equal(selections.at(-1), null, "blank click notifies panel to close node detail");
  flushRafsUntilIdle({ maxFrames: 10, ms: 16 });
  assert.equal(Math.round(renderer.scale * 100) / 100, 1, "blank click returns camera scale to overview");
  assert.equal(Math.round(renderer.offsetX), 0, "blank click returns camera x offset to overview");
  assert.equal(Math.round(renderer.offsetY), 0, "blank click returns camera y offset to overview");
  advanceMockTime(200);
  flushRafsUntilIdle({ maxFrames: 5, ms: 16 });
  assertNoPendingRafOrTimers("blank click overview animation settles");
  renderer.destroy();
}

{
  const graph = createStarSeedGraph({ includeFragment: true });
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  renderer.zoomIn();
  assert.ok(timerCallbacks.size > 0, "edge dim restore timer is scheduled while moving/zooming");
  renderer.setEnabled(false);
  assertNoPendingRafOrTimers("disable clears edge dim restore timer");
  renderer.destroy();
}

{
  const graph = createStarSeedGraph({ includeFragment: true });
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: { graphUseNativeLayout: false, graphNativeForceDisable: true },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  const darkObjectivePanel = renderer._regionPanels.find((panel) => panel.key === "objective");
  renderer.setTheme("paperDawn");
  const lightObjectivePanel = renderer._regionPanels.find((panel) => panel.key === "objective");
  assert.ok(darkObjectivePanel && lightObjectivePanel, "theme switch keeps objective panel metadata");
  assert.equal(
    Math.round(darkObjectivePanel.w),
    Math.round(lightObjectivePanel.w),
    "dark/light theme switch keeps the same galaxy layout regions",
  );
  renderer.destroy();
}

{
  const graph = createLabelBudgetGraph(18);
  const renderer = new GraphRenderer(createCanvas(), {
    runtimeConfig: {
      graphUseNativeLayout: true,
      graphNativeForceDisable: false,
      graphNativeLayoutThresholdNodes: 1,
      graphNativeLayoutThresholdEdges: 1,
    },
    layoutConfig: { neuralIterations: 8 },
  });

  renderer.loadGraph(graph, { userPovAliases: ["Host"] });
  const diagnostics = renderer.getLastLayoutDiagnostics();
  assert.notEqual(diagnostics.mode, "native-worker", "galaxy mode disables native layout until cross-region spring parity exists");
  renderer.destroy();
}

{
  const { renderer, restoreMatchMedia } = createAnimatedLayoutRenderer({ reducedMotion: true });
  try {
    renderer.loadGraph(createStarSeedGraph({ includeFragment: true }), { userPovAliases: ["Host"] });
    assertLayoutAnimationNotRunning(renderer, "reduced motion disables animated layout");
    assertNoPendingRafOrTimers("reduced motion animated layout disabled");
  } finally {
    renderer.destroy();
    restoreMatchMedia();
  }
}

{
  const { renderer, restoreMatchMedia } = createAnimatedLayoutRenderer({ configOff: true });
  try {
    renderer.loadGraph(createStarSeedGraph({ includeFragment: true }), { userPovAliases: ["Host"] });
    assertLayoutAnimationNotRunning(renderer, "config off disables animated layout");
    assertNoPendingRafOrTimers("config off animated layout disabled");
  } finally {
    renderer.destroy();
    restoreMatchMedia();
  }
}

{
  const { renderer, restoreMatchMedia } = createAnimatedLayoutRenderer();
  try {
    renderer.loadGraph(createStarSeedGraph(), { userPovAliases: ["Host"] });
    renderer.loadGraph(createStarSeedGraph({ includeFragment: true }), { userPovAliases: ["Host"] });
    renderer.setEnabled(false);
    assertLayoutAnimationNotRunning(renderer, "disable cancels animated layout");
    assertNoPendingRafOrTimers("disable cancels animated layout callbacks");
  } finally {
    renderer.destroy();
    restoreMatchMedia();
  }
}

{
  const { renderer, restoreMatchMedia } = createAnimatedLayoutRenderer();
  try {
    renderer.loadGraph(createStarSeedGraph(), { userPovAliases: ["Host"] });
    renderer.loadGraph(createStarSeedGraph({ includeFragment: true }), { userPovAliases: ["Host"] });
    renderer.destroy();
    assertLayoutAnimationNotRunning(renderer, "destroy cancels animated layout");
    assertNoPendingRafOrTimers("destroy cancels animated layout callbacks");
  } finally {
    restoreMatchMedia();
  }
}

{
  const { renderer, restoreMatchMedia } = createAnimatedLayoutRenderer();
  try {
    renderer.loadGraph(createStarSeedGraph(), { userPovAliases: ["Host"] });
    renderer.loadGraph(createStarSeedGraph({ includeFragment: true }), { userPovAliases: ["Host"] });
    const frameCount = flushRafsUntilIdle({ maxFrames: 80, ms: 16 });
    assert.ok(frameCount > 0, "animated layout actually used RAF frames");
    assert.ok(frameCount <= 80, "animated layout RAFs are bounded");
    assertLayoutAnimationNotRunning(renderer, "bounded animated layout settles");
    assertNoPendingRafOrTimers("bounded animated layout settles without RAF/timer leaks");
  } finally {
    renderer.destroy();
    restoreMatchMedia();
  }
}

{
  const { renderer, restoreMatchMedia } = createAnimatedLayoutRenderer();
  try {
    renderer.loadGraph(createStarSeedGraph({ includeFragment: true }), { userPovAliases: ["Host"] });
    assertLayoutAnimationDiagnosticsShape(renderer);
  } finally {
    renderer.destroy();
    restoreMatchMedia();
  }
}

console.log("graph-renderer guardrail tests passed");
