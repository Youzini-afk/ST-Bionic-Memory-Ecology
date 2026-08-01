import assert from "node:assert/strict";
import {
  createAgentBackgroundPresentation,
  createMemoryTaskPresentationBindings,
  MEMORY_TASK_PRESENTATION_MODE,
  normalizeMemoryTaskPresentation,
} from "../runtime/task-presentation.js";

assert.equal(
  normalizeMemoryTaskPresentation(null).mode,
  MEMORY_TASK_PRESENTATION_MODE.FOREGROUND,
);

{
  const calls = [];
  const original = (...args) => calls.push(args);
  const toastr = { warning: () => calls.push(["toast"]) };
  const bindings = createMemoryTaskPresentationBindings({
    setLastExtractionStatus: original,
    toastr,
  });
  assert.equal(bindings.setLastExtractionStatus, original);
  assert.equal(bindings.toastr, toastr);
}

{
  const statuses = [];
  const stages = [];
  let toastCalls = 0;
  const presentation = createAgentBackgroundPresentation({
    runId: "run-background",
    observer: { recordStageStatus: (entry) => stages.push(entry) },
  });
  const bindings = createMemoryTaskPresentationBindings({
    presentation,
    setLastExtractionStatus: (...args) => statuses.push(args),
    setLastVectorStatus: (...args) => statuses.push(args),
    setLastRecallStatus: (...args) => statuses.push(args),
    notifyExtractionIssue: () => {
      throw new Error("foreground issue notifier must not run");
    },
    toastr: {
      info: () => { toastCalls += 1; },
      success: () => { toastCalls += 1; },
      warning: () => { toastCalls += 1; },
      error: () => { toastCalls += 1; },
    },
  });
  bindings.setLastExtractionStatus("Extracting", "floor 8", "running", {
    syncRuntime: true,
  });
  bindings.setLastVectorStatus("Embedding", "2 nodes", "running");
  bindings.setLastRecallStatus("Recalling", "4 candidates", "running");
  bindings.notifyExtractionIssue("provider unavailable");
  bindings.toastr.warning("must stay in the Agent flow");

  assert.equal(toastCalls, 0);
  assert.deepEqual(stages.map((entry) => entry.stage), [
    "extraction",
    "vector",
    "recall",
    "extraction",
  ]);
  assert.ok(
    statuses.every(
      (args) => args[3]?.presentationMode === MEMORY_TASK_PRESENTATION_MODE.AGENT_BACKGROUND,
    ),
  );
  assert.equal(statuses.at(-1)[2], "error");
}

console.log("memory task presentation tests passed");
