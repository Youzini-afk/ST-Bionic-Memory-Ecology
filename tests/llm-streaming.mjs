import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  installResolveHooks,
  toDataModuleUrl,
} from "./helpers/register-hooks-compat.mjs";

const extensionsShimSource = [
  "export const extension_settings = globalThis.__llmStreamingExtensionSettings || {};",
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
  "  if (typeof globalThis.__llmStreamingSendOpenAIRequest === 'function') {",
  "    return await globalThis.__llmStreamingSendOpenAIRequest(...args);",
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
const originalExtensionSettings = globalThis.__llmStreamingExtensionSettings;
const originalSendOpenAIRequest = globalThis.__llmStreamingSendOpenAIRequest;

globalThis.__llmStreamingExtensionSettings = {
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
  delete globalThis.__llmStreamingExtensionSettings;
} else {
  globalThis.__llmStreamingExtensionSettings = originalExtensionSettings;
}

if (originalSendOpenAIRequest === undefined) {
  delete globalThis.__llmStreamingSendOpenAIRequest;
} else {
  globalThis.__llmStreamingSendOpenAIRequest = originalSendOpenAIRequest;
}

function buildStreamingSettings(generation = {}, overrides = {}) {
  const taskProfiles = createDefaultTaskProfiles();
  taskProfiles.extract.profiles[0].generation = {
    ...taskProfiles.extract.profiles[0].generation,
    ...generation,
  };
  return {
    llmApiUrl: "https://example.com/v1",
    llmApiKey: "sk-stream-secret",
    llmModel: "gpt-stream-test",
    timeoutMs: 1234,
    taskProfilesVersion: 3,
    taskProfiles,
    ...(overrides || {}),
  };
}

function createSseResponse(events = [], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          const payload =
            typeof event === "string" ? event : JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
        controller.close();
      },
    }),
    {
      status,
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

function getSnapshot(taskKey = "extract") {
  return globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.[taskKey] || null;
}

async function withStreamingSettings(generation, run, overrides = {}) {
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    ...buildStreamingSettings(generation, overrides),
  };
  delete globalThis.__stBmeRuntimeDebugState;

  try {
    await run();
  } finally {
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
}

async function testDedicatedStreamingSuccess() {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return createSseResponse([
      { choices: [{ delta: { content: '{"ok":' } }] },
      { choices: [{ delta: { content: "true}" } }] },
      { choices: [{ finish_reason: "stop" }] },
      "[DONE]",
    ]);
  };

  try {
    await withStreamingSettings({ stream: true }, async () => {
      const result = await llm.callLLMForJSON({
        systemPrompt: "system",
        userPrompt: "user",
        maxRetries: 0,
        taskType: "extract",
        requestSource: "test:stream-success",
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(fetchCount, 1);

      const snapshot = getSnapshot("extract");
      assert.ok(snapshot);
      assert.equal(snapshot.streamRequested, true);
      assert.equal(snapshot.streamActive, false);
      assert.equal(snapshot.streamCompleted, true);
      assert.equal(snapshot.streamFallback, false);
      assert.equal(snapshot.streamFallbackSucceeded, false);
      assert.equal(snapshot.streamFinishReason, "stop");
      assert.ok(snapshot.streamChunkCount >= 2);
      assert.ok(snapshot.streamReceivedChars >= 10);
      assert.match(snapshot.streamPreviewText, /\{"ok":true\}/);
      assert.equal(snapshot.requestBody?.stream, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDedicatedStreamingFallsBackToNonStream() {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Streaming is not supported by this provider",
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

  try {
    await withStreamingSettings({ stream: true }, async () => {
      const result = await llm.callLLMForJSON({
        systemPrompt: "system",
        userPrompt: "user",
        maxRetries: 0,
        taskType: "extract",
        requestSource: "test:stream-fallback",
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(fetchCount, 2);

      const snapshot = getSnapshot("extract");
      assert.ok(snapshot);
      assert.equal(snapshot.streamRequested, true);
      assert.equal(snapshot.streamCompleted, false);
      assert.equal(snapshot.streamFallback, true);
      assert.equal(snapshot.streamFallbackSucceeded, true);
      assert.match(snapshot.streamFallbackReason, /stream/i);
      assert.equal(snapshot.requestBody?.stream, false);
      assert.equal(snapshot.filteredGeneration?.stream, true);
      assert.equal(snapshot.redacted, true);
      assert.doesNotMatch(JSON.stringify(snapshot), /sk-stream-secret/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDedicatedStreamingAbortDoesNotLeaveActiveState() {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();

  globalThis.fetch = async (_url, options = {}) => {
    const signal = options.signal;
    let readCount = 0;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader() {
          return {
            async read() {
              if (readCount === 0) {
                readCount += 1;
                return {
                  done: false,
                  value: encoder.encode(
                    'data: {"choices":[{"delta":{"content":"{\\"partial\\":"}}]}\n\n',
                  ),
                };
              }

              return await new Promise((resolve, reject) => {
                signal?.addEventListener(
                  "abort",
                  () =>
                    reject(
                      signal.reason ||
                        new DOMException("Aborted", "AbortError"),
                    ),
                  { once: true },
                );
              });
            },
            releaseLock() {},
          };
        },
      },
      text: async () => "",
    };
  };

  try {
    await withStreamingSettings({ stream: true }, async () => {
      const controller = new AbortController();
      const promise = llm.callLLMForJSON({
        systemPrompt: "system",
        userPrompt: "user",
        maxRetries: 0,
        taskType: "extract",
        requestSource: "test:stream-abort",
        signal: controller.signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(new DOMException("Aborted", "AbortError"));

      await assert.rejects(
        promise,
        (error) => error?.name === "AbortError",
      );

      const snapshot = getSnapshot("extract");
      assert.ok(snapshot);
      assert.equal(snapshot.streamRequested, true);
      assert.equal(snapshot.streamActive, false);
      assert.equal(snapshot.streamCompleted, false);
      assert.equal(snapshot.streamFallback, false);
      assert.equal(snapshot.streamFinishReason, "aborted");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testJsonRetryKeepsProfileCompletionTokens() {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;

    if (fetchCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "not-json",
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
    }

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

  try {
    await withStreamingSettings(
      {
        stream: false,
        max_completion_tokens: 7777,
      },
      async () => {
        const result = await llm.callLLMForJSON({
          systemPrompt: "system",
          userPrompt: "user",
          maxRetries: 1,
          taskType: "extract",
          requestSource: "test:json-retry-keeps-profile-tokens",
        });

        assert.deepEqual(result, { ok: true });
        assert.equal(fetchCount, 2);

        const snapshot = getSnapshot("extract");
        assert.ok(snapshot);
        assert.equal(snapshot.requestBody?.max_tokens, 7777);
        assert.equal(snapshot.requestBody?.max_completion_tokens, undefined);
        assert.equal(snapshot.filteredGeneration?.max_completion_tokens, 7777);
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAnthropicRouteUsesReverseProxyAndDisablesStreaming() {
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(String(options.body || "{}"));
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

  try {
    await withStreamingSettings(
      { stream: true },
      async () => {
        const result = await llm.callLLMForJSON({
          systemPrompt: "system",
          userPrompt: "user",
          maxRetries: 0,
          taskType: "extract",
          requestSource: "test:anthropic-route",
        });

        assert.deepEqual(result, { ok: true });
        assert.equal(requestBody?.chat_completion_source, "claude");
        assert.equal(requestBody?.reverse_proxy, "https://api.anthropic.com/v1");
        assert.equal(requestBody?.proxy_password, "sk-stream-secret");
        assert.equal(requestBody?.stream, false);
        assert.ok(requestBody?.json_schema);

        const snapshot = getSnapshot("extract");
        assert.ok(snapshot);
        assert.equal(snapshot.route, "dedicated-anthropic-claude");
        assert.equal(snapshot.llmProviderLabel, "Anthropic Claude");
        assert.equal(snapshot.streamRequested, false);
        assert.equal(snapshot.streamForceDisabled, true);
      },
      {
        llmApiUrl: "https://api.anthropic.com/v1/messages",
        llmModel: "claude-sonnet-4-5",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await testDedicatedStreamingSuccess();
await testDedicatedStreamingFallsBackToNonStream();
await testDedicatedStreamingAbortDoesNotLeaveActiveState();
await testJsonRetryKeepsProfileCompletionTokens();
await testAnthropicRouteUsesReverseProxyAndDisablesStreaming();

console.log("llm-streaming tests passed");
