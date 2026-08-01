import assert from "node:assert/strict";
import { TokenAwareAgentContext } from "../agent/context-window.js";
import { BmeAgentCancelledError } from "../agent/errors.js";
import { DurableAgentJournal } from "../agent/journal.js";
import { BmeAgentLoop } from "../agent/loop.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { AgentRunMonitor } from "../runtime/agent-run-monitor.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

function createHarness({ chatId, model, observer }) {
  const repository = new InMemoryLedgerRepository(chatId);
  const journal = new DurableAgentJournal({ repository });
  const tools = new AgentToolRegistry();
  const context = new TokenAwareAgentContext({
    countTokens: ({ messages, tools: definitions }) =>
      messages.length * 10 + definitions.length * 5,
    settings: { contextWindowTokens: 1000, completionReserveTokens: 100 },
  });
  const loop = new BmeAgentLoop({
    model,
    toolRegistry: tools,
    journal,
    context,
    observer,
    settings: { maxRunMs: 60_000 },
  });
  return { loop, tools };
}

async function testLiveProjectionAndTerminalHistory() {
  const monitor = new AgentRunMonitor();
  const updates = [];
  monitor.subscribe((update) => updates.push(update));
  let requestNumber = 0;
  const harness = createHarness({
    chatId: "chat:monitor-success",
    observer: monitor,
    model: async (request) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        request.onStreamProgress?.({
          chunkCount: 1,
          receivedChars: 9,
          receivedReasoningChars: 5,
          contentDelta: "Checking ",
          reasoningDelta: "Need ",
          toolCalls: [{
            id: "call-lookup",
            name: "lookup",
            arguments: '{"key":"home"}',
          }],
        });
        return {
          content: "Checking memory.",
          reasoningContent: "Need evidence.",
          usage: { total_tokens: 20 },
          toolCalls: [{
            id: "call-lookup",
            name: "lookup",
            arguments: '{"key":"home"}',
          }],
        };
      }
      request.onStreamProgress?.({
        chunkCount: 1,
        receivedChars: 5,
        contentDelta: "Done.",
        reasoningDelta: "",
        toolCalls: [],
      });
      return {
        content: "Done.",
        usage: { total_tokens: 8 },
        toolCalls: [],
      };
    },
  });
  harness.tools.register(
    {
      name: "lookup",
      inputSchema: {
        type: "object",
        required: ["key"],
        properties: { key: { type: "string" } },
      },
    },
    async ({ key }) => ({ key, found: true }),
  );

  const result = await harness.loop.run({
    chatId: "chat:monitor-success",
    runId: "run-monitor-success",
    taskId: "task-monitor-success",
    agentKind: "graph-recall-agent",
    taskType: "agent_recall",
    messages: [{ role: "user", content: "Recall home." }],
    metadata: { recallKey: "turn-1" },
  });
  assert.equal(result.toolCallCount, 1);

  monitor.recordOutcome({
    runId: "run-monitor-success",
    outcome: { kind: "published", completed: true, selectedMemoryCount: 1 },
  });
  const snapshot = monitor.getSnapshot({ chatId: "chat:monitor-success" });
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.runs.length, 1);
  const run = snapshot.runs[0];
  assert.equal(run.status, "completed");
  assert.equal(run.taskType, "agent_recall");
  assert.equal(run.toolCallCount, 1);
  assert.equal(run.modelRequestCount, 2);
  assert.equal(run.usage.total_tokens, 28);
  assert.equal(run.stream.content, "Done.");
  assert.equal(run.outcome.kind, "published");
  assert.equal(run.cancellable, false);
  assert.equal(run.events[0].payload.initialMessageCount, 1);
  assert.equal("initialMessages" in run.events[0].payload, false);
  assert.ok(updates.some((update) => update.type === "stream"));
  assert.ok(updates.some((update) => update.type === "event"));
}

async function testCancellationByRunId() {
  const monitor = new AgentRunMonitor();
  let enteredModel;
  const modelEntered = new Promise((resolve) => {
    enteredModel = resolve;
  });
  const harness = createHarness({
    chatId: "chat:monitor-cancel",
    observer: monitor,
    model: async ({ signal }) => {
      enteredModel();
      return await new Promise((resolve, reject) => {
        const rejectFromAbort = () =>
          reject(signal.reason || new DOMException("Aborted", "AbortError"));
        if (signal.aborted) rejectFromAbort();
        else signal.addEventListener("abort", rejectFromAbort, { once: true });
      });
    },
  });
  const runPromise = harness.loop.run({
    chatId: "chat:monitor-cancel",
    runId: "run-monitor-cancel",
    taskId: "task-monitor-cancel",
    taskType: "agent_steward",
    messages: [{ role: "user", content: "Wait." }],
  });
  await modelEntered;
  const before = monitor.getSnapshot({ chatId: "chat:monitor-cancel" }).runs[0];
  assert.equal(before.cancellable, true);
  assert.equal(monitor.cancel("run-monitor-cancel", "Stop this run").ok, true);
  await assert.rejects(runPromise, BmeAgentCancelledError);
  const after = monitor.getSnapshot({ chatId: "chat:monitor-cancel" }).runs[0];
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancellable, false);
  assert.equal(monitor.cancel("run-monitor-cancel").ok, false);
}

await testLiveProjectionAndTerminalHistory();
await testCancellationByRunId();

console.log("Agent run monitor tests passed");
