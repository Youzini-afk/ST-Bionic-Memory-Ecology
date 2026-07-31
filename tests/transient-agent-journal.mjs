import assert from "node:assert/strict";

import { TransientAgentJournal } from "../agent/transient-journal.js";
import { AGENT_EVENT_TYPE } from "../domain/memory-contract.js";

const journal = new TransientAgentJournal({ now: () => 100 });
await journal.startRun({
  chatId: "chat:journal",
  runId: "run:one",
  taskId: "task:one",
  agentKind: "test-agent",
});

const first = await journal.append({
  chatId: "chat:journal",
  runId: "run:one",
  eventType: AGENT_EVENT_TYPE.RUN_SUSPENDED,
  eventKey: "run:one:suspend",
  payload: { reason: "test" },
});
const replay = await journal.append({
  chatId: "chat:journal",
  runId: "run:one",
  eventType: AGENT_EVENT_TYPE.RUN_SUSPENDED,
  eventKey: "run:one:suspend",
  payload: { reason: "test" },
});
assert.equal(first.replayed, false);
assert.equal(replay.replayed, true);
assert.equal(replay.event.id, first.event.id);

await assert.rejects(
  journal.append({
    chatId: "chat:journal",
    runId: "run:one",
    eventType: AGENT_EVENT_TYPE.RUN_SUSPENDED,
    eventKey: "run:one:suspend",
    payload: { reason: "different" },
  }),
  (error) => error?.code === "bme_agent_event_conflict",
);

await journal.startRun({
  chatId: "chat:journal",
  runId: "run:two",
  taskId: "task:two",
  agentKind: "test-agent",
});
const recovered = await journal.recoverInterruptedRuns("chat:journal", {
  agentKind: "test-agent",
});
assert.equal(recovered.length, 1);
assert.equal(recovered[0].runId, "run:two");
assert.equal(recovered[0].eventType, AGENT_EVENT_TYPE.RUN_SUSPENDED);
assert.equal((await journal.getRun("chat:journal", "run:two")).terminal, true);

console.log("transient Agent journal tests passed");
