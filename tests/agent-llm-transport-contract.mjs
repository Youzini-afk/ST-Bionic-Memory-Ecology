import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  attachOpenAICompatibleTools,
  buildOpenAICompatibleTransportMessages,
  normalizeOpenAICompatibleToolCalls,
} from "../llm/openai-tool-protocol.js";

const source = await readFile(new URL("../llm/llm.js", import.meta.url), "utf8");
assert.match(source, /export async function callBmeAgentModel\s*\(/);
assert.match(source, /requireDedicated:\s*true/);
assert.match(source, /forceNonStream:\s*true/);
assert.match(source, /body\.max_context_tokens\s*=/);
assert.match(source, /maxCompletionTokensIsCeiling:\s*true/);
assert.match(source, /normalized\.toolCalls\.length\s*>\s*0/);
assert.match(
  source,
  /export async function testLLMConnection\(\)[\s\S]*?callBmeAgentModel\(\{[\s\S]*?diagnostic:test-bme-agent-connection/,
);
assert.doesNotMatch(
  source,
  /export async function testLLMConnection\(\)[\s\S]*?callLLM\(/,
);

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
assert.equal(body.stream, false);
assert.equal(body.tool_choice, "auto");
assert.equal(body.enable_function_calling, true);
assert.equal(body.tools.length, 1);

console.log("Agent LLM transport contract tests passed");
