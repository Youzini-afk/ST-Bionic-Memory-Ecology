import assert from "node:assert/strict";

import {
  createBackgroundMaintenanceQueue,
  getMaintenanceExecutionModeLevel,
  normalizeMaintenanceExecutionMode,
  resolveConcurrencyConfig,
  runLimited,
} from "../runtime/concurrency.js";

assert.equal(normalizeMaintenanceExecutionMode("1"), "strict");
assert.equal(normalizeMaintenanceExecutionMode("balanced"), "balanced");
assert.equal(normalizeMaintenanceExecutionMode("fast"), "fast");
assert.equal(normalizeMaintenanceExecutionMode("unknown"), "strict");
assert.equal(getMaintenanceExecutionModeLevel("strict"), 1);
assert.equal(getMaintenanceExecutionModeLevel("balanced"), 2);
assert.equal(getMaintenanceExecutionModeLevel("fast"), 3);

assert.deepEqual(
  resolveConcurrencyConfig({ maintenanceExecutionMode: "strict" }),
  {
    mode: "strict",
    level: 1,
    vectorQueryConcurrency: 1,
    neighborQueryConcurrency: 1,
    llmConcurrency: 1,
    backgroundMaintenanceMaxRetries: 2,
    backgroundMaintenanceRetryBaseMs: 800,
    backgroundMaintenanceMaxQueueItems: 24,
  },
);
assert.equal(
  resolveConcurrencyConfig({
    maintenanceExecutionMode: "balanced",
    parallelVectorQueryConcurrency: 5,
    parallelNeighborQueryConcurrency: 4,
    parallelLlmConcurrency: 3,
  }).vectorQueryConcurrency,
  5,
);

{
  let active = 0;
  let maxActive = 0;
  const result = await runLimited(
    [1, 2, 3, 4],
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 20 : 1));
      active -= 1;
      return value * 2;
    },
    { concurrency: 2 },
  );

  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(maxActive, 2);
}

{
  let active = 0;
  let maxActive = 0;
  const result = await runLimited(
    [1, 2, 3],
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    },
    { concurrency: 1 },
  );

  assert.deepEqual(result, [1, 2, 3]);
  assert.equal(maxActive, 1);
}

{
  const abortError = new Error("stop");
  abortError.name = "AbortError";
  await assert.rejects(
    () => runLimited([1], async () => {
      throw abortError;
    }, { failFast: false }),
    /stop/,
  );
}

{
  const statuses = [];
  const queue = createBackgroundMaintenanceQueue({
    maxItems: 1,
    maxRetries: 1,
    retryBaseMs: 1,
    onStatus: (snapshot) => statuses.push(snapshot),
  });
  let attempts = 0;
  const enqueued = queue.enqueue("retry-once", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return "ok";
  });

  assert.equal(enqueued.queued, true);
  assert.equal(enqueued.snapshot.state, "queued");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const finalSnapshot = queue.getSnapshot();
  assert.equal(attempts, 2);
  assert.equal(finalSnapshot.completed, 1);
  assert.equal(finalSnapshot.failed, 0);
  assert.equal(finalSnapshot.state, "idle");
  assert.equal(finalSnapshot.lastTask?.status, "success");
  assert.ok(statuses.some((snapshot) => snapshot.state === "running"));
}

{
  const queue = createBackgroundMaintenanceQueue({ maxItems: 1 });
  const first = queue.enqueue("slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const second = queue.enqueue("overflow", async () => {});

  assert.equal(first.queued, true);
  assert.equal(second.queued, false);
  assert.equal(second.reason, "background-maintenance-queue-full");
  assert.equal(queue.getSnapshot().dropped, 1);
}

console.log("runtime-concurrency tests passed");
