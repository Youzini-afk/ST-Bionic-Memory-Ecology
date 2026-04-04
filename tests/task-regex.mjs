import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__taskRegexTestExtensionSettings || {};",
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: extensionsShimUrl,
      };
    }
    return nextResolve(specifier, context);
  },
});

const originalSillyTavern = globalThis.SillyTavern;
const originalGetTavernRegexes = globalThis.getTavernRegexes;
const originalIsCharacterTavernRegexesEnabled =
  globalThis.isCharacterTavernRegexesEnabled;
const originalExtensionSettings = globalThis.__taskRegexTestExtensionSettings;

function createRule(id, find, replace, overrides = {}) {
  return {
    id,
    script_name: id,
    enabled: true,
    find_regex: find,
    replace_string: replace,
    source: {
      user_input: true,
      ai_output: true,
      ...(overrides.source || {}),
    },
    destination: {
      prompt: true,
      display: false,
      ...(overrides.destination || {}),
    },
    ...overrides,
  };
}

try {
  globalThis.__taskRegexTestExtensionSettings = {
    regex: {
      regex_scripts: [createRule("legacy-global", "/Gamma/g", "G")],
    },
  };

  globalThis.SillyTavern = {
    getContext() {
      return {
        extensionSettings: globalThis.__taskRegexTestExtensionSettings,
        chatCompletionSettings: {
          regex_scripts: [createRule("legacy-preset", "/Delta/g", "D")],
        },
        characterId: 0,
        characters: [
          {
            extensions: {
              regex_scripts: [
                createRule("legacy-character", "/Epsilon/g", "E"),
              ],
            },
          },
        ],
      };
    },
  };

  globalThis.getTavernRegexes = () => {
    throw new Error(
      "legacy global getter should not be used when bridge exists",
    );
  };
  globalThis.isCharacterTavernRegexesEnabled = () => {
    throw new Error(
      "legacy character toggle should not be used when bridge full capability exists",
    );
  };

  const { initializeHostAdapter } = await import("../host-adapter/index.js");
  const { applyTaskRegex } = await import("../task-regex.js");

  const settings = {
    taskProfiles: {
      extract: {
        activeProfileId: "bridge-profile",
        profiles: [
          {
            id: "bridge-profile",
            name: "Regex Bridge Test",
            taskType: "extract",
            builtin: false,
            blocks: [],
            regex: {
              enabled: true,
              inheritStRegex: true,
              sources: {
                global: true,
                preset: true,
                character: true,
              },
              stages: {
                input: true,
                output: true,
              },
              localRules: [createRule("local-tail", "/Beta/g", "B")],
            },
          },
        ],
      },
    },
  };

  const bridgeCalls = [];
  initializeHostAdapter({
    regexProvider: {
      getTavernRegexes(request) {
        bridgeCalls.push(request);
        if (request?.type === "global") {
          return [createRule("bridge-global", "/Alpha/g", "A")];
        }
        if (request?.type === "preset") {
          return [createRule("bridge-preset", "/A/g", "P")];
        }
        if (request?.type === "character") {
          return [createRule("bridge-character", "/P/g", "C")];
        }
        return [];
      },
      isCharacterTavernRegexesEnabled() {
        return true;
      },
    },
  });

  const fullBridgeDebug = { entries: [] };
  const fullBridgeOutput = applyTaskRegex(
    settings,
    "extract",
    "finalPrompt",
    "Alpha Beta",
    fullBridgeDebug,
    "system",
  );

  assert.equal(fullBridgeOutput, "C B");
  assert.deepEqual(bridgeCalls, [
    { type: "global" },
    { type: "preset", name: "in_use" },
    { type: "character", name: "current" },
  ]);
  assert.deepEqual(
    fullBridgeDebug.entries[0].appliedRules.map((item) => item.id),
    ["bridge-global", "bridge-preset", "bridge-character", "local-tail"],
  );
  assert.deepEqual(fullBridgeDebug.entries[0].sourceCount, {
    tavern: 3,
    local: 1,
  });

  const partialBridgeCalls = [];
  initializeHostAdapter({
    regexProvider: {
      getTavernRegexes(request) {
        partialBridgeCalls.push(request);
        if (request?.type === "global") {
          return [createRule("partial-global", "/Gamma/g", "G1")];
        }
        return [];
      },
    },
  });

  const partialBridgeDebug = { entries: [] };
  const partialBridgeOutput = applyTaskRegex(
    settings,
    "extract",
    "finalPrompt",
    "Gamma Delta Epsilon",
    partialBridgeDebug,
    "system",
  );

  assert.equal(partialBridgeOutput, "G1 Delta E");
  assert.deepEqual(partialBridgeCalls, [
    { type: "global" },
    { type: "preset", name: "in_use" },
  ]);
  assert.deepEqual(
    partialBridgeDebug.entries[0].appliedRules.map((item) => item.id),
    ["partial-global", "legacy-character"],
  );
  assert.deepEqual(partialBridgeDebug.entries[0].sourceCount, {
    tavern: 2,
    local: 1,
  });

  const emptyBridgeCalls = [];
  initializeHostAdapter({
    regexProvider: {
      getTavernRegexes(request) {
        emptyBridgeCalls.push(request);
        if (request?.type === "global") {
          return [];
        }
        if (request?.type === "preset") {
          return [createRule("bridge-preset-empty-guard", "/Theta/g", "T")];
        }
        if (request?.type === "character") {
          return [createRule("bridge-character-empty-guard", "/T/g", "C2")];
        }
        return [];
      },
      isCharacterTavernRegexesEnabled() {
        return true;
      },
    },
  });

  const emptyBridgeDebug = { entries: [] };
  const emptyBridgeOutput = applyTaskRegex(
    settings,
    "extract",
    "finalPrompt",
    "Gamma Theta",
    emptyBridgeDebug,
    "system",
  );

  assert.equal(emptyBridgeOutput, "Gamma C2");
  assert.deepEqual(emptyBridgeCalls, [
    { type: "global" },
    { type: "preset", name: "in_use" },
    { type: "character", name: "current" },
  ]);
  assert.deepEqual(
    emptyBridgeDebug.entries[0].appliedRules.map((item) => item.id),
    ["bridge-preset-empty-guard", "bridge-character-empty-guard"],
  );
  assert.equal(
    emptyBridgeDebug.entries[0].appliedRules.some(
      (item) => item.id === "legacy-global",
    ),
    false,
  );
  assert.deepEqual(emptyBridgeDebug.entries[0].sourceCount, {
    tavern: 2,
    local: 1,
  });

  const outputGuardSettings = {
    taskProfiles: {
      extract: {
        activeProfileId: "output-guard",
        profiles: [
          {
            id: "output-guard",
            name: "Output Guard",
            taskType: "extract",
            builtin: false,
            blocks: [],
            regex: {
              enabled: true,
              inheritStRegex: false,
              stages: {
                input: true,
                output: true,
                "output.rawResponse": true,
              },
              localRules: [
                createRule("display-only-output", "/美化/g", "<b>美化</b>", {
                  destination: {
                    prompt: false,
                    display: true,
                  },
                }),
                createRule("prompt-output", "/JSON/g", "DONE", {
                  destination: {
                    prompt: true,
                    display: false,
                  },
                }),
              ],
            },
          },
        ],
      },
    },
  };
  const outputGuardDebug = { entries: [] };
  const outputGuardResult = applyTaskRegex(
    outputGuardSettings,
    "extract",
    "output.rawResponse",
    "JSON 美化",
    outputGuardDebug,
    "assistant",
  );
  assert.equal(outputGuardResult, "DONE 美化");
  assert.deepEqual(
    outputGuardDebug.entries[0].appliedRules.map((item) => item.id),
    ["prompt-output"],
  );

  const exactStageSettings = {
    taskProfilesVersion: 1,
    taskProfiles: {
      extract: {
        activeProfileId: "default",
        profiles: [
          {
            id: "default",
            taskType: "extract",
            regex: {
              enabled: true,
              inheritStRegex: false,
              sources: {
                global: false,
                preset: false,
                character: false,
              },
              stages: {
                output: true,
                "output.rawResponse": false,
                "output.beforeParse": true,
              },
              localRules: [
                createRule("exact-stage", "/JSON/g", "DONE", {
                  destination: {
                    prompt: true,
                    display: false,
                  },
                }),
              ],
            },
          },
        ],
      },
    },
  };
  const exactStageDebug = { entries: [] };
  const exactStageResult = applyTaskRegex(
    exactStageSettings,
    "extract",
    "output.rawResponse",
    "JSON",
    exactStageDebug,
    "assistant",
  );
  assert.equal(exactStageResult, "JSON");
  assert.deepEqual(exactStageDebug.entries[0].appliedRules, []);

  const legacyStageCompatibilitySettings = {
    taskProfilesVersion: 1,
    taskProfiles: {
      extract: {
        activeProfileId: "legacy-stage-compat",
        profiles: [
          {
            id: "legacy-stage-compat",
            taskType: "extract",
            regex: {
              enabled: true,
              inheritStRegex: false,
              sources: {
                global: false,
                preset: false,
                character: false,
              },
              stages: {
                input: true,
                output: true,
                "input.userMessage": false,
                "input.recentMessages": false,
                "input.candidateText": false,
                "input.finalPrompt": false,
                "output.rawResponse": false,
                "output.beforeParse": false,
              },
              localRules: [
                createRule("legacy-input-user", "/Alpha/g", "A1"),
                createRule("legacy-output-raw", "/Omega/g", "O1", {
                  source: {
                    user_input: false,
                    ai_output: true,
                  },
                }),
              ],
            },
          },
        ],
      },
    },
  };

  const legacyStageInputDebug = { entries: [] };
  const legacyStageInputResult = applyTaskRegex(
    legacyStageCompatibilitySettings,
    "extract",
    "input.userMessage",
    "Alpha",
    legacyStageInputDebug,
    "user",
  );
  assert.equal(legacyStageInputResult, "A1");
  assert.deepEqual(
    legacyStageInputDebug.entries[0].appliedRules.map((item) => item.id),
    ["legacy-input-user"],
  );

  const legacyStageOutputDebug = { entries: [] };
  const legacyStageOutputResult = applyTaskRegex(
    legacyStageCompatibilitySettings,
    "extract",
    "output.rawResponse",
    "Omega",
    legacyStageOutputDebug,
    "assistant",
  );
  assert.equal(legacyStageOutputResult, "O1");
  assert.deepEqual(
    legacyStageOutputDebug.entries[0].appliedRules.map((item) => item.id),
    ["legacy-output-raw"],
  );

  console.log("task-regex tests passed");
} finally {
  if (originalSillyTavern === undefined) {
    delete globalThis.SillyTavern;
  } else {
    globalThis.SillyTavern = originalSillyTavern;
  }

  if (originalGetTavernRegexes === undefined) {
    delete globalThis.getTavernRegexes;
  } else {
    globalThis.getTavernRegexes = originalGetTavernRegexes;
  }

  if (originalIsCharacterTavernRegexesEnabled === undefined) {
    delete globalThis.isCharacterTavernRegexesEnabled;
  } else {
    globalThis.isCharacterTavernRegexesEnabled =
      originalIsCharacterTavernRegexesEnabled;
  }

  if (originalExtensionSettings === undefined) {
    delete globalThis.__taskRegexTestExtensionSettings;
  } else {
    globalThis.__taskRegexTestExtensionSettings = originalExtensionSettings;
  }

  try {
    const { initializeHostAdapter } = await import("../host-adapter/index.js");
    initializeHostAdapter({});
  } catch {
    // ignore reset failures in test cleanup
  }
}
