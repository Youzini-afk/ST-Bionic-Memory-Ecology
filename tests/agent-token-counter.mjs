import assert from "node:assert/strict";
import { countBmeAgentContextTokens } from "../host/agent-token-counter.js";

let captured = null;
globalThis.SillyTavern = {
  getContext: () => ({
    getTokenCountAsync: async (text, padding) => {
      captured = { text, padding };
      return 321;
    },
  }),
};

const count = await countBmeAgentContextTokens({
  messages: [{ role: "user", content: "remember this" }],
  tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
});
assert.equal(count, 321);
assert.equal(captured.padding, 0);
assert.match(captured.text, /remember this/);
assert.match(captured.text, /lookup/);

delete globalThis.SillyTavern;
assert.equal(await countBmeAgentContextTokens({ messages: [] }), null);

console.log("Agent token counter tests passed");
