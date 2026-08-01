import assert from "node:assert/strict";

import { ensurePanelGraphRenderers } from "../ui/panel-graph-renderer-lifecycle.js";

const canvases = {
  "bme-graph-canvas": { id: "desktop" },
  "bme-mobile-graph-canvas": { id: "mobile" },
};
const created = [];
class FakeRenderer {
  constructor(canvas, options) {
    this.canvas = canvas;
    this.options = options;
    created.push(canvas.id);
  }
}
const document = { getElementById: (id) => canvases[id] || null };
const onNodeSelect = () => {};

const desktop = ensurePanelGraphRenderers({
  GraphRenderer: FakeRenderer, document, graphOptions: { theme: "test" }, onNodeSelect,
});
assert.deepEqual(created, ["desktop"]);
assert.equal(desktop.graphRenderer.canvas.id, "desktop");
assert.equal(desktop.graphRenderer.onNodeSelect, onNodeSelect);
assert.equal(desktop.mobileGraphRenderer, null);

const mobile = ensurePanelGraphRenderers({
  GraphRenderer: FakeRenderer, document, isMobile: true,
  graphRenderer: desktop.graphRenderer, onNodeSelect,
});
assert.deepEqual(created, ["desktop", "mobile"]);
assert.equal(mobile.graphRenderer, desktop.graphRenderer);
assert.equal(mobile.mobileGraphRenderer.canvas.id, "mobile");

console.log("panel graph renderer lifecycle tests passed");
