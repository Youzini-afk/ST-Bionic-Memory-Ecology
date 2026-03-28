import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__promptBuilderMvuExtensionSettings || {};",
  "export function getContext() {",
  "  return globalThis.__promptBuilderMvuContext || {",
  "    chat: [],",
  "    chatMetadata: {},",
  "    extensionSettings: {},",
  "    powerUserSettings: {},",
  "    characters: [],",
  "    characterId: null,",
  "    name1: '',",
  "    name2: '',",
  "    chatId: 'mvu-test-chat',",
  "  };",
  "}",
].join("\n");
const scriptShimSource = [
  "export function getRequestHeaders() {",
  "  return { 'Content-Type': 'application/json' };",
  "}",
].join("\n");
const openAiShimSource = [
  "export const chat_completion_sources = { CUSTOM: 'custom', OPENAI: 'openai' };",
  "export async function sendOpenAIRequest(...args) {",
  "  if (typeof globalThis.__promptBuilderMvuSendOpenAIRequest === 'function') {",
  "    return await globalThis.__promptBuilderMvuSendOpenAIRequest(...args);",
  "  }",
  "  return { choices: [{ message: { content: '{}' } }] };",
  "}",
].join("\n");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(extensionsShimSource)}`,
      };
    }
    if (specifier === "../../../../script.js") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(scriptShimSource)}`,
      };
    }
    if (specifier === "../../../openai.js") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(openAiShimSource)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});

const require = createRequire(import.meta.url);
const originalRequire = globalThis.require;
const originalExtensionSettings = globalThis.__promptBuilderMvuExtensionSettings;
const originalContext = globalThis.__promptBuilderMvuContext;
const originalSendOpenAIRequest = globalThis.__promptBuilderMvuSendOpenAIRequest;
const originalFetch = globalThis.fetch;

globalThis.require = require;
globalThis.__promptBuilderMvuExtensionSettings = {
  st_bme: {},
};
globalThis.__promptBuilderMvuContext = {
  chat: [],
  chatMetadata: {},
  extensionSettings: {},
  powerUserSettings: {},
  characters: [],
  characterId: null,
  name1: "User",
  name2: "Alice",
  chatId: "mvu-test-chat",
};

try {
  const extensionsApi = await import("../../../../extensions.js");
  const { createDefaultTaskProfiles } = await import("../prompt-profiles.js");
  const {
    buildTaskExecutionDebugContext,
    buildTaskLlmPayload,
    buildTaskPrompt,
  } = await import("../prompt-builder.js");
  const llm = await import("../llm.js");

  function createRule(id, findRegex, replaceString) {
    return {
      id,
      script_name: id,
      enabled: true,
      find_regex: findRegex,
      replace_string: replaceString,
      source: {
        user_input: true,
        ai_output: true,
      },
      destination: {
        prompt: true,
        display: false,
      },
    };
  }

  function buildSettings() {
    const taskProfiles = createDefaultTaskProfiles();
    const recallProfile = taskProfiles.recall.profiles[0];
    recallProfile.generation = {
      ...recallProfile.generation,
      stream: false,
    };
    recallProfile.regex = {
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
        "input.finalPrompt": true,
      },
      localRules: [
        createRule("user-rule", "/BAD_USER/g", "GOOD_USER"),
        createRule("recent-rule", "/BAD_RECENT/g", "GOOD_RECENT"),
        createRule("candidate-rule", "/BAD_CANDIDATE/g", "GOOD_CANDIDATE"),
        createRule("final-rule", "/FINAL_BAD/g", "FINAL_GOOD"),
      ],
    };
    recallProfile.blocks.push({
      id: "mvu-final-custom",
      name: "最终检查块",
      type: "custom",
      enabled: true,
      role: "system",
      sourceKey: "",
      sourceField: "",
      content: "FINAL_BAD",
      injectionMode: "append",
      order: recallProfile.blocks.length,
    });

    return {
      llmApiUrl: "https://example.com/v1",
      llmApiKey: "sk-mvu-secret",
      llmModel: "gpt-mvu-test",
      timeoutMs: 4321,
      taskProfilesVersion: 3,
      taskProfiles,
    };
  }

  const settings = buildSettings();
  extensionsApi.extension_settings.st_bme = settings;
  delete globalThis.__stBmeRuntimeDebugState;

  const promptBuild = await buildTaskPrompt(settings, "recall", {
    taskName: "recall",
    charDescription: "角色设定 <StatusPlaceHolderImpl/> BAD_RECENT",
    userPersona: "变量更新规则:\ntype: state\n当前时间: 12:00",
    recentMessages:
      "最近消息 <status_current_variable>hp=3</status_current_variable> BAD_RECENT",
    userMessage:
      "用户输入 <updatevariable>secret</updatevariable> BAD_USER",
    candidateNodes: "候选节点 BAD_CANDIDATE",
    candidateText: "候选节点 BAD_CANDIDATE",
    graphStats: "candidate_count=1",
  });

  assert.match(promptBuild.systemPrompt, /GOOD_RECENT/);
  assert.match(JSON.stringify(promptBuild.executionMessages), /GOOD_USER/);
  assert.match(JSON.stringify(promptBuild.executionMessages), /GOOD_CANDIDATE/);
  assert.match(promptBuild.systemPrompt, /FINAL_GOOD/);
  assert.doesNotMatch(
    JSON.stringify(promptBuild),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl/i,
  );
  assert.equal(promptBuild.debug.mvu.sanitizedFieldCount >= 4, true);
  assert.equal(promptBuild.debug.mvu.finalMessageStripCount >= 1, true);
  assert.equal(Array.isArray(promptBuild.regexInput?.entries), true);
  assert.equal(promptBuild.regexInput.entries.length > 0, true);

  const systemOnlySettings = buildSettings();
  systemOnlySettings.taskProfiles.recall = {
    activeProfileId: "system-only",
    profiles: [
      {
        id: "system-only",
        name: "system only",
        taskType: "recall",
        builtin: false,
        blocks: [
          {
            id: "only-system",
            name: "Only System",
            type: "custom",
            enabled: true,
            role: "system",
            sourceKey: "",
            sourceField: "",
            content: "系统块",
            injectionMode: "append",
            order: 0,
          },
        ],
        generation: createDefaultTaskProfiles().recall.profiles[0].generation,
        regex: {
          enabled: false,
          inheritStRegex: false,
          stages: {},
          localRules: [],
        },
      },
    ],
  };

  const systemOnlyPromptBuild = await buildTaskPrompt(systemOnlySettings, "recall", {
    taskName: "recall",
  });
  const systemOnlyPayload = buildTaskLlmPayload(
    systemOnlyPromptBuild,
    "fallback <updatevariable>hidden</updatevariable> text",
  );
  assert.equal(systemOnlyPayload.userPrompt, "fallback text");

  const capturedBodies = [];
  globalThis.fetch = async (_url, options = {}) => {
    capturedBodies.push(JSON.parse(String(options.body || "{}")));
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"ok":true}',
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  const payload = buildTaskLlmPayload(promptBuild, "unused fallback");
  assert.equal(payload.systemPrompt, "");
  const result = await llm.callLLMForJSON({
    systemPrompt: payload.systemPrompt,
    userPrompt: payload.userPrompt,
    maxRetries: 0,
    taskType: "recall",
    promptMessages: payload.promptMessages,
    additionalMessages: payload.additionalMessages,
    debugContext: buildTaskExecutionDebugContext(promptBuild),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(capturedBodies.length, 1);
  assert.doesNotMatch(
    JSON.stringify(capturedBodies[0].messages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl/i,
  );

  const runtimePromptBuild =
    globalThis.__stBmeRuntimeDebugState?.taskPromptBuilds?.recall || null;
  const runtimeLlmRequest =
    globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.recall || null;

  assert.ok(runtimePromptBuild);
  assert.ok(runtimeLlmRequest);
  assert.doesNotMatch(
    JSON.stringify(runtimePromptBuild.executionMessages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl/i,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimeLlmRequest.messages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl/i,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimeLlmRequest.requestBody?.messages || []),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl/i,
  );
  assert.deepEqual(
    runtimeLlmRequest.messages,
    runtimeLlmRequest.requestBody.messages,
  );
  assert.equal(
    runtimeLlmRequest.promptExecution?.mvu?.sanitizedFieldCount,
    promptBuild.debug.mvu.sanitizedFieldCount,
  );

  console.log("prompt-builder-mvu tests passed");
} finally {
  if (originalRequire === undefined) {
    delete globalThis.require;
  } else {
    globalThis.require = originalRequire;
  }

  if (originalExtensionSettings === undefined) {
    delete globalThis.__promptBuilderMvuExtensionSettings;
  } else {
    globalThis.__promptBuilderMvuExtensionSettings = originalExtensionSettings;
  }

  if (originalContext === undefined) {
    delete globalThis.__promptBuilderMvuContext;
  } else {
    globalThis.__promptBuilderMvuContext = originalContext;
  }

  if (originalSendOpenAIRequest === undefined) {
    delete globalThis.__promptBuilderMvuSendOpenAIRequest;
  } else {
    globalThis.__promptBuilderMvuSendOpenAIRequest = originalSendOpenAIRequest;
  }

  globalThis.fetch = originalFetch;
}
