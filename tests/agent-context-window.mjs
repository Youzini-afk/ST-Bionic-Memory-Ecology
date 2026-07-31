import assert from "node:assert/strict";
import {
  TokenAwareAgentContext,
} from "../agent/context-window.js";

function tokenCount({ messages = [], tools = [] }) {
  const messageTokens = messages.reduce((sum, message) => {
    const words = String(message?.content || "").trim().split(/\s+/).filter(Boolean).length;
    return sum + words + (Array.isArray(message?.tool_calls) ? 4 : 0);
  }, 0);
  return messageTokens + tools.length * 5;
}

const context = new TokenAwareAgentContext({
  countTokens: tokenCount,
  settings: { contextWindowTokens: 120, completionReserveTokens: 20 },
});
const words = (prefix, count) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
const source = [
  { role: "system", content: words("system", 5) },
  { role: "user", content: words("old", 30) },
  {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", type: "function", function: { name: "query", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "call-1", content: words("result", 30) },
  { role: "user", content: words("latest", 25) },
];
let compactionRequest = null;
const prepared = await context.prepare({
  messages: source,
  tools: [{ type: "function", function: { name: "query", parameters: {} } }],
  compact: async (request) => {
    compactionRequest = request;
    return { summary: "earlier evidence and tool result preserved" };
  },
});
assert.equal(prepared.compacted, true);
assert.ok(compactionRequest.messages.some((message) => message.role === "tool"));
assert.equal(prepared.messages[0].role, "system");
assert.equal(prepared.messages[1].bmeAgentContextSummary, true);
assert.notEqual(prepared.messages[2]?.role, "tool", "a compacted tail cannot begin with a tool result");
assert.ok(prepared.projectedTokens < prepared.currentTokens);

const longButCheap = "a".repeat(70_000);
const noCharacterCap = new TokenAwareAgentContext({
  countTokens: () => 1,
  settings: { contextWindowTokens: 100, completionReserveTokens: 10 },
});
const untouched = await noCharacterCap.prepare({
  messages: [{ role: "user", content: longButCheap }],
});
assert.equal(untouched.compacted, false);
assert.equal(untouched.messages[0].content.length, 70_000);

await assert.rejects(() =>
  context.prepare({ messages: source, tools: [], compact: null }),
);

const hugeContext = new TokenAwareAgentContext({
  countTokens: ({ messages }) =>
    messages.reduce(
      (sum, message) =>
        sum + String(message?.content || "").split(/\s+/).filter(Boolean).length,
      0,
    ),
  settings: { contextWindowTokens: 100, completionReserveTokens: 10 },
});
const hugeCompactionCalls = [];
const hugePrepared = await hugeContext.prepare({
  messages: [
    { role: "system", content: words("system", 5) },
    { role: "user", content: words("oversized", 250) },
    { role: "user", content: words("recent", 10) },
  ],
  measureCompaction: ({ messages }) => 5 + tokenCount({ messages, tools: [] }),
  compact: async (request) => {
    const requestTokens = 5 + tokenCount({ messages: request.messages, tools: [] });
    hugeCompactionCalls.push({ ...request, requestTokens });
    assert.ok(
      requestTokens + request.maxSummaryTokens <= 100,
      "each recursive compaction request must fit the configured model window",
    );
    return {
      summary:
        request.stage === "map"
          ? `chunk ${request.chunkIndex} evidence`
          : "final compacted evidence",
    };
  },
});
assert.equal(hugePrepared.compacted, true);
assert.ok(hugeCompactionCalls.length > 1);
assert.ok(hugeCompactionCalls.some((request) => request.stage === "map"));
assert.ok(hugeCompactionCalls.some((request) => request.stage === "reduce"));
assert.equal(hugePrepared.messages[1].content, "final compacted evidence");

console.log("Agent context-window tests passed");
