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

  const context = vm.createContext({
    createDefaultTaskProfiles() {
      return {
        extract: { activeProfileId: "default", profiles: [] },
        recall: { activeProfileId: "default", profiles: [] },
        compress: { activeProfileId: "default", profiles: [] },
        synopsis: { activeProfileId: "default", profiles: [] },
        reflection: { activeProfileId: "default", profiles: [] },
        consolidation: { activeProfileId: "default", profiles: [] },
      };
    },
  });
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
assert.equal(defaultSettings.recallLlmContextMessages, 4);
assert.equal(defaultSettings.recallEnableMultiIntent, true);
assert.equal(defaultSettings.recallMultiIntentMaxSegments, 4);
assert.equal(defaultSettings.recallTeleportAlpha, 0.15);
assert.equal(defaultSettings.recallEnableTemporalLinks, true);
assert.equal(defaultSettings.recallTemporalLinkStrength, 0.2);
assert.equal(defaultSettings.recallEnableDiversitySampling, true);
assert.equal(defaultSettings.recallDppCandidateMultiplier, 3);
assert.equal(defaultSettings.recallDppQualityWeight, 1.0);
assert.equal(defaultSettings.recallEnableCooccurrenceBoost, false);
assert.equal(defaultSettings.recallCooccurrenceScale, 0.1);
assert.equal(defaultSettings.recallCooccurrenceMaxNeighbors, 10);
assert.equal(defaultSettings.recallEnableResidualRecall, false);
assert.equal(defaultSettings.recallResidualBasisMaxNodes, 24);
assert.equal(defaultSettings.recallNmfTopics, 15);
assert.equal(defaultSettings.recallNmfNoveltyThreshold, 0.4);
assert.equal(defaultSettings.recallResidualThreshold, 0.3);
assert.equal(defaultSettings.recallResidualTopK, 5);
assert.equal(defaultSettings.injectDepth, 9999);
assert.equal(defaultSettings.enabled, true);
assert.equal(defaultSettings.enableReflection, true);
assert.equal(defaultSettings.embeddingTransportMode, "direct");
assert.equal(defaultSettings.taskProfilesVersion, 3);
assert.ok(defaultSettings.taskProfiles);
assert.ok(defaultSettings.taskProfiles.extract);
assert.ok(defaultSettings.taskProfiles.recall);

console.log("default-settings tests passed");
