import assert from "node:assert/strict";

const { onTestEmbeddingController } = await import("../ui/ui-actions-controller.js");

{
  const calls = [];
  const toasts = [];
  await onTestEmbeddingController({
    getSettings: () => ({ embeddingTransportMode: "direct" }),
    getEmbeddingConfig: (mode) => {
      calls.push(["getEmbeddingConfig", mode]);
      return { mode, apiUrl: "https://example.com/v1", model: "embedding" };
    },
    validateVectorConfig: () => ({ valid: true, error: "" }),
    getCurrentChatId: () => "chat-a",
    testVectorConnection: async (config, chatId) => {
      calls.push(["testVectorConnection", config.mode, chatId]);
      return { success: true, dimensions: 3 };
    },
    toastr: {
      info: (message) => toasts.push(["info", message]),
      success: (message) => toasts.push(["success", message]),
      error: (message) => toasts.push(["error", message]),
      warning: (message) => toasts.push(["warning", message]),
    },
  });
  assert.deepEqual(calls, [
    ["getEmbeddingConfig", "direct"],
    ["testVectorConnection", "direct", "chat-a"],
  ]);
  assert.equal(toasts.some(([kind, message]) => kind === "info" && message.includes("直连")), true);
}

{
  const calls = [];
  await onTestEmbeddingController({
    getSettings: () => ({ embeddingTransportMode: "backend" }),
    getEmbeddingConfig: (mode) => {
      calls.push(["getEmbeddingConfig", mode]);
      return { mode, source: "openai", model: "embedding" };
    },
    validateVectorConfig: () => ({ valid: true, error: "" }),
    getCurrentChatId: () => "chat-b",
    testVectorConnection: async (config, chatId) => {
      calls.push(["testVectorConnection", config.mode, chatId]);
      return { success: true, dimensions: 3 };
    },
    toastr: {
      info: () => {},
      success: () => {},
      error: () => {},
      warning: () => {},
    },
  });
  assert.deepEqual(calls, [
    ["getEmbeddingConfig", "backend"],
    ["testVectorConnection", "backend", "chat-b"],
  ]);
}

console.log("ui-actions-embedding tests passed");
