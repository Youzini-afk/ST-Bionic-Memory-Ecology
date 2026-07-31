import assert from "node:assert/strict";
import { AGENT_EVENT_TYPE } from "../domain/memory-contract.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import { materializeAgentRuns } from "../domain/memory-materializer.js";
import {
  BmeAgentRunExistsError,
  DurableAgentJournal,
  projectAgentRunMessages,
} from "../agent/journal.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

const chatId = "chat:agent-journal";
const repository = new InMemoryLedgerRepository(chatId);
let now = 10;
const journal = new DurableAgentJournal({ repository, now: () => now++ });

await journal.startRun({
  chatId,
  runId: "run-1",
  taskId: "task-1",
  agentKind: "memory-steward",
  initialMessages: [{ role: "user", content: "inspect the new turn" }],
  toolSnapshot: { fingerprint: "tools-v1", names: ["read"], definitions: [] },
});
await assert.rejects(
  () => journal.startRun({ chatId, runId: "run-1", taskId: "duplicate", initialMessages: [] }),
  BmeAgentRunExistsError,
);
await journal.append({
  chatId,
  runId: "run-1",
  eventType: AGENT_EVENT_TYPE.MODEL_REQUESTED,
  payload: { purpose: "agent-turn" },
});

const recovered = await journal.recoverInterruptedRuns(chatId);
assert.equal(recovered.length, 1);
assert.equal(recovered[0].eventType, AGENT_EVENT_TYPE.RUN_SUSPENDED);
assert.equal(recovered[0].payload.reason, "provider-boundary-interrupted");
assert.equal(recovered[0].payload.replayedProviderOrTool, false);
assert.equal((await journal.recoverInterruptedRuns(chatId)).length, 0);

const ledger = await repository.load(chatId);
const run = materializeAgentRuns(ledger).runs.get("run-1");
assert.equal(run.status, "suspended");
assert.equal(run.events.length, 3);
assert.deepEqual(projectAgentRunMessages(run), [
  { role: "user", content: "inspect the new turn" },
]);

await journal.startRun({
  chatId,
  runId: "run-invalid-transition",
  taskId: "task-invalid-transition",
  agentKind: "memory-steward",
  initialMessages: [{ role: "user", content: "work" }],
});
await assert.rejects(() =>
  journal.append({
    chatId,
    runId: "run-invalid-transition",
    eventType: AGENT_EVENT_TYPE.RUN_COMPLETED,
    payload: { content: "fabricated completion" },
  }),
);
await assert.rejects(() =>
  journal.append({
    chatId,
    runId: "run-invalid-transition",
    eventType: AGENT_EVENT_TYPE.TOOL_FINISHED,
    payload: { toolCall: { id: "missing-start" } },
  }),
);
assert.equal(
  (await journal.getRun(chatId, "run-invalid-transition")).events.length,
  1,
);

console.log("Agent journal tests passed");

class RetryAfterCommitRepository extends InMemoryLedgerRepository {
  async transact(targetChatId, transactionOrFactory) {
    const before = await this.load(targetChatId);
    const firstTransaction = await transactionOrFactory(before);
    const committed = appendMemoryLedgerTransaction(before, firstTransaction);
    this.ledgers.set(targetChatId, committed.ledger);
    const retryTransaction = await transactionOrFactory(committed.ledger);
    const replayed = appendMemoryLedgerTransaction(committed.ledger, retryTransaction);
    this.ledgers.set(targetChatId, replayed.ledger);
    return { ...replayed, changed: false };
  }
}

const retryChatId = "chat:agent-journal-response-lost";
const retryRepository = new RetryAfterCommitRepository(retryChatId);
const retryJournal = new DurableAgentJournal({ repository: retryRepository, now: () => 20 });
const startAfterLostResponse = await retryJournal.startRun({
  chatId: retryChatId,
  runId: "run-response-lost",
  taskId: "task-response-lost",
  agentKind: "memory-steward",
  initialMessages: [{ role: "user", content: "work" }],
});
assert.equal(startAfterLostResponse.replayed, true);
const appendAfterLostResponse = await retryJournal.append({
  chatId: retryChatId,
  runId: "run-response-lost",
  eventType: AGENT_EVENT_TYPE.MODEL_REQUESTED,
  eventKey: "agent-test:response-lost:model-request",
  payload: { purpose: "agent-turn" },
});
assert.equal(appendAfterLostResponse.replayed, true);
const retryLedger = await retryRepository.load(retryChatId);
assert.equal(materializeAgentRuns(retryLedger).runs.get("run-response-lost").events.length, 2);
await assert.rejects(() =>
  retryJournal.append({
    chatId: retryChatId,
    runId: "run-response-lost",
    eventType: AGENT_EVENT_TYPE.MODEL_REQUESTED,
    eventKey: "agent-test:response-lost:model-request",
    payload: { purpose: "different-payload" },
  }),
);

console.log("Agent journal response-loss tests passed");
