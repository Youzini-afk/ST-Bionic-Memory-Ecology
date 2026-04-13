import assert from "node:assert/strict";

import { solveLayoutWithJs } from "../ui/graph-layout-solver.js";

const payload = {
  nodes: [
    {
      x: 20,
      y: 20,
      vx: 0,
      vy: 0,
      pinned: false,
      radius: 8,
      regionKey: "objective",
      regionRect: { x: 0, y: 0, w: 200, h: 160 },
    },
    {
      x: 80,
      y: 30,
      vx: 0,
      vy: 0,
      pinned: false,
      radius: 9,
      regionKey: "objective",
      regionRect: { x: 0, y: 0, w: 200, h: 160 },
    },
    {
      x: 100,
      y: 80,
      vx: 0,
      vy: 0,
      pinned: true,
      radius: 10,
      regionKey: "objective",
      regionRect: { x: 0, y: 0, w: 200, h: 160 },
    },
  ],
  edges: [
    { from: 0, to: 1, strength: 0.8 },
    { from: 1, to: 2, strength: 0.6 },
  ],
  config: {
    iterations: 32,
    repulsion: 2200,
    springK: 0.05,
    damping: 0.87,
    centerGravity: 0.02,
    minGap: 10,
    speedCap: 3,
  },
};

const resultA = solveLayoutWithJs(payload);
assert.equal(resultA.ok, true);
assert.ok(resultA.positions instanceof Float32Array);
assert.equal(resultA.positions.length, payload.nodes.length * 2);
assert.equal(resultA.diagnostics.solver, "js-worker");
assert.equal(resultA.diagnostics.nodeCount, 3);

const resultB = solveLayoutWithJs(payload);
assert.deepEqual(Array.from(resultA.positions), Array.from(resultB.positions));

for (let index = 0; index < payload.nodes.length; index++) {
  const x = resultA.positions[index * 2];
  const y = resultA.positions[index * 2 + 1];
  assert.ok(Number.isFinite(x));
  assert.ok(Number.isFinite(y));
  assert.ok(x >= 0 && x <= 200);
  assert.ok(y >= 0 && y <= 160);
}

const emptyResult = solveLayoutWithJs({ nodes: [], edges: [] });
assert.equal(emptyResult.ok, true);
assert.equal(emptyResult.positions.length, 0);

console.log("graph-layout-solver tests passed");
