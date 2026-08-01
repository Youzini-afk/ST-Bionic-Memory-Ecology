import assert from "node:assert/strict";

import {
  mergeAgentExtractionWorkerRequest,
  resolveAgentExtractionTargetEndFloor,
  runManualExtractionByMode,
  shouldContinueAgentExtractionDrain,
} from "../runtime/manual-extraction-route.js";

{
  const calls = [];
  const result = await runManualExtractionByMode({
    mode: "workflow",
    options: { drainAll: false },
    runWorkflow: async (options) => {
      calls.push(["workflow", options]);
      return "workflow-result";
    },
    runAgent: async () => calls.push(["agent"]),
  });
  assert.equal(result, "workflow-result");
  assert.deepEqual(calls, [["workflow", { drainAll: false }]]);
}

{
  const calls = [];
  const result = await runManualExtractionByMode({
    mode: "agent",
    options: { lockedEndFloor: 8, triggerSource: "manual-rerun" },
    runWorkflow: async () => calls.push(["workflow"]),
    runAgent: async (options) => {
      calls.push(["agent", options]);
      return "agent-result";
    },
  });
  assert.equal(result, "agent-result");
  assert.equal(calls[0][0], "agent");
  assert.equal(calls[0][1].manual, true);
  assert.equal(calls[0][1].drainAll, true);
  assert.equal(calls[0][1].triggerSource, "manual-rerun");
}

assert.equal(resolveAgentExtractionTargetEndFloor({ lockedEndFloor: 7.8 }), 7);
assert.equal(resolveAgentExtractionTargetEndFloor({ drainAll: true, assistantTurns: [2, 5, 9] }), 9);
assert.equal(resolveAgentExtractionTargetEndFloor({ drainAll: false, assistantTurns: [2, 5, 9] }), null);

assert.equal(shouldContinueAgentExtractionDrain({
  drainAll: true,
  result: { success: true },
  beforeFloor: 2,
  afterFloor: 5,
  targetEndFloor: 9,
}), true);
assert.equal(shouldContinueAgentExtractionDrain({
  drainAll: true,
  result: { success: true },
  beforeFloor: 5,
  afterFloor: 5,
  targetEndFloor: 9,
}), false, "a non-advancing Agent batch must not spin");
assert.equal(shouldContinueAgentExtractionDrain({
  drainAll: true,
  result: { success: false },
  beforeFloor: 2,
  afterFloor: 5,
  targetEndFloor: 9,
}), false);

{
  const worker = { targetEndFloor: null, rerun: false };
  mergeAgentExtractionWorkerRequest(worker, {
    drainAll: true,
    manual: true,
    skipHistoryRecovery: true,
    triggerSource: "manual-rerun",
  }, 12);
  assert.deepEqual(worker, {
    targetEndFloor: 12,
    rerun: true,
    drainAll: true,
    manual: true,
    skipHistoryRecovery: true,
    triggerSource: "manual-rerun",
  });
}

console.log("manual Agent extraction route tests passed");
