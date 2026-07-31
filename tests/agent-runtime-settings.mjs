import assert from "node:assert/strict";
import {
  DEFAULT_BME_AGENT_CONTEXT_WINDOW_TOKENS,
  normalizeBmeAgentRuntimeSettings,
} from "../agent/runtime-settings.js";

const defaults = normalizeBmeAgentRuntimeSettings();
assert.equal(defaults.contextWindowTokens, DEFAULT_BME_AGENT_CONTEXT_WINDOW_TOKENS);
assert.equal(defaults.maxToolCalls, 500);
assert.equal(defaults.maxRunMs, 480000);
assert.equal("maxSteps" in defaults, false);

const large = normalizeBmeAgentRuntimeSettings({
  agentContextWindowTokens: 2_000_000,
  agentMaxToolCalls: 25_000,
  agentMaxRunMs: 3_600_000,
});
assert.equal(large.contextWindowTokens, 2_000_000);
assert.equal(large.maxToolCalls, 25_000);
assert.equal(large.maxRunMs, 3_600_000);

console.log("Agent runtime settings tests passed");
