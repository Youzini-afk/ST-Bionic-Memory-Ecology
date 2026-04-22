import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__lukerLlmRoutingExtensionSettings || {};",
  "export function getContext() {",
  "  return null;",
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
  "  if (typeof globalThis.__lukerLlmRoutingSendOpenAIRequest === 'function') {",
  "    return await globalThis.__lukerLlmRoutingSendOpenAIRequest(...args);",
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
const originalExtensionSettings = globalThis.__lukerLlmRoutingExtensionSettings;
const originalSendOpenAIRequest = globalThis.__lukerLlmRoutingSendOpenAIRequest;
const originalLuker = globalThis.Luker;
const originalFetch = globalThis.fetch;

globalThis.__lukerLlmRoutingExtensionSettings = {
  st_bme: {},
};
globalThis.require = require;

const llm = await import("../llm/llm.js");
const { createDefaultTaskProfiles } = await import("../prompting/prompt-profiles.js");
const extensionsApi = await import("../../../../extensions.js");

if (originalRequire === undefined) {
  delete globalThis.require;
} else {
  globalThis.require = originalRequire;
}

if (originalExtensionSettings === undefined) {
  delete globalThis.__lukerLlmRoutingExtensionSettings;
} else {
  globalThis.__lukerLlmRoutingExtensionSettings = originalExtensionSettings;
}

let capturedOptions = null;
let capturedMessages = null;
let sendOpenAIRequestCalls = 0;
let capturedFetchBody = null;

globalThis.Luker = {
  getContext() {
    return {
      mainApi: "openai",
      chatCompletionSettings: {
        chat_completion_source: "openai",
      },
      getChatState() {},
      updateChatState() {},
      getChatStateBatch() {},
      resolveChatCompletionRequestProfile() {
        return {
          requestApi: "openai",
          apiSettingsOverride: {
            chat_completion_source: "openai",
            reverse_proxy: "https://example-luker-route.test/v1",
            proxy_password: "sk-luker-route",
            secret_id: "luker-secret-1",
          },
        };
      },
    };
  },
};

globalThis.__lukerLlmRoutingSendOpenAIRequest = async (
  type,
  messages,
  signal,
  options = {},
) => {
  sendOpenAIRequestCalls += 1;
  capturedOptions = { ...(options || {}) };
  capturedMessages = Array.isArray(messages) ? [...messages] : messages;
  return {
    choices: [
      {
        message: {
          content: '{"operations":[]}',
        },
      },
    ],
  };
};

globalThis.fetch = async (_url, options = {}) => {
  capturedFetchBody = JSON.parse(String(options.body || "{}"));
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: '{"operations":[]}',
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

extensionsApi.extension_settings.st_bme = {
  taskProfiles: createDefaultTaskProfiles(),
};

try {
  const result = await llm.callLLMForJSON({
    systemPrompt: "system",
    userPrompt: "user",
    maxRetries: 0,
    taskType: "extract",
    requestSource: "test:luker-route",
  });

  assert.deepEqual(result, { operations: [] });
  assert.ok(Array.isArray(capturedMessages));
  assert.equal(capturedMessages.length >= 2, true);
  assert.equal(capturedOptions?.requestScope, "extension_internal");
  assert.deepEqual(capturedOptions?.apiSettingsOverride, {
    chat_completion_source: "openai",
    reverse_proxy: "https://example-luker-route.test/v1",
    proxy_password: "sk-luker-route",
    secret_id: "luker-secret-1",
  });

  capturedOptions = null;
  capturedMessages = null;
  capturedFetchBody = null;
  sendOpenAIRequestCalls = 0;
  extensionsApi.extension_settings.st_bme = {
    llmApiUrl: "https://stale-generic-config.invalid/v1",
    llmApiKey: "sk-stale-generic",
    llmModel: "stale-model",
    taskProfiles: createDefaultTaskProfiles(),
  };

  const routedResult = await llm.callLLMForJSON({
    systemPrompt: "system",
    userPrompt: "user",
    maxRetries: 0,
    taskType: "extract",
    requestSource: "test:luker-global-stale",
  });

  assert.deepEqual(routedResult, { operations: [] });
  assert.equal(
    sendOpenAIRequestCalls,
    0,
    "存在可用的 BME 全局专用 LLM 配置时，不应退回宿主当前聊天路由",
  );
  assert.equal(
    capturedFetchBody?.custom_url,
    "https://stale-generic-config.invalid/v1",
  );

  capturedOptions = null;
  capturedMessages = null;
  capturedFetchBody = null;
  sendOpenAIRequestCalls = 0;
  const taskProfiles = createDefaultTaskProfiles();
  taskProfiles.extract.profiles[0].generation.llm_preset = "luker-profile-alpha";
  extensionsApi.extension_settings.st_bme = {
    llmApiUrl: "https://stale-generic-config.invalid/v1",
    llmApiKey: "sk-stale-generic",
    llmModel: "stale-model",
    taskProfiles,
  };
  globalThis.Luker = {
    getContext() {
      return {
        mainApi: "openai",
        chatCompletionSettings: {
          chat_completion_source: "openai",
        },
        getChatState() {},
        updateChatState() {},
        getChatStateBatch() {},
        resolveChatCompletionRequestProfile({ profileName }) {
          assert.equal(profileName, "luker-profile-alpha");
          return {
            requestApi: "openai",
            apiSettingsOverride: {
              chat_completion_source: "openai",
              reverse_proxy: "https://example-luker-profile.test/v1",
              proxy_password: "sk-luker-profile",
            },
          };
        },
      };
    },
  };

  const profileRoutedResult = await llm.callLLMForJSON({
    systemPrompt: "system",
    userPrompt: "user",
    maxRetries: 0,
    taskType: "extract",
    requestSource: "test:luker-profile-route",
  });

  assert.deepEqual(profileRoutedResult, { operations: [] });
  assert.equal(
    sendOpenAIRequestCalls,
    0,
    "存在可用的 BME 全局专用 LLM 配置时，不应因为 Luker profile 名而劫持到当前聊天路由",
  );
  assert.equal(
    capturedFetchBody?.custom_url,
    "https://stale-generic-config.invalid/v1",
  );
} finally {
  if (originalSendOpenAIRequest === undefined) {
    delete globalThis.__lukerLlmRoutingSendOpenAIRequest;
  } else {
    globalThis.__lukerLlmRoutingSendOpenAIRequest = originalSendOpenAIRequest;
  }

  if (originalFetch === undefined) {
    delete globalThis.fetch;
  } else {
    globalThis.fetch = originalFetch;
  }

  if (originalLuker === undefined) {
    delete globalThis.Luker;
  } else {
    globalThis.Luker = originalLuker;
  }
}

console.log("luker-llm-routing tests passed");
