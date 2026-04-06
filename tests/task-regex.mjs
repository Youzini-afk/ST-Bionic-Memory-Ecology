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

const PLACEMENT = Object.freeze({
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  WORLD_INFO: 5,
  REASONING: 6,
});

function createLocalRule(id, find, replace, overrides = {}) {
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

function createTavernRule(id, findRegex, replaceString, overrides = {}) {
  return {
    id,
    scriptName: id,
    enabled: true,
    findRegex,
    replaceString,
    trimStrings: [],
    placement: [PLACEMENT.WORLD_INFO],
    promptOnly: false,
    markdownOnly: false,
    minDepth: null,
    maxDepth: null,
    ...overrides,
  };
}

function buildSettings(regex = {}) {
  return {
    taskProfiles: {
      extract: {
        activeProfileId: "default",
        profiles: [
          {
            id: "default",
            name: "Regex Test",
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
                "input.userMessage": true,
                "input.recentMessages": true,
                "input.candidateText": true,
                "input.finalPrompt": true,
                "output.rawResponse": true,
                "output.beforeParse": true,
              },
              localRules: [],
              ...regex,
            },
          },
        ],
      },
    },
  };
}

function setTestContext({
  extensionSettings,
  presetScripts = [],
  presetName = "Live Preset",
  apiId = "openai",
  characterId = 0,
  characters = [],
} = {}) {
  globalThis.__taskRegexTestExtensionSettings = extensionSettings;
  globalThis.SillyTavern = {
    getContext() {
      return {
        extensionSettings,
        characterId,
        characters,
        getPresetManager() {
          return {
            apiId,
            getSelectedPresetName() {
              return presetName;
            },
            readPresetExtensionField({ path } = {}) {
              return path === "regex_scripts" ? presetScripts : [];
            },
          };
        },
      };
    },
  };
}

try {
  const { initializeHostAdapter } = await import("../host-adapter/index.js");
  const { applyTaskRegex, inspectTaskRegexReuse } = await import(
    "../task-regex.js"
  );
  const {
    createDefaultTaskProfiles,
    isTaskRegexStageEnabled,
    normalizeTaskProfile,
    normalizeTaskRegexStages,
  } = await import("../prompt-profiles.js");

  const normalizedLegacyStages = normalizeTaskRegexStages({
    finalPrompt: true,
    "input.userMessage": false,
    "input.recentMessages": false,
    "input.candidateText": false,
    "input.finalPrompt": false,
    rawResponse: false,
    beforeParse: false,
    "output.rawResponse": false,
    "output.beforeParse": false,
  });
  assert.equal(normalizedLegacyStages["input.finalPrompt"], false);
  assert.equal(normalizedLegacyStages["input.userMessage"], false);
  assert.equal(normalizedLegacyStages["input.recentMessages"], false);
  assert.equal(normalizedLegacyStages["input.candidateText"], false);
  assert.equal(normalizedLegacyStages["output.rawResponse"], false);
  assert.equal(normalizedLegacyStages["output.beforeParse"], false);
  assert.equal(
    isTaskRegexStageEnabled(normalizedLegacyStages, "input.finalPrompt"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(normalizedLegacyStages, "input.userMessage"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(normalizedLegacyStages, "input.recentMessages"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(normalizedLegacyStages, "input.candidateText"),
    false,
  );

  const defaultProfiles = createDefaultTaskProfiles();
  const defaultExtractStages =
    defaultProfiles.extract?.profiles?.[0]?.regex?.stages || {};
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "input.finalPrompt"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "input.userMessage"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "input.recentMessages"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "input.candidateText"),
    false,
  );

  const normalizedLegacyOnlyProfile = normalizeTaskProfile(
    "extract",
    {
      id: "legacy-only-profile",
      name: "legacy only",
      regex: {
        stages: {
          finalPrompt: true,
        },
      },
    },
    {},
  );
  assert.equal(
    isTaskRegexStageEnabled(
      normalizedLegacyOnlyProfile.regex?.stages || {},
      "input.finalPrompt",
    ),
    true,
  );

  globalThis.getTavernRegexes = () => {
    throw new Error("legacy global getter should not be used in regex tests");
  };
  globalThis.isCharacterTavernRegexesEnabled = () => {
    throw new Error(
      "legacy character toggle should not be used in regex tests",
    );
  };

  setTestContext({
    extensionSettings: {
      regex: [],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });

  const fullBridgeSettings = buildSettings({
    localRules: [createLocalRule("local-tail", "/Beta/g", "B")],
  });
  const bridgeCalls = [];
  initializeHostAdapter({
    regexProvider: {
      getTavernRegexes(request) {
        bridgeCalls.push(request);
        if (request?.type === "global") {
          return [
            createTavernRule("bridge-global", "/Alpha/g", "A", {
              promptOnly: true,
            }),
          ];
        }
        if (request?.type === "preset") {
          return [
            createTavernRule("bridge-preset", "/A/g", "P", {
              promptOnly: true,
            }),
          ];
        }
        if (request?.type === "character") {
          return [
            createTavernRule("bridge-character", "/P/g", "C", {
              promptOnly: true,
            }),
          ];
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
    fullBridgeSettings,
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

  const fallbackExtensionSettings = {
    regex: [
      createTavernRule("global-fallback", "/Gamma/g", "G1", {
        promptOnly: true,
      }),
    ],
    preset_allowed_regex: {
      openai: ["Live Preset"],
    },
    character_allowed_regex: ["hero.png"],
  };
  setTestContext({
    extensionSettings: fallbackExtensionSettings,
    presetScripts: [
      createTavernRule("preset-fallback", "/G1/g", "P1", {
        promptOnly: true,
      }),
    ],
    characters: [
      {
        avatar: "hero.png",
        data: {
          extensions: {
            regex_scripts: [
              createTavernRule("character-fallback", "/P1/g", "C1", {
                promptOnly: true,
              }),
            ],
          },
        },
      },
    ],
  });
  initializeHostAdapter({});

  const fallbackDebug = { entries: [] };
  const fallbackOutput = applyTaskRegex(
    buildSettings(),
    "extract",
    "input.finalPrompt",
    "Gamma",
    fallbackDebug,
    "system",
  );
  assert.equal(fallbackOutput, "C1");

  const fallbackInspect = inspectTaskRegexReuse(buildSettings(), "extract");
  assert.equal(fallbackInspect.activeRuleCount, 3);
  assert.deepEqual(
    fallbackInspect.activeRules.map((rule) => rule.id),
    ["global-fallback", "preset-fallback", "character-fallback"],
  );
  assert.equal(
    fallbackInspect.sources.find((source) => source.type === "preset")
      ?.resolvedVia,
    "fallback",
  );
  assert.equal(
    fallbackInspect.sources.find((source) => source.type === "character")
      ?.allowed,
    true,
  );

  const disallowedExtensionSettings = {
    regex: [
      createTavernRule("global-only", "/Gamma/g", "G2", {
        promptOnly: true,
      }),
    ],
    preset_allowed_regex: {},
    character_allowed_regex: [],
  };
  setTestContext({
    extensionSettings: disallowedExtensionSettings,
    presetScripts: [
      createTavernRule("preset-blocked", "/G2/g", "P2", {
        promptOnly: true,
      }),
    ],
    characters: [
      {
        avatar: "blocked.png",
        data: {
          extensions: {
            regex_scripts: [
              createTavernRule("character-blocked", "/P2/g", "C2", {
                promptOnly: true,
              }),
            ],
          },
        },
      },
    ],
  });
  initializeHostAdapter({});

  const disallowedOutput = applyTaskRegex(
    buildSettings(),
    "extract",
    "input.finalPrompt",
    "Gamma",
    { entries: [] },
    "system",
  );
  assert.equal(disallowedOutput, "G2");

  const disallowedInspect = inspectTaskRegexReuse(buildSettings(), "extract");
  assert.equal(disallowedInspect.activeRuleCount, 1);
  assert.equal(
    disallowedInspect.sources.find((source) => source.type === "preset")
      ?.allowed,
    false,
  );
  assert.equal(
    disallowedInspect.sources.find((source) => source.type === "character")
      ?.allowed,
    false,
  );

  const tavernSemanticsSettings = buildSettings({
    sources: {
      global: true,
      preset: false,
      character: false,
    },
  });
  setTestContext({
    extensionSettings: {
      regex: [
        createTavernRule("user-prompt-only", "/Alpha/g", "A", {
          placement: [PLACEMENT.USER_INPUT],
          promptOnly: true,
        }),
        createTavernRule("markdown-only", "/Alpha/g", "<b>M</b>", {
          placement: [PLACEMENT.USER_INPUT],
          markdownOnly: true,
        }),
        createTavernRule("output-only", "/Answer/g", "AI", {
          placement: [PLACEMENT.AI_OUTPUT],
        }),
        createTavernRule("world-info-only", "/Lore/g", "SYS", {
          placement: [PLACEMENT.WORLD_INFO],
        }),
        createTavernRule("recent-user", "/User/g", "U", {
          placement: [PLACEMENT.USER_INPUT],
        }),
        createTavernRule("recent-ai", "/Reply/g", "R", {
          placement: [PLACEMENT.AI_OUTPUT],
        }),
      ],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  initializeHostAdapter({});

  assert.equal(
    applyTaskRegex(
      tavernSemanticsSettings,
      "extract",
      "input.userMessage",
      "Alpha",
      { entries: [] },
      "user",
    ),
    "",
  );
  assert.equal(
    applyTaskRegex(
      tavernSemanticsSettings,
      "extract",
      "input.finalPrompt",
      "Alpha",
      { entries: [] },
      "user",
    ),
    "A",
  );
  assert.equal(
    applyTaskRegex(
      tavernSemanticsSettings,
      "extract",
      "output.rawResponse",
      "Answer Lore",
      { entries: [] },
      "assistant",
    ),
    "AI Lore",
  );
  const markdownInspect = inspectTaskRegexReuse(tavernSemanticsSettings, "extract");
  const markdownRule = markdownInspect.activeRules.find(
    (rule) => rule.id === "markdown-only",
  );
  assert.equal(markdownRule?.promptReplaceAsEmpty, true);
  assert.equal(markdownRule?.effectivePromptReplaceString, "");
  assert.deepEqual(markdownRule?.placementLabels, ["用户输入"]);
  assert.equal(markdownRule?.promptStageMode, "clear");
  const markdownOnlyFinalPromptSettings = buildSettings({
    sources: {
      global: true,
      preset: false,
      character: false,
    },
  });
  setTestContext({
    extensionSettings: {
      regex: [
        createTavernRule("markdown-final-strip", "/Decor/g", "<span>Decor</span>", {
          placement: [PLACEMENT.USER_INPUT],
          markdownOnly: true,
        }),
      ],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  initializeHostAdapter({});
  const markdownFinalDebug = { entries: [] };
  assert.equal(
    applyTaskRegex(
      markdownOnlyFinalPromptSettings,
      "extract",
      "input.finalPrompt",
      "Decor",
      markdownFinalDebug,
      "user",
    ),
    "",
  );
  assert.deepEqual(
    markdownFinalDebug.entries[0].appliedRules.map((item) => item.id),
    ["markdown-final-strip"],
  );
  const beautifyFinalPromptSettings = buildSettings({
    sources: {
      global: true,
      preset: false,
      character: false,
    },
  });
  setTestContext({
    extensionSettings: {
      regex: [
        createTavernRule("beautify-final-strip", "/Decor/g", "<div class=\"pretty\">Decor</div>", {
          placement: [PLACEMENT.USER_INPUT],
          markdownOnly: false,
        }),
      ],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  initializeHostAdapter({});
  const beautifyFinalInspect = inspectTaskRegexReuse(
    beautifyFinalPromptSettings,
    "extract",
  );
  const beautifyFinalRule = beautifyFinalInspect.activeRules.find(
    (rule) => rule.id === "beautify-final-strip",
  );
  assert.equal(beautifyFinalRule?.promptReplaceAsEmpty, true);
  assert.equal(beautifyFinalRule?.promptStageMode, "clear");
  const beautifyFinalDebug = { entries: [] };
  assert.equal(
    applyTaskRegex(
      beautifyFinalPromptSettings,
      "extract",
      "input.finalPrompt",
      "Decor",
      beautifyFinalDebug,
      "user",
    ),
    "",
  );
  assert.deepEqual(
    beautifyFinalDebug.entries[0].appliedRules.map((item) => item.id),
    ["beautify-final-strip"],
  );
  const beautifyFinalPromptStageOffSettings = buildSettings({
    stages: {
      input: true,
      output: true,
      "input.userMessage": true,
      "input.recentMessages": true,
      "input.candidateText": true,
      "input.finalPrompt": false,
      "output.rawResponse": true,
      "output.beforeParse": true,
    },
  });
  const beautifyStageOffInspect = inspectTaskRegexReuse(
    beautifyFinalPromptStageOffSettings,
    "extract",
  );
  const beautifyStageOffRule = beautifyStageOffInspect.activeRules.find(
    (rule) => rule.id === "beautify-final-strip",
  );
  assert.equal(beautifyStageOffRule?.promptStageMode, "clear");
  assert.equal(beautifyStageOffRule?.promptStageApplies, false);
  assert.equal(
    applyTaskRegex(
      beautifyFinalPromptStageOffSettings,
      "extract",
      "input.finalPrompt",
      "Decor",
      { entries: [] },
      "user",
    ),
    "Decor",
  );
  const destinationBeautifySettings = buildSettings({
    sources: {
      global: true,
      preset: false,
      character: false,
    },
  });
  setTestContext({
    extensionSettings: {
      regex: [
        createTavernRule("destination-display-only-beautify", "/Decor/g", "<span>Decor</span>", {
          placement: [],
          source: {
            user_input: true,
            ai_output: false,
          },
          destination: {
            prompt: false,
            display: true,
          },
          markdownOnly: false,
        }),
        createTavernRule("destination-display-only-text", "/Plain/g", "TEXT", {
          placement: [],
          source: {
            user_input: true,
            ai_output: false,
          },
          destination: {
            prompt: false,
            display: true,
          },
          markdownOnly: true,
        }),
      ],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  initializeHostAdapter({});
  const destinationDebug = { entries: [] };
  assert.equal(
    applyTaskRegex(
      destinationBeautifySettings,
      "extract",
      "input.finalPrompt",
      "DecorPlain",
      destinationDebug,
      "user",
    ),
    "",
  );
  assert.deepEqual(
    destinationDebug.entries[0].appliedRules.map((item) => item.id),
    ["destination-display-only-beautify", "destination-display-only-text"],
  );
  const destinationInspect = inspectTaskRegexReuse(
    destinationBeautifySettings,
    "extract",
  );
  const destinationBeautifyRule = destinationInspect.activeRules.find(
    (rule) => rule.id === "destination-display-only-beautify",
  );
  const destinationTextRule = destinationInspect.activeRules.find(
    (rule) => rule.id === "destination-display-only-text",
  );
  assert.deepEqual(destinationBeautifyRule?.placementLabels, ["用户输入"]);
  assert.equal(destinationBeautifyRule?.promptReplaceAsEmpty, true);
  assert.equal(destinationBeautifyRule?.promptStageMode, "clear");
  assert.equal(destinationTextRule?.promptReplaceAsEmpty, true);
  assert.equal(destinationTextRule?.promptStageMode, "clear");
  setTestContext({
    extensionSettings: {
      regex: [
        createTavernRule("user-prompt-only", "/Alpha/g", "A", {
          placement: [PLACEMENT.USER_INPUT],
          promptOnly: true,
        }),
        createTavernRule("markdown-only", "/Alpha/g", "<b>M</b>", {
          placement: [PLACEMENT.USER_INPUT],
          markdownOnly: true,
        }),
        createTavernRule("output-only", "/Answer/g", "AI", {
          placement: [PLACEMENT.AI_OUTPUT],
        }),
        createTavernRule("world-info-only", "/Lore/g", "SYS", {
          placement: [PLACEMENT.WORLD_INFO],
        }),
        createTavernRule("recent-user", "/User/g", "U", {
          placement: [PLACEMENT.USER_INPUT],
        }),
        createTavernRule("recent-ai", "/Reply/g", "R", {
          placement: [PLACEMENT.AI_OUTPUT],
        }),
      ],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  initializeHostAdapter({});
  assert.equal(
    applyTaskRegex(
      tavernSemanticsSettings,
      "extract",
      "input.recentMessages",
      "User Reply Lore",
      { entries: [] },
      "mixed",
    ),
    "U R Lore",
  );

  const outputGuardSettings = buildSettings({
    inheritStRegex: false,
    localRules: [
      createLocalRule("display-only-output", "/美化/g", "<b>美化</b>", {
        destination: {
          prompt: false,
          display: true,
        },
      }),
      createLocalRule("prompt-output", "/JSON/g", "DONE", {
        destination: {
          prompt: true,
          display: false,
        },
      }),
    ],
  });
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
