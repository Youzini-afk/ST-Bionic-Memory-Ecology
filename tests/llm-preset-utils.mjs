import assert from "node:assert/strict";

import {
  isSameLlmConfigSnapshot,
  normalizeLlmPresetMap,
  resolveActiveLlmPresetName,
  sanitizeLlmPresetSettings,
} from "../llm-preset-utils.js";

assert.equal(
  isSameLlmConfigSnapshot(
    {
      llmApiUrl: " https://example.com/v1 ",
      llmApiKey: " sk-test ",
      llmModel: " model-a ",
    },
    {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-test",
      llmModel: "model-a",
    },
  ),
  true,
);

const normalizedMap = normalizeLlmPresetMap({
  Alpha: {
    llmApiUrl: " https://example.com/v1 ",
    llmApiKey: " sk-alpha ",
    llmModel: " model-a ",
  },
  "": {
    llmApiUrl: "https://bad.example/v1",
    llmApiKey: "sk-bad",
    llmModel: "bad-model",
  },
  Broken: {
    llmApiUrl: "https://broken.example/v1",
    llmApiKey: 42,
    llmModel: "broken",
  },
});
assert.equal(normalizedMap.changed, true);
assert.deepEqual(normalizedMap.presets, {
  Alpha: {
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-alpha",
    llmModel: "model-a",
  },
});

const sanitized = sanitizeLlmPresetSettings({
  llmPresets: {
    Alpha: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-alpha",
      llmModel: "model-a",
    },
  },
  llmActivePreset: "Missing",
});
assert.equal(sanitized.changed, true);
assert.equal(sanitized.activePreset, "");

const uniqueMatchSettings = {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-alpha",
  llmModel: "model-a",
  llmPresets: {
    Alpha: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-alpha",
      llmModel: "model-a",
    },
    Beta: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-beta",
      llmModel: "model-b",
    },
  },
  llmActivePreset: "",
};
assert.equal(resolveActiveLlmPresetName(uniqueMatchSettings), "Alpha");

const preservedActiveSettings = {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-shared",
  llmModel: "shared-model",
  llmPresets: {
    Alpha: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-shared",
      llmModel: "shared-model",
    },
    Beta: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-shared",
      llmModel: "shared-model",
    },
  },
  llmActivePreset: "Beta",
};
assert.equal(resolveActiveLlmPresetName(preservedActiveSettings), "Beta");

const ambiguousSettings = {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-shared",
  llmModel: "shared-model",
  llmPresets: {
    Alpha: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-shared",
      llmModel: "shared-model",
    },
    Beta: {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-shared",
      llmModel: "shared-model",
    },
  },
  llmActivePreset: "",
};
assert.equal(resolveActiveLlmPresetName(ambiguousSettings), "");

const noMatchSettings = {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-gamma",
  llmModel: "model-gamma",
  llmPresets: uniqueMatchSettings.llmPresets,
  llmActivePreset: "",
};
assert.equal(resolveActiveLlmPresetName(noMatchSettings), "");

console.log("llm-preset-utils tests passed");
