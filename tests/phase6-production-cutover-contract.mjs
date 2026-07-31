import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const indexSource = read("index.js");
const eventBindingSource = read("host/event-binding.js");
const finalInjectionSource = read("runtime/final-recall-injection.js");
const recallControllerSource = read("retrieval/recall-controller.js");
const lifecycleSource = read("application/memory-lifecycle-runtime.js");
const uiActionsSource = read("ui/ui-actions-controller.js");
const enaSource = read("ena-planner/ena-planner.js");
const plotHistorySource = read("ena-planner/planner-plot-history.js");

assert.match(
  indexSource,
  /async function runExtraction\(\)[\s\S]*?requestMemoryStewardAction\("extract"/,
  "production extraction must submit a Memory Steward intent",
);
assert.match(
  indexSource,
  /replaceGraphWithLedger:[\s\S]*?lifecycle\.replaceWithGraphSnapshot/,
  "graph import must replace the ledger snapshot, not the compatibility projection",
);
assert.match(indexSource, /archiveAllGraphMemories:[\s\S]*?archiveAllMemories/);
assert.match(indexSource, /archiveGraphMemories:[\s\S]*?archiveMemories/);
assert.doesNotMatch(
  uiActionsSource,
  /setCurrentGraph\(importedGraph\)|removeNode\(graph, node\.id\)/,
  "import/clear actions must not maintain a second graph authority",
);

const noNewUserBranch = eventBindingSource.match(
  /if \(effectiveGenerationKind === "no-new-user"\) \{[\s\S]*?\n  \}\n  const normalInput/,
)?.[0] || "";
assert.match(noNewUserBranch, /validateNoNewUserTurnArtifacts/);
assert.match(noNewUserBranch, /clearFinalRecallInjectionFailClosed/);
assert.doesNotMatch(noNewUserBranch, /applyFinalRecallInjectionForGeneration|runRecall\(/);
assert.match(finalInjectionSource, /function clearFinalRecallInjectionFailClosed/);
assert.match(finalInjectionSource, /clearRecallPayloadInjection\(promptData\)/);
assert.match(
  recallControllerSource,
  /inferredNoNewUser[\s\S]*?durable-turn-artifact-unavailable[\s\S]*?cachedRecallPayload/,
  "the lower Recall controller must stop no-new-user runs before every cache fallback",
);

assert.match(
  lifecycleSource,
  /expectedMemoryStateFingerprint: recallResult\.memoryStateFingerprint/,
  "Planner publication must retain the Recall memory snapshot",
);
assert.match(lifecycleSource, /_agentBundles = new Map\(\)/);
assert.match(lifecycleSource, /bundle\.activeCalls/);

assert.match(enaSource, /BME durable Recall unavailable/);
assert.match(enaSource, /throw e;[\s\S]*?finally/);
assert.doesNotMatch(
  plotHistorySource,
  /for \(const legacyPlot of extractLastNPlots\(chat/,
  "Planner prompt history must not scan raw legacy plot tags at runtime",
);
assert.match(
  plotHistorySource,
  /!record\?\.recallArtifactId[\s\S]*?!record\?\.plannerArtifactId/,
  "Planner history candidates must carry a complete Recall/Planner binding",
);
assert.match(enaSource, /validatePlannerPlotHistoryRecords\(plotCandidates\)/);
assert.match(
  lifecycleSource,
  /validatePlannerHistoryRecords[\s\S]*?recall\?\.id === recallArtifactId[\s\S]*?planner\?\.id === plannerArtifactId/,
  "Planner history must verify its exact durable Artifact pair against the chat ledger",
);

console.log("phase 6 production cutover contract tests passed");
