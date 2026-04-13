import assert from "node:assert/strict";

import { solveLayoutWithJs } from "../ui/graph-layout-solver.js";
import {
  getNativeModuleStatus,
  solveLayout,
} from "../vendor/wasm/stbme_core.js";

const originalLoader = globalThis.__stBmeLoadRustWasmLayout;

function buildPayload(seed = 42, nodeCount = 180) {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  const regionRect = { x: 0, y: 0, w: 980, h: 620 };
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      x: regionRect.x + rand() * regionRect.w,
      y: regionRect.y + rand() * regionRect.h,
      vx: 0,
      vy: 0,
      pinned: false,
      radius: 6 + rand() * 8,
      regionKey: "objective",
      regionRect,
    });
  }

  const edges = [];
  const edgeTarget = Math.max(nodeCount * 4, 1);
  for (let i = 0; i < edgeTarget; i++) {
    const from = Math.floor(rand() * nodeCount);
    let to = Math.floor(rand() * nodeCount);
    if (to === from) to = (to + 1) % nodeCount;
    edges.push({
      from,
      to,
      strength: 0.25 + rand() * 0.75,
    });
  }

  return {
    nodes,
    edges,
    config: {
      iterations: 52,
      repulsion: 2600,
      springK: 0.05,
      damping: 0.87,
      centerGravity: 0.015,
      minGap: 11,
      speedCap: 3.2,
    },
  };
}

function meanAbsDiff(a = new Float32Array(0), b = new Float32Array(0)) {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / len;
}

try {
  globalThis.__stBmeLoadRustWasmLayout = async () => ({
    solve_layout(payload) {
      const jsResult = solveLayoutWithJs(payload);
      return {
        ok: true,
        positions: Array.from(jsResult.positions),
        diagnostics: {
          solver: "mock-rust-wasm",
          nodeCount: jsResult.diagnostics.nodeCount,
          edgeCount: jsResult.diagnostics.edgeCount,
          iterations: jsResult.diagnostics.iterations,
        },
      };
    },
  });

  const payload = buildPayload();
  const jsResult = solveLayoutWithJs(payload);
  const nativeResult = await solveLayout(payload);

  assert.equal(jsResult.ok, true);
  assert.equal(nativeResult.ok, true);
  assert.ok(nativeResult.positions instanceof Float32Array);
  assert.equal(jsResult.positions.length, nativeResult.positions.length);

  const mad = meanAbsDiff(jsResult.positions, nativeResult.positions);
  const nativeStatus = getNativeModuleStatus();
  const threshold = nativeStatus.source === "wasm-pack-artifact" ? 2e-4 : 1e-6;
  assert.ok(
    mad <= threshold,
    `mean abs diff too high: ${mad} (source=${nativeStatus.source || "unknown"}, threshold=${threshold})`,
  );
} finally {
  if (typeof originalLoader === "function") {
    globalThis.__stBmeLoadRustWasmLayout = originalLoader;
  } else {
    delete globalThis.__stBmeLoadRustWasmLayout;
  }
}

console.log("native-layout-parity tests passed");
