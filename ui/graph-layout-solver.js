const DEFAULT_LAYOUT_CONFIG = Object.freeze({
  iterations: 80,
  repulsion: 2800,
  springK: 0.048,
  damping: 0.88,
  centerGravity: 0.014,
  minGap: 12,
  speedCap: 3.8,
});

function clampFinite(value, fallback = 0, min = -Infinity, max = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeConfig(raw = {}) {
  return {
    iterations: Math.max(
      8,
      Math.min(220, Math.floor(clampFinite(raw.iterations, DEFAULT_LAYOUT_CONFIG.iterations, 1, 220))),
    ),
    repulsion: clampFinite(raw.repulsion, DEFAULT_LAYOUT_CONFIG.repulsion, 100, 120000),
    springK: clampFinite(raw.springK, DEFAULT_LAYOUT_CONFIG.springK, 0.001, 1.0),
    damping: clampFinite(raw.damping, DEFAULT_LAYOUT_CONFIG.damping, 0.1, 0.999),
    centerGravity: clampFinite(
      raw.centerGravity,
      DEFAULT_LAYOUT_CONFIG.centerGravity,
      0.0001,
      1,
    ),
    minGap: clampFinite(raw.minGap, DEFAULT_LAYOUT_CONFIG.minGap, 0, 120),
    speedCap: clampFinite(raw.speedCap, DEFAULT_LAYOUT_CONFIG.speedCap, 0.5, 20),
  };
}

function normalizePanel(raw = null) {
  if (!raw || typeof raw !== "object") {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return {
    x: clampFinite(raw.x, 0),
    y: clampFinite(raw.y, 0),
    w: Math.max(0, clampFinite(raw.w, 0)),
    h: Math.max(0, clampFinite(raw.h, 0)),
  };
}

function normalizeNode(raw = {}) {
  const rect = normalizePanel(raw.regionRect);
  return {
    x: clampFinite(raw.x, 0),
    y: clampFinite(raw.y, 0),
    vx: clampFinite(raw.vx, 0),
    vy: clampFinite(raw.vy, 0),
    pinned: raw.pinned === true,
    radius: Math.max(1, clampFinite(raw.radius, 8, 1, 96)),
    regionKey: String(raw.regionKey || "objective"),
    regionRect: rect,
  };
}

function normalizeEdge(raw = {}, nodeCount = 0) {
  const from = Math.floor(clampFinite(raw.from, -1));
  const to = Math.floor(clampFinite(raw.to, -1));
  if (from < 0 || to < 0 || from >= nodeCount || to >= nodeCount || from === to) {
    return null;
  }
  return {
    from,
    to,
    strength: clampFinite(raw.strength, 0.5, 0, 1),
  };
}

function clampNodeToRegion(state, index) {
  const rect = state.rects[index];
  const radius = state.radius[index] + 6;
  state.x[index] = Math.max(rect.x + radius, Math.min(rect.x + rect.w - radius, state.x[index]));
  state.y[index] = Math.max(rect.y + radius, Math.min(rect.y + rect.h - radius, state.y[index]));
}

function computeSpringIdealByRegion(nodes = []) {
  const countByRegion = new Map();
  for (const node of nodes) {
    countByRegion.set(node.regionKey, (countByRegion.get(node.regionKey) || 0) + 1);
  }
  const idealByRegion = new Map();
  for (const node of nodes) {
    if (idealByRegion.has(node.regionKey)) continue;
    const rect = node.regionRect;
    const count = Math.max(1, countByRegion.get(node.regionKey) || 1);
    const area = Math.max(1, (rect?.w || 1) * (rect?.h || 1));
    const ideal = Math.max(36, Math.min(92, 0.78 * Math.sqrt(area / count)));
    idealByRegion.set(node.regionKey, ideal);
  }
  return idealByRegion;
}

function buildRegionBuckets(nodes = []) {
  const bucketByRegion = new Map();
  for (let index = 0; index < nodes.length; index++) {
    const key = nodes[index].regionKey;
    if (!bucketByRegion.has(key)) {
      bucketByRegion.set(key, []);
    }
    bucketByRegion.get(key).push(index);
  }
  return bucketByRegion;
}

function buildInRegionEdges(nodes = [], edges = []) {
  const result = [];
  for (const edge of edges) {
    const fromRegion = nodes[edge.from]?.regionKey;
    const toRegion = nodes[edge.to]?.regionKey;
    if (!fromRegion || fromRegion !== toRegion) continue;
    result.push({
      from: edge.from,
      to: edge.to,
      strength: edge.strength,
    });
  }
  return result;
}

function buildRegionCenters(nodes = []) {
  const centerX = new Float32Array(nodes.length);
  const centerY = new Float32Array(nodes.length);
  for (let index = 0; index < nodes.length; index++) {
    const rect = nodes[index]?.regionRect || { x: 0, y: 0, w: 0, h: 0 };
    centerX[index] = rect.x + rect.w / 2;
    centerY[index] = rect.y + rect.h / 2;
  }
  return { centerX, centerY };
}

function buildSimulationState(nodes = []) {
  const length = nodes.length;
  const x = new Float32Array(length);
  const y = new Float32Array(length);
  const vx = new Float32Array(length);
  const vy = new Float32Array(length);
  const fx = new Float32Array(length);
  const fy = new Float32Array(length);
  const radius = new Float32Array(length);
  const pinned = new Uint8Array(length);
  const rects = new Array(length);

  for (let i = 0; i < length; i++) {
    const node = nodes[i];
    x[i] = node.x;
    y[i] = node.y;
    vx[i] = node.vx;
    vy[i] = node.vy;
    radius[i] = node.radius;
    pinned[i] = node.pinned ? 1 : 0;
    rects[i] = node.regionRect;
  }

  return {
    x,
    y,
    vx,
    vy,
    fx,
    fy,
    radius,
    pinned,
    rects,
  };
}

export function solveLayoutWithJs(payload = {}) {
  const startedAt = performance.now();
  const nodes = Array.isArray(payload.nodes) ? payload.nodes.map(normalizeNode) : [];
  const config = normalizeConfig(payload.config || {});
  const edgesRaw = Array.isArray(payload.edges) ? payload.edges : [];
  const edges = edgesRaw
    .map((edge) => normalizeEdge(edge, nodes.length))
    .filter(Boolean);

  if (nodes.length === 0) {
    return {
      ok: true,
      positions: new Float32Array(0),
      diagnostics: {
        nodeCount: 0,
        edgeCount: 0,
        elapsedMs: 0,
        solver: "js-worker",
      },
    };
  }

  const springIdealByRegion = computeSpringIdealByRegion(nodes);
  const regionBuckets = buildRegionBuckets(nodes);
  const state = buildSimulationState(nodes);
  const inRegionEdges = buildInRegionEdges(nodes, edges);
  const { centerX, centerY } = buildRegionCenters(nodes);
  let actualIterations = 0;
  let stableRounds = 0;

  for (let iter = 0; iter < config.iterations; iter++) {
    actualIterations += 1;
    state.fx.fill(0);
    state.fy.fill(0);

    for (const indexes of regionBuckets.values()) {
      for (let i = 0; i < indexes.length; i++) {
        const a = indexes[i];
        for (let j = i + 1; j < indexes.length; j++) {
          const b = indexes[j];
          const dx = state.x[b] - state.x[a];
          const dy = state.y[b] - state.y[a];
          let distSq = dx * dx + dy * dy;
          if (distSq < 0.25) distSq = 0.25;
          const dist = Math.sqrt(distSq);
          const minSep = state.radius[a] + state.radius[b] + config.minGap;
          let force = config.repulsion / distSq;
          if (dist < minSep) {
            force += (minSep - dist) * 0.22;
          }
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          state.fx[a] -= fx;
          state.fy[a] -= fy;
          state.fx[b] += fx;
          state.fy[b] += fy;
        }
      }
    }

    for (const edge of inRegionEdges) {
      const from = edge.from;
      const to = edge.to;
      const ideal = springIdealByRegion.get(nodes[from].regionKey) ?? 68;
      const dx = state.x[to] - state.x[from];
      const dy = state.y[to] - state.y[from];
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const displacement = dist - ideal * (0.82 + 0.18 * edge.strength);
      const force = config.springK * displacement * (0.45 + 0.55 * edge.strength);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      state.fx[from] += fx;
      state.fy[from] += fy;
      state.fx[to] -= fx;
      state.fy[to] -= fy;
    }

    for (let i = 0; i < nodes.length; i++) {
      state.fx[i] += (centerX[i] - state.x[i]) * config.centerGravity;
      state.fy[i] += (centerY[i] - state.y[i]) * config.centerGravity;
    }

    let maxSpeed = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (state.pinned[i]) {
        continue;
      }
      state.vx[i] = (state.vx[i] + state.fx[i]) * config.damping;
      state.vy[i] = (state.vy[i] + state.fy[i]) * config.damping;
      const speed = Math.hypot(state.vx[i], state.vy[i]);
      if (speed > maxSpeed) {
        maxSpeed = speed;
      }
      if (speed > config.speedCap) {
        state.vx[i] = (state.vx[i] / speed) * config.speedCap;
        state.vy[i] = (state.vy[i] / speed) * config.speedCap;
      }
      state.x[i] += state.vx[i];
      state.y[i] += state.vy[i];
      clampNodeToRegion(state, i);
    }

    if (maxSpeed < 0.015) {
      stableRounds += 1;
      if (stableRounds >= 6) {
        break;
      }
    } else {
      stableRounds = 0;
    }
  }

  const positions = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    positions[i * 2] = state.x[i];
    positions[i * 2 + 1] = state.y[i];
  }

  return {
    ok: true,
    positions,
    diagnostics: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      elapsedMs: Math.max(0, performance.now() - startedAt),
      solver: "js-worker",
      iterations: actualIterations,
    },
  };
}
