import assert from "node:assert/strict";

import {
  GraphNativeLayoutBridge,
  normalizeGraphNativeRuntimeOptions,
} from "../ui/graph-native-bridge.js";

const normalized = normalizeGraphNativeRuntimeOptions({
  graphUseNativeLayout: "true",
  graphNativeLayoutThresholdNodes: "333.7",
  graphNativeLayoutThresholdEdges: -100,
  graphNativeLayoutWorkerTimeoutMs: 10,
  nativeEngineFailOpen: "false",
  graphNativeForceDisable: 1,
});

assert.equal(normalized.graphUseNativeLayout, true);
assert.equal(normalized.graphNativeLayoutThresholdNodes, 333);
assert.equal(normalized.graphNativeLayoutThresholdEdges, 1);
assert.equal(normalized.graphNativeLayoutWorkerTimeoutMs, 40);
assert.equal(normalized.nativeEngineFailOpen, false);
assert.equal(normalized.graphNativeForceDisable, true);

const runBridge = new GraphNativeLayoutBridge({
  graphUseNativeLayout: true,
  graphNativeLayoutThresholdNodes: 100,
  graphNativeLayoutThresholdEdges: 200,
});

assert.equal(runBridge.shouldRunForGraph(99, 199), false);
assert.equal(runBridge.shouldRunForGraph(100, 10), true);
assert.equal(runBridge.shouldRunForGraph(10, 200), true);

runBridge._ensureWorker = () => null;
runBridge._workerBootError = "forced-unavailable";
const failOpenResult = await runBridge.solveLayout({ nodes: [] });
assert.equal(failOpenResult.ok, false);
assert.equal(failOpenResult.skipped, true);
assert.equal(failOpenResult.reason, "worker-unavailable");
assert.equal(failOpenResult.error, "forced-unavailable");

const strictBridge = new GraphNativeLayoutBridge({
  graphUseNativeLayout: true,
  nativeEngineFailOpen: false,
});
strictBridge._ensureWorker = () => null;
strictBridge._workerBootError = "forced-hard-failure";
let strictThrew = false;
try {
  await strictBridge.solveLayout({ nodes: [] });
} catch (error) {
  strictThrew = String(error?.message || "") === "forced-hard-failure";
}
assert.equal(strictThrew, true);

const cancelBridge = new GraphNativeLayoutBridge({ graphUseNativeLayout: true });
let postMessages = [];
cancelBridge._worker = {
  postMessage(message) {
    postMessages.push(message);
  },
};
let canceledResolveCount = 0;
cancelBridge._pendingJobs.set(11, {
  timer: setTimeout(() => {}, 5000),
  resolve(result) {
    canceledResolveCount += 1;
    assert.equal(result.reason, "manual-cancel");
  },
});
cancelBridge.cancelPending("manual-cancel");
assert.equal(canceledResolveCount, 1);
assert.equal(cancelBridge._pendingJobs.size, 0);
assert.deepEqual(postMessages, [
  { type: "cancel-layout", jobId: 11, reason: "manual-cancel" },
]);

const disposedBridge = new GraphNativeLayoutBridge({ graphUseNativeLayout: true });
disposedBridge.dispose();
const disposedResult = await disposedBridge.solveLayout({ nodes: [] });
assert.equal(disposedResult.reason, "bridge-disposed");

console.log("graph-native-bridge tests passed");
