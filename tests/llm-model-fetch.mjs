import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__llmModelFetchExtensionSettings || {};",
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
  "  if (typeof globalThis.__llmModelFetchSendOpenAIRequest === 'function') {",
  "    return await globalThis.__llmModelFetchSendOpenAIRequest(...args);",
  "  }",
  "  return { choices: [{ message: { content: '{}' } }] };",
  "}",
].join("\n");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../../../extensions.js" ||
      specifier === "../../../../extensions.js" ||
      specifier === "../../../../../extensions.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(extensionsShimSource)}`,
      };
    }
    if (
      specifier === "../../../../script.js" ||
      specifier === "../../../../../script.js"
    ) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(scriptShimSource)}`,
      };
    }
    if (
      specifier === "../../../openai.js" ||
      specifier === "../../../../openai.js"
    ) {
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
const originalExtensionSettings = globalThis.__llmModelFetchExtensionSettings;
const originalSendOpenAIRequest = globalThis.__llmModelFetchSendOpenAIRequest;

globalThis.__llmModelFetchExtensionSettings = {
  st_bme: {},
};
globalThis.require = require;

const { createDefaultTaskProfiles } = await import("../prompting/prompt-profiles.js");
const llm = await import("../llm/llm.js");
const extensionsApi = await import("../../../../extensions.js");

if (originalRequire === undefined) {
  delete globalThis.require;
} else {
  globalThis.require = originalRequire;
}

if (originalExtensionSettings === undefined) {
  delete globalThis.__llmModelFetchExtensionSettings;
} else {
  globalThis.__llmModelFetchExtensionSettings = originalExtensionSettings;
}

if (originalSendOpenAIRequest === undefined) {
  delete globalThis.__llmModelFetchSendOpenAIRequest;
} else {
  globalThis.__llmModelFetchSendOpenAIRequest = originalSendOpenAIRequest;
}

function buildModelFetchSettings() {
  return {
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-model-secret",
    llmModel: "gpt-model-test",
    timeoutMs: 5678,
    taskProfilesVersion: 3,
    taskProfiles: createDefaultTaskProfiles(),
  };
}

async function withModelFetchSettings(run) {
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    ...buildModelFetchSettings(),
  };

  try {
    await run();
  } finally {
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
}

async function testFetchMemoryModelsUsesCustomStatusFirst() {
  const originalFetch = globalThis.fetch;
  const seenBodies = [];

  globalThis.fetch = async (_url, options = {}) => {
    seenBodies.push(JSON.parse(String(options.body || "{}")));
    return new Response(
      JSON.stringify({
        models: [{ id: "gpt-4.1-mini" }, { id: "gpt-4.1" }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  try {
    await withModelFetchSettings(async () => {
      const result = await llm.fetchMemoryLLMModels();
      assert.equal(result.success, true);
      assert.deepEqual(
        result.models.map((item) => item.id),
        ["gpt-4.1-mini", "gpt-4.1"],
      );
      assert.equal(seenBodies.length, 1);
      assert.equal(seenBodies[0].chat_completion_source, "custom");
      assert.equal(seenBodies[0].custom_url, "https://example.com/v1");
      assert.match(
        String(seenBodies[0].custom_include_headers || ""),
        /Authorization:\s+Bearer\s+sk-model-secret/,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFetchMemoryModelsFallsBackToLegacyStatus() {
  const originalFetch = globalThis.fetch;
  const seenBodies = [];
  let fetchCount = 0;

  globalThis.fetch = async (_url, options = {}) => {
    fetchCount += 1;
    seenBodies.push(JSON.parse(String(options.body || "{}")));

    if (fetchCount === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: "custom source not supported",
          },
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        data: [{ id: "legacy-openai-model" }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  };

  try {
    await withModelFetchSettings(async () => {
      const result = await llm.fetchMemoryLLMModels();
      assert.equal(result.success, true);
      assert.deepEqual(result.models, [
        { id: "legacy-openai-model", label: "legacy-openai-model" },
      ]);
      assert.equal(fetchCount, 2);
      assert.equal(seenBodies[0].chat_completion_source, "custom");
      assert.equal(seenBodies[1].chat_completion_source, "openai");
      assert.equal(seenBodies[1].reverse_proxy, "https://example.com/v1");
      assert.equal(seenBodies[1].proxy_password, "sk-model-secret");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFetchMemoryModelsParsesNestedPayload() {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          models: [{ name: "nested-model-a" }, { label: "nested-model-b" }],
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

  try {
    await withModelFetchSettings(async () => {
      const result = await llm.fetchMemoryLLMModels();
      assert.equal(result.success, true);
      assert.deepEqual(
        result.models.map((item) => item.id),
        ["nested-model-a", "nested-model-b"],
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testFetchMemoryModelsUsesCustomStatusFirst();
await testFetchMemoryModelsFallsBackToLegacyStatus();
await testFetchMemoryModelsParsesNestedPayload();

console.log("llm-model-fetch tests passed");
