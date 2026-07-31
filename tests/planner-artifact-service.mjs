import assert from "node:assert/strict";

import { PlannerArtifactService } from "../application/planner-artifact-service.js";
import { BmeMemoryLifecycleRuntime } from "../application/memory-lifecycle-runtime.js";
import { TURN_ARTIFACT_KIND } from "../domain/memory-contract.js";
import { fingerprintMaterializedMemoryState } from "../domain/memory-changeset.js";
import { createMemoryRevision, createTurnEvidence } from "../domain/memory-records.js";
import { planTurnArtifactCommit } from "../domain/turn-artifact.js";
import { InMemoryLedgerRepository } from "./helpers/memory-ledger-repository.mjs";

const chatId = "chat:planner-artifact";
const repository = new InMemoryLedgerRepository(chatId, 1);
const evidence = createTurnEvidence({
  chatId,
  turnId: "turn:planner",
  userText: "Plan",
  assistantText: "Evidence",
  createdAt: 2,
});
const memory = createMemoryRevision({
  chatId,
  memoryId: "memory:planner",
  memoryType: "fact",
  fields: { text: "memory" },
  evidenceIds: [evidence.id],
  createdAt: 2,
});
await repository.transact(chatId, {
  baseRevision: 0,
  idempotencyKey: "planner-seed",
  records: [evidence, memory],
  sourceEvidenceIds: [evidence.id],
  now: 2,
});
let ledger = await repository.load(chatId);
const recallPlan = planTurnArtifactCommit(ledger, {
  turnId: "turn:planner",
  artifactKind: TURN_ARTIFACT_KIND.RECALL,
  inputFingerprint: "input:planner",
  historyFingerprint: "history:planner",
  expectedMemoryStateFingerprint: fingerprintMaterializedMemoryState(ledger),
  selectedMemoryIds: [memory.memoryId],
  candidateMemoryIds: [memory.memoryId],
  injectionText: "memory injection",
  evidenceIds: [evidence.id],
  dependencyRevisionIds: [memory.id],
  now: 3,
});
await repository.transact(chatId, recallPlan.transaction);

// An unrelated commit between Recall and ENA completion must not force a
// second Recall or discard the plot. The source Recall artifact is the fence.
ledger = await repository.load(chatId);
const unrelatedEvidence = createTurnEvidence({
  chatId,
  turnId: "turn:unrelated",
  userText: "Other",
  assistantText: "Other evidence",
  createdAt: 4,
});
await repository.transact(chatId, {
  baseRevision: ledger.revision,
  idempotencyKey: "planner-unrelated",
  records: [unrelatedEvidence],
  sourceEvidenceIds: [unrelatedEvidence.id],
  now: 4,
});

const service = new PlannerArtifactService({ repository, now: () => 5 });
const published = await service.publish({
  chatId,
  turnId: "turn:planner",
  inputFingerprint: "input:planner",
  historyFingerprint: "history:planner",
  expectedMemoryStateFingerprint: recallPlan.artifact.memoryStateFingerprint,
  recallArtifactId: recallPlan.artifact.id,
  selectedMemoryIds: [memory.memoryId],
  candidateMemoryIds: [memory.memoryId],
  plotText: "<plot>continue the plan</plot>",
  plotBlocks: ["<plot>continue the plan</plot>"],
});
assert.equal(published.empty, false);
assert.equal(published.recallArtifactId, recallPlan.artifact.id);
assert.equal(
  published.memoryStateFingerprint,
  recallPlan.artifact.memoryStateFingerprint,
  "Planner must retain the exact Recall memory snapshot even when unrelated ledger work finishes later",
);
assert.equal(
  (await service.reuse({
    chatId,
    turnId: "turn:planner",
    inputFingerprint: "input:planner",
    historyFingerprint: "history:planner",
  })).artifactId,
  published.artifactId,
);

const lifecycle = new BmeMemoryLifecycleRuntime({
  memoryLedgerRepository: repository,
  stewardRuntimeFactory: () => ({ dispose() {} }),
  recallRuntimeFactory: () => ({ dispose() {} }),
});
const validHistoryRecord = {
  recallChatId: chatId,
  recallTurnId: "turn:planner",
  recallInputFingerprint: "input:planner",
  recallHistoryFingerprint: "history:planner",
  recallMemoryStateFingerprint: recallPlan.artifact.memoryStateFingerprint,
  recallArtifactId: recallPlan.artifact.id,
  plannerArtifactId: published.artifactId,
  plotText: "<plot>continue the plan</plot>",
};
assert.deepEqual(
  await lifecycle.validatePlannerHistoryRecords(chatId, [
    validHistoryRecord,
    { ...validHistoryRecord, recallChatId: "chat:foreign" },
    { ...validHistoryRecord, plannerArtifactId: "artifact:forged" },
    { ...validHistoryRecord, plotText: "<plot>edited without a new artifact</plot>" },
  ]),
  [validHistoryRecord],
  "Planner history must be backed by the exact durable Recall/Planner artifact pair",
);

console.log("planner artifact service tests passed");
