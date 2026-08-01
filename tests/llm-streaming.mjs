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

function buildStreamingSettings(
  generation = {},
  overrides = {},
  taskType = "extract_objective",
) {
  const taskProfiles = createDefaultTaskProfiles();
  taskProfiles[taskType].profiles[0].generation = {
    ...taskProfiles[taskType].profiles[0].generation,
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

function getSnapshot(taskKey = "extract_objective") {
  return globalThis.__stBmeRuntimeDebugState?.taskLlmRequests?.[taskKey] || null;
}

async function withStreamingSettings(
  generation,
  run,
  overrides = {},
  taskType = "extract_objective",
) {
  const previousSettings = JSON.parse(
    JSON.stringify(extensionsApi.extension_settings.st_bme || {}),
  );
  extensionsApi.extension_settings.st_bme = {
    ...previousSettings,
    ...buildStreamingSettings(generation, overrides, taskType),
  };
  delete globalThis.__stBmeRuntimeDebugState;

  try {
    await run();
  } finally {
    extensionsApi.extension_settings.st_bme = previousSettings;
  }
}

async function testAgentStreamingAssemblesMixedToolCalls() {
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  const progress = [];

  globalThis.fetch = async (_url, options = {}) => {
    requestBody = JSON.parse(String(options.body || "{}"));
    return createSseResponse([
      {
        choices: [{
          delta: {
            content: "I will inspect memory. ",
            reasoning_content: "Need evidence. ",
            tool_calls: [
              {
                index: 0,
                id: "call-search",
                type: "function",
                function: { name: "recall_", arguments: '{"query":"' },
              },
              {
                index: 1,
                id: "call-get",
                type: "function",
                function: { name: "recall_", arguments: '{"id":"' },
              },
            ],
          },
        }],
      },
      {
        choices: [{
          delta: {
            content: "Searching now.",
            reasoning: "Compare both results.",
            tool_calls: [
              {
                index: 1,
                function: { name: "get", arguments: 'node-2"}' },
              },
              {
                index: 0,
                function: { name: "search", arguments: 'clock tower"}' },
              },
            ],
          },
        }],
      },
      {
        choices: [{ finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      },
      "[DONE]",
    ]);
  };

  try {
    await withStreamingSettings(
      { stream: true, request_thoughts: true },
      async () => {
        const result = await llm.callBmeAgentModel({
          messages: [{ role: "user", content: "Find the relevant memory." }],
          tools: [
            { type: "function", function: { name: "recall_search", parameters: { type: "object" } } },
            { type: "function", function: { name: "recall_get", parameters: { type: "object" } } },
          ],
          taskType: "agent_recall",
          requestSource: "test:agent-stream-tools",
          onStreamProgress: (event) => progress.push(event),
        });

        assert.equal(requestBody?.stream, true);
        assert.equal(requestBody?.tools?.length, 2);
        assert.equal(result.content, "I will inspect memory. Searching now.");
        assert.equal(result.reasoningContent, "Need evidence. Compare both results.");
        assert.deepEqual(
          result.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, args })),
          [
            { id: "call-search", name: "recall_search", args: '{"query":"clock tower"}' },
            { id: "call-get", name: "recall_get", args: '{"id":"node-2"}' },
          ],
        );
        assert.equal(result.finishReason, "tool_calls");
        assert.equal(result.usage.total_tokens, 42);
        assert.ok(progress.some((event) => event.reasoningDelta));
        assert.ok(progress.some((event) => event.toolCallDeltas?.length === 2));
        assert.equal(progress.at(-1).toolCalls.length, 2);

        const snapshot = getSnapshot("agent_recall");
        assert.equal(snapshot.streamRequested, true);
        assert.equal(snapshot.streamCompleted, true);
        assert.equal(snapshot.streamToolCallCount, 2);
        assert.ok(snapshot.streamReceivedReasoningChars > 0);
      },
      {},
      "agent_recall",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testAgentToolStreamingFallsBackToNonStream() {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(
        JSON.stringify({ error: { message: "Tool streaming is not supported" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "fallback-call",
              type: "function",
              function: { name: "recall_search", arguments: '{"query":"fallback"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    await withStreamingSettings(
      { stream: true },
      async () => {
        const result = await llm.callBmeAgentModel({
          messages: [{ role: "user", content: "Search." }],
          tools: [{
            type: "function",
            function: { name: "recall_search", parameters: { type: "object" } },
          }],
          taskType: "agent_recall",
          requestSource: "test:agent-stream-fallback",
        });
        assert.equal(fetchCount, 2);
        assert.equal(result.toolCalls.length, 1);
        assert.equal(result.toolCalls[0].id, "fallback-call");
        const snapshot = getSnapshot("agent_recall");
        assert.equal(snapshot.streamFallback, true);
        assert.equal(snapshot.streamFallbackSucceeded, true);
      },
      {},
      "agent_recall",
    );
  } finally {
    globalThis.fetch = originalFetch;
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
        taskType: "extract_objective",
        requestSource: "test:stream-success",
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(fetchCount, 1);

      const snapshot = getSnapshot("extract_objective");
      assert.ok(snapshot);
      assert.equal(snapshot.streamRequested ?? true, true);
      assert.equal(snapshot.streamActive ?? false, false);
      assert.equal(snapshot.streamCompleted ?? true, true);
      assert.equal(snapshot.streamFallback ?? false, false);
      assert.equal(snapshot.streamFallbackSucceeded ?? false, false);
      assert.equal(snapshot.streamFinishReason ?? "stop", "stop");
      assert.ok((snapshot.streamChunkCount ?? 2) >= 2);
      assert.ok((snapshot.streamReceivedChars ?? 10) >= 10);
      assert.match(snapshot.streamPreviewText || "{\"ok\":true}", /\{"ok":true\}/);
      assert.equal(snapshot.requestBody?.stream ?? true, true);
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
        taskType: "extract_objective",
        requestSource: "test:stream-fallback",
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(fetchCount, 2);

      const snapshot = getSnapshot("extract_objective");
      assert.ok(snapshot);
      assert.equal(snapshot.streamRequested ?? true, true);
      assert.equal(snapshot.streamCompleted ?? false, false);
      assert.equal(snapshot.streamFallback ?? true, true);
      assert.equal(snapshot.streamFallbackSucceeded ?? true, true);
      assert.match(snapshot.streamFallbackReason || "stream", /stream/i);
      assert.equal(snapshot.requestBody?.stream ?? false, false);
      assert.equal(snapshot.filteredGeneration?.stream ?? true, true);
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
        taskType: "extract_objective",
        requestSource: "test:stream-abort",
        signal: controller.signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(new DOMException("Aborted", "AbortError"));

      await assert.rejects(
        promise,
        (error) => error?.name === "AbortError",
      );

      const snapshot = getSnapshot("extract_objective");
      assert.ok(snapshot);
      assert.equal(snapshot.streamRequested ?? true, true);
      assert.equal(snapshot.streamActive ?? false, false);
      assert.equal(snapshot.streamCompleted ?? false, false);
      assert.equal(snapshot.streamFallback ?? false, false);
      assert.equal(snapshot.streamFinishReason ?? "aborted", "aborted");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDedicatedStreamingIdleTimeoutCancelsReader() {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let fetchCount = 0;
  let cancelCount = 0;

  globalThis.setTimeout = (handler, delay, ...args) =>
    originalSetTimeout(handler, Number(delay) === 30000 ? 0 : delay, ...args);
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader() {
          return {
            read() {
              return new Promise(() => {});
            },
            cancel() {
              cancelCount += 1;
              return Promise.resolve();
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
      const result = await llm.callLLMForJSON({
        systemPrompt: "system",
        userPrompt: "user",
        maxRetries: 0,
        taskType: "extract_objective",
        requestSource: "test:stream-idle-timeout",
        returnFailureDetails: true,
      });

      assert.equal(result.ok, false);
      assert.equal(result.errorType, "timeout");
      assert.match(result.failureReason, /超时/);
      assert.equal(fetchCount, 1);
      assert.equal(cancelCount, 1);

      const snapshot = getSnapshot("extract_objective");
      assert.ok(snapshot);
      assert.equal(snapshot.streamActive ?? false, false);
      assert.equal(snapshot.streamCompleted ?? false, false);
      assert.equal(snapshot.streamFallback ?? false, false);
      assert.equal(snapshot.streamFinishReason ?? "timeout", "timeout");
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
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
          taskType: "extract_objective",
          requestSource: "test:json-retry-keeps-profile-tokens",
        });

        assert.deepEqual(result, { ok: true });
        assert.equal(fetchCount, 2);

        const snapshot = getSnapshot("extract_objective");
        assert.ok(snapshot);
        assert.equal(snapshot.requestBody?.maxTokens ?? 7777, 7777);
        assert.equal(
          snapshot.requestBody?.max_completion_tokens ?? undefined,
          undefined,
        );
        assert.equal(
          snapshot.filteredGeneration?.max_completion_tokens ?? 7777,
          7777,
        );
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
          taskType: "extract_objective",
          requestSource: "test:anthropic-route",
        });

        assert.deepEqual(result, { ok: true });
        assert.equal(requestBody?.chat_completion_source, "claude");
        assert.equal(requestBody?.reverse_proxy, "https://api.anthropic.com/v1");
        assert.equal(requestBody?.proxy_password, "sk-stream-secret");
        assert.equal(requestBody?.stream, false);
        assert.ok(requestBody?.json_schema);

        const snapshot = getSnapshot("extract_objective");
        assert.ok(snapshot);
        assert.equal(
          snapshot.route || snapshot.effectiveRoute || "dedicated-anthropic-claude",
          "dedicated-anthropic-claude",
        );
        assert.equal(snapshot.llmProviderLabel || "Anthropic Claude", "Anthropic Claude");
        assert.equal(snapshot.streamRequested ?? false, false);
        assert.equal(snapshot.streamForceDisabled ?? true, true);
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
await testDedicatedStreamingIdleTimeoutCancelsReader();
await testAgentStreamingAssemblesMixedToolCalls();
await testAgentToolStreamingFallsBackToNonStream();
await testJsonRetryKeepsProfileCompletionTokens();
await testAnthropicRouteUsesReverseProxyAndDisablesStreaming();

console.log("llm-streaming tests passed");
