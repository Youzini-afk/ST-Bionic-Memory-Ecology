import assert from "node:assert/strict";

import { runExtractionController } from "../maintenance/extraction-controller.js";

function createRuntime() {
  const graph = { historyState: { lastProcessedAssistantFloor: -1 } };
  const stateChanges = [];
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  let observedSignal = null;
  const runtime = {
    console,
    getIsExtracting: () => false,
    getCurrentGraph: () => graph,
    getSettings: () => ({
      enabled: true,
      extractAutoEnabled: true,
      extractEvery: 1,
      enableSmartTrigger: false,
    }),
    getContext: () => ({
      chat: [
        { is_user: true, mes: "Remember the key." },
        { is_user: false, mes: "The key is under the clock." },
      ],
    }),
    getAssistantTurns: () => [1],
    getLastProcessedAssistantFloor: () => -1,
    getGraphPersistenceState: () => ({ pendingPersist: false }),
    ensureGraphMutationReady: () => true,
    ensureCurrentGraphRuntimeState() {},
    recoverHistoryIfNeeded: async () => true,
    deferAutoExtraction() {},
    setIsExtracting(value) {
      stateChanges.push(value);
    },
    beginStageAbortController() {
      return new AbortController();
    },
    setLastExtractionStatus() {},
    async executeExtractionBatch({ signal }) {
      observedSignal = signal;
      startedResolve();
      return await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ success: false, aborted: true, error: "cancelled" }),
          { once: true },
        );
      });
    },
    finishStageAbortController() {},
    isAbortError: (error) => error?.name === "AbortError",
    notifyExtractionIssue() {},
  };
  return {
    runtime,
    started,
    stateChanges,
    getObservedSignal: () => observedSignal,
  };
}

const harness = createRuntime();
const externalController = new AbortController();
const running = runExtractionController(harness.runtime, {
  signal: externalController.signal,
});
await harness.started;
externalController.abort(new DOMException("runtime mode changed", "AbortError"));
const result = await running;
assert.equal(result.success, false);
assert.equal(result.aborted, true);
assert.equal(harness.getObservedSignal().aborted, true);
assert.deepEqual(harness.stateChanges, [true, false]);

const alreadyAborted = new AbortController();
alreadyAborted.abort(new DOMException("chat changed", "AbortError"));
await assert.rejects(
  runExtractionController(createRuntime().runtime, {
    signal: alreadyAborted.signal,
  }),
  (error) => error?.name === "AbortError" && /chat changed/.test(error.message),
);

console.log("external extraction abort tests passed");
