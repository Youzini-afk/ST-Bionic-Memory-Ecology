import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [indexSource, stewardToolSource, stewardRuntimeSource] = await Promise.all([
  readFile(new URL("../index.js", import.meta.url), "utf8"),
  readFile(new URL("../agent/graph-steward-tools.js", import.meta.url), "utf8"),
  readFile(new URL("../application/graph-steward-agent.js", import.meta.url), "utf8"),
]);

assert.ok(
  (indexSource.match(/presentationMode === "agent-background"/g) || []).length >= 3,
  "Agent background presentation must suppress extraction, vector, and recall stage notices",
);
assert.match(
  indexSource,
  /presentation:\s*createAgentBackgroundPresentation\(\{\s*runId,\s*observer:\s*agentRunMonitor\s*\}\)/,
  "Graph Steward must route nested Workflow status into its own Agent run",
);
assert.match(
  indexSource,
  /setLastRecallStatus:\s*presented\.setLastRecallStatus/,
  "Agent recall must use the background presentation status sink",
);
assert.match(
  indexSource,
  /toastr:\s*presented\.toastr/,
  "Agent recall must not reuse foreground per-stage toasts",
);
assert.match(stewardToolSource, /runId:\s*String\(scope\?\.runId/);
assert.match(stewardRuntimeSource, /reason:[\s\S]{0,180}\brunId,\s*\n\s*signal,/);

console.log("Agent presentation routing tests passed");
