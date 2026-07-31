import assert from "node:assert/strict";
import { PlannerArtifactService } from "../application/planner-artifact-service.js";
import { fingerprintMaterializedMemoryState } from "../domain/memory-changeset.js";
import {
  TURN_ARTIFACT_KIND,
  TURN_ARTIFACT_STATUS,
  createEmptyMemoryLedger,
} from "../domain/memory-contract.js";
import { appendMemoryLedgerTransaction } from "../domain/memory-ledger.js";
import {
  materializeMemoryLedger,
  materializeTurnArtifacts,
} from "../domain/memory-materializer.js";
import {
  createEvidenceInvalidation,
  createMemoryRevision,
  createTurnEvidence,
} from "../domain/memory-records.js";
import {
  createTurnInputFingerprint,
  findReusableTurnArtifact,
  planTurnArtifactCommit,
  turnArtifactToRecallResult,
} from "../domain/turn-artifact.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

const chatId = "chat:turn-artifact";
let ledger = createEmptyMemoryLedger({ chatId, now: 1 });
const evidence = createTurnEvidence({
  chatId,
  turnId: "turn:previous",
  userText: "Open the archive.",
  assistantText: "Mira opened the archive gate.",
  assistantFloor: 2,
  createdAt: 2,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: 0,
  idempotencyKey: "evidence",
  records: [evidence],
  sourceEvidenceIds: [evidence.id],
  now: 2,
}).ledger;
const memory = createMemoryRevision({
  chatId,
  memoryId: "memory:archive-gate",
  memoryType: "event",
  fields: { summary: "Mira opened the archive gate." },
  evidenceIds: [evidence.id],
  createdAt: 3,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: 1,
  idempotencyKey: "memory",
  records: [memory],
  sourceEvidenceIds: [evidence.id],
  now: 3,
}).ledger;

const historyFingerprint = "history:v1";
const inputFingerprint = createTurnInputFingerprint({
  turnId: "turn:current",
  userMessage: "What happened at the gate?",
  recentMessages: ["Mira entered the archive."],
  historyFingerprint,
});
const expectedMemoryStateFingerprint = fingerprintMaterializedMemoryState(ledger);
const planned = planTurnArtifactCommit(ledger, {
  turnId: "turn:current",
  artifactKind: TURN_ARTIFACT_KIND.RECALL,
  inputFingerprint,
  historyFingerprint,
  expectedMemoryStateFingerprint,
  selectedMemoryIds: [memory.memoryId],
  candidateMemoryIds: [memory.memoryId],
  injectionText: "[Memory - Recalled]\nMira opened the archive gate.",
  evidenceIds: [evidence.id],
  agentRunId: "run:recall",
  agentTaskId: "task:recall",
  result: {
    status: "failed",
    empty: true,
    chatId: "chat:must-not-override",
    injectionText: "must not override the durable artifact",
  },
  now: 4,
});
assert.equal(planned.artifact.status, TURN_ARTIFACT_STATUS.READY);
ledger = appendMemoryLedgerTransaction(ledger, planned.transaction).ledger;

const artifactView = materializeTurnArtifacts(ledger);
assert.equal(artifactView.active.length, 1);
assert.equal(
  artifactView.get("turn:current", TURN_ARTIFACT_KIND.RECALL, inputFingerprint)?.id,
  planned.artifact.id,
);
const reusable = findReusableTurnArtifact(ledger, {
  turnId: "turn:current",
  artifactKind: TURN_ARTIFACT_KIND.RECALL,
  inputFingerprint,
  historyFingerprint,
});
assert.equal(reusable.id, planned.artifact.id);
assert.equal(
  findReusableTurnArtifact(ledger, {
    turnId: "turn:current",
    inputFingerprint,
    historyFingerprint: "history:changed",
  }),
  null,
);
const recallResult = turnArtifactToRecallResult(reusable);
assert.equal(recallResult.status, "completed");
assert.equal(recallResult.didRecall, true);
assert.equal(recallResult.empty, false);
assert.equal(recallResult.chatId, chatId);
assert.equal(
  recallResult.injectionText,
  "[Memory - Recalled]\nMira opened the archive gate.",
);
assert.deepEqual(recallResult.selectedMemoryIds, [memory.memoryId]);

const alternateHistoryPlan = planTurnArtifactCommit(ledger, {
  turnId: "turn:current",
  artifactKind: TURN_ARTIFACT_KIND.RECALL,
  inputFingerprint,
  historyFingerprint: "history:alternate",
  expectedMemoryStateFingerprint: fingerprintMaterializedMemoryState(ledger),
  selectedMemoryIds: [memory.memoryId],
  candidateMemoryIds: [memory.memoryId],
  injectionText: "[Memory - Recalled]\nAlternate history snapshot.",
  evidenceIds: [evidence.id],
  now: 4.5,
});
assert.equal(alternateHistoryPlan.reused, false);
ledger = appendMemoryLedgerTransaction(
  ledger,
  alternateHistoryPlan.transaction,
).ledger;
assert.equal(
  findReusableTurnArtifact(ledger, {
    turnId: "turn:current",
    artifactKind: TURN_ARTIFACT_KIND.RECALL,
    inputFingerprint,
    historyFingerprint,
  })?.id,
  planned.artifact.id,
);
assert.equal(
  findReusableTurnArtifact(ledger, {
    turnId: "turn:current",
    artifactKind: TURN_ARTIFACT_KIND.RECALL,
    inputFingerprint,
    historyFingerprint: "history:alternate",
  })?.id,
  alternateHistoryPlan.artifact.id,
);

const emptyInputFingerprint = createTurnInputFingerprint({
  turnId: "turn:first",
  userMessage: "Hello",
  historyFingerprint: "history:first",
});
const emptyPlan = planTurnArtifactCommit(ledger, {
  turnId: "turn:first",
  inputFingerprint: emptyInputFingerprint,
  historyFingerprint: "history:first",
  expectedMemoryStateFingerprint: fingerprintMaterializedMemoryState(ledger),
  selectedMemoryIds: [],
  candidateMemoryIds: [],
  injectionText: "",
  now: 5,
});
assert.equal(emptyPlan.artifact.status, TURN_ARTIFACT_STATUS.EMPTY);
ledger = appendMemoryLedgerTransaction(ledger, emptyPlan.transaction).ledger;
const emptyResult = turnArtifactToRecallResult(
  findReusableTurnArtifact(ledger, {
    turnId: "turn:first",
    inputFingerprint: emptyInputFingerprint,
    historyFingerprint: "history:first",
  }),
);
assert.equal(emptyResult.didRecall, false);
assert.equal(emptyResult.empty, true);
assert.equal(emptyResult.injectionText, "");

const plannerRepository = new InMemoryLedgerRepository(chatId);
plannerRepository.ledgers.set(chatId, ledger);
const plannerService = new PlannerArtifactService({
  repository: plannerRepository,
  now: () => 5.5,
});
const planner = await plannerService.publish({
  chatId,
  turnId: "turn:current",
  inputFingerprint,
  historyFingerprint,
  expectedMemoryStateFingerprint: planned.artifact.memoryStateFingerprint,
  recallArtifactId: planned.artifact.id,
  selectedMemoryIds: [memory.memoryId],
  plotText: "Mira follows the opened gate into the archive.",
  plotBlocks: ["Enter the archive", "Inspect the sealed door"],
});
ledger = await plannerRepository.load(chatId);
assert.equal(planner.empty, false);
assert.equal(planner.recallArtifactId, planned.artifact.id);
assert.equal(
  materializeTurnArtifacts(ledger).get(
    "turn:current",
    TURN_ARTIFACT_KIND.PLANNER,
    inputFingerprint,
  )?.sourceArtifactIds[0],
  planned.artifact.id,
);

assert.throws(
  () => planTurnArtifactCommit(ledger, {
    turnId: "turn:current",
    artifactKind: TURN_ARTIFACT_KIND.PLANNER,
    inputFingerprint: "input:wrong-version",
    historyFingerprint: "history:wrong-version",
    expectedMemoryStateFingerprint: planned.artifact.memoryStateFingerprint,
    sourceArtifactIds: [planned.artifact.id],
    contentText: "This plan must not attach to another recall version.",
    now: 5.6,
  }),
  (error) => error?.code === "memory_ledger_conflict",
);

const memoryStateBeforeUnrelatedCommit = fingerprintMaterializedMemoryState(ledger);
const unrelatedEvidence = createTurnEvidence({
  chatId,
  turnId: "turn:unrelated",
  userText: "Look at the window.",
  assistantText: "Rain crossed the window.",
  assistantFloor: 8,
  createdAt: 5.7,
});
const unrelatedMemory = createMemoryRevision({
  chatId,
  memoryId: "memory:window-rain",
  memoryType: "event",
  fields: { summary: "Rain crossed the window." },
  evidenceIds: [unrelatedEvidence.id],
  createdAt: 5.7,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "unrelated-memory",
  records: [unrelatedEvidence, unrelatedMemory],
  sourceEvidenceIds: [unrelatedEvidence.id],
  now: 5.7,
}).ledger;
assert.notEqual(
  fingerprintMaterializedMemoryState(ledger),
  memoryStateBeforeUnrelatedCommit,
);
assert.equal(
  findReusableTurnArtifact(ledger, {
    turnId: "turn:current",
    artifactKind: TURN_ARTIFACT_KIND.RECALL,
    inputFingerprint,
    historyFingerprint,
  })?.id,
  planned.artifact.id,
  "reroll must reuse the exact turn-version snapshot after unrelated memory evolution",
);

assert.throws(
  () =>
    planTurnArtifactCommit(ledger, {
      turnId: "turn:stale",
      inputFingerprint: "input:stale",
      expectedMemoryStateFingerprint: "memory:stale",
      injectionText: "",
    }),
  /memory state changed/,
);

const invalidation = createEvidenceInvalidation({
  chatId,
  evidenceId: evidence.id,
  mutationId: "delete:previous",
  createdAt: 6,
});
ledger = appendMemoryLedgerTransaction(ledger, {
  baseRevision: ledger.revision,
  idempotencyKey: "invalidate-evidence",
  records: [invalidation],
  now: 6,
}).ledger;
const invalidatedView = materializeMemoryLedger(ledger);
assert.equal(invalidatedView.memories.byMemoryId.has(memory.memoryId), false);
assert.equal(
  invalidatedView.memories.byMemoryId.has(unrelatedMemory.memoryId),
  true,
);
assert.equal(
  invalidatedView.turnArtifacts.get(
    "turn:current",
    TURN_ARTIFACT_KIND.RECALL,
    inputFingerprint,
  ),
  null,
);
assert.equal(
  invalidatedView.turnArtifacts.get(
    "turn:current",
    TURN_ARTIFACT_KIND.PLANNER,
    inputFingerprint,
  ),
  null,
);
assert.equal(
  invalidatedView.turnArtifacts.get(
    "turn:first",
    TURN_ARTIFACT_KIND.RECALL,
    emptyInputFingerprint,
  )?.status,
  TURN_ARTIFACT_STATUS.EMPTY,
);

console.log("turn artifact tests passed");
