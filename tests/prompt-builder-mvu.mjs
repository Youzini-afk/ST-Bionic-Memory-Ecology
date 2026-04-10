import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

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
  "export function substituteParamsExtended(text) {",
  "  return String(text ?? '');",
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

installResolveHooks([
  {
    specifiers: [
      "../../../extensions.js",
      "../../../../extensions.js",
      "../../../../../extensions.js",
    ],
    url: toDataModuleUrl(extensionsShimSource),
  },
  {
    specifiers: [
      "../../../../script.js",
      "../../../../../script.js",
    ],
    url: toDataModuleUrl(scriptShimSource),
  },
  {
    specifiers: [
      "../../../openai.js",
      "../../../../openai.js",
    ],
    url: toDataModuleUrl(openAiShimSource),
  },
]);

const require = createRequire(import.meta.url);
const originalRequire = globalThis.require;
const originalExtensionSettings = globalThis.__promptBuilderMvuExtensionSettings;
const originalContext = globalThis.__promptBuilderMvuContext;
const originalSendOpenAIRequest = globalThis.__promptBuilderMvuSendOpenAIRequest;
const originalFetch = globalThis.fetch;
const originalGetWorldbook = globalThis.getWorldbook;
const originalGetLorebookEntries = globalThis.getLorebookEntries;
const originalGetCharWorldbookNames = globalThis.getCharWorldbookNames;

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

function createWorldbookEntry({
  uid,
  name,
  comment = name,
  content,
  strategyType = "constant",
  keys = [],
  enabled = true,
  order = 10,
}) {
  return {
    uid,
    name,
    comment,
    content,
    enabled,
    position: {
      type: "before_character_definition",
      role: "system",
      depth: 0,
      order,
    },
    strategy: {
      type: strategyType,
      keys,
      keys_secondary: { logic: "and_any", keys: [] },
    },
    probability: 100,
    extra: {},
  };
}

try {
  const extensionsApi = await import("../../../../extensions.js");
  const { createDefaultTaskProfiles } = await import("../prompting/prompt-profiles.js");
  const {
    buildTaskExecutionDebugContext,
    buildTaskLlmPayload,
    buildTaskPrompt,
  } = await import("../prompting/prompt-builder.js");
  const llm = await import("../llm/llm.js");

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
    recallProfile.blocks.push({
      id: "mvu-chat-custom",
      name: "聊天对象检查",
      type: "custom",
      enabled: true,
      role: "system",
      sourceKey: "",
      sourceField: "",
      content: "聊天对象 {{chatMessages}}",
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
    chatMessages: [
      {
        role: "assistant",
        content: "聊天内容 BAD_RECENT",
        variables: {
          0: {
            stat_data: { hp: [3, "状态更新"] },
            display_data: { hp: "2->3" },
            delta_data: { hp: "2->3" },
          },
        },
        debugStatus: "{{get_message_variable::display_data.hp}} BAD_RECENT",
      },
    ],
    userMessage:
      "用户输入 <updatevariable>secret</updatevariable> {{get_message_variable::stat_data.hp}} BAD_USER",
    candidateNodes: [
      {
        id: "node-1",
        summary: "候选节点 BAD_CANDIDATE <StatusPlaceHolderImpl/>",
        variables: {
          0: {
            stat_data: { 地点: "学校" },
            display_data: { 地点: "教室" },
          },
        },
        note: "{{get_message_variable::stat_data.地点}} BAD_CANDIDATE",
      },
    ],
    candidateText:
      "候选节点 BAD_CANDIDATE {{get_message_variable::stat_data.地点}}",
    graphStats: "candidate_count=1",
  });

  assert.match(promptBuild.systemPrompt, /GOOD_RECENT/);
  assert.match(JSON.stringify(promptBuild.executionMessages), /GOOD_CANDIDATE/);
  assert.match(promptBuild.systemPrompt, /FINAL_BAD/);
  assert.doesNotMatch(promptBuild.systemPrompt, /FINAL_GOOD/);
  assert.equal(
    promptBuild.debug.mvu.sanitizedFields.some((entry) => entry.name === "userMessage"),
    true,
  );
  assert.equal(
    promptBuild.debug.mvu.sanitizedFields.some((entry) =>
      String(entry.name || "").startsWith("candidateNodes[0].variables"),
    ),
    true,
  );
  assert.equal(
    promptBuild.debug.mvu.sanitizedFields.some((entry) =>
      String(entry.name || "").startsWith("chatMessages[0].variables"),
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(promptBuild),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.equal(promptBuild.debug.mvu.sanitizedFieldCount >= 4, true);
  assert.equal(promptBuild.debug.mvu.finalMessageStripCount >= 0, true);
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
  assert.equal(
    systemOnlyPayload.userPrompt,
    "fallback <updatevariable>hidden</updatevariable> text",
  );

  const rawWorldInfoEntries = [
    createWorldbookEntry({
      uid: 101,
      name: "raw-trigger",
      comment: "原始触发命中",
      content: "世界书原始触发成功。",
      strategyType: "selective",
      keys: ["星火密令"],
      order: 10,
    }),
    createWorldbookEntry({
      uid: 102,
      name: "raw-ejs",
      comment: "原始 EJS 命中",
      content:
        '<%= user_input.includes("星火密令") ? "EJS 看到了原始 MVU 信号。" : "EJS 丢失了原始 MVU 信号。" %>',
      order: 20,
    }),
  ];

  globalThis.getCharWorldbookNames = () => ({
    primary: "mvu-raw-worldbook",
    additional: [],
  });
  globalThis.getWorldbook = async (worldbookName) =>
    worldbookName === "mvu-raw-worldbook" ? rawWorldInfoEntries : [];
  globalThis.getLorebookEntries = async (worldbookName) =>
    (worldbookName === "mvu-raw-worldbook" ? rawWorldInfoEntries : []).map(
      (entry) => ({
        uid: entry.uid,
        comment: entry.comment,
      }),
    );
  globalThis.__promptBuilderMvuContext = {
    ...globalThis.__promptBuilderMvuContext,
    chatId: "mvu-raw-trigger-chat",
    chatMetadata: {},
    extensionSettings: {},
    powerUserSettings: {},
  };

  const rawWorldInfoSettings = buildSettings();
  rawWorldInfoSettings.taskProfiles.recall = {
    activeProfileId: "raw-worldinfo",
    profiles: [
      {
        id: "raw-worldinfo",
        name: "raw worldinfo",
        taskType: "recall",
        builtin: false,
        blocks: [
          {
            id: "wi-before",
            name: "世界书前块",
            type: "builtin",
            enabled: true,
            role: "system",
            sourceKey: "worldInfoBefore",
            sourceField: "",
            content: "",
            injectionMode: "append",
            order: 0,
          },
          {
            id: "recent-messages",
            name: "最近消息",
            type: "builtin",
            enabled: true,
            role: "system",
            sourceKey: "recentMessages",
            sourceField: "",
            content: "",
            injectionMode: "append",
            order: 1,
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

  const rawWorldInfoPromptBuild = await buildTaskPrompt(rawWorldInfoSettings, "recall", {
    taskName: "recall",
    recentMessages: "最近消息",
    userMessage:
      "继续 <status_current_variable>星火密令</status_current_variable>",
    chatMessages: [],
  });

  assert.match(rawWorldInfoPromptBuild.systemPrompt, /世界书原始触发成功/);
  assert.match(rawWorldInfoPromptBuild.systemPrompt, /EJS 看到了原始 MVU 信号/);
  assert.doesNotMatch(
    rawWorldInfoPromptBuild.systemPrompt,
    /status_current_variable/i,
  );
  assert.equal(
    rawWorldInfoPromptBuild.debug.effectivePath?.worldInfoInputContext,
    "raw-context-for-trigger-and-ejs",
  );

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
  assert.match(JSON.stringify(payload.promptMessages), /FINAL_BAD/);
  assert.doesNotMatch(JSON.stringify(payload.promptMessages), /FINAL_GOOD/);
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
  assert.match(JSON.stringify(capturedBodies[0].messages), /FINAL_GOOD/);
  assert.doesNotMatch(JSON.stringify(capturedBodies[0].messages), /FINAL_BAD/);
  assert.doesNotMatch(
    JSON.stringify(capturedBodies[0].messages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );

  const runtimePromptBuild =
    globalThis.__stBmeRuntimeDebugState?.taskPromptBuilds?.recall || null;
  const runtimeLlmRequest =
    globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.recall || null;

  assert.ok(runtimePromptBuild);
  assert.ok(runtimeLlmRequest);
  assert.match(JSON.stringify(runtimeLlmRequest.messages), /FINAL_GOOD/);
  assert.equal(runtimeLlmRequest.requestCleaning?.applied, true);
  assert.equal(
    runtimeLlmRequest.requestCleaning?.stages?.length > 0,
    true,
  );
  assert.equal(
    runtimeLlmRequest.requestCleaning?.stages?.every(
      (entry) => entry.stage === "input.finalPrompt",
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimePromptBuild.executionMessages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimeLlmRequest.messages),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
  );
  assert.doesNotMatch(
    JSON.stringify(runtimeLlmRequest.requestBody?.messages || []),
    /status_current_variable|updatevariable|StatusPlaceHolderImpl|stat_data|display_data|delta_data|get_message_variable/i,
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

  if (originalGetWorldbook === undefined) {
    delete globalThis.getWorldbook;
  } else {
    globalThis.getWorldbook = originalGetWorldbook;
  }

  if (originalGetLorebookEntries === undefined) {
    delete globalThis.getLorebookEntries;
  } else {
    globalThis.getLorebookEntries = originalGetLorebookEntries;
  }

  if (originalGetCharWorldbookNames === undefined) {
    delete globalThis.getCharWorldbookNames;
  } else {
    globalThis.getCharWorldbookNames = originalGetCharWorldbookNames;
  }
}
