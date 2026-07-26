import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const [manifestSource, panelHtml, styleCss] = await Promise.all([
  readFile(path.join(root, "manifest.json"), "utf8"),
  readFile(path.join(root, "ui", "panel.html"), "utf8"),
  readFile(path.join(root, "style.css"), "utf8"),
]);

const manifest = JSON.parse(manifestSource);
assert.equal(manifest.display_name, "ST-BME Memory Graph");
assert.equal(manifest.js, "index.js");
assert.equal(manifest.css, "style.css");

const requiredPanelIds = [
  "st-bme-panel-overlay",
  "st-bme-panel",
  "bme-pane-dashboard",
  "bme-pane-actions",
  "bme-pane-config",
  "bme-pane-graph",
  "bme-graph-canvas",
  "bme-cognition-workspace",
  "bme-summary-workspace",
  "bme-mobile-graph-pane",
  "bme-mobile-cognition-pane",
  "bme-mobile-summary-pane-full",
  "bme-setting-enabled",
  "bme-setting-recall-enabled",
  "bme-setting-cloud-storage-mode",
  "bme-act-backup-to-cloud",
  "bme-act-restore-from-cloud",
  "bme-planner-enabled",
  "bme-planner-run-test",
];

for (const id of requiredPanelIds) {
  assert.ok(panelHtml.includes(`id="${id}"`), `missing product surface #${id}`);
}

for (const tab of ["dashboard", "task", "actions", "config", "graph"]) {
  assert.ok(panelHtml.includes(`data-tab="${tab}"`), `missing product tab ${tab}`);
}

for (const view of ["graph", "cognition", "summary"]) {
  assert.ok(
    panelHtml.includes(`data-mobile-graph-view="${view}"`),
    `missing mobile graph view ${view}`,
  );
}

for (const selector of ["#st-bme-panel-overlay", "#st-bme-panel", "#bme-floating-ball"]) {
  assert.ok(styleCss.includes(selector), `missing product style ${selector}`);
}

console.log("product-surface-contract tests passed");
