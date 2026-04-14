import { performance } from "node:perf_hooks";

import { solveLayoutWithJs } from "../../ui/graph-layout-solver.js";
import {
  getNativeModuleStatus,
  solveLayout as solveNativeLayout,
} from "../../vendor/wasm/stbme_core.js";

const SCALES = [
  { nodes: 600, edgeMultiplier: 3 },
  { nodes: 1200, edgeMultiplier: 4 },
  { nodes: 2000, edgeMultiplier: 4 },
];

const RUNS = 3;

function buildPayload(seed = 7, nodeCount = 600, edgeMultiplier = 4) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };

  const regionRect = { x: 0, y: 0, w: 1280, h: 780 };
  const nodes = new Array(nodeCount).fill(null).map(() => ({
    x: regionRect.x + rand() * regionRect.w,
    y: regionRect.y + rand() * regionRect.h,
    vx: 0,
    vy: 0,
    pinned: false,
    radius: 5.5 + rand() * 8,
    regionKey: "objective",
    regionRect,
  }));

  const edgeCount = Math.max(1, Math.floor(nodeCount * edgeMultiplier));
  const edges = [];
  for (let i = 0; i < edgeCount; i++) {
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
      iterations: 56,
      repulsion: 2600,
      springK: 0.05,
      damping: 0.87,
      centerGravity: 0.015,
      minGap: 11,
      speedCap: 3.2,
    },
  };
}

function summarize(values = []) {
  if (!values.length) return { avg: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    avg: sum / sorted.length,
    p95: sorted[p95Index],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function runNative(payload) {
  const start = performance.now();
  const result = await solveNativeLayout(payload);
  const elapsed = performance.now() - start;
  return { elapsed, result };
}

function runJs(payload) {
  const start = performance.now();
  const result = solveLayoutWithJs(payload);
  const elapsed = performance.now() - start;
  return { elapsed, result };
}

async function warmUp() {
  const payload = buildPayload(12345, 320, 3);
  runJs(payload);
  await runNative(payload);
}

async function main() {
  const originalLoader = globalThis.__stBmeLoadRustWasmLayout;
  if (typeof originalLoader !== "function") {
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
  }

  try {
    await warmUp();
    const nativeStatus = getNativeModuleStatus();
    console.log(`[ST-BME][bench] graph-layout runs=${RUNS}`);
    console.log(
      `[ST-BME][bench] graph-layout native-source=${nativeStatus.source || "unknown"}`,
    );
    for (const scale of SCALES) {
      const jsTimes = [];
      const nativeTimes = [];
      for (let run = 0; run < RUNS; run++) {
        const payload = buildPayload(
          scale.nodes * 31 + run,
          scale.nodes,
          scale.edgeMultiplier,
        );
        const js = runJs(payload);
        jsTimes.push(js.elapsed);

        const native = await runNative(payload);
        nativeTimes.push(native.elapsed);
      }

      const jsSummary = summarize(jsTimes);
      const nativeSummary = summarize(nativeTimes);
      console.log(
        `[ST-BME][bench] nodes=${scale.nodes} edges≈${Math.floor(scale.nodes * scale.edgeMultiplier)} | js avg=${jsSummary.avg.toFixed(2)}ms p95=${jsSummary.p95.toFixed(2)}ms | native avg=${nativeSummary.avg.toFixed(2)}ms p95=${nativeSummary.p95.toFixed(2)}ms`,
      );
    }
  } finally {
    if (typeof originalLoader === "function") {
      globalThis.__stBmeLoadRustWasmLayout = originalLoader;
    } else {
      delete globalThis.__stBmeLoadRustWasmLayout;
    }
  }
}

main().catch((error) => {
  console.error("[ST-BME][bench] graph-layout failed:", error?.message || String(error));
  process.exitCode = 1;
});
