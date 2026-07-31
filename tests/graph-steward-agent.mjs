import assert from "node:assert/strict";

import { runGraphStewardAgent } from "../application/graph-steward-agent.js";

const base = {
  chatId: "chat:steward",
  startFloor: 4,
  endFloor: 5,
  context: {
    historyFingerprint: "history:5",
    messages: [
      { floor: 4, role: "user", content: "We should hide the key." },
      { floor: 5, role: "assistant", content: "The key was hidden under the clock." },
    ],
  },
  settings: {
    agentContextWindowTokens: 128000,
    agentMaxToolCalls: 500,
    agentMaxRunMs: 480000,
  },
  countTokens: () => 100,
};

let modelCall = 0;
const pipelineCalls = [];
const result = await runGraphStewardAgent({
  ...base,
  allowedCapabilities: {
    consolidate: true,
    summarize: true,
    reflect: false,
    compress: true,
    forget: false,
  },
  runPipeline: async (request) => {
    pipelineCalls.push(request);
    return { success: true, newNodes: 1 };
  },
  completeWithoutChanges: async () => ({ success: true }),
  model: async () => {
    modelCall += 1;
    if (modelCall === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "context", name: "memory_task_context", arguments: "{}" },
        ],
      };
    }
    if (modelCall === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "pipeline",
            name: "memory_run_pipeline",
            arguments: JSON.stringify({
              consolidate: true,
              summarize: false,
              reflect: true,
              compress: false,
              forget: true,
              reason: "A durable location state changed",
            }),
          },
        ],
      };
    }
    return { content: "completed", toolCalls: [] };
  },
});

assert.equal(result.outcome.kind, "pipeline");
assert.equal(pipelineCalls.length, 1);
assert.equal(pipelineCalls[0].capabilities.enableConsolidation, true);
assert.equal(pipelineCalls[0].capabilities.enableHierarchicalSummary, false);
assert.equal(pipelineCalls[0].capabilities.enableReflection, false);
assert.equal(pipelineCalls[0].capabilities.enableSleepCycle, false);

let noChangeCall = 0;
let noChangeModelCall = 0;
const noChange = await runGraphStewardAgent({
  ...base,
  endFloor: 7,
  runPipeline: async () => {
    throw new Error("pipeline should not run");
  },
  completeWithoutChanges: async ({ reason }) => {
    noChangeCall += 1;
    return { success: true, reason };
  },
  model: async () => {
    noChangeModelCall += 1;
    if (noChangeModelCall === 1) {
      return {
        content: "",
        toolCalls: [
          { id: "context-2", name: "memory_task_context", arguments: "{}" },
        ],
      };
    }
    if (noChangeModelCall === 2) {
      return {
        content: "",
        toolCalls: [
          {
            id: "no-change",
            name: "memory_complete_without_changes",
            arguments: JSON.stringify({ reason: "Only transient banter" }),
          },
        ],
      };
    }
    return { content: "completed", toolCalls: [] };
  },
});
assert.equal(noChange.outcome.kind, "no_change");
assert.equal(noChangeCall, 1);

let fallbackCalls = 0;
const fallback = await runGraphStewardAgent({
  ...base,
  allowedCapabilities: {
    consolidate: true,
    summarize: false,
    reflect: false,
    compress: true,
    forget: false,
  },
  runPipeline: async ({ fallback: isFallback, capabilities }) => {
    fallbackCalls += 1;
    assert.equal(isFallback, true);
    assert.equal(capabilities.enableConsolidation, true);
    assert.equal(capabilities.enableAutoCompression, true);
    return { success: true };
  },
  completeWithoutChanges: async () => ({ success: true }),
  model: async () => {
    throw new Error("provider unavailable");
  },
});
assert.equal(fallback.outcome.kind, "pipeline_fallback");
assert.equal(fallbackCalls, 1);

let failedPipelineCalls = 0;
const failedPipeline = await runGraphStewardAgent({
  ...base,
  endFloor: 9,
  allowedCapabilities: {
    consolidate: true,
    summarize: true,
    reflect: true,
    compress: true,
    forget: true,
  },
  runPipeline: async () => {
    failedPipelineCalls += 1;
    return { success: false, error: "durable commit was not accepted" };
  },
  completeWithoutChanges: async () => ({ success: true }),
  model: async () => ({
    content: "",
    toolCalls: [
      {
        id: "pipeline-fails",
        name: "memory_run_pipeline",
        arguments: JSON.stringify({
          consolidate: true,
          summarize: true,
          reflect: false,
          compress: false,
          forget: false,
          reason: "A durable fact changed",
        }),
      },
    ],
  }),
});
assert.equal(failedPipeline.success, false);
assert.equal(failedPipeline.outcome.kind, "pipeline_failed");
assert.equal(failedPipelineCalls, 1);

let thrownPipelineCalls = 0;
const thrownPipeline = await runGraphStewardAgent({
  ...base,
  endFloor: 11,
  runPipeline: async () => {
    thrownPipelineCalls += 1;
    throw new Error("pipeline interrupted after it started");
  },
  completeWithoutChanges: async () => ({ success: true }),
  model: async () => ({
    content: "",
    toolCalls: [
      {
        id: "pipeline-throws",
        name: "memory_run_pipeline",
        arguments: JSON.stringify({
          consolidate: false,
          summarize: false,
          reflect: false,
          compress: false,
          forget: false,
          reason: "Persist one new memory",
        }),
      },
    ],
  }),
});
assert.equal(thrownPipeline.success, false);
assert.equal(thrownPipeline.outcome.kind, "pipeline_failed");
assert.equal(thrownPipelineCalls, 1);

const committedAbortController = new AbortController();
let committedAbortCalls = 0;
const committedDuringAbort = await runGraphStewardAgent({
  ...base,
  endFloor: 13,
  signal: committedAbortController.signal,
  runPipeline: async () => {
    committedAbortCalls += 1;
    committedAbortController.abort(new DOMException("mode changed", "AbortError"));
    return { success: true, accepted: true };
  },
  completeWithoutChanges: async () => ({ success: true }),
  model: async () => ({
    content: "",
    toolCalls: [
      {
        id: "pipeline-commit-boundary",
        name: "memory_run_pipeline",
        arguments: JSON.stringify({
          consolidate: false,
          summarize: false,
          reflect: false,
          compress: false,
          forget: false,
          reason: "Commit before cancellation is observed",
        }),
      },
    ],
  }),
});
assert.equal(committedDuringAbort.success, true);
assert.equal(committedDuringAbort.outcome.kind, "pipeline");
assert.equal(committedAbortCalls, 1);

console.log("graph Steward Agent tests passed");
