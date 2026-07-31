import assert from "node:assert/strict";

import {
  MEMORY_RUNTIME_MODE,
  isAgentMemoryRuntimeMode,
  normalizeMemoryRuntimeMode,
} from "../runtime/memory-runtime-mode.js";

assert.equal(MEMORY_RUNTIME_MODE.WORKFLOW, "workflow");
assert.equal(MEMORY_RUNTIME_MODE.AGENT, "agent");
assert.equal(normalizeMemoryRuntimeMode("agent"), "agent");
assert.equal(normalizeMemoryRuntimeMode(" AGENT "), "agent");
assert.equal(normalizeMemoryRuntimeMode("workflow"), "workflow");
assert.equal(normalizeMemoryRuntimeMode(""), "workflow");
assert.equal(normalizeMemoryRuntimeMode("legacy"), "workflow");
assert.equal(isAgentMemoryRuntimeMode("agent"), true);
assert.equal(isAgentMemoryRuntimeMode("workflow"), false);

console.log("memory runtime mode tests passed");
