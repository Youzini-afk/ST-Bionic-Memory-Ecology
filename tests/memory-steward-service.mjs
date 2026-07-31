import assert from "node:assert/strict";
import { MemoryStewardToolset } from "../agent/memory-steward-tools.js";
import { MemoryStewardService } from "../application/memory-steward-service.js";
import {
  MEMORY_INBOX_STATUS,
  createEmptyMemoryLedger,
} from "../domain/memory-contract.js";
import { admitTurnEvidence, planInboxBatchTransition } from "../domain/memory-inbox.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeInboxState, materializeMemoryLedger } from "../domain/memory-materializer.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

function admit(repository, chatId, evidence, now) {
  const current = repository.ledgers.get(chatId);
  const admitted = admitTurnEvidence(current, { evidence, now });
  repository.ledgers.set(chatId, admitted.ledger);
  return admitted;
}

const chatId = "chat:steward-service";
const repository = new InMemoryLedgerRepository(chatId);
const first = admit(
  repository,
  chatId,
  { turnId: "turn-1", userText: "Continue", assistantText: "The archive gate opened.", assistantFloor: 2 },
  2,
);
const second = admit(
  repository,
  chatId,
  { turnId: "turn-2", userText: "Enter", assistantText: "Mira entered the archive.", assistantFloor: 4 },
  3,
);
const toolset = new MemoryStewardToolset({ repository, now: () => 20 });
let releaseRun;
const runGate = new Promise((resolve) => {
  releaseRun = resolve;
});
const runCalls = [];
const agentRuntime = {
  recoverInterruptedRuns: async () => [],
  run: async (input) => {
    runCalls.push(input);
    await runGate;
    const scope = { runId: input.runId };
    await toolset.taskContext({}, scope);
    const staged = await toolset.stage(
      {
        reason: "batch extraction and consolidation",
        operations: [
          {
            type: "memory_revision",
            memoryId: "memory:archive-entry",
            memoryType: "event",
            fields: { summary: "The gate opened and Mira entered the archive." },
            evidenceIds: [first.evidence.id, second.evidence.id],
            importance: 7,
          },
        ],
      },
      scope,
    );
    assert.equal(staged.staged, true);
    await toolset.commit(scope);
    return { status: "completed" };
  },
};
const statuses = [];
let now = 10;
const service = new MemoryStewardService({
  repository,
  agentRuntime,
  toolset,
  now: () => now++,
  onStatus: (status) => statuses.push(status),
});
const firstWake = service.wake(chatId);
const secondWake = service.wake(chatId);
assert.equal(firstWake, secondWake);
releaseRun();
const results = await firstWake;
assert.equal(runCalls.length, 1);
assert.deepEqual(runCalls[0].metadata.inboxIds.sort(), [first.inboxItem.inboxId, second.inboxItem.inboxId].sort());
assert.equal(results.length, 1);
const settledView = materializeMemoryLedger(await repository.load(chatId));
assert.equal(settledView.inbox.pending.length, 0);
assert.equal(settledView.inbox.claimed.length, 0);
assert.equal(settledView.memories.byMemoryId.has("memory:archive-entry"), true);
assert.deepEqual(statuses.map((status) => status.status), ["running", "completed"]);
assert.equal(toolset.workspaces.size, 0);

const failureChatId = "chat:steward-service-failure";
const failureRepository = new InMemoryLedgerRepository(failureChatId);
const failedAdmission = admit(
  failureRepository,
  failureChatId,
  { turnId: "turn-fail", userText: "Continue", assistantText: "Provider unavailable." },
  2,
);
const failureToolset = new MemoryStewardToolset({ repository: failureRepository, now: () => 100 });
const failureService = new MemoryStewardService({
  repository: failureRepository,
  toolset: failureToolset,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async () => {
      throw new Error("provider unavailable");
    },
  },
  now: () => 100,
});
const failedResults = await failureService.wake(failureChatId);
assert.equal(failedResults.length, 1);
assert.equal(failedResults[0].settled.status, MEMORY_INBOX_STATUS.DEFERRED);
const deferred = materializeInboxState(await failureRepository.load(failureChatId)).pending[0];
assert.equal(deferred.inboxId, failedAdmission.inboxItem.inboxId);
assert.equal(deferred.attempt, 1);
assert.equal(deferred.availableAt > 100, true);
assert.equal(failureToolset.workspaces.size, 0);

const recoveryChatId = "chat:steward-service-recovery";
const recoveryRepository = new InMemoryLedgerRepository(recoveryChatId);
const recoveryAdmission = admit(
  recoveryRepository,
  recoveryChatId,
  { turnId: "turn-recovery", userText: "Continue", assistantText: "Interrupted work." },
  2,
);
let recoveryLedger = await recoveryRepository.load(recoveryChatId);
const claim = planInboxBatchTransition(recoveryLedger, {
  inboxIds: [recoveryAdmission.inboxItem.inboxId],
  status: MEMORY_INBOX_STATUS.CLAIMED,
  expectedStatus: MEMORY_INBOX_STATUS.PENDING,
  claimId: "run:interrupted",
  claimOwner: "memory-steward",
  payloadPatch: { agentRunId: "run:interrupted", agentTaskId: "task:interrupted" },
  now: 3,
});
recoveryLedger = appendMemoryLedgerTransaction(recoveryLedger, claim.transaction).ledger;
recoveryRepository.ledgers.set(recoveryChatId, recoveryLedger);
const recoveryService = new MemoryStewardService({
  repository: recoveryRepository,
  toolset: new MemoryStewardToolset({ repository: recoveryRepository }),
  agentRuntime: { recoverInterruptedRuns: async () => [], run: async () => ({}) },
  now: () => 200,
});
const recovered = await recoveryService.recover(recoveryChatId);
assert.equal(recovered[0].status, MEMORY_INBOX_STATUS.DEFERRED);
assert.equal(materializeInboxState(await recoveryRepository.load(recoveryChatId)).claimed.length, 0);

const parallelRepository = new InMemoryLedgerRepository("chat:parallel-a");
parallelRepository.ledgers.set(
  "chat:parallel-b",
  createEmptyMemoryLedger({ chatId: "chat:parallel-b", now: 1 }),
);
admit(
  parallelRepository,
  "chat:parallel-a",
  { turnId: "turn-a", userText: "A", assistantText: "Parallel A." },
  2,
);
admit(
  parallelRepository,
  "chat:parallel-b",
  { turnId: "turn-b", userText: "B", assistantText: "Parallel B." },
  2,
);
const parallelToolset = new MemoryStewardToolset({ repository: parallelRepository });
let activeRuns = 0;
let maximumActiveRuns = 0;
let releaseBoth;
const bothRunning = new Promise((resolve) => {
  releaseBoth = resolve;
});
const parallelService = new MemoryStewardService({
  repository: parallelRepository,
  toolset: parallelToolset,
  agentRuntime: {
    recoverInterruptedRuns: async () => [],
    run: async (input) => {
      activeRuns += 1;
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
      if (activeRuns === 2) releaseBoth();
      await bothRunning;
      const scope = { runId: input.runId };
      await parallelToolset.taskContext({}, scope);
      await parallelToolset.completeWithoutChanges(
        { reason: "parallel scheduling verified" },
        scope,
      );
      activeRuns -= 1;
      return { status: "completed" };
    },
  },
});
await Promise.all([
  parallelService.wake("chat:parallel-a"),
  parallelService.wake("chat:parallel-b"),
]);
assert.equal(maximumActiveRuns, 2);

console.log("memory steward service tests passed");
