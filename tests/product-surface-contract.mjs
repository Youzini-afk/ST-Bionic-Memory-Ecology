import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const [manifestSource, panelHtml, panelSource, uiLabelSource, styleCss] = await Promise.all([
  readFile(path.join(root, "manifest.json"), "utf8"),
  readFile(path.join(root, "ui", "panel.html"), "utf8"),
  readFile(path.join(root, "ui", "panel.js"), "utf8"),
  readFile(path.join(root, "ui", "ui-label-formatter.js"), "utf8"),
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
  "bme-task-workspace",
  "bme-graph-canvas",
  "bme-cognition-workspace",
  "bme-summary-workspace",
  "bme-mobile-graph-pane",
  "bme-mobile-cognition-pane",
  "bme-mobile-summary-pane-full",
  "bme-setting-enabled",
  "bme-setting-recall-enabled",
  "bme-setting-recall-card-user-input-display-mode",
  "bme-setting-cloud-storage-mode",
  "bme-act-backup-to-cloud",
  "bme-act-restore-from-cloud",
  "bme-act-manage-server-backups",
  "bme-act-rollback-last-restore",
  "bme-planner-enabled",
  "bme-planner-run-test",
  "bme-setting-graph-native-force-disable",
  "bme-setting-native-engine-fail-open",
  "bme-setting-graph-use-native-layout",
  "bme-setting-persist-use-native-delta",
  "bme-setting-load-use-native-hydrate",
  "bme-act-extract",
  "bme-act-compress",
  "bme-act-synopsis",
  "bme-act-summary-rollup",
  "bme-act-summary-rebuild",
  "bme-act-evolve",
  "bme-act-sleep",
  "bme-act-undo-maintenance",
  "bme-act-vector-rebuild",
  "bme-act-vector-range",
  "bme-act-vector-reembed",
  "bme-act-export",
  "bme-act-import",
  "bme-act-rebuild",
  "bme-luker-sidecar-group",
  "bme-act-retry-persist",
  "bme-act-probe-graph-load",
  "bme-act-rebuild-luker-cache",
  "bme-act-repair-luker-sidecar",
  "bme-act-compact-luker-sidecar",
  "bme-act-export-diagnostics",
  "bme-act-clear-graph",
  "bme-act-clear-graph-range",
  "bme-act-summary-clear",
  "bme-act-clear-vector-cache",
  "bme-act-clear-batch-journal",
  "bme-act-delete-current-idb",
  "bme-act-delete-all-idb",
  "bme-act-delete-server-sync",
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

for (const section of ["api", "toggles", "advanced", "prompts", "planner", "appearance", "cleanup"]) {
  assert.ok(
    panelHtml.includes(`data-config-section="${section}"`),
    `missing config workspace ${section}`,
  );
}

for (const section of ["pipeline", "timeline", "memory", "injection", "trace", "persistence"]) {
  assert.ok(
    panelHtml.includes(`data-task-section="${section}"`),
    `missing task workspace ${section}`,
  );
}

for (const mode of ["off", "beautify_only", "mirror"]) {
  assert.ok(
    panelHtml.includes(`<option value="${mode}"`),
    `missing recall-card display mode ${mode}`,
  );
}

for (const key of [
  "panel.cloudSync.title",
  "panel.cloudSync.subtitle",
  "panel.cloudSync.modeLabel",
  "panel.cloudSync.automaticOption",
  "panel.cloudSync.manualOption",
  "panel.cloudSync.automaticHelp",
]) {
  assert.ok(panelHtml.includes(`data-i18n="${key}"`), `missing Cloud Sync surface ${key}`);
}

for (const key of [
  "panel.cloudSync.automaticHelp",
  "panel.cloudSync.manualHelp",
  "panel.cloudSync.authorityHelp",
  "panel.cloudSync.lukerHelp",
]) {
  assert.ok(uiLabelSource.includes(`"${key}"`), `missing dynamic Cloud Sync surface ${key}`);
}

assert.ok(
  uiLabelSource.includes('primary === "authority-sql"'),
  "Cloud Sync help must recognize Authority SQL primary storage",
);
assert.ok(
  uiLabelSource.includes('primary === "luker-chat-state"'),
  "Cloud Sync help must recognize Luker chat-state primary storage",
);
assert.ok(
  panelSource.includes("uiCloudStorageModeHelpText("),
  "Cloud Sync UI must consume the storage-aware help formatter",
);

for (const selector of ["#st-bme-panel-overlay", "#st-bme-panel", "#bme-floating-ball"]) {
  assert.ok(styleCss.includes(selector), `missing product style ${selector}`);
}

console.log("product-surface-contract tests passed");
