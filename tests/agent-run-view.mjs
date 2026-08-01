import assert from "node:assert/strict";
import { setLocale } from "../i18n/index.js";
import {
  buildAgentEntryRenderSignature,
  buildAgentRunTimeline,
} from "../ui/agent-run-view.js";

setLocale("en-US");

function event(id, eventType, payload = {}) {
  return { id, eventType, payload };
}

{
  const run = {
    runId: "run-recall",
    taskType: "agent_recall",
    metadata: { candidateCount: 4 },
    events: [
      event("start", "run_started"),
      event("model-1", "model_requested", { requestNumber: 1 }),
      event("assistant-1", "assistant_message", {
        requestEventId: "model-1",
        reasoningContent: "Search twice before publishing.",
        message: {
          content: "I will inspect two related queries.",
          tool_calls: [{
            id: "call-1",
            function: { name: "recall_search", arguments: '{"query":"home"}' },
          }],
        },
      }),
      event("tool-start-1", "tool_started", {
        toolCallNumber: 1,
        toolCall: {
          id: "call-1",
          function: { name: "recall_search", arguments: '{"query":"home"}' },
        },
      }),
      event("tool-finish-1", "tool_finished", {
        toolCallNumber: 1,
        ok: true,
        toolCall: {
          id: "call-1",
          function: { name: "recall_search", arguments: '{"query":"home"}' },
        },
        message: { content: JSON.stringify({ items: [{ id: "m1" }, { id: "m2" }] }) },
      }),
      event("tool-start-2", "tool_started", {
        toolCallNumber: 2,
        toolCall: {
          id: "call-2",
          function: { name: "recall_search", arguments: '{"query":"kitchen"}' },
        },
      }),
      event("tool-finish-2", "tool_finished", {
        toolCallNumber: 2,
        ok: true,
        toolCall: {
          id: "call-2",
          function: { name: "recall_search", arguments: '{"query":"kitchen"}' },
        },
        message: { content: JSON.stringify({ items: [{ id: "m3" }] }) },
      }),
      event("done", "run_completed", { elapsedMs: 1200 }),
    ],
  };

  const timeline = buildAgentRunTimeline(run);
  assert.deepEqual(
    timeline.map((entry) => entry.kind),
    ["marker", "model", "tool-group", "terminal"],
  );
  assert.equal(timeline[1].content, "I will inspect two related queries.");
  assert.equal(timeline[1].reasoning, "Search twice before publishing.");
  assert.equal(timeline[1].toolCalls[0].name, "recall_search");
  assert.equal(timeline[2].items.length, 2);
  assert.match(timeline[2].items[0].description, /2 candidate memories/);
  assert.match(timeline[2].items[1].description, /1 candidate memories/);
  assert.equal(timeline[3].status, "completed");
}

{
  const timeline = buildAgentRunTimeline({
    runId: "run-live",
    events: [
      event("start-live", "run_started"),
      event("model-live", "model_requested", { requestNumber: 1 }),
    ],
    stream: {
      active: true,
      requestNumber: 1,
      purpose: "agent-turn",
      content: "Searching",
      reasoningContent: "Need a narrower query",
      toolCalls: [{ name: "recall_search", arguments: '{"query":"garden"}' }],
    },
  });
  const live = timeline.find((entry) => entry.kind === "model");
  assert.equal(live.status, "streaming");
  assert.equal(live.content, "Searching");
  assert.equal(live.reasoning, "Need a narrower query");
  assert.equal(live.toolCalls[0].name, "recall_search");
}

{
  const timeline = buildAgentRunTimeline({
    runId: "run-pipeline-stage",
    activeTool: { toolCallNumber: 1 },
    substage: {
      text: "Extracting memories",
      meta: "floors 8–10",
      level: "running",
    },
    events: [
      event("start-stage", "run_started"),
      event("tool-stage", "tool_started", {
        toolCallNumber: 1,
        toolCall: {
          id: "pipeline-call",
          function: { name: "memory_run_pipeline", arguments: "{}" },
        },
      }),
    ],
  });
  const tool = timeline.find((entry) => entry.kind === "tool");
  assert.match(tool.description, /Extracting memories/);
  assert.match(tool.description, /floors 8–10/);
  assert.equal(tool.substageLevel, "running");
}

{
  const timeline = buildAgentRunTimeline({
    runId: "run-fallback",
    status: "failed",
    outcome: { completed: true, fallback: true },
    events: [
      event("start-fallback", "run_started"),
      event("failed-fallback", "run_failed", { reason: "provider unavailable" }),
    ],
  });
  assert.equal(timeline.at(-1).status, "completed");
  assert.match(timeline.at(-1).title, /Fallback completed/);
}

{
  const longText = "0123456789".repeat(20);
  const timeline = buildAgentRunTimeline(
    {
      runId: "run-windowed",
      events: Array.from({ length: 200 }, (_, index) =>
        event(`compact-${index}`, "context_compacted", {
          beforeTokens: index + 10,
          afterTokens: index + 5,
        }),
      ),
      stream: {
        active: true,
        requestNumber: 3,
        content: longText,
        reasoningContent: longText,
      },
    },
    {
      maxEntries: 20,
      contentCharLimit: 40,
      reasoningCharLimit: 30,
    },
  );
  assert.equal(timeline.length, 21);
  assert.match(timeline[0].title, /earlier entries collapsed/);
  const live = timeline.at(-1);
  assert.ok(live.content.length < longText.length);
  assert.ok(live.content.endsWith(longText.slice(-40)));
  assert.ok(live.reasoning.endsWith(longText.slice(-30)));
}

{
  const timeline = buildAgentRunTimeline({
    runId: "run-monitor-window",
    omittedEventCount: 80,
    events: [event("compact-tail", "context_compacted")],
  });
  assert.equal(timeline.length, 2);
  assert.match(timeline[0].title, /80 earlier entries collapsed/);
}

{
  const hugeDiagnostic = `do-not-sign-${"x".repeat(50_000)}`;
  const signature = buildAgentEntryRenderSignature({
    id: "tool-large",
    kind: "tool",
    status: "completed",
    title: "Large tool",
    description: "Completed",
    arguments: hugeDiagnostic,
    result: hugeDiagnostic,
  });
  assert.ok(signature.length < 200);
  assert.doesNotMatch(signature, /do-not-sign/);
}

console.log("Agent run view tests passed");
