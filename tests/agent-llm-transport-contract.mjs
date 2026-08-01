import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  appendOpenAICompatibleToolCallDeltas,
  attachOpenAICompatibleTools,
  buildOpenAICompatibleTransportMessages,
  createOpenAICompatibleToolCallAccumulator,
  materializeOpenAICompatibleToolCalls,
  normalizeOpenAICompatibleToolCalls,
} from "../llm/openai-tool-protocol.js";

const source = await readFile(new URL("../llm/llm.js", import.meta.url), "utf8");
assert.match(source, /export async function callBmeAgentModel\s*\(/);
assert.match(source, /requireDedicated:\s*true/);
assert.doesNotMatch(source, /callBmeAgentModel[\s\S]{0,1800}forceNonStream:\s*true/);
assert.match(source, /onStreamProgress/);
assert.match(source, /body\.max_context_tokens\s*=/);
assert.match(source, /maxCompletionTokensIsCeiling:\s*true/);
assert.match(source, /normalized\.toolCalls\.length\s*>\s*0/);

const toolCalls = normalizeOpenAICompatibleToolCalls({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"key":"home"}' },
          },
        ],
      },
    },
  ],
});
assert.equal(toolCalls[0].name, "lookup");
assert.equal(toolCalls[0].arguments, '{"key":"home"}');

const accumulator = createOpenAICompatibleToolCallAccumulator();
appendOpenAICompatibleToolCallDeltas(accumulator, {
  choices: [{
    delta: {
      tool_calls: [
        {
          index: 0,
          id: "call-a",
          type: "function",
          function: { name: "look", arguments: '{"key":"' },
        },
        {
          index: 1,
          id: "call-b",
          type: "function",
          function: { name: "neigh", arguments: '{"id":"' },
        },
      ],
    },
  }],
});
appendOpenAICompatibleToolCallDeltas(accumulator, {
  choices: [{
    delta: {
      tool_calls: [
        { index: 1, function: { name: "bors", arguments: 'n1"}' } },
        { index: 0, function: { name: "up", arguments: 'home"}' } },
      ],
    },
  }],
});
const streamedCalls = materializeOpenAICompatibleToolCalls(accumulator);
assert.deepEqual(
  streamedCalls.map(({ id, name, arguments: args }) => ({ id, name, args })),
  [
    { id: "call-a", name: "lookup", args: '{"key":"home"}' },
    { id: "call-b", name: "neighbors", args: '{"id":"n1"}' },
  ],
);

const transportMessages = buildOpenAICompatibleTransportMessages([
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
    ],
  },
  { role: "tool", tool_call_id: "call-1", name: "lookup", content: "result" },
]);
assert.equal(transportMessages.length, 2);
assert.equal(transportMessages[0].tool_calls[0].id, "call-1");
assert.equal(transportMessages[1].tool_call_id, "call-1");

const body = attachOpenAICompatibleTools(
  { messages: transportMessages, stream: true },
  [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  "auto",
);
assert.equal(body.stream, true);
assert.equal(body.tool_choice, "auto");
assert.equal(body.enable_function_calling, true);
assert.equal(body.tools.length, 1);

console.log("Agent LLM transport contract tests passed");
