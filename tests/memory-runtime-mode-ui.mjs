import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, panel, controls, css] = await Promise.all([
  readFile(new URL("../ui/panel.html", import.meta.url), "utf8"),
  readFile(new URL("../ui/panel.js", import.meta.url), "utf8"),
  readFile(new URL("../ui/runtime-mode-controls.js", import.meta.url), "utf8"),
  readFile(new URL("../style.css", import.meta.url), "utf8"),
]);

assert.match(html, /id="bme-memory-runtime-mode"/);
assert.match(html, /data-memory-runtime-mode="workflow"/);
assert.match(html, /data-memory-runtime-mode="agent"/);
assert.match(html, /class="bme-agent-cadence-note"/);
assert.match(panel, /bindRuntimeModeControls/);
assert.match(panel, /refreshRuntimeModeControls/);
assert.match(
  panel,
  /getTaskTypeOptionsForRuntimeMode\(\s*settings\.memoryRuntimeMode,?\s*\)/,
);
assert.match(
  panel,
  /refreshTaskWorkspace:[\s\S]{0,180}"memoryRuntimeMode"/,
);
assert.match(controls, /memoryRuntimeMode:\s*normalizeMemoryRuntimeMode/);
assert.match(controls, /patchSettings\(buildPatch\(button\)\)/);
assert.match(css, /\.bme-runtime-mode-switch/);
assert.match(
  css,
  /\[data-memory-runtime-mode="agent"\]\s+\.bme-agent-cadence-note/,
);

for (const workflowControl of [
  "bme-setting-extract-auto-enabled",
  "bme-setting-maintenance-execution-mode",
  "bme-setting-consolidation-enabled",
  "bme-setting-synopsis-enabled",
  "bme-setting-visibility-enabled",
  "bme-setting-cross-recall-enabled",
  "bme-setting-smart-trigger-enabled",
  "bme-setting-sleep-cycle-enabled",
  "bme-setting-auto-compression-enabled",
  "bme-setting-prob-recall-enabled",
  "bme-setting-reflection-enabled",
  "bme-setting-extract-every",
  "bme-setting-recall-top-k",
]) {
  assert.match(html, new RegExp(`id="${workflowControl}"`));
}

for (const agentControl of [
  "bme-setting-agent-context-window",
  "bme-setting-agent-max-tool-calls",
  "bme-setting-agent-max-run-minutes",
]) {
  assert.match(html, new RegExp(`id="${agentControl}"`));
  assert.match(controls, new RegExp(agentControl));
}

assert.doesNotMatch(
  css,
  /#bme-setting-extract-auto-enabled[\s\S]{0,500}display:\s*none\s*!important/,
);
console.log("memory runtime mode UI tests passed");
