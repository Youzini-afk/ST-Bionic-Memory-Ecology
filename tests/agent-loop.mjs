import assert from "node:assert/strict";
import { TokenAwareAgentContext } from "../agent/context-window.js";
import { BmeAgentGuardError, BmeAgentSuspendedError } from "../agent/errors.js";
import { DurableAgentJournal } from "../agent/journal.js";
import { BmeAgentLoop } from "../agent/loop.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { materializeAgentRuns } from "../domain/memory-materializer.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

function createHarness({ chatId, model, settings = {}, now = () => Date.now(), countTokens }) {
  const repository = new InMemoryLedgerRepository(chatId);
  const journal = new DurableAgentJournal({ repository, now });
  const tools = new AgentToolRegistry();
  const context = new TokenAwareAgentContext({
    countTokens:
      countTokens ||
      (({ messages, tools: definitions }) =>
        messages.length * 10 + definitions.length * 5),
    settings: { contextWindowTokens: 1000, completionReserveTokens: 100, ...settings },
  });
  const loop = new BmeAgentLoop({ model, toolRegistry: tools, journal, context, settings, now });
  return { repository, journal, tools, loop };
}

const requests = [];
const harness = createHarness({
  chatId: "chat:loop-success",
  model: async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      return {
        content: "I need the indexed memory.",
        toolCalls: [{ id: "call-1", name: "lookup", arguments: '{"key":"home"}' }],
      };
    }
    return { content: "The character moved to the riverside house.", toolCalls: [] };
  },
});
let handlerVersion = 1;
harness.tools.register(
  {
    name: "lookup",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string" } },
      additionalProperties: false,
    },
  },
  async ({ key }) => {
    harness.tools.register({ name: "lookup" }, async () => ({ version: 2 }), { replace: true });
    return { key, version: handlerVersion };
  },
);
const success = await harness.loop.run({
  chatId: "chat:loop-success",
  runId: "run-success",
  taskId: "task-success",
  agentKind: "memory-steward",
  messages: [
    { role: "system", content: "Manage memory with tools." },
    { role: "user", content: "Process this evidence." },
  ],
});
assert.equal(success.toolCallCount, 1);
assert.equal(success.modelRequestCount, 2);
assert.equal(requests[1].messages.at(-1).role, "tool");
assert.match(requests[1].messages.at(-1).content, /"version":1/);
assert.equal(requests.every((request) => request.tools.length === 1), true);
let runs = materializeAgentRuns(await harness.repository.load("chat:loop-success"));
assert.equal(runs.runs.get("run-success").status, "completed");

let guardModelCalls = 0;
const guarded = createHarness({
  chatId: "chat:loop-guard",
  settings: { maxToolCalls: 1, maxRunMs: 60_000 },
  model: async () => ({
    content: "",
    toolCalls: [{ id: `guard-${++guardModelCalls}`, name: "again", arguments: "{}" }],
  }),
});
let guardedExecutions = 0;
guarded.tools.register({ name: "again" }, async () => ({ count: ++guardedExecutions }));
await assert.rejects(
  () =>
    guarded.loop.run({
      chatId: "chat:loop-guard",
      runId: "run-guard",
      taskId: "task-guard",
      messages: [{ role: "user", content: "loop" }],
    }),
  BmeAgentGuardError,
);
assert.equal(guardedExecutions, 1);
runs = materializeAgentRuns(await guarded.repository.load("chat:loop-guard"));
assert.equal(runs.runs.get("run-guard").status, "suspended");

const failedProvider = createHarness({
  chatId: "chat:loop-provider",
  model: async () => {
    throw new Error("provider disconnected");
  },
});
await assert.rejects(
  () =>
    failedProvider.loop.run({
      chatId: "chat:loop-provider",
      runId: "run-provider",
      taskId: "task-provider",
      messages: [{ role: "user", content: "work" }],
    }),
  BmeAgentSuspendedError,
);
runs = materializeAgentRuns(await failedProvider.repository.load("chat:loop-provider"));
const providerRun = runs.runs.get("run-provider");
assert.equal(providerRun.status, "suspended");
assert.equal(providerRun.events.at(-2).eventType, "model_requested");
assert.equal(providerRun.latestEvent.payload.replayedProviderOrTool, false);

const compactRequests = [];
const compacted = createHarness({
  chatId: "chat:loop-compaction",
  settings: {
    contextWindowTokens: 120,
    completionReserveTokens: 20,
    maxRunMs: 60_000,
  },
  countTokens: ({ messages }) =>
    messages.reduce(
      (sum, message) =>
        sum + String(message?.content || "").split(/\s+/).filter(Boolean).length,
      0,
    ),
  model: async (request) => {
    compactRequests.push(request);
    if (request.requestSource.includes("context-compaction")) {
      return { content: "old evidence remains relevant", toolCalls: [] };
    }
    return { content: "done", toolCalls: [] };
  },
});
const manyWords = (prefix, count) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");
await compacted.loop.run({
  chatId: "chat:loop-compaction",
  runId: "run-compaction",
  taskId: "task-compaction",
  messages: [
    { role: "system", content: manyWords("system", 5) },
    { role: "user", content: manyWords("old", 80) },
    { role: "user", content: manyWords("recent", 20) },
  ],
});
const summaryRequests = compactRequests.filter((request) =>
  request.requestSource.includes("context-compaction"),
);
const finalAgentRequest = compactRequests.at(-1);
assert.ok(summaryRequests.length >= 1);
assert.equal(summaryRequests.every((request) => request.tools.length === 0), true);
assert.equal(summaryRequests.every((request) => request.maxContextTokens === 120), true);
assert.equal(finalAgentRequest.messages[1].bmeAgentContextSummary, true);
const compactRun = materializeAgentRuns(
  await compacted.repository.load("chat:loop-compaction"),
).runs.get("run-compaction");
assert.ok(compactRun.events.some((event) => event.eventType === "context_summary_created"));
assert.ok(compactRun.events.some((event) => event.eventType === "context_compacted"));
assert.equal(compactRun.firstEvent.payload.initialMessages[1].content, manyWords("old", 80));

console.log("Agent loop tests passed");
