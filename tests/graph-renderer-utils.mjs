import assert from "node:assert/strict";

import {
  isUsableGraphCanvasSize,
  remapPositionBetweenRects,
} from "../ui/graph-renderer-utils.js";

assert.equal(isUsableGraphCanvasSize(0, 0), false);
assert.equal(isUsableGraphCanvasSize(47, 120), false);
assert.equal(isUsableGraphCanvasSize(120, 47), false);
assert.equal(isUsableGraphCanvasSize(48, 48), true);
assert.equal(isUsableGraphCanvasSize(320, 180), true);

assert.deepEqual(
  remapPositionBetweenRects(60, 35, { x: 10, y: 10, w: 100, h: 50 }, { x: 20, y: 20, w: 200, h: 100 }),
  { x: 120, y: 70 },
);

assert.deepEqual(
  remapPositionBetweenRects(-50, 300, { x: 10, y: 10, w: 100, h: 50 }, { x: 20, y: 20, w: 200, h: 100 }),
  { x: 20, y: 120 },
);

assert.deepEqual(
  remapPositionBetweenRects(42, 84, null, { x: 20, y: 20, w: 200, h: 100 }),
  { x: 42, y: 84 },
);

console.log("graph-renderer-utils tests passed");
