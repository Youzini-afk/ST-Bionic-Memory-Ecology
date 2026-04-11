import assert from "node:assert/strict";
import {
  installResolveHooks,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__taskRegexTestExtensionSettings || {};",
  "export function getContext(...args) {",
  "  return globalThis.SillyTavern?.getContext?.(...args) || null;",
  "}",
].join("\n");
const extensionsShimUrl = `data:text/javascript,${encodeURIComponent(
  extensionsShimSource,
)}`;
const regexEngineShimSource = [
  "export const regex_placement = { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };",
  "export function getRegexedString(...args) {",
  "  const fn = globalThis.__taskRegexTestCoreGetRegexedString;",
  "  return typeof fn === 'function' ? fn(...args) : String(args?.[0] ?? '');",
  "}",
].join("\n");
const regexEngineShimUrl = `data:text/javascript,${encodeURIComponent(
  regexEngineShimSource,
)}`;

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: extensionsShimUrl,
  },
  {
    specifiers: ["../../../../regex/engine.js"],
    url: regexEngineShimUrl,
  },
]);

const originalSillyTavern = globalThis.SillyTavern;
const originalGetTavernRegexes = globalThis.getTavernRegexes;
const originalIsCharacterTavernRegexesEnabled =
  globalThis.isCharacterTavernRegexesEnabled;
const originalExtensionSettings = globalThis.__taskRegexTestExtensionSettings;
const originalCoreGetRegexedString = globalThis.__taskRegexTestCoreGetRegexedString;

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

function setCoreRegexedStringHandler(handler = null) {
  if (typeof handler === "function") {
    globalThis.__taskRegexTestCoreGetRegexedString = handler;
    return;
  }
  delete globalThis.__taskRegexTestCoreGetRegexedString;
}

try {
  const { initializeHostAdapter } = await import("../host/adapter/index.js");
  const { applyHostRegexReuse, applyTaskRegex, inspectTaskRegexReuse } = await import(
    "../prompting/task-regex.js"
  );
  const {
    createDefaultGlobalTaskRegex,
    createDefaultTaskProfiles,
    isTaskRegexStageEnabled,
    normalizeTaskProfile,
    normalizeTaskRegexStages,
  } = await import("../prompting/prompt-profiles.js");
  const initializeFallbackHostAdapter = () =>
    initializeHostAdapter({ disableCoreRegexBridge: true });

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
    true,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "input.recentMessages"),
    true,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "input.candidateText"),
    true,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "output.rawResponse"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "output.beforeParse"),
    false,
  );
  assert.equal(
    isTaskRegexStageEnabled(defaultExtractStages, "output"),
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

  setTestContext({
    extensionSettings: {
      regex: [],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  const coreFormatterCalls = [];
  setCoreRegexedStringHandler((text, placement, options) => {
    coreFormatterCalls.push({ text, placement, options });
    return String(text || "").replace(/Alpha/g, "CORE");
  });
  initializeHostAdapter({});
  const coreBridgeDebug = { entries: [] };
  const coreBridgeOutput = applyHostRegexReuse(
    buildSettings(),
    "extract",
    "Alpha Beta",
    {
      sourceType: "user_input",
      role: "user",
      debugCollector: coreBridgeDebug,
    },
  );
  assert.equal(coreBridgeOutput.text, "CORE Beta");
  assert.deepEqual(coreFormatterCalls, [
    {
      text: "Alpha Beta",
      placement: 1,
      options: {
        isPrompt: true,
        isMarkdown: false,
      },
    },
  ]);
  assert.equal(coreBridgeDebug.entries[0].executionMode, "host-real");
  assert.equal(
    inspectTaskRegexReuse(buildSettings(), "extract").host.bridgeTier,
    "core-real",
  );
  setCoreRegexedStringHandler(null);

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
  const formatterCalls = [];
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
      formatAsTavernRegexedString(text, source, destination, options) {
        formatterCalls.push({ text, source, destination, options });
        return String(text || "").replace(/Alpha/g, "HOST");
      },
    },
  });

  const fullBridgeDebug = { entries: [] };
  const fullBridgeOutput = applyHostRegexReuse(
    fullBridgeSettings,
    "extract",
    "Alpha Beta",
    {
      sourceType: "user_input",
      role: "user",
      debugCollector: fullBridgeDebug,
    },
  );

  assert.equal(fullBridgeOutput.text, "HOST Beta");
  assert.deepEqual(bridgeCalls, [
    { type: "global" },
    { type: "preset", name: "in_use" },
    { type: "character", name: "current" },
  ]);
  assert.deepEqual(formatterCalls, [
    {
      text: "Alpha Beta",
      source: "user_input",
      destination: "prompt",
      options: {
        isPrompt: true,
        isMarkdown: false,
      },
    },
  ]);
  assert.equal(fullBridgeDebug.entries[0].executionMode, "host-helper");
  assert.deepEqual(
    fullBridgeDebug.entries[0].appliedRules.map((item) => item.id),
    ["__host_formatter__"],
  );
  assert.equal(
    inspectTaskRegexReuse(fullBridgeSettings, "extract").host.bridgeTier,
    "helper-bridge",
  );
  assert.equal(
    applyTaskRegex(
      fullBridgeSettings,
      "extract",
      "input.finalPrompt",
      "Beta",
      { entries: [] },
      "system",
    ),
    "B",
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
  initializeFallbackHostAdapter();

  const fallbackDebug = { entries: [] };
  const fallbackOutput = applyHostRegexReuse(
    buildSettings(),
    "extract",
    "Gamma",
    {
      sourceType: "world_info",
      role: "system",
      debugCollector: fallbackDebug,
    },
  );
  assert.equal(fallbackOutput.text, "C1");
  assert.equal(fallbackDebug.entries[0].executionMode, "host-fallback");

  setTestContext({
    extensionSettings: {
      regex: [
        createTavernRule("depth-aware", "/Gamma/g", "DEPTH", {
          placement: [PLACEMENT.WORLD_INFO],
          minDepth: 1,
          maxDepth: 1,
        }),
      ],
      preset_allowed_regex: {},
      character_allowed_regex: [],
    },
  });
  initializeFallbackHostAdapter();
  const depthMissResult = applyHostRegexReuse(
    buildSettings({
      sources: {
        global: true,
        preset: false,
        character: false,
      },
    }),
    "extract",
    "Gamma",
    {
      sourceType: "world_info",
      role: "system",
      formatterOptions: {
        depth: 0,
      },
      debugCollector: { entries: [] },
    },
  );
  const depthHitResult = applyHostRegexReuse(
    buildSettings({
      sources: {
        global: true,
        preset: false,
        character: false,
      },
    }),
    "extract",
    "Gamma",
    {
      sourceType: "world_info",
      role: "system",
      formatterOptions: {
        depth: 1,
      },
      debugCollector: { entries: [] },
    },
  );
  assert.equal(depthMissResult.text, "Gamma");
  assert.equal(depthHitResult.text, "DEPTH");

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
  initializeFallbackHostAdapter();
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
  initializeFallbackHostAdapter();

  const disallowedOutput = applyHostRegexReuse(
    buildSettings(),
    "extract",
    "Gamma",
    {
      sourceType: "world_info",
      role: "system",
      debugCollector: { entries: [] },
    },
  );
  assert.equal(disallowedOutput.text, "G2");

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
  initializeFallbackHostAdapter();

  const userReuseResult = applyHostRegexReuse(
    tavernSemanticsSettings,
    "extract",
    "Alpha",
    {
      sourceType: "user_input",
      role: "user",
      debugCollector: { entries: [] },
    },
  );
  assert.equal(userReuseResult.text, "A");
  assert.equal(userReuseResult.executionMode, "host-fallback");
  assert.equal(userReuseResult.skippedDisplayOnlyRuleCount >= 1, true);
  const aiReuseResult = applyHostRegexReuse(
    tavernSemanticsSettings,
    "extract",
    "Answer Lore",
    {
      sourceType: "ai_output",
      role: "assistant",
      debugCollector: { entries: [] },
    },
  );
  assert.equal(aiReuseResult.text, "AI Lore");
  assert.equal(aiReuseResult.executionMode, "host-fallback");
  const markdownInspect = inspectTaskRegexReuse(tavernSemanticsSettings, "extract");
  const markdownRule = markdownInspect.activeRules.find(
    (rule) => rule.id === "markdown-only",
  );
  assert.equal(markdownRule?.promptReplaceAsEmpty, false);
  assert.equal(markdownRule?.effectivePromptReplaceString, "<b>M</b>");
  assert.deepEqual(markdownRule?.placementLabels, ["用户输入"]);
  assert.equal(markdownRule?.promptStageMode, "display-only");
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
  initializeFallbackHostAdapter();
  const markdownFinalDebug = { entries: [] };
  const markdownFallbackResult = applyHostRegexReuse(
    markdownOnlyFinalPromptSettings,
    "extract",
    "Decor",
    {
      sourceType: "user_input",
      role: "user",
      debugCollector: markdownFinalDebug,
    },
  );
  assert.equal(markdownFallbackResult.text, "Decor");
  assert.equal(markdownFallbackResult.skippedDisplayOnlyRuleCount, 1);
  assert.deepEqual(markdownFinalDebug.entries[0].appliedRules, []);
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
  initializeFallbackHostAdapter();
  const beautifyFinalInspect = inspectTaskRegexReuse(
    beautifyFinalPromptSettings,
    "extract",
  );
  const beautifyFinalRule = beautifyFinalInspect.activeRules.find(
    (rule) => rule.id === "beautify-final-strip",
  );
  assert.equal(beautifyFinalRule?.promptReplaceAsEmpty, false);
  assert.equal(beautifyFinalRule?.promptStageMode, "fallback-skip-beautify");
  const beautifyFinalDebug = { entries: [] };
  const beautifyFallbackResult = applyHostRegexReuse(
    beautifyFinalPromptSettings,
    "extract",
    "Decor",
    {
      sourceType: "user_input",
      role: "user",
      debugCollector: beautifyFinalDebug,
    },
  );
  assert.equal(beautifyFallbackResult.text, "Decor");
  assert.equal(beautifyFallbackResult.skippedDisplayOnlyRuleCount, 1);
  assert.deepEqual(beautifyFinalDebug.entries[0].appliedRules, []);
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
  assert.equal(beautifyStageOffRule?.promptStageMode, "fallback-skip-beautify");
  assert.equal(beautifyStageOffRule?.promptStageApplies, false);
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
  initializeFallbackHostAdapter();
  const destinationDebug = { entries: [] };
  const destinationReuseResult = applyHostRegexReuse(
    destinationBeautifySettings,
    "extract",
    "DecorPlain",
    {
      sourceType: "user_input",
      role: "user",
      debugCollector: destinationDebug,
    },
  );
  assert.equal(destinationReuseResult.text, "DecorPlain");
  assert.equal(destinationReuseResult.skippedDisplayOnlyRuleCount, 2);
  assert.deepEqual(destinationDebug.entries[0].appliedRules, []);
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
  assert.equal(destinationBeautifyRule?.promptReplaceAsEmpty, false);
  assert.equal(destinationBeautifyRule?.promptStageMode, "display-only");
  assert.equal(destinationTextRule?.promptReplaceAsEmpty, false);
  assert.equal(destinationTextRule?.promptStageMode, "display-only");
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
  initializeFallbackHostAdapter();
  const mixedReuseResult = applyHostRegexReuse(
    tavernSemanticsSettings,
    "extract",
    "User Reply Lore",
    {
      sourceType: "ai_output",
      role: "assistant",
      debugCollector: { entries: [] },
    },
  );
  assert.equal(mixedReuseResult.text, "User R Lore");

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

  const defaultGlobalRegex = createDefaultGlobalTaskRegex();
  assert.deepEqual(
    defaultGlobalRegex.localRules.map((rule) => rule.id),
    [
      "default-contamination-thinking-blocks",
      "default-contamination-choice-blocks",
      "default-contamination-updatevariable-tags",
      "default-contamination-status-current-variable-tags",
      "default-contamination-status-placeholder-tags",
    ],
  );

  const globalDefaultDebug = { entries: [] };
  const globalDefaultResult = applyTaskRegex(
    {
      taskProfiles: createDefaultTaskProfiles(),
      globalTaskRegex: createDefaultGlobalTaskRegex(),
    },
    "extract",
    "input.recentMessages",
    [
      "前缀",
      "<thinking>内部思维</thinking>",
      "<choice>1. 选项</choice>",
      "<UpdateVariable>hp=1</UpdateVariable>",
      "<status_current_variable>hp=1</status_current_variable>",
      "<StatusPlaceHolderImpl/>",
      "尾巴",
    ].join("\n"),
    globalDefaultDebug,
    "system",
  );
  assert.match(globalDefaultResult, /前缀/);
  assert.match(globalDefaultResult, /尾巴/);
  assert.doesNotMatch(
    globalDefaultResult,
    /<choice|<thinking|<updatevariable|<status_current_variable|<StatusPlaceHolderImpl/i,
  );
  assert.deepEqual(
    globalDefaultDebug.entries[0].appliedRules.map((item) => item.id),
    [
      "default-contamination-thinking-blocks",
      "default-contamination-choice-blocks",
      "default-contamination-updatevariable-tags",
      "default-contamination-status-current-variable-tags",
      "default-contamination-status-placeholder-tags",
    ],
  );
  assert.equal(globalDefaultDebug.entries[0].sourceCount.local, 5);

  const explicitEmptyGlobalDebug = { entries: [] };
  const explicitEmptyGlobalResult = applyTaskRegex(
    {
      taskProfiles: createDefaultTaskProfiles(),
      globalTaskRegex: {
        enabled: true,
        inheritStRegex: false,
        sources: {
          global: false,
          preset: false,
          character: false,
        },
        stages: {
          "input.userMessage": true,
          "input.recentMessages": true,
          "input.candidateText": true,
          "input.finalPrompt": false,
          "output.rawResponse": false,
          "output.beforeParse": false,
          output: false,
        },
        localRules: [],
      },
    },
    "extract",
    "input.recentMessages",
    "<choice>保留</choice><thinking>保留</thinking>",
    explicitEmptyGlobalDebug,
    "system",
  );
  assert.equal(
    explicitEmptyGlobalResult,
    "<choice>保留</choice><thinking>保留</thinking>",
  );
  assert.deepEqual(explicitEmptyGlobalDebug.entries[0].appliedRules, []);
  assert.equal(explicitEmptyGlobalDebug.entries[0].sourceCount.local, 0);

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

  if (originalCoreGetRegexedString === undefined) {
    delete globalThis.__taskRegexTestCoreGetRegexedString;
  } else {
    globalThis.__taskRegexTestCoreGetRegexedString = originalCoreGetRegexedString;
  }

  try {
    const { initializeHostAdapter } = await import("../host/adapter/index.js");
    initializeHostAdapter({});
  } catch {
    // ignore reset failures in test cleanup
  }
}
