import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [html, panel, css, zh, en] = await Promise.all([
  fs.readFile(path.join(root, "ui/panel.html"), "utf8"),
  fs.readFile(path.join(root, "ui/panel.js"), "utf8"),
  fs.readFile(path.join(root, "style.css"), "utf8"),
  fs.readFile(path.join(root, "i18n/zh-CN.js"), "utf8"),
  fs.readFile(path.join(root, "i18n/en-US.js"), "utf8"),
]);

for (const id of [
  "bme-setting-agent-context-window-tokens",
  "bme-setting-agent-max-tool-calls",
  "bme-setting-agent-max-run-minutes",
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(panel, new RegExp(`bindNumber\\(["']${id}["']`));
}
assert.match(panel, /agentContextWindowTokens/);
assert.match(panel, /agentMaxToolCalls/);
assert.match(panel, /agentMaxRunMs:\s*value\s*\*\s*60000/);
assert.doesNotMatch(html, /留空时复用当前聊天模型/);
assert.doesNotMatch(zh, /"llm\.providerHelp\.auto":\s*"留空时复用当前聊天模型/);
assert.doesNotMatch(en, /"llm\.providerHelp\.auto":\s*"Leave blank to reuse/);
assert.match(css, /:has\(#bme-setting-extract-auto-enabled\)/);
assert.match(css, /:has\(#bme-setting-consolidation-neighbor-count\)/);

console.log("Agent settings UI tests passed");
