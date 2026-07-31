import assert from "node:assert/strict";
import {
  normalizeAgentModelResponse,
  toAgentAssistantMessage,
  toAgentToolMessage,
} from "../agent/model-protocol.js";

const normalized = normalizeAgentModelResponse({
  content: "",
  toolCalls: [
    {
      id: "call-1",
      function: { name: "search_memory", arguments: { query: "clock tower" } },
    },
  ],
  usage: { total_tokens: 42 },
});
assert.equal(normalized.toolCalls[0].name, "search_memory");
assert.equal(normalized.toolCalls[0].arguments, '{"query":"clock tower"}');
assert.equal(normalized.usage.total_tokens, 42);

const assistant = toAgentAssistantMessage(normalized).message;
assert.equal(assistant.role, "assistant");
assert.equal(assistant.tool_calls[0].function.name, "search_memory");
const tool = toAgentToolMessage(normalized.toolCalls[0], { content: "result" });
assert.deepEqual(tool, {
  role: "tool",
  tool_call_id: "call-1",
  name: "search_memory",
  content: "result",
});

assert.throws(() => normalizeAgentModelResponse({ content: "", toolCalls: [] }));
assert.throws(() =>
  normalizeAgentModelResponse({
    toolCalls: [
      { id: "same", name: "a", arguments: "{}" },
      { id: "same", name: "b", arguments: "{}" },
    ],
  }),
);

console.log("Agent model protocol tests passed");
