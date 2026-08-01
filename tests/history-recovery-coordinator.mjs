import assert from "node:assert/strict";

import { createHistoryRecoveryCoordinator } from "../runtime/history-recovery-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function testMutationDuringRollbackRunsLatestRevision() {
  const firstGate = deferred();
  const attempts = [];
  const aborts = [];
  const coordinator = createHistoryRecoveryCoordinator({
    getCurrentChatId: () => "chat-main",
    abortActive(reason) {
      aborts.push(reason);
      firstGate.resolve(false);
      return true;
    },
    async runAttempt(request) {
      attempts.push(request);
      if (request.revision === 1) return await firstGate.promise;
      return true;
    },
  });

  coordinator.request("first-delete");
  const task = coordinator.start();
  await Promise.resolve();
  coordinator.request("second-delete");

  assert.equal(await task, true);
  assert.deepEqual(
    attempts.map(({ revision, trigger }) => ({ revision, trigger })),
    [
      { revision: 1, trigger: "first-delete" },
      { revision: 2, trigger: "second-delete" },
    ],
  );
  assert.equal(aborts.length, 1);
  assert.equal(coordinator.getSnapshot().busy, false);
  assert.equal(coordinator.getSnapshot().completedRevision, 2);
}

async function testReadSideJoinsActiveRollbackWithoutCreatingRevision() {
  const gate = deferred();
  let calls = 0;
  const coordinator = createHistoryRecoveryCoordinator({
    getCurrentChatId: () => "chat-main",
    async runAttempt() {
      calls += 1;
      return await gate.promise;
    },
  });

  coordinator.request("delete");
  const mutationTask = coordinator.start();
  await Promise.resolve();
  const recallTask = coordinator.recover("pre-recall");

  assert.equal(recallTask, mutationTask);
  assert.equal(coordinator.getSnapshot().requestedRevision, 1);
  gate.resolve(true);
  assert.equal(await recallTask, true);
  assert.equal(calls, 1);
}

async function testSettledNoopRequestDoesNotStartRollback() {
  let calls = 0;
  const coordinator = createHistoryRecoveryCoordinator({
    getCurrentChatId: () => "chat-main",
    async runAttempt() {
      calls += 1;
      return true;
    },
  });
  const request = coordinator.request("delete-outside-processed-range");

  assert.equal(coordinator.settlePending(request.revision, true), true);
  assert.equal(coordinator.getSnapshot().busy, false);
  assert.equal(calls, 0);
}

async function testReadBarrierDoesNotRetrySettledFailure() {
  let calls = 0;
  const coordinator = createHistoryRecoveryCoordinator({
    getCurrentChatId: () => "chat-main",
    async runAttempt() {
      calls += 1;
      return false;
    },
  });

  coordinator.request("delete-without-journal");
  assert.equal(await coordinator.start(), false);
  assert.equal(await coordinator.waitForCurrent(), false);
  assert.equal(calls, 1);
  assert.equal(coordinator.getSnapshot().requestedRevision, 1);
}

async function testRejectedAttemptClearsDiagnosticOwnership() {
  const coordinator = createHistoryRecoveryCoordinator({
    getCurrentChatId: () => "chat-main",
    async runAttempt() {
      throw new Error("rollback failed");
    },
  });

  await assert.rejects(
    coordinator.recover("failing-delete"),
    /rollback failed/,
  );
  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.activeRevision, 0);
  assert.equal(snapshot.activeTrigger, "");
  assert.equal(snapshot.completedRevision, 1);
  assert.equal(snapshot.lastResult, false);
}

await testMutationDuringRollbackRunsLatestRevision();
await testReadSideJoinsActiveRollbackWithoutCreatingRevision();
await testSettledNoopRequestDoesNotStartRollback();
await testReadBarrierDoesNotRetrySettledFailure();
await testRejectedAttemptClearsDiagnosticOwnership();

console.log("history-recovery-coordinator tests passed");
