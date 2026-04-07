import assert from "node:assert/strict";

import {
  createLlmConfigSnapshot,
  isSameLlmConfigSnapshot,
  isUsableLlmConfigSnapshot,
  normalizeLlmPresetMap,
  resolveLlmConfigSelection,
  resolveActiveLlmPresetName,
  sanitizeLlmPresetSettings,
} from "../llm/llm-preset-utils.js";

assert.deepEqual(createLlmConfigSnapshot({
  llmApiUrl: " https://example.com/v1 ",
  llmApiKey: " sk-test ",
  llmModel: " model-a ",
}), {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-test",
  llmModel: "model-a",
});

assert.equal(
  isUsableLlmConfigSnapshot({
    llmApiUrl: "https://example.com/v1",
    llmModel: "model-a",
  }),
  true,
);
assert.equal(
  isUsableLlmConfigSnapshot({
    llmApiUrl: "",
    llmModel: "model-a",
  }),
  false,
);

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

const taskPresetSelection = resolveLlmConfigSelection(
  uniqueMatchSettings,
  "Alpha",
);
assert.equal(taskPresetSelection.source, "task-preset");
assert.equal(taskPresetSelection.presetName, "Alpha");
assert.deepEqual(taskPresetSelection.config, {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-alpha",
  llmModel: "model-a",
});

const globalSelection = resolveLlmConfigSelection(
  uniqueMatchSettings,
  "",
);
assert.equal(globalSelection.source, "global");
assert.equal(globalSelection.presetName, "");

const missingTaskPresetSelection = resolveLlmConfigSelection(
  uniqueMatchSettings,
  "Missing",
);
assert.equal(
  missingTaskPresetSelection.source,
  "global-fallback-missing-task-preset",
);
assert.equal(missingTaskPresetSelection.requestedPresetName, "Missing");
assert.equal(
  missingTaskPresetSelection.fallbackReason,
  "selected_task_preset_missing",
);
assert.deepEqual(missingTaskPresetSelection.config, {
  llmApiUrl: "https://example.com/v1",
  llmApiKey: "sk-alpha",
  llmModel: "model-a",
});

const invalidTaskPresetSelection = resolveLlmConfigSelection(
  {
    llmApiUrl: "https://global.example/v1",
    llmApiKey: "sk-global",
    llmModel: "model-global",
    llmPresets: {
      Broken: {
        llmApiUrl: "",
        llmApiKey: "sk-broken",
        llmModel: "",
      },
    },
  },
  "Broken",
);
assert.equal(
  invalidTaskPresetSelection.source,
  "global-fallback-invalid-task-preset",
);
assert.equal(
  invalidTaskPresetSelection.fallbackReason,
  "selected_task_preset_incomplete",
);
assert.deepEqual(invalidTaskPresetSelection.config, {
  llmApiUrl: "https://global.example/v1",
  llmApiKey: "sk-global",
  llmModel: "model-global",
});

console.log("llm-preset-utils tests passed");
