import assert from "node:assert/strict";
import { resolveTaskGenerationOptions } from "../runtime/generation-options.js";
import { createDefaultTaskProfiles } from "../prompting/prompt-profiles.js";

function buildSettingsWithExtractGeneration(generation) {
  const taskProfiles = createDefaultTaskProfiles();
  taskProfiles.extract.profiles[0].generation = {
    ...taskProfiles.extract.profiles[0].generation,
    ...generation,
  };
  return {
    taskProfilesVersion: 1,
    taskProfiles,
  };
}

const openAiLikeSettings = buildSettingsWithExtractGeneration({
  temperature: 0.6,
  top_p: 0.95,
  top_k: 30,
  max_completion_tokens: 512,
  stream: true,
  reasoning_effort: "high",
  enable_function_calling: true,
  wrap_user_messages_in_quotes: true,
  character_name_prefix: "Narrator",
});

const openAiLike = resolveTaskGenerationOptions(
  openAiLikeSettings,
  "extract",
  { max_completion_tokens: 256 },
  { mode: "dedicated-openai-compatible" },
);

assert.equal(openAiLike.capabilityMode, "openai-compatible");
assert.equal(openAiLike.filtered.temperature, 0.6);
assert.equal(openAiLike.filtered.top_p, 0.95);
assert.equal(openAiLike.filtered.max_completion_tokens, 512);
assert.equal(openAiLike.filtered.stream, true);
assert.equal(openAiLike.filtered.reasoning_effort, "high");
assert.equal(openAiLike.filtered.enable_function_calling, true);
assert.equal(openAiLike.filtered.wrap_user_messages_in_quotes, true);
assert.ok(!Object.prototype.hasOwnProperty.call(openAiLike.filtered, "top_k"));
assert.ok(
  openAiLike.removed.some(
    (entry) => entry.field === "top_k" && entry.reason === "capability_filtered",
  ),
);

const conservative = resolveTaskGenerationOptions(
  openAiLikeSettings,
  "extract",
  { max_completion_tokens: 256 },
  { mode: "sillytavern-current-model" },
);
assert.equal(conservative.capabilityMode, "conservative");
assert.ok(
  !Object.prototype.hasOwnProperty.call(
    conservative.filtered,
    "reasoning_effort",
  ),
);
assert.ok(
  conservative.removed.some(
    (entry) =>
      entry.field === "reasoning_effort" &&
      entry.reason === "capability_filtered",
  ),
);

const fallbackSettings = buildSettingsWithExtractGeneration({
  max_completion_tokens: "",
});
const fallback = resolveTaskGenerationOptions(
  fallbackSettings,
  "extract",
  { max_completion_tokens: 300 },
  { mode: "conservative" },
);
assert.equal(fallback.filtered.max_completion_tokens, 300);

console.log("generation-options-filter tests passed");
