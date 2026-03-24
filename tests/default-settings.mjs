import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

async function loadDefaultSettings() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.resolve(__dirname, "../index.js");
  const source = await fs.readFile(indexPath, "utf8");
  const settingsMatch = source.match(/const defaultSettings = \{[\s\S]*?^\};/m);

  if (!settingsMatch) {
    throw new Error("无法从 index.js 提取 defaultSettings");
  }

  const context = vm.createContext({});
  const script = new vm.Script(`
${settingsMatch[0]}
this.defaultSettings = defaultSettings;
`);
  script.runInContext(context);
  return context.defaultSettings;
}

const defaultSettings = await loadDefaultSettings();

assert.equal(defaultSettings.extractContextTurns, 2);
assert.equal(defaultSettings.recallTopK, 20);
assert.equal(defaultSettings.recallMaxNodes, 8);
assert.equal(defaultSettings.recallEnableVectorPrefilter, true);
assert.equal(defaultSettings.recallEnableGraphDiffusion, true);
assert.equal(defaultSettings.recallDiffusionTopK, 100);
assert.equal(defaultSettings.recallLlmCandidatePool, 30);
assert.equal(defaultSettings.injectDepth, 9999);

console.log("default-settings tests passed");
